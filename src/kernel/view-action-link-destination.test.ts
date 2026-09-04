/**
 * **一覧の行から別の画面へ飛ぶ行き先の宣言**(`V5-M22-T01` / `T02` / `T04`。
 * `L-G5` / `L-G6` / `L-G7`。`ADR-0173` 限定1〜限定12)。
 *
 * ## これは何で、何ではないか
 *
 * - **通したのは `$defs/view_action` の3形目「行き先のビューID 1つ」だけである。**
 * - **`link` という新しいトップレベルキーを作っていない**(`ADR-0007` §3 問2③)——
 *   **`$defs` 28 / `$defs/view.properties` 28 は着手前と同値である**(`ADR-0173` 限定8)。
 * - **【禁止】「どこへでも飛べるようになった」と読まない**(`ADR-0173` 限定3)——
 *   **行き先は同じアプリの `list_view` / `detail_view` だけである。****`form` は指せず、
 *   外部 URL も別アプリのビューも1文字も書けない。**
 * - **【禁止】「詳細画面からも任意の画面へ飛べる」と読まない** —— **`L-G7` は却下である**
 *   (`docs/plan/v5/records/v5-m20.md` §2-2)。**3形目は `detail_view` に書けない。**
 *   **非対称が残る。**
 * - **【禁止】「行クリックの行き先が選べるようになった」と読まない**(`ADR-0173` 限定7)
 *   —— **変わったのは操作起点の行き先だけである。**
 * - **【禁止】「規約が置き換わった」と読まない**(限定4)—— **`resolveDetailViewTarget` の
 *   本体は1バイトも変わっておらず、宣言が無い画面の挙動は今日と同じである。**
 *
 * ## 2026-08-05 `v5-merge-repair-2` で測り方を入れ替えた1本
 *
 * **`FIELD_TYPES` 8 / `RESOURCE_KINDS` 7 / `DIFF_OPS` 16 の3定数を焼き込んでいた1本**
 * (`ADR-0173` 限定9)**が、`V5-M16`(`ADR-0161` / `ADR-0214` で `FIELD_TYPES` 8 → 9)の
 * マージによって赤くなった。****定数を追随させるのではなく、着手前の中身を名前で持つ形と
 * 「3形目が要素を足していない」形の2本に入れ替えた。**
 * **測らなくなったのは「3配列の総量」1点である**(詳細は当該テストの直上のコメントと
 * `docs/plan/v5/records/v5-merge-repair-2.md` §4 / §5)。
 * **【禁止】「これで同じ事故は起きなくなった」と読まない** —— **同じ形の焼き込みは、この
 * ファイルの中にもあと4本残っている**(`$defs` 28 / `$defs/view.properties` 28 /
 * `$defs/view_action.properties` の6キー / `view_changes` 23)。
 */

import { describe, expect, test } from "bun:test";
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import { foldOperations } from "./apply-diff.ts";
import type { Manifest, Operation, View } from "./types.ts";
import { DIFF_OPS, FIELD_TYPES, RESOURCE_KINDS } from "./types.ts";
import { validateManifest, validateManifestFull } from "./validate.ts";

/** 足した3つ目の形を表すキー。**1本だけである**(`ADR-0173` 限定1 / 限定2)。 */
const KEY = "view";

type Any = Record<string, unknown>;

function defs(): Record<string, Any> {
  return (manifestSchema as unknown as { $defs: Record<string, Any> }).$defs;
}

function viewActionSchema(): Any {
  return defs().view_action as Any;
}

/** `list_view` / `form` / `detail_view` の3分岐(`$defs/view.allOf` の並び順)。 */
function viewBranches(): [Any, Any, Any] {
  return (defs().view as Any).allOf as unknown as [Any, Any, Any];
}

function baseManifest(views: View[]): Manifest {
  return {
    app: {
      id: "shop",
      name: "店",
      tables: [
        {
          id: "orders",
          name: "注文",
          fields: [
            { id: "memo", name: "メモ", type: "text" },
            { id: "amount", name: "金額", type: "number" },
            { id: "status", name: "状態", type: "select", options: ["受付", "発送", "完了"] },
          ],
        },
        {
          id: "carts",
          name: "カート",
          fields: [{ id: "order", name: "注文", type: "reference", reference_table: "orders" }],
        },
      ],
      views,
    },
  } as unknown as Manifest;
}

