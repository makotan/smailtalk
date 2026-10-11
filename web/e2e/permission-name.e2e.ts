/**
 * **付与の表の権限の欄を、宣言の名前で出す**(`V23-M12-T03`。決定 `D-V23-356`、門A `ADR-0571` §Decision 1-3)。
 *
 * - 権限の一覧(付与の表の一覧)と、組織の詳細の子の一覧「メンバーと評価機関」で、権限が「オーナー」と名前で見える
 *   (ID の綴りは見えない)。
 * - 権限を変える画面(付与の表の編集画面)の選択肢の見出しが名前で、値は ID。
 * - 名前の見出しを選んで保存すると、一覧の値は名前で出て、HTTP の応答の値は ID のまま。
 *
 * 題材の定義はこのファイルが持ち、フィクスチャサーバの `/__e2e__/apps/:id/manifest` で入れる(`principal-row.e2e.ts` と同じ作法)。
 * カーネルの値は1つも import しない。 ここに出てくるアプリ固有の名前はこのファイル内だけの題材である。
 */
import { type APIRequestContext, expect, test } from "@playwright/test";
import { type FixtureApp, provisionApp } from "./fixture-app.ts";

const MEMBERS = "pn_members";
const ORGS = "pn_orgs";
const ORG_GRANTS = "pn_org_grants";
const ORG_DETAIL = "pn-org-detail";
const GRANT_LIST = "pn-grant-list";
const GRANT_FORM = "pn-grant-form";
const OWNER_ID = "pn_owner_perm";
const MEMBER_ID = "pn_member_perm";

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
        id: ORGS,
        name: "組織",
        representative_field: "title",
        fields: [{ id: "title", name: "組織名", type: "text" }],
        access_control: {
          enabled: true,
          permissions: [
            { id: OWNER_ID, name: "オーナー", read: true, write: true, delete: true },
            { id: MEMBER_ID, name: "メンバー", read: true, write: false, delete: false },
          ],
          creator_permission: OWNER_ID,
          creatable_by_roles: ["owner"],
          grant: { table: ORG_GRANTS, target: "org", member: "member", permission: "permission" },
          members: { table: MEMBERS, account: "account" },
        },
      },
      {
        id: ORG_GRANTS,
        name: "組織の付与",
        fields: [
          { id: "org", name: "組織", type: "reference", reference_table: ORGS, required: true },
          { id: "member", name: "相手", type: "reference", reference_table: MEMBERS },
          {
            id: "permission",
            name: "権限",
            type: "select",
            options: [OWNER_ID, MEMBER_ID],
            required: true,
          },
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
        related: [
          {
            table: ORG_GRANTS,
            via: "org",
            name: "メンバーと評価機関",
            columns: ["member", "permission"],
          },
        ],
      },
      {
        id: GRANT_LIST,
        type: "list_view",
        name: "権限の一覧",
        table: ORG_GRANTS,
        columns: ["org", "member", "permission"],
      },
      {
        id: GRANT_FORM,
        type: "form",
        name: "権限を変える",
        table: ORG_GRANTS,
        fields: ["permission"],
      },
    ],
  };
}

type Installed = { app: FixtureApp; me: string; other: string };

/** 払い出したアプリに題材を足して入れ直し、運営者(既定のセッション)と1人を名簿に載せる。 */
async function install(request: APIRequestContext): Promise<Installed> {
  const app = await provisionApp(request);
  const base = structuredClone(app.manifest) as unknown as {
    app: {
      tables: unknown[];
      views: unknown[];
      roles?: { id: string; name?: string; rules?: unknown[] }[];
    };
  };
  const p = parts();
  base.app.tables.push(...p.tables);
  base.app.views.push(...p.views);
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
  const owner = roles.find((role) => role.id === "owner");
  if (owner !== undefined) {
    owner.rules = [
      ...(owner.rules ?? []),
      ...[MEMBERS, ORGS, ORG_GRANTS].map((table) => ({
        target: "table",
        table,
        can: ["read", "write", "delete"],
      })),
      ...[ORG_DETAIL, GRANT_LIST, GRANT_FORM].map((view) => ({
        target: "view",
        view,
        can: ["read"],
      })),
    ];
  }
  base.app.roles = roles;
  const applied = await request.post(`/__e2e__/apps/${app.appId}/manifest`, { data: base });
  expect(applied.status(), await applied.text()).toBe(200);
  const me = await app.createRecord(MEMBERS, { name: "運営の人", account: app.userId });
  const other = await app.createRecord(MEMBERS, { name: "別の人", account: "someone-else" });
  return { app, me, other };
}

