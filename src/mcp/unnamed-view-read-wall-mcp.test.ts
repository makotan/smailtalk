/**
 * **`V18-M4-T03`(`PM-G10` / `D-V18-25` / `D-V18-26` / `ADR-0435` / `ADR-0441`)。**
 *
 * ## 本ファイルが固定するもの
 *
 * **AI の口(`list_records`)は、画面名を名乗る引数をそもそも持たない**
 * (`app_id` / `table_id` / `limit` / `offset` / `sort` / `order` の6個ちょうど)——
 * **だから AI の口からの一覧は、つねに「画面名を名乗らない一覧」である。**
 * **`V18-M4-T02` が画面の口(HTTP)に立てた壁と**同じ1本の述語**が、AI の口にも掛かる。**
 *
 * **ユーザ決定 `D-V18-25`(逐語)**:
 * 「**AI を動かしている人が名簿の一覧画面を読めないなら、AI からも名簿が返らなくなります。
 * 画面からの答えと AI からの答えが揃います。**」
 *
 * **ユーザ決定 `D-V18-26`**: **画面を宣言していて規則を1行も書いていない場合も止める。**
 *
 * ## 本ファイルが**測らないもの**(誇張しない)
 *
 * - **単票の壁は1度も測っていない** —— **AI の口に単票を読む道具が存在しない。**
 *   **だから AI の口に掛かるのは一覧の形(`"list"`)だけである。**
 * - **未ログイン(`anonymous`)は1度も測っていない** —— **AI の口は `requireActorAndApp` を
 *   通っており、名乗りの無い要求はここまで来ない。**
 * - **画面の定義が隠れることは1件も測っていない** —— **【禁止】隠れるのは行であって、
 *   画面の定義ではない。** **(H) 群がその逆(**定義は今日どおり丸ごと返る**)を固定する。**
 * - **【禁止】本ファイルは「安全になった」ことを1件も示さない。**
 * - **実地データ(`data/` 3か所)は1バイトも読んでいない・書いていない** ——
 *   **台は本ファイルが MCP の道具だけで組み立てた設計図である。**
 *
 * ## 題材の形(**なぜこの形でないと測れないか**)
 *
 * | 表 | 一覧系(`list_view` / `report_view`) | 単票系(`detail_view` / `form`) | `viewer` が読める画面 |
 * |---|---|---|---|
 * | `tasks` | `tasks_list` | `tasks_detail` | **単票系だけ**(一覧は止まる) |
 * | `secrets` | `secrets_list` | `secrets_detail` | **1本も無い** |
 * | `open_items` | `open_list` | `open_detail` | **両方**(一覧は通る) |
 * | `bare` | **0本** | **0本** | ——(決め2: 今日どおり通る) |
 * | `reports_only` | `reports_report`(**集計画面**) | **0本** | **1本も無い** |
 * | `forms_only` | **0本** | `forms_form`(**入力フォーム**) | ——(決め2: 一覧系が0本) |
 * | `admin_blind` | `admin_blind_list` | **0本** | **誰も読めない(運営も)** |
 *
 * **`editor` には画面の規則を1行も書いていない** —— **`D-V18-26` を撃つ相手である。**
 * **表の規則は3役割とも全表に書いてある** —— **書かないと面の関門
 * (`roleGateBlocksWithoutGrants`)が先に一覧を空にしてしまい、壁が測れない。**
 *
 * ## 2経路一致(**完了条件 (b)**)
 *
 * **(P) 群が、同じ `dataRoot` の上に HTTP の口と AI の口を両方起こし、
 * **同じ利用者 × 同じ表**で撃って、**返る行の `_id` の集合と件数が一致すること**を固定する。**
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServerApp } from "../server/app.ts";
import { seedSession, TEST_ORIGIN } from "../server/test-helpers.ts";
import { createMcpServer } from "./server.ts";

const APP_ID = "wall-mcp";
const PREVIEW_BASE_URL = "http://127.0.0.1:3000";
/** `create_app` は名乗りを解決しない(このアプリにはまだ利用者が1人も居ない)。 */
const BOOTSTRAP_ACTOR = "bootstrap";

