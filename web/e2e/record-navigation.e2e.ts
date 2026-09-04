/**
 * レコード間の遷移の E2E(V3-M3-T02)。
 *
 *   親の詳細 → `related` の子行をクリック → 子の詳細
 *   子行の中の `reference` リンクをクリック → 参照先(親)の詳細
 *   子の詳細の項目の `reference` リンクをクリック → 参照先(親)の詳細
 *   **一覧の `reference` セルのリンクをクリック → 参照先(親)の詳細**(行の遷移は起きない)
 *
 * **単体(happy-dom)は描画を解かない。** 「画面で実際にクリックして遷移する」ことの実証は
 * ここ(chromium)が担う。**行クリックとセル内リンクが同じ行の中で交差する**ので、
 * リンクを押したときに行の遷移が起きないことも本物のブラウザで確かめる。
 *
 * 対象のテーブル・フィールド・ビューは**フィクスチャの JSON から機械的に導く**ので、
 * このテストにもアプリ固有の名前は書かれていない(CP-3 確認方法4)。ただし
 * フィクスチャは `related` も参照先の `detail_view` も持たないので、**払い出したアプリの
 * マニフェストだけを差し替えて**(`POST /__e2e__/apps/:app_id/manifest`。稼働中のサーバに
 * 対するテスト専用経路)遷移点を作る。**製品の HTTP API には引き続きマニフェストを
 * 変更する口は無い**(ADR-0003)。
 */
import { expect, type Page, test } from "@playwright/test";
import type { DetailView, Diff, Field, Manifest, Table } from "../../src/kernel/types.ts";
import { buildRecord, fixture, provisionApp } from "./fixture-app.ts";

/**
 * 「子テーブル → 親テーブル」の参照を1組選ぶ。
 *
 * 条件: 子テーブルが `reference` フィールドを持ち、その参照先が実在すること。
 * 併せて、行を同定できる `text` フィールドを子・親の両方から採る。
 */
function pickPair(manifest: Manifest): {
  child: Table;
  parent: Table;
  via: Field;
  childMarker: Field;
  parentMarker: Field;
} {
  for (const child of manifest.app.tables) {
    for (const via of child.fields) {
      if (via.type !== "reference") {
        continue;
      }
      const parent = manifest.app.tables.find((candidate) => candidate.id === via.reference_table);
      const childMarker = child.fields.find((field) => field.type === "text");
      const parentMarker = parent?.fields.find((field) => field.type === "text");
      if (parent === undefined || childMarker === undefined || parentMarker === undefined) {
        continue;
      }
      return { child, parent, via, childMarker, parentMarker };
    }
  }
  throw new Error("フィクスチャに「参照を持つテーブルの組」がありません(このテストの前提)。");
}

const { child, parent, via, childMarker, parentMarker } = pickPair(fixture);

/** 既存 ID と衝突しないビューID。 */
function freshViewId(base: string, taken: readonly string[]): string {
  let candidate = base;
  while (taken.includes(candidate)) {
    candidate = `${candidate}-x`;
  }
  return candidate;
}

/**
 * 遷移点を作ったマニフェスト。**足すのはビューだけ**(テーブルもフィールドも1つも足さない)。
 *
 * - 親テーブルの `detail_view` を2つ足す —— 1つ目が `related`(子一覧)を持つ。
 *   **2つあるのは「遷移先が2つ以上あるときの注記」を出させるため**であり、規約
 *   (定義順の先頭)により参照リンクの行き先は必ず1つ目である。
 * - 子テーブルの `detail_view` も2つになるようにする(同じ理由)。
 */
function extend(manifest: Manifest): {
  next: Manifest;
  parentDetailId: string;
  childDetailId: string;
} {
  const next = structuredClone(manifest);
  const taken = next.app.views.map((view) => view.id);

  const existingChildDetail = next.app.views.find(
    (view): view is DetailView => view.type === "detail_view" && view.table === child.id,
  );
  const childDetailId = existingChildDetail?.id ?? freshViewId(`${child.id}-detail`, taken);
  if (existingChildDetail === undefined) {
    next.app.views.push({ id: childDetailId, type: "detail_view", table: child.id });
    taken.push(childDetailId);
  }

  const parentDetailId = freshViewId(`${parent.id}-detail`, taken);
  next.app.views.push({
    id: parentDetailId,
    type: "detail_view",
    table: parent.id,
    related: [{ table: child.id, via: via.id, columns: [childMarker.id, via.id] }],
  });
  taken.push(parentDetailId);

  // 注記(遷移先が2つ以上)を出すための2本目。**規約により選ばれるのは常に定義順の先頭。**
  for (const [tableId, base] of [
    [child.id, `${child.id}-detail-2`],
    [parent.id, `${parent.id}-detail-2`],
  ] as const) {
    const id = freshViewId(base, taken);
    next.app.views.push({ id, type: "detail_view", table: tableId });
    taken.push(id);
  }

  return { next, parentDetailId, childDetailId };
}

