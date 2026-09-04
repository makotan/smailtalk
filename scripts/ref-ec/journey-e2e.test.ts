/**
 * 参照 EC 全ジャーニー E2E(V2-M7-T03 / CP-V2 受け入れゲートの中核)。
 *
 * **本物の SQLite(mkdtemp)・本物の HTTP プラットフォームサーバ(createServerApp を 127.0.0.1 に
 * Bun.serve)・本物のモック PSP プロセス(127.0.0.1 に Bun.serve)・本物の署名付き HTTP Webhook**で、
 * T01 の**参照 EC 全マニフェスト**(`referenceEcManifest()`)と T02 の**周辺計算の島**を土台に、
 * 顧客ジャーニー全体(匿名閲覧 → 顧客サインアップ → カート → 周辺計算 → チェックアウト → 決済モック →
 * 署名 Webhook 受信 → 注文状態更新 → 確認メール → 在庫反映)を一連で通す。M5 の
 * `scripts/mock-psp/payment-flow-e2e.test.ts`(決済コア4経路の雛形)を、部分モデル `ecManifest()` から
 * **参照 EC のフルモデル**へ引き上げ、決済コアの前段に「匿名閲覧 + サインアップ + カート + 周辺計算」を
 * 積み増したものである。**カーネル語彙は1つも足していない**(下の「語彙不可侵」)。
 *
 * ## 9段ジャーニー(各段を証明する実機構)
 *  (0) 匿名閲覧(EC-G1): 未認証 GET が公開商品(st_public)だけ返し、運営テーブル(order)は 401。
 *  (1) 顧客サインアップ + ログイン(EC-G2): 本物の customer 登録経路で session を得る。cart/order は
 *      st_owner で本人スコープ。運営テーブル(coupon)は 403。
 *  (2) カートに入れる(EC-G14): customer session で cart + cart_line を HTTP 経由で作る。cart_line の
 *      on_create で fn-line-total(Route B / write_back:$record)が line_total を行へ書き戻す。
 *  (3) 周辺計算(T02): fn-cart-totals(集計・output_table 全置換)が小計/割引/送料(free_over 分岐)/
 *      税/合計を cart_totals へ書く。concrete な整数で固定する。
 *  (4) チェックアウト(EC-G7): 相1で order を create(status=pending_payment)、相2で
 *      [order_line ×N + product.stock CAS 減算 ×M] を**1原子バッチ**(writeRecords・if_match CAS)で。
 *  (5) order on_create WF(wf-order-checkout)の call_external が決済要求を outbox に積む → dispatchOutbox
 *      → モック PSP `POST /mock-psp/charges` 受理(202)。
 *  (6) モック PSP が署名付き Webhook を受信口 `POST /inbound/:endpoint_id` へ実 HTTP POST → 署名検証
 *      (実行層)→ payment_events に1行 create(EC-G4)。
 *  (7) payment_events on_create(wf-payment-received)の when(EC-G5)+ target `$record.order`(EC-G13)で
 *      対応 order を paid/failed に更新。
 *  (8) paid なら確認メール(EC-G15)を call_external で mail-gateway 宛に outbox へ積む(新語彙ゼロ)。
 *  (9) 在庫は (4) の CAS 減算で反映済み(売り越し防止 EC-G6/G7)。
 *
 * ## 4経路(M5 Path A〜D を参照 EC フルモデルで再現・拡張)
 *  A success  … 注文 paid・確認メール1通・在庫減算。
 *  B failure  … 注文 failed・確認メールなし・在庫は戻さない。
 *  C timeout  … Webhook 来ず注文 pending_payment のまま・在庫は戻さない(欠落非補償 D-G4a)。
 *  D 冪等     … 同一 event_id の Webhook 再到達を unique(EC-G8)で吸収・payment_events は1行のまま。
 *
 * ## この E2E が「やっていない/できない」正直な限界(憲法6。実際にこのテストが触れるものだけ列挙する)
 *  - **timeout で注文が pending_payment のまま残る**(D-G4a。ポーリング照会・リトライ・補償は入れない。Path C)。
 *  - **failure/timeout で在庫を戻さない**(D-G4a の系。在庫は (4) の予約で減ったまま。Path B/C)。
 *  - **2相チェックアウト**(M4 §限界7): 親 order と子 order_line を1バッチで原子生成できない
 *    (order._id は createRecord 内で採番されるため)。相1で order・相2で [明細 + 在庫] を原子化する。
 *  - **注文ごとのクーポン適用ができない**(T02 の ★): 集計島は1テーブルの全行しか入力に取れず
 *    coupon/shipping/tax テーブルを join できない。価格設定は島に**店舗共通の定数**として焼き込むしかなく、
 *    既定はクーポン null(送料・税だけ)。本ジャーニーの discount は常に 0 で、注文別クーポン引きは成立しない。
 *  - **行内計算列にならない**(T02): 小計/合計は Σ を自動更新する手段が無く、集計専用テーブル
 *    (cart_totals/order_totals)へ別置きになる。
 *  - **cart_line.unit_price は「商品からの自動コピー」ができない**: フォーム経路(cart-line-form)は
 *    [cart, product, quantity] しか持たず、product.price を cart_line.unit_price へ写す機構が語彙に無い。
 *    本テストはチェックアウト時にアプリ側が単価を焼き付ける(POST body で unit_price を渡す)ことで代替する。
 *  - **通貨精度・単位なし**(EC-G9 却下維持): JPY 整数のみ。税は Math.floor で決定論的に丸める。
 *  - **結果整合**(配送・受信とも「必ず/順序どおり/一度だけ」の保証なし。重複だけ unique で吸収)。
 *  - **マルチテナント非分離**(1アプリ = 1店舗 = 自己ホスト前提)。
 *  - **on_update ai_transform(wf-order-enrich)はライブ AI capability を要する**ため、この決定論 E2E
 *    からは apply_diff の remove_workflow で外す(マニフェスト上の valid は T01 が担保済み)。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff } from "../../src/kernel/apply-diff.ts";
import { applyManifest } from "../../src/kernel/apply-manifest.ts";
import { type BatchOp, writeRecords } from "../../src/kernel/batch.ts";
import { CapabilityStore } from "../../src/kernel/capability-store.ts";
import { createApp } from "../../src/kernel/create-app.ts";
import { InboundStore } from "../../src/kernel/inbound-store.ts";
import { ensureIslandRuntimeReady } from "../../src/kernel/island-runner.ts";
import { KernelMetaStore } from "../../src/kernel/meta-store.ts";
import { dispatchOutbox } from "../../src/kernel/outbox-dispatcher.ts";
import { createRecord, listRecords, type RecordRow } from "../../src/kernel/records.ts";
import { appDbPath, appManifestPath } from "../../src/kernel/storage-paths.ts";
// 【`V5-M29-T06` / メインの裁定1】**`FIELD_TYPES` と `RESOURCE_KINDS` の値 import を消した。**
//   `V5-M29-T05` は「消すと `scripts/kernel-import-snapshot.txt` の行が減り、それを sha で
//   固定している `scripts/industry-neutral-examples.test.ts`(`ADR-0163` 限定3)が赤くなる」
//   ことを理由に残し、`TS6133` と `noUnusedImports` を残した。**メインは消す側を採った。**
//   スナップショットからは本ファイルの2行を含む計9行を消し、
//   `industry-neutral-examples.test.ts` の基準値は同ファイルの作法(旧値を消さずコメントに
//   残す)どおり更新した。**`DIFF_OPS` は同ファイル内で今日も使われているので残っている。**
import { DIFF_OPS, type Manifest } from "../../src/kernel/types.ts";
import { createServerApp } from "../../src/server/app.ts";
import { OWNER_FIELD, PUBLIC_FIELD } from "../../src/server/owner-scope.ts";
import { TEST_ORIGIN } from "../../src/server/test-helpers.ts";
import { type MockOutcome, MockPsp, type MockPspServerHandle } from "../mock-psp/harness.ts";
import { REF_EC_APP_ID, referenceEcManifest } from "./manifest.ts";

const APP_ID = REF_EC_APP_ID;
const INBOUND_KEY_ENV = "ST_JOURNEY_INBOUND_KEY";
const OUTBOUND_SECRET_ENV = "ST_JOURNEY_OUTBOUND_SECRET";
const SIGNING_KEY = "journey-e2e-shared-signing-key-xyz";

// 商品カタログ(店舗共通の既定価格設定 = 送料500・無料5000・税10% は manifest.ts に焼き込み済み)。
const PRICE_A = 1800; // 商品A 単価
const PRICE_B = 800; // 商品B 単価
const QTY_A = 2;
const QTY_B = 1;
const STOCK_A = 5;
const STOCK_B = 3;
// 期待する周辺計算(既定価格設定)。subtotal=1800×2+800×1=4400 → 4400<5000 なので送料500・税 floor(440)=440。
const EXPECT_SUBTOTAL = PRICE_A * QTY_A + PRICE_B * QTY_B; // 4400
const EXPECT_DISCOUNT = 0; // ★注文別クーポン引きは成立しない(既定 coupon=null)
const EXPECT_SHIPPING = 500; // 4400 < free_over(5000)
const EXPECT_TAX = Math.floor(EXPECT_SUBTOTAL * 0.1); // 440
const EXPECT_TOTAL = EXPECT_SUBTOTAL - EXPECT_DISCOUNT + EXPECT_SHIPPING + EXPECT_TAX; // 5340

beforeAll(async () => {
  // fn-line-total / fn-cart-totals / fn-order-totals は QuickJS-WASM 島。未ロードだと同期実行が
  // fail-closed するので先にロードする(functions.test.ts と同じ作法)。
  await ensureIslandRuntimeReady();
});

let dataRoot: string;
let store: KernelMetaStore;
let app: ReturnType<typeof createServerApp>;
let mockPsp: MockPsp;
let mockServer: MockPspServerHandle;
let platformServer: ReturnType<typeof Bun.serve>;
let endpointId: string;
let mockChargesUrl: string;
let inboundUrl: string;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-journey-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "参照EC", { app_id: APP_ID });

  // T01 の参照 EC 全マニフェストをそのまま投入する(部分モデルではなくフルモデル)。
  const installed = applyManifest(dataRoot, APP_ID, referenceEcManifest());
  if (!installed.valid) {
    throw new Error(`参照 EC マニフェストの投入に失敗: ${JSON.stringify(installed.errors)}`);
  }

  // 署名検証鍵(受信口)と送信 secret(接続)は非保管 —— 取得元(env)だけを渡す。
  process.env[INBOUND_KEY_ENV] = SIGNING_KEY;
  process.env[OUTBOUND_SECRET_ENV] = "journey-outbound-bearer-secret";

  // 人間 owner が inbound endpoint を発行する(payment_events へ1行 create するだけの受信口)。
  const inbound = InboundStore.openForKernel(dataRoot);
  try {
    endpointId = inbound.issueInboundEndpoint({
      appId: APP_ID,
      name: "mock-psp-webhook",
      secretSource: { kind: "env", value: INBOUND_KEY_ENV },
      targetTable: "payment_events",
    }).id;
  } finally {
    inbound.close();
  }

  // 人間 owner が接続を発行する(送信 = 決済要求 / 確認メール。AI は申請だけ)。
  const cap = CapabilityStore.openForKernel(dataRoot);
  try {
    cap.createConnection({
      appId: APP_ID,
      name: "mock-psp",
      allowedHosts: ["127.0.0.1"],
      secretSource: { kind: "env", value: OUTBOUND_SECRET_ENV },
    });
    cap.createConnection({
      appId: APP_ID,
      name: "mail-gateway",
      allowedHosts: ["127.0.0.1"],
      secretSource: { kind: "env", value: OUTBOUND_SECRET_ENV },
    });
  } finally {
    cap.close();
  }

  // プラットフォームと HTTP アプリを 1 つ作り、`app.request`(前段の閲覧/サインアップ/カート)と
  // Bun.serve のループバック(モック PSP → 受信口の実 HTTP Webhook)の両方に同じ fetch を使う。
  app = createServerApp({ dataRoot });
  // **【`V8-M30` 第2波(2026-08-11)。ユーザ決定 `D-V8-82`。題材だけを直した】**
  // **旧(逐語)**: この直後の登録は無く、各検査の顧客サインアップがこのアプリの
  // **最初の1人**だった。
  // **`D-V8-82` により、自己登録でも最初の1人は持ち主になる**(選ばれた説明文の逐語
  // 「**公開の購入サイトでは、最初に買った客が運営者になってしまいます。**」)——
  // **参照 EC の主題(顧客ロールの分離・全ジャーニー)を測るには、先に運営者を1人
  // 置いて初回の席を埋める必要がある。** **測っている中身は1ミリも変えていない。**
  // **最初の1人が持ち主になること自体は `src/server/first-user-owner.test.ts` が測る。**
  {
    const seeded = await app.request(
      new Request(`http://localhost/api/apps/${APP_ID}/auth/password/register`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: TEST_ORIGIN },
        body: JSON.stringify({ username: "ref-ec-owner", password: "pw-123456" }),
      }),
    );
    if (seeded.status !== 200) {
      throw new Error(`運営者の初期登録に失敗: ${await seeded.text()}`);
    }
  }
  platformServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  inboundUrl = `http://127.0.0.1:${platformServer.port}/inbound/${endpointId}`;

  // モック PSP を 127.0.0.1 に立てる(共有シークレット = 受信口の署名検証鍵と同値)。
  mockPsp = new MockPsp({ sharedSecret: SIGNING_KEY });
  mockServer = mockPsp.listen();
  mockChargesUrl = mockServer.chargesUrl;

  // ジャーニー用の apply_diff(実経路)。**テスト制御フィールドと配線をここに閉じる**
  // (共有マニフェスト manifest.ts には焼き込まない):
  //  (i)   order にモック制御フィールド(mock_outcome / mock_delay_ms / callback_url)を足す
  //        —— これらは実 EC の注文モデルではなく、決定論モックへ $record 経由で値を渡すためのテスト制御。
  //  (ii)  wf-order-checkout の call_external を実モック PSP URL・full payload に差し替える
  //        (manifest.ts のプレースホルダ destination `http://127.0.0.1/mock-psp/charges` はポート未確定)。
  //  (iii) cart_line on_create で fn-cart-totals を走らせる配線を足す(参照 EC の fn-cart-totals を
  //        カートの実挙動で発火させる。manifest.ts では schedule 掃引のみに配線されている)。
  //  (iv)  on_update ai_transform(wf-order-enrich)を外す(ライブ AI capability 依存。決定論 E2E 対象外)。
  const wired = applyDiff(dataRoot, APP_ID, {
    diff_id: "d-journey-wiring",
    intent: "ジャーニー E2E の決済配線とカート合計配線を実経路で入れる",
    operations: [
      {
        op: "add_field",
        table: "order",
        field: { id: "mock_outcome", name: "モック結果", type: "text" },
      },
      {
        op: "add_field",
        table: "order",
        field: { id: "mock_delay_ms", name: "モック遅延", type: "number" },
      },
      {
        op: "add_field",
        table: "order",
        field: { id: "callback_url", name: "Webhook返し先", type: "text" },
      },
      {
        op: "update_workflow",
        workflow: {
          id: "wf-order-checkout",
          name: "注文確定で決済要求を送り合計を集計",
          trigger: { type: "on_create", table: "order" },
          actions: [
            {
              action: "call_external",
              connection: "mock-psp",
              destination: mockChargesUrl,
              payload: {
                order_id: "$record._id",
                amount: "$record.total",
                currency: "$record.currency",
                idempotency_key: "$record._id",
                callback_url: "$record.callback_url",
                mock_outcome: "$record.mock_outcome",
                mock_delay_ms: "$record.mock_delay_ms",
              },
            },
            // 注文合計の集計(order_line 全行 → order_totals 全置換)。注文 create 時点では明細ゼロなので
            // この段では空だが、参照 EC のワークフロー構造をそのまま保つ(誇張しないための忠実さ)。
            { action: "run_function", function: "fn-order-totals", output_table: "order_totals" },
          ],
          history_table: "wf_runs",
        },
      },
      {
        op: "add_workflow",
        workflow: {
          id: "wf-cart-totals-journey",
          name: "カート明細追加でカート合計を集計",
          trigger: { type: "on_create", table: "cart_line" },
          actions: [
            { action: "run_function", function: "fn-cart-totals", output_table: "cart_totals" },
          ],
          history_table: "wf_runs",
        },
      },
      { op: "remove_workflow", workflow: { id: "wf-order-enrich" } },
    ],
  });
  if (!wired.valid) {
    throw new Error(`ジャーニー配線の apply_diff に失敗: ${JSON.stringify(wired.errors)}`);
  }
});

afterEach(async () => {
  mockServer.stop();
  platformServer.stop(true);
  store.close();
  delete process.env[INBOUND_KEY_ENV];
  delete process.env[OUTBOUND_SECRET_ENV];
  await rm(dataRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 補助(M5 payment-flow-e2e と同型。ディスクの manifest が唯一の権威)
// ---------------------------------------------------------------------------

/** 適用済みワークフロー・追加フィールドを含むディスクの manifest.json を読む。 */
function readManifest(): Manifest {
  return JSON.parse(readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8")) as Manifest;
}

/** アプリ DB を開いて処理し、必ず閉じる。 */
function withDb<T>(fn: (db: Database, manifest: Manifest) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return fn(db, readManifest());
  } finally {
    db.close();
  }
}

