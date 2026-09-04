/**
 * アプリ単位の権限モデル(per-app authz)の E2E(V1-M3-T02 / ADR-0015 / 計画 §P-E)。
 *
 * サーバ側の役割×操作マトリクスは bun test が主に担う。ここは実ブラウザで
 * **UI の先回りガードとロール昇格フロー**が通ることを最小2シナリオで確かめる:
 *
 *   1. viewer は閲覧のみ ―― レコードは見えるが、フォームに保存ボタンが無く
 *      (form-read-only)、詳細に編集/削除が無く(detail-read-only)、
 *      owner 専用のユーザ管理導線(open-user-admin)も出ない。
 *   2. owner がロール昇格 ―― ユーザ管理で viewer を editor に上げると、その
 *      ユーザのセッションで実際にレコードを書けるようになる。さらに最後の
 *      owner を降格しようとするとサーバが弾き、role-error が出る。
 *
 * 認証は WebAuthn 儀式ではなくセッション直挿し(`seedRoleSession` / `provisionApp`)で
 * 通す。ゲートそのものの検証は `auth.e2e.ts` の担当で、ここはゲートの先の権限を見る。
 * 対象のフォーム・詳細・テーブルは**フィクスチャの JSON から導く**(アプリ固有名を書かない)。
 */
import { expect, test } from "@playwright/test";
import type { DetailView, FormView, Table } from "../../src/kernel/types.ts";
import {
  buildRecord,
  ensureReferenceTargets,
  fixture,
  provisionApp,
  seedRoleSession,
} from "./fixture-app.ts";

function tableOf(tableId: string): Table {
  const table = fixture.app.tables.find((candidate) => candidate.id === tableId);
  if (table === undefined) {
    throw new Error(`フィクスチャが壊れています: テーブル ${tableId} がありません。`);
  }
  return table;
}

/**
 * 検証対象を選ぶ: form と detail_view が揃っているテーブル。
 * form-read-only(フォーム)と detail-read-only(詳細)の両方を1つのアプリで見たいので、
 * 同じテーブルに form と detail_view がある組を採る。
 */
function pickTarget(): { form: FormView; detail: DetailView; table: Table } {
  for (const view of fixture.app.views) {
    if (view.type !== "detail_view") {
      continue;
    }
    const form = fixture.app.views.find(
      (candidate): candidate is FormView =>
        candidate.type === "form" && candidate.table === view.table,
    );
    if (form === undefined) {
      continue;
    }
    return { form, detail: view, table: tableOf(view.table) };
  }
  throw new Error(
    "フィクスチャに form と detail_view が揃ったテーブルがありません(このテストの前提)。",
  );
}

const { form, detail, table } = pickTarget();

