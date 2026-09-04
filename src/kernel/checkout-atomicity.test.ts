/**
 * チェックアウトの原子性 + 売り越し防止 + 決済Webhook(モック)→ order 更新の**実証**
 * (V2-M4-T03 / EC-G7 + EC-G13)。
 *
 * これは **実証(demonstration)であって実装ではない** —— T01(バッチ API `writeRecords`)と
 * T02(target 語彙 `$record.<reference field>`)を組み合わせ、参照 EC のチェックアウトの
 * **正しさ**を、本物の SQLite・本物のカーネル経路(`applyManifest` / `applyDiff` で実アプリを
 * ディスク上に作り、`writeRecords` / `createRecord` を直呼び)で固定する。**モック無し**
 * (決済 PSP・Webhook 署名検証だけはモック = 受信行を直接 create する)。**新しいカーネル
 * 語彙は1つも足していない。**
 *
 * ## この実証がやっていないこと(誇張しないための境界)
 *
 * - **実 PSP・実 Webhook 署名検証はしない** —— 決済完了通知は `payments` テーブルへ行を
 *   create することで模す(EC-G16 / 01 §2 の決済モック)。
 * - **在庫減算 `stock - qty` の演算はカーネルがしない** —— 呼び出し側(このテスト)が
 *   計算した新 stock 値をバッチの update op に渡す(ADR-0013 限定12 / `action_value` 不可侵)。
 * - **バッチは明示リストのみ** —— 反復/ループ/where 句/一括更新の語彙は無い。N の生成は
 *   呼び出し側の列挙。
 * - **実行時の参照先「行」の実在は保証しない**(T-2 の原理的限界。適用時検査は
 *   「参照フィールドが実在し reference 型か」まで)。
 *
 * ## 実証中に見つかった「既存語彙で書けない」箇所(報告事項)
 *
 * **order と order_line を1つのバッチで原子生成できない。** `order_line.order` は作成する
 * order の `_id` を参照する必要があるが、`_id` はカーネルが `createRecord` 内で
 * `crypto.randomUUID()` で採番し(records.ts:663)、`_id` は書込不可のシステム列
 * (records.ts:validateInput が拒否)。よって**同一バッチ内の兄弟 create op の出力 `_id` を
 * 後続 op から参照する手段が語彙に無い**。したがって現実のチェックアウトは2相になる:
 * (相1)order を1件 create して `_id` を得る → (相2)`[create order_line ×N, update stock ×M]`
 * を**1つの原子バッチ**で書く。売り越しに直結する「明細 N + 在庫減算 M」の原子性は相2で
 * 担保される(下の Demo1/2/3)。相1の order create は別 tx なので、相2が全失敗すると相1の
 * order が孤児として残りうる —— この非対称を正直に記録する(T01 が batch.test.ts の
 * コメントで既に明記した限界と同一)。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff } from "./apply-diff.ts";
import { applyManifest as applyManifestRaw } from "./apply-manifest.ts";
import {
  armManifestForAutomation,
  fixtureOwnerValues,
  seedAutomationActor,
} from "./automation-actor-fixture.test.ts";
import { type BatchOp, writeRecords } from "./batch.ts";
import { createApp } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import {
  countRecords,
  createRecord as createRecordRaw,
  listRecords,
  type RecordRow,
} from "./records.ts";
import { appDbPath, appManifestPath } from "./storage-paths.ts";
import { DIFF_OPS, type Manifest, type Workflow } from "./types.ts";

const APP_ID = "ref-ec";

/**
 * 参照 EC の最小データモデル(04-ec-data-model-draft §2-2/§2-6/§2-8/§2-9)。
 * - `products`(name / sku=unique / stock)—— 在庫は product 内包(§2-9 内包案)
 * - `orders`(customer / status=select / payment_status=text)
 * - `order_lines`(order→orders / product→products / quantity)
 * - `payments`(order→orders / amount / external_id)—— 決済受信行(モック Webhook の着地点)
 * - `wf-runs` —— ワークフロー実行履歴(規約5列)
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
              options: ["pending", "paid", "shipped", "cancelled"],
            },
            { id: "payment_status", name: "決済状態", type: "text" },
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
          id: "payments",
          name: "決済受信",
          fields: [
            { id: "order", name: "対象注文", type: "reference", reference_table: "orders" },
            { id: "amount", name: "金額", type: "number" },
            { id: "external_id", name: "外部決済ID", type: "text" },
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
    },
  };
}

/**
 * 決済完了通知 → 対応 order を更新するワークフロー(EC-G13 の中核)。
 * 発火元(payments 行)ではなく、その `order` 参照フィールドが指す**別テーブルの行**を
 * `$record.order` で狙う。この target 正規形が T02 / ADR-0040 の実証対象。
 */
