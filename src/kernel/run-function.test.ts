import { Database } from "bun:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armOwnerColumns,
  FIXTURE_ACTOR_ID,
  grantOwnerAllTables,
  isFixtureOwnerTable,
  OWNER_FIELD,
  seedAutomationActor,
} from "./automation-actor-fixture.test.ts";
import { applyManifestDdl as applyManifestDdlRaw } from "./ddl.ts";
import type { ValidationError, ValidationResult } from "./errors.ts";
import { ensureIslandRuntimeReady } from "./island-runner.ts";
import {
  createRecord as createRecordRaw,
  listRecords,
  type RecordRow,
  updateRecord as updateRecordRaw,
} from "./records.ts";
import { validateReferentialIntegrity } from "./referential-integrity.ts";
import { appDbPath } from "./storage-paths.ts";
import type { FunctionDef, Manifest, Workflow } from "./types.ts";
import { validateManifest } from "./validate.ts";
import { runScheduledWorkflow } from "./workflow-runner.ts";

/**
 * `run_function`(ワークフローアクション)と島の同期実行(ADR-0024 / V1-M6-T05 第2段)。
 *
 * **本物の QuickJS-WASM・実ディスクの SQLite で走らせる。モックを1つも置かない**
 * (`call-external.test.ts` / `island-runner.test.ts` の作法に揃える)。マニフェストを手で
 * 組み、実行経路(`createRecord` → `runWorkflows` → `runAction` → 島)を直接叩く。
 *
 * 完了条件の担保:
 * - schema / 参照整合性が run_function を受理・不正を拒否する
 * - **F-7 の自己更新集計**が成立する(月ごとに数える島 → output_table へ全置換)
 * - 出力が必ず output.fields で検証される(型違いは fail-closed で output_table を壊さない)
 * - 島の暴走(無限ループ)は timeout で止まり、ホストは健全・失敗は履歴に残る
 * - 宣言外の外部到達は島から不可(T04 と一貫)
 */

beforeAll(async () => {
  // 島ランタイムを事前ロードする(同期の `runIslandSync` は未ロードだと fail-closed する)。
  await ensureIslandRuntimeReady();
});

const APP_ID = "member-tracker";

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

/** 月ごとに件数を数える島(集計は**島の中**。カーネルに count / group by を持ち込まない。§7a)。 */
const COUNT_BY_MONTH_CODE = `(rows) => {
  const counts = {};
  for (const r of rows) {
    const month = (r.joined_at || '').slice(0, 7);
    counts[month] = (counts[month] || 0) + 1;
  }
  return Object.keys(counts).sort().map((month) => ({ month, count: counts[month] }));
}`;

/** 会員 / 月次集計 / 外部到達プローブ / 履歴 の4テーブル。functions / workflows は各テストが差す。 */
function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "会員管理",
      tables: [
        {
          id: "members",
          name: "会員",
          fields: [
            { id: "name", name: "名前", type: "text", required: true },
            { id: "joined_at", name: "入会日", type: "date" },
          ],
        },
        {
          id: "monthly-counts",
          name: "月次集計",
          fields: [
            { id: "month", name: "月", type: "text" },
            { id: "count", name: "件数", type: "number" },
          ],
        },
        {
          id: "probe",
          name: "外部到達プローブ",
          fields: [{ id: "reached", name: "到達型", type: "text" }],
        },
        { id: "wf-runs", name: "実行履歴", fields: historyFields() },
      ],
      views: [],
    },
  };
}

/** 月次集計の関数(source=table members)。code / output は上書き可能。 */
function countFunction(overrides: Partial<FunctionDef> = {}): FunctionDef {
  return {
    id: "count-by-month",
    name: "月ごとに会員を数える",
    code: COUNT_BY_MONTH_CODE,
    input: { source: "table", table: "members" },
    output: {
      fields: [
        { id: "month", type: "text" },
        { id: "count", type: "number" },
      ],
    },
    capabilities: [],
    ...overrides,
  };
}

/** on_create(members) → run_function を1本持つワークフロー。 */
function runFunctionWorkflow(functionId: string, outputTable: string): Workflow {
  return {
    id: "recount",
    name: "月次再集計",
    trigger: { type: "on_create", table: "members" },
    actions: [{ action: "run_function", function: functionId, output_table: outputTable }],
    history_table: "wf-runs",
  };
}

/*
 * --- **【`V8-M26`(2026-08-10)で題材に「壁を開ける下ごしらえ」が入った】** -------------
 *
 * **`V8-M26-T03` が面(役割に束ねた権限)の既定を「閉じる」側へ倒したので、
 * 島の書込(`run_function` の `output_table`)が題材ごと止まった**(17件が赤になった)。
 * **本ファイルの主題は島の実行であって、面ではない。** **題材の側で壁を開ける** ——
 * **実装は1バイトも緩めていない。**
 *
 * **中身は `src/kernel/automation-actor-fixture.test.ts` の doc に全部書いた**
 * (書き手を1人立てる / 持ち主の列を足す / 既定3役割に規則を配る)。
 */

/** DDL を当てる直前に列を足し、当てた直後に書き手を1人立てる。 */
function applyManifestDdl(database: Database, target: Manifest): void {
  armOwnerColumns(target);
  grantOwnerAllTables(target);
  applyManifestDdlRaw(database, target);
  seedAutomationActor(database);
}

/**
 * 行を作る。**この下ごしらえが持ち主の列を足したテーブルにだけ、書き手を既定で入れる**
 * (**題材が元から持っていた `st_owner` は1バイトも触らない** —— 「持ち主が空の共有行」を
 * 作ることが主題の検査を壊さないため)。
 *
 * **題材が明示した持ち主(`user-a` など)は、その場で `owner` として登録する** ——
 * **登録しないと面から見て未ログインと同じ主体になり、この題材のどのテーブルにも書けない。**
 */
function createRecord(
  database: Database,
  target: Manifest,
  tableId: string,
  values: Record<string, unknown>,
): ReturnType<typeof createRecordRaw> {
  grantOwnerAllTables(target);
  const declared = values[OWNER_FIELD.id];
  if (typeof declared === "string" && declared !== "") {
    seedAutomationActor(database, declared);
  }
  const filled =
    isFixtureOwnerTable(target, tableId) && declared === undefined
      ? { ...values, [OWNER_FIELD.id]: FIXTURE_ACTOR_ID }
      : values;
  return createRecordRaw(database, target, tableId, filled);
}

/** 行を更新する(**`st_owner` は1バイトも触らない**)。 */
function updateRecord(
  database: Database,
  target: Manifest,
  tableId: string,
  recordId: string,
  values: Record<string, unknown>,
): ReturnType<typeof updateRecordRaw> {
  grantOwnerAllTables(target);
  return updateRecordRaw(database, target, tableId, recordId, values);
}

let dataRoot: string;
let db: Database;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-run-function-"));
  const dbPath = appDbPath(dataRoot, APP_ID);
  await mkdir(join(dataRoot, "apps", APP_ID), { recursive: true });
  db = new Database(dbPath, { create: true });
});

afterEach(async () => {
  db.close();
  await rm(dataRoot, { recursive: true, force: true });
});

/** monthly-counts を月昇順で {month, count} に整えて読む。 */
function readMonthly(manifest: Manifest): { month: string; count: number }[] {
  const result = listRecords(db, manifest, "monthly-counts", {
    sort: { field: "month", order: "asc" },
  });
  if (!result.ok) {
    throw new Error("monthly-counts を読めませんでした");
  }
  return result.value.map((row) => ({ month: row.month as string, count: row.count as number }));
}

/** wf-runs の (status, error) を作成順で読む。 */
function readHistory(manifest: Manifest): { status: string; error: string | null }[] {
  const result = listRecords(db, manifest, "wf-runs");
  if (!result.ok) {
    throw new Error("wf-runs を読めませんでした");
  }
  return result.value.map((row) => ({
    status: row.status as string,
    error: (row.error ?? null) as string | null,
  }));
}

