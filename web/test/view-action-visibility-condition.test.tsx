/**
 * **操作起点の表示条件の器**(`V4-M20-T02`。`ADR-0101` 限定3・限定4・限定6)。
 *
 * **宣言と器を同じ差分に入れている**(`ADR-0086` 限定4 / `T02` 完了条件4)——
 * **「条件は書けるが描画が無視する」状態を1コミットも作らない。**
 *
 * ## この検査が言えないこと(**先に書く。誇張しない**)
 *
 * 1. **【禁止】「条件で隠したから安全である」と1文字も書かない**(`ADR-0101` 限定6)
 *    —— **サーバ側の書込判定を1バイトも変えていない。** 隠れたボタンの書込を、
 *    **API を直接叩けば今日どおり実行できる。** 本ファイルはそれを1度も測っていない。
 * 2. **【禁止】「出し分けが自由にできるようになった」と書かない** —— **葉1つなので
 *    「在庫0 かつ 販売期間内」は書けない。**
 * 3. **ここは happy-dom であり、chromium で1度も確かめていない。**
 * 4. **葉の評価は表示層に**もう1つ**の実装が生まれたことを意味する** —— サーバ側は
 *    SQL(`records.ts` の `compileFilter`)1本を持っており、**これで2本目である。**
 *    **同じ意味論であることを、本ファイルは1件も突き合わせていない**(実装記録 §6)。
 *    **【SQ-M4 で 3本 → 2本 になった】** かつてサーバ側は SQL とメモリ
 *    (`read-records.ts` の `memoryLeafPredicate`)の2本を持っていた。
 *    **システムテーブルの読取を SQL へ一本化したので、そのメモリ側が消えた。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { DetailView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";
import { grantRules, viewRead } from "./role-rules.ts";

const APP_ID = "sample-app";
const RECORD_ID = "goods-0001";
const GOODS_PATH = `/api/apps/${APP_ID}/tables/goods/records`;

/** 在庫0・販売中でない・名前に「限定」を含む1行。 */
const ROW = {
  _id: RECORD_ID,
  _created_at: "2026-01-01T00:00:00Z",
  _updated_at: "2026-01-02T00:00:00Z",
  name: "限定セット",
  stock: 0,
  sellable: false,
};

let originalFetch: typeof fetch;
let row: Record<string, unknown> = ROW;

function manifestWith(actions: NonNullable<DetailView["actions"]>): Manifest {
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
            { id: "sellable", name: "販売中", type: "boolean" },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
        {
          id: "carts",
          name: "カート",
          fields: [
            { id: "st_owner", name: "所有者", type: "text" },
            { id: "item", name: "商品", type: "reference", reference_table: "goods" },
          ],
        },
      ],
      views: [
        { id: "goods-detail", type: "detail_view", table: "goods", actions },
        { id: "cart-form", type: "form", table: "carts", fields: ["item"] },
      ],
    },
  } as unknown as Manifest;
  // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`】既定が「閉じる」側へ倒れたので、
  // 規則を1本も書かない題材では**遷移先の `cart-form` を開けない**と判定され、
  // **条件(`visible_when`)が真でもボタンが出ない** ——
  // **条件の評価そのものを測れなくなる**(`DetailViewRenderer` が `canUseView` を見る)。
  // **足すのはこの検査の主題に要る最小限だけである** —— **遷移先1画面 × 読取 ×
  // `owner`(既定のロール)。** **(e) の `viewer` には1本も足していない**
  // (あちらの主題は `canWriteRole` が止める側であって、面ではない)。
  return grantRules(built, ["owner"], [viewRead("cart-form")]);
}

const NAVIGATE = { form: "cart-form", prefill: { field: "item" }, name: "カートに入れる" };

