/**
 * **行を相手にした付与の書込 —— 相手の行を指す欄は、招待の承諾の外では書けない**
 * (`V23-M6-T04`。門A = `ADR-0502`(`SC-G20`)を補う `ADR-0538` §Decision 1-4。
 * 決定 `D-V23-145`・`D-V23-152`・`D-V23-162`〜`D-V23-164`・`D-V23-173`。授権 `ADR-0539`)。
 *
 * ## この検査が測るもの / 測らないもの(**先に書く**)
 *
 * **題材**: 名簿1本を共有する部隊(S。`units`)と案件(R。`projects`)と作業(R の子。`tasks`)。 案件の付与表
 * `project_grants` と作業の付与表 `task_grants` の `unit` 列が部隊の行を指す(`principal_row`。`via` は `unit_member`)。
 *
 * **測るもの**:
 * 1. **入口ごとに1本**: 相手の欄に値が新しく入る・値が変わる書込を断る。 画面の口(単件の作成・`PATCH`・一括)/
 *    MCP(`write_records`・`insert_sample_data`・`update_record`)/ 受信口 / 自動処理(アクションの作成と更新・時刻起動・
 *    手動起動・島の `write_ops`・`output_table` の全置換・書き戻し)/ AI の書き戻し。 断られた書込は1バイトも残らない。
 * 2. **今日どおり通すもの**(`D-V23-164`): 相手の欄だけを持つ行の権限の欄の変更(相手の欄は変わらない)/ 行の削除。
 *    そのとき、書く人が S に `via` を持てば「自分に付けられない」で断り、親の読取の検査は S に `via` を持つ人に落とす。
 * 3. **両方の欄**: 相手の欄と `member` を同じ行に持つ形は作れない。
 * 4. **陰性対照**: `principal_row` を書かないアプリでは、同じ書込の答えが今日と同じ。
 * 5. **判定の家の述語**(`owner-scope.ts` の export 1本)の形と、承諾の器が渡す抜け道(`T06` で使う)。
 *
 * **測らないもの(誇張しない)**: コードとコードの招待の承諾そのもの(`T05`・`T06`)。 相手の名前の見せ方(`T04b`)。
 * 生成器(`T09`)。 画面(`T06b`)。 undo・redo で行が戻ること(断らない側。この段では触っていない)。
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AiCapabilityStore } from "../kernel/ai-capability-store.ts";
import { dispatchAiJobs } from "../kernel/ai-dispatcher.ts";
import type { AiProvider } from "../kernel/ai-provider.ts";
import { InboundStore } from "../kernel/inbound-store.ts";
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
import * as ownerScope from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN } from "./test-helpers.ts";

const APP_ID = "pr-write";
const ALL = ["read", "write", "delete"];
const SIGNING_KEY = "test-principal-row-write-key";
const KEY_ENV_VAR = "ST_TEST_PRINCIPAL_ROW_WRITE_KEY";

/** 画面の口・MCP・受信口が返す断りの文(人の操作)。 */
const LOCKED_MESSAGE = "相手の行を指す欄は、招待の承諾でだけ書けます。";
/** 相手の欄と利用者の欄を同じ行に書こうとしたときの文。 */
const MIXED_MESSAGE = "相手の行を指す欄と、利用者やグループの欄を、同じ行に書くことはできません。";
/** 自動処理・AI の書き戻しの履歴に残る断りの文の一部。 */
const AUTOMATION_MARK = "相手の行を指す欄に書き込むため断りました";
const SELF_MESSAGE = "自分に権限を付けることはできません。";
const PARENT_MESSAGE =
  "この相手は、元になっている行を見る権限を持っていないため、ここには追加できません。";

type Wf =
  | "act"
  | "act_ok"
  | "upd"
  | "upd_ok"
  | "sched"
  | "manual"
  | "isl"
  | "isl_ok"
  | "replace"
  | "wb"
  | "ai"
  | "upd_target"
  | "isl_target"
  | "manual_title";

const TABLES = [
  "members",
  "units",
  "unit_grants",
  "projects",
  "project_grants",
  "tasks",
  "task_grants",
  "cmds",
  "wf_log",
];

const ref = (id: string, table: string) => ({
  id,
  name: id,
  type: "reference",
  reference_table: table,
});

const UPDATE_UNIT = {
  action: "update_record",
  table: "project_grants",
  target: "$record.gtarget",
  values: { unit: "$record.gunit" },
};

function workflows(wfs: readonly Wf[]): unknown[] {
  const onCmd = (id: string, actions: unknown[]) => ({
    id,
    name: id,
    trigger: { type: "on_create", table: "cmds" },
    history_table: "wf_log",
    actions,
  });
  const all: Record<Wf, unknown> = {
    act: onCmd("wf_act", [
      {
        action: "create_record",
        table: "project_grants",
        values: { project: "$record.gproject", unit: "$record.gunit", permission: "p_worker" },
      },
    ]),
    act_ok: onCmd("wf_act_ok", [
      {
        action: "create_record",
        table: "project_grants",
        values: { project: "$record.gproject", member: "$record.gmember", permission: "p_worker" },
      },
    ]),
    upd: onCmd("wf_upd", [UPDATE_UNIT]),
    upd_ok: onCmd("wf_upd_ok", [
      {
        action: "update_record",
        table: "project_grants",
        target: "$record.gtarget",
        values: { permission: "p_admin" },
      },
    ]),
    // 【独立点検の処置(重2)】守る行(target)の付け替え。
    upd_target: onCmd("wf_upd_target", [
      {
        action: "update_record",
        table: "project_grants",
        target: "$record.gtarget",
        values: { project: "$record.gproject" },
      },
    ]),
    isl_target: onCmd("wf_isl_target", [
      { action: "run_function", function: "isl_move", write_ops: true },
    ]),
    sched: {
      id: "wf_sched",
      name: "夜間に付け替える",
      trigger: { type: "schedule", at: { hour: 3, minute: 0 }, table: "cmds" },
      history_table: "wf_log",
      actions: [UPDATE_UNIT],
    },
    manual: {
      id: "wf_manual",
      name: "ボタンで付け替える",
      trigger: { type: "manual", table: "cmds" },
      history_table: "wf_log",
      actions: [UPDATE_UNIT],
    },
    // D-V23-259: 押した人を書き手にして案件そのものを書き換えるボタン(相手の行を通じた権限を数える側)。
    manual_title: {
      id: "wf_manual_title",
      name: "ボタンで案件を書き換える",
      trigger: { type: "manual", table: "cmds" },
      history_table: "wf_log",
      actions: [
        {
          action: "update_record",
          table: "projects",
          target: "$record.gproject",
          values: { title: "ボタン" },
        },
      ],
    },
    isl: onCmd("wf_isl", [{ action: "run_function", function: "isl_create", write_ops: true }]),
    isl_ok: onCmd("wf_isl_ok", [{ action: "run_function", function: "isl_perm", write_ops: true }]),
    replace: onCmd("wf_replace", [
      { action: "run_function", function: "replace_grants", output_table: "project_grants" },
    ]),
    wb: {
      id: "wf_wb",
      name: "書き戻しで相手を入れる",
      trigger: { type: "on_update", table: "project_grants" },
      history_table: "wf_log",
      actions: [{ action: "run_function", function: "wb_unit", write_back: "$record" }],
    },
    ai: {
      id: "wf_ai",
      name: "AI が相手を決める",
      trigger: { type: "on_update", table: "project_grants" },
      history_table: "wf_log",
      actions: [
        {
          action: "ai_transform",
          capability: "classifier",
          prompt: "相手を決めてください。",
          input: { memo: "$record.memo" },
          output_field: "unit",
          fallback: "no-such-unit",
        },
      ],
    },
  };
  return wfs.map((wf) => all[wf]);
}

