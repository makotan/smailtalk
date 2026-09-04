/**
 * **`V13-M1-T04`**: **利用者IDの可視化(`UM-G1`)と、名簿の `account` 欄のプルダウン
 * (`UM-G2`)が、本物のサーバ・本物のブラウザ・本物の SQLite の上で実際に動くことを測る。**
 *
 * ## なぜ要るか(単体検査が測っていないもの)
 *
 * **`web/test/` の検査は表示層だけを見ており、`_auth_users` の実データを1バイトも
 * 読んでいない。** **「画面に出ている文字列が、その利用者の本当の `id` なのか」
 * 「プルダウンで選んだ値が、本当に列に入り、その人が実際に行を作れるようになるのか」は、
 * 本物のサーバに当てないと測れない。** **本ファイルがそこを埋める。**
 *
 * ## 本ファイルの作法
 *
 * - **題材は自前で組む。** **既存の e2e の題材(`access-control-servicedesk.e2e.ts` 等)を
 *   1バイトも書き換えない。** 組み方は **`POST /api/apps/:app_id/diffs`(製品の HTTP 経路)**
 *   で、`fixture-app.ts` が払い出したアプリに表5本と入力画面2枚を足すだけである。
 * - **本物の SQLite を使う。** `web/e2e/fixture-server.ts` が `fs.mkdtemp` の一時データルート上に
 *   `src/server/app.ts` をそのまま起動しており、行は `<dataRoot>/apps/<app_id>/app.sqlite` に入る。
 *   **リポジトリの `data/` には1バイトも触れない。**
 * - **画面の見た目だけで済ませない。** **保存された値の確認は必ず API
 *   (`GET .../tables/<表>/records` と `GET .../auth/users`)で行い、逐語一致を見る。**
 *
 * ## 【正直に書く】本ファイルが測っていないもの
 *
 * - **OS のクリップボードの中身そのもの。** 読むのは Chromium が持つクリップボードであり、
 *   `context.grantPermissions(["clipboard-read", "clipboard-write"])` を前提にしている
 *   (`playwright.config.ts` は1バイトも変えていない)。
 * - **一覧が読めない立場でプルダウンがテキスト欄に倒れること。** ここは
 *   `web/test/` の単体検査が持っており、本ファイルは1度も測っていない
 *   (**この画面を開ける立場 = 役割を配れる人 = 一覧が読める立場**であり、
 *   ブラウザから「開けるが読めない」状態を作れないため)。
 * - **グループ経由の付与・継承・削除。** 1本も叩いていない。
 */
import { expect, type Page, test } from "@playwright/test";
import { type FixtureApp, provisionApp, seedRoleSession } from "./fixture-app.ts";

/** ブラウザと同じ既定 port(`playwright.config.ts` / `fixture-server.ts` と揃える)。 */
const port = Number(process.env.ST_E2E_PORT ?? 3210);

/**
 * 状態変更に付ける `Origin`。**`fixture-server.ts` が `ST_AUTH_EXPECTED_ORIGIN` を
 * この値に固定している。**
 */
const ORIGIN = `http://localhost:${port}`;

// ---------------------------------------------------------------------------
// 題材(表5本・入力画面2枚)
// ---------------------------------------------------------------------------

/** 名簿の表(`access_control.members.table` が名指しする側)。 */
const MEMBERS_TABLE = "visit_members";
/** 名簿の `account` 列(`members.account` が名指しする側 = プルダウンになる欄)。 */
const ACCOUNT_FIELD = "account";
/** 行ごとの付与を宣言した業務の表。 */
const TASKS_TABLE = "visit_tasks";
/** 名簿でない表(今日どおりのテキスト欄のままであることの対照)。 */
const NOTES_TABLE = "visit_notes";

/** 名簿の入力画面。 */
const MEMBER_FORM = "visit-member-form";
/** 名簿でない表の入力画面。 */
const NOTE_FORM = "visit-note-form";

/** 業務の表に載せる宣言。**名簿・グループ・付与を名指しする。** */
const ACCESS_CONTROL = {
  enabled: true,
  permissions: [
    { id: "reader", name: "参照のみ(読むだけ)", read: true, write: false, delete: false },
    { id: "writer", name: "編集できる(読む+書く)", read: true, write: true, delete: false },
    { id: "remover", name: "消せる(読む+書く+消す)", read: true, write: true, delete: true },
  ],
  creator_permission: "remover",
  grant: {
    table: "visit_grants",
    target: "task",
    member: "member",
    group: "group",
    permission: "permission",
  },
  members: { table: MEMBERS_TABLE, account: ACCOUNT_FIELD, group: "group" },
  groups: { table: "visit_groups" },
};

