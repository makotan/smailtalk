/**
 * **下見の画面を chromium で開く**(`V20-M13-T02c`。計画 `docs/plan/v20/15-v20-m13-plan.md` §9-6 / §10-4 /
 * §10-8 / §10-9 の 19、ユーザ決定 `D-V20-43` / `D-V20-45` / `D-V20-46`)。
 *
 * 下見は E2E の中で **MCP の `dry_run_diff`(`preview` 引数つき)** を呼んで作る(`preview-fixture.ts`。
 * 置き場の根は fixture-server の一時ディレクトリの隣で、終わるときに消える)。
 *
 * | # | 何を測るか |
 * |---|---|
 * | (1) | 実データの下見を**未ログイン**で開く → 適用後の姿(差分で足した列・変えた画面の名前・実データの行)と帯(「下見(適用前)」「期限 HH:MM」)。ログイン画面に落ちない・401 が1本も無い |
 * | (2) | 見本の下見 → 帯に「見本のデータで表示中」、一覧に「見本 1」、実データの目印が出ない |
 * | (3) | 下見でフォームの保存と詳細の削除を押す → 「下見なので保存されません」、「権限がありません(閲覧のみ)」は出ない。本体も写しも行数が変わらない |
 * | (4) | 期限切れ(置き場を消す)→ 開き直すと / 開いたまま押すと「この下見は期限切れです」 |
 * | (5) | 陰性対照: 本物のアプリの画面には帯も `meta referrer` も無い |
 * | (6) | 暗い表示で帯の文字と地色の比が本文の閾値(4.5)以上(`src/kernel/theme-contrast.ts` の `contrastRatio`) |
 * | (7) | 下見の画面から外へのリンクを踏んでも `Referer` が送られない(陰性対照: 本物の画面では送られる) |
 *
 * **撮った画面**は環境変数 `ST_E2E_SHOT_DIR` があるときだけそこへ書く(検査の合否には使わない)。
 */
import { join } from "node:path";
import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";
import { contrastRatio } from "../../src/kernel/theme-contrast.ts";
import type { Diff } from "../../src/kernel/types.ts";
import { type FixtureApp, provisionApp } from "./fixture-app.ts";

const READ_ONLY = "下見なので保存されません";
const EXPIRED = "この下見は期限切れです";
const REAL_MARK = "実データの印";

type Preview = { url: string; expires_at: string; mode: "real" | "sample" };

const PREVIEW_DIFF: Diff = {
  diff_id: "d-v20-m13-t02c-e2e",
  intent: "備品に置き場所を持たせ、一覧で見たい",
  operations: [
    {
      op: "add_field",
      table: "items",
      field: { id: "location", name: "置き場所", type: "text" },
    },
    {
      op: "update_view",
      view: "item-list",
      changes: { name: "備品一覧(下見)", columns: ["name", "location", "quantity"] },
    },
  ],
};

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.ST_E2E_SHOT_DIR;
  if (dir !== undefined && dir !== "") {
    await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
  }
}

async function createPreview(
  request: APIRequestContext,
  app: FixtureApp,
  mode: "real" | "sample",
): Promise<Preview> {
  const response = await request.post(`/__e2e__/apps/${app.appId}/preview`, {
    data: { mode, diff: PREVIEW_DIFF },
  });
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as {
    is_error: boolean;
    result: { preview?: Preview } | null;
    content: unknown;
  };
  expect(body.is_error, JSON.stringify(body.content)).toBe(false);
  const preview = body.result?.preview;
  if (preview === undefined) {
    throw new Error(`下見が作られなかった: ${JSON.stringify(body)}`);
  }
  expect(preview.mode).toBe(mode);
  return preview;
}

async function seedRealRows(app: FixtureApp): Promise<string[]> {
  const ids: string[] = [];
  for (const [index, quantity] of [3, 1].entries()) {
    ids.push(
      await app.createRecord("items", {
        name: `${REAL_MARK}-${index + 1}`,
        quantity,
        in_use: true,
        purchased_at: "2026-09-01",
      }),
    );
  }
  return ids;
}

async function realRowCount(request: APIRequestContext, app: FixtureApp): Promise<number> {
  const response = await request.get(`/api/apps/${app.appId}/tables/items/records`, {
    headers: app.authHeaders,
  });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { records: unknown[] }).records.length;
}

