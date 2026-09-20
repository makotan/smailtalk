/**
 * **運営者がブラウザから招待を発行できることの実証**(`V19-M3-T00`。台帳 `SV-G1`)。
 *
 * ## **なぜ E2E が要るのか**(**起票の完了条件 (c) / (d)**)
 *
 * **画面の HTML の差分では判定できない** —— **配っている画面は SPA で、どのアプリを開いても
 * サーバの応答は同一である。** **したがって「画面に発行の口が付いた」ことは、`curl` の
 * 応答本文を見比べても1バイトも現れない。** **本ファイルは実際にブラウザを起こし、
 * 欄を埋め、ボタンを押して、口が撃たれたことと画面の表示を確かめる。**
 *
 * **【禁止】画面を目で見たことを担保にしない**(個別限定③)。
 *
 * ## 検証点(**3つ**)
 *
 * 1. **発行を押すと、既存の口に `POST` が飛び、`200` が返る。**
 * 2. **応答が載せたコードが、画面に逐語で出る。**
 * 3. **登録リンクも、応答が載せたものと逐語で一致して画面に出る。**
 *
 * ## ここで証明していないこと(**誇張しない。先に書く**)
 *
 * - **発行できる人の範囲は1つも測っていない** —— **この台の既定セッションは `owner` である。**
 *   **非 owner が弾かれることは `src/server/` の検査の担当であり、本ファイルは1度も撃っていない。**
 * - **発行した招待で実際に登録できることは測っていない**(`web/e2e/invitation-signup.e2e.ts`
 *   が着手前から別に撃っている)。
 * - **一覧 / 出し直し / 取り消し / 3状態の見分けは1つも撃っていない**
 *   (`V19-M3-T01` / `T02` / `T03` の担当)。
 * - **コードが後から消えることは1つも測っていない**(`V19-M3-T04` = `SV-G7b` の担当)。
 *   **本ファイルはむしろ「出ること」だけを測る。**
 */
import { expect, test } from "@playwright/test";
import { provisionApp } from "./fixture-app.ts";

test.describe("画面から招待を発行する(`V19-M3-T00` / `SV-G1`)", () => {
  test("運営者が画面から発行すると 200 が返り、コードと登録リンクがその場に出る", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    // **既定セッションは `owner`** —— 導線はそのときだけ出る。
    await app.authenticate(page.context());
    await page.goto(`/apps/${app.appId}`);
    await page.getByTestId("open-user-admin").click();
    await expect(page.getByTestId("user-admin")).toBeVisible();

    // --- 発行の口が画面に在る(着手前はこの3つが1つも無かった)------------------------
    await expect(page.getByTestId("invite-username")).toBeVisible();
    await expect(page.getByTestId("invite-role")).toBeVisible();
    await expect(page.getByTestId("invite-submit")).toBeVisible();

    // --- 押す前は、コードも登録リンクも画面に1件も出ていない ---------------------------
    await expect(page.getByTestId("invite-code")).toHaveCount(0);
    await expect(page.getByTestId("invite-signup-url")).toHaveCount(0);

    const invited = `invited-${Date.now()}`;
    await page.getByTestId("invite-username").fill(invited);
    await page.getByTestId("invite-role").selectOption("viewer");

    const issuePath = `/api/apps/${app.appId}/auth/invitations`;
    const pending = page.waitForResponse(
      (response) => response.url().endsWith(issuePath) && response.request().method() === "POST",
    );
    await page.getByTestId("invite-submit").click();
    const response = await pending;

    // --- (1) HTTP 200 -----------------------------------------------------------------
    // **本文は1度だけ読む**(読み直しに依存しない形にする)。
    const bodyText = await response.text();
    expect(response.status(), bodyText).toBe(200);

    const payload = JSON.parse(bodyText) as {
      invitation: { username: string; code: string };
      signupUrl?: string;
    };
    expect(payload.invitation.username).toBe(invited);

    // --- (2) 画面上のコードの表示(応答の本文と逐語で一致する)--------------------------
    await expect(page.getByTestId("invite-code")).toHaveText(payload.invitation.code);

    // --- (3) 登録リンクも応答と逐語で一致して出る --------------------------------------
    // **画面の側でリンクを組み立てていないこと**を、応答との一致で示す。
    expect(payload.signupUrl).toBeDefined();
    await expect(page.getByTestId("invite-signup-url")).toHaveText(payload.signupUrl as string);
    await expect(page.getByTestId("invite-signup-url")).toHaveAttribute(
      "href",
      payload.signupUrl as string,
    );
  });
});
