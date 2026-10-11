/**
 * **子の表に行を作れる権限(`create_child`)を画面で通す**(`V23-M7-T08`。門A `ADR-0542`、授権 `ADR-0543`、
 * 計画 `docs/plan/v23/00-v23-plan.md` §26-3 の T08・§26-4 の受け入れ基準、決定 `D-V23-178`〜`D-V23-199`)。
 *
 * - (A) 組織の権限 `assessor`(読むだけ。`create_child` に告知)を持つ評価者が、組織の詳細の「告知を追加」から告知を作れる。
 *   作成フォームの親の選択肢は作れる組織だけ(読めるだけの組織は並ばない)。 組織の更新は 403。 自分の告知は直せて
 *   (詳細に「編集」が出る)、他の評価者の告知は読むだけ(「編集」が出ない・更新は 403)。
 * - (B) 組織に読むだけの権限(`create_child` の無い名前)しか持たない人には「告知を追加」が出ない(作成も 403)。
 * - (C) 陰性対照: `create_child` を1つも書かないアプリでは、同じ評価者に今日どおりボタンが出て、親の選択肢も絞られない
 *   (保存はサーバが今日どおり 403 で断る)。
 * - (D) 行を相手にした付与(`principal_row`)で `assessor` を持つ評価機関の専門家も、組織の詳細から告知を作れ、
 *   自分の告知を直せる。 同じ評価機関の他の専門家は読むだけ。
 *
 * **この検査が証明しないこと**: ボタンを隠すことは作成を止めることではない(遮断はサーバの 403 で、(B) と (C) は
 * HTTP でも撃つ)。 一覧の「新規作成」と子の一覧の導線は出し分けの範囲の外である(撃たない)。
 *
 * 題材の定義はこのファイルが持ち、フィクスチャサーバの `/__e2e__/apps/:id/manifest` で入れる(`principal-row.e2e.ts` と同じ作法)。
 * 担当(`staff`)の役割には、行ごとのアクセス権を宣言した表への規則を1本も配らない(面と点は OR なので、面で書込を許すと
 * 点の判定が見えなくなる)。 カーネルの値は1つも import しない。
 */
import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";
import { type FixtureApp, provisionApp, type RoleSession, seedRoleSession } from "./fixture-app.ts";

const MEMBERS = "cc_members";
const AGENCIES = "cc_agencies";
const AGENCY_GRANTS = "cc_agency_grants";
const ORGS = "cc_orgs";
const ORG_GRANTS = "cc_org_grants";
const NOTICES = "cc_notices";
const NOTICE_GRANTS = "cc_notice_grants";
const ORG_DETAIL = "cc-org-detail";
const NOTICE_FORM = "cc-notice-form";
const NOTICE_DETAIL = "cc-notice-detail";
const NOTICE_BUTTON = `action-origin-${NOTICE_FORM}`;

const MENU_LABEL = "届いた招待";
const ORG1 = "北の組織";
const ORG2 = "南の組織";
const AGENCY_NAME = "東評価機関";

type Any = Record<string, unknown>;

