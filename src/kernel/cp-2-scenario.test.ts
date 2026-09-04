/**
 * CP-2 統合シナリオテスト(docs/plan/v0/03-kernel-core.md チェックポイント CP-2)。
 *
 * 計画書が要求する5ステップを **1本のテスト**として通しで実行する。
 * ステップを別々のテストに割らないのは、シナリオの連続性そのもの
 * (同じアプリ・同じデータが、マイグレーションと再起動をまたいで
 * 生き延びること)が検証対象だからである。
 *
 * 1. create_app → 蔵書管理マニフェストを apply_manifest で適用 → テーブル生成確認
 * 2. レコード10件投入(7型の値を含む)
 * 3. additive マイグレーション(列追加 + テーブル追加)を適用
 * 4. 既存10件が全値無傷、新列は null で読める
 * 5. プロセス再起動相当(ストア/DB再オープン)後も 4 が成立
 *
 * ## 7型への到達方法
 *
 * 蔵書管理フィクスチャ(`fixtures/valid/book-tracker.json`、handover 3.4 原文)は
 * text / select / date の3型しか持たない。そこで **蔵書管理を additive に拡張して
 * 7型に到達させる**(別マニフェストに差し替えない)。ステップ1の中で
 * 「原文どおりの投入」→「long_text / number / boolean / reference の追加
 * (+ reference 先の authors テーブル追加)」の2回の apply_manifest を行い、
 * ステップ2以降は7型が揃った蔵書管理アプリに対して進む。
 *
 * ## 「全値無傷」の比較方法
 *
 * 投入時に `createRecord` が返した `RecordRow` を10件ぶんそのまま保持し、
 * マイグレーション後・再起動後の読み出し結果と `toEqual` で**オブジェクト全体**を
 * 比較する。システム列(`_id` / `_created_at` / `_updated_at`)と7型すべての
 * フィールド値が1件でも変化すれば落ちる。件数だけの確認はしない。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, readCurrentManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { quoteIdentifier } from "./ddl.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { createRecord, listRecords, type RecordRow } from "./records.ts";
import { appDbPath, appManifestPath, appSnapshotsDir } from "./storage-paths.ts";
import type { Manifest, Table } from "./types.ts";

const FIXTURE_DIR = join(import.meta.dir, "..", "..", "fixtures");
const APP_ID = "book-tracker";
const APP_NAME = "蔵書管理";

type ColumnInfo = { cid: number; name: string; type: string; notnull: number; pk: number };

function loadBookTracker(): Manifest {
  return JSON.parse(
    readFileSync(join(FIXTURE_DIR, "valid", "book-tracker.json"), "utf-8"),
  ) as Manifest;
}

function tableNames(db: Database): string[] {
  const rows = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

function columnTypes(db: Database, tableId: string): Record<string, string> {
  const rows = db.query(`PRAGMA table_info(${quoteIdentifier(tableId)})`).all() as ColumnInfo[];
  return Object.fromEntries(rows.map((r) => [r.name, r.type]));
}

/** 開いた DB に対して処理を行い、必ず閉じる。 */
function withAppDb<T>(dataRoot: string, appId: string, fn: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, appId), { readwrite: true, create: false });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function findTable(manifest: Manifest, tableId: string): Table {
  const table = manifest.app.tables.find((t) => t.id === tableId);
  if (table === undefined) {
    throw new Error(`テーブル "${tableId}" がマニフェストにありません(テストの前提が壊れている)。`);
  }
  return table;
}

let dataRoot: string;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-cp2-scenario-"));
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

