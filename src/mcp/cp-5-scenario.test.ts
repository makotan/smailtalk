/**
 * CP-5 統合シナリオテスト(docs/plan/v0/06-mcp-server.md チェックポイント CP-5-1)。
 *
 * `src/kernel/cp-4-scenario.test.ts` と **同じシナリオ・同じアサーション**を、
 * **MCP ツール呼び出しだけ**で再現する。CP-5 の検証方法がそう書いている
 * (「CP-4のライフサイクルシナリオをMCPツール呼び出しだけで実行して同じ
 * アサーションが通る」)。
 *
 * ## なぜ CP-4 のコピーに意味があるのか
 *
 * CP-4 は「カーネルとしてループが閉じる」ことを示した。CP-5 が示すのは
 * 「**MCP クライアント(= LLM)から見てもループが閉じる**」ことである。この2つは
 * 別の主張である。カーネルが正しくても、MCP の入口が
 *
 * - 必要な情報を返していない(例: 作られたレコードの `_id` を返さない)
 * - 必要な観測手段が無い(例: レコードを読むツールが無い)
 * - 例外を漏らす(統一形式でないエラーは LLM が自己修正できない)
 *
 * のいずれかであれば、会話だけではループが回らない。**同じアサーションを
 * ツール越しに通す**ことが、その3点をまとめて潰す唯一の確かめ方になる。
 * 実際、このテストを書くために `list_records` と `preview_undo` の2ツールを
 * 追加した(ADR-0005)。「テストが通らないから増やした」のではなく、
 * 「LLM にも同じことができなければ嘘になるから増やした」のである。
 *
 * ## MCP を通さずに直接読んでいる2点(と、その理由)
 *
 * 1. **スナップショットのディレクトリ一覧・実ファイルの存在**(`listSnapshots` / `existsSync`)
 * 2. **SQLite のスキーマ**(`sqlite_master` / `PRAGMA table_info`)
 *
 * どちらも意図的にツール化していない。これらは v0 の語彙
 * (リソース5種・フィールド型7種・additive 4操作)の**外側にある実装の詳細**であり、
 * LLM に見せる必要が無い —— 見せれば「スナップショットを直接いじる」「SQLite の
 * 型を意識して差分を組む」といった、語彙の外の発想を誘発する。
 * 一方でテストとしては「本当にディスク上で起きたか」を確かめる必要がある。
 * よってこの2点だけはカーネル/ファイルシステムを直接読む。それ以外
 * —— レコード・マニフェスト・変更履歴・undo の予告 —— は**すべてツール経由**である。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  appDbPath,
  type ChangelogEntry,
  type Diff,
  listSnapshots,
  type Manifest,
  quoteIdentifier,
  type RecordRow,
  snapshotDir,
  UNDO_PREVIEW_NOTE,
  type UndoPreview,
  type ValidationError,
} from "../kernel/index.ts";
import { seedSession } from "../server/test-helpers.ts";
import { createMcpServer } from "./server.ts";

const APP_ID = "book-tracker";
const APP_NAME = "蔵書管理";
const PREVIEW_BASE_URL = "http://127.0.0.1:3000";

/**
 * **【`V8-M31` 第3波。名乗りを足しただけで、期待値は1つも変えていない】**
 *
 * `V8-M31` が MCP に**名乗り**(どの利用者として動くか)を入れたので、
 * `createMcpServer` に `actor` を渡さないと23本のツールがすべて `isError` になる。
 * **【2026-08-16 訂正(`V8-M13-T04`)。直前の1行を1バイトも書き換えていない】この「23本」は今日は24本である**
 * (`V8-M13-T02` が `read_report` を足した)。**渡さないと全部が `isError` になることは1ミリも変わっていない。**
 * **【2026-08-24 訂正(`V10-M12-T01`。`ADR-0368`)。直前の1行を1バイトも書き換えていない】直前の「24本」は今日は25本である**
 * (`V10-M12-T01` が `list_comments` を足した)。**渡さないと全部が `isError` になることは今日も1ミリも変わっていない。**
 * **【2026-08-26 訂正(`V10-M34-T01`。台帳 `CM-G45` / `ADR-0379`)。直前の1行を1バイトも書き換えていない】直前の「25本」は今日は26本である**
 * (`V10-M30-T02` が `set_comment_visibility` を足した)。**渡さないと全部が `isError` になることは今日も1ミリも変わっていない。**
 * **CP-5 が示すのは「MCP クライアント(= LLM)から見てもループが閉じる」ことである** ——
 * よって `seedSession` の既定(`owner`)で1人だけ作り、シナリオの途中の拒否が
 * 「権限が無い」に化けないようにしてある。**シナリオのアサーションは1つも変えていない。**
 */
