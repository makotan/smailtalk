/**
 * 組み込みのテーマ候補(V3-M4-T01 / D-G7。**判定 = 将来送り・門外 Δ7**)。
 *
 * 判定の正は `docs/adr/0007-vocabulary-governance.md` §8 の 2026-07-26 の D-G7 の行と
 * `docs/plan/v3/records/v3-m4-gate-a-intake.md` §3、完了条件の正は
 * `docs/plan/v3/records/v3-m4.md` §2 の「V3-M4-T01」節である。
 *
 * ## 何であって、何でないか
 *
 * **これは「コードが持つ有限の表」である**(ユーザ決定 D-M4-2)。**AI は候補集合を増やせない**
 * —— AI が触れるのは差分操作 `set_theme` の中身であって、この表ではない。
 *
 * **これは組織テンプレート機構ではない**(計画 §0-2 / §1-1)。owner が候補を作って組織で
 * 共有する器は1つも作っていない。**「テンプレート機構ができた」と書いてはならない。**
 *
 * **候補の配色はこのリポジトリのコードが持つ値であって、利用者の組織の色ではない**
 * (審査記録 §3 S3-8)。**D-G7 で近づくのは「出発点を選べる」までである。**
 *
 * ## 候補が満たさなければならない条件(全件を機械検査で固定する)
 *
 * 1. **25スロット全部の実値**である —— `schemas/manifest.schema.json` の `$defs/theme` は
 *    全キー `required` で、部分テーマを受理しない(ADR-0047 の 2026-07-25 追記(2))。
 * 2. **値はスキーマの `pattern` を満たす** —— 式・計算・参照(`calc(` / `var(` 等)を書けない
 *    (ADR-0047 限定6)。
 * 3. **コントラスト検査(ADR-0046 / ADR-0047 限定8)を通る** —— **通らない候補を同梱しない。**
 *    確かめているのは `web/test/theme-candidates.test.ts` で、**カーネルの検査関数そのもの**
 *    (`src/kernel/theme-contrast.ts`)を呼んでいる。web 側に同じ規則を再実装していない。
 *
 * **この製品の既定配色はこの表に入れられない** —— `--color-border: #ddd` が非テキストの
 * 閾値 3:1 を通らないためである(ADR-0046 の 2026-07-25 追記「限界7」)。したがって
 * 「今の見た目」を候補として並べることはできない。**候補は3件とも、今の見た目とは違う。**
 *
 * ## カーネルから値を import しない
 *
 * スロット名は**マニフェストのキーそのもの**である(恒等写像)。したがって
 * `src/kernel/` から値を import する必要が無く、ADR-0009 限定2 と
 * `scripts/kernel-import-drift.test.ts` を製品コードでは1ミリも動かさない(型のみ import する)。
 * 先例は `web/src/ThemeExportPanel.tsx` である。
 */
import type { Theme } from "../../src/kernel/types.ts";
import type { ThemeDiff } from "./api.ts";

/** 候補1件。**画面に出す名前と説明を必ず持つ**(どれを選んだのかが読めない候補を作らない)。 */
export type ThemeCandidate = {
  /** 候補のID。差分IDの材料になるので `$defs/resource_id` の形をしている。 */
  readonly id: string;
  /** 画面に出す名前。`intent` にも入る(後から「どれを選んだか」を読むため)。 */
  readonly name: string;
  /** 何が違うのかの一言。**効能を約束しない**(「読みやすい」等と書かない)。 */
  readonly note: string;
  /** 25スロット全部の実値。 */
  readonly slots: Readonly<Record<string, string>>;
};

/**
 * 色以外のスロット(寸法・書体・行間)の基準値。
 *
 * **候補ごとに違いを付けられる** —— 3件目は余白と書体も変えてある。ここは既定値の表では
 * なく「基準にした値」であって、`web/src/styles.css` の `:root` の写しではない
 * (写しにすると、`:root` を変えたときに黙って食い違う)。
 */
const BASE_METRICS = {
  "--font-family-base": "system-ui, sans-serif",
  "--font-size-secondary": "0.85em",
  "--font-size-note": "0.875rem",
  "--line-height-base": "1.6",
  "--space-1": "0.25rem",
  "--space-2": "0.5rem",
  "--space-3": "0.75rem",
  "--space-4": "1rem",
  "--space-5": "1.25rem",
  "--space-6": "2rem",
  "--border-width": "1px",
  "--control-border-radius": "4px",
  "--surface-shadow": "none",
  "--focus-outline-width": "2px",
  "--detail-label-width": "8rem",
  "--login-max-width": "24rem",
} as const;

/**
 * 候補の表。**N = 3 である。**
 *
 * **3 にした理由**(計画上の判断。所見に根拠なし):
 *
 * - **上限はメインの計画が 4 以下と決めている。**
 * - **2 だと「A か B か」にしかならず、「候補の中から選ぶ」の形にならない。**
 *   完了条件1 の下限(「少なくとも2種」)は満たすが、下限そのものである。
 * - **1件増やすごとに、プレビューを開いたときの API 呼び出しがちょうど1画面ぶん増える**
 *   (D-M4-3 の代償。実測は `web/test/theme-preview.test.tsx`)。**多いほど良いではない。**
 * - **候補は25スロット全部を埋め、コントラスト検査を通り続けなければならない。**
 *   増やすほど、この表の維持費が線形に増える。
 *
 * **候補を増やす・owner に作らせるのは、この判定の射程外である** —— 審査記録 §3 S6 の
 * 後続の再審査条件 (d) が「候補を owner が作れるようにしたくなったとき」を門A に送っている。
 */
