/**
 * 負荷試験(V1-M3-T06)の**別プロセス側の書き手**。
 *
 * `scenarios.ts` の `loadWriterScenario` / `runLoadCase` が `Bun.spawn` で N 個起動する。
 * **本ファイルは `scripts/bench/` の一部であり、独立したベンチマークハーネスではない**
 * (`contention-writer.ts` と同格の部品。三重に作らない、という正典要件に反しない)。
 *
 * ## 何をするか
 *
 * 1. `app.sqlite` を書き込みで開き、`PRAGMA busy_timeout` を指定値に設定する
 *    (journal_mode はファイルに焼き済み。親が用意する)。
 * 2. **スタートバリア**: `readyPath` を書いて「準備完了」を親に伝え、`goPath` が
 *    現れるまで spin する。これで N 個の書き手が**同時に**走り出す(競合を確実に作る)。
 * 3. `ops` 回、下記トランザクション本体を回す。トランザクションは `db.transaction(body)`
 *    で作り、`begin==="immediate"` のときは `tx.immediate()`(= `BEGIN IMMEDIATE`)、
 *    それ以外は `tx()`(= deferred begin。現行サーバ相当)で実行する。
 *    - `insert`: 1件 INSERT する(`_id` は `load-<writerIndex>-<i>` でユニーク)。
 *    - `update`: **read-then-CAS-update を手書きミラー**する。
 *      `SELECT "_updated_at"`(SHARED ロック取得)→
 *      `UPDATE ... WHERE "_id"=? AND "_updated_at"=?`(RESERVED へ昇格)。
 *      deferred begin ではこの lock-upgrade が別行同士でもデッドロックし得る。
 *      `changes===0` は **CAS 衝突**(後発が古い版で負けた。M9-T02 の領分)であり、
 *      エラーではない。`cas_conflict` として数える。
 * 4. 例外は `isBusy`(SQLITE_BUSY = HTTP500 相当)と `other` に分類して数える。
 * 5. `db.close()` して `resultPath` に集計 JSON を書き、`process.exit(0)`。
 *
 * ## 保守性についての注意(レポート用)
 *
 * 実サーバは `writeWithAudit` の**同一トランザクション内で** `_auth_activity` にも
 * INSERT する(ロック窓がその分広い)。本 writer はその第2書込を省くので、
 * **観測 BUSY はロックの下限**である —— 実運用はより悪い方向に出る。
 *
 * 引数(順序):
 *   <dbPath> <tableId> <op> <begin> <busyTimeoutMs> <ops> <writerIndex> <rowSpace> <readyPath> <goPath> <resultPath>
 *   - op:       insert | update
 *   - begin:    deferred | immediate
 *   - rowSpace: own(自分専用の別行)| shared(全 writer が同じ少数のホット行)
 */
import { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";

/** shared のホット行数。`scenarios.ts` の HOT と一致させること。 */
const HOT = 4;

function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "SQLITE_BUSY" || code === "SQLITE_BUSY_SNAPSHOT") {
    return true;
  }
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && /database is locked/i.test(message);
}

const [
  dbPath,
  tableId,
  op,
  begin,
  busyTimeoutRaw,
  opsRaw,
  writerIndexRaw,
  rowSpace,
  readyPath,
  goPath,
  resultPath,
] = process.argv.slice(2);

if (
  dbPath === undefined ||
  tableId === undefined ||
  op === undefined ||
  begin === undefined ||
  busyTimeoutRaw === undefined ||
  opsRaw === undefined ||
  writerIndexRaw === undefined ||
  rowSpace === undefined ||
  readyPath === undefined ||
  goPath === undefined ||
  resultPath === undefined
) {
  throw new Error(
    "使い方: load-writer.ts <dbPath> <tableId> <op> <begin> <busyTimeoutMs> <ops> <writerIndex> <rowSpace> <readyPath> <goPath> <resultPath>",
  );
}

if (op !== "insert" && op !== "update") {
  throw new Error(`op は insert | update のいずれかです(受け取った値: ${op})`);
}
if (begin !== "deferred" && begin !== "immediate") {
  throw new Error(`begin は deferred | immediate のいずれかです(受け取った値: ${begin})`);
}
if (rowSpace !== "own" && rowSpace !== "shared") {
  throw new Error(`rowSpace は own | shared のいずれかです(受け取った値: ${rowSpace})`);
}

