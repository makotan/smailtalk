/**
 * 画面の作りの点検(注意)。
 *
 * マニフェストを1つ受け取り、**検証には通るが画面として使いにくくなりがちな作り**を
 * 「注意」として列挙する純粋関数である。**DB もファイルも読まず、何も書き込まず、
 * 何も止めない**(注意は適用を止めない。止めるのは検証の拒否だけである)。
 *
 * ## 返すもの
 *
 * - `notices` —— 当たった箇所を1件ずつ全件挙げる。**件数を別の欄に持たない**
 *   (`notices.length` が件数であり、列挙から数え直せる)。
 * - `not_counted` —— **数えなかったもの**を理由つきで挙げる(黙って数えないことを作らない)。
 * - `limits` —— この数え方の限界。
 *
 * ## 閾値
 *
 * 閾値はコード定数に固定し、引数に置かない(置けば呼ぶ側が値を選べてしまう)。
 *
 * ## 置き場
 *
 * `src/shared/` に置き、`src/kernel/` からは**型だけ**を取る(値を1つも取らない)。
 * 画面(`web/`)からも、コマンド(`src/cli/`)からも、同じ1本を呼べるようにするため。
 */

import type { Manifest } from "../kernel/types.ts";

/** 作り手が書いたボタンがこの数**以上**のとき注意を出す(一覧・詳細画面)。 */
export const DESIGN_NOTICE_MAX_ACTIONS = 8;

/** 入力フォームの項目がこの数**以上**で、まとまり(`field_sections`)が無いとき注意を出す。 */
export const DESIGN_NOTICE_LONG_FORM_FIELDS = 10;

/** 注意の種類。 */
export type DesignNoticeRule =
  | "multiple_primary_actions"
  | "too_many_actions"
  | "long_form_without_sections";

/** 注意1件。 */
export type DesignNotice = {
  rule: DesignNoticeRule;
  /** 当たった画面の識別子。 */
  view: string;
  /** 当たった箇所(JSON Pointer。マニフェストの根からの位置)。 */
  path: string;
  /** 数えた値(主ボタンの数・ボタンの数・項目の数)。 */
  count: number;
  /** 比べた閾値(この数以上で注意)。閾値を持たない注意には無い。 */
  threshold?: number;
  message: string;
};

/** 数えなかったもの1件。 */
export type DesignNoticeNotCounted = { what: string; reason: string };

/** 点検の結果。 */
export type DesignNoticeReport = {
  notices: DesignNotice[];
  not_counted: DesignNoticeNotCounted[];
  limits: string[];
};

/** 数えなかったもの(常に返す)。 */
const NOT_COUNTED: readonly DesignNoticeNotCounted[] = Object.freeze([
  Object.freeze({
    what: "並べ方の木(layout)の入れ子の深さ",
    reason:
      "深すぎる入れ子は検証が拒否する(保存できない)ので、注意としては数えない。注意に落とすと今日の拒否を緩めることになる。",
  }),
]);

/** この数え方の限界(常に返す)。 */
const LIMITS: readonly string[] = Object.freeze([
  "最初から付くボタン(編集・削除・新規作成・送信など)は数えない。数えるのは作り手が actions に書いたボタンだけである。",
  "表示の条件(visible_when)で同時には出ない主ボタンも、書かれた数のまま数える(2つあれば2つと数える)。",
  "入力フォームのまとまり(field_sections)は、一部の項目だけを区切っていても「区切り有り」とみなす。",
  "並べ方の木(layout)は区切りとして数えない。区切りとみなすのは field_sections だけである。",
  "元に戻す・やり直す(undo / redo)の返事と、人が画面から保存したときの返事には注意が出ない。",
  "注意が1件も無いことは、見た目の良さを保証しない。",
]);

/**
 * マニフェストの画面を点検し、注意を集める。
 *
 * 画面は `Record<string, unknown>` として読む —— 画面種別で書けないはずのキーや、
 * 形の崩れた値が来ても落ちずに、当たらない側へ回すため。
 */
export function collectDesignNotices(manifest: Manifest): DesignNoticeReport {
  const notices: DesignNotice[] = [];
  const views: unknown = (manifest as { app?: { views?: unknown } } | null)?.app?.views;
  if (Array.isArray(views)) {
    views.forEach((raw: unknown, index: number) => {
      if (typeof raw !== "object" || raw === null) {
        return;
      }
      const view = raw as Record<string, unknown>;
      const id = typeof view.id === "string" ? view.id : `#${index}`;
      const type = view.type;
      const base = `/app/views/${index}`;
      const actions = Array.isArray(view.actions) ? (view.actions as unknown[]) : [];

      // 注意1: 主ボタンが2つ以上。主・副を書けるのは詳細画面だけである。
      if (type === "detail_view") {
        const primaries = actions.filter(
          (one) =>
            typeof one === "object" &&
            one !== null &&
            (one as Record<string, unknown>).action_emphasis === "primary",
        ).length;
        if (primaries >= 2) {
          notices.push({
            rule: "multiple_primary_actions",
            view: id,
            path: `${base}/actions`,
            count: primaries,
            message: `注意: 詳細画面 "${id}" に主ボタン(primary)が${primaries}つあります。主ボタンを1つに絞ると、次に押すボタンが伝わりやすくなります。`,
          });
        }
      }

      // 注意2: 作り手が書いたボタンが多すぎる。組込のボタンは数えない。
      if (
        (type === "list_view" || type === "detail_view") &&
        actions.length >= DESIGN_NOTICE_MAX_ACTIONS
      ) {
        const where = type === "list_view" ? "一覧" : "詳細画面";
        notices.push({
          rule: "too_many_actions",
          view: id,
          path: `${base}/actions`,
          count: actions.length,
          threshold: DESIGN_NOTICE_MAX_ACTIONS,
          message: `注意: ${where} "${id}" に書かれたボタンが${actions.length}個あります(${DESIGN_NOTICE_MAX_ACTIONS}個以上)。よく使うものに絞るか、画面を分けると選びやすくなります。`,
        });
      }

      // 注意3: 長い入力フォームに区切り(field_sections)が無い。
      if (type === "form") {
        const fields = Array.isArray(view.fields) ? view.fields.length : 0;
        const hasSections = typeof view.field_sections === "object" && view.field_sections !== null;
        if (fields >= DESIGN_NOTICE_LONG_FORM_FIELDS && !hasSections) {
          notices.push({
            rule: "long_form_without_sections",
            view: id,
            path: `${base}/fields`,
            count: fields,
            threshold: DESIGN_NOTICE_LONG_FORM_FIELDS,
            message: `注意: 入力フォーム "${id}" に項目が${fields}個あり(${DESIGN_NOTICE_LONG_FORM_FIELDS}個以上)、まとまり(field_sections)がありません。見出しで区切ると入力しやすくなります。`,
          });
        }
      }
    });
  }
  return {
    notices,
    not_counted: NOT_COUNTED.map((one) => ({ ...one })),
    limits: [...LIMITS],
  };
}
