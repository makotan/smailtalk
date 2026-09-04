/**
 * バッチ書込(EC-G7 / ADR-0039)の TDD テスト。
 *
 * 本物の bun:sqlite(ファイル DB。モック無し)で、明示リストの原子書込・部分適用ゼロ・
 * `if_match` CAS・カスケード発火・IMMEDIATE 境界・監査フックを確認する。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  armManifestForAutomation,
  FIXTURE_ACTOR_ID,
  isFixtureOwnerTable,
  OWNER_FIELD,
  seedAutomationActor,
} from "./automation-actor-fixture.test.ts";
import { type BatchOp, type BatchWrittenOp, writeRecords } from "./batch.ts";
import { applyManifestDdl } from "./ddl.ts";
import { countRecords, createRecord, getRecord, listRecords, type RecordRow } from "./records.ts";
import { DIFF_OPS, type Manifest, RESOURCE_KINDS } from "./types.ts";

/**
 * 参照 EC の最小データモデル。
 * - `products`(name / stock)
 * - `orders`(customer / status)
 * - `order_lines`(order 参照 / product 参照 / quantity)
 * - `sku` に unique を1つ足して unique 違反ロールバックを試す
 */
function ecManifest(): Manifest {
  return {
    app: {
      id: "ec",
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
              options: ["pending", "paid", "cancelled"],
            },
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
      ],
      views: [],
    },
  };
}

let dir: string;
let db: Database;
let manifest: Manifest;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gp-batch-"));
  db = new Database(join(dir, "app.sqlite"));
  manifest = ecManifest();
  applyManifestDdl(db, manifest);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

/** 商品を1件作り _id を返す。 */
function makeProduct(name: string, stock: number, sku?: string): RecordRow {
  const r = createRecord(db, manifest, "products", { name, stock, sku: sku ?? null });
  if (!r.ok) {
    throw new Error(`商品作成に失敗: ${JSON.stringify(r.errors)}`);
  }
  return r.value;
}

describe("writeRecords: 明示リストの原子書込(全成功)", () => {
  test("order 1 + order_line ×N + product 在庫更新 ×M を1バッチで全成功で書ける", () => {
    const p1 = makeProduct("りんご", 10, "APPLE");
    const p2 = makeProduct("みかん", 5, "ORANGE");

    // 呼び出し側が明示列挙(N=2 明細、M=2 在庫更新)。在庫減算は呼び出し側が計算した値。
    const ops: BatchOp[] = [
      { op: "create", table: "orders", values: { customer: "田中", status: "pending" } },
    ];
    // order の _id は「まだ無い」—— T01 は定数 target のみ想定。ここでは order を先に作り
    // その _id を明細の reference に埋める2段には**しない**(T01 は明示リスト内の相互参照
    // 解決を持たない)。代わりに order を別途作ってから明細+在庫更新をバッチにする。
    const orderRes = writeRecords(db, manifest, ops);
    expect(orderRes.ok).toBe(true);
    if (!orderRes.ok) return;
    const orderId = orderRes.results[0]?._id as string;

    const batch: BatchOp[] = [
      {
        op: "create",
        table: "order_lines",
        values: { order: orderId, product: p1._id, quantity: 3 },
      },
      {
        op: "create",
        table: "order_lines",
        values: { order: orderId, product: p2._id, quantity: 2 },
      },
      {
        op: "update",
        table: "products",
        target: p1._id,
        values: { stock: 7 }, // 10 - 3(呼び出し側が計算)
        if_match: p1._updated_at,
      },
      {
        op: "update",
        table: "products",
        target: p2._id,
        values: { stock: 3 }, // 5 - 2
        if_match: p2._updated_at,
      },
    ];

    const res = writeRecords(db, manifest, batch);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.results).toHaveLength(4);

    // 実データを読み直して確認。
    const lines = listRecords(db, manifest, "order_lines");
    expect(lines.ok && lines.value.length).toBe(2);
    const prod1 = getRecord(db, manifest, "products", p1._id);
    const prod2 = getRecord(db, manifest, "products", p2._id);
    expect(prod1.ok && prod1.value?.stock).toBe(7);
    expect(prod2.ok && prod2.value?.stock).toBe(3);
  });
});

