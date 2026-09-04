/**
 * **操作起点の表示条件**(`V4-M20-T02`。`ADR-0101` 限定1〜限定7)。
 *
 * ## これは何で、何ではないか
 *
 * - **通したのは「この起点を出すか出さないか」を決める葉1つの述語だけである。**
 * - **【禁止】「出し分けが自由にできるようになった」と読まない**(`ADR-0101` §限界3)
 *   —— **葉1つなので `and` / `or` / `not` を1つも書けない。**
 * - **【禁止】「条件で隠したから安全である」と1文字も書かない**(限定6)——
 *   **ボタンを隠すことは書込を止めることではない。** サーバ側の書込判定を1バイトも
 *   変えていない。
 * - **【禁止】「一覧の行ごとに出し分けられるようになった」と読まない**(§限界1)——
 *   **`actions` は今日も `detail_view` だけである。**
 *
 * ## 【本数の実測が限定表と食い違う】
 *
 * **`ADR-0101` 限定1 は「`$defs/view_action.properties` を **3 → 4**」と書いているが、
 * それは `V4-M20-T01`(`ADR-0100` の `set`)が入る前の実測である。**
 * **今日の実測は 4 → 5 である** —— **守ったのは「1本だけ足す」という増分であって、
 * 限定表が写した絶対値ではない。** **`ADR-0101` の本文を1バイトも書き換えていない。**
 *
 * ## 【`V4-M19` との二重化を実測した】(`T02` 完了条件6)
 *
 * **`D-V4-84` の実装(`$defs/field.hide_when_empty`)は既に `main` に入っている。**
 * **その値域は `{"type":"boolean"}` の真偽値1つであり、`field` も演算子も1つも持たない**
 * —— **「行の値で分岐する述語」ではない。** 本ファイルの (T02-6) がこれを実測で固定する。
 */

import { describe, expect, test } from "bun:test";
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import { foldOperations } from "./apply-diff.ts";
import type { Manifest, View } from "./types.ts";
import { validateManifest, validateManifestFull } from "./validate.ts";

/** 足したキー。**1本だけである**(`ADR-0101` 限定1)。 */
const KEY = "visible_when";

type Any = Record<string, unknown>;

function defs(): Record<string, Any> {
  return (manifestSchema as unknown as { $defs: Record<string, Any> }).$defs;
}

function viewActionSchema(): Any {
  return defs().view_action as Any;
}

function baseManifest(views: View[]): Manifest {
  return {
    app: {
      id: "shop",
      name: "店",
      tables: [
        {
          id: "goods",
          name: "商品",
          fields: [
            { id: "name", name: "名前", type: "text" },
            { id: "stock", name: "在庫", type: "number" },
            { id: "sellable", name: "販売中", type: "boolean" },
          ],
        },
        {
          id: "carts",
          name: "カート",
          fields: [{ id: "item", name: "商品", type: "reference", reference_table: "goods" }],
        },
      ],
      views,
    },
  } as unknown as Manifest;
}

function detailView(actions: unknown[]): View {
  return { id: "goods-detail", type: "detail_view", table: "goods", actions } as unknown as View;
}

function cartForm(): View {
  return { id: "cart-form", type: "form", table: "carts", fields: ["item"] } as unknown as View;
}

const NAVIGATE = { form: "cart-form", prefill: { field: "item" } };

// ---------------------------------------------------------------------------
// 限定1: 足すキーは1本だけ。$defs を1つも増やさない
// ---------------------------------------------------------------------------

