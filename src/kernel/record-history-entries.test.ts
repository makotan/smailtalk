/**
 * **行の変更履歴の記録 —— 入口ごとに1本**(計画 §27-3 の T03 と §27-6 の重3・中3・中4・軽9)。
 *
 * 表に `history: true` を書くと、その表の行の作成・更新・削除が、書込と同じトランザクションの中で
 * 内部表 `_record_history` に1件ずつ残る。 各入口で、操作(`op`)・操作者(`actor_id`・`actor_login`・
 * `actor_role`)・入口(`entry`)・変更(`changes`)の値を見る。
 *
 * - 入口の値の規則は1つ: 自動処理の器の段の積みが空でなければ `on_create/on_update`。 空なら操作者の入口。
 *   操作者に入口が無ければ `on_create/on_update`。 値は6つ(`http`・`manual`・`inbound`・
 *   `on_create/on_update`・`schedule`・`mcp`)のどれか。
 * - 変更は項目ごとの `{field, before, after}`。 作成は値の入った全項目、削除は全項目、更新は値が変わった
 *   項目だけ(変わらない更新は記録しない)。 システム列と更新者の列(`st_updated_by`)は入れない。
 * - 壊し方: 内部表に `RAISE(ABORT)` の TRIGGER を付けると、業務の書込も残らない(作成・更新・削除)。
 * - 陰性対照: 宣言の無い表への書込は内部表に INSERT も DDL も流さない。 宣言の無いアプリでは内部表が作られない。
 * - 見張り: `src` の非テストの3関数の呼び出しのうち、操作者を渡さないものは名指しの許可リストの中だけ。
 *
 * 置き場は `src/kernel`(`src/kernel` の外の検査がカーネルの値を import すると、`kernel-import-drift` の
 * 写しに行が要る。それは授権の外)。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AuthStore } from "../auth/store.ts";
import { createMcpServer } from "../mcp/server.ts";
import { createServerApp } from "../server/app.ts";
import {
  type SeededSession,
  seedSession,
  TEST_ORIGIN,
  withDefaultRoleRules,
} from "../server/test-helpers.ts";
import { AiCapabilityStore } from "./ai-capability-store.ts";
import { dispatchAiJobs } from "./ai-dispatcher.ts";
import type { AiProvider } from "./ai-provider.ts";
import { InboundStore } from "./inbound-store.ts";
import {
  appDbPath,
  applyManifest,
  createApp,
  createRecord,
  deleteRecord,
  KernelMetaStore,
  type Manifest,
  updateRecord,
} from "./index.ts";
import { ensureIslandRuntimeReady } from "./island-runner.ts";
import { resetWorkflowClock, setWorkflowClock } from "./workflow-runner.ts";
import { runSchedulerTick } from "./workflow-scheduler.ts";

const APP_ID = "rh-entry";
const SIGNING_KEY = "rh-entry-signing-key";
const KEY_ENV_VAR = "ST_TEST_RH_ENTRY_KEY";
const ENTRIES = ["http", "manual", "inbound", "on_create/on_update", "schedule", "mcp"];
const AUTO = "on_create/on_update";
/** 長い本文(`long_text` は全文を残す)。 */
const LONG = "長い本文。".repeat(400);

const HISTORY_FIELDS = [
  { id: "ran_at", name: "実行時刻", type: "date" },
  { id: "workflow", name: "ワークフロー", type: "text" },
  { id: "trigger_type", name: "きっかけ", type: "text" },
  { id: "status", name: "結果", type: "text" },
  { id: "error", name: "エラー", type: "long_text" },
];

type Any = Record<string, unknown>;

function table(id: string, fields: Any[], history = true): Any {
  return { id, name: id, fields, ...(history ? { history: true } : {}) };
}

const text = (id: string): Any => ({ id, name: id, type: "text" });

const ENTRY_TABLES = [
  "holders",
  "items",
  "cmds",
  "stage2",
  "ext",
  "outs",
  "inbox",
  "strig",
  "aitab",
  "owned_log",
  "fails",
  "strict",
  "plain",
  "wf_log",
];

function manifest(options: { history?: boolean } = {}): Manifest {
  const h = options.history ?? true;
  return {
    app: {
      id: APP_ID,
      name: "変更履歴の入口",
      // 編集者は全部の表を読み・書き・消せる(削除の入口を撃つため)。
      roles: [
        { id: "owner", name: "持ち主" },
        {
          id: "editor",
          name: "編集者",
          rules: ENTRY_TABLES.map((id) => ({
            target: "table",
            table: id,
            can: ["read", "write", "delete"],
          })),
        },
        { id: "viewer", name: "閲覧者" },
      ],
      tables: [
        table("holders", [text("name"), { id: "st_owner", name: "所有者", type: "text" }], h),
        table(
          "items",
          [
            text("title"),
            { id: "memo", name: "メモ", type: "long_text" },
            { id: "qty", name: "数", type: "number" },
            { id: "flag", name: "旗", type: "boolean" },
            { id: "holder", name: "担当", type: "reference", reference_table: "holders" },
            { id: "pic", name: "写真", type: "image" },
            { id: "st_updated_by", name: "更新者", type: "text" },
          ],
          h,
        ),
        table("cmds", [text("title"), { id: "qty", name: "数", type: "number" }], h),
        table("stage2", [text("note")], h),
        table("ext", [text("note")], h),
        table("outs", [text("note")], h),
        table("inbox", [{ id: "ev", name: "知らせ", type: "text", unique: true }], h),
        table("strig", [text("note")], h),
        table(
          "aitab",
          [
            text("memo"),
            text("label"),
            { id: "holder", name: "担当", type: "reference", reference_table: "holders" },
          ],
          h,
        ),
        table("owned_log", [text("src"), { id: "st_owner", name: "所有者", type: "text" }], h),
        table("fails", [text("note")], h),
        table("strict", [{ id: "must", name: "必須", type: "text", required: true }], h),
        table("plain", [text("note")], false),
        table("wf_log", HISTORY_FIELDS, h),
      ],
      views: [
        {
          id: "item_list",
          type: "list_view",
          table: "items",
          columns: ["title"],
          actions: [
            { id: "press", run: "wf_manual", name: "押す" },
            { id: "press_replace", run: "wf_manual_replace", name: "作り直す" },
          ],
        },
      ],
      functions: [
        {
          id: "isl",
          name: "島が作る",
          code: 'export default function () { return [{ op: "create", table: "ext", values: { note: "島" } }]; }',
          input: { source: "record" },
          output: { ops: true },
        },
        {
          id: "out_fn",
          name: "作り直す",
          code: 'export default function () { return [{ note: "置き換え" }]; }',
          input: { source: "table", table: "strig" },
          output: { fields: [{ id: "note", type: "text" }] },
        },
        {
          id: "wb_fn",
          name: "書き戻す",
          code: "(rec) => [{ qty: 42 }]",
          input: { source: "record" },
          output: { fields: [{ id: "qty", type: "number" }] },
        },
      ],
      workflows: [
        {
          id: "wf_chain",
          name: "二段目を作る",
          trigger: { type: "on_create", table: "cmds" },
          history_table: "wf_log",
          actions: [
            { action: "create_record", table: "stage2", values: { note: "$record.title" } },
          ],
        },
        {
          id: "wf_island",
          name: "島を走らせる",
          trigger: { type: "on_create", table: "cmds" },
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "isl", write_ops: true }],
        },
        {
          id: "wf_replace",
          name: "作り直す",
          trigger: { type: "on_create", table: "cmds" },
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "out_fn", output_table: "outs" }],
        },
        {
          id: "wf_wb",
          name: "書き戻す",
          trigger: { type: "on_create", table: "cmds" },
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "wb_fn", write_back: "$record" }],
        },
        {
          id: "wf_upd",
          name: "二段目を直す",
          trigger: { type: "on_create", table: "stage2" },
          history_table: "wf_log",
          actions: [
            {
              action: "update_record",
              table: "stage2",
              target: "$record._id",
              values: { note: "直した" },
            },
          ],
        },
        {
          id: "wf_manual",
          name: "押す",
          trigger: { type: "manual", table: "items" },
          history_table: "wf_log",
          actions: [{ action: "create_record", table: "owned_log", values: { src: "manual" } }],
        },
        {
          id: "wf_manual_replace",
          name: "作り直す",
          trigger: { type: "manual", table: "items" },
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "out_fn", output_table: "outs" }],
        },
        {
          id: "wf_sched",
          name: "時刻で作る",
          trigger: { type: "schedule", at: { hour: 9, minute: 0 } },
          history_table: "wf_log",
          actions: [
            { action: "create_record", table: "owned_log", values: { src: "sched" } },
            { action: "run_function", function: "out_fn", output_table: "outs" },
          ],
        },
        {
          id: "wf_fail",
          name: "必ず落ちる",
          trigger: { type: "on_create", table: "fails" },
          history_table: "wf_log",
          actions: [{ action: "create_record", table: "strict", values: { must: "" } }],
        },
        {
          id: "wf_ai",
          name: "AI でラベルを付ける",
          trigger: { type: "on_update", table: "aitab" },
          history_table: "wf_log",
          act_as: "$record.holder",
          actions: [
            {
              action: "ai_transform",
              capability: "labeler",
              prompt: "ラベルを決めてください。",
              input: { memo: "$record.memo" },
              output_field: "label",
              fallback: "none",
            },
          ],
        },
      ],
    },
  } as unknown as Manifest;
}

