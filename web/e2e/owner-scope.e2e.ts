/**
 * 個人スコープ(owner)の 2ユーザ E2E(V1-M3-T04 / ADR-0016)。
 *
 * サーバ層の規約は「`st_owner`(id が `st_owner`・型 text・required でない)を持つ
 * テーブル=個人所有」。サーバは (1) 作成時に `st_owner` を認証ユーザ id で必ず上書き、
 * (2) 一覧/1件では自分の行+共有行(st_owner=null/空)だけ返し、他人の個人行は
 * 一覧に出さず1件は 404、(3) `PATCH {st_owner:null}` で共有化=全員可視、にする。
 *
 * このテストの完了条件は「E2E: 2セッションでの分離確認」。2人(owner=既定 +
 * editor=seedRoleSession)を **各自の authHeaders(cookie)で叩き分けて独立セッション**に
 * し、HTTP 認証経路で個人行を作って分離を確かめる。MCP は無認証でスタンプが効かない
 * ため個人行の作成には使わない(必ず HTTP POST + authHeaders)。
 *
 * 個人所有テーブルは既存フィクスチャに無いので、**自分のアプリの manifest を土台に、
 * `st_owner`(text・required なし)を持つ個人テーブル + list_view を additive に足して**
 * `POST /__e2e__/apps/:appId/manifest`(= applyManifest)で差し替えて用意する。自分の
 * アプリに閉じるので他 E2E を壊さない。
 */
import { expect, test } from "@playwright/test";
import type { Manifest } from "../../src/kernel/types.ts";
import { type FixtureApp, provisionApp, seedRoleSession } from "./fixture-app.ts";

/** 個人所有を表すフィールド id(サーバ規約 `src/server/owner-scope.ts` の OWNER_FIELD)。 */
const OWNER_FIELD = "st_owner";

/** 既存 ID と衝突しないリソース ID を作る(接尾辞を伸ばすだけ)。 */
function freshId(base: string, taken: readonly string[]): string {
  let candidate = base;
  while (taken.includes(candidate)) {
    candidate = `${candidate}-x`;
  }
  return candidate;
}

/**
 * 個人所有テーブル + その list_view を additive に足したマニフェストと、足した ID を返す。
 * 表示用の text フィールド(title・required)と、所有者フィールド `st_owner`(text・
 * required なし=個人所有の目印)を持たせる。既存テーブル・ビューは1つも消さない。
 */
function withPersonalTable(manifest: Manifest): {
  next: Manifest;
  tableId: string;
  titleField: string;
  viewId: string;
} {
  const next = structuredClone(manifest);
  const tableId = freshId(
    "personal_notes",
    next.app.tables.map((table) => table.id),
  );
  const titleField = "title";
  next.app.tables.push({
    id: tableId,
    name: "個人メモ",
    fields: [
      { id: titleField, name: "タイトル", type: "text", required: true },
      // 所有者フィールド。text かつ required 無し =「個人所有テーブル」の規約を満たす。
      { id: OWNER_FIELD, name: "所有者", type: "text" },
    ],
  });
  const viewId = freshId(
    "personal-list",
    next.app.views.map((view) => view.id),
  );
  next.app.views.push({
    id: viewId,
    type: "list_view",
    table: tableId,
    columns: [titleField],
  });
  return { next, tableId, titleField, viewId };
}

/** 稼働中のサーバに、自分のアプリ限定で個人所有テーブルを足す。 */
async function installPersonalTable(
  request: Parameters<typeof provisionApp>[0],
  app: FixtureApp,
): Promise<{ tableId: string; titleField: string; viewId: string }> {
  const { next, tableId, titleField, viewId } = withPersonalTable(app.manifest);
  const replaced = await request.post(`/__e2e__/apps/${app.appId}/manifest`, { data: next });
  expect(replaced.status(), await replaced.text()).toBe(200);
  return { tableId, titleField, viewId };
}

/** 公開指定を表すフィールド id(サーバ規約 `src/server/owner-scope.ts` の PUBLIC_FIELD)。 */
const PUBLIC_FIELD = "st_public";

/**
 * customer から見た3カテゴリ(`nonAdminTableAccess`)を1つのアプリに揃える(V3-M3-T04 / D-G12b)。
 *
 * - **scoped** = `st_owner`(text・required なし)を持つ個人テーブル → 上の `withPersonalTable`
 * - **public** = `st_public`(boolean・required なし)だけを持つ公開テーブル
 * - **denied** = どちらの規約も持たないフィクスチャの既存テーブル(足さない。既にある)
 *
 * 既存テーブル・ビューは1つも消さない(additive)。
 */
