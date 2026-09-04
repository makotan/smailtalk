/**
 * **カートから注文までを、本物のブラウザ(chromium)で1段ずつ確かめる**
 * (`V5-M26` / `L-G20` / `L-G21`。門A本審査 `v5-m20.md` §2-6 で**2件とも門外(記録)**)。
 *
 * ## `V5-M18` が足した `ref-ec-checkout.e2e.ts` との違い(**重ならない側だけを足す**)
 *
 * **`V5-M18` の4本は、自分で「確かめていないこと」を4件申告している**(同ファイル冒頭):
 * `cart_line` を1行も作っていない / 会計フォームを1度も送信していない /
 * 決済を1度も動かしていない / サーバが断るかを見ていない。
 * **本ファイルが埋めるのは、そのうち前2件と、`v5-m18.md` §12-2 が名指しした5点である。**
 *
 * | ここで測るもの | `CP-V5-LINK`(06 §8 の 6)のどれに当たるか |
 * |---|---|
 * | (C-1) 商品一覧 → カート明細 → 買い物かご一覧 → 会計 → 注文、を通しで押す | **(i) (ii) (iii)** |
 * | (C-2) 同じ URL を新しいタブで直接開く / 再読込する | **(iv) (v)** |
 * | (C-3) `visible_when` を満たさない行のボタンが消える | (i) の裏 |
 * | (C-4) 会計画面の「配送方法」欄が購入者にどう見えるか | —— (`v5-m18.md` §12-2 の 4) |
 * | (C-5) 一覧の `filter` が実際に効く | —— (同 5) |
 * | (C-6) 一覧の行き先に別テーブルの単票を書くと、押した先に何が出るか | —— (同 §12-3 の 1) |
 *
 * ## **この筋書きが、ブラウザだけでは始められないこと(先に書く)**
 *
 * **参照 EC には `cart` テーブルの入力画面(`form`)が1本も無い。**
 * **一覧画面に「新規作成」の口も無い**(`ListViewRenderer` が出すのは宣言された操作起点だけである)。
 * **したがって購入者は、買い物かごの行をブラウザから1件も作れない。**
 * **【2026-08-20 訂正(`V10-M3-T01` / `NV-G8b`)。旧文を1バイトも消していない】**
 * **上の括弧の中(「`ListViewRenderer` が出すのは宣言された操作起点だけである」)は今日は偽である**
 * —— **一覧画面は、同じテーブルの入力画面(`form`)が在り、それがその人に見え、書ける相手で、
 * その表が直接作成を止めていないときに、宣言されていない「新規作成」の口を自動で出す。**
 * **それでも結論(購入者が買い物かごの行をブラウザから1件も作れないこと)は今日も真である** ——
 * **参照 EC の `cart` テーブルには `form` が1本も無いので、この口は1つも出ないからである。**
 * **本ファイルは買い物かごを API で作ってから始める** —— **これは筋書きの省略ではなく、
 * 今日の参照 EC の宣言に穴が在るということである**(`docs/plan/v5/records/v5-m26.md` §5-2)。
 *
 * ## この E2E が測っていないこと(**誇張しない**)
 *
 * - **決済(`payment_events` / `wf-payment-received`)を1度も動かしていない。**
 * - **`payment_slip`(`file` 型)に1件もアップロードしていない。**
 * - **手動起動(`wf-cart-close` / `wf-product-archive`)を1度も押していない**
 *   —— それは `V5-M18` の (4) が既に押している。**重ねない。**
 * - **`data/apps/tokiwa`(実地インスタンス)を1バイトも触っていない。**
 */
import { type APIRequestContext, expect, test } from "@playwright/test";
import { referenceEcManifest } from "../../scripts/ref-ec/manifest.ts";
import type { ListView, Manifest } from "../../src/kernel/types.ts";
import { type FixtureApp, provisionApp, seedRoleSession } from "./fixture-app.ts";

