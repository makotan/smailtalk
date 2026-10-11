/**
 * **メニューの位置(左 / 上)と、上に置いたときの折りたたみ**を実ブラウザで測る(`V22-M2-T08`)。
 *
 * 計画の正は `docs/plan/v22/00-v22-plan.md` の T08 の行、決まりは `ADR-0486` §Decision 1 の 11
 * (ユーザ決定 `D-V22-9`〜`D-V22-12`)。 **判定は計算値と DOM の位置で行う**(happy-dom は CSS を計算しない)。
 *
 * | # | 何を測るか |
 * |---|---|
 * | (1) | 上に置いたアプリを 1280px で開くと、項目が横一列に並び、「≡ メニュー」は見えない |
 * | (2) | 360px では常に「≡ メニュー」(項目が2つでも)。 押すと浮かせた一覧が開き、その地色・文字色はテーマの値(明るい・暗い `slots_dark` の両方)。 Escape で閉じてフォーカスが「≡」に戻る。 項目を選ぶと移り、`aria-current` が付く |
 * | (3) | 項目が多いと 1280px でも「≡ メニュー」に畳む |
 * | (4) | 本文は左のときより広く、外枠の幅 60rem(960px)を超えない(画面の端まで広がらない。`D-V22-12`) |
 * | (5) | 役割の上書き: 2つの役割でログインすると位置が違う |
 * | (6) | 未ログイン(公開の画面)はアプリの既定に従う |
 * | (7) | 配る版でも宣言した位置になる |
 * | (8) | `POST /undo` で `set_workspace` を取り消すと左に戻る |
 * | (9) | 外枠(`.shell`)には何も漏れない(器も浮かせた一覧も `.app-theme` の内側) |
 *
 * ## 証明しないこと(誇張しない)
 *
 * - **読み上げの実物は聞いていない**(役割 `menu` / `menuitem` の DOM を見るだけ。代償は `ADR-0486` §3 の 2)。
 * - **見やすさ・ピクセルは比べない**(計算値と位置だけ)。
 * - **640px ちょうど前後の境目は測っていない**(360px と 1280px の2点だけ)。
 */
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import type { Diff, Manifest } from "../../src/kernel/types.ts";
import { type FixtureApp, provisionApp, seedRoleSession } from "./fixture-app.ts";

/** ブラウザがアクセスする育成用の版の port(`playwright.config.ts` と同じ既定値)。 */
const port = Number(process.env.ST_E2E_PORT ?? 3210);
/** 配る版の port は育成用の版の隣(`web/e2e/fixture-server.ts` と同じ組み方)。 */
const runnerBase = `http://localhost:${port + 1}`;
/** 配る版が描くアプリのID(`package.json` の `test:e2e` と `fixture-server.ts` と同じ綴り)。 */
const RUNNER_APP_ID = "runner-e2e";

/** 外枠の幅(`--shell-max-width` = 60rem)。 */
const SHELL_MAX_PX = 960;

const WIDE = { width: 1280, height: 800 };
const NARROW = { width: 360, height: 800 };

/** 明るい側の組(`web/e2e/color-scheme.e2e.ts` と同じ値。浮かせた一覧の色だけ本文と変えた)。 */
const SLOTS: Record<string, string> = {
  body_text: "#1a237e",
  secondary_text: "#37474f",
  label_text: "#4a148c",
  placeholder_text: "#5d4037",
  danger: "#b00020",
  page_background: "#fff8e1",
  highlight_surface: "#ffecb3",
  primary_fill: "#fff8e1",
  on_primary: "#1a237e",
  overlay_background: "#ffecb3",
  overlay_text: "#1a237e",
  border_color: "#6d4c41",
  focus_ring: "#00695c",
  body_font: "Georgia, serif",
  secondary_font_size: "12px",
  note_font_size: "13px",
  body_line_height: "2",
  space_1: "2px",
  space_2: "4px",
  space_3: "6px",
  space_4: "8px",
  space_5: "10px",
  space_6: "12px",
  border_width: "3px",
  control_radius: "5px",
  surface_shadow: "0 2px 6px #000000",
  focus_ring_width: "4px",
};

