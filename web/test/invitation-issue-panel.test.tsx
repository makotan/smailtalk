/**
 * **運営者が画面から招待を発行できることの固定**(`V19-M3-T00`。台帳 `SV-G1`)。
 *
 * ## この検査が固定するもの(**先に書く**)
 *
 * 1. **ユーザ管理の画面に発行の口が在る** —— 相手の名前を入れる欄 / 立場を選ぶ欄 / 発行のボタン。
 *    **着手前はこの3つが1つも無かった**(実測: 着手前の
 *    `LC_ALL=C /usr/bin/grep -ic 'invitation\|招待' web/src/auth/UserAdmin.tsx` = **0**)。
 * 2. **発行が既存の口を叩く** —— `POST /api/apps/:app_id/auth/invitations`。
 *    **新しい口を1本も足していない**(`SV-G1` の個別限定①)。**送る本文は `username` と
 *    `role` の2つだけである** —— **サーバは未知のキーを 400 で拒む**(`INVITATION_KEYS`)。
 * 3. **発行のあと、コードと登録リンクがその場に出る**(起票の完了条件 (b))。
 * 4. **登録リンクはサーバが返したときだけ出す** —— **サーバは組み立てられないとき
 *    `signupUrl` を載せない**(`signupUrlFor` が `undefined` を返す場合)。
 *    **黙って壊れたリンクを画面で作らない。**
 * 5. **失敗はサーバの文面をそのまま出す**(フロントで作り直さない。既存の
 *    ロール変更の失敗と同じ作法)。
 * 6. **行のロール変更セレクトの個数を1つも増やしていない** ——
 *    `web/test/user-admin-user-id.test.tsx` と `web/test/customer-signup.test.tsx` が
 *    **添字で行を特定している**ため、発行の欄が同じ目印を持つと、あちらが黙って別の行を指す。
 *
 * ## この検査が測らないもの(**誇張しない**)
 *
 * - **サーバが同じ判定を持つことは、ここでは1つも測っていない**(`src/server/` の検査の担当)。
 *   **【禁止】「画面に欄が出る」ことを、発行できる人の範囲の担保にしない** ——
 *   **範囲を守るのはサーバの `requireOwner` である。**
 * - **ブラウザで実際に撃ったことは、ここでは1つも測っていない**
 *   (`web/e2e/invitation-issue.e2e.ts` の担当。起票の完了条件 (c))。
 * - **一覧 / 出し直し / 取り消し / 3状態の見分けは1つも測っていない**
 *   (`V19-M3-T01` / `T02` / `T03` の担当)。
 * - **コードを伏せる側は1つも測っていない**(`SV-G7b` = `V19-M3-T04` の担当)。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AppUser } from "../src/api.ts";
import { UserAdmin } from "../src/auth/UserAdmin.tsx";

const APP_ID = "sample-app";
const USERS_URL = `/api/apps/${APP_ID}/auth/users`;
const ISSUE_URL = `/api/apps/${APP_ID}/auth/invitations`;

type Call = { url: string; method: string; body: Record<string, unknown> | undefined };

const OWNER: AppUser = {
  id: "u1",
  username: "boss",
  displayName: null,
  role: "owner",
  createdAt: "2026-09-18T00:00:00.000Z",
};

/** サーバが返す発行の応答(`issuedInvitationView` + 登録リンク)。 */
const ISSUED = {
  invitation: {
    username: "newcomer",
    role: "viewer",
    expiresAt: "2026-09-19T00:00:00.000Z",
    issuedBy: "u1",
    issuedAt: "2026-09-18T00:00:00.000Z",
    usedAt: null,
    state: "unused",
    code: "WXYZ6789",
  },
  signupUrl: `http://localhost:3210/apps/${APP_ID}`,
};

let calls: Call[];
let originalFetch: typeof fetch;
/** URL ごとの差し替え応答(`[status, body]`)。 */
let responses: Map<string, [number, unknown]>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  calls = [];
  responses = new Map();
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined,
    });
    const stubbed = responses.get(`${method} ${url}`);
    if (stubbed !== undefined) {
      return Promise.resolve(jsonResponse(stubbed[1], stubbed[0]));
    }
    if (method === "GET" && url === USERS_URL) {
      return Promise.resolve(jsonResponse({ users: [OWNER] }));
    }
    return Promise.resolve(jsonResponse({ errors: [] }, 500));
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

/** 一覧の取得が終わった状態の画面を起こす(以降の操作はここから始める)。 */
async function renderReady(): Promise<void> {
  render(<UserAdmin appId={APP_ID} />);
  await screen.findByTestId("user-admin-invite");
}