/**
 * **落とすワークフロー。`ref-ec-checkout.e2e.ts` と同じ2本である。**
 *
 * **【重複を隠さない】** **同じ定数と同じ3つの補助関数が `ref-ec-checkout.e2e.ts` にも在る。**
 * **共有モジュールに切り出していない** —— **`v5-m20.md` §2-6 の歯止め1 が宣言した
 * 変更予定ファイルは「`web/e2e/` の新設1本」であり、2本目(共有モジュール)を足すと
 * 宣言より広い範囲を触ることになるからである。** **重複は4箇所(定数1 + 関数3)である。**
 */
const DROPPED_WORKFLOW_IDS: readonly string[] = ["wf-order-checkout", "wf-order-enrich"];

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

async function installReferenceEc(
  request: APIRequestContext,
  app: FixtureApp,
  transform: (next: Manifest) => Manifest = (next) => next,
): Promise<void> {
  const replaced = await request.post(`/__e2e__/apps/${app.appId}/manifest`, {
    data: transform(withReferenceEc(app.manifest)),
  });
  expect(replaced.status(), await replaced.text()).toBe(200);
}

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

const viewUrl = (appId: string, viewId: string): string => `/apps/${appId}/views/${viewId}`;

/** 参照 EC の一覧ビュー定義を1本取り出す(期待値をここに書き写さないため)。 */
function listViewOf(viewId: string): ListView {
  const view = referenceEcManifest().app.views.find((candidate) => candidate.id === viewId);
  if (view === undefined || view.type !== "list_view") {
    throw new Error(`参照 EC に一覧ビュー ${viewId} がありません。`);
  }
  return view;
}

/**
 * **渡されたマニフェストの中だけで、`tableId` を書き先とする操作起点の壁を外す。**
 *
 * **`V5-M28` / `ADR-0249`(`docs/adr/0249-view-action-audience-write-wall.md`)が、
 * 操作起点の `audience` を「その操作起点が書く表への書込の壁」としてサーバでも効かせた。**
 *
 * **【`V8-M20` / `J-G29`。旧文を1バイトも消していない】** **その `view_action.audience` は
 * 撤去された**(台帳 `J-G29` の判定 = 廃止。手続きは `ADR-0301`)。
 * **今日その壁を立てているのは役割の規則(`app.roles[].rules` の 対象(ボタン)x 読取)であり、
 * 壁の材料はボタンの識別子(`view_action.id`)である。**
 * **したがって外し方も変わった** —— **`audience` のキーを落とすのではなく、
 * そのボタンを名指ししている規則を役割の一覧から落とす。**
 * **識別子を持たないボタンは面から名指しできないので、壁が1本も立たない。**
 *
 * **外すのは、この E2E が組み立てたマニフェストの中の宣言だけである** ——
 * **`scripts/ref-ec/manifest.ts` を1バイトも書き換えていない。**
 */
function withoutWriteWallOn(manifest: Manifest, tableId: string): Manifest {
  const formTables = new Map<string, string>();
  for (const view of manifest.app.views) {
    if (view.type === "form") {
      formTables.set(view.id, view.table);
    }
  }
  // **その表を書き先とするボタンを (画面ID, ボタンID) で集める。**
  const walling = new Set<string>();
  for (const view of manifest.app.views) {
    if (view.type !== "list_view" && view.type !== "detail_view") {
      continue;
    }
    for (const action of view.actions ?? []) {
      const entry = action as { id?: unknown; form?: unknown };
      if (typeof entry.id !== "string" || typeof entry.form !== "string") {
        continue;
      }
      if (formTables.get(entry.form) === tableId) {
        walling.add(`${view.id}\u0000${entry.id}`);
      }
    }
  }
  // **そのボタンを名指ししている規則を、すべての役割から落とす。**
  // **1本も名指しが残らなければ、そのボタンは面の管轄外になり、壁が消える。**
  const roles = (manifest.app as { roles?: unknown[] }).roles;
  if (Array.isArray(roles)) {
    for (const role of roles) {
      const rules = (role as { rules?: unknown[] }).rules;
      if (!Array.isArray(rules)) {
        continue;
      }
      (role as { rules?: unknown[] }).rules = rules.filter((rule) => {
        const entry = rule as { target?: unknown; view?: unknown; action?: unknown };
        if (entry.target !== "action") {
          return true;
        }
        return !walling.has(`${String(entry.view)}\u0000${String(entry.action)}`);
      });
    }
  }
  return manifest;
}

