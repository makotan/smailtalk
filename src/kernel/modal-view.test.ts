/**
 * **「この画面は重ねて出す」の宣言**(`V4-M18-T03`。`ADR-0095` 限定1〜限定6 / 限定11)。
 *
 * ## これは何で、何ではないか
 *
 * - **通したのは真偽値1つである**(限定2)。**大きさ・位置・重ね順・閉じ方を1つも選べない**
 *   (`ADR-0095` §Decision 3 の 6)。
 * - **【禁止】「AI が部品を選べるようになった」と読まない** —— **`P-G26` は 2026-08-03 に
 *   4回目の却下である**(`ADR-0096`)。**部品を既製の呼び名で選ぶ語彙は1バイトも増えていない。**
 * - **【禁止】「重ねて出す画面を自由に作れる」と読まない** —— **`type` が `form` の画面だけで、
 *   メニューに並ぶ画面には書けない**(限定4 / 限定5)。
 * - **【禁止】「モーダルが出せるようになった」と読まない** —— **宣言を器に当てるのは
 *   `V4-M18-T04` である**(`ADR-0095` §Decision 3 の 1)。
 *
 * ## 語彙の総量(**1つも動かしていないことを、ここで数える**)
 *
 * `RESOURCE_KINDS` 7 / `FIELD_TYPES` 8 / `DIFF_OPS` 16 / `$defs` 28 /
 * `$defs/theme` 25・25 / `$defs/field` 11 —— **すべて着手前と同じである。**
 * **動いたのは `$defs/view.properties`(22 → 23)と `view_changes.properties`(16 → 17)の2つだけ。**
 */

import { describe, expect, test } from "bun:test";
import diffSchema from "../../schemas/diff.schema.json" with { type: "json" };
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import { foldOperations } from "./apply-diff.ts";
import type { FormView, Manifest, View } from "./types.ts";
import { validateManifest, validateManifestFull } from "./validate.ts";

/** 足したキーの名前。**1本だけである**(`ADR-0095` 限定1)。 */
const KEY = "modal";

function defs(): Record<string, { properties: Record<string, unknown>; required?: string[] }> {
  return (manifestSchema as unknown as { $defs: Record<string, never> }).$defs as never;
}

function viewSchema(): {
  properties: Record<string, unknown>;
  allOf: { if: unknown; then: { properties?: Record<string, unknown>; required?: string[] } }[];
} {
  return defs().view as never;
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
          fields: [{ id: "memo", name: "メモ", type: "text" }],
        },
      ],
      views,
    },
  } as unknown as Manifest;
}

function form(overrides: Partial<FormView> = {}): View {
  return {
    id: "order-form",
    type: "form",
    table: "orders",
    fields: ["memo"],
    ...overrides,
  } as unknown as View;
}

// ---------------------------------------------------------------------------
// 限定1: 足すキーは `$defs/view` に1本だけ / 語彙の総量は1つも動かない
// ---------------------------------------------------------------------------

