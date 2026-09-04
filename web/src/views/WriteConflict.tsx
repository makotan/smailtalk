/**
 * 楽観ロック(M9-T02)の競合表示。records の update/delete が 409 を返したときに使う。
 *
 * 401(セッション失効)や 403(権限不足=`WriteForbidden`)とは別の状況なので、専用の
 * 文面を出す(`WriteForbidden` と同じ作法)。409 には2種類あり、意味も対処も違うので
 * 表示も分ける:
 *  - **版不一致**(`WriteConflict`)… 別のユーザ/セッションが先に変更した。最新を取り込む。
 *  - **適用中**(`ApplyInProgress`)… いま差分適用中。少し待って再試行すれば通る。
 *
 * ## 【V4-M15-T14】器を部品体系の `Alert` に載せ替えた(`ADR-0087` / `ADR-0089`)
 *
 * **着手前はどちらも素の `<p role="alert">` で、当たる CSS 規則は0件だった**
 * (`03` §4-1 の「警告表示 CSS 0件」と同型)。**`Alert variant="destructive"` に入れると、
 * 25スロット由来の枠線と文字色が当たる。**
 *
 * **変えていないもの**: **文言を1文字も変えていない。** **`data-testid` を1つも落として
 * いない。** **`class` 名(`write-conflict` / `apply-in-progress`)も残している** ——
 * 消すと `web/src/styles.css` の側から当てる手段が無くなる。**`role="alert"` は `Alert` が
 * 自分で持つ**(`aria-live` は1つも足していない)。
 *
 * **要素は `<p>` から `<div>` に変わる**(`Alert` は `div` である)。**隠さない。**
 */
import { Alert } from "../ui/surfaces.tsx";
import { cn } from "../ui/utils.ts";

/** 版不一致(別のユーザ/セッションが先に変更した)。最新を取り込んでやり直す。 */
export function WriteConflict() {
  return (
    <Alert variant="destructive" className={cn("write-conflict")} data-testid="write-conflict">
      このレコードは別の人が先に変更しました。最新を取り込んでやり直してください。
    </Alert>
  );
}

/** 差分適用中。いまは書き込めないが、少し待てば通る。 */
export function ApplyInProgress() {
  return (
    <Alert
      variant="destructive"
      className={cn("apply-in-progress")}
      data-testid="apply-in-progress"
    >
      いまアプリの変更を適用中です。少し待ってから、もう一度お試しください。
    </Alert>
  );
}