type Any = Record<string, unknown>;

/** 行を作る表の全量(7本)。 */
const ALL_TABLES = [
  "tasks",
  "secrets",
  "open_items",
  "bare",
  "reports_only",
  "forms_only",
  "admin_blind",
] as const;

const textField = { id: "title", name: "名前", type: "text", required: true };

const setupTables = {
  diff_id: "setup-tables",
  intent: "表7本と画面9本を用意する",
  operations: [
    { op: "add_table", table: { id: "tasks", name: "課題", fields: [textField] } },
    { op: "add_table", table: { id: "secrets", name: "秘密", fields: [textField] } },
    { op: "add_table", table: { id: "open_items", name: "開いた表", fields: [textField] } },
    { op: "add_table", table: { id: "bare", name: "画面を1本も持たない表", fields: [textField] } },
    {
      op: "add_table",
      table: {
        id: "reports_only",
        name: "集計画面だけの表",
        fields: [
          textField,
          { id: "kind", name: "区分", type: "select", options: ["甲", "乙", "丙"] },
        ],
      },
    },
    {
      op: "add_table",
      table: { id: "forms_only", name: "入力フォームだけの表", fields: [textField] },
    },
    {
      op: "add_table",
      table: { id: "admin_blind", name: "誰も画面を読めない表", fields: [textField] },
    },
    {
      op: "add_view",
      view: {
        id: "tasks_list",
        name: "課題一覧",
        type: "list_view",
        table: "tasks",
        columns: ["title"],
      },
    },
    {
      op: "add_view",
      view: {
        id: "tasks_detail",
        name: "課題の詳細",
        type: "detail_view",
        table: "tasks",
        fields: ["title"],
      },
    },
    {
      op: "add_view",
      view: {
        id: "secrets_list",
        name: "秘密一覧",
        type: "list_view",
        table: "secrets",
        columns: ["title"],
      },
    },
    {
      op: "add_view",
      view: {
        id: "secrets_detail",
        name: "秘密の詳細",
        type: "detail_view",
        table: "secrets",
        fields: ["title"],
      },
    },
    {
      op: "add_view",
      view: {
        id: "open_list",
        name: "開いた一覧",
        type: "list_view",
        table: "open_items",
        columns: ["title"],
      },
    },
    {
      op: "add_view",
      view: {
        id: "open_detail",
        name: "開いた詳細",
        type: "detail_view",
        table: "open_items",
        fields: ["title"],
      },
    },
    // **集計画面は一覧系である**(`06-v18-m4-plan.md` §11-7 の 1)。
    {
      op: "add_view",
      view: {
        id: "reports_report",
        name: "集計",
        type: "report_view",
        table: "reports_only",
        report: { group_by: [{ field: "kind" }], aggregates: [{ type: "count" }] },
      },
    },
    // **入力フォームは単票系である** —— **一覧の壁は立たない。**
    {
      op: "add_view",
      view: {
        id: "forms_form",
        name: "入力",
        type: "form",
        table: "forms_only",
        fields: ["title"],
      },
    },
    {
      op: "add_view",
      view: {
        id: "admin_blind_list",
        name: "誰も読めない一覧",
        type: "list_view",
        table: "admin_blind",
        columns: ["title"],
      },
    },
  ],
};

/** 全表への表の規則(面の関門を先に踏まないための下ごしらえ)。 */
function tableRules(verbs: string[]): Any[] {
  return ALL_TABLES.map((table) => ({ target: "table", table, can: verbs }));
}

/**
 * **役割の規則を書き直す差分**(`add_table` / `add_view` の自動付与を**全置換で消す**)。
 *
 * **`set_roles` は全置換であり、この差分は何も作らないので自動付与は1本も走らない** ——
 * **だから題材が書いたとおりの画面の規則だけが残る**(`actor-authz.test.ts` と同じ作法)。
 */
