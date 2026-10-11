/**
 * **ログアウトした後のログイン画面にも、招待コードの欄が出る**(`V22-M1`。計画
 * `docs/plan/v22/00-v22-plan.md` の「V22-M1 ログアウト後のログイン画面」)。
 *
 * ## 直す前に起きていたこと(2026-09-27 に読んで確かめた)
 *
 * - 作業画面(`web/src/AppWorkspace.tsx`)と配る版(`web/src/runner-app.tsx`)は、
 *   マウント時に `GET /manifest` を取り、401 のときだけ `GET /public` を取る。
 * - ログアウト(`useAppAuth` の `signOut`)は状態を `anonymous` にするだけで、定義も
 *   `GET /public` も取り直さない。
 * - そのため、ログアウト後は「ログイン中に取った定義 + 未ログイン」の分岐に入り、そこの
 *   `LoginPage` に `signup` が渡らない —— **招待コードの欄(`auth-invitation-code`)が出ない。**
 *
 * ## この検査が固定するもの
 *
 * - T01: 作業画面でログアウトすると、招待コードの欄が出る / 画面一覧が消える / `/public` を1回取る。
 * - T02: 配る版で同じことが起きる。
 * - T03: 保護 API の 401(セッション切れ)で未ログインに落ちたときも、招待コードの欄が出る。
 * - あわせて、ログインしたままの人の `GET /manifest` は1回だけである(取得を増やしていない)。
 *
 * ## 測らないもの(誇張しない)
 *
 * - サーバが同じ判定を持つこと(`GET /public` はセッションを読まない)はここでは測らない。
 * - 実ブラウザでの見え方は `web/e2e/invitation-signup.e2e.ts` の担当である。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Manifest } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
import type { PublicAppInfo } from "../src/api.ts";
import { RunnerShell } from "../src/runner-app.tsx";
import { ADMIN_ROLES, grantRules, viewRead } from "./role-rules.ts";

const APP_ID = "sample-app";

function sampleManifest(): Manifest {
  return grantRules(
    {
      app: {
        id: APP_ID,
        name: "サンプル",
        tables: [
          {
            id: "entries",
            name: "エントリ",
            fields: [{ id: "label", name: "ラベル", type: "text", required: true }],
          },
        ],
        views: [
          {
            id: "entry-list",
            name: "エントリ一覧",
            type: "list_view",
            table: "entries",
            columns: ["label"],
          },
        ],
      },
    },
    ADMIN_ROLES,
    [viewRead("entry-list")],
  );
}

/** 招待を要求しうるアプリの `GET /public`(開いた画面は0枚)。 */
const PUBLIC_INFO: PublicAppInfo = {
  app: { id: APP_ID, name: "サンプル" },
  views: [],
  signup: {
    kinds: [
      { id: "member", name: "会員", invite: false },
      { id: "staff", name: "スタッフ", invite: true },
    ],
    adminInvite: true,
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const UNAUTHORIZED = () =>
  jsonResponse({ errors: [{ path: "", message: "認証されていません。" }] }, 401);

type Call = { url: string; method: string };

let calls: Call[];
let originalFetch: typeof fetch;

/**
 * **ログイン中は me / manifest が 200、ログアウトの後は 401 になる**スタブ。
 * `recordsStatus` で表の読取の答えを変えられる(セッション切れの再現に使う)。
 */
function stubSession(options: { recordsUnauthorized?: boolean } = {}): void {
  let loggedIn = true;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).split("?")[0] ?? String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (url === `/api/apps/${APP_ID}/auth/me`) {
      return Promise.resolve(
        loggedIn
          ? jsonResponse({
              user: { id: "u1", username: "alice", displayName: null, role: "owner" },
            })
          : UNAUTHORIZED(),
      );
    }
    if (url === `/api/apps/${APP_ID}/auth/logout` && method === "POST") {
      loggedIn = false;
      return Promise.resolve(jsonResponse({ ok: true }));
    }
    if (url === `/api/apps/${APP_ID}/manifest`) {
      return Promise.resolve(loggedIn ? jsonResponse(sampleManifest()) : UNAUTHORIZED());
    }
    if (url === `/api/apps/${APP_ID}/public`) {
      return Promise.resolve(jsonResponse(PUBLIC_INFO));
    }
    if (url === `/api/apps/${APP_ID}/tables/entries/records`) {
      if (options.recordsUnauthorized === true || !loggedIn) {
        loggedIn = false;
        return Promise.resolve(UNAUTHORIZED());
      }
      return Promise.resolve(jsonResponse({ records: [], total: 0 }));
    }
    return Promise.resolve(
      jsonResponse({ errors: [{ path: "", message: `no stub for ${url}` }] }, 404),
    );
  }) as typeof fetch;
}

function countGet(path: string): number {
  return calls.filter((call) => call.method === "GET" && call.url === `/api/apps/${APP_ID}${path}`)
    .length;
}

beforeEach(() => {
  calls = [];
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.history.replaceState({}, "", "/");
});

describe("【V22-M1】ログアウトした後のログイン画面に招待コードの欄が出る", () => {
  test("T01: 作業画面でログアウトすると、招待コードの欄が出て、画面一覧が消え、/public を1回取る", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    stubSession();
    render(<App />);

    await screen.findByTestId("view-list");
    // **ログインしたままの人の定義の取得は1回だけである**(取得を増やしていない)。
    expect(countGet("/manifest")).toBe(1);
    expect(countGet("/public")).toBe(0);

    fireEvent.click(screen.getByTestId("logout"));

    await screen.findByTestId("auth-invitation-code");
    expect(screen.getByTestId("login-page")).toBeDefined();
    expect(screen.queryByTestId("view-list")).toBeNull();
    expect(countGet("/public")).toBe(1);
  });

  test("T02: 配る版でログアウトすると、招待コードの欄が出て、画面一覧が消え、/public を1回取る", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    stubSession();
    render(<RunnerShell appId={APP_ID} />);

    await screen.findByTestId("view-list");
    expect(countGet("/manifest")).toBe(1);
    expect(countGet("/public")).toBe(0);

    fireEvent.click(screen.getByTestId("logout"));

    await screen.findByTestId("auth-invitation-code");
    expect(screen.getByTestId("login-page")).toBeDefined();
    expect(screen.queryByTestId("view-list")).toBeNull();
    expect(countGet("/public")).toBe(1);
  });

  test("T03: 保護 API の 401(セッション切れ)で未ログインに落ちたときも、招待コードの欄が出る", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-list`);
    stubSession({ recordsUnauthorized: true });
    render(<App />);

    await screen.findByTestId("auth-invitation-code");
    expect(screen.getByTestId("login-page")).toBeDefined();
    expect(screen.queryByTestId("view-list")).toBeNull();
    for (const id of ["logout", "open-account", "current-role"]) {
      expect(screen.queryByTestId(id), id).toBeNull();
    }
    expect(countGet("/public")).toBe(1);
  });
});

describe("【V22-M1】ログインしたままの人には何も足さない", () => {
  test("作業画面: ログインしたまま落ち着いても /manifest は1回・/public は0回", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    stubSession();
    render(<App />);
    await screen.findByTestId("view-list");
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await waitFor(() => expect(screen.getByTestId("current-user").textContent).toBe("alice"));
    expect(countGet("/manifest")).toBe(1);
    expect(countGet("/public")).toBe(0);
  });
});