function parts(createChild: boolean) {
  const cc = createChild ? { create_child: [NOTICES] } : {};
  return {
    tables: [
      {
        id: MEMBERS,
        name: "名簿",
        representative_field: "name",
        fields: [
          { id: "name", name: "名前", type: "text", required: true },
          { id: "account", name: "利用者ID", type: "text", required: true },
        ],
      },
      {
        id: AGENCIES,
        name: "評価機関",
        representative_field: "title",
        fields: [{ id: "title", name: "評価機関名", type: "text" }],
        access_control: {
          enabled: true,
          permissions: [
            { id: "ag_admin", name: "評価機関の管理者", read: true, write: true, delete: true },
            { id: "ag_expert", name: "専門家", read: true, write: false, delete: false },
          ],
          creator_permission: "ag_admin",
          creatable_by_roles: ["staff", "owner"],
          grant: {
            table: AGENCY_GRANTS,
            target: "agency",
            member: "member",
            permission: "permission",
          },
          members: { table: MEMBERS, account: "account" },
        },
      },
      {
        id: AGENCY_GRANTS,
        name: "評価機関の付与",
        fields: [
          {
            id: "agency",
            name: "評価機関",
            type: "reference",
            reference_table: AGENCIES,
            required: true,
          },
          { id: "member", name: "相手", type: "reference", reference_table: MEMBERS },
          {
            id: "permission",
            name: "権限",
            type: "select",
            options: ["ag_admin", "ag_expert"],
            required: true,
          },
        ],
      },
      {
        id: ORGS,
        name: "組織",
        representative_field: "title",
        fields: [{ id: "title", name: "組織名", type: "text" }],
        access_control: {
          enabled: true,
          permissions: [
            { id: "org_admin", name: "組織の管理者", read: true, write: true, delete: true },
            { id: "assessor", name: "評価者", read: true, write: false, delete: false, ...cc },
            { id: "org_viewer", name: "閲覧のみ", read: true, write: false, delete: false },
          ],
          creator_permission: "org_admin",
          creatable_by_roles: ["owner"],
          grant: {
            table: ORG_GRANTS,
            target: "org",
            member: "member",
            permission: "permission",
            principal_row: { column: "agency", table: AGENCIES, via: ["ag_expert"] },
          },
          members: { table: MEMBERS, account: "account" },
          invitations: { grantable: ["assessor"], expires_days: 5 },
        },
      },
      {
        id: ORG_GRANTS,
        name: "組織の付与",
        fields: [
          { id: "org", name: "組織", type: "reference", reference_table: ORGS, required: true },
          { id: "member", name: "相手", type: "reference", reference_table: MEMBERS },
          { id: "agency", name: "相手の評価機関", type: "reference", reference_table: AGENCIES },
          {
            id: "permission",
            name: "権限",
            type: "select",
            options: ["org_admin", "assessor", "org_viewer"],
            required: true,
          },
        ],
      },
      {
        id: NOTICES,
        name: "告知",
        representative_field: "title",
        fields: [
          { id: "title", name: "件名", type: "text" },
          { id: "org", name: "組織", type: "reference", reference_table: ORGS, required: true },
        ],
        access_control: {
          enabled: true,
          permissions: [{ id: "author", name: "書いた人", read: true, write: true, delete: true }],
          creator_permission: "author",
          inherit_from: ["org"],
          grant: {
            table: NOTICE_GRANTS,
            target: "notice",
            member: "member",
            permission: "permission",
          },
          members: { table: MEMBERS, account: "account" },
        },
      },
      {
        id: NOTICE_GRANTS,
        name: "告知の付与",
        fields: [
          {
            id: "notice",
            name: "告知",
            type: "reference",
            reference_table: NOTICES,
            required: true,
          },
          { id: "member", name: "相手", type: "reference", reference_table: MEMBERS },
          { id: "permission", name: "権限", type: "select", options: ["author"], required: true },
        ],
      },
    ],
    views: [
      {
        id: ORG_DETAIL,
        type: "detail_view",
        name: "組織の詳細",
        table: ORGS,
        fields: ["title"],
        actions: [{ form: NOTICE_FORM, prefill: { field: "org" }, name: "告知を追加" }],
      },
      {
        id: NOTICE_FORM,
        type: "form",
        name: "告知の入力",
        table: NOTICES,
        fields: ["title", "org"],
      },
      {
        id: NOTICE_DETAIL,
        type: "detail_view",
        name: "告知の詳細",
        table: NOTICES,
        fields: ["title", "org"],
      },
    ],
  };
}

type Installed = {
  app: FixtureApp;
  assessor: RoleSession;
  assessor2: RoleSession;
  viewer: RoleSession;
  memberRows: Map<string, string>;
  org1: string;
  org2: string;
};