export const THEME_CANDIDATES: readonly ThemeCandidate[] = Object.freeze([
  Object.freeze({
    id: "plain-light",
    name: "明るい",
    note: "白い地色に黒い文字。余白と書体は基準のまま。",
    slots: Object.freeze({
      ...BASE_METRICS,
      "--color-text": "#111111",
      "--color-text-secondary": "#595959",
      "--color-text-label": "#595959",
      "--color-text-placeholder": "#595959",
      "--color-danger": "#a00000",
      "--color-page-background": "#ffffff",
      "--color-surface-highlight": "#f2f2f2",
      "--color-border": "#767676",
      "--focus-outline-color": "#005fcc",
    }),
  }),
  Object.freeze({
    id: "deep-dark",
    name: "暗い",
    note: "濃紺の地色に明るい文字。余白と書体は「明るい」と同じで、違うのは配色だけ。",
    slots: Object.freeze({
      ...BASE_METRICS,
      "--surface-shadow": "0 1px 3px #000000",
      "--color-text": "#f5f5f5",
      "--color-text-secondary": "#c8d8e8",
      "--color-text-label": "#ffd54a",
      "--color-text-placeholder": "#b0b8c0",
      "--color-danger": "#ff9a8a",
      "--color-page-background": "#102030",
      "--color-surface-highlight": "#243447",
      "--color-border": "#8fa3b8",
      "--focus-outline-color": "#7fd4ff",
    }),
  }),
  Object.freeze({
    id: "warm-roomy",
    name: "暖色でゆったり",
    note: "淡い黄の地色。**配色だけでなく余白と書体も違う**(明朝体・余白は広め・行間は 1.8)。",
    slots: Object.freeze({
      ...BASE_METRICS,
      "--font-family-base": "Georgia, serif",
      "--line-height-base": "1.8",
      "--space-1": "0.375rem",
      "--space-2": "0.75rem",
      "--space-3": "1rem",
      "--space-4": "1.5rem",
      "--space-5": "2rem",
      "--space-6": "3rem",
      "--control-border-radius": "8px",
      "--surface-shadow": "0 1px 3px #00000022",
      "--color-text": "#1a237e",
      "--color-text-secondary": "#37474f",
      "--color-text-label": "#4a148c",
      "--color-text-placeholder": "#5d4037",
      "--color-danger": "#b00020",
      "--color-page-background": "#fff8e1",
      "--color-surface-highlight": "#ffecb3",
      "--color-border": "#6d4c41",
      "--focus-outline-color": "#00695c",
    }),
  }),
]);

/**
 * 差分IDの後半(毎回変わる部分)。
 *
 * **同じミリ秒に2回押しても違うIDになるようにする** —— `_changelog` は差分IDの重複を
 * 受けないので、衝突すると2度目の適用が黙って失敗する。時刻だけでは足りない
 * (`docs/plan/v3/records/flaky-workflow-runner-ran-at` と同型の踏み方をしない)。
 *
 * 使う文字は `$defs/resource_id` が許す英小文字と数字だけである。
 */
export function newDiffSuffix(): string {
  const time = Date.now().toString(36);
  const nonce = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return `${time}${nonce}`;
}

/**
 * この候補を適用するための intent(完了条件12)。
 *
 * **これは人間の意図ではない。** 憲法5 は「差分に意図を残す」と言うが、ここで残るのは
 * **ブラウザの操作から機械が組み立てた定型文**である。`_changelog` は要件定義書の入力でも
 * ある(ADR-0025)ので、そこに**人間でも AI でもない書き手の行が混じる**ことになる。
 * **それを隠さず、文そのものに書く。**
 *
 * **最低条件は「どの候補を選んだかが後から読めること」である**(完了条件12)ので、
 * 候補の名前とIDを必ず含める。
 */
function themeCandidateIntent(candidate: ThemeCandidate): string {
  return (
    `テーマ候補のプレビューで、組み込みの候補「${candidate.name}」(${candidate.id})を選んで適用した。` +
    "この文はブラウザが自動で組み立てた定型文であり、人間が書いた意図ではない。"
  );
}

/**
 * 候補から差分を1件作る。**普通の差分である**(完了条件4)。
 *
 * - 操作は `set_theme` 1件だけ。**逃げ道経路も専用エンドポイントも使わない。**
 * - **由来(`origin`)を名乗らない** —— `origin.template_app_id` は「写し元のアプリID」で
 *   あり、候補はアプリではない。**カーネルは真偽を検証しない**(ADR-0047 限定7)ので、
 *   実在しないアプリIDでも通ってしまう。**通るからといって書かない。**
 *
 * @param suffix 差分IDの後半。呼び出し側が {@link newDiffSuffix} で作る(テストのため引数)。
 */
export function themeCandidateDiff(candidate: ThemeCandidate, suffix: string): ThemeDiff {
  const theme: Theme = { slots: { ...candidate.slots } };
  return {
    diff_id: `theme-${candidate.id}-${suffix}`,
    intent: themeCandidateIntent(candidate),
    operations: [{ op: "set_theme", theme }],
  };
}
