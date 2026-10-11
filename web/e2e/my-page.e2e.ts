/**
 * **マイページ**を実ブラウザ・本物のサーバ・本物の SQLite で測る(`V22-M3-T07`)。
 *
 * 計画の正は `docs/plan/v22/00-v22-plan.md` の「V22-M3」節の T07 の行と「T07 で見ること(ブラウザ)」の1〜12、
 * 決まりはユーザ決定 `D-V22-16`〜`D-V22-25`。 画面の細部の決めは `docs/plan/v22/records/v22-m3-t05.md`。
 *
 * ## 何を測るか
 *
 * - (A) ボタンの入れ替え(「アカウント」→「マイページ」)と、メニューの先頭(左・上の横一列・360px の「≡ メニュー」)。
 *   計画の5。 **メニューの位置だけを `set_workspace` で変えてもマイページが残る**(計画の12。`D-V22-21`)。
 * - (B) 運営者(owner)にも自分の行だけ。 `include` した表は出て、`exclude` した表は出ない。 持ち主が空の行は出ない。
 *   10件+「もっと見る」(新しい順)。 行を押すと詳細画面、詳細画面の無い表の行は押せない。 選んだ画面の開くボタン。
 *   計画の2・3・4(`D-V22-18`・`D-V22-19`・`D-V22-23`)。
 * - (C) 一般の人(customer)には自分の行だけ。 読めない表(一覧画面を1本も開けない表)の節は出ない。
 *   開けない画面のボタンは出ない。 計画の1(`D-V22-24`)。
 * - (D) パスワード登録した人が、マイページの中でパスワードを変え、ログアウト → 新しいパスワードで再ログインすると
 *   マイページに移る。 公開の入口(`/apps/<id>`)から入ったら移る、公開画面を指してから入ったら移らない。
 *   計画の6・7(`open_after_login`)。
 * - (E) 未ログインで `/apps/<id>/my-page` を直に開くとログイン画面。 計画の8。
 * - (F) 配る版も同じ(ボタン・メニューの先頭・マイページ)。 計画の9。
 * - (G) 暗い表示でもテーマの色が効く(明るい・暗いの両方で計算値を見る)。 計画の10。
 * - (H) `POST /undo` でマイページが消え、「アカウント」に戻る。 計画の11。
 * - (I) マイページの無いアプリは変化なし(「アカウント」のまま、メニューに項目が無い、`/my-page` は「ありません」)。
 *
 * ## 証明しないこと(誇張しない)
 *
 * - **読み上げの実物は聞いていない。** 見やすさ・ピクセルも比べない(計算値と DOM だけ)。
 * - **640px ちょうど前後の境目は測っていない**(360px と 1280px の2点だけ)。
 * - **大きな表の「もっと見る」の体感は測っていない**(12行だけ)。
 * - 退会は押していない(既存の `AccountPanel` の検査の担当。マイページには埋め込んだだけ)。
 */
import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import type { Diff, Manifest } from "../../src/kernel/types.ts";
import { type FixtureApp, provisionApp, seedRoleSession } from "./fixture-app.ts";

/** ブラウザがアクセスする育成用の版の port(`playwright.config.ts` と同じ既定値)。 */
const port = Number(process.env.ST_E2E_PORT ?? 3210);
/** 配る版の port は育成用の版の隣(`web/e2e/fixture-server.ts` と同じ組み方)。 */
const runnerBase = `http://localhost:${port + 1}`;
/** 配る版が描くアプリのID(`package.json` の `test:e2e` と `fixture-server.ts` と同じ綴り)。 */
const RUNNER_APP_ID = "runner-e2e";

const WIDE = { width: 1280, height: 800 };
const NARROW = { width: 360, height: 800 };

const PASSWORD = "correct-horse-battery-staple";
const NEW_PASSWORD = "tr0ub4dor-and-3-more-words";

// ---------------------------------------------------------------------------
// 題材(表3本と画面。`POST /__e2e__/apps/<id>/manifest` で足す。面の規則は fixture-server が配る)
// ---------------------------------------------------------------------------

/** 作った人だけの表(`st_owner`)。 マイページに自動で載る。 */
const MEMOS = "mp_memos";
/** 作った人だけの表(`st_owner`)。 `exclude` で外す。 */
const DRAFTS = "mp_drafts";
/** 担当者の列(`assignee`)を持つ表。 自動では載らないので `include` で足す。 運営だけが読める。 */
const DUTIES = "mp_duties";

const MEMO_LIST = "mp-memo-list";
const MEMO_DETAIL = "mp-memo-detail";
const MEMO_FORM = "mp-memo-form";
const DRAFT_LIST = "mp-draft-list";
const DUTY_LIST = "mp-duty-list";
/** 未ログインにも見せる公開の一覧(既存の表 `categories`)。 */
const PUBLIC_LIST = "mp-public-categories";