/** 会員を1件足す(ワークフローが発火する)。 */
function addMember(manifest: Manifest, name: string, joinedAt: string): RecordRow {
  const result = createRecord(db, manifest, "members", { name, joined_at: joinedAt });
  if (!result.ok) {
    throw new Error(`会員 "${name}" の作成に失敗: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

// --- スキーマ(構造検証)-------------------------------------------------------

/** 失敗であることを確認しつつ errors を取り出す。 */
function expectInvalid(result: ValidationResult): ValidationError[] {
  expect(result.valid).toBe(false);
  if (result.valid) {
    throw new Error("expected invalid");
  }
  return result.errors;
}

describe("run_function のスキーマ(構造検証)", () => {
  function manifestWithAction(action: unknown): Manifest {
    const manifest = baseManifest();
    manifest.app.functions = [countFunction()];
    manifest.app.workflows = [
      {
        id: "recount",
        name: "月次再集計",
        trigger: { type: "on_create", table: "members" },
        // biome-ignore lint/suspicious/noExplicitAny: 異常系の構造を意図的に組む
        actions: [action as any],
        history_table: "wf-runs",
      },
    ];
    return manifest;
  }

  test("run_function(function + output_table)を受理する", () => {
    const manifest = manifestWithAction({
      action: "run_function",
      function: "count-by-month",
      output_table: "monthly-counts",
    });
    expect(validateManifest(manifest)).toEqual({ valid: true });
  });

  test("function が欠けると拒否する", () => {
    expectInvalid(
      validateManifest(
        manifestWithAction({ action: "run_function", output_table: "monthly-counts" }),
      ),
    );
  });

  test("output_table が欠けると拒否する", () => {
    expectInvalid(
      validateManifest(manifestWithAction({ action: "run_function", function: "count-by-month" })),
    );
  });

  test("他アクションのキー(table / values 等)を混ぜると拒否する", () => {
    expectInvalid(
      validateManifest(
        manifestWithAction({
          action: "run_function",
          function: "count-by-month",
          output_table: "monthly-counts",
          table: "members",
          values: { name: "x" },
        }),
      ),
    );
  });

  test("output_table にシステムテーブル(_apps)を指すと拒否する(限定7。resource_id が担保)", () => {
    expectInvalid(
      validateManifest(
        manifestWithAction({
          action: "run_function",
          function: "count-by-month",
          output_table: "_apps",
        }),
      ),
    );
  });
});

// --- 参照整合性(apply_diff 時に走る)-----------------------------------------

describe("run_function の参照整合性", () => {
  function manifestWith(functionId: string, outputTable: string): Manifest {
    const manifest = baseManifest();
    manifest.app.functions = [countFunction()];
    manifest.app.workflows = [runFunctionWorkflow(functionId, outputTable)];
    return manifest;
  }

  test("実在する function / output_table を指せば valid", () => {
    expect(validateReferentialIntegrity(manifestWith("count-by-month", "monthly-counts"))).toEqual({
      valid: true,
    });
  });

  test("存在しない function を指す run_function を拒否する", () => {
    const errors = expectInvalid(
      validateReferentialIntegrity(manifestWith("no-such-fn", "monthly-counts")),
    );
    expect(errors.some((e) => e.path.endsWith("/function"))).toBe(true);
  });

  test("存在しない output_table を指す run_function を拒否する", () => {
    const errors = expectInvalid(
      validateReferentialIntegrity(manifestWith("count-by-month", "no-such-table")),
    );
    expect(errors.some((e) => e.path.endsWith("/output_table"))).toBe(true);
  });
});

// --- 実行 E2E ----------------------------------------------------------------

describe("run_function の実行(自己更新集計・全置換)", () => {
  function setup(): Manifest {
    const manifest = baseManifest();
    manifest.app.functions = [countFunction()];
    manifest.app.workflows = [runFunctionWorkflow("count-by-month", "monthly-counts")];
    applyManifestDdl(db, manifest);
    return manifest;
  }

  test("トリガーで正しい月次件数が output_table に入り、追加のたびに全置換される", () => {
    const manifest = setup();

    // 1件目(2026-01)。
    addMember(manifest, "Alice", "2026-01-10");
    expect(readMonthly(manifest)).toEqual([{ month: "2026-01", count: 1 }]);

    // 2件目も 2026-01 → **全置換**され、[{2026-01, 2}] になる(古い {2026-01,1} は残らない)。
    addMember(manifest, "Bob", "2026-01-20");
    expect(readMonthly(manifest)).toEqual([{ month: "2026-01", count: 2 }]);

    // 3件目は 2026-03 → 月をまたいで再集計される。
    addMember(manifest, "Carol", "2026-03-05");
    expect(readMonthly(manifest)).toEqual([
      { month: "2026-01", count: 2 },
      { month: "2026-03", count: 1 },
    ]);

    // 履歴は3回とも成功で、失敗は1件も無い。
    const history = readHistory(manifest);
    expect(history.length).toBe(3);
    expect(history.every((h) => h.status === "success")).toBe(true);
  });
});

describe("run_function の出力検証(fail-closed)", () => {
  test("island が output.fields に合わない行(型違い)を返したら output_table は変わらず履歴に失敗", () => {
    const manifest = baseManifest();
    // count を文字列で返す壊れた島(output.fields では count は number)。
    manifest.app.functions = [
      countFunction({ code: `(rows) => [{ month: "2026-01", count: "twelve" }]` }),
    ];
    manifest.app.workflows = [runFunctionWorkflow("count-by-month", "monthly-counts")];
    applyManifestDdl(db, manifest);

    // output_table に番人の行を直接1件入れておく(ワークフローは発火しない)。
    createRecord(db, manifest, "monthly-counts", { month: "sentinel", count: 0 });

    // 会員を足すと run_function が走り、出力検証で fail-closed する。
    // 【V3-M13-T02 / ADR-0066 による期待値の更新】fail-closed は**アクションの失敗**なので、
    // **発火元(会員)の書込ごと成立しなくなった。**fail-closed そのものは変わっていない。
    const created = createRecord(db, manifest, "members", {
      name: "Alice",
      joined_at: "2026-01-10",
    });
    expect(created.ok).toBe(false);
    if (created.ok) {
      throw new Error("失敗するはずの書込が成功しました。");
    }
    expect(String(created.errors[0]?.message)).toContain("スキーマ検証");

    // **output_table は1バイトも変わっていない**(番人の行がそのまま残る)。
    expect(readMonthly(manifest)).toEqual([{ month: "sentinel", count: 0 }]);

    // 【V3-M13-T04 による期待値の更新】失敗の履歴は巻き戻しの後に書き直されて残る
    // (ADR-0066 限定5)。**島が止まったこと自体は1バイトも変わっていない。**
    expect(readHistory(manifest).length).toBe(1);
  });
});

describe("run_function の暴走(無限ループ)", () => {
  test("島が無限ループしても timeout で止まり、ホスト健全・ワークフローは failure として記録", () => {
    const manifest = baseManifest();
    manifest.app.functions = [countFunction({ code: `(rows) => { while (true) {} }` })];
    manifest.app.workflows = [runFunctionWorkflow("count-by-month", "monthly-counts")];
    applyManifestDdl(db, manifest);

    // 【V3-M13-T02 / ADR-0066 による期待値の更新】以前はここで「会員の作成そのものは
    // 成功する(分離)」を測っていた。**`0013:417` の前段が決定として破られた**ので、
    // timeout の失敗は会員の作成ごと成立しなくさせる。**島が止まること自体は無傷。**
    const first = createRecord(db, manifest, "members", { name: "Alice", joined_at: "2026-01-10" });
    expect(first.ok).toBe(false);
    if (first.ok) {
      throw new Error("失敗するはずの書込が成功しました。");
    }
    expect(String(first.errors[0]?.message)).toContain("timeout");

    // output_table は空のまま(検証以前に島が止まる)。
    expect(readMonthly(manifest)).toEqual([]);

    // ホストは健全:もう1件足しても(また止まる)例外にはならず、同じ形で失敗が返る。
    const second = createRecord(db, manifest, "members", { name: "Bob", joined_at: "2026-02-01" });
    expect(second.ok).toBe(false);
    expect(listRecords(db, manifest, "members").ok).toBe(true);
    // 【V3-M13-T04 による期待値の更新】2回の書込のどちらの失敗も履歴に残る(限定5)。
    expect(readHistory(manifest).length).toBe(2);
  });
});

describe("run_function の capability(宣言外の外部到達は不可。T04 と一貫)", () => {
  test("capability を宣言しない島からは fetch 等の外部到達手段が存在しない(undefined)", () => {
    const manifest = baseManifest();
    // capabilities 宣言なし。島の中で外部到達手段の型を返すだけ。
    manifest.app.functions = [
      {
        id: "probe-reach",
        name: "外部到達プローブ",
        code: `(rows) => [{ reached: typeof fetch }]`,
        input: { source: "table", table: "members" },
        output: { fields: [{ id: "reached", type: "text" }] },
        capabilities: [],
      },
    ];
    manifest.app.workflows = [runFunctionWorkflow("probe-reach", "probe")];
    applyManifestDdl(db, manifest);

    addMember(manifest, "Alice", "2026-01-10");

    const probe = listRecords(db, manifest, "probe");
    expect(probe.ok).toBe(true);
    if (probe.ok) {
      expect(probe.value.map((row) => row.reached)).toEqual(["undefined"]);
    }
  });
});

// --- EC-G6 演算 = record 書き戻しモード(Route B。ADR-0037。V2-M3-T02)-----------
//
// 島の JS で unit_price * quantity を計算し、トリガー元 order-lines 行自身の line_total
// 列へ書き戻す(行内計算列)。演算は島の中・カーネルは式言語を持たない($defs/action_value
// 不変 = ADR-0013 限定12 不可侵)。output_table 全置換モードとは排他。

/** order-lines(単価・数量・金額・計算フラグ)を足したベース。functions / workflows は各テストが差す。 */
function writeBackBase(): Manifest {
  const manifest = baseManifest();
  manifest.app.tables.push({
    id: "order-lines",
    name: "注文明細",
    fields: [
      { id: "unit_price", name: "単価", type: "number" },
      { id: "quantity", name: "数量", type: "number" },
      { id: "line_total", name: "金額", type: "number" },
      { id: "compute", name: "計算する", type: "text" },
    ],
  });
  return manifest;
}

/** unit_price * quantity を line_total に返す島(input.source = record = トリガー元1行)。 */
const LINE_TOTAL_CODE = `(rec) => [{ line_total: rec.unit_price * rec.quantity }]`;

function lineTotalFunction(overrides: Partial<FunctionDef> = {}): FunctionDef {
  return {
    id: "line-total",
    name: "明細金額",
    code: LINE_TOTAL_CODE,
    input: { source: "record" },
    output: { fields: [{ id: "line_total", type: "number" }] },
    capabilities: [],
    ...overrides,
  };
}

/** write_back で order-lines 行自身へ書き戻すワークフロー。trigger 種別 / when は上書き可能。 */
function writeBackWorkflow(
  opts: {
    trigger?: Workflow["trigger"];
    when?: { field: string; equals: string | number | boolean };
  } = {},
): Workflow {
  const action: Record<string, unknown> = {
    action: "run_function",
    function: "line-total",
    write_back: "$record",
  };
  if (opts.when !== undefined) {
    action.when = opts.when;
  }
  return {
    id: "compute-line-total",
    name: "明細金額を計算",
    trigger: opts.trigger ?? { type: "on_create", table: "order-lines" },
    // biome-ignore lint/suspicious/noExplicitAny: when を条件で足すため
    actions: [action as any],
    history_table: "wf-runs",
  };
}

function addOrderLine(manifest: Manifest, fields: Record<string, unknown>): RecordRow {
  const result = createRecord(db, manifest, "order-lines", fields);
  if (!result.ok) {
    throw new Error(`order-line の作成に失敗: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

function readOrderLines(manifest: Manifest): RecordRow[] {
  const result = listRecords(db, manifest, "order-lines");
  if (!result.ok) {
    throw new Error("order-lines を読めませんでした");
  }
  return result.value;
}

describe("V2-M3-T02 write_back のスキーマ(排他・const)", () => {
  function manifestWithAction(action: unknown): Manifest {
    const manifest = writeBackBase();
    manifest.app.functions = [lineTotalFunction()];
    manifest.app.workflows = [
      {
        id: "compute-line-total",
        name: "明細金額を計算",
        trigger: { type: "on_create", table: "order-lines" },
        // biome-ignore lint/suspicious/noExplicitAny: 異常系の構造を意図的に組む
        actions: [action as any],
        history_table: "wf-runs",
      },
    ];
    return manifest;
  }

  test('write_back "$record"(output_table なし)を受理する', () => {
    expect(
      validateManifest(
        manifestWithAction({
          action: "run_function",
          function: "line-total",
          write_back: "$record",
        }),
      ),
    ).toEqual({ valid: true });
  });

  test("write_back と output_table の併存を拒否する(排他。限定6)", () => {
    expectInvalid(
      validateManifest(
        manifestWithAction({
          action: "run_function",
          function: "line-total",
          write_back: "$record",
          output_table: "monthly-counts",
        }),
      ),
    );
  });

  test("write_back も output_table も無い run_function を拒否する(どちらか一方が必須)", () => {
    expectInvalid(
      validateManifest(manifestWithAction({ action: "run_function", function: "line-total" })),
    );
  });

  test('write_back の値が "$record" 以外(別テーブル名)なら拒否する(const。別行を指せない。限定7)', () => {
    expectInvalid(
      validateManifest(
        manifestWithAction({
          action: "run_function",
          function: "line-total",
          write_back: "order-lines",
        }),
      ),
    );
  });

  test("create_record に write_back を混ぜると拒否する(write_back は run_function 専用)", () => {
    expectInvalid(
      validateManifest(
        manifestWithAction({
          action: "create_record",
          table: "order-lines",
          values: { unit_price: "1" },
          write_back: "$record",
        }),
      ),
    );
  });
});

describe("V2-M3-T02 write_back の参照整合性(apply 時)", () => {
  function manifestWith(fn: FunctionDef, wf: Workflow): Manifest {
    const manifest = writeBackBase();
    manifest.app.functions = [fn];
    manifest.app.workflows = [wf];
    return manifest;
  }

  test("実在フィールドへ書き戻す write_back は valid", () => {
    expect(
      validateReferentialIntegrity(manifestWith(lineTotalFunction(), writeBackWorkflow())),
    ).toEqual({ valid: true });
  });

  test("schedule × write_back は apply 時に拒否する(トリガー元レコードが無い。fail-closed)", () => {
    const errors = expectInvalid(
      validateReferentialIntegrity(
        manifestWith(
          lineTotalFunction(),
          writeBackWorkflow({ trigger: { type: "schedule", at: { hour: 9, minute: 0 } } }),
        ),
      ),
    );
    expect(errors.some((e) => e.path.endsWith("/write_back"))).toBe(true);
  });

  test("output.fields がトリガー元テーブルに無いフィールドなら apply 時に拒否する(実在フィールド限定)", () => {
    const errors = expectInvalid(
      validateReferentialIntegrity(
        manifestWith(
          lineTotalFunction({ output: { fields: [{ id: "no_such_field", type: "number" }] } }),
          writeBackWorkflow(),
        ),
      ),
    );
    expect(errors.some((e) => e.path.endsWith("/write_back"))).toBe(true);
  });
});

describe("V2-M3-T02 write_back の実行(行内演算 = トリガー元レコードへ書き戻し)", () => {
  function setup(
    opts: Parameters<typeof writeBackWorkflow>[0] & { fn?: FunctionDef } = {},
  ): Manifest {
    const manifest = writeBackBase();
    manifest.app.functions = [opts.fn ?? lineTotalFunction()];
    manifest.app.workflows = [writeBackWorkflow(opts)];
    applyManifestDdl(db, manifest);
    return manifest;
  }

  test("島で unit_price * quantity を計算し line_total へ書き戻す(行内計算列が成立)", () => {
    const manifest = setup();
    const line = addOrderLine(manifest, { unit_price: 120, quantity: 3 });

    const rows = readOrderLines(manifest);
    expect(rows).toHaveLength(1);
    expect(rows[0]?._id).toBe(line._id);
    // 書き戻された値が永続する普通のレコード列である(§4a-3。都度計算ではない)。
    expect(rows[0]?.line_total).toBe(360);
    // 他の列(unit_price / quantity)は書き換わらない(部分更新)。
    expect(rows[0]?.unit_price).toBe(120);
    expect(rows[0]?.quantity).toBe(3);

    // 履歴は成功で、output_table 全置換モードのテーブルには一切触れていない。
    const history = readHistory(manifest);
    expect(history).toHaveLength(1);
    expect(history[0]?.status).toBe("success");
    expect(readMonthly(manifest)).toEqual([]);
  });

  test("出力検証を通る(型違いは fail-closed でレコードを1バイトも変えない)", () => {
    // line_total を文字列で返す壊れた島(output.fields では number)。
    const manifest = setup({
      fn: lineTotalFunction({ code: `(rec) => [{ line_total: "たくさん" }]` }),
    });
    // 【期待値の更新(ADR-0066)】fail-closed が発火元の書込ごと落とすようになった。
    const created = createRecord(db, manifest, "order-lines", { unit_price: 120, quantity: 3 });
    expect(created.ok).toBe(false);
    if (created.ok) {
      throw new Error("失敗するはずの書込が成功しました。");
    }
    expect(String(created.errors[0]?.message)).toContain("スキーマ検証");
    // 行そのものが残らない(以前は「行は残るが line_total が書かれない」だった)。
    expect(readOrderLines(manifest)).toHaveLength(0);
  });

  test("島が複数行を返したら fail-closed(単数強制。ADR-0037 限定5)", () => {
    const manifest = setup({
      fn: lineTotalFunction({
        code: `(rec) => [{ line_total: 1 }, { line_total: 2 }]`,
      }),
    });
    // 【期待値の更新(ADR-0066)】同上。単数強制そのものは1バイトも変わっていない。
    const created = createRecord(db, manifest, "order-lines", { unit_price: 120, quantity: 3 });
    expect(created.ok).toBe(false);
    if (created.ok) {
      throw new Error("失敗するはずの書込が成功しました。");
    }
    expect(String(created.errors[0]?.message)).toContain("1行");
    expect(readOrderLines(manifest)).toHaveLength(0);
  });

  test("when 一致のときだけ write_back する(T01 との整合。条件付き書き戻し)", () => {
    const manifest = setup({ when: { field: "compute", equals: "yes" } });

    // compute=yes → 書き戻す。
    addOrderLine(manifest, { unit_price: 100, quantity: 2, compute: "yes" });
    // compute=no → スキップ(line_total は書かれない)。
    addOrderLine(manifest, { unit_price: 100, quantity: 2, compute: "no" });

    const rows = readOrderLines(manifest).sort((a, b) =>
      String(a.compute).localeCompare(String(b.compute)),
    );
    const no = rows.find((r) => r.compute === "no");
    const yes = rows.find((r) => r.compute === "yes");
    expect(yes?.line_total).toBe(200);
    expect(no?.line_total ?? null).toBeNull();
  });
});

describe("V2-M3-T02 write_back の自己更新(既存機構で止まる)", () => {
  test("on_update × write_back の再発火は firedRecords が止める(20回書き換えない・ホスト健全)", () => {
    const manifest = writeBackBase();
    manifest.app.functions = [lineTotalFunction()];
    // on_update トリガー: 書き戻し(updateRecord)が同じ on_update を再発火させうる。
    manifest.app.workflows = [
      writeBackWorkflow({ trigger: { type: "on_update", table: "order-lines" } }),
    ];
    applyManifestDdl(db, manifest);

    // レコードを1件作る(on_update トリガーなので作成では発火しない)。
    const created = createRecord(db, manifest, "order-lines", { unit_price: 50, quantity: 4 });
    if (!created.ok) {
      throw new Error("作成に失敗");
    }
    // 外部から1回更新する → on_update 発火 → write_back(updateRecord)→ 再発火は抑止される。
    //
    // 【V3-M13-T13 / ADR-0066 §改訂1 による期待値の更新。**経緯を残す**】
    // `V3-M13-T01` の限定16 は「`firedRecords` による停止も**失敗**として発火元を巻き戻す」
    // と定め、`V3-M13-T02` がそれを字義どおり実装した。**その結果 `on_update` ×
    // `write_back` は必ず失敗するようになった**(書き戻しの updateRecord が必ず抑止に
    // 当たるため)。`V3-M13-T13` の門A本審査(`V3-M9-G1` の2回目)が限定16 の適用範囲を
    // 狭め、**再発火抑止を「失敗」から外した。** 本検査の期待値は
    // 「書き戻しが1回効き、抑止が履歴に loud に残る」形へ戻っている。
    // **暴走しない(有限で止まる)ことは、3つの時点のどれでも1バイトも変わっていない。**
    const updated = updateRecord(db, manifest, "order-lines", created.value._id, { quantity: 4 });
    expect(updated.ok).toBe(true);

    // 書き戻しは**1回だけ**効く。20回書き換えて止まる形にはなっていない(暴走はしない)。
    const rows = readOrderLines(manifest);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.line_total).toBe(200);
    expect(rows[0]?.quantity).toBe(4);
    // 抑止は履歴に loud に残る(憲法6)。
    // 【V4-M4-T02 / ADR-0072 による期待値の更新】その1行の `status` が3値目になった。
    // **書き戻し(Route B)が「必ず失敗する」ように見える状態が、記録の上でも消える。**
    const suppressed = readHistory(manifest).filter((row) => row.status === "suppressed");
    expect(suppressed).toHaveLength(1);
    expect(String(suppressed[0]?.error)).toContain("再発火");
    expect(readHistory(manifest).filter((row) => row.status === "failure")).toHaveLength(0);

    // ホストは健全:さらに更新しても例外にはならず、同じ形で通る。
    const again = updateRecord(db, manifest, "order-lines", created.value._id, { quantity: 5 });
    expect(again.ok).toBe(true);
    expect(readOrderLines(manifest)[0]?.line_total).toBe(250);
  });
});

// ---------------------------------------------------------------------------
// V3-M13-T13: 書き戻し(Route B)が `on_update` でも動く(ADR-0066 §改訂1)
//
// `V3-M13-T02` が ADR-0066 限定16(連鎖の停止も失敗として扱う)を字義どおり実装した
// 結果、`on_update` × `write_back` は**必ず失敗**するようになっていた —— 書き戻しの
// `updateRecord` が必ず再発火抑止に当たり、外側の更新ごと成立しなかった。
// `V3-M13-T13` の門A本審査(`V3-M9-G1` の2回目)が限定16 の適用範囲を狭め、
// **再発火抑止を「失敗」から外した。深度上限は今日も「失敗」である。**
// ---------------------------------------------------------------------------

describe("V3-M13-T13 write_back がトリガー種別によらず動く(ADR-0066 §改訂1)", () => {
  function setup(trigger: Workflow["trigger"], fn?: FunctionDef): Manifest {
    const manifest = writeBackBase();
    manifest.app.functions = [fn ?? lineTotalFunction()];
    manifest.app.workflows = [writeBackWorkflow({ trigger })];
    applyManifestDdl(db, manifest);
    return manifest;
  }

  test("on_update × write_back —— 更新が成立し、行内計算列が書き戻される", () => {
    const manifest = setup({ type: "on_update", table: "order-lines" });
    const created = createRecord(db, manifest, "order-lines", { unit_price: 50, quantity: 4 });
    if (!created.ok) {
      throw new Error("作成に失敗");
    }

    const updated = updateRecord(db, manifest, "order-lines", created.value._id, { quantity: 7 });

    expect(updated.ok).toBe(true);
    const rows = readOrderLines(manifest);
    expect(rows).toHaveLength(1);
    // 更新値が残り、その値で計算された line_total が書き戻されている。
    expect(rows[0]?.quantity).toBe(7);
    expect(rows[0]?.line_total).toBe(350);
  });

  test("【完了条件12 の回帰検査】on_create × write_back は今日も動く", () => {
    const manifest = setup({ type: "on_create", table: "order-lines" });

    const created = createRecord(db, manifest, "order-lines", { unit_price: 120, quantity: 3 });

    expect(created.ok).toBe(true);
    const rows = readOrderLines(manifest);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.line_total).toBe(360);
    expect(rows[0]?.unit_price).toBe(120);
    expect(rows[0]?.quantity).toBe(3);
  });

  test("島の失敗は今日も発火元ごと落とす(限定16 の縮小は「アクションの失敗」を1バイトも緩めない)", () => {
    const manifest = setup(
      { type: "on_update", table: "order-lines" },
      lineTotalFunction({ code: `(rec) => [{ line_total: "たくさん" }]` }),
    );
    const created = createRecord(db, manifest, "order-lines", { unit_price: 50, quantity: 4 });
    if (!created.ok) {
      throw new Error("作成に失敗");
    }

    const updated = updateRecord(db, manifest, "order-lines", created.value._id, { quantity: 7 });

    expect(updated.ok).toBe(false);
    // 更新前の値がそのまま残る(巻き戻った)。
    expect(readOrderLines(manifest)[0]?.quantity).toBe(4);
  });
});

describe("V2-M3-T02 限定12 不可侵($defs/action_value を1バイトも触らない)", () => {
  test("schemas/manifest.schema.json の $defs.action_value が従来どおり(式言語を作っていない)", () => {
    const schemaPath = join(import.meta.dir, "..", "..", "schemas", "manifest.schema.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as {
      $defs: { action_value: Record<string, unknown> };
    };
    const actionValue = schema.$defs.action_value;
    // 値の語彙は「リテラル or $record.<field>」のまま —— 演算子・連結・比較を1つも足していない。
    expect(actionValue.type).toBe("string");
    expect(actionValue.if).toEqual({ type: "string", pattern: "^\\$" });
    expect(actionValue.then).toEqual({ pattern: "^\\$record\\.(_id|[a-z][a-z0-9_-]*)$" });
    expect(actionValue.else).toEqual({ pattern: "^[^{}]*$" });
  });
});

// =============================================================================
// V3-M9-T01: 複数入力(D-G14 限定採用 / ADR-0062 の限定表12点)
//
// **カーネルは突き合わせを1行も行わない。** 島へ渡すのは「各要素を既存3分岐でそのまま
// 解決した結果を、宣言順に並べた配列」だけである(限定4)。参照展開(`$record.<ref>.<field>`)
// ・多段・join・クエリ言語(where / select / count / group_by)を1つも実装しない(限定2 / 限定7)。
// =============================================================================

// biome-ignore lint/suspicious/noExplicitAny: 正準スキーマ / 異常系の構造をそのまま組み立てるため
type Any = any;

/** 正準スキーマ(`schemas/manifest.schema.json`)の `$defs` をそのまま読む。 */
function canonicalDefs(): Record<string, Any> {
  const schemaPath = join(import.meta.dir, "..", "..", "schemas", "manifest.schema.json");
  return (JSON.parse(readFileSync(schemaPath, "utf-8")) as { $defs: Record<string, Any> }).$defs;
}

describe("V3-M9-T01 複数入力: スキーマの形(限定1 / 2 / 3)", () => {
  test("限定3 —— `$defs/function.properties.input` は単体形と配列形の2形だけ(maxItems=5・uniqueItems・oneOf/anyOf 不使用)", () => {
    const input = canonicalDefs().function.properties.input;
    // この箇所に許すキーは4つだけ($comment / description / type / allOf)。
    expect(Object.keys(input).sort()).toEqual(["$comment", "allOf", "description", "type"]);
    // 2形だけ —— 文字列・数値・null は型で弾く。
    expect(input.type).toEqual(["object", "array"]);
    // 分岐は allOf + if/then の肯定形。**この箇所に oneOf / anyOf を使わない**($defs/function_input
    // 自身の $comment が宣言した作法。リポジトリ全体の規則ではない —— $defs/filter は anyOf を使う)。
    // **キーとして** oneOf / anyOf が1つも無いことを再帰的に確かめる($comment の散文中の
    // 言及は対象にしない —— 見るのはスキーマのキーワードである)。
    const keysOf = (node: unknown): string[] => {
      if (Array.isArray(node)) {
        return node.flatMap(keysOf);
      }
      if (node === null || typeof node !== "object") {
        return [];
      }
      return Object.entries(node).flatMap(([key, value]) => [key, ...keysOf(value)]);
    };
    expect(keysOf(input)).not.toContain("oneOf");
    expect(keysOf(input)).not.toContain("anyOf");
    expect(input.allOf.length).toBe(2);
    expect(input.allOf[0].if).toEqual({ type: "array" });
    expect(input.allOf[0].then).toEqual({
      type: "array",
      minItems: 1,
      maxItems: 5,
      uniqueItems: true,
      items: { $ref: "#/$defs/function_input" },
    });
    expect(input.allOf[1].if).toEqual({ type: "object" });
    expect(input.allOf[1].then).toEqual({ $ref: "#/$defs/function_input" });
  });

  test("限定1 / 2 —— `$defs/function_input` は1バイトも変わっていない(3キー・source は3値・additionalProperties: false)", () => {
    const fi = canonicalDefs().function_input;
    // **【V4-M10-T44 / E-G72 / ADR-0083 限定1 による更新】** **4キー目(`via`)が入った。**
    // **`ADR-0062` 限定1 の射程を `function_input` の1点だけ引き直したものである** ——
    // **`source` の enum は3値のまま、`additionalProperties: false` も1バイトも変わって
    // いない**(限定2)。
    expect(Object.keys(fi.properties).sort()).toEqual(["source", "table", "via", "view"]);
    expect(fi.properties.source.enum).toEqual(["table", "view", "record"]);
    expect(fi.additionalProperties).toBe(false);
    expect(fi.required).toEqual(["source"]);
  });

  // **【V3-M13-T09 による期待値の更新】** **`ADR-0062`(複数入力)の側は1バイトも増えて
  // いない**($defs 28 / function 6 / function_input 3 は今日も同じ)。**増えたのは
  // `workflow_action.properties` の 16 → 17 で、増やしたのは `ADR-0067`(D-G15 の4回目 =
  // 限定採用)が通した `write_ops` 1本である**(限定 A10: マニフェスト語彙の増分は
  // `$defs/function_output` の第2の形 + `workflow_action` の3値排他の2箇所だけ)。
  // **実装の誤りではなく、門A を通した増分の反映である。**
  // **【`V8-M18` / 台帳 `J-G12` による期待値の更新。2026-08-09】** **旧テスト名の逐語**:
  // 「**限定1 —— `properties` のキー数($defs 28 / function 6 / function_input 3 /
  // workflow_action 17 —— 17 目は ADR-0067 の write_ops)**」。**旧本体の逐語**:
  // `expect(Object.keys(defs).length).toBe(28)`。
  // **`ADR-0062`(複数入力)の側は今日も `$defs` を1本も増やしていない** —— **28 → 29 に
  // したのは `V8-M18` が新設した `role_condition` 1本だけである。****旧文を1バイトも消していない。**
  test("限定1 —— `properties` のキー数($defs 29 = V8-M18 の1本だけ増えた / function 6 / function_input 3 / workflow_action 17 —— 17 目は ADR-0067 の write_ops)", () => {
    const defs = canonicalDefs();
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 29 → 30 へ書き換えた。**
    // **旧行の逐語**: `expect(Object.keys(defs).length).toBe(29);`
    // **書き換えた理由**: この行が固定していたのは「**その決定**が新しい `$defs` を作らなかったこと」
    // であり、**30本目を作ったのは別の決定である**(`V8-M8` が集計表の中身 `$defs/report` を新設した)。
    // **検査は消していない。**
    expect(Object.keys(defs).length).toBe(30);
    expect(Object.keys(defs)).toContain("role_condition");
    expect(Object.keys(defs.function.properties).length).toBe(6);
    // **【V4-M10-T44 / E-G72 / ADR-0083 限定1 による更新】** **3 → 4**(`via`)。
    // **`ADR-0062` 限定1 の射程を `function_input` の1点だけ引き直したものであり、
    // `$defs` 28 / `function` 6 / `workflow_action` 17 は1つも動いていない。**
    expect(Object.keys(defs.function_input.properties).length).toBe(4);
    expect(Object.keys(defs.workflow_action.properties).length).toBe(17);
    expect(Object.keys(defs.workflow_action.properties)).toContain("write_ops");
    expect(defs.workflow_action.properties.write_ops.const).toBe(true);
  });

  test("限定2 —— 禁止7語(where / filter / select / count / group_by / join / on)がどちらの定義にもキーとして無い", () => {
    const defs = canonicalDefs();
    const forbidden = ["where", "filter", "select", "count", "group_by", "join", "on"];
    for (const word of forbidden) {
      expect(Object.keys(defs.function_input.properties)).not.toContain(word);
      expect(Object.keys(defs.function.properties)).not.toContain(word);
      expect(Object.keys(defs.function.properties.input)).not.toContain(word);
    }
  });

  test("限定9 —— 書込側(write_back / target / values / output_table)の意味論を1バイトも変えていない", () => {
    const wa = canonicalDefs().workflow_action.properties;
    expect(wa.write_back.const).toBe("$record");
    expect(wa.target.$ref).toBe("#/$defs/action_value");
    expect(wa.values).toEqual({
      description: "書き込む値。キーはフィールドID、値はリテラルか $record.<フィールドID> の参照。",
      type: "object",
      additionalProperties: { $ref: "#/$defs/action_value" },
    });
    expect(wa.output_table.$ref).toBe("#/$defs/resource_id");
  });

  test("限定6 —— `RUN_FUNCTION_LIMITS` の3値を1バイトも変えていない", () => {
    const runner = readFileSync(join(import.meta.dir, "workflow-runner.ts"), "utf-8");
    expect(runner).toContain(
      "const RUN_FUNCTION_LIMITS: IslandLimits = {\n" +
        "  timeoutMillis: 1000,\n" +
        "  memoryBytes: 64 * 1024 * 1024,\n" +
        "  maxInputBytes: 1024 * 1024,\n" +
        "};",
    );
  });
});

// --- apply 時の受理と拒否 -----------------------------------------------------

/** 6テーブル + 1 list_view + 1 form を持つ、複数入力の受理/拒否を測るためのマニフェスト。 */
function multiInputManifest(input: unknown): Manifest {
  const table = (id: string) => ({
    id,
    name: id.toUpperCase(),
    fields: [{ id: "a", name: "A", type: "text" as const }],
  });
  return {
    app: {
      id: "multi-input",
      name: "複数入力",
      tables: [
        table("t1"),
        table("t2"),
        table("t3"),
        table("t4"),
        table("t5"),
        table("t6"),
        { id: "out", name: "出力", fields: [{ id: "n", name: "N", type: "number" }] },
        { id: "wf-runs", name: "実行履歴", fields: historyFields() },
      ],
      views: [
        { id: "v1", type: "list_view", table: "t1", columns: ["a"] },
        { id: "f1", type: "form", table: "t1", fields: ["a"] },
      ],
      functions: [
        {
          id: "multi",
          name: "複数入力の関数",
          code: "(inputs) => []",
          input: input as FunctionDef["input"],
          output: { fields: [{ id: "n", type: "number" }] },
          capabilities: [],
        },
      ],
      workflows: [
        {
          id: "wf",
          name: "発火",
          trigger: { type: "on_create", table: "t1" },
          actions: [{ action: "run_function", function: "multi", output_table: "out" }],
          history_table: "wf-runs",
        },
      ],
    },
  };
}

describe("V3-M9-T01 複数入力: apply 時の受理(限定3 / 12)", () => {
  test("1要素の配列を受理する(minItems=1)", () => {
    expect(validateManifest(multiInputManifest([{ source: "table", table: "t1" }]))).toEqual({
      valid: true,
    });
  });

  test("5要素(maxItems ちょうど)の配列を受理する —— 審査が組み立てた最悪形と同じ要素数", () => {
    const manifest = multiInputManifest([
      { source: "record" },
      { source: "table", table: "t1" },
      { source: "table", table: "t2" },
      { source: "table", table: "t3" },
      { source: "view", view: "v1" },
    ]);
    expect(validateManifest(manifest)).toEqual({ valid: true });
    expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
  });

  test("限定12 —— 単体形(既存マニフェストの形)は無改変で valid のまま", () => {
    for (const single of [
      { source: "table", table: "t1" },
      { source: "view", view: "v1" },
      { source: "record" },
    ]) {
      const manifest = multiInputManifest(single);
      expect(validateManifest(manifest)).toEqual({ valid: true });
      expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
    }
  });
});

describe("V3-M9-T01 複数入力: apply 時の拒否(限定3 / 5 —— 拒否の場所 = schema)", () => {
  test("6要素は拒否する(maxItems = 5)", () => {
    expectInvalid(
      validateManifest(
        multiInputManifest([
          { source: "record" },
          { source: "table", table: "t1" },
          { source: "table", table: "t2" },
          { source: "table", table: "t3" },
          { source: "table", table: "t4" },
          { source: "table", table: "t5" },
        ]),
      ),
    );
  });

  test("空配列は拒否する(minItems = 1)", () => {
    expectInvalid(validateManifest(multiInputManifest([])));
  });

  test("限定5 —— 同じテーブル入力を2つ書くと拒否する(uniqueItems)", () => {
    expectInvalid(
      validateManifest(
        multiInputManifest([
          { source: "table", table: "t1" },
          { source: "table", table: "t1" },
        ]),
      ),
    );
  });

  test('限定5 —— `{source:"record"}` を2つ書くと拒否する(uniqueItems)', () => {
    expectInvalid(
      validateManifest(multiInputManifest([{ source: "record" }, { source: "record" }])),
    );
  });

  test("配列の入れ子は拒否する(要素は $defs/function_input だけ)", () => {
    expectInvalid(validateManifest(multiInputManifest([[{ source: "record" }]])));
  });

  test("配列でもオブジェクトでもない値(文字列)は拒否する", () => {
    expectInvalid(validateManifest(multiInputManifest("t1")));
  });

  test("配列の要素が要否を満たさない(source=table なのに table 無し)と拒否する", () => {
    expectInvalid(
      validateManifest(multiInputManifest([{ source: "record" }, { source: "table" }])),
    );
  });

  test("配列の要素に table と view を両方書くと拒否する", () => {
    expectInvalid(
      validateManifest(multiInputManifest([{ source: "table", table: "t1", view: "v1" }])),
    );
  });

  test("配列の要素がシステムテーブル(_apps)を指すと拒否する(限定7 / resource_id が担保)", () => {
    expectInvalid(
      validateManifest(
        multiInputManifest([{ source: "record" }, { source: "table", table: "_apps" }]),
      ),
    );
  });
});

describe("V3-M9-T01 複数入力: 多段・join・クエリ言語を1つも実装していない(限定2 / 7 —— 拒否の場所 = schema)", () => {
  test("要素に where / select / count / group_by / join / on / filter を書くと拒否する(additionalProperties: false)", () => {
    for (const extra of [
      { where: { a: 1 } },
      { select: ["a"] },
      { count: true },
      { group_by: "a" },
      { join: "t2" },
      { on: "a" },
      { filter: [{ field: "a", equals: "x" }] },
    ]) {
      expectInvalid(
        validateManifest(multiInputManifest([{ source: "table", table: "t1", ...extra }])),
      );
    }
  });

  test("`source` に4種目(reference / join など)を書くと拒否する —— 入力の種類は3種で閉じている", () => {
    for (const source of ["reference", "join", "record_ref", "query"]) {
      expectInvalid(validateManifest(multiInputManifest([{ source }])));
      expectInvalid(validateManifest(multiInputManifest({ source })));
    }
  });

  test("多段参照(`$record.a.b`)を書く場所が1つも無い —— table / view は resource_id でありドットを含めない", () => {
    expectInvalid(
      validateManifest(multiInputManifest([{ source: "table", table: "orders.coupon" }])),
    );
    expectInvalid(validateManifest(multiInputManifest([{ source: "view", view: "v1.a.b" }])));
    // `$record.<ref>.<field>` を入力に書く口も無い(source=record は table / view を禁じる)。
    expectInvalid(
      validateManifest(multiInputManifest([{ source: "record", table: "$record.coupon" }])),
    );
  });
});

describe("V3-M9-T01 複数入力: 参照整合性(限定11 —— 拒否の場所 = 整合性検査の類型9)", () => {
  test("配列要素が実在しないテーブルを指すと apply 時に拒否する(類型9・要素の位置が path に出る)", () => {
    const errors = expectInvalid(
      validateReferentialIntegrity(
        multiInputManifest([
          { source: "record" },
          { source: "table", table: "t1" },
          { source: "table", table: "no-such-table" },
        ]),
      ),
    );
    expect(errors.some((e) => e.path === "/app/functions/0/input/2/table")).toBe(true);
  });

  test("配列要素が実在しない list_view を指すと apply 時に拒否する(類型9)", () => {
    const errors = expectInvalid(
      validateReferentialIntegrity(
        multiInputManifest([{ source: "view", view: "no-such-view" }, { source: "record" }]),
      ),
    );
    expect(errors.some((e) => e.path === "/app/functions/0/input/0/view")).toBe(true);
  });

  test("配列要素が form を指すと apply 時に拒否する(入力に使えるのは list_view だけ。類型9)", () => {
    const errors = expectInvalid(
      validateReferentialIntegrity(multiInputManifest([{ source: "view", view: "f1" }])),
    );
    expect(errors.some((e) => e.path === "/app/functions/0/input/0/view")).toBe(true);
  });

  test("単体形の path は今日と同一である(後方互換。限定12)", () => {
    const errors = expectInvalid(
      validateReferentialIntegrity(multiInputManifest({ source: "table", table: "no-such-table" })),
    );
    expect(errors.some((e) => e.path === "/app/functions/0/input/table")).toBe(true);
  });

  test("複数要素が同時に不正なら、要素ごとに1件ずつ拒否理由が出る", () => {
    const errors = expectInvalid(
      validateReferentialIntegrity(
        multiInputManifest([
          { source: "table", table: "no-such-table" },
          { source: "view", view: "no-such-view" },
        ]),
      ),
    );
    expect(errors.filter((e) => e.path.startsWith("/app/functions/0/input/")).length).toBe(2);
  });
});

// --- 実行 E2E(限定4 / 6 / 12)-------------------------------------------------

/**
 * 実証対象(門A記録 §3 S6 完了条件1): **注文の行が持つ reference が指すクーポン行の値を読む。**
 *
 * **`scripts/ref-ec/` を1バイトも使わない**(D-M9-3)—— 同じ形をテスト用マニフェストで組む。
 * **カーネルは `order.coupon` を1ホップも辿らない** —— 島が `coupons` の全行を受け取り、
 * 島の JavaScript が `_id` で突き合わせる。`tax_rate` は**参照で1本も繋がっていない**が、
 * 配列に1要素足すだけで島に届く(これが1ホップの参照読み案では解けなかったケースである)。
 */
const PRICE_ISLAND = `(inputs) => {
  const order = inputs[0];
  const coupons = inputs[1];
  const taxRates = inputs[2];
  var discount = 0;
  for (var i = 0; i < coupons.length; i++) {
    if (coupons[i]._id === order.coupon) { discount = coupons[i].discount; }
  }
  var rate = taxRates.length > 0 ? taxRates[0].rate : 0;
  var total = Math.round((order.subtotal - discount) * (1 + rate));
  return [{ order_id: order._id, total: total }];
}`;

const PRICING_APP_ID = "order-pricing";

function pricingManifest(
  input: FunctionDef["input"],
  code: string = PRICE_ISLAND,
  triggerType: "on_create" | "on_update" = "on_create",
): Manifest {
  return {
    app: {
      id: PRICING_APP_ID,
      name: "注文の価格計算",
      tables: [
        {
          id: "coupons",
          name: "クーポン",
          fields: [
            { id: "code", name: "コード", type: "text", required: true },
            { id: "discount", name: "割引額", type: "number" },
          ],
        },
        {
          id: "tax-rates",
          name: "税率",
          fields: [
            { id: "label", name: "名称", type: "text" },
            { id: "rate", name: "税率", type: "number" },
          ],
        },
        {
          id: "shipping-methods",
          name: "配送方法",
          fields: [
            { id: "label", name: "名称", type: "text" },
            { id: "fee", name: "送料", type: "number" },
          ],
        },
        {
          id: "orders",
          name: "注文",
          fields: [
            { id: "subtotal", name: "小計", type: "number" },
            { id: "coupon", name: "適用クーポン", type: "reference", reference_table: "coupons" },
            {
              id: "shipping_method",
              name: "配送方法",
              type: "reference",
              reference_table: "shipping-methods",
            },
          ],
        },
        {
          id: "order-lines",
          name: "注文明細",
          fields: [
            { id: "order", name: "注文", type: "reference", reference_table: "orders" },
            { id: "amount", name: "金額", type: "number" },
          ],
        },
        {
          id: "order-totals",
          name: "注文合計",
          fields: [
            { id: "order_id", name: "注文ID", type: "text" },
            { id: "total", name: "合計", type: "number" },
          ],
        },
        { id: "wf-runs", name: "実行履歴", fields: historyFields() },
      ],
      views: [],
      functions: [
        {
          id: "price-order",
          name: "注文の価格を計算する",
          code,
          input,
          output: {
            fields: [
              { id: "order_id", type: "text" },
              { id: "total", type: "number" },
            ],
          },
          capabilities: [],
        },
      ],
      workflows: [
        {
          id: "price",
          name: "価格計算",
          trigger: { type: triggerType, table: "orders" },
          actions: [
            { action: "run_function", function: "price-order", output_table: "order-totals" },
          ],
          history_table: "wf-runs",
        },
      ],
    },
  };
}

describe("V3-M9-T01 複数入力: 実行(注文 → 参照先クーポン + 参照で繋がっていない税率)", () => {
  let pricingDb: Database;
  let pricingRoot: string;

  beforeEach(async () => {
    pricingRoot = await mkdtemp(join(tmpdir(), "gp-multi-input-"));
    await mkdir(join(pricingRoot, "apps", PRICING_APP_ID), { recursive: true });
    pricingDb = new Database(appDbPath(pricingRoot, PRICING_APP_ID), { create: true });
  });

  afterEach(async () => {
    pricingDb.close();
    await rm(pricingRoot, { recursive: true, force: true });
  });

  function seed(manifest: Manifest): { couponId: string; shippingId: string } {
    applyManifestDdl(pricingDb, manifest);
    const coupon = createRecord(pricingDb, manifest, "coupons", { code: "SPRING", discount: 300 });
    if (!coupon.ok) {
      throw new Error("クーポンを作れませんでした");
    }
    const tax = createRecord(pricingDb, manifest, "tax-rates", { label: "標準", rate: 0.1 });
    if (!tax.ok) {
      throw new Error("税率を作れませんでした");
    }
    const shipping = createRecord(pricingDb, manifest, "shipping-methods", {
      label: "宅配",
      fee: 500,
    });
    if (!shipping.ok) {
      throw new Error("配送方法を作れませんでした");
    }
    return { couponId: coupon.value._id, shippingId: shipping.value._id };
  }

  function readTotals(manifest: Manifest): { order_id: string; total: number }[] {
    const rows = listRecords(pricingDb, manifest, "order-totals", {});
    if (!rows.ok) {
      throw new Error("order-totals を読めませんでした");
    }
    return rows.value.map((r) => ({ order_id: r.order_id as string, total: r.total as number }));
  }

  test("注文の reference が指すクーポン行の値と、参照で繋がっていない税率表の値を、島が同時に読む", () => {
    const manifest = pricingManifest([
      { source: "record" },
      { source: "table", table: "coupons" },
      { source: "table", table: "tax-rates" },
    ]);
    expect(validateManifest(manifest)).toEqual({ valid: true });
    expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });

    const { couponId } = seed(manifest);
    const order = createRecord(pricingDb, manifest, "orders", {
      subtotal: 1000,
      coupon: couponId,
    });
    expect(order.ok).toBe(true);

    // (1000 - 300) * 1.1 = 770。**割引額はクーポン行から、税率は参照で繋がっていない表から来る。**
    expect(readTotals(manifest)).toEqual([
      { order_id: order.ok ? order.value._id : "", total: 770 },
    ]);
  });

  test("クーポンを指していない注文は割引0で計算される(島が突き合わせに失敗しただけ。カーネルは何もしない)", () => {
    const manifest = pricingManifest([
      { source: "record" },
      { source: "table", table: "coupons" },
      { source: "table", table: "tax-rates" },
    ]);
    seed(manifest);
    const order = createRecord(pricingDb, manifest, "orders", { subtotal: 1000 });
    expect(order.ok).toBe(true);
    expect(readTotals(manifest)[0]?.total).toBe(1100);
  });

  test("審査が組み立てた最悪形(トリガー元1 + 明細表1 + マスタ表3 = 5要素)がそのまま動く", () => {
    // ADR-0062 §7-1 (4) が「maxItems ちょうど」と書いた形を、**実際に島まで通す**。
    // **明細の絞り込みはカーネルがしない** —— 島が全行を受け取って `order` フィールドで
    // 自分で絞る(「この注文の明細だけ」は今日も書けない。ADR-0062 §7-2 (1))。
    const island = `(inputs) => {
      const order = inputs[0];
      const lines = inputs[1];
      const coupons = inputs[2];
      const shippings = inputs[3];
      const taxRates = inputs[4];
      var subtotal = 0;
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].order === order._id) { subtotal += lines[i].amount; }
      }
      var discount = 0;
      for (var j = 0; j < coupons.length; j++) {
        if (coupons[j]._id === order.coupon) { discount = coupons[j].discount; }
      }
      var fee = 0;
      for (var k = 0; k < shippings.length; k++) {
        if (shippings[k]._id === order.shipping_method) { fee = shippings[k].fee; }
      }
      var rate = taxRates.length > 0 ? taxRates[0].rate : 0;
      return [{ order_id: order._id, total: Math.round((subtotal - discount + fee) * (1 + rate)) }];
    }`;
    const manifest = pricingManifest(
      [
        { source: "record" },
        { source: "table", table: "order-lines" },
        { source: "table", table: "coupons" },
        { source: "table", table: "shipping-methods" },
        { source: "table", table: "tax-rates" },
      ],
      island,
      "on_update",
    );
    expect(validateManifest(manifest)).toEqual({ valid: true });
    expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });

    const { couponId, shippingId } = seed(manifest);
    const order = createRecord(pricingDb, manifest, "orders", {
      subtotal: 0,
      coupon: couponId,
      shipping_method: shippingId,
    });
    if (!order.ok) {
      throw new Error("注文を作れませんでした");
    }
    // **別の注文の明細も混ぜる** —— 島が絞れていなければ合計が狂う(カーネルは絞らない)。
    const other = createRecord(pricingDb, manifest, "orders", { subtotal: 0 });
    if (!other.ok) {
      throw new Error("別注文を作れませんでした");
    }
    for (const [orderId, amount] of [
      [order.value._id, 1200],
      [order.value._id, 800],
      [other.value._id, 9999],
    ] as const) {
      const line = createRecord(pricingDb, manifest, "order-lines", { order: orderId, amount });
      expect(line.ok).toBe(true);
    }

    // on_update で発火させる(明細は注文より後に入るため)。
    const touched = updateRecord(pricingDb, manifest, "orders", order.value._id, {
      subtotal: 2000,
    });
    expect(touched.ok).toBe(true);

    // (1200 + 800 - 300 + 500) * 1.1 = 2420。**9999 の明細は別注文なので入らない。**
    expect(readTotals(manifest)).toEqual([{ order_id: order.value._id, total: 2420 }]);
  });

  test("限定4 —— 島が受け取るのは宣言順に並べただけの配列である(結合・重複排除・ソートを1つもしない)", () => {
    // 宣言順を入れ替える: [table coupons, record, table tax-rates]。
    const manifest = pricingManifest(
      [
        { source: "table", table: "coupons" },
        { source: "record" },
        { source: "table", table: "tax-rates" },
      ],
      `(inputs) => {
        var shape = [];
        for (var i = 0; i < inputs.length; i++) {
          var v = inputs[i];
          shape.push(Array.isArray(v) ? ("arr:" + v.length) : ("rec:" + v.subtotal));
        }
        return [{ order_id: shape.join(","), total: inputs.length }];
      }`,
    );
    seed(manifest);
    createRecord(pricingDb, manifest, "orders", { subtotal: 1234 });
    expect(readTotals(manifest)).toEqual([{ order_id: "arr:1,rec:1234,arr:1", total: 3 }]);
  });

  test("限定12 —— 単体形のとき島が受け取る値は今日と同一(配列で包まない)。1要素の配列形とは受け取り形が違う", () => {
    const shapeCode = `(input) => [{
      order_id: Array.isArray(input) ? ("outer:" + (Array.isArray(input[0]) ? "nested" : "flat")) : "record",
      total: 1
    }]`;

    // (a) 単体形 source=table … 今日どおり「行の配列」がそのまま届く(包まれない)。
    const single = pricingManifest({ source: "table", table: "coupons" }, shapeCode);
    seed(single);
    createRecord(pricingDb, single, "orders", { subtotal: 1 });
    expect(readTotals(single)[0]?.order_id).toBe("outer:flat");
  });

  test("限定12 —— 1要素の配列形は「配列の中に行の配列」で届く(単体形と形が違う)", () => {
    const shapeCode = `(input) => [{
      order_id: Array.isArray(input) ? ("outer:" + (Array.isArray(input[0]) ? "nested" : "flat")) : "record",
      total: 1
    }]`;
    const wrapped = pricingManifest([{ source: "table", table: "coupons" }], shapeCode);
    seed(wrapped);
    createRecord(pricingDb, wrapped, "orders", { subtotal: 1 });
    expect(readTotals(wrapped)[0]?.order_id).toBe("outer:nested");
  });

  test("限定12 —— 単体形 source=record は今日どおり1レコードがそのまま届く(配列で包まない)", () => {
    const shapeCode = `(input) => [{
      order_id: Array.isArray(input) ? "array" : ("record:" + input.subtotal),
      total: 1
    }]`;
    const single = pricingManifest({ source: "record" }, shapeCode);
    seed(single);
    createRecord(pricingDb, single, "orders", { subtotal: 77 });
    expect(readTotals(single)[0]?.order_id).toBe("record:77");
  });

  test("配列の途中の要素が実行時に解決できないと fail-closed する(output_table を1バイトも触らない)", () => {
    // source=record を含む関数を schedule ではなく on_create で走らせるのは正常系なので、
    // ここでは「実在しないテーブル」を実行層に直接与える(apply 時には類型9 が拒否する形)。
    const manifest = pricingManifest([{ source: "record" }, { source: "table", table: "coupons" }]);
    seed(manifest);
    const fn = manifest.app.functions?.[0];
    if (fn === undefined || !Array.isArray(fn.input)) {
      throw new Error("配列形の関数が組めていません");
    }
    fn.input[1] = { source: "table", table: "ghost-table" };
    // 【V3-M13-T02 / ADR-0066 による期待値の更新】fail-closed は**アクションの失敗**なので、
    // 発火元(注文)の書込ごと成立しない。失敗の中身は呼び出し元の errors から読む
    // (履歴はこの時点では一緒に消える。解くのは `V3-M13-T04`)。
    const created = createRecord(pricingDb, manifest, "orders", { subtotal: 1000 });
    expect(created.ok).toBe(false);
    if (created.ok) {
      throw new Error("失敗するはずの書込が成功しました。");
    }
    expect(String(created.errors[0]?.message)).toContain("ghost-table");
    // 出力は1行も書かれない。
    expect(readTotals(manifest)).toEqual([]);
  });
});

