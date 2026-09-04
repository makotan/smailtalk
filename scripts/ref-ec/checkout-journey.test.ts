/**
 * **会計(支払い)の入力画面と、一覧の行だけで通す道順**(`V5-M18` / `G-G21` / `D-V5-86`)。
 *
 * ## なぜこのファイルが在るのか
 *
 * `D-V5-86`(ユーザ決定)の逐語は「**参照アプリに会計画面を足す**」である。着手前、
 * `scripts/ref-ec/` には**支払いを人が入力する画面が1本も無かった** —— `payment_events` は
 * 外から届く Webhook の受け皿であって、人の入口ではない。**`V5-M26`(実地確認)の台を
 * 用意するのが `V5-M18` の役目である**(`v5-m25.md` §11 の 5 が「台は本タスクが用意して
 * いない」と申告している)。
 *
 * ## このファイルが測るもの(**本物の HTTP を通す**)
 *
 * - (A) **宣言**: v5 が足した4つの形が、参照 EC のどこで実際に使われているか。
 * - (B) **道順**: 匿名で見る → 一般利用者で登録 → 買い物かご → 会計の入力 → 注文 →
 *   一覧に出る → 手動起動で支払い済みになる、を **`createServerApp` の HTTP 経路だけ**で通す。
 * - (C) **見せる相手**: 手動起動の入口が、宣言に載っていない相手をサーバでも断ること。
 * - (D) **今日の語彙で塞げていない穴**: 一覧の行き先が別テーブルの単票でも適用が通ること。
 *
 * ## このファイルが測っていないもの(**誇張しない**)
 *
 * - **ブラウザを1度も開いていない。** 通しているのは `app.request()` であり、
 *   ネットワークを1度も通っていない。**表示層がボタンを描くかどうかを1件も見ていない。**
 * - **`?prefill.<field>=` の URL を1本も組んでいない** —— それを組むのは表示層である。
 *   ここで測るのは「宣言が `prefill` を持っていること」までである。
 * - **`file` 型のアップロードを1度も行っていない**(`payment_slip` は宣言だけ確かめる)。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiCapabilityStore } from "../../src/kernel/ai-capability-store.ts";
import { applyManifest } from "../../src/kernel/apply-manifest.ts";
import { CapabilityStore } from "../../src/kernel/capability-store.ts";
import { createApp } from "../../src/kernel/create-app.ts";
import { ensureIslandRuntimeReady } from "../../src/kernel/island-runner.ts";
import { KernelMetaStore } from "../../src/kernel/meta-store.ts";
import { appDbPath } from "../../src/kernel/storage-paths.ts";
import type { DetailView, FormView, ListView, Manifest } from "../../src/kernel/types.ts";
import { createServerApp } from "../../src/server/app.ts";
import { OWNER_FIELD, PUBLIC_FIELD } from "../../src/server/owner-scope.ts";
import { seedSession, TEST_ORIGIN } from "../../src/server/test-helpers.ts";
import { REF_EC_APP_ID, referenceEcManifest } from "./manifest.ts";

const APP_ID = REF_EC_APP_ID;
const OUTBOUND_SECRET_ENV = "ST_REF_EC_OUTBOUND_SECRET";

let dataRoot: string;
let store: KernelMetaStore;
let app: ReturnType<typeof createServerApp>;
let manifest: Manifest;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-ref-ec-checkout-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "参照EC", { app_id: APP_ID });
  const installed = applyManifest(dataRoot, APP_ID, referenceEcManifest());
  if (!installed.valid) {
    throw new Error(`参照 EC マニフェストの投入に失敗: ${JSON.stringify(installed.errors)}`);
  }
  manifest = installed.manifest;
  issueCapabilities();
  await ensureIslandRuntimeReady();
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

/** 参照 EC のワークフローが要る capability を人間 owner の立場で発行する(manifest.test.ts と同じ作法)。 */
function issueCapabilities(): void {
  process.env[OUTBOUND_SECRET_ENV] = "ref-ec-outbound-bearer-secret";
  const cap = CapabilityStore.openForKernel(dataRoot);
  try {
    for (const name of ["mock-psp", "mail-gateway"]) {
      cap.createConnection({
        appId: APP_ID,
        name,
        allowedHosts: ["127.0.0.1"],
        secretSource: { kind: "env", value: OUTBOUND_SECRET_ENV },
      });
    }
  } finally {
    cap.close();
  }
  const ai = AiCapabilityStore.openForKernel(dataRoot);
  try {
    ai.createCapability({
      appId: APP_ID,
      name: "ai-copywriter",
      provider: "claude_cli",
      model: "claude-opus-4-8",
      limit: { maxCallsPerDay: 1000, maxCostUsdPerDay: 10 },
    });
  } finally {
    ai.close();
  }
}

// --- HTTP の薄いラッパ ---------------------------------------------------------

async function req(
  cookie: string | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { origin: TEST_ORIGIN };
  if (cookie !== undefined) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return app.request(new Request(`http://localhost${path}`, init));
}

const recordsPath = (table: string): string => `/api/apps/${APP_ID}/tables/${table}/records`;

/**
 * **サーバに「この画面の一覧」という読取の入口は1本も無い**(2026-08-05 実測)。
 *
 * `GET /api/apps/:app_id/views/:view_id/records` は**存在しない**(404)。実在するのは
 * `GET .../tables/:table_id/records` だけで、**`view.filter` / `view.sort` を読取の
 * 要求パラメータへ翻訳するのは表示層である**(`src/server/app.ts:2295` 前後の逐語
 * 「表示層は `view.sort` / `view.filter` を同じ読取パラメータへ投げる」)。
 *
 * **したがってこのファイルは「一覧に何行出るか」を測っていない** —— 測っているのは
 * **その画面の表に何行あるか**と、**その行が宣言した条件を満たす値を持っているか**である。
 * **`V5-M26`(実地確認)はここをブラウザで埋める必要がある。**
 */
const tableOfView = (viewId: string): string => viewOf(viewId).table;

/** 手動起動の入口(`ADR-0176`)。 */
const runPath = (viewId: string, workflow: string, record: string): string =>
  `/api/apps/${APP_ID}/views/${viewId}/actions/run?workflow=${workflow}&record=${record}`;

async function create(
  cookie: string,
  table: string,
  values: Record<string, unknown>,
): Promise<string> {
  const res = await req(cookie, "POST", recordsPath(table), values);
  expect(res.status, `${table}: ${await res.clone().text()}`).toBe(201);
  return ((await res.json()) as { record: { _id: string } }).record._id;
}

function rowsOf(table: string): Record<string, unknown>[] {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readonly: true });
  try {
    return db.query(`SELECT * FROM ${JSON.stringify(table)} ORDER BY rowid`).all() as Record<
      string,
      unknown
    >[];
  } finally {
    db.close();
  }
}

