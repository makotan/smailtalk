/**
 * 越えてはならない線の機械検査(V3-M4-T03。指定経路 = D-G7 / D-G8)。
 *
 * 完了条件の正は `docs/plan/v3/records/v3-m4.md` §2 の「V3-M4-T03」節の5、
 * 判定の正は `docs/adr/0007-vocabulary-governance.md` §8 の 2026-07-26 の D-G7 / D-G8 の行と
 * 審査記録 `docs/plan/v3/records/v3-m4-gate-a-intake.md` §3 / §4、
 * 改訂の出所は `docs/adr/0054-intake-declaration-revision.md`。
 * 書式の先例は `web/test/preset-boundary.test.ts`(V3-M2-T05)/
 * `web/test/shell-navigation-boundary.test.ts`(V3-M3-T06)。
 *
 * ## この検査群が守るもの(**V3-M4 が「越えない」と宣言したもの**)
 *
 * | # | 検査 | 守るもの |
 * |---|---|---|
 * | (a) | 候補集合が **`web/src/theme-candidates.ts` 1本に閉じ**、候補ID がカーネル・スキーマ・MCP 説明文層に**1件も現れない** | **ユーザ決定 D-M4-2(組み込み固定候補)。****AI が候補集合を増やせない**(候補は AI から見えない) |
 * | (b) | **URL 空間**(`src/shared/route.ts` の `Route` の種別)と **`get_preview_url` の引数**が増えていない | **門A の再審査条件 (b)(c)**(審査記録 §3 S6)。候補を URL に載せた時点で、`src/shared/route.ts` 冒頭の「URL 空間はアプリの内容に依存しない」の射程が変わる |
 * | (c) | 統制語彙の表の識別子(段ID・形容詞)が **`src/kernel/` と `web/src/` に1件も現れない** | **憲法1。****表は MCP の説明文層だけに在り、カーネルは1度も読まない**(V3-M4-T00 の問1 の結論) |
 * | (d) | 利用者向け文書が候補数と「プレビュー URL では見比べられない」ことを述べている | **憲法6**(T01 完了条件5 の残り。T01 は本記録の中だけに書いて文書に書けなかった) |
 *
 * ## 既に別の場所で担保されているもの(**ここに二重化しない**)
 *
 * **検査の二重化は維持費である。** 次の3群は既存の検査が持っているので、本ファイルは持たない:
 *
 * 1. **候補集合の有限性そのもの**(凍結・件数・25スロットとの一致・`pattern` 適合・
 *    コントラスト検査の通過)= **`web/test/theme-candidates.test.ts`**(V3-M4-T01)。
 * 2. **`schemas/manifest.schema.json` にキーが増えていないこと** =
 *    **`web/test/shell-navigation-boundary.test.ts` の (a)**(V3-M3-T06)。同検査は
 *    **`$defs` の名前の全量**と **`properties` を持つ全 `$defs` のキー集合**(`app` の7キー・
 *    `theme` の25スロットを含む)を凍結しているので、**指定経路用のキーをどの名前でどこに足しても
 *    赤くなる。** 本ファイルで同じことを書くと、同じ事実の基準表が2つになる。
 * 3. **統制語彙の表が正準スキーマの語彙になっていないこと**(形容詞・段ID が
 *    `manifest.schema.json` / `diff.schema.json` の字面に0件)= **`src/mcp/vocabulary.test.ts`**
 *    (V3-M4-T02)。本ファイルが見るのは**その検査が見ていない2つの層**(`src/kernel/` と `web/src/`)である。
 *
 * ## 拒否リストを作っていない(ADR-0013 限定13)
 *
 * **「書いてはいけない名前の一覧」を1つも持たない。** (a)(c) は**実在するものの全量**
 * (`THEME_CANDIDATES` の候補ID / `DESIGN_ADJECTIVE_AXES` の段ID / `DESIGN_ADJECTIVE_PHRASES` の
 * 形容詞)を**実物から回して**、それが越えてはならない層に現れないことを見る —— **候補や段を
 * 増やせば検査の対象も自動で増える。**(b)(d) は**既知の集合との一致**を見る —— 種別を
 * `theme` と名付けても `candidate` と名付けても、**名前が何であれ**不一致として赤くなる。
 * **件数だけを数えないのは、「1つ足して1つ消す」が素通りするからである。**
 *
 * ## 限界(先に書く。憲法6)
 *
 * 1. **(a) は「候補が AI から見えない」ことを、字面の不在で言っているにすぎない。**
 *    候補の値(色の実値)は `web/src/` に在り、**同じ実値を AI が偶然書くことは止められない。**
 *    止めているのは「候補集合という第2の語彙が AI 側の層に生えること」だけである。
 * 2. **(b) はソーステキストの正規表現であって型検査ではない。** `Route` の種別を別の型に
 *    切り出す・`get_preview_url` の引数を別オブジェクトに畳む、といった経路は捕まえられない。
 * 3. **(c) は識別子の不在しか見ない。** 同じ対応関係を**別の名前で**カーネルに書き直されたら
 *    気づかない(それは拒否リストでも捕まらない種類の穴である)。
 * 4. **(d) は字面の一致であって、文が正しいことの証明ではない**(ADR-0049 限界3 と同じ)。
 * 5. **本ファイルは描画を1つも見ていない。** 「並べて見比べられる」ことの実証は
 *    `web/e2e/theme-preview.e2e.ts`(chromium)にある。
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DESIGN_ADJECTIVE_AXES, DESIGN_ADJECTIVE_PHRASES } from "../../src/mcp/vocabulary.ts";
import { THEME_CANDIDATES } from "../src/theme-candidates.ts";

const WEB_ROOT = dirname(import.meta.dir);
/**
 * 移した公開単位の根(`apps/smailtalk/`)。`src` / `web` / `schemas` はこの下に在る。
 * **`import.meta.dir` から数える**(cwd 相対だと `bun test` を打つ場所で結果が変わる)。
 */
