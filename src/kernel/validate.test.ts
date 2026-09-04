import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ValidationError, ValidationResult } from "./errors.ts";
import { DIFF_OPS, FIELD_TYPES, VIEW_TYPES } from "./types.ts";
import { MAX_UNDOABLE_DIFF_ID_LENGTH } from "./undo.ts";
import { validateDiff, validateManifest, validateManifestFull } from "./validate.ts";

/**
 * 正準スキーマ(`schemas/*.json`)そのものを読む。
 *
 * V1-M0-T02 の完了条件3〜5 は「スキーマの diff がこうであること」を要求しており、
 * 挙動ではなく**スキーマの構造**を固定する必要がある。目視の差分検査だけに頼ると、
 * 後から `$defs` を1つ足しても誰も気づかない。
 */
function canonicalSchema(file: string): Any {
  return JSON.parse(
    readFileSync(join(import.meta.dir, "..", "..", "schemas", file), "utf-8"),
  ) as Any;
}

const canonicalManifestSchema = () => canonicalSchema("manifest.schema.json");

/**
 * handover.md 3.4 の蔵書管理サンプル(原文のまま)。
 * リソースIDの規約は `^[a-z][a-z0-9_-]*$`(1〜64文字)で、kebab-case と snake_case の両方を許可する。
 */
const bookTrackerManifest = {
  app: {
    id: "book-tracker",
    name: "蔵書管理",
    tables: [
      {
        id: "books",
        name: "書籍",
        fields: [
          { id: "title", name: "タイトル", type: "text", required: true },
          { id: "status", name: "状態", type: "select", options: ["未読", "読書中", "読了"] },
          { id: "finished_at", name: "読了日", type: "date" },
        ],
      },
    ],
    views: [
      {
        id: "book-list",
        type: "list_view",
        table: "books",
        columns: ["title", "status"],
        sort: { field: "finished_at", order: "desc" },
      },
      { id: "book-form", type: "form", table: "books", fields: ["title", "status", "finished_at"] },
      { id: "book-detail", type: "detail_view", table: "books" },
    ],
  },
};

/** handover.md 3.5 の差分パッチサンプル(そのまま)。 */
const sampleDiff = {
  diff_id: "d-0042",
  intent: "読了日で並べたいという要望。既読管理を日付ベースにする",
  operations: [
    {
      op: "add_field",
      table: "books",
      field: { id: "finished_at", name: "読了日", type: "date" },
    },
    {
      op: "update_view",
      view: "book-list",
      changes: { sort: { field: "finished_at", order: "desc" } },
    },
  ],
};

/** テスト用: 失敗であることを確認しつつ errors を取り出す。 */
function expectInvalid(result: ValidationResult): ValidationError[] {
  expect(result.valid).toBe(false);
  if (result.valid) {
    throw new Error("expected invalid");
  }
  return result.errors;
}

/** 深いコピー(サンプルを壊さずに異常系を作るため)。 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// biome-ignore lint/suspicious/noExplicitAny: テストで意図的に不正な構造を組み立てるため
type Any = any;

describe("validateManifest / 正常系", () => {
  test("handover 3.4 の蔵書管理サンプルが通過する", () => {
    expect(validateManifest(bookTrackerManifest)).toEqual({ valid: true });
  });

  test("フィールド型7種すべてを含むマニフェストが通過する", () => {
    const manifest = {
      app: {
        id: "kitchen-sink",
        name: "全型",
        tables: [
          { id: "authors", name: "著者", fields: [{ id: "name", name: "名前", type: "text" }] },
          {
            id: "books",
            name: "書籍",
            fields: [
              { id: "title", name: "タイトル", type: "text", required: true },
              { id: "memo", name: "メモ", type: "long_text" },
              { id: "pages", name: "ページ数", type: "number" },
              { id: "owned", name: "所有", type: "boolean" },
              { id: "bought-at", name: "購入日", type: "date" },
              { id: "status", name: "状態", type: "select", options: ["未読", "読了"] },
              { id: "author", name: "著者", type: "reference", reference_table: "authors" },
            ],
          },
        ],
        views: [
          {
            id: "book-list",
            type: "list_view",
            table: "books",
            columns: ["title", "status"],
            sort: { field: "bought-at", order: "asc" },
            filter: [{ field: "owned", equals: true }],
          },
        ],
      },
    };
    expect(validateManifest(manifest)).toEqual({ valid: true });
  });

  test("kebab-case と snake_case の両方のIDが通過し、別IDとして共存できる", () => {
    const manifest = {
      app: {
        id: "id-style",
        name: "ID表記",
        tables: [
          {
            id: "my_table",
            name: "テーブル",
            fields: [
              { id: "my-field", name: "ケバブ", type: "text" },
              { id: "my_field", name: "スネーク", type: "text" },
            ],
          },
        ],
        views: [
          {
            id: "my_list",
            type: "list_view",
            table: "my_table",
            columns: ["my-field", "my_field"],
          },
        ],
      },
    };
    expect(validateManifest(manifest)).toEqual({ valid: true });
  });

  test("views が空配列でも通過する(ビュー未作成のアプリ)", () => {
    const manifest = clone(bookTrackerManifest) as Any;
    manifest.app.views = [];
    expect(validateManifest(manifest)).toEqual({ valid: true });
  });
});

describe("ブール式フィルタ schema(EC-G12 / ADR-0043)", () => {
  /** filter を差し込んだ list_view を1つ持つマニフェストを作る。 */
  function withFilter(filter: unknown): Any {
    return {
      app: {
        id: "shop",
        name: "ショップ",
        tables: [
          {
            id: "products",
            name: "商品",
            fields: [
              { id: "name", name: "名前", type: "text", required: true },
              { id: "price", name: "価格", type: "number" },
              { id: "status", name: "状態", type: "select", options: ["在庫", "売切"] },
            ],
          },
        ],
        views: [
          {
            id: "product-list",
            type: "list_view",
            table: "products",
            columns: ["name", "price"],
            filter,
          },
        ],
      },
    };
  }

  test("葉演算子 contains / gte / lte / in が valid", () => {
    for (const leaf of [
      { field: "name", contains: "T" },
      { field: "price", gte: 100 },
      { field: "price", lte: 500 },
      { field: "status", in: ["在庫", "売切"] },
      { field: "name", equals: "本" },
    ]) {
      expect(validateManifest(withFilter(leaf))).toEqual({ valid: true });
    }
  });

  test("and / or / not のブール結合とネストが valid", () => {
    const filter = {
      and: [
        {
          or: [
            { field: "status", equals: "在庫" },
            { field: "price", lte: 100 },
          ],
        },
        { not: { field: "name", contains: "廃番" } },
      ],
    };
    expect(validateManifest(withFilter(filter))).toEqual({ valid: true });
  });

  test("後方互換: 等値AND配列形は依然 valid", () => {
    expect(validateManifest(withFilter([{ field: "status", equals: "在庫" }]))).toEqual({
      valid: true,
    });
  });

  test("1葉に演算子2つ(gte と lte)は invalid", () => {
    expect(validateManifest(withFilter({ field: "price", gte: 1, lte: 9 })).valid).toBe(false);
  });

  test("葉に未知の演算子キー(like)は additionalProperties:false で invalid", () => {
    expect(validateManifest(withFilter({ field: "name", like: "%本%" })).valid).toBe(false);
  });

  test("結合ノードに未知の結合キー(xor)は invalid", () => {
    expect(validateManifest(withFilter({ xor: [{ field: "status", equals: "在庫" }] })).valid).toBe(
      false,
    );
  });

  test("結合ノードに余分なキーを混ぜると invalid", () => {
    expect(
      validateManifest(withFilter({ and: [{ field: "status", equals: "在庫" }], field: "name" }))
        .valid,
    ).toBe(false);
  });

  test("葉に演算子が無い({field}のみ)は invalid", () => {
    expect(validateManifest(withFilter({ field: "name" })).valid).toBe(false);
  });
});