/**
 * **(C-1) `L-G20`。商品一覧の行から注文が1件できるまでを、押して通す。**
 *
 * **押した回数(ホップ)を数える** —— 06 §4-6 の (a) は実地インスタンス(`tokiwa`)について
 * 「**今日カートから注文へ進むには2ホップが要る**(一覧の行 → カート要約の詳細 → ボタン)」と
 * 書いた。**参照 EC で同じことを測る。**
 */
test("(C-1) 商品一覧の行から押していくと、注文が1件できる(押した回数を数える)", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  const shopper = await seedRoleSession(request, app.appId, "customer");
  await installReferenceEc(request, app);

  const productId = await createAs(
    request,
    app.appId,
    "product",
    { name: "実測用の湯呑", price: 1800, stock: 7, status: "active", st_public: true },
    app.authHeaders,
  );
  // **買い物かごはブラウザから作れない**(冒頭 doc)。**API で作る。**
  const cartId = await createAs(
    request,
    app.appId,
    "cart",
    { status: "open", created_at: "2026-08-05" },
    shopper.authHeaders,
  );

  await shopper.authenticate(page.context());

  // --- ホップ1: 商品一覧の行の「買い物かごに入れる」-----------------------------
  await page.goto(viewUrl(app.appId, "catalog-list"));
  await expect(page.getByTestId("current-role")).toHaveAttribute("data-role", "customer");
  const productRow = page.getByTestId("list-row").first();
  await expect(productRow).toBeVisible();
  await productRow.getByTestId("list-action-origin-cart-line-form").click();

  // **`v5-m18.md` §12-2 の 1 が「測っていない」と名指しした側**(`?prefill.product=`)。
  await expect(page).toHaveURL(
    `${viewUrl(app.appId, "cart-line-form")}?prefill.product=${productId}`,
  );
  await expect(page.getByTestId("view-renderer-form")).toBeVisible();
  await expect(page.getByTestId("field-input-product")).toHaveValue(productId);

  // 買い物かごは自分で選ぶ(**プリフィルされるのは商品だけである**)。
  await page.getByTestId("field-input-cart").selectOption(cartId);
  await page.getByTestId("field-input-quantity").fill("2");
  await page.getByRole("button", { name: "保存" }).click();

  // 保存後は同じテーブルの先頭 `list_view`(`cart-line-list`)へ行く。
  await expect(page).toHaveURL(viewUrl(app.appId, "cart-line-list"));
  await expect(page.getByTestId("list-row")).toHaveCount(1);

  // --- ホップ2: 買い物かご一覧へ「移動する」------------------------------------
  // **【押すボタンが無い】** **カート明細の一覧から買い物かご一覧へ行く操作起点は
  // 参照 EC に1本も無い。** **URL を直接開いている** —— **これはホップとして数えない**
  // (押していないため)。
  await page.goto(viewUrl(app.appId, "cart-list"));
  const cartRow = page.getByTestId("list-row").first();
  await expect(cartRow).toBeVisible();
  await cartRow.getByTestId("list-action-origin-checkout-form").click();

  await expect(page).toHaveURL(`${viewUrl(app.appId, "checkout-form")}?prefill.cart=${cartId}`);
  await expect(page.getByTestId("field-input-cart")).toHaveValue(cartId);

  // --- ホップ3: 会計フォームを送信する(**`V5-M18` が1度もしていないこと**)-------
  await page.getByTestId("field-input-order_number").fill("M26-0001");
  await page.getByTestId("field-input-payment_method").selectOption("bank_transfer");
  await page.getByTestId("field-input-status").selectOption("pending_payment");
  await page.getByTestId("field-input-payment_status").selectOption("unpaid");
  await page.getByRole("button", { name: "保存" }).click();

  await expect(page).toHaveURL(viewUrl(app.appId, "order-list"));
  await expect(page.getByTestId("list-row")).toHaveCount(1);

  // **できた注文の中身を API で検算する**(画面の見え方と行の値を混ぜない)。
  const orders = await request.get(`/api/apps/${app.appId}/tables/order/records`, {
    headers: shopper.authHeaders,
  });
  expect(orders.status()).toBe(200);
  const body = (await orders.json()) as { records: Record<string, unknown>[] };
  expect(body.records).toHaveLength(1);
  expect(body.records[0]?.cart).toBe(cartId);
  expect(body.records[0]?.payment_method).toBe("bank_transfer");
  // **配送方法は入っていない** —— 購入者は選択肢を1件も引けない(C-4)。
  expect(body.records[0]?.shipping_method).toBe(null);
});

