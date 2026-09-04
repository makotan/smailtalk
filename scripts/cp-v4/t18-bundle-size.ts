/**
 * `V4-M15-T09` (2) の**バンドルの大きさの記録器**(要求は `P-G45`)。**テストではない。**
 *
 * ## なぜ在るのか / **上限を設けない**
 *
 * `P-G45` が起票する要求は **「上限を設けること」ではない。** 求められているのは
 * **大きさを記録する仕組みが1本あること**である。したがって本スクリプトは
 * `scripts/cp-v4/t13-probe.ts` / `t13-diff.ts` と同じ作法を採る:
 *
 * - **合否を1つも判定しない**(`throw` するのは計測が成立しなかったときだけ)。
 * - **値をそのまま出す**(丸めない・間引かない)。**バイト数は生の整数で出す。**
 * - **上限も下限も1つも持たない。** **「太った」「痩せた」の判断を1件もしない。**
 *
 * **【この記録器は「大きさが許容範囲か」を1度も判定しない。】** 判定を置きたくなったら、
 * それは `P-G45` の外側の新しい決定であり、ここではなく門で決める事項である。
 *
 * ## 何を測るか / 測らないか(誇張しない)
 *
 * - 測る: **`web/dist/assets/` に出力された JS と CSS の生バイト数と gzip バイト数。**
 *   gzip は `node:zlib` の `gzipSync` を**既定の圧縮率**で掛ける(vite が build 後に
 *   報告する gzip 値と同じ既定である。2026-08-03 に突き合わせ済み ——
 *   vite の `gzip: 98.71 kB` に対して本記録器は `98,725 B` を出した。
 *   **`level: 9` を指定すると 97,756 B になり、vite の報告と食い違う。** 既定を使う理由がこれである)。
 * - 測らない: **`web/dist/index.html`(テンプレート1本で、部品体系の増減をほぼ映さない)** /
 *   **画像・フォント等の JS でも CSS でもない資産**(**数えるが `other` として別に置き、
 *   合計に混ぜない**)/ **ネットワーク上の実転送量**(HTTP の圧縮方式は配信側の設定であり、
 *   ここで測れるのは gzip を掛けたらどうなるかまでである)/ **実行時の速度**(1ミリ秒も測っていない)。
 *
 * **ビルドは走らせない。** 既に出来上がっている `web/dist/assets/` を読むだけである
 * (`t13-probe.ts` が「起動済みのサーバに繋ぐだけ」なのと同じ形)。
 * したがって **`bun run build:web` を先に走らせておくこと**が使う側の責任である。
 *
 * ## 使い方
 *
 * ```
 * mise exec -- bun run build:web
 * mise exec -- bun run bundle-size --label after
 * ```
 *
 * | 引数 | 既定 | 意味 |
 * |---|---|---|
 * | `--label <名前>` | (必須) | 出力ファイル名に入る名前。`before` / `after` |
 * | `--dist-dir <パス>` | `web/dist/assets` | 読む先 |
 * | `--out-dir <パス>` | `docs/evidence/cp-v4-ui` | JSON の置き場 |
 * | `--no-write` | (未指定) | 付けると JSON を書かず、標準エラーに出すだけ |
 *
 * ## 着手前と着手後(`V4-M15-T09` (3) の要求する表)
 *
 * **バイト数はすべて生の整数である。丸めていない。**
 *
 * | 時点 | JS raw | CSS raw | raw 合計 | JS gzip | CSS gzip | gzip 合計 |
 * |---|---|---|---|---|---|---|
 * | **着手前**(2026-08-03。`V4-M15-T09` の親が実測) | 288,835 | 5,709 | 294,544 | 85,144 | 1,548 | 86,692 |
 * | **着手後**(2026-08-03 13:28。本タスクが実測) | 330,641 | 21,723 | 352,364 | 98,989 | 5,206 | 104,195 |
 * | 差 | +41,806 | +16,014 | +57,820 | +13,845 | +3,658 | +17,503 |
 *
 * **【この表について正直に書くこと4件】**
 *
 * 1. **`docs/plan/v4/04-pre-execution-checks.md` §2-6 の値(JS 282,443 B / CSS 5,528 B /
 *    gzip 合計 85,537 B)は今日の値ではない。** 上の表には**入れていない**
 *    (着手前の行は `04` からの転記ではなく、2026-08-03 の実測である)。
 * 2. **着手後の値は「本タスクを実施した時点」の値であって、`V4-M15` 完了時の値ではない。**
 *    計測時、**同じ worktree で別のタスクが `web/src/` を書き換えている最中**であった。
 *    **実際、本タスクの計測中に値は2度動いた**:
 *    13:21 の build が JS 329,552 B、13:24 に読み直すと 329,717 B、13:28 の build で 330,641 B。
 *    **この 1,089 B の増分を、本タスクは1バイトも書いていない。**
 *    **`V4-M15` 完了時の値を書くには、完了時にもう一度この記録器を走らせる必要がある** ——
 *    上の「着手後」行は**その時点の値に置き換えられるべき暫定値**である。
 * 3. **増分の内訳を1件も分解していない。** どのバイトが tailwind で、どのバイトが
 *    `@base-ui-components/react` かは**測っていない。** 上の表が言えるのは合計だけである。
 * 4. **「大きくなったこと」を評価していない。** 差の欄は引き算の結果であって、
 *    良し悪しの判断ではない(**`P-G45` は上限を求めていない**)。
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

/**
 * 既定の読み先(`V9-M3-T01`。群D)。**正本のルートを cwd にして走らせた相対である**
 * (`package.json` の `bundle-size` は正本のルートから走る)。
 *
 * 旧: `web/dist/assets`。**`V9-M1` が `web/` を `apps/smailtalk/web/` へ移した**ので、
 * 旧の綴りでは `collectAssets` が「読めません」で落ちていた。
 */
