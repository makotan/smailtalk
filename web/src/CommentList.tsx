/**
 * **積まれたコメントを1枚のパネルで読み返す画面**(`V10-M32-T01`)。
 *
 * ## これは何で、何ではないか
 *
 * **ログインした人が、そのアプリで自分に見えるコメントを読み返すだけの器である。**
 * **読む先は `GET /api/apps/:app_id/comments` の1本だけで、これは `V10-M15-T05`
 * (`CM-G21` / `ADR-0370`)が `src/server/auth-routes.ts` に足した口である。**
 * **`CommentPanel`(書く欄)とは別の場所であり、書く欄の中には1要素も足していない。**
 *
 * ## **絞り込みも並べ替えも状態変更も、1行も書かない**(**この画面の一番大事な規律**)
 *
 * **読める範囲を決めるのは `src/server/comment-visibility.ts` の可視集合1本だけであり、
 * 画面側に条件式を1行も書かない**(`CM-G5` 限定1 と同じ規律)。 **具体的には:**
 *
 * - **`.filter(` を1つも書かない。** **役割も書き手も状態も、見て分岐しない**
 *   (表示に使うだけである)。 **書くと同じ規則が2箇所に住み、どちらが正かを人間が
 *   決められなくなる。**
 * - **サーバが返した配列を、返ってきた順にそのまま並べる。** **並べ替えのキーを1つも
 *   持たない** —— 並び順を決めているのは器(`CommentStore`)であって、この画面ではない。
 * - **状態を変える口(ボタン・API 呼び出し)を1つも置かない。** **承認画面(`CM-G13`)は
 *   門A で却下されている。** **状態を書き換える経路は今日も器の
 *   `CommentStore.updateCommentState` だけで、HTTP にも画面にも1本も無い。**
 *
 * **この規律は `web/test/comment-list.test.tsx` の (j) がソースを走査して数で固定する**
 * (陽性対照つき)。
 *
 * ## 出し入れ(ON/OFF)を掛けていない(**本工程では、である**)
 *
 * **この導線は、ログインしていれば常に出る。** **`comment_visibility.read` の設定を
 * 1度も見ていない** —— **掛けるのは `V10-M32-T02` であって本工程ではない。**
 * **したがって今日は「設定が OFF のアプリでも導線が出る」** ——**隠さずに書いておく。**
 *
 * ## 【`V10-M32-T03`(2026-08-26)】**直前の節は今日の正ではない**
 *
 * **上の節(見出しを含む5行)を1バイトも消していない**(`ADR-0007` §6 規律1 と同じ作法)。
 * **旧の逐語はこの3文である:**
 *
 * > **「この導線は、ログインしていれば常に出る。」**
 * > **「`comment_visibility.read` の設定を1度も見ていない —— 掛けるのは `V10-M32-T02` で
 * > あって本工程ではない。」**
 * > **「したがって今日は『設定が OFF のアプリでも導線が出る』。」**
 *
 * **この3文はどれも今日は偽である。** **偽にしたのは `V10-M32-T02`(台帳 `CM-G41`)であり、
 * 本工程(`V10-M32-T03`)ではない** —— **本工程は `web/src/` の実装を1バイトも書き換えて
 * おらず、ここに足したのは訂正の文だけである。**
 *
 * **今日の正は次のとおりである:**
 *
 * - **導線(`data-testid="open-comment-list"`)も、このパネルを描く三項連鎖の枝も、
 *   `comment_visibility.read` が真のときにしか出ない** —— **判定は
 *   `web/src/views/ViewHost.tsx` の `useCommentReadEnabled()` 1本で、呼ぶのは
 *   `web/src/AppWorkspace.tsx` の1箇所ちょうどである。**
 * - **既定は OFF である**(利用者決定 `D-V10-40`)—— **払い出したままのアプリでは
 *   導線も一覧も1要素も出ない。** **`web/e2e/comment-read.e2e.ts` の2本目が本物の
 *   ブラウザでそれを実測し、`read` を ON に倒して開き直すと出ることを陽性対照に置く。**
 * - **`write` と `read` は別である**(`D-V10-36`)—— **書く欄だけを出すことも、読む場所
 *   だけを出すこともできる**(同ファイルの3本目が実測する)。
 *
 * ## **【誇張しない】読み返せる場所と、読める範囲**(`V10-M32-T03`)
 *
 * - **読み返せる場所は書く欄(`web/src/CommentPanel.tsx`)ではない** —— **作業画面の上に
 *   ある「コメント」の導線から開く、この一覧である。** **書く欄の中に読み出しの要素は
 *   1つも無い。**
 * - **読めるのは「その人に見える範囲」であって、「自分が書いたもの」とは一致しない** ——
 *   **絞っているのは `src/server/comment-visibility.ts` の可視集合(`OR` の2項)だけであり、
 *   書き手が自分かどうかで絞る規則は今日1本も無い。** **他人が書いた1件も、その人に
 *   見える範囲なら同じ一覧に並ぶ。**
 * - **止めているのは画面に出すことだけで、口は1バイトも閉じていない**(`D-V10-38`)——
 *   **`GET /api/apps/:app_id/comments` も MCP の `list_comments` も、設定を今日1度も見ない。**
 *   **設定が OFF のアプリでも、口を直に叩けば今日どおり応答が返る**
 *   (`web/e2e/comment-read.e2e.ts` の4本目が 200 を実測する)。
 *
 * ## 手本
 *
 * **`web/src/RequirementsDocPanel.tsx` と同じ作法**(`useState<AsyncState<…>>` 1本 +
 * `useEffect(…, [appId])` + `cancelled` フラグ + `Card` / `Skeleton` / `ErrorList` /
 * `Button`)。**取得の経路も1本だけで、第2の取得経路を作らない。**
 *
 * **`web/src/styles.css` に規則を1つも足していない** —— 改行を保つのは Tailwind の
 * コアユーティリティ(`whitespace-pre-wrap`)である(足すと `web/test/styles.test.ts` の
 * 凍結値が動く)。
 */
