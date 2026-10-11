/**
 * **島の `reject(message)` を入口ごとに効かせる**(`V23-M2-T04`。上位:
 * `docs/adr/0498-unique-message-reject-and-atomic-creator-grant.md` §Decision 1・限定6・7・9、
 * `docs/adr/0517-v23-m2-guard-authorization-and-conditional-rows.md`、
 * 決定 `D-V23-42`・`D-V23-43`・`D-V23-44`・`D-V23-45`・`D-V23-51`・`D-V23-52`・`D-V23-53`・
 * `D-V23-56`・`D-V23-60`、計画 `docs/plan/v23/00-v23-plan.md` §21-2 の T04 と §21-4 の「T04 に足す」)。
 *
 * **見ること**:
 * - 島の本文に語の境界つきの綴りがある島にだけ、第2引数 `{ reject }` が渡る。 綴りの無い島は
 *   今日どおり引数1つ(陰性対照)。
 * - `on_create` / `on_update` で呼ぶと、発火元の書込ごと戻り、HTTP は 422 と
 *   `kind: "app_rejected"`・`path: ""`・島に渡した文字列そのまま(単件 POST・PATCH・まとめ書き・
 *   受信口)。 MCP の3道具も同じ文言を返す。
 * - 連鎖の2段・3段の奥で呼んでも、`errors[0].message` が島に渡した文字列と完全に一致する。
 * - 島が例外を握りつぶしても・値を返しても断り。 2回呼べば1回目。 後の時間切れ・メモリ超過・
 *   出力超過より断りが勝つ。
 * - 文言が文字列でない・コードポイントで1〜200の外なら汎用の失敗(今日の 400)。
 * - `reject` 以外の例外は今日どおり本文を捨てる。
 * - `reject` の後のアクションは動かない(`on_create` と手動起動)。 `reject` 以外の失敗では
 *   今日どおり後続も動く。 `reject` と汎用の失敗が混ざっても 422 と最初の文言。
 * - 時刻起動は汎用の失敗(文言を履歴に残さない)。 手動起動は済んだ書込が残り、文言が
 *   `failures` に出る。 履歴は `failure` のまま、`error` 列に前置きと文言。
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

const APP_ID = "isl-reject";
const KEY_ENV_VAR = "GP_TEST_ISLAND_REJECT_INBOUND_KEY";
const SIGNING_KEY = "island-reject-signing-key";

/** 島に渡す文言(作者の固定文)。 */
const MSG = "100 を超える点数は入れられません";
const MSG_CHAIN = "三段目の島が断りました";
const MSG_SW = "握りつぶしても断りです";
const MSG_FIRST = "一回目の文言";
const MSG_SECOND = "二回目の文言";
const MSG_TO = "断った後で止まらない島";
const MSG_OUT = "断った後で大きな出力を返す島";
const MSG_MEM = "断った後でメモリを使い切る島";
const MSG_MIX = "混ざっても断りの文言";
const MSG_SEQ = "後のアクションは動かない";
const MSG_MAN = "ボタンの処理を断りました";
const MSG_SCHED = "時刻起動では文言を出さない";
/** 捨てられるべき島の例外の本文。 */
const SECRET = "SECRET-島の例外の本文";
/** 履歴の `error` 列に入る前置き(`D-V23-45`。`V23-M2-T03` と同じ)。 */
const HISTORY_PREFIX = "アプリが定めた理由で断りました: ";

const HISTORY_FIELDS = [
  { id: "ran_at", name: "実行時刻", type: "date" },
  { id: "workflow", name: "ワークフロー", type: "text" },
  { id: "trigger_type", name: "きっかけ", type: "text" },
  { id: "status", name: "結果", type: "text" },
  { id: "error", name: "エラー", type: "long_text" },
];

const ALL = ["read", "write", "delete"];

const TEXT = (id: string) => ({ id, name: id, type: "text" });

/** 島の関数(出力は更新操作の配列。空なら何も書かない)。 */
function opsFn(id: string, code: string) {
  return { id, name: id, code, input: { source: "record" }, output: { ops: true } };
}

/** 島の関数(出力を発火元の行へ書き戻す。引数の数を測る)。 */
function argcFn(id: string, code: string) {
  return {
    id,
    name: id,
    code,
    input: { source: "record" },
    output: { fields: [{ id: "n", type: "number" }] },
  };
}

