/**
 * 書込が権限不足(サーバの 403)で拒否されたことの表示(V1-M3-T02)。
 *
 * viewer には書込 UI を先回りで出さないが、ロールがサーバ側で変わった直後などに
 * 403 が返ることはある。そのとき「セッションが切れた(401)」ではなく
 * 「ログイン済みだが権限が無い」ことを明示するための共通表示(form / detail が使う)。
 *
 * ## 【V4-M15-T14】器を部品体系の `Alert` に載せ替えた(`ADR-0087`)
 *
 * **理由と、変えていないものの一覧は `WriteConflict.tsx` の冒頭と同じである**
 * (文言・`data-testid`・`class` を1つも動かしていない。`role="alert"` は `Alert` が持つ)。
 * **要素は `<p>` から `<div>` に変わる。隠さない。**
 */
import { Alert } from "../ui/surfaces.tsx";
import { cn } from "../ui/utils.ts";

export function WriteForbidden() {
  return (
    <Alert variant="destructive" className={cn("write-forbidden")} data-testid="write-forbidden">
      権限がありません(閲覧のみ)。
    </Alert>
  );
}
