/**
 * **招待の行から「出し直し」と「取り消し」を本物のサーバに撃つことの実証**
 * (`V19-M3-T02`。台帳 `SV-G3` / `SV-G4`)。
 *
 * ## **なぜこの1本が要るのか**(**起票の完了条件 (a) / (b)**)
 *
 * **着手前、出し直しも取り消しも HTTP の口は在ったが、画面から押せるものが1つも無かった。**
 * **`web/test/invitation-actions-panel.test.tsx` は応答を差し替えて画面の側だけを見ている**
 * (同ファイルの冒頭が自分でそう書いている)。
 * **本ファイルは実際にブラウザを起こし、本物のサーバに向かって2つのボタンを押す。**
 *
 * **【罠9 の履行】このアプリは SPA なので、画面が変わっても HTTP の応答本文は同一である。**
 * **「ボタンが画面に在る」を `curl` や応答本文の diff で示すことはできない。**
 * **だからここはブラウザである。**
 *
 * ## 検証点(**5つ**)
 *
 * 1. **発行した直後の行には、2つのボタンが両方出る**(未使用)。
 * 2. **「取り消す」を押すと、一覧の状態が「未使用」→「取り消し済み」に変わる**(完了条件 (b))。
 * 3. **取り消したあと、その行から「取り消す」が消える**(`H-V19-5` を踏まない設計)——
 *    **行そのものは1行も消えない**(`ADR-0336` 限定16)。
 * 4. **「出し直す」を押すと、新しいコードがその場に出る**(完了条件 (a))——
 *    **前のコードとは違う文字列である。**
 * 5. **【隠さない】出し直すと、取り消した事実が消える**(計画の上乗せ1 / 罠23 / `H-V19-1`)
 *    —— **状態が「取り消し済み」→「未使用」に戻る。** **本ファイルはこれを塞がず、撃って示す。**
 *
 * ## ここで証明していないこと(**誇張しない。先に書く**)
 *
 * - **使用済みの招待に出し直しを撃ってはいない** —— **画面がそのボタンを出さないからである。**
 *   **サーバがそれを受理するかどうかは1度も撃っていない。**
 * - **取り消しが黙って効かない場合**(`H-V19-5`)**は1度も撃っていない** ——
 *   **画面が使用済み・取り消し済みの行に「取り消す」を出さないので、この台では踏めない。**
 *   **サーバ側の穴は塞がっていない**(計画 `§9-B-6`。**v19 の中に塞ぐ段は無い**)。
 * - **押し間違いを止める確認は1つも撃っていない** —— **そういう仕掛けが無いからである。**
 * - **誰が出し直せるか / 取り消せるかの範囲は1つも測っていない** ——
 *   **この台の既定セッションは `owner` である。** **範囲を決めるのはサーバである。**
 *
 * ## **(c) の貼り付けの出どころ**
 *
 * **起票の完了条件 (c)(操作前と操作後の一覧の状態を記録に貼る)は、本ファイルが
 * `console.log` で出す4枚を写したものである。** **印字は判定ではない**
 * (既知の罠: **印字するだけの数は見張りではない**)—— **判定は下の `expect` が行う。**
 */
import { expect, test } from "@playwright/test";
import { provisionApp } from "./fixture-app.ts";