function onCreate(id: string, table: string, actions: unknown[]) {
  return {
    id,
    name: id,
    trigger: { type: "on_create", table },
    history_table: "wf_log",
    actions,
  };
}

const run = (fn: string) => ({ action: "run_function", function: fn, write_ops: true });

/** 解決できない参照を持つ作成(動けば必ず失敗する。動いたかどうかを履歴で見る)。 */
const FAILING_CREATE = { action: "create_record", table: "logs", values: { v: "$record.nope" } };

const TABLES: Record<string, unknown>[] = [
  {
    id: "scores",
    name: "点数",
    fields: [{ id: "score", name: "点数", type: "number" }, TEXT("memo")],
  },
  { id: "c1", name: "一段目", fields: [TEXT("v")] },
  { id: "c2", name: "二段目", fields: [TEXT("v")] },
  { id: "c3", name: "三段目", fields: [TEXT("v")] },
  { id: "sw", name: "握りつぶす", fields: [TEXT("v")] },
  { id: "tw", name: "二回呼ぶ", fields: [TEXT("v")] },
  { id: "inv", name: "文言の境界", fields: [TEXT("kind")] },
  { id: "to", name: "時間切れ", fields: [TEXT("v")] },
  { id: "big", name: "出力超過", fields: [TEXT("v")] },
  { id: "mem", name: "メモリ超過", fields: [TEXT("v")] },
  { id: "thr", name: "例外", fields: [TEXT("v")] },
  { id: "mix", name: "混ざる", fields: [TEXT("v")] },
  { id: "seq", name: "後続", fields: [TEXT("v")] },
  { id: "seq_gen", name: "後続(汎用の失敗)", fields: [TEXT("v")] },
  {
    id: "argc0",
    name: "綴りなし",
    fields: [TEXT("v"), { id: "n", name: "引数の数", type: "number" }],
  },
  {
    id: "argc1",
    name: "綴りあり",
    fields: [TEXT("v"), { id: "n", name: "引数の数", type: "number" }],
  },
  {
    id: "argc2",
    name: "境界の外の綴り",
    fields: [TEXT("v"), { id: "n", name: "引数の数", type: "number" }],
  },
  { id: "logs", name: "記録", fields: [TEXT("v")] },
  { id: "mtrig", name: "ボタンのきっかけ", fields: [TEXT("v")] },
  { id: "mlog", name: "ボタンの記録", fields: [TEXT("v")] },
  { id: "strig", name: "時刻のきっかけ", fields: [TEXT("v")] },
  { id: "slog", name: "時刻の記録", fields: [TEXT("v")] },
  // 【`V23-M2-T11` / `D-V23-72`】連鎖の奥の断りと後続のアクション(時刻起動・手動起動・作成・更新)。
  { id: "sc_log", name: "時刻の連鎖の記録", fields: [TEXT("v")] },
  { id: "mc_trig", name: "ボタンの連鎖のきっかけ", fields: [TEXT("v")] },
  { id: "mc_log", name: "ボタンの連鎖の記録", fields: [TEXT("v")] },
  { id: "oc_trig", name: "作成の連鎖のきっかけ", fields: [TEXT("v")] },
  { id: "ou_trig", name: "更新の連鎖のきっかけ", fields: [TEXT("v")] },
  { id: "wf_log", name: "実行履歴", fields: HISTORY_FIELDS },
];

