/**
 * **行の最後の管理者**(`V23-M1-T07`。単位 `SC-G5`・`SC-G6`。上位:
 * `docs/adr/0497-auto-enroll-and-last-row-admin.md` §Decision 1、`docs/adr/0510-v23-m1-guard-authorization-and-pre-start-decisions.md`
 * §Decision 2・4、`docs/adr/0511-v23-m1-orphan-list-inheritance-and-manual-trigger.md`、計画
 * `docs/plan/v23/00-v23-plan.md` §4 の M1-B)。
 *
 * **題材のアプリは、v23 の宣言(名簿への自動登録)を1つも書いていない既存の形である** ——
 * 全アプリの例外(計画 §17 の例外1・例外4)の陽性対照を兼ねる。
 *
 * - (H) 人の操作: 最後の管理者が自分の付与を消す・権限名を変えると 409 / 2人いれば通る /
 *   グループ経由の管理者も数える / MCP でも同じ / まとめ書きでも同じ / 運営は外せる。
 * - (A) 自動処理(行10・11・12)・時刻起動(行13)・手動起動(行6)・書き戻し(行17)・
 *   AI の書き戻し(行18): 主体を問わず断り、付与が残り、失敗が履歴に残る。
 * - (C) 親の行を消す連鎖(`D-V23-28`): 付与先の行が残るのに最後の管理者の付与が連鎖で
 *   消えるなら、連鎖ごと 409 で断り何も消えない / 付与先ごと消える形は通る。
 * - (R) 運営の回復の一覧: 退会はでき、管理者のいない行が理由付きで並ぶ / 他のメンバーの
 *   付与が残っていても並ぶ / 管理者がいる行は並ばない / 引き継ぎ元に管理者がいれば並ばない
 *   (`D-V23-30`)。
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AiCapabilityStore } from "../kernel/ai-capability-store.ts";
import { dispatchAiJobs } from "../kernel/ai-dispatcher.ts";
import type { AiProvider } from "../kernel/ai-provider.ts";
import {
  appDbPath,
  applyManifest,
  createApp,
  createRecord,
  KernelMetaStore,
  type Manifest,
} from "../kernel/index.ts";
import { ensureIslandRuntimeReady } from "../kernel/island-runner.ts";
import { runScheduledWorkflow } from "../kernel/workflow-runner.ts";
import { createMcpServer } from "../mcp/server.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "last-row-admin";

/** 人の操作で最後の管理者を外そうとしたときの 409 の文面(計画 M1-B の逐語)。 */
const LAST_ADMIN_MESSAGE =
  "この行の管理者があなただけになるため、あなたの権限は外せません。先に別の人に管理の権限を渡してください。";
/** 自動処理の履歴に残る断りの文の一部。 */
const AUTOMATION_MARK = "行の最後の管理者の権限を外すため断りました";

type Wf = "upd" | "isl" | "replace" | "sched" | "manual" | "wb" | "ai";

const PERMS = [
  { id: "keeper", name: "管理", read: true, write: true, delete: true },
  { id: "reader", name: "閲覧", read: true, write: false, delete: false },
];
const ref = (id: string, table: string) => ({
  id,
  name: id,
  type: "reference",
  reference_table: table,
});
const PERMISSION_FIELD = {
  id: "permission",
  name: "権限",
  type: "select",
  options: ["keeper", "reader"],
};
const HISTORY_FIELDS = [
  { id: "ran_at", name: "時刻", type: "date" },
  { id: "workflow", name: "処理", type: "text" },
  { id: "trigger_type", name: "きっかけ", type: "text" },
  { id: "status", name: "結果", type: "text" },
  { id: "error", name: "エラー", type: "long_text" },
];

function workflows(wfs: readonly Wf[]): unknown[] {
  const all: Record<Wf, unknown> = {
    upd: {
      id: "wf_upd",
      name: "権限名を下げる",
      trigger: { type: "on_create", table: "cmds" },
      history_table: "wf_log",
      actions: [
        {
          action: "update_record",
          table: "note_grant",
          target: "$record.gtarget",
          values: { permission: "reader" },
        },
      ],
    },
    isl: {
      id: "wf_isl",
      name: "島が権限名を下げる",
      trigger: { type: "on_create", table: "cmds" },
      history_table: "wf_log",
      actions: [{ action: "run_function", function: "down_isl", write_ops: true }],
    },
    replace: {
      id: "wf_replace",
      name: "付与を作り直す",
      trigger: { type: "on_create", table: "cmds" },
      history_table: "wf_log",
      actions: [{ action: "run_function", function: "replace_grants", output_table: "note_grant" }],
    },
    sched: {
      id: "wf_sched",
      name: "夜間に下げる",
      trigger: { type: "schedule", at: { hour: 3, minute: 0 }, table: "cmds" },
      history_table: "wf_log",
      actions: [
        {
          action: "update_record",
          table: "note_grant",
          target: "$record.gtarget",
          values: { permission: "reader" },
        },
      ],
    },
    manual: {
      id: "wf_manual",
      name: "ボタンで下げる",
      trigger: { type: "manual", table: "cmds" },
      history_table: "wf_log",
      actions: [
        {
          action: "update_record",
          table: "note_grant",
          target: "$record.gtarget",
          values: { permission: "reader" },
        },
      ],
    },
    wb: {
      id: "wf_wb",
      name: "書き戻しで下げる",
      trigger: { type: "on_update", table: "note_grant" },
      history_table: "wf_log",
      actions: [{ action: "run_function", function: "wb_down", write_back: "$record" }],
    },
    ai: {
      id: "wf_ai",
      name: "AI が権限名を決める",
      trigger: { type: "on_update", table: "note_grant" },
      history_table: "wf_log",
      actions: [
        {
          action: "ai_transform",
          capability: "classifier",
          prompt: "権限名を決めてください。",
          input: { memo: "$record.memo" },
          output_field: "permission",
          fallback: "reader",
        },
      ],
    },
  };
  return wfs.map((wf) => all[wf]);
}

function manifest(wfs: readonly Wf[] = []): Manifest {
  return withDefaultRoleRules({
    app: {
      id: APP_ID,
      name: "最後の管理者",
      tables: [
        { id: "teams", name: "班", fields: [{ id: "label", name: "名", type: "text" }] },
        {
          id: "note_member",
          name: "名簿",
          fields: [{ id: "account", name: "利用者", type: "text" }, ref("team", "teams")],
        },
        {
          id: "notes",
          name: "メモ",
          fields: [{ id: "body", name: "本文", type: "text" }],
          access_control: {
            enabled: true,
            permissions: PERMS,
            creator_permission: "keeper",
            creatable_by_roles: ["owner", "editor"],
            grant: {
              table: "note_grant",
              target: "note",
              member: "member",
              group: "team",
              permission: "permission",
            },
            members: { table: "note_member", account: "account", group: "team" },
            groups: { table: "teams" },
          },
        },
        {
          id: "note_grant",
          name: "付与",
          fields: [
            ref("note", "notes"),
            ref("member", "note_member"),
            ref("team", "teams"),
            PERMISSION_FIELD,
            { id: "memo", name: "メモ", type: "text" },
          ],
        },
        {
          id: "kids",
          name: "子",
          fields: [{ id: "title", name: "名", type: "text" }, ref("note", "notes")],
          access_control: {
            enabled: true,
            permissions: PERMS,
            creator_permission: "keeper",
            inherit_from: ["note"],
            grant: {
              table: "kid_grant",
              target: "kid",
              member: "member",
              permission: "permission",
            },
            members: { table: "note_member", account: "account" },
          },
        },
        {
          id: "kid_grant",
          name: "子の付与",
          fields: [ref("kid", "kids"), ref("member", "note_member"), PERMISSION_FIELD],
        },
        {
          id: "cmds",
          name: "指示",
          fields: [
            { id: "title", name: "件名", type: "text" },
            ref("gtarget", "note_grant"),
            ref("gnote", "notes"),
            ref("gmember", "note_member"),
            { id: "version", name: "版", type: "text" },
            { id: "gperm", name: "全置換で渡す権限", type: "text" },
          ],
        },
        { id: "wf_log", name: "履歴", fields: HISTORY_FIELDS },
      ],
      views: wfs.includes("manual")
        ? [
            {
              id: "cmd_list",
              type: "list_view",
              table: "cmds",
              columns: ["title"],
              actions: [{ id: "down", run: "wf_manual", name: "下げる" }],
            },
          ]
        : [],
      functions: [
        {
          id: "down_isl",
          name: "島が下げる",
          code: 'export default function (record) { return [{ op: "update", table: "note_grant", target: record.gtarget, if_match: record.version, values: { permission: "reader" } }]; }',
          input: { source: "record" },
          output: { ops: true },
        },
        {
          id: "replace_grants",
          name: "付与を作り直す",
          code: 'export default function (record) { return [{ note: record.gnote, member: record.gmember, permission: record.gperm || "reader" }]; }',
          input: { source: "record" },
          output: {
            fields: [
              { id: "note", type: "reference" },
              { id: "member", type: "reference" },
              { id: "permission", type: "select" },
            ],
          },
        },
        {
          id: "wb_down",
          name: "書き戻しで下げる",
          code: 'export default function () { return [{ permission: "reader" }]; }',
          input: { source: "record" },
          output: { fields: [{ id: "permission", type: "select" }] },
        },
      ],
      workflows: workflows(wfs),
      // 編集者に付与表の削除を許す(既定の規則は削除を持たない)。
      roles: [
        { id: "owner", name: "持ち主" },
        {
          id: "editor",
          name: "編集者",
          rules: [
            { target: "table", table: "note_grant", can: ["read", "write", "delete"] },
            { target: "table", table: "kid_grant", can: ["read", "write", "delete"] },
          ],
        },
        { id: "viewer", name: "閲覧者" },
      ],
    },
  } as unknown as Manifest);
}

let dataRoot: string | undefined;
let server: ReturnType<typeof createServerApp>;
let current: Manifest;
type Session = ReturnType<typeof seedSession>;
let owner: Session;
let alice: Session;
let bob: Session;
let carol: Session;
/** 名簿の行の `_id`(付与の相手)。 */
const memberRow: Record<string, string> = {};
let teamId = "";

async function makeApp(wfs: readonly Wf[] = []): Promise<void> {
  if (wfs.some((wf) => wf === "isl" || wf === "replace" || wf === "wb")) {
    await ensureIslandRuntimeReady();
  }
  dataRoot = await mkdtemp(join(tmpdir(), "gp-last-row-admin-"));
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, "最後の管理者", { app_id: APP_ID });
  } finally {
    meta.close();
  }
  current = manifest(wfs);
  const applied = applyManifest(dataRoot, APP_ID, current);
  if (!applied.valid) {
    throw new Error(JSON.stringify(applied.errors));
  }
  owner = seedSession(dataRoot, APP_ID, { role: "owner", username: "owner1" });
  alice = seedSession(dataRoot, APP_ID, { role: "editor", username: "alice" });
  bob = seedSession(dataRoot, APP_ID, { role: "editor", username: "bob" });
  carol = seedSession(dataRoot, APP_ID, { role: "editor", username: "carol" });
  teamId = make("teams", { label: "班1" });
  memberRow.alice = make("note_member", { account: alice.userId });
  memberRow.bob = make("note_member", { account: bob.userId });
  memberRow.carol = make("note_member", { account: carol.userId, team: teamId });
  server = createServerApp({ dataRoot });
}

afterEach(async () => {
  if (dataRoot !== undefined) {
    await rm(dataRoot, { recursive: true, force: true });
    dataRoot = undefined;
  }
});

function withDb<T>(fn: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot as string, APP_ID));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** カーネルを直接呼んで1行作る(判定の外側で台を組む)。 */
function make(tableId: string, values: Record<string, unknown>): string {
  return withDb((db) => {
    const created = createRecord(db, current, tableId, values);
    if (!created.ok) {
      throw new Error(`${tableId}: ${JSON.stringify(created.errors)}`);
    }
    return String(created.value._id);
  });
}

function rows(tableId: string): Record<string, unknown>[] {
  return withDb((db) => db.query<Record<string, unknown>, []>(`SELECT * FROM "${tableId}"`).all());
}
function rowOf(tableId: string, id: string): Record<string, unknown> | undefined {
  return rows(tableId).find((row) => row._id === id);
}
function historyDetail(): string {
  return rows("wf_log")
    .map((row) => `${String(row.status)}:${String(row.error)}`)
    .join(" | ");
}