type Rig = {
  dataRoot: string;
  manifest: Manifest;
  server: ReturnType<typeof createServerApp>;
  alice: SeededSession;
  bob: SeededSession;
  inboxEndpoint: string;
};

const dataRoots: string[] = [];

beforeAll(async () => {
  await ensureIslandRuntimeReady();
});

afterEach(async () => {
  delete process.env[KEY_ENV_VAR];
  resetWorkflowClock();
  for (const dir of dataRoots.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeRig(options: { history?: boolean } = {}): Promise<Rig> {
  const dataRoot = await mkdtemp(join(tmpdir(), "gp-rh-entry-"));
  dataRoots.push(dataRoot);
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, "変更履歴の入口", { app_id: APP_ID });
  } finally {
    meta.close();
  }
  const m = withDefaultRoleRules(manifest(options));
  const applied = applyManifest(dataRoot, APP_ID, m);
  if (!applied.valid) {
    throw new Error(JSON.stringify(applied.errors));
  }
  process.env[KEY_ENV_VAR] = SIGNING_KEY;
  const inbound = InboundStore.openForKernel(dataRoot);
  let inboxEndpoint: string;
  try {
    inboxEndpoint = inbound.issueInboundEndpoint({
      appId: APP_ID,
      name: "inbox",
      secretSource: { kind: "env", value: KEY_ENV_VAR },
      targetTable: "inbox",
    }).id;
  } finally {
    inbound.close();
  }
  seedSession(dataRoot, APP_ID, { role: "owner", username: "boss" });
  return {
    dataRoot,
    manifest: m,
    server: createServerApp({ dataRoot }),
    alice: seedSession(dataRoot, APP_ID, { role: "editor", username: "alice" }),
    bob: seedSession(dataRoot, APP_ID, { role: "editor", username: "bob" }),
    inboxEndpoint,
  };
}

function withDb<T>(rig: { dataRoot: string }, run: (db: Database) => T, appId = APP_ID): T {
  const db = new Database(appDbPath(rig.dataRoot, appId));
  try {
    return run(db);
  } finally {
    db.close();
  }
}

async function send(
  rig: Rig,
  who: SeededSession,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return await rig.server.request(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        origin: TEST_ORIGIN,
        cookie: who.cookie,
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

const recordsPath = (t: string): string => `/api/apps/${APP_ID}/tables/${t}/records`;

function rowsOf(rig: { dataRoot: string }, t: string, appId = APP_ID): Any[] {
  return withDb(rig, (db) => db.query<Any, []>(`SELECT * FROM "${t}" ORDER BY rowid`).all(), appId);
}

function versionOf(rig: Rig, t: string, id: string): string {
  return String(rowsOf(rig, t).find((row) => row._id === id)?._updated_at);
}

async function mustCreate(rig: Rig, who: SeededSession, t: string, values: Any): Promise<string> {
  const res = await send(rig, who, "POST", recordsPath(t), values);
  if (res.status !== 201) {
    throw new Error(`${t} に行を置けない: ${res.status} ${await res.text()}`);
  }
  return ((await res.json()) as { record: { _id: string } }).record._id;
}

async function patch(rig: Rig, who: SeededSession, t: string, id: string, values: Any) {
  return await send(rig, who, "PATCH", `${recordsPath(t)}/${id}`, values, {
    "if-match": versionOf(rig, t, id),
  });
}

function hasHistoryTable(rig: { dataRoot: string }, appId = APP_ID): boolean {
  return withDb(
    rig,
    (db) =>
      (db
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM sqlite_master WHERE name = '_record_history'",
        )
        .get()?.n ?? 0) > 0,
    appId,
  );
}

type HistoryRow = {
  seq: number;
  table_id: string;
  record_id: string;
  op: string;
  actor_id: string;
  actor_login: string;
  actor_role: string;
  entry: string;
  at: string;
  changes: { field: string; before: unknown; after: unknown }[];
};

/** 内部表の全行(表が無ければ空)。 `changes` は JSON を読んだもの。 */
function history(rig: { dataRoot: string }, tableId?: string, appId = APP_ID): HistoryRow[] {
  if (!hasHistoryTable(rig, appId)) {
    return [];
  }
  return withDb(
    rig,
    (db) =>
      db
        .query<Any, []>("SELECT * FROM _record_history ORDER BY seq")
        .all()
        .map((row) => ({ ...row, changes: JSON.parse(String(row.changes)) }) as HistoryRow)
        .filter((row) => tableId === undefined || row.table_id === tableId),
    appId,
  );
}

/** 操作者と入口(と操作)だけを抜く。 */
function who(row: HistoryRow | undefined): Any {
  return {
    op: row?.op,
    id: row?.actor_id,
    login: row?.actor_login,
    role: row?.actor_role,
    entry: row?.entry,
  };
}

function by(person: SeededSession | undefined, op: string, entry: string): Any {
  return {
    op,
    id: person?.userId ?? "",
    login: person?.username ?? "",
    role: person?.role ?? "",
    entry,
  };
}

function fieldsOf(row: HistoryRow | undefined): string[] {
  return (row?.changes ?? []).map((change) => change.field);
}

function expectEntriesClosed(rig: { dataRoot: string }, appId = APP_ID): void {
  for (const row of history(rig, undefined, appId)) {
    expect(ENTRIES).toContain(row.entry);
  }
}

async function mcp(rig: Rig, actor: string, name: string, args: Any): Promise<CallToolResult> {
  const server = createMcpServer({
    dataRoot: rig.dataRoot,
    previewBaseUrl: "http://localhost:3000",
    actor,
  });
  const client = new Client({ name: "rh", version: "0.0.0" });
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

function mustOk(result: CallToolResult): void {
  if (result.isError === true) {
    throw new Error(
      `道具が失敗した: ${JSON.stringify(result.structuredContent ?? result.content)}`,
    );
  }
}

async function press(rig: Rig, person: SeededSession, workflow: string, item: string) {
  return await send(
    rig,
    person,
    "POST",
    `/api/apps/${APP_ID}/views/item_list/actions/run?workflow=${workflow}&record=${item}`,
  );
}

async function upload(rig: Rig, person: SeededSession): Promise<string> {
  const form = new FormData();
  form.set(
    "file",
    new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])]),
    "f.png",
  );
  const res = await rig.server.request(
    new Request(`http://localhost/api/apps/${APP_ID}/files`, {
      method: "POST",
      headers: { cookie: person.cookie, origin: TEST_ORIGIN },
      body: form,
    }),
  );
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { file_id: string }).file_id;
}