/** 暗い側の組(`color-scheme.e2e.ts` と同じ色。浮かせた一覧の地色だけ本文と変えた)。 */
const SLOTS_DARK: Record<string, string> = {
  ...SLOTS,
  body_text: "#f5f5f5",
  secondary_text: "#c8d8e8",
  label_text: "#ffd54a",
  placeholder_text: "#b0b8c0",
  danger: "#ff9a8a",
  page_background: "#102030",
  highlight_surface: "#243447",
  primary_fill: "#102030",
  on_primary: "#f5f5f5",
  overlay_background: "#243447",
  overlay_text: "#f5f5f5",
  border_color: "#8fa3b8",
  focus_ring: "#7fd4ff",
};

/** `SLOTS` / `SLOTS_DARK` の浮かせた一覧の色の計算値。 */
const MENU_LIGHT = { background: "rgb(255, 236, 179)", color: "rgb(26, 35, 126)" };
const MENU_DARK = { background: "rgb(36, 52, 71)", color: "rgb(245, 245, 245)" };

type Navigation = {
  placement?: "side" | "top";
  by_role?: { role: string; placement: "side" | "top" }[];
};

async function postDiff(
  request: APIRequestContext,
  appId: string,
  headers: { cookie: string },
  diff: Diff,
): Promise<void> {
  const applied = await request.post(`/api/apps/${appId}/diffs`, { data: diff, headers });
  expect(applied.status(), await applied.text()).toBe(201);
}

function workspaceDiff(diffId: string, navigation: Navigation | null): Diff {
  return {
    diff_id: diffId,
    intent: "メニューの置き場所を変えたい、という要望に応えた",
    operations: [
      {
        op: "set_workspace",
        // 【`V22-M3-T02` / `ADR-0488` §Decision 2 の 6(授権 `ADR-0489` 行24)】`{}` は断られるようになったので、
        // 宣言を消すのは `{ navigation: null }` である。 旧の行(逐語): `workspace: navigation === null ? {} : { navigation },`
        workspace: navigation === null ? { navigation: null } : { navigation },
      },
    ],
  } as unknown as Diff;
}

async function setNavigation(
  request: APIRequestContext,
  app: FixtureApp,
  navigation: Navigation,
  diffId = "workspace-top",
): Promise<void> {
  await postDiff(request, app.appId, app.authHeaders, workspaceDiff(diffId, navigation));
}

async function setTheme(request: APIRequestContext, app: FixtureApp): Promise<void> {
  await postDiff(request, app.appId, app.authHeaders, {
    diff_id: "workspace-theme",
    intent: "アプリの配色を決めたい、という要望に応えてテーマを設定した",
    operations: [{ op: "set_theme", theme: { slots: SLOTS, slots_dark: SLOTS_DARK } }],
  } as unknown as Diff);
}

/** 払い出したアプリの画面(並び順)。 */
function viewIdsOf(manifest: Manifest): string[] {
  return manifest.app.views.map((view) => view.id);
}

async function openSignedIn(page: Page, app: FixtureApp, viewId?: string): Promise<void> {
  await app.authenticate(page.context());
  await page.goto(
    viewId === undefined ? `/apps/${app.appId}` : `/apps/${app.appId}/views/${viewId}`,
  );
  await expect(page.getByTestId("view-list")).toBeVisible();
}

/** 上に置いた一覧の項目の上端(px)。 横一列なら全部同じ。 */
async function itemTops(page: Page): Promise<number[]> {
  return await page
    .getByTestId("view-list-items")
    .locator(":scope > li")
    .evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().top)));
}

async function mainWidth(page: Page): Promise<number> {
  return await page
    .getByTestId("workspace-main")
    .evaluate((element) => element.getBoundingClientRect().width);
}

async function menuColors(page: Page): Promise<{ background: string; color: string }> {
  return await page.locator('[data-slot="overlay-menu"]').evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, color: style.color };
  });
}

