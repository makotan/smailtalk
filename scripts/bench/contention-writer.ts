/**
 * クロスプロセス競合測定(V1-M9-T03 の測定項目 b)の**別プロセス側の書き手**。
 *
 * `scenarios.ts` の `crossProcessContentionScenario` が `Bun.spawn` で起動する。
 * **本ファイルは `scripts/bench/` の一部であり、独立したベンチマークハーネスではない**
 * (三重に作らない、という正典要件は「別のベンチ基盤を作らない」ことを指す。
 * 既存ハーネスの一部品としてのサブプロセスはこれに当たらない)。
 *
 * ## 何をするか
 *
 * 1. `app.sqlite` を書き込みで開き、`journal_mode` を指定モードに設定する。
 * 2. `BEGIN EXCLUSIVE` で**排他書き込みロックを取得**し、1件 INSERT する
 *    (= `app.sqlite` に対して「書き込み中」の状態を作る)。
 * 3. ロックを取れたことを **sentinel ファイル**で親に知らせる。
 * 4. `holdMs` の間ロックを保持したまま眠る(この間、親プロセスが読み取りを試みる)。
 * 5. `COMMIT` してロックを解放する。
 *
 * **同一プロセス・同一スレッドではロックを保持したまま解放できない**(JS は単一スレッド)。
 * 「書き手が書き込みを終えたら読み手が進める」という**本物の待ち時間**は、
 * 別プロセスの書き手がロックを解放して初めて測れる。そのための最小の書き手である。
 *
 * 引数(順序): `<dbPath> <mode> <holdMs> <sentinelPath> <tableId>`
 */
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";

const [dbPath, mode, holdMsRaw, sentinelPath, tableId] = process.argv.slice(2);

if (
  dbPath === undefined ||
  mode === undefined ||
  holdMsRaw === undefined ||
  sentinelPath === undefined ||
  tableId === undefined
) {
  throw new Error("使い方: contention-writer.ts <dbPath> <mode> <holdMs> <sentinelPath> <tableId>");
}

const holdMs = Number(holdMsRaw);
if (!Number.isFinite(holdMs) || holdMs < 0) {
  throw new Error(`holdMs は0以上の数値である必要があります(受け取った値: ${holdMsRaw})`);
}

const db = new Database(dbPath, { readwrite: true, create: false });
try {
  db.exec(`PRAGMA journal_mode = ${mode.toUpperCase()};`);
  // 書き手自身は競合を待てるようにしておく(親の読み取りと取り合っても諦めない)。
  db.exec("PRAGMA busy_timeout = 30000;");
  db.exec("BEGIN EXCLUSIVE");
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO "${tableId}" ("_id", "_created_at", "_updated_at", "title") VALUES (?, ?, ?, ?)`,
  ).run(`xproc-${process.pid}-${Date.now()}`, now, now, "クロスプロセスの書き手");
  // ロックを握った状態で「準備完了」を親に知らせる。親はこれを見てから読みにいく。
  writeFileSync(sentinelPath, "ready", "utf-8");
  Bun.sleepSync(holdMs);
  db.exec("COMMIT");
} finally {
  db.close();
}
