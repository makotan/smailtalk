/**
 * **配布の器(`web/runner/dist`)の未ログインの入口と `/apps/<id>/login`**(`V21-M4` / `ADR-0482` §5-1
 * 「配布の器も同じにする」)と、**断られた取得を繰り返さないこと**(`V21-M4-T07`)を実ブラウザで測る。
 *
 * 器はビルド時にアプリID(`runner-e2e`)を焼き込むので、題材はそのアプリ1本である
 * (`web/e2e/runner-flow.e2e.ts` の冒頭の doc)。 **このアプリは他の検査と共有している** ——
 * **足した画面と規則は、終わりに元の定義を投げ直して外す**(表・項目は1つも足さない。行は
 * `categories` に1行足すが、他の検査は `categories` の行数を見ていない)。
 *
 * **育成用の版は `web/e2e/anonymous-entry.e2e.ts`。**
 */
import { expect, test } from "@playwright/test";
import type { Manifest } from "../../src/kernel/types.ts";
import {
  countRequests,
  DENIED_VIEW,
  DETAIL_VIEW,
  installEntryViews,
  LIST_VIEW,
} from "./anonymous-entry-fixture.ts";

/** `package.json` の `test:e2e` の `GP_RUNNER_APP_ID` と同じ綴り(`web/e2e/runner-flow.e2e.ts`)。 */
const RUNNER_APP_ID = "runner-e2e";
const port = Number(process.env.ST_E2E_PORT ?? 3210);
const runnerBase = `http://localhost:${port + 1}`;

test.describe("配布の器の未ログインの入口と /login(V21-M4 / AN-G5)", () => {
  test("入口は最初の公開一覧画面、導線は /apps/<id>/login、読めない表の取得は1回、ログイン済みの /login はアプリ", async ({
    page,
    request,
    context,
  }) => {
    const seeded = await request.post(`/__e2e__/apps/${RUNNER_APP_ID}/session`);
    expect(seeded.status(), await seeded.text()).toBe(201);
    const spec = (await seeded.json()) as { name: string; value: string; path: string };
    const headers = { cookie: `${spec.name}=${spec.value}` };
    const got = await request.get(`/api/apps/${RUNNER_APP_ID}/manifest`, { headers });
    expect(got.status(), await got.text()).toBe(200);
    // **定義(`app`)だけを持ち回る**(応答には兄弟キー `comment_visibility` が載り、差し替えの口は
    // それを 400 で弾く。`web/e2e/runner-flow.e2e.ts` の同じ注記)。
    const original: Manifest = { app: ((await got.json()) as Manifest).app };

    await installEntryViews(request, RUNNER_APP_ID, original);
    try {
      const created = await request.post(`/api/apps/${RUNNER_APP_ID}/tables/categories/records`, {
        data: { name: "器のなかま" },
        headers,
      });
      expect(created.status(), await created.text()).toBe(201);

      // **未ログイン**(cookie を入れていない)。
      await page.goto(`${runnerBase}/apps/${RUNNER_APP_ID}`);
      const workspace = page.getByTestId("anonymous-workspace");
      await expect(workspace).toBeVisible();
      await expect(page.getByTestId("login-page")).toHaveCount(0);
      await expect(workspace.locator('[aria-current="page"]')).toContainText("カテゴリ一覧(公開)");
      await expect(page.getByTestId("workspace-main")).toContainText("器のなかま");

      const link = page.getByTestId("anonymous-login-link");
      await expect(link.locator("xpath=ancestor::a[1]")).toHaveAttribute(
        "href",
        `/apps/${RUNNER_APP_ID}/login`,
      );
      await link.click();
      await expect(page).toHaveURL(`${runnerBase}/apps/${RUNNER_APP_ID}/login`);
      await expect(page.getByTestId("login-page")).toBeVisible();

      // **T07: 読めない表(401)の公開一覧画面でも、同じ URL への取得は1回。**
      const counts = await countRequests(
        page,
        async () => {
          await page.goto(`${runnerBase}/apps/${RUNNER_APP_ID}/views/${DENIED_VIEW}`);
          await expect(page.getByTestId("anonymous-workspace")).toBeVisible();
        },
        2500,
      );
      const tableRequests = Object.entries(counts).filter(([url]) =>
        url.includes("/tables/items/"),
      );
      expect(tableRequests.length, JSON.stringify(counts)).toBeGreaterThan(0);
      for (const [url, count] of tableRequests) {
        expect(count, url).toBe(1);
      }

      // **ログイン済みで /apps/<id>/login を開くと、/apps/<id> と同じ表示。**
      await context.addCookies([
        { name: spec.name, value: spec.value, url: `${runnerBase}${spec.path}` },
      ]);
      await page.goto(`${runnerBase}/apps/${RUNNER_APP_ID}/login`);
      await expect(page.getByTestId("current-user")).toBeVisible();
      await expect(page.getByTestId("login-page")).toHaveCount(0);
    } finally {
      // **未ログインの規則を外す**(共有のアプリなので、後に走る検査の前提 = 未ログインの入口は
      // ログイン画面、を戻す)。 **画面3枚は残る**(差し替えの口は画面の削除を受け付けない)。
      // 残る画面は運営の `owner` だけが開ける。
      await installEntryViews(request, RUNNER_APP_ID, original, { anonymous: false });
    }
  });
});