function rowsOf(db: Database, m: Manifest, table: string): RecordRow[] {
  const r = listRecords(db, m, table);
  if (!r.ok) {
    throw new Error(`一覧に失敗: ${JSON.stringify(r.errors)}`);
  }
  return r.value;
}

function ordersById(id: string): RecordRow | undefined {
  return withDb((db, m) => rowsOf(db, m, "order").find((r) => r._id === id));
}

/** kernel.sqlite の outbox の pending を読む(確認メールが積まれたかの検査)。 */
function pendingOutbox() {
  const cap = CapabilityStore.openForKernel(dataRoot);
  try {
    return cap.listPendingOutbox();
  } finally {
    cap.close();
  }
}

/** HTTP リクエストの薄いラッパ(cookie / body 任意)。 */
function request(
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.cookie !== undefined) {
    headers.cookie = opts.cookie;
  }
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers.origin = TEST_ORIGIN;
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  return Promise.resolve(app.request(new Request(`http://localhost${path}`, init)));
}

const R = (table: string, id?: string) =>
  `/api/apps/${APP_ID}/tables/${table}/records${id === undefined ? "" : `/${id}`}`;

/** (1) 本物の顧客サインアップ経路で登録し、st_session cookie を返す(role=customer 固定)。 */
async function customerSignup(username: string): Promise<string> {
  const res = await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/auth/signup/password/register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: TEST_ORIGIN },
      body: JSON.stringify({ username, password: "pw-123456" }),
    }),
  );
  expect(res.status, `signup ${username}: ${await res.clone().text()}`).toBe(200);
  expect(((await res.json()) as { user: { role: string } }).user.role).toBe("customer");
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const [k, v] = (pair ?? "").split("=");
    if (k === "st_session") {
      return `st_session=${v}`;
    }
  }
  throw new Error("st_session cookie が発行されなかった");
}

