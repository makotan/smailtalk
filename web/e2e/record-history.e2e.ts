/**
 * **詳細画面の行の変更履歴**(`V23-M8-T12`。計画 `docs/plan/v23/00-v23-plan.md` §27-3 の T12、決定
 * `D-V23-211`・`D-V23-213`・`D-V23-219`・`D-V23-222`、門A `ADR-0504`・`ADR-0544`)。
 *
 * - (R-1) 宣言した表(`history: true`)の行を、詳細 → 編集 → 保存で変えると、詳細画面の変更履歴の
 *   いちばん上に1件出る。 変えた人の名前(表示名の無い人なのでログイン名)・入口「画面・API」・操作「更新」・
 *   項目名と変更前 → 変更後。
 * - (R-2) 読めない項目(`secret`。読む人の役割に項目の規則が無い)だけを変えた保存は、読む人の履歴に1件も
 *   出ない。 読める項目の変更と作成は出るが、読めない項目は変更前・変更後とも出ない(陽性対照: 書く人には出る)。
 * - (R-3) その行を読めない人(読む人は `status` が `open` の行だけ読める)には、詳細も変更履歴も出ない
 *   (単件 GET `?history=1` は 404)。 同じ行を書く人が開くと変更履歴が出る(陽性対照)。
 * - (R-4) 61件の履歴は最初に50件だけ出て、「さらに読む」で次の11件が足され、ボタンが消える。
 *
 * 題材の定義はこのファイルが持ち、フィクスチャサーバの `/__e2e__/apps/:id/manifest` で入れる
 * (`actor-previous-history.e2e.ts` と同じ作法)。 カーネルの値は1つも import しない。
 */
import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";
import { type FixtureApp, provisionApp, type RoleSession, seedRoleSession } from "./fixture-app.ts";

const TABLE = "hnotes";
const FORM = "hnote-form";
const DETAIL = "hnote-detail";
const PLAIN_DETAIL = "hnote-detail-plain";
const ALL = ["read", "write", "delete"];

function parts() {
  return {
    tables: [
      {
        id: TABLE,
        name: "点検メモ",
        history: true,
        fields: [
          { id: "title", name: "題", type: "text" },
          { id: "status", name: "状態", type: "select", options: ["open", "closed"] },
          { id: "memo", name: "メモ", type: "long_text" },
          { id: "secret", name: "秘密", type: "text" },
        ],
      },
    ],
    views: [
      {
        id: FORM,
        type: "form",
        name: "点検メモの入力",
        table: TABLE,
        fields: ["title", "status", "memo", "secret"],
      },
      {
        id: DETAIL,
        type: "detail_view",
        name: "点検メモの詳細",
        table: TABLE,
        fields: ["title", "status", "memo", "secret"],
        history: true,
      },
      {
        // 陰性対照: 同じ表の詳細でも、画面に history を書かなければ部品は出ない。
        id: PLAIN_DETAIL,
        type: "detail_view",
        name: "点検メモの詳細(履歴なし)",
        table: TABLE,
        fields: ["title", "status"],
      },
    ],
  };
}

const viewRules = [FORM, DETAIL, PLAIN_DETAIL].map((view) => ({
  target: "view",
  view,
  can: ["read"],
}));
const secretRule = { target: "field", table: TABLE, field: "secret", can: ["read", "write"] };

type Installed = { app: FixtureApp; editor: RoleSession; viewer: RoleSession };