describe("(T02-1) 足すキーは view_action に1本だけ(ADR-0101 限定1)", () => {
  /*
   * **【`V5-M22-T01` / `L-G5` / `ADR-0173` 限定1 で 5 → 6 に更新した】**
   *
   * **旧テスト名(逐語)**: 「**$defs/view_action.properties は 5 で、5本目が本キーである**」。
   * **増やしたのは `ADR-0101`(本ファイルが固定している審査)ではない** —— **6キー目
   * `view`(行き先のビューID)は `V5-M20` 面2 が門A の本審査を新規に通して足した**
   * (判定 = 限定採用。`ADR-0173`)。**`ADR-0101` の増分は今日も 1 本(`visible_when`)である。**
   * **主張(足すキーは1本だけ)は1ミリも弱めていない** —— **測る位置を「末尾」から
   * 「名指し」に変えた**(末尾で測ると、後続が別のキーを足すたびに主張が壊れる)。
   *
   * **【`V5-M23-T02` / `L-G14` / `ADR-0177` 限定1 で 6 → 7 に更新した】**
   * **7キー目 `audience`(この操作起点を見せる相手)も `ADR-0101` が足したものではない**
   * —— **`V5-M20` 面4 の `L-G14` が門A の本審査を新規に通して足した**(判定 = 限定採用)。
   * **`ADR-0101` の増分は今日も 1 本(`visible_when`)である。**
   * **【混ぜない】** **`visible_when` は「行の値で出し分ける」/ `audience` は
   * 「見ている人で出し分ける」であり、同じ場所にある別の判定である。**
   */
  /*
   * **【`V5-M25-T01` / `L-G8` / `ADR-0174` による追随】** **旧: `toHaveLength(7)`。**
   * **8キー目 `run` を足したのは `ADR-0174` であり、`ADR-0101` の増分は今日も
   * `visible_when` 1本である。**
   */
  /*
   * **【`V8-M17` / `J-G9`(`ADR-0007` 門A 本審査 = 限定採用)による追随。2026-08-09】**
   * **9キー目 `id`(ボタンの識別子)を足したのは `V8-M17` であり、役割に束ねた規則
   * (`app.roles[].rules` の `target: action`)からボタンを名指しするためである。**
   * **旧文・旧値を1バイトも消していない。**
   * **【期待値を1つの数字に揃えてはならない。メインの裁定 `R-13-1` / 審査の申し送り2】**
   * **`$defs/view_action` は `V8-M17` 時点で9キー、`V8-M20` が `audience` を消して
   * 8キーに戻る。****揃えると `V8-M17` と `V8-M20` の完了条件が互いを赤くする。**
   */
  test("$defs/view_action.properties に本キーがちょうど1本在る(本 ADR の増分は1本だけ)", () => {
    const keys = Object.keys(viewActionSchema().properties as Any);
    expect(keys.filter((key) => key === KEY)).toHaveLength(1);
    // **`V8-M17` 時点で9。****`V8-M20` が `audience` を消して8に戻った。**
    // **【`V8-M20-T01` / 台帳 `J-G29` / `ADR-0301`。2026-08-10】旧値の逐語は 9。**
    expect(keys).toHaveLength(8);
  });

  // 【`V5-M29-T04` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
  //   消したテスト名(逐語): 「$defs の本数 28 が1つも増えていない(値域は既存の $ref)」
  //   そのブロックが測っていたもの:
  //     - $defs の本数 28 が1つも増えていない(値域は既存の $ref)
  //   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `manifest.$defs:` で始まる行)。
  //   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
  //   検出力0のまま `Ran` を水増しする)。
  //   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。

  // 【`V5-M29-T04` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
  //   消したテスト名(逐語): 「RESOURCE_KINDS 7 / FIELD_TYPES 8 / DIFF_OPS 16 が1つも動かない(限定7)」
  //   そのブロックが測っていたもの:
  //     - RESOURCE_KINDS は 7 である
  //     - FIELD_TYPES は 9 である(テスト名は 8 と書いていた)
  //     - DIFF_OPS は 17 である(テスト名は 16 と書いていた)
  //   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `RESOURCE_KINDS:` / `FIELD_TYPES:` /
  //   `DIFF_OPS:` で始まる行)。
  //   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
  //   検出力0のまま `Ran` を水増しする)。
  //   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。

  // **【`V5-M29-T04` / `ADR-0250` 限定14 がテスト名を更新した】** 旧名(逐語)は
  // 「**$defs/view.properties(26)と $defs/field.properties(12)に1バイトも触っていない**」。
  // **`$defs/view.properties` の総量を固定していた `expect` を中央へ移したので、この test に
  // 残るのは `$defs/field.properties` の 12 だけである**(`$defs/field` は8主題の外にあり、
  // 中央へは移していない)。
  test("$defs/field.properties(12)に1バイトも触っていない", () => {
    // **【V4-M20-T04 / ADR-0102 限定1 で 26 → 27 に更新した】** 27キー目 `after_save`
    // (保存が成立したあとに行く画面のID)が門A の本審査(V4-M20 単位D。2回目の審査。
    // 判定 = 限定採用)を通って増えた。**form 型のビューでだけ書ける。****本タスク
    // (`V4-M20-T02` / `ADR-0101`)の増分ではない。**
    // **【V4-M23-T01 / ADR-0104 限定採用で 27 → 28 に更新した】** 28キー目 `sum_field`
    // (合計を出す列)が門A の本審査を通って増えた。**`list_view` でだけ書ける。****本タスク
    // (`V4-M20-T02` / `ADR-0101`)の増分ではない。**
    // 【`V5-M29-T04` / `ADR-0250` 限定11】ここにあった「$defs/view.properties(26)と $defs/field.properties(12)に1バイトも触っていない」の検査は
    //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
    //   `manifest.$defs.view.properties:` で始まる行)。**総量ではなく名前と順序で見張る。**
    //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
    // **【V6-M1-T01 / K-G1 / ADR-0288 限定1 で 12 → 13 に更新した】** 13キー目 `reference_picker`
    // (他のテーブルから選ぶ項目の選び方)が門A を通って増えた(V6-M0 単位A。判定 = 限定採用)。
    // **reference 型にだけ書けるキーである。****本 ADR の増分ではない。**
    // **【`V6-M3-T02` / `K-G7` / `ADR-0290` 限定1 で 13 → 14 に更新した】** 14キー目
    // `reference_search_fields`(参照候補の「探せる項目」の、項目ごとの上書き)が門A を通って
    // 増えた(`V6-M0` 単位B。判定 = 限定採用)。**`reference` 型にだけ書けるキーである。**
    // **本 ADR の増分ではない。**
    // **【`V8-M20-T01` / 台帳 `J-G27` / `J-G28` / 手続きは `ADR-0301` で 14 → 12 に更新した】**
    // 8キー目だった `audience`(この項目を見せる相手)と9キー目だった `writable_by`(この項目を
    // 書ける相手)が**2本とも廃止された**(判定 = 廃止)。**代わりに担うのは `app.roles[].rules` の
    // 「役割 × 対象(項目)× 読取 / 書込」である。****旧値の逐語は 14。**
    expect(Object.keys((defs().field as Any).properties as Any)).toHaveLength(12);
  });
});

