/**
 * アプリ単位認証(per-app auth)の E2E(V1-M3-T01 / 計画 v3 §P5 / ADR-0014 v3)。
 *
 * ここだけは **本物の WebAuthn 儀式** を CDP の仮想オーセンティケータで通す
 * (他の E2E はセッション直挿しでゲートを通すが、ここはゲートそのものを検証する)。
 * 検証するのは4点:
 *
 *   1. 未認証だとアプリを開いた瞬間そのアプリのログイン画面になる(records が 401)
 *   2. Passkey 新規登録 → ログアウト → Passkey ログイン が実機の資格情報 API で通る
 *   3. password 登録 → ログアウト → password ログイン が通る
 *   4. アプリ間分離: A にログインしても B は別ログインが要る(cookie は Path で分離)
 *
 * ## 仮想オーセンティケータ(CDP / chromium 専用)
 * `page.context().newCDPSession(page)` → `WebAuthn.enable` →
 * `WebAuthn.addVirtualAuthenticator`(ctap2 / internal / resident key 可 / UV 済み)。
 * `automaticPresenceSimulation` は既定 false にしておき、**登録・認証の直前だけ true** に
 * して儀式を成立させ、終わったら false に戻す(`withPresence`)。`isUserVerified:true` なので
 * UV は常に満たされる。`WebAuthn.getCredentials` で資格情報の件数を確認する。
 * WebAuthn は rpID に IP を許さないので、ブラウザは **`http://localhost:<port>`**
 * (playwright.config の baseURL)でアクセスし、サーバの expectedOrigin も localhost に
 * 合わせてある(fixture-server.ts)。他ブラウザでは skip。
 */
import { type CDPSession, expect, test } from "@playwright/test";
import { provisionApp } from "./fixture-app.ts";

