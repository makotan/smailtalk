/**
 * **一覧の検索の口** —— 表示層(`V4-M22-T02`。`ADR-0112` 限定7・限定9・限定10・限定12)。
 *
 * **限定表の正は [`docs/adr/0112-view-search-fields.md`](../../docs/adr/0112-view-search-fields.md) §Decision 3**、
 * 完了条件の正は `docs/plan/v4/records/v4-m22.md` §1-2 の `V4-M22-T02` の行。
 *
 * ## このファイルが固定すること
 *
 * | # | 限定 | 検査 |
 * |---|---|---|
 * | (a) | **限定12** 書かなかった画面の DOM は今日と1バイトも変わらない | 着手前の DOM を採った fixture(`__fixtures__/list-view-plain.html`)と**完全一致** |
 * | (b) | **限定10** 宣言と器が同じマイルストーンで揃っている(「書けるが効かない」を作らない) | 宣言を書いた画面にだけ入力欄が出る |
 * | (c) | **限定7** 照合は `contains` の OR で固定 | 実際に飛んだ URL の `filter` を1葉ずつ読む |
 * | (d) | **限定9** 画面の `view.filter` を外せない | 必ず `and` で結ぶ / `view.filter` を1バイトも書き換えない |
 * | (e) | **限定8** 検索語はマニフェストに1バイトも入らない | 語を打っても書込のリクエストが0件・マニフェストが不変 |
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * 1. **本物の SQLite で1件も測っていない。** ここは `fetch` を差し替えた表示層の検査であり、
 *    **サーバが同じ `filter` をどう解釈するかは `V4-M22-T04` が本物で測る。**
 * 2. **`st_owner` の post-filter と `view.audience` の遮断を1件も測っていない**(同じく `T04`)。
 * 3. **ブラウザの計算値も、支援技術での使い勝手も1つも測っていない。**
 * 4. **性能を1度も測っていない** —— `contains` の OR は索引に乗らない見込みだが、測っていない
 *    (`ADR-0112` §限界4)。
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import type { ListView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";

const PLAIN_LIST_HTML = readFileSync(
  join(import.meta.dir, "__fixtures__", "list-view-plain.html"),
  "utf-8",
).trim();

const APP_ID = "shape-app";

/**
 * 一覧を描くときに名乗るロール(`V4-M19-T10` の追記)。**定数にしてあるのは、
 * `<RoleProvider role="owner">` と文字列で書くと biome の `useValidAriaRole` が
 * `role` を ARIA 属性と読んで赤にするためである。**
 */
const OWNER_ROLE: Role = "owner";
const RECORD_A = "rec-a";
const RECORD_B = "rec-b";

/** **`list-view-shape.test.tsx` (d) と同じフィクスチャである**(DOM の完全一致を採るため)。 */
function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "形のサンプル",
      tables: [
        {
          id: "items",
          name: "備品",
          fields: [
            { id: "name", name: "備品名", type: "text" },
            { id: "quantity", name: "数量", type: "number" },
            { id: "vendor", name: "仕入先", type: "reference", reference_table: "vendors" },
          ],
        },
        {
          id: "vendors",
          name: "仕入先",
          fields: [{ id: "vendor_name", name: "名称", type: "text" }],
        },
      ],
      views: [
        {
          id: "item-list",
          type: "list_view",
          table: "items",
          columns: ["name", "quantity", "vendor"],
        },
        { id: "item-detail", type: "detail_view", table: "items" },
        { id: "vendor-detail", type: "detail_view", table: "vendors" },
      ],
    },
  } as unknown as Manifest;
}

function listWith(overrides: Partial<ListView>): Manifest {
  const manifest = baseManifest();
  Object.assign(manifest.app.views[0] as ListView, overrides);
  return manifest;
}

const ITEM_ROWS = [
  {
    _id: RECORD_A,
    _created_at: "",
    _updated_at: "",
    name: "会議テーブル",
    quantity: 3,
    vendor: "vendor-1",
  },
  { _id: RECORD_B, _created_at: "", _updated_at: "", name: "椅子", quantity: 12, vendor: null },
];