const TABLE_IDS = TABLES.map((table) => String(table.id));

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "島の断り",
      tables: TABLES,
      views: [
        {
          id: "mlist",
          type: "list_view",
          table: "mtrig",
          columns: ["v"],
          actions: [{ id: "go", run: "wf_manual", name: "実行" }],
        },
        {
          id: "mclist",
          type: "list_view",
          table: "mc_trig",
          columns: ["v"],
          actions: [{ id: "go", run: "wf_manual_chain", name: "実行" }],
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
            { target: "view", view: "mclist", can: ["read"] },
            { target: "action", view: "mclist", action: "go", can: ["read"] },
          ],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
      functions: [
        opsFn(
          "gate",
          `export default function (input, { reject }) { if (input.score > 100) reject(${JSON.stringify(MSG)}); return []; }`,
        ),
        opsFn(
          "chain_gate",
          `export default function (input, { reject }) { reject(${JSON.stringify(MSG_CHAIN)}); return []; }`,
        ),
        opsFn(
          "swallow",
          `export default function (input, { reject }) { try { reject(${JSON.stringify(MSG_SW)}); } catch (e) {} return []; }`,
        ),
        opsFn(
          "twice",
          `export default function (input, { reject }) { try { reject(${JSON.stringify(MSG_FIRST)}); } catch (e) {} reject(${JSON.stringify(MSG_SECOND)}); return []; }`,
        ),
        opsFn(
          "bounds",
          [
            "export default function (input, { reject }) {",
            '  if (input.kind === "empty") reject("");',
            '  if (input.kind === "long") reject("あ".repeat(201));',
            '  if (input.kind === "num") reject(42);',
            '  if (input.kind === "none") reject();',
            '  if (input.kind === "len200") reject("あ".repeat(200));',
            '  if (input.kind === "emoji200") reject("😀".repeat(200));',
            '  if (input.kind === "emoji201") reject("😀".repeat(201));',
            "  return [];",
            "}",
          ].join("\n"),
        ),
        opsFn(
          "timeout",
          `export default function (input, { reject }) { try { reject(${JSON.stringify(MSG_TO)}); } catch (e) {} while (true) {} }`,
        ),
        opsFn(
          "big",
          `export default function (input, { reject }) { try { reject(${JSON.stringify(MSG_OUT)}); } catch (e) {} return [{ op: "create", table: "logs", values: { v: "x".repeat(1100000) } }]; }`,
        ),
        opsFn(
          "memory",
          `export default function (input, { reject }) { try { reject(${JSON.stringify(MSG_MEM)}); } catch (e) {} const a = []; while (true) { a.push("y".repeat(1000000) + a.length); } }`,
        ),
        opsFn(
          "thrower",
          `export default function () { throw new Error(${JSON.stringify(SECRET)}); }`,
        ),
        opsFn(
          "mix_reject",
          `export default function (input, { reject }) { reject(${JSON.stringify(MSG_MIX)}); return []; }`,
        ),
        opsFn(
          "seq_reject",
          `export default function (input, { reject }) { reject(${JSON.stringify(MSG_SEQ)}); return []; }`,
        ),
        opsFn(
          "man_reject",
          `export default function (input, { reject }) { reject(${JSON.stringify(MSG_MAN)}); return []; }`,
        ),
        {
          id: "sched_reject",
          name: "sched_reject",
          code: `export default function (input, { reject }) { reject(${JSON.stringify(MSG_SCHED)}); return []; }`,
          input: { source: "table", table: "slog" },
          output: { ops: true },
        },
        argcFn("argc_plain", "export default function () { return [{ n: arguments.length }]; }"),
        argcFn(
          "argc_spelled",
          'export default function () { const note = "reject"; return [{ n: arguments.length }]; }',
        ),
        argcFn(
          "argc_boundary",
          "export default function () { const rejected = 1; const unreject = 2; const reject_x = 3; return [{ n: arguments.length }]; }",
        ),
      ],
      workflows: [
        onCreate("wf_gate_c", "scores", [run("gate")]),
        {
          id: "wf_gate_u",
          name: "wf_gate_u",
          trigger: { type: "on_update", table: "scores" },
          history_table: "wf_log",
          actions: [run("gate")],
        },
        onCreate("wf_c1", "c1", [
          { action: "create_record", table: "c2", values: { v: "$record.v" } },
        ]),
        onCreate("wf_c2", "c2", [
          { action: "create_record", table: "c3", values: { v: "$record.v" } },
        ]),
        onCreate("wf_c3", "c3", [run("chain_gate")]),
        onCreate("wf_sw", "sw", [run("swallow")]),
        onCreate("wf_tw", "tw", [run("twice")]),
        onCreate("wf_inv", "inv", [run("bounds")]),
        onCreate("wf_to", "to", [run("timeout")]),
        onCreate("wf_big", "big", [run("big")]),
        onCreate("wf_mem", "mem", [run("memory")]),
        onCreate("wf_thr", "thr", [run("thrower")]),
        onCreate("wf_mix", "mix", [run("thrower"), run("mix_reject")]),
        onCreate("wf_seq", "seq", [run("seq_reject"), FAILING_CREATE]),
        onCreate("wf_seq_gen", "seq_gen", [run("thrower"), FAILING_CREATE]),
        onCreate("wf_argc0", "argc0", [
          { action: "run_function", function: "argc_plain", write_back: "$record" },
        ]),
        onCreate("wf_argc1", "argc1", [
          { action: "run_function", function: "argc_spelled", write_back: "$record" },
        ]),
        onCreate("wf_argc2", "argc2", [
          { action: "run_function", function: "argc_boundary", write_back: "$record" },
        ]),
        {
          id: "wf_manual",
          name: "ボタンの処理",
          trigger: { type: "manual", table: "mtrig" },
          history_table: "wf_log",
          actions: [
            { action: "create_record", table: "mlog", values: { v: "before" } },
            run("man_reject"),
            { action: "create_record", table: "mlog", values: { v: "after" } },
          ],
        },
        {
          id: "wf_sched",
          name: "夜の処理",
          trigger: { type: "schedule", at: { hour: 3, minute: 0 } },
          history_table: "wf_log",
          actions: [
            run("sched_reject"),
            { action: "create_record", table: "slog", values: { v: "after" } },
          ],
        },
        {
          id: "wf_sched_chain",
          name: "夜の連鎖の処理",
          trigger: { type: "schedule", at: { hour: 4, minute: 0 } },
          history_table: "wf_log",
          actions: [
            { action: "create_record", table: "c3", values: { v: "s" } },
            { action: "create_record", table: "sc_log", values: { v: "after" } },
          ],
        },
        {
          id: "wf_manual_chain",
          name: "ボタンの連鎖の処理",
          trigger: { type: "manual", table: "mc_trig" },
          history_table: "wf_log",
          actions: [
            { action: "create_record", table: "c3", values: { v: "m" } },
            { action: "create_record", table: "mc_log", values: { v: "after" } },
          ],
        },
        onCreate("wf_oc_chain", "oc_trig", [
          { action: "create_record", table: "c3", values: { v: "$record.v" } },
          FAILING_CREATE,
        ]),
        {
          id: "wf_ou_chain",
          name: "wf_ou_chain",
          trigger: { type: "on_update", table: "ou_trig" },
          history_table: "wf_log",
          actions: [
            { action: "create_record", table: "c3", values: { v: "$record.v" } },
            FAILING_CREATE,
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
  cookie: string;
  inb: string;
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

async function makeRig(): Promise<Rig> {
  const dataRoot = await mkdtemp(join(tmpdir(), "gp-island-reject-"));
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, "島の断り", { app_id: APP_ID });
  } finally {
    meta.close();
  }
  const m = manifest();
  const applied = applyManifest(dataRoot, APP_ID, m);
  if (!applied.valid) {
    throw new Error(JSON.stringify(applied.errors));
  }
  process.env[KEY_ENV_VAR] = SIGNING_KEY;
  const inbound = InboundStore.openForKernel(dataRoot);
  let inb: string;
  try {
    inb = inbound.issueInboundEndpoint({
      appId: APP_ID,
      name: "psp",
      secretSource: { kind: "env", value: KEY_ENV_VAR },
      targetTable: "scores",
    }).id;
  } finally {
    inbound.close();
  }
  const cookie = seedSession(dataRoot, APP_ID, { role: "owner", username: "owner1" }).cookie;
  const rig: Rig = { dataRoot, manifest: m, server: createServerApp({ dataRoot }), cookie, inb };
  rigs.push(rig);
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
  const client = new Client({ name: "t04", version: "0.0.0" });
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

function withDb<T>(rig: Rig, runner: (db: Database) => T): T {
  const db = new Database(appDbPath(rig.dataRoot, APP_ID));
  try {
    return runner(db);
  } finally {
    db.close();
  }
}

function rowsOf(rig: Rig, table: string): Record<string, unknown>[] {
  return withDb(rig, (db) =>
    db.query<Record<string, unknown>, []>(`SELECT * FROM "${table}"`).all(),
  );
}

function history(rig: Rig): { workflow: string; status: string; error: string }[] {
  return rowsOf(rig, "wf_log").map((row) => ({
    workflow: String(row.workflow ?? ""),
    status: String(row.status ?? ""),
    error: String(row.error ?? ""),
  }));
}

function historyOf(rig: Rig, workflow: string): { status: string; error: string }[] {
  return history(rig).filter((row) => row.workflow === workflow);
}

function rowOf(rig: Rig, table: string, id: string): Record<string, unknown> {
  const row = rowsOf(rig, table).find((r) => r._id === id);
  if (row === undefined) {
    throw new Error(`${table} に ${id} の行が無い`);
  }
  return row;
}

type ErrorItem = { path: string; message: string; hint?: string };
type Body = { kind?: string; errors: ErrorItem[] };

const REJECTED = (message: string, path = ""): Body => ({
  kind: "app_rejected",
  errors: [{ path, message }],
});

describe("V23-M2-T04 綴りのある島にだけ第2引数が渡る(D-V23-60)", () => {
  test("(a-plain) 陰性対照: 綴りの無い島は今日どおり引数1つ", async () => {
    const rig = await makeRig();
    const id = await mustCreate(rig, "argc0", { v: "x" });
    expect(rowOf(rig, "argc0", id).n).toBe(1);
  });

  test("(a-spelled) 綴りのある島は引数2つ(文字列の中の綴りも語として数える)", async () => {
    const rig = await makeRig();
    const id = await mustCreate(rig, "argc1", { v: "x" });
    expect(rowOf(rig, "argc1", id).n).toBe(2);
  });

  test("(a-boundary) 語の境界の外の綴り(rejected・unreject・reject_x)は数えない", async () => {
    const rig = await makeRig();
    const id = await mustCreate(rig, "argc2", { v: "x" });
    expect(rowOf(rig, "argc2", id).n).toBe(1);
  });

  test("(a-pass) 断らない入力なら今日どおり 201", async () => {
    const rig = await makeRig();
    const res = await post(rig, "scores", { score: 50 });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(rowsOf(rig, "scores")).toHaveLength(1);
  });
});

describe("V23-M2-T04 HTTP の入口", () => {
  test("(h-post) 単件 POST の on_create: 422・kind・path は空・文言そのまま。行は無い", async () => {
    const rig = await makeRig();
    const res = await post(rig, "scores", { score: 200 });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body).toEqual(REJECTED(MSG));
    expect(rowsOf(rig, "scores")).toHaveLength(0);
  });

  test("(h-patch) PATCH の on_update: 422 と文言。行は変わらない", async () => {
    const rig = await makeRig();
    const id = await mustCreate(rig, "scores", { score: 10, memo: "前" });
    const before = rowOf(rig, "scores", id);
    const res = await send(
      rig,
      "PATCH",
      `/api/apps/${APP_ID}/tables/scores/records/${id}`,
      { score: 300, memo: "後" },
      { "if-match": String(before._updated_at) },
    );
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body).toEqual(REJECTED(MSG));
    const after = rowOf(rig, "scores", id);
    expect(after.score).toBe(10);
    expect(after.memo).toBe("前");
  });

  test("(h-batch) まとめ書き: 422 と文言(path は /ops/N)。1件も書かない", async () => {
    const rig = await makeRig();
    const res = await send(rig, "POST", `/api/apps/${APP_ID}/batch`, {
      ops: [
        { op: "create", table: "scores", values: { score: 50 } },
        { op: "create", table: "scores", values: { score: 200 } },
      ],
    });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body).toEqual(REJECTED(MSG, "/ops/1"));
    expect(rowsOf(rig, "scores")).toHaveLength(0);
  });

  test("(h-inbound) 受信口: 吸収せず 422 と文言。行は無い", async () => {
    const rig = await makeRig();
    const res = await postInbound(rig, rig.inb, { score: 200 });
    const body = (await res.json()) as Body & { idempotent?: boolean };
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body.idempotent).toBeUndefined();
    expect(body).toEqual(REJECTED(MSG));
    expect(rowsOf(rig, "scores")).toHaveLength(0);
  });
});

