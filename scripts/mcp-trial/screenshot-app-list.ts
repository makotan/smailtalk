// [V1-M9-T09 検証方法4 / 使い捨て補助] アプリ一覧画面(_apps 投影 = ルート "/")の
// スクリーンショットを撮る。削除後の一覧に「消したアプリが出ていない」ことの目視証跡。
// 使い方: ST_DATA_ROOT=... bun run server を別プロセスで起動しておき、
//   mise exec -- bun run scripts/mcp-trial/screenshot-app-list.ts <出力パス.png> [baseURL]
import { chromium } from "@playwright/test";

const outPath = process.argv[2];
// 既定は `localhost`(2026-09-06。着手前は `http://127.0.0.1:3000` だった)。
// 書き込みを許す origin の既定に `127.0.0.1` が無いので、撮る先も localhost に揃える。
const baseURL = process.argv[3] ?? "http://localhost:3000";
if (outPath === undefined) {
  console.error("usage: screenshot-app-list.ts <out.png> [baseURL]");
  process.exit(1);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  await page.goto(`${baseURL}/`, { waitUntil: "networkidle" });
  // アプリ一覧の描画完了を待つ(AppListPage が app 行を出す)。
  await page.waitForTimeout(500);
  await page.screenshot({ path: outPath, fullPage: true });
  const bodyText = await page.locator("body").innerText();
  console.log("=== 画面テキスト(先頭2000字)===");
  console.log(bodyText.slice(0, 2000));
} finally {
  await browser.close();
}
