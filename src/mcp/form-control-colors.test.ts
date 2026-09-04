/**
 * **AI 向けの説明文が、ボタン・入力欄の色について今日の実物と一致していること**
 * (`V4-M29` / ユーザ決定 `D-V4-105` / `ADR-0087` 限定11 の履行)。
 *
 * ## なぜこの検査が要るか
 *
 * **`ADR-0087` 限定11 は逐語「`Δ5` を同じ差分で直す」を課したが、同 ADR 限定1(`src/` に
 * 1バイトも触らない)と正面衝突しており、`V4-M15` / `V4-M16` の2度にわたって未履行のまま
 * 申告だけが積まれていた**(`v4-m15-t19.md` §Q 1 / `v4-m16-t15.md` §Q 1)。
 * **ユーザ決定 `D-V4-105` が「説明文を直すことを優先する」と決めたので、本検査が
 * 「直したあとに新しい嘘が入らない」側を固定する。**
 *
 * ## この検査が固定するもの —— **双方向である**
 *
 * 1. **実装の真**(`web/src/` を直読みする)—— ボタンと入力欄の文字色・地色が
 *    25スロットからの導出であること。
 * 2. **記述**(`VOCABULARY_SCOPE` / `CANNOT_DO`)—— 「ブラウザ既定のまま」という
 *    **今日は偽の断定**が消えていること。
 * 3. **逆向きの嘘への歯止め** —— 「ボタンの色を選べるようになった」に倒れていないこと。
 *    **ボタン専用のスロットは今日も1つも無く、`$defs/theme` は 25 / 25 のままである。**
 *
 * ## この検査が言えないこと(**誇張しない**)
 *
 * - **CSS を1バイトも計算していない。** 読んでいるのはクラス名と `@theme inline` の
 *   宣言テキストであって、chromium での計算値ではない(`web/test/filled-button.test.tsx`
 *   の冒頭が同じ限界を書いている)。
 * - **「説明文が正しい」ことは証明していない。** 証明しているのは
 *   **名指しした偽の断定が消えたこと**と、**名指しした実装事実が実在すること**だけである。
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CANNOT_DO, VOCABULARY_SCOPE } from "./vocabulary.ts";

/** リポジトリ直下からの相対で読む(`vocabulary.test.ts` の `readSrc` と同型)。 */
function readRepo(...parts: string[]): string {
  return readFileSync(join(import.meta.dir, "..", "..", ...parts), "utf-8");
}

function manifestSchema(): {
  $defs: { theme: { properties: Record<string, unknown>; required: string[] } };
} {
  return JSON.parse(readRepo("schemas", "manifest.schema.json"));
}

/**
 * 部品側の変数 → 25スロットの導出(`web/src/tailwind.css` の `@theme inline`)。
 * **ボタン・入力欄の文字色と地色に実際に効いている分だけを挙げる。**
 */
const CONTROL_DERIVATIONS: readonly (readonly [string, string])[] = Object.freeze([
  ["--color-background", "var(--color-page-background)"],
  ["--color-foreground", "var(--color-text)"],
  ["--color-secondary", "var(--color-surface-highlight)"],
  ["--color-secondary-foreground", "var(--color-text)"],
  ["--color-destructive", "var(--color-danger)"],
  ["--color-input", "var(--color-border)"],
  ["--color-placeholder", "var(--color-text-placeholder)"],
]);

test("(M29-1) 実装の真: ボタン・入力欄の色に効く導出が生成側の入口に実在する", () => {
  const css = readRepo("web", "src", "tailwind.css");
  for (const [name, value] of CONTROL_DERIVATIONS) {
    expect(css.includes(`${name}: ${value};`), name).toBe(true);
  }
});

test("(M29-2) 実装の真: 入力部品の共通体裁が地色と文字色を対で持つ", () => {
  const source = readRepo("web", "src", "ui", "form-controls.tsx");
  // `controlBase` は `Input` / `Textarea` / `Select` の3部品が共有する。
  expect(source.includes('"bg-background text-foreground font-sans"')).toBe(true);
  expect(source.includes("placeholder:text-placeholder")).toBe(true);
  // **チェックボックスだけは地色を1つも持たない**(箱の地色は今日もブラウザ既定である)。
  const checkboxStart = source.indexOf("export function Checkbox");
  const checkboxEnd = source.indexOf("export function Label");
  expect(checkboxStart).toBeGreaterThan(-1);
  expect(checkboxEnd).toBeGreaterThan(checkboxStart);
  const checkbox = source.slice(checkboxStart, checkboxEnd);
  expect(/\bbg-[a-z-]+/.test(checkbox)).toBe(false);
  expect(checkbox.includes("accent-foreground")).toBe(true);
});