/**
 * **(C-2) `L-G21`。プリフィルを載せた URL を、押さずに開く / 再読込する。**
 *
 * **`CP-V5-LINK`(06 §8 の 6)の (iv) と (v) に1本ずつ当たる。**
 */
test("(C-2) prefill を載せた URL は、直接開いても再読込しても同じ画面・同じ値になる", async ({
  page,
  request,
  context,
}) => {
  const app = await provisionApp(request);
  const shopper = await seedRoleSession(request, app.appId, "customer");
  await installReferenceEc(request, app);
  const cartId = await createAs(
    request,
    app.appId,
    "cart",
    { status: "open", created_at: "2026-08-05" },
    shopper.authHeaders,
  );
  await shopper.authenticate(context);

  const target = `${viewUrl(app.appId, "checkout-form")}?prefill.cart=${cartId}`;

  // **(iv) 押さずに直接開く。** **押して着いた画面と同じであること。**
  await page.goto(target);
  await expect(page.getByTestId("view-renderer-form")).toBeVisible();
  await expect(page.getByTestId("field-label-cart")).toContainText("もとになった買い物かご");
  await expect(page.getByTestId("field-input-cart")).toHaveValue(cartId);

  // **(v) 再読込しても消えない。**
  await page.reload();
  await expect(page.getByTestId("view-renderer-form")).toBeVisible();
  await expect(page.getByTestId("field-input-cart")).toHaveValue(cartId);
  await expect(page).toHaveURL(target);

  // **別のタブ(同じ context = 同じログイン)で開いても同じである** —— 共有の実測。
  const another = await context.newPage();
  try {
    await another.goto(target);
    await expect(another.getByTestId("field-input-cart")).toHaveValue(cartId);
  } finally {
    await another.close();
  }
});

/**
 * **(C-3) `visible_when` を満たさない行のボタンが、実際に消える。**
 *
 * **`v5-m18.md` §12-2 の 3 の逐語**: 「**条件を満たさない行でボタンが消えることを1件も
 * 測っていない**」。**同じ画面の2行で測る**(別々の画面で測ると「行ごと」の証拠にならない)。
 */
