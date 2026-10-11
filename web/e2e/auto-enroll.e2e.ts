/**
 * **名簿への自動登録と行の最後の管理者を、本物のブラウザで確かめる**(`V23-M1-T12`。上位:
 * `docs/adr/0497-auto-enroll-and-last-row-admin.md`・計画 `docs/plan/v23/00-v23-plan.md` §4 の T12)。
 *
 * - (E-1) 名簿に `auto_enroll` を宣言したアプリでは、`signup: open` の立場で登録した直後に、画面から組織を作れる
 *   (FR-3 の受け入れ1)。 名簿に本人の行が1行入っている。
 * - (E-0) 対照(直す前の姿): 同じアプリから `auto_enroll` だけを外すと、登録した直後の組織の作成は
 *   「この表に行を作れるのは、このアプリの利用者の表に登録されている人だけです」で断られ、組織は1行も増えない。
 * - (E-2) 最後の管理者(組織を作った本人)が自分の付与の行を消そうとすると、理由の文面が画面に出て、付与は残る。
 * - (E-3) passkey で登録した人にも名簿の行ができる(`V23-M1-T04` の記録で、passkey の経路は実物で撃てていなかった)。
 * - (E-4) 運営は「管理者のいない行」の一覧を開ける(読取専用)。
 *
 * 題材の定義はこのファイルが持ち、フィクスチャサーバの `/__e2e__/apps/:id/manifest`(定義の丸ごとの投入)で入れる。
 * 丸ごとの投入では宣言の適用時の埋め戻しが走らない(差分の適用だけが走らせる)が、この検査は登録で入る行だけを見る。
 * 名簿の一意索引は最初の書込の前に遅延で張られる(`V23-M1-T08`)。
 */
import { type CDPSession, expect, type Page, test } from "@playwright/test";
import { type FixtureApp, provisionApp } from "./fixture-app.ts";

const PASSWORD = "correct-horse-battery-staple";
/** 名簿に自分の行が無いときの断りの一部(本体の文面)。 */
const NOT_ENROLLED = "利用者の表に登録されている人だけです";
const LAST_ADMIN_MESSAGE =
  "この行の管理者があなただけになるため、あなたの権限は外せません。先に別の人に管理の権限を渡してください。";

/** 組織・名簿・付与表の3表と、登録で名乗れる立場 `member` を持つ定義。 */
function rosterManifest(appId: string, appName: string, declared: boolean): unknown {
  return {
    app: {
      id: appId,
      name: appName,
      roles: [
        {
          id: "owner",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
          ],
        },
        { id: "editor" },
        { id: "viewer" },
        {
          id: "member",
          name: "メンバー",
          signup: "open",
          rules: [
            { target: "view", view: "org-list", can: ["read"] },
            { target: "view", view: "org-form", can: ["read"] },
            { target: "view", view: "grant-detail", can: ["read"] },
            { target: "table", table: "orgs", can: ["read", "write"] },
            { target: "table", table: "mem", can: ["read", "write"] },
            { target: "table", table: "org_grant", can: ["read", "write", "delete"] },
          ],
        },
      ],
      tables: [
        {
          id: "orgs",
          name: "組織",
          fields: [{ id: "title", name: "組織名", type: "text" }],
          access_control: {
            enabled: true,
            permissions: [
              { id: "reader", name: "閲覧", read: true, write: false, delete: false },
              { id: "keeper", name: "管理", read: true, write: true, delete: true },
            ],
            creator_permission: "keeper",
            creatable_by_roles: ["member", "owner"],
            grant: {
              table: "org_grant",
              target: "org",
              member: "member",
              permission: "permission",
            },
            members: {
              table: "mem",
              account: "account",
              ...(declared ? { auto_enroll: { roles: ["member"], name: "display" } } : {}),
            },
          },
        },
        {
          id: "mem",
          name: "名簿",
          fields: [
            { id: "account", name: "利用者ID", type: "text" },
            { id: "display", name: "表示名", type: "text" },
          ],
        },
        {
          id: "org_grant",
          name: "組織の付与",
          fields: [
            { id: "org", name: "組織", type: "reference", reference_table: "orgs" },
            { id: "member", name: "相手", type: "reference", reference_table: "mem" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "keeper"] },
          ],
        },
      ],
      views: [
        {
          id: "org-list",
          type: "list_view",
          name: "組織の一覧",
          table: "orgs",
          columns: ["title"],
        },
        { id: "org-form", type: "form", name: "組織の登録", table: "orgs", fields: ["title"] },
        { id: "grant-detail", type: "detail_view", name: "付与の詳細", table: "org_grant" },
      ],
    },
  };
}

