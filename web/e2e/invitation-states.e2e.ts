/**
 * **3状態の招待が、本物のサーバの上で別々の文字列として一覧に出ることの実証**
 * (`V19-M3-T03`。台帳 `SV-G5`)。
 *
 * ## **なぜこの1本が要るのか**(**起票の完了条件 (b)**)
 *
 * **着手前、使われた招待と取り消された招待が**本物のサーバから返ってくる様子は1度も
 * 撃たれていなかった。** **`web/test/invitation-list-panel.test.tsx` は応答を差し替えて
 * 画面の側だけを見ており**(同ファイルの冒頭が自分でそう書いている)、
 * **`web/e2e/invitation-list.e2e.ts` が本物のサーバで作れたのは1件だけである**
 * (同ファイルの「ここで証明していないこと」の2点目)。
 * **本ファイルは3つの状態を**実際に作ってから**一覧を開く。**
 *
 * ## 3つの状態の作り方(**どれも既存の口だけで作る。新しい口を1本も足していない**)
 *
 * 1. **発行するだけ。**
 * 2. **発行したコードを**未ログインのブラウザ**から入れて登録を通す**
 *    (`web/e2e/invitation-signup.e2e.ts` と同じ手順)。
 * 3. **発行したうえで、同じ口に `revoke` を送る。** **取り消しの画面は今日まだ無い**
 *    (`V19-M3-T02` の射程)ので、**HTTP の口を直接叩く**(計画 `§9-D` の裁定)。
 *
 * ## 検証点(**4つ**)
 *
 * 1. **3件が3行とも一覧に出る** —— **使われた行も取り消された行も落ちない。**
 * 2. **3行の状態の欄が、互いに違う文字列になる**(= **見分けられる**)。
 * 3. **開き直しても3行の表示は変わらない** —— **手元に持っている値ではなく、
 *    サーバが返した値を並べていることを示す。**
 * 4. **3件ぶんのコードが、画面に1度も現れない。**
 *
 * ## ここで証明していないこと(**誇張しない。先に書く**)
 *
 * - **取り消しを画面から撃ってはいない** —— **押せるものが今日は1つも無い。**
 *   **本ファイルが撃ったのは HTTP の口である。**
 * - **発行できる人 / 一覧を読める人の範囲は1つも測っていない** —— **この台の既定セッションは
 *   `owner` である。** **範囲を決めているのはサーバであり、その担保は `src/server/` の
 *   検査の担当である。** **【禁止】「画面に出ないこと」を制限の担保にしない。**
 * - **期限切れの行は1件も作っていない** —— **期限は発行から24時間の固定で、この台では
 *   縮められない。** **期限切れの行がどう出るかは1度も撃っていない。**
 * - **この版より前に作られた行の読み方は1つも測っていない**(`src/auth/` の検査の担当)。
 */
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { type FixtureApp, provisionApp } from "./fixture-app.ts";

/**
 * **書込の口に添える origin**(`web/e2e/invitation-signup.e2e.ts` と同じ値)。
 *
 * **落とすと画面から何も書けない** —— **先例がこの値を添えている。**
 * **【正直に書く】port を直値で持っている** —— **`ST_E2E_PORT` を変えるとここだけ古くなる。**
 * **先例も同じ性質を持っており、本ファイルはそれを1ミリも改善していない。**
 */
const ORIGIN = "http://localhost:3210";

/** 招待制の立場に付ける登録時のパスワード(値そのものに意味は無い)。 */
const PASSWORD = "correct-horse-battery-staple";

type LooseRole = { id: string; name?: string; signup?: "invite" | "open"; rules?: unknown[] };

/**
 * そのアプリに `staff`(招待制)を宣言する。
 *
 * **差し替えの口は既存のもの**(`POST /__e2e__/apps/:app_id/manifest`)——
 * **製品のサーバにはマニフェストを変更する口が1本も無い**(`ADR-0003`)。
 * **形は `web/e2e/invitation-signup.e2e.ts` の同名の関数に倣っている** ——
 * **招待コードで登録を通せる立場が1つも無いと、2つ目の状態を作れない。**
 */
async function declareInviteRole(request: APIRequestContext, app: FixtureApp): Promise<void> {
  const declared = structuredClone(app.manifest) as unknown as {
    app: { roles?: LooseRole[] };
  };
  const roles = declared.app.roles ?? [];
  const firstView = app.manifest.app.views[0]?.id;
  const firstTable = app.manifest.app.tables[0]?.id;
  roles.push({
    id: "staff",
    name: "スタッフ",
    signup: "invite",
    rules: [
      { target: "view", view: firstView, can: ["read"] },
      { target: "table", table: firstTable, can: ["read"] },
    ],
  });
  declared.app.roles = roles;
  const applied = await request.post(`/__e2e__/apps/${app.appId}/manifest`, { data: declared });
  expect(applied.status(), await applied.text()).toBe(200);
}

/** 招待の口(**着手前から在る1本。本ファイルは1本も足していない**)。 */
const invitationsPath = (app: FixtureApp): string => `/api/apps/${app.appId}/auth/invitations`;

