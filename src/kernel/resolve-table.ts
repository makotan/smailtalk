import { findSystemTable } from "../shared/system-tables.ts";
import type { Manifest, ResourceId, Table } from "./types.ts";

/**
 * テーブル解決の一本化(ADR-0006 §7)。
 *
 * システムテーブルは `manifest.app.tables` に現れない(ADR-0006 §5)ため、
 * 「マニフェストからテーブルを探して、無ければ存在しない」という素朴な解決は
 * システムテーブルに対して必ず**嘘**を返す。`_apps` は存在する。ただ書けないだけである。
 * しかもその嘘は「では add_table で作ろう」という誤った自己修正をAIに誘導する(憲法6)。
 *
 * **読み取り経路はすべてこの関数を通す。** 解決できれば読める。
 *
 * **書き込み経路(`createRecord` / `updateRecord` / `deleteRecord`)はこの関数を使わない。**
 * ADR-0006 §8 の指定どおり、書き込みでは `isSystemTableId` による拒否をテーブル解決より
 * 前に置き、解決自体はマニフェスト限定のままにする。ここで解決してしまうと、
 * ガードを1つ書き漏らした瞬間に存在しない物理テーブルへ `INSERT` が飛び、
 * 統一形式ですらない 500 になる。**書き込み経路では「解決しないこと」が安全性を担保する。**
 */
export function resolveTable(manifest: Manifest, tableId: ResourceId): Table | undefined {
  // ユーザは `_` 始まりのIDを定義できないので、優先順位に迷う余地はない。
  return findSystemTable(tableId) ?? manifest.app.tables.find((table) => table.id === tableId);
}
