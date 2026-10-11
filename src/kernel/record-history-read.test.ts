/**
 * **行の変更履歴を読む —— 閲覧権**(計画 §27-3 の T05 と §27-6 の重1・中5・中6。決定 `D-V23-202`・`D-V23-203`・
 * `D-V23-211`・`D-V23-212`・`D-V23-217`・`D-V23-219`・`D-V23-220`・`D-V23-222`・`D-V23-224`・`D-V23-226`・`D-V23-229`)。
 *
 * - HTTP: 単件 GET に `?history=1`(と `history_offset`)を付けたときだけ、全部の関門を通った後の、ログインした人の
 *   枝の応答に `history: {items, total, offset, limit}`(limit 50)が載る。 未ログイン・宣言の無い表・引数が無い要求の
 *   応答は1バイトも変わらない。
 * - MCP: `list_record_history`(名乗りが要る。宣言の無い表は断る)。 読める判定は単件 GET と同じ並び(母集団の壁を含む)。
 *   消した行は運営だけが読める(HTTP は 404)。
 * - 各題材を HTTP と MCP の両方で撃ち、答え(読める・読めない)が単件 GET の 200 / 404 と一致すること。
 * - 隠す項目は今の行に項目の規則を1回当てて決める(条件つきの規則は今の行で当たる)。 消した項目は落とす。
 *   項目を落として変更が空になった更新の行は出さない(`total` は絞った後の数)。
 * - 変えた人は更新者の欄と同じ名前(表示名、無ければログイン名。引けなければ「(不明なユーザ)」。空は空)。
 *
 * 置き場は `src/kernel`(`src/kernel` の外の検査がカーネルの値を import すると `kernel-import-drift` の写しに行が要る)。
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AuthStore } from "../auth/store.ts";
import { createMcpServer } from "../mcp/server.ts";
import { createServerApp } from "../server/app.ts";
import { TEST_ORIGIN } from "../server/test-helpers.ts";
import {
  appDbPath,
  applyDiff,
  applyManifest,
  createApp,
  createRecord,
  KernelMetaStore,
  type Manifest,
} from "./index.ts";

const APP_ID = "rh-read";
const ALL = ["read", "write", "delete"];
const UNRESOLVED = "(不明なユーザ)";

type Any = Record<string, unknown>;

const text = (id: string): Any => ({ id, name: id, type: "text" });
const ref = (id: string, table: string): Any => ({
  id,
  name: id,
  type: "reference",
  reference_table: table,
});
const sel = (id: string, options: string[]): Any => ({ id, name: id, type: "select", options });

const HISTORY_FIELDS = [
  { id: "ran_at", name: "実行時刻", type: "date" },
  { id: "workflow", name: "ワークフロー", type: "text" },
  { id: "trigger_type", name: "きっかけ", type: "text" },
  { id: "status", name: "結果", type: "text" },
  { id: "error", name: "エラー", type: "long_text" },
];

const CASE_PERMISSIONS = [
  { id: "c_admin", name: "管理", read: true, write: true, delete: true },
  { id: "c_reader", name: "閲覧", read: true, write: false, delete: false },
  { id: "c_blind", name: "見せない", read: false, write: false, delete: false, restrictive: true },
];

const ALL_TABLES = [
  "notes",
  "pub",
  "memo",
  "diaries",
  "members",
  "groups",
  "agencies",
  "agency_grants",
  "cases",
  "case_grants",
  "tasks",
  "task_grants",
  "case_notes",
  "wf_log",
];

type RigOptions = { grantHistory?: boolean; personalGrant?: boolean };

/**
 * `personalGrant`: 個人所有(`st_owner`)の表に `access_control` を重ねた表 `pdocs` とその付与の表を足す(`D-V23-243`)。
 * 他の題材の母集団を変えないため、その検査だけが足す。
 */