const setupRoles = {
  diff_id: "setup-roles",
  intent: "面の規則を、この検査の題材の形に書き直す",
  operations: [
    {
      op: "set_roles",
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            ...tableRules(["read", "write", "delete"]),
            // **`admin_blind_list` **だけ**を書かない** —— **決め5(運営の素通しを作らない)。**
            ...[
              "tasks_list",
              "tasks_detail",
              "secrets_list",
              "secrets_detail",
              "open_list",
              "open_detail",
              "reports_report",
              "forms_form",
            ].map((view) => ({ target: "view", view, can: ["read"] })),
          ],
        },
        {
          id: "editor",
          name: "編集者",
          // **画面の規則を1行も書かない**(`D-V18-26` を撃つ相手)。
          rules: tableRules(["read", "write", "delete"]),
        },
        {
          id: "viewer",
          name: "閲覧者",
          rules: [
            ...tableRules(["read"]),
            { target: "view", view: "tasks_detail", can: ["read"] },
            { target: "view", view: "open_list", can: ["read"] },
            { target: "view", view: "open_detail", can: ["read"] },
          ],
        },
      ],
    },
  ],
};

let dataRoot = "";
let httpApp: ReturnType<typeof createServerApp>;
let admin: ReturnType<typeof seedSession>;
let editor: ReturnType<typeof seedSession>;
let viewer: ReturnType<typeof seedSession>;

/** 表ごとに作った行のID(`beforeEach` が詰める。1表あたり3行)。 */
const rows: Record<string, string[]> = {};

async function connectInMemory(
  actor: string,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer({ dataRoot, previewBaseUrl: PREVIEW_BASE_URL, actor });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function callTool(name: string, args: Any, actor: string): Promise<CallToolResult> {
  const { client, close } = await connectInMemory(actor);
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await close();
  }
}

function okData(result: CallToolResult): Any {
  if (result.isError === true) {
    throw new Error(`ツールが失敗した: ${JSON.stringify(result.structuredContent)}`);
  }
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Any;
}

function sorted(ids: string[]): string[] {
  return [...ids].sort();
}

/** **AI の口の一覧。** **`total` と行IDの両方を返す**(件数だけで判定しない)。 */
async function mcpList(
  table: string,
  actor: string,
  args: Any = {},
): Promise<{ isError: boolean; ids: string[]; total: number }> {
  const result = await callTool(
    "list_records",
    { app_id: APP_ID, table_id: table, ...args },
    actor,
  );
  if (result.isError === true) {
    return { isError: true, ids: [], total: -1 };
  }
  const data = result.structuredContent as { records: { _id: string }[]; total: number };
  return { isError: false, ids: data.records.map((row) => row._id), total: data.total };
}

