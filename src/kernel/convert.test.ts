/**
 * 変換マトリクス(ADR-0010 §5b / §5c)の網羅テスト(V1-M1-T03)。
 *
 * 計画書 §V1-M1-T03 の検証方法「変換マトリクス網羅テスト」の本体である。
 * **49セル(7型 × 7型)すべてに期待値を書く。** 「代表例だけ」にすると、
 * ADR が「不」に倒した10セルのうちどれかが黙って「条」になっても気付けない。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type ConversionVerdict,
  checkFieldConversions,
  conversionLayer,
  conversionVerdict,
  convertValue,
  type FieldConversion,
  UNCONVERTIBLE_SAMPLE_LIMIT,
} from "./convert.ts";
import { sqliteTypeForFieldType } from "./ddl.ts";
import { FIELD_TYPES, type Field, type FieldType } from "./types.ts";

/**
 * ADR-0010 §5b のマトリクスを**そのまま**書き写した表。
 *
 * 実装(`conversionVerdict`)が正でこの表が写しである、という向きにしないこと。
 * ADR が正であり、実装がずれたらこのテストが赤くなるのが正しい向きである
 * (ADR-0010 Status:「食い違ったときに正なのは実装ではなく本 ADR」)。
 *
 * 凡例: `y` = 可 / `c` = 条 / `n` = 不 / `-` = 対角(同一型)
 */
const ADR_MATRIX: Record<FieldType, Record<FieldType, "y" | "c" | "n" | "-">> = {
  //          text long_text number boolean date select reference image
  // image が絡む非対角セルはすべて "n"(変換不可。V2-M2 / ADR-0035 §3 限定2)。
  // image → image だけは対角なので "-"(変換しない no-op)。
  text: {
    text: "-",
    long_text: "y",
    number: "c",
    boolean: "c",
    date: "c",
    select: "c",
    reference: "c",
    image: "n",
    file: "n",
  },
  long_text: {
    text: "y",
    long_text: "-",
    number: "c",
    boolean: "c",
    date: "c",
    select: "c",
    reference: "c",
    image: "n",
    file: "n",
  },
  number: {
    text: "y",
    long_text: "y",
    number: "-",
    boolean: "c",
    date: "n",
    select: "c",
    reference: "n",
    image: "n",
    file: "n",
  },
  boolean: {
    text: "y",
    long_text: "y",
    number: "y",
    boolean: "-",
    date: "n",
    select: "c",
    reference: "n",
    image: "n",
    file: "n",
  },
  date: {
    text: "y",
    long_text: "y",
    number: "n",
    boolean: "n",
    date: "-",
    select: "c",
    reference: "n",
    image: "n",
    file: "n",
  },
  select: {
    text: "y",
    long_text: "y",
    number: "c",
    boolean: "c",
    date: "c",
    select: "-",
    reference: "c",
    image: "n",
    file: "n",
  },
  reference: {
    text: "y",
    long_text: "y",
    number: "n",
    boolean: "n",
    date: "n",
    select: "c",
    reference: "-",
    image: "n",
    file: "n",
  },
  image: {
    text: "n",
    long_text: "n",
    number: "n",
    boolean: "n",
    date: "n",
    select: "n",
    reference: "n",
    image: "-",
    file: "n",
  },
  // **file(V5-M16 / ADR-0161 限定3)**。image と同じく非対角はすべて "n"。
  // **image ⇄ file も "n" である** —— 列型は同じ TEXT だが、受け入れる種別・上限・
  // 配信の形が違うので入れ替えを通さない(`convert.ts` の MATRIX の file 行を参照)。
  file: {
    text: "n",
    long_text: "n",
    number: "n",
    boolean: "n",
    date: "n",
    select: "n",
    reference: "n",
    image: "n",
    file: "-",
  },
};

