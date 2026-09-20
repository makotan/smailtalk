/**
 * **集計表の口に、その画面の閲覧判定を掛ける**(`V17-M4-T01`。台帳 `AC-G19` = **門外**(`Δ7`)/
 * **限定採用**。計画は `docs/plan/v17/05-v17-m4-plan.md` §2b の 1 / §3-1)。
 *
 * ## 着手前の実測(**この検査を書いた時点で赤だった**)
 *
 * **表 `sale` の読取は持つが、集計表 `rep_sale` の画面の規則を1本も持たない役割
 * (`clerk`)が、`GET /api/apps/:app_id/views/rep_sale/report` を **200** で受け取り、
 * 店の売上の合計と群がそのまま読めた。** **MCP の `read_report` も同じ数を返した。**
 * **実出力は記録 `docs/plan/v17/records/v17-m4.md` §1 に貼ってある。**
 *
 * **今日の口には `target: "view"` の判定が1件も無い**(着手前に打った) ——
 * `LC_ALL=C /usr/bin/grep -c 'target: "view"' src/mcp/tools/read.ts` = **0**、
 * `src/server/app.ts` の 5件はどれも集計表の口ではない(`rejectNamedView` /
 * `views/:view_id/records` / `views/:view_id/actions/run` / `public` / コメント)。
 *
 * ## 題材の組み方(**罠を2つ避けている**)
 *
 * 1. **既定3役割(`owner` / `editor` / `viewer`)では撃てない** —— **`add_view` の畳み込みが
 *    既定3役割に画面の `read` を自動で生やす**(`report-undo-boundary.test.ts:259` の逐語)。
 *    **そこで、既定でない役割 `clerk` を1本立てる。**
 *    **`clerk` には別の画面(`list_sale`)の `read` を持たせる** —— **測りたいのは
 *    「規則を1本も持たない相手」ではなく「その画面だけ持たない相手」だからである**
 *    (**実地の `data/apps/refec` の `buyer` と同じ形**。画面規則は10本あるが集計表2枚だけが無い)。
 * 2. **書いたその場で偽にならないことを、検査の中で確かめる** ——
 *    **(前提) が `GET /manifest` を読み、`clerk` に `rep_sale` の規則が**生えていない**ことと、
 *    `list_sale` の規則を**持っている**ことの両方を撃つ**(記憶 `limit-table-checks-can-be-born-false`)。
 *
 * ## 陰性対照(**着手の前後で1バイトも動いてはならない**)
 *
 * - **(B) `owner` の応答本文を `toEqual` で固定する**(起票の完了条件
 *   「`read` を持つ役割の応答本文が着手前と1バイトも変わらない」)。**HTTP と MCP の両方。**
 * - **(C) 表の規則を1本も持たないが画面の規則は持つ相手(`viewer`)は、着手の前後とも
 *   **200** で `{groups: [], total_groups: 0, totals: [… 0 …]}` を受け取る** ——
 *   **`ADR-0343` 限定10 / ユーザ決定 `D-V8-128`(「403 にしない」)が守る相手である。**
 *   **`src/server/report-visibility.test.ts` の `(C-1)` と同じ形を、本段の題材で置き直したもの。**
 *
 * ## この検査が言わないこと(**正直に**)
 *
 * - **未ログインを1度も撃っていない** —— **集計表の口は `app.ts:3822` の
 *   `app.use(… /report, recordsAuthMiddleware)` が今日どおり 401 で止める**(`D-V8-127`)。
 *   **本段はそこを1バイトも触らない。**
 * - **`?view=` の名指しの経路(`rejectNamedView`)を1度も撃っていない** ——
 *   **本段が置くのは「パスで名指しされた画面」の判定である**(台帳 `ADR-0007:1845` の逐語)。
 * - **生成物(配布用の生成器の側。作業単位が別である)の集計の口には、今日も画面の判定が1行も無い** ——
 *   **`AC-G26`(`V17-M1-T04` / `ADR-0410`)の担当である。**
 * - **土台をカーネルの関数ではなく MCP の道具で組んでいる** ——
 *   **`scripts/kernel-import-drift.test.ts`(層またぎのスナップショット)を、この検査のためだけに
 *   太らせないためである**(`src/mcp/tools/read-report.test.ts` と同じ判断)。
 *   **本ファイルは `src/kernel/` から値を1つも import していない。**
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../mcp/server.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN } from "./test-helpers.ts";

const APP_ID = "shop";
const SALE = "sale";
const REPORT_VIEW = "rep_sale";
const LIST_VIEW = "list_sale";
const PREVIEW_BASE_URL = "http://127.0.0.1:3000";
/** 名乗りがあれば通る側(`create_app` は解決しない)。 */
const BOOTSTRAP_ACTOR = "bootstrap";

