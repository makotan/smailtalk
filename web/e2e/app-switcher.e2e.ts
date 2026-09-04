/**
 * 共通ヘッダのアプリ切替が**実際にブラウザで切り替わること**の chromium 実測
 * (V3-M3-T01 / F-11' / ユーザ決定 D-M3-5)。
 *
 * 完了条件の正は `docs/plan/v3/records/v3-m3.md` §2 の「V3-M3-T01」節。
 *
 * ## なぜ要るか
 *
 * `web/test/app-switcher.test.tsx`(happy-dom)が見られるのは DOM の形だけである。
 * **`<details>` の開閉も、切替後に画面の中身が入れ替わることも、happy-dom では解けない。**
 * **「画面上でアプリを切り替えられる」(台帳 `docs/plan/v1/00-v1-plan.md:342` の原文)と
 * 言える根拠は本ファイルにしか無い。**
 *
 * ## 3本が何を証明するか
 *
 * | # | テスト | 証明するもの |
 * |---|---|---|
 * | (i) | 未認証での露出 | **ログインを1度もせずに、台帳の全アプリ名が共通ヘッダから読める**(T01-4。**これは安全性の検査ではなく、常設の代償の実測である**) |
 * | (ii) | 未ログインのアプリへの切替 | 押すと**そのアプリのログイン画面**が出る(T01-3。「押せるのに入れない」導線ではない) |
 * | (iii) | ログイン済みのアプリへの切替 | **作業画面の中身が別アプリのものに入れ替わる**(T01-1) |
 *
 * ## このファイルが証明しないこと(誇張しない)
 *
 * - **見た目の良し悪しは見ていない。** `web/src/styles.css` を1バイトも変えていないので、
 *   切替 UI は既存の規則(`.shell header` / `ul` / `li` / `.meta`)の上に素の
 *   `<details>` として乗っているだけである。スクリーンショット比較もしていない。
 * - **アプリが多いときの見え方は見ていない。** 払い出されるアプリはテストごとに増えるが、
 *   件数の上限も折り返しも実装していない(審査記録 §2 S3-4 の不利な材料)。
 * - **人間が「切り替えやすい」と感じるかは測っていない。**
 */
import { type BrowserContext, expect, test } from "@playwright/test";
import type { ListView } from "../../src/kernel/types.ts";
import { type FixtureApp, provisionApp } from "./fixture-app.ts";

/** 作業画面として開く一覧ビュー(フィクスチャから機械的に選ぶ)。 */
function listViewOf(app: FixtureApp): ListView {
  const view = app.manifest.app.views.find((candidate): candidate is ListView => {
    return candidate.type === "list_view";
  });
  if (view === undefined) throw new Error("フィクスチャに list_view が無い");
  return view;
}

/**
 * **2つのアプリに同時にログインした状態を作る**(本ファイルだけが要る操作)。
 *
 * 共有の `FixtureApp.authenticate()` は `addCookies({url})` を使っており、cookie の
 * path は URL から既定規則(最後のセグメントを落とす)で導かれて **`/api/apps` になる**。
 * その結果、2つのアプリに続けて呼ぶと **同じ (name, domain, path) の cookie を上書きし、
 * 先に入れた側のセッションが消える**(実測: (iii) が切替元のログイン画面に落ちた)。
 *
 * **これはフィクスチャ側の性質であって、製品の性質ではない** —— サーバは
 * `Path=/api/apps/:app_id` を明示して cookie を発行する(`src/server/` の setCookie)。
 * **`fixture-app.ts` は1バイトも変えず**(T01 の主対象外)、ここで path を明示して入れる。
 */
async function authenticatePerApp(context: BrowserContext, app: FixtureApp): Promise<void> {
  const separator = app.sessionCookie.indexOf("=");
  await context.addCookies([
    {
      name: app.sessionCookie.slice(0, separator),
      value: app.sessionCookie.slice(separator + 1),
      domain: "localhost",
      path: `/api/apps/${app.appId}`,
    },
  ]);
}