const VENDOR_ROWS = [
  { _id: "vendor-1", _created_at: "", _updated_at: "", vendor_name: "山田商会" },
];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

let originalFetch: typeof fetch;
/** **飛んだリクエストの全量**(メソッドつき)。書込が1件も無いことをここで数える。 */
let calls: { url: string; method: string }[] = [];

beforeEach(() => {
  calls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
    if (url.includes("/tables/items/records")) {
      return jsonResponse({ records: ITEM_ROWS, total: ITEM_ROWS.length });
    }
    if (url.includes("/tables/vendors/records")) {
      return jsonResponse({ records: VENDOR_ROWS, total: VENDOR_ROWS.length });
    }
    return jsonResponse({ records: [], total: 0 });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

async function renderList(manifest: Manifest = baseManifest()): Promise<HTMLElement> {
  // **【`V4-M19-T10` の追記。既存の行を1バイトも消していない】**
  // **`RoleProvider role="owner"` で包むようになった** —— `V4-M19-T10` が CSV の書き出し口を
  // 「買い物客と未ログインには出さない」に絞ったので、**包まずに描くと `useRole()` が `null` を
  // 返して口が消え、フィクスチャ(`__fixtures__/list-view-plain.html`)と一致しなくなる。**
  // **フィクスチャが表しているのは「運営が見ている素の一覧」である。**
  // **包んでも DOM に要素は1つも増えない**(`RoleProvider` はコンテキストだけである)ので、
  // **この行がフィクスチャの中身を変えることは無い。** 先例は `V4-M2-T06` が `form.test.tsx` /
  // `detail-view.test.tsx` を `RoleProvider role="owner"` で包んだ形である。
  render(
    <RoleProvider role={OWNER_ROLE}>
      {createElement(ListViewRenderer, {
        appId: APP_ID,
        manifest,
        view: manifest.app.views[0] as ListView,
      })}
    </RoleProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("view-renderer-list_view")).toBeDefined());
  await waitFor(() => expect(screen.queryByTestId("list-table")).not.toBeNull());
  return screen.getByTestId("view-renderer-list_view");
}

/** 対象テーブルの一覧取得のうち**最後のもの**の `filter` を JSON として読む。 */
function lastItemFilter(): unknown {
  const itemCalls = calls.filter(
    (call) => call.url.includes("/tables/items/records") && call.method === "GET",
  );
  const last = itemCalls.at(-1);
  if (last === undefined) {
    throw new Error("items の取得が1件も無い");
  }
  const raw = new URL(last.url, "http://localhost").searchParams.get("filter");
  return raw === null ? undefined : JSON.parse(raw);
}

async function typeSearch(word: string): Promise<void> {
  const input = screen.getByTestId("list-search-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: word } });
  await waitFor(() => expect(screen.queryByTestId("list-table")).not.toBeNull());
}

// ---------------------------------------------------------------------------
// (a) 限定12: 書かなかった画面は今日と1バイトも変わらない
// ---------------------------------------------------------------------------

test("(a) 限定12: search_fields を書かない一覧の DOM が着手前と完全一致する", async () => {
  const section = await renderList();
  // **完全一致**(入力欄1つ・属性1つの追加も赤になる)。**基準は `V4-M16-T13` が
  // 着手前に採った実物のフィクスチャであり、本タスクは1バイトも作り直していない。**
  expect(section.outerHTML).toBe(PLAIN_LIST_HTML);
});

test("(a) 限定12: 書かない画面の取得 URL に filter が1つも載らない", async () => {
  await renderList();
  expect(lastItemFilter()).toBeUndefined();
});

// ---------------------------------------------------------------------------
// (b) 限定10: 宣言を書いた画面にだけ器が出る(「書けるが効かない」を作らない)
// ---------------------------------------------------------------------------

test("(b) 限定10: search_fields を書いた画面には検索の入力欄が1つ出る", async () => {
  await renderList(listWith({ search_fields: ["name"] }));
  const input = screen.getByTestId("list-search-input") as HTMLInputElement;
  expect(input.tagName).toBe("INPUT");
  expect(input.getAttribute("type")).toBe("search");
  // **入力欄には名前が付いている**(何を打つ欄かが分かる)。
  expect(input.getAttribute("id")).not.toBeNull();
  expect(document.querySelector(`label[for="${input.getAttribute("id")}"]`)).not.toBeNull();
});

test("(b) 限定10: 書かない画面には入力欄が1つも出ない", async () => {
  await renderList();
  expect(screen.queryByTestId("list-search-input")).toBeNull();
  expect(screen.queryByTestId("list-search")).toBeNull();
});

// ---------------------------------------------------------------------------
// (c) 限定7: 照合は `contains` の OR で固定する
// ---------------------------------------------------------------------------

test("(c) 限定7: 打った語は、宣言した列ぶんの contains を or で結んだ形になる", async () => {
  await renderList(listWith({ search_fields: ["name"] }));
  await typeSearch("椅子");
  expect(lastItemFilter()).toEqual({ or: [{ field: "name", contains: "椅子" }] });
});

test("(c) 限定7: 複数の列を宣言すると、宣言した順に1葉ずつ並ぶ", async () => {
  const manifest = listWith({ search_fields: ["name", "vendor"] });
  // **型の検査はカーネル(`referential-integrity.ts`)が持つ。** ここは表示層の形だけを見る。
  await renderList(manifest);
  await typeSearch("山田");
  expect(lastItemFilter()).toEqual({
    or: [
      { field: "name", contains: "山田" },
      { field: "vendor", contains: "山田" },
    ],
  });
});

test("(c) 限定7: equals / gte / lte / in / not を1つも組み立てない", async () => {
  await renderList(listWith({ search_fields: ["name"] }));
  await typeSearch("椅子");
  const serialized = JSON.stringify(lastItemFilter());
  for (const forbidden of ["equals", "gte", "lte", '"in"', "not"]) {
    expect(serialized, forbidden).not.toContain(forbidden);
  }
});

test("(c) 限定7: 語を消すと検索の条件が消える(空の or を送らない)", async () => {
  await renderList(listWith({ search_fields: ["name"] }));
  await typeSearch("椅子");
  await typeSearch("");
  expect(lastItemFilter()).toBeUndefined();
});

test("(c) 限定7: 空白だけの語は検索の条件にしない", async () => {
  await renderList(listWith({ search_fields: ["name"] }));
  await typeSearch("   ");
  expect(lastItemFilter()).toBeUndefined();
});

// ---------------------------------------------------------------------------
// (d) 限定9: 画面の `view.filter` を外せない
// ---------------------------------------------------------------------------

test("(d) 限定9: 画面の filter が在るときは、必ず and で結ぶ", async () => {
  await renderList(
    listWith({
      search_fields: ["name"],
      filter: { field: "name", contains: "テーブル" },
    } as Partial<ListView>),
  );
  await typeSearch("会議");
  expect(lastItemFilter()).toEqual({
    and: [{ field: "name", contains: "テーブル" }, { or: [{ field: "name", contains: "会議" }] }],
  });
});

test("(d) 限定9: 旧来の等値AND配列で書かれた filter も and の中に丸ごと入る", async () => {
  await renderList(
    listWith({
      search_fields: ["name"],
      filter: [{ field: "name", equals: "椅子" }],
    } as unknown as Partial<ListView>),
  );
  await typeSearch("椅");
  expect(lastItemFilter()).toEqual({
    and: [
      { and: [{ field: "name", equals: "椅子" }] },
      { or: [{ field: "name", contains: "椅" }] },
    ],
  });
});

test("(d) 限定9: or / not で view.filter を無効化する経路を作っていない(最上位は必ず and)", async () => {
  await renderList(
    listWith({
      search_fields: ["name"],
      filter: { field: "name", contains: "テーブル" },
    } as Partial<ListView>),
  );
  await typeSearch("会議");
  expect(Object.keys(lastItemFilter() as object)).toEqual(["and"]);
});

test("(d) 限定9: view.filter を1バイトも書き換えない", async () => {
  const manifest = listWith({
    search_fields: ["name"],
    filter: { field: "name", contains: "テーブル" },
  } as Partial<ListView>);
  const before = JSON.stringify(manifest);
  await renderList(manifest);
  await typeSearch("会議");
  expect(JSON.stringify(manifest)).toBe(before);
});

test("(d) 限定9: 語を打っていないときの filter は、画面の filter そのものである", async () => {
  await renderList(
    listWith({
      search_fields: ["name"],
      filter: { field: "name", contains: "テーブル" },
    } as Partial<ListView>),
  );
  expect(lastItemFilter()).toEqual({ field: "name", contains: "テーブル" });
});

// ---------------------------------------------------------------------------
// (e) 限定8: 検索語はマニフェストに1バイトも入らない
// ---------------------------------------------------------------------------

test("(e) 限定8: 語を打っても書込のリクエストが1件も飛ばない", async () => {
  await renderList(listWith({ search_fields: ["name"] }));
  await typeSearch("椅子");
  expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
});

test("(e) 限定8: 語を打ってもマニフェストのどこにも語が現れない", async () => {
  const manifest = listWith({ search_fields: ["name"] });
  await renderList(manifest);
  await typeSearch("椅子");
  expect(JSON.stringify(manifest)).not.toContain("椅子");
  // **宣言に入っているのは列の名前だけである。**
  expect((manifest.app.views[0] as ListView).search_fields).toEqual(["name"]);
});

// ---------------------------------------------------------------------------
// ページ位置(`ADR-0042` 限定2 不可侵)
// ---------------------------------------------------------------------------

test("語を変えたら先頭ページへ戻る(ページ位置はマニフェストに1バイトも入らない)", async () => {
  await renderList(listWith({ search_fields: ["name"] }));
  await typeSearch("椅子");
  const last = calls.filter((call) => call.url.includes("/tables/items/records")).at(-1);
  // **`offset` は 0 のときに載せない**(着手前の作法を1バイトも変えていない)。
  expect(new URL(last?.url ?? "", "http://localhost").searchParams.get("offset")).toBeNull();
});

// ---------------------------------------------------------------------------
// V4-M22-T06: 1ページに出す件数(`ADR-0113` 限定2・限定8・限定10)
//
// **同じ画面(`list_view`)の器を触る2つ目の増分なので、器の検査もここに置く** ——
// 検索の入力欄と件数の解決が同じレンダラの中で干渉しないことも、ここで見る。
// ---------------------------------------------------------------------------

/** 取得の URL に載った `limit` を読む。 */
function lastItemLimit(): string | null {
  const last = calls
    .filter((call) => call.url.includes("/tables/items/records") && call.method === "GET")
    .at(-1);
  return new URL(last?.url ?? "", "http://localhost").searchParams.get("limit");
}

test("(f) 限定10: page_size を書かない一覧の DOM が着手前と完全一致する", async () => {
  const section = await renderList();
  expect(section.outerHTML).toBe(PLAIN_LIST_HTML);
});

test("(f) 限定10: 50 と明示した一覧の DOM も、書かなかった場合と完全一致する", async () => {
  const section = await renderList(listWith({ page_size: 50 } as Partial<ListView>));
  // **既定は 50 である** —— 明示しても DOM は1バイトも変わらない。
  expect(section.outerHTML).toBe(PLAIN_LIST_HTML);
});

test("(g) 書かない画面の取得は今日どおり 50 件である(既定を1バイトも変えていない)", async () => {
  await renderList();
  expect(lastItemLimit()).toBe("50");
});

test("(g) 限定2: 書いた値が実際に取得の件数になる(4値すべて)", async () => {
  for (const size of [10, 20, 50, 100] as const) {
    cleanup();
    calls = [];
    await renderList(listWith({ page_size: size } as Partial<ListView>));
    expect(lastItemLimit(), String(size)).toBe(String(size));
  }
});

test("(g) ページャの出る条件・ページ送りの幅が、同じ1つの解決値を使う(2つの数を作らない)", async () => {
  // **総件数 12 / `page_size` 10** —— 既定の 50 で判定していたらページャは出ない。
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
    if (url.includes("/tables/items/records")) {
      return jsonResponse({ records: ITEM_ROWS, total: 12 });
    }
    return jsonResponse({ records: [], total: 0 });
  }) as typeof fetch;

  await renderList(listWith({ page_size: 10 } as Partial<ListView>));
  const pager = screen.queryByTestId("list-pager");
  expect(pager).not.toBeNull();
  // ページ送りの幅も同じ解決値である(50 ではなく 10 進む)。
  fireEvent.click(screen.getByTestId("list-next"));
  await waitFor(() => expect(lastItemLimit()).toBe("10"));
  const last = calls
    .filter((call) => call.url.includes("/tables/items/records") && call.method === "GET")
    .at(-1);
  expect(new URL(last?.url ?? "", "http://localhost").searchParams.get("offset")).toBe("10");
});