import { useEffect, useState } from "react";
import { type CommentState, type CommentSummary, listComments } from "./api.ts";
import { type AsyncState, toValidationErrors } from "./async.ts";
import { ErrorList } from "./ErrorList.tsx";
import { Button } from "./ui/button.tsx";
import { Card, Skeleton } from "./ui/surfaces.tsx";
import { cn } from "./ui/utils.ts";

/**
 * 状態の表示名(器の3値ちょうど)。
 *
 * `Record<CommentState, string>` はキーの過不足をどちらもコンパイルエラーにするので、
 * **器の union が動けばここが必ず赤くなる**(`RequirementsDocPanel.tsx` の `SECTION_LABELS`
 * が先例)。 **綴りを手で焼いて黙って外れることを避けるための1本である。**
 *
 * **これは表示名の対応表であって、判定ではない。** **どの状態を出すか出さないかを、
 * この表で決めてはいない**(3値とも出る)。
 */
const STATE_LABELS: Record<CommentState, string> = {
  open: "未対応",
  not_applicable: "対応できない",
  applied: "当てた",
};

/**
 * **状態の表示名を引き当てる**(`V10-M32-T04`(2026-08-26)。独立点検の指摘5)。
 *
 * **すぐ上の `STATE_LABELS` も、その doc も1バイトも消していない** —— **足したのは
 * 「表に無い値が来たとき」の道1本だけである。**
 *
 * **旧の呼び出し(逐語)**:
 *
 * ```
 * {STATE_LABELS[comment.state]}
 * ```
 *
 * **旧は器の3値でない値が届くと空文字を出していた**(点検の実測 = `P4 state text = ""`)——
 * **「状態が無い」と「器が知らない値が来た」が画面上で区別できなかった。**
 * **今日は引き当てが外れたら、届いた値そのものを出す**(憲法6。(u-2) が数で固定する)。
 *
 * **型の担保は1ミリも緩んでいない** —— **`STATE_LABELS` は今日も `Record<CommentState, string>`
 * であり、器の union が動けば `bunx tsc --noEmit` が落ちる。** **ここで一度 `string` 鍵の
 * 表として読み直しているのは、実行時に型の外の値が届きうるからであって、型を緩めたからではない。**
 */
function stateLabel(comment: CommentSummary): string {
  const labels: Record<string, string | undefined> = STATE_LABELS;
  return labels[comment.state] ?? comment.state;
}

/**
 * 宛先1件の表示文字列。**形と部品を連ねるだけで、解釈も要約も丸めもしない。**
 * 部品を持たない形(`app` など)では形の名前だけが残る。
 */
function anchorLabel(comment: CommentSummary): string {
  // **【`V10-M32-T04`(2026-08-26)。独立点検の指摘4】旧の本体(逐語。1バイトも消していない)**:
  //   ``return `${comment.anchorForm} / ${comment.anchorParts.join(" / ")}`;``
  // **すぐ上の doc の「部品を持たない形(`app` など)では形の名前だけが残る」は、
  // 旧の本体では偽だった** —— **点検の実測は `"app / "` であり、宙に浮いた区切りが1つ出ていた。**
  // **今日は doc のとおりにする**((t) が数で固定する)。**丸めでも要約でもない** ——
  // **連ねる相手が1つも無いときに、連ねるための記号を出さないだけである。**
  if (comment.anchorParts.length === 0) {
    return comment.anchorForm;
  }
  return `${comment.anchorForm} / ${comment.anchorParts.join(" / ")}`;
}