/**
 * カタログを用意する(公開商品2件)。**CAS 用に _id / _updated_at 付きの行が要る**ので kernel の
 * 書込経路で作る(owner の HTTP 経由 create は T01 が別途実証済み。ここでは行版を得るのが目的)。
 * st_public=true なので (0) の匿名閲覧でも見える。
 */
function seedCatalog(): { productA: RecordRow; productB: RecordRow } {
  return withDb((db, m) => {
    const a = createRecord(db, m, "product", {
      name: "公開シャツ",
      price: PRICE_A,
      stock: STOCK_A,
      [PUBLIC_FIELD]: true,
    });
    const b = createRecord(db, m, "product", {
      name: "公開マグ",
      price: PRICE_B,
      stock: STOCK_B,
      [PUBLIC_FIELD]: true,
    });
    if (!a.ok || !b.ok) {
      throw new Error("商品作成に失敗");
    }
    return { productA: a.value, productB: b.value };
  });
}

/**
 * (2)(3) 顧客がカートを作り明細2件を HTTP 経由で入れる。cart_line on_create で
 * fn-line-total(Route B)が line_total を書き、fn-cart-totals(集計)が cart_totals を全置換する。
 * @returns 顧客 cookie・顧客 userId(cart の st_owner)・cart id・cart_totals の1行。
 */
