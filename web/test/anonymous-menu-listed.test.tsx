/**
 * **未ログインのメニュー・ログイン画面の画面リンク・入口に「メニューに載せない」を効かせる**
 * (`ADR-0494` §Decision 1。未ログインのメニューとリンクは門の外、入口の選び方は `EN-G1`)。
 *
 * - (a) `menu_listed: false` の公開画面は、未ログインのメニュー(`anonymous-workspace` の中の `view-list`)に出ない。
 * - (b) ログイン画面の画面リンク(`anonymous-views`)にも出ない。
 * - (c) その画面の URL を直に開くと開く(開ける判定は絞らない。`ADR-0084` 限定5)。
 * - (d) 入口(`/apps/<id>`)は、メニューに載せる公開の一覧画面のうち並び順で最初のもの。
 * - (e) 公開の一覧画面が全部「載せない」なら、入口は今日の選び方(載せない画面も含めた最初の公開の一覧画面)。
 *   このときメニューに `aria-current` の項目は1つも無い。
 * - (f) `menu_listed` を書かないアプリは、メニュー・リンク・入口が今日と同じ(陰性対照)。
 * - (g) (a)〜(f) を配る版(`RunnerShell`)でも。
 * - (u) 選び方の部品(`menuListedViews` / `publicAnonymousMenuEntryView`)の単体。
 *
 * **測らないこと(誇張しない)**: 本物のサーバには当てていない(`fetch` の差し替え)。 実ブラウザは e2e。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import type { View } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
import * as workspaceModule from "../src/AppWorkspace.tsx";
import * as authzModule from "../src/auth/authz.tsx";
import { RunnerShell } from "../src/runner-app.tsx";

const APP_ID = "menu-listed-shop";

type PublicViewStub = Record<string, unknown>;

const PRODUCT_TABLE = {
  id: "product",
  name: "商品",
  fields: [
    { id: "name", name: "商品名", type: "text", required: true },
    { id: "price", name: "価格", type: "number" },
  ],
};

/** 並び順の1番目 = メニューに載せない公開の一覧画面(入口に出てはならない)。 */
const HIDDEN_LIST: PublicViewStub = {
  id: "hidden-list",
  name: "隠した一覧",
  type: "list_view",
  table: "product",
  columns: ["name", "price"],
  menu_listed: false,
  tables: [PRODUCT_TABLE],
};
/** 並び順の2番目 = 公開の詳細画面(載せる。行の ID が要るので入口にならない)。 */
const DETAIL_VIEW: PublicViewStub = {
  id: "product-detail",
  name: "商品の詳細",
  type: "detail_view",
  table: "product",
  tables: [PRODUCT_TABLE],
};
/** 並び順の3番目 = 載せる公開の一覧画面(入口に出るべきもの)。 */
const LISTED_LIST: PublicViewStub = {
  id: "product-list",
  name: "商品一覧",
  type: "list_view",
  table: "product",
  columns: ["name", "price"],
  tables: [PRODUCT_TABLE],
};
/** 並び順の4番目 = 2枚目の載せる公開の一覧画面(入口に出てはならない)。 */
const SECOND_LISTED_LIST: PublicViewStub = {
  id: "product-list-2",
  name: "新着",
  type: "list_view",
  table: "product",
  columns: ["name"],
  tables: [PRODUCT_TABLE],
};
/** 2枚目のメニューに載せない公開の一覧画面((e) の題材)。 */
const SECOND_HIDDEN_LIST: PublicViewStub = {
  id: "hidden-list-2",
  name: "隠した新着",
  type: "list_view",
  table: "product",
  columns: ["name"],
  menu_listed: false,
  tables: [PRODUCT_TABLE],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let originalFetch: typeof fetch;

/** 今日の製品経路: `me` 401 / `manifest` 401 / `public` 200。 */
function stubAnonymous(views: PublicViewStub[]): void {
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
      return Promise.resolve(jsonResponse({ app: { id: APP_ID, name: "載せ方の店" }, views }));
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
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.history.replaceState({}, "", "/");
});

/** 未ログインのメニューの項目(`<li>`)の文字の並び。 */
function menuItems(workspace: HTMLElement): string[] {
  const nav = within(workspace).getByTestId("view-list");
  return [...nav.querySelectorAll("li")].map((row) => row.textContent ?? "");
}

/** いま開いている項目の文字の並び。 */
function currentItems(workspace: HTMLElement): string[] {
  return [...workspace.querySelectorAll('[aria-current="page"]')].map(
    (row) => row.textContent ?? "",
  );
}

/** ログイン画面の画面リンクの文字の並び(リンクの節が無ければ空)。 */
function loginLinks(): string[] {
  const nav = screen.queryByTestId("anonymous-views");
  return nav === null ? [] : [...nav.querySelectorAll("li")].map((row) => row.textContent ?? "");
}

const SHELLS: readonly { readonly label: string; readonly element: () => ReactElement }[] = [
  { label: "育成用の版 App", element: () => <App /> },
  { label: "配る版 RunnerShell", element: () => <RunnerShell appId={APP_ID} /> },
];

