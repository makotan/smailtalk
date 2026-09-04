/**
 * **参照 EC の起動出力から、プラットフォームの説明文だけを取り出して業種依存語を数える**
 * (`V5-M18` / `G-G21` / `D-V5-24`)。
 *
 * ## 何を測っているか(**先に書く。誇張しない**)
 *
 * - 測るのは **`PLATFORM_NOTES` の7本の文字列に、あらかじめ決めた業種依存語が1件も
 *   現れないこと**だけである。照合器は `scripts/industry-words.ts` の `findIndustryWords`
 *   をそのまま使う(`V5-M13` 面1 と `V5-M14` 面5 が使っているものと同じ1本)。
 * - **語の一覧は網羅ではない。** `FACE1`(10語)と `FACE5`(24語)を合わせた集合であり、
 *   04 §4-1 / §4-5 の逐語に実際に現れていた語だけである。
 * - **これは「業種に依存しない」ことの証明ではない。** 字面を避けて書かれた業種前提は
 *   1件も拾えない。**代理である**(`V5-M13-T02` が置いた代理と同じ性格のもの)。
 * - **参照 EC の他の文字列は1つも見ていない。** テーブル名(`product` / `order` / `cart`)も
 *   ビュー名(「商品一覧」)も、**アプリが自分の業種の言葉で名付けたものであって、
 *   プラットフォームの文言ではない** —— そこに業種の言葉が在るのは問題ではない
 *   (04 §5-2 の 4 / 本タスクの指示の逐語「**EC であること自体は問題ではない**」)。
 *
 * ## 何を測っていないか
 *
 * - **`scripts/ref-ec/manifest.ts` のコメントを1文字も見ていない。** あそこは
 *   このアプリの宣言の説明であり、業種の言葉で書かれていて当然である。
 * - **`formatStartupReport` が組む出力全体を見ていない** —— 出力にはビュー名と表名が載る。
 *   見ているのは `PLATFORM_NOTES` の7本と、「その7本が実際に出力に載っていること」だけである。
 */
import { describe, expect, test } from "bun:test";
import {
  FACE1_INDUSTRY_WORDS,
  FACE5_INDUSTRY_WORDS,
  findIndustryWords,
} from "../industry-words.ts";
import { referenceEcManifest } from "./manifest.ts";
import { manualWorkflowIds, PLATFORM_NOTES } from "./serve.ts";

/** `FACE1` と `FACE5` を合わせた集合(重複は1回だけ)。**1語も減らしていない。** */
const ALL_INDUSTRY_WORDS = [...new Set([...FACE1_INDUSTRY_WORDS, ...FACE5_INDUSTRY_WORDS])];

describe("V5-M18 / G-G21: プラットフォームの説明文に業種依存語を置かない", () => {
  test("語の集合は FACE1(10) + FACE5(24) の和で、重複を除いて実数で固定する", () => {
    expect(FACE1_INDUSTRY_WORDS.length).toBe(10);
    expect(FACE5_INDUSTRY_WORDS.length).toBe(24);
    // 重複する語(注文 / カート / 顧客 / 買い物 / ポイント)は5語なので 10 + 24 - 5 = 29。
    expect(ALL_INDUSTRY_WORDS.length).toBe(29);
  });

  test("PLATFORM_NOTES は7本ある(数を丸めない)", () => {
    // **【`V8-M20` / 台帳 `J-G29` / `ADR-0301`】7本目の名前だけが変わった。本数は7のまま。**
    // **旧の逐語**: 最後の要素は `"audienceIsNotPermission"` だった
    // (説明文は「見せる相手の宣言(audience)は…」で始まっていた)。
    // **新**: `"roleRulesAreNotJustDisplay"`(説明文は「役割の規則(roles の rules)は…」)。
    // **3本目の `adminReadable` は名前も本文も残っている** —— メインが `serve.ts` で
    // 書き直したのは7本目だけである。
    expect(Object.keys(PLATFORM_NOTES)).toEqual([
      "firstUserIsOwner",
      "ownerScope",
      "adminReadable",
      "scheduleOnly",
      "outboundDestination",
      "manualTrigger",
      "roleRulesAreNotJustDisplay",
    ]);
  });

  for (const [key, note] of Object.entries(PLATFORM_NOTES)) {
    test(`PLATFORM_NOTES.${key} に業種依存語が1語も現れない`, () => {
      expect(findIndustryWords(note, ALL_INDUSTRY_WORDS)).toEqual([]);
    });
  }

  test("起動時の出力に書くワークフロー名は、マニフェストから引く(手で書き写さない)", () => {
    // **`V5-M18` は実際に起動して、出力に古いワークフロー名が残っているのを踏んだ。**
    // **手で書き写した名前は、実装で名前を変えた瞬間に嘘になる。**
    expect(manualWorkflowIds(referenceEcManifest())).toEqual([
      "wf-cart-close",
      "wf-product-archive",
    ]);
  });

  test("【対照】このアプリ自身の言葉には業種依存語が現れる —— 検査が空振りしていないことの確認", () => {
    // **参照 EC は EC なので、アプリの言葉に業種の語が在るのは正しい。**
    // この1本が緑であることは、上の7本の緑が「照合器が何も拾えていないだけ」ではないことを示す。
    expect(
      findIndustryWords("商品一覧から買い物かごに入れて会計する", ALL_INDUSTRY_WORDS),
    ).not.toEqual([]);
  });
});
