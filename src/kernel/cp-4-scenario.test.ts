/**
 * CP-4 統合シナリオテスト(docs/plan/v0/05-change-model.md チェックポイント CP-4)。
 *
 * 計画書が要求する5ステップを **1本のテスト**として通しで実行する。
 * ステップを別々のテストに割らないのは、CP-4 の確認対象が
 * 「要望→差分→適用→(気に入らなければ)undo のループが**閉じる**こと」であり、
 * その連続性そのものが検証対象だからである(CP-2 シナリオと同じ理由)。
 *
 * 1. create_app → 初期マニフェスト適用 → データ投入
 * 2. diff#2(add_field + update_view)apply → 既存データ無傷 + 画面反映
 * 3. diff#3 apply → changelog に3件、各 intent が読める
 * 4. undo → diff#3 適用前とマニフェスト・データが完全一致
 * 5. 破壊的 diff → 拒否され状態不変
 *
 * 加えて計画書の「スナップショットディレクトリに apply ごとのスナップショットが
 * 実在すること」を、各 apply の直後と最後にまとめて確認する。
 *
 * ## 設計判断: 初期マニフェストも applyDiff で構築する(重要)
 *
 * 計画書のステップ3は「changelog に3件」と書いており、これは**初期マニフェスト投入を
 * 履歴の1件目として数えている**。しかし `applyManifest`(V0-P2-T06)は
 * マニフェスト全体の差し替えとマイグレーションを行うだけで、**changelog に追記しない**。
 * `applyManifest` を初期投入に使うと changelog は2件にしかならず、計画書と食い違う。
 *
 * そこで **初期マニフェストも `applyDiff` で構築する**。`createApp` が書く空マニフェスト
 * (`{ app: { id, name, tables: [], views: [] } }`)に対して、`add_table` / `add_view` は
 * すべて additive op としてそのまま表現できるので、語彙を1つも増やさずに済む。これにより:
 *
 * - changelog が計画書どおり **3件**になる
 * - **アプリ誕生時の要件も intent 付きで履歴に残る**。「なぜこのアプリには書籍テーブルが
 *   あるのか」を history の1件目が答える状態になり、憲法5「changelog が要件定義書」が
 *   最初の1行から厳密に成立する。`applyManifest` で流し込むと、アプリの出発点だけが
 *   履歴の外にあり、要件定義書の第1章が白紙になる
 *
 * `applyManifest` は開発・検証用の投入経路(Phase 3 の E2E フィクスチャ等)として残るが、
 * **製品として想定される経路は applyDiff である**。この非対称性は docs/evidence/cp-4.md の
 * 「既知の限界」にも明記してある。
 *
 * ## 比較の粒度
 *
 * - マニフェストは `toEqual` による**深い等価**で比較する。
 * - レコードは件数一致で済ませない。**`_id` の集合**を `toEqual` で突き合わせたうえで、
 *   各行のオブジェクト全体(システム列3 + 全フィールド)を `toEqual` で比較する。
 * - ステップ4の「完全一致」には、**diff#3 適用後に追加したデータが消えること**を含める。
 *   ADR-0004 が「最も起こしてほしくない事故」として警告している挙動そのものなので、
 *   ここを緩めると CP-4 は何も保証しないテストになる。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerApp } from "../server/app.ts";
import { seedSession, TEST_ORIGIN } from "../server/test-helpers.ts";
import { applyDiff } from "./apply-diff.ts";
import { readCurrentManifest } from "./apply-manifest.ts";
import { getChangelog } from "./changelog.ts";
import { createApp } from "./create-app.ts";
import { quoteIdentifier } from "./ddl.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { createRecord, listRecords, type RecordRow } from "./records.ts";
import { listSnapshots } from "./snapshot.ts";
import { appDbPath, snapshotDir } from "./storage-paths.ts";
import type { Diff, Manifest } from "./types.ts";
import { previewRedo, previewUndo, redo, UNDO_PREVIEW_NOTE, undo } from "./undo.ts";

const APP_ID = "book-tracker";
const APP_NAME = "蔵書管理";

let dataRoot: string;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-cp4-scenario-"));
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

// --- 観測ヘルパ ----------------------------------------------------------------

/** 開いた app.sqlite に対して処理を行い、必ず閉じる。 */
function withAppDb<T>(fn: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * SQLite に実在するユーザテーブル名(昇順)。
 *
 * per-app 認証(ADR-0014 v3)では、この app.sqlite に `_auth_*` 予約テーブルが同居する
 * (`seedSession` が仕込む)。それらはユーザテーブルではなく、リソースID規約(英小文字始まり)に
 * も従わないため、`_` 始まりの予約テーブルは観測対象から除く(観測は本シナリオのユーザ
 * テーブルだけを見る)。
 */
function tableNames(db: Database): string[] {
  return (
    db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]
  )
    .map((row) => row.name)
    .filter((name) => !name.startsWith("_"));
}

