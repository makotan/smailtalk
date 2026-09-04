/**
 * `V4-M21-T03`: 買い物客としての登録が成功した直後に、**自分の情報を登録する画面へ導く**
 * (表示層。`E-G65` / `D-V4-82`)。
 *
 * 上位: `docs/plan/v4/records/v4-m21.md` §1 の `V4-M21-T03` /
 *       `docs/plan/v4/records/v4-m21-gate-a-account-created-member-row.md`(単位B = **将来送り**)。
 *
 * ## 本ファイルの立場(誇張しない。憲法6)
 *
 * **単位B は将来送りであり、送り先は「表示層」である。** **自動処理の起点は1バイトも
 * 作っていない** —— `schemas/` / `src/kernel/` / `src/auth/` に差分は0行で、
 * `src/server/auth-routes.ts` の `runWorkflows` は今日も **0件**である。
 *
 * ## 【解けないこと。先に書く】
 *
 * - **自動処理の起点にはならない。** **客が導線に従わなければ行は1つも作られない。**
 * - **既に「アカウントだけあって会員行が無い」利用者は1件も直らない。**
 * - **導く先をアプリが宣言できない。** マニフェストには1バイトも書けないので、
 *   **どこへ導くかはレンダラの既定挙動である** —— 選ぶ規則は
 *   「**`st_owner` を宣言したテーブルの `form` ビューのうち、そのロールが使えるもの**」
 *   であり、**そのうちどれが「会員情報」なのかをレンダラは知らない。全部並べる。**
 * - **候補が1つも無いアプリでは、案内そのものを描かない**(押しても何も無い導線を
 *   出さない。`V4-M2-T07` 完了条件3 と同じ規律)。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Manifest } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
import { grantRules, viewRead } from "./role-rules.ts";

const APP_ID = "shop-app";

/**
 * `member`(`st_owner` つき)の form を持つアプリ。
 *
 * **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`】面の既定が「閉じる」側へ倒れたので、
 * 規則を1本も持たない題材では `canUseView` が偽になり、案内の候補
 * (`AppWorkspace` の `signupNextForms`)が0件になって案内そのものが1つも描かれない。**
 * **本ファイルの主題は「登録の直後に導線が出る/閉じれば消える」であって権限ではないので、
 * 題材の側に規則を足して主題を保つ。** **期待値は1文字も変えていない。**
 *
 * **足すのは `member-form` × 読取の1本だけである** —— **導線の行き先そのものであり、
 * これ以外に要る規則は1本も無い。** **`notice-list` には1本も足していない**
 * (画面一覧が空のままでも案内は出る。**主題に要らない対象を足さない**)。
 * **宛先は `customer` 1役割だけである**(登録の応答が返すロール)。
 */
