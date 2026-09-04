/**
 * 画面ごとの「見せる相手」を、**表示層の可視判定が読む**ことの検査(`V4-M3-T04` / `B-G1`)。
 *
 * 限定表の正は `docs/adr/0070-view-audience-declaration.md` §3、
 * 完了条件の正は `docs/plan/v4/records/v4-m3.md` §4 の「V4-M3-T04」節、
 * 渡し方の設計の正は `docs/plan/v4/records/v4-m3-t01.md`。
 *
 * ## 【`V8-M20`(2026-08-10)。台帳 `J-G27`。手続きは `ADR-0301`】**測る宣言が入れ替わった**
 *
 * **上の見出しの `view.audience` は廃止された。** **本ファイルは1本も消していない** ——
 * **`ADR-0301` の作法(「その語彙が無くなったので意味を失った検査だけを消す」)に照らすと、
 * ここが測っていた問い(「画面ごとの宣言を表示層の可視判定が読むか」)は今日も在るからである。**
 * **見る宣言だけを `view.audience` から**面**(`app.roles[].rules` の
 * `{ target: "view", view: <画面ID>, can: ["read"] }`)へ置き直した。**
 *
 * **【正直に書く。置き直しても同じにならない点が1つある】**
 * **旧層には「未ログインには `audience` に `anonymous` と書いた画面だけを見せる」という
 * 閉じる向きの既定があった**(`ADR-0074` 限定7)。**面の既定は「規則を1本も書いていない
 * 対象は管轄外(全許可)」である**(裁定 `R-4`)。**したがって規則を1本も書いていない
 * アプリでは、未ログインに画面が並ぶ側に倒れる。** **その向きの実測は
 * `web/test/anonymous-view.test.tsx` の (b) 群が持つ。**
 * **【禁止の履行】これを「同じ挙動を保った」と書かない。**
 *
 * ## このファイルが固定すること
 *
 * 1. **`canUseView` が宣言を読む** —— 対象テーブルを読めても、規則の外の相手には `false`。
 * 2. **`visibleViewsForRole` の本数が宣言によって変わる。**
 * 3. **`ADR-0053:40` の逐語「画面が減るのは customer のときだけである。owner / editor /
 *    viewer では**1画面も減らない**」が、**規則を書いた画面については**偽になった**こと
 *    を実測で示す**(`ADR-0070` §限界5 が「破れたかは実測してから書く」と要求している)。
 * 4. **画面を開いたときのレコード取得に `?view=` が載る** —— サーバの判定に実際に届いて
 *    いることを、fetch した URL で確かめる。
 *
 * ## 【`V8-M26`(2026-08-10)。ユーザ決定 `D-V8-45` / `D-V8-65`】**既定が「閉じる」側へ倒れた**
 *
 * **上の1.〜4. は1本も消していないが、拠って立つ既定が反転した。**
 * **`src/server/owner-scope.ts` の `judgeRoleAccess` は、規則を1本も名指ししていない
 * `table` / `view` / `action` を今日から拒否する**(`field` だけは今日どおり開いたまま。
 * 台帳 `T-G1b` = 却下)。**役割を1つも宣言していないアプリも閉じる**(`D-V8-65`)。
 *
 * **その帰結が本ファイルに2つ出た**(**どちらも旧の期待値をその場に逐語で残した**):
 *
 * 1. **「宣言の無い画面は今日どおり全員が開ける」(`ADR-0070` 限定4)が偽になった** ——
 *    **1本目の検査の期待値を `true` → `false` へ反転させた。**
 * 2. **「宣言が1つも無いマニフェストでは本数が変わらない」も偽になった** ——
 *    **本数の期待値を `1` → `0` へ反転させた。**
 *
 * **題材の側では `catalog-list`(旧「宣言の無い画面」)を4ロールが名指しするようにした** ——
 * **本数の検査が旧の `owner 3 / editor 2 / viewer 1 / customer 1` をそのまま測り続けるためである。**
 * **【禁止の履行】これを「同じ挙動を保った」と書かない。既定は反転した。**
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * - **UI が隠すことは遮断ではない**(`ADR-0053:41`)。**遮断はサーバの 403 である。**
 * - **`?view=` を渡さない要求は今日どおり通る**(`ADR-0070` 限定4)。**表は閉じていない。**
 * - **`GET /manifest` は未ログインで全ビュー定義を返し続ける**(限定7)——
 *   **隠した画面の存在そのものは、今日も誰でも読める。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { Manifest, RoleDeclaration, View } from "../../src/kernel/types.ts";
import { canUseView, RoleProvider, visibleViewsForRole } from "../src/auth/authz.tsx";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";

const APP_ID = "audience-shop";

/**
 * **`B-G1` の症状をそのまま写した題材**(`docs/plan/v4/01-boundary-baseline.md:129`)。
 * `product` は `st_public` を持つので **customer は今日どれも読める** ——
 * **テーブル単位の判定では1画面も減らない。**
 *
 * **【`V8-M20`】画面ごとの宣言は、画面の側(`audience`)ではなく役割の側(`roles[].rules`)に
 * 書く。** **題材の画面3本・テーブル1本は1バイトも変えていない。**
 */
