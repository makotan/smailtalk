/**
 * **操作起点を「実際に行える人」にだけ自動で出す**(`V5-M23-T01`。`L-G13`。門 = **外**)。
 *
 * **審査記録**: [`docs/plan/v5/records/v5-m20.md`](../../docs/plan/v5/records/v5-m20.md) §2-4。
 * **実施記録**: [`docs/plan/v5/records/v5-m23.md`](../../docs/plan/v5/records/v5-m23.md)。
 *
 * ## 何を足したか(**1点だけである**)
 *
 * **着手前、操作起点の出し分けは `canWriteRole`(遷移先 form のテーブル基準)1本だけだった。**
 * **行き先の画面をその人が**使えるか**(`canUseView`)は1件も見ていなかった。**
 * **本ファイルはその1点を固定する。** **新しい述語を1本も作っていない** ——
 * **`canUseView` は `web/src/auth/authz.tsx` に着手前から在る関数である。**
 *
 * ## 【`V8-M26`(2026-08-10)。ユーザ決定 `D-V8-45` / `D-V8-65`】**`canUseView` の既定が反転した**
 *
 * **`V8-M26-T03` が `judgeRoleAccess` の既定を閉じる側へ倒したので、
 * `canUseView` は「規則を1本も名指ししていない画面」に今日から偽を返す**
 * (**役割を1つも宣言していないアプリも閉じる**)。
 *
 * **本ファイルが測っている問い(`canUseView` が偽なら、その行き先へのボタンを出さない)は
 * 1ミリも変えていない** —— **変わったのは「`canUseView` が偽になる条件」の側だけである。**
 * **その帰結として「名指しが無ければ出る」を測っていた3本の期待値を反転させた**
 * ((a) の3本目 / (b) の2本目 / (c) の2本目。**旧の逐語はその場に残した**)。
 * **題材(`manifest()`)には規則を1本も足していない。**
 *
 * ## この検査が言えないこと(**先に書く。誇張しない**)
 *
 * 1. **【禁止】「権限のある機能だけが出るようになった」と書かない**(06 §9 の 7)——
 *    **これは先回りガードであって防御ではない。** **最終防衛線は今日もサーバの 403 / 404 である。**
 * 2. **【禁止】「一覧の行クリックの穴が塞がった」と書かない** —— **`L-G15` は却下であり、
 *    行クリックの経路に本作業の差分は0行である**(`v5-m23.md` §4)。
 * 3. **ここは happy-dom である。** **本物のブラウザで1度も押していない。**
 * 4. **サーバが実際に何を落とすかは本ファイルでは1件も測っていない** ——
 *    **測るのは `src/server/view-action-audience.test.ts`(`V5-M23-T05`)である。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { DetailView, ListView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";

const APP_ID = "shop";
const CARTS_PATH = `/api/apps/${APP_ID}/tables/carts/records`;
const ORDERS_PATH = `/api/apps/${APP_ID}/tables/orders/records`;
const CART_ID = "cart-a";

const CART_ROW = {
  _id: CART_ID,
  _created_at: "2026-01-01T00:00:00Z",
  _updated_at: "2026-01-02T00:00:00Z",
  label: "かご1",
};

/**
 * **行き先の画面の「見せる相手」を1つずつ差し替えられるフィクスチャ。**
 *
 * - `order-detail`(行き先の宣言 = 3形目の行き先)
 * - `order-form`(遷移の形 = 1形目の行き先)
 *
 * **どちらのテーブルも `st_owner` も `st_public` も持たない**(= 運営テーブル)。
 * **したがって `customer` は `canReadTableRole` の段で落ちる** —— 本ファイルが測りたいのは
 * **画面ごとの宣言の段**なので、**customer 以外(`viewer` / `editor`)で測る。**
 *
 * ## 【`V8-M20`(2026-08-10)。台帳 `J-G27`。手続きは `ADR-0301`】**宣言の置き場が移った**
 *
 * **旧は画面に `audience: [...]` を直接書いていた**(引数名も `detailAudience` /
 * `formAudience` だった)。**そのキーは撤去され、画面の「見せる相手」は
 * `app.roles[].rules` の `{ target: "view", view: <画面ID>, can: ["read"] }` になった。**
 * **本ファイルが測っている問い(`canUseView` が偽なら、その行き先へのボタンを出さない)は
 * 1ミリも変えていない** —— **`L-G13` の自動判定そのものは1バイトも触っていない。**
 */
