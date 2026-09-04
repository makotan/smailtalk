/**
 * 参照系8ツールの統合テスト(V0-P5-T02 / ADR-0005。7つ目は V1-M1-T02 の `dry_run_diff`、
 * 8つ目は V1-M8-T02 の `generate_requirements_doc`)。
 *
 * すべて **in-process の MCP `Client` 経由**で叩く。ツール関数を直接呼ぶのでは
 * 「登録されている」「入力スキーマが通る」「結果が MCP の形になっている」の
 * どれも確かめられず、MCP クライアント(Claude Code)から見た挙動を保証できない
 * ためである。`InMemoryTransport` なので子プロセスもポートも要らない。
 *
 * 異常系は全ツールで「実在しない app_id」を通す。ここが統一形式
 * (`/app_id` + `allowed_values`)で返らないと LLM が自己修正できず、
 * Phase 5 の目的(会話だけでループが回る)が成立しない。
 *
 * データは毎テスト `mkdtemp` の一時ディレクトリに作るので、リポジトリの
 * `data/` には触れない。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  appDbPath,
  applyDiff,
  type ChangelogEntry,
  createApp,
  createRecord,
  type Diff,
  DRY_RUN_NOTE,
  // **【`V10-M28-T03`】** **カーネルのレポートが今日どおり全量であることを、
  // **カーネルの関数を直に呼んで**測る**(MCP の返り値だけを見ていると、
  // 「落とす層がどちらか」を測ったことにならない)。
  dryRunDiff,
  KernelMetaStore,
  listSnapshots,
  type Manifest,
  type RecordRow,
  readCurrentManifest,
  type UndoPreview,
  type ValidationError,
} from "../../kernel/index.ts";
import { createServerApp } from "../../server/app.ts";
import { seedSession } from "../../server/test-helpers.ts";
import { createMcpServer } from "../server.ts";

/**
 * **【`V8-M31`】MCP の名乗り。** ツールは `actor` を渡さないと全部 `isError` になり、
 * 渡した名前は**そのアプリに実在する利用者**へ解決される必要がある。
 * 参照系のテストはどれも「読める」ことを見るので、既定ロール(`owner`)で1人作る。
 */
const ACTOR = "mcp-actor";

const APP_ID = "inventory";
const TABLE_ID = "items";
const LIST_VIEW_ID = "items-list";

/** テーブル1つ・list_view 1つを足す差分。changelog に apply エントリを1件作る目的も兼ねる。 */
const setupDiff: Diff = {
  diff_id: "setup",
  intent: "備品テーブルと一覧画面を用意する",
  operations: [
    {
      op: "add_table",
      table: {
        id: TABLE_ID,
        name: "備品",
        fields: [
          { id: "title", name: "品名", type: "text", required: true },
          { id: "qty", name: "数量", type: "number" },
        ],
      },
    },
    {
      op: "add_view",
      view: { id: LIST_VIEW_ID, type: "list_view", table: TABLE_ID, columns: ["title", "qty"] },
    },
  ],
};

let dataRoot = "";
let previewBaseUrl = "http://127.0.0.1:3000";

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-mcp-read-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "在庫管理", { app_id: APP_ID });
    createApp(store, "経費申請", { app_id: "expense" });
  } finally {
    store.close();
  }

  const applied = applyDiff(dataRoot, APP_ID, setupDiff);
  if (!applied.valid) {
    throw new Error(`テスト前提の差分適用に失敗しました: ${JSON.stringify(applied.errors)}`);
  }

  // **【`V8-M31`】名乗りはアプリごとに解決される。**このファイルは2つアプリを作るので、
  // **両方に同じ名前で1人ずつ**作る(片方でも漏らすと `expense` を触るテストが
  // 「名乗った利用者は、このアプリに登録されていません。」で落ちる)。
  seedSession(dataRoot, APP_ID, { username: ACTOR });
  seedSession(dataRoot, "expense", { username: ACTOR });

  // レコードを3件。sort / limit の効き方を見分けられるよう数量をばらけさせる。
  const manifest = readCurrentManifest(dataRoot, APP_ID);
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    for (const row of [
      { title: "椅子", qty: 3 },
      { title: "机", qty: 1 },
      { title: "棚", qty: 2 },
    ]) {
      const created = createRecord(db, manifest, TABLE_ID, row);
      if (!created.ok) {
        throw new Error(
          `テスト前提のレコード作成に失敗しました: ${JSON.stringify(created.errors)}`,
        );
      }
    }
  } finally {
    db.close();
  }
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

/**
 * クライアントとサーバを直結して、接続済みのクライアントを返す。
 * 両 `connect` は `Promise.all` で並行に待つ(逐次 await はハンドシェイクが
 * 進まずデッドロックする。`server.test.ts` と同じ理由)。
 */
async function connectInMemory(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer({ dataRoot, previewBaseUrl, actor: ACTOR });
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

/** ツールを1回呼んで結果を返す(接続と後始末を毎回書かないための薄いヘルパ)。 */
async function callTool(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  const { client, close } = await connectInMemory();
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await close();
  }
}