async function signupAndFillCart(
  username: string,
  products: { productA: RecordRow; productB: RecordRow },
): Promise<{
  cookie: string;
  customerUserId: string;
  cartId: string;
  cartTotals: RecordRow;
}> {
  const cookie = await customerSignup(username);

  // カート作成(st_owner は customer id にスタンプされる = EC-G2 スコープ)。
  const cartRes = await request("POST", R("cart"), { cookie, body: { status: "open" } });
  expect(cartRes.status, `cart create: ${await cartRes.clone().text()}`).toBe(201);
  const cartRec = ((await cartRes.json()) as { record: RecordRow }).record;
  const cartId = cartRec._id;
  const customerUserId = String(cartRec[OWNER_FIELD]);

  // 明細2件を追加(EC-G14 カートに入れる)。unit_price はアプリ側で焼き付ける(★商品からの自動コピー
  // 機構は無いので POST body で渡す)。cart-line-form が持つ [cart, product, quantity] + unit_price。
  const add = async (product: RecordRow, quantity: number, unitPrice: number) => {
    const res = await request("POST", R("cart_line"), {
      cookie,
      body: { cart: cartId, product: product._id, quantity, unit_price: unitPrice },
    });
    expect(res.status, `cart_line create: ${await res.clone().text()}`).toBe(201);
  };
  await add(products.productA, QTY_A, PRICE_A);
  await add(products.productB, QTY_B, PRICE_B);

  // cart_totals は集計 function が全置換で書いた1行(この cart のグループ)。
  const totals = withDb((db, m) => rowsOf(db, m, "cart_totals").filter((r) => r.cart === cartId));
  if (totals.length !== 1) {
    throw new Error(`cart_totals が1行になりませんでした: ${JSON.stringify(totals)}`);
  }
  return { cookie, customerUserId, cartId, cartTotals: totals[0] as RecordRow };
}

