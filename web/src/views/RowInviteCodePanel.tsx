/**
 * **行の詳細画面の「この行の招待用コード」**(`V23-M6-T06b`。決定 `D-V23-153`・`D-V23-169`、`ADR-0538` §Decision 1-5)。
 *
 * - 呼び手(`DetailViewRenderer.tsx`)は、表がどこかの表の相手の行(`principal_row.table`)に指されているときだけこの部品を
 *   描く(指されていない表では口を呼ばない)。 **出すかどうかはコードを見る口の答えで決める**: 200 なら出し、それ以外
 *   (404・403・通信の失敗)は何も出さない(静かに。見られるのはその行の管理者と運営だけで、ほかの人には 404 が返る)。
 * - コードがまだ無ければ「まだ発行していません」と「発行」。 在ればコードと「再発行」。 **再発行は確かめてから**
 *   (再発行すると古いコードでは招待できなくなる。古いコードで出した招待と、それで渡した権限はそのまま)。
 * - 発行・再発行は同じ `POST` 1本(見る `GET` は書かない。`D-V23-169`)。
 *
 * **画面は判定を持たない。** 見られるか・発行できるかはサーバが決める。 部品にアプリを指す属性を書かない。
 * CSS のファイルは足さず、クラスは静的な Tailwind の綴りだけ。
 */
import { useCallback, useEffect, useState } from "react";
import { fetchRowInviteCode, reissueRowInviteCode, type ValidationError } from "../api.ts";
import { toValidationErrors } from "../async.ts";
import { ErrorList } from "../ErrorList.tsx";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/utils.ts";

/** 口の答え。 `hidden` = 200 以外(何も出さない)。 */
type CodeState =
  | { readonly status: "loading" }
  | { readonly status: "hidden" }
  | { readonly status: "ready"; readonly code: string | null };

export function RowInviteCodePanel({
  appId,
  tableId,
  recordId,
}: {
  appId: string;
  tableId: string;
  recordId: string;
}) {
  const [state, setState] = useState<CodeState>({ status: "loading" });
  const [confirming, setConfirming] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [errors, setErrors] = useState<ValidationError[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetchRowInviteCode(appId, tableId, recordId).then(
      (code) => {
        if (alive) {
          setState({ status: "ready", code });
        }
      },
      () => {
        // **静かに**: 見られない人(404)・下見(403)・通信の失敗のどれでも、部品を出さない。
        if (alive) {
          setState({ status: "hidden" });
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [appId, tableId, recordId]);

  const issue = useCallback(async () => {
    setIssuing(true);
    setErrors(null);
    try {
      const code = await reissueRowInviteCode(appId, tableId, recordId);
      setState({ status: "ready", code });
      setConfirming(false);
    } catch (reason: unknown) {
      setErrors(toValidationErrors(reason));
    } finally {
      setIssuing(false);
    }
  }, [appId, tableId, recordId]);

  if (state.status !== "ready") {
    return null;
  }
  const { code } = state;

  return (
    <section className={cn("flex flex-col gap-s2")} data-testid="row-invite-code">
      <h4 className={cn("m-0")}>この行の招待用コード</h4>
      <p className={cn("m-0", "text-sm text-muted-foreground")}>
        このコードを渡すと、相手はこの行を相手にした招待を出せます。招待を承諾すると、この行に属する人が相手の行を使えるようになります。
      </p>
      {code === null ? (
        <p className={cn("m-0")} data-testid="row-invite-code-none">
          まだ発行していません。
        </p>
      ) : (
        <p className={cn("m-0", "font-mono text-lg")} data-testid="row-invite-code-value">
          {code}
        </p>
      )}
      {code === null ? (
        <div>
          <Button
            size="sm"
            type="button"
            data-testid="row-invite-code-issue"
            disabled={issuing}
            onClick={() => void issue()}
          >
            発行
          </Button>
        </div>
      ) : confirming ? (
        <div className={cn("flex flex-col gap-s2")} data-testid="row-invite-code-confirm">
          <p className={cn("m-0", "text-sm font-medium")}>
            再発行すると、今のコードでは招待できなくなります。今のコードで出された招待と、それで渡した権限はそのまま残ります。再発行しますか。
          </p>
          <div className={cn("flex flex-wrap gap-s2")}>
            <Button
              size="sm"
              variant="destructive"
              type="button"
              data-testid="row-invite-code-confirm-yes"
              disabled={issuing}
              onClick={() => void issue()}
            >
              再発行する
            </Button>
            <Button
              size="sm"
              variant="secondary"
              type="button"
              data-testid="row-invite-code-confirm-no"
              disabled={issuing}
              onClick={() => setConfirming(false)}
            >
              やめる
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button
            size="sm"
            variant="secondary"
            type="button"
            data-testid="row-invite-code-reissue"
            onClick={() => setConfirming(true)}
          >
            再発行
          </Button>
        </div>
      )}
      {errors === null ? null : (
        <div data-testid="row-invite-code-errors">
          <ErrorList errors={errors} />
        </div>
      )}
    </section>
  );
}