describe("関連レコードの動的表示 schema(EC-G17 / ADR-0044)", () => {
  /**
   * 親 orders + 子 lines(order 参照)を持ち、order-detail(detail_view)に related を
   * 差し込んだマニフェストを作る。schema(構造)だけを見るので、via の参照先整合などは
   * `referential-integrity.test.ts` の担当(ここでは形だけ確認する)。
   */
  function withRelated(related: unknown): Any {
    return {
      app: {
        id: "shop",
        name: "ショップ",
        tables: [
          {
            id: "orders",
            name: "注文",
            fields: [{ id: "code", name: "番号", type: "text", required: true }],
          },
          {
            id: "lines",
            name: "明細",
            fields: [
              { id: "qty", name: "数量", type: "number" },
              { id: "order", name: "注文", type: "reference", reference_table: "orders" },
            ],
          },
        ],
        views: [{ id: "order-detail", type: "detail_view", table: "orders", related }],
      },
    };
  }

  const validRelated = [{ table: "lines", via: "order", columns: ["qty"] }];

  test("detail_view の related(最小形)は valid", () => {
    expect(validateManifest(withRelated(validRelated))).toEqual({ valid: true });
  });

  test("detail_view の related に sort / name を足しても valid(既存 $defs 再利用)", () => {
    const related = [
      {
        table: "lines",
        via: "order",
        columns: ["qty", "order"],
        sort: { field: "qty", order: "desc" },
        name: "明細一覧",
      },
    ];
    expect(validateManifest(withRelated(related))).toEqual({ valid: true });
  });

  test("related の sort は複合(配列)でも valid(既存 sort の値域そのまま)", () => {
    const related = [
      {
        table: "lines",
        via: "order",
        columns: ["qty"],
        sort: [
          { field: "qty", order: "desc" },
          { field: "order", order: "asc" },
        ],
      },
    ];
    expect(validateManifest(withRelated(related))).toEqual({ valid: true });
  });

  test("related は detail_view の既存キー(自レコードのみ)を壊さない —— related 無しは従来どおり valid", () => {
    expect(validateManifest(bookTrackerManifest)).toEqual({ valid: true });
  });

  test("list_view に related を付けると invalid(related は detail_view 限定)", () => {
    const manifest = withRelated(validRelated) as Any;
    manifest.app.views[0] = {
      id: "order-list",
      type: "list_view",
      table: "orders",
      columns: ["code"],
      related: validRelated,
    };
    expect(validateManifest(manifest).valid).toBe(false);
  });

  test("form に related を付けると invalid(related は detail_view 限定)", () => {
    const manifest = withRelated(validRelated) as Any;
    manifest.app.views[0] = {
      id: "order-form",
      type: "form",
      table: "orders",
      fields: ["code"],
      related: validRelated,
    };
    expect(validateManifest(manifest).valid).toBe(false);
  });

  test("related の要素に filter キーを持たせると invalid(子一覧に演算子を開かない・限定2)", () => {
    const related = [
      { table: "lines", via: "order", columns: ["qty"], filter: [{ field: "qty", equals: 1 }] },
    ];
    expect(validateManifest(withRelated(related)).valid).toBe(false);
  });

  test("related の要素に未知キー(via_field)を混ぜると invalid(additionalProperties:false)", () => {
    const related = [{ table: "lines", via: "order", columns: ["qty"], via_field: "x" }];
    expect(validateManifest(withRelated(related)).valid).toBe(false);
  });

  test("related の table / via / columns はいずれも必須", () => {
    for (const missing of ["table", "via", "columns"] as const) {
      const item: Record<string, unknown> = { table: "lines", via: "order", columns: ["qty"] };
      delete item[missing];
      expect(validateManifest(withRelated([item])).valid).toBe(false);
    }
  });

  test("related の columns は空配列を拒否する(field_id_list の minItems)", () => {
    const related = [{ table: "lines", via: "order", columns: [] }];
    expect(validateManifest(withRelated(related)).valid).toBe(false);
  });

  test("detail_view の columns / sort / filter は related を足しても依然 invalid(自レコード不変)", () => {
    for (const key of ["columns", "sort", "filter"]) {
      const manifest = withRelated(validRelated) as Any;
      manifest.app.views[0][key] =
        key === "columns"
          ? ["code"]
          : key === "sort"
            ? { field: "code", order: "asc" }
            : [{ field: "code", equals: "x" }];
      expect(validateManifest(manifest).valid).toBe(false);
    }
  });

  // **V3-M2-T01(ADR-0050)がテスト名を更新した。** 旧名は「…related(T03)と actions(T04)」
  // だったが、**プリセット7キーが門A を通って増えた**ので字面が成立しなくなった。
  // **アサーションの向き(全キーを列挙して固定する)は1バイトも変えていない。**
  // **V3-M5-T02(ADR-0055)がテスト名を再度更新した。** 旧名は「…とプリセット7キー
  // (ADR-0050)」で終わっていたが、**逃げ道の参照キー `custom_css` が門A を通って増えた**ので
  // 字面が成立しなくなった。**アサーションの向き(全キーを列挙して固定する)は
  // 1バイトも変えていない。**
  // **【`V5-M29-T04` / `ADR-0250` 限定14 がテスト名を更新した】** 旧名(逐語)は
  // 「**view の properties に増えたキーは related(T03)と actions(T04)とプリセット7キー
  // (ADR-0050)と逃げ道の参照(ADR-0055)・required は不変**」。**properties の全キーを列挙して
  // 固定していた `expect` を中央へ移したので、この test が測るのは `required` だけになった。**
  test("view の required は id / type / table の3本で不変(properties の列挙は中央へ移した)", () => {
    const schema = canonicalManifestSchema();
    expect(schema.$defs.view.required).toEqual(["id", "type", "table"]);
    // 【`V5-M29-T04` / `ADR-0250` 限定11】ここにあった「view の properties に増えたキーは related(T03)と actions(T04)とプリセット7キー(ADR-0050)と逃げ道の参照(ADR-0055)・required は不変」の検査は
    //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
    //   `manifest.$defs.view.properties:` で始まる行)。**総量ではなく名前と順序で見張る。**
    //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  });

  test("detail_view の allOf は columns/sort/filter:false を維持している(1バイトも変えない)", () => {
    const schema = canonicalManifestSchema();
    const detailBranch = schema.$defs.view.allOf.find(
      (branch: Any) => branch.if?.properties?.type?.const === "detail_view",
    );
    // **V3-M2-T01(ADR-0050)で list 専用プリセット3軸の false 宣言が増えた。**
    // 主張(「自レコードのみ」の columns/sort/filter:false を1バイトも変えない)は
    // 生きており、下の3行がそれを固定している。
    // **【V4-M16-T13 / `P-G24` の (C) 側 / ADR-0093 限定2 で1本増えた】** 8つ目の
    // `preset_` キー(一覧の器の形)も detail_view では `false` である。**主張(「自レコード
    // のみ」の columns/sort/filter:false を1バイトも変えない)は1ミリも緩んでいない。**
    // **【V4-M18-T03 / `P-G14` の (C) 側 / ADR-0095 限定6 で1本増えた】** `modal`
    // (重ねて出す宣言)も detail_view では `false` である。**主張は1ミリも緩んでいない。**
    // **【V4-M22-T01 / ADR-0112 限定2 で1本増えた】** `search_fields`(検索の対象にする列)も
    // detail_view では `false` である。**主張は1ミリも緩んでいない。**
    // **【V4-M22-T05 / ADR-0113 限定7 で1本増えた】** `page_size`(1ページに出す件数)も
    // detail_view では `false` である。**主張は1ミリも緩んでいない。**
    // **【V4-M20-T04 / ADR-0102 限定3 で1本増えた】** `after_save`(保存が成立したあとに
    // 行く画面のID)も detail_view では `false` である(form 型のビューでだけ書ける)。
    // **主張(「自レコードのみ」の columns/sort/filter:false を1バイトも変えない)は
    // 1ミリも緩んでいない。**
    // **【V4-M23-T01 / ADR-0104 限定採用で1本増えた】** 28キー目 `sum_field`(合計を出す列。
    // `list_view` でだけ書ける)も detail_view では `false` である。**主張は1ミリも緩んで
    // いない。**
    // **【V5-M22-T04 / `L-G7` / `ADR-0173` で1本増えた。ただし形が違う】** `actions` が
    // この分岐に現れた。**`false` ではない** —— **`detail_view` の `actions` は今日も
    // 書ける**(遷移の形 / 値の書換の形の2形)。**閉じたのは3形目(行き先の宣言 = `view`)
    // だけであり、`items.properties.view: false` の1点である。**
    // **`L-G7`(詳細画面側にも同じ宣言を置くか)の判定は却下である**
    // (`docs/plan/v5/records/v5-m20.md` §2-2)。**これは開く側ではなく閉じる側の差である。**
    // **主張(「自レコードのみ」の columns/sort/filter:false を1バイトも変えない)は
    // 1ミリも緩んでいない。**
    // **【2026-08-14。`V8-M8` / 台帳 `Q-G1` / 門A 本審査 = `V8-M7` で1本増えた】** 29キー目
    // `report`(集計表の中身。`report_view` でだけ書ける)も detail_view では `false` である。
    // **主張(「自レコードのみ」の columns/sort/filter:false を1バイトも変えない)は
    // 1ミリも緩んでいない。**
    expect(detailBranch.then.properties).toEqual({
      report: false,
      columns: false,
      sort: false,
      filter: false,
      actions: {
        // `$comment` の中身は本テストの主張ではないので、実物をそのまま通す
        // (**`$comment` の有無だけを固定する** —— 下の1行が `undefined` なら赤くなる)。
        $comment: detailBranch.then.properties.actions.$comment,
        type: "array",
        items: { type: "object", properties: { view: false } },
      },
      modal: false,
      search_fields: false,
      page_size: false,
      // **【2026-08-20。`V10-M1-T01` / `NV-G3a` / `ADR-0358` 限定1 で1本減った】**
      // **旧行の逐語**: `after_save: false,`
      // **門A の本審査(`V10-M0` 群A。判定 = 限定採用)が `detail_view` 分岐の
      // `"after_save": false,` を外した** —— **詳細画面の書換ボタン(`set` 形)が
      // 成立したあとの行き先を書けるようにするためである。**
      // **これは本テストで `false` が減る初めての更新である**(ここまではすべて増加)。
      // **主張(「自レコードのみ」の columns/sort/filter:false を1バイトも変えない)は
      // 1ミリも緩んでいない** —— **解いたのは `after_save` の1本だけであり、
      // `list_view` / `report_view` の `false` は1バイトも動いていない。**
      sum_field: false,
      preset_column_align: false,
      preset_column_width: false,
      preset_pager_position: false,
      preset_list_shape: false,
      // **【`V6-M2-T01` / `K-G2` / `ADR-0289` 限定4 で足した】** detail_view では
      // `reference_pickers`(参照項目の選び方の、入力画面ごとの上書き)も `false` である
      // (`form` でだけ書ける)。**これも開く側ではなく閉じる側の差である。**
      // **主張(「自レコードのみ」の columns/sort/filter:false を1バイトも変えない)は
      // 1ミリも緩んでいない。**
      reference_pickers: false,
    });
    expect(typeof detailBranch.then.properties.actions.$comment).toBe("string");
  });
});

describe("ビューからの操作起点 actions schema(EC-G14 / ADR-0045)", () => {
  /**
   * 親 products(product-detail の対象)+ cart_lines(product 参照)。product-detail の
   * actions は「この商品をカートに入れる = product をプリフィルした cart_line-form へ遷移」。
   * schema(構造)だけを見るので、form の実在・prefill.field の型整合は
   * `referential-integrity.test.ts` の担当(ここでは形だけ確認する)。
   */
  function withActions(actions: unknown): Any {
    return {
      app: {
        id: "shop",
        name: "ショップ",
        tables: [
          {
            id: "products",
            name: "商品",
            fields: [{ id: "name", name: "名前", type: "text", required: true }],
          },
          {
            id: "cart_lines",
            name: "カート明細",
            fields: [
              { id: "qty", name: "数量", type: "number" },
              { id: "product", name: "商品", type: "reference", reference_table: "products" },
            ],
          },
        ],
        views: [
          { id: "cart-form", type: "form", table: "cart_lines", fields: ["product", "qty"] },
          { id: "product-detail", type: "detail_view", table: "products", actions },
        ],
      },
    };
  }

  const validActions = [{ form: "cart-form", prefill: { field: "product" } }];

  test("detail_view の actions(最小形)は valid", () => {
    expect(validateManifest(withActions(validActions))).toEqual({ valid: true });
  });

  test("actions に表示名 name を足しても valid(既存 name $defs 再利用)", () => {
    const actions = [{ form: "cart-form", prefill: { field: "product" }, name: "カートに入れる" }];
    expect(validateManifest(withActions(actions))).toEqual({ valid: true });
  });

  test("actions は複数の操作起点を並べられる(1操作起点=プリフィル1つは各要素内で固定)", () => {
    const actions = [
      { form: "cart-form", prefill: { field: "product" }, name: "カートに入れる" },
      { form: "cart-form", prefill: { field: "product" }, name: "もう一度追加" },
    ];
    expect(validateManifest(withActions(actions))).toEqual({ valid: true });
  });

  test("actions 無しは従来どおり valid(後方互換)", () => {
    expect(validateManifest(bookTrackerManifest)).toEqual({ valid: true });
  });

  /*
   * **【V5-M21-T01 / `L-G1` / `ADR-0171` で書き換えた】** **着手前のテスト名は
   * 「list_view に actions を付けると invalid(actions は detail_view 限定)」であり、
   * 本体は `valid` が `false` であることを期待していた。****今日は偽である** ——
   * **`ADR-0171`(門A / 判定 = 限定採用)が `list_view` 分岐の `"actions": false,` を解いた。**
   * **`form` の分は下のテストが今日も `false` を期待しており、1バイトも変えていない(限定3)。**
   * **一覧に書けるのは遷移の形だけである** —— **set 形は `ADR-0171` 限定10 の順序拘束
   * (`ADR-0175` の規則が実装されるまで実装しない)により今日も拒否される。**
   */
  test("list_view に遷移の形の actions を付けると valid(ADR-0171 が list_view の false を解いた)", () => {
    const manifest = withActions(validActions) as Any;
    manifest.app.views[1] = {
      id: "product-list",
      type: "list_view",
      table: "products",
      columns: ["name"],
      actions: validActions,
    };
    expect(validateManifest(manifest).valid).toBe(true);
  });

  /*
   * **【`V5-M25-T07` / `L-G3` による追随。旧を隠さない】**
   * **`ADR-0171` 限定10 の順序拘束(「`ADR-0175` の規則が実装されるまで、一覧の set 形を
   * 実装しない」)は、`V5-M25-T03` が規則を実装したことで**解けた**。**
   * **【禁止】これを「二重押しが防げるようになったから解いた」と読まない** ——
   * **set 形の冪等性は今日も1つも無い**(`ADR-0100` §限界1 は1バイトも無効化されていない)。
   */
  test("list_view に set 形の actions を付けられる(V5-M25-T07 で順序拘束が解けた)", () => {
    const manifest = withActions(validActions) as Any;
    manifest.app.views[1] = {
      id: "product-list",
      type: "list_view",
      table: "products",
      columns: ["name"],
      actions: [{ set: { field: "name", value: "x" } }],
    };
    expect(validateManifest(manifest).valid).toBe(true);
  });

  test("form に actions を付けると invalid(actions は detail_view 限定)", () => {
    const manifest = withActions(validActions) as Any;
    manifest.app.views[1] = {
      id: "product-form",
      type: "form",
      table: "products",
      fields: ["name"],
      actions: validActions,
    };
    expect(validateManifest(manifest).valid).toBe(false);
  });

  test("form / prefill はいずれも必須", () => {
    for (const missing of ["form", "prefill"] as const) {
      const item: Record<string, unknown> = { form: "cart-form", prefill: { field: "product" } };
      delete item[missing];
      expect(validateManifest(withActions([item])).valid).toBe(false);
    }
  });

  test("prefill.field は必須(参照フィールド1つの指定)", () => {
    const actions = [{ form: "cart-form", prefill: {} }];
    expect(validateManifest(withActions(actions)).valid).toBe(false);
  });

  test("prefill に value / from を書くと invalid(値は _id 固定・値式を書かせない・限定3)", () => {
    for (const extra of [{ value: "x" }, { from: "$record._id" }, { from: "$record.name" }]) {
      const actions = [{ form: "cart-form", prefill: { field: "product", ...extra } }];
      expect(validateManifest(withActions(actions)).valid).toBe(false);
    }
  });

  test("prefill に条件キー(when)を混ぜると invalid(条件付きプリフィルを開かない・限定3)", () => {
    const actions = [
      { form: "cart-form", prefill: { field: "product", when: { field: "name", equals: "x" } } },
    ];
    expect(validateManifest(withActions(actions)).valid).toBe(false);
  });

  test("actions の要素に未知キー(prefills / color)を混ぜると invalid(additionalProperties:false)", () => {
    for (const extra of [{ prefills: [] }, { color: "red" }, { chart: "bar" }]) {
      const actions = [{ form: "cart-form", prefill: { field: "product" }, ...extra }];
      expect(validateManifest(withActions(actions)).valid).toBe(false);
    }
  });

  test("actions は空配列を拒否する(minItems)", () => {
    expect(validateManifest(withActions([])).valid).toBe(false);
  });

  test("detail_view の columns / sort / filter は actions を足しても依然 invalid(自レコード不変)", () => {
    for (const key of ["columns", "sort", "filter"]) {
      const manifest = withActions(validActions) as Any;
      manifest.app.views[1][key] =
        key === "columns"
          ? ["name"]
          : key === "sort"
            ? { field: "name", order: "asc" }
            : [{ field: "name", equals: "x" }];
      expect(validateManifest(manifest).valid).toBe(false);
    }
  });

  test("detail_view の allOf then は columns/sort/filter:false のみで actions を禁止しない", () => {
    const schema = canonicalManifestSchema();
    const detailBranch = schema.$defs.view.allOf.find(
      (branch: Any) => branch.if?.properties?.type?.const === "detail_view",
    );
    /*
     * **【`V5-M22-T04` / `L-G7` / `ADR-0173` で書き換えた】** 着手前の1行は逐語
     * `expect(detailBranch.then.properties.actions).toBeUndefined();` であった。
     * **今日は `undefined` ではない** —— **`L-G7`(却下)を機械的に閉じるために、
     * 3形目だけを `items.properties.view: false` で塞いだためである。**
     * **テスト名の主張(「actions を禁止しない」)は今日も真である** —— **禁止して
     * いない。****塞いだのは3形目だけであり、既存2形は1バイトも変わっていない。**
     * **旧文を消していない**(この注記の中に逐語で残してある)。
     */
    expect(detailBranch.then.properties.actions).not.toBe(false);
    expect(detailBranch.then.properties.actions.items.properties.view).toBe(false);
    // **既存2形は今日も書ける**(下の (a) 群が実際の差分で確かめている)。
    expect(detailBranch.then.properties.actions.items.properties.set).toBeUndefined();
    expect(detailBranch.then.properties.actions.items.properties.form).toBeUndefined();
    /*
     * **【V5-M21-T01 / `L-G1` / `ADR-0171` で書き換えた】** 上の1行
     * 「list_view / form 側は actions:false を持つ(detail_view 限定の機械的担保)」は
     * **今日は form についてだけ真である。** **`list_view` の `false` は `ADR-0171` が解いた。**
     * **旧文を消していない**(この注記の直下に残してある)。
     */
    // list_view / form 側は actions:false を持つ(detail_view 限定の機械的担保)。
    const listBranch = schema.$defs.view.allOf.find(
      (branch: Any) => branch.if?.properties?.type?.const === "list_view",
    );
    const formBranch = schema.$defs.view.allOf.find(
      (branch: Any) => branch.if?.properties?.type?.const === "form",
    );
    // **`list_view` は `false` ではなくなった。**
    // **【`V5-M25-T07` で外した。旧を隠さない】** **旧(逐語)**:
    // `expect(listBranch.then.properties.actions.items.properties.set).toBe(false);`
    // —— **`ADR-0171` 限定10 の順序拘束の機械的な担保だった。**
    // **`V5-M25-T03` が `ADR-0175` の規則を実装したので拘束が解け、`items` ごと外した。**
    expect(listBranch.then.properties.actions).not.toBe(false);
    expect(listBranch.then.properties.actions.items).toBeUndefined();
    // **`form` は1バイトも解いていない**(限定3)。
    expect(formBranch.then.properties.actions).toBe(false);
  });
});

describe("正準スキーマと FIELD_TYPES の同期(V2-M2 / ADR-0035)", () => {
  test("manifest.schema.json の field_type.enum は FIELD_TYPES と一致する(image / file を含む9種)", () => {
    // types.ts と正準スキーマの語彙がずれると、片方だけを直したとき AI に嘘の型を
    // 提示しうる。**image を FIELD_TYPES に足したら enum にも足さねばならない**ことを
    // ここで機械的に固定する(ADR-0035 §3 限定1 の「schema は enum に1値足す」)。
    const schema = canonicalManifestSchema();
    expect(schema.$defs.field_type.enum).toEqual([...FIELD_TYPES]);
    expect(schema.$defs.field_type.enum).toContain("image");
    expect(FIELD_TYPES.length).toBe(9); // 【`V5-M16` / `ADR-0161`】8 → 9(`file` が9種目)。**この行が固定していたのは「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**
  });
});

describe("validateManifest / 異常系", () => {
  test("語彙外のフィールド型を拒否し、許可値8種を allowed_values に含む", () => {
    const manifest = clone(bookTrackerManifest) as Any;
    manifest.app.tables[0].fields[2].type = "datetime";
    const errors = expectInvalid(validateManifest(manifest));
    const err = errors.find((e) => e.path === "/app/tables/0/fields/2/type");
    expect(err).toBeDefined();
    expect(err?.allowed_values).toEqual([...FIELD_TYPES]);
    expect(err?.message).toContain("datetime");
  });

  test("image フィールドは正準スキーマを通過する(options / reference_table なし)", () => {
    // ADR-0035: image は付帯キーを持たない。schema の allOf(select→options /
    // reference→reference_table)の else 節が image に対して両キーを禁止することも確認する。
    const manifest = clone(bookTrackerManifest) as Any;
    manifest.app.tables[0].fields.push({ id: "cover", name: "表紙", type: "image" });
    expect(validateManifest(manifest)).toEqual({ valid: true });

    // image に options を付けると拒否される(else: { options: false })。
    const withOptions = clone(bookTrackerManifest) as Any;
    withOptions.app.tables[0].fields.push({
      id: "cover",
      name: "表紙",
      type: "image",
      options: ["a"],
    });
    expectInvalid(validateManifest(withOptions));
  });

  test("語彙外のリソース種(view type)を拒否し、許可値を allowed_values に含む", () => {
    const manifest = clone(bookTrackerManifest) as Any;
    manifest.app.views[0].type = "chart";
    const errors = expectInvalid(validateManifest(manifest));
    const err = errors.find((e) => e.path === "/app/views/0/type");
    expect(err).toBeDefined();
    expect(err?.allowed_values).toEqual([...VIEW_TYPES]);
  });

  test("未知プロパティ(LLMの幻覚プロパティ)を拒否する", () => {
    const manifest = clone(bookTrackerManifest) as Any;
    manifest.app.tables[0].fields[0].placeholder = "書名を入力";
    const errors = expectInvalid(validateManifest(manifest));
    const err = errors.find((e) => e.path === "/app/tables/0/fields/0");
    expect(err).toBeDefined();
    expect(err?.message).toContain("placeholder");
  });

  test("トップレベルの未知プロパティを拒否する", () => {
    const manifest = clone(bookTrackerManifest) as Any;
    manifest.workflows = [];
    const errors = expectInvalid(validateManifest(manifest));
    expect(errors.some((e) => e.message.includes("workflows"))).toBe(true);
  });

  test("id 規約違反(大文字・記号・数字始まり)を拒否する", () => {
    for (const badId of ["Books", "book.s", "book s", "1books", "-books", "_books", ""]) {
      const manifest = clone(bookTrackerManifest) as Any;
      manifest.app.tables[0].id = badId;
      const errors = expectInvalid(validateManifest(manifest));
      expect(errors.some((e) => e.path === "/app/tables/0/id")).toBe(true);
    }
  });

  test("id が 64 文字を超える場合を拒否する", () => {
    const manifest = clone(bookTrackerManifest) as Any;
    manifest.app.tables[0].id = `b${"a".repeat(64)}`;
    const errors = expectInvalid(validateManifest(manifest));
    expect(errors.some((e) => e.path === "/app/tables/0/id")).toBe(true);
  });

  test("select 型に options が無い場合を拒否する", () => {
    const manifest = clone(bookTrackerManifest) as Any;
    manifest.app.tables[0].fields[1].options = undefined;
    delete manifest.app.tables[0].fields[1].options;
    const errors = expectInvalid(validateManifest(manifest));
    expect(errors.some((e) => e.message.includes("options"))).toBe(true);
  });

  test("select 型の options が空配列の場合を拒否する", () => {
    const manifest = clone(bookTrackerManifest) as Any;
    manifest.app.tables[0].fields[1].options = [];
    const errors = expectInvalid(validateManifest(manifest));
    expect(errors.some((e) => e.path === "/app/tables/0/fields/1/options")).toBe(true);
  });

  test("select 以外の型に options を付けた場合を拒否する", () => {
    const manifest = clone(bookTrackerManifest) as Any;
    manifest.app.tables[0].fields[0].options = ["a"];
    const errors = expectInvalid(validateManifest(manifest));
    expect(errors.some((e) => e.message.includes("options"))).toBe(true);
  });

  test("reference 型に reference_table が無い場合を拒否する", () => {
    const manifest = clone(bookTrackerManifest) as Any;
    manifest.app.tables[0].fields.push({ id: "author", name: "著者", type: "reference" });
    const errors = expectInvalid(validateManifest(manifest));
    expect(errors.some((e) => e.message.includes("reference_table"))).toBe(true);
  });

  test("reference 以外の型に reference_table を付けた場合を拒否する", () => {
    const manifest = clone(bookTrackerManifest) as Any;
    manifest.app.tables[0].fields[0].reference_table = "authors";
    const errors = expectInvalid(validateManifest(manifest));
    expect(errors.some((e) => e.message.includes("reference_table"))).toBe(true);
  });

  test("list_view の columns 欠落を拒否する", () => {
    const manifest = clone(bookTrackerManifest) as Any;
    delete manifest.app.views[0].columns;
    const errors = expectInvalid(validateManifest(manifest));
    expect(errors.some((e) => e.message.includes("columns"))).toBe(true);
  });

  test("form の fields 欠落を拒否する", () => {
    const manifest = clone(bookTrackerManifest) as Any;
    delete manifest.app.views[1].fields;
    const errors = expectInvalid(validateManifest(manifest));
    expect(errors.some((e) => e.message.includes("fields"))).toBe(true);
  });

  test("detail_view に columns を付けた場合を拒否する", () => {
    const manifest = clone(bookTrackerManifest) as Any;
    manifest.app.views[2].columns = ["title"];
    const errors = expectInvalid(validateManifest(manifest));
    expect(errors.some((e) => e.message.includes("columns"))).toBe(true);
  });

  /*
   * V1-M0-T09(F-3): detail_view の表示項目指定を `fields` で解禁した。
   * ADR-0007 の Δ6(既存キーの値域変更 = `false` の解除)であり、
   * `properties` に新しいキーは増えていない。ここで固定するのは
   *   - `fields` は通る(解禁したもの)
   *   - `columns` / `sort` / `filter` は依然として通らない(解禁していないもの)
   *   - `fields` 省略は従来どおり通る(既存マニフェストが無改変で valid)
   * の3点である。「1つ解いたら全部解けた」を防ぐためにセットで置く。
   */
  test("detail_view に fields を付けた場合を受理する(V1-M0-T09 / F-3)", () => {
    const manifest = clone(bookTrackerManifest) as Any;
    manifest.app.views[2].fields = ["title", "status"];
    expect(validateManifest(manifest)).toEqual({ valid: true });
  });

  test("detail_view の fields 省略は従来どおり受理する(V1-M0-T09 完了条件2)", () => {
    const manifest = clone(bookTrackerManifest) as Any;
    expect(manifest.app.views[2].fields).toBeUndefined();
    expect(validateManifest(manifest)).toEqual({ valid: true });
  });

  test("detail_view の fields は空配列を拒否する(field_id_list の minItems)", () => {
    const manifest = clone(bookTrackerManifest) as Any;
    manifest.app.views[2].fields = [];
    expect(validateManifest(manifest).valid).toBe(false);
  });

  test("detail_view に sort / filter を付けた場合は依然として拒否する", () => {
    for (const key of ["sort", "filter"]) {
      const manifest = clone(bookTrackerManifest) as Any;
      manifest.app.views[2][key] =
        key === "sort" ? { field: "title", order: "asc" } : [{ field: "title", equals: "x" }];
      const errors = expectInvalid(validateManifest(manifest));
      expect(errors.some((e) => e.message.includes(key))).toBe(true);
    }
  });

  /*
   * V1-M0-T02(F-1): `view.name`(表示名)を**限定採用**した。
   * ADR-0007 §7c の限定3点をここで機械的に固定する。
   *   限定1: 新しい概念を作らない —— `table.name` と同じ定義を `$ref` する
   *   限定2: 1つだけ —— `description` / `icon` / `order` は依然として拒否される
   *   限定3: 必須にしない —— `name` を持たないビューは無改変で valid のまま
   * 「1つ通したら全部通った」を防ぐために、受理と拒否をセットで置く。
   */
  test("3種すべてのビューで name を受理する(V1-M0-T02 / F-1・完了条件1)", () => {
    const manifest = clone(bookTrackerManifest) as Any;
    manifest.app.views[0].name = "蔵書一覧";
    manifest.app.views[1].name = "本を登録";
    manifest.app.views[2].name = "本の詳細";
    expect(validateManifest(manifest)).toEqual({ valid: true });
  });

  test("view の name 省略は従来どおり受理する(V1-M0-T02 完了条件2・限定3)", () => {
    const manifest = clone(bookTrackerManifest) as Any;
    for (const view of manifest.app.views) {
      expect(view.name).toBeUndefined();
    }
    expect(validateManifest(manifest)).toEqual({ valid: true });
  });

  test("view の name は required に入っておらず、view.properties は既知のキーだけを持つ(完了条件4・5)", () => {
    const schema = canonicalManifestSchema();
    expect(schema.$defs.view.required).toEqual(["id", "type", "table"]);
    // V1-M0-T02 が `name` を、V2-M6-T03(EC-G17 / ADR-0044)が `related` を、
    // V2-M6-T04(EC-G14 / ADR-0045)が `actions` を足した。それぞれ門A を通した1キーであり、
    // ここで view.properties の全キーを固定して「気づかないうちに properties が増える」ことを
    // 防ぐ(related / actions の限定は別テストで確認)。
    // **V3-M2-T01(D-G4 / ADR-0050)がプリセット7キーを足した** —— 1回の審査で足した本数と
    // しては過去最大であり、限定表12点(とくに限定1 の列挙固定)が上限を決めている。
    // **V3-M5-T02(D-G5 / ADR-0055)が18キー目 `custom_css`(逃げ道の参照)を足した** ——
    // 限定1 が「足すキーは1つだけ」と上限を決めている。
    expect(Object.keys(schema.$defs.view.properties)).toEqual([
      "id",
      "type",
      "table",
      "name",
      "columns",
      "sort",
      "filter",
      "fields",
      "related",
      "actions",
      "preset_column_align",
      "preset_column_width",
      "preset_pager_position",
      "preset_label_placement",
      "preset_field_columns",
      "preset_image_size",
      "preset_text_preview",
      "custom_css",
      // **V4-M3-T02 / `B-G1` / ADR-0070 限定1 が足した19キー目 `audience`**(画面ごとに
      // 見せる相手)。**門A の本審査を通って限定採用された増分である。列挙を消して件数に
      // 丸めない**(`custom_css` と同じ作法)。
      // **【`V8-M20-T01` / 台帳 `J-G27` / 手続きは `ADR-0301`。2026-08-10】** **この19キー目
      // `audience` は廃止された**(判定 = 廃止)。**上の3行は歴史の記述として残してあり、
      // 1バイトも消していない。****列挙から1本消したのであって、件数へ丸めたのではない。**
      // **代わりに担うのは `app.roles[].rules` の「役割 × 対象(画面)× 読取」である。**
      // **V4-M10-T45 / `E-G12` / ADR-0084 限定1 が足した20キー目 `menu_listed`**(画面を
      // メニューへ出すか)。**門A の本審査(再審査 B8)を通って限定採用された増分である。**
      // **これは可視性ではなく掲載の宣言であり、`audience` とは役割が違う**(限定5)。
      "menu_listed",
      // **V4-M16-T12 / `P-G17` の (C) 側 / ADR-0092 限定1 が足した21キー目 `field_groups`**
      // (詳細画面の項目のまとまり)。**門A の本審査(`V4-M14` 本審査② の単位9)を通って
      // 限定採用された増分である。列挙を消して件数に丸めない**(`custom_css` /
      // `menu_listed` と同じ作法)。**`detail_view` でだけ書ける**(限定2)。
      "field_groups",
      // **V4-M16-T13 / `P-G24` の (C) 側 / ADR-0093 限定1 が足した22キー目 `preset_list_shape`**
      // (一覧の器の形。8つ目の `preset_` キー)。**門A の本審査(`V4-M14` 本審査② の単位11)を
      // 通って限定採用された増分である。列挙を消して件数に丸めない**(`custom_css` /
      // `menu_listed` / `field_groups` と同じ作法)。**`list_view` でだけ書ける**(限定2)。
      "preset_list_shape",
      // **V4-M18-T03 / `P-G14` の (C) 側 / ADR-0095 限定1 が足した23キー目 `modal`**
      // (重ねて出す宣言)。**門A の本審査(V4-M18 単位3)を通って限定採用された増分である。**
      // **列挙を消して件数に丸めない**(`custom_css` / `menu_listed` / `field_groups` /
      // `preset_list_shape` と同じ作法)。**`form` でだけ書ける**(限定4)。
      "modal",
      // **【V4-M22-T01 / ADR-0112 限定1 が足した24キー目 `search_fields`】**
      // (検索の対象にする列)。**門A の本審査(V4-M22 単位A)を通って限定採用された増分である。**
      // **列挙を消して件数に丸めない**(`custom_css` / `menu_listed` / `field_groups` /
      // `preset_list_shape` / `modal` と同じ作法)。**`list_view` でだけ書ける。**
      "search_fields",
      // **【V4-M22-T05 / ADR-0113 限定1 が足した25キー目 `page_size`】**
      // (1ページに出す件数)。**門A の本審査(V4-M22 単位C。4回目の審査)を通って
      // 限定採用された増分である。** **列挙を消して件数に丸めない**(`custom_css` /
      // `menu_listed` / `field_groups` / `preset_list_shape` / `modal` / `search_fields` と
      // 同じ作法)。**`list_view` でだけ書ける。**
      "page_size",
      // **【V4-M19-T03 / `P-G32` の (C) 側 / ADR-0118 限定1 が足した26キー目 `preset_density`】**
      // (画面の詰まり具合)。**門A の本審査(V4-M19 単位C。2回目の審査)を通って限定採用
      // された増分である。** **列挙を消して件数に丸めない**(`custom_css` / `menu_listed` /
      // `field_groups` / `preset_list_shape` / `modal` / `search_fields` / `page_size` と
      // 同じ作法)。**3種すべてに書ける。****本 ADR の増分ではない。**
      "preset_density",
      // **【V4-M20-T04 / ADR-0102 限定1 が足した27キー目 `after_save`】**
      // (保存が成立したあとに行く画面のID)。**門A の本審査(V4-M20 単位D。2回目の審査)を
      // 通って限定採用された増分である。** **列挙を消して件数に丸めない**(`custom_css` /
      // `menu_listed` / `field_groups` / `preset_list_shape` / `modal` / `search_fields` /
      // `page_size` / `preset_density` と同じ作法)。**`form` でだけ書ける。**
      "after_save",
      // **【V4-M23-T01 / ADR-0104 限定採用が足した28キー目 `sum_field`】**
      // (合計を出す列)。**門A の本審査を通って限定採用された増分である。**
      // **列挙を消して件数に丸めない**(`custom_css` / `menu_listed` / `field_groups` /
      // `preset_list_shape` / `modal` / `search_fields` / `page_size` / `preset_density` /
      // `after_save` と同じ作法)。**`list_view` でだけ書ける。**
      "sum_field",
      // **【`V6-M2-T01` / `K-G2` / `ADR-0289` 限定1 が足した29キー目 `reference_pickers`】**
      // (参照項目の選び方の、入力画面ごとの上書き)。**門A の本審査(`V6-M0` 単位A)を
      // 通って限定採用された増分である。** **列挙を消して件数に丸めない**(`custom_css` /
      // `menu_listed` / `field_groups` / `preset_list_shape` / `modal` / `search_fields` /
      // `page_size` / `preset_density` / `after_save` / `sum_field` と同じ作法)。
      // **`form` でだけ書ける**(限定4)。
      "reference_pickers",
      // **【2026-08-14。`V8-M8` / 台帳 `Q-G1` / 門A 本審査 = `V8-M7`】29キー目 `report`
      // (集計表の中身)。****`report_view`(画面種別の4種目)でだけ書ける。**
      // **列挙を消して件数に丸めない**(`custom_css` / `menu_listed` と同じ作法)。
      "report",
      // **【2026-08-20。`V10-M1-T02` / 台帳 `NV-G4` / 門A 本審査 = `V10-M0` 群A /
      // `ADR-0359` §4a 限定1・限定2】30キー目 `after_delete`(削除が成立したあとの
      // 行き先)。****`detail_view` でだけ書ける**(限定2)。
      // **列挙を消して件数に丸めない**(`custom_css` / `menu_listed` と同じ作法)。
      "after_delete",
      // **【2026-08-20。`V10-M4-T01` / 台帳 `NV-G9` / 門A 本審査 = `V10-M0` 群B /
      // `ADR-0359` §4b 限定1 が足した31キー目 `flow`】** **一続きの流れの中の段。**
      // **列挙を消して件数に丸めない**(この列挙が「気づかないうちに properties が
      // 増える」ことを防ぐ仕掛けそのものである)。
      "flow",
    ]);
  });

  test("view の name は table.name と同じ定義を $ref する(V1-M0-T02 限定1・完了条件3)", () => {
    const schema = canonicalManifestSchema();
    // 新しい $defs を作らず、既存の定義を JSON Pointer で指していること。
    expect(schema.$defs.view.properties.name.$ref).toBe("#/$defs/table/properties/name");
    expect(schema.$defs.name).toBeUndefined();
  });

  test("view の name の型違反・空文字は table.name と同じ形で拒否される(限定1)", () => {
    for (const bad of [42, "", null, ["a"]]) {
      const manifest = clone(bookTrackerManifest) as Any;
      manifest.app.views[0].name = bad;
      const viewErrors = expectInvalid(validateManifest(manifest)).filter(
        (e) => e.path === "/app/views/0/name",
      );
      expect(viewErrors.length).toBeGreaterThan(0);

      const tableCase = clone(bookTrackerManifest) as Any;
      tableCase.app.tables[0].name = bad;
      const tableErrors = expectInvalid(validateManifest(tableCase)).filter(
        (e) => e.path === "/app/tables/0/name",
      );
      expect(viewErrors.map((e) => e.message)).toEqual(tableErrors.map((e) => e.message));
    }
  });

  test("view に description / icon / order は依然として指定できない(V1-M0-T02 限定2)", () => {
    for (const key of ["description", "icon", "order"]) {
      const manifest = clone(bookTrackerManifest) as Any;
      manifest.app.views[0][key] = key === "order" ? 1 : "なにか";
      const errors = expectInvalid(validateManifest(manifest));
      expect(errors.some((e) => e.path === "/app/views/0" && e.message.includes(key))).toBe(true);
    }
  });

  test("sort.order の語彙外を拒否し allowed_values を持つ", () => {
    const manifest = clone(bookTrackerManifest) as Any;
    manifest.app.views[0].sort.order = "descending";
    const errors = expectInvalid(validateManifest(manifest));
    const err = errors.find((e) => e.path === "/app/views/0/sort/order");
    expect(err?.allowed_values).toEqual(["asc", "desc"]);
  });

  test("app 欠落を拒否する", () => {
    const errors = expectInvalid(validateManifest({}));
    expect(errors.some((e) => e.message.includes("app"))).toBe(true);
  });

  test("複数のエラーをまとめて返す(allErrors)", () => {
    const manifest = clone(bookTrackerManifest) as Any;
    manifest.app.tables[0].fields[0].type = "datetime";
    manifest.app.views[0].type = "chart";
    const errors = expectInvalid(validateManifest(manifest));
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  test("null / 配列 / 文字列などオブジェクト以外を拒否する", () => {
    for (const bad of [null, [], "manifest", 42]) {
      expect(validateManifest(bad).valid).toBe(false);
    }
  });

  test("すべてのエラーが path と message を持つ", () => {
    const manifest = clone(bookTrackerManifest) as Any;
    manifest.app.tables[0].fields[2].type = "datetime";
    manifest.app.views[0].type = "chart";
    for (const e of expectInvalid(validateManifest(manifest))) {
      expect(typeof e.path).toBe("string");
      expect(e.message.length).toBeGreaterThan(0);
    }
  });
});

describe("validateDiff / 正常系", () => {
  test("handover 3.5 のサンプル diff が通過する", () => {
    expect(validateDiff(sampleDiff)).toEqual({ valid: true });
  });

  test("additive 4種の op がすべて通過する", () => {
    const diff = {
      diff_id: "d-0001",
      intent: "著者テーブルを足して一覧に出す",
      operations: [
        {
          op: "add_table",
          table: {
            id: "authors",
            name: "著者",
            fields: [{ id: "name", name: "名前", type: "text", required: true }],
          },
        },
        {
          op: "add_field",
          table: "books",
          field: { id: "author", name: "著者", type: "reference", reference_table: "authors" },
        },
        {
          op: "add_view",
          view: {
            id: "author-list",
            type: "list_view",
            table: "authors",
            columns: ["name"],
          },
        },
        {
          op: "update_view",
          view: "book-list",
          changes: { columns: ["title", "author"], filter: [{ field: "owned", equals: true }] },
        },
      ],
    };
    expect(validateDiff(diff)).toEqual({ valid: true });
  });
});

describe("validateDiff / 異常系", () => {
  test("intent 欠落を拒否する", () => {
    const diff = clone(sampleDiff) as Any;
    delete diff.intent;
    const errors = expectInvalid(validateDiff(diff));
    expect(errors.some((e) => e.message.includes("intent"))).toBe(true);
  });

  test("intent が空文字の場合を拒否する", () => {
    const diff = clone(sampleDiff) as Any;
    diff.intent = "";
    const errors = expectInvalid(validateDiff(diff));
    expect(errors.some((e) => e.path === "/intent")).toBe(true);
  });

  test("diff_id 欠落を拒否する", () => {
    const diff = clone(sampleDiff) as Any;
    delete diff.diff_id;
    const errors = expectInvalid(validateDiff(diff));
    expect(errors.some((e) => e.message.includes("diff_id"))).toBe(true);
  });

  test("operations 欠落・空配列を拒否する", () => {
    const noOps = clone(sampleDiff) as Any;
    delete noOps.operations;
    expect(validateDiff(noOps).valid).toBe(false);

    const emptyOps = clone(sampleDiff) as Any;
    emptyOps.operations = [];
    expect(validateDiff(emptyOps).valid).toBe(false);
  });

  test("未知の op を許可op一覧付きで拒否する", () => {
    const diff = clone(sampleDiff) as Any;
    diff.operations[0].op = "frobnicate";
    const errors = expectInvalid(validateDiff(diff));
    const err = errors.find((e) => e.path === "/operations/0/op");
    expect(err).toBeDefined();
    expect(err?.allowed_values).toEqual([...DIFF_OPS]);
  });

  // **V1-M1-T03(ADR-0010)で対象を入れ替えた。** `remove_field` / `remove_table` は
  // 語彙内になったので、ここの題材にできない(それらの受理は apply-diff.test.ts の
  // 完了条件A/B が固定している)。**今も語彙外であるもの**だけを残す ——
  // **`remove_view` は ADR-0012 で門A を通って語彙内になったので、ここから外した。**
  // `remove_app` / `patch_manifest` / `copy_field` は ADR-0012 限定1 が名指しで
  // 止めている op、`rename_field` / `change_type` / `set_required` は
  // **能力はあるが綴りが違う** op である。
  test.each([
    "remove_app",
    "patch_manifest",
    "copy_field",
    "rename_field",
    "change_type",
    "set_required",
  ])("語彙外op %s を許可op一覧付きで拒否する", (op) => {
    const diff = {
      diff_id: "d-0099",
      intent: "いらない列を消したい",
      operations: [{ op, table: "books", field: "finished_at" }],
    };
    const errors = expectInvalid(validateDiff(diff));
    const err = errors.find((e) => e.path === "/operations/0/op");
    expect(err).toBeDefined();
    expect(err?.allowed_values).toEqual([...DIFF_OPS]);
    expect(err?.allowed_values).not.toContain(op);
  });

  test.each(["remove_field", "remove_table", "change_table", "change_field"])(
    "破壊的op %s は語彙内である(ADR-0010 が門A を通した4種)",
    (op) => {
      expect([...DIFF_OPS] as string[]).toContain(op);
    },
  );

  test("remove_view は語彙内である(ADR-0012 が門A を通した1種)", () => {
    expect([...DIFF_OPS] as string[]).toContain("remove_view");
  });

  /**
   * **ADR-0010 限定3 / ADR-0012 限定2 を機械的に固定する。**
   *
   * 「op を1つ足すのに `$defs/operation.properties` へキーを1つも足さない」
   * 「既存の分岐の `false` 宣言を1バイトも書き換えない」は、目視の差分検査だけに
   * 頼ると次の改訂で必ず崩れる。**崩れた瞬間に赤くなること**が限定の実体である。
   *
   * ## 【V1-M2-T07 / ADR-0013 による改訂 —— この不変条件は1度だけ破られた】
   *
   * **上の「キーが増えない」は、ADR-0010 制定から ADR-0012 まで一度も破られなかった。**
   * 破壊的4種も `remove_view` も、既存の `table` / `field` / `view` / `changes` の
   * 転用だけで足りたからである。
   *
   * **ADR-0013 が、ADR-0013 §4c の追加関門3問を通したうえで、これを破った。**
   * 3問とは (問1) 既存キーの転用で目的が達成できないことをキーの意味の数で示せるか
   * (問2) 書き換える既存分岐の `false` 宣言を名指しで全件列挙しているか
   * (問3) 限定3 が無くなったあとに何がその位置を占めるのか、である。
   * 破った根拠は問1 —— `view` キーを転用する案(却下案2)を採ると `view` の意味が
   * 2つから4つになり、**隠れた語彙拡張は見える語彙拡張より悪い**。
   *
   * **したがって「キーは増えない」はもう不変条件ではない。問3 の答えが新しい不変条件で
   * あり、それがこの describe が今固定しているものである(ADR-0013 限定3)**:
   *
   * > **`$defs/operation.properties` は `op` / `table` / `field` / `view` / `changes` /
   * > `workflow` の6キーで閉じる。7キー目を足してはならない。**
   *
   * **1度破られたことをここに書き残すのは、「前も破ったのだから」を次の提案の理由に
   * させないためである。**`remove_field` が通ったことが `remove_view` の理由にならず、
   * `remove_view` が通ったことが次の op の理由にならないのと同じ構造で、
   * **`workflow` が通ったことは7キー目の理由にならない。**足す提案は ADR-0013 §4c の
   * 3問に答えたうえで ADR-0007 の門A を改めて通すこと。
   */
  describe("差分スキーマの operation のキーは6つで閉じる(ADR-0013 限定3。ADR-0010 限定3 を1度だけ破って置き換えたもの)", () => {
    const operation = canonicalSchema("diff.schema.json").$defs.operation as Any;

    // **【`V5-M17b` / `ADR-0248` 限定4】** **旧テスト名の逐語は
    // 「properties のキーは op / table / field / view / changes / workflow / function / theme の8つで閉じる。9キー目を足してはならない」である。**
    // **テスト名を実体に合わせた** —— **`v5-merge-repair-2.md` §5-2 が数えた
    // 「本体だけ追随してテスト名に古い数が残る」箇所を1件も増やさないため。**
    // **【`V8-M16-T03` / `J-G1b` / `D-V8-31`】** **旧テスト名の逐語は
    // 「properties のキーは op / table / field / view / changes / workflow / function / theme / user_kinds の9つで閉じる。10キー目を足してはならない」である。**
    // **テスト名も期待値も実体に合わせた** —— **数で書いた記述は静かに嘘になる。検査は消していない。**
    // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a` / `T-G11`。判定値 = 廃止】**
    // **`user_kinds` の器と `set_user_kinds` を撤去したので、期待値から `user_kinds` を1件外した(10 → 9)。**
    // **旧(逐語)**: 期待値は `["op","table","field","view","changes","workflow","function","theme","user_kinds","roles"]` の10キー。
    // **テスト名の「user_kinds」と「10」は当時の逐語である**(テスト名は書き換えない。検査は1本も減らしていない)。
    test("properties のキーは op / table / field / view / changes / workflow / function / theme / user_kinds / roles の10で閉じる。11キー目を足してはならない", () => {
      expect(Object.keys(operation.properties)).toEqual([
        "op",
        "table",
        "field",
        "view",
        "changes",
        // **ADR-0013 §4c が追加関門3問を通して足した6キー目。**
        "workflow",
        // **ADR-0024 §4c が追加関門3問を通して足した7キー目。**
        "function",
        // **ADR-0047 §4c が追加関門3問を通して足した8キー目(V3-M1-T03)。
        // ここが9つになったら、それは新しい不変条件を破る提案が門A を通らずに
        // 入った合図である。**足す提案は ADR-0013 §4c の3問に改めて答えたうえで
        // 門A を通すこと(ADR-0047 §3a 8 / 限定11)。**テスト名と
        // `schemas/diff.schema.json` の `$comment` は同時に更新する** ——
        // 片方だけ直すと条文と実装のどちらかが嘘になる(ADR-0047 限定11)。
        "theme",
        // **ADR-0248 §4c が追加関門3問を通して足した9キー目(V5-M17b)。
        // ここが10 になったら、それは新しい不変条件を破る提案が門A を通らずに
        // 入った合図である。**足す提案は ADR-0013 §4c の3問に改めて答えたうえで
        // 門A を通すこと(ADR-0248 §3a 4 / 限定4)。**この不変条件が破られるのは
        // 4代目である**(ADR-0010 限定3 → ADR-0013 → ADR-0024 → ADR-0047 → 本決定)。
        // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a` / `T-G11`。判定値 = 廃止】**
        // **旧(逐語)**: `"user_kinds",` —— この1行を消した(器ごと撤去された)。
        // **`V8-M16-T03` が `ADR-0013` §4c の追加関門3問に答えたうえで足した10キー目
        // (台帳 `J-G1b` / ユーザ決定 `D-V8-31`。門A 本審査 = 限定採用)。**
        // **直上の「ここが10 になったら門A を通らない増分が入った合図」は制定時の文であり
        // 消していない** —— **本件は門A を通った増分である。**ここが11 になったら、
        // それは新しい不変条件を破る提案が門A を通らずに入った合図である。
        // **この不変条件が破られるのは5代目である**(ADR-0010 限定3 → ADR-0013 →
        // ADR-0024 → ADR-0047 → ADR-0248 → 本決定)。
        "roles",
      ]);
    });

    test("allOf は op ごとに1分岐ずつあり、DIFF_OPS と1対1に対応する", () => {
      const branchOps = (operation.allOf as Any[]).map((branch) => branch.if.properties.op.const);
      expect(branchOps).toEqual([...DIFF_OPS]);
    });

    test("allOf の各要素は if / then / else 以外のキーを持たない", () => {
      // ajv-error-adapter.ts の resolveAllowedProperties が「解釈できない分岐」として
      // 諦め、未知プロパティのエラーから allowed_values が消える(V1-M1-T03 で実際に踏んだ)。
      for (const branch of operation.allOf as Any[]) {
        for (const key of Object.keys(branch)) {
          expect(["if", "then", "else"]).toContain(key);
        }
      }
    });

    /**
     * **テスト名の「既存8分岐」は、書かれた時点から実体(9分岐)とずれていた。**
     * ADR-0012 が `remove_view` を足したときに期待値の側だけを直し、テスト名を
     * 直さなかったためである。**V1-M2-T07 が実体に合わせた** —— この種の
     * 「数を名前に焼き込んだまま実体だけ動かす」ずれが、T07 の計画書が
     * `DIFF_OP_ENUM_HINT` と `fixtures/invalid/diff-unknown-op.json` を数え落とした
     * 直接の原因である。**数を名前に書くなら、実体と一緒に動かすこと。**
     *
     * **ADR-0013 は全12分岐の `false` 宣言に `workflow` を書き足した。**これは
     * ADR-0010 限定3 が禁じていた「既存分岐の `false` 宣言の書き換え」に当たるが、
     * ADR-0013 §4c の問2 が要求するとおり、書き換えた既存分岐は数ではなく
     * **名指しで全9件** —— add_table / add_field / add_view / update_view /
     * remove_field / remove_table / change_table / change_field / remove_view ——
     * が diff.schema.json の `$comment` に列挙されている。**それ以外の `false` 宣言は
     * 1バイトも変わっていない**ことを、下の `toEqual` が全件で固定する。
     */
    // **【`V5-M17b` / `ADR-0248` §4c 問2】** **旧テスト名の逐語は
    // 「op ごとの false 宣言(禁止キー)が、全16分岐で実体どおりである(ADR-0047 が全既存分岐に theme を1つ加え、set_theme 分岐を足した)」である。**
    // **【`V8-M16-T03` / `J-G1b` / `D-V8-31`。`ADR-0013` §4c 問2】** **旧テスト名の逐語は
    // 「op ごとの false 宣言(禁止キー)が、全17分岐で実体どおりである(ADR-0248 が全既存分岐に user_kinds を1つ加え、set_user_kinds 分岐を足した)」である。**
    // **`V8-M16` が全既存17分岐に `roles: false` を1つ加え、`set_roles` 分岐を足したので、
    // テスト名と期待値を同時に実体へ合わせた。検査は消していない。**
    // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a` / `T-G11`。判定値 = 廃止】**
    // **`user_kinds` の器と `set_user_kinds` を撤去したので、(a) 全既存分岐から `"user_kinds"` を1件ずつ外し、
    // (b) `set_user_kinds` の分岐そのものを期待値から外した(18分岐 → 17分岐)。**
    // **テスト名の「全18分岐」は当時の逐語である**(テスト名は書き換えない。検査は1本も減らしていない)。
    test("op ごとの false 宣言(禁止キー)が、全18分岐で実体どおりである(V8-M16 が全既存分岐に roles を1つ加え、set_roles 分岐を足した)", () => {
      const forbidden = Object.fromEntries(
        (operation.allOf as Any[]).map((branch) => [
          branch.if.properties.op.const,
          Object.entries(branch.then.properties as Record<string, unknown>)
            .filter(([, sub]) => sub === false)
            .map(([name]) => name),
        ]),
      );
      expect(forbidden).toEqual({
        // **既存12分岐。末尾の `function` / `theme` 以外は1バイトも変わっていない**
        // (ADR-0024 が7キー目 function を足し、**ADR-0047 が8キー目 theme を足した**ので、
        // 全既存分岐に function: false と theme: false が1つずつ増える。
        // ADR-0047 §4c 問2 が「書き換える既存分岐を数ではなく名指しで全15件」列挙している)。
        //
        // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a` / `T-G11`。判定値 = 廃止】**
        // **旧(逐語)** —— 既存12分岐の禁止集合は `"theme"` と `"roles"` の間に `"user_kinds"` を1件ずつ持っていた:
        //   `add_table: ["field","view","changes","workflow","function","theme","user_kinds","roles"],`
        //   `add_field: ["view","changes","workflow","function","theme","user_kinds","roles"],`
        //   `add_view: ["table","field","changes","workflow","function","theme","user_kinds","roles"],`
        //   `update_view: ["table","field","workflow","function","theme","user_kinds","roles"],`
        //   `remove_field: ["view","changes","workflow","function","theme","user_kinds","roles"],`
        //   `remove_table: ["field","view","changes","workflow","function","theme","user_kinds","roles"],`
        //   `change_table: ["field","view","workflow","function","theme","user_kinds","roles"],`
        //   `change_field: ["view","workflow","function","theme","user_kinds","roles"],`
        //   `remove_view: ["table","field","changes","workflow","function","theme","user_kinds","roles"],`
        //   `add_workflow: ["table","field","view","changes","function","theme","user_kinds","roles"],`
        //   `update_workflow: ["table","field","view","changes","function","theme","user_kinds","roles"],`
        //   `remove_workflow: ["table","field","view","changes","function","theme","user_kinds","roles"],`
        add_table: ["field", "view", "changes", "workflow", "function", "theme", "roles"],
        add_field: ["view", "changes", "workflow", "function", "theme", "roles"],
        add_view: ["table", "field", "changes", "workflow", "function", "theme", "roles"],
        update_view: ["table", "field", "workflow", "function", "theme", "roles"],
        remove_field: ["view", "changes", "workflow", "function", "theme", "roles"],
        remove_table: ["field", "view", "changes", "workflow", "function", "theme", "roles"],
        change_table: ["field", "view", "workflow", "function", "theme", "roles"],
        change_field: ["view", "workflow", "function", "theme", "roles"],
        remove_view: ["table", "field", "changes", "workflow", "function", "theme", "roles"],
        add_workflow: ["table", "field", "view", "changes", "function", "theme", "roles"],
        update_workflow: ["table", "field", "view", "changes", "function", "theme", "roles"],
        remove_workflow: ["table", "field", "view", "changes", "function", "theme", "roles"],
        // **ADR-0024 が足した3分岐。**7キー目 `function` を使う唯一の op 群であり、
        // 残る5キー(workflow を含む)をすべて禁止する。**3分岐の禁止集合が完全に同一で
        // あること**が、「`function` キーの意味は2義に閉じる」(定義そのもの / 対象のID)の
        // 裏返しである —— 意味が3義目に分かれると、必要なキーが分岐ごとに変わって必ずここが割れる。
        // **【2026-08-11。`V8-M29` 第2波】旧(逐語)** —— 関数3分岐も `"theme"` と `"roles"` の間に
        // `"user_kinds"` を持っていた:
        //   `add_function: ["table","field","view","changes","workflow","theme","user_kinds","roles"],`
        //   `update_function: ["table","field","view","changes","workflow","theme","user_kinds","roles"],`
        //   `remove_function: ["table","field","view","changes","workflow","theme","user_kinds","roles"],`
        add_function: ["table", "field", "view", "changes", "workflow", "theme", "roles"],
        update_function: ["table", "field", "view", "changes", "workflow", "theme", "roles"],
        remove_function: ["table", "field", "view", "changes", "workflow", "theme", "roles"],
        // **ADR-0047 が足した1分岐(16種目)。**8キー目 `theme` を使う唯一の op であり、
        // 残る6キーをすべて禁止する。**`theme` キーの意味は1義である**(対象IDを取らない)。
        // **【2026-08-11。`V8-M29` 第2波】旧(逐語)**:
        //   `set_theme: ["table","field","view","changes","workflow","function","user_kinds","roles"],`
        set_theme: ["table", "field", "view", "changes", "workflow", "function", "roles"],
        // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】**
        // **`set_user_kinds` の分岐そのものを期待値から外した(語彙から消えたので分岐が実在しない)。**
        // **旧(逐語)**:
        //   `// **ADR-0248 が足した1分岐(17種目)。**9キー目 \`user_kinds\` を使う唯一の op であり、`
        //   `// 残る7キーをすべて禁止する。**\`user_kinds\` キーの意味は1義である**(対象IDを取らない)。`
        //   `set_user_kinds: ["table","field","view","changes","workflow","function","theme","roles"],`
        // **`V8-M16` が足した1分岐(18種目)。**10キー目 `roles` を使う唯一の op であり、
        // 残る8キーをすべて禁止する。**`roles` キーの意味は1義である**(対象IDを取らない)。
        // **【2026-08-11。`V8-M29` 第2波】旧(逐語)**:
        //   `set_roles: ["table","field","view","changes","workflow","function","theme","user_kinds"],`
        // **本廃止で `set_roles` は 17種目・最後の op になり、禁止するのは残る7キーである。**
        set_roles: ["table", "field", "view", "changes", "workflow", "function", "theme"],
      });
    });

    test("remove_view の分岐は view だけを必須にし、changes を取らない(限定3)", () => {
      const branch = (operation.allOf as Any[]).find(
        (each) => each.if.properties.op.const === "remove_view",
      );
      expect(branch.then.required).toEqual(["view"]);
      expect(branch.then.properties.view.$ref).toBe(
        "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/resource_id",
      );
      expect(branch.then.properties.changes).toBe(false);
    });
  });

  test("update_view の changes に許可外プロパティがあると拒否する", () => {
    const diff = clone(sampleDiff) as Any;
    diff.operations[1].changes = { table: "authors" };
    const errors = expectInvalid(validateDiff(diff));
    expect(errors.some((e) => e.message.includes("table"))).toBe(true);
  });

  test("update_view の changes が空オブジェクトだと拒否する", () => {
    const diff = clone(sampleDiff) as Any;
    diff.operations[1].changes = {};
    expect(validateDiff(diff).valid).toBe(false);
  });

  test("update_view の changes は columns/sort/filter/fields を許可する", () => {
    for (const changes of [
      { columns: ["title"] },
      { sort: { field: "title", order: "asc" } },
      { filter: [{ field: "status", equals: "読了" }] },
      { fields: ["title"] },
    ]) {
      const diff = {
        diff_id: "d-0100",
        intent: "ビューを調整する",
        operations: [{ op: "update_view", view: "book-list", changes }],
      };
      expect(validateDiff(diff)).toEqual({ valid: true });
    }
  });

  test("add_field の field が語彙外の型だと拒否する", () => {
    const diff = clone(sampleDiff) as Any;
    diff.operations[0].field.type = "datetime";
    const errors = expectInvalid(validateDiff(diff));
    const err = errors.find((e) => e.path === "/operations/0/field/type");
    expect(err?.allowed_values).toEqual([...FIELD_TYPES]);
  });

  test("op 内の未知プロパティを拒否する", () => {
    const diff = clone(sampleDiff) as Any;
    diff.operations[0].position = 3;
    const errors = expectInvalid(validateDiff(diff));
    expect(errors.some((e) => e.message.includes("position"))).toBe(true);
  });

  test("add_field の table にオブジェクトを渡すと拒否する", () => {
    const diff = clone(sampleDiff) as Any;
    diff.operations[0].table = { id: "books" };
    expect(validateDiff(diff).valid).toBe(false);
  });

  test("null / 配列などオブジェクト以外を拒否する", () => {
    for (const bad of [null, [], "diff", 0]) {
      expect(validateDiff(bad).valid).toBe(false);
    }
  });
});

describe("未知プロパティのエラーに許可プロパティ一覧が入る (CP-1 確認方法3)", () => {
  /*
   * V1-M0-T02 以前、この位置の「許可外プロパティ」の例は `name` だった(view は name を
   * 持てなかったため)。**限定採用で `name` は受理側に移った**ので、例を `title` に差し替える。
   * 主張は変わっていない —— 「changes の許可外キーは拒否され、許可キーが列挙される」。
   */
  test("update_view の changes の許可外プロパティで name/columns/sort/filter/fields が示される", () => {
    const diff = clone(sampleDiff) as Any;
    diff.operations[1].changes = { title: "書籍一覧", sort: { field: "title", order: "asc" } };
    const errors = expectInvalid(validateDiff(diff));
    const err = errors.find(
      (e) => e.path === "/operations/0/changes" || e.path === "/operations/1/changes",
    );
    expect(err).toBeDefined();
    expect(err?.message).toContain("title");
    const allowed = err?.allowed_values ?? [];
    for (const key of ["name", "columns", "sort", "filter", "fields"]) {
      expect(allowed).toContain(key);
    }
    expect(allowed).not.toContain("title");
  });

  test("update_view の changes に name を指定できる(V1-M0-T02 完了条件1)", () => {
    const diff = clone(sampleDiff) as Any;
    diff.operations[1].changes = { name: "蔵書一覧" };
    expect(validateDiff(diff)).toEqual({ valid: true });
  });

  test("add_view で name つきのビューを追加できる(V1-M0-T02 完了条件1)", () => {
    const diff = clone(sampleDiff) as Any;
    diff.operations.push({
      op: "add_view",
      view: {
        id: "book-detail-2",
        name: "本の詳細",
        type: "detail_view",
        table: "books",
      },
    });
    expect(validateDiff(diff)).toEqual({ valid: true });
  });

  // **V3-M2-T01(ADR-0050)がテスト名を更新した。** 旧名は「view_changes に増えたキーも
  // name の1つだけである」。**プリセット7キーが門A(ADR-0050)を通って増えた**ので、
  // 「1つだけ」は成立しない。**全キーを列挙して固定する向きは変えていない。**
  // **V3-M5-T02(ADR-0055 改訂1)がテスト名を更新した。** 旧名は「…とプリセット7キー
  // (ADR-0050)である」。**逃げ道の参照が門A の判定(改訂1)を経て13キー目に増えた**ので
  // 字面が成立しなくなった。**アサーションの向き(全キーを列挙して固定する)は
  // 1バイトも変えていない。**
  test("view_changes に増えたキーは name(V1-M0-T02 限定2)とプリセット7キー(ADR-0050)と逃げ道の参照(ADR-0055 改訂1)である", () => {
    const schema = canonicalSchema("diff.schema.json");
    expect(Object.keys(schema.$defs.view_changes.properties)).toEqual([
      "name",
      "columns",
      "sort",
      "filter",
      "fields",
      "preset_column_align",
      "preset_column_width",
      "preset_pager_position",
      "preset_label_placement",
      "preset_field_columns",
      "preset_image_size",
      "preset_text_preview",
      "custom_css",
      // **V4-M10-T45 / `E-G12` / ADR-0084 限定6 が足した14キー目 `menu_listed`。**
      // **`update_view` で後から書けて、カーネルが値を実際に運ぶ**(`ADR-0076` /
      // `ADR-0080` が作った「キーは在るが運ばれない」形を繰り返していない)。
      "menu_listed",
      // **V4-M16-T12 / `P-G17` の (C) 側 / ADR-0092 限定2 が足した15キー目 `field_groups`。**
      // **`update_view` で後から書けて、カーネルが値を実際に運ぶ**(`applyViewChanges` の
      // `detail_view` 分岐。**`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは運ばれない**)。
      "field_groups",
      // **V4-M16-T13 / `P-G24` の (C) 側 / ADR-0093 限定2 が足した16キー目 `preset_list_shape`。**
      // **`update_view` で後から書けて、カーネルが値を実際に運ぶ**(`applyViewChanges` の
      // `list_view` 分岐。**`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは運ばれない**)。
      "preset_list_shape",
      // **V4-M18-T03 / `P-G14` の (C) 側 / ADR-0095 限定6 が足した17キー目 `modal`。**
      // **`update_view` で後から書けて、カーネルが値を実際に運ぶ**(`applyViewChanges` の
      // `form` 分岐。**`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは運ばれない**)。
      "modal",
      // **V4-M22-T01 / ADR-0112 限定2 が足した18キー目 `search_fields`。**
      // **`update_view` で後から書けて、カーネルが値を実際に運ぶ**(`applyViewChanges` の
      // `list_view` 分岐。**`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは運ばれない**)。
      "search_fields",
      // **V4-M22-T05 / ADR-0113 限定2 が足した19キー目 `page_size`。**
      // **`update_view` で後から書けて、カーネルが値を実際に運ぶ**(`applyViewChanges` の
      // `list_view` 分岐。**`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは運ばれない**)。
      "page_size",
      // **V4-M19-T03 / `P-G32` の (C) 側 / ADR-0118 限定2 が足した20キー目 `preset_density`。**
      // **`update_view` で後から書けて、カーネルが値を実際に運ぶ**(`applyViewChanges` の
      // 当該分岐。**`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは運ばれない**)。
      // **本 ADR の増分ではない。**
      "preset_density",
      // **V4-M20-T04 / ADR-0102 限定2 が足した21キー目 `after_save`。**
      // **`update_view` で後から書けて、カーネルが値を実際に運ぶ**(`applyViewChanges` の
      // `form` 分岐。**`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは運ばれない**)。
      // **本 ADR の増分ではない。**
      "after_save",
      // **V4-M23-T01 / ADR-0104 限定採用が足した22キー目 `sum_field`**
      // (合計を出す列。`list_view` でだけ書ける)。
      // **`update_view` で後から書けて、カーネルが値を実際に運ぶ**(`applyViewChanges` の
      // `list_view` 分岐。**`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは運ばれない**)。
      // **本 ADR の増分ではない。**
      "sum_field",
      // **【V5-M21-T03 / `L-G4` / ADR-0172 限定1】23キー目 `actions`(操作起点)が末尾に
      // 入った** —— 門A の本審査(`V5-M20` 面1 の `L-G4`。判定 = 限定採用)を通った増分で
      // ある。**`related` / `audience` は今日も無い。****列挙を消して件数に丸めない。**
      "actions",
      // **【`V6-M2-T02` / `K-G3` / `ADR-0289` 限定1】24キー目 `reference_pickers`
      // (参照項目の選び方の、入力画面ごとの上書き。`form` でだけ書ける)が末尾に入った** ——
      // 門A の本審査(`V6-M0` 単位A の `K-G3`)を通った増分である。
      // **`update_view` で後から書けて、カーネルが値を実際に運ぶ**(`applyViewChanges` の
      // `form` 分岐。**`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは運ばれない**)。
      // **`related` / `audience` は今日も無い。****列挙を消して件数に丸めない。**
      "reference_pickers",
      // **【2026-08-14。`V8-M8` / 台帳 `Q-G1` / 門A 本審査 = `V8-M7`】25キー目 `report`
      // (集計表の中身)。****`update_view` で後から書けて、カーネルが値を実際に運ぶ**
      // (`applyViewChanges` の `report_view` 分岐。**`CHANGE_KEYS_BY_VIEW_TYPE` に足す
      // だけでは運ばれない**)。
      "report",
      // **【2026-08-20。`V10-M1-T02` / 台帳 `NV-G4` / `ADR-0359` §Decision 2】26キー目
      // `after_delete`(削除が成立したあとの行き先)。****`update_view` で後から書けて、
      // カーネルが値を実際に運ぶ**(`applyViewChanges` の `detail_view` 分岐。
      // **`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは運ばれない**)。
      "after_delete",
      // **【2026-08-20。`V10-M4-T01` / 台帳 `NV-G9` / `ADR-0359` §Decision 2 が足した
      // 27キー目 `flow`】** **一続きの流れの中の段を、後から差し替えられるようにした。**
      // **列挙を消して件数に丸めない。**
      "flow",
    ]);
    expect(schema.$defs.view_changes.properties.name.$ref).toBe(
      "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/table/properties/name",
    );
  });

  test("app 直下の未知プロパティで app の許可プロパティが示される", () => {
    const manifest = clone(bookTrackerManifest) as Any;
    // **V3-M1-T03(ADR-0047)で題材を入れ替えた。実装を直したのではない。**
    // このテストは「**語彙外のキーを書いたら許可プロパティ一覧が返る**」ことを固定する
    // ものであり、題材は「その時点で語彙外であるキー」でなければならない。
    // **旧い題材は `theme: "dark"` だったが、`theme` は ADR-0047 で語彙内になった** ——
    // 題材を変えないと、このテストは「語彙内のキーが拒否される」ことを主張する別の
    // テストに変わってしまう(それは偽である)。**`dark_mode` は今も語彙外である**
    // (ダークモードは ADR-0046 §3a 5 / ADR-0047 §3a 4 が門A の再通過を要求している)。
    manifest.app.dark_mode = true;
    const errors = expectInvalid(validateManifest(manifest));
    const err = errors.find((e) => e.path === "/app");
    expect(err).toBeDefined();
    // **`workflows` は ADR-0013 §1 が足した5つ目の許可プロパティである。**
    // **`required` には入っていない**(入れると既存マニフェストが全部 invalid になり
    // `readCurrentManifest` が例外を投げる)が、**許可プロパティには入る** ——
    // ここに出ないと、AI は `workflows` を書けることに気づけない。
    // **`functions` は ADR-0024(V1-M6-T05)が足した6つ目の許可プロパティである**
    // (workflows と同じく required には入れない。同じ理由で許可プロパティには入る)。
    // **`theme` は ADR-0047(V3-M1-T03)が足した7つ目の許可プロパティである**
    // (同じく required には入れない。同じ理由で許可プロパティには入る ——
    // ここに出ないと、AI はテーマを書けることに気づけない)。
    // **`user_kinds` は `ADR-0158` 限定8(`V5-M17-T02`)が足した8つ目の許可プロパティである**
    // (workflows / functions / theme と同じく required には入れない。同じ理由で許可
    // プロパティには入る —— ここに出ないと、AI は利用者の種類を宣言できることに気づけない)。
    // **`roles` は `V8-M16-T02`(台帳 `J-G1b` / `D-V8-31`)が足した9つ目の許可プロパティである**
    // (workflows / functions / theme / user_kinds と同じく required には入れない。同じ理由で
    // 許可プロパティには入る —— ここに出ないと、AI は役割を宣言できることに気づけない)。
    // **期待値に1件足した。検査は消していない。**
    // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】**
    // **`app.user_kinds` の器を撤去したので、許可プロパティの一覧から `user_kinds` が消えた(9 → 8)。**
    // **旧(逐語)**: `expect(err?.allowed_values).toEqual(["id","name","tables","views","workflows","functions","theme","user_kinds","roles"]);`
    expect(err?.allowed_values).toEqual([
      "id",
      "name",
      "tables",
      "views",
      "workflows",
      "functions",
      "theme",
      "roles",
    ]);
    expect(err?.message).toContain("dark_mode");
  });

  test("マニフェストのルートの未知プロパティで app が示される", () => {
    const manifest = clone(bookTrackerManifest) as Any;
    manifest.version = 2;
    const errors = expectInvalid(validateManifest(manifest));
    const err = errors.find((e) => e.path === "");
    expect(err?.allowed_values).toEqual(["app"]);
  });

  test("条件分岐を持つ view の位置では、その type で書ける属性だけが列挙される (V1-M0-T04)", () => {
    // view は if/then で type ごとに columns/fields 等を禁止するため、素朴な properties 一覧は
    // 「その文脈で本当に書けるもの」と一致しない。以前はそれを理由に列挙を省いていたが
    // (嘘を出すより省く / 憲法6)、V1-M0-T04 で条件分岐を実インスタンスに対して解決するようにした。
    // 列挙が実際の受理集合と一致することは ajv-error-adapter.test.ts の網羅的突き合わせが担保する。
    const manifest = clone(bookTrackerManifest) as Any;
    expect(manifest.app.views[0].type).toBe("list_view");
    manifest.app.views[0].width = 100;
    const errors = expectInvalid(validateManifest(manifest));
    const err = errors.find((e) => e.path === "/app/views/0" && e.message.includes("width"));
    expect(err).toBeDefined();
    // list_view なので fields は含まれない。name は3種すべてで書けるので含まれる(V1-M0-T02)。
    // プリセットは list_view で書ける5軸だけが出る(V3-M2-T01 / ADR-0050)。
    // **逃げ道の参照(custom_css)は3種すべてで書けるので含まれる**(V3-M5-T02 / ADR-0055)。
    expect(err?.allowed_values).toEqual([
      "id",
      "type",
      "table",
      "name",
      "columns",
      "sort",
      "filter",
      // **【V5-M21-T01 / `L-G1` / ADR-0171 が `list_view` 分岐の `"actions": false,` を
      // 解いたので、一覧の受理集合に `actions` が入った】** **キーを1本も足していない**
      // (`$defs/view.properties` は 28 のままである)—— **入ったのは「この type で書ける」
      // 側であって、キーの本数ではない。** **列挙を消して件数に丸めない。**
      "actions",
      "preset_column_align",
      "preset_column_width",
      "preset_pager_position",
      "preset_image_size",
      "preset_text_preview",
      "custom_css",
      // **V4-M3-T02 / `B-G1` / ADR-0070 限定1 が足した19キー目 `audience`**(画面ごとに
      // 見せる相手)。**門A の本審査を通って限定採用された増分である。列挙を消して件数に
      // 丸めない**(`custom_css` と同じ作法)。
      // **【`V8-M20-T01` / 台帳 `J-G27` / 手続きは `ADR-0301`。2026-08-10】** **この19キー目
      // `audience` は廃止された**(判定 = 廃止)。**上の3行は歴史の記述として残してあり、
      // 1バイトも消していない。****列挙から1本消したのであって、件数へ丸めたのではない。**
      // **代わりに担うのは `app.roles[].rules` の「役割 × 対象(画面)× 読取」である。**
      // **V4-M10-T45 / `E-G12` / ADR-0084 限定1 が足した20キー目 `menu_listed`**(画面を
      // メニューへ出すか)。**門A の本審査(再審査 B8)を通って限定採用された増分である。**
      // **これは可視性ではなく掲載の宣言であり、`audience` とは役割が違う**(限定5)。
      "menu_listed",
      // **V4-M16-T13 / `P-G24` の (C) 側 / ADR-0093 限定1 が足した22キー目
      // `preset_list_shape`**(一覧の器の形。8つ目の `preset_` キー)。**門A の本審査
      // (`V4-M14` 本審査② の単位11)を通って限定採用された増分である。****`list_view` で
      // だけ書ける**(限定2)ので、この文脈(list_view)の受理集合に現れる。
      "preset_list_shape",
      // **V4-M22-T01 / ADR-0112 限定1 が足した24キー目 `search_fields`**(検索の対象にする
      // 列)。**門A の本審査(V4-M22 単位A)を通って限定採用された増分である。**`list_view` で
      // だけ書ける(form / detail_view では `false`)ので、この文脈(list_view)の受理集合に現れる。
      "search_fields",
      // **V4-M22-T05 / ADR-0113 限定1 が足した25キー目 `page_size`**(1ページに出す件数)。
      // **門A の本審査(V4-M22 単位C。4回目の審査)を通って限定採用された増分である。**
      // **`list_view` でだけ書ける**(form / detail_view では `false`)ので、この文脈
      // (list_view)の受理集合に現れる。
      "page_size",
      // **V4-M19-T03 / `P-G32` の (C) 側 / ADR-0118 限定1 が足した26キー目 `preset_density`**
      // (画面の詰まり具合)。**門A の本審査(V4-M19 単位C。2回目の審査)を通って限定採用
      // された増分である。****3種すべてに書ける**(限定6)ので、この文脈(list_view)の
      // 受理集合にも現れる。**本 ADR の増分ではない。**
      "preset_density",
      // **V4-M23-T01 / ADR-0104 限定採用が足した28キー目 `sum_field`**(合計を出す列)。
      // **門A の本審査を通って限定採用された増分である。****`list_view` でだけ書ける**
      // (form / detail_view では `false`)ので、この文脈(list_view)の受理集合に現れる。
      "sum_field",
      // **【2026-08-20。`V10-M4-T01` / 台帳 `NV-G9` / 門A 本審査 = `V10-M0` 群B /
      // `ADR-0359` §4b 限定1 が足した31キー目 `flow`】** **一続きの流れの中の段。**
      // **列挙を消して件数に丸めない**(この列挙が「気づかないうちに properties が
      // 増える」ことを防ぐ仕掛けそのものである)。
      "flow",
    ]);
  });
});

describe("diff_id の長さ制限(ADR-0028 / V1-M9-T08)", () => {
  /**
   * スキーマの `diff_id.maxLength` と実装定数 `MAX_UNDOABLE_DIFF_ID_LENGTH` の一致を
   * 機械的に固定する(§4-4 の 3)。**59 という数字を2箇所に書いておくと、片方だけ動かした
   * 日に「宣言された契約と実装の振る舞いが食い違う」—— それはまさに本タスクが直した
   * 失敗そのものである(ADR-0028 §1)。**`op_name` enum と `DIFF_OPS` を1対1で固定する
   * 上の方式に倣い、値が離れた瞬間に赤くする。
   */
  test("diff.schema.json の diff_id.maxLength は MAX_UNDOABLE_DIFF_ID_LENGTH と一致する", () => {
    const schema = canonicalSchema("diff.schema.json");
    expect(schema.properties.diff_id.maxLength).toBe(MAX_UNDOABLE_DIFF_ID_LENGTH);
    // 由来の式(64 − len("undo-") = 59)も固定して、定数側が黙って動いていないことを見る。
    expect(MAX_UNDOABLE_DIFF_ID_LENGTH).toBe(59);
  });

  /** 境界値: 59文字は通り、60文字は maxLength で拒否される(スキーマ単体の判定)。 */
  const diffOfLength = (n: number) => ({
    diff_id: `d${"a".repeat(n - 1)}`,
    intent: "境界値",
    operations: [{ op: "add_field", table: "books", field: { id: "f", name: "F", type: "text" } }],
  });

  test("59文字の diff_id はスキーマを通る", () => {
    expect(validateDiff(diffOfLength(MAX_UNDOABLE_DIFF_ID_LENGTH)).valid).toBe(true);
  });

  test("60文字の diff_id はスキーマの maxLength(59)で拒否される", () => {
    const errors = expectInvalid(validateDiff(diffOfLength(MAX_UNDOABLE_DIFF_ID_LENGTH + 1)));
    const err = errors.find((e) => e.path === "/diff_id");
    expect(err).toBeDefined();
    expect(err?.message).toContain(`${MAX_UNDOABLE_DIFF_ID_LENGTH}文字以内`);
  });
});

// ===========================================================================
// V3-M1-T03(段階A): アプリのテーマ(ADR-0047 / ADR-0046)
//
// **限定の正は `docs/adr/0047-app-theme-manifest.md` §3(12点)である。**
// ここが固定するのは限定1(app に1キー・view とトップレベルには足さない)/
// 限定2(`required` に入れない)/ 限定5(`additionalProperties: false` で
// スロット名を列挙)/ 限定6(値域は型と形式。式・計算・参照を1つも入れない)/
// 限定7(`origin` は自己申告)/ 限定8(コントラスト検査は `incoming` だけ)/
// 2026-07-25 追記 (2)(全スロット `required` = 部分テーマを作らない)である。
// ===========================================================================

/** テーマ対象スロット(25件)。**集合の正はスキーマとフィクスチャであり、これは入力である。** */
const THEME_SLOTS_PASSING: Readonly<Record<string, string>> = {
  // 色9件。**既定配色ではない** —— 既定の `--color-border`(`#ddd`)は
  // 非テキスト閾値 3:1 を通らない(ADR-0046 2026-07-25 追記「限界7」)。
  "--color-text": "#000000",
  "--color-text-secondary": "#595959",
  "--color-text-label": "#595959",
  "--color-text-placeholder": "#595959",
  "--color-danger": "#a00000",
  "--color-page-background": "#ffffff",
  "--color-surface-highlight": "#f2f2f2",
  "--color-border": "#767676",
  "--focus-outline-color": "#005fcc",
  // 色でない16件。
  "--font-family-base": "system-ui, sans-serif",
  "--font-size-secondary": "0.85em",
  "--font-size-note": "0.875rem",
  "--line-height-base": "1.6",
  "--space-1": "0.25rem",
  "--space-2": "0.5rem",
  "--space-3": "0.75rem",
  "--space-4": "1rem",
  "--space-5": "1.25rem",
  "--space-6": "2rem",
  "--border-width": "1px",
  "--control-border-radius": "4px",
  "--surface-shadow": "none",
  "--focus-outline-width": "2px",
  "--detail-label-width": "8rem",
  "--login-max-width": "22rem",
};

/** テーマ付きマニフェストを作る(`slots` は差し替えられる)。 */
function manifestWithTheme(theme: unknown): Any {
  const manifest = clone(bookTrackerManifest) as Any;
  manifest.app.theme = theme;
  return manifest;
}

describe("V3-M1-T03: テーマの置き場(ADR-0047 限定1 / 限定2)", () => {
  // **【`V8-M16-T02` / `J-G1b` / `D-V8-31`】期待値に9本目 `roles` を1件足した。**
  // **この行が固定していたのは「`ADR-0047` が8キー目を足さなかったこと」であり、
  // 9本目を足したのは別の決定である。テスト名は当時の逐語のまま残す(既存の作法)。検査は消していない。**
  test("$defs/app の properties は7キーで、theme は required に入っていない", () => {
    const app = canonicalManifestSchema().$defs.app as Any;
    expect(Object.keys(app.properties)).toEqual([
      "id",
      "name",
      "tables",
      "views",
      "workflows",
      "functions",
      // **ADR-0047 限定1 が足した1キー。8キー目を足すなら門A を改めて通すこと。**
      "theme",
      // **【`V5-M17-T02` / `G-G5` / `ADR-0158` 限定8 が足した8キー目 `user_kinds`】**
      // **門A の本審査(`V5-M12` の単位 `G-G5` / `G-G6` / `G-G7`。判定 = 限定採用)を
      // 改めて通した増分である**(上の行が要求していた手続きを踏んだ)。
      // **この行が固定していたのは「`ADR-0047` が8キー目を足さなかったこと」であって、
      // 足したのは別の決定である**(`v5-merge-repair-2.md` §3-1 が名指しした形と同じ)。
      // **テスト名の「7キー」は当時の逐語であり、今日の本体は8である。名を書き換えていない。**
      // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】**
      // **旧(逐語)**: `"user_kinds",` —— 器ごと撤去されたので期待値から1行外した(9 → 8)。
      // **テスト名の「7キー」は今日も当時の逐語のままである(名を書き換えていない)。**
      // **【`V8-M16-T02` / `J-G1b` / `D-V8-31` が足した9本目 `roles`】**
      // **門A の本審査(判定 = 限定採用)を通した増分である。**
      // **この行が固定していたのは「`ADR-0047` が8キー目を足さなかったこと」であって、
      // 足したのは別の決定である。****テスト名の「7キー」は当時の逐語であり、今日の本体は9である。**
      "roles",
    ]);
    // 限定2: `required` を1バイトも変えない(`theme` 無しの既存マニフェストは valid のまま)。
    expect(app.required).toEqual(["id", "name", "tables", "views"]);
    expect(app.additionalProperties).toBe(false);
    // 限定7: 「版」に新しい概念を作らない(`$defs/app` に version を新設しない)。
    expect(Object.keys(app.properties)).not.toContain("version");
  });

  /**
   * **V3-M2-T01(ADR-0050)がテスト名を更新した。**
   *
   * 旧名は「**`$defs/view` とトップレベルには1キーも足していない(限定1)**」だった。
   * **`docs/adr/0050-view-display-presets.md` が門A を通して `$defs/view` に
   * プリセット7キーを足したので、その字面は文字どおりには成立しなくなった。**
   * アサーションは `theme` を含むキーしか見ないので**緑のまま通っていた** ——
   * 名前だけが嘘になる「黙って古くなる」型であり、放置しない
   * (`docs/plan/v3/records/v3-m2-gate-a-preset.md` §1-9 (B') / ADR-0050 §Consequences)。
   *
   * **ADR-0047 限定1 の趣旨(ビュー単位テーマを作らない)は破られていない。**
   * プリセットはテーマではない —— 色・書体・長さの実値を1つも持たず、値域はすべて
   * `enum` である(ADR-0050 Context の4点)。**この検査が守るのはその趣旨の方である。**
   */
  test("$defs/view にテーマのキーは1つも無い(限定1 の趣旨。増えた7キーは ADR-0050 の門A を通ったプリセットである)", () => {
    const schema = canonicalManifestSchema();
    expect(Object.keys(schema.properties)).toEqual(["app"]);
    const viewKeys = Object.keys((schema.$defs.view as Any).properties);
    expect(viewKeys).not.toContain("theme");
    // ビュー単位テーマを作らない = ADR-0047 §3a 3。
    expect(viewKeys.filter((key) => key.includes("theme"))).toEqual([]);
    // 増えたキーは `preset_` 前置の7つだけである(8つ目を足したらここが赤くなる)。
    // **【V4-M16-T13 / ADR-0093 限定1 で 7 → 8 に更新した】** 8つ目の `preset_` キー(一覧の器の形)は門A の本審査を通って限定採用された増分である。**9つ目を足したらここが赤くなる。**
    // **【V4-M19-T03 / ADR-0118 限定1 で 8 → 9 に更新した】** 9つ目の `preset_` キー
    // `preset_density`(画面の詰まり具合)が門A を通って増えた(V4-M19 単位C。2回目の審査。
    // 判定 = 限定採用)。**3種すべてに書けるキーである。****本 ADR の増分ではない。**
    expect(viewKeys.filter((key) => key.startsWith("preset_"))).toHaveLength(9);
  });

  test("theme を持たない既存マニフェストは valid のままである(限定2 / 完了条件11)", () => {
    expect(validateManifest(bookTrackerManifest)).toEqual({ valid: true });
    expect(validateManifestFull(bookTrackerManifest)).toEqual({ valid: true });
    expect(validateManifestFull(bookTrackerManifest, "stored")).toEqual({ valid: true });
  });
});

describe("V3-M1-T03: $defs/theme(ADR-0047 限定5 / 限定6 / 2026-07-25 追記(2))", () => {
  const themeDef = () => canonicalManifestSchema().$defs.theme as Any;

  test("スロット名を列挙し、additionalProperties: false で閉じている(限定5)", () => {
    const theme = themeDef();
    expect(theme.additionalProperties).toBe(false);
    expect(Object.keys(theme.properties)).toHaveLength(25);
    for (const name of Object.keys(theme.properties)) {
      expect(name.startsWith("--")).toBe(true);
    }
  });

  test("required のキー集合 == properties のキー集合(全スロット必須。部分テーマを作らない)", () => {
    const theme = themeDef();
    expect([...(theme.required as string[])].sort()).toEqual(Object.keys(theme.properties).sort());
  });

  test("テーマ対象外の3件は $defs/theme に無い(完了条件21)", () => {
    const keys = Object.keys(themeDef().properties);
    for (const excluded of ["--shell-max-width", "--border-style", "--focus-outline-style"]) {
      expect(keys).not.toContain(excluded);
    }
  });

  test("全スロットを持つテーマは valid で、1つ欠けると invalid(追記(2))", () => {
    expect(validateManifest(manifestWithTheme({ slots: THEME_SLOTS_PASSING }))).toEqual({
      valid: true,
    });
    const missing = { ...THEME_SLOTS_PASSING } as Record<string, string>;
    delete missing["--color-text"];
    expect(validateManifest(manifestWithTheme({ slots: missing })).valid).toBe(false);
  });

  test("未知スロットを含むテーマは invalid(AI はスロットを増やせない。D-1 / 限定5)", () => {
    const extra = { ...THEME_SLOTS_PASSING, "--color-brand": "#123456" };
    const errors = expectInvalid(validateManifest(manifestWithTheme({ slots: extra })));
    expect(errors.some((e) => e.message.includes("--color-brand"))).toBe(true);
  });

  test.each(["calc(1rem + 1px)", "var(--space-1)", "{{record.space}}", "$record.space"])(
    "式・計算・参照を含む値 %s は invalid(限定6 / ADR-0013 限定12 を破らない)",
    (value) => {
      const slots = { ...THEME_SLOTS_PASSING, "--space-1": value };
      expect(validateManifest(manifestWithTheme({ slots })).valid).toBe(false);
    },
  );

  test.each(["red", "rgb(0,0,0)", "rgba(0,0,0,0.5)", "currentColor", "#ff", "#1234567"])(
    "色スロットに16進以外の色表記 %s を書けない(限定6)",
    (value) => {
      const slots = { ...THEME_SLOTS_PASSING, "--color-text": value };
      expect(validateManifest(manifestWithTheme({ slots })).valid).toBe(false);
    },
  );

  test("色スロットが受ける形は #rgb / #rrggbb だけである(コントラスト検査が読める形と同一)", () => {
    for (const value of ["#000", "#000000", "#A0b1C2"]) {
      const slots = { ...THEME_SLOTS_PASSING, "--color-danger": value };
      // #A0b1C2 は白地に対して 4.5:1 を通らない可能性があるので、構造検証だけを見る。
      expect(validateManifest(manifestWithTheme({ slots })).valid).toBe(true);
    }
  });

  test("スロットの値は文字列であり、数値や真偽値を書けない(限定6)", () => {
    const slots = { ...THEME_SLOTS_PASSING, "--line-height-base": 1.6 } as Record<
      string,
      string | number
    >;
    expect(validateManifest(manifestWithTheme({ slots })).valid).toBe(false);
  });
});

describe("V3-M1-T03: 由来(origin。ADR-0047 §1b / 限定7)", () => {
  test("由来が無いテーマも表せる(手で作ったテーマ)", () => {
    expect(validateManifest(manifestWithTheme({ slots: THEME_SLOTS_PASSING })).valid).toBe(true);
  });

  test("由来を持つテーマも表せる(版は _changelog の diff_id を使う)", () => {
    const theme = {
      slots: THEME_SLOTS_PASSING,
      origin: { template_app_id: "org-theme", template_diff_id: "d-0007" },
    };
    expect(validateManifest(manifestWithTheme(theme)).valid).toBe(true);
  });

  test("origin の未知キーは invalid(自己申告の器を勝手に広げられない)", () => {
    const theme = {
      slots: THEME_SLOTS_PASSING,
      origin: { template_app_id: "org-theme", template_seq: 3 },
    };
    expect(validateManifest(manifestWithTheme(theme)).valid).toBe(false);
  });

  test("カーネルが origin の真偽を検証しないことがスキーマの $comment に書かれている(憲法6)", () => {
    const origin = (canonicalManifestSchema().$defs.app as Any).properties.theme.properties
      .origin as Any;
    expect(origin.$comment).toContain("カーネルは origin の真偽を検証しない");
  });

  test("実在しないアプリを指す origin でも valid である(限定7。参照整合性検査の対象外)", () => {
    const theme = {
      slots: THEME_SLOTS_PASSING,
      origin: { template_app_id: "does-not-exist", template_diff_id: "d-9999" },
    };
    expect(validateManifestFull(manifestWithTheme(theme))).toEqual({ valid: true });
  });
});

describe("V3-M1-T03: コントラスト検査の結線(ADR-0047 限定8 / 完了条件7)", () => {
  /** 前景だけを白にしたテーマ(白地に白文字)。**全スロット必須なので背景も必ず在る。** */
  const unreadable = () => ({
    slots: { ...THEME_SLOTS_PASSING, "--color-text": "#ffffff" },
  });

  test("閾値未満のテーマは incoming で拒否される", () => {
    const errors = expectInvalid(validateManifestFull(manifestWithTheme(unreadable())));
    expect(errors.some((e) => e.path === "/app/theme/slots/--color-text")).toBe(true);
    expect(errors.some((e) => e.message.includes("4.5:1"))).toBe(true);
  });

  test("同じマニフェストは stored として読める(過去の undo を壊さない)", () => {
    // **この非対称が限定8 の実体である** —— `readCurrentManifest` / `readSnapshotManifest`
    // に掛けると、閾値を後から厳しくした日に既存アプリのマニフェストが読めなくなる
    // (`src/kernel/validate.ts:74`〜`:77` の明文)。
    expect(validateManifestFull(manifestWithTheme(unreadable()), "stored")).toEqual({
      valid: true,
    });
  });

  test("構造検証を通らないテーマではコントラスト検査まで進まない(順序)", () => {
    // スロットが欠けている = 構造エラー。ここでコントラストのエラーを混ぜない
    // (LLM にはまず構造から直させる。既存の「構造 → 参照整合性」と同じ作法)。
    const missing = { ...THEME_SLOTS_PASSING } as Record<string, string>;
    missing["--color-text"] = "#ffffff";
    delete missing["--space-1"];
    const errors = expectInvalid(validateManifestFull(manifestWithTheme({ slots: missing })));
    expect(errors.every((e) => !e.message.includes("コントラスト比"))).toBe(true);
  });

  test("閾値を満たすテーマは incoming でも通る", () => {
    expect(validateManifestFull(manifestWithTheme({ slots: THEME_SLOTS_PASSING }))).toEqual({
      valid: true,
    });
  });
});

describe("V3-M1-T03: 差分操作 set_theme(ADR-0047 限定3)", () => {
  const themeDiff = (theme: unknown) => ({
    diff_id: "d-theme-1",
    intent: "アプリの見た目を指定する",
    operations: [{ op: "set_theme", theme }],
  });

  test("set_theme は語彙内である(16種目)", () => {
    expect([...DIFF_OPS] as string[]).toContain("set_theme");
    // **【`V8-M16` / `J-G1b` / `D-V8-31`】期待値を 17 → 18 に書き換えた —— 18種目 `set_roles` を足したため。検査は消していない。**
    // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】**
    // **旧(逐語)**: `expect(DIFF_OPS.length).toBe(18);`
    // **`set_user_kinds` を撤去したので 18 → 17。**`set_theme` が語彙内であることは1バイトも変わっていない。
    expect(DIFF_OPS.length).toBe(17); // 【`V5-M17b` / `ADR-0248`】16 → 17(`set_user_kinds` が17種目)。**この行が固定していたのは「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**
  });

  test("全スロットを持つテーマの set_theme は valid", () => {
    expect(validateDiff(themeDiff({ slots: THEME_SLOTS_PASSING }))).toEqual({ valid: true });
  });

  test("スロットが欠けた set_theme は差分の時点で拒否される(部分テーマを作らない)", () => {
    const missing = { ...THEME_SLOTS_PASSING } as Record<string, string>;
    delete missing["--space-6"];
    expect(validateDiff(themeDiff({ slots: missing })).valid).toBe(false);
  });

  test("set_theme の分岐は theme だけを必須にし、他の7キーを禁止する", () => {
    const operation = canonicalSchema("diff.schema.json").$defs.operation as Any;
    const branch = (operation.allOf as Any[]).find(
      (each) => each.if.properties.op.const === "set_theme",
    );
    expect(branch.then.required).toEqual(["theme"]);
    for (const forbidden of ["table", "field", "view", "changes", "workflow", "function"]) {
      expect(branch.then.properties[forbidden]).toBe(false);
    }
  });

  test("set_theme に table / view を混ぜると拒否される", () => {
    const diff = themeDiff({ slots: THEME_SLOTS_PASSING }) as Any;
    diff.operations[0].table = "books";
    expect(validateDiff(diff).valid).toBe(false);
  });

  test("theme キーは set_theme 以外の全 op で禁止されている(8キー目の意味は1義)", () => {
    const operation = canonicalSchema("diff.schema.json").$defs.operation as Any;
    for (const branch of operation.allOf as Any[]) {
      const op = branch.if.properties.op.const as string;
      if (op === "set_theme") {
        continue;
      }
      expect(branch.then.properties.theme).toBe(false);
    }
  });
});

/**
 * **画面ごとの見せ方(プリセット。D-G4 / F-5レイアウト)**。V3-M2-T01。
 *
 * 限定の正は `docs/adr/0050-view-display-presets.md` §3(**有限12点**)+ §3a(越えてはならない
 * 線8項目)/ `docs/adr/0051-layout-ledger-f5.md` §3(5点)。審査記録は
 * `docs/plan/v3/records/v3-m2-gate-a-preset.md`。
 *
 * **ここで固定するもの**:
 *
 * - **限定1**: 足すキーは**7つだけ**で、**名前と enum の値を列挙して固定する。**
 * - **限定2**: `additionalProperties: false` と `required` を1バイトも変えない。
 * - **限定3**: `$defs/operation.properties` に9キー目を足さない(既存テストと重ねて確認)。
 * - **限定11**: **越えてはならない線を schema の形で守る** —— ピクセル座標・自由な CSS
 *   文字列・`position` / `z-index` 相当の値を**書けない形**にする。**拒否リストを作らない**
 *   (ADR-0013 限定13)—— 検査するのは「値域がすべて有限 enum であること」と
 *   「`additionalProperties: false` が閉じていること」であって、禁止文字の一覧ではない。
 */
describe("V3-M2-T01: 画面ごとのプリセット(ADR-0050 / D-G4)", () => {
  /**
   * **限定1 の列挙固定**。キー名 → その値域の全量。**ここに8つ目を足す提案は ADR-0050
   * §3a 3 の門を通すこと**(「なぜ7キーでは足りないのか」「その値に当たり先の CSS 規則が
   * 実在するか」に答える必要がある)。
   */
  const PRESET_ENUMS: Record<string, unknown[]> = {
    preset_column_align: ["left", "center", "right"],
    preset_column_width: ["narrow", "standard", "wide"],
    preset_pager_position: ["top", "bottom", "both"],
    preset_label_placement: ["inline", "stacked"],
    preset_field_columns: [1, 2],
    preset_image_size: ["thumbnail", "medium", "original"],
    // **【V4-M10-T36 / `E-G13` / ADR-0085 限定1】** 軸7 の値域が 3 → 4 になった
    // (4値目 `full` = 切らない)。**8つ目の軸は1つも増えていない**(`ADR-0050` 限定1 の
    // 前半は無傷)—— **増えたのは1軸の選択肢だけで、総数は 19 → 20 である。**
    preset_text_preview: ["short", "standard", "long", "full"],
    // **【V4-M16-T13 / `P-G24` の (C) 側 / ADR-0093 限定1 / 限定3】8つ目の軸である。**
    // **門A の本審査(`V4-M14` 本審査② の単位11。判定 = 限定採用 / 審査記録 =
    // `docs/plan/v4/records/v4-m14-gate-a-list-shape.md` / ADR =
    // `docs/adr/0093-list-view-shape.md`)を通った増分である。**
    // **`ADR-0050` 限定1 の前半(7キー)は今日から偽であり、引き直したのは `ADR-0093` の側。**
    // **値域は2値だけで、3値目(グリッド / カンバン / カレンダー / タイムライン)を
    // 1つも置いていない。総数は 20 → 22 である。**
    preset_list_shape: ["table", "card"],
    // **【V4-M19-T03 / `P-G32` の (C) 側 / ADR-0118 限定1 / 限定3】9つ目の軸である。**
    // **門A の本審査(V4-M19 単位C。2回目の審査。判定 = 限定採用)を通った増分である。**
    // **`preset_list_shape` と違い、3種すべての画面に書ける**(限定6。当たり先の器が
    // list_view / form / detail_view のどれにも実在するため)。**値域は2値だけで、3値目
    // (自由な文字列・px・rem・割合・CSS 文字列)を1つも置いていない。**
    preset_density: ["comfortable", "compact"],
  };

  /** 列ごとのマップ(キーがフィールドID・値が enum)である2キー。 */
  const COLUMN_MAP_KEYS = ["preset_column_align", "preset_column_width"];

  /** 画面ごとの単一値である5キー。 */
  const SCALAR_KEYS = [
    "preset_pager_position",
    "preset_label_placement",
    "preset_field_columns",
    "preset_image_size",
    "preset_text_preview",
  ];

  const ALLOWED_BY_VIEW_TYPE: Record<string, string[]> = {
    list_view: [
      "preset_column_align",
      "preset_column_width",
      "preset_pager_position",
      "preset_image_size",
      "preset_text_preview",
      // **【V4-M16-T13 / `P-G24` の (C) 側 / ADR-0093 限定2】着手前は5軸だった。**
      // **`ADR-0093`(門A / 判定 = 限定採用)が8つ目の軸を `list_view` にだけ通した** ——
      // **form / detail_view の分岐では今日も `false` である。**
      "preset_list_shape",
      // **【V4-M19-T03 / ADR-0118 限定1 / 限定6】9つ目の軸(画面の詰まり具合)は
      // **3種すべてに通る**(`custom_css` / `menu_listed` と同じ性質)。**本 ADR の増分ではない。**
      "preset_density",
    ],
    detail_view: [
      "preset_label_placement",
      "preset_field_columns",
      "preset_image_size",
      "preset_text_preview",
      // **【V4-M19-T03 / ADR-0118 限定1 / 限定6】9つ目の軸は3種すべてに通る。**
      "preset_density",
    ],
    // **【V4-M16-T11 / P-G29 / ADR-0091 限定3】着手前は `form: []` だった。**
    // **`ADR-0091`(門A / 判定 = 限定採用)が form 分岐の `false` を2つ外した** ——
    // **通したのは2軸だけで、残る5軸は form で今日も `false` である。**
    // **【V4-M19-T03 / ADR-0118 限定1 / 限定6 で3軸目を通した】** `preset_density`
    // (画面の詰まり具合)は**プリセットが1軸も当たらない form こそ当たり先の1つ**
    // として3種すべてに通した(限定6)。**本 ADR の増分ではない。**
    form: ["preset_label_placement", "preset_field_columns", "preset_density"],
  };

  /** その軸として妥当な最小の値(列マップはフィールドID 1件ぶん)。 */
  function sampleValue(key: string, fieldId = "title"): unknown {
    const values = PRESET_ENUMS[key] ?? [];
    return COLUMN_MAP_KEYS.includes(key) ? { [fieldId]: values[0] } : values[0];
  }

  function manifestWithView(view: Any): Any {
    return {
      app: {
        id: "book-tracker",
        name: "蔵書管理",
        tables: [
          {
            id: "books",
            name: "書籍",
            fields: [{ id: "title", name: "タイトル", type: "text" }],
          },
        ],
        views: [view],
      },
    };
  }

  function viewOf(type: string, extra: Any): Any {
    const base: Any = { id: "v1", type, table: "books", ...extra };
    if (type === "list_view") {
      base.columns = ["title"];
    }
    if (type === "form") {
      base.fields = ["title"];
    }
    return base;
  }

  function updateViewDiff(changes: Any): Any {
    return {
      diff_id: "d-0001",
      intent: "画面の見せ方を選ぶ",
      operations: [{ op: "update_view", view: "book-list", changes }],
    };
  }

  test("限定1: $defs/view に足したのは7キーちょうどで、名前が列挙どおりである", () => {
    const properties = canonicalManifestSchema().$defs.view.properties as Any;
    const presetKeys = Object.keys(properties).filter((key) => key.startsWith("preset_"));
    expect(presetKeys).toEqual(Object.keys(PRESET_ENUMS));
    // **【V4-M16-T13 / ADR-0093 限定1 で 7 → 8 に更新した】** 8つ目の `preset_` キーは
    // 門A の本審査(判定 = 限定採用)を通った増分である。**9つ目を足したら赤くなる。**
    // **【V4-M19-T03 / ADR-0118 限定1 で 8 → 9 に更新した】** 9つ目の `preset_` キー
    // `preset_density`(画面の詰まり具合)が門A を通って増えた(V4-M19 単位C。2回目の審査。
    // 判定 = 限定採用)。**3種すべてに書けるキーである。****本 ADR の増分ではない。**
    expect(presetKeys).toHaveLength(9);
  });

  test("限定1 / 限定11: 7キーの値域はすべて有限 enum であり、値の全量が列挙どおりである", () => {
    const properties = canonicalManifestSchema().$defs.view.properties as Any;
    for (const [key, values] of Object.entries(PRESET_ENUMS)) {
      const node = properties[key];
      // 列ごとのマップは「値の側」が enum、画面ごとの単一値はその場が enum。
      const valueNode = COLUMN_MAP_KEYS.includes(key) ? node.additionalProperties : node;
      expect(valueNode.enum, key).toEqual(values);
      // **自由な文字列も自由な数値も1つも受けない**(enum 以外の受理口が無い)。
      expect(valueNode.pattern, key).toBeUndefined();
      expect(valueNode.minimum, key).toBeUndefined();
      expect(valueNode.maximum, key).toBeUndefined();
    }
  });

  test("限定11: 列ごとのマップは既存の field_id パターンでキーを閉じ、未知の値を受ける口が無い", () => {
    const properties = canonicalManifestSchema().$defs.view.properties as Any;
    for (const key of COLUMN_MAP_KEYS) {
      const node = properties[key];
      expect(node.type, key).toBe("object");
      // **新しい $defs を作らず、既存の resource_id をそのまま指す**(F-1 / `name` の作法)。
      expect(node.propertyNames.$ref, key).toBe("#/$defs/resource_id");
      // 値の側は enum のオブジェクトであって `true` ではない(何でも受ける口を作らない)。
      expect(typeof node.additionalProperties, key).toBe("object");
    }
  });

  test("限定2: $defs/view の required と additionalProperties は1バイトも変わっていない", () => {
    const view = canonicalManifestSchema().$defs.view as Any;
    expect(view.required).toEqual(["id", "type", "table"]);
    expect(view.additionalProperties).toBe(false);
    // 7キーはいずれも任意 —— required には1つも入らない。
    for (const key of Object.keys(PRESET_ENUMS)) {
      expect(view.required).not.toContain(key);
    }
  });

  // **【`V5-M17b` / `ADR-0248`】** **旧テスト名の逐語は「限定3: $defs/operation.properties は8キーのままで、プリセット専用の op は無い」である。**
  // **測っていたのは「`V3-M2` がキーを足さなかったこと」であり、足したのは別の決定である。**
  // **プリセット専用の op が無いことは今日も真であり、そちらは1バイトも緩めていない。**
  // **【`V8-M16-T03` / `J-G1b` / `D-V8-31`】** **旧テスト名の逐語は「限定3: $defs/operation.properties は9キーで、プリセット専用の op は無い」である。**
  // **測っていたのは「`V3-M2` がキーを足さなかったこと」であり、足したのは別の決定である。**
  // **プリセット専用の op が無いことは今日も真であり、そちらは1バイトも緩めていない。**
  test("限定3: $defs/operation.properties は10キーで、プリセット専用の op は無い", () => {
    const operation = canonicalSchema("diff.schema.json").$defs.operation as Any;
    expect(Object.keys(operation.properties)).toEqual([
      "op",
      "table",
      "field",
      "view",
      "changes",
      "workflow",
      "function",
      // **【`V5-M17b` / `ADR-0248`】9キー目 `user_kinds` を足した。**
      "theme",
      // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a` / `T-G11`。判定値 = 廃止】**
      // **旧(逐語)**: `"user_kinds",` —— 器ごと撤去されたので期待値から1行外した(10 → 9)。
      // **テスト名の「10キー」は当時の逐語である**(テスト名は書き換えない)。
      // **【`V8-M16-T03` / `J-G1b`】10キー目 `roles` を足した。**
      "roles",
    ]);
    // 書き込みは既存の add_view / update_view だけ(DIFF_OPS は16のまま)。
    // **【`V8-M16`】期待値を 17 → 18 に書き換えた —— 18種目 `set_roles` を足したため。検査は消していない。**
    // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】**
    // **旧(逐語)**: `expect(DIFF_OPS).toHaveLength(18);` —— `set_user_kinds` を撤去したので 18 → 17。
    expect(DIFF_OPS).toHaveLength(17); // 【`V5-M17b` / `ADR-0248`】16 → 17(`set_user_kinds` が17種目)。**この行が固定していたのは「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**
    expect(DIFF_OPS.filter((op) => op.includes("preset"))).toEqual([]);
  });

  for (const [type, allowed] of Object.entries(ALLOWED_BY_VIEW_TYPE)) {
    test(`${type} が受理するプリセットは限定1 の割り当てどおりである(それ以外は invalid)`, () => {
      for (const key of Object.keys(PRESET_ENUMS)) {
        const manifest = manifestWithView(viewOf(type, { [key]: sampleValue(key) }));
        expect(validateManifest(manifest).valid, `${type} / ${key}`).toBe(allowed.includes(key));
      }
    });
  }

  /**
   * **【`V4-M16-T11` / `P-G29` / `ADR-0091` 限定3 で書き換えた】**
   *
   * **着手前の本テストは題「form には1キーも書けない(限定1 の割り当て。form の4軸は
   * 却下1 / 保留3 で別の門)」で、7キーすべてが `invalid` になることを見ていた。**
   * **`ADR-0091`(門A / 判定 = 限定採用)が2軸を form にも通したので、その形では
   * 実装と食い違う。****期待値を緩めたのではなく、通した2軸と通していない5軸を
   * 名指しで分けた** —— **5軸の側は着手前と1バイトも同じ判定である。**
   */
  // **【V4-M16-T13 / ADR-0093 限定2 で「残る5軸」が「残る6軸」になった】** 8つ目の軸
  // (一覧の器の形)も form には書けない。**`ADR-0091` が通した2軸は1バイトも動いていない。**
  // **【V4-M19-T03 / ADR-0118 限定1 / 限定6 で3軸目が通った】** `preset_density`
  // (画面の詰まり具合)が form にも書ける9つ目の軸として加わった。**「残る6軸」の中身は
  // 1バイトも変えていない** —— `preset_density` は元から「残る6軸」に居なかった
  // (`PRESET_ENUMS` に本 ADR で新規に加わった軸である)。**本 ADR の増分ではない。**
  test("form に書けるのは2軸だけで、残る6軸は今日も書けない(ADR-0091 限定3 / ADR-0093 限定2)", () => {
    for (const key of ["preset_label_placement", "preset_field_columns", "preset_density"]) {
      const manifest = manifestWithView(viewOf("form", { [key]: sampleValue(key) }));
      expect(validateManifest(manifest).valid, key).toBe(true);
    }
    for (const key of Object.keys(PRESET_ENUMS).filter(
      (key) =>
        key !== "preset_label_placement" &&
        key !== "preset_field_columns" &&
        key !== "preset_density",
    )) {
      const manifest = manifestWithView(viewOf("form", { [key]: sampleValue(key) }));
      expect(validateManifest(manifest).valid, key).toBe(false);
    }
  });

  describe("越えてはならない線(限定11。拒否リストではなく enum + additionalProperties:false で閉じる)", () => {
    /**
     * **ADR-0050 §3a 5 が門にしたもの**を、実際に書こうとして拒否されることで示す。
     * **禁止文字の一覧を実装に持たせていない** —— 落ちる理由はすべて
     * 「enum の要素ではない」か「未知のプロパティである」のどちらかである。
     */
    const forbiddenValues: [string, unknown][] = [
      ["ピクセル座標(文字列)", "10px"],
      ["ピクセル座標(数値)", 10],
      ["自由な CSS 宣言", "width: 120px; position: absolute"],
      ["position 相当", "absolute"],
      ["z-index 相当", 999],
      ["割合", "50%"],
      ["enum の外の段階値", "extra-wide"],
      ["空文字列", ""],
    ];

    for (const [label, value] of forbiddenValues) {
      test(`${label} は list_view の preset_column_width に書けない`, () => {
        const manifest = manifestWithView(
          viewOf("list_view", { preset_column_width: { title: value } }),
        );
        expect(validateManifest(manifest).valid).toBe(false);
      });

      test(`${label} は list_view の preset_pager_position に書けない`, () => {
        const manifest = manifestWithView(viewOf("list_view", { preset_pager_position: value }));
        expect(validateManifest(manifest).valid).toBe(false);
      });
    }

    test("段組数は 1 と 2 だけで、3段組も 0 も小数も書けない", () => {
      for (const value of [0, 3, 4, 1.5, "2"]) {
        const manifest = manifestWithView(viewOf("detail_view", { preset_field_columns: value }));
        expect(validateManifest(manifest).valid, String(value)).toBe(false);
      }
      expect(
        validateManifest(manifestWithView(viewOf("detail_view", { preset_field_columns: 2 })))
          .valid,
      ).toBe(true);
    });

    test("8つ目のプリセットキーは書けない(additionalProperties:false が閉じている)", () => {
      const manifest = manifestWithView(
        viewOf("list_view", { preset_row_height: "tall", preset_css: ".x { color: red }" }),
      );
      expect(validateManifest(manifest).valid).toBe(false);
    });

    test("列マップのキーはフィールドIDの形に閉じており、CSS セレクタは書けない", () => {
      for (const key of ["td.title", "*", "#main", "Title", ".list-table td"]) {
        const manifest = manifestWithView(
          viewOf("list_view", { preset_column_align: { [key]: "left" } }),
        );
        expect(validateManifest(manifest).valid, key).toBe(false);
      }
    });

    test("任意 CSS 文字列を受ける口はスキーマのどこにも無い(値域が enum ではない preset キーが0件)", () => {
      const properties = canonicalManifestSchema().$defs.view.properties as Any;
      for (const key of Object.keys(properties).filter((k) => k.startsWith("preset_"))) {
        const node = properties[key];
        const valueNode = node.type === "object" ? node.additionalProperties : node;
        expect(Array.isArray(valueNode.enum), key).toBe(true);
      }
    });
  });

  describe("差分側($defs/view_changes)も同じ形で閉じている", () => {
    test("view_changes の7キーは manifest 側の定義をそのまま $ref する(定義を二重に持たない)", () => {
      const changes = canonicalSchema("diff.schema.json").$defs.view_changes as Any;
      expect(changes.additionalProperties).toBe(false);
      for (const key of Object.keys(PRESET_ENUMS)) {
        expect(changes.properties[key].$ref, key).toBe(
          `https://smailtalk.dev/schemas/manifest.schema.json#/$defs/view/properties/${key}`,
        );
      }
    });

    test("update_view でプリセットを差し替える差分は valid である", () => {
      for (const key of SCALAR_KEYS) {
        expect(validateDiff(updateViewDiff({ [key]: sampleValue(key) })).valid, key).toBe(true);
      }
      for (const key of COLUMN_MAP_KEYS) {
        expect(validateDiff(updateViewDiff({ [key]: sampleValue(key) })).valid, key).toBe(true);
      }
    });

    test("update_view でも越えてはならない線が守られる(px / 自由 CSS / enum 外)", () => {
      for (const value of ["10px", "width: 120px", "absolute", "extra-wide", 999]) {
        expect(
          validateDiff(updateViewDiff({ preset_column_width: { title: value } })).valid,
          String(value),
        ).toBe(false);
        expect(
          validateDiff(updateViewDiff({ preset_image_size: value })).valid,
          String(value),
        ).toBe(false);
      }
      expect(validateDiff(updateViewDiff({ preset_css: ".x{}" })).valid).toBe(false);
    });
  });

  test("プリセットを持たない既存マニフェストは valid のままである(限定表 #7: 7キーはすべて任意)", () => {
    expect(validateManifest(bookTrackerManifest)).toEqual({ valid: true });
    expect(validateManifestFull(bookTrackerManifest)).toEqual({ valid: true });
    expect(validateManifestFull(bookTrackerManifest, "stored")).toEqual({ valid: true });
  });

  test("限定表 #5: $defs/theme のスロット数は25のままで、1つも増減していない", () => {
    const theme = canonicalManifestSchema().$defs.theme as Any;
    expect(Object.keys(theme.properties)).toHaveLength(25);
    expect(theme.required).toHaveLength(25);
  });
});

// ---------------------------------------------------------------------------
// V3-M5-T02 逃げ道(D-G5)の参照キー(ADR-0055 限定1 / 限定2 / 限定3)
// ---------------------------------------------------------------------------

describe("V3-M5-T02: $defs/view の逃げ道の参照キー(ADR-0055)", () => {
  /** 逃げ道の参照を持つ view を1つだけ差し替えたマニフェストを作る。 */
  function withCustomCss(viewIndex: number, value: unknown): Any {
    const manifest = clone(bookTrackerManifest) as Any;
    manifest.app.views[viewIndex].custom_css = value;
    return manifest;
  }

  const DIGEST = "a".repeat(64);

  // **【V4-M3-T02 / `B-G1` / ADR-0070 限定1 による更新】** `audience` が門A を通って19キー目に
  // 加わったので件数を 18 → 19 にした。**このテストが守る主張(逃げ道に相当するキーは1つだけ)
  // は1ミリも緩んでいない** —— 下の正規表現による絞り込み(`css|style|escape|hatch`)は
  // 1バイトも変えておらず、`audience` はそのどれにも当たらない。
  // **【V4-M10-T45 / `E-G12` / ADR-0084 限定1 による更新】** `menu_listed` が門A(再審査 B8)
  // を通って20キー目に加わったので件数を 19 → 20 にした。**このテストが守る主張(逃げ道に
  // 相当するキーは1つだけ)は1ミリも緩んでいない** —— 正規表現(`css|style|escape|hatch`)は
  // 1バイトも変えておらず、`menu_listed` はそのどれにも当たらない。
  // **【V4-M16-T12 / `P-G17` の (C) 側 / ADR-0092 限定1 による更新】** `field_groups` が門A
  // (`V4-M14` 本審査② の単位9)を通って21キー目に加わったので件数を 20 → 21 にした。
  // **このテストが守る主張(逃げ道に相当するキーは1つだけ)は1ミリも緩んでいない** ——
  // 正規表現(`css|style|escape|hatch`)は1バイトも変えておらず、**`field_groups` はその
  // どれにも当たらない**(`ADR-0092` は CSS のバイト列を受ける口を1つも作っていない)。
  test("限定1: $defs/view のキーは21で、逃げ道に相当するのは custom_css の1つだけである", () => {
    const properties = Object.keys(canonicalManifestSchema().$defs.view.properties);
    // **【V4-M16-T13 / ADR-0093 限定1 で 21 → 22 に更新した】** 門A の本審査(`V4-M14` 本審査② の単位11。判定 = 限定採用)が22キー目 `preset_list_shape`(一覧の器の形)を足した。
    // **【V4-M18-T03 / ADR-0095 限定1 で 22 → 23 に更新した】** 門A の本審査(V4-M18 単位3。
    // 判定 = 限定採用)が23キー目 `modal`(重ねて出す宣言)を足した。**逃げ道に相当する
    // キーではない** —— `modal` は真偽値1つで、CSS の本文を1バイトも運ばない。
    // **【V4-M22-T01 / ADR-0112 限定1 で 23 → 24 に更新した】** 24キー目 `search_fields`
    // (検索の対象にする列)を足した。**逃げ道に相当するキーではない** —— `search_fields` は
    // 列名の配列で、CSS の本文を1バイトも運ばない。
    // **【V4-M22-T05 / ADR-0113 限定1 で 24 → 25 に更新した】** 25キー目 `page_size`
    // (1ページに出す件数)を足した。**逃げ道に相当するキーではない** —— `page_size` は
    // 10/20/50/100 の段階値1つで、CSS の本文を1バイトも運ばない。
    // **【V4-M19-T03 / ADR-0118 限定1 で 25 → 26 に更新した】** 26キー目 `preset_density`
    // (画面の詰まり具合)を足した。**逃げ道に相当するキーではない** —— `preset_density` は
    // 2値の enum で、CSS の本文を1バイトも運ばない。**本 ADR の増分ではない。**
    // **【V4-M20-T04 / ADR-0102 限定1 で 26 → 27 に更新した】** 27キー目 `after_save`
    // (保存が成立したあとに行く画面のID)を足した。**逃げ道に相当するキーではない** ——
    // `after_save` は既存の `resource_id` を指すビューID1つで、CSS の本文を1バイトも
    // 運ばない。**本 ADR の増分ではない。**
    // **【V4-M23-T01 / ADR-0104 限定採用で 27 → 28 に更新した】** 28キー目 `sum_field`
    // (合計を出す列。`list_view` でだけ書ける)を足した。**逃げ道に相当するキーではない**
    // —— `sum_field` は既存の `resource_id` を指す number 型フィールドID1つで、CSS の本文を
    // 1バイトも運ばない。**本 ADR の増分ではない。**
    // **【`V6-M2-T01` / `K-G2` / `ADR-0289` 限定1 で 28 → 29 に更新した】** 29キー目 `reference_pickers`
    // (参照項目の選び方の、入力画面ごとの上書き)が門A を通って増えた(`V6-M0` 単位A。判定 = 限定採用)。
    // **`form` 型のビューでだけ書ける。****本 ADR の増分ではない。**
    // **【`V8-M20-T01` / 台帳 `J-G27` / 手続きは `ADR-0301` で 29 → 28 に更新した】**
    // 19キー目だった `audience`(この画面を見せる相手)が**廃止された**(判定 = 廃止)。
    // **旧値の逐語は 29。****このテストが守る主張(逃げ道に相当するキーは1つだけ)は
    // 1ミリも緩んでいない** —— 正規表現(`css|style|escape|hatch`)は1バイトも変えて
    // おらず、消えたキーはそのどれにも当たらない。**このリポジトリで語彙が減ったのは
    // これが初めてであり、この行が増分ではなく減分を記録した最初の行である。**
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 28 → 29 へ書き換えた。**
    // **旧行の逐語**: `expect(properties).toHaveLength(28);`
    // **書き換えた理由**: この行が固定していたのは「**その決定**が `$defs/view.properties` の本数 を増やさなかったこと」であり、
    // **29本目を足したのは別の決定である**(`V8-M8` が 集計表の宣言 `report` を29キー目として足した)。**検査は消していない。**
    // **【2026-08-20。`V10-M1-T02`。台帳 `NV-G4`。ADR = `0359`】期待値を 29 → 30 へ書き換えた。**
    // **旧行の逐語**: `expect(properties).toHaveLength(29);`
    // **30本目を足したのは別の決定である**(`ADR-0359` の `after_delete`)。
    // **逃げ道に相当するのが `custom_css` の1つだけであることは今日も真である。**
    // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
    // **期待値を 30 → 31 へ書き換えた。****旧行の逐語**: `expect(properties).toHaveLength(30);`
    // **31本目を足したのは別の決定である**(`ADR-0359` §4b 限定1 が一続きの流れの中の段
    // `flow` を**末尾に**31キー目として足した。**`list_view` / `form` / `detail_view` の3種別で
    // 書け、集計表(`report_view`)には書けない**)。
    // **本ファイルが測っている決定の増分ではない。****検査は消していない。**
    expect(properties).toHaveLength(31);
    expect(properties).toContain("custom_css");
    // **2つ目を足していない**(逃げ道に相当するキーは1つだけ)。
    expect(properties.filter((key) => /css|style|escape|hatch/.test(key))).toEqual(["custom_css"]);
  });

  test("限定1: $defs/app にも $defs/theme にも逃げ道のキーを足していない", () => {
    const schema = canonicalManifestSchema();
    // **【`V5-M17-T02` の追随】7 → 8**(`ADR-0158` 限定8 が `user_kinds` を足した)。
    // **`ADR-0055` 限定1 が測りたいのは「逃げ道(CSS)のキーが増えていないこと」であり、
    // それを測っているのは下の `/css/` の絞り込みである。****本行が固定していたのは
    // 「`ADR-0055` 以後、誰も `$defs/app` を触っていないこと」である。**
    // **【`V8-M16-T02` / `J-G1b` / `D-V8-31`】期待値を 8 → 9 に書き換えた —— 9本目 `roles` を足したため。**
    // **`ADR-0055` 限定1 が測りたい「逃げ道(CSS)のキーが増えていないこと」は下の `/css/` の絞り込みが今日も測る。検査は消していない。**
    // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】**
    // **旧(逐語)**: `expect(Object.keys(schema.$defs.app.properties)).toHaveLength(9);`
    // **`app.user_kinds` の器を撤去したので 9 → 8。**
    // **`ADR-0055` 限定1 が測りたい「逃げ道(CSS)のキーが増えていないこと」は下の `/css/` の絞り込みが今日も測る。検査は消していない。**
    expect(Object.keys(schema.$defs.app.properties)).toHaveLength(8);
    expect(Object.keys(schema.$defs.app.properties).filter((k: string) => /css/.test(k))).toEqual(
      [],
    );
    expect(Object.keys(schema.$defs.theme.properties)).toHaveLength(25);
    expect(Object.keys(schema.$defs.theme.properties).filter((k: string) => /css/.test(k))).toEqual(
      [],
    );
  });

  test("限定2: 形は2要素(asset / digest)で閉じており、3つ目のキーを書けない", () => {
    const property = canonicalManifestSchema().$defs.view.properties.custom_css as Any;
    expect(property.type).toBe("object");
    expect(Object.keys(property.properties)).toEqual(["asset", "digest"]);
    expect(property.required).toEqual(["asset", "digest"]);
    expect(property.additionalProperties).toBe(false);
    // 資産名は既存の resource_id を $ref する(新しい $defs を作らない = F-1 name の作法)。
    expect(property.properties.asset.$ref).toBe("#/$defs/resource_id");
    // ダイジェストは sha256 の16進64文字以外を受けない。
    expect(property.properties.digest.pattern).toBe("^[0-9a-f]{64}$");
  });

  test("限定2: CSS のバイト列をマニフェストに1バイトも書けない(形で縛る)", () => {
    // 「長い文字列を拒否する」のではなく「文字列を書く場所が無い」形である。
    for (const bad of [
      ".x { color: red }",
      { asset: "brand", digest: DIGEST, css: ".x{}" },
      { asset: "brand", digest: DIGEST, style: "color:red" },
      { asset: "brand" },
      { digest: DIGEST },
      { asset: "brand", digest: "not-a-sha256" },
      { asset: "brand", digest: DIGEST.toUpperCase() },
      { asset: "Brand", digest: DIGEST },
      { asset: "", digest: DIGEST },
      null,
      42,
      [{ asset: "brand", digest: DIGEST }],
    ]) {
      expect(validateManifest(withCustomCss(0, bad)).valid, JSON.stringify(bad)).toBe(false);
    }
  });

  test("参照は3種のビューすべてに書ける(list_view / form / detail_view)", () => {
    // **allOf の3分岐のどれでも false にしていない** —— プリセット7キーが1軸も当たらない
    // form こそ逃げ道の当て先だからである(判断の記録は v3-m5-t02.md §3)。
    for (const index of [0, 1, 2]) {
      const manifest = withCustomCss(index, { asset: "brand", digest: DIGEST });
      expect(validateManifest(manifest), String(index)).toEqual({ valid: true });
      expect(validateManifestFull(manifest), String(index)).toEqual({ valid: true });
    }
    const branches = canonicalManifestSchema().$defs.view.allOf as Any[];
    for (const branch of branches) {
      expect(branch.then.properties.custom_css).toBeUndefined();
    }
  });

  test("参照を持たない既存マニフェストは valid のままである(任意キーである)", () => {
    expect(validateManifest(bookTrackerManifest)).toEqual({ valid: true });
    expect(validateManifestFull(bookTrackerManifest, "stored")).toEqual({ valid: true });
  });

  test("既に書かれた参照は stored でも読める(語彙を広げた変更なので遡って不正にならない)", () => {
    const manifest = withCustomCss(0, { asset: "brand", digest: DIGEST });
    expect(validateManifestFull(manifest, "stored")).toEqual({ valid: true });
  });

  // **【`V5-M29-T04` / `ADR-0250` 限定14 がテスト名を更新した】** 旧名(逐語)は
  // 「**限定3: RESOURCE_KINDS / FIELD_TYPES / DIFF_OPS は1要素も増えていない**」。
  // **`FIELD_TYPES` と `DIFF_OPS` の総量を測っていた2件を中央へ移したので、この test に
  // 残るのは `VIEW_TYPES` 3 と「逃げ道専用の op を作っていない」の2件である。**
  test("限定3: VIEW_TYPES は3種で、DIFF_OPS に css / escape / hatch の op を1つも足していない", () => {
    // 【`V5-M29-T04` / `ADR-0250` 限定11】ここにあった「限定3: RESOURCE_KINDS / FIELD_TYPES / DIFF_OPS は1要素も増えていない」の検査は
    //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
    //   `FIELD_TYPES:` で始まる行)。**総量ではなく名前と順序で見張る。**
    //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
    // 【`V5-M29-T04` / `ADR-0250` 限定11】ここにあった「限定3: RESOURCE_KINDS / FIELD_TYPES / DIFF_OPS は1要素も増えていない」の検査は
    //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
    //   `DIFF_OPS:` で始まる行)。**総量ではなく名前と順序で見張る。**
    //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 3 → 4 へ書き換えた。**
    // **旧行の逐語**: `expect(VIEW_TYPES).toHaveLength(3);`
    // **旧テスト名の逐語(名前は1バイトも書き換えていない)**:
    // 「**限定3: VIEW_TYPES は3種で、DIFF_OPS に css / escape / hatch の op を1つも足していない**」。
    // **書き換えた理由**: この検査が固定しているのは **`ADR-0055` / `ADR-0057`(逃げ道)の限定3**
    // であり、**その決定は今日も画面種別を1つも増やしていない。****4種目 `report_view` を
    // 足したのは、逃げ道とまったく無関係な別の決定である**(`V8-M8` の集計表)。
    // **すぐ下の行(逃げ道専用の op を1つも足していない)は1バイトも変えていない** ——
    // **本来の主張を1ミリも弱めていない。**
    expect(VIEW_TYPES).toHaveLength(4);
    expect([...DIFF_OPS].filter((op) => /css|escape|hatch/.test(op))).toEqual([]);
  });

  test("限定3: add_view は参照を運べる(新しい差分操作を作っていない)", () => {
    const diff = {
      diff_id: "d-escape-1",
      intent: "印刷用の体裁を owner が発行した逃げ道で当てる",
      operations: [
        {
          op: "add_view",
          view: {
            id: "book-print",
            type: "detail_view",
            table: "books",
            custom_css: { asset: "print-layout", digest: DIGEST },
          },
        },
      ],
    };
    expect(validateDiff(diff)).toEqual({ valid: true });
  });

  // **【V3-M5-T02 / 門A 差し戻し後の再開で意味を書き直した。消していない】**
  //
  // **旧テストは「今日は update_view が参照を運べない」を固定していた**(名前:「【今日の実測】
  // update_view は参照を運べない —— $defs/view_changes に custom_css が無い」)。**それは
  // 実装の欠落を固定するテストであり、門A が `view_changes` 12 → 13 を限定表の内側と判定した
  // 時点で主張ごと偽になった**(ADR-0055 **改訂1** / 索引 v3-m5-gate-a.md §6-1)。
  //
  // **「落ちたから消す」ではない。何を守る検査かを書き直した** ——
  // **守るのは「限定3 が名指しした2つの経路(add_view / update_view)の両方で参照が書けること」と、
  // 「消費側スキーマが提供側の定義を $ref していること(定義を二重に持たない)」である**
  // (改訂1 の禁止形そのもの)。**キー数の上限(13)もここで固定する。**
  // **【V4-M10-T45 / `E-G12` / ADR-0084 限定6 による更新】** `menu_listed` が14キー目に
  // 加わったので件数を 13 → 14 にした。**主張(形は manifest 側の $ref である)は1ミリも
  // 緩んでいない。**
  // **【V4-M16-T12 / ADR-0092 限定2 による更新】** `field_groups` が15キー目に加わったので
  // 件数を 14 → 15 にした。**主張(形は manifest 側の $ref である)は1ミリも緩んでいない。**
  test("限定3 + 改訂1: update_view も参照を運べる。view_changes は15キーで、形は manifest 側の $ref である", () => {
    const changes = canonicalSchema("diff.schema.json").$defs.view_changes as Any;
    // **【V4-M16-T13 / ADR-0093 限定2 で 15 → 16 に更新した】** `update_view` にも16キー目 `preset_list_shape` が加わった(値はカーネルが実際に運ぶ)。
    // **【V4-M18-T03 / ADR-0095 限定6 で 16 → 17 に更新した】** `update_view` にも17キー目
    // `modal` が加わった(値は `applyViewChanges` の `form` 分岐が実際に運ぶ)。
    // **【V4-M22-T01 / ADR-0112 限定2 で 17 → 18 に更新した】** `update_view` にも18キー目
    // `search_fields` が加わった(値は `applyViewChanges` の `list_view` 分岐が実際に運ぶ)。
    // **【V4-M22-T05 / ADR-0113 限定2 で 18 → 19 に更新した】** `update_view` にも19キー目
    // `page_size` が加わった(値は `applyViewChanges` の `list_view` 分岐が実際に運ぶ)。
    // **【V4-M19-T03 / ADR-0118 限定1 で 19 → 20 に更新した】** `update_view` にも20キー目
    // `preset_density` が加わった(値は `applyViewChanges` の当該分岐が実際に運ぶ)。
    // **本 ADR の増分ではない。**
    // **【V4-M20-T04 / ADR-0102 限定2 で 20 → 21 に更新した】** `update_view` にも21キー目
    // `after_save` が加わった(値は `applyViewChanges` の `form` 分岐が実際に運ぶ)。
    // **本 ADR の増分ではない。**
    // **【V4-M23-T01 / ADR-0104 限定採用で 21 → 22 に更新した】** `update_view` にも22キー目
    // `sum_field`(合計を出す列。`list_view` でだけ書ける)が加わった(値は `applyViewChanges`
    // の `list_view` 分岐が実際に運ぶ)。**本 ADR の増分ではない。**
    // **【`V6-M2-T02` / `K-G3` / `ADR-0289` 限定1 で 23 → 24 に更新した】** 24キー目 `reference_pickers`
    // (参照項目の選び方の、入力画面ごとの上書き。`form` でだけ書ける)が `update_view` にも加わった
    // (値は `applyViewChanges` の `form` 分岐が実際に運ぶ)。**本 ADR の増分ではない。**
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 24 → 25 へ書き換えた。**
    // **旧行の逐語**: `expect(Object.keys(changes.properties)).toHaveLength(24);`
    // **書き換えた理由**: この行が固定していたのは「**その決定**が `view_changes.properties` の本数 を増やさなかったこと」であり、
    // **25本目を足したのは別の決定である**(`V8-M8` が 集計表の宣言 `report` を25キー目として足した)。**検査は消していない。**
    // **【2026-08-20。`V10-M1-T02`。台帳 `NV-G4`。ADR = `0359` §Decision 2】期待値を
    // 25 → 26 へ書き換えた。****旧行の逐語**: `expect(Object.keys(changes.properties)).toHaveLength(25);`
    // **26本目を足したのは別の決定である**(`after_delete`)。**検査は消していない。**
    // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
    // **期待値を 26 → 27 へ書き換えた。****旧行の逐語**: `expect(Object.keys(changes.properties)).toHaveLength(26);`
    // **27本目を足したのは別の決定である**(`flow` を `view_changes` の末尾に足した。
    // `ADR-0359` §Decision 2)。**本ファイルが測っている決定の増分ではない。**
    // **検査は消していない。**
    expect(Object.keys(changes.properties)).toHaveLength(27);
    expect(Object.keys(changes.properties)).toContain("custom_css");
    // **定義を二重に持たない**(改訂1 の禁止形。先例は view_changes.properties.name)。
    expect(changes.properties.custom_css.$ref).toBe(
      "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/view/properties/custom_css",
    );
    expect(Object.keys(changes.properties.custom_css)).not.toContain("properties");
    // **$defs/operation.properties は8キーのままである**(9キー目を足していない。ADR-0047 限定11)。
    // **【`V5-M17b` / `ADR-0248`】8 → 9(`user_kinds` が9キー目)。**
    // **この行が固定していたのは「`V3-M5` がキーを足さなかったこと」であり、足したのは別の決定である。**
    // **【`V8-M16-T03` / `J-G1b` / `D-V8-31`】期待値を 9 → 10 に書き換えた —— 10キー目 `roles` を足したため。検査は消していない。**
    // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a` / `T-G11`。判定値 = 廃止】**
    // **旧(逐語)**: `expect(Object.keys(canonicalSchema("diff.schema.json").$defs.operation.properties)).toHaveLength(10);`
    // **`user_kinds` キーを撤去したので 10 → 9。「`V3-M5` がキーを足していない」ことは今日も真である。検査は消していない。**
    expect(
      Object.keys(canonicalSchema("diff.schema.json").$defs.operation.properties),
    ).toHaveLength(9);
    const diff = {
      diff_id: "d-escape-2",
      intent: "既存画面に逃げ道を当てたい",
      operations: [
        {
          op: "update_view",
          view: "book-detail",
          changes: { custom_css: { asset: "print-layout", digest: DIGEST } },
        },
      ],
    };
    expect(validateDiff(diff)).toEqual({ valid: true });
    // **形の縛りは manifest 側と同じである**($ref なので二重管理にならないことの実測)。
    for (const bad of [
      { asset: "print-layout" },
      { digest: DIGEST },
      { asset: "print-layout", digest: DIGEST, css: ".x{}" },
      { asset: "Print", digest: DIGEST },
      { asset: "print-layout", digest: "not-a-sha256" },
    ]) {
      expect(
        validateDiff({
          diff_id: "d-escape-2b",
          intent: "壊れた参照",
          operations: [{ op: "update_view", view: "book-detail", changes: { custom_css: bad } }],
        }).valid,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });
});
