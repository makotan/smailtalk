/**
 * 測定シナリオ本体(V1-M1-T05)。
 *
 * ## 測る5項目(タスク定義)
 *
 * 1. `snapshot` —— スナップショット取得の所要時間とディスク量(行数・テーブル数・アプリ数を振る)
 * 2. `undo` —— undo の所要時間
 * 3. `layer2` —— 層2(テーブル再構築)を伴う破壊的変更の所要時間
 * 4. `copies` —— ドライランを挟んだ場合の DB 全体コピー回数(`v1-m1-t02.md` 争点2 の検証)
 * 5. `journal` —— `journal_mode = DELETE` であることのコスト(WAL との比較)
 *
 * **5 は V1-M9-T03(WAL / スナップショットの計測)と V1-M3-T06 が入力として使う。**
 * `00-v1-plan.md` の依存骨格と `03-auth-multiuser-layers.md:49` が
 * 「ベンチマークスクリプトを三重に作らない」と定めているので、
 * **本ファイルの `journalModeScenario` を M9-T03 が拡張して使うことを前提に切り出してある。**
 *
 * ## 測っていないこと(憲法6。ADR-0011 にも同じ内容を書く)
 *
 * - **同時アクセス下の挙動を測っていない。** すべて単一プロセス・単一接続である。
 *   `journal_mode = DELETE` の本当のコスト(書き込み中に読み取りがブロックされること)は
 *   **複数接続でしか現れない。** ここで測れるのは書き込みそのものの速さだけである。
 *   **これは V1-M9-T03 の仕事として残る。**
 * - **1環境でしか測っていない。** 別環境で再現しない可能性がある(`environment` を同梱する理由)。
 * - **ページキャッシュを制御していない。** OS のファイルキャッシュが温まった状態の数値である。
 *   コールドスタートは遅い方向に外れる。
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Manifest, ReadSource, RecordRow } from "../../src/kernel/index.ts";
import {
  applyDiff,
  createRecord,
  dryRunDiff,
  readCurrentManifest,
  readRecordList,
  takeSnapshot,
  undo,
} from "../../src/kernel/index.ts";
import { appDbPath, appSnapshotsDir } from "../../src/kernel/storage-paths.ts";
// --- V8-M10-T07(集計表の性能)で追加。**可視性の post-filter は `src/kernel/report.ts` に
//     1バイトも無く `app.ts` が注入している**ので、本物の HTTP を立てて測る。
//     **`src/kernel/` からの値 import は1件も増えていない。** ---
import { createServerApp } from "../../src/server/app.ts";
import { seedSession, TEST_ORIGIN } from "../../src/server/test-helpers.ts";
import { buildApp, buildReportApp, layer1Diff, layer2Diff } from "./fixture.ts";
import { dirSize, fileSize, summarizeTimings, type Timing, timeOnce } from "./measure.ts";
import { type SqlEvent, withSqlProbe } from "./probe.ts";

/** 既定のシード。**変えると数値が変わる。** */
export const DEFAULT_SEED = 20260719;

