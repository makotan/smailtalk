/**
 * **MCP から集計を読む**(`V8-M13-T02`。台帳 `Q-G28` = **限定採用**(門A)。
 * 門A 本審査 = `V8-M7`。限定6点の写しは `docs/plan/v8/records/v8-m7.md:339`)。
 *
 * ## この検査が固定するもの
 *
 * | 群 | 何を |
 * |---|---|
 * | (A) | **`read_report` が集計表の群と集計値を返す**(限定1: 道具は24本を超えない) |
 * | (B) | **可視性の判定を必ず通る**(限定5)—— **同じ道具・同じ引数で、名乗りが違えば数が違う** |
 * | (C) | **上限に当たったときの応答** —— **区別できるのは `message` の文面だけである** |
 * | (D) | **読むだけ**(限定3)—— **書込の口を1つも作っていない** |
 * | (E) | **登録**(引数の全量。**主体を渡す引数を1つも作っていない**) |
 *
 * ## **【必ず読むこと】名乗りは起動設定であって引数ではない**(`ADR-0327` の ③-1)
 *
 * **`ST_MCP_ACTOR` は起動時に一度だけ決める**(`D-V8-46`)。**したがって (B) は
 * **サーバを2度起こして**比べる** —— **`connectInMemory(actor)` は呼ばれるたびに
 * `createMcpServer({ actor })` を新しく作り、終わったら閉じる。**
 * **【禁止】道具の引数に主体を足さない** —— **`ADR-0327` の ③-1 が明示的に却下した案そのもの。**
 *
 * ## 土台をカーネルの関数ではなく MCP のツールで作っている理由
 *
 * `scripts/kernel-import-drift.test.ts`(消費側の層またぎのスナップショット)を、この
 * 検査のためだけに太らせないためである(`actor-authz.test.ts` / `actor-identity.test.ts`
 * と同じ判断)。**本ファイルは `src/kernel/` から値を1つも import していない。**
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ValidationError } from "../../kernel/index.ts";
import { seedSession } from "../../server/test-helpers.ts";
import { createMcpServer } from "../server.ts";

const APP_ID = "shop";
const SALE = "sale";
const PREVIEW_BASE_URL = "http://127.0.0.1:3000";
/** 名乗りがあれば通る側(`create_app` は解決しない)。 */
const BOOTSTRAP_ACTOR = "bootstrap";

let dataRoot = "";
/** **運営**(`owner`)。**無条件の読取を持つので全行が見える。** */
let admin: ReturnType<typeof seedSession>;
/** **買い手**(`customer`)。**自分が買った行しか見えない。** */
let buyer: ReturnType<typeof seedSession>;
/** **規則を1本も持たない人**(`viewer`)。**画面の規則だけ持つ。** */
let stranger: ReturnType<typeof seedSession>;

async function connectInMemory(
  actor?: string,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer(
    actor === undefined
      ? { dataRoot, previewBaseUrl: PREVIEW_BASE_URL }
      : { dataRoot, previewBaseUrl: PREVIEW_BASE_URL, actor },
  );
  const client = new Client({ name: "read-report-test-client", version: "0.0.0" });
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

/**
 * **サーバを1つ起こし、道具を1回叩き、落とす。**
 *
 * **これが「起動時に一度だけ名乗る」の実物である** —— **2つの主体で比べるときは、
 * この関数を2度呼ぶ**(= サーバを2度起こす)。
 */
async function callTool(
  name: string,
  args: Record<string, unknown> = {},
  actor?: string,
): Promise<CallToolResult> {
  const { client, close } = await connectInMemory(actor);
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await close();
  }
}

function errorsOf(result: CallToolResult): ValidationError[] {
  expect(result.isError).toBe(true);
  const structured = result.structuredContent as { errors: ValidationError[] } | undefined;
  expect(structured?.errors).toBeDefined();
  return structured?.errors ?? [];
}

