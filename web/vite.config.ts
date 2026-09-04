/**
 * フロントのビルド構成(V0-P3-T03 / ADR-0003 §2)。
 *
 * ビルドするのは**汎用コンポーネント自身**であって、アプリごとのビルドではない。
 * マニフェストを変えてもここは再実行されない(憲法3 / V0-P3-T07)。
 *
 * - 出力先は `web/dist`。`src/server/app.ts` の既定値(`<cwd>/web/dist`)と一致させてある。
 * - 開発時は `/api` を Hono にプロキシする。ブラウザから見て同一オリジンになるので
 *   CORS を設定しない(ADR-0003 §8)。
 */
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

/** Hono の待ち受けポート(`src/server/index.ts` と同じ既定値・同じ環境変数)。 */
const apiPort = Number(process.env.PORT ?? 3000);

/**
 * **実行専用エントリのビルド**(`V5-M4-T01` / 単位 `R-G8`)。
 *
 * `vite build --mode runner` のときだけ、入口を `web/runner.html` に差し替え、
 * 出力先を `web/runner/dist` にする。**既定(`mode` が `runner` 以外)は1バイトも
 * 変わっていない** —— 入口は `web/index.html`、出力先は `web/dist` のままである。
 *
 * **出力先を `web/runner/dist` にした理由**: `.gitignore:10` の `dist/` が**階層を問わず**
 * `dist` という名前のディレクトリに当たるので、**`.gitignore` を1バイトも足さずに
 * 除外できる**(`git check-ignore -v web/runner/dist/x.js` → `.gitignore:10:dist/` で実測)。
 * 除外が効いていないと biome(`vcs.useIgnoreFile`)が成果物を lint しにいく。
 *
 * **開発サーバ(`server`)は差し替えていない。** 実行専用エントリを `vite dev` で開く
 * 経路は用意していない(**測っていない**)。
 */
const RUNNER_MODE = "runner";

export default defineConfig(({ mode }) => ({
  root,
  // **Tailwind の走査はビルド時に閉じる**(ADR-0087 限定6)。走査対象は
  // `web/src/tailwind.css` の `@source` が名指しする `web/src/**/*.{ts,tsx}` だけであり、
  // **safelist を1行も置いていない。** マニフェストの値からクラス名は1つも生えない
  // —— したがって上のコメント「マニフェストを変えてもここは再実行されない」は今日も真である。
  plugins: [tailwindcss(), react()],
  build:
    mode === RUNNER_MODE
      ? {
          outDir: "runner/dist",
          emptyOutDir: true,
          rollupOptions: {
            input: fileURLToPath(new URL("./runner.html", import.meta.url)),
          },
        }
      : {
          outDir: "dist",
          emptyOutDir: true,
        },
  /**
   * **実行専用エントリが描くアプリを、ビルド時に外から入れる**(`V5-M4-T01`)。
   *
   * **与えなければ空文字である** —— **既定のビルド成果物にアプリのIDは1文字も入らない。**
   * **`runner` モードでだけ置き換える。** 既定のビルドはこのキーを持たない
   * (既存エントリのバイト列を1バイトも動かさないため。2026-08-06 に sha256 で実測)。
   */
  define:
    mode === RUNNER_MODE
      ? {
          __GP_RUNNER_APP_ID__: JSON.stringify(process.env.GP_RUNNER_APP_ID ?? ""),
        }
      : {},
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: `http://127.0.0.1:${apiPort}` },
    },
  },
}));