/**
 * (4)〜(9) チェックアウト + 決済フロー(送信 → モック PSP → 署名 Webhook → 受信 → 注文更新 → 確認メール)。
 * `outcome` で3経路(success/failure/timeout)を切り替える。**在庫は相2の予約 CAS で減らす。**
 * order.total には周辺計算(cart_totals)の合計を焼き付ける(アプリ側スナップショット)。
 */
async function checkoutAndPay(
  customerUserId: string,
  products: { productA: RecordRow; productB: RecordRow },
  cartTotals: RecordRow,
  outcome: MockOutcome,
): Promise<{ orderId: string }> {
  // (4) 相1: order を create(status=pending_payment)。**createRecord が on_create を発火** →
  //     wf-order-checkout の call_external が決済要求を outbox に積む(§5)/ wf-order-audit が監査行。
  const order = withDb((db, m) => {
    const r = createRecord(db, m, "order", {
      status: "pending_payment",
      payment_status: "unpaid",
      currency: "JPY",
      subtotal: Number(cartTotals.subtotal),
      discount: Number(cartTotals.discount),
      shipping_fee: Number(cartTotals.shipping_fee),
      tax: Number(cartTotals.tax),
      total: Number(cartTotals.total),
      mock_outcome: outcome,
      mock_delay_ms: 0,
      callback_url: inboundUrl,
      [OWNER_FIELD]: customerUserId,
    });
    if (!r.ok) throw new Error(`注文作成に失敗: ${JSON.stringify(r.errors)}`);
    return r.value;
  });

  // (4) 相2: 明細 ×2 + 在庫 CAS 減算 ×2 を**1原子バッチ**で(EC-G7・売り越し防止)。
  const checkoutBatch: BatchOp[] = [
    {
      op: "create",
      table: "order_line",
      values: {
        order: order._id,
        product: products.productA._id,
        quantity: QTY_A,
        unit_price: PRICE_A,
        line_total: PRICE_A * QTY_A,
        [OWNER_FIELD]: customerUserId,
      },
    },
    {
      op: "create",
      table: "order_line",
      values: {
        order: order._id,
        product: products.productB._id,
        quantity: QTY_B,
        unit_price: PRICE_B,
        line_total: PRICE_B * QTY_B,
        [OWNER_FIELD]: customerUserId,
      },
    },
    {
      op: "update",
      table: "product",
      target: products.productA._id,
      values: { stock: STOCK_A - QTY_A },
      if_match: products.productA._updated_at,
    },
    {
      op: "update",
      table: "product",
      target: products.productB._id,
      values: { stock: STOCK_B - QTY_B },
      if_match: products.productB._updated_at,
    },
  ];
  const reserved = withDb((db, m) => writeRecords(db, m, checkoutBatch));
  if (!reserved.ok) {
    throw new Error(`在庫予約バッチに失敗: ${JSON.stringify(reserved)}`);
  }

  // (5) dispatchOutbox → モック PSP へ実 HTTP で決済要求を送る(202)。
  const dispatched = await dispatchOutbox(dataRoot);
  expect(dispatched.sent).toBe(1);

  // (6)(7)(8) モック PSP が署名付き Webhook を受信口へ実 HTTP で POST → 受信 → 注文更新 → 確認メールまで走る。
  //     **Webhook が着地するまで待つ**(timeout は着地しない = drain 即完了)。
  await mockPsp.drain();

  return { orderId: order._id };
}

// ===========================================================================
// Path A: success —— 全9段ジャーニーの通し(匿名閲覧〜在庫反映)を1本で narrate する
// ===========================================================================