let dataRoot = "";
let app: ReturnType<typeof createServerApp>;
/** 運営。表も画面も持つ。 */
let admin: ReturnType<typeof seedSession>;
/** **表 `sale` の読取は持つが、集計表の画面の規則を1本も持たない人。** */
let clerk: ReturnType<typeof seedSession>;
/** **画面の規則は持つが、表の規則を1本も持たない人**(`D-V8-128` の当たり先)。 */
let stranger: ReturnType<typeof seedSession>;

type Any = Record<string, unknown>;

async function connectInMemory(
  actor: string,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer({ dataRoot, previewBaseUrl: PREVIEW_BASE_URL, actor });
  const client = new Client({ name: "report-view-access-test-client", version: "0.0.0" });
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

/** **サーバを1つ起こし、道具を1回叩き、落とす**(名乗りは起動設定である。`ADR-0327` の ③-1)。 */
async function callTool(
  name: string,
  args: Record<string, unknown>,
  actor: string,
): Promise<CallToolResult> {
  const { client, close } = await connectInMemory(actor);
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await close();
  }
}

function okData(result: CallToolResult): Record<string, unknown> {
  if (result.isError === true) {
    throw new Error(`ツールが失敗した: ${JSON.stringify(result.structuredContent)}`);
  }
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

function httpGet(cookie: string, path: string): Promise<Response> {
  return Promise.resolve(
    app.request(
      new Request(`http://localhost${path}`, {
        method: "GET",
        headers: { cookie, origin: TEST_ORIGIN },
      }),
    ),
  );
}

function reportPath(viewId = REPORT_VIEW): string {
  return `/api/apps/${APP_ID}/views/${viewId}/report`;
}

const setupTables = {
  diff_id: "setup-tables",
  intent: "売上の表を用意する",
  operations: [
    {
      op: "add_table",
      table: {
        id: SALE,
        name: "売上",
        fields: [
          { id: "title", name: "件名", type: "text", required: true },
          { id: "amount", name: "金額", type: "number" },
          { id: "tag", name: "区分", type: "select", options: ["A", "B"] },
        ],
      },
    },
  ],
};

const setupViews = {
  diff_id: "setup-views",
  intent: "集計表1枚と、集計表でない画面を1枚用意する",
  operations: [
    {
      op: "add_view",
      view: {
        id: REPORT_VIEW,
        type: "report_view",
        table: SALE,
        name: "区分ごとの売上",
        report: {
          group_by: [{ field: "tag" }],
          aggregates: [{ type: "sum", field: "amount" }, { type: "count" }],
        },
      },
    },
    {
      op: "add_view",
      view: {
        id: LIST_VIEW,
        type: "list_view",
        table: SALE,
        name: "売上の一覧",
        columns: ["title"],
      },
    },
  ],
};

/**
 * **`set_roles` は `add_view` の畳み込みの**後**に当てる** ——
 * **畳み込みが既定3役割へ生やした画面の規則を、ここで書き直して確定させる。**
 * **`clerk` は畳み込みの対象外である**(既定3役割ではない)。
 */
const setupRoles = {
  diff_id: "setup-roles",
  intent: "運営・店員・通りすがりの3種を書き分ける",
  operations: [
    {
      op: "set_roles",
      roles: [
        {
          id: "owner",
          name: "運営",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            { target: "table", table: SALE, can: ["read", "write", "delete"] },
            { target: "view", view: REPORT_VIEW, can: ["read"] },
            { target: "view", view: LIST_VIEW, can: ["read"] },
          ],
        },
        // **本段の当たり先** —— **表 `sale` は条件なしで全行読めるのに、
        // 集計表 `rep_sale` の画面の規則を1本も持たない。** **一覧の画面は持つ。**
        {
          id: "clerk",
          name: "店員",
          rules: [
            { target: "table", table: SALE, can: ["read"] },
            { target: "view", view: LIST_VIEW, can: ["read"] },
          ],
        },
        // **既定3役割は消せない**(消すと `applyManifest` が invalid になる)。
        { id: "editor", name: "係", rules: [{ target: "view", view: LIST_VIEW, can: ["read"] }] },
        // **陰性対照2** —— **画面の規則だけを持ち、表の規則を1本も持たない。**
        {
          id: "viewer",
          name: "通りすがり",
          rules: [
            { target: "view", view: REPORT_VIEW, can: ["read"] },
            { target: "view", view: LIST_VIEW, can: ["read"] },
          ],
        },
      ],
    },
  ],
};

