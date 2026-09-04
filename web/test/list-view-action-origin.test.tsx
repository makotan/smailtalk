/**
 * **一覧(`list_view`)の行の操作起点の描画**(`V5-M21-T01`。`L-G1` / `L-G2` /
 * `ADR-0171` 限定1〜限定12)。
 *
 * **宣言と器を同じマイルストーンに入れている**(`ADR-0086` 限定4)——
 * **「一覧に書けるが描画が無視する」状態を作らない。**
 *
 * ## この検査が言えないこと(**先に書く。誇張しない**)
 *
 * 1. **【禁止】「一覧の行から押せるようになった」を、本物のブラウザで押す前に総括しない**
 *    (`ADR-0171` §限界1)。**ここは happy-dom であり、chromium で1度も確かめていない。**
 * 2. **【禁止】「二重押しが防げる」と読まない**(同 §限界2)—— **規則は今日1つも無い。**
 *    **一覧の操作起点は遷移だけで書込を1度も起こさない**(set 形は一覧では書けない)ので、
 *    **本タスクは「押した回数だけ書き込まれる」経路を一覧に1本も作っていない** ——
 *    **しかしそれは「二重押しが防げる」ことではない。**
 * 3. **【禁止】「一覧から何でも呼べるようになった」と読まない**(同 §限界5)——
 *    **複数行の一括操作は1ミリも解けていない。**
 * 4. **UI に出さないことは「押せない」ことではない**(限定9)—— **最終防衛線はサーバの
 *    403 / 404 であり、本ファイルは `fetch` をスタブしているので「サーバが実際に拒む」ことを
 *    1件も測っていない。**
 * 5. **`visible_when` を行ごとに評価する計算量を1度も測っていない**(`ADR-0171` §限界3)。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ListView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";
import { grantRules, viewRead } from "./role-rules.ts";

const APP_ID = "shop";
const RECORDS_PATH = `/api/apps/${APP_ID}/tables/goods/records`;

/** 2行。**在庫が違う**ので `visible_when` の行ごとの評価を測れる。 */
const ROWS = [
  {
    _id: "goods-a",
    _created_at: "2026-01-01T00:00:00Z",
    _updated_at: "2026-01-02T00:00:00Z",
    name: "在庫あり",
    stock: 3,
  },
  {
    _id: "goods-b",
    _created_at: "2026-01-01T00:00:00Z",
    _updated_at: "2026-01-02T00:00:00Z",
    name: "在庫なし",
    stock: 0,
  },
];

const NAVIGATE = { form: "cart-form", prefill: { field: "item" }, name: "カートに入れる" };

let originalFetch: typeof fetch;

function manifest(): Manifest {
  const built = {
    app: {
      id: APP_ID,
      name: "店",
      tables: [
        {
          id: "goods",
          name: "商品",
          fields: [
            { id: "name", name: "名前", type: "text" },
            { id: "stock", name: "在庫", type: "number" },
          ],
        },
        {
          id: "carts",
          name: "カート",
          fields: [{ id: "item", name: "商品", type: "reference", reference_table: "goods" }],
        },
      ],
      views: [
        { id: "goods-list", type: "list_view", table: "goods", columns: ["name", "stock"] },
        { id: "goods-detail", type: "detail_view", table: "goods" },
        { id: "cart-form", type: "form", table: "carts", fields: ["item"] },
      ],
    },
  } as unknown as Manifest;
  // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`】既定が「閉じる」側へ倒れたので、
  // 規則を1本も書かない題材では**遷移先の `cart-form` を開けない**と判定され、
  // 3形目の操作起点が1つも描かれない(`ListViewRenderer` が `canUseView` を見る)。
  // **足すのはこの検査の主題に要る最小限だけである** —— **遷移先1画面 × 読取 ×
  // 出る側の2ロール。** **`viewer` には1本も足していない**((d) の期待値は
  // `canWriteRole` が止める側であって、面ではない)。
  return grantRules(built, ["owner", "editor"], [viewRead("cart-form")]);
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (method === "GET" && url.startsWith(RECORDS_PATH)) {
      return json({ records: ROWS, total: ROWS.length });
    }
    return json({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/goods-list`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

async function renderList(role: Role = "owner", extra?: Partial<ListView>): Promise<void> {
  const built = manifest();
  const target = { ...(built.app.views[0] as ListView), ...(extra ?? {}) } as ListView;
  render(
    <RoleProvider role={role}>
      <ListViewRenderer appId={APP_ID} manifest={built} view={target} />
    </RoleProvider>,
  );
  await waitFor(() => expect(screen.getAllByTestId("list-row").length).toBe(ROWS.length));
}

// ---------------------------------------------------------------------------
// (a) 行ごとに操作起点が出る
// ---------------------------------------------------------------------------

test("(a) actions を書いた一覧では、行ごとに操作起点のボタンが1つずつ出る", async () => {
  await renderList("owner", { actions: [NAVIGATE] } as Partial<ListView>);
  expect(screen.getAllByTestId("list-action-origin-cart-form")).toHaveLength(ROWS.length);
});

test("(a) ボタンの文言は宣言した name である", async () => {
  await renderList("owner", { actions: [NAVIGATE] } as Partial<ListView>);
  for (const button of screen.getAllByTestId("list-action-origin-cart-form")) {
    expect(button.textContent).toBe("カートに入れる");
  }
});

test("(a) name を書かなければ既定の文言が出る", async () => {
  await renderList("owner", {
    actions: [{ form: "cart-form", prefill: { field: "item" } }],
  } as Partial<ListView>);
  for (const button of screen.getAllByTestId("list-action-origin-cart-form")) {
    expect(button.textContent).toBe("新規作成へ");
  }
});

test("(a) actions を書かない一覧には、操作起点のセルもボタンも1つも出ない", async () => {
  await renderList();
  expect(screen.queryAllByTestId("list-action-origin-cart-form")).toHaveLength(0);
  expect(screen.queryByTestId("list-action-cell")).toBeNull();
});

// ---------------------------------------------------------------------------
// (b) 押すと「押した行」の _id を引き継いで遷移する(限定2 / L-G2)
// ---------------------------------------------------------------------------

test("(b) 押すと遷移先 form へ行き、押した行の _id が URL のプリフィルに載る", async () => {
  await renderList("owner", { actions: [NAVIGATE] } as Partial<ListView>);
  const buttons = screen.getAllByTestId("list-action-origin-cart-form");
  fireEvent.click(buttons[1] as HTMLElement);
  await waitFor(() => expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/cart-form`));
  // **押した行(2行目)の `_id` だけが載る** —— 1行目の `_id` は1文字も出ない。
  expect(window.location.search).toBe("?prefill.item=goods-b");
});