/** ADR-0010 §5b のセルの右肩 `¹`/`²`(層)を書き写した表。 */
// image は SQLite 列型 TEXT(reference と同じ)。TEXT 系どうしは層1、NUMERIC/INTEGER が
// 絡めば層2 になる(V2-M2 / ADR-0035)。
const ADR_LAYER: Record<FieldType, Record<FieldType, 1 | 2>> = {
  text: {
    text: 1,
    long_text: 1,
    number: 2,
    boolean: 2,
    date: 1,
    select: 1,
    reference: 1,
    image: 1,
    file: 1,
  },
  long_text: {
    text: 1,
    long_text: 1,
    number: 2,
    boolean: 2,
    date: 1,
    select: 1,
    reference: 1,
    image: 1,
    file: 1,
  },
  number: {
    text: 2,
    long_text: 2,
    number: 1,
    boolean: 2,
    date: 2,
    select: 2,
    reference: 2,
    image: 2,
    file: 2,
  },
  boolean: {
    text: 2,
    long_text: 2,
    number: 2,
    boolean: 1,
    date: 2,
    select: 2,
    reference: 2,
    image: 2,
    file: 2,
  },
  date: {
    text: 1,
    long_text: 1,
    number: 2,
    boolean: 2,
    date: 1,
    select: 1,
    reference: 1,
    image: 1,
    file: 1,
  },
  select: {
    text: 1,
    long_text: 1,
    number: 2,
    boolean: 2,
    date: 1,
    select: 1,
    reference: 1,
    image: 1,
    file: 1,
  },
  reference: {
    text: 1,
    long_text: 1,
    number: 2,
    boolean: 2,
    date: 1,
    select: 1,
    reference: 1,
    image: 1,
    file: 1,
  },
  image: {
    text: 1,
    long_text: 1,
    number: 2,
    boolean: 2,
    date: 1,
    select: 1,
    reference: 1,
    image: 1,
    file: 1,
  },
  // file も SQLite 列型は TEXT なので、層の割り当ては image と1つも違わない
  // (V5-M16 / ADR-0161 限定3)。
  file: {
    text: 1,
    long_text: 1,
    number: 2,
    boolean: 2,
    date: 1,
    select: 1,
    reference: 1,
    image: 1,
    file: 1,
  },
};

const EXPECTED: Record<"y" | "c" | "n" | "-", ConversionVerdict> = {
  y: "possible",
  c: "conditional",
  n: "impossible",
  "-": "possible",
};

/** 型からテスト用のフィールド定義を作る(select / reference は既定の付帯情報を付ける)。 */
function field(type: FieldType, extra: Partial<Field> = {}): Field {
  const base = { id: "f", name: "F" };
  if (type === "select") {
    return { ...base, type, options: ["a", "b"], ...extra } as Field;
  }
  if (type === "reference") {
    return { ...base, type, reference_table: "others", ...extra } as Field;
  }
  return { ...base, type, ...extra } as Field;
}

describe("変換マトリクス: 81セルすべてが ADR-0010 §5b + ADR-0035(image)+ ADR-0161(file)どおりである", () => {
  for (const from of FIELD_TYPES) {
    for (const to of FIELD_TYPES) {
      test(`${from} → ${to} は ${EXPECTED[ADR_MATRIX[from][to]]}`, () => {
        expect(conversionVerdict(from, to)).toBe(EXPECTED[ADR_MATRIX[from][to]]);
      });
    }
  }

  test("網羅の件数が ADR の内訳と一致する(可13 / 条19 / 不40 / 対角9)", () => {
    // V2-M2 / ADR-0035: image 追加で対角7→8、image が絡む非対角14セルがすべて "不" に
    // 入るので 不10→24。可 / 条は image が1つも増やさないので不変。
    // **【V5-M16 / ADR-0161】file 追加で対角8→9、file が絡む非対角16セルがすべて "不" に
    // 入るので 不24→40(セル総数は 64 → 81)。可 / 条は file も1つも増やさない。**
    const counts = { possible: 0, conditional: 0, impossible: 0 };
    let diagonal = 0;
    for (const from of FIELD_TYPES) {
      for (const to of FIELD_TYPES) {
        if (from === to) {
          diagonal += 1;
          continue;
        }
        counts[conversionVerdict(from, to)] += 1;
      }
    }
    expect(diagonal).toBe(9);
    expect(counts).toEqual({ possible: 13, conditional: 19, impossible: 40 });
  });
});