/**
 * **作り手向けの注記が本物の chromium で1つも出ないこと**(`V10-M18-T02` / `FU-G2` /
 * ユーザ決定 `D-V10-21` =「出すのをやめる」)。
 *
 * **`data-testid` は3種ある**(器の class の既定は `.detail-target-note`)。
 * **`getByTestId` は完全一致なので、2種だけを数えると3種目が素通りする。**
 * **class の側も併せて数える** —— **CSS の規則そのものは撤去していない**(当たり先を
 * 1つも持たない規則1本が残る)ので、**class が付いた要素が0個であることを別に測る。**
 */
async function expectNoDetailTargetNotes(page: Page): Promise<void> {
  for (const testId of [
    "list-detail-target-note",
    "reference-detail-target-note",
    "related-detail-target-note",
  ]) {
    await expect(page.getByTestId(testId), testId).toHaveCount(0);
  }
  await expect(page.locator(".detail-target-note")).toHaveCount(0);
  await expect(page.locator(".list-detail-target-note")).toHaveCount(0);
}

test("親の詳細の子行から子の詳細へ、子行の参照リンクからは参照先へ(二重発火しない)", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());

  const { next, parentDetailId, childDetailId } = extend(app.manifest);
  const replaced = await request.post(`/__e2e__/apps/${app.appId}/manifest`, { data: next });
  expect(replaced.status(), await replaced.text()).toBe(200);

  const stamp = Date.now();
  const parentMark = `e2e-parent-${stamp}`;
  const childMark = `e2e-child-${stamp}`;

  // 親を1件、その親を指す子を1件作る。
  const parentRecord = buildRecord(app.tableOf(parent.id), 0, new Map());
  parentRecord[parentMarker.id] = parentMark;
  const parentId = await app.createRecord(parent.id, parentRecord);

  const childRecord = buildRecord(app.tableOf(child.id), 1, new Map([[parent.id, parentId]]));
  childRecord[childMarker.id] = childMark;
  childRecord[via.id] = parentId;
  const childId = await app.createRecord(child.id, childRecord);

  const detailUrl = (viewId: string, recordId: string): string =>
    `/apps/${app.appId}/views/${viewId}/records/${recordId}`;

  // --- 親の詳細に子一覧が出る ---------------------------------------------------
  await page.goto(detailUrl(parentDetailId, parentId));
  const row = page.getByTestId("related-row").filter({ hasText: childMark });
  await expect(row).toHaveCount(1);

  // 遷移先が2つ以上あるときの注記が、増えた遷移点にも出ている(D-M3-6)。
  //
  // **【`V10-M18-T02`(`FU-G2`)の追記。上の1行と、下の3行の意図を消していない】**
  // **ユーザ決定 `D-V10-21` が「出すのをやめる」を選んだので、注記は本物の chromium でも
  // 1つも出ない。** **`detail_view` は上の `extend()` が2枚に増やしてあり、着手前は
  // ここが `toBeVisible()` で緑だった。** **今日は3種とも0件であることを数える。**
  await expectNoDetailTargetNotes(page);

  // --- 子行(リンクでないセル)をクリック → 子の詳細 -----------------------------
  await row.locator(`td[data-field="${childMarker.id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`${detailUrl(childDetailId, childId)}$`));
  await expect(page.getByTestId("view-renderer-detail_view")).toBeVisible();

  // --- 子の詳細の項目の参照リンク → 親の詳細 ------------------------------------
  // 規約(定義順の先頭)により、参照先テーブルの1つ目の detail_view が開く。
  const fieldLink = page.getByTestId(`detail-field-${via.id}`).getByRole("link");
  await expect(fieldLink).toHaveCount(1);
  await fieldLink.click();
  await expect(page).toHaveURL(new RegExp(`${detailUrl(parentDetailId, parentId)}$`));
  await expect(page.getByText(parentMark).first()).toBeVisible();

  // --- 子行の中の参照リンク → 参照先(親)の詳細。**行の遷移は起きない** ----------
  const rowLink = page.getByTestId("related-row").filter({ hasText: childMark }).getByRole("link");
  await expect(rowLink).toHaveCount(1);
  await rowLink.click();
  // 行の onClick が二重に発火していたら、ここは子の詳細(childDetailId)になる。
  await expect(page).toHaveURL(new RegExp(`${detailUrl(parentDetailId, parentId)}$`));
});

test("遷移先が無ければ子行はクリックできない(押せるのに開けない導線を作らない)", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());

  // (1) 親の詳細(子一覧つき)を足す。**マニフェストを直接渡す経路は additive のみ**で、
  //     ビューの削除は表現できない(サーバがそう答える)。
  const next = structuredClone(app.manifest);
  const parentDetailId = freshViewId(
    `${parent.id}-detail`,
    next.app.views.map((view) => view.id),
  );
  next.app.views.push({
    id: parentDetailId,
    type: "detail_view",
    table: parent.id,
    related: [{ table: child.id, via: via.id, columns: [childMarker.id] }],
  });
  const replaced = await request.post(`/__e2e__/apps/${app.appId}/manifest`, { data: next });
  expect(replaced.status(), await replaced.text()).toBe(200);

  // (2) 子テーブルの detail_view を**製品の差分 API** で消す(`remove_view` は画面の定義
  //     だけを消し、テーブルもレコードも1バイトも触らない)。これで「遷移先が0個」になる。
  const removals = next.app.views
    .filter((view) => view.type === "detail_view" && view.table === child.id)
    .map((view) => ({ op: "remove_view" as const, view: view.id }));
  expect(removals.length).toBeGreaterThan(0);
  const diff: Diff = {
    diff_id: "remove-child-detail",
    intent: "子テーブルの詳細画面が無いときの子一覧の振る舞いを確かめる",
    operations: removals,
  };
  const applied = await request.post(`/api/apps/${app.appId}/diffs`, {
    data: diff,
    headers: app.authHeaders,
  });
  expect(applied.status(), await applied.text()).toBe(201);

  const stamp = Date.now();
  const parentRecord = buildRecord(app.tableOf(parent.id), 0, new Map());
  parentRecord[parentMarker.id] = `e2e-parent-noview-${stamp}`;
  const parentId = await app.createRecord(parent.id, parentRecord);
  const childRecord = buildRecord(app.tableOf(child.id), 1, new Map([[parent.id, parentId]]));
  childRecord[childMarker.id] = `e2e-child-noview-${stamp}`;
  childRecord[via.id] = parentId;
  await app.createRecord(child.id, childRecord);

  const url = `/apps/${app.appId}/views/${parentDetailId}/records/${parentId}`;
  await page.goto(url);
  const row = page.getByTestId("related-row");
  await expect(row).toHaveCount(1);
  // クリックできる行の印(tabindex)が付いていない。
  await expect(row).not.toHaveAttribute("tabindex", "0");
  await row.click();
  // URL は1文字も変わらない。
  await expect(page).toHaveURL(new RegExp(`${url}$`));
  // 注記も出ない(遷移先が無いのだから、どれを選んだかの説明も無い)。
  //
  // **【`V10-M18-T02`(`FU-G2`)の追記。上の行を1バイトも消していない】** **上の理由づけ
  // (遷移先が無いから)は今日の理由ではない。** **`FU-G2` により、遷移先が2つ以上あっても
  // 注記は出ない。** **数える先を3種すべてに広げた。**
  await expectNoDetailTargetNotes(page);
});

test("一覧の参照セルのリンクから参照先の詳細へ(行の遷移は起きない)", async ({ page, request }) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());

  // 一覧(子テーブルのもの)を探し、**参照列を1つ足す**(フィクスチャの一覧は参照を出して
  // いない)。併せて参照先テーブルの detail_view を2つ足す —— 1つ目がリンクの行き先になり、
  // 2つ目があることで「遷移先が2つ以上あるときの注記」が出る。
  const list = app.manifest.app.views.find(
    (view) => view.type === "list_view" && view.table === child.id,
  );
  if (list === undefined || list.type !== "list_view") {
    throw new Error("フィクスチャに子テーブルの list_view がありません(このテストの前提)。");
  }
  const next = structuredClone(app.manifest);
  const taken = next.app.views.map((view) => view.id);
  const nextList = next.app.views.find((view) => view.id === list.id);
  if (nextList === undefined || nextList.type !== "list_view") {
    throw new Error("複製したマニフェストから一覧を引けません。");
  }
  if (!nextList.columns.includes(via.id)) {
    nextList.columns = [...nextList.columns, via.id];
  }
  const parentDetailId = freshViewId(`${parent.id}-detail`, taken);
  next.app.views.push({ id: parentDetailId, type: "detail_view", table: parent.id });
  taken.push(parentDetailId);
  const secondParentDetailId = freshViewId(`${parent.id}-detail-2`, taken);
  next.app.views.push({ id: secondParentDetailId, type: "detail_view", table: parent.id });

  const replaced = await request.post(`/__e2e__/apps/${app.appId}/manifest`, { data: next });
  expect(replaced.status(), await replaced.text()).toBe(200);

  // 子テーブルの detail_view(行の遷移先)はフィクスチャが持っている前提。
  const childDetail = next.app.views.find(
    (view) => view.type === "detail_view" && view.table === child.id,
  );
  if (childDetail === undefined) {
    throw new Error("フィクスチャに子テーブルの detail_view がありません(このテストの前提)。");
  }

  const stamp = Date.now();
  const parentMark = `e2e-list-parent-${stamp}`;
  const childMark = `e2e-list-child-${stamp}`;

  const parentRecord = buildRecord(app.tableOf(parent.id), 0, new Map());
  parentRecord[parentMarker.id] = parentMark;
  const parentId = await app.createRecord(parent.id, parentRecord);

  const childRecord = buildRecord(app.tableOf(child.id), 1, new Map([[parent.id, parentId]]));
  childRecord[childMarker.id] = childMark;
  childRecord[via.id] = parentId;
  // 一覧の filter は等値AND配列(後方互換形)。行が必ず出るように合わせる。
  if (Array.isArray(list.filter)) {
    for (const condition of list.filter) {
      childRecord[condition.field] = condition.equals;
    }
  }
  const childId = await app.createRecord(child.id, childRecord);

  const listUrl = `/apps/${app.appId}/views/${list.id}`;
  await page.goto(listUrl);
  const row = page.getByTestId("list-row").filter({ hasText: childMark });
  await expect(row).toHaveCount(1);

  // 参照の注記が一覧にも出る。**行の注記(list-detail-target-note)とは別物である。**
  //
  // **【`V10-M18-T02`(`FU-G2`)の追記。上の1行を1バイトも消していない】** **一覧でも
  // 出ない。** **参照先の `detail_view` は下の準備で2枚にしてあり、着手前はここが
  // `toHaveCount(1)` で緑だった。** **今日は3種とも0件である。**
  await expectNoDetailTargetNotes(page);

  // --- 参照セルのリンク → 参照先(親)の詳細。**行の遷移は起きない** ------------------
  const cellLink = row.locator(`td[data-field="${via.id}"]`).getByRole("link");
  await expect(cellLink).toHaveCount(1);
  await expect(cellLink).toContainText(parentMark);
  await cellLink.click();
  // 行の onClick が二重に発火していたら、ここは子の詳細になる。
  await expect(page).toHaveURL(
    new RegExp(`/apps/${app.appId}/views/${parentDetailId}/records/${parentId}$`),
  );

  // --- リンクでないセルを押したときは従来どおり行が開く --------------------------------
  await page.goto(listUrl);
  await page
    .getByTestId("list-row")
    .filter({ hasText: childMark })
    .locator(`td[data-field="${childMarker.id}"]`)
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/apps/${app.appId}/views/${childDetail.id}/records/${childId}$`),
  );
});

