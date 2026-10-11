/**
 * **画面から評価の行を更新すると、履歴の表に「操作者・更新前・更新後・時刻」が1行増える**
 * (`V23-M4-T09`。上位: `docs/adr/0500-actor-previous-now-references.md`、門A `ADR-0524`、
 * 計画 `docs/plan/v23/00-v23-plan.md` §23-3 の T09・§23-6 中9、決定 `D-V23-92`・`D-V23-96`・
 * `D-V23-98`・`D-V23-101`・`D-V23-104`)。
 *
 * - (H-1) 詳細画面 → 編集 → 判定を変えて保存すると、`on_update` + `changed_fields: ["verdict"]` の
 *   `create_record` が履歴の表に1行書く。 操作者は自分の id、ログイン名、更新前・更新後の判定、
 *   時刻は時差付きの秒までの形、日付の項目は年月日だけ(受け入れ基準1)。
 * - (H-2) 何も変えずに保存すると、履歴は増えない(`D-V23-96`)。
 * - (H-3) 「更新者」(`st_updated_by`)は詳細と一覧で表示名(表示名の無い人はログイン名)で見え、
 *   ID は見えない。 フォームに入力欄は出ない(`D-V23-92`・`D-V23-98`)。
 * - (H-4) 別の自動処理が `update_record` で日付の項目に `$now` を書くと、年月日だけが入り、
 *   編集画面の日付の欄に表示される(空に見えない。`D-V23-101`・`D-V23-104`)。
 *
 * 題材の定義はこのファイルが持ち、フィクスチャサーバの `/__e2e__/apps/:id/manifest` で入れる
 * (`unique-message.e2e.ts` と同じ作法)。 カーネルの値は1つも import しない。
 */
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { type FixtureApp, provisionApp, type RoleSession, seedRoleSession } from "./fixture-app.ts";

const FORM = "assessment-form";
const DETAIL = "assessment-detail";
const LIST = "assessment-list";