describe("(T03-1) 語彙の総量(ADR-0095 限定1)", () => {
  test("$defs/view の properties が 23 になり、その23本目が本キーである", () => {
    const keys = Object.keys(viewSchema().properties);
    // **【V4-M22-T01 / ADR-0112 限定1 で 23 → 24 に更新した】** 門A の本審査(V4-M22 単位A。
    // 判定 = 限定採用)が24キー目 `search_fields`(検索の対象にする列)を末尾に足した。
    // **本 ADR の増分ではない —— `modal` が23キー目(0-based index 22)であることは
    // 今日も真である。**
    // **【V4-M22-T05 / ADR-0113 限定1 で 24 → 25 に更新した】** 門A の本審査(V4-M22 単位C。
    // **4回目の審査**。判定 = 限定採用)が25キー目 `page_size`(1ページに出す件数)を
    // 末尾に足した。**本 ADR の増分ではない —— `modal` が23キー目(0-based index 22)で
    // あることは今日も真である。**
    // **【V4-M19-T03 / ADR-0118 限定1 で 25 → 26 に更新した】** 26キー目 `preset_density`
    // (画面の詰まり具合)が門A を通って増えた(V4-M19 単位C。2回目の審査。判定 = 限定採用)。
    // **3種すべてに書けるキーである。****本 ADR の増分ではない —— `modal` が23キー目
    // (0-based index 22)であることは今日も真である。**
    // **【V4-M20-T04 / ADR-0102 限定1 で 26 → 27 に更新した】** 27キー目 `after_save`
    // (保存が成立したあとに行く画面のID)が門A を通って増えた(V4-M20 単位D。2回目の審査。
    // 判定 = 限定採用)。**form 型のビューでだけ書ける。****本 ADR の増分ではない —— `modal`
    // が23キー目(0-based index 22)であることは今日も真である。**
    // **【V4-M23-T01 / ADR-0104 限定採用で 27 → 28 に更新した】** 28キー目 `sum_field`
    // (合計を出す列)が門A を通って増えた。**`list_view` でだけ書ける。****本 ADR の増分では
    // ない —— `modal` が23キー目(0-based index 22)であることは今日も真である。**
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
    // `after_delete` を**末尾に**30キー目として足した。**`detail_view` でだけ書ける**)。
    // **本ファイルが測っている決定の増分ではない。****検査は消していない。**
    // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
    // **期待値を 30 → 31 へ書き換えた。****旧行の逐語**: `expect(keys).toHaveLength(30);`
    // **31本目を足したのは別の決定である**(`ADR-0359` §4b 限定1 が一続きの流れの中の段
    // `flow` を**末尾に**31キー目として足した。**`list_view` / `form` / `detail_view` の3種別で
    // 書け、集計表(`report_view`)には書けない**)。
    // **本ファイルが測っている決定の増分ではない。****検査は消していない。**
    expect(keys).toHaveLength(31);
    expect(keys).toContain(KEY);
    // **22キー目までの並びを1バイトも動かしていない**(末尾に足した)。
    // **【`V8-M20-T01` / 台帳 `J-G27` / `ADR-0301` で見る位置を1つ手前へ直した】** **19キー目だった
    // `audience` が廃止されたので、それより後ろのキーの添字が1つずつ繰り上がった。**
    // **期待値を緩めていない**(位置は今日も1つに固定される)。
    expect(keys[21]).toBe(KEY);
  });

  // 【`V5-M29-T03` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
  //   消したテスト名(逐語): 「$defs の本数 28 が1つも増えていない(新しい $defs を作らない)」
  //   そのブロックが測っていたもの:
  //     - `expect(Object.keys(defs())).toHaveLength(28)`
  //   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `manifest.$defs:` で始まる行)。
  //   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
  //   検出力0のまま `Ran` を水増しする)。
  //   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。

  test("$defs/theme 25・25 / $defs/field 12 が1つも動かない", () => {
    expect(Object.keys(defs().theme?.properties ?? {})).toHaveLength(25);
    expect(defs().theme?.required ?? []).toHaveLength(25);
    // **【V4-M19-T07 / ADR-0119 限定1 で 11 → 12 に更新した】** 12キー目 `hide_when_empty`
    // (値が無いとき行ごと出さない)が門A を通って増えた(V4-M19 単位E-a。2回目の審査。
    // 判定 = 限定採用)。**8型すべてに書けるキーである。****本 ADR の増分ではない。**
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
    expect(Object.keys(defs().field?.properties ?? {})).toHaveLength(12);
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
    // 【`V5-M29-T03`】**テスト名を書き換えた。** 旧: 「$defs/theme 25・25 / $defs/field 11 / RESOURCE_KINDS 7 / FIELD_TYPES 8 / DIFF_OPS 16 が1つも動かない」。
    //   本体から語彙3種を測る `expect` が消えたため(記録 §4-7)。**`$defs/field 11` は消す前から本体が 12 を測っており、食い違っていた。**
  });
});

// ---------------------------------------------------------------------------
// 限定2: 値は真偽値1つ。enum にしない
// ---------------------------------------------------------------------------