// --- 入力サイズの上限(限定6。**和であって積ではない。上限は1バイトも動かさない**)-------

const BULK_APP_ID = "bulk-input";

function bulkManifest(input: FunctionDef["input"]): Manifest {
  const bulk = (id: string) => ({
    id,
    name: id,
    fields: [{ id: "blob", name: "塊", type: "long_text" as const }],
  });
  return {
    app: {
      id: BULK_APP_ID,
      name: "巨大入力",
      tables: [
        bulk("bulk-a"),
        bulk("bulk-b"),
        { id: "triggers", name: "きっかけ", fields: [{ id: "note", name: "メモ", type: "text" }] },
        { id: "out", name: "出力", fields: [{ id: "n", name: "件数", type: "number" }] },
        { id: "wf-runs", name: "実行履歴", fields: historyFields() },
      ],
      views: [],
      functions: [
        {
          id: "measure",
          name: "件数を数えるだけの島",
          code: "(input) => [{ n: Array.isArray(input[0]) ? input[0].length + input[1].length : input.length }]",
          input,
          output: { fields: [{ id: "n", type: "number" }] },
          capabilities: [],
        },
      ],
      workflows: [
        {
          id: "measure-wf",
          name: "計測",
          trigger: { type: "on_create", table: "triggers" },
          actions: [{ action: "run_function", function: "measure", output_table: "out" }],
          history_table: "wf-runs",
        },
      ],
    },
  };
}

