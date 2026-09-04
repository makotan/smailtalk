import { describe, expect, test } from "bun:test";
import type { ValidationError, ValidationResult } from "./errors.ts";
import { validateReferentialIntegrity } from "./referential-integrity.ts";
import type { Manifest } from "./types.ts";
import { validateManifest, validateManifestFull } from "./validate.ts";

/**
 * 参照整合性バリデータ(V0-P1-T02)のテスト。
 *
 * 検証する5類型:
 * 1. view の table が実在するテーブルID
 * 2. list_view.columns / form.fields のフィールドIDが該当テーブルに実在
 * 3. reference 型の reference_table が実在するテーブルID
 * 4. sort.field / filter[].field が該当テーブルに実在
 * 5. ID重複禁止(テーブル・ビュー・同一テーブル内フィールド)
 */

/** handover.md 3.4 の蔵書管理サンプル(原文のまま)。 */
const bookTrackerManifest: Manifest = {
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

/** reference 型・filter を含むサンプル。 */
const libraryManifest: Manifest = {
  app: {
    id: "library",
    name: "図書館",
    tables: [
      {
        id: "authors",
        name: "著者",
        fields: [{ id: "name", name: "名前", type: "text", required: true }],
      },
      {
        id: "books",
        name: "書籍",
        fields: [
          { id: "title", name: "タイトル", type: "text", required: true },
          { id: "author", name: "著者", type: "reference", reference_table: "authors" },
          { id: "available", name: "貸出可", type: "boolean" },
          { id: "pages", name: "ページ数", type: "number" },
        ],
      },
    ],
    views: [
      {
        id: "book-list",
        type: "list_view",
        table: "books",
        columns: ["title", "author", "available"],
        sort: { field: "pages", order: "asc" },
        filter: [{ field: "available", equals: true }],
      },
      { id: "author-form", type: "form", table: "authors", fields: ["name"] },
    ],
  },
};

/** 失敗であることを確認しつつ errors を取り出す。 */
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

/** 配列要素を取り出す(noUncheckedIndexedAccess 下で `!` を使わないため)。 */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`fixture broken: no element at index ${index}`);
  }
  return item;
}

/** 指定パスのエラーを1件だけ取り出す。 */
function errorAt(errors: ValidationError[], path: string): ValidationError {
  const matched = errors.filter((error) => error.path === path);
  expect(matched).toHaveLength(1);
  const error = matched[0];
  if (error === undefined) {
    throw new Error(`no error at ${path}`);
  }
  return error;
}

describe("validateReferentialIntegrity / 正常系", () => {
  test("handover 3.4 の蔵書管理サンプルが通過する", () => {
    expect(validateReferentialIntegrity(bookTrackerManifest)).toEqual({ valid: true });
  });

  test("reference 型・filter を含むサンプルが通過する", () => {
    expect(validateReferentialIntegrity(libraryManifest)).toEqual({ valid: true });
  });

  test("IDは正規化されないので my-field と my_field は別IDとして共存できる", () => {
    const manifest: Manifest = {
      app: {
        id: "app",
        name: "アプリ",
        tables: [
          {
            id: "t",
            name: "テーブル",
            fields: [
              { id: "my-field", name: "A", type: "text" },
              { id: "my_field", name: "B", type: "text" },
            ],
          },
        ],
        views: [{ id: "v", type: "form", table: "t", fields: ["my-field", "my_field"] }],
      },
    };
    expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
  });
});

describe("類型1: view の table が実在しない", () => {
  test("存在しないテーブルを指すビューが、パス・理由・実在テーブル一覧付きで拒否される", () => {
    const manifest = clone(libraryManifest);
    at(manifest.app.views, 0).table = "bookz";

    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/views/0/table");
    expect(error.message).toContain("bookz");
    expect(error.message).toContain("存在しません");
    // ビューの参照先候補には、読み取り専用のシステムテーブルも含む(ADR-0006 §9)。
    expect(error.allowed_values).toEqual(["authors", "books", "_apps", "_changelog", "_ai_usage"]);
  });

  test("参照先テーブルが存在しないビューでは、カラム由来のエラーをカスケードさせない", () => {
    const manifest = clone(libraryManifest);
    at(manifest.app.views, 0).table = "bookz";

    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    expect(errors).toHaveLength(1);
    expect(at(errors, 0).path).toBe("/app/views/0/table");
  });
});

describe("類型2: columns / fields のフィールドIDが実在しない", () => {
  test("list_view.columns の不正なフィールドIDが、実在フィールド一覧付きで拒否される", () => {
    const manifest = clone(bookTrackerManifest);
    const view = manifest.app.views[0];
    if (view?.type !== "list_view") {
      throw new Error("fixture broken");
    }
    view.columns = ["title", "titel"];

    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/views/0/columns/1");
    expect(error.message).toContain("titel");
    expect(error.message).toContain("books");
    expect(error.allowed_values).toEqual(["title", "status", "finished_at"]);
  });

  test("form.fields の不正なフィールドIDが、実在フィールド一覧付きで拒否される", () => {
    const manifest = clone(bookTrackerManifest);
    const view = manifest.app.views[1];
    if (view?.type !== "form") {
      throw new Error("fixture broken");
    }
    view.fields = ["title", "author"];

    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/views/1/fields/1");
    expect(error.message).toContain("author");
    expect(error.allowed_values).toEqual(["title", "status", "finished_at"]);
  });

  /*
   * detail_view.fields も **書き込み時に**弾く(V1-M0-T09 の追補)。
   *
   * V1-M0-T09 本体は表示層(`DetailViewRenderer`)でだけ照合しており、不正なIDを含む
   * `add_view` は 201 で通り、詳細画面を開いた時点で初めてエラーになっていた
   * (記録 §6-1 の限界1)。list_view.columns / form.fields と非対称なので閉じる。
   * **エラー形式は上の2件と同じ `missingField` から出す**(独自の本文を作らない)。
   */
  test("detail_view.fields の不正なフィールドIDが、実在フィールド一覧付きで拒否される", () => {
    const manifest = clone(bookTrackerManifest);
    const view = manifest.app.views[2];
    if (view?.type !== "detail_view") {
      throw new Error("fixture broken");
    }
    view.fields = ["title", "titel"];

    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/views/2/fields/1");
    expect(error.message).toContain("titel");
    expect(error.message).toContain("books");
    expect(error.allowed_values).toEqual(["title", "status", "finished_at"]);
  });

  test("detail_view.fields のエラーは list_view.columns / form.fields と同じ形で出る", () => {
    const manifest = clone(bookTrackerManifest);
    const listView = manifest.app.views[0];
    const formView = manifest.app.views[1];
    const detailView = manifest.app.views[2];
    if (
      listView?.type !== "list_view" ||
      formView?.type !== "form" ||
      detailView?.type !== "detail_view"
    ) {
      throw new Error("fixture broken");
    }
    listView.columns = ["nope"];
    formView.fields = ["nope"];
    detailView.fields = ["nope"];

    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const columnsError = errorAt(errors, "/app/views/0/columns/0");
    const formError = errorAt(errors, "/app/views/1/fields/0");
    const detailError = errorAt(errors, "/app/views/2/fields/0");

    // path 以外の3点(message の骨格 / allowed_values / hint)が一致すること。
    // ラベル部分("表示列(columns)" 等)だけが違う。
    for (const error of [columnsError, formError, detailError]) {
      expect(error.message).toContain(
        `に指定されたフィールド "nope" はテーブル "books" に存在しません。`,
      );
      expect(error.allowed_values).toEqual(["title", "status", "finished_at"]);
    }
    expect(detailError.hint).toBe(formError.hint);
    expect(detailError.hint).toBe(columnsError.hint);
  });

  test("detail_view.fields が実在するフィールドを指していれば受理される", () => {
    const manifest = clone(bookTrackerManifest);
    const view = manifest.app.views[2];
    if (view?.type !== "detail_view") {
      throw new Error("fixture broken");
    }
    view.fields = ["status", "title"];

    expect(validateReferentialIntegrity(manifest).valid).toBe(true);
  });

  test("detail_view.fields の省略は従来どおり受理される(全項目表示)", () => {
    const manifest = clone(bookTrackerManifest);
    const view = manifest.app.views[2];
    if (view?.type !== "detail_view") {
      throw new Error("fixture broken");
    }
    expect(view.fields).toBeUndefined();
    expect(validateReferentialIntegrity(manifest).valid).toBe(true);
  });
});

