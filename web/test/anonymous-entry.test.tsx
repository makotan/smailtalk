/**
 * **未ログインの入口と、ログイン画面の専用の場所**(`V21-M4` / `ADR-0482` §5 `AN-G5` /
 * ユーザ決定 `D-V21-8`・`D-V21-17`・`D-V21-18` / メインの裁定 `D-V21-20`)。
 *
 * - (E1) 未ログインで `/apps/<id>`(画面を名乗らない URL)を開くと、**行の ID 無しで開ける公開の
 *   一覧画面(`list_view`)のうち、画面の並び順で最初のもの**が出る。 候補は `GET /public` の
 *   `views[]` から選ぶ。 **並び順の1番目が公開の詳細画面、2番目が公開の一覧画面**の対照を置き、
 *   2番目が出ることを見る(計画 §9-5 の C10)。
 * - (E2) 公開画面の中の「ログイン」導線の行き先は `/apps/<id>/login`。
 * - (E3) `/apps/<id>/login` は、公開の一覧画面を持つアプリでもログイン画面を出す。
 * - (E4) 公開の一覧画面を1つも持たないアプリ(公開画面が無い / 詳細画面だけ)は、今日どおり
 *   `/apps/<id>` でログイン画面。
 *
 * **配布の器(`RunnerShell`)の同じ4本は `web/test/runner-anonymous-entry.test.tsx` に在る。**
 *
 * **測らないこと(誇張しない)**: 本物のサーバには当てていない(`fetch` の差し替え)。 実ブラウザは
 * `web/e2e/anonymous-entry.e2e.ts`。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { App } from "../src/App.tsx";

const APP_ID = "entry-shop";

type PublicViewStub = Record<string, unknown>;

const PRODUCT_TABLE = {
  id: "product",
  name: "商品",
  fields: [
    { id: "name", name: "商品名", type: "text", required: true },
    { id: "price", name: "価格", type: "number" },
  ],
};

/** 並び順の1番目 = 公開の詳細画面(行の ID が要る)。 */
const DETAIL_VIEW: PublicViewStub = {
  id: "product-detail",
  name: "商品の詳細",
  type: "detail_view",
  table: "product",
  tables: [PRODUCT_TABLE],
};
/** 並び順の2番目 = 公開の一覧画面(入口に出るべきもの)。 */
const LIST_VIEW: PublicViewStub = {
  id: "product-list",
  name: "商品一覧",
  type: "list_view",
  table: "product",
  columns: ["name", "price"],
  tables: [PRODUCT_TABLE],
};
/** 並び順の3番目 = 2枚目の公開の一覧画面(入口に出てはならない)。 */
const SECOND_LIST_VIEW: PublicViewStub = {
  id: "product-list-2",
  name: "新着",
  type: "list_view",
  table: "product",
  columns: ["name"],
  tables: [PRODUCT_TABLE],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let originalFetch: typeof fetch;
let requested: string[];

/** 今日の製品経路: `me` 401 / `manifest` 401 / `public` 200。 */
function stubAnonymous(views: PublicViewStub[]): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const full = String(input);
    requested.push(full);
    const url = full.split("?")[0] ?? "";
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
      return Promise.resolve(jsonResponse({ app: { id: APP_ID, name: "入口の店" }, views }));
    }
    if (url === `/api/apps/${APP_ID}/tables/product/records`) {
      return Promise.resolve(
        jsonResponse({ records: [{ _id: "p1", name: "藻塩", price: 800 }], total: 1 }),
      );
    }
    return Promise.resolve(jsonResponse({ errors: [{ path: "", message: "no stub" }] }, 404));
  }) as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  requested = [];
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.history.replaceState({}, "", "/");
});

describe("未ログインの入口(育成用の版 App)", () => {
  test("(E1) 未ログインの入口は並び順で最初の公開一覧画面", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    stubAnonymous([DETAIL_VIEW, LIST_VIEW, SECOND_LIST_VIEW]);
    render(<App />);

    const workspace = await screen.findByTestId("anonymous-workspace");
    expect(screen.queryByTestId("login-page")).toBeNull();
    // **いま開いている画面は並び順の2番目(最初の一覧画面)。** 詳細画面(1番目)でも、
    // 2枚目の一覧画面(3番目)でもない。
    const current = workspace.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain("商品一覧");
    // 中身(行)が描かれる。
    const main = screen.getByTestId("workspace-main");
    await waitFor(() => expect(main.textContent).toContain("藻塩"));
    // 詳細画面の行を名乗る取得は1本も出ていない。
    expect(requested.some((url) => url.includes("/records/"))).toBe(false);
  });

  test("(E2) 導線の行き先は /apps/<id>/login", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    stubAnonymous([DETAIL_VIEW, LIST_VIEW]);
    render(<App />);

    const link = await screen.findByTestId("anonymous-login-link");
    expect(link.closest("a")?.getAttribute("href")).toBe(`/apps/${APP_ID}/login`);
    cleanup();

    // 画面を名乗った公開画面の導線も同じ行き先。
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/product-list`);
    stubAnonymous([DETAIL_VIEW, LIST_VIEW]);
    render(<App />);
    const named = await screen.findByTestId("anonymous-login-link");
    expect(named.closest("a")?.getAttribute("href")).toBe(`/apps/${APP_ID}/login`);
  });

  test("(E3) /apps/<id>/login はログイン画面", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}/login`);
    stubAnonymous([DETAIL_VIEW, LIST_VIEW]);
    render(<App />);

    const loginPage = await screen.findByTestId("login-page");
    expect(loginPage.textContent).toContain("入口の店にログイン");
    expect(screen.queryByTestId("anonymous-workspace")).toBeNull();
    // **ログイン画面は公開の一覧画面の行を読みに行かない。**
    expect(requested.some((url) => url.includes("/records"))).toBe(false);
  });

  test("(E4) 公開一覧画面の無いアプリはログイン画面", async () => {
    // 公開画面が1枚も無いアプリ。
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    stubAnonymous([]);
    render(<App />);
    expect(await screen.findByTestId("login-page")).toBeDefined();
    expect(screen.queryByTestId("anonymous-workspace")).toBeNull();
    cleanup();

    // 公開画面が詳細画面だけのアプリ(行の ID 無しで開ける公開の一覧画面が無い。`D-V21-20`)。
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    stubAnonymous([DETAIL_VIEW]);
    render(<App />);
    expect(await screen.findByTestId("login-page")).toBeDefined();
    expect(screen.queryByTestId("anonymous-workspace")).toBeNull();
  });
});