/** 明るい側の組(`web/e2e/workspace-navigation.e2e.ts` と同じ値)。 */
const SLOTS: Record<string, string> = {
  body_text: "#1a237e",
  secondary_text: "#37474f",
  label_text: "#4a148c",
  placeholder_text: "#5d4037",
  danger: "#b00020",
  page_background: "#fff8e1",
  highlight_surface: "#ffecb3",
  primary_fill: "#fff8e1",
  on_primary: "#1a237e",
  overlay_background: "#ffecb3",
  overlay_text: "#1a237e",
  border_color: "#6d4c41",
  focus_ring: "#00695c",
  body_font: "Georgia, serif",
  secondary_font_size: "12px",
  note_font_size: "13px",
  body_line_height: "2",
  space_1: "2px",
  space_2: "4px",
  space_3: "6px",
  space_4: "8px",
  space_5: "10px",
  space_6: "12px",
  border_width: "3px",
  control_radius: "5px",
  surface_shadow: "0 2px 6px #000000",
  focus_ring_width: "4px",
};

/** 暗い側の組(同じく `workspace-navigation.e2e.ts` と同じ値)。 */
const SLOTS_DARK: Record<string, string> = {
  ...SLOTS,
  body_text: "#f5f5f5",
  secondary_text: "#c8d8e8",
  label_text: "#ffd54a",
  placeholder_text: "#b0b8c0",
  danger: "#ff9a8a",
  page_background: "#102030",
  highlight_surface: "#243447",
  primary_fill: "#102030",
  on_primary: "#f5f5f5",
  overlay_background: "#243447",
  overlay_text: "#f5f5f5",
  border_color: "#8fa3b8",
  focus_ring: "#7fd4ff",
};

type MyPage = {
  open_after_login?: boolean;
  tables?: { exclude?: string[]; include?: { table: string; owner_field: string }[] };
  views?: string[];
};

/** 題材に足すマイページの宣言(全部入り)。 */
const FULL_MY_PAGE: MyPage = {
  open_after_login: true,
  tables: { exclude: [DRAFTS], include: [{ table: DUTIES, owner_field: "assignee" }] },
  views: [MEMO_LIST, DUTY_LIST],
};

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
    intent: "ログインした人ごとの頁(マイページ)を置きたい、という要望に応えた",
    operations: [{ op: "set_workspace", workspace }],
  } as unknown as Diff;
}

async function setMyPage(
  request: APIRequestContext,
  app: FixtureApp,
  myPage: MyPage,
  diffId = "my-page-declare",
): Promise<void> {
  await postDiff(request, app.appId, app.authHeaders, workspaceDiff(diffId, { my_page: myPage }));
}

async function setTheme(request: APIRequestContext, app: FixtureApp): Promise<void> {
  await postDiff(request, app.appId, app.authHeaders, {
    diff_id: "my-page-theme",
    intent: "アプリの配色を決めたい、という要望に応えてテーマを設定した",
    operations: [{ op: "set_theme", theme: { slots: SLOTS, slots_dark: SLOTS_DARK } }],
  } as unknown as Diff);
}

/**
 * 払い出したアプリに表3本・画面・公開の一覧を足す(差し替え。規則は fixture-server が「名指しの無い対象」にだけ配る)。
 *
 * - `mp_memos` / `mp_drafts` は `st_owner` の表なので、運営3役割と customer に「自分の行か持ち主が空の行」の読取が配られる。
 * - `mp_duties` は規約の列を持たないので、運営3役割にだけ全行の読取が配られ、customer には1本も配られない。
 * - 公開の一覧 `mp-public-categories` だけは自分で名指しする(未ログインに開く)。
 */
async function installSubject(request: APIRequestContext, app: FixtureApp): Promise<void> {
  const next = structuredClone(app.manifest);
  const loose = next.app as unknown as {
    roles?: { id: string; name?: string; rules?: Record<string, unknown>[] }[];
  };
  next.app.tables = [
    ...next.app.tables,
    {
      id: MEMOS,
      name: "メモ",
      fields: [
        { id: "title", name: "件名", type: "text", required: true },
        { id: "st_owner", name: "作った人", type: "text" },
      ],
    },
    {
      id: DRAFTS,
      name: "下書き",
      fields: [
        { id: "title", name: "件名", type: "text", required: true },
        { id: "st_owner", name: "作った人", type: "text" },
      ],
    },
    {
      id: DUTIES,
      name: "当番",
      fields: [
        { id: "title", name: "件名", type: "text", required: true },
        { id: "assignee", name: "担当者", type: "text" },
      ],
    },
  ] as Manifest["app"]["tables"];
  next.app.views = [
    ...next.app.views,
    { id: MEMO_LIST, name: "メモの一覧", type: "list_view", table: MEMOS, columns: ["title"] },
    { id: MEMO_DETAIL, name: "メモの詳細", type: "detail_view", table: MEMOS },
    { id: MEMO_FORM, name: "メモを書く", type: "form", table: MEMOS, fields: ["title"] },
    { id: DRAFT_LIST, name: "下書きの一覧", type: "list_view", table: DRAFTS, columns: ["title"] },
    {
      id: DUTY_LIST,
      name: "当番の一覧",
      type: "list_view",
      table: DUTIES,
      columns: ["title", "assignee"],
    },
    {
      id: PUBLIC_LIST,
      name: "カテゴリ一覧(公開)",
      type: "list_view",
      table: "categories",
      columns: ["name"],
    },
  ] as Manifest["app"]["views"];
  const roles = loose.roles ?? [];
  const push = (roleId: string, rules: Record<string, unknown>[]): void => {
    const found = roles.find((role) => role.id === roleId);
    if (found === undefined) {
      roles.push({ id: roleId, name: roleId, rules });
      return;
    }
    found.rules = [...(found.rules ?? []), ...rules];
  };
  push("owner", [{ target: "view", view: PUBLIC_LIST, can: ["read"] }]);
  push("anonymous", [
    { target: "view", view: PUBLIC_LIST, can: ["read"] },
    { target: "table", table: "categories", can: ["read"] },
  ]);
  loose.roles = roles;
  const replaced = await request.post(`/__e2e__/apps/${app.appId}/manifest`, { data: next });
  expect(replaced.status(), await replaced.text()).toBe(200);
}