function manifest(options: RigOptions = {}): Manifest {
  const members = { table: "members", account: "account", group: "grp" };
  const tableRules = (tables: string[], can: string[]) =>
    tables.map((table) => ({ target: "table", table, can }));
  return {
    app: {
      id: APP_ID,
      name: "履歴を読む",
      tables: [
        {
          id: "notes",
          name: "メモ",
          history: true,
          fields: [
            text("title"),
            sel("status", ["open", "closed"]),
            sel("level", ["low", "high"]),
            text("secret"),
            text("memo"),
            text("extra"),
          ],
        },
        { id: "pub", name: "公開", history: true, fields: [text("name")] },
        { id: "memo", name: "覚え", history: true, fields: [text("body")] },
        {
          id: "diaries",
          name: "日記",
          history: true,
          fields: [text("title"), { id: "st_owner", name: "持ち主", type: "text" }],
        },
        {
          id: "members",
          name: "名簿",
          history: true,
          representative_field: "name",
          fields: [
            { id: "name", name: "名前", type: "text", required: true },
            { id: "account", name: "利用者ID", type: "text", required: true },
            ref("grp", "groups"),
          ],
        },
        { id: "groups", name: "グループ", fields: [text("title")] },
        {
          id: "agencies",
          name: "評価機関",
          representative_field: "title",
          fields: [text("title")],
          access_control: {
            enabled: true,
            permissions: [
              { id: "agency_member", name: "所属", read: true, write: false, delete: false },
            ],
            creator_permission: "agency_member",
            grant: {
              table: "agency_grants",
              target: "agency",
              member: "member",
              group: "group",
              permission: "permission",
            },
            members,
            groups: { table: "groups" },
          },
        },
        {
          id: "agency_grants",
          name: "評価機関の付与",
          fields: [
            ref("agency", "agencies"),
            ref("member", "members"),
            ref("group", "groups"),
            sel("permission", ["agency_member"]),
          ],
        },
        {
          id: "cases",
          name: "判定",
          history: true,
          representative_field: "title",
          fields: [text("title"), text("verdict")],
          access_control: {
            enabled: true,
            permissions: CASE_PERMISSIONS,
            creator_permission: "c_admin",
            grant: {
              table: "case_grants",
              target: "case",
              member: "member",
              permission: "permission",
              principal_row: { column: "agency", table: "agencies", via: ["agency_member"] },
            },
            members,
            groups: { table: "groups" },
            invitations: { grantable: ["c_reader"] },
          },
        },
        {
          id: "case_grants",
          name: "判定の付与",
          ...(options.grantHistory === true ? { history: true } : {}),
          fields: [
            ref("case", "cases"),
            ref("member", "members"),
            ref("agency", "agencies"),
            sel(
              "permission",
              CASE_PERMISSIONS.map((permission) => permission.id),
            ),
          ],
        },
        {
          id: "tasks",
          name: "作業",
          history: true,
          fields: [text("title"), ref("case", "cases")],
          access_control: {
            enabled: true,
            permissions: CASE_PERMISSIONS,
            creator_permission: "c_admin",
            grant: {
              table: "task_grants",
              target: "task",
              member: "member",
              permission: "permission",
            },
            members,
            groups: { table: "groups" },
            inherit_from: ["case"],
          },
        },
        {
          id: "task_grants",
          name: "作業の付与",
          fields: [
            ref("task", "tasks"),
            ref("member", "members"),
            sel(
              "permission",
              CASE_PERMISSIONS.map((permission) => permission.id),
            ),
          ],
        },
        {
          id: "case_notes",
          name: "判定の書き込み",
          // 自動処理の書き手は書き込んだ人(持ち主の項目)。 判定の表はアクセス権で守られているため。
          fields: [
            ref("case", "cases"),
            text("body"),
            { id: "st_owner", name: "持ち主", type: "text" },
          ],
        },
        { id: "wf_log", name: "自動処理の記録", fields: HISTORY_FIELDS },
        ...(options.personalGrant === true
          ? [
              {
                id: "pdocs",
                name: "個人の書類",
                history: true,
                fields: [text("title"), { id: "st_owner", name: "持ち主", type: "text" }],
                access_control: {
                  enabled: true,
                  permissions: [
                    { id: "p_reader", name: "閲覧", read: true, write: false, delete: false },
                    { id: "p_admin", name: "管理", read: true, write: true, delete: true },
                  ],
                  creator_permission: "p_admin",
                  grant: {
                    table: "pdoc_grants",
                    target: "pdoc",
                    member: "member",
                    permission: "permission",
                  },
                  members,
                  groups: { table: "groups" },
                },
              },
              {
                id: "pdoc_grants",
                name: "個人の書類の付与",
                fields: [
                  ref("pdoc", "pdocs"),
                  ref("member", "members"),
                  sel("permission", ["p_reader", "p_admin"]),
                ],
              },
            ]
          : []),
      ],
      views: [
        {
          id: "memo_detail",
          name: "覚えの詳細",
          type: "detail_view",
          table: "memo",
          fields: ["body"],
        },
      ],
      workflows: [
        {
          id: "wf_review",
          name: "書き込まれたら判定を見直し中にする",
          trigger: { type: "on_create", table: "case_notes" },
          history_table: "wf_log",
          actions: [
            {
              action: "update_record",
              table: "cases",
              target: "$record.case",
              values: { verdict: "見直し中" },
            },
          ],
        },
      ],
      workspace: { invitations: { label: "招待" } },
      roles: [
        {
          id: "owner",
          name: "運営",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            ...tableRules(ALL_TABLES, ALL),
            ...(options.personalGrant === true ? tableRules(["pdocs", "pdoc_grants"], ALL) : []),
            { target: "field", table: "notes", field: "secret", can: ["read", "write"] },
            { target: "field", table: "notes", field: "memo", can: ["read", "write"] },
            { target: "view", view: "memo_detail", can: ["read"] },
          ],
        },
        {
          id: "staff",
          name: "担当",
          rules: [
            ...tableRules(["notes", "pub", "memo", "case_notes", "wf_log"], ALL),
            {
              target: "table",
              table: "diaries",
              can: ALL,
              when: { field: "st_owner", equals_current_user: true },
            },
            { target: "field", table: "notes", field: "secret", can: ["read", "write"] },
            { target: "field", table: "notes", field: "memo", can: ["read", "write"] },
          ],
        },
        {
          id: "viewer",
          name: "閲覧者",
          rules: [
            {
              target: "table",
              table: "notes",
              can: ["read"],
              when: { field: "status", equals: "open" },
            },
            {
              target: "field",
              table: "notes",
              field: "memo",
              can: ["read"],
              when: { field: "level", equals: "low" },
            },
          ],
        },
        { id: "editor", name: "編集者" },
        { id: "outsider", name: "部外者" },
        {
          id: "member",
          name: "会員",
          rules: [
            ...tableRules(["case_notes", "wf_log", "case_grants"], ALL),
            ...tableRules(["members"], ["read"]),
          ],
        },
        {
          id: "anonymous",
          name: "未ログイン",
          rules: [{ target: "table", table: "pub", can: ["read"] }],
        },
      ],
    },
  } as unknown as Manifest;
}

type Who = { cookie: string; userId: string; username: string };

type Rig = {
  dataRoot: string;
  server: ReturnType<typeof createServerApp>;
  m: Manifest;
  who: Record<string, Who>;
  memberRow: Record<string, string>;
  ids: Record<string, string>;
};

const dataRoots: string[] = [];

