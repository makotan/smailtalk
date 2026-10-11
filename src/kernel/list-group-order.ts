/**
 * **一覧の束ねるキーの読取の並び**(`V20-M4-T01`。メインの裁定 案A。条文 = `ADR-0470` / `ADR-0461`)。
 *
 * ## 何をするか
 *
 * 一覧の読取の引数 `group_by=<項目>&granularity=<粒度>` を検査して形に写し(`parseListGroupBy`)、
 * 読み出した行を**群の値の昇順を第1キーに安定ソートする**(`orderRowsByListGroup`)。
 * **同じ群の中の並びは、渡された順(= SQL が利用者の `sort`、無ければ作成順で並べた順)のまま**である。
 *
 * ## なぜ SQL で並べないか(**`ADR-0339` 限定7**)
 *
 * **日付の群は粒度で丸めた値で並べる必要がある。** **丸めを SQL に書くと、丸めの実装が2本になる**
 * (`ADR-0339` 限定7「日付の丸めを2本目にしない」。見張りは `src/server/report-declaration-boundary.test.ts`
 * の (27))。**したがって丸めは `report.ts` の `truncateToGranularity` を呼ぶだけにし、並びは JS で行う。**
 * **一覧の SQL は着手前と同じ形のままである**(呼び出し側が `LIMIT` / `OFFSET` を外して読むだけ。
 * 個人スコープ等の post-filter 分岐が今日している運び方と同じ)。
 *
 * ## 並びの向き
 *
 * **群の値の昇順、値が無い群は最後** —— **集計表の `compareGroupValue` をそのまま使う**(同じ意味の
 * 並びを2つ持たない)。**【代償。隠さない】文字列は JS の UTF-16 の順で比べる** —— 一覧の
 * `sort`(SQLite の UTF-8 バイト順)とは `𠮷` と `Ａ` のような文字が混ざると逆転しうる
 * (`ADR-0347` 限界3 と同じ穴)。**群の向き(降順)は書けない**(裁定2)。
 *
 * ## このファイルがしないこと
 *
 * - **母集団(誰に何行見えるか)を1つも決めない** —— 並べるのは母集団を閉じた**後**の行である。
 * - **役割の規則が名指しした項目の壁を持たない** —— 壁はサーバ層の `sort` と同じ場所・同じ述語に置く
 *   (`src/server/app.ts`。カーネルはサーバに依存しない)。
 */
import type { ValidationError } from "./errors.ts";
import type { RecordValue } from "./records.ts";
import { compareGroupValue, truncateToGranularity } from "./report.ts";
import type { Table } from "./types.ts";

/** 日付の粒度(集計表と同じ3値。スキーマは `$defs/report` の定義を共有している)。 */
const GRANULARITIES = ["day", "week", "month"] as const;
type Granularity = (typeof GRANULARITIES)[number];

/** 束ねられる型(集計表の `groupableTypes` と同じ4種。`ADR-0470` §Decision 3 の2)。 */
const LIST_GROUPABLE_TYPES: readonly string[] = ["select", "reference", "boolean", "date"];

/** 読取の束ねるキー(設計図の `list_view.group_by` と同じ形)。 */
type ListGroupKey = { field: string; granularity?: Granularity };

/**
 * **読取の引数を検査して形に写す。** `field` が `null`(引数が無い)なら束ねない(`undefined`)。
 *
 * 値域: 実在する項目 / 型4種 / 粒度3値 / date に必須 / date 以外に不可 / 粒度だけの指定は不可。
 * **空文字の `group_by=` は誤りとして返す**(黙って「束ねない」に化けさせない)。
 * 書ける値の一覧は、その表の束ねられる項目(表の項目の順)。**役割の規則が名指しした項目を
 * 一覧から伏せるのは呼び出し側**(`sort` の 400 と同じ `scrubHiddenFieldIds`)。
 */
