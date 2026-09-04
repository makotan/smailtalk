/**
 * `long_text` の切り詰め長に「切らない」を1値足したことの検査
 * (`E-G13` / `V4-M10-T36` / `ADR-0085`)。
 *
 * **限定表の正は [`docs/adr/0085-long-text-full-preview.md`](../../docs/adr/0085-long-text-full-preview.md) §Decision 3(10点)**、
 * 完了条件の正は `docs/plan/v4/records/v4-m10.md` §3c の `V4-M10-T36` 節(5点)。
 *
 * ## このファイルが固定すること
 *
 * 1. **限定1**: 足すのは `preset_text_preview` の enum に1値(`full`)だけ。
 *    **キーを1本も足さない**(`$defs/view.properties` は 20 のまま・`$defs` は 28 のまま・
 *    `view_changes` は 14 のまま)。
 * 2. **限定2**: 値は1語の段階値。**文字数そのものは書けない。**
 * 3. **限定4 / 限定10(引数)**: 表示関数の引数は `textPreview` の1つのままである。
 * 4. **限定6**: `long_text` 以外の型に1バイトも触っていない。
 * 5. **限定8**: 書かなかった画面は今日と1文字も変わらない。
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * - **「長い文章が読めるようになった」とは書かない** —— 足したのは1つの選択肢である。
 * - **一覧に `full` を書けてしまうことを塞いでいない**(限定10)。
 *   **`table-layout: fixed` の画面で何が起きるかは chromium の実測**(記録 §8)であり、
 *   ここでは DOM 上の事実(全文が出る)だけを見る。
 */
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import type { Field } from "../../src/kernel/types.ts";
import { FieldValue } from "../src/fields/display.tsx";

const ROOT = dirname(dirname(import.meta.dir));

afterEach(cleanup);

// biome-ignore lint/suspicious/noExplicitAny: スキーマ JSON を素で読むための局所エイリアス。
type Any = any;

function readSchema(name: string): Any {
  return JSON.parse(readFileSync(join(ROOT, "schemas", name), "utf8")) as Any;
}

/**
 * **`02` §5-3 の実測(引用)に合わせた題材** —— `brand.story` は 157〜177文字だった。
 * **`long`(80文字)を宣言しても切れる。** ここでは 200 文字で代表させる。
 */
const LONG_STORY = "あ".repeat(200);

const STORY_FIELD: Field = { id: "story", name: "ブランドの物語", type: "long_text" };

// --- (a) 増分の総量(限定1 / 限定2 / 限定3 / 限定5)-----------------------------------

test("限定1: preset_text_preview の enum は4値で、4値目は full である", () => {
  const key = readSchema("manifest.schema.json").$defs.view.properties.preset_text_preview as Any;
  expect(key.enum).toEqual(["short", "standard", "long", "full"]);
});

// 【`V5-M29-T05` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
//   消したテスト名(逐語): 「限定1: キーを1本も足していない($defs/view.properties 21 / $defs 28 / view_changes 15)」
//   そのブロックが測っていたもの:
//     - `expect(Object.keys(manifest.$defs.view.properties)).toHaveLength(28)`(主張の逐語はテスト名の「キーを1本も足していない($defs/view.properties 21)」)
//     - `expect(Object.keys(manifest.$defs)).toHaveLength(28)`(主張の逐語はテスト名の「キーを1本も足していない($defs 28)」)
//     - `expect(Object.keys(readSchema("diff.schema.json").$defs.view_changes.properties)).toHaveLength(23)`(主張の逐語はテスト名の「キーを1本も足していない(view_changes 15)」)
//   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `manifest.$defs.view.properties:` /
//   `manifest.$defs:` / `diff.$defs.view_changes.properties:` で始まる行)。
//   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
//   検出力0のまま `Ran` を水増しする)。
//   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。
//   **消したブロックにあった「20 → 21 → … → 28」「14 → 15 → … → 23」の更新履歴のコメントも、
//   ブロックごと消えた**(`ADR-0250` §Decision 5 の (4) が言う「テスト名が持っていた宣言」に
//   加えて、**期待値がどの門A でどう動いたかの経緯もここから消えた**)。

test("限定2: 値は1語の段階値であり、文字数を書ける形になっていない", () => {
  const key = readSchema("manifest.schema.json").$defs.view.properties.preset_text_preview as Any;
  expect(key.type).toBe("string");
  // **数を受ける形が1つも無い**(`maximum` / `minimum` / `pattern` を持たない)。
  for (const numeric of ["maximum", "minimum", "multipleOf", "pattern"]) {
    expect(key[numeric]).toBeUndefined();
  }
});