describe("類型3: reference 型の reference_table が実在しない", () => {
  test("存在しないテーブルを参照する reference フィールドが拒否される", () => {
    const manifest = clone(libraryManifest);
    const field = manifest.app.tables[1]?.fields[1];
    if (field?.type !== "reference") {
      throw new Error("fixture broken");
    }
    field.reference_table = "writers";

    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/tables/1/fields/1/reference_table");
    expect(error.message).toContain("writers");
    expect(error.message).toContain("存在しません");
    expect(error.allowed_values).toEqual(["authors", "books"]);
  });
});

describe("類型4: sort.field / filter[].field が実在しない", () => {
  test("sort.field が該当テーブルに存在しない場合に拒否される", () => {
    const manifest = clone(bookTrackerManifest);
    const view = manifest.app.views[0];
    if (view?.type !== "list_view") {
      throw new Error("fixture broken");
    }
    view.sort = { field: "published_at", order: "desc" };

    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/views/0/sort/field");
    expect(error.message).toContain("published_at");
    expect(error.allowed_values).toEqual(["title", "status", "finished_at"]);
  });

  test("filter[].field が該当テーブルに存在しない場合に拒否される", () => {
    const manifest = clone(libraryManifest);
    const view = manifest.app.views[0];
    if (view?.type !== "list_view") {
      throw new Error("fixture broken");
    }
    view.filter = [
      { field: "available", equals: true },
      { field: "borrowed", equals: false },
    ];

    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/views/0/filter/1/field");
    expect(error.message).toContain("borrowed");
    expect(error.allowed_values).toEqual(["title", "author", "available", "pages"]);
  });
});

describe("関連レコードの動的表示 related の参照整合(EC-G17 / ADR-0044)", () => {
  /**
   * 親 orders(detail_view の対象)+ 子 lines(order 参照)。order-detail の related は
   * 「今開いている order を親に持つ lines の一覧」を表す。
   */
  function relatedManifest(related: unknown): Manifest {
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
              { id: "note", name: "備考", type: "text" },
              { id: "order", name: "注文", type: "reference", reference_table: "orders" },
            ],
          },
        ],
        views: [
          {
            id: "order-detail",
            type: "detail_view",
            table: "orders",
            related,
          } as unknown as Manifest["app"]["views"][number],
        ],
      },
    };
  }

  test("正しい related(via が子の reference で参照先が対象テーブル)は通過する", () => {
    const manifest = relatedManifest([
      {
        table: "lines",
        via: "order",
        columns: ["qty", "note"],
        sort: { field: "qty", order: "desc" },
      },
    ]);
    expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
  });

  test("related.table が実在しないと、実在テーブル候補付きで拒否される", () => {
    const manifest = relatedManifest([{ table: "ghost", via: "order", columns: ["qty"] }]);
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/views/0/related/0/table");
    expect(error.message).toContain("ghost");
    expect(error.allowed_values).toEqual(["orders", "lines"]);
  });

  test("related.via が子テーブルに存在しないと、reference フィールド候補付きで拒否される", () => {
    const manifest = relatedManifest([{ table: "lines", via: "nope", columns: ["qty"] }]);
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/views/0/related/0/via");
    expect(error.message).toContain("nope");
    expect(error.allowed_values).toEqual(["order"]);
  });

  test("related.via が reference 型でないと拒否される(単一の親参照の1ホップ・限定3)", () => {
    const manifest = relatedManifest([{ table: "lines", via: "qty", columns: ["qty"] }]);
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/views/0/related/0/via");
    expect(error.message).toContain("reference");
  });

  test("related.via の参照先が detail_view の対象テーブルと違うと拒否される", () => {
    // lines に「別テーブル shops を指す reference」を足し、それを via にする。
    const manifest = relatedManifest([{ table: "lines", via: "shop", columns: ["qty"] }]);
    manifest.app.tables.push({
      id: "shops",
      name: "店",
      fields: [{ id: "name", name: "名前", type: "text" }],
    });
    at(manifest.app.tables, 1).fields.push({
      id: "shop",
      name: "店",
      type: "reference",
      reference_table: "shops",
    });
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/views/0/related/0/via");
    // 参照先(shops)が対象テーブル(orders)と一致しないことを述べる。
    expect(error.message).toContain("orders");
  });

  test("related.columns の不在フィールドが、子テーブルのフィールド候補付きで拒否される", () => {
    const manifest = relatedManifest([{ table: "lines", via: "order", columns: ["qty", "bogus"] }]);
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/views/0/related/0/columns/1");
    expect(error.message).toContain("bogus");
    expect(error.allowed_values).toEqual(["qty", "note", "order"]);
  });

  test("related.sort.field の不在フィールドが拒否される", () => {
    const manifest = relatedManifest([
      { table: "lines", via: "order", columns: ["qty"], sort: { field: "bogus", order: "asc" } },
    ]);
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/views/0/related/0/sort/field");
    expect(error.message).toContain("bogus");
  });

  test("related 無しの detail_view は従来どおり通過する(後方互換)", () => {
    expect(validateReferentialIntegrity(bookTrackerManifest)).toEqual({ valid: true });
  });
});

describe("ビューからの操作起点 actions の参照整合(EC-G14 / ADR-0045)", () => {
  /**
   * 親 products(product-detail の対象)+ cart_lines(product 参照)。product-detail の
   * actions は「この商品をカートに入れる = product をプリフィルした cart_line-form へ遷移」。
   * prefill.field は遷移先 form(cart-form)の対象テーブル(cart_lines)上の reference で、
   * その参照先が detail_view の対象テーブル(products)であること、を検査する。
   */
  function actionsManifest(actions: unknown): Manifest {
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
          {
            id: "product-detail",
            type: "detail_view",
            table: "products",
            actions,
          } as unknown as Manifest["app"]["views"][number],
        ],
      },
    };
  }

  test("正しい actions(form が実在・prefill.field が form の対象テーブル上の対象テーブル参照)は通過する", () => {
    const manifest = actionsManifest([
      { form: "cart-form", prefill: { field: "product" }, name: "カートに入れる" },
    ]);
    expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
  });

  test("actions.form が実在しないと、form ビュー候補付きで拒否される", () => {
    const manifest = actionsManifest([{ form: "ghost", prefill: { field: "product" } }]);
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/views/1/actions/0/form");
    expect(error.message).toContain("ghost");
    expect(error.allowed_values).toEqual(["cart-form"]);
  });

  test("actions.form が form 型でない(list_view / detail_view を指す)と拒否される", () => {
    const manifest = actionsManifest([{ form: "product-detail", prefill: { field: "product" } }]);
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/views/1/actions/0/form");
    expect(error.message).toContain("form");
    expect(error.allowed_values).toEqual(["cart-form"]);
  });

  test("prefill.field が遷移先 form の対象テーブルに存在しないと、reference 候補付きで拒否される", () => {
    const manifest = actionsManifest([{ form: "cart-form", prefill: { field: "nope" } }]);
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/views/1/actions/0/prefill/field");
    expect(error.message).toContain("nope");
    expect(error.allowed_values).toEqual(["product"]);
  });

  test("prefill.field が reference 型でないと拒否される(プリフィル先は参照フィールドのみ)", () => {
    const manifest = actionsManifest([{ form: "cart-form", prefill: { field: "qty" } }]);
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/views/1/actions/0/prefill/field");
    expect(error.message).toContain("reference");
  });

  test("prefill.field の参照先が detail_view の対象テーブルと違うと拒否される(_id を入れる先の整合)", () => {
    // cart_lines に「別テーブル shops を指す reference」を足し、それを prefill.field にする。
    const manifest = actionsManifest([{ form: "cart-form", prefill: { field: "shop" } }]);
    manifest.app.tables.push({
      id: "shops",
      name: "店",
      fields: [{ id: "sname", name: "名前", type: "text" }],
    });
    at(manifest.app.tables, 1).fields.push({
      id: "shop",
      name: "店",
      type: "reference",
      reference_table: "shops",
    });
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/views/1/actions/0/prefill/field");
    // 参照先(shops)が対象テーブル(products)と一致しないことを述べる。
    expect(error.message).toContain("products");
  });

  test("actions 無しの detail_view は従来どおり通過する(後方互換)", () => {
    expect(validateReferentialIntegrity(bookTrackerManifest)).toEqual({ valid: true });
  });
});

