/**
 * E2E の設定(V0-P3-T03)。以降のタスクと CP-3 の E2E はこの基盤の上に足す。
 *
 * `bun test` と混ざらないよう、テストファイルの拡張子は `.e2e.ts` にしてある
 * (bun のテスト検出は `*.test.*` / `*.spec.*` を拾うため、`.spec.ts` は使わない)。
 *
 * サーバは `fixture-server.ts` が一時 dataRoot 上に立てる。`npm run test:e2e` は
 * その前に `build:web` を実行するので、Hono がビルド済みフロントを配信する
 * **本番相当の構成**(ADR-0003 §2)をそのまま検証することになる。
 */
import type { ReporterDescription } from "@playwright/test";
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.ST_E2E_PORT ?? 3210);
/**
 * ブラウザは **localhost** でアクセスする(per-app 認証 / ADR-0014 v3)。
 * WebAuthn は rpID に IP を許さず、rpID=localhost はホスト名 localhost の origin でのみ
 * 儀式が成立する(`auth.e2e.ts` の仮想オーセンティケータ)。既存 E2E も同じ origin に
 * 揃えることで、認証エンドポイント・レコード書き込みの Origin 検査が単一の期待 origin で通る。
 * サーバ自体は 127.0.0.1 に bind したままで、localhost は 127.0.0.1 に解決して到達する。
 */
const baseURL = `http://localhost:${port}`;
/** 起動待ちは bind アドレス(127.0.0.1)で確実に判定する(localhost の IPv6/IPv4 解決順に依存しない)。 */
const readyURL = `http://127.0.0.1:${port}`;

/**
 * reporter の決定を純関数として切り出す(config 本体は `process.env.CI` を
 * モジュール評価時に読むため、そのままでは env を切り替えたテストが書けない)。
 *
 * CI では "line" と "html" を両方指定する:
 * - "line" 単独だと playwright-report/ が一切生成されず、失敗時に
 *   ci.yml の Upload Playwright artifacts が上げるものが無くなる。
 * - とはいえ "html" 単独にはしない。"line" が持つ「CI ログをその場で
 *   行単位で追える」利点を失いたくないため、両方を並べる。
 * - html レポータの `open: "never"` は必須。指定しないと Playwright が
 *   レポート表示用にブラウザを開こうとし、CI では何もせず固まる/失敗する。
 */
export function resolveReporter(ciEnv: string | undefined): "list" | ReporterDescription[] {
  return ciEnv === undefined ? "list" : [["line"], ["html", { open: "never" }]];
}

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  reporter: resolveReporter(process.env.CI),
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun run web/e2e/fixture-server.ts",
    cwd: "../..",
    url: readyURL,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
});
