/**
 * `package.json` の依存集合を凍結する検査(`V4-M15-T09` (1)。要求は `P-G40` / `ADR-0087` 限定5)。
 *
 * ## なぜ在るのか
 *
 * `ADR-0087` §Context 7 の逐語: **「chart(recharts)を連れてくる経路が `F-7'` の保留を
 * 門外で素通りさせうる」**(`ADR-0007:261` の警告の例そのもの)。部品体系を1つ入れると、
 * **人が1行も書かないまま依存が増える。** `ADR-0087` 限定5 の第4列は、その固定先を
 * **本検査に名指しで指定している**:
 *
 * > **依存集合を凍結する検査**(`V4-M15-T09` が新設。**今日は0件である**)で
 * > 名指しの禁止リストとして固定する
 *
 * ## これは「検出」であって「審査」ではない(`ADR-0007:124`)
 *
 * 骨格は `scripts/kernel-export-drift.test.ts`(Δ8 の機械検査)と同型である。
 * あちらが `src/kernel/` の公開エクスポート識別子を凍結したのと同じ作法で、
 * ここでは **`dependencies` と `devDependencies` を名前と版の対で凍結し、
 * 増えた依存・減った依存・版が動いた依存を名指しで赤にする。**
 *
 * **【赤くなったら、凍結表を更新する前に、増えた依存が `ADR-0007` の門を通ったかを
 * 審査すること。】** この検査が機械化したのは**検出**であって**審査ではない。**
 * (`web/test/__fixtures__/styles-token-slots.txt` 冒頭と同じ注意書きである。)
 *
 * とくに **禁止リストの8本(`chart` / `recharts` / `d3` / `victory` / `nivo` /
 * `chart.js` / `apexcharts` / `plotly.js`)が赤くなった場合、凍結表の更新では通らない。**
 * `ADR-0087` 限定5 は「`F-7'` の保留を1ミリも動かさない」であり、
 * **`ADR-0087` §総括3 が「本 ADR は権限を持たない」と明記している。**
 *
 * ## 基準を「件数」にしない(`kernel-export-drift.test.ts` §基準 と同じ判断)
 *
 * 件数は「1本消して1本足す」を素通りさせる。したがって基準は**名前の集合**であり、
 * 件数の検査は「検査が実際に読めていること」の確認にしか使わない。
 *
 * ## 推移的依存も見る(直接依存だけでは足りない)
 *
 * **直接依存だけを見ると、部品体系が描画ライブラリを連れてきた場合に素通りする。**
 * `recharts` は `victory-vendor` と `d3-*` を、`@nivo/*` は `d3-*` を連れてくる。
 * そこで禁止リストは **`bun.lock` に載る全パッケージ名(2026-08-03 実測で 252 名)**
 * に対しても当てる。同族(`d3-` / `victory-` / `@nivo/` / `@d3/` で始まる名前)も落とす。
 *
 * ## この検査の限界(先に書く。憲法6)
 *
 * 1. **凍結表の更新は人間が行う。** 「赤くなったので更新した」だけで通せる。
 *    これは `kernel-export-drift.test.ts` 限界1 / `write-tools-drift.test.ts` に既にある穴で
 *    あり、本検査が新しく作る穴ではない。塞ぐ手段は無い(`ADR-0007` §限界9)。
 * 2. **禁止リストは名指しの8本と4つの同族接頭辞だけである。** 名前で名乗らない描画
 *    ライブラリ(例: 独自名の canvas 描画パッケージ)は**1本も落とせない。**
 *    **「描画ライブラリが入っていないこと」を証明する検査ではない** ——
 *    **「名指しした8本と同族が入っていないこと」しか言えない。**
 * 3. **`bun.lock` の走査は行の形に依存している**(`"<キー>": ["<名前>@<版>", ...]`)。
 *    lockfile の書式が変わると読み落としうるので、**読めた総数が下限を割ったら赤にする**
 *    自己検査を併せて置いている(`kernel-types-no-import.test.ts` と同じ手口)。
 * 4. **版の凍結は `package.json` の文字列そのものである。** `^2.3.14` のような範囲指定は
 *    **範囲のまま凍結される** —— **範囲の中で実際に解決された版が動いたことは、この検査に
 *    1件も出ない**(それは `bun.lock` の差分に出る)。
 * 5. **検出するのは「増えたこと」だけで、「門を通ったか」は判定しない。**
 *
 * ## 【2026-08-15 追記】例外表を持った(`V8-M12-T01`)
 *
 * **上の本文を1バイトも書き換えていない。ただし次の2点は今日は不正確である。**
 *
 * - 限界2 の「同族接頭辞は4つ」は今日 **6つ**である(`d3-` / `victory-` / `@nivo/` / `@d3/` /
 *   `chart.js/` / **`@types/d3-`**)。**`@types/d3-` は本タスクが足した** ——
 *   `"@types/d3-scale".startsWith("d3-")` は `false` なので、**型だけの `@types/d3-*` は
 *   今日まで禁止リストを素通りしていた**(`V8-M12` が実測で見つけた既存の穴であって、
 *   `Q-G24` が要求したものではない)。
 * - 冒頭の「禁止リストの8本が赤くなった場合、凍結表の更新では通らない」は、
 *   **`@nivo/bar` / `@nivo/line` とその推移依存34本に限って、門A の判定によって解かれた**
 *   (`Q-G24` = 限定採用。`ADR-0087` 限定5 の引き直し)。**解いたのは検査ではなく門A である。**
 *   例外表 `CHART_LIBRARY_ALLOWLIST` は**その判定の写し**であって、判定そのものではない。
 * - **例外表は接頭辞ではなく34本の完全な名指しである。** 接頭辞(`@nivo/` / `d3-`)の例外に
 *   すると、**`recharts` が連れてくる `d3-*` まで素通りする** —— 「1本入れたら次も通る」形になる。
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 移した公開単位の根(`apps/smailtalk/`)。**依存の宣言(`package.json`)はここに在る** ——
 * 正本のルートにも `package.json` は在るが、そちらは workspaces の器で依存を1本も持たない。
 * **`import.meta.dir` から数える**(cwd 相対だと `bun test` を打つ場所で結果が変わる)。
 */
