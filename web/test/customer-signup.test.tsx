/**
 * ロールの入口(D-G12a / V3-M3-T03)のコンポーネントテスト。
 *
 * 完了条件の正は `docs/plan/v3/records/v3-m3.md` §2 の「V3-M3-T03」節(7点)、審査の正は
 * `docs/plan/v3/records/v3-m3-gate-a-navigation.md` §2(門外 Δ7 / 将来送り → T03)。
 * D-G12a は「顧客サインアップ導線」と「ロール変更 UI の4値化」を**同じ単位**として審査した
 * (同 §2 S1: どちらも『customer というロールに入る/入れる入口』)ので、本ファイルも
 * その2面を1本で持つ。
 *
 * 検証点:
 *   1. **顧客セルフサインアップの導線が画面にある**(D-M3-2 により password と passkey の両方)。
 *   2. 叩き先が**顧客経路**である(`auth/signup/password/register` /
 *      `auth/signup/passkey/register/{options,verify}`)—— 管理経路ではない。
 *   3. **管理登録と顧客登録の区別が画面上で読める**(完了条件2)。
 *   4. 登録が閉じている環境の 403 が、サーバの文面のまま `auth-error` に出る。
 *   5. ロール変更 UI が**4値**を出す(customer を含む)。
 *   6. owner / editor → customer の変更に**確認を挟む**(D-M3-3)。**確認前は PATCH を送らない。**
 *
 * ## このファイルが証明しないこと(先に書く)
 *
 * - **降格を構造で禁じていない。** 確認を押せば PATCH は飛び、サーバは受理する。
 *   6 が証明するのは「警告と確認が画面に出る」ことだけである。
 * - 実 WebAuthn 儀式は happy-dom で動かないので `web/src/auth/passkey.ts` をモックする
 *   (実儀式は `web/e2e/customer-signup.e2e.ts` が chromium の仮想オーセンティケータで通す)。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// 儀式のラッパをモック(実 WebAuthn は E2E で検証する)。
mock.module("../src/auth/passkey.ts", () => ({
  runPasskeyRegistration: async () => ({ id: "reg-cred", type: "public-key", response: {} }),
  runPasskeyLogin: async () => ({ id: "login-cred", type: "public-key", response: {} }),
}));

import type { AppUser, AuthUser } from "../src/api.ts";
import { DEFAULT_USER_KIND_LABEL } from "../src/auth/authz.tsx";
import { LoginPage } from "../src/auth/LoginPage.tsx";
import { UserAdmin } from "../src/auth/UserAdmin.tsx";

const APP_ID = "sample-app";

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
function stub(routes: (url: string, method: string) => Response): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return Promise.resolve(routes(url, method));
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

const CUSTOMER_USER: AuthUser = {
  id: "u9",
  username: "shopper",
  displayName: null,
  role: "customer",
};

describe("顧客サインアップ導線(D-M3-2: password と passkey の両方)", () => {
  test("買い物客向けの登録ボタンが2つとも画面にある", () => {
    render(<LoginPage appId={APP_ID} onAuthenticated={() => {}} />);
    expect(screen.getByTestId("customer-signup")).toBeDefined();
    expect(screen.getByTestId("customer-password-register")).toBeDefined();
    expect(screen.getByTestId("customer-passkey-register")).toBeDefined();
  });

  test("パスワードでの顧客登録は顧客経路を叩き、成功で onAuthenticated(role=customer)", async () => {
    let authenticated: AuthUser | null = null;
    stub(() => jsonResponse({ user: CUSTOMER_USER }));

    render(<LoginPage appId={APP_ID} onAuthenticated={(u) => (authenticated = u)} />);
    fireEvent.change(screen.getByTestId("auth-username"), { target: { value: "shopper" } });
    fireEvent.change(screen.getByTestId("auth-password"), { target: { value: "pw12345" } });
    fireEvent.click(screen.getByTestId("customer-password-register"));

    await waitFor(() => {
      expect(authenticated).toEqual(CUSTOMER_USER);
    });
    const register = calls.find((c) => c.method === "POST");
    // 管理経路(auth/password/register)ではなく顧客経路であること。
    expect(register?.url).toBe(`/api/apps/${APP_ID}/auth/signup/password/register`);
    expect(register?.body).toEqual({ username: "shopper", password: "pw12345" });
  });

  test("Passkey での顧客登録は顧客経路の options → 儀式 → verify を通る", async () => {
    let authenticated: AuthUser | null = null;
    stub((url) =>
      url.endsWith("/verify")
        ? jsonResponse({ user: CUSTOMER_USER })
        : jsonResponse({ challenge: "c", rp: { id: "localhost" } }),
    );

    render(<LoginPage appId={APP_ID} onAuthenticated={(u) => (authenticated = u)} />);
    fireEvent.change(screen.getByTestId("auth-username"), { target: { value: "shopper" } });
    fireEvent.click(screen.getByTestId("customer-passkey-register"));

    await waitFor(() => {
      expect(authenticated).toEqual(CUSTOMER_USER);
    });
    expect(calls.map((c) => c.url)).toEqual([
      `/api/apps/${APP_ID}/auth/signup/passkey/register/options`,
      `/api/apps/${APP_ID}/auth/signup/passkey/register/verify`,
    ]);
  });

  test("登録が閉じている環境の 403 は、サーバの文面のまま auth-error に出る", async () => {
    stub(() =>
      jsonResponse(
        {
          errors: [
            {
              path: "",
              message: "新規登録は許可されていません。",
              // =========================================================================
              // **【2026-08-14。`V8-M5-T04`。`V8-M4` の申し送りをここで直した】**
              // **旧の `hint` の逐語(1バイトも消していない)**:
              // ```
              //   hint: "管理者に ST_AUTH_ALLOW_REGISTRATION を有効化してもらうか、既存アカウントでログインしてください。",
              // ```
              // **なぜ変わったか**: **`V8-M4-T01`(裁定 `M4-1` = `ADR-0335` 限定8)が
              // サーバの文面に「有効な招待があれば、この設定のままでも登録できる」ことを
              // 足した。** **この検査はサーバの文面を**自作の偽応答**で写しているので、
              // サーバが変わっても落ちなかった** —— **旧の文面を写したまま緑であった。**
              // **【この検査が測れないことを、丸めずに書く】** **偽応答を使う限り、
              // ここはサーバの文面のドリフトを1件も捕まえられない。**
              // **サーバの文面そのものは `src/server/registration-default-and-lockout.test.ts`
              // が本物の HTTP で固定している。** **ここが測るのは「サーバが返した
              // `message` / `hint` を、画面が1文字も作り直さずに出すこと」だけである。**
              // =========================================================================
              hint: "管理者に ST_AUTH_ALLOW_REGISTRATION を有効化してもらうか、既存アカウントでログインしてください。有効な招待(運営者から伝えられたログイン名と招待コード)をお持ちの場合は、この設定のままでも登録できます。",
            },
          ],
        },
        403,
      ),
    );
    render(<LoginPage appId={APP_ID} onAuthenticated={() => {}} />);
    fireEvent.change(screen.getByTestId("auth-username"), { target: { value: "shopper" } });
    fireEvent.change(screen.getByTestId("auth-password"), { target: { value: "pw12345" } });
    fireEvent.click(screen.getByTestId("customer-password-register"));

    const region = await screen.findByTestId("auth-error");
    expect(region.textContent).toContain("新規登録は許可されていません");
    expect(region.textContent).toContain("ST_AUTH_ALLOW_REGISTRATION");
    // **【`V8-M5-T04`】足した1行** —— **サーバが足した後半も、画面が1文字も落とさずに出す。**
    expect(region.textContent).toContain("有効な招待");
  });
});

describe("管理登録と顧客登録の区別が画面上で読める(完了条件2)", () => {
  test("どちらの登録が何になるかが、画面の文言に書いてある", () => {
    render(<LoginPage appId={APP_ID} onAuthenticated={() => {}} />);
    const adminNote = screen.getByTestId("admin-signup-note").textContent ?? "";
    const customerNote = screen.getByTestId("customer-signup-note").textContent ?? "";
    // 運営側: 最初の1人がオーナー、以降は閲覧者(ADMIN_SIGNUP の resolveRole そのもの)。
    expect(adminNote).toContain("運営");
    expect(adminNote).toContain("オーナー");
    expect(adminNote).toContain("閲覧者");
    // 顧客側: 常に customer になり、運営の画面は開けない(CUSTOMER_SIGNUP の resolveRole そのもの)。
    //
    // **【`V5-M13` / `G-G4`】表示名が「顧客」から「一般利用者」に変わったので、この2行の
    // 期待値を差し替えた**(`docs/plan/v5/records/v5-m13.md` §5)。**着手前は逐語
    // `expect(customerNote).toContain("買い物");` / `expect(customerNote).toContain("顧客");`
    // だった。** **固定しているもの(「どちらの登録が何になるかが読める」)は1ミリも
    // 弱めていない** —— 業種の語ではなく `ROLE_LABELS` の表示名そのものに当てた。
    expect(customerNote).toContain(DEFAULT_USER_KIND_LABEL);
    expect(customerNote).toContain("運営の画面は開けません");
  });

  /**
   * **【E-G5 / V4-M6 で向きを逆にした】** 着手前はここが「顧客の登録は運営の登録より**後ろ**」
   * (= 既定の導線を運営側に保つ)を固定していた。**その並びが `E-G5` の症状そのものである**
   * —— 店のログイン画面で一番目立つ「新規登録」を押した客が、買い物のできない閲覧者
   * (運営)になり、在庫の増減・決済結果・売上集計だけが読めるアカウントを持ってしまう
   * (02 §5-1 `E-G5`。HTTP 200 / `"role":"viewer"` を実測)。
   */
  test("運営の登録は顧客の登録より後ろに置く(既定の導線を買い物客側にする。E-G5)", () => {
    render(<LoginPage appId={APP_ID} onAuthenticated={() => {}} />);
    const adminRegister = screen.getByTestId("password-register");
    const customerRegister = screen.getByTestId("customer-password-register");
    expect(
      customerRegister.compareDocumentPosition(adminRegister) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  test("ログインの2ボタンは、どちらの登録よりも前にある(E-G5)", () => {
    render(<LoginPage appId={APP_ID} onAuthenticated={() => {}} />);
    const passwordLogin = screen.getByTestId("password-login");
    for (const id of ["customer-password-register", "password-register"]) {
      expect(
        passwordLogin.compareDocumentPosition(screen.getByTestId(id)) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        id,
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }
  });

  test("運営の登録の注記は、押す前に読める位置(運営の登録ボタンより前)にある(E-G5)", () => {
    render(<LoginPage appId={APP_ID} onAuthenticated={() => {}} />);
    const note = screen.getByTestId("admin-signup-note");
    const adminRegister = screen.getByTestId("password-register");
    expect(note.compareDocumentPosition(adminRegister) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});

// --- ロール変更 UI(4値化 + 降格警告)--------------------------------------------------

const OWNER_USER: AppUser = {
  id: "u1",
  username: "alice",
  displayName: null,
  role: "owner",
  createdAt: "2026-01-01",
};
const EDITOR_USER: AppUser = {
  id: "u2",
  username: "bob",
  displayName: "ボブ",
  role: "editor",
  createdAt: "2026-01-02",
};
const VIEWER_USER: AppUser = {
  id: "u3",
  username: "carol",
  displayName: null,
  role: "viewer",
  createdAt: "2026-01-03",
};
const USERS: AppUser[] = [OWNER_USER, EDITOR_USER, VIEWER_USER];

/** ユーザ一覧を返し、PATCH は `patched` の応答を返すスタブ。 */
function stubUsers(patched: (userId: string) => Response): void {
  stub((url, method) => {
    if (method === "PATCH") {
      const userId = url.slice(url.lastIndexOf("/") + 1);
      return patched(userId);
    }
    return jsonResponse({ users: USERS });
  });
}

// -----------------------------------------------------------------------------------------
// **【2026-08-13。`V8-M38`。台帳 `F-G9`。判定値 = 限定採用(門外 `Δ7`)】**
// **describe 名・テスト名・期待値を入れ替えた。** **検査は1本も消していない。**
//
// **旧 describe 名の逐語**: 「ロール変更 UI が4値を出す(完了条件3)」。
// **旧テスト名の逐語**: 「<option> が owner / editor / viewer / customer の4つになる」。
// **旧の本体(逐語)**:
//
//     stubUsers(() => jsonResponse({}, 500));
//     render(<UserAdmin appId={APP_ID} />);
//     await waitFor(() => expect(screen.getAllByTestId("user-row").length).toBe(3));
//     const select = screen.getAllByTestId("role-select")[0] as HTMLSelectElement;
//     expect([...select.options].map((option) => option.value)).toEqual([
//       "owner",
//       "editor",
//       "viewer",
//       "customer",
//     ]);
//
// **`baseRoleValues()` が `customer` を無条件に足すのをやめたので、**役割を1つも
// 宣言していないアプリ**のセレクトは3値になった。**
// **`customer` を宣言したアプリでは今日も4値である** —— **同じ検査の後半で測る。**
// **`D-G12a`(完了条件3)が足した4値目そのものは消していない。宣言が要るようになった。**
// -----------------------------------------------------------------------------------------
describe("ロール変更 UI が出す値(完了条件3。`F-G9` 以降は宣言しだい)", () => {
  test("宣言が無ければ owner / editor / viewer の3つ、`customer` を宣言すれば4つになる", async () => {
    stubUsers(() => jsonResponse({}, 500));
    render(<UserAdmin appId={APP_ID} />);
    await waitFor(() => expect(screen.getAllByTestId("user-row").length).toBe(3));
    const select = screen.getAllByTestId("role-select")[0] as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([
      "owner",
      "editor",
      "viewer",
    ]);
    // **`customer` を宣言したアプリでは、旧の4値がそのまま出る。**
    cleanup();
    stubUsers(() => jsonResponse({}, 500));
    render(<UserAdmin appId={APP_ID} roleIds={["owner", "editor", "viewer", "customer"]} />);
    await waitFor(() => expect(screen.getAllByTestId("user-row").length).toBe(3));
    const declaredSelect = screen.getAllByTestId("role-select")[0] as HTMLSelectElement;
    expect([...declaredSelect.options].map((option) => option.value)).toEqual([
      "owner",
      "editor",
      "viewer",
      "customer",
    ]);
    // **【`V5-M13` / `G-G4`】着手前は逐語 `.toContain("顧客")` だった。** 表示名が
    // 「一般利用者」に変わったので `ROLE_LABELS` から引く形にした。**キー4値は動いていない**
    // ので、上の `option.value` の4値の検査は1バイトも触っていない。
    // **【`V8-M38` / `F-G9`】旧(逐語)**: `expect([...select.options]...` ——
    // **`customer` を宣言した側のセレクトへ引き先を移しただけで、測る中身は同じである。**
    expect([...declaredSelect.options].map((option) => option.textContent)).toContain(
      DEFAULT_USER_KIND_LABEL,
    );
  });
});

describe("降格の事故を UI で警告する(D-M3-3。構造では禁じない)", () => {
  test("editor → customer は確認を挟み、確認するまで PATCH を送らない", async () => {
    stubUsers((userId) => jsonResponse({ user: { ...EDITOR_USER, id: userId, role: "customer" } }));
    render(<UserAdmin appId={APP_ID} />);
    await waitFor(() => expect(screen.getAllByTestId("user-row").length).toBe(3));
    const editorSelect = screen.getAllByTestId("role-select")[1] as HTMLSelectElement;

    fireEvent.change(editorSelect, { target: { value: "customer" } });

    // 警告が出る。運営画面から締め出されることが読める。
    const warning = await screen.findByTestId("role-demotion-warning");
    expect(warning.textContent).toContain("bob");
    expect(warning.textContent).toContain("運営");
    // まだ PATCH は飛んでいない(確認を挟んでいる)。
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    // セレクトの表示も元のまま。
    expect(editorSelect.value).toBe("editor");
  });

  test("確認すると PATCH が飛び、customer になる(構造では禁じていない)", async () => {
    stubUsers((userId) => jsonResponse({ user: { ...EDITOR_USER, id: userId, role: "customer" } }));
    // **【2026-08-13。`V8-M38`。台帳 `F-G9`】旧(逐語)**: `render(<UserAdmin appId={APP_ID} />);`
    // **`customer` を宣言していないアプリではセレクトに `customer` の `<option>` が
    // 無くなったので、選び直したあとの表示(`selects[1]?.value`)を保てない。**
    // **題材を「`customer` を宣言したアプリ」に入れ替えた** —— **測っている中身
    // (確認すると PATCH が飛び、構造では禁じていない)は1ミリも変えていない。**
    render(<UserAdmin appId={APP_ID} roleIds={["owner", "editor", "viewer", "customer"]} />);
    await waitFor(() => expect(screen.getAllByTestId("user-row").length).toBe(3));
    fireEvent.change(screen.getAllByTestId("role-select")[1] as HTMLSelectElement, {
      target: { value: "customer" },
    });
    await screen.findByTestId("role-demotion-warning");

    fireEvent.click(screen.getByTestId("confirm-role-demotion"));

    await waitFor(() => {
      const patched = calls.find((c) => c.method === "PATCH");
      expect(patched?.url).toBe(`/api/apps/${APP_ID}/auth/users/u2`);
      expect(patched?.body).toEqual({ role: "customer" });
    });
    await waitFor(() => {
      const selects = screen.getAllByTestId("role-select") as HTMLSelectElement[];
      expect(selects[1]?.value).toBe("customer");
    });
    // 警告は閉じる。
    expect(screen.queryByTestId("role-demotion-warning")).toBeNull();
  });

  test("やめると PATCH を送らず、ロールは元のまま", async () => {
    stubUsers(() => jsonResponse({}, 500));
    render(<UserAdmin appId={APP_ID} />);
    await waitFor(() => expect(screen.getAllByTestId("user-row").length).toBe(3));
    fireEvent.change(screen.getAllByTestId("role-select")[0] as HTMLSelectElement, {
      target: { value: "customer" },
    });
    await screen.findByTestId("role-demotion-warning");

    fireEvent.click(screen.getByTestId("cancel-role-demotion"));

    await waitFor(() => expect(screen.queryByTestId("role-demotion-warning")).toBeNull());
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    const selects = screen.getAllByTestId("role-select") as HTMLSelectElement[];
    expect(selects[0]?.value).toBe("owner");
  });

  test("owner → customer の警告は、この画面を開ける人が居なくなりうることまで書く", async () => {
    stubUsers(() => jsonResponse({}, 500));
    render(<UserAdmin appId={APP_ID} />);
    await waitFor(() => expect(screen.getAllByTestId("user-row").length).toBe(3));
    fireEvent.change(screen.getAllByTestId("role-select")[0] as HTMLSelectElement, {
      target: { value: "customer" },
    });
    const warning = await screen.findByTestId("role-demotion-warning");
    expect(warning.textContent).toContain("alice");
    expect(warning.textContent).toContain("オーナー");
  });

  test("昇格(viewer → editor)には確認を挟まない(そのまま PATCH)", async () => {
    stubUsers((userId) => jsonResponse({ user: { ...VIEWER_USER, id: userId, role: "editor" } }));
    render(<UserAdmin appId={APP_ID} />);
    await waitFor(() => expect(screen.getAllByTestId("user-row").length).toBe(3));
    fireEvent.change(screen.getAllByTestId("role-select")[2] as HTMLSelectElement, {
      target: { value: "editor" },
    });

    await waitFor(() => {
      const patched = calls.find((c) => c.method === "PATCH");
      expect(patched?.url).toBe(`/api/apps/${APP_ID}/auth/users/u3`);
    });
    expect(screen.queryByTestId("role-demotion-warning")).toBeNull();
  });
});
