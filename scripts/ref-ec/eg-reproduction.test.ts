/**
 * `E-G` の再現可否を参照 EC で固定する検査(`V4-M11` / `D-V4-40`)。
 *
 * ## 本ファイルの立場(誇張しない。憲法6)
 *
 * `docs/plan/v4/02-ec-behavior-baseline.md` §5 の `E-G1`〜`E-G76` は**すべて実地インスタンス
 * `data/apps/ichishioya` の観測**である。`D-V4-40`(ユーザ決定)は「同じ欠落が参照 EC でも
 * 起きるかを76件全部について測る」と定めた。本ファイルは、その実測のうち**本物の SQLite
 * (`mkdtemp`)+ 本物の HTTP(`createServerApp`)で決定論的に固定できる分**を検査にしたものである。
 *
 * - **参照 EC のマニフェスト(`manifest.ts`)と島(`functions.ts`)は1バイトも変えていない。**
 *   本タスクは**測るのが仕事**であって、直すのは `V4-M10` の仕事である。
 * - **各テストは「この症状が参照 EC で起きること」を固定する** —— つまり**赤くならないことが
 *   欠陥の存在を意味する**。直したときにここが赤くなるのは正しい(そのとき書き直す)。
 * - **本ファイルは判定を1つも下さない。** 帰属((A)/(B)/(C))も重大度も書かない。
 * - **実地インスタンス(B)の観測とここ(A)の実測を合算してはならない**(横断論点13)。
 *
 * ## この検査が測っていないもの
 *
 * - **DOM 起因の症状**(切り詰め・alt・件数表示・ページャ・メニューの並び)は、参照ショップ
 *   (`bun run serve:ref-ec`)を chromium で踏んで測った。**本ファイルは HTTP 層だけである。**
 * - `E-G72`(島の入力が全行であること)の**行数を増やしたときの打ち切り**は、3,500 行を投入する
 *   実測であり決定論検査に載せると遅いので、記録側(`records/v4-m11-refec.md`)にだけ置いた。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiCapabilityStore } from "../../src/kernel/ai-capability-store.ts";
import { applyManifest } from "../../src/kernel/apply-manifest.ts";
import { CapabilityStore } from "../../src/kernel/capability-store.ts";
import { createApp } from "../../src/kernel/create-app.ts";
import { ensureIslandRuntimeReady } from "../../src/kernel/island-runner.ts";
import { KernelMetaStore } from "../../src/kernel/meta-store.ts";
import type { Manifest } from "../../src/kernel/types.ts";
import { createServerApp } from "../../src/server/app.ts";
import { TEST_ORIGIN } from "../../src/server/test-helpers.ts";
import { REF_EC_APP_ID, referenceEcManifest } from "./manifest.ts";

const APP_ID = REF_EC_APP_ID;
const OUTBOUND_SECRET_ENV = "ST_EG_REPRO_OUTBOUND_SECRET";

let dataRoot: string;
let store: KernelMetaStore;
let app: ReturnType<typeof createServerApp>;
let ownerCookie: string;
let customerCookie: string;

beforeAll(async () => {
  // 島(QuickJS-WASM)を先にロードする。未ロードだと `run_function` が fail-closed する。
  await ensureIslandRuntimeReady();
});

type Res = { status: number; body: unknown; text: string };

async function call(
  cookie: string | undefined,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Res> {
  const h: Record<string, string> = { origin: TEST_ORIGIN, ...headers };
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

/** 製品のサインアップ経路(HTTP)でアカウントを作り、session cookie を返す。 */
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