describe("V3-M9-T01 複数入力: 入力サイズの上限(限定6 —— 拒否の場所 = 実行時)", () => {
  let bulkDb: Database;
  let bulkRoot: string;

  beforeEach(async () => {
    bulkRoot = await mkdtemp(join(tmpdir(), "gp-bulk-input-"));
    await mkdir(join(bulkRoot, "apps", BULK_APP_ID), { recursive: true });
    bulkDb = new Database(appDbPath(bulkRoot, BULK_APP_ID), { create: true });
  });

  afterEach(async () => {
    bulkDb.close();
    await rm(bulkRoot, { recursive: true, force: true });
  });

  /** 1テーブルあたり約 660KB を積む(単独なら 1MiB 未満、2つ足すと超える)。 */
  function fill(manifest: Manifest, tableId: string): void {
    const blob = "x".repeat(2600);
    for (let i = 0; i < 250; i += 1) {
      const created = createRecord(bulkDb, manifest, tableId, { blob });
      if (!created.ok) {
        throw new Error(`${tableId} の投入に失敗しました`);
      }
    }
  }

  function lastHistory(manifest: Manifest): { status: string; error: string } {
    const rows = listRecords(bulkDb, manifest, "wf-runs", {});
    if (!rows.ok || rows.value.length === 0) {
      throw new Error("履歴を読めませんでした");
    }
    const row = rows.value[rows.value.length - 1];
    return { status: String(row?.status), error: String(row?.error ?? "") };
  }

  test("単体形で1テーブル(約660KB)なら上限内で成功する", () => {
    const manifest = bulkManifest({ source: "table", table: "bulk-a" });
    applyManifestDdl(bulkDb, manifest);
    fill(manifest, "bulk-a");
    createRecord(bulkDb, manifest, "triggers", { note: "go" });
    expect(lastHistory(manifest).status).toBe("success");
  });

  test("配列形で同じ大きさの表を2つ渡すと、**和**が 1 MiB を越えて input_too_large で fail-closed する", () => {
    const manifest = bulkManifest([
      { source: "table", table: "bulk-a" },
      { source: "table", table: "bulk-b" },
    ]);
    applyManifestDdl(bulkDb, manifest);
    fill(manifest, "bulk-a");
    fill(manifest, "bulk-b");
    // 【期待値の更新(ADR-0066)】fail-closed が発火元の書込ごと落とす。**上限は1バイトも
    // 動かしていない**(限定15)。失敗の中身は呼び出し元の errors から読む。
    const created = createRecord(bulkDb, manifest, "triggers", { note: "go" });
    expect(created.ok).toBe(false);
    if (created.ok) {
      throw new Error("失敗するはずの書込が成功しました。");
    }
    expect(String(created.errors[0]?.message)).toContain("input_too_large");
    // output_table は1バイトも触られていない。
    const out = listRecords(bulkDb, manifest, "out", {});
    expect(out.ok && out.value.length).toBe(0);
  });
});