function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "見せ分けの店",
      tables: [
        {
          id: "product",
          name: "商品",
          fields: [
            { id: "name", name: "商品名", type: "text", required: true },
            { id: "stock", name: "在庫数", type: "number" },
            { id: "st_public", name: "公開", type: "boolean" },
          ],
        },
      ],
      views: [
        {
          id: "catalog-list",
          name: "商品一覧",
          type: "list_view",
          table: "product",
          columns: ["name"],
        },
        {
          id: "admin-product-list",
          name: "【運営】商品と在庫",
          type: "list_view",
          table: "product",
          columns: ["name", "stock"],
        },
        {
          id: "admin-product-form",
          name: "【運営】商品登録",
          type: "form",
          table: "product",
          fields: ["name", "stock"],
        },
      ],
      // **旧 `admin-product-list.audience = ["owner","editor"]` /
      //     `admin-product-form.audience = ["owner"]` と同じ見え方を、面の規則で書く。**
      //
      // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`】`catalog-list` の4行を足した。**
      // **旧はここに `catalog-list` の規則が1本も無く、それが「宣言の無い画面」(`ADR-0070`
      // 限定4)の題材だった。** **既定が閉じる側へ倒れた今日、名指ししないままだと
      // `catalog-list` はどの役割にも見えなくなり、下の本数の検査(`owner 3 / editor 2 /
      // viewer 1 / customer 1`)が測っていた**宣言による差**そのものが消える。**
      // **足したのはこの1画面 × 読取だけである** —— **表・項目・ボタンの規則は1本も足していない。**
      // **「宣言の無い画面」の側は、名指しを外した写しを作って1本目の検査が測る。**
      roles: [
        {
          id: "owner",
          rules: [
            { target: "view", view: "catalog-list", can: ["read"] },
            { target: "view", view: "admin-product-list", can: ["read"] },
            { target: "view", view: "admin-product-form", can: ["read"] },
          ],
        },
        {
          id: "editor",
          rules: [
            { target: "view", view: "catalog-list", can: ["read"] },
            { target: "view", view: "admin-product-list", can: ["read"] },
          ],
        },
        { id: "viewer", rules: [{ target: "view", view: "catalog-list", can: ["read"] }] },
        { id: "customer", rules: [{ target: "view", view: "catalog-list", can: ["read"] }] },
      ],
    },
  };
}

function viewOf(id: string): View {
  const view = manifest().app.views.find((candidate) => candidate.id === id);
  if (view === undefined) {
    throw new Error("fixture broken");
  }
  return view;
}

/** `ListViewRenderer` は `ListView` を要求するので、題材の型を絞って渡す。 */
function listViewOf(id: string): Extract<View, { type: "list_view" }> {
  const view = viewOf(id);
  if (view.type !== "list_view") {
    throw new Error("fixture broken");
  }
  return view;
}

/** 運営テーブル(`st_owner` も `st_public` も持たない)+ 画面1本の題材。 */
function adminOnlyManifest(roles: RoleDeclaration[]): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "運営専用",
      tables: [
        { id: "ledger", name: "元帳", fields: [{ id: "memo", name: "メモ", type: "text" }] },
      ],
      views: [{ id: "ledger-list", type: "list_view", table: "ledger", columns: ["memo"] }],
      roles,
    },
  };
}

// --- 1. 純関数の判定 -------------------------------------------------------------