/** 内部表を先に作り、指定の操作の INSERT を `RAISE(ABORT)` で断る TRIGGER を付ける(壊し方)。 */
function breakHistory(rig: { dataRoot: string }, op: string): void {
  withDb(rig, (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS _record_history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  op TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_login TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  entry TEXT NOT NULL,
  at TEXT NOT NULL,
  changes TEXT NOT NULL
)`);
    db.exec(
      `CREATE TRIGGER rh_break_${op} BEFORE INSERT ON _record_history WHEN NEW.op = '${op}' BEGIN SELECT RAISE(ABORT, 'rh-broken'); END`,
    );
  });
}

// =====================================================================================
// (H) 画面・HTTP
// =====================================================================================

describe("V23-M8-T03 (H) 画面・HTTP の入口は http・ログイン中の利用者", () => {
  test("(H-1) 単件の作成: 値の入った全項目(long_text は全文・画像は資産 ID・参照は相手の _id)。更新者の列とシステム列は入らない", async () => {
    const rig = await makeRig();
    const holder = await mustCreate(rig, rig.bob, "holders", { name: "担当1" });
    const pic = await upload(rig, rig.alice);
    const item = await mustCreate(rig, rig.alice, "items", {
      title: "一",
      memo: LONG,
      qty: 3,
      flag: true,
      holder,
      pic,
    });
    const rows = history(rig, "items");
    expect(rows).toHaveLength(1);
    expect(who(rows[0])).toEqual(by(rig.alice, "create", "http"));
    expect(rows[0]?.record_id).toBe(item);
    expect(rows[0]?.changes).toEqual([
      { field: "title", before: null, after: "一" },
      { field: "memo", before: null, after: LONG },
      { field: "qty", before: null, after: 3 },
      { field: "flag", before: null, after: true },
      { field: "holder", before: null, after: holder },
      { field: "pic", before: null, after: pic },
    ]);
    // 予約規約の st_owner は入る(更新者の列 st_updated_by は入らない)。
    const holderRows = history(rig, "holders");
    expect(who(holderRows[0])).toEqual(by(rig.bob, "create", "http"));
    expect(fieldsOf(holderRows[0])).toEqual(["name", "st_owner"]);
    expect(holderRows[0]?.changes[1]?.after).toBe(rig.bob.userId);
    expectEntriesClosed(rig);
  });

  test("(H-2) 単件の更新: 値が変わった項目だけ。値が1つも変わらない保存は記録しない", async () => {
    const rig = await makeRig();
    const item = await mustCreate(rig, rig.alice, "items", { title: "一", qty: 1 });
    const res = await patch(rig, rig.bob, "items", item, { title: "二", qty: 1 });
    expect(res.status, await res.clone().text()).toBe(200);
    const rows = history(rig, "items");
    expect(rows).toHaveLength(2);
    expect(who(rows[1])).toEqual(by(rig.bob, "update", "http"));
    expect(rows[1]?.changes).toEqual([{ field: "title", before: "一", after: "二" }]);
    const same = await patch(rig, rig.bob, "items", item, { title: "二" });
    expect(same.status, await same.clone().text()).toBe(200);
    expect(history(rig, "items")).toHaveLength(2);
  });

  test("(H-3) 単件の削除: 消える行の全項目(after は null)", async () => {
    const rig = await makeRig();
    const item = await mustCreate(rig, rig.alice, "items", { title: "一", qty: 1, memo: LONG });
    const res = await send(rig, rig.bob, "DELETE", `${recordsPath("items")}/${item}`, undefined, {
      "if-match": versionOf(rig, "items", item),
    });
    expect(res.status, await res.clone().text()).toBe(204);
    const rows = history(rig, "items");
    expect(rows).toHaveLength(2);
    expect(who(rows[1])).toEqual(by(rig.bob, "delete", "http"));
    expect(rows[1]?.record_id).toBe(item);
    expect(rows[1]?.changes).toEqual([
      { field: "title", before: "一", after: null },
      { field: "memo", before: LONG, after: null },
      { field: "qty", before: 1, after: null },
      { field: "flag", before: null, after: null },
      { field: "holder", before: null, after: null },
      { field: "pic", before: null, after: null },
    ]);
  });

  test("(H-4) 一括(POST /batch)の作成・更新は http・送った人", async () => {
    const rig = await makeRig();
    const item = await mustCreate(rig, rig.alice, "items", { title: "一" });
    const res = await send(rig, rig.bob, "POST", `/api/apps/${APP_ID}/batch`, {
      ops: [
        { op: "create", table: "items", values: { title: "二" } },
        { op: "update", table: "items", target: item, values: { title: "直した" } },
      ],
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const rows = history(rig, "items");
    expect(rows.map(who)).toEqual([
      by(rig.alice, "create", "http"),
      by(rig.bob, "create", "http"),
      by(rig.bob, "update", "http"),
    ]);
  });
});

// =====================================================================================
// (M) MCP の4道具
// =====================================================================================

describe("V23-M8-T03 (M) MCP の書込4道具は mcp・名乗った利用者", () => {
  test("(M-1) insert_sample_data", async () => {
    const rig = await makeRig();
    mustOk(
      await mcp(rig, "alice", "insert_sample_data", { table_id: "items", rows: [{ title: "一" }] }),
    );
    const rows = history(rig, "items");
    expect(rows.map(who)).toEqual([by(rig.alice, "create", "mcp")]);
  });

  test("(M-2) update_record", async () => {
    const rig = await makeRig();
    const item = await mustCreate(rig, rig.alice, "items", { title: "一" });
    mustOk(
      await mcp(rig, "bob", "update_record", {
        table_id: "items",
        record_id: item,
        changes: { title: "二" },
        if_match: versionOf(rig, "items", item),
      }),
    );
    const rows = history(rig, "items");
    expect(who(rows[1])).toEqual(by(rig.bob, "update", "mcp"));
    expect(rows[1]?.changes).toEqual([{ field: "title", before: "一", after: "二" }]);
  });

  test("(M-3) write_records の作成・更新", async () => {
    const rig = await makeRig();
    const item = await mustCreate(rig, rig.alice, "items", { title: "一" });
    mustOk(
      await mcp(rig, "bob", "write_records", {
        ops: [
          { op: "create", table: "items", values: { title: "二" } },
          {
            op: "update",
            table: "items",
            target: item,
            values: { title: "直した" },
            if_match: versionOf(rig, "items", item),
          },
        ],
      }),
    );
    expect(history(rig, "items").map(who)).toEqual([
      by(rig.alice, "create", "http"),
      by(rig.bob, "create", "mcp"),
      by(rig.bob, "update", "mcp"),
    ]);
  });

  test("(M-4) delete_record", async () => {
    const rig = await makeRig();
    const item = await mustCreate(rig, rig.alice, "items", { title: "一" });
    mustOk(
      await mcp(rig, "bob", "delete_record", {
        table_id: "items",
        record_id: item,
        if_match: versionOf(rig, "items", item),
      }),
    );
    const rows = history(rig, "items");
    expect(who(rows[1])).toEqual(by(rig.bob, "delete", "mcp"));
    expect(rows[1]?.changes[0]).toEqual({ field: "title", before: "一", after: null });
    expectEntriesClosed(rig);
  });
});

// =====================================================================================
// (A) 自動処理・手動起動・時刻起動・受信口・AI の書き戻し
// =====================================================================================

describe("V23-M8-T03 (A) 自動処理の連鎖は on_create/on_update・起点の操作者", () => {
  test("(A-1) 自動処理の作成と更新・島の write_ops・output_table・発火元への書き戻し・自動処理の履歴の表", async () => {
    const rig = await makeRig();
    await mustCreate(rig, rig.alice, "strig", { note: "種" });
    const cmd = await mustCreate(rig, rig.bob, "cmds", { title: "指示" });
    // 起点の作成は http。
    const cmds = history(rig, "cmds");
    expect(who(cmds[0])).toEqual(by(rig.bob, "create", "http"));
    // 発火元への書き戻し(島の write_back)は on_create/on_update・起点の人。
    expect(who(cmds[1])).toEqual(by(rig.bob, "update", AUTO));
    expect(cmds[1]?.changes).toEqual([{ field: "qty", before: null, after: 42 }]);
    expect(cmds[1]?.record_id).toBe(cmd);
    // 自動処理の作成と、その連鎖の更新。
    const stage2 = history(rig, "stage2");
    expect(stage2.map(who)).toEqual([by(rig.bob, "create", AUTO), by(rig.bob, "update", AUTO)]);
    expect(stage2[1]?.changes).toEqual([{ field: "note", before: "指示", after: "直した" }]);
    // 島の write_ops。
    expect(history(rig, "ext").map(who)).toEqual([by(rig.bob, "create", AUTO)]);
    // 島の output_table(作り直す前の行は0件なので作成だけ)。
    expect(history(rig, "outs").map(who)).toEqual([by(rig.bob, "create", AUTO)]);
    // 自動処理の履歴の表への書込は、操作者を運ばない(空)・on_create/on_update。
    const logs = history(rig, "wf_log");
    expect(logs.length).toBeGreaterThan(0);
    for (const row of logs) {
      expect(who(row)).toEqual(by(undefined, "create", AUTO));
    }
    expectEntriesClosed(rig);
  });

  test("(A-2) 手動起動のアクションと島の全置換は manual・押した人。全置換の削除も残る", async () => {
    const rig = await makeRig();
    await mustCreate(rig, rig.alice, "strig", { note: "種" });
    const item = await mustCreate(rig, rig.alice, "items", { title: "一" });
    const old = withDb(rig, (db) => {
      const created = createRecord(db, rig.manifest, "outs", { note: "古い" });
      if (!created.ok) {
        throw new Error(JSON.stringify(created.errors));
      }
      return created.value._id;
    });
    const res = await press(rig, rig.bob, "wf_manual", item);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(history(rig, "owned_log").map(who)).toEqual([by(rig.bob, "create", "manual")]);
    const replaced = await press(rig, rig.bob, "wf_manual_replace", item);
    expect(replaced.status, await replaced.clone().text()).toBe(200);
    const outs = history(rig, "outs");
    // カーネル直の作成(操作者なし)・全置換の削除・作り直しの作成。
    expect(outs.map(who)).toEqual([
      by(undefined, "create", AUTO),
      by(rig.bob, "delete", "manual"),
      by(rig.bob, "create", "manual"),
    ]);
    expect(outs[1]?.record_id).toBe(old);
    expectEntriesClosed(rig);
  });

  test("(A-3) 時刻起動のアクションと島の全置換は schedule・操作者は空(役割だけ schedule)", async () => {
    const rig = await makeRig();
    await mustCreate(rig, rig.alice, "strig", { note: "種" });
    withDb(rig, (db) => createRecord(db, rig.manifest, "outs", { note: "古い" }));
    setWorkflowClock({ now: () => new Date("2026-09-30T01:00:00.000Z") });
    runSchedulerTick({ dataRoot: rig.dataRoot, timeZone: "Asia/Tokyo" });
    const sched = { op: "create", id: "", login: "", role: "schedule", entry: "schedule" };
    expect(history(rig, "owned_log").map(who)).toEqual([sched]);
    expect(history(rig, "outs").map(who)).toEqual([
      by(undefined, "create", AUTO),
      { ...sched, op: "delete" },
      sched,
    ]);
    expectEntriesClosed(rig);
  });

  test("(A-4) 受信口は inbound・操作者は空(役割だけ inbound)", async () => {
    const rig = await makeRig();
    const rawBody = JSON.stringify({ ev: "e1" });
    const signature = `sha256=${createHmac("sha256", SIGNING_KEY).update(Buffer.from(rawBody, "utf-8")).digest("hex")}`;
    const res = await rig.server.request(
      new Request(`http://localhost/inbound/${rig.inboxEndpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Mock-PSP-Signature": signature },
        body: rawBody,
      }),
    );
    expect(res.status, await res.clone().text()).toBe(201);
    expect(history(rig, "inbox").map(who)).toEqual([
      { op: "create", id: "", login: "", role: "inbound", entry: "inbound" },
    ]);
  });

  test("(A-5) AI の書き戻しは on_create/on_update・ジョブの主体(act_as の先の持ち主)", async () => {
    const rig = await makeRig();
    const store = AiCapabilityStore.openForKernel(rig.dataRoot);
    try {
      store.createCapability({
        appId: APP_ID,
        name: "labeler",
        provider: "claude_cli",
        model: "claude-opus-4-8",
        limit: { maxCallsPerDay: 100, maxCostUsdPerDay: 10 },
      });
    } finally {
      store.close();
    }
    const holder = await mustCreate(rig, rig.bob, "holders", { name: "ぼぶの担当" });
    const target = await mustCreate(rig, rig.alice, "aitab", { memo: "元", holder });
    const res = await patch(rig, rig.alice, "aitab", target, { memo: "見直し" });
    expect(res.status, await res.clone().text()).toBe(200);
    const provider: AiProvider = async () => ({
      text: '{"value":"good"}',
      inputTokens: 1,
      outputTokens: 1,
    });
    await dispatchAiJobs(rig.dataRoot, provider);
    const rows = history(rig, "aitab");
    // 書き戻しの操作者は今日の書き戻しの起点のまま: id はジョブの主体。 ログイン名と役割は、アプリが
    // `$actor.login`・`$actor.role` を読まないので空(利用者の表を引き直さない。読むときは id から名前を引く)。
    expect(rows.map(who)).toEqual([
      by(rig.alice, "create", "http"),
      by(rig.alice, "update", "http"),
      { op: "update", id: rig.bob.userId, login: "", role: "", entry: AUTO },
    ]);
    expect(rows[2]?.changes).toEqual([{ field: "label", before: null, after: "good" }]);
  });

  test("(A-6) 失敗の履歴の書き直しは on_create/on_update・操作者は空。巻き戻った書込の履歴は残らない", async () => {
    const rig = await makeRig();
    const res = await send(rig, rig.alice, "POST", recordsPath("fails"), { note: "落ちる" });
    expect(res.status, await res.clone().text()).toBe(400);
    expect(rowsOf(rig, "fails")).toHaveLength(0);
    expect(history(rig, "fails")).toHaveLength(0);
    expect(history(rig, "strict")).toHaveLength(0);
    // 残った失敗の履歴の行と、内部表の記録は同じ数(巻き戻った書込の記録は残らない)。
    const logs = history(rig, "wf_log");
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).toHaveLength(rowsOf(rig, "wf_log").length);
    for (const row of logs) {
      expect(who(row)).toEqual(by(undefined, "create", AUTO));
      expect(row.changes.find((change) => change.field === "status")?.after).toBe("failure");
    }
  });

  test("(A-7) カーネルを直に呼んだ書込(操作者なし)は on_create/on_update・操作者は空", async () => {
    const rig = await makeRig();
    withDb(rig, (db) => {
      const created = createRecord(db, rig.manifest, "items", { title: "直" });
      if (!created.ok) {
        throw new Error(JSON.stringify(created.errors));
      }
      updateRecord(db, rig.manifest, "items", created.value._id, { title: "直2" });
      deleteRecord(db, rig.manifest, "items", created.value._id);
    });
    expect(history(rig, "items").map(who)).toEqual([
      by(undefined, "create", AUTO),
      by(undefined, "update", AUTO),
      by(undefined, "delete", AUTO),
    ]);
  });
});