type Row = Record<string, unknown> & { _id: string; _updated_at: string };
const rowOf = (res: Res): Row => (res.body as { record: Row }).record;
const listOf = (res: Res): Row[] => (res.body as { records: Row[] }).records;
const totalOf = (res: Res): number => (res.body as { total: number }).total;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-eg-repro-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "参照EC", { app_id: APP_ID });
  const installed = applyManifest(dataRoot, APP_ID, referenceEcManifest());
  if (!installed.valid) {
    throw new Error(`参照 EC マニフェストの投入に失敗: ${JSON.stringify(installed.errors)}`);
  }

  // **人間 owner が発行するもの**を先に用意する(AI は申請しかできない)。
  // これが無いと `wf-order-checkout` の `call_external` が失敗し、注文が1件も作れない
  // —— つまり以下の実測は「守りが効いた」ではなく「配線が足りない」を測ってしまう。
  process.env[OUTBOUND_SECRET_ENV] = "eg-repro-outbound-secret";
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
  // 同じ理由で `wf-order-enrich`(`on_update` の `ai_transform`)の capability も発行しておく。
  // **未発行だと order への PATCH が必ず 400 になる** —— それは書込の守りではなく未配線である。
  const ai = AiCapabilityStore.openForKernel(dataRoot);
  try {
    ai.createCapability({
      appId: APP_ID,
      name: "ai-copywriter",
      provider: "claude_cli",
      model: "claude-opus-4-8",
      limit: { maxCallsPerDay: 100, maxCostUsdPerDay: 1 },
    });
  } finally {
    ai.close();
  }

  app = createServerApp({ dataRoot });
  // **順序が役割を決める**(最初の1人だけが owner)。
  ownerCookie = await register(`/api/apps/${APP_ID}/auth/password/register`, "repro-owner");
  customerCookie = await register(
    `/api/apps/${APP_ID}/auth/signup/password/register`,
    "repro-customer",
  );
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

/** 運営が公開商品を1件作る。 */
async function seedProduct(sku = "SKU-REPRO-1"): Promise<Row> {
  const res = await call(ownerCookie, "POST", records("product"), {
    name: "測定用の商品",
    description: "測定用",
    sku,
    price: 1200,
    stock: 10,
    status: "active",
    st_public: true,
  });
  expect(res.status).toBe(201);
  return rowOf(res);
}

/** 購入者が注文を1件作る。 */
async function seedOrder(orderNumber = "ORD-REPRO-1"): Promise<Row> {
  const res = await call(customerCookie, "POST", records("order"), {
    order_number: orderNumber,
    status: "pending_payment",
    subtotal: 1200,
    discount: 0,
    shipping_fee: 500,
    tax: 120,
    total: 1820,
    payment_status: "unpaid",
    currency: "JPY",
    placed_at: "2026-08-03",
    // **【`V8-M20` / 台帳 `J-G30` / `ADR-0301`】旧の逐語は `st_admin_readable: true,` である。**
    // **`order` からその項目を撤去したので、送ると 400 になる。落としただけである** ——
    // **運営が購入者の注文を読めるのは、今日は `app.roles` の「役割 x 表 x 読取」による。**
  });
  expect(res.status).toBe(201);
  return rowOf(res);
}

