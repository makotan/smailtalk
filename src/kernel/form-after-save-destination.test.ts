/**
 * **保存が成立したあとの行き先**(`V4-M20-T04`。`ADR-0102` 限定1〜限定9)。
 *
 * ## これは何で、何ではないか
 *
 * - **通したのは「どの画面へ行くか」の宣言1本だけである。**
 * - **【禁止】「2段階の確認ができるようになった」と読まない**(`ADR-0102` §限界1)——
 *   **`E-G33`(入力→確認→確定)は1ミリも解けていない。**
 * - **【禁止】「送信ボタンの文言が選べるようになった」と読まない**(§限界2)——
 *   **`保存` は今日も全アプリ共通である。**
 * - **【禁止】「成功・失敗で行き先を分けられる」と読まない**(§限界3)—— **行き先は1つである。**
 *
 * ## 【本数の実測が限定表と食い違う】
 *
 * **`ADR-0102` 限定1 は「`$defs/view.properties` を **22 → 23**」と書いているが、それは
 * `V4-M18` の `modal` / `V4-M22` の `search_fields` / `page_size` / `V4-M19` の
 * `preset_density` が入る前の実測である。** **今日の増分は 26 → 27 である。**
 * **`view_changes` も「16」ではなく **20 → 21** である。**
 * **守ったのは「1本だけ足す」という増分であって、限定表が写した絶対値ではない。**
 * **`ADR-0102` の本文を1バイトも書き換えていない。**
 */

import { describe, expect, test } from "bun:test";
import diffSchema from "../../schemas/diff.schema.json" with { type: "json" };
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import { foldOperations } from "./apply-diff.ts";
import type { Manifest, View } from "./types.ts";
import { validateManifest, validateManifestFull } from "./validate.ts";

/** 足したキー。**1本だけである**(`ADR-0102` 限定1)。 */
const KEY = "after_save";

type Any = Record<string, unknown>;

function defs(): Record<string, Any> {
  return (manifestSchema as unknown as { $defs: Record<string, Any> }).$defs;
}

function viewSchema(): Any {
  return defs().view as Any;
}

function viewChanges(): Any {
  return (diffSchema as unknown as { $defs: Record<string, Any> }).$defs.view_changes as Any;
}

function baseManifest(views: View[]): Manifest {
  return {
    app: {
      id: "shop",
      name: "店",
      tables: [
        { id: "orders", name: "注文", fields: [{ id: "memo", name: "メモ", type: "text" }] },
      ],
      views,
    },
  } as unknown as Manifest;
}

function formView(overrides: Record<string, unknown> = {}): View {
  return {
    id: "order-form",
    type: "form",
    table: "orders",
    fields: ["memo"],
    ...overrides,
  } as unknown as View;
}

function listView(): View {
  return {
    id: "order-list",
    type: "list_view",
    table: "orders",
    columns: ["memo"],
  } as unknown as View;
}

function detailView(): View {
  return { id: "order-detail", type: "detail_view", table: "orders" } as unknown as View;
}

// ---------------------------------------------------------------------------
// 限定1 / 限定2: 足すキーは1本だけ / 値はビューID 1つだけ
// ---------------------------------------------------------------------------

