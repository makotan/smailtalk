/**
 * **アプリが決めた断りの文言(一意違反の文言と島の `reject`)を、本物のブラウザで確かめる**
 * (`V23-M2-T10`。上位: `docs/adr/0498-unique-message-reject-and-atomic-creator-grant.md`、
 * 授権 `docs/adr/0517-v23-m2-guard-authorization-and-conditional-rows.md`・
 * `docs/adr/0519-v23-m2-new-test-file-kernel-import-authorization.md`、
 * 計画 `docs/plan/v23/00-v23-plan.md` §21-2 の T10、決定 `D-V23-71`)。
 *
 * - (U-1) 付与表の `member` 列に `unique: true` と `unique_message` を書いたアプリで、所属済みの
 *   利用者が画面から2つ目の組織を作ると、フォームの上(`form-app-rejected`)にその文言がそのまま出て、
 *   組織の一覧に行が増えていない(FR-6 の受け入れ基準)。 1つ目の組織は作れる(陽性対照)。
 * - (R-1) `on_create` の島が `reject` を呼ぶ表で、フォームから保存すると、その文言がフォームの上に
 *   出て、行が増えていない。 断らない値では保存できる(陽性対照)。
 * - (N-1)(N-2) `D-V23-71`: フォームを持たない書込(詳細画面の書換ボタン・一覧の行の書換ボタン)で
 *   `on_update` の島が `reject` したとき、文言が画面に出て、値が書き換わっていないことを固定する
 *   (それぞれの置き場 `detail-errors`・一覧の行の失敗の器。フォームの上の器ではない)。
 *
 * 題材の定義はこのファイルが持ち、フィクスチャサーバの `/__e2e__/apps/:id/manifest` で入れる
 * (`auto-enroll.e2e.ts` と同じ作法)。 カーネルの値は1つも import しない。
 */
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { type FixtureApp, provisionApp } from "./fixture-app.ts";

const PASSWORD = "correct-horse-battery-staple";
/** 付与表の `member` 列に宣言する一意違反の文言。 */
const UNIQUE_MESSAGE = "既に別の組織に所属しています";
/** 島が `reject` に渡す文言(作成のとき)。 */
const CREATE_REJECT = "100 を超える点数は入れられません";
/** 島が `reject` に渡す文言(書換のとき)。 */
const UPDATE_REJECT = "この案件はまだ閉じられません";

type Rule = Record<string, unknown>;
type Parts = {
  tables: unknown[];
  views: unknown[];
  functions?: unknown[];
  workflows?: unknown[];
  memberRole?: Rule[];
  ownerTables: string[];
  ownerViews: string[];
  ownerActions?: Rule[];
};

/** 払い出したアプリの定義に題材の表・画面・関数・自動処理・立場を足して入れ直す。 */
async function install(request: APIRequestContext, parts: Parts): Promise<FixtureApp> {
  const app = await provisionApp(request);
  const base = structuredClone(app.manifest) as unknown as {
    app: {
      tables: unknown[];
      views: unknown[];
      functions?: unknown[];
      workflows?: unknown[];
      roles?: { id: string; rules?: unknown[] }[];
    };
  };
  base.app.tables.push(...parts.tables);
  base.app.views.push(...parts.views);
  if (parts.functions !== undefined) {
    base.app.functions = [...(base.app.functions ?? []), ...parts.functions];
  }
  if (parts.workflows !== undefined) {
    base.app.workflows = [...(base.app.workflows ?? []), ...parts.workflows];
  }
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
  if (parts.memberRole !== undefined) {
    roles.push({ id: "member", name: "メンバー", signup: "open", rules: parts.memberRole } as {
      id: string;
      rules?: unknown[];
    });
  }
  // 題材の表は規則が名指しするので、フィクスチャサーバは運営に規則を足さない。 運営の分を書く。
  const owner = roles.find((role) => role.id === "owner");
  if (owner !== undefined) {
    owner.rules = [
      ...(owner.rules ?? []),
      ...parts.ownerTables.map((table) => ({
        target: "table",
        table,
        can: ["read", "write", "delete"],
      })),
      ...parts.ownerViews.map((view) => ({ target: "view", view, can: ["read"] })),
      ...(parts.ownerActions ?? []),
    ];
  }
  base.app.roles = roles;
  const applied = await request.post(`/__e2e__/apps/${app.appId}/manifest`, { data: base });
  expect(applied.status(), await applied.text()).toBe(200);
  return app;
}