test("viewer は閲覧のみ ―― 保存/編集/削除もユーザ管理導線も出ない", async ({ page, request }) => {
  const app = await provisionApp(request);

  // 詳細を確かめるためのレコードは owner(既定セッション)で先に作っておく。
  // viewer は書けないので、対象データの用意は書ける側で行う。
  const referenceIds = await ensureReferenceTargets(app, app.tableOf(table.id));
  const recordId = await app.createRecord(table.id, buildRecord(table, 0, referenceIds));

  // ブラウザには viewer のセッションだけを入れる(owner の cookie は入れない)。
  const viewer = await seedRoleSession(request, app.appId, "viewer");
  await viewer.authenticate(page.context());

  // --- アプリを開く: 認証済み(閲覧可)だが viewer である ---------------------
  await page.goto(`/apps/${app.appId}`);
  // レコード一覧の導線(認証済みワークスペース)が見える。
  await expect(page.getByTestId("view-list")).toBeVisible();
  // ヘッダのロール表示が viewer。
  await expect(page.getByTestId("current-role")).toHaveAttribute("data-role", "viewer");
  // owner 専用のユーザ管理導線は出ない。
  await expect(page.getByTestId("open-user-admin")).toHaveCount(0);

  // --- フォーム: 保存ボタンが無く「閲覧のみ」が出る --------------------------
  await page.goto(`/apps/${app.appId}/views/${form.id}`);
  await expect(page.getByTestId("view-renderer-form")).toBeVisible();
  await expect(page.getByTestId("form-read-only")).toBeVisible();
  await expect(page.getByRole("button", { name: "保存" })).toHaveCount(0);

  // --- 詳細: レコードは見えるが編集/削除の導線が無い ------------------------
  await page.goto(`/apps/${app.appId}/views/${detail.id}/records/${recordId}`);
  await expect(page.getByTestId("view-renderer-detail_view")).toBeVisible();
  // 読める(詳細フィールドが描画されている)= 閲覧はできている。
  await expect(page.getByTestId("detail-fields")).toBeVisible();
  await expect(page.getByTestId("detail-read-only")).toBeVisible();
  await expect(page.getByTestId("detail-edit")).toHaveCount(0);
  await expect(page.getByTestId("detail-delete")).toHaveCount(0);

  // --- UI を経由しない 403 の直接確認(V3-M3-T04 完了条件4)-------------------
  // **UI が押させないことは 403 の代わりにならない。** 上でボタンが消えていることを
  // 確かめたが、それはサーバが断っている証拠ではない。`request`(ブラウザ context と
  // cookie を共有しない)から直接叩き、サーバが今も 403 を返すことを別に確かめる。
  const forbidden = await request.post(`/api/apps/${app.appId}/tables/${table.id}/records`, {
    data: buildRecord(table, 1, referenceIds),
    headers: viewer.authHeaders,
  });
  expect(forbidden.status(), await forbidden.text()).toBe(403);
  const forbiddenDelete = await request.delete(
    `/api/apps/${app.appId}/tables/${table.id}/records/${recordId}`,
    { headers: viewer.authHeaders },
  );
  expect(forbiddenDelete.status(), await forbiddenDelete.text()).toBe(403);
  // 読めることは変わっていない(閉じすぎていないことの裏)。
  const readable = await request.get(`/api/apps/${app.appId}/tables/${table.id}/records`, {
    headers: viewer.authHeaders,
  });
  expect(readable.status(), await readable.text()).toBe(200);
});

test("owner が viewer を editor に昇格 → その editor が書き込め、最後の owner は降格できない", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request); // 既定セッション = owner

  // 管理対象となる2人目のユーザ(viewer)を仕込む。owner とは別ユーザ。
  const viewer = await seedRoleSession(request, app.appId, "viewer");

  // 参照先レコードは owner で先に用意しておく(昇格後の editor 書込を通すため)。
  const referenceIds = await ensureReferenceTargets(app, app.tableOf(table.id));

  // owner のセッションでブラウザを認証してアプリを開く。
  await app.authenticate(page.context());
  await page.goto(`/apps/${app.appId}`);

  // --- ユーザ管理を開く(owner だけの導線)----------------------------------
  await page.getByTestId("open-user-admin").click();
  await expect(page.getByTestId("user-admin")).toBeVisible();

  const viewerRow = page.locator(`[data-testid="user-row"][data-user-id="${viewer.userId}"]`);
  const viewerRoleSelect = viewerRow.getByTestId("role-select");
  await expect(viewerRoleSelect).toHaveValue("viewer");

  // --- viewer → editor に昇格 ------------------------------------------------
  await viewerRoleSelect.selectOption("editor");
  // 反映される(サーバが受理して手元の一覧も editor に更新)。エラーは出ない。
  await expect(viewerRoleSelect).toHaveValue("editor");
  await expect(page.getByTestId("role-error")).toHaveCount(0);

  // 昇格が本当に効いていることを、その editor のセッションで書き込めることで確かめる。
  // viewer の cookie が指すユーザの role が editor になったので、同じセッションで 201。
  const created = await request.post(`/api/apps/${app.appId}/tables/${table.id}/records`, {
    data: buildRecord(table, 1, referenceIds),
    headers: viewer.authHeaders,
  });
  expect(created.status(), await created.text()).toBe(201);

  // --- 最後の owner を降格しようとすると弾かれる ----------------------------
  // いま owner は既定ユーザ1人だけ。これを viewer にしようとすると 409 → role-error。
  const ownerRow = page.locator(`[data-testid="user-row"][data-user-id="${app.userId}"]`);
  const ownerRoleSelect = ownerRow.getByTestId("role-select");
  await expect(ownerRoleSelect).toHaveValue("owner");
  await ownerRoleSelect.selectOption("viewer");
  await expect(page.getByTestId("role-error")).toBeVisible();
  // 降格は成立していない(コントロールドな select が owner に戻る)。
  await expect(ownerRoleSelect).toHaveValue("owner");
});
