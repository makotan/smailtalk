/**
 * P6 2プロセス実証テスト用の**別プロセス側の更新者**(V1-M9-T02 テスト(i))。
 *
 * `two-process-concurrency.test.ts` が同じレコードに対してこのプロセスを **2つ** 起動する。
 * 両者は**親が一度だけ読んだ同じ版(`_updated_at`)**を `expectedVersion` として渡され、
 * `ready` センチネルで「準備できた」ことを親に知らせ、親が置く `go` センチネルを待ってから
 * **同時に** `updateRecord`(CAS 付き)を撃つ。SQLite は書込を直列化するが、CAS
 * (`UPDATE ... WHERE _id=? AND _updated_at=?`)が SQL レベルで正しさを保証するので、
 * **片方だけが成功し、他方は版不一致(`conflict`)で弾かれる**。
 *
 * 同一プロセスのモックでは「別接続からの同時更新」を実証できない(完了条件6)。
 * `src/kernel/` 配下に置く理由は `heavy-apply.ts` の doc と同じ(import-drift 非干渉)。
 *
 * 引数(順序):
 *   `<dataRoot> <appId> <tableId> <recordId> <expectedVersion> <newTitle> <ready> <go> <resultPath>`
 */
import { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { readCurrentManifest } from "../apply-manifest.ts";
import { updateRecord } from "../records.ts";
import { appDbPath } from "../storage-paths.ts";

const [
  dataRoot,
  appId,
  tableId,
  recordId,
  expectedVersion,
  newTitle,
  readyPath,
  goPath,
  resultPath,
] = process.argv.slice(2);

if (
  dataRoot === undefined ||
  appId === undefined ||
  tableId === undefined ||
  recordId === undefined ||
  expectedVersion === undefined ||
  newTitle === undefined ||
  readyPath === undefined ||
  goPath === undefined ||
  resultPath === undefined
) {
  throw new Error(
    "使い方: patch-writer.ts <dataRoot> <appId> <tableId> <recordId> <expectedVersion> <newTitle> <ready> <go> <resultPath>",
  );
}

const manifest = readCurrentManifest(dataRoot, appId);
const db = new Database(appDbPath(dataRoot, appId), { readwrite: true, create: false });
// 書込同士は直列化する。CAS の衝突(changes===0)と SQLITE_BUSY を混同しないよう、
// ロックは諦めずに待つ(busy_timeout を十分に取る)。負けた側は版不一致で弾かれる。
db.exec("PRAGMA busy_timeout = 30000;");

try {
  // 準備完了を親に知らせ、親の合図(go)を待つ。両者が go を見てから同時に撃つ。
  writeFileSync(readyPath, "ready", "utf-8");
  const deadline = Bun.nanoseconds() + 10_000 * 1e6;
  while (!existsSync(goPath)) {
    if (Bun.nanoseconds() > deadline) {
      throw new Error("親からの go シグナルが 10 秒以内に来ませんでした。");
    }
    Bun.sleepSync(1);
  }

  const result = updateRecord(
    db,
    manifest,
    tableId,
    recordId,
    { title: newTitle },
    expectedVersion,
  );
  writeFileSync(
    resultPath,
    JSON.stringify(
      result.ok
        ? { ok: true, version: result.value._updated_at, title: result.value.title }
        : { ok: false, conflict: result.conflict === true },
    ),
    "utf-8",
  );
  process.exit(0);
} finally {
  db.close();
}