describe("Path A success: 匿名閲覧→サインアップ→カート→周辺計算→チェックアウト→決済→Webhook→注文paid→確認メール→在庫", () => {
  test("参照EC全モデル・本物SQLite・本物HTTP・本物モックPSP・署名Webhookで9段が一連で通る", async () => {
    const products = seedCatalog();

    // (0) 匿名閲覧(EC-G1): 未認証 GET は公開商品だけ返し、予約フィールドは伏せる。運営テーブルは 401。
    const browse = await request("GET", R("product"));
    expect(browse.status).toBe(200);
    const catalog = (await browse.json()) as { records: Record<string, unknown>[] };
    expect(catalog.records).toHaveLength(2);
    expect(catalog.records[0]).not.toHaveProperty(PUBLIC_FIELD);
    expect((await request("GET", R("order"))).status).toBe(401); // 運営テーブルは匿名遮断

    // (1)(2)(3) サインアップ → カート → 周辺計算。
    const { cookie, customerUserId, cartId, cartTotals } = await signupAndFillCart(
      `cust-A-${Math.random().toString(36).slice(2)}`,
      products,
    );

    // (1) 顧客スコープ(EC-G2): 自分の cart 1件だけ見える・運営テーブル(coupon)は 403。
    const myCarts = await request("GET", R("cart"), { cookie });
    expect(
      ((await myCarts.json()) as { records: { _id: string }[] }).records.map((r) => r._id),
    ).toEqual([cartId]);
    // **【`V8-M27-T04` / `T-G5`。期待値を反転させた。旧の期待値を逐語で残す】**
    // **旧(逐語)**: `expect((await request("GET", R("coupon"), { cookie })).status).toBe(403);`
    // **根拠**: **`V8-M27` / 台帳 `T-G5` / ユーザ決定 `D-V8-38`。**
    // **読取は今日 403 で断らない**(`ADR-0305` 限定11)—— **200 で、行が0件になる。**
    // **上の1行の説明(「運営テーブル(coupon)は 403」)は旧のものである。1バイトも消していない。**
    {
      const coupons = await request("GET", R("coupon"), { cookie });
      expect(coupons.status).toBe(200);
      expect(((await coupons.json()) as { records: unknown[] }).records).toEqual([]);
    }

    // (2) Route B(EC-G6): cart_line の line_total が単価×数量で書き戻っている(3600 / 800)。
    const lines = withDb((db, m) => rowsOf(db, m, "cart_line").filter((r) => r.cart === cartId));
    expect(lines.map((r) => r.line_total).sort((a, b) => Number(a) - Number(b))).toEqual([
      800, 3600,
    ]);

    // (3) 周辺計算(T02): cart_totals に concrete な整数が入る(★discount は 0 = 注文別クーポン不成立)。
    expect({
      subtotal: Number(cartTotals.subtotal),
      discount: Number(cartTotals.discount),
      shipping_fee: Number(cartTotals.shipping_fee),
      tax: Number(cartTotals.tax),
      total: Number(cartTotals.total),
    }).toEqual({
      subtotal: EXPECT_SUBTOTAL, // 4400
      discount: EXPECT_DISCOUNT, // 0
      shipping_fee: EXPECT_SHIPPING, // 500(4400 < 5000)
      tax: EXPECT_TAX, // 440
      total: EXPECT_TOTAL, // 5340
    });

    // (4)〜(8) チェックアウト → 決済 → Webhook → 注文更新 → 確認メール。
    const { orderId } = await checkoutAndPay(customerUserId, products, cartTotals, "success");

    // (4) 相1で order が存在し合計が焼き付いている・相2で明細2件が書けている。
    const order = ordersById(orderId);
    expect(order?.total).toBe(EXPECT_TOTAL);
    const orderLines = withDb((db, m) =>
      rowsOf(db, m, "order_line").filter((r) => r.order === orderId),
    );
    expect(orderLines).toHaveLength(2);
    // wf-order-audit(create_record アクション)が監査行を残している。
    const events = withDb((db, m) =>
      rowsOf(db, m, "order_events").filter((r) => r.order === orderId),
    );
    expect(events.map((e) => e.event)).toEqual(["created"]);

    // (6) 受信テーブルに1行 create(署名検証を通過して着地)・対象 order を指す。
    const payEvents = withDb((db, m) => rowsOf(db, m, "payment_events"));
    expect(payEvents).toHaveLength(1);
    expect(payEvents[0]?.status).toBe("paid");
    expect(payEvents[0]?.order).toBe(orderId);
    expect(payEvents[0]?.amount).toBe(EXPECT_TOTAL);

    // (7) when(EC-G5)+ target(EC-G13)で order が paid に更新されている。
    expect(order?.status).toBe("paid");
    expect(order?.payment_status).toBe("paid");

    // (8) 確認メール(EC-G15)が call_external で outbox に積まれている(mail-gateway 宛。新語彙ゼロ)。
    const mail = pendingOutbox().filter((p) => p.destination === "http://127.0.0.1/mail/send");
    expect(mail).toHaveLength(1);
    expect(mail[0]?.payload).toEqual({ order: orderId, amount: EXPECT_TOTAL });

    // (9) 在庫は相2の CAS で減っている(A: 5-2=3 / B: 3-1=2。売り越し防止)。
    const stocks = withDb((db, m) => {
      const byId = new Map(rowsOf(db, m, "product").map((r) => [r._id, r.stock]));
      return { a: byId.get(products.productA._id), b: byId.get(products.productB._id) };
    });
    expect(stocks).toEqual({ a: STOCK_A - QTY_A, b: STOCK_B - QTY_B });

    // モック PSP の証跡: 決済要求1件・署名付き Webhook 1本を配送(受信口が 201 で受理・sha256= 署名)。
    expect(mockPsp.ledger.charges).toHaveLength(1);
    expect(mockPsp.ledger.deliveries).toHaveLength(1);
    expect(mockPsp.ledger.deliveries[0]?.deliveredStatus).toBe(201);
    expect(mockPsp.ledger.deliveries[0]?.signatureHeader.startsWith("sha256=")).toBe(true);
  });
});

// ===========================================================================
// Path B: failure —— 注文 failed → 確認メールなし → 在庫は戻さない(D-G4a の系)
// ===========================================================================