/** その人のセッションで1行作る(`st_owner` はサーバが作った人で上書きする)。 */
async function createAs(
  request: APIRequestContext,
  appId: string,
  headers: { cookie: string },
  table: string,
  data: Record<string, unknown>,
): Promise<string> {
  const created = await request.post(`/api/apps/${appId}/tables/${table}/records`, {
    data,
    headers,
  });
  expect(created.status(), await created.text()).toBe(201);
  return ((await created.json()) as { record: { _id: string } }).record._id;
}

/** マイページの表の節の、行の見出し(並びのまま)。 */
async function rowTitles(page: Page, table: string): Promise<string[]> {
  return await page
    .getByTestId(`my-page-table-${table}`)
    .getByTestId("my-page-row")
    .allTextContents();
}

async function openSignedIn(page: Page, app: FixtureApp, path = ""): Promise<void> {
  await app.authenticate(page.context());
  await page.goto(`/apps/${app.appId}${path}`);
}

/** 公開の入口を経ずにログイン画面を出す(公開の一覧が無いアプリの `/apps/<id>` か、`/login`)。 */
async function loginWithPassword(page: Page, username: string, password: string): Promise<void> {
  await expect(page.getByTestId("login-page")).toBeVisible();
  await page.getByTestId("auth-username").fill(username);
  await page.getByTestId("auth-password").fill(password);
  await page.getByTestId("password-login").click();
  await expect(page.getByTestId("current-user")).toHaveText(username);
}

async function textColor(page: Page, testId: string): Promise<string> {
  return await page
    .getByTestId(testId)
    .first()
    .evaluate((element) => getComputedStyle(element).color);
}

