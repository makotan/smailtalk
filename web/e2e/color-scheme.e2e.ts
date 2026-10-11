/**
 * **OS の明暗設定への追随と、画面内のスイッチでの上書き**の chromium 実測(`V20-M10-T03`)。
 *
 * 計画の正は `docs/plan/v20/12-v20-m10-plan.md` §9-7 の 1 と §10 の 6 / 12(iv) / 12(v)、
 * ユーザ決定は `docs/plan/v20/01-user-decisions.md` §11(`D-V20-31` / `D-V20-32` / `D-V20-33`)。
 * **判定は計算値(`getComputedStyle`)で行う。HTML の差分では判定しない。**
 *
 * | # | 何を測るか |
 * |---|---|
 * | (i) | OS を暗くすると、テーマを持たないアプリのページの地色と文字色が暗い既定になる |
 * | (ii) | スイッチで明るくでき、再読込しても明るい(覚える) |
 * | (iii) | スイッチを OS と同じ側へ戻すと記憶が消え、その後は OS に追随する(`D-V20-32`) |
 * | (iv) | 暗い側の組(`slots_dark`)を持つテーマのアプリは、暗いとき `slots_dark` の色、明るいとき `slots` の色 |
 * | (v) | `slots_dark` を持たないテーマのアプリは OS が暗くても明るく、スイッチが無い(`D-V20-31`) |
 * | (vi) | アプリ一覧・ログイン画面にスイッチが無い。利用者向けの版(runner)にはある(`D-V20-33`) |
 * | (vii) | **ちらつきの実測**: OS が暗い端末で `slots_dark` を持たないテーマのアプリを開くと、定義が届くまでは既定の暗い色(計画 §10 の 6) |
 * | (viii) | **覚えた値が OS と逆のときの最初の描画**(計画 §10 の 12(iv)) |
 * | (ix) | **【`V20-M10-T05`。メインの裁定】ログインせずに開ける画面(公開の画面)の上端の帯にもスイッチがあり、右に寄る。** `slots_dark` を持たないテーマなら無く、明るい |
 * | (x) | **【V20-M10 点検 中1 の処置】別タブで切り替えた後、このタブの無関係な移動でスイッチ・器・ページの外枠が食い違わない。開き直すと効く** |
 *
 * ## 証明しないこと(誇張しない)
 *
 * - **見やすさは証明しない**(計算値を読むだけ。スクリーンショットの比較はしない)。
 * - **ブラウザが描く部品(チェックボックスの箱・選択肢の開いた一覧・日付の暦・スクロールバー)が
 *   暗くなるかは測らない** —— `color-scheme:` を書かないので明るいまま残りうる(`ADR-0458` 限定12。
 *   穴の候補として `docs/plan/v20/records/v20-m10-t03.md` に書いた)。
 */
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import type { Diff, Manifest } from "../../src/kernel/types.ts";
import { type FixtureApp, provisionApp } from "./fixture-app.ts";

const STORAGE_KEY = "smailtalk.color-scheme";

const LIGHT = { background: "rgb(255, 255, 255)", text: "rgb(0, 0, 0)" };
/** 暗い既定(`web/src/styles.css` の末尾。`#121212` / `#e6e6e6`)。 */
const DARK = { background: "rgb(18, 18, 18)", text: "rgb(230, 230, 230)" };

/** 明るい側の組(`web/e2e/theme.e2e.ts` のテーマB と同じ値。コントラスト検査を通る)。 */
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
  overlay_background: "#fff8e1",
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

/** 暗い側の組(`web/e2e/theme.e2e.ts` のテーマA と同じ色。色以外は明るい側と同じ値)。 */
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
  overlay_background: "#102030",
  overlay_text: "#f5f5f5",
  border_color: "#8fa3b8",
  focus_ring: "#7fd4ff",
};

async function setTheme(
  request: APIRequestContext,
  app: FixtureApp,
  theme: { slots: Record<string, string>; slots_dark?: Record<string, string> },
  diffId: string,
): Promise<void> {
  const diff: Diff = {
    diff_id: diffId,
    intent: "アプリの配色を決めたい、という要望に応えてテーマを設定した",
    operations: [{ op: "set_theme", theme }],
  };
  const applied = await request.post(`/api/apps/${app.appId}/diffs`, {
    data: diff,
    headers: app.authHeaders,
  });
  expect(applied.status(), await applied.text()).toBe(201);
}