function viewOf(id: string): ListView | DetailView | FormView {
  const found = manifest.app.views.find((v) => v.id === id);
  if (found === undefined) throw new Error(`ビュー "${id}" が無い`);
  // **【2026-08-14。`V8-M8`。台帳 `Q-G1`】画面種別に4種目(`report_view` = 集計表)が
  // 加わったので、`View` はこの戻り値の3種に**そのままでは**代入できなくなった。**
  // **戻り値の型を広げるのではなく、集計表を投げて落とす1行を足した** ——
  // **この参照ECアプリに集計表は1枚も無く、以下の検査はどれも3種の形を前提にしている。**
  // **黙って通すと「型では3種のはずが実際は4種目が来る」状態になる。**
  if (found.type === "report_view") {
    throw new Error(`ビュー "${id}" は集計表(report_view)である。この検査は3種だけを見る`);
  }
  return found;
}

// ===========================================================================
// (A) 宣言 —— v5 が足した4つの形が、実際にどこで使われているか
// ===========================================================================

describe("(A) v5 が足した形の当て先(宣言で測る)", () => {
  test("(A-1) 会計(支払い)の入力画面が1本在る —— 着手前は0本だった", () => {
    const checkout = viewOf("checkout-form");
    expect(checkout.type).toBe("form");
    expect(checkout.table).toBe("order");
    // **支払い方法と控えを人が入れる。** これが「会計の入力画面」の実体である。
    expect((checkout as FormView).fields).toContain("payment_method");
    expect((checkout as FormView).fields).toContain("payment_slip");
    // **状態列まで人に選ばせている**(既定値を宣言する語彙が無いため)。隠さない。
    expect((checkout as FormView).fields).toContain("status");
    expect((checkout as FormView).fields).toContain("payment_status");
  });

  test("(A-2) `V5-M21`: 一覧の行の操作起点が3画面に在る(着手前は0画面)", () => {
    const withActions = manifest.app.views.filter(
      (v) => v.type === "list_view" && Array.isArray((v as ListView).actions),
    );
    expect(withActions.map((v) => v.id).sort()).toEqual([
      "cart-list",
      "catalog-list",
      "order-list",
    ]);
  });

  test("(A-3) `V5-M24`: プリフィルを持つ操作起点が一覧に2本在る", () => {
    const prefills = manifest.app.views
      .filter((v) => v.type === "list_view")
      .flatMap((v) => (v as ListView).actions ?? [])
      .filter((a) => "prefill" in a);
    expect(prefills).toHaveLength(2);
    // **プリフィル先は「遷移先 form の対象テーブル上の reference で、参照先がこの画面の表」**
    // という `ADR-0045` 限定2 を満たしていることは、`applyManifest` が valid を返したことで
    // 既に機械的に担保されている(不整合なら beforeEach が投げる)。
    expect(prefills.map((a) => ("prefill" in a ? a.prefill?.field : undefined)).sort()).toEqual([
      "cart",
      "product",
    ]);
  });

  test("(A-4) `V5-M22`: 行き先の宣言が1本在り、規約が選ぶ画面とは違う", () => {
    const orderList = viewOf("order-list") as ListView;
    const link = (orderList.actions ?? []).find((a) => "view" in a);
    expect(link).toBeDefined();
    expect(link && "view" in link ? link.view : undefined).toBe("order-receipt");
    // **規約(同テーブルの先頭 detail_view)が選ぶのは `order-detail` である** ——
    // 宣言が無ければ会計の控えには行けない。この2本の順序が意味を持つ。
    const orderDetails = manifest.app.views
      .filter((v) => v.type === "detail_view" && v.table === "order")
      .map((v) => v.id);
    expect(orderDetails).toEqual(["order-detail", "order-receipt"]);
  });

  test("(A-5) `V5-M25`: `manual` のワークフローが2本在り、外部送信を1つも含まない", () => {
    const manual = (manifest.app.workflows ?? []).filter((w) => w.trigger.type === "manual");
    expect(manual.map((w) => w.id)).toEqual(["wf-cart-close", "wf-product-archive"]);
    expect(manual.map((w) => w.trigger.table)).toEqual(["cart", "product"]);
    // **`call_external` / `ai_transform` / capability 付き `run_function` は入れられない**
    // (`ADR-0174` 限定5)。ここは「入れていない」ことの確認であって、限定の再実装ではない。
    expect(manual.flatMap((w) => w.actions.map((a) => a.action))).toEqual([
      "update_record",
      "update_record",
    ]);
  });

  // **【`V8-M20` / 台帳 `J-G29` / `ADR-0301`】検査は消していない。当て先を面へ移した。**
  // **旧テスト名の逐語**: 「(A-6) `V5-M23`: 見せる相手の宣言が4本在る(`customer` 3本 / `owner` 1本)」。
  // **旧本体の逐語**:
  //   const audiences = manifest.app.views
  //     .flatMap((v) => ("actions" in v ? ((v.actions ?? []) as { audience?: string[] }[]) : []))
  //     .flatMap((a) => a.audience ?? []);
  //   expect(audiences.sort()).toEqual(["customer", "customer", "customer", "owner"]);
  // **問いの形は1ミリも変えていない**(「ボタンを誰に出すかの宣言が4本在り、内訳は
  // `customer` 3本 / `owner` 1本である」)。**読む場所だけが `view_action.audience` から
  // `app.roles[].rules` の `target: "action"` へ移った。**
  test("(A-6) `V5-M23`: ボタンを名指しした面の規則が4本在る(`customer` 3本 / `owner` 1本)", () => {
    const actionRules = (manifest.app.roles ?? []).flatMap((role) =>
      (role.rules ?? []).filter((rule) => rule.target === "action").map(() => role.id),
    );
    expect(actionRules.sort()).toEqual(["customer", "customer", "customer", "owner"]);
    // **どのボタンを名指ししているかも逐語で固定する**(旧は `audience` の値しか見ていなかった
    // ので、ここは**足した側**である —— 面は `(画面, ボタン)` の2つで名指しするからである)。
    expect(
      (manifest.app.roles ?? [])
        .flatMap((role) => role.rules ?? [])
        .filter((rule) => rule.target === "action")
        .map((rule) => `${rule.view}/${rule.action}`)
        .sort(),
    ).toEqual([
      "cart-list/checkout",
      "cart-list/close-cart",
      "catalog-list/add-to-cart",
      "catalog-list/archive-product",
    ]);
  });

  test("(A-7) `V5-M16`: `file` 型のフィールドが1本在る(着手前は0本)", () => {
    const order = manifest.app.tables.find((t) => t.id === "order");
    const files = (order?.fields ?? []).filter((f) => f.type === "file");
    expect(files.map((f) => f.id)).toEqual(["payment_slip"]);
  });

  test("(A-8) 【使わなかったもの】`user_kinds` を1つも宣言していない", () => {
    // **差分操作が実在せず、`App` 型にも無いためである**(記録 `v5-m18.md` §5)。
    // **「使わなかった」ことを機械的に固定する** —— 後から黙って足されたら、この検査が落ちる。
    expect((manifest.app as { user_kinds?: unknown }).user_kinds).toBeUndefined();
  });
});

