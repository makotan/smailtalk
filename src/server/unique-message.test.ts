/**
 * **一意違反の文言(`unique_message`)を入口ごとに効かせる**(`V23-M2-T03`。上位:
 * `docs/adr/0498-unique-message-reject-and-atomic-creator-grant.md` §Decision 1・限定4・5、
 * `docs/adr/0517-v23-m2-guard-authorization-and-conditional-rows.md` §Decision 6・7、
 * 決定 `D-V23-46`・`D-V23-47`・`D-V23-52`・`D-V23-53`・`D-V23-54`・`D-V23-56`、
 * 計画 `docs/plan/v23/00-v23-plan.md` §21-2 の T03 と §21-4 の「T03 に足す」)。
 *
 * **見ること**:
 * - 文言を書いた列の一意違反(`unique: true` と `"owner"`)は、文面が宣言の文言に替わる。
 *   `path` は今日のまま、今日の汎用の `hint` は付かない。
 * - HTTP は、失敗の**全部**がアプリの理由のときだけ 422 と最上位の `kind: "app_rejected"`。
 *   今日の検査の失敗が1件でも混ざれば今日の 400(差し替えた文言は残る)。
 * - 連鎖(自動処理の `create_record`・`update_record`、島の `write_ops`、`write_back`)の中の違反は、
 *   最も外の書込が `path: ""` と作者の文言そのままで返し、HTTP は 422。
 * - 受信口: `unique: true` の列は今日どおり吸収して 200。 `"owner"` の列と、連鎖の中の違反は
 *   吸収せず 422 と文言。
 * - MCP の3道具は文言を返す。 手動起動と時刻起動の履歴の `error` 列に、前置きと文言が残る。
 * - 名簿の一意索引に当たった書込の翻訳(`V23-M1-T05`)にも文言が効く。
 * - **陰性対照**: 文言を書かない列は今日の 400 と今日の文面。 `access_control` も
 *   `unique_message` も書かないアプリの応答は今日と同じ。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { InboundStore } from "../kernel/inbound-store.ts";
import {
  appDbPath,
  applyDiff,
  applyManifest,
  createApp,
  KernelMetaStore,
  type Manifest,
} from "../kernel/index.ts";
import { ensureIslandRuntimeReady } from "../kernel/island-runner.ts";
import { runScheduledWorkflow } from "../kernel/workflow-runner.ts";
import { createMcpServer } from "../mcp/server.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN } from "./test-helpers.ts";

const APP_ID = "uniq-msg";
const KEY_ENV_VAR = "GP_TEST_UNIQUE_MESSAGE_INBOUND_KEY";
const SIGNING_KEY = "unique-message-signing-key";

/** 宣言した文言(作者の固定文。行の値を含まない)。 */
const MSG_CODE = "その番号はもう使われています";
const MSG_TAG = "同じ札はあなたの一覧に既にあります";
const MSG_WB = "書き戻し先の番号が重なっています";
const MSG_EV = "同じ知らせは受け取り済みです";
const MSG_INB_TAG = "受信の札が重なっています";
const MSG_ROSTER = "その利用者は既に名簿にいます";
/** 履歴の `error` 列に入る前置き(`D-V23-45`)。 */
const HISTORY_PREFIX = "アプリが定めた理由で断りました: ";

const DUP = "C-001";

const HISTORY_FIELDS = [
  { id: "ran_at", name: "実行時刻", type: "date" },
  { id: "workflow", name: "ワークフロー", type: "text" },
  { id: "trigger_type", name: "きっかけ", type: "text" },
  { id: "status", name: "結果", type: "text" },
  { id: "error", name: "エラー", type: "long_text" },
];

const ALL = ["read", "write", "delete"];

const TABLE_IDS = [
  "codes",
  "tags",
  "trig",
  "trig_up",
  "trig_isl",
  "wbt",
  "inb",
  "inb2",
  "mtrig",
  "strig",
  "wf_log",
];