type ManifestOptions = {
  principalRow?: boolean;
  wfs?: readonly Wf[];
  /** D-V23-259: 担当の役割の規則で案件(`projects`)を読むだけにする(書けるかを点だけで決める)。 */
  staffProjectsReadOnly?: boolean;
};

function manifest(options: ManifestOptions = {}): Manifest {
  const principal = options.principalRow !== false;
  const wfs = options.wfs ?? [];
  const buttons = [
    ...(wfs.includes("manual") ? [{ id: "move", run: "wf_manual", name: "付け替える" }] : []),
    ...(wfs.includes("manual_title")
      ? [{ id: "retitle", run: "wf_manual_title", name: "書き換える" }]
      : []),
  ];
  const viewRules =
    buttons.length > 0
      ? [
          { target: "view", view: "cmd_list", can: ["read"] },
          ...buttons.map((button) => ({
            target: "action",
            view: "cmd_list",
            action: button.id,
            can: ["read"],
          })),
        ]
      : [];
  const rules = (can: string[]) => [
    ...TABLES.map((table) => ({ target: "table", table, can })),
    ...viewRules,
  ];
  const staffRules = options.staffProjectsReadOnly
    ? rules(ALL).map((rule) =>
        rule.target === "table" && "table" in rule && rule.table === "projects"
          ? { ...rule, can: ["read"] }
          : rule,
      )
    : rules(ALL);
  return {
    app: {
      id: APP_ID,
      name: "行を相手にした付与の書込",
      tables: [
        {
          id: "members",
          name: "名簿",
          representative_field: "name",
          fields: [
            { id: "name", name: "名前", type: "text", required: true },
            { id: "account", name: "利用者ID", type: "text", required: true },
          ],
        },
        {
          id: "units",
          name: "部隊",
          representative_field: "title",
          fields: [{ id: "title", name: "名前", type: "text" }],
          access_control: {
            enabled: true,
            permissions: [
              { id: "unit_lead", name: "長", read: true, write: true, delete: true },
              { id: "unit_member", name: "所属", read: true, write: false, delete: false },
            ],
            creator_permission: "unit_lead",
            grant: {
              table: "unit_grants",
              target: "unit",
              member: "member",
              permission: "permission",
            },
            members: { table: "members", account: "account" },
          },
        },
        {
          id: "unit_grants",
          name: "部隊の付与",
          fields: [
            ref("unit", "units"),
            ref("member", "members"),
            {
              id: "permission",
              name: "権限",
              type: "select",
              options: ["unit_lead", "unit_member"],
            },
          ],
        },
        {
          id: "projects",
          name: "案件",
          representative_field: "title",
          fields: [{ id: "title", name: "名前", type: "text" }],
          access_control: {
            enabled: true,
            permissions: [
              { id: "p_admin", name: "管理", read: true, write: true, delete: true },
              { id: "p_worker", name: "担当", read: true, write: true, delete: true },
            ],
            creator_permission: "p_admin",
            grant: {
              table: "project_grants",
              target: "project",
              member: "member",
              permission: "permission",
              ...(principal
                ? { principal_row: { column: "unit", table: "units", via: ["unit_member"] } }
                : {}),
            },
            members: { table: "members", account: "account" },
          },
        },
        {
          id: "project_grants",
          name: "案件の付与",
          fields: [
            ref("project", "projects"),
            ref("member", "members"),
            ref("unit", "units"),
            { id: "permission", name: "権限", type: "select", options: ["p_admin", "p_worker"] },
            { id: "memo", name: "メモ", type: "text" },
            { id: "event_id", name: "受信の印", type: "text" },
          ],
        },
        {
          id: "tasks",
          name: "作業",
          fields: [{ id: "title", name: "名前", type: "text" }, ref("project", "projects")],
          access_control: {
            enabled: true,
            permissions: [
              { id: "t_admin", name: "管理", read: true, write: true, delete: true },
              { id: "p_worker", name: "担当", read: true, write: true, delete: false },
            ],
            creator_permission: "t_admin",
            grant: {
              table: "task_grants",
              target: "task",
              member: "member",
              permission: "permission",
              ...(principal
                ? { principal_row: { column: "unit", table: "units", via: ["unit_member"] } }
                : {}),
            },
            members: { table: "members", account: "account" },
            inherit_from: ["project"],
          },
        },
        {
          id: "task_grants",
          name: "作業の付与",
          fields: [
            ref("task", "tasks"),
            ref("member", "members"),
            ref("unit", "units"),
            { id: "permission", name: "権限", type: "select", options: ["t_admin", "p_worker"] },
          ],
        },
        {
          id: "cmds",
          name: "指示",
          fields: [
            { id: "title", name: "件名", type: "text" },
            ref("gproject", "projects"),
            ref("gunit", "units"),
            ref("gmember", "members"),
            ref("gtarget", "project_grants"),
            { id: "version", name: "版", type: "text" },
          ],
        },
        {
          id: "wf_log",
          name: "実行履歴",
          fields: [
            { id: "ran_at", name: "実行時刻", type: "date" },
            { id: "workflow", name: "ワークフロー", type: "text" },
            { id: "trigger_type", name: "起点", type: "text" },
            { id: "status", name: "結果", type: "text" },
            { id: "error", name: "詳細", type: "long_text" },
          ],
        },
      ],
      views:
        buttons.length > 0
          ? [
              {
                id: "cmd_list",
                type: "list_view",
                table: "cmds",
                columns: ["title"],
                actions: buttons,
              },
            ]
          : [],
      functions: [
        {
          id: "isl_create",
          name: "島が相手の行を相手にした付与を作る",
          code: 'export default function (record) { return [{ op: "create", table: "project_grants", values: { project: record.gproject, unit: record.gunit, permission: "p_worker" } }]; }',
          input: { source: "record" },
          output: { ops: true },
        },
        {
          id: "isl_perm",
          name: "島が権限の欄だけを変える",
          code: 'export default function (record) { return [{ op: "update", table: "project_grants", target: record.gtarget, if_match: record.version, values: { permission: "p_admin" } }]; }',
          input: { source: "record" },
          output: { ops: true },
        },
        {
          id: "isl_move",
          name: "島が守る行を付け替える",
          code: 'export default function (record) { return [{ op: "update", table: "project_grants", target: record.gtarget, if_match: record.version, values: { project: record.gproject } }]; }',
          input: { source: "record" },
          output: { ops: true },
        },
        {
          id: "replace_grants",
          name: "付与を作り直す",
          code: 'export default function (record) { return [{ project: record.gproject, unit: record.gunit, permission: "p_worker" }]; }',
          input: { source: "record" },
          output: {
            fields: [
              { id: "project", type: "reference" },
              { id: "unit", type: "reference" },
              { id: "permission", type: "select" },
            ],
          },
        },
        {
          id: "wb_unit",
          name: "書き戻しで相手を入れる",
          code: "export default function (record) { return [{ unit: record.memo }]; }",
          input: { source: "record" },
          output: { fields: [{ id: "unit", type: "reference" }] },
        },
      ],
      workflows: workflows(wfs),
      roles: [
        {
          id: "owner",
          name: "運営",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            ...rules(ALL),
          ],
        },
        { id: "staff", name: "担当", rules: staffRules },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
    },
  } as unknown as Manifest;
}

// =====================================================================================
// 台
// =====================================================================================

type Who = { cookie: string; userId: string; username: string };

