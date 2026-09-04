/**
 * CP-3 の「手動シナリオ」をブラウザ操作として実行し、各ステップのスクリーンショットを
 * 撮るスクリプト(docs/plan/v0/04-interpreter-ui.md CP-3 確認方法2・3)。
 *
 * ## なぜ `web/e2e/` ではなくここに置くか
 *
 * これは**エビデンス採取のための再現手順**であって、リグレッションを守るテストではない。
 * `bun run test:e2e`(= CP-3 確認方法1)は「何が壊れたら赤くなるか」が明快な集合で
 * あるべきなので、スクリーンショットを撮るだけの実行をそこに混ぜない。
 * 一方で使い捨てにもしない: cp-3.md の主張(3冊登録→状態変更→ソート→削除が
 * ブラウザで通る)は、このファイルを再実行すれば誰でも再現できる。
 *
 * ## 実行
 *
 * **正本のルートを cwd にして打つ**(`V9-M2` が木を `apps/smailtalk/` へ移した)。
 * **`--out` は必須である**(`V9-M3-T01`)。
 *
 *   mise exec -- bun run apps/smailtalk/scripts/cp3-scenario.ts \
 *       --out ../../docs/evidence/cp-3                            # 蔵書管理シナリオ
 *   mise exec -- bun run apps/smailtalk/scripts/cp3-scenario.ts \
 *       --mode reference --out ../../docs/evidence/cp-3           # reference型を含むアプリ
 *
 * オプション: `--fixture <path>` `--port <n>`(`--out <dir>` は必須)
 *
 * データは毎回 `fs.mkdtemp` の一時 dataRoot に作り、終了時に消す。リポジトリの
 * `data/` には触らない。サーバは `src/server/app.ts`(製品のサーバ)をそのまま起動し、
 * フロントは `web/dist`(`bun run build:web` の成果物)を Hono が配信する本番相当の構成。
 *
 * このスクリプトにアプリ固有の分岐は無い……とは言えない。**「3冊登録して状態を変えて
 * 削除する」というシナリオ自体が蔵書管理という具体のアプリの話**なので、フィールドID
 * (`title` / `status` / `finished_at`)がシナリオ定義に現れる。これはプラットフォーム側
 * のコード(`src/` / `web/src/`)ではなく、**エビデンス採取用の台本**である。台本が
 * アプリを知っていることと、実装がアプリを知っていることは別である(CP-3 確認方法4 は
 * 後者を見ている)。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../src/kernel/index.ts";
import { createServerApp } from "../src/server/app.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// --- 引数 -----------------------------------------------------------------------

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const mode = argValue("mode") ?? "book";
const defaultFixture =
  mode === "reference"
    ? "fixtures/valid/library-with-reference.json"
    : "fixtures/valid/book-tracker.json";
const fixturePath = resolve(repoRoot, argValue("fixture") ?? defaultFixture);

/**
 * **`--out` は必須である**(`V9-M3-T01`。群D)。
 *
 * 旧: 省くと `docs/evidence/cp-3` へ書いた。**`V9-M1` / `V9-M2` が製品と器を
 * `apps/smailtalk/` へ移したが、`docs/` は正本のルートに残る** —— 公開単位
 * (`apps/smailtalk/`)の中の採取器が、既定値だけで公開単位の外へ書く形になる。
 * **撤去であって移設ではない**(どこへ書くべきかは呼ぶ側が決める)。
 *
 * なお `resolve` の起点 `repoRoot` は `apps/smailtalk` である
 * (このファイルは `apps/smailtalk/scripts/` に在り、`fixtures/` も `web/dist` も
 * その下に在る)。**絶対パスを渡せば起点は効かない。**
 */
const outArg = argValue("out");
if (outArg === undefined || outArg === "") {
  throw new Error(
    "--out <dir> は必須です(書き先を黙って決めません)。例: --out ../../docs/evidence/cp-3",
  );
}
const outDir = resolve(repoRoot, outArg);
const port = Number(argValue("port") ?? 3311);