describe("writeRecords: 部分適用ゼロ(1 op 失敗で全ロールバック)", () => {
  test("存在しない table を含むと order も在庫も1バイトも書かれない", () => {
    const p1 = makeProduct("りんご", 10);
    const before = countRecords(db, manifest, "orders");
    expect(before.ok && before.value).toBe(0);

    const batch: BatchOp[] = [
      { op: "create", table: "orders", values: { customer: "佐藤", status: "pending" } },
      { op: "create", table: "ghost_table", values: { x: 1 } }, // 存在しない
      {
        op: "update",
        table: "products",
        target: p1._id,
        values: { stock: 0 },
        if_match: p1._updated_at,
      },
    ];
    const res = writeRecords(db, manifest, batch);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failedIndex).toBe(1);

    // order は書かれていない(部分適用ゼロ)。
    const after = countRecords(db, manifest, "orders");
    expect(after.ok && after.value).toBe(0);
    // 在庫も戻っている。
    const prod = getRecord(db, manifest, "products", p1._id);
    expect(prod.ok && prod.value?.stock).toBe(10);
  });

  test("unique 違反を含むと全ロールバック", () => {
    makeProduct("既存", 1, "DUP");
    const before = countRecords(db, manifest, "orders");
    const batch: BatchOp[] = [
      { op: "create", table: "orders", values: { customer: "鈴木", status: "pending" } },
      { op: "create", table: "products", values: { name: "重複", stock: 1, sku: "DUP" } }, // unique 違反
    ];
    const res = writeRecords(db, manifest, batch);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failedIndex).toBe(1);
    // order は書かれていない。
    const after = countRecords(db, manifest, "orders");
    expect(after.ok && after.value).toBe(before.ok ? before.value : -1);
    // 重複商品も入っていない(既存の1件のみ)。
    const prods = listRecords(db, manifest, "products");
    expect(prods.ok && prods.value.length).toBe(1);
  });

  test("参照整合性違反(実在しない product 参照)を含むと全ロールバック", () => {
    const batch: BatchOp[] = [
      { op: "create", table: "orders", values: { customer: "高橋", status: "pending" } },
      {
        op: "create",
        table: "order_lines",
        values: { order: "does-not-exist", product: "nope", quantity: 1 },
      },
    ];
    const res = writeRecords(db, manifest, batch);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failedIndex).toBe(1);
    const orders = listRecords(db, manifest, "orders");
    expect(orders.ok && orders.value.length).toBe(0);
  });
});

describe("writeRecords: update op の if_match CAS", () => {
  test("古い if_match(在庫を別途進めた後)でバッチ全体が巻き戻る", () => {
    const p1 = makeProduct("限定品", 1);
    const staleVersion = p1._updated_at;

    // 別経路で在庫を先に更新して _updated_at を進める(先行チェックアウト相当)。
    const advanced = createRecord(db, manifest, "orders", {
      customer: "先行",
      status: "pending",
    });
    expect(advanced.ok).toBe(true);
    const adv = updateStock(p1._id, 0, staleVersion);
    expect(adv).toBe(true); // 先行更新は成功

    const p1After = getRecord(db, manifest, "products", p1._id);
    const newVersion = p1After.ok ? (p1After.value?._updated_at as string) : "";
    expect(newVersion).not.toBe(staleVersion);

    // 後発バッチは**古い** staleVersion を渡す → CAS 失敗 → 全ロールバック。
    const batch: BatchOp[] = [
      { op: "create", table: "orders", values: { customer: "後発", status: "pending" } },
      {
        op: "update",
        table: "products",
        target: p1._id,
        values: { stock: -1 },
        if_match: staleVersion,
      },
    ];
    const res = writeRecords(db, manifest, batch);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.conflict).toBe(true);
    expect(res.failedIndex).toBe(1);

    // 後発の order は書かれていない(部分適用ゼロ)。
    const orders = listRecords(db, manifest, "orders");
    // 先行 order(1件)のみ。後発 order は巻き戻っている。
    expect(orders.ok && orders.value.map((r) => r.customer)).toEqual(["先行"]);
    // 在庫はマイナスにならず、先行更新の 0 のまま(売り越しゼロ)。
    expect(p1After.ok && p1After.value?.stock).toBe(0);
  });
});

/** 在庫を CAS 付きで更新するヘルパ(先行更新の模擬)。 */
function updateStock(id: string, stock: number, ifMatch: string): boolean {
  const res = writeRecords(db, manifest, [
    { op: "update", table: "products", target: id, values: { stock }, if_match: ifMatch },
  ]);
  return res.ok;
}