/** 表5本。**参照される側を先に置く**(1つの差分に畳んで送るため)。 */
const TABLES: readonly Record<string, unknown>[] = [
  {
    id: "visit_groups",
    name: "グループ",
    fields: [{ id: "name", name: "名前", type: "text", required: true }],
  },
  {
    id: MEMBERS_TABLE,
    name: "利用者名簿",
    fields: [
      { id: "display_name", name: "表示名", type: "text", required: true },
      // **ここに入るのはログイン名ではなく `_auth_users.id` である。**
      { id: ACCOUNT_FIELD, name: "ログインアカウント", type: "text" },
      { id: "group", name: "グループ", type: "reference", reference_table: "visit_groups" },
    ],
  },
  {
    id: TASKS_TABLE,
    name: "作業",
    fields: [
      { id: "title", name: "件名", type: "text", required: true },
      { id: "detail", name: "詳細", type: "long_text" },
    ],
    access_control: ACCESS_CONTROL,
  },
  {
    // **付与表そのものは宣言を持たない** —— 宣言から `grant.table` として名指しされるだけ。
    id: "visit_grants",
    name: "付与",
    fields: [
      { id: "task", name: "作業", type: "reference", reference_table: TASKS_TABLE },
      { id: "member", name: "相手", type: "reference", reference_table: MEMBERS_TABLE },
      { id: "group", name: "グループ", type: "reference", reference_table: "visit_groups" },
      {
        id: "permission",
        name: "権限",
        type: "select",
        options: ["reader", "writer", "remover"],
      },
    ],
  },
  {
    // **名簿でも付与でもない、ただの表。** ここの `text` は今日どおりのテキスト欄である。
    id: NOTES_TABLE,
    name: "お知らせ",
    fields: [
      { id: "title", name: "件名", type: "text", required: true },
      { id: "body", name: "本文", type: "long_text" },
    ],
  },
];

/** 入力画面2枚。 */
const VIEWS: readonly Record<string, unknown>[] = [
  {
    id: MEMBER_FORM,
    type: "form",
    table: MEMBERS_TABLE,
    fields: ["display_name", ACCOUNT_FIELD, "group"],
  },
  { id: NOTE_FORM, type: "form", table: NOTES_TABLE, fields: ["title", "body"] },
];

/** API が返す利用者1人(この E2E が使う分だけ)。 */
type ApiUser = { id: string; username: string; displayName?: string | null; role: string };

/**
 * テスト1件専用のアプリを払い出し、**`POST /diffs` で表5本と入力画面2枚を入れる。**
 *
 * **差分は owner のセッションで送る**(未認証 401 / owner 以外 403)。
 */
async function setupApp(request: Parameters<typeof provisionApp>[0]): Promise<FixtureApp> {
  const app = await provisionApp(request);
  const applied = await request.post(`/api/apps/${app.appId}/diffs`, {
    data: {
      diff_id: "v13-m1-t04-user-account-visibility",
      intent:
        "利用者IDの可視化と名簿のプルダウンを本物のサーバで測るため、名簿・グループ・付与・業務・お知らせの表と入力画面を入れた",
      operations: [
        ...TABLES.map((table) => ({ op: "add_table", table })),
        ...VIEWS.map((view) => ({ op: "add_view", view })),
      ],
    },
    headers: { ...app.authHeaders, origin: ORIGIN },
  });
  expect(applied.status(), await applied.text()).toBe(201);
  return app;
}

/** `GET /api/apps/:app_id/auth/users` を owner のセッションで読む。 */
async function fetchUsers(
  request: Parameters<typeof provisionApp>[0],
  app: FixtureApp,
): Promise<ApiUser[]> {
  const response = await request.get(`/api/apps/${app.appId}/auth/users`, {
    headers: app.authHeaders,
  });
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as { users: ApiUser[] };
  return body.users;
}

/** 入力画面を開く。 */
async function openForm(page: Page, app: FixtureApp, viewId: string): Promise<void> {
  await page.goto(`/apps/${app.appId}/views/${viewId}`);
  await expect(page.getByTestId("view-renderer-form")).toBeVisible();
}

// ---------------------------------------------------------------------------
// (1)(2) 利用者管理の一覧に出る利用者ID(`UM-G1`)
// ---------------------------------------------------------------------------

