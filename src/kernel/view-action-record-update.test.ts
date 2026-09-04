/**
 * **詳細画面の操作起点の2つ目の形**(`V4-M20-T01`。`ADR-0100` 限定1〜限定8)。
 *
 * ## これは何で、何ではないか
 *
 * - **通したのは「今開いているレコードの1フィールドを1つのリテラル値に書き換える」1形だけ
 *   である。**
 * - **【禁止】「ボタンで処理を走らせられるようになった」と読まない**(`ADR-0100` §限界3)
 *   —— **`trigger.type` は今日も3種で、ワークフローを名指しで起こす形は1つも無い。**
 * - **【禁止】「二重押しが防げるようになった」と読まない**(同 §限界1)—— **冪等ではない。
 *   押した回数だけ書込が起き、`on_update` もそのたびに発火する。**
 * - **【禁止】「一覧の行から押せるようになった」と読まない**(同 §限界2)—— **`actions` は
 *   今日も `detail_view` だけである。**
 *
 * ## 【本数の実測が限定表と食い違う】
 *
 * **`ADR-0100` 限定8 は「`$defs` の本数(28)を1つも動かさない」と書いており、そこは
 * 今日の実測と一致する。** **一方 `ADR-0100` は `$defs/view.properties` を「22」、
 * `$defs/field.properties` を「11」と記した実施記録(`v4-m20.md` §2a-3)の上に立っているが、
 * **今日の実測は 26 / 12 である**(`V4-M18` の `modal`・`V4-M22` の `search_fields` /
 * `page_size`・`V4-M19` の `preset_density` / `hide_when_empty` が後から入った)。
 * **本タスクはそのどちらも1つも動かさない**ので、食い違いは増分ではなく起点だけである。
 * **`ADR-0100` の本文を1バイトも書き換えていない。**
 */

import { describe, expect, test } from "bun:test";
import diffSchema from "../../schemas/diff.schema.json" with { type: "json" };
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import type { Manifest, View } from "./types.ts";
import { validateManifest, validateManifestFull } from "./validate.ts";