function okData(result: CallToolResult): Record<string, unknown> {
  if (result.isError === true) {
    throw new Error(`ツールが失敗した: ${JSON.stringify(result.structuredContent)}`);
  }
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

type ReportGroup = {
  keys: { field: string; value: unknown }[];
  aggregates: { type: string; field?: string; value: number }[];
};
type ReportBody = {
  groups: ReportGroup[];
  total_groups: number;
  totals: { type: string; field?: string; value: number }[];
};

/** 群を「キーの値 → 集計値の並び」へ潰す(読みやすい形で突き合わせるため)。 */
function shapeOf(body: ReportBody): [unknown, number[]][] {
  return body.groups.map((group) => [
    group.keys[0]?.value ?? null,
    group.aggregates.map((aggregate) => aggregate.value),
  ]);
}

function countOf(body: ReportBody): number {
  return body.totals.find((aggregate) => aggregate.type === "count")?.value ?? -1;
}

async function readReport(
  actor: string,
  viewId = "rep_sale",
  args: Record<string, unknown> = {},
): Promise<ReportBody> {
  return okData(
    await callTool("read_report", { app_id: APP_ID, view_id: viewId, ...args }, actor),
  ) as unknown as ReportBody;
}

const setupTables = {
  diff_id: "setup-tables",
  intent: "売上と、上限を超える大きい表を用意する",
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
          { id: "buyer", name: "買った人", type: "text" },
        ],
      },
    },
    {
      op: "add_table",
      table: {
        id: "big",
        name: "大きい表",
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
  intent: "集計表2枚と、集計表でない画面を1枚用意する",
  operations: [
    {
      op: "add_view",
      view: {
        id: "rep_sale",
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
        id: "rep_big",
        type: "report_view",
        table: "big",
        name: "大きい表の集計",
        report: {
          group_by: [{ field: "tag" }],
          aggregates: [{ type: "count" }],
        },
      },
    },
    {
      op: "add_view",
      view: {
        id: "list_sale",
        type: "list_view",
        table: SALE,
        name: "売上の一覧",
        columns: ["title"],
      },
    },
  ],
};

const setupRoles = {
  diff_id: "setup-roles",
  intent: "運営は全行、買い手は自分の行だけを読める形にする",
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
            // **無条件の読取** —— **全行が見える。**
            { target: "table", table: SALE, can: ["read", "write", "delete"] },
            { target: "table", table: "big", can: ["read", "write", "delete"] },
            { target: "view", view: "rep_sale", can: ["read"] },
            { target: "view", view: "rep_big", can: ["read"] },
            { target: "view", view: "list_sale", can: ["read"] },
          ],
        },
        {
          id: "customer",
          name: "買い手",
          rules: [
            // **条件つきの読取** —— **自分が買った行だけ。**
            {
              target: "table",
              table: SALE,
              can: ["read"],
              when: { field: "buyer", equals_current_user: true },
            },
            { target: "table", table: "big", can: ["read"] },
            { target: "view", view: "rep_sale", can: ["read"] },
            { target: "view", view: "rep_big", can: ["read"] },
            { target: "view", view: "list_sale", can: ["read"] },
          ],
        },
        // **既定の3役割(owner / editor / viewer)は消せない**ので、`editor` も書く。
        // **`editor` は本検査では1度も使っていない。**
        { id: "editor", name: "係", rules: [{ target: "view", view: "list_sale", can: ["read"] }] },
        {
          id: "viewer",
          name: "通りすがり",
          rules: [
            { target: "view", view: "rep_sale", can: ["read"] },
            { target: "view", view: "rep_big", can: ["read"] },
            { target: "view", view: "list_sale", can: ["read"] },
          ],
        },
      ],
    },
  ],
};

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-mcp-read-report-"));
  okData(await callTool("create_app", { name: "売店", app_id: APP_ID }, BOOTSTRAP_ACTOR));

  admin = seedSession(dataRoot, APP_ID, { username: "admin" });
  buyer = seedSession(dataRoot, APP_ID, { username: "buyer", role: "customer" });
  stranger = seedSession(dataRoot, APP_ID, { username: "stranger", role: "viewer" });

  okData(await callTool("apply_diff", { app_id: APP_ID, diff: setupTables }, admin.username));
  okData(await callTool("apply_diff", { app_id: APP_ID, diff: setupViews }, admin.username));
  okData(await callTool("apply_diff", { app_id: APP_ID, diff: setupRoles }, admin.username));

  // **10行。** **買い手が買ったのは3行(区分 A が2件・B が1件)である。**
  const rows = Array.from({ length: 10 }, (_, index) => ({
    title: `売上${index}`,
    amount: (index + 1) * 100,
    tag: index % 2 === 0 ? "A" : "B",
    buyer: index < 3 ? buyer.userId : admin.userId,
  }));
  const inserted = okData(
    await callTool("insert_sample_data", { app_id: APP_ID, table_id: SALE, rows }, admin.username),
  );
  expect(inserted.failed).toEqual([]);
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