test.describe("V3-M3-T01 共通ヘッダのアプリ切替(chromium 実測)", () => {
  test("(i) ログインを1度もせずに、共通ヘッダから台帳の全アプリ名が読める", async ({
    page,
    request,
  }) => {
    const first = await provisionApp(request);
    const second = await provisionApp(request);

    // **認証は1つも通していない。**
    await page.goto("/");
    const switcher = page.getByTestId("app-switcher");
    await expect(switcher).toBeVisible();

    // **畳んだままでも、アプリ名は DOM に載っている。** 常設の代償はここにある ——
    // 「畳んであるから見えない」ではなく、「1クリックで見える / ソースには最初から在る」。
    await expect(switcher.getByTestId("app-switcher-list")).toHaveCount(1);
    const collapsed = await switcher.evaluate((element) => ({
      open: (element as HTMLDetailsElement).open,
      text: element.textContent ?? "",
    }));
    expect(collapsed.open).toBe(false);
    for (const app of [first, second]) {
      expect(collapsed.text).toContain(app.appName);
    }

    await switcher.locator("summary").click();

    for (const app of [first, second]) {
      const link = switcher.getByRole("link", { name: app.appName, exact: true });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute("href", `/apps/${app.appId}`);
    }
  });

  test("(ii) セッションの無いアプリへ切り替えると、そのアプリのログイン画面が出る", async ({
    page,
    request,
  }) => {
    const open = await provisionApp(request);
    const locked = await provisionApp(request);
    // **開いている側だけ**ログインする(cookie の Path は `/api/apps/<app_id>`)。
    await open.authenticate(page.context());

    const view = listViewOf(open);
    await page.goto(`/apps/${open.appId}/views/${view.id}`);
    await expect(page.getByTestId("view-list")).toBeVisible();

    // 切替 UI は**アプリ単位テーマのスコープ要素の外**にある(ADR-0048 限定2)。
    const placement = await page.evaluate(() => {
      const target = document.querySelector('[data-testid="app-switcher"]');
      const scope = document.querySelector('[data-testid="app-theme"]');
      return {
        found: target !== null,
        inHeader: target?.closest(".shell > header") !== null,
        insideThemeScope: scope !== null && target !== null && scope.contains(target),
      };
    });
    expect(placement).toEqual({ found: true, inHeader: true, insideThemeScope: false });

    const switcher = page.getByTestId("app-switcher");
    await switcher.locator("summary").click();
    await switcher.getByRole("link", { name: locked.appName, exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`/apps/${locked.appId}$`));
    // **401 を握り潰さない。** そのアプリのログイン画面が出る。
    await expect(page.getByTestId("login-page")).toBeVisible();
    await expect(page.getByTestId("login-page")).toContainText(locked.appName);
    await expect(page.getByTestId("view-list")).toHaveCount(0);
    // 切替 UI は未認証の画面でも消えない(常設。D-M3-5)。
    await expect(page.getByTestId("app-switcher")).toBeVisible();
  });

  test("(iii) ログイン済みのアプリへ切り替えると作業画面の中身が入れ替わる", async ({
    page,
    request,
  }) => {
    const from = await provisionApp(request);
    const to = await provisionApp(request);
    await authenticatePerApp(page.context(), from);
    await authenticatePerApp(page.context(), to);

    const view = listViewOf(from);
    await page.goto(`/apps/${from.appId}/views/${view.id}`);
    await expect(page.getByTestId("view-list")).toBeVisible();
    // 切替の前は、画面の見出しは切替元のアプリ名である。
    await expect(page.locator(".app-header h2")).toHaveText(from.appName);

    const switcher = page.getByTestId("app-switcher");
    await switcher.locator("summary").click();
    await switcher.getByRole("link", { name: to.appName, exact: true }).click();

    // **画面が切り替わった** —— URL も、見出しも、切替先のアプリのものになる。
    await expect(page).toHaveURL(new RegExp(`/apps/${to.appId}$`));
    await expect(page.locator(".app-header h2")).toHaveText(to.appName);
    await expect(page.getByTestId("view-list")).toBeVisible();

    // リロードしても同じ画面に戻る(URL に画面状態が載っている)。
    await page.reload();
    await expect(page.locator(".app-header h2")).toHaveText(to.appName);
  });
});