const PRODUCT_ROOT = join(import.meta.dir, "..", "..");
/**
 * 【V9-M11-T01 / `X-G25`】**`bun.lock` は公開単位の根(`PRODUCT_ROOT`)に在る。**
 * 公開単位だけを切り出した木で `bun install` を打っても依存の版が固定されるように、
 * 公開単位が自分の lockfile を持つようにした。
 * **この検査は正本のルートの `bun.lock` を1バイトも読まない。**
 * 正本のルートにも `bun.lock` は今日まだ在るが、それを消すのは `X-G31`(`V9-M12-T01`)の射程である。
 */
const PACKAGE_JSON_PATH = join(PRODUCT_ROOT, "package.json");
const LOCKFILE_PATH = join(PRODUCT_ROOT, "bun.lock");

// ============================================================================
// 凍結表 —— **更新する前に門を通ったかを審査すること**(上の注意書き)
// ============================================================================
//
// 2026-08-03 実測。`V4-M15` 着手前(`git merge-base main work/v4-m15` = `303e4d1`)は
// `dependencies` 10本 / `devDependencies` 12本であった。
// **`docs/plan/v4/records/v4-m15.md` `T09` の起票文が書いた「devDependencies 13本 → 14本」は
// 今日の実測と食い違う。実測は 12本 → 13本である**(`V4-M15-T09` の完了条件により実測を採る)。
//
// 着手後に増えた6本(`dependencies`):
//   tailwindcss / class-variance-authority / clsx / tailwind-merge /
//   @base-ui-components/react / lucide-react
// 着手後に増えた1本(`devDependencies`): @tailwindcss/vite
// **減った依存は0本である。**
//
// 2026-08-08 更新(依存の版上げ)。**名前は1本も増えず、1本も減っていない**(16本 / 13本のまま)ので
// `ADR-0007` の門にかかる追加は0件である。動いたのは版の文字列だけである:
//   dependencies    … @modelcontextprotocol/sdk ^1.29.0→^1.30.0 / hono 4.12.30→4.13.1 /
//                     lucide-react 1.28.0→1.30.0 / react 19.2.7→19.2.8 / react-dom 19.2.7→19.2.8
//   devDependencies … @biomejs/biome ^2.3.14→^2.5.7 / @happy-dom/global-registrator 20.10.6→20.11.2 /
//                     @playwright/test 1.61.1→1.62.1 / @types/react 19→^19.2.18 /
//                     @types/react-dom 19→^19.2.4 / @vitejs/plugin-react 6.0.3→6.0.5 /
//                     happy-dom 20.10.6→20.11.2 / vite 8.1.5→8.2.1
// **【2026-08-08 追記】その据え置きは同日ユーザの指示で解いた。** `typescript ^5.9.3→^7.0.2`。
// 名前は増えも減りもしていない(16本 / 13本のまま)ので、この版上げも `ADR-0007` の門にはかからない。
// **7 系は中身が Go による別実装に置き換わった系列である**(`tsc` の名前と CLI は同じ)。
// 実測で赤くなったのは `web/src/main.tsx` の CSS への副作用 import 2本だけで(`TS2882`。
// **5.9 は型宣言の無いファイルへの副作用 import を黙って通していた**)、`tsconfig.json` の
// `types` に `vite/client`(`declare module '*.css' {}` を配る)を足して解いた。**型注釈は1バイトも書き換えていない。**
// `@types/react` / `@types/react-dom` の主要版のみの指定(`"19"`)が範囲指定に変わったのは
// `bun update` の書き換えであって、解決される版は変わっていない。
//
// 2026-08-15 更新(`V8-M12-T01`。**名前が増えた**)。**上の記録を1バイトも書き換えていない。**
//   いつ  … 2026-08-15。`V8-M12`(v8 軸2。集計表にグラフを描く)の `T01`。
//   何を … `devDependencies` に **`@nivo/bar` `0.99.0`** と **`@nivo/line` `0.99.0`** の2本。
//          **13本 → 15本**(`dependencies` は 16本のまま。**1本も減っていない**)。
//          推移的依存は `bun.lock` のパッケージ名で **271 → 317**(**+46 / 減 0**)。
//          そのうち**禁止リストに当たるのは34本**で、例外表 `CHART_LIBRARY_ALLOWLIST` に
//          全件を名指しした(内訳 = `@nivo/*` 13 / `d3-*` 11 / `@types/d3-*` 10)。
//   なぜ … `Q-G23`(集計の数字を棒グラフと折れ線グラフで見たい)/ `Q-G24`(描画ライブラリを入れる)が
//          **門A で限定採用**になったため(判定の正は `docs/plan/v8/records/v8-m7.md` と
//          `ADR-0007` §8 の台帳。**本ファイルは判定を1つも下していない**)。
//          描画ライブラリの選定は `D-V8-117`(ユーザ決定)で `@nivo/bar` + `@nivo/line` に固定されている。
//   **誰がどう追従するか**(`Q-G25` = 供給元の更新への追従責任。**却下 = 既存機構で満たす**の実体):
//     1. **追従の口はこの凍結表2つ(`FROZEN_DEPENDENCIES` / `FROZEN_DEV_DEPENDENCIES`)である。**
//        `@nivo` 側が版を上げても、`package.json` の版の文字列が動かない限り本検査は1件も赤くならない
//        (限界4 の逐語「範囲の中で実際に解決された版が動いたことは、この検査に1件も出ない」)。
//        **だから `@nivo` の2本は caret(`^0.99.0`)ではなく exact(`0.99.0`)で固定した** ——
//        caret のままだと `0.99.x` の中の移動が本検査に1件も出ず、**「追従の口」を作ったつもりで
//        実際には開いていない**ことになる(先例は `react: "19.2.8"` の側。`bun add` の既定は caret なので、
//        入れた後に手で落としてある)。
//     2. **版を上げるのは人間である。** `bun update` を打った人が、赤くなった版の文字列を
//        審査のうえでこの表に書き写す(2026-08-08 の2ブロックが実際にその形である)。
//        **名前が増減しない版上げは `ADR-0007` の門にかからない。**
//     3. **推移依存の顔ぶれが変わったとき**(`@nivo` が新しい `d3-*` を連れてきたときなど)は、
//        例外表に無い名前として**赤になる**。**そこで止まるのが本検査の役目である** ——
//        例外表を足す前に、増えた名前が門を通ったかを審査すること。
//     4. **本検査は脆弱性・保守終了・ライセンスを1件も見ていない。** 見ているのは名前と版の文字列だけである。
//     5. **【限界。名前ベースの数え方が畳むもの】名前ベースの数え方は、同名で2版入っているものを1件に畳む。**
//        **`bun` の「48 packages installed」と名前の +46 の差はこれである(今日は2組** ——
//        **`d3-time` が `1.1.0` と `3.1.0`、`@types/d3-time-format` が `2.3.4` と `3.0.4`)。**
//        **したがってこの検査は版の重複を1件も見つけられない。** 今日は畳まずそのまま残してある
//        (無理に畳むと `--frozen-lockfile` の再現性を壊す)。

