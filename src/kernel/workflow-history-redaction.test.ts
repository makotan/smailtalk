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
import { applyManifestDdl } from "./ddl.ts";
import { ensureIslandRuntimeReady } from "./island-runner.ts";
import { createRecord, listRecords, type RecordRow } from "./records.ts";
import { appDbPath } from "./storage-paths.ts";
import type { FunctionDef, Manifest, Workflow } from "./types.ts";
import { runScheduledWorkflow, runWorkflows } from "./workflow-runner.ts";

/**
 * **`AC-G27a` / `V17-M3-T07`** —— **実行履歴(`_workflow_history` 相当の履歴テーブル)の
 * `error` 列に、他人の行の値が流れ込む口を全部撃つ。**
 *
 * **`b1` の再現**(`docs/plan/v16/records/investigation-b1-unmeasured-writes.md:258`-`:311`)は、
 * **無関係な `user3` が履歴を開くと `error` に他人3人分の `title` / `memo` / `st_owner` が
 * 丸ごと入っている**ことを実測している。 **本ファイルはその型を、カーネルの単体の高さで
 * 7つの流入口それぞれについて撃つ。**
 *
 * **計画 `docs/plan/v17/04-v17-m3-plan.md` §2-2 の #K / §3-7 の実測**:
 * **流入口は起票が数えた4つではなく7つである。**
 *
 * | # | どこ | 何が入るか |
 * |--:|---|---|
 * | (i)   | 島(`run_function`)が投げた例外の本文 | `throw new Error(JSON.stringify(rows))` で行が丸ごと |
 * | (ii)  | 島の出力のスキーマ検証の失敗 | `formatErrors` |
 * | (iii) | `create_record` / `update_record` の検証失敗 | `formatErrors` → `records.ts` の「受け取った値: …」 |
 * | (iv)  | `update_record` の `target` の解決失敗 | `JSON.stringify(...)` |
 * | (v)   | `output_table` の書込失敗 | 同上 |
 * | (vi)  | `write_back` の書込失敗 | 同上 |
 * | (vii) | `write_ops` の適用失敗 | 同上 |
 *
 * **【`_id` は落とさない。残す】**(計画 §3-7 の決着5-2)——
 * **`b1` が名指しした3つは `title` / `memo` / `st_owner` であって `_id` ではない。**
 * **`_id` は行の識別子であって中身ではなく、落とすと「どの行で失敗したか」が履歴から読めなくなる。**
 *
 * **本物の SQLite・本物の QuickJS-WASM で走らせる。モックを1つも置かない**
 * (`run-function.test.ts` / `aggregation-demo.test.ts` の作法に揃える)。
 */

beforeAll(async () => {
  await ensureIslandRuntimeReady();
});

const APP_ID = "leak-probe";

/**
 * **他人の行にだけ在る合言葉。** **履歴に1文字も出てはいけない。**
 * **`b1` の `memo`(「user2だけの秘密」)に対応する。**
 */
const CANARY_MEMO = "CANARY-他人だけの秘密メモ";
/** **同じく `title` に対応する合言葉。** */
const CANARY_TITLE = "CANARY-他人の行の題名";
/** **`(iv)` 用。参照列に入った文字列でない値**(SQLite は列の型を強制しない)。 */
const CANARY_NUMBER = 987654321;

/** 履歴テーブルの5列(規約どおり。`WORKFLOW_HISTORY_COLUMNS` は 5列のまま)。 */
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
 * 題材。
 *
 * - `secrets` —— **他人の行**が入る表(`title` / `memo` / `amount` / `linked`)。
 * - `targets` —— 書込先(`month` は text、`count` は number)。
 * - `num-out`  —— **`month` が number** の書込先(型の食い違いを作るためだけの表)。
 * - `wf-runs`  —— 履歴表(規約5列)。
 */
function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "履歴の漏れを撃つ台",
      tables: [
        {
          id: "secrets",
          name: "秘密",
          fields: [
            { id: "title", name: "題名", type: "text" },
            { id: "memo", name: "覚書", type: "text" },
            { id: "amount", name: "金額", type: "number" },
            { id: "linked", name: "参照先", type: "reference", reference_table: "secrets" },
          ],
        },
        {
          id: "targets",
          name: "書込先",
          fields: [
            { id: "month", name: "月", type: "text" },
            { id: "count", name: "件数", type: "number" },
          ],
        },
        {
          id: "num-out",
          name: "数値だけの書込先",
          fields: [{ id: "month", name: "月", type: "number" }],
        },
        { id: "wf-runs", name: "実行履歴", fields: historyFields() },
      ],
      views: [],
    },
  };
}

