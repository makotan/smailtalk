/**
 * 決済フロー E2E 実証(V2-M5-T03 / EC-G4 + EC-G13 + EC-G15 + EC-G16)。
 *
 * **本物の SQLite・本物の署名付き HTTP Webhook・本物のモック PSP プロセス**で、注文確定から
 * 在庫反映までの一連(03 §5 シーケンス)を通す。**モック PSP は 127.0.0.1 に Bun.serve で立て、
 * プラットフォームも 127.0.0.1 に Bun.serve で立てる** —— 決済要求もWebhookもループバックHTTPで
 * 実際に飛ぶ(app.fetch 直呼びではない)。`checkout-atomicity.test.ts`(M4)を土台に、受信
 * (T01/T02)と既存送信(call_external / outbox)と M3(条件分岐 EC-G5)/ M4(target EC-G13・
 * バッチ EC-G7)を組み合わせる。**新しいカーネル語彙は1つも足していない**(下の「語彙不可侵」)。
 *
 * ## E2E シーケンス(03 §5)
 *  (1) チェックアウト = 注文 create(status=pending_payment)+ 明細 + 在庫 CAS 減算(M4 原子)
 *  (2) 注文 on_create ワークフローで call_external が決済要求を outbox に積む(既存・新語彙なし)
 *  (3) dispatchOutbox → モック PSP `POST /mock-psp/charges` 受理(202)
 *  (4)(5) モック PSP が署名付き Webhook を受信口 `POST /inbound/:endpoint_id` へ POST
 *  (6) 署名検証(実行層)→ payment_events へ1行 create(T02)
 *  (7) payment_events on_create が条件分岐(EC-G5)+ target `$record.order`(EC-G13)で
 *      対応注文を paid/failed に更新
 *  (8) paid なら確認メール送信(EC-G15。call_external でメールゲートウェイ宛。outbox に積む)
 *  (9) 在庫は (1) の CAS 減算で反映済み(売り越し防止 EC-G7)
 *
 * ## この実証がやっていないこと(誇張しない限界。憲法6 / ADR-0041 §限界 / 03 §6)
 *  - **欠落(timeout)/順序逆転は補償しない**(D-G4a)。timeout ケースで **Webhook が来ず注文が
 *    pending_payment のまま残ることを実証・記録する**(下の Path C)。ポーリング照会・リトライ・
 *    タイムアウト後照会は入れない。
 *  - **配送・受信ともに結果整合**(03 §6b-2)。Webhook が「必ず/順序どおり/一度だけ」届く保証は
 *    無い。**重複**は event_id + unique(EC-G8/M3)で吸収する(Path D で実証)が、欠落・順序逆転は
 *    補償しない。
 *  - **2相チェックアウト**(M4 ADR-0039 §限界7 を引き継ぐ)。親 order と子 order_line を1バッチで
 *    原子生成できない(order._id は createRecord 内で採番されるため。checkout-atomicity.test.ts
 *    冒頭コメント)。相1で order を create し、相2で `[明細 + 在庫 CAS]` を1原子バッチにする。
 *  - **failure/timeout で在庫を戻さない**(D-G4a の系。補償を入れない)。在庫は (1) の予約で減っており、
 *    決済失敗・欠落でも自動では戻さない —— 正直に記録する(Path B/C)。
 *  - **マルチテナント非分離**(03 §6b-6。1アプリ=1店舗=自己ホスト前提)。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { type MockOutcome, MockPsp, type MockPspServerHandle } from "./harness.ts";

const APP_ID = "ref-ec";
const INBOUND_KEY_ENV = "ST_E2E_INBOUND_KEY";
const OUTBOUND_SECRET_ENV = "ST_E2E_OUTBOUND_SECRET";
const SIGNING_KEY = "e2e-shared-signing-key-abc";

/**
 * 参照 EC のデータモデル(04-ec-data-model-draft)。
 * - products(name / sku=unique / stock)
 * - orders(顧客・状態・決済状態・金額・通貨 + モック制御フィールド)
 *   ※ mock_outcome / mock_delay_ms / callback_url は**テスト制御フィールド**であり、実 EC の注文
 *     モデルの一部ではない —— 決定論のモックへ call_external の $record 経由で渡すためだけに載せる。
 * - order_lines(order→orders / product→products / quantity)
 * - payment_events(受信テーブル。event_id=unique で冪等・order→orders で target 更新に使う)
 * - wf-runs(履歴5列)
 */
function ecManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "参照EC",
      tables: [
        {
          id: "products",
          name: "商品",
          fields: [
            { id: "name", name: "商品名", type: "text", required: true },
            { id: "sku", name: "SKU", type: "text", unique: true },
            { id: "stock", name: "在庫", type: "number", required: true },
          ],
        },
        {
          id: "orders",
          name: "注文",
          fields: [
            { id: "customer", name: "顧客", type: "text", required: true },
            {
              id: "status",
              name: "状態",
              type: "select",
              options: ["pending_payment", "paid", "failed", "shipped", "cancelled"],
            },
            { id: "payment_status", name: "決済状態", type: "text" },
            { id: "total", name: "合計金額", type: "number", required: true },
            { id: "currency", name: "通貨", type: "text", required: true },
            { id: "mock_outcome", name: "モック結果", type: "text" },
            { id: "mock_delay_ms", name: "モック遅延", type: "number" },
            { id: "callback_url", name: "Webhook返し先", type: "text" },
          ],
        },
        {
          id: "order_lines",
          name: "注文明細",
          fields: [
            { id: "order", name: "注文", type: "reference", reference_table: "orders" },
            { id: "product", name: "商品", type: "reference", reference_table: "products" },
            { id: "quantity", name: "数量", type: "number", required: true },
          ],
        },
        {
          id: "payment_events",
          name: "決済イベント(受信)",
          fields: [
            { id: "event_id", name: "イベントID", type: "text", required: true, unique: true },
            { id: "event_type", name: "種類", type: "text", required: true },
            { id: "order", name: "対象注文", type: "reference", reference_table: "orders" },
            { id: "amount", name: "金額", type: "number" },
            { id: "currency", name: "通貨", type: "text" },
            { id: "status", name: "状態", type: "text" },
          ],
        },
        {
          id: "wf-runs",
          name: "実行履歴",
          fields: [
            { id: "ran_at", name: "実行時刻", type: "date" },
            { id: "workflow", name: "ワークフロー", type: "text" },
            { id: "trigger_type", name: "きっかけ", type: "text" },
            { id: "status", name: "結果", type: "text" },
            { id: "error", name: "エラー", type: "long_text" },
          ],
        },
      ],
      views: [{ id: "product-list", type: "list_view", table: "products", columns: ["name"] }],
      // =================================================================================
      // **【`V8-M26` / `D-V8-67`】面(役割に束ねた権限)の宣言を、この題材に足した。**
      // =================================================================================
      //
      // **`V8-M26-T03` が既定を「閉じる」側へ倒したので、受信口の判定は必ず面を通る** ——
      // **題材に `roles` が1つも無いと、署名の正しい Webhook も 403 になり、
      // `payment_events` が0行になり、決済が完了しない**(着手時の実測)。
      //
      // **`D-V8-67`(受信口は「持ち主が書いている」として扱う)により、受信の主体は
      // 持ち主(`owner`)として面の判定を受ける** —— **したがって受信を通すのに要るのは、
      // 持ち主に `payment_events` の書込を許す規則1本だけである。**
      //
      // **【`payment_events` 1表にしか書いていない。理由を実測で書く】** ——
      // **受信をきっかけに動くワークフローが書く先(`orders` / `wf-runs`)には1本も
      // 書いていない。** **その発火の書き手は「特定できません」に落ちる**
      // (`payment_events` は `st_owner` を持たないので `act_as` で辿る先も無い)——
      // **書き手を特定できない発火は今日も面を素通りするので、規則が要らない**
      // (`src/kernel/automation-writer-passthrough.test.ts` がその1本の線を測っている)。
      // **【正直に書く】** **したがってこの題材は「受信は面で守られているが、その受信が
      // 起こす注文更新は面に1度も掛からない」という非対称を、そのまま抱えている。**
      //
      // **配る動詞は `src/kernel/apply-diff.ts` の自動付与と同じ形である**
      // (表 = 持ち主 `read`/`write`/`delete`・編集者 `read`/`write`・閲覧者 `read`)。
      // **「全部に全許可」を配ってはいない。**
      // **判定を1ミリも緩めていない** —— **変えたのは題材の側だけである。**
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(類型17 の拡張)。
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            { target: "table", table: "payment_events", can: ["read", "write", "delete"] },
          ],
        },
        {
          id: "editor",
          name: "編集者",
          rules: [{ target: "table", table: "payment_events", can: ["read", "write"] }],
        },
        {
          id: "viewer",
          name: "閲覧者",
          rules: [{ target: "table", table: "payment_events", can: ["read"] }],
        },
      ],
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let store: KernelMetaStore;
let mockPsp: MockPsp;
let mockServer: MockPspServerHandle;
let platformServer: ReturnType<typeof Bun.serve>;
let endpointId: string;
let mockChargesUrl: string;
let inboundUrl: string;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-payflow-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "参照EC", { app_id: APP_ID });
  const installed = applyManifest(dataRoot, APP_ID, ecManifest());
  if (!installed.valid) {
    throw new Error(`スキーマ投入に失敗: ${JSON.stringify(installed.errors)}`);
  }

  // 署名検証鍵(受信口)と送信 secret(接続)は非保管 —— 取得元(env)だけを渡す。
  process.env[INBOUND_KEY_ENV] = SIGNING_KEY;
  process.env[OUTBOUND_SECRET_ENV] = "outbound-bearer-secret";

  // 人間 owner が inbound endpoint を発行する(T01。テストからは発行を直接呼ぶ)。
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

  // 人間 owner が接続を発行する(送信 = 決済要求 / 確認メール。ADR-0020。AI は申請だけ)。
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

  // プラットフォームを 127.0.0.1 に立てる(受信口 POST /inbound/:endpoint_id を含む)。
  platformServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createServerApp({ dataRoot }).fetch,
  });
  inboundUrl = `http://127.0.0.1:${platformServer.port}/inbound/${endpointId}`;

  // モック PSP を 127.0.0.1 に立てる(共有シークレット = 受信口の署名検証鍵と同値)。
  mockPsp = new MockPsp({ sharedSecret: SIGNING_KEY });
  mockServer = mockPsp.listen();
  mockChargesUrl = mockServer.chargesUrl;

  // ワークフローを実経路(apply_diff)で入れる:
  //  (A) 注文 on_create → call_external で決済要求を outbox に積む(destination は起動後に確定)
  //  (B) payment_events on_create → 条件分岐(EC-G5)+ target(EC-G13)で注文更新 + 確認メール
  const wf = applyDiff(dataRoot, APP_ID, {
    diff_id: "d-payment-workflows",
    intent: "決済要求送信と受信後の注文更新・確認メールを自動化したい",
    operations: [
      {
        op: "add_workflow",
        workflow: {
          id: "wf-order-checkout",
          name: "注文確定で決済要求を送る",
          trigger: { type: "on_create", table: "orders" },
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
          ],
          history_table: "wf-runs",
        },
      },
      {
        op: "add_workflow",
        workflow: {
          id: "wf-payment-received",
          name: "決済イベント受信で注文を確定/失敗にする",
          trigger: { type: "on_create", table: "payment_events" },
          actions: [
            // paid 分岐(EC-G5 when)→ 対応注文を paid に(EC-G13 target $record.order)。
            {
              action: "update_record",
              table: "orders",
              target: "$record.order",
              values: { status: "paid", payment_status: "paid" },
              when: { field: "status", equals: "paid" },
            },
            // paid 分岐 → 確認メール(EC-G15。call_external でメールゲートウェイ宛。新語彙なし)。
            {
              action: "call_external",
              connection: "mail-gateway",
              destination: "http://127.0.0.1/mail/send",
              payload: { order: "$record.order", amount: "$record.amount" },
              when: { field: "status", equals: "paid" },
            },
            // failed 分岐 → 対応注文を failed に(在庫は戻さない = D-G4a の系)。
            {
              action: "update_record",
              table: "orders",
              target: "$record.order",
              values: { status: "failed", payment_status: "failed" },
              when: { field: "status", equals: "failed" },
            },
          ],
          history_table: "wf-runs",
        },
      },
    ],
  });
  if (!wf.valid) {
    throw new Error(`ワークフローの apply_diff に失敗: ${JSON.stringify(wf.errors)}`);
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

/** ディスクの manifest.json(適用済みワークフローを含む唯一の権威)を読む。 */
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

/** kernel.sqlite の outbox の pending を読む(確認メールが積まれたかの検査)。 */
function pendingOutbox() {
  const cap = CapabilityStore.openForKernel(dataRoot);
  try {
    return cap.listPendingOutbox();
  } finally {
    cap.close();
  }
}

function ordersById(id: string): RecordRow | undefined {
  return withDb((db, m) => rowsOf(db, m, "orders").find((r) => r._id === id));
}

/**
 * チェックアウト1件 + 決済フロー(送信 → モック PSP → 署名付き Webhook → 受信 → 注文更新)。
 * `outcome` で3経路(success/failure/timeout)を切り替える。**在庫は (1) の予約 CAS で減らす。**
 * @returns 作成した注文とその明細商品(検証用)。
 */
async function checkout(
  customer: string,
  outcome: MockOutcome,
  opts: { stock: number; qty: number } = { stock: 5, qty: 2 },
): Promise<{ orderId: string; productId: string }> {
  // 商品を用意(相0)。
  const product = withDb((db, m) => {
    const r = createRecord(db, m, "products", {
      name: `商品-${customer}`,
      stock: opts.stock,
      sku: null,
    });
    if (!r.ok) throw new Error(`商品作成に失敗: ${JSON.stringify(r.errors)}`);
    return r.value;
  });

  // (1) 相1: 注文 create(status=pending_payment)。**createRecord が on_create を発火** →
  //     wf-order-checkout の call_external が決済要求を outbox に積む(§5 (2))。
  const order = withDb((db, m) => {
    const r = createRecord(db, m, "orders", {
      customer,
      status: "pending_payment",
      total: 12345,
      currency: "JPY",
      mock_outcome: outcome,
      mock_delay_ms: 0,
      callback_url: inboundUrl,
    });
    if (!r.ok) throw new Error(`注文作成に失敗: ${JSON.stringify(r.errors)}`);
    return r.value;
  });

  // (1) 相2: 明細 + 在庫 CAS 減算を**1原子バッチ**で(EC-G7・売り越し防止。§5 (9) の在庫予約)。
  const checkoutBatch: BatchOp[] = [
    {
      op: "create",
      table: "order_lines",
      values: { order: order._id, product: product._id, quantity: opts.qty },
    },
    {
      op: "update",
      table: "products",
      target: product._id,
      values: { stock: opts.stock - opts.qty },
      if_match: product._updated_at,
    },
  ];
  const reserved = withDb((db, m) => writeRecords(db, m, checkoutBatch));
  if (!reserved.ok) {
    throw new Error(`在庫予約バッチに失敗: ${JSON.stringify(reserved)}`);
  }

  // (3) dispatchOutbox → モック PSP へ実 HTTP で決済要求を送る(202)。**実 fetch を使う。**
  const dispatched = await dispatchOutbox(dataRoot);
  expect(dispatched.sent).toBe(1);

  // (4)(5)(6)(7)(8) モック PSP が署名付き Webhook を受信口へ実 HTTP で POST し、受信 → 注文更新 →
  //     確認メールまで走る。**Webhook が着地するまで待つ**(timeout は着地しない = drain 即完了)。
  await mockPsp.drain();

  return { orderId: order._id, productId: product._id };
}

// ===========================================================================
// Path A: success —— paid → 確認メール → 在庫減算
// ===========================================================================

describe("Path A success: 決済成功 → 注文 paid → 確認メール(EC-G15)→ 在庫減算", () => {
  test("本物のSQLite + 署名付きWebhook + モックPSPプロセスで一連が通る", async () => {
    const { orderId, productId } = await checkout("成功太郎", "success", { stock: 5, qty: 2 });

    // (6) 受信テーブルに1行 create(署名検証を通過して着地)。
    const events = withDb((db, m) => rowsOf(db, m, "payment_events"));
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe("paid");
    expect(events[0]?.order).toBe(orderId);

    // (7) 条件分岐(EC-G5)+ target(EC-G13)で対応注文が paid に更新されている。
    const order = ordersById(orderId);
    expect(order?.status).toBe("paid");
    expect(order?.payment_status).toBe("paid");

    // (8) 確認メール(EC-G15)が call_external で outbox に積まれている(mail-gateway 宛。新語彙ゼロ)。
    const pending = pendingOutbox();
    const mail = pending.filter((p) => p.destination === "http://127.0.0.1/mail/send");
    expect(mail).toHaveLength(1);
    expect(mail[0]?.payload).toEqual({ order: orderId, amount: 12345 });

    // (9) 在庫は予約 CAS で減っている(5 - 2 = 3。売り越し防止)。
    const product = withDb((db, m) => rowsOf(db, m, "products").find((r) => r._id === productId));
    expect(product?.stock).toBe(3);

    // モック PSP の証跡: 決済要求1件・署名付き Webhook 1本を配送(受信口が 201 で受理)。
    expect(mockPsp.ledger.charges).toHaveLength(1);
    expect(mockPsp.ledger.deliveries).toHaveLength(1);
    expect(mockPsp.ledger.deliveries[0]?.deliveredStatus).toBe(201);
    // 配送 body の署名は sha256= 形(実バイトに付いている)。
    expect(mockPsp.ledger.deliveries[0]?.signatureHeader.startsWith("sha256=")).toBe(true);
  });
});

// ===========================================================================
// Path B: failure —— 注文 failed → 確認メールなし → 在庫は戻さない(D-G4a の系)
// ===========================================================================

describe("Path B failure: 決済失敗 → 注文 failed → メールなし → 在庫は戻さない", () => {
  test("失敗 Webhook で注文が failed になり、確認メールは積まれず、在庫は予約のまま", async () => {
    const { orderId, productId } = await checkout("失敗花子", "failure", { stock: 5, qty: 2 });

    // 受信は成功(署名付き Webhook は届く)。状態は failed。
    const events = withDb((db, m) => rowsOf(db, m, "payment_events"));
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe("failed");

    // 注文は failed に更新(EC-G5 failed 分岐)。
    const order = ordersById(orderId);
    expect(order?.status).toBe("failed");
    expect(order?.payment_status).toBe("failed");

    // 確認メールは積まれない(paid 分岐の call_external は when 不成立でスキップ)。
    const mail = pendingOutbox().filter((p) => p.destination === "http://127.0.0.1/mail/send");
    expect(mail).toHaveLength(0);

    // **在庫は戻さない**(D-G4a の系。補償を入れない)。予約で減った 3 のまま。
    const product = withDb((db, m) => rowsOf(db, m, "products").find((r) => r._id === productId));
    expect(product?.stock).toBe(3);
  });
});

// ===========================================================================
// Path C: timeout —— Webhook 来ず注文 pending_payment のまま(欠落非補償 D-G4a を実証)
// ===========================================================================

describe("Path C timeout: Webhook が来ず注文 pending_payment のまま(欠落非補償 D-G4a)", () => {
  test("timeout では受信0件・注文は pending_payment のまま残る(補償しないことを実証・記録)", async () => {
    const { orderId, productId } = await checkout("欠落次郎", "timeout", { stock: 5, qty: 2 });

    // **Webhook が来ない** —— 受信テーブルは空。
    const events = withDb((db, m) => rowsOf(db, m, "payment_events"));
    expect(events).toHaveLength(0);

    // **注文は pending_payment のまま**(補償・リトライ・照会をしないので自動では進まない)。
    const order = ordersById(orderId);
    expect(order?.status).toBe("pending_payment");
    expect(order?.payment_status).toBeNull();

    // 確認メールも積まれない。
    const mail = pendingOutbox().filter((p) => p.destination === "http://127.0.0.1/mail/send");
    expect(mail).toHaveLength(0);

    // 在庫は予約のまま(戻さない)。決済が確定しないのに在庫が減ったまま = 欠落非補償の代償。
    const product = withDb((db, m) => rowsOf(db, m, "products").find((r) => r._id === productId));
    expect(product?.stock).toBe(3);

    // モック PSP は決済要求を受理(202)したが Webhook は1本も配送していない ——
    // **黙って消さず**「timeout で抑止した」ことを証跡に残す(憲法6・D-G4a)。
    expect(mockPsp.ledger.charges).toHaveLength(1);
    expect(mockPsp.ledger.deliveries).toHaveLength(0);
    expect(mockPsp.ledger.suppressed).toHaveLength(1);
    expect(mockPsp.ledger.suppressed[0]?.reason).toBe("timeout");
  });
});

// ===========================================================================
// Path D: 重複 Webhook —— event_id + unique で冪等(結果整合の重複を吸収。EC-G8)
// ===========================================================================

describe("Path D 冪等: 同じ Webhook が再到達しても payment_events は1行のまま(EC-G8 unique)", () => {
  test("同一 event_id の Webhook を2回配送 → 2件目は unique で弾かれ1行・注文は二重更新しない", async () => {
    const { orderId } = await checkout("冪等三郎", "success", { stock: 5, qty: 1 });
    expect(withDb((db, m) => rowsOf(db, m, "payment_events"))).toHaveLength(1);

    // モック PSP から**同じ event_id の Webhook を再配送**(結果整合の重複を再現)。
    // idempotency_key = order._id なので event_id は決定論的に同じになる。
    const again = await mockPsp.handleCharge(
      new Request(mockChargesUrl, {
        method: "POST",
        body: JSON.stringify({
          order_id: orderId,
          amount: 12345,
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

    // 2件目は受信口の unique(EC-G8)で弾かれ、payment_events は1行のまま。
    expect(withDb((db, m) => rowsOf(db, m, "payment_events"))).toHaveLength(1);
    // 注文も paid のまま(二重更新しても状態は同じ = 冪等)。
    expect(ordersById(orderId)?.status).toBe("paid");
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

  test("この決済 E2E が使う diff op の集合は v2 完了時点の語彙集合に収まっている(規則2)", () => {
    const used = diffOpsUsedIn([
      join(import.meta.dir, "payment-flow-e2e.test.ts"),
      join(import.meta.dir, "harness.ts"),
      join(import.meta.dir, "signer.ts"),
    ]);
    // 実測の全件(モック PSP の決済フロー E2E が使う diff op はこれだけである)。
    expect(used).toEqual(["add_workflow"]);
    for (const op of used) {
      expect(DIFF_OPS_AT_V2_COMPLETION as readonly string[]).toContain(op);
    }
    expect(DIFF_OPS_AT_V2_COMPLETION).toHaveLength(15);
  });
});
