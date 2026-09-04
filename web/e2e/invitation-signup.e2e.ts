/**
 * **招待コードをブラウザから入れて登録が通ることの実証**(`V8-M5-T04`。台帳 `I-G8` /
 * `I-G27`。**ユーザ決定 `D-V8-112` / `D-V8-114`**)。
 *
 * ## **これは判定手段ではない。実証である**(裁定 `M5-2`)
 *
 * **`I-G27` の判定手段は `GET /api/apps/:app_id/public` の JSON の差分である**(裁定 `M0-4`)。
 * **`curl` の HTML 差分では判定しない** —— **SPA なので3本とも同一の394バイトになる。**
 * **本ファイルが担うのは「ブラウザから実際に招待コードを入れて登録が通る」ことの実証だけで
 * ある。** **【禁止】これを `I-G27` の判定に使わない。**
 *
 * ## 検証点
 *
 * 1. **招待制を宣言したアプリのログイン画面に、招待コードの欄と立場を選ぶ欄が出る。**
 * 2. **招待コードを入れずに招待制の立場で登録すると、サーバの 403 の文面が画面に出る。**
 * 3. **正しい招待コードを入れると登録が通り、招待された役割が付く。**
 * 4. **招待を1つも宣言していないアプリでは、どちらの欄も出ない**(着手前の画面と同じ)。
 *
 * ## ここで証明していないこと(**先に書く**)
 *
 * - **サーバが同じ判定を持つことは、ここでは1つも測っていない**(`src/server/` の検査の担当)。
 *   **【禁止】「画面に欄が出ない」を制限の担保にしない。**
 * - **passkey 経路の招待は測っていない**(実 WebAuthn 儀式が要る。単体
 *   `web/test/invitation-signup-ui.test.tsx` の (3) が本文の中身だけを固定している)。
 * - **配布用の器の中での挙動は測っていない**(`I-G31` の担当)。
 */
import { expect, test } from "@playwright/test";
import { type FixtureApp, provisionApp } from "./fixture-app.ts";

type LooseRole = { id: string; name?: string; signup?: "invite" | "open"; rules?: unknown[] };

/**
 * そのアプリに `staff`(招待制)を宣言する。
 *
 * **差し替えの口は既存のもの**(`POST /__e2e__/apps/:app_id/manifest`。
 * `customer-signup.e2e.ts` / `owner-scope.e2e.ts` と同じ作法)。**製品のサーバには
 * マニフェストを変更する口が1本も無い**(`ADR-0003`)。
 */
async function declareInviteRole(
  request: Parameters<typeof provisionApp>[0],
  app: FixtureApp,
): Promise<void> {
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

test.describe("招待コードでの登録(`D-V8-112` / `D-V8-114`)", () => {
  test("招待コードを入れるとブラウザだけで登録が完了する", async ({ page, request }) => {
    const app = await provisionApp(request);
    await declareInviteRole(request, app);

    // --- 運営者が招待を1件発行する(`POST /api/apps/:app_id/auth/invitations`)---------
    const invited = `invited-${Date.now()}`;
    const issued = await request.post(`/api/apps/${app.appId}/auth/invitations`, {
      headers: { ...app.authHeaders, origin: "http://localhost:3210" },
      data: { username: invited, role: "staff" },
    });
    expect(issued.status(), await issued.text()).toBe(200);
    const code = ((await issued.json()) as { invitation: { code: string } }).invitation.code;

    // --- 未ログインのブラウザで登録画面を開く ------------------------------------------
    await page.goto(`/apps/${app.appId}`);
    await expect(page.getByTestId("login-page")).toBeVisible();
    // **欄が出る**(`GET /public` の `signup` を見た結果である)。
    await expect(page.getByTestId("auth-invitation-code")).toBeVisible();
    await expect(page.getByTestId("auth-user-kind")).toBeVisible();
    await expect(page.getByTestId("auth-user-kind").locator('option[value="staff"]')).toHaveCount(
      1,
    );

    // --- 招待コード無しでは通らない(サーバの文面がそのまま出る)------------------------
    await page.getByTestId("auth-username").fill(invited);
    await page.getByTestId("auth-password").fill("correct-horse-battery-staple");
    await page.getByTestId("auth-user-kind").selectOption("staff");
    await page.getByTestId("customer-password-register").click();
    await expect(page.getByTestId("auth-error")).toBeVisible();

    // --- 正しい招待コードを入れると通る ------------------------------------------------
    await page.getByTestId("auth-invitation-code").fill(code);
    await page.getByTestId("customer-password-register").click();
    await expect(page.getByTestId("current-user")).toHaveText(invited);
    await expect(page.getByTestId("current-role")).toHaveAttribute("data-role", "staff");
  });

  test("招待を1つも宣言していないアプリでは、どちらの欄も出ない", async ({ page, request }) => {
    const app = await provisionApp(request);
    await page.goto(`/apps/${app.appId}`);
    await expect(page.getByTestId("login-page")).toBeVisible();
    await expect(page.getByTestId("auth-invitation-code")).toHaveCount(0);
    await expect(page.getByTestId("auth-user-kind")).toHaveCount(0);
  });
});
