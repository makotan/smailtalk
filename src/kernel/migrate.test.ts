import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifestDdl, quoteIdentifier } from "./ddl.ts";
import {
  applyAddField,
  applyAddTable,
  applyMigrationPlan,
  migrateSchema,
  planMigration,
} from "./migrate.ts";
import type { Field, Manifest, Table } from "./types.ts";

type ColumnInfo = { cid: number; name: string; type: string; notnull: number; pk: number };

function tableInfo(db: Database, tableId: string): ColumnInfo[] {
  return db.query(`PRAGMA table_info(${quoteIdentifier(tableId)})`).all() as ColumnInfo[];
}

function tableNames(db: Database): string[] {
  const rows = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

/** 7型すべてを持つテーブル。 */
const itemsTable: Table = {
  id: "items",
  name: "備品",
  fields: [
    { id: "name", name: "備品名", type: "text", required: true },
    { id: "note", name: "備考", type: "long_text" },
    { id: "quantity", name: "数量", type: "number" },
    { id: "in_use", name: "使用中", type: "boolean" },
    { id: "purchased_at", name: "購入日", type: "date" },
    { id: "condition", name: "状態", type: "select", options: ["新品", "良好"] },
    { id: "category", name: "カテゴリ", type: "reference", reference_table: "categories" },
  ],
};

const categoriesTable: Table = {
  id: "categories",
  name: "カテゴリ",
  fields: [{ id: "name", name: "カテゴリ名", type: "text", required: true }],
};

function baseManifest(): Manifest {
  return {
    app: {
      id: "inventory",
      name: "備品管理",
      tables: [structuredClone(categoriesTable), structuredClone(itemsTable)],
      views: [],
    },
  };
}

type ItemRow = {
  _id: string;
  name: string | null;
  note: string | null;
  quantity: number | null;
  in_use: number | null;
  purchased_at: string | null;
  condition: string | null;
  category: string | null;
};

const SEED_ROWS: ItemRow[] = [
  {
    _id: "i-1",
    name: "ノートPC",
    note: "貸出中\n複数行のメモ",
    quantity: 3,
    in_use: 1,
    purchased_at: "2026-01-15",
    condition: "新品",
    category: "c-1",
  },
  {
    _id: "i-2",
    name: "椅子",
    note: null,
    quantity: 1.5,
    in_use: 0,
    purchased_at: null,
    condition: "良好",
    category: null,
  },
  {
    _id: "i-3",
    name: 'クォート"入り',
    note: "",
    quantity: 0,
    in_use: null,
    purchased_at: "2026-07-18",
    condition: null,
    category: "c-2",
  },
];

function seed(db: Database): void {
  const stmt = db.query(
    'INSERT INTO "items" ("_id", "_created_at", "_updated_at", "name", "note", "quantity", "in_use", "purchased_at", "condition", "category")' +
      " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const row of SEED_ROWS) {
    stmt.run(
      row._id,
      "2026-07-18T00:00:00.000Z",
      "2026-07-18T00:00:00.000Z",
      row.name,
      row.note,
      row.quantity,
      row.in_use,
      row.purchased_at,
      row.condition,
      row.category,
    );
  }
}

function readItems(db: Database): ItemRow[] {
  return db
    .query(
      'SELECT "_id", "name", "note", "quantity", "in_use", "purchased_at", "condition", "category" FROM "items" ORDER BY "_id"',
    )
    .all() as ItemRow[];
}

describe("planMigration", () => {
  test("差分なしなら空のプランを返す", () => {
    const result = planMigration(baseManifest(), baseManifest());
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.plan.add_tables).toEqual([]);
    expect(result.plan.add_fields).toEqual([]);
  });

  test("テーブル追加を add_tables に導出する", () => {
    const next = baseManifest();
    const added: Table = { id: "rooms", name: "部屋", fields: [] };
    next.app.tables.push(added);
    const result = planMigration(baseManifest(), next);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.plan.add_tables).toEqual([added]);
    expect(result.plan.add_fields).toEqual([]);
  });

  test("フィールド追加を add_fields に導出する", () => {
    const next = baseManifest();
    const field: Field = { id: "memo", name: "メモ", type: "long_text" };
    next.app.tables[1]?.fields.push(field);
    const result = planMigration(baseManifest(), next);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.plan.add_fields).toEqual([{ table: "items", field }]);
  });

  test("select の選択肢追加は additive として許可する", () => {
    const next = baseManifest();
    const condition = next.app.tables[1]?.fields.find((f) => f.id === "condition");
    if (condition?.type === "select") condition.options.push("要修理");
    expect(planMigration(baseManifest(), next).valid).toBe(true);
  });

  test("表示名(name)の変更は破壊的ではないので許可する", () => {
    const next = baseManifest();
    next.app.name = "備品管理(改)";
    const items = next.app.tables[1];
    if (items !== undefined) items.name = "備品一覧";
    const field = items?.fields[0];
    if (field !== undefined) field.name = "品名";
    expect(planMigration(baseManifest(), next).valid).toBe(true);
  });

  describe("破壊的な差分は統一形式エラーで拒否する", () => {
    test("テーブル削除", () => {
      const next = baseManifest();
      next.app.tables = next.app.tables.filter((t) => t.id !== "items");
      const result = planMigration(baseManifest(), next);
      expect(result.valid).toBe(false);
      if (result.valid) return;
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.path).toBe("/app/tables");
      expect(result.errors[0]?.message).toContain("items");
      expect(result.errors[0]?.message.length).toBeGreaterThan(0);
    });

    test("フィールド削除", () => {
      const next = baseManifest();
      const items = next.app.tables[1];
      if (items !== undefined) items.fields = items.fields.filter((f) => f.id !== "note");
      const result = planMigration(baseManifest(), next);
      expect(result.valid).toBe(false);
      if (result.valid) return;
      expect(result.errors[0]?.path).toBe("/app/tables/1/fields");
      expect(result.errors[0]?.message).toContain("note");
    });

    test("フィールドの型変更", () => {
      const next = baseManifest();
      const field = next.app.tables[1]?.fields.find((f) => f.id === "quantity");
      if (field !== undefined) (field as { type: string }).type = "text";
      const result = planMigration(baseManifest(), next);
      expect(result.valid).toBe(false);
      if (result.valid) return;
      expect(result.errors[0]?.path).toBe("/app/tables/1/fields/2/type");
      expect(result.errors[0]?.message).toContain("number");
      expect(result.errors[0]?.message).toContain("text");
    });

    test("select の選択肢削除", () => {
      const next = baseManifest();
      const condition = next.app.tables[1]?.fields.find((f) => f.id === "condition");
      if (condition?.type === "select") condition.options = ["新品"];
      const result = planMigration(baseManifest(), next);
      expect(result.valid).toBe(false);
      if (result.valid) return;
      expect(result.errors[0]?.path).toBe("/app/tables/1/fields/5/options");
      expect(result.errors[0]?.message).toContain("良好");
    });

    test("reference の参照先テーブル変更", () => {
      const next = baseManifest();
      const category = next.app.tables[1]?.fields.find((f) => f.id === "category");
      if (category?.type === "reference") category.reference_table = "categories";
      const changed = baseManifest();
      const target = changed.app.tables[1]?.fields.find((f) => f.id === "category");
      if (target?.type === "reference") target.reference_table = "rooms";
      const result = planMigration(baseManifest(), changed);
      expect(result.valid).toBe(false);
      if (result.valid) return;
      expect(result.errors[0]?.path).toBe("/app/tables/1/fields/6/reference_table");
    });

    test("ビュー削除", () => {
      const current = baseManifest();
      current.app.views.push({ id: "item-detail", type: "detail_view", table: "items" });
      const result = planMigration(current, baseManifest());
      expect(result.valid).toBe(false);
      if (result.valid) return;
      expect(result.errors[0]?.path).toBe("/app/views");
      expect(result.errors[0]?.message).toContain("item-detail");
    });

    test("ビューの type / table 変更", () => {
      const current = baseManifest();
      current.app.views.push({ id: "v1", type: "detail_view", table: "items" });
      const next = baseManifest();
      next.app.views.push({ id: "v1", type: "detail_view", table: "categories" });
      const result = planMigration(current, next);
      expect(result.valid).toBe(false);
      if (result.valid) return;
      expect(result.errors[0]?.path).toBe("/app/views/0/table");
    });

    test("app.id の変更", () => {
      const next = baseManifest();
      next.app.id = "other-app";
      const result = planMigration(baseManifest(), next);
      expect(result.valid).toBe(false);
      if (result.valid) return;
      expect(result.errors[0]?.path).toBe("/app/id");
    });

    test("複数の破壊的差分をまとめて報告する", () => {
      const next = baseManifest();
      next.app.tables = next.app.tables.filter((t) => t.id !== "categories");
      const items = next.app.tables[0];
      if (items !== undefined) items.fields = items.fields.filter((f) => f.id !== "note");
      const result = planMigration(baseManifest(), next);
      expect(result.valid).toBe(false);
      if (result.valid) return;
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe("破壊的な呼び口が存在しない(v0はadditiveのみ)", () => {
  test("migrate モジュールは drop / rename / 型変更の関数を公開しない", async () => {
    const exported = Object.keys(await import("./migrate.ts"));
    for (const name of exported) {
      expect(name.toLowerCase()).not.toContain("drop");
      expect(name.toLowerCase()).not.toContain("rename");
      expect(name.toLowerCase()).not.toContain("delete");
      expect(name.toLowerCase()).not.toContain("remove");
    }
  });
});

describe("マイグレーション適用", () => {
  let dir: string;
  let dbPath: string;
  let db: Database;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gp-migrate-"));
    dbPath = join(dir, "app.sqlite");
    db = new Database(dbPath, { create: true });
    db.exec("PRAGMA journal_mode = DELETE;");
    applyManifestDdl(db, baseManifest());
    seed(db);
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("ラウンドトリップ: 列追加+テーブル追加後も既存レコードが全件・全値一致", () => {
    const before = readItems(db);
    expect(before).toEqual(SEED_ROWS);

    const next = baseManifest();
    next.app.tables[1]?.fields.push({ id: "memo", name: "メモ", type: "long_text" });
    next.app.tables.push({
      id: "rooms",
      name: "部屋",
      fields: [{ id: "label", name: "名称", type: "text" }],
    });

    const result = migrateSchema(db, baseManifest(), next);
    expect(result.valid).toBe(true);

    expect(readItems(db)).toEqual(SEED_ROWS);
    expect(tableNames(db)).toContain("rooms");
  });

  test("追加された列は既存レコードで NULL として読める", () => {
    applyAddField(db, "items", { id: "memo", name: "メモ", type: "long_text" });
    const rows = db.query('SELECT "_id", "memo" FROM "items" ORDER BY "_id"').all() as {
      _id: string;
      memo: string | null;
    }[];
    expect(rows).toEqual([
      { _id: "i-1", memo: null },
      { _id: "i-2", memo: null },
      { _id: "i-3", memo: null },
    ]);
  });

  test("7型すべてを含むテーブルへ7型すべての列を追加できる", () => {
    const added: Field[] = [
      { id: "extra-text", name: "追加text", type: "text" },
      { id: "extra_long", name: "追加long", type: "long_text" },
      { id: "extra_number", name: "追加number", type: "number" },
      { id: "extra_boolean", name: "追加boolean", type: "boolean" },
      { id: "extra_date", name: "追加date", type: "date" },
      { id: "extra_select", name: "追加select", type: "select", options: ["a", "b"] },
      {
        id: "extra_ref",
        name: "追加ref",
        type: "reference",
        reference_table: "categories",
      },
    ];
    for (const field of added) {
      applyAddField(db, "items", field);
    }
    const types = Object.fromEntries(tableInfo(db, "items").map((c) => [c.name, c.type]));
    expect(types["extra-text"]).toBe("TEXT");
    expect(types.extra_long).toBe("TEXT");
    expect(types.extra_number).toBe("NUMERIC");
    expect(types.extra_boolean).toBe("INTEGER");
    expect(types.extra_date).toBe("TEXT");
    expect(types.extra_select).toBe("TEXT");
    expect(types.extra_ref).toBe("TEXT");
    // 既存データは無傷。
    expect(readItems(db)).toEqual(SEED_ROWS);
  });

  test("追加列は NOT NULL にならない(既存行があっても ADD COLUMN が通る)", () => {
    applyAddField(db, "items", { id: "must", name: "必須", type: "text", required: true });
    const column = tableInfo(db, "items").find((c) => c.name === "must");
    expect(column?.notnull).toBe(0);
  });

  test("applyAddTable でテーブルを追加できる", () => {
    applyAddTable(db, { id: "rooms", name: "部屋", fields: [] });
    expect(tableNames(db)).toContain("rooms");
  });

  test("破壊的な差分は SQLite の状態を一切変えずに拒否される", () => {
    const next = baseManifest();
    // 追加(additive)と削除(破壊的)を混ぜる。
    next.app.tables.push({ id: "rooms", name: "部屋", fields: [] });
    const items = next.app.tables[1];
    if (items !== undefined) items.fields = items.fields.filter((f) => f.id !== "note");

    const result = migrateSchema(db, baseManifest(), next);
    expect(result.valid).toBe(false);
    // additive 側も適用されていないこと。
    expect(tableNames(db)).toEqual(["categories", "items"]);
    expect(readItems(db)).toEqual(SEED_ROWS);
  });

  test("適用中に失敗したら途中の DDL もロールバックされる", () => {
    const plan = {
      add_tables: [
        { id: "rooms", name: "部屋", fields: [] },
        // 既存テーブルと同名: CREATE TABLE が失敗する。
        { id: "items", name: "重複", fields: [] },
      ],
      add_fields: [],
    };
    expect(() => applyMigrationPlan(db, plan)).toThrow();
    expect(tableNames(db)).toEqual(["categories", "items"]);
  });

  test("プロセス再起動相当(再オープン)後も移行結果とデータが残る", () => {
    const next = baseManifest();
    next.app.tables[1]?.fields.push({ id: "memo", name: "メモ", type: "long_text" });
    expect(migrateSchema(db, baseManifest(), next).valid).toBe(true);
    db.close();

    db = new Database(dbPath, { readwrite: true });
    expect(readItems(db)).toEqual(SEED_ROWS);
    expect(tableInfo(db, "items").some((c) => c.name === "memo")).toBe(true);
  });
});

/**
 * **`planMigration` の直書きエラー文言が黙って古くならないようにする**(V3-M2-T01。完了条件10)。
 *
 * `migrate.ts` の「`update_view` で変更できるのは … のみです。」という2つのメッセージは
 * **キー名を直書き**しており、**それを固定するテストが1本も無かった**
 * (`docs/plan/v3/records/v3-m2.md` §2-10 (B))。**キーが増えるたびに黙って嘘になる。**
 *
 * そこで **`schemas/diff.schema.json` の `$defs/view_changes` のキー集合そのものと
 * 文言を突き合わせる。** 以後は `view_changes` にキーが増えた時点でここが赤くなる。
 */
describe("V3-M2-T01: マニフェスト直渡し経路のエラー文言が view_changes のキー集合と一致する", () => {
  function viewChangeKeys(): string[] {
    const schema = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "schemas", "diff.schema.json"), "utf-8"),
    ) as { $defs: { view_changes: { properties: Record<string, unknown> } } };
    return Object.keys(schema.$defs.view_changes.properties);
  }

  function withView(view: Manifest["app"]["views"][number]): Manifest {
    const manifest = baseManifest();
    manifest.app.views = [view];
    return manifest;
  }

  /** 「変更できるのは A / B / C のみです。」の A / B / C を取り出す。 */
  function enumeratedKeys(message: string): string[] {
    const matched = /変更できるのは (.+?) のみです。/.exec(message);
    expect(matched, message).not.toBeNull();
    return (matched?.[1] ?? "").split(" / ");
  }

  test("ビューの type を変えようとしたときの文言が全キーを列挙している", () => {
    const current = withView({ id: "v1", type: "list_view", table: "items", columns: ["name"] });
    const next = withView({ id: "v1", type: "detail_view", table: "items" });
    const result = planMigration(current, next);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    const message = result.errors[0]?.message ?? "";
    expect(enumeratedKeys(message)).toEqual(viewChangeKeys());
  });

  test("ビューの対象テーブルを変えようとしたときの文言が全キーを列挙している", () => {
    const current = withView({ id: "v1", type: "list_view", table: "items", columns: ["name"] });
    const next = withView({ id: "v1", type: "list_view", table: "categories", columns: ["name"] });
    const result = planMigration(current, next);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    const message = result.errors[0]?.message ?? "";
    expect(enumeratedKeys(message)).toEqual(viewChangeKeys());
  });
});