// ============================================================================
// V3-M13-T09: 島の返り値として「更新操作の配列」を受ける(第3のモード。ADR-0067)
//
// **限定表(ADR-0067 §3)の A群 / B群 / C群のうち、T09 が実装する範囲だけを固定する。**
// **A5(所有者スコープの検査)と A6(件数・出力サイズの上限)は T10 の仕事であり、
// ここでは「まだ効いていないこと」を実測として固定する**(T09 完了条件8)。
// ============================================================================

/** 在庫の3表 + 履歴。`stock_move.source` の unique は C3(冪等性)の器である。 */
function stockManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "在庫",
      tables: [
        {
          id: "product",
          name: "商品",
          fields: [
            { id: "name", name: "商品名", type: "text", required: true },
            { id: "stock", name: "在庫", type: "number", required: true },
          ],
        },
        {
          id: "stock_move",
          name: "在庫増減明細",
          fields: [
            { id: "product", name: "商品", type: "reference", reference_table: "product" },
            { id: "delta", name: "増減", type: "number", required: true },
            { id: "source", name: "発生源", type: "text", unique: true },
          ],
        },
        {
          id: "order_line",
          name: "注文明細",
          fields: [
            { id: "product", name: "商品", type: "reference", reference_table: "product" },
            { id: "qty", name: "数量", type: "number", required: true },
          ],
        },
        { id: "wf-runs", name: "実行履歴", fields: historyFields() },
      ],
      views: [],
    },
  };
}

