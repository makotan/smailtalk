/**
 * ロールに応じた画面一覧と操作ボタンの出し分け(V3-M3-T04 / D-G12b。ユーザ決定 D-M3-1 =「隠す」)。
 *
 * ## このファイルが固定すること
 *
 *   1. **判定規則は1本**。`nonAdminTableAccess`(`src/server/owner-scope.ts:116`)を
 *      **web から import して使う**(案(i))。web 側に同じ規約を再実装しない
 *      —— `web/src/navigation.tsx:99`〜`:100` が名指しで禁じた「同じ判定が2箇所」を作らない。
 *   2. **使えない画面が画面一覧に並ばない**(`visibleViewsForRole`)。
 *   3. **403 になるボタンが出ない**(`canWriteRole` のテーブル込み拡張 / `useCanWrite(table)`)。
 *   4. **射程**: viewer / editor / owner では**1件も隠れない**。隠れるのは customer だけである
 *      (V3-M0 審査記録 §5 S3-5。「ロールに応じて画面が出し分けられる」と一般化しない)。
 *
 * ## このファイルが証明しないこと(先に書く)
 *
 * - **サーバの 403 が効いていること**は証明しない。UI が押させないことは 403 の代わりに
 *   ならない(完了条件4)。それは `web/e2e/authz.e2e.ts` / `web/e2e/owner-scope.e2e.ts` の担当。
 * - **隠したことで「なぜ見えないのか」を説明する機会が消える**(憲法6 との緊張。完了条件6)。
 *   その代償はここでは埋め合わせていない —— 画面一覧に消えた理由は1文字も出ない。
 *   **URL を直接叩けば従来どおりサーバの 403 とその hint に到達する**(`SelectedView` は
 *   絞っていない)ので、説明機会は「一覧から」消えるのであって、全部が消えるのではない。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { Manifest, Table, View } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
import {
  canReadTableRole,
  canWriteRole,
  RoleProvider,
  visibleViewsForRole,
} from "../src/auth/authz.tsx";
import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";
import { FormRenderer } from "../src/views/FormRenderer.tsx";
import { ADMIN_ROLES, grantAllViews, grantRules, viewRead } from "./role-rules.ts";

const APP_ID = "shop-app";
const CART_RECORD_ID = "cart-0001";
const PRODUCT_RECORD_ID = "product-0001";

/**
 * customer から見た3カテゴリ(`nonAdminTableAccess`)が全部そろったマニフェスト。
 *   - `products`  : `st_public`(boolean・required でない)だけ → **public**(GET 可・書込 403)
 *   - `carts`     : `st_owner`(text・required でない)       → **scoped**(自分の行は読み書き可)
 *   - `shipments` : どちらの規約も持たない                    → **denied**(GET も書込も 403)
 */
/**
 * **本ファイルが測る相手**(4ロール + provider の外)。
 *
 * **【`V8-M26`(2026-08-10)。ユーザ決定 `D-V8-45` / `D-V8-65`】**
 * **`src/server/owner-scope.ts` の `judgeRoleAccess` の既定が閉じる側へ倒れ、
 * `canUseView` は「規則を1本も名指ししていない画面」に偽を返すようになった。**
 * **本ファイルの主題は `nonAdminTableAccess`(テーブル単位の出し分け。隠れるのは
 * customer だけ)であって面ではないので、題材に「画面 × 読取」だけを足して前段を通す。**
 * **表・項目・ボタンの規則は1本も足していない** —— **customer から3画面が隠れるのは
 * 今日も `canReadTableRole` の側が落としているからである**(下の検査がそれを測る)。
 *
 * **`anonymous` を含めているのは、`visibleViewsForRole(null, ...)`(provider の外)が
 * 面では `anonymous` として判定されるためである**(`J-G11`)。
 */
// **【`V8-M27-T04` / `T-G5`】この定数は使われなくなった。旧の宣言を残す** ——
// **旧(逐語)**: `const SHOP_ROLES = [...ADMIN_ROLES, "customer", "anonymous"] as const;`
// **題材が「4役割すべてに全画面の規則を配る」形をやめたためである**(下の
// {@link shopManifest} / {@link adminOnlyManifest} が役割ごとに配る先を分けている)。

