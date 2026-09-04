/**
 * `V4-M23-T05`: **参照ショップに合計の宣言を実地に当て、外せたもの・外せないものを実測する**
 * (`D-V4-89` / `E-G31` / `ADR-0104`)。
 *
 * 上位: `docs/plan/v4/records/v4-m23.md` §1-1 の `V4-M23-T05` の行 /
 *       `docs/plan/v4/records/v4-m23-gate-a-list-sum.md`(単位A-2 = **限定採用**)。
 *
 * ## 本ファイルの立場(誇張しない。憲法6)
 *
 * **【禁止】「回避策が不要になった」と総括しない**(`V4-M23-T05` 完了条件 (3))。
 * **本ファイルは「何が外せて、何が外せないか」を1件ずつ実測して固定するものである。**
 *
 * ## 今日の回避策(`v4-m23.md` §2-4 が数えた実測。**合計8つの構造物**)
 *
 * | # | 種別 | ID |
 * |---|---|---|
 * | 1 | 集計テーブル | `cart_totals` |
 * | 2 | 集計テーブル | `order_totals` |
 * | 3 | 集計の島 | `fn-cart-totals` |
 * | 4 | 集計の島 | `fn-order-totals` |
 * | 5 | 行内計算の島 | `fn-line-total`(単価×数量。Route B) |
 * | 6 | ワークフロー | `wf-totals-sweep`(**毎日03:00の定時再集計**) |
 * | 7 | ワークフロー | `wf-cart-line-total` |
 * | 8 | 集計閲覧ビュー | `order-totals-list` |
 *
 * ## このファイルが測らないこと(先に書く)
 *
 * 1. **性能を1度も測っていない**(それは `V4-M23-T06` である)。
 * 2. **ブラウザを1枚も開いていない。** ここは本物の SQLite と本物の HTTP である。
 * 3. **参照ショップのマニフェストを1バイトも書き換えていない** —— 測るときは
 *    **その場で組み立てた変種**を別アプリとして適用する。**`scripts/ref-ec/manifest.ts` の
 *    差分は0行である。**
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest } from "../../src/kernel/apply-manifest.ts";
import { createApp } from "../../src/kernel/create-app.ts";
import { ensureIslandRuntimeReady } from "../../src/kernel/island-runner.ts";
import { KernelMetaStore } from "../../src/kernel/meta-store.ts";
import type { ListView, Manifest } from "../../src/kernel/types.ts";
import { createServerApp } from "../../src/server/app.ts";
import { TEST_ORIGIN } from "../../src/server/test-helpers.ts";
import { REF_EC_APP_ID, referenceEcManifest } from "./manifest.ts";

const APP_ID = REF_EC_APP_ID;

let dataRoot: string;
let store: KernelMetaStore;
let app: ReturnType<typeof createServerApp>;
let ownerCookie: string;
let customerCookie: string;

beforeAll(async () => {
  await ensureIslandRuntimeReady();
});

type Res = { status: number; body: unknown; text: string };
type Row = Record<string, unknown> & { _id: string; _updated_at: string };

async function call(
  cookie: string | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<Res> {
  const h: Record<string, string> = { origin: TEST_ORIGIN };
  if (cookie !== undefined) {
    h.cookie = cookie;
  }
  const init: RequestInit = { method, headers: h };
  if (body !== undefined) {
    h["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await app.request(new Request(`${TEST_ORIGIN}${path}`, init));
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { status: res.status, body: parsed, text };
}

async function register(path: string, username: string): Promise<string> {
  const res = await app.request(
    new Request(`${TEST_ORIGIN}${path}`, {
      method: "POST",
      headers: { origin: TEST_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ username, password: `${username}-password` }),
    }),
  );
  if (res.status !== 200) {
    throw new Error(`${username} の登録に失敗しました(${res.status}): ${await res.text()}`);
  }
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const [name, value] = (pair ?? "").split("=");
    if (name === "st_session" && value !== undefined) {
      return `st_session=${value}`;
    }
  }
  throw new Error(`${username} の登録で st_session cookie が発行されませんでした。`);
}

const records = (table: string): string => `/api/apps/${APP_ID}/tables/${table}/records`;
const rowOf = (res: Res): Row => (res.body as { record: Row }).record;

/**
 * **参照ショップのマニフェストに `sum_field` を1本だけ足した変種。**
 * **`scripts/ref-ec/manifest.ts` を1バイトも書き換えていない**(その場で組み立てる)。
 */
