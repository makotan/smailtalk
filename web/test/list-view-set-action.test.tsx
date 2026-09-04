/**
 * **一覧の行の set 形(値の書換)**(`V5-M25-T07` = `V5-M21-T02` の実装。`L-G3` /
 * `ADR-0171` 限定10 の順序拘束が解けた)。
 *
 * ## この検査が言えないこと(**先に書く**)
 *
 * 1. **`fetch` を差し替えている。** **本物のサーバを1度も叩いていない** ——
 *    **既存のレコード更新経路を1つも迂回していないことは「同じ `PATCH` を同じヘッダで
 *    投げる」ところまでしか測っていない**(`writable_by` / ロール判定 / `If-Match` の
 *    判定そのものはサーバ側にあり、`src/server/` の既存検査が固定している)。
 * 2. **【禁止】「二重押しが防げるようになった」と読まない** —— **set 形の冪等性は今日も
 *    1つも無い。** **押した回数だけ書込が起きる**(`ADR-0100` §限界1)。
 * 3. **happy-dom であり、chromium で1度も確かめていない。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ListView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";

const APP_ID = "shop";
const RECORDS_PATH = `/api/apps/${APP_ID}/tables/orders/records`;

const ROWS = [
  {
    _id: "order-a",
    _created_at: "2026-01-01T00:00:00Z",
    _updated_at: "2026-01-02T00:00:00Z",
    title: "注文1",
    state: "new",
  },
  {
    _id: "order-b",
    _created_at: "2026-01-01T00:00:00Z",
    _updated_at: "2026-01-03T00:00:00Z",
    title: "注文2",
    state: "new",
  },
];

const SET_ACTION = { set: { field: "state", value: "done" }, name: "完了にする" };

let originalFetch: typeof fetch;
/** **実際に飛んだ `PATCH`**(URL / ヘッダ / 本文をそのまま積む)。 */
let patchCalls: { url: string; ifMatch: string | null; body: string }[];

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "店",
      tables: [
        {
          id: "orders",
          name: "注文",
          fields: [
            { id: "title", name: "件名", type: "text" },
            { id: "state", name: "状態", type: "select", options: ["new", "done"] },
          ],
        },
      ],
      views: [
        { id: "order-list", type: "list_view", table: "orders", columns: ["title", "state"] },
      ],
    },
  } as unknown as Manifest;
}

beforeEach(() => {
  patchCalls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (method === "PATCH" && url.startsWith(RECORDS_PATH)) {
      const headers = new Headers(init?.headers as HeadersInit);
      patchCalls.push({
        url,
        ifMatch: headers.get("if-match"),
        body: String(init?.body ?? ""),
      });
      return json({ record: { ...ROWS[0], state: "done" } });
    }
    if (method === "GET" && url.startsWith(RECORDS_PATH)) {
      return json({ records: ROWS, total: ROWS.length });
    }
    return json({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/order-list`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

async function renderList(extra?: Partial<ListView>, role: Role = "owner"): Promise<void> {
  const built = manifest();
  const target = { ...(built.app.views[0] as ListView), ...(extra ?? {}) } as ListView;
  render(
    <RoleProvider role={role}>
      <ListViewRenderer appId={APP_ID} manifest={built} view={target} />
    </RoleProvider>,
  );
  await waitFor(() => expect(screen.getAllByTestId("list-row").length).toBe(ROWS.length));
}

test("(a) 行ごとに1つずつボタンが出る", async () => {
  await renderList({ actions: [SET_ACTION] } as Partial<ListView>);
  expect(screen.getAllByTestId("list-action-set-state")).toHaveLength(ROWS.length);
});

test("(a) 押すと、その行を対象に既存のレコード更新経路へ PATCH する(If-Match つき)", async () => {
  await renderList({ actions: [SET_ACTION] } as Partial<ListView>);
  fireEvent.click(screen.getAllByTestId("list-action-set-state")[1] as HTMLElement);
  await waitFor(() => expect(patchCalls).toHaveLength(1));
  const call = patchCalls[0];
  expect(call?.url).toBe(`${RECORDS_PATH}/order-b`);
  // **`If-Match` は押した行の版である**(`ADR-0017` の CAS を1つも迂回していない)。
  expect(call?.ifMatch).toBe("2026-01-03T00:00:00Z");
  // **書き換えるのは宣言した1項目だけである。**
  expect(JSON.parse(call?.body ?? "{}")).toEqual({ state: "done" });
});

test("(a) 押しても画面は移らない(値の書換は遷移しない)", async () => {
  await renderList({ actions: [SET_ACTION] } as Partial<ListView>);
  fireEvent.click(screen.getAllByTestId("list-action-set-state")[0] as HTMLElement);
  await waitFor(() => expect(patchCalls).toHaveLength(1));
  expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/order-list`);
});

test("(a) name を書かなければ既定の文言が出る", async () => {
  await renderList({ actions: [{ set: { field: "state", value: "done" } }] } as Partial<ListView>);
  expect((screen.getAllByTestId("list-action-set-state")[0] as HTMLElement).textContent).toBe(
    "この値にする",
  );
});

test("(b) viewer には出ない(書ける相手でないため)", async () => {
  await renderList({ actions: [SET_ACTION] } as Partial<ListView>, "viewer");
  expect(screen.queryAllByTestId("list-action-set-state")).toHaveLength(0);
});

test("(b) visible_when は行ごとに1回ずつ評価される", async () => {
  await renderList({
    actions: [{ ...SET_ACTION, visible_when: { field: "title", equals: "注文1" } }],
  } as Partial<ListView>);
  expect(screen.getAllByTestId("list-action-set-state")).toHaveLength(1);
});
