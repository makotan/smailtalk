/**
 * `web/src/styles.css` のスロット集合とその解決後の値の機械検査。
 *
 * - 導入は **V3-M0-T04**(既存リテラルを CSS 変数へ 1 対 1 で写した門外作業。33スロット)。
 * - **V3-M1-T01**(意味の名前への移行 + 束ね + 新設7軸。28スロット / 宣言78件)。
 *   完了条件の正は `docs/plan/v3/records/v3-m1.md` 「### V3-M1-T01」節、
 *   スロット集合の正は `docs/plan/v3/03-token-slot-inventory.md` §9、
 *   増分の限定は `docs/adr/0046-design-token-slots.md` §3(とくに限定2 と限定5)。
 * - 現在の基準は **V3-M3-T02**(レコード間の遷移。**規則も宣言も1件も増えていない** ——
 *   **113件のまま**である)。変わったのは**3規則のセレクタだけ**で、遷移点が増えたぶん
 *   当たり先を広げた: `.list-row-interactive` → `+ .related-row-interactive`(`cursor` と
 *   `:hover` / `:focus-visible` の2規則)、`.list-detail-target-note` → `+ .detail-target-note`。
 *   **プロパティも解決後の値も1つも変えていない**ので、(a) の差は5件のセレクタ文字列だけである。
 *   **`:root` にも `--surface-shadow` の当たり先にも1バイトも触っていない**((g) / (h) は
 *   規則の**数**を見るので、同じ規則にセレクタを足しても数は変わらない)。
 *   完了条件の正は `docs/plan/v3/records/v3-m3.md` §2 の「V3-M3-T02」節。
 * - その前の基準は **V3-FIX-01**(影の当たり先の是正。**スロットも軸も1件も増えていない**が、
 *   規則が3つ増えて宣言は **113件**になった)。増えた4件はすべて
 *   `box-shadow: var(--surface-shadow)` の参照で、当たり先は `.list-table`(既存規則へ追加)/
 *   `.related-table` / `.detail-fields` / `.record-form` である。**`:root` には1件も足していない。**
 *   **既定値が `none` なので、既存109件は1バイトも動いておらず、テーマを持たないアプリの
 *   描画は1ピクセルも変わらない**(chromium 実測は `web/e2e/theme-baseline.e2e.ts`)。
 *   経緯と当たり先の判定理由は `docs/plan/v3/records/v3-fix-01.md`。
 * - その前の基準は **V3-M2-T03**(詳細の画面プリセット。**スロットは1件も増えていない**が、
 *   規則が8つ増えて宣言は **109件**になった)。増えた14件は項目名と値の向き3件
 *   (`.detail-fields[data-preset-label="…"]` 経由の `flex-direction` 2件と、**縦積みのときだけ
 *   `--detail-label-width` を無効化する `flex: 0 0 auto` 1件**。`docs/adr/0050-view-display-presets.md`
 *   限定8)、項目の段組数5件(`display: grid` 2件 + `grid-template-columns` 2件 + `column-gap` 1件)、
 *   `image` の表示サイズ6件(`.list-view` と `.detail-view` の器を1規則にまとめた3段階 ×
 *   `max-width` / `max-height`)で、**`:root` には1件も足していない**(経路B。限定5)。
 *   **セレクタにアプリID・画面ID・フィールドIDは1つも現れない**(限定11)。
 *   **既存の95件は1バイトも動いていない** = プリセットを書いていない画面は
 *   1ピクセルも変わらない(`docs/adr/0051-layout-ledger-f5.md` 限定4)。
 * - その前の基準は **V3-M2-T02**(一覧の画面プリセット。**スロットは1件も増えていない**が、
 *   規則が7つ増えて宣言は **95件**になった)。増えた7件は列の幅の段階値3件
 *   (`.list-table col[data-preset-width="…"]` の `width`)と、その表にだけ掛ける
 *   `table-layout: fixed` 1件、列の寄せ3件(`th`/`td` の `text-align`)で、
 *   **`:root` には1件も足していない**(経路B。`docs/adr/0050-view-display-presets.md` 限定5)。
 *   **セレクタにアプリID・画面ID・フィールドIDは1つも現れない**(限定11)。
 *   **既存の88件は1バイトも動いていない** = プリセットを書いていない画面は
 *   1ピクセルも変わらない(`docs/adr/0051-layout-ledger-f5.md` 限定4)。
 * - その前の基準は **V3-M1-T05**(テーマの持ち出し口。**スロットは1件も増えていない**が、
 *   規則が2つ増えて宣言は **88件**になった)。増えた4件は `.theme-export-copy` の3件
 *   (要件定義書のコピー行 `.requirements-copy` と同じ形)と `.theme-export-css` の
 *   `overflow-x: auto` 1件(生成物の行が長いときにページ全体が横へ伸びるのを防ぐ器)で、
 *   **既存スロットの参照だけであり、色リテラルも新しいスロットも1つも足していない**
 *   (`docs/plan/v3/records/v3-m1-t05.md`)。
 * - その前の基準は **V3-M1-T04**(アプリ単位テーマのスコープ要素。**スロットは1件も
 *   増えていない**が、規則が2つ増えて宣言は **84件**になった)。増えた6件の内訳は
 *   `docs/plan/v3/records/v3-m1-t04.md` §5 が1件ずつ持つ —— `.app-theme` の4件
 *   (文字色 / 地色 / 書体 / 行間の**再宣言**。`body` で `var()` が解決されるため
 *   スコープ要素側にもう一度書かないとテーマが効かない)と
 *   `button, input, select, textarea` の2件(`font-family: inherit` /
 *   `line-height: inherit`。**この2件は描画を実際に変える** —— UA 既定の `Arial` /
 *   `normal` から `system-ui, sans-serif` / `25.6px` になる。chromium 実測)。
 *
 * ## この6本が何を証明し、何を証明しないか
 *
 * - **(a) 計算値の同一性** —— `var()` を `:root` の定義で解決したあとの
 *   (セレクタ, プロパティ, 値) の集合が `__fixtures__/styles-baseline.json` と完全一致する。
 *   **「見た目を変えていない」ことの実証はこれが担う。** 基準は HEAD `38a99a0` 時点の
 *   76件から、V3-M1-T01 が **死んだ規則 `.view-placeholder` の3件を落とし、新設7軸の
 *   宣言5件を足した78件**である(削除と追加の理由は T01 の実施記録にある)。
 * - **(b) 色を表しうるリテラルが `:root` の外に1つも無い。**
 * - **(c) スロット集合の固定**(`__fixtures__/styles-token-slots.txt` と完全一致)。
 * - **(d) スナップショットに載っているスロットが全て少なくとも1箇所で参照されている。**
 * - **(e) 参照されている `var(--…)` が全て `:root` で定義されている。**
 * - **(f) 冒頭の禁止コメントが変更前と逐語一致している。**
 * - **(g) 当たり先が1規則しかないスロットの集合が、明示列挙したものと完全に一致する**
 *   (**V3-FIX-01 が新設**。下の「(d) が捕まえられなかったもの」を参照)。
 * - **(h) `--surface-shadow` の当たり先が、面と判定した5規則と完全に一致する**
 *   (**V3-FIX-01 が新設**)。
 *
 * ## (d) が捕まえられなかったもの(V3-FIX-01 の是正の理由)
 *
 * **(d) は「1箇所以上」しか見ない。** V3-M1 が新設した7軸のうち **`--surface-shadow` は
 * `.login` 1箇所にしか当たっておらず**(V3-M2-T06 の R39 が実測して見つけた。
 * `docs/plan/v3/records/v3-m2-t06.md` §3-4)、**利用者がテーマで影を指定しても
 * ログイン画面のカード以外は1ピクセルも変わらなかった。それでも (a)〜(f) は全部緑だった。**
 *
 * **(g) は「防ぐ」ためのものではない。** 当たり先が1規則だけであること自体は妥当な場合が
 * あり(`--shell-max-width` / `--login-max-width` など)、**一律に「2箇所以上」を要求するのは
 * 誤りである。** (g) が要求するのは「**1箇所しかないスロットが黙って増えないこと**」だけで、
 * 増減はどちらも赤になる。**赤くなったら列挙を書き換える前に、その状態が妥当かを人間が
 * 判断すること**(検査 (c) と同じ作法)。
 *
 * **(a) は CSS のテキストしか見ない。** ブラウザでの計算値は
 * `web/e2e/theme-baseline.e2e.ts`(V3-M1-T01 が新設。chromium の `getComputedStyle`)が
 * 見る —— **ページ地色とフォーカスリングは (a) では「追加」に見えるが、描画は実際に変わる。**
 * その2軸の変化の中身はその E2E が期待値として固定している。
 *
 * ## 限界(先に書く。憲法6)
 *
 * 1. 本ファイルの解析器は `styles.css` の現在の形(フラットな規則のみ・at-rule なし)を
 *    前提にしている。`@media` 等が入ったら `parseRules` は例外を投げる(黙って通さない)。
 *    **これは ADR-0046 限定5(`@media` / `prefers-color-scheme` / `[data-theme]` を
 *    1つも足さない)を構造で固定している唯一の仕掛けでもある。**
 * 2. カスケード・詳細度・継承は解いていない。**同じ (セレクタ, プロパティ) の対に
 *    複数の宣言が現れたら (a) は集合として持つ**ため、宣言の並び替えは検出できない。
 * 3. **DOM に当たる要素があるかは見ない。** V3-M1-T01 は唯一の死んだ規則
 *    (`.view-placeholder`。`styles.css` 以外からの参照が0件)を削除したが、
 *    **同じ形の死んだ規則を新しく書いても (a)〜(h) は緑のままである。**
 * 4. **(g) / (h) が数えるのは「規則(セレクタ)の数」であって「画面上の要素の数」ではない。**
 *    セレクタが実在の DOM に当たっているかは相変わらず見ない(限界3 と同じ穴)。
 *    **当たっていることの実測は `web/e2e/theme.e2e.ts` / `web/e2e/theme-baseline.e2e.ts` が担う。**
 * 5. **(g) は「当たり先が1規則だけであること」が妥当かどうかを判断しない。** 判断するのは
 *    人間であり、(g) は状態を見える形に固定するだけである。
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HANDWRITTEN_SOURCES, styleSourcePath } from "./style-source-set.ts";

/**
 * **読む対象は「ファイル名1つ」ではなく「配られる CSS の集合のうち手で書く側」である**
 * (`V4-M15-T02`。`ADR-0088` 限定2 / 限定5)。集合の定義と全量性は
 * `web/test/style-source-set.ts` と `web/test/style-sources.test.ts` が持つ。
 *
 * **2026-08-03 の着手前は `const STYLES_PATH = join(…, "src", "styles.css")` の1行だった。**
 * **【正直に書く】手で書く側は今日も1本である**(`styles.css`)。**集合にしたことで
 * 本数が増えたわけではない** —— 増えたのは「増やしたら検査が気づく」ことのほうである。
 */