const ACTOR = "mcp-actor";

let dataRoot = "";
let client: Client;
let closeConnection: () => Promise<void>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-cp5-scenario-"));
  // シナリオ全体を**1本の接続**で通す。ツールごとに繋ぎ直すと、実際の
  // Claude Code のセッション(1本の接続で会話が続く)と条件が変わってしまう。
  const server = createMcpServer({ dataRoot, previewBaseUrl: PREVIEW_BASE_URL, actor: ACTOR });
  client = new Client({ name: "cp-5-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  closeConnection = async () => {
    await client.close();
    await server.close();
  };
});

afterEach(async () => {
  await closeConnection();
  await rm(dataRoot, { recursive: true, force: true });
});

// --- MCP 呼び出しヘルパ ----------------------------------------------------------

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

/** 成功結果の `structuredContent`。失敗していたら中身を添えて落とす(原因追跡のため)。 */
async function callOk(
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const result = await call(name, args);
  expect(result.isError, `${name}: ${JSON.stringify(result.structuredContent)}`).toBeFalsy();
  return result.structuredContent as Record<string, unknown>;
}

/** 失敗結果のエラー配列。 */
function errorsOf(result: CallToolResult): ValidationError[] {
  expect(result.isError).toBe(true);
  const structured = result.structuredContent as { errors: ValidationError[] } | undefined;
  expect(structured?.errors).toBeDefined();
  return structured?.errors ?? [];
}

// --- 観測ヘルパ ------------------------------------------------------------------

/** 現行マニフェストを MCP 経由で読む。 */
async function manifestVia(): Promise<Manifest> {
  return (await callOk("get_manifest", { app_id: APP_ID })).manifest as Manifest;
}

/** 変更履歴を MCP 経由で読む。 */
async function changelogVia(): Promise<ChangelogEntry[]> {
  return (await callOk("get_changelog", { app_id: APP_ID })).changelog as ChangelogEntry[];
}

/**
 * マニフェストに載っている全テーブルの全レコードを `_id` 昇順で読む(MCP 経由)。
 * CP-4 の `readAllRecords` と同じ観測値を、`list_records` ツールだけで作る。
 */
async function readAllRecords(): Promise<Record<string, RecordRow[]>> {
  const manifest = await manifestVia();
  const out: Record<string, RecordRow[]> = {};
  for (const table of manifest.app.tables) {
    const data = await callOk("list_records", { app_id: APP_ID, table_id: table.id });
    const records = data.records as RecordRow[];
    // `total` が絞られていないこと(= 全件見えていること)も毎回確かめる。
    expect(data.total).toBe(records.length);
    out[table.id] = [...records].sort((a, b) => a._id.localeCompare(b._id));
  }
  return out;
}

/** テーブルID → `_id` の集合(件数一致で済ませないための比較軸)。 */
function idSets(records: Record<string, RecordRow[]>): Record<string, Set<string>> {
  return Object.fromEntries(
    Object.entries(records).map(([tableId, rows]) => [tableId, new Set(rows.map((r) => r._id))]),
  );
}

// --- 直接読む2点(ファイル冒頭の理由を参照)---------------------------------------

