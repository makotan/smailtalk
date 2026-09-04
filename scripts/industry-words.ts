/**
 * **業種依存語の一覧と照合器**(`V5-M13` 面1 / `V5-M14` 面5 の共有)。
 *
 * 上位: `docs/plan/v5/04-generalization-baseline.md` §4-1(面1)/ §4-5(面5)/
 *       `docs/plan/v5/records/v5-m13.md` §9 の 2(**誤検出の自己申告**)/
 *       `docs/plan/v5/records/v5-m14.md` §3(本モジュールを切り出した経緯)。
 *
 * ## この照合器が測っているもの・測っていないもの(**先に書く。誇張しない**)
 *
 * - **測っているのは「あらかじめ決めた語が文字列に現れないこと」だけである。**
 *   **「業種に依存しない」ことの証明ではない。** 字面を避けて書かれた業種前提は1件も拾えない。
 * - **語の一覧は網羅ではない。** 04 §4-1 / §4-5 の逐語に実際に現れていた語だけを採った。
 *
 * ## 面1 が申告した誤検出を直した(**直さずに使い回さない**)
 *
 * `v5-m13.md` §9 の 2 の逐語: 「**禁止語の1つ「ポイント」は「エンドポイント」に誤って
 * 当たる。**」 面1 は画面に描かれる文字列だけを見ていたので判定に影響しなかったが、
 * **面5 が見るのはコメント・説明文・スキーマ注釈であり、そこには「エンドポイント」が
 * 実際に現れる**(受信 capability の説明)。直したのは2点:
 *
 *  1. **複合語の除外**(`FALSE_POSITIVE_COMPOUNDS`)—— 一致した範囲を先に伏せてから数える。
 *  2. **ASCII 語の語境界** —— `stock_move` の中の `stock` を単独出現として数えない。
 *
 * **語の一覧は1語も減らしていない。**
 */

/** 面1(`V5-M13`)が使った10語。**1語も減らさない**(`scripts/industry-words.test.ts` が固定)。 */
export const FACE1_INDUSTRY_WORDS = [
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
] as const;

/**
 * 面5(`V5-M14`)が使う語。**04 §4-5 の逐語に実際に現れていた語だけを採った。**
 *
 * 日本語を先に、コード上の識別子(例示として現れるもの)を後に並べる。
 * **並び順は `findIndustryWords` の戻り値の順序になる**(検査が `toEqual` で固定している)。
 */
export const FACE5_INDUSTRY_WORDS = [
  // --- 日本語 ---
  "在庫",
  "注文",
  "明細",
  "商品",
  "カート",
  "決済",
  "顧客",
  "買い物",
  "ポイント",
  "売り越し",
  "発送",
  "支払",
  "チェックアウト",
  // --- コード上の識別子(04 §4-5 の JSON 例・逐語に現れるもの)---
  "stock",
  "stock_move",
  "qty",
  "product",
  "order",
  "orders",
  "order_line",
  "cart",
  "checkout",
  "pending_payment",
  "placed_on",
] as const;

/**
 * **誤検出のもとになる複合語。** ここに一致した範囲は禁止語の出現として数えない。
 *
 * - **`エンドポイント`**: 面1 が実際に踏んだ誤検出である(`web/src/auth/LoginPage.tsx:5`。
 *   `v5-m13.md` §2-3 / §9 の 2)。
 * - **`解決済`**: **`V5-M14` が実測で踏んだ2件目である** ——
 *   `src/kernel/workflow-runner.ts:929` の逐語「解決済み payload」が「決済」に当たっていた。
 *   **面1 の10語には「決済」が無いので、面1 では踏みようがなかった。**
 * - **`エントリポイント` / `チェックポイント` / `ブレークポイント`**: 同型の複合語であり、
 *   **先回りで入れた。** **入れたことを隠さない**(実測で踏んだのは上の2語だけである)。
 */
export const FALSE_POSITIVE_COMPOUNDS = [
  "エンドポイント",
  "エントリポイント",
  "チェックポイント",
  "ブレークポイント",
  "解決済",
] as const;

/** ASCII だけで書かれた語か(語境界で照合する対象か)。 */
function isAsciiWord(word: string): boolean {
  return /^[\x21-\x7e]+$/.test(word);
}

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 複合語の一致範囲を伏せる(伏せ字は元の長さを保つので、位置がずれない)。
 *
 * **伏せ字に半角スペースを使う** —— 生の NUL バイトを使った初版は
 * `scripts/no-nul-bytes.test.ts` に落とされた(`v5-m14.md` §6-1 の 1)。
 */
function maskFalsePositives(text: string): string {
  let masked = text;
  for (const compound of FALSE_POSITIVE_COMPOUNDS) {
    masked = masked.split(compound).join(" ".repeat(compound.length));
  }
  return masked;
}

/**
 * `text` に現れた業種依存語を**一覧の並び順で全部返す**(1件目で止めない —— 件数を丸めないため)。
 *
 * - 同じ語が何回出ても、戻り値には1回だけ入る(**語の集合**であって出現回数ではない)。
 * - ASCII の語は語境界(`[A-Za-z0-9_]` に挟まれていないこと)で照合する。
 * - `FALSE_POSITIVE_COMPOUNDS` に一致した範囲は数えない。
 */
export function findIndustryWords(text: string, words: readonly string[]): string[] {
  const masked = maskFalsePositives(text);
  return words.filter((word) => {
    if (!isAsciiWord(word)) return masked.includes(word);
    return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(word)}(?![A-Za-z0-9_])`).test(masked);
  });
}
