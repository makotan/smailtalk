/**
 * useAppAuth のコンポーネントテスト(V1-M3-T01 / ADR-0014 改訂 = per-app)。
 *
 * 認証はアプリ単位。フックは `appId` を受け取り、そのアプリの `me` だけを見る。
 * 検証点:
 *   1. me 200 → authenticated(user を保持)。叩く URL は `/api/apps/:appId/auth/me`
 *   2. me 401 → anonymous(**そのアプリに未ログインの正常応答。エラーにしない**)
 *   3. me の通信不能/想定外 → anonymous(ログイン画面へ誘導)
 *   4. signOut → `logout(appId)` を叩いてから anonymous
 *   5. **このアプリ**の保護 API(records)の 401 → 共通ハンドラ経由で anonymous(セッション失効)
 *   6. **別アプリ**宛の失効通知は無視する(複数アプリ同時ログインを壊さない)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { fetchRecords } from "../src/api.ts";
import { useAppAuth } from "../src/auth/useAppAuth.ts";

const APP_ID = "sample-app";

let originalFetch: typeof fetch;
let calls: string[];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** url → Response を返す fetch スタブ(呼び出し url を記録)。 */
function stub(routes: (url: string) => Response): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return Promise.resolve(routes(url));
  }) as typeof fetch;
}

function Harness({ appId = APP_ID }: { appId?: string }) {
  const auth = useAppAuth(appId);
  return (
    <div>
      <span data-testid="status">{auth.status}</span>
      {auth.status === "authenticated" && <span data-testid="user">{auth.user.username}</span>}
      <button type="button" data-testid="signout" onClick={() => void auth.signOut()}>
        out
      </button>
    </div>
  );
}

beforeEach(() => {
  calls = [];
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("起動時の me 確認(アプリ単位)", () => {
  test("me 200 は authenticated(user を保持)。URL は per-app", async () => {
    stub(() =>
      jsonResponse({ user: { id: "u1", username: "alice", displayName: null, role: "owner" } }),
    );
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("authenticated"));
    expect(screen.getByTestId("user").textContent).toBe("alice");
    expect(calls).toContain(`/api/apps/${APP_ID}/auth/me`);
  });

  test("me 401 は anonymous(エラーにしない)", async () => {
    stub(() => jsonResponse({ errors: [{ path: "", message: "認証されていません。" }] }, 401));
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("anonymous"));
  });

  test("me の想定外応答(500)も anonymous に倒す", async () => {
    stub(() => jsonResponse({ errors: [{ path: "", message: "内部エラー" }] }, 500));
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("anonymous"));
  });
});

describe("ログアウト(アプリ単位)", () => {
  test("signOut は logout(appId) を叩いてから anonymous", async () => {
    stub((url) => {
      if (url === `/api/apps/${APP_ID}/auth/me`) {
        return jsonResponse({
          user: { id: "u1", username: "alice", displayName: null, role: "owner" },
        });
      }
      return jsonResponse({ ok: true });
    });
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("authenticated"));

    fireEvent.click(screen.getByTestId("signout"));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("anonymous"));
    expect(calls).toContain(`/api/apps/${APP_ID}/auth/logout`);
  });
});

describe("セッション失効(保護 API の 401)", () => {
  test("このアプリの records が 401 を返すと共通ハンドラ経由で anonymous", async () => {
    stub((url) => {
      if (url === `/api/apps/${APP_ID}/auth/me`) {
        return jsonResponse({
          user: { id: "u1", username: "alice", displayName: null, role: "owner" },
        });
      }
      // 保護 API(records)はセッション失効を表す 401 を返す。
      return jsonResponse({ errors: [{ path: "", message: "認証されていません。" }] }, 401);
    });
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("authenticated"));

    // このアプリの保護 API を叩く(失効 → 共通ハンドラが appId 一致で anonymous へ)。
    await act(async () => {
      await fetchRecords(APP_ID, "things").catch(() => {});
    });
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("anonymous"));
  });

  test("別アプリの records 401 は無視する(authenticated のまま)", async () => {
    stub((url) => {
      if (url === `/api/apps/${APP_ID}/auth/me`) {
        return jsonResponse({
          user: { id: "u1", username: "alice", displayName: null, role: "owner" },
        });
      }
      return jsonResponse({ errors: [{ path: "", message: "認証されていません。" }] }, 401);
    });
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("authenticated"));

    // 別アプリ(other-app)の失効は、このフック(sample-app)には無関係。
    await act(async () => {
      await fetchRecords("other-app", "things").catch(() => {});
    });
    // しばらく待っても authenticated のまま。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId("status").textContent).toBe("authenticated");
  });
});