describe("店の入口(E-G1 / E-G6)", () => {
  test("E-G1: 未ログインではカートに1行も入れられない(401。ゲスト購入の経路が無い)", async () => {
    const res = await call(undefined, "POST", records("cart_line"), { quantity: 1 });
    expect(res.status).toBe(401);
    expect(res.text).toContain("認証が必要です");
  });

  // **【`V8-M21` / 台帳 `J-G24a` / ユーザ決定 `D-V8-21` による更新。旧文を1バイトも消していない】**
  //
  // **旧テスト名**: 「E-G6: 未認証でアプリ定義が丸ごと読める(島のコード本文と外部宛先を含む)」。
  // **旧の第1引数**: `call(undefined, …)`(= 未認証)。
  //
  // **`D-V8-21`(塞ぐ(ログインを要求))を `V8-M21` が実装したので、未認証は 401 になった。**
  // **`E-G6` が言っていた「丸ごと読める」は、**ログインした買い物客について**は今日も真である**
  // —— **島のコード本文も外部の宛先も、客のセッションで読める。** **下の期待値は1つも
  // 緩めていない**(数も、島の本文の長さも、宛先の2本もそのままである)。
  test("E-G6【半分だけ塞いだ】未認証は 401。ログインした買い物客にはアプリ定義が丸ごと読める(島のコード本文と外部宛先を含む)", async () => {
    expect((await call(undefined, "GET", `/api/apps/${APP_ID}/manifest`)).status).toBe(401);
    const res = await call(customerCookie, "GET", `/api/apps/${APP_ID}/manifest`);
    expect(res.status).toBe(200);
    const manifest = res.body as Manifest;
    // 全13ビュー・全17テーブルの定義がそのまま返る(**V4-M21-T01 で 12 → 13**)。
    // **【`V5-M18` / `D-V5-86`】当時 `13` → 今日 `16`**(会計まわりの3ビューが増えた)。
    // **上の行を1バイトも書き換えていない。** **E-G6 が言っている「丸ごと読める」は
    // 今日も真であり、読める量が増えただけである** —— 会計の入力画面の項目も未認証で読める。
    // **【`V8-M21` の訂正】** **「未認証で読める」は今日は偽である** ——
    // **読めるのは**ログインした買い物客**であり、未ログインには1バイトも渡らない。**
    expect(manifest.app.views.length).toBe(16);
    expect(manifest.app.tables.length).toBe(17);
    // 島の JS 本文が `code` に入ったまま返る。
    const island = manifest.app.functions?.find((fn) => fn.id === "fn-order-totals");
    expect(island?.code.length).toBeGreaterThan(1000);
    // 決済・メールの宛先も返る。
    expect(res.text).toContain("/mock-psp/charges");
    expect(res.text).toContain("/mail/send");
  });
});

describe("入力の検査(E-G30 / E-G36 / E-G37 / E-G38)", () => {
  test("E-G36/E-G38: メール形式も数量の範囲も検査されない(型検査と unique だけ効く)", async () => {
    const bad = await call(customerCookie, "POST", records("customer"), {
      name: "測定用",
      email: "not-an-email",
    });
    expect(bad.status).toBe(201);
    expect(rowOf(bad).email).toBe("not-an-email");

    // unique だけは効く。
    const dup = await call(customerCookie, "POST", records("customer"), {
      name: "測定用2",
      email: "not-an-email",
    });
    expect(dup.status).toBe(400);
    expect(dup.text).toContain("一意(unique)制約");

    // 数量はマイナスでも小数でも通り、島がそのまま金額に流す。
    const product = await seedProduct();
    const cart = rowOf(await call(customerCookie, "POST", records("cart"), { status: "open" }));
    const neg = await call(customerCookie, "POST", records("cart_line"), {
      cart: cart._id,
      product: product._id,
      quantity: -5,
      unit_price: 1200,
    });
    expect(neg.status).toBe(201);
    const after = await call(customerCookie, "GET", `${records("cart_line")}/${rowOf(neg)._id}`);
    expect(rowOf(after).line_total).toBe(-6000);

    // 型検査だけは効く。
    const typed = await call(customerCookie, "POST", records("cart_line"), {
      cart: cart._id,
      product: product._id,
      quantity: "abc",
    });
    expect(typed.status).toBe(400);
  });

  test("E-G37: required の無いテーブルは空のまま1行作れる", async () => {
    const res = await call(customerCookie, "POST", records("address"), {});
    expect(res.status).toBe(201);
    const row = rowOf(res);
    expect(row.postal_code).toBeNull();
    expect(row.prefecture).toBeNull();
    expect(row.line).toBeNull();
  });

  test("E-G30: 同じ商品をもう一度入れても合算されず、同じ行が2本並ぶ", async () => {
    const product = await seedProduct();
    const cart = rowOf(await call(customerCookie, "POST", records("cart"), { status: "open" }));
    for (let i = 0; i < 2; i += 1) {
      const res = await call(customerCookie, "POST", records("cart_line"), {
        cart: cart._id,
        product: product._id,
        quantity: 1,
        unit_price: 1200,
      });
      expect(res.status).toBe(201);
    }
    const lines = listOf(await call(customerCookie, "GET", records("cart_line")));
    expect(lines.filter((l) => l.product === product._id).length).toBe(2);
  });
});