afterEach(async () => {
  for (const dir of dataRoots.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function withDb<T>(rig: { dataRoot: string }, run: (db: Database) => T): T {
  const db = new Database(appDbPath(rig.dataRoot, APP_ID));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return run(db);
  } finally {
    db.close();
  }
}

const USERS: { username: string; role: string; displayName?: string }[] = [
  { username: "boss", role: "owner", displayName: "運営の人" },
  { username: "alice", role: "staff", displayName: "アリス" },
  { username: "bob", role: "staff" },
  { username: "vera", role: "viewer" },
  { username: "olga", role: "outsider" },
  { username: "orgm", role: "member", displayName: "組織の人" },
  { username: "exp1", role: "member", displayName: "専門家1" },
  { username: "exp2", role: "member", displayName: "専門家2" },
  { username: "blinded", role: "member" },
  { username: "stranger", role: "member" },
];

async function makeRig(options: RigOptions = {}): Promise<Rig> {
  const dataRoot = await mkdtemp(join(tmpdir(), "gp-rh-read-"));
  dataRoots.push(dataRoot);
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, "履歴を読む", { app_id: APP_ID });
  } finally {
    meta.close();
  }
  const m = manifest(options);
  const applied = applyManifest(dataRoot, APP_ID, m);
  if (!applied.valid) {
    throw new Error(JSON.stringify(applied.errors));
  }
  const who: Record<string, Who> = {};
  const store = AuthStore.openForApp(dataRoot, APP_ID);
  try {
    for (const user of USERS) {
      const created = store.createUser({
        username: user.username,
        role: user.role as never,
        ...(user.displayName === undefined ? {} : { displayName: user.displayName }),
      });
      const session = store.createSession(created.id, 3600);
      who[user.username] = {
        cookie: `st_session=${session.id}`,
        userId: created.id,
        username: user.username,
      };
    }
  } finally {
    store.close();
  }
  const memberRow: Record<string, string> = {};
  const ids: Record<string, string> = {};
  withDb({ dataRoot }, (db) => {
    const put = (table: string, values: Any): string => {
      const created = createRecord(db, m, table, values);
      if (!created.ok) {
        throw new Error(`${table} に行を置けない: ${JSON.stringify(created.errors)}`);
      }
      return created.value._id;
    };
    for (const name of ["orgm", "exp1", "exp2", "blinded", "stranger"]) {
      memberRow[name] = put("members", { name, account: who[name]?.userId });
    }
    ids.a1 = put("agencies", { title: "評価機関1" });
    ids.a2 = put("agencies", { title: "評価機関2" });
    put("agency_grants", { agency: ids.a1, member: memberRow.exp1, permission: "agency_member" });
    put("agency_grants", { agency: ids.a2, member: memberRow.exp2, permission: "agency_member" });
    ids.c1 = put("cases", { title: "判定1", verdict: "未判定" });
    put("case_grants", { case: ids.c1, member: memberRow.orgm, permission: "c_admin" });
    put("case_grants", { case: ids.c1, agency: ids.a1, permission: "c_reader" });
    put("case_grants", { case: ids.c1, member: memberRow.blinded, permission: "c_reader" });
    put("case_grants", { case: ids.c1, member: memberRow.blinded, permission: "c_blind" });
    ids.t1 = put("tasks", { title: "作業1", case: ids.c1 });
  });
  return { dataRoot, server: createServerApp({ dataRoot }), m, who, memberRow, ids };
}

type Sent = { status: number; body: Any; text: string };

