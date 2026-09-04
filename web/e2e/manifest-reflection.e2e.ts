/**
 * マニフェスト変更の動的反映 E2E(V0-P3-T07 の完了条件そのもの)。
 *
 * 手順は3つだけ:
 *
 *   (a) アプリを開いて、いまのマニフェストどおりの画面が出ていることを確認する
 *   (b) **サーバを起動したまま** マニフェストを additive に差し替える
 *       (フィールド追加 + ビュー追加。差し替えは `__e2e__` 経路 → カーネルの
 *        `applyManifest`。製品の HTTP API には差し替える口が無い)
 *   (c) **ブラウザをリロードするだけ**で、新しいフィールド・新しいビューが出ることを確認する
 *
 * このテストの本質は **(b) と (c) のあいだで何もしないこと**である。フロントの
 * 再ビルドもサーバの再起動もページの再デプロイも挟まない。それでも画面が変われば、
 * 画面構成がフロントに焼き込まれておらず、毎回サーバのマニフェストを解釈して
 * 描かれている(= コード生成をしていない、憲法3)ことの実証になる。
 *
 * 追加する要素の名前は**フィクスチャから機械的に導く**(既存 ID と衝突しない
 * 合成 ID を作る)。アプリ固有の名前はこのファイルにも現れない。
 */
import { expect, test } from "@playwright/test";
import type { Field, ListView, Manifest, Table, View } from "../../src/kernel/types.ts";
import {
  buildRecord,
  ensureReferenceTargets,
  type FixtureApp,
  fixturePath,
  provisionApp,
} from "./fixture-app.ts";

/** 検証対象の list_view。列ヘッダの増減が一番はっきり見えるビューを使う。 */
function targetListView(manifest: Manifest): ListView {
  const chosen = manifest.app.views.find((view): view is ListView => view.type === "list_view");
  if (chosen === undefined) {
    throw new Error(`フィクスチャに list_view がありません: ${fixturePath}`);
  }
  return chosen;
}

function tableOf(manifest: Manifest, tableId: string): Table {
  const table = manifest.app.tables.find((candidate) => candidate.id === tableId);
  if (table === undefined) {
    throw new Error(`フィクスチャが壊れています: table ${tableId}`);
  }
  return table;
}

function fieldOf(table: Table, fieldId: string): Field {
  const field = table.fields.find((candidate) => candidate.id === fieldId);
  if (field === undefined) {
    throw new Error(`フィクスチャが壊れています: field ${fieldId}`);
  }
  return field;
}

/** 既存 ID と衝突しないリソースID を作る(接尾辞を伸ばすだけ)。 */
function freshId(base: string, taken: readonly string[]): string {
  let candidate = `${base}-added`;
  while (taken.includes(candidate)) {
    candidate = `${candidate}-x`;
  }
  return candidate;
}

/**
 * additive な差し替え後のマニフェストを組み立てる。
 * 既存のテーブル・フィールド・ビューは1つも消さない(v0 は additive のみ)。
 */
function extend(
  manifest: Manifest,
  view: ListView,
): { next: Manifest; addedField: Field; addedView: View } {
  const next = structuredClone(manifest);
  const table = tableOf(next, view.table);

  const addedField: Field = {
    id: freshId(
      "field",
      table.fields.map((field) => field.id),
    ),
    name: "追加フィールド",
    type: "text",
  };
  table.fields.push(addedField);

  // 追加フィールドを既存ビューの列に足す(= 既存画面に新しい列が現れる)。
  const targetView = next.app.views.find((candidate) => candidate.id === view.id) as ListView;
  targetView.columns = [...targetView.columns, addedField.id];

  // ビューそのものも1つ足す(= ビュー一覧に新しい項目が現れる)。
  const addedView: ListView = {
    id: freshId(
      "view",
      next.app.views.map((candidate) => candidate.id),
    ),
    type: "list_view",
    table: table.id,
    columns: [addedField.id],
  };
  next.app.views.push(addedView);

  return { next, addedField, addedView };
}