/** 文言を書くか(`true`)、書かない今日のアプリか(`false`)。 */
function manifest(withMessages: boolean): Manifest {
  const msg = (text: string): Record<string, string> =>
    withMessages ? { unique_message: text } : {};
  return {
    app: {
      id: APP_ID,
      name: "一意の文言",
      tables: [
        {
          id: "codes",
          name: "番号",
          fields: [
            { id: "code", name: "番号", type: "text", unique: true, ...msg(MSG_CODE) },
            { id: "plain", name: "文言なしの一意", type: "text", unique: true },
            { id: "num", name: "数", type: "number" },
          ],
        },
        {
          id: "tags",
          name: "札",
          fields: [
            { id: "tag", name: "札", type: "text", unique: "owner", ...msg(MSG_TAG) },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
        { id: "trig", name: "作るきっかけ", fields: [{ id: "acc", name: "番号", type: "text" }] },
        {
          id: "trig_up",
          name: "直すきっかけ",
          fields: [
            { id: "acc", name: "番号", type: "text" },
            { id: "target", name: "直す行", type: "reference", reference_table: "codes" },
          ],
        },
        {
          id: "trig_isl",
          name: "島のきっかけ",
          fields: [{ id: "acc", name: "番号", type: "text" }],
        },
        {
          id: "wbt",
          name: "書き戻し先",
          fields: [
            { id: "code2", name: "番号", type: "text", unique: true, ...msg(MSG_WB) },
            { id: "memo", name: "メモ", type: "text" },
          ],
        },
        {
          id: "inb",
          name: "受信",
          fields: [
            { id: "ev", name: "知らせ", type: "text", unique: true, ...msg(MSG_EV) },
            { id: "tag", name: "札", type: "text", unique: "owner", ...msg(MSG_INB_TAG) },
          ],
        },
        {
          id: "inb2",
          name: "受信から番号を作る",
          // **連鎖の先(`codes`)と同じ名前の `unique: true` 列**を持つ(受信口の吸収は
          // `path` だけを見るので、連鎖の違反が `/code` で返ると吸収されてしまう)。
          fields: [{ id: "code", name: "番号", type: "text", unique: true }],
        },
        {
          id: "mtrig",
          name: "ボタンのきっかけ",
          fields: [{ id: "acc", name: "番号", type: "text" }],
        },
        {
          id: "strig",
          name: "時刻のきっかけ",
          fields: [{ id: "acc", name: "番号", type: "text" }],
        },
        { id: "wf_log", name: "実行履歴", fields: HISTORY_FIELDS },
      ],
      views: [
        {
          id: "mlist",
          type: "list_view",
          table: "mtrig",
          columns: ["acc"],
          actions: [{ id: "go", run: "wf_manual", name: "作る" }],
        },
      ],
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            ...TABLE_IDS.map((table) => ({ target: "table", table, can: ALL })),
            { target: "view", view: "mlist", can: ["read"] },
            { target: "action", view: "mlist", action: "go", can: ["read"] },
          ],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
      functions: [
        {
          id: "isl",
          name: "島が番号を作る",
          code: `export default function () { return [{ op: "create", table: "codes", values: { code: "${DUP}" } }]; }`,
          input: { source: "record" },
          output: { ops: true },
        },
        {
          id: "wb",
          name: "書き戻しで番号を重ねる",
          code: `export default function () { return [{ code2: "${DUP}" }]; }`,
          input: { source: "record" },
          output: { fields: [{ id: "code2", type: "text" }] },
        },
      ],
      workflows: [
        {
          id: "wf_create",
          name: "番号を作る",
          trigger: { type: "on_create", table: "trig" },
          history_table: "wf_log",
          actions: [{ action: "create_record", table: "codes", values: { code: "$record.acc" } }],
        },
        {
          id: "wf_update",
          name: "番号を直す",
          trigger: { type: "on_create", table: "trig_up" },
          history_table: "wf_log",
          actions: [
            {
              action: "update_record",
              table: "codes",
              target: "$record.target",
              values: { code: "$record.acc" },
            },
          ],
        },
        {
          id: "wf_island",
          name: "島から番号を作る",
          trigger: { type: "on_create", table: "trig_isl" },
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "isl", write_ops: true }],
        },
        {
          id: "wf_wb",
          name: "書き戻す",
          trigger: { type: "on_update", table: "wbt" },
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "wb", write_back: "$record" }],
        },
        {
          id: "wf_inb2",
          name: "受信から番号を作る",
          trigger: { type: "on_create", table: "inb2" },
          history_table: "wf_log",
          actions: [{ action: "create_record", table: "codes", values: { code: "$record.code" } }],
        },
        {
          id: "wf_manual",
          name: "ボタンで番号を作る",
          trigger: { type: "manual", table: "mtrig" },
          history_table: "wf_log",
          actions: [{ action: "create_record", table: "codes", values: { code: "$record.acc" } }],
        },
        {
          id: "wf_sched",
          name: "夜に番号を作る",
          trigger: { type: "schedule", at: { hour: 3, minute: 0 }, table: "strig" },
          history_table: "wf_log",
          actions: [{ action: "create_record", table: "codes", values: { code: "$record.acc" } }],
        },
      ],
    },
  } as unknown as Manifest;
}

type Rig = {
  dataRoot: string;
  manifest: Manifest;
  server: ReturnType<typeof createServerApp>;
  cookie: string;
  inb: string;
  inb2: string;
};

const rigs: Rig[] = [];

beforeAll(async () => {
  await ensureIslandRuntimeReady();
});

afterEach(async () => {
  delete process.env[KEY_ENV_VAR];
  for (const rig of rigs.splice(0)) {
    await rm(rig.dataRoot, { recursive: true, force: true });
  }
});

async function makeRig(withMessages: boolean): Promise<Rig> {
  const dataRoot = await mkdtemp(join(tmpdir(), "gp-unique-message-"));
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, "一意の文言", { app_id: APP_ID });
  } finally {
    meta.close();
  }
  const m = manifest(withMessages);
  const applied = applyManifest(dataRoot, APP_ID, m);
  if (!applied.valid) {
    throw new Error(JSON.stringify(applied.errors));
  }
  process.env[KEY_ENV_VAR] = SIGNING_KEY;
  const inbound = InboundStore.openForKernel(dataRoot);
  let inb: string;
  let inb2: string;
  try {
    const issue = (name: string, targetTable: string): string =>
      inbound.issueInboundEndpoint({
        appId: APP_ID,
        name,
        secretSource: { kind: "env", value: KEY_ENV_VAR },
        targetTable,
      }).id;
    inb = issue("psp", "inb");
    inb2 = issue("psp2", "inb2");
  } finally {
    inbound.close();
  }
  const cookie = seedSession(dataRoot, APP_ID, { role: "owner", username: "owner1" }).cookie;
  const rig: Rig = {
    dataRoot,
    manifest: m,
    server: createServerApp({ dataRoot }),
    cookie,
    inb,
    inb2,
  };
  rigs.push(rig);
  // 先に1行ずつ置く(重なる相手)。
  await mustCreate(rig, "codes", { code: DUP, plain: DUP });
  await mustCreate(rig, "tags", { tag: DUP });
  await mustCreate(rig, "wbt", { code2: DUP });
  return rig;
}

