/**
 * **一覧の合計の表示** —— 表示層(`V4-M23-T03`。`ADR-0104` 限定4・限定5・限定11・限定12)。
 *
 * **限定表の正は [`docs/adr/0104-list-view-aggregate.md`](../../docs/adr/0104-list-view-aggregate.md) §Decision 5**、
 * 完了条件の正は `docs/plan/v4/records/v4-m23.md` §1-1 の `V4-M23-T03` の行。
 *
 * ## このファイルが固定すること
 *
 * | # | 何を | 根拠 |
 * |---|---|---|
 * | (a) | **書かなかった画面の DOM は今日と1バイトも変わらない** | 着手前の DOM を採った fixture(`__fixtures__/list-view-plain.html`)と**完全一致** |
 * | (b) | **宣言と器が同じマイルストーンで揃っている**(「書けるが効かない」を作らない) | `ADR-0086` 限定4 |
 * | (c) | **件数表示の隣に出る**(`V4-M23-T03` 完了条件 (1)) | —— |
 * | (d) | **母集団を画面の文言で示す**(「全 N 件」と同じ集合の合計であること) | `V4-M23-T03` 完了条件 (3) |
 * | (e) | **読取に `sum=<列>` が1つだけ載る**(2つ目の演算も束ねるキーも載らない) | 限定2 / 限定8 |
 * | (f) | **合計は書込を1件も起こさない** | 限定11 |
 * | (g) | **サーバが `sum` を返さない応答でも画面が壊れない** | —— |
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * 1. **本物の SQLite で1件も測っていない。** ここは `fetch` を差し替えた表示層の検査であり、
 *    **母集団が `total` と割れないことは `V4-M23-T02` が本物で測る。**
 * 2. **ブラウザの計算値も、支援技術での使い勝手も1つも測っていない。**
 * 3. **性能を1度も測っていない。**
 * 4. **`group_by` / `avg` / グラフを1つも測っていない** —— **実装が1バイトも無いからである。**
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
const OWNER_ROLE: Role = "owner";
const RECORD_A = "rec-a";
const RECORD_B = "rec-b";

/** **`list-view-search.test.tsx` (a) と同じフィクスチャである**(DOM の完全一致を採るため)。 */
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
let calls: { url: string; method: string }[] = [];
/** サーバが `sum` を返すかどうか(g の検査で切り替える)。 */
let serverReturnsSum = true;

