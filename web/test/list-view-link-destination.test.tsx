/**
 * **一覧の行の操作起点から、宣言した行き先へ飛ぶ**(`V5-M22-T03`。`L-G5` / `L-G6` /
 * `ADR-0173` 限定4〜限定7)。
 *
 * **宣言と器を同じマイルストーンに入れている**(`ADR-0086` 限定4)——
 * **「一覧に書けるが描画が無視する」状態を作らない。**
 *
 * ## この検査が言えないこと(**先に書く。誇張しない**)
 *
 * 1. **【禁止】「宣言した画面へ飛べるようになった」を、本物のブラウザで押す前に総括しない**
 *    (`ADR-0173` §限界1 の逐語「走らせて確かめていない」)。**ここは happy-dom であり、
 *    chromium で1度も確かめていない。**
 * 2. **【禁止】「規約より宣言の方が分かりやすくなった」と読まない**(同 §限界4)——
 *    **測っていない。** **書き手が指定を間違える余地は実際に増えた。**
 * 3. **【禁止】「詳細画面からも任意の画面へ飛べる」と読まない** —— **`L-G7` は却下である。**
 *    **非対称が残る。**
 * 4. **`audience` で見えない行き先を宣言したときの挙動は (e) 群で1件だけ測る。**
 *    **【`V5-M23-T05` の追記】** **(e) 群が測っているのは「行き先がマニフェストに無い」
 *    状態であって、`audience` そのものではない** —— **サーバはマニフェストから1画面も
 *    落とさないことが実測で分かった**(`src/server/view-action-audience.test.ts` (A-3))。
 *    **`ADR-0173` §限界3 は「同じに倒れるかは実装で確かめること」と書いていた** ——
 *    **本ファイルが出した答えは「既定の行き先へ倒れない。ボタンごと出ない」である。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ListView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";
import { grantRules, viewRead } from "./role-rules.ts";

const APP_ID = "shop";
const RECORDS_PATH = `/api/apps/${APP_ID}/tables/carts/records`;

const ROWS = [
  {
    _id: "cart-a",
    _created_at: "2026-01-01T00:00:00Z",
    _updated_at: "2026-01-02T00:00:00Z",
    label: "かご1",
  },
  {
    _id: "cart-b",
    _created_at: "2026-01-01T00:00:00Z",
    _updated_at: "2026-01-02T00:00:00Z",
    label: "かご2",
  },
];

/** 3形目(行き先の宣言)。**行き先は `detail_view`。** */
const LINK_TO_DETAIL = { view: "order-detail", name: "会計へ進む" };
/** 3形目。**行き先は `list_view`。** */
const LINK_TO_LIST = { view: "order-list", name: "注文一覧へ" };
/** 1形目(遷移)。**今日と1バイトも同じでなければならない。** */
const NAVIGATE = { form: "order-form", prefill: { field: "cart" }, name: "注文を作る" };

let originalFetch: typeof fetch;

function manifest(): Manifest {
  const built = {
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
        { id: "order-list", type: "list_view", table: "orders", columns: ["memo"] },
        { id: "order-form", type: "form", table: "orders", fields: ["cart", "memo"] },
      ],
    },
  } as unknown as Manifest;
  // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`】既定が「閉じる」側へ倒れたので、
  // 規則を1本も書かない題材では**行き先の画面を1つも開けない**と判定され、
  // 3形目(`view`)も1形目(`form` + `prefill`)も操作起点が1つも描かれない
  // (`ListViewRenderer` が行き先に対して `canUseView` を見る)。
  // **足すのはこの検査の主題に要る最小限だけである** —— **この題材に出てくる行き先
  // 3画面 × 読取 × `owner`(既定のロール)。**
  grantRules(
    built,
    ["owner"],
    [viewRead("order-detail"), viewRead("order-list"), viewRead("order-form")],
  );
  // **`viewer` には `order-list` の1本だけを足す** —— **(f) の1本目が測るのは
  // 「3形目には書込判定を当てない」ことであり、`order-form`(1形目の行き先)を
  // 足すとその主題((f) の2本目 = `canWriteRole` が止める)が消える。**
  // **`order-detail` も `viewer` の主題に出てこないので足していない。**
  return grantRules(built, ["viewer"], [viewRead("order-list")]);
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
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/cart-list`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

async function renderList(
  extra?: Partial<ListView>,
  role: Role = "owner",
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
// (a) 宣言した行き先へ飛ぶ
// ---------------------------------------------------------------------------

test("(a) 行き先が detail_view なら、押した行の _id を運んでその詳細画面へ行く", async () => {
  await renderList({ actions: [LINK_TO_DETAIL] } as Partial<ListView>);
  const buttons = screen.getAllByTestId("list-action-link-order-detail");
  expect(buttons).toHaveLength(ROWS.length);
  fireEvent.click(buttons[1] as HTMLElement);
  expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/order-detail/records/cart-b`);
});

