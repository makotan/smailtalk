/**
 * 入力フォーム(`form`)に既存の画面プリセットを**2軸だけ**通したことの機械検査
 * (`V4-M16-T11` / `P-G29` / `ADR-0091` 限定1〜限定8)。
 *
 * ## この検査が固定するもの / 固定しないもの
 *
 * **固定する**: 限定1(新しいキーを1つも足さない)/ 限定2(`enum` に値を1つも足さない)/
 * 限定3(外すのは form 分岐の `false` 2つだけ)/ 限定4(色を1つも足さない)/
 * 限定5(必須印と入力欄の寸法を1つも通さない)/ 限定6(書かなかった form は
 * 今日と1ピクセルも変わらない)/ 限定7(`related` の子一覧に当たらない)。
 *
 * **固定しない**: **chromium での実描画**。ここが見るのは DOM の属性と CSS のテキストで
 * あって、ブラウザの計算値ではない(`web/test/styles.test.ts` の限界3 と同じ穴)。
 *
 * ## **【正直に書く】`ADR-0091` 限定6 の「既定は `inline`」は form については偽である**
 *
 * 限定6 は逐語「**既定は `inline`(項目名と値の向き)と 1段(項目の段組数)であり、
 * 今日の描画と一致する**」と書いているが、**`detail_view` の既定が横並びなのに対し、
 * form の既定は縦積みである**(`web/src/styles.css` の `.record-form label { display: block }`
 * と `FormRenderer` の `flex flex-col`)。**したがって form について「既定は `inline`」は
 * 今日の実物と一致しない。**
 *
 * **実装は限定6 の第一義(書かなかった画面は1ピクセルも変わらない)を採った**:
 * - **属性を1つも出さないので、規則が1つも当たらない**(下の (f) が DOM の完全一致で固定)。
 * - **`stacked` と書いた form は今日の描画と同じになる**(`flex-direction: column` は
 *   `flex flex-col` と同値)。
 * - **`inline` と書いた form だけが、項目名と入力欄が横に並ぶ形に変わる。**
 */
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { FormView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { FormRenderer } from "../src/views/FormRenderer.tsx";
import { HANDWRITTEN_SOURCES, styleSourcePath } from "./style-source-set.ts";

const REPO_ROOT = dirname(dirname(import.meta.dir));
const MANIFEST_SCHEMA_PATH = join(REPO_ROOT, "schemas", "manifest.schema.json");
// 【`V5-M29-T05`】`DIFF_SCHEMA_PATH` の定義を消した。**`view_changes` の本数を測る `expect` が
//   消えて、この定数を読む箇所が1つも無くなったためである**(`tsc` が `TS6133` を出す)。
//   **`schemas/diff.schema.json` そのものには1バイトも触っていない。**

// biome-ignore lint/suspicious/noExplicitAny: 正準スキーマの構造を動的に辿るため
type Any = any;

function readJson(path: string): Any {
  return JSON.parse(readFileSync(path, "utf-8"));
}

/** 手で書く側の CSS の全量(`ADR-0088` 限定2)。**ファイル名を直に読まない。** */
const css = HANDWRITTEN_SOURCES.map((source) =>
  readFileSync(styleSourcePath(source), "utf-8"),
).join("\n");

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

function viewSchema(): Any {
  return readJson(MANIFEST_SCHEMA_PATH).$defs.view;
}

function formBranch(): Any {
  return (viewSchema().allOf as Any[]).find(
    (branch) => branch.if?.properties?.type?.const === "form",
  );
}

// ---------------------------------------------------------------------------
// (a) 語彙の定点観測 —— **新しいキーを1つも足していない**(限定1)
// ---------------------------------------------------------------------------

// 【`V5-M29-T05`】**テスト名を書き換えた。** 旧: 「(a) $defs / $defs/view / $defs/theme /
//   view_changes / $defs/field の件数が1つも動いていない」。**`$defs` / `$defs/view` /
//   `view_changes` を測る `expect` が消えたのに、名前だけがそれらを主張する状態を残さないため
//   (記録 §4-7)。**
test("(a) $defs/theme / $defs/field の件数が1つも動いていない", () => {
  const manifest = readJson(MANIFEST_SCHEMA_PATH);
  // **`$defs/view.properties` は 20 のまま**(`ADR-0084` が 20 キー目 `menu_listed` を足した後)。
  // **【V4-M16-T12 / `P-G17` の (C) 側 / ADR-0092 限定1 による更新】** `ADR-0092`(門A の
  // 本審査 = `V4-M14` 本審査② の単位9。判定 = 限定採用)が21キー目 `field_groups` を足した
  // ので 20 → 21 にした。**`ADR-0091` の増分が0キーであることは1ミリも変わっていない**
  // (`ADR-0091` は form 分岐の `false` を2つ外しただけで、キーを1本も足していない)。
  // **【V4-M16-T13 / ADR-0093 限定1 で 21 → 22 に更新した】** 門A の本審査(`V4-M14` 本審査② の単位11。判定 = 限定採用)が22キー目 `preset_list_shape`(一覧の器の形)を足した。
  // **【V4-M18-T03 / ADR-0095 限定1 で 22 → 23 に更新した】** 門A の本審査(V4-M18 単位3。
  // 判定 = 限定採用)が23キー目 `modal`(重ねて出す宣言)を足した。**本 ADR の増分ではない。**
  // **【V4-M22-T01 / ADR-0112 限定1 で 23 → 24 に更新した】** 門A の本審査(V4-M22 単位A。
  // 判定 = 限定採用)が24キー目 `search_fields`(検索の対象にする列)を足した。**本 ADR の
  // 増分ではない。**
  // **【V4-M22-T05 / ADR-0113 限定1 で 24 → 25 に更新した】** 門A の本審査(V4-M22 単位C。
  // **4回目の審査**。判定 = 限定採用)が25キー目 `page_size`(1ページに出す件数)を足した。
  // **本 ADR の増分ではない。**
  // **【V4-M19-T03 / ADR-0118 限定1 で 25 → 26 に更新した】** 門A の本審査(V4-M19 単位C。
  // 2回目の審査。前回 = V4-M14 単位7 は却下。判定 = 限定採用)が26キー目 `preset_density`
  // (画面の詰まり具合)を足した。**`ADR-0091` の増分が0キーであることは1ミリも変わって
  // いない**(`ADR-0091` は今日も form 分岐の `false` を2つ外しただけである)。
  // **【V4-M20-T04 / ADR-0102 限定1 で 26 → 27 に更新した】** 門A の本審査(V4-M20 単位D。
  // 2回目の審査。判定 = 限定採用)が27キー目 `after_save`(保存が成立したあとに行く画面の
  // ID。form 型のビューでだけ書ける)を足した。**増やしたのは本 ADR(`ADR-0102`)ではない
  // ——`ADR-0091` の増分が0キーであることは今日も1ミリも変わっていない。**
  // **【V4-M23-T01 / ADR-0104 限定1 で 27 → 28 に更新した】** 門A の本審査(判定 = 限定採用)が
  // 28キー目 `sum_field`(合計を出す列。`list_view` でだけ書ける)を足した。**増やしたのは
  // 本 ADR(`ADR-0104`)ではない ——`ADR-0091` の増分が0キーであることは今日も1ミリも変わって
  // いない。**
  // 【`V5-M29-T05` / `ADR-0250` 限定11】ここにあった「**`$defs/view.properties` は 20 のまま**
  //   (`ADR-0084` が 20 キー目 `menu_listed` を足した後)」の検査は
  //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
  //   `manifest.$defs.view.properties:` で始まる行)。**総量ではなく名前と順序で見張る。**
  //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  //   **直前の 20 → 28 の更新履歴のコメントは、跡として残してある。**
  // 【`V5-M29-T05` / `ADR-0250` 限定11】ここにあった「**`$defs` は 28 のまま。**」の検査も
  //   `scripts/vocabulary-drift.test.ts` へ移した(一覧の `manifest.$defs:` で始まる行)。
  //   **総量ではなく名前と順序で見張る。**
  //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  // **テーマは 25 スロット / 25 required のまま**(`ADR-0091` は色を1バイトも触らない)。
  expect(Object.keys(manifest.$defs.theme.properties)).toHaveLength(25);
  expect(manifest.$defs.theme.required).toHaveLength(25);
  // **`$defs/field.properties` は 11 のまま**(`ADR-0090` が 11 キー目 `emphasis` を足した後)。
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
  // **【`V8-M20` / 台帳 `J-G28`(判定 = 廃止)/ 手続きは `ADR-0301` で 14 → 12 に更新した】**
  // **本ファイルで期待値が**減る**初めての更新である**(ここまでの更新はすべて増える側だった)。
  // **旧の期待値**: `expect(Object.keys(manifest.$defs.field.properties)).toHaveLength(14);`
  // **減った2キーは `audience`(この項目を見せる相手)と `writable_by`(この項目を書ける相手)
  // である。** **代わりに担うのは `app.roles[].rules` の
  // `{ target: "field", table: <表ID>, field: <項目ID>, can: ["read"] / ["write"] }` である。**
  // **`ADR-0091` の増分が0キーであることは今日も1ミリも変わっていない**(減らしたのは
  // `V8-M20` の側であって、本 ADR は今日も form 分岐の `false` を2つ外しただけである)。
  expect(Object.keys(manifest.$defs.field.properties)).toHaveLength(12);
  // **`view_changes` は 14 のまま。** `schemas/diff.schema.json` に1バイトも触っていない。
  // **【V4-M16-T12 / ADR-0092 限定2 による更新】** 15キー目 `field_groups` が門A を通って
  // 加わったので 14 → 15 にした。**`ADR-0091` は今日も `diff.schema.json` に1バイトも
  // 触っていない**(増やしたのは `ADR-0092` の側である)。
  // **【V4-M16-T13 / ADR-0093 限定2 で 15 → 16 に更新した】** `update_view` にも16キー目 `preset_list_shape` が加わった(値はカーネルが実際に運ぶ)。
  // **【V4-M18-T03 / ADR-0095 限定6 で 16 → 17 に更新した】** `update_view` にも17キー目
  // `modal` が加わった(値は `applyViewChanges` の `form` 分岐が実際に運ぶ)。
  // **【V4-M22-T01 / ADR-0112 限定2 で 17 → 18 に更新した】** `update_view` にも18キー目
  // `search_fields` が加わった(値は `applyViewChanges` の `list_view` 分岐が実際に運ぶ)。
  // **【V4-M22-T05 / ADR-0113 限定2 で 18 → 19 に更新した】** `update_view` にも19キー目
  // `page_size` が加わった(値は `applyViewChanges` の `list_view` 分岐が実際に運ぶ)。
  // **【V4-M19-T03 / ADR-0118 限定1 で 19 → 20 に更新した】** `update_view` にも20キー目
  // `preset_density` が加わった(値は `applyViewChanges` の list_view / form / detail_view の
  // 3分岐すべてが実際に運ぶ)。**`ADR-0091` は今日も `diff.schema.json` に1バイトも触って
  // いない。**
  // **【V4-M20-T04 / ADR-0102 限定2 で 20 → 21 に更新した】** `update_view` にも21キー目
  // `after_save` が加わった(値は `applyViewChanges` の `form` 分岐が実際に運ぶ)。
  // **`ADR-0091` は今日も `diff.schema.json` に1バイトも触っていない**(増やしたのは
  // `ADR-0102` の側である)。
  // **【V4-M23-T01 / ADR-0104 限定2 で 21 → 22 に更新した】** `update_view` にも22キー目
  // `sum_field`(合計を出す列。`list_view` でだけ書ける)が加わった(値は `applyViewChanges` の
  // `list_view` 分岐が実際に運ぶ)。**`ADR-0091` は今日も `diff.schema.json` に1バイトも
  // 触っていない**(増やしたのは `ADR-0104` の側である)。
  // 【`V5-M29-T05` / `ADR-0250` 限定11】ここにあった「**`view_changes` は 14 のまま。**
  //   `schemas/diff.schema.json` に1バイトも触っていない。」の検査は
  //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
  //   `diff.$defs.view_changes.properties:` で始まる行)。**総量ではなく名前と順序で見張る。**
  //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  //   **直前の 14 → 23 の更新履歴のコメントは、跡として残してある。**
});

// ---------------------------------------------------------------------------
// (b) プリセットは 7軸20値のまま(限定2)——
//     **V4-M16-T13 / ADR-0093 が8つ目の軸を足したので、今日の実数は 8軸22値である。**
//     **増やしたのは ADR-0093 の側であり、ADR-0091 の増分は今日も0キー0値である。**
//     **【V4-M19-T03 / ADR-0118 が9つ目の軸を足したので、今日の実数は 9軸24値である。**
//     **増やしたのは ADR-0118 の側であり、ADR-0091 の増分は今日も0キー0値である。**
// ---------------------------------------------------------------------------

test("(b) プリセットは9軸で、値の全量は24である(ADR-0091 の増分は今日も0キー0値)", () => {
  const properties = viewSchema().properties;
  const presetKeys = Object.keys(properties).filter((key) => key.startsWith("preset_"));
  // **【V4-M16-T13 / ADR-0093 限定1・限定3 で 7 → 8 / 20 → 22 に更新した】**
  // **増やしたのは `ADR-0093`(門A / 判定 = 限定採用)であって `ADR-0091` ではない** ——
  // **`ADR-0091` は form 分岐の `false` を2つ外しただけで、キーも enum 値も1つも足していない。**
  // **【V4-M19-T03 / ADR-0118 限定1・限定3 で 8 → 9 / 22 → 24 に更新した】**
  // **増やしたのは `ADR-0118`(門A / 判定 = 限定採用。V4-M19 単位C。2回目の審査)であって
  // `ADR-0091` ではない** —— `ADR-0091` は今日もキーも enum 値も1つも足していない。
  expect(presetKeys).toHaveLength(9);
  const mapAxes = new Set(["preset_column_align", "preset_column_width"]);
  let total = 0;
  for (const key of presetKeys) {
    const schema = mapAxes.has(key) ? properties[key].additionalProperties : properties[key];
    expect(schema.enum, key).toBeDefined();
    total += (schema.enum as unknown[]).length;
  }
  expect(total).toBe(24);
  // **本タスクが form に通した2軸の値域も1つも動いていない。**
  expect(properties.preset_label_placement.enum).toEqual(["inline", "stacked"]);
  expect(properties.preset_field_columns.enum).toEqual([1, 2]);
});

// ---------------------------------------------------------------------------
// (c) 外したのは form 分岐の `false` 2つだけである(限定3)
// ---------------------------------------------------------------------------

/**
 * **form で今日も書けないプリセット6軸。**1つでも減ったら赤くする(両向き)。
 *
 * **【V4-M16-T13 / ADR-0093 限定2 で 5軸 → 6軸になった】** 8つ目の `preset_` キー
 * (`preset_list_shape`。一覧の器の形)も form 分岐で `false` である。
 * **`ADR-0091` が通した2軸は今日も1バイトも動いていない。**
 */
const FORM_DENIED_PRESETS = [
  "preset_column_align",
  "preset_column_width",
  "preset_image_size",
  "preset_list_shape",
  "preset_pager_position",
  "preset_text_preview",
];

/** **form で今日も書けないプリセット以外のキー。** */
const FORM_DENIED_OTHERS = ["actions", "columns", "filter", "related", "sort"];

// **【V4-M16-T13 / ADR-0093 限定2 で 5本 → 6本になった】** 8つ目の `preset_` キー
// (`preset_list_shape`。一覧の器の形)も form 分岐で `false` である。
// **`ADR-0091` が通した2軸(`preset_label_placement` / `preset_field_columns`)は
// 今日も form 分岐から消えたままであり、1バイトも動いていない。**
test("(c) form 分岐の preset_* の false はちょうど6本で、名前が完全一致する", () => {
  const properties = (formBranch()?.then?.properties ?? {}) as Record<string, unknown>;
  const denied = Object.entries(properties)
    .filter(([key, value]) => key.startsWith("preset_") && value === false)
    .map(([key]) => key)
    .sort();
  expect(denied).toEqual([...FORM_DENIED_PRESETS].sort());
  expect(denied).toHaveLength(6);
  // **通した2軸が form 分岐から消えていること**(`false` のままだと「書けるが拒否される」)。
  expect(properties.preset_label_placement).toBeUndefined();
  expect(properties.preset_field_columns).toBeUndefined();
});

test("(c) form 分岐の columns / sort / filter / related / actions の false は1つも動いていない", () => {
  const properties = (formBranch()?.then?.properties ?? {}) as Record<string, unknown>;
  for (const key of FORM_DENIED_OTHERS) {
    expect(properties[key], key).toBe(false);
  }
  // **form の必須キーも動いていない。**
  expect(formBranch()?.then?.required).toEqual(["fields"]);
});

// ---------------------------------------------------------------------------
// (d) 色を1つも足していない(限定4)
// ---------------------------------------------------------------------------

test("(d) button, input, select, textarea ブロックの宣言は3つちょうどで、色の宣言が1つも無い", () => {
  const body = stripComments(css);
  const match = /(^|\})\s*button,\s*input,\s*select,\s*textarea\s*\{([^{}]*)\}/m.exec(body);
  expect(match, "button, input, select, textarea のブロックを読めない").not.toBeNull();
  const declarations = ((match as RegExpExecArray)[2] ?? "")
    .split(";")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== "");
  // **3宣言ちょうど**(`ADR-0091` 限定4。`ADR-0049` の「フォームコントロールの文字色と
  // 地色はブラウザ既定のまま」を1ミリも動かしていない)。
  expect(declarations).toHaveLength(3);
  expect(declarations.map((d) => d.split(":")[0]?.trim()).sort()).toEqual([
    "border-radius",
    "font-family",
    "line-height",
  ]);
  for (const property of ["color", "background", "background-color"]) {
    expect(
      declarations.some((d) => d.split(":")[0]?.trim() === property),
      property,
    ).toBe(false);
  }
});