describe("V23-M2-T04 MCP の道具", () => {
  test("(m-write) write_records: isError で文言。行は無い", async () => {
    const rig = await makeRig();
    const result = await mcpCall(rig, "write_records", {
      ops: [{ op: "create", table: "scores", values: { score: 200 } }],
    });
    expect(result.isError).toBe(true);
    expect(mcpText(result)).toContain(MSG);
    expect(rowsOf(rig, "scores")).toHaveLength(0);
  });

  test("(m-update) update_record: isError で文言。行は変わらない", async () => {
    const rig = await makeRig();
    const id = await mustCreate(rig, "scores", { score: 10 });
    const before = rowOf(rig, "scores", id);
    const result = await mcpCall(rig, "update_record", {
      table_id: "scores",
      record_id: id,
      if_match: String(before._updated_at),
      changes: { score: 500 },
    });
    expect(result.isError).toBe(true);
    expect(mcpText(result)).toContain(MSG);
    expect(rowOf(rig, "scores", id).score).toBe(10);
  });

  test("(m-sample) insert_sample_data: failed[].errors に path 空と文言(他の行は残る)", async () => {
    const rig = await makeRig();
    const result = await mcpCall(rig, "insert_sample_data", {
      table_id: "scores",
      rows: [{ score: 5 }, { score: 200 }],
    });
    expect(result.isError ?? false).toBe(false);
    const parsed = JSON.parse(mcpText(result)) as {
      failed: { index: number; errors: ErrorItem[] }[];
    };
    expect(parsed.failed).toEqual([{ index: 1, errors: [{ path: "", message: MSG }] }]);
    expect(rowsOf(rig, "scores").map((row) => row.score)).toEqual([5]);
  });
});

