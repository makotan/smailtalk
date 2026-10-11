/**
 * **行の招待を画面で通す**(`V23-M5-T10`。上位: `docs/adr/0501-row-invitations-and-inbox.md`、
 * 門A `ADR-0532`、計画 `docs/plan/v23/00-v23-plan.md` §24-3 の T10・§24-6 中8、決定 `D-V23-115`〜`D-V23-133`)。
 *
 * - (A) 組織オーナー(運営でない `staff`)が行の詳細から相手のログイン名で招待する →「招待しました」→
 *   未承諾の一覧に出る。 存在しないログイン名・役割が合わない相手への招待も、同じ表示になる。
 *   相手は別の context でログインし、メニューの「招待」から受け取り画面を開いて、代表項目・招待者・
 *   権限名だけを見て承諾する。 承諾の前は行が読めず、承諾の後は一覧と詳細に出る。
 *   `target_roles` に合わない人(`guest`)の受け取り画面には出ない。
 * - (R) 組織オーナーが取り消すと、未承諾の一覧から消え、相手の受け取り画面にも出ない。
 * - (G) `group_from` を書いた台で、承諾の後に名簿のグループ欄が招待した行の値に変わる(運営の HTTP で読む)。
 *   【2026-09-30。`V23-M5-T11` の処置(`ADR-0537` §1・§2)。上の行を消していない】承諾で書くグループは招待者自身の
 *   名簿のグループと同じときだけなので、(G) は組織オーナーを招待した行のグループの一員にした台で通す。
 *   受け取り画面には「承諾すると所属グループが替わり…」の1文が出る。 (G2) 組織オーナーの入っていないグループの
 *   行への招待は、承諾が理由付きで断られ、招待は残り、名簿のグループ欄は変わらない。
 * - (U) 付与表の `unique_message` に当たる承諾は、その文言が受け取り画面に出て、招待は残る。
 * - (F) 配る版でも、メニューの「招待」と受け取り画面が出る。
 * - (N) 招待を宣言しないアプリには、メニューの「招待」が出ない。
 *
 * 題材の定義はこのファイルが持ち、フィクスチャサーバの `/__e2e__/apps/:id/manifest` で入れる
 * (`actor-previous-history.e2e.ts` と同じ作法)。 カーネルの値は1つも import しない。
 */
import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";
import type { Diff } from "../../src/kernel/types.ts";
import { type FixtureApp, provisionApp, type RoleSession, seedRoleSession } from "./fixture-app.ts";

const port = Number(process.env.ST_E2E_PORT ?? 3210);
/** 配る版の置き場(`my-page.e2e.ts` と同じ)。 */
const runnerBase = `http://localhost:${port + 1}`;
const RUNNER_APP_ID = "runner-e2e";

const ORGS = "ri_orgs";
const MEMBERS = "ri_members";
const GROUPS = "ri_groups";
const GRANTS = "ri_org_grants";
const LIST = "ri-org-list";
const DETAIL = "ri-org-detail";

const MENU_LABEL = "届いた招待";
const UNIQUE_MESSAGE = "すでに別の組織に所属しています。1人が入れる組織は1つだけです。";
const SECRET = "金庫の番号は4321";

type Options = { groupFrom?: boolean; uniqueMember?: boolean };