test("(d) 本タスクが足した規則に色の宣言が1つも無い", () => {
  for (const rule of recordFormPresetRules()) {
    for (const property of ["color", "background", "background-color", "border-color"]) {
      expect(rule.body.includes(`${property}:`), `${rule.selector} の ${property}`).toBe(false);
    }
  }
});

// ---------------------------------------------------------------------------
// (e) 必須印と入力欄の寸法を1つも足していない(限定5)
// ---------------------------------------------------------------------------

test("(e) .record-form .required の規則が1つだけで、宣言も3つのままである", () => {
  const body = stripComments(css);
  const matches = [...body.matchAll(/\.record-form\s+\.required[^{]*\{([^{}]*)\}/g)];
  // **必須印の規則は1本のままである**(見せ方の軸を1つも通していない)。
  expect(matches).toHaveLength(1);
  const declarations = (matches[0]?.[1] ?? "")
    .split(";")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== "");
  expect(declarations.map((d) => d.split(":")[0]?.trim()).sort()).toEqual([
    "color",
    "font-size",
    "margin-left",
  ]);
});

test("(e) input / select / textarea の寸法の規則を1つも新設していない", () => {
  // **`ADR-0091` 限定5 の3点目**: 入力欄の幅と高さを通すと `input` / `select` / `textarea` の
  // 寸法の規則を新設することになり、`ADR-0050` §3a 2 への回答が成立しなくなる。
  for (const rule of recordFormPresetRules()) {
    for (const property of [
      "width",
      "height",
      "min-width",
      "max-width",
      "min-height",
      "font-size",
    ]) {
      expect(rule.body.includes(`${property}:`), `${rule.selector} の ${property}`).toBe(false);
    }
  }
});