// =====================================================================================
// (B) 壊し方: 内部表を壊すと業務の書込も残らない
// =====================================================================================

describe("V23-M8-T03 (B) 同じトランザクション(内部表に RAISE(ABORT) の TRIGGER)", () => {
  test("(B-1) 作成: HTTP の作成は失敗し、行は増えない", async () => {
    const rig = await makeRig();
    breakHistory(rig, "create");
    const res = await send(rig, rig.alice, "POST", recordsPath("items"), { title: "一" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(rowsOf(rig, "items")).toHaveLength(0);
  });

  test("(B-2) 更新: HTTP の更新は失敗し、値は変わらない", async () => {
    const rig = await makeRig();
    const item = await mustCreate(rig, rig.alice, "items", { title: "一" });
    breakHistory(rig, "update");
    const res = await patch(rig, rig.alice, "items", item, { title: "二" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(rowsOf(rig, "items")[0]?.title).toBe("一");
  });

  test("(B-3) 削除: HTTP の DELETE は失敗し、行は残る", async () => {
    const rig = await makeRig();
    const item = await mustCreate(rig, rig.alice, "items", { title: "一" });
    breakHistory(rig, "delete");
    const res = await send(rig, rig.alice, "DELETE", `${recordsPath("items")}/${item}`, undefined, {
      "if-match": versionOf(rig, "items", item),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(rowsOf(rig, "items")).toHaveLength(1);
  });

  test("(B-4) 削除: MCP の delete_record は失敗し、行は残る", async () => {
    const rig = await makeRig();
    const item = await mustCreate(rig, rig.alice, "items", { title: "一" });
    breakHistory(rig, "delete");
    const result = await mcp(rig, "alice", "delete_record", {
      table_id: "items",
      record_id: item,
      if_match: versionOf(rig, "items", item),
    });
    expect(result.isError).toBe(true);
    expect(rowsOf(rig, "items")).toHaveLength(1);
  });

  test("(B-5) 削除: 島の全置換の削除が落ちると、作り直しも古い行の削除も残らない", async () => {
    const rig = await makeRig();
    await mustCreate(rig, rig.alice, "strig", { note: "種" });
    const item = await mustCreate(rig, rig.alice, "items", { title: "一" });
    withDb(rig, (db) => createRecord(db, rig.manifest, "outs", { note: "古い" }));
    breakHistory(rig, "delete");
    await press(rig, rig.bob, "wf_manual_replace", item);
    expect(rowsOf(rig, "outs").map((row) => row.note)).toEqual(["古い"]);
  });

  test("(B-6) カーネル直の削除も、例外で返し行は残る(エラーを返したのに行が消えた、にならない)", async () => {
    const rig = await makeRig();
    const item = await mustCreate(rig, rig.alice, "items", { title: "一" });
    breakHistory(rig, "delete");
    expect(() =>
      withDb(rig, (db) => deleteRecord(db, rig.manifest, "items", item, undefined)),
    ).toThrow("rh-broken");
    expect(rowsOf(rig, "items")).toHaveLength(1);
  });
});

// =====================================================================================
// (N) 陰性対照
// =====================================================================================

/** 接続に流れた SQL の文字列を拾う(`query`・`prepare`・`exec`・`run`)。 */
function spySql(db: Database): string[] {
  const seen: string[] = [];
  const target = db as unknown as Record<string, (sql: string, ...rest: unknown[]) => unknown>;
  for (const name of ["query", "prepare", "exec", "run"]) {
    const original = target[name]?.bind(db);
    if (original === undefined) {
      continue;
    }
    target[name] = (sql: string, ...rest: unknown[]) => {
      seen.push(String(sql));
      return original(sql, ...rest);
    };
  }
  return seen;
}

describe("V23-M8-T03 (N) 宣言の無い表・アプリ", () => {
  test("(N-1) 宣言した表と無い表が同じアプリにあるとき、無い表への作成・更新・削除は内部表への INSERT も DDL も流さない", async () => {
    const rig = await makeRig();
    withDb(rig, (db) => {
      const seen = spySql(db);
      const created = createRecord(db, rig.manifest, "plain", { note: "一" });
      if (!created.ok) {
        throw new Error(JSON.stringify(created.errors));
      }
      updateRecord(db, rig.manifest, "plain", created.value._id, { note: "二" });
      deleteRecord(db, rig.manifest, "plain", created.value._id);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.filter((sql) => sql.includes("_record_history"))).toEqual([]);
      // 陽性対照: 宣言した表への作成は内部表に触れる(見張りが空振りしていない)。
      createRecord(db, rig.manifest, "strig", { note: "一" });
      expect(seen.filter((sql) => sql.includes("_record_history")).length).toBeGreaterThan(0);
    });
    expect(history(rig, "plain")).toEqual([]);
  });

  test("(N-2) 宣言した表があるアプリでも、無い表にだけ書く間は内部表を作らない(HTTP)", async () => {
    const rig = await makeRig();
    const id = await mustCreate(rig, rig.alice, "plain", { note: "一" });
    await patch(rig, rig.alice, "plain", id, { note: "二" });
    expect(hasHistoryTable(rig)).toBe(false);
  });

  test("(N-3) 宣言の無いアプリでは、どの入口から書いても app.sqlite に内部表が作られない", async () => {
    const rig = await makeRig({ history: false });
    await mustCreate(rig, rig.alice, "strig", { note: "種" });
    const item = await mustCreate(rig, rig.alice, "items", { title: "一" });
    await patch(rig, rig.bob, "items", item, { title: "二" });
    await mustCreate(rig, rig.bob, "cmds", { title: "指示" });
    await press(rig, rig.bob, "wf_manual_replace", item);
    mustOk(
      await mcp(rig, "alice", "insert_sample_data", { table_id: "items", rows: [{ title: "三" }] }),
    );
    const res = await send(rig, rig.bob, "DELETE", `${recordsPath("items")}/${item}`, undefined, {
      "if-match": versionOf(rig, "items", item),
    });
    expect(res.status).toBe(204);
    expect(hasHistoryTable(rig)).toBe(false);
    expect(
      withDb(rig, (db) =>
        db
          .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name LIKE '%history%'")
          .all(),
      ),
    ).toEqual([]);
  });
});

// =====================================================================================
// (R) 名簿・付与の書込点(自己登録・招待の承諾・役割の変更・埋め戻し・作成者への付与・退会の連鎖)
// =====================================================================================

const R_APP = "rh-roster";
const PERMS = [{ id: "keeper", name: "管理", read: true, write: true, delete: true }];
const WORKER_RULES = [
  { target: "table", table: "orgs", can: ["read", "write"] },
  { target: "table", table: "mem", can: ["read"] },
  { target: "table", table: "og", can: ["read", "write"] },
];

function declaration(autoEnroll: boolean): Any {
  return {
    enabled: true,
    permissions: PERMS,
    creator_permission: "keeper",
    creatable_by_roles: ["member", "expert", "editor"],
    grant: { table: "og", target: "org", member: "member", permission: "permission" },
    members: {
      table: "mem",
      account: "account",
      ...(autoEnroll ? { auto_enroll: { roles: ["member", "expert"], name: "display" } } : {}),
    },
  };
}

function rosterManifest(autoEnroll: boolean): Manifest {
  const base = {
    app: {
      id: R_APP,
      name: "名簿の履歴",
      tables: [
        {
          id: "orgs",
          name: "組織",
          history: true,
          fields: [{ id: "title", name: "名", type: "text" }],
          access_control: declaration(autoEnroll),
        },
        {
          id: "mem",
          name: "名簿",
          history: true,
          fields: [
            { id: "account", name: "利用者", type: "text" },
            { id: "display", name: "表示名", type: "text" },
          ],
        },
        {
          id: "og",
          name: "付与",
          history: true,
          fields: [
            { id: "org", name: "組織", type: "reference", reference_table: "orgs" },
            { id: "member", name: "相手", type: "reference", reference_table: "mem" },
            { id: "permission", name: "権限", type: "select", options: ["keeper"] },
          ],
        },
      ],
      views: [],
      roles: [
        { id: "owner", name: "持ち主" },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
        { id: "member", name: "会員", signup: "open", rules: WORKER_RULES },
        { id: "expert", name: "専門家", signup: "invite", rules: WORKER_RULES },
      ],
    },
  };
  return withDefaultRoleRules(base as unknown as Manifest, { skipTables: ["orgs"] });
}

async function makeRosterApp(autoEnroll: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gp-rh-roster-"));
  dataRoots.push(root);
  const meta = KernelMetaStore.open(root);
  try {
    createApp(meta, "名簿の履歴", { app_id: R_APP });
  } finally {
    meta.close();
  }
  const applied = applyManifest(root, R_APP, rosterManifest(autoEnroll));
  if (!applied.valid) {
    throw new Error(JSON.stringify(applied.errors));
  }
  return root;
}

async function rsend(
  root: string,
  method: string,
  path: string,
  body: unknown,
  cookie?: string,
): Promise<Response> {
  return await createServerApp({ dataRoot: root }).request(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        origin: TEST_ORIGIN,
        ...(cookie === undefined ? {} : { cookie }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

function account(root: string, username: string): Any {
  const store = AuthStore.openForApp(root, R_APP);
  try {
    const user = store.findUserByUsername(username);
    return { id: user?.id, login: user?.username, role: user?.role };
  } finally {
    store.close();
  }
}

function rwho(row: HistoryRow | undefined): Any {
  return { id: row?.actor_id, login: row?.actor_login, role: row?.actor_role, entry: row?.entry };
}

async function selfRegister(root: string, username: string, kind: string, code?: string) {
  return await rsend(root, "POST", `/api/apps/${R_APP}/auth/signup/password/register`, {
    username,
    password: "pw-123456",
    user_kind: kind,
    ...(code === undefined ? {} : { invitation_code: code }),
  });
}

function sessionCookie(response: Response): string {
  const match = /st_session=[^;]+/.exec(response.headers.get("set-cookie") ?? "");
  return match === null ? "" : match[0];
}

function declareDiff(diffId: string): Any {
  return {
    diff_id: diffId,
    intent: "名簿へ自動で入れる",
    operations: [
      { op: "change_table", table: "orgs", changes: { access_control: declaration(true) } },
    ],
  };
}

describe("V23-M8-T03 (R) 名簿・付与の書込点", () => {
  test("(R-1) 自己登録の自動登録は http・登録した本人", async () => {
    const root = await makeRosterApp(true);
    seedSession(root, R_APP, { role: "owner", username: "owner1" });
    const res = await selfRegister(root, "alice", "member");
    expect(res.status, await res.clone().text()).toBe(200);
    const rows = history({ dataRoot: root }, "mem", R_APP);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.op).toBe("create");
    expect(rwho(rows[0])).toEqual({ ...account(root, "alice"), entry: "http" });
  });

  test("(R-2) 招待の承諾での自動登録は http・登録した本人", async () => {
    const root = await makeRosterApp(true);
    seedSession(root, R_APP, { role: "owner", username: "owner1" });
    const store = AuthStore.openForApp(root, R_APP);
    let code: string;
    try {
      code = store.issueInvitation({
        username: "bob",
        role: "expert" as never,
        issuedBy: "owner1",
      }).code;
    } finally {
      store.close();
    }
    const res = await selfRegister(root, "bob", "expert", code);
    expect(res.status, await res.clone().text()).toBe(200);
    const rows = history({ dataRoot: root }, "mem", R_APP);
    expect(rows.map(rwho)).toEqual([{ ...account(root, "bob"), entry: "http" }]);
  });

  test("(R-3) 役割の変更での自動登録は http・操作した人", async () => {
    const root = await makeRosterApp(true);
    const owner = seedSession(root, R_APP, { role: "owner", username: "owner1" });
    const carol = seedSession(root, R_APP, { role: "viewer", username: "carol" });
    const res = await rsend(
      root,
      "PATCH",
      `/api/apps/${R_APP}/auth/users/${carol.userId}`,
      { role: "member" },
      owner.cookie,
    );
    expect(res.status, await res.clone().text()).toBe(200);
    const rows = history({ dataRoot: root }, "mem", R_APP);
    expect(rows.map(rwho)).toEqual([
      { id: owner.userId, login: "owner1", role: "owner", entry: "http" },
    ]);
    expect(rows[0]?.changes.find((change) => change.field === "account")?.after).toBe(carol.userId);
  });

  test("(R-4) 差分の適用の埋め戻しは、HTTP の差分は http・適用した人", async () => {
    const root = await makeRosterApp(false);
    seedSession(root, R_APP, { role: "member", username: "m1" });
    const owner = seedSession(root, R_APP, { role: "owner", username: "owner2" });
    const res = await rsend(
      root,
      "POST",
      `/api/apps/${R_APP}/diffs`,
      declareDiff("d1"),
      owner.cookie,
    );
    expect(res.status, await res.clone().text()).toBe(201);
    const rows = history({ dataRoot: root }, "mem", R_APP);
    expect(rows.map(rwho)).toEqual([
      { id: owner.userId, login: "owner2", role: "owner", entry: "http" },
    ]);
  });

  test("(R-5) 差分の適用の埋め戻しは、MCP の apply_diff は mcp・名乗った人", async () => {
    const root = await makeRosterApp(false);
    const owner = seedSession(root, R_APP, { role: "owner", username: "owner1" });
    seedSession(root, R_APP, { role: "member", username: "m1" });
    const server = createMcpServer({
      dataRoot: root,
      previewBaseUrl: "http://localhost:3000",
      actor: "owner1",
    });
    const client = new Client({ name: "rh", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    let result: CallToolResult;
    try {
      result = (await client.callTool({
        name: "apply_diff",
        arguments: { app_id: R_APP, diff: declareDiff("d2") },
      })) as CallToolResult;
    } finally {
      await client.close();
      await server.close();
    }
    expect(result.isError === true, JSON.stringify(result.content)).toBe(false);
    const rows = history({ dataRoot: root }, "mem", R_APP);
    expect(rows.map(rwho)).toEqual([
      { id: owner.userId, login: "owner1", role: "owner", entry: "mcp" },
    ]);
  });

  test("(R-6) 作成者への付与は http・行を作った人", async () => {
    const root = await makeRosterApp(true);
    seedSession(root, R_APP, { role: "owner", username: "owner1" });
    const reg = await selfRegister(root, "alice", "member");
    expect(reg.status, await reg.clone().text()).toBe(200);
    const created = await rsend(
      root,
      "POST",
      `/api/apps/${R_APP}/tables/orgs/records`,
      { title: "A 社" },
      sessionCookie(reg),
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const alice = { ...account(root, "alice"), entry: "http" };
    expect(history({ dataRoot: root }, "orgs", R_APP).map(rwho)).toEqual([alice]);
    const grants = history({ dataRoot: root }, "og", R_APP);
    expect(grants.map(rwho)).toEqual([alice]);
    expect(grants[0]?.op).toBe("create");
  });

  test("(R-7) 退会の連鎖は、宣言した名簿・付与表の行ごとに delete・http・退会する本人", async () => {
    const root = await makeRosterApp(true);
    seedSession(root, R_APP, { role: "owner", username: "owner1" });
    const reg = await selfRegister(root, "alice", "member");
    const cookie = sessionCookie(reg);
    const created = await rsend(
      root,
      "POST",
      `/api/apps/${R_APP}/tables/orgs/records`,
      { title: "A 社" },
      cookie,
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const alice = { ...account(root, "alice"), entry: "http" };
    const res = await rsend(root, "DELETE", `/api/apps/${R_APP}/auth/me`, undefined, cookie);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(rowsOf({ dataRoot: root }, "mem", R_APP)).toHaveLength(0);
    expect(rowsOf({ dataRoot: root }, "og", R_APP)).toHaveLength(0);
    const mem = history({ dataRoot: root }, "mem", R_APP);
    expect(mem.map((row) => row.op)).toEqual(["create", "delete"]);
    expect(rwho(mem[1])).toEqual(alice);
    const og = history({ dataRoot: root }, "og", R_APP);
    expect(og.map((row) => row.op)).toEqual(["create", "delete"]);
    expect(rwho(og[1])).toEqual(alice);
    expectEntriesClosed({ dataRoot: root }, R_APP);
  });
});

// =====================================================================================
// (C) 親を消すと子ごと(HTTP と MCP)
// =====================================================================================

const C_APP = "rh-cascade";
const C_PERMS = [{ id: "keeper", name: "消せる", read: true, write: true, delete: true }];

function cascadeDeclaration(target: string, inheritFrom?: string[]): Any {
  return {
    enabled: true,
    permissions: C_PERMS,
    creator_permission: "keeper",
    grant: { table: "ac_grant", target, member: "member", permission: "permission" },
    members: { table: "ac_member", account: "account" },
    ...(inheritFrom === undefined ? {} : { inherit_from: inheritFrom }),
  };
}

function cascadeManifest(): Manifest {
  const base = {
    app: {
      id: C_APP,
      name: "親を消すと子ごと",
      tables: [
        {
          id: "projects",
          name: "案件",
          history: true,
          fields: [{ id: "title", name: "名前", type: "text", required: true }],
          access_control: cascadeDeclaration("project"),
        },
        {
          id: "issues",
          name: "課題",
          history: true,
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "project", name: "案件", type: "reference", reference_table: "projects" },
          ],
          access_control: cascadeDeclaration("issue", ["project"]),
        },
        {
          id: "ac_member",
          name: "名簿",
          fields: [{ id: "account", name: "利用者", type: "text" }],
        },
        {
          id: "ac_grant",
          name: "付与",
          fields: [
            { id: "project", name: "案件", type: "reference", reference_table: "projects" },
            { id: "issue", name: "課題", type: "reference", reference_table: "issues" },
            { id: "member", name: "相手", type: "reference", reference_table: "ac_member" },
            { id: "permission", name: "権限", type: "select", options: ["keeper"] },
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
  return withDefaultRoleRules(base as unknown as Manifest, { skipTables: ["projects", "issues"] });
}

async function makeCascade(): Promise<{
  dataRoot: string;
  keeper: SeededSession;
  project: string;
  issues: string[];
}> {
  const dataRoot = await mkdtemp(join(tmpdir(), "gp-rh-cascade-"));
  dataRoots.push(dataRoot);
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, "親を消すと子ごと", { app_id: C_APP });
  } finally {
    meta.close();
  }
  const m = cascadeManifest();
  const applied = applyManifest(dataRoot, C_APP, m);
  if (!applied.valid) {
    throw new Error(JSON.stringify(applied.errors));
  }
  seedSession(dataRoot, C_APP, { role: "owner", username: "boss" });
  const keeper = seedSession(dataRoot, C_APP, { role: "editor", username: "keeper" });
  const db = new Database(appDbPath(dataRoot, C_APP));
  try {
    const put = (t: string, values: Any): string => {
      const created = createRecord(db, m, t, values);
      if (!created.ok) {
        throw new Error(JSON.stringify(created.errors));
      }
      return created.value._id;
    };
    const member = put("ac_member", { account: keeper.userId });
    const project = put("projects", { title: "案件1" });
    put("ac_grant", { project, member, permission: "keeper" });
    const issues = [
      put("issues", { title: "課題1", project }),
      put("issues", { title: "課題2", project }),
    ];
    return { dataRoot, keeper, project, issues };
  } finally {
    db.close();
  }
}

describe("V23-M8-T03 (C) 親を消すと子ごと", () => {
  test("(C-1) HTTP: 子と親が1件ずつ delete・http・消した人", async () => {
    const c = await makeCascade();
    const version = String(
      rowsOf(c, "projects", C_APP).find((row) => row._id === c.project)?._updated_at,
    );
    const res = await createServerApp({ dataRoot: c.dataRoot }).request(
      new Request(`http://localhost/api/apps/${C_APP}/tables/projects/records/${c.project}`, {
        method: "DELETE",
        headers: {
          origin: TEST_ORIGIN,
          cookie: c.keeper.cookie,
          "if-match": version,
          "if-match-children": "2",
        },
      }),
    );
    expect(res.status, await res.clone().text()).toBe(204);
    const deletes = history(c, undefined, C_APP).filter((row) => row.op === "delete");
    expect(deletes.map((row) => row.record_id).sort()).toEqual([...c.issues, c.project].sort());
    for (const row of deletes) {
      expect(who(row)).toEqual(by(c.keeper, "delete", "http"));
    }
  });

  test("(C-2) MCP: 子と親が1件ずつ delete・mcp・名乗った人", async () => {
    const c = await makeCascade();
    const version = String(
      rowsOf(c, "projects", C_APP).find((row) => row._id === c.project)?._updated_at,
    );
    const server = createMcpServer({
      dataRoot: c.dataRoot,
      previewBaseUrl: "http://localhost:3000",
      actor: "keeper",
    });
    const client = new Client({ name: "rh", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    let result: CallToolResult;
    try {
      result = (await client.callTool({
        name: "delete_record",
        arguments: {
          app_id: C_APP,
          table_id: "projects",
          record_id: c.project,
          if_match: version,
          if_match_children: 2,
        },
      })) as CallToolResult;
    } finally {
      await client.close();
      await server.close();
    }
    expect(result.isError === true, JSON.stringify(result.content)).toBe(false);
    const deletes = history(c, undefined, C_APP).filter((row) => row.op === "delete");
    expect(deletes.map((row) => row.record_id).sort()).toEqual([...c.issues, c.project].sort());
    for (const row of deletes) {
      expect(who(row)).toEqual(by(c.keeper, "delete", "mcp"));
    }
  });
});

// =====================================================================================
// (W) 見張り: 操作者を渡さない呼び出しは名指しの許可リストの中だけ
// =====================================================================================

/** 操作者の引数の位置(0 始まり)。 */
const ORIGIN_ARG = { createRecord: 4, updateRecord: 6, deleteRecord: 5 } as const;

/**
 * 操作者を渡さない呼び出しの許可リスト(`ファイル:囲む関数`)。 自動処理の履歴の表への書込・
 * 失敗の履歴の書き直し(HTTP と MCP)・検査の子プロセス。
 */
const ALLOWED_WITHOUT_ORIGIN = [
  "src/kernel/two-process/patch-writer.ts:(top)",
  "src/kernel/workflow-runner.ts:writeHistoryRow",
  "src/mcp/tools/write.ts:rewriteMcpHistory",
  "src/server/app.ts:rewriteHeldHistory",
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (name.endsWith(".ts") && !name.includes(".test.")) {
      out.push(path);
    }
  }
  return out;
}

/** コメントを空白に置き換える(位置は保つ)。 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(
      /(^|[\s;{}(),])\/\/[^\n]*/g,
      (line, lead: string) => lead + " ".repeat(line.length - lead.length),
    );
}

/** `(` の位置から対応する `)` までを読み、上の段の引数の数を返す。 */
function argCount(source: string, open: number): number {
  let depth = 0;
  let count = 0;
  let sawToken = false;
  let quote: string | undefined;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i] as string;
    if (quote !== undefined) {
      if (ch === "\\") {
        i += 1;
      } else if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      sawToken = true;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      if (depth > 1) {
        sawToken = true;
      }
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return sawToken ? count + 1 : count;
      }
      continue;
    }
    if (depth === 1 && ch === ",") {
      // 末尾のカンマ(`, )`)は数えない。
      const rest = source.slice(i + 1).trimStart();
      if (rest.startsWith(")")) {
        continue;
      }
      count += 1;
      sawToken = false;
      continue;
    }
    if (depth === 1 && !/\s/.test(ch)) {
      sawToken = true;
    }
  }
  return -1;
}

function enclosingFunction(source: string, at: number): string {
  const before = source.slice(0, at);
  const matches = [...before.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)];
  const last = matches[matches.length - 1];
  return last === undefined ? "(top)" : (last[1] as string);
}

describe("V23-M8-T03 (W) 見張り", () => {
  test("(W-1) src の非テストの作成・更新・削除の呼び出しのうち、操作者を渡さないものは名指しの許可リストの中だけ", () => {
    const root = join(import.meta.dir, "..", "..");
    const missing: string[] = [];
    let calls = 0;
    for (const file of sourceFiles(join(root, "src"))) {
      const source = withoutComments(readFileSync(file, "utf-8"));
      for (const match of source.matchAll(
        /(?<![\w.])(createRecord|updateRecord|deleteRecord)\(/g,
      )) {
        const index = match.index ?? 0;
        if (/function\s+$/.test(source.slice(Math.max(0, index - 12), index))) {
          continue;
        }
        calls += 1;
        const name = match[1] as keyof typeof ORIGIN_ARG;
        const count = argCount(source, index + name.length);
        if (count <= ORIGIN_ARG[name]) {
          missing.push(`${relative(root, file)}:${enclosingFunction(source, index)}`);
        }
      }
    }
    expect(calls).toBeGreaterThan(20);
    expect([...new Set(missing)].sort()).toEqual(ALLOWED_WITHOUT_ORIGIN);
  });
});