/** `.app-theme` の外に出た「メニューの器」「浮かせた一覧」と、`.shell` に付いた属性。 */
async function leakage(page: Page) {
  return await page.evaluate(() => {
    const scope = document.querySelector(".app-theme");
    const marked = [
      ...document.querySelectorAll(
        '[data-navigation-placement], [data-slot="overlay-menu"], [data-testid="view-menu-item"]',
      ),
    ];
    const shell = document.querySelector(".shell");
    return {
      marked: marked.length,
      outside: marked.filter((element) => scope === null || !scope.contains(element)).length,
      onShell: (shell?.getAttributeNames() ?? []).filter(
        (name) => name.startsWith("data-navigation") || name === "data-slot",
      ).length,
      /** 外枠の属性の全部(名前=値)。 左のときと上のときで同じであることを見る。 */
      shellAttributes: (shell?.getAttributeNames() ?? []).map(
        (name) => `${name}=${shell?.getAttribute(name) ?? ""}`,
      ),
    };
  });
}

/**
 * **公開の画面を2枚だけ足す**(`web/e2e/anonymous-entry-fixture.ts` と同じ作り。 表は1つも足さない)。
 * 未ログインが読めるのはこの2枚だけなので、未ログインの一覧は2項目になる。
 */
const PUBLIC_LIST = "nav-public-list";
const PUBLIC_DETAIL = "nav-public-detail";
async function installTwoPublicViews(request: APIRequestContext, app: FixtureApp): Promise<void> {
  const next = structuredClone(app.manifest);
  const loose = next.app as unknown as {
    roles?: { id: string; name?: string; rules?: Record<string, unknown>[] }[];
  };
  next.app.views = [
    ...next.app.views,
    {
      id: PUBLIC_LIST,
      name: "カテゴリ一覧(公開)",
      type: "list_view",
      table: "categories",
      columns: ["name"],
    },
    { id: PUBLIC_DETAIL, name: "カテゴリの詳細(公開)", type: "detail_view", table: "categories" },
  ] as Manifest["app"]["views"];
  const roles = loose.roles ?? [];
  const push = (roleId: string, rules: Record<string, unknown>[]): void => {
    const found = roles.find((role) => role.id === roleId);
    if (found === undefined) {
      roles.push({ id: roleId, name: roleId, rules });
      return;
    }
    found.rules = [...(found.rules ?? []), ...rules];
  };
  const views = [PUBLIC_LIST, PUBLIC_DETAIL];
  push(
    "owner",
    views.map((view) => ({ target: "view", view, can: ["read"] })),
  );
  push("anonymous", [
    ...views.map((view) => ({ target: "view", view, can: ["read"] })),
    { target: "table", table: "categories", can: ["read"] },
  ]);
  loose.roles = roles;
  const replaced = await request.post(`/__e2e__/apps/${app.appId}/manifest`, { data: next });
  expect(replaced.status(), await replaced.text()).toBe(200);
}