test.describe("アプリ単位認証(WebAuthn 仮想オーセンティケータ)", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "WebAuthn 仮想オーセンティケータは chromium(CDP)専用",
  );

  /** 仮想オーセンティケータを1台追加する。presence は既定 off(儀式の直前だけ on にする)。 */
  async function enableAuthenticator(
    page: import("@playwright/test").Page,
  ): Promise<{ client: CDPSession; authenticatorId: string }> {
    const client = await page.context().newCDPSession(page);
    await client.send("WebAuthn.enable");
    const { authenticatorId } = await client.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: false,
      },
    });
    return { client, authenticatorId };
  }

  /** presence を on にして儀式(登録/認証)を実行し、終わったら必ず off に戻す。 */
  async function withPresence<T>(
    client: CDPSession,
    authenticatorId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    await client.send("WebAuthn.setAutomaticPresenceSimulation", {
      authenticatorId,
      enabled: true,
    });
    try {
      return await run();
    } finally {
      await client.send("WebAuthn.setAutomaticPresenceSimulation", {
        authenticatorId,
        enabled: false,
      });
    }
  }

  /** 仮想オーセンティケータが保持する資格情報の件数。 */
  async function credentialCount(client: CDPSession, authenticatorId: string): Promise<number> {
    const { credentials } = await client.send("WebAuthn.getCredentials", { authenticatorId });
    return credentials.length;
  }

  test("未認証でアプリを開くと、そのアプリのログイン画面が出る", async ({ page, request }) => {
    // セッションは仕込まない(ブラウザに cookie を入れない)= 未認証。
    const app = await provisionApp(request);

    await page.goto(`/apps/${app.appId}`);

    // records が 401 なので、AppWorkspace はそのアプリのログイン画面に落ちる。
    await expect(page.getByTestId("login-page")).toBeVisible();
    // 見出しにそのアプリ名が出る(manifest は非保護なので未認証でも取れている)。
    // app.appName は括弧を含むため正規表現ではなくリテラル部分一致で見る。
    await expect(page.getByTestId("login-page")).toContainText(app.appName);
    // 認証済みの UI は出ていない。
    await expect(page.getByTestId("view-list")).toHaveCount(0);
    await expect(page.getByTestId("current-user")).toHaveCount(0);
  });

  test("Passkey 新規登録 → ログアウト → Passkey ログイン", async ({ page, request }) => {
    const app = await provisionApp(request);
    const { client, authenticatorId } = await enableAuthenticator(page);

    await page.goto(`/apps/${app.appId}`);
    await expect(page.getByTestId("login-page")).toBeVisible();
    expect(await credentialCount(client, authenticatorId)).toBe(0);

    // --- 新規登録 ---------------------------------------------------------------
    const username = `passkey-${Date.now()}`;
    await page.getByTestId("auth-username").fill(username);
    await withPresence(client, authenticatorId, async () => {
      await page.getByTestId("passkey-register").click();
      // 登録成功 = 認証済みワークスペースに遷移する。
      await expect(page.getByTestId("view-list")).toBeVisible();
    });
    await expect(page.getByTestId("current-user")).toHaveText(username);
    // 資格情報が1件、実際に作られている。
    expect(await credentialCount(client, authenticatorId)).toBe(1);

    // --- ログアウト -------------------------------------------------------------
    await page.getByTestId("logout").click();
    await expect(page.getByTestId("login-page")).toBeVisible();
    await expect(page.getByTestId("view-list")).toHaveCount(0);

    // --- Passkey ログイン(username 省略 = discoverable credential)-------------
    await withPresence(client, authenticatorId, async () => {
      await page.getByTestId("passkey-login").click();
      await expect(page.getByTestId("view-list")).toBeVisible();
    });
    await expect(page.getByTestId("current-user")).toHaveText(username);
    // ログインでは資格情報は増えない(登録済みの1件を使うだけ)。
    expect(await credentialCount(client, authenticatorId)).toBe(1);
  });

  test("password 登録 → ログアウト → password ログイン", async ({ page, request }) => {
    const app = await provisionApp(request);

    await page.goto(`/apps/${app.appId}`);
    await expect(page.getByTestId("login-page")).toBeVisible();

    const username = `password-${Date.now()}`;
    const password = "correct-horse-battery-staple";

    // --- 登録 -------------------------------------------------------------------
    await page.getByTestId("auth-username").fill(username);
    await page.getByTestId("auth-password").fill(password);
    await page.getByTestId("password-register").click();
    await expect(page.getByTestId("view-list")).toBeVisible();
    await expect(page.getByTestId("current-user")).toHaveText(username);

    // --- ログアウト -------------------------------------------------------------
    await page.getByTestId("logout").click();
    await expect(page.getByTestId("login-page")).toBeVisible();

    // --- ログイン ---------------------------------------------------------------
    await page.getByTestId("auth-username").fill(username);
    await page.getByTestId("auth-password").fill(password);
    await page.getByTestId("password-login").click();
    await expect(page.getByTestId("view-list")).toBeVisible();
    await expect(page.getByTestId("current-user")).toHaveText(username);
  });

  test("アプリ間分離: A にログインしても B はログインが要る", async ({ page, request }) => {
    const appA = await provisionApp(request);
    const appB = await provisionApp(request);

    // A に password でログイン。
    await page.goto(`/apps/${appA.appId}`);
    await expect(page.getByTestId("login-page")).toBeVisible();
    const username = `iso-${Date.now()}`;
    const password = "correct-horse-battery-staple";
    await page.getByTestId("auth-username").fill(username);
    await page.getByTestId("auth-password").fill(password);
    await page.getByTestId("password-register").click();
    await expect(page.getByTestId("view-list")).toBeVisible();
    await expect(page.getByTestId("current-user")).toHaveText(username);

    // B を開くと、A のセッション cookie は Path=/api/apps/:appA に閉じているので効かない。
    await page.goto(`/apps/${appB.appId}`);
    await expect(page.getByTestId("login-page")).toBeVisible();
    await expect(page.getByTestId("view-list")).toHaveCount(0);
    await expect(page.getByTestId("current-user")).toHaveCount(0);
  });
});