/** 一時データルートを作って body に渡し、必ず消す。 */
function withDataRoot<T>(body: (dataRoot: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "gp-bench-"));
  try {
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function repeat(times: number, body: () => number): Timing {
  const samples: number[] = [];
  for (let i = 0; i < times; i++) {
    samples.push(body());
  }
  return summarizeTimings(samples);
}

// ---------------------------------------------------------------------------
// 1. スナップショット
// ---------------------------------------------------------------------------

export type SnapshotRow = {
  rows_per_table: number;
  tables: number;
  apps: number;
  /** アプリ1つ分の app.sqlite のバイト数(実測)。 */
  app_db_bytes: number;
  /** 全アプリのスナップショットを1周取るのにかかった時間。 */
  timing: Timing;
  /** スナップショット1周分のディスク増加量(バイト、実測)。 */
  snapshot_bytes_per_round: number;
};

export type SnapshotScenarioResult = {
  sweeps: SnapshotRow[];
  /** 同一アプリに N 回スナップショットを積んだときのディスク量(肥大の実測)。 */
  accumulation: {
    rows_per_table: number;
    app_db_bytes: number;
    rounds: number;
    total_snapshot_bytes: number;
    bytes_per_snapshot: number;
  };
};

export function snapshotScenario(
  reps: number,
  seed: number = DEFAULT_SEED,
): SnapshotScenarioResult {
  const sweeps: SnapshotRow[] = [];

  const cases: { rows: number; tables: number; apps: number }[] = [
    // 行数を振る(テーブル1・アプリ1)
    { rows: 1_000, tables: 1, apps: 1 },
    { rows: 10_000, tables: 1, apps: 1 },
    { rows: 100_000, tables: 1, apps: 1 },
    { rows: 1_000_000, tables: 1, apps: 1 },
    // テーブル数を振る(1テーブルあたり 10,000 行)
    { rows: 10_000, tables: 3, apps: 1 },
    { rows: 10_000, tables: 10, apps: 1 },
    // アプリ数を振る(計画書の例示: 10万行 × 10アプリ)
    { rows: 100_000, tables: 1, apps: 10 },
  ];

  for (const c of cases) {
    sweeps.push(
      withDataRoot((root) => {
        const apps = Array.from({ length: c.apps }, (_, i) =>
          buildApp({
            dataRoot: root,
            appId: `bench-${i + 1}`,
            tables: c.tables,
            rowsPerTable: c.rows,
            seed: seed + i,
          }),
        );
        let round = 0;
        const before = apps.reduce((sum, a) => sum + dirSize(appSnapshotsDir(root, a.app_id)), 0);
        const timing = repeat(reps, () => {
          round += 1;
          const { ms } = timeOnce(() => {
            for (const app of apps) {
              takeSnapshot(root, app.app_id, `d-round-${round}`);
            }
          });
          return ms;
        });
        const after = apps.reduce((sum, a) => sum + dirSize(appSnapshotsDir(root, a.app_id)), 0);
        return {
          rows_per_table: c.rows,
          tables: c.tables,
          apps: c.apps,
          app_db_bytes: apps[0]?.db_bytes ?? 0,
          timing,
          snapshot_bytes_per_round: Math.round((after - before) / reps),
        };
      }),
    );
  }

  const accumulation = withDataRoot((root) => {
    const rows = 100_000;
    const app = buildApp({
      dataRoot: root,
      appId: "accum",
      tables: 1,
      rowsPerTable: rows,
      seed,
    });
    const rounds = 10;
    for (let i = 0; i < rounds; i++) {
      takeSnapshot(root, "accum", `d-accum-${i}`);
    }
    const total = dirSize(appSnapshotsDir(root, "accum"));
    return {
      rows_per_table: rows,
      app_db_bytes: app.db_bytes,
      rounds,
      total_snapshot_bytes: total,
      bytes_per_snapshot: Math.round(total / rounds),
    };
  });

  return { sweeps, accumulation };
}

// ---------------------------------------------------------------------------
// 2. undo / 3. 層2 の破壊的変更
// ---------------------------------------------------------------------------

export type MutationRow = {
  rows: number;
  /** 層1(列型が変わらない)の apply。 */
  apply_layer1: Timing;
  /** 層2(NUMERIC → TEXT。テーブル再構築が起きる)の apply。 */
  apply_layer2: Timing;
  /** 層2 の**ドライラン**の時間(推奨フロー dry_run → apply の前半)。 */
  dry_run_layer2: Timing;
  /** 層2 の apply を undo する時間。 */
  undo_after_layer2: Timing;
  /** 参考: apply を挟まず素の takeSnapshot だけの時間(apply 内訳の比較対象)。 */
  snapshot_only: Timing;
  app_db_bytes: number;
};

export function mutationScenario(reps: number, seed: number = DEFAULT_SEED): MutationRow[] {
  const rowCounts = [1_000, 10_000, 100_000, 1_000_000];
  const results: MutationRow[] = [];

  for (const rows of rowCounts) {
    // apply / undo は状態を変えるので、**1回ごとにアプリを作り直す。**
    // 作り直しの時間は計測に含めない(`timeOnce` の外にある)。
    const measure = (body: (root: string, appId: string) => void): Timing =>
      repeat(reps, () =>
        withDataRoot((root) => {
          buildApp({
            dataRoot: root,
            appId: "m",
            tables: 1,
            rowsPerTable: rows,
            seed,
          });
          return timeOnce(() => body(root, "m")).ms;
        }),
      );

    const applyLayer1 = measure((root, appId) => {
      const r = applyDiff(root, appId, layer1Diff("d-l1", "t1"));
      if (!r.valid) {
        throw new Error(`層1 の apply に失敗: ${JSON.stringify(r.errors)}`);
      }
    });
    const applyLayer2 = measure((root, appId) => {
      const r = applyDiff(root, appId, layer2Diff("d-l2", "t1"));
      if (!r.valid) {
        throw new Error(`層2 の apply に失敗: ${JSON.stringify(r.errors)}`);
      }
    });
    const dryRunLayer2 = measure((root, appId) => {
      const r = dryRunDiff(root, appId, layer2Diff("d-l2", "t1"));
      if (!r.valid) {
        throw new Error(`層2 のドライランに失敗: ${JSON.stringify(r.errors)}`);
      }
    });
    const undoTiming = repeat(reps, () =>
      withDataRoot((root) => {
        buildApp({
          dataRoot: root,
          appId: "m",
          tables: 1,
          rowsPerTable: rows,
          seed,
        });
        const applied = applyDiff(root, "m", layer2Diff("d-l2", "t1"));
        if (!applied.valid) {
          throw new Error("undo 測定の前提となる apply に失敗しました");
        }
        return timeOnce(() => {
          const r = undo(root, "m");
          if (!r.valid) {
            throw new Error(`undo に失敗: ${JSON.stringify(r.errors)}`);
          }
        }).ms;
      }),
    );
    const snapshotOnly = withDataRoot((root) => {
      const app = buildApp({
        dataRoot: root,
        appId: "s",
        tables: 1,
        rowsPerTable: rows,
        seed,
      });
      let i = 0;
      const t = repeat(reps, () => {
        i += 1;
        return timeOnce(() => takeSnapshot(root, app.app_id, `d-s-${i}`)).ms;
      });
      return t;
    });

    results.push({
      rows,
      apply_layer1: applyLayer1,
      apply_layer2: applyLayer2,
      dry_run_layer2: dryRunLayer2,
      undo_after_layer2: undoTiming,
      snapshot_only: snapshotOnly,
      app_db_bytes: withDataRoot(
        (root) =>
          buildApp({
            dataRoot: root,
            appId: "z",
            tables: 1,
            rowsPerTable: rows,
            seed,
          }).db_bytes,
      ),
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// 4. コピー回数(v1-m1-t02.md 争点2 の検証)
// ---------------------------------------------------------------------------

export type CopyCountRow = {
  flow: "apply_only" | "dry_run_only" | "dry_run_then_apply";
  layer: 1 | 2;
  /** app.sqlite に対する `VACUUM INTO`(= DB 全体の整合コピー)の回数。 */
  app_db_full_copies: number;
  /** kernel.sqlite に対する `VACUUM INTO` の回数(**争点2 が数えていない分**)。 */
  kernel_db_full_copies: number;
  /** テーブル1つ分の全行コピー(層2 の再構築)の回数。 */
  table_full_copies: number;
  /** WHERE の無い全行 SELECT の回数(変換事前走査 + 再構築の読み出し + 行数観測)。 */
  full_scans: number;
  /** 「コピー」と呼べる操作の合計(全体コピー + テーブルコピー)。争点2 の「5回」と突き合わせる数。 */
  total_copy_operations: number;
  /** 実測の内訳。 */
  events: SqlEvent[];
};

export function copyCountScenario(rows: number, seed: number = DEFAULT_SEED): CopyCountRow[] {
  const flows: CopyCountRow["flow"][] = ["apply_only", "dry_run_only", "dry_run_then_apply"];
  const layers: (1 | 2)[] = [1, 2];
  const out: CopyCountRow[] = [];

  for (const layer of layers) {
    for (const flow of flows) {
      out.push(
        withDataRoot((root) => {
          buildApp({
            dataRoot: root,
            appId: "c",
            tables: 1,
            rowsPerTable: rows,
            seed,
          });
          const diff = layer === 2 ? layer2Diff("d-x", "t1") : layer1Diff("d-x", "t1");
          const { probe } = withSqlProbe(() => {
            if (flow !== "apply_only") {
              const d = dryRunDiff(root, "c", diff);
              if (!d.valid) {
                throw new Error(`ドライランに失敗: ${JSON.stringify(d.errors)}`);
              }
            }
            if (flow !== "dry_run_only") {
              const a = applyDiff(root, "c", diff);
              if (!a.valid) {
                throw new Error(`apply に失敗: ${JSON.stringify(a.errors)}`);
              }
            }
          });
          const appCopies = probe.events.filter(
            (e) => e.kind === "vacuum_into" && e.filename.endsWith("app.sqlite"),
          ).length;
          const kernelCopies = probe.events.filter(
            (e) => e.kind === "vacuum_into" && e.filename.endsWith("kernel.sqlite"),
          ).length;
          const tableCopies = probe.counts.rebuild_create;
          return {
            flow,
            layer,
            app_db_full_copies: appCopies,
            kernel_db_full_copies: kernelCopies,
            table_full_copies: tableCopies,
            full_scans: probe.counts.full_scan,
            total_copy_operations: appCopies + kernelCopies + tableCopies,
            events: probe.events.map((e) => ({
              ...e,
              // 一時ディレクトリ名は実行ごとに変わる。再現の妨げになるので伏せる。
              filename: e.filename
                .replace(root, "<data-root>")
                .replace(/^.*gp-dry-run-[^/]+/, "<dry-run-shadow>"),
            })),
          };
        }),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. journal_mode = DELETE のコスト(V1-M9-T03 / V1-M3-T06 への入力)
// ---------------------------------------------------------------------------

export type JournalModeRow = {
  journal_mode: "delete" | "wal";
  /** 1件ずつ(= 1トランザクションずつ)createRecord を撃った時間。 */
  insert_one_by_one: Timing;
  /** 全件を1トランザクションにまとめた場合の時間(比較対照)。 */
  insert_single_transaction: Timing;
  /** その DB に対する `takeSnapshot`(= VACUUM INTO)の時間。 */
  snapshot: Timing;
  records: number;
  /** 実際に効いていた journal_mode(**PRAGMA を読んで確認した実測値**)。 */
  effective_journal_mode: string;
};

/**
 * `journal_mode = DELETE` と `WAL` を同条件で比較する。
 *
 * **測っているのは単一接続の書き込みだけである。** ADR-0003:221 が記録している
 * 「HTTP 経由でレコード更新が同時に飛ぶとここが直列化点になる」は**複数接続の話**であり、
 * ここでは測れない。**V1-M9-T03 が測る。** 本シナリオはその下敷き(シングルユーザの分離)である。
 */
export function journalModeScenario(
  records: number,
  reps: number,
  seed: number = DEFAULT_SEED,
): JournalModeRow[] {
  const modes: ("delete" | "wal")[] = ["delete", "wal"];
  return modes.map((mode) => {
    const oneByOne = repeat(reps, () =>
      withDataRoot((root) => {
        buildApp({ dataRoot: root, appId: "j", tables: 1, rowsPerTable: 0, seed });
        const manifest = readCurrentManifest(root, "j");
        const db = new Database(appDbPath(root, "j"), { readwrite: true, create: false });
        try {
          db.exec(`PRAGMA journal_mode = ${mode.toUpperCase()};`);
          return timeOnce(() => {
            for (let i = 0; i < records; i++) {
              const r = createRecord(db, manifest, "t1", {
                title: `件名 ${i}`,
                qty: i,
                status: "進行中",
              });
              if (!r.ok) {
                throw new Error(`createRecord に失敗: ${JSON.stringify(r.errors)}`);
              }
            }
          }).ms;
        } finally {
          db.close();
        }
      }),
    );

    const batched = repeat(reps, () =>
      withDataRoot((root) => {
        buildApp({ dataRoot: root, appId: "j", tables: 1, rowsPerTable: 0, seed });
        const manifest = readCurrentManifest(root, "j");
        const db = new Database(appDbPath(root, "j"), { readwrite: true, create: false });
        try {
          db.exec(`PRAGMA journal_mode = ${mode.toUpperCase()};`);
          return timeOnce(() => {
            db.transaction(() => {
              for (let i = 0; i < records; i++) {
                const r = createRecord(db, manifest, "t1", {
                  title: `件名 ${i}`,
                  qty: i,
                  status: "進行中",
                });
                if (!r.ok) {
                  throw new Error(`createRecord に失敗: ${JSON.stringify(r.errors)}`);
                }
              }
            })();
          }).ms;
        } finally {
          db.close();
        }
      }),
    );

    let effective = "(未取得)";
    const snapshot = withDataRoot((root) => {
      buildApp({
        dataRoot: root,
        appId: "j",
        tables: 1,
        rowsPerTable: records,
        seed,
      });
      const db = new Database(appDbPath(root, "j"), { readwrite: true, create: false });
      try {
        db.exec(`PRAGMA journal_mode = ${mode.toUpperCase()};`);
        effective =
          (db.query("PRAGMA journal_mode").get() as { journal_mode: string } | null)
            ?.journal_mode ?? "(未取得)";
      } finally {
        db.close();
      }
      let i = 0;
      return repeat(reps, () => {
        i += 1;
        return timeOnce(() => takeSnapshot(root, "j", `d-j-${i}`)).ms;
      });
    });

    return {
      journal_mode: mode,
      insert_one_by_one: oneByOne,
      insert_single_transaction: batched,
      snapshot,
      records,
      effective_journal_mode: effective,
    };
  });
}

// ---------------------------------------------------------------------------
// 6. 書き込み中の読み取りブロック / 競合(V1-M9-T03 測定項目 b — 最大の新規)
//
//    M1-T05 は単一接続の書き込み速度だけを測った。ADR-0003:221 の中心的な主張
//    「書き込み中は読み取りがブロックされる」「HTTP 経由で更新が同時に飛ぶと
//    ここが直列化点になる」は**複数接続でしか現れない**。ここで実測する。
//
//    ## 実測で確かめる非対称(重要な既知事実)
//    - app.sqlite の書込接続は busy_timeout=0(src/server/app.ts の withAppDb)。
//      → 書込ロック中の読取は「待つ」のではなく即 SQLITE_BUSY。
//    - よって「読取がブロックされる」という ADR-0003:221 の前提は busy_timeout 依存。
//      busy_timeout=0(即失敗)と設定あり(実待ち)の両方を測って区別する。
// ---------------------------------------------------------------------------

type JournalMode = "delete" | "wal";
type WriterLock = "immediate" | "exclusive";
type ReaderOp = "read" | "write";

/** 書込ロックを保持している別接続がいる状態で1操作を試みた結果(1回分)。 */
type LockAttempt = {
  /** SQLITE_BUSY(= 直列化点が現れた)か。 */
  busy: boolean;
  /** 最終的に操作が成功したか。 */
  ok: boolean;
  /** 諦める / 成功するまでの実測ミリ秒。 */
  ms: number;
  /** SQLite のエラーコード(成功時は null)。 */
  error_code: string | null;
};

function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "SQLITE_BUSY" || code === "SQLITE_BUSY_SNAPSHOT") {
    return true;
  }
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && /database is locked/i.test(message);
}

/**
 * 書き手接続 `writer` が `lock` で書込ロックを保持している間に、`reader` 接続から
 * `op`(read / write)を1回試みる。**同一プロセス・同一スレッド**なので、書き手は
 * ロックを保持したまま解放できない —— busy_timeout を設定しても「その分だけ待って
 * 結局 SQLITE_BUSY」になる。真の待ち時間はクロスプロセス(項目7)で測る。
 */
function probeUnderWriteLock(
  writer: Database,
  reader: Database,
  lock: WriterLock,
  op: ReaderOp,
  readerBusyTimeoutMs: number,
  tableId: string,
): LockAttempt {
  reader.exec(`PRAGMA busy_timeout = ${readerBusyTimeoutMs};`);
  writer.exec(lock === "exclusive" ? "BEGIN EXCLUSIVE" : "BEGIN IMMEDIATE");
  if (lock === "immediate") {
    // RESERVED ロックだけでは弱いので、実際に1行書いて「書き込み中」を作る。
    writer.exec(
      `UPDATE "${tableId}" SET "title" = "title" WHERE "_id" IN (SELECT "_id" FROM "${tableId}" LIMIT 1)`,
    );
  }
  const start = Bun.nanoseconds();
  let result: LockAttempt;
  try {
    if (op === "read") {
      reader.query(`SELECT COUNT(*) AS c FROM "${tableId}"`).get();
    } else {
      reader.exec(
        `UPDATE "${tableId}" SET "title" = "title" WHERE "_id" IN (SELECT "_id" FROM "${tableId}" LIMIT 1)`,
      );
    }
    result = {
      busy: false,
      ok: true,
      ms: (Bun.nanoseconds() - start) / 1e6,
      error_code: null,
    };
  } catch (error) {
    result = {
      busy: isBusy(error),
      ok: false,
      ms: (Bun.nanoseconds() - start) / 1e6,
      error_code: (error as { code?: string } | null)?.code ?? "(不明)",
    };
  } finally {
    try {
      writer.exec("ROLLBACK");
    } catch {
      // すでにトランザクション外ならロールバックは失敗する。無視してよい。
    }
  }
  return result;
}

/** 1ケース(モード × ロック種 × 操作 × busy_timeout)の測定結果。 */
export type ContentionCase = {
  journal_mode: JournalMode;
  effective_journal_mode: string;
  /** 書き手が取ったロック種。immediate = 書き込み中(RESERVED)/ exclusive = 排他(コミット窓相当)。 */
  writer_lock: WriterLock;
  /** もう一方が試みた操作。 */
  reader_op: ReaderOp;
  /** 読み手 / もう一方の書き手接続の busy_timeout(0 = 即失敗を許す)。 */
  busy_timeout_ms: number;
  /** SQLITE_BUSY(= 直列化点が観測された)か。reps 全件で一致していることを確認する。 */
  busy: boolean;
  /** 最終的に操作が成功したか。 */
  ok: boolean;
  /** SQLite エラーコード(成功時 null)。 */
  error_code: string | null;
  /** 諦める / 成功するまでの実測時間。 */
  timing: Timing;
  /** reps 全件で busy 判定が一致したか(不一致なら測定が不安定)。 */
  busy_stable: boolean;
};

/**
 * 1ケースを、その都度アプリを作り直して reps 回測る。
 *
 * **測定対象そのものは接続 2 本の取り合いなので、アプリは 1 回だけ作り、
 * 接続だけ開き直す。** busy 判定は本来決定的だが、reps で安定性も確認する。
 */
function runContentionCase(
  mode: JournalMode,
  lock: WriterLock,
  op: ReaderOp,
  busyTimeoutMs: number,
  reps: number,
  seed: number,
): ContentionCase {
  return withDataRoot((root) => {
    buildApp({ dataRoot: root, appId: "k", tables: 1, rowsPerTable: 50, seed });
    const path = appDbPath(root, "k");
    const writer = new Database(path, { readwrite: true, create: false });
    const reader = new Database(path, { readwrite: true, create: false });
    // journal_mode はファイル単位で永続する。どちらかで設定すれば効く。
    writer.exec(`PRAGMA journal_mode = ${mode.toUpperCase()};`);
    const effective =
      (writer.query("PRAGMA journal_mode").get() as { journal_mode: string } | null)
        ?.journal_mode ?? "(未取得)";
    try {
      const samples: number[] = [];
      const busyFlags: boolean[] = [];
      let last: LockAttempt | null = null;
      for (let i = 0; i < reps; i++) {
        const attempt = probeUnderWriteLock(writer, reader, lock, op, busyTimeoutMs, "t1");
        samples.push(attempt.ms);
        busyFlags.push(attempt.busy);
        last = attempt;
      }
      const busyStable = busyFlags.every((b) => b === busyFlags[0]);
      return {
        journal_mode: mode,
        effective_journal_mode: effective,
        writer_lock: lock,
        reader_op: op,
        busy_timeout_ms: busyTimeoutMs,
        busy: last?.busy ?? false,
        ok: last?.ok ?? false,
        error_code: last?.error_code ?? null,
        timing: summarizeTimings(samples),
        busy_stable: busyStable,
      };
    } finally {
      writer.close();
      reader.close();
    }
  });
}

/**
 * 書き込み中の読み取りブロック / 競合の実測(同一プロセス・複数接続)。
 *
 * 行列(モード delete/wal × 以下):
 * - 書き手 immediate(書き込み中・RESERVED)で読み取り、busy_timeout=0 / 200
 * - 書き手 exclusive(排他・コミット窓相当)で読み取り、busy_timeout=0 / 200
 * - 書き手 immediate で**もう一方も書き込み**(書き手同士は必ず直列化する)busy_timeout=0
 */
export function contentionScenario(reps: number, seed: number = DEFAULT_SEED): ContentionCase[] {
  const modes: JournalMode[] = ["delete", "wal"];
  const out: ContentionCase[] = [];
  for (const mode of modes) {
    out.push(runContentionCase(mode, "immediate", "read", 0, reps, seed));
    out.push(runContentionCase(mode, "immediate", "read", 200, reps, seed));
    out.push(runContentionCase(mode, "exclusive", "read", 0, reps, seed));
    out.push(runContentionCase(mode, "exclusive", "read", 200, reps, seed));
    // 書き手同士(片方が書き込み中に他方も書く)。読み取りとの非対称を示す対照。
    out.push(runContentionCase(mode, "immediate", "write", 0, reps, seed));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 7. クロスプロセス競合 —— **本物の待ち時間**(V1-M9-T03 測定項目 b の中核)
//
//    同一プロセスでは書き手がロックを解放できないので「待って結局失敗」しか測れない。
//    別プロセスの書き手がロックを保持 → 解放する間に読み取りを撃つと、
//    「書き手が終わるまで待って、その後読めた」という本物の直列化が測れる。
// ---------------------------------------------------------------------------

export type CrossProcessCase = {
  journal_mode: JournalMode;
  effective_journal_mode: string;
  /** 別プロセスの書き手が排他ロックを保持し続ける時間。 */
  writer_hold_ms: number;
  /** 親(読み手)の busy_timeout。保持時間より十分大きく取る。 */
  reader_busy_timeout_ms: number;
  /** 読み取りが最終的に成功したか。 */
  read_succeeded: boolean;
  /** 一度でも SQLITE_BUSY を観測したか(= busy_timeout を使い切って諦めたか)。 */
  busy: boolean;
  /** 読み取りが返るまでの実測時間(= 直列化による本物の待ち)。 */
  timing: Timing;
};

/** 別プロセスの書き手が排他ロックを保持している間に読み取りを1回撃つ(1 rep 分)。 */
function crossProcessAttempt(
  mode: JournalMode,
  writerHoldMs: number,
  readerBusyTimeoutMs: number,
  seed: number,
): { ms: number; ok: boolean; busy: boolean } {
  return withDataRoot((root) => {
    buildApp({ dataRoot: root, appId: "x", tables: 1, rowsPerTable: 50, seed });
    const path = appDbPath(root, "x");
    // journal_mode をファイルに焼く。
    const setup = new Database(path, { readwrite: true, create: false });
    setup.exec(`PRAGMA journal_mode = ${mode.toUpperCase()};`);
    setup.close();

    const sentinel = join(root, "writer-ready");
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        join(import.meta.dir, "contention-writer.ts"),
        path,
        mode,
        String(writerHoldMs),
        sentinel,
        "t1",
      ],
      { stdout: "ignore", stderr: "pipe" },
    );

    // 書き手がロックを取るまで待つ(sentinel が出るまで)。5秒で見切る。
    const deadline = Bun.nanoseconds() + 5_000 * 1e6;
    while (!existsSync(sentinel)) {
      if (Bun.nanoseconds() > deadline) {
        proc.kill();
        throw new Error("書き手プロセスが 5 秒以内にロックを取得しませんでした。");
      }
      Bun.sleepSync(1);
    }

    const reader = new Database(path, { readwrite: true, create: false });
    reader.exec(`PRAGMA busy_timeout = ${readerBusyTimeoutMs};`);
    const start = Bun.nanoseconds();
    let ok = false;
    let busy = false;
    try {
      reader.query('SELECT COUNT(*) AS c FROM "t1"').get();
      ok = true;
    } catch (error) {
      busy = isBusy(error);
    }
    const ms = (Bun.nanoseconds() - start) / 1e6;
    reader.close();
    proc.kill();
    return { ms, ok, busy };
  });
}

/**
 * クロスプロセスの書き込みロック競合を実測する(delete / wal)。
 *
 * DELETE では読み手は書き手がコミットするまで待って、その後成功するはずである
 * (= 本物の直列化)。WAL では読み手は待たずに直近コミット状態を読めるはずである。
 * **どちらになるかは実測が言う。**
 */
export function crossProcessContentionScenario(
  reps: number,
  seed: number = DEFAULT_SEED,
): CrossProcessCase[] {
  const modes: JournalMode[] = ["delete", "wal"];
  const writerHoldMs = 300;
  const readerBusyTimeoutMs = 5_000;
  return modes.map((mode) => {
    const samples: number[] = [];
    let anyBusy = false;
    let allOk = true;
    let effective = "(未取得)";
    for (let i = 0; i < reps; i++) {
      const a = crossProcessAttempt(mode, writerHoldMs, readerBusyTimeoutMs, seed);
      samples.push(a.ms);
      anyBusy = anyBusy || a.busy;
      allOk = allOk && a.ok;
    }
    // effective は別途素早く1回確認する(ファイル単位なので確定値)。
    effective = withDataRoot((root) => {
      buildApp({ dataRoot: root, appId: "e", tables: 1, rowsPerTable: 1, seed });
      const db = new Database(appDbPath(root, "e"), { readwrite: true, create: false });
      db.exec(`PRAGMA journal_mode = ${mode.toUpperCase()};`);
      const v =
        (db.query("PRAGMA journal_mode").get() as { journal_mode: string } | null)?.journal_mode ??
        "(未取得)";
      db.close();
      return v;
    });
    return {
      journal_mode: mode,
      effective_journal_mode: effective,
      writer_hold_ms: writerHoldMs,
      reader_busy_timeout_ms: readerBusyTimeoutMs,
      read_succeeded: allOk,
      busy: anyBusy,
      timing: summarizeTimings(samples),
    };
  });
}

// ---------------------------------------------------------------------------
// 8. スナップショット全量コピーを 1MB / 10MB / 100MB × DELETE / WAL
//    (V1-M9-T03 測定項目 c と d)
//
//    M1-T05 の WAL スナップショットは 2,000 行の小さい DB 1 ケースだけだった。
//    ここを 1/10/100 MB に振り、DELETE と A/B で比較する。
//    行数→MB は M1-T05 実測(1MB≒5k行 / 10MB≒50k行 / 100MB≒500k行)を使う。
// ---------------------------------------------------------------------------

export type SnapshotSizeRow = {
  target_mb: number;
  rows: number;
  journal_mode: JournalMode;
  effective_journal_mode: string;
  /** 実測の app.sqlite バイト数。 */
  app_db_bytes: number;
  /** スナップショット直前の -wal ファイルのバイト数(DELETE では 0)。 */
  wal_bytes_before_snapshot: number;
  /** takeSnapshot(= checkpoint + VACUUM INTO)の時間。 */
  timing: Timing;
  /** スナップショット1個のバイト数(実測)。 */
  snapshot_bytes: number;
  /** app_db_bytes / median_ms から出したスループット(MB/s)。 */
  throughput_mb_s: number;
};

/**
 * 1MB / 10MB / 100MB × DELETE / WAL でスナップショット取得を測る。
 *
 * ## WAL 側で**未チェックポイントの WAL を実際に溜めておく**理由
 *
 * takeSnapshot(`snapshot.ts`)は WAL のとき `wal_checkpoint(TRUNCATE)` を撃ってから
 * `VACUUM INTO` する。**WAL が空だと checkpoint に仕事が無く、DELETE と差が出ない**
 * (それでは「WAL にした場合のスナップショット費用」を測ったことにならない)。
 * 現実には app.sqlite にはサーバの接続が張られ続け、書き込みが -wal に溜まった状態で
 * スナップショットが走る。それを再現するため:
 *
 * - `PRAGMA wal_autocheckpoint = 0`(自動チェックポイントを止める)
 * - 書き込み接続を**開いたまま保持**する(最後の接続が閉じる際の暗黙チェックポイントを避ける)
 * - **各 rep の直前に全体の 1% を更新して -wal を溜め直す**(takeSnapshot が TRUNCATE で
 *   畳むので、溜め直さないと 2 回目以降が空 WAL になる)
 *
 * これで各 rep が「未チェックポイントの WAL がある状態での checkpoint + VACUUM INTO」を測る。
 */
export function snapshotSizeScenario(
  reps: number,
  seed: number = DEFAULT_SEED,
  cases: { target_mb: number; rows: number }[] = [
    { target_mb: 1, rows: 5_000 },
    { target_mb: 10, rows: 50_000 },
    { target_mb: 100, rows: 500_000 },
  ],
): SnapshotSizeRow[] {
  const modes: JournalMode[] = ["delete", "wal"];
  const out: SnapshotSizeRow[] = [];
  for (const c of cases) {
    for (const mode of modes) {
      out.push(
        withDataRoot((root) => {
          const app = buildApp({
            dataRoot: root,
            appId: "sz",
            tables: 1,
            rowsPerTable: c.rows,
            seed,
          });
          const path = appDbPath(root, "sz");
          const updates = Math.max(1, Math.floor(c.rows / 100));

          if (mode === "delete") {
            let i = 0;
            const timing = repeat(reps, () => {
              i += 1;
              return timeOnce(() => takeSnapshot(root, "sz", `d-sz-${i}`)).ms;
            });
            return finishSnapshotSizeRow(root, app, c, "delete", "delete", 0, timing, reps);
          }

          // --- WAL: 未チェックポイントの WAL を保った状態で測る ---
          const writer = new Database(path, { readwrite: true, create: false });
          try {
            writer.exec("PRAGMA journal_mode = WAL;");
            writer.exec("PRAGMA wal_autocheckpoint = 0;");
            const effective =
              (writer.query("PRAGMA journal_mode").get() as { journal_mode: string } | null)
                ?.journal_mode ?? "(未取得)";
            const stmt = writer.query('UPDATE "t1" SET "title" = "title" || ? WHERE "_id" = ?');
            const repopulate = (): void => {
              writer.transaction(() => {
                for (let i = 0; i < updates; i++) {
                  stmt.run("*", `t1-${String(i).padStart(9, "0")}`);
                }
              })();
            };

            let walBytes = 0;
            let i = 0;
            const timing = repeat(reps, () => {
              i += 1;
              repopulate(); // 各 rep の直前に -wal を溜め直す(前 rep で TRUNCATE 済み)
              if (i === 1) {
                walBytes = fileSize(`${path}-wal`);
              }
              return timeOnce(() => takeSnapshot(root, "sz", `d-sz-${i}`)).ms;
            });
            return finishSnapshotSizeRow(root, app, c, "wal", effective, walBytes, timing, reps);
          } finally {
            writer.close();
          }
        }),
      );
    }
  }
  return out;
}

function finishSnapshotSizeRow(
  root: string,
  app: { db_bytes: number },
  c: { target_mb: number; rows: number },
  mode: JournalMode,
  effective: string,
  walBytes: number,
  timing: Timing,
  reps: number,
): SnapshotSizeRow {
  const snaps = appSnapshotsDir(root, "sz");
  const oneSnapBytes = Math.round(dirSize(snaps) / reps);
  const throughput = timing.median_ms > 0 ? app.db_bytes / 1e6 / (timing.median_ms / 1000) : 0;
  return {
    target_mb: c.target_mb,
    rows: c.rows,
    journal_mode: mode,
    effective_journal_mode: effective,
    app_db_bytes: app.db_bytes,
    wal_bytes_before_snapshot: walBytes,
    timing,
    snapshot_bytes: oneSnapBytes,
    throughput_mb_s: Math.round(throughput * 10) / 10,
  };
}

// ---------------------------------------------------------------------------
// 9. 負荷試験 load —— クロスプロセスの複数書き手による直列化 / デッドロック(V1-M3-T06)
//
//    contention / xproc は「書き手が 1 本いる状態で 1 操作を撃つ」までだった。
//    ここでは **N 本の書き手プロセスを同時に走らせ**、現行サーバの書込パス
//    (deferred tx + read-then-CAS-update)の形状をミラーして、
//    - A: bt=0 の脆さ(即 SQLITE_BUSY)
//    - B: deferred の read-then-upgrade が別行同士でもデッドロックすること(R1)
//    - B': BEGIN IMMEDIATE がそれを解消すること
//    - C: 共有ホット行での版衝突(CP-V1-3。M9-T02 の領分)
//    - D: 1app1file(different_apps)の線形スケール
//    - E: WAL を重ねても plateau が残ること(M7)
//    を実測する。**時間は再現しない**が、質的判定(busy の有無・会計一致)は決定的。
//
//    ## 実サーバとの差(観測 BUSY はロックの下限)
//    実サーバは同一トランザクションで `_auth_activity` にも INSERT する(ロック窓が広い)。
//    本 writer はそれを省くので、ここで観測される BUSY は実運用の**下限**である。
// ---------------------------------------------------------------------------

/** shared の row_space で全 writer が集中するホット行数(load-writer.ts の HOT と一致)。 */
const LOAD_HOT = 4;

/** 1ケース(N 本の書き手プロセス)の集計結果。 */
export type LoadCase = {
  /** 人間可読ラベル(例 "update/deferred/own/same_app/delete/bt5000")。 */
  label: string;
  scope: "same_app" | "different_apps";
  op: "insert" | "update";
  begin: "deferred" | "immediate";
  row_space: "own" | "shared";
  journal_mode: JournalMode;
  busy_timeout_ms: number;
  writers: number;
  ops_per_writer: number;
  commit_total: number;
  /** SQLITE_BUSY(= HTTP500 相当)。 */
  busy_total: number;
  /** update の版衝突(M9-T02 の領分。エラーではない)。 */
  cas_conflict_total: number;
  other_total: number;
  /** writers * ops_per_writer。 */
  attempted_total: number;
  /** commit + busy + cas_conflict + other === attempted か。 */
  accounting_ok: boolean;
  /** 全 writer の elapsed_ms の max(= 実時間)。 */
  elapsed_ms_max: number;
  /** commit_total / (elapsed_ms_max/1000)。**再現しない**。 */
  throughput_commits_s: number;
};

export type LoadCaseOptions = {
  /** 省略時は他フィールドから導出する。 */
  label?: string;
  scope: "same_app" | "different_apps";
  op: "insert" | "update";
  begin: "deferred" | "immediate";
  row_space: "own" | "shared";
  journal_mode: JournalMode;
  busy_timeout_ms: number;
  writers: number;
  ops_per_writer: number;
  /** shared のホット行数。既定 LOAD_HOT。 */
  hot?: number;
  seed?: number;
};

function deriveLoadLabel(o: LoadCaseOptions): string {
  return `${o.op}/${o.begin}/${o.row_space}/${o.scope}/${o.journal_mode}/bt${o.busy_timeout_ms}`;
}

/** journal_mode をファイルに焼く(ファイル単位で永続する)。 */
function bakeJournalMode(path: string, mode: JournalMode): void {
  const db = new Database(path, { readwrite: true, create: false });
  try {
    db.exec(`PRAGMA journal_mode = ${mode.toUpperCase()};`);
  } finally {
    db.close();
  }
}

/** async 版 `withDataRoot`。**書き手プロセスの終了を待ってから**後始末する。 */
async function withDataRootAsync<T>(body: (dataRoot: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "gp-bench-"));
  try {
    return await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

type WriterResult = {
  commits: number;
  busy: number;
  other: number;
  cas_conflict: number;
  elapsed_ms: number;
};

/**
 * 1ケースを実行する。N 本の load-writer をスタートバリアで同時発火させ、
 * **全プロセスの exit(=0)を確認してから**結果ファイルを読む(部分読みを避ける / M3)。
 */
export async function runLoadCase(opts: LoadCaseOptions): Promise<LoadCase> {
  const { scope, op, begin, row_space, journal_mode, busy_timeout_ms, writers, ops_per_writer } =
    opts;
  const hot = opts.hot ?? LOAD_HOT;
  const seed = opts.seed ?? DEFAULT_SEED;
  const label = opts.label ?? deriveLoadLabel(opts);

  // own の update は writer×ops 個の既存行を要する(base = writerIndex*ops + i)。
  // shared でも先頭 hot 行が要る。insert は seed 不要。
  const rowsPerTable = op === "update" ? Math.max(writers * ops_per_writer + hot, 64) : 0;

  return withDataRootAsync(async (root) => {
    // --- app.sqlite を用意し、journal_mode を焼く ---
    const dbPaths: string[] = [];
    if (scope === "same_app") {
      buildApp({ dataRoot: root, appId: "load-app", tables: 1, rowsPerTable, seed });
      const path = appDbPath(root, "load-app");
      bakeJournalMode(path, journal_mode);
      for (let i = 0; i < writers; i++) {
        dbPaths.push(path);
      }
    } else {
      for (let i = 0; i < writers; i++) {
        const appId = `load-app-${i}`;
        buildApp({ dataRoot: root, appId, tables: 1, rowsPerTable, seed });
        const path = appDbPath(root, appId);
        bakeJournalMode(path, journal_mode);
        dbPaths.push(path);
      }
    }

    // --- N 本の書き手を起動(まだ go は書かない) ---
    const goPath = join(root, "go");
    const readyPaths: string[] = [];
    const resultPaths: string[] = [];
    const writerScript = join(import.meta.dir, "load-writer.ts");
    const procs = Array.from({ length: writers }, (_, i) => {
      const readyPath = join(root, `ready-${i}`);
      const resultPath = join(root, `result-${i}`);
      readyPaths.push(readyPath);
      resultPaths.push(resultPath);
      return Bun.spawn(
        [
          "bun",
          "run",
          writerScript,
          dbPaths[i] as string,
          "t1",
          op,
          begin,
          String(busy_timeout_ms),
          String(ops_per_writer),
          String(i),
          row_space,
          readyPath,
          goPath,
          resultPath,
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
    });

    // --- 全 ready を待つ → go を書く(同時発火) ---
    const deadline = Bun.nanoseconds() + 30_000 * 1e6;
    while (!readyPaths.every((p) => existsSync(p))) {
      if (Bun.nanoseconds() > deadline) {
        for (const p of procs) {
          p.kill();
        }
        throw new Error("書き手プロセスが 30 秒以内に ready になりませんでした。");
      }
      Bun.sleepSync(1);
    }
    writeFileSync(goPath, "1", "utf-8");

    // --- 全プロセスの終了を待つ(M3: 結果を読む前に必ず exited を await) ---
    await Promise.all(procs.map((p) => p.exited));
    for (let i = 0; i < procs.length; i++) {
      const p = procs[i];
      if (p === undefined || p.exitCode !== 0) {
        const stderr =
          p?.stderr instanceof ReadableStream ? await new Response(p.stderr).text() : "";
        throw new Error(
          `load-writer[${i}] が異常終了しました (exit=${p?.exitCode}): ${stderr.trim()}`,
        );
      }
    }

    // --- exited 済みなので部分読みは起きない。集計する。 ---
    let commit_total = 0;
    let busy_total = 0;
    let cas_conflict_total = 0;
    let other_total = 0;
    let elapsed_ms_max = 0;
    for (const rp of resultPaths) {
      const r = JSON.parse(readFileSync(rp, "utf-8")) as WriterResult;
      commit_total += r.commits;
      busy_total += r.busy;
      cas_conflict_total += r.cas_conflict;
      other_total += r.other;
      elapsed_ms_max = Math.max(elapsed_ms_max, r.elapsed_ms);
    }
    const attempted_total = writers * ops_per_writer;
    const accounting_ok =
      commit_total + busy_total + cas_conflict_total + other_total === attempted_total;
    const throughput_commits_s = elapsed_ms_max > 0 ? commit_total / (elapsed_ms_max / 1000) : 0;

    return {
      label,
      scope,
      op,
      begin,
      row_space,
      journal_mode,
      busy_timeout_ms,
      writers,
      ops_per_writer,
      commit_total,
      busy_total,
      cas_conflict_total,
      other_total,
      attempted_total,
      accounting_ok,
      elapsed_ms_max,
      throughput_commits_s,
    };
  });
}

/**
 * 負荷試験のフル計測(run.ts から実行する)。**重いので N sweep を回す。**
 * テストは `runLoadCase` を小さい N/ops で直接呼ぶ(こちらは呼ばない)。
 *
 * `reps` は既存シグネチャに合わせて受けるが、負荷試験では使わない
 * (質的不変量は決定的なので繰り返さない。時間は全 writer の実測を残す)。
 */
export async function loadWriterScenario(
  _reps: number,
  seed: number = DEFAULT_SEED,
): Promise<LoadCase[]> {
  const OPS = 200;
  const nSweep = [1, 2, 4, 8, 16];
  const out: LoadCase[] = [];

  // A: insert / deferred / own / same_app / bt=0(現行 config の脆さ)
  for (const n of nSweep) {
    out.push(
      await runLoadCase({
        scope: "same_app",
        op: "insert",
        begin: "deferred",
        row_space: "own",
        journal_mode: "delete",
        busy_timeout_ms: 0,
        writers: n,
        ops_per_writer: OPS,
        seed,
      }),
    );
  }

  // B: update / deferred / own / same_app / bt=5000(R1: lock-upgrade デッドロック)
  for (const n of nSweep) {
    out.push(
      await runLoadCase({
        scope: "same_app",
        op: "update",
        begin: "deferred",
        row_space: "own",
        journal_mode: "delete",
        busy_timeout_ms: 5000,
        writers: n,
        ops_per_writer: OPS,
        seed,
      }),
    );
  }

  // B': update / immediate / own / same_app / bt=5000(IMMEDIATE が解消)
  for (const n of nSweep) {
    out.push(
      await runLoadCase({
        scope: "same_app",
        op: "update",
        begin: "immediate",
        row_space: "own",
        journal_mode: "delete",
        busy_timeout_ms: 5000,
        writers: n,
        ops_per_writer: OPS,
        seed,
      }),
    );
  }

  // C: update / deferred / shared / same_app / bt=5000(R2: CP-V1-3 共有編集の版衝突)
  for (const n of [2, 4, 8]) {
    out.push(
      await runLoadCase({
        scope: "same_app",
        op: "update",
        begin: "deferred",
        row_space: "shared",
        journal_mode: "delete",
        busy_timeout_ms: 5000,
        writers: n,
        ops_per_writer: OPS,
        seed,
      }),
    );
  }

  // D: update / immediate / own / different_apps / bt=5000(1app1file の線形スケール)
  for (const n of nSweep) {
    out.push(
      await runLoadCase({
        scope: "different_apps",
        op: "update",
        begin: "immediate",
        row_space: "own",
        journal_mode: "delete",
        busy_timeout_ms: 5000,
        writers: n,
        ops_per_writer: OPS,
        seed,
      }),
    );
  }

  // E: B' と同条件で journal_mode=wal(M7: plateau が WAL でも残ることを確認)
  for (const n of [1, 8]) {
    out.push(
      await runLoadCase({
        scope: "same_app",
        op: "update",
        begin: "immediate",
        row_space: "own",
        journal_mode: "wal",
        busy_timeout_ms: 5000,
        writers: n,
        ops_per_writer: OPS,
        seed,
      }),
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// read —— listRecords / システムテーブル投影の全件返却コスト(V1-M9-T01 判断ゲート)
// ---------------------------------------------------------------------------

/**
 * V1-M9-T01 判断ゲート (b)(c) 用に、read パスの全件返却コストを実測する。
 *
 * `listRecords` は LIMIT/OFFSET を持たず常に全件を返す(records.ts:591-652)。
 * HTTP GET は `readRecordList`(read-records.ts:284)を通り、結果を丸ごと
 * `JSON.stringify` する(app.ts の c.json)。ここではその2点を計時する:
 *   1. list_ms —— `readRecordList` の実行時間(kernel の read パスそのもの)
 *   2. serialize_ms + payload_bytes —— 結果配列の JSON シリアライズ時間とバイト数
 *
 * ## 測っていないこと(憲法6)
 *
 * - **DOM 描画**はここでは測らない。web/ 側(`web/test/list-render-bench.test.tsx`)が
 *   happy-dom 上で計測する。ゲート (b) の3点目はそちらが担当する。
 * - **HTTP の owner-scope post-filter を含まない。** 実 HTTP は個人スコープ表で
 *   結果配列に対する O(N) の post-filter(app.ts:705-709)を追加で通るので、
 *   ここで得る list_ms は **HTTP 実測の下限**(これより速くはならない側)である。
 *
 * ## システムテーブル経路((c))
 *
 * `_apps` / `_changelog` は `kernel.sqlite` に対する副問合せとして読む(`read-records.ts`)。
 * 全アプリ横断なので、アプリ数を増やすと実アプリより先にここが詰まりうる。
 * アプリ数を振って桁を出す。
 *
 * **【SQ-M4 で前提が変わった。旧文を消さずに直す】** かつてここには
 * 「絞り込みの前に全件をメモリに読む」「`listAllChangelog` が **operations の JSON 込み**で
 * 全件展開する」と書いていた。**読取を SQL へ一本化したので、どちらも今日は起きない**
 * (`operations` / `snapshot` は投影の SELECT に1度も現れない)。
 * **したがって、それ以前に採った数字は今日の実装の数字ではない。**
 *
 * ## 測定規律(M1-T05 / M9-T03 踏襲)
 *
 * 時間は桁と比のみ。`payload_bytes` と `record_count` は同一シードで決定的。
 */
export type ReadCase = {
  label: string;
  path: "user" | "_apps" | "_changelog";
  /** user は行数、システムテーブルはアプリ数。 */
  scale: number;
  record_count: number;
  list_ms: Timing;
  serialize_ms: Timing;
  payload_bytes: number;
};

export type ReadCaseOptions = {
  path: "user" | "_apps" | "_changelog";
  scale: number;
  reps: number;
  seed: number;
};

/** appDb が呼ばれてはならないシステムテーブル経路で使う番兵。 */
function forbiddenAppDb(): never {
  throw new Error("appDb はシステムテーブルの read で呼ばれてはならない");
}

/** 1 ケースを実測する。テストから小さい scale/reps で直呼びできるよう export する。 */
export function runReadCase(opts: ReadCaseOptions): ReadCase {
  const { path, scale, reps, seed } = opts;
  return withDataRoot((root) => {
    let source: ReadSource;
    let manifest: Manifest;
    let tableId: string;
    let db: Database | undefined;

    if (path === "user") {
      buildApp({ dataRoot: root, appId: "read", tables: 1, rowsPerTable: scale, seed });
      manifest = readCurrentManifest(root, "read");
      tableId = "t1";
      source = {
        dataRoot: root,
        appDb: () =>
          (db ??= new Database(appDbPath(root, "read"), { readwrite: true, create: false })),
      };
    } else {
      // scale 個のアプリを作る。各 buildApp は createApp + applyDiff で changelog を
      // 2 行足すので、_changelog の規模はアプリ数に比例して増える。
      for (let i = 0; i < scale; i++) {
        buildApp({ dataRoot: root, appId: `a${i}`, tables: 1, rowsPerTable: 1, seed });
      }
      manifest = readCurrentManifest(root, "a0");
      tableId = path; // "_apps" | "_changelog"
      source = { dataRoot: root, appDb: forbiddenAppDb };
    }

    let last: RecordRow[] = [];
    const list_ms = repeat(reps, () => {
      const timed = timeOnce(() => {
        const r = readRecordList(source, manifest, tableId, {});
        if (!r.ok) {
          throw new Error(`readRecordList failed: ${JSON.stringify(r.errors)}`);
        }
        return r.value;
      });
      last = timed.value;
      return timed.ms;
    });
    const record_count = last.length;
    const serialize_ms = repeat(reps, () => timeOnce(() => JSON.stringify({ records: last })).ms);
    const payload_bytes = Buffer.byteLength(JSON.stringify({ records: last }), "utf8");

    db?.close();

    return {
      label: `${path}/scale=${scale}`,
      path,
      scale,
      record_count,
      list_ms,
      serialize_ms,
      payload_bytes,
    };
  });
}

/**
 * フル sweep。run.ts から呼ぶ。sample 数は測定規律のため最低 5 を確保する。
 */
export function readScenario(reps: number, seed: number = DEFAULT_SEED): ReadCase[] {
  const REPS = Math.max(reps, 5);
  const out: ReadCase[] = [];
  // (b) ユーザテーブル: 1千 / 1万 / 10万件
  for (const rows of [1_000, 10_000, 100_000]) {
    out.push(runReadCase({ path: "user", scale: rows, reps: REPS, seed }));
  }
  // (c) システムテーブル: アプリ数 1 / 10 / 100
  for (const apps of [1, 10, 100]) {
    out.push(runReadCase({ path: "_apps", scale: apps, reps: REPS, seed }));
    out.push(runReadCase({ path: "_changelog", scale: apps, reps: REPS, seed }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// report —— 集計表の性能(V8-M10-T07。台帳 `Q-G34`)
// ---------------------------------------------------------------------------

/**
 * **集計表(`report_view`)の性能を実測する**(`V8-M10-T07`。台帳 `Q-G34`。
 * `v8-m10.md` §1 の `T07` / §1-0c の決定3・決定9)。
 *
 * ## なぜ**本物の HTTP** を通すのか
 *
 * **可視性の post-filter は `src/kernel/report.ts` に1バイトも無い** ——
 * **`app.ts` の集計表ルートが「可視な行だけを返す読取元」を組んで注入している**
 * (`v8-m10.md` §1-0c の決定1)。**カーネルの `computeReport` を直に呼ぶと、
 * `T03`/`T04` が足した post-filter を1ミリも通らない。**
 * したがって本シナリオだけは `read` シナリオと違い、**`createServerApp` を立てて
 * `GET /api/apps/:app_id/views/:view_id/report` を実際に叩く。**
 *
 * ## 測る3つ
 *
 * 1. **`http_ms`** —— 要求を出してから応答本文を読み終えるまで。**行の読取・可視性の
 *    post-filter・結合・群化・JSON シリアライズが全部入っている。**
 * 2. **`payload_bytes`** —— 応答本文のバイト数(`ADR-0019:86` の「payload < 300KB」と
 *    突き合わせる数値)。
 * 3. **`total_count`** —— 応答の `totals` にある件数。**母集団の**中身**が分岐によって
 *    変わっていないことを、測定値そのもので示すために採る**(これが一致していない
 *    2つのケースを「post-filter の差」として比べてはならない)。
 *
 * ## 【この シナリオが測っていないこと】(憲法6)
 *
 * - **DOM 描画を1ミリも測っていない。** `ADR-0019:86`-`:88` の帯の律速は
 *   **フロント描画**であり、集計表の画面は `web/` にまだ無い。**ここで測るのは
 *   サーバ側(読取 + post-filter + 群化 + シリアライズ)だけである。**
 * - **メモリを1バイトも測っていない**(`T05` の申し送り 2 と 4 は解けていない)。
 * - **同時アクセスを測っていない。** 1プロセス・1接続・直列である。
 * - **MCP 経路の集計を1ミリも測っていない**(`computeReport` を呼ぶのは今日 HTTP の1経路
 *   だけである)。
 * - **行アクセス権(点の付与。分岐3)と匿名公開(分岐1)を測っていない** ——
 *   前者の台は `report-limit-boundary.test.ts` が持っており二重に持たない。
 *   後者は集計表の口が未ログインを 401 で閉じている(`D-V8-127`)ので原理的に測れない。
 */
export type ReportCase = {
  label: string;
  /** 叩いた画面ID。 */
  view: string;
  /** 要求した人の役割。 */
  actor: "owner" | "editor";
  /** 結合の向き。 */
  join: "none" | "forward" | "reverse" | "forward_x4";
  /** **読む表の数**(起点 + 結合先)。 */
  tables_read: number;
  /** 1表あたりの行数。 */
  rows_per_table: number;
  /** **読む行の合計**(= `tables_read` × `rows_per_table`。`over` だけ +1)。 */
  scanned_rows: number;
  /**
   * **母集団の分類**(`recordPopulationScope` が返す値の名前)。
   *
   * **これは測定値ではなく、台の宣言から決まる値である** ——
   * `st_owner` を持つ表は `owner_scoped`、条件つきの読取規則で読む表は
   * `role_conditional`、どちらでもなければ `unfiltered`。
   */
  population: "unfiltered" | "owner_scoped" | "role_conditional";
  /** 応答の状態コード。 */
  status: number;
  /** 応答の群の数(200 のときだけ)。 */
  total_groups: number | null;
  /** 応答の `totals` の件数(200 のときだけ)。**母集団の大きさそのもの。** */
  total_count: number | null;
  /** 応答本文のバイト数。 */
  payload_bytes: number;
  /** `Content-Length` ヘッダ(付いていなければ `null`)。 */
  content_length: string | null;
  /** 400 のときの1件目の文面(**逐語**)。 */
  error_message: string | null;
  http_ms: Timing;
};

export type ReportCaseOptions = {
  /** 1表あたりの行数。 */
  rows: number;
  /** 繰り返し回数。 */
  reps: number;
};

/** 集計表ベンチの1件の定義。**何表・何行を読むかがここから機械的に読める。** */
type ReportCaseSpec = {
  label: string;
  view: string;
  actor: "owner" | "editor";
  join: ReportCase["join"];
  tables_read: number;
  population: ReportCase["population"];
  /** 読む行が「1表あたりの行数 × 表の数」より多い場合の加算(`over` の +1)。 */
  extra_rows?: number;
};

/**
 * 測る一覧。**`T07` の完了条件が名指しした5つを全部含む。**
 *
 * 1. **単表・結合なし**(`single/unfiltered`)
 * 2. **結合あり・順方向 / 逆方向**(`join_forward` / `join_reverse`)
 * 3. **post-filter の掛かる分岐と掛からない分岐の差**
 *    (`single/unfiltered` ⇔ `single/role_conditional` ⇔ `single/owner_scoped`。
 *    **3件とも同じ行数・同じ母集団の中身**)
 * 4. **群が上限(10,000)ちょうど**(`group_by_id`。N = 10,000 のとき群が 10,000)
 * 5. **5表 × N 行**(`five_tables`)
 *
 * **`over_limit` は上限を1行だけ超えたときの応答**(N = 10,000 のとき 400)。
 */
const REPORT_CASES: readonly ReportCaseSpec[] = [
  {
    label: "single/unfiltered",
    view: "v_plain_tag",
    actor: "owner",
    join: "none",
    tables_read: 1,
    population: "unfiltered",
  },
  {
    label: "single/role_conditional",
    view: "v_plain_tag",
    actor: "editor",
    join: "none",
    tables_read: 1,
    population: "role_conditional",
  },
  {
    label: "single/owner_scoped",
    view: "v_owned_tag",
    actor: "owner",
    join: "none",
    tables_read: 1,
    population: "owner_scoped",
  },
  {
    label: "group_by_id/unfiltered",
    view: "v_plain_ids",
    actor: "owner",
    join: "none",
    tables_read: 1,
    population: "unfiltered",
  },
  {
    label: "join_forward/unfiltered",
    view: "v_fwd",
    actor: "owner",
    join: "forward",
    tables_read: 2,
    population: "unfiltered",
  },
  {
    label: "join_forward/role_conditional",
    view: "v_fwd",
    actor: "editor",
    join: "forward",
    tables_read: 2,
    population: "role_conditional",
  },
  {
    label: "join_reverse/unfiltered",
    view: "v_rev",
    actor: "owner",
    join: "reverse",
    tables_read: 2,
    population: "unfiltered",
  },
  {
    label: "join_reverse/role_conditional",
    view: "v_rev",
    actor: "editor",
    join: "reverse",
    tables_read: 2,
    population: "role_conditional",
  },
  {
    label: "five_tables/unfiltered",
    view: "v_five",
    actor: "owner",
    join: "forward_x4",
    tables_read: 5,
    population: "unfiltered",
  },
  {
    label: "five_tables/role_conditional",
    view: "v_five",
    actor: "editor",
    join: "forward_x4",
    tables_read: 5,
    population: "role_conditional",
  },
  {
    label: "over_limit/unfiltered",
    view: "v_over",
    actor: "owner",
    join: "none",
    tables_read: 1,
    population: "unfiltered",
    extra_rows: 1,
  },
];

/** {@link repeat} の async 版。 */
async function repeatAsync(times: number, body: () => Promise<number>): Promise<Timing> {
  const samples: number[] = [];
  for (let i = 0; i < times; i++) {
    samples.push(await body());
  }
  return summarizeTimings(samples);
}

/**
 * 1つの行数で全ケースを測る。**台は1つだけ作って使い回す**(要求ごとにキャッシュを
 * 持たない実装なので、台を作り直しても数値の意味は変わらない)。
 *
 * テストから小さい `rows` / `reps` で直呼びできるよう export する。
 */
export async function runReportCases(opts: ReportCaseOptions): Promise<ReportCase[]> {
  const { rows, reps } = opts;
  const appId = "report-bench";
  return withDataRootAsync(async (root) => {
    let owner: ReturnType<typeof seedSession> | undefined;
    let editor: ReturnType<typeof seedSession> | undefined;
    buildReportApp({
      dataRoot: root,
      appId,
      rowsPerTable: rows,
      afterCreate: () => {
        owner = seedSession(root, appId, { role: "owner", username: "bench-owner" });
        editor = seedSession(root, appId, { role: "editor", username: "bench-editor" });
        return owner.userId;
      },
    });
    if (owner === undefined || editor === undefined) {
      throw new Error("集計表ベンチのセッションが作られていません");
    }
    const cookies: Record<"owner" | "editor", string> = {
      owner: owner.cookie,
      editor: editor.cookie,
    };

    const app = createServerApp({ dataRoot: root });
    // **本物のソケットで測る**(`app.request` の直呼びではない)。
    // **理由は2つ**: (1) `T07` 完了条件 4' が **`Content-Length`** を測れと言っており、
    // **`app.request` の返す `Response` にはそのヘッダが1つも付かない**(実測。
    // 付けるのはサーバの実装であってハンドラではない)。(2) 利用者が実際に払う費用は
    // ループバックの往復を含む。**したがってここの時間は `app.request` 直呼びより
    // 遅い側であり、上限ではなく実測そのものである。**
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    const origin = `http://localhost:${server.port}`;
    const out: ReportCase[] = [];
    try {
      for (const spec of REPORT_CASES) {
        let status = 0;
        let body = "";
        let contentLength: string | null = null;
        const http_ms = await repeatAsync(reps, async () => {
          const started = Bun.nanoseconds();
          const response = await fetch(`${origin}/api/apps/${appId}/views/${spec.view}/report`, {
            method: "GET",
            headers: { origin: TEST_ORIGIN, cookie: cookies[spec.actor] },
          });
          const text = await response.text();
          const ms = (Bun.nanoseconds() - started) / 1e6;
          status = response.status;
          body = text;
          contentLength = response.headers.get("content-length");
          return ms;
        });

        const parsed = JSON.parse(body) as {
          total_groups?: number;
          totals?: { type: string; value: number }[];
          errors?: { message: string }[];
        };
        const count = parsed.totals?.find((entry) => entry.type === "count")?.value;
        out.push({
          label: `${spec.label}/rows=${rows}`,
          view: spec.view,
          actor: spec.actor,
          join: spec.join,
          tables_read: spec.tables_read,
          rows_per_table: rows,
          scanned_rows: spec.tables_read * rows + (spec.extra_rows ?? 0),
          population: spec.population,
          status,
          total_groups: parsed.total_groups ?? null,
          total_count: count ?? null,
          payload_bytes: Buffer.byteLength(body, "utf8"),
          content_length: contentLength,
          error_message: parsed.errors?.[0]?.message ?? null,
          http_ms,
        });
      }
    } finally {
      await server.stop(true);
    }
    return out;
  });
}

/**
 * フル sweep。run.ts から呼ぶ。
 *
 * **行数は 1,000 と 10,000 の2点である** —— **`ADR-0019:86`-`:88` の帯の境目そのもの
 * (`≤ 1,000` = SLO 保証対象 / `≤ 10,000` = 動作するが重い)。**
 * **10,000 は集計表が読む行の上限(inclusive)でもある。**
 *
 * **シードを1つも引かない** —— **この台は乱数を1つも使わないので、同じ行数なら
 * 同じ DB・同じ応答バイト数になる。**
 */
export async function reportScenario(reps: number): Promise<ReportCase[]> {
  const REPS = Math.max(reps, 5);
  const out: ReportCase[] = [];
  for (const rows of [1_000, 10_000]) {
    out.push(...(await runReportCases({ rows, reps: REPS })));
  }
  return out;
}
