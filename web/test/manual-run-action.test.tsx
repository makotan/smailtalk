/**
 * **一覧の行と詳細画面から自動処理を起こすボタン**(`V5-M25-T08`。`L-G8` / `ADR-0174` /
 * `ADR-0176`)。
 *
 * ## この検査が言えないこと(**先に書く。誇張しない**)
 *
 * 1. **`fetch` を差し替えている。** **本物のサーバを1度も叩いていない** ——
 *    **サーバ側の判定(誰が起こせるか / 409 / 監査記録)は
 *    `src/server/manual-trigger-route.test.ts` が本物の HTTP で測っている。**
 * 2. **happy-dom であり、chromium で1度も確かめていない。**
 * 3. **【禁止】「二重押しが防げるようになった」と読まない** —— **押している間ボタンを
 *    止めるのは先回りガードであって、規則は入口が持つ**(`ADR-0175`)。
 * 4. **【禁止】「押した人が実行履歴に残る」と読まない** —— **履歴は今日も5列である。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ListView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";

const APP_ID = "shop";
const RECORDS_PATH = `/api/apps/${APP_ID}/tables/orders/records`;
const RUN_PATH = `/api/apps/${APP_ID}/views/order-list/actions/run`;

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
    _updated_at: "2026-01-02T00:00:00Z",
    title: "注文2",
    state: "done",
  },
];

const RUN_ACTION = { run: "ship", name: "発送する" };

let originalFetch: typeof fetch;
/** **入口へ実際に飛んだ要求の URL**(1本ずつ積む)。 */
let runCalls: string[];
/** 入口が返す応答(テストごとに差し替える)。 */
let runResponse: { status: number; body: unknown };

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
            { id: "state", name: "状態", type: "text" },
          ],
        },
        { id: "notice", name: "通知", fields: [{ id: "title", name: "件名", type: "text" }] },
      ],
      views: [
        { id: "order-list", type: "list_view", table: "orders", columns: ["title", "state"] },
        { id: "order-detail", type: "detail_view", table: "orders" },
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
  runCalls = [];
  runResponse = { status: 200, body: { workflow: "ship", record: "order-a", failures: [] } };
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (method === "POST" && url.startsWith(RUN_PATH)) {
      runCalls.push(url);
      return json(runResponse.body, runResponse.status);
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

async function renderList(
  extra?: Partial<ListView>,
  role: Role = "owner",
  // **【`V8-M20` / `J-G29`】マニフェストを差し替えられるようにした** —— **ボタンの
  // 「見せる相手」は `view_action.audience` ではなく `app.roles[].rules` に書くので、
  // 題材はビューではなくマニフェスト側に持たせる必要がある。**
  built: Manifest = manifest(),
): Promise<void> {
  const target = { ...(built.app.views[0] as ListView), ...(extra ?? {}) } as ListView;
  render(
    <RoleProvider role={role}>
      <ListViewRenderer appId={APP_ID} manifest={built} view={target} />
    </RoleProvider>,
  );
  await waitFor(() => expect(screen.getAllByTestId("list-row").length).toBe(ROWS.length));
}

// ---------------------------------------------------------------------------
// (a) 行ごとにボタンが出て、押すと入口へ飛ぶ
// ---------------------------------------------------------------------------

test("(a) 行ごとに1つずつボタンが出る", async () => {
  await renderList({ actions: [RUN_ACTION] } as Partial<ListView>);
  expect(screen.getAllByTestId("list-action-run-ship")).toHaveLength(ROWS.length);
});

test("(a) 押すと、その行を対象に入口へ POST する(対象は押した行1行だけ)", async () => {
  await renderList({ actions: [RUN_ACTION] } as Partial<ListView>);
  fireEvent.click(screen.getAllByTestId("list-action-run-ship")[1] as HTMLElement);
  await waitFor(() => expect(runCalls).toHaveLength(1));
  expect(runCalls[0]).toBe(`${RUN_PATH}?workflow=ship&record=order-b`);
});

test("(a) 押しても画面は移らない(遷移の形ではない)", async () => {
  await renderList({ actions: [RUN_ACTION] } as Partial<ListView>);
  fireEvent.click(screen.getAllByTestId("list-action-run-ship")[0] as HTMLElement);
  await waitFor(() => expect(runCalls).toHaveLength(1));
  expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/order-list`);
});

test("(a) 文言は宣言した name。書かなければ既定の文言が出る", async () => {
  await renderList({ actions: [RUN_ACTION] } as Partial<ListView>);
  expect((screen.getAllByTestId("list-action-run-ship")[0] as HTMLElement).textContent).toBe(
    "発送する",
  );
  cleanup();
  await renderList({ actions: [{ run: "ship" }] } as Partial<ListView>);
  expect((screen.getAllByTestId("list-action-run-ship")[0] as HTMLElement).textContent).toBe(
    "実行する",
  );
});

test("(a) visible_when は行ごとに1回ずつ評価される(4形目でも同じ実装1本である)", async () => {
  await renderList({
    actions: [{ run: "ship", visible_when: { field: "state", equals: "new" } }],
  } as Partial<ListView>);
  expect(screen.getAllByTestId("list-action-run-ship")).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// (b) 出し分け —— **先回りガードである**
// ---------------------------------------------------------------------------

test("(b) viewer には出ない(書ける相手でないため)", async () => {
  await renderList({ actions: [RUN_ACTION] } as Partial<ListView>, "viewer");
  expect(screen.queryAllByTestId("list-action-run-ship")).toHaveLength(0);
});

test("(b) 面の規則が名指ししたボタンは、その役割でない相手には出ない(判定は既存の1本)", async () => {
  // **【`V8-M20` / 台帳 `J-G29`(判定 = 廃止)/ 手続きは `ADR-0301` で宣言の置き場を移した。
  // 旧のテスト名と旧の書き方を1バイトも消していない】**
  // **旧テスト名**: 「(b) audience の列挙外には出ない(判定は既存の1本)」。
  // **旧の書き方**: `{ actions: [{ ...RUN_ACTION, audience: ["owner"] }] }`。
  // **今日**: `app.roles[].rules` の
  // `{ target: "action", view: <画面ID>, action: <ボタンID>, can: ["read"] }` で名指しする。
  // **測っている問い(名指しの外の相手にはボタンが出ない)は1ミリも変えていない。**
  // **【正直に書く。同じにならない1点】** **面はボタンを `view_action.id` で名指しするので、
  // 識別子を書いていない操作起点は名指しできず、今日どおり出る**(旧層は `id` が無くても
  // 効いていた)。**下の (b) の4本目がその事実をそのまま記録する。**
  const built = manifest();
  built.app.roles = [
    {
      id: "owner",
      rules: [{ target: "action", view: "order-list", action: "run-ship", can: ["read"] }],
    },
  ];
  await renderList(
    { actions: [{ ...RUN_ACTION, id: "run-ship" }] } as Partial<ListView>,
    "editor",
    built,
  );
  expect(screen.queryAllByTestId("list-action-run-ship")).toHaveLength(0);
});

test("(b) 識別子を書いていない操作起点は、面から名指しできないので今日どおり出る", async () => {
  // **【`V8-M20` / `J-G29` が足した1本。誇張しない】** **旧層(`view_action.audience`)は
  // `id` が無くても効いていた。** **面は `(画面ID, ボタンID)` で名指しするので、`id` の無い
  // 起点には壁が1本も立たない。** **これは穴であり、隠さずに固定しておく。**
  const built = manifest();
  built.app.roles = [
    {
      id: "owner",
      rules: [{ target: "action", view: "order-list", action: "run-ship", can: ["read"] }],
    },
  ];
  await renderList({ actions: [RUN_ACTION] } as Partial<ListView>, "editor", built);
  expect(screen.getAllByTestId("list-action-run-ship")).toHaveLength(ROWS.length);
});

test("(b) 実在しない自動処理を指すボタンは出ない(fail-closed)", async () => {
  await renderList({ actions: [{ run: "nope" }] } as Partial<ListView>);
  expect(screen.queryAllByTestId("list-action-run-nope")).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// (c) 失敗を黙って捨てない(憲法6)
// ---------------------------------------------------------------------------

test("(c) 入口が 409 を返したら、その理由が画面に出る", async () => {
  runResponse = {
    status: 409,
    body: { errors: [{ path: "", message: "この行に対して今まさに実行中です。" }] },
  };
  await renderList({ actions: [RUN_ACTION] } as Partial<ListView>);
  fireEvent.click(screen.getAllByTestId("list-action-run-ship")[0] as HTMLElement);
  await waitFor(() =>
    expect(screen.getByTestId("list-action-run-error").textContent).toContain("実行中"),
  );
});

test("(c) アクションが失敗したら、その説明が画面に出る(200 でも黙らない)", async () => {
  runResponse = {
    status: 200,
    body: { workflow: "ship", record: "order-a", failures: ["アクション1 が失敗しました"] },
  };
  await renderList({ actions: [RUN_ACTION] } as Partial<ListView>);
  fireEvent.click(screen.getAllByTestId("list-action-run-ship")[0] as HTMLElement);
  await waitFor(() =>
    expect(screen.getByTestId("list-action-run-error").textContent).toContain("失敗"),
  );
});

test("(c) 成功したら理由は1つも出ない", async () => {
  await renderList({ actions: [RUN_ACTION] } as Partial<ListView>);
  fireEvent.click(screen.getAllByTestId("list-action-run-ship")[0] as HTMLElement);
  await waitFor(() => expect(runCalls).toHaveLength(1));
  expect(screen.queryByTestId("list-action-run-error")).toBeNull();
});
