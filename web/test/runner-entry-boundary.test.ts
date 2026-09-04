/**
 * **実行専用エントリの否定形の検査**(`V5-M4-T02` / 単位 `R-G8`)。
 *
 * 正は `docs/plan/v5/01-distribution-baseline.md` §4-2 の 2(逐語):
 *
 * > 「編集の口を外した」を確認する手段は、**イメージの中身に対する否定形の検査**
 * > (編集系ルートが登録されないこと・アプリ一覧の画面が入っていないこと)である。
 * > **肯定形(「動く」)だけでは足りない。**
 *
 * ## この検査が測っているもの / 測っていないもの
 *
 * - **測っている**: `bun run build:runner` が出す**ビルド成果物のバイト列**である。
 *   `import` 文を静的に読むだけの形ではない —— `web/runner/dist/` 配下の全ファイルを
 *   `Buffer` として読み、`Buffer#includes` で目印のバイト列を探す。**したがって
 *   バンドル後・最小化後の中身を見ている。**
 * - **測っていない**: **コンテナイメージの中身は1バイトも見ていない。**
 *   ここが見るのはビルド成果物であって、イメージではない。**イメージに対する検査は
 *   `V5-M7` の担当である**(`docs/plan/v5/records/v5-m4.md` §5)。
 * - **測っていない**: **サーバの編集系ルートが登録されないこと**は見ていない。
 *   本検査の対象は画面(`web/`)だけである(`R-G1` の担当範囲)。
 *
 * ## 3群の構成(なぜ (a) が要るのか)
 *
 * | # | 検査 | 何を守るのか |
 * |---|---|---|
 * | (a) | **禁止する目印が、既存エントリの成果物には実在すること** | **目印が死んでいないこと。** 文言や `data-testid` が改名されると (b) は何も検査していないのに緑になる。(a) が先に赤くなる |
 * | (b) | **実行専用エントリの成果物に、禁止する目印が1つも無いこと** | **本丸。** アプリ一覧・アプリ切替・運営/育成用パネルが配布物に入っていないこと |
 * | (c) | **実行専用エントリの成果物に、画面描画の部品が在ること** | **空の成果物で (b) が緑になることを防ぐ。** 何も描かないバンドルは (b) を必ず通る |
 *
 * ## 限界(先に書く。憲法6)
 *
 * 1. **「編集できない」ことは1ミリも示していない。** 示せるのは「**この成果物に入って
 *    いない**」までである(`01` §8-1 の禁止1)。**別のビルド設定で作り直せば入る。**
 * 2. **目印は文言と `data-testid` である。** どちらも人間が付けた名前であり、**同じ画面を
 *    別の名前で入れられたら (b) は気づかない。** (a) はその「改名」を検出するが、
 *    「改名して、かつ実行専用エントリにも入れる」経路は両方とも素通りする。
 * 3. **成果物のバイト列は最小化後である。** 変数名・関数名は消えているので、**目印に
 *    できるのは文字列リテラルとして残るものだけ**である(JSX の属性値と画面の文言)。
 * 4. **`web/runner/dist/` を実際に生成してから測る。** 生成に失敗したら全件赤になる。
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** 既存エントリ(`web/src/main.tsx`)の成果物。**(a) の対照に使うだけである。** */
const MAIN_DIST = join(REPO_ROOT, "web", "dist");
/** 実行専用エントリの成果物。**`web/vite.config.ts` の `runner` モードが出す。** */
const RUNNER_DIST = join(REPO_ROOT, "web", "runner", "dist");

/**
 * **配布物に入っていてはならないもの。**
 *
 * **今日の `web/src/AppWorkspace.tsx` と `web/src/App.tsx` を読んで数えた**
 * (2026-08-06 実測)。**「など」で丸めていない** —— 同居している運営/育成用の口は
 * 下の7本で、それに加えてシェル側のアプリ一覧・アプリ切替の2本である。
 *
 * **`marker` はバイト列としてそのまま探す。** 最小化しても文字列リテラルは残る。
 */