function listView(actions: unknown[], id = "order-list"): View {
  return {
    id,
    type: "list_view",
    table: "orders",
    columns: ["memo"],
    actions,
  } as unknown as View;
}

function detailView(actions?: unknown[], id = "order-detail"): View {
  return {
    id,
    type: "detail_view",
    table: "orders",
    ...(actions === undefined ? {} : { actions }),
  } as unknown as View;
}

function cartForm(): View {
  return { id: "cart-form", type: "form", table: "carts", fields: ["order"] } as unknown as View;
}

function cartList(): View {
  return {
    id: "cart-list",
    type: "list_view",
    table: "carts",
    columns: ["order"],
  } as unknown as View;
}

function cartDetail(): View {
  return { id: "cart-detail", type: "detail_view", table: "carts" } as unknown as View;
}

/** 今日も通らなければならない1つ目の形(遷移)。 */
const NAVIGATE_ACTION = { form: "cart-form", prefill: { field: "order" } };
/** 今日も通らなければならない2つ目の形(値の書換)。**`detail_view` にだけ書ける。** */
const SET_ACTION = { set: { field: "status", value: "完了" } };
/** 足した3つ目の形。 */
const LINK_ACTION = { [KEY]: "cart-list" };

// ---------------------------------------------------------------------------
// 限定1 / 限定2: 形は3形で閉じる。3形目に書けるのはビューID 1つだけ
// ---------------------------------------------------------------------------