/**
 * 引き当ての島(ADR-0067 §9-1)。**演算(`stock - qty`)は島の JS の中だけで行う。**
 * 入力は [トリガー元の注文明細, product 全行]。
 */
const ALLOCATE_CODE = `(input) => {
  const line = input[0];
  const products = input[1];
  const p = products.find((x) => x._id === line.product);
  if (!p) { throw new Error("商品が見つかりません"); }
  if (p.stock < line.qty) { throw new Error("在庫が足りません"); }
  return [
    { op: "create", table: "stock_move", values: { product: p._id, delta: -line.qty, source: line._id } },
    { op: "update", table: "product", target: p._id, if_match: p._updated_at, values: { stock: p.stock - line.qty } },
  ];
}`;

/** op 配列を返す島(コードだけ差し替える)。`output` は ops 形。 */
function opsFunction(code: string, overrides: Partial<FunctionDef> = {}): FunctionDef {
  return {
    id: "allocate-stock",
    name: "在庫を引き当てる",
    code,
    input: [{ source: "record" }, { source: "table", table: "product" }],
    // biome-ignore lint/suspicious/noExplicitAny: 第3のモードの output 形(T09 が足す)
    output: { ops: true } as any,
    capabilities: [],
    ...overrides,
  };
}

/** on_create(order_line) → run_function(write_ops)。 */
function opsWorkflow(): Workflow {
  return {
    id: "allocate",
    name: "在庫の引き当て",
    trigger: { type: "on_create", table: "order_line" },
    // biome-ignore lint/suspicious/noExplicitAny: 第3のモードの action 形(T09 が足す)
    actions: [{ action: "run_function", function: "allocate-stock", write_ops: true } as any],
    history_table: "wf-runs",
  };
}

function setupStock(code: string = ALLOCATE_CODE): { manifest: Manifest; productId: string } {
  const manifest = stockManifest();
  manifest.app.functions = [opsFunction(code)];
  manifest.app.workflows = [opsWorkflow()];
  applyManifestDdl(db, manifest);
  const p = createRecord(db, manifest, "product", { name: "Tシャツ", stock: 10 });
  if (!p.ok) {
    throw new Error(`商品の作成に失敗: ${JSON.stringify(p.errors)}`);
  }
  return { manifest, productId: p.value._id };
}

function readAll(manifest: Manifest, table: string): RecordRow[] {
  const rows = listRecords(db, manifest, table, {});
  if (!rows.ok) {
    throw new Error(`${table} を読めませんでした`);
  }
  return rows.value;
}

describe("V3-M13-T09 第3のモードのスキーマ(3値排他。限定 A1 / A3 / A10)", () => {
  test("run_function は write_ops: true を受理する(output_table も write_back も無い形)", () => {
    const manifest = stockManifest();
    manifest.app.functions = [opsFunction(ALLOCATE_CODE)];
    manifest.app.workflows = [opsWorkflow()];
    expect(validateManifest(manifest)).toEqual({ valid: true });
  });

  test("write_ops と output_table を同時に書くと拒否する(3値排他)", () => {
    const manifest = stockManifest();
    manifest.app.functions = [opsFunction(ALLOCATE_CODE)];
    const wf = opsWorkflow();
    // biome-ignore lint/suspicious/noExplicitAny: 異常系の構造を意図的に組む
    (wf.actions[0] as any).output_table = "stock_move";
    manifest.app.workflows = [wf];
    expectInvalid(validateManifest(manifest));
  });

  test("write_ops と write_back を同時に書くと拒否する(3値排他)", () => {
    const manifest = stockManifest();
    manifest.app.functions = [opsFunction(ALLOCATE_CODE)];
    const wf = opsWorkflow();
    // biome-ignore lint/suspicious/noExplicitAny: 異常系の構造を意図的に組む
    (wf.actions[0] as any).write_back = "$record";
    manifest.app.workflows = [wf];
    expectInvalid(validateManifest(manifest));
  });

  test("write_ops: false は書けない(const true。モードは足し引きできる旗ではない)", () => {
    const manifest = stockManifest();
    manifest.app.functions = [opsFunction(ALLOCATE_CODE)];
    const wf = opsWorkflow();
    // biome-ignore lint/suspicious/noExplicitAny: 異常系の構造を意図的に組む
    (wf.actions[0] as any).write_ops = false;
    manifest.app.workflows = [wf];
    expectInvalid(validateManifest(manifest));
  });

  test("write_ops を run_function 以外のアクション(create_record)に書くと拒否する", () => {
    const manifest = stockManifest();
    manifest.app.workflows = [
      {
        id: "bad",
        name: "だめ",
        trigger: { type: "on_create", table: "order_line" },
        actions: [
          {
            action: "create_record",
            table: "stock_move",
            values: { delta: "1" },
            write_ops: true,
            // biome-ignore lint/suspicious/noExplicitAny: 異常系の構造を意図的に組む
          } as any,
        ],
        history_table: "wf-runs",
      },
    ];
    expectInvalid(validateManifest(manifest));
  });

  test("function.output は ops: true と fields の同時指定を拒否する(第2の形は排他)", () => {
    const manifest = stockManifest();
    manifest.app.functions = [
      opsFunction(ALLOCATE_CODE, {
        // biome-ignore lint/suspicious/noExplicitAny: 異常系の構造を意図的に組む
        output: { ops: true, fields: [{ id: "x", type: "text" }] } as any,
      }),
    ];
    manifest.app.workflows = [opsWorkflow()];
    expectInvalid(validateManifest(manifest));
  });

  test("function.output は ops も fields も無い形を拒否する(どちらか一方が必要)", () => {
    const manifest = stockManifest();
    // biome-ignore lint/suspicious/noExplicitAny: 異常系の構造を意図的に組む
    manifest.app.functions = [opsFunction(ALLOCATE_CODE, { output: {} as any })];
    manifest.app.workflows = [opsWorkflow()];
    expectInvalid(validateManifest(manifest));
  });

  test("既存2モードのスキーマは1バイトも変わっていない(output_table / write_back。限定 A3)", () => {
    const manifest = baseManifest();
    manifest.app.functions = [countFunction()];
    manifest.app.workflows = [runFunctionWorkflow("count-by-month", "monthly-counts")];
    expect(validateManifest(manifest)).toEqual({ valid: true });
    // write_ops を持たない run_function は今日どおり output_table 必須である。
    expectInvalid(
      validateManifest(
        (() => {
          const m = baseManifest();
          m.app.functions = [countFunction()];
          m.app.workflows = [
            {
              id: "recount",
              name: "月次再集計",
              trigger: { type: "on_create", table: "members" },
              // biome-ignore lint/suspicious/noExplicitAny: 異常系
              actions: [{ action: "run_function", function: "count-by-month" } as any],
              history_table: "wf-runs",
            },
          ];
          return m;
        })(),
      ),
    );
  });
});