test("(M29-3) 実装の真: ボタンの全 variant が地色を1つ持つ", () => {
  const source = readRepo("web", "src", "ui", "button.tsx");
  const start = source.indexOf("variant: {");
  const end = source.indexOf("size: {", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end);
  // cva の variant 名(行頭の `name:` / `name:\n`)を拾う。
  const names = [...block.matchAll(/^\s{8}([a-z]+):/gm)].map((match) => match[1]);
  expect(names.length).toBeGreaterThanOrEqual(6);
  for (const name of names) {
    const at = block.indexOf(`${name}:`);
    const next = block.indexOf("\n", block.indexOf('"', block.indexOf('"', at) + 1));
    expect(block.slice(at, next).includes("bg-"), name).toBe(true);
  }
});

test("(M29-4) 記述: 「ブラウザ既定のまま」という今日は偽の断定が2つの定数から消えている", () => {
  for (const [label, text] of [
    ["VOCABULARY_SCOPE", VOCABULARY_SCOPE],
    ["CANNOT_DO", CANNOT_DO],
  ] as const) {
    // **`ADR-0087` §2 が逐語で挙げた偽の断定**(4行のうち説明文に残っていた分)。
    expect(text.includes("の文字色と地色もブラウザ既定のままです"), label).toBe(false);
    expect(text.includes("の文字色と地色**はブラウザ既定のままです"), label).toBe(false);
  }
  // **`ADR-0087` §2 の4行目**(偽の前提から導かれていた帰結)。
  expect(CANNOT_DO.includes("(だから「ボタンの色を変えて」は今もできません)")).toBe(false);
});

test("(M29-5) 記述: できるようになったことが両方の定数に書かれている", () => {
  expect(VOCABULARY_SCOPE).toContain("ブラウザ既定ではありません");
  expect(CANNOT_DO).toContain("ブラウザ既定ではありません");
});

test("(M29-6) 記述: 逆向きの嘘(ボタンの色を選べる)に倒れていない", () => {
  // **ボタンだけを別の色にすることは今日もできない**(`D-V4-104` でユーザが導出を受け入れた)。
  expect(CANNOT_DO).toContain("ボタンだけを別の色に");
  expect(VOCABULARY_SCOPE).toContain("ボタンだけを別の色に");
  // **今日も本当にブラウザ既定である場所を名指しで残す**(全否定を全肯定に反転させない)。
  expect(CANNOT_DO).toContain("チェックボックスの箱の地色");
  expect(VOCABULARY_SCOPE).toContain("チェックボックスの箱の地色");
});

test("(M29-7) 記述: 当たらない範囲(シェル)は今日も残っている", () => {
  // `vocabulary.test.ts` の「逆向きの歯止め」が固定している2語を落としていない。
  expect(CANNOT_DO).toContain("プラットフォームの外枠(シェル)");
  expect(CANNOT_DO).toContain("フォームコントロール");
  expect(VOCABULARY_SCOPE).toContain("プラットフォームの外枠(シェル)");
});

test("(M29-8) 実装の真: 色のスロットにボタン専用は1つも無い(25 / 25 のまま)", () => {
  const theme = manifestSchema().$defs.theme;
  const slots = Object.keys(theme.properties);
  expect(slots).toHaveLength(25);
  expect(theme.required).toHaveLength(25);
  // **色のスロットは8つで、そのどれもボタン専用・入力欄専用ではない。**
  const colorSlots = slots.filter((slot) => slot.startsWith("--color-"));
  expect(colorSlots).toHaveLength(8);
  for (const slot of colorSlots) {
    expect(/button|input|control|primary/i.test(slot), slot).toBe(false);
  }
  // **【正直に書く】フォームコントロール専用のスロットは今日1本だけ実在する** ——
  // 角丸である。**説明文はこれを名指しで書く**(「専用のスロットは1つも無い」と
  // 書くと、それ自体が新しい嘘になる)。
  const controlSpecific = slots.filter((slot) => /control/i.test(slot));
  expect(controlSpecific).toEqual(["--control-border-radius"]);
  expect(VOCABULARY_SCOPE).toContain("--control-border-radius");
});

test("(M29-9) 記述: 25スロットの側から書いていることが分かる形になっている", () => {
  // **実装の真**: 導出元は25スロットのうちこの6つである。
  const slots = Object.keys(manifestSchema().$defs.theme.properties);
  const used = [
    "--color-page-background",
    "--color-text",
    "--color-surface-highlight",
    "--color-danger",
    "--color-border",
    "--color-text-placeholder",
  ];
  for (const slot of used) {
    expect(slots, slot).toContain(slot);
    expect(VOCABULARY_SCOPE, slot).toContain(slot);
  }
});