/** 時差付きの秒までの形(`2026-09-30T10:23:45+09:00`)。 */
const ZONED_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
/** 年月日だけ。 */
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parts() {
  const historyTable = {
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
  return {
    tables: [
      {
        id: "assessments",
        name: "評価",
        fields: [
          { id: "title", name: "対象", type: "text" },
          { id: "verdict", name: "判定", type: "select", options: ["未評価", "合格", "不合格"] },
          { id: "memo", name: "メモ", type: "text" },
          { id: "checked_on", name: "確認日", type: "date" },
          { id: "st_updated_by", name: "更新者", type: "text" },
        ],
      },
      {
        id: "assessment_log",
        name: "評価の履歴",
        fields: [
          { id: "actor", name: "操作者", type: "text" },
          { id: "actor_login", name: "操作者のログイン名", type: "text" },
          { id: "before", name: "更新前", type: "text" },
          { id: "after", name: "更新後", type: "text" },
          { id: "at", name: "時刻", type: "text" },
          { id: "day", name: "日付", type: "date" },
        ],
      },
      historyTable,
    ],
    views: [
      {
        id: FORM,
        type: "form",
        name: "評価の入力",
        table: "assessments",
        // 「更新者」も名指しする。 名指ししても入力欄は出ない(H-3)。
        fields: ["title", "verdict", "memo", "checked_on", "st_updated_by"],
      },
      {
        id: DETAIL,
        type: "detail_view",
        name: "評価の詳細",
        table: "assessments",
        fields: ["title", "verdict", "checked_on", "st_updated_by"],
      },
      {
        id: LIST,
        type: "list_view",
        name: "評価の一覧",
        table: "assessments",
        columns: ["title", "verdict", "st_updated_by"],
      },
    ],
    workflows: [
      {
        id: "wf_hist",
        name: "判定の変化を記録する",
        trigger: { type: "on_update", table: "assessments", changed_fields: ["verdict"] },
        history_table: "wf_log",
        actions: [
          {
            action: "create_record",
            table: "assessment_log",
            values: {
              actor: "$actor.id",
              actor_login: "$actor.login",
              before: "$previous.verdict",
              after: "$record.verdict",
              at: "$now",
              day: "$now",
            },
          },
        ],
      },
      {
        id: "wf_checked",
        name: "確認日を書く",
        trigger: { type: "on_update", table: "assessments", changed_fields: ["verdict"] },
        history_table: "wf_log",
        actions: [
          {
            action: "update_record",
            table: "assessments",
            target: "$record._id",
            values: { checked_on: "$now" },
          },
        ],
      },
    ],
  };
}

type Installed = { app: FixtureApp; me: RoleSession };

/**
 * 払い出したアプリの定義に題材を足して入れ直す。 `withoutChangedFields` は壊す点検のためだけの口
 * (`changed_fields` を外した定義で (H-2) が赤くなることを確かめる。 通常は使わない)。
 */
async function install(
  request: APIRequestContext,
  options: { withoutChangedFields?: boolean } = {},
): Promise<Installed> {
  const app = await provisionApp(request);
  const base = structuredClone(app.manifest) as unknown as {
    app: {
      tables: unknown[];
      views: unknown[];
      workflows?: unknown[];
      roles?: { id: string; rules?: unknown[] }[];
    };
  };
  const p = parts();
  if (options.withoutChangedFields === true) {
    for (const workflow of p.workflows) {
      delete (workflow.trigger as { changed_fields?: string[] }).changed_fields;
    }
  }
  base.app.tables.push(...p.tables);
  base.app.views.push(...p.views);
  base.app.workflows = [...(base.app.workflows ?? []), ...p.workflows];
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
      ...["assessments", "assessment_log", "wf_log"].map((table) => ({
        target: "table",
        table,
        can: ["read", "write", "delete"],
      })),
      ...[FORM, DETAIL, LIST].map((view) => ({ target: "view", view, can: ["read"] })),
    ];
  }
  base.app.roles = roles;
  const applied = await request.post(`/__e2e__/apps/${app.appId}/manifest`, { data: base });
  expect(applied.status(), await applied.text()).toBe(200);
  // 画面を操作する本人。 ログイン名を知るために、運営の2人目を仕込む。
  const me = await seedRoleSession(request, app.appId, "owner");
  return { app, me };
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

/** 詳細 → 編集 → (変えるなら判定を選んで)保存 → 詳細に戻る。 */
async function editFromDetail(
  page: Page,
  app: FixtureApp,
  recordId: string,
  verdict: string | undefined,
): Promise<void> {
  await page.goto(`/apps/${app.appId}/views/${DETAIL}/records/${recordId}`);
  await page.getByTestId("detail-edit").click();
  await expect(page).toHaveURL(new RegExp(`/views/${FORM}/records/${recordId}$`));
  await expect(page.locator(`#${FORM}-title`)).toHaveValue("北棟の点検");
  if (verdict !== undefined) {
    await page.locator(`#${FORM}-verdict`).selectOption(verdict);
  }
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page).toHaveURL(new RegExp(`/views/${DETAIL}/records/${recordId}$`));
}

