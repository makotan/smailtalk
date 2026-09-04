/**
 * 値の意味に応じた強調が**実際に描画を変える**ことの検査
 * (`P-G28` + `P-G22` の (C) 側。`V4-M16-T10` / `ADR-0090`)。
 *
 * **限定表の正は [`docs/adr/0090-value-emphasis-declaration.md`](../../docs/adr/0090-value-emphasis-declaration.md)
 * §Decision 2(限定1〜限定10)。**
 *
 * ## このファイルが固定すること(表示層側)
 *
 * 1. **限定6**: **意味の名前1つにつき当たり先の CSS 規則が1つ実在する。**
 *    `ADR-0050` §3a 3 逐語「当たり先の無い enum 値を置いてはならない」を、
 *    `ADR-0090` が自らに課した条である。**4値を1つずつ見る。**
 * 2. **限定5**: **当たり先が使う色は `$defs/theme` の25スロットだけである** ——
 *    **色のリテラルを1バイトも書いていない。**
 * 3. **限定7**: **座標系9プロパティを1つも書いていない。**
 * 4. **限定8**: **`emphasis` を1つも持たないマニフェストで、`select` の値の描画は
 *    今日と1文字も変わらない**(DOM の完全一致で見る)。
 * 5. **限定1 の帰結**: **表示関数の引数を1本も増やしていない** —— `emphasis` は
 *    `field` の中に入って届く(`ADR-0050` 限定10 の趣旨は無傷)。
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * - **chromium で1度も見ていない。** 見ているのは React が組んだ DOM と、手で書く CSS の
 *   テキストだけである。**「画面でこう見える」ことの実測は本ファイルの射程外である。**
 * - **強調色と背景色の対はコントラスト検査に1組も載っていない**(`ADR-0090` §Context 4 の 5)。
 *   **読める配色であることを本ファイルは1件も担保しない。**
 * - **「バッジが出せるようになった」とは書かない**(§Decision 3 の 2)。**出るのは
 *   枠と地色の付いた `<span>` 1つであり、部品体系の `Badge` は1つも使っていない。**
 */
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import type { Field } from "../../src/kernel/types.ts";
import { FieldValue } from "../src/fields/display.tsx";
import { HANDWRITTEN_SOURCES, readStyleSource } from "./style-source-set.ts";

afterEach(cleanup);

const ROOT = dirname(dirname(import.meta.dir));

/** 意味の名前(限定3。**この4値がすべてである**)。 */
const EMPHASIS_NAMES = ["neutral", "info", "caution", "danger"] as const;

/** 手で書く側の CSS 全量(`ADR-0088` 限定2 が定める「配られる CSS の集合」の手書き側)。 */
const handwrittenCss = HANDWRITTEN_SOURCES.map(readStyleSource).join("\n");

/** コメントを落とす(**説明文の中の字面を規則と読まないため**)。 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

const cssBody = stripComments(handwrittenCss);

/** `emphasis` を1つも持たない `select`(限定8 の対照)。 */
const PLAIN: Field = {
  id: "payment_status",
  name: "決済状態",
  type: "select",
  options: ["入金済み", "決済できず"],
};

/** `emphasis` を持つ `select`(`ADR-0090` の目的文が名指しした例)。 */
const MARKED: Field = {
  ...PLAIN,
  emphasis: { 入金済み: "info", 決済できず: "danger" },
} as Field;

function renderValue(field: Field, value: unknown): HTMLElement {
  cleanup();
  render(
    <FieldValue field={field} value={value as never} referenceLabels={new Map()} appId="app" />,
  );
  return screen.getByTestId("field-value-select");
}

// --- (h) 限定6: 意味の名前4値それぞれに当たり先の CSS 規則が実在する ---------------------

test("限定6: 配られる CSS の集合に .field-emphasis の器の規則が実在する", () => {
  expect(cssBody).toContain(".field-emphasis {");
});

test("限定6: 意味の名前4値それぞれに対応する規則が、配られる CSS の集合に1つずつ実在する", () => {
  for (const name of EMPHASIS_NAMES) {
    const selector = `.field-emphasis[data-emphasis="${name}"]`;
    // **当たり先の無い enum 値を1つも置かない**(`ADR-0050` §3a 3)。
    expect(cssBody.includes(selector), name).toBe(true);
    // **規則が空でない**(セレクタだけ置いて「実在する」と言わない)。
    const body = new RegExp(`\\.field-emphasis\\[data-emphasis="${name}"\\]\\s*\\{([^}]*)\\}`).exec(
      cssBody,
    );
    expect(body, name).not.toBeNull();
    expect((body as RegExpExecArray)[1]?.trim().length ?? 0, name).toBeGreaterThan(0);
  }
});