const viewUrl = (app: FixtureApp, viewId: string): string => `/apps/${app.appId}/views/${viewId}`;

test("サーバ稼働中のマニフェスト変更が、ブラウザのリロードだけで画面に反映される", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());
  const view = targetListView(app.manifest);
  const table = tableOf(app.manifest, view.table);
  const beforeColumns = view.columns.map((columnId) => fieldOf(table, columnId));

  // --- (a) 差し替え前の画面。既存データも1件入れておく ---
  const referenceIds = await ensureReferenceTargets(app, table);
  const seeded = buildRecord(table, 1, referenceIds);
  // フィクスチャの filter は等値AND配列(後方互換形)。ブール式(EC-G12 / ADR-0043)は扱わない。
  if (Array.isArray(view.filter)) {
    for (const condition of view.filter) {
      seeded[condition.field] = condition.equals;
    }
  }
  const seededId = await app.createRecord(table.id, seeded);
  const firstColumn = beforeColumns[0];
  if (firstColumn === undefined) {
    throw new Error(`フィクスチャの list_view に columns がありません: ${fixturePath}`);
  }
  const seededText = String(seeded[firstColumn.id]);

  await page.goto(viewUrl(app, view.id));
  const headers = page.getByTestId("list-table").locator("thead th");
  await expect(headers).toHaveText(beforeColumns.map((field) => field.name));
  await expect(page.getByTestId("list-row")).toHaveCount(1);

  const { next, addedField, addedView } = extend(app.manifest, view);

  // 差し替え前は、新しい列も新しいビューも当然どこにも無い。
  await expect(page.getByTestId("list-table")).not.toContainText(addedField.name);
  await expect(page.getByTestId("view-list")).not.toContainText(addedView.id);

  // --- (b) サーバを起動したままマニフェストを差し替える ---
  //
  // ここでフロントを再ビルドしない・サーバを再起動しない・ページを開き直さない。
  const replaced = await request.post(`/__e2e__/apps/${app.appId}/manifest`, { data: next });
  expect(replaced.status(), await replaced.text()).toBe(200);

  // --- (c) リロードするだけ ---
  await page.reload();

  // 新しい列が既存のビューに現れる。
  await expect(headers).toHaveText([...beforeColumns.map((f) => f.name), addedField.name]);

  // 新しいビューがビュー一覧に現れ、開ける。
  const viewList = page.getByTestId("view-list");
  await expect(viewList.getByRole("link", { name: new RegExp(addedView.id) })).toBeVisible();

  // 既存データは残っている(additive な変更でレコードは消えない)。
  const rows = page.getByTestId("list-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(seededText);
  // 追加した列は既存行では未設定(値が無いだけで、行そのものは生きている)。
  // 「未設定」の文面は `fields/display.tsx` の担当なので、ここでは印(class)だけを見る。
  await expect(
    rows.first().locator(`td[data-field="${addedField.id}"] .field-empty`),
  ).toBeVisible();

  // 追加フィールドに値を書けるようになっている ―― 画面だけでなくスキーマも追随している。
  // 更新は楽観ロック(M9-T02)。現在の版を ETag で取り、If-Match に載せる。
  const current = await request.get(
    `/api/apps/${app.appId}/tables/${table.id}/records/${seededId}`,
    { headers: app.authHeaders },
  );
  const version = current.headers().etag;
  if (version === undefined) throw new Error("GET 応答に ETag(版)が無い");
  await request.patch(`/api/apps/${app.appId}/tables/${table.id}/records/${seededId}`, {
    data: { [addedField.id]: addedField.name },
    headers: { ...app.authHeaders, "If-Match": version },
  });
  await page.reload();
  await expect(rows.first().locator(`td[data-field="${addedField.id}"]`)).toHaveText(
    addedField.name,
  );

  // 追加したビューも、そのままの URL で開ける(ビュー一覧経由でなくても解釈される)。
  await page.goto(viewUrl(app, addedView.id));
  await expect(page.getByTestId("list-table").locator("thead th")).toHaveText([addedField.name]);
  await expect(page.getByTestId("list-row")).toHaveCount(1);
});