/** `dependencies`(16本)。名前 → `package.json` に書かれた版の文字列。 */
const FROZEN_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@base-ui-components/react": "1.0.0-rc.0",
  "@modelcontextprotocol/sdk": "^1.30.0",
  "@simplewebauthn/browser": "^13.3.0",
  "@simplewebauthn/server": "^13.3.2",
  ajv: "^8.20.0",
  "ajv-formats": "^3.0.1",
  "class-variance-authority": "0.7.1",
  clsx: "2.1.1",
  hono: "4.13.1",
  "lucide-react": "1.30.0",
  "quickjs-emscripten": "^0.32.0",
  react: "19.2.8",
  "react-dom": "19.2.8",
  "tailwind-merge": "3.6.0",
  tailwindcss: "4.3.3",
  zod: "^4.4.3",
};

/**
 * `devDependencies`(13本)。
 *
 * **【2026-08-15 追記】15本になった**(`@nivo/bar` / `@nivo/line`。上の 2026-08-15 の記録ブロック)。
 * **「13本」の文字列は当時の実測なので消していない。今日の実数は15本である。**
 */
const FROZEN_DEV_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@biomejs/biome": "^2.5.7",
  "@happy-dom/global-registrator": "20.11.2",
  "@nivo/bar": "0.99.0",
  "@nivo/line": "0.99.0",
  "@playwright/test": "1.62.1",
  "@tailwindcss/vite": "4.3.3",
  "@testing-library/dom": "10.4.1",
  "@testing-library/react": "16.3.2",
  "@types/bun": "^1.3.14",
  "@types/react": "^19.2.18",
  "@types/react-dom": "^19.2.4",
  "@vitejs/plugin-react": "6.0.5",
  "happy-dom": "20.11.2",
  typescript: "^7.0.2",
  vite: "8.2.1",
};

