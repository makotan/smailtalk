/**
 * **未ログインのまま公開画面を開いて、中身が見える経路**(`V8-M26-T05`)。
 *
 * ## なぜこの1本が要るか(**穴を名指しする**)
 *
 * **`ADR-0314` §限界4 の逐語**(`docs/adr/0314-app-definition-login-required.md:303`):
 *   > **未ログインのまま公開画面を**開く**ことは、今日成り立たない** —— **名前しか渡らないので
 *   > 画面を描く材料が無い。** … **E2E に匿名で公開画面を開く筋が1本も無かったので、
 *   > 落ちた検査は0件だった** = **この穴は検査に守られていない。**
 *
 * **`ADR-0319` §限界6 も同じことを申告している**(「**E2E に匿名で公開画面を開く筋が
 * 1本も無い。本 ADR も1本も足していない**」)。**本ファイルがその1本である。**
 *
 * ## 根拠(ユーザ決定)
 *
 * - **`D-V8-57`**(選ばれた見出し = **実際に開けるようにする**)。
 * - **`D-V8-64`**(選ばれた見出し = **表にも1行書いたぶんだけ見せる**)。
 *
 * ## この E2E が測らないこと(**誇張しない**)
 *
 * - **`D-V8-64` の分岐(表の規則を書かなければ 0件)はここでは測っていない** ——
 *   **`src/server/anonymous-public-view.test.ts` の (c) / (d) が本物の SQLite の上で測る。**
 * - **公開画面で項目を隠せないことも、ここでは測っていない**(同ファイルの (e))。
 * - **`data/` の実地インスタンスには1バイトも当てていない**(E2E は一時 dataRoot である)。
 */
import { type APIRequestContext, expect, test } from "@playwright/test";
import type { Manifest } from "../../src/kernel/types.ts";
import { type FixtureApp, provisionApp } from "./fixture-app.ts";

/** 公開規約フィールド(`ADR-0034` の匿名 read-only 窓)。 */
const PUBLIC_FIELD = "st_public";

const PUBLIC_VIEW = "public-catalog";
const ADMIN_VIEW = "admin-catalog";
const TABLE = "catalog";

/**
 * **払い出したアプリに、公開の商品一覧を1枚足す。**
 *
 * **役割の規則は題材が自分で全部書く** —— **`web/e2e/fixture-server.ts` の
 * `grantFixtureRoleRules` は「1度でも名指しされた対象」には1本も足さないので、
 * ここで名指ししておけば注入が当たらない。** **注入任せにすると、運営専用のつもりの画面まで
 * `anonymous` に開いてしまう**(公開規約を宣言した表の画面へ自動で配られるため)。
 */
