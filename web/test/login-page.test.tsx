/**
 * ログイン画面(LoginPage)のコンポーネントテスト(V1-M3-T01 / ADR-0014 改訂 = per-app)。
 *
 * 認証はアプリ単位なので、LoginPage は `appId` を受け取り、**そのアプリ配下の
 * 認証エンドポイント(`/api/apps/:appId/auth/*`)**を叩く。検証点:
 *   1. Passkey ボタンを **password ボタンより先に**(優先)提示する
 *   2. password ログインのフォーム送信で `passwordLogin(appId,...)` が呼ばれ、成功で onAuthenticated
 *   3. 409(username 重複)/ 401(不一致)をサーバの日本語文面で `auth-error` に表示
 *   4. Passkey ログインの配線(per-app options → 儀式 → verify → onAuthenticated)
 *   5. `appName` を渡すと「〈アプリ名〉にログイン」の見出しが出る
 *
 * 実 WebAuthn 儀式(`navigator.credentials`)は happy-dom で動かないので、
 * `web/src/auth/passkey.ts` をモックする(実儀式の検証は E2E に委譲)。fetch は既存作法で
 * スタブする。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// 儀式のラッパをモック(実 WebAuthn は E2E で検証する)。
mock.module("../src/auth/passkey.ts", () => ({
  runPasskeyRegistration: async () => ({ id: "reg-cred", type: "public-key", response: {} }),
  runPasskeyLogin: async () => ({ id: "login-cred", type: "public-key", response: {} }),
}));

import type { AuthUser } from "../src/api.ts";
import { LoginPage } from "../src/auth/LoginPage.tsx";

type Call = { url: string; method: string; body: unknown };

let calls: Call[];
let originalFetch: typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** url → 応答を返すルーティング型スタブ。呼び出しは `calls` に記録する。 */
function stub(routes: (url: string) => Response): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
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

const SAMPLE_USER: AuthUser = { id: "u1", username: "alice", displayName: null, role: "owner" };
const APP_ID = "sample-app";