/** 招待を1件発行し、応答が載せたコードを返す。 */
async function issue(
  request: APIRequestContext,
  app: FixtureApp,
  username: string,
  role: string,
): Promise<string> {
  const response = await request.post(invitationsPath(app), {
    headers: { ...app.authHeaders, origin: ORIGIN },
    data: { username, role },
  });
  // **本文は1度だけ読む**(読み直しに依存しない形にする)。
  const body = await response.text();
  expect(response.status(), body).toBe(200);
  return (JSON.parse(body) as { invitation: { code: string } }).invitation.code;
}

/** その相手の招待を取り消す(**同じ口に `revoke` を送る。口は増えない**)。 */
async function revoke(
  request: APIRequestContext,
  app: FixtureApp,
  username: string,
): Promise<void> {
  const response = await request.post(invitationsPath(app), {
    headers: { ...app.authHeaders, origin: ORIGIN },
    data: { username, revoke: true },
  });
  const body = await response.text();
  expect(response.status(), body).toBe(200);
}

test.describe("3状態の招待を本物のサーバで見分ける(`V19-M3-T03` / `SV-G5`)", () => {
  test("発行 / 登録して使う / 取り消す の3件が、一覧で別々の文字列になる", async ({
    page,
    request,
    browser,
  }) => {
    const app = await provisionApp(request);
    await declareInviteRole(request, app);

    // **相手の名前は3件とも別にする** —— **招待の主キーは相手の名前1列なので、
    // 同じ名前に2度発行すると行が差し替わり、3行にならない。**
    const stamp = Date.now();
    const newcomer = `newcomer-${stamp}`;
    const joined = `joined-${stamp}`;
    const cancelled = `cancelled-${stamp}`;

    const newcomerCode = await issue(request, app, newcomer, "staff");
    const joinedCode = await issue(request, app, joined, "staff");
    const cancelledCode = await issue(request, app, cancelled, "staff");

    // --- 2つ目の状態を作る(未ログインのブラウザで、コードを入れて登録する)-------------
    const guestContext = await browser.newContext();
    try {
      const guest = await guestContext.newPage();
      await guest.goto(`/apps/${app.appId}`);
      await expect(guest.getByTestId("login-page")).toBeVisible();
      await guest.getByTestId("auth-username").fill(joined);
      await guest.getByTestId("auth-password").fill(PASSWORD);
      await guest.getByTestId("auth-user-kind").selectOption("staff");
      await guest.getByTestId("auth-invitation-code").fill(joinedCode);
      await guest.getByTestId("customer-password-register").click();
      // **登録が通ったことを確かめてから閉じる** —— **通っていなければ印は立たない。**
      await expect(guest.getByTestId("current-user")).toHaveText(joined);
    } finally {
      await guestContext.close();
    }

    // --- 3つ目の状態を作る(画面の口が今日まだ無いので、HTTP の口を直接叩く)-------------
    await revoke(request, app, cancelled);

    // --- 運営者の画面を開く ------------------------------------------------------------
    // **既定セッションは `owner`** —— 招待が応答に載るのは持ち主のときだけである。
    await app.authenticate(page.context());
    await page.goto(`/apps/${app.appId}`);
    await page.getByTestId("open-user-admin").click();
    await expect(page.getByTestId("user-admin")).toBeVisible();
    // **招待の節の中だけを数える**(`invitation-list.e2e.ts` と同じ形。画面全体で数えると
    // 利用者の表を巻き込む)。
    const invitations = page.getByTestId("user-admin-invitations");
    await expect(invitations).toBeVisible();

    const stateOf = (username: string) =>
      invitations
        .locator(`[data-testid="invitation-row"][data-username="${username}"]`)
        .getByTestId("invitation-row-state");

    // --- (1) 3件が3行とも出る(使われた行も取り消された行も落ちない)---------------------
    await expect(invitations.getByTestId("invitation-row")).toHaveCount(3);

    // --- (2) 3行の状態が互いに違う文字列になる ------------------------------------------
    await expect(stateOf(newcomer)).toHaveText("未使用");
    await expect(stateOf(joined)).toHaveText("使用済み");
    await expect(stateOf(cancelled)).toHaveText("取り消し済み");
    // **3つが互いに違うことを、表示の側からも数える**(3つのうち2つが同じ文字列に
    // 化けていたら、上の3本が緑でも「見分けられる」は成立しない —— という形にはならないが、
    // **数えずに「別々だ」と書かない**)。
    const shown = await invitations.getByTestId("invitation-row-state").allTextContents();
    expect(shown).toHaveLength(3);
    expect(new Set(shown).size).toBe(3);

    // --- (3) 開き直しても同じ3つが出る(サーバが返した値を並べている)---------------------
    await page.reload();
    await page.getByTestId("open-user-admin").click();
    await expect(page.getByTestId("user-admin")).toBeVisible();
    await expect(stateOf(newcomer)).toHaveText("未使用");
    await expect(stateOf(joined)).toHaveText("使用済み");
    await expect(stateOf(cancelled)).toHaveText("取り消し済み");

    // --- (4) 3件ぶんのコードが、画面に1度も現れない --------------------------------------
    // **発行の結果はその場に出るが、開き直した後の画面には残っていない。**
    await expect(page.getByTestId("invite-code")).toHaveCount(0);
    const content = await page.content();
    for (const code of [newcomerCode, joinedCode, cancelledCode]) {
      await expect(invitations.getByText(code, { exact: false })).toHaveCount(0);
      expect(content.includes(code)).toBe(false);
    }
  });
});
