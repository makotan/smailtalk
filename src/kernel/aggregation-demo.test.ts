import { Database } from "bun:sqlite";
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armManifestForAutomation,
  fixtureOwnerValues,
  seedAutomationActor,
} from "./automation-actor-fixture.test.ts";
import { applyManifestDdl as applyManifestDdlRaw } from "./ddl.ts";
import { ensureIslandRuntimeReady } from "./island-runner.ts";
import {
  createRecord as createRecordRaw,
  type ListRecordsOptions,
  listRecords,
  type RecordRow,
} from "./records.ts";
import { validateReferentialIntegrity } from "./referential-integrity.ts";
import { appDbPath } from "./storage-paths.ts";
import type { FunctionDef, ListView, Manifest, Workflow } from "./types.ts";
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
 * EC-G10 集計の実証(V2-M3-T04。ADR-0007 §8 台帳870行 / [v2-m3.md] §1 T04)。
 *
 * **既存語彙だけ**で参照 EC の集計(注文明細 order-lines → 注文合計 order-totals)が
 * 成立することを、本物の QuickJS-WASM・実ディスクの SQLite で実証する
 * (`run-function.test.ts` の作法に揃える。モックを1つも置かない)。
 *
 * **このファイルは新語彙を1つも足さない。** 使うのは既存の
 * `run_function` + `output_table` 全置換(ADR-0024)/ 既存 `list_view`(自レコード列を
 * 見せる)/ 既存の function の島(集計は島の JS。カーネルに count/sum/group_by を
 * 持ち込まない = ADR-0024 §7a)だけである。カーネルのコードは1バイトも変更しない。
 *
 * 実証すること:
 * - 集計(Σ line_total・件数)を島の JS で計算し、run_function で output_table へ全置換
 * - 既存 `list_view` が output_table(= 集計テーブル)を見せられる(§7a「島の出力をビューに出す形」)
 * - 追加のたびに全置換され、古い集計が残らない(W-C を避ける設計。ADR-0024)
 * - **T02 の record 書き戻し(行内計算列 line_total = Route B)と、この集計(親行/別テーブル
 *   の全置換 = output_table)が別経路であること**を対比して示す
 * - この実証マニフェストが既存 schema(`validateManifest`)を通る = 新語彙0 の機械的証明
 */

beforeAll(async () => {
  // 島ランタイムを事前ロード(同期の `runIslandSync` は未ロードだと fail-closed する)。
  await ensureIslandRuntimeReady();
});

const APP_ID = "ec-aggregation";

/** 履歴テーブルの5列(規約どおり)。 */
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
 * 注文合計を島の JS で集計する(order ごとに Σ line_total と件数)。
 * **集計は島の中**。カーネルに count / sum / group by を1つも持ち込まない(ADR-0024 §7a)。
 * 出力は「注文ごとに1行」= {order, subtotal, line_count}。
 */
const AGGREGATE_CODE = `(rows) => {
  const totals = {};
  for (const r of rows) {
    const key = r.order || '';
    if (!totals[key]) { totals[key] = { order: key, subtotal: 0, line_count: 0 }; }
    totals[key].subtotal += (r.line_total || 0);
    totals[key].line_count += 1;
  }
  return Object.keys(totals).sort().map((k) => totals[k]);
}`;

/**
 * 注文明細 / 注文合計 / 実行履歴 の3テーブル。functions / workflows は各テストが差す。
 * order-lines は line_total 列(Route B の行内計算列の書き戻し先)を持つ。
 */
function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "EC 集計実証",
      tables: [
        {
          id: "order-lines",
          name: "注文明細",
          fields: [
            { id: "order", name: "注文", type: "text" },
            { id: "unit_price", name: "単価", type: "number" },
            { id: "quantity", name: "数量", type: "number" },
            // 行内計算列(Route B = T02 の書き戻し先)。集計とは別経路であることを示す。
            { id: "line_total", name: "明細金額", type: "number" },
          ],
        },
        {
          id: "order-totals",
          name: "注文合計",
          fields: [
            { id: "order", name: "注文", type: "text" },
            { id: "subtotal", name: "小計", type: "number" },
            { id: "line_count", name: "明細件数", type: "number" },
          ],
        },
        { id: "wf-runs", name: "実行履歴", fields: historyFields() },
      ],
      // 既存 `list_view` が集計テーブル(output_table)を見せる形(§7a)。
      views: [
        {
          id: "order-totals-view",
          name: "注文合計一覧",
          type: "list_view",
          table: "order-totals",
          columns: ["order", "subtotal", "line_count"],
          sort: { field: "order", order: "asc" },
        } satisfies ListView,
      ],
    },
  };
}

