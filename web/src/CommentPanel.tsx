/**
 * **画面へのコメントを1件書く導線**(`V10-M11-T01` の2手目。台帳 `CM-G4` =
 * **門外**(`Δ7`)/ 判定値 = 限定採用。`docs/plan/v10/records/v10-m9.md` §8-1 が
 * `web/src/CommentPanel.tsx` を名指ししている)。
 *
 * ## これは何で、何ではないか
 *
 * **開いている画面について「ここをこう直したい」を1件書き送るだけの器である。**
 * **書く先は `POST /api/apps/:app_id/comments` の1本だけで、これは
 * `V10-M11-T01` の1手目が `src/server/auth-routes.ts` に足した口である。**
 *
 * - **読む導線を1本も持たない。** **コメントを読む口は HTTP に今日1本も無い**
 *   (足すのは `V10-M15-T05` / `CM-G21`)。 **したがって、書いた本人がこの画面で
 *   読み返すことは今日できない**(`CM-G4` §1-8 の限界1。**隠さない**)。
 *
 *   **--- 【`V10-M32-T01`(2026-08-26)】上の3行を1バイトも消していない。訂正を後ろに足す ---**
 *
 *   1. **「読む導線を1本も持たない」は今日も真である。** **この欄は書くだけであり、
 *      本工程でも読み出しの口を1度も叩いていない**(`web/test/comment-panel.test.tsx` の
 *      「読出は今日0本」がそのまま緑である)。
 *   2. **「コメントを読む口は HTTP に今日1本も無い」は既に偽である。**
 *      **`GET /api/apps/:app_id/comments` が `src/server/auth-routes.ts:3747` に在る。**
 *      **偽にしたのは本工程ではなく `V10-M15-T05`(`CM-G21` / `ADR-0370`)であり、
 *      2026-08-24 の時点で既に偽だった** —— **本工程はその事実を書き入れただけである。**
 *   3. **「書いた本人がこの画面で読み返すことは今日できない」は、本工程が偽にした。**
 *      **読み返す場所は `web/src/CommentList.tsx`(作業画面の「コメント」の導線)である** ——
 *      **`この画面`(= この書く欄)ではなく、別の1枚のパネルである。**
 *      **この欄の中には読み出しの要素を1つも足していない。**
 *      **【正直に書く】読めるのは「その人に見える範囲」であって、自分が書いたコメントとは
 *      一致しない** —— **絞っているのは `src/server/comment-visibility.ts` の可視集合であり、
 *      書き手が自分かどうかで絞る規則は今日1本も無い。**
 * - **返事も状態も出さない。** 器に状態(`open` / `not_applicable` / `applied`)の列が
 *   無い(足すのは `V10-M13-T02`)。
 * - **判定も整形も1つも書かない**(`CM-G4` 限定5)。 **宛先の形が登録簿に在るか・部品の数が
 *   形と合うか・本文が空でないかは、すべて器(`CommentStore.addComment`)が見る。**
 *   **ここで先回りして弾かない** —— **弾くと同じ規則が2箇所に住み、器の文面が画面に出なくなる。**
 *   **その帰結として、空のまま送るとサーバが 400 を返し、器の文面がそのまま出る**
 *   (「押しても必ず失敗するボタン」ではない —— **何を書いたかで結果が変わる**)。
 *
 * ## 誰に出すか(**`D-V10-5`**)
 *
 * **役割で1つも絞らない** —— **使う人も含めて誰でも書ける**(サーバ側も役割の規則を
 * 1度も見ない)。 **絞りは「ログインしているか」の1点だけである。**
 *
 * **未ログインには1要素も出さない** —— **`src/mcp/vocabulary.ts` の `CANNOT_DO` (f)
 * 「未ログインには書き込みの導線を1つも出しません」は今日も真であり、
 * それを偽にするのは `V10-M11-T03`(`CM-G6`)である。**
 * **判定は `useRole()` が `null` かどうかだけである** —— **匿名の作業画面
 * (`AnonymousWorkspace`)は `RoleProvider` で包まないので、配下に `null` が流れる**
 * (`web/src/AppWorkspace.tsx` の「`RoleProvider` で包まない」節)。
 *
 * ## 指せる宛先(**今日は1形だけ。丸めない**)
 *
 * **器の登録簿は11形あるが、この導線が指せるのは `view`(画面そのもの)の1形だけである。**
 * **`app` / `view_action` / `view_field` / `view_related` / `view_report_node` /
 * `view_field_group` / `view_field_link` / `view_row` / `view_after_save` /
 * `view_after_delete` の10形は、画面から1つも指せない** —— **器はどれも受け付けるので、
 * 指せないのは画面の側の限界である。** **形を選ばせる選択肢を1つも出していない**
 * (無理に11形を画面へ出さない)。
 *
 * **形の名前は `CommentAnchorForm` 型で受けている** —— **登録簿から名前が消えたら
 * 型検査が落ちる**(綴りを手で焼いて黙って外れることを避ける)。
 */