function withCartSum(): Manifest {
  const manifest = referenceEcManifest();
  const cartLineList = manifest.app.views.find((view) => view.id === "cart-line-list") as ListView;
  (cartLineList as unknown as Record<string, unknown>).sum_field = "line_total";
  return manifest;
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-cart-sum-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "参照EC", { app_id: APP_ID });
  const installed = applyManifest(dataRoot, APP_ID, withCartSum());
  if (!installed.valid) {
    throw new Error(`合計つき参照 EC の投入に失敗: ${JSON.stringify(installed.errors)}`);
  }
  app = createServerApp({ dataRoot });
  ownerCookie = await register(`/api/apps/${APP_ID}/auth/password/register`, "sum-owner");
  customerCookie = await register(
    `/api/apps/${APP_ID}/auth/signup/password/register`,
    "sum-customer",
  );
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

async function seedProduct(sku: string, price: number): Promise<Row> {
  const res = await call(ownerCookie, "POST", records("product"), {
    name: `測定用 ${sku}`,
    sku,
    price,
    stock: 100,
    status: "active",
    st_public: true,
  });
  expect(res.status, res.text).toBe(201);
  return rowOf(res);
}

async function newCart(): Promise<Row> {
  const res = await call(customerCookie, "POST", records("cart"), { status: "open" });
  expect(res.status, res.text).toBe(201);
  return rowOf(res);
}

async function addLine(
  cartId: string,
  productId: string,
  quantity: number,
  unitPrice: number,
): Promise<Row> {
  const res = await call(customerCookie, "POST", records("cart_line"), {
    cart: cartId,
    product: productId,
    quantity,
    unit_price: unitPrice,
  });
  expect(res.status, res.text).toBe(201);
  return rowOf(res);
}

/** 客が「カートの中身」の画面を開いたときにサーバへ飛ぶのと同じ読み取り。 */
async function readCartLineList(): Promise<{ total: number; sum: unknown }> {
  const filter = encodeURIComponent(JSON.stringify({ not: { field: "voided", equals: true } }));
  const res = await call(
    customerCookie,
    "GET",
    `${records("cart_line")}?filter=${filter}&sum=line_total&limit=50`,
  );
  expect(res.status, res.text).toBe(200);
  const body = res.body as { total: number; sum?: unknown };
  return { total: body.total, sum: body.sum };
}

// ---------------------------------------------------------------------------
// (1) 外せた分 —— 買い物かごの合計は、集計テーブルも島もワークフローも通らずに出る
// ---------------------------------------------------------------------------

describe("(1) 外せた分", () => {
  test("カートの合計が、集計テーブル・島・ワークフローを1つも通らずに出る", async () => {
    const product = await seedProduct("SKU-SUM-1", 1200);
    const cart = await newCart();
    await addLine(cart._id, product._id, 2, 1200);
    // **同じ品をもう一度入れても行は増えない**(`V4-M21-T01` / `E-G30` の重複防止)——
    // **数量が 2 → 5 に増え、`line_total` が島によって書き直される。**
    await addLine(cart._id, product._id, 3, 1200);

    const view = await readCartLineList();
    expect(view.total).toBe(1);
    // 1200×5 = 6000。**`line_total` は `wf-cart-line-total` が入れた行内の値である。**
    expect(view.sum).toBe(6000);

    // **`cart_totals` は1行も無い**(定時再集計がまだ走っていないため)。
    const totals = await call(ownerCookie, "GET", records("cart_totals"));
    expect((totals.body as { total: number }).total).toBe(0);
  });

  test("【最も重い実測】客が今入れた品が、即座に合計に出る(最大24時間の遅れが消えた)", async () => {
    const first = await seedProduct("SKU-SUM-2A", 500);
    const second = await seedProduct("SKU-SUM-2B", 500);
    const cart = await newCart();
    await addLine(cart._id, first._id, 1, 500);
    expect((await readCartLineList()).sum).toBe(500);

    // **もう1件入れた直後に、同じ読み取りが新しい合計を返す。**
    await addLine(cart._id, second._id, 4, 500);
    expect((await readCartLineList()).sum).toBe(2500);

    // **`cart_totals` は今日も空のままである** —— **合計は `cart_totals` を1バイトも見ていない。**
    const totals = await call(ownerCookie, "GET", records("cart_totals"));
    expect((totals.body as { total: number }).total).toBe(0);
  });

  test("無効にした明細は合計にも入らない(画面の filter と母集団が一致している)", async () => {
    // **別々の品にする** —— 同じ品だと `E-G30` の重複防止で1行に畳まれる。
    const kept = await seedProduct("SKU-SUM-3A", 300);
    const dropped = await seedProduct("SKU-SUM-3B", 300);
    const cart = await newCart();
    const keep = await addLine(cart._id, kept._id, 2, 300);
    const drop = await addLine(cart._id, dropped._id, 5, 300);

    const before = await readCartLineList();
    expect(before.total).toBe(2);
    expect(before.sum).toBe(2100);

    // **楽観ロック(`ADR-0017`)により `If-Match` が要る。**
    // **行を読み直してから版を取る** —— `wf-cart-line-total`(島)が `line_total` を
    // 書き戻しており、作成時に返った版はもう古い。
    const reread = await call(customerCookie, "GET", `${records("cart_line")}/${drop._id}`);
    expect(reread.status, reread.text).toBe(200);
    const currentVersion = rowOf(reread)._updated_at;
    const voidedRes = await app.request(
      new Request(`${TEST_ORIGIN}${records("cart_line")}/${drop._id}`, {
        method: "PATCH",
        headers: {
          origin: TEST_ORIGIN,
          cookie: customerCookie,
          "content-type": "application/json",
          "if-match": currentVersion,
        },
        body: JSON.stringify({ voided: true }),
      }),
    );
    const voidedText = await voidedRes.text();
    expect(voidedRes.status, voidedText).toBe(200);

    const after = await readCartLineList();
    // **件数も合計も同じ母集団で縮む**(`ADR-0104` 限定5)。
    expect(after.total).toBe(1);
    expect(after.sum).toBe(600);
    expect(keep._id).not.toBe(drop._id);
  });
});