test.describe("V22-M3-T07 マイページ(chromium 実測)", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "計算値の期待値は chromium の値である(`color-scheme.e2e.ts` と同じ理由)",
  );

  test("(I) マイページの無いアプリは変化なし: 「アカウント」のまま、メニューに項目が無く、/my-page は「ありません」", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await page.setViewportSize(WIDE);
    await openSignedIn(page, app);
    await expect(page.getByTestId("view-list")).toBeVisible();
    await expect(page.getByTestId("open-account")).toBeVisible();
    await expect(page.getByTestId("open-my-page")).toHaveCount(0);
    await expect(page.getByTestId("view-list-my-page")).toHaveCount(0);

    await page.goto(`/apps/${app.appId}/my-page`);
    await expect(page.getByTestId("my-page-missing")).toBeVisible();
    await expect(page.getByTestId("my-page")).toHaveCount(0);
  });

  test("(E) 未ログインで /my-page を直に開くとログイン画面(公開の入口画面も出さない)", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await installSubject(request, app);
    await setMyPage(request, app, FULL_MY_PAGE);
    // **cookie を1つも入れない**(= 未ログイン)。
    await page.goto(`/apps/${app.appId}/my-page`);
    await expect(page.getByTestId("login-page")).toBeVisible();
    await expect(page.getByTestId("my-page")).toHaveCount(0);
    await expect(page.getByTestId("anonymous-workspace")).toHaveCount(0);
  });

  test("(A) ボタンがマイページに替わり、メニューの先頭(左・上・360px の ≡)に出る。位置だけ変えても残る", async ({
    page,
    request,
  }) => {
    // **題材の表は足さない**(画面4枚+マイページ = 1280px で横一列に収まる数にして、上の横一列の先頭を測る)。
    const app = await provisionApp(request);
    await setMyPage(request, app, {});
    const [firstView] = app.manifest.app.views.map((view) => view.id);
    await page.setViewportSize(WIDE);
    await openSignedIn(page, app, `/views/${firstView}`);
    await expect(page.getByTestId("view-list")).toBeVisible();

    // --- ボタンの入れ替え ---
    await expect(page.getByTestId("open-my-page")).toBeVisible();
    await expect(page.getByTestId("open-my-page")).toHaveText("マイページ");
    await expect(page.getByTestId("open-account")).toHaveCount(0);

    // --- 左: 先頭の項目がマイページ。 いまは開いていないので aria-current は無い ---
    const sideFirst = page.getByTestId("view-list").locator("ul > li").first();
    await expect(sideFirst).toHaveAttribute("data-testid", "view-list-my-page");
    await expect(sideFirst).not.toHaveAttribute("aria-current", "page");

    // --- ボタンで開くと /my-page、先頭の項目に aria-current ---
    await page.getByTestId("open-my-page").click();
    await expect(page).toHaveURL(new RegExp(`/apps/${app.appId}/my-page$`));
    await expect(page.getByTestId("my-page")).toBeVisible();
    await expect(page.getByTestId("view-list-my-page")).toHaveAttribute("aria-current", "page");
    // パスワードの変更と退会がマイページの中にある(閉じるボタンは出さない)。
    await expect(page.getByTestId("my-page").getByTestId("account-panel")).toBeVisible();
    await expect(page.getByTestId("my-page").getByTestId("account-change-password")).toBeVisible();
    await expect(page.getByTestId("my-page").getByTestId("account-withdraw")).toBeVisible();
    await expect(page.getByTestId("close-account")).toHaveCount(0);

    // --- メニューの位置だけを上に変える(`D-V22-21`: マイページは消えない。計画の12) ---
    await postDiff(
      request,
      app.appId,
      app.authHeaders,
      workspaceDiff("my-page-top", { navigation: { placement: "top" } }),
    );
    await page.goto(`/apps/${app.appId}/views/${firstView}`);
    await expect(page.locator('[data-navigation-placement="top"]')).toHaveCount(1);
    await expect(page.getByTestId("open-my-page")).toBeVisible();
    // 1280px では横一列で、「≡ メニュー」は見えない。 その先頭がマイページ。
    await expect(page.getByTestId("view-list-items")).toBeVisible();
    await expect(page.getByTestId("view-menu-toggle")).toBeHidden();
    const topFirst = page.getByTestId("view-list-items").locator(":scope > li").first();
    await expect(topFirst).toHaveAttribute("data-testid", "view-list-my-page");
    const tops = await page
      .getByTestId("view-list-items")
      .locator(":scope > li")
      .evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().top)));
    console.log(`[my-page (A)] top tops=${JSON.stringify(tops)}`);
    expect(new Set(tops).size).toBe(1);
    await topFirst.getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/apps/${app.appId}/my-page$`));
    await expect(page.getByTestId("my-page")).toBeVisible();

    // --- 360px: ≡ メニューの先頭がマイページ、開いているので aria-current ---
    await page.setViewportSize(NARROW);
    const toggle = page.getByTestId("view-menu-toggle");
    await expect(toggle).toBeVisible();
    await toggle.click();
    const menuItems = page.locator('[data-slot="overlay-menu"] [role="menuitem"]');
    await expect(menuItems.first()).toHaveAttribute("data-testid", "view-menu-my-page");
    await expect(menuItems.first()).toHaveAttribute("aria-current", "page");
    // 画面の項目に移って、また ≡ の先頭から戻れる。
    await page.getByTestId("view-menu-item").first().click();
    await expect(page).toHaveURL(new RegExp(`/apps/${app.appId}/views/`));
    await page.getByTestId("view-menu-toggle").click();
    await page.getByTestId("view-menu-my-page").click();
    await expect(page).toHaveURL(new RegExp(`/apps/${app.appId}/my-page$`));
    await expect(page.getByTestId("my-page")).toBeVisible();
  });

  test("(B) 運営者(owner)にも自分の行だけ: include は出て exclude は出ない、10件+もっと見る、行を押すと詳細、選んだ画面のボタン", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await installSubject(request, app);
    await setMyPage(request, app, FULL_MY_PAGE);
    const editor = await seedRoleSession(request, app.appId, "editor");
    const customer = await seedRoleSession(request, app.appId, "customer");

    // 自分(owner)のメモ12行(古い順に作る)。 他人(editor・customer)のメモも作る。
    for (let index = 1; index <= 12; index += 1) {
      await app.createRecord(MEMOS, { title: `運営のメモ${index}` });
    }
    await createAs(request, app.appId, editor.authHeaders, MEMOS, { title: "編集者のメモ" });
    await createAs(request, app.appId, customer.authHeaders, MEMOS, { title: "客のメモ" });
    // exclude した表にも自分の行を作る(出ないことを見る)。
    await app.createRecord(DRAFTS, { title: "運営の下書き" });
    // include した表: 自分が担当・他人が担当・担当が空。 **owner はこの表の全行を読める**(一覧では3行見える)。
    await app.createRecord(DUTIES, { title: "運営の当番", assignee: app.userId });
    await app.createRecord(DUTIES, { title: "編集者の当番", assignee: editor.userId });
    await app.createRecord(DUTIES, { title: "担当なしの当番" });

    await page.setViewportSize(WIDE);
    await openSignedIn(page, app, "/my-page");
    await expect(page.getByTestId("my-page")).toBeVisible();

    // アカウントの節(名前・役割・ログインID)。
    await expect(page.getByTestId("my-page-role")).not.toHaveText("");
    await expect(page.getByTestId("my-page-login-id")).not.toHaveText("");

    // 載る表は memos と duties の2つ(drafts は exclude)。
    await expect(page.locator("[data-my-page-table]")).toHaveCount(2);
    await expect(page.getByTestId(`my-page-table-${MEMOS}`)).toBeVisible();
    await expect(page.getByTestId(`my-page-table-${DUTIES}`)).toBeVisible();
    await expect(page.getByTestId(`my-page-table-${DRAFTS}`)).toHaveCount(0);

    // --- memos: 10件、新しい順、他人の行は無い ---
    const memos = page.getByTestId(`my-page-table-${MEMOS}`);
    await expect(memos.getByTestId("my-page-row")).toHaveCount(10);
    const firstTen = await rowTitles(page, MEMOS);
    console.log(`[my-page (B)] first10=${JSON.stringify(firstTen)}`);
    expect(firstTen).toEqual(
      Array.from({ length: 10 }, (_unused, index) => `運営のメモ${12 - index}`),
    );
    // --- もっと見る で残りの2件。 全部出たらボタンは消える ---
    await memos.getByTestId("my-page-more").click();
    await expect(memos.getByTestId("my-page-row")).toHaveCount(12);
    await expect(memos.getByTestId("my-page-more")).toHaveCount(0);
    const all = await rowTitles(page, MEMOS);
    expect(all).toEqual(Array.from({ length: 12 }, (_unused, index) => `運営のメモ${12 - index}`));
    expect(all).not.toContain("編集者のメモ");
    expect(all).not.toContain("客のメモ");

    // --- duties(include): 自分が担当の1行だけ。 他人が担当・担当が空の行は出ない。 詳細画面が無いので押せない ---
    const duties = page.getByTestId(`my-page-table-${DUTIES}`);
    await expect(duties.getByTestId("my-page-row")).toHaveCount(1);
    expect(await rowTitles(page, DUTIES)).toEqual(["運営の当番"]);
    await expect(duties.getByTestId("my-page-row")).toHaveAttribute("data-openable", "false");
    await expect(duties.getByTestId("my-page-row").getByRole("link")).toHaveCount(0);
    await expect(duties.getByTestId("my-page-more")).toHaveCount(0);

    // --- 選んだ画面: 宣言の並びのまま2つ ---
    const openButtons = page.getByTestId("my-page-open-view");
    await expect(openButtons).toHaveCount(2);
    await expect(openButtons).toHaveText(["メモの一覧", "当番の一覧"]);

    // --- 行を押すと詳細画面 ---
    await memos.getByTestId("my-page-row").first().getByRole("link").click();
    await expect(page).toHaveURL(
      new RegExp(`/apps/${app.appId}/views/${MEMO_DETAIL}/records/[^/]+$`),
    );
    await expect(page.getByText("運営のメモ12").first()).toBeVisible();

    // --- 選んだ画面のボタンで一覧を開く ---
    await page.getByTestId("open-my-page").click();
    await expect(page.getByTestId("my-page")).toBeVisible();
    await page.getByTestId("my-page-open-view").nth(1).click();
    await expect(page).toHaveURL(new RegExp(`/apps/${app.appId}/views/${DUTY_LIST}$`));
    // 一覧(`?my_page` を付けない読取)では owner は3行とも見える = 絞りはマイページだけ。
    await expect(page.getByTestId("list-row")).toHaveCount(3);
  });

  test("(C) 一般の人(customer)には自分の行だけ。一覧を開けない表の節と画面のボタンは出ない", async ({
    browser,
    request,
  }) => {
    const app = await provisionApp(request);
    await installSubject(request, app);
    await setMyPage(request, app, FULL_MY_PAGE);
    const customer = await seedRoleSession(request, app.appId, "customer");
    const other = await seedRoleSession(request, app.appId, "customer");
    await createAs(request, app.appId, customer.authHeaders, MEMOS, { title: "わたしのメモ" });
    await createAs(request, app.appId, other.authHeaders, MEMOS, { title: "となりのメモ" });
    await app.createRecord(MEMOS, { title: "運営のメモ" });
    await app.createRecord(DUTIES, { title: "客の当番", assignee: customer.userId });

    const context: BrowserContext = await browser.newContext({ viewport: WIDE });
    try {
      await customer.authenticate(context);
      const page = await context.newPage();
      await page.goto(`/apps/${app.appId}/my-page`);
      await expect(page.getByTestId("my-page")).toBeVisible();
      await expect(page.getByTestId("current-role")).toHaveAttribute("data-role", "customer");
      // 上端のボタンもマイページ(役割に関わらず。`D-V22-16`)。
      await expect(page.getByTestId("open-my-page")).toBeVisible();
      await expect(page.getByTestId("open-account")).toHaveCount(0);

      // 載る表は memos だけ(duties は customer が一覧を1本も開けない。`D-V22-24`)。
      await expect(page.locator("[data-my-page-table]")).toHaveCount(1);
      await expect(page.getByTestId(`my-page-table-${DUTIES}`)).toHaveCount(0);
      const memos = page.getByTestId(`my-page-table-${MEMOS}`);
      await expect(memos.getByTestId("my-page-row")).toHaveCount(1);
      expect(await rowTitles(page, MEMOS)).toEqual(["わたしのメモ"]);
      // 行を押すと詳細画面(customer も開ける)。
      await expect(memos.getByTestId("my-page-row")).toHaveAttribute("data-openable", "true");

      // 選んだ画面のうち開けるのは memos の一覧だけ(当番の一覧は名前も出ない)。
      await expect(page.getByTestId("my-page-open-view")).toHaveCount(1);
      await expect(page.getByTestId("my-page-open-view")).toHaveText("メモの一覧");
      await expect(page.getByText("当番の一覧")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("(D) パスワードをマイページで変え、ログアウト → 再ログインでマイページに移る。公開の入口からは移り、公開画面を指してからは移らない", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await installSubject(request, app);
    await setMyPage(request, app, FULL_MY_PAGE);
    await page.setViewportSize(WIDE);

    // --- 公開の入口から登録する(一般の人。パスワード) ---
    await page.goto(`/apps/${app.appId}`);
    await expect(page.getByTestId("anonymous-workspace")).toBeVisible();
    await page.getByTestId("anonymous-login-link").click();
    await expect(page).toHaveURL(new RegExp(`/apps/${app.appId}/login$`));
    const username = `mp-shopper-${Date.now()}`;
    await page.getByTestId("auth-username").fill(username);
    await page.getByTestId("auth-password").fill(PASSWORD);
    await page.getByTestId("customer-password-register").click();
    await expect(page.getByTestId("current-user")).toHaveText(username);
    await expect(page.getByTestId("current-role")).toHaveAttribute("data-role", "customer");
    // 登録の直後は、登録直後に自動で開く入力画面が先(`D-V22-25`)。 customer が書ける入力画面はメモの1枚だけ。
    await expect(page).toHaveURL(new RegExp(`/apps/${app.appId}/views/${MEMO_FORM}$`));
    await expect(page.getByTestId("my-page")).toHaveCount(0);

    // --- マイページの中でパスワードを変える(計画の6) ---
    await page.getByTestId("open-my-page").click();
    await expect(page.getByTestId("my-page")).toBeVisible();
    await expect(page.getByTestId("my-page-login-id")).toHaveText(username);
    await page.getByTestId("account-current-password").fill(PASSWORD);
    await page.getByTestId("account-new-password").fill(NEW_PASSWORD);
    await page.getByTestId("account-change-password").click();
    await expect(page.getByTestId("account-password-changed")).toBeVisible();

    // --- ログアウト → 新しいパスワードでログイン → マイページへ移る(計画の7。画面を指さずに入った) ---
    await page.getByTestId("logout").click();
    await expect(page.getByTestId("current-user")).toHaveCount(0);
    await page.goto(`/apps/${app.appId}/login`);
    await loginWithPassword(page, username, NEW_PASSWORD);
    await expect(page).toHaveURL(new RegExp(`/apps/${app.appId}/my-page$`));
    await expect(page.getByTestId("my-page")).toBeVisible();

    // --- 公開の入口(`/apps/<id>` で自動で出る公開一覧)から入ったら移る ---
    await page.getByTestId("logout").click();
    await expect(page.getByTestId("current-user")).toHaveCount(0);
    await page.goto(`/apps/${app.appId}`);
    await expect(page.getByTestId("anonymous-workspace")).toBeVisible();
    await page.getByTestId("anonymous-login-link").click();
    await loginWithPassword(page, username, NEW_PASSWORD);
    await expect(page).toHaveURL(new RegExp(`/apps/${app.appId}/my-page$`));
    await expect(page.getByTestId("my-page")).toBeVisible();

    // --- 公開画面を指してからログインしたら移らない(`/login` に留まり、作業画面が出る) ---
    await page.getByTestId("logout").click();
    await expect(page.getByTestId("current-user")).toHaveCount(0);
    await page.goto(`/apps/${app.appId}/views/${PUBLIC_LIST}`);
    await expect(page.getByTestId("anonymous-workspace")).toBeVisible();
    await page.getByTestId("anonymous-login-link").click();
    await loginWithPassword(page, username, NEW_PASSWORD);
    await expect(page.getByTestId("open-my-page")).toBeVisible();
    await expect(page).not.toHaveURL(/\/my-page$/);
    await expect(page.getByTestId("my-page")).toHaveCount(0);
  });

  test("(G) 暗い表示でもテーマの色が効く(明るい・暗いの両方)", async ({ page, request }) => {
    const app = await provisionApp(request);
    await installSubject(request, app);
    await setTheme(request, app);
    await setMyPage(request, app, FULL_MY_PAGE);
    await app.createRecord(MEMOS, { title: "運営のメモ" });
    await page.setViewportSize(WIDE);

    await page.emulateMedia({ colorScheme: "light" });
    await openSignedIn(page, app, "/my-page");
    await expect(page.getByTestId("my-page-row")).toHaveCount(1);
    const light = await textColor(page, "my-page");
    const lightRow = await textColor(page, "my-page-login-id");
    console.log(`[my-page (G)] light=${light} row=${lightRow}`);
    expect(light).toBe("rgb(26, 35, 126)");
    expect(lightRow).toBe("rgb(26, 35, 126)");

    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(async () => await textColor(page, "my-page")).toBe("rgb(245, 245, 245)");
    const darkRow = await textColor(page, "my-page-login-id");
    const background = await page
      .locator(".app-theme")
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    console.log(`[my-page (G)] darkRow=${darkRow} background=${background}`);
    expect(darkRow).toBe("rgb(245, 245, 245)");
    // マイページは `.app-theme` の内側に描かれる(外枠に漏れない)。
    expect(
      await page.evaluate(() => {
        const scope = document.querySelector(".app-theme");
        const target = document.querySelector('[data-testid="my-page"]');
        return scope !== null && target !== null && scope.contains(target);
      }),
    ).toBe(true);
  });

  test("(H) POST /undo でマイページが消え、「アカウント」に戻る", async ({ page, request }) => {
    const app = await provisionApp(request);
    await installSubject(request, app);
    await setMyPage(request, app, FULL_MY_PAGE);
    await page.setViewportSize(WIDE);
    await openSignedIn(page, app, `/views/${MEMO_LIST}`);
    await expect(page.getByTestId("open-my-page")).toBeVisible();
    await expect(page.getByTestId("view-list-my-page")).toHaveCount(1);

    const undone = await request.post(`/api/apps/${app.appId}/undo`, { headers: app.authHeaders });
    expect(undone.status(), await undone.text()).toBe(200);
    await page.reload();
    await expect(page.getByTestId("view-list")).toBeVisible();
    await expect(page.getByTestId("open-account")).toBeVisible();
    await expect(page.getByTestId("open-my-page")).toHaveCount(0);
    await expect(page.getByTestId("view-list-my-page")).toHaveCount(0);
    await page.goto(`/apps/${app.appId}/my-page`);
    await expect(page.getByTestId("my-page-missing")).toBeVisible();
  });

  test("(F) 配る版も同じ: ボタンが替わり、メニューの先頭に出て、マイページが開く", async ({
    page,
    request,
  }) => {
    const seeded = await request.post(`/__e2e__/apps/${RUNNER_APP_ID}/session`);
    expect(seeded.status(), await seeded.text()).toBe(201);
    const spec = (await seeded.json()) as { name: string; value: string; path: string };
    const headers = { cookie: `${spec.name}=${spec.value}` };
    // 配る版には差分の口が無いので、育成用の版の口で同じアプリに宣言する。
    await postDiff(
      request,
      RUNNER_APP_ID,
      headers,
      workspaceDiff("runner-my-page", { my_page: { views: ["item-list"] } }),
    );
    try {
      await page.setViewportSize(WIDE);
      await page
        .context()
        .addCookies([
          { name: spec.name, value: spec.value, url: `http://localhost:${port}${spec.path}` },
        ]);
      await page.goto(`${runnerBase}/apps/${RUNNER_APP_ID}`);
      expect(await page.getByText("どのアプリを表示するかが与えられていません。").count()).toBe(0);
      await expect(page.getByTestId("open-my-page")).toBeVisible();
      await expect(page.getByTestId("open-account")).toHaveCount(0);
      await expect(page.getByTestId("view-list-my-page").first()).toBeVisible();
      await page.getByTestId("open-my-page").click();
      await expect(page).toHaveURL(new RegExp(`/apps/${RUNNER_APP_ID}/my-page$`));
      await expect(page.getByTestId("my-page")).toBeVisible();
      await expect(page.getByTestId("my-page-account")).toBeVisible();
      // 題材の表には持ち主の分かる表が無い = 「載せる記録はありません」。
      await expect(page.getByTestId("my-page-no-tables")).toBeVisible();
      await expect(page.getByTestId("my-page-open-view")).toHaveCount(1);
      await page.getByTestId("my-page-open-view").click();
      await expect(page).toHaveURL(new RegExp(`/apps/${RUNNER_APP_ID}/views/item-list$`));
    } finally {
      // 後始末: マイページの宣言だけを消す(配る版のアプリは他の検査と共有している)。
      await postDiff(
        request,
        RUNNER_APP_ID,
        headers,
        workspaceDiff("runner-my-page-clear", { my_page: null }),
      );
    }
  });
});

