/**
 * **画面の状態が見えることの検査**(`V4-M15-T14`。`ADR-0087` / `ADR-0089`)。
 *
 * ## この検査が見ているもの
 *
 * `V4-M15-T14` の着手前の実測(`docs/plan/v4/03-component-layer-baseline.md` §4-1)は
 * **`:active` 0件 / `:disabled` 0件 / skeleton・spinner 0件 / 成功・警告表示0件 /
 * `aria-current`・`aria-selected` 0件 / transition・animation 0件**であった。
 * **本ファイルは、シェル・ログイン・運営者画面の側でその 0 が 0 でなくなったことを
 * DOM の上で固定する。**
 *
 * **見ているのは「部品体系の器に入っているか」と「既存の class / `data-testid` が
 * 消えていないか」の2つだけである。** **色も余白も1つも見ていない**(計算値は
 * chromium の e2e の担当であり、happy-dom は CSS を解決しない)。
 *
 * **【誇張しない】これは「見やすくなった」ことの検査ではない。**
 * **書けるのは「読み込み中に骨組みが出る」「失敗が `Alert` の器に入る」
 * 「いま居る画面に `aria-current` が付く」までである。**
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// 儀式のラッパをモック(実 WebAuthn は happy-dom で動かない。`login-page.test.tsx` と同じ)。
mock.module("../src/auth/passkey.ts", () => ({
  runPasskeyRegistration: async () => ({ id: "reg-cred", type: "public-key", response: {} }),
  runPasskeyLogin: async () => ({ id: "login-cred", type: "public-key", response: {} }),
}));

import type { Manifest } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
import { AppListPage } from "../src/AppListPage.tsx";
import { AccountPanel } from "../src/auth/AccountPanel.tsx";
import { ConnectionAdmin } from "../src/auth/ConnectionAdmin.tsx";
import { EscapeHatchAdmin } from "../src/auth/EscapeHatchAdmin.tsx";
import { LoginPage } from "../src/auth/LoginPage.tsx";
import { UserAdmin } from "../src/auth/UserAdmin.tsx";
import { RequirementsDocPanel } from "../src/RequirementsDocPanel.tsx";
import { ApplyInProgress, WriteConflict } from "../src/views/WriteConflict.tsx";
import { WriteForbidden } from "../src/views/WriteForbidden.tsx";
import { grantRules, viewRead } from "./role-rules.ts";

const APP_ID = "sample-app";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`】面の既定が「閉じる」側へ倒れたので、
 * 規則を1本も持たない題材では画面一覧が空になり、`aria-current` の当たり先が0件になる。**
 * **本ファイルの主題は「いま居る場所が見えること」であって権限ではないので、題材の側に
 * 規則を足して主題を保つ。** **期待値は1文字も変えていない。**
 *
 * **2画面とも足すのは、`aria-current` が「1件だけ」に付くことを測る検査だからである** ——
 * **1画面しか並ばない一覧では「1件だけ」が自明になり、検査が弱くなる。**
 * **足すのは画面 × 読取の2本だけで、表・項目・ボタンの規則は1本も足していない。**
 * **宛先は `owner` 1役割だけである**(この題材の `me` が返すのはそのロールである)。
 */
function sampleManifest(): Manifest {
  const built: Manifest = {
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
        {
          id: "entry-form",
          name: "エントリ登録",
          type: "form",
          table: "entries",
          fields: ["label"],
        },
      ],
    },
  };
  return grantRules(built, ["owner"], [viewRead("entry-list"), viewRead("entry-form")]);
}

let originalFetch: typeof fetch;

/** url → Response のルーティング型スタブ。未登録は 404。 */
function stub(routes: (url: string) => Response | undefined): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    const response = routes(url.split("?")[0] ?? url);
    return Promise.resolve(
      response ?? jsonResponse({ errors: [{ path: "", message: `no stub for ${url}` }] }, 404),
    );
  }) as typeof fetch;
}

/** **決して解決しない** fetch(読み込み中の状態をそのまま観察するため)。 */
function stubPending(): void {
  globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.history.replaceState({}, "", "/");
});