test("canUseView: どの役割も名指ししていない画面は、今日から誰にも開けない(V8-M26 で既定が反転した)", () => {
  // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65` で期待値を反転させた。
  //   旧の逐語を1バイトも消していない】**
  //
  // **旧テスト名**: 「canUseView: 宣言の無い画面は今日どおり全員が開ける(ADR-0070 限定4)」。
  // **旧の本体(逐語)**:
  //   `const view = viewOf("catalog-list");`
  //   `for (const role of ["owner", "editor", "viewer", "customer", null] as const) {`
  //   `  expect(canUseView(role, manifest(), view), String(role)).toBe(true);`
  //   `}`
  // **旧の根拠**: `ADR-0070` 限定4(「**宣言の無い画面は今日どおり動く**」)と
  // 裁定 `R-4`(「規則を1本も書いていない対象は管轄外(全許可)」)。
  //
  // **今日**: **`V8-M26-T03` が `judgeRoleAccess` の既定を閉じる側へ倒した** ——
  // **`target: "view"` は、規則が1本も名指ししていなければ `allowed: false` で返る。**
  // **役割を1つも宣言していないアプリも同じく閉じる**(`D-V8-65`)。
  // **【禁止の履行】これを「同じ挙動を保った」と書かない。既定は反転した。**
  //
  // **題材の `catalog-list` は今日4ロールから名指しされている**(下の本数の検査が
  // 旧の `3 / 2 / 1 / 1` を測り続けるため)ので、**ここでは名指しだけを外した写しで測る。**
  const unruled = manifest();
  for (const declaration of unruled.app.roles ?? []) {
    declaration.rules = (declaration.rules ?? []).filter(
      (rule) => !(rule.target === "view" && rule.view === "catalog-list"),
    );
  }
  const view = viewOf("catalog-list");
  for (const role of ["owner", "editor", "viewer", "customer", null] as const) {
    expect(canUseView(role, unruled, view), String(role)).toBe(false);
  }
});

test("canUseView: 宣言のある画面は列挙されたロールだけが開ける(テーブルは読めるのに開けない)", () => {
  const view = viewOf("admin-product-list");
  // **対象テーブル `product` は `st_public` を持つので、customer も viewer も「読める」。**
  // **それでも画面は開けない** —— これがテーブル単位の判定では作れなかった区別である。
  expect(canUseView("owner", manifest(), view)).toBe(true);
  expect(canUseView("editor", manifest(), view)).toBe(true);
  expect(canUseView("viewer", manifest(), view)).toBe(false);
  expect(canUseView("customer", manifest(), view)).toBe(false);
  expect(canUseView(null, manifest(), view)).toBe(false);
});

// **【`V8-M27-T04` / `T-G5`。期待値を1つ反転させた。旧のテスト名と旧の期待値を逐語で残す】**
// **旧のテスト名**: `canUseView: テーブル単位の遮断と宣言は AND である(どちらか一方でも駄目なら開けない)`
// **旧の期待値(逐語)**: `expect(canUseView("customer", adminOnly, view)).toBe(false);`
// **旧の説明(逐語)**: `// **規則に customer と書いてもテーブルが読めないので開けない**(既存の遮断は緩まない)。`
// **根拠**: **`V8-M27` / 台帳 `T-G5` / ユーザ決定 `D-V8-38`。**
// **`canReadTableRole` から表単位の枝(`nonAdminTableAccess`)を撤去したので、
// `AND` の左辺は今日1件も落とさない** —— **残った右辺(面の画面の規則)が1本で決める。**
// **`owner` が規則に載っていなければ開けない、という右辺の側は1バイトも変わっていない。**
test("(反転) 画面の可否は面の規則1本で決まる(旧: テーブル単位の遮断との AND だった)", () => {
  // 運営テーブル(`st_owner` も `st_public` も無い)の画面を customer の規則で名指ししても、
  // customer は**テーブルを読めない**ので開けない。**宣言は既存の遮断を緩めない。**
  const adminOnly = adminOnlyManifest([
    { id: "customer", rules: [{ target: "view", view: "ledger-list", can: ["read"] }] },
  ]);
  const view = adminOnly.app.views[0] as View;
  // **今日は規則に customer と書けば開ける**(表の作りは1バイトも見ない)。
  expect(canUseView("customer", adminOnly, view)).toBe(true);
  // **owner はテーブルを読めるが、規則に載っていないので開けない**(宣言の側で落ちる)。
  expect(canUseView("owner", adminOnly, view)).toBe(false);
  // **どちらの条件も満たす相手だけが開ける**(規則に owner を足すと開く)。
  const opened = adminOnlyManifest([
    { id: "customer", rules: [{ target: "view", view: "ledger-list", can: ["read"] }] },
    { id: "owner", rules: [{ target: "view", view: "ledger-list", can: ["read"] }] },
  ]);
  expect(canUseView("owner", opened, opened.app.views[0] as View)).toBe(true);
  // --- 【`V8-M27-T04` / `T-G5`。期待値を反転させた。旧の1行を1バイトも消していない】 ---
  // **旧(逐語)**: `expect(canUseView("customer", opened, opened.app.views[0] as View)).toBe(false);`
  // **旧はテーブル単位の遮断で落ちていた** —— **今日は規則に載っているので開ける。**
  expect(canUseView("customer", opened, opened.app.views[0] as View)).toBe(true);
});