test("利用者管理の一覧に出る利用者IDが API の返す id と逐語一致し、コピーのボタンが押せる", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request); // 既定セッション = owner
  // 一覧が1人だけにならないよう、もう2人足す(表示名は持たない = ログイン名だけの人)。
  const second = await seedRoleSession(request, app.appId, "editor");
  const third = await seedRoleSession(request, app.appId, "viewer");

  const users = await fetchUsers(request, app);
  // 払い出した owner と、いま足した2人が居る。
  expect(users.map((user) => user.id).sort()).toEqual(
    [app.userId, second.userId, third.userId].sort(),
  );

  // クリップボードを読むための権限。**`playwright.config.ts` は1バイトも変えていない。**
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
  await app.authenticate(page.context());
  await page.goto(`/apps/${app.appId}`);

  await page.getByTestId("open-user-admin").click();
  await expect(page.getByTestId("user-admin")).toBeVisible();

  // --- (1) 画面に出ている値が、API の返した `id` と1バイト違わない ------------------
  for (const user of users) {
    const row = page.locator(`[data-testid="user-row"][data-user-id="${user.id}"]`);
    await expect(row).toHaveCount(1);
    const shown = row.getByTestId("user-row-user-id");
    await expect(shown).toBeVisible();
    // **`toHaveText` は前後の空白を落として比べる** —— 中身は生の `id` そのものである。
    await expect(shown).toHaveText(user.id);
  }
  // 出ているのは人数ぶんちょうど(余分な行を数えていないことの裏)。
  await expect(page.getByTestId("user-row-user-id")).toHaveCount(users.length);

  // --- (2) コピーのボタン -----------------------------------------------------------
  const ownerRow = page.locator(`[data-testid="user-row"][data-user-id="${app.userId}"]`);
  await ownerRow.getByTestId("user-row-copy-id").click();
  // 押しても例外にならず、結果の表示が出る。
  const result = ownerRow.getByTestId("user-row-copy-id-result");
  await expect(result).toBeVisible();
  await expect(result).toHaveText("コピーしました。");

  // クリップボードの中身そのものを読む(Chromium のクリップボード。OS のものではない)。
  const clipped = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipped).toBe(app.userId);
});

// ---------------------------------------------------------------------------
// (3)(4)(5) 名簿の `account` 欄のプルダウン(`UM-G2`)
// ---------------------------------------------------------------------------