test.describe("操作者・更新前・今の時刻を履歴に書く(V23-M4)", () => {
  test("(H-1)(H-2)(H-3)(H-4) 画面で判定を変えると履歴に1行、変えずに保存すると増えない、更新者は表示名、確認日は年月日", async ({
    page,
    request,
  }) => {
    const { app, me } = await install(request);
    await me.authenticate(page.context());
    const recordId = await app.createRecord("assessments", {
      title: "北棟の点検",
      verdict: "未評価",
    });
    expect(await rowsOf(request, app, "assessment_log")).toEqual([]);

    // (H-3) フォームに「更新者」の入力欄が出ない(ほかの項目の欄は出る = 陽性対照)。
    await page.goto(`/apps/${app.appId}/views/${FORM}/records/${recordId}`);
    await expect(page.locator(`#${FORM}-verdict`)).toBeVisible();
    await expect(page.locator(`#${FORM}-memo`)).toBeVisible();
    await expect(page.locator(`#${FORM}-st_updated_by`)).toHaveCount(0);
    await expect(page.getByLabel("更新者")).toHaveCount(0);

    // (H-1) 詳細から編集して判定を変えて保存する。
    await editFromDetail(page, app, recordId, "合格");
    await expect(page.getByTestId("detail-field-verdict")).toHaveText("合格");
    await expect.poll(async () => (await rowsOf(request, app, "assessment_log")).length).toBe(1);
    const [log] = await rowsOf(request, app, "assessment_log");
    console.log(`T09 history row: ${JSON.stringify(log)}`);
    expect(log?.actor).toBe(me.userId);
    expect(log?.actor_login).toBe(me.username);
    expect(log?.before).toBe("未評価");
    expect(log?.after).toBe("合格");
    expect(String(log?.at)).toMatch(ZONED_SECONDS);
    expect(String(log?.day)).toMatch(DAY_ONLY);
    // 日付は時刻と同じ時間帯の年月日。
    expect(String(log?.day)).toBe(String(log?.at).slice(0, 10));

    // (H-4) 別の自動処理が確認日に年月日だけを書いている。
    const [afterChange] = await rowsOf(request, app, "assessments");
    console.log(`T09 assessment row: ${JSON.stringify(afterChange)}`);
    expect(String(afterChange?.checked_on)).toMatch(DAY_ONLY);
    expect(afterChange?.checked_on).toBe(log?.day);
    // (H-3) 詳細の「更新者」は表示名(表示名の無い人なのでログイン名)で、ID は見えない。
    const updatedByCell = page.getByTestId("detail-field-st_updated_by");
    await expect(updatedByCell).toHaveText(me.username);
    await expect(updatedByCell).not.toContainText(me.userId);
    // 詳細の確認日も年月日で見えている。
    await expect(page.getByTestId("detail-field-checked_on")).not.toHaveText("");

    // (H-4) 編集画面の日付の欄に年月日が入っている(空に見えない)。
    await page.getByTestId("detail-edit").click();
    const dateInput = page.locator(`#${FORM}-checked_on`);
    await expect(dateInput).toHaveValue(String(afterChange?.checked_on));
    await expect(dateInput).not.toHaveValue("");

    // (H-2) 何も変えずに保存しても、履歴は増えず、確認日も判定もそのまま。
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page).toHaveURL(new RegExp(`/views/${DETAIL}/records/${recordId}$`));
    // 保存そのものは通ったこと(行の版が進んだ)を確かめてから、履歴の件数を見る。
    await expect
      .poll(async () => (await rowsOf(request, app, "assessments"))[0]?._updated_at)
      .not.toBe(afterChange?._updated_at);
    // 念のため、発火が遅れて届く余地を待ってから数える。
    await page.waitForTimeout(500);
    expect(await rowsOf(request, app, "assessment_log")).toHaveLength(1);
    const [afterNoop] = await rowsOf(request, app, "assessments");
    expect(afterNoop?.checked_on).toBe(afterChange?.checked_on);
    expect(afterNoop?.verdict).toBe("合格");

    // (H-3) 一覧の「更新者」の列も表示名で、ID は見えない。
    await page.goto(`/apps/${app.appId}/views/${LIST}`);
    const list = page.getByTestId("view-renderer-list_view");
    await expect(list).toContainText("北棟の点検");
    await expect(list).toContainText(me.username);
    await expect(list).not.toContainText(me.userId);

    // もう一度判定を変えると、2行目が増える(更新前は1回目の更新後)。
    await editFromDetail(page, app, recordId, "不合格");
    await expect.poll(async () => (await rowsOf(request, app, "assessment_log")).length).toBe(2);
    const befores = (await rowsOf(request, app, "assessment_log"))
      .map((row) => `${row.before}->${row.after}`)
      .sort();
    expect(befores).toEqual(["合格->不合格", "未評価->合格"]);
  });
});