describe("類型5: ID重複禁止", () => {
  test("テーブルIDの重複が2件目の出現箇所で拒否される", () => {
    const manifest = clone(libraryManifest);
    at(manifest.app.tables, 1).id = "authors";

    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/tables/1/id");
    expect(error.message).toContain("authors");
    expect(error.message).toContain("重複");
  });

  test("ビューIDの重複が2件目の出現箇所で拒否される", () => {
    const manifest = clone(libraryManifest);
    at(manifest.app.views, 1).id = "book-list";

    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/views/1/id");
    expect(error.message).toContain("book-list");
    expect(error.message).toContain("重複");
  });

  test("同一テーブル内のフィールドID重複が2件目の出現箇所で拒否される", () => {
    const manifest = clone(bookTrackerManifest);
    at(at(manifest.app.tables, 0).fields, 2).id = "title";

    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/tables/0/fields/2/id");
    expect(error.message).toContain("title");
    expect(error.message).toContain("重複");
  });

  test("別テーブルで同じフィールドIDを使うのは重複ではない", () => {
    expect(validateReferentialIntegrity(libraryManifest)).toEqual({ valid: true });
    const manifest = clone(libraryManifest);
    at(manifest.app.tables, 0).fields.push({ id: "title", name: "肩書", type: "text" });
    at(manifest.app.tables, 1).fields.push({ id: "name", name: "通称", type: "text" });
    expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
  });

  test("3回以上の重複では2件目・3件目の両方が指摘される", () => {
    const manifest = clone(bookTrackerManifest);
    at(at(manifest.app.tables, 0).fields, 1).id = "title";
    at(at(manifest.app.tables, 0).fields, 2).id = "title";

    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const paths = errors.map((error) => error.path);
    expect(paths).toContain("/app/tables/0/fields/1/id");
    expect(paths).toContain("/app/tables/0/fields/2/id");
  });
});

describe("allowed_values", () => {
  test("マニフェスト側にID重複があっても allowed_values には重複を載せない", () => {
    const manifest = clone(bookTrackerManifest);
    at(at(manifest.app.tables, 0).fields, 1).id = "title";
    const view = manifest.app.views[0];
    if (view?.type !== "list_view") {
      throw new Error("fixture broken");
    }
    view.columns = ["nope"];

    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/views/0/columns/0");
    expect(error.allowed_values).toEqual(["title", "finished_at"]);
  });
});

describe("エラーは全件返す", () => {
  test("複数の壊れ方を同時に含むマニフェストで、すべてのエラーが返る", () => {
    const manifest: Manifest = {
      app: {
        id: "broken",
        name: "壊れたアプリ",
        tables: [
          {
            id: "books",
            name: "書籍",
            fields: [
              { id: "title", name: "タイトル", type: "text" },
              { id: "title", name: "重複タイトル", type: "text" },
              { id: "author", name: "著者", type: "reference", reference_table: "writers" },
            ],
          },
          {
            id: "books",
            name: "書籍(重複)",
            fields: [{ id: "x", name: "X", type: "text" }],
          },
        ],
        views: [
          {
            id: "book-list",
            type: "list_view",
            table: "books",
            columns: ["title", "nope"],
            sort: { field: "missing", order: "asc" },
            filter: [{ field: "alsomissing", equals: 1 }],
          },
          { id: "book-list", type: "form", table: "ghost", fields: ["title"] },
        ],
      },
    };

    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const paths = errors.map((error) => error.path).sort();
    expect(paths).toEqual(
      [
        "/app/tables/0/fields/1/id",
        "/app/tables/0/fields/2/reference_table",
        "/app/tables/1/id",
        "/app/views/0/columns/1",
        "/app/views/0/filter/0/field",
        "/app/views/0/sort/field",
        "/app/views/1/id",
        "/app/views/1/table",
      ].sort(),
    );
    for (const error of errors) {
      expect(error.message.length).toBeGreaterThan(0);
    }
  });
});

describe("validateManifestFull", () => {
  test("構造・参照整合性ともに正しいマニフェストが通過する", () => {
    expect(validateManifestFull(bookTrackerManifest)).toEqual({ valid: true });
    expect(validateManifestFull(libraryManifest)).toEqual({ valid: true });
  });

  test("構造が壊れている場合は参照整合性エラーを含めず構造エラーのみ返す", () => {
    // type が語彙外 かつ view.table も存在しない。構造検証で落ちるので後者は報告されない。
    const input = {
      app: {
        id: "broken",
        name: "壊れたアプリ",
        tables: [{ id: "books", name: "書籍", fields: [{ id: "t", name: "T", type: "uuid" }] }],
        views: [{ id: "v", type: "detail_view", table: "ghost" }],
      },
    };

    const errors = expectInvalid(validateManifestFull(input));
    expect(errors.some((error) => error.path.startsWith("/app/tables/0/fields/0"))).toBe(true);
    expect(errors.some((error) => error.path === "/app/views/0/table")).toBe(false);
  });

  test("構造は正しいが参照が壊れている場合は参照整合性エラーを返す", () => {
    const manifest = clone(bookTrackerManifest);
    at(manifest.app.views, 2).table = "ghost";

    const errors = expectInvalid(validateManifestFull(manifest));
    const error = errorAt(errors, "/app/views/2/table");
    expect(error.allowed_values).toEqual(["books", "_apps", "_changelog", "_ai_usage"]);
  });
});

/**
 * システムテーブル(ADR-0006 §8 L2 / §9)。
 *
 * マップと `allowed_values` を対で2組に分ける決定を固定する。片方だけを直せない
 * 構造にすることが目的なので、**両方の組**を同じ観点で確かめる。
 */