/** 成功結果から `structuredContent` を取り出す(型を絞りつつ isError も確認する)。 */
function okData(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

/** 失敗結果からエラー配列を取り出す。 */
function errorsOf(result: CallToolResult): ValidationError[] {
  expect(result.isError).toBe(true);
  const structured = result.structuredContent as { errors: ValidationError[] } | undefined;
  expect(structured?.errors).toBeDefined();
  return structured?.errors ?? [];
}

/** 「実在しない app_id」に対する共通の期待(全ツール共通の異常系)。 */
function expectUnknownAppError(result: CallToolResult): void {
  const errors = errorsOf(result);
  expect(errors).toHaveLength(1);
  expect(errors[0]?.path).toBe("/app_id");
  expect(errors[0]?.message).toContain("nope");
  expect(errors[0]?.allowed_values).toEqual([APP_ID, "expense"]);
}

// --- tools/list -----------------------------------------------------------------

test("参照系7ツールが tools/list に出て、説明文が付いている", async () => {
  const { client, close } = await connectInMemory();
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    // 参照系が**含まれる**ことを見る。完全一致にしないのは、同じサーバに更新系も
    // 加わるためで、公開ツール集合そのものの固定は `write.ts` 側のテスト
    // (全ツールの完全一致)と `descriptions.test.ts` が担当する。
    expect(names).toEqual(
      expect.arrayContaining([
        "get_changelog",
        "get_manifest",
        "get_preview_url",
        "list_apps",
        "list_records",
        "preview_undo",
        // V1-M1-T02。7つ目の参照系。**本体を1バイトも変えない**ので更新系ではない
        // (`scripts/mcp-trial/transcript.ts` の `WRITE_TOOLS` にも入れていない)。
        "dry_run_diff",
      ]),
    );
    for (const tool of listed.tools) {
      expect(tool.description ?? "").not.toBe("");
    }
    // T01 の暫定ツール(`__bootstrap__`)がクライアントから見えていないこと。
    expect(names).not.toContain("__bootstrap__");
  } finally {
    await close();
  }
});

// --- list_apps ------------------------------------------------------------------

test("list_apps は台帳のアプリを作成順に返す", async () => {
  const data = okData(await callTool("list_apps"));
  const apps = data.apps as { app_id: string; name: string; status: string }[];
  expect(apps.map((app) => app.app_id)).toEqual([APP_ID, "expense"]);
  expect(apps[0]?.name).toBe("在庫管理");
  expect(apps[0]?.status).toBe("active");
});

test("list_apps はアプリが1つも無くても空配列を返す(エラーにしない)", async () => {
  const empty = await mkdtemp(join(tmpdir(), "gp-mcp-read-empty-"));
  const previous = dataRoot;
  dataRoot = empty;
  try {
    const data = okData(await callTool("list_apps"));
    expect(data.apps).toEqual([]);
  } finally {
    dataRoot = previous;
    await rm(empty, { recursive: true, force: true });
  }
});

// --- get_manifest ---------------------------------------------------------------

test("get_manifest は現行マニフェストをそのまま返す", async () => {
  const data = okData(await callTool("get_manifest", { app_id: APP_ID }));
  const manifest = data.manifest as Manifest;
  expect(manifest.app.id).toBe(APP_ID);
  expect(manifest.app.tables.map((table) => table.id)).toEqual([TABLE_ID]);
  expect(manifest.app.views.map((view) => view.id)).toEqual([LIST_VIEW_ID]);
});

test("get_manifest は実在しない app_id に統一形式エラーを返す", async () => {
  expectUnknownAppError(await callTool("get_manifest", { app_id: "nope" }));
});

// --- get_changelog --------------------------------------------------------------

test("get_changelog は適用済みの変更履歴を返す", async () => {
  const data = okData(await callTool("get_changelog", { app_id: APP_ID }));
  const changelog = data.changelog as ChangelogEntry[];
  // V1-M0-T05: createApp が書く「第0行」(_create-app)+ setup diff の2件になる。
  // 第0行が実際に見えること自体がこの変更の目的なので、内容まで明示的に確かめる。
  expect(changelog).toHaveLength(2);
  expect(changelog[0]?.diff_id).toBe("_create-app");
  expect(changelog[0]?.intent).toBe(
    "アプリ「在庫管理」を作成した(create_app)。この行はカーネルが記録したもので、ユーザの発話ではない。",
  );
  expect(changelog[0]?.kind).toBe("apply");
  expect(changelog[1]?.diff_id).toBe("setup");
  expect(changelog[1]?.intent).toBe(setupDiff.intent);
  expect(changelog[1]?.kind).toBe("apply");
});

test("get_changelog は実在しない app_id に統一形式エラーを返す", async () => {
  expectUnknownAppError(await callTool("get_changelog", { app_id: "nope" }));
});

// --- get_preview_url ------------------------------------------------------------

test("get_preview_url は view_id 無しでアプリ画面のURLを返す", async () => {
  const data = okData(await callTool("get_preview_url", { app_id: APP_ID }));
  expect(data.url).toBe(`${previewBaseUrl}/apps/${APP_ID}`);
  expect(typeof data.note).toBe("string");
  expect(String(data.note)).not.toBe("");
  // R10: `app_url` は `view_id` 無しの `url` と同じで冗長なので返さない。
  expect(data).not.toHaveProperty("app_url");
});