/** 払い出したアプリに題材を足して入れ直し、組織を2つ作り、人を3人仕込んで名簿と付与に載せる。 */
async function install(request: APIRequestContext, createChild: boolean): Promise<Installed> {
  const app = await provisionApp(request);
  const base = structuredClone(app.manifest) as unknown as {
    app: {
      workspace?: Any;
      tables: unknown[];
      views: unknown[];
      roles?: { id: string; name?: string; rules?: unknown[] }[];
    };
  };
  const p = parts(createChild);
  base.app.tables.push(...p.tables);
  base.app.views.push(...p.views);
  base.app.workspace = { ...(base.app.workspace ?? {}), invitations: { label: MENU_LABEL } };
  const roles = base.app.roles ?? [
    {
      id: "owner",
      rules: [
        { target: "app", can: ["write"] },
        { target: "role", can: ["write"] },
      ],
    },
    { id: "editor" },
    { id: "viewer" },
  ];
  const all = [MEMBERS, AGENCIES, AGENCY_GRANTS, ORGS, ORG_GRANTS, NOTICES, NOTICE_GRANTS];
  const viewRules = [ORG_DETAIL, NOTICE_FORM, NOTICE_DETAIL].map((view) => ({
    target: "view",
    view,
    can: ["read"],
  }));
  const owner = roles.find((role) => role.id === "owner");
  if (owner !== undefined) {
    owner.rules = [
      ...(owner.rules ?? []),
      ...all.map((table) => ({ target: "table", table, can: ["read", "write", "delete"] })),
      ...viewRules,
    ];
  }
  // 担当には、組織と告知(行ごとのアクセス権を宣言した表)への規則を配らない(読み書きは点の付与だけで決まる)。
  // 評価機関の付与表にだけ書ける((D) で評価機関の管理者が専門家を足すため。付与表の書込は面の壁を通る)。
  roles.push({
    id: "staff",
    name: "担当",
    rules: [
      { target: "table", table: AGENCY_GRANTS, can: ["read", "write", "delete"] },
      ...viewRules,
    ],
  });
  base.app.roles = roles;
  const applied = await request.post(`/__e2e__/apps/${app.appId}/manifest`, { data: base });
  expect(applied.status(), await applied.text()).toBe(200);

  const assessor = await seedRoleSession(request, app.appId, "staff");
  const assessor2 = await seedRoleSession(request, app.appId, "staff");
  const viewer = await seedRoleSession(request, app.appId, "staff");
  const memberRows = new Map<string, string>();
  for (const person of [assessor, assessor2, viewer]) {
    memberRows.set(
      person.username,
      await app.createRecord(MEMBERS, { name: person.username, account: person.userId }),
    );
  }
  // 運営も名簿に載せてから、組織を2つ作る(作成者として組織の管理者)。
  await app.createRecord(MEMBERS, { name: "運営", account: app.userId });
  const org1 = await app.createRecord(ORGS, { title: ORG1 });
  const org2 = await app.createRecord(ORGS, { title: ORG2 });
  const grant = (org: string, who: RoleSession, permission: string) =>
    app.createRecord(ORG_GRANTS, { org, member: memberRows.get(who.username), permission });
  // 評価者2人は組織1 に assessor。 評価者1 は組織2 を読むだけ。 閲覧者は組織1 を読むだけ。
  await grant(org1, assessor, "assessor");
  await grant(org1, assessor2, "assessor");
  await grant(org2, assessor, "org_viewer");
  await grant(org1, viewer, "org_viewer");
  return { app, assessor, assessor2, viewer, memberRows, org1, org2 };
}

async function send(
  request: APIRequestContext,
  method: "POST" | "PATCH",
  path: string,
  who: { authHeaders: { cookie: string } },
  data: Any,
): Promise<{ status: number; body: Any; text: string }> {
  let headers: Record<string, string> = { ...who.authHeaders };
  if (method === "PATCH") {
    const current = await request.get(path, { headers: who.authHeaders });
    headers = { ...headers, "if-match": current.headers().etag ?? "" };
  }
  const response =
    method === "POST"
      ? await request.post(path, { data, headers })
      : await request.patch(path, { data, headers });
  const text = await response.text();
  let body: Any = {};
  try {
    body = JSON.parse(text) as Any;
  } catch {
    body = {};
  }
  return { status: response.status(), body, text };
}

function records(app: FixtureApp, tableId: string, id?: string): string {
  const base = `/api/apps/${app.appId}/tables/${tableId}/records`;
  return id === undefined ? base : `${base}/${id}`;
}