function manifestWithMemberForm(): Manifest {
  const built: Manifest = {
    app: {
      id: APP_ID,
      name: "お店",
      tables: [
        {
          id: "member",
          name: "会員",
          fields: [
            { id: "display_name", name: "表示名", type: "text", required: true },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
        {
          id: "notice",
          name: "お知らせ",
          fields: [{ id: "body", name: "本文", type: "text" }],
        },
      ],
      views: [
        {
          id: "notice-list",
          name: "お知らせ一覧",
          type: "list_view",
          table: "notice",
          columns: ["body"],
        },
        {
          id: "member-form",
          name: "会員情報の登録",
          type: "form",
          table: "member",
          fields: ["display_name"],
        },
      ],
    },
  };
  return grantRules(built, ["customer"], [viewRead("member-form")]);
}

/**
 * `st_owner` を宣言したテーブルの form が1本も無いアプリ(= 会員テーブルを持たないアプリ)。
 *
 * **【`V8-M26`】規則は `app.roles` ごと引き継がれるので、ここには `member-form` を名指しした
 * まま指し先の無い規則が1本残る。** **これは「書けるが必ず効かない宣言」であり、
 * ユーザ決定 `D-V8-66`(2026-08-10)が役割の規則についてだけ、それを明文で許した形と
 * 同じものである** —— **`src/kernel/referential-integrity.ts` の類型16 は撤去済みで、
 * 適用時検査は今日この形を拒まない。** **本ファイルの期待値(案内を1つも描かない)は
 * その残骸に1ミリも依っていない** —— **画面そのものが無いので候補は0件である。**
 */
function manifestWithoutMemberForm(): Manifest {
  const base = manifestWithMemberForm();
  return {
    app: {
      ...base.app,
      tables: base.app.tables.filter((table) => table.id !== "member"),
      views: base.app.views.filter((view) => view.id !== "member-form"),
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let originalFetch: typeof fetch;

function stub(routes: (url: string) => Response | undefined): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    const response = routes(url.split("?")[0] ?? url);
    return Promise.resolve(
      response ?? jsonResponse({ errors: [{ path: "", message: `no stub for ${url}` }] }, 404),
    );
  }) as typeof fetch;
}

/** 未ログイン → その manifest を返す、という最小のルーティング。 */
function anonymousStub(manifest: Manifest): void {
  stub((url) => {
    if (url === `/api/apps/${APP_ID}/auth/me`) {
      return jsonResponse({ errors: [{ path: "", message: "認証されていません。" }] }, 401);
    }
    if (url === `/api/apps/${APP_ID}/manifest`) {
      return jsonResponse(manifest);
    }
    if (url === `/api/apps/${APP_ID}/auth/signup/password/register`) {
      return jsonResponse({ user: { id: "u-1", username: "kaimono", role: "customer" } });
    }
    if (url === `/api/apps/${APP_ID}/auth/password/login`) {
      return jsonResponse({ user: { id: "u-1", username: "kaimono", role: "customer" } });
    }
    if (url.startsWith(`/api/apps/${APP_ID}/tables/`)) {
      return jsonResponse({ records: [], total: 0 });
    }
    return undefined;
  });
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.history.replaceState({}, "", "/");
});

describe("登録の直後に、自分の情報を登録する画面へ導く", () => {
  test("買い物客として登録すると、案内と導線が出る", async () => {
    anonymousStub(manifestWithMemberForm());
    render(<App />);
    await screen.findByTestId("customer-password-register");

    fireEvent.change(screen.getByTestId("auth-username"), { target: { value: "kaimono" } });
    fireEvent.change(screen.getByTestId("auth-password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByTestId("customer-password-register"));

    const notice = await screen.findByTestId("customer-signup-next");
    expect(notice.textContent).toContain("会員情報の登録");
  });

  test("導線は form ビューへのリンクである(押せば行き先がある)", async () => {
    anonymousStub(manifestWithMemberForm());
    render(<App />);
    await screen.findByTestId("customer-password-register");

    fireEvent.change(screen.getByTestId("auth-username"), { target: { value: "kaimono" } });
    fireEvent.change(screen.getByTestId("auth-password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByTestId("customer-password-register"));

    const notice = await screen.findByTestId("customer-signup-next");
    const link = notice.querySelector("a");
    expect(link?.getAttribute("href")).toBe(`/apps/${APP_ID}/views/member-form`);
  });

  test("【解けない】ログインしただけでは出ない(登録の直後だけの案内である)", async () => {
    anonymousStub(manifestWithMemberForm());
    render(<App />);
    await screen.findByTestId("password-login");

    fireEvent.change(screen.getByTestId("auth-username"), { target: { value: "kaimono" } });
    fireEvent.change(screen.getByTestId("auth-password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByTestId("password-login"));

    await screen.findByTestId("current-user");
    expect(screen.queryByTestId("customer-signup-next")).toBeNull();
  });

  test("【実測】会員テーブルを持たないアプリでは、案内を1つも描かない", async () => {
    anonymousStub(manifestWithoutMemberForm());
    render(<App />);
    await screen.findByTestId("customer-password-register");

    fireEvent.change(screen.getByTestId("auth-username"), { target: { value: "kaimono" } });
    fireEvent.change(screen.getByTestId("auth-password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByTestId("customer-password-register"));

    await screen.findByTestId("current-user");
    expect(screen.queryByTestId("customer-signup-next")).toBeNull();
  });

  test("閉じれば消える(セッションの間ずっと出続けない)", async () => {
    anonymousStub(manifestWithMemberForm());
    render(<App />);
    await screen.findByTestId("customer-password-register");

    fireEvent.change(screen.getByTestId("auth-username"), { target: { value: "kaimono" } });
    fireEvent.change(screen.getByTestId("auth-password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByTestId("customer-password-register"));

    await screen.findByTestId("customer-signup-next");
    fireEvent.click(screen.getByTestId("customer-signup-next-dismiss"));
    await waitFor(() => {
      expect(screen.queryByTestId("customer-signup-next")).toBeNull();
    });
  });
});