function withAppDb<T>(fn: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * アプリのテーブル名(`_id` 昇順ではなく名前順)。
 *
 * **【`V8-M31` 第3波。`_auth_*` を数えないようにした。期待値は1つも変えていない】**
 *
 * **`_auth_*` の7本は、このシナリオの `seedSession`(名乗った利用者を実在させる1行)が
 * `app.sqlite` に作る予約テーブルである** —— `_auth_users` /
 * `_auth_webauthn_credentials` / `_auth_password_credentials` / `_auth_sessions` /
 * `_auth_pending_challenges` / `_auth_activity` / `_auth_user_roles`。
 * **利用者が1人でも居る本番のアプリでは常に在るもので、差分が作るものではない。**
 * **このシナリオが見ているのは「差分が物理スキーマを作ったか」だけなので、
 * 予約テーブルは数から外す** —— 期待値(`["authors", "books"]` など)は
 * `V8-M31` の前と1文字も変えていない。
 */
function tableNames(db: Database): string[] {
  return (
    db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table'" +
          " AND name NOT LIKE '\\_auth\\_%' ESCAPE '\\' ORDER BY name",
      )
      .all() as {
      name: string;
    }[]
  ).map((row) => row.name);
}

function columnTypes(db: Database, tableId: string): Record<string, string> {
  const rows = db.query(`PRAGMA table_info(${quoteIdentifier(tableId)})`).all() as {
    name: string;
    type: string;
  }[];
  return Object.fromEntries(rows.map((row) => [row.name, row.type]));
}

/** SQLite の実スキーマ(MCP には出さない実装詳細なので直接読む)。 */
function schemaOnDisk(): Record<string, Record<string, string>> {
  return withAppDb((db) =>
    Object.fromEntries(tableNames(db).map((name) => [name, columnTypes(db, name)])),
  );
}

/** スナップショットが2ファイル揃って実在することを確かめる(同上)。 */
function expectSnapshotOnDisk(name: string): void {
  const dir = snapshotDir(dataRoot, APP_ID, name);
  expect(existsSync(join(dir, "manifest.json"))).toBe(true);
  expect(existsSync(join(dir, "app.sqlite"))).toBe(true);
}

/** 「状態」のスナップショット。CP-4 の `observe()` と同じ5点。 */
type Observed = {
  manifest: Manifest;
  schema: Record<string, Record<string, string>>;
  records: Record<string, RecordRow[]>;
  changelog: ChangelogEntry[];
  snapshots: string[];
};

async function observe(): Promise<Observed> {
  return {
    manifest: await manifestVia(),
    schema: schemaOnDisk(),
    records: await readAllRecords(),
    changelog: await changelogVia(),
    snapshots: listSnapshots(dataRoot, APP_ID),
  };
}

// --- 差分パッチ(CP-4 と同一)------------------------------------------------------

/** diff#1: アプリ誕生時の要件。7型すべてを含む器を作る。 */
const DIFF_1: Diff = {
  diff_id: "d-001-book-tracker",
  intent:
    "読んだ本を記録して読書状況を管理したい。著者ごとに本をたどれるようにもしたいので、著者は別テーブルにして参照でつなぐ",
  operations: [
    {
      op: "add_table",
      table: {
        id: "authors",
        name: "著者",
        fields: [{ id: "name", name: "氏名", type: "text", required: true }],
      },
    },
    {
      op: "add_table",
      table: {
        id: "books",
        name: "書籍",
        fields: [
          { id: "title", name: "タイトル", type: "text", required: true },
          { id: "status", name: "状態", type: "select", options: ["未読", "読書中", "読了"] },
          { id: "finished_at", name: "読了日", type: "date" },
          { id: "memo", name: "メモ", type: "long_text" },
          { id: "pages", name: "ページ数", type: "number" },
          { id: "owned", name: "所有", type: "boolean" },
          { id: "author", name: "著者", type: "reference", reference_table: "authors" },
        ],
      },
    },
    {
      op: "add_view",
      view: {
        id: "book-list",
        type: "list_view",
        table: "books",
        columns: ["title", "status"],
        sort: { field: "finished_at", order: "desc" },
      },
    },
    {
      op: "add_view",
      view: {
        id: "book-form",
        type: "form",
        table: "books",
        fields: ["title", "status", "finished_at", "memo", "pages", "owned", "author"],
      },
    },
    { op: "add_view", view: { id: "book-detail", type: "detail_view", table: "books" } },
  ],
};