test("限定5: 他の6軸の enum に1値も足していない", () => {
  const properties = readSchema("manifest.schema.json").$defs.view.properties as Any;
  expect(properties.preset_column_align.additionalProperties.enum).toEqual([
    "left",
    "center",
    "right",
  ]);
  expect(properties.preset_column_width.additionalProperties.enum).toEqual([
    "narrow",
    "standard",
    "wide",
  ]);
  expect(properties.preset_pager_position.enum).toEqual(["top", "bottom", "both"]);
  expect(properties.preset_label_placement.enum).toEqual(["inline", "stacked"]);
  expect(properties.preset_field_columns.enum).toEqual([1, 2]);
  expect(properties.preset_image_size.enum).toEqual(["thumbnail", "medium", "original"]);
});

// --- (b) 当たり先が実在する(`ADR-0085` §Decision 2-2)---------------------------------

test("限定1 の当たり先: full を書いた画面は全文が DOM に出る(… を1つも付けない)", () => {
  render(
    <FieldValue
      field={STORY_FIELD}
      value={LONG_STORY}
      referenceLabels={new Map()}
      appId="app"
      textPreview="full"
    />,
  );
  const node = screen.getByTestId("field-value-long_text");
  expect(node.textContent).toBe(LONG_STORY);
  expect(node.textContent).not.toContain("…");
  // **切り詰めが起きないので title を出さない**(既存3値と同じ規則。2本目の規則を作らない)。
  expect(node.getAttribute("title")).toBeNull();
});

test("限定8: 書かなかった画面は今日と1文字も変わらない(既定は 40文字で切る)", () => {
  render(
    <FieldValue field={STORY_FIELD} value={LONG_STORY} referenceLabels={new Map()} appId="app" />,
  );
  const node = screen.getByTestId("field-value-long_text");
  expect(node.textContent).toBe(`${"あ".repeat(40)}…`);
  expect(node.getAttribute("title")).toBe(LONG_STORY);
});

test("既存3値の切り詰め長が1文字も動いていない(short 20 / standard 40 / long 80)", () => {
  for (const [preview, limit] of [
    ["short", 20],
    ["standard", 40],
    ["long", 80],
  ] as const) {
    cleanup();
    render(
      <FieldValue
        field={STORY_FIELD}
        value={LONG_STORY}
        referenceLabels={new Map()}
        appId="app"
        textPreview={preview}
      />,
    );
    expect(screen.getByTestId("field-value-long_text").textContent).toBe(`${"あ".repeat(limit)}…`);
  }
});

test("full でも短い本文は今日どおりそのまま出る(4値目が本文を作り替えない)", () => {
  render(
    <FieldValue
      field={STORY_FIELD}
      value="短い一文"
      referenceLabels={new Map()}
      appId="app"
      textPreview="full"
    />,
  );
  expect(screen.getByTestId("field-value-long_text").textContent).toBe("短い一文");
});

// --- (c) 限定4 / 限定6 / 限定7 --------------------------------------------------------

test("限定4 / 限定10: 表示関数が受け取る表示オプションは textPreview の1つのままである", () => {
  const source = readFileSync(join(ROOT, "web", "src", "fields", "display.tsx"), "utf8");
  // **`FieldValue` / `FieldCell` の引数に2つ目の表示オプションを足していない。**
  // 実引数の名前を数える(型の上での網羅ではないが、増えたら気づく錨である)。
  const optionArgs = [...source.matchAll(/^\s{2}(\w+)\?: TextPreview;$/gm)].map((m) => m[1]);
  expect(optionArgs).toEqual(["textPreview", "textPreview"]);
});

test("限定6: text 型は full を書いても今日どおり切られない(分岐は long_text の case にだけ在る)", () => {
  const textField: Field = { id: "title", name: "題名", type: "text" };
  render(
    <FieldValue
      field={textField}
      value={LONG_STORY}
      referenceLabels={new Map()}
      appId="app"
      textPreview="full"
    />,
  );
  expect(screen.getByTestId("field-value-text").textContent).toBe(LONG_STORY);
});

test("限定7: 逃げ道・テーマ・@media を1バイトも触っていない(styles.css に足していない)", () => {
  const before = readFileSync(join(ROOT, "web", "src", "styles.css"), "utf8");
  expect(before).not.toContain("full");
  expect(before).not.toContain("preset_text_preview");
});