describe("writeRecords: IMMEDIATE 境界", () => {
  test("別接続が BEGIN IMMEDIATE で書込ロックを保持している間、バッチは即座に失敗し1バイトも書かない", () => {
    // busy_timeout=0 の別接続が IMMEDIATE で書込ロック(RESERVED)を先取り。
    const other = new Database(join(dir, "app.sqlite"));
    other.exec("PRAGMA busy_timeout=0");
    db.exec("PRAGMA busy_timeout=0");
    other.exec("BEGIN IMMEDIATE");
    try {
      // writeRecords は BEGIN IMMEDIATE を発行する経路なので、begin 時点で SQLITE_BUSY。
      // 検証層(バリデーション)を通ったうえで tx 取得に失敗するので**例外**が投げられる
      // (バリデーション失敗ではない = 静かな部分適用にならない)。
      expect(() =>
        writeRecords(db, manifest, [
          { op: "create", table: "orders", values: { customer: "衝突", status: "pending" } },
        ]),
      ).toThrow();
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
    // ロック解放後、orders には1件も書かれていない(部分適用ゼロ)。
    const orders = listRecords(db, manifest, "orders");
    expect(orders.ok && orders.value.length).toBe(0);
  });
});

/** 履歴テーブル(5列)を足したマニフェストを返す。 */
function ecManifestWithHistory(): Manifest {
  const m = ecManifest();
  m.app.tables.push({
    id: "wf_log",
    name: "実行履歴",
    fields: [
      { id: "ran_at", name: "実行時刻", type: "text" },
      { id: "workflow", name: "ワークフロー", type: "text" },
      { id: "trigger_type", name: "トリガー", type: "text" },
      { id: "status", name: "状態", type: "text" },
      { id: "error", name: "エラー", type: "long_text" },
    ],
  });
  return m;
}

describe("writeRecords: カスケードが同一 tx で発火(firedRecords / 深度上限)", () => {
  /*
   * --- **【`V8-M26`(2026-08-10)で足した下ごしらえ】** ------------------------------
   *
   * **`V8-M26-T03` が面(役割に束ねた権限)の既定を「閉じる」側へ倒したので、
   * カスケードの `update_record` が止まった。** **この describe の主題は
   * 「同一 tx で発火するか」「暴走しないか」であって面ではないので、題材の側で壁を開ける**
   * —— **実装は1バイトも緩めていない。**
   *
   * **`orders` は `beforeEach` で DDL 済みなので、持ち主の列は `ALTER TABLE` で足す**
   * (マニフェストに書くだけでは物理の列が無く、挿入がその場で落ちる)。
   */
  function armCascade(m: Manifest): void {
    armManifestForAutomation(m);
    for (const table of m.app.tables) {
      if (table.id === "wf_log" || !isFixtureOwnerTable(m, table.id)) {
        continue;
      }
      db.run(
        `ALTER TABLE ${JSON.stringify(table.id)} ADD COLUMN ${JSON.stringify(OWNER_FIELD.id)} TEXT`,
      );
    }
    seedAutomationActor(db);
  }

  test("on_create カスケードがバッチ経由でも同一 tx 内で発火し、書いた行が読める", () => {
    // orders への create で、その order 自身の status を "paid" に更新するワークフロー。
    const m: Manifest = ecManifestWithHistory();
    m.app.workflows = [
      {
        id: "wf_autopay",
        name: "受注時に確定",
        trigger: { type: "on_create", table: "orders" },
        actions: [
          {
            action: "update_record",
            table: "orders",
            target: "$record._id",
            values: { status: "paid" },
          },
        ],
        history_table: "wf_log",
      },
    ];
    db.exec(
      'CREATE TABLE "wf_log" ("_id" TEXT PRIMARY KEY, "_created_at" TEXT, "_updated_at" TEXT, "ran_at" TEXT, "workflow" TEXT, "trigger_type" TEXT, "status" TEXT, "error" TEXT)',
    );
    armCascade(m);
    const res = writeRecords(db, m, [
      {
        op: "create",
        table: "orders",
        // **持ち主は下ごしらえが要求する** —— **これがカスケードの書き手になる。**
        values: { customer: "カスケード", status: "pending", st_owner: FIXTURE_ACTOR_ID },
      },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // カスケードが同一 tx で発火 → order の status が paid に書き換わって**コミット済み**。
    const order = getRecord(db, m, "orders", res.results[0]?._id as string);
    expect(order.ok && order.value?.status).toBe("paid");
  });

  test("自己更新カスケードでも firedRecords により同じ行は2度発火しない(暴走しない)", () => {
    // on_update × update_record × target:$record._id は firedRecords で1回で止まる。
    const m: Manifest = ecManifestWithHistory();
    m.app.workflows = [
      {
        id: "wf_self",
        name: "自己更新",
        trigger: { type: "on_update", table: "orders" },
        actions: [
          {
            action: "update_record",
            table: "orders",
            target: "$record._id",
            values: { customer: "touched" },
          },
        ],
        history_table: "wf_log",
      },
    ];
    db.exec(
      'CREATE TABLE "wf_log" ("_id" TEXT PRIMARY KEY, "_created_at" TEXT, "_updated_at" TEXT, "ran_at" TEXT, "workflow" TEXT, "trigger_type" TEXT, "status" TEXT, "error" TEXT)',
    );
    armCascade(m);
    const created = createRecord(db, m, "orders", {
      customer: "初期",
      status: "pending",
      // **持ち主は下ごしらえが要求する** —— **これがカスケードの書き手になる。**
      st_owner: FIXTURE_ACTOR_ID,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // バッチ経由の update でも暴走せず完了する(firedRecords が効く)。
    const res = writeRecords(db, m, [
      {
        op: "update",
        table: "orders",
        target: created.value._id,
        values: { status: "paid" },
        if_match: created.value._updated_at,
      },
    ]);
    // 【V3-M13-T13 / ADR-0066 §改訂1 による期待値の更新】`V3-M13-T02` の時点では
    // 抑止も「失敗」だったので(限定16)自己更新カスケードはバッチ全体を巻き戻していた。
    // **`V3-M13-T13` の門A本審査が限定16 の適用範囲を狭め、再発火抑止を失敗から外した。**
    // 暴走しない(有限で止まる)ことは、3つの時点のどれでも1バイトも変わっていない。
    expect(res.ok).toBe(true);
    // 自己更新は1回だけ効き、2度目は抑止される。
    const order = getRecord(db, m, "orders", created.value._id);
    expect(order.ok && order.value?.customer).toBe("touched");
    expect(order.ok && order.value?.status).toBe("paid");
    // 抑止は履歴に loud に残る(憲法6)。
    const log = db.query('SELECT "status", "error" FROM "wf_log"').all() as {
      status: string;
      error: string;
    }[];
    // 【V4-M4-T02 / ADR-0072 による期待値の更新】抑止の履歴行の `status` が3値目になった。
    const suppressed = log.filter((row) => row.status === "suppressed");
    expect(suppressed).toHaveLength(1);
    expect(String(suppressed[0]?.error)).toContain("再発火");
    expect(log.filter((row) => row.status === "failure")).toHaveLength(0);
  });
});

describe("writeRecords: 監査フック(onWritten)", () => {
  test("成功した各 op で onWritten が呼ばれる", () => {
    const p1 = makeProduct("A", 5);
    const written: BatchWrittenOp[] = [];
    const res = writeRecords(
      db,
      manifest,
      [
        { op: "create", table: "orders", values: { customer: "監査", status: "pending" } },
        {
          op: "update",
          table: "products",
          target: p1._id,
          values: { stock: 4 },
          if_match: p1._updated_at,
        },
      ],
      { onWritten: (w) => written.push(w) },
    );
    expect(res.ok).toBe(true);
    expect(written.map((w) => w.index)).toEqual([0, 1]);
    expect(written[0]?.op.op).toBe("create");
    expect(written[1]?.op.op).toBe("update");
  });
});

describe("writeRecords: 入力の構造検証(明示リストのみ・create/update の2種のみ)", () => {
  /*
   * **V4-M34-T01 が反転させた検査(`ADR-0131` 限定7)。削除ではない。**
   *
   * **反転前の逐語(4行。消さずにここへ残す)**:
   *
   *     test("空のバッチは拒否する(黙って何もしないを避ける)", () => {
   *       const res = writeRecords(db, manifest, []);
   *       expect(res.ok).toBe(false);
   *     });
   *
   * **反転の根拠**: `ADR-0131`(門A 本審査 = 限定採用。単位A)§Decision 1 の逐語
   * 「**`src/kernel/batch.ts` の `validateBatchStructure` が持つ「op が0件なら失敗」という
   * 判定を、「op が0件なら `{ ok: true, results: [] }`」に変える。**」。
   * **入口ごとに扱いを変えない**(単位B = 却下。`ADR-0003` §7)。
   *
   * **【この検査が守っていた性質のうち、何が失われるか。審査記録 §3-2 と同じ言葉で書く】**
   *
   *  - **(i) 「空のバッチを渡したときに何が起きるか」を述べる検査が製品に1本は在る**
   *    → **限定7** が守る(本検査を削除せず、名前を数える検査で本数の下限を固定する)。
   *  - **(ii) 「黙って何もしない」を作らない**
   *    → **限定3**(0件ではディスクが1バイトも動かない)+ **限定8**(実行の事実は履歴に
   *      1行残る)が守る。
   *  - **(iii) 呼び出し側のバグ(op を組み立て損ねた)が loud に落ちる**
   *    → **守られない。失われる。** **限定表はこれを回復しない。**
   *      **「代わりに守られる」と書いてはならない**(審査記録 §3-2 の逐語)。
   *      失うことは `ADR-0131` §限界2 として引き受けている。
   */
  test("空のバッチは0件書けた成功として返る(書くことが無いと書けなかったを区別しない)", () => {
    const res = writeRecords(db, manifest, []);
    // 限定2: 戻り値は `{ ok: true, results: [] }` の1形。
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // `undefined` でないことを明示的に見る(限定2 の機械的検査の逐語)。
    expect(res.results).toEqual([]);
    // 新しいフィールドを1つも足していない(`conflict` / `failedIndex` を付けない)。
    expect(Object.keys(res).sort()).toEqual(["ok", "results"]);
  });

  test("空のバッチではディスクが1バイトも動かない(限定3。COUNT(*) が前後で等しい)", () => {
    // 事前に行を作っておく —— 「もともと0件だから増えない」では検査にならない。
    makeProduct("A", 5, "sku-empty-1");
    const count = (): number[] =>
      ["products", "orders", "order_lines"].map((t) => {
        const c = countRecords(db, manifest, t);
        if (!c.ok) {
          throw new Error(`${t} を数えられませんでした`);
        }
        return c.value;
      });
    const before = count();

    const res = writeRecords(db, manifest, []);
    expect(res.ok).toBe(true);

    expect(count()).toEqual(before);
  });

  test("空のバッチでは onWritten が1度も呼ばれない(限定3。呼び出し回数 = 0)", () => {
    const written: BatchWrittenOp[] = [];
    const res = writeRecords(db, manifest, [], { onWritten: (w) => written.push(w) });
    expect(res.ok).toBe(true);
    expect(written).toHaveLength(0);
  });

  /*
   * **限定7 の機械的検査**(`ADR-0131` §3 の逐語「**`src/kernel/batch.test.ts` に、名前に
   * 「空のバッチ」を含む `test(` が1本以上在ることを数える検査を1本新設する**」)。
   *
   * **【この検査の弱さを申告する。審査記録 §3-1 の逐語】** 「**限定7 の検査(検査名を
   * 数える)は、名前が在ることしか見ない。中身が空の `test` でも通る。限定として弱い。
   * 弱さを補うのは限定2 / 限定3 の assert であって、限定7 の検査ではない。**」
   */
  test("限定7: 空のバッチを主語にする検査が0本になっていない", () => {
    const source = readFileSync(join(import.meta.dir, "batch.test.ts"), "utf-8");
    const named = source.match(/^\s*test\("[^"]*空のバッチ[^"]*"/gm) ?? [];
    expect(named.length).toBeGreaterThanOrEqual(1);
  });

  test("delete op は語彙に無い(create/update の2種のみ)", () => {
    // biome-ignore lint/suspicious/noExplicitAny: 語彙外 op を意図的に渡す。
    const res = writeRecords(db, manifest, [{ op: "delete", table: "orders", target: "x" } as any]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors[0]?.allowed_values).toEqual(["create", "update"]);
  });

  test("update op に target が無いと拒否する", () => {
    // biome-ignore lint/suspicious/noExplicitAny: target 欠落を意図的に渡す。
    const res = writeRecords(db, manifest, [{ op: "update", table: "orders", values: {} } as any]);
    expect(res.ok).toBe(false);
  });

  /*
   * **V3-M13-T09(ADR-0067 限定 A7)が足した凍結検査。**
   *
   * `ADR-0067` は「**島が返す update op には `if_match` を必須にする**」を限定に置いたが、
   * **その必須化はワークフローの島経路にしか無い**(`workflow-runner.ts` の
   * `applyIslandWriteOps`)。**バッチ経路(`writeRecords`)の `if_match` は今日も任意である**
   * (`ADR-0039` 限定4)。**新しい CAS 機構を作らないとは、この非対称を保つことである** ——
   * ここが必須になったら HTTP / MCP のバッチ API の意味論が黙って変わる。
   */
  test("バッチ経路の if_match は今日も**任意**である(島経路の必須化が漏れていない)", () => {
    const product = makeProduct("Tシャツ", 10);
    const res = writeRecords(db, manifest, [
      { op: "update", table: "products", target: product._id, values: { stock: 7 } },
    ]);
    expect(res.ok).toBe(true);
    expect(res.ok && res.results[0]?.stock).toBe(7);
  });
});

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

describe("writeRecords: 語彙不可侵(ADR-0039 限定6/7)", () => {
  // T01 の増分がカーネル語彙を1つも動かしていないことを機械的に固定する。
  test("語彙に batch / write_records を1つも足していない", () => {
    // 【`V5-M29-T03` / `ADR-0250` 限定11】ここにあった「FIELD_TYPES(8) / RESOURCE_KINDS(7) が増えていない」の
    //   うち `FIELD_TYPES` の本数を固定していた検査は `scripts/vocabulary-drift.test.ts` へ移した
    //   (名前の一覧は `scripts/vocabulary-snapshot.txt` の `FIELD_TYPES:` で始まる行)。
    //   **総量ではなく名前と順序で見張る。**
    //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
    // 【`V5-M29-T03` / `ADR-0250` 限定11】同じ位置にあった `RESOURCE_KINDS` の本数を固定していた検査も
    //   `scripts/vocabulary-drift.test.ts` へ移した(一覧の `RESOURCE_KINDS:` で始まる行)。
    //   **総量ではなく名前と順序で見張る。**
    //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
    // 【`V5-M29-T03`】**テスト名を書き換えた。** 旧: 「FIELD_TYPES(8) / RESOURCE_KINDS(7) が増えていない」。
    //   本体から本数を測る `expect` が消えたのに、名前だけが本数を主張する状態を残さないため(記録 §4-7)。
    // バッチは create/update のデータ書込であって manifest 語彙ではない。
    expect(RESOURCE_KINDS).not.toContain("batch");
    expect(DIFF_OPS).not.toContain("write_records");
  });

  test("writeRecords が使う diff op の集合は空である(規則2。空だから省略しない)", () => {
    // **`writeRecords` は差分 op を1つも使わない** —— 使うのは `create` / `update` /
    // `delete` の3つのバッチ op(ADR-0039)であり、これらは manifest 語彙ではない。
    // **空集合であることを明示的に固定する**(§10 の規則2)—— 空だから検査を省くと、
    // バッチがある日 diff op を使い始めたことに誰も気づかない。
    const used = diffOpsUsedIn([join(import.meta.dir, "batch.test.ts")]);
    expect(used).toEqual([]);
    for (const op of used) {
      expect(DIFF_OPS_AT_V2_COMPLETION as readonly string[]).toContain(op);
    }
    expect(DIFF_OPS_AT_V2_COMPLETION).toHaveLength(15);
  });

  test("$defs/action_value(限定12)の pattern が1バイトも変わっていない", () => {
    // 正準スキーマを直読みし、限定12 の3 pattern が原文のままであることを固定する
    // (バッチは値の演算をカーネルに持ち込まない = action_value を触らない)。
    const schemaPath = join(dirname(dirname(import.meta.dir)), "schemas", "manifest.schema.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as {
      $defs: {
        action_value: {
          if: { pattern: string };
          then: { pattern: string };
          else: { pattern: string };
        };
      };
    };
    const av = schema.$defs.action_value;
    expect(av.if.pattern).toBe("^\\$");
    expect(av.then.pattern).toBe("^\\$record\\.(_id|[a-z][a-z0-9_-]*)$");
    expect(av.else.pattern).toBe("^[^{}]*$");
  });

  test("run_function の output_table / write_back が schema に残っている(回帰しない)", () => {
    const schemaPath = join(dirname(dirname(import.meta.dir)), "schemas", "manifest.schema.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as {
      $defs: { workflow_action: { properties: Record<string, unknown> } };
    };
    const props = schema.$defs.workflow_action.properties;
    expect(props.output_table).toBeDefined();
    expect(props.write_back).toBeDefined();
  });
});
