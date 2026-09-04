/**
 * `V4-M21-T01`: 同じ品をもう一度カートに入れても、客の画面に2行出ない状態を
 * **既存語彙だけで**実際に作って示す(`E-G30` / `D-V4-72`)。
 *
 * 上位: `docs/plan/v4/records/v4-m21.md` §1 の `V4-M21-T01` /
 *       `docs/plan/v4/records/v4-m21-gate-a-workflow-row-removal.md`(単位A = **却下**)。
 *
 * ## 本ファイルの立場(誇張しない。憲法6)
 *
 * **単位A は却下された。** **「自動処理が行を消せるようにする」という増分は1バイトも
 * 作っていない** —— 島(コード)が返せる操作は今日も `create` / `update` の2種だけである
 * (`src/kernel/batch.ts` を1バイトも触っていない)。**却下の帰属先は「既存語彙」であり、
 * 本ファイルはその帰属先が本当に目的を満たすのかを実際に動かして確かめるものである。**
 *
 * 使ったのは3つとも今日在るものだけである:
 *
 * 1. **`boolean` フィールド1本**(`cart_line.voided`)。
 * 2. **島の `update` op**(`run_function` の `write_ops` モード。`ADR-0067`)。
 * 3. **`filter` の `not` / `equals`**(`ADR-0043`)。
 *
 * ## 【解けないことを先に書く】
 *
 * - **行は消えない。** 無効になった行は DB に残り続け、データ量に比例して増える。
 *   **「カートの重複が直った」とは書かない。**
 * - **`filter` を書き忘れた画面には無効行が出る。** 本ファイルはそれも実測で固定する
 *   (`cart-detail` の関連一覧には `filter` を**書けない** —— `ADR-0044` 限定2)。
 * - **`_id` は残るので、その行を参照していた行は切れない**(これは利点の側)。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest } from "../../src/kernel/apply-manifest.ts";
import { createApp } from "../../src/kernel/create-app.ts";
import { ensureIslandRuntimeReady } from "../../src/kernel/island-runner.ts";
import { KernelMetaStore } from "../../src/kernel/meta-store.ts";
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
const listOf = (res: Res): Row[] => (res.body as { records: Row[] }).records;
const totalOf = (res: Res): number => (res.body as { total: number }).total;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-cart-dedupe-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "参照EC", { app_id: APP_ID });
  const installed = applyManifest(dataRoot, APP_ID, referenceEcManifest());
  if (!installed.valid) {
    throw new Error(`参照 EC マニフェストの投入に失敗: ${JSON.stringify(installed.errors)}`);
  }
  app = createServerApp({ dataRoot });
  ownerCookie = await register(`/api/apps/${APP_ID}/auth/password/register`, "dedupe-owner");
  customerCookie = await register(
    `/api/apps/${APP_ID}/auth/signup/password/register`,
    "dedupe-customer",
  );
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

async function seedProduct(sku = "SKU-DEDUPE-1"): Promise<Row> {
  const res = await call(ownerCookie, "POST", records("product"), {
    name: "測定用の商品",
    sku,
    price: 1200,
    stock: 10,
    status: "active",
    st_public: true,
  });
  expect(res.status).toBe(201);
  return rowOf(res);
}

async function addLine(cartId: string, productId: string, quantity: number): Promise<Row> {
  const res = await call(customerCookie, "POST", records("cart_line"), {
    cart: cartId,
    product: productId,
    quantity,
    unit_price: 1200,
  });
  expect(res.status, res.text).toBe(201);
  return rowOf(res);
}

/** 画面の `cart-line-list` が宣言している `filter` をそのまま query に載せて読む。 */
function listWithViewFilter(): Promise<Res> {
  const filter = encodeURIComponent(JSON.stringify({ not: { field: "voided", equals: true } }));
  return call(customerCookie, "GET", `${records("cart_line")}?filter=${filter}`);
}

describe("同じ品を2行に増やさない(既存語彙だけ。E-G30 / D-V4-72)", () => {
  test("同じ商品を2回入れても、絞り込みを書いた画面には1行しか出ない", async () => {
    const product = await seedProduct();
    const cart = rowOf(await call(customerCookie, "POST", records("cart"), { status: "open" }));
    await addLine(cart._id, product._id, 1);
    await addLine(cart._id, product._id, 2);

    const visible = listOf(await listWithViewFilter());
    expect(visible.filter((row) => row.product === product._id)).toHaveLength(1);
  });

  test("数量は合算される(1 + 2 = 3)。行内金額も合算後の数量で書き直る", async () => {
    const product = await seedProduct();
    const cart = rowOf(await call(customerCookie, "POST", records("cart"), { status: "open" }));
    await addLine(cart._id, product._id, 1);
    await addLine(cart._id, product._id, 2);

    const visible = listOf(await listWithViewFilter());
    const line = visible.find((row) => row.product === product._id);
    expect(line?.quantity).toBe(3);
    expect(line?.line_total).toBe(3600);
  });

  test("【解けない】行は消えていない —— 絞り込みを書かなければ2行とも出る", async () => {
    const product = await seedProduct();
    const cart = rowOf(await call(customerCookie, "POST", records("cart"), { status: "open" }));
    await addLine(cart._id, product._id, 1);
    await addLine(cart._id, product._id, 2);

    const all = listOf(await call(customerCookie, "GET", records("cart_line")));
    expect(all.filter((row) => row.product === product._id)).toHaveLength(2);
    expect(all.filter((row) => row.voided === true)).toHaveLength(1);
  });

  test("違う商品は1行にまとめられない(束ねる鍵は カート × 商品 である)", async () => {
    const first = await seedProduct("SKU-DEDUPE-A");
    const second = await seedProduct("SKU-DEDUPE-B");
    const cart = rowOf(await call(customerCookie, "POST", records("cart"), { status: "open" }));
    await addLine(cart._id, first._id, 1);
    await addLine(cart._id, second._id, 1);

    const visible = listOf(await listWithViewFilter());
    expect(visible).toHaveLength(2);
    expect(visible.every((row) => row.voided !== true)).toBe(true);
  });

  test("3回入れても1行のまま、数量は3回分になる", async () => {
    const product = await seedProduct();
    const cart = rowOf(await call(customerCookie, "POST", records("cart"), { status: "open" }));
    await addLine(cart._id, product._id, 1);
    await addLine(cart._id, product._id, 1);
    await addLine(cart._id, product._id, 1);

    const visible = listOf(await listWithViewFilter());
    expect(visible).toHaveLength(1);
    expect(visible[0]?.quantity).toBe(3);
    const all = listOf(await call(customerCookie, "GET", records("cart_line")));
    expect(all).toHaveLength(3);
    expect(all.filter((row) => row.voided === true)).toHaveLength(2);
  });
});

describe("【完了条件3】一覧の件数表示(`total`)が `filter` の後の値になるかの実測", () => {
  test("`total` は絞り込みの後の件数である(表示行数と食い違わない)", async () => {
    const product = await seedProduct();
    const cart = rowOf(await call(customerCookie, "POST", records("cart"), { status: "open" }));
    await addLine(cart._id, product._id, 1);
    await addLine(cart._id, product._id, 2);

    const filtered = await listWithViewFilter();
    expect(totalOf(filtered)).toBe(1);
    expect(listOf(filtered)).toHaveLength(1);

    // 絞り込みを書かなければ 2 である(= 差が出るのは filter の有無だけであることの裏取り)。
    const unfiltered = await call(customerCookie, "GET", records("cart_line"));
    expect(totalOf(unfiltered)).toBe(2);
  });
});
