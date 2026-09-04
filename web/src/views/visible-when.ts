/**
 * **操作起点の表示条件の評価**(`V4-M20-T02` / `ADR-0101` 限定2・限定3)。
 *
 * **【V5-M21-T01 / `L-G1` / ADR-0171 でここへ切り出した】** **着手前、この2つの関数は
 * `web/src/views/DetailViewRenderer.tsx` の中にあった**(`comparableValue` = 当時 `:156` /
 * `visibleWhenMatches` = 当時 `:190`)。**`ADR-0171` が `list_view` にも操作起点を許した
 * ので、`ListViewRenderer` からも同じ評価が要る。****同じ判定を2箇所に書かない** ——
 * 片方だけが更新される日が必ず来る。**関数の中身は1バイトも変えていない**(移しただけである)。
 *
 * **これは `src/kernel/` の公開 export ではない**(`web/src/` の中である)——
 * `ADR-0171` 限定11(`Δ8` を空に保つ)を1ミリも動かしていない。
 */
import type { FilterLeaf } from "../../../src/kernel/types.ts";
import type { RecordRow } from "../api.ts";

/**
 * 真偽値を比較可能な値へ畳む(SQLite に写したときの形。`true` / `false` は 1 / 0)。
 *
 * **【SQ-M4 追記】** かつては「`src/kernel/read-records.ts` の `comparable` と同じ規則」と
 * 書いていた。**その関数は消えた**(システムテーブルの読取を SQL へ一本化したため)。
 * **規則そのものは変わっていない** —— 揃える先が SQLite の値だからである。
 *
 * **サーバは行の値を SQLite から読むので `boolean` は 1 / 0 で届くが、ここへ届くのは
 * JSON なので `true` / `false` である。** 比較の前に同じ形へ揃える。
 */
function comparableValue(value: unknown): string | number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return typeof value === "number" || typeof value === "string" ? value : null;
}

/**
 * **操作起点の表示条件を、今開いているレコードに対して評価する**(`V4-M20-T02` /
 * `ADR-0101` 限定2・限定3)。
 *
 * **葉1つだけである** —— `and` / `or` / `not` は schema が書けないようにしており、
 * ここにも1つも実装が無い。**演算子は `equals` / `contains` / `gte` / `lte` / `in` の
 * 有限5種だけ**で、`$defs/filter_leaf`(`ADR-0043` 限定1)そのままである。
 *
 * ## **意味論を写した元と、正直な限界**
 *
 * カーネルの絞り込み(`src/kernel/records.ts` の `compileFilter`)と同じ規則で
 * 書いた —— **行の値が未設定(`null`)ならどの演算子でも偽**(SQL の `NULL = ?` が偽に
 * なるのに合わせる)/ `contains` はリテラル・大文字小文字を区別する部分一致 /
 * `gte` / `lte` は数値どうしなら数値、そうでなければ文字列として比べる。
 *
 * > **【正直に書く】これは同じ意味論の**2本目の実装**である**(SQL = `records.ts` の
 * > `compileFilter` / ここ)。**カーネルの述語をそのまま呼べない**(あちらは `bun:sqlite` と
 * > `validateDbFreeFieldValue` に依存しており、ブラウザのバンドルに入れられない)。
 * > **2本が将来ずれないことを、機械的に固定していない。**
 * >
 * > **【SQ-M4 で 3本 → 2本 になった。旧文を消さずに直す】** かつては「**3本目の実装**」
 * > (SQL / `read-records.ts` のメモリ経路 / ここ)と書いていた。**システムテーブルの
 * > 読取を SQL へ一本化したので、2本目が消えて、ここが2本目になった。**
 * > **ここの実装は1バイトも変えていない。**
 *
 * **書込を止めているのはここではない** —— **偽を返すのはボタンを描かないためだけであり、
 * サーバ側の書込判定を1バイトも変えていない**(`ADR-0101` 限定6)。
 */
export function visibleWhenMatches(leaf: NonNullable<FilterLeaf>, record: RecordRow): boolean {
  const raw = record[leaf.field];
  if ("contains" in leaf) {
    return typeof raw === "string" && raw.includes(leaf.contains);
  }
  const value = comparableValue(raw);
  if (value === null) {
    // 未設定の行はどの演算子でも偽(SQL の除外挙動に合わせる)。
    return false;
  }
  if ("in" in leaf) {
    return leaf.in.some((element) => comparableValue(element) === value);
  }
  if ("equals" in leaf) {
    return comparableValue(leaf.equals) === value;
  }
  const bound = comparableValue("gte" in leaf ? leaf.gte : leaf.lte);
  if (bound === null) {
    return false;
  }
  const compared =
    typeof value === "number" && typeof bound === "number"
      ? value === bound
        ? 0
        : value < bound
          ? -1
          : 1
      : String(value) === String(bound)
        ? 0
        : String(value) < String(bound)
          ? -1
          : 1;
  return "gte" in leaf ? compared >= 0 : compared <= 0;
}
