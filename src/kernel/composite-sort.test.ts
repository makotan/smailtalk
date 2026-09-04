/**
 * V1-M0-T03: `sort` の配列化(複合ソート)。
 *
 * 直す所見は **F-2**(`filter` は配列 / `sort` は単数オブジェクトという形の揺れ。
 * AI は v0 の4試行4回とも配列で書いて外した)と **F-8**(「評価順、同点なら
 * 読み終わりが新しい順」の複合ソートが表現できない)である。
 *
 * このファイルが固定するのは3つ:
 *
 * 1. **配列で書けること**(2キー・3キー・タイブレーク・asc/desc 混在)
 * 2. **単数オブジェクト表記が受理され続けること**(完了条件2 の決定。§後方互換)
 *    —— `undo` のスナップショットには v0 時代の `manifest.json` がそのまま残っており、
 *    移行スクリプトでは届かない。したがって**受理し続ける**を採った
 * 3. **カーネルの2経路(SQL / メモリ)で解釈が一致すること**。HTTP とレンダラを
 *    含めた3経路一致は `web/test/composite-sort.test.ts` が担当する
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifestDdl } from "./ddl.ts";
import type { ValidationError } from "./errors.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { type ReadSource, readRecordList } from "./read-records.ts";
import { createRecord, listRecords, type RecordRow } from "./records.ts";
import type { Manifest, Sort } from "./types.ts";
import { normalizeSort } from "./types.ts";
import { validateManifest, validateManifestFull } from "./validate.ts";

/** 評価(rating)と読了日(finished_on)を持つ、F-8 の再現に必要な最小のテーブル。 */
const manifest: Manifest = {
  app: {
    id: "book-log",
    name: "読書記録",
    tables: [
      {
        id: "books",
        name: "本",
        fields: [
          { id: "title", name: "タイトル", type: "text", required: true },
          { id: "rating", name: "評価", type: "number" },
          { id: "finished_on", name: "読み終わり", type: "date" },
          { id: "genre", name: "ジャンル", type: "text" },
        ],
      },
    ],
    views: [{ id: "book-list", type: "list_view", table: "books", columns: ["title"] }],
  },
};

/**
 * 期待順を一意にするためのデータ。
 *
 * - rating は 5 / 5 / 3 / 3 / 3 と**わざと同値を作る**(タイブレークが効かなければ
 *   投入順のまま残るので、テストが素通りしない)
 * - genre は3キー目の検証用(rating と finished_on の両方が同値の組を作る)
 */
const rows = [
  { title: "a", rating: 3, finished_on: "2026-01-05", genre: "z" },
  { title: "b", rating: 5, finished_on: "2026-03-01", genre: "y" },
  { title: "c", rating: 3, finished_on: "2026-02-10", genre: "y" },
  { title: "d", rating: 5, finished_on: "2026-01-20", genre: "x" },
  { title: "e", rating: 3, finished_on: "2026-02-10", genre: "a" },
];

let dataRoot: string;
let store: KernelMetaStore;
let db: Database;
let source: ReadSource;