describe("V23-M2-T04 連鎖の奥の断り(D-V23-44・D-V23-52)", () => {
  test("(c-2) 2段: 二段目の作成で三段目の島が断ると、errors[0].message が島に渡した文字列と完全一致し、全部戻る", async () => {
    const rig = await makeRig();
    const res = await post(rig, "c2", { v: "x" });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body.errors[0]?.message).toBe(MSG_CHAIN);
    expect(body).toEqual(REJECTED(MSG_CHAIN));
    expect(rowsOf(rig, "c2")).toHaveLength(0);
    expect(rowsOf(rig, "c3")).toHaveLength(0);
  });

  test("(c-3) 3段: 一段目から三段目まで連なっても最初の文言そのまま・全部戻る", async () => {
    const rig = await makeRig();
    const res = await post(rig, "c1", { v: "x" });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body.errors[0]?.message).toBe(MSG_CHAIN);
    expect(body).toEqual(REJECTED(MSG_CHAIN));
    expect(rowsOf(rig, "c1")).toHaveLength(0);
    expect(rowsOf(rig, "c2")).toHaveLength(0);
    expect(rowsOf(rig, "c3")).toHaveLength(0);
  });
});

describe("V23-M2-T04 島の中の振る舞い(D-V23-43・D-V23-56)", () => {
  test("(s-swallow) 島が例外を握りつぶして値を返しても断り", async () => {
    const rig = await makeRig();
    const res = await post(rig, "sw", { v: "x" });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body).toEqual(REJECTED(MSG_SW));
    expect(rowsOf(rig, "sw")).toHaveLength(0);
  });

  test("(s-twice) 2回呼ぶと1回目の文言", async () => {
    const rig = await makeRig();
    const res = await post(rig, "tw", { v: "x" });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body).toEqual(REJECTED(MSG_FIRST));
  });

  test("(s-timeout) 断った後の時間切れより断りが勝つ", async () => {
    const rig = await makeRig();
    const res = await post(rig, "to", { v: "x" });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body).toEqual(REJECTED(MSG_TO));
  });

  test("(s-output) 断った後の出力超過より断りが勝つ", async () => {
    const rig = await makeRig();
    const res = await post(rig, "big", { v: "x" });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body).toEqual(REJECTED(MSG_OUT));
  });

  test("(s-memory) 断った後のメモリ超過より断りが勝つ", async () => {
    const rig = await makeRig();
    const res = await post(rig, "mem", { v: "x" });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body).toEqual(REJECTED(MSG_MEM));
  });

  for (const kind of ["empty", "long", "num", "none", "emoji201"]) {
    test(`(s-invalid-${kind}) 文言が文字列でない・1〜200 コードポイントの外なら汎用の失敗(今日の 400。kind なし)`, async () => {
      const rig = await makeRig();
      const res = await post(rig, "inv", { kind });
      const text = await res.text();
      expect(res.status, text).toBe(400);
      const body = JSON.parse(text) as Body;
      expect(body.kind).toBeUndefined();
      expect(text).not.toContain("あああ");
      expect(text).not.toContain("😀");
      expect(text).not.toContain(HISTORY_PREFIX);
      expect(rowsOf(rig, "inv")).toHaveLength(0);
      const rows = historyOf(rig, "wf_inv");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("failure");
      expect(rows[0]?.error).not.toContain(HISTORY_PREFIX);
    });
  }

  test("(s-len200) 200 文字ちょうどは通る(422 と文言)", async () => {
    const rig = await makeRig();
    const res = await post(rig, "inv", { kind: "len200" });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body).toEqual(REJECTED("あ".repeat(200)));
  });

  test("(s-emoji200) サロゲートペアの 200 コードポイント(400 UTF-16 単位)は通る", async () => {
    const rig = await makeRig();
    const res = await post(rig, "inv", { kind: "emoji200" });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body).toEqual(REJECTED("😀".repeat(200)));
  });

  test("(s-throw) reject 以外の例外は今日どおり本文を捨てる(400。応答にも履歴にも本文が無い)", async () => {
    const rig = await makeRig();
    const res = await post(rig, "thr", { v: "x" });
    const text = await res.text();
    expect(res.status, text).toBe(400);
    expect(text).not.toContain(SECRET);
    expect((JSON.parse(text) as Body).kind).toBeUndefined();
    const rows = historyOf(rig, "wf_thr");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failure");
    expect(rows[0]?.error).not.toContain(SECRET);
    expect(rows[0]?.error).toContain("(error)");
  });
});