/**
 * `ADR-0087` 限定5 が名指しした描画ライブラリ。
 *
 * **`dependencies` にも `devDependencies` にも、そして推移的依存にも1本も足せない。**
 * **赤くなったら凍結表の更新では通らない**(`ADR-0087` §総括3)。
 */
const FORBIDDEN_PACKAGES: readonly string[] = [
  "chart",
  "recharts",
  "d3",
  "victory",
  "nivo",
  "chart.js",
  "apexcharts",
  "plotly.js",
];

/**
 * 同族の接頭辞。**上の8本は分割された小さなパッケージとして入ってくる** ——
 * `recharts` は `victory-vendor` と `d3-scale` / `d3-shape` を、`@nivo/*` は `d3-*` を連れてくる。
 * 名指しの8本だけでは、その形の混入を1件も落とせない。
 *
 * **【2026-08-15 追記】`@types/d3-` を足した**(`V8-M12-T01`。**1語も消していない**)。
 * `"@types/d3-scale".startsWith("d3-")` は `false` なので、**型定義だけの `@types/d3-*` は
 * 今日まで名指しの8本にも4つの接頭辞にも当たらず、素通りしていた。**
 * これは `V8-M12` が実測で見つけた**既存の穴**であって、`Q-G24` が要求したものではない。
 */
const FORBIDDEN_PREFIXES: readonly string[] = [
  "d3-",
  "victory-",
  "@nivo/",
  "@d3/",
  "chart.js/",
  "@types/d3-",
];

/** `bun.lock` から読めるべきパッケージ名の下限(2026-08-03 実測 252 名)。 */
const LOCKFILE_NAME_FLOOR = 200;

/**
 * 例外表 —— **禁止リストに当たるが、門A の判定によって在ってよい名前**(2026-08-15 実測 **34本**)。
 *
 * **これは「禁止リストの緩和」ではなく、判定の写しである。**
 * `Q-G24`(描画ライブラリを入れる)が**門A で限定採用**になり、触れてよいものが
 * **`@nivo/bar` / `@nivo/line` とその推移依存だけ**に限定された。その限定を機械で当てるための表である。
 *
 * ## なぜ接頭辞の例外にしないのか(**この形が要点である**)
 *
 * `@nivo/` や `d3-` を「例外の接頭辞」にすると、**`recharts` が連れてくる `d3-scale` /
 * `d3-shape` まで素通りする** —— **「1本入れたら次も通る」形になる。**
 * したがって**34本の完全な名指し**にしてある。**ここに無い名前は今日どおり赤になる。**
 *
 * ## 増やすときの作法
 *
 * **赤くなったから足す、をしない。** 増えた名前が `ADR-0007` の門を通ったかを先に審査すること
 * (本ファイル冒頭の注意書きと同じ。**この表も「検出」であって「審査」ではない**)。
 * **`@nivo/pie` / `@nivo/scatterplot` / `@nivo/heatmap` / `@nivo/calendar` を1本も足さず、
 * 3本目の描画ライブラリ(`recharts` / `chart.js` / `victory` ほか)を1本も足さない**
 * (`ADR-0007:1468` の限定。下の検査が機械で固定している)。
 *
 * 内訳: `@nivo/*` 13 / `d3-*` 11 / `@types/d3-*` 10。
 */