const HANDWRITTEN_PATHS = HANDWRITTEN_SOURCES.map(styleSourcePath);
const BASELINE_PATH = join(import.meta.dir, "__fixtures__", "styles-baseline.json");
const SLOTS_PATH = join(import.meta.dir, "__fixtures__", "styles-token-slots.txt");

type Declaration = { property: string; value: string };
type Rule = { selector: string; declarations: Declaration[] };
type Triple = { selector: string; property: string; value: string };

// ---------------------------------------------------------------------------
// 解析器(`__fixtures__/styles-baseline.json` を作ったものと同一のロジック)
// ---------------------------------------------------------------------------

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function normalizeSpace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function normalizeSelector(selector: string): string {
  return selector.split(",").map(normalizeSpace).join(", ");
}

/**
 * **通す at-rule の列挙**(`V4-M15-T07`。`ADR-0089` 限定1 / 限定2)。
 *
 * ## 何を変えたのか(隠さない)
 *
 * **2026-08-03 の着手前は `if (body.includes("@")) { throw … }` の3行だった** ——
 * **`@` を1文字でも見つけたら例外**である。`ADR-0046` 限定5 の第4列はそれを
 * 「構造的に不可能」と呼んでいた。
 *
 * **`ADR-0089` はその射程を「幅の条件の `@media`」の分だけ引き直した。**
 * **【禁止】「限定5 を1バイトも緩めていない」と書かない。緩めている。**
 *
 * **改めた後の形は「解析器を緩める」ではなく「通すものの有限の列挙」である**
 * (`ADR-0046:165` が立てた問いへの答え。`ADR-0089` §3):
 *
 * - **通すのは `@media` だけ。** `@import` / `@charset` / `@supports` / `@container` /
 *   `@scope` / `@layer` / `@property` / `@keyframes` / `@font-face` は今日どおり例外を投げる。
 * - **`@media` のうち通すのは幅の条件だけ。** `min-width` / `max-width` 以外の
 *   メディア特性(`prefers-color-scheme` / `prefers-reduced-motion` / `prefers-contrast` /
 *   `orientation` / `print` / `hover` / `pointer` ほか)は1つも通さない。
 * - **メディア型(`screen` / `print`)も `not` / `only` も通さない。**
 * - **入れ子の `@media` を通さない。**
 */
const ALLOWED_AT_RULE = "media";

/** 幅の条件1つの形。**この正規表現の外は全部例外である。** */
const WIDTH_CONDITION_RE =
  /^\(\s*(min-width|max-width)\s*:\s*(0|[0-9]{1,4}(\.[0-9]{1,3})?(px|rem|em))\s*\)$/;

/** 集合の1要素から取り出した `@media` のブロック。 */
type MediaBlock = { condition: string; body: string };

/**
 * 深さ0の `@…` を取り出し、それ以外の本文を返す。
 *
 * **黙って読み飛ばさない** —— 読み飛ばすと (a) が緑のまま意味を失う。
 */