async function installRoster(
  request: Parameters<typeof provisionApp>[0],
  declared: boolean,
): Promise<FixtureApp> {
  const app = await provisionApp(request);
  // 丸ごとの投入は表・画面を消せないので、払い出された定義に題材の表・画面・立場を足す。
  const base = structuredClone(app.manifest) as unknown as {
    app: { tables: unknown[]; views: unknown[]; roles?: { id: string }[] };
  };
  const roster = rosterManifest(app.appId, app.appName, declared) as typeof base;
  base.app.tables.push(...roster.app.tables);
  base.app.views.push(...roster.app.views);
  const roles = (base.app.roles ??
    (roster.app.roles ?? []).filter((role) => role.id !== "member")) as {
    id: string;
    rules?: unknown[];
  }[];
  roles.push(...(roster.app.roles ?? []).filter((role) => role.id === "member"));
  // 題材の表は `member` の規則が名指しするので、フィクスチャサーバは運営に規則を足さない。 運営の分を書く。
  const owner = roles.find((role) => role.id === "owner");
  if (owner !== undefined) {
    owner.rules = [
      ...(owner.rules ?? []),
      ...["orgs", "mem", "org_grant"].map((table) => ({
        target: "table",
        table,
        can: ["read", "write", "delete"],
      })),
      ...["org-list", "org-form", "grant-detail"].map((view) => ({
        target: "view",
        view,
        can: ["read"],
      })),
    ];
  }
  base.app.roles = roles;
  const applied = await request.post(`/__e2e__/apps/${app.appId}/manifest`, { data: base });
  expect(applied.status(), await applied.text()).toBe(200);
  return app;
}

/** 運営のセッションで表の行を読む。 */
async function rowsOf(
  request: Parameters<typeof provisionApp>[0],
  app: FixtureApp,
  tableId: string,
): Promise<Record<string, unknown>[]> {
  const response = await request.get(`/api/apps/${app.appId}/tables/${tableId}/records`, {
    headers: app.authHeaders,
  });
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { records: Record<string, unknown>[] }).records;
}

/** ログイン画面から `member` の立場でパスワード登録する。 */
async function signUpAsMember(page: Page, app: FixtureApp, username: string): Promise<void> {
  await page.goto(`/apps/${app.appId}`);
  await expect(page.getByTestId("login-page")).toBeVisible();
  await page.getByTestId("auth-username").fill(username);
  await page.getByTestId("auth-password").fill(PASSWORD);
  if ((await page.getByTestId("auth-user-kind").count()) > 0) {
    await page.getByTestId("auth-user-kind").selectOption("member");
  }
  await page.getByTestId("customer-password-register").click();
  await expect(page.getByTestId("current-user")).toHaveText(username);
  await expect(page.getByTestId("current-role")).toHaveAttribute("data-role", "member");
}

/** 組織の登録画面から1行作る(押した後の画面は呼び手が見る)。 */
async function submitOrg(page: Page, app: FixtureApp, title: string): Promise<void> {
  await page.goto(`/apps/${app.appId}/views/org-form`);
  await page.getByLabel("組織名").fill(title);
  await page.getByRole("button", { name: /保存/ }).click();
}