function withPublicTable(manifest: Manifest): {
  next: Manifest;
  tableId: string;
  titleField: string;
  viewId: string;
} {
  const next = structuredClone(manifest);
  const tableId = freshId(
    "public_notices",
    next.app.tables.map((table) => table.id),
  );
  const titleField = "title";
  next.app.tables.push({
    id: tableId,
    name: "公開のお知らせ",
    fields: [
      { id: titleField, name: "見出し", type: "text", required: true },
      // boolean かつ required 無し =「公開テーブル」の規約を満たす。
      { id: PUBLIC_FIELD, name: "公開", type: "boolean" },
    ],
  });
  const viewId = freshId(
    "public-list",
    next.app.views.map((view) => view.id),
  );
  next.app.views.push({ id: viewId, type: "list_view", table: tableId, columns: [titleField] });
  return { next, tableId, titleField, viewId };
}

const recordsUrl = (app: FixtureApp, tableId: string): string =>
  `/api/apps/${app.appId}/tables/${tableId}/records`;
const recordUrl = (app: FixtureApp, tableId: string, recordId: string): string =>
  `${recordsUrl(app, tableId)}/${recordId}`;
const viewUrl = (app: FixtureApp, viewId: string): string => `/apps/${app.appId}/views/${viewId}`;

/** scoped(st_owner)と public(st_public)を**同時に**足して1回で差し替える(V3-M3-T04)。 */
async function installCustomerTables(
  request: Parameters<typeof provisionApp>[0],
  app: FixtureApp,
): Promise<{
  scopedTable: string;
  scopedTitle: string;
  scopedView: string;
  publicTable: string;
  publicTitle: string;
  publicView: string;
  deniedTable: string;
  deniedViews: string[];
  deniedListView: string;
}> {
  const personal = withPersonalTable(app.manifest);
  const shared = withPublicTable(personal.next);
  const replaced = await request.post(`/__e2e__/apps/${app.appId}/manifest`, { data: shared.next });
  expect(replaced.status(), await replaced.text()).toBe(200);
  // 運営テーブル = フィクスチャに元からある、どちらの規約も持たないテーブル。
  // **list_view を持つものを選ぶ** —— 下の (c) が「URL 直打ちならサーバの 403 が画面に出る」
  // ことを確かめるのに、レコードを取りに行く画面が要る(form の新規作成は何も取りに行かない)。
  const deniedListView = app.manifest.app.views.find((view) => view.type === "list_view");
  if (deniedListView === undefined) {
    throw new Error("フィクスチャに list_view がありません(このテストの前提)。");
  }
  const denied = app.manifest.app.tables.find((table) => table.id === deniedListView.table);
  if (denied === undefined) {
    throw new Error("フィクスチャの list_view が実在しないテーブルを指しています。");
  }
  return {
    deniedListView: deniedListView.id,
    scopedTable: personal.tableId,
    scopedTitle: personal.titleField,
    scopedView: personal.viewId,
    publicTable: shared.tableId,
    publicTitle: shared.titleField,
    publicView: shared.viewId,
    deniedTable: denied.id,
    deniedViews: app.manifest.app.views
      .filter((view) => view.table === denied.id)
      .map((view) => view.id),
  };
}