/**
 * **【`V22-M4-T08`】未解決の穴を塞いだ後のマイページ**(`ADR-0494` §Decision 2・3。穴 `H-V22-3`・`H-V22-4`。
 * ユーザ決定 `D-V22-30`・`D-V22-31`・`D-V22-37`・`D-V22-40`)。 計画 `V22-M4` 節の T08 の (4)(5)。
 */
test.describe("V22-M4-T08 マイページ(画面0枚の役割・最新に更新)", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "上の describe と同じ理由(chromium の実測)",
  );

  test("(4) マイページのあるアプリで画面0枚の役割(customer)にログインすると、左・上・360px の ≡ のどれでも「マイページ」だけ", async ({
    page,
    request,
  }) => {
    // **題材の表は足さない** —— フィクスチャの表は `st_owner` も `st_public` も持たないので、customer が開ける画面は0枚
    // (`web/e2e/owner-scope.e2e.ts` の「customer で使える画面が0件でも」と同じ前提)。
    const app = await provisionApp(request);
    await setMyPage(request, app, {});
    const customer = await seedRoleSession(request, app.appId, "customer");
    await customer.authenticate(page.context());

    // --- 左 ---
    await page.setViewportSize(WIDE);
    await page.goto(`/apps/${app.appId}`);
    await expect(page.getByTestId("current-role")).toHaveAttribute("data-role", "customer");
    const side = page.getByTestId("view-list");
    await expect(side).toBeVisible();
    await expect(page.getByTestId("view-list-empty")).toHaveCount(0);
    await expect(side.locator("li")).toHaveCount(1);
    await expect(side.locator("li").first()).toHaveAttribute("data-testid", "view-list-my-page");

    // --- 上(1280px の横一列) ---
    await postDiff(
      request,
      app.appId,
      app.authHeaders,
      workspaceDiff("my-page-zero-top", { navigation: { placement: "top" } }),
    );
    await page.goto(`/apps/${app.appId}`);
    await expect(page.locator('[data-navigation-placement="top"]')).toHaveCount(1);
    await expect(page.getByTestId("view-list-empty")).toHaveCount(0);
    const items = page.getByTestId("view-list-items").locator(":scope > li");
    await expect(items).toHaveCount(1);
    await expect(items.first()).toHaveAttribute("data-testid", "view-list-my-page");

    // --- 360px の ≡ ---
    await page.setViewportSize(NARROW);
    await expect(page.getByTestId("view-list-empty")).toHaveCount(0);
    const toggle = page.getByTestId("view-menu-toggle");
    await expect(toggle).toBeVisible();
    await toggle.click();
    const menuItems = page.locator('[data-slot="overlay-menu"] [role="menuitem"]');
    await expect(menuItems).toHaveCount(1);
    await expect(menuItems.first()).toHaveAttribute("data-testid", "view-menu-my-page");
    await expect(page.getByTestId("view-list-empty")).toHaveCount(0);
    await page.getByTestId("view-menu-my-page").click();
    await expect(page).toHaveURL(new RegExp(`/apps/${app.appId}/my-page$`));
    await expect(page.getByTestId("my-page")).toBeVisible();
  });

  test("(5) 「最新に更新」を押すと、別の経路で足した行が先頭に出る(10件のまま・重複なし)", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await installSubject(request, app);
    await setMyPage(request, app, FULL_MY_PAGE);
    for (let index = 1; index <= 11; index += 1) {
      await app.createRecord(MEMOS, { title: `運営のメモ${index}` });
    }
    await page.setViewportSize(WIDE);
    await openSignedIn(page, app, "/my-page");
    await expect(page.getByTestId("my-page")).toBeVisible();
    const memos = page.getByTestId(`my-page-table-${MEMOS}`);
    await expect(memos.getByTestId("my-page-row")).toHaveCount(10);
    const refresh = memos.getByTestId("my-page-refresh");
    await expect(refresh).toHaveCount(1);
    await expect(refresh).toHaveText("最新に更新");
    await expect(refresh).toBeEnabled();
    // 表ごとの節に1つずつ(載る表は memos と duties の2つ)。
    await expect(page.getByTestId("my-page-refresh")).toHaveCount(2);
    expect(await rowTitles(page, MEMOS)).toEqual(
      Array.from({ length: 10 }, (_unused, index) => `運営のメモ${11 - index}`),
    );

    // **別の経路(API)で1行足す。** 押すまでは画面は変わらない(新着の知らせも出さない)。
    await app.createRecord(MEMOS, { title: "あとから足したメモ" });
    expect(await rowTitles(page, MEMOS)).not.toContain("あとから足したメモ");

    await refresh.click();
    await expect(memos.getByTestId("my-page-row").first()).toHaveText("あとから足したメモ");
    await expect(memos.getByTestId("my-page-row")).toHaveCount(10);
    const after = await rowTitles(page, MEMOS);
    console.log(`[my-page T08 (5)] after=${JSON.stringify(after)}`);
    expect(after).toEqual([
      "あとから足したメモ",
      ...Array.from({ length: 9 }, (_unused, index) => `運営のメモ${11 - index}`),
    ]);
    expect(new Set(after).size).toBe(after.length);
    await expect(refresh).toBeEnabled();
  });
});