const PRODUCT_ROOT = dirname(WEB_ROOT);

function read(...parts: string[]): string {
  return readFileSync(join(PRODUCT_ROOT, ...parts), "utf-8");
}

/** 拡張子を問わず再帰的に集める(**走査対象を名前で選り好みしない**)。 */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    out.push(full);
  }
  return out;
}

function textsUnder(...parts: string[]): { path: string; text: string }[] {
  return walk(join(PRODUCT_ROOT, ...parts)).map((path) => ({
    path,
    text: readFileSync(path, "utf-8"),
  }));
}

// ---------------------------------------------------------------------------
// (a) 候補集合が有限で列挙でき、AI が増やせない(ユーザ決定 D-M4-2)
// ---------------------------------------------------------------------------

test("(a) 候補集合の定義は web/src/theme-candidates.ts の1本だけである(第2の候補表を作れない)", () => {
  const defining = textsUnder("web", "src").filter(({ text }) =>
    /export\s+const\s+THEME_CANDIDATES\b/.test(text),
  );
  expect(defining.map(({ path }) => path.slice(PRODUCT_ROOT.length + 1))).toEqual([
    "web/src/theme-candidates.ts",
  ]);
});

test("(a) 候補IDがカーネル・正準スキーマ・MCP 説明文層に1件も現れない(AI から見えない)", () => {
  // **実在する候補の全量を実物から回す。** 候補を増やせば、検査する語も自動で増える。
  const ids = THEME_CANDIDATES.map((candidate) => candidate.id);
  expect(ids.length).toBeGreaterThan(0);

  const layers = [
    ...textsUnder("src", "kernel"),
    ...textsUnder("src", "mcp"),
    { path: "schemas/manifest.schema.json", text: read("schemas", "manifest.schema.json") },
    { path: "schemas/diff.schema.json", text: read("schemas", "diff.schema.json") },
  ];
  for (const id of ids) {
    for (const { path, text } of layers) {
      expect(text.includes(id), `${path} に候補ID ${id} が現れている`).toBe(false);
    }
  }
});

// ---------------------------------------------------------------------------
// (b) URL 空間と get_preview_url の引数が増えていない(門A の再審査条件 (b)(c))
// ---------------------------------------------------------------------------

/** `export type Route = ...;` の中の `kind: "…"` の全量。 */
function routeKinds(): string[] {
  const source = read("src", "shared", "route.ts");
  const start = source.indexOf("export type Route =");
  expect(start, "route.ts に `export type Route =` が無い").toBeGreaterThan(-1);
  // **宣言の終わりは空行で見る。** 型リテラルの中でも `;` が区切りに使われるので、
  // 最初の `;` で切ると `Route` の途中で切れてしまう。
  const body = source.slice(start, source.indexOf("\n\n", start));
  return [...body.matchAll(/kind:\s*"([^"]+)"/g)].map((match) => match[1] as string).sort();
}

test("(b) URL 空間の種別が4つのままで、候補・プレビューの状態が載っていない", () => {
  expect(routeKinds()).toEqual(["app", "app-list", "not-found", "view"]);
  // **冒頭の宣言そのものが消えていないこと**(なぜ載せないのかの理由が残る)。
  expect(read("src", "shared", "route.ts")).toContain("アプリの内容に依存しない");
});

test("(b) get_preview_url の引数が app_id / view_id の2つのままである(テーマを指す引数が無い)", () => {
  const source = read("src", "mcp", "tools", "read.ts");
  const toolAt = source.indexOf('"get_preview_url"');
  expect(toolAt, "read.ts に get_preview_url が無い").toBeGreaterThan(-1);
  const schemaAt = source.indexOf("inputSchema: {", toolAt);
  const end = source.indexOf("\n      },", schemaAt);
  const block = source.slice(schemaAt, end);
  const keys = [...block.matchAll(/^ {8}(\w+):/gm)].map((match) => match[1] as string).sort();
  expect(keys).toEqual(["app_id", "view_id"]);
});

// ---------------------------------------------------------------------------
// (c) 統制語彙の表がマニフェストの語彙にも表示層にもなっていない(憲法1)
// ---------------------------------------------------------------------------

test("(c) 表の段ID・形容詞が src/kernel/ と web/src/ に1件も現れない(カーネルは表を読まない)", () => {
  const words = [
    ...DESIGN_ADJECTIVE_AXES.flatMap((axis) => axis.levels.map((level) => level.id)),
    ...DESIGN_ADJECTIVE_PHRASES.map((phrase) => phrase.phrase),
  ];
  expect(words.length).toBeGreaterThan(0);

  const layers = [...textsUnder("src", "kernel"), ...textsUnder("web", "src")];
  for (const word of words) {
    for (const { path, text } of layers) {
      expect(text.includes(word), `${path} に表の語 ${word} が現れている`).toBe(false);
    }
  }
});

// ---------------------------------------------------------------------------
// (d) 利用者向け文書が、今日できること / できないことを述べている(憲法6)
//
// **【`X-G28` / `V9-M11-T02` / `D-V9-21` で移した】** (d) の2本は `docs/manual.md` /
// `docs/mcp-quickstart.md` を fs で読むため、公開単位(`apps/smailtalk/`)の外を読む検査に
// なっていた。**`tools/docs/intake-boundary-docs.test.ts` へ切り出した**(この2本だけ。
// (a)〜(c) はここに残る)。`USER_DOCS` 定数もそちらへ移した。
// ---------------------------------------------------------------------------