test("get_preview_url は view_id ありでビュー画面のURLを返す", async () => {
  const data = okData(await callTool("get_preview_url", { app_id: APP_ID, view_id: LIST_VIEW_ID }));
  expect(data.url).toBe(`${previewBaseUrl}/apps/${APP_ID}/views/${LIST_VIEW_ID}`);
});

test("get_preview_url は実在しない view_id に /view_id を指すエラーを返す", async () => {
  const errors = errorsOf(await callTool("get_preview_url", { app_id: APP_ID, view_id: "nope" }));
  expect(errors[0]?.path).toBe("/view_id");
  expect(errors[0]?.allowed_values).toEqual([LIST_VIEW_ID]);
});

test("get_preview_url は実在しない app_id に統一形式エラーを返す", async () => {
  expectUnknownAppError(await callTool("get_preview_url", { app_id: "nope" }));
});

test("get_preview_url が返すURLに実際にHTTPアクセスすると200が返る", async () => {
  // R4: `/apps/<id>` は SPA フォールバック(`src/server/app.ts:588-645`)なので、
  // `index.html` が無いと 404 になる。既存の `web/dist` に依存すると
  // 「`bun run build:web` を先に走らせたかどうか」でテスト結果が変わるため、
  // 一時ディレクトリに自前の `index.html` を用意して `webDistDir` に渡す。
  const webDistDir = await mkdtemp(join(tmpdir(), "gp-mcp-read-dist-"));
  await writeFile(join(webDistDir, "index.html"), "<!doctype html><title>preview</title>", "utf-8");

  const app = createServerApp({ dataRoot, webDistDir });
  // port 0 = OS が空きポートを割り当てる(固定ポートだと並行テストで衝突する)。
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const previous = previewBaseUrl;
  previewBaseUrl = `http://127.0.0.1:${server.port}`;
  try {
    const data = okData(await callTool("get_preview_url", { app_id: APP_ID }));
    const response = await fetch(String(data.url));
    expect(response.status).toBe(200);
    await response.text();

    const viewData = okData(
      await callTool("get_preview_url", { app_id: APP_ID, view_id: LIST_VIEW_ID }),
    );
    const viewResponse = await fetch(String(viewData.url));
    expect(viewResponse.status).toBe(200);
    await viewResponse.text();
  } finally {
    previewBaseUrl = previous;
    await server.stop(true);
    await rm(webDistDir, { recursive: true, force: true });
  }
});

// --- list_records ---------------------------------------------------------------

test("list_records はレコード全件と総件数を返す", async () => {
  const data = okData(await callTool("list_records", { app_id: APP_ID, table_id: TABLE_ID }));
  const records = data.records as RecordRow[];
  expect(records).toHaveLength(3);
  expect(data.total).toBe(3);
  expect(records.map((record) => record.title).sort()).toEqual(["机", "棚", "椅子"].sort());
});

test("list_records は sort / order で並べ替えられる", async () => {
  const data = okData(
    await callTool("list_records", {
      app_id: APP_ID,
      table_id: TABLE_ID,
      sort: "qty",
      order: "desc",
    }),
  );
  const records = data.records as RecordRow[];
  expect(records.map((record) => record.qty)).toEqual([3, 2, 1]);
});

test("list_records の limit は件数を絞るが total は絞らない", async () => {
  // total が絞られてしまうと、LLM は「全部見た」と誤認する。
  const data = okData(
    await callTool("list_records", {
      app_id: APP_ID,
      table_id: TABLE_ID,
      sort: "qty",
      order: "asc",
      limit: 2,
    }),
  );
  const records = data.records as RecordRow[];
  expect(records.map((record) => record.qty)).toEqual([1, 2]);
  expect(data.total).toBe(3);
});

test("list_records は offset で次ページを取れる(limit と併用・total は絞らない。EC-G11)", async () => {
  const data = okData(
    await callTool("list_records", {
      app_id: APP_ID,
      table_id: TABLE_ID,
      sort: "qty",
      order: "asc",
      limit: 1,
      offset: 1,
    }),
  );
  const records = data.records as RecordRow[];
  expect(records.map((record) => record.qty)).toEqual([2]);
  expect(data.total).toBe(3);
});

test("list_records は offset 単独(limit なし)でも先頭をスキップする", async () => {
  const data = okData(
    await callTool("list_records", {
      app_id: APP_ID,
      table_id: TABLE_ID,
      sort: "qty",
      order: "asc",
      offset: 2,
    }),
  );
  const records = data.records as RecordRow[];
  expect(records.map((record) => record.qty)).toEqual([3]);
  expect(data.total).toBe(3);
});

test("list_records は order だけ指定されたら sort が必要だとエラーで伝える", async () => {
  const errors = errorsOf(
    await callTool("list_records", { app_id: APP_ID, table_id: TABLE_ID, order: "desc" }),
  );
  expect(errors[0]?.path).toBe("/sort");
});