describe("V23-M2-T04 後続のアクションと混ざったとき(D-V23-51・D-V23-53)", () => {
  test("(q-stop) on_create: reject の後のアクションは動かない(履歴に2つ目の失敗が無い)", async () => {
    const rig = await makeRig();
    const res = await post(rig, "seq", { v: "x" });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body).toEqual(REJECTED(MSG_SEQ));
    const rows = historyOf(rig, "wf_seq");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.error).toContain(`${HISTORY_PREFIX}${MSG_SEQ}`);
    expect(rows[0]?.error).not.toContain("アクション2");
  });

  test("(q-generic) 陰性対照: reject 以外の失敗では今日どおり後続も動く(履歴に2つ目の失敗がある)", async () => {
    const rig = await makeRig();
    const res = await post(rig, "seq_gen", { v: "x" });
    expect(res.status, await res.clone().text()).toBe(400);
    const rows = historyOf(rig, "wf_seq_gen");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.error).toContain("アクション1");
    expect(rows[0]?.error).toContain("アクション2");
  });

  test("(q-mix) 汎用の失敗の後に reject が来ても 422 と断りの文言", async () => {
    const rig = await makeRig();
    const res = await post(rig, "mix", { v: "x" });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body).toEqual(REJECTED(MSG_MIX));
    expect(rowsOf(rig, "mix")).toHaveLength(0);
  });
});

