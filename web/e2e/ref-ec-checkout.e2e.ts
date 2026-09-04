/**
 * **参照EC(`scripts/ref-ec/manifest.ts`)の一覧の導線を、本物のブラウザ(chromium)で確かめる E2E。**
 *
 * **`v5` の12本のマイルストーンは E2E を1本も足していない。これが最初の1本である。**
 *
 * 確かめるのは **4点だけ**である(増やしていない):
 *
 *   1. `V5-M21`(一覧の行の操作起点)+ `V5-M24`(URL とプリフィル)
 *      —— `cart-list` の行の「会計に進む」を押すと `?prefill.cart=<行の _id>` が URL に載り、
 *         `checkout-form` の「もとになった買い物かご」欄がその行で埋まる。
 *   2. `V5-M22`(行き先の宣言)
 *      —— `order-list` の行の「会計の控えを見る」が `order-receipt` へ行く。
 *         **規約(同テーブルの先頭 `detail_view`)なら `order-detail` である。宣言が規約に勝つ。**
 *   3. `V5-M23`(見せる相手)
 *      —— `catalog-list` のボタンが owner と customer で入れ替わる。
 *   4. `V5-M25`(手動起動)
 *      —— owner が `catalog-list` の「取り扱いをやめる」を押すと `product.status` が `archived` になる。
 *
 * ## **参照EC のマニフェストから落としたもの(全件)**
 *
 * **落としたワークフローは2本である。**
 *
 *   - **`wf-order-checkout`**(`on_create` / `order`)…… `call_external`(connection `mock-psp`)を含む。
 *   - **`wf-order-enrich`**(`on_update` / `order`)…… `ai_transform`(capability `ai-copywriter`)を含む。
 *
 * **理由**: E2E のフィクスチャサーバ(`web/e2e/fixture-server.ts`)は別プロセスで立ち、
 * テスト側から接続(connection)も AI capability も発行できない。**(2) は `order` の行を
 * 実際に作る必要があるので、この2本を残したままだと `on_create` の外部呼び出しが失敗する。**
 * **落としたのはこの2本だけで、残り9本(`wf-cart-line-total` / `wf-cart-line-dedupe` /
 * `wf-payment-received` / `wf-order-audit` / `wf-order-cancel-request` / `wf-cart-close` /
 * `wf-product-archive` / `wf-totals-sweep` / `wf-stale-order-sweep`)はそのまま入れている。**
 * **テーブル・ビュー・function は1件も落としていない。**
 *
 * ## **参照EC を「差し替え」ではなく「足し込み」で入れている理由**
 *
 * `POST /__e2e__/apps/<app_id>/manifest` は `applyManifest` をそのまま呼ぶ。既定は
 * **additive のみ**(`src/kernel/apply-manifest.ts`)なので、払い出したアプリの既存テーブル
 * (`categories` / `items`)を消す差し替えは通らない。**したがって参照EC のテーブル・ビュー・
 * function・ワークフローを、払い出したアプリのマニフェストに足す形で入れている。**
 * **その結果、このアプリにはフィクスチャ由来の画面も残っている**(参照EC 単体のアプリではない)。
 * **参照EC 側の ID とは1件も衝突していない**(衝突していれば `applyManifest` が 400 を返す)。
 *
 * ## **この E2E が確かめていないこと(先に書く)**
 *
 * - **`cart_line` を1行も作っていない。** 作ると島(`fn-line-total` / `fn-cart-line-dedupe`)が
 *   起きるので、(1) は `cart` の行だけで書いてある。**「カートに商品を入れてから会計する」という
 *   通しの筋書きは、ここでは1度も通っていない。**
 * - **会計フォームを送信していない。** (1) が見ているのは **URL とプリフィルが効くところまで**である。
 * - **決済(`payment_events` / `wf-payment-received`)を1度も動かしていない。**
 * - **【`V8-M20` / `J-G29`】旧文は `audience` を名指ししていた。撤去された。**
 *   **今日ボタンの出し分けを決めるのは役割の規則であり、これは表示層の先回りガードである**
 *   (`ADR-0177` 限定6 と同じ線)。(3) が確かめているのは
 *   **ボタンが出るか出ないか**だけで、**同じ操作をサーバが断るかどうかは1つも見ていない。**
 * - **【`V5-M28-T04` / `ADR-0249` §Decision 7 の 10 による引き直し。上の1行は1バイトも消していない】**
 *   **上の前段(「表示層の先回りガードである」)は `ADR-0177` 当時の正であり、今日の正ではない。**
 *   **今日は、ボタンの規則はその起点が書く先のテーブルへの作成(`POST` / バッチ `create`)と
 *   更新(`PATCH` / バッチ `update`)の壁でもあり、列挙に載っていない相手はサーバに 403 で断られる**
 *   (`ADR-0249` §Decision)。**名乗り(`?view=`)の有無に依存しない。**
 *   **後段は今日も真である** —— **この E2E は 403 を1度も測っていない。**
 *   403 を測っているのは `scripts/ref-ec/checkout-journey.test.ts` の `(E)` 群のほうである。
 *   **止まらない経路5本(受信口 / MCP / 自動処理 / コードの島 / `DELETE`。`ADR-0249` 限定13)も、
 *   この E2E は1本も測っていない。**
 */