describe("システムテーブル: ビュー参照(類型1)と reference(類型3)の非対称", () => {
  test("list_view が _apps を参照できる", () => {
    const manifest: Manifest = {
      app: {
        id: "platform-admin",
        name: "管理ツール",
        tables: [],
        views: [{ id: "app-list", type: "list_view", table: "_apps", columns: ["name", "status"] }],
      },
    };
    expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
  });

  test("detail_view が _changelog を参照できる", () => {
    const manifest: Manifest = {
      app: {
        id: "platform-admin",
        name: "管理ツール",
        tables: [],
        views: [{ id: "log-detail", type: "detail_view", table: "_changelog" }],
      },
    };
    expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
  });

  test("システムテーブルの columns / sort / filter は既存ロジックでそのまま検証される", () => {
    const manifest: Manifest = {
      app: {
        id: "platform-admin",
        name: "管理ツール",
        tables: [],
        views: [
          {
            id: "log-list",
            type: "list_view",
            table: "_changelog",
            columns: ["intent", "ghost"],
            sort: { field: "applied_at", order: "desc" },
            filter: [{ field: "app_id", equals: "book-tracker" }],
          },
        ],
      },
    };
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    expect(errors).toHaveLength(1);
    const error = errorAt(errors, "/app/views/0/columns/1");
    expect(error.allowed_values).toContain("intent");
  });

  test("L2: form がシステムテーブルを指すと拒否される", () => {
    const manifest: Manifest = {
      app: {
        id: "platform-admin",
        name: "管理ツール",
        tables: [
          { id: "notes", name: "メモ", fields: [{ id: "body", name: "本文", type: "long_text" }] },
        ],
        views: [{ id: "app-form", type: "form", table: "_apps", fields: ["name"] }],
      },
    };
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/views/0/table");
    expect(error.message).toContain("読み取り専用");
    expect(error.message).toContain("_apps");
    expect(error.message).not.toContain("存在しません");
    expect(error.hint ?? "").toContain("list_view");
    // form を作れるのはユーザ定義テーブルだけなので、候補にシステムテーブルは載せない。
    expect(error.allowed_values).toEqual(["notes"]);
  });

  test("L2: 拒否されたビューの fields で二重エラーをカスケードさせない", () => {
    const manifest: Manifest = {
      app: {
        id: "platform-admin",
        name: "管理ツール",
        tables: [],
        views: [{ id: "app-form", type: "form", table: "_apps", fields: ["ghost"] }],
      },
    };
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    expect(errors).toHaveLength(1);
    expect(at(errors, 0).path).toBe("/app/views/0/table");
  });

  test("裏口封じ: reference_table に _apps は指定できない(類型3)", () => {
    const manifest: Manifest = {
      app: {
        id: "platform-admin",
        name: "管理ツール",
        tables: [
          {
            id: "notes",
            name: "メモ",
            fields: [{ id: "app", name: "アプリ", type: "reference", reference_table: "_apps" }],
          },
        ],
        views: [],
      },
    };
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/tables/0/fields/0/reference_table");
    expect(error.message).toContain("存在しません");
    // エラーメッセージが裏口を宣伝しないこと(ADR-0006 §9)。
    expect(error.allowed_values).toEqual(["notes"]);
    expect(error.allowed_values).not.toContain("_apps");
    expect(error.allowed_values).not.toContain("_changelog");
  });

  test("類型1 の allowed_values にはシステムテーブルが載る(発見可能性)", () => {
    const manifest = clone(bookTrackerManifest);
    at(manifest.app.views, 0).table = "bookz";

    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/views/0/table");
    expect(error.allowed_values).toEqual(["books", "_apps", "_changelog", "_ai_usage"]);
  });
});

// ===========================================================================
// V3-M1-T03(段階A): テーマの由来は参照整合性検査の対象外である(ADR-0047 限定7)
//
// **カーネルは origin の真偽を検証しない**(自己申告。憲法6)。**検査対象にすると、
// テンプレート app を削除した日に既存アプリのマニフェストが読めなくなり、過去の undo が
// 壊れる**(この検査は purpose に関係なく呼ばれ、`stored` 読み取りにも掛かる)。
// **孤児は検出のみ・自動刈り取りなし**(ADR-0035 §4 と同型)。
// ===========================================================================

describe("テーマの由来(origin)は参照整合性の対象ではない(ADR-0047 限定7)", () => {
  /** コントラスト検査を通る25スロット(値は入力であって集合の正ではない)。 */
  const passingSlots: Record<string, string> = {
    "--color-danger": "#a00000",
    "--color-text": "#000000",
    "--color-text-label": "#595959",
    "--color-text-placeholder": "#595959",
    "--color-text-secondary": "#595959",
    "--color-border": "#767676",
    "--color-page-background": "#ffffff",
    "--color-surface-highlight": "#f2f2f2",
    "--font-family-base": "system-ui, sans-serif",
    "--font-size-note": "0.875rem",
    "--font-size-secondary": "0.85em",
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
    "--focus-outline-color": "#005fcc",
    "--focus-outline-width": "2px",
    "--detail-label-width": "8rem",
    "--login-max-width": "22rem",
  };

  test("実在しないアプリを指す origin でも valid である(限定7 の機械的固定)", () => {
    const manifest = clone(bookTrackerManifest);
    manifest.app.theme = {
      slots: passingSlots,
      origin: { template_app_id: "deleted-template", template_diff_id: "d-9999" },
    };
    expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
    // 構造 → 参照整合性 → コントラストの全経路でも通る(`incoming` / `stored` の両方)。
    expect(validateManifestFull(manifest)).toEqual({ valid: true });
    expect(validateManifestFull(manifest, "stored")).toEqual({ valid: true });
  });

  test("テーマはテーブル・フィールド・ビューを1つも参照しない(参照の不在を固定する)", () => {
    // **スロットの値は色・長さ・書体の文字列だけである** —— リソースIDを運ぶ経路が
    // 無いので、「テーマが指す先が消えた」という状態は origin 以外に存在しない。
    // ここが破れる(値にIDを書ける形にする)なら、参照整合性の対象にするかどうかの
    // 判断が新たに要る = ADR-0047 §3a の門である。
    const manifest = clone(bookTrackerManifest);
    manifest.app.theme = { slots: passingSlots };
    expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
    const ids = [
      ...manifest.app.tables.map((table) => table.id),
      ...manifest.app.views.map((view) => view.id),
    ];
    for (const value of Object.values(passingSlots)) {
      for (const id of ids) {
        expect(value).not.toContain(id);
      }
    }
  });
});

/**
 * **列ごとのプリセットのマップキーの参照整合**(V3-M2-T01 追加分。D-G4 / ADR-0050)。
 *
 * `preset_column_align` / `preset_column_width` は **キーがフィールドIDのマップ**である。
 * **スキーマはキーの「形」(`$defs/resource_id`)しか見ない** —— 形の正しい実在しないIDは
 * スキーマを通ってしまう。**`columns` 側は同じフィールドIDを類型2 が実在照合している**ので、
 * 検査しないと**同じ画面の中で片方だけ検査が無い**という非対称が残り、しかもそれは
 * 「黙って通って、黙って効かない」形になる(憲法6)。**だから拒否する。**
 *
 * ## 実在の基準は「テーブルに在ること」であって「`columns` に載っていること」ではない
 *
 * **既存の類型2 / 類型4 と一貫させた。** `sort.field` も `filter[].field` も
 * `related[].columns` も、照合先は**対象テーブルのフィールド一覧**であり、
 * **`columns` への掲載を要求している検査は1本も無い**(実測)。
 * `columns` 掲載を要求すると、この1軸だけが新しい規則を1つ増やすことになる。
 *
 * **代償(黙って通るものとして残る)**: **`columns` に載っていない列に寄せ・幅を書いても
 * 通る。当たり先が無いので効かない。**
 */
