/**
 * **`V8-M26-T03b` —— 「管轄内か」と「規則が名指ししているか」を割ったことの検査。**
 *
 * ユーザ決定 `D-V8-45` / `D-V8-65`、台帳 `T-G1a` / `T-G4b` が仕様である。
 *
 * ## 何が起きたのか(**着手前の実測**)
 *
 * **`V8-M26-T03` が面の既定を「閉じる」側へ倒した結果、画面(`target: "view"`)は
 * 規則を1本も書いていなくても `judgeRoleAccess(...).governed === true` で返るようになった。**
 *
 * **`web/src/auth/authz.tsx` の `viewIdForRecordRequest` はその `governed` を見て
 * 「サーバに名乗るべき画面か」を決めていた** —— **したがって全画面が `?view=` を名乗り、
 * レコード取得の URL が全部変わった。** **実測で `web/test/` の赤が 384 本になった。**
 *
 * **その関数の doc 自身が禁じている形である**(逐語):
 * **「常に名乗ると、宣言を1つも書いていないアプリのレコード取得 URL まで今日と変わる。
 * それは『1バイトの変更もなく』ではない。」**
 *
 * ## 今日の姿
 *
 * **`src/server/owner-scope.ts` に述語 `roleRulesNameTarget` を1本足した** ——
 * **意味は「その対象を名指しした規則が、どれかの役割に1本でも書かれているか」であり、
 * = **既定を閉じる前の `governed` の意味そのもの**である。**
 * **`viewIdForRecordRequest` はそちらを見る。**
 *
 * **判定のロジックを2本目に増やしていない** —— **`roleRulesNameTarget` は
 * `judgeRoleAccess` の中の `ruleNamesTarget` を再利用している。**
 *
 * ## このファイルが固定すること
 *
 * (a) **`roleRulesNameTarget` は「名指しされているか」だけを見る**(動詞・役割・条件を見ない)。
 * (b) **`viewIdForRecordRequest` は、規則が名指ししていない画面では `undefined` を返す** ——
 *     **役割を1つも宣言していないアプリでも、規則を書いたが別の画面を名指ししたアプリでも。**
 * (c) **実際に組み立てられる URL に `view=` が1バイトも載らない**(着手前と同一)。
 * (d) **規則が名指しした画面では今日どおり `?view=` が載る**(名乗りを弱めていない)。
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * - **`roleRulesNameTarget` は許可を1ミリも決めない。** **可否は `judgeRoleAccess` 1本のままで
 *   あり、本ファイルは可否を1つも測っていない**(既定が閉じたことの実測は
 *   `src/server/role-default-closed.test.ts` が持つ)。
 * - **`?view=` は遮断ではない**(`ADR-0070` 限定4)—— **外して直接叩けば今日どおり通る。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ListView, Manifest, RoleDeclaration } from "../../src/kernel/types.ts";
import { judgeRoleAccess, roleRulesNameTarget } from "../../src/server/owner-scope.ts";
import { RoleProvider, viewIdForRecordRequest } from "../src/auth/authz.tsx";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";

const APP_ID = "named-view-shop";

/**
 * **`<RoleProvider role="owner">` と直に書かない** —— **lint(`a11y/useValidAriaRole`)が
 * リテラルの `role` 属性を WAI-ARIA の役割と読み違えて赤くする。**
 * **`web/test/view-audience-visibility.test.tsx` が同じ理由で同じ定数を持っている。**
 */
const OWNER_ROLE = "owner" as const;

/** 規則を1本も書かない既定3役割(**宣言は在るが、何も名指ししていない**)。 */
const ROLES_WITHOUT_RULES: RoleDeclaration[] = [
  { id: "owner", name: "持ち主" },
  { id: "editor", name: "編集者" },
  { id: "viewer", name: "閲覧者" },
];

/** **表だけを名指しした規則**(画面は1つも名指ししていない)。 */
const ROLES_NAMING_TABLE_ONLY: RoleDeclaration[] = [
  {
    id: "owner",
    name: "持ち主",
    rules: [{ target: "table", table: "product", can: ["read", "write", "delete"] }],
  },
];

/** **画面 `admin-product-list` を名指しした規則。** */
const ROLES_NAMING_VIEW: RoleDeclaration[] = [
  {
    id: "owner",
    name: "持ち主",
    rules: [
      { target: "table", table: "product", can: ["read", "write", "delete"] },
      { target: "view", view: "admin-product-list", can: ["read"] },
    ],
  },
];

function manifest(roles?: RoleDeclaration[]): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "名乗りの検査",
      tables: [
        {
          id: "product",
          name: "商品",
          fields: [{ id: "title", name: "名前", type: "text", required: true }],
        },
      ],
      views: [
        {
          id: "admin-product-list",
          type: "list_view",
          name: "商品一覧",
          table: "product",
          columns: ["title"],
        },
        {
          id: "public-product-list",
          type: "list_view",
          name: "公開一覧",
          table: "product",
          columns: ["title"],
        },
      ],
      ...(roles === undefined ? {} : { roles }),
    },
  } as Manifest;
}

function listViewOf(m: Manifest, viewId: string): ListView {
  const view = m.app.views.find((v) => v.id === viewId);
  if (view === undefined || view.type !== "list_view") {
    throw new Error(`題材が壊れている: ${viewId}`);
  }
  return view;
}

// --- (a) 述語そのもの --------------------------------------------------------------

test("roleRulesNameTarget は「名指しされているか」だけを見る(役割を1つも宣言していない)", () => {
  expect(
    roleRulesNameTarget({
      manifest: manifest(),
      target: { target: "view", view: "admin-product-list" },
    }),
  ).toBe(false);
});

