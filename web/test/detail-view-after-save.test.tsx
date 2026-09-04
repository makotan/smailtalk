/**
 * **詳細画面の書換ボタンが成立したあとの行き先**(`V10-M1-T01`。`NV-G3a` / `ADR-0358`)。
 *
 * ## この検査が言えないこと(**先に書く。誇張しない**)
 *
 * 1. **`fetch` を差し替えている。** **本物のサーバを1度も叩いていない** ——
 *    書込が本当に成立したかどうかはサーバの担当であり、ここが見ているのは
 *    「表示層が 200 を受け取ったあとに何をするか」だけである。
 * 2. **happy-dom であり、chromium で1度も確かめていない**(`web/e2e` に1本も足していない)。
 * 3. **【禁止】「保存後の行き先が詳細画面にも書けるようになった」と読まない** ——
 *    **詳細画面に『保存』は無い。** **移るのは `set` 形(値の書換)の書込が成立したとき
 *    だけであり、`run` 形(自動処理の起動)の後は1ミリも移らない**(`ADR-0358` 限定2)。
 * 4. **【禁止】「ボタンごとに行き先を選べる」と読まない**(限定5)—— **画面に1本である。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { DetailView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";

/**
 * **書ける立場**(`V4-M2-T06` と同じ作法)。**文字列リテラルで `role="owner"` と書くと
 * biome の a11y 規則(`useValidAriaRole`)が HTML の `role` 属性と誤認するので、
 * 変数経由で渡す**(`web/test/detail-view.test.tsx` と1バイトも同じ形である)。
 */
const WRITER_ROLE: Role = "owner";

import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";

const APP_ID = "shop";
const RECORD_ID = "order-0001";
const ORDERS_PATH = `/api/apps/${APP_ID}/tables/orders/records`;
const RUN_PATH = `/api/apps/${APP_ID}/views/order-detail/actions/run`;
const HERE = `/apps/${APP_ID}/views/order-detail/records/${RECORD_ID}`;

const ORDER_ROW = {
  _id: RECORD_ID,
  _created_at: "2026-01-01T00:00:00Z",
  _updated_at: "2026-01-02T00:00:00Z",
  title: "注文1",
  status: "受付",
};

/** 形 (ii): 値の書換。**これだけが行き先を発火させる**(限定2)。 */
const SET_ACTION = { set: { field: "status", value: "完了" }, name: "完了にする" };
/** 形 (iv): 自動処理の起動。**この後は1ミリも移らない**(限定2)。 */
const RUN_ACTION = { run: "ship", name: "発送する" };

let originalFetch: typeof fetch;
let patchResponse: { status: number; body: unknown };
let runResponse: { status: number; body: unknown };
let patchCount: number;

/**
 * `entry-detail` に操作起点と(任意で)行き先を差し込む。
 * **行き先の候補として `order-list`(一覧)を1本置いてある。**
 */
function manifestWith(overrides: Partial<DetailView>): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "店",
      tables: [
        {
          id: "orders",
          name: "注文",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "status", name: "状態", type: "select", options: ["受付", "完了"] },
          ],
        },
        { id: "notice", name: "通知", fields: [{ id: "title", name: "件名", type: "text" }] },
      ],
      views: [
        { id: "order-detail", type: "detail_view", table: "orders", ...overrides },
        { id: "order-list", type: "list_view", table: "orders", columns: ["title"] },
      ],
      workflows: [
        {
          id: "ship",
          name: "発送する",
          trigger: { type: "manual", table: "orders" },
          actions: [{ action: "create_record", table: "notice", values: { title: "発送" } }],
          history_table: "notice",
        },
      ],
    },
  } as unknown as Manifest;
}

