/**
 * **未ログインの公開画面で、参照が代表項目の名前で出ること**(`V21-M3`。`ADR-0482` の `AN-G4`)。
 *
 * - `GET /public` の画面の `tables` に参照先の表が載っていれば(= サーバが「未ログインで読める」と
 *   判定した)、画面は今の `resolveReference` のまま名前を出す。
 * - 載っていなければ(読めない表・代表項目を隠した表)、今日どおり「(見つかりません: 行ID)」。
 *   **その表の行を読みに行かない**(読みに行くと 401 で画面ごと失敗する)。
 * - 配布用の器(`RunnerShell`)も同じ組み立て(`publicManifest`)を使うので、同じ表示になる。
 *
 * ## この検査が測らないこと(誇張しない)
 *
 * - **本物のサーバに当てていない**(`fetch` の差し替え)。 どの表を載せるかの判定は
 *   `src/kernel/anonymous-public-view-reference-http.test.ts`、実ブラウザは
 *   `web/e2e/anonymous-reference-label.e2e.ts` が持つ。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { App } from "../src/App.tsx";
import { RunnerShell } from "../src/runner-app.tsx";

const APP_ID = "anon-ref-label";

const PRODUCT = {
  id: "product",
  name: "商品",
  fields: [
    { id: "name", name: "商品名", type: "text", required: true },
    { id: "cat", name: "カテゴリ", type: "reference", reference_table: "category" },
    { id: "maker", name: "製造元", type: "reference", reference_table: "maker" },
  ],
};

const CATEGORY = {
  id: "category",
  name: "カテゴリ",
  fields: [{ id: "name", name: "名前", type: "text" }],
};

/** `GET /public` の応答。 `withCategory` = 参照先の表(カテゴリ)が未ログインで読める。 */
function publicInfo(withCategory: boolean) {
  return {
    app: { id: APP_ID, name: "参照の名前表示" },
    views: [
      {
        id: "v_list",
        name: "商品一覧",
        type: "list_view",
        table: "product",
        columns: ["name", "cat", "maker"],
        tables: withCategory ? [PRODUCT, CATEGORY] : [PRODUCT],
      },
    ],
    signup: { kinds: [], adminInvite: false },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let originalFetch: typeof fetch;
/** 読みに行った表の一覧(`?` の前の URL)。 */
let requested: string[] = [];

function stub(withCategory: boolean): void {
  requested = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input).split("?")[0] ?? "";
    requested.push(url);
    if (url === `/api/apps/${APP_ID}/auth/me`) {
      return Promise.resolve(jsonResponse({ errors: [{ path: "", message: "未認証" }] }, 401));
    }
    if (url === `/api/apps/${APP_ID}/manifest`) {
      return Promise.resolve(jsonResponse({ errors: [{ path: "", message: "未認証" }] }, 401));
    }
    if (url === `/api/apps/${APP_ID}/public`) {
      return Promise.resolve(jsonResponse(publicInfo(withCategory)));
    }
    if (url === `/api/apps/${APP_ID}/tables/product/records`) {
      return Promise.resolve(
        jsonResponse({
          records: [{ _id: "p1", name: "藻塩", cat: "c1", maker: "m1" }],
          total: 1,
        }),
      );
    }
    if (url === `/api/apps/${APP_ID}/tables/category/records`) {
      return Promise.resolve(
        jsonResponse({ records: [{ _id: "c1", name: "カテゴリ-塩" }], total: 1 }),
      );
    }
    // **読めない表は 401**(サーバの今日の答え)。
    return Promise.resolve(jsonResponse({ errors: [{ path: "", message: "未認証" }] }, 401));
  }) as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/v_list`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.history.replaceState({}, "", "/");
});

for (const [label, draw] of [
  ["本体の画面", () => render(<App />)],
  ["配布用の器", () => render(<RunnerShell appId={APP_ID} />)],
] as const) {
  test(`(R-1) ${label}: 参照先の表が渡っていれば、参照は代表項目の名前で出る`, async () => {
    stub(true);
    draw();
    const main = await screen.findByTestId("workspace-main");
    await waitFor(() => expect(main.textContent).toContain("藻塩"));
    expect(main.textContent).toContain("カテゴリ-塩");
    expect(main.textContent).not.toContain("(見つかりません: c1)");
    // **渡っていない表(製造元)は今日どおり「見つかりません」。 読みに行かない。**
    expect(main.textContent).toContain("(見つかりません: m1)");
    expect(requested).not.toContain(`/api/apps/${APP_ID}/tables/maker/records`);
  });

  test(`(R-2) ${label}: 参照先の表が渡っていなければ、今日どおり「見つかりません」で、その表を読みに行かない`, async () => {
    stub(false);
    draw();
    const main = await screen.findByTestId("workspace-main");
    await waitFor(() => expect(main.textContent).toContain("藻塩"));
    expect(main.textContent).toContain("(見つかりません: c1)");
    expect(main.textContent).not.toContain("カテゴリ-塩");
    expect(requested).not.toContain(`/api/apps/${APP_ID}/tables/category/records`);
  });
}