test("(b) 1行目を押したときは1行目の _id が載る(行ごとに違う値を運ぶ)", async () => {
  await renderList("owner", { actions: [NAVIGATE] } as Partial<ListView>);
  fireEvent.click(screen.getAllByTestId("list-action-origin-cart-form")[0] as HTMLElement);
  await waitFor(() => expect(window.location.search).toBe("?prefill.item=goods-a"));
});

test("(b) ボタンを押しても行クリックの遷移(詳細画面)は起きない(二重発火しない)", async () => {
  await renderList("owner", { actions: [NAVIGATE] } as Partial<ListView>);
  fireEvent.click(screen.getAllByTestId("list-action-origin-cart-form")[0] as HTMLElement);
  await waitFor(() => expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/cart-form`));
  // 詳細画面(`goods-detail`)へは1度も行っていない。
  expect(window.location.pathname).not.toContain("goods-detail");
});

// ---------------------------------------------------------------------------
// (c) visible_when は行ごとに1回ずつ評価される(§Decision 4)
// ---------------------------------------------------------------------------

test("(c) 条件を満たす行にだけ出る(在庫1以上の行にだけ出る)", async () => {
  await renderList("owner", {
    actions: [{ ...NAVIGATE, visible_when: { field: "stock", gte: 1 } }],
  } as Partial<ListView>);
  const buttons = screen.getAllByTestId("list-action-origin-cart-form");
  expect(buttons).toHaveLength(1);
  // 出たのは1行目(在庫3)の行の中である。
  const row = buttons[0]?.closest("[data-testid='list-row']");
  expect(row?.textContent).toContain("在庫あり");
});

test("(c) 条件を書かなければ全部の行に出る(既定を反転させていない)", async () => {
  await renderList("owner", { actions: [NAVIGATE] } as Partial<ListView>);
  expect(screen.getAllByTestId("list-action-origin-cart-form")).toHaveLength(ROWS.length);
});

// ---------------------------------------------------------------------------
// (d) 先回りガード(限定9)—— 判定先は遷移先 form のテーブルである
// ---------------------------------------------------------------------------

test("(d) viewer には操作起点を1つも出さない(先回りガード。防御ではない)", async () => {
  await renderList("viewer", { actions: [NAVIGATE] } as Partial<ListView>);
  expect(screen.queryAllByTestId("list-action-origin-cart-form")).toHaveLength(0);
});

test("(d) editor には出る", async () => {
  await renderList("editor", { actions: [NAVIGATE] } as Partial<ListView>);
  expect(screen.getAllByTestId("list-action-origin-cart-form")).toHaveLength(ROWS.length);
});

// ---------------------------------------------------------------------------
// (e) カードの器でも同じ挙動(器の形で操作が割れない)
// ---------------------------------------------------------------------------

test("(e) カード表示でも、カードごとに操作起点が1つずつ出る", async () => {
  const built = manifest();
  const target = {
    ...(built.app.views[0] as ListView),
    preset_list_shape: "card",
    actions: [NAVIGATE],
  } as ListView;
  const role: Role = "owner";
  render(
    <RoleProvider role={role}>
      <ListViewRenderer appId={APP_ID} manifest={built} view={target} />
    </RoleProvider>,
  );
  await waitFor(() => expect(screen.getAllByTestId("list-card").length).toBe(ROWS.length));
  expect(screen.getAllByTestId("list-action-origin-cart-form")).toHaveLength(ROWS.length);
});