let dataRoot: string | undefined;
let server: ReturnType<typeof createServerApp>;
let current: Manifest;
let admin: Who;
let expert: Who;
let operator: Who;
type Ids = Record<
  | "mAdmin"
  | "mExpert"
  | "mOut"
  | "unitA1"
  | "unitB1"
  | "p1"
  | "p2"
  | "rowA1P1"
  | "rowOutP1"
  | "t1"
  | "t2"
  | "rowA1T1"
  | "rowA1T2",
  string
>;
let ids = {} as Ids;
let inboundEndpoint = "";

function withDb<T>(run: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot as string, APP_ID));
  try {
    return run(db);
  } finally {
    db.close();
  }
}

/** カーネルを直接呼んで1行作る(判定の外側で台を組む)。 */
function put(table: string, values: Record<string, unknown>): string {
  return withDb((db) => {
    const created = createRecord(db, current, table, values);
    if (!created.ok) {
      throw new Error(`${table} に行を置けない: ${JSON.stringify(created.errors)}`);
    }
    return String(created.value._id);
  });
}

function rowsOf(table: string): Record<string, unknown>[] {
  return withDb((db) => db.query(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[]);
}

function rowOf(table: string, id: string): Record<string, unknown> | undefined {
  return rowsOf(table).find((row) => row._id === id);
}

function historyDetail(): string {
  return rowsOf("wf_log")
    .map((row) => `${String(row.status)}:${String(row.error)}`)
    .join(" | ");
}

/** 相手の欄に値のある案件の付与の行の数。 */
function principalGrantCount(): number {
  return rowsOf("project_grants").filter((row) => typeof row.unit === "string" && row.unit !== "")
    .length;
}

async function makeApp(options: ManifestOptions = {}) {
  const wfs = options.wfs ?? [];
  if (wfs.some((wf) => wf === "isl" || wf === "isl_ok" || wf === "replace" || wf === "wb")) {
    await ensureIslandRuntimeReady();
  }
  dataRoot = await mkdtemp(join(tmpdir(), "gp-pr-write-"));
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, "行を相手にした付与の書込", { app_id: APP_ID });
  } finally {
    meta.close();
  }
  current = manifest(options);
  const applied = applyManifest(dataRoot, APP_ID, current);
  if (!applied.valid) {
    throw new Error(JSON.stringify(applied.errors));
  }
  const seed = (username: string, role: string): Who => {
    const s = seedSession(dataRoot as string, APP_ID, { role, username });
    return { cookie: s.cookie, userId: s.userId, username };
  };
  admin = seed("admin1", "staff");
  expert = seed("expert1", "staff");
  operator = seed("operator1", "owner");
  const outsider = seed("outsider1", "staff");
  const mAdmin = put("members", { name: "管理者", account: admin.userId });
  const mExpert = put("members", { name: "専門家", account: expert.userId });
  const mOut = put("members", { name: "外の人", account: outsider.userId });
  const unitA1 = put("units", { title: "部隊A1" });
  const unitB1 = put("units", { title: "部隊B1" });
  put("unit_grants", { unit: unitA1, member: mExpert, permission: "unit_member" });
  const p1 = put("projects", { title: "案件1" });
  const p2 = put("projects", { title: "案件2" });
  for (const p of [p1, p2]) {
    put("project_grants", { project: p, member: mAdmin, permission: "p_admin" });
  }
  // 相手の欄だけを持つ行は、承諾の器が書く形(ここでは判定の外側で置く。陰性対照の台では、ただの参照の列)。
  const rowA1P1 = put("project_grants", { project: p1, unit: unitA1, permission: "p_worker" });
  const rowOutP1 = put("project_grants", { project: p1, member: mOut, permission: "p_worker" });
  const t1 = put("tasks", { title: "作業1", project: p1 });
  const t2 = put("tasks", { title: "作業2", project: p2 });
  for (const t of [t1, t2]) {
    put("task_grants", { task: t, member: mAdmin, permission: "t_admin" });
  }
  const rowA1T1 = put("task_grants", { task: t1, unit: unitA1, permission: "p_worker" });
  const rowA1T2 = put("task_grants", { task: t2, unit: unitA1, permission: "p_worker" });
  ids = {
    mAdmin,
    mExpert,
    mOut,
    unitA1,
    unitB1,
    p1,
    p2,
    rowA1P1,
    rowOutP1,
    t1,
    t2,
    rowA1T1,
    rowA1T2,
  };
  process.env[KEY_ENV_VAR] = SIGNING_KEY;
  const inbound = InboundStore.openForKernel(dataRoot);
  try {
    inboundEndpoint = inbound.issueInboundEndpoint({
      appId: APP_ID,
      name: "grants",
      secretSource: { kind: "env", value: KEY_ENV_VAR },
      targetTable: "project_grants",
    }).id;
  } finally {
    inbound.close();
  }
  server = createServerApp({ dataRoot });
}

afterEach(async () => {
  delete process.env[KEY_ENV_VAR];
  if (dataRoot !== undefined) {
    await rm(dataRoot, { recursive: true, force: true });
    dataRoot = undefined;
  }
});

type Sent = { status: number; text: string };