async function send(
  rig: Rig,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await rig.server.request(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        origin: TEST_ORIGIN,
        cookie: rig.cookie,
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function post(rig: Rig, table: string, values: Record<string, unknown>): Promise<Response> {
  return await send(rig, "POST", `/api/apps/${APP_ID}/tables/${table}/records`, values);
}

async function mustCreate(
  rig: Rig,
  table: string,
  values: Record<string, unknown>,
): Promise<string> {
  const res = await post(rig, table, values);
  if (res.status !== 201) {
    throw new Error(`${table} に行を置けない: ${res.status} ${await res.text()}`);
  }
  return ((await res.json()) as { record: { _id: string } }).record._id;
}

async function postInbound(
  rig: Rig,
  endpointId: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  const rawBody = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", SIGNING_KEY).update(Buffer.from(rawBody, "utf-8")).digest("hex")}`;
  return await rig.server.request(
    new Request(`http://localhost/inbound/${endpointId}`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Mock-PSP-Signature": signature },
      body: rawBody,
    }),
  );
}

async function mcpCall(
  rig: Rig,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const server = createMcpServer({
    dataRoot: rig.dataRoot,
    previewBaseUrl: "http://localhost:3000",
    actor: "owner1",
  });
  const client = new Client({ name: "t03", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  try {
    return (await client.callTool({
      name,
      arguments: { app_id: APP_ID, ...args },
    })) as CallToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

function mcpText(result: CallToolResult): string {
  return (result.content as { type: string; text?: string }[])
    .map((part) => part.text ?? "")
    .join("\n");
}

function withDb<T>(rig: Rig, run: (db: Database) => T): T {
  const db = new Database(appDbPath(rig.dataRoot, APP_ID));
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function count(rig: Rig, table: string, column: string, value: string): number {
  return withDb(
    rig,
    (db) =>
      db
        .query<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n FROM "${table}" WHERE "${column}" = ?`,
        )
        .get(value)?.n ?? -1,
  );
}

function rowsOf(rig: Rig, table: string): Record<string, unknown>[] {
  return withDb(rig, (db) =>
    db.query<Record<string, unknown>, []>(`SELECT * FROM "${table}"`).all(),
  );
}

function historyErrors(rig: Rig): string[] {
  return rowsOf(rig, "wf_log").map((row) => String(row.error ?? ""));
}

function rowIdOf(
  rig: Rig,
  table: string,
  column: string,
  value: string,
): { _id: string; _updated_at: string } {
  const row = withDb(rig, (db) =>
    db
      .query<{ _id: string; _updated_at: string }, [string]>(
        `SELECT "_id", "_updated_at" FROM "${table}" WHERE "${column}" = ?`,
      )
      .get(value),
  );
  if (row === null) {
    throw new Error(`${table} に ${value} の行が無い`);
  }
  return row;
}

type ErrorItem = { path: string; message: string; hint?: string };
type Body = { kind?: string; errors: ErrorItem[] };

/** 今日の `unique: true` の汎用の断り(`records.ts` の `tableUniqueError` の文面)。 */
function todayTableUnique(table: string, fieldId: string, value: string): ErrorItem {
  return {
    path: `/${fieldId}`,
    message:
      `フィールド "${fieldId}" は一意(unique)制約があり、値 ${JSON.stringify(value)} は` +
      `テーブル "${table}" の別のレコードで既に使われています。`,
    hint:
      "このフィールドは同じテーブル内で値が重複できません。別の値を指定するか、" +
      "その値を持つ既存のレコードを更新してください。",
  };
}

describe("V23-M2-T03 HTTP の入口", () => {
  test("(h-post) 単件 POST: unique: true の文言の列は 422・kind・文言・path は今日のまま・hint なし", async () => {
    const rig = await makeRig(true);
    const res = await post(rig, "codes", { code: DUP });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body).toEqual({ kind: "app_rejected", errors: [{ path: "/code", message: MSG_CODE }] });
    expect(body.errors[0]?.hint).toBeUndefined();
    expect(count(rig, "codes", "code", DUP)).toBe(1);
  });

  test('(h-owner) 単件 POST: unique: "owner" の文言の列も 422 と文言', async () => {
    const rig = await makeRig(true);
    const res = await post(rig, "tags", { tag: DUP });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body).toEqual({ kind: "app_rejected", errors: [{ path: "/tag", message: MSG_TAG }] });
    expect(count(rig, "tags", "tag", DUP)).toBe(1);
  });

  test("(h-patch) PATCH: 別の行を同じ番号に書き換えると 422 と文言", async () => {
    const rig = await makeRig(true);
    await mustCreate(rig, "codes", { code: "C-002" });
    const row = rowIdOf(rig, "codes", "code", "C-002");
    const res = await send(
      rig,
      "PATCH",
      `/api/apps/${APP_ID}/tables/codes/records/${row._id}`,
      { code: DUP },
      { "if-match": row._updated_at },
    );
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body).toEqual({ kind: "app_rejected", errors: [{ path: "/code", message: MSG_CODE }] });
    expect(count(rig, "codes", "code", DUP)).toBe(1);
  });

  test("(h-batch) まとめ書き: 422 と文言(path は今日の /ops/N の前置きのまま)。1件も書かない", async () => {
    const rig = await makeRig(true);
    const res = await send(rig, "POST", `/api/apps/${APP_ID}/batch`, {
      ops: [
        { op: "create", table: "codes", values: { code: "C-003" } },
        { op: "create", table: "codes", values: { code: DUP } },
      ],
    });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body).toEqual({
      kind: "app_rejected",
      errors: [{ path: "/ops/1/code", message: MSG_CODE }],
    });
    expect(count(rig, "codes", "code", "C-003")).toBe(0);
  });

  test("(h-mixed) 今日の検査の失敗が1件でも混ざれば今日の 400(差し替えた文言は残る。kind なし)", async () => {
    const rig = await makeRig(true);
    const res = await post(rig, "codes", { code: DUP, num: "数ではない" });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.kind).toBeUndefined();
    expect(body.errors.map((e) => e.path).sort()).toEqual(["/code", "/num"]);
    expect(body.errors.find((e) => e.path === "/code")).toEqual({
      path: "/code",
      message: MSG_CODE,
    });
  });

  test("(h-mixed-batch) まとめ書きでも、混ざれば 400", async () => {
    const rig = await makeRig(true);
    const res = await send(rig, "POST", `/api/apps/${APP_ID}/batch`, {
      ops: [{ op: "create", table: "codes", values: { code: DUP, num: "数ではない" } }],
    });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.kind).toBeUndefined();
    expect(body.errors.find((e) => e.path === "/ops/0/code")?.message).toBe(MSG_CODE);
  });

  test("(h-neg) 陰性対照: 文言を書かない一意の列は今日の 400 と今日の文面(hint つき)", async () => {
    const rig = await makeRig(true);
    const res = await post(rig, "codes", { plain: DUP });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body).toEqual({ errors: [todayTableUnique("codes", "plain", DUP)] });
  });

  test("(h-mixed-plain) 文言の列と文言なしの列が同時に重なれば 400(文言なしの側は今日の文面と hint)", async () => {
    const rig = await makeRig(true);
    const res = await post(rig, "codes", { code: DUP, plain: DUP });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body).toEqual({
      errors: [{ path: "/code", message: MSG_CODE }, todayTableUnique("codes", "plain", DUP)],
    });
  });
});

describe("V23-M2-T03 連鎖の中の違反(D-V23-52)", () => {
  test("(c-create) 自動処理の create_record: 発火元ごと戻り、422・path は空・作者の文言そのまま", async () => {
    const rig = await makeRig(true);
    const res = await post(rig, "trig", { acc: DUP });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body).toEqual({ kind: "app_rejected", errors: [{ path: "", message: MSG_CODE }] });
    expect(rowsOf(rig, "trig")).toHaveLength(0);
    expect(count(rig, "codes", "code", DUP)).toBe(1);
    // 巻き戻した後も失敗の履歴は残り(`ADR-0066` 限定5)、前置きと文言が入る(`D-V23-45`)。
    expect(historyErrors(rig).join("\n")).toContain(`${HISTORY_PREFIX}${MSG_CODE}`);
  });

  test("(c-update) 自動処理の update_record: 422・path は空・文言", async () => {
    const rig = await makeRig(true);
    const other = await mustCreate(rig, "codes", { code: "C-004" });
    const res = await post(rig, "trig_up", { acc: DUP, target: other });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body).toEqual({ kind: "app_rejected", errors: [{ path: "", message: MSG_CODE }] });
    expect(count(rig, "codes", "code", "C-004")).toBe(1);
    expect(rowsOf(rig, "trig_up")).toHaveLength(0);
  });

  test("(c-island) 島の write_ops: 422・path は空・文言", async () => {
    const rig = await makeRig(true);
    const res = await post(rig, "trig_isl", { acc: "x" });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body).toEqual({ kind: "app_rejected", errors: [{ path: "", message: MSG_CODE }] });
    expect(rowsOf(rig, "trig_isl")).toHaveLength(0);
    expect(count(rig, "codes", "code", DUP)).toBe(1);
    expect(historyErrors(rig).join("\n")).toContain(`${HISTORY_PREFIX}${MSG_CODE}`);
  });

  test("(c-writeback) write_back: 発火元の更新ごと戻り、422・path は空・文言", async () => {
    const rig = await makeRig(true);
    await mustCreate(rig, "wbt", { code2: "W-2", memo: "前" });
    const row = rowIdOf(rig, "wbt", "code2", "W-2");
    const res = await send(
      rig,
      "PATCH",
      `/api/apps/${APP_ID}/tables/wbt/records/${row._id}`,
      { memo: "後" },
      { "if-match": row._updated_at },
    );
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body).toEqual({ kind: "app_rejected", errors: [{ path: "", message: MSG_WB }] });
    const after = rowsOf(rig, "wbt").find((r) => r._id === row._id);
    expect(after?.memo).toBe("前");
    expect(after?.code2).toBe("W-2");
  });

  test("(c-batch) まとめ書きの中の連鎖も 422 と文言(path は今日の /ops/N)", async () => {
    const rig = await makeRig(true);
    const res = await send(rig, "POST", `/api/apps/${APP_ID}/batch`, {
      ops: [{ op: "create", table: "trig", values: { acc: DUP } }],
    });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body).toEqual({ kind: "app_rejected", errors: [{ path: "/ops/0", message: MSG_CODE }] });
    expect(rowsOf(rig, "trig")).toHaveLength(0);
  });
});

describe("V23-M2-T03 受信口", () => {
  test("(i-absorb) unique: true の文言の列は今日どおり冪等に吸収して 200(吸収は path だけを見る)", async () => {
    const rig = await makeRig(true);
    const first = await postInbound(rig, rig.inb, { ev: "E-1" });
    expect(first.status, await first.clone().text()).toBe(201);
    const second = await postInbound(rig, rig.inb, { ev: "E-1" });
    const body = (await second.json()) as {
      idempotent?: boolean;
      kind?: string;
      errors: ErrorItem[];
    };
    expect(second.status, JSON.stringify(body)).toBe(200);
    expect(body.idempotent).toBe(true);
    expect(body.kind).toBeUndefined();
    expect(body.errors).toEqual([{ path: "/ev", message: MSG_EV }]);
    expect(count(rig, "inb", "ev", "E-1")).toBe(1);
  });

  test('(i-owner) unique: "owner" の文言の列は吸収せず 422 と文言', async () => {
    const rig = await makeRig(true);
    const first = await postInbound(rig, rig.inb, { tag: "T-1" });
    expect(first.status, await first.clone().text()).toBe(201);
    const second = await postInbound(rig, rig.inb, { tag: "T-1" });
    const body = (await second.json()) as Body;
    expect(second.status, JSON.stringify(body)).toBe(422);
    expect(body).toEqual({
      kind: "app_rejected",
      errors: [{ path: "/tag", message: MSG_INB_TAG }],
    });
    expect(count(rig, "inb", "tag", "T-1")).toBe(1);
  });

  test("(i-chain) 連鎖の中の違反は、同名の unique: true 列があっても吸収せず 422(path は空)", async () => {
    const rig = await makeRig(true);
    const res = await postInbound(rig, rig.inb2, { code: DUP });
    const body = (await res.json()) as Body & { idempotent?: boolean };
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body.idempotent).toBeUndefined();
    expect(body).toEqual({ kind: "app_rejected", errors: [{ path: "", message: MSG_CODE }] });
    expect(rowsOf(rig, "inb2")).toHaveLength(0);
  });
});

describe("V23-M2-T03 MCP の道具", () => {
  test("(m-write) write_records: isError で文言を返す", async () => {
    const rig = await makeRig(true);
    const result = await mcpCall(rig, "write_records", {
      ops: [{ op: "create", table: "codes", values: { code: DUP } }],
    });
    expect(result.isError).toBe(true);
    expect(mcpText(result)).toContain(MSG_CODE);
    expect(count(rig, "codes", "code", DUP)).toBe(1);
  });

  test("(m-update) update_record: 文言を返す", async () => {
    const rig = await makeRig(true);
    await mustCreate(rig, "codes", { code: "C-005" });
    const row = rowIdOf(rig, "codes", "code", "C-005");
    const result = await mcpCall(rig, "update_record", {
      table_id: "codes",
      record_id: row._id,
      if_match: row._updated_at,
      changes: { code: DUP },
    });
    expect(result.isError).toBe(true);
    expect(mcpText(result)).toContain(MSG_CODE);
    expect(count(rig, "codes", "code", "C-005")).toBe(1);
  });

  test("(m-sample) insert_sample_data: failed[].errors に文言(他の行は残る)", async () => {
    const rig = await makeRig(true);
    const result = await mcpCall(rig, "insert_sample_data", {
      table_id: "codes",
      rows: [{ code: "C-006" }, { code: DUP }],
    });
    expect(result.isError ?? false).toBe(false);
    const text = mcpText(result);
    expect(text).toContain(MSG_CODE);
    const parsed = JSON.parse(text) as { failed: { index: number; errors: ErrorItem[] }[] };
    expect(parsed.failed).toEqual([{ index: 1, errors: [{ path: "/code", message: MSG_CODE }] }]);
    expect(count(rig, "codes", "code", "C-006")).toBe(1);
  });
});

describe("V23-M2-T03 手動起動と時刻起動の履歴(D-V23-45)", () => {
  test("(r-manual) 手動起動: 200 と failures に文言、履歴の error 列に前置きと文言", async () => {
    const rig = await makeRig(true);
    const trigger = await mustCreate(rig, "mtrig", { acc: DUP });
    const res = await send(
      rig,
      "POST",
      `/api/apps/${APP_ID}/views/mlist/actions/run?workflow=wf_manual&record=${trigger}`,
    );
    const body = (await res.json()) as { failures?: string[] };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect((body.failures ?? []).join("\n")).toContain(`${HISTORY_PREFIX}${MSG_CODE}`);
    expect(historyErrors(rig).join("\n")).toContain(`${HISTORY_PREFIX}${MSG_CODE}`);
    expect(count(rig, "codes", "code", DUP)).toBe(1);
  });

  test("(r-schedule) 時刻起動: 履歴の error 列に前置きと文言", async () => {
    const rig = await makeRig(true);
    await mustCreate(rig, "strig", { acc: DUP });
    const trigger = rowsOf(rig, "strig")[0];
    withDb(rig, (db) => {
      const workflow = (rig.manifest.app.workflows ?? []).find((w) => w.id === "wf_sched");
      runScheduledWorkflow(db, rig.manifest, workflow as never, {
        records: [trigger as never],
      });
    });
    expect(historyErrors(rig).join("\n")).toContain(`${HISTORY_PREFIX}${MSG_CODE}`);
    expect(count(rig, "codes", "code", DUP)).toBe(1);
  });
});

describe("V23-M2-T03 陰性対照: access_control も unique_message も書かないアプリは今日と同じ", () => {
  test("(n-post) 単件 POST は今日の 400 と今日の文面(kind なし)", async () => {
    const rig = await makeRig(false);
    const res = await post(rig, "codes", { code: DUP });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body).toEqual({ errors: [todayTableUnique("codes", "code", DUP)] });
  });

  test("(n-batch) まとめ書きは今日の 400 と今日の文面", async () => {
    const rig = await makeRig(false);
    const res = await send(rig, "POST", `/api/apps/${APP_ID}/batch`, {
      ops: [{ op: "create", table: "codes", values: { code: DUP } }],
    });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(400);
    const today = todayTableUnique("codes", "code", DUP);
    expect(body).toEqual({ errors: [{ ...today, path: "/ops/0/code" }] });
  });

  test("(n-chain) 連鎖の違反は今日の 400 とワークフローの失敗の文面、履歴に前置きは無い", async () => {
    const rig = await makeRig(false);
    const res = await post(rig, "trig", { acc: DUP });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.kind).toBeUndefined();
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]?.path).toBe("");
    expect(body.errors[0]?.message).toStartWith(
      'テーブル "trig" への書き込みは、ワークフローのアクションが失敗したため成立しませんでした',
    );
    expect(body.errors[0]?.message).toContain(
      "検証に失敗した箇所 1 件(/code)。項目の値は履歴に残していません。",
    );
    expect(historyErrors(rig).join("\n")).not.toContain(HISTORY_PREFIX);
  });

  test("(n-inbound) 受信口の連鎖の違反は今日どおり 400(吸収もしない)", async () => {
    const rig = await makeRig(false);
    const res = await postInbound(rig, rig.inb2, { code: DUP });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.kind).toBeUndefined();
    expect(body.errors[0]?.path).toBe("");
  });

  test("(n-mcp) MCP の write_records は今日の文面", async () => {
    const rig = await makeRig(false);
    const result = await mcpCall(rig, "write_records", {
      ops: [{ op: "create", table: "codes", values: { code: DUP } }],
    });
    expect(result.isError).toBe(true);
    const today = todayTableUnique("codes", "code", DUP);
    expect(JSON.parse(mcpText(result))).toEqual({ errors: [{ ...today, path: "/ops/0/code" }] });
  });
});

// --- 名簿の一意索引に当たった書込の翻訳(`V23-M1-T05`)にも文言が効く ---------------------

const ROSTER_APP_ID = "uniq-roster";

function rosterManifest(): Manifest {
  const tables = ["orgs", "mem", "og"];
  return {
    app: {
      id: ROSTER_APP_ID,
      name: "名簿の文言",
      tables: [
        {
          id: "orgs",
          name: "組織",
          fields: [{ id: "title", name: "名", type: "text" }],
        },
        {
          id: "mem",
          name: "名簿",
          fields: [
            {
              id: "account",
              name: "利用者",
              type: "text",
              unique: true,
              unique_message: MSG_ROSTER,
            },
            { id: "display", name: "表示名", type: "text" },
          ],
        },
        {
          id: "og",
          name: "付与",
          fields: [
            { id: "org", name: "組織", type: "reference", reference_table: "orgs" },
            { id: "member", name: "相手", type: "reference", reference_table: "mem" },
            { id: "permission", name: "権限", type: "select", options: ["keeper"] },
          ],
        },
      ],
      views: [],
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            ...tables.map((table) => ({ target: "table", table, can: ALL })),
          ],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
    },
  } as unknown as Manifest;
}

describe("V23-M2-T03 名簿の一意索引の翻訳", () => {
  test("(x-index) 書込時検査をすり抜けて索引に当たっても、文言で 422 を返す", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "gp-unique-message-roster-"));
    const meta = KernelMetaStore.open(dataRoot);
    try {
      createApp(meta, "名簿の文言", { app_id: ROSTER_APP_ID });
    } finally {
      meta.close();
    }
    const applied = applyManifest(dataRoot, ROSTER_APP_ID, rosterManifest());
    if (!applied.valid) {
      throw new Error(JSON.stringify(applied.errors));
    }
    const declared = applyDiff(dataRoot, ROSTER_APP_ID, {
      diff_id: "d-declare",
      intent: "名簿へ自動で入れる",
      operations: [
        {
          op: "change_table",
          table: "orgs",
          changes: {
            access_control: {
              enabled: true,
              permissions: [{ id: "keeper", name: "管理", read: true, write: true, delete: true }],
              creator_permission: "keeper",
              creatable_by_roles: ["owner"],
              grant: { table: "og", target: "org", member: "member", permission: "permission" },
              members: { table: "mem", account: "account", auto_enroll: { roles: ["editor"] } },
            },
          },
        },
      ],
    });
    if (!declared.valid) {
      throw new Error(JSON.stringify(declared.errors));
    }
    const cookie = seedSession(dataRoot, ROSTER_APP_ID, {
      role: "owner",
      username: "owner1",
    }).cookie;
    const server = createServerApp({ dataRoot });
    const rig = { dataRoot } as Rig;
    rigs.push(rig);
    const postMem = async (values: Record<string, unknown>): Promise<Response> =>
      await server.request(
        new Request(`http://localhost/api/apps/${ROSTER_APP_ID}/tables/mem/records`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: TEST_ORIGIN, cookie },
          body: JSON.stringify(values),
        }),
      );
    const first = await postMem({ account: "u-first" });
    expect(first.status, await first.clone().text()).toBe(201);
    // **競り合いを1プロセスで起こす**: `display` が "race" の行を足す直前に、同じ利用者の行を
    // 別に1行入れる(書込時検査は通った後なので、DB の一意索引に当たる)。
    const db = new Database(appDbPath(dataRoot, ROSTER_APP_ID));
    try {
      db.exec(
        `CREATE TRIGGER "t03_race" BEFORE INSERT ON "mem" WHEN NEW."display" = 'race' BEGIN ` +
          `INSERT INTO "mem"("_id", "_created_at", "_updated_at", "account") ` +
          `VALUES ('race-' || NEW."_id", NEW."_created_at", NEW."_updated_at", NEW."account"); END;`,
      );
    } finally {
      db.close();
    }
    const res = await postMem({ account: "u-race", display: "race" });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body).toEqual({
      kind: "app_rejected",
      errors: [{ path: "/account", message: MSG_ROSTER }],
    });
  });
});