async function install(request: APIRequestContext): Promise<Installed> {
  const app = await provisionApp(request);
  const base = structuredClone(app.manifest) as unknown as {
    app: {
      tables: unknown[];
      views: unknown[];
      roles?: { id: string; rules?: unknown[] }[];
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
  const extra: Record<string, unknown[]> = {
    owner: [{ target: "table", table: TABLE, can: ALL }, secretRule, ...viewRules],
    editor: [{ target: "table", table: TABLE, can: ALL }, secretRule, ...viewRules],
    // 読む人: status が open の行だけ読める。 secret には項目の規則が無いので読めない。
    viewer: [
      { target: "table", table: TABLE, can: ["read"], when: { field: "status", equals: "open" } },
      ...viewRules,
    ],
  };
  for (const [id, rules] of Object.entries(extra)) {
    let role = roles.find((candidate) => candidate.id === id);
    if (role === undefined) {
      role = { id };
      roles.push(role);
    }
    role.rules = [...(role.rules ?? []), ...rules];
  }
  base.app.roles = roles;
  const applied = await request.post(`/__e2e__/apps/${app.appId}/manifest`, { data: base });
  expect(applied.status(), await applied.text()).toBe(200);
  const editor = await seedRoleSession(request, app.appId, "editor");
  const viewer = await seedRoleSession(request, app.appId, "viewer");
  return { app, editor, viewer };
}

/** 運営のセッションで行を API から更新する(If-Match は今の版)。 */
async function patchByApi(
  request: APIRequestContext,
  app: FixtureApp,
  recordId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const path = `/api/apps/${app.appId}/tables/${TABLE}/records/${recordId}`;
  const current = await request.get(path, { headers: app.authHeaders });
  expect(current.status(), await current.text()).toBe(200);
  const version = String(
    ((await current.json()) as { record: { _updated_at: string } }).record._updated_at,
  );
  const patched = await request.patch(path, {
    data: values,
    headers: { ...app.authHeaders, "if-match": version },
  });
  expect(patched.status(), await patched.text()).toBe(200);
}

/** 別の人として、新しいブラウザの文脈で開く。 */
async function pageAs(browser: Browser, who: RoleSession): Promise<Page> {
  const context = await browser.newContext();
  await who.authenticate(context);
  return context.newPage();
}

async function openDetail(page: Page, app: FixtureApp, recordId: string): Promise<void> {
  await page.goto(`/apps/${app.appId}/views/${DETAIL}/records/${recordId}`);
}

test.describe("行の変更履歴を詳細画面で見る(V23-M8)", () => {
  test("(R-1)(R-2)(R-3) 画面で更新すると詳細に履歴が出る・読めない項目の変更は出ない・行を読めない人には出ない", async ({
    page,
    browser,
    request,
  }) => {
    const { app, editor, viewer } = await install(request);
    const openId = await app.createRecord(TABLE, {
      title: "北棟の点検",
      status: "open",
      memo: "はじめ",
      secret: "鍵1",
    });
    // 読めない項目だけの変更(運営が API で)。
    await patchByApi(request, app, openId, { secret: "鍵2" });

    // (R-1) 書く人が、詳細 → 編集 → 題を変えて保存する。
    await editor.authenticate(page.context());
    await openDetail(page, app, openId);
    await expect(page.getByTestId("record-history-item")).toHaveCount(2);
    await page.getByTestId("detail-edit").click();
    await expect(page).toHaveURL(new RegExp(`/views/${FORM}/records/${openId}$`));
    await page.locator(`#${FORM}-title`).fill("南棟の点検");
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page).toHaveURL(new RegExp(`/views/${DETAIL}/records/${openId}$`));

    const items = page.getByTestId("record-history-item");
    await expect(items).toHaveCount(3);
    const newest = items.first();
    await expect(newest.getByTestId("record-history-actor")).toHaveText(editor.username);
    await expect(newest.getByTestId("record-history-entry")).toHaveText("画面・API");
    await expect(newest.getByTestId("record-history-op")).toHaveText("更新");
    await expect(newest.getByTestId("record-history-change")).toHaveCount(1);
    await expect(newest.getByTestId("record-history-field")).toHaveText("題");
    await expect(newest.getByTestId("record-history-before")).toHaveText("北棟の点検");
    await expect(newest.getByTestId("record-history-after")).toHaveText("南棟の点検");
    await expect(newest.getByTestId("record-history-at")).not.toHaveText("");
    // 陽性対照: 書く人には読めない項目だけの変更(2件目)が出る。
    const second = items.nth(1);
    await expect(second.getByTestId("record-history-field")).toHaveText("秘密");
    await expect(second.getByTestId("record-history-before")).toHaveText("鍵1");
    await expect(second.getByTestId("record-history-after")).toHaveText("鍵2");
    await expect(items.last().getByTestId("record-history-op")).toHaveText("作成");

    // 画面に history を書いていない詳細には、同じ行でも部品が出ない(陰性対照)。
    await page.goto(`/apps/${app.appId}/views/${PLAIN_DETAIL}/records/${openId}`);
    await expect(page.getByTestId("detail-field-title")).toHaveText("南棟の点検");
    await expect(page.getByTestId("record-history")).toHaveCount(0);

    // (R-2) 読む人には、読めない項目だけの変更が出ない。 作成の記録からも読めない項目が落ちる。
    const viewerPage = await pageAs(browser, viewer);
    await openDetail(viewerPage, app, openId);
    const viewerItems = viewerPage.getByTestId("record-history-item");
    await expect(viewerItems).toHaveCount(2);
    await expect(viewerItems.first().getByTestId("record-history-op")).toHaveText("更新");
    await expect(viewerItems.first().getByTestId("record-history-field")).toHaveText("題");
    await expect(viewerItems.last().getByTestId("record-history-op")).toHaveText("作成");
    await expect(viewerPage.getByTestId("record-history")).not.toContainText("秘密");
    await expect(viewerPage.getByTestId("record-history")).not.toContainText("鍵1");
    await expect(viewerPage.getByTestId("record-history")).not.toContainText("鍵2");
    await expect(viewerItems.last().getByTestId("record-history-field")).toHaveText([
      "題",
      "状態",
      "メモ",
    ]);

    // (R-3) 読む人が読めない行(closed)には、詳細も変更履歴も出ない。
    const closedId = await app.createRecord(TABLE, { title: "倉庫の点検", status: "closed" });
    await patchByApi(request, app, closedId, { title: "倉庫の再点検" });
    const closedPath = `/api/apps/${app.appId}/tables/${TABLE}/records/${closedId}`;
    const denied = viewerPage.waitForResponse(
      (response) => response.url().includes(closedPath) && response.request().method() === "GET",
    );
    await openDetail(viewerPage, app, closedId);
    expect((await denied).status()).toBe(404);
    await expect(viewerPage.getByTestId("record-history")).toHaveCount(0);
    await expect(viewerPage.getByText("倉庫の再点検")).toHaveCount(0);
    const byApi = await request.get(`${closedPath}?history=1`, {
      headers: viewer.authHeaders,
    });
    expect(byApi.status()).toBe(404);
    expect(await byApi.text()).not.toContain("倉庫");
    // 陽性対照: 書く人が同じ行を開くと変更履歴が出る。
    await openDetail(page, app, closedId);
    await expect(page.getByTestId("record-history-item")).toHaveCount(2);
    await viewerPage.context().close();
  });

  test("(R-4) 61件の履歴は50件ずつ出て、「さらに読む」で次の11件が足される", async ({
    page,
    request,
  }) => {
    const { app } = await install(request);
    const id = await app.createRecord(TABLE, { title: "t-0", status: "open" });
    for (let i = 1; i <= 60; i++) {
      await patchByApi(request, app, id, { title: `t-${i}` });
    }
    await app.authenticate(page.context());
    await openDetail(page, app, id);
    const items = page.getByTestId("record-history-item");
    await expect(items).toHaveCount(50);
    await expect(items.first().getByTestId("record-history-after")).toHaveText("t-60");
    await expect(items.last().getByTestId("record-history-after")).toHaveText("t-11");
    const more = page.getByRole("button", { name: "さらに読む" });
    await expect(more).toBeVisible();
    await more.click();
    await expect(items).toHaveCount(61);
    await expect(items.nth(50).getByTestId("record-history-after")).toHaveText("t-10");
    await expect(items.last().getByTestId("record-history-op")).toHaveText("作成");
    await expect(more).toHaveCount(0);
  });
});