/** 行内で unit_price * quantity を line_total へ書き戻す島(Route B = T02。source=record)。 */
const LINE_TOTAL_CODE = `(rec) => [{ line_total: rec.unit_price * rec.quantity }]`;

function lineTotalFunction(): FunctionDef {
  return {
    id: "line-total",
    name: "明細金額(行内)",
    code: LINE_TOTAL_CODE,
    input: { source: "record" },
    output: { fields: [{ id: "line_total", type: "number" }] },
    capabilities: [],
  };
}

/** 注文合計を集計する島(source=table order-lines → output_table 全置換)。 */
function aggregateFunction(): FunctionDef {
  return {
    id: "order-agg",
    name: "注文合計を集計",
    code: AGGREGATE_CODE,
    input: { source: "table", table: "order-lines" },
    output: {
      fields: [
        { id: "order", type: "text" },
        { id: "subtotal", type: "number" },
        { id: "line_count", type: "number" },
      ],
    },
    capabilities: [],
  };
}

/** on_create(order-lines) → run_function(集計)→ output_table 全置換。 */
function aggregateWorkflow(): Workflow {
  return {
    id: "reaggregate",
    name: "注文合計を再集計",
    trigger: { type: "on_create", table: "order-lines" },
    actions: [{ action: "run_function", function: "order-agg", output_table: "order-totals" }],
    history_table: "wf-runs",
  };
}

/** on_create(order-lines) → run_function(行内)→ write_back $record(Route B = T02)。 */
function lineTotalWorkflow(): Workflow {
  return {
    id: "compute-line-total",
    name: "明細金額を行内計算",
    trigger: { type: "on_create", table: "order-lines" },
    actions: [{ action: "run_function", function: "line-total", write_back: "$record" }],
    history_table: "wf-runs",
  };
}

let dataRoot: string;
let db: Database;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-aggregation-demo-"));
  const dbPath = appDbPath(dataRoot, APP_ID);
  await mkdir(join(dataRoot, "apps", APP_ID), { recursive: true });
  db = new Database(dbPath, { create: true });
});

afterEach(async () => {
  db.close();
  await rm(dataRoot, { recursive: true, force: true });
});