test("(a) 行き先が list_view なら、何も運ばずにその一覧へ行く", async () => {
  await renderList({ actions: [LINK_TO_LIST] } as Partial<ListView>);
  fireEvent.click(screen.getAllByTestId("list-action-link-order-list")[0] as HTMLElement);
  expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/order-list`);
  // **プリフィルのクエリ文字列が1文字も付かない**(`V5-M24-T01` の往復を壊さない)。
  expect(window.location.search).toBe("");
});

test("(a) ボタンの文言は宣言した name である", async () => {
  await renderList({ actions: [LINK_TO_DETAIL] } as Partial<ListView>);
  for (const button of screen.getAllByTestId("list-action-link-order-detail")) {
    expect(button.textContent).toBe("会計へ進む");
  }
});

test("(a) name を書かないときは既定の文言が出る(マニフェストから1文字も取っていない)", async () => {
  await renderList({ actions: [{ view: "order-list" }] } as Partial<ListView>);
  expect((screen.getAllByTestId("list-action-link-order-list")[0] as HTMLElement).textContent).toBe(
    "画面を開く",
  );
});

test("(a) visible_when は行ごとに1回ずつ評価される(3形目でも同じ実装1本である)", async () => {
  await renderList({
    actions: [{ view: "order-list", visible_when: { field: "label", equals: "かご1" } }],
  } as Partial<ListView>);
  expect(screen.getAllByTestId("list-action-link-order-list")).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// (b) 既存の形を1バイトも変えていない(`ADR-0173` 限定4)
// ---------------------------------------------------------------------------

test("(b) 遷移の形(form + prefill)は今日どおり押した行の _id をプリフィルして form へ行く", async () => {
  await renderList({ actions: [NAVIGATE] } as Partial<ListView>);
  fireEvent.click(screen.getAllByTestId("list-action-origin-order-form")[0] as HTMLElement);
  expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/order-form`);
  expect(window.location.search).toBe("?prefill.cart=cart-a");
});

test("(b) 2つの形を同じ一覧に並べられる(どちらも規則1本を通る)", async () => {
  await renderList({ actions: [NAVIGATE, LINK_TO_DETAIL] } as Partial<ListView>);
  expect(screen.getAllByTestId("list-action-origin-order-form")).toHaveLength(ROWS.length);
  expect(screen.getAllByTestId("list-action-link-order-detail")).toHaveLength(ROWS.length);
});

// ---------------------------------------------------------------------------
// (c) 行クリックの行き先を1バイトも変えていない(`ADR-0173` 限定7)
// ---------------------------------------------------------------------------

test("(c) 行そのものをクリックすると、今日どおり規約(同テーブル先頭 detail_view)が決める", async () => {
  await renderList({ actions: [LINK_TO_DETAIL] } as Partial<ListView>);
  fireEvent.click(screen.getAllByTestId("list-row")[0] as HTMLElement);
  // **`carts` の先頭 `detail_view` は `cart-detail` である。** **宣言した `order-detail` ではない。**
  expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/cart-detail/records/cart-a`);
});

test("(c) 操作起点を押しても行クリックの遷移が同時に起きない(stopPropagation)", async () => {
  await renderList({ actions: [LINK_TO_DETAIL] } as Partial<ListView>);
  fireEvent.click(screen.getAllByTestId("list-action-link-order-detail")[0] as HTMLElement);
  expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/order-detail/records/cart-a`);
});

// ---------------------------------------------------------------------------
// (d) 宣言が無い画面は今日と1ピクセルも変わらない(`ADR-0173` 限定4)
// ---------------------------------------------------------------------------