// --- サーバ ---------------------------------------------------------------------

const manifest = JSON.parse(readFileSync(fixturePath, "utf8")) as Manifest;
const dataRoot = mkdtempSync(join(tmpdir(), "gp-cp3-scenario-"));
const appId = manifest.app.id;

const store = KernelMetaStore.open(dataRoot);
try {
  createApp(store, manifest.app.name, { app_id: appId });
} finally {
  store.close();
}
const applied = applyManifest(dataRoot, appId, manifest);
if (!applied.valid) {
  throw new Error(`フィクスチャの適用に失敗: ${JSON.stringify(applied.errors)}`);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: createServerApp({ dataRoot, webDistDir: join(repoRoot, "web", "dist") }).fetch,
});
const baseURL = `http://127.0.0.1:${port}`;
console.log(`server: ${baseURL} (dataRoot=${dataRoot}, fixture=${fixturePath})`);

// --- ブラウザ操作のヘルパ --------------------------------------------------------

mkdirSync(outDir, { recursive: true });
let shotIndex = 0;

async function shot(page: Page, name: string, caption: string): Promise<void> {
  shotIndex += 1;
  const file = join(outDir, `${mode}-${String(shotIndex).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  [shot] ${file}  — ${caption}`);
}

/** アプリ一覧からアプリ名のリンクを踏む(URL を直打ちしない = 人の操作と同じ経路)。 */
async function openApp(page: Page): Promise<void> {
  await page.goto(`${baseURL}/`);
  await page.getByTestId("app-list").waitFor();
  await page.getByRole("link", { name: manifest.app.name }).click();
  await page.getByTestId("view-list").waitFor();
}

/** ビュー一覧のリンクからビューを開く。 */
async function openView(page: Page, viewId: string): Promise<void> {
  await page.getByTestId("view-list").getByRole("link", { name: viewId }).click();
  await waitForContent(page, viewTypeOf(viewId));
}

/**
 * ビューの**中身が出るまで**待つ。
 *
 * `view-renderer-<type>` は読み込み中でも同じ `data-testid` で描かれる(どのビューに
 * ディスパッチされたかは取得の成否と無関係、という設計判断。ListViewRenderer の
 * コメント参照)。したがってこれを待つだけでは「読み込み中…」の瞬間を掴んでしまう。
 * スクリーンショットを撮る用途ではそれが致命的なので、中身を持つ要素まで待つ。
 */
async function waitForContent(page: Page, viewType: string): Promise<void> {
  await page.getByTestId(`view-renderer-${viewType}`).waitFor();
  if (viewType === "list_view") {
    await page
      .getByTestId("list-table")
      .or(page.getByTestId("list-empty"))
      .or(page.getByTestId("errors"))
      .first()
      .waitFor();
    return;
  }
  if (viewType === "detail_view") {
    await page.getByTestId("detail-fields").or(page.getByTestId("errors")).first().waitFor();
    return;
  }
  if (viewType === "form") {
    await page
      .getByRole("button", { name: "保存" })
      .or(page.getByTestId("errors"))
      .first()
      .waitFor();
  }
}

function viewTypeOf(viewId: string): string {
  const view = manifest.app.views.find((candidate) => candidate.id === viewId);
  if (view === undefined) {
    throw new Error(`ビュー "${viewId}" がマニフェストにありません`);
  }
  return view.type;
}

/** 一覧の行を上から順に、セルの文字列の配列として読む。 */
async function readRows(page: Page): Promise<string[][]> {
  const rows = page.getByTestId("list-row");
  const count = await rows.count();
  const result: string[][] = [];
  for (let i = 0; i < count; i += 1) {
    result.push((await rows.nth(i).locator("td").allInnerTexts()).map((text) => text.trim()));
  }
  return result;
}

