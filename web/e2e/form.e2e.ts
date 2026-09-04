/**
 * form 汎用コンポーネントの E2E(V0-P3-T05 の検証方法)。
 *
 * 1. 作成 → 保存すると実際にレコードができ、同じテーブルの一覧ビューへ戻る
 * 2. required 違反 → 該当フィールドの直下にカーネルのエラーが出る
 *
 * 期待値はすべて**フィクスチャの JSON から導く**。どのアプリを載せても同じテストが
 * 成立することが、解釈実行(憲法3)であることの確認になっている。
 *
 * 作成結果の確認は「一覧画面に出ること」ではなく **API に問い合わせて確認する**。
 * 一覧の描画は V0-P3-T04 の担当であり、そちらの実装状況にこのテストの成否を
 * 依存させないため(このテストが見たいのは「フォームが書き込めたか」だけ)。
 *
 * アプリはテストごとに払い出す(`fixture-app.ts`)ので、ここで作ったレコードが
 * 他のテストの一覧に現れることはない。
 */
import { expect, type Page, test } from "@playwright/test";
import type { Field, FormView, ListView, Table } from "../../src/kernel/types.ts";
import {
  ensureReferenceTargets,
  type FixtureApp,
  fixture,
  provisionApp,
  type ReferenceIds,
  sampleValue,
} from "./fixture-app.ts";

function tableOf(tableId: string): Table {
  const table = fixture.app.tables.find((candidate) => candidate.id === tableId);
  if (table === undefined) {
    throw new Error(`フィクスチャが壊れています: テーブル ${tableId} がありません。`);
  }
  return table;
}

function formFields(view: FormView): Field[] {
  return view.fields.flatMap((fieldId) => {
    const field = tableOf(view.table).fields.find((candidate) => candidate.id === fieldId);
    return field === undefined ? [] : [field];
  });
}

/**
 * 検証に使う form: 必須フィールドを持つ最初の form。
 *
 * required 違反を「入力欄を空のまま送る」で作れる必要があるので、reference 以外の
 * 必須フィールドを1つ以上持つものを選ぶ。**必須の reference を含んでいても構わない**
 * ―― 保存を通すほうのテストは参照先レコードを先に作って埋める。
 */
const form = fixture.app.views.find(
  (view): view is FormView =>
    view.type === "form" &&
    formFields(view).some((field) => field.required === true && field.type !== "reference"),
);
if (form === undefined) {
  throw new Error("フィクスチャに必須フィールドを持つ form がありません。");
}
const targetForm = form;

const listView = fixture.app.views.find(
  (view): view is ListView => view.type === "list_view" && view.table === targetForm.table,
);

/** 入力欄の DOM id は `<view_id>-<field_id>`(FormRenderer と同じ規則)。 */
function inputSelector(field: Field): string {
  return `#${targetForm.id}-${field.id}`;
}

/**
 * フィールド1つを型に応じた手段で埋める。**7型すべて**に対応する。
 *
 * 値そのものは `fixture-app.ts` の `sampleValue` が決める(一覧・詳細のテストと
 * 同じ規則)。ここが持つのは「その値をどの UI 操作で入れるか」だけ。
 * `reference` は選択肢の `value` が参照先レコードの `_id` なので、
 * `ensureReferenceTargets` が先に作った ID をそのまま選ぶ。
 */
async function fillField(
  page: Page,
  field: Field,
  index: number,
  referenceIds: ReferenceIds,
): Promise<void> {
  const value = sampleValue(field, index, referenceIds);
  if (value === null) {
    return;
  }
  const selector = inputSelector(field);
  switch (field.type) {
    case "boolean":
      if (value === true) {
        await page.check(selector);
      } else {
        await page.uncheck(selector);
      }
      return;
    case "select":
    case "reference":
      await page.selectOption(selector, String(value));
      return;
    default:
      await page.fill(selector, String(value));
  }
}

function formUrl(app: FixtureApp): string {
  return `/apps/${app.appId}/views/${targetForm.id}`;
}

async function openForm(page: Page, app: FixtureApp): Promise<void> {
  await page.goto(formUrl(app));
  await expect(page.getByTestId("view-renderer-form")).toBeVisible();
}

test("フォームから作成するとレコードができ、一覧ビューへ戻る", async ({ page, request }) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());
  const marker = `e2e-${Date.now()}`;

  // 参照先レコードはフォームを開く**前**に作る。reference のピッカーはマウント時に
  // 選択肢を取りに行くので、後から作っても選択肢には出てこない。
  const referenceIds = await ensureReferenceTargets(app, app.tableOf(targetForm.table));

  await openForm(page, app);

  const required = formFields(targetForm).filter((field) => field.required === true);
  const textField = required.find((field) => field.type === "text");
  expect(textField).toBeDefined();

  for (const field of required) {
    await fillField(page, field, 0, referenceIds);
  }
  // 行の同定に使う text フィールドだけ、この実行に固有の目印で上書きする。
  if (textField !== undefined) {
    await page.fill(inputSelector(textField), marker);
  }

  await page.getByRole("button", { name: "保存" }).click();

  // 同じテーブルの list_view があればそこへ、無ければアプリのビュー一覧へ戻る。
  const expectedPath =
    listView === undefined ? `/apps/${app.appId}` : `/apps/${app.appId}/views/${listView.id}`;
  await expect(page).toHaveURL(new RegExp(`${expectedPath}$`));

  // 実際に書き込まれたことは API で確認する(一覧の描画は T04 の担当)。
  const response = await page.request.get(
    `/api/apps/${app.appId}/tables/${targetForm.table}/records`,
  );
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { records: Record<string, unknown>[] };
  const created = body.records.filter((record) => record[String(textField?.id)] === marker);
  // フォームが作ったのはちょうど1件(自分専用のアプリなので他のテストの分は混ざらない)。
  expect(created).toHaveLength(1);

  // 必須フィールドは**すべて**保存されている(required な reference も含む)。
  for (const field of required) {
    expect(created[0]?.[field.id] ?? null).not.toBeNull();
  }
});

test("required 違反は該当フィールドの直下に表示される", async ({ page, request }) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());
  await openForm(page, app);

  const requiredField = formFields(targetForm).find(
    (field) => field.required === true && field.type !== "reference",
  );
  expect(requiredField).toBeDefined();
  if (requiredField === undefined) {
    return;
  }

  // 何も入力せずに送る。フロントは送信をブロックせず、カーネルの判断を仰ぐ。
  await page.getByRole("button", { name: "保存" }).click();

  const fieldError = page.getByTestId(`field-error-${requiredField.id}`);
  await expect(fieldError).toBeVisible();
  await expect(fieldError).toContainText(requiredField.id);

  // 失敗したら画面は動かない。
  await expect(page).toHaveURL(new RegExp(`${formUrl(app)}$`));

  // 画面が動かないだけでなく、**レコードも1件もできていない**。
  const response = await request.get(`/api/apps/${app.appId}/tables/${targetForm.table}/records`, {
    headers: app.authHeaders,
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { records: unknown[] };
  expect(body.records).toHaveLength(0);
});