beforeEach(() => {
  calls = [];
  serverReturnsSum = true;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
    if (url.includes("/tables/items/records")) {
      const asked = new URL(url, "http://localhost").searchParams.get("sum");
      return jsonResponse({
        records: ITEM_ROWS,
        total: ITEM_ROWS.length,
        // **サーバは求められたときだけ `sum` を返す**(サーバ側の実装と同じ形)。
        ...(asked !== null && serverReturnsSum ? { sum: 15 } : {}),
      });
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

/** 対象テーブルの一覧取得のうち**最後のもの**の URL を読む。 */
function lastItemUrl(): URL {
  const itemCalls = calls.filter(
    (call) => call.url.includes("/tables/items/records") && call.method === "GET",
  );
  const last = itemCalls.at(-1);
  if (last === undefined) {
    throw new Error("items の取得が1件も無い");
  }
  return new URL(last.url, "http://localhost");
}

// ---------------------------------------------------------------------------
// (a) 書かなかった画面は今日と1バイトも変わらない
// ---------------------------------------------------------------------------

test("(a) sum_field を書かない一覧の DOM が着手前と完全一致する", async () => {
  const section = await renderList();
  expect(section.outerHTML).toBe(PLAIN_LIST_HTML);
});

test("(a) sum_field を書かない一覧の読取 URL に sum が1つも載らない", async () => {
  await renderList();
  expect(lastItemUrl().searchParams.get("sum")).toBeNull();
});

// ---------------------------------------------------------------------------
// (b)(c)(d) 宣言と器が揃っている / 件数の隣に出る / 母集団を文言で示す
// ---------------------------------------------------------------------------

test("(b) sum_field を書いた一覧にだけ合計が出る", async () => {
  await renderList(listWith({ sum_field: "quantity" } as Partial<ListView>));
  await waitFor(() => expect(screen.queryByTestId("list-sum")).not.toBeNull());
  expect(screen.getByTestId("list-sum").textContent).toContain("15");
});

test("(b) 書かなかった画面には合計の器が1つも無い(書けるが効かないを作らない)", async () => {
  await renderList();
  expect(screen.queryByTestId("list-sum")).toBeNull();
});

test("(c) 合計は件数表示と同じ親の中にある(件数の隣に出る)", async () => {
  await renderList(listWith({ sum_field: "quantity" } as Partial<ListView>));
  await waitFor(() => expect(screen.queryByTestId("list-sum")).not.toBeNull());
  const total = screen.getByTestId("list-total");
  const sum = screen.getByTestId("list-sum");
  expect(total.parentElement).not.toBeNull();
  expect(total.parentElement).toBe(sum.parentElement);
});

test("(d) 合計の文言が、母集団は「全 N 件」と同じ集合であることを示している", async () => {
  await renderList(listWith({ sum_field: "quantity" } as Partial<ListView>));
  await waitFor(() => expect(screen.queryByTestId("list-sum")).not.toBeNull());
  const text = screen.getByTestId("list-sum").textContent ?? "";
  // **「今見えているページの合計」と読み違えられない文言であること。**
  expect(text).toContain("全 2 件");
  expect(text).toContain("数量");
  expect(text).toContain("合計");
});

test("(d) 合計に出す列名は、マニフェストの表示名である(フィールドIDを出さない)", async () => {
  await renderList(listWith({ sum_field: "quantity" } as Partial<ListView>));
  await waitFor(() => expect(screen.queryByTestId("list-sum")).not.toBeNull());
  const text = screen.getByTestId("list-sum").textContent ?? "";
  expect(text).toContain("数量");
  expect(text).not.toContain("quantity");
});

// ---------------------------------------------------------------------------
// (e) 読取に載るのは `sum=<列>` 1つだけである
// ---------------------------------------------------------------------------

test("(e) 読取 URL に sum=<列> が1つだけ載る", async () => {
  await renderList(listWith({ sum_field: "quantity" } as Partial<ListView>));
  const url = lastItemUrl();
  expect(url.searchParams.getAll("sum")).toEqual(["quantity"]);
});

test("(e) 2つ目の演算も、束ねるキーも、読取 URL に1つも載らない", async () => {
  await renderList(listWith({ sum_field: "quantity" } as Partial<ListView>));
  const url = lastItemUrl();
  for (const forbidden of ["avg", "min", "max", "count", "group_by", "having", "select"]) {
    expect(url.searchParams.get(forbidden), forbidden).toBeNull();
  }
});

test("(e) 参照ラベルの取得には sum を載せない(別テーブルである)", async () => {
  await renderList(listWith({ sum_field: "quantity" } as Partial<ListView>));
  const vendorCalls = calls.filter((call) => call.url.includes("/tables/vendors/records"));
  expect(vendorCalls.length).toBeGreaterThan(0);
  for (const call of vendorCalls) {
    expect(new URL(call.url, "http://localhost").searchParams.get("sum")).toBeNull();
  }
});

// ---------------------------------------------------------------------------
// (f) 合計は書込を1件も起こさない
// ---------------------------------------------------------------------------

test("(f) 合計を出しても書込のリクエストが1件も飛ばない", async () => {
  await renderList(listWith({ sum_field: "quantity" } as Partial<ListView>));
  const writes = calls.filter((call) => call.method !== "GET");
  expect(writes).toEqual([]);
});

// ---------------------------------------------------------------------------
// (g) サーバが `sum` を返さない応答でも画面が壊れない
// ---------------------------------------------------------------------------

test("(g) サーバが sum を返さないときは合計を出さない(0 と嘘をつかない)", async () => {
  serverReturnsSum = false;
  await renderList(listWith({ sum_field: "quantity" } as Partial<ListView>));
  // **行は出ている**(画面が壊れていない)。
  expect(screen.queryByTestId("list-table")).not.toBeNull();
  // **合計の器は出ない** —— **「0」と書くと「合計は0だった」という嘘になる。**
  expect(screen.queryByTestId("list-sum")).toBeNull();
});

// ---------------------------------------------------------------------------
// 限定4: `detail_view` / `form` には出ない(型の上でも器の上でも)
// ---------------------------------------------------------------------------

test("限定4: 合計の器は一覧の描画器の中にしか無い", async () => {
  const detailSource = readFileSync(
    join(import.meta.dir, "..", "src", "views", "DetailViewRenderer.tsx"),
    "utf-8",
  );
  const formSource = readFileSync(
    join(import.meta.dir, "..", "src", "views", "FormRenderer.tsx"),
    "utf-8",
  );
  expect(detailSource).not.toContain("sum_field");
  expect(detailSource).not.toContain("list-sum");
  expect(formSource).not.toContain("sum_field");
  expect(formSource).not.toContain("list-sum");
});