/**
 * **作り手向けの注記を画面から出さない**(`V10-M18-T02` / `FU-G2` / `D-V10-21`)。
 *
 * **上の2本は「遷移すること」を名前に持つ検査であり、注記はその途中の主張だった。**
 * **そこを `expectNoDetailTargetNotes` に差し替えただけでは、「注記が出ないこと」を
 * 名前で述べる検査が本物の chromium に1本も無い。** そこでこの1本を足した。
 *
 * **候補は `extend()` が親・子とも2枚にしている**ので、**着手前はここで注記が出ていた
 * 条件そのものである。**
 */
test("作り手向けの注記が本物のブラウザで1つも出ない(FU-G2 / D-V10-21)", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());

  const { next, parentDetailId } = extend(app.manifest);
  const replaced = await request.post(`/__e2e__/apps/${app.appId}/manifest`, { data: next });
  expect(replaced.status(), await replaced.text()).toBe(200);

  const stamp = Date.now();
  const parentRecord = buildRecord(app.tableOf(parent.id), 0, new Map());
  parentRecord[parentMarker.id] = `e2e-note-parent-${stamp}`;
  const parentId = await app.createRecord(parent.id, parentRecord);

  const childRecord = buildRecord(app.tableOf(child.id), 1, new Map([[parent.id, parentId]]));
  childRecord[childMarker.id] = `e2e-note-child-${stamp}`;
  childRecord[via.id] = parentId;
  await app.createRecord(child.id, childRecord);

  // 詳細画面(項目の参照 / 子一覧の行 / 子一覧の列の参照が全部そろう画面)。
  await page.goto(`/apps/${app.appId}/views/${parentDetailId}/records/${parentId}`);
  await expect(page.getByTestId("view-renderer-detail_view")).toBeVisible();
  await expectNoDetailTargetNotes(page);

  // 一覧(子テーブル。`extend()` が子の detail_view も2枚にしてある)。
  const list = next.app.views.find((view) => view.type === "list_view" && view.table === child.id);
  if (list === undefined) {
    throw new Error("フィクスチャに子テーブルの list_view がありません(このテストの前提)。");
  }
  await page.goto(`/apps/${app.appId}/views/${list.id}`);
  await expect(page.getByTestId("view-renderer-list_view")).toBeVisible();
  await expectNoDetailTargetNotes(page);
});