// =====================================================================================
// (A) 集計表の群と集計値が返る
// =====================================================================================

test("(A-1) read_report が集計表の群と集計値を返す", async () => {
  const body = await readReport(admin.username);
  // **区分 A は 0/2/4/6/8 番の5行(100 + 300 + 500 + 700 + 900 = 2,500)、
  //   区分 B は 1/3/5/7/9 番の5行(200 + 400 + 600 + 800 + 1,000 = 3,000)。**
  expect(shapeOf(body)).toEqual([
    ["A", [2500, 5]],
    ["B", [3000, 5]],
  ]);
  expect(body.total_groups).toBe(2);
  // **`totals` は全体の合計である**(`D-V8-122`)—— **群ごとの値の和ではない。**
  expect(body.totals).toEqual([
    { type: "sum", field: "amount", value: 5500 },
    { type: "count", value: 10 },
  ]);
});

test("(A-2) 応答のトップレベルのキーは groups / total_groups / totals の3つちょうどである", async () => {
  const data = okData(
    await callTool("read_report", { app_id: APP_ID, view_id: "rep_sale" }, admin.username),
  );
  // **HTTP の口(`GET /api/apps/:app_id/views/:view_id/report`)とまったく同じ3つである**
  // (`src/server/report-declaration-boundary.test.ts` の (24) が HTTP 側を固定している)。
  expect(Object.keys(data).sort()).toEqual(["groups", "total_groups", "totals"]);
});

// =====================================================================================
// (B) 可視性の判定を必ず通る(限定5)—— **サーバを2度起こして比べる**
// =====================================================================================

test("(B-1) 同じ道具・同じ引数でも、名乗りが違えば数が違う(運営と買い手)", async () => {
  const forAdmin = await readReport(admin.username);
  const forBuyer = await readReport(buyer.username);

  // **運営は全10行。**
  expect(shapeOf(forAdmin)).toEqual([
    ["A", [2500, 5]],
    ["B", [3000, 5]],
  ]);
  // **買い手は自分が買った3行だけ**(0番 = A/100、1番 = B/200、2番 = A/300)。
  expect(shapeOf(forBuyer)).toEqual([
    ["A", [400, 2]],
    ["B", [200, 1]],
  ]);
  // **2人ぶんが同じ数ではないこと**(同じなら「一致した」と言えても意味が無い)。
  expect([countOf(forAdmin), countOf(forBuyer)]).toEqual([10, 3]);
});

test("(B-2) 規則を1本も持たない人には、合計0・件数0・群0 が返る(断らない)", async () => {
  const body = await readReport(stranger.username);
  expect(body.groups).toEqual([]);
  expect(body.total_groups).toBe(0);
  expect(body.totals).toEqual([
    { type: "sum", field: "amount", value: 0 },
    { type: "count", value: 0 },
  ]);
});

test("(B-3) 名乗りをそのアプリの利用者へ解決できないと、集計を1つも返さない", async () => {
  const result = await callTool("read_report", { app_id: APP_ID, view_id: "rep_sale" }, "居ない人");
  expect(errorsOf(result)[0]?.message).toBe("名乗った利用者は、このアプリに登録されていません。");
});

// =====================================================================================
// (C) 上限に当たったときの応答
// =====================================================================================