async function send(
  method: string,
  path: string,
  body: unknown,
  cookie: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await server.request(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "content-type": "application/json", origin: TEST_ORIGIN, cookie, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
const RECORDS = (tableId: string) => `/api/apps/${APP_ID}/tables/${tableId}/records`;
const DOOR = (tableId: string) => `/api/apps/${APP_ID}/tables/${tableId}/unreachable-records`;

async function httpDelete(
  who: Session,
  tableId: string,
  id: string,
  children?: string,
): Promise<Response> {
  const headers: Record<string, string> = { "if-match": String(rowOf(tableId, id)?._updated_at) };
  if (children !== undefined) {
    headers["if-match-children"] = children;
  }
  return await send("DELETE", `${RECORDS(tableId)}/${id}`, undefined, who.cookie, headers);
}
async function httpPatch(
  who: Session,
  tableId: string,
  id: string,
  changes: Record<string, unknown>,
): Promise<Response> {
  return await send("PATCH", `${RECORDS(tableId)}/${id}`, changes, who.cookie, {
    "if-match": String(rowOf(tableId, id)?._updated_at),
  });
}

async function mcpCall(
  username: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const mcp = createMcpServer({
    dataRoot: dataRoot as string,
    previewBaseUrl: "http://localhost:3000",
    actor: username,
  });
  const client = new Client({ name: "t07", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), mcp.connect(b)]);
  try {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    return { isError: result.isError === true, text: JSON.stringify(result.content) };
  } finally {
    await client.close();
    await mcp.close();
  }
}

/** メモ N1 に、alice の管理(keeper)と bob の閲覧(reader)の付与を置く。 */
function seedNote(): { note: string; aliceGrant: string; bobGrant: string } {
  const note = make("notes", { body: "N1" });
  const aliceGrant = make("note_grant", {
    note,
    member: memberRow.alice,
    permission: "keeper",
  });
  const bobGrant = make("note_grant", { note, member: memberRow.bob, permission: "reader" });
  return { note, aliceGrant, bobGrant };
}

// =====================================================================================
// (H) 人の操作
// =====================================================================================

describe("V23-M1-T07 (H) 人の操作", () => {
  test("(H-1) 最後の管理者が自分の付与を消すと 409、付与は残る", async () => {
    await makeApp();
    const { aliceGrant } = seedNote();
    const res = await httpDelete(alice, "note_grant", aliceGrant);
    expect(res.status, await res.clone().text()).toBe(409);
    expect(await res.text()).toContain(LAST_ADMIN_MESSAGE);
    expect(rowOf("note_grant", aliceGrant)?.permission).toBe("keeper");
  });

  test("(H-2) 最後の管理者が自分の権限名を変えると 409、権限名は残る", async () => {
    await makeApp();
    const { aliceGrant } = seedNote();
    const res = await httpPatch(alice, "note_grant", aliceGrant, { permission: "reader" });
    expect(res.status, await res.clone().text()).toBe(409);
    expect(await res.text()).toContain(LAST_ADMIN_MESSAGE);
    expect(rowOf("note_grant", aliceGrant)?.permission).toBe("keeper");
  });

  test("(H-3) 管理者が2人いれば、自分の権限名を変える更新は最後の管理者では断られない(今日どおり「自分に権限を付けられない」の 403)", async () => {
    await makeApp();
    const { note, aliceGrant } = seedNote();
    make("note_grant", { note, member: memberRow.carol, permission: "keeper" });
    const patched = await httpPatch(alice, "note_grant", aliceGrant, { permission: "reader" });
    expect(patched.status, await patched.clone().text()).toBe(403);
    expect(await patched.text()).not.toContain(LAST_ADMIN_MESSAGE);
  });

  test("(H-3b) 管理者が2人いれば、自分の付与を消せる", async () => {
    await makeApp();
    const { note, aliceGrant } = seedNote();
    make("note_grant", { note, member: memberRow.carol, permission: "keeper" });
    const res = await httpDelete(alice, "note_grant", aliceGrant);
    expect(res.status, await res.clone().text()).toBe(204);
    expect(rowOf("note_grant", aliceGrant)).toBeUndefined();
  });

  test("(H-4) グループ経由の管理者も数える(班に管理を渡していれば、自分を外せる)", async () => {
    await makeApp();
    const { note, aliceGrant } = seedNote();
    make("note_grant", { note, team: teamId, permission: "keeper" });
    const res = await httpDelete(alice, "note_grant", aliceGrant);
    expect(res.status, await res.clone().text()).toBe(204);
  });

  test("(H-4b) グループ経由の最後の管理者が、その班の付与を消すと 409", async () => {
    await makeApp();
    const note = make("notes", { body: "班だけ" });
    const teamGrant = make("note_grant", { note, team: teamId, permission: "keeper" });
    const res = await httpDelete(carol, "note_grant", teamGrant);
    expect(res.status, await res.clone().text()).toBe(409);
    expect(rowOf("note_grant", teamGrant)).toBeDefined();
  });

  test("(H-5) MCP の delete_record・update_record でも同じく断られ、付与が残る", async () => {
    await makeApp();
    const { aliceGrant } = seedNote();
    const deleted = await mcpCall("alice", "delete_record", {
      app_id: APP_ID,
      table_id: "note_grant",
      record_id: aliceGrant,
      if_match: String(rowOf("note_grant", aliceGrant)?._updated_at),
    });
    expect(deleted.isError).toBe(true);
    expect(deleted.text).toContain(LAST_ADMIN_MESSAGE);
    const updated = await mcpCall("alice", "update_record", {
      app_id: APP_ID,
      table_id: "note_grant",
      record_id: aliceGrant,
      if_match: String(rowOf("note_grant", aliceGrant)?._updated_at),
      changes: { permission: "reader" },
    });
    expect(updated.isError).toBe(true);
    expect(updated.text).toContain(LAST_ADMIN_MESSAGE);
    expect(rowOf("note_grant", aliceGrant)?.permission).toBe("keeper");
  });

  test("(H-6) まとめ書きの update でも 409、付与は残る", async () => {
    await makeApp();
    const { aliceGrant } = seedNote();
    const res = await send(
      "POST",
      `/api/apps/${APP_ID}/batch`,
      {
        ops: [
          {
            op: "update",
            table: "note_grant",
            target: aliceGrant,
            if_match: String(rowOf("note_grant", aliceGrant)?._updated_at),
            values: { permission: "reader" },
          },
        ],
      },
      alice.cookie,
    );
    expect(res.status, await res.clone().text()).toBe(409);
    expect(rowOf("note_grant", aliceGrant)?.permission).toBe("keeper");
  });

  test("(H-7) 運営(owner)は人の操作として最後の管理者の付与を外せる(D-V23-15)", async () => {
    await makeApp();
    const { aliceGrant } = seedNote();
    const patched = await httpPatch(owner, "note_grant", aliceGrant, { permission: "reader" });
    expect(patched.status, await patched.clone().text()).toBe(200);
    const deleted = await httpDelete(owner, "note_grant", aliceGrant);
    expect(deleted.status, await deleted.clone().text()).toBe(204);
  });

  test("(H-7b) D-V23-259: MCP でも運営は最後の管理者の付与を外せる(update_record・delete_record)。運営でない人は同じ操作を断られる", async () => {
    // 陰性対照: 運営でない最後の管理者(alice)は、MCP の delete_record で断られ、付与は残る(HTTP の 409 と同じ文)。
    await makeApp();
    const refused = seedNote();
    const aliceDelete = await mcpCall("alice", "delete_record", {
      app_id: APP_ID,
      table_id: "note_grant",
      record_id: refused.aliceGrant,
      if_match: String(rowOf("note_grant", refused.aliceGrant)?._updated_at),
    });
    expect(aliceDelete.isError, aliceDelete.text).toBe(true);
    expect(aliceDelete.text).toContain(LAST_ADMIN_MESSAGE);
    expect(rowOf("note_grant", refused.aliceGrant)?.permission).toBe("keeper");
    // 陽性: 運営(owner1)は同じ形の行の権限名を変え、別の行は消せる。
    const { aliceGrant } = seedNote();
    const updated = await mcpCall("owner1", "update_record", {
      app_id: APP_ID,
      table_id: "note_grant",
      record_id: aliceGrant,
      if_match: String(rowOf("note_grant", aliceGrant)?._updated_at),
      changes: { permission: "reader" },
    });
    expect(updated.isError, updated.text).toBe(false);
    expect(rowOf("note_grant", aliceGrant)?.permission).toBe("reader");
    const { aliceGrant: second } = seedNote();
    const deleted = await mcpCall("owner1", "delete_record", {
      app_id: APP_ID,
      table_id: "note_grant",
      record_id: second,
      if_match: String(rowOf("note_grant", second)?._updated_at),
    });
    expect(deleted.isError, deleted.text).toBe(false);
    expect(rowOf("note_grant", second)).toBeUndefined();
  });

  test("(H-8) 管理者のいない行の付与(閲覧だけ)を消すのは断らない(回復の経路を塞がない)", async () => {
    await makeApp();
    const note = make("notes", { body: "管理者なし" });
    make("note_grant", { note, member: memberRow.alice, permission: "keeper" });
    const bobGrant = make("note_grant", { note, member: memberRow.bob, permission: "reader" });
    // bob の閲覧の付与は alice(管理者)が消せる。管理者の数は変わらない。
    const res = await httpDelete(alice, "note_grant", bobGrant);
    expect(res.status, await res.clone().text()).toBe(204);
  });
});

// =====================================================================================
// (I) 引き継ぎ元に管理者がいれば、行そのものの最後の管理者は外せる(`D-V23-37`)
// =====================================================================================

/** 子 K に alice の管理の付与を置く。親 N の付与は `parent` で選ぶ。 */
function seedKid(parent: "admin" | "reader"): { kid: string; aliceKidGrant: string } {
  const note = make("notes", { body: "親" });
  make("note_grant", {
    note,
    member: parent === "admin" ? memberRow.carol : memberRow.bob,
    permission: parent === "admin" ? "keeper" : "reader",
  });
  const kid = make("kids", { title: "子", note });
  const aliceKidGrant = make("kid_grant", { kid, member: memberRow.alice, permission: "keeper" });
  return { kid, aliceKidGrant };
}

describe("V23-M1-T07 (I) 引き継ぎ元の管理者(D-V23-37)", () => {
  test("(I-1) 親の行に管理者がいれば、子の行の直接の最後の管理者は自分の付与を消せる", async () => {
    await makeApp();
    const { aliceKidGrant } = seedKid("admin");
    const res = await httpDelete(alice, "kid_grant", aliceKidGrant);
    expect(res.status, await res.clone().text()).toBe(204);
  });

  test("(I-2) 親の行にも管理者がいなければ(閲覧の付与だけ)、409 で断る", async () => {
    await makeApp();
    const { aliceKidGrant } = seedKid("reader");
    const res = await httpDelete(alice, "kid_grant", aliceKidGrant);
    expect(res.status, await res.clone().text()).toBe(409);
    expect(await res.text()).toContain(LAST_ADMIN_MESSAGE);
    expect(rowOf("kid_grant", aliceKidGrant)).toBeDefined();
  });

  test("(I-3) 引き継ぎの上限に当たって数え切れないときは断る(安全側)", async () => {
    await makeApp();
    const { aliceKidGrant } = seedKid("admin");
    // 親の段で読む名簿の行を上限(1000行)より多くする。
    withDb((db) => {
      for (let index = 0; index < 1001; index += 1) {
        const created = createRecord(db, current, "note_member", { account: `filler-${index}` });
        if (!created.ok) {
          throw new Error(JSON.stringify(created.errors));
        }
      }
    });
    const res = await httpDelete(alice, "kid_grant", aliceKidGrant);
    expect(res.status, await res.clone().text()).toBe(409);
    expect(rowOf("kid_grant", aliceKidGrant)).toBeDefined();
  });
});

// =====================================================================================
// (A) 自動処理・時刻起動・手動起動・書き戻し
// =====================================================================================

type Actor = "alice" | "bob" | "owner";
const ACTORS: readonly Actor[] = ["alice", "bob", "owner"];
const sessionOf = (who: Actor): Session => (who === "alice" ? alice : who === "bob" ? bob : owner);

/** きっかけの行を HTTP で作る(書き手 = 作った人)。 */
async function fire(
  who: Actor,
  grant: string,
  note: string,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return await send(
    "POST",
    RECORDS("cmds"),
    {
      title: "下げて",
      gtarget: grant,
      gnote: note,
      gmember: memberRow.alice,
      version: String(rowOf("note_grant", grant)?._updated_at),
      ...extra,
    },
    sessionOf(who).cookie,
  );
}

/** きっかけの行をカーネルで作る(名乗り無し)。 */
function fireUnnamed(grant: string, note: string): boolean {
  return withDb((db) => {
    const created = createRecord(db, current, "cmds", {
      title: "下げて",
      gtarget: grant,
      gnote: note,
      gmember: memberRow.alice,
      version: String(rowOf("note_grant", grant)?._updated_at),
    });
    return created.ok;
  });
}

describe("V23-M1-T07 (A) 自動処理は主体を問わず断る", () => {
  for (const wf of ["upd", "isl", "replace"] as const) {
    for (const who of ACTORS) {
      test(`(A-${wf}-${who}) ${wf} の書込が最後の管理者の付与を外すなら、書き手 ${who} でも失敗として履歴に残り、付与が残る`, async () => {
        await makeApp([wf]);
        const { note, aliceGrant } = seedNote();
        const res = await fire(who, aliceGrant, note);
        expect(res.status, await res.clone().text()).toBe(400);
        expect(rowOf("note_grant", aliceGrant)?.permission).toBe("keeper");
        expect(rows("cmds")).toHaveLength(0);
        expect(historyDetail()).toContain(AUTOMATION_MARK);
      });
    }
    test(`(A-${wf}-unnamed) ${wf} を名乗り無しで起こしても付与は残る`, async () => {
      await makeApp([wf]);
      const { note, aliceGrant } = seedNote();
      expect(fireUnnamed(aliceGrant, note)).toBe(false);
      expect(rowOf("note_grant", aliceGrant)?.permission).toBe("keeper");
      expect(historyDetail()).toContain("failure");
    });
    test(`(A-${wf}-ok) 陰性対照: 管理者が2人いれば ${wf} は通る`, async () => {
      await makeApp([wf]);
      const { note, aliceGrant } = seedNote();
      make("note_grant", { note, member: memberRow.carol, permission: "keeper" });
      // 全置換は付与の行を全部入れ替えるので、陰性対照では管理(keeper)を1行残す形で渡す。
      const res = await fire(
        "owner",
        aliceGrant,
        note,
        wf === "replace" ? { gperm: "keeper" } : {},
      );
      expect(res.status, await res.clone().text()).toBe(201);
      expect(historyDetail()).not.toContain(AUTOMATION_MARK);
    });
  }

  test("(A-sched) 時刻起動(行13)も名乗り無しで断り、失敗が履歴に残り、付与が残る", async () => {
    await makeApp(["sched"]);
    const { note, aliceGrant } = seedNote();
    const cmd = make("cmds", { title: "夜間", gtarget: aliceGrant, gnote: note });
    withDb((db) => {
      const workflow = (current.app.workflows ?? []).find((w) => w.id === "wf_sched");
      runScheduledWorkflow(db, current, workflow as never, {
        records: [rowOf("cmds", cmd) as never],
      });
    });
    expect(rowOf("note_grant", aliceGrant)?.permission).toBe("keeper");
    expect(historyDetail()).toContain(AUTOMATION_MARK);
    expect(historyDetail()).toContain("failure");
  });

  test("(A-sched-ok) 陰性対照: 管理者が2人いれば時刻起動は書ける", async () => {
    await makeApp(["sched"]);
    const { note, aliceGrant } = seedNote();
    make("note_grant", { note, member: memberRow.carol, permission: "keeper" });
    const cmd = make("cmds", { title: "夜間", gtarget: aliceGrant, gnote: note });
    withDb((db) => {
      const workflow = (current.app.workflows ?? []).find((w) => w.id === "wf_sched");
      runScheduledWorkflow(db, current, workflow as never, {
        records: [rowOf("cmds", cmd) as never],
      });
    });
    expect(rowOf("note_grant", aliceGrant)?.permission).toBe("reader");
  });

  test("(A-manual) 手動起動(行6)は押した人が運営でも断り、200 と failures で返り、履歴に残る(D-V23-31)", async () => {
    await makeApp(["manual"]);
    const { note, aliceGrant } = seedNote();
    const cmd = make("cmds", { title: "ボタン", gtarget: aliceGrant, gnote: note });
    const res = await send(
      "POST",
      `/api/apps/${APP_ID}/views/cmd_list/actions/run?workflow=wf_manual&record=${cmd}`,
      undefined,
      owner.cookie,
    );
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { failures: string[] };
    expect(body.failures.join(" ")).toContain(AUTOMATION_MARK);
    expect(rowOf("note_grant", aliceGrant)?.permission).toBe("keeper");
    expect(historyDetail()).toContain(AUTOMATION_MARK);
  });

  test("(A-wb) 書き戻し(行17)も断り、発火元の更新ごと巻き戻り、履歴に残る", async () => {
    await makeApp(["wb"]);
    const { aliceGrant } = seedNote();
    // 運営がメモの欄だけを書き換える(運営の人の操作は断られない)→ on_update の書き戻しが走る。
    const res = await httpPatch(owner, "note_grant", aliceGrant, { memo: "見直し" });
    expect(res.status, await res.clone().text()).toBe(400);
    const after = rowOf("note_grant", aliceGrant);
    expect(after?.permission).toBe("keeper");
    expect(after?.memo ?? null).toBe(null);
    expect(historyDetail()).toContain(AUTOMATION_MARK);
  });

  test("(A-ai) AI の書き戻し(行18)も本命・フォールバックとも断り、付与が残る", async () => {
    await makeApp(["ai"]);
    const store = AiCapabilityStore.openForKernel(dataRoot as string);
    try {
      store.createCapability({
        appId: APP_ID,
        name: "classifier",
        provider: "claude_cli",
        model: "claude-opus-4-8",
        limit: { maxCallsPerDay: 100, maxCostUsdPerDay: 10 },
      });
    } finally {
      store.close();
    }
    const { aliceGrant } = seedNote();
    // 運営がメモを書く → on_update で AI のジョブが積まれる。
    const res = await httpPatch(owner, "note_grant", aliceGrant, { memo: "見直し" });
    expect(res.status, await res.clone().text()).toBe(200);
    const provider: AiProvider = async () => ({
      text: '{"value":"reader"}',
      inputTokens: 1,
      outputTokens: 1,
    });
    await dispatchAiJobs(dataRoot as string, provider);
    expect(rowOf("note_grant", aliceGrant)?.permission).toBe("keeper");
    const kernelDb = new Database(join(dataRoot as string, "kernel.sqlite"), { readonly: true });
    try {
      const jobs = kernelDb
        .query<{ status: string; error: string | null }, []>(
          `SELECT "status", "error" FROM "ai_jobs" ORDER BY "rowid" ASC`,
        )
        .all();
      expect(jobs.map((job) => job.error ?? "").join(" ")).toContain(AUTOMATION_MARK);
    } finally {
      kernelDb.close();
    }
  });
});

// =====================================================================================
// (C) 親の行を消す連鎖(`D-V23-28`・`ADR-0510` §Decision 4)
// =====================================================================================

const CASCADE_APP = "last-row-admin-cascade";
const CASCADE_PERMS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "keeper", name: "管理", read: true, write: true, delete: true },
];
function cascadeDecl(grantTable: string, target: string, inherit?: string[]) {
  return {
    enabled: true,
    permissions: CASCADE_PERMS,
    creator_permission: "keeper",
    grant: { table: grantTable, target, member: "member", permission: "permission" },
    members: { table: "mem", account: "account" },
    ...(inherit === undefined ? { creatable_by_roles: ["editor"] } : { inherit_from: inherit }),
  };
}
function cascadeManifest(): Manifest {
  const perm = { id: "permission", name: "権限", type: "select", options: ["reader", "keeper"] };
  const base = {
    app: {
      id: CASCADE_APP,
      name: "連鎖と最後の管理者",
      tables: [
        { id: "mem", name: "名簿", fields: [{ id: "account", name: "利用者", type: "text" }] },
        {
          id: "projects",
          name: "親",
          fields: [{ id: "title", name: "名", type: "text" }],
          access_control: cascadeDecl("ac_grant", "project"),
        },
        {
          id: "docs",
          name: "付与先A",
          fields: [{ id: "title", name: "名", type: "text" }],
          access_control: cascadeDecl("dgrant", "doc"),
        },
        {
          id: "dgrant",
          name: "付与A(親 projects から引き継ぐ)",
          fields: [ref("doc", "docs"), ref("project", "projects"), ref("member", "mem"), perm],
          access_control: cascadeDecl("ac_grant", "dgr", ["project"]),
        },
        {
          id: "docs_b",
          name: "付与先B",
          fields: [{ id: "title", name: "名", type: "text" }],
          access_control: cascadeDecl("dgrant_b", "docb"),
        },
        {
          id: "dgrant_b",
          name: "付与B(付与先 docs_b から引き継ぐ)",
          fields: [ref("docb", "docs_b"), ref("member", "mem"), perm],
          access_control: cascadeDecl("ac_grant", "dgrb", ["docb"]),
        },
        {
          id: "ac_grant",
          name: "共通の付与",
          fields: [
            ref("project", "projects"),
            ref("dgr", "dgrant"),
            ref("dgrb", "dgrant_b"),
            ref("member", "mem"),
            perm,
          ],
        },
      ],
      views: [],
      roles: [
        { id: "owner", name: "持ち主" },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
    },
  };
  return withDefaultRoleRules(base as unknown as Manifest, {
    skipTables: ["projects", "docs", "dgrant", "docs_b", "dgrant_b"],
  });
}

async function makeCascadeApp(): Promise<{ keeper: Session; keeperMember: string }> {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-last-row-admin-cascade-"));
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, "連鎖", { app_id: CASCADE_APP });
  } finally {
    meta.close();
  }
  current = cascadeManifest();
  const applied = applyManifest(dataRoot, CASCADE_APP, current);
  if (!applied.valid) {
    throw new Error(JSON.stringify(applied.errors));
  }
  server = createServerApp({ dataRoot });
  seedSession(dataRoot, CASCADE_APP, { role: "owner", username: "owner1" });
  const keeper = seedSession(dataRoot, CASCADE_APP, { role: "editor", username: "keeper" });
  const keeperMember = cmake("mem", { account: keeper.userId });
  return { keeper, keeperMember };
}
function cdb<T>(fn: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot as string, CASCADE_APP));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
function cmake(tableId: string, values: Record<string, unknown>): string {
  return cdb((db) => {
    const created = createRecord(db, current, tableId, values);
    if (!created.ok) {
      throw new Error(`${tableId}: ${JSON.stringify(created.errors)}`);
    }
    return String(created.value._id);
  });
}
function ccount(tableId: string): number {
  return cdb((db) => (db.query(`SELECT COUNT(*) AS n FROM "${tableId}"`).get() as { n: number }).n);
}
function cversion(tableId: string, id: string): string {
  return cdb(
    (db) =>
      (db.query(`SELECT _updated_at AS v FROM "${tableId}" WHERE _id = ?`).get(id) as { v: string })
        .v,
  );
}
async function cdelete(who: Session, tableId: string, id: string, children?: string) {
  const headers: Record<string, string> = {
    cookie: who.cookie,
    origin: TEST_ORIGIN,
    "if-match": cversion(tableId, id),
  };
  if (children !== undefined) {
    headers["if-match-children"] = children;
  }
  return await server.request(`/api/apps/${CASCADE_APP}/tables/${tableId}/records/${id}`, {
    method: "DELETE",
    headers,
  });
}

