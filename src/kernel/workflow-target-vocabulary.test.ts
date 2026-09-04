import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armManifestForAutomation,
  fixtureOwnerValues,
  seedAutomationActor,
} from "./automation-actor-fixture.test.ts";
import { applyManifestDdl as applyManifestDdlRaw } from "./ddl.ts";
import type { ValidationError, ValidationResult } from "./errors.ts";
import { createRecord as createRecordRaw, listRecords, type RecordRow } from "./records.ts";
import { validateReferentialIntegrity } from "./referential-integrity.ts";
import type { Manifest, Workflow } from "./types.ts";
import { validateManifest } from "./validate.ts";

/*
 * --- **【`V8-M26`(2026-08-10)で題材に「壁を開ける下ごしらえ」が入った】** -------------
 *
 * **`V8-M26-T03` が面(役割に束ねた権限)の既定を「閉じる」側へ倒したので、
 * ワークフロー・島の書込が題材ごと止まった。** **本ファイルの主題は面ではないので、
 * 題材の側で壁を開ける** —— **実装は1バイトも緩めていない。**
 * **中身は `src/kernel/automation-actor-fixture.test.ts` の doc に全部書いた。**
 */

/** DDL を当てる直前に壁を開け、当てた直後に書き手を1人立てる。 */
function applyManifestDdl(database: Database, target: Manifest): void {
  armManifestForAutomation(target);
  applyManifestDdlRaw(database, target);
  seedAutomationActor(database);
}

/** 行を作る(**下ごしらえが持ち主の列を足した表にだけ書き手を入れる**)。 */
function createRecord(
  database: Database,
  target: Manifest,
  tableId: string,
  values: Record<string, unknown>,
): ReturnType<typeof createRecordRaw> {
  armManifestForAutomation(target);
  return createRecordRaw(database, target, tableId, fixtureOwnerValues(target, tableId, values));
}

/**
 * EC-G13 target 語彙(cross-row workflow 更新 + 適用時検査。V2-M4-T02 / ADR-0040)の検査。
 *
 * `update_record` の `target` が受ける正規形は **3形のみ**:
 * (i) `$record._id`(自己更新。既存)/ (ii) `$record.<reference フィールドID>`(参照先の
 * 別テーブル行を狙う。**新規**)/ (iii) 定数 UUID リテラル(既存)。
 *
 * 適用時(referential-integrity)に確定するのは「target が構文的に正しい参照形か /
 * 参照フィールドが実在し reference 型か」まで —— **実行時の参照先『行』の実在は
 * 保証しない**(T-2 の原理的限界。過剰約束しない)。
 *
 * D2-a 非対称は **選択肢A**(リテラル target を UUID 形に限定)で実装し、`"bogus"` /
 * `"trigger_record"` を apply 時に拒否する。ただし UUID 形の実在しない _id は残る。
 */

// ---------------------------------------------------------------------------
// 共通マニフェスト(cross-row: order_line → product / payment → order)
// ---------------------------------------------------------------------------

/** 履歴テーブルの規約5列。 */
function historyFields() {
  return [
    { id: "ran_at", name: "実行時刻", type: "date" as const },
    { id: "workflow", name: "ワークフロー", type: "text" as const },
    { id: "trigger_type", name: "きっかけ", type: "text" as const },
    { id: "status", name: "結果", type: "text" as const },
    { id: "error", name: "エラー", type: "long_text" as const },
  ];
}