test("限定6: 4値の規則はどれも配色を実際に変える(文字色・地色・枠線色の3つを持つ)", () => {
  for (const name of EMPHASIS_NAMES) {
    const body =
      new RegExp(`\\.field-emphasis\\[data-emphasis="${name}"\\]\\s*\\{([^}]*)\\}`).exec(
        cssBody,
      )?.[1] ?? "";
    for (const property of ["color", "background-color", "border-color"]) {
      expect(
        new RegExp(`(^|[;{])\\s*${property}\\s*:`, "m").test(body),
        `${name}/${property}`,
      ).toBe(true);
    }
  }
});

test("限定6: 5値目の規則を書いていない(enum の外に当たり先を作らない)", () => {
  const values = [...cssBody.matchAll(/\.field-emphasis\[data-emphasis="([^"]+)"\]/g)].map(
    (match) => match[1] as string,
  );
  expect([...new Set(values)].sort()).toEqual([...EMPHASIS_NAMES].sort());
});

// --- (i) 限定5 / 限定7: 色のリテラルも座標系9プロパティも書いていない ---------------------

test("限定5: .field-emphasis の規則が使う色は var(--…) だけで、色のリテラルが1つも無い", () => {
  const rules = [...cssBody.matchAll(/(\.field-emphasis[^{}]*)\{([^}]*)\}/g)];
  // **規則を1本も読めていないのに緑になる壊れ方を防ぐ。**
  expect(rules.length).toBe(5);
  for (const rule of rules) {
    const body = rule[2] ?? "";
    // 16進・色関数・名前付き色を1つも書かない(限定3 / 限定5)。
    expect(/#[0-9a-fA-F]{3,8}\b/.test(body), rule[1]).toBe(false);
    expect(/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\s*\(/i.test(body), rule[1]).toBe(
      false,
    );
    for (const literal of ["red", "green", "orange", "yellow", "gray", "grey", "white", "black"]) {
      expect(new RegExp(`:\\s*${literal}\\b`).test(body), `${rule[1]} / ${literal}`).toBe(false);
    }
  }
});

test("限定5: 色の当たり先はすべて $defs/theme の25スロットの中である(新しい色スロットを1つも作っていない)", () => {
  const schema = JSON.parse(
    readFileSync(join(ROOT, "schemas", "manifest.schema.json"), "utf8"),
  ) as { $defs: { theme: { properties: Record<string, unknown> } } };
  const themeSlots = Object.keys(schema.$defs.theme.properties);
  // **`$defs/theme` の properties / required 25 を1つも動かしていない**(限定5)。
  expect(themeSlots).toHaveLength(25);

  const rules = [...cssBody.matchAll(/(\.field-emphasis[^{}]*)\{([^}]*)\}/g)];
  expect(rules.length).toBe(5);
  for (const rule of rules) {
    for (const declaration of (rule[2] ?? "").split(";")) {
      const match = /^\s*([a-z-]+)\s*:\s*var\(\s*(--[\w-]+)\s*\)\s*$/.exec(declaration);
      if (match === null) {
        continue;
      }
      const [, property, slot] = match as unknown as [string, string, string];
      if (!property.includes("color")) {
        continue;
      }
      // **色を運ぶ宣言のスロットは、必ず25スロットのどれかである。**
      expect(themeSlots.includes(slot), `${rule[1]} / ${property}: ${slot}`).toBe(true);
    }
  }
});

test("限定5: 使ったスロットはすべて styles.css の :root に既に在る(1つも新設していない)", () => {
  const slotsFile = readFileSync(
    join(import.meta.dir, "__fixtures__", "styles-token-slots.txt"),
    "utf-8",
  )
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  // **スロット集合は 28 のままである**(`web/test/styles.test.ts` の (c) が正)。
  expect(slotsFile).toHaveLength(28);
  const rules = [...cssBody.matchAll(/\.field-emphasis[^{}]*\{([^}]*)\}/g)];
  const used = new Set<string>();
  for (const rule of rules) {
    for (const reference of [...(rule[1] ?? "").matchAll(/var\(\s*(--[\w-]+)\s*\)/g)]) {
      used.add(reference[1] as string);
    }
  }
  // **1つも読めていないのに緑になる壊れ方を防ぐ。**
  expect(used.size).toBeGreaterThan(0);
  for (const slot of used) {
    expect(slotsFile.includes(slot), slot).toBe(true);
  }
});