describe("列ごとのプリセットのマップキーの参照整合(D-G4 / ADR-0050。V3-M2-T01)", () => {
  /** `books`(title / status / finished_at)の list_view を1つだけ持つマニフェスト。 */
  function listOnly(): Manifest {
    const manifest = clone(bookTrackerManifest);
    manifest.app.views = [at(clone(bookTrackerManifest).app.views, 0)];
    return manifest;
  }

  function listView(manifest: Manifest) {
    const view = at(manifest.app.views, 0);
    if (view.type !== "list_view") {
      throw new Error("fixture broken");
    }
    return view;
  }

  test("実在するフィールドIDを指す寄せ・幅は通る", () => {
    const manifest = listOnly();
    const view = listView(manifest);
    view.preset_column_align = { title: "center", status: "right" };
    view.preset_column_width = { title: "wide" };
    expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
    expect(validateManifestFull(manifest)).toEqual({ valid: true });
  });

  test("preset_column_align の不在フィールドIDが、実在フィールド一覧付きで拒否される", () => {
    const manifest = listOnly();
    listView(manifest).preset_column_align = { title: "center", titel: "left" };

    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    // **path は RFC 6901 の JSON Pointer**。マップなので添字ではなくキーそのものを指す
    // (フィールドIDは `^[a-z][a-z0-9_-]*$` なので `/` も `~` も含まず、エスケープは要らない)。
    const error = errorAt(errors, "/app/views/0/preset_column_align/titel");
    expect(error.message).toContain("titel");
    expect(error.message).toContain("books");
    expect(error.message).toContain("存在しません");
    // **既存の参照切れエラーと同じ形**(message / allowed_values / hint)。
    expect(error.allowed_values).toEqual(["title", "status", "finished_at"]);
    expect(error.hint).toContain("add_field");
  });

  test("preset_column_width の不在フィールドIDも同じ形で拒否される", () => {
    const manifest = listOnly();
    listView(manifest).preset_column_width = { widht: "narrow" };

    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/views/0/preset_column_width/widht");
    expect(error.allowed_values).toEqual(["title", "status", "finished_at"]);
  });

  test("2軸に跨って壊れていてもエラーは全件返る(最初の1件で打ち切らない)", () => {
    const manifest = listOnly();
    const view = listView(manifest);
    view.preset_column_align = { aaa: "left", bbb: "right" };
    view.preset_column_width = { ccc: "wide" };

    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    expect(errors.map((error) => error.path).sort()).toEqual([
      "/app/views/0/preset_column_align/aaa",
      "/app/views/0/preset_column_align/bbb",
      "/app/views/0/preset_column_width/ccc",
    ]);
  });

  test("実在の基準はテーブルであり、columns への掲載は要求しない(類型2 / 類型4 と一貫)", () => {
    // **`sort.field` / `filter[].field` も `columns` 掲載を要求していない**(既存の実測)。
    // ここだけ厳しくすると、この1軸のためだけに新しい規則が1つ増える。
    const manifest = listOnly();
    const view = listView(manifest);
    expect(view.columns).toEqual(["title", "status"]);
    view.preset_column_align = { finished_at: "right" }; // columns に無いがテーブルには在る
    expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
  });

  test("参照先テーブルが存在しないビューでは、プリセット由来のエラーをカスケードさせない", () => {
    const manifest = listOnly();
    const view = listView(manifest);
    view.table = "bookz";
    view.preset_column_align = { titel: "left" };

    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    expect(errors).toHaveLength(1);
    expect(at(errors, 0).path).toBe("/app/views/0/table");
  });

  test("detail_view / form には掛からない(そもそもこの2キーを持てない)", () => {
    // スキーマの allOf が detail_view / form では preset_column_align / preset_column_width を
    // false にしているので、**構造として存在し得ない。** 検査側も list_view の分岐にしか無い。
    const manifest = clone(bookTrackerManifest);
    const detail = at(manifest.app.views, 2);
    const form = at(manifest.app.views, 1);
    expect(detail.type).toBe("detail_view");
    expect(form.type).toBe("form");
    // 型の上でも書けないので、意図的に構造を壊して「検査が走らない」ことだけを見る。
    (detail as unknown as Record<string, unknown>).preset_column_align = { titel: "left" };
    (form as unknown as Record<string, unknown>).preset_column_width = { titel: "wide" };
    // 参照整合性は1件も出ない(list_view の分岐にしか検査が無いことの機械的固定)。
    expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
    // 一方で構造検査(スキーマ)はこれを拒否する —— 二重の歯止め。
    expect(validateManifestFull(manifest).valid).toBe(false);
  });

  test("purpose の分岐を作っていない —— incoming でも stored でも同じ判定になる(columns と同じ)", () => {
    // **ADR-0047 限定8(コントラスト検査を incoming にだけ掛ける)を真似ない。**
    // 参照整合性は `validateReferentialIntegrity` が purpose を受け取らない設計であり、
    // `stored` 読み取りにも掛かる。**プリセットもそれに合わせる**(独自の分岐を作らない)。
    // 過去の manifest が後から読めなくなる心配が無いのは、**`remove_field` が
    // 「まだ画面から参照されている」状態では拒否される**からである(下の apply-diff 側の検査)。
    const broken = listOnly();
    listView(broken).preset_column_align = { titel: "left" };
    expect(validateManifestFull(broken, "incoming").valid).toBe(false);
    expect(validateManifestFull(broken, "stored").valid).toBe(false);

    // 比較対象: `columns` を壊した場合もまったく同じ挙動である(非対称が無いことの実測)。
    const brokenColumns = listOnly();
    listView(brokenColumns).columns = ["title", "titel"];
    expect(validateManifestFull(brokenColumns, "incoming").valid).toBe(false);
    expect(validateManifestFull(brokenColumns, "stored").valid).toBe(false);
  });
});

/*
 * **`V7-M1-T05` / `Z-G9`(規約から外れた宣言を適用時に拒否する)/ `Z-G8`(グループのネスト禁止)。**
 *
 * **外れたら差分全体を拒否する。警告に留めない。**
 *
 * **拒否項目は9項目である**(`v7-m0.md` §6 の台帳は「8項目」と書いている。**数え直したら
 * 9項目だった。** 内訳と、どれが台帳に無かったかは `docs/plan/v7/records/v7-m1.md` §2-5)。
 *
 * **【この検査が測らないもの。先に書く(憲法6)】** **判定(誰に何が見えるか)は1バイトも
 * 実装していない**(`V7-M3`)。**ここで測るのは「宣言が規約どおりか」だけである。**
 */