/**
 * EC 風のデータモデル。
 * - `products` … 参照先(在庫を持つ)
 * - `order_lines` … `product`(reference → products)/ `qty` / `note`(text)を持つ明細
 * - `orders` … `status`(決済で更新される)
 * - `payments` … `order`(reference → orders)を持つ決済受信行
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
            { id: "name", name: "名前", type: "text", required: true },
            { id: "stock", name: "在庫", type: "number" },
            { id: "touched", name: "更新印", type: "text" },
          ],
        },
        {
          id: "order_lines",
          name: "注文明細",
          fields: [
            { id: "product", name: "商品", type: "reference", reference_table: "products" },
            { id: "qty", name: "数量", type: "number" },
            { id: "note", name: "備考", type: "text" },
          ],
        },
        {
          id: "orders",
          name: "注文",
          fields: [
            { id: "status", name: "状態", type: "text" },
            { id: "payment_status", name: "決済状態", type: "text" },
          ],
        },
        {
          id: "payments",
          name: "決済受信",
          fields: [
            { id: "order", name: "対象注文", type: "reference", reference_table: "orders" },
            { id: "amount", name: "金額", type: "number" },
          ],
        },
        { id: "wf-runs", name: "実行履歴", fields: historyFields() },
      ],
      views: [{ id: "product-list", type: "list_view", table: "products", columns: ["name"] }],
    },
  };
}

function withWorkflow(manifest: Manifest, workflow: Workflow): Manifest {
  const next = structuredClone(manifest);
  next.app.workflows = [workflow];
  return next;
}

/** 明細作成 → 参照先 product を更新するワークフロー。 */
function lineToProductWorkflow(target: string, values: Record<string, string>): Workflow {
  return {
    id: "line-to-product",
    name: "明細作成で参照先商品を更新",
    trigger: { type: "on_create", table: "order_lines" },
    actions: [{ action: "update_record", table: "products", target, values }],
    history_table: "wf-runs",
  };
}

function expectInvalid(result: ValidationResult): ValidationError[] {
  expect(result.valid).toBe(false);
  if (result.valid) {
    throw new Error("expected invalid");
  }
  return result.errors;
}

function expectValid(result: ValidationResult): void {
  if (!result.valid) {
    throw new Error(`expected valid, got: ${JSON.stringify(result.errors)}`);
  }
  expect(result.valid).toBe(true);
}

function errorsAt(errors: ValidationError[], path: string): ValidationError[] {
  return errors.filter((error) => error.path === path);
}

// ===========================================================================
// 適用時検査(referential-integrity)
// ===========================================================================