/** diff#2: 「add_field + update_view」の組。 */
const DIFF_2: Diff = {
  diff_id: "d-002-rating",
  intent: "読んだ本に5段階の評価を付けて、一覧でも評価が見えるようにしたい",
  operations: [
    { op: "add_field", table: "books", field: { id: "rating", name: "評価", type: "number" } },
    { op: "update_view", view: "book-list", changes: { columns: ["title", "status", "rating"] } },
  ],
};

/** diff#3: 別の要望(タグで本を分類したい)。undo の対象になる。 */
const DIFF_3: Diff = {
  diff_id: "d-003-tags",
  intent: "本をタグで分類して、あとからタグの一覧を見られるようにしたい",
  operations: [
    {
      op: "add_table",
      table: {
        id: "tags",
        name: "タグ",
        fields: [{ id: "label", name: "ラベル", type: "text", required: true }],
      },
    },
    {
      op: "add_view",
      view: { id: "tag-list", type: "list_view", table: "tags", columns: ["label"] },
    },
  ],
};

/** list_view の列を取り出す(型を絞る。見つからなければテストの前提が壊れている)。 */
function listViewColumns(manifest: Manifest): string[] {
  const view = manifest.app.views.find((candidate) => candidate.id === "book-list");
  if (view === undefined || view.type !== "list_view") {
    throw new Error("book-list が list_view として見つかりません(テストの前提が壊れている)。");
  }
  return view.columns;
}

// --- シナリオ本体 ----------------------------------------------------------------