// ---------------------------------------------------------------------------
// 限定2: 値域は $defs/filter_leaf の $ref そのもの。新しい条件構文を1バイトも作らない
// ---------------------------------------------------------------------------

describe("(T02-2) 値域は既存の filter_leaf の $ref そのもの(ADR-0101 限定2)", () => {
  test("キーの中身は $ref 1本だけである(型も enum も pattern も書いていない)", () => {
    const property = (viewActionSchema().properties as Any)[KEY] as Any;
    expect(property.$ref).toBe("#/$defs/filter_leaf");
    // **$ref のほかに書いてよいのは説明だけである。**新しい構文を1バイトも作らない。
    expect(Object.keys(property).filter((key) => key !== "$ref" && key !== "$comment")).toEqual([
      "description",
    ]);
  });

  test("演算子5種はどれも書ける(filter_leaf をそのまま再利用している)", () => {
    for (const leaf of [
      { field: "stock", equals: 0 },
      { field: "name", contains: "限定" },
      { field: "stock", gte: 1 },
      { field: "stock", lte: 0 },
      { field: "name", in: ["A", "B"] },
    ]) {
      expect(
        validateManifestFull(
          baseManifest([cartForm(), detailView([{ ...NAVIGATE, [KEY]: leaf }])]),
        ),
        JSON.stringify(leaf),
      ).toEqual({ valid: true });
    }
  });

  test("1葉に演算子を2つ書くと拒否される(filter_leaf の oneOf をそのまま受け継ぐ)", () => {
    expect(
      validateManifest(
        baseManifest([
          cartForm(),
          detailView([{ ...NAVIGATE, [KEY]: { field: "stock", gte: 1, lte: 5 } }]),
        ]),
      ).valid,
    ).toBe(false);
  });

  test("and / or / not の合成は1つも書けない(葉1つだけ)", () => {
    for (const value of [
      { and: [{ field: "stock", gte: 1 }] },
      { or: [{ field: "stock", gte: 1 }] },
      { not: { field: "stock", gte: 1 } },
      [{ field: "stock", gte: 1 }],
    ]) {
      expect(
        validateManifest(baseManifest([cartForm(), detailView([{ ...NAVIGATE, [KEY]: value }])]))
          .valid,
        JSON.stringify(value),
      ).toBe(false);
    }
  });

  test("演算子は5種のままで、6種目を1つも足していない(ADR-0043 限定1 は無傷)", () => {
    const leaf = defs().filter_leaf as Any;
    expect(Object.keys(leaf.properties as Any).filter((key) => key !== "field")).toEqual([
      "equals",
      "contains",
      "gte",
      "lte",
      "in",
    ]);
    expect(leaf.additionalProperties).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 限定3: 判定対象は「今開いているレコードの値」だけ
// ---------------------------------------------------------------------------

describe("(T02-3) 判定対象は今開いているレコードの値だけ(ADR-0101 限定3)", () => {
  test("対象テーブルに無いフィールドを指すと apply 時に拒否される", () => {
    const result = validateManifestFull(
      baseManifest([
        cartForm(),
        detailView([{ ...NAVIGATE, [KEY]: { field: "nope", equals: 1 } }]),
      ]),
    );
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result)).toContain("nope");
  });

  test("別テーブルを指すキー(table / via / from)を1つも書けない", () => {
    for (const value of [
      { table: "carts", field: "item", equals: 1 },
      { field: "stock", equals: 1, table: "carts" },
      { field: "stock", via: "item", equals: 1 },
    ]) {
      expect(
        validateManifest(baseManifest([cartForm(), detailView([{ ...NAVIGATE, [KEY]: value }])]))
          .valid,
        JSON.stringify(value),
      ).toBe(false);
    }
  });

  test("【正直に書く】葉の値の型は apply 時に見ていない —— view.filter と同じ非対称である", () => {
    /*
     * **`view.filter` の葉も今日フィールドの実在だけを見ている**(`filterFieldRefs` は
     * `field` しか集めない)。**本キーはそこと非対称にしない**ことを選んだ。
     *
     * **その代償を隠さない**: `number` 列に文字列を比べる条件は apply を通り、
     * **画面では毎回偽になってボタンが永久に出ない。** これは「書けるが効かない」に
     * 当たるが、**本タスクが新しく作った穴ではなく、`view.filter` に今日在る穴と同じ形で
     * ある**(`ADR-0101` 限定表はこの検査を1つも求めていない)。
     */
    expect(
      validateManifestFull(
        baseManifest([
          cartForm(),
          detailView([{ ...NAVIGATE, [KEY]: { field: "stock", equals: "$record.stock" } }]),
        ]),
      ),
    ).toEqual({ valid: true });
  });

  test("集計を指すキー(count / sum / avg)を1つも書けない", () => {
    for (const value of [
      { field: "stock", count: 0 },
      { field: "stock", sum: 0 },
    ]) {
      expect(
        validateManifest(baseManifest([cartForm(), detailView([{ ...NAVIGATE, [KEY]: value }])]))
          .valid,
        JSON.stringify(value),
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 限定4: 条件が決めるのは「出すか出さないか」だけ。プリフィル値を変えられない
// ---------------------------------------------------------------------------

describe("(T02-4) 条件でプリフィル値を変えられない(ADR-0101 限定4)", () => {
  test("prefill の properties は今日も {field} 1本だけで、条件のキーが無い", () => {
    const prefill = (viewActionSchema().properties as Any).prefill as Any;
    expect(Object.keys(prefill.properties as Any)).toEqual(["field"]);
    expect(prefill.additionalProperties).toBe(false);
    expect(Object.keys(prefill.properties as Any)).not.toContain(KEY);
  });

  test("prefill の中に条件を書くと拒否される(条件付きプリフィルは今日も作らない)", () => {
    expect(
      validateManifest(
        baseManifest([
          cartForm(),
          detailView([
            { form: "cart-form", prefill: { field: "item", [KEY]: { field: "stock", gte: 1 } } },
          ]),
        ]),
      ).valid,
    ).toBe(false);
  });

  test("set(形 (ii))にも条件を書ける —— 条件は形に依らず「出すか」だけを決める", () => {
    expect(
      validateManifestFull(
        baseManifest([
          detailView([
            { set: { field: "sellable", value: false }, [KEY]: { field: "stock", lte: 0 } },
          ]),
        ]),
      ),
    ).toEqual({ valid: true });
  });

  test("条件は任意である —— 書かなければ今日どおり必ず出る(既定を反転させていない)", () => {
    expect(validateManifestFull(baseManifest([cartForm(), detailView([NAVIGATE])]))).toEqual({
      valid: true,
    });
  });
});

// ---------------------------------------------------------------------------
// 限定5 / 限定6: workflow_action.when を1バイトも触らない / サーバ側の判定を変えない
// ---------------------------------------------------------------------------

describe("(T02-5) 2つ目の条件語彙を作っていない(ADR-0101 限定5)", () => {
  test("$defs/workflow_action.properties は 17 のままで、when の形も1バイトも変わっていない", () => {
    const wa = defs().workflow_action as Any;
    expect(Object.keys(wa.properties as Any)).toHaveLength(17);
    const when = (wa.properties as Any).when as Any;
    expect(Object.keys(when.properties as Any).sort()).toEqual(["equals", "field"]);
    expect(when.additionalProperties).toBe(false);
  });

  test("表示条件は filter_leaf を指しており、workflow_action.when とは別の定義を1つも作っていない", () => {
    const property = (viewActionSchema().properties as Any)[KEY] as Any;
    expect(property.$ref).toBe("#/$defs/filter_leaf");
    // **`when` を指してはいない**(ワークフローの述語は実行の可否、こちらは表示の可否)。
    expect(property.$ref).not.toContain("workflow");
  });
});

// ---------------------------------------------------------------------------
// (T02-5b) rename の追随(**`T01` の `set.field` も一緒にここで固定する**)
// ---------------------------------------------------------------------------

describe("(T02-5b) change_field の rename が操作起点の列参照に追随する", () => {
  /*
   * **`apply-diff.ts` の §5d は「このテーブルを見ているビュー」の列参照を新IDへ写す。**
   * **`set.field` と `visible_when.field` は、どちらもこの画面の対象テーブルの列である。**
   * **追随させないと、操作起点を1つ書いた画面があるだけで rename が参照整合性で拒否される**
   * (直上の `preset_column_align` が同じ理由で追随している)。
   *
   * **`prefill.field` は追随させない** —— **あれは遷移先 form の対象テーブルの列**であり、
   * 別テーブルの同名列を巻き添えにしないためである((c) が固定する)。
   *
   * **【正直に書く】この追随は `T01` の増分(`set.field`)にも要るものだが、`T01` の
   * コミットには入っていない。** **`T02` のコミットで2つまとめて入れた**(実装記録 §1)。
   */
  const rename = (manifest: Manifest): Manifest =>
    (
      foldOperations(manifest, [
        {
          op: "change_field",
          table: "goods",
          field: "stock",
          changes: { id: "quantity" },
        },
      ] as never) as unknown as { manifest: Manifest }
    ).manifest;

  test("(a) set.field が新IDへ写り、rename 後のマニフェストが通る", () => {
    const before = baseManifest([
      detailView([{ set: { field: "stock", value: 0 }, name: "在庫を空にする" }]),
    ]);
    const after = rename(before);
    const action = (after.app.views[0] as Any).actions as Any[];
    expect((action[0] as Any).set).toEqual({ field: "quantity", value: 0 });
    expect(validateManifestFull(after)).toEqual({ valid: true });
  });

  test("(b) visible_when.field が新IDへ写り、rename 後のマニフェストが通る", () => {
    const before = baseManifest([
      cartForm(),
      detailView([{ ...NAVIGATE, [KEY]: { field: "stock", gte: 1 } }]),
    ]);
    const after = rename(before);
    const action = (after.app.views[1] as Any).actions as Any[];
    expect((action[0] as Any).visible_when).toEqual({ field: "quantity", gte: 1 });
    expect(validateManifestFull(after)).toEqual({ valid: true });
  });

  test("(c) prefill.field は1バイトも動かない(別テーブルの列だから)", () => {
    const before = baseManifest([cartForm(), detailView([NAVIGATE])]);
    const after = rename(before);
    const action = (after.app.views[1] as Any).actions as Any[];
    expect((action[0] as Any).prefill).toEqual({ field: "item" });
  });
});

// ---------------------------------------------------------------------------
// (T02-6) `V4-M19`(D-V4-84)との二重化が起きていないことの実測(T02 完了条件6)
// ---------------------------------------------------------------------------

describe("(T02-6) 行の値で分岐する述語が2つになっていない", () => {
  test("hide_when_empty は真偽値1つであり、field も演算子も1つも持たない", () => {
    const hide = ((defs().field as Any).properties as Any).hide_when_empty as Any;
    expect(hide.type).toBe("boolean");
    expect(hide.properties).toBeUndefined();
    expect(hide.$ref).toBeUndefined();
  });

  test("$defs/filter_leaf を指しているのは、view.filter と本キーの2箇所だけである", () => {
    const refs: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (node === null || typeof node !== "object") {
        return;
      }
      if (!Array.isArray(node) && (node as Any).$ref === "#/$defs/filter_leaf") {
        refs.push(path);
      }
      for (const [key, value] of Object.entries(node as Any)) {
        walk(value, `${path}/${key}`);
      }
    };
    walk(manifestSchema, "");
    expect(refs.sort()).toEqual([
      "/$defs/filter_node/anyOf/0",
      `/$defs/view_action/properties/${KEY}`,
    ]);
  });

  test("$defs/view で条件を指しているのは今日も filter の1本だけ / $defs/field には1本も無い", () => {
    /*
     * **`V4-M19`(`D-V4-84`)は `$defs/field` に真偽値1本(`hide_when_empty`)を足しただけで、
     * 述語を1つも足していない。** **本タスクも `$defs/view` / `$defs/field` に
     * 1バイトも触っていない。** したがって「行の値で分岐する述語」の置き場は
     * `view.filter`(どの行を出すか)/ `view_action.visible_when`(どのボタンを出すか)/
     * `workflow_action.when`(実行するか)の3つで、**本タスクが増やしたのは2つ目だけである。**
     */
    const viewKeys = Object.entries((defs().view as Any).properties as Any)
      .filter(([, body]) => String((body as Any).$ref ?? "").includes("filter"))
      .map(([key]) => key);
    expect(viewKeys).toEqual(["filter"]);
    const fieldKeys = Object.entries((defs().field as Any).properties as Any)
      .filter(([, body]) => String((body as Any).$ref ?? "").includes("filter"))
      .map(([key]) => key);
    expect(fieldKeys).toEqual([]);
    // `hide_when_empty`(`D-V4-84` の実装)は真偽値1つであり、述語の器を持たない。
    expect(((defs().field as Any).properties as Any).hide_when_empty).toEqual({
      $comment: expect.any(String),
      description: expect.any(String),
      type: "boolean",
    });
  });
});