test.describe("名簿への自動登録と、行の最後の管理者(V23-M1)", () => {
  test("(E-1) 宣言したアプリでは、登録した直後に組織を作れ、名簿に本人の行が入る", async ({
    page,
    request,
  }) => {
    const app = await installRoster(request, true);
    const username = `member-${Date.now()}`;
    await signUpAsMember(page, app, username);

    const members = await rowsOf(request, app, "mem");
    expect(members.map((row) => row.display)).toEqual([username]);

    await submitOrg(page, app, "北支店");
    await expect
      .poll(async () => (await rowsOf(request, app, "orgs")).map((row) => row.title))
      .toEqual(["北支店"]);
    await expect(page.getByText(NOT_ENROLLED)).toHaveCount(0);
  });

  test("(E-0) 対照: 宣言を外したアプリでは、登録した直後の組織の作成が断られる", async ({
    page,
    request,
  }) => {
    const app = await installRoster(request, false);
    const username = `member-${Date.now()}`;
    await signUpAsMember(page, app, username);
    expect(await rowsOf(request, app, "mem")).toEqual([]);

    await submitOrg(page, app, "北支店");
    await expect(page.getByTestId("view-renderer-form")).toContainText(NOT_ENROLLED);
    expect(await rowsOf(request, app, "orgs")).toEqual([]);
  });

  test("(E-2) 最後の管理者が自分の付与の行を消そうとすると、理由が画面に出て付与は残る", async ({
    page,
    request,
  }) => {
    const app = await installRoster(request, true);
    const username = `member-${Date.now()}`;
    await signUpAsMember(page, app, username);
    await submitOrg(page, app, "南支店");
    await expect.poll(async () => (await rowsOf(request, app, "org_grant")).length).toBe(1);
    const grant = (await rowsOf(request, app, "org_grant"))[0];
    expect(grant?.permission).toBe("keeper");

    await page.goto(`/apps/${app.appId}/views/grant-detail/records/${String(grant?._id)}`);
    await page.getByTestId("detail-delete").click();
    await page.getByTestId("detail-delete-execute").click();
    await expect(page.getByText(LAST_ADMIN_MESSAGE)).toBeVisible();
    await expect(page.getByTestId("write-conflict")).toHaveCount(0);
    expect(await rowsOf(request, app, "org_grant")).toHaveLength(1);
  });

  test("(E-3) passkey で登録した人にも、名簿の行ができる", async ({
    page,
    request,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "WebAuthn 仮想オーセンティケータは chromium(CDP)専用");
    const app = await installRoster(request, true);
    const client: CDPSession = await page.context().newCDPSession(page);
    await client.send("WebAuthn.enable");
    const { authenticatorId } = await client.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });

    await page.goto(`/apps/${app.appId}`);
    await expect(page.getByTestId("login-page")).toBeVisible();
    const username = `passkey-${Date.now()}`;
    await page.getByTestId("auth-username").fill(username);
    if ((await page.getByTestId("auth-user-kind").count()) > 0) {
      await page.getByTestId("auth-user-kind").selectOption("member");
    }
    await page.getByTestId("customer-passkey-register").click();
    await expect(page.getByTestId("current-user")).toHaveText(username);
    await expect(page.getByTestId("current-role")).toHaveAttribute("data-role", "member");
    await client.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });

    const members = await rowsOf(request, app, "mem");
    expect(members.map((row) => row.display)).toEqual([username]);
  });

  test("(E-4) 運営は「管理者のいない行」の一覧を開ける(読取専用)", async ({ page, request }) => {
    const app = await installRoster(request, true);
    await app.authenticate(page.context());
    await page.goto(`/apps/${app.appId}`);
    await page.getByTestId("open-orphan-records").click();
    const panel = page.getByTestId("orphan-records-admin");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("組織");
    await expect(panel).toContainText("並ぶ行はありません。");
  });
});