function paymentWorkflow(): Workflow {
  return {
    id: "wf-payment-webhook",
    name: "決済完了通知で注文を確定",
    trigger: { type: "on_create", table: "payments" },
    actions: [
      {
        action: "update_record",
        table: "orders",
        target: "$record.order",
        values: { status: "paid", payment_status: "paid" },
      },
    ],
    history_table: "wf-runs",
  };
}

let dataRoot: string;
let store: KernelMetaStore;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-checkout-"));
  store = KernelMetaStore.open(dataRoot);
  // 実アプリをカーネルの正規経路でディスク上に作る(生 DDL ではなく apply 経路)。
  createApp(store, "参照EC", { app_id: APP_ID });
  const installed = applyManifest(dataRoot, APP_ID, ecManifest());
  if (!installed.valid) {
    throw new Error(`スキーマ投入に失敗: ${JSON.stringify(installed.errors)}`);
  }
  // 決済ワークフローは **apply_diff の実経路**で入れる —— これにより EC-G13 の適用時検査
  // (target が指す参照フィールドが実在し reference 型か)を本物の diff 経路で通す。
  const wf = applyDiff(dataRoot, APP_ID, {
    diff_id: "d-pay-wf",
    intent: "決済完了通知で注文を確定したい",
    operations: [{ op: "add_workflow", workflow: paymentWorkflow() }],
  });
  if (!wf.valid) {
    throw new Error(`決済WFの apply_diff に失敗: ${JSON.stringify(wf.errors)}`);
  }
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

/** ディスクに永続化された manifest.json をそのまま読む(WF を含む唯一の権威)。 */
function readManifest(): Manifest {
  return JSON.parse(readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8")) as Manifest;
}

/** アプリ DB を開いて処理し、必ず閉じる。 */
/*
 * --- **【`V8-M26`(2026-08-10)で題材に「壁を開ける下ごしらえ」が入った】** -------------
 *
 * **`V8-M26-T03` が面(役割に束ねた権限)の既定を「閉じる」側へ倒したので、
 * 決済 Webhook のワークフローが `orders` を書けなくなった。** **本ファイルの主題は
 * チェックアウトの原子性であって面ではないので、題材の側で壁を開ける** ——
 * **実装は1バイトも緩めていない。**
 * **中身は `src/kernel/automation-actor-fixture.test.ts` の doc に全部書いた。**
 */

/** マニフェストを投入する直前に壁を開け、投入した直後に書き手を1人立てる。 */
function applyManifest(
  root: string,
  appId: string,
  target: Manifest,
): ReturnType<typeof applyManifestRaw> {
  armManifestForAutomation(target);
  const applied = applyManifestRaw(root, appId, target);
  if (applied.valid) {
    const db = new Database(appDbPath(root, appId), { readwrite: true, create: false });
    try {
      seedAutomationActor(db);
    } finally {
      db.close();
    }
  }
  return applied;
}

/** 行を作る(**下ごしらえが持ち主の列を足した表にだけ書き手を入れる**)。 */
function createRecord(
  database: Database,
  target: Manifest,
  tableId: string,
  values: Record<string, unknown>,
): ReturnType<typeof createRecordRaw> {
  return createRecordRaw(database, target, tableId, fixtureOwnerValues(target, tableId, values));
}

function withDb<T>(fn: (db: Database, manifest: Manifest) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return fn(db, readManifest());
  } finally {
    db.close();
  }
}

/** 商品を1件 create し、その行(_id / _updated_at 付き)を返す。 */
function seedProduct(name: string, stock: number, sku?: string): RecordRow {
  return withDb((db, m) => {
    const r = createRecord(db, m, "products", { name, stock, sku: sku ?? null });
    if (!r.ok) {
      throw new Error(`商品作成に失敗: ${JSON.stringify(r.errors)}`);
    }
    return r.value;
  });
}

/** 注文を1件 create し、その行を返す(チェックアウト相1)。 */
function seedOrder(customer: string): RecordRow {
  return withDb((db, m) => {
    const r = createRecord(db, m, "orders", { customer, status: "pending" });
    if (!r.ok) {
      throw new Error(`注文作成に失敗: ${JSON.stringify(r.errors)}`);
    }
    return r.value;
  });
}

/** テーブルの全行を読む(失敗は throw。narrowing 用の unwrap)。 */
function rowsOf(db: Database, m: Manifest, table: string): RecordRow[] {
  const r = listRecords(db, m, table);
  if (!r.ok) {
    throw new Error(`一覧に失敗: ${JSON.stringify(r.errors)}`);
  }
  return r.value;
}

