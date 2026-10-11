/**
 * **未ログインの公開画面で、参照が参照先の代表項目の名前で出る**(`V21-M3`。`ADR-0482` の `AN-G4`。
 * 計画 `docs/plan/v21/00-v21-plan.md` §3-2 の C7 と §8-3b の C26 の「参照の表示」)。
 *
 * - **参照先も未ログインで読める表(カテゴリ)** —— 参照の列に名前が出て、「(見つかりません:」を含まない。
 *   **カテゴリの表には未ログインに開いていない店用の一覧画面がある**(`ADR-0482` §1-5 の対照 (a))。
 * - **参照先が未ログインで読めない表(製造元。未ログインの規則が無い)** —— 今日どおり「(見つかりません: 行ID)」。
 * - **参照先の代表項目を未ログインに隠した表(ブランド)** —— 名前にしない(今日の「見つかりません」と
 *   同じ表示。§4-2)。 **隠した値(`SECRET-H`)は画面に1文字も出ない。**
 *
 * ## この E2E が測らないこと(誇張しない)
 *
 * - `GET /public` の応答の中身(どの表の定義を渡すか)は
 *   `src/kernel/anonymous-public-view-reference-http.test.ts` が本物の SQLite の上で測る。
 * - 配布用の器(`runner`)は `web/test/anonymous-reference-label.test.tsx` が差し替えの上で測る
 *   (実ブラウザでは測っていない)。
 */
import { type APIRequestContext, expect, test } from "@playwright/test";
import type { Manifest } from "../../src/kernel/types.ts";
import { type FixtureApp, provisionApp } from "./fixture-app.ts";

const PUBLIC_VIEW = "anon-ref-list";
const SECRET = "SECRET-H";

async function installCatalog(request: APIRequestContext, app: FixtureApp): Promise<void> {
  const next = structuredClone(app.manifest);
  const loose = next.app as unknown as {
    roles?: { id: string; name?: string; rules?: Record<string, unknown>[] }[];
  };
  next.app.tables = [
    ...next.app.tables,
    {
      id: "ar_category",
      name: "カテゴリ",
      fields: [{ id: "name", name: "名前", type: "text" }],
    },
    {
      id: "ar_maker",
      name: "製造元",
      fields: [{ id: "name", name: "名前", type: "text" }],
    },
    {
      id: "ar_brand",
      name: "ブランド",
      representative_field: "label",
      fields: [
        { id: "code", name: "記号", type: "text" },
        { id: "label", name: "名前", type: "text" },
      ],
    },
    {
      id: "ar_product",
      name: "商品",
      fields: [
        { id: "name", name: "商品名", type: "text", required: true },
        { id: "cat", name: "カテゴリ", type: "reference", reference_table: "ar_category" },
        { id: "maker", name: "製造元", type: "reference", reference_table: "ar_maker" },
        { id: "brand", name: "ブランド", type: "reference", reference_table: "ar_brand" },
      ],
    },
  ] as Manifest["app"]["tables"];
  next.app.views = [
    ...next.app.views,
    {
      id: PUBLIC_VIEW,
      name: "商品一覧",
      type: "list_view",
      table: "ar_product",
      columns: ["name", "cat", "maker", "brand"],
    },
    // **店用のカテゴリ一覧**(未ログインに開いていない。名乗らない読取の壁が今日なら閉じる形)。
    {
      id: "ar-category-admin",
      name: "カテゴリ管理",
      type: "list_view",
      table: "ar_category",
      columns: ["name"],
    },
  ] as Manifest["app"]["views"];

  const roles = loose.roles ?? [];
  const push = (roleId: string, rules: Record<string, unknown>[]): void => {
    const found = roles.find((role) => role.id === roleId);
    if (found === undefined) {
      roles.push({ id: roleId, name: roleId, rules });
      return;
    }
    found.rules = [...(found.rules ?? []), ...rules];
  };
  push("owner", [
    ...["ar_category", "ar_maker", "ar_brand", "ar_product"].map((table) => ({
      target: "table",
      table,
      can: ["read", "write", "delete"],
    })),
    { target: "view", view: PUBLIC_VIEW, can: ["read"] },
    { target: "view", view: "ar-category-admin", can: ["read"] },
  ]);
  push("anonymous", [
    { target: "view", view: PUBLIC_VIEW, can: ["read"] },
    { target: "table", table: "ar_product", can: ["read"] },
    { target: "table", table: "ar_category", can: ["read"] },
    { target: "table", table: "ar_brand", can: ["read"], hidden_fields: ["label"] },
  ]);
  loose.roles = roles;

  const replaced = await request.post(`/__e2e__/apps/${app.appId}/manifest`, { data: next });
  expect(replaced.status(), await replaced.text()).toBe(200);
}

test.describe("未ログインの公開画面で参照を名前で出す(V21-M3 / AN-G4)", () => {
  test("読める参照先は名前、読めない参照先と代表項目を隠した参照先は「見つかりません」", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await installCatalog(request, app);
    const categoryId = await app.createRecord("ar_category", { name: "藻塩のなかま" });
    const makerId = await app.createRecord("ar_maker", { name: "製造元の名前" });
    const brandId = await app.createRecord("ar_brand", { code: "B1", label: SECRET });
    await app.createRecord("ar_product", {
      name: "藻塩",
      cat: categoryId,
      maker: makerId,
      brand: brandId,
    });

    // **ブラウザに cookie を1つも入れない**(= 未ログイン)。
    await page.goto(`/apps/${app.appId}/views/${PUBLIC_VIEW}`);
    await expect(page.getByTestId("anonymous-workspace")).toBeVisible();
    const main = page.getByTestId("workspace-main");
    await expect(main).toContainText("藻塩");

    // **(C7) 参照先も未ログインで読める → 代表項目の値。**
    await expect(main).toContainText("藻塩のなかま");
    await expect(main).not.toContainText(`(見つかりません: ${categoryId})`);
    // **読めない参照先 → 今日どおり。**
    await expect(main).toContainText(`(見つかりません: ${makerId})`);
    await expect(main).not.toContainText("製造元の名前");
    // **(C26) 代表項目を隠した参照先 → 名前にしない。 隠した値は出ない。**
    await expect(main).toContainText(`(見つかりません: ${brandId})`);
    await expect(page.locator("body")).not.toContainText(SECRET);
    await expect(page.locator("body")).not.toContainText("B1");
  });
});
