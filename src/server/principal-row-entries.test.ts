/**
 * **行を相手にした付与の読取の解決 —— 入口ごとに1本ずつ(実 HTTP・MCP・自動処理)**
 * (`V23-M6-T03`。門A = `ADR-0502`(`SC-G20`)を補う `ADR-0538` §Decision 1-2・1-3。
 * 決定 `D-V23-150`・`D-V23-161`・`D-V23-165`。授権 `ADR-0539`)。
 *
 * ## この検査が測るもの / 測らないもの(**先に書く**)
 *
 * **題材**: 名簿1本を共有する2つの表。 部隊(S。`units`)と案件(R。`projects`)。 案件の付与表の `unit` 列が
 * 部隊の行を指す(`principal_row`。`via` は `unit_member`)。 案件 P1・P3 に部隊 A1 への `p_worker`(読む・書く・消す)。
 * `expert` は部隊 A1 に `unit_member` を直接持つだけで、案件には付与が1件も無い。
 *
 * **測るもの**: `expert` が、案件の行の中身の判定を通る入口のそれぞれで、部隊経由の付与どおりに通ること
 * (HTTP の一覧・1行・集計表・ファイル・ボタン・PATCH・DELETE・一括・作成の親・出どころ、MCP の
 * `list_records`・`read_report`・`update_record`・`delete_record`、ボタン起動の自動処理の `act_as` の対象の読み)。
 * 部隊から外すと次の要求ですぐ読めないこと。 **付与表・名簿の見える範囲には部隊経由を入れない**こと
 * (HTTP と MCP。`D-V23-165`)。
 *
 * **測らないもの(誇張しない)**: 判定の家の細部(`principal-row-resolution.test.ts`)。 付与の書込の断り(`T04`)。
 * コードとコードの招待(`T05`・`T06`)。 相手の名前の見せ方(`T04b`)。 受信口・時刻起動・島の書込(読取の解決を
 * 通るのは書込の判定の側。`T04` で入口ごとに撃つ)。 生成器(`T09`)。 画面(`T06b`)。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  appDbPath,
  applyManifest,
  createApp,
  createRecord,
  deleteRecord,
  KernelMetaStore,
  type Manifest,
} from "../kernel/index.ts";
import { ensureIslandRuntimeReady } from "../kernel/island-runner.ts";
import { createMcpServer } from "../mcp/server.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN } from "./test-helpers.ts";

const APP_ID = "pr-entries";
const ALL = ["read", "write", "delete"];
const TABLES = [
  "members",
  "units",
  "unit_grants",
  "projects",
  "project_grants",
  "tasks",
  "task_grants",
  "reviews",
  "logs",
  "wf_log",
];

const ref = (id: string, table: string) => ({
  id,
  name: id,
  type: "reference",
  reference_table: table,
});

function manifest(options: { taskGuest?: boolean } = {}): Manifest {
  // **【独立点検の処置(重1)】`taskGuest` を渡すと、部隊に権限 `unit_guest` を足し、作業にも同じ部隊を指す
  // `principal_row`(`via` は `unit_guest`。案件と違う)を置く。** 渡さなければ着手前と同じ定義。
  const taskGuest = options.taskGuest === true;
  const rules = (can: string[]) => TABLES.map((table) => ({ target: "table", table, can }));
  const views = ["project-list", "review-list", "rep-projects"];
  const viewRules = views.map((view) => ({ target: "view", view, can: ["read"] }));
  return {
    app: {
      id: APP_ID,
      name: "行を相手にした付与の入口",
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
              ...(taskGuest
                ? [{ id: "unit_guest", name: "客", read: true, write: false, delete: false }]
                : []),
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
              options: ["unit_lead", "unit_member", ...(taskGuest ? ["unit_guest"] : [])],
            },
          ],
        },
        {
          id: "projects",
          name: "案件",
          representative_field: "title",
          fields: [
            { id: "title", name: "名前", type: "text" },
            { id: "doc", name: "資料", type: "file" },
            { id: "kind", name: "種類", type: "select", options: ["甲", "乙", "丙"] },
          ],
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
              principal_row: { column: "unit", table: "units", via: ["unit_member"] },
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
              ...(taskGuest
                ? { principal_row: { column: "unit", table: "units", via: ["unit_guest"] } }
                : {}),
            },
            members: { table: "members", account: "account" },
            inherit_from: ["project"],
            creatable_by: ["p_worker"],
          },
        },
        {
          id: "task_grants",
          name: "作業の付与",
          fields: [
            ref("task", "tasks"),
            ref("member", "members"),
            ...(taskGuest ? [ref("unit", "units")] : []),
            { id: "permission", name: "権限", type: "select", options: ["t_admin", "p_worker"] },
          ],
        },
        {
          id: "reviews",
          name: "見直し",
          fields: [{ id: "title", name: "名前", type: "text" }, ref("on_project", "projects")],
        },
        { id: "logs", name: "記録", fields: [{ id: "body", name: "本文", type: "text" }] },
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
      views: [
        {
          id: "project-list",
          type: "list_view",
          table: "projects",
          columns: ["title"],
          actions: [{ run: "wf_touch", name: "押す" }],
        },
        {
          id: "review-list",
          type: "list_view",
          table: "reviews",
          columns: ["title"],
          actions: [{ run: "wf_actas", name: "案件として押す" }],
        },
        {
          id: "rep-projects",
          type: "report_view",
          table: "projects",
          name: "案件の数",
          report: { group_by: [{ field: "kind" }], aggregates: [{ type: "count" }] },
        },
      ],
      workflows: [
        {
          id: "wf_touch",
          name: "押した記録",
          trigger: { type: "manual", table: "projects" },
          history_table: "wf_log",
          actions: [{ action: "create_record", table: "logs", values: { body: "押した" } }],
        },
        {
          id: "wf_actas",
          name: "案件として記録",
          trigger: { type: "manual", table: "reviews" },
          act_as: "$record.on_project",
          history_table: "wf_log",
          actions: [{ action: "create_record", table: "logs", values: { body: "案件として" } }],
        },
      ],
      roles: [
        {
          id: "owner",
          name: "運営",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            ...rules(ALL),
            ...viewRules,
          ],
        },
        { id: "staff", name: "担当", rules: [...rules(ALL), ...viewRules] },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
    },
  } as unknown as Manifest;
}

type Who = { cookie: string; userId: string; username: string };

let dataRoot = "";
let server: ReturnType<typeof createServerApp>;
let admin: Who;
let expert: Who;
let outsider: Who;
type Ids = Record<
  "mAdmin" | "mExpert" | "unitA1" | "ug" | "p1" | "p2" | "p3" | "fileId" | "review",
  string
>;
let ids = {} as Ids;

beforeAll(async () => {
  await ensureIslandRuntimeReady();
});

function withDb<T>(run: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID));
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function put(db: Database, table: string, values: Record<string, unknown>): string {
  const created = createRecord(db, manifest(), table, values);
  if (!created.ok) {
    throw new Error(`${table} に行を置けない: ${JSON.stringify(created.errors)}`);
  }
  return created.value._id;
}

function rowsOf(table: string): Record<string, unknown>[] {
  return withDb((db) => db.query(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[]);
}

function rowOf(table: string, id: string): Record<string, unknown> {
  return rowsOf(table).find((row) => row._id === id) as Record<string, unknown>;
}

async function upload(who: Who): Promise<string> {
  const form = new FormData();
  form.set(
    "file",
    new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])]),
    "doc.png",
  );
  const res = await server.request(
    new Request(`http://localhost/api/apps/${APP_ID}/files`, {
      method: "POST",
      headers: { cookie: who.cookie, origin: TEST_ORIGIN },
      body: form,
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { file_id: string }).file_id;
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-pr-entries-"));
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, "行を相手にした付与の入口", { app_id: APP_ID });
  } finally {
    meta.close();
  }
  const applied = applyManifest(dataRoot, APP_ID, manifest());
  if (!applied.valid) {
    throw new Error(JSON.stringify(applied.errors));
  }
  server = createServerApp({ dataRoot });
  const seed = (username: string, role: string): Who => {
    const s = seedSession(dataRoot, APP_ID, { role, username });
    return { cookie: s.cookie, userId: s.userId, username };
  };
  admin = seed("admin1", "staff");
  expert = seed("expert1", "staff");
  outsider = seed("outsider1", "staff");
  const fileId = await upload(admin);
  ids = withDb((db) => {
    const mAdmin = put(db, "members", { name: "管理者", account: admin.userId });
    const mExpert = put(db, "members", { name: "専門家", account: expert.userId });
    put(db, "members", { name: "外の人", account: outsider.userId });
    const unitA1 = put(db, "units", { title: "部隊A1" });
    const ug = put(db, "unit_grants", { unit: unitA1, member: mExpert, permission: "unit_member" });
    const p1 = put(db, "projects", { title: "案件1", doc: fileId, kind: "甲" });
    const p2 = put(db, "projects", { title: "案件2", kind: "乙" });
    const p3 = put(db, "projects", { title: "案件3", kind: "丙" });
    for (const p of [p1, p2, p3]) {
      put(db, "project_grants", { project: p, member: mAdmin, permission: "p_admin" });
    }
    put(db, "project_grants", { project: p1, unit: unitA1, permission: "p_worker" });
    put(db, "project_grants", { project: p3, unit: unitA1, permission: "p_worker" });
    const review = put(db, "reviews", { title: "見直し1", on_project: p1 });
    return { mAdmin, mExpert, unitA1, ug, p1, p2, p3, fileId, review };
  });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

type Sent = { status: number; body: Record<string, unknown> };

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
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

const listedIds = (sent: Sent): string[] =>
  ((sent.body.records ?? []) as Record<string, unknown>[]).map((row) => String(row._id)).sort();

async function mcp(name: string, args: Record<string, unknown>, who: Who): Promise<CallToolResult> {
  const mcpServer = createMcpServer({
    dataRoot,
    previewBaseUrl: "http://127.0.0.1:3000",
    actor: who.username,
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);
  try {
    return (await client.callTool({
      name,
      arguments: { app_id: APP_ID, ...args },
    })) as CallToolResult;
  } finally {
    await client.close();
    await mcpServer.close();
  }
}

function structured(result: CallToolResult): Record<string, unknown> {
  if (result.isError === true) {
    throw new Error(`ツールが失敗した: ${JSON.stringify(result.structuredContent)}`);
  }
  return result.structuredContent as Record<string, unknown>;
}

describe("(H) HTTP の入口", () => {
  test("(H-1) 一覧: 部隊経由の付与のある案件だけが並ぶ。 部隊から外すと次の要求ですぐ並ばない", async () => {
    const before = await http("GET", "/tables/projects/records", expert);
    expect(before.status).toBe(200);
    expect(listedIds(before)).toEqual([ids.p1, ids.p3].sort());
    // 陰性対照: 部隊に居ない人には1件も並ばない。
    expect(listedIds(await http("GET", "/tables/projects/records", outsider))).toEqual([]);
    withDb((db) => {
      const removed = deleteRecord(db, manifest(), "unit_grants", ids.ug);
      expect(removed.ok).toBe(true);
    });
    expect(listedIds(await http("GET", "/tables/projects/records", expert))).toEqual([]);
  });

  test("(H-2) 1行: 部隊経由で読める行は 200、付与の無い行は 404", async () => {
    expect((await http("GET", `/tables/projects/records/${ids.p1}`, expert)).status).toBe(200);
    expect((await http("GET", `/tables/projects/records/${ids.p2}`, expert)).status).toBe(404);
  });

  test("(H-3) 集計表: 部隊経由で読める行だけが数えられる", async () => {
    const sent = await http("GET", "/views/rep-projects/report", expert);
    expect(sent.status).toBe(200);
    const text = JSON.stringify(sent.body);
    expect(text).toContain("甲");
    expect(text).toContain("丙");
    expect(text).not.toContain("乙");
  });

  test("(H-4) ファイル: 部隊経由で読める行の添付は配られる", async () => {
    expect((await http("GET", `/files/${ids.fileId}`, expert)).status).toBe(200);
    expect((await http("GET", `/files/${ids.fileId}`, outsider)).status).toBe(404);
  });

  test("(H-5) ボタン: 部隊経由で読み書きできる行で押せる", async () => {
    const sent = await http(
      "POST",
      `/views/project-list/actions/run?workflow=wf_touch&record=${ids.p1}`,
      expert,
      { body: {} },
    );
    expect(sent.status).toBe(200);
    expect(sent.body.failures).toEqual([]);
    expect(rowsOf("logs").map((row) => row.body)).toEqual(["押した"]);
  });

  test("(H-6) PATCH: 部隊経由で書ける行を直せる", async () => {
    const before = rowOf("projects", ids.p1);
    const sent = await http("PATCH", `/tables/projects/records/${ids.p1}`, expert, {
      body: { title: "案件1(直した)" },
      ifMatch: String(before._updated_at),
    });
    expect(sent.status).toBe(200);
    expect(rowOf("projects", ids.p1).title).toBe("案件1(直した)");
  });

  test("(H-7) DELETE: 部隊経由で消せる行を消せる", async () => {
    const before = rowOf("projects", ids.p3);
    const sent = await http("DELETE", `/tables/projects/records/${ids.p3}`, expert, {
      ifMatch: String(before._updated_at),
    });
    expect([200, 204]).toContain(sent.status);
    expect(rowsOf("projects").some((row) => row._id === ids.p3)).toBe(false);
  });

  test("(H-8) 一括: 部隊経由で書ける行を一括の口で直せる", async () => {
    const before = rowOf("projects", ids.p1);
    const sent = await http("POST", "/batch", expert, {
      body: {
        ops: [
          {
            op: "update",
            table: "projects",
            target: ids.p1,
            if_match: String(before._updated_at),
            values: { title: "案件1(一括)" },
          },
        ],
      },
    });
    expect(sent.status).toBe(200);
    expect(rowOf("projects", ids.p1).title).toBe("案件1(一括)");
  });

  test("(H-9) 作成の親: 部隊経由で親に書け creatable_by の名前を持つので子を作れる", async () => {
    const sent = await http("POST", "/tables/tasks/records", expert, {
      body: { title: "作業", project: ids.p1 },
    });
    expect(sent.status).toBe(201);
    // 陰性対照: 部隊に居ない人は作れない。
    const denied = await http("POST", "/tables/tasks/records", outsider, {
      body: { title: "作業", project: ids.p1 },
    });
    expect(denied.status).not.toBe(201);
  });

  test("(H-10) 出どころ: 部隊経由の付与に「行経由」の印(部隊の行)が付く", async () => {
    const sent = await http("GET", `/tables/projects/records/${ids.p1}/access-sources`, expert);
    expect(sent.status).toBe(200);
    const sources = sent.body.sources as Record<string, unknown>[];
    expect(sources).toHaveLength(1);
    expect(sources[0]?.principal).toEqual({ table: "units", record_id: ids.unitA1 });
    expect(sources[0]?.permission).toBe("p_worker");
  });

  test("(H-11) 見える範囲(使わない側): 部隊経由の人に、案件の付与の行も名簿の他人の行も見えない", async () => {
    // 案件 P1 は読める。
    expect((await http("GET", `/tables/projects/records/${ids.p1}`, expert)).status).toBe(200);
    expect(listedIds(await http("GET", "/tables/project_grants/records", expert))).toEqual([]);
    expect(listedIds(await http("GET", "/tables/members/records", expert))).toEqual([ids.mExpert]);
    // 陰性対照: 直接の管理者には付与の行が見える。
    expect(listedIds(await http("GET", "/tables/project_grants/records", admin)).length).toBe(5);
  });
});

describe("(M) MCP の入口", () => {
  test("(M-1) list_records: 部隊経由の付与のある案件だけが返る", async () => {
    const listed = structured(await mcp("list_records", { table_id: "projects" }, expert));
    const records = (listed.records as Record<string, unknown>[])
      .map((row) => String(row._id))
      .sort();
    expect(records).toEqual([ids.p1, ids.p3].sort());
    // 見える範囲(使わない側): 付与表は1件も返らない。
    const grants = structured(await mcp("list_records", { table_id: "project_grants" }, expert));
    expect(grants.total).toBe(0);
  });

  test("(M-2) read_report: 部隊経由で読める行だけが数えられる", async () => {
    const text = JSON.stringify(
      structured(await mcp("read_report", { view_id: "rep-projects" }, expert)),
    );
    expect(text).toContain("甲");
    expect(text).not.toContain("乙");
  });

  test("(M-3) update_record: 部隊経由で書ける行を直せる", async () => {
    const before = rowOf("projects", ids.p1);
    structured(
      await mcp(
        "update_record",
        {
          table_id: "projects",
          record_id: ids.p1,
          if_match: String(before._updated_at),
          changes: { title: "案件1(MCP)" },
        },
        expert,
      ),
    );
    expect(rowOf("projects", ids.p1).title).toBe("案件1(MCP)");
  });

  test("(M-4) delete_record: 部隊経由で消せる行を消せる", async () => {
    const before = rowOf("projects", ids.p3);
    structured(
      await mcp(
        "delete_record",
        { table_id: "projects", record_id: ids.p3, if_match: String(before._updated_at) },
        expert,
      ),
    );
    expect(rowsOf("projects").some((row) => row._id === ids.p3)).toBe(false);
  });
});

describe("(A) 自動処理の入口", () => {
  test("(A-1) ボタン起動の act_as の対象の読み: 押した人が部隊経由で読める案件を指せる", async () => {
    const sent = await http(
      "POST",
      `/views/review-list/actions/run?workflow=wf_actas&record=${ids.review}`,
      expert,
      { body: {} },
    );
    expect(sent.status).toBe(200);
    const failures = (sent.body.failures ?? []) as string[];
    expect(failures.filter((message) => message.includes("act_as"))).toEqual([]);
    // 陰性対照: 部隊に居ない人が押すと、案件は見つからない側に倒れる。
    const denied = await http(
      "POST",
      `/views/review-list/actions/run?workflow=wf_actas&record=${ids.review}`,
      outsider,
      { body: {} },
    );
    expect(((denied.body.failures ?? []) as string[]).join(" ")).toContain("act_as");
  });
});

// =====================================================================================
// 【独立点検の処置(重1)】via の違う2つの守る表が同じ部隊を指すとき、1つの要求の中で答えを取り違えない
// =====================================================================================

describe("(V) via の違う守る表どうし", () => {
  test("(V-1) 一覧: 作業の付与で部隊に unit_guest を持つ人には、付与のある作業だけが並ぶ(1行の答えと同じ)", async () => {
    const guestManifest = manifest({ taskGuest: true });
    const applied = applyManifest(dataRoot, APP_ID, guestManifest);
    if (!applied.valid) {
      throw new Error(JSON.stringify(applied.errors));
    }
    server = createServerApp({ dataRoot });
    const tasks = withDb((db) => {
      const add = (table: string, values: Record<string, unknown>): string => {
        const created = createRecord(db, guestManifest, table, values);
        if (!created.ok) {
          throw new Error(`${table} に行を置けない: ${JSON.stringify(created.errors)}`);
        }
        return created.value._id;
      };
      const mOut = (
        db.query(`SELECT _id FROM members WHERE account = ?`).get(outsider.userId) as {
          _id: string;
        }
      )._id;
      add("unit_grants", { unit: ids.unitA1, member: mOut, permission: "unit_guest" });
      const t1 = add("tasks", { title: "作業1", project: ids.p1 });
      const t2 = add("tasks", { title: "作業2", project: ids.p1 });
      add("task_grants", { task: t1, unit: ids.unitA1, permission: "p_worker" });
      return { t1, t2 };
    });
    // 1行ずつ: 作業1 は部隊経由で読める、作業2 は読めない(親の案件の付与は案件の via に unit_guest が無い)。
    expect((await http("GET", `/tables/tasks/records/${tasks.t1}`, outsider)).status).toBe(200);
    expect((await http("GET", `/tables/tasks/records/${tasks.t2}`, outsider)).status).toBe(404);
    // 一覧も同じ答え(作業2 は並ばない)。
    const listed = await http("GET", "/tables/tasks/records", outsider);
    expect(listed.status).toBe(200);
    expect(listedIds(listed)).toEqual([tasks.t1]);
    // 案件の一覧にも並ばない(案件の via に unit_guest は無い)。
    expect(listedIds(await http("GET", "/tables/projects/records", outsider))).toEqual([]);
    // 陰性対照: 所属(unit_member)の人は、案件の付与から作業1・作業2 とも読める(親から引き継ぐ)。
    expect(listedIds(await http("GET", "/tables/tasks/records", expert))).toEqual(
      [tasks.t1, tasks.t2].sort(),
    );
  });
});
