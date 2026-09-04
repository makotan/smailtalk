/**
 * アカウント画面(パスワードの変更と退会)のコンポーネントテスト(`E-G68` / V4-M6)。
 *
 * **見るのは DOM と、叩いた URL / メソッド / 本文だけである。** サーバ側の挙動
 * (401 / 409 / セッションの切り直し)は `src/server/auth-routes.test.ts` が本物の HTTP で
 * 固定しており、ここでそれを再実装しない。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AccountPanel } from "../src/auth/AccountPanel.tsx";

const APP_ID = "sample-app";

let originalFetch: typeof fetch;
let calls: { url: string; method: string; body: unknown }[];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stub(respond: (url: string) => Response): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return Promise.resolve(respond(url));
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

function renderPanel(onWithdrawn: () => void = () => {}) {
  return render(
    <AccountPanel appId={APP_ID} username="alice" onWithdrawn={onWithdrawn} onClose={() => {}} />,
  );
}

describe("パスワードの変更", () => {
  test("入力して押すと password/change を POST し、入力欄が空になる", async () => {
    stub(() => jsonResponse({ ok: true }));
    renderPanel();
    fireEvent.change(screen.getByTestId("account-current-password"), {
      target: { value: "pw-123456" },
    });
    fireEvent.change(screen.getByTestId("account-new-password"), {
      target: { value: "pw-abcdefg" },
    });
    fireEvent.click(screen.getByTestId("account-change-password"));

    await waitFor(() => expect(screen.getByTestId("account-password-changed")).toBeDefined());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`/api/apps/${APP_ID}/auth/password/change`);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({
      current_password: "pw-123456",
      new_password: "pw-abcdefg",
    });
    // 変更後のパスワードを画面に残さない。
    expect((screen.getByTestId("account-new-password") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("account-current-password") as HTMLInputElement).value).toBe("");
  });

  test("失敗するとサーバの文面がそのまま出る(401 でもログイン画面へ落とさない)", async () => {
    stub(() =>
      jsonResponse(
        { errors: [{ path: "", message: "username またはパスワードが正しくありません。" }] },
        401,
      ),
    );
    renderPanel();
    fireEvent.click(screen.getByTestId("account-change-password"));
    await waitFor(() => expect(screen.getByTestId("account-error")).toBeDefined());
    expect(screen.getByTestId("account-error").textContent).toContain(
      "username またはパスワードが正しくありません。",
    );
    expect(screen.queryByTestId("account-password-changed")).toBeNull();
  });
});

describe("退会", () => {
  test("押しただけでは消えない(確認を挟む)", () => {
    stub(() => jsonResponse({ ok: true }));
    renderPanel();
    fireEvent.click(screen.getByTestId("account-withdraw"));
    expect(screen.getByTestId("account-withdraw-confirm")).toBeDefined();
    // **この時点でネットワークを1本も叩いていない。**
    expect(calls).toHaveLength(0);
  });

  test("確認して押すと DELETE /auth/me を叩き、呼び出し側に通知する", async () => {
    stub(() => jsonResponse({ ok: true }));
    let withdrawn = false;
    renderPanel(() => {
      withdrawn = true;
    });
    fireEvent.click(screen.getByTestId("account-withdraw"));
    fireEvent.click(screen.getByTestId("account-withdraw-execute"));
    await waitFor(() => expect(withdrawn).toBe(true));
    expect(calls[0]?.url).toBe(`/api/apps/${APP_ID}/auth/me`);
    expect(calls[0]?.method).toBe("DELETE");
  });

  test("最後の owner の 409 は文面が出て、確認は閉じる(アカウントは残る)", async () => {
    stub(() =>
      jsonResponse({ errors: [{ path: "", message: "最後の owner は退会できません。" }] }, 409),
    );
    let withdrawn = false;
    renderPanel(() => {
      withdrawn = true;
    });
    fireEvent.click(screen.getByTestId("account-withdraw"));
    fireEvent.click(screen.getByTestId("account-withdraw-execute"));
    await waitFor(() => expect(screen.getByTestId("account-error")).toBeDefined());
    expect(screen.getByTestId("account-error").textContent).toContain(
      "最後の owner は退会できません。",
    );
    expect(withdrawn).toBe(false);
    expect(screen.queryByTestId("account-withdraw-confirm")).toBeNull();
  });

  test("退会で業務データが消えないことを画面に書いてある", () => {
    stub(() => jsonResponse({ ok: true }));
    renderPanel();
    expect(screen.getByTestId("account-withdraw-note").textContent).toContain("消えません");
  });
});

// ---------------------------------------------------------------------------
// 導線(`AppWorkspace` の「アカウント」ボタン)—— ロールで出し分けない(E-G68)
// ---------------------------------------------------------------------------

describe("アカウントの導線", () => {
  test("AppWorkspace の導線はロールで出し分けない(4ロールとも同じ1本)", () => {
    // **判定を持たないことを、実装の形で固定する。** owner 限定パネル(`isOwner &&`)と
    // 並べても、この導線だけは条件を持たない —— 本人の資格情報は誰でもやり直せる。
    const source = readFileSync(join(dirname(import.meta.dir), "src", "AppWorkspace.tsx"), "utf-8");
    const match = /\{isOwner && \(\s*<button type="button" data-testid="open-account"/.exec(source);
    expect(match, "open-account が owner 限定になっている").toBeNull();
    expect(source).toContain('data-testid="open-account"');
  });
});