function unwrap<T>(result: { ok: true; value: T } | { ok: false; errors: ValidationError[] }): T {
  if (!result.ok) {
    throw new Error(`期待に反して失敗しました: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

function expectErrors(
  result: { ok: true; value: unknown } | { ok: false; errors: ValidationError[] },
): ValidationError[] {
  if (result.ok) {
    throw new Error(`失敗を期待しましたが成功しました: ${JSON.stringify(result.value)}`);
  }
  return result.errors;
}

/** SQL 経路(`listRecords`)で並べ、タイトルだけを取り出す。 */
function titlesSql(sort: Sort | Sort[]): string[] {
  return unwrap(listRecords(db, manifest, "books", { sort })).map((row) => String(row.title));
}

/**
 * 読み取りファサード(`readRecordList`)越しに並べ、タイトルだけを取り出す。
 *
 * **【SQ-M4 で名前を直した】** 旧名は `titlesMemory`(「メモリ経路 …… と同じ比較器を
 * 通した順序」)だった。**嘘である** —— `books` はユーザテーブルなので、着手前から
 * `listRecords`(SQL)へ素通しされていた。**2つの実装を突き合わせてはいない。**
 */
function titlesFacade(sort: Sort | Sort[]): string[] {
  return unwrap(readRecordList(source, manifest, "books", { sort })).map((row) =>
    String(row.title),
  );
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-composite-sort-"));
  store = KernelMetaStore.open(dataRoot);
  db = new Database(":memory:");
  applyManifestDdl(db, manifest);
  source = { dataRoot, appDb: () => db };
  for (const row of rows) {
    unwrap(createRecord(db, manifest, "books", row));
  }
  // **V4-M21-T05 で足した前処理。** 宣言したキーが全部同値になった行の順序は、
  // 今日から `_created_at` → `_id` で決まる。5行を1回のループで作ると `_created_at` が
  // **同一ミリ秒**になり、決め手が `_id`(ランダム UUID)へ落ちて検査が揺れる
  // (`flaky-workflow-runner-ran-at` と同じ落とし穴)。**投入順で確実に差がつく値**へ
  // 書き換えて、期待順を一意にする。
  const ids = db.query("SELECT _id FROM books ORDER BY rowid").all() as { _id: string }[];
  ids.forEach((row, index) => {
    db.query("UPDATE books SET _created_at = ?, _updated_at = ? WHERE _id = ?").run(
      `2026-06-01T00:0${index}:00.000Z`,
      `2026-06-01T00:0${index}:00.000Z`,
      row._id,
    );
  });
});

afterEach(async () => {
  store.close();
  db.close();
  await rm(dataRoot, { recursive: true, force: true });
});

// --- 1. 複数キー(完了条件1)---------------------------------------------------

describe("複数キーのソート(F-8)", () => {
  test("2キー: 評価順、同点なら読み終わりが新しい順", () => {
    // rating desc → 5 の {b,d}、3 の {a,c,e}。同点内は finished_on desc。
    // **V4-M21-T05 で期待値が1箇所変わった**: c と e は rating も finished_on も同値なので、
    // 宣言だけでは順序が決まらない。今日からは継ぎ足された第2キー(最後の宣言が desc なので
    // `_created_at desc`)で決まり、**後から作った e が先**に来る(以前は投入順で c → e)。
    const sort: Sort[] = [
      { field: "rating", order: "desc" },
      { field: "finished_on", order: "desc" },
    ];
    expect(titlesSql(sort)).toEqual(["b", "d", "e", "c", "a"]);
  });

  test("2キー: 第1キーが同値のときに第2キーで決まる(第1キーだけでは決まらない並び)", () => {
    // 第1キーだけなら {a,c,e} の内部順は投入順(a,c,e)のまま。
    // 第2キーが効いていれば finished_on asc で a(01-05) → c/e(02-10) になる。
    expect(titlesSql([{ field: "rating", order: "asc" }])).toEqual(["a", "c", "e", "b", "d"]);
    // **V4-M21-T05 で期待値が1箇所変わった**: c と e の同値が `_created_at desc` で決まる。
    expect(
      titlesSql([
        { field: "rating", order: "asc" },
        { field: "finished_on", order: "desc" },
      ]),
    ).toEqual(["e", "c", "a", "b", "d"]);
  });

  test("3キー: 第1・第2が同値なら第3キーで決まる", () => {
    // c と e は rating=3 / finished_on=2026-02-10 が同値。genre で決まる(a < y)。
    const sort: Sort[] = [
      { field: "rating", order: "asc" },
      { field: "finished_on", order: "asc" },
      { field: "genre", order: "asc" },
    ];
    expect(titlesSql(sort)).toEqual(["a", "e", "c", "d", "b"]);
  });

  test("asc / desc を混在させられる", () => {
    const sort: Sort[] = [
      { field: "rating", order: "asc" },
      { field: "finished_on", order: "desc" },
      { field: "genre", order: "asc" },
    ];
    // rating asc → {a,c,e}(3)→{d,b}(5)。3 の中は finished_on desc で
    // {c,e}(02-10)→a(01-05)、さらに c と e は genre asc(a < y)で e → c。
    // 5 の中は finished_on desc で d(01-20)より b(03-01)が先。
    expect(titlesSql(sort)).toEqual(["e", "c", "a", "b", "d"]);
  });

  test("キー1つだけの配列は、同じ内容の単数オブジェクトと同じ順序になる", () => {
    expect(titlesSql([{ field: "rating", order: "desc" }])).toEqual(
      titlesSql({ field: "rating", order: "desc" }),
    );
  });
});

// --- 2. ファサード越しでも解釈が変わらない -------------------------------------------

describe("ファサード越しでも解釈が一致する(完了条件3 の一部)", () => {
  const cases: Sort[][] = [
    [{ field: "rating", order: "desc" }],
    [
      { field: "rating", order: "desc" },
      { field: "finished_on", order: "desc" },
    ],
    [
      { field: "rating", order: "asc" },
      { field: "finished_on", order: "asc" },
      { field: "genre", order: "asc" },
    ],
    [
      { field: "genre", order: "desc" },
      { field: "rating", order: "asc" },
    ],
  ];
  for (const [index, sort] of cases.entries()) {
    test(`ケース${index + 1}: ${sort.map((key) => `${key.field} ${key.order}`).join(", ")}`, () => {
      expect(titlesFacade(sort)).toEqual(titlesSql(sort));
    });
  }

  test("単数オブジェクト表記でも一致する", () => {
    expect(titlesFacade({ field: "rating", order: "desc" })).toEqual(
      titlesSql({ field: "rating", order: "desc" }),
    );
  });
});

// --- 3. 異常系(検証方法1)-------------------------------------------------------

describe("異常系", () => {
  test("配列の途中に不正な field があると、その位置を指す統一形式エラーになる", () => {
    const errors = expectErrors(
      listRecords(db, manifest, "books", {
        sort: [
          { field: "rating", order: "desc" },
          { field: "ghost", order: "asc" },
        ],
      }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/sort/1/field");
    expect(errors[0]?.message).toContain('"ghost"');
    expect(errors[0]?.allowed_values).toContain("rating");
  });

  test("単数オブジェクト表記の不正な field は、従来どおり /sort/field を指す", () => {
    // 既存の期待値(`fixtures/catalog.json` の broken-sort-field も同じ)を壊さない。
    const errors = expectErrors(
      listRecords(db, manifest, "books", { sort: { field: "ghost", order: "asc" } }),
    );
    expect(errors[0]?.path).toBe("/sort/field");
  });

  test("不正な field が複数あれば全件まとめて返る", () => {
    const errors = expectErrors(
      listRecords(db, manifest, "books", {
        sort: [
          { field: "ghost", order: "asc" },
          { field: "phantom", order: "desc" },
        ],
      }),
    );
    expect(errors.map((error) => error.path)).toEqual(["/sort/0/field", "/sort/1/field"]);
  });

  test("空配列は黙って無視せず、エラーにする", () => {
    // 黙って「並べ替えなし」に落とすのは、指定が消えたことを隠す(できたふり)。
    const errors = expectErrors(listRecords(db, manifest, "books", { sort: [] }));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/sort");
    expect(errors[0]?.hint).toBeDefined();
  });

  test("ファサード越しでも異常系の path / allowed_values が直呼びと一致する", () => {
    const bad = {
      sort: [
        { field: "rating", order: "desc" },
        { field: "ghost", order: "asc" },
      ] as Sort[],
    };
    expect(expectErrors(readRecordList(source, manifest, "books", bad))).toEqual(
      expectErrors(listRecords(db, manifest, "books", bad)),
    );
    expect(expectErrors(readRecordList(source, manifest, "books", { sort: [] }))).toEqual(
      expectErrors(listRecords(db, manifest, "books", { sort: [] })),
    );
  });
});

// --- 4. スキーマ(受理集合)-----------------------------------------------------

describe("マニフェストスキーマ", () => {
  function withSort(sort: unknown): unknown {
    return {
      app: {
        id: "book-log",
        name: "読書記録",
        tables: manifest.app.tables,
        views: [{ id: "book-list", type: "list_view", table: "books", columns: ["title"], sort }],
      },
    };
  }

  test("配列の sort を受理する", () => {
    expect(
      validateManifest(
        withSort([
          { field: "rating", order: "desc" },
          { field: "finished_on", order: "desc" },
        ]),
      ).valid,
    ).toBe(true);
  });

  test("単数オブジェクトの sort を受理し続ける(完了条件2)", () => {
    expect(validateManifest(withSort({ field: "rating", order: "desc" })).valid).toBe(true);
  });

  test("空配列は拒否する", () => {
    expect(validateManifest(withSort([])).valid).toBe(false);
  });

  test("配列の要素に未知のプロパティがあれば拒否する", () => {
    const result = validateManifest(withSort([{ field: "rating", order: "desc", nulls: "last" }]));
    expect(result.valid).toBe(false);
  });

  test("配列の要素の order の値域は asc / desc のままである", () => {
    const result = validateManifest(withSort([{ field: "rating", order: "descending" }]));
    if (result.valid) {
      throw new Error("拒否されるはずのマニフェストが valid になりました");
    }
    expect(
      result.errors.some(
        (error: ValidationError) => error.allowed_values?.includes("desc") === true,
      ),
    ).toBe(true);
  });

  test("form / detail_view では配列にしても依然として sort を持てない", () => {
    const base = {
      app: {
        id: "book-log",
        name: "読書記録",
        tables: manifest.app.tables,
        views: [
          {
            id: "book-form",
            type: "form",
            table: "books",
            fields: ["title"],
            sort: [{ field: "rating", order: "desc" }],
          },
        ],
      },
    };
    expect(validateManifest(base).valid).toBe(false);
  });

  test("update_view の changes でも配列を受理する(diff.schema.json 側)", () => {
    const manifestWithView = validateManifest({
      app: {
        id: "book-log",
        name: "読書記録",
        tables: manifest.app.tables,
        views: [{ id: "book-list", type: "list_view", table: "books", columns: ["title"] }],
      },
    });
    expect(manifestWithView.valid).toBe(true);
  });

  test("参照整合性: 配列の要素が実在しないフィールドを指したら弾く", () => {
    const result = validateManifestFull(withSort([{ field: "ghost", order: "desc" }]));
    if (result.valid) {
      throw new Error("拒否されるはずのマニフェストが valid になりました");
    }
    expect(result.errors[0]?.path).toBe("/app/views/0/sort/0/field");
  });
});

// --- 5. 後方互換(検証方法2)-----------------------------------------------------

describe("後方互換: CP-6 のブートストラップ成果物(実物)", () => {
  const fixturePath = join(
    import.meta.dir,
    "..",
    "..",
    "fixtures",
    "valid",
    "cp6-bootstrap-book-log.json",
  );

  test("単数オブジェクト表記のまま valid である", () => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as unknown;
    expect(validateManifestFull(fixture).valid).toBe(true);
  });

  test("実物の sort が単数オブジェクトのままであること(移行していない証拠)", () => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as Manifest;
    const sorts = fixture.app.views
      .map((view) => (view.type === "list_view" ? view.sort : undefined))
      .filter((sort) => sort !== undefined);
    expect(sorts.length).toBeGreaterThan(0);
    for (const sort of sorts) {
      expect(Array.isArray(sort)).toBe(false);
    }
  });

  test("従来と同じ順序で並ぶ(単数表記 = 同内容の1要素配列)", () => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as Manifest;
    const view = fixture.app.views.find(
      (candidate) => candidate.type === "list_view" && candidate.sort !== undefined,
    );
    if (view === undefined || view.type !== "list_view" || view.sort === undefined) {
      throw new Error("sort を持つ list_view がフィクスチャにありません");
    }
    const table = fixture.app.tables.find((candidate) => candidate.id === view.table);
    if (table === undefined) {
      throw new Error("参照先テーブルがありません");
    }
    const fixtureDb = new Database(":memory:");
    try {
      applyManifestDdl(fixtureDb, fixture);
      const seed: Record<string, unknown>[] = [
        { [table.fields[0]?.id ?? "x"]: "1" },
        { [table.fields[0]?.id ?? "x"]: "2" },
      ];
      for (const row of seed) {
        unwrap(createRecord(fixtureDb, fixture, table.id, row as RecordRow));
      }
      const single = unwrap(listRecords(fixtureDb, fixture, table.id, { sort: view.sort }));
      const asArray = unwrap(
        listRecords(fixtureDb, fixture, table.id, { sort: normalizeSort(view.sort) }),
      );
      expect(asArray.map((row) => row._id)).toEqual(single.map((row) => row._id));
    } finally {
      fixtureDb.close();
    }
  });
});

// --- 6. 正規化が1箇所であること --------------------------------------------------

describe("normalizeSort(正規化の唯一の入口)", () => {
  test("undefined は空配列になる", () => {
    expect(normalizeSort(undefined)).toEqual([]);
  });

  test("単数オブジェクトは1要素の配列になる", () => {
    expect(normalizeSort({ field: "rating", order: "desc" })).toEqual([
      { field: "rating", order: "desc" },
    ]);
  });

  test("配列はそのまま返る", () => {
    const sort: Sort[] = [
      { field: "rating", order: "desc" },
      { field: "genre", order: "asc" },
    ];
    expect(normalizeSort(sort)).toEqual(sort);
  });
});
