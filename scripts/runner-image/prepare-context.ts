/**
 * **`docker build` に渡す前に、1アプリ分の `data/` を用意する**(`V5-M7-T01`)。
 *
 * ## なぜスクリプトが要るのか
 *
 * `Dockerfile` の中では `data/` を組み立てられない —— **元になる `data/` は
 * `.gitignore` の対象であり、リポジトリにも build context にも入っていない**
 * (`.gitignore:2` 逐語 `data/`)。**組み立ては build context を作る側の仕事である。**
 *
 * ## 出力先を `data-runner-image/` にした理由
 *
 * **`.gitignore:3` の `data-*`(末尾はスラッシュ) が既に当たる。** **`.gitignore` を1バイトも足さずに
 * 除外できる**(`git check-ignore -v data-runner-image/data` で実測)。
 * 除外が効いていないと biome(`vcs.useIgnoreFile`)が SQLite ファイルを lint しにいく。
 *
 * ## 2つの入り方
 *
 * | 入り方 | 使う場面 | 中身 |
 * |---|---|---|
 * | **`--from <dataRoot> --app <app_id>`** | 実際に育てたアプリを配る | `scripts/build-runner-data.ts` がそのアプリ1件を切り出す |
 * | **`--demo`** | 自動チェック(`D-V5-91`)/ 手元の煙試験 | `scripts/runner-image/seed-demo-app.ts` がその場で1件作る |
 *
 * **`--demo` が要る理由**: **自動チェックの機械には `data/` が1バイトも無い。**
 * **加えて、今日ディスクにある実アプリは `user_version = 0` なので版のゲートに止められる**
 * (`ADR-0251` 限定6。実測は `docs/plan/v5/records/v5-m7.md` §1)。
 *
 * ## この器がしないこと
 *
 * - **元の `data/` に1バイトも書かない。** `--from` は読むだけである
 *   (`buildRunnerData` が読み取り専用で開く)。
 * - **`docker` を1回も呼ばない。** ここは context を作るだけである。
 *
 * ## 使い方
 *
 * **正本のルートを cwd にして打つ**(`V9-M2` が木を `apps/smailtalk/` へ移した)。
 *
 * ```
 * mise exec -- bun run apps/smailtalk/scripts/runner-image/prepare-context.ts --demo
 * mise exec -- bun run apps/smailtalk/scripts/runner-image/prepare-context.ts --from ../data --app tokiwa
 * ```
 *
 * **`--context-root <path>` は書き込み先を上書きする(既定は公開単位の根直下の
 * `data-runner-image/`)。** `ci-container-check.sh` は正本のルートを cwd にして
 * `--context-root data-runner-image` を渡し、`docker build` の context(正本のルート)
 * と噛み合わせている。
 *
 * 出力の最後の行は `GP_RUNNER_APP_ID=<app_id>` である(`docker build --build-arg` に渡す)。
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildRunnerData } from "../build-runner-data.ts";
import { DEMO_APP_ID, seedDemoApp } from "./seed-demo-app.ts";

/** build context に置くディレクトリ(公開単位の根直下)。**`.gitignore` の `data-*`(末尾はスラッシュ) が当たる。** */
export const CONTEXT_DIR_NAME = "data-runner-image";
/** その下に置く `data/`。`Dockerfile` はここを `COPY` する。 */
export const CONTEXT_DATA_SUBDIR = "data";

/**
 * **公開単位(`apps/smailtalk/`)の根**(`V9-M11-T03`。`X-G29`)。
 *
 * `import.meta.dir` は `<公開単位の根>/scripts/runner-image` である。
 * **2つ上げる**(`runner-image` → `scripts` → 公開単位の根)。
 *
 * **正本のルート(`apps/smailtalk` の親)へは1度も出ない**(`X-G29`。公開単位の中の
 * コードが自分より上の階層を解決してはいけない)。**切り出した木**
 * (`apps/smailtalk/` を単独の器として配ったもの)では、そこにこの根が木の根
 * そのものになる —— **モノレポでも切り出した木でも、同じ2段上げで正しく着く。**
 *
 * **旧い計算(4段上げ)は正本のルートまで出ていた。** `apps/smailtalk` を単独で
 * 配った木にはその先(`apps/` や器の `bun.lock`)が無いので、旧い計算はどこにも
 * 着かず、実測でも壊れていた(`ci-container-check.test.ts` の実測。`V9-M11-T03`)。
 *
 * ## この変更が呼んだ波及(**メインの裁定でここまでは当てた**)
 *
 * `contextRoot` を省略した既定の書き込み先が
 * `<正本のルート>/data-runner-image/data` から `<公開単位の根>/data-runner-image/data`
 * へ動いた。`apps/smailtalk/Dockerfile:152` の `COPY data-runner-image/data ./image-data`
 * は **build context(モノレポでは正本のルート。`ci-container-check.sh` の
 * `docker build … .`)からの相対**のままであり(`Dockerfile` は `X-G33` の射程なので
 * 書き換えていない)、既定のままだと `docker build` の `COPY` が見つからず落ちる
 * (実測は `V9-M11-T03` の報告に貼った)。
 *
 * **そこで `--context-root <path>` を新設した。** `ci-container-check.sh` は
 * 正本のルートを cwd にして `--context-root data-runner-image` を渡すので、
 * 書き込み先は今までどおり正本のルート直下に戻る(相対パスは `fs` の既定どおり
 * `process.cwd()` から解決される。ここは `PRODUCT_ROOT` を経由しない)。
 * **`--context-root` を渡さない呼び出しは今日も公開単位の根直下に書く**
 * (`X-G29` の対象は変わらず `PRODUCT_ROOT` である)。
 *
 * **`.gitignore:4` の `data-*`(末尾はスラッシュ) はどの深さでも当たるので、
 * 書き込み先が動いても `git status` には1行も出ない。**
 *
 * **`process.cwd()` を使わない**(`V9-M3-T01` の裁定2)。`PRODUCT_ROOT` はどこから
 * 走らせても同じ場所を指す。`--context-root` を渡したときだけは呼び出し側が渡した
 * パスをそのまま使うので、この限りではない(呼び出し側の cwd に依存するのは
 * `ci-container-check.sh` の既知の前提であり、新規の `process.cwd()` 呼び出しを
 * このファイルに足してはいない)。
 */
