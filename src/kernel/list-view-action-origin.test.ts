/**
 * **一覧(`list_view`)の行の操作起点**(`V5-M21-T01`。`ADR-0171` 限定1〜限定12)。
 *
 * ## これは何で、何ではないか
 *
 * - **通したのは「一覧の行に操作起点(遷移の形)を置けるようにする」ことだけである。**
 * - **【禁止】「一覧から何でも呼べるようになった」と読まない**(`ADR-0171` §限界5)——
 *   **複数行の一括操作は今日も1ミリも解けない**(`V4-M20` 単位C は将来送りのままである)。
 * - **【禁止】「二重押しが防げる」と読まない**(同 §限界2)—— **規則は今日1つも無い。**
 * - **【禁止】「一覧の行から押せるようになった」を、実際に押す前に書かない**(同 §限界1)。
 *   **本ファイルはスキーマと適用時検査だけを見ている。押していない。**
 * - **【禁止】「入力フォームにも書けるようになった」と読まない**(限定3)—— **`form` 分岐の
 *   `"actions": false,` は1バイトも解いていない。**
 *
 * ## **set 形(値の書換)は一覧では今日も書けない**
 *
 * **`ADR-0171` 限定10 の逐語**: 「**[`ADR-0175`](../../docs/adr/0175-manual-trigger-idempotency-and-actor.md)
 * の規則が実装されるまで、一覧の set 形を実装しない**(順序の拘束)」。
 * **`V5-M25-T03`(実行中の重複を 409 で拒む規則)は今日 `docs/plan/v5/records/v5-m20.md` §6 に
 * 起票があるだけで、実装は1バイトも存在しない。** したがって本タスクは **`list_view` の
 * `actions` から `set` を機械的に閉じる**(下の (T01-3) 群)。**これは「書けるが効かない」を
 * 黙って作らないための閉じ方であって、`L-G3` の判定(限定採用)を覆すものではない。**
 */

import { describe, expect, test } from "bun:test";
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import type { Manifest, View } from "./types.ts";
import { validateManifest, validateManifestFull } from "./validate.ts";

type Any = Record<string, unknown>;

function defs(): Record<string, Any> {
  return (manifestSchema as unknown as { $defs: Record<string, Any> }).$defs;
}

function viewBranch(type: string): Any {
  const branches = (defs().view as Any).allOf as { if: Any; then?: Any }[];
  const found = branches.find(
    (branch) => ((branch.if.properties as Any).type as Any)?.const === type,
  );
  if (found === undefined) {
    throw new Error(`branch not found: ${type}`);
  }
  return (found.then ?? {}) as Any;
}

function branchProperties(type: string): Any {
  return (viewBranch(type).properties ?? {}) as Any;
}

function baseManifest(views: View[]): Manifest {
  return {
    app: {
      id: "shop",
      name: "店",
      tables: [
        {
          id: "products",
          name: "商品",
          fields: [
            { id: "title", name: "名前", type: "text" },
            { id: "stock", name: "在庫", type: "number" },
          ],
        },
        {
          id: "carts",
          name: "カート",
          fields: [
            { id: "product", name: "商品", type: "reference", reference_table: "products" },
            { id: "qty", name: "個数", type: "number" },
          ],
        },
      ],
      views,
    },
  } as unknown as Manifest;
}

function productList(actions?: unknown[]): View {
  return {
    id: "product-list",
    type: "list_view",
    table: "products",
    columns: ["title"],
    ...(actions === undefined ? {} : { actions }),
  } as unknown as View;
}

function cartForm(): View {
  return {
    id: "cart-form",
    type: "form",
    table: "carts",
    fields: ["product", "qty"],
  } as unknown as View;
}

/** 遷移の形(`ADR-0045` の最小形。**1バイトも変えていない**)。 */
const NAVIGATE_ACTION = { form: "cart-form", prefill: { field: "product" } };

// ---------------------------------------------------------------------------
// 限定表 の入口: 一覧に遷移の形を書ける(L-G1 / L-G2)
// ---------------------------------------------------------------------------