/** 相手と立場を埋めて発行を押す。 */
function fillAndSubmit(username = "newcomer", role = "viewer"): void {
  fireEvent.change(screen.getByTestId("invite-username"), { target: { value: username } });
  fireEvent.change(screen.getByTestId("invite-role"), { target: { value: role } });
  fireEvent.click(screen.getByTestId("invite-submit"));
}

// --- (1) 発行の口が画面に在る ------------------------------------------------------------

test("(1-a) ユーザ管理の画面に、相手の名前・立場・発行のボタンが在る", async () => {
  await renderReady();
  expect(screen.getByTestId("invite-username")).toBeDefined();
  expect(screen.getByTestId("invite-role")).toBeDefined();
  expect(screen.getByTestId("invite-submit")).toBeDefined();
});

test("(1-b) 発行する前は、コードも登録リンクも画面に1件も出ていない", async () => {
  await renderReady();
  expect(screen.queryByTestId("invite-code")).toBeNull();
  expect(screen.queryByTestId("invite-signup-url")).toBeNull();
});

test("(1-c) 立場の選択肢は、行のロール変更セレクトと同じ土台から並ぶ", async () => {
  await renderReady();
  const select = screen.getByTestId("invite-role") as HTMLSelectElement;
  expect([...select.options].map((option) => option.value)).toEqual(["owner", "editor", "viewer"]);
});

// --- (2) 発行は既存の口を叩く -------------------------------------------------------------

test("(2-a) 発行は既存の口を叩き、本文は相手と立場の2つだけである", async () => {
  responses.set(`POST ${ISSUE_URL}`, [200, ISSUED]);
  await renderReady();
  fillAndSubmit("newcomer", "viewer");

  await waitFor(() => {
    expect(calls.filter((call) => call.method === "POST").length).toBe(1);
  });
  const posted = calls.find((call) => call.method === "POST");
  expect(posted?.url).toBe(ISSUE_URL);
  // **サーバは未知のキーを 400 で拒む** —— 期限のキーを1つも乗せない。
  expect(posted?.body).toEqual({ username: "newcomer", role: "viewer" });
});

// --- (3) 発行のあとコードと登録リンクが出る ------------------------------------------------

test("(3-a) 発行のあと、コードが画面に逐語で出る", async () => {
  responses.set(`POST ${ISSUE_URL}`, [200, ISSUED]);
  await renderReady();
  fillAndSubmit();

  const shown = await screen.findByTestId("invite-code");
  expect(shown.textContent).toBe("WXYZ6789");
});

test("(3-b) 発行のあと、登録リンクが画面に逐語で出る", async () => {
  responses.set(`POST ${ISSUE_URL}`, [200, ISSUED]);
  await renderReady();
  fillAndSubmit();

  const link = await screen.findByTestId("invite-signup-url");
  expect(link.textContent).toBe(`http://localhost:3210/apps/${APP_ID}`);
  expect(link.getAttribute("href")).toBe(`http://localhost:3210/apps/${APP_ID}`);
});

test("(3-c) サーバが登録リンクを載せなかったら、リンクを出さずコードだけを出す", async () => {
  responses.set(`POST ${ISSUE_URL}`, [200, { invitation: ISSUED.invitation }]);
  await renderReady();
  fillAndSubmit();

  const shown = await screen.findByTestId("invite-code");
  expect(shown.textContent).toBe("WXYZ6789");
  // **組み立てられないリンクを画面で作らない**(黙って壊れたリンクを出さない)。
  expect(screen.queryByTestId("invite-signup-url")).toBeNull();
});

// --- (4) 失敗はサーバの文面をそのまま出す ---------------------------------------------------

test("(4-a) 発行が拒まれたら、サーバの文面がそのまま画面に出る", async () => {
  responses.set(`POST ${ISSUE_URL}`, [
    400,
    { errors: [{ path: "/username", message: "招く相手のログイン名を指定してください。" }] },
  ]);
  await renderReady();
  fillAndSubmit("", "viewer");

  const shown = await screen.findByTestId("invite-error");
  expect(shown.textContent).toContain("招く相手のログイン名を指定してください。");
  // **失敗したのだから、コードも登録リンクも出ない。**
  expect(screen.queryByTestId("invite-code")).toBeNull();
  expect(screen.queryByTestId("invite-signup-url")).toBeNull();
});

// --- (5) 既存の検査を壊さない -------------------------------------------------------------

test("(5-a) 行を指す目印の個数は利用者の人数のままである(添字で行を指す検査を壊さない)", async () => {
  await renderReady();
  expect(screen.getAllByTestId("role-select").length).toBe(1);
});