export const PRODUCT_ROOT = dirname(dirname(import.meta.dir));

export type PrepareContextOptions = {
  /** 切り出し元の `data/`。`demo` のときは使わない。 */
  from?: string;
  /** 配るアプリのID。`demo` のときの既定は `runner-demo`。 */
  appId?: string;
  /** その場で見本のアプリを1件作るか。 */
  demo?: boolean;
  /** 出力の置き場(既定は公開単位の根直下の `data-runner-image/`)。 */
  contextRoot?: string;
};

export type PrepareContextResult = {
  appId: string;
  /** 組み上がった `data/` の絶対パス。 */
  dataRoot: string;
};

/**
 * build context の `data/` を用意する。
 *
 * **既に在れば消してから作り直す** —— `buildRunnerData` は出力先に `kernel.sqlite` が
 * 在ると拒否するので、消さないと2回目が必ず失敗する。**消すのは自分が作った
 * `data-runner-image/` の下だけである。**
 */
export function prepareContext(options: PrepareContextOptions = {}): PrepareContextResult {
  const contextRoot = options.contextRoot ?? join(PRODUCT_ROOT, CONTEXT_DIR_NAME);
  const targetDataRoot = join(contextRoot, CONTEXT_DATA_SUBDIR);
  if (existsSync(targetDataRoot)) {
    rmSync(targetDataRoot, { recursive: true, force: true });
  }

  if (options.demo === true) {
    const appId = options.appId ?? DEMO_APP_ID;
    // **見本は一時ディレクトリに作ってから切り出す。** `buildRunnerData` を必ず通すことで、
    // **実アプリを配る経路と同じ道を踏む**(見本だけ別の道を通ると、切り出しの検査が
    // 自動チェックで1度も踏まれない)。
    const staging = mkdtempSync(join(tmpdir(), "gp-runner-seed-"));
    try {
      seedDemoApp(staging, appId);
      buildRunnerData({ sourceDataRoot: staging, targetDataRoot, appId });
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    return { appId, dataRoot: targetDataRoot };
  }

  const sourceDataRoot = options.from;
  const appId = options.appId;
  if (sourceDataRoot === undefined || appId === undefined) {
    throw new Error("--from <dataRoot> と --app <app_id> の両方が要ります(または --demo)。");
  }
  buildRunnerData({ sourceDataRoot, targetDataRoot, appId });
  return { appId, dataRoot: targetDataRoot };
}

/** `--key value` / `--flag` だけを読む最小の引数解釈。 */
function parseArgs(argv: readonly string[]): PrepareContextOptions {
  const options: PrepareContextOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--demo") {
      options.demo = true;
    } else if (arg === "--from") {
      if (next === undefined) {
        throw new Error("--from の後にパスがありません。");
      }
      options.from = next;
      i += 1;
    } else if (arg === "--app") {
      if (next === undefined) {
        throw new Error("--app の後に app_id がありません。");
      }
      options.appId = next;
      i += 1;
    } else if (arg === "--context-root") {
      if (next === undefined) {
        throw new Error("--context-root の後にパスがありません。");
      }
      options.contextRoot = next;
      i += 1;
    } else {
      throw new Error(`読めない引数です: ${arg}`);
    }
  }
  return options;
}

if (import.meta.main) {
  const result = prepareContext(parseArgs(process.argv.slice(2)));
  console.log(`build context の data/ を作りました: ${result.dataRoot}`);
  console.log(`GP_RUNNER_APP_ID=${result.appId}`);
}