function manifest(options?: { detailRoles?: string[]; formRoles?: string[] }): Manifest {
  /** 「この画面を、この役割たちにだけ見せる」を面の規則へ組み立てる。 */
  const rulesFor = (viewId: string, roles: string[] | undefined): Record<string, unknown>[] =>
    (roles ?? []).map((role) => ({ role, view: viewId }));
  const pairs = [
    ...rulesFor("order-detail", options?.detailRoles),
    ...rulesFor("order-form", options?.formRoles),
  ];
  const roleIds = [...new Set(pairs.map((pair) => pair.role as string))];
  const roles = roleIds.map((id) => ({
    id,
    rules: pairs
      .filter((pair) => pair.role === id)
      .map((pair) => ({ target: "view", view: pair.view, can: ["read"] })),
  }));
  return {
    app: {
      id: APP_ID,
      name: "店",
      tables: [
        { id: "carts", name: "かご", fields: [{ id: "label", name: "名前", type: "text" }] },
        {
          id: "orders",
          name: "注文",
          fields: [
            { id: "cart", name: "かご", type: "reference", reference_table: "carts" },
            { id: "memo", name: "メモ", type: "text" },
          ],
        },
      ],
      views: [
        { id: "cart-list", type: "list_view", table: "carts", columns: ["label"] },
        { id: "cart-detail", type: "detail_view", table: "carts" },
        { id: "order-detail", type: "detail_view", table: "orders" },
        { id: "order-form", type: "form", table: "orders", fields: ["cart", "memo"] },
      ],
      roles,
    },
  } as unknown as Manifest;
}

/** 3形目(行き先の宣言)。**行き先は `order-detail`。** */
const LINK = { view: "order-detail", name: "会計へ進む" };
/** 1形目(遷移)。**行き先は `order-form`。** */
const NAVIGATE = { form: "order-form", prefill: { field: "cart" }, name: "注文を作る" };

let originalFetch: typeof fetch;

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
    if (method === "GET" && url === `${CARTS_PATH}/${CART_ID}`) {
      return json({ record: CART_ROW });
    }
    if (method === "GET" && url.startsWith(CARTS_PATH)) {
      return json({ records: [CART_ROW], total: 1 });
    }
    if (method === "GET" && url.startsWith(ORDERS_PATH)) {
      return json({ records: [], total: 0 });
    }
    return json({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/cart-list`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

async function renderList(
  actions: unknown[],
  role: Role,
  built: Manifest = manifest(),
): Promise<void> {
  const target = { ...(built.app.views[0] as ListView), actions } as ListView;
  render(
    <RoleProvider role={role}>
      <ListViewRenderer appId={APP_ID} manifest={built} view={target} />
    </RoleProvider>,
  );
  await waitFor(() => expect(screen.getAllByTestId("list-row").length).toBe(1));
}

async function renderDetail(
  actions: unknown[],
  role: Role,
  built: Manifest = manifest(),
): Promise<void> {
  const target = { ...(built.app.views[1] as DetailView), actions } as DetailView;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/cart-detail/records/${CART_ID}`);
  render(
    <RoleProvider role={role}>
      <DetailViewRenderer appId={APP_ID} manifest={built} view={target} recordId={CART_ID} />
    </RoleProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("detail-field-label")).toBeDefined());
}

// ---------------------------------------------------------------------------
// (a) 行き先の宣言(3形目)—— **行き先の画面を使えない相手には出さない**
// ---------------------------------------------------------------------------

test("(a) 行き先の画面を面が名指しし、自分が外れている相手には、その行き先のボタンが1つも出ない", async () => {
  // **【`V8-M20` / `J-G27`】旧テスト名(逐語)**: 「(a) 行き先の画面に audience を宣言して
  // 自分が外れている相手には、その行き先のボタンが1つも出ない」。**宣言の置き場が
  // `view.audience` から `app.roles[].rules` へ移っただけで、期待値は1バイトも変えていない。**
  await renderList([LINK], "viewer", manifest({ detailRoles: ["owner"] }));
  expect(screen.queryByTestId("list-action-link-order-detail")).toBeNull();
});

test("(a) 同じ宣言でも、列挙に載っている相手には今日どおり出る", async () => {
  await renderList([LINK], "owner", manifest({ detailRoles: ["owner"] }));
  expect(screen.getAllByTestId("list-action-link-order-detail")).toHaveLength(1);
});