// ===========================================================================
// (B) 道順 —— 本物の HTTP で、買い物かごから注文まで
// ===========================================================================

describe("(B) 買い物かごから注文まで(本物の HTTP)", () => {
  test("(B-1) 匿名 → 一般利用者 → 買い物かご → 会計の入力 → 注文一覧 → 手動起動で支払い済み", async () => {
    const owner = seedSession(dataRoot, APP_ID, { role: "owner" });

    // --- 運営が売るものを置く ---------------------------------------------
    const categoryId = await create(owner.cookie, "category", {
      name: "調味料",
      slug: "cat-1",
      [PUBLIC_FIELD]: true,
    });
    const productId = await create(owner.cookie, "product", {
      name: "藻塩 150g",
      sku: "SKU-0001",
      price: 1200,
      category: categoryId,
      stock: 40,
      status: "active",
      [PUBLIC_FIELD]: true,
    });
    await create(owner.cookie, "shipping_method", {
      name: "宅配便",
      base_fee: 500,
      free_over: 5000,
    });

    // --- (0) 匿名で商品一覧が見える(`st_public`)---------------------------
    const anon = await req(undefined, "GET", `${recordsPath("product")}`);
    expect(anon.status).toBe(200);
    expect(((await anon.json()) as { records: unknown[] }).records).toHaveLength(1);

    // --- (1) 一般利用者(`customer`)で入る --------------------------------
    const buyer = seedSession(dataRoot, APP_ID, { role: "customer" });
    const customerId = await create(buyer.cookie, "customer", {
      name: "見本 太郎",
      email: "taro@example.test",
    });

    // --- (2) 買い物かごに入れる(catalog-list の行の操作起点が開く form の中身)---
    const cartId = await create(buyer.cookie, "cart", {
      customer: customerId,
      status: "open",
      created_at: "2026-08-05",
    });
    await create(buyer.cookie, "cart_line", {
      cart: cartId,
      product: productId,
      quantity: 2,
      unit_price: 1200,
    });
    // 島(`fn-line-total`)が Route B で行内金額を書き戻している。
    expect(rowsOf("cart_line")[0]?.line_total).toBe(2400);

    // --- (3) 買い物かご一覧に、会計へ進める行が出る -------------------------
    const cartList = await req(buyer.cookie, "GET", recordsPath(tableOfView("cart-list")));
    expect(cartList.status).toBe(200);
    const cartRows = ((await cartList.json()) as { records: { _id: string; status: string }[] })
      .records;
    expect(cartRows).toHaveLength(1);
    // `visible_when`(`status` が `open`)を満たす行である。**判定するのは表示層だが、
    // 判定材料がサーバから返っていることをここで固定する。**
    expect(cartRows[0]?.status).toBe("open");
    expect(cartRows[0]?._id).toBe(cartId);

    // --- (4) 会計(支払い)の入力画面が書く先へ、その画面の項目だけを POST する ---
    // **`checkout-form` の `fields` に載っている9項目だけを送る。**
    // これが「会計画面から注文を作る」の実体である(表示層は同じ body を組む)。
    const checkoutFields = (viewOf("checkout-form") as FormView).fields;
    const checkoutBody: Record<string, unknown> = {
      cart: cartId, // ← `?prefill.cart=` が入れる値
      customer: customerId,
      order_number: "ORD-9001",
      shipping_method: rowsOf("shipping_method")[0]?._id,
      payment_method: "bank_transfer",
      payment_slip: null,
      currency: "JPY",
      status: "pending_payment",
      payment_status: "unpaid",
    };
    expect(Object.keys(checkoutBody).sort()).toEqual([...checkoutFields].sort());
    const orderId = await create(buyer.cookie, "order", checkoutBody);

    // 会計画面が作った注文は、押した買い物かごを指している。
    const order = rowsOf("order")[0];
    expect(order?.cart).toBe(cartId);
    expect(order?.payment_method).toBe("bank_transfer");
    expect(order?.[OWNER_FIELD]).toBe(buyer.userId);

    // --- (5) 運営が注文を読める(面の読取の規則が在るのは `order` だけ)-----
    // **旧の逐語**: 「(5) 運営が注文を読める(`st_admin_readable` の宣言があるのは
    // `order` だけ)」(`V8-M20` / `J-G30` / `D-V8-35`)。
    const admin = seedSession(dataRoot, APP_ID, { role: "owner" });
    const orderList = await req(admin.cookie, "GET", recordsPath(tableOfView("order-list")));
    expect(orderList.status).toBe(200);
    const orderRows = (
      (await orderList.json()) as {
        records: { _id: string; status: string; payment_status: string }[];
      }
    ).records;
    expect(orderRows.map((r) => r._id)).toEqual([orderId]);
    // `order-list` の `filter`(`status` が `pending_payment` か `paid`)を満たす値である。
    // **翻訳して投げるのは表示層なので、ここでは値だけを見る。**
    expect(orderRows[0]?.status).toBe("pending_payment");
    // `visible_when`(`payment_status` が `unpaid`)を満たす。
    expect(orderRows[0]?.payment_status).toBe("unpaid");

    // --- (6) 買い物かご一覧の行のボタンから手動起動する(購入者が自分の行に対して)---
    const run = await req(buyer.cookie, "POST", runPath("cart-list", "wf-cart-close", cartId));
    expect(run.status, await run.clone().text()).toBe(200);
    expect(await run.json()).toEqual({
      workflow: "wf-cart-close",
      record: cartId,
      failures: [],
    });

    // --- (7) 買い物かごが締まった ------------------------------------------
    expect(rowsOf("cart")[0]?.status).toBe("converted");

    // 履歴に手動の1行が残る(**押した人の列は今日も無い**。`L-G11b` = 保留)。
    const manualRuns = rowsOf("wf_runs").filter((r) => r.trigger_type === "manual");
    expect(manualRuns).toHaveLength(1);
    expect(manualRuns[0]?.workflow).toBe("wf-cart-close");
    expect(manualRuns[0]?.status).toBe("success");
    expect(Object.keys(manualRuns[0] ?? {})).not.toContain("actor");

    // **押した人は監査記録(`_auth_activity`)の側にだけ残る**(`D-V5-83`)。
    const activity = await req(admin.cookie, "GET", `/api/apps/${APP_ID}/auth/activity`);
    expect(activity.status).toBe(200);
    const audit = (await activity.json()) as { activity?: { action: string; userId: string }[] };
    const manualEntries = (audit.activity ?? []).filter((e) => e.action === "manual_run");
    expect(manualEntries).toHaveLength(1);
    expect(manualEntries[0]?.userId).toBe(buyer.userId);
  });

  test("(B-2) 2回目の手動起動は `when` に落ちて、行を1ミリも動かさない", async () => {
    const buyer = seedSession(dataRoot, APP_ID, { role: "customer" });
    const cartId = await create(buyer.cookie, "cart", { status: "open", created_at: "2026-08-05" });
    await req(buyer.cookie, "POST", runPath("cart-list", "wf-cart-close", cartId));
    const first = rowsOf("cart")[0];
    expect(first?.status).toBe("converted");
    const updatedAt = first?._updated_at;

    // **もう一度押せる**(`visible_when` はボタンを隠すだけで、入口は今日も開いている)。
    const second = await req(buyer.cookie, "POST", runPath("cart-list", "wf-cart-close", cartId));
    expect(second.status).toBe(200);
    // **落としているのはサーバ側の `when` である** —— 行は1ミリも動いていない。
    const after = rowsOf("cart")[0];
    expect(after?._updated_at).toBe(updatedAt);
    // **走った回数は2回である**(冪等ではない。`ADR-0174`)。
    expect(rowsOf("wf_runs").filter((r) => r.trigger_type === "manual")).toHaveLength(2);
  });

  test("(B-3) 運営は個人所有でない表(`product`)になら手動起動を押せる", async () => {
    const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
    const productId = await create(owner.cookie, "product", {
      name: "藻塩 150g",
      sku: "SKU-A",
      price: 1200,
      stock: 3,
      status: "active",
    });
    const res = await req(
      owner.cookie,
      "POST",
      runPath("catalog-list", "wf-product-archive", productId),
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect(rowsOf("product")[0]?.status).toBe("archived");
  });
});

// ===========================================================================
// (C) 見せる相手 —— 起動の経路はサーバでも断る
//
// **【`V8-M20` / 台帳 `J-G29` / `ADR-0301`】この群は1本も消していない。**
// **止めているものが `view_action.audience` から面のボタンの規則
// (`app.roles[].rules` の `target: "action"` x `read`)へ移っただけである** ——
// **手動起動の入口(`app.ts` の `judgeRoleAccess(target: "action")`)が 403 を返す。**
// **`describe` の見出しの逐語も旧のまま残す**(下の1行)。
// ===========================================================================

describe("(C) 見せる相手の宣言(旧 `audience`。今日は面のボタンの規則)", () => {
  test("(C-1) `owner` にだけ出す宣言の操作起点は、一般利用者が直接叩いても 403", async () => {
    const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
    const productId = await create(owner.cookie, "product", {
      name: "藻塩 150g",
      sku: "SKU-B",
      price: 1200,
      stock: 3,
      status: "active",
      [PUBLIC_FIELD]: true,
    });
    const buyer = seedSession(dataRoot, APP_ID, { role: "customer" });
    const res = await req(
      buyer.cookie,
      "POST",
      runPath("catalog-list", "wf-product-archive", productId),
    );
    expect(res.status, await res.clone().text()).toBe(403);
    // **1ミリも走っていない。**
    expect(rowsOf("product")[0]?.status).toBe("active");
  });

  test("(C-2) `customer` にだけ出す宣言の操作起点は、運営が直接叩いても 403", async () => {
    const buyer = seedSession(dataRoot, APP_ID, { role: "customer" });
    const cartId = await create(buyer.cookie, "cart", { status: "open" });
    const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
    const res = await req(owner.cookie, "POST", runPath("cart-list", "wf-cart-close", cartId));
    expect(res.status, await res.clone().text()).toBe(403);
    expect(rowsOf("cart")[0]?.status).toBe("open");
  });

  test("(C-3) 未ログインは 401(匿名からは1本も通さない)", async () => {
    const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
    const productId = await create(owner.cookie, "product", {
      name: "藻塩 150g",
      sku: "SKU-C",
      price: 1200,
      stock: 3,
      status: "active",
      [PUBLIC_FIELD]: true,
    });
    const res = await req(
      undefined,
      "POST",
      runPath("catalog-list", "wf-product-archive", productId),
    );
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// (D) 今日の語彙で塞げていない穴 —— **見つけたので書く**
// ===========================================================================

describe("(D) 行き先の宣言が塞げていないもの(`V5-M26` への申し送り)", () => {
  test("(D-1) 別テーブルの単票を行き先にしても適用は通る —— 押すと必ず空の行を開く", () => {
    // **`referential-integrity.ts` が見るのは「実在するか」と「型が一覧か単票か」の2つだけで、
    // **押した行の `_id` がその単票の表の行として通用するかを1件も見ていない**
    // (`ADR-0173` §Decision 3 の逐語「行き先が detail_view のときは、押した行の _id を運ぶ」)。
    // **したがって `cart_line` の一覧から `product` の単票へ飛ばす宣言は valid になり、
    // 押すと必ず存在しない行を開く。** 参照 EC にはこの形を1本も置いていない。
    const broken = referenceEcManifest();
    const cartLineList = broken.app.views.find((v) => v.id === "cart-line-list") as ListView;
    cartLineList.actions = [{ view: "product-detail", name: "商品を見る" }];
    const probe = KernelMetaStore.open(dataRoot);
    probe.close();
    const applied = applyManifest(dataRoot, APP_ID, broken);
    // **valid である。これが穴である。**
    expect(applied.valid).toBe(true);
  });

  test("(D-2) 運営可視の宣言は手動起動の入口に1件も効かない —— 運営は購入者の注文に押せない", async () => {
    // **【`V8-M20` / 台帳 `J-G30` / ユーザ決定 `D-V8-35`】検査は消していない。根拠を移した。**
    // **旧の逐語**: 「**`order` には `st_admin_readable` が宣言してあるので、運営は購入者の
    // 注文を**読める**。**しかし手動起動の入口は `isOwnerVisible(row[st_owner], actor.id)` を
    // 第3引数(`adminReadable`)なしで呼ぶので、宣言を1件も見ない**」。**旧の作成本文には
    // `st_admin_readable: true` が入っていた**(今日はその項目が `order` に存在しないので 400)。
    //
    // **今日: `order` には面の規則(`owner` x 表 x 読取)が在るので、運営は購入者の注文を
    // **読める**。** **しかし手動起動の入口は `isOwnerVisible(row[st_owner], actor.id)` を
    // 呼ぶだけで `roleReadCrossesOwnerScope` を1度も呼ばない** ——
    // **したがって同じ行に対して「読めるが押せない」という非対称が今日もある。**
    // **`V5-M18` はこの実測を根拠に、運営向けの手動起動を `order-list` に置かなかった。**
    const buyer = seedSession(dataRoot, APP_ID, { role: "customer" });
    const orderId = await create(buyer.cookie, "order", {
      order_number: "ORD-9101",
      status: "pending_payment",
      payment_status: "unpaid",
    });
    const owner = seedSession(dataRoot, APP_ID, { role: "owner" });

    // (1) 読める。
    const read = await req(owner.cookie, "GET", `${recordsPath("order")}/${orderId}`);
    expect(read.status).toBe(200);

    // (2) 同じ行を対象にした手動起動は 404 になる —— **`order` に `manual` の
    // ワークフローが在ったとしても**である。ここでは表が違うワークフローを指して
    // 400 と区別できないので、**`cart` の manual を `cart-list` から他人の行に対して**
    // 押して同じ判定に当てる(判定は表に依らない1本である)。
    const otherCartId = await create(buyer.cookie, "cart", { status: "open" });
    const run = await req(owner.cookie, "POST", runPath("cart-list", "wf-cart-close", otherCartId));
    // **面のボタンの規則の 403 が先に立つ**(`cart-list/close-cart` を `read` できるのは
    // `customer` だけである)。**旧の逐語**: 「**`audience` の 403 が先に立つ**
    // (`cart-list` の宣言は `customer` だけ)」。
    expect(run.status).toBe(403);

    // (3) **面から名指しできない同型の宣言**でも、他人の行なら 404 になることを直接測る。
    // **旧の逐語**: 「`audience` を外した同型の宣言でも」。**今日は識別子(`id`)を書かない
    // 起点がそれに当たる** —— 面の規則は `(画面, ボタン)` で名指しするので、`id` の無い起点は
    // 管轄外(全許可)になる(`app.ts` の逐語「識別子を書いていない操作起点は面から名指し
    // できないので、ここでは管轄外(全許可)になる」)。
    const opened = referenceEcManifest();
    const cartList = opened.app.views.find((v) => v.id === "cart-list") as ListView;
    cartList.actions = [{ run: "wf-cart-close", name: "締める" }];
    // **【実測してここで踏んだ。隠さない】** **面の規則が名指ししているボタンを消すと、
    // マニフェストがそのまま invalid になる**(`referential-integrity.ts` が
    // 「規則が指すボタンが実在するか」を適用時に検査している)。**旧層(`audience`)は
    // 起点の中に書かれていたので、起点を差し替えれば宣言も一緒に消えた** ——
    // **面では宣言が別の場所に在るので、両方を直さないと適用が通らない。**
    // **`rules: []` は書けない**(スキーマの `minItems: 1`。「0本書く」と「書かない」の
    // 2通りを作らないため)——**空になったらキーごと落とす。これも実測で踏んだ。**
    // **【2026-08-10(`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-58`)。この段で1本足した。
    // 期待値(404)は1バイトも動かしていない】**
    //
    // **既定が「閉じる」側へ倒れたので、画面 `cart-list` を `read` できない運営は、
    // ボタンの規則より手前(`app.ts` の「名乗られた画面の検査」)で 403 になる** ——
    // **そのままだと、この段が測りたい 404(他人の行だから伏せる)まで到達しない。**
    // **測る対象を変えないために、この差し替え版だけ運営に `cart-list` の閲覧を開ける。**
    // **参照 EC の本体(`manifest.ts`)には1バイトも足していない** ——
    // **本物の EC の運営は他人の買い物かご画面を開かないからである。**
    opened.app.roles = (opened.app.roles ?? []).map((role) => {
      const kept = (role.rules ?? []).filter(
        (rule) => !(rule.target === "action" && rule.view === "cart-list"),
      );
      const opens =
        role.id === "owner"
          ? [...kept, { target: "view" as const, view: "cart-list", can: ["read" as const] }]
          : kept;
      const { rules: _dropped, ...rest } = role;
      return opens.length === 0 ? rest : { ...rest, rules: opens };
    });
    expect(applyManifest(dataRoot, APP_ID, opened).valid).toBe(true);
    const reopened = createServerApp({ dataRoot });
    const res = await reopened.request(
      new Request(`http://localhost${runPath("cart-list", "wf-cart-close", otherCartId)}`, {
        method: "POST",
        headers: { origin: TEST_ORIGIN, cookie: owner.cookie },
      }),
    );
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// (E) 書込の壁 —— **参照EC の実データで、`audience` の宣言が書込を止めることを測る**
//     (`V5-M28-T05`。`A-G1` / [`ADR-0249`](../../docs/adr/0249-view-action-audience-write-wall.md))
//
// **既存16テスト((A)〜(D))を1バイトも書き換えていない。末尾に足しただけである。**
// **`scripts/ref-ec/manifest.ts` を1バイトも書き換えていない。**
//
// ## この群が測るもの
//
// **【`V8-M20` / 台帳 `J-G29` / `ADR-0301`。この群は1本も消していない。壁の材料が移った】**
//
// **旧の逐語**:
//
// > **表 `T` を書き先とする操作起点のうち `audience` を宣言しているものが1つ以上あるとき、
// > `T` への当該種類の書込は、その和集合に挙がっている相手だけに許す**(`ADR-0249` §Decision 1)。
// > 参照EC でその材料になっている宣言は**2本**である:
// >
// > | 宣言の場所 | 形 | 書き先の表 | 種類 | `audience` |
// > |---|---|---|---|---|
// > | `manifest.ts:529-534`(`catalog-list` の「買い物かごに入れる」) | `form` + `prefill` | **`cart_line`** | 作成 | `["customer"]` |
// > | `manifest.ts:628-634`(`cart-list` の「会計に進む」) | `form` + `prefill` | **`order`** | 作成 | `["customer"]` |
//
// **今日**: **表 `T` を書き先とする操作起点のうち、面の規則(`app.roles[].rules` の
// `target: "action"`)が名指ししているものが1つ以上あるとき、`T` への当該種類の書込は、
// その起点を `read` できる役割にだけ許す**(`isRoleActionWriteAllowed`)。
// 参照EC でその材料になっている規則は**2本**である:
//
// | 名指しした規則 | 起点の形 | 書き先の表 | 種類 | 許される役割 |
// |---|---|---|---|---|
// | `catalog-list/add-to-cart`(「買い物かごに入れる」) | `form` + `prefill` | **`cart_line`** | 作成 | `customer` |
// | `cart-list/checkout`(「会計に進む」) | `form` + `prefill` | **`order`** | 作成 | `customer` |
//
// **`run` 形2本(`catalog-list/archive-product` / `cart-list/close-cart`)は壁を1本も
// 立てない**(書き先を持たない。`ADR-0249` §Decision 1 の形 (iv))。
// **`order-list` の `view` 形も立てない**(形 (iii))。
// **識別子(`id`)を書いていない起点(`product-detail` / `order-detail`)は面から名指し
// できないので、壁の材料にならない** —— **旧層はここが違った(`id` が無くても効いた)。**
//
// ## **この群が測っていないもの(誇張しない)**
//
// - **サーバは「どのボタンを押したか」を1バイトも受け取っていない。** 要求に載るのは
//   **表 × 種類 × 名乗ったロール**だけである(`ADR-0249` 限定7)。**したがって
//   「商品一覧のボタン経由」と「商品詳細のボタン経由」を、この群は区別して測れない** ——
//   測っているのは**同じ表への同じ種類の書込が、経路によらず同じ応答になること**である。
// - **ブラウザを1枚も開いていない。** 通しているのは `app.request()` である。
// - **止めない経路(受信口 / MCP / ワークフロー / コードの島)を1件も測っていない**
//   (`V5-M28-T06`)。**`DELETE` は (E-6) が測るが、参照EC では壁の外の相手に届く前に
//   個人スコープの 404 が立つ** —— **(E-6) の中に実測を書いた。**
// - **更新の壁を1件も測っていない** —— **参照EC に `set` 形の操作起点が1本も無いためである**
//   ((E-7) がその本数を数える)。
// ===========================================================================

/**
 * 壁の 403 かどうかを、応答本文の目印で見分ける。
 *
 * **【`V8-M20` / `J-G29`】目印を差し替えた。** **旧の逐語**:
 * `return (await res.clone().text()).includes("view_action.audience");`
 * (壁の 403 は `view_action.audience` を名指しする文面を返していた)。
 *
 * **今日の壁は面が返す** —— **文面は `forbiddenRoleAccessError`(`app.ts`)の
 * 「表 "<表ID>" に対する作成は、あなたの役割に許されていません。」である。**
 *
 * **【この目印が区別できるもの・できないもの。誇張しない】**
 * - **区別できる**: 項目単位の書込制御(文面が `項目 "…"` で始まる)/ 直接作成の遮断
 *   (`st_no_direct_create` の別の文面)/ 個人スコープの 404。
 * - **区別できない**: **同じ表を(表 x 書込)の規則で止めた面の 403** —— **文面が同一である。**
 *   **参照EC では表の規則が `order` の書込を運営に許しているので、この2つが同時に立つ表は
 *   1つも無い**(そうでなければ (E-7) の数え方は成り立たない)。
 *
 * **【`V8-M39` / 台帳 `F-G7` / `F-G8` で目印を差し替えた。旧の逐語を1バイトも消していない】**
 *
 *     return /表 \\"[a-z0-9_]+\\" に対する(作成|更新)は、あなたの役割に許されていません。/.test(text);
 *
 * **2つ変わった** —— **(1) `F-G7` が「表 "…"」を「表 "…" のボタン」に直した**
 * (**止めていたのはボタンの規則であって表の面ではない**。`v8-m33.md` §12 の `D-8`)/
 * **(2) `F-G8` が文末に `(止めた層: role)` を足した。**
 * **【この差し替えで、上の「区別できない」が1つ減った】** —— **今日は「表 "…" のボタン」と
 * 「表 "…"」で綴りが違うので、壁(ボタンの規則)と表の規則は文面で見分けられる。**
 * **それでも下の `isTableRoleForbidden` を消していない** —— **動詞(作成/更新 と
 * 書き込み/削除)で分ける形も今日どおり成り立っており、2本を数え分ける (E-7) の
 * 読み方を変えないためである。**
 */
async function isWallForbidden(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  const text = await res.clone().text();
  return /表 \\"[a-z0-9_]+\\" のボタン に対する(作成|更新)は、あなたの役割に許されていません\(止めた層: role\)。/.test(
    text,
  );
}

/**
 * **【`V8-M26`(ユーザ決定 `D-V8-45` / `D-V8-58` / `D-V8-65`)で足した2本目の目印】**
 *
 * **面の「表 x 書込」の規則が止めた 403 かどうか。** **壁の 403 と文面が1文字だけ違う** ——
 * **壁は「作成」/「更新」、表の規則は「書き込み」/「削除」である**(`app.ts` の
 * `forbiddenRoleAccessError` の呼び出し2種)。
 *
 * **なぜ2本目が要るようになったか** —— **既定が「閉じる」側へ倒れたので、規則を1本も
 * 書いていない表への書込は、壁に届く前に表の規則が止める。** **上の doc の
 * 「この2つが同時に立つ表は1つも無い」は、参照 EC では今日も真である**(表の規則が止めた
 * 表は壁に届かないので、2つの文面が同時に返ることはない)——
 * **が、「壁で止まる表」と「表の規則で止まる表」は今日 別々に数える必要がある。**
 *
 * **【`V8-M39` / 台帳 `F-G8` で目印を差し替えた。旧の逐語を1バイトも消していない】**
 *
 *     return /表 \\"[a-z0-9_]+\\" に対する(書き込み|削除)は、あなたの役割に許されていません。/.test(text);
 *
 * **変わったのは文末の `(止めた層: role)` だけである** —— **`F-G7` は本関数が見る2箇所
 * (`recordsAuthMiddleware` とバッチの表の関門)の第1引数を1バイトも動かしていない**
 * (**あちらは実際に**表**を判定しており、文面と食い違っていなかった**)。
 */
async function isTableRoleForbidden(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  const text = await res.clone().text();
  return /表 \\"[a-z0-9_]+\\" に対する(書き込み|削除)は、あなたの役割に許されていません\(止めた層: role\)。/.test(
    text,
  );
}

/** `cart_line` を作るときに `cart-line-form` が送る形(`fields` の3項目 + 単価)。 */
async function seedCartAndProduct(): Promise<{
  ownerCookie: string;
  buyer: ReturnType<typeof seedSession>;
  productId: string;
  cartId: string;
}> {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const productId = await create(owner.cookie, "product", {
    name: "藻塩 150g",
    sku: "SKU-E",
    price: 1200,
    stock: 10,
    status: "active",
    [PUBLIC_FIELD]: true,
  });
  const buyer = seedSession(dataRoot, APP_ID, { role: "customer" });
  const cartId = await create(buyer.cookie, "cart", { status: "open", created_at: "2026-08-06" });
  return { ownerCookie: owner.cookie, buyer, productId, cartId };
}

describe("(E) 見せる相手から立った書込の壁(参照EC の実データ・本物の HTTP)", () => {
  test("(E-1) 運営(owner)は cart_line を1件も作れない(403)—— 商品一覧の「買い物かごに入れる」の宣言が壁になる", async () => {
    const { ownerCookie, productId, cartId } = await seedCartAndProduct();

    const res = await req(ownerCookie, "POST", recordsPath("cart_line"), {
      cart: cartId,
      product: productId,
      quantity: 1,
      unit_price: 1200,
    });
    expect(res.status, await res.clone().text()).toBe(403);
    // **【2026-08-10(`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-58` / `D-V8-65`)。
    // 止めた層が入れ替わった。旧の1行を逐語で残す】**
    //
    // **旧**: `expect(await isWallForbidden(res)).toBe(true);`
    //   —— コメントの逐語は「**壁の 403 である**(項目単位の書込制御や直接作成の遮断ではない)」。
    //
    // **今日は「表 x 書込」の規則が壁より手前で止める。** **参照 EC の運営は `cart_line` に
    // 規則を1本も持たない**(本物の EC の運営は他人の買い物かごを触らない)—— **既定が
    // 閉じた今日、それは「触れない」を意味する。**
    // **【誇張しない】止まった結果(403 / 0行)は1ミリも変わっていない。** **変わったのは
    // どの層が止めたかだけであり、壁が消えたわけでも弱くなったわけでもない。**
    expect(await isWallForbidden(res)).toBe(false);
    expect(await isTableRoleForbidden(res)).toBe(true);
    // **1行も増えていない。**
    expect(rowsOf("cart_line")).toHaveLength(0);
  });

  test("(E-2) 運営(owner)は商品詳細の「カートに入れる」が送るのと同じ要求でも作れない(403)—— **サーバは押したボタンを見分けないので、測っているのは表と種類だけである**", async () => {
    // **【テスト名を発注書から変えた。理由をここに書く】**
    //
    // 発注書の逐語は「**商品詳細の「カートに入れる」経由でも作れない**」だった。
    // **サーバはどの操作起点から来たかを1バイトも受け取っていない**(`ADR-0249` 限定7:
    // 「要求が画面を名乗ったかどうかを1ミリも見ない」)。**したがって「経由」を測ることは
    // 今日できない。** 実際に測れるのは次の2つだけである:
    //   (1) `product-detail:569-571` の宣言の無いボタンが送るのと**同じ body**(= `cart-line-form`
    //       の `fields` に `product` をプリフィルした形)でも 403 になること。
    //   (2) `?view=product-detail` と**名乗っても**答えが変わらないこと。
    // **「宣言の無いボタンだから止まった」のではない** —— **同じ表への同じ種類の書込だから
    // 止まっている。** `ADR-0249` §Decision 4 の「宣言の無い操作起点は壁を消さない」の帰結である。
    const { ownerCookie, productId, cartId } = await seedCartAndProduct();

    // `product-detail` の操作起点は**識別子(`id`)を持たない**(**面から名指しできない
    // ボタン**)。**旧の逐語**: 「`product-detail` の操作起点は `audience` を1つも持たない
    // (**宣言の無いボタン**)」/ `expect((fromDetail as { audience?: string[] }).audience).toBeUndefined();`
    const detail = viewOf("product-detail") as DetailView;
    const fromDetail = (detail.actions ?? []).find(
      (a) => "form" in a && a.form === "cart-line-form",
    );
    expect(fromDetail).toBeDefined();
    expect((fromDetail as { id?: string }).id).toBeUndefined();

    // その画面から開く form の `fields` そのままの body。
    const formFields = (viewOf("cart-line-form") as FormView).fields;
    const body: Record<string, unknown> = { cart: cartId, product: productId, quantity: 1 };
    expect(Object.keys(body).sort()).toEqual([...formFields].sort());

    // **【2026-08-10(`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-58` / `D-V8-65`)。
    // (1)(2) の止めた層が入れ替わった。旧の2行を逐語で残す】**
    //
    // **旧**: `expect(await isWallForbidden(bare)).toBe(true);`
    //         `expect(await isWallForbidden(named)).toBe(true);`
    //
    // **今日は (1) が「表 x 書込」の規則で、(2) が「名乗られた画面の閲覧」の規則で止まる** ——
    // **`cart-line-form` は購入者の画面であり、運営には開けていないからである。**
    // **測っている中身(押したボタンを見分けない / 名乗っても答えが変わらない)は
    // 1ミリも変わっていない** —— **どちらも 403 で、行は1件も増えない。**
    //
    // (1) 名乗らない要求。
    const bare = await req(ownerCookie, "POST", recordsPath("cart_line"), body);
    expect(bare.status).toBe(403);
    expect(await isWallForbidden(bare)).toBe(false);
    expect(await isTableRoleForbidden(bare)).toBe(true);

    // (2) 画面を名乗った要求。**同じ状態コードである。**
    // 名乗るのは**その表の画面**でなければならない —— `cart-line-form` は
    // `product-detail` のボタンが開く先であり、表は `cart_line` である。
    const named = await req(
      ownerCookie,
      "POST",
      `${recordsPath("cart_line")}?view=cart-line-form`,
      body,
    );
    expect(named.status).toBe(403);
    expect(named.status).toBe(bare.status);
    expect(await isWallForbidden(named)).toBe(false);

    // **【実測して分かったことを隠さない】** **押したボタンが乗っていた画面
    // (`product-detail`)を名乗ると、応答は 403 ではなく 400 になる。**
    // **壁とは無関係の既存の検査**(`app.ts:1627` の「画面の対象テーブルと URL のテーブルが
    // 一致していること」)が、**壁より手前(middleware)で落としているためである** ——
    // `product-detail` の表は `product` で、URL の表は `cart_line` である。
    // **つまり「押したボタンの画面を名乗る」経路は、そもそも今日サーバに通らない。**
    // **これは本タスクが実測で踏んだものであり、`ADR-0249` 限定7 とは別の話である。**
    const namedDetail = await req(
      ownerCookie,
      "POST",
      `${recordsPath("cart_line")}?view=product-detail`,
      body,
    );
    expect(namedDetail.status).toBe(400);
    expect(await isWallForbidden(namedDetail)).toBe(false);

    expect(rowsOf("cart_line")).toHaveLength(0);
  });

  test("(E-3) 購入者(customer)は今日どおり cart_line を作れる(201)", async () => {
    const { buyer, productId, cartId } = await seedCartAndProduct();
    const res = await req(buyer.cookie, "POST", recordsPath("cart_line"), {
      cart: cartId,
      product: productId,
      quantity: 2,
      unit_price: 1200,
    });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(rowsOf("cart_line")).toHaveLength(1);
    // 島(`fn-line-total`)も今日どおり走っている。
    expect(rowsOf("cart_line")[0]?.line_total).toBe(2400);
  });

  test("(E-4) 運営(owner)は order を1件も作れない(403)", async () => {
    const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
    // `checkout-form` の `fields` に載っている9項目をそのまま送る((B-1) と同じ形)。
    const res = await req(owner.cookie, "POST", recordsPath("order"), {
      cart: null,
      customer: null,
      order_number: "ORD-E4",
      shipping_method: null,
      payment_method: "bank_transfer",
      payment_slip: null,
      currency: "JPY",
      status: "pending_payment",
      payment_status: "unpaid",
    });
    expect(res.status, await res.clone().text()).toBe(403);
    expect(await isWallForbidden(res)).toBe(true);
    expect(rowsOf("order")).toHaveLength(0);
  });

  test("(E-5) 購入者(customer)は今日どおり order を作れる(201)", async () => {
    const buyer = seedSession(dataRoot, APP_ID, { role: "customer" });
    const cartId = await create(buyer.cookie, "cart", { status: "open" });
    const res = await req(buyer.cookie, "POST", recordsPath("order"), {
      cart: cartId,
      customer: null,
      order_number: "ORD-E5",
      shipping_method: null,
      payment_method: "bank_transfer",
      payment_slip: null,
      currency: "JPY",
      status: "pending_payment",
      payment_status: "unpaid",
    });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(rowsOf("order")).toHaveLength(1);
  });

  test("(E-6) 壁の立った表への GET と DELETE は今日どおり(穴を固定する)", async () => {
    const { ownerCookie, buyer, productId, cartId } = await seedCartAndProduct();
    // 壁の中の相手が2つの表に1行ずつ置く。
    const lineRes = await req(buyer.cookie, "POST", recordsPath("cart_line"), {
      cart: cartId,
      product: productId,
      quantity: 1,
      unit_price: 1200,
    });
    expect(lineRes.status).toBe(201);
    const line = ((await lineRes.json()) as { record: { _id: string; _updated_at: string } })
      .record;
    // **【`V8-M20` / `J-G30`】旧の作成本文には `st_admin_readable: true` が入っていた**
    // (今日はその項目が `order` に存在しないので 400 になる)。**落としただけである。**
    const orderId = await create(buyer.cookie, "order", {
      order_number: "ORD-E6",
      status: "pending_payment",
      payment_status: "unpaid",
    });

    // --- GET は壁に1ミリも触れない -----------------------------------------
    // **壁の外(owner)でも 200 が返る。** 何行見えるかを決めているのは今日どおり
    // 個人スコープ(`st_owner`)と**面の表の規則**であって、壁ではない。
    // **旧の逐語**: 「個人スコープ(`st_owner`)と `st_admin_readable` であって」。
    const lineGet = await req(ownerCookie, "GET", recordsPath("cart_line"));
    expect(lineGet.status).toBe(200);
    // `cart_line` を読める面の規則は1本も無いので、運営には0行である(`ADR-0033`)。
    // **旧の逐語**: 「`cart_line` に `st_admin_readable` は無いので」。
    expect(((await lineGet.json()) as { records: unknown[] }).records).toHaveLength(0);

    const orderGet = await req(ownerCookie, "GET", recordsPath("order"));
    expect(orderGet.status).toBe(200);
    // `order` には `owner` の読取の規則が在るので、運営に1行見える(`D-V8-35`)。
    // **旧の逐語**: 「`order` には `st_admin_readable` が在るので、運営に1行見える。」
    expect(
      ((await orderGet.json()) as { records: { _id: string }[] }).records.map((r) => r._id),
    ).toEqual([orderId]);

    // --- DELETE も壁に1ミリも触れない ---------------------------------------
    // **壁の中の相手(= 行の持ち主)は今日どおり消せる。**
    const del = await req(buyer.cookie, "DELETE", `${recordsPath("cart_line")}/${line._id}`);
    expect(del.status).toBe(400); // `If-Match` 必須(`ADR-0017`)。壁の 403 ではない。
    // **作成応答が返した版はもう古い** —— 島(`fn-line-total`)が `line_total` を書き戻して
    // `_updated_at` を進めているためである(そのまま渡すと 409 になる。実測した)。
    const lineVersion = String(rowsOf("cart_line")[0]?._updated_at);
    expect(lineVersion).not.toBe(String(line._updated_at));
    const delOk = await app.request(
      new Request(`http://localhost${recordsPath("cart_line")}/${line._id}`, {
        method: "DELETE",
        headers: {
          origin: TEST_ORIGIN,
          cookie: buyer.cookie,
          "if-match": lineVersion,
        },
      }),
    );
    expect(delOk.status, await delOk.clone().text()).toBe(204);
    expect(rowsOf("cart_line")).toHaveLength(0);

    // **【正直に書く】参照EC では「壁の外の相手が消せる」を測れない。**
    // 運営が同じ表の行を消しに行くと、**壁より先に個人スコープの 404 が立つ**
    // (`app.ts` の `isOwnerVisible(...)`。**削除の経路は `roleReadCrossesOwnerScope` を
    // 1度も呼ばない** —— `D-V8-35` が開いたのは読取だけである)。
    // **旧の逐語**: 「(`app.ts:2871` の `isOwnerVisible(...)`。`st_admin_readable` を
    // 第3引数に渡していない)」。
    // **したがって §4-5 の穴5(`DELETE` に壁が掛からない)を参照EC の実データで
    // 実証できていない** —— **それを実証しているのは
    // `src/server/view-action-write-wall.test.ts` の `(H-5)` である。**
    const orderRow = rowsOf("order")[0];
    const outsider = await app.request(
      new Request(`http://localhost${recordsPath("order")}/${orderId}`, {
        method: "DELETE",
        headers: {
          origin: TEST_ORIGIN,
          cookie: ownerCookie,
          "if-match": String(orderRow?._updated_at),
        },
      }),
    );
    expect(outsider.status).toBe(404);
    // **壁の 403 ではない**(壁は `DELETE` を1バイトも見ていない)。
    expect(await isWallForbidden(outsider)).toBe(false);
    // **行は消えていない。**
    expect(rowsOf("order")).toHaveLength(1);
  });

  // **【2026-08-10(`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-58` / `D-V8-65`)。
  // 期待値を反転させた。旧のテスト名と旧の期待値を逐語で残す】**
  //
  // **旧テスト名**: 「(E-7) 参照EC で壁が立つのは2つの表だけである —— **ユーザに伝えた
  // 「参照ECの2箇所」を実数で確かめる**」。
  // **旧の期待値**:
  // ```
  //   expect(walled.sort()).toEqual(["cart_line", "order"]);
  //   expect(walled).toHaveLength(2);
  // ```
  //
  // **反転の理由**: **既定が「閉じる」側へ倒れたので、運営が「表 x 書込」の規則を持たない表
  // では、壁より手前で表の規則が止める。** **`cart_line` がそれである** —— **壁は今日も
  // 立っているが、運営の要求はそこへ届かない。** **観測できる壁は `order` の1本になった。**
  // **【誇張しない】これは「壁が1本になった」ではない** —— **壁の宣言(`add-to-cart` /
  // `checkout` の2本)は1バイトも減っていない。** **観測できる相手(運営)が、手前の層で
  // 先に止まるようになっただけである。**
  test("(E-7) 参照EC で運営から観測できる壁は order 1つで、cart_line は手前の表の規則が止める", async () => {
    // **述語を呼ばずに、本物の HTTP で数える。**
    // 壁の判定は**本文を読む前**に置いてある(`app.ts` の逐語「ボディを読む前」)ので、
    // **空の body を投げると、壁の立った表だけが 403(面の文面)を返し、
    // 立っていない表は 400(必須項目が無い)か 201 を返す。**
    // **旧の逐語**: 「壁の立った表だけが 403(`view_action.audience`)を返し」。
    const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
    const walled: string[] = [];
    const tableRoleBlocked: string[] = [];
    for (const table of manifest.app.tables) {
      const res = await req(owner.cookie, "POST", recordsPath(table.id), {});
      if (await isWallForbidden(res)) {
        walled.push(table.id);
      }
      if (await isTableRoleForbidden(res)) {
        tableRoleBlocked.push(table.id);
      }
    }
    // **1つである。** 会計(`order`)だけが壁まで届く。
    expect(walled.sort()).toEqual(["order"]);
    expect(walled).toHaveLength(1);
    // **カート投入(`cart_line`)は手前で止まっている** —— **同じ表が2つの層に同時に
    // 現れないことも、ここで固定する。**
    expect(tableRoleBlocked).toContain("cart_line");
    expect(tableRoleBlocked).not.toContain("order");

    // **更新の壁は1本も立っていない** —— **参照EC に `set` 形の操作起点が1本も無いからである。**
    // (壁の材料は宣言のある操作起点だけなので、`set` の本数を数えれば足りる。)
    const setActions = manifest.app.views
      .flatMap((v) => ("actions" in v ? ((v.actions ?? []) as Record<string, unknown>[]) : []))
      .filter((a) => "set" in a);
    expect(setActions).toHaveLength(0);
  });
});