// ---------------------------------------------------------------------------
// (k) 当たり先の CSS 規則が、配られる CSS の集合に実在する
// ---------------------------------------------------------------------------

type CssRule = { selector: string; body: string };

/** 本タスクが足した `.record-form[data-preset-…]` の規則を全部取り出す。 */
function recordFormPresetRules(): CssRule[] {
  const body = stripComments(css);
  return [...body.matchAll(/([^{}]*\.record-form\[data-preset-[^{}]*)\{([^{}]*)\}/g)].map(
    (match) => ({
      selector: (match[1] ?? "").trim().replace(/\s+/g, " "),
      body: (match[2] ?? "").replace(/\s+/g, " ").trim(),
    }),
  );
}

test("(k) 2軸それぞれの当たり先の規則が、配られる CSS の集合に実在する", () => {
  const rules = recordFormPresetRules();
  const selectors = rules.map((rule) => rule.selector).sort();
  // **enum の値1つに規則1つ**(冒頭コメントの許可 (iv) と同型。値の数より規則を増やさない)。
  expect(selectors).toEqual([
    '.record-form[data-preset-columns="1"] .form-fields',
    '.record-form[data-preset-columns="2"] .form-fields',
    '.record-form[data-preset-label="inline"] .field',
    '.record-form[data-preset-label="stacked"] .field',
  ]);
  // **座標系9プロパティを1つも書いていない**(`ADR-0091` の射程外を1つも踏まない)。
  for (const rule of rules) {
    for (const property of [
      "position",
      "z-index",
      "top",
      "left",
      "right",
      "bottom",
      "inset",
      "float",
      "transform",
    ]) {
      expect(new RegExp(`(^|;)\\s*${property}\\s*:`).test(rule.body), `${rule.selector}`).toBe(
        false,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// (f) 書かなかった form は今日と1ピクセルも変わらない(限定6)
// ---------------------------------------------------------------------------

const WRITER_ROLE: Role = "owner";
const APP_ID = "sample-app";
const BASELINE_DOM_PATH = join(import.meta.dir, "__fixtures__", "form-no-preset-dom.html");

function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "サンプル",
      tables: [
        {
          id: "items",
          name: "備品",
          fields: [
            { id: "name", name: "備品名", type: "text", required: true },
            { id: "quantity", name: "数量", type: "number" },
          ],
        },
      ],
      views: [{ id: "item-form", type: "form", table: "items", fields: ["name", "quantity"] }],
    },
  };
}

function withPresets(presets: Partial<FormView>): Manifest {
  const manifest = baseManifest();
  manifest.app.views[0] = { ...(manifest.app.views[0] as FormView), ...presets };
  return manifest;
}

async function renderForm(manifest: Manifest): Promise<HTMLElement> {
  render(
    <RoleProvider role={WRITER_ROLE}>
      <FormRenderer appId={APP_ID} manifest={manifest} view={manifest.app.views[0] as FormView} />
    </RoleProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("view-renderer-form")).toBeDefined());
  return screen.getByTestId("view-renderer-form");
}

afterEach(cleanup);

test("(f) プリセットを書かない form の DOM が、着手前と完全一致する", async () => {
  const section = await renderForm(baseManifest());
  // **完全一致**(属性1つ・器1つの追加も赤になる)。基準は 2026-08-04 の着手前に
  // 同じフィクスチャで採った実物である。
  expect(section.outerHTML).toBe(readFileSync(BASELINE_DOM_PATH, "utf-8").trimEnd());
});

test("(f) プリセットを書かない form には data-preset-* が1つも出ない", async () => {
  const section = await renderForm(baseManifest());
  const form = section.querySelector("form") as HTMLElement;
  expect(form.getAttribute("data-preset-label")).toBeNull();
  expect(form.getAttribute("data-preset-columns")).toBeNull();
  // **段組の器も出ない**(当たり先の無い器を DOM に置かない)。
  expect(section.querySelector(".form-fields")).toBeNull();
});

test("2軸を書いた form には属性が出る(段組数は文字列になる)", async () => {
  const section = await renderForm(
    withPresets({ preset_label_placement: "inline", preset_field_columns: 2 }),
  );
  const form = section.querySelector("form") as HTMLElement;
  expect(form.getAttribute("data-preset-label")).toBe("inline");
  expect(form.getAttribute("data-preset-columns")).toBe("2");
  // **段組の器は項目だけを包む** —— 送信ボタンとエラー表示を段に入れない。
  const container = section.querySelector(".form-fields") as HTMLElement;
  expect(container).not.toBeNull();
  expect([...container.children].every((child) => child.classList.contains("field"))).toBe(true);
  expect(container.querySelector("button")).toBeNull();
  // **既存の `data-testid` を1つも落としていない。**
  expect(screen.getByTestId("field-label-name")).toBeDefined();
  expect(screen.getByTestId("required-name")).toBeDefined();
});

test("軸を片方だけ書いた form には、書いた側の属性だけが出る", async () => {
  const section = await renderForm(withPresets({ preset_label_placement: "stacked" }));
  const form = section.querySelector("form") as HTMLElement;
  expect(form.getAttribute("data-preset-label")).toBe("stacked");
  expect(form.getAttribute("data-preset-columns")).toBeNull();
  // 段組を書いていないので器も出ない。
  expect(section.querySelector(".form-fields")).toBeNull();
});

// ---------------------------------------------------------------------------
// (g) `related` の子一覧に当たらない(限定7)
// ---------------------------------------------------------------------------

test("(g) form 分岐の related: false が残っている", () => {
  expect(formBranch()?.then?.properties?.related).toBe(false);
  // 当たり先の CSS も `related` に1つも触れていない。
  for (const rule of recordFormPresetRules()) {
    expect(rule.selector.includes("related"), rule.selector).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// (i) list_view は今日どおり拒否される(form に通したことで緩んでいない)
// ---------------------------------------------------------------------------

/**
 * **拒否そのものの実測は `src/kernel/form-view-presets.test.ts` の (h) が持つ**
 * (`web/` からカーネルの値を `import` しない = `ADR-0009` 限定2 /
 * `scripts/kernel-import-drift.test.ts`)。**ここはスキーマをファイルとして読み、
 * `list_view` 分岐の `false` が1バイトも動いていないことだけを見る。**
 */
test("(i) list_view 分岐の preset_label_placement / preset_field_columns の false が残っている", () => {
  const listBranch = (viewSchema().allOf as Any[]).find(
    (branch) => branch.if?.properties?.type?.const === "list_view",
  );
  const properties = (listBranch?.then?.properties ?? {}) as Record<string, unknown>;
  expect(properties.preset_label_placement).toBe(false);
  expect(properties.preset_field_columns).toBe(false);
  // list_view 分岐の他の `false` も1つも動いていない。
  // **【V4-M16-T12 / `P-G17` の (C) 側 / ADR-0092 限定2 による更新】** **5本 → 6本になった** ——
  // 増えたのは `field_groups` の1本だけで、**`ADR-0091` が守った4本(`actions` / `fields` /
  // `preset_field_columns` / `preset_label_placement`)と `related` は1バイトも動いていない。**
  // **【V4-M18-T03 / `P-G14` の (C) 側 / ADR-0095 限定6 による更新】** **6本 → 7本になった** ——
  // 増えたのは `modal`(重ねて出す宣言)の1本だけで、他の6本は1バイトも動いていない。
  // **【V4-M20-T04 / ADR-0102 限定1 で 7本 → 8本に更新した】** 門A の本審査(V4-M20 単位D。
  // 2回目の審査。判定 = 限定採用)が `after_save`(保存が成立したあとに行く画面のID)を
  // list_view 分岐で `false` にした(after_save は form 型のビューでだけ書ける)。
  // **【2026-08-20。`V10-M1-T01` / `NV-G3a` / `ADR-0358` 限定1】直前の逐語
  // 「after_save は form 型のビューでだけ書ける」は今日は偽である** —— **門A の本審査(`V10-M0` 群A。判定 = 限定採用)が
  // `detail_view` 分岐の `"after_save": false,` を外した。****今日は `form` と
  // `detail_view` の2種別で書ける**(`list_view` / `report_view` には今日も書けない)。
  // **旧文を1バイトも消していない。**
  // 増えたのは `after_save` の1本だけで、他の7本は1バイトも動いていない。
  // **【V5-M21-T01 / `L-G1` / ADR-0171 で 8本 → 7本に更新した】** 門A の本審査
  // (`V5-M20` 面1。判定 = 限定採用)が `actions`(一覧の行の操作起点)の `false` を
  // **解いた。** **本ファイルで初めて「false が減る」更新である**(ここまでの3回はすべて
  // 増加であった)。**`ADR-0091` が守った4本のうち `actions` が1本抜け、残る3本
  // (`fields` / `preset_field_columns` / `preset_label_placement`)と `related` は
  // 1バイトも動いていない。****form 分岐の `actions` の `false` も1バイトも動いていない**
  // (上の (c) 群が今日も `false` を期待している)。
  expect(
    Object.entries(properties)
      .filter(([, value]) => value === false)
      .map(([key]) => key)
      .sort(),
  ).toEqual([
    // **【2026-08-20。`V10-M1-T02` / `NV-G4` / `ADR-0359` 限定2 で足した】** list_view では
    // 30キー目 `after_delete`(削除が成立したあとの行き先)も `false` である
    // (`detail_view` でだけ書ける)。**本 ADR の増分ではない。**
    "after_delete",
    "after_save",
    "field_groups",
    "fields",
    "modal",
    "preset_field_columns",
    "preset_label_placement",
    // **【`V6-M2-T01` / `K-G2` / `ADR-0289` 限定4 で足した】** list_view では
    // `reference_pickers`(参照項目の選び方の、入力画面ごとの上書き)も `false` である
    // (`form` でだけ書ける)。**本 ADR の増分ではない。**
    "reference_pickers",
    "related",
    // **【2026-08-14。`V8-M8` / 台帳 `Q-G1` / 門A 本審査 = `V8-M7` で足した】** list_view では
    // `report`(集計表の中身)も `false` である(`report_view` でだけ書ける)。
    // **本 ADR(`ADR-0091`)の増分ではない。****`ADR-0091` が守った3本
    // (`fields` / `preset_field_columns` / `preset_label_placement`)は1バイトも動いていない。**
    "report",
  ]);
});