describe("層の判定は SQLite 列型の一致から導かれる(ADR-0010 §5a)", () => {
  for (const from of FIELD_TYPES) {
    for (const to of FIELD_TYPES) {
      test(`${from} → ${to} は層${ADR_LAYER[from][to]}`, () => {
        expect(conversionLayer(from, to)).toBe(ADR_LAYER[from][to]);
      });
    }
  }

  test("層は sqliteTypeForFieldType の一致とちょうど対応する(表を二重に持たない)", () => {
    for (const from of FIELD_TYPES) {
      for (const to of FIELD_TYPES) {
        const same = sqliteTypeForFieldType(from) === sqliteTypeForFieldType(to);
        expect(conversionLayer(from, to)).toBe(same ? 1 : 2);
      }
    }
  });

  /**
   * **ADR-0010 §5a の内訳「層1 = 25組 / 層2 = 24組」は実測と食い違う。実測は 27 / 22 である。**
   *
   * 食い違いの中身(セル単位の判定は1つもずれていない。**総数の数え方だけがずれている**):
   *
   * - ADR は層1 を「`text` ↔ `long_text` ↔ `select` ↔ `date` ↔ `reference` の相互変換25組」
   *   と書いており、**`number` → `number` と `boolean` → `boolean`(同一型どうし = DDL 無操作)
   *   を数え落としている。** この2セルを足すと 27 になる。
   * - ADR は層2 を「`number` / `boolean` が絡む変換24組」と書くが、
   *   **非対角で `number` または `boolean` が絡むセルは 22 である**(42 − 20)。
   *   ADR の 24 は、上の2セルを層2 側に入れて 25 + 24 = 49 に合わせた結果と読める。
   *
   * **実装は変えない。**`number` → `number` は SQLite 列型が変わらないので再構築が要らず、
   * 層1 が正しい(ADR §5a の層の定義「変換元と変換先が同じ SQLite 列型」に照らして
   * 実装のほうが定義に忠実である)。**ADR-0010 §9 限界1 が「食い違ったら本 ADR を改訂すること。
   * 実装に合わせて黙って読み替えない」と定めているため、本件は記録 §2 に申告して
   * ADR の改訂に回す。**
   */
  test("層1は51組、層2は30組(V5-M16 / ADR-0161 で file=TEXT を追加)", () => {
    // TEXT 群は {text, long_text, select, date, reference, image, file} の7型になった
    // (**V5-M16 / ADR-0161 で file 追加**)。
    // 層1 = 同一 SQLite 列型の組 = 7² + 1²(number) + 1²(boolean) = 51。層2 = 81 − 51 = 30。
    // (file 前は TEXT 群6型で 6²+1+1 = 38 / 64−38 = 26 だった。
    //  image 前は TEXT 群5型で 5²+1+1 = 27 / 49−27 = 22 だった。)
    let layer1 = 0;
    let layer2 = 0;
    for (const from of FIELD_TYPES) {
      for (const to of FIELD_TYPES) {
        if (conversionLayer(from, to) === 1) {
          layer1 += 1;
        } else {
          layer2 += 1;
        }
      }
    }
    expect({ layer1, layer2 }).toEqual({ layer1: 51, layer2: 30 });
  });
});