async function grantsOf(
  request: APIRequestContext,
  app: FixtureApp,
): Promise<Record<string, unknown>[]> {
  const response = await request.get(`/api/apps/${app.appId}/tables/${ORG_GRANTS}/records`, {
    headers: app.authHeaders,
  });
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { records: Record<string, unknown>[] }).records;
}

test.describe("V23-M12-T03 D-V23-356: 権限は宣言の名前で出る", () => {
  test("D-V23-356: 権限の一覧と組織の詳細の「メンバーと評価機関」で「オーナー」が見え、権限を変える画面の見出しが名前で、保存後の一覧の値が名前、HTTP の応答は ID", async ({
    page,
    request,
  }) => {
    const { app, other } = await install(request);
    await app.authenticate(page.context());
    // 運営者が組織を作ると、作成者に「オーナー」(ID は OWNER_ID)の付与が付く。
    const orgId = await app.createRecord(ORGS, { title: "北の組織" });
    const otherGrant = await app.createRecord(ORG_GRANTS, {
      org: orgId,
      member: other,
      permission: MEMBER_ID,
    });
    expect((await grantsOf(request, app)).map((row) => row.permission).sort()).toEqual(
      [MEMBER_ID, OWNER_ID].sort(),
    );

    // 1. 権限の一覧: 名前で見え、ID の綴りは見えない。
    await page.goto(`/apps/${app.appId}/views/${GRANT_LIST}`);
    const listRows = page.getByTestId("list-row");
    await expect(listRows).toHaveCount(2);
    const listView = page.getByTestId("list-table");
    await expect(listView.getByText("オーナー", { exact: true })).toHaveCount(1);
    await expect(listView.getByText("メンバー", { exact: true })).toHaveCount(1);
    await expect(listView.getByText(OWNER_ID)).toHaveCount(0);
    await expect(listView.getByText(MEMBER_ID)).toHaveCount(0);

    // 2. 組織の詳細の子の一覧「メンバーと評価機関」でも名前で見える。
    await page.goto(`/apps/${app.appId}/views/${ORG_DETAIL}/records/${orgId}`);
    const related = page.getByTestId("related-list");
    await expect(related.getByRole("heading", { name: "メンバーと評価機関" })).toBeVisible();
    await expect(related.getByTestId("related-row")).toHaveCount(2);
    await expect(related.getByText("オーナー", { exact: true })).toHaveCount(1);
    await expect(related.getByText(OWNER_ID)).toHaveCount(0);

    // 3. 権限を変える画面: 選択肢の見出しは名前、値は ID。 名前の見出しを選んで保存する。
    await page.goto(`/apps/${app.appId}/views/${GRANT_FORM}/records/${otherGrant}`);
    const select = page.locator(`#${GRANT_FORM}-permission`);
    await expect(select).toHaveValue(MEMBER_ID);
    const options = select.locator("option");
    await expect(options).toHaveText(["", "オーナー", "メンバー"]);
    expect(
      await options.evaluateAll((items) => items.map((item) => (item as HTMLOptionElement).value)),
    ).toEqual(["", OWNER_ID, MEMBER_ID]);
    await select.selectOption({ label: "オーナー" });
    await page.getByRole("button", { name: "保存" }).click();
    await expect
      .poll(
        async () =>
          (await grantsOf(request, app)).find((row) => row._id === otherGrant)?.permission,
      )
      .toBe(OWNER_ID);

    // 4. 保存後の一覧の値は名前。 HTTP の一覧・単件の値は ID のまま。
    await page.goto(`/apps/${app.appId}/views/${GRANT_LIST}`);
    await expect(page.getByTestId("list-row")).toHaveCount(2);
    await expect(page.getByTestId("list-table").getByText("オーナー", { exact: true })).toHaveCount(
      2,
    );
    await expect(page.getByTestId("list-table").getByText(OWNER_ID)).toHaveCount(0);
    expect((await grantsOf(request, app)).map((row) => row.permission)).toEqual([
      OWNER_ID,
      OWNER_ID,
    ]);
    const single = await request.get(
      `/api/apps/${app.appId}/tables/${ORG_GRANTS}/records/${otherGrant}`,
      { headers: app.authHeaders },
    );
    expect(single.status()).toBe(200);
    expect(((await single.json()) as { record: Record<string, unknown> }).record.permission).toBe(
      OWNER_ID,
    );
  });
});
