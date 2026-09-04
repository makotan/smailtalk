import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyManifestDdl,
  createTableSql,
  quoteIdentifier,
  SYSTEM_COLUMNS,
  sqliteTypeForFieldType,
} from "./ddl.ts";
import type { Manifest, Table } from "./types.ts";

const FIXTURES = join(import.meta.dir, "..", "..", "fixtures", "valid");

async function loadManifest(name: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(FIXTURES, name), "utf-8")) as Manifest;
}

type ColumnInfo = { cid: number; name: string; type: string; notnull: number; pk: number };

function tableInfo(db: Database, tableId: string): ColumnInfo[] {
  return db.query(`PRAGMA table_info(${quoteIdentifier(tableId)})`).all() as ColumnInfo[];
}

function columnByName(db: Database, tableId: string, column: string): ColumnInfo | undefined {
  return tableInfo(db, tableId).find((c) => c.name === column);
}

function tableNames(db: Database): string[] {
  const rows = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

describe("sqliteTypeForFieldType", () => {
  test("フィールド型9種すべてがマッピング表どおりに対応する", () => {
    expect(sqliteTypeForFieldType("text")).toBe("TEXT");
    expect(sqliteTypeForFieldType("long_text")).toBe("TEXT");
    expect(sqliteTypeForFieldType("select")).toBe("TEXT");
    expect(sqliteTypeForFieldType("date")).toBe("TEXT");
    expect(sqliteTypeForFieldType("reference")).toBe("TEXT");
    // image は _files の file_id を指す TEXT(V2-M2 / ADR-0035)。
    expect(sqliteTypeForFieldType("image")).toBe("TEXT");
    // file も同じく _files の file_id を指す TEXT(V5-M16 / ADR-0161 限定3)。
    expect(sqliteTypeForFieldType("file")).toBe("TEXT");
    expect(sqliteTypeForFieldType("number")).toBe("NUMERIC");
    expect(sqliteTypeForFieldType("boolean")).toBe("INTEGER");
  });
});

describe("quoteIdentifier", () => {
  test("ダブルクォートで囲む", () => {
    expect(quoteIdentifier("items")).toBe('"items"');
  });

  test("ハイフンを含むIDも囲める", () => {
    expect(quoteIdentifier("item-list")).toBe('"item-list"');
  });

  test("リソースID規約に違反する識別子は例外で拒否する(多層防御)", () => {
    expect(() => quoteIdentifier('items"; DROP TABLE items; --')).toThrow();
    expect(() => quoteIdentifier("Items")).toThrow();
    expect(() => quoteIdentifier("")).toThrow();
    expect(() => quoteIdentifier("1items")).toThrow();
  });
});

describe("createTableSql", () => {
  const table: Table = {
    id: "books",
    name: "書籍",
    fields: [
      { id: "title", name: "タイトル", type: "text", required: true },
      { id: "read-count", name: "読了回数", type: "number" },
    ],
  };

  test("識別子がすべてダブルクォートで囲まれている", () => {
    const sql = createTableSql(table);
    expect(sql).toContain('"books"');
    expect(sql).toContain('"title"');
    expect(sql).toContain('"read-count"');
  });

  test("システム列3種を含む", () => {
    const sql = createTableSql(table);
    expect(sql).toContain('"_id" TEXT PRIMARY KEY');
    expect(sql).toContain('"_created_at" TEXT NOT NULL');
    expect(sql).toContain('"_updated_at" TEXT NOT NULL');
  });

  test("required は NOT NULL 制約にしない(additive マイグレーション維持のため)", () => {
    const sql = createTableSql(table);
    expect(sql).toContain('"title" TEXT');
    expect(sql).not.toContain('"title" TEXT NOT NULL');
  });

  test("select は CHECK 制約にしない", () => {
    const sql = createTableSql({
      id: "books",
      name: "書籍",
      fields: [{ id: "status", name: "状態", type: "select", options: ["未読", "読了"] }],
    });
    expect(sql).not.toContain("CHECK");
  });

  test("reference は外部キー制約ではなく TEXT 列にする", () => {
    const sql = createTableSql({
      id: "items",
      name: "備品",
      fields: [
        { id: "category", name: "カテゴリ", type: "reference", reference_table: "categories" },
      ],
    });
    expect(sql).toContain('"category" TEXT');
    expect(sql).not.toContain("REFERENCES");
  });
});

describe("SYSTEM_COLUMNS", () => {
  test("すべて `_` 始まり(ユーザ定義フィールドIDと原理的に衝突しない)", () => {
    for (const name of Object.values(SYSTEM_COLUMNS)) {
      expect(name.startsWith("_")).toBe(true);
    }
  });
});

describe("applyManifestDdl", () => {
  let dir: string;
  let db: Database;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gp-ddl-"));
    db = new Database(join(dir, "app.sqlite"), { create: true });
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("fixtures/valid/inventory-all-field-types.json の全テーブルが作られる", async () => {
    applyManifestDdl(db, await loadManifest("inventory-all-field-types.json"));
    expect(tableNames(db)).toEqual(["categories", "items"]);
  });

  test("システム列3つが型・PK ともに規約どおり作られる", async () => {
    applyManifestDdl(db, await loadManifest("inventory-all-field-types.json"));
    const id = columnByName(db, "items", "_id");
    expect(id?.type).toBe("TEXT");
    expect(id?.pk).toBe(1);

    const createdAt = columnByName(db, "items", "_created_at");
    expect(createdAt?.type).toBe("TEXT");
    expect(createdAt?.notnull).toBe(1);

    const updatedAt = columnByName(db, "items", "_updated_at");
    expect(updatedAt?.type).toBe("TEXT");
    expect(updatedAt?.notnull).toBe(1);
  });

  test("フィールド型9種すべてがマッピング表どおりの列型になる", async () => {
    applyManifestDdl(db, await loadManifest("inventory-all-field-types.json"));
    const types = Object.fromEntries(tableInfo(db, "items").map((c) => [c.name, c.type]));
    expect(types).toEqual({
      _id: "TEXT",
      _created_at: "TEXT",
      _updated_at: "TEXT",
      name: "TEXT", // text
      note: "TEXT", // long_text
      quantity: "NUMERIC", // number
      in_use: "INTEGER", // boolean
      purchased_at: "TEXT", // date
      condition: "TEXT", // select
      category: "TEXT", // reference
      photo: "TEXT", // image(V2-M2 / ADR-0035。_files の file_id)
      manual: "TEXT", // file(V5-M16 / ADR-0161。_files の file_id。image と同型)
    });
  });

  test("ユーザ定義フィールドはどれも NOT NULL にならない(required でも)", async () => {
    applyManifestDdl(db, await loadManifest("inventory-all-field-types.json"));
    // name / quantity は required: true だが NOT NULL にしない。
    expect(columnByName(db, "items", "name")?.notnull).toBe(0);
    expect(columnByName(db, "items", "quantity")?.notnull).toBe(0);
  });

  test("number 列は整数を整数、小数を小数のまま保持する", async () => {
    applyManifestDdl(db, await loadManifest("inventory-all-field-types.json"));
    db.query(
      'INSERT INTO "items" ("_id", "_created_at", "_updated_at", "quantity") VALUES (?, ?, ?, ?)',
    ).run("r1", "2026-07-18T00:00:00.000Z", "2026-07-18T00:00:00.000Z", 3);
    db.query(
      'INSERT INTO "items" ("_id", "_created_at", "_updated_at", "quantity") VALUES (?, ?, ?, ?)',
    ).run("r2", "2026-07-18T00:00:00.000Z", "2026-07-18T00:00:00.000Z", 1.5);
    const rows = db.query('SELECT "_id", "quantity" FROM "items" ORDER BY "_id"').all() as {
      _id: string;
      quantity: number;
    }[];
    expect(rows).toEqual([
      { _id: "r1", quantity: 3 },
      { _id: "r2", quantity: 1.5 },
    ]);
  });

  test("book-tracker.json / library-with-reference.json も適用できる", async () => {
    applyManifestDdl(db, await loadManifest("book-tracker.json"));
    expect(tableNames(db)).toContain("books");

    const db2 = new Database(join(dir, "app2.sqlite"), { create: true });
    try {
      applyManifestDdl(db2, await loadManifest("library-with-reference.json"));
      expect(tableNames(db2).length).toBeGreaterThan(1);
    } finally {
      db2.close();
    }
  });

  test("テーブルを持たないマニフェストでも失敗しない", () => {
    applyManifestDdl(db, { app: { id: "empty", name: "空", tables: [], views: [] } });
    expect(tableNames(db)).toEqual([]);
  });

  test("同じテーブルを二度適用すると例外になる(黙って握りつぶさない)", async () => {
    const manifest = await loadManifest("book-tracker.json");
    applyManifestDdl(db, manifest);
    expect(() => applyManifestDdl(db, manifest)).toThrow();
  });
});
