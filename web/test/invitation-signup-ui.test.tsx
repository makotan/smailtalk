/**
 * **同梱UIの登録画面を招待に対応させる**(`V8-M5-T04`。台帳 `I-G8`(却下)/ `I-G27`(却下)。
 * **ユーザ決定 `D-V8-112` により実施する** / `D-V8-114`)。
 *
 * ## この検査が固定するもの(**先に書く**)
 *
 * 1. **`GET /api/apps/:app_id/public` の `signup` を見て欄を出し分けること** ——
 *    **招待コードの欄は「そのアプリが招待を要求しうるとき」だけ、立場を選ぶ欄は
 *    「名乗れる立場が2つ以上あるとき」だけ出す**(裁定 `M5-3`)。
 * 2. **登録の送信本文に `user_kind` と `invitation_code` が乗ること**(`I-G8`)——
 *    **着手前は `{username}` / `{username,password}` だけであった**(実測: 着手前の
 *    `LC_ALL=C /usr/bin/grep -c -e user_kind -e invitation_code web/src/api.ts` = **0**)。
 * 3. **passkey は `options` と `verify` の**両方**に招待コードが乗ること** ——
 *    **サーバの `options` は「有効な招待を引けたときだけ 409 / 403 を飛ばす」逃がしを
 *    持っており**(`src/server/auth-routes.ts` の passkey register options)、
 *    **`verify` は名乗りと招待の両方を読む。** **片方だけでは招待された人が登録できない。**
 * 4. **運営(管理者)の登録には `user_kind` を1バイトも乗せないこと** ——
 *    **サーバはこの口で名乗りを1度も読まず、値が不正なら `422` になる。**
 *
 * ## この検査が測らないもの(**誇張しない**)
 *
 * - **サーバが同じ判定を持つことは、ここでは1つも測っていない**(`src/server/` の検査の担当)。
 *   **【禁止】「画面に欄が出ない」を制限の担保にしない** —— **サーバが本体である。**
 * - **実 WebAuthn 儀式は happy-dom で動かないのでモックする**(実儀式は
 *   `web/e2e/invitation-signup.e2e.ts` が chromium の仮想オーセンティケータで通す)。
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

mock.module("../src/auth/passkey.ts", () => ({
  runPasskeyRegistration: async () => ({ id: "reg-cred", type: "public-key", response: {} }),
  runPasskeyLogin: async () => ({ id: "login-cred", type: "public-key", response: {} }),
}));

import type { AuthUser, SignupFacts } from "../src/api.ts";
import { LoginPage } from "../src/auth/LoginPage.tsx";

const APP_ID = "sample-app";

type Call = { url: string; method: string; body: Record<string, unknown> | undefined };

let calls: Call[];
let originalFetch: typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stub(routes: (url: string) => Response): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined,
    });
    return Promise.resolve(routes(url));
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const USER: AuthUser = { id: "u1", username: "shopper", displayName: null, role: "customer" };

/** 招待制のアプリ(`staff` が招待制 / 運営が人を足す口も招待制)。 */
const INVITE_FACTS: SignupFacts = {
  kinds: [
    { id: "member", name: "会員", invite: false },
    { id: "staff", name: "スタッフ", invite: true },
  ],
  adminInvite: true,
};

/** 何も宣言していないアプリ(名乗れるのは既定の1つだけ / 招待は1つも要らない)。 */
const OPEN_FACTS: SignupFacts = {
  kinds: [{ id: "customer", name: "customer", invite: false }],
  adminInvite: false,
};

// --- (1) 欄の出し分け ------------------------------------------------------------------

test("(1-a) `signup` を渡さなければ、招待コードの欄も立場の欄も出ない(着手前と同じ画面)", () => {
  render(<LoginPage appId={APP_ID} onAuthenticated={() => {}} />);
  expect(screen.queryByTestId("auth-invitation-code")).toBeNull();
  expect(screen.queryByTestId("auth-user-kind")).toBeNull();
});

test("(1-b) 招待を1つも要求しないアプリでは、招待コードの欄も立場の欄も出ない", () => {
  render(<LoginPage appId={APP_ID} signup={OPEN_FACTS} onAuthenticated={() => {}} />);
  expect(screen.queryByTestId("auth-invitation-code")).toBeNull();
  // **立場が1つしか無ければ選ばせる意味が1つも無い**(裁定 `M5-3`)。
  expect(screen.queryByTestId("auth-user-kind")).toBeNull();
});

test("(1-c) 招待を要求しうるアプリでは、招待コードの欄と立場を選ぶ欄が出る", () => {
  render(<LoginPage appId={APP_ID} signup={INVITE_FACTS} onAuthenticated={() => {}} />);
  expect(screen.getByTestId("auth-invitation-code")).toBeDefined();
  const select = screen.getByTestId("auth-user-kind") as HTMLSelectElement;
  // **値域はサーバが返したものそのままである** —— **画面が組み直していない。**
  expect([...select.options].map((option) => option.value)).toEqual(["member", "staff"]);
  // **表示名はサーバが返したものをそのまま出す**(`D-V8-79` により宣言が無ければ識別子)。
  expect([...select.options].map((option) => option.textContent)).toEqual([
    "会員",
    "スタッフ(招待コードが要ります)",
  ]);
});