test("名簿のフォームは利用者を選ぶプルダウンで、選んだ利用者が実際に行を作れるようになる", async ({
  page,
  request,
}) => {
  const app = await setupApp(request);
  // 名簿に載せる相手。**`editor`** である(`viewer` は `records` の書込に届かない)。
  const target = await seedRoleSession(request, app.appId, "editor");

  // --- 着手前の状態を先に測る(名簿に行が無いので作れない)---------------------------
  const beforeJoin = await request.post(`/api/apps/${app.appId}/tables/${TASKS_TABLE}/records`, {
    data: { title: "名簿に載る前の作業" },
    headers: { ...target.authHeaders, origin: ORIGIN, "content-type": "application/json" },
  });
  expect(beforeJoin.status(), await beforeJoin.text()).toBe(400);

  const users = await fetchUsers(request, app);
  const expected = new Map(users.map((user) => [user.id, user] as const));

  await app.authenticate(page.context());
  await openForm(page, app, MEMBER_FORM);

  // --- (3) `account` 欄が `<select>` である ----------------------------------------
  // **選択肢は画面を開いた後に読みに行く**(`useUserAccountChoices`)ので、
  // 一覧が返るまでは今日どおりのテキスト欄が出ている。**`<select>` になるのを待つ。**
  const account = page.locator(`select[data-testid="field-input-${ACCOUNT_FIELD}"]`);
  await expect(account).toBeVisible();
  expect(await account.evaluate((element) => element.tagName)).toBe("SELECT");
  // 対照: 同じ表の別の `text` 項目(`display_name`)は今日どおりのテキスト欄のままである。
  const displayName = page.getByTestId("field-input-display_name");
  expect(await displayName.evaluate((element) => element.tagName)).toBe("INPUT");
  expect(await displayName.getAttribute("type")).toBe("text");

  // 選択肢に、このアプリに登録済みの利用者が並ぶ(未選択の空の選択肢を除く)。
  const options = await account.locator("option").evaluateAll((elements) =>
    elements.map((element) => ({
      value: (element as HTMLOptionElement).value,
      label: (element.textContent ?? "").trim(),
    })),
  );
  const chooseable = options.filter((option) => option.value !== "");
  expect(chooseable.map((option) => option.value).sort()).toEqual(
    users.map((user) => user.id).sort(),
  );
  // 見出しはログイン名を必ず含む(同姓同名を見分けられる)。
  for (const option of chooseable) {
    const user = expected.get(option.value);
    expect(user, `選択肢 ${option.value} が API の一覧に居ない`).toBeDefined();
    expect(option.label).toContain(user?.username ?? "");
  }
  // 空の選択肢はちょうど1つ(未選択)。
  expect(options.filter((option) => option.value === "")).toHaveLength(1);

  // --- (4) 選んで保存すると、列に利用者IDが入る ------------------------------------
  const label = `名簿の人-${Date.now()}`;
  await page.fill(`#${MEMBER_FORM}-display_name`, label);
  await page.selectOption(`#${MEMBER_FORM}-${ACCOUNT_FIELD}`, target.userId);
  await page.getByRole("button", { name: "保存" }).click();
  // 名簿の表には一覧画面が無いので、アプリの画面一覧へ戻る。
  await expect(page).toHaveURL(new RegExp(`/apps/${app.appId}$`));

  // **画面の見た目では済ませない** —— 保存された行を API で読む。
  const listed = await request.get(`/api/apps/${app.appId}/tables/${MEMBERS_TABLE}/records`, {
    headers: app.authHeaders,
  });
  expect(listed.status(), await listed.text()).toBe(200);
  const rows = (await listed.json()) as { records: Record<string, unknown>[] };
  const saved = rows.records.filter((record) => record.display_name === label);
  expect(saved).toHaveLength(1);
  // **逐語一致**: 保存された値は `_auth_users.id` そのものである(ログイン名ではない)。
  expect(saved[0]?.[ACCOUNT_FIELD]).toBe(target.userId);
  expect(saved[0]?.[ACCOUNT_FIELD]).not.toBe(target.username);
  expect(expected.get(String(saved[0]?.[ACCOUNT_FIELD]))?.id).toBe(target.userId);

  // --- (5) 選んだその人が、実際に行を作れる ----------------------------------------
  // **これが「書き写しの事故が起きなくなった」ことの証拠である** ——
  // 同じ要求が、名簿に載る前は 400、載せた後は 201 になる。
  const afterJoin = await request.post(`/api/apps/${app.appId}/tables/${TASKS_TABLE}/records`, {
    data: { title: "名簿に載った後の作業" },
    headers: { ...target.authHeaders, origin: ORIGIN, "content-type": "application/json" },
  });
  expect(afterJoin.status(), await afterJoin.text()).toBe(201);
  const created = (await afterJoin.json()) as { record: { _id: string } };
  // 作った本人がその行を読める(作成者への自動付与が立っている)。
  const readBack = await request.get(
    `/api/apps/${app.appId}/tables/${TASKS_TABLE}/records/${created.record._id}`,
    { headers: target.authHeaders },
  );
  expect(readBack.status(), await readBack.text()).toBe(200);
});

// ---------------------------------------------------------------------------
// (6) 名簿でない表は今日どおり
// ---------------------------------------------------------------------------

test("名簿でない表のフォームでは、text 項目が今日どおりのテキスト欄のままである", async ({
  page,
  request,
}) => {
  const app = await setupApp(request);
  await app.authenticate(page.context());
  await openForm(page, app, NOTE_FORM);

  // **後から `<select>` に化けないことまで見る** —— 名簿の欄は一覧が返ってから
  // 差し替わるので、**その読取が終わるだけの時間を置いてから**判定する
  // (置かずに測ると「まだ差し替わっていないだけ」を通してしまう)。
  await page.waitForLoadState("networkidle");
  const title = page.getByTestId("field-input-title");
  await expect(title).toBeVisible();
  expect(await title.evaluate((element) => element.tagName)).toBe("INPUT");
  expect(await title.getAttribute("type")).toBe("text");
  // プルダウンの部品は1つも出ていない。
  await expect(page.locator(`select[data-testid="field-input-title"]`)).toHaveCount(0);

  // 打った文字がそのまま保存される(値の意味が変わっていないことの裏)。
  const marker = `お知らせ-${Date.now()}`;
  await page.fill(`#${NOTE_FORM}-title`, marker);
  // 打ち終わった後も、まだテキスト欄のままである。
  expect(await title.evaluate((element) => element.tagName)).toBe("INPUT");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page).toHaveURL(new RegExp(`/apps/${app.appId}$`));

  const listed = await request.get(`/api/apps/${app.appId}/tables/${NOTES_TABLE}/records`, {
    headers: app.authHeaders,
  });
  expect(listed.status(), await listed.text()).toBe(200);
  const rows = (await listed.json()) as { records: Record<string, unknown>[] };
  expect(rows.records.filter((record) => record.title === marker)).toHaveLength(1);
});
