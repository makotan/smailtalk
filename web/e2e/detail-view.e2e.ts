/**
 * detail_view の E2E(V0-P3-T06 の検証方法そのもの)。
 *
 *   一覧 → 詳細 → 編集 → 保存 → 詳細に反映 → 削除 → 一覧から消える
 *
 * 対象のビュー・テーブル・フィールドはすべて**フィクスチャの JSON から導く**ので、
 * このテストにもアプリ固有の名前は書かれていない(CP-3 確認方法4)。マニフェストを
 * 差し替えれば対象も期待値も自動的に変わる ―― それが解釈実行であることの確認になる。
 *
 * アプリはテストごとに払い出す(`fixture-app.ts`)ので、ここで作った/消したレコードが
 * 他のテストに影響することも、その逆もない。
 */
import { expect, test } from "@playwright/test";
import type { DetailView, Field, FormView, ListView, Table } from "../../src/kernel/types.ts";
import {
  buildRecord,
  ensureReferenceTargets,
  fixture,
  provisionApp,
  referenceLabelField,
  sampleValue,
} from "./fixture-app.ts";

function tableOf(tableId: string): Table {
  const table = fixture.app.tables.find((candidate) => candidate.id === tableId);
  if (table === undefined) {
    throw new Error(`フィクスチャが壊れています: テーブル ${tableId} がありません。`);
  }
  return table;
}

/**
 * 検証対象一式を選ぶ。
 *
 * 「一覧 → 詳細 → 編集 → 削除」を通すので、同じテーブルの list_view / form / detail_view
 * が揃っていて、かつ**行を同定できる text フィールド**(一覧の列にもフォームの入力欄にも
 * 出るもの)を持つ組み合わせを採る。
 */
function pickTarget(): {
  detail: DetailView;
  list: ListView;
  form: FormView;
  table: Table;
  markerField: Field;
} {
  for (const view of fixture.app.views) {
    if (view.type !== "detail_view") {
      continue;
    }
    const list = fixture.app.views.find(
      (candidate): candidate is ListView =>
        candidate.type === "list_view" && candidate.table === view.table,
    );
    const form = fixture.app.views.find(
      (candidate): candidate is FormView =>
        candidate.type === "form" && candidate.table === view.table,
    );
    if (list === undefined || form === undefined) {
      continue;
    }
    const table = tableOf(view.table);
    const markerField = table.fields.find(
      (field) =>
        field.type === "text" && list.columns.includes(field.id) && form.fields.includes(field.id),
    );
    if (markerField === undefined) {
      continue;
    }
    return { detail: view, list, form, table, markerField };
  }
  throw new Error(
    "フィクスチャに「一覧・フォーム・詳細が揃ったテーブル」がありません(このテストの前提)。",
  );
}

const { detail, list, form, table, markerField } = pickTarget();