// --- (2) セルフ登録の送信本文 -----------------------------------------------------------

test("(2-a) パスワードのセルフ登録に `user_kind` と `invitation_code` が乗る", async () => {
  stub(() => jsonResponse({ user: USER }));
  render(<LoginPage appId={APP_ID} signup={INVITE_FACTS} onAuthenticated={() => {}} />);
  fireEvent.change(screen.getByTestId("auth-username"), { target: { value: "shopper" } });
  fireEvent.change(screen.getByTestId("auth-password"), { target: { value: "pw12345" } });
  fireEvent.change(screen.getByTestId("auth-user-kind"), { target: { value: "staff" } });
  fireEvent.change(screen.getByTestId("auth-invitation-code"), { target: { value: "ABCD2345" } });
  fireEvent.click(screen.getByTestId("customer-password-register"));

  await waitFor(() => {
    expect(calls.length).toBe(1);
  });
  expect(calls[0]?.url).toBe(`/api/apps/${APP_ID}/auth/signup/password/register`);
  expect(calls[0]?.body).toEqual({
    username: "shopper",
    password: "pw12345",
    user_kind: "staff",
    invitation_code: "ABCD2345",
  });
});

test("(2-b) 空欄のキーは1つも送らない(着手前の本文と1バイト違わない)", async () => {
  stub(() => jsonResponse({ user: USER }));
  render(<LoginPage appId={APP_ID} signup={OPEN_FACTS} onAuthenticated={() => {}} />);
  fireEvent.change(screen.getByTestId("auth-username"), { target: { value: "shopper" } });
  fireEvent.change(screen.getByTestId("auth-password"), { target: { value: "pw12345" } });
  fireEvent.click(screen.getByTestId("customer-password-register"));

  await waitFor(() => {
    expect(calls.length).toBe(1);
  });
  expect(calls[0]?.body).toEqual({ username: "shopper", password: "pw12345" });
});

// --- (3) passkey は options と verify の両方に乗せる -------------------------------------

test("(3) passkey のセルフ登録は options と verify の両方に招待コードを乗せる", async () => {
  stub((url) =>
    url.endsWith("/verify")
      ? jsonResponse({ user: USER })
      : jsonResponse({ challenge: "c", rp: { id: "localhost" } }),
  );
  render(<LoginPage appId={APP_ID} signup={INVITE_FACTS} onAuthenticated={() => {}} />);
  fireEvent.change(screen.getByTestId("auth-username"), { target: { value: "shopper" } });
  fireEvent.change(screen.getByTestId("auth-user-kind"), { target: { value: "staff" } });
  fireEvent.change(screen.getByTestId("auth-invitation-code"), { target: { value: "ABCD2345" } });
  fireEvent.click(screen.getByTestId("customer-passkey-register"));

  await waitFor(() => {
    expect(calls.length).toBe(2);
  });
  expect(calls.map((call) => call.url)).toEqual([
    `/api/apps/${APP_ID}/auth/signup/passkey/register/options`,
    `/api/apps/${APP_ID}/auth/signup/passkey/register/verify`,
  ]);
  // **`options` は招待コードを読む**(サーバはこれで 409 / 403 を飛ばす)。
  expect(calls[0]?.body).toEqual({
    username: "shopper",
    user_kind: "staff",
    invitation_code: "ABCD2345",
  });
  // **`verify` は名乗りと招待の両方を読む。**
  expect(calls[1]?.body).toMatchObject({ user_kind: "staff", invitation_code: "ABCD2345" });
});

// --- (4) 運営(管理者)の登録には名乗りを乗せない -----------------------------------------

test("(4) 運営の登録は招待コードだけを乗せ、`user_kind` を1バイトも乗せない", async () => {
  stub(() => jsonResponse({ user: USER }));
  render(<LoginPage appId={APP_ID} signup={INVITE_FACTS} onAuthenticated={() => {}} />);
  fireEvent.change(screen.getByTestId("auth-username"), { target: { value: "boss" } });
  fireEvent.change(screen.getByTestId("auth-password"), { target: { value: "pw12345" } });
  fireEvent.change(screen.getByTestId("auth-invitation-code"), { target: { value: "ABCD2345" } });
  fireEvent.click(screen.getByTestId("password-register"));

  await waitFor(() => {
    expect(calls.length).toBe(1);
  });
  expect(calls[0]?.url).toBe(`/api/apps/${APP_ID}/auth/password/register`);
  // **`user_kind` を送るとサーバは `422` を返す** —— **この口は名乗りを1度も読まない。**
  expect(calls[0]?.body).toEqual({
    username: "boss",
    password: "pw12345",
    invitation_code: "ABCD2345",
  });
});