describe("V3-M13-T09 第3のモードの実行(1トランザクション。完了条件2 / 6・限定 B3)", () => {
  test("商品行と明細行の2テーブルを1回の発火で書ける(D-M13-1 の要求)", () => {
    const { manifest, productId } = setupStock();

    const line = createRecord(db, manifest, "order_line", { product: productId, qty: 3 });
    expect(line.ok).toBe(true);

    // 明細(create op)と残高(update op)が**同じ1回の発火**で両方書かれている。
    const moves = readAll(manifest, "stock_move");
    expect(moves.length).toBe(1);
    expect(moves[0]?.delta).toBe(-3);
    const products = readAll(manifest, "product");
    expect(products[0]?.stock).toBe(7);
    expect(readHistory(manifest).map((h) => h.status)).toEqual(["success"]);
  });

  test("2番目の op が失敗すると1番目の op も1バイトも残らない(全巻き戻し)", () => {
    // 1つ目は成功しうる create、2つ目は存在しないフィールドを書く update(必ず落ちる)。
    const code = `(input) => {
      const line = input[0];
      const p = input[1][0];
      return [
        { op: "create", table: "stock_move", values: { product: p._id, delta: -line.qty, source: line._id } },
        { op: "update", table: "product", target: p._id, if_match: p._updated_at, values: { no_such_field: 1 } },
      ];
    }`;
    const { manifest, productId } = setupStock(code);

    const line = createRecord(db, manifest, "order_line", { product: productId, qty: 3 });
    // アクションの失敗は発火元の書込ごと致命になる(ADR-0066)。
    expect(line.ok).toBe(false);
    // **1つ目の create op も残っていない。**
    expect(readAll(manifest, "stock_move").length).toBe(0);
    expect(readAll(manifest, "product")[0]?.stock).toBe(10);
    expect(readAll(manifest, "order_line").length).toBe(0);
  });

  test("島が例外で落ちる(在庫不足)と op は1件も適用されず、注文明細も成立しない(限定 B1 / B2)", () => {
    const { manifest, productId } = setupStock();
    const line = createRecord(db, manifest, "order_line", { product: productId, qty: 99 });
    expect(line.ok).toBe(false);
    expect(readAll(manifest, "order_line").length).toBe(0);
    expect(readAll(manifest, "stock_move").length).toBe(0);
    expect(readAll(manifest, "product")[0]?.stock).toBe(10);
  });

  test("update op に if_match が無いと拒否される(限定 A7。CAS 機構は新設しない)", () => {
    const code = `(input) => {
      const p = input[1][0];
      return [{ op: "update", table: "product", target: p._id, values: { stock: 1 } }];
    }`;
    const { manifest, productId } = setupStock(code);
    const line = createRecord(db, manifest, "order_line", { product: productId, qty: 1 });
    expect(line.ok).toBe(false);
    if (line.ok) {
      throw new Error("失敗するはずの書込が成功しました。");
    }
    expect(String(line.errors[0]?.message)).toContain("if_match");
    expect(readAll(manifest, "product")[0]?.stock).toBe(10);
  });

  test("delete op は語彙に無い(限定 A1)", () => {
    const code = `(input) => [{ op: "delete", table: "product", target: input[1][0]._id }]`;
    const { manifest, productId } = setupStock(code);
    const line = createRecord(db, manifest, "order_line", { product: productId, qty: 1 });
    expect(line.ok).toBe(false);
    expect(readAll(manifest, "product").length).toBe(1);
  });

  /**
   * **【期待値を1本だけ反転させた。黙って書き換えていない。2026-08-10】**
   *
   * **旧の期待値の逐語**: `expect(String(line.errors[0]?.message)).toContain("システムテーブル");`
   *
   * **反転の根拠**: **`V8-M26`(`D-V8-45` / `D-V8-65`)が面の既定を「閉じる」側へ倒した。**
   * **`_apps` はアプリのテーブル一覧に入らないので、面の規則を1本も持てない** ——
   * **したがって面が先に止め、文面は「システムテーブル」ではなく「アクセス権」になる。**
   * **拒否されること自体は今日も同じであり、`_apps` を名指しできることも変わらない。**
   *
   * **【正直に書く】限定 A8 のシステムテーブル遮断そのものは、本検査からは見えなくなった** ——
   * **今日ここが測っているのは「`_apps` を狙う op が1件も通らないこと」だけである。**
   */
  test("システムテーブル(_apps)を狙う op は拒否される(限定 A8。`V8-M26` で止める層が変わった)", () => {
    const code = `(input) => [{ op: "create", table: "_apps", values: { id: "x" } }]`;
    const { manifest, productId } = setupStock(code);
    const line = createRecord(db, manifest, "order_line", { product: productId, qty: 1 });
    expect(line.ok).toBe(false);
    if (line.ok) {
      throw new Error("失敗するはずの書込が成功しました。");
    }
    expect(String(line.errors[0]?.message)).toContain("_apps");
    expect(readAll(manifest, "stock_move").length).toBe(0);
  });

  test("出力が配列でなければ fail-closed(op を1件も適用しない)", () => {
    const code = `(input) => ({ op: "create", table: "stock_move", values: {} })`;
    const { manifest, productId } = setupStock(code);
    const line = createRecord(db, manifest, "order_line", { product: productId, qty: 1 });
    expect(line.ok).toBe(false);
    expect(readAll(manifest, "stock_move").length).toBe(0);
  });
});

describe("V3-M13-T09 apply 時の参照整合性が op に及ばない(限定 A11。完了条件8)", () => {
  test("存在しないテーブルを指す op を返す島は apply 時に valid で、実行時に failure になり発火元が巻き戻る", () => {
    const code = `(input) => [{ op: "create", table: "no_such_table", values: { x: 1 } }]`;
    const manifest = stockManifest();
    manifest.app.functions = [opsFunction(code)];
    manifest.app.workflows = [opsWorkflow()];

    // **apply 時の検査は1件も出ない**(op は実行時に生成されるので類型7 / 10 / 11 / 12 / 13 が効かない)。
    expect(validateManifest(manifest)).toEqual({ valid: true });
    expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });

    applyManifestDdl(db, manifest);
    const p = createRecord(db, manifest, "product", { name: "T", stock: 10 });
    if (!p.ok) {
      throw new Error("商品の作成に失敗");
    }
    const line = createRecord(db, manifest, "order_line", { product: p.value._id, qty: 1 });
    expect(line.ok).toBe(false);
    expect(readAll(manifest, "order_line").length).toBe(0);
    // 失敗は履歴に loud に残る(黙って空振りしない)。
    expect(readHistory(manifest).map((h) => h.status)).toEqual(["failure"]);
  });
});

// ============================================================================
// V3-M13-T10: 安全装置(所有者スコープ / op 件数上限 / 出力サイズ上限。ADR-0067 限定 A5 / A6)
//
// **T09 完了時点のコードは、島が誰の行にでも書け、op の件数にも上限が無かった**
// (`v3-m13-t09.md` §5-1 / §5-2 の実測)。**下の2つの describe は、その2本の回帰検査を
// 反転させたものである** —— T09 の記録が「T10 はこの検査を反転させることになる」と
// 予告している。
//
// **所有者スコープの判定は `src/server/owner-scope.ts` の `judgeOwnerScopedOp` 1本しか
// 無い**(限定 A5 の「判定を2箇所に書かない」)。カーネルはそれを**適用**するだけである。
// ============================================================================

/** `note`(個人所有テーブル)を足した在庫マニフェスト。 */
function stockManifestWithNotes(): Manifest {
  const manifest = stockManifest();
  manifest.app.tables.push({
    id: "note",
    name: "メモ",
    fields: [
      { id: "st_owner", name: "所有者", type: "text" },
      { id: "body", name: "本文", type: "text" },
    ],
  });
  return manifest;
}

/** `note` の1行目を狙う update op を返す島。 */
const OVERWRITE_NOTE_CODE = `(input) => {
  const victim = input[1][0];
  return [{ op: "update", table: "note", target: victim._id, if_match: victim._updated_at, values: { body: "島が書き換えた" } }];
}`;

describe("V3-M13-T10 所有者スコープ(限定 A5。必須。外せない)", () => {
  test("島は他人(st_owner)の行を書き換えられない —— 発火元ごと失敗し、行は1バイトも変わらない", () => {
    const manifest = stockManifestWithNotes();
    manifest.app.functions = [
      opsFunction(OVERWRITE_NOTE_CODE, {
        input: [{ source: "record" }, { source: "table", table: "note" }],
      }),
    ];
    manifest.app.workflows = [opsWorkflow()];
    applyManifestDdl(db, manifest);
    const p = createRecord(db, manifest, "product", { name: "T", stock: 10 });
    if (!p.ok) {
      throw new Error("商品の作成に失敗");
    }
    createRecord(db, manifest, "note", { st_owner: "user-b", body: "他人のメモ" });

    // 発火元(order_line)は st_owner を持たないので、この実行には actor が居ない。
    const line = createRecord(db, manifest, "order_line", { product: p.value._id, qty: 1 });
    expect(line.ok).toBe(false);
    expect(readAll(manifest, "note")[0]?.body).toBe("他人のメモ");
    expect(readAll(manifest, "order_line").length).toBe(0);
    // **黙って空振りしない** —— 失敗は履歴に loud に残る。
    expect(readHistory(manifest).map((h) => h.status)).toEqual(["failure"]);
    expect(String(readHistory(manifest)[0]?.error)).toContain("見つかりません");
  });

  test("共有行(st_owner が空)は書き換えられる —— 締めすぎていない", () => {
    const manifest = stockManifestWithNotes();
    manifest.app.functions = [
      opsFunction(OVERWRITE_NOTE_CODE, {
        input: [{ source: "record" }, { source: "table", table: "note" }],
      }),
    ];
    manifest.app.workflows = [opsWorkflow()];
    applyManifestDdl(db, manifest);
    const p = createRecord(db, manifest, "product", { name: "T", stock: 10 });
    if (!p.ok) {
      throw new Error("商品の作成に失敗");
    }
    createRecord(db, manifest, "note", { body: "みんなのメモ" });

    const line = createRecord(db, manifest, "order_line", { product: p.value._id, qty: 1 });
    expect(line.ok).toBe(true);
    expect(readAll(manifest, "note")[0]?.body).toBe("島が書き換えた");
  });

  test("トリガー元の行の所有者と同じ所有者の行は書き換えられる(actor = 発火させた行の所有者)", () => {
    const manifest = stockManifestWithNotes();
    // 発火元(order_line)自身を個人所有テーブルにする —— これが actor の出どころである。
    manifest.app.tables
      .find((t) => t.id === "order_line")
      ?.fields.push({ id: "st_owner", name: "所有者", type: "text" });
    manifest.app.functions = [
      opsFunction(OVERWRITE_NOTE_CODE, {
        input: [{ source: "record" }, { source: "table", table: "note" }],
      }),
    ];
    manifest.app.workflows = [opsWorkflow()];
    applyManifestDdl(db, manifest);
    const p = createRecord(db, manifest, "product", { name: "T", stock: 10 });
    if (!p.ok) {
      throw new Error("商品の作成に失敗");
    }
    createRecord(db, manifest, "note", { st_owner: "user-a", body: "本人のメモ" });

    const mine = createRecord(db, manifest, "order_line", {
      product: p.value._id,
      qty: 1,
      st_owner: "user-a",
    });
    expect(mine.ok).toBe(true);
    expect(readAll(manifest, "note")[0]?.body).toBe("島が書き換えた");
  });

  test("create op の st_owner は actor で必ず上書きされる(島が他人の名前で行を作れない)", () => {
    const manifest = stockManifestWithNotes();
    manifest.app.tables
      .find((t) => t.id === "order_line")
      ?.fields.push({ id: "st_owner", name: "所有者", type: "text" });
    const code = `(input) => [{ op: "create", table: "note", values: { st_owner: "user-b", body: "詐称" } }]`;
    manifest.app.functions = [opsFunction(code)];
    manifest.app.workflows = [opsWorkflow()];
    applyManifestDdl(db, manifest);
    const p = createRecord(db, manifest, "product", { name: "T", stock: 10 });
    if (!p.ok) {
      throw new Error("商品の作成に失敗");
    }
    const mine = createRecord(db, manifest, "order_line", {
      product: p.value._id,
      qty: 1,
      st_owner: "user-a",
    });
    expect(mine.ok).toBe(true);
    expect(readAll(manifest, "note")[0]?.st_owner).toBe("user-a");
  });

  test("actor を特定できない実行は、個人所有テーブルへ1行も作れない", () => {
    // 発火元(order_line)に st_owner が無い = actor が居ない。
    const code = `(input) => [{ op: "create", table: "note", values: { body: "誰のもの?" } }]`;
    const manifest = stockManifestWithNotes();
    manifest.app.functions = [opsFunction(code)];
    manifest.app.workflows = [opsWorkflow()];
    applyManifestDdl(db, manifest);
    const p = createRecord(db, manifest, "product", { name: "T", stock: 10 });
    if (!p.ok) {
      throw new Error("商品の作成に失敗");
    }
    // **【`V8-M26`(2026-08-10)】持ち主を空文字で明示する。**
    // **この題材は `V8-M26` の下ごしらえが `order_line` に持ち主の列を足すので、
    //   何も書かないと下ごしらえが書き手を入れてしまい、「actor が居ない」という
    //   本検査の前提が消える。** **空文字は「特定できない」と同じ意味である**
    //   (`resolveWorkflowActor` の戻り値の空文字を呼び出し側が `null` に倒す)。
    const line = createRecord(db, manifest, "order_line", {
      product: p.value._id,
      qty: 1,
      st_owner: "",
    });
    expect(line.ok).toBe(false);
    expect(readAll(manifest, "note").length).toBe(0);
    expect(String(readHistory(manifest)[0]?.error)).toContain("所有者");
  });

  test("所有者の付け替え(私物化)は拒否される", () => {
    const manifest = stockManifestWithNotes();
    manifest.app.tables
      .find((t) => t.id === "order_line")
      ?.fields.push({ id: "st_owner", name: "所有者", type: "text" });
    const code = `(input) => {
      const victim = input[1][0];
      return [{ op: "update", table: "note", target: victim._id, if_match: victim._updated_at, values: { st_owner: "user-a" } }];
    }`;
    manifest.app.functions = [
      opsFunction(code, { input: [{ source: "record" }, { source: "table", table: "note" }] }),
    ];
    manifest.app.workflows = [opsWorkflow()];
    applyManifestDdl(db, manifest);
    const p = createRecord(db, manifest, "product", { name: "T", stock: 10 });
    if (!p.ok) {
      throw new Error("商品の作成に失敗");
    }
    createRecord(db, manifest, "note", { body: "共有のメモ" });
    const mine = createRecord(db, manifest, "order_line", {
      product: p.value._id,
      qty: 1,
      st_owner: "user-a",
    });
    expect(mine.ok).toBe(false);
    expect(readAll(manifest, "note")[0]?.st_owner ?? null).toBe(null);
  });

  test("個人所有でないテーブル(product / stock_move)への引き当ては1ミリも変わらない", () => {
    const { manifest, productId } = setupStock();
    const line = createRecord(db, manifest, "order_line", { product: productId, qty: 3 });
    expect(line.ok).toBe(true);
    expect(readAll(manifest, "product")[0]?.stock).toBe(7);
    expect(readAll(manifest, "stock_move").length).toBe(1);
  });
});