describe("V23-M2-T04 履歴・手動起動・時刻起動(D-V23-42・D-V23-45)", () => {
  test("(r-create) on_create の履歴: status は failure、error 列に前置きと文言(巻き戻しの後も残る)", async () => {
    const rig = await makeRig();
    await post(rig, "scores", { score: 200 });
    const rows = historyOf(rig, "wf_gate_c");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failure");
    expect(rows[0]?.error).toContain(`${HISTORY_PREFIX}${MSG}`);
  });

  test("(r-manual) 手動起動: 200・済んだ書込は残り・後のアクションは動かず・failures と履歴に前置きと文言", async () => {
    const rig = await makeRig();
    const trigger = await mustCreate(rig, "mtrig", { v: "x" });
    const res = await send(
      rig,
      "POST",
      `/api/apps/${APP_ID}/views/mlist/actions/run?workflow=wf_manual&record=${trigger}`,
    );
    const body = (await res.json()) as { failures?: string[] };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect((body.failures ?? []).join("\n")).toContain(`${HISTORY_PREFIX}${MSG_MAN}`);
    expect(rowsOf(rig, "mlog").map((row) => row.v)).toEqual(["before"]);
    const rows = historyOf(rig, "wf_manual");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failure");
    expect(rows[0]?.error).toContain(`${HISTORY_PREFIX}${MSG_MAN}`);
  });

  test("(r-schedule) 時刻起動: 汎用の失敗(文言も前置きも履歴に残らない)", async () => {
    const rig = await makeRig();
    withDb(rig, (db) => {
      const workflow = (rig.manifest.app.workflows ?? []).find((w) => w.id === "wf_sched");
      runScheduledWorkflow(db, rig.manifest, workflow as never);
    });
    const rows = historyOf(rig, "wf_sched");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failure");
    expect(rows[0]?.error).not.toContain(MSG_SCHED);
    expect(rows[0]?.error).not.toContain(HISTORY_PREFIX);
    expect(rows[0]?.error).toContain("詳細は履歴に残していません");
  });

  // **【`D-V23-66`】時刻起動の reject は汎用の失敗であり、同じワークフローの後続のアクションは
  // 今日どおり動く**(`D-V23-51` の止めは手動起動と `on_create`・`on_update` だけ)。
  test("(r-schedule-next) 時刻起動: reject の後のアクションも今日どおり動く(D-V23-66)", async () => {
    const rig = await makeRig();
    withDb(rig, (db) => {
      const workflow = (rig.manifest.app.workflows ?? []).find((w) => w.id === "wf_sched");
      runScheduledWorkflow(db, rig.manifest, workflow as never);
    });
    expect(rowsOf(rig, "slog").map((row) => row.v)).toEqual(["after"]);
    const rows = historyOf(rig, "wf_sched");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failure");
  });
});

