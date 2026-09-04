/**
 * list_view の E2E(V0-P3-T04 の検証方法)。
 *
 * 実ブラウザで「マニフェストに定義された列・ソート順・フィルタ結果」が期待と
 * 一致することを確認する。期待値は**フィクスチャの JSON から導く**ので、この
 * テストにもアプリ固有の名前は書かれていない(CP-3 確認方法4)。マニフェストを
 * 差し替えれば期待値も自動的に変わる ―― それが解釈実行であることの確認になる。
 *
 * データは API 経由で投入する。アプリはテストごとに払い出す(`fixture-app.ts`)ので、
 * 一覧に出るのは**このテストが投入したレコードだけ**であり、行数の期待値は自分が
 * 投入したデータから導ける。他のテストが何件作ろうと影響を受けない。
 */
import { expect, test } from "@playwright/test";
import type { Field, ListView, Table } from "../../src/kernel/types.ts";
import { normalizeSort } from "../../src/kernel/types.ts";
import {
  buildRecord,
  ensureReferenceTargets,
  type FixtureApp,
  fixture,
  fixturePath,
  provisionApp,
  type ReferenceIds,
  referenceLabelField,
  sampleValue,
} from "./fixture-app.ts";

/**
 * 検証対象の list_view を選ぶ。sort / filter が定義されているものを優先するのは、
 * 「定義どおりの列・ソート順・フィルタ結果」を一番よく確かめられるため。
 */
function targetListView(): ListView {
  const listViews = fixture.app.views.filter((view): view is ListView => view.type === "list_view");
  const score = (view: ListView): number =>
    (view.sort === undefined ? 0 : 2) + (view.filter === undefined ? 0 : 1);
  const chosen = [...listViews].sort((left, right) => score(right) - score(left))[0];
  if (chosen === undefined) {
    throw new Error(`フィクスチャに list_view がありません: ${fixturePath}`);
  }
  return chosen;
}