describe("(T01-1) 操作起点の形は3形である(`ADR-0173` 限定1)", () => {
  /*
   * **【`V5-M25-T01` / `L-G8` / `ADR-0174` による追随。当時の期待値を隠さない】**
   * **旧: `toHaveLength(3)`** —— **`ADR-0174` が4形目(自動処理の起動 = `run`)を足した。**
   * **`ADR-0173` の増分(3形目 = `view`)は今日も1形である。**
   */
  test("`$defs/view_action.oneOf` の分岐はちょうど4本である(着手前は 2。`ADR-0173` が3本目、`ADR-0174` が4本目)", () => {
    const oneOf = viewActionSchema().oneOf as unknown[];
    expect(Array.isArray(oneOf)).toBe(true);
    expect(oneOf).toHaveLength(4);
  });

  test("`additionalProperties: false` を1バイトも外していない", () => {
    expect(viewActionSchema().additionalProperties).toBe(false);
  });

  test("3形目の `required` は `view` 1本だけである", () => {
    const oneOf = viewActionSchema().oneOf as Any[];
    expect([...((oneOf[2] as Any).required as string[])].sort()).toEqual([KEY]);
  });

  test("既存2形の `required` は1バイトも変わっていない", () => {
    const oneOf = viewActionSchema().oneOf as Any[];
    expect([...((oneOf[0] as Any).required as string[])].sort()).toEqual(["form", "prefill"]);
    expect([...((oneOf[1] as Any).required as string[])].sort()).toEqual(["set"]);
  });

  test("3形は排他である(2つを1要素に混ぜると拒否される)", () => {
    for (const action of [
      { ...NAVIGATE_ACTION, [KEY]: "cart-list" },
      { ...SET_ACTION, [KEY]: "cart-list" },
      { ...NAVIGATE_ACTION, ...SET_ACTION },
    ]) {
      expect(
        validateManifest(baseManifest([listView([action]), cartForm(), cartList(), detailView()]))
          .valid,
        JSON.stringify(action),
      ).toBe(false);
    }
  });

  test("3形目に未知のキーは1つも書けない(`additionalProperties:false`)", () => {
    for (const action of [
      { [KEY]: "cart-list", url: "https://example.com" },
      { [KEY]: "cart-list", app: "other" },
      { [KEY]: "cart-list", target: "_blank" },
      { [KEY]: "cart-list", record: "$record._id" },
    ]) {
      expect(
        validateManifest(baseManifest([listView([action]), cartList(), detailView()])).valid,
        JSON.stringify(action),
      ).toBe(false);
    }
  });

  test("3形目に書けるのは `view` / `name` / `visible_when` の3キーだけである(限定2)", () => {
    const ok = [
      { [KEY]: "cart-list" },
      { [KEY]: "cart-list", name: "カートを見る" },
      { [KEY]: "cart-list", visible_when: { field: "status", equals: "受付" } },
    ];
    for (const action of ok) {
      expect(
        validateManifestFull(baseManifest([listView([action]), cartList(), detailView()])),
        JSON.stringify(action),
      ).toEqual({ valid: true });
    }
  });

  test("3形目に条件・複数・既定値式・演算を1つも書けない(限定2)", () => {
    for (const value of [["cart-list"], { id: "cart-list" }, 1, true, null]) {
      expect(
        validateManifest(baseManifest([listView([{ [KEY]: value }]), cartList(), detailView()]))
          .valid,
        JSON.stringify(value),
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 限定3: 行き先は同じアプリの list_view / detail_view だけ
// ---------------------------------------------------------------------------

describe("(T02-1) 行き先は同じアプリの一覧か詳細だけである(`ADR-0173` 限定3)", () => {
  test("行き先が `list_view` なら通る", () => {
    expect(
      validateManifestFull(baseManifest([listView([LINK_ACTION]), cartList(), detailView()])),
    ).toEqual({ valid: true });
  });

  test("行き先が `detail_view` なら通る", () => {
    expect(
      validateManifestFull(
        baseManifest([listView([{ [KEY]: "cart-detail" }]), cartDetail(), detailView()]),
      ),
    ).toEqual({ valid: true });
  });

  test("行き先が `form` の差分は apply 時に拒否される(遷移形が担う領分である)", () => {
    const result = validateManifestFull(
      baseManifest([listView([{ [KEY]: "cart-form" }]), cartForm(), detailView()]),
    );
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result)).toContain("cart-form");
  });

  test("実在しないビューIDを指した差分は apply 時に拒否される", () => {
    const result = validateManifestFull(
      baseManifest([listView([{ [KEY]: "nowhere" }]), cartList(), detailView()]),
    );
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result)).toContain("nowhere");
  });

  test("自分自身を指してもよい(壊れない)", () => {
    expect(
      validateManifestFull(baseManifest([listView([{ [KEY]: "order-list" }]), detailView()])),
    ).toEqual({ valid: true });
  });

  test("外部 URL / 別アプリのIDは `$defs/resource_id` の形で構造的に書けない", () => {
    for (const value of [
      "https://example.com/checkout",
      "/apps/other/views/cart-list",
      "other:cart-list",
      "../cart-list",
    ]) {
      expect(
        validateManifest(baseManifest([listView([{ [KEY]: value }]), cartList(), detailView()]))
          .valid,
        value,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 限定1 の対: L-G7 は却下である。3形目は detail_view に書けない
// ---------------------------------------------------------------------------

describe("(T04-1) `L-G7` は却下である —— 3形目は詳細画面に書けない(非対称が残る)", () => {
  test("`detail_view` に3形目を書いた差分は拒否される", () => {
    expect(
      validateManifest(
        baseManifest([detailView([LINK_ACTION]), cartList(), listView([NAVIGATE_ACTION])]),
      ).valid,
    ).toBe(false);
  });

  test("`detail_view` 分岐が `actions.items.properties.view` を `false` で閉じている", () => {
    const [, , detailBranch] = viewBranches();
    const actions = ((detailBranch.then as Any).properties as Any).actions as Any;
    expect(((actions.items as Any).properties as Any)[KEY]).toBe(false);
  });

  test("`detail_view` の既存2形は1バイトも変わっていない(今日どおり両方通る)", () => {
    expect(
      validateManifestFull(baseManifest([detailView([NAVIGATE_ACTION, SET_ACTION]), cartForm()])),
    ).toEqual({ valid: true });
  });

  test("`form` 分岐の `actions: false` は1バイトも解いていない", () => {
    const [, formBranch] = viewBranches();
    expect(((formBranch.then as Any).properties as Any).actions).toBe(false);
  });

  /*
   * **【`V5-M25-T07` / `L-G3` による追随。旧を隠さない】**
   * **`ADR-0171` 限定10 の順序拘束(「`ADR-0175` の規則が実装されるまで、一覧の set 形を
   * 実装しない」)は、`V5-M25-T03` が規則を実装したことで**解けた**。**
   * **【禁止】これを「二重押しが防げるようになったから解いた」と読まない** ——
   * **set 形の冪等性は今日も1つも無い**(`ADR-0100` §限界1 は1バイトも無効化されていない)。
   */
  test("一覧の `set` 形は書けるようになった(`V5-M25-T07` で順序拘束が解けた)", () => {
    const [listBranch] = viewBranches();
    const actions = ((listBranch.then as Any).properties as Any).actions as Any;
    expect((actions.items ?? {}) as Any).toEqual({});
    expect(validateManifest(baseManifest([listView([SET_ACTION]), detailView()])).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 限定8 / 限定9 / 限定10: 語彙の本数を1つも動かさない
// ---------------------------------------------------------------------------

describe("(T01-2) 語彙の本数(`ADR-0173` 限定8 / 限定9)", () => {
  // 【`V5-M29-T04` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
  //   消したテスト名(逐語): 「`$defs` は 28 のままである(新しい `$defs` を1本も作っていない)」
  //   そのブロックが測っていたもの:
  //     - `$defs` は 28 のままである(新しい `$defs` を1本も作っていない)
  //   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `manifest.$defs:` で始まる行)。
  //   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
  //   検出力0のまま `Ran` を水増しする)。
  //   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。

  // **【`V5-M29-T04` / `ADR-0250` 限定14 がテスト名を更新した】** 旧名(逐語)は
  // 「**`$defs/view.properties` は 28 のままである(`link` というトップレベルキーを作っていない)**」。
  // **総量 28 を固定していた `expect` を中央へ移したので、この test に残るのは
  // 「`link` というキーが無い」の名指し(C-3)だけである。**
  test("`$defs/view.properties` に `link` というトップレベルキーを作っていない", () => {
    // 【`V5-M29-T04` / `ADR-0250` 限定11】ここにあった「`$defs/view.properties` は 28 のままである(`link` というトップレベルキーを作っていない)」の検査は
    //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
    //   `manifest.$defs.view.properties:` で始まる行)。**総量ではなく名前と順序で見張る。**
    //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
    expect(Object.keys((defs().view as Any).properties as Any)).not.toContain("link");
  });

  /*
   * **【`V5-M23-T02` / `L-G14` / `ADR-0177` 限定1 で 6 → 7 に更新した】**
   *
   * **旧テスト名(逐語)**: 「**`$defs/view_action.properties` は 5 → 6 である(増えたのは
   * `view` 1本だけ)**」。**7キー目 `audience` を足したのは `ADR-0173`(本ファイルが
   * 固定している審査)ではない** —— **`V5-M20` 面4 の `L-G14` が門A の本審査を新規に
   * 通して足した**(判定 = 限定採用。`ADR-0177`)。**`ADR-0173` の増分は今日も
   * `view` 1本である。****測る位置を「全量の一致」から「`view` がちょうど1本」へ
   * 弱めていない** —— **全量で測り続ける**(後続が別のキーを足したらここが赤くなる)。
   */
  /*
   * **【`V5-M25-T01` / `L-G8` / `ADR-0174` による追随】** **旧テスト名(逐語)**:
   * 「**`$defs/view_action.properties` は 6 → 7 である(`ADR-0173` が増やしたのは
   * `view` 1本だけ)**」。**8キー目 `run` を足したのは `ADR-0174` であり、
   * `ADR-0173` の増分は今日も `view` 1本である。**
   * **測る位置を「全量の一致」から弱めていない** —— **全量で測り続ける。**
   */
  /*
   * **【`V8-M17` / `J-G9`(`ADR-0007` 門A 本審査 = 限定採用)による追随。2026-08-09】**
   * **9キー目 `id`(ボタンの識別子)を足したのは `V8-M17` であり、役割に束ねた規則から
   * ボタンを名指しするためである。****旧文・旧値を1バイトも消していない。**
   * **【期待値を1つの数字に揃えてはならない。メインの裁定 `R-13-1` / 審査の申し送り2】**
   * **`V8-M17` 時点で9キー、`V8-M20` が `audience` を消して8キーに戻る。**
   * **【`V8-M20-T01` / 台帳 `J-G29` / 手続きは `ADR-0301`。2026-08-10】**
   * **`audience` が廃止されたので、予告どおり9キー → 8キーに戻した。**
   * **旧値の逐語は 9 で、消えたキーの逐語は `audience` である。**
   * **代わりに担うのは `app.roles[].rules` の「役割 × 対象(表)× 書込」と
   * 「役割 × 対象(ボタン)× 読取」の2本である。****旧文を1バイトも消していない。**
   */
  test("`$defs/view_action.properties` は 8 である(`ADR-0173` が増やしたのは `view` 1本だけ)", () => {
    expect(Object.keys(viewActionSchema().properties as Any).sort()).toEqual([
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

  /*
   * **【2026-08-05 `v5-merge-repair-2` で測り方を入れ替えた】**
   *
   * **旧テスト名(逐語)**: 「**`FIELD_TYPES` 8 / `RESOURCE_KINDS` 7 / `DIFF_OPS` 16 を
   * 1つも動かしていない**」。**本体は `toHaveLength(8)` / `(7)` / `(16)` の3行だった。**
   *
   * **なぜ赤くなったか**: **`V5-M16`(`ADR-0161` / `ADR-0214`。門A 本審査・判定 = 限定採用)が
   * `FIELD_TYPES` に9種目 `file` を足した。** **`V5-M22` と `V5-M16` は同じ分岐点
   * (`c31ac07`)から並行しており、`V5-M22` のマージ(`ae480a0`)の時点では 8 だった。**
   * **`ADR-0173` 限定9 は「`V5-M22` が `Δ1` を1度も発火させない」という**この差し替えに
   * ついての**約束であって、リポジトリ全体の恒久的な不変条件ではない** —— **`ADR-0173` §6
   * の無効化リストに `ADR-0161` は1件も挙がっておらず、逆も無い。****したがって
   * `V5-M16` は `ADR-0173` の限定に違反していない。****直すのは検査の側である。**
   *
   * **なぜ「8 を 9 に書き換える」を採らなかったか**: **その定数はもはや `V5-M22` について
   * 何も測っていない。** **測っているのは「`V5-M22` 以後、誰も `FIELD_TYPES` を触って
   * いないこと」であり、後続が門Aを通して正当に足すたびに人手で追随することになる。**
   * **実測: `V5-M16` の追随先はリポジトリ全体で 32 箇所あった**(本行を除く。
   * `docs/plan/v5/records/v5-merge-repair-2.md` §5)。
   *
   * **入れ替え後に測っているもの(どちらも後続の追随を要求しない)**:
   * 1. **`V5-M22` 着手前(`ae480a0^1` = `c31ac07`)の3配列の中身が、今日も全部実在する**
   *    —— **`V5-M22` は1つも消していない・改名していない。**
   * 2. **3形目(行き先の宣言)は3配列のどれにも要素を足していない** —— **行き先を運ぶのは
   *    `$defs/view_action` の中のキー1本と既存の op `update_view` だけである。**
   *
   * **測らなくなったもの(1点)**: **3配列の**総量**が 8 / 7 / 16 であること。**
   * **今日は 9 / 7 / 16 である。****このファイルは、誰かが語彙を1つ**足した**ことを
   * もう1件も検出しない。** **総量の見張りは他の 32 / 27 / 30 箇所に残っている**
   * (実数と場所は `v5-merge-repair-2.md` §5)。
   *
   * **弱い点**: **2 の「3形目が足していない」は、名前が行き先らしいかどうかで見る形であり、
   * 網羅ではない。** **`V5-M22` が行き先と無関係な名前で1つ足していたら、この検査は
   * 拾えない**(履歴の差分では拾えている —— `git diff c31ac07 4c26930 -- src/kernel/types.ts`
   * は3配列の要素を1行も動かしていない。**ただしそれは今日走る検査ではない**)。
   */
  const FIELD_TYPES_AT_V5_M22: readonly string[] = [
    "text",
    "long_text",
    "number",
    "boolean",
    "date",
    "select",
    "reference",
    "image",
  ];
  const RESOURCE_KINDS_AT_V5_M22: readonly string[] = [
    "app",
    "table",
    "form",
    "list_view",
    "detail_view",
    "workflow",
    "function",
  ];
  const DIFF_OPS_AT_V5_M22: readonly string[] = [
    "add_table",
    "add_field",
    "add_view",
    "update_view",
    "remove_field",
    "remove_table",
    "change_table",
    "change_field",
    "remove_view",
    "add_workflow",
    "update_workflow",
    "remove_workflow",
    "add_function",
    "update_function",
    "remove_function",
    "set_theme",
  ];

  test("`V5-M22` は `FIELD_TYPES` / `RESOURCE_KINDS` / `DIFF_OPS` から1つも消していない", () => {
    expect(FIELD_TYPES as readonly string[]).toEqual(
      expect.arrayContaining([...FIELD_TYPES_AT_V5_M22]),
    );
    expect(RESOURCE_KINDS as readonly string[]).toEqual(
      expect.arrayContaining([...RESOURCE_KINDS_AT_V5_M22]),
    );
    expect(DIFF_OPS as readonly string[]).toEqual(expect.arrayContaining([...DIFF_OPS_AT_V5_M22]));
  });

  test("行き先の宣言は `FIELD_TYPES` / `RESOURCE_KINDS` / `DIFF_OPS` に1つも要素を足していない(`Δ1` 不発火)", () => {
    const fieldTypes = FIELD_TYPES as readonly string[];
    const resourceKinds = RESOURCE_KINDS as readonly string[];
    const diffOps = DIFF_OPS as readonly string[];

    // 3形目が使う語は `$defs/view_action` の中のキー1本(`view`)だけである。
    expect(fieldTypes).not.toContain(KEY);
    expect(resourceKinds).not.toContain(KEY);
    expect(diffOps).not.toContain(KEY);

    // 「行き先」を名乗る語を、3配列のどこにも作っていない。
    for (const word of ["link", "url", "href", "destination", "navigate", "view_action"]) {
      expect(fieldTypes).not.toContain(word);
      expect(resourceKinds).not.toContain(word);
      expect(diffOps).not.toContain(word);
    }
    for (const op of ["add_link", "set_link", "link_view", "add_view_action", "update_link"]) {
      expect(diffOps).not.toContain(op);
    }

    // 行き先を運ぶのは今日も既存の op である(新しい op を作っていない)。
    expect(diffOps).toContain("update_view");
  });

  // 【`V5-M29-T04` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
  //   消したテスト名(逐語): 「`schemas/diff.schema.json` の `$defs/view_changes.properties` は 23 のままである」
  //   そのブロックが測っていたもの:
  //     - `schemas/diff.schema.json` の `$defs/view_changes.properties` は 23 のままである
  //   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `diff.$defs.view_changes.properties:` で始まる行)。
  //   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
  //   検出力0のまま `Ran` を水増しする)。
  //   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。
});

// ---------------------------------------------------------------------------
// update_view の経路(判定を2箇所に住まわせない)
// ---------------------------------------------------------------------------

describe("(T02-2) `update_view` でも同じ1箇所が判定する", () => {
  const before = (): Manifest =>
    baseManifest([listView([NAVIGATE_ACTION]), cartForm(), cartList(), detailView()]);

  /**
   * **畳み込み + 適用後マニフェストの検証。** **`schema` の `allOf` と参照整合は畳み込んだ
   * 後の1箇所(`validateManifestFull`)が見る** —— `view-changes-actions.test.ts` の
   * `apply()` と同じ形であり、**判定を2箇所に住まわせない。**
   */
  function apply(operations: Operation[]): { valid: boolean; manifest?: Manifest } {
    const folded = foldOperations(before(), operations);
    if (!folded.valid) {
      return { valid: false };
    }
    return validateManifestFull(folded.manifest).valid
      ? { valid: true, manifest: folded.manifest }
      : { valid: false };
  }

  function updateView(id: string, actions: unknown[]): Operation[] {
    return [{ op: "update_view", view: id, changes: { actions } } as unknown as Operation];
  }

  test("一覧の `actions` を3形目に差し替えられる", () => {
    const result = apply(updateView("order-list", [LINK_ACTION]));
    expect(result.valid).toBe(true);
    const view = result.manifest?.app.views.find((v) => v.id === "order-list") as Any;
    expect(view.actions).toEqual([LINK_ACTION]);
  });

  test("詳細画面の `actions` を3形目に差し替える `update_view` は拒否される(`L-G7` 却下の対)", () => {
    expect(apply(updateView("order-detail", [LINK_ACTION])).valid).toBe(false);
  });

  test("行き先が実在しない `update_view` は拒否される", () => {
    expect(apply(updateView("order-list", [{ [KEY]: "nowhere" }])).valid).toBe(false);
  });
});