/** コメント1件。**器が返した値をそのまま並べる**(整形は1箇所も無い)。 */
function CommentItem({ comment }: { comment: CommentSummary }) {
  return (
    <li
      className={cn("comment-list-item", "flex flex-col gap-s1")}
      data-testid="comment-list-item"
      data-comment-id={comment.id}
      data-state={comment.state}
    >
      {/* 本文は書いた人が打った改行をそのまま持つので、潰さずに出す。 */}
      <p
        className={cn("comment-item-body", "m-0", "whitespace-pre-wrap")}
        data-testid="comment-item-body"
      >
        {comment.body}
      </p>
      <span
        className={cn("comment-item-anchor", "text-note text-muted-foreground")}
        data-testid="comment-item-anchor"
      >
        {anchorLabel(comment)}
      </span>
      {/* 日時は器が返した文字列そのままである(表示用に組み直さない)。 */}
      <span
        className={cn("comment-item-created-at", "text-note text-muted-foreground")}
        data-testid="comment-item-created-at"
      >
        {comment.createdAt}
      </span>
      <span
        className={cn("comment-item-writer", "text-note text-muted-foreground")}
        data-testid="comment-item-writer"
      >
        {comment.writer ?? "(名乗りなし)"}
      </span>
      <span
        className={cn("comment-item-state", "text-note text-muted-foreground")}
        data-testid="comment-item-state"
      >
        {stateLabel(comment)}
      </span>
      {/*
        **【`V10-M32-T04`(2026-08-26)。独立点検の指摘5】旧の条件(逐語。1バイトも消していない)**:
        `{comment.reason !== null && (` … `{comment.reason}` … `)}`
        **旧は `reason` キーそのものが無い行(`undefined`)を通していた** —— **`!== null` は
        `undefined` に対して真になるので、空の理由欄が1つ出ていた**(点検の実測 =
        `P5 reason 要素数 = 1`)。**今日は `null` と `undefined` の両方を「無い」に倒す。**
        **`?? null` にしてあるのは、型が `string | null` のままだと `!== undefined` が
        「重なりが無い比較」として型検査に落ちるからである**(型を緩めずに実行時の欠落だけを拾う)。
      */}
      {(comment.reason ?? null) !== null && (
        <span
          className={cn("comment-item-reason", "text-note text-muted-foreground")}
          data-testid="comment-item-reason"
        >
          {comment.reason}
        </span>
      )}
    </li>
  );
}

export function CommentList({ appId, onClose }: { appId: string; onClose?: () => void }) {
  const [state, setState] = useState<AsyncState<CommentSummary[]>>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    listComments(appId).then(
      (value) => {
        if (!cancelled) {
          setState({ status: "ready", value });
        }
      },
      (reason: unknown) => {
        if (!cancelled) {
          setState({ status: "error", errors: toValidationErrors(reason) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [appId]);

  return (
    <Card className={cn("comment-list")} data-testid="comment-list">
      <header
        className={cn("comment-list-header", "flex flex-wrap items-center justify-between gap-s2")}
      >
        <h3 className={cn("m-0")}>コメント</h3>
        {onClose !== undefined && (
          <Button size="sm" variant="secondary" data-testid="close-comment-list" onClick={onClose}>
            閉じる
          </Button>
        )}
      </header>

      {state.status === "loading" && (
        <div className={cn("flex flex-col gap-s2")}>
          <p className={cn("m-0", "text-note text-muted-foreground")}>読み込み中…</p>
          {["head", "body-1", "body-2"].map((slot) => (
            <Skeleton key={slot} className="h-4 w-full" />
          ))}
        </div>
      )}
      {state.status === "error" && <ErrorList errors={state.errors} />}
      {state.status === "ready" &&
        (state.value.length === 0 ? (
          <p
            className={cn("comment-list-empty", "m-0 text-muted-foreground")}
            data-testid="comment-list-empty"
          >
            まだコメントは1件もありません。
          </p>
        ) : (
          <ul className={cn("comment-list-items", "flex flex-col gap-s2")}>
            {state.value.map((comment) => (
              <CommentItem key={comment.id} comment={comment} />
            ))}
          </ul>
        ))}
    </Card>
  );
}