beforeEach(() => {
  row = ROW;
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
      return json({ record: row });
    }
    if (method === "GET" && url === `${GOODS_PATH}/${RECORD_ID}`) {
      return json({ record: row });
    }
    if (method === "GET" && url.startsWith(GOODS_PATH)) {
      return json({ records: [row] });
    }
    if (method === "GET" && url.includes("/tables/carts/records")) {
      return json({ records: [] });
    }
    return json({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/goods-detail/records/${RECORD_ID}`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function detailView(manifest: Manifest): DetailView {
  const view = manifest.app.views[0];
  if (view === undefined || view.type !== "detail_view") {
    throw new Error("fixture broken");
  }
  return view;
}

async function renderDetail(manifest: Manifest, role: Role = "owner"): Promise<void> {
  render(
    <RoleProvider role={role}>
      <DetailViewRenderer
        appId={APP_ID}
        manifest={manifest}
        view={detailView(manifest)}
        recordId={RECORD_ID}
      />
    </RoleProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("detail-field-name")).toBeDefined());
}

// ---------------------------------------------------------------------------
// (a) 条件が偽の操作起点はボタンとして描画されない(T02 完了条件4)
// ---------------------------------------------------------------------------

test("(a) 条件が偽なら、その操作起点は1つも描かれない", async () => {
  await renderDetail(manifestWith([{ ...NAVIGATE, visible_when: { field: "stock", gte: 1 } }]));
  expect(screen.queryByTestId("action-origin-cart-form")).toBeNull();
});

test("(a) 条件が真なら、今日どおり描かれる", async () => {
  await renderDetail(manifestWith([{ ...NAVIGATE, visible_when: { field: "stock", lte: 0 } }]));
  expect(screen.getByTestId("action-origin-cart-form")).toBeDefined();
});

test("(a) 条件を書かなければ今日どおり必ず描かれる(既定を反転させていない)", async () => {
  await renderDetail(manifestWith([NAVIGATE]));
  expect(screen.getByTestId("action-origin-cart-form")).toBeDefined();
});

test("(a) 条件が偽の起点しか無い画面では、器そのものが出ない", async () => {
  await renderDetail(manifestWith([{ ...NAVIGATE, visible_when: { field: "stock", gte: 1 } }]));
  expect(screen.queryByTestId("detail-action-origins")).toBeNull();
});

// ---------------------------------------------------------------------------
// (b) 演算子5種を、今開いているレコードの値に対して評価する
// ---------------------------------------------------------------------------

test("(b) equals / contains / gte / lte / in の5種が、行の値で評価される", async () => {
  const cases: { leaf: Record<string, unknown>; shown: boolean }[] = [
    { leaf: { field: "stock", equals: 0 }, shown: true },
    { leaf: { field: "stock", equals: 1 }, shown: false },
    { leaf: { field: "sellable", equals: false }, shown: true },
    { leaf: { field: "sellable", equals: true }, shown: false },
    { leaf: { field: "name", contains: "限定" }, shown: true },
    { leaf: { field: "name", contains: "通常" }, shown: false },
    { leaf: { field: "stock", gte: 0 }, shown: true },
    { leaf: { field: "stock", gte: 1 }, shown: false },
    { leaf: { field: "stock", lte: 0 }, shown: true },
    { leaf: { field: "stock", lte: -1 }, shown: false },
    { leaf: { field: "name", in: ["限定セット", "他"] }, shown: true },
    { leaf: { field: "name", in: ["他"] }, shown: false },
  ];
  for (const { leaf, shown } of cases) {
    await renderDetail(manifestWith([{ ...NAVIGATE, visible_when: leaf } as never]));
    const found = screen.queryByTestId("action-origin-cart-form");
    expect(found === null, JSON.stringify(leaf)).toBe(!shown);
    cleanup();
  }
});

test("(b) 値が未設定(null)の行では、どの演算子でも偽になる(サーバの除外挙動に合わせる)", async () => {
  row = { ...ROW, stock: null, name: null };
  for (const leaf of [
    { field: "stock", equals: 0 },
    { field: "stock", gte: 0 },
    { field: "stock", lte: 0 },
    { field: "name", contains: "限定" },
    { field: "name", in: ["限定セット"] },
  ]) {
    await renderDetail(manifestWith([{ ...NAVIGATE, visible_when: leaf } as never]));
    expect(screen.queryByTestId("action-origin-cart-form"), JSON.stringify(leaf)).toBeNull();
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (c) 条件は形に依らない —— 値の書換(形 (ii))にも同じように効く
// ---------------------------------------------------------------------------

test("(c) 形 (ii)(値の書換)にも条件が効く", async () => {
  await renderDetail(
    manifestWith([
      {
        set: { field: "sellable", value: true },
        name: "販売を再開する",
        visible_when: { field: "sellable", equals: false },
      } as never,
    ]),
  );
  expect(screen.getByTestId("action-set-sellable")).toBeDefined();
  cleanup();
  await renderDetail(
    manifestWith([
      {
        set: { field: "sellable", value: true },
        name: "販売を再開する",
        visible_when: { field: "sellable", equals: true },
      } as never,
    ]),
  );
  expect(screen.queryByTestId("action-set-sellable")).toBeNull();
});

// ---------------------------------------------------------------------------
// (d) 条件はプリフィル値を1バイトも変えない(限定4)
// ---------------------------------------------------------------------------

test("(d) 条件が真のとき、プリフィルは今日どおり参照フィールド1つ × _id である", async () => {
  await renderDetail(manifestWith([{ ...NAVIGATE, visible_when: { field: "stock", lte: 0 } }]));
  screen.getByTestId("action-origin-cart-form").click();
  await waitFor(() => expect(window.location.pathname).toContain("cart-form"));
  // **プリフィルは navigate の一時状態で運ばれるので URL には出ない。**
  // ここで確かめられるのは「遷移したこと」だけである(着手前と同じ経路)。
});

// ---------------------------------------------------------------------------
// (e) 隠すことは止めることではない(限定6)。**この検査が示せる範囲を正直に書く**
// ---------------------------------------------------------------------------

test("(e) 条件で隠れた起点も、ロールで隠れた起点も、DOM から消えるだけである", async () => {
  // **条件で消えた場合**: ボタンが無い。
  await renderDetail(manifestWith([{ ...NAVIGATE, visible_when: { field: "stock", gte: 1 } }]));
  expect(screen.queryByTestId("action-origin-cart-form")).toBeNull();
  cleanup();
  // **ロールで消えた場合**(今日の挙動。1バイトも変えていない)。
  await renderDetail(manifestWith([NAVIGATE]), "viewer");
  expect(screen.queryByTestId("action-origin-cart-form")).toBeNull();
  /*
   * **どちらも「サーバがその書込を拒む」ことを1ミリも意味しない。**
   * **本ファイルはサーバを1バイトも動かしていない**ので、書込が止まるかは1件も測れていない。
   */
});