describe("EC-G13 適用時検査: target 正規形(ADR-0040 限定3/4)", () => {
  test("$record.<reference フィールド> は valid(参照先行を狙える正規形)", () => {
    const manifest = withWorkflow(
      ecManifest(),
      lineToProductWorkflow("$record.product", { touched: "yes" }),
    );
    expectValid(validateReferentialIntegrity(manifest));
  });

  test("$record._id(自己更新)は従来どおり valid", () => {
    const manifest = withWorkflow(ecManifest(), {
      id: "self",
      name: "自己更新",
      trigger: { type: "on_create", table: "order_lines" },
      actions: [
        {
          action: "update_record",
          table: "order_lines",
          target: "$record._id",
          values: { note: "x" },
        },
      ],
      history_table: "wf-runs",
    });
    expectValid(validateReferentialIntegrity(manifest));
  });

  test("定数 UUID リテラル target は従来どおり valid(実在は apply 時に検査しない)", () => {
    const manifest = withWorkflow(
      ecManifest(),
      // 実在しない UUID でも apply は通る(過剰約束しない。T-2 限界)。
      lineToProductWorkflow("11111111-2222-3333-4444-555555555555", { touched: "yes" }),
    );
    expectValid(validateReferentialIntegrity(manifest));
  });

  test("非 reference フィールドを指す $record.<field> target は apply 時に拒否される", () => {
    // note は text 型(reference ではない)。
    const manifest = withWorkflow(
      ecManifest(),
      lineToProductWorkflow("$record.note", { touched: "yes" }),
    );
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const at = errorsAt(errors, "/app/workflows/0/actions/0/target");
    expect(at).toHaveLength(1);
    expect(at[0]?.message).toContain("note");
    expect(at[0]?.message).toContain("reference");
    // 参照フィールドの候補が提示される(自己修正できる)。
    expect(at[0]?.allowed_values).toContain("product");
  });

  test("実在しないフィールドを指す $record.<field> target は apply 時に拒否される", () => {
    const manifest = withWorkflow(
      ecManifest(),
      lineToProductWorkflow("$record.nonexistent", { touched: "yes" }),
    );
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const at = errorsAt(errors, "/app/workflows/0/actions/0/target");
    expect(at).toHaveLength(1);
    expect(at[0]?.message).toContain("nonexistent");
    expect(at[0]?.allowed_values).toContain("product");
  });

  test('"bogus"(参照形でない任意リテラル)は apply 時に拒否される(D2-a 選択肢A)', () => {
    const manifest = withWorkflow(ecManifest(), lineToProductWorkflow("bogus", { touched: "yes" }));
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const at = errorsAt(errors, "/app/workflows/0/actions/0/target");
    expect(at).toHaveLength(1);
    expect(at[0]?.message).toContain("bogus");
  });

  test('"trigger_record"(未定義疑似識別子)は apply 時に拒否される', () => {
    const manifest = withWorkflow(
      ecManifest(),
      lineToProductWorkflow("trigger_record", { touched: "yes" }),
    );
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    expect(errorsAt(errors, "/app/workflows/0/actions/0/target")).toHaveLength(1);
  });

  test("schedule × $record.<field> target は fail-closed(apply 拒否)", () => {
    const manifest = withWorkflow(ecManifest(), {
      id: "sched",
      name: "定時",
      trigger: { type: "schedule", at: { hour: 9, minute: 0 } },
      actions: [
        {
          action: "update_record",
          table: "products",
          target: "$record.product",
          values: { touched: "x" },
        },
      ],
      history_table: "wf-runs",
    });
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    // 類型7(schedule × $record.)が既に target を拒否している。
    expect(errorsAt(errors, "/app/workflows/0/actions/0/target").length).toBeGreaterThanOrEqual(1);
  });

  test("決済フロー: payment → $record.order で参照先 order を狙う target は valid", () => {
    const manifest = withWorkflow(ecManifest(), {
      id: "pay",
      name: "決済で注文を更新",
      trigger: { type: "on_create", table: "payments" },
      actions: [
        {
          action: "update_record",
          table: "orders",
          target: "$record.order",
          values: { payment_status: "paid" },
        },
      ],
      history_table: "wf-runs",
    });
    expectValid(validateReferentialIntegrity(manifest));
  });
});

describe("EC-G13 単一ホップのみ(ADR-0040 限定2): join/多段は書けない", () => {
  test("$record.a.b(多段参照)は schema pattern で拒否される", () => {
    const manifest = withWorkflow(
      ecManifest(),
      lineToProductWorkflow("$record.product.name", { touched: "yes" }),
    );
    // 構造(schema)検査の時点で action_value pattern が弾く。
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
  });
});

// ===========================================================================
// 実行時解決(本物の SQLite・モック無し)
// ===========================================================================