/** フォームを埋めて保存する。値は `{ フィールドID: 値 }`。 */
async function fillAndSubmit(page: Page, values: Record<string, string>): Promise<void> {
  for (const [fieldId, value] of Object.entries(values)) {
    const input = page.getByTestId(`field-input-${fieldId}`);
    const tag = await input.evaluate((node) => node.tagName.toLowerCase());
    if (tag === "select") {
      await input.selectOption({ label: value });
    } else {
      await input.fill(value);
    }
  }
  await page.getByRole("button", { name: "保存" }).click();
}

function expect(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`シナリオの期待に反しました: ${message}`);
  }
  console.log(`  [ok] ${message}`);
}

// --- シナリオ本体 ---------------------------------------------------------------

/**
 * CP-3 確認方法2:「書籍を3冊登録→状態を変更→読了日でソートされた一覧を確認→1冊削除」
 */
async function bookScenario(page: Page): Promise<void> {
  const listView = "book-list";
  const formView = "book-form";

  console.log("[1] アプリを開いて空の一覧を見る");
  await openApp(page);
  await openView(page, listView);
  await page.getByTestId("list-empty").waitFor();
  await shot(page, "empty-list", "空の一覧(まだ1冊も登録していない)");

  console.log("[2] 3冊登録する");
  const books = [
    { title: "吾輩は猫である", status: "読了", finished_at: "2026-03-01" },
    { title: "坊っちゃん", status: "読了", finished_at: "2026-05-20" },
    { title: "こころ", status: "未読", finished_at: "" },
  ];
  for (const book of books) {
    await openView(page, formView);
    const values: Record<string, string> = { title: book.title, status: book.status };
    if (book.finished_at !== "") {
      values.finished_at = book.finished_at;
    }
    await fillAndSubmit(page, values);
    await waitForContent(page, "list_view");
  }
  await openView(page, listView);
  await page.getByTestId("list-table").waitFor();
  const afterCreate = await readRows(page);
  expect(afterCreate.length === 3, `3冊が一覧に出ている(実際 ${afterCreate.length} 行)`);
  await shot(page, "list-3-books", "3冊登録した直後の一覧");

  console.log("[3] 「こころ」の状態を 未読 → 読了 に変え、読了日を入れる");
  const target = page.getByTestId("list-row").filter({ hasText: "こころ" });
  await target.click();
  await waitForContent(page, "detail_view");
  await shot(page, "detail-before", "状態変更前の詳細(状態=未読 / 読了日は空)");
  await page.getByTestId("detail-edit").click();
  await waitForContent(page, "form");
  await fillAndSubmit(page, { status: "読了", finished_at: "2026-07-10" });
  await waitForContent(page, "detail_view");
  const statusText = (await page.getByTestId("detail-field-status").innerText()).trim();
  const finishedText = (await page.getByTestId("detail-field-finished_at").innerText()).trim();
  expect(statusText === "読了", `詳細の状態が「読了」になっている(実際 "${statusText}")`);
  expect(
    finishedText.includes("2026") && finishedText.includes("7"),
    `詳細の読了日が 2026-07-10 相当になっている(実際 "${finishedText}")`,
  );
  await shot(page, "detail-after-status-change", "状態変更後の詳細(状態=読了 / 読了日=2026-07-10)");

  console.log("[4] 読了日でソートされた一覧を確認する");
  await openView(page, listView);
  await page.getByTestId("list-table").waitFor();
  const sorted = await readRows(page);
  const titles = sorted.map((row) => row[0]);
  // マニフェストの list_view は sort: { field: finished_at, order: desc }。
  // 読了日の降順は こころ(07-10) > 坊っちゃん(05-20) > 吾輩は猫である(03-01)。
  expect(
    JSON.stringify(titles) === JSON.stringify(["こころ", "坊っちゃん", "吾輩は猫である"]),
    `読了日の降順に並んでいる(実際 ${JSON.stringify(titles)})`,
  );
  await shot(page, "list-sorted-by-finished-at", "読了日(finished_at)降順に並んだ一覧");

  console.log("[5] 1冊(坊っちゃん)を削除する");
  await page.getByTestId("list-row").filter({ hasText: "坊っちゃん" }).click();
  await waitForContent(page, "detail_view");
  await page.getByTestId("detail-delete").click();
  await page.getByTestId("detail-delete-confirm").waitFor();
  await shot(page, "delete-confirm", "削除の確認(元に戻せない旨を出してから消す)");
  await page.getByTestId("detail-delete-execute").click();
  await waitForContent(page, "list_view");
  const afterDelete = await readRows(page);
  const remaining = afterDelete.map((row) => row[0]);
  expect(
    JSON.stringify(remaining) === JSON.stringify(["こころ", "吾輩は猫である"]),
    `削除後は2冊で、消したのは「坊っちゃん」だけ(実際 ${JSON.stringify(remaining)})`,
  );
  await shot(page, "list-after-delete", "1冊削除した後の一覧(2冊)");
}