// ---------------------------------------------------------------------------
// (2) 外せない分 —— 名指しする(`V4-M23-T05` 完了条件 (2))
// ---------------------------------------------------------------------------

describe("(2) 外せない分(名指しする)", () => {
  /**
   * **`fn-line-total` / `wf-cart-line-total` は外せない。**
   *
   * **`sum_field` が足すのは「既に行に入っている `number` 列」だけである。**
   * **単価×数量という行ごとの計算を1つも行わない**(`ADR-0104` が式を1バイトも開いていない)。
   * **`line_total` を書いているのは今日も島(Route B)である。**
   */
  test("fn-line-total / wf-cart-line-total は外せない(行内の計算は合計では作れない)", async () => {
    const product = await seedProduct("SKU-SUM-4", 700);
    const cart = await newCart();
    const line = await addLine(cart._id, product._id, 3, 700);

    // **行に `line_total` が入っているのは島が書いたからである。**
    const read = await call(customerCookie, "GET", `${records("cart_line")}/${line._id}`);
    expect(read.status, read.text).toBe(200);
    expect(rowOf(read).line_total).toBe(2100);

    // **その列が無ければ合計する対象そのものが無い。**
    expect((await readCartLineList()).sum).toBe(2100);
  });

  /**
   * **`order.total`(注文行の行内 `number` 列)は外せない。**
   * **一覧の合計は「集合に対する1つの数」であり、行ごとの値を作らない。**
   */
  test("order.total(行内の number 列)は外せない —— 合計は行ごとの値を1つも作らない", () => {
    const manifest = withCartSum();
    const order = manifest.app.tables.find((table) => table.id === "order");
    expect(order?.fields.some((field) => field.id === "total")).toBe(true);
    // **`sum_field` は `list_view` のキーであり、テーブルの列を1本も作らない。**
    const viewKeys = manifest.app.views.flatMap((view) =>
      Object.keys(view as unknown as Record<string, unknown>),
    );
    expect(viewKeys).toContain("sum_field");
    expect(order?.fields.map((field) => field.id)).toContain("total");
  });

  /**
   * **`order_totals` / `fn-order-totals` / `order-totals-list` は外せない。**
   *
   * **あの画面が出しているのは「注文ごとに1行」である** —— **注文で束ねた行集合であり、
   * `group by` の側である。** **`ADR-0104` 限定8 は `group_by` を1バイトも開いていない。**
   */
  test("order_totals / fn-order-totals / order-totals-list は外せない(注文ごとに束ねる = group by)", () => {
    const manifest = withCartSum();
    const view = manifest.app.views.find((candidate) => candidate.id === "order-totals-list");
    expect(view).toBeDefined();
    // **列が6本ある** —— 合計1つでは置き換わらない。
    expect((view as ListView).columns).toEqual([
      "order",
      "subtotal",
      "discount",
      "shipping_fee",
      "tax",
      "total",
    ]);
    // **`sum_field` は1画面1列だけである**(`ADR-0104` 限定3)。
    expect(typeof (view as unknown as Record<string, unknown>).sum_field).not.toBe("object");
  });

  /**
   * **`cart_totals` / `fn-cart-totals` / `wf-totals-sweep` を今日は外していない。**
   *
   * **外せるのは「合計」の1列だけで、`subtotal` / `discount` / `shipping_fee` / `tax` の
   * 4列は1つも作れない**(1画面で合計できる列は1本だけ = 限定3)。
   * **【禁止】「定時再集計が要らなくなった」と総括しない。**
   */
  test("cart_totals の5列のうち、合計で置き換えられるのは1列だけである", () => {
    const manifest = withCartSum();
    const cartTotals = manifest.app.tables.find((table) => table.id === "cart_totals");
    const numberColumns = (cartTotals?.fields ?? [])
      .filter((field) => field.type === "number")
      .map((field) => field.id);
    expect(numberColumns).toEqual(["subtotal", "discount", "shipping_fee", "tax", "total"]);
    // **1画面につき1列。** **5列を出すには5画面が要る**(そして4列は足し算ではない)。
    expect(numberColumns).toHaveLength(5);
  });

  /**
   * **カート合計は「そのカートの合計」ではない。** **これが本増分の最大の限界である。**
   *
   * **`cart-line-list` は `cart` で絞っていない** —— **客が自分の行だけを見るのは
   * `st_owner` の post-filter による**(`ADR-0016`)。**したがって同じ客が2つのカートを
   * 持つと、合計は2つのカートを足した数になる。**
   * **絞るには画面の `filter` に「どのカートか」を書く必要があるが、`filter` の値に
   * 実行時解決を1つも許していない**(`ADR-0064` 限定4。本増分は1バイトも引き直していない)。
   */
  test("【最大の限界】カートが2つあると、合計は2つを足した数になる(カート単位ではない)", async () => {
    const product = await seedProduct("SKU-SUM-5", 100);
    const cartA = await newCart();
    const cartB = await newCart();
    await addLine(cartA._id, product._id, 1, 100);
    await addLine(cartB._id, product._id, 2, 100);

    const view = await readCartLineList();
    // **2行・300 円** —— **「カートAの合計」ではない。**
    expect(view.total).toBe(2);
    expect(view.sum).toBe(300);
  });

  /**
   * **他人のカートは1円も混ざらない。** **これは post-filter が効いていることの実測である**
   * (`ADR-0104` 限定7)。**上の限界と別の話であることを、同じ場所で示す。**
   */
  test("他人のカートの明細は合計に1円も入らない(st_owner の post-filter が効いている)", async () => {
    const product = await seedProduct("SKU-SUM-6", 900);
    const mine = await newCart();
    await addLine(mine._id, product._id, 1, 900);

    const other = await register(
      `/api/apps/${APP_ID}/auth/signup/password/register`,
      "sum-customer-2",
    );
    const otherCart = await call(other, "POST", records("cart"), { status: "open" });
    expect(otherCart.status, otherCart.text).toBe(201);
    const otherAdd = await call(other, "POST", records("cart_line"), {
      cart: rowOf(otherCart)._id,
      product: product._id,
      quantity: 10,
      unit_price: 900,
    });
    expect(otherAdd.status, otherAdd.text).toBe(201);

    // **自分の側は 900 のままである**(他人の 9000 が1円も入らない)。
    expect((await readCartLineList()).sum).toBe(900);
  });
});

