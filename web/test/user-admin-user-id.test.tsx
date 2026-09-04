/**
 * **利用者管理の一覧に「利用者ID」の列が出ることの検査**(`V13-M1-T01` / 台帳 `UM-G1`)。
 *
 * ## 着手前に何が偽だったか
 *
 * 説明書(`docs/manual.md` / `plugins/smailtalk/skills/app-build/SKILL.md`)は
 * **「画面なら利用者管理の一覧。そこに出る `id` が利用者IDである」**と書いていたが、
 * **着手前、利用者IDは `<tr data-user-id>` の属性に入っているだけで、画面には1文字も
 * 出ていなかった。** **本ファイルはその記述を真に戻したことを DOM の上で固定する。**
 *
 * ## 見ているもの / 見ていないもの
 *
 * - **見ている**: 見出しが4本になったこと(既存3本の文言と順序が1バイトも動いていない
 *   こと込み)、各行の `user-row-user-id` が API の返した `id` と**逐語一致**すること、
 *   コピーのボタンが `navigator.clipboard.writeText` にその `id` を渡すこと、
 *   **クリップボードが無い環境でも押して落ちない**こと、
 *   **`role-select` の個数が利用者の人数から増えていない**こと。
 * - **見ていない**: 色も余白も1つも見ていない(happy-dom は CSS を解決しない)。
 *   **「コピーできた」ことの実証でもない** —— 見ているのは `writeText` の引数までである。
 *
 * `role-select` の個数を測るのは、`web/test/customer-signup.test.tsx` が
 * `getAllByTestId("role-select")` の**添字**で行を特定しているためである ——
 * **この列を足したときに `role-select` が増えると、あちらが黙って別の行を指す。**
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UserAdmin } from "../src/auth/UserAdmin.tsx";

const APP_ID = "sample-app";

/** API が返す利用者。**`id` はここに書いた綴りと1バイト違わずに画面へ出るはずである。** */
const USERS = [
  {
    id: "usr_01hq7m3k9d2f8s4v6x0y1z",
    username: "alice",
    displayName: null,
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "usr_02jr8n4l0e3g9t5w7z1a2b",
    username: "bob",
    displayName: "ボブ",
    role: "viewer",
    createdAt: "2026-01-02T00:00:00.000Z",
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let originalFetch: typeof fetch;
/** `navigator.clipboard.writeText` に渡された文字列(先例: `web/test/theme-export.test.tsx`)。 */
let copied: string[];
let originalClipboard: PropertyDescriptor | undefined;

function stubClipboard(): void {
  copied = [];
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (text: string) => {
        copied.push(text);
        return Promise.resolve();
      },
    },
  });
}

function restoreClipboard(): void {
  if (originalClipboard === undefined) {
    Reflect.deleteProperty(navigator, "clipboard");
  } else {
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  }
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/apps/${APP_ID}/auth/users`) {
      return jsonResponse({ users: USERS });
    }
    return jsonResponse({ errors: [{ path: "", message: `no stub for ${url}` }] }, 404);
  }) as typeof fetch;
  stubClipboard();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  restoreClipboard();
});

/** 一覧が描き終わるまで待つ(2人ぶんの行が出る)。 */
async function renderUserAdmin(): Promise<void> {
  render(<UserAdmin appId={APP_ID} />);
  await waitFor(() => expect(screen.getAllByTestId("user-row").length).toBe(USERS.length));
}

describe("利用者管理の一覧に利用者IDが出る(UM-G1)", () => {
  test("見出しに「利用者ID」が並び、既存3本の文言と順序は1バイトも動いていない", async () => {
    await renderUserAdmin();
    const headers = screen.getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headers).toEqual(["ユーザ名", "表示名", "ロール", "利用者ID"]);
  });

  test("各行の利用者IDが、API の返した id と逐語一致する", async () => {
    await renderUserAdmin();
    const shown = screen.getAllByTestId("user-row-user-id").map((cell) => cell.textContent);
    expect(shown).toEqual(USERS.map((user) => user.id));
  });

  test("行の利用者IDは、その行の data-user-id と同じ値である", async () => {
    await renderUserAdmin();
    for (const row of screen.getAllByTestId("user-row")) {
      const shown = row.querySelector('[data-testid="user-row-user-id"]');
      const attribute = row.getAttribute("data-user-id") ?? "";
      expect(shown?.textContent).toBe(attribute);
      // **属性が空文字のまま「一致した」と読まないための下支え**(片方が消えたら赤くする)。
      expect(attribute.length).toBeGreaterThan(0);
    }
  });

  test("コピーのボタンを押すと、その行の id が writeText に渡る", async () => {
    await renderUserAdmin();
    const buttons = screen.getAllByTestId("user-row-copy-id");
    expect(buttons.length).toBe(USERS.length);

    fireEvent.click(buttons[1] as HTMLElement);
    await waitFor(() => expect(copied.length).toBe(1));
    expect(copied).toEqual([USERS[1]?.id as string]);

    fireEvent.click(buttons[0] as HTMLElement);
    await waitFor(() => expect(copied.length).toBe(2));
    expect(copied[1]).toBe(USERS[0]?.id as string);
  });

  test("クリップボードが無い環境でも、押して例外を投げない", async () => {
    // **`Reflect.deleteProperty` では消えない** —— happy-dom は `Navigator` の
    // プロトタイプに `clipboard` の getter を持つ(`web/test/theme-export.test.tsx` の実測)。
    // したがって「無い」状態は `value: undefined` の自前プロパティで作る。
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    await renderUserAdmin();
    const button = screen.getAllByTestId("user-row-copy-id")[0] as HTMLElement;
    expect(() => fireEvent.click(button)).not.toThrow();
    expect(copied).toEqual([]);
  });

  test("行の同定に使われている data-user-id を残している", async () => {
    await renderUserAdmin();
    const ids = screen.getAllByTestId("user-row").map((row) => row.getAttribute("data-user-id"));
    expect(ids).toEqual(USERS.map((user) => user.id));
  });

  test("role-select の個数は利用者の人数のままである(添字で行を指す検査を壊さない)", async () => {
    await renderUserAdmin();
    expect(screen.getAllByTestId("role-select").length).toBe(USERS.length);
  });
});