/**
 * CP-3 確認方法3: reference 型を含む別アプリでも、同じフロント・同じサーバのまま動くこと。
 * 参照先(著者)を作ってから、書籍のフォームで**ピッカーとして**著者を選ぶ。
 */
async function referenceScenario(page: Page): Promise<void> {
  console.log("[1] アプリを開く");
  await openApp(page);
  await shot(page, "view-list", "reference型を含むアプリのビュー一覧(蔵書管理と同じ画面)");

  console.log("[2] 著者を2人登録する");
  for (const author of [
    { name: "夏目漱石", bio: "1867-1916。小説家。" },
    { name: "森鴎外", bio: "1862-1922。小説家・軍医。" },
  ]) {
    await openView(page, "author-form");
    await fillAndSubmit(page, author);
    await waitForContent(page, "list_view");
  }

  console.log("[3] 書籍を3冊登録する(著者は reference のピッカーで選ぶ)");
  await openView(page, "book-form");
  // reference の選択肢は参照先テーブルを別途取りに行くので、選択肢が入るまで待つ。
  await page
    .getByTestId("field-input-author")
    .locator("option", { hasText: "夏目漱石" })
    .waitFor({ state: "attached" });
  await shot(
    page,
    "reference-picker",
    "reference 型は生の _id ではなく参照先の代表値のプルダウンになる",
  );
  for (const book of [
    { title: "三四郎", author: "夏目漱石" },
    { title: "舞姫", author: "森鴎外" },
    { title: "門", author: "夏目漱石" },
  ]) {
    await openView(page, "book-form");
    await fillAndSubmit(page, book);
    await waitForContent(page, "list_view");
  }

  console.log("[4] 一覧で reference 列が代表値で表示されることを確認する");
  await openView(page, "book-list");
  await page.getByTestId("list-table").waitFor();
  const rows = await readRows(page);
  expect(rows.length === 3, `3冊が一覧に出ている(実際 ${rows.length} 行)`);
  const authorCells = rows.map((row) => row[1]);
  expect(
    authorCells.every((cell) => cell === "夏目漱石" || cell === "森鴎外"),
    `著者列が _id ではなく代表値で出ている(実際 ${JSON.stringify(authorCells)})`,
  );
  await shot(page, "list-with-reference", "reference 列(著者)が参照先の代表値で表示された一覧");

  console.log("[5] 著者の詳細を開く");
  await openView(page, "author-list");
  await page.getByTestId("list-table").waitFor();
  await page.getByTestId("list-row").filter({ hasText: "夏目漱石" }).click();
  await waitForContent(page, "detail_view");
  await shot(page, "author-detail", "参照先(著者)の詳細。long_text も型に応じた表示になる");
}

// --- 実行 -----------------------------------------------------------------------

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
let failure: unknown;
try {
  if (mode === "reference") {
    await referenceScenario(page);
  } else {
    await bookScenario(page);
  }
  console.log(`\nシナリオ完了: スクリーンショット ${shotIndex} 枚を ${outDir} に保存しました。`);
} catch (reason: unknown) {
  failure = reason;
  console.error("\nシナリオ失敗:", reason);
} finally {
  await browser.close();
  server.stop(true);
  rmSync(dataRoot, { recursive: true, force: true });
}
process.exit(failure === undefined ? 0 : 1);