function addOrderLine(manifest: Manifest, fields: Record<string, unknown>): RecordRow {
  const result = createRecord(db, manifest, "order-lines", fields);
  if (!result.ok) {
    throw new Error(`order-line の作成に失敗: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

/**
 * **既存 `list_view` が output_table を見せる形**(§7a)を再現する。
 * `workflow-runner.ts` が list_view 入力を解決するのと同じ経路(view.sort/filter →
 * `listRecords`)を通し、view.columns の列だけを取り出す。新しいクエリ経路を作らない。
 */
function renderListView(manifest: Manifest, viewId: string): Record<string, unknown>[] {
  const view = manifest.app.views.find(
    (v): v is ListView => v.type === "list_view" && v.id === viewId,
  );
  if (view === undefined) {
    throw new Error(`list_view "${viewId}" が見つかりません`);
  }
  const options: ListRecordsOptions = {};
  if (view.sort !== undefined) {
    options.sort = view.sort;
  }
  if (view.filter !== undefined) {
    options.filter = view.filter;
  }
  const result = listRecords(db, manifest, view.table, options);
  if (!result.ok) {
    throw new Error(`list_view "${viewId}" の行を読めませんでした`);
  }
  // view.columns の列だけを見せる(list_view の columns の意味論)。
  return result.value.map((row) => {
    const projected: Record<string, unknown> = {};
    for (const col of view.columns) {
      projected[col] = row[col];
    }
    return projected;
  });
}

// --- 実証1: 既存語彙のみで 集計 → output_table → list_view が成立する -------------

test("新語彙0: 集計マニフェストが既存 schema(validateManifest)を通る", () => {
  // 既存 schema を通ること自体が「既存語彙だけで書けた」ことの機械的証明である
  // —— run_function / output_table / list_view いずれも既存キーで、集計語彙(count/sum)を
  // カーネルに1つも足していない。新キーを混ぜれば additionalProperties:false で落ちる。
  const manifest = baseManifest();
  manifest.app.functions = [aggregateFunction()];
  manifest.app.workflows = [aggregateWorkflow()];
  expect(validateManifest(manifest)).toEqual({ valid: true });
  expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
});

test("島の JS で Σ line_total と件数を集計し output_table へ全置換 → list_view が見せる", () => {
  const manifest = baseManifest();
  manifest.app.functions = [aggregateFunction()];
  manifest.app.workflows = [aggregateWorkflow()];
  applyManifestDdl(db, manifest);

  // 注文 A に2明細(line_total は明細に直接入れておく = 集計側の入力)。
  addOrderLine(manifest, { order: "A", unit_price: 100, quantity: 2, line_total: 200 });
  addOrderLine(manifest, { order: "A", unit_price: 50, quantity: 1, line_total: 50 });
  // 注文 B に1明細。
  addOrderLine(manifest, { order: "B", unit_price: 300, quantity: 3, line_total: 900 });

  // 集計テーブル(output_table)には注文ごとの Σ line_total と件数が入る。
  const totals = listRecords(db, manifest, "order-totals", {
    sort: { field: "order", order: "asc" },
  });
  expect(totals.ok).toBe(true);
  if (totals.ok) {
    expect(
      totals.value.map((r) => ({ order: r.order, subtotal: r.subtotal, line_count: r.line_count })),
    ).toEqual([
      { order: "A", subtotal: 250, line_count: 2 },
      { order: "B", subtotal: 900, line_count: 1 },
    ]);
  }

  // **既存 list_view が output_table を見せる**(§7a「島の出力をビューに出す形」)。
  expect(renderListView(manifest, "order-totals-view")).toEqual([
    { order: "A", subtotal: 250, line_count: 2 },
    { order: "B", subtotal: 900, line_count: 1 },
  ]);
});

test("追加のたびに全置換され、古い集計が残らない(W-C を避ける設計)", () => {
  const manifest = baseManifest();
  manifest.app.functions = [aggregateFunction()];
  manifest.app.workflows = [aggregateWorkflow()];
  applyManifestDdl(db, manifest);

  addOrderLine(manifest, { order: "A", unit_price: 100, quantity: 1, line_total: 100 });
  expect(renderListView(manifest, "order-totals-view")).toEqual([
    { order: "A", subtotal: 100, line_count: 1 },
  ]);

  // 同じ注文 A にもう1明細 → 全置換され、古い {A,100,1} は残らず {A,300,2} になる。
  addOrderLine(manifest, { order: "A", unit_price: 200, quantity: 1, line_total: 200 });
  expect(renderListView(manifest, "order-totals-view")).toEqual([
    { order: "A", subtotal: 300, line_count: 2 },
  ]);

  // 履歴は毎回成功。集計専用テーブル(order-totals)に累積の重複行は生まれない。
  const history = listRecords(db, manifest, "wf-runs");
  expect(history.ok).toBe(true);
  if (history.ok) {
    expect(history.value.length).toBe(2);
    expect(history.value.every((h) => h.status === "success")).toBe(true);
  }
});

// --- 実証2: 行内(Route B)と 集計(output_table 全置換)は別経路 --------------------

test("Route B(行内計算列 line_total)と 集計(別テーブル全置換)が別経路で共存する", () => {
  const manifest = baseManifest();
  manifest.app.functions = [lineTotalFunction(), aggregateFunction()];
  // 行内計算(write_back)を先に、その結果を集計(output_table 全置換)が読む。
  manifest.app.workflows = [lineTotalWorkflow(), aggregateWorkflow()];
  applyManifestDdl(db, manifest);

  // line_total は入れず作成する → Route B が unit_price*quantity を行内へ書き戻す。
  addOrderLine(manifest, { order: "A", unit_price: 120, quantity: 3 });
  addOrderLine(manifest, { order: "A", unit_price: 100, quantity: 2 });

  // (経路1)行内計算列 = Route B: line_total が order-lines の行自身に書かれている。
  const lines = listRecords(db, manifest, "order-lines");
  expect(lines.ok).toBe(true);
  if (lines.ok) {
    expect(lines.value.map((r) => r.line_total).sort()).toEqual([200, 360]);
  }

  // (経路2)集計 = output_table 全置換: 行内の line_total を Σ した合計が別テーブルに入る。
  expect(renderListView(manifest, "order-totals-view")).toEqual([
    { order: "A", subtotal: 560, line_count: 2 },
  ]);

  // 行内は order-lines 行自身(Route B)/ 集計は別テーブル order-totals(全置換)—— 別経路。
});