// --- list_records の複合ソート(V3-M12-T10)--------------------------------------
//
// v1 の `V1-M0-T03` はマニフェスト側の `sort` を配列化し、カーネルの
// `ListRecordsOptions.sort` も `Sort | Sort[]` を受けるようにした。ところが
// `list_records` の引数だけが1キーのまま残り、**同じカーネル関数に対して
// HTTP は複合ソートを渡せるのに MCP は渡せない**という非対称が生じていた
// (`docs/plan/v1/00-m0-close-v0-gaps.md` §入口の受け皿 の #3。判定は「未審査」)。
// ここで閉じる。**カーネルは1バイトも変えていない** —— 入口を開けただけである。

/** 第1キーが同値になる行を足す(複合ソートの第2キーが効いていることを見分けるため)。 */
function insertTiedRows(): void {
  const manifest = readCurrentManifest(dataRoot, APP_ID);
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    // qty=3 が「椅子」と並ぶ2行。title は ASCII にしてあり、UTF-8 バイト順
    // (SQLite の BINARY collation)で "A" < "B" < "椅" が確定する。
    for (const row of [
      { title: "A", qty: 3 },
      { title: "B", qty: 3 },
    ]) {
      const created = createRecord(db, manifest, TABLE_ID, row);
      if (!created.ok) {
        throw new Error(
          `テスト前提のレコード作成に失敗しました: ${JSON.stringify(created.errors)}`,
        );
      }
    }
  } finally {
    db.close();
  }
}

test("list_records は sort を配列で受け、第2キーが同値の並びを決める(複合ソート)", async () => {
  insertTiedRows();

  const asc = okData(
    await callTool("list_records", {
      app_id: APP_ID,
      table_id: TABLE_ID,
      sort: [
        { field: "qty", order: "desc" },
        { field: "title", order: "asc" },
      ],
    }),
  );
  expect((asc.records as RecordRow[]).map((record) => record.title)).toEqual([
    "A",
    "B",
    "椅子",
    "棚",
    "机",
  ]);

  // 第2キーの向きだけを裏返す。第1キー(qty)の並びは変わらず、同値群の中だけが
  // 逆になる —— これが「第2キーが実際に効いている」ことの証拠である。
  const desc = okData(
    await callTool("list_records", {
      app_id: APP_ID,
      table_id: TABLE_ID,
      sort: [
        { field: "qty", order: "desc" },
        { field: "title", order: "desc" },
      ],
    }),
  );
  expect((desc.records as RecordRow[]).map((record) => record.title)).toEqual([
    "椅子",
    "B",
    "A",
    "棚",
    "机",
  ]);
  expect((desc.records as RecordRow[]).map((record) => record.qty)).toEqual([3, 3, 3, 2, 1]);
});

test("list_records は sort の配列と limit / offset を併用でき、total は絞らない", async () => {
  insertTiedRows();

  const data = okData(
    await callTool("list_records", {
      app_id: APP_ID,
      table_id: TABLE_ID,
      sort: [
        { field: "qty", order: "desc" },
        { field: "title", order: "asc" },
      ],
      limit: 2,
      offset: 1,
    }),
  );
  expect((data.records as RecordRow[]).map((record) => record.title)).toEqual(["B", "椅子"]);
  expect(data.total).toBe(5);
});

test("list_records は sort をマニフェストと同じ単数オブジェクトでも受ける", async () => {
  // `$defs/sort` は単数オブジェクトと配列の両方を受ける。ツール側だけが
  // 受けないと、マニフェストの書き方から一般化した AI が読めない
  // union のエラー(F-21 の失敗形)を踏む。非対称を移し替えないために受ける。
  const data = okData(
    await callTool("list_records", {
      app_id: APP_ID,
      table_id: TABLE_ID,
      sort: { field: "qty", order: "desc" },
    }),
  );
  expect((data.records as RecordRow[]).map((record) => record.qty)).toEqual([3, 2, 1]);
});

