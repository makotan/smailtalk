/**
 * **未ログインの入口と、ログイン画面の専用の場所 `/apps/<id>/login`**(`V21-M4` / `ADR-0482` §5
 * `AN-G5` / ユーザ決定 `D-V21-8`・`D-V21-17`・`D-V21-18` / メインの裁定 `D-V21-20`)と、
 * **断られた取得を繰り返さないこと**(`V21-M4-T07` / 計画 §10-1 / 穴 `H-V21-15`)を実ブラウザで測る。
 *
 * - 入口 `/apps/<id>` → 並び順で最初の公開一覧画面(並び順の1番目は公開の詳細画面にして、
 *   2番目の一覧画面が出ることを見る)。
 * - 「ログイン」導線 → `/apps/<id>/login` → ログイン画面 → 画面のフォームで登録・ログイン →
 *   同じ URL のまま元のアプリ(ログイン済みの作業画面)。
 * - 公開画面の無いアプリの入口 → ログイン画面(今日どおり)。
 * - 未ログインで読めない表(401)の公開一覧画面を開いても、同じ URL への取得は1回。
 *
 * **配布の器は `web/e2e/runner-anonymous-entry.e2e.ts`。**
 */
import { type APIRequestContext, expect, test } from "@playwright/test";
import {
  countRequests,
  DENIED_VIEW,
  DETAIL_VIEW,
  installEntryViews,
  LIST_VIEW,
} from "./anonymous-entry-fixture.ts";
import { type FixtureApp, provisionApp } from "./fixture-app.ts";

async function provisionWithEntry(request: APIRequestContext): Promise<FixtureApp> {
  const app = await provisionApp(request);
  await installEntryViews(request, app.appId, app.manifest);
  await app.createRecord("categories", { name: "藻塩のなかま" });
  return app;
}