test("2セッションで個人行が相互不可視、共有化すると双方に見える(API)", async ({ request }) => {
  // A = 既定 owner。B = 追加した editor(別ユーザ)。owner も editor も書けるロール。
  const app = await provisionApp(request);
  const bee = await seedRoleSession(request, app.appId, "editor");
  const { tableId, titleField } = await installPersonalTable(request, app);

  // --- 1. A が個人行を作成(A の authHeaders)。st_owner は詐称値を送っても A の id に矯正される ---
  //
  // --- 【`V8-M37` / 台帳 `F-G3` / ユーザ決定 `D-V8-96`。期待値を入れ替えた。旧を逐語で残す】 ---
  //
  // **旧(逐語)**:
  //   ```
  //   const aCreated = await request.post(recordsUrl(app, tableId), {
  //     data: { [titleField]: "A-row", [OWNER_FIELD]: "spoofed-someone-else" },
  //     headers: app.authHeaders,
  //   });
  //   expect(aCreated.status(), await aCreated.text()).toBe(201);
  //   const aRecord = ((await aCreated.json()) as { record: Record<string, unknown> }).record;
  //   const aId = aRecord._id as string;
  //   // 作成時スタンプ: 送った詐称値ではなく、認証ユーザ A の id になっている。
  //   expect(aRecord[OWNER_FIELD]).toBe(app.userId);
  //   ```
  //
  // **詐称値を送った作成は、黙って矯正されるのではなく 403 で断られるようになった。**
  // **矯正(スタンプ)そのものは残る** —— **送らなければ今日どおり A の id になる。**
  const aSpoofed = await request.post(recordsUrl(app, tableId), {
    data: { [titleField]: "A-row", [OWNER_FIELD]: "spoofed-someone-else" },
    headers: app.authHeaders,
  });
  expect(aSpoofed.status(), await aSpoofed.text()).toBe(403);
  const aCreated = await request.post(recordsUrl(app, tableId), {
    data: { [titleField]: "A-row" },
    headers: app.authHeaders,
  });
  expect(aCreated.status(), await aCreated.text()).toBe(201);
  const aRecord = ((await aCreated.json()) as { record: Record<string, unknown> }).record;
  const aId = aRecord._id as string;
  // 作成時スタンプ: 認証ユーザ A の id になっている。
  expect(aRecord[OWNER_FIELD]).toBe(app.userId);

  // --- 2. B が個人行を作成(B の authHeaders)---
  const bCreated = await request.post(recordsUrl(app, tableId), {
    data: { [titleField]: "B-row" },
    headers: bee.authHeaders,
  });
  expect(bCreated.status(), await bCreated.text()).toBe(201);
  const bRecord = ((await bCreated.json()) as { record: Record<string, unknown> }).record;
  const bId = bRecord._id as string;
  expect(bRecord[OWNER_FIELD]).toBe(bee.userId);

  // --- 3. 相互不可視 -------------------------------------------------------
  // A の一覧には A の行だけ。B の行は出ない。
  const aList = await request.get(recordsUrl(app, tableId), { headers: app.authHeaders });
  expect(aList.status()).toBe(200);
  const aRows = ((await aList.json()) as { records: Record<string, unknown>[] }).records;
  expect(aRows.map((row) => row._id)).toEqual([aId]);

  // B の一覧には B の行だけ。A の行は出ない。
  const bList = await request.get(recordsUrl(app, tableId), { headers: bee.authHeaders });
  expect(bList.status()).toBe(200);
  const bRows = ((await bList.json()) as { records: Record<string, unknown>[] }).records;
  expect(bRows.map((row) => row._id)).toEqual([bId]);

  // A が B の個人行を1件 GET → 404(存在ごと伏せる)。
  const aGetsB = await request.get(recordUrl(app, tableId, bId), { headers: app.authHeaders });
  expect(aGetsB.status()).toBe(404);
  // 逆向きも確認: B が A の行を GET → 404。
  const bGetsA = await request.get(recordUrl(app, tableId, aId), { headers: bee.authHeaders });
  expect(bGetsA.status()).toBe(404);

  // --- 4. 共有化: A が自分の行を PATCH {st_owner:null}(If-Match 必須)→ 200 -----
  const aOwn = await request.get(recordUrl(app, tableId, aId), { headers: app.authHeaders });
  expect(aOwn.status()).toBe(200);
  const version = aOwn.headers().etag;
  if (version === undefined) throw new Error("GET 応答に ETag(版)が無い");
  const shared = await request.patch(recordUrl(app, tableId, aId), {
    data: { [OWNER_FIELD]: null },
    headers: { ...app.authHeaders, "If-Match": version },
  });
  expect(shared.status(), await shared.text()).toBe(200);

  // 以後、A・B 双方の一覧に A の(共有化された)行が出る。
  const aListAfter = await request.get(recordsUrl(app, tableId), { headers: app.authHeaders });
  const aRowsAfter = ((await aListAfter.json()) as { records: Record<string, unknown>[] }).records;
  expect(aRowsAfter.map((row) => row._id).sort()).toEqual([aId]); // A 自身: 共有行のみ(自分の個人行はもう無い)
  const bListAfter = await request.get(recordsUrl(app, tableId), { headers: bee.authHeaders });
  const bRowsAfter = ((await bListAfter.json()) as { records: Record<string, unknown>[] }).records;
  expect(bRowsAfter.map((row) => row._id).sort()).toEqual([aId, bId].sort()); // B: 自分の行 + 共有行

  // B が共有化された A の行を1件 GET → 200。
  const bGetsShared = await request.get(recordUrl(app, tableId, aId), { headers: bee.authHeaders });
  expect(bGetsShared.status()).toBe(200);
});