describe("所有者の書込が全開(E-G48 / E-G49 / E-G50 / E-G51 / E-G52)", () => {
  test("E-G48: 購入者が自分の注文の金額と状態を書き換えられる", async () => {
    const order = await seedOrder();
    const res = await call(
      customerCookie,
      "PATCH",
      `${records("order")}/${order._id}`,
      { total: 1, subtotal: 1, status: "paid", payment_status: "paid" },
      { "if-match": order._updated_at },
    );
    expect(res.status).toBe(200);
    expect(rowOf(res).total).toBe(1);
    expect(rowOf(res).status).toBe("paid");
    expect(rowOf(res).payment_status).toBe("paid");
  });

  test("E-G49: 購入者が注文を直接作れる(金額0・発送済みでも通る)", async () => {
    const res = await call(customerCookie, "POST", records("order"), {
      order_number: "ORD-FABRICATED",
      status: "shipped",
      payment_status: "paid",
      subtotal: 0,
      total: 0,
      currency: "JPY",
      placed_at: "2026-08-03",
    });
    expect(res.status).toBe(201);
    expect(rowOf(res).total).toBe(0);
    expect(rowOf(res).status).toBe("shipped");
  });

  test("E-G50/E-G51: 親を消しても子が残り、集計にも消えた注文が残る", async () => {
    const product = await seedProduct();
    const order = await seedOrder();
    const line = rowOf(
      await call(customerCookie, "POST", records("order_line"), {
        order: order._id,
        product: product._id,
        quantity: 1,
        unit_price: 1200,
        line_total: 1200,
      }),
    );
    // 2本目の注文を作ると、その on_create で1本目の明細が order_totals に集計される。
    await seedOrder("ORD-REPRO-2");
    const totalsBefore = listOf(await call(ownerCookie, "GET", records("order_totals")));
    expect(totalsBefore.some((t) => t.order === order._id)).toBe(true);

    const del = await call(
      customerCookie,
      "DELETE",
      `${records("order")}/${order._id}`,
      undefined,
      { "if-match": order._updated_at },
    );
    expect(del.status).toBe(204);

    // 親は消えたが子は残る(孤児)。
    expect((await call(customerCookie, "GET", `${records("order")}/${order._id}`)).status).toBe(
      404,
    );
    const lineAfter = await call(customerCookie, "GET", `${records("order_line")}/${line._id}`);
    expect(lineAfter.status).toBe(200);
    expect(rowOf(lineAfter).order).toBe(order._id);

    // 集計は削除を起点にできないので、消えた注文の行が残り続ける。
    const totalsAfter = listOf(await call(ownerCookie, "GET", records("order_totals")));
    expect(totalsAfter.some((t) => t.order === order._id)).toBe(true);
  });

  test("E-G50 の連鎖: 孤児の明細が残っている間、新しい注文が1件も作れない", async () => {
    const product = await seedProduct();
    const order = await seedOrder();
    await call(customerCookie, "POST", records("order_line"), {
      order: order._id,
      product: product._id,
      quantity: 1,
      unit_price: 1200,
      line_total: 1200,
    });
    await call(customerCookie, "DELETE", `${records("order")}/${order._id}`, undefined, {
      "if-match": order._updated_at,
    });
    // 集計島は孤児の明細から消えた注文の行を出し、その書込が参照整合性で落ちる。
    const blocked = await call(customerCookie, "POST", records("order"), {
      order_number: "ORD-AFTER-ORPHAN",
      status: "pending_payment",
      total: 100,
      currency: "JPY",
      placed_at: "2026-08-03",
    });
    expect(blocked.status).toBe(400);
    expect(blocked.text).toContain("fn-order-totals");
  });

  test("E-G52: 本人は自分の行を消せる(記録が残らない)", async () => {
    const order = await seedOrder();
    const action = rowOf(
      await call(customerCookie, "POST", records("order_action"), {
        order: order._id,
        action_type: "cancel_request",
        reason: "測定用",
        status: "requested",
        requested_at: "2026-08-03",
      }),
    );
    const del = await call(
      customerCookie,
      "DELETE",
      `${records("order_action")}/${action._id}`,
      undefined,
      { "if-match": action._updated_at },
    );
    expect(del.status).toBe(204);
    expect(totalOf(await call(customerCookie, "GET", records("order_action")))).toBe(0);
  });
});

