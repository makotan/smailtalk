/**
 * **未ログインのまま公開画面が「実際に描かれる」こと**の検査(`V8-M26-T05`)。
 *
 * ## 由来と、この検査が塞いだ穴
 *
 * - **台帳 `T-G27b`** —— **`V8-M25` は「保留」、`V8-M26` が再審査して「限定採用」。**
 * - **ユーザ決定 `D-V8-57`**(選ばれた見出し = **実際に開けるようにする**)。
 *
 * **`web/test/anonymous-view.test.tsx` の (e) は、`GET /manifest` を **200** で返す差し替えの
 * 上で測っている** —— **`V8-M21` 以降、その口は未ログインで **401** なので、あの (e) は
 * 今日の製品経路を1バイトも通っていない。** **本ファイルは 401 → `GET /public` の経路を
 * そのまま測る。**
 *
 * ## この検査が測らないこと(**誇張しない**)
 *
 * - **本物のサーバに当てていない**(`fetch` の差し替えである)。**サーバ側の契約は
 *   `src/server/anonymous-public-view.test.ts` が、実ブラウザは
 *   `web/e2e/anonymous-public-view.e2e.ts` が持つ。3つを混ぜない。**
 * - **UI が隠すことは遮断ではない**(`ADR-0053:41`)。**遮断はサーバの 401 / 403 である。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { App } from "../src/App.tsx";

const APP_ID = "pub-open";

/** `GET /public` の応答(**今日の形**。画面の定義 + その画面が描くのに要る表の定義)。 */
function publicInfo() {
  return {
    app: { id: APP_ID, name: "みどり商店" },
    views: [
      {
        id: "public-catalog",
        name: "商品一覧",
        type: "list_view",
        table: "product",
        columns: ["name", "price"],
        tables: [
          {
            id: "product",
            name: "商品",
            fields: [
              { id: "name", name: "商品名", type: "text", required: true },
              { id: "price", name: "価格", type: "number" },
              { id: "st_public", name: "公開", type: "boolean" },
            ],
          },
        ],
      },
    ],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let originalFetch: typeof fetch;

/**
 * **今日の製品経路をそのまま写す** —— **`me` が 401 / `manifest` が 401 /
 * `public` が 200。** **`manifest` を 200 で返さない**(そこが `anonymous-view.test.tsx` の
 * (e) との違いである)。
 */
function stub(records: Record<string, unknown>[] = []): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input).split("?")[0] ?? "";
    if (url === `/api/apps/${APP_ID}/auth/me`) {
      return Promise.resolve(
        jsonResponse({ errors: [{ path: "", message: "認証されていません。" }] }, 401),
      );
    }
    if (url === `/api/apps/${APP_ID}/manifest`) {
      return Promise.resolve(
        jsonResponse({ errors: [{ path: "", message: "認証が必要です。" }] }, 401),
      );
    }
    if (url === `/api/apps/${APP_ID}/public`) {
      return Promise.resolve(jsonResponse(publicInfo()));
    }
    if (url.endsWith("/records")) {
      return Promise.resolve(jsonResponse({ records, total: records.length }));
    }
    return Promise.resolve(jsonResponse({ errors: [{ path: "", message: "no stub" }] }, 404));
  }) as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.history.replaceState({}, "", "/");
});

test("(f) 未ログインのまま公開画面を直接開くと、中身が描かれる(ログイン画面に落ちない)", async () => {
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/public-catalog`);
  stub([{ _id: "r1", name: "藻塩", price: 800 }]);
  render(<App />);

  // **画面の枠が出る**(`AnonymousWorkspace`)。
  await waitFor(() => expect(screen.getByTestId("anonymous-workspace")).toBeDefined());
  // **【この1本が `AppWorkspace.tsx:170` の旧の逐語を覆した実測である】** ——
  // **旧文: 「未ログインのまま公開画面を開くこと…は、今日から成り立たない」。**
  expect(screen.queryByTestId("login-page")).toBeNull();
  // **中身(行)が並ぶ。**
  const main = screen.getByTestId("workspace-main");
  await waitFor(() => expect(main.textContent).toContain("藻塩"));
  // **項目の見出し(画面の作り)も渡っている** —— **`D-V8-57` の説明文が代償として
  // 名指しした「項目の並び」そのものである。**
  expect(main.textContent).toContain("商品名");
  expect(main.textContent).toContain("価格");
});

test("(f) ログイン画面への導線は残る(T-G26b / T-G28。ログイン画面は今日どおり必ず開ける)", async () => {
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/public-catalog`);
  stub([{ _id: "r1", name: "藻塩", price: 800 }]);
  render(<App />);

  await waitFor(() => expect(screen.getByTestId("anonymous-workspace")).toBeDefined());
  expect(screen.getByTestId("anonymous-login-link")).toBeDefined();
  // **ログイン済みの導線は1つも出さない**(旧からの継続。緩めていない)。
  for (const id of ["logout", "open-account", "open-user-admin", "current-role"]) {
    expect(screen.queryByTestId(id), id).toBeNull();
  }
});

test("(f) 画面を名乗らない URL では、今日どおりログイン画面が出る", async () => {
  window.history.replaceState({}, "", `/apps/${APP_ID}`);
  stub();
  render(<App />);

  const loginPage = await screen.findByTestId("login-page");
  expect(loginPage.textContent).toContain("みどり商店にログイン");
  // **公開画面への導線は今日どおり並ぶ**(`D-V4-20` (b))。
  expect(screen.getByTestId("anonymous-views").querySelectorAll("a").length).toBe(1);
});

test("(f) 渡っていない画面を URL で名乗っても、ログイン画面に落ちる", async () => {
  // **判定は表示層に無い** —— **`GET /public` に載っていないので開けない。**
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/admin-product-list`);
  stub();
  render(<App />);

  await screen.findByTestId("login-page");
  expect(screen.queryByTestId("anonymous-workspace")).toBeNull();
});