/** 下見の写しの行数(未ログインの要求。前段が頼んだ人のセッションを付ける)。 */
async function previewRowCount(request: APIRequestContext, preview: Preview): Promise<number> {
  const previewAppId = previewAppIdOf(preview);
  const response = await request.get(`/api/apps/${previewAppId}/tables/items/records`, {
    headers: { cookie: "" },
  });
  expect(response.status()).toBe(200);
  expect(response.headers()["x-smailtalk-preview"]).toContain(`mode=${preview.mode}`);
  return ((await response.json()) as { records: unknown[] }).records.length;
}

function previewAppIdOf(preview: Preview): string {
  const matched = /\/apps\/(pv-[0-9a-f]{32})\/$/.exec(preview.url);
  if (matched === null) {
    throw new Error(`下見の URL の形が違う: ${preview.url}`);
  }
  return matched[1] as string;
}

/** 期限の HH:MM(ブラウザの時計で組む。画面と同じ規則)。 */
async function deadlineInBrowser(page: Page, expiresAt: string): Promise<string> {
  return await page.evaluate((iso) => {
    const at = new Date(iso);
    return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  }, expiresAt);
}

/** 計算値 `rgb(r, g, b)` を `#rrggbb` に写す(形が違えば元のまま)。 */
function rgbToHex(value: string): string {
  const matched = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(value);
  if (matched === null) return value;
  return `#${matched
    .slice(1, 4)
    .map((channel) => Number(channel).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** クッキーを1つも持たないブラウザの頁(= 未ログイン)。 */
async function anonymousPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  expect(await context.cookies()).toEqual([]);
  return await context.newPage();
}

test("(1) 実データの下見を未ログインで開くと、適用後の姿と帯が見える(ログイン画面に落ちない)", async ({
  browser,
  request,
}) => {
  const app = await provisionApp(request);
  await seedRealRows(app);
  const preview = await createPreview(request, app, "real");
  const page = await anonymousPage(browser);
  const statuses: number[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/apps/pv-")) statuses.push(response.status());
  });
  await page.goto(`${preview.url}views/item-list`);

  const banner = page.getByTestId("preview-banner");
  await expect(banner).toBeVisible();
  const hhmm = await deadlineInBrowser(page, preview.expires_at);
  await expect(banner).toHaveText(`下見(適用前)。保存されません。期限 ${hhmm}`);
  await expect(banner).toHaveAttribute("data-preview-mode", "real");
  // 帯は上端(画面の器の最初の子)。
  expect(
    await page.evaluate(() =>
      document.querySelector("main.shell")?.firstElementChild?.getAttribute("data-testid"),
    ),
  ).toBe("preview-banner");
  // 適用後の姿: 差分で足した列・変えた画面の名前・実データの行。
  const list = page.getByTestId("list-table");
  await expect(list).toContainText("置き場所");
  await expect(list).toContainText(`${REAL_MARK}-1`);
  await expect(page.getByTestId("view-list")).toContainText("備品一覧(下見)");
  // ログイン画面に落ちない。401 は1本も無い。
  await expect(page.getByTestId("login-page")).toHaveCount(0);
  expect(statuses.filter((status) => status === 401)).toEqual([]);
  expect(statuses.length).toBeGreaterThan(0);
  // Referer を送らない指定が在る。
  expect(
    await page.evaluate(
      () => document.head.querySelector('meta[name="referrer"]')?.getAttribute("content") ?? null,
    ),
  ).toBe("no-referrer");
  await shot(page, "preview-real-list");
  await page.context().close();
});

test("(2) 見本の下見では、帯に「見本のデータで表示中」、一覧に見本の行が出て、実データの目印は出ない", async ({
  browser,
  request,
}) => {
  const app = await provisionApp(request);
  await seedRealRows(app);
  const preview = await createPreview(request, app, "sample");
  const page = await anonymousPage(browser);
  await page.goto(`${preview.url}views/item-list`);

  const banner = page.getByTestId("preview-banner");
  await expect(banner).toBeVisible();
  const hhmm = await deadlineInBrowser(page, preview.expires_at);
  await expect(banner).toContainText(`下見(適用前)。保存されません。期限 ${hhmm}`);
  await expect(page.getByTestId("preview-banner-sample")).toHaveText("見本のデータで表示中");
  await expect(banner).toHaveAttribute("data-preview-mode", "sample");
  const list = page.getByTestId("list-table");
  await expect(list).toContainText("見本 1");
  await expect(list).toContainText("置き場所");
  await expect(page.locator("body")).not.toContainText(REAL_MARK);
  await shot(page, "preview-sample-list");
  await page.context().close();
});

test("(3) 下見で保存と削除を押すと「下見なので保存されません」が出て、本体も写しも変わらない", async ({
  browser,
  request,
}) => {
  const app = await provisionApp(request);
  const [firstId] = await seedRealRows(app);
  const preview = await createPreview(request, app, "real");
  const realBefore = await realRowCount(request, app);
  const copyBefore = await previewRowCount(request, preview);
  expect(realBefore).toBe(2);
  expect(copyBefore).toBe(2);

  const page = await anonymousPage(browser);
  // フォームの保存。
  await page.goto(`${preview.url}views/item-form`);
  await expect(page.getByTestId("preview-banner")).toBeVisible();
  const form = page.getByTestId("view-renderer-form");
  await form.locator("input").first().fill("下見で保存しようとした行");
  await form.locator('input[type="number"]').first().fill("5");
  const save = form.getByRole("button", { name: "保存" });
  await expect(save).toBeVisible();
  await save.click();
  await expect(form).toContainText(READ_ONLY);
  await expect(page.locator("body")).not.toContainText("権限がありません(閲覧のみ)");
  await shot(page, "preview-save-refused");

  // 詳細の削除。
  await page.goto(`${preview.url}views/item-detail/records/${firstId}`);
  await page.getByTestId("detail-delete").click();
  await page.getByTestId("detail-delete-execute").click();
  await expect(page.getByTestId("detail-errors")).toContainText(READ_ONLY);
  await expect(page.locator("body")).not.toContainText("権限がありません(閲覧のみ)");
  await shot(page, "preview-delete-refused");

  expect(await realRowCount(request, app)).toBe(realBefore);
  expect(await previewRowCount(request, preview)).toBe(copyBefore);
  await page.context().close();
});

test("(4) 期限切れ(置き場を消す)の後は「この下見は期限切れです」が出る(開き直しても、開いたまま押しても)", async ({
  browser,
  request,
}) => {
  const app = await provisionApp(request);
  const [firstId] = await seedRealRows(app);
  const preview = await createPreview(request, app, "real");
  const page = await anonymousPage(browser);
  // 開いたまま期限が切れる。
  await page.goto(`${preview.url}views/item-detail/records/${firstId}`);
  await expect(page.getByTestId("preview-banner")).toBeVisible();
  // **【`V20-M14-T04E`】詳細の削除ボタンが描かれるまで待ってから期限を切る。** 帯は写しの最初の読み物
  // (`/auth/me`)の応答で出るので、帯が見えた時点では行の読み物がまだ飛んでいないことがある。 そこで
  // 期限を切ると行の読み物が 410 になり、削除ボタンが出ないまま落ちる(記録 `v20-m14-t04e.md` §5)。
  await expect(page.getByTestId("detail-delete")).toBeVisible();
  const expire = await request.post(`/__e2e__/previews/${previewAppIdOf(preview)}/expire`);
  expect(expire.status(), await expire.text()).toBe(200);
  await page.getByTestId("detail-delete").click();
  await page.getByTestId("detail-delete-execute").click();
  await expect(page.getByTestId("preview-expired")).toContainText(EXPIRED);
  await expect(page.getByTestId("preview-banner")).toHaveCount(0);
  // 開き直す。
  await page.goto(`${preview.url}views/item-list`);
  await expect(page.getByTestId("preview-expired")).toContainText(EXPIRED);
  await expect(page.getByTestId("login-page")).toHaveCount(0);
  await expect(page.getByTestId("list-table")).toHaveCount(0);
  await shot(page, "preview-expired");
  await page.context().close();
});

test("(5) 陰性対照: 本物のアプリの画面には帯も meta referrer も出ない", async ({
  context,
  page,
  request,
}) => {
  const app = await provisionApp(request);
  await seedRealRows(app);
  await createPreview(request, app, "real");
  await app.authenticate(context);
  await page.goto(`/apps/${app.appId}/views/item-list`);
  await expect(page.getByTestId("list-table")).toContainText(`${REAL_MARK}-1`);
  await expect(page.getByTestId("preview-banner")).toHaveCount(0);
  expect(
    await page.evaluate(() => document.head.querySelector('meta[name="referrer"]') === null),
  ).toBe(true);
  // 本物の画面は下見の変更を持たない(列「置き場所」が無い)。
  await expect(page.getByTestId("list-table")).not.toContainText("置き場所");
  await shot(page, "real-app-no-banner");
});

test("(6) 暗い表示でも帯が読める(文字と地色の比が本文の閾値 4.5 以上。明るい表示も同じ)", async ({
  browser,
  request,
}) => {
  const app = await provisionApp(request);
  const preview = await createPreview(request, app, "real");
  const results: Record<string, { background: string; text: string; ratio: number | null }> = {};
  for (const scheme of ["dark", "light"] as const) {
    const context = await browser.newContext({ colorScheme: scheme });
    const page = await context.newPage();
    await page.goto(`${preview.url}views/item-list`);
    const banner = page.getByTestId("preview-banner");
    await expect(banner).toBeVisible();
    const colors = await banner.evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, text: style.color };
    });
    // `contrastRatio` が読む表記(16進)に写す(計算値は `rgb(…)` で来る)。
    const ratio = contrastRatio(rgbToHex(colors.text), rgbToHex(colors.background));
    results[scheme] = { ...colors, ratio };
    await shot(page, `preview-banner-${scheme}`);
    await context.close();
  }
  // 暗い既定(`#1f1f1f` の上に `#e6e6e6`)と明るい既定(`#f2f2f2` の上に `#000`)。
  expect(results.dark?.background).toBe("rgb(31, 31, 31)");
  expect(results.dark?.text).toBe("rgb(230, 230, 230)");
  expect(results.light?.background).toBe("rgb(242, 242, 242)");
  expect(results.light?.text).toBe("rgb(0, 0, 0)");
  expect(results.dark?.ratio ?? 0).toBeGreaterThanOrEqual(4.5);
  expect(results.light?.ratio ?? 0).toBeGreaterThanOrEqual(4.5);
});