import { useState } from "react";
import type { CommentAnchorForm } from "../../src/kernel/comment-store.ts";
import type { View } from "../../src/kernel/types.ts";
import { ApiError, createComment, type ValidationError } from "./api.ts";
import { useRole } from "./auth/authz.tsx";
import { ErrorList } from "./ErrorList.tsx";
import { Button } from "./ui/button.tsx";
import { Textarea } from "./ui/form-controls.tsx";
import { Alert } from "./ui/surfaces.tsx";
import { cn } from "./ui/utils.ts";

/**
 * **この導線が指す宛先の形**。**型を通しているので、登録簿からこの名前が消えると
 * `bunx tsc --noEmit` が落ちる。**
 */
const ANCHOR_FORM: CommentAnchorForm = "view";

type PanelState =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "sent" }
  | { status: "failed"; errors: ValidationError[] };

export function CommentPanel({ appId, view }: { appId: string; view: View }) {
  const role = useRole();
  const [body, setBody] = useState("");
  const [state, setState] = useState<PanelState>({ status: "idle" });

  // **未ログインには1要素も出さない**(上の「誰に出すか」)。
  // **フックの後で返している** —— 呼ぶ順序を分岐で変えない。
  if (role === null) {
    return null;
  }

  const send = (): void => {
    setState({ status: "sending" });
    createComment(appId, { anchorForm: ANCHOR_FORM, anchorParts: [view.id], body })
      .then(() => {
        // **受け付けられたときだけ入力を消す** —— 断られたら書いたものを捨てない。
        setBody("");
        setState({ status: "sent" });
      })
      .catch((error: unknown) => {
        const errors =
          error instanceof ApiError
            ? error.errors
            : [{ path: "", message: "コメントを送れませんでした。" }];
        setState({ status: "failed", errors });
      });
  };

  return (
    <section
      className={cn("comment-panel", "mt-s3 flex flex-col gap-s2")}
      data-testid="comment-panel"
      aria-label="この画面へのコメント"
    >
      <h4 className="m-0 text-note">この画面へのコメント</h4>
      {/*
       * **【`V10-M32-T01`(2026-08-26)】文言を差し替えた。挙動は1バイトも変えていない。**
       *
       * **旧の文(逐語。1バイトも消していない)**:
       *   `直したいところを書いて送れます。送った内容をこの画面で読み返すことは今日できません ——`
       *   `読む口がまだ1本もないためです。`
       *
       * **旧の文は今日の正ではない** —— **読む場所ができた**(`web/src/CommentList.tsx`)。
       * **ただし読み返す場所はこの欄ではなく、作業画面の「コメント」の導線の先である。**
       * **そこまで書かないと、この欄を見つめて待つ人が出る。**
       */}
      <p className="m-0 text-note text-muted-foreground">
        直したいところを書いて送れます。送った内容はこの欄には出ません ——
        読み返すのは、画面の上にある「コメント」の導線から開くコメントの一覧です。
      </p>
      <Textarea
        data-testid="comment-body"
        aria-label="コメントの本文"
        value={body}
        rows={3}
        onChange={(event) => {
          setBody(event.target.value);
          if (state.status !== "idle") {
            setState({ status: "idle" });
          }
        }}
      />
      <div className="flex">
        <Button
          type="button"
          data-testid="comment-submit"
          disabled={state.status === "sending"}
          onClick={send}
        >
          送る
        </Button>
      </div>
      {state.status === "sent" ? (
        <Alert data-testid="comment-sent">
          コメントを受け付けました。返事はこの画面には出ません。
        </Alert>
      ) : null}
      {state.status === "failed" ? <ErrorList errors={state.errors} /> : null}
    </section>
  );
}