const FORBIDDEN: readonly { readonly label: string; readonly marker: string }[] = [
  // --- シェル(`web/src/App.tsx` / `web/src/AppListPage.tsx`)---
  {
    label: "台帳の全アプリを並べる画面(AppListPage / AppSwitcher の0件表示)",
    marker: "アプリがまだありません。",
  },
  { label: "別のアプリへ移る口(AppSwitcher の器)", marker: "app-switcher" },
  { label: "別のアプリへ移る口の文言(App.tsx)", marker: "アプリを切り替える" },
  { label: "シェルの未知パス表示(App.tsx)", marker: "アプリ一覧から選び直してください" },
  // --- 運営/育成用パネル7本(`web/src/AppWorkspace.tsx` が同居させているもの)---
  { label: "利用者の管理(UserAdmin の器)", marker: "user-admin" },
  { label: "利用者の管理への導線の文言", marker: "ユーザ管理" },
  { label: "接続まわりの管理(ConnectionAdmin の器)", marker: "connection-admin" },
  { label: "接続まわりの管理への導線の文言", marker: "接続の管理" },
  { label: "逃げ道の管理(EscapeHatchAdmin の器)", marker: "escape-hatch-admin" },
  { label: "逃げ道の管理への導線の文言", marker: "逃げ道の管理" },
  { label: "テーマ候補の下見(ThemePreviewPanel の前置き)", marker: "theme-preview-preface" },
  { label: "テーマ候補の下見への導線", marker: "open-theme-preview" },
  { label: "テーマの取り込み(ThemeImportPanel の器)", marker: "theme-import" },
  { label: "テーマの取り込みへの導線の文言", marker: "テーマの取り込み" },
  { label: "テーマの持ち出し(ThemeExportPanel の前置き)", marker: "theme-export-preface" },
  { label: "テーマの持ち出しへの導線", marker: "open-theme-export" },
  { label: "要件の定義書(RequirementsDocPanel の前置き)", marker: "requirements-preface" },
  { label: "要件の定義書への導線", marker: "open-requirements-doc" },
  // --- コメントの書く欄5本(`web/src/CommentPanel.tsx`)---
  //
  // **【2026-08-26。`V10-M33-T01`。台帳 `CM-G43`】**
  // **1〜5 は「入っているものを外した」である。** 着手前の実測(下の (b) を赤くしてから
  // 実装した)では、実行専用エントリの成果物に `comment-panel` が **2**・`comment-body` が
  // **1**・`comment-submit` が **1**・`comment-sent` が **1**・前置きの文言が **1** 入っていた。
  // **`ViewHost` が `CommentPanel` を静的 import していたためであり、provider を置いて
  // いない配る版でも「描かれないだけで、バイト列は入っている」状態だった。**
  //
  // **【罠 (b) に当たらないことを先に測った】** 9本とも `web/src/styles.css` 由来の CSS には
  // **0件**である(`web/dist/assets/*.css` / `web/runner/dist/assets/*.css` の両方で0)。
  // **上の (a) の doc が言う `theme-export` 型の罠**(共有 CSS 経由で目印が入ってしまい、
  // 画面の部品ではなく CSS の有無を測ることになる)**には掛からない** ——
  // 陽性対照として `theme-export` を同じ式で測ると、実行専用エントリの CSS に **2** 出た。
  { label: "書く欄の器(CommentPanel の器)", marker: "comment-panel" },
  { label: "書く欄の本文入力", marker: "comment-body" },
  { label: "書く欄の送信", marker: "comment-submit" },
  { label: "書く欄の送信後の知らせ", marker: "comment-sent" },
  { label: "書く欄の前置きの文言", marker: "直したいところを書いて送れます" },
  // --- コメントの読む場所4本(`web/src/CommentList.tsx` / `web/src/AppWorkspace.tsx`)---
  //
  // **【誇張しない】6〜9 は「外した」ではない** —— **着手前から実行専用エントリの成果物に
  // 1バイトも入っていなかった**(4本とも **0**。既存エントリの `.js` には
  // `comment-list` **10** / `open-comment-list` **1** / `comment-item-body` **2** /
  // `(名乗りなし)` **1**)。**読む場所は器(`ViewHost`)ではなくアプリの器
  // (`web/src/AppWorkspace.tsx`)に在り、配る版のエントリ(`web/src/runner-app.tsx`)は
  // それを1度も読み込まないためである。** **本タスクがしたのは「今日どおり入っていない」を
  // これから壊せないように固定することだけである。**
  //
  // **`(名乗りなし)` の括弧は半角(`0x28` / `0x29`)である**(`web/src/CommentList.tsx` の
  // 逐語)。**全角にすると (a) が赤くなる。**
  { label: "読む場所の器(CommentList の器)", marker: "comment-list" },
  { label: "読む場所への導線", marker: "open-comment-list" },
  { label: "読む場所の本文", marker: "comment-item-body" },
  { label: "読む場所の名乗りの既定", marker: "(名乗りなし)" },
];

