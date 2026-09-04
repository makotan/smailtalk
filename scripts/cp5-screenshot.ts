/**
 * CP-5 の実地シナリオで「人間がブラウザで確認する」部分を、Playwright の
 * スクリーンショットとして残すための採取スクリプト(テストではない)。
 *
 * E2E(`web/e2e/`)は自前のフィクスチャサーバを立てるが、CP-5 は
 * **MCP 経由で AI が作った実物のアプリ**を見る必要があるので、
 * 既に起動している評価用サーバ(ST_DATA_ROOT=data-cp5, :3000)に直接繋ぐ。
 *
 * 使い方: bun run scripts/cp5-screenshot.ts <url> <出力パス> [待機するテキスト]
 */
import { chromium } from "@playwright/test";

const [, , url, out, waitText] = process.argv;
if (url === undefined || out === undefined) {
  throw new Error("usage: cp5-screenshot.ts <url> <out.png> [waitText]");
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
await page.goto(url, { waitUntil: "networkidle" });
if (waitText !== undefined) {
  await page.getByText(waitText, { exact: false }).first().waitFor({ timeout: 10_000 });
}
await page.screenshot({ path: out, fullPage: true });

// 一覧のヘッダ列を標準出力に出す。スクリーンショットは人間が見るものなので、
// 「列が増えた/消えた」を機械的にも記録しておく。
const headers = await page.locator("thead th").allTextContents();
console.error(`[cp5-screenshot] ${url} -> ${out} / thead: ${JSON.stringify(headers)}`);
await browser.close();
