/**
 * 稼働中アプリへの反映 E2E(V0-P4-T06 の完了条件そのもの)。
 *
 *   「サーバを再起動せずに apply_diff → ブラウザリロードで新フィールドが画面に現れ、
 *     undo → リロードで消える」
 *
 * ## このテストが「再起動なし・再ビルドなし」をどう保証しているか
 *
 * 構造だけで保証している。テスト本体がやることは次の3種類しかない:
 *
 *   - `request.post("/api/...")` … 稼働中サーバの**製品の HTTP API** を叩く
 *   - `page.reload()`            … 同じタブを再読み込みする
 *   - `expect(...)`              … 画面を見る
 *
 * サーバプロセスを起動するのは Playwright の `webServer`(`playwright.config.ts`)であり、
 * **テストファイルからはサーバを起動も停止も再起動もできない**(ハンドルを持っていない)。
 * フロントのビルドは `bun run test:e2e` が Playwright を呼ぶ**前**に1回走るだけで、
 * テスト中にビルドを起動する手段もない(`bun x vite build` の類はここに一切現れない)。
 * したがって (b) 適用 と (c) リロード のあいだに挟まれているものは何も無い。
 *
 * V0-P3-T07 の `manifest-reflection.e2e.ts` との違いは、変更の入口が
 * テスト専用の `__e2e__` 経路(カーネル直呼び)ではなく、**製品の `/api/apps/:app_id/diffs`**
 * であることと、`/api/apps/:app_id/undo` で元に戻るところまで見ることである。
 *
 * アプリは**テストごとに専用インスタンスを払い出す**(`provisionApp`)。apply_diff は
 * アプリの状態を恒久的に変えるので、共有アプリに対して行うと後続テストの前提を壊す。
 *
 * 追加する要素の名前はフィクスチャから機械的に導く。アプリ固有の名前は書かない。
 */
