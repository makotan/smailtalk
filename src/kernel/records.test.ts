import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armManifestForAutomation,
  fixtureOwnerValues,
  OWNER_FIELD,
  seedAutomationActor,
} from "./automation-actor-fixture.test.ts";
import { applyManifestDdl } from "./ddl.ts";
import type { ValidationError } from "./errors.ts";
import {
  countRecords,
  createRecord as createRecordRaw,
  deleteRecord,
  getRecord,
  listRecords,
  type RecordRow,
  updateRecord,
} from "./records.ts";
import type { FilterNode, Manifest } from "./types.ts";

/**
 * **【`V8-M26`(2026-08-10)】行を作る。**
 * **`describe("ワークフローの発火地点")` が壁を開けた表にだけ、書き手を既定で入れる**
 * ({@link fixtureOwnerValues} は下ごしらえが足した持ち主の列だけを見る)。
 * **それ以外の検査からは、この包みは1ミリも見えない。**
 */
function createRecord(
  database: Database,
  target: Manifest,
  tableId: string,
  values: Record<string, unknown>,
): ReturnType<typeof createRecordRaw> {
  return createRecordRaw(database, target, tableId, fixtureOwnerValues(target, tableId, values));
}

/** fixtures/valid/inventory-all-field-types.json と同じ7型を持つマニフェスト。 */
function inventoryManifest(): Manifest {
  return {
    app: {
      id: "inventory",
      name: "備品管理",
      tables: [
        {
          id: "categories",
          name: "カテゴリ",
          fields: [{ id: "name", name: "カテゴリ名", type: "text", required: true }],
        },
        {
          id: "items",
          name: "備品",
          fields: [
            { id: "name", name: "備品名", type: "text", required: true },
            { id: "note", name: "備考", type: "long_text" },
            { id: "quantity", name: "数量", type: "number", required: true },
            { id: "in_use", name: "使用中", type: "boolean" },
            { id: "purchased_at", name: "購入日", type: "date" },
            {
              id: "condition",
              name: "状態",
              type: "select",
              options: ["新品", "良好", "要修理"],
            },
            {
              id: "category",
              name: "カテゴリ",
              type: "reference",
              reference_table: "categories",
            },
          ],
        },
      ],
      views: [],
    },
  };
}

let dir: string;
let db: Database;
let manifest: Manifest;