let dataRoot: string;
let db: Database;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-history-redaction-"));
  const dbPath = appDbPath(dataRoot, APP_ID);
  await mkdir(join(dataRoot, "apps", APP_ID), { recursive: true });
  db = new Database(dbPath, { create: true });
});

afterEach(async () => {
  db.close();
  await rm(dataRoot, { recursive: true, force: true });
});

/** 題材をディスクに当てる(**時刻起動の題材。壁の下ごしらえは要らない**)。 */
function arm(manifest: Manifest): void {
  applyManifestDdl(db, manifest);
}

/** 題材をディスクに当てる(**`on_create` の題材。壁を開ける下ごしらえを入れる**)。 */
function armForEvents(manifest: Manifest): void {
  armManifestForAutomation(manifest);
  applyManifestDdl(db, manifest);
  seedAutomationActor(db);
}

/** **他人の行**を1件作る。 */
function seedSecret(manifest: Manifest, values: Record<string, unknown> = {}): RecordRow {
  const result = createRecord(db, manifest, "secrets", {
    title: CANARY_TITLE,
    memo: CANARY_MEMO,
    ...values,
  });
  if (!result.ok) {
    throw new Error(`他人の行を作れませんでした: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

/** 履歴の全行を作成順に読む。 */
function readHistory(manifest: Manifest): { workflow: string; status: string; error: string }[] {
  const result = listRecords(db, manifest, "wf-runs");
  if (!result.ok) {
    throw new Error("wf-runs を読めませんでした");
  }
  return result.value.map((row) => ({
    workflow: String(row.workflow ?? ""),
    status: String(row.status ?? ""),
    error: String(row.error ?? ""),
  }));
}

/** 履歴の `error` を1つの文字列に畳む(**読み手が画面で見る全量**)。 */
function historyText(manifest: Manifest): string {
  return readHistory(manifest)
    .map((row) => row.error)
    .join("\n");
}

/** `run_function` の関数定義を1本組む。 */
function fn(overrides: Partial<FunctionDef> & { id: string; code: string }): FunctionDef {
  return {
    name: overrides.id,
    input: { source: "table", table: "secrets" },
    output: { fields: [{ id: "month", type: "text" }] },
    capabilities: [],
    ...overrides,
  } as FunctionDef;
}

/** 時刻起動のワークフローを1本組む。 */
function scheduleWorkflow(id: string, actions: unknown[], table?: string): Workflow {
  return {
    id,
    name: id,
    trigger: table === undefined ? { type: "schedule" } : { type: "schedule", table },
    // biome-ignore lint/suspicious/noExplicitAny: 題材のアクションを直に組む
    actions: actions as any,
    history_table: "wf-runs",
  } as Workflow;
}

// --- (i) 島が投げた例外の本文 -------------------------------------------------

test("(i) 島が投げた例外の本文が、他人の行を丸ごと履歴に流し込まない", () => {
  const manifest = baseManifest();
  manifest.app.functions = [
    fn({
      id: "throw-rows",
      // **`b1` と同じ形** —— **島が読んだ行(アクセス権で絞られていない)を丸ごと投げる。**
      code: `(rows) => { throw new Error(JSON.stringify(rows)); }`,
    }),
  ];
  manifest.app.workflows = [
    scheduleWorkflow("wf-i", [
      { action: "run_function", function: "throw-rows", output_table: "targets" },
    ]),
  ];
  arm(manifest);
  seedSecret(manifest);

  runScheduledWorkflow(db, manifest, manifest.app.workflows[0] as Workflow);

  const text = historyText(manifest);
  expect(readHistory(manifest)).toHaveLength(1);
  expect(readHistory(manifest)[0]?.status).toBe("failure");
  // **失敗の種別(`error` / `timeout` / `memory` …)は残る。**
  expect(text).toContain("error");
  // **他人の行の値は1つも残らない。**
  expect(text).not.toContain(CANARY_MEMO);
  expect(text).not.toContain(CANARY_TITLE);
});

// --- (ii) 島の出力のスキーマ検証の失敗 ---------------------------------------

test("(ii) 島の出力のスキーマ検証の失敗が、他人の行の値を履歴に流し込まない", () => {
  const manifest = baseManifest();
  manifest.app.functions = [
    fn({
      id: "bad-output",
      // `count` は number 宣言。**他人の行の `memo` を入れると型で落ちる。**
      code: `(rows) => rows.map((r) => ({ month: "2026-09", count: r.memo }))`,
      output: {
        fields: [
          { id: "month", type: "text" },
          { id: "count", type: "number" },
        ],
      },
    }),
  ];
  manifest.app.workflows = [
    scheduleWorkflow("wf-ii", [
      { action: "run_function", function: "bad-output", output_table: "targets" },
    ]),
  ];
  arm(manifest);
  seedSecret(manifest);

  runScheduledWorkflow(db, manifest, manifest.app.workflows[0] as Workflow);

  const text = historyText(manifest);
  expect(readHistory(manifest)[0]?.status).toBe("failure");
  expect(text).toContain("スキーマ検証に失敗");
  expect(text).not.toContain(CANARY_MEMO);
});

// --- (iii) create_record / update_record の検証失敗 ---------------------------

test("(iii-a) create_record の検証失敗が、他人の行の値を履歴に流し込まない", () => {
  const manifest = baseManifest();
  manifest.app.workflows = [
    scheduleWorkflow("wf-iii-a", [
      // `count` は number。**他人の行の `memo` を入れると型で落ちる。**
      { action: "create_record", table: "targets", values: { count: "$record.memo" } },
    ]),
  ];
  arm(manifest);
  const row = seedSecret(manifest);

  runScheduledWorkflow(db, manifest, manifest.app.workflows[0] as Workflow, { records: [row] });

  const text = historyText(manifest);
  expect(readHistory(manifest)[0]?.status).toBe("failure");
  expect(text).toContain("アクション1(create_record → targets)");
  expect(text).not.toContain(CANARY_MEMO);
});

test("(iii-b) update_record の検証失敗が、他人の行の値を履歴に流し込まない", () => {
  const manifest = baseManifest();
  manifest.app.workflows = [
    scheduleWorkflow("wf-iii-b", [
      // `amount` は number。**他人の行の `memo` を入れると型で落ちる。**
      {
        action: "update_record",
        table: "secrets",
        target: "$record._id",
        values: { amount: "$record.memo" },
      },
    ]),
  ];
  arm(manifest);
  const row = seedSecret(manifest);

  runScheduledWorkflow(db, manifest, manifest.app.workflows[0] as Workflow, { records: [row] });

  const text = historyText(manifest);
  expect(readHistory(manifest)[0]?.status).toBe("failure");
  expect(text).toContain("アクション1(update_record → secrets)");
  expect(text).not.toContain(CANARY_MEMO);
});

// --- (iv) update_record の target の解決失敗 ----------------------------------

test("(iv) update_record の target の解決失敗が、他人の行の値を履歴に流し込まない", () => {
  const manifest = baseManifest();
  manifest.app.workflows = [
    scheduleWorkflow("wf-iv", [
      // `linked` は reference 型なので `checkTargetReferenceField` は通る。
      // **その列に入っている他人の行の値が `_id` にならない**ときの断りを撃つ。
      {
        action: "update_record",
        table: "secrets",
        target: "$record.linked",
        values: { title: "書き換え" },
      },
    ]),
  ];
  arm(manifest);
  const row = seedSecret(manifest);
  // **SQLite は列の型を強制しない。** 参照列に数値が入っている行を、そのまま発火の対象にする。
  const planted = { ...row, linked: CANARY_NUMBER } as unknown as RecordRow;

  runScheduledWorkflow(db, manifest, manifest.app.workflows[0] as Workflow, { records: [planted] });

  const text = historyText(manifest);
  expect(readHistory(manifest)[0]?.status).toBe("failure");
  expect(text).toContain("解決できませんでした");
  expect(text).not.toContain(String(CANARY_NUMBER));
});

// --- (v) output_table の書込失敗 ----------------------------------------------

test("(v) output_table の書込失敗が、他人の行の値を履歴に流し込まない", () => {
  const manifest = baseManifest();
  manifest.app.functions = [
    fn({
      id: "text-month",
      // 出力の宣言は text。**書込先 `num-out` の `month` は number** なので `createRecord` が落ちる。
      code: `(rows) => rows.map((r) => ({ month: r.memo }))`,
      output: { fields: [{ id: "month", type: "text" }] },
    }),
  ];
  manifest.app.workflows = [
    scheduleWorkflow("wf-v", [
      { action: "run_function", function: "text-month", output_table: "num-out" },
    ]),
  ];
  arm(manifest);
  seedSecret(manifest);

  runScheduledWorkflow(db, manifest, manifest.app.workflows[0] as Workflow);

  const text = historyText(manifest);
  expect(readHistory(manifest)[0]?.status).toBe("failure");
  expect(text).toContain("num-out");
  expect(text).not.toContain(CANARY_MEMO);
});

// --- (vi) write_back の書込失敗 ----------------------------------------------

test("(vi) write_back の書込失敗が、他人の行の値を履歴に流し込まない", () => {
  const manifest = baseManifest();
  manifest.app.functions = [
    fn({
      id: "write-back-bad",
      input: { source: "record" },
      // 出力の宣言は text。**書き戻し先 `secrets.amount` は number** なので `updateRecord` が落ちる。
      code: `(rec) => [{ amount: rec.memo }]`,
      output: { fields: [{ id: "amount", type: "text" }] },
    }),
  ];
  // **ワークフローは行を作った**後**に差す** —— **`on_create` の失敗は
  // その `createRecord` ごと巻き戻すので、先に差すと題材の行が残らない。**
  armForEvents(manifest);
  const created = createRecord(
    db,
    manifest,
    "secrets",
    fixtureOwnerValues(manifest, "secrets", { title: CANARY_TITLE, memo: CANARY_MEMO }),
  );
  if (!created.ok) {
    throw new Error(`他人の行を作れませんでした: ${JSON.stringify(created.errors)}`);
  }
  manifest.app.workflows = [
    {
      id: "wf-vi",
      name: "wf-vi",
      trigger: { type: "on_create", table: "secrets" },
      actions: [{ action: "run_function", function: "write-back-bad", write_back: "$record" }],
      history_table: "wf-runs",
    } as Workflow,
  ];

  runWorkflows(db, manifest, "secrets", "on_create", created.value);

  const text = historyText(manifest);
  expect(readHistory(manifest)[0]?.status).toBe("failure");
  expect(text).toContain("書き戻せませんでした");
  expect(text).not.toContain(CANARY_MEMO);
});

// --- (vii) write_ops の適用失敗 ----------------------------------------------

test("(vii) write_ops の適用失敗が、他人の行の値を履歴に流し込まない", () => {
  const manifest = baseManifest();
  manifest.app.functions = [
    fn({
      id: "bad-ops",
      // `targets.count` は number。**他人の行の `memo` を入れると `writeRecords` が落ちる。**
      code: `(rows) => [{ op: "create", table: "targets", values: { count: rows[0].memo } }]`,
      output: { ops: true },
    }),
  ];
  manifest.app.workflows = [
    scheduleWorkflow("wf-vii", [
      { action: "run_function", function: "bad-ops", write_ops: true, output_table: "targets" },
    ]),
  ];
  arm(manifest);
  seedSecret(manifest);

  runScheduledWorkflow(db, manifest, manifest.app.workflows[0] as Workflow);

  const text = historyText(manifest);
  expect(readHistory(manifest)[0]?.status).toBe("failure");
  expect(text).toContain("更新操作を適用できませんでした");
  expect(text).not.toContain(CANARY_MEMO);
});

// --- 完了条件の後半: id と失敗の種類が読める ---------------------------------

test("失敗したワークフローの id と失敗の種類が、今日どおり履歴から読める", () => {
  const manifest = baseManifest();
  manifest.app.workflows = [
    scheduleWorkflow("wf-readable", [
      { action: "create_record", table: "targets", values: { count: "$record.memo" } },
    ]),
  ];
  arm(manifest);
  const row = seedSecret(manifest);

  runScheduledWorkflow(db, manifest, manifest.app.workflows[0] as Workflow, { records: [row] });

  const history = readHistory(manifest);
  expect(history).toHaveLength(1);
  // **id は `workflow` 列。**
  expect(history[0]?.workflow).toBe("wf-readable");
  // **成否は `status` 列。**
  expect(history[0]?.status).toBe("failure");
  // **失敗の種類はラベル。`destination` は表 id という識別子だけである。**
  expect(history[0]?.error).toContain("アクション1(create_record → targets)");
  // **どの行で失敗したかは `_id` で読める**(**`_id` は落とさない** —— 計画 §3-7 の決着5-2)。
  expect(history[0]?.error).toContain(row._id);
});