test.describe("V22-M2-T08 メニューの位置と折りたたみ(chromium 実測)", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "計算値の期待値は chromium の値である(`color-scheme.e2e.ts` と同じ理由)",
  );

  test("(1)(4)(9) 1280px: 上に置くと横一列で ≡ は出ず、本文は左のときより広く 960px を超えない。.shell に漏れない", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await page.setViewportSize(WIDE);
    const [first] = viewIdsOf(app.manifest);

    // --- 左(宣言なし): 今日の姿。本文の幅を測っておく ---
    await openSignedIn(page, app, first);
    await expect(page.locator("[data-navigation-placement]")).toHaveCount(0);
    await expect(page.locator(".workspace-body")).toHaveCount(1);
    const sideWidth = await mainWidth(page);
    const sideShell = (await leakage(page)).shellAttributes;

    // --- 上に置く ---
    await setNavigation(request, app, { placement: "top" });
    await page.reload();
    const frame = page.locator('[data-navigation-placement="top"]');
    await expect(frame).toHaveCount(1);
    await expect(page.locator(".workspace-body")).toHaveCount(0);
    const items = page.getByTestId("view-list-items");
    await expect(items).toBeVisible();
    await expect(items.locator(":scope > li")).toHaveCount(viewIdsOf(app.manifest).length);
    // (1) 横一列(項目の上端がすべて同じ)で、「≡ メニュー」は見えない。
    const tops = await itemTops(page);
    console.log(`[workspace-navigation (1)] tops=${JSON.stringify(tops)}`);
    expect(new Set(tops).size).toBe(1);
    await expect(page.getByTestId("view-menu-toggle")).toBeHidden();
    // いま開いている画面の項目に aria-current。
    await expect(items.locator(':scope > li[aria-current="page"]')).toHaveCount(1);

    // (4) 本文は左のときより広く、外枠 960px を超えない(画面の端まで広がらない)。
    const topWidth = await mainWidth(page);
    console.log(`[workspace-navigation (4)] side=${sideWidth} top=${topWidth}`);
    expect(topWidth).toBeGreaterThan(sideWidth);
    expect(topWidth).toBeLessThanOrEqual(SHELL_MAX_PX);
    expect(topWidth).toBeLessThan(WIDE.width);

    // (9) 器は .app-theme の内側だけ。.shell には何も付かない。
    const leaked = await leakage(page);
    console.log(`[workspace-navigation (9)] ${JSON.stringify(leaked)}`);
    expect(leaked.marked).toBeGreaterThan(0);
    expect(leaked.outside).toBe(0);
    expect(leaked.onShell).toBe(0);
    // 外枠の属性は左のときと1つも変わらない(クラスも含めて)。
    expect(leaked.shellAttributes).toEqual(sideShell);
  });

  test("(2)(9) 360px: 常に ≡。浮かせた一覧はテーマの色(明るい・暗い)、Escape で閉じてフォーカスが戻り、選ぶと移って aria-current が付く", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await setTheme(request, app);
    await setNavigation(request, app, { placement: "top" });
    const views = viewIdsOf(app.manifest);
    const [first] = views;
    const last = views[views.length - 1];

    await page.setViewportSize(NARROW);
    await page.emulateMedia({ colorScheme: "light" });
    await openSignedIn(page, app, first);
    await expect(page.locator('[data-navigation-placement="top"]')).toHaveCount(1);
    const toggle = page.getByTestId("view-menu-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).toContainText("メニュー");
    await expect(page.getByTestId("view-list-items")).toBeHidden();

    // --- 開く → 浮かせた一覧(明るい側の色)---
    const popup = page.locator('[data-slot="overlay-menu"]');
    await toggle.click();
    await expect(popup).toBeVisible();
    await expect(page.getByTestId("view-menu-item")).toHaveCount(views.length);
    const light = await menuColors(page);
    console.log(`[workspace-navigation (2)] light=${JSON.stringify(light)}`);
    expect(light).toEqual(MENU_LIGHT);
    // (9) 開いた一覧も .app-theme の内側。
    const leaked = await leakage(page);
    expect(leaked.outside).toBe(0);
    expect(leaked.onShell).toBe(0);

    // --- Escape で閉じ、フォーカスは ≡ に戻る ---
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await expect(toggle).toBeFocused();

    // --- 暗い側(slots_dark)---
    await page.emulateMedia({ colorScheme: "dark" });
    await toggle.click();
    await expect(popup).toBeVisible();
    const dark = await menuColors(page);
    console.log(`[workspace-navigation (2)] dark=${JSON.stringify(dark)}`);
    expect(dark).toEqual(MENU_DARK);
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await expect(toggle).toBeFocused();

    // --- 項目を選ぶと移り、aria-current が付く ---
    await toggle.click();
    await page
      .getByTestId("view-menu-item")
      .nth(views.length - 1)
      .click();
    await expect(page).toHaveURL(new RegExp(`/apps/${app.appId}/views/${last}$`));
    await expect(popup).toHaveCount(0);
    await page.getByTestId("view-menu-toggle").click();
    const current = page.locator('[data-testid="view-menu-item"][aria-current="page"]');
    await expect(current).toHaveCount(1);
    expect(
      await page
        .getByTestId("view-menu-item")
        .evaluateAll((elements) =>
          elements.findIndex((element) => element.getAttribute("aria-current") === "page"),
        ),
    ).toBe(views.length - 1);
  });

  test("(3) 項目が多いと 1280px でも ≡ に畳む", async ({ page, request }) => {
    const app = await provisionApp(request);
    // 名前の長い一覧を24枚足す(表は足さない。規則は fixture-server が運営3役割へ配る)。
    const next = structuredClone(app.manifest);
    for (let index = 0; index < 24; index += 1) {
      next.app.views.push({
        id: `nav-many-${index}`,
        name: `カテゴリの一覧その${index}(項目が多いときの折りたたみを測る)`,
        type: "list_view",
        table: "categories",
        columns: ["name"],
      } as Manifest["app"]["views"][number]);
    }
    const replaced = await request.post(`/__e2e__/apps/${app.appId}/manifest`, { data: next });
    expect(replaced.status(), await replaced.text()).toBe(200);
    await setNavigation(request, app, { placement: "top" });

    await page.setViewportSize(WIDE);
    await openSignedIn(page, app);
    await expect(page.locator('[data-navigation-placement="top"]')).toHaveCount(1);
    await expect(page.getByTestId("view-menu-toggle")).toBeVisible();
    await expect(page.getByTestId("view-list-items")).toBeHidden();
    await page.getByTestId("view-menu-toggle").click();
    await expect(page.getByTestId("view-menu-item")).toHaveCount(next.app.views.length);
  });

  test("(5) 役割の上書き: owner は上(既定)、editor は左(by_role)", async ({ browser, request }) => {
    const app = await provisionApp(request);
    await setNavigation(request, app, {
      placement: "top",
      by_role: [{ role: "editor", placement: "side" }],
    });
    const editor = await seedRoleSession(request, app.appId, "editor");
    const contextOwner = await browser.newContext({ viewport: WIDE });
    const contextEditor = await browser.newContext({ viewport: WIDE });
    try {
      await app.authenticate(contextOwner);
      await editor.authenticate(contextEditor);
      const pageOwner = await contextOwner.newPage();
      const pageEditor = await contextEditor.newPage();
      await pageOwner.goto(`/apps/${app.appId}`);
      await pageEditor.goto(`/apps/${app.appId}`);
      await expect(pageOwner.getByTestId("current-role")).toHaveAttribute("data-role", "owner");
      await expect(pageEditor.getByTestId("current-role")).toHaveAttribute("data-role", "editor");
      await expect(pageOwner.locator('[data-navigation-placement="top"]')).toHaveCount(1);
      await expect(pageOwner.locator(".workspace-body")).toHaveCount(0);
      await expect(pageEditor.getByTestId("view-list")).toBeVisible();
      await expect(pageEditor.locator("[data-navigation-placement]")).toHaveCount(0);
      await expect(pageEditor.locator(".workspace-body")).toHaveCount(1);
    } finally {
      await contextOwner.close();
      await contextEditor.close();
    }
  });

  test("(6) 未ログイン(公開の画面)はアプリの既定に従う。項目が2つでも 360px では ≡", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await installTwoPublicViews(request, app);
    await app.createRecord("categories", { name: "藻塩のなかま" });
    // 既定は上、owner だけ左に上書き(未ログインは上書きを見ない)。
    await setNavigation(request, app, {
      placement: "top",
      by_role: [{ role: "owner", placement: "side" }],
    });

    // **cookie を1つも入れない**(= 未ログイン)。
    await page.setViewportSize(WIDE);
    await page.goto(`/apps/${app.appId}`);
    const workspace = page.getByTestId("anonymous-workspace");
    await expect(workspace).toBeVisible();
    await expect(workspace.locator('[data-navigation-placement="top"]')).toHaveCount(1);
    const items = page.getByTestId("view-list-items").locator(":scope > li");
    await expect(items).toHaveCount(2);
    expect(new Set(await itemTops(page)).size).toBe(1);
    await expect(page.getByTestId("view-menu-toggle")).toBeHidden();

    // 360px: 項目が2つでも ≡。
    await page.setViewportSize(NARROW);
    await expect(page.getByTestId("view-menu-toggle")).toBeVisible();
    await expect(page.getByTestId("view-list-items")).toBeHidden();
    await page.getByTestId("view-menu-toggle").click();
    await expect(page.getByTestId("view-menu-item")).toHaveCount(2);
    const leaked = await leakage(page);
    expect(leaked.outside).toBe(0);
    expect(leaked.onShell).toBe(0);
  });

  test("(7) 配る版でも宣言した位置(上)になる", async ({ page, request }) => {
    const seeded = await request.post(`/__e2e__/apps/${RUNNER_APP_ID}/session`);
    expect(seeded.status(), await seeded.text()).toBe(201);
    const spec = (await seeded.json()) as { name: string; value: string; path: string };
    const headers = { cookie: `${spec.name}=${spec.value}` };
    // 配る版には差分の口が無いので、育成用の版の口で同じアプリに宣言する。
    await postDiff(
      request,
      RUNNER_APP_ID,
      headers,
      workspaceDiff("runner-workspace-top", { placement: "top" }),
    );
    try {
      await page.setViewportSize(WIDE);
      await page
        .context()
        .addCookies([
          { name: spec.name, value: spec.value, url: `http://localhost:${port}${spec.path}` },
        ]);
      await page.goto(`${runnerBase}/apps/${RUNNER_APP_ID}`);
      expect(await page.getByText("どのアプリを表示するかが与えられていません。").count()).toBe(0);
      await expect(page.locator('[data-navigation-placement="top"]')).toHaveCount(1);
      await expect(page.locator(".workspace-body")).toHaveCount(0);
      // **配る版のアプリは他の検査と共有しており、先に走った検査が画面を足している**(通しで打つと
      // 1280px でもはみ出して畳む)。 **横一列か「≡ メニュー」のどちらか一方だけが見えることを見る。**
      const listShown = await page.getByTestId("view-list-items").isVisible();
      const toggleShown = await page.getByTestId("view-menu-toggle").isVisible();
      console.log(`[workspace-navigation (7)] list=${listShown} toggle=${toggleShown}`);
      expect(listShown).not.toBe(toggleShown);
      if (listShown) {
        expect(new Set(await itemTops(page)).size).toBe(1);
      }
      // 本文はメニューの下に置かれる(上に置いた形)。
      const [navBottom, mainTop] = await page.evaluate(() => {
        const nav = document.querySelector('[data-testid="view-list"]');
        const main = document.querySelector('[data-testid="workspace-main"]');
        if (nav === null || main === null) throw new Error("メニューか本文が無い");
        return [nav.getBoundingClientRect().bottom, main.getBoundingClientRect().top];
      });
      expect(mainTop).toBeGreaterThanOrEqual(navBottom);
      const leaked = await leakage(page);
      expect(leaked.outside).toBe(0);
      expect(leaked.onShell).toBe(0);
    } finally {
      // 後始末: 宣言を消す(`{}` でキーごと消える)。配る版のアプリは他の検査と共有している。
      // 【`V22-M3-T02` / `ADR-0488` §Decision 2 の 6(授権 `ADR-0489` 行24)の訂正】今日は `{}` を断る。
      // `workspaceDiff(…, null)` は `{ navigation: null }` を送り、メニューの位置の宣言だけを消す。
      await postDiff(
        request,
        RUNNER_APP_ID,
        headers,
        workspaceDiff("runner-workspace-clear", null),
      );
    }
  });

  test("(8) POST /undo で set_workspace を取り消すと左に戻る", async ({ page, request }) => {
    const app = await provisionApp(request);
    await setNavigation(request, app, { placement: "top" });
    await page.setViewportSize(WIDE);
    await openSignedIn(page, app);
    await expect(page.locator('[data-navigation-placement="top"]')).toHaveCount(1);

    const undone = await request.post(`/api/apps/${app.appId}/undo`, { headers: app.authHeaders });
    expect(undone.status(), await undone.text()).toBe(200);
    await page.reload();
    await expect(page.getByTestId("view-list")).toBeVisible();
    await expect(page.locator("[data-navigation-placement]")).toHaveCount(0);
    await expect(page.locator(".workspace-body")).toHaveCount(1);
    await expect(page.getByTestId("view-menu-toggle")).toHaveCount(0);
  });
});