describe("Path B failure: 決済失敗 → 注文 failed → メールなし → 在庫は戻さない", () => {
  test("失敗 Webhook で注文が failed になり、確認メールは積まれず、在庫は予約のまま", async () => {
    const products = seedCatalog();
    const { customerUserId, cartTotals } = await signupAndFillCart(
      `cust-B-${Math.random().toString(36).slice(2)}`,
      products,
    );
    const { orderId } = await checkoutAndPay(customerUserId, products, cartTotals, "failure");

    // 受信は成功(署名付き Webhook は届く)。状態は failed。
    const payEvents = withDb((db, m) => rowsOf(db, m, "payment_events"));
    expect(payEvents).toHaveLength(1);
    expect(payEvents[0]?.status).toBe("failed");

    // 注文は failed に更新(EC-G5 failed 分岐)。
    const order = ordersById(orderId);
    expect(order?.status).toBe("failed");
    expect(order?.payment_status).toBe("failed");

    // 確認メールは積まれない(paid 分岐の call_external は when 不成立でスキップ)。
    const mail = pendingOutbox().filter((p) => p.destination === "http://127.0.0.1/mail/send");
    expect(mail).toHaveLength(0);

    // **在庫は戻さない**(D-G4a の系。補償を入れない)。A:3 / B:2 のまま。
    const stocks = withDb((db, m) => {
      const byId = new Map(rowsOf(db, m, "product").map((r) => [r._id, r.stock]));
      return { a: byId.get(products.productA._id), b: byId.get(products.productB._id) };
    });
    expect(stocks).toEqual({ a: STOCK_A - QTY_A, b: STOCK_B - QTY_B });
  });
});

// ===========================================================================
// Path C: timeout —— Webhook 来ず注文 pending_payment のまま(欠落非補償 D-G4a を実証)
// ===========================================================================

describe("Path C timeout: Webhook が来ず注文 pending_payment のまま(欠落非補償 D-G4a)", () => {
  test("timeout では受信0件・注文は pending_payment のまま・在庫は戻さない(補償しないことを実証)", async () => {
    const products = seedCatalog();
    const { customerUserId, cartTotals } = await signupAndFillCart(
      `cust-C-${Math.random().toString(36).slice(2)}`,
      products,
    );
    const { orderId } = await checkoutAndPay(customerUserId, products, cartTotals, "timeout");

    // **Webhook が来ない** —— 受信テーブルは空。
    expect(withDb((db, m) => rowsOf(db, m, "payment_events"))).toHaveLength(0);

    // **注文は pending_payment のまま**(補償・リトライ・照会をしないので自動では進まない)。
    const order = ordersById(orderId);
    expect(order?.status).toBe("pending_payment");
    expect(order?.payment_status).toBe("unpaid");

    // 確認メールも積まれない。
    expect(
      pendingOutbox().filter((p) => p.destination === "http://127.0.0.1/mail/send"),
    ).toHaveLength(0);

    // 在庫は予約のまま(戻さない)。決済が確定しないのに在庫が減ったまま = 欠落非補償の代償。
    const stocks = withDb((db, m) => {
      const byId = new Map(rowsOf(db, m, "product").map((r) => [r._id, r.stock]));
      return { a: byId.get(products.productA._id), b: byId.get(products.productB._id) };
    });
    expect(stocks).toEqual({ a: STOCK_A - QTY_A, b: STOCK_B - QTY_B });

    // モック PSP は決済要求を受理(202)したが Webhook は1本も配送していない —— 黙って消さず証跡に残す。
    expect(mockPsp.ledger.charges).toHaveLength(1);
    expect(mockPsp.ledger.deliveries).toHaveLength(0);
    expect(mockPsp.ledger.suppressed).toHaveLength(1);
    expect(mockPsp.ledger.suppressed[0]?.reason).toBe("timeout");
  });
});

// ===========================================================================
// Path D: 重複 Webhook —— event_id + unique(EC-G8)で冪等(結果整合の重複を吸収)
// ===========================================================================

describe("Path D 冪等: 同じ Webhook が再到達しても payment_events は1行のまま(EC-G8 unique)", () => {
  test("同一 event_id の Webhook を2回配送 → 2件目は unique で弾かれ1行・注文は二重更新しない", async () => {
    const products = seedCatalog();
    const { customerUserId, cartTotals } = await signupAndFillCart(
      `cust-D-${Math.random().toString(36).slice(2)}`,
      products,
    );
    const { orderId } = await checkoutAndPay(customerUserId, products, cartTotals, "success");
    expect(withDb((db, m) => rowsOf(db, m, "payment_events"))).toHaveLength(1);

    // モック PSP から**同じ event_id の Webhook を再配送**(idempotency_key = order._id なので決定論的に同一)。
    const again = await mockPsp.handleCharge(
      new Request(mockChargesUrl, {
        method: "POST",
        body: JSON.stringify({
          order_id: orderId,
          amount: EXPECT_TOTAL,
          currency: "JPY",
          idempotency_key: orderId,
          callback_url: inboundUrl,
          mock_outcome: "success",
          mock_delay_ms: 0,
        }),
      }),
    );
    expect(again.status).toBe(202);
    await mockPsp.drain();

    // 2件目は受信口の unique(EC-G8)で弾かれ、payment_events は1行のまま。注文も paid のまま(冪等)。
    expect(withDb((db, m) => rowsOf(db, m, "payment_events"))).toHaveLength(1);
    expect(ordersById(orderId)?.status).toBe("paid");
  });
});

// ===========================================================================
// 周辺計算の free_over 境界(EC-G6/T02 を参照 EC の実島 + 実 on_create 経路で境界確認)
// ===========================================================================