test("(C-3) 同じ一覧の中で、visible_when を満たす行にだけボタンが出る", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  const shopper = await seedRoleSession(request, app.appId, "customer");
  await installReferenceEc(request, app);

  // **並び順を固定する** —— `cart-list` に `sort` の宣言は無いので、
  // **どちらの行がどちらかは行の中身で見分ける**(順序に期待しない)。
  await createAs(
    request,
    app.appId,
    "cart",
    { status: "open", created_at: "2026-08-01" },
    shopper.authHeaders,
  );
  await createAs(
    request,
    app.appId,
    "cart",
    { status: "converted", created_at: "2026-08-02" },
    shopper.authHeaders,
  );

  await shopper.authenticate(page.context());
  await page.goto(viewUrl(app.appId, "cart-list"));

  const rows = page.getByTestId("list-row");
  await expect(rows).toHaveCount(2);

  const openRow = rows.filter({ hasText: "2026-08-01" });
  const convertedRow = rows.filter({ hasText: "2026-08-02" });

  // **`status` が `open` の行**: 宣言した操作起点2本がどちらも出る。
  await expect(openRow.getByTestId("list-action-origin-checkout-form")).toHaveCount(1);
  await expect(openRow.getByTestId("list-action-run-wf-cart-close")).toHaveCount(1);

  // **`status` が `converted` の行**: **同じ画面の同じ列で、2本とも消えている。**
  await expect(convertedRow.getByTestId("list-action-origin-checkout-form")).toHaveCount(0);
  await expect(convertedRow.getByTestId("list-action-run-wf-cart-close")).toHaveCount(0);
});

/**
 * **(C-4) 会計画面の「配送方法」欄が、購入者にどう見えるか。**
 *
 * **`v5-m18.md` §12-2 の 4 の逐語**: 「**購入者は `shipping_method` を読めない(403)**ので、
 * **選択肢が空の欄が出るのか、エラーが出るのか、欄ごと消えるのかを1件も測っていない**
 * …… **ここは `V5-M26` の最重要の確認点である。**」
 *
 * **答えを先に書く**(下の assert が根拠である):
 * **欄は消えない。** **選択肢が空の `<select>` が出て、その真下にサーバの 403 の文面が出る。**
 * **`checkout-form` の3本の reference 欄は、3本とも違う見え方になる。**
 */
test("(C-4) 会計画面の3つの参照欄は、購入者にそれぞれ違う見え方をする", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  const shopper = await seedRoleSession(request, app.appId, "customer");
  await installReferenceEc(request, app);

  // **配送方法の行を運営が1件作っておく** —— それでも購入者には見えないことを測る。
  await createAs(
    request,
    app.appId,
    "shipping_method",
    { name: "宅配便", base_fee: 800 },
    app.authHeaders,
  );
  const cartId = await createAs(
    request,
    app.appId,
    "cart",
    { status: "open", created_at: "2026-08-05" },
    shopper.authHeaders,
  );

  await shopper.authenticate(page.context());
  await page.goto(`${viewUrl(app.appId, "checkout-form")}?prefill.cart=${cartId}`);
  await expect(page.getByTestId("view-renderer-form")).toBeVisible();

  // --- 1本目: `cart`(個人所有。自分の行が見える)-------------------------------
  await expect(page.getByTestId("field-input-cart")).toBeVisible();
  await expect(page.getByTestId("reference-error-cart")).toHaveCount(0);
  // 空の選択肢 + 自分の買い物かご1件。
  await expect(page.getByTestId("field-input-cart").locator("option")).toHaveCount(2);

  // --- 2本目: `customer`(個人所有。自分の行が0件)------------------------------
  await expect(page.getByTestId("field-input-customer")).toBeVisible();
  // **エラーは出ない。** **選択肢が空の欄が黙って出る** —— 読めるが1行も無いためである。
  await expect(page.getByTestId("reference-error-customer")).toHaveCount(0);
  await expect(page.getByTestId("field-input-customer").locator("option")).toHaveCount(1);

  // --- 3本目: `shipping_method`(公開でも個人所有でもない。403)------------------
  // **欄は消えない。** **選択肢は空の1件だけ**(未選択の `<option>`)。
  //
  // =====================================================================================
  // **【`V8-M27-T04` / `T-G5`。期待値を反転させた。旧の期待値を逐語で残す】**
  //
  // **旧(逐語)**:
  //   await expect(page.getByTestId("field-input-shipping_method").locator("option")).toHaveCount(1);
  //   const shippingError = page.getByTestId("reference-error-shipping_method");
  //   await expect(shippingError).toBeVisible();
  //   await expect(shippingError).toContainText("このテーブルの閲覧は許可されていません");
  // **上の2行の説明(「公開でも個人所有でもない。403」「選択肢は空の1件だけ」)も旧である。**
  //
  // **根拠**: **`V8-M27` / 台帳 `T-G5` / ユーザ決定 `D-V8-38`。**
  // **`nonAdminTableAccess` の層を撤去した** —— **参照EC の `customer` の規則には
  // `{ target: "table", table: "shipping_method", can: ["read"] }` が**着手前から**書いてある**
  // (`scripts/ref-ec/manifest.ts`)。**旧はその規則が層に負けており、届いていなかった。**
  // **今日は規則が効くので、運営が作った配送方法の行が購入者の選択肢に出る。**
  // **`forbiddenNonAdminReadError` の文面(「このテーブルの閲覧は許可されていません。」)も
  // 実装ごと消えたので、この欄にエラーは1つも出ない。**
  //
  // **【この反転は「壊れていたものが直った」側である。それでも誇張しない】** ——
  // **本物の EC では、購入者が配送方法を選べないほうが壊れている。**
  // **ただし本タスクの目的は層の撤去であって、参照EC を直すことではない。**
  // =====================================================================================
  await expect(page.getByTestId("field-label-shipping_method")).toContainText("配送方法");
  await expect(page.getByTestId("field-input-shipping_method")).toBeVisible();
  // 空の選択肢 + 運営が作った配送方法1件。
  await expect(page.getByTestId("field-input-shipping_method").locator("option")).toHaveCount(2);
  await expect(page.getByTestId("reference-error-shipping_method")).toHaveCount(0);
});