/** **`owner` に返る本文**(**着手の前後で1バイトも動いてはならない**)。 */
const OWNER_REPORT_BODY = {
  groups: [
    {
      keys: [{ field: "tag", value: "A" }],
      aggregates: [
        { type: "sum", field: "amount", value: 2500 },
        { type: "count", value: 5 },
      ],
    },
    {
      keys: [{ field: "tag", value: "B" }],
      aggregates: [
        { type: "sum", field: "amount", value: 3000 },
        { type: "count", value: 5 },
      ],
    },
  ],
  total_groups: 2,
  totals: [
    { type: "sum", field: "amount", value: 5500 },
    { type: "count", value: 10 },
  ],
};

/** **表の規則を持たない人に返る本文**(`D-V8-128`。**403 にしない**)。 */
const EMPTY_REPORT_BODY = {
  groups: [],
  total_groups: 0,
  totals: [
    { type: "sum", field: "amount", value: 0 },
    { type: "count", value: 0 },
  ],
};

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-report-view-access-"));
  okData(await callTool("create_app", { name: "売店", app_id: APP_ID }, BOOTSTRAP_ACTOR));

  admin = seedSession(dataRoot, APP_ID, { username: "admin" });
  clerk = seedSession(dataRoot, APP_ID, { username: "clerk-user", role: "clerk" });
  stranger = seedSession(dataRoot, APP_ID, { username: "stranger", role: "viewer" });

  okData(await callTool("apply_diff", { app_id: APP_ID, diff: setupTables }, admin.username));
  okData(await callTool("apply_diff", { app_id: APP_ID, diff: setupViews }, admin.username));
  okData(await callTool("apply_diff", { app_id: APP_ID, diff: setupRoles }, admin.username));

  // **10行。** **区分 A が5件(合計 2,500)/ 区分 B が5件(合計 3,000)。**
  const rows = Array.from({ length: 10 }, (_, index) => ({
    title: `売上${index}`,
    amount: (index + 1) * 100,
    tag: index % 2 === 0 ? "A" : "B",
  }));
  const inserted = okData(
    await callTool("insert_sample_data", { app_id: APP_ID, table_id: SALE, rows }, admin.username),
  );
  expect(inserted.failed).toEqual([]);

  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

// =====================================================================================
// (前提) 題材が「書いたその場で偽」になっていないことを、実物のマニフェストで確かめる
// =====================================================================================