test.describe("招待の行から出し直しと取り消しを撃つ(`V19-M3-T02` / `SV-G3` / `SV-G4`)", () => {
  test("取り消すと状態が変わり、出し直すと新しいコードが出て、取り消した事実が消える", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    // **既定セッションは `owner`** —— 招待が応答に載るのは持ち主のときだけである。
    await app.authenticate(page.context());
    await page.goto(`/apps/${app.appId}`);
    await page.getByTestId("open-user-admin").click();
    await expect(page.getByTestId("user-admin")).toBeVisible();

    const invitations = page.getByTestId("user-admin-invitations");
    const issuePath = `/api/apps/${app.appId}/auth/invitations`;

    // --- 発行する(本段が足したのは操作であって、発行の口ではない)------------------------
    const invited = `invited-${Date.now()}`;
    await page.getByTestId("invite-username").fill(invited);
    await page.getByTestId("invite-role").selectOption("viewer");
    const issuing = page.waitForResponse(
      (response) => response.url().endsWith(issuePath) && response.request().method() === "POST",
    );
    await page.getByTestId("invite-submit").click();
    const issued = await issuing;
    const issuedText = await issued.text();
    expect(issued.status(), issuedText).toBe(200);
    const firstCode = (JSON.parse(issuedText) as { invitation: { code: string } }).invitation.code;

    const row = invitations.locator(`[data-testid="invitation-row"][data-username="${invited}"]`);
    await expect(row).toHaveCount(1);

    /** 一覧の状態を文字で写す(**(c) の貼り付けの素**)。 */
    const snapshot = async (label: string): Promise<string> => {
      const rows = await invitations.getByTestId("invitation-row").all();
      const lines: string[] = [];
      for (const each of rows) {
        const username = await each.getAttribute("data-username");
        const state = await each.getByTestId("invitation-row-state").textContent();
        const reissue = await each.getByTestId("invitation-row-reissue").count();
        const revoke = await each.getByTestId("invitation-row-revoke").count();
        lines.push(
          `  ${username} | 状態=${state} | 出し直す=${reissue === 1 ? "在る" : "無い"} | 取り消す=${revoke === 1 ? "在る" : "無い"}`,
        );
      }
      const code = await page.getByTestId("invite-code").count();
      lines.push(
        `  (発行の結果欄のコード: ${code === 1 ? await page.getByTestId("invite-code").textContent() : "出ていない"})`,
      );
      const text = `[invitation-actions] ${label}\n${lines.join("\n")}`;
      console.log(text);
      return text;
    };

    // --- (1) 発行した直後の行には2つのボタンが両方出る -----------------------------------
    await expect(row.getByTestId("invitation-row-state")).toHaveText("未使用");
    await expect(row.getByTestId("invitation-row-reissue")).toHaveCount(1);
    await expect(row.getByTestId("invitation-row-revoke")).toHaveCount(1);

    // --- (c) 取り消しの操作前 -------------------------------------------------------------
    await snapshot("取り消しの操作前");

    // --- (2) 取り消すと状態が変わる(完了条件 (b))----------------------------------------
    const revoking = page.waitForResponse(
      (response) => response.url().endsWith(issuePath) && response.request().method() === "POST",
    );
    await row.getByTestId("invitation-row-revoke").click();
    const revoked = await revoking;
    expect(revoked.status(), await revoked.text()).toBe(200);
    // **`DELETE` を1本も使っていない** —— **同じ口に `POST` で `revoke` を送っている。**
    expect(revoked.request().method()).toBe("POST");
    expect(JSON.parse(revoked.request().postData() ?? "{}")).toEqual({
      username: invited,
      revoke: true,
    });
    await expect(row.getByTestId("invitation-row-state")).toHaveText("取り消し済み");

    // --- (3) 取り消したあと「取り消す」が消える。行は消えない ----------------------------
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId("invitation-row-revoke")).toHaveCount(0);
    await expect(row.getByTestId("invitation-row-reissue")).toHaveCount(1);

    // --- (c) 取り消しの操作後 = 出し直しの操作前 ------------------------------------------
    await snapshot("取り消しの操作後(= 出し直しの操作前)");

    // --- (4) 出し直すと新しいコードがその場に出る(完了条件 (a))--------------------------
    const reissuing = page.waitForResponse(
      (response) => response.url().endsWith(issuePath) && response.request().method() === "POST",
    );
    await row.getByTestId("invitation-row-reissue").click();
    const reissued = await reissuing;
    const reissuedText = await reissued.text();
    expect(reissued.status(), reissuedText).toBe(200);
    const secondCode = (JSON.parse(reissuedText) as { invitation: { code: string } }).invitation
      .code;
    // **新しいコードである** —— **同じ文字列なら「出し直した」と言えない。**
    expect(secondCode).not.toBe(firstCode);
    // **その場に出る**(発行の結果欄。**コードの出どころは今日も1箇所である**)。
    await expect(page.getByTestId("invite-code")).toHaveText(secondCode);

    // --- (5) 【隠さない】出し直すと取り消した事実が消える(上乗せ1 / 罠23)---------------
    await expect(row.getByTestId("invitation-row-state")).toHaveText("未使用");
    await expect(row.getByTestId("invitation-row-revoke")).toHaveCount(1);

    // --- (c) 出し直しの操作後 -------------------------------------------------------------
    await snapshot("出し直しの操作後");

    // --- 一覧の側にコードが1文字も出ていない(`ADR-0452` ⑮ を本段が破っていない)---------
    await expect(invitations.getByText(secondCode, { exact: false })).toHaveCount(0);
    await expect(invitations.getByText(firstCode, { exact: false })).toHaveCount(0);
  });
});