async function http(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  who: Who,
  options: { body?: unknown; ifMatch?: string } = {},
): Promise<Sent> {
  const headers: Record<string, string> = { cookie: who.cookie, origin: TEST_ORIGIN };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (options.ifMatch !== undefined) {
    headers["if-match"] = options.ifMatch;
  }
  const res = await server.request(
    new Request(`http://localhost/api/apps/${APP_ID}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
  return { status: res.status, text: await res.text() };
}

const RECORDS = (table: string) => `/tables/${table}/records`;

function versionOf(table: string, id: string): string {
  return String(rowOf(table, id)?._updated_at);
}

async function patch(who: Who, table: string, id: string, changes: Record<string, unknown>) {
  return await http("PATCH", `${RECORDS(table)}/${id}`, who, {
    body: changes,
    ifMatch: versionOf(table, id),
  });
}

async function mcp(
  who: Who,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const mcpServer = createMcpServer({
    dataRoot: dataRoot as string,
    previewBaseUrl: "http://127.0.0.1:3000",
    actor: who.username,
  });
  const client = new Client({ name: "t04", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);
  try {
    const result = (await client.callTool({
      name,
      arguments: { app_id: APP_ID, ...args },
    })) as CallToolResult;
    return { isError: result.isError === true, text: JSON.stringify(result.content) };
  } finally {
    await client.close();
    await mcpServer.close();
  }
}

async function postInbound(payload: Record<string, unknown>): Promise<Sent> {
  const rawBody = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", SIGNING_KEY).update(Buffer.from(rawBody, "utf-8")).digest("hex")}`;
  const res = await server.request(
    new Request(`http://localhost/inbound/${inboundEndpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Mock-PSP-Signature": signature },
      body: rawBody,
    }),
  );
  return { status: res.status, text: await res.text() };
}

/** きっかけの行を画面の口で作る(on_create の自動処理が同じ要求の中で走る)。 */
async function fire(values: Record<string, unknown>): Promise<Sent> {
  return await http("POST", RECORDS("cmds"), admin, { body: { title: "指示", ...values } });
}

// =====================================================================================
// (H) 画面の口
// =====================================================================================

describe("V23-M6-T04 (H) 画面の口", () => {
  test("(H-1) 単件の作成: 案件の管理者が相手の欄を埋めた付与を作ると 403、1行も増えない", async () => {
    await makeApp();
    const before = principalGrantCount();
    const sent = await http("POST", RECORDS("project_grants"), admin, {
      body: { project: ids.p2, unit: ids.unitA1, permission: "p_worker" },
    });
    expect(sent.status, sent.text).toBe(403);
    expect(sent.text).toContain(LOCKED_MESSAGE);
    expect(principalGrantCount()).toBe(before);
  });

  test("(H-2) 単件の作成: 運営でも 403(承諾の外では誰も書けない)", async () => {
    await makeApp();
    const before = principalGrantCount();
    const sent = await http("POST", RECORDS("project_grants"), operator, {
      body: { project: ids.p2, unit: ids.unitA1, permission: "p_worker" },
    });
    expect(sent.status, sent.text).toBe(403);
    expect(sent.text).toContain(LOCKED_MESSAGE);
    expect(principalGrantCount()).toBe(before);
  });

  test("(H-3) PATCH: 相手の欄を別の行に付け替えると 403、相手は変わらない", async () => {
    await makeApp();
    const sent = await patch(admin, "project_grants", ids.rowA1P1, { unit: ids.unitB1 });
    expect(sent.status, sent.text).toBe(403);
    expect(sent.text).toContain(LOCKED_MESSAGE);
    expect(rowOf("project_grants", ids.rowA1P1)?.unit).toBe(ids.unitA1);
  });

  test("(H-4) PATCH: 利用者を相手にした行に相手の欄を書き足すと 403、欄は空のまま", async () => {
    await makeApp();
    const sent = await patch(admin, "project_grants", ids.rowOutP1, { unit: ids.unitA1 });
    expect(sent.status, sent.text).toBe(403);
    expect(sent.text).toContain(LOCKED_MESSAGE);
    expect(rowOf("project_grants", ids.rowOutP1)?.unit ?? null).toBe(null);
  });

  test("(H-5) PATCH: 相手の欄を空にする(値が変わる)のも 403", async () => {
    await makeApp();
    const sent = await patch(admin, "project_grants", ids.rowA1P1, { unit: null });
    expect(sent.status, sent.text).toBe(403);
    expect(rowOf("project_grants", ids.rowA1P1)?.unit).toBe(ids.unitA1);
  });

  test("(H-6) 一括: 相手の欄を埋めた作成を含むと 403、1行も書かれない", async () => {
    await makeApp();
    const before = rowsOf("project_grants").length;
    const sent = await http("POST", "/batch", admin, {
      body: {
        ops: [
          {
            op: "create",
            table: "project_grants",
            values: { project: ids.p2, member: ids.mOut, permission: "p_worker" },
          },
          {
            op: "create",
            table: "project_grants",
            values: { project: ids.p2, unit: ids.unitA1, permission: "p_worker" },
          },
        ],
      },
    });
    expect(sent.status, sent.text).toBe(403);
    expect(sent.text).toContain(LOCKED_MESSAGE);
    expect(rowsOf("project_grants").length).toBe(before);
  });

  test("(H-7) 一括: 相手の欄の付け替えも 403", async () => {
    await makeApp();
    const sent = await http("POST", "/batch", admin, {
      body: {
        ops: [
          {
            op: "update",
            table: "project_grants",
            target: ids.rowA1P1,
            if_match: versionOf("project_grants", ids.rowA1P1),
            values: { unit: ids.unitB1 },
          },
        ],
      },
    });
    expect(sent.status, sent.text).toBe(403);
    expect(rowOf("project_grants", ids.rowA1P1)?.unit).toBe(ids.unitA1);
  });
});

// =====================================================================================
// (K) 今日どおり通すもの(`D-V23-164`)と、両方の欄
// =====================================================================================

describe("V23-M6-T04 (K) 権限の欄の変更・削除・両方の欄", () => {
  test("(K-1) 権限の変更が通る: 相手の欄だけを持つ行の権限の欄を、案件の管理者が変えられる(相手は変わらない)", async () => {
    await makeApp();
    const sent = await patch(admin, "project_grants", ids.rowA1P1, { permission: "p_admin" });
    expect(sent.status, sent.text).toBe(200);
    const row = rowOf("project_grants", ids.rowA1P1);
    expect(row?.permission).toBe("p_admin");
    expect(row?.unit).toBe(ids.unitA1);
  });

  test("(K-2) 権限の変更: 同じ値の相手の欄を送っても通る(値が変わらない)", async () => {
    await makeApp();
    const sent = await patch(admin, "project_grants", ids.rowA1P1, {
      unit: ids.unitA1,
      permission: "p_admin",
    });
    expect(sent.status, sent.text).toBe(200);
    expect(rowOf("project_grants", ids.rowA1P1)?.permission).toBe("p_admin");
  });

  test("(K-3) 削除は通る: 相手の欄だけを持つ行を案件の管理者が消せる", async () => {
    await makeApp();
    const sent = await http("DELETE", `${RECORDS("project_grants")}/${ids.rowA1P1}`, admin, {
      ifMatch: versionOf("project_grants", ids.rowA1P1),
    });
    expect([200, 204]).toContain(sent.status);
    expect(rowOf("project_grants", ids.rowA1P1)).toBeUndefined();
  });

  test("(K-4) 自分に付けられない: 書く人が相手の行に via を持てば、権限の変更は 403", async () => {
    await makeApp();
    // 専門家にも案件1の管理を直接渡す(作成者の関門を越えさせる)。
    put("project_grants", { project: ids.p1, member: ids.mExpert, permission: "p_admin" });
    const sent = await patch(expert, "project_grants", ids.rowA1P1, { permission: "p_admin" });
    expect(sent.status, sent.text).toBe(403);
    expect(sent.text).toContain(SELF_MESSAGE);
    expect(rowOf("project_grants", ids.rowA1P1)?.permission).toBe("p_worker");
  });

  test("(K-5) 親の読取の検査は相手の行に via を持つ人に落とす: 部隊の人が親の案件を読めなければ 403", async () => {
    await makeApp();
    // 作業2 の親は案件2。 部隊A1 は案件2 に付与を持たないので、専門家は案件2 を読めない。
    const sent = await patch(admin, "task_grants", ids.rowA1T2, { permission: "t_admin" });
    expect(sent.status, sent.text).toBe(403);
    expect(sent.text).toContain(PARENT_MESSAGE);
    expect(rowOf("task_grants", ids.rowA1T2)?.permission).toBe("p_worker");
  });

  test("(K-6) 陰性対照: 部隊の人が親の案件を読めれば(案件1 は部隊経由で読める)通る", async () => {
    await makeApp();
    const sent = await patch(admin, "task_grants", ids.rowA1T1, { permission: "t_admin" });
    expect(sent.status, sent.text).toBe(200);
    expect(rowOf("task_grants", ids.rowA1T1)?.permission).toBe("t_admin");
  });

  test("(K-7) 両方の欄: 相手の欄だけを持つ行に利用者を書き足すと 400、行は変わらない", async () => {
    await makeApp();
    const sent = await patch(admin, "project_grants", ids.rowA1P1, { member: ids.mOut });
    expect(sent.status, sent.text).toBe(400);
    expect(sent.text).toContain(MIXED_MESSAGE);
    expect(rowOf("project_grants", ids.rowA1P1)?.member ?? null).toBe(null);
  });

  test("(K-8) 両方の欄: 作成で両方を書いても(相手の欄が入るので)403、1行も増えない", async () => {
    await makeApp();
    const before = rowsOf("project_grants").length;
    const sent = await http("POST", RECORDS("project_grants"), admin, {
      body: { project: ids.p2, member: ids.mOut, unit: ids.unitA1, permission: "p_worker" },
    });
    expect(sent.status, sent.text).toBe(403);
    expect(rowsOf("project_grants").length).toBe(before);
  });
});

// =====================================================================================
// (M) MCP
// =====================================================================================

describe("V23-M6-T04 (M) MCP", () => {
  test("(M-1) write_records: 相手の欄を埋めた作成は断られ、1行も増えない", async () => {
    await makeApp();
    const before = rowsOf("project_grants").length;
    const result = await mcp(admin, "write_records", {
      ops: [
        {
          op: "create",
          table: "project_grants",
          values: { project: ids.p2, unit: ids.unitA1, permission: "p_worker" },
        },
      ],
    });
    expect(result.isError, result.text).toBe(true);
    expect(result.text).toContain(LOCKED_MESSAGE);
    expect(rowsOf("project_grants").length).toBe(before);
  });

  test("(M-2) insert_sample_data: 相手の欄を埋めた行は入らない", async () => {
    await makeApp();
    const before = rowsOf("project_grants").length;
    const result = await mcp(admin, "insert_sample_data", {
      table_id: "project_grants",
      rows: [{ project: ids.p2, unit: ids.unitA1, permission: "p_worker" }],
    });
    expect(result.text).toContain(LOCKED_MESSAGE);
    expect(rowsOf("project_grants").length).toBe(before);
  });

  test("(M-3) update_record: 相手の欄の付け替えは断られ、権限の欄だけの変更は通る", async () => {
    await makeApp();
    const moved = await mcp(admin, "update_record", {
      table_id: "project_grants",
      record_id: ids.rowA1P1,
      if_match: versionOf("project_grants", ids.rowA1P1),
      changes: { unit: ids.unitB1 },
    });
    expect(moved.isError, moved.text).toBe(true);
    expect(moved.text).toContain(LOCKED_MESSAGE);
    expect(rowOf("project_grants", ids.rowA1P1)?.unit).toBe(ids.unitA1);
    const perm = await mcp(admin, "update_record", {
      table_id: "project_grants",
      record_id: ids.rowA1P1,
      if_match: versionOf("project_grants", ids.rowA1P1),
      changes: { permission: "p_admin" },
    });
    expect(perm.isError, perm.text).toBe(false);
    expect(rowOf("project_grants", ids.rowA1P1)?.permission).toBe("p_admin");
  });
});

// =====================================================================================
// (I) 受信口
// =====================================================================================

describe("V23-M6-T04 (I) 受信口", () => {
  test("(I-1) 受信口から相手の欄を埋めた付与は作れない(403)、1行も増えない", async () => {
    await makeApp();
    const before = rowsOf("project_grants").length;
    const sent = await postInbound({
      event_id: "evt-1",
      project: ids.p2,
      unit: ids.unitA1,
      permission: "p_worker",
    });
    expect(sent.status, sent.text).toBe(403);
    expect(sent.text).toContain(LOCKED_MESSAGE);
    expect(rowsOf("project_grants").length).toBe(before);
  });

  test("(I-2) 陰性対照: 受信口から利用者を相手にした付与は今日どおり作れる", async () => {
    await makeApp();
    const before = rowsOf("project_grants").length;
    const sent = await postInbound({
      event_id: "evt-2",
      project: ids.p2,
      member: ids.mOut,
      permission: "p_worker",
    });
    expect(sent.status, sent.text).toBe(201);
    expect(rowsOf("project_grants").length).toBe(before + 1);
  });
});

// =====================================================================================
// (A) 自動処理・AI の書き戻し
// =====================================================================================

describe("V23-M6-T04 (A) 自動処理", () => {
  test("(A-act) アクションの作成: 相手の欄を埋めた付与は作れず、きっかけの行ごと巻き戻り、履歴に残る", async () => {
    await makeApp({ wfs: ["act"] });
    const before = rowsOf("project_grants").length;
    const sent = await fire({ gproject: ids.p2, gunit: ids.unitA1 });
    expect(sent.status, sent.text).toBe(400);
    expect(rowsOf("project_grants").length).toBe(before);
    expect(rowsOf("cmds")).toHaveLength(0);
    expect(historyDetail()).toContain(AUTOMATION_MARK);
  });

  test("(A-act-ok) 陰性対照: アクションで利用者を相手にした付与は今日どおり作れる", async () => {
    await makeApp({ wfs: ["act_ok"] });
    const before = rowsOf("project_grants").length;
    const sent = await fire({ gproject: ids.p2, gmember: ids.mOut });
    expect(sent.status, sent.text).toBe(201);
    expect(rowsOf("project_grants").length).toBe(before + 1);
  });

  test("(A-upd) アクションの更新: 相手の欄の付け替えは断られ、相手は変わらない", async () => {
    await makeApp({ wfs: ["upd"] });
    const sent = await fire({ gtarget: ids.rowA1P1, gunit: ids.unitB1 });
    expect(sent.status, sent.text).toBe(400);
    expect(rowOf("project_grants", ids.rowA1P1)?.unit).toBe(ids.unitA1);
    expect(historyDetail()).toContain(AUTOMATION_MARK);
  });

  test("(A-upd-ok) 陰性対照: アクションで権限の欄だけを変えるのは通る(相手の欄は変わらない)", async () => {
    await makeApp({ wfs: ["upd_ok"] });
    const sent = await fire({ gtarget: ids.rowA1P1 });
    expect(sent.status, sent.text).toBe(201);
    const row = rowOf("project_grants", ids.rowA1P1);
    expect(row?.permission).toBe("p_admin");
    expect(row?.unit).toBe(ids.unitA1);
  });

  test("(A-sched) 時刻起動: 名乗り無しでも断り、失敗が履歴に残り、相手は変わらない", async () => {
    await makeApp({ wfs: ["sched"] });
    const cmd = put("cmds", { title: "夜間", gtarget: ids.rowA1P1, gunit: ids.unitB1 });
    withDb((db) => {
      const workflow = (current.app.workflows ?? []).find((w) => w.id === "wf_sched");
      runScheduledWorkflow(db, current, workflow as never, {
        records: [rowOf("cmds", cmd) as never],
      });
    });
    expect(rowOf("project_grants", ids.rowA1P1)?.unit).toBe(ids.unitA1);
    expect(historyDetail()).toContain(AUTOMATION_MARK);
  });

  test("(A-manual) 手動起動: 押した人が運営でも断り、200 と failures で返り、相手は変わらない", async () => {
    await makeApp({ wfs: ["manual"] });
    const cmd = put("cmds", { title: "ボタン", gtarget: ids.rowOutP1, gunit: ids.unitA1 });
    const sent = await http(
      "POST",
      `/views/cmd_list/actions/run?workflow=wf_manual&record=${cmd}`,
      operator,
    );
    expect(sent.status, sent.text).toBe(200);
    expect(sent.text).toContain(AUTOMATION_MARK);
    expect(rowOf("project_grants", ids.rowOutP1)?.unit ?? null).toBe(null);
  });

  test("(A-manual-via) D-V23-259: 手動起動で押した人の書込は、相手の行(部隊)を通じた権限も数える: 専門家は案件1 を書き換えられ、付与の無い案件2 は failures", async () => {
    await makeApp({ wfs: ["manual_title"], staffProjectsReadOnly: true });
    const press = (cmd: string) =>
      http("POST", `/views/cmd_list/actions/run?workflow=wf_manual_title&record=${cmd}`, expert);
    const ok = await press(put("cmds", { title: "ボタン", gproject: ids.p1 }));
    expect(ok.status, ok.text).toBe(200);
    expect((JSON.parse(ok.text) as { failures: string[] }).failures).toEqual([]);
    expect(rowOf("projects", ids.p1)?.title).toBe("ボタン");
    const refused = await press(put("cmds", { title: "ボタン", gproject: ids.p2 }));
    expect(refused.status, refused.text).toBe(200);
    expect(refused.text).toContain("書き換える権限がありません");
    expect(rowOf("projects", ids.p2)?.title).toBe("案件2");
  });

  test("(A-manual-via-n) D-V23-259: 陰性対照: principal_row を書かないアプリでは、同じ専門家のボタンは案件1 でも failures で書けない", async () => {
    await makeApp({ principalRow: false, wfs: ["manual_title"], staffProjectsReadOnly: true });
    const cmd = put("cmds", { title: "ボタン", gproject: ids.p1 });
    const refused = await http(
      "POST",
      `/views/cmd_list/actions/run?workflow=wf_manual_title&record=${cmd}`,
      expert,
    );
    expect(refused.status, refused.text).toBe(200);
    expect(refused.text).toContain("書き換える権限がありません");
    expect(rowOf("projects", ids.p1)?.title).toBe("案件1");
  });

  test("(A-isl) 島の write_ops: 相手の欄を埋めた作成は断られ、1行も増えない", async () => {
    await makeApp({ wfs: ["isl"] });
    const before = rowsOf("project_grants").length;
    const sent = await fire({ gproject: ids.p2, gunit: ids.unitA1 });
    expect(sent.status, sent.text).toBe(400);
    expect(rowsOf("project_grants").length).toBe(before);
    expect(historyDetail()).toContain(AUTOMATION_MARK);
  });

  test("(A-isl-ok) 陰性対照: 島の write_ops で権限の欄だけを変えるのは通る", async () => {
    await makeApp({ wfs: ["isl_ok"] });
    const sent = await fire({
      gtarget: ids.rowA1P1,
      version: versionOf("project_grants", ids.rowA1P1),
    });
    expect(sent.status, sent.text).toBe(201);
    expect(rowOf("project_grants", ids.rowA1P1)?.permission).toBe("p_admin");
  });

  test("(A-replace) output_table の全置換: 相手の欄を埋めた行の作り直しは断られ、付与表は1バイトも変わらない", async () => {
    await makeApp({ wfs: ["replace"] });
    const before = rowsOf("project_grants");
    const sent = await fire({ gproject: ids.p2, gunit: ids.unitA1 });
    expect(sent.status, sent.text).toBe(400);
    expect(rowsOf("project_grants")).toEqual(before);
    expect(historyDetail()).toContain(AUTOMATION_MARK);
  });

  test("(A-wb) 書き戻し: 利用者を相手にした行に相手の欄を書き戻すのは断られ、発火元の更新ごと巻き戻る", async () => {
    await makeApp({ wfs: ["wb"] });
    const sent = await patch(admin, "project_grants", ids.rowOutP1, { memo: ids.unitA1 });
    expect(sent.status, sent.text).toBe(400);
    const row = rowOf("project_grants", ids.rowOutP1);
    expect(row?.unit ?? null).toBe(null);
    expect(row?.memo ?? null).toBe(null);
    expect(historyDetail()).toContain(AUTOMATION_MARK);
  });

  test("(A-ai) AI の書き戻し: 本命・フォールバックとも断り、相手の欄は空のまま", async () => {
    await makeApp({ wfs: ["ai"] });
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
    const sent = await patch(admin, "project_grants", ids.rowOutP1, { memo: "見直し" });
    expect(sent.status, sent.text).toBe(200);
    const unitA1 = ids.unitA1;
    const provider: AiProvider = async () => ({
      text: JSON.stringify({ value: unitA1 }),
      inputTokens: 1,
      outputTokens: 1,
    });
    await dispatchAiJobs(dataRoot as string, provider);
    expect(rowOf("project_grants", ids.rowOutP1)?.unit ?? null).toBe(null);
    const kernelDb = new Database(join(dataRoot as string, "kernel.sqlite"), { readonly: true });
    try {
      const jobs = kernelDb
        .query<{ error: string | null }, []>(`SELECT "error" FROM "ai_jobs" ORDER BY "rowid" ASC`)
        .all();
      expect(jobs.map((job) => job.error ?? "").join(" ")).toContain(AUTOMATION_MARK);
    } finally {
      kernelDb.close();
    }
  });
});

// =====================================================================================
// (N) 陰性対照: `principal_row` を書かないアプリでは答えが変わらない
// =====================================================================================

describe("V23-M6-T04 (N) principal_row を書かないアプリ", () => {
  test("(N-1) 相手の欄(ただの参照の列)だけの付与は、今日どおり「相手が登録されていない」の 400", async () => {
    await makeApp({ principalRow: false });
    const sent = await http("POST", RECORDS("project_grants"), admin, {
      body: { project: ids.p2, unit: ids.unitA1, permission: "p_worker" },
    });
    expect(sent.status, sent.text).toBe(400);
    expect(sent.text).toContain("権限を渡す相手が、このアプリの利用者として登録されていません。");
    expect(sent.text).not.toContain(LOCKED_MESSAGE);
  });

  test("(N-2) 利用者と同じ列を一緒に書く付与も、PATCH での書き足しも今日どおり通る", async () => {
    await makeApp({ principalRow: false });
    const created = await http("POST", RECORDS("project_grants"), admin, {
      body: { project: ids.p2, member: ids.mOut, unit: ids.unitA1, permission: "p_worker" },
    });
    expect(created.status, created.text).toBe(201);
    const patched = await patch(admin, "project_grants", ids.rowOutP1, { unit: ids.unitB1 });
    expect(patched.status, patched.text).toBe(200);
    expect(rowOf("project_grants", ids.rowOutP1)?.unit).toBe(ids.unitB1);
  });

  test("(N-3) 相手の欄だけの行の権限の変更は、今日どおり「相手が登録されていない」の 400", async () => {
    await makeApp({ principalRow: false });
    const sent = await patch(admin, "project_grants", ids.rowA1P1, { permission: "p_admin" });
    expect(sent.status, sent.text).toBe(400);
    expect(sent.text).not.toContain(LOCKED_MESSAGE);
  });

  test("(N-4) 自動処理・受信口・MCP でも参照の列への書込は今日どおり通る", async () => {
    await makeApp({ principalRow: false, wfs: ["act"] });
    const before = rowsOf("project_grants").length;
    const fired = await fire({ gproject: ids.p2, gunit: ids.unitA1 });
    expect(fired.status, fired.text).toBe(201);
    const received = await postInbound({
      event_id: "evt-n4",
      project: ids.p2,
      unit: ids.unitB1,
      permission: "p_worker",
    });
    expect(received.status, received.text).toBe(201);
    const written = await mcp(admin, "update_record", {
      table_id: "project_grants",
      record_id: ids.rowOutP1,
      if_match: versionOf("project_grants", ids.rowOutP1),
      changes: { unit: ids.unitA1 },
    });
    expect(written.isError, written.text).toBe(false);
    expect(rowsOf("project_grants").length).toBe(before + 2);
  });
});

// =====================================================================================
// (U) 判定の家の述語と、承諾の器が渡す抜け道(`T06` で使う)
// =====================================================================================

type Row = Record<string, unknown>;

/** 手元の表で付与の書込を判定する(読む手は1つの要求の形)。 */
function judgeOnStore(
  store: Map<string, Row[]>,
  params: {
    tableId: string;
    op: "create" | "update" | "delete";
    values: Row;
    actorId: string;
    roles?: string[];
    principalRowAccepted?: boolean;
  },
) {
  const readRows = (id: string): readonly Row[] => store.get(id) ?? [];
  return ownerScope.judgeGrantWrite({
    manifest: manifest(),
    tableId: params.tableId,
    op: params.op,
    values: params.values,
    actorId: params.actorId,
    role: (params.roles ?? ["staff"]) as never,
    readRows,
    readRow: (id, recordId) => readRows(id).find((row) => row._id === recordId),
    ...(params.principalRowAccepted === undefined
      ? {}
      : ({ principalRowAccepted: params.principalRowAccepted } as Record<string, unknown>)),
  } as Parameters<typeof ownerScope.judgeGrantWrite>[0]);
}

function unitStore(): Map<string, Row[]> {
  return new Map<string, Row[]>([
    [
      "members",
      [
        { _id: "m-admin", name: "管理者", account: "u-admin" },
        { _id: "m-expert", name: "専門家", account: "u-expert" },
        { _id: "m-out", name: "外の人", account: "u-out" },
      ],
    ],
    ["units", [{ _id: "s-a1", title: "部隊A1" }]],
    ["unit_grants", [{ _id: "ug-1", unit: "s-a1", member: "m-expert", permission: "unit_member" }]],
    ["projects", [{ _id: "p-1", title: "案件1" }]],
    [
      "project_grants",
      [
        { _id: "g-admin", project: "p-1", member: "m-admin", permission: "p_admin" },
        { _id: "g-a1", project: "p-1", unit: "s-a1", permission: "p_worker" },
        { _id: "g-gone", project: "p-1", unit: "s-gone", permission: "p_worker" },
      ],
    ],
  ]);
}

describe("V23-M6-T04 (U) 判定の家の述語", () => {
  type Refused = (params: {
    manifest: Manifest;
    tableId: string;
    op: "create" | "update" | "delete";
    values: Row;
    before?: () => Row | undefined;
    accepted?: boolean;
  }) => boolean;
  const refused = (params: Parameters<Refused>[0]): boolean =>
    (ownerScope as unknown as { principalRowWriteRefused: Refused }).principalRowWriteRefused(
      params,
    );

  test("(U-1) 述語は owner-scope.ts から export され、名前に PrincipalRow を含む", () => {
    expect(typeof (ownerScope as Record<string, unknown>).principalRowWriteRefused).toBe(
      "function",
    );
  });

  test("(U-2) 作成: 相手の欄に値が入れば断る / 入らなければ通す / 削除は通す / 承諾の器なら通す", () => {
    const m = manifest();
    const base = { manifest: m, tableId: "project_grants" };
    expect(refused({ ...base, op: "create", values: { project: "p-1", unit: "s-a1" } })).toBe(true);
    expect(refused({ ...base, op: "create", values: { project: "p-1", member: "m-1" } })).toBe(
      false,
    );
    expect(refused({ ...base, op: "create", values: { project: "p-1", unit: "" } })).toBe(false);
    expect(refused({ ...base, op: "create", values: { project: "p-1", unit: null } })).toBe(false);
    expect(refused({ ...base, op: "delete", values: { project: "p-1", unit: "s-a1" } })).toBe(
      false,
    );
    expect(
      refused({ ...base, op: "create", values: { project: "p-1", unit: "s-a1" }, accepted: true }),
    ).toBe(false);
  });

  test("(U-3) 更新: 値が変わらなければ通す / 変わる・空にする・新しく入れるなら断る / 欄を送らなければ前の行を読まない", () => {
    const m = manifest();
    const base = { manifest: m, tableId: "project_grants", op: "update" as const };
    const before = () => ({ _id: "g-a1", project: "p-1", unit: "s-a1" });
    expect(refused({ ...base, values: { unit: "s-a1", permission: "p_admin" }, before })).toBe(
      false,
    );
    expect(refused({ ...base, values: { unit: "s-b1" }, before })).toBe(true);
    expect(refused({ ...base, values: { unit: null }, before })).toBe(true);
    expect(
      refused({ ...base, values: { unit: "s-a1" }, before: () => ({ _id: "g-x", member: "m" }) }),
    ).toBe(true);
    let reads = 0;
    expect(
      refused({
        ...base,
        values: { permission: "p_admin" },
        before: () => {
          reads += 1;
          return before();
        },
      }),
    ).toBe(false);
    expect(reads).toBe(0);
  });

  test("(U-4) 陰性対照: principal_row を書かない定義・付与表でない表では、どの書込も断らない", () => {
    const none = manifest({ principalRow: false });
    expect(
      refused({
        manifest: none,
        tableId: "project_grants",
        op: "create",
        values: { project: "p-1", unit: "s-a1" },
      }),
    ).toBe(false);
    expect(
      refused({
        manifest: manifest(),
        tableId: "cmds",
        op: "create",
        values: { gunit: "s-a1", unit: "s-a1" },
      }),
    ).toBe(false);
  });

  test("(U-5) 承諾の器の抜け道(T06 で使う): judgeGrantWrite に principalRowAccepted を渡せば、相手の欄だけの作成が通る", () => {
    const store = unitStore();
    const values = { project: "p-1", unit: "s-a1", permission: "p_admin" };
    expect(
      judgeOnStore(store, { tableId: "project_grants", op: "create", values, actorId: "u-admin" })
        ?.kind,
    ).toBe("principal_row_locked");
    expect(
      judgeOnStore(store, {
        tableId: "project_grants",
        op: "create",
        values,
        actorId: "u-admin",
        principalRowAccepted: true,
      })?.kind,
    ).toBe("allowed");
  });

  test("(U-6) 承諾の器でも、相手の欄と利用者の欄を同じ行に書けない", () => {
    const store = unitStore();
    const verdict = judgeOnStore(store, {
      tableId: "project_grants",
      op: "create",
      values: { project: "p-1", unit: "s-a1", member: "m-out", permission: "p_worker" },
      actorId: "u-admin",
      principalRowAccepted: true,
    });
    expect(verdict?.kind).toBe("principal_row_locked");
    expect((verdict as { reason?: string } | undefined)?.reason).toBe("mixed_holder");
  });

  test("(U-7) 相手の行が無い付与の権限の変更は「相手が解決できない」", () => {
    const store = unitStore();
    const verdict = judgeOnStore(store, {
      tableId: "project_grants",
      op: "update",
      values: { _id: "g-gone", project: "p-1", unit: "s-gone", permission: "p_admin" },
      actorId: "u-admin",
    });
    expect(verdict?.kind).toBe("unknown_holder");
  });

  test("(U-8) 書く人が相手の行に via を持てば self(運営でも)", () => {
    const store = unitStore();
    store.get("project_grants")?.push({
      _id: "g-expert",
      project: "p-1",
      member: "m-expert",
      permission: "p_admin",
    });
    const values = { _id: "g-a1", project: "p-1", unit: "s-a1", permission: "p_admin" };
    expect(
      judgeOnStore(store, { tableId: "project_grants", op: "update", values, actorId: "u-expert" })
        ?.kind,
    ).toBe("self");
    expect(
      judgeOnStore(store, {
        tableId: "project_grants",
        op: "update",
        values,
        actorId: "u-expert",
        roles: ["owner"],
      })?.kind,
    ).toBe("self");
    expect(
      judgeOnStore(store, { tableId: "project_grants", op: "update", values, actorId: "u-admin" })
        ?.kind,
    ).toBe("allowed");
  });
});

// =====================================================================================
// 【独立点検の処置(重2)】相手の欄に値のある行の、守る行(target)の付け替えも承諾の外では断る
// =====================================================================================

describe("(R) 相手の欄に値のある行の付け替え(入口ごと)", () => {
  test("(R-1) PATCH: 守る行を案件1 から案件2 へ付け替えると 403、行は変わらず、専門家は案件2 を読めない", async () => {
    await makeApp();
    const sent = await patch(admin, "project_grants", ids.rowA1P1, { project: ids.p2 });
    expect(sent.status, sent.text).toBe(403);
    expect(sent.text).toContain(LOCKED_MESSAGE);
    expect(rowOf("project_grants", ids.rowA1P1)?.project).toBe(ids.p1);
    expect((await http("GET", `${RECORDS("projects")}/${ids.p2}`, expert)).status).toBe(404);
  });

  test("(R-2) 一括: 守る行の付け替えを含むと 403、1行も変わらない", async () => {
    await makeApp();
    const sent = await http("POST", "/batch", admin, {
      body: {
        ops: [
          {
            op: "update",
            table: "project_grants",
            target: ids.rowA1P1,
            if_match: versionOf("project_grants", ids.rowA1P1),
            values: { project: ids.p2 },
          },
        ],
      },
    });
    expect(sent.status, sent.text).toBe(403);
    expect(rowOf("project_grants", ids.rowA1P1)?.project).toBe(ids.p1);
  });

  test("(R-3) MCP update_record: 守る行の付け替えは断られ、行は変わらない", async () => {
    await makeApp();
    const moved = await mcp(admin, "update_record", {
      table_id: "project_grants",
      record_id: ids.rowA1P1,
      if_match: versionOf("project_grants", ids.rowA1P1),
      changes: { project: ids.p2 },
    });
    expect(moved.isError, moved.text).toBe(true);
    expect(moved.text).toContain(LOCKED_MESSAGE);
    expect(rowOf("project_grants", ids.rowA1P1)?.project).toBe(ids.p1);
  });

  test("(R-4) 自動処理のアクションの更新: 守る行の付け替えは断られ、きっかけの行ごと巻き戻る", async () => {
    await makeApp({ wfs: ["upd_target"] });
    const sent = await fire({ gtarget: ids.rowA1P1, gproject: ids.p2 });
    expect(sent.status, sent.text).toBe(400);
    expect(rowOf("project_grants", ids.rowA1P1)?.project).toBe(ids.p1);
    expect(historyDetail()).toContain(AUTOMATION_MARK);
  });

  test("(R-5) 島の write_ops の更新: 守る行の付け替えは断られ、行は変わらない", async () => {
    await makeApp({ wfs: ["isl_target"] });
    const sent = await fire({
      gtarget: ids.rowA1P1,
      gproject: ids.p2,
      version: versionOf("project_grants", ids.rowA1P1),
    });
    expect(sent.status, sent.text).toBe(400);
    expect(rowOf("project_grants", ids.rowA1P1)?.project).toBe(ids.p1);
    expect(historyDetail()).toContain(AUTOMATION_MARK);
  });

  test("(R-6) 陰性対照: 利用者を相手にした行(相手の欄が空)の付け替えは今日どおり通る(PATCH・アクション・島)", async () => {
    await makeApp({ wfs: ["upd_target"] });
    const sent = await patch(admin, "project_grants", ids.rowOutP1, { project: ids.p2 });
    expect(sent.status, sent.text).toBe(200);
    expect(rowOf("project_grants", ids.rowOutP1)?.project).toBe(ids.p2);
    const fired = await fire({ gtarget: ids.rowOutP1, gproject: ids.p1 });
    expect(fired.status, fired.text).toBe(201);
    expect(rowOf("project_grants", ids.rowOutP1)?.project).toBe(ids.p1);
  });

  test("(R-7) 陰性対照: 島の write_ops で利用者を相手にした行を付け替えるのは今日どおり通る", async () => {
    await makeApp({ wfs: ["isl_target"] });
    const sent = await fire({
      gtarget: ids.rowOutP1,
      gproject: ids.p2,
      version: versionOf("project_grants", ids.rowOutP1),
    });
    expect(sent.status, sent.text).toBe(201);
    expect(rowOf("project_grants", ids.rowOutP1)?.project).toBe(ids.p2);
  });

  test("(R-8) 陰性対照: principal_row を書かないアプリでは、参照の列に値のある行の付け替えの答えが今日と同じ(相手の欄の検査に進む)", async () => {
    await makeApp({ principalRow: false });
    // 宣言が無ければ unit はただの参照の列で、この行は今日どおり「相手が登録されていない」の 400。
    const sent = await patch(admin, "project_grants", ids.rowA1P1, { project: ids.p2 });
    expect(sent.status, sent.text).toBe(400);
    expect(sent.text).not.toContain(LOCKED_MESSAGE);
  });
});

describe("(R-U) 判定の家の述語(付け替え)", () => {
  type Refused = (params: {
    manifest: Manifest;
    tableId: string;
    op: "create" | "update" | "delete";
    values: Row;
    before?: () => Row | undefined;
    accepted?: boolean;
  }) => boolean;
  const refused = (params: Parameters<Refused>[0]): boolean =>
    (ownerScope as unknown as { principalRowWriteRefused: Refused }).principalRowWriteRefused(
      params,
    );
  const base = { tableId: "project_grants", op: "update" as const };

  test("(R-U1) 前の行の相手の欄に値があれば、守る行の付け替えを断る(重ねた値でも送った値だけでも)", () => {
    const before = () => ({ _id: "g-a1", project: "p-1", unit: "s-a1", permission: "p_worker" });
    const m = manifest();
    expect(refused({ manifest: m, ...base, values: { project: "p-2" }, before })).toBe(true);
    expect(
      refused({
        manifest: m,
        ...base,
        values: { _id: "g-a1", project: "p-2", unit: "s-a1", permission: "p_worker" },
        before,
      }),
    ).toBe(true);
    expect(refused({ manifest: m, ...base, values: { project: null }, before })).toBe(true);
    // 同じ値・権限の欄だけ・削除・承諾の器は通す。
    expect(refused({ manifest: m, ...base, values: { project: "p-1" }, before })).toBe(false);
    expect(
      refused({
        manifest: m,
        ...base,
        values: { _id: "g-a1", project: "p-1", unit: "s-a1", permission: "p_admin" },
        before,
      }),
    ).toBe(false);
    expect(
      refused({ manifest: m, tableId: "project_grants", op: "delete", values: {}, before }),
    ).toBe(false);
    expect(
      refused({ manifest: m, ...base, values: { project: "p-2" }, before, accepted: true }),
    ).toBe(false);
  });

  test("(R-U2) 両方の欄の古い行: 利用者の欄の付け替えも断る(書き足しは両方の欄の 400 に任せる)", () => {
    const m = manifest();
    const mixed = () => ({ _id: "g-x", project: "p-1", unit: "s-a1", member: "m-1" });
    expect(refused({ manifest: m, ...base, values: { member: "m-2" }, before: mixed })).toBe(true);
    const onlyUnit = () => ({ _id: "g-a1", project: "p-1", unit: "s-a1" });
    expect(refused({ manifest: m, ...base, values: { member: "m-2" }, before: onlyUnit })).toBe(
      false,
    );
  });

  test("(R-U3) 陰性対照: 前の行の相手の欄が空なら付け替えを断らない・宣言の無い定義では前の行を読まない", () => {
    const m = manifest();
    const userRow = () => ({ _id: "g-u", project: "p-1", member: "m-1" });
    expect(refused({ manifest: m, ...base, values: { project: "p-2" }, before: userRow })).toBe(
      false,
    );
    let reads = 0;
    expect(
      refused({
        manifest: manifest({ principalRow: false }),
        ...base,
        values: { project: "p-2" },
        before: () => {
          reads += 1;
          return { _id: "g-a1", project: "p-1", unit: "s-a1" };
        },
      }),
    ).toBe(false);
    expect(reads).toBe(0);
  });
});