test("list_records は sort が配列・オブジェクトのときの order 併用を、統一形式で弾く", async () => {
  // 黙って無視すると「全キーを desc にしたつもり」の誤解が残る(憲法6)。
  for (const sort of [[{ field: "qty", order: "desc" }], { field: "qty", order: "desc" }]) {
    const errors = errorsOf(
      await callTool("list_records", {
        app_id: APP_ID,
        table_id: TABLE_ID,
        sort,
        order: "desc",
      }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/order");
    expect(errors[0]?.message).toContain("order");
  }
});

test("list_records は単数オブジェクトの誤りを /sort/field で示す(添字を付けない)", async () => {
  // 書いた形をそのまま指す(`sortErrorPath`)。配列で書いていないのに
  // `/sort/0/field` と言われたら、利用者は自分の入力と照合できない。
  const errors = errorsOf(
    await callTool("list_records", {
      app_id: APP_ID,
      table_id: TABLE_ID,
      sort: { field: "nope", order: "asc" },
    }),
  );
  expect(errors[0]?.path).toBe("/sort/field");
});

test("list_records は配列の何番目のキーが誤りかを /sort/<index>/field で示す", async () => {
  // path はカーネルの `sortErrorPath` が付ける。MCP 層で組み立て直さない
  // (書いた形をそのまま指す。配列で書いたなら添字つき)。
  const errors = errorsOf(
    await callTool("list_records", {
      app_id: APP_ID,
      table_id: TABLE_ID,
      sort: [
        { field: "qty", order: "desc" },
        { field: "nope", order: "asc" },
      ],
    }),
  );
  expect(errors[0]?.path).toBe("/sort/1/field");
  expect(errors[0]?.allowed_values).toContain("qty");
});

test("list_records は空配列の sort をカーネルの既存エラーのまま返す", async () => {
  // 「並べ替えないなら sort そのものを指定しない」——検証の正はカーネル1つで、
  // MCP 層は独自の文言を作らない(ADR-0003 §7)。
  const errors = errorsOf(
    await callTool("list_records", { app_id: APP_ID, table_id: TABLE_ID, sort: [] }),
  );
  expect(errors[0]?.path).toBe("/sort");
  expect(errors[0]?.message).toContain("空の配列");
});

// **【`V8-M31` 第3波。期待値を反転させた。旧を逐語で残す】**
// **旧のテスト名**: `list_records は実在しないテーブルに allowed_values 付きのエラーを返す`
// **旧の期待値(逐語)**:
// ```
//   const errors = errorsOf(await callTool("list_records", { app_id: APP_ID, table_id: "nope" }));
//   expect(errors[0]?.message).toContain("nope");
//   expect(errors[0]?.allowed_values).toEqual([TABLE_ID]);
// ```
// **反転の理由**: `list_records` が名乗った主体の役割で絞るようになり、**読めない表は
// 断らずに応答から落とす**(空の一覧。`ADR-0305` 限定11 =「その表が在る」ことを役割の外へ
// 漏らさない側に倒す)。**実在しない表 `nope` を名指しした規則はどの役割にも無いので、
// 既定が閉じている今日(`V8-M26` / `D-V8-45`)は「存在しない」ではなく「見せない」に落ちる。**
// **その結果、テーブル名の綴り誤りに対する `allowed_values` 付きの助言は返らなくなった。**
// **名乗り(`actor`)を足すだけでは戻らない** —— 主体は `owner` であり、それでも
// 名指しの規則が無い表は閉じる側に落ちるためである。
test("list_records は実在しないテーブルを、断らずに空の一覧として返す", async () => {
  const data = okData(await callTool("list_records", { app_id: APP_ID, table_id: "nope" }));
  expect(data.records).toEqual([]);
  // **母集団も割らない** —— `total` も可視集合から採るので 0 になる。
  expect(data.total).toBe(0);
});

test("list_records は実在しない app_id に統一形式エラーを返す", async () => {
  expectUnknownAppError(await callTool("list_records", { app_id: "nope", table_id: TABLE_ID }));
});

// --- preview_undo ---------------------------------------------------------------

test("preview_undo は直前の apply を取り消した場合の影響を返す", async () => {
  const data = okData(await callTool("preview_undo", { app_id: APP_ID }));
  const preview = data.preview as UndoPreview;
  expect(preview.diff_id).toBe("setup");
  expect(preview.intent).toBe(setupDiff.intent);
  // setup を取り消すと備品テーブルごと消えるので、3件が失われることが見える。
  expect(preview.lost_records[TABLE_ID]).toBe(3);
  expect(preview.note).not.toBe("");
});

test("preview_undo は取り消せる変更が無いアプリに統一形式エラーを返す", async () => {
  const errors = errorsOf(await callTool("preview_undo", { app_id: "expense" }));
  expect(errors[0]?.message).not.toBe("");
});

test("preview_undo は実在しない app_id に統一形式エラーを返す", async () => {
  expectUnknownAppError(await callTool("preview_undo", { app_id: "nope" }));
});

// --- システムテーブル(ADR-0006 §7 / §10)-------------------------------------------
//
// AI がソースを読めない条件下で `_apps` に辿り着ける唯一の経路が `get_manifest` の
// `system_tables` である(ADR-0006 §10)。読めることと、知れることの両方を固定する。

test("get_manifest は system_tables にシステムテーブルの定義を添えて返す", async () => {
  const data = okData(await callTool("get_manifest", { app_id: APP_ID }));

  const systemTables = data.system_tables as { id: string; fields: { id: string }[] }[];
  expect(systemTables.map((table) => table.id)).toEqual(["_apps", "_changelog", "_ai_usage"]);
  // 列名と型が分かる形(Table 定義そのもの)であること。
  expect(systemTables[0]?.fields.map((field) => field.id)).toEqual([
    "app_id",
    "name",
    "created_at",
    "status",
  ]);
  expect(systemTables[1]?.fields.map((field) => field.id)).toContain("intent");

  // manifest 本体は不変。兄弟フィールドとして並べるのであって、中に混ぜない。
  const manifest = data.manifest as Manifest;
  expect(manifest.app.tables.map((table) => table.id)).toEqual([TABLE_ID]);
});

test("list_records は _apps を読める(count 経路も含めて成功する)", async () => {
  const data = okData(await callTool("list_records", { app_id: APP_ID, table_id: "_apps" }));
  const records = data.records as RecordRow[];
  expect(records.map((record) => record.app_id).sort()).toEqual(["expense", APP_ID]);
  // total は countRecords 経路。ここを覆い漏らすとツール全体が isError になる。
  expect(data.total).toBe(2);
});

test("list_records は _changelog を読める(intent 付き・全アプリ横断)", async () => {
  const data = okData(await callTool("list_records", { app_id: APP_ID, table_id: "_changelog" }));
  const records = data.records as RecordRow[];
  // V1-M0-T05: createApp が2アプリぶんの「第0行」(_create-app)を書くので、
  // setup diff の1件と合わせて3件になる(全アプリ横断なので expense 側も含む)。
  expect(records).toHaveLength(3);
  expect(data.total).toBe(3);
  const setupEntry = records.find((record) => record.diff_id === "setup");
  expect(setupEntry?.intent).toBe(setupDiff.intent);
  // 第0行が実際に見えること(= このタスクの目的そのもの)を明示的に確かめる。
  const createEntry = records.find(
    (record) => record.app_id === APP_ID && record.diff_id === "_create-app",
  );
  expect(createEntry?.intent).toBe(
    "アプリ「在庫管理」を作成した(create_app)。この行はカーネルが記録したもので、ユーザの発話ではない。",
  );
});

test("list_records はシステムテーブルでも sort / limit が効く", async () => {
  const data = okData(
    await callTool("list_records", {
      app_id: APP_ID,
      table_id: "_apps",
      sort: "app_id",
      order: "desc",
      limit: 1,
    }),
  );
  const records = data.records as RecordRow[];
  expect(records.map((record) => record.app_id)).toEqual([APP_ID]);
  // limit は records だけを絞る。total はテーブル全体の件数のまま。
  expect(data.total).toBe(2);
});

// **【`V8-M31` 第3波。期待値を反転させた。旧を逐語で残す】**
// **旧のテスト名**: `list_records は app.sqlite が無くてもシステムテーブルを読める`
// **旧の期待値(逐語)**:
// ```
//   await rm(appDbPath(dataRoot, APP_ID), { force: true });
//   const data = okData(await callTool("list_records", { app_id: APP_ID, table_id: "_apps" }));
//   expect((data.records as RecordRow[]).length).toBe(2);
// ```
// **反転の理由**: **利用者と役割は各アプリの `app.sqlite` の中(`_auth_*`)に在る**
// (`AuthStore.openForApp`)。**`V8-M31` は全ツールの入口で名乗りを解決するようにしたので、
// `app.sqlite` を消すと利用者そのものが消え、システムテーブルに辿り着く前に
// 「名乗った利用者は、このアプリに登録されていません。」で止まる。**
// **`judgeRoleAccess` はシステムの表を判定しない(`D-V8-69`)が、その手前の名乗りの解決は
// システムの表でも免除されていない。** **名乗りを足しても戻らない**(足した名乗りの
// 置き場所ごと消えるため)。
// **失われた保証**: `app.sqlite` が無いアプリでも `_apps` を読めること。
test("list_records は app.sqlite が無いと、システムテーブルにも辿り着けない(名乗りが解決できない)", async () => {
  await rm(appDbPath(dataRoot, APP_ID), { force: true });
  const errors = errorsOf(await callTool("list_records", { app_id: APP_ID, table_id: "_apps" }));
  expect(errors).toHaveLength(1);
  expect(errors[0]?.message).toContain("登録されていません");
});

// --- dry_run_diff(V1-M1-T02)-------------------------------------------------------
//
// カーネル側の性質(本体不変 / レポートと実適用の一致)は `src/kernel/dry-run.test.ts` が
// 固定している。ここで見るのは **MCP 層を通っても同じであること**だけである。
// 参照系ツールとして登録されている以上、`list_apps` などと同じく「呼んでも何も起きない」
// のが正しい。
//
// **【2026-08-25 追記(`V10-M28-T02` / `T03` / `ADR-0376`)。上の行を1バイトも消していない】**
// **「呼んでも何も起きない」は今日も正しいが、「誰でも呼べる」は今日は偽である** ——
// **`apply_diff` とまったく同じ判定(`app` × `write`)が、`intent` の検査より**前**に掛かる。**
// **このファイルの名乗り(`ACTOR`)は既定ロール(`owner`)であり、`createApp` が持ち主に
// 規則を2行入れる**(`{ target: "app", can: ["write"] }` / `{ target: "role", can: ["write"] }`)
// **ので、下の検査は着手前と1本も変わらずに通る。** **断られる側の実測は
// `src/mcp/app-setting-write-guard.test.ts` が経路ごとに別々に持つ。**

test("dry_run_diff はレポートを返し、アプリの状態を1つも変えない", async () => {
  const before = readCurrentManifest(dataRoot, APP_ID);
  const beforeSnapshots = listSnapshots(dataRoot, APP_ID);

  const data = okData(
    await callTool("dry_run_diff", {
      app_id: APP_ID,
      diff: {
        diff_id: "d-dry",
        intent: "備品に置き場所を持たせたい",
        operations: [
          {
            op: "add_field",
            table: TABLE_ID,
            field: { id: "place", name: "置き場所", type: "text" },
          },
        ],
      },
    }),
  );

  const report = data.report as {
    manifest: Manifest;
    schema: Record<string, string[]>;
    impacts: { table: string; affected_rows: number; added_columns: string[] }[];
    role_condition_notices: unknown[];
    note: string;
  };

  // 適用後の姿を返している。
  expect(report.schema[TABLE_ID]).toContain("place");
  expect(report.impacts.find((impact) => impact.table === TABLE_ID)).toMatchObject({
    added_columns: ["place"],
    affected_rows: 3,
  });
  expect(report.note).toBe(DRY_RUN_NOTE);

  // **【`V8-M18` / 台帳 `J-G16`。裁定 `R-17-6`】誰も通さない条件・全員を通す条件の知らせが、
  // `dry_run_diff` の側にも出る** —— **矛盾が無ければ空配列であり、欄そのものは常に在る**
  // (「黙って何もしない」を作らない)。**この差分は役割を1つも触っていないので空である。**
  expect(report.role_condition_notices).toEqual([]);

  // しかし本体は変わっていない。
  expect(readCurrentManifest(dataRoot, APP_ID)).toEqual(before);
  expect(listSnapshots(dataRoot, APP_ID)).toEqual(beforeSnapshots);
});

test("dry_run_diff の拒否は apply_diff と同じ統一形式で返る", async () => {
  const errors = errorsOf(
    await callTool("dry_run_diff", {
      app_id: APP_ID,
      diff: {
        diff_id: "d-bad",
        intent: "存在しないテーブルに列を足そうとする",
        operations: [
          { op: "add_field", table: "ghosts", field: { id: "x", name: "X", type: "text" } },
        ],
      },
    }),
  );
  expect(errors.length).toBeGreaterThan(0);
  expect(errors[0]?.path).toBe("/operations/0/table");
  expect(errors[0]?.allowed_values).toContain(TABLE_ID);
});

test("dry_run_diff は存在しない app_id を統一形式で断る", async () => {
  const errors = errorsOf(
    await callTool("dry_run_diff", {
      app_id: "nope",
      diff: { diff_id: "d-x", intent: "何か", operations: [] },
    }),
  );
  expect(errors[0]?.path).toBe("/app_id");
});

// --- 【`V10-M28-T03`】報告から認証まわりを落とす ---------------------------------------
//
// **落とす層は MCP(この `read.ts` の `toolOk` の手前)であり、`src/kernel/` ではない。**
// **`src/kernel/dry-run.ts` は1バイトも変えていない** —— **`src/kernel/dry-run.test.ts` と
// `src/kernel/apply-diff.test.ts` が「`report.schema` が実 SQLite スキーマの**全量**と
// 一致する」を固定しており、カーネルで落とすとその2本が確実に赤くなる。**
// **カーネルのレポートは今日どおり全量であり、絞っているのは MCP が返す1経路だけである。**
//
// **【落とす綴りは接頭辞1つである】** —— **表名を列挙していない。** **実物は
// `_auth_activity` / `_auth_users` / `_auth_webauthn_credentials` /
// `_auth_password_credentials` / `_auth_sessions` / `_auth_pending_challenges` /
// `_auth_user_roles` / `_auth_invitations` の8本あり、3本だけ挙げれば漏れる。**

/** そのアプリの `app.sqlite` に実在する表の名前(実体を直に読む)。 */
function realTableNames(appId: string): string[] {
  const db = new Database(appDbPath(dataRoot, appId), { readonly: true });
  try {
    return db
      .query<{ name: string }, []>(
        `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%' ORDER BY "name"`,
      )
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

test("V10-M28-T03: dry_run_diff の schema と impacts に _auth_ の表が1件も無い", async () => {
  // **陽性対照** —— **実体には `_auth_` の表が在る**(落とすものが無い空振りではない)。
  const real = realTableNames(APP_ID).filter((name) => name.startsWith("_auth_"));
  expect(real.length).toBeGreaterThan(0);

  const data = okData(
    await callTool("dry_run_diff", {
      app_id: APP_ID,
      diff: {
        diff_id: "d-scrub",
        intent: "備品に置き場所を持たせたい",
        operations: [
          {
            op: "add_field",
            table: TABLE_ID,
            field: { id: "place", name: "置き場所", type: "text" },
          },
        ],
      },
    }),
  );
  const report = data.report as {
    schema: Record<string, string[]>;
    impacts: { table: string }[];
  };

  expect(Object.keys(report.schema).filter((table) => table.startsWith("_auth_"))).toEqual([]);
  expect(
    report.impacts.map((impact) => impact.table).filter((t) => t.startsWith("_auth_")),
  ).toEqual([]);

  // **アプリ自身の表は今日どおり返る**(絞りすぎていないことを測る)。
  expect(report.schema[TABLE_ID]).toContain("place");
  expect(report.impacts.map((impact) => impact.table)).toContain(TABLE_ID);
});

test("V10-M28-T03: カーネルのレポートは今日どおり全量である(落としているのは MCP だけ)", () => {
  // **同じ差分をカーネルの `dryRunDiff` に直に渡すと、`_auth_` の表がそのまま入っている。**
  // **これが「落とす層は MCP である」ことの実測である** —— **ここが空になったら、
  // カーネルを書き換えてしまっている。**
  const result = dryRunDiff(dataRoot, APP_ID, {
    diff_id: "d-kernel-full",
    intent: "備品に置き場所を持たせたい",
    operations: [
      { op: "add_field", table: TABLE_ID, field: { id: "place", name: "置き場所", type: "text" } },
    ],
  });
  expect(result.valid).toBe(true);
  if (!result.valid) return;
  expect(
    Object.keys(result.report.schema).filter((table) => table.startsWith("_auth_")).length,
  ).toBeGreaterThan(0);
});

test("dry_run_diff は intent が空なら apply_diff と同じ位置で断る", async () => {
  const errors = errorsOf(
    await callTool("dry_run_diff", {
      app_id: APP_ID,
      diff: { diff_id: "d-x", intent: "  ", operations: [] },
    }),
  );
  expect(errors[0]?.path).toBe("/diff/intent");
});

// --- 8. generate_requirements_doc(V1-M8-T02 / ADR-0025 §10)---------------------------
//
// 入口層はカーネル(`generateRequirementsDoc`)を呼んで整形するだけである(限定9)。
// ここで見るのは**整形が出典を落としていないこと**と、`section` の絞り込みが
// カーネルの節分類そのものに従っていることの2点で、文書の中身の正しさは
// `src/kernel/requirements-doc.test.ts` の担当である。

/** `requirements_doc` を取り出す(構造は format で分岐する)。 */
function requirementsDocOf(result: CallToolResult): Record<string, unknown> {
  const data = okData(result);
  expect(data.requirements_doc).toBeDefined();
  return data.requirements_doc as Record<string, unknown>;
}

test("generate_requirements_doc は既定で markdown を返し、出典を落とさない", async () => {
  const doc = requirementsDocOf(await callTool("generate_requirements_doc", { app_id: APP_ID }));

  expect(doc.app_id).toBe(APP_ID);
  expect(doc.format).toBe("markdown");
  expect(doc.section).toBeNull();
  expect(typeof doc.markdown).toBe("string");
  expect(doc.markdown as string).toContain("# 要件定義書");

  // **出典が落ちていないこと。** markdown 文字列だけを返すと出典欄が消えるので、
  // statement ごとの出典表を併せて返す(ADR-0025 §10 / 限定9)。
  const sources = doc.sources as { statement_id: string; sources: unknown[] }[];
  expect(sources.length).toBeGreaterThan(0);
  for (const entry of sources) {
    expect(typeof entry.statement_id).toBe("string");
    expect(entry.sources.length).toBeGreaterThan(0);
  }
});

test("generate_requirements_doc の json は statements と実在集合を返す", async () => {
  const doc = requirementsDocOf(
    await callTool("generate_requirements_doc", { app_id: APP_ID, format: "json" }),
  );

  expect(doc.format).toBe("json");
  const statements = doc.statements as { id: string; section: string; sources: unknown[] }[];
  expect(statements.length).toBeGreaterThan(0);
  // 確認方法2(出典欄が空の記述が0件)を、この入口でも全数で見る。
  for (const statement of statements) {
    expect(statement.sources.length).toBeGreaterThan(0);
  }
  // markdown も併せて返す(同じ生成物の別表現なので、片方だけにしない)。
  expect(typeof doc.markdown).toBe("string");
  expect((doc.identifiers as Record<string, string[]>).app_id).toEqual([APP_ID]);
});

test("generate_requirements_doc の section は、その節の記述だけに絞る", async () => {
  const all = requirementsDocOf(
    await callTool("generate_requirements_doc", { app_id: APP_ID, format: "json" }),
  );
  const allStatements = all.statements as { section: string }[];

  const history = requirementsDocOf(
    await callTool("generate_requirements_doc", {
      app_id: APP_ID,
      format: "json",
      section: "history",
    }),
  );
  const historyStatements = history.statements as { section: string }[];

  expect(history.section).toBe("history");
  expect(historyStatements.length).toBeGreaterThan(0);
  expect(historyStatements.every((statement) => statement.section === "history")).toBe(true);
  // 期待値はフィクスチャではなく**全体の応答から導く**(件数を焼き込まない)。
  expect(historyStatements.length).toBe(
    allStatements.filter((statement) => statement.section === "history").length,
  );
  expect(historyStatements.length).toBeLessThan(allStatements.length);
});

test("generate_requirements_doc の markdown は section で絞っても骨格を保つ", async () => {
  const doc = requirementsDocOf(
    await callTool("generate_requirements_doc", { app_id: APP_ID, section: "overview" }),
  );
  // 見出し・前書きは statements に依存しない定数なので、絞っても消えない。
  expect(doc.markdown as string).toContain("## 履歴");
  expect(doc.markdown as string).toContain("この節に該当する記述はない。");
});

test("generate_requirements_doc は語彙外の section を受け付けない", async () => {
  const result = await callTool("generate_requirements_doc", {
    app_id: APP_ID,
    section: "nonexistent",
  });
  expect(result.isError).toBe(true);
});

test("generate_requirements_doc は存在しない app_id を統一形式で断る", async () => {
  expectUnknownAppError(await callTool("generate_requirements_doc", { app_id: "nope" }));
});
