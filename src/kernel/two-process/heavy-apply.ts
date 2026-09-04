/**
 * P6 2プロセス実証テスト用の**別プロセス側の適用者(A)**(V1-M9-T02)。
 *
 * `two-process-concurrency.test.ts` が `Bun.spawn` で起動する。**テスト専用の
 * サブプロセスであり、独立したハーネスではない**(`scripts/bench/contention-writer.ts`
 * と同じ位置づけ)。`src/kernel/` 配下に置いてあるのは、カーネルを相対 import して
 * `kernel-import-drift.test.ts` のスナップショット(層の外→カーネルの import を数える)を
 * 動かさないためである。
 *
 * ## 何をするか
 *
 * 実データ量の大きいテーブルに対して `change_field`(number → text 等)を1回 `applyDiff` する。
 * これは層2(テーブル再構築 = 新テーブル作成 → 全行コピー → **旧テーブル DROP** → rename)を
 * 起こすので、`beginApply`〜`endApply` の危険窓(`.st-applying.json` マーカーが立つ区間)が
 * **実データ量に比例して伸びる**。**テスト用のフック(遅延・差し替え)は1つも挟まない** ——
 * 窓はあくまで本物の再構築コストで伸ばす(計画の厳守事項)。
 *
 * 別プロセスの適用者でなければならないのは、同一プロセスのモックでは「別接続が本当に
 * apply 窓に入っている間に書き込みを試みる」ことを実証できないからである(完了条件6)。
 *
 * 引数(順序): `<dataRoot> <appId> <tableId> <field> <newType> <diffId> <resultPath>`
 * 結果は `resultPath` に JSON(`{ valid, errors?, threw? }`)で書き、終了コードでも返す。
 */
import { writeFileSync } from "node:fs";
import { applyDiff } from "../apply-diff.ts";

const [dataRoot, appId, tableId, field, newType, diffId, resultPath] = process.argv.slice(2);

if (
  dataRoot === undefined ||
  appId === undefined ||
  tableId === undefined ||
  field === undefined ||
  newType === undefined ||
  diffId === undefined ||
  resultPath === undefined
) {
  throw new Error(
    "使い方: heavy-apply.ts <dataRoot> <appId> <tableId> <field> <newType> <diffId> <resultPath>",
  );
}

try {
  const result = applyDiff(dataRoot, appId, {
    diff_id: diffId,
    intent: "数量を自由記述にしたいという要望(重い再構築で apply 窓を実データ量で伸ばす)",
    operations: [{ op: "change_field", table: tableId, field, changes: { type: newType } }],
  });
  writeFileSync(
    resultPath,
    JSON.stringify(result.valid ? { valid: true } : { valid: false, errors: result.errors }),
    "utf-8",
  );
  process.exit(result.valid ? 0 : 1);
} catch (error) {
  // applyDiff は失敗時に適用前へ巻き戻してから投げ直す(rollback してクリーン)。
  // ここで捕まえて結果に残す —— 親はこれを見て「成功か rollback でクリーン」を確かめる。
  writeFileSync(
    resultPath,
    JSON.stringify({ valid: false, threw: error instanceof Error ? error.message : String(error) }),
    "utf-8",
  );
  process.exit(1);
}
