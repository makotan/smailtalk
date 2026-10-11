/**
 * 一覧の束ねるキーの**読取の並び**(`V20-M4-T01`。メインの裁定 案A)。カーネル側の純関数。
 *
 * **条文**: `ADR-0470` / `ADR-0461`、`ADR-0339` 限定7(日付の丸めを2本目にしない)。
 *
 * ## このファイルが固定すること
 *
 * 1. 群の値は `report.ts` の `truncateToGranularity` そのもので丸める(**丸めの実装は1本のまま**)。
 *    日付表(週またぎ・年またぎ・日曜・月曜・閏日)で、手で書いた期待値と一致する。
 * 2. 並びは**安定ソート**である —— 群の値の昇順を第1キーにし、同じ群の中では渡された順
 *    (= SQL が利用者の sort で並べた順)を1つも崩さない。**値が無い群は最後**
 *    (集計表の `compareGroupValue` と同じ向き)。
 * 3. 読取の引数(`group_by=<項目>&granularity=<粒度>`)の値域の検査: 実在 / 型4種 /
 *    粒度3値 / date に必須 / date 以外に不可 / 粒度だけの指定は不可。
 * 4. **新しいファイルに SQL の丸めが1文字も無い**(`strftime` / `SELECT` / `ORDER BY` が0件)。
 */
import { expect, test } from "bun:test";
import { listGroupKey, orderRowsByListGroup, parseListGroupBy } from "./list-group-order.ts";
import { truncateToGranularity } from "./report.ts";
import type { Table } from "./types.ts";

const TABLE = {
  id: "orders",
  name: "注文",
  fields: [
    { id: "title", name: "件名", type: "text", required: true },
    { id: "amount", name: "金額", type: "number" },
    { id: "done", name: "済み", type: "boolean" },
    { id: "ordered_on", name: "注文日", type: "date" },
    { id: "category", name: "種類", type: "select", options: ["食品", "雑貨"] },
    { id: "customer", name: "顧客", type: "reference", reference_table: "customers" },
  ],
} as unknown as Table;

// ---------------------------------------------------------------------------
// (1) 日付の丸めは1本(truncateToGranularity)で、日付表と一致する
// ---------------------------------------------------------------------------

const DATE_TABLE: [string, string, string, string][] = [
  // [値, day, week(その週の月曜), month]
  ["2026-09-20", "2026-09-20", "2026-09-14", "2026-09"], // 日曜 → 前の月曜
  ["2026-09-21", "2026-09-21", "2026-09-21", "2026-09"], // 月曜 → その日
  ["2026-09-27", "2026-09-27", "2026-09-21", "2026-09"], // 日曜(週の最後)
  ["2026-09-28", "2026-09-28", "2026-09-28", "2026-09"], // 次の月曜(週またぎ)
  ["2026-10-01", "2026-10-01", "2026-09-28", "2026-10"], // 木曜。月をまたいで前月の月曜
  ["2026-12-31", "2026-12-31", "2026-12-28", "2026-12"], // 年末の木曜
  ["2027-01-03", "2027-01-03", "2026-12-28", "2027-01"], // 年始の日曜 → 前年の月曜(年またぎ)
  ["2027-01-04", "2027-01-04", "2027-01-04", "2027-01"], // 年始の月曜
  ["2028-02-29", "2028-02-29", "2028-02-28", "2028-02"], // 閏日(火曜)
  ["2028-03-05", "2028-03-05", "2028-02-28", "2028-03"], // 閏日を含む週の日曜
];

test("(1) 群の値は日付表の手書きの期待値と一致する(day / week(月曜始まり)/ month)", () => {
  for (const [value, day, week, month] of DATE_TABLE) {
    const row = { ordered_on: value };
    expect(listGroupKey(row, { field: "ordered_on", granularity: "day" }), value).toBe(day);
    expect(listGroupKey(row, { field: "ordered_on", granularity: "week" }), value).toBe(week);
    expect(listGroupKey(row, { field: "ordered_on", granularity: "month" }), value).toBe(month);
  }
});

test("(1) 群の値は truncateToGranularity と同じ値である(丸めの実装を2本持たない)", () => {
  for (const [value] of DATE_TABLE) {
    for (const granularity of ["day", "week", "month"] as const) {
      expect(listGroupKey({ ordered_on: value }, { field: "ordered_on", granularity })).toBe(
        truncateToGranularity(value, granularity),
      );
    }
  }
  // 値が無い・読めない値は null(群から落とさない)。
  expect(listGroupKey({ ordered_on: null }, { field: "ordered_on", granularity: "week" })).toBe(
    null,
  );
  expect(listGroupKey({}, { field: "category" })).toBe(null);
  // 日付でない項目は値そのもの。
  expect(listGroupKey({ category: "食品" }, { field: "category" })).toBe("食品");
  expect(listGroupKey({ done: false }, { field: "done" })).toBe(false);
});