/**
 * **(C-5) 一覧の `filter` が実際に効く。**
 *
 * **`v5-m18.md` §12-2 の 5 の逐語**: 「**サーバに「この画面の一覧」という読取の入口は
 * 1本も無い** …… **`view.filter` / `view.sort` を読取の要求へ翻訳するのは表示層である。**」
 *
 * **`order-list` の `filter` は `status` が `pending_payment` か `paid` の行だけを出す。**
 * **4件作って2件だけ出ることを数える。**
 */
test("(C-5) 一覧の filter は、宣言に掛からない行を実際に落とす", async ({ page, request }) => {
  const app = await provisionApp(request);
  const shopper = await seedRoleSession(request, app.appId, "customer");
  await installReferenceEc(request, app);

  const statuses = ["pending_payment", "paid", "cancelled", "shipped"] as const;
  for (const [index, status] of statuses.entries()) {
    await createAs(
      request,
      app.appId,
      "order",
      { order_number: `M26-F-${index}`, status },
      shopper.authHeaders,
    );
  }

  // **API は4件返す**(サーバは `view.filter` を1バイトも見ない)。
  const all = await request.get(`/api/apps/${app.appId}/tables/order/records`, {
    headers: shopper.authHeaders,
  });
  expect(((await all.json()) as { records: unknown[] }).records).toHaveLength(4);

  await shopper.authenticate(page.context());
  await page.goto(viewUrl(app.appId, "order-list"));

  // **画面は2件だけ出す。** 期待値は宣言から導く(数を書き写さない)。
  await expect(page.getByTestId("list-row")).toHaveCount(2);
  await expect(page.getByTestId("list-row").filter({ hasText: "M26-F-2" })).toHaveCount(0);
  await expect(page.getByTestId("list-row").filter({ hasText: "M26-F-3" })).toHaveCount(0);
  // 宣言が今日も `status` の2値であることを、ビュー定義そのもので固定する。
  expect(JSON.stringify(listViewOf("order-list").filter)).toContain("pending_payment");
});