describe("運営の仕事(E-G53 / E-G55 / E-G56)", () => {
  test("E-G53: 運営は購入者の注文を読めるが、1文字も直せない(404 が返る)", async () => {
    const order = await seedOrder();
    // 読める(面の規則 = `owner` x 表 `order` x 読取 があるため。`D-V8-35`)。
    // **旧の逐語**: 「読める(st_admin_readable の宣言があるため)。」
    expect(totalOf(await call(ownerCookie, "GET", records("order")))).toBe(1);
    expect((await call(ownerCookie, "GET", `${records("order")}/${order._id}`)).status).toBe(200);
    // 直せない。しかも文面は「存在しません」である。
    const patch = await call(
      ownerCookie,
      "PATCH",
      `${records("order")}/${order._id}`,
      { status: "paid" },
      { "if-match": order._updated_at },
    );
    expect(patch.status).toBe(404);
    expect(patch.text).toContain("は存在しません");
    const del = await call(ownerCookie, "DELETE", `${records("order")}/${order._id}`, undefined, {
      "if-match": order._updated_at,
    });
    expect(del.status).toBe(404);
  });

  // **【`V8-M20` / 台帳 `J-G30` / `ADR-0301`。検査を1本消した。逐語を残す】**
  // **消したテスト名**: 「E-G54: `st_admin_readable` は書けるが、読取応答からは伏せられる
  // (行の値は判定に使われない)」。
  // **消した理由**: **この検査の主語(予約規約フィールド `st_admin_readable`)そのものが
  // 廃止された。** **測っていたのは「書けるが効かない値」という `ADR-0061` §限界3 の形で
  // あり、その値は今日 `order` に1本も存在しない**(送れば 400 になる)。
  // **面の側に置き直せるものが無い** —— **面の規則は行の値を持たないので、「書けるが効かない
  // 値が応答に出る」という現象が起こらない**(`owner-scope.ts` が `READ_HIDDEN_RESERVED_FIELDS`
  // を空にして撤去したのと同じ理由)。**「効かない」の代わりに測れる事実は、E-G53 が既に
  // 測っている「運営は読めるが直せない」だけである。**

  test("E-G55: 運営は購入者のカート・住所・顧客・明細を1件も見られない", async () => {
    const product = await seedProduct();
    const cart = rowOf(await call(customerCookie, "POST", records("cart"), { status: "open" }));
    await call(customerCookie, "POST", records("cart_line"), {
      cart: cart._id,
      product: product._id,
      quantity: 1,
      unit_price: 1200,
    });
    await call(customerCookie, "POST", records("customer"), { name: "測定用の顧客" });
    await call(customerCookie, "POST", records("address"), { postal_code: "150-0001" });

    for (const table of ["cart", "cart_line", "customer", "address", "order_line"]) {
      expect(totalOf(await call(ownerCookie, "GET", records(table)))).toBe(0);
    }
    // 購入者本人には見える。
    expect(totalOf(await call(customerCookie, "GET", records("cart")))).toBe(1);
  });

  // **【`V8-M37` / 台帳 `F-G3` / ユーザ決定 `D-V8-96`。期待値を入れ替えた。旧を逐語で残す】**
  //
  // **旧のテスト名(逐語)**: 「E-G56: 運営が代理で作った行は、宛先を指定しても運営自身の行になる」
  // **旧の本体(逐語)**:
  //   ```
  //   const made = await call(ownerCookie, "POST", records("order_action"), {
  //     order: order._id,
  //     action_type: "cancel_request",
  //     reason: "運営の代理申込(測定用)",
  //     st_owner: me.user.id,
  //   });
  //   expect(made.status).toBe(201);
  //   expect(rowOf(made).st_owner).not.toBe(me.user.id);
  //   ```
  //
  // **測っている事実(運営は代理で他人の行を作れない)は1ミリも変わっていない** ——
  // **変わったのは断り方だけである**(黙って自分名義に化ける → **403 で断る**)。
  // **`F-G3` はその「黙って」を消した単位である。**
  test("E-G56: 運営が代理で作ろうとすると 403(旧: 黙って運営自身の行になる)", async () => {
    const me = (await call(customerCookie, "GET", `/api/apps/${APP_ID}/auth/me`)).body as {
      user: { id: string };
    };
    const order = await seedOrder();
    const spoofed = await call(ownerCookie, "POST", records("order_action"), {
      order: order._id,
      action_type: "cancel_request",
      reason: "運営の代理申込(測定用)",
      st_owner: me.user.id,
    });
    expect(spoofed.status).toBe(403);
    // **宛先を書かなければ今日どおり作れる**(閉じすぎていない)。**作られるのは運営自身の行。**
    const made = await call(ownerCookie, "POST", records("order_action"), {
      order: order._id,
      action_type: "cancel_request",
      reason: "運営の代理申込(測定用)",
    });
    expect(made.status).toBe(201);
    expect(rowOf(made).st_owner).not.toBe(me.user.id);
    // あとから宛先へ付け替えることもできない。
    const patch = await call(
      ownerCookie,
      "PATCH",
      `${records("order_action")}/${rowOf(made)._id}`,
      { st_owner: me.user.id },
      { "if-match": rowOf(made)._updated_at },
    );
    expect(patch.status).toBe(403);
    // 購入者からは1件も見えない。
    expect(totalOf(await call(customerCookie, "GET", records("order_action")))).toBe(0);
  });
});