function shopManifest(): Manifest {
  const built: Manifest = {
    app: {
      id: APP_ID,
      name: "ショップ",
      tables: [
        {
          id: "products",
          name: "商品",
          fields: [
            { id: "title", name: "商品名", type: "text", required: true },
            { id: "st_public", name: "公開", type: "boolean" },
          ],
        },
        {
          id: "carts",
          name: "カート",
          fields: [
            { id: "title", name: "品目", type: "text", required: true },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
        {
          id: "shipments",
          name: "出荷",
          fields: [{ id: "title", name: "伝票", type: "text", required: true }],
        },
      ],
      views: [
        { id: "product-list", type: "list_view", table: "products", columns: ["title"] },
        { id: "product-detail", type: "detail_view", table: "products" },
        { id: "product-form", type: "form", table: "products", fields: ["title"] },
        { id: "cart-list", type: "list_view", table: "carts", columns: ["title"] },
        { id: "cart-detail", type: "detail_view", table: "carts" },
        { id: "cart-form", type: "form", table: "carts", fields: ["title"] },
        { id: "shipment-list", type: "list_view", table: "shipments", columns: ["title"] },
        { id: "shipment-detail", type: "detail_view", table: "shipments" },
        { id: "shipment-form", type: "form", table: "shipments", fields: ["title"] },
      ],
    },
  };
  // **【`V8-M26`】9画面すべてに「開ける」規則を足す**(テーブル単位の判定の前段を通すため)。
  //
  // --- 【`V8-M27-T04` / `T-G5`。題材を書き換えた。旧の行を1バイトも消していない】 ---
  //
  // **旧(逐語)**: `return grantAllViews(built, SHOP_ROLES);`
  //
  // **根拠**: **`V8-M27` / 台帳 `T-G5` / ユーザ決定 `D-V8-38`。**
  // **`nonAdminTableAccess` を撤去した** —— **9画面すべてに `customer` の規則を書いた
  // 題材では、今日は9画面とも並ぶ**(隠していたのは層であって、規則ではなかった)。
  // **本ファイルが測ってきた観測(「`customer` には出荷の3画面が並ばない」)を
  // 今日の仕組みで再現するため、`customer` にだけ出荷の3画面の規則を書かない。**
  //
  // **【この書き換えが意味すること。誇張しない】** —— **出し分けの根拠が
  // 「表の作り(`st_owner` / `st_public` の有無)」から「役割に書いた規則」へ移った。**
  // **表の作りは1バイトも変えていない**(3表とも旧のまま)—— **それでも出し分けは起きる。**
  // **逆に、規則を書けば `customer` に出荷の画面を並べることもできる**(旧はできなかった)。
  grantAllViews(built, ADMIN_ROLES);
  grantAllViews(built, ["anonymous"]);
  grantRules(
    built,
    ["customer"],
    built.app.views.filter((view) => view.table !== "shipments").map((view) => viewRead(view.id)),
  );
  return built;
}

/**
 * customer から見て**全テーブルが denied** のマニフェスト(絞ると画面一覧が0件になる)。
 * E2E フィクスチャ `fixtures/valid/inventory-all-field-types.json` と同じ形である
 * (`st_owner` も `st_public` も持たないテーブルしかない)。
 */
function adminOnlyManifest(): Manifest {
  const built: Manifest = {
    app: {
      id: APP_ID,
      name: "運営だけのアプリ",
      tables: [
        {
          id: "shipments",
          name: "出荷",
          fields: [{ id: "title", name: "伝票", type: "text", required: true }],
        },
      ],
      views: [
        {
          id: "shipment-list",
          name: "出荷一覧",
          type: "list_view",
          table: "shipments",
          columns: ["title"],
        },
        { id: "shipment-detail", name: "出荷の詳細", type: "detail_view", table: "shipments" },
      ],
    },
  };
  // **【`V8-M26`】2画面に「開ける」規則を足す** —— **customer が0件になるのは今日も
  // `canReadTableRole`(運営テーブル = denied)の側が落とすからである、を測り続けるため。**
  //
  // --- 【`V8-M27-T04` / `T-G5`。題材を書き換えた。旧の行を1バイトも消していない】 ---
  //
  // **旧(逐語)**: `return grantAllViews(built, SHOP_ROLES);`
  // **上のコメントの後半(「`canReadTableRole`(運営テーブル = denied)の側が落とす」)は
  // 今日は偽である** —— **`canReadTableRole` は今日1件も落とさない**(層ごと撤去した)。
  // **`customer` が0件になるのは、`customer` にこの2画面の規則を1本も書いていないからである。**
  grantAllViews(built, ADMIN_ROLES);
  grantAllViews(built, ["anonymous"]);
  return built;
}

/** そもそもビューを1つも持たないマニフェスト(「元から0件」の状態)。 */
function noViewManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "画面のないアプリ",
      tables: [
        {
          id: "shipments",
          name: "出荷",
          fields: [{ id: "title", name: "伝票", type: "text", required: true }],
        },
      ],
      views: [],
    },
  };
}