/**
 * **(C-6) 一覧の行き先に「別のテーブルの単票」を書くと、押した先に何が出るか。**
 *
 * **`v5-m18.md` §12-3 の 1 の逐語**: 「**`cart_line` の一覧から `product` の単票へ飛ばす
 * 宣言は valid になり、押すと必ず存在しない行を開く。**」——
 * **`v5-m18.md` は適用が通ることまでしか測っていない**(`checkout-journey.test.ts` の (D-1))。
 * **本テストは実際に押して、利用者に何が見えるかを測る。**
 *
 * ## **【`V5-M28-FIX1`(2026-08-06)で足した壁外しを、逐語で書く】**
 *
 * **今日、参照 EC の `cart_line` には「作成の壁」が立っている**(`V5-M28` / `ADR-0249`)——
 * **`catalog-list` の操作起点が `audience: ["customer"]` を宣言しており
 * (`scripts/ref-ec/manifest.ts:529-534`)、その操作起点の書き先が `cart-line-form`
 * (`table: "cart_line"`)だからである。**
 *
 * **【`V8-M20` / `J-G29`。旧文を1バイトも消していない】** **その `audience` の宣言は
 * 撤去された。** **今日この壁を立てているのは役割の規則(`app.roles[].rules` の
 * 対象(ボタン)x 読取)であり、`customer` だけがそのボタンを名指しされている。**
 * **壁が立っているという事実も、owner が 403 で落ちるという事実も、1ミリも変わっていない。** **この壁は仕様どおりの挙動である**
 * (ユーザ決定 `D-V5-89`「その表への書き込み自体を止める」)。
 * **本テストは owner のセッションで `cart_line` を1件作るので、壁を外さないと 403 で落ちる**
 * (実 CI run `31052243799` の `e2e` = **84 passed / 1 failed** の1本がこれである)。
 *
 * **本テストは壁を測る検査ではない。** **測っているのは「一覧の行き先に別テーブルの単票を
 * 書くと押した先に何が出るか」の1点だけである。** **したがって
 * `withoutWriteWallOn(next, "cart_line")` で壁を外した状態にしてから、主題だけを測る。**
 * **主題を1ミリも変えていない**(押す導線も、期待する URL も、期待する文言も、
 * `V5-M28` の前と1バイトも同じである)。
 *
 * **壁そのものを測っているのは、本ファイルではなく次の検査である**(重ねない):
 *
 * - **`scripts/ref-ec/checkout-journey.test.ts` の `(E-1)` 〜 `(E-7)`**
 *   —— 参照 EC の実物の宣言に対して、壁が誰を止め誰を通すかを測る。
 * - **`src/server/view-action-write-wall.test.ts`**
 *   —— 壁の導出・合成・射程(作成 / 更新 / `GET` / `DELETE`)をサーバ単体で測る。
 *
 * ## **【`V8-M26`(2026-08-11)で、行を作る主体を owner から customer へ変えた】**
 *
 * **上の「本テストは owner のセッションで `cart_line` を1件作る」は今日は偽である。**
 * **旧文を1バイトも消していない。**
 *
 * **切り分けの実測(2026-08-11)**: **落ちていたのは押した先の話ではなく、その手前の
 * `cart` の作成が 403 になっていたためである。** **応答の逐語**:
 * 「**表 "cart" に対する書き込みは、あなたの役割に許されていません。**」
 *
 * **原因は題材の側にある。実装の穴ではない。** **`V8-M26`(`6b8cf31`)が参照 EC の
 * `roles` を厚く書き、`customer` に `cart` / `cart_line` の読み書きを与えた一方で、
 * `owner` にはその2表の規則を1本も書かなかった**(同ファイルの逐語:
 * 「**本物の EC の運営は他人の買い物かごと住所を触らない**」)。
 * **面は「対象を名指しした規則が1本でもあれば allow-list」なので、
 * 名指しした時点で `owner` は閉め出される** —— **これは `V8-M26` より前からある規則であり、
 * `V8-M26` が作った挙動でもない。** **着手前は `cart` を名指しした規則が1本も無かったので、
 * 同じ経路が管轄外(全許可)で通っていた。**
 *
 * **したがって直したのは題材の側である** —— **`cart` / `cart_line` を作る主体を、
 * その2表を持つと題材が宣言している役割(`customer`)に変えた。**
 * **`scripts/ref-ec/manifest.ts` を1バイトも書き換えていない**(運営に買い物かごを
 * 開けてしまうと、題材が測っている当のものが壊れる)。
 * **主題は1ミリも変えていない** —— **押す導線も、期待する URL も、期待する文言も、
 * `V5-M28` の前と1バイトも同じである。**
 * **`product` を作るのは今日も owner である**(商品カタログは運営のものだからである)。
 */