describe("EC-G13 実行時解決: cross-row 更新(本物の SQLite)", () => {
  let dir: string;
  let db: Database;
  let manifest: Manifest;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gp-target-vocab-"));
    db = new Database(join(dir, "app.sqlite"));
    manifest = ecManifest();
    applyManifestDdl(db, manifest);
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  function unwrap<T>(result: { ok: true; value: T } | { ok: false; errors: ValidationError[] }): T {
    if (!result.ok) {
      throw new Error(`期待に反して失敗: ${JSON.stringify(result.errors)}`);
    }
    return result.value;
  }

  function rowsOf(tableId: string): RecordRow[] {
    return unwrap(listRecords(db, manifest, tableId));
  }

  test("$record.<reference field> で参照先の別テーブル行を更新できる(明細→商品)", () => {
    manifest.app.workflows = [lineToProductWorkflow("$record.product", { touched: "済" })];
    const product = unwrap(createRecord(db, manifest, "products", { name: "本", stock: 5 }));

    // 明細を作成すると on_create が発火し、参照先 product が更新される。
    unwrap(createRecord(db, manifest, "order_lines", { product: product._id, qty: 1 }));

    const stored = rowsOf("products").find((row) => row._id === product._id);
    expect(stored?.touched).toBe("済");
    // 履歴は成功。
    const history = rowsOf("wf-runs");
    expect(history).toHaveLength(1);
    expect(history[0]?.status).toBe("success");
  });

  test("決済受信行 → $record.order で参照先 order を更新できる", () => {
    manifest.app.workflows = [
      {
        id: "pay",
        name: "決済で注文を更新",
        trigger: { type: "on_create", table: "payments" },
        actions: [
          {
            action: "update_record",
            table: "orders",
            target: "$record.order",
            values: { payment_status: "paid" },
          },
        ],
        history_table: "wf-runs",
      },
    ];
    const order = unwrap(createRecord(db, manifest, "orders", { status: "pending" }));

    unwrap(createRecord(db, manifest, "payments", { order: order._id, amount: 100 }));

    const stored = rowsOf("orders").find((row) => row._id === order._id);
    expect(stored?.payment_status).toBe("paid");
    // 元の status は触られていない(update は values のフィールドだけ書く)。
    expect(stored?.status).toBe("pending");
  });

  test("非 reference フィールドを $record.<field> target に書くと実行時に loud に失敗する", () => {
    // note は text 型。resolveValue が値を返しても target 検査で弾く。
    manifest.app.workflows = [lineToProductWorkflow("$record.note", { touched: "済" })];
    const product = unwrap(createRecord(db, manifest, "products", { name: "本", stock: 5 }));

    // 【V3-M13-T02 / ADR-0066 による期待値の更新】target 検査で弾かれるのは
    // **アクションの失敗**なので、決定が変わって**発火元(明細)の書込ごと成立しなくなった。**
    // 失敗の理由(黙って別値で更新しない)は呼び出し元の errors から読む。
    const created = createRecord(db, manifest, "order_lines", {
      product: product._id,
      qty: 1,
      note: "備考",
    });
    expect(created.ok).toBe(false);
    if (created.ok) {
      throw new Error("失敗するはずの書込が成功しました。");
    }
    expect(String(created.errors[0]?.message)).toContain("order_lines");

    // product は1バイトも更新されていない。
    const stored = rowsOf("products").find((row) => row._id === product._id);
    expect(stored?.touched).toBeNull();
    // 発火元の明細も残らない。
    expect(rowsOf("order_lines")).toHaveLength(0);
    // 【V3-M13-T04 による期待値の更新】失敗の履歴は巻き戻しの後に書き直されて残る
    // (ADR-0066 限定5)。**発火元の行が残らないことは1バイトも変わっていない。**
    expect(rowsOf("wf-runs").map((row) => row.status)).toEqual(["failure"]);
  });

  test("実行時の参照先『行』の実在は検査対象外(存在しない UUID を指しても apply/実行は通る)", () => {
    // 参照フィールド product が指す product 行を削除した状態を模す代わりに、
    // 定数 UUID(実在しない行)を target にする —— 過剰約束しないことの確認。
    const ghost = "99999999-8888-7777-6666-555555555555";
    manifest.app.workflows = [lineToProductWorkflow(ghost, { touched: "済" })];
    const product = unwrap(createRecord(db, manifest, "products", { name: "本", stock: 5 }));

    // 明細作成で発火。ghost 行は存在しないので updateRecord は「存在しません」で失敗する。
    // **これは適用時検査の射程外(実行層の話)であり、例外で落ちたりはしない。**
    // 【V3-M13-T02 / ADR-0066 による期待値の更新】その失敗により、
    // **発火元(明細)の書込も成立しなくなった。**
    const created = createRecord(db, manifest, "order_lines", { product: product._id, qty: 1 });
    expect(created.ok).toBe(false);

    // 実在の product は当然更新されていない(ghost を狙ったので)。
    const stored = rowsOf("products").find((row) => row._id === product._id);
    expect(stored?.touched).toBeNull();
    // 発火元の明細は残らないが、**失敗の履歴は書き直されて残る**(V3-M13-T04 / 限定5)。
    expect(rowsOf("order_lines")).toHaveLength(0);
    expect(rowsOf("wf-runs").map((row) => row.status)).toEqual(["failure"]);
  });
});