function skeletons(): Element[] {
  return [...document.querySelectorAll('[data-slot="skeleton"]')];
}

function destructiveAlerts(): Element[] {
  return [...document.querySelectorAll('[data-slot="alert"][data-variant="destructive"]')];
}

// ---------------------------------------------------------------------------
// (1) 読み込み中 —— skeleton が出る(着手前 0件)
// ---------------------------------------------------------------------------

describe("(1) 読み込み中に骨組みが出る", () => {
  test("アプリ一覧", () => {
    stubPending();
    render(<AppListPage />);
    expect(skeletons().length).toBeGreaterThan(0);
    // **文言は1文字も変えていない。**
    expect(document.body.textContent).toContain("読み込み中…");
  });

  test("ユーザ管理", () => {
    stubPending();
    render(<UserAdmin appId={APP_ID} />);
    expect(skeletons().length).toBeGreaterThan(0);
  });

  test("接続の管理", () => {
    stubPending();
    render(<ConnectionAdmin appId={APP_ID} />);
    expect(skeletons().length).toBeGreaterThan(0);
  });

  test("逃げ道の管理", () => {
    stubPending();
    render(<EscapeHatchAdmin appId={APP_ID} />);
    expect(skeletons().length).toBeGreaterThan(0);
  });

  test("要件定義書", () => {
    stubPending();
    render(<RequirementsDocPanel appId={APP_ID} />);
    expect(skeletons().length).toBeGreaterThan(0);
  });

  test("アプリの作業画面(マニフェスト取得中)", () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    stubPending();
    render(<App />);
    expect(skeletons().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// (2) 失敗 —— Alert variant="destructive" の器に入る(着手前 0件)
// ---------------------------------------------------------------------------

describe("(2) 失敗が Alert の器に入る", () => {
  test("アプリ一覧の取得失敗", async () => {
    stub(() => jsonResponse({ errors: [{ path: "", message: "取れません。" }] }, 500));
    render(<AppListPage />);
    await waitFor(() => expect(destructiveAlerts().length).toBeGreaterThan(0));
    expect(document.body.textContent).toContain("取れません。");
  });

  test("ログインの失敗(auth-error は destructive な Alert で、login-error の class を持つ)", async () => {
    stub(() =>
      jsonResponse(
        { errors: [{ path: "", message: "username またはパスワードが正しくありません。" }] },
        401,
      ),
    );
    render(<LoginPage appId={APP_ID} onAuthenticated={() => {}} />);
    fireEvent.submit(screen.getByTestId("password-login").closest("form") as HTMLFormElement);

    const region = await screen.findByTestId("auth-error");
    expect(region.getAttribute("data-slot")).toBe("alert");
    expect(region.getAttribute("data-variant")).toBe("destructive");
    // **既存の class は1つも消していない。**
    expect(region.classList.contains("login-error")).toBe(true);
    expect(region.getAttribute("role")).toBe("alert");
  });

  test("ロール変更の失敗(role-error)", async () => {
    stub((url) => {
      if (url === `/api/apps/${APP_ID}/auth/users`) {
        return jsonResponse({
          users: [{ id: "u1", username: "alice", displayName: null, role: "owner" }],
        });
      }
      return jsonResponse({ errors: [{ path: "", message: "だめでした。" }] }, 409);
    });
    render(<UserAdmin appId={APP_ID} />);
    const select = (await screen.findAllByTestId("role-select"))[0] as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "editor" } });

    const error = await screen.findByTestId("role-error");
    expect(error.getAttribute("data-slot")).toBe("alert");
    expect(error.getAttribute("data-variant")).toBe("destructive");
    expect(error.classList.contains("user-admin-role-error")).toBe(true);
  });

  test("接続の発行の失敗(issue-error)", async () => {
    stub((url) => {
      if (url === `/api/apps/${APP_ID}/connections/requests`) {
        return jsonResponse({ requests: [] });
      }
      if (url === `/api/apps/${APP_ID}/connections`) {
        return jsonResponse({ errors: [{ path: "/name", message: "name は必須です。" }] }, 400);
      }
      return undefined;
    });
    render(<ConnectionAdmin appId={APP_ID} />);
    await waitFor(() => expect(screen.getByTestId("connection-name-input")).toBeDefined());
    fireEvent.click(screen.getByTestId("issue-connection"));
    const error = await screen.findByTestId("issue-error");
    expect(error.getAttribute("data-slot")).toBe("alert");
    expect(error.getAttribute("data-variant")).toBe("destructive");
  });

  test("逃げ道の発行の失敗(escape-hatch-issue-error)", async () => {
    stub((url) => {
      if (url === `/api/apps/${APP_ID}/escape-hatch-assets/requests`) {
        return jsonResponse({ requests: [] });
      }
      if (url === `/api/apps/${APP_ID}/escape-hatch-assets`) {
        return jsonResponse({ assets: [] });
      }
      return undefined;
    });
    render(<EscapeHatchAdmin appId={APP_ID} />);
    await waitFor(() => expect(screen.getByTestId("escape-hatch-name-input")).toBeDefined());
    // 資産名が空なので、送る前の先回りで落ちる(サーバへは行かない)。
    fireEvent.click(screen.getByTestId("issue-escape-hatch"));
    const error = await screen.findByTestId("escape-hatch-issue-error");
    expect(error.getAttribute("data-slot")).toBe("alert");
    expect(error.getAttribute("data-variant")).toBe("destructive");
  });

  test("書込の拒否・競合の3表示", () => {
    render(
      <>
        <WriteConflict />
        <ApplyInProgress />
        <WriteForbidden />
      </>,
    );
    for (const [testId, className] of [
      ["write-conflict", "write-conflict"],
      ["apply-in-progress", "apply-in-progress"],
      ["write-forbidden", "write-forbidden"],
    ] as const) {
      const element = screen.getByTestId(testId);
      expect(element.getAttribute("data-slot")).toBe("alert");
      expect(element.getAttribute("data-variant")).toBe("destructive");
      expect(element.getAttribute("role")).toBe("alert");
      expect(element.classList.contains(className)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// (3) いま居る場所 —— aria-current="page"(着手前 0件)
// ---------------------------------------------------------------------------

describe("(3) いま居る場所に aria-current が付く", () => {
  test("画面一覧の現在の画面 1件だけに付く", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-list`);
    stub((url) => {
      if (url === `/api/apps/${APP_ID}/auth/me`) {
        return jsonResponse({
          user: { id: "u1", username: "alice", displayName: null, role: "owner" },
        });
      }
      if (url === `/api/apps/${APP_ID}/manifest`) {
        return jsonResponse(sampleManifest());
      }
      return undefined;
    });
    render(<App />);

    const list = await screen.findByTestId("view-list");
    const current = [...list.querySelectorAll('[aria-current="page"]')];
    expect(current.length).toBe(1);
    expect(current[0]?.textContent).toContain("エントリ一覧");
  });

  test("画面を選んでいないときは1件も付かない", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    stub((url) => {
      if (url === `/api/apps/${APP_ID}/auth/me`) {
        return jsonResponse({
          user: { id: "u1", username: "alice", displayName: null, role: "owner" },
        });
      }
      if (url === `/api/apps/${APP_ID}/manifest`) {
        return jsonResponse(sampleManifest());
      }
      return undefined;
    });
    render(<App />);

    const list = await screen.findByTestId("view-list");
    expect(list.querySelectorAll('[aria-current="page"]').length).toBe(0);
  });

  test("アプリ切替の現在のアプリに付く(印 data-current と同じ当たり先)", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    stub((url) => {
      if (url === "/api/apps") {
        return jsonResponse({
          apps: [
            { app_id: APP_ID, name: "サンプル", created_at: "2026-01-01", status: "active" },
            { app_id: "other", name: "べつのやつ", created_at: "2026-01-01", status: "active" },
          ],
        });
      }
      if (url === `/api/apps/${APP_ID}/auth/me`) {
        return jsonResponse({ errors: [{ path: "", message: "未認証" }] }, 401);
      }
      if (url === `/api/apps/${APP_ID}/manifest`) {
        return jsonResponse(sampleManifest());
      }
      return undefined;
    });
    render(<App />);

    const list = await screen.findByTestId("app-switcher-list");
    const current = [...list.querySelectorAll('[aria-current="page"]')];
    expect(current.length).toBe(1);
    expect(current[0]?.getAttribute("data-current")).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// (4) 成功表示(着手前 0件)
// ---------------------------------------------------------------------------

describe("(4) 成功が器を持つ", () => {
  test("パスワード変更の成功は Alert の器に入り、role=status のままである", async () => {
    stub(() => jsonResponse({ ok: true }));
    render(<AccountPanel appId={APP_ID} username="alice" onWithdrawn={() => {}} />);
    fireEvent.change(screen.getByTestId("account-current-password"), {
      target: { value: "old12345" },
    });
    fireEvent.change(screen.getByTestId("account-new-password"), {
      target: { value: "new12345" },
    });
    fireEvent.submit(
      screen.getByTestId("account-change-password").closest("form") as HTMLFormElement,
    );

    const done = await screen.findByTestId("account-password-changed");
    expect(done.getAttribute("data-slot")).toBe("alert");
    // **`role` は既存のまま `status` である**(`aria-live` を1つも足していない)。
    expect(done.getAttribute("role")).toBe("status");
    expect(done.classList.contains("account-done")).toBe(true);
    // **文言は1文字も変えていない。**
    expect(done.textContent).toContain("パスワードを変更しました。他の端末のログインは切れます。");
  });
});

// ---------------------------------------------------------------------------
// (5) 押せる/押せない —— 操作は部品のボタンである
// ---------------------------------------------------------------------------

describe("(5) 操作が部品のボタンである", () => {
  test("ログイン画面の6ボタンは部品で、順序も testid も1つも変わっていない", () => {
    render(<LoginPage appId={APP_ID} onAuthenticated={() => {}} />);
    const buttons = [...document.querySelectorAll("button[data-testid]")];
    expect(buttons.map((button) => button.getAttribute("data-testid"))).toEqual([
      "passkey-login",
      "password-login",
      "customer-passkey-register",
      "customer-password-register",
      "passkey-register",
      "password-register",
    ]);
    for (const button of buttons) {
      expect(button.getAttribute("data-slot")).toBe("button");
    }
    // 送信ボタンだけは `type="submit"` のままである。
    expect(screen.getByTestId("password-login").getAttribute("type")).toBe("submit");
  });

  test("押している最中は押せない(disabled が実際に立つ)", async () => {
    // 決して解決しない fetch にすると `busy` が立ったままになる。
    stubPending();
    render(<LoginPage appId={APP_ID} onAuthenticated={() => {}} />);
    fireEvent.click(screen.getByTestId("passkey-login"));
    await waitFor(() =>
      expect((screen.getByTestId("password-login") as HTMLButtonElement).disabled).toBe(true),
    );
    for (const id of [
      "passkey-login",
      "password-login",
      "customer-passkey-register",
      "customer-password-register",
      "passkey-register",
      "password-register",
    ]) {
      expect((screen.getByTestId(id) as HTMLButtonElement).disabled).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// (6) 幅への対応(`D-V4-44`)—— 表は横に溢れうるので包む
// ---------------------------------------------------------------------------

describe("(6) 運営者画面の表が包まれている", () => {
  test("ユーザ管理の表", async () => {
    stub((url) => {
      if (url === `/api/apps/${APP_ID}/auth/users`) {
        return jsonResponse({
          users: [{ id: "u1", username: "alice", displayName: null, role: "owner" }],
        });
      }
      return undefined;
    });
    render(<UserAdmin appId={APP_ID} />);
    const row = await screen.findByTestId("user-row");
    const table = row.closest("table");
    expect(table?.classList.contains("user-admin-table")).toBe(true);
    expect(table?.parentElement?.getAttribute("data-slot")).toBe("table-container");
  });

  test("発行済み接続の表", async () => {
    stub((url) => {
      if (url === `/api/apps/${APP_ID}/connections/requests`) {
        return jsonResponse({ requests: [] });
      }
      if (url === `/api/apps/${APP_ID}/connections`) {
        return jsonResponse({
          connections: [
            {
              id: "c1",
              name: "stripe",
              allowedHosts: ["api.stripe.com"],
              secretSource: { kind: "env", value: "STRIPE_API_KEY" },
            },
          ],
        });
      }
      return undefined;
    });
    render(<ConnectionAdmin appId={APP_ID} />);
    const row = await screen.findByTestId("connection-row");
    const table = row.closest("table");
    expect(table?.classList.contains("connection-table")).toBe(true);
    expect(table?.parentElement?.getAttribute("data-slot")).toBe("table-container");
  });

  test("発行済み逃げ道の表", async () => {
    stub((url) => {
      if (url === `/api/apps/${APP_ID}/escape-hatch-assets/requests`) {
        return jsonResponse({ requests: [] });
      }
      if (url === `/api/apps/${APP_ID}/escape-hatch-assets`) {
        return jsonResponse({
          assets: [{ id: "a1", name: "print", digest: "abc", scopeViews: ["entry-list"] }],
        });
      }
      return undefined;
    });
    render(<EscapeHatchAdmin appId={APP_ID} />);
    const row = await screen.findByTestId("escape-hatch-row");
    const table = row.closest("table");
    expect(table?.classList.contains("escape-hatch-table")).toBe(true);
    expect(table?.parentElement?.getAttribute("data-slot")).toBe("table-container");
  });
});

// ---------------------------------------------------------------------------
// (7) 既存の class を1つも消していない
// ---------------------------------------------------------------------------

describe("(7) 既存の class が残っている", () => {
  test("ログイン画面(login / login-form)", () => {
    render(<LoginPage appId={APP_ID} onAuthenticated={() => {}} />);
    expect(screen.getByTestId("login-page").classList.contains("login")).toBe(true);
    expect(document.querySelector(".login-form")).not.toBeNull();
    expect(document.querySelector(".shell")).not.toBeNull();
  });

  test("作業画面(app-header / current-user / workspace-body / view-list / workspace-main)", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    stub((url) => {
      if (url === `/api/apps/${APP_ID}/auth/me`) {
        return jsonResponse({
          user: { id: "u1", username: "alice", displayName: null, role: "owner" },
        });
      }
      if (url === `/api/apps/${APP_ID}/manifest`) {
        return jsonResponse(sampleManifest());
      }
      return undefined;
    });
    render(<App />);

    const list = await screen.findByTestId("view-list");
    expect(list.classList.contains("view-list")).toBe(true);
    expect(list.parentElement?.classList.contains("workspace-body")).toBe(true);
    // **左カラムの器の並びは1バイトも変えていない**(`app-workspace.test.tsx` と同じ固定)。
    expect(list.parentElement?.firstElementChild).toBe(list);
    expect(list.parentElement?.children[1]).toBe(screen.getByTestId("workspace-main"));
    expect(screen.getByTestId("workspace-main").classList.contains("workspace-main")).toBe(true);
    expect(document.querySelector(".app-header")).not.toBeNull();
    expect(screen.getByTestId("current-user").classList.contains("current-user")).toBe(true);
    expect(document.querySelectorAll(".meta").length).toBeGreaterThan(0);
  });

  test("要件定義書(requirements-doc-preface / requirements-copy)", async () => {
    stub(() =>
      jsonResponse({
        requirements: {
          markdown: "# なにか",
          statements: [
            {
              id: "s1",
              section: "overview",
              template: "app_overview",
              text: "アプリの説明。",
              sources: [{ kind: "manifest", pointer: "/app" }],
            },
          ],
        },
      }),
    );
    render(<RequirementsDocPanel appId={APP_ID} />);
    await waitFor(() => expect(screen.getByTestId("requirement-text")).toBeDefined());
    expect(screen.getByTestId("requirement-text").classList.contains("requirement-text")).toBe(
      true,
    );
    expect(
      screen.getByTestId("requirements-preface").classList.contains("requirements-doc-preface"),
    ).toBe(true);
    expect(document.querySelector(".requirements-copy")).not.toBeNull();
    expect(
      screen.getByTestId("requirement-sources").classList.contains("requirement-sources"),
    ).toBe(true);
    expect(document.querySelector(".requirement-statements")).not.toBeNull();
  });
});
