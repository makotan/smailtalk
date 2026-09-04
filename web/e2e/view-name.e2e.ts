/**
 * `view.name`(表示名)の E2E(V1-M0-T02 / F-1。検証方法2)。
 *
 * **これが完了条件1 の実機での証明である。** 検証するのは「スキーマが通ること」ではなく、
 * **製品の経路(`POST /api/apps/:id/diffs`)で `name` を書き、ブラウザに出ること**である。
 * スキーマだけ通って画面に出ない状態は未完了である、と計画書が明示している。
 *
 * 同時に完了条件2 も同じテストの中で確認する —— **同じアプリの中に** `name` を持つビューと
 * 持たないビューを並べ、後者が従来どおり `id` で描けることを見る。フィクスチャ
 * (`fixtures/valid/inventory-all-field-types.json`)のビューは1つも `name` を持たないので、
 * 払い出したアプリはそのまま「既存マニフェスト」の役を果たす。
 */
import { expect, test } from "@playwright/test";
import type { ListView } from "../../src/kernel/types.ts";
import { fixture, provisionApp } from "./fixture-app.ts";

/** 検証対象の list_view(フィクスチャから機械的に選ぶ。アプリ固有の名前は書かない)。 */
const list = ((): ListView => {
  const view = fixture.app.views.find(
    (candidate): candidate is ListView => candidate.type === "list_view",
  );
  if (view === undefined) {
    throw new Error("フィクスチャが壊れています: list_view がありません。");
  }
  return view;
})();

test("view.name は add_view / update_view で指定でき、見出しとビュー一覧に出る", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  // per-app 認証ゲート(ADR-0014 v3)を通す。ビュー画面は records を読むため認証が要る。
  await app.authenticate(page.context());
  const namedViewId = `${list.id}-named`;
  const displayName = "在庫の一覧";

  // --- 0. 既存ビュー(name 無し)は従来どおり id で描かれる(完了条件2) ----------
  // ビュー一覧のリンク文言は「<表示名> <種別ラベル>」なので、部分一致で見る。
  await page.goto(`/apps/${app.appId}`);
  const viewList = page.getByTestId("view-list");
  await expect(viewList).toContainText(list.id);

  await page.goto(`/apps/${app.appId}/views/${list.id}`);
  await expect(page.getByTestId("view-title")).toHaveText(list.id);
  await expect(page.getByTestId("view-renderer-list_view")).toBeVisible();

  // --- 1. add_view で name つきのビューを足す(完了条件1) -----------------------
  const created = await request.post(`/api/apps/${app.appId}/diffs`, {
    headers: app.authHeaders,
    data: {
      diff_id: `d-e2e-view-name-${Date.now()}`,
      intent: "一覧画面に人間向けの表示名を付けたい",
      operations: [
        {
          op: "add_view",
          view: {
            id: namedViewId,
            name: displayName,
            type: "list_view",
            table: list.table,
            columns: list.columns,
          },
        },
      ],
    },
  });
  expect(created.status(), await created.text()).toBe(201);

  await page.goto(`/apps/${app.appId}/views/${namedViewId}`);
  await expect(page.getByTestId("view-title")).toHaveText(displayName);
  await expect(page.getByTestId("view-renderer-list_view")).toBeVisible();

  // ビュー一覧では、name を持つビューは表示名で、持たないビューは id で並ぶ。
  await page.goto(`/apps/${app.appId}`);
  await expect(viewList).toContainText(displayName);
  await expect(viewList).toContainText(list.id);
  // 表示名を付けたビューについては、ID は一覧に出ない(名前が ID を置き換える)。
  await expect(viewList).not.toContainText(namedViewId);

  // --- 2. update_view で既存ビューに後から name を付けられる(完了条件1) --------
  const renamed = await request.post(`/api/apps/${app.appId}/diffs`, {
    headers: app.authHeaders,
    data: {
      diff_id: `d-e2e-view-rename-${Date.now()}`,
      intent: "既存の一覧にも表示名を付けたい",
      operations: [{ op: "update_view", view: list.id, changes: { name: "在庫台帳" } }],
    },
  });
  expect(renamed.status(), await renamed.text()).toBe(201);

  await page.goto(`/apps/${app.appId}/views/${list.id}`);
  await expect(page.getByTestId("view-title")).toHaveText("在庫台帳");
  // 表示名を変えても、描画対象そのものは変わっていない。
  await expect(page.getByTestId("view-renderer-list_view")).toBeVisible();
});