function parts(options: Options) {
  return {
    workspaceInvitations: { label: MENU_LABEL },
    tables: [
      { id: GROUPS, name: "グループ", fields: [{ id: "title", name: "名前", type: "text" }] },
      {
        id: MEMBERS,
        name: "名簿",
        representative_field: "name",
        fields: [
          { id: "name", name: "名前", type: "text", required: true },
          { id: "account", name: "利用者ID", type: "text", required: true },
          { id: "grp", name: "所属グループ", type: "reference", reference_table: GROUPS },
        ],
      },
      {
        id: ORGS,
        name: "組織",
        representative_field: "title",
        fields: [
          { id: "title", name: "組織名", type: "text" },
          { id: "secret", name: "内部メモ", type: "text" },
          { id: "grp", name: "グループ", type: "reference", reference_table: GROUPS },
        ],
        access_control: {
          enabled: true,
          permissions: [
            { id: "org_owner", name: "組織オーナー", read: true, write: true, delete: true },
            { id: "org_member", name: "メンバー", read: true, write: false, delete: false },
            { id: "org_viewer", name: "閲覧のみ", read: true, write: false, delete: false },
          ],
          creator_permission: "org_owner",
          creatable_by_roles: ["staff", "guest", "owner"],
          grant: {
            table: GRANTS,
            target: "org",
            member: "member",
            group: "group",
            permission: "permission",
          },
          members: { table: MEMBERS, account: "account", group: "grp" },
          groups: { table: GROUPS },
          invitations: {
            by: ["org_owner"],
            grantable: ["org_member", "org_viewer"],
            target_roles: ["staff"],
            expires_days: 5,
            ...(options.groupFrom === true ? { group_from: "grp" } : {}),
          },
        },
      },
      {
        id: GRANTS,
        name: "組織の付与",
        fields: [
          { id: "org", name: "組織", type: "reference", reference_table: ORGS, required: true },
          {
            id: "member",
            name: "相手",
            type: "reference",
            reference_table: MEMBERS,
            ...(options.uniqueMember === true
              ? { unique: true, unique_message: UNIQUE_MESSAGE }
              : {}),
          },
          { id: "group", name: "グループ", type: "reference", reference_table: GROUPS },
          {
            id: "permission",
            name: "権限",
            type: "select",
            options: ["org_owner", "org_member", "org_viewer"],
            required: true,
          },
        ],
      },
    ],
    views: [
      { id: LIST, type: "list_view", name: "組織の一覧", table: ORGS, columns: ["title"] },
      {
        id: DETAIL,
        type: "detail_view",
        name: "組織の詳細",
        table: ORGS,
        fields: ["title", "secret"],
      },
    ],
  };
}

type Installed = {
  app: FixtureApp;
  /** 組織オーナー(運営でない)。 */
  orgOwner: RoleSession;
  /** 招待される人(`target_roles` に合う)。 */
  invitee: RoleSession;
  /** 役割が合わない人。 */
  outsider: RoleSession;
  /** 名簿の行の ID(ログイン名 → 行)。 */
  memberRows: Map<string, string>;
};

/** 払い出したアプリに題材を足して入れ直し、人を3人仕込んで名簿に載せる。 */
async function install(
  request: APIRequestContext,
  options: Options = {},
  memberGroup?: (app: FixtureApp) => Promise<string | undefined>,
  /** 【`V23-M5-T11`】組織オーナーの名簿の行のグループ(省けば空)。 */
  ownerGroup?: (app: FixtureApp) => Promise<string | undefined>,
): Promise<Installed> {
  const app = await provisionApp(request);
  const base = structuredClone(app.manifest) as unknown as {
    app: {
      workspace?: Record<string, unknown>;
      tables: unknown[];
      views: unknown[];
      roles?: { id: string; name?: string; rules?: unknown[] }[];
    };
  };
  const p = parts(options);
  base.app.tables.push(...p.tables);
  base.app.views.push(...p.views);
  base.app.workspace = { ...(base.app.workspace ?? {}), invitations: p.workspaceInvitations };
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
  const tableRules = (can: string[]) =>
    [ORGS, MEMBERS, GROUPS, GRANTS].map((table) => ({ target: "table", table, can }));
  const viewRules = [LIST, DETAIL].map((view) => ({ target: "view", view, can: ["read"] }));
  const owner = roles.find((role) => role.id === "owner");
  if (owner !== undefined) {
    owner.rules = [
      ...(owner.rules ?? []),
      ...tableRules(["read", "write", "delete"]),
      ...viewRules,
    ];
  }
  const memberRules = [
    { target: "table", table: ORGS, can: ["read", "write", "delete"] },
    { target: "table", table: GRANTS, can: ["read", "write", "delete"] },
    { target: "table", table: MEMBERS, can: ["read"] },
    { target: "table", table: GROUPS, can: ["read"] },
    ...viewRules,
  ];
  roles.push(
    { id: "staff", name: "担当", rules: memberRules },
    { id: "guest", name: "来客", rules: memberRules },
  );
  base.app.roles = roles;
  const applied = await request.post(`/__e2e__/apps/${app.appId}/manifest`, { data: base });
  expect(applied.status(), await applied.text()).toBe(200);

  const orgOwner = await seedRoleSession(request, app.appId, "staff");
  const invitee = await seedRoleSession(request, app.appId, "staff");
  const outsider = await seedRoleSession(request, app.appId, "guest");
  const inviteeGroup = memberGroup === undefined ? undefined : await memberGroup(app);
  const orgOwnerGroup = ownerGroup === undefined ? undefined : await ownerGroup(app);
  const memberRows = new Map<string, string>();
  for (const person of [orgOwner, invitee, outsider]) {
    const row = await app.createRecord(MEMBERS, {
      name: person.username,
      account: person.userId,
      ...(person === invitee && inviteeGroup !== undefined ? { grp: inviteeGroup } : {}),
      ...(person === orgOwner && orgOwnerGroup !== undefined ? { grp: orgOwnerGroup } : {}),
    });
    memberRows.set(person.username, row);
  }
  return { app, orgOwner, invitee, outsider, memberRows };
}