export const DEFAULT_DIST_DIR = "apps/smailtalk/web/dist/assets";

/**
 * **既定の書き先は置かない**(`V9-M3-T01`。群D)。
 *
 * 旧: `DEFAULT_OUT_DIR = "docs/evidence/cp-v4-ui"`。**`docs/` は公開単位
 * (`apps/smailtalk/`)の外に残る** —— 公開単位の中の記録器が、既定値だけで
 * 外へ書く形になる。**書くときは `--out-dir` で名指しさせる**(`--no-write` なら要らない)。
 */

export type Options = {
  label: string;
  distDir: string;
  /** 書き先。**`write` が false のときだけ未指定でよい。** */
  outDir: string | undefined;
  write: boolean;
};

/** 引数の解釈。**綴り間違いは黙って無視せず落とす**(`t13-probe.ts` の `parseArgs` と同じ作法)。 */
export function parseArgs(argv: readonly string[]): Options {
  let label: string | undefined;
  let distDir = DEFAULT_DIST_DIR;
  let outDir: string | undefined;
  let write = true;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--label":
        if (next === undefined) throw new Error("--label に値がありません");
        label = next;
        index += 1;
        break;
      case "--dist-dir":
        if (next === undefined) throw new Error("--dist-dir に値がありません");
        distDir = next;
        index += 1;
        break;
      case "--out-dir":
        if (next === undefined) throw new Error("--out-dir に値がありません");
        outDir = next;
        index += 1;
        break;
      case "--no-write":
        write = false;
        break;
      default:
        throw new Error(`知らない引数です: ${arg}`);
    }
  }

  // **ラベルの無い記録は残さない。** どの時点の値かが分からない数は記録の役に立たない。
  if (label === undefined || label === "") {
    throw new Error("--label は必須です(例: --label after)");
  }
  // **書き先を黙って決めない**(`V9-M3-T01`)。**1バイトも書かないときだけ省いてよい。**
  if (write && outDir === undefined) {
    throw new Error(
      "--out-dir は必須です(--no-write のときを除く)。例: --out-dir docs/evidence/cp-v4-ui",
    );
  }
  return { label, distDir, outDir, write };
}

export type AssetKind = "js" | "css" | "other";

/**
 * 拡張子だけで種別を決める。**中身を1バイトも見ない。**
 * `.js` / `.mjs` / `.cjs` を JS、`.css` を CSS、それ以外を `other` とする
 * (`.map` は JS ではない —— **配信されないので合計に入れない**)。
 */
export function classifyAsset(fileName: string): AssetKind {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".map")) return "other";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "js";
  if (lower.endsWith(".css")) return "css";
  return "other";
}