test("CP-2 シナリオ: 作成→蔵書管理適用→10件投入→additive移行→全値無傷→再起動後も無傷", () => {
  // === ステップ1: create_app → 蔵書管理マニフェスト適用 → テーブル生成確認 ===

  const store = KernelMetaStore.open(dataRoot);
  const created = createApp(store, APP_NAME, { app_id: APP_ID });

  expect(created.app.app_id).toBe(APP_ID);
  expect(created.app.name).toBe(APP_NAME);
  expect(store.getApp(APP_ID)?.name).toBe(APP_NAME);
  // ADR-0002 のレイアウトが disk 上にできていること。
  expect(existsSync(appManifestPath(dataRoot, APP_ID))).toBe(true);
  expect(existsSync(appDbPath(dataRoot, APP_ID))).toBe(true);
  expect(existsSync(appSnapshotsDir(dataRoot, APP_ID))).toBe(true);

  // handover 3.4 原文の蔵書管理マニフェストをそのまま投入する。
  const v1 = loadBookTracker();
  const applied1 = applyManifest(dataRoot, APP_ID, v1);
  expect(applied1.valid).toBe(true);

  withAppDb(dataRoot, APP_ID, (db) => {
    expect(tableNames(db)).toEqual(["books"]);
    expect(columnTypes(db, "books")).toEqual({
      _id: "TEXT",
      _created_at: "TEXT",
      _updated_at: "TEXT",
      title: "TEXT",
      status: "TEXT",
      finished_at: "TEXT",
    });
  });

  // 蔵書管理を additive に拡張して7型に到達させる
  // (long_text / number / boolean / reference と、参照先の authors テーブルを追加)。
  const v2 = loadBookTracker();
  v2.app.tables.push({
    id: "authors",
    name: "著者",
    fields: [{ id: "name", name: "氏名", type: "text", required: true }],
  });
  findTable(v2, "books").fields.push(
    { id: "memo", name: "メモ", type: "long_text" },
    { id: "pages", name: "ページ数", type: "number" },
    { id: "owned", name: "所有", type: "boolean" },
    { id: "author", name: "著者", type: "reference", reference_table: "authors" },
  );

  const applied2 = applyManifest(dataRoot, APP_ID, v2);
  expect(applied2.valid).toBe(true);

  withAppDb(dataRoot, APP_ID, (db) => {
    expect(tableNames(db)).toEqual(["authors", "books"]);
    // フィールド型7種すべてが、マッピング表どおりの SQLite 型で存在する。
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

  // === ステップ2: レコード10件投入(7型の値を含む) ===

  const manifestV2 = readCurrentManifest(dataRoot, APP_ID);
  const statuses = ["未読", "読書中", "読了"] as const;

  const inserted: RecordRow[] = withAppDb(dataRoot, APP_ID, (db) => {
    const author = createRecord(db, manifestV2, "authors", { name: "夏目 漱石" });
    if (!author.ok) {
      throw new Error(`著者レコードの投入に失敗: ${JSON.stringify(author.errors)}`);
    }
    const authorId = author.value._id;

    const rows: RecordRow[] = [];
    for (let i = 0; i < 10; i++) {
      const result = createRecord(db, manifestV2, "books", {
        title: `蔵書 ${i + 1}「吾輩は猫である」`,
        status: statuses[i % 3],
        finished_at: `2026-0${(i % 9) + 1}-1${i % 10}`,
        memo: `複数行のメモ ${i}\n2行目に "引用符" とカンマ, を含む`,
        pages: i % 2 === 0 ? 100 + i : 12.5 + i,
        owned: i % 2 === 0,
        author: authorId,
      });
      if (!result.ok) {
        throw new Error(`書籍レコード ${i} の投入に失敗: ${JSON.stringify(result.errors)}`);
      }
      rows.push(result.value);
    }
    return rows;
  });

  expect(inserted).toHaveLength(10);
  // 投入時点で7型が期待どおりの JS の値としてラウンドトリップしていること
  // (boolean が 0/1 で、number が文字列で返ってきていない、の確認)。
  const first = inserted[0];
  if (first === undefined) {
    throw new Error("投入結果が空です。");
  }
  expect(typeof first.owned).toBe("boolean");
  expect(typeof first.pages).toBe("number");
  expect(first.pages).toBe(100);
  expect(inserted[1]?.pages).toBe(13.5);
  expect(new Set(inserted.map((r) => r._id)).size).toBe(10);

  /**
   * 「全値無傷 + 新列は null」の検査。
   * 投入時に返った RecordRow 10件それぞれについて、
   * システム列3列 + 7型のフィールド値 + 新列 `rating` を含むオブジェクト全体を比較する。
   */
  const expectRecordsIntact = (): void => {
    const manifest = readCurrentManifest(dataRoot, APP_ID);
    withAppDb(dataRoot, APP_ID, (db) => {
      const listed = listRecords(db, manifest, "books");
      if (!listed.ok) {
        throw new Error(`一覧の取得に失敗: ${JSON.stringify(listed.errors)}`);
      }
      expect(listed.value).toHaveLength(10);

      const byId = new Map(listed.value.map((row) => [row._id, row]));
      for (const original of inserted) {
        const actual = byId.get(original._id);
        expect(actual).toBeDefined();
        // 既存の全フィールド値 + 新列 null。1フィールドでも変化すれば落ちる。
        expect(actual).toEqual({ ...original, rating: null });
      }
    });
  };

  // === ステップ3: additive マイグレーション(列追加 + テーブル追加)===

  const v3: Manifest = structuredClone(readCurrentManifest(dataRoot, APP_ID));
  // 列追加: books に評価(number)を足す。
  findTable(v3, "books").fields.push({ id: "rating", name: "評価", type: "number" });
  // テーブル追加: タグ。
  v3.app.tables.push({
    id: "tags",
    name: "タグ",
    fields: [{ id: "label", name: "ラベル", type: "text", required: true }],
  });

  const applied3 = applyManifest(dataRoot, APP_ID, v3);
  expect(applied3.valid).toBe(true);
  if (applied3.valid) {
    expect(applied3.plan.add_tables.map((t) => t.id)).toEqual(["tags"]);
    expect(applied3.plan.add_fields.map((f) => `${f.table}.${f.field.id}`)).toEqual([
      "books.rating",
    ]);
  }

  withAppDb(dataRoot, APP_ID, (db) => {
    expect(tableNames(db)).toEqual(["authors", "books", "tags"]);
    expect(columnTypes(db, "books").rating).toBe("NUMERIC");
  });

  // === ステップ4: 既存10件が全値無傷、新列は null で読める ===

  expectRecordsIntact();

  // === ステップ5: プロセス再起動相当(ストア/DB再オープン)後も 4 が成立 ===

  // ここまでで開いた接続はすべて閉じてある(withAppDb が finally で閉じる)。
  // 残るカーネルメタストアも閉じ、開き直す = プロセス再起動相当。
  store.close();
  const reopened = KernelMetaStore.open(dataRoot);
  try {
    expect(reopened.getApp(APP_ID)).toEqual(created.app);
    expect(reopened.listApps().map((a) => a.app_id)).toEqual([APP_ID]);

    // マニフェストも app.sqlite も開き直したうえで、ステップ4と同じ検査を再実行する。
    expectRecordsIntact();

    withAppDb(dataRoot, APP_ID, (db) => {
      expect(tableNames(db)).toEqual(["authors", "books", "tags"]);
      expect(columnTypes(db, "books")).toEqual({
        _id: "TEXT",
        _created_at: "TEXT",
        _updated_at: "TEXT",
        title: "TEXT",
        status: "TEXT",
        finished_at: "TEXT",
        memo: "TEXT",
        pages: "NUMERIC",
        owned: "INTEGER",
        author: "TEXT",
        rating: "NUMERIC",
      });
    });
  } finally {
    reopened.close();
  }
});
