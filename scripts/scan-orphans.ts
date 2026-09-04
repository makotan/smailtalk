#!/usr/bin/env bun
/**
 * 孤児・死蔵スナップショットの走査(V1-M9-T04。ADR-0030)。
 *
 * 判断ゲート(`docs/plan/v1/records/v1-m9-t04-gate.md`)は scratchpad の使い捨てスクリプトで
 * 数えたが、実装フェーズでは**カーネルの検出関数を使う形**へ置き換える(ゲート §8-4)。
 * 本スクリプトは `auditAllSnapshots` を呼んで、データルート配下の全アプリの
 * 孤児 / 死蔵(-undo-) / 宙吊り参照 / バイト数を JSON で出す。**再実行可能**であることが要点。
 *
 * 使い方:
 *   mise exec -- bun scripts/scan-orphans.ts <dataRoot>
 *
 * 例(実在する唯一のデータルート。ゲート §1 (a-1) の走査対象):
 *   mise exec -- bun scripts/scan-orphans.ts /Users/makotan/projects/growable_platform/data-demo
 *
 * 期待(2026-07-23 の実測。ADR-0030 §実測): reading-log の
 *   孤児 0件 / スナップショット2個 / 29,091 bytes / 死蔵 0件 / 宙吊り 0件。
 * ゲートが指定した CP-4/5/6 の data/ は .gitignore により現存しないので、一致の対象は
 * data-demo に読み替える(ADR-0030 §データルートの読み替え)。
 */
import { auditAllSnapshots } from "../src/kernel/snapshot-orphans.ts";

const dataRoot = process.argv[2];
if (dataRoot === undefined) {
  console.error("使い方: bun scripts/scan-orphans.ts <dataRoot>");
  process.exit(2);
}

const audits = auditAllSnapshots(dataRoot);
const summary = {
  data_root: dataRoot,
  apps: audits.length,
  snapshots_on_disk_total: audits.reduce((sum, a) => sum + a.on_disk.length, 0),
  referenced_total: audits.reduce((sum, a) => sum + a.referenced.length, 0),
  orphans_total: audits.reduce((sum, a) => sum + a.orphans.length, 0),
  undo_snapshots_total: audits.reduce((sum, a) => sum + a.undo_snapshots.length, 0),
  dangling_references_total: audits.reduce((sum, a) => sum + a.dangling_references.length, 0),
  snapshots_bytes_total: audits.reduce((sum, a) => sum + a.bytes, 0),
};

console.log(JSON.stringify(summary));
console.log(JSON.stringify(audits, null, 2));