// --- 2. 画面一覧の本数 -----------------------------------------------------------

test("visibleViewsForRole: 宣言により本数が変わる(owner 3 / editor 2 / viewer 1 / customer 1)", () => {
  const m = manifest();
  expect(visibleViewsForRole("owner", m).map((v) => v.id)).toEqual([
    "catalog-list",
    "admin-product-list",
    "admin-product-form",
  ]);
  expect(visibleViewsForRole("editor", m).map((v) => v.id)).toEqual([
    "catalog-list",
    "admin-product-list",
  ]);
  expect(visibleViewsForRole("viewer", m).map((v) => v.id)).toEqual(["catalog-list"]);
  expect(visibleViewsForRole("customer", m).map((v) => v.id)).toEqual(["catalog-list"]);
});

test("【ADR-0053:40 の逐語が偽になったことの実測】viewer / editor でも画面が減る", () => {
  // **`ADR-0053:40` 逐語**: 「**画面が減るのは customer のときだけである。**
  // owner / editor / viewer では**1画面も減らない**」。
  // **規則を書いた画面については、今日からこれは成り立たない。**
  // **`ADR-0070` §限界5 / §Consequences が要求した実測である。**
  const m = manifest();
  expect(m.app.views).toHaveLength(3);
  expect(visibleViewsForRole("viewer", m)).toHaveLength(1); // 3 → 1(2画面 減った)
  expect(visibleViewsForRole("editor", m)).toHaveLength(2); // 3 → 2(1画面 減った)
  // **owner だけは減らない**(この題材ではどちらの規則にも owner が入っているため)。
  // **「owner は必ず全部見える」ではない** —— customer だけの規則を書けば owner も減る。
  expect(visibleViewsForRole("owner", m)).toHaveLength(3);
  const ownerExcluded: Manifest = {
    app: {
      ...m.app,
      views: [viewOf("catalog-list")],
      roles: [{ id: "customer", rules: [{ target: "view", view: "catalog-list", can: ["read"] }] }],
    },
  };
  expect(visibleViewsForRole("owner", ownerExcluded)).toHaveLength(0);
});

test("役割を1つも宣言していないマニフェストでは、今日どのロールにも1画面も並ばない(V8-M26 / D-V8-65)", () => {
  // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65` で期待値を反転させた。
  //   旧の逐語を1バイトも消していない】**
  //
  // **旧テスト名**: 「宣言が1つも無いマニフェストでは、どのロールでも本数が今日どおり
  // 変わらない(限定4)」。
  // **旧の期待値(逐語)**:
  //   `expect(visibleViewsForRole(role, noDeclaration), String(role)).toHaveLength(1);`
  //
  // **今日**: **`judgeRoleAccess` は `app.roles` が空のとき、表・画面・ボタンを閉じる**
  // (`D-V8-65`。**項目だけは今日どおり通る** —— 台帳 `T-G1b` = 却下)。
  // **したがって「既存アプリは1バイトの変更もなく今日どおり動く」(`ADR-0070` 限定4)は
  // 画面については今日から偽である。**
  // **【禁止の履行】これを「同じ挙動を保った」と書かない。既定は反転した。**
  const noDeclaration: Manifest = {
    app: {
      ...manifest().app,
      views: [viewOf("catalog-list")],
      roles: [],
    },
  };
  for (const role of ["owner", "editor", "viewer", "customer", null] as const) {
    expect(visibleViewsForRole(role, noDeclaration), String(role)).toHaveLength(0);
  }
});

// --- 3. 画面を開いたときのレコード取得に `?view=` が載る ------------------------------

let requestedUrls: string[];
let originalFetch: typeof fetch;

beforeEach(() => {
  requestedUrls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    requestedUrls.push(url);
    return new Response(JSON.stringify({ records: [], total: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const OWNER_ROLE = "owner" as const;

test("一覧を描くと、レコード取得の URL に ?view=<view_id> が載る(サーバの判定に届く)", async () => {
  render(
    <RoleProvider role={OWNER_ROLE}>
      <ListViewRenderer
        appId={APP_ID}
        manifest={manifest()}
        view={listViewOf("admin-product-list")}
      />
    </RoleProvider>,
  );
  await waitFor(() => {
    expect(requestedUrls.length).toBeGreaterThan(0);
  });
  const recordUrl = requestedUrls.find((url) => url.includes("/tables/product/records"));
  expect(recordUrl).toBeDefined();
  expect(recordUrl).toContain("view=admin-product-list");
  // **画面が実際に描かれている**(URL だけ変えて描画が壊れていない)。
  await waitFor(() => {
    expect(screen.getByTestId("view-renderer-list_view")).toBeDefined();
  });
});