test("(C-1) 群化の前に読む行が上限を超えると断る —— 区別できるのは message の文面だけである", async () => {
  // **10,001 行**(上限は 10,000 で **inclusive**。ちょうどは通り、超えたときだけ断る)。
  for (let batch = 0; batch < 11; batch += 1) {
    const size = batch === 10 ? 1 : 1000;
    const rows = Array.from({ length: size }, (_, index) => ({
      title: `大${batch}-${index}`,
      amount: 1,
      tag: index % 2 === 0 ? "A" : "B",
    }));
    const inserted = okData(
      await callTool(
        "insert_sample_data",
        { app_id: APP_ID, table_id: "big", rows },
        admin.username,
      ),
    );
    expect(inserted.failed).toEqual([]);
  }

  const result = await callTool(
    "read_report",
    { app_id: APP_ID, view_id: "rep_big" },
    admin.username,
  );
  const errors = errorsOf(result);
  expect(errors).toHaveLength(1);
  /*
   * **【実測。誇張しない】** **「どの上限か」を載せる専用のキーは1本も無い。**
   * **`path` は根(`""`)、`allowed_values` は無い、`conflict` も無い** ——
   * **区別できるのは `message` の文面だけである。**
   * **応答は `groups` / `total_groups` / `totals` を1つも持たない**(部分的な結果を返さない)。
   */
  expect(Object.keys(errors[0] ?? {}).sort()).toEqual(["hint", "message", "path"]);
  expect(errors[0]?.path).toBe("");
  // **【実測。3桁区切りは入っていない】** —— **散文(`src/mcp/vocabulary.ts` ほか)は
  // `10,000` と書くが、応答の文面は `10000` である**(`src/server/errors.ts` が
  // `MAX_REPORT_SCANNED_ROWS` をそのまま埋めている)。**書いたその場で打って気づいた。**
  expect(errors[0]?.message).toBe(
    "集計の上限を超えているため計算できません(群にまとめる前に読む行の件数が上限 10000 件を超えました)。",
  );
  expect(result.structuredContent).toEqual({ errors });
}, 120_000);

test("(C-2) 集計表でない画面・実在しない画面は、統一形式で断る", async () => {
  const notReport = await callTool(
    "read_report",
    { app_id: APP_ID, view_id: "list_sale" },
    admin.username,
  );
  expect(errorsOf(notReport)[0]?.message).toContain("集計表(report_view)ではありません");

  const missing = await callTool(
    "read_report",
    { app_id: APP_ID, view_id: "nope" },
    admin.username,
  );
  const errors = errorsOf(missing);
  expect(errors[0]?.message).toContain('"nope"');
  // **実在する集計表の名前を示す**(自己修正の1往復を作る)。
  expect(errors[0]?.allowed_values).toEqual(["rep_sale", "rep_big"]);
});

// =====================================================================================
// (D) 読むだけ(限定3)
// =====================================================================================

test("(D-1) 読んでも変更履歴が1件も増えない(書込の口を1つも作っていない)", async () => {
  const before = okData(await callTool("get_changelog", { app_id: APP_ID }, admin.username));
  await readReport(admin.username);
  await readReport(buyer.username);
  const after = okData(await callTool("get_changelog", { app_id: APP_ID }, admin.username));
  expect((after.changelog as unknown[]).length).toBe((before.changelog as unknown[]).length);
});

// =====================================================================================
// (E) 登録(引数の全量)
// =====================================================================================

test("(E-1) read_report は参照系として登録され、引数は4つちょうどで、主体を渡す引数が1つも無い", async () => {
  const { client, close } = await connectInMemory(admin.username);
  try {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "read_report");
    expect(tool).toBeDefined();
    const keys = Object.keys(tool?.inputSchema?.properties ?? {});
    expect(keys.sort()).toEqual(["app_id", "limit", "offset", "view_id"]);
    /*
     * **【禁止】主体を渡す引数を作らない**(`ADR-0327` の ③-1 が明示的に却下した案)。
     * **名乗りは起動時に一度だけ決める**(`D-V8-46`)。
     */
    for (const forbidden of ["actor", "as", "user", "user_id", "act_as", "role", "roles"]) {
      expect(keys).not.toContain(forbidden);
    }
  } finally {
    await close();
  }
});

test("(E-2) limit / offset は群だけを切り、total_groups と totals は切る前の全体である", async () => {
  const body = await readReport(admin.username, "rep_sale", { limit: 1, offset: 1 });
  expect(shapeOf(body)).toEqual([["B", [3000, 5]]]);
  // **切るのは `groups` だけである**(HTTP の口と同じ。`D-V8-129`)。
  expect(body.total_groups).toBe(2);
  expect(body.totals).toEqual([
    { type: "sum", field: "amount", value: 5500 },
    { type: "count", value: 10 },
  ]);
});