describe("周辺計算: 送料の free_over 境界(参照 EC の fn-cart-totals をカートの実挙動で発火)", () => {
  test("小計 5000(free_over ちょうど到達)は送料0・小計 4400(未満)は送料500 —— 同じ島が両側を出す", async () => {
    const products = seedCatalog();

    // 未満カート(4400 → 送料500)。既定価格設定は送料500・無料5000・税10%・クーポン null。
    const below = await signupAndFillCart(
      `cust-fo1-${Math.random().toString(36).slice(2)}`,
      products,
    );
    expect(Number(below.cartTotals.shipping_fee)).toBe(500);
    expect(Number(below.cartTotals.subtotal)).toBe(4400);

    // 到達カート: 別顧客が単価2500×2=5000 の1明細で小計ちょうど 5000 → 送料0。
    const cookie = await customerSignup(`cust-fo2-${Math.random().toString(36).slice(2)}`);
    const cartRes = await request("POST", R("cart"), { cookie, body: { status: "open" } });
    const cartId = ((await cartRes.json()) as { record: RecordRow }).record._id;
    const add = await request("POST", R("cart_line"), {
      cookie,
      body: { cart: cartId, product: products.productA._id, quantity: 2, unit_price: 2500 },
    });
    expect(add.status).toBe(201);
    const reached = withDb((db, m) => rowsOf(db, m, "cart_totals").find((r) => r.cart === cartId));
    // subtotal=5000 → 送料0(free_over 到達)・tax floor(500)=500・total=5000-0+0+500=5500。
    expect({
      subtotal: Number(reached?.subtotal),
      shipping_fee: Number(reached?.shipping_fee),
      tax: Number(reached?.tax),
      total: Number(reached?.total),
    }).toEqual({ subtotal: 5000, shipping_fee: 0, tax: 500, total: 5500 });
  });
});

// ===========================================================================
// 語彙不可侵(この E2E が1つも語彙を足していないことの機械的固定)
// ===========================================================================

// ---------------------------------------------------------------------------
// 規則2(docs/plan/v3/records/v3-m1-gate-a-theme.md §10)による書き換え
//
// **旧い形**: `expect(DIFF_OPS.length).toBe(15)`。
// **なぜ書き換えたか**: この検査が主張しているのは「**この成果物が語彙を1つも
// 増やしていない**」ことなのに、見ていたのは「**現在の語彙総数**」だった。
// v3 は ADR-0047 で `DIFF_OPS` を 15 → 16 にする(門A 本審査 = 限定採用)ので、
// 数値を 16 に書き換えると **v2 の主張の担保がその瞬間に消える**(検査が
// 「現在16種である」しか言わなくなる)。
// **新しい形**: 「この成果物が使う op の名前の集合 ⊆ v2 完了時点の語彙集合(名前で
// 列挙)」。**(a) v3 が op を足しても赤くならず、(b) v2 の成果物が新語彙を使い始めたら
// 赤くなる。** v2 の主張はそのまま担保される(むしろ主張に一致する方向へ強くなる)。
// **`FIELD_TYPES`(8)と `RESOURCE_KINDS`(7)は本審査で1つも増えないので、数値固定を
// そのまま残す**(§10 の規則2 の末尾。書き換えるのは op の側だけである)。
// ---------------------------------------------------------------------------

/** v2 完了時点(CP-V2 通過)の差分操作語彙。**名前で列挙する**(現在の総数ではない)。 */
const DIFF_OPS_AT_V2_COMPLETION = [
  "add_table",
  "add_field",
  "add_view",
  "update_view",
  "remove_field",
  "remove_table",
  "change_table",
  "change_field",
  "remove_view",
  "add_workflow",
  "update_workflow",
  "remove_workflow",
  "add_function",
  "update_function",
  "remove_function",
] as const;

/**
 * 与えたソースに**実際に現れる**差分 op を集める(手書きの列挙ではない)。
 *
 * 現在の語彙(`DIFF_OPS`)と v2 完了時点の語彙の和集合に含まれる名前だけを拾うので、
 * バッチ書込の `op: "create"` / `"update"` / `"delete"`(ADR-0039。差分 op ではない)は
 * 混ざらない。**成果物が新しい op を使い始めたら、この集合に現れて下の包含が破れる。**
 */
function diffOpsUsedIn(paths: readonly string[]): string[] {
  const known = new Set<string>([...DIFF_OPS, ...DIFF_OPS_AT_V2_COMPLETION]);
  const found = new Set<string>();
  for (const path of paths) {
    for (const match of readFileSync(path, "utf-8").matchAll(/"?op"?:\s*"([a-z_]+)"/g)) {
      const op = match[1];
      if (op !== undefined && known.has(op)) {
        found.add(op);
      }
    }
  }
  return [...found].sort();
}

describe("語彙不可侵: T03 は実証であって実装ではない", () => {
  // 【`V5-M29-T05` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
  //   消したテスト名(逐語): 「FIELD_TYPES(8) / RESOURCE_KINDS(7) が増えていない」
  //   そのブロックが測っていたもの:
  //     - `expect(FIELD_TYPES.length).toBe(9)`(主張の逐語はテスト名の「FIELD_TYPES(8) … が増えていない」)
  //     - `expect(RESOURCE_KINDS.length).toBe(7)`(主張の逐語はテスト名の「RESOURCE_KINDS(7) が増えていない」)
  //   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `FIELD_TYPES:` / `RESOURCE_KINDS:` で始まる行)。
  //   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
  //   検出力0のまま `Ran` を水増しする)。
  //   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。

  test("この E2E が使う diff op の集合は v2 完了時点の語彙集合に収まっている(規則2)", () => {
    const used = diffOpsUsedIn([
      join(import.meta.dir, "journey-e2e.test.ts"),
      join(import.meta.dir, "manifest.ts"),
      join(import.meta.dir, "functions.ts"),
    ]);
    // 実測の全件(全ジャーニー E2E が使う diff op はこの4つだけである)。
    expect(used).toEqual(["add_field", "add_workflow", "remove_workflow", "update_workflow"]);
    for (const op of used) {
      expect(DIFF_OPS_AT_V2_COMPLETION as readonly string[]).toContain(op);
    }
    expect(DIFF_OPS_AT_V2_COMPLETION).toHaveLength(15);
  });
});