test("CP-5 シナリオ: MCPツールだけで 作成→初期diff→データ投入→diff#2→diff#3→undo→破壊的diff拒否", async () => {
  // === ステップ1: create_app → 初期マニフェスト適用 → データ投入 ===

  const createdData = await callOk("create_app", { name: APP_NAME, app_id: APP_ID });
  // **アプリが出来た直後に、名乗った利用者を実在させる**(`create_app` は名乗りだけで通るが、
  // 以降の `apply_diff` / `insert_sample_data` / `undo` は「そのアプリに登録済みか」を解決する)。
  // **この1行が作るのは `_auth_*` の予約テーブルだけで、アプリのテーブル・レコード・
  // changelog・スナップショットには1バイトも触れない**(下のアサーションが全部それを見ている)。
  seedSession(dataRoot, APP_ID, { username: ACTOR });
  const createdApp = createdData.app as { app_id: string; name: string };
  expect(createdApp.app_id).toBe(APP_ID);
  expect(createdApp.name).toBe(APP_NAME);
  // create_app が書くのは空マニフェスト。ここから先の形はすべて差分が作る。
  const created = createdData.manifest as Manifest;
  expect(created.app.tables).toEqual([]);
  expect(created.app.views).toEqual([]);
  // 作った直後に人間へ見せられるURLが返る(会話だけで確認まで到達できる)。
  expect(createdData.preview_url).toBe(`${PREVIEW_BASE_URL}/apps/${APP_ID}`);
  // V1-M0-T05: create_app は changelog に「第0行」(_create-app)を1件書く。
  // これが「アプリを作成した」ことが人間にも見える唯一の経路になるので、
  // 存在するだけでなく内容(intent の文面)まで明示的に確かめる。
  const changelogAfterCreate = await changelogVia();
  expect(changelogAfterCreate).toHaveLength(1);
  expect(changelogAfterCreate[0]?.diff_id).toBe("_create-app");
  expect(changelogAfterCreate[0]?.intent).toBe(
    `アプリ「${APP_NAME}」を作成した(create_app)。この行はカーネルが記録したもので、ユーザの発話ではない。`,
  );
  expect(changelogAfterCreate[0]?.kind).toBe("apply");
  expect(changelogAfterCreate[0]?.operations).toEqual([]);
  expect(changelogAfterCreate[0]?.snapshot).toBeNull();
  expect(changelogAfterCreate[0]?.undo_target_seq).toBeNull();
  expect(listSnapshots(dataRoot, APP_ID)).toEqual([]);

  // 初期マニフェストも apply_diff で構築する(CP-4 の設計判断と同じ。changelog の
  // 1件目に「なぜこのアプリに書籍テーブルがあるのか」が残る形にするため)。
  const applied1 = await callOk("apply_diff", { app_id: APP_ID, diff: DIFF_1 });
  expect(applied1.snapshot).toBe("0001-d-001-book-tracker");
  expectSnapshotOnDisk(String(applied1.snapshot));
  const entry1 = applied1.entry as ChangelogEntry;
  expect(entry1.kind).toBe("apply");
  expect(entry1.snapshot).toBe(String(applied1.snapshot));

  // マイグレーションが7型ぶんの列を作っている(SQLite の実スキーマは直接読む)。
  expect(withAppDb((db) => tableNames(db))).toEqual(["authors", "books"]);
  expect(withAppDb((db) => columnTypes(db, "books"))).toEqual({
    _id: "TEXT",
    _created_at: "TEXT",
    _updated_at: "TEXT",
    title: "TEXT", // text
    status: "TEXT", // select
    finished_at: "TEXT", // date
    memo: "TEXT", // long_text
    pages: "NUMERIC", // number
    owned: "INTEGER", // boolean
    author: "TEXT", // reference
  });

  // データ投入: 著者1件 + 書籍5件(7型すべてに値が入る)。
  // `insert_sample_data` が作られたレコードを `_id` 付きで返すからこそ、
  // 次の投入で reference フィールドをその `_id` で埋められる。LLM が会話だけで
  // 参照付きのデータを作れるかは、この1点にかかっている。
  const authorInsert = await callOk("insert_sample_data", {
    app_id: APP_ID,
    table_id: "authors",
    rows: [{ name: "夏目 漱石" }],
  });
  expect(authorInsert.failed).toEqual([]);
  const authorRows = authorInsert.inserted as RecordRow[];
  const authorId = authorRows[0]?._id;
  if (authorId === undefined) {
    throw new Error("著者の投入結果に _id がありません(直前のアサートが通れば起きない)。");
  }

  const statuses = ["未読", "読書中", "読了"] as const;
  const bookInsert = await callOk("insert_sample_data", {
    app_id: APP_ID,
    table_id: "books",
    rows: Array.from({ length: 5 }, (_unused, i) => ({
      title: `蔵書 ${i + 1}`,
      status: statuses[i % 3],
      finished_at: `2026-0${i + 1}-1${i}`,
      memo: `メモ ${i}\n2行目に "引用符" とカンマ, を含む`,
      pages: i % 2 === 0 ? 100 + i : 12.5 + i,
      owned: i % 2 === 0,
      author: authorId,
    })),
  });
  expect(bookInsert.failed).toEqual([]);
  const seeded = bookInsert.inserted as RecordRow[];
  expect(new Set(seeded.map((row) => row._id)).size).toBe(5);

  const afterSeed = await observe();
  expect(Object.keys(afterSeed.records).sort()).toEqual(["authors", "books"]);
  expect(afterSeed.records.books).toHaveLength(5);

  // === ステップ2: diff#2(add_field + update_view)→ 既存データ無傷 + 画面反映 ===

  // CP-4 はここで「画面反映」を稼働中の HTTP サーバの応答として観測していた。
  // CP-5 では **MCP から見た反映**を観測する。LLM が変更の結果を確認する手段は
  // get_manifest と list_records しかないので、そこに現れなければ
  // 「AIが自分で確認して報告する」というループが成立しない。
  // ブラウザ上の反映は web/e2e/apply-diff-reflection.e2e.ts が実ブラウザで担保している。
  const manifestBefore2 = await manifestVia();
  const recordsBefore2 = (await readAllRecords()).books ?? [];
  expect(listViewColumns(manifestBefore2)).toEqual(["title", "status"]);
  expect(recordsBefore2.every((row) => !("rating" in row))).toBe(true);

  const applied2 = await callOk("apply_diff", { app_id: APP_ID, diff: DIFF_2 });
  expect(applied2.snapshot).toBe("0002-d-002-rating");
  expectSnapshotOnDisk(String(applied2.snapshot));
  const plan2 = applied2.plan as { add_fields: { table: string; field: { id: string } }[] };
  expect(plan2.add_fields.map((step) => `${step.table}.${step.field.id}`)).toEqual([
    "books.rating",
  ]);

  // (a) 反映: 同じ接続の同じツールが、適用後の姿を返すようになっている。
  const manifestAfter2 = await manifestVia();
  expect(listViewColumns(manifestAfter2)).toEqual(["title", "status", "rating"]);

  // (b) 既存データ無傷: `_id` の集合が一致し、かつ各行の全フィールドが元のまま
  //     (新列 rating だけが null で増える)。件数一致では済ませない。
  const afterDiff2 = await observe();
  expect(afterDiff2.records.books?.every((row) => row.rating === null)).toBe(true);
  expect(idSets(afterDiff2.records)).toEqual(idSets(afterSeed.records));
  const booksAfter2 = new Map(afterDiff2.records.books?.map((row) => [row._id, row]) ?? []);
  for (const original of seeded) {
    expect(booksAfter2.get(original._id)).toEqual({ ...original, rating: null });
  }
  expect(afterDiff2.records.authors).toEqual(afterSeed.records.authors ?? []);

  // === ステップ3: diff#3 → changelog に3件、各 intent が読める ===

  // undo の比較基準は「diff#3 を適用する直前」の状態である。ここで採っておく。
  const beforeDiff3 = await observe();

  const applied3 = await callOk("apply_diff", { app_id: APP_ID, diff: DIFF_3 });
  expect(applied3.snapshot).toBe("0003-d-003-tags");
  expectSnapshotOnDisk(String(applied3.snapshot));

  const changelog3 = await changelogVia();
  // createApp の第0行(_create-app)+ 3回の apply で4件になる。
  expect(changelog3).toHaveLength(4);
  expect(changelog3.map((entry) => entry.diff_id)).toEqual([
    "_create-app",
    DIFF_1.diff_id,
    DIFF_2.diff_id,
    DIFF_3.diff_id,
  ]);
  expect(changelog3.map((entry) => entry.kind)).toEqual(["apply", "apply", "apply", "apply"]);
  // 「各 intent が読める」= 記録された intent が入力した日本語文そのものであること。
  // MCP の入口が要約・切り詰めを挟んでいたらここで落ちる(憲法5)。第0行はカーネルの
  // 固定文であり diff の intent ではないので、そこだけ別扱いで比べる。
  expect(changelog3[0]?.intent).toBe(changelogAfterCreate[0]?.intent);
  expect(changelog3.slice(1).map((entry) => entry.intent)).toEqual([
    DIFF_1.intent,
    DIFF_2.intent,
    DIFF_3.intent,
  ]);
  expect(changelog3.slice(1).map((entry) => entry.operations)).toEqual([
    DIFF_1.operations,
    DIFF_2.operations,
    DIFF_3.operations,
  ]);
  // 第0行(_create-app)は undo できない設計(snapshot: null)なので、この検証からは除く。
  for (const entry of changelog3.filter((e) => e.diff_id !== "_create-app")) {
    expect(entry.snapshot).not.toBeNull();
    expect(entry.undo_target_seq).toBeNull();
    expect(entry.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  }

  const diff3Seq = changelog3[3]?.seq;
  if (diff3Seq === undefined) {
    throw new Error("changelog の3件目が取れません(直前のアサートが通っていれば起きない)。");
  }

  // 3回の apply それぞれにスナップショットが1つずつ実在する。
  expect(listSnapshots(dataRoot, APP_ID)).toEqual([
    "0001-d-001-book-tracker",
    "0002-d-002-rating",
    "0003-d-003-tags",
  ]);
  for (const entry of changelog3) {
    if (entry.snapshot !== null) {
      expectSnapshotOnDisk(entry.snapshot);
    }
  }

  // === ステップ4: undo → diff#3 適用前とマニフェスト・データが完全一致 ===

  // diff#3 の**あとに**データを足す。ADR-0004 が「最も起こしてほしくない事故」として
  // 警告している挙動 —— undo は DB ファイルごと巻き戻すのでこのデータも消える —— を、
  // MCP 経由でも同じように固定する。
  const tagInsert = await callOk("insert_sample_data", {
    app_id: APP_ID,
    table_id: "tags",
    rows: [{ label: "名作" }],
  });
  const laterBookInsert = await callOk("insert_sample_data", {
    app_id: APP_ID,
    table_id: "books",
    rows: [{ title: "diff#3 の後で足した本" }],
  });
  const addedTagId = (tagInsert.inserted as RecordRow[])[0]?._id;
  const addedBookId = (laterBookInsert.inserted as RecordRow[])[0]?._id;
  if (addedTagId === undefined || addedBookId === undefined) {
    throw new Error("diff#3 後のデータ投入に失敗しました。");
  }
  expect((await readAllRecords()).books).toHaveLength(6);
  expect((await readAllRecords()).tags).toHaveLength(1);

  // preview_undo は「失われる件数」を undo の**前に**正しく提示できるか
  // (DoD-3 の「驚きがない」の実証)。LLM はこれを人間に見せて同意を取る。
  const previewData = await callOk("preview_undo", { app_id: APP_ID });
  const preview = previewData.preview as UndoPreview;
  expect(preview.diff_id).toBe(DIFF_3.diff_id);
  expect(preview.intent).toBe(DIFF_3.intent);
  expect(preview.target_seq).toBe(diff3Seq);
  expect(preview.operations).toEqual(DIFF_3.operations);
  // books: diff#3 の後に足した1件が消える。tags: テーブルごと消えるので現在の全件。
  expect(preview.lost_records).toEqual({ books: 1, tags: 1 });
  expect(preview.restored_records).toEqual({});
  // 件数に現れない喪失(内容だけ変わったレコード)があることを必ず添える(憲法6)。
  expect(preview.note).toBe(UNDO_PREVIEW_NOTE);
  // 参照系なので、呼んでも状態は1バイトも変わらない。
  expect(await changelogVia()).toHaveLength(4);
  expect((await readAllRecords()).books).toHaveLength(6);

  const undone = await callOk("undo", { app_id: APP_ID });
  expect(undone.restored_from).toBe(applied3.snapshot);
  // undo ツールが内部で先に取った preview(R2)が、直前に人間へ見せた予告と一致する。
  // ここがずれると「見せた予告と実際に起きたことが違う」ことになる。
  expect(undone.preview).toEqual(preview);

  const afterUndo = await observe();

  // (a) マニフェストが diff#3 適用前と**深い等価**で一致する。
  expect(afterUndo.manifest).toEqual(beforeDiff3.manifest);
  // (b) SQLite のスキーマも一致する(tags テーブルは消えている)。
  expect(afterUndo.schema).toEqual(beforeDiff3.schema);
  expect(Object.keys(afterUndo.schema).sort()).toEqual(["authors", "books"]);
  // (c) レコードが `_id` の集合レベルで一致し、各行の全フィールドも一致する。
  expect(idSets(afterUndo.records)).toEqual(idSets(beforeDiff3.records));
  expect(afterUndo.records).toEqual(beforeDiff3.records);
  // (d) 「完全一致」には、**diff#3 の後に追加したデータが消えること**が含まれる。
  expect(afterUndo.records.books?.map((row) => row._id)).not.toContain(addedBookId);
  expect(afterUndo.records.books).toHaveLength(5);
  expect(afterUndo.records.tags).toBeUndefined();
  // tags は「マニフェストから消えた」だけでなく SQLite からも物理的に消えている。
  expect(
    withAppDb((db) =>
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tags'").get(),
    ),
  ).toBeNull();
  expect(addedTagId).toMatch(/^[0-9a-f-]{36}$/);

  // (e) 取り消したことも履歴に残る。第0行 + apply の3件は消えない(ADR-0004 §3)。
  expect(afterUndo.changelog).toHaveLength(5);
  expect(afterUndo.changelog.map((entry) => entry.kind)).toEqual([
    "apply",
    "apply",
    "apply",
    "apply",
    "undo",
  ]);
  const undoEntry = afterUndo.changelog[4];
  expect(undoEntry?.undo_target_seq).toBe(diff3Seq);
  expect(undoEntry?.diff_id).toBe(`undo-${DIFF_3.diff_id}`);
  expect(undoEntry?.intent).toBe(`${DIFF_3.diff_id}(${DIFF_3.intent})を取り消した`);
  expect(undoEntry?.operations).toEqual([]);
  // undo 実行直前のスナップショットも取られている(ADR-0004 §5。戻る API は無い)。
  expect(afterUndo.snapshots).toEqual([
    "0001-d-001-book-tracker",
    "0002-d-002-rating",
    "0003-d-003-tags",
    "0004-undo-d-003-tags",
  ]);
  expectSnapshotOnDisk("0004-undo-d-003-tags");
  expect(undone.snapshot).toBe("0004-undo-d-003-tags");

  // (f) 画面に相当するもの(ビュー定義)からも tag-list が消えている。
  expect(afterUndo.manifest.app.views.map((view) => view.id)).toEqual([
    "book-list",
    "book-form",
    "book-detail",
  ]);
  // get_preview_url も、消えたビューのURLを返さない(開けば404になるURLを渡さない)。
  expect(
    errorsOf(await call("get_preview_url", { app_id: APP_ID, view_id: "tag-list" }))[0]?.path,
  ).toBe("/view_id");

  // === ステップ5: 破壊的 diff → 拒否され状態不変 ===

  const before5 = await observe();

  /**
   * 破壊的意図の代表2パターン(CP-4 と同一)。
   *
   * 1. 語彙上存在しない op(`remove_field`)。差分スキーマの段階で落ちる
   * 2. `update_view` を装った破壊的変更。op としては合法だが、存在しないフィールドへ
   *    列を差し替えようとしている(= 実質的に列の削除・改名)。適用後マニフェストの
   *    参照整合性検証で落ちる
   *
   * MCP 側の入力スキーマ(`z.array(z.record(...))`)が浅いのは、この2つを
   * **zod ではなくカーネルに落とさせる**ためである。zod で弾くと、LLM が読むのは
   * Phase 1 の統一形式ではなく zod のメッセージになってしまう。
   */
  const destructiveDiffs: Record<string, unknown>[] = [
    {
      diff_id: "d-004-remove",
      intent: "評価は要らなくなったので消したい",
      operations: [{ op: "remove_field", table: "books", field: "rating" }],
    },
    {
      diff_id: "d-005-swap",
      intent: "一覧の列を別の項目に差し替えたい",
      operations: [
        { op: "update_view", view: "book-list", changes: { columns: ["title", "score"] } },
      ],
    },
  ];

  for (const destructive of destructiveDiffs) {
    const rejected = await call("apply_diff", { app_id: APP_ID, diff: destructive });
    const errors = errorsOf(rejected);
    expect(errors.length, JSON.stringify(destructive)).toBeGreaterThan(0);
    // 統一形式(path + message)であること。LLM が自己修正できる形で返る。
    for (const error of errors) {
      expect(typeof error.path).toBe("string");
      expect(error.message.length).toBeGreaterThan(0);
    }
  }

  // 状態不変を5点すべてでアサートする。
  const after5 = await observe();
  expect(after5.manifest).toEqual(before5.manifest); // マニフェスト
  expect(after5.schema).toEqual(before5.schema); // SQLite スキーマ
  expect(idSets(after5.records)).toEqual(idSets(before5.records)); // レコード(集合)
  expect(after5.records).toEqual(before5.records); // レコード(全値)
  expect(after5.changelog).toEqual(before5.changelog); // changelog(5件のまま)
  expect(after5.snapshots).toEqual(before5.snapshots); // スナップショット数(4のまま)
  // 拒否は事前検証で起きるので、スナップショットは1つも増えない。
  expect(after5.snapshots).toHaveLength(4);
});