describe("(T03-2) 値は真偽値1つ(ADR-0095 限定2)", () => {
  test("schema の型が boolean で、enum も pattern も minLength も無い", () => {
    const property = viewSchema().properties[KEY] as Record<string, unknown>;
    expect(property.type).toBe("boolean");
    expect(property.enum).toBeUndefined();
    expect(property.pattern).toBeUndefined();
    expect(property.minLength).toBeUndefined();
  });

  test("文字列も数値も受けない", () => {
    for (const value of ["true", 1, "modal", {}]) {
      const result = validateManifest(
        baseManifest([form({ [KEY]: value } as unknown as Partial<FormView>)]),
      );
      expect(result.valid, JSON.stringify(value)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 限定3: 既定は「重ねない」。既定を反転させない
// ---------------------------------------------------------------------------

describe("(T03-3) 既定は「重ねない」(ADR-0095 限定3)", () => {
  test("本キーは必須ではなく、書かないマニフェストが今日どおり通る", () => {
    const required = (viewSchema() as unknown as { required?: string[] }).required ?? [];
    expect(required).not.toContain(KEY);
    expect(validateManifest(baseManifest([form()]))).toEqual({ valid: true });
  });

  test("false と明示しても通る", () => {
    expect(
      validateManifest(baseManifest([form({ [KEY]: false } as unknown as Partial<FormView>)])),
    ).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// 限定4: 書けるのは `type` が `form` の画面だけ
// ---------------------------------------------------------------------------

describe("(T03-4) 書けるのは form だけ(ADR-0095 限定4)", () => {
  test("form には書ける", () => {
    expect(
      validateManifest(
        baseManifest([form({ [KEY]: true, menu_listed: false } as unknown as Partial<FormView>)]),
      ),
    ).toEqual({ valid: true });
  });

  test("list_view / detail_view の分岐で false になっている", () => {
    const branches = viewSchema().allOf;
    for (const type of ["list_view", "detail_view"]) {
      const branch = branches.find(
        (candidate) =>
          ((candidate.if as { properties?: { type?: { const?: string } } }).properties?.type
            ?.const ?? "") === type,
      );
      expect(branch?.then.properties?.[KEY], type).toBe(false);
    }
  });

  test("list_view に書くと差分全体が拒否される", () => {
    const result = validateManifest(
      baseManifest([
        {
          id: "order-list",
          type: "list_view",
          table: "orders",
          columns: ["memo"],
          [KEY]: true,
        } as unknown as View,
      ]),
    );
    expect(result.valid).toBe(false);
  });

  test("detail_view に書くと差分全体が拒否される", () => {
    const result = validateManifest(
      baseManifest([
        {
          id: "order-detail",
          type: "detail_view",
          table: "orders",
          [KEY]: true,
        } as unknown as View,
      ]),
    );
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 限定5: `menu_listed` を偽にしていない画面には書けない
// ---------------------------------------------------------------------------

describe("(T03-5) menu_listed を偽にしていない画面には書けない(ADR-0095 限定5)", () => {
  test("menu_listed を書いていない form に書くと拒否される", () => {
    const result = validateManifest(
      baseManifest([form({ [KEY]: true } as unknown as Partial<FormView>)]),
    );
    expect(result.valid).toBe(false);
  });

  test("menu_listed: true の form に書くと拒否される", () => {
    const result = validateManifest(
      baseManifest([form({ [KEY]: true, menu_listed: true } as unknown as Partial<FormView>)]),
    );
    expect(result.valid).toBe(false);
  });

  test("menu_listed: false なら通る", () => {
    expect(
      validateManifest(
        baseManifest([form({ [KEY]: true, menu_listed: false } as unknown as Partial<FormView>)]),
      ),
    ).toEqual({ valid: true });
  });

  test("重ねない画面(false / 未記述)は menu_listed に1ミリも縛られない", () => {
    expect(
      validateManifest(
        baseManifest([form({ [KEY]: false, menu_listed: true } as unknown as Partial<FormView>)]),
      ),
    ).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// 限定6: view_changes にも同じキーを1本 / カーネルが値を実際に運ぶ
// ---------------------------------------------------------------------------

describe("(T03-6) update_view で後から書けて、値が実際に運ばれる(ADR-0095 限定6)", () => {
  test("diff.schema.json の view_changes が 16 → 17 になっている", () => {
    const changes = (diffSchema as unknown as { $defs: { view_changes: { properties: object } } })
      .$defs.view_changes.properties;
    const keys = Object.keys(changes);
    // **【V4-M22-T01 / ADR-0112 限定2 で 17 → 18 に更新した】** `update_view` にも18キー目
    // `search_fields` が加わった(値は `applyViewChanges` の `list_view` 分岐が実際に運ぶ)。
    // **【V4-M22-T05 / ADR-0113 限定2 で 18 → 19 に更新した】** `update_view` にも19キー目
    // `page_size` が加わった(値は `applyViewChanges` の `list_view` 分岐が実際に運ぶ)。
    // **【V4-M19-T03 / ADR-0118 限定1 で 19 → 20 に更新した】** 20キー目 `preset_density`
    // (画面の詰まり具合)が門A を通って増えた(V4-M19 単位C。2回目の審査。判定 = 限定採用)。
    // **3種すべてに書けるキーである。****本 ADR の増分ではない。**
    // **【V4-M20-T04 / ADR-0102 限定2 で 20 → 21 に更新した】** 21キー目 `after_save` が
    // `update_view` にも加わった(値は `applyViewChanges` の `form` 分岐が実際に運ぶ)。
    // **本 ADR の増分ではない。**
    // **【V4-M23-T01 / ADR-0104 限定採用で 21 → 22 に更新した】** 22キー目 `sum_field`
    // (合計を出す列。`list_view` でだけ書ける)が `update_view` にも加わった(値は
    // `applyViewChanges` の `list_view` 分岐が実際に運ぶ)。**本 ADR の増分ではない。**
    // **【`V6-M2-T02` / `K-G3` / `ADR-0289` 限定1 で 23 → 24 に更新した】** 24キー目 `reference_pickers`
    // (参照項目の選び方の、入力画面ごとの上書き。`form` でだけ書ける)が `update_view` にも加わった
    // (値は `applyViewChanges` の `form` 分岐が実際に運ぶ)。**本 ADR の増分ではない。**
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 24 → 25 へ書き換えた。**
    // **旧行の逐語**: `expect(keys).toHaveLength(24);`
    // **書き換えた理由**: この行が固定していたのは「**その決定**が `view_changes.properties` の本数 を増やさなかったこと」であり、
    // **25本目を足したのは別の決定である**(`V8-M8` が 集計表の宣言 `report` を25キー目として足した)。**検査は消していない。**
    // **【2026-08-20。`V10-M1-T02`。台帳 `NV-G4`。ADR = `0359` §Decision 2】**
    // **期待値を 25 → 26 へ書き換えた。****旧行の逐語**: `expect(keys).toHaveLength(25);`
    // **26本目を足したのは別の決定である**(`after_delete` を `view_changes` の末尾に足した)。
    // **本ファイルが測っている決定の増分ではない。****検査は消していない。**
    // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
    // **期待値を 26 → 27 へ書き換えた。****旧行の逐語**: `expect(keys).toHaveLength(26);`
    // **27本目を足したのは別の決定である**(`flow` を `view_changes` の末尾に足した。
    // `ADR-0359` §Decision 2)。**本ファイルが測っている決定の増分ではない。**
    // **検査は消していない。**
    expect(keys).toHaveLength(27);
    expect(keys).toContain(KEY);
  });

  /**
   * `applyDiff` と**同じ順序**で畳み込みと検証を行う(`apply-diff.ts:1403`-`:1418`)。
   * **`applyDiff` そのものを呼ばないのは、永続化の土台(dataRoot / store)が要るからである** ——
   * **拒否がスナップショット取得より前に起きることは `applyDiff` 側の既存の検査が押さえている。**
   */
  function fold(current: Manifest, changes: Record<string, unknown>, view = "order-form") {
    const folded = foldOperations(current, [{ op: "update_view", view, changes } as never]);
    if (!folded.valid) {
      return { valid: false as const, manifest: undefined };
    }
    const validated = validateManifestFull(folded.manifest);
    return validated.valid
      ? { valid: true as const, manifest: folded.manifest }
      : { valid: false as const, manifest: undefined };
  }

  test("値がマニフェストへ運ばれる(「キーは在るが効かない」穴を踏まない)", () => {
    const current = baseManifest([form({ menu_listed: false } as unknown as Partial<FormView>)]);
    const result = fold(current, { [KEY]: true });
    expect(result.valid).toBe(true);
    const view = result.manifest?.app.views.find((candidate) => candidate.id === "order-form");
    expect((view as unknown as Record<string, unknown>)[KEY]).toBe(true);
  });

  test("update_view で list_view に書こうとすると拒否される", () => {
    const current = baseManifest([
      {
        id: "order-list",
        type: "list_view",
        table: "orders",
        columns: ["memo"],
      } as unknown as View,
    ]);
    expect(fold(current, { [KEY]: true }, "order-list").valid).toBe(false);
  });

  test("update_view で menu_listed を偽にしていない form に書こうとすると拒否される", () => {
    expect(fold(baseManifest([form()]), { [KEY]: true }).valid).toBe(false);
  });

  test("書かなかったキーは触られない(キー単位の差し替えである)", () => {
    const current = baseManifest([
      form({ menu_listed: false, [KEY]: true } as unknown as Partial<FormView>),
    ]);
    const result = fold(current, { name: "注文フォーム" });
    expect(result.valid).toBe(true);
    const view = result.manifest?.app.views.find((candidate) => candidate.id === "order-form");
    expect((view as unknown as Record<string, unknown>)[KEY]).toBe(true);
  });
});
