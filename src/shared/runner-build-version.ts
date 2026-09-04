/**
 * Runner のイメージのビルド単位の版(`V5-M5-T03` / `R-G2` /
 * [`ADR-0251`](../../docs/adr/0251-runner-build-version.md))。
 *
 * ## これは何の版か
 *
 * **`D-V5-12` の逐語「Runnerの作成単位でバージョンを起きたいです」の「作成単位」である。**
 * `_changelog` の `seq` でも `diff_id` でもない —— **マニフェストが1バイトも変わらずに
 * `src/` のコードだけが変わる差し替え**(`D-V5-4`)では `seq` も `diff_id` も動かないので、
 * 「このボリュームは新しい Runner で動かせるか」を判定できない(`ADR-0251` §3 の回答1)。
 *
 * ## 置き場は1箇所だけである(`ADR-0251` 限定1 / 限定2)
 *
 * **値の置き場は SQLite ファイルヘッダの `PRAGMA user_version`(32bit 符号付き整数)だけ。**
 * `schemas/` に0バイト、`$defs/app` に `version` を新設しない、テーブルを1本も作らない、
 * 予約規約フィールドを1本も足さない。**アプリごとに別の版を持たない。**
 * 宣言がこの1箇所だけであることは `runner-build-version.test.ts` が固定する。
 *
 * ## `src/kernel/` に置かない理由
 *
 * `src/kernel/` に export を1本足すと `ADR-0007` §1b の **Δ8 が発火する**
 * (`scripts/kernel-export-drift.test.ts`)。この定数は `src/kernel/`(刻む側)と
 * `src/server/`(照合する側)の両方から要る。**`src/kernel/` から `src/shared/` への
 * 値 import は既に8ファイルで行われている**(`system-tables.ts` / `files-table.ts`)ので、
 * ここは既存の向きに乗るだけであり、新しい層またぎを作らない。
 *
 * ## 版を上げるとき
 *
 * **この数字を1つ増やす。** そのイメージは、増やす前の版が刻まれたボリュームでは
 * 起動しなくなる(`ADR-0251` 限定5。fail-closed)。**移行の手段は `V5-M6` が持つ。**
 */

/**
 * Runner のイメージのビルド単位の版。**単調増加の整数1本**(`ADR-0251` 限定3)。
 *
 * **0 は使わない。** `PRAGMA user_version` の既定値が 0 であり、**0 は「印が無い」を
 * 意味する**(`ADR-0251` 限定6)。版として 0 を使うと、印の無い DB が素通りする。
 *
 * **1 は「版の仕組みが入った最初の Runner」である。**
 */
export const RUNNER_BUILD_VERSION = 1;

/**
 * ボリュームに刻まれた版が、この Runner のイメージの版と**等しいか**を返す。
 *
 * **判定は1つだけである**(`ADR-0251` 限定4)。「以上なら通す」「メジャーが同じなら通す」
 * 「互換範囲」を1つも作らない —— **作りたくなったら `ADR-0251` §6 の 2 により門A を
 * 新規に通すこと。本 ADR を根拠にできない。**
 *
 * **本体に分岐が1本も無いことを `runner-build-version.test.ts` が固定している。**
 */
export function matchesRunnerBuildVersion(actual: number): boolean {
  return actual === RUNNER_BUILD_VERSION;
}