describe("値の変換(条件付きセルの境界)", () => {
  test("null はどのセルでも変換不能値にならない(ADR-0010 §5b 注意1)", () => {
    for (const from of FIELD_TYPES) {
      for (const to of FIELD_TYPES) {
        if (conversionVerdict(from, to) === "impossible") {
          continue;
        }
        const result = convertValue(null, field(from), field(to), new Set());
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBeNull();
        }
      }
    }
  });

  test("text → number は数値としてパースできる場合のみ", () => {
    const from = field("text");
    const to = field("number");
    expect(convertValue("42", from, to)).toEqual({ ok: true, value: 42 });
    expect(convertValue("3.5", from, to)).toEqual({ ok: true, value: 3.5 });
    expect(convertValue("-1", from, to)).toEqual({ ok: true, value: -1 });
    expect(convertValue("abc", from, to).ok).toBe(false);
    expect(convertValue("", from, to).ok).toBe(false);
    expect(convertValue(" ", from, to).ok).toBe(false);
    // Number("Infinity") は有限でないので受けない。
    expect(convertValue("Infinity", from, to).ok).toBe(false);
  });

  test('text → boolean は "true" / "false" だけ(ADR-0010 §5b 注意3)', () => {
    const from = field("text");
    const to = field("boolean");
    expect(convertValue("true", from, to)).toEqual({ ok: true, value: 1 });
    expect(convertValue("false", from, to)).toEqual({ ok: true, value: 0 });
    // 広げない。広げるなら ADR を改訂する。
    for (const rejected of ["1", "0", "yes", "no", "はい", "TRUE", "True"]) {
      expect(convertValue(rejected, from, to).ok).toBe(false);
    }
  });

  test("text → date は ISO8601 としてパースできる場合のみ", () => {
    const from = field("text");
    const to = field("date");
    expect(convertValue("2026-07-19", from, to)).toEqual({ ok: true, value: "2026-07-19" });
    expect(convertValue("2026-07-19T10:00:00Z", from, to).ok).toBe(true);
    expect(convertValue("19/07/2026", from, to).ok).toBe(false);
    expect(convertValue("not a date", from, to).ok).toBe(false);
    expect(convertValue("2026-13-01", from, to).ok).toBe(false);
  });

  test("text → select は値が options に含まれる場合のみ", () => {
    const from = field("text");
    const to = field("select", { options: ["未読", "読了"] });
    expect(convertValue("読了", from, to)).toEqual({ ok: true, value: "読了" });
    expect(convertValue("積読", from, to).ok).toBe(false);
  });

  test("number → boolean は 0 / 1 のみ", () => {
    const from = field("number");
    const to = field("boolean");
    expect(convertValue(0, from, to)).toEqual({ ok: true, value: 0 });
    expect(convertValue(1, from, to)).toEqual({ ok: true, value: 1 });
    expect(convertValue(2, from, to).ok).toBe(false);
    expect(convertValue(-1, from, to).ok).toBe(false);
    expect(convertValue(0.5, from, to).ok).toBe(false);
  });

  test("boolean → number / text は無条件(可)", () => {
    expect(convertValue(1, field("boolean"), field("number"))).toEqual({ ok: true, value: 1 });
    expect(convertValue(0, field("boolean"), field("number"))).toEqual({ ok: true, value: 0 });
    expect(convertValue(1, field("boolean"), field("text"))).toEqual({ ok: true, value: "true" });
    expect(convertValue(0, field("boolean"), field("text"))).toEqual({ ok: true, value: "false" });
  });

  test("number → text は数値の文字列表現になる", () => {
    expect(convertValue(42, field("number"), field("text"))).toEqual({ ok: true, value: "42" });
    expect(convertValue(3.5, field("number"), field("long_text"))).toEqual({
      ok: true,
      value: "3.5",
    });
  });

  test("number → select は数値の文字列表現が options にある場合のみ", () => {
    const to = field("select", { options: ["1", "2"] });
    expect(convertValue(1, field("number"), to)).toEqual({ ok: true, value: "1" });
    expect(convertValue(3, field("number"), to).ok).toBe(false);
  });

  test('boolean → select は "true" / "false" が options にある場合のみ', () => {
    const ok = field("select", { options: ["true", "false"] });
    expect(convertValue(1, field("boolean"), ok)).toEqual({ ok: true, value: "true" });
    const ng = field("select", { options: ["はい", "いいえ"] });
    expect(convertValue(1, field("boolean"), ng).ok).toBe(false);
  });

  test("select → text / long_text は無条件(可)。値は1バイトも変わらない", () => {
    const from = field("select", { options: ["未読", "読了"] });
    expect(convertValue("読了", from, field("text"))).toEqual({ ok: true, value: "読了" });
  });

  test("text → reference は値が参照先の実在する _id である場合のみ", () => {
    const from = field("text");
    const to = field("reference", { reference_table: "authors" });
    const ids = new Set(["a-1", "a-2"]);
    expect(convertValue("a-1", from, to, ids)).toEqual({ ok: true, value: "a-1" });
    expect(convertValue("a-9", from, to, ids).ok).toBe(false);
  });

  test("不能セルは値を問わず変換できない", () => {
    expect(convertValue(1, field("number"), field("date")).ok).toBe(false);
    expect(convertValue("2026-07-19", field("date"), field("number")).ok).toBe(false);
    expect(convertValue("x", field("reference"), field("date")).ok).toBe(false);
  });
});

describe("制約の変更(ADR-0010 §5c)", () => {
  test("required: false → true は既存行に空値があると変換不能", () => {
    const from = field("text", { required: false });
    const to = field("text", { required: true });
    expect(convertValue("値", from, to).ok).toBe(true);
    expect(convertValue(null, from, to).ok).toBe(false);
    // isMissingValue と同じ判定 —— 空白のみも違反(T01 §1-4 S3(3) の申告どおり)。
    expect(convertValue("", from, to).ok).toBe(false);
    expect(convertValue("   ", from, to).ok).toBe(false);
  });

  test("required: true → false は無条件(可)", () => {
    const from = field("text", { required: true });
    const to = field("text", { required: false });
    expect(convertValue(null, from, to).ok).toBe(true);
  });

  test("options の追加は可、削除は条(削除される選択肢を持つ行があれば不能)", () => {
    const from = field("select", { options: ["未読", "読了"] });
    const added = field("select", { options: ["未読", "読了", "積読"] });
    expect(convertValue("読了", from, added).ok).toBe(true);

    const removed = field("select", { options: ["未読"] });
    expect(convertValue("未読", from, removed).ok).toBe(true);
    expect(convertValue("読了", from, removed).ok).toBe(false);
  });

  test("reference_table の変更は、既存の値が新しい参照先に実在する場合のみ", () => {
    const from = field("reference", { reference_table: "authors" });
    const to = field("reference", { reference_table: "publishers" });
    expect(convertValue("p-1", from, to, new Set(["p-1"])).ok).toBe(true);
    expect(convertValue("a-1", from, to, new Set(["p-1"])).ok).toBe(false);
  });

  test("name(表示名)だけの変更は値に影響しない", () => {
    const from = field("text", { name: "旧" });
    const to = field("text", { name: "新" });
    expect(convertValue("そのまま", from, to)).toEqual({ ok: true, value: "そのまま" });
  });
});