const busyTimeoutMs = Number(busyTimeoutRaw);
const ops = Number(opsRaw);
const writerIndex = Number(writerIndexRaw);
if (!Number.isFinite(busyTimeoutMs) || busyTimeoutMs < 0) {
  throw new Error(
    `busyTimeoutMs は0以上の数値である必要があります(受け取った値: ${busyTimeoutRaw})`,
  );
}
if (!Number.isInteger(ops) || ops < 1) {
  throw new Error(`ops は1以上の整数である必要があります(受け取った値: ${opsRaw})`);
}
if (!Number.isInteger(writerIndex) || writerIndex < 0) {
  throw new Error(`writerIndex は0以上の整数である必要があります(受け取った値: ${writerIndexRaw})`);
}

/** seed 行の `_id`(fixture.ts:147 と同じ形式)。 */
function rowId(index: number): string {
  return `${tableId}-${String(index).padStart(9, "0")}`;
}

const db = new Database(dbPath, { readwrite: true, create: false });

let commits = 0;
let busy = 0;
let other = 0;
let casConflict = 0;

try {
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);

  const insertStmt = db.query(
    `INSERT INTO "${tableId}" ("_id", "_created_at", "_updated_at", "title") VALUES (?, ?, ?, ?)`,
  );
  const selectStmt = db.query(`SELECT "_updated_at" AS u FROM "${tableId}" WHERE "_id" = ?`);
  const updateStmt = db.query(
    `UPDATE "${tableId}" SET "_updated_at" = ?, "title" = ? WHERE "_id" = ? AND "_updated_at" = ?`,
  );

  // --- スタートバリア: 準備完了を伝え、go が出るまで待つ(N 個を同時発火させる) ---
  writeFileSync(readyPath, "1", "utf-8");
  const deadline = Bun.nanoseconds() + 30_000 * 1e6;
  while (!existsSync(goPath)) {
    if (Bun.nanoseconds() > deadline) {
      throw new Error("go シグナルが 30 秒以内に来ませんでした。");
    }
    Bun.sleepSync(1);
  }

  const start = Bun.nanoseconds();
  for (let i = 0; i < ops; i++) {
    try {
      if (op === "insert") {
        const now = new Date().toISOString();
        const body = (): void => {
          insertStmt.run(`load-${writerIndex}-${i}`, now, now, `負荷 ${writerIndex}-${i}`);
        };
        const tx = db.transaction(body);
        if (begin === "immediate") {
          tx.immediate();
        } else {
          tx();
        }
        commits += 1;
      } else {
        // update: read-then-CAS-update の手書きミラー
        const targetIndex = rowSpace === "own" ? writerIndex * ops + i : i % HOT;
        const id = rowId(targetIndex);
        // 新しい `_updated_at` は**必ずユニーク**にする。そうしないと shared で
        // 古い版の CAS が誤って一致してしまい、版衝突が検出できない。
        const nextStamp = `${new Date().toISOString()}#${writerIndex}.${i}.${Bun.nanoseconds()}`;
        let conflicted = false;
        const body = (): void => {
          const cur = selectStmt.get(id) as { u: string } | null;
          if (cur === null) {
            // 対象行が無いのは前提崩れ(親が十分な行を seed していない)。other 扱い。
            throw new Error(`対象行が存在しません: ${id}`);
          }
          const r = updateStmt.run(nextStamp, `負荷 ${writerIndex}-${i}`, id, cur.u);
          if (r.changes === 0) {
            conflicted = true;
          }
        };
        const tx = db.transaction(body);
        if (begin === "immediate") {
          tx.immediate();
        } else {
          tx();
        }
        if (conflicted) {
          casConflict += 1;
        } else {
          commits += 1;
        }
      }
    } catch (error) {
      if (isBusy(error)) {
        busy += 1;
      } else {
        other += 1;
      }
    }
  }
  const elapsedMs = (Bun.nanoseconds() - start) / 1e6;

  db.close();
  writeFileSync(
    resultPath,
    JSON.stringify({ commits, busy, other, cas_conflict: casConflict, elapsed_ms: elapsedMs }),
    "utf-8",
  );
  process.exit(0);
} catch (error) {
  try {
    db.close();
  } catch {
    // すでに閉じているなら無視してよい。
  }
  throw error;
}