async function send(
  rig: Rig,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  who: Who | null,
  body?: unknown,
  extra: Record<string, string> = {},
): Promise<Sent> {
  const headers: Record<string, string> = { ...extra };
  if (who !== null) {
    headers.cookie = who.cookie;
  }
  if (method !== "GET") {
    headers.origin = TEST_ORIGIN;
    headers["content-type"] = "application/json";
  }
  const res = await rig.server.request(
    new Request(`http://localhost/api/apps/${APP_ID}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const raw = await res.text();
  let parsed: Any;
  try {
    parsed = JSON.parse(raw) as Any;
  } catch {
    parsed = { raw };
  }
  return { status: res.status, body: parsed, text: raw };
}

async function mcp(rig: Rig, actor: string, name: string, args: Any): Promise<CallToolResult> {
  const server = createMcpServer({
    dataRoot: rig.dataRoot,
    previewBaseUrl: "http://localhost:3000",
    actor,
  });
  const client = new Client({ name: "rh-read", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  try {
    return JSON.parse(
      JSON.stringify(await client.callTool({ name, arguments: { app_id: APP_ID, ...args } })),
    ) as CallToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

type Page = { items: Item[]; total: number; offset: number; limit: number };
type Item = { seq: number; op: string; actor: string; entry: string; at: string; changes: Any[] };

function mcpText(result: CallToolResult): string {
  const first = (result.content as { type: string; text?: string }[] | undefined)?.[0];
  return first?.text ?? "";
}

async function mcpHistory(
  rig: Rig,
  actor: string,
  table: string,
  id: string,
  extra: Any = {},
): Promise<{ ok: boolean; page?: Page; text: string }> {
  const result = await mcp(rig, actor, "list_record_history", {
    table_id: table,
    record_id: id,
    ...extra,
  });
  const raw = mcpText(result);
  if (result.isError === true) {
    return { ok: false, text: raw };
  }
  return { ok: true, page: JSON.parse(raw) as Page, text: raw };
}

const single = (rig: Rig, who: Who | null, table: string, id: string, query = "") =>
  send(rig, "GET", `/tables/${table}/records/${id}${query}`, who);

/**
 * **HTTP と MCP の答えが単件 GET の答えと一致することを見る**(計画 §27-6 中5)。
 * 単件 GET が 200 なら、`?history=1` の応答は `record` が同じで `history` が載り、MCP も読める(中身が同じ)。
 * 単件 GET が 404 なら、`?history=1` も 404(本文も同じ)で、MCP は断る。
 */
async function agree(
  rig: Rig,
  name: string,
  table: string,
  id: string,
): Promise<{ status: number; page?: Page }> {
  const who = rig.who[name] as Who;
  const plain = await single(rig, who, table, id);
  const withHistory = await single(rig, who, table, id, "?history=1");
  const viaMcp = await mcpHistory(rig, name, table, id);
  expect(withHistory.status, `${name} ${table}`).toBe(plain.status);
  if (plain.status === 200) {
    expect(withHistory.body.record, `${name} ${table}`).toEqual(plain.body.record);
    const page = withHistory.body.history as Page | undefined;
    expect(page, `${name} ${table} の HTTP に履歴が無い`).toBeDefined();
    expect(viaMcp.ok, `${name} ${table} の MCP が断った: ${viaMcp.text}`).toBe(true);
    expect(viaMcp.page, `${name} ${table}`).toEqual(page);
    return { status: 200, ...(page === undefined ? {} : { page }) };
  }
  expect(withHistory.text, `${name} ${table}`).toBe(plain.text);
  expect(viaMcp.ok, `${name} ${table} の MCP が読めてしまった: ${viaMcp.text}`).toBe(false);
  return { status: plain.status };
}

function versionOf(rig: Rig, table: string, id: string): string {
  return String(
    withDb(rig, (db) =>
      db
        .query<{ v: string }, [string]>(`SELECT _updated_at AS v FROM "${table}" WHERE _id = ?`)
        .get(id),
    )?.v,
  );
}

async function patch(rig: Rig, name: string, table: string, id: string, values: Any) {
  const sent = await send(
    rig,
    "PATCH",
    `/tables/${table}/records/${id}`,
    rig.who[name] as Who,
    values,
    {
      "if-match": versionOf(rig, table, id),
    },
  );
  expect(sent.status, sent.text).toBe(200);
  return sent;
}

async function post(rig: Rig, name: string, table: string, values: Any): Promise<string> {
  const sent = await send(rig, "POST", `/tables/${table}/records`, rig.who[name] as Who, values);
  expect(sent.status, sent.text).toBe(201);
  return String((sent.body.record as Any)._id);
}

const fieldsOf = (item: Item): string[] => item.changes.map((change) => String(change.field));

// =====================================================================================

describe("(P) 載る・載らない(宣言・引数・未ログイン)", () => {
  test("(P-1) 引数の無い要求の応答は変わらない。?history=1 で history が {items, total, offset, limit} で載る", async () => {
    const rig = await makeRig();
    const id = await post(rig, "alice", "notes", { title: "一", status: "open", level: "low" });
    const plain = await single(rig, rig.who.alice as Who, "notes", id);
    expect(plain.status).toBe(200);
    expect(Object.hasOwn(plain.body, "history")).toBe(false);
    const withHistory = await single(rig, rig.who.alice as Who, "notes", id, "?history=1");
    expect(withHistory.status).toBe(200);
    const page = withHistory.body.history as Page;
    expect(Object.keys(page).sort()).toEqual(["items", "limit", "offset", "total"]);
    expect(page.total).toBe(1);
    expect(page.offset).toBe(0);
    expect(page.limit).toBe(50);
    expect(page.items[0]?.op).toBe("create");
    expect(page.items[0]?.entry).toBe("http");
    expect(page.items[0]?.actor).toBe("アリス");
    // 応答の他の鍵は引数の無い要求と同じ。
    const { history: _dropped, ...rest } = withHistory.body;
    expect(rest).toEqual(plain.body);
  });

  test("(P-2) 宣言の無い表では ?history=1 を付けても応答が1バイトも変わらず、MCP は断る", async () => {
    const rig = await makeRig();
    const id = withDb(rig, (db) => {
      const created = createRecord(db, rig.m, "groups", { title: "宣言の無い表" });
      if (!created.ok) {
        throw new Error(JSON.stringify(created.errors));
      }
      return created.value._id;
    });
    const plain = await single(rig, rig.who.boss as Who, "groups", id);
    const withHistory = await single(rig, rig.who.boss as Who, "groups", id, "?history=1");
    expect(plain.status).toBe(200);
    expect(withHistory.text).toBe(plain.text);
    const viaMcp = await mcpHistory(rig, "boss", "groups", id);
    expect(viaMcp.ok).toBe(false);
    expect(viaMcp.text).toContain("groups");
  });

  test("(P-3) 未ログインで全行が読める表: 未ログインには ?history=1 でも載らず(応答は同じ)、ログインした人には載る", async () => {
    const rig = await makeRig();
    const id = await post(rig, "alice", "pub", { name: "公開の行" });
    const anonPlain = await single(rig, null, "pub", id);
    const anonHistory = await single(rig, null, "pub", id, "?history=1");
    expect(anonPlain.status).toBe(200);
    expect(anonHistory.status).toBe(200);
    expect(anonHistory.text).toBe(anonPlain.text);
    const shown = await agree(rig, "alice", "pub", id);
    expect(shown.status).toBe(200);
    expect(shown.page?.total).toBe(1);
  });

  test("(P-4) MCP は名乗りが要る(名乗りの無い道具は断る)", async () => {
    const rig = await makeRig();
    const id = await post(rig, "alice", "notes", { title: "一", status: "open", level: "low" });
    const server = createMcpServer({
      dataRoot: rig.dataRoot,
      previewBaseUrl: "http://localhost:3000",
    });
    const client = new Client({ name: "rh-read", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    try {
      const result = (await client.callTool({
        name: "list_record_history",
        arguments: { app_id: APP_ID, table_id: "notes", record_id: id },
      })) as CallToolResult;
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("(P-5) 表の history を外すと読めなくなり、戻すと前の履歴がまた読める", async () => {
    const rig = await makeRig();
    const id = await post(rig, "alice", "pub", { name: "一" });
    const off = applyDiff(rig.dataRoot, APP_ID, {
      diff_id: "rh-read-off",
      intent: "履歴をやめる",
      operations: [{ op: "change_table", table: "pub", changes: { history: false } }],
    });
    expect((off as { valid?: boolean }).valid, JSON.stringify(off)).toBe(true);
    const plain = await single(rig, rig.who.alice as Who, "pub", id);
    const withHistory = await single(rig, rig.who.alice as Who, "pub", id, "?history=1");
    expect(withHistory.text).toBe(plain.text);
    expect((await mcpHistory(rig, "alice", "pub", id)).ok).toBe(false);
    const on = applyDiff(rig.dataRoot, APP_ID, {
      diff_id: "rh-read-on",
      intent: "履歴を戻す",
      operations: [{ op: "change_table", table: "pub", changes: { history: true } }],
    });
    expect((on as { valid?: boolean }).valid, JSON.stringify(on)).toBe(true);
    const back = await agree(rig, "alice", "pub", id);
    expect(back.page?.items.map((item) => item.op)).toEqual(["create"]);
  });
});

describe("(W) 読める人だけ(HTTP と MCP の答えが単件 GET と一致する)", () => {
  test("(W-1) 役割の規則: 表を読める役割には出て、規則の無い役割には出ない", async () => {
    const rig = await makeRig();
    const id = await post(rig, "alice", "notes", { title: "一", status: "open", level: "low" });
    expect((await agree(rig, "bob", "notes", id)).status).toBe(200);
    expect((await agree(rig, "olga", "notes", id)).status).toBe(404);
  });

  test("(W-2) 行の条件つきの面: 条件に合う行だけ出る(今の行で当たる)", async () => {
    const rig = await makeRig();
    const id = await post(rig, "alice", "notes", { title: "一", status: "open", level: "low" });
    expect((await agree(rig, "vera", "notes", id)).status).toBe(200);
    await patch(rig, "alice", "notes", id, { status: "closed" });
    expect((await agree(rig, "vera", "notes", id)).status).toBe(404);
  });

  test("(W-3) 行ごとの付与・行を相手にした付与・上限・引き継ぎ", async () => {
    const rig = await makeRig();
    // 直の付与(管理)。
    expect((await agree(rig, "orgm", "cases", rig.ids.c1 as string)).status).toBe(200);
    // 行を相手にした付与(評価機関1 の所属 → 判定1 の閲覧)。
    expect((await agree(rig, "exp1", "cases", rig.ids.c1 as string)).status).toBe(200);
    // 関連の無い評価機関の所属・付与の無い会員。
    expect((await agree(rig, "exp2", "cases", rig.ids.c1 as string)).status).toBe(404);
    expect((await agree(rig, "stranger", "cases", rig.ids.c1 as string)).status).toBe(404);
    // 上限(閲覧の付与と、見せない符号の付与を両方持つ人)。
    const blinded = await agree(rig, "blinded", "cases", rig.ids.c1 as string);
    expect(blinded.status).toBe(404);
    // 引き継ぎ(親の判定の付与で子の作業が読める)。
    expect((await agree(rig, "orgm", "tasks", rig.ids.t1 as string)).status).toBe(200);
    expect((await agree(rig, "exp2", "tasks", rig.ids.t1 as string)).status).toBe(404);
  });

  test("(W-4) 個人所有の他人の行: 持ち主と運営には出て、他人には出ない", async () => {
    const rig = await makeRig();
    const id = await post(rig, "alice", "diaries", {
      title: "日記",
      st_owner: rig.who.alice?.userId,
    });
    expect((await agree(rig, "alice", "diaries", id)).status).toBe(200);
    expect((await agree(rig, "bob", "diaries", id)).status).toBe(404);
    expect((await agree(rig, "boss", "diaries", id)).status).toBe(200);
  });

  test("(W-5) 登録簿の壁: 名簿の行は、母集団の判定で落ちる人には出ない", async () => {
    const rig = await makeRig();
    const row = rig.memberRow.orgm as string;
    expect((await agree(rig, "boss", "members", row)).status).toBe(200);
    const results = [];
    for (const name of ["orgm", "exp1", "exp2", "stranger"]) {
      results.push((await agree(rig, name, "members", row)).status);
    }
    // 会員は名簿の表を面で読めるが、母集団の判定で自分の行だけになる(運営は全部読める)。
    expect(results).toEqual([200, 404, 404, 404]);
  });

  test("(W-6) 名乗らない読取の壁: 単票系の画面を1本も読めない人には出ない", async () => {
    const rig = await makeRig();
    const id = await post(rig, "boss", "memo", { body: "覚え" });
    expect((await agree(rig, "boss", "memo", id)).status).toBe(200);
    expect((await agree(rig, "alice", "memo", id)).status).toBe(404);
  });

  test("(W-7) 消した行は運営だけが MCP で読め、HTTP は運営にも 404", async () => {
    const rig = await makeRig();
    const id = await post(rig, "alice", "notes", { title: "消す", status: "open", level: "low" });
    const deleted = await send(
      rig,
      "DELETE",
      `/tables/notes/records/${id}`,
      rig.who.alice as Who,
      undefined,
      {
        "if-match": versionOf(rig, "notes", id),
      },
    );
    expect(deleted.status, deleted.text).toBe(204);
    for (const name of ["boss", "alice"]) {
      const withHistory = await single(rig, rig.who[name] as Who, "notes", id, "?history=1");
      expect(withHistory.status).toBe(404);
    }
    const byOwner = await mcpHistory(rig, "boss", "notes", id);
    expect(byOwner.ok, byOwner.text).toBe(true);
    expect(byOwner.page?.items.map((item) => item.op)).toEqual(["delete", "create"]);
    expect(byOwner.page?.items[0]?.actor).toBe("アリス");
    const byStaff = await mcpHistory(rig, "alice", "notes", id);
    expect(byStaff.ok).toBe(false);
  });
});

describe("D-V23-243: MCP の個人スコープの枝だけが断る題材", () => {
  test("D-V23-243: 個人所有と付与を併せ持つ表で、付与だけを持つ他人には HTTP も MCP も出ず、持ち主(付与あり)と運営には出る", async () => {
    // 付与で守られる表では先の面の検査が飛ばされるので、付与だけを持つ他人を MCP で断るのは
    // list_record_history の個人スコープの枝だけになる(枝を外すと MCP だけが読める)。
    const rig = await makeRig({ personalGrant: true });
    const id = withDb(rig, (db) => {
      const put = (table: string, values: Any): string => {
        const created = createRecord(db, rig.m, table, values);
        if (!created.ok) {
          throw new Error(`${table} に行を置けない: ${JSON.stringify(created.errors)}`);
        }
        return created.value._id;
      };
      const pdoc = put("pdocs", { title: "組織の人の書類", st_owner: rig.who.orgm?.userId });
      put("pdoc_grants", { pdoc, member: rig.memberRow.orgm, permission: "p_admin" });
      put("pdoc_grants", { pdoc, member: rig.memberRow.exp1, permission: "p_reader" });
      return pdoc;
    });
    // 陽性対照: 持ち主で付与のある人と運営は読める(HTTP と MCP の中身が一致)。
    expect((await agree(rig, "orgm", "pdocs", id)).status).toBe(200);
    expect((await agree(rig, "boss", "pdocs", id)).status).toBe(200);
    // 付与だけを持つ他人(持ち主でない): 単件 GET は 404 で、MCP も断る。
    expect((await agree(rig, "exp1", "pdocs", id)).status).toBe(404);
    // 付与の無い会員も読めない。
    expect((await agree(rig, "exp2", "pdocs", id)).status).toBe(404);
  });
});

describe("(F) 項目の落とし方", () => {
  test("(F-1) 読めない項目は変更前と変更後の両方が落ちる。読めない項目だけの更新は1件も出ない(total も数えない)", async () => {
    const rig = await makeRig();
    const id = await post(rig, "alice", "notes", {
      title: "一",
      status: "open",
      level: "low",
      secret: "秘密1",
    });
    await patch(rig, "alice", "notes", id, { secret: "秘密2" });
    await patch(rig, "alice", "notes", id, { title: "二", secret: "秘密3" });
    const forStaff = await agree(rig, "bob", "notes", id);
    expect(forStaff.page?.total).toBe(3);
    const forViewer = await agree(rig, "vera", "notes", id);
    expect(forViewer.page?.total).toBe(2);
    const items = forViewer.page?.items ?? [];
    expect(items.map((item) => item.op)).toEqual(["update", "create"]);
    for (const item of items) {
      expect(fieldsOf(item)).not.toContain("secret");
    }
    expect(fieldsOf(items[0] as Item)).toEqual(["title"]);
  });

  test("(F-2) 条件つきの項目の規則は今の行で当たる(過去の値も今の状態で隠れる)", async () => {
    const rig = await makeRig();
    const id = await post(rig, "alice", "notes", {
      title: "一",
      status: "open",
      level: "low",
      memo: "見える頃",
    });
    const before = await agree(rig, "vera", "notes", id);
    expect(fieldsOf(before.page?.items[0] as Item)).toContain("memo");
    await patch(rig, "alice", "notes", id, { level: "high" });
    const after = await agree(rig, "vera", "notes", id);
    for (const item of after.page?.items ?? []) {
      expect(fieldsOf(item)).not.toContain("memo");
    }
    // 運営には落ちない(陽性対照)。
    const forOwner = await agree(rig, "boss", "notes", id);
    expect(fieldsOf(forOwner.page?.items.at(-1) as Item)).toContain("memo");
  });

  test("(F-3) 消した項目は落ちる(その項目だけの更新は出ない)", async () => {
    const rig = await makeRig();
    const id = await post(rig, "alice", "notes", {
      title: "一",
      status: "open",
      level: "low",
      extra: "a",
    });
    await patch(rig, "alice", "notes", id, { extra: "b" });
    expect((await agree(rig, "bob", "notes", id)).page?.total).toBe(2);
    const removed = applyDiff(rig.dataRoot, APP_ID, {
      diff_id: "rh-read-rm",
      intent: "項目を消す",
      operations: [{ op: "remove_field", table: "notes", field: "extra" }],
    });
    expect((removed as { valid?: boolean }).valid, JSON.stringify(removed)).toBe(true);
    const page = (await agree(rig, "bob", "notes", id)).page;
    expect(page?.total).toBe(1);
    expect(fieldsOf(page?.items[0] as Item)).not.toContain("extra");
  });
});

describe("(N) 変えた人の名前", () => {
  test("(N-1) 表示名、無ければログイン名。退会した人は「(不明なユーザ)」。操作者の無い書込は空。MCP も同じ", async () => {
    const rig = await makeRig();
    const id = await post(rig, "alice", "notes", { title: "一", status: "open", level: "low" });
    await patch(rig, "bob", "notes", id, { title: "二" });
    const page = (await agree(rig, "boss", "notes", id)).page as Page;
    expect(page.items.map((item) => item.actor)).toEqual(["bob", "アリス"]);
    const store = AuthStore.openForApp(rig.dataRoot, APP_ID);
    try {
      store.deleteUser(rig.who.bob?.userId as string);
    } finally {
      store.close();
    }
    const afterLeave = (await agree(rig, "boss", "notes", id)).page as Page;
    expect(afterLeave.items.map((item) => item.actor)).toEqual([UNRESOLVED, "アリス"]);
    expect(JSON.stringify(afterLeave)).not.toContain(rig.who.bob?.userId as string);
    // 操作者の無い書込(カーネルを直に呼んだ書込)は空。
    const kernelId = withDb(rig, (db) => {
      const created = createRecord(db, rig.m, "notes", { title: "直", status: "open" });
      if (!created.ok) {
        throw new Error(JSON.stringify(created.errors));
      }
      return created.value._id;
    });
    const kernelPage = (await agree(rig, "boss", "notes", kernelId)).page as Page;
    expect(kernelPage.items[0]?.actor).toBe("");
  });

  test("(N-2) 個人所有の表の st_owner の値は詳細画面と同じく名前に差し替わる(生の利用者 ID を出さない)", async () => {
    const rig = await makeRig();
    const id = await post(rig, "alice", "diaries", {
      title: "日記",
      st_owner: rig.who.alice?.userId,
    });
    const page = (await agree(rig, "boss", "diaries", id)).page as Page;
    const owner = page.items[0]?.changes.find((change) => change.field === "st_owner");
    expect(owner?.after).toBe("アリス");
    expect(JSON.stringify(page)).not.toContain(rig.who.alice?.userId as string);
  });

  test("(N-3) 招待の記録の招かれた人も名前に差し替わる", async () => {
    const rig = await makeRig();
    const sent = await send(
      rig,
      "POST",
      `/tables/cases/records/${rig.ids.c1}/invitations`,
      rig.who.orgm as Who,
      { login: "stranger", permission: "c_reader" },
    );
    expect(sent.status, sent.text).toBe(202);
    const page = (await agree(rig, "orgm", "cases", rig.ids.c1 as string)).page as Page;
    const invite = page.items.find((item) => item.op === "invite");
    expect(invite?.changes).toEqual([{ invitee: "stranger", permission: "c_reader" }]);
    expect(invite?.actor).toBe("組織の人");
    expect(JSON.stringify(page)).not.toContain(rig.who.stranger?.userId as string);
  });
});

describe("(A) 受け入れ基準", () => {
  test("(A-1) 組織のメンバーが判定を変えると、関連付けた評価機関の専門家が変更者・時刻・変更前後を読め、関連の無い専門家には見えない", async () => {
    const rig = await makeRig();
    await patch(rig, "orgm", "cases", rig.ids.c1 as string, { verdict: "適合" });
    const forExpert = await agree(rig, "exp1", "cases", rig.ids.c1 as string);
    expect(forExpert.status).toBe(200);
    const latest = forExpert.page?.items[0] as Item;
    expect(latest.op).toBe("update");
    expect(latest.actor).toBe("組織の人");
    expect(latest.entry).toBe("http");
    expect(typeof latest.at).toBe("string");
    expect(latest.changes).toEqual([{ field: "verdict", before: "未判定", after: "適合" }]);
    expect((await agree(rig, "exp2", "cases", rig.ids.c1 as string)).status).toBe(404);
  });

  test("(A-2) ワークフローが更新した行は、入口「自動処理」・操作者「起点の利用者」で読める", async () => {
    const rig = await makeRig();
    await post(rig, "orgm", "case_notes", { case: rig.ids.c1, body: "見直して" });
    const page = (await agree(rig, "exp1", "cases", rig.ids.c1 as string)).page as Page;
    const latest = page.items[0] as Item;
    expect(latest.op).toBe("update");
    expect(latest.entry).toBe("on_create/on_update");
    expect(latest.actor).toBe("組織の人");
    expect(latest.changes).toEqual([{ field: "verdict", before: "未判定", after: "見直し中" }]);
  });
});

describe("(G) ページ送り", () => {
  test("(G-1) 新しい順に50件ずつ。history_offset で続き。MCP は offset と limit(上限200)", async () => {
    const rig = await makeRig();
    const id = await post(rig, "alice", "notes", { title: "t0", status: "open", level: "low" });
    for (let index = 1; index <= 54; index += 1) {
      await patch(rig, "alice", "notes", id, { title: `t${index}` });
    }
    const first = (await agree(rig, "bob", "notes", id)).page as Page;
    expect(first.total).toBe(55);
    expect(first.items).toHaveLength(50);
    expect(first.items[0]?.changes[0]?.after).toBe("t54");
    const seqs = first.items.map((item) => item.seq);
    expect([...seqs].sort((x, y) => y - x)).toEqual(seqs);
    const next = await single(rig, rig.who.bob as Who, "notes", id, "?history=1&history_offset=50");
    const nextPage = next.body.history as Page;
    expect(nextPage.offset).toBe(50);
    expect(nextPage.items).toHaveLength(5);
    expect(nextPage.items.at(-1)?.op).toBe("create");
    const viaMcp = await mcpHistory(rig, "bob", "notes", id, { offset: 50, limit: 3 });
    expect(viaMcp.page?.items.map((item) => item.seq)).toEqual(
      nextPage.items.slice(0, 3).map((item) => item.seq),
    );
    expect(viaMcp.page?.limit).toBe(3);
    const tooMany = await mcpHistory(rig, "bob", "notes", id, { limit: 201 });
    expect(tooMany.ok).toBe(false);
    const max = await mcpHistory(rig, "bob", "notes", id, { limit: 200 });
    expect(max.page?.items).toHaveLength(55);
  });
});

describe("(I) 行の招待の承諾で作られる付与の行", () => {
  test("(I-1) 付与表が history を宣言していれば、承諾で作られた付与の行も付与表の行の履歴に入る", async () => {
    const rig = await makeRig({ grantHistory: true });
    const sent = await send(
      rig,
      "POST",
      `/tables/cases/records/${rig.ids.c1}/invitations`,
      rig.who.orgm as Who,
      { login: "stranger", permission: "c_reader" },
    );
    expect(sent.status, sent.text).toBe(202);
    const invitationId = withDb(rig, (db) =>
      db.query<{ id: string }, []>("SELECT id FROM _row_invitations").get(),
    )?.id as string;
    const accepted = await send(
      rig,
      "POST",
      `/invitations/${invitationId}`,
      rig.who.stranger as Who,
      {
        action: "accept",
      },
    );
    expect(accepted.status, accepted.text).toBe(200);
    const grantRow = withDb(rig, (db) =>
      db
        .query<{ id: string }, [string]>(
          "SELECT _id AS id FROM case_grants WHERE member = ? ORDER BY rowid DESC",
        )
        .get(rig.memberRow.stranger as string),
    )?.id as string;
    expect(grantRow).toBeDefined();
    const rows = withDb(rig, (db) =>
      db
        .query<{ op: string; entry: string; actor_id: string }, [string]>(
          "SELECT op, entry, actor_id FROM _record_history WHERE table_id = 'case_grants' AND record_id = ?",
        )
        .all(grantRow),
    );
    expect(rows).toEqual([
      { op: "create", entry: "http", actor_id: rig.who.stranger?.userId as string },
    ]);
    // 運営は MCP でその付与の行の履歴を読める。
    const byOwner = await mcpHistory(rig, "boss", "case_grants", grantRow);
    expect(byOwner.ok, byOwner.text).toBe(true);
    expect(byOwner.page?.items.map((item) => item.op)).toEqual(["create"]);
  });
});

// =====================================================================================
// (R) ID の付け替え(`V23-M8-T13` の独立点検の中1。決定 `D-V23-232`)
//
// 点検の撃ち方: 履歴を取っている表で項目の ID を変えると、その項目の更新の行が丸ごと消え、作成からも落ちる。
// 表の ID を変えると、新しい ID では履歴が0件になる(内部表の行は前の ID のまま)。 今日は付け替え自体を断るので、
// 同じ撃ち方をしても前の履歴は HTTP でも MCP でもそのまま読める。
// =====================================================================================

describe("(R) 履歴を取っている表の ID の付け替えは断られ、前の履歴が読めたまま", () => {
  test("(R-1) 項目の付け替え・表の付け替えは断られ、HTTP と MCP の履歴は付け替えを撃つ前と同じ", async () => {
    const rig = await makeRig();
    const id = await post(rig, "alice", "notes", { title: "a", status: "open", level: "low" });
    await patch(rig, "alice", "notes", id, { title: "b" });
    const before = await agree(rig, "alice", "notes", id);
    expect(before.page?.items.map((item) => item.op)).toEqual(["update", "create"]);
    expect(before.page?.items.map(fieldsOf)[0]).toEqual(["title"]);

    const field = applyDiff(rig.dataRoot, APP_ID, {
      diff_id: "rh-read-rename-field",
      intent: "題の ID を変える",
      operations: [
        { op: "change_field", table: "notes", field: "title", changes: { id: "headline" } },
      ],
    });
    expect((field as { valid?: boolean }).valid).toBe(false);
    expect(JSON.stringify(field)).toContain("先に表の history を外して");
    const table = applyDiff(rig.dataRoot, APP_ID, {
      diff_id: "rh-read-rename-table",
      intent: "表の ID を変える",
      operations: [{ op: "change_table", table: "notes", changes: { id: "memos" } }],
    });
    expect((table as { valid?: boolean }).valid).toBe(false);
    expect(JSON.stringify(table)).toContain("先に表の history を外して");

    const after = await agree(rig, "alice", "notes", id);
    expect(after.page).toEqual(before.page as Page);
    expect(after.page?.total).toBe(2);
    expect((await single(rig, rig.who.alice as Who, "memos", id, "?history=1")).status).toBe(404);
    const tableIds = withDb(rig, (db) =>
      db
        .query<{ table_id: string }, [string]>(
          "SELECT DISTINCT table_id FROM _record_history WHERE record_id = ? ORDER BY table_id",
        )
        .all(id),
    ).map((row) => row.table_id);
    expect(tableIds).toEqual(["notes"]);
  });
});

// =====================================================================================
// (L) 引き継ぎの上限(`V23-M8-T13` の独立点検の軽1。決定 `D-V23-233`)
//
// 引き継ぎを7段たどる鎖で、根(段0)の行を読むと上限(段数5)に当たる。 単件 GET は ?history=1 の有無を問わず
// 400 と上限の文で断り、MCP の list_record_history も同じ上限の文で断る(無い行と同じ文にしない)。
// 段1 の行は上限に当たらないので、HTTP も MCP も読める(陰性対照。拒否側だけを測ると全部断っても緑になる)。
// =====================================================================================

const LIMIT_APP = "rh-limit";
const LIMIT_CHAIN = 7;
const LIMIT_SENTENCE = "引き継ぎの上限を超えているため判定できません";

function limitManifest(): Manifest {
  const permissions = [{ id: "keeper", name: "管理", read: true, write: true, delete: true }];
  const tables: Any[] = [];
  for (let level = 0; level < LIMIT_CHAIN; level += 1) {
    tables.push({
      id: `lvl${level}`,
      name: `段${level}`,
      history: true,
      fields: [
        text("title"),
        ...(level < LIMIT_CHAIN - 1 ? [ref("parent", `lvl${level + 1}`)] : []),
      ],
      access_control: {
        enabled: true,
        permissions,
        creator_permission: "keeper",
        grant: {
          table: "dep_grant",
          target: `t${level}`,
          member: "member",
          permission: "permission",
        },
        members: { table: "dep_member", account: "account" },
        ...(level < LIMIT_CHAIN - 1 ? { inherit_from: ["parent"] } : {}),
      },
    });
  }
  return {
    app: {
      id: LIMIT_APP,
      name: "上限",
      tables: [
        ...tables,
        {
          id: "dep_grant",
          name: "鎖の付与",
          fields: [
            ...Array.from({ length: LIMIT_CHAIN }, (_unused, level) =>
              ref(`t${level}`, `lvl${level}`),
            ),
            ref("member", "dep_member"),
            sel("permission", ["keeper"]),
          ],
        },
        { id: "dep_member", name: "鎖の利用者", fields: [text("account")] },
      ],
      views: [],
      roles: [
        {
          id: "owner",
          name: "運営",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
          ],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
    },
  } as unknown as Manifest;
}

describe("(L) 引き継ぎの上限", () => {
  test("(L-1) 上限に当たる行は HTTP が 400、MCP も上限の文で断る。上限に当たらない行は両方で読める", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "gp-rh-limit-"));
    dataRoots.push(dataRoot);
    const meta = KernelMetaStore.open(dataRoot);
    try {
      createApp(meta, "上限", { app_id: LIMIT_APP });
    } finally {
      meta.close();
    }
    const m = limitManifest();
    const applied = applyManifest(dataRoot, LIMIT_APP, m);
    expect(applied.valid, JSON.stringify(applied)).toBe(true);
    const store = AuthStore.openForApp(dataRoot, LIMIT_APP);
    let deep: { id: string; cookie: string };
    try {
      const user = store.createUser({ username: "deep", role: "editor" as never });
      deep = { id: user.id, cookie: `st_session=${store.createSession(user.id, 3600).id}` };
    } finally {
      store.close();
    }
    const rows: string[] = [];
    const db = new Database(appDbPath(dataRoot, LIMIT_APP));
    try {
      let parent: string | undefined;
      for (let level = LIMIT_CHAIN - 1; level >= 0; level -= 1) {
        const created = createRecord(db, m, `lvl${level}`, {
          title: `段${level}`,
          ...(parent === undefined ? {} : { parent }),
        });
        if (!created.ok) throw new Error(JSON.stringify(created.errors));
        rows[level] = created.value._id;
        parent = created.value._id;
      }
      const member = createRecord(db, m, "dep_member", { account: deep.id });
      if (!member.ok) throw new Error(JSON.stringify(member.errors));
      const grant = createRecord(db, m, "dep_grant", {
        [`t${LIMIT_CHAIN - 1}`]: rows[LIMIT_CHAIN - 1],
        member: member.value._id,
        permission: "keeper",
      });
      if (!grant.ok) throw new Error(JSON.stringify(grant.errors));
    } finally {
      db.close();
    }
    const server = createServerApp({ dataRoot });
    const get = async (level: number, query: string) => {
      const res = await server.request(
        new Request(
          `http://localhost/api/apps/${LIMIT_APP}/tables/lvl${level}/records/${rows[level]}${query}`,
          { headers: { cookie: deep.cookie } },
        ),
      );
      return { status: res.status, text: await res.text() };
    };
    const viaMcp = async (level: number) => {
      const mcpServer = createMcpServer({
        dataRoot,
        previewBaseUrl: "http://localhost:3000",
        actor: "deep",
      });
      const client = new Client({ name: "rh-limit", version: "0.0.0" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([client.connect(a), mcpServer.connect(b)]);
      try {
        const result = JSON.parse(
          JSON.stringify(
            await client.callTool({
              name: "list_record_history",
              arguments: { app_id: LIMIT_APP, table_id: `lvl${level}`, record_id: rows[level] },
            }),
          ),
        ) as CallToolResult;
        return { isError: result.isError === true, text: mcpText(result) };
      } finally {
        await client.close();
        await mcpServer.close();
      }
    };

    // 段0: 上限に当たる。
    for (const query of ["", "?history=1"]) {
      const hit = await get(0, query);
      expect(hit.status, hit.text).toBe(400);
      expect(hit.text).toContain(LIMIT_SENTENCE);
    }
    const limited = await viaMcp(0);
    expect(limited.isError, limited.text).toBe(true);
    expect(limited.text).toContain(LIMIT_SENTENCE);
    expect(limited.text).not.toContain("見つかりません");

    // 段1: 上限に当たらない(陰性対照)。
    const reachable = await get(1, "?history=1");
    expect(reachable.status, reachable.text).toBe(200);
    const page = (JSON.parse(reachable.text) as { history?: Page }).history;
    expect(page?.items.map((item) => item.op)).toEqual(["create"]);
    const readable = await viaMcp(1);
    expect(readable.isError, readable.text).toBe(false);
    expect(JSON.parse(readable.text) as Page).toEqual(page as Page);
  });
});