/**
 * **配布物に入っていなければならないもの**((c) 用)。
 *
 * **「何も描かないバンドル」で (b) が緑になることを防ぐだけの検査である。**
 * **これは「動く」ことの証明ではない** —— ブラウザで開いて確かめてはいない。
 */
const REQUIRED: readonly { readonly label: string; readonly marker: string }[] = [
  { label: "画面一覧の器(実行専用エントリが描く)", marker: "view-list" },
  { label: "本文の器(実行専用エントリが描く)", marker: "workspace-main" },
  { label: "アプリ単位テーマのスコープ要素(AppThemeScope)", marker: "app-theme" },
  { label: "一覧レンダラ(ListViewRenderer の 0 件表示)", marker: "list-empty" },
  { label: "ログイン画面(LoginPage の器)", marker: "login-page" },
];

type Artifact = { readonly path: string; readonly bytes: Buffer };

/** ディレクトリ配下の全ファイルをバイト列として読む(再帰)。 */
function collectArtifacts(dir: string): Artifact[] {
  const found: Artifact[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectArtifacts(full));
      continue;
    }
    found.push({ path: full, bytes: readFileSync(full) });
  }
  return found;
}

/** 目印を含む成果物のパス(バイト列としての一致)。 */
function hits(artifacts: readonly Artifact[], marker: string): string[] {
  const needle = Buffer.from(marker, "utf8");
  return artifacts.filter((artifact) => artifact.bytes.includes(needle)).map((a) => a.path);
}

/**
 * `package.json` の script を実際に走らせる(**製品の経路そのものを踏む**)。
 *
 * **`NODE_ENV` を落としてから起動する。** `bun test` は `NODE_ENV=test` を立てるが、
 * **その値が入っているとビルド成果物のバイト列が変わる**(2026-08-06 実測:
 * `NODE_ENV=test bun run build:web` は `index-ZfFyX551.js`、素の
 * `bun run build:web` は `index-DvTVE4fR.js`)。**落とさないと、この検査が測るものが
 * 人間の走らせるビルドと別物になる。**
 */
function runBuild(script: string, extraEnv: Record<string, string> = {}): void {
  const env: Record<string, string | undefined> = { ...process.env, ...extraEnv };
  delete env.NODE_ENV;
  const result = Bun.spawnSync([process.execPath, "run", script], {
    cwd: REPO_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `bun run ${script} が失敗した(exit=${result.exitCode})\n` +
        `${result.stdout.toString()}\n${result.stderr.toString()}`,
    );
  }
}

/** **どのアプリを描くかを外から与えたときの目印。** 製品コードのどこにも書かれていない値。 */
const PROBE_APP_ID = "gp-runner-app-id-probe-9c1f";

