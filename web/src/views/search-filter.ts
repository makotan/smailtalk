/**
 * **打たれた語から読取API の `filter` を組み立てる、ただ1本の規則**
 * (`V4-M22-T02` / `ADR-0112` 限定7・限定9。**`V6-M4-T01` / `K-G11` が共有先へ切り出した**)。
 *
 * ## なぜこのファイルが在るのか(**新しい規則を1つも作っていない**)
 *
 * **この関数は `web/src/views/ListViewRenderer.tsx:492` に `export` されない形で住んでいた。**
 * **`V6-M4-T01`(`K-G11`)が参照項目の絞り込みからも同じ規則を使う必要が生じたので、
 * `v6-m0.md` §7-5 が挙げた2案(「`export` を1語足す」/「共有モジュールへ切り出す」)の
 * うち後者を採った。** **関数の中身は1バイトも変えていない** —— **移しただけである。**
 *
 * **切り出した理由**: `web/src/fields/input.tsx` から `ListViewRenderer.tsx` を import すると、
 * **入力欄1つのために一覧の画面まるごとが依存に入る。** **規則だけを持つ小さな家に置く。**
 *
 * ## 承知して受ける代償(`v6-m0.md` §7-5 の `S3` 1 の逐語)
 *
 * > **`buildSearchFilter` を共有すると、一覧の検索と参照の絞り込みが同じ関数に依存する。**
 * > 片方の都合で関数を変えると、もう片方が黙って変わる。
 *
 * **この代償は「規則を2つ持たない」ことと引き換えである。** **隠さない。**
 */
import type { FilterCondition, FilterNode, ResourceId } from "../../../src/kernel/types.ts";

/**
 * **打たれた語から、読取API に渡す `filter` を1つ組み立てる**(`ADR-0112` 限定7 / 限定9)。
 *
 * **照合は `contains` の OR で固定である**(限定7)—— **`equals` / `gte` / `lte` / `in` を
 * 1つも使わず、正規表現・あいまい検索・語の分割・大小文字の規則・複数語の AND を1つも
 * 作らない。** **利用者が打った1つの語が、宣言した列のどれかに含まれるか、だけである。**
 *
 * **画面の `view.filter` を外せない**(限定9)—— **必ず `and` で結ぶ。** **`or` / `not` で
 * `view.filter` を無効化する経路を1本も作らない**(`ADR-0081` 限定3 と同型)。
 * **旧来の等値AND配列で書かれた `filter` は、`{ and: [...] }` に包んで丸ごと入れる** ——
 * **葉を1つも取り出さないので、条件が1つも落ちない。**
 *
 * **`view.filter` を1バイトも書き換えない** —— 新しいオブジェクトを組み立てて返すだけである。
 * **検索語はマニフェストに1バイトも入らない**(限定8)—— 語はここで作った値に入り、
 * `buildListQuery` が `?filter=<JSON>` としてリクエストに載せる。
 *
 * **語が空(空白だけを含む)なら、画面の `filter` をそのまま返す** —— **空の `or` を
 * 送らない**(全件が消える形を作らない)。
 *
 * **【`V6-M4-T01` / `K-G11` の追記。上の本文を1バイトも書き換えていない】**
 * **参照項目の絞り込み(打った文字で候補を絞る選び方)もこの1本を呼ぶ。**
 * **そちら側は「画面の `filter`」を持たないので第1引数に `undefined` を渡す** ——
 * **第2引数は `web/src/fields/reference-label.ts` の `referenceSearchFields` が
 * 解決した項目のIDである**(**探す対象の解決規則も、ここには1バイトも無い**)。
 */
export function buildSearchFilter(
  viewFilter: FilterCondition[] | FilterNode | undefined,
  searchFields: readonly ResourceId[],
  term: string,
): FilterCondition[] | FilterNode | undefined {
  const trimmed = term.trim();
  if (trimmed === "" || searchFields.length === 0) {
    return viewFilter;
  }
  const searchNode: FilterNode = {
    or: searchFields.map((field) => ({ field, contains: trimmed })),
  };
  if (viewFilter === undefined) {
    return searchNode;
  }
  const declared: FilterNode = Array.isArray(viewFilter) ? { and: viewFilter } : viewFilter;
  return { and: [declared, searchNode] };
}