const CHART_LIBRARY_ALLOWLIST: readonly string[] = [
  // `@nivo/*`(13本。うち直接依存は `@nivo/bar` と `@nivo/line` の2本だけ)
  "@nivo/annotations",
  "@nivo/axes",
  "@nivo/bar",
  "@nivo/canvas",
  "@nivo/colors",
  "@nivo/core",
  "@nivo/legends",
  "@nivo/line",
  "@nivo/scales",
  "@nivo/text",
  "@nivo/theming",
  "@nivo/tooltip",
  "@nivo/voronoi",
  // `d3-*`(11本。**`d3` 本体は1本も入っていない** —— 入ってきたら赤になる)
  "d3-array",
  "d3-color",
  "d3-delaunay",
  "d3-format",
  "d3-interpolate",
  "d3-path",
  "d3-scale",
  "d3-scale-chromatic",
  "d3-shape",
  "d3-time",
  "d3-time-format",
  // `@types/d3-*`(10本。上で `FORBIDDEN_PREFIXES` に `@types/d3-` を足したので、
  // ここに名指ししない限り赤になる)
  "@types/d3-color",
  "@types/d3-delaunay",
  "@types/d3-format",
  "@types/d3-interpolate",
  "@types/d3-path",
  "@types/d3-scale",
  "@types/d3-scale-chromatic",
  "@types/d3-shape",
  "@types/d3-time",
  "@types/d3-time-format",
];

// ============================================================================
// 検出(純粋な部分)
// ============================================================================

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8")) as PackageJson;
}

/** 増えた名前と減った名前を**名指しで**返す。差分を目で探す作業を残さない。 */
export function diffNames(
  actual: Readonly<Record<string, string>>,
  frozen: Readonly<Record<string, string>>,
): { added: string[]; removed: string[] } {
  const actualNames = Object.keys(actual);
  const frozenNames = Object.keys(frozen);
  return {
    added: actualNames.filter((name) => !frozenNames.includes(name)).sort(),
    removed: frozenNames.filter((name) => !actualNames.includes(name)).sort(),
  };
}

/** 版が動いた依存を `名前: 凍結値 → 実際の値` の形で返す(名前の増減はここに出さない)。 */
export function diffVersions(
  actual: Readonly<Record<string, string>>,
  frozen: Readonly<Record<string, string>>,
): string[] {
  return Object.keys(actual)
    .filter((name) => frozen[name] !== undefined && frozen[name] !== actual[name])
    .sort()
    .map((name) => `${name}: ${frozen[name]} → ${actual[name]}`);
}

/**
 * `bun.lock` に載る全パッケージ名(推移的依存を含む)。
 *
 * bun の text lockfile は `"<キー>": ["<名前>@<版>", "", {...}, "<integrity>"]` の形で
 * 1パッケージ1行を持つ。キーは入れ子(`"vite/esbuild"`)になりうるので、
 * **キーではなく第1要素の解決済み識別子から名前を採る。**
 * 版に `@` を含む形(`@scope/name@1.0.0`)があるので、スコープ付きを先に食わせている。
 */
export function lockfilePackageNames(lockfileText: string): string[] {
  const entry = /^\s*"[^"]*":\s*\[\s*"((?:@[^@"/]+\/)?[^@"]+)@/gm;
  const names = new Set<string>();
  for (const match of lockfileText.matchAll(entry)) {
    const name = match[1];
    if (name !== undefined && name !== "") {
      names.add(name);
    }
  }
  return [...names].sort();
}

/** 禁止リスト(名指し8本 + 同族接頭辞)に当たった名前を全件返す。 */
export function forbiddenHits(names: readonly string[]): string[] {
  return names
    .filter(
      (name) =>
        FORBIDDEN_PACKAGES.includes(name) ||
        FORBIDDEN_PREFIXES.some((prefix) => name.startsWith(prefix)),
    )
    .sort();
}