test("(C-6) 一覧の行き先に別テーブルの単票を書くと、適用は通り、押すと「見つかりません」になる", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  // **買い物かご(`cart` / `cart_line`)を持つのは題材では `customer` である**(上の doc)。
  const shopper = await seedRoleSession(request, app.appId, "customer");
  await installReferenceEc(request, app, (next) => {
    const cartLineList = next.app.views.find((view) => view.id === "cart-line-list");
    if (cartLineList === undefined || cartLineList.type !== "list_view") {
      throw new Error("cart-line-list がありません。");
    }
    // **`cart_line` の一覧の行から `product` の単票へ飛ばす。**
    // **参照整合性の検査は「実在するか」と「一覧か単票か」しか見ない。**
    (cartLineList as ListView).actions = [{ view: "product-detail", name: "行き先を間違えた導線" }];
    // **`cart_line` の作成の壁(`V5-M28` / `ADR-0249`)を、このマニフェストからだけ外す。**
    // **理由は本テストの doc に逐語で書いた。壁を測っているのはここではない。**
    return withoutWriteWallOn(next, "cart_line");
  });

  const productId = await createAs(
    request,
    app.appId,
    "product",
    { name: "別のテーブルの行", price: 100, stock: 1, status: "active", st_public: true },
    app.authHeaders,
  );
  // **【`V8-M26`】旧は3件とも `app.authHeaders`(owner)で作っていた。**
  // **買い物かごの2表は題材が `customer` のものと宣言しているので、そちらで作る。**
  const cartId = await createAs(
    request,
    app.appId,
    "cart",
    { status: "open", created_at: "2026-08-05" },
    shopper.authHeaders,
  );
  const lineId = await createAs(
    request,
    app.appId,
    "cart_line",
    { cart: cartId, product: productId, quantity: 1 },
    shopper.authHeaders,
  );

  // **【`V8-M26`】旧: `await app.authenticate(page.context());`(owner で開いていた)。**
  // **作った本人で開く** —— **`cart_line` は `st_owner` を持つので、他人が開くと0行になる。**
  await shopper.authenticate(page.context());
  await page.goto(viewUrl(app.appId, "cart-line-list"));
  const row = page.getByTestId("list-row").first();
  await expect(row).toBeVisible();
  await row.getByTestId("list-action-link-product-detail").click();

  // **押した行の `_id`(`cart_line` の行)が、`product` の単票の URL に載る。**
  await expect(page).toHaveURL(`${viewUrl(app.appId, "product-detail")}/records/${lineId}`);
  // **`product` にその `_id` の行は無い。** **画面に出るのは空ではなく、エラーである。**
  // **`detail-fields`(項目の並び)は1つも描かれない。**
  const detail = page.getByTestId("view-renderer-detail_view");
  await expect(detail).toBeVisible();
  await expect(page.getByTestId("detail-fields")).toHaveCount(0);
  // **【出る文言は API の言葉のままである。丸めない】**
  // 逐語: 「テーブル "product" にレコード "<uuid>" は存在しません。
  //        一覧(GET .../records)で実在する _id を確認してください。」
  // **買い物をしている人に `GET .../records` を確認させる文が、そのまま画面に出る。**
  await expect(detail).toContainText('テーブル "product" にレコード');
  await expect(detail).toContainText("は存在しません");
  await expect(detail).toContainText("GET .../records");
});