/** 足した2つ目の形を表すキー。**1本だけである**(`ADR-0100` 限定1 / 限定2)。 */
const KEY = "set";

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
          id: "orders",
          name: "注文",
          fields: [
            { id: "memo", name: "メモ", type: "text" },
            { id: "amount", name: "金額", type: "number" },
            { id: "paid", name: "支払済", type: "boolean" },
            { id: "status", name: "状態", type: "select", options: ["受付", "発送", "完了"] },
            { id: "due", name: "期日", type: "date" },
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

function detailView(actions: unknown[]): View {
  return {
    id: "order-detail",
    type: "detail_view",
    table: "orders",
    actions,
  } as unknown as View;
}

function cartForm(): View {
  return {
    id: "cart-form",
    type: "form",
    table: "carts",
    fields: ["order"],
  } as unknown as View;
}

/** 今日も通らなければならない1つ目の形(遷移)。 */
const NAVIGATE_ACTION = { form: "cart-form", prefill: { field: "order" } };

// ---------------------------------------------------------------------------
// 限定1: 形は列挙された2形だけ。3つ目の形を書けない
// ---------------------------------------------------------------------------

describe("(T01-1) 操作起点の形は2形だけである(ADR-0100 限定1)", () => {
  /*
   * **【`V5-M22-T01` / `L-G5` / `L-G6` / `ADR-0173` 限定1 で 2 → 3 に更新した】**
   *
   * **旧テスト名(逐語)**: 「**$defs/view_action は oneOf を持ち、その分岐はちょうど
   * 2本である**」。**`describe` の名前(「操作起点の形は2形だけである(ADR-0100 限定1)」)は
   * `ADR-0100` の判定そのものなので1バイトも書き換えていない** —— **その限定1 の「2形だけ」
   * という**数**は `ADR-0173` によって改まった**(`docs/adr/0100-view-action-record-update.md`
   * の Status 直下の改訂注に逐語で書いてある)。
   * **3形目(行き先の宣言 = `view` 1キー)は `V5-M20` 面2 が門A の本審査を新規に通して
   * 足したものである**(判定 = 限定採用)—— **`ADR-0100` §3a-1 が求めた手続き(門A の
   * 本審査 + 同格の個別 ADR)を実際に踏んだ。**
   * **`oneOf` による排他と `additionalProperties: false` は1バイトも解けていない。**
   * **3形目は `list_view` にしか書けない**(`L-G7` = 却下)—— **`detail_view` については
   * 「2形だけ」が今日も真である**(直下の検査がそれを固定している)。
   */
  /*
   * **【`V5-M25-T01` / `L-G8` / `ADR-0174` による追随。当時の期待値を隠さない】**
   * **旧: `toHaveLength(3)`** —— **`ADR-0174` が4形目(自動処理の起動 = `run`)を足した。**
   * **【テスト名の後半は今日から偽である。書き換えた】** **旧名の逐語**:
   * 「**`detail_view` では今日も2形だけ**」。**4形目は `detail_view` にも書ける**
   * (`ADR-0174` は形を型で閉じていない)—— **詳細画面で書けないのは3形目(`view`)だけである。**
   */
  test("$defs/view_action は oneOf を持ち、その分岐は4本である(`detail_view` に書けないのは3形目だけ)", () => {
    const oneOf = viewActionSchema().oneOf as unknown[];
    expect(Array.isArray(oneOf)).toBe(true);
    expect(oneOf).toHaveLength(4);
  });

  test("3形目は detail_view に書けない(`ADR-0100` 限定1 は詳細画面については今日も真である)", () => {
    expect(
      validateManifest(baseManifest([cartForm(), detailView([{ view: "cart-form" }])])).valid,
    ).toBe(false);
  });

  test("additionalProperties: false を1バイトも外していない", () => {
    expect(viewActionSchema().additionalProperties).toBe(false);
  });

  test("1つ目の形(遷移)は今日どおり通る", () => {
    expect(validateManifestFull(baseManifest([cartForm(), detailView([NAVIGATE_ACTION])]))).toEqual(
      {
        valid: true,
      },
    );
  });

  test("2つ目の形(値の書換)が通る", () => {
    expect(
      validateManifestFull(
        baseManifest([detailView([{ [KEY]: { field: "status", value: "完了" } }])]),
      ),
    ).toEqual({ valid: true });
  });

  test("2形を1要素に混ぜると拒否される(排他である)", () => {
    expect(
      validateManifest(
        baseManifest([
          cartForm(),
          detailView([{ ...NAVIGATE_ACTION, [KEY]: { field: "status", value: "完了" } }]),
        ]),
      ).valid,
    ).toBe(false);
  });

  test("どちらの形でもない要素は拒否される(3つ目の形が書けない)", () => {
    for (const action of [
      {},
      { name: "押す" },
      { form: "cart-form" },
      { prefill: { field: "order" } },
      { workflow: "resend" },
      { [KEY]: { field: "status", value: "完了" }, form: "cart-form" },
    ]) {
      expect(
        validateManifest(baseManifest([cartForm(), detailView([action])])).valid,
        JSON.stringify(action),
      ).toBe(false);
    }
  });

  test("未知のキーは今日どおり1つも書けない", () => {
    for (const action of [
      { ...NAVIGATE_ACTION, confirm: true },
      { [KEY]: { field: "status", value: "完了" }, confirm: true },
    ]) {
      expect(
        validateManifest(baseManifest([cartForm(), detailView([action])])).valid,
        JSON.stringify(action),
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 限定2 / 限定3: フィールド1つ × リテラル値1つ。式を1つも書けない
// ---------------------------------------------------------------------------

describe("(T01-2) 書換はフィールド1つ × リテラル値1つ(ADR-0100 限定2 / 限定3)", () => {
  test("set の properties は field / value の2本で、additionalProperties: false である", () => {
    const set = viewActionSchema().properties as Any;
    const body = set[KEY] as Any;
    expect(Object.keys(body.properties as Any)).toEqual(["field", "value"]);
    expect(body.required).toEqual(["field", "value"]);
    expect(body.additionalProperties).toBe(false);
  });

  test("値の型は string / number / boolean の3つだけである(配列もオブジェクトも受けない)", () => {
    const body = (viewActionSchema().properties as Any)[KEY] as Any;
    const value = (body.properties as Any).value as Any;
    expect(value.type).toEqual(["string", "number", "boolean"]);
  });

  test("複数フィールドを同時に書き換える形が書けない(field は1つ)", () => {
    for (const set of [
      { fields: ["status", "memo"], value: "完了" },
      { field: ["status", "memo"], value: "完了" },
      { field: "status", value: "完了", field2: "memo" },
    ]) {
      expect(
        validateManifest(baseManifest([detailView([{ [KEY]: set }])])).valid,
        JSON.stringify(set),
      ).toBe(false);
    }
  });

  test("演算子・条件式・関数呼び出しのキーを1つも書けない", () => {
    for (const set of [
      { field: "amount", value: { add: 1 } },
      { field: "amount", expression: "amount + 1" },
      { field: "status", value: "完了", when: { field: "paid", equals: true } },
      { field: "status", value: ["完了"] },
      { field: "status", value: null },
    ]) {
      expect(
        validateManifest(baseManifest([detailView([{ [KEY]: set }])])).valid,
        JSON.stringify(set),
      ).toBe(false);
    }
  });

  test("$record. 参照は文字列として書けるが、リテラルとして扱われる(式にならない)", () => {
    /*
     * **`$record.` を schema で拒否していない。** 値は「string / number / boolean のリテラル
     * 1つ」であり、`"$record.amount"` はその文字列そのものが書き込まれる ——
     * **参照として解決する経路を1本も作っていない**(`web/src/views/DetailViewRenderer.tsx` の
     * `handleSetAction` は `set.value` をそのまま `PATCH` の本文に載せるだけである)。
     * **`ADR-0013` `action_value` 限定12 の `$record.` 解決はワークフローの側だけである。**
     *
     * **【正直に書く】「書き込まれた値が文字列 `$record.amount` そのものである」ことを
     * 実データで確かめてはいない** —— 確かめたのは「この宣言が apply 時に通ること」と
     * 「表示層が値を加工せずに送ること」の2つだけである。
     */
    expect(
      validateManifestFull(
        baseManifest([detailView([{ [KEY]: { field: "memo", value: "$record.amount" } }])]),
      ),
    ).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// 限定4: 対象は「今開いているレコード」1行だけ
// ---------------------------------------------------------------------------

describe("(T01-3) 対象は今開いているレコード1行だけ(ADR-0100 限定4)", () => {
  /*
   * **【V5-M21-T01 / `L-G1` / `ADR-0171` で書き換えた。2本のテスト名も本体も変えた】**
   *
   * **着手前の2本は次を期待していた**(逐語):
   * - 「`list_view` / form では今日どおり "actions": false である」→ `["form","list_view"]`
   * - 「`list_view` に actions を書くと拒否される(**2形のどちらでも**)」
   *
   * **`ADR-0171`(門A / 判定 = 限定採用)が `list_view` 分岐の `"actions": false,` を
   * 解いたので、前者は今日 form だけ・後者は set 形だけが真である。**
   * **`ADR-0100` §限界2 の逐語「一覧からは押せない」は `ADR-0171` §7 の1番が
   * 「全部」無効化した。****`ADR-0100` 限定4 の前半(対象は1行だけ)は1ミリも動いて
   * いない** —— 下の「複数行を指すキーが1本も無い」が今日も緑である。
   * **`ADR-0100` の本文を1バイトも書き換えていない**(front matter の `amended_by` と
   * Status 直下の改訂注だけを足した)。
   */
  test('form では今日どおり "actions": false である(list_view は ADR-0171 が解いた)', () => {
    const view = defs().view as Any;
    const branches = view.allOf as { if: Any; then?: Any }[];
    const forbidden = branches
      .filter((branch) => (branch.then?.properties as Any)?.actions === false)
      .map((branch) => ((branch.if.properties as Any).type as Any)?.const);
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値に `report_view` を足した。**
    // **旧行の逐語**: `expect(forbidden.sort()).toEqual(["form"]);`
    // **書き換えた理由**: **画面種別に4種目(集計表)が加わり、その分岐でも `actions` は
    // `false` で閉じてある** —— **これは `Q-G21c`(集計表にも操作起点を置けるようにする)の
    // **却下**の帰属先そのものであり、`$defs/view_action` は1バイトも触っていない。**
    // **「form では今日どおり `actions: false` である」という本来の主張は1ミリも
    // 弱めていない。**
    expect(forbidden.sort()).toEqual(["form", "report_view"]);
  });

  test("list_view に書けるのは遷移の形だけで、set 形は今日も拒否される(ADR-0171 限定10)", () => {
    const listWith = (action: unknown): View =>
      ({
        id: "order-list",
        type: "list_view",
        table: "orders",
        columns: ["memo"],
        actions: [action],
      }) as unknown as View;
    expect(validateManifest(baseManifest([cartForm(), listWith(NAVIGATE_ACTION)])).valid).toBe(
      true,
    );
    /*
     * **【`V5-M25-T07` / `L-G3` による追随。旧を隠さない】** **旧**: `toBe(false)`
     * —— **`ADR-0171` 限定10 の順序拘束により一覧の set 形が閉じていた。**
     * **`V5-M25-T03` が `ADR-0175` の規則を実装したので拘束が解けた。**
     * **`ADR-0100` 限定4(対象は1行だけ)は1ミリも弱まっていない** ——
     * **一覧でも対象は押した行1行だけである**(複数行を指すキーは今日も1本も無い。下の test)。
     */
    expect(
      validateManifest(
        baseManifest([cartForm(), listWith({ [KEY]: { field: "status", value: "完了" } })]),
      ).valid,
    ).toBe(true);
  });

  test("複数行を指すキー(records / rows / selection)が view_action に1本も無い", () => {
    const keys = Object.keys(viewActionSchema().properties as Any);
    for (const forbidden of ["records", "rows", "selection", "targets", "all"]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// 限定5: trigger.type を1バイトも触らない
// ---------------------------------------------------------------------------

describe("(T01-4) ワークフローを名指しで起こす形を作らない(ADR-0100 限定5)", () => {
  /*
   * **【`V5-M25-T01` / `L-G8` / `ADR-0174` 無効化条文1 による追随。旧を隠さない】**
   * **旧テスト名(逐語)**: 「**トリガー種別は今日も3種である**」。
   * **`ADR-0100` 限定5(逐語「`trigger.type` を1バイトも触らない」「トリガーは今日も3種」)は
   * `ADR-0174` が**全部**無効化した**(同 §7 の1)。
   * **名指しで禁じられた4つ(`on_delete` / `on_view` / `on_undo` / `on_error`)は
   * 今日も1つも足していない** —— **そこは1ミリも弱めていない。**
   */
  test("トリガー種別は4種である(`ADR-0100` 限定5 は `ADR-0174` が無効化した)", () => {
    const trigger = defs().workflow_trigger as Any;
    const type = (trigger.properties as Any).type as Any;
    expect(type.enum).toEqual(["on_create", "on_update", "schedule", "manual"]);
    for (const forbidden of ["on_delete", "on_view", "on_undo", "on_error"]) {
      expect(type.enum as string[]).not.toContain(forbidden);
    }
  });

  /*
   * **【`V5-M25-T01` / `L-G8` / `ADR-0174` 無効化条文1 による追随。旧を隠さない】**
   * **旧テスト名(逐語)**: 「**view_action にワークフローを指すキーが1本も無い**」。
   * **旧の禁止語 4つ(逐語)**: `["workflow", "function", "capability", "run"]`。
   * **今日は `run` が実在する** —— **`ADR-0174` が4形目の唯一のキーとして足した。**
   * **残る3つ(`workflow` / `function` / `capability`)は今日も1つも無い** ——
   * **島(function)を名指しで起こす形も、capability を直に指す形も1つも作っていない**
   * (`ADR-0174` 限定7。`L-G9` = 将来送り)。**そこは1ミリも弱めていない。**
   */
  test("view_action に島や capability を指すキーは今日も1本も無い(`run` はワークフローだけを指す)", () => {
    const keys = Object.keys(viewActionSchema().properties as Any);
    for (const forbidden of ["workflow", "function", "capability"]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
    expect(keys).toContain("run");
  });
});

// ---------------------------------------------------------------------------
// 限定7: 型と値の対応を apply 時に検査する(「書けるが効かない」を1つも作らない)
// ---------------------------------------------------------------------------

describe("(T01-5) 宣言したフィールドと値を apply 時に検査する(ADR-0100 限定7)", () => {
  test("対象テーブルに無いフィールドを指すと拒否される", () => {
    const result = validateManifestFull(
      baseManifest([detailView([{ [KEY]: { field: "nope", value: "完了" } }])]),
    );
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result)).toContain("nope");
  });

  test("型の合わない値は拒否される(number 列に文字列 / text 列に数値 / boolean 列に文字列)", () => {
    for (const set of [
      { field: "amount", value: "1000" },
      { field: "memo", value: 1000 },
      { field: "paid", value: "true" },
      { field: "paid", value: 1 },
    ]) {
      const result = validateManifestFull(baseManifest([detailView([{ [KEY]: set }])]));
      expect(result.valid, JSON.stringify(set)).toBe(false);
    }
  });

  test("型の合う値は通る(8型のうち JS 型が一致するもの)", () => {
    for (const set of [
      { field: "amount", value: 1000 },
      { field: "memo", value: "済" },
      { field: "paid", value: true },
      { field: "status", value: "完了" },
      { field: "due", value: "2026-08-04" },
    ]) {
      expect(
        validateManifestFull(baseManifest([detailView([{ [KEY]: set }])])),
        JSON.stringify(set),
      ).toEqual({ valid: true });
    }
  });

  test("select の options に無い値は拒否される", () => {
    const result = validateManifestFull(
      baseManifest([detailView([{ [KEY]: { field: "status", value: "キャンセル" } }])]),
    );
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result)).toContain("キャンセル");
  });

  test("date 列に ISO8601 でない値は拒否される", () => {
    expect(
      validateManifestFull(
        baseManifest([detailView([{ [KEY]: { field: "due", value: "きのう" } }])]),
      ).valid,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 限定8: 型・リソース種・diff op・$defs の本数を1つも動かさない
// ---------------------------------------------------------------------------

describe("(T01-6) 語彙の総量(ADR-0100 限定8)", () => {
  // 【`V5-M29-T04` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
  //   消したテスト名(逐語): 「RESOURCE_KINDS 7 / FIELD_TYPES 8 / DIFF_OPS 16 / $defs 28 が1つも動かない」
  //   そのブロックが測っていたもの:
  //     - RESOURCE_KINDS は 7 である
  //     - FIELD_TYPES は 9 である(テスト名は 8 と書いていた)
  //     - DIFF_OPS は 17 である(テスト名は 16 と書いていた)
  //     - $defs の本数は 28 である
  //   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `RESOURCE_KINDS:` / `FIELD_TYPES:` /
  //   `DIFF_OPS:` / `manifest.$defs:` で始まる行)。
  //   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
  //   検出力0のまま `Ran` を水増しする)。
  //   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。

  // 【`V5-M29-T04` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
  //   消したテスト名(逐語): 「$defs/view.properties は 26 のままである(本タスクは1本も足していない)」
  //   そのブロックが測っていたもの:
  //     - $defs/view.properties の本数(**テスト名は 26 と書いていたが、本体は 28 を固定していた**
  //       —— `v5-merge-repair-2.md` §5-2 が名指しした既知の食い違いである。**test ごと消えたので
  //       この食い違いも消えた**)
  //   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `manifest.$defs.view.properties:` で始まる行)。
  //   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
  //   検出力0のまま `Ran` を水増しする)。
  //   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。

  test("$defs/field.properties は 12 のままである(本タスクは1本も足していない)", () => {
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

  /*
   * **【V5-M21-T03 / `L-G4` / `ADR-0172` で書き換えた】** **着手前のテスト名は
   * 「view_changes に actions は今日も無い(update_view で書けない)」であり、本体は
   * `not.toContain("actions")` を期待していた。****今日は偽である** —— **`ADR-0172`
   * (門A / 判定 = 限定採用)が `view_changes` に `actions` を1本足した(22 → 23)。**
   * **`ADR-0100` 限定8(語彙の総量)が言っているのは `$defs` / `FIELD_TYPES` /
   * `RESOURCE_KINDS` / `DIFF_OPS` の本数であり、そこは1つも動いていない** ——
   * **`DIFF_OPS` は今日も16である**(新しい op を作らず `update_view` の中に入れた)。
   * **`ADR-0100` の本文を1バイトも書き換えていない。**
   */
  test("view_changes に actions が入った(ADR-0172)。DIFF_OPS は 16 のままである", () => {
    const viewChanges = (diffSchema as unknown as { $defs: Record<string, Any> }).$defs
      .view_changes as Any;
    expect(Object.keys(viewChanges.properties as Any)).toContain("actions");
    expect(Object.keys(viewChanges.properties as Any)).not.toContain("related");
  });
});