// ============================================================================
// V4-M34-T01: 島が空の op 配列を返したとき(`ADR-0131` 単位A = 限定採用)
//
// **限定1 の機械的検査の3本目(島の経路)**。HTTP 経路と MCP 経路は
// `src/server/batch.test.ts` が持つ。**3本とも同じ `writeRecords` の戻り値を受ける** ——
// `src/kernel/workflow-runner.ts` に「op が0件なら〜」の分岐を1行も足していない
// (単位B = 却下。`ADR-0003` §7 / `workflow-runner.ts` の逐語「**判定を1つも複製しない**」)。
//
// **これが `E-G43` の形である**(審査記録 §2-1 の P1)。**反転前は、島が `[]` を返すと
// `writeRecords` が「バッチに操作が1件もありません。」で落ち、`ADR-0066` により
// 発火元の行の作成ごと巻き戻っていた。**
// ============================================================================
describe("V4-M34-T01 島が空の op 配列を返す(ADR-0131 単位A)", () => {
  /** **何も書くことが無かった**ときに `[]` を返す島(`E-G43` の形)。 */
  const EMPTY_OPS_CODE = `(input) => { return []; }`;

  test("発火元の行が消えない —— 島が [] を返しても作成は成立する(E-G43 の症状が止まる)", () => {
    const { manifest, productId } = setupStock(EMPTY_OPS_CODE);
    const line = createRecord(db, manifest, "order_line", { product: productId, qty: 1 });
    expect(line.ok).toBe(true);
    // **発火元の行が跡形もなく消えない**(`ADR-0066` による巻き戻しが起きない)。
    expect(readAll(manifest, "order_line").length).toBe(1);
  });

  test("島が何も書かないのでディスクは1バイトも動かない(限定3)", () => {
    const { manifest, productId } = setupStock(EMPTY_OPS_CODE);
    createRecord(db, manifest, "order_line", { product: productId, qty: 1 });
    expect(readAll(manifest, "stock_move").length).toBe(0);
    expect(readAll(manifest, "product")[0]?.stock).toBe(10);
  });

  test("実行の事実は消えない —— 履歴に1行残り status は success / error は null(限定8)", () => {
    const { manifest, productId } = setupStock(EMPTY_OPS_CODE);
    createRecord(db, manifest, "order_line", { product: productId, qty: 1 });
    // **`status` は既存の式(`statusOverride ?? (succeeded ? "success" : "failure")`)が
    // 決める `success` である。** **「抑制」などの別種別を1つも作っていない**(限定8)。
    expect(readHistory(manifest)).toEqual([{ status: "success", error: null }]);
  });
});

describe("V3-M13-T10 op 件数の上限(限定 A6。必須。外せない)", () => {
  /** N 件の create op を返す島。 */
  function bulkCode(n: number): string {
    return `(input) => {
      const ops = [];
      const p = input[1][0];
      for (let i = 0; i < ${n}; i++) {
        ops.push({ op: "create", table: "stock_move", values: { product: p._id, delta: 1, source: "bulk-" + i } });
      }
      return ops;
    }`;
  }

  test("上限ちょうど(1000 件)は適用される", () => {
    const { manifest, productId } = setupStock(bulkCode(1000));
    const line = createRecord(db, manifest, "order_line", { product: productId, qty: 1 });
    expect(line.ok).toBe(true);
    expect(readAll(manifest, "stock_move").length).toBe(1000);
  });

  test("上限を1件超える(1001 件)と拒否され、1バイトも書かれない(打ち切らない)", () => {
    const { manifest, productId } = setupStock(bulkCode(1001));
    const line = createRecord(db, manifest, "order_line", { product: productId, qty: 1 });
    expect(line.ok).toBe(false);
    // **黙って一部だけ書かない**(憲法6 / 限定 A6)。
    expect(readAll(manifest, "stock_move").length).toBe(0);
    expect(readAll(manifest, "order_line").length).toBe(0);
    const error = String(readHistory(manifest)[0]?.error);
    expect(error).toContain("1001");
    expect(error).toContain("1000");
  });

  test("T09 が実測した 2000 件も、もう素通りしない", () => {
    const { manifest, productId } = setupStock(bulkCode(2000));
    const line = createRecord(db, manifest, "order_line", { product: productId, qty: 1 });
    expect(line.ok).toBe(false);
    expect(readAll(manifest, "stock_move").length).toBe(0);
  });
});

describe("V3-M13-T10 島の出力サイズの上限が run_function 経路にも効く(限定 A6)", () => {
  test("巨大な出力を返す島は failure になり、発火元ごと巻き戻る", () => {
    // 1 op あたり約79文字 × 100,000 件 ≒ 7.9M 文字 > 1 MiB。
    const code = `(input) => {
      const ops = [];
      for (let i = 0; i < 100000; i++) {
        ops.push({ op: "update", table: "product", target: "row-" + i, values: { qty: i } });
      }
      return ops;
    }`;
    const { manifest, productId } = setupStock(code);
    const line = createRecord(db, manifest, "order_line", { product: productId, qty: 1 });
    expect(line.ok).toBe(false);
    expect(readAll(manifest, "order_line").length).toBe(0);
    expect(String(readHistory(manifest)[0]?.error)).toContain("output_too_large");
  });
});

describe("V3-M13-T09 schedule 起点でも op 配列は1原子で適用される(限定 C1 / C4 / A12)", () => {
  test("行選択のある schedule から2テーブル(注文の状態 + 明細)を1回のアクションで書ける", () => {
    const manifest = stockManifest();
    manifest.app.tables.push({
      id: "purchase",
      name: "注文",
      fields: [
        { id: "state", name: "状態", type: "text", required: true },
        { id: "qty", name: "数量", type: "number", required: true },
      ],
    });
    // 打ち切り(update)と戻しの明細(create)を**同じ op 配列**に入れる(限定 C4)。
    const code = `(input) => {
      const order = input[0];
      const products = input[1];
      const p = products[0];
      return [
        { op: "update", table: "purchase", target: order._id, if_match: order._updated_at, values: { state: "cancelled" } },
        { op: "create", table: "stock_move", values: { product: p._id, delta: order.qty, source: "cancel:" + order._id } },
      ];
    }`;
    manifest.app.functions = [opsFunction(code)];
    const wf: Workflow = {
      id: "restore",
      name: "滞留注文の打ち切りと戻し",
      trigger: { type: "schedule", at: { hour: 3, minute: 0 }, table: "purchase" },
      // biome-ignore lint/suspicious/noExplicitAny: 第3のモードの action 形
      actions: [{ action: "run_function", function: "allocate-stock", write_ops: true } as any],
      history_table: "wf-runs",
    };
    manifest.app.workflows = [wf];
    expect(validateManifest(manifest)).toEqual({ valid: true });
    applyManifestDdl(db, manifest);
    const product = createRecord(db, manifest, "product", { name: "T", stock: 10 });
    const order = createRecord(db, manifest, "purchase", { state: "pending", qty: 4 });
    if (!product.ok || !order.ok) {
      throw new Error("下ごしらえに失敗");
    }

    // **`workflow-scheduler.ts` を1バイトも触らずに、既存の発火経路から走らせる。**
    runScheduledWorkflow(db, manifest, wf, { records: [order.value] });

    expect(readAll(manifest, "purchase")[0]?.state).toBe("cancelled");
    expect(readAll(manifest, "stock_move").map((r) => r.delta)).toEqual([4]);
    expect(readHistory(manifest).map((h) => h.status)).toEqual(["success"]);
  });

  test("schedule で op が1件でも落ちれば、その発火の書込は1バイトも残らない(原子性は op 配列の内側だけ)", () => {
    const manifest = stockManifest();
    manifest.app.tables.push({
      id: "purchase",
      name: "注文",
      fields: [
        { id: "state", name: "状態", type: "text", required: true },
        { id: "qty", name: "数量", type: "number", required: true },
      ],
    });
    const code = `(input) => {
      const order = input[0];
      return [
        { op: "update", table: "purchase", target: order._id, if_match: order._updated_at, values: { state: "cancelled" } },
        { op: "create", table: "stock_move", values: { product: "no-such-product", delta: 1, source: "x" } },
      ];
    }`;
    manifest.app.functions = [opsFunction(code)];
    const wf: Workflow = {
      id: "restore",
      name: "滞留注文の打ち切りと戻し",
      trigger: { type: "schedule", at: { hour: 3, minute: 0 }, table: "purchase" },
      // biome-ignore lint/suspicious/noExplicitAny: 第3のモードの action 形
      actions: [{ action: "run_function", function: "allocate-stock", write_ops: true } as any],
      history_table: "wf-runs",
    };
    manifest.app.workflows = [wf];
    applyManifestDdl(db, manifest);
    createRecord(db, manifest, "product", { name: "T", stock: 10 });
    const order = createRecord(db, manifest, "purchase", { state: "pending", qty: 4 });
    if (!order.ok) {
      throw new Error("下ごしらえに失敗");
    }

    runScheduledWorkflow(db, manifest, wf, { records: [order.value] });

    // 打ち切り(1つ目の op)も残っていない = 部分適用ゼロ。
    expect(readAll(manifest, "purchase")[0]?.state).toBe("pending");
    expect(readAll(manifest, "stock_move").length).toBe(0);
    expect(readHistory(manifest).map((h) => h.status)).toEqual(["failure"]);
  });
});
