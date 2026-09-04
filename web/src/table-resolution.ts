/**
 * フロントのテーブル解決(ADR-0006 §7 の #9〜#12)。
 *
 * システムテーブル(`_apps` / `_changelog`)は `manifest.app.tables` に現れない
 * (ADR-0006 §5)。したがって「マニフェストから探して、無ければ存在しない」という
 * 素朴な解決は、システムテーブルに対して必ず**嘘**を返す。`_apps` は存在する。
 * ただ書けないだけである(憲法6)。
 *
 * フロントにはこの解決が**4箇所**独立に存在していた。落とすと DoD-4 が落ちる ――
 * `ListViewRenderer` は `_apps` を指す list_view に対し、レコードAPI を**一度も
 * 叩かないまま**「マニフェストにありません」を描画して終わっていた。サーバ側を
 * 完璧に直しても画面は空のままである。したがって4箇所をこの1関数に集約する。
 *
 * カーネル側の `src/kernel/resolve-table.ts` と同じ規則だが、そちらを import しない。
 * `src/kernel/*` を辿ると `bun:sqlite` を推移的に読み込み `vite build` が壊れるためで、
 * フロントが値として触ってよいのは `src/shared/*` だけである(ADR-0006 §6)。
 *
 * **これは読み取りの解決である。** 書き込みを許すことではない。書き込みの禁止は
 * カーネルの L1(最終防衛線)が担い、フロントの L4(削除ボタンを出さない)は
 * 防御ではなく UI の一貫性のためにある(ADR-0006 §8)。
 */
import type { Manifest, ResourceId, Table } from "../../src/kernel/types.ts";
import { findSystemTable, SYSTEM_TABLE_IDS } from "../../src/shared/system-tables.ts";

export { isSystemTableId } from "../../src/shared/system-tables.ts";

/** ビューの対象テーブルを解決する。システムテーブルも解決する。 */
export function resolveViewTable(manifest: Manifest, tableId: ResourceId): Table | undefined {
  // ユーザは `_` 始まりのIDを定義できない(`resource-id.ts` と JSON Schema の二重の壁)ので、
  // 優先順位に迷う余地はない。
  return findSystemTable(tableId) ?? manifest.app.tables.find((table) => table.id === tableId);
}

/**
 * 対象テーブルを解決できなかったときの `allowed_values`。
 *
 * 宣言テーブルだけを並べると、システムテーブルが選べることを候補一覧から知れない
 * (ADR-0006 §9 が referential-integrity について避けた失敗と同型)。`view.table` に
 * タイポした利用者に対しては、実際に指定できる集合をそのまま出す。
 */
export function viewTargetIds(manifest: Manifest): string[] {
  return [...manifest.app.tables.map((table) => table.id), ...SYSTEM_TABLE_IDS];
}