describe("提示順(Passkey 優先)", () => {
  test("Passkey ボタンが password ボタンより先に現れる", () => {
    render(<LoginPage appId={APP_ID} onAuthenticated={() => {}} />);
    // 4つのボタンはすべて存在する。
    for (const id of ["passkey-login", "passkey-register", "password-login", "password-register"]) {
      expect(screen.getByTestId(id)).toBeDefined();
    }
    const passkeyLogin = screen.getByTestId("passkey-login");
    const passwordLogin = screen.getByTestId("password-login");
    // DOM 順で passwordLogin は passkeyLogin より後ろ(Passkey 優先提示)。
    expect(
      passkeyLogin.compareDocumentPosition(passwordLogin) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  /**
   * V3-M3-T03(D-G12a): 顧客セルフサインアップの2ボタンが**運営の4ボタンの後ろに**増えた。
   *
   * **【E-G5 / V4-M6 で並びを変えた】** ログイン2本 → 買い物客の登録2本 → 運営の登録2本。
   * **ボタンは6つのままで、`data-testid` は1つも増減していない**(この画面の `data-testid` は
   * E2E が使う確定版であり増減させない、という LoginPage.tsx ヘッダの規律)。**Passkey 優先は
   * 3つの塊それぞれの中で保たれている。**
   */
  test("ボタン構成は6つで、順序が固定されている(ログイン2 → 顧客2 → 運営2。E-G5)", () => {
    const { container } = render(<LoginPage appId={APP_ID} onAuthenticated={() => {}} />);
    const order = [...container.querySelectorAll("button[data-testid]")].map((button) =>
      button.getAttribute("data-testid"),
    );
    expect(order).toEqual([
      "passkey-login",
      "password-login",
      "customer-passkey-register",
      "customer-password-register",
      "passkey-register",
      "password-register",
    ]);
  });
});

describe("password ログイン", () => {
  test("フォーム送信で passwordLogin(appId,...) が呼ばれ、成功で onAuthenticated", async () => {
    let authenticated: AuthUser | null = null;
    stub(() => jsonResponse({ user: SAMPLE_USER }));

    const { container } = render(
      <LoginPage appId={APP_ID} onAuthenticated={(u) => (authenticated = u)} />,
    );
    fireEvent.change(screen.getByTestId("auth-username"), { target: { value: "alice" } });
    fireEvent.change(screen.getByTestId("auth-password"), { target: { value: "pw12345" } });
    const form = container.querySelector("form");
    if (form === null) {
      throw new Error("form が見つからない");
    }
    fireEvent.submit(form);

    await waitFor(() => {
      expect(authenticated).toEqual(SAMPLE_USER);
    });
    // per-app のエンドポイント(パスに appId が入る)を叩く。
    const login = calls.find((c) => c.url === `/api/apps/${APP_ID}/auth/password/login`);
    expect(login?.method).toBe("POST");
    expect(login?.body).toEqual({ username: "alice", password: "pw12345" });
  });

  test("401(不一致)はサーバ文面を auth-error に表示する", async () => {
    stub(() =>
      jsonResponse(
        { errors: [{ path: "", message: "username またはパスワードが正しくありません。" }] },
        401,
      ),
    );
    render(<LoginPage appId={APP_ID} onAuthenticated={() => {}} />);
    fireEvent.submit(screen.getByTestId("password-login").closest("form") as HTMLFormElement);

    const region = await screen.findByTestId("auth-error");
    expect(region.textContent).toContain("正しくありません");
  });
});

describe("新規登録", () => {
  test("409(username 重複)を auth-error に表示する", async () => {
    stub(() =>
      jsonResponse(
        { errors: [{ path: "/username", message: 'ユーザ名 "alice" は既に使われています。' }] },
        409,
      ),
    );
    render(<LoginPage appId={APP_ID} onAuthenticated={() => {}} />);
    fireEvent.change(screen.getByTestId("auth-username"), { target: { value: "alice" } });
    fireEvent.change(screen.getByTestId("auth-password"), { target: { value: "pw12345" } });
    fireEvent.click(screen.getByTestId("password-register"));

    const region = await screen.findByTestId("auth-error");
    expect(region.textContent).toContain("既に使われています");
  });
});

describe("Passkey ログイン(配線)", () => {
  test("options → 儀式 → verify を通り、成功で onAuthenticated", async () => {
    let authenticated: AuthUser | null = null;
    stub((url) => {
      if (url.endsWith("/verify")) {
        return jsonResponse({ user: SAMPLE_USER });
      }
      // options はダミーの JSON を返す(儀式はモック済み)。
      return jsonResponse({ challenge: "c", rpId: "localhost" });
    });

    render(<LoginPage appId={APP_ID} onAuthenticated={(u) => (authenticated = u)} />);
    fireEvent.change(screen.getByTestId("auth-username"), { target: { value: "alice" } });
    fireEvent.click(screen.getByTestId("passkey-login"));

    await waitFor(() => {
      expect(authenticated).toEqual(SAMPLE_USER);
    });
    expect(calls.map((c) => c.url)).toEqual([
      `/api/apps/${APP_ID}/auth/passkey/login/options`,
      `/api/apps/${APP_ID}/auth/passkey/login/verify`,
    ]);
  });
});

describe("見出し(アプリ名)", () => {
  test("appName を渡すと「〈アプリ名〉にログイン」の見出しが出る", () => {
    render(<LoginPage appId={APP_ID} appName="サンプル" onAuthenticated={() => {}} />);
    expect(screen.getByTestId("login-page").textContent).toContain("サンプルにログイン");
  });

  test("appName が無ければ既定の「ログイン」見出し", () => {
    render(<LoginPage appId={APP_ID} onAuthenticated={() => {}} />);
    const heading = screen.getByTestId("login-page").querySelector("h1");
    expect(heading?.textContent).toBe("ログイン");
  });
});