/** テーブルの列名 → SQLite 型。 */
function columnTypes(db: Database, tableId: string): Record<string, string> {
  const rows = db.query(`PRAGMA table_info(${quoteIdentifier(tableId)})`).all() as {
    name: string;
    type: string;
  }[];
  return Object.fromEntries(rows.map((row) => [row.name, row.type]));
}

/** 現在のマニフェストに載っている全テーブルの全レコードを `_id` 昇順で読む。 */
function readAllRecords(): Record<string, RecordRow[]> {
  const manifest = readCurrentManifest(dataRoot, APP_ID);
  return withAppDb((db) => {
    const out: Record<string, RecordRow[]> = {};
    for (const table of manifest.app.tables) {
      const listed = listRecords(db, manifest, table.id);
      if (!listed.ok) {
        throw new Error(`${table.id} の一覧取得に失敗: ${JSON.stringify(listed.errors)}`);
      }
      out[table.id] = [...listed.value].sort((a, b) => a._id.localeCompare(b._id));
    }
    return out;
  });
}

/** テーブルID → `_id` の集合(集合レベルの比較に使う。件数一致で済ませないため)。 */
function idSets(records: Record<string, RecordRow[]>): Record<string, Set<string>> {
  return Object.fromEntries(
    Object.entries(records).map(([tableId, rows]) => [tableId, new Set(rows.map((r) => r._id))]),
  );
}

/**
 * 「状態」のスナップショット(テストが比較に使う観測値)。
 * マニフェスト・SQLiteスキーマ・全レコード・changelog・スナップショット一覧の5点。
 */
type Observed = {
  manifest: Manifest;
  schema: Record<string, Record<string, string>>;
  records: Record<string, RecordRow[]>;
  changelog: ReturnType<typeof getChangelog>;
  snapshots: string[];
};

function observe(): Observed {
  const manifest = readCurrentManifest(dataRoot, APP_ID);
  const schema = withAppDb((db) =>
    Object.fromEntries(tableNames(db).map((name) => [name, columnTypes(db, name)])),
  );
  return {
    manifest,
    schema,
    records: readAllRecords(),
    changelog: getChangelog(dataRoot, APP_ID),
    snapshots: listSnapshots(dataRoot, APP_ID),
  };
}

/** スナップショットが2ファイル揃って実在することを確かめる。 */
function expectSnapshotOnDisk(name: string): void {
  const dir = snapshotDir(dataRoot, APP_ID, name);
  expect(existsSync(join(dir, "manifest.json"))).toBe(true);
  expect(existsSync(join(dir, "app.sqlite"))).toBe(true);
}

// --- 差分パッチ ----------------------------------------------------------------

/**
 * diff#1: アプリ誕生時の要件。空マニフェストに対して蔵書管理の器を作る。
 *
 * `add_table` は先頭から順に畳み込まれるので、`authors` を先に足しておけば
 * 同じ差分の中で `books.author`(reference)がその `authors` を指せる。
 * 7型(text / long_text / number / boolean / date / select / reference)をすべて含む。
 */
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

/**
 * diff#2: 計画書が名指しする「add_field + update_view」の組。
 * 「一覧で評価も見たい」という要望が、フィールド追加と一覧の列追加の2操作になる。
 */