/** その人のセッションで告知を読む(件名の一覧)。 */
async function noticeTitles(
  request: APIRequestContext,
  app: FixtureApp,
  who: RoleSession,
): Promise<string[]> {
  const response = await request.get(records(app, NOTICES), { headers: who.authHeaders });
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as { records: { title?: string }[] };
  return body.records.map((row) => row.title ?? "").sort();
}

async function noticeIdByTitle(
  request: APIRequestContext,
  app: FixtureApp,
  title: string,
): Promise<string> {
  const response = await request.get(records(app, NOTICES), { headers: app.authHeaders });
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as { records: { _id: string; title?: string }[] };
  const found = body.records.find((row) => row.title === title);
  expect(found, `告知「${title}」が無い`).toBeDefined();
  return found?._id ?? "";
}

async function pageFor(browser: Browser, who: { authenticate: RoleSession["authenticate"] }) {
  const context = await browser.newContext();
  await who.authenticate(context);
  return context.newPage();
}

/** 組織の詳細を開き、項目が描かれるまで待つ(ボタンの有無は行の判定が届いてから決まる)。 */
async function openOrg(page: Page, app: FixtureApp, orgId: string, title: string): Promise<void> {
  await page.goto(`/apps/${app.appId}/views/${ORG_DETAIL}/records/${orgId}`);
  await expect(page.getByTestId("detail-field-title")).toHaveText(title);
}

/** 告知の作成フォームの親(組織)の選択肢の値(空を除く)。 */
async function orgChoices(page: Page): Promise<string[]> {
  const select = page.getByTestId("field-input-org");
  await expect(select).toBeVisible();
  await expect
    .poll(async () =>
      (
        await select
          .locator("option")
          .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))
      ).filter((value) => value !== ""),
    )
    .not.toEqual([]);
  return (
    await select
      .locator("option")
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))
  )
    .filter((value) => value !== "")
    .sort();
}

/** 組織の詳細の「告知を追加」から告知を1件保存する(親は詰めて渡される)。 */
async function createNoticeFromOrg(
  page: Page,
  app: FixtureApp,
  orgId: string,
  orgTitle: string,
  title: string,
): Promise<string[]> {
  await openOrg(page, app, orgId, orgTitle);
  const button = page.getByTestId(NOTICE_BUTTON);
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.getByTestId("view-renderer-form")).toBeVisible();
  const choices = await orgChoices(page);
  await expect(page.getByTestId("field-input-org")).toHaveValue(orgId);
  await page.getByTestId("field-input-title").fill(title);
  await page.getByRole("button", { name: "保存" }).click();
  return choices;
}

