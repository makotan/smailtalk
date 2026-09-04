/**
 * `number` の単位が**値の後ろに1通りで出る**ことの検査
 * (`E-G14` / `F-9` の4回目。`V4-M10-T46` / `ADR-0086`)。
 *
 * **限定表の正は [`docs/adr/0086-field-value-unit.md`](../../docs/adr/0086-field-value-unit.md) §Decision 3(12点)。**
 *
 * ## このファイルが固定すること
 *
 * 1. **限定5**: 描画規則は「値の後ろに置く」1通りだけ。**位置をアプリが選べない。**
 * 2. **限定6**: **桁区切りは1バイトも動かない** —— 単位を書いても閾値(5桁)は変わらない。
 * 3. **限定9**: 書かなかったフィールドは今日と1文字も変わらない。
 * 4. **限定10**: 表示関数の引数を1本も増やしていない(単位は `field` の中に入って届く)。
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * - **【禁止】「金額が正しく表示されるようになった」とは書かない。** **桁区切りの閾値は
 *   今日も表示層の固定値であり、`4256 点` と `24,724 円` は同じ画面に違う書式で並ぶ**
 *   (`ADR-0086` §Decision 4-1 / §Context 4 の6)。**この検査はその状態が残ることを
 *   実測で固定している。**
 * - **税込・税抜は単位ではない**(§Decision 4-3)。**`価格(税込)` という表示名は
 *   今日どおり必要である。**
 * - **CSV には単位を付けていない**(`V4-M10-T46` 完了条件6 の決定。理由は記録 §5-3)。
 */
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import type { Field } from "../../src/kernel/types.ts";
import { FieldValue } from "../src/fields/display.tsx";

const ROOT = dirname(dirname(import.meta.dir));

afterEach(cleanup);

/** 単位つきの `number`(`ADR-0086` の目的文が名指しした3例のうち2つ)。 */
const POINT: Field = { id: "points", name: "所持ポイント", type: "number", unit: "点" };
const YEN: Field = { id: "total", name: "合計", type: "number", unit: "円" };
/** 単位を書かなかった `number`(限定9 の対照)。 */
const PLAIN: Field = { id: "year", name: "西暦", type: "number" };

function renderValue(field: Field, value: unknown): string {
  cleanup();
  render(
    <FieldValue field={field} value={value as never} referenceLabels={new Map()} appId="app" />,
  );
  return screen.getByTestId("field-value-number").textContent ?? "";
}

// --- 限定5: 値の後ろに1通りだけ ---------------------------------------------------------

test("限定5: 単位は値の後ろに出る(接頭辞も記号の位置指定も1つも無い)", () => {
  expect(renderValue(POINT, 4256)).toBe("4256 点");
  expect(renderValue(YEN, 24724)).toBe("24,724 円");
});

test("限定5: 位置をアプリが選べる形になっていない(display.tsx の実装が1通りである)", () => {
  const source = readFileSync(join(ROOT, "web", "src", "fields", "display.tsx"), "utf8");
  // **記号の位置・小数桁・負数の表し方・端数処理・接頭辞を1つも作らない。**
  for (const forbidden of ["prefix", "suffixPosition", "decimals", "rounding", "unitPosition"]) {
    expect(source, forbidden).not.toContain(forbidden);
  }
});

// --- 限定6: 桁区切りを1バイトも動かさない ----------------------------------------------

test("限定6: 単位を書いても桁区切りの閾値(整数部5桁)は1文字も変わらない", () => {
  // 4桁は区切らない(西暦・評価・連番・件数・順位の表示を変えないための既存の規則)。
  expect(renderValue(YEN, 1234)).toBe("1234 円");
  // 5桁から区切る。
  expect(renderValue(YEN, 12345)).toBe("12,345 円");
  // **単位を書かない番号は今日と1文字も変わらない。**
  expect(renderValue(PLAIN, 2026)).toBe("2026");
});

test("限定6: GROUPING_MIN_INTEGER_DIGITS は今日も1つの定数である(宣言にしていない)", () => {
  const source = readFileSync(join(ROOT, "web", "src", "fields", "display.tsx"), "utf8");
  expect(source).toContain("const GROUPING_MIN_INTEGER_DIGITS = 5;");
  expect([...source.matchAll(/GROUPING_MIN_INTEGER_DIGITS\s*=/g)]).toHaveLength(1);
});

/**
 * **【この検査は「解けていないこと」を固定する】**(憲法6)。
 *
 * **`ADR-0086` §Context 4 の6 が不利な材料として自分で挙げた状態である** ——
 * **単位が付いても桁区切りの食い違いは消えない。**
 */
test("解けていないことの実測: 4256 点 と 24,724 円 は同じ画面で違う書式のまま並ぶ", () => {
  expect(renderValue(POINT, 4256)).toBe("4256 点");
  expect(renderValue(YEN, 24724)).toBe("24,724 円");
  // **同じ「数」なのに一方だけ区切られている。** これは今日も残る。
  expect(renderValue(POINT, 4256).includes(",")).toBe(false);
  expect(renderValue(YEN, 24724).includes(",")).toBe(true);
});

// --- 限定9: 書かなかったフィールドは今日と1文字も変わらない -----------------------------

test("限定9: 単位を書かなかった number の表示は今日と1文字も変わらない", () => {
  expect(renderValue(PLAIN, 24724)).toBe("24,724");
  expect(renderValue(PLAIN, 0)).toBe("0");
  expect(renderValue(PLAIN, -1234567)).toBe("-1,234,567");
});

test("限定9: 単位を書いた負数・小数も、桁区切りの規則は今日どおりである", () => {
  expect(renderValue(YEN, -1234567)).toBe("-1,234,567 円");
  expect(renderValue(YEN, 12345.67)).toBe("12,345.67 円");
});

// --- 限定10: 表示関数の引数を1本も増やさない --------------------------------------------

test("限定10: 単位は field の中に入って届く(表示オプションの引数を足していない)", () => {
  const source = readFileSync(join(ROOT, "web", "src", "fields", "display.tsx"), "utf8");
  // `FieldValue` / `FieldCell` が受け取る表示オプションは今日も `textPreview` の1つだけ。
  const optionArgs = [...source.matchAll(/^\s{2}(\w+)\?: TextPreview;$/gm)].map((m) => m[1]);
  expect(optionArgs).toEqual(["textPreview", "textPreview"]);
  expect(source).not.toContain("unit?: string;\n");
});

// --- 完了条件6: CSV には単位を付けない -------------------------------------------------

test("完了条件6: CSV の書き出しに単位を1文字も付けていない(整形を1つも掛けない既存の方針)", () => {
  const source = readFileSync(join(ROOT, "web", "src", "views", "ListViewRenderer.tsx"), "utf8");
  // **`csvValue` は `reference` 以外に整形を1つも掛けない**(桁区切りも切り詰めも掛けて
  // いない)。**単位もそこに足していない** —— 足すと「値」ではなく「表示」を書き出すことに
  // なり、読み手が計算に使えなくなる。**この判断は記録 §5-3 に書いた。**
  expect(source).toContain("したがって整形は1つも掛けない");
  expect(source).not.toContain("field.unit");
});