async function installPublicCatalog(
  request: APIRequestContext,
  app: FixtureApp,
): Promise<Manifest> {
  const next = structuredClone(app.manifest);
  /** **役割の一覧を緩い形で触る**(規則の値域の正はスキーマであり、この型ではない)。 */
  const loose = next.app as unknown as {
    roles?: { id: string; name?: string; rules?: Record<string, unknown>[] }[];
  };
  next.app.tables = [
    ...next.app.tables,
    {
      id: TABLE,
      name: "商品",
      fields: [
        { id: "name", name: "商品名", type: "text", required: true },
        { id: "price", name: "価格", type: "number" },
        { id: PUBLIC_FIELD, name: "公開", type: "boolean" },
      ],
    },
  ] as Manifest["app"]["tables"];
  next.app.views = [
    ...next.app.views,
    {
      id: PUBLIC_VIEW,
      name: "商品一覧",
      type: "list_view",
      table: TABLE,
      columns: ["name", "price"],
    },
    {
      id: ADMIN_VIEW,
      name: "商品台帳",
      type: "list_view",
      table: TABLE,
      columns: ["name", "price"],
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
  // **運営** —— **行を作るのと、2枚とも開けるのに要る分。**
  push("owner", [
    { target: "table", table: TABLE, can: ["read", "write", "delete"] },
    { target: "view", view: PUBLIC_VIEW, can: ["read"] },
    { target: "view", view: ADMIN_VIEW, can: ["read"] },
  ]);
  // **未ログイン** —— **`D-V8-57` の「画面」1本と、`D-V8-64` の「表」1本。**
  // **運営台帳(`ADMIN_VIEW`)は名指ししない** —— **面の既定が閉じているので開かない。**
  push("anonymous", [
    { target: "view", view: PUBLIC_VIEW, can: ["read"] },
    { target: "table", table: TABLE, can: ["read"] },
  ]);
  loose.roles = roles;

  const replaced = await request.post(`/__e2e__/apps/${app.appId}/manifest`, { data: next });
  expect(replaced.status(), await replaced.text()).toBe(200);
  return next;
}

test.describe("未ログインで公開画面を開く(V8-M26-T05 / T-G27b / D-V8-57)", () => {
  test("未ログインのまま公開画面を開くと、中身(行と項目の見出し)が見える", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await installPublicCatalog(request, app);
    // **行は運営が作る**(公開1件 / 非公開1件)。
    await app.createRecord(TABLE, { name: "藻塩", price: 800, [PUBLIC_FIELD]: true });
    await app.createRecord(TABLE, { name: "試作品", price: 0, [PUBLIC_FIELD]: false });

    // **ブラウザに cookie を1つも入れない**(= 未ログイン)。
    await page.goto(`/apps/${app.appId}/views/${PUBLIC_VIEW}`);

    // **【この1本が `ADR-0314` §限界4 / `ADR-0319` §限界6 の穴を塞いだ実測である】**
    await expect(page.getByTestId("anonymous-workspace")).toBeVisible();
    await expect(page.getByTestId("login-page")).toHaveCount(0);

    const main = page.getByTestId("workspace-main");
    // **項目の見出し(= `D-V8-57` の説明文が代償として名指しした「項目の並び」)。**
    await expect(main).toContainText("商品名");
    await expect(main).toContainText("価格");
    // **公開行は見える。**
    await expect(main).toContainText("藻塩");
    // **非公開行は見えない**(`ADR-0034` の窓は今日も `st_public` 1本である)。
    await expect(main).not.toContainText("試作品");
  });

  test("公開画面の中にも、ログイン画面への導線が残る(T-G26b / T-G28)", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await installPublicCatalog(request, app);
    await app.createRecord(TABLE, { name: "藻塩", price: 800, [PUBLIC_FIELD]: true });

    await page.goto(`/apps/${app.appId}/views/${PUBLIC_VIEW}`);
    await expect(page.getByTestId("anonymous-workspace")).toBeVisible();
    await expect(page.getByTestId("anonymous-login-link")).toBeVisible();
    // **ログイン済みの導線は1つも出ない。**
    await expect(page.getByTestId("logout")).toHaveCount(0);
    await expect(page.getByTestId("current-role")).toHaveCount(0);

    // **押せばログイン画面に着く**(ログイン画面は今日どおり必ず開ける)。
    await page.getByTestId("anonymous-login-link").click();
    await expect(page.getByTestId("login-page")).toBeVisible();
  });

  test("未ログインに開いていない画面を URL で名乗っても、ログイン画面に落ちる", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await installPublicCatalog(request, app);
    await app.createRecord(TABLE, { name: "藻塩", price: 800, [PUBLIC_FIELD]: true });

    await page.goto(`/apps/${app.appId}/views/${ADMIN_VIEW}`);
    await expect(page.getByTestId("login-page")).toBeVisible();
    await expect(page.getByTestId("anonymous-workspace")).toHaveCount(0);
    // **運営台帳に載っている行の値も、画面の名前も1バイトも出ない。**
    await expect(page.getByTestId("login-page")).not.toContainText("商品台帳");
  });
});