// --- D-V23-259(V23-M9-T12b): 名簿の一意索引 × 手動起動・時刻起動 ---------------------------
//
// 名簿の `account` 列に `unique: true` を書かない(書込時検査は掛からず、自動登録の宣言で張った
// DB の一意索引だけが断る)。 陰性対照は自動登録を宣言しない同じアプリ(索引が無く、重複が入る)。

const INDEX_APP_ID = "uniq-index-entries";
const INDEX_DUP = "u-dup";

function indexDeclaration(autoEnroll: boolean): Record<string, unknown> {
  return {
    enabled: true,
    permissions: [{ id: "keeper", name: "管理", read: true, write: true, delete: true }],
    creator_permission: "keeper",
    creatable_by_roles: ["owner"],
    grant: { table: "og", target: "org", member: "member", permission: "permission" },
    members: {
      table: "mem",
      account: "account",
      ...(autoEnroll ? { auto_enroll: { roles: ["editor"] } } : {}),
    },
  };
}

function indexManifest(declaration?: Record<string, unknown>): Manifest {
  const tables = ["orgs", "mem", "og", "cmd", "wf_log"];
  const toRoster = (id: string, name: string, trigger: Record<string, unknown>) => ({
    id,
    name,
    trigger,
    history_table: "wf_log",
    actions: [{ action: "create_record", table: "mem", values: { account: "$record.acc" } }],
  });
  return {
    app: {
      id: INDEX_APP_ID,
      name: "名簿の索引の入口",
      tables: [
        {
          id: "orgs",
          name: "組織",
          fields: [{ id: "title", name: "名", type: "text" }],
          ...(declaration === undefined ? {} : { access_control: declaration }),
        },
        {
          id: "mem",
          name: "名簿",
          fields: [
            { id: "account", name: "利用者", type: "text" },
            { id: "display", name: "表示名", type: "text" },
          ],
        },
        {
          id: "og",
          name: "付与",
          fields: [
            { id: "org", name: "組織", type: "reference", reference_table: "orgs" },
            { id: "member", name: "相手", type: "reference", reference_table: "mem" },
            { id: "permission", name: "権限", type: "select", options: ["keeper"] },
          ],
        },
        { id: "cmd", name: "指示", fields: [{ id: "acc", name: "利用者", type: "text" }] },
        { id: "wf_log", name: "実行履歴", fields: HISTORY_FIELDS },
      ],
      views: [
        {
          id: "cmd_list",
          type: "list_view",
          table: "cmd",
          columns: ["acc"],
          actions: [{ id: "go", run: "wf_manual", name: "名簿に入れる" }],
        },
      ],
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            ...tables.map((table) => ({ target: "table", table, can: ALL })),
            { target: "view", view: "cmd_list", can: ["read"] },
            { target: "action", view: "cmd_list", action: "go", can: ["read"] },
          ],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
      workflows: [
        toRoster("wf_manual", "ボタンで名簿に入れる", { type: "manual", table: "cmd" }),
        toRoster("wf_sched", "夜に名簿に入れる", {
          type: "schedule",
          at: { hour: 3, minute: 0 },
          table: "cmd",
        }),
      ],
    },
  } as unknown as Manifest;
}