function tableOf(id: string): Table {
  const table = shopManifest().app.tables.find((candidate) => candidate.id === id);
  if (table === undefined) {
    throw new Error("fixture broken");
  }
  return table;
}

function viewIdsOf(views: readonly View[]): string[] {
  return views.map((view) => view.id);
}

function jsonResponse(body: unknown, status = 200): Response {
  if (body === undefined) {
    return new Response(null, { status });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CART_ROW = { _id: CART_RECORD_ID, _created_at: "", _updated_at: "", title: "りんご" };
const PRODUCT_ROW = { _id: PRODUCT_RECORD_ID, _created_at: "", _updated_at: "", title: "りんご" };

let responses: Map<string, [number, unknown]>;
let originalFetch: typeof fetch;

beforeEach(() => {
  responses = new Map();
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = (typeof input === "string" ? input : input.toString()).split("?")[0] ?? "";
    const method = init?.method ?? "GET";
    const stubbed = responses.get(`${method} ${url}`);
    if (stubbed !== undefined) {
      return jsonResponse(stubbed[1], stubbed[0]);
    }
    if (url === `/api/apps/${APP_ID}/tables/carts/records/${CART_RECORD_ID}`) {
      return jsonResponse({ record: CART_ROW }, 200);
    }
    if (url === `/api/apps/${APP_ID}/tables/products/records/${PRODUCT_RECORD_ID}`) {
      return jsonResponse({ record: PRODUCT_ROW }, 200);
    }
    if (url === `/api/apps/${APP_ID}/manifest`) {
      return jsonResponse(shopManifest(), 200);
    }
    return jsonResponse({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.history.replaceState({}, "", "/");
});

// --- 1. 判定規則(純関数)------------------------------------------------------

describe("canReadTableRole(テーブル込みの読取判定)", () => {
  test("owner / editor / viewer はテーブルによらず読める(隠す対象は0件)", () => {
    for (const role of ["owner", "editor", "viewer"] as const) {
      expect(canReadTableRole(role, tableOf("products"))).toBe(true);
      expect(canReadTableRole(role, tableOf("carts"))).toBe(true);
      expect(canReadTableRole(role, tableOf("shipments"))).toBe(true);
    }
  });

  // **【`V8-M27-T04` / `T-G5`。期待値を反転させた。旧のテスト名と旧の期待値を逐語で残す】**
  // **旧のテスト名**: `customer は scoped / public を読め、denied(運営テーブル)は読めない`
  // **旧の期待値(逐語)**: `expect(canReadTableRole("customer", tableOf("shipments"))).toBe(false);`
  // **根拠**: **`V8-M27` / 台帳 `T-G5` / ユーザ決定 `D-V8-38`。**
  // **`nonAdminTableAccess` を撤去したので、この述語は今日1件も落とさない。**
  // **表単位の読取の可否を答えるのは面(`judgeRoleAccess`)であり、
  // `canUseView` はその `AND` の右辺で見る。**
  test("(反転) customer もテーブルによらず true(旧: denied = 運営テーブルは false)", () => {
    expect(canReadTableRole("customer", tableOf("carts"))).toBe(true);
    expect(canReadTableRole("customer", tableOf("products"))).toBe(true);
    expect(canReadTableRole("customer", tableOf("shipments"))).toBe(true);
  });

  // **【`V8-M27-T04` / `T-G5`。期待値を反転させた。旧のテスト名と旧の期待値を逐語で残す】**
  // **旧のテスト名**: `provider 外(null)は読める。テーブル不明は customer だけ fail-closed`
  // **旧の期待値(逐語)**: `expect(canReadTableRole("customer", undefined)).toBe(false);`
  // **旧の説明(逐語)**: `// サーバ(\`src/server/app.ts\`)がテーブル解決に失敗したとき denied に倒すのと同じ向き。`
  // **そのサーバ側の fail-closed(`table === undefined ? "denied" : ...`)ごと撤去した。**
  test("(反転) テーブル不明でも true(customer の fail-closed は層ごと消えた)", () => {
    // 既定を変えない(`authz.tsx` の「provider の外では書込可」と同じ向き)。
    expect(canReadTableRole(null, undefined)).toBe(true);
    expect(canReadTableRole("viewer", undefined)).toBe(true);
    expect(canReadTableRole("customer", undefined)).toBe(true);
  });
});

describe("canWriteRole(テーブル込みの書込判定)", () => {
  /**
   * **【V4-M2-T06 / `ADR-0074` 限定6 で `null` の期待値を反転させた】**
   * 理由と経緯は `web/test/authz.test.tsx` の同名 describe のコメントと
   * `web/src/auth/authz.tsx` のヘッダにある。**既存3ロールの答えは1つも動いていない。**
   */
  test("既存3ロールの挙動(テーブルを渡さない)は1つも変わらない(null だけが反転した)", () => {
    expect(canWriteRole("owner")).toBe(true);
    expect(canWriteRole("editor")).toBe(true);
    expect(canWriteRole("viewer")).toBe(false);
    expect(canWriteRole(null)).toBe(false);
  });

  // **【`V8-M27-T04` / `T-G5`。期待値を反転させた。旧のテスト名と旧の期待値を逐語で残す】**
  // **旧のテスト名**: `customer は scoped テーブルにだけ書ける(public / denied は 403 になるので出さない)`
  // **旧の期待値(逐語)**:
  //   expect(canWriteRole("customer", tableOf("products"))).toBe(false);
  //   expect(canWriteRole("customer", tableOf("shipments"))).toBe(false);
  //   expect(canWriteRole("customer", undefined)).toBe(false);   // fail-closed
  // **根拠**: **`V8-M27` / 台帳 `T-G5` / ユーザ決定 `D-V8-38`。**
  // **`nonAdminTableAccess` を撤去したので、この述語は表を1バイトも見ない。**
  // **書込ボタンを消すのは、今日は面の側の述語である**(`canWriteFieldRole` /
  // `canWriteTableActionRole`)。
  // **【正直に書く。塞いでいない食い違い】** **`role === "viewer"` の枝はこの関数に
  // 残っている**(下の検査が測る)—— **サーバの `hasAdminWriteRole` は消えたので、
  // 面が書込を許した `viewer` はサーバでは書けるのに、UI は保存ボタンを出さない。**
  // **本タスクの射程は「表単位の可否を決める層」であり、この1語は射程外である。**
  test("(反転) customer はテーブルによらず true(表単位の層を撤去した)", () => {
    expect(canWriteRole("customer", tableOf("carts"))).toBe(true);
    expect(canWriteRole("customer", tableOf("products"))).toBe(true);
    expect(canWriteRole("customer", tableOf("shipments"))).toBe(true);
    expect(canWriteRole("customer", undefined)).toBe(true);
  });

  test("テーブルを渡しても owner / editor / viewer の答えは変わらない(null は反転済み)", () => {
    for (const table of [tableOf("products"), tableOf("carts"), tableOf("shipments")]) {
      expect(canWriteRole("owner", table)).toBe(true);
      expect(canWriteRole("editor", table)).toBe(true);
      expect(canWriteRole("viewer", table)).toBe(false);
      // **`V4-M2-T06` / `ADR-0074` 限定6 で `true` → `false` に反転した。**
      expect(canWriteRole(null, table)).toBe(false);
    }
  });
});

// --- 2. 画面一覧の出し分け ------------------------------------------------------

describe("visibleViewsForRole(画面一覧の絞り込み)", () => {
  const manifest = shopManifest();

  test("owner / editor / viewer では1件も隠れない(射程は customer 限定)", () => {
    const all = viewIdsOf(manifest.app.views);
    for (const role of ["owner", "editor", "viewer"] as const) {
      expect(viewIdsOf(visibleViewsForRole(role, manifest))).toEqual(all);
    }
    // provider 外(null)でも隠さない。
    expect(viewIdsOf(visibleViewsForRole(null, manifest))).toEqual(all);
  });

  // **【`V8-M27-T04` / `T-G5`】期待値は1バイトも変えていないが、**根拠が入れ替わった**。**
  // **旧: `canReadTableRole` が運営テーブル(`denied`)を落としていた。**
  // **新: 題材の `customer` に出荷3画面の規則を1本も書いていない**(上の {@link shopManifest})。
  // **表の作りは1バイトも変えていない。**
  test("customer には運営テーブル(denied)のビューが3件とも並ばない", () => {
    const visible = viewIdsOf(visibleViewsForRole("customer", manifest));
    expect(visible).not.toContain("shipment-list");
    expect(visible).not.toContain("shipment-detail");
    expect(visible).not.toContain("shipment-form");
  });

  test("公開テーブルの form は customer にも並ぶ —— 隠す判定は『読めるか』1本である", () => {
    // 書けないが読める画面は隠さない。viewer の form が今日そうなっているのと同じ扱いで、
    // 規則をロールごとに割らないための決定(`canUseView` の注記)。**保存ボタンは出ない。**
    const visible = viewIdsOf(visibleViewsForRole("customer", manifest));
    expect(visible).toContain("product-form");
    expect(visible).toContain("product-list");
    expect(visible).toContain("product-detail");
  });

  test("customer に残るのは公開3画面 + 自分のテーブル3画面の計6件(9件中3件が隠れる)", () => {
    const visible = viewIdsOf(visibleViewsForRole("customer", manifest));
    expect(visible).toEqual([
      "product-list",
      "product-detail",
      "product-form",
      "cart-list",
      "cart-detail",
      "cart-form",
    ]);
    // 射程の実測。誇張しないための数 —— 隠れるのは運営テーブル(denied)の3件だけである。
    expect(manifest.app.views.length - visible.length).toBe(3);
  });

  test("並び順はマニフェストのまま(絞るだけで並べ替えない)", () => {
    const visible = viewIdsOf(visibleViewsForRole("customer", manifest));
    const order = viewIdsOf(manifest.app.views).filter((id) => visible.includes(id));
    expect(visible).toEqual(order);
  });
});

describe("AppWorkspace の画面一覧(製品経路)", () => {
  function renderAppAs(
    role: "owner" | "editor" | "viewer" | "customer",
    manifest: Manifest = shopManifest(),
  ) {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    responses.set(`GET /api/apps/${APP_ID}/auth/me`, [
      200,
      { user: { id: "u1", username: "alice", displayName: null, role } },
    ]);
    responses.set(`GET /api/apps/${APP_ID}/manifest`, [200, manifest]);
    return render(<App />);
  }

  test("viewer は9件すべての画面が並ぶ", async () => {
    renderAppAs("viewer");
    await waitFor(() => expect(screen.getByTestId("view-list")).toBeDefined());
    expect(screen.getByTestId("view-list").querySelectorAll("li").length).toBe(9);
  });

  test("customer には運営テーブルの画面名が1つも出ない", async () => {
    renderAppAs("customer");
    await waitFor(() => expect(screen.getByTestId("view-list")).toBeDefined());
    const list = screen.getByTestId("view-list");
    expect(list.querySelectorAll("li").length).toBe(6);
    expect(list.textContent).not.toContain("shipment");
    // 1件でも並ぶなら、空の説明は出さない。
    expect(screen.queryByTestId("view-list-empty")).toBeNull();
  });
});

/**
 * 【追加実施】絞った結果が0件のときに真っ白な画面を出さない。
 *
 * **これは T04 が新しく作った状態である** —— 実装前は customer にも画面が並んでいた
 * (押すと 403 になった)。実装後は何も出ない。**黙って空にすると「壊れている」と
 * 区別が付かない**(同じ規律を `ListViewRenderer:298` の `list-empty` と
 * `web/src/App.tsx` のアプリ一覧が既に持っている)。
 *
 * **D-M3-1(隠す)の射程は侵さない** —— 出すのは「このロールで使える画面が無い」だけで、
 * **隠した画面の名前・件数・テーブル名を1つも出さない**。下の検査がそれを機械で固定する。
 */
describe("画面一覧が0件のときの説明", () => {
  function renderAppAs(role: "owner" | "editor" | "viewer" | "customer", manifest: Manifest) {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    responses.set(`GET /api/apps/${APP_ID}/auth/me`, [
      200,
      { user: { id: "u1", username: "alice", displayName: null, role } },
    ]);
    responses.set(`GET /api/apps/${APP_ID}/manifest`, [200, manifest]);
    return render(<App />);
  }

  test("customer で全部隠れたら、壊れていないことと次の行動が読める説明を出す", async () => {
    renderAppAs("customer", adminOnlyManifest());
    const empty = await screen.findByTestId("view-list-empty");
    // 「ロールで絞った結果0件」であることが機械でも読める。
    expect(empty.getAttribute("data-reason")).toBe("role");
    const text = empty.textContent ?? "";
    // (a) 壊れているのではないことが読める。
    expect(text).toContain("壊れて");
    // (b) 次に何をすればよいかが読める。
    expect(text).toContain("運営者");
    // (c) 誇張しない —— 「権限がありません」と断定しない。
    expect(text).not.toContain("権限");
    // 一覧の `<li>` は1つも無い。
    expect(screen.getByTestId("view-list").querySelectorAll("li").length).toBe(0);
  });

  test("説明は隠した画面の名前・ID・テーブル名・件数を1つも明かさない", async () => {
    const manifest = adminOnlyManifest();
    renderAppAs("customer", manifest);
    const text = (await screen.findByTestId("view-list-empty")).textContent ?? "";
    for (const view of manifest.app.views) {
      expect(text).not.toContain(view.id);
      expect(text).not.toContain(view.name ?? "@@no-name@@");
      expect(text).not.toContain(view.table);
    }
    for (const table of manifest.app.tables) {
      expect(text).not.toContain(table.id);
      expect(text).not.toContain(table.name);
    }
    // 件数も出さない(数字を1文字も含まない、という機械的な固定)。
    expect(text).not.toMatch(/\d/);
  });

  test("元から画面が0件のアプリは、別の理由として区別して出す", async () => {
    renderAppAs("customer", noViewManifest());
    const empty = await screen.findByTestId("view-list-empty");
    expect(empty.getAttribute("data-reason")).toBe("none");
    const text = empty.textContent ?? "";
    expect(text).toContain("壊れて");
    // 「ロールのせい」と言わない —— 元から無いのだから、ロールを変えても増えない。
    expect(text).not.toContain("ロール");
  });

  test("元から0件は owner でも同じ理由で出る(ロールに依存しない状態である)", async () => {
    renderAppAs("owner", noViewManifest());
    const empty = await screen.findByTestId("view-list-empty");
    expect(empty.getAttribute("data-reason")).toBe("none");
  });

  test("owner / editor / viewer では、絞りによる空の説明は出ない", async () => {
    for (const role of ["owner", "editor", "viewer"] as const) {
      const view = renderAppAs(role, adminOnlyManifest());
      await waitFor(() => expect(screen.getByTestId("view-list")).toBeDefined());
      expect(screen.getByTestId("view-list").querySelectorAll("li").length).toBe(2);
      expect(screen.queryByTestId("view-list-empty")).toBeNull();
      view.unmount();
    }
  });
});

// --- 3. 操作ボタンの出し分け ----------------------------------------------------

describe("customer の操作ボタン(403 になるボタンを出さない)", () => {
  function renderDetail(role: "owner" | "customer", viewId: string, recordId: string) {
    const manifest = shopManifest();
    const view = manifest.app.views.find((candidate) => candidate.id === viewId);
    if (view === undefined || view.type !== "detail_view") {
      throw new Error("fixture broken");
    }
    return render(
      <RoleProvider role={role}>
        <DetailViewRenderer appId={APP_ID} manifest={manifest} view={view} recordId={recordId} />
      </RoleProvider>,
    );
  }

  function renderForm(role: "owner" | "customer", viewId: string) {
    const manifest = shopManifest();
    const view = manifest.app.views.find((candidate) => candidate.id === viewId);
    if (view === undefined || view.type !== "form") {
      throw new Error("fixture broken");
    }
    return render(
      <RoleProvider role={role}>
        <FormRenderer appId={APP_ID} manifest={manifest} view={view} />
      </RoleProvider>,
    );
  }

  // **【E-G20 / V4-M6 で期待を書き直した】** 着手前はここが「公開テーブルの詳細で
  // `detail-read-only` が出ること」を固定していた。**買い物客の商品ページに
  // 「閲覧のみ(書き込み権限がありません)。」という運営向けの文言が出ること**そのものが
  // `E-G20` の症状である(02 §5-3)。**編集/削除が出ないことは1ミリも変えていない。**
  // **【`V8-M27-T04` / `T-G5`。期待値を反転させた。旧のテスト名と旧の期待値を逐語で残す】**
  // **旧のテスト名**: `customer は公開テーブルの詳細で編集/削除が出ず、権限の注記も出ない(E-G20)`
  // **旧の期待値(逐語)**:
  //   expect(screen.queryByTestId("detail-read-only")).toBeNull();
  //   expect(screen.queryByTestId("detail-edit")).toBeNull();
  //   expect(screen.queryByTestId("detail-delete")).toBeNull();
  // **根拠**: **`V8-M27` / 台帳 `T-G5` / ユーザ決定 `D-V8-38`。**
  // **`canWriteRole` から表単位の枝(`nonAdminTableAccess`)を撤去したので、
  // `customer` の書込導線は表の作りでは消えなくなった。**
  // **`isWriteAudienceRole`(`E-G20` の注記の判定)も同じ層だったので常に真になり、
  // 「閲覧のみ」の注記も出うる** —— **ただしこの画面では書込導線が出るので注記は出ない。**
  // **【正直に書く。これは広がりである】** **`E-G20` / `V4-M6` が消した「押しても
  // 403 になる導線」が、公開テーブルについては戻った。** **押した先で止めるのはサーバの
  // 面(`judgeRoleAccess` の表 × 書込)であり、そちらは今日も 403 を返す。**
  // **導線を消したいアプリは、その表の `write` を役割に書かなければよい** ——
  // **表示層はその規則を `canWriteFieldRole` / `canWriteTableActionRole` で見る。**
  test("(反転) customer にも公開テーブルの詳細で編集/削除が出る(旧: 表の作りで消えていた)", async () => {
    renderDetail("customer", "product-detail", PRODUCT_RECORD_ID);
    await waitFor(() => expect(screen.getByTestId("detail-fields")).toBeDefined());
    expect(screen.getByTestId("detail-edit")).toBeDefined();
    expect(screen.getByTestId("detail-delete")).toBeDefined();
    // **「閲覧のみ」の注記は今日も出ない**(書けると判定されているため)。**据え置き。**
    expect(screen.queryByTestId("detail-read-only")).toBeNull();
  });

  test("customer は自分のテーブル(scoped)の詳細では編集/削除が出る", async () => {
    renderDetail("customer", "cart-detail", CART_RECORD_ID);
    await waitFor(() => expect(screen.getByTestId("detail-edit")).toBeDefined());
    expect(screen.getByTestId("detail-delete")).toBeDefined();
    expect(screen.queryByTestId("detail-read-only")).toBeNull();
  });

  // **【`V8-M27-T04` / `T-G5`。期待値を反転させた。旧のテスト名と旧の期待値を逐語で残す】**
  // **旧のテスト名**: `customer は公開テーブルの form で保存ボタンが出ない`
  // **旧の期待値(逐語)**:
  //   await waitFor(() => expect(screen.getByTestId("form-read-only")).toBeDefined());
  //   expect(screen.queryByRole("button", { name: /保存/ })).toBeNull();
  // **根拠は1つ上の詳細画面と同じである**(`canWriteRole` の表単位の枝の撤去)。
  test("(反転) customer にも公開テーブルの form で保存ボタンが出る(旧: 出なかった)", async () => {
    renderForm("customer", "product-form");
    await waitFor(() => expect(screen.getByLabelText(/商品名/)).toBeDefined());
    expect(screen.getByRole("button", { name: /保存/ })).toBeDefined();
    expect(screen.queryByTestId("form-read-only")).toBeNull();
  });

  test("customer は自分のテーブル(scoped)の form では保存ボタンが出る", async () => {
    renderForm("customer", "cart-form");
    await waitFor(() => expect(screen.getByLabelText(/品目/)).toBeDefined());
    expect(screen.getByRole("button", { name: /保存/ })).toBeDefined();
    expect(screen.queryByTestId("form-read-only")).toBeNull();
  });

  test("owner は3カテゴリのどこでも書込導線が出る(既存の挙動を変えていない)", async () => {
    renderDetail("owner", "product-detail", PRODUCT_RECORD_ID);
    await waitFor(() => expect(screen.getByTestId("detail-edit")).toBeDefined());
    expect(screen.getByTestId("detail-delete")).toBeDefined();
  });
});