test("(7) 下見の画面から外へのリンクを踏んでも Referer が送られない(本物の画面では送られる)", async ({
  browser,
  request,
}) => {
  const app = await provisionApp(request);
  await seedRealRows(app);
  const preview = await createPreview(request, app, "real");
  const EXTERNAL = "https://referrer-probe.example/landing";

  async function refererAfterClick(page: Page): Promise<string | null> {
    let referer: string | null | undefined;
    await page.context().route("https://referrer-probe.example/**", async (route) => {
      referer = route.request().headers().referer ?? null;
      await route.fulfill({ status: 200, contentType: "text/html", body: "<p>外</p>" });
    });
    await page.evaluate((href) => {
      const link = document.createElement("a");
      link.href = href;
      link.textContent = "外へのリンク";
      link.id = "external-probe";
      document.body.appendChild(link);
    }, EXTERNAL);
    await page.click("#external-probe");
    await page.waitForURL(EXTERNAL);
    return referer ?? null;
  }

  const previewPage = await anonymousPage(browser);
  await previewPage.goto(`${preview.url}views/item-list`);
  await expect(previewPage.getByTestId("preview-banner")).toBeVisible();
  expect(await refererAfterClick(previewPage)).toBeNull();
  await previewPage.context().close();

  // 陰性対照: 本物のアプリの画面(meta referrer 無し)からは送られる。
  const realContext = await browser.newContext();
  await app.authenticate(realContext);
  const realPage = await realContext.newPage();
  await realPage.goto(`/apps/${app.appId}/views/item-list`);
  await expect(realPage.getByTestId("list-table")).toBeVisible();
  const realReferer = await refererAfterClick(realPage);
  expect(realReferer).not.toBeNull();
  expect(realReferer ?? "").toContain("localhost");
  await realContext.close();
});

test("(8) 下見の画面の上端に頼んだ人のログイン名が出ない(「下見」と出る。役割の印は残る)", async ({
  browser,
  request,
}) => {
  // **【`V20-M13` 点検の処置 軽2】** 前段が転送する `/auth/me` の `username` と `displayName` を
  // 固定の文言に置き換える。 頼んだ人のログイン名は `preview-requester-<N>`(`preview-fixture.ts`)。
  const app = await provisionApp(request);
  await seedRealRows(app);
  const preview = await createPreview(request, app, "real");
  const page = await anonymousPage(browser);
  await page.goto(`${preview.url}views/item-list`);
  await expect(page.getByTestId("preview-banner")).toBeVisible();
  await expect(page.getByTestId("list-table")).toContainText(`${REAL_MARK}-1`);
  await expect(page.getByTestId("current-user")).toHaveText("下見");
  await expect(page.getByTestId("current-role")).toHaveAttribute("data-role", "owner");
  await expect(page.locator("body")).not.toContainText("preview-requester");
  await shot(page, "preview-requester-hidden");
  await page.context().close();
});