// =============================================================================================
// 【`V23-M2-T11` / `D-V23-72`】時刻起動のアクションが書いた行の先(連鎖)で島が断っても、時刻起動の
// 後続のアクションは止めない(その書込が戻るだけ)。 手動起動と `on_create`・`on_update` は、連鎖の
// 奥の断りでも今日どおり後続を止める。
// =============================================================================================
describe("V23-M2-T11 連鎖の奥の断りと後続のアクション(D-V23-72)", () => {
  test("(sc-1) 時刻起動: アクション1が作った行の先で島が断っても、アクション2は動く(その書込だけが戻る)", async () => {
    const rig = await makeRig();
    withDb(rig, (db) => {
      const workflow = (rig.manifest.app.workflows ?? []).find((w) => w.id === "wf_sched_chain");
      runScheduledWorkflow(db, rig.manifest, workflow as never);
    });
    // 断られた作成は戻り、後続の作成は書かれている。
    expect(rowsOf(rig, "c3")).toHaveLength(0);
    expect(rowsOf(rig, "sc_log").map((row) => row.v)).toEqual(["after"]);
    // 時刻起動の履歴には、アクション1の失敗として残る(アクション2は成功したので失敗に無い)。
    const rows = historyOf(rig, "wf_sched_chain");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failure");
    expect(rows[0]?.error).toContain("アクション1");
    expect(rows[0]?.error).not.toContain("アクション2");
    // 連鎖の奥の作成の自動処理の履歴には、前置きと文言が残る(作者の固定文)。
    const inner = historyOf(rig, "wf_c3");
    expect(inner).toHaveLength(1);
    expect(inner[0]?.error).toContain(`${HISTORY_PREFIX}${MSG_CHAIN}`);
  });

  test("(sc-2) 手動起動: 連鎖の奥の断りで後続は止まる(今日どおり)", async () => {
    const rig = await makeRig();
    const trigger = await mustCreate(rig, "mc_trig", { v: "x" });
    const res = await send(
      rig,
      "POST",
      `/api/apps/${APP_ID}/views/mclist/actions/run?workflow=wf_manual_chain&record=${trigger}`,
    );
    const body = (await res.json()) as { failures?: string[] };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect((body.failures ?? []).join("\n")).toContain("アクション1");
    expect(rowsOf(rig, "c3")).toHaveLength(0);
    expect(rowsOf(rig, "mc_log")).toHaveLength(0);
  });

  test("(sc-3) on_create: 連鎖の奥の断りで後続は止まる(今日どおり。履歴に2つ目の失敗が無い)", async () => {
    const rig = await makeRig();
    const res = await post(rig, "oc_trig", { v: "x" });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body).toEqual(REJECTED(MSG_CHAIN));
    const rows = historyOf(rig, "wf_oc_chain");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.error).toContain("アクション1");
    expect(rows[0]?.error).not.toContain("アクション2");
  });

  test("(sc-4) on_update: 連鎖の奥の断りで後続は止まる(今日どおり。履歴に2つ目の失敗が無い)", async () => {
    const rig = await makeRig();
    const id = await mustCreate(rig, "ou_trig", { v: "前" });
    const before = rowOf(rig, "ou_trig", id);
    const res = await send(
      rig,
      "PATCH",
      `/api/apps/${APP_ID}/tables/ou_trig/records/${id}`,
      { v: "後" },
      { "if-match": String(before._updated_at) },
    );
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body).toEqual(REJECTED(MSG_CHAIN));
    expect(rowOf(rig, "ou_trig", id).v).toBe("前");
    const rows = historyOf(rig, "wf_ou_chain");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.error).toContain("アクション1");
    expect(rows[0]?.error).not.toContain("アクション2");
  });
});
