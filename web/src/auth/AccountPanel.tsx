/**
 * アカウント(本人のパスワード変更と退会)の画面(`E-G68` / V4-M6)。
 *
 * **着手前は、パスワードの変更も、忘れたときの再設定も、退会も画面から1つもできなかった**
 * (サーバにもルートが無かった。02 §5-10 `E-G68`)。**本画面が扱うのは「本人がやり直せる
 * 2本」だけである。**
 *
 * ## この画面が扱わないもの(**書ける以上に主張しないために明記する**)
 *
 * - **忘れたときの再設定** —— **この製品にメールを送る経路が1本も無い**ので、本人確認の手段を
 *   作れない。ログイン画面に「パスワードをお忘れの方」は今日も無い。**「忘れても戻れる」とは
 *   書けない。**
 * - **運営による他人のパスワードの再発行** —— 他人の資格情報を書き換える権限を owner に与える
 *   変更であり、`E-G53` と同じ「線の引き直し」に当たる(審査の対象)。
 * - **Passkey の付け外し** —— 退会では credentials ごと消えるが、**個別に外す口は無い。**
 *
 * ## 退会で消えるもの・消えないもの(**サーバの `deleteUser` の doc と同じことを画面にも書く**)
 *
 * 消えるのはアカウント(`_auth_users` の1行)と資格情報とセッションだけである。
 * **その人が作った業務データ(そのアプリのテーブルに入っている行)は1行も消えない** ——
 * **所有者 id に一致するユーザが居なくなるので、誰にも見えなくなるだけである。**
 * **監査記録(`_auth_activity`)も1行も消えない**(ユーザ削除後も追跡できるようにするため)。
 * **画面にもそのとおり書く**(「退会すれば個人情報が消える」と読ませない)。
 *
 * 導線(このパネルを開くボタン)は `AppWorkspace` にあり、**ロールで出し分けていない** ——
 * 本人の資格情報の話であって、運営の権限の話ではないからである。
 *
 * ## 【V4-M15-T14】部品体系で組み直した(`ADR-0087`)
 *
 * **文言も `data-testid` も1バイトも変えていない。** 変えたのは器だけである:
 * 入力欄を `Input`、ラベルを `Label htmlFor` + `id` の対、操作を `Button`、
 * 成功表示(`account-password-changed`)と失敗表示(`account-error`)を `Alert` にした。
 * **成功表示の `role="status"` はそのまま残している**(`aria-live` を1つも足していない)。
 * **元に戻せない操作(退会)は `variant="destructive"` にした** —— **これは色の話であって、
 * 止めているわけではない。** 止めているのは今日も確認の1段だけである。
 */
import { type FormEvent, useState } from "react";
import { changePassword, deleteOwnAccount, type ValidationError } from "../api.ts";
import { toValidationErrors } from "../async.ts";
import { ErrorList } from "../ErrorList.tsx";
import { Button } from "../ui/button.tsx";
import { Input, Label } from "../ui/form-controls.tsx";
import { Alert, Card, Separator } from "../ui/surfaces.tsx";
import { cn } from "../ui/utils.ts";

export function AccountPanel({
  appId,
  username,
  onClose,
  onWithdrawn,
}: {
  appId: string;
  username: string;
  onClose?: () => void;
  /** 退会が成功したときに呼ぶ(呼び出し側がログイン画面へ戻す)。 */
  onWithdrawn: () => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<ValidationError[] | null>(null);
  const [done, setDone] = useState(false);
  /** 退会の確認待ち。**押した瞬間には消さない**(元に戻せない操作なので確認を挟む)。 */
  const [confirming, setConfirming] = useState(false);

  async function submitChange(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setErrors(null);
    setDone(false);
    try {
      await changePassword(appId, current, next);
      // **入力欄を空にする** —— 変更後のパスワードが画面に残ったままにしない。
      setCurrent("");
      setNext("");
      setDone(true);
    } catch (reason: unknown) {
      setErrors(toValidationErrors(reason));
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(): Promise<void> {
    setBusy(true);
    setErrors(null);
    try {
      await deleteOwnAccount(appId);
      onWithdrawn();
    } catch (reason: unknown) {
      setConfirming(false);
      setErrors(toValidationErrors(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className={cn("account-panel")} data-testid="account-panel">
      <header
        className={cn("account-panel-header", "flex flex-wrap items-center justify-between gap-s2")}
      >
        <h3 className={cn("m-0")}>アカウント({username})</h3>
        {onClose !== undefined && (
          <Button size="sm" variant="secondary" data-testid="close-account" onClick={onClose}>
            閉じる
          </Button>
        )}
      </header>

      <form className={cn("account-password-form", "flex flex-col gap-s2")} onSubmit={submitChange}>
        <h4 className={cn("m-0")}>パスワードの変更</h4>
        <div className={cn("flex flex-col gap-s1")}>
          <Label htmlFor="account-current-password">いまのパスワード</Label>
          <Input
            id="account-current-password"
            data-testid="account-current-password"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
        </div>
        <div className={cn("flex flex-col gap-s1")}>
          <Label htmlFor="account-new-password">新しいパスワード</Label>
          <Input
            id="account-new-password"
            data-testid="account-new-password"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
          />
        </div>
        <Button
          type="submit"
          variant="secondary"
          className="w-full sm:w-auto"
          data-testid="account-change-password"
          disabled={busy}
        >
          パスワードを変更する
        </Button>
        {/*
         * **成功表示**(`03` §4-1 の実測では着手前 0件)。**`role="status"` は既存のまま
         * である** —— `Alert` の既定(`role="alert"`)を上書きして残している
         * (**`aria-live` を1つも足していない**)。**文言は1文字も変えていない。**
         */}
        {done && (
          <Alert
            className={cn("account-done")}
            data-testid="account-password-changed"
            role="status"
          >
            パスワードを変更しました。他の端末のログインは切れます。
          </Alert>
        )}
      </form>

      <Separator />

      <div className={cn("account-withdraw", "flex flex-col gap-s2")}>
        <h4 className={cn("m-0")}>退会</h4>
        <p
          className={cn("account-note", "m-0 text-note text-muted-foreground")}
          data-testid="account-withdraw-note"
        >
          退会すると、このアカウントではログインできなくなります。
          <strong>これまでに作った記録そのものは消えません</strong>
          (持ち主が居なくなるので、どの画面にも出なくなります)。元に戻せません。
        </p>
        {confirming ? (
          <div
            data-testid="account-withdraw-confirm"
            className={cn("flex flex-col gap-s2 sm:flex-row")}
          >
            <Button
              variant="destructive"
              className="w-full sm:w-auto"
              data-testid="account-withdraw-execute"
              disabled={busy}
              onClick={() => {
                void withdraw();
              }}
            >
              退会する
            </Button>
            <Button
              variant="secondary"
              className="w-full sm:w-auto"
              data-testid="account-withdraw-cancel"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              やめる
            </Button>
          </div>
        ) : (
          <Button
            variant="destructive"
            className="w-full sm:w-auto"
            data-testid="account-withdraw"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            退会する
          </Button>
        )}
      </div>

      {/* **`ErrorList` が `Alert` を持つので、ここでは器を二重にしない。** */}
      {errors !== null && (
        <div data-testid="account-error" role="alert">
          <ErrorList errors={errors} />
        </div>
      )}
    </Card>
  );
}