function tableOf(tableId: string): Table {
  const table = fixture.app.tables.find((candidate) => candidate.id === tableId);
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

/** フィルタ条件に**合致しない**値(除外されることを確かめる行に使う)。 */
function nonMatchingValue(field: Field, equals: string | number | boolean): unknown {
  if (typeof equals === "boolean") {
    return !equals;
  }
  if (typeof equals === "number") {
    return equals + 1;
  }
  if (field.type === "select") {
    return field.options.find((option) => option !== equals) ?? null;
  }
  return `${equals}-not-matching`;
}

const view = targetListView();
const table = tableOf(view.table);
const columns = view.columns.map((columnId) => fieldOf(table, columnId));
// sort は単数オブジェクトでも配列でも書ける(V1-M0-T03)。E2E の期待順の組み立ては
// 1キーぶんしか書いていないので、複数キーのフィクスチャが来たら黙って第1キーだけを
// 見て通す(= 検証が薄くなる)ことのないよう、ここで落とす。
const sortKeys = normalizeSort(view.sort);
if (sortKeys.length > 1) {
  throw new Error(
    `このE2Eは1キーの sort しか検証できません(${sortKeys.length}キーのフィクスチャ: ${fixturePath})。複合ソートの検証は web/test/composite-sort.test.tsx にある`,
  );
}
const sort = sortKeys[0];
// フィクスチャの list_view.filter は等値AND配列(後方互換形)。この e2e は等値前提で
// 行のプリセット・件数を検算するため、ブール式(EC-G12 / ADR-0043)のときは空配列に倒す。
const filter = Array.isArray(view.filter) ? view.filter : [];

/** 投入するレコード。index が大きいほどソート対象の値が大きい。index 0 だけフィルタに合致しない。 */
const ROW_COUNT = 3;
function buildRecords(referenceIds: ReferenceIds): Record<string, unknown>[] {
  return Array.from({ length: ROW_COUNT }, (_unused, index) => {
    const record = buildRecord(table, index, referenceIds);
    for (const condition of filter) {
      const field = fieldOf(table, condition.field);
      record[condition.field] =
        index === 0 ? nonMatchingValue(field, condition.equals) : condition.equals;
    }
    if (sort !== undefined) {
      const sortField = fieldOf(table, sort.field);
      record[sort.field] = sampleValue(sortField, index, referenceIds);
    }
    return record;
  });
}

/** 1列目に表示される値(行の同定に使う)。 */
function firstColumnText(record: Record<string, unknown>): string {
  const first = columns[0];
  if (first === undefined) {
    throw new Error("フィクスチャの list_view に columns がありません");
  }
  return String(record[first.id]);
}

const viewUrl = (app: FixtureApp): string => `/apps/${app.appId}/views/${view.id}`;

/** このテストが使うレコード一式を投入し、参照先IDと投入内容を返す。 */
async function seed(app: FixtureApp): Promise<{
  referenceIds: ReferenceIds;
  records: Record<string, unknown>[];
}> {
  // reference の列があれば、参照先レコードを先に作っておく(代表値の表示を確かめるため)。
  const referenceIds = await ensureReferenceTargets(app, app.tableOf(table.id));
  const records = buildRecords(referenceIds);
  for (const record of records) {
    await app.createRecord(table.id, record);
  }
  return { referenceIds, records };
}

test("定義された列・ソート順・フィルタ結果どおりに一覧が表示され、行から詳細に遷移できる", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());

  // 投入前の一覧は**空**である。ここが空でなければ、テストが自分専用のアプリを
  // 持てていない(＝他のテストの残骸が混ざっている)ということなので、
  // 以降の行数の期待値も信用できない。先に落としておく。
  await page.goto(viewUrl(app));
  await expect(page.getByTestId("list-empty")).toBeVisible();
  await expect(page.getByTestId("list-row")).toHaveCount(0);

  const { referenceIds, records } = await seed(app);

  await page.goto(viewUrl(app));

  // 列: columns の順に、Field の表示名が並ぶ。
  const headers = page.getByTestId("list-table").locator("thead th");
  await expect(headers).toHaveText(columns.map((field) => field.name));

  // フィルタ: 定義されていれば、合致しない index 0 の行は現れない。
  const rows = page.getByTestId("list-row");
  const hasFilter = filter.length > 0;
  const expectedRecords = hasFilter ? records.slice(1) : records;
  await expect(rows).toHaveCount(expectedRecords.length);
  if (hasFilter) {
    const excluded = records[0];
    if (excluded !== undefined) {
      await expect(page.getByTestId("list-table")).not.toContainText(firstColumnText(excluded));
    }
  }

  // ソート: サーバが返した順序(sort の定義どおり)で並ぶ。
  const ordered = sort?.order === "desc" ? [...expectedRecords].reverse() : [...expectedRecords];
  for (const [index, record] of ordered.entries()) {
    await expect(rows.nth(index)).toContainText(firstColumnText(record));
  }

  // reference の列があれば、参照先の代表値が出ていて生の ID は出ていない。
  for (const column of columns) {
    if (column.type !== "reference") {
      continue;
    }
    const target = tableOf(column.reference_table);
    const labelField = referenceLabelField(target);
    const referenceId = referenceIds.get(column.reference_table);
    if (labelField === undefined || referenceId === undefined) {
      continue;
    }
    const cell = rows.first().locator(`td[data-field="${column.id}"]`);
    await expect(cell).toHaveText(String(sampleValue(labelField, 0, referenceIds)));
    await expect(cell).not.toContainText(referenceId);
  }

  // 行クリックで detail_view に遷移する。**どのレコードを開いたかが URL に載る**
  // (V0-P3-T06 でレコードID を `Route` の第一級の要素にした)。詳細の中身は
  // detail-view.e2e.ts の担当なので、ここでは遷移先の URL だけを見る。
  const detailView = fixture.app.views.find(
    (candidate) => candidate.type === "detail_view" && candidate.table === table.id,
  );
  if (detailView !== undefined) {
    await rows.first().click();
    await expect(page).toHaveURL(
      new RegExp(`/apps/${app.appId}/views/${detailView.id}/records/[^/]+$`),
    );
  }
});

/**
 * テスト間の独立そのものを検証する回帰テスト。
 *
 * 以前は全テストが1つのアプリを共有していたため、form の E2E が作ったレコードが
 * この一覧に現れ、「行数はちょうど N」の期待が実行順序で壊れていた。ここでは
 * **わざと別のアプリに大量のゴミレコードを作ってから**同じ一覧を見て、行数も内容も
 * 一切変わらないことを確かめる。共有 dataRoot に戻ったらこのテストが落ちる。
 */
test("他のテストがレコードを残しても一覧の行数と内容は変わらない", async ({ page, request }) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());
  const { records } = await seed(app);
  const expectedRecords = filter.length > 0 ? records.slice(1) : records;

  await page.goto(viewUrl(app));
  const rows = page.getByTestId("list-row");
  await expect(rows).toHaveCount(expectedRecords.length);

  // 別のテストが同じフィクスチャで動いた状況を再現する(同じテーブルに、
  // フィルタにも合致する行を投入する)。
  const noisy = await provisionApp(request);
  const noisyReferenceIds = await ensureReferenceTargets(noisy, noisy.tableOf(table.id));
  for (let index = 0; index < 5; index += 1) {
    const record = buildRecord(table, index, noisyReferenceIds);
    for (const condition of filter) {
      record[condition.field] = condition.equals;
    }
    await noisy.createRecord(table.id, record);
  }

  await page.reload();
  await expect(rows).toHaveCount(expectedRecords.length);
  for (const [index, record] of (sort?.order === "desc"
    ? [...expectedRecords].reverse()
    : expectedRecords
  ).entries()) {
    await expect(rows.nth(index)).toContainText(firstColumnText(record));
  }
});