describe("checkFieldConversions: 全行走査して変換不能行を報告する(ADR-0010 §7 失敗4)", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`CREATE TABLE "books" ("_id" TEXT PRIMARY KEY, "qty" TEXT)`);
    db.exec(`CREATE TABLE "authors" ("_id" TEXT PRIMARY KEY)`);
    db.exec(`INSERT INTO "authors" ("_id") VALUES ('a-1')`);
  });

  afterEach(() => {
    db.close();
  });

  function seed(rows: [string, string | null][]): void {
    for (const [id, qty] of rows) {
      db.query(`INSERT INTO "books" ("_id", "qty") VALUES (?, ?)`).run(id, qty);
    }
  }

  function conversion(to: Field): FieldConversion {
    return {
      table: "books",
      field: "qty",
      from: field("text", { id: "qty", name: "数量" }),
      to,
      path: "/operations/0/changes",
    };
  }

  test("全行が変換できるならエラーは0件", () => {
    seed([
      ["b-1", "1"],
      ["b-2", "2"],
    ]);
    expect(checkFieldConversions(db, [conversion(field("number", { id: "qty" }))])).toEqual([]);
  });

  test("null 行があっても、required でなければ通る", () => {
    seed([
      ["b-1", "1"],
      ["b-2", null],
    ]);
    expect(checkFieldConversions(db, [conversion(field("number", { id: "qty" }))])).toEqual([]);
  });

  test("変換不能行があると、該当行の _id と実際の値を返す", () => {
    seed([
      ["b-1", "1"],
      ["b-2", "たくさん"],
    ]);
    const errors = checkFieldConversions(db, [conversion(field("number", { id: "qty" }))]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/operations/0/changes");
    expect(errors[0]?.message).toContain("b-2");
    expect(errors[0]?.message).toContain("たくさん");
    // 何件あるかは常に正確に伝える(サンプルが打ち切られても総数は嘘にしない)。
    expect(errors[0]?.message).toContain("1 件");
  });

  test("変換不能行が多いときはサンプルを打ち切るが、総数は正確に述べる", () => {
    const rows: [string, string | null][] = [];
    for (let i = 0; i < UNCONVERTIBLE_SAMPLE_LIMIT + 7; i += 1) {
      rows.push([`b-${i}`, "変換できない"]);
    }
    seed(rows);
    const errors = checkFieldConversions(db, [conversion(field("number", { id: "qty" }))]);
    expect(errors).toHaveLength(1);
    const message = errors[0]?.message ?? "";
    expect(message).toContain(`${UNCONVERTIBLE_SAMPLE_LIMIT + 7} 件`);
    // 打ち切ったことを黙らない(憲法6)。
    expect(message).toContain("ほか");
  });

  test("対象テーブルが存在しない(同じ差分で作られた)場合は走査しない", () => {
    const errors = checkFieldConversions(db, [
      {
        table: "not-created-yet",
        field: "qty",
        from: field("text", { id: "qty" }),
        to: field("number", { id: "qty" }),
        path: "/operations/0/changes",
      },
    ]);
    expect(errors).toEqual([]);
  });

  test("reference への変換は参照先テーブルの実在 _id を見る", () => {
    seed([
      ["b-1", "a-1"],
      ["b-2", "a-9"],
    ]);
    const errors = checkFieldConversions(db, [
      conversion(field("reference", { id: "qty", reference_table: "authors" })),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("a-9");
  });

  test("不能セルは1行も無くても拒否する(語彙として認めない)", () => {
    const errors = checkFieldConversions(db, [
      {
        table: "books",
        field: "qty",
        from: field("date", { id: "qty" }),
        to: field("number", { id: "qty" }),
        path: "/operations/0/changes",
      },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("date");
    expect(errors[0]?.message).toContain("number");
  });

  test("エラーは統一形式(path / message / hint)で返る", () => {
    seed([["b-1", "だめ"]]);
    const errors = checkFieldConversions(db, [conversion(field("number", { id: "qty" }))]);
    expect(typeof errors[0]?.path).toBe("string");
    expect(typeof errors[0]?.message).toBe("string");
    expect(typeof errors[0]?.hint).toBe("string");
    // ADR-0010 §6a: 「先に直してから改めて送る」以外の道を案内しない。
    expect(errors[0]?.hint).toContain("update_record");
  });
});