test("(前提) clerk には集計表の画面の規則が1本も生えていない(一覧の画面と表の規則は持っている)", async () => {
  const res = await httpGet(admin.cookie, `/api/apps/${APP_ID}/manifest`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { app: { roles: { id: string; rules?: Any[] }[] } };
  const roleOf = (id: string): Any[] => body.app.roles.find((role) => role.id === id)?.rules ?? [];
  const viewReads = (id: string): string[] =>
    roleOf(id)
      .filter(
        (rule) => rule.target === "view" && (rule.can as string[] | undefined)?.includes("read"),
      )
      .map((rule) => String(rule.view));
  const tableReads = (id: string): string[] =>
    roleOf(id)
      .filter(
        (rule) => rule.target === "table" && (rule.can as string[] | undefined)?.includes("read"),
      )
      .map((rule) => String(rule.table));

  // **`clerk` が持っている画面は `list_sale` だけである**(`rep_sale` は1本も無い)。
  expect({ role: "clerk", views: viewReads("clerk").sort() }).toEqual({
    role: "clerk",
    views: [LIST_VIEW],
  });
  // **表は条件なしで読める**(= 0件になるのは「行が見えないから」ではない)。
  expect({ role: "clerk", tables: tableReads("clerk").sort() }).toEqual({
    role: "clerk",
    tables: [SALE],
  });
  // **陰性対照2 の相手は逆である** —— **画面は持ち、表は1本も持たない。**
  expect({ role: "viewer", views: viewReads("viewer").sort() }).toEqual({
    role: "viewer",
    views: [LIST_VIEW, REPORT_VIEW],
  });
  expect({ role: "viewer", tables: tableReads("viewer") }).toEqual({ role: "viewer", tables: [] });
});

// =====================================================================================
// (A) 当たり先 —— 集計表の画面の `read` を持たない相手は 403(HTTP)/ isError(MCP)
// =====================================================================================

test("(A-1) HTTP: 集計表の画面の規則を持たない役割は 403 になる(表の読取は持っていても)", async () => {
  const res = await httpGet(clerk.cookie, reportPath());
  expect(res.status).toBe(403);
  const body = (await res.json()) as { errors: { message: string }[] };
  expect(body.errors[0]?.message).toBe(
    `画面 "${REPORT_VIEW}" に対する閲覧は、あなたの役割に許されていません(止めた層: role)。`,
  );
  // **群も合計も1つも返らない**(部分的な集計を漏らさない)。
  expect(Object.keys(body)).toEqual(["errors"]);
});

test("(A-2) MCP: 同じ相手が read_report を呼ぶと isError になる(HTTP の 403 と1対1)", async () => {
  const result = await callTool(
    "read_report",
    { app_id: APP_ID, view_id: REPORT_VIEW },
    clerk.username,
  );
  expect(result.isError).toBe(true);
  const structured = result.structuredContent as { errors: { message: string }[] } | undefined;
  expect(structured?.errors?.[0]?.message).toBe(
    `画面 "${REPORT_VIEW}" に対する閲覧は、あなたの役割に許されていません(止めた層: role)。`,
  );
  // **群も合計も1つも返らない。**
  expect(Object.keys(structured ?? {})).toEqual(["errors"]);
});

// =====================================================================================
// (B) 陰性対照1 —— `read` を持つ役割の応答本文は着手前と1バイトも同じ
// =====================================================================================

test("(B-1) HTTP: owner の応答本文は着手前と1バイトも同じである", async () => {
  const res = await httpGet(admin.cookie, reportPath());
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(OWNER_REPORT_BODY);
});

test("(B-2) MCP: owner の応答も着手前と1バイトも同じである(キーは3つちょうど)", async () => {
  const result = await callTool(
    "read_report",
    { app_id: APP_ID, view_id: REPORT_VIEW },
    admin.username,
  );
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toEqual(OWNER_REPORT_BODY);
});

// =====================================================================================
// (C) 陰性対照2 —— 表の規則を持たないが画面の規則は持つ相手は 200 のまま(`ADR-0343` 限定10)
// =====================================================================================

test("(C-1) HTTP: 表の規則を1本も持たない相手には、合計0・件数0が 200 で返る(403 にしない)", async () => {
  const res = await httpGet(stranger.cookie, reportPath());
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(EMPTY_REPORT_BODY);
});

test("(C-2) MCP: 同じ相手が read_report を呼んでも isError にならない(合計0が返る)", async () => {
  const result = await callTool(
    "read_report",
    { app_id: APP_ID, view_id: REPORT_VIEW },
    stranger.username,
  );
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toEqual(EMPTY_REPORT_BODY);
});