/** `v7-m0.md` §5-2 (a) の確定形を、蔵書アプリの表名で書いた**規約どおりの**マニフェスト。 */
const accessControlManifest: Manifest = {
  app: {
    id: "book-tracker",
    name: "蔵書管理",
    tables: [
      {
        id: "books",
        name: "書籍",
        fields: [
          { id: "title", name: "タイトル", type: "text" },
          { id: "parent", name: "親の本", type: "reference", reference_table: "books" },
        ],
        access_control: {
          enabled: true,
          permissions: [
            { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
            { id: "writer", name: "編集可", read: true, write: true, delete: false },
          ],
          creator_permission: "writer",
          grant: {
            table: "book_grant",
            target: "target",
            member: "member",
            group: "group",
            permission: "permission",
          },
          members: { table: "member", account: "account", group: "group" },
          groups: { table: "team" },
          inherit_from: ["parent"],
        },
      },
      { id: "team", name: "グループ", fields: [{ id: "title", name: "名前", type: "text" }] },
      {
        id: "member",
        name: "利用者",
        fields: [
          { id: "account", name: "ログイン", type: "text" },
          { id: "group", name: "グループ", type: "reference", reference_table: "team" },
        ],
      },
      {
        id: "book_grant",
        name: "本の付与",
        fields: [
          { id: "target", name: "本", type: "reference", reference_table: "books" },
          { id: "member", name: "利用者", type: "reference", reference_table: "member" },
          { id: "group", name: "グループ", type: "reference", reference_table: "team" },
          { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
        ],
      },
    ],
    views: [],
  },
} as unknown as Manifest;

/** 保護対象表(`books`)の宣言を触るための取り出し口。 */
function declarationOf(manifest: Manifest): Record<string, unknown> {
  const table = at(manifest.app.tables, 0) as unknown as Record<string, unknown>;
  return table.access_control as Record<string, unknown>;
}

/** その表の `fields` を触るための取り出し口。 */
function fieldsOf(manifest: Manifest, tableId: string): Record<string, unknown>[] {
  const table = manifest.app.tables.find((candidate) => candidate.id === tableId);
  if (table === undefined) {
    throw new Error(`fixture broken: no table ${tableId}`);
  }
  return table.fields as unknown as Record<string, unknown>[];
}

/** エラー文言に内部記号が漏れていないこと(発注の逐語)。 */
function expectUserFacing(error: ValidationError): void {
  for (const symbol of ["Z-G", "D-V7-", "access_control", "referential", "undefined"]) {
    expect(error.message.includes(symbol)).toBe(false);
  }
  expect(error.message.length).toBeGreaterThan(0);
}

describe("V7-M1-T05: アクセス権管理の宣言が規約から外れていたら差分全体を拒否する(Z-G9 / Z-G8)", () => {
  test("(0) 規約どおりの宣言は通る(オプトインの側を壊していない)", () => {
    expect(validateReferentialIntegrity(accessControlManifest)).toEqual({ valid: true });
    expect(validateManifestFull(accessControlManifest).valid).toBe(true);
  });

  test("(0b) 宣言していない表は1件も検査されない", () => {
    const manifest = clone(accessControlManifest);
    const table = at(manifest.app.tables, 0) as unknown as Record<string, unknown>;
    table.access_control = undefined;
    expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
  });

  // --- 項目1: 指した表が実在するか -------------------------------------------------
  test("(1a) 付与の表が実在しないと拒否される", () => {
    const manifest = clone(accessControlManifest);
    declarationOf(manifest).grant = { ...(declarationOf(manifest).grant as object), table: "nope" };
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/tables/0/access_control/grant/table");
    expect(error.message).toContain("見つかりません");
    expect(error.allowed_values).toContain("book_grant");
    expectUserFacing(error);
  });

  test("(1b) 利用者の表が実在しないと拒否される", () => {
    const manifest = clone(accessControlManifest);
    declarationOf(manifest).members = { table: "nope", account: "account" };
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    expectUserFacing(errorAt(errors, "/app/tables/0/access_control/members/table"));
  });

  test("(1c) グループの表が実在しないと拒否される", () => {
    const manifest = clone(accessControlManifest);
    declarationOf(manifest).groups = { table: "nope" };
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    expectUserFacing(errorAt(errors, "/app/tables/0/access_control/groups/table"));
  });

  // --- 項目2: 指した列が実在するか -------------------------------------------------
  test("(2a) 付与の表に、指した項目が無いと拒否される(4本すべて)", () => {
    for (const key of ["target", "member", "group", "permission"]) {
      const manifest = clone(accessControlManifest);
      (declarationOf(manifest).grant as Record<string, unknown>)[key] = "nope";
      const errors = expectInvalid(validateReferentialIntegrity(manifest));
      const error = errorAt(errors, `/app/tables/0/access_control/grant/${key}`);
      expect(error.message).toContain("ありません");
      expect(error.allowed_values).toContain("permission");
      expectUserFacing(error);
    }
  });

  test("(2b) 利用者の表に、指した項目が無いと拒否される(2本すべて)", () => {
    for (const key of ["account", "group"]) {
      const manifest = clone(accessControlManifest);
      (declarationOf(manifest).members as Record<string, unknown>)[key] = "nope";
      const errors = expectInvalid(validateReferentialIntegrity(manifest));
      expectUserFacing(errorAt(errors, `/app/tables/0/access_control/members/${key}`));
    }
  });

  // --- 項目3: 型が規約どおりか -----------------------------------------------------
  test("(3a) 対象の行を指す項目が reference でないと拒否される", () => {
    const manifest = clone(accessControlManifest);
    fieldsOf(manifest, "book_grant")[0] = { id: "target", name: "本", type: "text" };
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/tables/0/access_control/grant/target");
    expect(error.message).toContain("参照");
    expectUserFacing(error);
  });

  test("(3b) 対象の行を指す項目が、この表以外を参照していると拒否される", () => {
    const manifest = clone(accessControlManifest);
    fieldsOf(manifest, "book_grant")[0] = {
      id: "target",
      name: "本",
      type: "reference",
      reference_table: "member",
    };
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/tables/0/access_control/grant/target");
    expect(error.message).toContain("books");
    expectUserFacing(error);
  });

  test("(3c) 権限名の項目が select でないと拒否される", () => {
    const manifest = clone(accessControlManifest);
    fieldsOf(manifest, "book_grant")[3] = { id: "permission", name: "権限", type: "text" };
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/tables/0/access_control/grant/permission");
    expect(error.message).toContain("選択肢");
    expectUserFacing(error);
  });

  test("(3d) ログインアカウントの項目が text でないと拒否される", () => {
    const manifest = clone(accessControlManifest);
    fieldsOf(manifest, "member")[0] = { id: "account", name: "ログイン", type: "number" };
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    expectUserFacing(errorAt(errors, "/app/tables/0/access_control/members/account"));
  });

  test("(3e) 相手を指す項目が、利用者の表 / グループの表を参照していないと拒否される", () => {
    const manifest = clone(accessControlManifest);
    fieldsOf(manifest, "book_grant")[1] = {
      id: "member",
      name: "利用者",
      type: "reference",
      reference_table: "team",
    };
    fieldsOf(manifest, "member")[1] = {
      id: "group",
      name: "グループ",
      type: "reference",
      reference_table: "member",
    };
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    expectUserFacing(errorAt(errors, "/app/tables/0/access_control/grant/member"));
    expectUserFacing(errorAt(errors, "/app/tables/0/access_control/members/group"));
  });

  // --- 項目4: creator_permission が実在するか ---------------------------------------
  test("(4) 作成者に与える権限名が宣言に無いと拒否される", () => {
    const manifest = clone(accessControlManifest);
    declarationOf(manifest).creator_permission = "manager";
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/tables/0/access_control/creator_permission");
    expect(error.message).toContain("宣言されていません");
    expect(error.allowed_values).toEqual(["reader", "writer"]);
    expectUserFacing(error);
  });

  // --- 項目5: permissions[].id の重複 ------------------------------------------------
  test("(5) 権限名が重複していると拒否される(schema は止めない)", () => {
    const manifest = clone(accessControlManifest);
    declarationOf(manifest).permissions = [
      { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
      { id: "reader", name: "参照だけ", read: true, write: false, delete: false },
    ];
    declarationOf(manifest).creator_permission = "reader";
    // **schema は今日もこれを通す**(`V7-M1-T01` の記録の実測)。止めるのは本検査である。
    expect(validateManifest(manifest).valid).toBe(true);
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/tables/0/access_control/permissions/1/id");
    expect(error.message).toContain("重複");
    expectUserFacing(error);
  });

  // --- 項目6: inherit_from -----------------------------------------------------------
  test("(6a) 引き継ぎ元に、この表に無い項目を書くと拒否される", () => {
    const manifest = clone(accessControlManifest);
    declarationOf(manifest).inherit_from = ["nope"];
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    expectUserFacing(errorAt(errors, "/app/tables/0/access_control/inherit_from/0"));
  });

  test("(6b) 引き継ぎ元が reference でないと拒否される", () => {
    const manifest = clone(accessControlManifest);
    declarationOf(manifest).inherit_from = ["title"];
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/tables/0/access_control/inherit_from/0");
    expect(error.message).toContain("参照");
    expectUserFacing(error);
  });

  // --- 項目7: グループのネスト禁止(Z-G8)-------------------------------------------
  test("(7a) グループの表が、グループの表自身を参照する項目を持つと拒否される", () => {
    const manifest = clone(accessControlManifest);
    fieldsOf(manifest, "team").push({
      id: "parent_group",
      name: "親グループ",
      type: "reference",
      reference_table: "team",
    });
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = errorAt(errors, "/app/tables/1/fields/1/reference_table");
    expect(error.message).toContain("グループの中にグループ");
    expectUserFacing(error);
  });

  test("(7b) 利用者の表からグループの表を指すのは今日も通る(禁じるのはグループ→グループだけ)", () => {
    // **`members.group` はメンバー表 → グループ表なので許される**(発注の逐語)。
    expect(validateReferentialIntegrity(accessControlManifest)).toEqual({ valid: true });
  });

  // --- 項目8: 「書けるが効かない」を作らない同居の拒否 --------------------------------
  // 【`V8-M20-T01` / 台帳 `J-G30` / 手続きは `ADR-0301`。2026-08-10】ここにあった test を、
  //   ブロックごと消した。**消したのは「赤いから」ではなく、測る対象そのものが今日は
  //   1つも作れないからである。**
  //   消したテスト名(逐語): 「(8a) 運営者向けの公開設定の項目と同居すると拒否される」
  //   そのブロックが測っていたもの:
  //     - 予約規約フィールド `st_admin_readable` を持つ表で `access_control.enabled` を
  //       真にすると、「書けるが効かない」同居として差分全体が拒否される
  //       (`/app/tables/0/access_control/enabled` に「同時」を含むエラーが出る)
  //   **`st_admin_readable` は `V8-M20` が廃止した**(判定 = 廃止)。**予約規約フィールドは
  //   5本 → 4本(`st_owner` / `st_public` / `st_undeletable` / `st_no_direct_create`)。**
  //   **同居の拒否そのものは消えていない** —— **`st_public` について下の (8b) が今日も
  //   測っている。****拒否する通り数が 2 → 1 に減った。**
  //   **代わりに担うのは `app.roles[].rules` の「役割 × 対象(表)× 読取」である** ——
  //   **【正直に書く】代わりが立つ範囲は同じではない。** **旧キーは表に1本足すだけで
  //   運営に読ませる宣言だったが、面では規則を書いた時点でその対象が allow-list になる。**

  test("(8b) だれでも見られる公開設定の項目と同居すると拒否される", () => {
    const manifest = clone(accessControlManifest);
    fieldsOf(manifest, "books").push({ id: "st_public", name: "公開", type: "boolean" });
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    expectUserFacing(errorAt(errors, "/app/tables/0/access_control/enabled"));
  });

  test("(8c) enabled: false なら同居は拒否されない(宣言していない表と同じ扱い)", () => {
    const manifest = clone(accessControlManifest);
    declarationOf(manifest).enabled = false;
    fieldsOf(manifest, "books").push({ id: "st_public", name: "公開", type: "boolean" });
    expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
  });

  // --- 項目9: 相手を1つも指せない宣言 -------------------------------------------------
  test("(9a) 利用者もグループも指さない宣言は拒否される", () => {
    const manifest = clone(accessControlManifest);
    const grant = declarationOf(manifest).grant as Record<string, unknown>;
    grant.member = undefined;
    grant.group = undefined;
    declarationOf(manifest).members = undefined;
    declarationOf(manifest).groups = undefined;
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    expectUserFacing(errorAt(errors, "/app/tables/0/access_control/grant"));
  });

  test("(9b) 利用者を指す項目を書いたのに利用者の表を宣言していないと拒否される", () => {
    const manifest = clone(accessControlManifest);
    declarationOf(manifest).members = undefined;
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    expectUserFacing(errorAt(errors, "/app/tables/0/access_control/grant/member"));
  });

  test("(9c) グループを指す項目を書いたのにグループの表を宣言していないと拒否される", () => {
    const manifest = clone(accessControlManifest);
    declarationOf(manifest).groups = undefined;
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    // `members.group` もグループの表を指しているので、そちらにもエラーが立つ。
    expectUserFacing(errorAt(errors, "/app/tables/0/access_control/grant/group"));
  });

  // --- 全体の性質 ---------------------------------------------------------------------
  test("(10) 壊れている箇所は全件返る(最初の1件で打ち切らない)", () => {
    const manifest = clone(accessControlManifest);
    const grant = declarationOf(manifest).grant as Record<string, unknown>;
    grant.table = "nope";
    declarationOf(manifest).creator_permission = "manager";
    declarationOf(manifest).inherit_from = ["nope"];
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  test("(11) incoming でも stored でも同じ判定になる(purpose の分岐を作っていない)", () => {
    const manifest = clone(accessControlManifest);
    declarationOf(manifest).creator_permission = "manager";
    expect(validateManifestFull(manifest, "incoming").valid).toBe(false);
    expect(validateManifestFull(manifest, "stored").valid).toBe(false);
  });
});

/*
 * --- 名札の一意性(`CM-G31`。`V10-M24-T05` / `ADR-0371` 限定1〜限定6)------------------
 *
 * **一意の範囲は「1つの画面の中で、宛先の形ごと」である。**
 * - 同一画面内で名札が重複 → `valid=false`
 * - 画面をまたいで同じ名札(画面内は一意) → `true`
 * - 名札を1つも書いていない → `true`(**拒否は「全か無か」だが、名札の無いノードは
 *   1件も拒否しない** —— 名札は任意である = `ADR-0371` 限定1)
 * - **集計表は `group_by` と `aggregates` を1つの名前空間として一意にする**
 *   (宛先の形が `(view_id, report_node_id)` の1形だから)
 */
describe("`CM-G31` / `V10-M24-T05`: 名札の一意性(同じ画面の中で、宛先の形ごと)", () => {
  /** 親 orders + 子 lines。名札の検査だけを見るための最小の台。 */
  function anchorManifest(views: unknown[]): Manifest {
    return {
      app: {
        id: "anchor",
        name: "名札",
        tables: [
          {
            id: "orders",
            name: "注文",
            fields: [
              { id: "code", name: "番号", type: "text", required: true },
              { id: "amount", name: "金額", type: "number" },
              { id: "status", name: "状態", type: "select", options: ["新規", "完了"] },
              { id: "kind", name: "種別", type: "select", options: ["A", "B"] },
            ],
          },
          {
            id: "lines",
            name: "明細",
            fields: [
              { id: "qty", name: "数量", type: "number" },
              { id: "note", name: "備考", type: "text" },
              { id: "order", name: "注文", type: "reference", reference_table: "orders" },
            ],
          },
        ],
        views,
      },
    } as unknown as Manifest;
  }

  /** 子一覧1本(名札は呼び出し側が足す)。 */
  function relatedItem(extra: Record<string, unknown>): Record<string, unknown> {
    return { table: "lines", via: "order", columns: ["qty"], ...extra };
  }

  /** 集計表の中身1組(名札は呼び出し側が足す)。 */
  function reportView(id: string, report: Record<string, unknown>): Record<string, unknown> {
    return { id, type: "report_view", table: "orders", report };
  }

  // --- (1) 関連一覧 `related[].id` ----------------------------------------------------
  describe("関連一覧(related)", () => {
    test("同じ画面の中で名札が重複すると、2件目の出現箇所で拒否される", () => {
      const manifest = anchorManifest([
        {
          id: "order-detail",
          type: "detail_view",
          table: "orders",
          related: [relatedItem({ id: "lines_panel" }), relatedItem({ id: "lines_panel" })],
        },
      ]);
      const errors = expectInvalid(validateReferentialIntegrity(manifest));
      const error = errorAt(errors, "/app/views/0/related/1/id");
      expect(error.message).toContain("lines_panel");
      expect(error.message).toContain("重複");
    });

    test("画面をまたいで同じ名札を書くのは重複ではない", () => {
      const manifest = anchorManifest([
        {
          id: "order-detail",
          type: "detail_view",
          table: "orders",
          related: [relatedItem({ id: "lines_panel" })],
        },
        {
          id: "order-detail-2",
          type: "detail_view",
          table: "orders",
          related: [relatedItem({ id: "lines_panel" })],
        },
      ]);
      expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
    });

    test("名札を1つも書いていない関連一覧は今日どおり通る", () => {
      const manifest = anchorManifest([
        {
          id: "order-detail",
          type: "detail_view",
          table: "orders",
          related: [relatedItem({}), relatedItem({})],
        },
      ]);
      expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
    });

    test("名札の無い子一覧を1件も拒否しない(重複した1件だけが指摘される)", () => {
      const manifest = anchorManifest([
        {
          id: "order-detail",
          type: "detail_view",
          table: "orders",
          related: [
            relatedItem({}),
            relatedItem({ id: "lines_panel" }),
            relatedItem({}),
            relatedItem({ id: "lines_panel" }),
          ],
        },
      ]);
      const errors = expectInvalid(validateReferentialIntegrity(manifest));
      expect(errors).toHaveLength(1);
      expect(at(errors, 0).path).toBe("/app/views/0/related/3/id");
    });
  });

  // --- (2) 集計表の列 `report.group_by[].id` / `report.aggregates[].id` ---------------
  describe("集計表の列(report.group_by / report.aggregates)", () => {
    test("束ねるキーどうしで名札が重複すると拒否される", () => {
      const manifest = anchorManifest([
        reportView("order-report", {
          group_by: [
            { id: "col", field: "status" },
            { id: "col", field: "kind" },
          ],
          aggregates: [{ type: "count" }],
        }),
      ]);
      const errors = expectInvalid(validateReferentialIntegrity(manifest));
      const error = errorAt(errors, "/app/views/0/report/group_by/1/id");
      expect(error.message).toContain("col");
      expect(error.message).toContain("重複");
    });

    test("集計どうしで名札が重複すると拒否される", () => {
      const manifest = anchorManifest([
        reportView("order-report", {
          group_by: [{ field: "status" }],
          aggregates: [
            { id: "col", type: "count" },
            { id: "col", type: "sum", field: "amount" },
          ],
        }),
      ]);
      const errors = expectInvalid(validateReferentialIntegrity(manifest));
      const error = errorAt(errors, "/app/views/0/report/aggregates/1/id");
      expect(error.message).toContain("重複");
    });

    test("束ねるキーと集計は1つの名前空間である(同じ名札を書くと拒否される)", () => {
      const manifest = anchorManifest([
        reportView("order-report", {
          group_by: [{ id: "col", field: "status" }],
          aggregates: [{ id: "col", type: "count" }],
        }),
      ]);
      const errors = expectInvalid(validateReferentialIntegrity(manifest));
      const error = errorAt(errors, "/app/views/0/report/aggregates/0/id");
      expect(error.message).toContain("重複");
    });

    test("束ねるキーと集計で別の名札なら通る", () => {
      const manifest = anchorManifest([
        reportView("order-report", {
          group_by: [{ id: "by_status", field: "status" }],
          aggregates: [{ id: "total", type: "count" }],
        }),
      ]);
      expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
    });

    test("画面をまたいで同じ名札を書くのは重複ではない", () => {
      const manifest = anchorManifest([
        reportView("report-a", {
          group_by: [{ id: "col", field: "status" }],
          aggregates: [{ type: "count" }],
        }),
        reportView("report-b", {
          group_by: [{ field: "status" }],
          aggregates: [{ id: "col", type: "count" }],
        }),
      ]);
      expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
    });

    test("名札を1つも書いていない集計表は今日どおり通る", () => {
      const manifest = anchorManifest([
        reportView("order-report", {
          group_by: [{ field: "status" }, { field: "kind" }],
          aggregates: [{ type: "count" }, { type: "sum", field: "amount" }],
        }),
      ]);
      expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
    });
  });

  // --- (3) 項目のまとまり `field_groups.<名前>.id`(新形)------------------------------
  describe("項目のまとまり(field_groups の新形)", () => {
    test("同じ画面の中で名札が重複すると、2件目のまとまりで拒否される", () => {
      const manifest = anchorManifest([
        {
          id: "order-detail",
          type: "detail_view",
          table: "orders",
          field_groups: {
            基本: { id: "grp", fields: ["code"] },
            詳細: { id: "grp", fields: ["amount"] },
          },
        },
      ]);
      const errors = expectInvalid(validateReferentialIntegrity(manifest));
      const error = errorAt(errors, "/app/views/0/field_groups/詳細/id");
      expect(error.message).toContain("grp");
      expect(error.message).toContain("重複");
    });

    test("画面をまたいで同じ名札を書くのは重複ではない", () => {
      const manifest = anchorManifest([
        {
          id: "order-detail",
          type: "detail_view",
          table: "orders",
          field_groups: { 基本: { id: "grp", fields: ["code"] } },
        },
        {
          id: "order-detail-2",
          type: "detail_view",
          table: "orders",
          field_groups: { 基本: { id: "grp", fields: ["code"] } },
        },
      ]);
      expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
    });

    test("旧形(配列そのもの)は名札を持てないので1件も拒否しない", () => {
      const manifest = anchorManifest([
        {
          id: "order-detail",
          type: "detail_view",
          table: "orders",
          field_groups: { 基本: ["code"], 詳細: ["amount"] },
        },
      ]);
      expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
    });

    test("新形でも名札を書いていないまとまりは今日どおり通る", () => {
      const manifest = anchorManifest([
        {
          id: "order-detail",
          type: "detail_view",
          table: "orders",
          field_groups: { 基本: { fields: ["code"] }, 詳細: { fields: ["amount"] } },
        },
      ]);
      expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
    });

    test("まとまりの名前に `/` が入っていても path が壊れない(RFC 6901)", () => {
      const manifest = anchorManifest([
        {
          id: "order-detail",
          type: "detail_view",
          table: "orders",
          field_groups: {
            "基本/一般": { id: "grp", fields: ["code"] },
            "詳細~notes": { id: "grp", fields: ["amount"] },
          },
        },
      ]);
      const errors = expectInvalid(validateReferentialIntegrity(manifest));
      errorAt(errors, "/app/views/0/field_groups/詳細~0notes/id");
    });
  });

  // --- (4) 3種は互いに別の名前空間である --------------------------------------------
  test("宛先の形が違えば同じ名札を同じ画面に書ける(形ごとに一意)", () => {
    const manifest = anchorManifest([
      {
        id: "order-detail",
        type: "detail_view",
        table: "orders",
        related: [relatedItem({ id: "same" })],
        field_groups: { 基本: { id: "same", fields: ["code"] } },
      },
    ]);
    expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
  });
});