/** **画面の口(HTTP)の一覧。** **`?view=` を名乗らない**(AI の口と同じ形)。 */
async function httpList(
  table: string,
  cookie: string,
  query = "",
): Promise<{ status: number; ids: string[]; total: number }> {
  const response = await httpApp.request(
    new Request(`http://localhost/api/apps/${APP_ID}/tables/${table}/records${query}`, {
      headers: { origin: TEST_ORIGIN, cookie },
    }),
  );
  if (response.status !== 200) {
    return { status: response.status, ids: [], total: -1 };
  }
  const body = (await response.json()) as { records: { _id: string }[]; total: number };
  return { status: 200, ids: body.records.map((row) => row._id), total: body.total };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-mcp-wall-"));
  okData(
    await callTool(
      "create_app",
      { name: "名乗らない読取の壁(AI の口)", app_id: APP_ID },
      BOOTSTRAP_ACTOR,
    ),
  );

  admin = seedSession(dataRoot, APP_ID, { username: "u-owner", role: "owner" });
  editor = seedSession(dataRoot, APP_ID, { username: "u-editor", role: "editor" });
  viewer = seedSession(dataRoot, APP_ID, { username: "u-viewer", role: "viewer" });

  okData(await callTool("apply_diff", { app_id: APP_ID, diff: setupTables }, admin.username));
  okData(await callTool("apply_diff", { app_id: APP_ID, diff: setupRoles }, admin.username));

  httpApp = createServerApp({ dataRoot });

  // **行は AI の口から作る**(カーネルを直に呼ばない = 実際に通る道で作る)。
  for (const table of ALL_TABLES) {
    const values = [1, 2, 3].map((index) => {
      const row: Any = { title: `${table}-${index}` };
      if (table === "reports_only") {
        row.kind = ["甲", "乙", "丙"][index - 1] as string;
      }
      return row;
    });
    const data = okData(
      await callTool(
        "insert_sample_data",
        { app_id: APP_ID, table_id: table, rows: values },
        admin.username,
      ),
    );
    expect({ table, failed: data.failed }).toEqual({ table, failed: [] });
    rows[table] = (data.inserted as Any[]).map((row) => String(row._id));
  }
  // **台の自己点検** —— **7表とも3行ずつ在ること**(取りこぼすと下の検査が
  // 「壁が立った」ではなく「行が無い」で緑になってしまう)。
  expect(ALL_TABLES.filter((table) => (rows[table] ?? []).length !== 3)).toEqual([]);
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

// ===========================================================================
// (A) AI の口の一覧に壁が立つ —— **`D-V18-25`**
// ===========================================================================

test("(A-1) その表を指す一覧系の画面を1本も読めない名乗りには、AI の口の一覧が0件になる", async () => {
  const actual: Record<string, { isError: boolean; count: number }> = {};
  for (const table of ["tasks", "secrets", "reports_only", "admin_blind"]) {
    const got = await mcpList(table, viewer.username);
    actual[table] = { isError: got.isError, count: got.ids.length };
  }
  expect(actual).toEqual({
    // **`tasks` は単票系(`tasks_detail`)を読めるが、一覧系(`tasks_list`)は読めない。**
    tasks: { isError: false, count: 0 },
    secrets: { isError: false, count: 0 },
    // **集計画面は一覧系である。**
    reports_only: { isError: false, count: 0 },
    admin_blind: { isError: false, count: 0 },
  });
});

test("(A-2) 【決め4】落とすのは応答からであり、`total` も 0 になる(エラーにしない)", async () => {
  const got = await mcpList("secrets", viewer.username);
  expect({ isError: got.isError, total: got.total, count: got.ids.length }).toEqual({
    isError: false,
    total: 0,
    count: 0,
  });
  // **ページ送りでも漏れない**(`limit=1` で歩いても1行も出てこない)。
  const page = await mcpList("secrets", viewer.username, { limit: 1, offset: 0 });
  expect({ total: page.total, count: page.ids.length }).toEqual({ total: 0, count: 0 });
  // **並べ替えを指定しても漏れない。**
  const ordered = await mcpList("secrets", viewer.username, { sort: "title", order: "desc" });
  expect({ total: ordered.total, count: ordered.ids.length }).toEqual({ total: 0, count: 0 });
});

test("(A-3) 一覧系を1本でも読めれば、AI の口の一覧は今日どおり全件返る", async () => {
  const got = await mcpList("open_items", viewer.username);
  expect({ isError: got.isError, ids: sorted(got.ids), total: got.total }).toEqual({
    isError: false,
    ids: sorted(rows.open_items as string[]),
    total: 3,
  });
});

// ===========================================================================
// (B) 決め2 —— **その形の画面が1本も無い表は今日どおり通る**
// ===========================================================================

test("(B-1) 画面を1本も持たない表は、AI の口でも今日どおり全件返る", async () => {
  for (const actor of [viewer.username, editor.username, admin.username]) {
    const got = await mcpList("bare", actor);
    expect({ actor, ids: sorted(got.ids), total: got.total }).toEqual({
      actor,
      ids: sorted(rows.bare as string[]),
      total: 3,
    });
  }
});

test("(B-2) 単票系だけを持つ表の一覧は、AI の口でも今日どおり全件返る(一覧系が0本)", async () => {
  for (const actor of [viewer.username, editor.username]) {
    const got = await mcpList("forms_only", actor);
    expect({ actor, ids: sorted(got.ids), total: got.total }).toEqual({
      actor,
      ids: sorted(rows.forms_only as string[]),
      total: 3,
    });
  }
});

// ===========================================================================
// (C) 決め5 / `D-V18-26` —— **運営の素通しを作らない / 規則を1行も書かない場合も止める**
// ===========================================================================

test("(C-1) 【決め5】規則で一覧画面を読めない運営にも、AI の口で同じ壁が立つ", async () => {
  const blind = await mcpList("admin_blind", admin.username);
  expect({ isError: blind.isError, total: blind.total, count: blind.ids.length }).toEqual({
    isError: false,
    total: 0,
    count: 0,
  });
  // **運営が読める画面を持つ表は1ビットも動かない**(素通しではなく、規則がそのまま効く)。
  const tasks = await mcpList("tasks", admin.username);
  expect({ ids: sorted(tasks.ids), total: tasks.total }).toEqual({
    ids: sorted(rows.tasks as string[]),
    total: 3,
  });
});

test("(C-2) 【`D-V18-26`】画面を宣言していて規則を1行も書いていない名乗りにも壁が立つ", async () => {
  const actual: Record<string, number> = {};
  for (const table of ["tasks", "secrets", "open_items", "reports_only", "admin_blind"]) {
    actual[table] = (await mcpList(table, editor.username)).total;
  }
  // **`editor` は画面の規則を1行も持たない** —— **一覧系の画面を持つ5表がすべて止まる。**
  expect(actual).toEqual({
    tasks: 0,
    secrets: 0,
    open_items: 0,
    reports_only: 0,
    admin_blind: 0,
  });
});

// ===========================================================================
// (D) 決め3 / 決め9 —— **書込と、一覧以外の口は1ビットも動かない**
// ===========================================================================

test("(D-1) 一覧が止まる相手でも、AI の口からの書込は今日どおり通る", async () => {
  // **`editor` は `tasks` の一覧が0件になる側に居る**((C-2) が固定済み)。
  const created = okData(
    await callTool(
      "insert_sample_data",
      { app_id: APP_ID, table_id: "tasks", rows: [{ title: "editor が作った" }] },
      editor.username,
    ),
  );
  expect(created.failed).toEqual([]);
  const target = String((created.inserted as Any[])[0]?._id);
  const version = String((created.inserted as Any[])[0]?._updated_at);
  const updated = okData(
    await callTool(
      "update_record",
      {
        app_id: APP_ID,
        table_id: "tasks",
        record_id: target,
        changes: { title: "editor が直した" },
        if_match: version,
      },
      editor.username,
    ),
  );
  expect((updated.record as Any).title).toBe("editor が直した");
  const removed = await callTool(
    "delete_record",
    {
      app_id: APP_ID,
      table_id: "tasks",
      record_id: target,
      if_match: String((updated.record as Any)._updated_at),
    },
    editor.username,
  );
  expect(removed.isError).toBeFalsy();
});

test("(D-2) 【決め9】システムの表(`_apps` / `_changelog`)の答えは1ビットも動かない", async () => {
  const apps = await mcpList("_apps", viewer.username);
  expect({ isError: apps.isError, hasRows: apps.ids.length > 0 || apps.total > 0 }).toEqual({
    isError: false,
    hasRows: true,
  });
  const changelog = await mcpList("_changelog", viewer.username);
  expect({ isError: changelog.isError, hasRows: changelog.total > 0 }).toEqual({
    isError: false,
    hasRows: true,
  });
});

test("(D-3) 【決め9】画面名を名乗る口(`read_report`)の答えは1ビットも動かない", async () => {
  // **運営は `reports_report` を読める** —— **集計は今日どおり3群を返す。**
  const report = okData(
    await callTool("read_report", { app_id: APP_ID, view_id: "reports_report" }, admin.username),
  );
  expect((report.groups as unknown[]).length).toBe(3);
});

// ===========================================================================
// (H) 射程の担保 —— **画面の定義は今日どおり丸ごと返る**
// ===========================================================================

test("(H-1) AI の口(`get_manifest`)は、読めない画面も含めて定義を丸ごと返す", async () => {
  for (const actor of [viewer.username, editor.username, admin.username]) {
    const data = okData(await callTool("get_manifest", { app_id: APP_ID }, actor));
    const manifest = data.manifest as {
      app: { views: { id: string }[]; tables: { id: string }[] };
    };
    expect({ actor, views: sorted(manifest.app.views.map((view) => view.id)) }).toEqual({
      actor,
      views: sorted([
        "tasks_list",
        "tasks_detail",
        "secrets_list",
        "secrets_detail",
        "open_list",
        "open_detail",
        "reports_report",
        "forms_form",
        "admin_blind_list",
      ]),
    });
    // **表の定義も1本も欠けない。**
    expect({ actor, tables: sorted(manifest.app.tables.map((table) => table.id)) }).toEqual({
      actor,
      tables: sorted([...ALL_TABLES]),
    });
  }
});

// ===========================================================================
// (P) **2経路一致**(完了条件 (b))—— **画面の口と AI の口が同じ答えを返す**
// ===========================================================================

test("(P-1) 同じ利用者 × 同じ表で、画面の口と AI の口の行IDと件数が一致する", async () => {
  const people = [
    { name: "viewer", actor: viewer.username, cookie: viewer.cookie },
    { name: "editor", actor: editor.username, cookie: editor.cookie },
    { name: "owner", actor: admin.username, cookie: admin.cookie },
  ];
  const mismatches: Any[] = [];
  for (const person of people) {
    for (const table of ALL_TABLES) {
      const http = await httpList(table, person.cookie);
      const mcp = await mcpList(table, person.actor);
      const same =
        http.status === 200 &&
        mcp.isError === false &&
        http.total === mcp.total &&
        sorted(http.ids).join(",") === sorted(mcp.ids).join(",");
      if (!same) {
        mismatches.push({ person: person.name, table, http, mcp });
      }
    }
  }
  expect(mismatches).toEqual([]);
});

test("(P-2) 壁が閉じる組み合わせでは、2経路とも 0件 / `total` 0 である(両方が素通しでないこと)", async () => {
  const closed = [
    { name: "viewer", actor: viewer.username, cookie: viewer.cookie, table: "secrets" },
    { name: "editor", actor: editor.username, cookie: editor.cookie, table: "open_items" },
    { name: "owner", actor: admin.username, cookie: admin.cookie, table: "admin_blind" },
  ];
  const actual: Any[] = [];
  for (const entry of closed) {
    const http = await httpList(entry.table, entry.cookie);
    const mcp = await mcpList(entry.table, entry.actor);
    actual.push({
      who: entry.name,
      table: entry.table,
      http: { status: http.status, total: http.total, count: http.ids.length },
      mcp: { isError: mcp.isError, total: mcp.total, count: mcp.ids.length },
    });
  }
  expect(actual).toEqual([
    {
      who: "viewer",
      table: "secrets",
      http: { status: 200, total: 0, count: 0 },
      mcp: { isError: false, total: 0, count: 0 },
    },
    {
      who: "editor",
      table: "open_items",
      http: { status: 200, total: 0, count: 0 },
      mcp: { isError: false, total: 0, count: 0 },
    },
    {
      who: "owner",
      table: "admin_blind",
      http: { status: 200, total: 0, count: 0 },
      mcp: { isError: false, total: 0, count: 0 },
    },
  ]);
});

test("(P-3) 壁が開く組み合わせでは、2経路とも全件返る(壁を立てた側が広く止めすぎていないこと)", async () => {
  const open = [
    { name: "viewer", actor: viewer.username, cookie: viewer.cookie, table: "open_items" },
    { name: "editor", actor: editor.username, cookie: editor.cookie, table: "bare" },
    { name: "owner", actor: admin.username, cookie: admin.cookie, table: "tasks" },
  ];
  for (const entry of open) {
    const http = await httpList(entry.table, entry.cookie);
    const mcp = await mcpList(entry.table, entry.actor);
    expect({
      who: entry.name,
      table: entry.table,
      http: { total: http.total, ids: sorted(http.ids) },
      mcp: { total: mcp.total, ids: sorted(mcp.ids) },
    }).toEqual({
      who: entry.name,
      table: entry.table,
      http: { total: 3, ids: sorted(rows[entry.table] as string[]) },
      mcp: { total: 3, ids: sorted(rows[entry.table] as string[]) },
    });
  }
});
