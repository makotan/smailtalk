/**
 * **表の代表項目**(`V23-M5-T05` で `app.ts` の `anonymousReferenceTableReadable` の中の式を関数にしたもの。
 * 計画 §24-6 軽1。3つ目の写しを作らない)。 画面の `representativeField`(`web/src/fields/reference-label.ts`)と
 * 同じ読み方: 宣言(`representative_field`)が自表の `text` 項目を指していればそれ、無ければ最初の `text`。
 *
 * 【2026-10-01。`V23-M6-T04b`】`app.ts` の中に在った関数を、本文を1文字も変えずにこのファイルへ移した
 * (写しを増やさない)。 MCP の `list_records` も相手の名前(付与の行ごとの相手の行の代表項目)を同じ読み方で
 * 返すため、`app.ts` と `src/mcp/tools/read.ts` の両方から import する。 判定の家 `owner-scope.ts` は
 * この関数を値として import せず、呼ぶ側から関数として受け取る(判定の家の import を増やさない)。
 *
 * 使うのは未ログインの参照先の判定・自分宛ての招待の一覧(承諾前に見せる代表項目。`D-V23-126`)・
 * 付与の行ごとの相手の名前(`D-V23-156`)。
 */
import type { Table } from "../kernel/types.ts";

export function representativeTextField(table: Table): Table["fields"][number] | undefined {
  const declared = (table as { representative_field?: unknown }).representative_field;
  return (
    table.fields.find((field) => field.id === declared && field.type === "text") ??
    table.fields.find((field) => field.type === "text")
  );
}