/**
 * 禁止リストに当たった名前のうち、**例外表に載っていないもの**を全件返す(2026-08-15 新設)。
 *
 * **`forbiddenHits` は1バイトも変えていない** —— あちらは「禁止リストに当たったか」だけを見る
 * 素の検出器であり、`d3-scale` も `@nivo/core` も今日どおり当たる。
 * **例外表を当てるのはこちらだけである。**
 */
export function unapprovedHits(names: readonly string[]): string[] {
  return forbiddenHits(names).filter((name) => !CHART_LIBRARY_ALLOWLIST.includes(name));
}

// ============================================================================
// 検査
// ============================================================================

describe("依存集合の凍結(増えた依存を名指しで赤にする)", () => {
  test("`dependencies` の名前が凍結表と一致する", () => {
    const actual = readPackageJson().dependencies ?? {};
    // 赤くなったら、まず `added` が `ADR-0007` の門を通ったかを審査すること。
    // 凍結表の更新はその審査の**後**である。
    expect(diffNames(actual, FROZEN_DEPENDENCIES)).toEqual({ added: [], removed: [] });
  });

  test("`devDependencies` の名前が凍結表と一致する", () => {
    const actual = readPackageJson().devDependencies ?? {};
    expect(diffNames(actual, FROZEN_DEV_DEPENDENCIES)).toEqual({ added: [], removed: [] });
  });

  test("版の指定が凍結表と一致する(名前が同じまま版だけ動いた場合)", () => {
    const pkg = readPackageJson();
    expect({
      dependencies: diffVersions(pkg.dependencies ?? {}, FROZEN_DEPENDENCIES),
      devDependencies: diffVersions(pkg.devDependencies ?? {}, FROZEN_DEV_DEPENDENCIES),
    }).toEqual({ dependencies: [], devDependencies: [] });
  });
});

/**
 * **【2026-08-15。テスト名を2本改めた。`V8-M12-T01`。メインの裁定による】**
 *
 * この `describe` の中の2本は、**検査の中身そのものを `forbiddenHits` から `unapprovedHits`
 * (= 禁止リストに当たったもののうち、例外表34本に無いもの)に変えた。**
 * **名前が指す対象が変わったので、旧名を残すと「赤くならずにテスト名だけが嘘になる」形になる**
 * (このリポジトリで既に3度出た型。4度目にしない)。**そこで名前を中身に合わせた。**
 *
 * **改めた2本(旧 → 新。旧名は逐語で残す)**:
 *
 * 1. 旧(逐語): 直接依存(`dependencies` / `devDependencies`)に1本も無い
 *    新(逐語): 直接依存(`dependencies` / `devDependencies`)に、例外表の外側の描画ライブラリが1本も無い
 * 2. 旧(逐語): 推移的依存(`bun.lock`)にも1本も無い
 *    新(逐語): 推移的依存(`bun.lock`)にも、例外表の外側の描画ライブラリが1本も無い
 *
 * **なぜ**: 今日 `@nivo/bar` / `@nivo/line` とその推移依存34本が実際に入っている
 * (`Q-G24` = 門A で限定採用)。旧名の「1本も無い」は **2026-08-14 までの事実**であり、今日は偽である。
 * **改める前に `LC_ALL=C /usr/bin/grep -rnF` で `docs/` / `src/` / `scripts/` / `web/` /
 * `plugins/` / `schemas/` / `.github/` を全件走査し、この2本の名前を引いている他ファイルが
 * 0件であることを確かめた。**
 *
 * **【この `describe` の見出しは1バイトも書き換えていない】** ——
 * **`docs/plan/v8/02-report-aggregation-baseline.md:624` と `:901` が見出しを逐語で引用しており**、
 * 書き換えると引用の側が黙って嘘になるからである。**見出しの「1本も入れない」は今日は偽である**
 * (正しくは「**例外表の34本以外を1本も入れない**」)。**この食い違いは意図して残してある。**
 */