/** 運営のセッションで表の行を読む。 */
async function rowsOf(
  request: APIRequestContext,
  app: FixtureApp,
  tableId: string,
): Promise<Record<string, unknown>[]> {
  const response = await request.get(`/api/apps/${app.appId}/tables/${tableId}/records`, {
    headers: app.authHeaders,
  });
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { records: Record<string, unknown>[] }).records;
}

/** 実行履歴の表(自動処理の宣言に要る)。 */
const HISTORY_TABLE = {
  id: "wf_log",
  name: "実行履歴",
  fields: [
    { id: "ran_at", name: "実行時刻", type: "date" },
    { id: "workflow", name: "ワークフロー", type: "text" },
    { id: "trigger_type", name: "きっかけ", type: "text" },
    { id: "status", name: "結果", type: "text" },
    { id: "error", name: "エラー", type: "long_text" },
  ],
};

// ---------------------------------------------------------------------------
// (U-1) 一意違反の文言(FR-6)
// ---------------------------------------------------------------------------

/** 組織・名簿・付与表。 付与表の `member` に `unique: true` と文言を書く(1人1組織)。 */
function rosterParts(): Parts {
  return {
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
          grant: { table: "org_grant", target: "org", member: "member", permission: "permission" },
          members: {
            table: "mem",
            account: "account",
            auto_enroll: { roles: ["member"], name: "display" },
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
          {
            id: "member",
            name: "相手",
            type: "reference",
            reference_table: "mem",
            unique: true,
            unique_message: UNIQUE_MESSAGE,
          },
          { id: "permission", name: "権限", type: "select", options: ["reader", "keeper"] },
        ],
      },
    ],
    views: [
      { id: "org-list", type: "list_view", name: "組織の一覧", table: "orgs", columns: ["title"] },
      { id: "org-form", type: "form", name: "組織の登録", table: "orgs", fields: ["title"] },
    ],
    memberRole: [
      { target: "view", view: "org-list", can: ["read"] },
      { target: "view", view: "org-form", can: ["read"] },
      { target: "table", table: "orgs", can: ["read", "write"] },
      { target: "table", table: "mem", can: ["read", "write"] },
      { target: "table", table: "org_grant", can: ["read", "write", "delete"] },
    ],
    ownerTables: ["orgs", "mem", "org_grant"],
    ownerViews: ["org-list", "org-form"],
  };
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

/** 登録画面から1行保存する(押した後の画面は呼び手が見る)。 */
async function submitForm(
  page: Page,
  app: FixtureApp,
  viewId: string,
  label: string,
  value: string,
): Promise<void> {
  await page.goto(`/apps/${app.appId}/views/${viewId}`);
  await page.getByLabel(label).fill(value);
  await page.getByRole("button", { name: /保存/ }).click();
}

// ---------------------------------------------------------------------------
// (R-1)(N-1)(N-2) 島の reject
// ---------------------------------------------------------------------------

function islandParts(): Parts {
  const opsFn = (id: string, code: string) => ({
    id,
    name: id,
    code,
    input: { source: "record" },
    output: { ops: true },
  });
  const workflow = (id: string, type: "on_create" | "on_update", table: string, fn: string) => ({
    id,
    name: id,
    trigger: { type, table },
    history_table: "wf_log",
    actions: [{ action: "run_function", function: fn, write_ops: true }],
  });
  const closeButton = { set: { field: "state", value: "closed" }, name: "閉じる" };
  return {
    tables: [
      { id: "scores", name: "点数", fields: [{ id: "score", name: "点数", type: "number" }] },
      { id: "tickets", name: "案件", fields: [{ id: "state", name: "状態", type: "text" }] },
      HISTORY_TABLE,
    ],
    views: [
      { id: "score-form", type: "form", name: "点数の登録", table: "scores", fields: ["score"] },
      {
        id: "ticket-detail",
        type: "detail_view",
        name: "案件の詳細",
        table: "tickets",
        actions: [closeButton],
      },
      {
        id: "ticket-list",
        type: "list_view",
        name: "案件の一覧",
        table: "tickets",
        columns: ["state"],
        actions: [closeButton],
      },
    ],
    functions: [
      opsFn(
        "score_gate",
        `export default function (input, { reject }) { if (input.score > 100) reject(${JSON.stringify(CREATE_REJECT)}); return []; }`,
      ),
      opsFn(
        "close_gate",
        `export default function (input, { reject }) { if (input.state === "closed") reject(${JSON.stringify(UPDATE_REJECT)}); return []; }`,
      ),
    ],
    workflows: [
      workflow("wf_score", "on_create", "scores", "score_gate"),
      workflow("wf_close", "on_update", "tickets", "close_gate"),
    ],
    ownerTables: ["scores", "tickets", "wf_log"],
    ownerViews: ["score-form", "ticket-detail", "ticket-list"],
  };
}