/** 成功を前提に値を取り出す。失敗ならエラー内容を添えて落とす。 */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; errors: ValidationError[] }): T {
  if (!result.ok) {
    throw new Error(`期待に反して失敗しました: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

/** 失敗を前提にエラー配列を取り出す。 */
function errorsOf(
  result: { ok: true; value: unknown } | { ok: false; errors: ValidationError[] },
): ValidationError[] {
  if (result.ok) {
    throw new Error(`期待に反して成功しました: ${JSON.stringify(result.value)}`);
  }
  return result.errors;
}

/** カテゴリを1件作り、その `_id` を返す(reference のテスト用)。 */
function makeCategory(name: string): string {
  return unwrap(createRecord(db, manifest, "categories", { name }))._id;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gp-records-"));
  db = new Database(join(dir, "app.sqlite"));
  manifest = inventoryManifest();
  applyManifestDdl(db, manifest);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("createRecord / getRecord: 7型のラウンドトリップ", () => {
  test("7型すべての値が書いた形のまま読み出せる", () => {
    const categoryId = makeCategory("家具");
    const input = {
      name: "デスク",
      note: "複数行の\n備考テキスト",
      quantity: 12,
      in_use: true,
      purchased_at: "2026-07-18",
      condition: "良好",
      category: categoryId,
    };

    const created = unwrap(createRecord(db, manifest, "items", input));
    for (const [key, value] of Object.entries(input)) {
      expect(created[key]).toBe(value);
    }

    const fetched = unwrap(getRecord(db, manifest, "items", created._id));
    expect(fetched).not.toBeNull();
    for (const [key, value] of Object.entries(input)) {
      expect((fetched as RecordRow)[key]).toBe(value);
    }
  });

  test("boolean は 0/1 ではなく true/false で返る", () => {
    const t = unwrap(createRecord(db, manifest, "items", { name: "A", quantity: 1, in_use: true }));
    const f = unwrap(
      createRecord(db, manifest, "items", { name: "B", quantity: 1, in_use: false }),
    );
    expect(t.in_use).toBe(true);
    expect(f.in_use).toBe(false);
    expect(unwrap(getRecord(db, manifest, "items", t._id))?.in_use).toBe(true);
    expect(unwrap(getRecord(db, manifest, "items", f._id))?.in_use).toBe(false);
  });

  test("number は整数が整数のまま、小数が小数のまま返る", () => {
    const i = unwrap(createRecord(db, manifest, "items", { name: "A", quantity: 42 }));
    const f = unwrap(createRecord(db, manifest, "items", { name: "B", quantity: 3.5 }));
    expect(i.quantity).toBe(42);
    expect(Number.isInteger(i.quantity)).toBe(true);
    expect(f.quantity).toBe(3.5);
    expect(unwrap(getRecord(db, manifest, "items", i._id))?.quantity).toBe(42);
    expect(unwrap(getRecord(db, manifest, "items", f._id))?.quantity).toBe(3.5);
  });

  test("システム列が付与される(_id は UUID、日時は ISO8601 UTC)", () => {
    const row = unwrap(createRecord(db, manifest, "items", { name: "A", quantity: 1 }));
    expect(row._id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(row._created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(row._updated_at).toBe(row._created_at);
  });

  test("required でないフィールドは省略でき null で返る", () => {
    const row = unwrap(createRecord(db, manifest, "items", { name: "A", quantity: 1 }));
    expect(row.note).toBeNull();
    expect(row.in_use).toBeNull();
    expect(row.purchased_at).toBeNull();
    expect(row.condition).toBeNull();
    expect(row.category).toBeNull();
  });

  test("required でないフィールドには明示的な null を書ける", () => {
    const row = unwrap(
      createRecord(db, manifest, "items", { name: "A", quantity: 1, note: null, in_use: null }),
    );
    expect(row.note).toBeNull();
    expect(row.in_use).toBeNull();
  });

  test("存在しないレコードIDの取得は null を返す(エラーではない)", () => {
    expect(unwrap(getRecord(db, manifest, "items", "no-such-id"))).toBeNull();
  });

  test("date は日付のみ・日時つきのどちらも受け付ける", () => {
    const a = unwrap(
      createRecord(db, manifest, "items", { name: "A", quantity: 1, purchased_at: "2026-07-18" }),
    );
    const b = unwrap(
      createRecord(db, manifest, "items", {
        name: "B",
        quantity: 1,
        purchased_at: "2026-07-18T09:30:00Z",
      }),
    );
    expect(a.purchased_at).toBe("2026-07-18");
    expect(b.purchased_at).toBe("2026-07-18T09:30:00Z");
  });
});

describe("createRecord: 書き込み時バリデーション", () => {
  test("required フィールドの欠落を拒否する", () => {
    const errors = errorsOf(createRecord(db, manifest, "items", { note: "メモ" }));
    expect(errors.map((e) => e.path).sort()).toEqual(["/name", "/quantity"]);
    expect(errors[0]?.message).toContain("必須");
  });

  test("required フィールドの null / 空文字を拒否する", () => {
    const nullErrors = errorsOf(createRecord(db, manifest, "items", { name: null, quantity: 1 }));
    expect(nullErrors.map((e) => e.path)).toEqual(["/name"]);
    const emptyErrors = errorsOf(createRecord(db, manifest, "items", { name: "  ", quantity: 1 }));
    expect(emptyErrors.map((e) => e.path)).toEqual(["/name"]);
  });

  test("select の選択肢外の値を allowed_values 付きで拒否する", () => {
    const errors = errorsOf(
      createRecord(db, manifest, "items", { name: "A", quantity: 1, condition: "ジャンク" }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/condition");
    expect(errors[0]?.allowed_values).toEqual(["新品", "良好", "要修理"]);
  });

  test("参照切れ(存在しない _id を指す reference)を拒否する", () => {
    const errors = errorsOf(
      createRecord(db, manifest, "items", { name: "A", quantity: 1, category: "missing-id" }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/category");
    expect(errors[0]?.message).toContain("categories");
  });

  test("実在する参照は通る", () => {
    const categoryId = makeCategory("消耗品");
    const row = unwrap(
      createRecord(db, manifest, "items", { name: "A", quantity: 1, category: categoryId }),
    );
    expect(row.category).toBe(categoryId);
  });

  test("型不正(number に文字列)を拒否する", () => {
    const errors = errorsOf(createRecord(db, manifest, "items", { name: "A", quantity: "12" }));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/quantity");
    expect(errors[0]?.message).toContain("number");
  });

  test("型不正(number に NaN / Infinity)を拒否する", () => {
    expect(
      errorsOf(createRecord(db, manifest, "items", { name: "A", quantity: Number.NaN })).length,
    ).toBe(1);
    expect(
      errorsOf(
        createRecord(db, manifest, "items", { name: "A", quantity: Number.POSITIVE_INFINITY }),
      ).length,
    ).toBe(1);
  });

  test("型不正(boolean に文字列)を拒否する", () => {
    const errors = errorsOf(
      createRecord(db, manifest, "items", { name: "A", quantity: 1, in_use: "true" }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/in_use");
    expect(errors[0]?.message).toContain("boolean");
  });

  test("型不正(text に数値)を拒否する", () => {
    const errors = errorsOf(createRecord(db, manifest, "items", { name: 123, quantity: 1 }));
    expect(errors.map((e) => e.path)).toEqual(["/name"]);
  });

  test("型不正(date が ISO8601 でない)を拒否する", () => {
    for (const bad of ["2026/07/18", "18-07-2026", "2026-13-01", "not a date", "2026-02-30"]) {
      const errors = errorsOf(
        createRecord(db, manifest, "items", { name: "A", quantity: 1, purchased_at: bad }),
      );
      expect(errors.map((e) => e.path)).toEqual(["/purchased_at"]);
    }
  });

  test("マニフェストに存在しないフィールドへの書き込みを allowed_values 付きで拒否する", () => {
    const errors = errorsOf(
      createRecord(db, manifest, "items", { name: "A", quantity: 1, color: "red" }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/color");
    expect(errors[0]?.allowed_values).toEqual([
      "name",
      "note",
      "quantity",
      "in_use",
      "purchased_at",
      "condition",
      "category",
    ]);
  });

  test("システム列への書き込みを拒否する", () => {
    const errors = errorsOf(
      createRecord(db, manifest, "items", { name: "A", quantity: 1, _id: "手書きID" }),
    );
    expect(errors.map((e) => e.path)).toEqual(["/_id"]);
  });

  test("存在しないテーブルを allowed_values 付きで拒否する", () => {
    const errors = errorsOf(createRecord(db, manifest, "unknown", { name: "A" }));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.allowed_values).toEqual(["categories", "items"]);
  });

  test("違反は全件まとめて返る", () => {
    const errors = errorsOf(
      createRecord(db, manifest, "items", {
        quantity: "多い",
        in_use: "yes",
        condition: "不明",
        color: "red",
      }),
    );
    expect(errors.map((e) => e.path).sort()).toEqual([
      "/color",
      "/condition",
      "/in_use",
      "/name",
      "/quantity",
    ]);
  });

  test("バリデーションに失敗したときレコードは作られない", () => {
    errorsOf(createRecord(db, manifest, "items", { quantity: 1 }));
    expect(unwrap(countRecords(db, manifest, "items"))).toBe(0);
  });
});

describe("listRecords: ソートとフィルタ", () => {
  beforeEach(() => {
    const rows = [
      { name: "B", quantity: 2, in_use: true, condition: "良好" },
      { name: "A", quantity: 3, in_use: false, condition: "新品" },
      { name: "C", quantity: 1, in_use: true, condition: "新品" },
    ];
    for (const row of rows) {
      unwrap(createRecord(db, manifest, "items", row));
    }
  });

  test("sort なしでも全件返る", () => {
    expect(unwrap(listRecords(db, manifest, "items")).length).toBe(3);
  });

  test("asc でソートできる", () => {
    const rows = unwrap(
      listRecords(db, manifest, "items", { sort: { field: "quantity", order: "asc" } }),
    );
    expect(rows.map((r) => r.quantity)).toEqual([1, 2, 3]);
  });

  test("desc でソートできる", () => {
    const rows = unwrap(
      listRecords(db, manifest, "items", { sort: { field: "name", order: "desc" } }),
    );
    expect(rows.map((r) => r.name)).toEqual(["C", "B", "A"]);
  });

  test("単一フィルタで絞り込める(boolean)", () => {
    const rows = unwrap(
      listRecords(db, manifest, "items", { filter: [{ field: "in_use", equals: true }] }),
    );
    expect(rows.map((r) => r.name).sort()).toEqual(["B", "C"]);
    expect(rows.every((r) => r.in_use === true)).toBe(true);
  });

  test("複数フィルタは AND で効く", () => {
    const rows = unwrap(
      listRecords(db, manifest, "items", {
        filter: [
          { field: "in_use", equals: true },
          { field: "condition", equals: "新品" },
        ],
      }),
    );
    expect(rows.map((r) => r.name)).toEqual(["C"]);
  });

  test("フィルタとソートを併用できる", () => {
    const rows = unwrap(
      listRecords(db, manifest, "items", {
        filter: [{ field: "in_use", equals: true }],
        sort: { field: "quantity", order: "desc" },
      }),
    );
    expect(rows.map((r) => r.name)).toEqual(["B", "C"]);
  });

  test("一致するものがなければ空配列", () => {
    const rows = unwrap(
      listRecords(db, manifest, "items", { filter: [{ field: "quantity", equals: 999 }] }),
    );
    expect(rows).toEqual([]);
  });

  test("一覧でも 7型の値は正しい型で返る", () => {
    const rows = unwrap(
      listRecords(db, manifest, "items", { sort: { field: "quantity", order: "asc" } }),
    );
    expect(rows[0]?.in_use).toBe(true);
    expect(rows[0]?.quantity).toBe(1);
  });

  test("存在しないフィールドでのソートを統一形式エラーで拒否する", () => {
    const errors = errorsOf(
      listRecords(db, manifest, "items", { sort: { field: "nope", order: "asc" } }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/sort/field");
    expect(errors[0]?.allowed_values).toContain("quantity");
  });

  test("存在しないフィールドでのフィルタを統一形式エラーで拒否する", () => {
    const errors = errorsOf(
      listRecords(db, manifest, "items", { filter: [{ field: "nope", equals: 1 }] }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/filter/0/field");
    expect(errors[0]?.allowed_values).toContain("quantity");
  });

  test("フィルタ値の型不正を拒否する", () => {
    const errors = errorsOf(
      listRecords(db, manifest, "items", { filter: [{ field: "quantity", equals: "多い" }] }),
    );
    expect(errors.map((e) => e.path)).toEqual(["/filter/0/equals"]);
  });

  test("SQLインジェクションを狙ったソート指定はエラーになり、テーブルは残る", () => {
    errorsOf(
      listRecords(db, manifest, "items", {
        sort: { field: '"items"; DROP TABLE "items"; --', order: "asc" },
      }),
    );
    expect(unwrap(countRecords(db, manifest, "items"))).toBe(3);
  });
});

describe("listRecords: ブール式フィルタ(EC-G12 / ADR-0043)", () => {
  beforeEach(() => {
    const rows = [
      { name: "アルファ", quantity: 2, in_use: true, condition: "良好" },
      { name: "ベータ", quantity: 3, in_use: false, condition: "新品" },
      { name: "ガンマ", quantity: 1, in_use: true, condition: "新品" },
    ];
    for (const row of rows) {
      unwrap(createRecord(db, manifest, "items", row));
    }
  });

  const names = (rows: RecordRow[]): string[] => rows.map((r) => r.name as string).sort();

  test("contains で部分一致検索できる(葉演算子)", () => {
    const rows = unwrap(
      listRecords(db, manifest, "items", { filter: { field: "name", contains: "ル" } }),
    );
    expect(names(rows)).toEqual(["アルファ"]);
  });

  test("gte で以上の比較ができる", () => {
    const rows = unwrap(
      listRecords(db, manifest, "items", { filter: { field: "quantity", gte: 2 } }),
    );
    expect(names(rows)).toEqual(["アルファ", "ベータ"]);
  });

  test("lte で以下の比較ができる", () => {
    const rows = unwrap(
      listRecords(db, manifest, "items", { filter: { field: "quantity", lte: 2 } }),
    );
    expect(names(rows)).toEqual(["アルファ", "ガンマ"]);
  });

  test("in で複数値のいずれかに一致するものを取れる", () => {
    const rows = unwrap(
      listRecords(db, manifest, "items", { filter: { field: "condition", in: ["新品", "良好"] } }),
    );
    expect(names(rows)).toEqual(["アルファ", "ガンマ", "ベータ"]);
  });

  test("空の in は常に偽(1件も返さない)", () => {
    const rows = unwrap(
      listRecords(db, manifest, "items", { filter: { field: "condition", in: [] } }),
    );
    expect(rows).toEqual([]);
  });

  test("and で AND 結合できる", () => {
    const rows = unwrap(
      listRecords(db, manifest, "items", {
        filter: {
          and: [
            { field: "quantity", gte: 2 },
            { field: "in_use", equals: true },
          ],
        },
      }),
    );
    expect(names(rows)).toEqual(["アルファ"]);
  });

  test("or で OR 結合できる", () => {
    const rows = unwrap(
      listRecords(db, manifest, "items", {
        filter: {
          or: [
            { field: "quantity", equals: 1 },
            { field: "condition", equals: "良好" },
          ],
        },
      }),
    );
    expect(names(rows)).toEqual(["アルファ", "ガンマ"]);
  });

  test("not で否定できる", () => {
    const rows = unwrap(
      listRecords(db, manifest, "items", { filter: { not: { field: "in_use", equals: true } } }),
    );
    expect(names(rows)).toEqual(["ベータ"]);
  });

  test("and/or/not をネストできる", () => {
    const rows = unwrap(
      listRecords(db, manifest, "items", {
        filter: {
          and: [
            {
              or: [
                { field: "condition", equals: "新品" },
                { field: "condition", equals: "良好" },
              ],
            },
            { not: { field: "quantity", equals: 3 } },
          ],
        },
      }),
    );
    expect(names(rows)).toEqual(["アルファ", "ガンマ"]);
  });

  test("空の and は真(全件)・空の or は偽(0件)", () => {
    expect(unwrap(listRecords(db, manifest, "items", { filter: { and: [] } })).length).toBe(3);
    expect(unwrap(listRecords(db, manifest, "items", { filter: { or: [] } }))).toEqual([]);
  });

  test("後方互換: 等値AND配列形は従来どおり暗黙ANDで効く", () => {
    const rows = unwrap(
      listRecords(db, manifest, "items", {
        filter: [
          { field: "in_use", equals: true },
          { field: "condition", equals: "新品" },
        ],
      }),
    );
    expect(names(rows)).toEqual(["ガンマ"]);
  });

  test("ネスト深度上限を超える filter は拒否される(DoS 予防)", () => {
    let node: FilterNode = { field: "in_use", equals: true };
    for (let i = 0; i < 20; i += 1) {
      node = { not: node };
    }
    const errors = errorsOf(listRecords(db, manifest, "items", { filter: node }));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /深度|depth|ネスト/.test(e.message))).toBe(true);
  });

  test("値はパラメータ化され SQL インジェクションできない(テーブルは残る)", () => {
    const rows = unwrap(
      listRecords(db, manifest, "items", {
        filter: { field: "name", contains: '"; DROP TABLE "items"; --' },
      }),
    );
    expect(rows).toEqual([]);
    expect(unwrap(countRecords(db, manifest, "items"))).toBe(3);
  });

  test("contains の LIKE メタ文字(% / _)はリテラル一致になる", () => {
    unwrap(createRecord(db, manifest, "items", { name: "50%オフ", quantity: 9 }));
    // "%" はワイルドカードではなくリテラルとして扱う
    const literal = unwrap(
      listRecords(db, manifest, "items", { filter: { field: "name", contains: "50%" } }),
    );
    expect(names(literal)).toEqual(["50%オフ"]);
    // "_" もワイルドカードにならない(3文字なんでも、にはならない)
    const underscore = unwrap(
      listRecords(db, manifest, "items", { filter: { field: "name", contains: "5_%" } }),
    );
    expect(underscore).toEqual([]);
  });

  test("葉に演算子が2つあると拒否される(1葉1演算子)", () => {
    const errors = errorsOf(
      listRecords(db, manifest, "items", {
        filter: { field: "quantity", gte: 1, lte: 3 },
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  test("葉に演算子が無いと拒否される", () => {
    const errors = errorsOf(
      listRecords(db, manifest, "items", {
        filter: { field: "quantity" } as unknown as FilterNode,
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  test("contains を数値フィールドに使うと拒否される(文字列対象のみ)", () => {
    const errors = errorsOf(
      listRecords(db, manifest, "items", {
        filter: { field: "quantity", contains: "2" },
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  test("存在しないフィールドを葉に使うと拒否される", () => {
    const errors = errorsOf(
      listRecords(db, manifest, "items", { filter: { field: "nope", equals: 1 } }),
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.allowed_values?.includes("quantity"))).toBe(true);
  });

  test("葉の値の型不正を拒否する", () => {
    const errors = errorsOf(
      listRecords(db, manifest, "items", { filter: { field: "quantity", gte: "多い" } }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  test("countRecords が filter を受けて絞り込み後の件数を返す(等値AND配列)", () => {
    expect(
      unwrap(countRecords(db, manifest, "items", { filter: [{ field: "in_use", equals: true }] })),
    ).toBe(2);
  });

  test("countRecords が filter を受けて絞り込み後の件数を返す(ブール式)", () => {
    expect(
      unwrap(countRecords(db, manifest, "items", { filter: { field: "quantity", gte: 2 } })),
    ).toBe(2);
    expect(unwrap(countRecords(db, manifest, "items"))).toBe(3);
  });
});

describe("updateRecord", () => {
  test("部分更新で他フィールドは変わらない", () => {
    const created = unwrap(
      createRecord(db, manifest, "items", {
        name: "デスク",
        note: "メモ",
        quantity: 5,
        in_use: true,
      }),
    );
    const updated = unwrap(updateRecord(db, manifest, "items", created._id, { quantity: 7 }));
    expect(updated.quantity).toBe(7);
    expect(updated.name).toBe("デスク");
    expect(updated.note).toBe("メモ");
    expect(updated.in_use).toBe(true);
    expect(updated._created_at).toBe(created._created_at);
  });

  test("_updated_at が進む", async () => {
    const created = unwrap(createRecord(db, manifest, "items", { name: "A", quantity: 1 }));
    await Bun.sleep(2);
    const updated = unwrap(updateRecord(db, manifest, "items", created._id, { quantity: 2 }));
    expect(updated._updated_at > created._updated_at).toBe(true);
  });

  test("required フィールドを null にする更新を拒否する", () => {
    const created = unwrap(createRecord(db, manifest, "items", { name: "A", quantity: 1 }));
    const errors = errorsOf(updateRecord(db, manifest, "items", created._id, { name: null }));
    expect(errors.map((e) => e.path)).toEqual(["/name"]);
    expect(unwrap(getRecord(db, manifest, "items", created._id))?.name).toBe("A");
  });

  test("required フィールドを省略した部分更新は通る", () => {
    const created = unwrap(createRecord(db, manifest, "items", { name: "A", quantity: 1 }));
    const updated = unwrap(updateRecord(db, manifest, "items", created._id, { note: "追記" }));
    expect(updated.name).toBe("A");
    expect(updated.note).toBe("追記");
  });

  test("required でないフィールドは更新で null に戻せる", () => {
    const created = unwrap(
      createRecord(db, manifest, "items", { name: "A", quantity: 1, note: "メモ" }),
    );
    const updated = unwrap(updateRecord(db, manifest, "items", created._id, { note: null }));
    expect(updated.note).toBeNull();
  });

  test("更新でも select / reference / 型 / 未知フィールドを検証する", () => {
    const created = unwrap(createRecord(db, manifest, "items", { name: "A", quantity: 1 }));
    expect(
      errorsOf(updateRecord(db, manifest, "items", created._id, { condition: "不明" }))[0]
        ?.allowed_values,
    ).toEqual(["新品", "良好", "要修理"]);
    expect(
      errorsOf(updateRecord(db, manifest, "items", created._id, { category: "missing" })).map(
        (e) => e.path,
      ),
    ).toEqual(["/category"]);
    expect(
      errorsOf(updateRecord(db, manifest, "items", created._id, { quantity: "x" })).map(
        (e) => e.path,
      ),
    ).toEqual(["/quantity"]);
    expect(
      errorsOf(updateRecord(db, manifest, "items", created._id, { color: "red" }))[0]
        ?.allowed_values,
    ).toContain("name");
  });

  test("存在しないレコードの更新を統一形式エラーで拒否する", () => {
    const errors = errorsOf(updateRecord(db, manifest, "items", "missing", { quantity: 1 }));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("missing");
  });

  test("空の更新でも _updated_at は進む", async () => {
    const created = unwrap(createRecord(db, manifest, "items", { name: "A", quantity: 1 }));
    await Bun.sleep(2);
    const updated = unwrap(updateRecord(db, manifest, "items", created._id, {}));
    expect(updated._updated_at > created._updated_at).toBe(true);
    expect(updated.name).toBe("A");
  });
});

describe("deleteRecord", () => {
  test("レコードを削除できる", () => {
    const created = unwrap(createRecord(db, manifest, "items", { name: "A", quantity: 1 }));
    expect(unwrap(deleteRecord(db, manifest, "items", created._id))).toBe(true);
    expect(unwrap(getRecord(db, manifest, "items", created._id))).toBeNull();
    expect(unwrap(countRecords(db, manifest, "items"))).toBe(0);
  });

  test("存在しないレコードの削除は false を返す", () => {
    expect(unwrap(deleteRecord(db, manifest, "items", "missing"))).toBe(false);
  });

  test("他のレコードは残る", () => {
    const a = unwrap(createRecord(db, manifest, "items", { name: "A", quantity: 1 }));
    unwrap(createRecord(db, manifest, "items", { name: "B", quantity: 2 }));
    unwrap(deleteRecord(db, manifest, "items", a._id));
    const rows = unwrap(listRecords(db, manifest, "items"));
    expect(rows.map((r) => r.name)).toEqual(["B"]);
  });

  test("存在しないテーブルの削除を拒否する", () => {
    expect(errorsOf(deleteRecord(db, manifest, "unknown", "x"))[0]?.allowed_values).toEqual([
      "categories",
      "items",
    ]);
  });
});

/** 衝突(版不一致)を前提にエラー配列を取り出す(discriminant `conflict:true` を確認)。 */
function conflictOf(
  result: { ok: true; value: unknown } | { ok: false; errors: ValidationError[]; conflict?: true },
): ValidationError[] {
  if (result.ok) {
    throw new Error(`期待に反して成功しました: ${JSON.stringify(result.value)}`);
  }
  if (result.conflict !== true) {
    throw new Error(`衝突(conflict)ではない失敗でした: ${JSON.stringify(result.errors)}`);
  }
  return result.errors;
}

describe("updateRecord: 楽観ロック(CAS)(V1-M9-T02)", () => {
  test("expectedVersion 一致で更新でき、新しい _updated_at を返す", () => {
    const created = unwrap(createRecord(db, manifest, "items", { name: "A", quantity: 1 }));
    const updated = unwrap(
      updateRecord(db, manifest, "items", created._id, { quantity: 2 }, created._updated_at),
    );
    expect(updated.quantity).toBe(2);
    // 版は更新後に必ず進む(CAS の版源として使えること)。
    expect(updated._updated_at > created._updated_at).toBe(true);
  });

  test("expectedVersion 不一致は衝突(conflict discriminant)で返る", () => {
    const created = unwrap(createRecord(db, manifest, "items", { name: "A", quantity: 1 }));
    const errors = conflictOf(
      updateRecord(db, manifest, "items", created._id, { quantity: 2 }, "2000-01-01T00:00:00.000Z"),
    );
    expect(errors.length).toBeGreaterThan(0);
    // 衝突しても本体は書き換わっていない。
    expect(unwrap(getRecord(db, manifest, "items", created._id))?.quantity).toBe(1);
  });

  test("expectedVersion 省略は従来どおり LWW(CAS しない)", () => {
    const created = unwrap(createRecord(db, manifest, "items", { name: "A", quantity: 1 }));
    // 版を渡さなければ、古い値を知らなくても上書きできる(現行 LWW 挙動)。
    const updated = unwrap(updateRecord(db, manifest, "items", created._id, { quantity: 9 }));
    expect(updated.quantity).toBe(9);
  });

  test("存在しない id + 版指定は不在エラー(衝突とは区別する)", () => {
    const result = updateRecord(
      db,
      manifest,
      "items",
      "missing",
      { quantity: 1 },
      "2000-01-01T00:00:00.000Z",
    );
    // 不在は「衝突」ではない(discriminant を立てない)。
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).not.toBe(true);
    }
    expect(errorsOf(result)[0]?.message).toContain("存在しません");
  });

  test("同一レコードの2連続更新で、2回目に旧版を渡すと衝突する", () => {
    const created = unwrap(createRecord(db, manifest, "items", { name: "A", quantity: 1 }));
    // 1回目: 旧版で成功し版が進む(nextTimestamp が +1ms でも必ず進む)。
    const v1 = unwrap(
      updateRecord(db, manifest, "items", created._id, { quantity: 2 }, created._updated_at),
    );
    expect(v1._updated_at > created._updated_at).toBe(true);
    // 2回目: 旧版(created._updated_at)を渡すと衝突。
    conflictOf(
      updateRecord(db, manifest, "items", created._id, { quantity: 3 }, created._updated_at),
    );
    // 新版を渡せば通る。
    const v2 = unwrap(
      updateRecord(db, manifest, "items", created._id, { quantity: 3 }, v1._updated_at),
    );
    expect(v2.quantity).toBe(3);
  });
});

describe("deleteRecord: 楽観ロック(CAS)(V1-M9-T02)", () => {
  test("expectedVersion 一致で削除できる", () => {
    const created = unwrap(createRecord(db, manifest, "items", { name: "A", quantity: 1 }));
    expect(unwrap(deleteRecord(db, manifest, "items", created._id, created._updated_at))).toBe(
      true,
    );
    expect(unwrap(getRecord(db, manifest, "items", created._id))).toBeNull();
  });

  test("expectedVersion 不一致は衝突(conflict discriminant)で返り、行は残る", () => {
    const created = unwrap(createRecord(db, manifest, "items", { name: "A", quantity: 1 }));
    conflictOf(deleteRecord(db, manifest, "items", created._id, "2000-01-01T00:00:00.000Z"));
    expect(unwrap(getRecord(db, manifest, "items", created._id))).not.toBeNull();
  });

  test("存在しない id + 版指定は不在(ok:false・衝突ではない)", () => {
    const result = deleteRecord(db, manifest, "items", "missing", "2000-01-01T00:00:00.000Z");
    expect(unwrap(result)).toBe(false);
  });

  test("expectedVersion 省略は従来どおり(削除成功=true / 不在=false)", () => {
    const created = unwrap(createRecord(db, manifest, "items", { name: "A", quantity: 1 }));
    expect(unwrap(deleteRecord(db, manifest, "items", created._id))).toBe(true);
    expect(unwrap(deleteRecord(db, manifest, "items", "missing"))).toBe(false);
  });
});

describe("fixtures/valid/inventory-all-field-types.json", () => {
  test("フィクスチャのマニフェストそのもので7型がラウンドトリップする", async () => {
    const fixture = (await Bun.file(
      join(import.meta.dir, "../../fixtures/valid/inventory-all-field-types.json"),
    ).json()) as Manifest;
    const path = join(dir, "fixture.sqlite");
    const fixtureDb = new Database(path);
    applyManifestDdl(fixtureDb, fixture);

    const categoryId = unwrap(createRecord(fixtureDb, fixture, "categories", { name: "家具" }))._id;
    const input = {
      name: "デスク",
      note: "天板に傷あり",
      quantity: 3,
      in_use: true,
      purchased_at: "2026-07-18",
      condition: "要修理",
      category: categoryId,
    };
    const created = unwrap(createRecord(fixtureDb, fixture, "items", input));
    const fetched = unwrap(getRecord(fixtureDb, fixture, "items", created._id));
    for (const [key, value] of Object.entries(input)) {
      expect((fetched as RecordRow)[key]).toBe(value);
    }
    fixtureDb.close();
  });
});

describe("永続性", () => {
  test("DB を閉じて開き直しても 7型の値が保たれる", () => {
    const path = join(dir, "reopen.sqlite");
    const first = new Database(path);
    applyManifestDdl(first, manifest);
    const categoryId = unwrap(createRecord(first, manifest, "categories", { name: "家具" }))._id;
    const created = unwrap(
      createRecord(first, manifest, "items", {
        name: "デスク",
        note: "メモ",
        quantity: 12,
        in_use: true,
        purchased_at: "2026-07-18",
        condition: "良好",
        category: categoryId,
      }),
    );
    first.close();

    const second = new Database(path);
    const fetched = unwrap(getRecord(second, manifest, "items", created._id));
    expect(fetched).toEqual(created);
    second.close();
  });
});

describe("システムテーブルへの書き込み拒否(ADR-0006 §8 の L1)", () => {
  /**
   * L1 は最終防衛線であり、入口を何本生やしても全経路がここを通る。
   *
   * 文面が「存在しません」になっていないことを明示的に確かめる。`_apps` は存在する。
   * ただ書けないだけであり、「存在しない」と言うのは嘘であるうえ、
   * 「では add_table で作ろう」という誤った自己修正を誘導する(憲法6 / ADR-0006 §7)。
   */
  const writeOnlyTables = ["_apps", "_changelog", "_ai_usage"] as const;

  for (const tableId of writeOnlyTables) {
    test(`createRecord が ${tableId} を読み取り専用として拒否する`, () => {
      const result = createRecord(db, manifest, tableId, { name: "x" });
      const error = expectSingleError(result);
      expect(error.message).toContain("読み取り専用");
      expect(error.message).not.toContain("存在しません");
      expect(error.path).toBe("");
      expect(error.allowed_values).toEqual(["categories", "items"]);
    });

    test(`updateRecord が ${tableId} を読み取り専用として拒否する`, () => {
      const error = expectSingleError(updateRecord(db, manifest, tableId, "book-tracker", {}));
      expect(error.message).toContain("読み取り専用");
      expect(error.message).not.toContain("存在しません");
    });

    test(`deleteRecord が ${tableId} を読み取り専用として拒否する`, () => {
      const error = expectSingleError(deleteRecord(db, manifest, tableId, "book-tracker"));
      expect(error.message).toContain("読み取り専用");
      expect(error.message).not.toContain("存在しません");
    });
  }

  test("レコードの存在確認より先に読み取り専用で落ちる(ADR-0006 §7 の判定順序)", () => {
    // 実在しない _id でも「レコードが存在しません」ではなく読み取り専用エラーになる。
    const error = expectSingleError(updateRecord(db, manifest, "_apps", "ghost-id", {}));
    expect(error.message).toContain("読み取り専用");
    expect(error.message).not.toContain("レコード");
  });

  test("拒否は入力の妥当性に依存しない(検証より前に落ちる)", () => {
    const error = expectSingleError(createRecord(db, manifest, "_apps", { nonexistent: 1 }));
    expect(error.path).toBe("");
    expect(error.message).toContain("読み取り専用");
  });

  test("hint が add_table を勧めない(L3 で必ず弾かれる操作に誘導しない)", () => {
    const error = expectSingleError(createRecord(db, manifest, "_apps", {}));
    expect(error.hint ?? "").not.toContain("add_table");
  });

  test("システムテーブル風の未定義IDは従来どおり「存在しません」", () => {
    const error = expectSingleError(createRecord(db, manifest, "_snapshots", {}));
    expect(error.message).toContain("存在しません");
  });
});

/**
 * ワークフローのフックが `records.ts` の CRUD にあることの検査(V1-M2-T02)。
 *
 * 実行エンジンそのものの検査は `workflow-runner.test.ts` にある。ここが固定するのは
 * **フックが `createRecord` / `updateRecord` の中にあり、`workflows` を持たない
 * マニフェストの振る舞いを1バイトも変えていない**ことだけである ——
 * ADR-0003 §7 の「入口を何本生やしても振る舞いが一致する」は、フックがこの層に
 * あることで構造的に保証される(呼び出し元に置くと、書き忘れた経路が静かにずれる)。
 */
describe("ワークフローの発火地点(V1-M2-T02)", () => {
  /** 出力先テーブル・履歴テーブル・ワークフローを1本足す。 */
  function withWorkflow(): void {
    const added: Manifest["app"]["tables"] = [
      { id: "audit", name: "監査", fields: [{ id: "source", name: "対象", type: "text" }] },
      {
        id: "runs",
        name: "実行履歴",
        fields: [
          { id: "ran_at", name: "実行時刻", type: "date" },
          { id: "workflow", name: "ワークフロー", type: "text" },
          { id: "trigger_type", name: "きっかけ", type: "text" },
          { id: "status", name: "結果", type: "text" },
          { id: "error", name: "エラー", type: "long_text" },
        ],
      },
    ];
    // 既存テーブルは beforeEach で作成済みなので、**追加分だけ**に DDL を掛ける
    // (`applyManifestDdl` は CREATE TABLE を無条件に発行するため、全体に掛け直せない)。
    /*
     * **【`V8-M26`(2026-08-10)で足した下ごしらえ】**
     *
     * **`V8-M26-T03` が面(役割に束ねた権限)の既定を「閉じる」側へ倒したので、
     * ワークフローの `create_record` が止まった。** **この describe の主題は
     * 「発火するかどうか」であって面ではないので、題材の側で壁を開ける** ——
     * **実装は1バイトも緩めていない。**
     *
     * **順番が要る**: **先にマニフェストへ持ち主の列を入れてから DDL を掛ける。**
     * **`beforeEach` で既に DDL 済みのテーブルには、物理の列を `ALTER TABLE` で足す** ——
     * **マニフェストに書くだけでは物理の列が無く、挿入がその場で落ちる**(実測)。
     * **この下ごしらえが効くのは、この関数を呼んだ検査の中だけである。**
     */
    const existing = manifest.app.tables.map((table) => table.id);
    manifest.app.tables.push(...added);
    manifest.app.workflows = [
      {
        id: "audit-items",
        name: "備品の作成を記録する",
        trigger: { type: "on_create", table: "items" },
        actions: [{ action: "create_record", table: "audit", values: { source: "$record.name" } }],
        history_table: "runs",
      },
    ];
    armManifestForAutomation(manifest);
    applyManifestDdl(db, {
      app: {
        ...manifest.app,
        tables: manifest.app.tables.filter((table) => !existing.includes(table.id)),
        views: [],
      },
    });
    for (const tableId of existing) {
      db.run(
        `ALTER TABLE ${JSON.stringify(tableId)} ADD COLUMN ${JSON.stringify(OWNER_FIELD.id)} TEXT`,
      );
    }
    seedAutomationActor(db);
  }

  test("workflows を持たないマニフェストでは CRUD の振る舞いが変わらない", () => {
    // 省略は「1つも無い」と同じ意味である(ADR-0013 §1)。ここが落ちるなら
    // フックが省略形(`workflows: undefined`)を踏んでいる。
    expect(manifest.app.workflows).toBeUndefined();
    const created = unwrap(createRecord(db, manifest, "items", { name: "机", quantity: 1 }));
    expect(unwrap(updateRecord(db, manifest, "items", created._id, { quantity: 2 })).quantity).toBe(
      2,
    );
    expect(unwrap(countRecords(db, manifest, "items"))).toBe(1);
  });

  test("createRecord がワークフローを発火させ、返り値は本体行のままである", () => {
    withWorkflow();
    const created = unwrap(createRecord(db, manifest, "items", { name: "椅子", quantity: 3 }));

    // 返り値は**本体の行**であって、ワークフローの結果ではない。
    expect(created.name).toBe("椅子");
    expect(unwrap(listRecords(db, manifest, "audit"))[0]?.source).toBe("椅子");
    expect(unwrap(listRecords(db, manifest, "runs"))[0]?.status).toBe("success");
  });

  test("updateRecord は on_create を発火させない(トリガー種別を取り違えていない)", () => {
    withWorkflow();
    const created = unwrap(createRecord(db, manifest, "items", { name: "棚", quantity: 1 }));
    unwrap(updateRecord(db, manifest, "items", created._id, { quantity: 9 }));

    // 発火は作成の1回だけ。
    expect(unwrap(countRecords(db, manifest, "audit"))).toBe(1);
    expect(unwrap(countRecords(db, manifest, "runs"))).toBe(1);
  });
});

/** 失敗を前提に、唯一のエラーを取り出す。 */
function expectSingleError(
  result: { ok: true; value: unknown } | { ok: false; errors: ValidationError[] },
): ValidationError {
  if (result.ok) {
    throw new Error(`失敗を期待しましたが成功しました: ${JSON.stringify(result.value)}`);
  }
  expect(result.errors).toHaveLength(1);
  const error = result.errors[0];
  if (error === undefined) {
    throw new Error("unreachable");
  }
  return error;
}

// --- V2-M2-T01: image 値の実在確認(ADR-0035 §1b)-----------------------------------
//
// image 値 = `_files` に実在する file_id を表す文字列。reference が参照先 `_id` を指すのと
// **同型の実在制約**であり、書き込み時に `_files` の実在を確認して通らなければ 422 相当で落ちる。
//
// **T02 のアップロード API には依存しない単体テスト**である。`_files` テーブルを手で用意した
// 状態で「実在する file_id は通り・存在しない file_id は落ちる」ことを固定する。`_files` の実体
// (DDL / アップロード)は T02 が作るので、T01 では検証の枠だけを確かめる —— `_files` が無い間は
// どの file_id も実在しないので必ず落ちる、という枠の挙動もここで固定する。

/** image フィールドを1つ持つ最小マニフェスト。 */
function imageManifest(): Manifest {
  return {
    app: {
      id: "catalog",
      name: "商品カタログ",
      tables: [
        {
          id: "products",
          name: "商品",
          fields: [
            { id: "name", name: "商品名", type: "text", required: true },
            { id: "photo", name: "写真", type: "image" },
          ],
        },
      ],
      views: [],
    },
  };
}

/** `_files`(file_id PK)を手で作る。**T02 の DDL 前提と揃える** —— file_id を PRIMARY KEY とする。 */
function createFilesTable(database: Database): void {
  database.exec(
    'CREATE TABLE "_files" ("file_id" TEXT PRIMARY KEY, "sha256" TEXT NOT NULL, ' +
      '"mime" TEXT NOT NULL, "size" INTEGER NOT NULL, "filename" TEXT, "created_at" TEXT NOT NULL)',
  );
}

/** `_files` に1行入れて file_id を返す。 */
function seedFile(database: Database, fileId: string): string {
  database
    .query(
      'INSERT INTO "_files" ("file_id", "sha256", "mime", "size", "filename", "created_at") ' +
        "VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(fileId, "a".repeat(64), "image/png", 123, "p.png", "2026-07-23T00:00:00.000Z");
  return fileId;
}

describe("V2-M2-T01: image 値は `_files` に実在する file_id のみ受理する", () => {
  let imgDir: string;
  let imgDb: Database;
  let imgManifest: Manifest;

  beforeEach(async () => {
    imgDir = await mkdtemp(join(tmpdir(), "gp-image-"));
    imgDb = new Database(join(imgDir, "app.sqlite"));
    imgManifest = imageManifest();
    applyManifestDdl(imgDb, imgManifest);
  });

  afterEach(async () => {
    imgDb.close();
    await rm(imgDir, { recursive: true, force: true });
  });

  test("実在する file_id は書ける(create → 読み出しで file_id が保たれる)", () => {
    createFilesTable(imgDb);
    const fileId = seedFile(imgDb, "file-abc");
    const created = unwrap(
      createRecord(imgDb, imgManifest, "products", { name: "机", photo: fileId }),
    );
    expect(created.photo).toBe(fileId);
    const fetched = unwrap(getRecord(imgDb, imgManifest, "products", created._id));
    expect((fetched as RecordRow).photo).toBe(fileId);
  });

  test("image の未設定(null / 省略)は通る(必須ではない)", () => {
    createFilesTable(imgDb);
    const a = unwrap(createRecord(imgDb, imgManifest, "products", { name: "椅子", photo: null }));
    expect(a.photo).toBeNull();
    const b = unwrap(createRecord(imgDb, imgManifest, "products", { name: "棚" }));
    expect(b.photo).toBeNull();
  });

  test("存在しない file_id は 422 相当で落ちる(reference の実在確認と同型)", () => {
    createFilesTable(imgDb);
    seedFile(imgDb, "file-abc");
    const error = expectSingleError(
      createRecord(imgDb, imgManifest, "products", { name: "机", photo: "file-missing" }),
    );
    expect(error.path).toBe("/photo");
    expect(error.message).toContain("file-missing");
    expect(error.message).toContain("_files");
  });

  test("文字列以外の値は型エラーで落ちる", () => {
    createFilesTable(imgDb);
    const error = expectSingleError(
      createRecord(imgDb, imgManifest, "products", { name: "机", photo: 123 }),
    );
    expect(error.path).toBe("/photo");
  });

  test("`_files` テーブルがまだ無い間は、どの file_id も実在しないので落ちる(T01 の枠)", () => {
    // T02 が `_files` を作るまでは実在確認の相手が存在しない。黙って通さず、必ず落とす。
    const error = expectSingleError(
      createRecord(imgDb, imgManifest, "products", { name: "机", photo: "file-abc" }),
    );
    expect(error.path).toBe("/photo");
    expect(error.message).toContain("_files");
  });

  test("update でも実在確認が効く(実在 file_id は通り、不在は落ちる)", () => {
    createFilesTable(imgDb);
    const fileId = seedFile(imgDb, "file-abc");
    const created = unwrap(createRecord(imgDb, imgManifest, "products", { name: "机" }));
    const updated = unwrap(
      updateRecord(imgDb, imgManifest, "products", created._id, { photo: fileId }),
    );
    expect(updated.photo).toBe(fileId);
    const error = expectSingleError(
      updateRecord(imgDb, imgManifest, "products", created._id, { photo: "nope" }),
    );
    expect(error.path).toBe("/photo");
  });
});

describe("listRecords: ページネーション(EC-G11 / ADR-0042)", () => {
  // 作成順(_created_at, _id)で安定する。name を quantity 昇順に振り、offset/limit の効きを見分ける。
  beforeEach(() => {
    for (let i = 1; i <= 5; i += 1) {
      unwrap(createRecord(db, manifest, "items", { name: `n${i}`, quantity: i }));
    }
  });

  test("limit 未指定は全件返す(後方互換)", () => {
    const rows = unwrap(
      listRecords(db, manifest, "items", { sort: { field: "quantity", order: "asc" } }),
    );
    expect(rows.map((r) => r.quantity)).toEqual([1, 2, 3, 4, 5]);
  });

  test("limit で先頭 N 件に絞る(N 件を超えて返さない)", () => {
    const rows = unwrap(
      listRecords(db, manifest, "items", { sort: { field: "quantity", order: "asc" }, limit: 2 }),
    );
    expect(rows.map((r) => r.quantity)).toEqual([1, 2]);
  });

  test("offset で先頭をスキップする", () => {
    const rows = unwrap(
      listRecords(db, manifest, "items", { sort: { field: "quantity", order: "asc" }, offset: 3 }),
    );
    expect(rows.map((r) => r.quantity)).toEqual([4, 5]);
  });

  test("limit + offset で任意のページを取れる", () => {
    const rows = unwrap(
      listRecords(db, manifest, "items", {
        sort: { field: "quantity", order: "asc" },
        limit: 2,
        offset: 2,
      }),
    );
    expect(rows.map((r) => r.quantity)).toEqual([3, 4]);
  });

  test("limit=0 は0件(境界)", () => {
    const rows = unwrap(
      listRecords(db, manifest, "items", { sort: { field: "quantity", order: "asc" }, limit: 0 }),
    );
    expect(rows).toEqual([]);
  });

  test("offset が総件数を超えると空配列", () => {
    const rows = unwrap(
      listRecords(db, manifest, "items", { sort: { field: "quantity", order: "asc" }, offset: 99 }),
    );
    expect(rows).toEqual([]);
  });

  test("非整数の limit を統一形式エラーで拒否する(/limit)", () => {
    const errors = errorsOf(listRecords(db, manifest, "items", { limit: 1.5 }));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/limit");
  });

  test("負の limit を拒否する(/limit)", () => {
    const errors = errorsOf(listRecords(db, manifest, "items", { limit: -1 }));
    expect(errors[0]?.path).toBe("/limit");
  });

  test("負の offset を拒否する(/offset)", () => {
    const errors = errorsOf(listRecords(db, manifest, "items", { offset: -1 }));
    expect(errors[0]?.path).toBe("/offset");
  });

  test("非整数の offset を拒否する(/offset)", () => {
    const errors = errorsOf(listRecords(db, manifest, "items", { offset: 2.5 }));
    expect(errors[0]?.path).toBe("/offset");
  });

  test("countRecords は limit/offset に左右されず総件数を返す(total 整合)", () => {
    // ページ(limit=2, offset=2)は2件だが、total は5件のまま。
    const page = unwrap(
      listRecords(db, manifest, "items", {
        limit: 2,
        offset: 2,
        sort: { field: "quantity", order: "asc" },
      }),
    );
    expect(page).toHaveLength(2);
    expect(unwrap(countRecords(db, manifest, "items"))).toBe(5);
  });

  test("filter 併用時: total は filter 適用後件数・page は limit 件(整合)", () => {
    // quantity>=3 は 3件(3,4,5)。limit=2 で先頭2件、total=3。
    const filter: FilterNode = { field: "quantity", gte: 3 };
    const page = unwrap(
      listRecords(db, manifest, "items", {
        filter,
        limit: 2,
        sort: { field: "quantity", order: "asc" },
      }),
    );
    expect(page.map((r) => r.quantity)).toEqual([3, 4]);
    expect(unwrap(countRecords(db, manifest, "items", { filter }))).toBe(3);
  });
});
