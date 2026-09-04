/**
 * **配られる CSS の集合が全量であることの検査**(`V4-M15-T02` / `T07`。
 * `ADR-0088` 限定1 / 限定2 / 限定4 / 限定5 / 限定6、`ADR-0089` 限定2 / 限定3 / 限定6、
 * `ADR-0087` 限定6 / 限定10)。
 *
 * ## この検査が言えること / 言えないこと
 *
 * **言えること**: `web/src` 配下の CSS は `STYLE_SOURCES` の2本だけであり、
 * それ以外の CSS を `web/src` に置くと赤くなる。TypeScript から `import` される CSS も
 * その2本だけである。**したがって「別ファイルに書けば検査に当たらない」は今日から成立しない。**
 *
 * **言えないこと**(隠さない):
 * 1. **`web/src` の外に CSS を置いた場合は、本ファイルでは見ていない。**
 *    **【`V4-M47` が 2026-08-04 に訂正】着手前の本コメントは置き場を **3つ**
 *    (`src` / `schemas` / `scripts`)と書いていたが、**`ADR-0088` 限定1 第2列が
 *    名指ししているのは4つである** —— 逐語「**CSS を `src/` にも `schemas/` にも
 *    `scripts/` にも置かない。`data/` にも置かない**」。**同じ行の第4列(機械的固定)は
 *    `src` / `schemas` の **2つ**しか数えていない。** **条文(2)/ 本コメント(3)/
 *    第2列(4)で三者三様だった**(`docs/plan/v4/records/v4-m46.md` §2-4 が発見)。
 *    **今日は4つとも `scripts/style-location-scope.test.ts` が機械で見ている。**
 *    **【`V4-M50` が 2026-08-04 に再訂正】着手前の本コメントは「条文の第4列は今日も
 *    2つのままである」と書いていたが、**今日は違う**。** **`V4-M50` 単位A(門A・限定採用)
 *    が第4列の数え方を引き直し、今日の正は [`ADR-0155`](../../docs/adr/0155-style-location-scope-check-rescope.md)
 *    §Decision 2【今日の正の式】に移った** —— **4箇所の `.css` を、ファイル系を直接
 *    歩いて数える形である**(**バージョン管理の差分を1度も読まない**)。
 *    **`ADR-0088` 限定1 の条文そのものは1バイトも書き換わっていない**(行末の
 *    追記マーカーが `ADR-0155` を指す)。**したがって「条文(2)/ 本コメント(4)/
 *    第2列(4)」の食い違いは、今日「4 / 4 / 4」に揃った。**
 *    **【禁止】これを「条文と検査の食い違いを解消した」と書かない** —— **揃ったのは
 *    「いくつの置き場を、どの拡張子について数えるか」だけである。** **`.ts` の中の
 *    テンプレート文字列に CSS を書く経路は、条文も機械も今日なお何も見ていない**
 *    (`ADR-0155` 限定3 がそれを明文の限定にした)。
 * 2. **ビルド出力そのものを読んでいない。** 読むには `bun run build:web` が要り、
 *    `bun test` の中で走らせると数十秒かかる。**代わりに入口(`@import`)を押さえている。**
 * 3. **逃げ道(任意 CSS)は集合に入らない。** あれはマニフェストの外の
 *    content-addressed ストアにあり、`ViewHost.tsx` が実行時に `<style>` で当てる
 *    (`ADR-0055`)。**本検査はその経路が1本だけであることを確かめる。**
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  discoverCssFiles,
  discoverSourceFiles,
  HANDWRITTEN_SOURCES,
  readStyleSource,
  STYLE_SOURCES,
} from "./style-source-set.ts";

/** ブロックコメント・行コメントを落とす(**説明文の中の字面を経路と読まないため**)。 */
function stripCodeComments(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// ---------------------------------------------------------------------------
// (集合1) 集合が全量である
// ---------------------------------------------------------------------------

test("(集合1) web/src 配下の CSS は宣言した集合と完全一致する", () => {
  // **ADR-0088 限定6 が実数の記録を求める。着手前1本 → 着手後2本。**
  expect(STYLE_SOURCES.length).toBe(2);
  expect(discoverCssFiles()).toEqual([...STYLE_SOURCES].map((s) => s.path).sort());
});

test("(集合2) TypeScript から import される CSS が集合の外に1本も無い", () => {
  const declared = new Set(STYLE_SOURCES.map((s) => s.path.replace(/^\.\//, "")));
  const imported: string[] = [];
  for (const file of discoverSourceFiles()) {
    for (const match of readFileSync(file, "utf-8").matchAll(/import\s+"([^"]+\.css)"/g)) {
      imported.push((match[1] ?? "").replace(/^\.\//, ""));
    }
  }
  // **1本も import されていない、で緑になる壊れ方を防ぐ**(`kernel-export-drift.test.ts` と同手口)。
  expect(imported.length).toBe(2);
  for (const path of imported) {
    expect(declared.has(path), path).toBe(true);
  }
});

test("(集合3) 実行時に CSS を差し込む経路が、名指しした1本だけである", () => {
  // 逃げ道(ADR-0055)は `ViewHost.tsx` の `<style>` 1本だけ。**それ以外に増えたら赤にする。**
  const offenders: string[] = [];
  for (const file of discoverSourceFiles()) {
    // **コメントを落としてから見る** —— 説明文の中の `<style>` は経路ではない。
    const body = stripCodeComments(readFileSync(file, "utf-8"));
    if (/<style[\s>]/.test(body) || /insertRule|styleSheets\[/.test(body)) {
      offenders.push(file);
    }
  }
  expect(offenders.map((f) => f.split("/").slice(-1)[0]).sort()).toEqual(["ViewHost.tsx"]);
});

// ---------------------------------------------------------------------------
// (集合4) 置き場ごとの冒頭宣言(ADR-0088 限定4)
// ---------------------------------------------------------------------------

test("(集合4) 集合の各要素が「ここに何を書いてよいか」の宣言を持つ", () => {
  for (const source of STYLE_SOURCES) {
    const body = readStyleSource(source);
    expect(body.startsWith("/*"), source.path).toBe(true);
    expect(body.includes(source.headerMarker), source.path).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// (集合5) 生成側の置き場に置いてはならないもの
// ---------------------------------------------------------------------------

test("(集合5) 生成側の入口に、セレクタを持つ手書きの規則が1つも無い", () => {
  for (const source of STYLE_SOURCES.filter((s) => s.kind === "generated")) {
    const body = readStyleSource(source).replace(/\/\*[\s\S]*?\*\//g, "");
    // at-rule のブロック(`@theme { … }` / `@custom-variant …`)だけが許される。
    // ブロックの外に `{` が現れたら、それはセレクタを持つ規則である。
    const withoutAtBlocks = body.replace(/@[a-z-]+[^{;]*(\{[^{}]*\}|;)/g, "");
    expect(withoutAtBlocks.includes("{"), source.path).toBe(false);
  }
});

test("(集合6) 集合の全要素に、色のリテラルが1つも無い", () => {
  // **色は25スロットから導出する**(ADR-0087 限定7)。**生成側の入口にも
  // `#rrggbb` / `rgb(` / `oklch(` を1つも書かない** —— 書けば「テーマの入口が2つに割れる」。
  // (`styles.css` の `:root` は例外である。そこがスロットの定義そのものだからで、
  //  その中身は `styles.test.ts` の (b) / (c) が別に押さえている。)
  for (const source of STYLE_SOURCES.filter((s) => s.kind === "generated")) {
    const body = readStyleSource(source).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(/#[0-9a-fA-F]{3,8}\b/.test(body), source.path).toBe(false);
    expect(/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\s*\(/i.test(body), source.path).toBe(
      false,
    );
  }
});

// ---------------------------------------------------------------------------
// (集合7) 配色設定の切り替え機構(ADR-0087 限定10 / ADR-0089 限定6)
// ---------------------------------------------------------------------------

/**
 * **【重要】これは「ダークモードを機械で止める検査」ではない。**
 *
 * `D-V4-47`(ユーザ決定)は **「ダークモードを機械で止める検査は作らない」** と定めた。
 * **本検査は新設ではなく、着手前から `preset-boundary.test.ts:173` / `:174` に在った
 * 2本の当たり先を、1ファイルから集合へ広げただけである**(`ADR-0089` 限定5 が
 * 「この2本を残す」ことを義務づけている)。
 *
 * **【禁止】これを「ダークモードを止めている」と書かない。**
 * **【禁止】「ダークモードに対応した」とも書かない。**
 * `light-dark()` と `color-scheme:` を見る検査は**今日も0件である**(`ADR-0089` 限定6 の
 * 第4列が「機械的固定を置かない」と定めた)。**守っているのは人の側の約束だけである。**
 */
test("(集合7) 着手前から在った2本の文字列検査が、集合の全要素に当たる", () => {
  for (const source of STYLE_SOURCES) {
    const body = readStyleSource(source);
    expect(body.includes("prefers-color-scheme"), source.path).toBe(false);
    expect(body.includes("[data-theme]"), source.path).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// (集合8) 断点の本数(ADR-0089 限定3)
// ---------------------------------------------------------------------------

/**
 * **断点の本数を有限に固定する。実数は 2 である。**
 *
 * `sm` = 40rem / `lg` = 64rem。**Tailwind 既定の5本(40 / 48 / 64 / 80 / 96rem)は
 * `--breakpoint-*: initial` で全部消してある。**
 * **AI も owner も断点を1つも指定できない** —— 語彙に置き場が無く、
 * `schemas/manifest.schema.json` に1バイトも触っていない。
 */
export const BREAKPOINT_COUNT = 2;

test("(集合8) 断点が有限で、宣言した本数と一致する", () => {
  const generated = STYLE_SOURCES.filter((source) => source.kind === "generated");
  expect(generated.length).toBe(1);
  const entry = generated.map(readStyleSource).join("\n");
  const declared = [...entry.matchAll(/--breakpoint-([a-z0-9]+)\s*:\s*([^;]+);/g)]
    .map((m) => `${m[1]}=${(m[2] ?? "").trim()}`)
    .sort();
  expect(declared).toEqual(["lg=64rem", "sm=40rem"]);
  expect(declared.length).toBe(BREAKPOINT_COUNT);
  // **既定の断点を消していること**(消し忘れると本数が 5 に戻る)。
  expect(entry.includes("--breakpoint-*: initial")).toBe(true);
});

// ---------------------------------------------------------------------------
// (集合9) safelist を1行も置かない(ADR-0087 限定6)
// ---------------------------------------------------------------------------

test("(集合9) 構成ファイルに safelist が1行も無い", () => {
  const configs = [
    "web/vite.config.ts",
    "package.json",
    "web/src/tailwind.css",
    // Tailwind v3 の構成ファイルは存在しない(v4 は CSS が構成である)。
  ];
  for (const path of configs) {
    const full = new URL(`../../${path}`, import.meta.url).pathname;
    // **コメントを落としてから見る** —— 「safelist を置かない」と書いた説明文は設定ではない。
    expect(stripCodeComments(readFileSync(full, "utf-8")).includes("safelist"), path).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// (集合10) 手で書く側の本数(ADR-0088 限定5)
// ---------------------------------------------------------------------------

test("(集合10) 完全一致固定の対象は手で書く側だけである", () => {
  expect(HANDWRITTEN_SOURCES.map((s) => s.path)).toEqual(["styles.css"]);
});