import { type APIRequestContext, expect, test } from "@playwright/test";
import type { ChangelogEntry } from "../../src/kernel/meta-store.ts";
import type { Diff, Field, ListView, Manifest, Table } from "../../src/kernel/types.ts";
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
 * 「一覧に新しい項目を出したい」という要望を表す差分(CP-4 の diff#2 と同じ形)。
 * additive な2操作だけ: フィールドを1つ足し、それを既存ビューの列に足す。
 */
function addFieldDiff(manifest: Manifest, view: ListView): { diff: Diff; addedField: Field } {
  const table = tableOf(manifest, view.table);
  const addedField: Field = {
    id: freshId(
      "field",
      table.fields.map((field) => field.id),
    ),
    name: "追加フィールド",
    type: "text",
  };
  return {
    addedField,
    diff: {
      diff_id: "add-column",
      intent: "一覧に項目をもう1つ出したい、という要望に応えて列を足した",
      operations: [
        { op: "add_field", table: table.id, field: addedField },
        {
          op: "update_view",
          view: view.id,
          changes: { columns: [...view.columns, addedField.id] },
        },
      ],
    },
  };
}

const viewUrl = (app: FixtureApp, viewId: string): string => `/apps/${app.appId}/views/${viewId}`;

async function changelogOf(request: APIRequestContext, app: FixtureApp): Promise<ChangelogEntry[]> {
  const response = await request.get(`/api/apps/${app.appId}/changelog`);
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as { changelog: ChangelogEntry[] };
  return body.changelog;
}

test("稼働中のサーバに apply_diff すると、リロードだけで新フィールドが画面に現れ、undo で消える", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());
  const view = targetListView(app.manifest);
  const table = tableOf(app.manifest, view.table);
  const beforeColumns = view.columns.map((columnId) => fieldOf(table, columnId));

  // --- (a) 適用前の画面。既存データを1件入れておく ---
  const referenceIds = await ensureReferenceTargets(app, table);
  const seeded = buildRecord(table, 1, referenceIds);
  // フィクスチャの list_view.filter は等値AND配列(後方互換形)。ブール式(EC-G12 /
  // ADR-0043)のときは葉のプリセットを行わない(この e2e は等値フィクスチャ前提)。
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

  const { diff, addedField } = addFieldDiff(app.manifest, view);
  await expect(page.getByTestId("list-table")).not.toContainText(addedField.name);
  // 差分適用前でも履歴は空ではない。create_app が第0行を書いている(V1-M0-T05 / F-28)。
  const beforeApply = await changelogOf(request, app);
  expect(beforeApply.map((entry) => entry.diff_id)).toEqual(["_create-app"]);
  expect(beforeApply[0]?.operations).toEqual([]);
  expect(beforeApply[0]?.snapshot).toBeNull();

  // --- (b) サーバは起動したまま、製品の HTTP API に差分を投げる ---
  //
  // ここでフロントを再ビルドしない・サーバを再起動しない・ページを開き直さない。
  const applied = await request.post(`/api/apps/${app.appId}/diffs`, {
    data: diff,
    headers: app.authHeaders,
  });
  expect(applied.status(), await applied.text()).toBe(201);

  // --- (c) リロードするだけで新しい列が現れる ---
  await page.reload();
  await expect(headers).toHaveText([...beforeColumns.map((f) => f.name), addedField.name]);

  // 既存データは無傷(additive な変更でレコードは消えない)。追加列は未設定。
  const rows = page.getByTestId("list-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(seededText);
  await expect(
    rows.first().locator(`td[data-field="${addedField.id}"] .field-empty`),
  ).toBeVisible();

  // 画面だけでなくスキーマも追随している(新しい列に値を書ける)。
  // 更新は楽観ロック(M9-T02)。現在の版を ETag で取り、If-Match に載せる。
  const current = await request.get(
    `/api/apps/${app.appId}/tables/${table.id}/records/${seededId}`,
    { headers: app.authHeaders },
  );
  const version = current.headers().etag;
  if (version === undefined) throw new Error("GET 応答に ETag(版)が無い");
  const written = await request.patch(
    `/api/apps/${app.appId}/tables/${table.id}/records/${seededId}`,
    {
      data: { [addedField.id]: addedField.name },
      headers: { ...app.authHeaders, "If-Match": version },
    },
  );
  expect(written.status(), await written.text()).toBe(200);
  await page.reload();
  await expect(rows.first().locator(`td[data-field="${addedField.id}"]`)).toHaveText(
    addedField.name,
  );

  // 履歴に意図が残っている(憲法5)。
  const afterApply = await changelogOf(request, app);
  // 最古行はアプリ作成、その次が今回の差分。
  expect(afterApply.map((entry) => entry.diff_id)).toEqual(["_create-app", diff.diff_id]);
  expect(afterApply[1]?.intent).toBe(diff.intent);

  // --- (d) undo の事前確認は参照系。GET で引けて、画面は変わらない ---
  const preview = await request.get(`/api/apps/${app.appId}/undo/preview`);
  expect(preview.status(), await preview.text()).toBe(200);
  const previewBody = (await preview.json()) as { preview: { diff_id: string; intent: string } };
  expect(previewBody.preview.diff_id).toBe(diff.diff_id);
  await page.reload();
  await expect(headers).toHaveText([...beforeColumns.map((f) => f.name), addedField.name]);

  // --- (e) undo → リロードだけで、追加した列が消える ---
  const undone = await request.post(`/api/apps/${app.appId}/undo`, { headers: app.authHeaders });
  expect(undone.status(), await undone.text()).toBe(200);

  await page.reload();
  await expect(headers).toHaveText(beforeColumns.map((field) => field.name));
  await expect(page.getByTestId("list-table")).not.toContainText(addedField.name);

  // undo は「その apply の直前の状態そのもの」を書き戻す(ADR-0004 §4)。
  // 適用前に入れておいたレコードは、適用前の状態で生きている。
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(seededText);

  // 取り消したことも履歴に残る(apply は消えない)。
  const afterUndo = await changelogOf(request, app);
  // 先頭は create_app の第0行(kind は "apply")。undo が指すのはその次の apply である。
  expect(afterUndo.map((entry) => entry.kind)).toEqual(["apply", "apply", "undo"]);
  expect(afterUndo.map((entry) => entry.diff_id)).toEqual([
    "_create-app",
    diff.diff_id,
    `undo-${diff.diff_id}`,
  ]);
  expect(afterUndo[2]?.undo_target_seq).toBe(afterUndo[1]?.seq ?? -1);
});