test("(1) 新しいファイルに SQL の丸めが1文字も無い(strftime / SELECT / ORDER BY が0件)", async () => {
  const source = await Bun.file(new URL("./list-group-order.ts", import.meta.url)).text();
  const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  for (const forbidden of ["strftime", "SELECT", "ORDER BY", "julianday"]) {
    expect(
      code.filter((line) => line.includes(forbidden)),
      forbidden,
    ).toEqual([]);
  }
  // 丸めは report.ts の1本を呼ぶだけである(このファイルに丸めの関数を定義していない)。
  expect(code.filter((line) => /function\s+truncate/.test(line))).toEqual([]);
  expect(code.some((line) => line.includes("truncateToGranularity"))).toBe(true);
});

// ---------------------------------------------------------------------------
// (2) 安定ソート: 群の昇順が第1キー、群の中は渡された順のまま、値が無い群は最後
// ---------------------------------------------------------------------------

test("(2) 群の値の昇順に並べ、同じ群の中では渡された順を崩さない。値が無い群は最後", () => {
  const rows = [
    { _id: "1", category: "雑貨" },
    { _id: "2", category: null },
    { _id: "3", category: "食品" },
    { _id: "4", category: "雑貨" },
    { _id: "5" },
    { _id: "6", category: "食品" },
  ];
  const ordered = orderRowsByListGroup(rows, { field: "category" });
  // "雑貨"(U+96D1)< "食品"(U+98DF)。群の中は元の順(1→4 / 3→6 / 2→5)。
  expect(ordered.map((row) => row._id)).toEqual(["1", "4", "3", "6", "2", "5"]);
  // 元の配列は変えない。
  expect(rows.map((row) => row._id)).toEqual(["1", "2", "3", "4", "5", "6"]);
});

test("(2) 日付は丸めた値で並べる —— 同じ週の中では渡された順(利用者の sort)が効く", () => {
  // 渡された順 = 利用者が title の降順で並べた結果、と見立てる。
  const rows = [
    { _id: "z", ordered_on: "2026-09-22" }, // 週 09-21
    { _id: "y", ordered_on: "2026-09-15" }, // 週 09-14
    { _id: "x", ordered_on: "2026-09-27" }, // 週 09-21(日曜)
    { _id: "w", ordered_on: null },
    { _id: "v", ordered_on: "2026-09-14" }, // 週 09-14
  ];
  const ordered = orderRowsByListGroup(rows, { field: "ordered_on", granularity: "week" });
  expect(ordered.map((row) => row._id)).toEqual(["y", "v", "z", "x", "w"]);
});

test("(2) 真偽は偽 → 真 → 値なしの順", () => {
  const rows = [
    { _id: "1", done: true },
    { _id: "2", done: null },
    { _id: "3", done: false },
    { _id: "4", done: true },
  ];
  expect(orderRowsByListGroup(rows, { field: "done" }).map((row) => row._id)).toEqual([
    "3",
    "1",
    "4",
    "2",
  ]);
});

// ---------------------------------------------------------------------------
// (3) 読取の引数の値域
// ---------------------------------------------------------------------------

test("(3) 引数が無ければ束ねない(undefined)。在れば形に写す", () => {
  expect(parseListGroupBy(TABLE, null, null)).toEqual({ ok: true, value: undefined });
  expect(parseListGroupBy(TABLE, "category", null)).toEqual({
    ok: true,
    value: { field: "category" },
  });
  expect(parseListGroupBy(TABLE, "ordered_on", "month")).toEqual({
    ok: true,
    value: { field: "ordered_on", granularity: "month" },
  });
  for (const field of ["done", "customer"]) {
    expect(parseListGroupBy(TABLE, field, null).ok, field).toBe(true);
  }
});

function errorsOf(result: ReturnType<typeof parseListGroupBy>) {
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors;
}

test("(3) 実在しない項目・束ねられない型は /group_by のエラー(書ける項目の一覧つき)", () => {
  for (const field of ["nothing", "title", "amount", "_id", "_created_at"]) {
    const [error] = errorsOf(parseListGroupBy(TABLE, field, null));
    expect(error?.path, field).toBe("/group_by");
    expect(error?.allowed_values, field).toEqual(["done", "ordered_on", "category", "customer"]);
    expect(error?.hint, field).toBeDefined();
  }
});

test("(3) 粒度は3値だけ。date に必須、date 以外には書けない、粒度だけの指定もできない", () => {
  const [bad] = errorsOf(parseListGroupBy(TABLE, "ordered_on", "year"));
  expect(bad?.path).toBe("/granularity");
  expect(bad?.allowed_values).toEqual(["day", "week", "month"]);
  const [missing] = errorsOf(parseListGroupBy(TABLE, "ordered_on", null));
  expect(missing?.path).toBe("/granularity");
  expect(missing?.allowed_values).toEqual(["day", "week", "month"]);
  const [extra] = errorsOf(parseListGroupBy(TABLE, "category", "week"));
  expect(extra?.path).toBe("/granularity");
  const [alone] = errorsOf(parseListGroupBy(TABLE, null, "week"));
  expect(alone?.path).toBe("/granularity");
  expect(alone?.message).toContain("group_by");
  // 空文字は「指定なし」ではなく誤り(黙って束ねない形に化けさせない)。
  const [empty] = errorsOf(parseListGroupBy(TABLE, "", null));
  expect(empty?.path).toBe("/group_by");
});
