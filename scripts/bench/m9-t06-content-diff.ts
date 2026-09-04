/**
 * V1-M9-T06 判断ゲート用の単発ベンチマーク(新規・既存ファイルは1行も変更しない)。
 *
 * ## 目的
 *
 * `previewUndo` の件数算出を「`_id` の集合差」(現行。`src/kernel/undo.ts` の
 * `countRecordChanges`)から「内容比較」へ広げた場合の**追加コスト**を測る。
 * 既存 `scripts/bench/` のハーネス(`fixture.ts` / `measure.ts`)をそのまま import して使う
 * (三重に作らない)。**新規シナリオを `scenarios.ts` / `run.ts` へは足さない** —— この
 * ファイル単体で完結させ、既存ファイルへの書き込みを一切発生させないため。
 *
 * ## 測る3手法
 *
 * 1. **baseline(現行実装そのもの)**: `_id` 列だけを2つの DB から読んで `Set` 差分を取る
 *    (`countRecordChanges` と同じクエリ形)。
 * 2. **naive-js**: 両方の DB から全列を読んで id→row の Map を作り、共通 id について
 *    JS 側でフィールドごとに値を比較する(`_created_at` / `_updated_at` は比較対象から除く)。
 * 3. **sql-attach**: `ATTACH DATABASE` でスナップショット側を同一接続にぶら下げ、
 *    1本の SQL(`JOIN ... WHERE 列の不一致条件`)で異なる行数を数える。
 *
 * ## 使い方
 *
 * ```console
 * $ bun run scripts/bench/m9-t06-content-diff.ts
 * $ bun run scripts/bench/m9-t06-content-diff.ts --out=scripts/bench/results/m9-t06-content-diff.json
 * ```
 *
 * 測定規律は既存ベンチと同じ: 時間は桁と比のみを主張する。`environment` を同梱する。
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureEnvironment } from "./env.ts";
import { buildApp } from "./fixture.ts";
import { summarizeTimings, type Timing, timeOnce } from "./measure.ts";
import { Rng } from "./rng.ts";

const DEFAULT_SEED = 20260719;
const REPS = 3;
// 比較対象の5フィールド(fixture.ts の fieldsOf() と一致させる)。システム列は含めない。
const CONTENT_FIELDS = ["title", "memo", "qty", "status", "due"] as const;
// 現在DB側で「内容だけ変えた」ことにする行の割合(apply後にユーザが編集した想定)。
const MUTATION_FRACTION = 0.2;

type Row = {
  _id: string;
  title: string;
  memo: string;
  qty: number;
  status: string;
  due: string;
};

/** `n` 行のテーブルを1つ持つ current DB を作り、その一部行を「編集」した状態にする。 */
function buildScenario(n: number, seed: number): { dataRoot: string; dbPath: string } {
  const dataRoot = mkdtempSync(join(tmpdir(), "gp-bench-t06-"));
  const app = buildApp({
    dataRoot,
    appId: "app1",
    tables: 1,
    rowsPerTable: n,
    seed,
  });
  const tableId = app.table_ids[0];
  if (tableId === undefined) {
    throw new Error("テーブルが作られませんでした");
  }
  // MUTATION_FRACTION 分の行の title を書き換える(内容だけ変わったレコードを作る)。
  // _updated_at も本物の apply-diff 経路と同様に更新する(粒度判定の対象になる列)。
  const db = new Database(app.db_path, { readwrite: true, create: false });
  try {
    const rng = new Rng(seed + 999983);
    const mutateCount = Math.floor(n * MUTATION_FRACTION);
    const update = db.query(
      `UPDATE "${tableId}" SET "title" = ?, "_updated_at" = ? WHERE "_id" = ?`,
    );
    db.transaction(() => {
      for (let i = 0; i < mutateCount; i++) {
        const idx = rng.int(n);
        const id = `${tableId}-${String(idx).padStart(9, "0")}`;
        update.run(`編集後の件名 ${rng.int(1_000_000)}`, "2026-07-23T00:00:00.000Z", id);
      }
    })();
  } finally {
    db.close();
  }
  return { dataRoot, dbPath: app.db_path };
}

/** baseline: `_id` 列だけを読んで Set 差分(= 現行 `countRecordChanges` と同じクエリ形)。 */
function baselineIdDiff(currentDb: Database, snapshotDb: Database, tableId: string): number {
  const cur = currentDb.query<{ _id: string }, []>(`SELECT "_id" FROM "${tableId}"`).all();
  const snap = snapshotDb.query<{ _id: string }, []>(`SELECT "_id" FROM "${tableId}"`).all();
  const snapIds = new Set(snap.map((r) => r._id));
  let lost = 0;
  for (const row of cur) {
    if (!snapIds.has(row._id)) lost++;
  }
  return lost;
}