test("list_view でも自分の個人行だけが見え、他人の行は出ない(UI 分離)", async ({
  browser,
  request,
}) => {
  const app = await provisionApp(request); // A = owner
  const bee = await seedRoleSession(request, app.appId, "editor"); // B = editor
  const { tableId, titleField, viewId } = await installPersonalTable(request, app);

  // 個人行は必ず HTTP 認証経路で作る(MCP はスタンプが効かない)。
  const aCreated = await request.post(recordsUrl(app, tableId), {
    data: { [titleField]: "A-personal-row" },
    headers: app.authHeaders,
  });
  expect(aCreated.status(), await aCreated.text()).toBe(201);
  const bCreated = await request.post(recordsUrl(app, tableId), {
    data: { [titleField]: "B-personal-row" },
    headers: bee.authHeaders,
  });
  expect(bCreated.status(), await bCreated.text()).toBe(201);

  // 2つの独立した context を作り、各々に片方のユーザだけを認証させる。
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  try {
    await app.authenticate(contextA);
    await bee.authenticate(contextB);
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    // A の画面: 自分の行(A-personal-row)だけが見え、B の行は出ない。
    await pageA.goto(viewUrl(app, viewId));
    const aRows = pageA.getByTestId("list-row");
    await expect(aRows).toHaveCount(1);
    await expect(aRows.first()).toContainText("A-personal-row");
    await expect(pageA.getByTestId("list-table")).not.toContainText("B-personal-row");

    // B の画面: 自分の行(B-personal-row)だけが見え、A の行は出ない。
    await pageB.goto(viewUrl(app, viewId));
    const bRows = pageB.getByTestId("list-row");
    await expect(bRows).toHaveCount(1);
    await expect(bRows.first()).toContainText("B-personal-row");
    await expect(pageB.getByTestId("list-table")).not.toContainText("A-personal-row");
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

/**
 * V3-M3-T04(D-G12b / ユーザ決定 D-M3-1 =「隠す」)の完了条件4:
 * **サーバの 403 が効き続けることを直接確かめる。UI が押させないことは 403 の代わりにならない。**
 *
 * したがってこのテストは**2つを別々に**確かめる:
 *   (a) **UI を1度も経由しない** `request`(ブラウザ context と cookie を共有しない)で
 *       customer の 403 を叩き出す —— 隠す実装が入っても、サーバは今までどおり断る。
 *   (b) そのうえで、画面一覧に運営テーブルのビューが**並ばない**こと(隠す側)。
 *
 * (a) が緑で (b) が緑のときにだけ、「押させない」と「断る」が両方成立している。
 */
test("customer: 運営テーブルはサーバが 403(UI 非経由)。画面一覧にも並ばない", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request); // 既定 = owner
  const ids = await installCustomerTables(request, app);
  const shopper = await seedRoleSession(request, app.appId, "customer");

  // --- (a) UI を経由しない 403 の直接確認 ------------------------------------
  // 運営テーブル(denied): GET も書込も 403。
  //
  // =====================================================================================
  // **【`V8-M27-T04` / `T-G5`。読取の期待値を反転させた。旧の期待値を逐語で残す】**
  //
  // **旧(逐語)**: `expect(deniedGet.status(), await deniedGet.text()).toBe(403);`
  // **上の1行の説明(「運営テーブル(denied): GET も書込も 403」)も旧である。**
  //
  // **根拠**: **`V8-M27` / 台帳 `T-G5` / ユーザ決定 `D-V8-38`。**
  // **`nonAdminTableAccess` の層を撤去した** —— **読取は今日 403 で断らない**
  // (`ADR-0305` 限定11: **一覧は 200 で応答から落とす。403 にすると「その表が在る」ことが
  // 役割の外へ漏れる**)。**書込(下の `deniedPost`)は今日も 403 である** ——
  // **止めているのが面(`app.roles[].rules`)に変わっただけで、断ること自体は変わっていない。**
  // **このテストの主題(「UI が押させないことは 403 の代わりにならない」)は1ミリも
  // 変わっていない** —— **読取について測る対象が「応答コード」から「返る行数」に移った。**
  // =====================================================================================
  const deniedGet = await request.get(recordsUrl(app, ids.deniedTable), {
    headers: shopper.authHeaders,
  });
  expect(deniedGet.status(), await deniedGet.text()).toBe(200);
  expect(
    ((await deniedGet.json()) as { records: unknown[] }).records.length,
    "運営テーブルの行が購入者に1件でも返っている",
  ).toBe(0);
  const deniedPost = await request.post(recordsUrl(app, ids.deniedTable), {
    data: {},
    headers: shopper.authHeaders,
  });
  expect(deniedPost.status(), await deniedPost.text()).toBe(403);

  // 公開テーブル(public): GET は 200、書込は 403。
  const publicGet = await request.get(recordsUrl(app, ids.publicTable), {
    headers: shopper.authHeaders,
  });
  expect(publicGet.status(), await publicGet.text()).toBe(200);
  const publicPost = await request.post(recordsUrl(app, ids.publicTable), {
    data: { [ids.publicTitle]: "だめ" },
    headers: shopper.authHeaders,
  });
  expect(publicPost.status(), await publicPost.text()).toBe(403);

  // 自分のテーブル(scoped): GET も書込も通る(隠しすぎていないことの裏)。
  const scopedPost = await request.post(recordsUrl(app, ids.scopedTable), {
    data: { [ids.scopedTitle]: "customer-row" },
    headers: shopper.authHeaders,
  });
  expect(scopedPost.status(), await scopedPost.text()).toBe(201);

  // --- (b) 画面一覧の出し分け(隠す側)---------------------------------------
  await shopper.authenticate(page.context());
  await page.goto(`/apps/${app.appId}`);
  await expect(page.getByTestId("current-role")).toHaveAttribute("data-role", "customer");
  const viewList = page.getByTestId("view-list");
  await expect(viewList).toBeVisible();
  // 使える画面(scoped / public)は並ぶ。
  await expect(viewList.locator(`a[href$="/views/${ids.scopedView}"]`)).toHaveCount(1);
  await expect(viewList.locator(`a[href$="/views/${ids.publicView}"]`)).toHaveCount(1);
  // 運営テーブルのビューは1つも並ばない。
  expect(ids.deniedViews.length).toBeGreaterThan(0); // 前提: 運営ビューが実在する
  for (const viewId of ids.deniedViews) {
    await expect(viewList.locator(`a[href$="/views/${viewId}"]`)).toHaveCount(0);
  }

  // --- (c) 隠しても最終防衛線は動いている ------------------------------------
  // URL を直接叩けば画面は描こうとし、**サーバの 403 がそのまま画面に出る**。
  // 「隠す」で消えるのは一覧からの説明機会であって、説明そのものではない(憲法6 との緊張)。
  const deniedList = ids.deniedListView;
  await page.goto(viewUrl(app, deniedList));
  await expect(page.getByTestId("errors")).toBeVisible();
});

/**
 * 【V3-M3-T04 追加実施】**絞った結果が0件でも、真っ白な画面を出さない。**
 *
 * フィクスチャのテーブルは `st_owner` も `st_public` も持たない(= customer からは全部
 * denied)ので、**マニフェストに1バイトも足さなければ customer の画面一覧は実際に0件に
 * なる。**その状態を実ブラウザで踏み、説明が出ることを確かめる。
 *
 * **隠した対象を1つも明かしていない**ことも、実物の DOM に対して確かめる。
 */
test("customer で使える画面が0件でも、真っ白にならず理由が読める", async ({ page, request }) => {
  const app = await provisionApp(request);
  const shopper = await seedRoleSession(request, app.appId, "customer");
  await shopper.authenticate(page.context());

  await page.goto(`/apps/${app.appId}`);
  await expect(page.getByTestId("current-role")).toHaveAttribute("data-role", "customer");
  // 一覧の枠は出るが、行は1つも無い。
  await expect(page.getByTestId("view-list")).toBeVisible();
  await expect(page.getByTestId("view-list").locator("li")).toHaveCount(0);

  // 「ロールで絞った結果0件」として説明が出る(「元から0件」ではない)。
  const empty = page.getByTestId("view-list-empty");
  await expect(empty).toBeVisible();
  await expect(empty).toHaveAttribute("data-reason", "role");
  await expect(empty).toContainText("壊れて");
  await expect(empty).toContainText("運営者");

  // 隠した対象を1つも明かしていない(実物の DOM で確認する)。
  const text = (await empty.textContent()) ?? "";
  for (const view of app.manifest.app.views) {
    expect(text).not.toContain(view.id);
  }
  for (const table of app.manifest.app.tables) {
    expect(text).not.toContain(table.id);
  }
  expect(text).not.toMatch(/\d/);
});