let mainArtifacts: Artifact[] = [];
let runnerArtifacts: Artifact[] = [];
/** **アプリIDを外から与えて**作った成果物((d) 用)。 */
let probeArtifacts: Artifact[] = [];

beforeAll(() => {
  runBuild("build:web");
  mainArtifacts = collectArtifacts(MAIN_DIST);
  // **与えた場合 → 与えなかった場合の順に建てる。** 最後に残る `web/runner/dist` は
  // **アプリIDを1文字も持たない既定のビルド**である(検査の副作用で汚れた成果物を
  // 置いていかない)。
  runBuild("build:runner", { GP_RUNNER_APP_ID: PROBE_APP_ID });
  probeArtifacts = collectArtifacts(RUNNER_DIST);
  runBuild("build:runner");
  runnerArtifacts = collectArtifacts(RUNNER_DIST);
});

describe("実行専用エントリの否定形の検査(V5-M4-T02 / R-G8)", () => {
  test("(前提) 両方の成果物が1ファイル以上ある", () => {
    expect(mainArtifacts.length).toBeGreaterThan(0);
    expect(runnerArtifacts.length).toBeGreaterThan(0);
  });

  test("(a) 禁止する目印は、既存エントリの JavaScript には実在する(目印が死んでいない)", () => {
    // **`.js` に限る。** CSS の class 名だけに現れる語を目印にすると、**画面の部品が
    // 入っているかどうかではなく、共有の CSS が入っているかどうかを測ることになる**
    // (実際に `theme-preview` / `theme-export` / `requirements-doc` はそうだった。
    // どれも `web/src/styles.css` に規則があり、実行専用エントリの CSS にも入る)。
    const mainScripts = mainArtifacts.filter((a) => a.path.endsWith(".js"));
    expect(mainScripts.length).toBeGreaterThan(0);
    const dead = FORBIDDEN.filter((entry) => hits(mainScripts, entry.marker).length === 0).map(
      (entry) => `${entry.label}: ${entry.marker}`,
    );
    expect(dead).toEqual([]);
  });

  test("(b) 実行専用エントリの成果物に、禁止する目印が1つも無い", () => {
    const violations = FORBIDDEN.flatMap((entry) =>
      hits(runnerArtifacts, entry.marker).map(
        (path) => `${entry.label}(${entry.marker})が ${path} に入っている`,
      ),
    );
    expect(violations).toEqual([]);
  });

  test("(c) 実行専用エントリの JavaScript に、画面を描く部品が入っている", () => {
    // **ここも `.js` に限る** —— CSS だけを見ていると、**JavaScript が空でも緑になる。**
    const runnerScripts = runnerArtifacts.filter((a) => a.path.endsWith(".js"));
    expect(runnerScripts.length).toBeGreaterThan(0);
    const missing = REQUIRED.filter((entry) => hits(runnerScripts, entry.marker).length === 0).map(
      (entry) => `${entry.label}: ${entry.marker}`,
    );
    expect(missing).toEqual([]);
  });

  test("(d) どのアプリを描くかは成果物の外から入る(与えなければ入らない・与えれば入る)", () => {
    // **画面の中にアプリIDを直書きしない**(`V5-M4-T01`)。**2つ測る**:
    //   (d-1) 何も与えずに建てた成果物に、目印の値が1バイトも無い
    //   (d-2) `GP_RUNNER_APP_ID` を与えて建てた成果物には、その値が入っている
    // **片方だけでは「外から入る」と言えない** —— (d-1) だけなら「口が無い」でも緑になり、
    // (d-2) だけなら「焼き込んである」でも緑になる。
    expect(hits(runnerArtifacts, PROBE_APP_ID)).toEqual([]);
    expect(hits(probeArtifacts, PROBE_APP_ID).length).toBeGreaterThan(0);
  });
});