beforeEach(() => {
  patchCount = 0;
  patchResponse = {
    status: 200,
    body: { record: { ...ORDER_ROW, status: "完了", _updated_at: "2026-01-03T00:00:00Z" } },
  };
  runResponse = { status: 200, body: { workflow: "ship", record: RECORD_ID, failures: [] } };
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (method === "PATCH") {
      patchCount += 1;
      return json(patchResponse.body, patchResponse.status);
    }
    if (method === "POST" && url.startsWith(RUN_PATH)) {
      return json(runResponse.body, runResponse.status);
    }
    if (method === "GET" && url === `${ORDERS_PATH}/${RECORD_ID}`) {
      return json({ record: ORDER_ROW });
    }
    if (method === "GET" && url.startsWith(ORDERS_PATH)) {
      return json({ records: [ORDER_ROW] });
    }
    return json({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", HERE);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

async function renderDetail(manifest: Manifest): Promise<void> {
  const view = manifest.app.views[0];
  if (view === undefined || view.type !== "detail_view") {
    throw new Error("fixture broken");
  }
  render(
    <RoleProvider role={WRITER_ROLE}>
      <DetailViewRenderer appId={APP_ID} manifest={manifest} view={view} recordId={RECORD_ID} />
    </RoleProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("detail-field-title")).toBeDefined());
}

// ---------------------------------------------------------------------------
// (a) set の書込が成立したときだけ、宣言した行き先へ移る(ADR-0358 限定2)
// ---------------------------------------------------------------------------

test("(a) set の書込が成立すると、宣言した行き先へ移る", async () => {
  await renderDetail(manifestWith({ actions: [SET_ACTION] as never, after_save: "order-list" }));
  screen.getByTestId("action-set-status").click();
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/order-list`);
  });
});

test("(a) 書込が失敗したら移らない(成立したときだけである)", async () => {
  patchResponse = { status: 403, body: { errors: [{ path: "", message: "権限がありません" }] } };
  await renderDetail(manifestWith({ actions: [SET_ACTION] as never, after_save: "order-list" }));
  screen.getByTestId("action-set-status").click();
  await waitFor(() => expect(screen.getByTestId("write-forbidden")).toBeDefined());
  expect(window.location.pathname).toBe(HERE);
});

test("(a) 宣言した行き先がこのマニフェストに無ければ、その場に留まる(壊れない)", async () => {
  await renderDetail(manifestWith({ actions: [SET_ACTION] as never, after_save: "nowhere" }));
  screen.getByTestId("action-set-status").click();
  await waitFor(() => expect(patchCount).toBe(1));
  expect(window.location.pathname).toBe(HERE);
});

// ---------------------------------------------------------------------------
// (b) run の後は1ミリも移らない(ADR-0358 限定2。成否が確定していないため)
// ---------------------------------------------------------------------------

test("(b) run(自動処理の起動)の後は、行き先を宣言していても移らない", async () => {
  await renderDetail(manifestWith({ actions: [RUN_ACTION] as never, after_save: "order-list" }));
  screen.getByTestId("action-run-ship").click();
  await waitFor(() => expect(screen.getByTestId("action-run-ship")).toBeDefined());
  expect(window.location.pathname).toBe(HERE);
});

test("(b) 同じ画面に set と run が並んでいても、移るのは set のときだけである", async () => {
  await renderDetail(
    manifestWith({ actions: [RUN_ACTION, SET_ACTION] as never, after_save: "order-list" }),
  );
  screen.getByTestId("action-run-ship").click();
  await waitFor(() => expect(screen.getByTestId("action-set-status")).toBeDefined());
  expect(window.location.pathname).toBe(HERE);
  screen.getByTestId("action-set-status").click();
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/order-list`);
  });
});

// ---------------------------------------------------------------------------
// (c) 宣言が無い詳細画面の挙動は1文字も変わらない(ADR-0358 限定7 と同じ精神)
// ---------------------------------------------------------------------------

test("(c) 行き先を宣言していない詳細画面は、set を押しても URL が1バイトも変わらない", async () => {
  await renderDetail(manifestWith({ actions: [SET_ACTION] as never }));
  screen.getByTestId("action-set-status").click();
  await waitFor(() => expect(patchCount).toBe(1));
  expect(window.location.pathname).toBe(HERE);
});