test("一覧→詳細→編集→保存→詳細に反映、削除→一覧から消える", async ({ page, request }) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());

  /** レコード1件の詳細 URL。`route.ts` の URL 形式に合わせる。 */
  const detailUrl = (recordId: string): string =>
    `/apps/${app.appId}/views/${detail.id}/records/${recordId}`;
  const listUrl = `/apps/${app.appId}/views/${list.id}`;

  const marker = `e2e-detail-${Date.now()}`;
  const editedMarker = `${marker}-edited`;

  // reference があれば参照先レコードを先に作る(詳細で代表値が出ることを確かめるため)。
  const referenceIds = await ensureReferenceTargets(app, app.tableOf(table.id));

  // 全フィールドに値の入ったレコードを1件作る。一覧の filter に合致させて必ず出るようにする。
  const record = buildRecord(table, 0, referenceIds);
  // フィクスチャの filter は等値AND配列(後方互換形)。ブール式(EC-G12 / ADR-0043)は扱わない。
  if (Array.isArray(list.filter)) {
    for (const condition of list.filter) {
      record[condition.field] = condition.equals;
    }
  }
  record[markerField.id] = marker;
  const recordId = await app.createRecord(table.id, record);

  // 参照先レコードが同じテーブルにも作られている(自己参照)場合だけ、一覧には
  // このテストが作った行が他にも並ぶ。それ以外では「いま作った1件だけ」になる。
  const soleRow = !referenceIds.has(table.id);

  // --- 一覧 → 詳細 ---------------------------------------------------------------
  await page.goto(listUrl);
  // このアプリはこのテスト専用なので、一覧に出るのはいま作った1件だけ。
  if (soleRow) {
    await expect(page.getByTestId("list-row")).toHaveCount(1);
  }
  const row = page.getByTestId("list-row").filter({ hasText: marker });
  await expect(row).toHaveCount(1);
  await row.click();

  // どのレコードを開いたかが URL に載っている(リロードで戻れる = T07 の前提)。
  await expect(page).toHaveURL(new RegExp(`${detailUrl(recordId)}$`));
  await expect(page.getByTestId("view-renderer-detail_view")).toBeVisible();

  // 対象テーブルの全フィールドが出る(このビューは fields を指定していないため。V1-M0-T09 完了条件2)。
  for (const field of table.fields) {
    await expect(page.getByTestId(`detail-field-${field.id}`)).toBeVisible();
  }
  await expect(page.getByTestId(`detail-field-${markerField.id}`)).toHaveText(marker);

  // reference は生の ID ではなく参照先の代表値で出る。
  for (const field of table.fields) {
    if (field.type !== "reference") {
      continue;
    }
    const referenceId = referenceIds.get(field.reference_table);
    const labelField = referenceLabelField(tableOf(field.reference_table));
    if (referenceId === undefined || labelField === undefined) {
      continue;
    }
    const cell = page.getByTestId(`detail-field-${field.id}`);
    await expect(cell).toHaveText(String(sampleValue(labelField, 0, referenceIds)));
    await expect(cell).not.toContainText(referenceId);
  }

  // リロードしても同じレコードの詳細に戻る。
  await page.reload();
  await expect(page.getByTestId(`detail-field-${markerField.id}`)).toHaveText(marker);

  // --- 詳細 → 編集 → 保存 → 詳細に反映 -------------------------------------------
  await page.getByTestId("detail-edit").click();
  await expect(page).toHaveURL(
    new RegExp(`/apps/${app.appId}/views/${form.id}/records/${recordId}$`),
  );

  // 入力欄の DOM id は `<view_id>-<field_id>`(FormRenderer と同じ規則)。既存値が入っている。
  const input = page.locator(`#${form.id}-${markerField.id}`);
  await expect(input).toHaveValue(marker);
  await input.fill(editedMarker);
  await page.getByRole("button", { name: "保存" }).click();

  // 編集は詳細から来ているので、保存後は同じレコードの詳細に戻り、結果が反映されている。
  await expect(page).toHaveURL(new RegExp(`${detailUrl(recordId)}$`));
  await expect(page.getByTestId(`detail-field-${markerField.id}`)).toHaveText(editedMarker);

  // --- 削除 → 一覧から消える -----------------------------------------------------
  await page.getByTestId("detail-delete").click();
  // 確認を挟む(押した瞬間には消えない)。
  await expect(page.getByTestId("detail-delete-confirm")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${detailUrl(recordId)}$`));

  await page.getByTestId("detail-delete-execute").click();
  await expect(page).toHaveURL(new RegExp(`${listUrl}$`));
  await expect(page.getByTestId("list-row").filter({ hasText: editedMarker })).toHaveCount(0);
  // 消したのは1件だけで、他の行が巻き添えになっていないこと(このアプリは空になる)。
  if (soleRow) {
    await expect(page.getByTestId("list-row")).toHaveCount(0);
  }

  // 実際に消えていることは API でも確認する(画面だけの見かけでないこと)。
  const response = await request.get(
    `/api/apps/${app.appId}/tables/${table.id}/records/${recordId}`,
    { headers: app.authHeaders },
  );
  expect(response.status()).toBe(404);
});

/**
 * 表示項目の指定(V1-M0-T09 / v0 所見 F-3)の E2E。
 *
 * v0 では `detail_view` に表示項目を指定する手段が無く、AI は4試行すべてで
 * `fields` → `columns` の順に推測して2回連続で弾かれていた(F-15)。
 * V1-M0-T09 が `fields` の `false` だけを解除した。ここで見るのは2つ:
 *
 *   1. `fields` を指定したビューでは、指定した項目だけが指定した順に出る
 *   2. `fields` を指定していない**既存の**ビューは、従来どおり全項目を出す
 *
 * ビューは**製品の `/api/apps/:app_id/diffs`(add_view)**で足す。フィクスチャの
 * JSON を書き換えないので、「既存マニフェストが無改変で従来どおり動く」ことが
 * 同じアプリの中で並べて確認できる(完了条件2)。
 *
 * どのフィールドを出す/隠すかはフィクスチャから機械的に導く。アプリ固有の名前は書かない。
 */
test("detail_view の fields で表示項目を絞れ、指定しないビューは全項目のまま", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());
  const referenceIds = await ensureReferenceTargets(app, app.tableOf(table.id));

  const marker = `e2e-detail-fields-${Date.now()}`;
  const record = buildRecord(table, 0, referenceIds);
  record[markerField.id] = marker;
  const recordId = await app.createRecord(table.id, record);

  // 出す項目は「行を同定できる marker + テーブル定義の最後のフィールド」の2つ。
  // 定義順の先頭と末尾を採るので、**並べ替えが効いていること**も同時に見られる。
  const last = table.fields[table.fields.length - 1];
  if (last === undefined) {
    throw new Error("フィクスチャが壊れています: フィールドが無い");
  }
  const shown = last.id === markerField.id ? [markerField] : [last, markerField];
  const hidden = table.fields.filter((field) => !shown.some((s) => s.id === field.id));
  expect(hidden.length, "隠れる項目が1つも無いと、このテストは何も確かめていない").toBeGreaterThan(
    0,
  );

  // --- fields 付きの detail_view を稼働中のアプリに足す ---------------------------
  const pickedViewId = `${detail.id}-picked`;
  const applied = await request.post(`/api/apps/${app.appId}/diffs`, {
    headers: app.authHeaders,
    data: {
      diff_id: `d-e2e-detail-fields-${Date.now()}`,
      intent: "詳細画面に出す項目を絞りたい",
      operations: [
        {
          op: "add_view",
          view: {
            id: pickedViewId,
            type: "detail_view",
            table: table.id,
            fields: shown.map((field) => field.id),
          },
        },
      ],
    },
  });
  expect(applied.status(), await applied.text()).toBe(201);

  // --- 1. 指定した項目だけが、指定した順に出る -----------------------------------
  await page.goto(`/apps/${app.appId}/views/${pickedViewId}/records/${recordId}`);
  await expect(page.getByTestId("view-renderer-detail_view")).toBeVisible();
  await expect(page.getByTestId("detail-fields").locator("[data-field]")).toHaveCount(shown.length);
  await expect(page.getByTestId("detail-fields").locator("[data-field]").first()).toHaveAttribute(
    "data-field",
    shown[0]?.id ?? "",
  );
  for (const field of shown) {
    await expect(page.getByTestId(`detail-field-${field.id}`)).toBeVisible();
  }
  for (const field of hidden) {
    await expect(page.getByTestId(`detail-field-${field.id}`)).toHaveCount(0);
  }
  await expect(page.getByTestId(`detail-field-${markerField.id}`)).toHaveText(marker);

  // --- 2. fields を指定していない既存のビューは全項目のまま -----------------------
  await page.goto(`/apps/${app.appId}/views/${detail.id}/records/${recordId}`);
  for (const field of table.fields) {
    await expect(page.getByTestId(`detail-field-${field.id}`)).toBeVisible();
  }
});

/**
 * V1-M0-T09 の追補: `detail_view.fields` の非対称を閉じたことの実機確認。
 *
 * 1. 不在フィールドIDは **`apply_diff` の時点で**弾かれる(以前は 201 で通り、
 *    詳細画面を開いた時点で初めてエラーになっていた)
 * 2. `update_view` で **後から** `fields` を差し替えられる(以前は add_view のみ)
 */
test("detail_view の fields は書き込み時に検証され、update_view で後から変更できる", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());
  const referenceIds = await ensureReferenceTargets(app, app.tableOf(table.id));

  const marker = `e2e-detail-update-${Date.now()}`;
  const record = buildRecord(table, 0, referenceIds);
  record[markerField.id] = marker;
  const recordId = await app.createRecord(table.id, record);

  const viewId = `${detail.id}-updatable`;

  // --- 1. 不在フィールドIDを含む add_view は 201 にならない ----------------------
  const rejected = await request.post(`/api/apps/${app.appId}/diffs`, {
    headers: app.authHeaders,
    data: {
      diff_id: `d-e2e-detail-bad-${Date.now()}`,
      intent: "存在しない項目を詳細に出そうとする",
      operations: [
        {
          op: "add_view",
          view: {
            id: viewId,
            type: "detail_view",
            table: table.id,
            fields: ["definitely-not-a-field"],
          },
        },
      ],
    },
  });
  expect(rejected.status(), await rejected.text()).not.toBe(201);
  const rejectedBody = (await rejected.json()) as { errors?: { message?: string }[] };
  expect(JSON.stringify(rejectedBody)).toContain("definitely-not-a-field");

  // 弾かれたのだから、ビューは1つも増えていない。
  await page.goto(`/apps/${app.appId}/views/${viewId}/records/${recordId}`);
  await expect(page.getByTestId("detail-fields")).toHaveCount(0);

  // --- 2. 正しい fields なら通る -------------------------------------------------
  const created = await request.post(`/api/apps/${app.appId}/diffs`, {
    headers: app.authHeaders,
    data: {
      diff_id: `d-e2e-detail-ok-${Date.now()}`,
      intent: "詳細に marker だけ出したい",
      operations: [
        {
          op: "add_view",
          view: { id: viewId, type: "detail_view", table: table.id, fields: [markerField.id] },
        },
      ],
    },
  });
  expect(created.status(), await created.text()).toBe(201);

  await page.goto(`/apps/${app.appId}/views/${viewId}/records/${recordId}`);
  await expect(page.getByTestId("detail-fields").locator("[data-field]")).toHaveCount(1);
  await expect(page.getByTestId(`detail-field-${markerField.id}`)).toHaveText(marker);

  // --- 3. update_view で後から差し替えられる ------------------------------------
  const other = table.fields.find((field) => field.id !== markerField.id);
  if (other === undefined) {
    throw new Error("フィクスチャが壊れています: フィールドが1つしかない");
  }
  const updated = await request.post(`/api/apps/${app.appId}/diffs`, {
    headers: app.authHeaders,
    data: {
      diff_id: `d-e2e-detail-update-${Date.now()}`,
      intent: "詳細に出す項目を増やしたい",
      operations: [
        { op: "update_view", view: viewId, changes: { fields: [markerField.id, other.id] } },
      ],
    },
  });
  expect(updated.status(), await updated.text()).toBe(201);

  await page.goto(`/apps/${app.appId}/views/${viewId}/records/${recordId}`);
  await expect(page.getByTestId("detail-fields").locator("[data-field]")).toHaveCount(2);
  await expect(page.getByTestId(`detail-field-${other.id}`)).toBeVisible();
});

/**
 * **値が無いときの行ごとの非表示**(`V4-M19-T08`。`E-G17` / `D-V4-84` の一部 / `ADR-0119`
 * 限定3 / 限定4 / 限定5)。
 *
 * **本物のサーバ・本物の SQLite・本物のブラウザで1件確かめる**(完了条件4)。
 * `web/test/field-hide-when-empty.test.tsx` は happy-dom であって、実データを1件も持たない。
 *
 * **【禁止】「空の項目が消えるようになった」と読まない** —— **消えるのは未設定のときだけで、
 * 空文字は今日も「値がある」側である**(`ADR-0119` §Decision 5 の 3)。
 */
test("hide_when_empty を書いた項目は、値が無いとき詳細画面から行ごと消える(空文字では消えない)", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());
  const referenceIds = await ensureReferenceTargets(app, app.tableOf(table.id));

  // **必須でない文字列の項目を1つ選ぶ** —— そこに宣言を書き、目印の項目には書かない。
  // **空文字を書ける型でなければ (3) が測れない**ので `text` / `long_text` に絞る。
  const declared = table.fields.find(
    (field) =>
      (field.type === "text" || field.type === "long_text") &&
      field.required !== true &&
      field.id !== markerField.id,
  );
  if (declared === undefined) {
    throw new Error("フィクスチャが壊れています: 宣言に使える任意の文字列項目がありません");
  }

  const marker = `e2e-hide-${Date.now()}`;
  const record = buildRecord(table, 0, referenceIds);
  record[markerField.id] = marker;
  // **未設定にする** —— カーネルは書かれなかった任意項目を `null` として持つ。
  delete record[declared.id];
  const recordId = await app.createRecord(table.id, record);

  const viewId = `${detail.id}-hide-when-empty`;
  const created = await request.post(`/api/apps/${app.appId}/diffs`, {
    headers: app.authHeaders,
    data: {
      diff_id: `d-e2e-hide-${Date.now()}`,
      intent: "値の無い項目の行を詳細画面から出さないようにしたい",
      operations: [
        {
          op: "add_view",
          view: {
            id: viewId,
            type: "detail_view",
            table: table.id,
            fields: [markerField.id, declared.id],
          },
        },
      ],
    },
  });
  expect(created.status(), await created.text()).toBe(201);

  // --- 1. 宣言する前は、値が無くても「未設定」の行が出る(既定を反転させていない)---
  await page.goto(`/apps/${app.appId}/views/${viewId}/records/${recordId}`);
  await expect(page.getByTestId("detail-fields").locator("[data-field]")).toHaveCount(2);
  await expect(page.getByTestId(`detail-field-${declared.id}`)).toHaveText("未設定");

  // --- 2. change_field で宣言すると、行ごと消える(dt も dd も出ない)---
  const declaredDiff = await request.post(`/api/apps/${app.appId}/diffs`, {
    headers: app.authHeaders,
    data: {
      diff_id: `d-e2e-hide-on-${Date.now()}`,
      intent: "この項目は値が無いなら出さない",
      operations: [
        {
          op: "change_field",
          table: table.id,
          field: declared.id,
          changes: { hide_when_empty: true },
        },
      ],
    },
  });
  expect(declaredDiff.status(), await declaredDiff.text()).toBe(201);

  await page.goto(`/apps/${app.appId}/views/${viewId}/records/${recordId}`);
  await expect(page.getByTestId("detail-fields").locator("[data-field]")).toHaveCount(1);
  await expect(page.getByTestId(`detail-field-${declared.id}`)).toHaveCount(0);
  // **項目名(`dt`)も一緒に消えている**(限定5。「ラベルだけ残して空欄」を作らない)。
  await expect(page.getByTestId("detail-fields").getByText(declared.name)).toHaveCount(0);
  // **宣言しなかった項目は今日どおり出る。**
  await expect(page.getByTestId(`detail-field-${markerField.id}`)).toHaveText(marker);

  // --- 3. 空文字を入れた別の行では、同じ宣言でも行が残る(限定3。空文字は「値がある」側)---
  // **同じ画面・同じ宣言のまま、値だけが違う行を1件足して見比べる。**
  const emptyStringRecord = buildRecord(table, 1, referenceIds);
  emptyStringRecord[markerField.id] = `${marker}-empty`;
  emptyStringRecord[declared.id] = "";
  const emptyStringId = await app.createRecord(table.id, emptyStringRecord);
  await page.goto(`/apps/${app.appId}/views/${viewId}/records/${emptyStringId}`);
  await expect(page.getByTestId("detail-fields").locator("[data-field]")).toHaveCount(2);
  await expect(page.getByTestId(`detail-field-${declared.id}`)).toHaveCount(1);
  // **「未設定」とも出ない** —— 空文字は値なので、空文字そのものが描かれる。
  await expect(page.getByTestId(`detail-field-${declared.id}`)).toHaveText("");
});
