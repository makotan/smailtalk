/**
 * **行を相手にした付与とコードの招待を画面で通す**(`V23-M6-T06b`。門A `ADR-0502`(`SC-G20`・`SC-G21`)を補う
 * `ADR-0538`、計画 `docs/plan/v23/00-v23-plan.md` §25-3 の T08(§25-6 で T06b)、決定 `D-V23-145`〜`D-V23-176`)。
 *
 * - (A) 評価機関(相手の行)の管理者が、評価機関の詳細で招待用コードを発行する → 組織の管理者が、組織の詳細の「招待する」で
 *   コードに切り替えて招待する(未承諾の一覧には評価機関の名前が出る)→ 評価機関の管理者が、メニューの「招待」の受け取り画面で
 *   「受ける行」を見て承諾する → 評価機関の専門家が、組織側で何もしなくても組織を読める(一覧と詳細)→ 組織の管理者の付与の一覧に
 *   評価機関の名前が出る(「見つかりません」にならない)→ 評価機関の管理者が専門家を外すと、専門家はすぐ組織を読めない。
 * - (F) 配る版でも、受け取り画面にコードの招待の「受ける行」が出る(配る版のアプリは他の検査と共有しているので、自分宛ての一覧の口
 *   の答えだけを差し替える。本物の口の答えの形は `src/server/row-code-invitations.test.ts`)。
 *
 * 題材の定義はこのファイルが持ち、フィクスチャサーバの `/__e2e__/apps/:id/manifest` で入れる(`row-invitations.e2e.ts` と同じ作法)。
 * カーネルの値は1つも import しない。
 */
import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";
import type { Diff } from "../../src/kernel/types.ts";
import { type FixtureApp, provisionApp, type RoleSession, seedRoleSession } from "./fixture-app.ts";

const port = Number(process.env.ST_E2E_PORT ?? 3210);
/** 配る版の置き場(`row-invitations.e2e.ts` と同じ)。 */
const runnerBase = `http://localhost:${port + 1}`;
const RUNNER_APP_ID = "runner-e2e";

const MEMBERS = "pr_members";
const AGENCIES = "pr_agencies";
const AGENCY_GRANTS = "pr_agency_grants";
const ORGS = "pr_orgs";
const ORG_GRANTS = "pr_org_grants";
const ORG_LIST = "pr-org-list";
const ORG_DETAIL = "pr-org-detail";
const AGENCY_DETAIL = "pr-agency-detail";
const GRANT_LIST = "pr-org-grant-list";

const MENU_LABEL = "届いた招待";
const AGENCY_NAME = "東評価機関";
const ORG_NAME = "北の組織";
const SECRET = "審査メモ 7788";

function parts() {
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
        fields: [
          { id: "title", name: "組織名", type: "text" },
          { id: "secret", name: "内部メモ", type: "text" },
        ],
        access_control: {
          enabled: true,
          permissions: [
            { id: "org_admin", name: "組織の管理者", read: true, write: true, delete: true },
            { id: "org_viewer", name: "閲覧のみ", read: true, write: false, delete: false },
          ],
          creator_permission: "org_admin",
          creatable_by_roles: ["staff", "owner"],
          grant: {
            table: ORG_GRANTS,
            target: "org",
            member: "member",
            permission: "permission",
            principal_row: { column: "agency", table: AGENCIES, via: ["ag_expert"] },
          },
          members: { table: MEMBERS, account: "account" },
          invitations: { grantable: ["org_viewer"], expires_days: 5 },
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
            options: ["org_admin", "org_viewer"],
            required: true,
          },
        ],
      },
    ],
    views: [
      { id: ORG_LIST, type: "list_view", name: "組織の一覧", table: ORGS, columns: ["title"] },
      {
        id: ORG_DETAIL,
        type: "detail_view",
        name: "組織の詳細",
        table: ORGS,
        fields: ["title", "secret"],
      },
      {
        id: AGENCY_DETAIL,
        type: "detail_view",
        name: "評価機関の詳細",
        table: AGENCIES,
        fields: ["title"],
      },
      {
        id: GRANT_LIST,
        type: "list_view",
        name: "組織の付与の一覧",
        table: ORG_GRANTS,
        columns: ["org", "agency", "permission"],
      },
    ],
  };
}