test.describe("アプリが決めた断りの文言(V23-M2)", () => {
  test("(U-1) 所属済みの人が組織を作ると、フォームの上に一意違反の文言が出て、組織は増えない", async ({
    page,
    request,
  }) => {
    const app = await install(request, rosterParts());
    await signUpAsMember(page, app, `member-${Date.now()}`);

    // 陽性対照: 1つ目の組織は作れて、付与が1行できる。
    await submitForm(page, app, "org-form", "組織名", "北支店");
    await expect
      .poll(async () => (await rowsOf(request, app, "orgs")).map((row) => row.title))
      .toEqual(["北支店"]);
    expect(await rowsOf(request, app, "org_grant")).toHaveLength(1);

    // 2つ目: 付与表の `member` の一意に当たる。
    await submitForm(page, app, "org-form", "組織名", "南支店");
    const banner = page.getByTestId("form-app-rejected");
    await expect(banner).toBeVisible();
    await expect(banner).toHaveText(UNIQUE_MESSAGE);
    // フォームの上(最初の入力欄より前)に出る。
    const bannerBox = await banner.boundingBox();
    const inputBox = await page.getByLabel("組織名").boundingBox();
    expect(bannerBox !== null && inputBox !== null && bannerBox.y < inputBox.y).toBe(true);
    await expect(page.getByTestId("write-conflict")).toHaveCount(0);

    // 組織も付与も増えていない。 一覧にも1行だけ。
    expect((await rowsOf(request, app, "orgs")).map((row) => row.title)).toEqual(["北支店"]);
    expect(await rowsOf(request, app, "org_grant")).toHaveLength(1);
    await page.goto(`/apps/${app.appId}/views/org-list`);
    await expect(page.getByText("北支店")).toBeVisible();
    await expect(page.getByText("南支店")).toHaveCount(0);
  });

  test("(R-1) on_create の島が reject すると、フォームの上に文言が出て、行は増えない", async ({
    page,
    request,
  }) => {
    const app = await install(request, islandParts());
    await app.authenticate(page.context());

    // 陽性対照: 断らない値は保存できる。
    await submitForm(page, app, "score-form", "点数", "50");
    await expect
      .poll(async () => (await rowsOf(request, app, "scores")).map((row) => row.score))
      .toEqual([50]);

    await submitForm(page, app, "score-form", "点数", "150");
    const banner = page.getByTestId("form-app-rejected");
    await expect(banner).toBeVisible();
    await expect(banner).toHaveText(CREATE_REJECT);
    const bannerBox = await banner.boundingBox();
    const inputBox = await page.getByLabel("点数").boundingBox();
    expect(bannerBox !== null && inputBox !== null && bannerBox.y < inputBox.y).toBe(true);
    expect((await rowsOf(request, app, "scores")).map((row) => row.score)).toEqual([50]);
  });

  test("(N-1) D-V23-71: 詳細画面の書換ボタンで on_update の島が reject すると、文言が画面に出て値は変わらない", async ({
    page,
    request,
  }) => {
    const app = await install(request, islandParts());
    await app.authenticate(page.context());
    const recordId = await app.createRecord("tickets", { state: "open" });

    await page.goto(`/apps/${app.appId}/views/ticket-detail/records/${recordId}`);
    await page.getByTestId("action-set-state").click();
    const errors = page.getByTestId("detail-errors");
    await expect(errors).toBeVisible();
    await expect(errors).toHaveText(UPDATE_REJECT);
    console.log(`D-V23-71 detail-errors text: ${JSON.stringify(await errors.textContent())}`);
    await expect(page.getByTestId("form-app-rejected")).toHaveCount(0);
    expect((await rowsOf(request, app, "tickets")).map((row) => row.state)).toEqual(["open"]);
  });

  test("(N-2) D-V23-71: 一覧の行の書換ボタンで on_update の島が reject すると、文言が行に出て値は変わらない", async ({
    page,
    request,
  }) => {
    const app = await install(request, islandParts());
    await app.authenticate(page.context());
    await app.createRecord("tickets", { state: "open" });

    await page.goto(`/apps/${app.appId}/views/ticket-list`);
    await page.getByTestId("list-action-set-state").click();
    const rowError = page.getByTestId("list-action-run-error");
    await expect(rowError).toBeVisible();
    await expect(rowError).toHaveText(UPDATE_REJECT);
    console.log(`D-V23-71 list row error text: ${JSON.stringify(await rowError.textContent())}`);
    expect((await rowsOf(request, app, "tickets")).map((row) => row.state)).toEqual(["open"]);
  });
});