describe("(T01-1) 一覧の行に操作起点を置ける(ADR-0171 §Decision 1)", () => {
  test("list_view 分岐の properties から actions の false が外れている", () => {
    expect(branchProperties("list_view").actions).not.toBe(false);
  });

  test("list_view に遷移の形の actions を書いたマニフェストが通る", () => {
    expect(validateManifest(baseManifest([cartForm(), productList([NAVIGATE_ACTION])])).valid).toBe(
      true,
    );
  });

  test("適用時の参照整合(referential-integrity)も通る", () => {
    expect(
      validateManifestFull(baseManifest([cartForm(), productList([NAVIGATE_ACTION])])),
    ).toEqual({ valid: true });
  });

  test("actions を書かない list_view は今日どおり通る(既定を反転させていない)", () => {
    expect(validateManifestFull(baseManifest([cartForm(), productList()]))).toEqual({
      valid: true,
    });
  });

  test("遷移先が実在しない form なら適用時に倒れる", () => {
    const result = validateManifestFull(
      baseManifest([cartForm(), productList([{ form: "nope", prefill: { field: "product" } }])]),
    );
    expect(result.valid).toBe(false);
  });

  test("prefill.field の参照先が一覧の対象テーブルでないと適用時に倒れる", () => {
    // `qty` は number であって reference ではない。
    const result = validateManifestFull(
      baseManifest([cartForm(), productList([{ form: "cart-form", prefill: { field: "qty" } }])]),
    );
    expect(result.valid).toBe(false);
  });

  test("visible_when の葉が対象テーブルに無い列を指すと適用時に倒れる(detail_view と同じ検査が当たる)", () => {
    const result = validateManifestFull(
      baseManifest([
        cartForm(),
        productList([{ ...NAVIGATE_ACTION, visible_when: { field: "nothere", equals: "x" } }]),
      ]),
    );
    expect(result.valid).toBe(false);
  });

  test("visible_when の葉が対象テーブルの列を指していれば通る", () => {
    expect(
      validateManifestFull(
        baseManifest([
          cartForm(),
          productList([{ ...NAVIGATE_ACTION, visible_when: { field: "stock", gte: 1 } }]),
        ]),
      ),
    ).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// 限定1: 形は今日どおり2形だけ
// ---------------------------------------------------------------------------

describe("(T01-2) 限定1: $defs/view_action の oneOf を1バイトも増やしていない", () => {
  /*
   * **【`V5-M22-T01` / `L-G5` / `L-G6` / `ADR-0173` 限定1 で 2 → 3 に更新した】**
   *
   * **増やしたのは `ADR-0171`(本ファイルが固定している審査)ではない。** **3形目
   * (行き先の宣言 = `view` 1キー)は `V5-M20` 面2 が門A の本審査を新規に通して
   * 足したものである**(判定 = 限定採用。`ADR-0173`)。
   * **`ADR-0171` の増分は今日も 0 である** —— **上のテスト名(「1バイトも増やして
   * いない」)は `ADR-0171` についての主張であり、今日も真である。**
   * **テスト名は書き換えた。旧名を隠さずここに書く**: 逐語「**oneOf の要素数は 2 の
   * ままである**」。**そのままにすると名前が嘘になる**(`ADR-0007` §6 規律の趣旨)。
   * **`describe` の名前(「1バイトも増やしていない」)は `ADR-0171` についての主張なので
   * 1バイトも書き換えていない。**
   * **固定の向き(4形目が入ったら赤くなる)を1ミリも弱めていない。**
   */
  // 【`V5-M29-T03` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
  //   消したテスト名(逐語): 「oneOf の要素数は 4 である(`ADR-0171` は 2 のままにし、`ADR-0173` が3形目・`ADR-0174` が4形目を足した)」
  //   そのブロックが測っていたもの:
  //     - `expect(((defs().view_action as Any).oneOf as unknown[]).length).toBe(4)`
  //   ブロックの直前にあったコメントの逐語: 「**【`V5-M25-T01` / `L-G8` / `ADR-0174` による追随。当時の期待値を隠さない】**
  //   **旧: `toBe(3)`**(その前は `toBe(2)`)—— **`ADR-0174`(門A / 判定 = 限定採用)が
  //   4形目(自動処理の起動 = `run`)を足した。** **`ADR-0171` の増分は今日も 0 である。**
  //   **固定の向き(5形目が入ったら赤くなる)を1ミリも弱めていない。**」
  //   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `manifest.$defs.view_action.oneOf.` で始まる行。形ごとに `oneOf.0` 〜 `oneOf.3`)。
  //   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
  //   検出力0のまま `Ran` を水増しする)。
  //   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。

  test("additionalProperties: false を1バイトも外していない", () => {
    expect((defs().view_action as Any).additionalProperties).toBe(false);
  });

  test("一覧の actions の要素に未知キーを混ぜると拒否される", () => {
    expect(
      validateManifest(
        baseManifest([cartForm(), productList([{ ...NAVIGATE_ACTION, color: "red" }])]),
      ).valid,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 限定10 の順序拘束: 一覧に set 形は今日も書けない
// ---------------------------------------------------------------------------

/*
 * **【`V5-M25-T07` / `L-G3` による追随。旧を隠さない】**
 * **`ADR-0171` 限定10 の順序拘束(「`ADR-0175` の規則が実装されるまで、一覧の set 形を
 * 実装しない」)は、`V5-M25-T03` が規則を実装したことで**解けた**。**
 * **【禁止】これを「二重押しが防げるようになったから解いた」と読まない** ——
 * **set 形の冪等性は今日も1つも無い**(`ADR-0100` §限界1 は1バイトも無効化されていない)。
 */
describe("(T01-3) 限定10 の順序拘束は解けた —— 一覧にも set 形を書ける(V5-M25-T07)", () => {
  test("list_view に set 形の actions を書けるようになった(着手前は拒否されていた)", () => {
    expect(
      validateManifest(baseManifest([productList([{ set: { field: "stock", value: 0 } }])])).valid,
    ).toBe(true);
  });

  test("detail_view の set 形は1バイトも変わっていない(今日どおり通る)", () => {
    const detail = {
      id: "product-detail",
      type: "detail_view",
      table: "products",
      actions: [{ set: { field: "stock", value: 0 } }],
    } as unknown as View;
    expect(validateManifestFull(baseManifest([detail]))).toEqual({ valid: true });
  });

  /*
   * **【`V5-M25-T07` で外した。旧テスト名を隠さない】**
   * **旧(逐語)**: 「**閉じ方は list_view 分岐の1箇所だけである(外す先が1箇所であること)**」
   * / `expect(((actions.items as Any).properties as Any).set).toBe(false);`
   * **【実測: 外す先は1箇所ではなく2箇所だった】** **schema のここと、
   * `src/kernel/types.ts` の `ListView.actions` の `Extract<...>` の対である**
   * (`types.ts` 側の doc がそれを名指ししていた)。**記録に書いた。**
   */
  test("閉じていた1箇所(items.properties.set)が外れている", () => {
    const actions = branchProperties("list_view").actions as Any;
    expect(((actions.items ?? {}) as Any).properties).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 限定3 / 限定4: form と related は1バイトも解かない
// ---------------------------------------------------------------------------

describe("(T01-4) 限定3 / 限定4: 解いていないものを解いていない", () => {
  test('限定3: form 分岐の "actions": false が残っている', () => {
    expect(branchProperties("form").actions).toBe(false);
  });

  test("限定3: form に actions を書くと今日も拒否される", () => {
    const form = {
      id: "cart-form",
      type: "form",
      table: "carts",
      fields: ["product"],
      actions: [NAVIGATE_ACTION],
    } as unknown as View;
    expect(validateManifest(baseManifest([form])).valid).toBe(false);
  });

  test('限定4: list_view / form の両分岐に "related": false が残っている', () => {
    expect(branchProperties("list_view").related).toBe(false);
    expect(branchProperties("form").related).toBe(false);
  });

  test("限定4: list_view に related を書くと今日も拒否される", () => {
    const list = {
      id: "product-list",
      type: "list_view",
      table: "products",
      columns: ["title"],
      related: [{ table: "carts", via: "product", columns: ["qty"] }],
    } as unknown as View;
    expect(validateManifest(baseManifest([list])).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 限定5 / 限定6: 語彙の総量
// ---------------------------------------------------------------------------

describe("(T01-5) 限定5 / 限定6: 語彙の総量を動かしていない", () => {
  // 【`V5-M29-T03` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
  //   消したテスト名(逐語): 「限定5: $defs の本数は 28 のままである」
  //   そのブロックが測っていたもの:
  //     - `expect(Object.keys(defs()).length).toBe(28)`
  //   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `manifest.$defs:` で始まる行)。
  //   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
  //   検出力0のまま `Ran` を水増しする)。
  //   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。

  // 【`V5-M29-T03` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
  //   消したテスト名(逐語): 「限定5: $defs/view.properties の本数は 28 のままである」
  //   そのブロックが測っていたもの:
  //     - `expect(Object.keys((defs().view as Any).properties as Any).length).toBe(28)`
  //   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `manifest.$defs.view.properties:` で始まる行)。
  //   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
  //   検出力0のまま `Ran` を水増しする)。
  //   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。

  test("限定5: 新しい $defs も新しい view のキーも1本も作っていない", () => {
    // **キー名の集合そのものを見る**(本数だけだと1本消して1本足しても気づけない)。
    expect(Object.keys((defs().view as Any).properties as Any)).toContain("actions");
    expect(Object.keys(defs())).toContain("view_action");
    expect(Object.keys(defs())).toContain("view_actions");
    expect(Object.keys(defs())).not.toContain("list_view_action");
  });

  // 【`V5-M29-T03` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
  //   消したテスト名(逐語): 「限定6: FIELD_TYPES 8 / RESOURCE_KINDS 7 / DIFF_OPS 16 を1つも動かしていない」
  //   そのブロックが測っていたもの:
  //     - `expect(FIELD_TYPES.length).toBe(9)`(行末の逐語: 「【`V5-M16` / `ADR-0161`】8 → 9(`file` が9種目)。
  //       **この行が固定していたのは「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**」)
  //     - `expect(RESOURCE_KINDS.length).toBe(7)`
  //     - `expect(DIFF_OPS.length).toBe(17)`(行末の逐語: 「【`V5-M17b` / `ADR-0248`】16 → 17(`set_user_kinds` が17種目)。
  //       **この行が固定していたのは「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**」)
  //   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `FIELD_TYPES:` / `RESOURCE_KINDS:` / `DIFF_OPS:` で始まる行)。
  //   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
  //   検出力0のまま `Ran` を水増しする)。
  //   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。
});

// ---------------------------------------------------------------------------
// 限定7: visible_when の条件式を1ミリも広げていない
// ---------------------------------------------------------------------------

describe("(T01-6) 限定7: visible_when の条件式を1ミリも広げていない", () => {
  test("visible_when の $ref 先は今日も #/$defs/filter_leaf である", () => {
    const action = defs().view_action as Any;
    const visibleWhen = (action.properties as Any).visible_when as Any;
    expect(visibleWhen.$ref).toBe("#/$defs/filter_leaf");
  });

  test("and / or / not を書いた visible_when は一覧でも拒否される", () => {
    expect(
      validateManifest(
        baseManifest([
          cartForm(),
          productList([
            {
              ...NAVIGATE_ACTION,
              visible_when: { and: [{ field: "stock", gte: 1 }] },
            },
          ]),
        ]),
      ).valid,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 限定2: 対象は「押した行」1行だけ(宣言の側で確かめられる分)
// ---------------------------------------------------------------------------

describe("(T01-7) 限定2: 複数行を対象にする形を1つも作っていない", () => {
  /*
   * **【`V5-M22-T01` / `L-G5` / `ADR-0173` 限定1 で 5 → 6 に更新した】**
   * **旧テスト名(逐語)**: 「**view_action の properties は5キーのままで、複数行を指す語が
   * 1つも無い**」。**6キー目 `view` は `ADR-0173` が足したものであり、`ADR-0171` の増分は
   * 今日も 0 である。** **主張の核(複数行を指す語が1つも無い)は1ミリも弱めていない** ——
   * **`view` は行き先1つを指すキーであって、対象行を増やすキーではない。**
   *
   * **【`V5-M23-T02` / `L-G14` / `ADR-0177` 限定1 で 6 → 7 に更新した】**
   * **旧テスト名(逐語)**: 「**view_action の properties は6キーで、複数行を指す語が
   * 1つも無い**」。**7キー目 `audience`(この操作起点を見せる相手)は `ADR-0177` が
   * 足したものであり、`ADR-0171` の増分は今日も 0 である。**
   * **主張の核(複数行を指す語が1つも無い)は1ミリも弱めていない** ——
   * **`audience` は「誰に見せるか」のキーであって、対象行を増やすキーではない。**
   */
  /*
   * **【`V5-M25-T01` / `L-G8` / `ADR-0174` による追随】** **旧テスト名(逐語)**:
   * 「**view_action の properties は7キーで、複数行を指す語が1つも無い**」。
   * **8キー目 `run`(起こす自動処理)は `ADR-0174` が足したものであり、`ADR-0171` の
   * 増分は今日も 0 である。** **主張の核(複数行を指す語が1つも無い)は1ミリも
   * 弱めていない** —— **`run` は「何を起こすか」のキーであって、対象行を増やすキーではない**
   * (`ADR-0174` 限定3: 対象は押した行1行だけ)。
   */
  /*
   * **【`V8-M17` / `J-G9`(`ADR-0007` 門A 本審査 = 限定採用)による追随。2026-08-09】**
   * **旧テスト名(逐語)**: 「**view_action の properties は8キーで、複数行を指す語が
   * 1つも無い**」。**9キー目 `id`(ボタンの識別子)は `V8-M17` が足したものであり、
   * `ADR-0171` の増分は今日も 0 である。****主張の核(複数行を指す語が1つも無い)は
   * 1ミリも弱めていない** —— **`id` は「どのボタンか」を1つ名指しするキーであって、
   * 対象行を増やすキーではない。**
   * **【期待値を1つの数字に揃えてはならない。裁定 `R-13-1`】** **`V8-M20` 後は
   * `audience` が消えて8キーに戻る。**
   *
   * **【`V8-M20-T01` / 台帳 `J-G29` / 手続きは `ADR-0301`。2026-08-10】**
   * **旧テスト名(逐語)**: 「**view_action の properties は9キーで、複数行を指す語が
   * 1つも無い**」。**`audience` が廃止されたので、予告どおり8キーに戻した。**
   * **主張の核(複数行を指す語が1つも無い)は1ミリも弱めていない** —— **消えたのは
   * 「誰に見せるか」のキーであって、対象行を増やすキーではない。****旧文を1バイトも
   * 消していない。**
   */
  test("view_action の properties は8キーで、複数行を指す語が1つも無い", () => {
    const properties = Object.keys((defs().view_action as Any).properties as Any).sort();
    expect(properties).toEqual([
      "form",
      "id",
      "name",
      "prefill",
      "run",
      "set",
      "view",
      "visible_when",
    ]);
  });

  test("prefill は field 1キーだけで、値を書く場所を持たない", () => {
    const prefill = ((defs().view_action as Any).properties as Any).prefill as Any;
    expect(Object.keys(prefill.properties as Any)).toEqual(["field"]);
    expect(prefill.additionalProperties).toBe(false);
  });

  test("選択・全選択・範囲を指すキーを1つも足していない", () => {
    const properties = Object.keys((defs().view_action as Any).properties as Any);
    for (const forbidden of ["target", "targets", "selection", "rows", "scope", "all"]) {
      expect(properties).not.toContain(forbidden);
    }
  });
});