describe("V23-M1-T07 (C) 親の行を消す連鎖", () => {
  test("(C-1) 形A: 付与先の行が残るのに最後の管理者の付与が連鎖で消えるなら、HTTP は連鎖ごと 409 で断り、何も消えない", async () => {
    const { keeper, keeperMember } = await makeCascadeApp();
    const p = cmake("projects", { title: "P1" });
    cmake("ac_grant", { project: p, member: keeperMember, permission: "keeper" });
    const d = cmake("docs", { title: "D1" });
    cmake("dgrant", { doc: d, project: p, member: keeperMember, permission: "keeper" });
    for (const seal of [undefined, "1"]) {
      const res = await cdelete(keeper, "projects", p, seal);
      expect(res.status, await res.clone().text()).toBe(409);
      expect(await res.text()).toContain(LAST_ADMIN_MESSAGE);
    }
    expect({
      projects: ccount("projects"),
      docs: ccount("docs"),
      dgrant: ccount("dgrant"),
    }).toEqual({ projects: 1, docs: 1, dgrant: 1 });
  });

  test("(C-2) 形A: AI の口(delete_record)も同じく断り、何も消えない", async () => {
    const { keeperMember } = await makeCascadeApp();
    const p = cmake("projects", { title: "P1" });
    cmake("ac_grant", { project: p, member: keeperMember, permission: "keeper" });
    const d = cmake("docs", { title: "D1" });
    cmake("dgrant", { doc: d, project: p, member: keeperMember, permission: "keeper" });
    const mcp = createMcpServer({
      dataRoot: dataRoot as string,
      previewBaseUrl: "http://localhost:3000",
      actor: "keeper",
    });
    const client = new Client({ name: "t07c", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), mcp.connect(b)]);
    try {
      for (const seal of [undefined, 1]) {
        const result = (await client.callTool({
          name: "delete_record",
          arguments: {
            app_id: CASCADE_APP,
            table_id: "projects",
            record_id: p,
            if_match: cversion("projects", p),
            ...(seal === undefined ? {} : { if_match_children: seal }),
          },
        })) as CallToolResult;
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain(LAST_ADMIN_MESSAGE);
      }
    } finally {
      await client.close();
      await mcp.close();
    }
    expect({
      projects: ccount("projects"),
      docs: ccount("docs"),
      dgrant: ccount("dgrant"),
    }).toEqual({ projects: 1, docs: 1, dgrant: 1 });
  });

  test("(C-3) 陰性対照 形B: 付与先の行も同じ連鎖で消えるなら、今日どおり通る", async () => {
    const { keeper, keeperMember } = await makeCascadeApp();
    const d = cmake("docs_b", { title: "D2" });
    cmake("dgrant_b", { docb: d, member: keeperMember, permission: "keeper" });
    const first = await cdelete(keeper, "docs_b", d);
    expect(first.status).toBe(409);
    expect(await first.text()).not.toContain(LAST_ADMIN_MESSAGE);
    const second = await cdelete(keeper, "docs_b", d, "1");
    expect(second.status, await second.clone().text()).toBe(204);
    expect({ docs_b: ccount("docs_b"), dgrant_b: ccount("dgrant_b") }).toEqual({
      docs_b: 0,
      dgrant_b: 0,
    });
  });

  test("(C-4) 陰性対照 形A: 付与先の行に別の管理者がいれば、今日どおり通る", async () => {
    const { keeper, keeperMember } = await makeCascadeApp();
    const other = seedSession(dataRoot as string, CASCADE_APP, {
      role: "editor",
      username: "other",
    });
    const otherMember = cmake("mem", { account: other.userId });
    const p = cmake("projects", { title: "P1" });
    cmake("ac_grant", { project: p, member: keeperMember, permission: "keeper" });
    const d = cmake("docs", { title: "D1" });
    cmake("dgrant", { doc: d, project: p, member: keeperMember, permission: "keeper" });
    cmake("dgrant", { doc: d, member: otherMember, permission: "keeper" });
    const res = await cdelete(keeper, "projects", p, "1");
    expect(res.status, await res.clone().text()).toBe(204);
    expect(ccount("docs")).toBe(1);
  });
});