/** 要素の地色と文字色の計算値。 */
async function colors(page: Page, selector: string): Promise<{ background: string; text: string }> {
  return await page.evaluate((selector) => {
    const element = document.querySelector(selector);
    if (element === null) throw new Error(`要素が見つからない: ${selector}`);
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, text: style.color };
  }, selector);
}

async function memory(page: Page): Promise<string | null> {
  return await page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY);
}

async function htmlAttribute(page: Page): Promise<string | null> {
  return await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
}

async function openSignedIn(page: Page, app: FixtureApp): Promise<void> {
  await app.authenticate(page.context());
  await page.goto(`/apps/${app.appId}`);
  await expect(page.getByTestId("current-user")).toBeVisible();
}

test.describe("V20-M10-T03 OS の明暗設定への追随と画面内のスイッチ(chromium 実測)", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "計算値の期待値は chromium の値である(`theme-baseline.e2e.ts` と同じ理由)",
  );

  test("(i)(ii)(iii) テーマを持たないアプリ: OS に追随し、スイッチで上書きして覚え、OS と同じ側へ戻すと忘れる", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await page.emulateMedia({ colorScheme: "dark" });
    await openSignedIn(page, app);

    // (i) OS が暗い → 暗い既定。属性は付かない(配色設定の @media が効いている)。
    expect(await colors(page, "body")).toEqual(DARK);
    expect(await colors(page, '[data-testid="app-theme"]')).toEqual(DARK);
    expect(await htmlAttribute(page)).toBeNull();
    const toggle = page.getByTestId("color-scheme-toggle");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(toggle).toContainText("暗い表示");

    // (ii) スイッチで明るくする → 明るい既定。覚える。再読込しても明るい。
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(await colors(page, "body")).toEqual(LIGHT);
    expect(await memory(page)).toBe("light");
    expect(await htmlAttribute(page)).toBe("light");
    await page.reload();
    await expect(page.getByTestId("current-user")).toBeVisible();
    expect(await colors(page, "body")).toEqual(LIGHT);
    await expect(page.getByTestId("color-scheme-toggle")).toHaveAttribute("aria-pressed", "false");

    // (iii) もう1度押す → 反対(暗い)は OS と同じなので忘れる。属性も外れる。
    await page.getByTestId("color-scheme-toggle").click();
    await expect(page.getByTestId("color-scheme-toggle")).toHaveAttribute("aria-pressed", "true");
    expect(await colors(page, "body")).toEqual(DARK);
    expect(await memory(page)).toBeNull();
    expect(await htmlAttribute(page)).toBeNull();
    // 忘れたので OS に追随する(OS を明るくすると明るくなる。再読込なしで)。
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.getByTestId("color-scheme-toggle")).toHaveAttribute("aria-pressed", "false");
    expect(await colors(page, "body")).toEqual(LIGHT);
  });

  test("(iv) slots_dark を持つテーマのアプリは、暗いとき slots_dark の色、明るいとき slots の色で描かれる", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await setTheme(request, app, { slots: SLOTS, slots_dark: SLOTS_DARK }, "theme-with-dark");
    await page.emulateMedia({ colorScheme: "dark" });
    await openSignedIn(page, app);

    expect(await colors(page, '[data-testid="app-theme"]')).toEqual({
      background: "rgb(16, 32, 48)", // #102030
      text: "rgb(245, 245, 245)", // #f5f5f5
    });
    // 器の外(body)は既定の暗い値(テーマは器の inline style にしか立たない。ADR-0047 限界4)。
    expect(await colors(page, "body")).toEqual(DARK);
    await expect(page.getByTestId("color-scheme-toggle")).toBeVisible();

    // スイッチで明るく → slots の色。
    await page.getByTestId("color-scheme-toggle").click();
    await expect(page.getByTestId("color-scheme-toggle")).toHaveAttribute("aria-pressed", "false");
    expect(await colors(page, '[data-testid="app-theme"]')).toEqual({
      background: "rgb(255, 248, 225)", // #fff8e1
      text: "rgb(26, 35, 126)", // #1a237e
    });
    expect(await colors(page, "body")).toEqual(LIGHT);
  });

  test("(v) slots_dark を持たないテーマのアプリは OS が暗くても明るく、スイッチが無い。記憶は書き換えず、離れたら戻る", async ({
    page,
    request,
  }) => {
    const themed = await provisionApp(request);
    await setTheme(request, themed, { slots: SLOTS }, "theme-light-only");
    const plain = await provisionApp(request);
    await page.emulateMedia({ colorScheme: "dark" });
    await openSignedIn(page, themed);

    expect(await colors(page, '[data-testid="app-theme"]')).toEqual({
      background: "rgb(255, 248, 225)",
      text: "rgb(26, 35, 126)",
    });
    // 器の外も明るい(強制で <html> が明るい側)。
    expect(await colors(page, "body")).toEqual(LIGHT);
    expect(await htmlAttribute(page)).toBe("light");
    expect(await page.getByTestId("color-scheme-toggle").count()).toBe(0);
    expect(await memory(page)).toBeNull();

    // 離れる(シェルの導線で別のアプリへ。再読込なし)→ 強制が外れ、OS に追随して暗い。
    await plain.authenticate(page.context());
    await page.evaluate((path) => {
      window.history.pushState({}, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, `/apps/${plain.appId}`);
    await expect(page.getByTestId("color-scheme-toggle")).toBeVisible();
    expect(await htmlAttribute(page)).toBeNull();
    expect(await colors(page, "body")).toEqual(DARK);
  });

  test("(vi) アプリ一覧とログイン画面にスイッチが無く、利用者向けの版(runner)の上端の帯にはある", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await page.emulateMedia({ colorScheme: "dark" });

    // アプリ一覧: スイッチは無いが OS に追随して暗い。
    await page.goto("/");
    await expect(page.getByTestId("app-list")).toBeVisible();
    expect(await page.getByTestId("color-scheme-toggle").count()).toBe(0);
    expect(await colors(page, "body")).toEqual(DARK);

    // ログイン画面(未ログイン): スイッチは無い。
    await page.goto(`/apps/${app.appId}`);
    await expect(page.getByTestId("login-page")).toBeVisible();
    expect(await page.getByTestId("color-scheme-toggle").count()).toBe(0);

    // 利用者向けの版: owner のセッションで開くと上端の帯にある。
    const port = Number(process.env.ST_E2E_PORT ?? 3210);
    const seeded = await request.post("/__e2e__/apps/runner-e2e/session");
    expect(seeded.status(), await seeded.text()).toBe(201);
    const spec = (await seeded.json()) as { name: string; value: string; path: string };
    await page
      .context()
      .addCookies([
        { name: spec.name, value: spec.value, url: `http://localhost:${port}${spec.path}` },
      ]);
    await page.goto(`http://localhost:${port + 1}/apps/runner-e2e`);
    const toggle = page.locator('.app-header [data-testid="color-scheme-toggle"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(await colors(page, "body")).toEqual(DARK);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(await colors(page, "body")).toEqual(LIGHT);
    // 後片付け(runner のアプリは他の検査と共有なので、記憶を残さない)。
    await toggle.click();
    expect(await memory(page)).toBeNull();

    // ログイン画面(runner。未ログイン)にも無い。
    await page.context().clearCookies();
    await page.goto(`http://localhost:${port + 1}/apps/runner-e2e`);
    await expect(page.getByTestId("login-page")).toBeVisible();
    expect(await page.getByTestId("color-scheme-toggle").count()).toBe(0);
  });

  test("(vii) ちらつきの実測: OS が暗い端末で slots_dark を持たないテーマのアプリを開くと、定義が届くまでは既定の暗い色(計画 §10 の 6)", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await setTheme(request, app, { slots: SLOTS }, "theme-light-only-flicker");
    await app.authenticate(page.context());
    await page.emulateMedia({ colorScheme: "dark" });

    // 定義(manifest)の応答を止めて、読み込み中の姿を測る。
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/apps/${app.appId}/manifest`, async (route) => {
      await held;
      await route.continue();
    });
    await page.goto(`/apps/${app.appId}`);
    await expect(page.getByText("読み込み中…").first()).toBeVisible();
    const loading = await colors(page, "body");
    const loadingAttribute = await htmlAttribute(page);
    release();
    await expect(page.getByTestId("current-user")).toBeVisible();
    const loaded = await colors(page, "body");
    test.info().annotations.push({
      type: "flicker",
      description: `読み込み中 body=${JSON.stringify(loading)} 属性=${loadingAttribute} / 定義の後 body=${JSON.stringify(loaded)}`,
    });
    // **読み込み中は既定の暗い色、定義が届いてから明るくなる**(D-V20-31 の代償。穴として記録)。
    expect(loading).toEqual(DARK);
    expect(loadingAttribute).toBeNull();
    expect(loaded).toEqual(LIGHT);
  });

  // 【V20-M10-T05】旧の test 名(逐語): "(viii) 覚えた値が OS と逆のとき、最初の描画から覚えた側の色である(計画 §10 の 12(iv))"。
  // 実測は「最初のフレームは OS 側」であり、名前だけが嘘だった(期待値は T03 が実測に合わせている)。
  test("(viii) 覚えた値が OS と逆のとき、最初のフレームは OS 側の色で、描き終わると覚えた側の色である(計画 §10 の 12(iv)。穴)", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await page.emulateMedia({ colorScheme: "dark" });
    // 覚えた値(明るい)を先に入れ、最初の描画の直前(最初のフレーム)の姿を記録する仕掛けを置く。
    await page.addInitScript((key) => {
      window.localStorage.setItem(key, "light");
      const frames: { attribute: string | null; background: string }[] = [];
      (window as unknown as { __frames: typeof frames }).__frames = frames;
      // 読むのは `<html>` で解決した地色の枠(= body とキャンバスに出る色)。body がまだ無いフレームでも読める。
      const record = () => {
        frames.push({
          attribute: document.documentElement.getAttribute("data-theme"),
          background: getComputedStyle(document.documentElement)
            .getPropertyValue("--color-page-background")
            .trim(),
        });
        if (frames.length < 3) requestAnimationFrame(record);
      };
      requestAnimationFrame(record);
    }, STORAGE_KEY);
    await app.authenticate(page.context());
    await page.goto(`/apps/${app.appId}`);
    await expect(page.getByTestId("current-user")).toBeVisible();
    const frames = await page.evaluate(
      () =>
        (window as unknown as { __frames: { attribute: string | null; background: string }[] })
          .__frames,
    );
    test.info().annotations.push({ type: "first-frames", description: JSON.stringify(frames) });
    expect(frames.length).toBeGreaterThan(0);
    // **【実測。穴として記録する】最初のフレームは OS 側(暗い)である** —— 入口のモジュールは
    // 文書の解析の後に走るので、覚えた値を当てる前に1フレーム以上が OS 側の色で描かれうる。
    // 最初のフレームの姿を固定する(直したら赤くなり、この期待値と記録を書き直すことになる)。
    expect(frames[0]).toEqual({ attribute: null, background: "#121212" });
    // 描き終わった後は覚えた側(明るい)。
    expect(await colors(page, "body")).toEqual(LIGHT);
  });

  test("(x) 別タブで切り替えた後、このタブの無関係な移動でスイッチ・器・ページの外枠が食い違わない。開き直すと効く(V20-M10 点検 中1)", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await setTheme(request, app, { slots: SLOTS, slots_dark: SLOTS_DARK }, "theme-cross-tab");
    await page.emulateMedia({ colorScheme: "dark" });
    await openSignedIn(page, app);
    const other = await page.context().newPage();
    await other.emulateMedia({ colorScheme: "dark" });
    await other.goto(`/apps/${app.appId}`);
    await expect(other.getByTestId("current-user")).toBeVisible();

    const darkScope = { background: "rgb(16, 32, 48)", text: "rgb(245, 245, 245)" };
    await expect(page.getByTestId("color-scheme-toggle")).toHaveAttribute("aria-pressed", "true");
    expect(await colors(page, '[data-testid="app-theme"]')).toEqual(darkScope);

    // 別タブでスイッチを押して明るくする(保存領域に light が残る)。
    await other.getByTestId("color-scheme-toggle").click();
    await expect(other.getByTestId("color-scheme-toggle")).toHaveAttribute("aria-pressed", "false");
    expect(await memory(page)).toBe("light");

    // このタブで画面一覧のリンクを1つ押す(無関係な再描画)。
    const view = app.manifest.app.views[0];
    if (view === undefined) throw new Error("フィクスチャに画面がありません。");
    await page
      .getByTestId("view-list")
      .getByRole("link", { name: new RegExp(view.id) })
      .click();
    await expect(page).toHaveURL(new RegExp(view.id));

    // スイッチの表示・器・ページの外枠・<html> の属性がそろって暗いまま(開き直すまで動かない)。
    await expect(page.getByTestId("color-scheme-toggle")).toHaveAttribute("aria-pressed", "true");
    expect(await colors(page, '[data-testid="app-theme"]')).toEqual(darkScope);
    expect(await colors(page, "body")).toEqual(DARK);
    expect(await htmlAttribute(page)).toBeNull();

    // 開き直すと別タブで覚えた側(明るい)が効く。
    await page.reload();
    await expect(page.getByTestId("color-scheme-toggle")).toHaveAttribute("aria-pressed", "false");
    expect(await colors(page, '[data-testid="app-theme"]')).toEqual({
      background: "rgb(255, 248, 225)",
      text: "rgb(26, 35, 126)",
    });
    expect(await colors(page, "body")).toEqual(LIGHT);
    expect(await htmlAttribute(page)).toBe("light");
    await other.close();
  });
});

/**
 * **公開の画面を1枚足す**(`web/e2e/anonymous-public-view.e2e.ts` の `installPublicCatalog` と同じ形を
 * 小さく書いた。未ログインの役割に画面1本と表1本を名指しする)。テーマを渡せば一緒に置く。
 */
const PUBLIC_VIEW = "public-catalog";
async function installPublicView(
  request: APIRequestContext,
  app: FixtureApp,
  theme?: { slots: Record<string, string> },
): Promise<void> {
  const next = structuredClone(app.manifest);
  const loose = next.app as unknown as {
    roles?: { id: string; name?: string; rules?: Record<string, unknown>[] }[];
  };
  next.app.tables = [
    ...next.app.tables,
    {
      id: "catalog",
      name: "商品",
      fields: [
        { id: "name", name: "商品名", type: "text", required: true },
        { id: "st_public", name: "公開", type: "boolean" },
      ],
    },
  ] as Manifest["app"]["tables"];
  next.app.views = [
    ...next.app.views,
    { id: PUBLIC_VIEW, name: "商品一覧", type: "list_view", table: "catalog", columns: ["name"] },
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
  push("owner", [
    { target: "table", table: "catalog", can: ["read", "write", "delete"] },
    { target: "view", view: PUBLIC_VIEW, can: ["read"] },
  ]);
  push("anonymous", [
    { target: "view", view: PUBLIC_VIEW, can: ["read"] },
    { target: "table", table: "catalog", can: ["read"] },
  ]);
  loose.roles = roles;
  if (theme !== undefined) next.app.theme = theme;
  const replaced = await request.post(`/__e2e__/apps/${app.appId}/manifest`, { data: next });
  expect(replaced.status(), await replaced.text()).toBe(200);
}

test.describe("ログインせずに開ける画面のスイッチ(V20-M10-T05)", () => {
  test("(ix) 公開の画面の上端の帯にスイッチがあり右に寄る。押すと暗く覚える。slots_dark を持たないテーマなら無く明るい", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await installPublicView(request, app);
    await page.emulateMedia({ colorScheme: "light" });

    // cookie を1つも入れない(= 未ログイン)。
    await page.goto(`/apps/${app.appId}/views/${PUBLIC_VIEW}`);
    await expect(page.getByTestId("anonymous-workspace")).toBeVisible();
    const toggle = page.locator('.app-header [data-testid="color-scheme-toggle"]');
    await expect(toggle).toBeVisible();
    expect(await page.getByTestId("color-scheme-toggle").count()).toBe(1);
    // 右寄せ: スイッチはログインへの導線の右に在り、帯の右半分に在る(計算した配置で測る)。
    const boxes = await page.evaluate(() => {
      const box = (selector: string) => {
        const element = document.querySelector(selector);
        if (element === null) throw new Error(`要素が見つからない: ${selector}`);
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top };
      };
      return {
        header: box('[data-testid="anonymous-workspace"] .app-header'),
        link: box('[data-testid="anonymous-login-link"]'),
        toggle: box('.app-header [data-testid="color-scheme-toggle"]'),
      };
    });
    test.info().annotations.push({ type: "boxes", description: JSON.stringify(boxes) });
    expect(boxes.toggle.left).toBeGreaterThan(boxes.link.right);
    expect(boxes.toggle.left).toBeGreaterThan((boxes.header.left + boxes.header.right) / 2);
    expect(boxes.header.right - boxes.toggle.right).toBeLessThan(
      boxes.toggle.left - boxes.link.right,
    );

    expect(await colors(page, "body")).toEqual(LIGHT);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(await colors(page, "body")).toEqual(DARK);
    expect(await memory(page)).toBe("dark");
    // 後片付け(OS と同じ側へ戻すと忘れる)。
    await toggle.click();
    expect(await memory(page)).toBeNull();

    // slots_dark を持たないテーマ: OS が暗くてもスイッチは無く明るい(D-V20-31 と同じ規則)。
    const themed = await provisionApp(request);
    await installPublicView(request, themed, { slots: SLOTS });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(`/apps/${themed.appId}/views/${PUBLIC_VIEW}`);
    await expect(page.getByTestId("anonymous-workspace")).toBeVisible();
    await expect(page.locator('[data-testid="app-theme"]')).toBeVisible();
    await expect.poll(() => htmlAttribute(page)).toBe("light");
    expect(await page.getByTestId("color-scheme-toggle").count()).toBe(0);
    expect(await colors(page, "body")).toEqual(LIGHT);
  });
});
