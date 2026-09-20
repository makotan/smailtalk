/**
 * **発行した招待が運営者の画面の一覧に現れることの実証**(`V19-M3-T01`。台帳 `SV-G2`)。
 *
 * ## **なぜ E2E が要るのか**(**起票の完了条件 (c) / (d)**)
 *
 * **配っている画面は SPA なので、「一覧に列が付いた」ことは `curl` の応答本文を見比べても
 * 1バイトも現れない。** **本ファイルは実際にブラウザを起こし、発行し、画面を開き直して、
 * 本物のサーバが返した招待が一覧に出ることを確かめる。**
 *
 * ## 検証点(**4つ**)
 *
 * 1. **発行する前、招待の行は0件である**(払い出したばかりのアプリ)。
 * 2. **発行すると、その相手の行が一覧に出る**(完了条件 (c))。
 * 3. **画面を開き直しても、その行は出たままである** ——
 *    **手元に持っている値ではなく、サーバが返した値を並べていることを示す。**
 * 4. **一覧にコードが1件も出ない**(完了条件 (d))——
 *    **開き直した後の画面の文字列全体を数えて、発行で受け取ったコードが
 *    1度も現れないことを示す。** **`SV-G7b` の側と二重に測ることになるが、丸めない。**
 *
 * ## ここで証明していないこと(**誇張しない。先に書く**)
 *
 * - **発行できる人の範囲は1つも測っていない** —— **この台の既定セッションは `owner` である。**
 *   **持ち主でない人に招待が載らないことは `src/server/` の検査の担当であり、
 *   本ファイルは1度も撃っていない。**
 * - **使用済み / 取り消し済みの行が本物のサーバから返ってくる様子は撃っていない** ——
 *   **この台で作れるのは未使用の1件だけである**(登録も取り消しも踏んでいない)。
 *   **3値の出し分けは `web/test/invitation-list-panel.test.tsx` が応答を差し替えて固定する。**
 * - **コードを伏せる仕掛けは1つも測っていない**(`V19-M3-T04` = `SV-G7b` の担当)。
 */
import { expect, test } from "@playwright/test";
import { provisionApp } from "./fixture-app.ts";

test.describe("発行した招待が一覧に出る(`V19-M3-T01` / `SV-G2`)", () => {
  test("発行した相手が一覧に現れ、開き直してもコードは1件も出ない", async ({ page, request }) => {
    const app = await provisionApp(request);
    // **既定セッションは `owner`** —— 招待が応答に載るのは持ち主のときだけである。
    await app.authenticate(page.context());
    await page.goto(`/apps/${app.appId}`);
    await page.getByTestId("open-user-admin").click();
    await expect(page.getByTestId("user-admin")).toBeVisible();

    // --- (1) 発行する前は、招待の行が1件も無い -----------------------------------------
    await expect(page.getByTestId("invitation-row")).toHaveCount(0);

    const invited = `invited-${Date.now()}`;
    await page.getByTestId("invite-username").fill(invited);
    await page.getByTestId("invite-role").selectOption("viewer");

    const issuePath = `/api/apps/${app.appId}/auth/invitations`;
    const pending = page.waitForResponse(
      (response) => response.url().endsWith(issuePath) && response.request().method() === "POST",
    );
    await page.getByTestId("invite-submit").click();
    const response = await pending;
    const bodyText = await response.text();
    expect(response.status(), bodyText).toBe(200);
    const payload = JSON.parse(bodyText) as { invitation: { code: string } };
    const code = payload.invitation.code;

    // --- (2) 発行した相手の行が一覧に出る(完了条件 (c))--------------------------------
    const row = page.getByTestId("invitation-row").filter({ hasText: invited });
    await expect(row).toHaveCount(1);
    // **状態はサーバが返した3値のうちの「未使用」である**(画面が時刻から組み立てていない)。
    await expect(row.getByTestId("invitation-row-state")).toHaveText("未使用");

    // --- (3) 開き直しても出たまま(サーバが返した値を並べている)------------------------
    await page.reload();
    await page.getByTestId("open-user-admin").click();
    await expect(page.getByTestId("user-admin")).toBeVisible();
    const reopened = page.getByTestId("invitation-row").filter({ hasText: invited });
    await expect(reopened).toHaveCount(1);

    // --- (4) 一覧にコードが1件も出ない(完了条件 (d))------------------------------------
    // **開き直したので、発行のときにその場に出ていた結果は画面に残っていない。**
    await expect(page.getByTestId("invite-code")).toHaveCount(0);
    // **招待の節の中を数える。**
    await expect(
      page.getByTestId("user-admin-invitations").getByText(code, { exact: false }),
    ).toHaveCount(0);
    // **画面の文字列全体でも1度も現れない**(別経路で出していないことを、丸めずに数える)。
    await expect(page.getByText(code, { exact: false })).toHaveCount(0);
    expect((await page.content()).includes(code)).toBe(false);
  });
});