test("(a) 行き先を面が1つも名指ししていなければ、今日は誰にも出ない(V8-M26 で既定が反転した)", async () => {
  // **【`V8-M20` / `J-G27`】旧テスト名(逐語)**: 「(a) 行き先に audience を1つも書いて
  // いなければ、着手前と同じく全員に出る(既定を反転させていない)」。
  //
  // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65` で期待値を反転させた。
  //   上の逐語も含めて1バイトも消していない】**
  // **`V8-M20` のテスト名**: 「(a) 行き先を面が1つも名指ししていなければ、着手前と同じく
  // 全員に出る(既定を反転させていない)」。
  // **`V8-M20` の期待値(逐語)**:
  //   `expect(screen.getAllByTestId("list-action-link-order-detail")).toHaveLength(1);`
  // **今日**: **`V8-M26-T03` が `judgeRoleAccess` の既定を閉じる側へ倒したので、
  // `canUseView`(行き先の画面)は規則が1本も無ければ偽になる** ——
  // **役割を1つも宣言していないアプリも閉じる**(`D-V8-65`)。
  // **【正直に書く】本ファイルが測っている問い(`canUseView` が偽ならボタンを出さない)は
  // 1ミリも変えていない。** **変わったのは「`canUseView` が偽になる条件」の側である。**
  // **【禁止の履行】これを「同じ挙動を保った」と書かない。既定は反転した。**
  await renderList([LINK], "viewer");
  expect(screen.queryByTestId("list-action-link-order-detail")).toBeNull();
});

// ---------------------------------------------------------------------------
// (b) 遷移の形(1形目)—— **書ける相手でも、その form を使えなければ出さない**
// ---------------------------------------------------------------------------

test("(b) 遷移先 form を面が名指しし、自分が外れている相手には、書ける相手でも出ない", async () => {
  // **【`V8-M20` / `J-G27`】旧テスト名(逐語)**: 「(b) 遷移先 form に audience を宣言して
  // 自分が外れている相手には、書ける相手でも出ない」。
  // **`editor` は `orders` に書ける**(`canWriteRole` は真)。**落とすのは `canUseView` である。**
  await renderList([NAVIGATE], "editor", manifest({ formRoles: ["owner"] }));
  expect(screen.queryByTestId("list-action-origin-order-form")).toBeNull();
});

test("(b) 遷移先 form を面が名指ししていなければ、今日は書ける相手にも出ない(V8-M26 で既定が反転した)", async () => {
  // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65` で期待値を反転させた。
  //   旧の逐語を1バイトも消していない】**
  // **旧テスト名**: 「(b) 遷移先 form を面が名指ししていなければ、着手前どおり書ける相手に出る」。
  // **旧の期待値(逐語)**:
  //   `expect(screen.getAllByTestId("list-action-origin-order-form")).toHaveLength(1);`
  // **今日**: **`editor` は `orders` に今日も書ける**(`canWriteRole` は真のまま。
  // **その判定は1バイトも変わっていない**)——**落としているのは `canUseView` の側であり、
  // 規則を1本も持たない `order-form` が閉じる側へ倒れたためである。**
  // **【禁止の履行】これを「同じ挙動を保った」と書かない。既定は反転した。**
  await renderList([NAVIGATE], "editor");
  expect(screen.queryByTestId("list-action-origin-order-form")).toBeNull();
});

test("(b) 書けない相手には着手前どおり出ない(canWriteRole の判定を1バイトも変えていない)", async () => {
  await renderList([NAVIGATE], "viewer");
  expect(screen.queryByTestId("list-action-origin-order-form")).toBeNull();
});

// ---------------------------------------------------------------------------
// (c) 詳細画面でも同じ1本が当たる(**判定を2箇所に割っていない**)
// ---------------------------------------------------------------------------

test("(c) 詳細画面でも、遷移先 form を面が名指しし、自分が外れている相手には出ない", async () => {
  // **【`V8-M20` / `J-G27`】旧テスト名(逐語)**: 「(c) 詳細画面でも、遷移先 form に
  // audience を宣言して自分が外れている相手には出ない」。
  await renderDetail([NAVIGATE], "editor", manifest({ formRoles: ["owner"] }));
  expect(screen.queryByTestId("action-origin-order-form")).toBeNull();
});

test("(c) 詳細画面でも、面の名指しが無ければ今日は出ない(V8-M26 で既定が反転した)", async () => {
  // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65` で期待値を反転させた。
  //   旧の逐語を1バイトも消していない】**
  // **旧テスト名**: 「(c) 詳細画面で面の名指しが無ければ着手前どおり出る」。
  // **旧の期待値(逐語)**:
  //   `expect(screen.getAllByTestId("action-origin-order-form")).toHaveLength(1);`
  // **今日**: 上の (b) と同じ理由である。
  // **本節が測っている問い(判定を一覧と詳細の2箇所に割っていない)は1ミリも変えていない** ——
  // **反転の向きが一覧と詳細で一致していること自体が、その裏取りになっている。**
  await renderDetail([NAVIGATE], "editor");
  expect(screen.queryByTestId("action-origin-order-form")).toBeNull();
});