test("(d) actions を1つも書かない一覧に、操作起点の列も器も出ない", async () => {
  await renderList();
  expect(screen.queryByTestId("list-action-cell")).toBeNull();
  expect(screen.queryAllByTestId("list-action-link-order-detail")).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// (e) 行き先がその人のマニフェストに無いとき(`ADR-0173` §限界3 が「確かめること」と書いた点)
// ---------------------------------------------------------------------------

test("(e) 行き先の画面がマニフェストに無い相手には、ボタンごと出ない(既定の行き先へ倒れない)", async () => {
  // **`audience` を宣言した画面は、サーバがマニフェストから落として返す**
  // (`src/server/owner-scope.ts`)。**その状態をここで再現する。**
  //
  // **【`V5-M23-T05` の実測で、上の2行は偽であることが分かった。旧文を1バイトも消していない】**
  // **`GET /api/apps/:app_id/manifest`(`src/server/app.ts`)は `loadManifest` の結果を
  // そのまま返しており、`audience` で1画面も落としていない**(`ADR-0070` 限定7 の逐語
  // 「`GET /api/apps/:app_id/manifest` は未ログインで全ビュー定義を返し続ける」がそう
  // 定めている)。**実測は `src/server/view-action-audience.test.ts` の (A-3) である。**
  // **したがって本テストが再現しているのは「サーバが落とした状態」ではなく、
  // 「マニフェストにその画面が無い状態」そのものである** —— **テストの主張(行き先が
  // 無ければボタンごと出ない)は今日も真であり、1ミリも弱めていない。**
  // **`audience` で見えない行き先の実際の扱いは `V5-M23-T01` が `canUseView` で入れた**
  // (`web/test/action-origin-authz.test.tsx` の (a) 群)。
  const trimmed = manifest();
  trimmed.app.views = trimmed.app.views.filter((view) => view.id !== "order-detail");
  await renderList({ actions: [LINK_TO_DETAIL] } as Partial<ListView>, "owner", trimmed);
  expect(screen.queryAllByTestId("list-action-link-order-detail")).toHaveLength(0);
  // **`after_save`(`ADR-0102`)は「既定の行き先へ倒れる」を選んだが、3形目は倒れない。**
  // **行き先が1つも無い以上、倒れる先が無いためである。**
  expect(screen.queryByTestId("list-action-cell")).toBeNull();
});

test("(e) 行き先が form の宣言は描かれない(apply 時に拒否されるが、表示層でも fail-closed である)", async () => {
  await renderList({ actions: [{ view: "order-form" }] } as Partial<ListView>);
  expect(screen.queryAllByTestId("list-action-link-order-form")).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// (f) 権限による出し分けは 3形目では起きない(`V5-M23` の担当である)
//
// **【`V5-M23-T01` / `T02` で、この見出しは今日から偽である。旧文を1バイトも消していない】**
// **3形目にも権限の出し分けが当たるようになった** —— **`canUseView`(行き先の画面を
// 使えるか。`L-G13`)と `audience`(操作起点1本ごとの宣言。`L-G14` / `ADR-0177`)の2つである。**
// **下の2本が今日も緑なのは、この題材が `audience` を1つも書いておらず、`order-list` を
// viewer が使えるためである** —— **主張(書込判定は3形目に当てない)は1ミリも変わっていない。**
// **新しい出し分けの検査は `web/test/action-origin-authz.test.tsx` と
// `web/test/view-action-audience.test.tsx` が持つ。**
// ---------------------------------------------------------------------------

test("(f) viewer にも3形目のボタンは出る(書込が1件も起きないため)", async () => {
  await renderList({ actions: [LINK_TO_LIST] } as Partial<ListView>, "viewer");
  expect(screen.getAllByTestId("list-action-link-order-list")).toHaveLength(ROWS.length);
});

test("(f) viewer には遷移の形(書込先がある)のボタンは今日どおり出ない", async () => {
  await renderList({ actions: [NAVIGATE] } as Partial<ListView>, "viewer");
  expect(screen.queryAllByTestId("list-action-origin-order-form")).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// (g) 一続きの流れの段は、行そのものの行き先からだけ外れる(FU-G1a / ADR-0362)
// ---------------------------------------------------------------------------

/**
 * **`ADR-0362` が引き直したのは規約(`resolveDetailViewTarget`)の側だけである。**
 * **宣言(3形目 = `view`)の行き先には除外を1ビットも当てていない** ——
 * **`resolveRowActionDestination` は「宣言されたビューID」で探しており、規約とは別の
 * 探し方だからである**(`web/src/navigation.tsx` の限定6 の節)。
 *
 * **したがって同じ一覧の同じ行に、次の2つが同居しうる**:
 * **行そのものは押せない**(候補が全部段)/ **宣言したボタンは段の画面へ今日どおり進む。**
 * **これは `ADR-0173` 限定5(規則は1本)を破っていない** —— **宣言があれば宣言、
 * 無ければ規約、という1本の規則のままである。**
 */
function withFlowStep(viewId: string, step: number): Manifest {
  const built = manifest();
  const view = built.app.views.find((candidate) => candidate.id === viewId);
  if (view === undefined || view.type === "report_view") {
    throw new Error(`fixture broken: ${viewId}`);
  }
  view.flow = { id: "kaimono", step, kind: "input" };
  return built;
}

test("(g) 宣言した行き先が段になった detail_view でも、ボタンは今日どおりそこへ行く", async () => {
  await renderList(
    { actions: [LINK_TO_DETAIL] } as Partial<ListView>,
    "owner",
    withFlowStep("order-detail", 3),
  );
  fireEvent.click(screen.getAllByTestId("list-action-link-order-detail")[0] as HTMLElement);
  expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/order-detail/records/cart-a`);
});

test("(g) 同じ行で「行そのものは押せない / 宣言したボタンは進む」が同居する", async () => {
  await renderList(
    { actions: [LINK_TO_DETAIL] } as Partial<ListView>,
    "owner",
    withFlowStep("cart-detail", 3),
  );
  const row = screen.getAllByTestId("list-row")[0] as HTMLElement;
  // **行そのもの**: `carts` の `detail_view` は段1枚だけなので、候補が0個になる。
  expect(row.getAttribute("tabindex")).toBeNull();
  expect(row.className).not.toContain("list-row-interactive");
  fireEvent.click(row);
  expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/cart-list`);
  // **宣言したボタン**: 今日と1バイトも同じである。
  fireEvent.click(screen.getAllByTestId("list-action-link-order-detail")[0] as HTMLElement);
  expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/order-detail/records/cart-a`);
});