// **【2026-08-15。この `describe` の見出しを書き換えないことの理由。メインの裁定】**
//
// 1. **この見出しは `ADR-0087` 限定5 の**旧文の逐語**である。**
//    **`docs/adr/0087-renderer-component-baseline.md:83` に今日もその字面で在る。**
// 2. **今日は字面として偽である** —— **`@nivo/bar` / `@nivo/line` の2本と、
//    その推移依存34本(例外表 `CHART_LIBRARY_ALLOWLIST`)が実際に入っている。**
// 3. **それでも見出しを書き換えない。** **`ADR-0087` の本文を1バイトも書き換えない作法
//    (同 ADR §Decision 2 前文の逐語「本 ADR に追記しない」/ 先例は `ADR-0153`)と揃えるためである。**
//    **引き直しは別 ADR に `限定5'` を立てて行う** —— **今日の正は、引き直す側の ADR
//    (`V8-M12-T08` が起草する)にある。** **見出しだけを今日の正に書き換えると、
//    ADR 本文と検査の見出しが逆に食い違う。** **条文が凍っているなら、それを引いた見出しも凍る側が筋である。**
//    **解かれたのは条文の効力であって、条文の字面ではない。**
// 4. **`docs/plan/v8/02-report-aggregation-baseline.md:624` と `:901` が、この見出しを逐語で引いている**
//    (2026-08-15 に `LC_ALL=C /usr/bin/grep -rnF` で走査して確認した)。
//    **書き換えると、その2箇所が黙って偽になる。**
// 5. **【この1件は「逐語の残置が検査を騙す」型が1件残ることを承知したうえでの判断である】** ——
//    **隠さない。** **見出しの「1本も入れない」を根拠に「今日この repo に描画ライブラリは無い」と
//    読んではならない。** 今日この `describe` が確かめているのは、**中の2本の `test` 名が書くとおり、
//    「例外表の外側の描画ライブラリが1本も無い」ことだけである。**
describe("`ADR-0087` 限定5 —— 描画ライブラリを1本も入れない", () => {
  test("直接依存(`dependencies` / `devDependencies`)に、例外表の外側の描画ライブラリが1本も無い", () => {
    const pkg = readPackageJson();
    const direct = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    // 赤くなった場合、凍結表の更新では通らない。`F-7'` の保留を動かす権限の所在を
    // 先に確かめること(`ADR-0087` §総括3)。
    //
    // **今日この検査が言えるのは「例外表(門A が限定採用した `@nivo/bar` / `@nivo/line` と
    // その推移依存34本)の外側に1本も無い」までである。**
    expect(unapprovedHits(direct)).toEqual([]);
  });

  test("推移的依存(`bun.lock`)にも、例外表の外側の描画ライブラリが1本も無い", () => {
    const names = lockfilePackageNames(readFileSync(LOCKFILE_PATH, "utf-8"));
    expect(unapprovedHits(names)).toEqual([]);
  });
});

describe("検査が実際に読めていることの確認", () => {
  test("凍結表が空でも件数が0でもない", () => {
    // `kernel-export-drift.test.ts` の第2検査と同じ手口。対象を読めていないのに
    // 「差が無い」で緑になる壊れ方を防ぐ。
    const pkg = readPackageJson();
    expect(Object.keys(pkg.dependencies ?? {}).length).toBe(16);
    // 【2026-08-15】13 → 15(`@nivo/bar` / `@nivo/line`)。`dependencies` の 16 は動いていない。
    expect(Object.keys(pkg.devDependencies ?? {}).length).toBe(15);
    expect(pkg.dependencies?.react).toBeDefined();
    expect(pkg.devDependencies?.vite).toBeDefined();
  });

  test("`bun.lock` から推移的依存の名前が読める", () => {
    const names = lockfilePackageNames(readFileSync(LOCKFILE_PATH, "utf-8"));
    expect(names.length).toBeGreaterThanOrEqual(LOCKFILE_NAME_FLOOR);
    expect(names).toContain("react");
    // 部品体系が実際に推移的依存を連れてきていること(走査が直接依存だけを
    // 見ているのではないことの確認)。`@base-ui-components/react` の連れてきた分。
    expect(names).toContain("@base-ui-components/utils");
  });
});

