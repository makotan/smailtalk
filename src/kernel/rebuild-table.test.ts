/**
 * テーブル再構築(層2)のテスト(V1-M1-T03 / ADR-0010 §5a)。
 *
 * SQLite は列の型変更をサポートしないので、`number` / `boolean` が絡む変換では
 * 新テーブル作成 → 変換しながら全行コピー → 旧テーブル DROP → RENAME が要る。
 * **このテストの中心は「途中で失敗しても元テーブルが失われないこと」である。**
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type RebuildColumn,
  rebuildTable,
  supportsDropColumn,
  supportsRenameColumn,
} from "./rebuild-table.ts";
import type { Field, Table } from "./types.ts";

let db: Database;

const QTY_TEXT: Field = { id: "qty", name: "数量", type: "text" };
const QTY_NUMBER: Field = { id: "qty", name: "数量", type: "number" };
const TITLE: Field = { id: "title", name: "タイトル", type: "text" };

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    `CREATE TABLE "books" (
       "_id" TEXT PRIMARY KEY,
       "_created_at" TEXT NOT NULL,
       "_updated_at" TEXT NOT NULL,
       "title" TEXT,
       "qty" TEXT
     )`,
  );
  db.query(
    `INSERT INTO "books" ("_id","_created_at","_updated_at","title","qty") VALUES (?,?,?,?,?)`,
  ).run("b-1", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", "銀河", "42");
  db.query(
    `INSERT INTO "books" ("_id","_created_at","_updated_at","title","qty") VALUES (?,?,?,?,?)`,
  ).run("b-2", "2026-01-03T00:00:00Z", "2026-01-04T00:00:00Z", "軽さ", null);
});

afterEach(() => {
  db.close();
});

function columnNames(table: string): string[] {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info("${table}")`)
    .all()
    .map((row) => row.name);
}

function columnTypes(table: string): Record<string, string> {
  const info = db.query<{ name: string; type: string }, []>(`PRAGMA table_info("${table}")`).all();
  return Object.fromEntries(info.map((row) => [row.name, row.type]));
}

function rows(table: string): Record<string, unknown>[] {
  return db.query<Record<string, unknown>, []>(`SELECT * FROM "${table}" ORDER BY "_id"`).all();
}

function tableNames(): string[] {
  return db
    .query<{ name: string }, []>(
      `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%' ORDER BY "name"`,
    )
    .all()
    .map((row) => row.name);
}

const BOOKS_AS_NUMBER: Table = { id: "books", name: "本", fields: [TITLE, QTY_NUMBER] };

const CONVERT_QTY: RebuildColumn[] = [
  { field: TITLE, source: "title" },
  { field: QTY_NUMBER, source: "qty", from: QTY_TEXT },
];

describe("実行環境の能力を実行時に確認する(ADR-0010 §5a:「使えるはずだ」を前提にしない)", () => {
  test("DROP COLUMN / RENAME COLUMN の可用性を実際に試して判定する", () => {
    // 判定は真偽どちらでもよい。**判定が例外を投げないこと**と、
    // **判定が対象DBに痕跡を残さないこと**がこのテストの主張である。
    const before = tableNames();
    expect(typeof supportsDropColumn(db)).toBe("boolean");
    expect(typeof supportsRenameColumn(db)).toBe("boolean");
    expect(tableNames()).toEqual(before);
    expect(rows("books")).toHaveLength(2);
  });

  test("同じDBに対して繰り返し呼んでも結果が変わらない", () => {
    expect(supportsDropColumn(db)).toBe(supportsDropColumn(db));
    expect(supportsRenameColumn(db)).toBe(supportsRenameColumn(db));
  });
});

describe("再構築は列型を変え、値を変換して全行を運ぶ", () => {
  test("qty が TEXT から NUMERIC になり、値が数値として入る", () => {
    rebuildTable(db, "books", BOOKS_AS_NUMBER, CONVERT_QTY);

    expect(columnTypes("books")).toEqual({
      _id: "TEXT",
      _created_at: "TEXT",
      _updated_at: "TEXT",
      title: "TEXT",
      qty: "NUMERIC",
    });
    expect(rows("books")).toEqual([
      {
        _id: "b-1",
        _created_at: "2026-01-01T00:00:00Z",
        _updated_at: "2026-01-02T00:00:00Z",
        title: "銀河",
        qty: 42,
      },
      {
        _id: "b-2",
        _created_at: "2026-01-03T00:00:00Z",
        _updated_at: "2026-01-04T00:00:00Z",
        title: "軽さ",
        qty: null,
      },
    ]);
  });

  test("システム列(_id / _created_at / _updated_at)が1バイトも変わらずに運ばれる", () => {
    const before = rows("books").map((row) => ({
      _id: row._id,
      _created_at: row._created_at,
      _updated_at: row._updated_at,
    }));
    rebuildTable(db, "books", BOOKS_AS_NUMBER, CONVERT_QTY);
    const after = rows("books").map((row) => ({
      _id: row._id,
      _created_at: row._created_at,
      _updated_at: row._updated_at,
    }));
    expect(after).toEqual(before);
  });

  test("主キー制約が再構築後も残る", () => {
    rebuildTable(db, "books", BOOKS_AS_NUMBER, CONVERT_QTY);
    expect(() =>
      db
        .query(`INSERT INTO "books" ("_id","_created_at","_updated_at") VALUES (?,?,?)`)
        .run("b-1", "x", "y"),
    ).toThrow();
  });

  test("作業用の一時テーブルが残らない", () => {
    rebuildTable(db, "books", BOOKS_AS_NUMBER, CONVERT_QTY);
    expect(tableNames()).toEqual(["books"]);
  });

  test("列の削除(再構築経路)は残す列だけを運ぶ", () => {
    const target: Table = { id: "books", name: "本", fields: [TITLE] };
    rebuildTable(db, "books", target, [{ field: TITLE, source: "title" }]);
    expect(columnNames("books")).toEqual(["_id", "_created_at", "_updated_at", "title"]);
    expect(rows("books").map((r) => r.title)).toEqual(["銀河", "軽さ"]);
  });

  test("列名の変更(再構築経路)は source から新しい列名へ値を運ぶ", () => {
    const renamed: Field = { id: "amount", name: "数量", type: "number" };
    const target: Table = { id: "books", name: "本", fields: [TITLE, renamed] };
    rebuildTable(db, "books", target, [
      { field: TITLE, source: "title" },
      { field: renamed, source: "qty", from: QTY_TEXT },
    ]);
    expect(columnNames("books")).toEqual(["_id", "_created_at", "_updated_at", "title", "amount"]);
    expect(rows("books").map((r) => r.amount)).toEqual([42, null]);
  });

  test("テーブル名の変更を同時に行える(rename + 再構築)", () => {
    const target: Table = { id: "volumes", name: "本", fields: [TITLE, QTY_NUMBER] };
    rebuildTable(db, "books", target, CONVERT_QTY);
    expect(tableNames()).toEqual(["volumes"]);
    expect(rows("volumes").map((r) => r.qty)).toEqual([42, null]);
  });

  test("0行のテーブルでも再構築できる", () => {
    db.exec(`DELETE FROM "books"`);
    rebuildTable(db, "books", BOOKS_AS_NUMBER, CONVERT_QTY);
    expect(columnTypes("books").qty).toBe("NUMERIC");
    expect(rows("books")).toEqual([]);
  });
});

describe("途中で失敗しても元テーブルが失われない(ADR-0010 §7 失敗6)", () => {
  test("変換できない値があると例外になり、元テーブルとデータがそのまま残る", () => {
    db.query(
      `INSERT INTO "books" ("_id","_created_at","_updated_at","title","qty") VALUES (?,?,?,?,?)`,
    ).run("b-3", "2026-01-05T00:00:00Z", "2026-01-06T00:00:00Z", "壊れ", "たくさん");

    const before = rows("books");
    expect(() => rebuildTable(db, "books", BOOKS_AS_NUMBER, CONVERT_QTY)).toThrow();

    // 元テーブルは名前も列も行も無傷。作業用テーブルも残っていない。
    expect(tableNames()).toEqual(["books"]);
    expect(columnTypes("books").qty).toBe("TEXT");
    expect(rows("books")).toEqual(before);
  });

  test("作業用テーブル名が既存テーブルと衝突する場合は、何もせずに例外にする", () => {
    // 衝突するテーブルをあらかじめ作っておく。黙って DROP して進むと、
    // ユーザのテーブルを消すことになる。
    const workName = "gp-rebuild-books";
    db.exec(`CREATE TABLE "${workName}" ("_id" TEXT PRIMARY KEY)`);
    db.query(`INSERT INTO "${workName}" ("_id") VALUES ('keep-me')`).run();

    const before = rows("books");
    expect(() => rebuildTable(db, "books", BOOKS_AS_NUMBER, CONVERT_QTY)).toThrow();

    expect(rows(workName)).toEqual([{ _id: "keep-me" }]);
    expect(rows("books")).toEqual(before);
    expect(columnTypes("books").qty).toBe("TEXT");
  });

  test("呼び出し側のトランザクションの中で失敗した場合も、外側のロールバックで元に戻る", () => {
    db.query(
      `INSERT INTO "books" ("_id","_created_at","_updated_at","title","qty") VALUES (?,?,?,?,?)`,
    ).run("b-3", "2026-01-05T00:00:00Z", "2026-01-06T00:00:00Z", "壊れ", "たくさん");
    const before = rows("books");

    expect(() =>
      db.transaction(() => {
        db.exec(`CREATE TABLE "scratch" ("_id" TEXT PRIMARY KEY)`);
        rebuildTable(db, "books", BOOKS_AS_NUMBER, CONVERT_QTY);
      })(),
    ).toThrow();

    // 同一トランザクションの中で先に作ったテーブルも巻き戻る。
    expect(tableNames()).toEqual(["books"]);
    expect(rows("books")).toEqual(before);
  });

  test("成功した再構築は、呼び出し側のトランザクションのロールバックで巻き戻る", () => {
    const before = rows("books");
    try {
      db.transaction(() => {
        rebuildTable(db, "books", BOOKS_AS_NUMBER, CONVERT_QTY);
        throw new Error("呼び出し側の都合で中止");
      })();
    } catch {
      // 握りつぶすのはテストの都合。ロールバックされたことを下で見る。
    }
    expect(columnTypes("books").qty).toBe("TEXT");
    expect(rows("books")).toEqual(before);
  });
});
