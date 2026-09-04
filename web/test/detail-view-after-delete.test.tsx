/**
 * **削除の後の行き先**(`V10-M1-T02`。`NV-G4` / `ADR-0359` §4a)。
 *
 * ## この検査が言えないこと(**先に書く。誇張しない**)
 *
 * 1. **`fetch` を差し替えている。** **本物のサーバを1度も叩いていない** ——
 *    削除が本当に成立したかどうかはサーバの担当であり、ここが見ているのは
 *    「表示層が 204 を受け取ったあとにどこへ行くか」だけである。
 * 2. **happy-dom であり、chromium で1度も確かめていない**(`web/e2e` に1本も足していない)。
 * 3. **【禁止】「削除の確認が宣言できるようになった」と読まない**(`ADR-0359` §4a 限定6)
 *    —— **確認ダイアログには1バイトも触っていない。**
 * 4. **【禁止】「テーブルに紐づかないお別れの画面へ行ける」と読まない**(限定7)——
 *    **行き先は同じアプリの実在するビューIDだけである。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { DetailView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";

/** **書ける立場**(`web/test/detail-view-after-save.test.tsx` と1バイトも同じ作法)。 */
const WRITER_ROLE: Role = "owner";

import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";

const APP_ID = "shop";
const RECORD_ID = "order-0001";
const ORDERS_PATH = `/api/apps/${APP_ID}/tables/orders/records`;
const HERE = `/apps/${APP_ID}/views/order-detail/records/${RECORD_ID}`;

const ORDER_ROW = {
  _id: RECORD_ID,
  _created_at: "2026-01-01T00:00:00Z",
  _updated_at: "2026-01-02T00:00:00Z",
  title: "注文1",
};

let originalFetch: typeof fetch;
let deleteStatus: number;
let deleteCount: number;

/**
 * 行き先の候補を3本置く。
 *
 * - `order-list` —— **同じテーブルの一覧**(= 宣言が無いときの既定の行き先)。
 * - `other-list` —— **別のテーブルの一覧**(宣言でしか行けない)。
 * - `order-report` —— **集計表**(限定4 が許す2種目)。
 */
function manifestWith(overrides: Partial<DetailView>, options: { withOwnList?: boolean } = {}) {
  const views = [
    { id: "order-detail", type: "detail_view", table: "orders", ...overrides },
    ...(options.withOwnList === false
      ? []
      : [{ id: "order-list", type: "list_view", table: "orders", columns: ["title"] }]),
    { id: "other-list", type: "list_view", table: "notice", columns: ["title"] },
    {
      id: "order-report",
      type: "report_view",
      table: "orders",
      report: { group_by: [{ field: "title" }], aggregates: [{ type: "count" }] },
    },
  ];
  return {
    app: {
      id: APP_ID,
      name: "店",
      tables: [
        {
          id: "orders",
          name: "注文",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
        },
        { id: "notice", name: "通知", fields: [{ id: "title", name: "件名", type: "text" }] },
      ],
      views,
    },
  } as unknown as Manifest;
}

beforeEach(() => {
  deleteCount = 0;
  deleteStatus = 204;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (method === "DELETE") {
      deleteCount += 1;
      return deleteStatus === 204
        ? new Response(null, { status: 204 })
        : json({ errors: [{ path: "", message: "権限がありません" }] }, deleteStatus);
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

/** **確認ダイアログには1バイトも触っていない**(限定6)—— 今日どおり2段である。 */
async function deleteRecord(): Promise<void> {
  screen.getByTestId("detail-delete").click();
  await waitFor(() => expect(screen.getByTestId("detail-delete-execute")).toBeDefined());
  screen.getByTestId("detail-delete-execute").click();
}

// ---------------------------------------------------------------------------
// (a) 宣言した行き先へ移る(ADR-0359 §4a 限定4)
// ---------------------------------------------------------------------------

test("(a) 別のテーブルの一覧を宣言すると、削除の後そこへ移る", async () => {
  await renderDetail(manifestWith({ after_delete: "other-list" } as Partial<DetailView>));
  await deleteRecord();
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/other-list`);
  });
  expect(deleteCount).toBe(1);
});

test("(a) 集計表を宣言すると、削除の後そこへ移る(行を必要としない画面の2種目)", async () => {
  await renderDetail(manifestWith({ after_delete: "order-report" } as Partial<DetailView>));
  await deleteRecord();
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/order-report`);
  });
});

test("(a) 削除が失敗したら移らない(成立したときだけである)", async () => {
  deleteStatus = 403;
  await renderDetail(manifestWith({ after_delete: "other-list" } as Partial<DetailView>));
  await deleteRecord();
  await waitFor(() => expect(screen.getByTestId("write-forbidden")).toBeDefined());
  expect(window.location.pathname).toBe(HERE);
});

// ---------------------------------------------------------------------------
// (b) 宣言が無いときの既定は1文字も変わらない(ADR-0359 §4a 限定5)
// ---------------------------------------------------------------------------

test("(b) 宣言が無ければ同じテーブルの一覧へ移る(着手前と1バイトも同じ)", async () => {
  await renderDetail(manifestWith({}));
  await deleteRecord();
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/order-list`);
  });
});

test("(b) 宣言が無く、同じテーブルの一覧も無ければアプリのビュー一覧へ移る(着手前と1バイトも同じ)", async () => {
  await renderDetail(manifestWith({}, { withOwnList: false }));
  await deleteRecord();
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/apps/${APP_ID}`);
  });
});

test("(b) 宣言した画面がこのマニフェストに無ければ、既定へ倒れる(壊れない)", async () => {
  await renderDetail(manifestWith({ after_delete: "nowhere" } as Partial<DetailView>));
  await deleteRecord();
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/order-list`);
  });
});