describe("(T04-1) 足すキーは $defs/view に1本だけ(ADR-0102 限定1 / 限定2)", () => {
  // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。ADR = `0359` §4b。題名の数を直した】**
  // **旧名の逐語**: `$defs/view.properties は今日 30 で、その26本目(添字25)が本キーである`
  // **本キーの位置(26本目)は1バイトも動いていない。動いたのは総数だけである。**
  test("$defs/view.properties は今日 31 で、その26本目(添字25)が本キーである", () => {
    const keys = Object.keys(viewSchema().properties as Any);
    // **【V4-M23-T01 / ADR-0104 限定1 で 27 → 28 に更新した】** 28キー目 `sum_field`
    // (合計を出す列。`list_view` でだけ書ける)が門A を通って増えた(判定 = 限定採用)。
    // **本 ADR(ADR-0102)の増分ではない —— `after_save` が27本目であることは今日も真である。**
    // **【`V6-M2-T01` / `K-G2` / `ADR-0289` 限定1 で 28 → 29 に更新した】** 29キー目 `reference_pickers`
    // (参照項目の選び方の、入力画面ごとの上書き)が門A を通って増えた(`V6-M0` 単位A。判定 = 限定採用)。
    // **`form` 型のビューでだけ書ける。****本 ADR の増分ではない。**
    // **【`V8-M20-T01` / 台帳 `J-G27` / 手続きは `ADR-0301` で 29 → 28 に更新した】** 19キー目
    // だった `audience`(この画面を見せる相手)が**廃止された**(判定 = 廃止)。**代わりに担うのは
    // `app.roles[].rules` の「役割 × 対象(画面)× 読取」である。****旧値の逐語は 29。**
    // **このリポジトリで語彙が減ったのはこれが初めてであり、増分ではなく減分である。**
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 28 → 29 へ書き換えた。**
    // **旧行の逐語**: `expect(keys).toHaveLength(28);`
    // **書き換えた理由**: この行が固定していたのは「**その決定**が `$defs/view.properties` の本数 を増やさなかったこと」であり、
    // **29本目を足したのは別の決定である**(`V8-M8` が 集計表の宣言 `report` を29キー目として足した)。**検査は消していない。**
    // **【2026-08-20。`V10-M1-T02`。台帳 `NV-G4`。門A 本審査 = `V10-M0` 群A。ADR = `0359`】**
    // **期待値を 29 → 30 へ書き換えた。****旧行の逐語**: `expect(keys).toHaveLength(29);`
    // **30本目を足したのは別の決定である**(`ADR-0359` §4a 限定1 が削除後の行き先
    // `after_delete` を**末尾に**30キー目として足した)。**本キーの添字25 は1つも動いていない。**
    // **検査は消していない。****本 ADR の増分ではない。**
    // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
    // **期待値を 30 → 31 へ書き換えた。****旧行の逐語**: `expect(keys).toHaveLength(30);`
    // **31本目を足したのは別の決定である**(`ADR-0359` §4b 限定1 が一続きの流れの中の段
    // `flow` を**末尾に**31キー目として足した。**`list_view` / `form` / `detail_view` の3種別で
    // 書け、集計表(`report_view`)には書けない**)。
    // **本ファイルが測っている決定の増分ではない。****検査は消していない。**
    expect(keys).toHaveLength(31);
    // **【`V8-M20-T01` / 台帳 `J-G27` / `ADR-0301` で見る位置を1つ手前へ直した】** **19キー目だった
    // `audience` が廃止されたので、それより後ろのキーの添字が1つずつ繰り上がった。**
    // **期待値を緩めていない**(位置は今日も1つに固定される)。
    expect(keys[25]).toBe(KEY);
  });

  test("値は既存の resource_id を $ref で受ける", () => {
    // 【`V5-M29-T03` / `ADR-0250` 限定11】ここにあった「$defs の本数 28 が1つも増えていない」の検査は
    //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
    //   `manifest.$defs:` で始まる行)。**総量ではなく名前と順序で見張る。**
    //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
    // 【`V5-M29-T03`】**テスト名を書き換えた。** 旧: 「$defs の本数 28 が1つも増えていない(値は既存の resource_id を $ref で受ける)」。
    //   本体から `$defs` の本数を測る `expect` が消えたため(記録 §4-7)。
    const property = (viewSchema().properties as Any)[KEY] as Any;
    expect(property.$ref).toBe("#/$defs/resource_id");
  });

  test("値は文字列1つであり、配列にもオブジェクトにもできない", () => {
    for (const value of [["order-list"], { view: "order-list" }, 1, true, null]) {
      expect(
        validateManifest(baseManifest([listView(), formView({ [KEY]: value })])).valid,
        JSON.stringify(value),
      ).toBe(false);
    }
  });

  test("$defs/field 12 が1つも動かない(限定9)", () => {
    // 【`V5-M29-T03` / `ADR-0250` 限定11】ここにあった `RESOURCE_KINDS` の本数の検査は
    //   `scripts/vocabulary-drift.test.ts` へ移した(一覧の `RESOURCE_KINDS:` で始まる行)。
    //   **総量ではなく名前と順序で見張る。**
    //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
    // 【`V5-M29-T03` / `ADR-0250` 限定11】同じく `FIELD_TYPES` の本数の検査も移した(一覧の `FIELD_TYPES:` で始まる行)。
    //   消した行に付いていた逐語: 「【`V5-M16` / `ADR-0161`】8 → 9(`file` が9種目)。**この行が固定していたのは
    //   「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**」
    //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
    // 【`V5-M29-T03` / `ADR-0250` 限定11】同じく `DIFF_OPS` の本数の検査も移した(一覧の `DIFF_OPS:` で始まる行)。
    //   消した行に付いていた逐語: 「【`V5-M17b` / `ADR-0248`】16 → 17(`set_user_kinds` が17種目)。**この行が固定していたのは
    //   「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**」
    //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
    // 【`V5-M29-T03`】**テスト名を書き換えた。** 旧: 「RESOURCE_KINDS 7 / FIELD_TYPES 8 / DIFF_OPS 16 / $defs/field 12 が1つも動かない(限定9)」。
    //   本体から語彙3種を測る `expect` が消えたため(記録 §4-7)。
    //   **`FIELD_TYPES 8` / `DIFF_OPS 16` は消す前から本体が 9 / 17 を測っており、食い違っていた。**
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
// 限定3: form 型のビューでだけ書ける
// ---------------------------------------------------------------------------

describe("(T04-2) form 型のビューでだけ書ける(ADR-0102 限定3)", () => {
  test("form には書ける", () => {
    expect(
      validateManifestFull(baseManifest([listView(), formView({ [KEY]: "order-list" })])),
    ).toEqual({ valid: true });
  });

  /*
   * **【2026-08-20。`V10-M1-T01` / `NV-G3a` / `ADR-0358` 限定1 で契約ごと書き直した】**
   *
   * **旧テスト名の逐語**: 「list_view / detail_view に書くと拒否される」。
   * **旧本体の逐語**: `detail_view` を `list_view` と並べて `validateManifest(...).valid` が
   * `false` であることを見ていた。
   *
   * **書き直した理由**: **門A の本審査(`V10-M0` 群A。判定 = 限定採用)が
   * `manifest.schema.json` の `detail_view` 分岐の `"after_save": false,` を解いた** ——
   * **`detail_view` は今日書ける。** **`ADR-0102` 限定3 は `ADR-0358` §4 が
   * `detail_view` の分だけ引き直しており、`ADR-0102` の本文は1バイトも書き換えていない。**
   * **弱めたのは `detail_view` の1種別だけである** —— **`list_view` と `report_view` は
   * 今日も1バイトも解いていない**(`NV-G3b` = **却下**)。**検査は消していない。**
   */
  test("list_view / report_view に書くと拒否される(detail_view は ADR-0358 で書けるようになった)", () => {
    for (const view of [
      { id: "order-list", type: "list_view", table: "orders", columns: ["memo"], [KEY]: "x" },
      {
        id: "order-report",
        type: "report_view",
        table: "orders",
        report: { group_by: [{ field: "memo" }], aggregates: [{ id: "n", type: "count" }] },
        [KEY]: "x",
      },
    ]) {
      expect(
        validateManifest(baseManifest([view as unknown as View])).valid,
        String((view as Any).type),
      ).toBe(false);
    }
  });

  test("detail_view には書ける(ADR-0358 限定1。発火は set 形の書込が成立したときだけである)", () => {
    // **器だけを見る。** **`set` の成立でだけ移ることと `run` の後は移らないことは
    // `web/test/detail-view-after-save.test.tsx` が測る。**
    expect(
      validateManifestFull(
        baseManifest([listView(), { ...(detailView() as Any), [KEY]: "order-list" } as never]),
      ),
    ).toEqual({ valid: true });
  });

  /*
   * **【2026-08-20。`V10-M1-T01` / `NV-G3a` / `ADR-0358` 限定1 でテスト名と期待値を
   * 書き直した】**
   *
   * **旧テスト名の逐語**: 「allOf の list_view / detail_view の分岐が false で閉じている
   * (actions と同じ作法)」。
   * **旧行の逐語**: `expect(forbidden.sort()).toEqual(["detail_view", "list_view", "report_view"]);`
   *
   * **書き直した理由**: **`ADR-0358` が `detail_view` 分岐の `"after_save": false,` を
   * 外した。** **閉じている分岐は 3 → 2 に減った** —— **本ファイルで `false` の分岐が
   * 減るのはこれが初めてである。** **`list_view` / `report_view` は1バイトも解いていない。**
   */
  test("allOf の list_view / report_view の分岐が false で閉じている(actions と同じ作法)", () => {
    const branches = viewSchema().allOf as { if: Any; then?: Any }[];
    const forbidden = branches
      .filter((branch) => (branch.then?.properties as Any)?.[KEY] === false)
      .map((branch) => ((branch.if.properties as Any).type as Any)?.const);
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値に `report_view` を足した。**
    // **旧行の逐語**: `expect(forbidden.sort()).toEqual(["detail_view", "list_view"]);`
    // **書き換えた理由**: **画面種別に4種目(集計表)が加わり、その分岐でも `after_save` は
    // `false` で閉じてある。****「`form` 型のビューでだけ書ける」という本来の主張は1ミリも
    // 弱めていない** —— **むしろ閉じている分岐が1つ増えた。**
    // **【2026-08-20。`V10-M1-T01` / `ADR-0358` 限定1】期待値から `detail_view` を落とした。**
    // **旧行の逐語**: `expect(forbidden.sort()).toEqual(["detail_view", "list_view", "report_view"]);`
    expect(forbidden.sort()).toEqual(["list_view", "report_view"]);
  });
});

// ---------------------------------------------------------------------------
// 限定4 / 限定5 / 限定6: 条件分岐・確認の段・ボタン文言を1つも作らない
// ---------------------------------------------------------------------------

describe("(T04-3) 分岐も確認の段もボタン文言も1つも作らない(ADR-0102 限定4〜限定6)", () => {
  test("成功 / 失敗で分けるキーを1本も持たない", () => {
    const keys = Object.keys(viewSchema().properties as Any);
    for (const forbidden of [
      "after_save_success",
      "after_save_failure",
      "on_success",
      "on_error",
      "confirm",
      "confirm_view",
      "submit_label",
      "button_label",
    ]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  // **【2026-08-20。`V10-M1-T02`。台帳 `NV-G4`。ADR = `0359`。テスト名を直した】**
  // **着手前の名前は「行き先のキーは1本だけである(2本目を足していない)」であり、
  // 今日は偽である** —— **門A の本審査(`V10-M0` 群A。判定 = 限定採用)が
  // 削除の後の行き先 `after_delete` を2本目として足した。**
  // **`ADR-0102`(本ファイルが測っている決定)の増分が2本になったのではない** ——
  // **2本目を足したのは `ADR-0359` である。****どの ADR の限定が何を増やしたかを混ぜない。**
  // **3本目を足していないことは今日も固定する**(期待値は2本ちょうどの列である)。
  test("行き先のキーは今日2本ちょうどで、ADR-0102 の増分はそのうち1本である", () => {
    const keys = Object.keys(viewSchema().properties as Any);
    expect(keys.filter((key) => key.includes("after"))).toEqual([KEY, "after_delete"]);
  });

  test("送信ボタンの文言は今日も1つに固定されている", async () => {
    const source = await Bun.file(
      new URL("../../web/src/views/FormRenderer.tsx", import.meta.url),
    ).text();
    // **`web/src/views/FormRenderer.tsx` の送信ボタンの文言は `保存` の1つだけである。**
    // **文言を宣言から読む形を1つも作っていない**(マニフェストの値が入る余地が無い)。
    expect(source).toContain("            保存\n");
    for (const forbidden of ["submit_label", "submitLabel", "buttonLabel"]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// 限定8: 遷移先の実在を apply 時に検査する
// ---------------------------------------------------------------------------

describe("(T04-4) 遷移先の実在を apply 時に検査する(ADR-0102 限定8)", () => {
  test("実在しないビューIDを指すと拒否される", () => {
    const result = validateManifestFull(baseManifest([formView({ [KEY]: "nope" })]));
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result)).toContain("nope");
  });

  test("自分自身を指してもよい(壊れない。無限ループは起きない = 保存のたびに同じ form へ戻るだけ)", () => {
    expect(validateManifestFull(baseManifest([formView({ [KEY]: "order-form" })]))).toEqual({
      valid: true,
    });
  });

  test("別テーブルのビューを指してもよい(書いた表と見せたい表が違う場合に応える)", () => {
    const manifest = {
      app: {
        id: "shop",
        name: "店",
        tables: [
          { id: "orders", name: "注文", fields: [{ id: "memo", name: "メモ", type: "text" }] },
          { id: "carts", name: "カート", fields: [{ id: "memo", name: "メモ", type: "text" }] },
        ],
        views: [
          { id: "cart-form", type: "form", table: "carts", fields: ["memo"], [KEY]: "order-list" },
          { id: "order-list", type: "list_view", table: "orders", columns: ["memo"] },
        ],
      },
    } as unknown as Manifest;
    expect(validateManifestFull(manifest)).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// 完了条件7: update_view で書けるようにするかを1つに決めた
// ---------------------------------------------------------------------------

describe("(T04-5) update_view で後から書ける(T04 完了条件7 の決定)", () => {
  /*
   * **決めた: `view_changes` に足す(20 → 21)。**
   *
   * **根拠は `ADR-0084` 限定6 の1文目である**(逐語)——
   * 「**`audience` の穴を新しいキーで踏み直さない**(`ADR-0080` 限定3 と同じ精神)」。
   * **`audience` / `related` / `actions` を足すことは `ADR-0084` の射程外である**という
   * 2文目は今日も守っている(本タスクはその3本に1バイトも触っていない)。
   * **`menu_listed` / `field_groups` / `preset_list_shape` / `modal` / `search_fields` /
   * `page_size` / `preset_density` の7本が、いずれも同じ判断で `view_changes` に入っている**
   * —— **本キーだけを外すと、また「後から変えられないキー」を1本増やすことになる。**
   *
   * **【正直に書く】足しても外せるようにはならない** —— `update_view` はキーを消す手段を
   * 持たないので、**一度書いた行き先は前進では消せない**(別のビューIDに差し替えるか、
   * `undo` で戻すか、`remove_view` + `add_view` で作り直すかである)。
   */
  // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。ADR = `0359` §Decision 2。題名の数を直した】**
  // **旧名の逐語**: `view_changes.properties は今日 26 で、after_save は21本目である(制定時は 21 ちょうどだった)`
  test("view_changes.properties は今日 27 で、after_save は21本目である(制定時は 21 ちょうどだった)", () => {
    const keys = Object.keys(viewChanges().properties as Any);
    // **【V4-M23-T01 / ADR-0104 限定2 で 21 → 22 に更新した】** 22キー目 `sum_field`
    // (合計を出す列。`list_view` でだけ書ける)が `update_view` にも加わった
    // (値は `applyViewChanges` の `list_view` 分岐が実際に運ぶ)。
    // **本 ADR(ADR-0102)の増分ではない —— `after_save` が21本目であることは今日も真である。**
    // **【`V6-M2-T02` / `K-G3` / `ADR-0289` 限定1 で 23 → 24 に更新した】** 24キー目 `reference_pickers`
    // (参照項目の選び方の、入力画面ごとの上書き。`form` でだけ書ける)が `update_view` にも加わった
    // (値は `applyViewChanges` の `form` 分岐が実際に運ぶ)。**本 ADR の増分ではない。**
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 24 → 25 へ書き換えた。**
    // **旧行の逐語**: `expect(keys).toHaveLength(24);`
    // **書き換えた理由**: この行が固定していたのは「**その決定**が `view_changes.properties` の本数 を増やさなかったこと」であり、
    // **25本目を足したのは別の決定である**(`V8-M8` が 集計表の宣言 `report` を25キー目として足した)。**検査は消していない。**
    // **【2026-08-20。`V10-M1-T02`。台帳 `NV-G4`。ADR = `0359`】期待値を 25 → 26 へ書き換えた。**
    // **旧行の逐語**: `expect(keys).toHaveLength(25);`
    // **26本目を足したのは別の決定である**(`ADR-0359` §Decision 2 が `after_delete` を
    // `view_changes` の**末尾に**足した)。**本キーの添字20 は1つも動いていない。**
    // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
    // **期待値を 26 → 27 へ書き換えた。****旧行の逐語**: `expect(keys).toHaveLength(26);`
    // **27本目を足したのは別の決定である**(`flow` を `view_changes` の末尾に足した。
    // `ADR-0359` §Decision 2)。**本ファイルが測っている決定の増分ではない。**
    // **検査は消していない。**
    expect(keys).toHaveLength(27);
    expect(keys[20]).toBe(KEY);
  });

  test("update_view で書いた値が、適用後のマニフェストに実際に残る", () => {
    const before = baseManifest([listView(), formView()]);
    const folded = foldOperations(before, [
      { op: "update_view", view: "order-form", changes: { [KEY]: "order-list" } },
    ] as never);
    expect(folded.valid).toBe(true);
    if (!folded.valid) {
      throw new Error("fold failed");
    }
    expect((folded.manifest.app.views[1] as Any)[KEY]).toBe("order-list");
    expect(validateManifestFull(folded.manifest)).toEqual({ valid: true });
  });

  /*
   * **【2026-08-20。`V10-M1-T01` / `NV-G3a` / `ADR-0358` 限定8 で契約ごと書き直した】**
   *
   * **旧テスト名の逐語**: 「list_view / detail_view を対象にした update_view はキー単位で
   * 拒否される」。**旧本体の逐語**: `for (const target of ["order-list", "order-detail"])`。
   *
   * **書き直した理由**: **`after_save` は着手前から `view_changes` に在るので、
   * `ADR-0358` が `detail_view` 分岐の `false` を外した時点で、`update_view` でも
   * 後から書けるようになった**(`ADR-0358` 限定8 がそのことを明示的に「決めた」と書き、
   * 検査で固定させている)。**その固定は
   * `src/kernel/detail-view-after-save.test.ts` の (T01-d) が持つ。**
   * **`schemas/diff.schema.json` には1バイトも触っていない**(限定8 前半)。
   */
  test("list_view を対象にした update_view はキー単位で拒否される(detail_view は ADR-0358 で書けるようになった)", () => {
    for (const target of ["order-list"]) {
      const folded = foldOperations(baseManifest([listView(), detailView(), formView()]), [
        { op: "update_view", view: target, changes: { [KEY]: "order-list" } },
      ] as never);
      expect(folded.valid, target).toBe(false);
    }
  });

  test("update_view で実在しないビューIDへ差し替えると、畳み込み後の検証が差分全体を拒否する", () => {
    const folded = foldOperations(baseManifest([listView(), formView()]), [
      { op: "update_view", view: "order-form", changes: { [KEY]: "nope" } },
    ] as never);
    // **畳み込み自体は通る**(キーは form に書けるので op としては正しい)。
    expect(folded.valid).toBe(true);
    if (!folded.valid) {
      throw new Error("fold failed");
    }
    // **倒すのは畳み込み後のマニフェスト検証である**(判定を2箇所に住まわせない)。
    expect(validateManifestFull(folded.manifest).valid).toBe(false);
  });
});