export function parseListGroupBy(
  table: Table,
  field: string | null,
  granularity: string | null,
): { ok: true; value: ListGroupKey | undefined } | { ok: false; errors: ValidationError[] } {
  if (field === null) {
    if (granularity === null) {
      return { ok: true, value: undefined };
    }
    return {
      ok: false,
      errors: [
        {
          path: "/granularity",
          message:
            "granularity は group_by と一緒に指定してください(group_by なしの granularity は効きません)。",
          hint: "束ねる項目を group_by=<field_id> で指定してください。",
        },
      ],
    };
  }
  const groupable = table.fields.filter((candidate) =>
    LIST_GROUPABLE_TYPES.includes(candidate.type),
  );
  const target = table.fields.find((candidate) => candidate.id === field);
  if (target === undefined || !LIST_GROUPABLE_TYPES.includes(target.type)) {
    return {
      ok: false,
      errors: [
        {
          path: "/group_by",
          message:
            target === undefined
              ? `束ねるキー(group_by)に指定されたフィールド "${field}" はテーブル "${table.id}" に存在しません。`
              : `束ねるキー(group_by)に指定されたフィールド "${field}" は ${target.type} 型です。束ねられるのは select / reference / boolean / date だけです。`,
          allowed_values: groupable.map((candidate) => candidate.id),
          hint: "select / reference / boolean / date のフィールドを指定してください。",
        },
      ],
    };
  }
  if (granularity !== null && !(GRANULARITIES as readonly string[]).includes(granularity)) {
    return {
      ok: false,
      errors: [
        {
          path: "/granularity",
          message: `granularity の値 "${granularity}" は束ね方の語彙ではありません。`,
          allowed_values: [...GRANULARITIES],
          hint: "day / week / month のいずれかを指定してください(週は月曜始まり)。",
        },
      ],
    };
  }
  if (target.type === "date" && granularity === null) {
    return {
      ok: false,
      errors: [
        {
          path: "/granularity",
          message: `date 型のフィールド "${field}" で束ねるときは、束ね方(granularity)を必ず指定してください。`,
          allowed_values: [...GRANULARITIES],
          hint: "day / week / month のいずれかを指定してください(書かないと日付が1つ違うだけで別の群になります)。",
        },
      ],
    };
  }
  if (target.type !== "date" && granularity !== null) {
    return {
      ok: false,
      errors: [
        {
          path: "/granularity",
          message: `束ね方(granularity)を指定できるのは date 型のフィールドだけです。"${field}" は ${target.type} 型です。`,
          hint: "granularity を外すか、date 型のフィールドを指定してください。",
        },
      ],
    };
  }
  return {
    ok: true,
    value: granularity === null ? { field } : { field, granularity: granularity as Granularity },
  };
}

/**
 * **1行の群の値。** 日付は `truncateToGranularity`(`report.ts` の1本)で丸める。
 * **値が無い・読めない値は `null`**(群から落とさない。値が無い群として最後に並ぶ)。
 */
export function listGroupKey(row: Record<string, unknown>, groupBy: ListGroupKey): RecordValue {
  const raw = row[groupBy.field];
  const value: RecordValue =
    raw === undefined ||
    raw === null ||
    (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean")
      ? null
      : raw;
  if (groupBy.granularity === undefined) {
    return value;
  }
  return truncateToGranularity(value, groupBy.granularity);
}

/**
 * **行を群の値の昇順に安定ソートした新しい配列を返す**(元の配列は変えない)。
 * 同じ群の中は渡された順のまま。値が無い群は最後。
 */
export function orderRowsByListGroup<T extends Record<string, unknown>>(
  rows: readonly T[],
  groupBy: ListGroupKey,
): T[] {
  return rows
    .map((row, index) => ({ row, index, key: listGroupKey(row, groupBy) }))
    .sort((left, right) => compareGroupValue(left.key, right.key) || left.index - right.index)
    .map((entry) => entry.row);
}