const DIFF_2: Diff = {
  diff_id: "d-002-rating",
  intent: "読んだ本に5段階の評価を付けて、一覧でも評価が見えるようにしたい",
  operations: [
    { op: "add_field", table: "books", field: { id: "rating", name: "評価", type: "number" } },
    { op: "update_view", view: "book-list", changes: { columns: ["title", "status", "rating"] } },
  ],
};

/** diff#3: 別の要望(タグで本を分類したい)。テーブルと一覧を1つずつ増やす。 */
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

// --- シナリオ本体 --------------------------------------------------------------

test("CP-4 シナリオ: 作成→初期diff→データ投入→diff#2→diff#3→undo→破壊的diff拒否", async () => {
  // === ステップ1: create_app → 初期マニフェスト適用 → データ投入 ===

  const store = KernelMetaStore.open(dataRoot);
  const created = createApp(store, APP_NAME, { app_id: APP_ID });
  store.close();

  expect(created.app.app_id).toBe(APP_ID);
  // create_app が書くのは空マニフェスト。ここから先の形はすべて差分が作る。
  expect(created.manifest.app.tables).toEqual([]);
  expect(created.manifest.app.views).toEqual([]);
  // V1-M0-T05: create_app が changelog の第0行(_create-app)を書くので、
  // diff を1つも適用していない時点でも changelog は空にはならない。
  const changelog0 = getChangelog(dataRoot, APP_ID);
  expect(changelog0).toHaveLength(1);
  expect(changelog0[0]?.diff_id).toBe("_create-app");
  expect(changelog0[0]?.kind).toBe("apply");
  expect(changelog0[0]?.snapshot).toBeNull();
  expect(listSnapshots(dataRoot, APP_ID)).toEqual([]);

  // 初期マニフェストも applyDiff で構築する(ファイル冒頭の設計判断を参照)。
  const applied1 = applyDiff(dataRoot, APP_ID, DIFF_1);
  expect(applied1.valid, JSON.stringify(applied1)).toBe(true);
  if (!applied1.valid) {
    return;
  }
  // apply の直前状態(= 空マニフェスト)がスナップショットとして実在する。
  expect(applied1.snapshot).toBe("0001-d-001-book-tracker");
  expectSnapshotOnDisk(applied1.snapshot);
  expect(applied1.entry.kind).toBe("apply");
  expect(applied1.entry.snapshot).toBe(applied1.snapshot);

  // マイグレーションが7型ぶんの列を作っている。
  withAppDb((db) => {
    expect(tableNames(db)).toEqual(["authors", "books"]);
    expect(columnTypes(db, "books")).toEqual({
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
  });

  // データ投入: 著者1件 + 書籍5件(7型すべてに値が入る)。
  const manifestV1 = readCurrentManifest(dataRoot, APP_ID);
  const statuses = ["未読", "読書中", "読了"] as const;
  const seeded: RecordRow[] = withAppDb((db) => {
    const author = createRecord(db, manifestV1, "authors", { name: "夏目 漱石" });
    if (!author.ok) {
      throw new Error(`著者の投入に失敗: ${JSON.stringify(author.errors)}`);
    }
    const rows: RecordRow[] = [];
    for (let i = 0; i < 5; i++) {
      const result = createRecord(db, manifestV1, "books", {
        title: `蔵書 ${i + 1}`,
        status: statuses[i % 3],
        finished_at: `2026-0${i + 1}-1${i}`,
        memo: `メモ ${i}\n2行目に "引用符" とカンマ, を含む`,
        pages: i % 2 === 0 ? 100 + i : 12.5 + i,
        owned: i % 2 === 0,
        author: author.value._id,
      });
      if (!result.ok) {
        throw new Error(`書籍 ${i} の投入に失敗: ${JSON.stringify(result.errors)}`);
      }
      rows.push(result.value);
    }
    return rows;
  });
  expect(new Set(seeded.map((row) => row._id)).size).toBe(5);

  const afterSeed = observe();
  expect(Object.keys(afterSeed.records).sort()).toEqual(["authors", "books"]);
  expect(afterSeed.records.books).toHaveLength(5);

  // === ステップ2: diff#2(add_field + update_view)→ 既存データ無傷 + 画面反映 ===

  // 「画面反映」は稼働中サーバの API レスポンスとして観測する。
  // ブラウザ上の反映(リロードだけで新しい列が現れ、undo で消える)は
  // web/e2e/apply-diff-reflection.e2e.ts が実ブラウザで担保している。
  // ここではその手前の層 —— 製品の HTTP API の応答が差分適用で変わること —— を見る。
  const server = createServerApp({ dataRoot });
  // 認証境界(ADR-0014)を通すため、同じ dataRoot にセッションを1件仕込んで cookie を付ける。
  const { cookie } = seedSession(dataRoot, APP_ID);
  const getJson = async (path: string): Promise<unknown> => {
    const response = await server.request(
      new Request(`http://localhost${path}`, { headers: { cookie, origin: TEST_ORIGIN } }),
    );
    expect(response.status, `${path}: ${await response.clone().text()}`).toBe(200);
    return (await response.json()) as unknown;
  };
  const listViewColumns = (manifest: Manifest): string[] => {
    const view = manifest.app.views.find((candidate) => candidate.id === "book-list");
    if (view === undefined || view.type !== "list_view") {
      throw new Error("book-list が list_view として見つかりません(テストの前提が壊れている)。");
    }
    return view.columns;
  };

  const manifestBefore2 = (await getJson(`/api/apps/${APP_ID}/manifest`)) as Manifest;
  const recordsBefore2 = (await getJson(`/api/apps/${APP_ID}/tables/books/records`)) as {
    records: RecordRow[];
  };
  // 適用前: 一覧の列は2つで、レコードは rating というキーを持たない。
  expect(listViewColumns(manifestBefore2)).toEqual(["title", "status"]);
  expect(recordsBefore2.records.every((row) => !("rating" in row))).toBe(true);

  const applied2 = applyDiff(dataRoot, APP_ID, DIFF_2);
  expect(applied2.valid, JSON.stringify(applied2)).toBe(true);
  if (!applied2.valid) {
    return;
  }
  expect(applied2.snapshot).toBe("0002-d-002-rating");
  expectSnapshotOnDisk(applied2.snapshot);
  expect(applied2.plan.add_fields.map((f) => `${f.table}.${f.field.id}`)).toEqual(["books.rating"]);

  // (a) 画面反映: サーバを再起動していない同じ Hono アプリの応答が変わっている。
  const manifestAfter2 = (await getJson(`/api/apps/${APP_ID}/manifest`)) as Manifest;
  const recordsAfter2 = (await getJson(`/api/apps/${APP_ID}/tables/books/records`)) as {
    records: RecordRow[];
  };
  expect(listViewColumns(manifestAfter2)).toEqual(["title", "status", "rating"]);
  expect(recordsAfter2.records.every((row) => row.rating === null)).toBe(true);

  // (b) 既存データ無傷: `_id` の集合が一致し、かつ各行の全フィールドが元のまま
  //     (新列 rating だけが null で増える)。件数一致では済ませない。
  const afterDiff2 = observe();
  expect(idSets(afterDiff2.records)).toEqual(idSets(afterSeed.records));
  const booksAfter2 = new Map(afterDiff2.records.books?.map((row) => [row._id, row]) ?? []);
  for (const original of seeded) {
    expect(booksAfter2.get(original._id)).toEqual({ ...original, rating: null });
  }
  expect(afterDiff2.records.authors).toEqual(afterSeed.records.authors ?? []);

  // === ステップ3: diff#3 → changelog に3件、各 intent が読める ===

  // undo の比較基準は「diff#3 を適用する直前」の状態である。ここで採っておく。
  const beforeDiff3 = observe();

  const applied3 = applyDiff(dataRoot, APP_ID, DIFF_3);
  expect(applied3.valid, JSON.stringify(applied3)).toBe(true);
  if (!applied3.valid) {
    return;
  }
  expect(applied3.snapshot).toBe("0003-d-003-tags");
  expectSnapshotOnDisk(applied3.snapshot);

  const changelog3 = getChangelog(dataRoot, APP_ID);
  // 計画書の「changelog に3件」+ create_app が書いた第0行(_create-app)の4件。
  expect(changelog3).toHaveLength(4);
  expect(changelog3.map((entry) => entry.diff_id)).toEqual([
    "_create-app",
    DIFF_1.diff_id,
    DIFF_2.diff_id,
    DIFF_3.diff_id,
  ]);
  expect(changelog3.map((entry) => entry.kind)).toEqual(["apply", "apply", "apply", "apply"]);
  // 第0行はカーネルが書いた行(ユーザ由来の diff ではない)なので、ここから先は
  // ユーザ由来の3件だけを見る。
  const diffEntries3 = changelog3.slice(1);
  // 「各 intent が読める」= 記録された intent が入力した日本語文そのものであること。
  // 要約・切り詰め・機械語への変換が挟まっていたらここで落ちる(憲法5)。
  expect(diffEntries3.map((entry) => entry.intent)).toEqual([
    DIFF_1.intent,
    DIFF_2.intent,
    DIFF_3.intent,
  ]);
  // 各エントリが「何を」やったかも、operations として原文のまま残っている。
  expect(diffEntries3.map((entry) => entry.operations)).toEqual([
    DIFF_1.operations,
    DIFF_2.operations,
    DIFF_3.operations,
  ]);
  for (const entry of diffEntries3) {
    expect(entry.snapshot).not.toBeNull();
    expect(entry.undo_target_seq).toBeNull();
    expect(entry.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  }

  const diff3Seq = changelog3[3]?.seq;
  if (diff3Seq === undefined) {
    throw new Error("changelog の3件目が取れません(直前のアサートが通っていれば起きない)。");
  }

  // 3回の apply それぞれにスナップショットが1つずつ実在する(計画書の追加要求)。
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

  // diff#3 の**あとに**データを足す。ADR-0004 §「undo で実際に失われるもの」が
  // 「最も起こしてほしくない事故」として警告している挙動 —— undo は DB ファイルごと
  // 巻き戻すので、このデータも消える —— を、テストとして固定する。
  const manifestV3 = readCurrentManifest(dataRoot, APP_ID);
  const addedAfterDiff3 = withAppDb((db) => {
    const tag = createRecord(db, manifestV3, "tags", { label: "名作" });
    const book = createRecord(db, manifestV3, "books", { title: "diff#3 の後で足した本" });
    if (!tag.ok || !book.ok) {
      throw new Error("diff#3 後のデータ投入に失敗しました。");
    }
    return { tagId: tag.value._id, bookId: book.value._id };
  });
  expect(readAllRecords().books).toHaveLength(6);
  expect(readAllRecords().tags).toHaveLength(1);

  // previewUndo は「失われる件数」を undo の**前に**正しく提示できるか(DoD-3 の
  // 「驚きがない」の実証)。件数は `_id` の集合差で数えるので(ADR-0004 §6)、
  // 引き算では取りこぼす「テーブルごと消える tags」もきちんと現れる。
  const preview = previewUndo(dataRoot, APP_ID);
  expect(preview.valid, JSON.stringify(preview)).toBe(true);
  if (!preview.valid) {
    return;
  }
  expect(preview.preview.diff_id).toBe(DIFF_3.diff_id);
  expect(preview.preview.intent).toBe(DIFF_3.intent);
  expect(preview.preview.target_seq).toBe(diff3Seq);
  expect(preview.preview.operations).toEqual(DIFF_3.operations);
  // books: diff#3 の後に足した1件が消える。tags: テーブルごと消えるので現在の全件。
  expect(preview.preview.lost_records).toEqual({ books: 1, tags: 1 });
  expect(preview.preview.restored_records).toEqual({});
  // 件数に現れない喪失(内容だけ変わったレコード)があることを必ず添える(憲法6)。
  expect(preview.preview.note).toBe(UNDO_PREVIEW_NOTE);
  // 参照系なので、呼んでも状態は1バイトも変わらない。
  expect(observe().changelog).toHaveLength(4);
  expect(readAllRecords().books).toHaveLength(6);

  const undone = undo(dataRoot, APP_ID);
  expect(undone.valid, JSON.stringify(undone)).toBe(true);
  if (!undone.valid) {
    return;
  }
  expect(undone.restored_from).toBe(applied3.snapshot);

  const afterUndo = observe();

  // (a) マニフェストが diff#3 適用前と**深い等価**で一致する。
  expect(afterUndo.manifest).toEqual(beforeDiff3.manifest);
  // (b) SQLite のスキーマも一致する(tags テーブルは消えている)。
  expect(afterUndo.schema).toEqual(beforeDiff3.schema);
  expect(Object.keys(afterUndo.schema).sort()).toEqual(["authors", "books"]);
  // (c) レコードが `_id` の集合レベルで一致し、各行の全フィールドも一致する。
  expect(idSets(afterUndo.records)).toEqual(idSets(beforeDiff3.records));
  expect(afterUndo.records).toEqual(beforeDiff3.records);
  // (d) 「完全一致」には、**diff#3 の後に追加したデータが消えること**が含まれる。
  //     previewUndo が予告した lost_records の中身が、実際にこれである。
  expect(afterUndo.records.books?.map((row) => row._id)).not.toContain(addedAfterDiff3.bookId);
  expect(afterUndo.records.books).toHaveLength(5);
  expect(afterUndo.records.tags).toBeUndefined();
  // tags は「マニフェストから消えた」だけでなく、SQLite からも物理的に消えている。
  // diff#3 の後に入れたタグ1件は、行ごとではなくテーブルごと失われた。
  expect(
    withAppDb((db) =>
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tags'").get(),
    ),
  ).toBeNull();
  expect(addedAfterDiff3.tagId).toMatch(/^[0-9a-f-]{36}$/);

  // (e) 取り消したことも履歴に残る。第0行(_create-app)+ apply の3件は消えない(ADR-0004 §3)。
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

  // (f) 画面(API レスポンス)からも tag-list が消えている。
  const manifestAfterUndo = (await getJson(`/api/apps/${APP_ID}/manifest`)) as Manifest;
  expect(manifestAfterUndo.app.views.map((view) => view.id)).toEqual([
    "book-list",
    "book-form",
    "book-detail",
  ]);

  // === ステップ5: 破壊的 diff → 拒否され状態不変 ===

  const before5 = observe();

  /**
   * 破壊的意図の代表2パターン。網羅は `destructive-rejection.test.ts` の担当で、
   * ここで見るのは「CP-4 のライフサイクルの中で拒否され、**状態が動かない**」こと。
   *
   * 1. 語彙上存在しない op(`remove_field`)。差分スキーマの段階で落ちる
   * 2. `update_view` を装った破壊的変更。op としては合法だが、存在しないフィールドへ
   *    列を差し替えようとしている(= 実質的に列の削除・改名)。適用後マニフェストの
   *    参照整合性検証で落ちる
   */
  const destructiveDiffs: unknown[] = [
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
    const rejected = applyDiff(dataRoot, APP_ID, destructive);
    expect(rejected.valid, JSON.stringify(destructive)).toBe(false);
    if (rejected.valid) {
      return;
    }
    expect(rejected.errors.length).toBeGreaterThan(0);
    // 統一形式(path + message)であること。LLM が自己修正できる形で返す。
    for (const error of rejected.errors) {
      expect(typeof error.path).toBe("string");
      expect(error.message.length).toBeGreaterThan(0);
    }
  }

  // 状態不変を5点すべてでアサートする。
  const after5 = observe();
  expect(after5.manifest).toEqual(before5.manifest); // マニフェスト
  expect(after5.schema).toEqual(before5.schema); // SQLite スキーマ
  expect(idSets(after5.records)).toEqual(idSets(before5.records)); // レコード(集合)
  expect(after5.records).toEqual(before5.records); // レコード(全値)
  expect(after5.changelog).toEqual(before5.changelog); // changelog(5件のまま)
  expect(after5.snapshots).toEqual(before5.snapshots); // スナップショット数(4のまま)
  // 拒否は事前検証で起きるので、スナップショットは1つも増えない。
  expect(after5.snapshots).toHaveLength(4);
});

/**
 * CP-4 拡張(ADR-0032 / V1-M9-T05): undo で消えた books 1件が redo で戻る。
 *
 * CP-6 持ち越し表 CP-4-2 が実地で観測した縁 —— 「undo は DB ファイルごとの巻き戻しなので、
 * 対象 apply 以降にユーザが頼んで入れた本まで失われる」—— を **redo で回復できる**ことを
 * エビデンスに残す。**redo は縁そのものを無くさない**(undo の巻き添えは同じだけ起きる)が、
 * 巻き添えが起きたあとの回復可能性を与える(ゲート §2-5)。
 */
test("CP-4 拡張: undo で消えた books 1件が redo で物理的に戻る(tag-list ビューも復活)", () => {
  const store = KernelMetaStore.open(dataRoot);
  createApp(store, APP_NAME, { app_id: APP_ID });
  store.close();

  // 蔵書テーブル・ビューを作り、その後 tags 機能(DIFF_3)を足す。
  expect(applyDiff(dataRoot, APP_ID, DIFF_1).valid).toBe(true);
  expect(applyDiff(dataRoot, APP_ID, DIFF_3).valid).toBe(true);

  // DIFF_3 の**あとに**ユーザが頼んで本を1冊入れる(= undo の巻き添えになる縁)。
  const manifestV3 = readCurrentManifest(dataRoot, APP_ID);
  const addedBookId = withAppDb((db) => {
    const book = createRecord(db, manifestV3, "books", {
      title: "undo のあとに redo で戻したい本",
    });
    if (!book.ok) {
      throw new Error(`本の投入に失敗: ${JSON.stringify(book.errors)}`);
    }
    return book.value._id;
  });
  expect(readAllRecords().books?.map((r) => r._id)).toContain(addedBookId);

  // === undo: DIFF_3 を取り消すと、その後に足した本1件も巻き添えで消える ===
  const previewU = previewUndo(dataRoot, APP_ID);
  expect(previewU.valid, JSON.stringify(previewU)).toBe(true);
  if (!previewU.valid) {
    return;
  }
  // 消えるのは books の1件(tags テーブルは空なので件数には出ない)。
  expect(previewU.preview.lost_records).toEqual({ books: 1 });

  const undone = undo(dataRoot, APP_ID);
  expect(undone.valid, JSON.stringify(undone)).toBe(true);
  expect(readAllRecords().books?.map((r) => r._id) ?? []).not.toContain(addedBookId);
  expect(readAllRecords().books ?? []).toHaveLength(0);

  // === redo: 直前の undo をやり直すと、消えた本が戻る ===
  const previewR = previewRedo(dataRoot, APP_ID);
  expect(previewR.valid, JSON.stringify(previewR)).toBe(true);
  if (!previewR.valid) {
    return;
  }
  // 「redo で戻る books 1件」が restored_records に現れる(CP-4 の books 1件 redo)。
  expect(previewR.preview.restored_records).toEqual({ books: 1 });
  expect(previewR.preview.lost_records).toEqual({});
  expect(previewR.preview.note).toBe(UNDO_PREVIEW_NOTE);

  const redone = redo(dataRoot, APP_ID);
  expect(redone.valid, JSON.stringify(redone)).toBe(true);
  if (!redone.valid) {
    return;
  }

  // undo で消えた**その本**(同じ _id)が物理的に戻っている。
  const booksAfterRedo = readAllRecords().books ?? [];
  expect(booksAfterRedo.map((r) => r._id)).toContain(addedBookId);
  expect(booksAfterRedo).toHaveLength(1);
  // 定義(tags テーブル・tag-list ビュー)も復活している。
  const manifestAfterRedo = readCurrentManifest(dataRoot, APP_ID);
  expect(manifestAfterRedo.app.tables.map((t) => t.id)).toContain("tags");
  expect(manifestAfterRedo.app.views.map((v) => v.id)).toContain("tag-list");

  // 履歴: apply×2(+ 第0行 _create-app)→ undo → redo。redo エントリの diff_id は前置1段。
  const changelog = getChangelog(dataRoot, APP_ID);
  expect(changelog.map((e) => e.kind)).toEqual(["apply", "apply", "apply", "undo", "redo"]);
  const undoSeq = changelog[3]?.seq;
  const redoEntry = changelog[4];
  expect(redoEntry?.diff_id).toBe(`redo-${DIFF_3.diff_id}`);
  // undo_target_seq はやり直した undo エントリの seq を指す(ADR-0032 §3)。
  expect(redoEntry?.undo_target_seq).toBe(undoSeq);
});