/** テーブルの件数を読む(失敗は throw)。 */
function count(db: Database, m: Manifest, table: string): number {
  const r = countRecords(db, m, table);
  if (!r.ok) {
    throw new Error(`件数に失敗: ${JSON.stringify(r.errors)}`);
  }
  return r.value;
}

// ===========================================================================
// Demo 1: チェックアウトの原子的生成(明細 N + 在庫減算 M を1バッチで全成功)
// ===========================================================================

describe("Demo1 チェックアウトの原子的生成(EC-G7)", () => {
  test("order 1 + order_line ×N + product.stock 減算 ×M が全部書けている", () => {
    const order = seedOrder("田中"); // 相1(別 tx。理由は冒頭コメント参照)
    const p1 = seedProduct("りんご", 10, "APPLE");
    const p2 = seedProduct("みかん", 5, "ORANGE");

    // 相2: 明細2件 + 在庫減算2件を**1つの原子バッチ**で。在庫の新値は呼び出し側が計算。
    const checkout: BatchOp[] = [
      {
        op: "create",
        table: "order_lines",
        values: { order: order._id, product: p1._id, quantity: 3 },
      },
      {
        op: "create",
        table: "order_lines",
        values: { order: order._id, product: p2._id, quantity: 2 },
      },
      {
        op: "update",
        table: "products",
        target: p1._id,
        values: { stock: 7 },
        if_match: p1._updated_at,
      }, // 10-3
      {
        op: "update",
        table: "products",
        target: p2._id,
        values: { stock: 3 },
        if_match: p2._updated_at,
      }, // 5-2
    ];
    const res = withDb((db, m) => writeRecords(db, m, checkout));
    expect(res.ok).toBe(true);

    withDb((db, m) => {
      // order は相1で存在。明細2件・在庫減算がすべて反映されている。
      expect(count(db, m, "orders")).toBe(1);
      expect(rowsOf(db, m, "order_lines").length).toBe(2);
      const byId = new Map(rowsOf(db, m, "products").map((r) => [r._id, r.stock]));
      expect(byId.get(p1._id)).toBe(7);
      expect(byId.get(p2._id)).toBe(3);
    });
  });
});

// ===========================================================================
// Demo 2: 全成功か全失敗(部分適用ゼロ)—— 3ケース
// ===========================================================================

describe("Demo2 全成功か全失敗・部分適用ゼロ(EC-G7)", () => {
  /** チェックアウト相2のバッチ(先頭に必ず明細 create を置き、部分適用の有無を測る)。 */
  function checkoutWithFailure(order: RecordRow, p: RecordRow, failing: BatchOp): BatchOp[] {
    return [
      {
        op: "create",
        table: "order_lines",
        values: { order: order._id, product: p._id, quantity: 1 },
      },
      failing,
    ];
  }

  test("(a) 存在しない table を含む → 明細も在庫も1バイトも書かれない", () => {
    const order = seedOrder("佐藤");
    const p = seedProduct("限定A", 5);
    const batch = checkoutWithFailure(order, p, {
      op: "create",
      table: "ghost_table", // 実在しないテーブル
      values: { x: 1 },
    });
    const res = withDb((db, m) => writeRecords(db, m, batch));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failedIndex).toBe(1);

    withDb((db, m) => {
      expect(rowsOf(db, m, "order_lines").length).toBe(0);
      expect(rowsOf(db, m, "products").find((r) => r._id === p._id)?.stock).toBe(5);
    });
  });

  test("(b) unique 違反(重複 SKU)を含む → 全ロールバック", () => {
    seedProduct("既存", 1, "DUP"); // 既に SKU=DUP を使う商品
    const order = seedOrder("鈴木");
    const p = seedProduct("限定B", 5, "B-SKU");
    const batch = checkoutWithFailure(order, p, {
      op: "create",
      table: "products",
      values: { name: "重複", stock: 1, sku: "DUP" }, // unique 違反
    });
    const res = withDb((db, m) => writeRecords(db, m, batch));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failedIndex).toBe(1);

    withDb((db, m) => {
      // 明細は書かれていない。products は既存2件のみ(重複行は入っていない)。
      expect(rowsOf(db, m, "order_lines").length).toBe(0);
      expect(count(db, m, "products")).toBe(2);
    });
  });

  test("(c) CAS 競合(古い if_match)を含む → 全ロールバック(conflict)", () => {
    const order = seedOrder("高橋");
    const p = seedProduct("限定C", 1);
    const stale = p._updated_at;
    // 別チェックアウトが先に在庫を進める(版が変わる)。
    const advance = withDb((db, m) =>
      writeRecords(db, m, [
        { op: "update", table: "products", target: p._id, values: { stock: 0 }, if_match: stale },
      ]),
    );
    expect(advance.ok).toBe(true);

    // 後発バッチは古い版(stale)で在庫を更新しようとする → CAS 失敗 → 全ロールバック。
    const batch = checkoutWithFailure(order, p, {
      op: "update",
      table: "products",
      target: p._id,
      values: { stock: 0 },
      if_match: stale,
    });
    const res = withDb((db, m) => writeRecords(db, m, batch));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.conflict).toBe(true);
      expect(res.failedIndex).toBe(1);
    }
    // 後発の明細は書かれていない。
    withDb((db, m) => {
      expect(rowsOf(db, m, "order_lines").length).toBe(0);
    });
  });
});