describe("会員・アカウント(E-G65 / E-G66 / E-G68)", () => {
  test("E-G65: 登録しただけでは顧客の行が1件も無い", async () => {
    expect(totalOf(await call(customerCookie, "GET", records("customer")))).toBe(0);
    expect(totalOf(await call(customerCookie, "GET", records("cart")))).toBe(0);
  });

  test("E-G66: 1つのアカウントで顧客の行を何枚でも作れる", async () => {
    for (const email of ["a@example.test", "b@example.test", "c@example.test"]) {
      const res = await call(customerCookie, "POST", records("customer"), {
        name: `測定用 ${email}`,
        email,
      });
      expect(res.status).toBe(201);
    }
    expect(totalOf(await call(customerCookie, "GET", records("customer")))).toBe(3);
  });

  test("E-G68: パスワードの再設定と『お忘れの方』の経路は1本も無い(変更と退会は在る)", async () => {
    // 変更の経路は在る(本文が足りないので 400 が返る = ルート自体は実在する)。
    const change = await call(
      customerCookie,
      "POST",
      `/api/apps/${APP_ID}/auth/password/change`,
      {},
    );
    expect(change.status).toBe(400);
    // 再設定・忘れたときの経路は無い。
    for (const path of ["password/reset", "password/forgot"]) {
      const res = await call(customerCookie, "POST", `/api/apps/${APP_ID}/auth/${path}`, {});
      expect(res.status).toBe(404);
    }
  });
});

describe("並び順の語彙(E-G71)", () => {
  test("E-G71: `sort` にシステム列(`_created_at`)を書いたマニフェストは適用できない", async () => {
    // **`manifest.ts` は変えない** —— 返ってきたオブジェクトの複製に書き足して適用を試すだけである。
    const base = referenceEcManifest();
    const patched: Manifest = JSON.parse(JSON.stringify(base)) as Manifest;
    const view = patched.app.views.find((v) => v.id === "order-list");
    if (view === undefined || view.type !== "list_view") {
      throw new Error("order-list が見つかりません");
    }
    (view as { sort?: unknown }).sort = [{ field: "_created_at", order: "desc" }];
    const other = await mkdtemp(join(tmpdir(), "gp-eg-sort-"));
    const s = KernelMetaStore.open(other);
    try {
      createApp(s, "参照EC", { app_id: APP_ID });
      const applied = applyManifest(other, APP_ID, patched);
      expect(applied.valid).toBe(false);
    } finally {
      s.close();
      await rm(other, { recursive: true, force: true });
    }
  });
});