function extractAtRules(body: string): { media: MediaBlock[]; rest: string } {
  const media: MediaBlock[] = [];
  let rest = "";
  let index = 0;
  while (index < body.length) {
    const at = body.indexOf("@", index);
    if (at < 0) {
      rest += body.slice(index);
      break;
    }
    rest += body.slice(index, at);
    const nameMatch = /^@([a-zA-Z-]+)/.exec(body.slice(at));
    const name = nameMatch?.[1] ?? "";
    if (name !== ALLOWED_AT_RULE) {
      throw new Error(
        `通さない at-rule である: @${name}(通すのは @${ALLOWED_AT_RULE} の幅の条件だけ。ADR-0089 限定2)`,
      );
    }
    const open = body.indexOf("{", at);
    if (open < 0) {
      throw new Error(`@${name} にブロックが無い`);
    }
    const condition = normalizeSpace(body.slice(at + 1 + name.length, open));
    // 波括弧の対応を数えてブロックの終わりを見つける。
    let depth = 0;
    let close = -1;
    for (let i = open; i < body.length; i += 1) {
      if (body[i] === "{") depth += 1;
      else if (body[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close < 0) {
      throw new Error(`@${name} のブロックが閉じていない`);
    }
    const inner = body.slice(open + 1, close);
    if (inner.includes("@")) {
      throw new Error("@media の入れ子は通さない(ADR-0089 限定2)");
    }
    media.push({ condition, body: inner });
    index = close + 1;
  }
  return { media, rest };
}

/** 条件が幅だけであることを確かめる。**列挙の外は例外である。** */
function assertWidthOnly(condition: string): void {
  const parts = condition.split(/\s+and\s+/);
  for (const part of parts) {
    if (!WIDTH_CONDITION_RE.test(part.trim())) {
      throw new Error(
        `幅以外のメディア特性は通さない: ${condition}(通すのは min-width / max-width だけ。ADR-0089 限定1)`,
      );
    }
  }
}

function parseFlatRules(body: string, mediaCondition?: string): Rule[] {
  const rules: Rule[] = [];
  for (const match of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const bare = normalizeSelector(match[1] ?? "");
    // **`@media` の内側の規則は、セレクタに条件を前置して区別する。**
    // 条件が違えば同じセレクタでも別の三つ組になる((a) が両方を見る)。
    const selector = mediaCondition === undefined ? bare : `@media ${mediaCondition} { ${bare} }`;
    const declarations: Declaration[] = [];
    for (const chunk of (match[2] ?? "").split(";")) {
      const text = normalizeSpace(chunk);
      if (text === "") continue;
      const colon = text.indexOf(":");
      if (colon < 0) {
        throw new Error(`宣言として読めない断片: ${text}`);
      }
      declarations.push({
        property: text.slice(0, colon).trim(),
        value: normalizeSpace(text.slice(colon + 1)),
      });
    }
    rules.push({ selector, declarations });
  }
  return rules;
}

function parseRules(css: string): Rule[] {
  const body = stripComments(css);
  const { media, rest } = extractAtRules(body);
  for (const block of media) {
    assertWidthOnly(block.condition);
  }
  const rules = parseFlatRules(rest);
  for (const block of media) {
    rules.push(...parseFlatRules(block.body, block.condition));
  }
  return rules;
}

/** `@media` の条件を全部取り出す(**断点を数えるため**。`ADR-0089` 限定3)。 */
function mediaConditionsOf(css: string): string[] {
  return extractAtRules(stripComments(css)).media.map((block) => block.condition);
}

/** `:root` で定義されたカスタムプロパティ(= スロット)。 */
function rootVariables(rules: Rule[]): Map<string, string> {
  const vars = new Map<string, string>();
  for (const rule of rules) {
    if (rule.selector !== ":root") continue;
    for (const declaration of rule.declarations) {
      if (declaration.property.startsWith("--")) {
        vars.set(declaration.property, declaration.value);
      }
    }
  }
  return vars;
}

const VAR_REF_RE = /var\(\s*(--[\w-]+)\s*\)/g;

function resolveValue(value: string, vars: Map<string, string>): string {
  let current = value;
  for (let round = 0; round < 10; round += 1) {
    const next = current.replace(VAR_REF_RE, (whole, name: string) => {
      const replacement = vars.get(name);
      return replacement === undefined ? whole : replacement;
    });
    if (next === current) return normalizeSpace(current);
    current = next;
  }
  throw new Error(`var() の解決が収束しない: ${value}`);
}

function sortKey(triple: Triple): string {
  return `${triple.selector}|${triple.property}|${triple.value}`;
}

/**
 * (セレクタ, プロパティ, 解決後の値) の集合。
 *
 * **カスタムプロパティの宣言(`--*`)は含めない。** 基準は変数が1つも無かった HEAD 時点の
 * ファイルから採っているため、スロットの定義そのものを数えると必ず食い違う。
 * 一方 `:root` に**カスタムプロパティ以外**の宣言を紛れ込ませたら、それはここに現れて赤になる。
 */
function triplesOf(css: string): Triple[] {
  const rules = parseRules(css);
  const vars = rootVariables(rules);
  const out: Triple[] = [];
  for (const rule of rules) {
    for (const declaration of rule.declarations) {
      if (declaration.property.startsWith("--")) continue;
      out.push({
        selector: rule.selector,
        property: declaration.property,
        value: resolveValue(declaration.value, vars),
      });
    }
  }
  // **`localeCompare` を使わない。** ICU の照合順は実行環境(ロケール)に依存し、
  // 生成スクリプトと `bun test` で並びが変わって (a) が偽の赤になった実績がある。
  // コード単位の比較にすると環境に依らず一意に決まる。
  return out.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
}

function readSnapshotLines(path: string): string[] {
  return readFileSync(path, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/**
 * **手で書く側の全要素を連結して読む**(`ADR-0088` 限定2 / 限定5)。
 * **【正直に書く】今日この配列の要素は1本である。** 2本目(`tailwind.css`)は
 * 生成側なので、完全一致固定の対象にしない —— **固定の射程はその分だけ縮んだ。**
 */
const css = HANDWRITTEN_PATHS.map((path) => readFileSync(path, "utf-8")).join("\n");
const rules = parseRules(css);
const nonRootRules = rules.filter((rule) => rule.selector !== ":root");

// ---------------------------------------------------------------------------
// (a) 計算値の同一性
// ---------------------------------------------------------------------------

test("(a) var() 解決後の (セレクタ, プロパティ, 値) が基準と完全一致する", () => {
  const actual = triplesOf(css);
  const expected: Triple[] = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));

  // 対象を読めていないのに「差が無い」で緑になる壊れ方を防ぐ
  // (`scripts/kernel-export-drift.test.ts` の2本目と同じ手口)。
  //
  // **113 → 116(V3-M4-T01 / D-G7)**。増えたのは `.theme-preview-list` の3宣言だけで、
  // 既存の113件は1件も動いていない(`display` / `gap` / `grid-template-columns`)。
  // **数字を書き換えるときは、増えた分がその1規則で説明できることを確かめること。**
  //
  // **116 → 123(V4-M2-T03 / 単位 `B-G4`。門外 Δ7)**。増えたのは**画面一覧を左カラムに
  // 置く器の3規則7宣言だけ**で、**既存の116件は1件も動いていない**(実測: added 7 / removed 0):
  //   - `.workspace-body`(4) …… `display: flex` / `flex-wrap: wrap` /
  //     `align-items: flex-start` / `gap: var(--space-4)`
  //   - `.workspace-body > .view-list`(1) …… `flex: 1 1 12rem`
  //   - `.workspace-body > .workspace-main`(2) …… `flex: 999 1 60%` / `min-width: 0`
  //
  // **`@` を1文字も足していない**(足すと上の `parseRules` が例外を投げる)。
  // **`:root` に1スロットも足していない**((c) の 28 は動いていない)。
  // **`.shell` に当たる規則を1つも足していない。**
  // **参照している `--space-4` は着手前から複数の規則に当たっているので (g) の13件も動かない。**
  //
  // **123 → 125(`V4-M15-T07` / `ADR-0089`。門A 限定採用)**。**増えたのは2件だけで、
  // どちらも `.shell` の余白に幅の条件を掛けた規則である**(実測: added 2 / removed 0):
  //   - `@media (min-width: 40rem) { .shell }`(1) …… `padding: var(--space-4)`
  //   - `@media (min-width: 64rem) { .shell }`(1) …… `padding: var(--space-6) var(--space-4)`
  //
  // **`@media` の内側の規則は、セレクタに条件を前置した三つ組として現れる**(上の `parseRules`)。
  // **`:root` に1スロットも足していない**((c) の 28 は動いていない)。
  // **既存の123件のうち、値が動いたのは `.shell` の `padding` 1件だけである**
  // (`var(--space-4)` → `var(--space-2)`。幅の条件を足したのでモバイル先行の値にした)。
  // **スロットの既定値は1件も動いていない** —— 角丸と影の既定値を変える案は
  // `src/mcp/vocabulary.ts` の段階表と結び付いており、`ADR-0087` 限定1(`src/` に
  // 1バイトも触らない)と両立しないので、同じタスクの中で着手前の値へ戻した。
  // **(g) は13件 → 12件になった** —— `--space-6` の当たり先が `.shell header` 1つから
  // 上の `@media` の分だけ増えたためで、**新しくスロットを作ったのではない。**
  //
  // **125 → 142(`V4-M16-T10` / `ADR-0090`。門A 限定採用)**。**増えたのは17件だけで、
  // すべて値の意味に応じた強調の当たり先である**(実測: added 17 / removed 0):
  //   - `.field-emphasis`(5) …… `display: inline-block` / `padding: 0 var(--space-2)` /
  //     `border-width` / `border-style` / `border-radius`(**色を1つも書いていない**)
  //   - `.field-emphasis[data-emphasis="neutral"]`(3) …… `color` / `background-color` /
  //     `border-color`
  //   - `.field-emphasis[data-emphasis="info"]`(3) …… 同上
  //   - `.field-emphasis[data-emphasis="caution"]`(3) …… 同上
  //   - `.field-emphasis[data-emphasis="danger"]`(3) …… 同上
  //
  // **属性値に入るのは意味の名前の有限 enum 4値の1要素だけである**(`ADR-0090` 限定3)——
  // **アプリ数・画面数・選択肢の数をいくつ増やしても規則は1つも増えない**(冒頭の許可 (iv)
  // と同型)。**`:root` に1スロットも足していない**((c) の 28 は動いていない)。
  // **既存の125件は1件も動いていない**(値もセレクタも1バイト変わっていない)。
  // **`@` を1文字も足していない**((i) の断点2本も動いていない)。
  // **(g) は12件 → 9件になった** —— `--color-surface-highlight` / `--control-border-radius` /
  // `--focus-outline-color` の当たり先が上の規則の分だけ増えたためで、**新しいスロットを
  // 作ったのではない**(理由は下の `SINGLE_TARGET_SLOTS` の注記)。
  //
  // **142 → 149(`V4-M16-T11` / `ADR-0091`。門A 限定採用)**。**増えたのは7件だけで、
  // すべて入力フォームに通した2軸の当たり先である**(実測: added 7 / removed 0):
  //   - `.record-form[data-preset-label="inline"] .field`(1) …… `flex-direction: row`
  //   - `.record-form[data-preset-label="stacked"] .field`(1) …… `flex-direction: column`
  //     (**これは今日の描画と同値である** —— `.field` は着手前から `flex flex-col` である)
  //   - `.record-form[data-preset-columns="1"] .form-fields`(2) …… `display: grid` /
  //     `grid-template-columns`
  //   - `.record-form[data-preset-columns="2"] .form-fields`(3) …… `display: grid` /
  //     `grid-template-columns` / `column-gap`
  //
  // **属性値に入るのは既存 enum の1要素だけである**(向き2値 / 段組数2値)—— **アプリ数・
  // 画面数・項目数をいくつ増やしても規則は1つも増えない**(冒頭の許可 (iv) と同型)。
  // **`:root` に1スロットも足していない**((c) の 28 は動いていない)。
  // **色を1宣言も足していない**(`ADR-0091` 限定4)—— `button, input, select, textarea` の
  // 3宣言は1バイトも動いていない。**必須印(`.record-form .required`)も1バイトも動いていない**(限定5)。
  // **既存の142件は1件も動いていない** = **プリセットを書いていない form は1ピクセルも
  // 変わらない**(`ADR-0091` 限定6。DOM の完全一致は
  // `web/test/form-view-presets.test.tsx` の (f) が固定する)。
  // **`@` を1文字も足していない**((i) の断点2本も動いていない)。
  // **(g) は9件のままである** —— 新しく参照したスロットは `--space-4` 1つで、着手前から
  // 複数の規則に当たっている(**新しいスロットを作っていない**)。
  //
  // **149 → 152(`V4-M16-T12` / `P-G17` の (C) 側 / `ADR-0092`。門A 限定採用)**。
  // **増えたのは3件だけで、すべて「まとまりの器」1規則の宣言である**(実測: added 3 / removed 0):
  //   - `.detail-field-group`(3) …… `display: flex` / `flex-direction: column` /
  //     `gap: var(--space-2)`
  //
  // **セレクタにアプリID・画面ID・フィールドID・まとまりの名前は1つも現れない** ——
  // **まとまりをいくつ書いても規則は1つも増えない**(冒頭の許可 (iii)「`web/src/` 自身が描く
  // UI 要素の『器』の宣言」)。
  // **`:root` に1スロットも足していない**((c) の 28 は動いていない)。
  // **色を1宣言も足していない**(`ADR-0092` 限定7)—— 参照したのは既存の `--space-2` だけで、
  // これは着手前から複数の規則に当たっている(**(g) の9件も動いていない**)。
  // **座標系9プロパティを1つも足していない**(限定7。`preset-boundary.test.ts` の (ii) と
  // `detail-field-grouping.test.tsx` の (g) が固定する)。
  // **既存の149件は1件も動いていない** = **まとまりを書いていない詳細画面は1ピクセルも
  // 変わらない**(`ADR-0092` 限定8。DOM の完全一致は
  // `web/test/detail-field-grouping.test.tsx` の (h) が着手前の DOM そのもので固定する)。
  // **`@` を1文字も足していない**((i) の断点2本も動いていない)。
  //
  // **152 → 167(`V4-M16-T13` / `P-G24` の (C) 側 / `ADR-0093`。門A 限定採用)**。
  // **増えたのは15件だけで、すべて一覧の器の形が `card` のときの当たり先である**
  // (実測: added 15 / removed 0):
  //   - `.list-cards`(4) …… `display: flex` / `flex-direction: column` /
  //     `gap: var(--space-2)` / `margin-top: var(--space-4)`
  //   - `.list-card`(6) …… `display: flex` / `flex-direction: column` /
  //     `gap: var(--space-1)` / `padding: var(--space-2) var(--space-3)` /
  //     `border: var(--border-width) var(--border-style) var(--color-border)` /
  //     `border-radius: var(--control-border-radius)`
  //   - `.list-card-field`(3) …… `display: flex` / `flex-wrap: wrap` / `gap: var(--space-2)`
  //   - `.list-card-label`(2) …… `color: var(--color-text-secondary)` /
  //     `font-size: var(--font-size-secondary)`
  //
  // **セレクタにアプリID・画面ID・フィールドID・属性値は1つも現れない** —— 器の選択は
  // `web/src/views/ListViewRenderer.tsx` の分岐(有限 enum 2値)であって CSS の属性
  // セレクタではないので、**アプリ数・画面数・列数をいくつ増やしても規則は1つも増えない**
  // (冒頭の許可 (iii)「`web/src/` 自身が描く UI 要素の『器』の宣言」)。
  // **`:root` に1スロットも足していない**((c) の 28 は動いていない)。
  // **色のリテラルを1バイトも書いていない**(使うのは25スロットの `var()` だけである)——
  // **クリックできるときのカーソルと地色は `.list-row-interactive` の既存規則が持つ**ので、
  // カードのために色の宣言を1つも新設していない。
  // **座標系9プロパティを1つも足していない**(`ADR-0093` 限定5。`preset-boundary.test.ts` の
  // (ii) と `list-view-shape.test.tsx` の (f) が固定する)。**カードを重ねて出していない。**
  // **既存の152件は1件も動いていない** = **`preset_list_shape` を書いていない一覧は
  // 1ピクセルも変わらない**(`ADR-0093` 限定4。DOM の完全一致は
  // `web/test/list-view-shape.test.tsx` の (d) が着手前の DOM そのもので固定する)。
  // **`@` を1文字も足していない**((i) の断点2本も動いていない)。
  // **(g) は9件のままである** —— 新しく参照したスロットはいずれも着手前から複数の規則に
  // 当たっている(**新しいスロットを1つも作っていない**)。
  expect(expected.length).toBe(167);
  expect(actual.length).toBe(167);

  expect(actual).toEqual(expected);
});

// ---------------------------------------------------------------------------
// (b) 色を表しうるリテラルが `:root` の外に無い
// ---------------------------------------------------------------------------

/**
 * CSS の名前付き色(148色)+ システム色。
 *
 * **プロパティ名ではなく値の側だけを見る。** `white-space: pre-wrap`(`styles.css:191`)の
 * `white` はプロパティ名の一部であって色ではない。値 `pre-wrap` は識別子として
 * `pre-wrap` 1つに切り出されるので、`white` とは一致しない。
 */
const NAMED_COLORS = new Set(
  `
  aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue
  blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk
  crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki
  darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen
  darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue
  dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite
  gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki
  lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
  lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen
  lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen
  magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen
  mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream
  mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid
  palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum
  powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown
  seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen
  steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow
  yellowgreen
  accentcolor accentcolortext activetext buttonborder buttonface buttontext canvas
  canvastext field fieldtext graytext highlight highlighttext linktext mark marktext
  selecteditem selecteditemtext visitedtext
  `
    .trim()
    .split(/\s+/),
);

const COLOR_FUNCTION_RE = /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\s*\(/i;
const HEX_RE = /#[0-9a-fA-F]{3,8}\b/;
const IDENTIFIER_RE = /[a-zA-Z][a-zA-Z0-9-]*/g;

/** 値の中に色を表しうるリテラルがあれば、その形の名前を返す。 */
function colorLiteralsIn(value: string): string[] {
  const found: string[] = [];
  if (HEX_RE.test(value)) found.push("16進");
  const fn = value.match(COLOR_FUNCTION_RE);
  if (fn !== null) found.push(`${fn[1]}()`);

  // `var(--slot)` の**スロット名**は値のリテラルではないので、識別子の走査から除く
  // (`--color-666` の `color` を色名と誤判定しないため)。フォールバック付きの
  // `var(--x, #fff)` はこの形に当たらないので、上の16進検査に残る。
  const withoutVarRefs = value.replace(VAR_REF_RE, " ");
  for (const match of withoutVarRefs.matchAll(IDENTIFIER_RE)) {
    const word = match[0].toLowerCase();
    if (word === "currentcolor") found.push("currentColor");
    // `transparent` を含める理由: T02 §2-1 の実測で現状**0件**であり、含めても
    // 今日の結果は変わらない(この検査は緑のまま)。一方 `transparent` は CSS の
    // 色の値そのものなので、除外すると「色を表しうるリテラル」に穴が1つ残り、
    // 後から `border-color: transparent` を `:root` の外に書いても赤にならない。
    // 実測0件 = 除外する動機が無い、ので**含める**側を採る。
    else if (word === "transparent") found.push("transparent");
    else if (NAMED_COLORS.has(word)) found.push(`名前付き色(${word})`);
  }
  return found;
}

test("(b) 色を表しうるリテラルが :root ブロックの外に1つも無い", () => {
  const offenders: string[] = [];
  for (const rule of nonRootRules) {
    for (const declaration of rule.declarations) {
      for (const kind of colorLiteralsIn(declaration.value)) {
        offenders.push(
          `${rule.selector} { ${declaration.property}: ${declaration.value} } → ${kind}`,
        );
      }
    }
  }
  expect(offenders).toEqual([]);

  // 検査が実際に値を読めていることの確認(`:root` の中には色が残っているはずである)。
  const rootColors = [...rootVariables(rules).values()].flatMap(colorLiteralsIn);
  expect(rootColors.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// (c) スロット集合の固定(`scripts/kernel-export-drift.test.ts` と同型の drift 検査)
// ---------------------------------------------------------------------------

test("(c) :root で定義された変数名の集合がスナップショットと一致する", () => {
  const actual = [...rootVariables(rules).keys()].sort();
  const expected = readSnapshotLines(SLOTS_PATH).sort();

  const added = actual.filter((name) => !expected.includes(name));
  const removed = expected.filter((name) => !actual.includes(name));

  // **赤くなったらスナップショットを更新する前に、増えたスロットが ADR-0007 の門A を
  // 通ったかを審査すること。** この検査が機械化したのは検出であって審査ではない
  // (`scripts/kernel-export-drift.test.ts` の作法をそのまま踏む)。
  // スロットを増やさないことは T04 が門外(Δ7)である根拠そのものなので、
  // 「赤くなったので更新した」で通すと門外性の根拠が消える。
  expect({ added, removed }).toEqual({ added: [], removed: [] });
  expect(expected.length).toBe(28);
});

// ---------------------------------------------------------------------------
// (d) スナップショットのスロットが全て参照されている
// ---------------------------------------------------------------------------

/** `:root` の外の宣言から参照されている変数名。 */
function referencedVariables(target: Rule[]): Set<string> {
  const names = new Set<string>();
  for (const rule of target) {
    for (const declaration of rule.declarations) {
      for (const match of declaration.value.matchAll(VAR_REF_RE)) {
        const name = match[1];
        if (name !== undefined) names.add(name);
      }
    }
  }
  return names;
}

test("(d) スナップショットに載っているスロットが全て1箇所以上で参照されている", () => {
  // 対象は「スナップショットに載っている変数」に限定してある(M0 は「将来 M1 が
  // 当たり所の無いスロットを足せるように」という理由でこう書いた)。**しかしこの緩和は
  // 空回りしている** —— (c) が `:root` の集合とスナップショットを added/removed 両方0で
  // 強制するので両集合は常に等しく、(d) は実質「`:root` の全変数が1箇所以上で
  // 参照されていること」である。**V3-M1-T01 はこれを緩めず、新設7軸のスロットを
  // すべて非 `:root` 規則から実際に参照する側で満たした**(当たり所の無いスロットを
  // AI に提示しないため。憲法6)。
  const declared = readSnapshotLines(SLOTS_PATH);
  const referenced = referencedVariables(nonRootRules);
  const unused = declared.filter((name) => !referenced.has(name));
  expect(unused).toEqual([]);
});

// ---------------------------------------------------------------------------
// (e) 未定義参照が無い
// ---------------------------------------------------------------------------

test("(e) 参照されている var(--…) が全て :root で定義されている", () => {
  const defined = rootVariables(rules);
  const referenced = [...referencedVariables(rules)].sort();
  const undefinedRefs = referenced.filter((name) => !defined.has(name));
  expect(undefinedRefs).toEqual([]);
  expect(referenced.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// (f) 冒頭の禁止コメントの逐語一致
// ---------------------------------------------------------------------------

/**
 * `web/src/styles.css` の冒頭コメント。**1バイトも変えてはならない。**
 *
 * ここは 01-design-baseline.md §6-3 が挙げた改訂対象(実測4箇所)のうちの1つである。
 * **V3-M1-T06 が改訂した**(`docs/plan/v3/records/v3-m1.md` の T06-5 / T06-13 と
 * `docs/adr/0049-appearance-declaration-revision.md`)—— 手順は「① `styles.css` の冒頭 →
 * ② `HEADER_COMMENT` → ③ `slice` の長さを配列から導出 → ④ テスト」であり、そのとおりに行った。
 * **V3-M0-T04 / V3-M1-T01〜T05 はどれも1バイトも触っていない。**
 *
 * **旧文言(2026-07-25 まで)は次の6行だった。** テーマ(`set_theme`)が入って
 * 「見た目のカスタマイズ機構ではない」が偽になったので改訂した。旧文言は ADR-0049 が全文を持つ。
 *
 * ```
 * /* 最小限の可読性のためのスタイル(V0-P3-T03)。
 *  *
 *  * 見た目のカスタマイズ機構ではない(handover 3.10)。テーマ切り替え、配色設定、
 *  * レイアウト指定などの「マニフェストに現れない表示オプション」をここに足さないこと。
 * ```
 *
 * **【2026-07-26。V3-M2-T05 / ADR-0052 で再改訂した】** V3-M2 で画面ごとのプリセット
 * (7軸19値)が入り、`data-preset-…` の属性セレクタ15規則・宣言21件が足された。
 * **ADR-0049 限定2 の「足してよいのは3つだけ」はその時点で偽になった**ので、
 * **4種目として明記した。** 旧文言(V3-M1-T06 版の14行)は ADR-0052 が全文を持つ。
 *
 * **禁止は全部外していない** —— 足してよいものを4つに限定し、アプリ固有のセレクタ・
 * 任意の CSS 規則・「マニフェストに現れない表示オプション」は引き続き禁じている
 * (これを外すと W-C の回避策 = アプリ数に比例した CSS 規則の累積が復活する)。
 * **「レイアウト指定」は禁止の例から外していない** —— **マニフェストに現れない**
 * レイアウト指定は今日も禁止であり、マニフェストに現れる7軸だけが例外である。
 * 追記も削除も禁止なので、期待文字列をここに埋め込んで固定する。
 */
const HEADER_COMMENT_LINES = [
  "/*",
  " * 最小限の可読性のためのスタイル(V0-P3-T03。V3-M1-T06 / ADR-0049 で改訂し、",
  " * V3-M2-T05 / ADR-0052 で再改訂し、V3-M4-T03 / ADR-0054 で5種目を足した)。",
  " *",
  " * **アプリごとの見た目をここに持たない。** それはマニフェストの app.theme(有限個の",
  " * スロットの実値)にあり、差し替えは差分操作 set_theme である(ADR-0046 / ADR-0047)。",
  " * **画面ごとの見せ方も同じで、マニフェストのビュー定義の preset_ で始まるキー",
  " * (有限 enum)にある**(ADR-0050 / ADR-0051)。",
  " *",
  " * **足してよいのは5つだけである。**(i) スロットの定義(:root)と、既存宣言からの",
  " * スロットの参照(var(--…))/(ii) アプリ単位テーマのスコープ要素の規則(.app-theme と、",
  " * 継承を開けるための inherit)/(iii) web/src/ 自身が描く UI 要素の「器」の宣言",
  " * (先例は .requirements-copy。.theme-export-copy / .theme-export-css も同型)/",
  " * (iv) 画面プリセットの有限 enum に1対1で対応する属性セレクタの規則 —— 属性値は",
  " * enum の1要素であり、規則の総数は各 enum の値の数の和で上から抑えられる",
  " * (アプリ数・画面数・列数をいくつ増やしても規則は1つも増えない)/",
  " * (v) 適用前の候補を同時に並べる器の規則(.theme-preview-list)—— 器の並べ方だけを",
  " * 書き、枠の中の見た目は1宣言も持たない(候補の実値は ThemePreviewPanel が",
  " * インラインスタイルで立てる)。候補を何種類に増やしても規則は1つも増えない。",
  " *",
  " * **引き続き禁じる**: アプリ固有のセレクタ、任意の CSS 規則、そして",
  " * 配色設定・切り替え機構や、マニフェストに現れないレイアウト指定のような",
  " * 「マニフェストに現れない表示オプション」。",
  " *",
  // **【2026-07-27。V3-M5-T05 / ADR-0055 で追記した】** V3-M5 で逃げ道(任意 CSS)が入り、
  // **「アプリごとの見た目をここに持たない ⇔ それはマニフェストにある」という上の説明が
  // 全量ではなくなった**(逃げ道の本体はマニフェストの外にある)。**足してよいものは5つの
  // ままである** —— **`web/src/styles.css` の差分は V3-M5 を通じて0行であり、6種目は生じて
  // いない**(V3-M5-T02 が実測)。**したがって禁止は1つも外していない。追記は射程の訂正だけ。**
  " * **【V3-M5-T05 / ADR-0055 で追記】逃げ道(任意 CSS)もここには無い。** V3-M5 で",
  " * owner 専用の逃げ道が入り、**画面に当たる見た目のうち、テーマでもプリセットでもない",
  " * ぶんが実在するようになった** —— 上の「アプリごとの見た目をここに持たない」の説明は、",
  " * それを数えていない。逃げ道の本体はマニフェストの外(owner 専用の content-addressed",
  " * ストア)にあり、当てるのは web/src/views/ViewHost.tsx が .app-theme の内側に立てる",
  " * <style> である。**このファイルには1規則も足していない**(V3-M5-T02 が",
  " * git diff = 0行 で担保した。ADR-0055 限定12)—— **したがって6種目は生じていない。**",
  " * **上の禁止は1つも外れていない。**",
  " */",
];
const HEADER_COMMENT = HEADER_COMMENT_LINES.join("\n");

test("(f) 冒頭の禁止コメントが期待文字列と逐語一致している", () => {
  // **行数をハードコードしない**(T06-5 の手順③)—— 期待配列の長さから導出する。
  // 以前は `slice(0, 6)` と書いてあり、冒頭コメントの行数を変えると期待側と切り出し側の
  // 両方を直す必要があった(片方だけ直すと、足りない行が黙って比較対象から外れる)。
  expect(css.split("\n").slice(0, HEADER_COMMENT_LINES.length).join("\n")).toBe(HEADER_COMMENT);
  expect(css.startsWith(`${HEADER_COMMENT}\n`)).toBe(true);
  // **禁止の主旨が残っていること**(T06-5: 「ここに足さないこと」の禁止を全部外さない)。
  expect(HEADER_COMMENT).toContain("引き続き禁じる");
  expect(HEADER_COMMENT).toContain("マニフェストに現れない表示オプション");
  // **足してよいものが5つに明示されていること**(V3-M1-T06-13 の3つに、V3-M2-T05 が
  // プリセットの属性セレクタを4種目として足し〔ADR-0052〕、V3-M4-T03 が候補を並べる器を
  // 5種目として足した〔ADR-0054〕)。
  expect(HEADER_COMMENT).toContain("足してよいのは5つだけである");
  for (const allowed of ["(i)", "(ii)", "(iii)", "(iv)", "(v)"]) {
    expect(HEADER_COMMENT).toContain(allowed);
  }
  // **4種目が「有限 enum に1対1で対応する属性セレクタ」に限定されていること**(逆向きの歯止め)
  // —— ここが緩むと「アプリごとの CSS 規則」が4種目の名の下に入ってくる。
  expect(HEADER_COMMENT).toContain("有限 enum に1対1で対応する属性セレクタ");
  expect(HEADER_COMMENT).toContain("アプリ数・画面数・列数をいくつ増やしても規則は1つも増えない");
  // **5種目が「器の並べ方だけ」に限定されていること**(逆向きの歯止め。ADR-0054 限定2)
  // —— ここが緩むと「枠の中の見た目を CSS 側で決める」経路が5種目の名の下に開く。
  expect(HEADER_COMMENT).toContain("器の並べ方だけを");
  expect(HEADER_COMMENT).toContain("枠の中の見た目は1宣言も持たない");
  expect(HEADER_COMMENT).toContain("候補を何種類に増やしても規則は1つも増えない");
  // **旧文言(全否定)が復活していないこと**(双方向の歯止め)。
  expect(css).not.toContain("見た目のカスタマイズ機構ではない");
  // **3つ・4つに戻っていないこと**(改訂の巻き戻しを止める)。
  expect(css).not.toContain("足してよいのは3つだけである");
  expect(css).not.toContain("足してよいのは4つだけである");
  // **【V3-M5-T05 / ADR-0055 限定12】6種目に増えていないこと。** 逃げ道は器の宣言を1つも
  // 要求しなかった(T02 が実測)ので、**「逃げ道の器」を名目に6種目が足されたら赤くする。**
  expect(css).not.toContain("足してよいのは6つだけである");
  // **逆向き**: 逃げ道がこのファイルに無いことの射程の訂正が消えていないこと。
  expect(HEADER_COMMENT).toContain("逃げ道(任意 CSS)もここには無い");
  expect(HEADER_COMMENT).toContain("6種目は生じていない");
});

// ---------------------------------------------------------------------------
// (g) 当たり先が1規則だけのスロットの明示列挙(V3-FIX-01)
// ---------------------------------------------------------------------------

/**
 * スロット名 → それを参照している `:root` 以外の**規則(セレクタ)**の集合。
 *
 * **数えるのは規則であって宣言ではない。** 同じ規則の中で2つのプロパティが同じスロットを
 * 読んでも(`.detail-field` の `gap` と `margin-bottom` が両方 `--space-2` を読む)、
 * 当たり先は1つである —— 当たる DOM 要素は同じだからである。
 */
function referenceSelectors(target: Rule[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const rule of target) {
    for (const declaration of rule.declarations) {
      for (const match of declaration.value.matchAll(VAR_REF_RE)) {
        const name = match[1];
        if (name === undefined) continue;
        const selectors = out.get(name) ?? new Set<string>();
        selectors.add(rule.selector);
        out.set(name, selectors);
      }
    }
  }
  return out;
}

/**
 * **当たり先が1規則だけのスロット(表を書いた時点で13件。今日は9件)。**
 *
 * **【V4-M15-T07 で12件、V4-M16-T10 で9件になった】** **下の表は13件のときのもので、
 * 外れた4件(`--space-6` / `--color-surface-highlight` / `--control-border-radius` /
 * `--focus-outline-color`)の理由は配列側の注記に1件ずつ書いてある。**
 * **表の行は消していない** —— **「1箇所だった時期がある」ことの記録だからである。**
 *
 * **これは「望ましい状態」の一覧ではなく「今日そうなっている状態」の一覧である。**
 * 各件に理由を書いてあるが、**その理由の妥当性を本検査は判定しない。**
 *
 * **V3-FIX-01 の射程は `--surface-shadow` だけである。** 下の13件が妥当かどうかは
 * 本タスクの射程外であり、**勝手に広げていない**(広げると「影を直す」タスクが
 * 画面全体の見た目を変える作業になる)。
 *
 * | スロット | 唯一の当たり先 | 1箇所である理由(判定は人間) |
 * |---|---|---|
 * | `--color-surface-highlight` | `.list-row-interactive:hover, …, .related-row-interactive:…` | 面の強調色を使う場所が「クリックで開ける行」だけである(**V3-M3-T02 が子一覧の行を同じ規則に足した。規則の数は1のまま**) |
 * | `--color-text-label` | `.detail-field dt` | 項目名(ラベル)を出す要素が詳細画面にしか無い |
 * | `--color-text-placeholder` | `.field-empty` | 「値が無い」の表示が1箇所しかない |
 * | `--control-border-radius` | `button, input, select, textarea` | **1規則で4要素に当たる。**角丸が見えるのはフォームコントロールだけである(`v3-m1-t01.md` §13-6) |
 * | `--detail-label-width` | `.detail-field dt` | 詳細画面の項目名の幅そのものである |
 * | `--focus-outline-color` | `:focus-visible` | **1規則で全要素に当たる**(フォーカスリングは1箇所で宣言する。`styles.css` の当該コメント) |
 * | `--focus-outline-style` | `:focus-visible` | 同上 |
 * | `--focus-outline-width` | `:focus-visible` | 同上 |
 * | `--font-size-note` | `.list-detail-target-note, .detail-target-note` | 注記の文字サイズを使う規則が1つしかない(**V3-M3-T02 が遷移点の増えたぶんのセレクタを同じ規則に足した**) |
 * | `--login-max-width` | `.login` | ログイン画面の最大幅そのものである |
 * | `--shell-max-width` | `.shell` | シェルの最大幅そのものである(**テーマ対象外**。V3-M3 / D-G6) |
 * | `--space-5` | `.requirement-sources` | 密度の第5段を使う宣言が1つしかない |
 * | `--space-6` | `.login` | 密度の第6段を使う宣言が1つしかない |
 *
 * **`--surface-shadow` はここに載っていない。** V3-FIX-01 が当たり先を5規則へ広げたためで、
 * **もし1規則へ戻ればこの検査が赤くなる**(それが本検査を置いた理由である)。
 */
const SINGLE_TARGET_SLOTS = [
  "--color-text-label",
  "--color-text-placeholder",
  "--detail-label-width",
  "--focus-outline-style",
  "--focus-outline-width",
  "--font-size-note",
  "--login-max-width",
  "--shell-max-width",
  "--space-5",
  // **【V4-M15-T07 で `--space-6` を外した。13件 → 12件】**
  // `--space-6` は着手前 `.shell header` の1規則にしか当たっていなかったが、
  // `@media (min-width: 64rem) { .shell }` が `padding: var(--space-6) var(--space-4)` で
  // 参照したので当たり先が2つになった。**新しいスロットを作ったのではない。**
  //
  // **【V4-M16-T10 / `ADR-0090` で3件外した。12件 → 9件】**
  // **3件とも「当たり先が広がった」側であり、「1箇所すら無くなった」側ではない**
  // (後者なら (d) が赤くなる)。**新しいスロットは1つも作っていない**((c) の 28 は不変)。
  //   - `--color-surface-highlight` …… 着手前は「クリックで開ける行」の1規則だけだった。
  //     `.field-emphasis[data-emphasis="neutral"]` と `…="caution"` の地色が参照したので
  //     当たり先が3つになった。
  //   - `--control-border-radius` …… 着手前は `button, input, select, textarea` の
  //     1規則だけだった。`.field-emphasis` の角丸が参照したので2つになった。
  //   - `--focus-outline-color` …… 着手前は `:focus-visible` の1規則だけだった。
  //     `.field-emphasis[data-emphasis="info"]` の枠線色が参照したので2つになった。
  //     **【正直に書く】フォーカスリングの色を「注意の度合いが低い情報」の枠線に
  //     流用している。** スロットの意味の名前(`--focus-outline-color`)と用途が
  //     一対一でなくなった、という代償が実在する。**強調のための色スロットを新設する
  //     ことは `ADR-0090` 限定5 が禁じている**(25スロットを1つも動かさない)ので、
  //     既存スロットからの導出になる。**この一致は `ADR-0046` §3a の門を通していない。**
];

test("(g) 当たり先が1規則だけのスロットが、明示列挙した9件と完全に一致する", () => {
  const bySlot = referenceSelectors(nonRootRules);
  const declared = readSnapshotLines(SLOTS_PATH);
  const actual = declared.filter((name) => (bySlot.get(name)?.size ?? 0) === 1).sort();
  const expected = [...SINGLE_TARGET_SLOTS].sort();

  // **赤くなったら列挙を書き換える前に、その状態が妥当かを判断すること。**
  // 増えた側は「当たり先が1箇所しか無いスロットを新しく作った」であり、V3-M1 が
  // `--surface-shadow` でやってしまったことの再発である(`docs/plan/v3/records/v3-fix-01.md`)。
  // 減った側は「当たり先を広げた」か「1箇所すら無くなった」のどちらかで、後者は (d) が赤くなる。
  const added = actual.filter((name) => !expected.includes(name));
  const removed = expected.filter((name) => !actual.includes(name));
  expect({ added, removed }).toEqual({ added: [], removed: [] });
  expect(actual).toEqual(expected);

  // 検査が実際に数えられていることの確認(全スロットが0件になって「一致」で緑になる壊れ方を防ぐ)。
  expect(bySlot.size).toBe(declared.length);
});

// ---------------------------------------------------------------------------
// (h) `--surface-shadow` の当たり先(V3-FIX-01)
// ---------------------------------------------------------------------------

/**
 * **影が「面の影」として意味を持つと判定した5規則。**
 *
 * 判定の条件3つ(すべて満たすものだけを面とした。理由の全量は
 * `docs/plan/v3/records/v3-fix-01.md`):
 *
 * 1. **マニフェストのビュー定義(3種)またはアプリのログイン画面が描く「主たる内容の
 *    かたまり」であること。** 影は面が地から浮くことを表すので、浮くべきはアプリの
 *    内容そのものが載っている塊である。
 * 2. **要素の箱が、その塊の見た目の輪郭と一致すること。** 箱が塊より大きい要素
 *    (`.list-view` / `.detail-view` / `.related-list`)に当てると、影は内容の縁ではない
 *    場所に落ちる。
 * 3. **`.app-theme` の内側にあること。** 外側(`.shell` / `.shell header`)にはテーマの値が
 *    届かないので、当てても「値を埋めても変わらない当たり先」が増えるだけである(憲法6)。
 *
 * **全要素には当てない。** 影が意味を持たない要素に当てると、利用者が影を指定したときに
 * 画面が壊れる(行ごと・項目ごとに影が落ちる、地に影が落ちる、など)。
 */
const SURFACE_SHADOW_TARGETS = [
  ".list-table", // list_view の主たるかたまり(レコードの表)
  ".related-table", // detail_view の子一覧のかたまり(`.list-table` と同種の物)
  ".detail-fields", // detail_view の項目のかたまり(V3-M2-T06 の R39 が名指しした対象)
  ".record-form", // form の入力欄のかたまり
  ".login", // ログイン画面のカード(**V3-M1-T01 が置いた唯一の当たり先**)
];

test("(h) --surface-shadow の当たり先が、面と判定した5規則と完全に一致する", () => {
  const bySlot = referenceSelectors(nonRootRules);
  const actual = [...(bySlot.get("--surface-shadow") ?? [])].sort();
  const expected = [...SURFACE_SHADOW_TARGETS].sort();

  // **減ったら赤**(V3-M1 が残した「`.login` にしか当たらない」状態への逆戻り)。
  // **増えても赤**(面かどうかの判定を通さずに広げるのを止める。ADR-0049 限定2' の
  // 「アプリ固有のセレクタ・任意の CSS 規則を書かない」を字面の側から支える)。
  expect(actual).toEqual(expected);

  // 当たり先のセレクタに**アプリID・画面ID・フィールドID が1つも現れない**こと
  // (ADR-0050 §2 (b) / ADR-0052 限定2' と同じ性質。規則の総数はアプリ数に比例しない)。
  for (const selector of SURFACE_SHADOW_TARGETS) {
    expect(selector).not.toContain("data-app-id");
    expect(selector).not.toContain("data-view-id");
    expect(selector).not.toContain("data-field-id");
  }
});

// ---------------------------------------------------------------------------
// (i) 通す at-rule の列挙(V4-M15-T07。ADR-0089 限定1 / 限定2 / 限定3)
// ---------------------------------------------------------------------------

/**
 * **着手前は「`@` が1文字でもあれば例外」だった。** 着手後は
 * **「`@media` の幅の条件だけを通し、列挙の外は今日どおり例外」** である。
 *
 * **【禁止】これを「`ADR-0046` 限定5 を1バイトも緩めていない」と書かない。緩めている。**
 * **緩めたのは `@media` の幅の条件の分だけであり、`prefers-color-scheme` と
 * `[data-theme]` の部分は1バイトも動かしていない**(その2本は
 * `web/test/preset-boundary.test.ts:173` / `:174` と `style-sources.test.ts` (集合7) が持つ)。
 */
test("(i) @media 以外の at-rule は今日どおり例外を投げる", () => {
  for (const at of [
    "@import url('x.css');",
    '@charset "utf-8";',
    "@supports (display: grid) { .a { color: red; } }",
    "@container (min-width: 10rem) { .a { color: red; } }",
    "@scope (.a) { .b { color: red; } }",
    "@layer base { .a { color: red; } }",
    "@property --x { syntax: '*'; inherits: false; }",
    "@keyframes spin { from { rotate: 0deg; } }",
    "@font-face { font-family: x; }",
  ]) {
    expect(() => parseRules(at), at).toThrow();
  }
});

test("(i) @media のうち幅以外のメディア特性は例外を投げる", () => {
  for (const condition of [
    "(prefers-color-scheme: dark)",
    "(prefers-reduced-motion: reduce)",
    "(prefers-contrast: more)",
    "(orientation: landscape)",
    "print",
    "screen and (min-width: 40rem)",
    "(hover: hover)",
    "(pointer: fine)",
    "not all and (min-width: 40rem)",
    "only screen",
    "(width >= 40rem)",
  ]) {
    expect(() => parseRules(`@media ${condition} { .a { color: red; } }`), condition).toThrow();
  }
});

test("(i) @media の幅の条件は通り、内側の規則が三つ組に現れる", () => {
  const parsed = parseRules("@media (min-width: 40rem) { .a { color: red; } }");
  expect(parsed).toEqual([
    {
      selector: "@media (min-width: 40rem) { .a }",
      declarations: [{ property: "color", value: "red" }],
    },
  ]);
});

test("(i) @media の入れ子は例外を投げる", () => {
  expect(() =>
    parseRules("@media (min-width: 40rem) { @media (max-width: 64rem) { .a { color: red; } } }"),
  ).toThrow();
});

/**
 * **断点の本数を有限に固定する**(`ADR-0089` 限定3)。
 *
 * **AI も owner も断点を1つも指定できない** —— 語彙に置き場が無い
 * (`schemas/manifest.schema.json` に1バイトも触っていない)。
 * **アプリごと・画面ごとに断点を増やせない** —— 増やすには本ファイルの数を書き換える
 * ことになり、差分に必ず出る。
 */
test("(i) 手で書く側の断点が、宣言した本数と完全一致する", () => {
  const conditions = mediaConditionsOf(css);
  const widths = [...new Set(conditions.map((c) => c.replace(/\s+/g, "")))].sort();
  // **本数の実数はここに書く。書き換えるときは、増えた分が何かを差分で説明すること。**
  expect(widths).toEqual(["(min-width:40rem)", "(min-width:64rem)"]);
  expect(widths.length).toBe(2);
});