// ===========================================================================
// Demo 3: 売り越し防止(並行 CAS。stock=1 の最後の1個)
// ===========================================================================

describe("Demo3 売り越し防止・並行 CAS(EC-G7 / ADR-0017・0018)", () => {
  /**
   * **並行窓の正直な記録**:
   * このテストは2つのチェックアウトを**同一プロセス内で逐次**走らせる(bun:sqlite は
   * 同期 API で真の同時実行スレッドを持たない)。ここで検証するのは ADR-0017 の
   * **read-then-CAS** の窓 —— 2つ目が1つ目のコミット**前**に読んだ古い `_updated_at` を
   * `if_match` に持ち、書込時に版不一致で CAS が失敗する経路である。
   *
   * **残る真の同時実行窓**(別テスト `IMMEDIATE 境界` で実証): busy_timeout=0 のもとで
   * 2つの writer が**本当に同時**に `BEGIN IMMEDIATE` を打つと、後発は即 `SQLITE_BUSY` で
   * 例外になり(静かな部分適用ではなく loud に失敗)1バイトも書かない。IMMEDIATE は
   * 書込ロックを begin 時に取るので昇格デッドロックは起きない(ADR-0018)。どちらの窓でも
   * **売り越し(在庫マイナス・二重確定)は起きない**。誇張しない: これは単一ファイル
   * 単一ライタの直列化に依存しており、M9-T03 の計測(DELETE の EXCLUSIVE 窓のみ読取ブロック)
   * と矛盾しない。
   */
  test("2つ目のチェックアウトが古い版で CAS 失敗 → バッチ全体が巻き戻り、在庫はマイナスにならない", () => {
    const p = seedProduct("最後の1個", 1);
    const v0 = p._updated_at;
    const orderA = seedOrder("先着A");
    const orderB = seedOrder("後発B");

    // チェックアウトA: 在庫 1→0(v0 で CAS 成功)+ 明細1件。原子的に成立。
    const a = withDb((db, m) =>
      writeRecords(db, m, [
        {
          op: "create",
          table: "order_lines",
          values: { order: orderA._id, product: p._id, quantity: 1 },
        },
        { op: "update", table: "products", target: p._id, values: { stock: 0 }, if_match: v0 },
      ]),
    );
    expect(a.ok).toBe(true);

    // チェックアウトB: A のコミット**前に読んだ** v0 を握ったまま在庫 1→0 を試みる
    //(古い版 = 売り越しになる更新)。CAS 失敗 → B のバッチ全体が巻き戻る。
    const b = withDb((db, m) =>
      writeRecords(db, m, [
        {
          op: "create",
          table: "order_lines",
          values: { order: orderB._id, product: p._id, quantity: 1 },
        },
        { op: "update", table: "products", target: p._id, values: { stock: 0 }, if_match: v0 },
      ]),
    );
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.conflict).toBe(true);

    withDb((db, m) => {
      // 在庫は 0 のまま(マイナスにならない = 売り越しゼロ)。
      expect(rowsOf(db, m, "products").find((r) => r._id === p._id)?.stock).toBe(0);
      // 明細は A の1件のみ(B は巻き戻り、二重確定していない)。
      const lines = rowsOf(db, m, "order_lines");
      expect(lines.length).toBe(1);
      expect(lines[0]?.order).toBe(orderA._id);
    });
  });

  test("IMMEDIATE 境界: 別接続が書込ロック保持中はバッチが即失敗し1バイトも書かない(残る同時実行窓)", () => {
    // ロック取得**前**に前提行を作っておく(seed 自体が書込なのでロック中は打てない)。
    const order = seedOrder("衝突");
    const p = seedProduct("在庫", 1);
    const dbPath = appDbPath(dataRoot, APP_ID);
    const holder = new Database(dbPath);
    holder.exec("PRAGMA busy_timeout=0");
    holder.exec("BEGIN IMMEDIATE"); // 書込ロック(RESERVED)を先取り
    try {
      // writeRecords は BEGIN IMMEDIATE を打つので、begin 時点で SQLITE_BUSY → 例外。
      expect(() =>
        withDb((db, m) => {
          db.exec("PRAGMA busy_timeout=0");
          return writeRecords(db, m, [
            {
              op: "create",
              table: "order_lines",
              values: { order: order._id, product: p._id, quantity: 1 },
            },
          ]);
        }),
      ).toThrow();
      // 明細は1バイトも書かれていない(静かな部分適用にならない)。
      withDb((db, m) => {
        db.exec("PRAGMA busy_timeout=0");
        expect(rowsOf(db, m, "order_lines").length).toBe(0);
      });
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
  });
});