test("(g) 件数の宣言はマニフェストに残り、ページ位置は1バイトも残らない(ADR-0042 限定2 不可侵)", async () => {
  const manifest = listWith({ page_size: 20 } as Partial<ListView>);
  await renderList(manifest);
  const view = manifest.app.views[0] as Record<string, unknown>;
  expect(view.page_size).toBe(20);
  // **ページ位置のキーは1本も生えない。**
  for (const forbidden of ["offset", "page", "current_page"]) {
    expect(Object.keys(view), forbidden).not.toContain(forbidden);
  }
});

test("(h) 検索と件数は同じ画面で干渉しない(2つの増分が同じレンダラで両立する)", async () => {
  await renderList(listWith({ search_fields: ["name"], page_size: 20 } as Partial<ListView>));
  await typeSearch("椅子");
  expect(lastItemLimit()).toBe("20");
  expect(lastItemFilter()).toEqual({ or: [{ field: "name", contains: "椅子" }] });
});

// ---------------------------------------------------------------------------
// 「書けるが効かない」を作っていないことの実測(`ADR-0086` 限定4)
// ---------------------------------------------------------------------------

test("(i) card の器でも検索の入力欄は出る(器の形と組み合わせても効かなくならない)", async () => {
  // **`preset_list_shape: "card"` と一緒に書いても、検索の口は消えない。**
  // **`card` のとき効かない軸(列の寄せ・列の幅)と同じ穴を作っていない**(`ADR-0093` 限定8)。
  render(
    createElement(ListViewRenderer, {
      appId: APP_ID,
      manifest: listWith({
        search_fields: ["name"],
        preset_list_shape: "card",
      } as Partial<ListView>),
      view: listWith({
        search_fields: ["name"],
        preset_list_shape: "card",
      } as Partial<ListView>).app.views[0] as ListView,
    }),
  );
  await waitFor(() => expect(screen.queryByTestId("list-cards")).not.toBeNull());
  expect(screen.queryByTestId("list-search-input")).not.toBeNull();
});

test("(i) 【正直に書く】columns に載っていない列も検索の対象に書け、実際に絞り込む", async () => {
  // **カーネルの実在照合は「対象テーブルに在ること」であり、`columns` 掲載を要求しない**
  // (`referential-integrity.ts` の類型2b が `preset_column_align` について既に採っている
  // 基準と一貫させた)。**したがって画面に出ていない列で絞り込める。**
  // **【これは「書けるが効かない」ではない】** —— **条件は実際に効く。**
  // **代償**: **利用者から見ると「なぜこの行が残ったのか」が画面から分からない。**
  // **機械では止めていない。** **止めるなら改めて門A を通すこと。**
  await renderList(listWith({ search_fields: ["vendor"] } as Partial<ListView>));
  await typeSearch("vendor-1");
  expect(lastItemFilter()).toEqual({ or: [{ field: "vendor", contains: "vendor-1" }] });
});