/** naive-js: 全列を読み、id→row の Map を作って JS 側でフィールド比較する。 */
function naiveJsContentDiff(currentDb: Database, snapshotDb: Database, tableId: string): number {
  const cols = ["_id", ...CONTENT_FIELDS].map((c) => `"${c}"`).join(", ");
  const cur = currentDb.query<Row, []>(`SELECT ${cols} FROM "${tableId}"`).all();
  const snap = snapshotDb.query<Row, []>(`SELECT ${cols} FROM "${tableId}"`).all();
  const snapMap = new Map(snap.map((r) => [r._id, r]));
  let changed = 0;
  for (const row of cur) {
    const other = snapMap.get(row._id);
    if (other === undefined) continue; // 集合差(消える/増える)は別カウンタの仕事
    for (const field of CONTENT_FIELDS) {
      if (row[field] !== other[field]) {
        changed++;
        break;
      }
    }
  }
  return changed;
}

/** sql-attach: スナップショットDBを同一接続にATTACHし、1本のJOINクエリで数える。 */
function sqlAttachContentDiff(
  currentDb: Database,
  snapshotDbPath: string,
  tableId: string,
): number {
  currentDb.run(`ATTACH DATABASE ? AS snap`, [snapshotDbPath]);
  try {
    const whereClause = CONTENT_FIELDS.map((f) => `c."${f}" IS NOT s."${f}"`).join(" OR ");
    const result = currentDb
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM "${tableId}" c ` +
          `JOIN "snap"."${tableId}" s ON c."_id" = s."_id" ` +
          `WHERE ${whereClause}`,
      )
      .get();
    return result?.n ?? 0;
  } finally {
    currentDb.run(`DETACH DATABASE snap`);
  }
}

function repeatTiming(times: number, body: () => number): { timing: Timing; lastValue: number } {
  const samples: number[] = [];
  let lastValue = 0;
  for (let i = 0; i < times; i++) {
    const { value, ms } = timeOnce(body);
    samples.push(ms);
    lastValue = value;
  }
  return { timing: summarizeTimings(samples), lastValue };
}

type ScenarioResult = {
  rows: number;
  mutated_expected: number;
  baseline_ms: Timing;
  naive_js_ms: Timing;
  sql_attach_ms: Timing;
  naive_js_changed_count: number;
  sql_attach_changed_count: number;
  counts_agree: boolean;
};

function runScenario(n: number, seed: number): ScenarioResult {
  const current = buildScenario(n, seed);
  // snapshot = current のミューテーション**前**の内容として別データルートに再構築する
  // (同じ seed で buildApp すると decisionally 同一の初期DBが作れる。ミューテーションは
  // current 側にしか適用していないので、snapshot 側はそのまま「apply 直後」の状態)。
  const snapshotRoot = mkdtempSync(join(tmpdir(), "gp-bench-t06-snap-"));
  const snapshotApp = buildApp({
    dataRoot: snapshotRoot,
    appId: "app1",
    tables: 1,
    rowsPerTable: n,
    seed,
  });
  const tableId = snapshotApp.table_ids[0];
  if (tableId === undefined) {
    throw new Error("テーブルが作られませんでした");
  }

  try {
    const mutatedExpected = Math.min(Math.floor(n * MUTATION_FRACTION), n);

    const baseline = repeatTiming(REPS, () => {
      const curDb = new Database(current.dbPath, { readonly: true });
      const snapDb = new Database(snapshotApp.db_path, { readonly: true });
      try {
        return baselineIdDiff(curDb, snapDb, tableId);
      } finally {
        curDb.close();
        snapDb.close();
      }
    });

    const naive = repeatTiming(REPS, () => {
      const curDb = new Database(current.dbPath, { readonly: true });
      const snapDb = new Database(snapshotApp.db_path, { readonly: true });
      try {
        return naiveJsContentDiff(curDb, snapDb, tableId);
      } finally {
        curDb.close();
        snapDb.close();
      }
    });

    const sqlAttach = repeatTiming(REPS, () => {
      const curDb = new Database(current.dbPath, { readonly: true });
      try {
        return sqlAttachContentDiff(curDb, snapshotApp.db_path, tableId);
      } finally {
        curDb.close();
      }
    });

    return {
      rows: n,
      mutated_expected: mutatedExpected,
      baseline_ms: baseline.timing,
      naive_js_ms: naive.timing,
      sql_attach_ms: sqlAttach.timing,
      naive_js_changed_count: naive.lastValue,
      sql_attach_changed_count: sqlAttach.lastValue,
      counts_agree: naive.lastValue === sqlAttach.lastValue,
    };
  } finally {
    rmSync(current.dataRoot, { recursive: true, force: true });
    rmSync(snapshotRoot, { recursive: true, force: true });
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const outArg = args.find((a) => a.startsWith("--out="));
  const outPath = outArg?.slice("--out=".length);

  const rowCounts = [1_000, 10_000, 100_000];
  const results = rowCounts.map((n) => runScenario(n, DEFAULT_SEED));

  const output = {
    task: "V1-M9-T06",
    seed: DEFAULT_SEED,
    mutation_fraction: MUTATION_FRACTION,
    reps: REPS,
    environment: captureEnvironment(import.meta.dir),
    results,
  };

  console.log(JSON.stringify(output, null, 2));
  if (outPath !== undefined) {
    writeFileSync(outPath, JSON.stringify(output, null, 2));
    console.error(`書きました: ${outPath}`);
  }
}

main();