test("roleRulesNameTarget は、規則を1本も持たない役割宣言も「名指し無し」と読む", () => {
  expect(
    roleRulesNameTarget({
      manifest: manifest(ROLES_WITHOUT_RULES),
      target: { target: "view", view: "admin-product-list" },
    }),
  ).toBe(false);
});

test("roleRulesNameTarget は、別の種類(表)の規則を画面の名指しと取り違えない", () => {
  const m = manifest(ROLES_NAMING_TABLE_ONLY);
  expect(roleRulesNameTarget({ manifest: m, target: { target: "table", table: "product" } })).toBe(
    true,
  );
  expect(
    roleRulesNameTarget({ manifest: m, target: { target: "view", view: "admin-product-list" } }),
  ).toBe(false);
});

test("roleRulesNameTarget は、名指しされた画面だけを真にする(別の画面は偽)", () => {
  const m = manifest(ROLES_NAMING_VIEW);
  expect(
    roleRulesNameTarget({ manifest: m, target: { target: "view", view: "admin-product-list" } }),
  ).toBe(true);
  expect(
    roleRulesNameTarget({ manifest: m, target: { target: "view", view: "public-product-list" } }),
  ).toBe(false);
});

test("roleRulesNameTarget は許可を1ミリも決めない(名指しが真でも、面は止めうる)", () => {
  const m = manifest(ROLES_NAMING_VIEW);
  // **`viewer` は `admin-product-list` の規則を1本も持たない** —— 名指しは在るが通らない。
  expect(
    roleRulesNameTarget({ manifest: m, target: { target: "view", view: "admin-product-list" } }),
  ).toBe(true);
  expect(
    judgeRoleAccess({
      manifest: m,
      roles: "viewer",
      target: { target: "view", view: "admin-product-list" },
      verb: "read",
    }).allowed,
  ).toBe(false);
});

test("既定が閉じた今日、governed はもう「名指しされているか」の答えではない(割れたことの実測)", () => {
  const m = manifest(ROLES_WITHOUT_RULES);
  const target = { target: "view", view: "admin-product-list" } as const;
  // **閉じる側の管轄内なので `governed` は真。** **名指しは偽。** **2つは別の問いである。**
  expect(judgeRoleAccess({ manifest: m, roles: null, target, verb: "read" }).governed).toBe(true);
  expect(roleRulesNameTarget({ manifest: m, target })).toBe(false);
});

// --- (b) 名乗るべき画面ID ----------------------------------------------------------

test("viewIdForRecordRequest は、規則が名指ししていない画面では undefined(着手前と同じ)", () => {
  for (const roles of [undefined, ROLES_WITHOUT_RULES, ROLES_NAMING_TABLE_ONLY]) {
    const m = manifest(roles);
    expect(viewIdForRecordRequest(m, listViewOf(m, "admin-product-list"))).toBeUndefined();
    expect(viewIdForRecordRequest(m, listViewOf(m, "public-product-list"))).toBeUndefined();
  }
});

test("viewIdForRecordRequest は、規則が名指しした画面だけ画面IDを返す", () => {
  const m = manifest(ROLES_NAMING_VIEW);
  expect(viewIdForRecordRequest(m, listViewOf(m, "admin-product-list"))).toBe("admin-product-list");
  expect(viewIdForRecordRequest(m, listViewOf(m, "public-product-list"))).toBeUndefined();
});

// --- (c)(d) 実際に組み立てられる URL ------------------------------------------------

let requestedUrls: string[];
let originalFetch: typeof fetch;

beforeEach(() => {
  requestedUrls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requestedUrls.push(typeof input === "string" ? input : input.toString());
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

test("規則を1本も書いていないアプリのレコード取得 URL には view= が1バイトも載らない", async () => {
  const m = manifest(ROLES_WITHOUT_RULES);
  render(
    <RoleProvider role={OWNER_ROLE}>
      <ListViewRenderer appId={APP_ID} manifest={m} view={listViewOf(m, "admin-product-list")} />
    </RoleProvider>,
  );
  await waitFor(() => {
    expect(requestedUrls.length).toBeGreaterThan(0);
  });
  const recordUrl = requestedUrls.find((url) => url.includes("/tables/product/records"));
  expect(recordUrl).toBeDefined();
  expect(recordUrl).not.toContain("view=");
});

test("役割を1つも宣言していないアプリでも、レコード取得 URL は着手前と1バイトも変わらない", async () => {
  const m = manifest();
  render(
    <RoleProvider role={OWNER_ROLE}>
      <ListViewRenderer appId={APP_ID} manifest={m} view={listViewOf(m, "admin-product-list")} />
    </RoleProvider>,
  );
  await waitFor(() => {
    expect(requestedUrls.length).toBeGreaterThan(0);
  });
  const recordUrl = requestedUrls.find((url) => url.includes("/tables/product/records"));
  expect(recordUrl).toBeDefined();
  expect(recordUrl).not.toContain("view=");
});

test("規則が名指しした画面では、今日どおり ?view= が載る(名乗りを弱めていない)", async () => {
  const m = manifest(ROLES_NAMING_VIEW);
  render(
    <RoleProvider role={OWNER_ROLE}>
      <ListViewRenderer appId={APP_ID} manifest={m} view={listViewOf(m, "admin-product-list")} />
    </RoleProvider>,
  );
  await waitFor(() => {
    expect(requestedUrls.length).toBeGreaterThan(0);
  });
  const recordUrl = requestedUrls.find((url) => url.includes("/tables/product/records"));
  expect(recordUrl).toBeDefined();
  expect(recordUrl).toContain("view=admin-product-list");
});