import { type APIRequestContext, expect, test } from "@playwright/test";
import { referenceEcManifest } from "../../scripts/ref-ec/manifest.ts";
import type { Manifest } from "../../src/kernel/types.ts";
import { type FixtureApp, provisionApp, seedRoleSession } from "./fixture-app.ts";

/** 上の doc に理由を書いた、落とすワークフロー。**この2本だけである。** */
const DROPPED_WORKFLOW_IDS: readonly string[] = ["wf-order-checkout", "wf-order-enrich"];

/** 払い出したアプリのマニフェストに、参照EC の定義を足したものを返す(既存は1件も消さない)。 */
function withReferenceEc(base: Manifest): Manifest {
  const ref = referenceEcManifest();
  const next = structuredClone(base);
  next.app.tables = [...next.app.tables, ...ref.app.tables];
  next.app.views = [...next.app.views, ...ref.app.views];
  next.app.functions = [...(next.app.functions ?? []), ...(ref.app.functions ?? [])];
  // **【`V8-M20` / `J-G27`〜`J-G30`】役割の一覧も足す。**
  // **参照EC の権限は、撤去前は `view_action.audience` / `st_admin_readable` として
  // 表・画面・ボタンの定義そのものに書かれていたので、上の3行(tables / views / workflows)を
  // 写すだけで一緒に入ってきた。****今日は `app.roles` に分かれているので、明示的に写す。**
  // **足し込みではなく差し替えである** —— **参照EC の `roles` は既定の3ロール
  // (owner / editor / viewer)を含んでおり、払い出したアプリの3ロールと `id` が衝突する。**
  if (ref.app.roles !== undefined) {
    next.app.roles = ref.app.roles;
  }
  next.app.workflows = [
    ...(next.app.workflows ?? []),
    ...(ref.app.workflows ?? []).filter((workflow) => !DROPPED_WORKFLOW_IDS.includes(workflow.id)),
  ];
  return next;
}

/** 稼働中のサーバに、自分のアプリ限定で参照EC を足す。 */
async function installReferenceEc(request: APIRequestContext, app: FixtureApp): Promise<void> {
  const replaced = await request.post(`/__e2e__/apps/${app.appId}/manifest`, {
    data: withReferenceEc(app.manifest),
  });
  expect(replaced.status(), await replaced.text()).toBe(200);
}

/**
 * 指定したセッションの cookie でレコードを1件作る。
 *
 * `FixtureApp.createRecord` は**既定セッション(owner)**で叩くので、`st_owner` が効く表
 * (`cart` / `order`)の行を購入者のものとして作れない。ここは `authHeaders` を受け取る。
 */
async function createAs(
  request: APIRequestContext,
  appId: string,
  tableId: string,
  data: Record<string, unknown>,
  headers: { cookie: string },
): Promise<string> {
  const created = await request.post(`/api/apps/${appId}/tables/${tableId}/records`, {
    data,
    headers,
  });
  expect(created.status(), await created.text()).toBe(201);
  const body = (await created.json()) as { record: { _id: string } };
  return body.record._id;
}

/** 1件読む(検算用)。 */
async function readAs(
  request: APIRequestContext,
  appId: string,
  tableId: string,
  recordId: string,
  headers: { cookie: string },
): Promise<Record<string, unknown>> {
  const response = await request.get(`/api/apps/${appId}/tables/${tableId}/records/${recordId}`, {
    headers,
  });
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as { record: Record<string, unknown> };
  return body.record;
}

const viewUrl = (appId: string, viewId: string): string => `/apps/${appId}/views/${viewId}`;

test("(1) 買い物かご一覧の行から会計へ進むと、URL に prefill が載り、会計画面の欄が埋まる", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  const shopper = await seedRoleSession(request, app.appId, "customer");
  await installReferenceEc(request, app);

  // `cart` は `st_owner` が効くので、**購入者のセッションで作る**(owner で作ると購入者から見えない)。
  // **`cart_line` は1行も作らない**(島を起こさないため。冒頭 doc の「確かめていないこと」)。
  const cartId = await createAs(
    request,
    app.appId,
    "cart",
    { status: "open", created_at: "2026-08-05" },
    shopper.authHeaders,
  );

  await shopper.authenticate(page.context());
  await page.goto(viewUrl(app.appId, "cart-list"));
  await expect(page.getByTestId("current-role")).toHaveAttribute("data-role", "customer");

  const rows = page.getByTestId("list-row");
  await expect(rows).toHaveCount(1);

  // `V5-M21`: **行の中に操作起点がある**(着手前、参照EC の `actions` は詳細画面にしか無かった)。
  await rows.first().getByTestId("list-action-origin-checkout-form").click();

  // `V5-M24`: **押した行の `_id` がクエリ文字列に載る。** 運搬は URL 1本である。
  await expect(page).toHaveURL(`${viewUrl(app.appId, "checkout-form")}?prefill.cart=${cartId}`);

  // 遷移先が会計の入力画面である。
  await expect(page.getByTestId("view-renderer-form")).toBeVisible();
  // **プリフィルが効いている** —— 「もとになった買い物かご」欄に、押した行が入っている。
  await expect(page.getByTestId("field-label-cart")).toContainText("もとになった買い物かご");
  await expect(page.getByTestId("field-input-cart")).toHaveValue(cartId);
});