for (const shell of SHELLS) {
  describe(`未ログインのメニューに載せない画面(${shell.label})`, () => {
    test("(a)(d) 入口は載せる公開の一覧画面の先頭で、載せない画面はメニューに出ない", async () => {
      window.history.replaceState({}, "", `/apps/${APP_ID}`);
      stubAnonymous([HIDDEN_LIST, DETAIL_VIEW, LISTED_LIST, SECOND_LISTED_LIST]);
      render(shell.element());

      const workspace = await screen.findByTestId("anonymous-workspace");
      expect(screen.queryByTestId("login-page")).toBeNull();
      const items = menuItems(workspace);
      expect(items.some((text) => text.includes("隠した一覧"))).toBe(false);
      expect(items.filter((text) => text.includes("商品一覧"))).toHaveLength(1);
      expect(items.filter((text) => text.includes("商品の詳細"))).toHaveLength(1);
      expect(items.filter((text) => text.includes("新着"))).toHaveLength(1);
      const current = currentItems(workspace);
      expect(current).toHaveLength(1);
      expect(current[0]).toContain("商品一覧");
      const main = within(workspace).getByTestId("workspace-main");
      await waitFor(() => expect(main.textContent).toContain("藻塩"));
    });

    test("(b) ログイン画面の画面リンクに載せない画面が出ない", async () => {
      window.history.replaceState({}, "", `/apps/${APP_ID}/login`);
      stubAnonymous([HIDDEN_LIST, DETAIL_VIEW, LISTED_LIST, SECOND_LISTED_LIST]);
      render(shell.element());

      await screen.findByTestId("login-page");
      const links = loginLinks();
      expect(links.some((text) => text.includes("隠した一覧"))).toBe(false);
      expect(links).toHaveLength(3);
    });

    test("(c) 載せない画面の URL を直に開くと開く(メニューには出ず、現在地の印も無い)", async () => {
      window.history.replaceState({}, "", `/apps/${APP_ID}/views/hidden-list`);
      stubAnonymous([HIDDEN_LIST, DETAIL_VIEW, LISTED_LIST, SECOND_LISTED_LIST]);
      render(shell.element());

      const workspace = await screen.findByTestId("anonymous-workspace");
      expect(screen.queryByTestId("login-page")).toBeNull();
      const main = within(workspace).getByTestId("workspace-main");
      await waitFor(() => expect(main.textContent).toContain("藻塩"));
      expect(menuItems(workspace).some((text) => text.includes("隠した一覧"))).toBe(false);
      expect(currentItems(workspace)).toEqual([]);
    });

    test("(e) 公開の一覧画面が全部「載せない」なら、入口は今日の選び方(最初の公開の一覧画面)", async () => {
      window.history.replaceState({}, "", `/apps/${APP_ID}`);
      stubAnonymous([HIDDEN_LIST, DETAIL_VIEW, SECOND_HIDDEN_LIST]);
      render(shell.element());

      const workspace = await screen.findByTestId("anonymous-workspace");
      expect(screen.queryByTestId("login-page")).toBeNull();
      // 入口は「隠した一覧」(並び順で最初の公開の一覧画面)。 行が描かれる。
      const main = within(workspace).getByTestId("workspace-main");
      await waitFor(() => expect(main.textContent).toContain("藻塩"));
      // メニューには載せる画面(詳細画面)だけが出て、現在地の印は1つも無い。
      const items = menuItems(workspace);
      expect(items).toHaveLength(1);
      expect(items[0]).toContain("商品の詳細");
      expect(currentItems(workspace)).toEqual([]);
    });

    test("(f) menu_listed を書かないアプリは、メニュー・リンク・入口が今日と同じ(陰性対照)", async () => {
      window.history.replaceState({}, "", `/apps/${APP_ID}`);
      stubAnonymous([DETAIL_VIEW, LISTED_LIST, SECOND_LISTED_LIST]);
      render(shell.element());

      const workspace = await screen.findByTestId("anonymous-workspace");
      const items = menuItems(workspace);
      expect(items).toHaveLength(3);
      expect(items[0]).toContain("商品の詳細");
      expect(items[1]).toContain("商品一覧");
      expect(items[2]).toContain("新着");
      const current = currentItems(workspace);
      expect(current).toHaveLength(1);
      expect(current[0]).toContain("商品一覧");
      cleanup();

      window.history.replaceState({}, "", `/apps/${APP_ID}/login`);
      stubAnonymous([DETAIL_VIEW, LISTED_LIST, SECOND_LISTED_LIST]);
      render(shell.element());
      await screen.findByTestId("login-page");
      expect(loginLinks()).toEqual(["商品の詳細", "商品一覧", "新着"]);
    });
  });
}

describe("(u) 選び方の部品", () => {
  const views = [HIDDEN_LIST, DETAIL_VIEW, LISTED_LIST, SECOND_LISTED_LIST] as unknown as View[];

  test("(u1) menuListedViews は載せない画面だけを外し、並びを保つ(書かない画面と真偽値でない値は載せる)", () => {
    const odd = { ...SECOND_LISTED_LIST, id: "odd", menu_listed: "no" } as unknown as View;
    const listed = authzModule.menuListedViews([...views, odd]);
    expect(listed.map((view) => view.id)).toEqual([
      "product-detail",
      "product-list",
      "product-list-2",
      "odd",
    ]);
  });

  test("(u2) publicAnonymousMenuEntryView は載せる公開の一覧画面の先頭、無ければ今日の選び方、それも無ければ無し", () => {
    expect(workspaceModule.publicAnonymousMenuEntryView(views)?.id).toBe("product-list");
    const allHidden = [HIDDEN_LIST, DETAIL_VIEW, SECOND_HIDDEN_LIST] as unknown as View[];
    expect(workspaceModule.publicAnonymousMenuEntryView(allHidden)?.id).toBe("hidden-list");
    expect(
      workspaceModule.publicAnonymousMenuEntryView([DETAIL_VIEW] as unknown as View[]),
    ).toBeUndefined();
    expect(workspaceModule.publicAnonymousMenuEntryView([])).toBeUndefined();
  });
});