test.describe("未ログインの入口と /login(V21-M4 / AN-G5)", () => {
  test("入口は並び順で最初の公開一覧画面、導線は /apps/<id>/login、ログインすると元のアプリ", async ({
    page,
    request,
  }) => {
    const app = await provisionWithEntry(request);

    // **ブラウザに cookie を1つも入れない**(= 未ログイン)。
    await page.goto(`/apps/${app.appId}`);
    const workspace = page.getByTestId("anonymous-workspace");
    await expect(workspace).toBeVisible();
    await expect(page.getByTestId("login-page")).toHaveCount(0);
    await expect(workspace.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(workspace.locator('[aria-current="page"]')).toContainText("カテゴリ一覧(公開)");
    await expect(page.getByTestId("workspace-main")).toContainText("藻塩のなかま");

    const link = page.getByTestId("anonymous-login-link");
    await expect(link.locator("xpath=ancestor::a[1]")).toHaveAttribute(
      "href",
      `/apps/${app.appId}/login`,
    );
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/apps/${app.appId}/login$`));
    await expect(page.getByTestId("login-page")).toBeVisible();
    await expect(page.getByTestId("anonymous-workspace")).toHaveCount(0);

    // **画面のフォームで登録 → ログアウト → ログイン**(API のログインは使わない)。
    const username = `entry-${Date.now()}`;
    const password = "correct-horse-battery-staple";
    await page.getByTestId("auth-username").fill(username);
    await page.getByTestId("auth-password").fill(password);
    await page.getByTestId("password-register").click();
    await expect(page.getByTestId("view-list")).toBeVisible();
    await expect(page.getByTestId("current-user")).toHaveText(username);
    await page.getByTestId("logout").click();
    await expect(page.getByTestId("login-page")).toBeVisible();
    await page.getByTestId("auth-username").fill(username);
    await page.getByTestId("auth-password").fill(password);
    await page.getByTestId("password-login").click();
    // **ログインすると元のアプリ**(ログイン済みの作業画面。URL は /login のまま同じ表示)。
    await expect(page.getByTestId("view-list")).toBeVisible();
    await expect(page.getByTestId("current-user")).toHaveText(username);

    // **ログイン済みで /apps/<id>/login を開き直しても、/apps/<id> と同じ表示。**
    await page.goto(`/apps/${app.appId}/login`);
    await expect(page.getByTestId("view-list")).toBeVisible();
    await expect(page.getByTestId("login-page")).toHaveCount(0);
  });

  test("公開画面の無いアプリの入口はログイン画面(今日どおり)", async ({ page, request }) => {
    const app = await provisionApp(request);
    await page.goto(`/apps/${app.appId}`);
    await expect(page.getByTestId("login-page")).toBeVisible();
    await expect(page.getByTestId("anonymous-workspace")).toHaveCount(0);
  });

  test("読めない表(401)の公開一覧画面を開いても、同じ URL への取得は1回(T07)", async ({
    page,
    request,
  }) => {
    const app = await provisionWithEntry(request);
    const counts = await countRequests(
      page,
      async () => {
        await page.goto(`/apps/${app.appId}/views/${DENIED_VIEW}`);
        await expect(page.getByTestId("anonymous-workspace")).toBeVisible();
      },
      2500,
    );
    const tableRequests = Object.entries(counts).filter(([url]) => url.includes("/tables/items/"));
    expect(tableRequests.length, JSON.stringify(counts)).toBeGreaterThan(0);
    for (const [url, count] of tableRequests) {
      expect(count, url).toBe(1);
    }
    await expect(page.getByTestId("workspace-main")).not.toContainText(
      "サーバと通信できませんでした",
    );
  });
});

/**
 * **【`V22-M4-T08`】メニューに載せない公開画面(`menu_listed: false`)の未ログインの見え方**(`ADR-0494` §Decision 1。
 * 穴 `H-V22-1`。ユーザ決定 `D-V22-29`)。 計画 `V22-M4` 節の T08 の (1)(2)。 **配る版は
 * `web/e2e/runner-anonymous-entry.e2e.ts` の同じ名の検査**(T08 の (3))。
 *
 * 題材は上と同じ3枚(並び順: 詳細 → 一覧(公開) → 読めない表の一覧)で、**2枚目の一覧(公開)だけをメニューに載せない。**
 * 載せる公開の一覧画面の先頭は3枚目(読めない表の一覧。開くと 401 の断りが出る)になる。
 */
test.describe("未ログインのメニューに載せない公開画面(V22-M4-T08 / H-V22-1)", () => {
  async function provisionUnlisted(request: APIRequestContext): Promise<FixtureApp> {
    const app = await provisionApp(request);
    await installEntryViews(request, app.appId, app.manifest, {
      anonymous: true,
      unlisted: [LIST_VIEW],
    });
    await app.createRecord("categories", { name: "載せない棚のなかま" });
    return app;
  }

  test("(1) 入口は載せる公開の一覧画面の先頭で、載せない画面はメニューにもログイン画面のリンクにも無い", async ({
    page,
    request,
  }) => {
    const app = await provisionUnlisted(request);

    await page.goto(`/apps/${app.appId}`);
    const workspace = page.getByTestId("anonymous-workspace");
    await expect(workspace).toBeVisible();
    await expect(page.getByTestId("login-page")).toHaveCount(0);
    // 入口 = 載せる公開の一覧画面の先頭(読めない表の一覧)。 載せない「カテゴリ一覧(公開)」ではない。
    await expect(workspace.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(workspace.locator('[aria-current="page"]')).toContainText(
      "品目一覧(公開・読めない)",
    );
    // メニュー: 載せる2枚(詳細・読めない表の一覧)はあり、載せない1枚は無い。
    const menu = page.getByTestId("view-list");
    await expect(menu.locator(`a[href$="/views/${DETAIL_VIEW}"]`)).toHaveCount(1);
    await expect(menu.locator(`a[href$="/views/${DENIED_VIEW}"]`)).toHaveCount(1);
    await expect(menu.locator(`a[href$="/views/${LIST_VIEW}"]`)).toHaveCount(0);
    await expect(menu).not.toContainText("カテゴリ一覧(公開)");

    // ログイン画面の画面リンクにも無い。
    await page.goto(`/apps/${app.appId}/login`);
    await expect(page.getByTestId("login-page")).toBeVisible();
    const links = page.getByTestId("anonymous-views");
    await expect(links).toBeVisible();
    await expect(links.locator("li")).toHaveCount(2);
    await expect(links).toContainText("品目一覧(公開・読めない)");
    await expect(links).not.toContainText("カテゴリ一覧(公開)");
  });

  test("(2) 載せない画面も URL を直に開けば開く(メニューには出ず、現在地の印も無い)", async ({
    page,
    request,
  }) => {
    const app = await provisionUnlisted(request);

    await page.goto(`/apps/${app.appId}/views/${LIST_VIEW}`);
    const workspace = page.getByTestId("anonymous-workspace");
    await expect(workspace).toBeVisible();
    await expect(page.getByTestId("login-page")).toHaveCount(0);
    await expect(page.getByTestId("workspace-main")).toContainText("載せない棚のなかま");
    await expect(
      page.getByTestId("view-list").locator(`a[href$="/views/${LIST_VIEW}"]`),
    ).toHaveCount(0);
    await expect(workspace.locator('[aria-current="page"]')).toHaveCount(0);
  });
});