type Installed = {
  app: FixtureApp;
  agencyAdmin: RoleSession;
  orgAdmin: RoleSession;
  expert: RoleSession;
  memberRows: Map<string, string>;
};

/** 払い出したアプリに題材を足して入れ直し、人を3人仕込んで名簿に載せる。 */
async function install(request: APIRequestContext): Promise<Installed> {
  const app = await provisionApp(request);
  const base = structuredClone(app.manifest) as unknown as {
    app: {
      workspace?: Record<string, unknown>;
      tables: unknown[];
      views: unknown[];
      roles?: { id: string; name?: string; rules?: unknown[] }[];
    };
  };
  const p = parts();
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
  const all = [MEMBERS, AGENCIES, AGENCY_GRANTS, ORGS, ORG_GRANTS];
  const viewRules = [ORG_LIST, ORG_DETAIL, AGENCY_DETAIL, GRANT_LIST].map((view) => ({
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
  roles.push({
    id: "staff",
    name: "担当",
    rules: [
      ...[AGENCIES, AGENCY_GRANTS, ORGS, ORG_GRANTS].map((table) => ({
        target: "table",
        table,
        can: ["read", "write", "delete"],
      })),
      { target: "table", table: MEMBERS, can: ["read"] },
      ...viewRules,
    ],
  });
  base.app.roles = roles;
  const applied = await request.post(`/__e2e__/apps/${app.appId}/manifest`, { data: base });
  expect(applied.status(), await applied.text()).toBe(200);

  const agencyAdmin = await seedRoleSession(request, app.appId, "staff");
  const orgAdmin = await seedRoleSession(request, app.appId, "staff");
  const expert = await seedRoleSession(request, app.appId, "staff");
  const memberRows = new Map<string, string>();
  for (const person of [agencyAdmin, orgAdmin, expert]) {
    const row = await app.createRecord(MEMBERS, {
      name: person.username,
      account: person.userId,
    });
    memberRows.set(person.username, row);
  }
  return { app, agencyAdmin, orgAdmin, expert, memberRows };
}

/** その人のセッションで1行作る(行ごとの権限の表なら作成者に管理者の権限が付く)。 */
async function createAs(
  request: APIRequestContext,
  app: FixtureApp,
  who: RoleSession,
  tableId: string,
  data: Record<string, unknown>,
): Promise<string> {
  const created = await request.post(`/api/apps/${app.appId}/tables/${tableId}/records`, {
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

async function pageFor(browser: Browser, who: RoleSession): Promise<Page> {
  const context = await browser.newContext();
  await who.authenticate(context);
  return context.newPage();
}

test.describe("行を相手にした付与とコードの招待(V23-M6)", () => {
  test("(A) 評価機関の管理者がコードを発行し、組織の管理者がコードで招待し、評価機関の管理者が承諾すると、専門家が組織を読める。外すとすぐ読めない", async ({
    browser,
    request,
  }) => {
    const { app, agencyAdmin, orgAdmin, expert, memberRows } = await install(request);
    const agencyId = await createAs(request, app, agencyAdmin, AGENCIES, { title: AGENCY_NAME });
    const expertGrant = await createAs(request, app, agencyAdmin, AGENCY_GRANTS, {
      agency: agencyId,
      member: memberRows.get(expert.username),
      permission: "ag_expert",
    });
    const orgId = await createAs(request, app, orgAdmin, ORGS, { title: ORG_NAME, secret: SECRET });

    // 承諾の前: 専門家は組織を読めない。
    expect(await rowsAs(request, app, expert.authHeaders, ORGS)).toEqual([]);

    // 1. 評価機関の管理者が、評価機関の詳細で招待用コードを発行する。
    const agencyPage = await pageFor(browser, agencyAdmin);
    await agencyPage.goto(`/apps/${app.appId}/views/${AGENCY_DETAIL}/records/${agencyId}`);
    const codePanel = agencyPage.getByTestId("row-invite-code");
    await expect(codePanel).toBeVisible();
    await expect(agencyPage.getByTestId("row-invite-code-none")).toBeVisible();
    await agencyPage.getByTestId("row-invite-code-issue").click();
    const codeValue = agencyPage.getByTestId("row-invite-code-value");
    await expect(codeValue).toHaveText(/^[0-9A-Z]{8}$/);
    const code = (await codeValue.textContent()) ?? "";
    await expect(agencyPage.getByTestId("row-invite-code-reissue")).toBeVisible();

    // 組織の管理者には、評価機関のコードの欄は見えない(口が 404 → 何も描かない)。
    const orgPage = await pageFor(browser, orgAdmin);
    const codeSeen = await request.get(
      `/api/apps/${app.appId}/tables/${AGENCIES}/records/${agencyId}/invite-code`,
      { headers: orgAdmin.authHeaders },
    );
    expect(codeSeen.status()).toBe(404);

    // 2. 組織の管理者が、組織の詳細の「招待する」をコードに切り替えて招待する。
    await orgPage.goto(`/apps/${app.appId}/views/${ORG_DETAIL}/records/${orgId}`);
    const panel = orgPage.getByTestId("row-invitations");
    await expect(panel).toBeVisible();
    await panel.getByTestId("row-invitation-mode").selectOption("code");
    await panel.getByTestId("row-invitation-code").fill(code);
    await panel.getByTestId("row-invitation-permission").selectOption({ label: "閲覧のみ" });
    await panel.getByTestId("row-invitation-submit").click();
    await expect(panel.getByTestId("row-invitation-issued")).toBeVisible();
    const pending = panel.getByTestId("row-invitation-pending-item");
    await expect(pending).toHaveCount(1);
    await expect(pending.first().getByTestId("row-invitation-pending-principal")).toHaveText(
      `相手の行: ${AGENCY_NAME}`,
    );

    // 招待だけでは、専門家はまだ読めない。
    expect(await rowsAs(request, app, expert.authHeaders, ORGS)).toEqual([]);

    // 3. 評価機関の管理者が、メニューの「招待」の受け取り画面で「受ける行」を見て承諾する。
    await agencyPage.goto(`/apps/${app.appId}/views/${ORG_LIST}`);
    const menu = agencyPage.getByTestId("view-list-invitations");
    await expect(menu).toContainText(MENU_LABEL);
    await menu.getByRole("link").click();
    await expect(agencyPage).toHaveURL(new RegExp(`/apps/${app.appId}/invitations$`));
    const item = agencyPage.getByTestId("invitation-inbox-item");
    await expect(item).toHaveCount(1);
    await expect(item.getByTestId("invitation-inbox-representative")).toHaveText(ORG_NAME);
    await expect(item.getByTestId("invitation-inbox-principal")).toHaveText(
      `受ける行: ${AGENCY_NAME}`,
    );
    await expect(agencyPage.getByTestId("invitation-inbox")).not.toContainText(SECRET);
    await item.getByTestId("invitation-accept").click();
    await expect(agencyPage.getByTestId("invitation-inbox-notice")).toHaveText(
      "招待を承諾しました。",
    );
    await expect(agencyPage.getByTestId("invitation-inbox-item")).toHaveCount(0);

    // 専門家の受け取り画面には届かない(受け手は評価機関の管理者だけ)。 承諾の後なので空。
    const expertPage = await pageFor(browser, expert);
    await expertPage.goto(`/apps/${app.appId}/invitations`);
    await expect(expertPage.getByTestId("invitation-inbox-empty")).toBeVisible();

    // 4. 専門家は、組織側で何もしなくても組織を読める(HTTP と画面)。
    expect((await rowsAs(request, app, expert.authHeaders, ORGS)).map((row) => row._id)).toEqual([
      orgId,
    ]);
    await expertPage.goto(`/apps/${app.appId}/views/${ORG_LIST}`);
    await expect(expertPage.getByTestId("view-renderer-list_view")).toContainText(ORG_NAME);
    await expertPage.goto(`/apps/${app.appId}/views/${ORG_DETAIL}/records/${orgId}`);
    await expect(expertPage.getByTestId("detail-field-secret")).toHaveText(SECRET);
    // 専門家は組織の招待を出せない(招待の部品は出ない)。
    await expect(expertPage.getByTestId("row-invitations")).toHaveCount(0);

    // 組織の管理者の付与の一覧には、評価機関の名前が出る(読めない行でも「見つかりません」にしない)。
    await orgPage.goto(`/apps/${app.appId}/views/${GRANT_LIST}`);
    const grantList = orgPage.getByTestId("view-renderer-list_view");
    await expect(grantList).toContainText(AGENCY_NAME);
    await expect(grantList).not.toContainText("見つかりません");
    // 未承諾の一覧からは消えている。
    await orgPage.goto(`/apps/${app.appId}/views/${ORG_DETAIL}/records/${orgId}`);
    await expect(orgPage.getByTestId("row-invitation-pending-empty")).toBeVisible();

    // 5. 評価機関の管理者が専門家を外すと、専門家はすぐ組織を読めない。
    const grantPath = `/api/apps/${app.appId}/tables/${AGENCY_GRANTS}/records/${expertGrant}`;
    const current = await request.get(grantPath, { headers: agencyAdmin.authHeaders });
    expect(current.status(), await current.text()).toBe(200);
    const removed = await request.delete(grantPath, {
      headers: { ...agencyAdmin.authHeaders, "if-match": current.headers().etag ?? "" },
    });
    expect(removed.status(), await removed.text()).toBe(204);
    expect(await rowsAs(request, app, expert.authHeaders, ORGS)).toEqual([]);
    await expertPage.goto(`/apps/${app.appId}/views/${ORG_LIST}`);
    await expect(expertPage.getByTestId("view-renderer-list_view")).toBeVisible();
    await expect(expertPage.getByTestId("view-renderer-list_view")).not.toContainText(ORG_NAME);
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

test.describe("行を相手にした付与とコードの招待・配る版(V23-M6)", () => {
  test("(F) 配る版の受け取り画面にも、コードの招待の「受ける行」が出る", async ({
    page,
    request,
  }) => {
    const seeded = await request.post(`/__e2e__/apps/${RUNNER_APP_ID}/session`);
    expect(seeded.status(), await seeded.text()).toBe(201);
    const spec = (await seeded.json()) as { name: string; value: string; path: string };
    const headers = { cookie: `${spec.name}=${spec.value}` };
    await postDiff(
      request,
      RUNNER_APP_ID,
      headers,
      workspaceDiff("runner-principal-row", { invitations: { label: MENU_LABEL } }),
    );
    try {
      // 自分宛ての一覧の口の答えだけを差し替える(配る版のアプリは他の検査と共有しているため)。
      await page.route(`**/api/apps/${RUNNER_APP_ID}/invitations`, (route) =>
        route.request().method() === "GET"
          ? route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                invitations: [
                  {
                    id: "inv-code",
                    representative: ORG_NAME,
                    inviter_name: "組織の管理者",
                    permission_name: "閲覧のみ",
                    table_name: "組織",
                    expires_at: "2099-01-01T00:00:00.000Z",
                    changes_group: false,
                    principal_label: AGENCY_NAME,
                  },
                ],
              }),
            })
          : route.continue(),
      );
      await page
        .context()
        .addCookies([
          { name: spec.name, value: spec.value, url: `http://localhost:${port}${spec.path}` },
        ]);
      await page.goto(`${runnerBase}/apps/${RUNNER_APP_ID}`);
      const menu = page.getByTestId("view-list-invitations");
      await expect(menu).toBeVisible();
      await menu.getByRole("link").click();
      await expect(page).toHaveURL(new RegExp(`/apps/${RUNNER_APP_ID}/invitations$`));
      const item = page.getByTestId("invitation-inbox-item");
      await expect(item).toHaveCount(1);
      await expect(item.getByTestId("invitation-inbox-representative")).toHaveText(ORG_NAME);
      await expect(item.getByTestId("invitation-inbox-principal")).toHaveText(
        `受ける行: ${AGENCY_NAME}`,
      );
    } finally {
      await postDiff(
        request,
        RUNNER_APP_ID,
        headers,
        workspaceDiff("runner-principal-row-clear", { invitations: null }),
      );
    }
  });
});