test("(2) 注文一覧の行の「会計の控えを見る」は、規約の order-detail ではなく宣言した order-receipt へ行く", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  const shopper = await seedRoleSession(request, app.appId, "customer");
  await installReferenceEc(request, app);

  // `order` も `st_owner` が効くので購入者のセッションで作る。
  // `order-list` の `filter` は `status` が `pending_payment` か `paid` の行だけを出す。
  const orderId = await createAs(
    request,
    app.appId,
    "order",
    { order_number: `E2E-${Date.now()}`, status: "pending_payment" },
    shopper.authHeaders,
  );

  await shopper.authenticate(page.context());
  await page.goto(viewUrl(app.appId, "order-list"));

  const rows = page.getByTestId("list-row");
  await expect(rows).toHaveCount(1);
  await rows.first().getByTestId("list-action-link-order-receipt").click();

  // **宣言が規約に勝っている。** 規約(`resolveDetailViewTarget` = 同テーブルの先頭
  // `detail_view`)なら `order-detail` へ行くところである。
  await expect(page).toHaveURL(`${viewUrl(app.appId, "order-receipt")}/records/${orderId}`);
  expect(page.url()).not.toContain("order-detail");
  await expect(page.getByTestId("view-renderer-detail_view")).toBeVisible();
});

test("(3) 商品一覧の操作起点は、owner と customer で入れ替わる", async ({ browser, request }) => {
  const app = await provisionApp(request);
  const shopper = await seedRoleSession(request, app.appId, "customer");
  await installReferenceEc(request, app);

  // `product` は `st_public` を持つ公開テーブル。**購入者に見せるには行の `st_public` が要る。**
  // `status` が `active` でないと「取り扱いをやめる」の `visible_when` に掛からない。
  await createAs(
    request,
    app.appId,
    "product",
    { name: "実測用の商品", price: 1200, stock: 5, status: "active", st_public: true },
    app.authHeaders,
  );

  const ownerContext = await browser.newContext();
  const shopperContext = await browser.newContext();
  try {
    await app.authenticate(ownerContext);
    await shopper.authenticate(shopperContext);

    const ownerPage = await ownerContext.newPage();
    await ownerPage.goto(viewUrl(app.appId, "catalog-list"));
    const ownerRow = ownerPage.getByTestId("list-row").first();
    await expect(ownerRow).toBeVisible();
    // **【`V8-M20` / `J-G29`。旧文を1バイトも消していない】** 旧文は
    // 「`audience: ["owner"]` の側だけが出る。」だった。**その宣言は撤去された。**
    // **今日この出し分けを決めているのは役割の規則(対象(ボタン)x 読取)である。**
    await expect(ownerRow.getByTestId("list-action-run-wf-product-archive")).toBeVisible();
    await expect(ownerRow.getByTestId("list-action-origin-cart-line-form")).toHaveCount(0);

    const shopperPage = await shopperContext.newPage();
    await shopperPage.goto(viewUrl(app.appId, "catalog-list"));
    const shopperRow = shopperPage.getByTestId("list-row").first();
    await expect(shopperRow).toBeVisible();
    // **【`V8-M20` / `J-G29`】旧文は「`audience: ["customer"]` の側だけが出る」だった。**
    // **今日は役割の規則が決めている。****owner と入れ替わっている。**
    await expect(shopperRow.getByTestId("list-action-origin-cart-line-form")).toBeVisible();
    await expect(shopperRow.getByTestId("list-action-run-wf-product-archive")).toHaveCount(0);
  } finally {
    await ownerContext.close();
    await shopperContext.close();
  }
});

test("(4) owner が商品一覧の行で「取り扱いをやめる」を押すと、その商品の status が archived になる", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  await installReferenceEc(request, app);

  const productId = await createAs(
    request,
    app.appId,
    "product",
    { name: "取り扱いをやめる商品", price: 800, stock: 3, status: "active", st_public: true },
    app.authHeaders,
  );

  await app.authenticate(page.context());
  await page.goto(viewUrl(app.appId, "catalog-list"));

  const row = page.getByTestId("list-row").first();
  await expect(row).toBeVisible();
  await row.getByTestId("list-action-run-wf-product-archive").click();

  // **押した後に API で確かめる。** 手動起動が `wf-product-archive` を実際に走らせている。
  // 起動は非同期に返るので、`expect.poll` で待つ(固定の待ち時間を置かない)。
  await expect
    .poll(
      async () => (await readAs(request, app.appId, "product", productId, app.authHeaders)).status,
      { message: "手動起動で product.status が archived になること" },
    )
    .toBe("archived");

  // **行の中にエラーが出ていない**(200 でもアクションが失敗していれば、ここに文言が出る)。
  await expect(page.getByTestId("list-action-run-error")).toHaveCount(0);
});
