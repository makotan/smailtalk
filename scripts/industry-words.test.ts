/**
 * `V5-M14-T02`(汎用化の軸・面5): **業種依存語の照合器**の検査。
 *
 * ## なぜこのモジュールを切り出したか(**面1 の自己申告への対処**)
 *
 * `V5-M13`(面1)は禁止語10語の単純な `includes` を代理検査に使い、**その代理が雑である
 * ことを自分で申告した** —— 逐語(`docs/plan/v5/records/v5-m13.md` §9 の 2):
 * 「**禁止語の1つ「ポイント」は「エンドポイント」に誤って当たる。**」
 *
 * **面1 では画面に描かれる文字列だけを見ていたので、この誤検出は判定に影響しなかった。**
 * **面5(`G-G15`〜`G-G19`)が見るのはコメント・説明文・スキーマ注釈であり、そこには
 * 「エンドポイント」が実際に現れる。** **直さずに使い回すと面5 の判定が壊れる。**
 *
 * 直したのは次の2点である:
 *  1. **複合語の除外**(`エンドポイント` などに含まれる `ポイント` を数えない)。
 *  2. **ASCII 語の語境界**(`stock_move` の中の `stock` を単独出現として数えない)。
 *
 * **語の一覧そのものは減らしていない** —— 面1 の10語は `FACE1_INDUSTRY_WORDS` に
 * 1語も欠けずに入っている(下の検査が固定する)。
 */
import { describe, expect, test } from "bun:test";
import {
  FACE1_INDUSTRY_WORDS,
  FACE5_INDUSTRY_WORDS,
  FALSE_POSITIVE_COMPOUNDS,
  findIndustryWords,
} from "./industry-words.ts";

describe("面1 の10語を1語も減らしていない", () => {
  test("`V5-M13` が使った10語がそのまま入っている", () => {
    expect([...FACE1_INDUSTRY_WORDS]).toEqual([
      "買い物",
      "お買い物",
      "買い物客",
      "顧客",
      "お店",
      "店員",
      "お客さま",
      "注文",
      "カート",
      "ポイント",
    ]);
  });
});

describe("誤検出を直した(面1 の §9 の 2)", () => {
  test("「エンドポイント」は「ポイント」に当たらない(**面1 が当たると申告した誤検出**)", () => {
    expect(findIndustryWords("受信のエンドポイントを発行する", FACE1_INDUSTRY_WORDS)).toEqual([]);
  });

  test("「ポイントを積む」は今日も当たる(除外しすぎていない)", () => {
    expect(findIndustryWords("注文の持ち主としてポイントを積む", FACE1_INDUSTRY_WORDS)).toEqual([
      "注文",
      "ポイント",
    ]);
  });

  test("「解決済み payload」は「決済」に当たらない(**`V5-M14` が実測で踏んだ2件目**)", () => {
    // `src/kernel/workflow-runner.ts:929` の逐語。**面1 の10語には「決済」が無いので、
    // 面1 では踏みようがなかった誤検出である。**
    expect(
      findIndustryWords("送信内容(宛先 + 解決済み payload)を outbox に積むだけ", [
        ...FACE5_INDUSTRY_WORDS,
      ]),
    ).toEqual([]);
  });

  test("「決済サービス」は今日も当たる(除外しすぎていない)", () => {
    expect(findIndustryWords("決済サービスの署名形式", [...FACE5_INDUSTRY_WORDS])).toEqual([
      "決済",
    ]);
  });

  test("除外語の一覧は空でなく、すべて禁止語のどれかを含む複合語である", () => {
    expect(FALSE_POSITIVE_COMPOUNDS.length).toBeGreaterThan(0);
    const all = [...FACE1_INDUSTRY_WORDS, ...FACE5_INDUSTRY_WORDS];
    for (const compound of FALSE_POSITIVE_COMPOUNDS) {
      expect(
        all.some((w) => compound.includes(w)),
        compound,
      ).toBe(true);
    }
  });
});

describe("ASCII 語は語境界で照合する", () => {
  test("`stock_move` の中の `stock` は単独出現として数えない", () => {
    expect(findIndustryWords('"table": "stock_move"', FACE5_INDUSTRY_WORDS)).toEqual([
      "stock_move",
    ]);
  });

  test("`border` の中の `order` は数えない", () => {
    expect(findIndustryWords("border-radius: 4px", FACE5_INDUSTRY_WORDS)).toEqual([]);
  });

  test("`order 1行` の `order` は数える", () => {
    expect(findIndustryWords("order 1行 + 明細 N行", FACE5_INDUSTRY_WORDS)).toEqual([
      "明細",
      "order",
    ]);
  });
});

describe("件数を丸めない(1件目で止めない)", () => {
  test("複数当たったら全部返す", () => {
    expect(findIndustryWords("在庫と注文と商品", FACE5_INDUSTRY_WORDS)).toEqual([
      "在庫",
      "注文",
      "商品",
    ]);
  });

  test("同じ語が2回出ても一覧には1回だけ入る(語の集合を返す)", () => {
    expect(findIndustryWords("在庫と在庫", FACE5_INDUSTRY_WORDS)).toEqual(["在庫"]);
  });
});

describe("面5 の語の一覧", () => {
  test("面1 の10語のうち面5 でも使うものが落ちていない", () => {
    for (const word of ["顧客", "注文", "カート", "ポイント", "買い物"]) {
      expect(FACE5_INDUSTRY_WORDS as readonly string[], word).toContain(word);
    }
  });

  test("重複が1つも無い", () => {
    expect(new Set(FACE5_INDUSTRY_WORDS).size).toBe(FACE5_INDUSTRY_WORDS.length);
    expect(new Set(FACE1_INDUSTRY_WORDS).size).toBe(FACE1_INDUSTRY_WORDS.length);
  });
});