// ===========================================================================
// Demo 4: 決済 Webhook(モック)→ order 状態更新(EC-G13 target)
// ===========================================================================

describe("Demo4 決済Webhook(モック)→ order 更新(EC-G13)", () => {
  test("payments 行を create すると on_create が $record.order で参照先 order を paid に更新する", () => {
    const order = seedOrder("購入者"); // status=pending / payment_status=null

    // 決済完了通知を模して payments 行を create(= モック Webhook の着地)。
    // 署名検証・実 PSP はモック(受信行を直接 create するだけ)。
    withDb((db, m) => {
      const r = createRecord(db, m, "payments", {
        order: order._id,
        amount: 1200,
        external_id: "pi_mock_123",
      });
      if (!r.ok) throw new Error(`決済受信行の作成に失敗: ${JSON.stringify(r.errors)}`);
    });

    withDb((db, m) => {
      // 発火元(payments)ではなく参照先(order)が更新されている = EC-G13 の中核。
      const updated = rowsOf(db, m, "orders").find((r) => r._id === order._id);
      expect(updated?.status).toBe("paid");
      expect(updated?.payment_status).toBe("paid");
      // 履歴は成功で1件。
      const runs = rowsOf(db, m, "wf-runs");
      expect(runs.length).toBe(1);
      expect(runs[0]?.status).toBe("success");
    });
  });

  test("誤った target(reference でない/実在しないフィールド)は apply_diff 時に拒否される(EC-G13 適用時検査)", () => {
    // amount は number(reference ではない)。$record.amount を target にする WF は apply で拒否。
    const bad = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-bad-target",
      intent: "誤った target を入れてみる",
      operations: [
        {
          op: "add_workflow",
          workflow: {
            id: "wf-bad",
            name: "誤 target",
            trigger: { type: "on_create", table: "payments" },
            actions: [
              {
                action: "update_record",
                table: "orders",
                target: "$record.amount",
                values: { status: "paid" },
              },
            ],
            history_table: "wf-runs",
          },
        },
      ],
    });
    expect(bad.valid).toBe(false);
    // 参照先「行」の実在は検査しない(過剰約束しない)—— ここで確定するのは
    // 「target が指す参照フィールドが reference 型で実在するか」まで。
  });
});

// ===========================================================================
// 語彙不可侵(実証が1つも語彙を足していないことの機械的固定)
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
  // 【`V5-M29-T03` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
  //   消したテスト名(逐語): 「FIELD_TYPES(8) / RESOURCE_KINDS(7) が増えていない」
  //   そのブロックが測っていたもの:
  //     - `expect(FIELD_TYPES.length).toBe(9)`(主張の逐語はテスト名の「FIELD_TYPES(8) が増えていない」)
  //     - `expect(RESOURCE_KINDS.length).toBe(7)`(主張の逐語はテスト名の「RESOURCE_KINDS(7) が増えていない」)
  //   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `FIELD_TYPES:` / `RESOURCE_KINDS:` で始まる行)。
  //   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
  //   検出力0のまま `Ran` を水増しする)。
  //   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。

  test("この実証が使う diff op の集合は v2 完了時点の語彙集合に収まっている(規則2)", () => {
    const used = diffOpsUsedIn([join(import.meta.dir, "checkout-atomicity.test.ts")]);
    // 実測の全件(V2-M4-T03 のチェックアウト実証が使う diff op はこれだけである)。
    expect(used).toEqual(["add_workflow"]);
    for (const op of used) {
      expect(DIFF_OPS_AT_V2_COMPLETION as readonly string[]).toContain(op);
    }
    // v2 完了時点の集合の大きさ(**現在の総数ではない**)。
    expect(DIFF_OPS_AT_V2_COMPLETION).toHaveLength(15);
  });
});