test.describe("子の表に行を作れる権限(V23-M7)", () => {
  test("(A) 評価者は組織の詳細から告知を作れる。親の選択肢は作れる組織だけ。組織は 403。自分の告知は直せ、他人の告知は読むだけ", async ({
    browser,
    request,
  }) => {
    const { app, assessor, assessor2, org1, org2 } = await install(request, true);

    // 評価者は組織を2つとも読める(組織2 は読むだけ)。
    const page = await pageFor(browser, assessor);
    const choices = await createNoticeFromOrg(page, app, org1, ORG1, "評価者1の告知");
    // 作成フォームの親の選択肢は作れる組織(組織1)だけ。 読めるだけの組織2 は並ばない。
    expect(choices).toEqual([org1]);
    await expect.poll(() => noticeTitles(request, app, assessor)).toEqual(["評価者1の告知"]);

    // 読むだけの組織2 の詳細には「告知を追加」が出ない。 HTTP の作成も 403。
    await openOrg(page, app, org2, ORG2);
    await expect(page.getByTestId(NOTICE_BUTTON)).toHaveCount(0);
    const refused = await send(request, "POST", records(app, NOTICES), assessor, {
      title: "組織2へ",
      org: org2,
    });
    expect(refused.status, refused.text).toBe(403);

    // 組織の更新は 403(組織の詳細に「編集」も出ない)。
    const orgPatch = await send(request, "PATCH", records(app, ORGS, org1), assessor, {
      title: "書き換え",
    });
    expect(orgPatch.status, orgPatch.text).toBe(403);
    await openOrg(page, app, org1, ORG1);
    await expect(page.getByTestId(NOTICE_BUTTON)).toBeVisible();
    await expect(page.getByTestId("detail-edit")).toHaveCount(0);

    // 自分の告知は直せる(詳細に「編集」が出る・更新 200)。
    const own = await noticeIdByTitle(request, app, "評価者1の告知");
    await page.goto(`/apps/${app.appId}/views/${NOTICE_DETAIL}/records/${own}`);
    await expect(page.getByTestId("detail-field-title")).toHaveText("評価者1の告知");
    await expect(page.getByTestId("detail-edit")).toBeVisible();
    const ownPatch = await send(request, "PATCH", records(app, NOTICES, own), assessor, {
      title: "評価者1の告知(直した)",
    });
    expect(ownPatch.status, ownPatch.text).toBe(200);

    // 他の評価者の告知は読むだけ(詳細は読めて「編集」が出ない・更新 403)。
    const page2 = await pageFor(browser, assessor2);
    await createNoticeFromOrg(page2, app, org1, ORG1, "評価者2の告知");
    await expect
      .poll(() => noticeTitles(request, app, assessor))
      .toEqual(["評価者1の告知(直した)", "評価者2の告知"]);
    const others = await noticeIdByTitle(request, app, "評価者2の告知");
    await page.goto(`/apps/${app.appId}/views/${NOTICE_DETAIL}/records/${others}`);
    await expect(page.getByTestId("detail-field-title")).toHaveText("評価者2の告知");
    await expect(page.getByTestId("detail-edit")).toHaveCount(0);
    const otherPatch = await send(request, "PATCH", records(app, NOTICES, others), assessor, {
      title: "書き換え",
    });
    expect(otherPatch.status, otherPatch.text).toBe(403);
    expect(await noticeTitles(request, app, assessor2)).toEqual([
      "評価者1の告知(直した)",
      "評価者2の告知",
    ]);
  });

  test("(B) 組織を読むだけの人(create_child の無い権限)にはボタンが出ない。作成も 403", async ({
    browser,
    request,
  }) => {
    const { app, viewer, org1 } = await install(request, true);
    const page = await pageFor(browser, viewer);
    await openOrg(page, app, org1, ORG1);
    await expect(page.getByTestId(NOTICE_BUTTON)).toHaveCount(0);
    const refused = await send(request, "POST", records(app, NOTICES), viewer, {
      title: "閲覧者から",
      org: org1,
    });
    expect(refused.status, refused.text).toBe(403);
  });

  test("(C) 陰性対照: create_child を書かないアプリでは、評価者にも今日どおりボタンが出て、親の選択肢も絞られない(保存は 403)", async ({
    browser,
    request,
  }) => {
    const { app, assessor, viewer, org1, org2 } = await install(request, false);
    const page = await pageFor(browser, assessor);
    await openOrg(page, app, org1, ORG1);
    const button = page.getByTestId(NOTICE_BUTTON);
    await expect(button).toBeVisible();
    await button.click();
    await expect(page.getByTestId("view-renderer-form")).toBeVisible();
    expect(await orgChoices(page)).toEqual([org1, org2].sort());
    // 読むだけの組織2 にも、閲覧者にも、今日どおりボタンが出る。
    await openOrg(page, app, org2, ORG2);
    await expect(page.getByTestId(NOTICE_BUTTON)).toBeVisible();
    const viewerPage = await pageFor(browser, viewer);
    await openOrg(viewerPage, app, org1, ORG1);
    await expect(viewerPage.getByTestId(NOTICE_BUTTON)).toBeVisible();
    // 保存はサーバが今日どおり断る。
    const refused = await send(request, "POST", records(app, NOTICES), assessor, {
      title: "宣言なし",
      org: org1,
    });
    expect(refused.status, refused.text).toBe(403);
  });

  test("(D) 評価機関経由(行を相手にした付与)で assessor を持つ専門家も、組織の詳細から告知を作れ、自分の告知を直せる。同じ機関の他の専門家は読むだけ", async ({
    browser,
    request,
  }) => {
    const { app, assessor2, viewer, memberRows, org2 } = await install(request, true);
    // 評価機関の管理者は viewer の人を流用する(組織1 は読むだけ)。 専門家は評価者1・評価者2 とは別の2人を足す。
    const agencyAdmin = viewer;
    const expert = await seedRoleSession(request, app.appId, "staff");
    const expert2 = await seedRoleSession(request, app.appId, "staff");
    for (const person of [expert, expert2]) {
      memberRows.set(
        person.username,
        await app.createRecord(MEMBERS, { name: person.username, account: person.userId }),
      );
    }
    const agency = await send(request, "POST", records(app, AGENCIES), agencyAdmin, {
      title: AGENCY_NAME,
    });
    expect(agency.status, agency.text).toBe(201);
    const agencyId = (agency.body.record as { _id: string })._id;
    for (const person of [expert, expert2]) {
      const added = await send(request, "POST", records(app, AGENCY_GRANTS), agencyAdmin, {
        agency: agencyId,
        member: memberRows.get(person.username),
        permission: "ag_expert",
      });
      expect(added.status, added.text).toBe(201);
    }
    // 評価機関のコード → 運営(組織2 の管理者)がコードで assessor を招待 → 評価機関の管理者が承諾。
    const code = await send(
      request,
      "POST",
      `${records(app, AGENCIES, agencyId)}/invite-code`,
      agencyAdmin,
      {},
    );
    expect(code.status, code.text).toBe(200);
    const invited = await send(request, "POST", `${records(app, ORGS, org2)}/invitations`, app, {
      code: code.body.code,
      permission: "assessor",
    });
    expect(invited.status, invited.text).toBe(202);
    const inbox = await request.get(`/api/apps/${app.appId}/invitations`, {
      headers: agencyAdmin.authHeaders,
    });
    expect(inbox.status(), await inbox.text()).toBe(200);
    const items = ((await inbox.json()) as { invitations: { id: string }[] }).invitations;
    expect(items).toHaveLength(1);
    const accepted = await send(
      request,
      "POST",
      `/api/apps/${app.appId}/invitations/${items[0]?.id ?? ""}`,
      agencyAdmin,
      { action: "accept" },
    );
    expect(accepted.status, accepted.text).toBe(200);

    // 専門家は組織2 の詳細から告知を作れる。 親の選択肢は組織2 だけ(組織1 は読めない)。
    const page = await pageFor(browser, expert);
    const choices = await createNoticeFromOrg(page, app, org2, ORG2, "専門家の告知");
    expect(choices).toEqual([org2]);
    await expect.poll(() => noticeTitles(request, app, expert)).toEqual(["専門家の告知"]);
    const own = await noticeIdByTitle(request, app, "専門家の告知");
    await page.goto(`/apps/${app.appId}/views/${NOTICE_DETAIL}/records/${own}`);
    await expect(page.getByTestId("detail-edit")).toBeVisible();
    const ownPatch = await send(request, "PATCH", records(app, NOTICES, own), expert, {
      title: "専門家の告知(直した)",
    });
    expect(ownPatch.status, ownPatch.text).toBe(200);
    // 組織の更新は 403。
    const orgPatch = await send(request, "PATCH", records(app, ORGS, org2), expert, {
      title: "書き換え",
    });
    expect(orgPatch.status, orgPatch.text).toBe(403);

    // 同じ評価機関の他の専門家は読めるが直せない(「編集」が出ない・更新 403)。
    const page2 = await pageFor(browser, expert2);
    await page2.goto(`/apps/${app.appId}/views/${NOTICE_DETAIL}/records/${own}`);
    await expect(page2.getByTestId("detail-field-title")).toHaveText("専門家の告知(直した)");
    await expect(page2.getByTestId("detail-edit")).toHaveCount(0);
    const otherPatch = await send(request, "PATCH", records(app, NOTICES, own), expert2, {
      title: "書き換え",
    });
    expect(otherPatch.status, otherPatch.text).toBe(403);
    // 組織1 だけの評価者2 は、組織2 の告知を読めない。
    expect(await noticeTitles(request, app, assessor2)).toEqual([]);
  });
});