// ---------------------------------------------------------------------------
// (3) 参照ショップのマニフェストを1バイトも書き換えていないことの実測
// ---------------------------------------------------------------------------

describe("(3) 参照ショップ本体を1バイトも書き換えていない", () => {
  test("scripts/ref-ec/manifest.ts に sum_field が1文字も無い", async () => {
    const source = await Bun.file(new URL("./manifest.ts", import.meta.url)).text();
    expect(source).not.toContain("sum_field");
  });

  test("8つの回避策の構造物は、今日も8つとも在る", () => {
    const manifest = referenceEcManifest();
    const tableIds = manifest.app.tables.map((table) => table.id);
    const viewIds = manifest.app.views.map((view) => view.id);
    const functionIds = (manifest.app.functions ?? []).map((fn) => fn.id);
    const workflowIds = (manifest.app.workflows ?? []).map((wf) => wf.id);
    expect(tableIds).toContain("cart_totals");
    expect(tableIds).toContain("order_totals");
    expect(functionIds).toContain("fn-cart-totals");
    expect(functionIds).toContain("fn-order-totals");
    expect(functionIds).toContain("fn-line-total");
    expect(workflowIds).toContain("wf-totals-sweep");
    expect(workflowIds).toContain("wf-cart-line-total");
    expect(viewIds).toContain("order-totals-list");
  });
});