/**
 * **【`V22-M4-T08`】配る版でも、メニューに載せない公開画面は未ログインのメニューとログイン画面のリンクに出ず、
 * 入口は載せる公開の一覧画面の先頭で、URL を直に開けば開く**(`ADR-0494` §Decision 1 の 6。穴 `H-V22-1`)。
 * 計画 `V22-M4` 節の T08 の (3)。 育成用の版は `web/e2e/anonymous-entry.e2e.ts` の同じ名の検査。
 *
 * **共有のアプリなので、終わりに上の検査と同じ後始末をする**(未ログインの規則を外し、`menu_listed` も外す。
 * 画面3枚は上の検査が残すものと同じ ID なので、新しい画面は1枚も残さない)。
 */
test.describe("配る版の未ログインのメニューに載せない公開画面(V22-M4-T08 / H-V22-1)", () => {
  test("(3) 入口は載せる公開の一覧画面の先頭、載せない画面はメニューにもリンクにも無く、URL を直に開けば開く", async ({
    page,
    request,
  }) => {
    const seeded = await request.post(`/__e2e__/apps/${RUNNER_APP_ID}/session`);
    expect(seeded.status(), await seeded.text()).toBe(201);
    const spec = (await seeded.json()) as { name: string; value: string; path: string };
    const headers = { cookie: `${spec.name}=${spec.value}` };
    const got = await request.get(`/api/apps/${RUNNER_APP_ID}/manifest`, { headers });
    expect(got.status(), await got.text()).toBe(200);
    const current = ((await got.json()) as Manifest).app;
    // **上の検査が残した3枚とその画面の規則を外して持ち回る**(差し替えは同じ ID の画面を2枚持てない。
    // 同じ3枚と規則を足し直すので、規則が2重にならないよう外しておく)。
    const entryIds = new Set<string>([DETAIL_VIEW, LIST_VIEW, DENIED_VIEW]);
    const loose = current as unknown as {
      roles?: { id: string; name?: string; rules?: Record<string, unknown>[] }[];
    };
    const original: Manifest = {
      app: {
        ...current,
        views: current.views.filter((view) => !entryIds.has(view.id)),
        ...(loose.roles === undefined
          ? {}
          : {
              // 規則が0本になった役割は宣言しない(スキーマの `rules` は `minItems: 1`)。
              roles: loose.roles
                .map((role) => ({
                  ...role,
                  rules: (role.rules ?? []).filter(
                    (rule) => !(rule.target === "view" && entryIds.has(String(rule.view))),
                  ),
                }))
                .filter((role) => role.rules.length > 0),
            }),
      } as Manifest["app"],
    };

    await installEntryViews(request, RUNNER_APP_ID, original, {
      anonymous: true,
      unlisted: [LIST_VIEW],
    });
    try {
      const created = await request.post(`/api/apps/${RUNNER_APP_ID}/tables/categories/records`, {
        data: { name: "器の載せない棚" },
        headers,
      });
      expect(created.status(), await created.text()).toBe(201);

      // **未ログイン**(cookie を入れていない)。
      await page.goto(`${runnerBase}/apps/${RUNNER_APP_ID}`);
      const workspace = page.getByTestId("anonymous-workspace");
      await expect(workspace).toBeVisible();
      await expect(page.getByTestId("login-page")).toHaveCount(0);
      await expect(workspace.locator('[aria-current="page"]')).toHaveCount(1);
      await expect(workspace.locator('[aria-current="page"]')).toContainText(
        "品目一覧(公開・読めない)",
      );
      const menu = page.getByTestId("view-list");
      await expect(menu.locator(`a[href$="/views/${DETAIL_VIEW}"]`)).toHaveCount(1);
      await expect(menu.locator(`a[href$="/views/${DENIED_VIEW}"]`)).toHaveCount(1);
      await expect(menu.locator(`a[href$="/views/${LIST_VIEW}"]`)).toHaveCount(0);
      await expect(menu).not.toContainText("カテゴリ一覧(公開)");

      // ログイン画面の画面リンク。
      await page.goto(`${runnerBase}/apps/${RUNNER_APP_ID}/login`);
      await expect(page.getByTestId("login-page")).toBeVisible();
      const links = page.getByTestId("anonymous-views");
      await expect(links).toBeVisible();
      await expect(links.locator("li")).toHaveCount(2);
      await expect(links).toContainText("品目一覧(公開・読めない)");
      await expect(links).not.toContainText("カテゴリ一覧(公開)");

      // URL を直に開けば開く。
      await page.goto(`${runnerBase}/apps/${RUNNER_APP_ID}/views/${LIST_VIEW}`);
      await expect(page.getByTestId("anonymous-workspace")).toBeVisible();
      await expect(page.getByTestId("workspace-main")).toContainText("器の載せない棚");
      await expect(
        page.getByTestId("view-list").locator(`a[href$="/views/${LIST_VIEW}"]`),
      ).toHaveCount(0);
      await expect(
        page.getByTestId("anonymous-workspace").locator('[aria-current="page"]'),
      ).toHaveCount(0);
    } finally {
      await installEntryViews(request, RUNNER_APP_ID, original, { anonymous: false });
    }
  });
});