// =====================================================================================
// (R) 運営の回復の一覧(`D-V23-16`・`D-V23-30`)
// =====================================================================================

type DoorRow = { _id: string; _orphan_reason?: string };
async function door(tableId: string): Promise<DoorRow[]> {
  const res = await send("GET", DOOR(tableId), undefined, owner.cookie);
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { records: DoorRow[] }).records;
}

describe("V23-M1-T07 (R) 運営の回復の一覧", () => {
  test("(R-1) 最後の管理者は退会でき、その行は他のメンバーの付与が残っていても「管理者がいない」理由付きで並ぶ(付与の行と名簿の行は残ったまま)", async () => {
    await makeApp();
    const { note } = seedNote();
    expect((await door("notes")).map((row) => row._id)).not.toContain(note);
    const res = await send("DELETE", `/api/apps/${APP_ID}/auth/me`, undefined, alice.cookie);
    expect(res.status, await res.clone().text()).toBe(200);
    // 自動登録の無いアプリなので、名簿の行も付与の行も残っている。
    expect(rows("note_member").map((row) => row.account)).toContain(alice.userId);
    expect(rows("note_grant").filter((row) => row.note === note)).toHaveLength(2);
    const listed = await door("notes");
    expect(listed.find((row) => row._id === note)?._orphan_reason).toBe("no_admin");
  });

  test("(R-2) 付与が0件の行も並び、理由は「付与が無い」", async () => {
    await makeApp();
    const bare = make("notes", { body: "付与なし" });
    const listed = await door("notes");
    expect(listed.find((row) => row._id === bare)?._orphan_reason).toBe("no_grants");
  });

  test("(R-3) 陰性対照: 管理者がいる行は並ばない", async () => {
    await makeApp();
    const { note } = seedNote();
    expect((await door("notes")).map((row) => row._id)).not.toContain(note);
  });

  test("(R-4) 閲覧の付与だけの行(管理者0人)は並ぶ", async () => {
    await makeApp();
    const note = make("notes", { body: "閲覧だけ" });
    make("note_grant", { note, member: memberRow.bob, permission: "reader" });
    const listed = await door("notes");
    expect(listed.find((row) => row._id === note)?._orphan_reason).toBe("no_admin");
  });

  test("(R-5) 引き継ぎ元に管理者がいれば、子の行は自分に管理者がいなくても並ばない(D-V23-30)", async () => {
    await makeApp();
    const { note } = seedNote();
    const kidBare = make("kids", { title: "付与なしの子", note });
    const kidReader = make("kids", { title: "閲覧だけの子", note });
    make("kid_grant", { kid: kidReader, member: memberRow.bob, permission: "reader" });
    const listed = (await door("kids")).map((row) => row._id);
    expect(listed).not.toContain(kidBare);
    expect(listed).not.toContain(kidReader);
  });

  test("(R-6) 引き継ぎ元にも管理者がいなければ、子の行は並ぶ", async () => {
    await makeApp();
    const note = make("notes", { body: "閲覧だけの親" });
    make("note_grant", { note, member: memberRow.bob, permission: "reader" });
    const kidReader = make("kids", { title: "閲覧だけの子", note });
    make("kid_grant", { kid: kidReader, member: memberRow.bob, permission: "reader" });
    const listed = await door("kids");
    expect(listed.find((row) => row._id === kidReader)?._orphan_reason).toBe("no_admin");
  });
});

// =====================================================================================
// (P)(N) 親の行の削除で、その行を対象・相手に持つ付与の行・招待・招待用コードを消す(`V23-M12-T02`。
// 決定 `D-V23-354`・`D-V23-355`・`D-V23-399`・`D-V23-405`・`D-V23-408`。門A = `ADR-0571` §Decision 1-1・
// `ADR-0575` §Decision 1 の1・4。指示の正は記録 `docs/plan/v23/records/v23-m12-t01c.md` §7-1 の P1〜P11・N1〜N6)
//
// 置き場をこのファイルにした理由: 新しい検査ファイルを足すと `scripts/kernel-import-snapshot.txt` と指紋が動き、
// その授権が無い。 このファイルは要る値の import(`ensureIslandRuntimeReady`・`runScheduledWorkflow` ほか)を
// 既に持つ。 直接のカーネルの削除は呼ばず、HTTP・AI の口・時刻起動で撃つ。 N4 は上の (C) の題材を使う。
//
// 測らないもの(誇張しない): 画面(部品の検査)からの削除の要求(本段は `web/` を1バイトも変えない。 削除の
// 要求の形は既存の `web/test/api.test.ts`・`web/test/detail-delete-cascade.test.tsx` が見張る)。 書き出した
// アプリ(生成器の側の突き合わせの検査 `parity-create-gate.test.ts` の G1〜G3)。
// =====================================================================================

