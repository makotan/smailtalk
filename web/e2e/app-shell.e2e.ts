/**
 * スモーク E2E(V0-P3-T03 の検証方法)。
 *
 * アプリ一覧 → アプリ選択 → ビュー一覧、をブラウザで確認する。
 * 期待値はすべて**フィクスチャの JSON から読む**ので、このテストにも
 * アプリ固有の名前はハードコードされていない。マニフェストを差し替えれば
 * 期待値も自動的に変わる ―― それが解釈実行であることの確認になっている。
 *
 * 対象アプリはテスト開始時に払い出す(`fixture-app.ts`)。他のテストが作った
 * アプリが一覧に並んでいても、見るのは自分のアプリの行だけ。
 */
import { expect, test } from "@playwright/test";
import { provisionApp } from "./fixture-app.ts";

test("アプリ一覧からアプリを選ぶとビュー一覧に遷移する", async ({ page, request }) => {
  const app = await provisionApp(request);
  // アプリを開くと per-app 認証ゲート(ADR-0014 v3)が働くので、先にログイン済みにする。
  await app.authenticate(page.context());

  await page.goto("/");

  const appLink = page.getByRole("link", { name: app.appName, exact: true });
  await expect(appLink).toBeVisible();

  await appLink.click();

  await expect(page).toHaveURL(new RegExp(`/apps/${app.appId}$`));

  const viewList = page.getByTestId("view-list");
  await expect(viewList).toBeVisible();
  for (const view of app.manifest.app.views) {
    await expect(viewList.getByRole("link", { name: new RegExp(view.id) })).toBeVisible();
  }

  // リロードで同じ画面に戻れること(V0-P3-T07 の前提)。
  await page.reload();
  await expect(page.getByTestId("view-list")).toBeVisible();
});