/** その人のセッションで組織を1行作る(作成者に「組織オーナー」が付く)。 */
async function createOrg(
  request: APIRequestContext,
  app: FixtureApp,
  who: RoleSession,
  data: Record<string, unknown>,
): Promise<string> {
  const created = await request.post(`/api/apps/${app.appId}/tables/${ORGS}/records`, {
    data,
    headers: who.authHeaders,
  });
  expect(created.status(), await created.text()).toBe(201);
  return ((await created.json()) as { record: { _id: string } }).record._id;
}

/** その人のセッションで表の行を読む。 */
async function rowsAs(
  request: APIRequestContext,
  app: FixtureApp,
  headers: { cookie: string },
  tableId: string,
): Promise<Record<string, unknown>[]> {
  const response = await request.get(`/api/apps/${app.appId}/tables/${tableId}/records`, {
    headers,
  });
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { records: Record<string, unknown>[] }).records;
}

/** 人ごとの context と page。 */
async function pageFor(browser: Browser, who: RoleSession): Promise<Page> {
  const context = await browser.newContext();
  await who.authenticate(context);
  return context.newPage();
}

/** 行の詳細の部品から1件招待し、「招待しました」の文を返す。 */
async function inviteFromDetail(page: Page, login: string, permissionLabel: string) {
  const panel = page.getByTestId("row-invitations");
  await panel.getByTestId("row-invitation-login").fill(login);
  await panel.getByTestId("row-invitation-permission").selectOption({ label: permissionLabel });
  await panel.getByTestId("row-invitation-submit").click();
  const issued = panel.getByTestId("row-invitation-issued");
  await expect(issued).toBeVisible();
  await expect(panel.getByTestId("row-invitation-errors")).toHaveCount(0);
  // 入力が空に戻るのを待つ(次の招待と混ざらないように)。
  await expect(panel.getByTestId("row-invitation-login")).toHaveValue("");
  return (await issued.textContent()) ?? "";
}