describe("V23-M12-T02 親の削除と付属物(D-V23-354・D-V23-355・D-V23-399・D-V23-405・D-V23-408)", () => {
  const PD_APP = "pd-attach";
  const ALL_CAN = ["read", "write", "delete"];

  type Variant = {
    /** 付与の表 `org_grants` と組織 `orgs` が変更履歴を宣言する(P10)。 */
    grantHistory?: boolean;
    /** 名簿 `members` が変更履歴を宣言する(P6)。 */
    rosterHistory?: boolean;
    /** 名簿の自動登録を宣言する(P6。退会の連鎖が効く)。 */
    autoEnroll?: boolean;
    /** 島の全置換の自動処理を持つ(P9)。 */
    replace?: boolean;
    /** 【`V23-M12-T04`】評価機関に名前でない項目(`memo`)を持たせる(N2。名前以外が出ないことを数える)。 */
    agencyMemo?: boolean;
    /** 【`V23-M12-T04`】評価機関の代表項目(`title`)を運営ロールだけに見せる項目の規則(P4。隠れる代表項目)。 */
    hideAgencyTitle?: boolean;
    /**
     * 【`V23-M12-T07b`。`D-V23-422` の (1)】名簿 `members` を行ごとの権限の表にし(招待と招待用コードを持つ)、
     * 掲示 `boards` の付与の相手の行を名簿の行にする(P6b。退会で名簿の行が消えたときに、名簿の行を相手に持つ付与・
     * 名簿の行への招待・名簿の行を相手にしたコードの招待・名簿の行の招待用コードが消えるかを撃つ)。
     */
    rosterPrincipal?: boolean;
  };

  const ref = (id: string, table: string, extra: object = {}) => ({
    id,
    name: id,
    type: "reference",
    reference_table: table,
    ...extra,
  });
  const perm = (options: string[]) => ({
    id: "permission",
    name: "権限",
    type: "select",
    options,
  });

  const ORG_PERMS = [
    { id: "o_owner", name: "オーナー", read: true, write: true, delete: true },
    { id: "o_member", name: "メンバー", read: true, write: false, delete: false },
  ];

  const TABLE_IDS = [
    "members",
    "groups",
    "agencies",
    "agency_grants",
    "orgs",
    "org_grants",
    "depts",
    "dept_grants",
    "teams",
    "team_grants",
    "reports",
    "report_grants",
    "plain",
    "plain_child",
    "cmds",
    "wf_log",
  ];

  function pdManifest(variant: Variant = {}): Manifest {
    const members = {
      table: "members",
      account: "account",
      ...(variant.autoEnroll ? { auto_enroll: { roles: ["staff"] } } : {}),
    };
    const ruleTables = variant.rosterPrincipal
      ? [...TABLE_IDS, "member_grants", "boards", "board_grants"]
      : TABLE_IDS;
    const rules = (can: string[]) => ruleTables.map((table) => ({ target: "table", table, can }));
    const childDecl = (grantTable: string, target: string, parent: string) => ({
      enabled: true,
      permissions: ORG_PERMS,
      creator_permission: "o_owner",
      grant: { table: grantTable, target, member: "member", permission: "permission" },
      members,
      inherit_from: [parent],
    });
    return {
      app: {
        id: PD_APP,
        name: "親の削除と付属物",
        tables: [
          {
            id: "members",
            name: "名簿",
            representative_field: "name",
            ...(variant.rosterHistory ? { history: true } : {}),
            fields: [
              { id: "name", name: "名前", type: "text" },
              { id: "account", name: "利用者ID", type: "text", required: true },
            ],
            ...(variant.rosterPrincipal
              ? {
                  access_control: {
                    enabled: true,
                    permissions: [
                      { id: "m_self", name: "本人", read: true, write: true, delete: true },
                    ],
                    creator_permission: "m_self",
                    grant: {
                      table: "member_grants",
                      target: "member_row",
                      member: "member",
                      permission: "permission",
                    },
                    members,
                    invitations: { grantable: ["m_self"] },
                  },
                }
              : {}),
          },
          ...(variant.rosterPrincipal
            ? [
                {
                  id: "member_grants",
                  name: "名簿の付与",
                  fields: [
                    ref("member_row", "members"),
                    ref("member", "members"),
                    perm(["m_self"]),
                  ],
                },
                {
                  id: "boards",
                  name: "掲示",
                  fields: [{ id: "title", name: "名前", type: "text" }],
                  access_control: {
                    enabled: true,
                    permissions: [
                      { id: "b_view", name: "見る", read: true, write: false, delete: false },
                    ],
                    creator_permission: "b_view",
                    grant: {
                      table: "board_grants",
                      target: "board",
                      member: "member",
                      permission: "permission",
                      principal_row: { column: "roster", table: "members", via: ["m_self"] },
                    },
                    members,
                    invitations: { grantable: ["b_view"] },
                  },
                },
                {
                  id: "board_grants",
                  name: "掲示の付与",
                  fields: [
                    ref("board", "boards"),
                    ref("member", "members"),
                    ref("roster", "members"),
                    perm(["b_view"]),
                  ],
                },
              ]
            : []),
          { id: "groups", name: "グループ", fields: [{ id: "title", name: "名前", type: "text" }] },
          {
            id: "agencies",
            name: "評価機関",
            representative_field: "title",
            fields: [
              { id: "title", name: "名前", type: "text" },
              ...(variant.agencyMemo ? [{ id: "memo", name: "メモ", type: "text" }] : []),
            ],
            access_control: {
              enabled: true,
              permissions: [
                { id: "ag_lead", name: "代表", read: true, write: true, delete: true },
                { id: "ag_member", name: "専門家", read: true, write: false, delete: false },
              ],
              creator_permission: "ag_lead",
              grant: {
                table: "agency_grants",
                target: "agency",
                member: "member",
                permission: "permission",
              },
              members,
            },
          },
          {
            id: "agency_grants",
            name: "評価機関の付与",
            fields: [
              ref("agency", "agencies"),
              ref("member", "members"),
              perm(["ag_lead", "ag_member"]),
            ],
          },
          {
            id: "orgs",
            name: "組織",
            representative_field: "title",
            ...(variant.grantHistory ? { history: true } : {}),
            fields: [{ id: "title", name: "名前", type: "text" }],
            access_control: {
              enabled: true,
              permissions: ORG_PERMS,
              creator_permission: "o_owner",
              creatable_by_roles: ["staff"],
              grant: {
                table: "org_grants",
                target: "org",
                member: "member",
                group: "group",
                permission: "permission",
                principal_row: { column: "agency", table: "agencies", via: ["ag_member"] },
              },
              members,
              groups: { table: "groups" },
              invitations: { grantable: ["o_member"] },
            },
          },
          {
            id: "org_grants",
            name: "組織の付与",
            ...(variant.grantHistory ? { history: true } : {}),
            fields: [
              ref("org", "orgs"),
              ref("member", "members", { unique: true }),
              ref("group", "groups"),
              ref("agency", "agencies"),
              perm(["o_owner", "o_member"]),
            ],
          },
          {
            id: "depts",
            name: "部署",
            fields: [{ id: "title", name: "名前", type: "text" }, ref("org", "orgs")],
            access_control: childDecl("dept_grants", "dept", "org"),
          },
          {
            id: "dept_grants",
            name: "部署の付与",
            fields: [ref("dept", "depts"), ref("member", "members"), perm(["o_owner", "o_member"])],
          },
          {
            id: "teams",
            name: "班",
            fields: [{ id: "title", name: "名前", type: "text" }, ref("dept", "depts")],
            access_control: childDecl("team_grants", "team", "dept"),
          },
          {
            id: "team_grants",
            name: "班の付与",
            fields: [ref("team", "teams"), ref("member", "members"), perm(["o_owner", "o_member"])],
          },
          {
            id: "reports",
            name: "報告",
            fields: [{ id: "title", name: "名前", type: "text" }],
            access_control: {
              enabled: true,
              permissions: [
                { id: "r_admin", name: "報告の管理", read: true, write: true, delete: true },
              ],
              creator_permission: "r_admin",
              grant: {
                table: "report_grants",
                target: "report",
                member: "member",
                permission: "permission",
              },
              members,
            },
          },
          {
            id: "report_grants",
            name: "報告の付与",
            fields: [ref("report", "reports"), ref("member", "members"), perm(["r_admin"])],
          },
          {
            id: "plain",
            name: "宣言の無い表",
            fields: [{ id: "title", name: "名前", type: "text" }],
          },
          {
            id: "plain_child",
            name: "宣言の無い子",
            fields: [{ id: "title", name: "名前", type: "text" }, ref("parent", "plain")],
          },
          { id: "cmds", name: "指示", fields: [{ id: "title", name: "名前", type: "text" }] },
          {
            id: "wf_log",
            name: "処理の履歴",
            fields: [
              { id: "ran_at", name: "時刻", type: "date" },
              { id: "workflow", name: "処理", type: "text" },
              { id: "trigger_type", name: "きっかけ", type: "text" },
              { id: "status", name: "結果", type: "text" },
              { id: "error", name: "エラー", type: "long_text" },
            ],
          },
        ],
        views: [],
        ...(variant.replace
          ? {
              functions: [
                {
                  id: "remake_reports",
                  name: "報告を作り直す",
                  code: 'export default function (record) { return [{ title: "新しい報告" }]; }',
                  input: { source: "record" },
                  output: { fields: [{ id: "title", type: "text" }] },
                },
              ],
              workflows: [
                {
                  id: "wf_remake",
                  name: "夜間に報告を作り直す",
                  trigger: { type: "schedule", at: { hour: 3, minute: 0 }, table: "cmds" },
                  history_table: "wf_log",
                  actions: [
                    { action: "run_function", function: "remake_reports", output_table: "reports" },
                  ],
                },
                {
                  id: "wf_remake_plain",
                  name: "夜間に宣言の無い表を作り直す",
                  trigger: { type: "schedule", at: { hour: 4, minute: 0 }, table: "cmds" },
                  history_table: "wf_log",
                  actions: [
                    { action: "run_function", function: "remake_reports", output_table: "plain" },
                  ],
                },
              ],
            }
          : {}),
        workspace: { invitations: { label: "招待" } },
        roles: [
          {
            id: "owner",
            name: "運営",
            rules: [
              { target: "app", can: ["write"] },
              { target: "role", can: ["write"] },
              ...rules(ALL_CAN),
              ...(variant.hideAgencyTitle
                ? [{ target: "field", table: "agencies", field: "title", can: ["read", "write"] }]
                : []),
            ],
          },
          { id: "staff", name: "担当", rules: rules(ALL_CAN) },
          { id: "editor", name: "編集者" },
          { id: "viewer", name: "閲覧者" },
        ],
      },
    } as unknown as Manifest;
  }

  type Who = { cookie: string; userId: string; username: string };
  type Name = "boss" | "padmin" | "alice" | "carol" | "lead" | "expert" | "newbie";
  type Rig = {
    variant: Variant;
    manifest: Manifest;
    server: ReturnType<typeof createServerApp>;
    who: Record<Name, Who>;
    memberRow: Record<Name, string>;
  };

  let pdRoot = "";

  afterEach(async () => {
    if (pdRoot !== "") {
      await rm(pdRoot, { recursive: true, force: true });
      pdRoot = "";
    }
  });

  function openDb(): Database {
    return new Database(appDbPath(pdRoot, PD_APP));
  }

  function withDb<T>(fn: (db: Database) => T): T {
    const db = openDb();
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  function put(rig: Rig, table: string, values: object): string {
    return withDb((db) => {
      const created = createRecord(db, rig.manifest, table, values as Record<string, unknown>);
      if (!created.ok) {
        throw new Error(`${table} に行を置けない: ${JSON.stringify(created.errors)}`);
      }
      return created.value._id;
    });
  }

  function rows(table: string): Record<string, unknown>[] {
    return withDb((db) => {
      const has = db
        .query<{ n: number }, [string]>(
          "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(table);
      if ((has?.n ?? 0) === 0) {
        return [];
      }
      return db.query<Record<string, unknown>, []>(`SELECT * FROM "${table}" ORDER BY rowid`).all();
    });
  }

  const count = (table: string): number => rows(table).length;
  const where = (table: string, column: string, value: string) =>
    rows(table).filter((row) => row[column] === value);

  function versionOf(table: string, id: string): string {
    const found = rows(table).find((row) => row._id === id);
    if (found === undefined) {
      throw new Error(`行 ${id} が ${table} に無い`);
    }
    return String(found._updated_at);
  }

  async function makeRig(variant: Variant = {}): Promise<Rig> {
    if (variant.replace) {
      await ensureIslandRuntimeReady();
    }
    pdRoot = await mkdtemp(join(tmpdir(), "gp-pd-attach-"));
    const meta = KernelMetaStore.open(pdRoot);
    try {
      createApp(meta, "親の削除と付属物", { app_id: PD_APP });
    } finally {
      meta.close();
    }
    const built = pdManifest(variant);
    const applied = applyManifest(pdRoot, PD_APP, built);
    if (!applied.valid) {
      throw new Error(JSON.stringify(applied.errors));
    }
    const seed = (username: string, role: string): Who => {
      const s = seedSession(pdRoot, PD_APP, { role, username });
      return { cookie: s.cookie, userId: s.userId, username };
    };
    const who: Record<Name, Who> = {
      boss: seed("boss", "owner"),
      padmin: seed("padmin", "staff"),
      alice: seed("alice", "staff"),
      carol: seed("carol", "staff"),
      lead: seed("lead", "staff"),
      expert: seed("expert", "staff"),
      newbie: seed("newbie", "staff"),
    };
    const rig: Rig = {
      variant,
      manifest: built,
      server: createServerApp({ dataRoot: pdRoot }),
      who,
      memberRow: {} as Record<Name, string>,
    };
    for (const name of Object.keys(who) as Name[]) {
      rig.memberRow[name] = put(rig, "members", { name, account: who[name].userId });
    }
    return rig;
  }

  type Sent = { status: number; body: Record<string, unknown>; text: string };

  async function call(
    rig: Rig,
    method: "GET" | "POST" | "DELETE",
    path: string,
    options: { who?: Who; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Sent> {
    const headers: Record<string, string> = { origin: TEST_ORIGIN, ...(options.headers ?? {}) };
    if (options.who !== undefined) {
      headers.cookie = options.who.cookie;
    }
    if (method === "POST") {
      headers["content-type"] = "application/json";
    }
    const res = await rig.server.request(
      new Request(`http://localhost/api/apps/${PD_APP}${path}`, {
        method,
        headers,
        ...(method === "POST" ? { body: JSON.stringify(options.body ?? {}) } : {}),
      }),
    );
    const text = await res.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { raw: text };
    }
    return { status: res.status, body, text };
  }

  const httpDelete = (rig: Rig, who: Who, table: string, id: string, children?: number) =>
    call(rig, "DELETE", `/tables/${table}/records/${id}`, {
      who,
      headers: {
        "if-match": versionOf(table, id),
        ...(children === undefined ? {} : { "if-match-children": String(children) }),
      },
    });

  async function mcpDelete(
    _rig: Rig,
    who: Who,
    table: string,
    id: string,
    children?: number,
  ): Promise<CallToolResult> {
    const server = createMcpServer({
      dataRoot: pdRoot,
      previewBaseUrl: "http://localhost:3000",
      actor: who.username,
    });
    const client = new Client({ name: "pd-attach", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    try {
      return (await client.callTool({
        name: "delete_record",
        arguments: {
          app_id: PD_APP,
          table_id: table,
          record_id: id,
          if_match: versionOf(table, id),
          ...(children === undefined ? {} : { if_match_children: children }),
        },
      })) as CallToolResult;
    } finally {
      await client.close();
      await server.close();
    }
  }

  /** 組織を1つ置き、オーナーとメンバーの付与を付ける。 */
  function seedOrg(rig: Rig, title: string, owner: Name, member?: Name): string {
    const org = put(rig, "orgs", { title });
    put(rig, "org_grants", { org, member: rig.memberRow[owner], permission: "o_owner" });
    if (member !== undefined) {
      put(rig, "org_grants", { org, member: rig.memberRow[member], permission: "o_member" });
    }
    return org;
  }

  /** 評価機関を1つ置き、代表と専門家の付与を付ける。 */
  function seedAgency(rig: Rig, title: string): string {
    const agency = put(rig, "agencies", { title });
    put(rig, "agency_grants", { agency, member: rig.memberRow.lead, permission: "ag_lead" });
    put(rig, "agency_grants", { agency, member: rig.memberRow.expert, permission: "ag_member" });
    return agency;
  }

  async function issueCode(rig: Rig, who: Who, table: string, id: string): Promise<string> {
    const sent = await call(rig, "POST", `/tables/${table}/records/${id}/invite-code`, { who });
    expect(sent.status, sent.text).toBe(200);
    return sent.body.code as string;
  }

  async function inviteByName(rig: Rig, who: Who, org: string, login: string): Promise<void> {
    const sent = await call(rig, "POST", `/tables/orgs/records/${org}/invitations`, {
      who,
      body: { login, permission: "o_member" },
    });
    expect(sent.status, sent.text).toBe(202);
  }

  async function inviteByCode(rig: Rig, who: Who, org: string, code: string): Promise<void> {
    const sent = await call(rig, "POST", `/tables/orgs/records/${org}/invitations`, {
      who,
      body: { code, permission: "o_member" },
    });
    expect(sent.status, sent.text).toBe(202);
  }

  const invitations = () => rows("_row_invitations");
  const codes = () => rows("_row_invite_codes");
  const history = (table: string) =>
    rows("_record_history").filter((row) => row.table_id === table && row.op === "delete");

  // =====================================================================================
  // P: 消える
  // =====================================================================================

  describe("V23-M12-T02 D-V23-354: 親の行(対象)を消すと、付与の行・招待・招待用コードが消える", () => {
    test("P1 D-V23-354: 組織を HTTP で消すと、その行を対象に持つ付与(最後のオーナーを含む)・その行への未承諾の招待が0行", async () => {
      const rig = await makeRig();
      const org = seedOrg(rig, "組織1", "padmin", "alice");
      await inviteByName(rig, rig.who.padmin, org, "carol");
      expect(where("org_grants", "org", org)).toHaveLength(2);
      expect(invitations()).toHaveLength(1);

      const sent = await httpDelete(rig, rig.who.padmin, "orgs", org);
      expect(sent.status, sent.text).toBe(204);
      expect(where("org_grants", "org", org)).toEqual([]);
      expect(invitations()).toEqual([]);
      // 招待用コードは相手の行の表にだけ出せる(組織は相手の行の宣言を持つので、相手の行の表になれない。
      // 「たどれるのは1段だけ」)。 行のコードが消えることは P3(評価機関)で確かめる。
    });

    test("P2 D-V23-354: 消した後、元のオーナーは新しい組織を作れ、元のメンバーは別の組織の招待を承諾できる(1人1組織の一意が当たらない)", async () => {
      const rig = await makeRig();
      const org = seedOrg(rig, "組織1", "padmin", "alice");
      const other = seedOrg(rig, "組織2", "carol");
      expect((await httpDelete(rig, rig.who.padmin, "orgs", org)).status).toBe(204);

      const created = await call(rig, "POST", "/tables/orgs/records", {
        who: rig.who.padmin,
        body: { title: "組織3" },
      });
      expect(created.status, created.text).toBe(201);
      expect(where("org_grants", "member", rig.memberRow.padmin)).toHaveLength(1);

      await inviteByName(rig, rig.who.carol, other, "alice");
      const invitationId = String(invitations()[0]?.id);
      const accepted = await call(rig, "POST", `/invitations/${invitationId}`, {
        who: rig.who.alice,
        body: { action: "accept" },
      });
      expect(accepted.status, accepted.text).toBe(200);
      expect(where("org_grants", "member", rig.memberRow.alice).map((row) => row.org)).toEqual([
        other,
      ]);
    });

    test("P3 D-V23-354: 相手の行(評価機関)を消すと、それを相手に持つ付与・その行を相手にしたコードの招待・その行の招待用コードが消える", async () => {
      const rig = await makeRig();
      const org = seedOrg(rig, "組織1", "padmin");
      const agency = seedAgency(rig, "機関A");
      const agencyB = seedAgency(rig, "機関B");
      put(rig, "org_grants", { org, agency, permission: "o_member" });
      const org2 = seedOrg(rig, "組織2", "carol");
      const code = await issueCode(rig, rig.who.lead, "agencies", agency);
      await inviteByCode(rig, rig.who.carol, org2, code);
      const codeB = await issueCode(rig, rig.who.lead, "agencies", agencyB);
      expect(codeB).not.toBe(code);
      expect(invitations()).toHaveLength(1);
      expect(codes()).toHaveLength(2);

      const sent = await httpDelete(rig, rig.who.lead, "agencies", agency);
      expect(sent.status, sent.text).toBe(204);
      expect(where("org_grants", "agency", agency)).toEqual([]);
      expect(invitations()).toEqual([]);
      expect(codes().map((row) => row.record_id)).toEqual([agencyB]);
      // 評価機関の行を対象に持つ自分の付与(agency_grants)も消える。
      expect(where("agency_grants", "agency", agency)).toEqual([]);
      expect(where("agency_grants", "agency", agencyB)).toHaveLength(2);
      // 組織の行と、組織のオーナーの付与は残る。
      expect(where("org_grants", "org", org).map((row) => row.permission)).toEqual(["o_owner"]);
    });

    test("P4 D-V23-399: 相手の行の付与が残る行の唯一の管理を担っていても、運営者以外の削除は 204。残る行は運営の回復の一覧に「管理者がいない」で出る", async () => {
      const rig = await makeRig();
      const org = put(rig, "orgs", { title: "組織1" });
      const agency = seedAgency(rig, "機関A");
      put(rig, "org_grants", { org, agency, permission: "o_owner" });
      put(rig, "org_grants", { org, member: rig.memberRow.alice, permission: "o_member" });

      const sent = await httpDelete(rig, rig.who.lead, "agencies", agency);
      expect(sent.status, sent.text).toBe(204);
      expect(where("org_grants", "agency", agency)).toEqual([]);
      expect(count("orgs")).toBe(1);
      const door = await call(rig, "GET", "/tables/orgs/unreachable-records", {
        who: rig.who.boss,
      });
      expect(door.status, door.text).toBe(200);
      const listed = (door.body.records ?? []) as { _id: string; _orphan_reason?: string }[];
      expect(listed.find((row) => row._id === org)?._orphan_reason).toBe("no_admin");
    });
  });

  describe("V23-M12-T02 D-V23-405: 名簿の行・グループの行を消すと、それを相手に持つ付与が消える", () => {
    test("P5 D-V23-405: 運営者が名簿の行を一覧から消すと grant.member の付与が、グループの行を消すと grant.group の付与が消える", async () => {
      const rig = await makeRig();
      const org = seedOrg(rig, "組織1", "padmin", "alice");
      const group = put(rig, "groups", { title: "G" });
      const otherGroup = put(rig, "groups", { title: "H" });
      put(rig, "org_grants", { org, group, permission: "o_member" });
      put(rig, "org_grants", { org, group: otherGroup, permission: "o_member" });

      const removedMember = await httpDelete(rig, rig.who.boss, "members", rig.memberRow.alice);
      expect(removedMember.status, removedMember.text).toBe(204);
      expect(where("org_grants", "member", rig.memberRow.alice)).toEqual([]);

      const removedGroup = await httpDelete(rig, rig.who.boss, "groups", group);
      expect(removedGroup.status, removedGroup.text).toBe(204);
      expect(where("org_grants", "group", group)).toEqual([]);
      // 消していない行を指す付与は残る。
      expect(where("org_grants", "group", otherGroup)).toHaveLength(1);
      expect(where("org_grants", "member", rig.memberRow.padmin)).toHaveLength(1);
    });

    for (const rosterHistory of [false, true]) {
      test(`P6 D-V23-405: 退会で名簿の行が消えると、その行を相手に持つ付与の行が消える(名簿の履歴の宣言 ${rosterHistory ? "あり" : "なし"}。答えは同じ)`, async () => {
        const rig = await makeRig({ autoEnroll: true, rosterHistory });
        const org = seedOrg(rig, "組織1", "padmin", "alice");
        const res = await call(rig, "DELETE", "/auth/me", { who: rig.who.alice });
        expect(res.status, res.text).toBe(200);
        expect(where("members", "account", rig.who.alice.userId)).toEqual([]);
        expect(where("org_grants", "member", rig.memberRow.alice)).toEqual([]);
        expect(where("org_grants", "org", org).map((row) => row.permission)).toEqual(["o_owner"]);
        expect(count("members")).toBe(6);
      });
    }

    // 【`V23-M12-T07b`。`D-V23-422` の (1)。独立点検の中1】直す前の形(名簿の履歴の宣言が無ければ名簿の行を生の DELETE で消す)
    // でも grant.member の付与は退会の連鎖が先に消していたので、上の P6 は直す前から緑だった(歯が無い)。 直す前の形で残るのは、
    // 名簿の行を相手の行に持つ付与・名簿の行への招待・名簿の行を相手にしたコードの招待・名簿の行の招待用コードである。
    test("P6b D-V23-405・D-V23-422: 名簿の履歴の宣言が無くても、退会で名簿の行が消えると、名簿の行を相手の行に持つ付与・名簿の行への招待・名簿の行を相手にしたコードの招待・名簿の行の招待用コードが消える", async () => {
      const rig = await makeRig({ autoEnroll: true, rosterPrincipal: true });
      const aliceRow = rig.memberRow.alice;
      const carolRow = rig.memberRow.carol;
      const board = put(rig, "boards", { title: "掲示1" });
      put(rig, "board_grants", { board, roster: aliceRow, permission: "b_view" });
      put(rig, "board_grants", { board, roster: carolRow, permission: "b_view" });
      // 名簿の行への招待(ログイン名)。
      const invited = await call(rig, "POST", `/tables/members/records/${aliceRow}/invitations`, {
        who: rig.who.boss,
        body: { login: "newbie", permission: "m_self" },
      });
      expect(invited.status, invited.text).toBe(202);
      // 名簿の行の招待用コードと、そのコードでの掲示への招待。
      const code = await issueCode(rig, rig.who.boss, "members", aliceRow);
      const codeCarol = await issueCode(rig, rig.who.boss, "members", carolRow);
      expect(codeCarol).not.toBe(code);
      // 同じ相手の行への付与が既にある行には、コードの招待は保存されない(応答は同じ)ので、別の掲示に招く。
      const board2 = put(rig, "boards", { title: "掲示2" });
      const byCode = await call(rig, "POST", `/tables/boards/records/${board2}/invitations`, {
        who: rig.who.boss,
        body: { code, permission: "b_view" },
      });
      expect(byCode.status, byCode.text).toBe(202);
      expect(invitations()).toHaveLength(2);
      expect(codes()).toHaveLength(2);

      const res = await call(rig, "DELETE", "/auth/me", { who: rig.who.alice });
      expect(res.status, res.text).toBe(200);
      expect(where("members", "account", rig.who.alice.userId)).toEqual([]);
      expect(where("board_grants", "roster", aliceRow)).toEqual([]);
      expect(invitations()).toEqual([]);
      expect(codes().map((row) => row.record_id)).toEqual([carolRow]);
      // 消していない名簿の行を相手に持つ付与は残る。
      expect(where("board_grants", "roster", carolRow)).toHaveLength(1);
    });
  });

  describe("V23-M12-T02 D-V23-354: 削除の口ごと(連鎖・AI の口・全置換)", () => {
    // 【V23-M14-T02。授権 ADR-0579 §2-1 の2。D-V23-465】旧の題は
    // 「P7 D-V23-354: 子ごと消す連鎖(inherit_from)の子と孫の付与の行も消える。確認の件数と表の名は直す前と同じ」、
    // 旧の期待の文は「この行には、ぶら下がっている行が 2 件あります(depts / teams)。まとめて消してよければ、
    // 件数の印を付けて同じ操作をもう一度実行してください。1行も消していません。」。 件数2と消える行は変えず、文だけを新しい文に替えた。
    test("P7 D-V23-354・D-V23-465: 子ごと消す連鎖(inherit_from)の子と孫の付与の行も消える。確認の件数は直す前と同じで、表は表示名で言う", async () => {
      const rig = await makeRig();
      const org = seedOrg(rig, "組織1", "padmin");
      const dept = put(rig, "depts", { title: "部署1", org });
      put(rig, "dept_grants", { dept, member: rig.memberRow.alice, permission: "o_member" });
      const team = put(rig, "teams", { title: "班1", dept });
      put(rig, "team_grants", { team, member: rig.memberRow.carol, permission: "o_member" });

      const first = await httpDelete(rig, rig.who.padmin, "orgs", org);
      expect(first.status, first.text).toBe(409);
      expect((first.body.errors as { message: string }[])[0]?.message).toBe(
        "この「組織」を消すと、一緒に消える行が全部で 2 件あります(「部署」1 件、「班」1 件)。まとめて消してよければ、件数を確かめたうえで、もう一度削除してください。まだ1行も消していません。",
      );
      const second = await httpDelete(rig, rig.who.padmin, "orgs", org, 2);
      expect(second.status, second.text).toBe(204);
      expect({
        orgs: count("orgs"),
        depts: count("depts"),
        teams: count("teams"),
        org_grants: count("org_grants"),
        dept_grants: count("dept_grants"),
        team_grants: count("team_grants"),
      }).toEqual({ orgs: 0, depts: 0, teams: 0, org_grants: 0, dept_grants: 0, team_grants: 0 });
    });

    test("P8 D-V23-354: AI の口の delete_record(単件と子ごとの印つき)でも消える", async () => {
      const rig = await makeRig();
      const org = seedOrg(rig, "組織1", "padmin", "alice");
      await inviteByName(rig, rig.who.padmin, org, "carol");
      const single = await mcpDelete(rig, rig.who.padmin, "orgs", org);
      expect(single.isError, JSON.stringify(single.content)).not.toBe(true);
      expect(where("org_grants", "org", org)).toEqual([]);
      expect(invitations()).toEqual([]);

      const org2 = seedOrg(rig, "組織2", "carol");
      const dept = put(rig, "depts", { title: "部署", org: org2 });
      put(rig, "dept_grants", { dept, member: rig.memberRow.alice, permission: "o_member" });
      const cascade = await mcpDelete(rig, rig.who.carol, "orgs", org2, 1);
      expect(cascade.isError, JSON.stringify(cascade.content)).not.toBe(true);
      expect({ org_grants: count("org_grants"), dept_grants: count("dept_grants") }).toEqual({
        org_grants: 0,
        dept_grants: 0,
      });
    });

    test("P9 D-V23-354: 自動処理の関数の出力の全置換で、全置換の先の表が付与の対象のとき、消えた行の付与の行が消える", async () => {
      const rig = await makeRig({ replace: true });
      const report = put(rig, "reports", { title: "古い報告" });
      put(rig, "report_grants", { report, member: rig.memberRow.alice, permission: "r_admin" });
      const cmd = put(rig, "cmds", { title: "夜間" });
      withDb((db) => {
        const workflow = (rig.manifest.app.workflows ?? []).find((w) => w.id === "wf_remake");
        runScheduledWorkflow(db, rig.manifest, workflow as never, {
          records: [rows("cmds").find((row) => row._id === cmd) as never],
        });
      });
      expect(rows("reports").map((row) => row.title)).toEqual(["新しい報告"]);
      expect(where("report_grants", "report", report)).toEqual([]);
    });

    test("P10 D-V23-354: 付与の表が変更履歴を宣言していれば、消えた付与の行ごとに削除の記録が1件残る(操作者と入口は親の削除と同じ)", async () => {
      const rig = await makeRig({ grantHistory: true });
      const org = seedOrg(rig, "組織1", "padmin", "alice");
      const grantIds = where("org_grants", "org", org).map((row) => String(row._id));
      expect((await httpDelete(rig, rig.who.padmin, "orgs", org)).status).toBe(204);
      const parent = history("orgs");
      expect(parent).toHaveLength(1);
      const grants = history("org_grants");
      expect(grants.map((row) => row.record_id).sort()).toEqual([...grantIds].sort());
      const actorOf = (row: Record<string, unknown> | undefined) => ({
        actor_id: row?.actor_id,
        actor_login: row?.actor_login,
        actor_role: row?.actor_role,
        entry: row?.entry,
      });
      for (const row of grants) {
        expect(actorOf(row)).toEqual(actorOf(parent[0]));
      }
      expect(actorOf(parent[0]).actor_id).toBe(rig.who.padmin.userId);
    });

    test("P11 D-V23-354: 差分を当てる → 親を消す → undo で、親・付与・招待がそろって戻り、差分の後に作った行は消える。preview_undo の操作に行の削除は出ない", async () => {
      const rig = await makeRig();
      const org = seedOrg(rig, "組織1", "padmin", "alice");
      await inviteByName(rig, rig.who.padmin, org, "carol");
      const applied = await call(rig, "POST", "/diffs", {
        who: rig.who.boss,
        body: {
          diff_id: "p11-mark",
          intent: "巻き戻しの起点を作るために、宣言の無い表へ列を1本足した",
          operations: [
            {
              op: "add_field",
              table: "plain",
              field: { id: "note", name: "メモ", type: "text" },
            },
          ],
        },
      });
      expect(applied.status, applied.text).toBe(201);
      put(rig, "plain", { title: "差分の後に作った行" });
      expect((await httpDelete(rig, rig.who.padmin, "orgs", org)).status).toBe(204);
      expect(where("org_grants", "org", org)).toEqual([]);

      const preview = await call(rig, "GET", "/undo/preview", { who: rig.who.boss });
      expect(preview.status, preview.text).toBe(200);
      const operations = JSON.stringify(
        (preview.body.preview as { operations?: unknown } | undefined)?.operations ??
          preview.body.operations ??
          [],
      );
      expect(operations).toContain("add_field");
      expect(operations).not.toContain("delete");

      const undone = await call(rig, "POST", "/undo", { who: rig.who.boss });
      expect(undone.status, undone.text).toBe(200);
      expect(count("orgs")).toBe(1);
      expect(where("org_grants", "org", org)).toHaveLength(2);
      expect(invitations()).toHaveLength(1);
      expect(count("plain")).toBe(0);
    });
  });

  // =====================================================================================
  // N: 消えない(陰性)
  // =====================================================================================

  describe("V23-M12-T02 D-V23-354 陰性: 消していない行の付属物は1行も消えない", () => {
    test("N1 D-V23-354: 消していない行を指す付与の行・招待・コードは1行も消えない(同じ表の別の行の付与を数える)", async () => {
      const rig = await makeRig();
      const org1 = seedOrg(rig, "組織1", "padmin");
      const org2 = seedOrg(rig, "組織2", "carol", "alice");
      await inviteByName(rig, rig.who.carol, org2, "newbie");
      const agency = seedAgency(rig, "機関A");
      await issueCode(rig, rig.who.lead, "agencies", agency);
      const before = {
        grants: where("org_grants", "org", org2).length,
        invitations: invitations().length,
        codes: codes().length,
      };
      expect(before).toEqual({ grants: 2, invitations: 1, codes: 1 });
      expect((await httpDelete(rig, rig.who.padmin, "orgs", org1)).status).toBe(204);
      expect({
        grants: where("org_grants", "org", org2).length,
        invitations: invitations().length,
        codes: codes().length,
      }).toEqual(before);
    });

    test("N2 D-V23-355: 直す前から残っている付与の行(親の行だけを生の SQL で消して作る)は、別の行を消しても残る", async () => {
      const rig = await makeRig();
      const stale = seedOrg(rig, "古い組織", "padmin", "alice");
      withDb((db) => {
        db.query('DELETE FROM "orgs" WHERE "_id" = ?').run(stale);
      });
      const org2 = seedOrg(rig, "組織2", "carol");
      expect((await httpDelete(rig, rig.who.carol, "orgs", org2)).status).toBe(204);
      expect(where("org_grants", "org", stale)).toHaveLength(2);
      expect(where("org_grants", "org", org2)).toEqual([]);
    });

    test("N3 線1: 宣言の無い表の削除で、消える行の数が直す前と同じで、削除の器が開かない(db.transaction は監査の器の1回だけ)", async () => {
      const rig = await makeRig();
      const a = put(rig, "plain", { title: "一" });
      put(rig, "plain", { title: "二" });
      const org = seedOrg(rig, "組織1", "padmin");
      const org2 = seedOrg(rig, "組織2", "carol");
      const spy = spyOn(Database.prototype, "transaction");
      try {
        // 宣言の無い表: 開く器は HTTP の監査の器(writeWithAudit)の1つだけ。
        expect((await httpDelete(rig, rig.who.boss, "plain", a)).status).toBe(204);
        expect(spy).toHaveBeenCalledTimes(1);
        // 陽性対照: 付属物のある表は、削除の器がもう1つ開く(差し込みが数えていることの確かめ)。
        spy.mockClear();
        expect((await httpDelete(rig, rig.who.padmin, "orgs", org)).status).toBe(204);
        expect(spy).toHaveBeenCalledTimes(2);
      } finally {
        spy.mockRestore();
      }
      expect(count("plain")).toBe(1);
      expect(where("org_grants", "org", org2)).toHaveLength(1);
    });

    test("N4 ADR-0510 §4 の2: inherit_from で連鎖する付与の表の行で、残る行の最後の管理者が消える形は、今日どおり連鎖ごと 409", async () => {
      const { keeper, keeperMember } = await makeCascadeApp();
      const p = cmake("projects", { title: "P1" });
      cmake("ac_grant", { project: p, member: keeperMember, permission: "keeper" });
      const d = cmake("docs", { title: "D1" });
      // 残る行(docs)の最後の管理者は、projects から引き継ぐ付与の表 dgrant の行(連鎖で消える)だけ。
      cmake("dgrant", { doc: d, project: p, member: keeperMember, permission: "keeper" });
      for (const seal of [undefined, "1"]) {
        const res = await cdelete(keeper, "projects", p, seal);
        expect(res.status, await res.clone().text()).toBe(409);
        expect(await res.text()).toContain(LAST_ADMIN_MESSAGE);
      }
      expect({
        projects: ccount("projects"),
        docs: ccount("docs"),
        dgrant: ccount("dgrant"),
        ac_grant: ccount("ac_grant"),
      }).toEqual({ projects: 1, docs: 1, dgrant: 1, ac_grant: 1 });
    });

    test("N5 D-V23-354: AI の口で関係の無い行を消しても付与は消えない・全置換の先が付与の対象でなければ付与は消えない・付与の表を宣言していない連鎖では何も消えない", async () => {
      const rig = await makeRig({ replace: true });
      const org = seedOrg(rig, "組織1", "padmin", "alice");
      const report = put(rig, "reports", { title: "報告" });
      put(rig, "report_grants", { report, member: rig.memberRow.alice, permission: "r_admin" });
      const plainRow = put(rig, "plain", { title: "消す" });
      const removed = await mcpDelete(rig, rig.who.boss, "plain", plainRow);
      expect(removed.isError, JSON.stringify(removed.content)).not.toBe(true);
      expect(where("org_grants", "org", org)).toHaveLength(2);

      const cmd = put(rig, "cmds", { title: "夜間" });
      withDb((db) => {
        const workflow = (rig.manifest.app.workflows ?? []).find((w) => w.id === "wf_remake_plain");
        runScheduledWorkflow(db, rig.manifest, workflow as never, {
          records: [rows("cmds").find((row) => row._id === cmd) as never],
        });
      });
      expect(rows("plain").map((row) => row.title)).toEqual(["新しい報告"]);
      expect(count("report_grants")).toBe(1);
      expect(count("org_grants")).toBe(2);

      // 宣言の無い表には子ごとの連鎖が無い: 子の残る親は1回目で 204、子は親を指したまま残る。
      const parent = put(rig, "plain", { title: "親" });
      put(rig, "plain_child", { title: "子", parent });
      expect((await httpDelete(rig, rig.who.boss, "plain", parent)).status).toBe(204);
      expect(where("plain_child", "parent", parent)).toHaveLength(1);
      expect(count("org_grants")).toBe(2);
      expect(count("report_grants")).toBe(1);
    });

    test("N6: 付与の行の削除が失敗すると、親の行も消えない(器ごと巻き戻る)", async () => {
      const rig = await makeRig();
      const org = seedOrg(rig, "組織1", "padmin", "alice");
      withDb((db) => {
        db.exec(
          'CREATE TRIGGER "pd_attach_block" BEFORE DELETE ON "org_grants" BEGIN SELECT RAISE(ABORT, \'付与の行を消せない\'); END;',
        );
      });
      const sent = await httpDelete(rig, rig.who.padmin, "orgs", org).catch((error: unknown) => ({
        status: 0,
        body: {},
        text: String(error),
      }));
      expect(sent.status).not.toBe(204);
      expect(count("orgs")).toBe(1);
      expect(where("org_grants", "org", org)).toHaveLength(2);
    });
  });

  // =====================================================================================
  // V23-M12-T02b: 対象の行が消えた付与の行を運営者が消せる(D-V23-365・D-V23-400)
  // 置き場は D-V23-414 の (1) のとおり既存のファイル(新しいファイルは kernel-import-snapshot を動かす)。
  // 題材と道具は上の T02 の節のものを使う(対象の消えた付与の行は、N2 と同じく親の行だけを生の SQL で消して作る)。
  // =====================================================================================

  describe("V23-M12-T02b D-V23-365: 対象の行が消えた付与の行は運営者だけが消せる", () => {
    const NO_TARGET_MESSAGE = "どの行に対する権限なのかが決まらないため、権限を渡せません。";

    /** 組織を置いてから、組織の行だけを生の SQL で消す(直す前から残っている付与の行の形)。 */
    function staleOrg(rig: Rig, owner: Name, member?: Name): string {
      const org = seedOrg(rig, "消えた組織", owner, member);
      withDb((db) => {
        db.query('DELETE FROM "orgs" WHERE "_id" = ?').run(org);
      });
      return org;
    }

    const grantOf = (org: string, permission: string): string => {
      const found = where("org_grants", "org", org).find((row) => row.permission === permission);
      if (found === undefined) {
        throw new Error(`組織 ${org} の ${permission} の付与が無い`);
      }
      return String(found._id);
    };

    async function patch(rig: Rig, who: Who, table: string, id: string, body: object) {
      const res = await rig.server.request(
        new Request(`http://localhost/api/apps/${PD_APP}/tables/${table}/records/${id}`, {
          method: "PATCH",
          headers: {
            origin: TEST_ORIGIN,
            cookie: who.cookie,
            "content-type": "application/json",
            "if-match": versionOf(table, id),
          },
          body: JSON.stringify(body),
        }),
      );
      return { status: res.status, text: await res.text() };
    }

    const toolText = (result: CallToolResult): string =>
      (result.content as { type: string; text?: string }[])
        .map((part) => part.text ?? "")
        .join("\n");

    test("P1 D-V23-365: 運営者は対象の行が消えた付与の行を HTTP の DELETE で消せる(204)。AI の口の delete_record でも消せる", async () => {
      const rig = await makeRig();
      const stale = staleOrg(rig, "padmin", "alice");
      const ownerGrant = grantOf(stale, "o_owner");
      const memberGrant = grantOf(stale, "o_member");

      const sent = await httpDelete(rig, rig.who.boss, "org_grants", ownerGrant);
      expect(sent.status, sent.text).toBe(204);
      expect(where("org_grants", "org", stale).map((row) => row._id)).toEqual([memberGrant]);

      const result = await mcpDelete(rig, rig.who.boss, "org_grants", memberGrant);
      expect(result.isError ?? false, toolText(result)).toBe(false);
      expect(where("org_grants", "org", stale)).toEqual([]);
    });

    test("P2 D-V23-365: 運営者が消した後、その行に居た人(1人1組織の一意に当たっていた人)はすぐ新しい組織を作れる", async () => {
      const rig = await makeRig();
      const stale = staleOrg(rig, "padmin");
      const before = await call(rig, "POST", "/tables/orgs/records", {
        who: rig.who.padmin,
        body: { title: "作り直す前" },
      });
      // 消す前は、対象の消えた付与の行が1人1組織の一意に当たって作れない(状態コードの値は縛らない)。
      expect(before.status, before.text).not.toBe(201);
      expect(count("orgs")).toBe(0);

      const removed = await httpDelete(rig, rig.who.boss, "org_grants", grantOf(stale, "o_owner"));
      expect(removed.status, removed.text).toBe(204);

      const created = await call(rig, "POST", "/tables/orgs/records", {
        who: rig.who.padmin,
        body: { title: "新しい組織" },
      });
      expect(created.status, created.text).toBe(201);
      expect(where("org_grants", "member", rig.memberRow.padmin)).toHaveLength(1);
    });

    test("N1 D-V23-365: 本人・メンバー・他の人の削除は今日どおり 400 で、文は今日の文(HTTP と AI の口)", async () => {
      const rig = await makeRig();
      const stale = staleOrg(rig, "padmin", "alice");
      const ownerGrant = grantOf(stale, "o_owner");
      const memberGrant = grantOf(stale, "o_member");
      for (const [who, id] of [
        [rig.who.padmin, ownerGrant],
        [rig.who.alice, memberGrant],
        [rig.who.alice, ownerGrant],
        [rig.who.carol, ownerGrant],
      ] as const) {
        const sent = await httpDelete(rig, who, "org_grants", id);
        expect(sent.status, `${who.username}: ${sent.text}`).toBe(400);
        expect(sent.text).toContain(NO_TARGET_MESSAGE);
      }
      const result = await mcpDelete(rig, rig.who.padmin, "org_grants", ownerGrant);
      expect(result.isError).toBe(true);
      expect(toolText(result)).toContain(NO_TARGET_MESSAGE);
      expect(where("org_grants", "org", stale)).toHaveLength(2);
    });

    test("N2 D-V23-365: 運営者でも、対象の行が無い付与の作成と更新は今日どおり 400", async () => {
      const rig = await makeRig();
      const stale = staleOrg(rig, "padmin");
      const ownerGrant = grantOf(stale, "o_owner");
      const created = await call(rig, "POST", "/tables/org_grants/records", {
        who: rig.who.boss,
        body: { org: stale, member: rig.memberRow.carol, permission: "o_member" },
      });
      expect(created.status, created.text).toBe(400);
      expect(created.text).toContain(NO_TARGET_MESSAGE);
      const updated = await patch(rig, rig.who.boss, "org_grants", ownerGrant, {
        permission: "o_member",
      });
      expect(updated.status, updated.text).toBe(400);
      expect(updated.text).toContain(NO_TARGET_MESSAGE);
      expect(where("org_grants", "org", stale).map((row) => row.permission)).toEqual(["o_owner"]);
    });

    test("N3 D-V23-365: 対象の行が在る付与の行の削除は今日どおり(作成者でない人は 403・最後の管理者は 409・運営者は 204)", async () => {
      const rig = await makeRig();
      const org = seedOrg(rig, "組織1", "padmin", "alice");
      const ownerGrant = grantOf(org, "o_owner");
      const memberGrant = grantOf(org, "o_member");
      const notCreator = await httpDelete(rig, rig.who.alice, "org_grants", ownerGrant);
      expect(notCreator.status, notCreator.text).toBe(403);
      const lastAdmin = await httpDelete(rig, rig.who.padmin, "org_grants", ownerGrant);
      expect(lastAdmin.status, lastAdmin.text).toBe(409);
      const byOperator = await httpDelete(rig, rig.who.boss, "org_grants", memberGrant);
      expect(byOperator.status, byOperator.text).toBe(204);
      expect(where("org_grants", "org", org).map((row) => row._id)).toEqual([ownerGrant]);
    });
  });

  // ===================================================================================
  // 【`V23-M12-T04`。`D-V23-357`・`D-V23-367`・`D-V23-401`・`D-V23-402`・`D-V23-410`】結んだ相手の名前を見せる範囲
  // (門A `ADR-0571` §Decision 1-4・`ADR-0573` §Decision 1 の4・5)。 置き場は `D-V23-414` の (1) のとおり既存のファイル。
  // ===================================================================================

  describe("V23-M12-T04 D-V23-357・D-V23-367: 変更履歴の招待の件の相手は、見せてよい人にだけ名前で出る", () => {
    type InviteChange = { invitee: string; permission: string };
    type HistoryItem = { op: string; changes: InviteChange[] | Record<string, unknown>[] };
    type Scene = { rig: Rig; org: string; agencyX: string; agencyY: string };

    const MEMO = "名前でない項目の値";
    const HIDDEN = "(表示できません)";

    function invitationOf(org: string, agency: string): string {
      const found = invitations().find(
        (row) => row.record_id === org && row.invitee_key === `row:agencies:${agency}`,
      );
      if (found === undefined) {
        throw new Error(`組織 ${org} への ${agency} の招待が無い`);
      }
      return String(found.id);
    }

    async function respond(rig: Rig, who: Who, id: string, action: string): Promise<void> {
      const sent = await call(rig, "POST", `/invitations/${id}`, { who, body: { action } });
      expect(sent.status, `${action}: ${sent.text}`).toBe(200);
    }

    /**
     * 組織A(オーナー alice・メンバー padmin)に、評価機関X(代表 lead・専門家 expert)と評価機関Y(代表 carol・
     * 専門家 newbie)をコードで招く。 X は招待→承諾、Y は招待→取消・招待→辞退・招待→承諾(4つの操作が全部履歴に入る)。
     */
    async function scene(variant: Variant = {}): Promise<Scene> {
      const rig = await makeRig({ grantHistory: true, ...variant });
      const org = seedOrg(rig, "組織A", "alice", "padmin");
      const memo = variant.agencyMemo ? { memo: MEMO } : {};
      const agencyX = put(rig, "agencies", { title: "評価機関X", ...memo });
      put(rig, "agency_grants", {
        agency: agencyX,
        member: rig.memberRow.lead,
        permission: "ag_lead",
      });
      put(rig, "agency_grants", {
        agency: agencyX,
        member: rig.memberRow.expert,
        permission: "ag_member",
      });
      const agencyY = put(rig, "agencies", { title: "評価機関Y", ...memo });
      put(rig, "agency_grants", {
        agency: agencyY,
        member: rig.memberRow.carol,
        permission: "ag_lead",
      });
      put(rig, "agency_grants", {
        agency: agencyY,
        member: rig.memberRow.newbie,
        permission: "ag_member",
      });
      const invite = async (agency: string, lead: Who) => {
        const code = await issueCode(rig, lead, "agencies", agency);
        await inviteByCode(rig, rig.who.alice, org, code);
        return invitationOf(org, agency);
      };
      await respond(rig, rig.who.lead, await invite(agencyX, rig.who.lead), "accept");
      await respond(rig, rig.who.alice, await invite(agencyY, rig.who.carol), "revoke");
      await respond(rig, rig.who.carol, await invite(agencyY, rig.who.carol), "decline");
      await respond(rig, rig.who.carol, await invite(agencyY, rig.who.carol), "accept");
      expect(where("org_grants", "org", org).map((row) => row.agency ?? null)).toEqual([
        null,
        null,
        agencyX,
        agencyY,
      ]);
      return { rig, org, agencyX, agencyY };
    }

    async function historyOf(
      s: Scene,
      who: Who,
    ): Promise<{ status: number; items: HistoryItem[] }> {
      const sent = await call(s.rig, "GET", `/tables/orgs/records/${s.org}?history=1`, { who });
      const history = sent.body.history as { items?: HistoryItem[] } | undefined;
      return { status: sent.status, items: history?.items ?? [] };
    }

    /** 招待の件だけを `操作:相手` の形で(新しい順)。 */
    async function invitees(s: Scene, who: Who): Promise<string[]> {
      const { status, items } = await historyOf(s, who);
      expect(status, who.username).toBe(200);
      return items
        .filter((item) => item.op.startsWith("invite"))
        .flatMap((item) =>
          (item.changes as InviteChange[]).map((change) => `${item.op}:${change.invitee}`),
        );
    }

    /** X と Y の見え方から、期待する並び(新しい順)を組む。 */
    const expected = (x: string, y: string): string[] => [
      `invite_accept:${y}`,
      `invite:${y}`,
      `invite_decline:${y}`,
      `invite:${y}`,
      `invite_revoke:${y}`,
      `invite:${y}`,
      `invite_accept:${x}`,
      `invite:${x}`,
    ];

    test("P1 P2 D-V23-357・D-V23-367・D-V23-410: 組織のオーナー・メンバーと運営者には、招待・承諾・辞退・取消の4つとも結んだ評価機関の名前", async () => {
      const s = await scene();
      for (const who of [s.rig.who.alice, s.rig.who.padmin, s.rig.who.boss]) {
        expect(await invitees(s, who), who.username).toEqual(expected("評価機関X", "評価機関Y"));
      }
    });

    test("P3 N1 D-V23-367: 評価機関の専門家には自分の評価機関の名前だけ。 読めない別の評価機関は今日どおり鍵(row:<表>:<ID>)", async () => {
      const s = await scene();
      const keyX = `row:agencies:${s.agencyX}`;
      const keyY = `row:agencies:${s.agencyY}`;
      expect(await invitees(s, s.rig.who.expert)).toEqual(expected("評価機関X", keyY));
      expect(await invitees(s, s.rig.who.newbie)).toEqual(expected(keyX, "評価機関Y"));
    });

    test("P4 N1 D-V23-401: 相手の行が消えた後、名前を見せてよい人には「(表示できません)」、それ以外の人には今日どおり鍵", async () => {
      const s = await scene();
      const removed = await httpDelete(s.rig, s.rig.who.boss, "agencies", s.agencyX);
      expect(removed.status, removed.text).toBe(204);
      for (const who of [s.rig.who.alice, s.rig.who.padmin, s.rig.who.boss]) {
        expect(await invitees(s, who), who.username).toEqual(expected(HIDDEN, "評価機関Y"));
      }
      expect(await invitees(s, s.rig.who.newbie)).toEqual(
        expected(`row:agencies:${s.agencyX}`, "評価機関Y"),
      );
    });

    test("P4 D-V23-401: 相手の行の代表項目が見る人の項目の規則で隠れるときも「(表示できません)」(隠れない運営者には名前)", async () => {
      const s = await scene({ hideAgencyTitle: true });
      const keyX = `row:agencies:${s.agencyX}`;
      const keyY = `row:agencies:${s.agencyY}`;
      expect(await invitees(s, s.rig.who.boss)).toEqual(expected("評価機関X", "評価機関Y"));
      for (const who of [s.rig.who.alice, s.rig.who.padmin]) {
        expect(await invitees(s, who), who.username).toEqual(expected(HIDDEN, HIDDEN));
      }
      expect(await invitees(s, s.rig.who.expert)).toEqual(expected(HIDDEN, keyY));
      expect(await invitees(s, s.rig.who.newbie)).toEqual(expected(keyX, HIDDEN));
    });

    test("N2 D-V23-357: 名前以外の相手の行の項目は、組織の単件・履歴・付与の一覧と単件の応答に1件も出ない(履歴の招待の件の鍵は invitee と permission の2つだけ)", async () => {
      const s = await scene({ agencyMemo: true });
      const grantIds = where("org_grants", "org", s.org).map((row) => String(row._id));
      for (const who of [
        s.rig.who.alice,
        s.rig.who.padmin,
        s.rig.who.expert,
        s.rig.who.newbie,
        s.rig.who.boss,
      ]) {
        const texts: string[] = [];
        const single = await call(s.rig, "GET", `/tables/orgs/records/${s.org}?history=1`, { who });
        expect(single.status, who.username).toBe(200);
        texts.push(single.text);
        const items = ((single.body.history as { items: HistoryItem[] }).items ?? []).filter(
          (item) => item.op.startsWith("invite"),
        );
        expect(items.length, who.username).toBe(8);
        for (const item of items) {
          for (const change of item.changes) {
            expect(Object.keys(change).sort(), who.username).toEqual(["invitee", "permission"]);
          }
        }
        const listed = await call(s.rig, "GET", `/tables/org_grants/records?filter.org=${s.org}`, {
          who,
        });
        texts.push(listed.text);
        for (const id of grantIds) {
          texts.push((await call(s.rig, "GET", `/tables/org_grants/records/${id}`, { who })).text);
        }
        const leaks = texts.reduce((n, text) => n + (text.split(MEMO).length - 1), 0);
        // 運営者は評価機関の行を読めるが、ここで撃った口は評価機関の行を返さないので0。
        expect(leaks, who.username).toBe(0);
      }
    });

    test("N3 D-V23-402: AI の口の list_record_history が返す相手は、名前を見せてよい人にも今日どおり鍵", async () => {
      const s = await scene();
      const server = createMcpServer({
        dataRoot: pdRoot,
        previewBaseUrl: "http://localhost:3000",
        actor: s.rig.who.alice.username,
      });
      const client = new Client({ name: "t04", version: "0.0.0" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([client.connect(a), server.connect(b)]);
      try {
        const result = (await client.callTool({
          name: "list_record_history",
          arguments: { app_id: PD_APP, table_id: "orgs", record_id: s.org },
        })) as CallToolResult;
        expect(result.isError === true, JSON.stringify(result.content)).toBe(false);
        const items = (result.structuredContent as { items: HistoryItem[] }).items.filter((item) =>
          item.op.startsWith("invite"),
        );
        const seen = items.flatMap((item) =>
          (item.changes as InviteChange[]).map((change) => `${item.op}:${change.invitee}`),
        );
        expect(seen).toEqual(expected(`row:agencies:${s.agencyX}`, `row:agencies:${s.agencyY}`));
        expect(JSON.stringify(result.content).includes("評価機関X")).toBe(false);
      } finally {
        await client.close();
        await server.close();
      }
    });
  });
});

// =====================================================================================
// 【`V23-M12-T03`。`D-V23-356`】権限の名前に替えるのは画面だけ。 HTTP と AI の口の応答は ID のまま
// (門A `ADR-0571` §Decision 1-3 の2。 サーバは1バイトも変えていない段の見張り。 直す前から緑)。
// 置き場は `D-V23-414` の (1) のとおり既存のファイル(新しいファイルは import のスナップショットを動かす)。
// =====================================================================================

describe("V23-M12-T03 D-V23-356 N2: HTTP の一覧・単件と AI の口の応答の権限の値は ID のまま", () => {
  test("N2 D-V23-356: 付与の表の一覧(HTTP)・単件(HTTP)・AI の口の list_records は、権限の値を ID(keeper・reader)で返し、宣言の名前(管理・閲覧)を返さない", async () => {
    await makeApp();
    const { aliceGrant } = seedNote();
    const listed = await send("GET", RECORDS("note_grant"), undefined, owner.cookie);
    expect(listed.status, await listed.clone().text()).toBe(200);
    const listedBody = (await listed.json()) as { records: Record<string, unknown>[] };
    expect(listedBody.records.map((row) => row.permission).sort()).toEqual(["keeper", "reader"]);
    const single = await send(
      "GET",
      `${RECORDS("note_grant")}/${aliceGrant}`,
      undefined,
      owner.cookie,
    );
    expect(single.status).toBe(200);
    expect(((await single.json()) as { record: Record<string, unknown> }).record.permission).toBe(
      "keeper",
    );
    const mcp = createMcpServer({
      dataRoot: dataRoot as string,
      previewBaseUrl: "http://localhost:3000",
      actor: "owner1",
    });
    const client = new Client({ name: "t03", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), mcp.connect(b)]);
    try {
      const result = (await client.callTool({
        name: "list_records",
        arguments: { app_id: APP_ID, table_id: "note_grant" },
      })) as CallToolResult;
      expect(result.isError === true, JSON.stringify(result.content)).toBe(false);
      const records = (result.structuredContent as { records: Record<string, unknown>[] }).records;
      expect(records.map((row) => row.permission).sort()).toEqual(["keeper", "reader"]);
      const text = JSON.stringify(result.content);
      expect(text.includes("keeper")).toBe(true);
      expect(records.some((row) => row.permission === "管理" || row.permission === "閲覧")).toBe(
        false,
      );
    } finally {
      await client.close();
      await mcp.close();
    }
  });
});