export type AssetSize = {
  name: string;
  kind: AssetKind;
  rawBytes: number;
  gzipBytes: number;
};

/**
 * 1ファイルの大きさ。**gzip は `node:zlib` の既定の圧縮率**(vite の報告と同じ既定)。
 * **合否を判定しない。返すのは数だけである。**
 */
export function measureAsset(name: string, bytes: Uint8Array): AssetSize {
  return {
    name,
    kind: classifyAsset(name),
    rawBytes: bytes.byteLength,
    gzipBytes: gzipSync(bytes).byteLength,
  };
}

export type Totals = { files: number; rawBytes: number; gzipBytes: number };

/**
 * 種別ごとの合計と、**JS + CSS の合計**。**`other` は数えるが合計に混ぜない**
 * (画像やフォントは部品体系の増減をそのまま映さないため)。
 * **これは集計であって判定ではない**(`t13-diff.ts` の `summarize` と同じ立場)。
 */
export function summarize(assets: readonly AssetSize[]): {
  js: Totals;
  css: Totals;
  other: Totals;
  total: Totals;
} {
  const bucket = (kind: AssetKind): Totals => {
    const picked = assets.filter((asset) => asset.kind === kind);
    return {
      files: picked.length,
      rawBytes: picked.reduce((sum, asset) => sum + asset.rawBytes, 0),
      gzipBytes: picked.reduce((sum, asset) => sum + asset.gzipBytes, 0),
    };
  };
  const js = bucket("js");
  const css = bucket("css");
  const other = bucket("other");
  return {
    js,
    css,
    other,
    total: {
      files: js.files + css.files,
      rawBytes: js.rawBytes + css.rawBytes,
      gzipBytes: js.gzipBytes + css.gzipBytes,
    },
  };
}

/** 標準エラーに出す行。**丸めない**(kB に直さない。生のバイト数を桁区切りだけ付けて出す)。 */
export function formatLines(assets: readonly AssetSize[], totals: ReturnType<typeof summarize>) {
  const n = (value: number): string => value.toLocaleString("en-US");
  const lines = assets.map(
    (asset) =>
      `  ${asset.name} (${asset.kind}) raw=${n(asset.rawBytes)} B gzip=${n(asset.gzipBytes)} B`,
  );
  lines.push(
    `  --- 合計(JS+CSS。上限は設けない) raw=${n(totals.total.rawBytes)} B gzip=${n(totals.total.gzipBytes)} B`,
  );
  return lines;
}

/** `web/dist/assets/` を読む(ここだけがファイルシステムに触る)。 */
export function collectAssets(distDir: string): AssetSize[] {
  let entries: string[];
  try {
    entries = readdirSync(distDir);
  } catch {
    // **黙って0件で成功しない。** 測れなかったことを測れなかったと言う。
    throw new Error(`${distDir} を読めません。先に \`bun run build:web\` を走らせてください`);
  }
  const assets = entries
    .filter((name) => statSync(join(distDir, name)).isFile())
    .sort()
    .map((name) => measureAsset(name, readFileSync(join(distDir, name))));
  if (assets.length === 0) {
    throw new Error(`${distDir} にファイルが1つもありません`);
  }
  return assets;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const assets = collectAssets(options.distDir);
  const totals = summarize(assets);

  for (const line of formatLines(assets, totals)) {
    console.error(`[t18-bundle-size:${options.label}]${line}`);
  }

  if (!options.write) {
    return;
  }
  // `parseArgs` が既に保証しているが、型を狭めるために書く(**黙って空文字へ落とさない**)。
  const outDir = options.outDir;
  if (outDir === undefined) {
    throw new Error("--out-dir は必須です(--no-write のときを除く)。");
  }
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `t18-bundle-size-${options.label}.json`);
  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        label: options.label,
        capturedAt: new Date().toISOString(),
        distDir: options.distDir,
        gzip: "node:zlib gzipSync 既定の圧縮率(vite の build 後の報告と同じ既定)",
        note: "P-G45 は上限を求めていない。本記録は合否を1つも判定しない(V4-M15-T09 (2))。",
        totals,
        assets,
      },
      null,
      2,
    )}\n`,
  );
  console.error(`[t18-bundle-size:${options.label}] wrote ${outPath}`);
}

if (import.meta.main) {
  main();
}