/** メニューの「招待」から受け取り画面を開く。 */
async function openInbox(page: Page, app: FixtureApp): Promise<void> {
  await page.goto(`/apps/${app.appId}/views/${LIST}`);
  const item = page.getByTestId("view-list-invitations");
  await expect(item).toBeVisible();
  await expect(item).toContainText(MENU_LABEL);
  await item.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/apps/${app.appId}/invitations$`));
  await expect(page.getByTestId("invitation-inbox")).toBeVisible();
}

test.describe("行の招待(V23-M5)", () => {
  test("(A) 組織オーナーが詳細から招待し、相手が受け取り画面で承諾すると行が読める。存在しない名前・役割が合わない相手も同じ表示で、合わない人には届かない", async ({
    browser,
    request,
  }) => {
    const { app, orgOwner, invitee, outsider } = await install(request);
    const orgId = await createOrg(request, app, orgOwner, { title: "北支店", secret: SECRET });

    // 承諾の前: 相手は組織を読めない(HTTP と画面の両方)。
    expect(await rowsAs(request, app, invitee.authHeaders, ORGS)).toEqual([]);
    const inviteePage = await pageFor(browser, invitee);
    await inviteePage.goto(`/apps/${app.appId}/views/${LIST}`);
    await expect(inviteePage.getByTestId("view-renderer-list_view")).toBeVisible();
    await expect(inviteePage.getByTestId("view-renderer-list_view")).not.toContainText("北支店");
    // 招待が無いうちは、受け取り画面は空。
    await openInbox(inviteePage, app);
    await expect(inviteePage.getByTestId("invitation-inbox-empty")).toBeVisible();

    // 組織オーナー(運営でない)が行の詳細から招待する。
    const ownerPage = await pageFor(browser, orgOwner);
    await ownerPage.goto(`/apps/${app.appId}/views/${DETAIL}/records/${orgId}`);
    await expect(ownerPage.getByTestId("current-role")).toHaveAttribute("data-role", "staff");
    const panel = ownerPage.getByTestId("row-invitations");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("row-invitation-pending-empty")).toBeVisible();
    const issuedReal = await inviteFromDetail(ownerPage, invitee.username, "メンバー");
    expect(issuedReal).toContain("招待しました");
    const pending = panel.getByTestId("row-invitation-pending-item");
    await expect(pending).toHaveCount(1);
    await expect(pending.first()).toContainText(invitee.username);
    await expect(pending.first()).toContainText("メンバー");
    await expect(pending.first()).toContainText(orgOwner.username);

    // 存在しないログイン名・役割が合わない相手への招待も、画面の表示が同じ。
    const issuedGhost = await inviteFromDetail(ownerPage, "no-such-person-t10", "閲覧のみ");
    const issuedOutsider = await inviteFromDetail(ownerPage, outsider.username, "メンバー");
    console.log(`T10 issued texts: ${JSON.stringify([issuedReal, issuedGhost, issuedOutsider])}`);
    expect(issuedGhost).toBe(issuedReal);
    expect(issuedOutsider).toBe(issuedReal);
    await expect(pending).toHaveCount(3);
    await expect(panel).toContainText("no-such-person-t10");

    // 相手: メニューの「招待」から受け取り画面を開き、代表項目・招待者・権限名だけを見る。
    await openInbox(inviteePage, app);
    const item = inviteePage.getByTestId("invitation-inbox-item");
    await expect(item).toHaveCount(1);
    await expect(item.getByTestId("invitation-inbox-table")).toHaveText("組織");
    await expect(item.getByTestId("invitation-inbox-representative")).toHaveText("北支店");
    await expect(item.getByTestId("invitation-inbox-inviter")).toContainText(orgOwner.username);
    await expect(item.getByTestId("invitation-inbox-permission")).toContainText("メンバー");
    await expect(item.getByTestId("invitation-inbox-expires")).toContainText(/\d{4}-\d{2}-\d{2}/);
    // 代表項目以外の中身は見えない。
    await expect(inviteePage.getByTestId("invitation-inbox")).not.toContainText(SECRET);
    await expect(inviteePage.getByTestId("invitation-inbox")).not.toContainText(orgId);
    // 承諾の前は、詳細も開けない(HTTP で 404)。
    const before = await request.get(`/api/apps/${app.appId}/tables/${ORGS}/records/${orgId}`, {
      headers: invitee.authHeaders,
    });
    expect(before.status()).toBe(404);

    await item.getByTestId("invitation-accept").click();
    await expect(inviteePage.getByTestId("invitation-inbox-notice")).toHaveText(
      "招待を承諾しました。",
    );
    await expect(inviteePage.getByTestId("invitation-inbox-item")).toHaveCount(0);
    await expect(inviteePage.getByTestId("invitation-inbox-empty")).toBeVisible();

    // 承諾の後: 一覧と詳細に出る。
    await inviteePage.goto(`/apps/${app.appId}/views/${LIST}`);
    await expect(inviteePage.getByTestId("view-renderer-list_view")).toContainText("北支店");
    await inviteePage.goto(`/apps/${app.appId}/views/${DETAIL}/records/${orgId}`);
    await expect(inviteePage.getByTestId("detail-field-title")).toHaveText("北支店");
    await expect(inviteePage.getByTestId("detail-field-secret")).toHaveText(SECRET);
    // 「メンバー」は招待できない権限なので、相手の詳細に招待の部品は出ない。
    await expect(inviteePage.getByTestId("row-invitations")).toHaveCount(0);
    const grants = await rowsAs(request, app, app.authHeaders, GRANTS);
    expect(grants.filter((row) => row.permission === "org_member")).toHaveLength(1);

    // 役割が合わない人の受け取り画面には出ない。
    const outsiderPage = await pageFor(browser, outsider);
    await openInbox(outsiderPage, app);
    await expect(outsiderPage.getByTestId("invitation-inbox-empty")).toBeVisible();
    await expect(outsiderPage.getByTestId("invitation-inbox-item")).toHaveCount(0);

    // 組織オーナーの未承諾の一覧から、承諾された招待が消えている(残りは2件)。
    await ownerPage.reload();
    await expect(ownerPage.getByTestId("row-invitation-pending-item")).toHaveCount(2);
    await expect(ownerPage.getByTestId("row-invitations")).not.toContainText(invitee.username);
  });

  test("(R) 組織オーナーが取り消すと、未承諾の一覧から消え、相手の受け取り画面にも出ない", async ({
    browser,
    request,
  }) => {
    const { app, orgOwner, invitee } = await install(request);
    const orgId = await createOrg(request, app, orgOwner, { title: "南支店" });
    const ownerPage = await pageFor(browser, orgOwner);
    await ownerPage.goto(`/apps/${app.appId}/views/${DETAIL}/records/${orgId}`);
    await inviteFromDetail(ownerPage, invitee.username, "閲覧のみ");
    const pending = ownerPage.getByTestId("row-invitation-pending-item");
    await expect(pending).toHaveCount(1);

    // 取消の前は相手に届いている(陽性対照)。
    const inviteePage = await pageFor(browser, invitee);
    await openInbox(inviteePage, app);
    await expect(inviteePage.getByTestId("invitation-inbox-item")).toHaveCount(1);
    await expect(inviteePage.getByTestId("invitation-inbox-representative")).toHaveText("南支店");

    await pending.first().getByTestId("row-invitation-revoke").click();
    await expect(pending).toHaveCount(0);
    await expect(ownerPage.getByTestId("row-invitation-pending-empty")).toBeVisible();
    await ownerPage.reload();
    await expect(ownerPage.getByTestId("row-invitation-pending-empty")).toBeVisible();

    await inviteePage.reload();
    await expect(inviteePage.getByTestId("invitation-inbox")).toBeVisible();
    await expect(inviteePage.getByTestId("invitation-inbox-empty")).toBeVisible();
    await expect(inviteePage.getByTestId("invitation-inbox-item")).toHaveCount(0);
    expect(await rowsAs(request, app, invitee.authHeaders, ORGS)).toEqual([]);
  });

  test("(G) group_from を書いた台で、承諾の後に名簿のグループ欄が招待した行の値に変わる", async ({
    browser,
    request,
  }) => {
    let oldGroup = "";
    // 【`V23-M5-T11`】旧は `newGroup` を install の後に作り、組織オーナーは所属グループなしだった。 今日は承諾で
    // 書くグループが招待者自身のグループと同じときだけ通るので、組織オーナーを北支店グループの一員にする。
    let newGroup = "";
    const { app, orgOwner, invitee, memberRows } = await install(
      request,
      { groupFrom: true },
      async (provisioned) => {
        oldGroup = await provisioned.createRecord(GROUPS, { title: "旧グループ" });
        return oldGroup;
      },
      async (provisioned) => {
        newGroup = await provisioned.createRecord(GROUPS, { title: "北支店グループ" });
        return newGroup;
      },
    );
    const orgId = await createOrg(request, app, orgOwner, { title: "北支店", grp: newGroup });
    const memberRowId = memberRows.get(invitee.username);
    const memberRow = async () =>
      (await rowsAs(request, app, app.authHeaders, MEMBERS)).find((row) => row._id === memberRowId);
    expect((await memberRow())?.grp).toBe(oldGroup);

    const ownerPage = await pageFor(browser, orgOwner);
    await ownerPage.goto(`/apps/${app.appId}/views/${DETAIL}/records/${orgId}`);
    await inviteFromDetail(ownerPage, invitee.username, "メンバー");

    const inviteePage = await pageFor(browser, invitee);
    await openInbox(inviteePage, app);
    await expect(inviteePage.getByTestId("invitation-inbox-changes-group")).toHaveText(
      "承諾すると所属グループが替わり、今のグループを通した権限は無くなります。",
    );
    await expect(inviteePage.getByTestId("invitation-inbox")).not.toContainText("北支店グループ");
    await inviteePage.getByTestId("invitation-accept").click();
    await expect(inviteePage.getByTestId("invitation-inbox-notice")).toHaveText(
      "招待を承諾しました。",
    );
    const after = await memberRow();
    console.log(`T10 member row after accept: ${JSON.stringify(after)}`);
    expect(after?.grp).toBe(newGroup);
    expect((await rowsAs(request, app, invitee.authHeaders, ORGS)).map((row) => row._id)).toEqual([
      orgId,
    ]);
  });

  test("(G2) 組織オーナーの入っていないグループの行への招待は、承諾が理由付きで断られ、招待は残り、名簿のグループ欄は変わらない(`V23-M5-T11`)", async ({
    browser,
    request,
  }) => {
    let oldGroup = "";
    let ownGroup = "";
    const { app, orgOwner, invitee, memberRows } = await install(
      request,
      { groupFrom: true },
      async (provisioned) => {
        oldGroup = await provisioned.createRecord(GROUPS, { title: "旧グループ" });
        return oldGroup;
      },
      async (provisioned) => {
        ownGroup = await provisioned.createRecord(GROUPS, { title: "北支店グループ" });
        return ownGroup;
      },
    );
    const otherGroup = await app.createRecord(GROUPS, { title: "本社グループ" });
    const orgId = await createOrg(request, app, orgOwner, { title: "本社", grp: otherGroup });
    const memberRowId = memberRows.get(invitee.username);
    const memberRow = async () =>
      (await rowsAs(request, app, app.authHeaders, MEMBERS)).find((row) => row._id === memberRowId);

    const ownerPage = await pageFor(browser, orgOwner);
    await ownerPage.goto(`/apps/${app.appId}/views/${DETAIL}/records/${orgId}`);
    await inviteFromDetail(ownerPage, invitee.username, "メンバー");

    const inviteePage = await pageFor(browser, invitee);
    await openInbox(inviteePage, app);
    await inviteePage.getByTestId("invitation-accept").click();
    await expect(inviteePage.getByTestId("invitation-inbox-error")).toContainText(
      "招待した人の所属グループとは別のグループへ入れるものなので承諾できません",
    );
    await expect(inviteePage.getByTestId("invitation-inbox-item")).toHaveCount(1);
    expect((await memberRow())?.grp).toBe(oldGroup);
    expect(await rowsAs(request, app, invitee.authHeaders, ORGS)).toEqual([]);
    expect(ownGroup).not.toBe(otherGroup);
  });

  test("(U) 付与表の unique_message に当たる承諾は、その文言が受け取り画面に出て、招待は残る", async ({
    browser,
    request,
  }) => {
    const { app, orgOwner, invitee } = await install(request, { uniqueMember: true });
    const orgId = await createOrg(request, app, orgOwner, { title: "北支店" });
    // 相手は自分の組織をすでに持っている(作成者の付与で所属済み)。
    const ownOrg = await createOrg(request, app, invitee, { title: "相手の組織" });

    const ownerPage = await pageFor(browser, orgOwner);
    await ownerPage.goto(`/apps/${app.appId}/views/${DETAIL}/records/${orgId}`);
    await inviteFromDetail(ownerPage, invitee.username, "メンバー");

    const inviteePage = await pageFor(browser, invitee);
    await openInbox(inviteePage, app);
    const item = inviteePage.getByTestId("invitation-inbox-item");
    await expect(item).toHaveCount(1);
    await item.getByTestId("invitation-accept").click();
    const refusal = item.getByTestId("invitation-inbox-error");
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText(UNIQUE_MESSAGE);
    await expect(inviteePage.getByTestId("invitation-inbox-notice")).toHaveCount(0);
    // 招待は残り、付与は増えていない。
    await inviteePage.reload();
    await expect(inviteePage.getByTestId("invitation-inbox-item")).toHaveCount(1);
    expect((await rowsAs(request, app, invitee.authHeaders, ORGS)).map((row) => row._id)).toEqual([
      ownOrg,
    ]);
    await ownerPage.reload();
    await expect(ownerPage.getByTestId("row-invitation-pending-item")).toHaveCount(1);
  });

  test("(N) 招待を宣言しないアプリには、メニューの「招待」が出ず、/invitations は「無い」と出る", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    let inboxCalls = 0;
    page.on("request", (sent) => {
      if (new URL(sent.url()).pathname === `/api/apps/${app.appId}/invitations`) {
        inboxCalls += 1;
      }
    });
    await page.goto(`/apps/${app.appId}`);
    await expect(page.getByTestId("view-list")).toBeVisible();
    await expect(page.getByTestId("view-list-invitations")).toHaveCount(0);
    await page.goto(`/apps/${app.appId}/invitations`);
    await expect(page.getByTestId("invitations-missing")).toBeVisible();
    await expect(page.getByTestId("invitation-inbox")).toHaveCount(0);
    expect(inboxCalls).toBe(0);
  });
});

async function postDiff(
  request: APIRequestContext,
  appId: string,
  headers: { cookie: string },
  diff: Diff,
): Promise<void> {
  const applied = await request.post(`/api/apps/${appId}/diffs`, { data: diff, headers });
  expect(applied.status(), await applied.text()).toBe(201);
}

function workspaceDiff(diffId: string, workspace: Record<string, unknown>): Diff {
  return {
    diff_id: diffId,
    intent: "届いた招待を受け取る頁をメニューに置きたい、という要望に応えた",
    operations: [{ op: "set_workspace", workspace }],
  } as unknown as Diff;
}

test.describe("行の招待・配る版(V23-M5)", () => {
  test("(F) 配る版でも、メニューの「招待」から受け取り画面が開く", async ({ page, request }) => {
    const seeded = await request.post(`/__e2e__/apps/${RUNNER_APP_ID}/session`);
    expect(seeded.status(), await seeded.text()).toBe(201);
    const spec = (await seeded.json()) as { name: string; value: string; path: string };
    const headers = { cookie: `${spec.name}=${spec.value}` };
    // 配る版には差分の口が無いので、育成用の版の口で同じアプリに宣言する。
    await postDiff(
      request,
      RUNNER_APP_ID,
      headers,
      workspaceDiff("runner-row-invitations", { invitations: { label: MENU_LABEL } }),
    );
    try {
      await page
        .context()
        .addCookies([
          { name: spec.name, value: spec.value, url: `http://localhost:${port}${spec.path}` },
        ]);
      await page.goto(`${runnerBase}/apps/${RUNNER_APP_ID}`);
      const item = page.getByTestId("view-list-invitations");
      await expect(item).toBeVisible();
      await expect(item).toContainText(MENU_LABEL);
      await item.getByRole("link").click();
      await expect(page).toHaveURL(new RegExp(`/apps/${RUNNER_APP_ID}/invitations$`));
      await expect(page.getByTestId("invitation-inbox")).toBeVisible();
      await expect(page.getByTestId("invitation-inbox")).toContainText(MENU_LABEL);
      await expect(page.getByTestId("invitation-inbox-empty")).toBeVisible();
    } finally {
      // 後始末: 招待の宣言だけを消す(配る版のアプリは他の検査と共有している)。
      await postDiff(
        request,
        RUNNER_APP_ID,
        headers,
        workspaceDiff("runner-row-invitations-clear", { invitations: null }),
      );
    }
  });
});