type IndexRig = {
  dataRoot: string;
  manifest: Manifest;
  sendAs: (method: string, path: string, body?: unknown) => Promise<Response>;
};

/** `autoEnroll` が真なら、自動登録の宣言を差分で足す(索引を張るのは差分の適用)。 */
async function makeIndexRig(autoEnroll: boolean): Promise<IndexRig> {
  const dataRoot = await mkdtemp(join(tmpdir(), "gp-unique-index-entries-"));
  rigs.push({ dataRoot } as Rig);
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, "名簿の索引の入口", { app_id: INDEX_APP_ID });
  } finally {
    meta.close();
  }
  const applied = applyManifest(dataRoot, INDEX_APP_ID, indexManifest());
  if (!applied.valid) {
    throw new Error(JSON.stringify(applied.errors));
  }
  const declaration = indexDeclaration(autoEnroll);
  const declared = applyDiff(dataRoot, INDEX_APP_ID, {
    diff_id: "d-declare",
    intent: "組織に行ごとのアクセス権を宣言する",
    operations: [{ op: "change_table", table: "orgs", changes: { access_control: declaration } }],
  });
  if (!declared.valid) {
    throw new Error(JSON.stringify(declared.errors));
  }
  const cookie = seedSession(dataRoot, INDEX_APP_ID, {
    role: "owner",
    username: "owner1",
  }).cookie;
  const server = createServerApp({ dataRoot });
  const sendAs = async (method: string, path: string, body?: unknown): Promise<Response> =>
    await server.request(
      new Request(`http://localhost/api/apps/${INDEX_APP_ID}${path}`, {
        method,
        headers: { "content-type": "application/json", origin: TEST_ORIGIN, cookie },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const first = await sendAs("POST", "/tables/mem/records", { account: INDEX_DUP });
  if (first.status !== 201) {
    throw new Error(`先の1行を置けない: ${first.status} ${await first.text()}`);
  }
  return { dataRoot, manifest: indexManifest(declaration), sendAs };
}

function indexRows(rig: IndexRig, sql: string): Record<string, unknown>[] {
  const db = new Database(appDbPath(rig.dataRoot, INDEX_APP_ID), { readonly: true });
  try {
    return db.query<Record<string, unknown>, []>(sql).all();
  } finally {
    db.close();
  }
}

function indexDupCount(rig: IndexRig): number {
  return indexRows(rig, `SELECT "_id" FROM "mem" WHERE "account" = '${INDEX_DUP}'`).length;
}

async function indexCmd(rig: IndexRig): Promise<Record<string, unknown>> {
  const created = await rig.sendAs("POST", "/tables/cmd/records", { acc: INDEX_DUP });
  expect(created.status, await created.clone().text()).toBe(201);
  const id = ((await created.json()) as { record: { _id: string } }).record._id;
  const row = indexRows(rig, `SELECT * FROM "cmd"`).find((r) => r._id === id);
  if (row === undefined) {
    throw new Error("指示の行が無い");
  }
  return row;
}

describe("D-V23-259: 名簿の一意索引 × 手動起動・時刻起動", () => {
  test("(x-manual) D-V23-259: 手動起動の create_record は索引に断られ、200 と failures(/account)・履歴に失敗、名簿は増えない", async () => {
    const rig = await makeIndexRig(true);
    const cmd = await indexCmd(rig);
    const res = await rig.sendAs(
      "POST",
      `/views/cmd_list/actions/run?workflow=wf_manual&record=${String(cmd._id)}`,
    );
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect((JSON.parse(text) as { failures: string[] }).failures.join("\n")).toContain("/account");
    const history = indexRows(rig, `SELECT * FROM "wf_log"`);
    expect(history.map((row) => `${String(row.trigger_type)}/${String(row.status)}`)).toEqual([
      "manual/failure",
    ]);
    expect(indexDupCount(rig)).toBe(1);
  });

  test("(x-manual-n) D-V23-259: 陰性対照: 自動登録を宣言しない同じアプリでは索引が無く、ボタンで重複が入る", async () => {
    const rig = await makeIndexRig(false);
    const cmd = await indexCmd(rig);
    const res = await rig.sendAs(
      "POST",
      `/views/cmd_list/actions/run?workflow=wf_manual&record=${String(cmd._id)}`,
    );
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect((JSON.parse(text) as { failures: string[] }).failures).toEqual([]);
    expect(indexDupCount(rig)).toBe(2);
  });

  test("(x-schedule) D-V23-259: 時刻起動の create_record は索引に断られ、履歴に失敗(/account)、名簿は増えない", async () => {
    const rig = await makeIndexRig(true);
    const cmd = await indexCmd(rig);
    const db = new Database(appDbPath(rig.dataRoot, INDEX_APP_ID));
    try {
      const workflow = (rig.manifest.app.workflows ?? []).find((w) => w.id === "wf_sched");
      runScheduledWorkflow(db, rig.manifest, workflow as never, { records: [cmd as never] });
    } finally {
      db.close();
    }
    const history = indexRows(rig, `SELECT * FROM "wf_log"`);
    expect(history.map((row) => `${String(row.trigger_type)}/${String(row.status)}`)).toEqual([
      "schedule/failure",
    ]);
    expect(String(history[0]?.error)).toContain("/account");
    expect(indexDupCount(rig)).toBe(1);
  });

  test("(x-schedule-n) D-V23-259: 陰性対照: 自動登録を宣言しない同じアプリでは、時刻起動で重複が入る", async () => {
    const rig = await makeIndexRig(false);
    const cmd = await indexCmd(rig);
    const db = new Database(appDbPath(rig.dataRoot, INDEX_APP_ID));
    try {
      const workflow = (rig.manifest.app.workflows ?? []).find((w) => w.id === "wf_sched");
      runScheduledWorkflow(db, rig.manifest, workflow as never, { records: [cmd as never] });
    } finally {
      db.close();
    }
    const history = indexRows(rig, `SELECT * FROM "wf_log"`);
    expect(history.map((row) => `${String(row.trigger_type)}/${String(row.status)}`)).toEqual([
      "schedule/success",
    ]);
    expect(indexDupCount(rig)).toBe(2);
  });
});