describe("検出器そのものが働くこと(仕込みの入力で赤くなる)", () => {
  test("依存が1本増えたら名指しで出る", () => {
    expect(diffNames({ react: "19.2.7", recharts: "3.0.0" }, { react: "19.2.7" })).toEqual({
      added: ["recharts"],
      removed: [],
    });
  });

  test("依存が1本減っても名指しで出る(「1本消して1本足す」を素通りさせない)", () => {
    expect(diffNames({ recharts: "3.0.0" }, { react: "19.2.7" })).toEqual({
      added: ["recharts"],
      removed: ["react"],
    });
  });

  test("版だけ動いた場合は版の差として出る", () => {
    expect(diffVersions({ react: "19.3.0" }, { react: "19.2.7" })).toEqual([
      "react: 19.2.7 → 19.3.0",
    ]);
  });

  test("名指しの8本は全部落ちる", () => {
    expect(forbiddenHits([...FORBIDDEN_PACKAGES])).toEqual([...FORBIDDEN_PACKAGES].sort());
  });

  test("同族(`d3-scale` / `victory-vendor` / `@nivo/core`)も落ちる", () => {
    expect(forbiddenHits(["react", "d3-scale", "victory-vendor", "@nivo/core", "hono"])).toEqual([
      "@nivo/core",
      "d3-scale",
      "victory-vendor",
    ]);
  });

  test("名前が似ているだけのものは落とさない(`d3` と `d3js-like` を混ぜない)", () => {
    // **`d3` で始まるだけの名前は落とさない。** 落とす同族は接頭辞 `d3-` である。
    expect(forbiddenHits(["d3js-like", "charting-helpers", "uncharted"])).toEqual([]);
  });

  test("lockfile の走査が入れ子のキーからも名前を採る", () => {
    const sample = [
      '{ "packages": {',
      '  "react": ["react@19.2.7", "", {}, "sha512-x"],',
      '  "vite/esbuild": ["esbuild@0.25.0", "", {}, "sha512-y"],',
      '  "@nivo/core": ["@nivo/core@0.88.0", "", {}, "sha512-z"],',
      "} }",
    ].join("\n");
    expect(lockfilePackageNames(sample)).toEqual(["@nivo/core", "esbuild", "react"]);
    expect(forbiddenHits(lockfilePackageNames(sample))).toEqual(["@nivo/core"]);
  });
});

// ============================================================================
// 例外表(2026-08-15 新設。`V8-M12-T01`)
// ============================================================================

describe("例外表(`@nivo/bar` / `@nivo/line` とその推移依存だけを名指しで通す)", () => {
  test("例外表に載っていない名前は今日どおり赤になる(架空の `d3-foo` を混ぜる)", () => {
    // **例外表は「口を開ける」ものではない。** 名指しした34本の外側は1本も通らない。
    expect(
      unapprovedHits(["react", "hono", "d3-scale", "d3-foo", "@nivo/bar", "@nivo/pie", "recharts"]),
    ).toEqual(["@nivo/pie", "d3-foo", "recharts"]);
  });

  test("例外表の要素数を固定する(取りこぼしを名指しで赤にする)", () => {
    // 件数の固定は「増えたこと」ではなく**取りこぼし**を止める。
    // 名前の集合そのものは `CHART_LIBRARY_ALLOWLIST` の定義が正である。
    expect(CHART_LIBRARY_ALLOWLIST.length).toBe(34);
    // 同じ名前を2度書いて件数だけ合わせる壊れ方を止める。
    expect(new Set(CHART_LIBRARY_ALLOWLIST).size).toBe(34);
    // 例外表の全件が、そもそも禁止リストに当たる名前であること(死んだ行を置かない)。
    expect(forbiddenHits([...CHART_LIBRARY_ALLOWLIST]).length).toBe(34);
  });

  test("`@nivo/pie` ほか4本と3本目の描画ライブラリは例外表に1つも入っていない(`ADR-0007:1468` の限定)", () => {
    const outside = [
      "@nivo/pie",
      "@nivo/scatterplot",
      "@nivo/heatmap",
      "@nivo/calendar",
      "recharts",
      "chart.js",
      "victory",
      "apexcharts",
      "plotly.js",
    ];
    expect(outside.filter((name) => CHART_LIBRARY_ALLOWLIST.includes(name))).toEqual([]);
    // 例外表を通り道にできないこと(混ぜたら全件が赤で出る)。
    expect(unapprovedHits(outside)).toEqual([...outside].sort());
  });

  test("`@types/d3-` の追加が効いている(型だけの素通りを塞ぐ)", () => {
    expect(FORBIDDEN_PREFIXES).toContain("@types/d3-");
    // **追加前は素通りだった** —— この式が `false` であることが、穴の実体である。
    expect("@types/d3-scale".startsWith("d3-")).toBe(false);
    // 例外表に無い `@types/d3-*` は赤になる。
    expect(unapprovedHits(["@types/d3-foo"])).toEqual(["@types/d3-foo"]);
    // 実際に入った10本は例外表に在るので通る。
    expect(unapprovedHits(["@types/d3-scale", "@types/d3-time-format"])).toEqual([]);
  });
});