test("限定7: .field-emphasis の規則に座標系9プロパティが1つも無い", () => {
  const rules = [...cssBody.matchAll(/(\.field-emphasis[^{}]*)\{([^}]*)\}/g)];
  expect(rules.length).toBe(5);
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
      expect(
        new RegExp(`(^|[;{])\\s*${property}\\s*:`, "m").test(rule[2] ?? ""),
        `${rule[1]} / ${property}`,
      ).toBe(false);
    }
  }
});

test("限定7: 座標系9プロパティが手で書く側の全量に1つも無い(既存の (ii) と同じ射程)", () => {
  // **`web/test/preset-boundary.test.ts` の (ii) が既に見ている条である。**
  // **ここでは「それが今日も緑であること」を、同じ射程で1本だけ確かめる。**
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
    expect(new RegExp(`(^|[;{])\\s*${property}\\s*:`, "m").test(cssBody), property).toBe(false);
  }
});

// --- (j) 限定8: 書かなかったフィールドは今日と1文字も変わらない ---------------------------

test("限定8: emphasis を持たない select の DOM は今日と完全一致する(クラスも属性も増えない)", () => {
  const element = renderValue(PLAIN, "入金済み");
  // **今日の形は `<span data-testid="field-value-select">入金済み</span>` である。**
  expect(element.outerHTML).toBe('<span data-testid="field-value-select">入金済み</span>');
});

test("限定8: emphasis に載っていない値は、同じ select でも今日と完全一致する", () => {
  const partial = { ...PLAIN, emphasis: { 決済できず: "danger" } } as Field;
  const element = renderValue(partial, "入金済み");
  expect(element.outerHTML).toBe('<span data-testid="field-value-select">入金済み</span>');
});

test("限定8: text 型の描画は1文字も変わっていない(分岐を割っても text は不変)", () => {
  cleanup();
  const text: Field = { id: "memo", name: "メモ", type: "text" };
  render(<FieldValue field={text} value={"あ"} referenceLabels={new Map()} appId="app" />);
  expect(screen.getByTestId("field-value-text").outerHTML).toBe(
    '<span data-testid="field-value-text">あ</span>',
  );
});

// --- (k) 意味の名前4値のとおりに data-emphasis が出る -----------------------------------

test("限定6: emphasis を持つ値には field-emphasis クラスと data-emphasis 属性が出る", () => {
  const element = renderValue(MARKED, "決済できず");
  expect(element.outerHTML).toBe(
    '<span class="field-emphasis" data-emphasis="danger" data-testid="field-value-select">決済できず</span>',
  );
});

test("限定6: 4値それぞれが data-emphasis にそのまま出る", () => {
  for (const name of EMPHASIS_NAMES) {
    const field = { ...PLAIN, emphasis: { 入金済み: name } } as Field;
    const element = renderValue(field, "入金済み");
    expect(element.getAttribute("data-emphasis"), name).toBe(name);
    expect(element.className, name).toBe("field-emphasis");
    expect(element.textContent, name).toBe("入金済み");
  }
});

test("限定6: 部品体系の Badge を使っていない(ADR-0087 の射程に入らない)", () => {
  const element = renderValue(MARKED, "入金済み");
  // `Badge` は変種ごとのクラスを付ける。**素の `<span>` + クラス名1つだけである。**
  expect(element.tagName).toBe("SPAN");
  expect(element.className).toBe("field-emphasis");
});

// --- 限定1 の帰結: 表示関数の引数を1本も増やしていない ------------------------------------

test("限定1: emphasis は field の中に入って届く(表示オプションの引数を足していない)", () => {
  const source = readFileSync(join(ROOT, "web", "src", "fields", "display.tsx"), "utf8");
  // `FieldValue` / `FieldCell` が受け取る表示オプションは今日も `textPreview` の1つだけ。
  const optionArgs = [...source.matchAll(/^\s{2}(\w+)\?: TextPreview;$/gm)].map((m) => m[1]);
  expect(optionArgs).toEqual(["textPreview", "textPreview"]);
  expect(source).not.toContain("emphasis?: Record");
});
