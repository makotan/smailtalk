/**
 * **行の詳細画面の「招待する」と、その行の未承諾の招待の一覧**(`V23-M5-T06`。決定 `D-V23-116`・`D-V23-127`・`D-V23-129`、
 * 門A `ADR-0532` §Decision 1-8)。
 *
 * - 呼び手(`DetailViewRenderer.tsx`)は、表が招待を宣言しているときだけこの部品を描く(宣言の無い表では口を呼ばない。
 *   計画 §24-6 中8)。 **出すかどうかは行の招待の一覧の口の答えで決める**: 200 なら出し、それ以外(404・403・通信の失敗)は
 *   何も出さない(静かに。下見の画面の 403 も同じ。計画 §24-6 軽8)。 行のアクセスの型 `RowAccess` にキーを足さない。
 * - 発行は相手のログイン名と、`grantable` の権限の1つ。 **発行の後は、相手の名前が在っても無くても同じ「招待しました」**
 *   (サーバの応答が同じなので、画面も同じにする。`D-V23-122`)。 入力の誤り(400)だけは理由を出す。
 * - 未承諾の招待ごとに、ログイン名・権限・招待した人・期限と「取り消す」。 取消は返答の口の `action: "revoke"`。
 *
 * 【2026-10-01。`V23-M6-T06b`(決定 `D-V23-154`・`D-V23-156`)の追記。上の行を消していない】
 * - 守る表が相手の行(`principal_row`)を宣言しているとき(呼び手が `byCode` を渡すとき)だけ、相手をログイン名で
 *   指すかコード(相手の行の招待用コード)で指すかを切り替えられる。 コードで出すと相手の行を招待する
 *   (本文は `{code, permission}`)。 応答はコードが在っても無くても同じなので、画面も同じ「招待しました」。
 * - 未承諾の一覧で、コードの招待の1件はサーバが返す相手の行の代表項目(`principal_label`)で出す
 *   (隠れている・行が無ければ「(表示できません)」)。
 * - `byCode` を渡さなければ、DOM は着手前と1バイトも同じ。
 *
 * **画面は判定を持たない。** 招待できるか・取り消せるかはサーバが決める。 部品にアプリを指す属性を書かない
 * (`D-V23-134` (3))。 CSS のファイルは足さず、クラスは静的な Tailwind の綴りだけ。
 */
import { useCallback, useEffect, useId, useState } from "react";
import {
  answerRowInvitation,
  fetchRowInvitations,
  issueRowInvitation,
  issueRowInvitationByCode,
  type RowInvitationList,
  type ValidationError,
} from "../api.ts";
import { toValidationErrors } from "../async.ts";
import { ErrorList } from "../ErrorList.tsx";
import { formatInvitationDeadline, INVITATION_REPRESENTATIVE_HIDDEN } from "../InvitationInbox.tsx";
import { Button } from "../ui/button.tsx";
import { Input, Label, Select } from "../ui/form-controls.tsx";
import { cn } from "../ui/utils.ts";

export function RowInvitationsPanel({
  appId,
  tableId,
  recordId,
  byCode,
}: {
  appId: string;
  tableId: string;
  recordId: string;
  /** 【`V23-M6-T06b`】守る表が相手の行を宣言しているときだけ `true`(ログイン名とコードを切り替えられる)。 */
  byCode?: boolean;
}) {
  /** `null` = まだ答えが無い、または 200 以外(何も出さない)。 */
  const [list, setList] = useState<RowInvitationList | null>(null);
  const [login, setLogin] = useState("");
  /** 【`V23-M6-T06b`】相手の指し方(`byCode` のときだけ切り替えられる)と、コードの入力。 */
  const [mode, setMode] = useState<"login" | "code">("login");
  const [code, setCode] = useState("");
  const [permission, setPermission] = useState("");
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState(false);
  const [errors, setErrors] = useState<ValidationError[] | null>(null);
  const [revokeErrors, setRevokeErrors] = useState<ValidationError[] | null>(null);
  const loginFieldId = useId();
  const permissionFieldId = useId();
  const modeFieldId = useId();
  const codeFieldId = useId();

  const reload = useCallback(async (): Promise<RowInvitationList | null> => {
    try {
      return await fetchRowInvitations(appId, tableId, recordId);
    } catch {
      // **静かに**: 招待できない人(404)・下見(403)・通信の失敗のどれでも、部品を出さない。
      return null;
    }
  }, [appId, tableId, recordId]);

  useEffect(() => {
    let alive = true;
    void reload().then((next) => {
      if (alive) {
        setList(next);
        setPermission((current) => current || (next?.grantable[0]?.id ?? ""));
      }
    });
    return () => {
      alive = false;
    };
  }, [reload]);

  const submit = useCallback(async () => {
    setIssuing(true);
    setIssued(false);
    setErrors(null);
    try {
      if (byCode === true && mode === "code") {
        await issueRowInvitationByCode(appId, tableId, recordId, code, permission);
        setCode("");
      } else {
        await issueRowInvitation(appId, tableId, recordId, login, permission);
        setLogin("");
      }
      setIssued(true);
      const next = await reload();
      if (next !== null) {
        setList(next);
      }
    } catch (reason: unknown) {
      setErrors(toValidationErrors(reason));
    } finally {
      setIssuing(false);
    }
  }, [appId, tableId, recordId, login, permission, reload, byCode, mode, code]);

  const revoke = useCallback(
    async (invitationId: string) => {
      setRevokeErrors(null);
      try {
        await answerRowInvitation(appId, invitationId, "revoke");
        setList((current) =>
          current === null
            ? current
            : { ...current, pending: current.pending.filter((row) => row.id !== invitationId) },
        );
      } catch (reason: unknown) {
        setRevokeErrors(toValidationErrors(reason));
      }
    },
    [appId],
  );

  if (list === null) {
    return null;
  }
  const permissionName = (id: string) =>
    list.grantable.find((candidate) => candidate.id === id)?.name ?? id;

  return (
    <section className={cn("flex flex-col gap-s2")} data-testid="row-invitations">
      <h4 className={cn("m-0")}>この行に招待する</h4>
      <div className={cn("flex flex-wrap items-end gap-s2")}>
        {byCode === true ? (
          <div className={cn("flex flex-col gap-s1")}>
            <Label htmlFor={modeFieldId}>相手の指し方</Label>
            <Select
              id={modeFieldId}
              data-testid="row-invitation-mode"
              value={mode}
              onChange={(event) => setMode(event.target.value === "code" ? "code" : "login")}
            >
              <option value="login">ログイン名で招待する</option>
              <option value="code">相手の行のコードで招待する</option>
            </Select>
          </div>
        ) : null}
        {byCode === true && mode === "code" ? (
          <div className={cn("flex flex-col gap-s1")}>
            <Label htmlFor={codeFieldId}>相手の行のコード</Label>
            <Input
              id={codeFieldId}
              data-testid="row-invitation-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </div>
        ) : (
          <div className={cn("flex flex-col gap-s1")}>
            <Label htmlFor={loginFieldId}>相手のログイン名</Label>
            <Input
              id={loginFieldId}
              data-testid="row-invitation-login"
              value={login}
              onChange={(event) => setLogin(event.target.value)}
            />
          </div>
        )}
        <div className={cn("flex flex-col gap-s1")}>
          <Label htmlFor={permissionFieldId}>渡す権限</Label>
          <Select
            id={permissionFieldId}
            data-testid="row-invitation-permission"
            value={permission}
            onChange={(event) => setPermission(event.target.value)}
          >
            {list.grantable.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </Select>
        </div>
        <Button
          size="sm"
          type="button"
          data-testid="row-invitation-submit"
          disabled={issuing}
          onClick={() => void submit()}
        >
          招待する
        </Button>
      </div>
      {issued ? (
        <p className={cn("m-0")} data-testid="row-invitation-issued" role="status">
          招待しました。相手が承諾すると、この行を使えるようになります。
        </p>
      ) : null}
      {errors === null ? null : (
        <div data-testid="row-invitation-errors">
          <ErrorList errors={errors} />
        </div>
      )}
      <h5 className={cn("m-0")}>承諾を待っている招待</h5>
      {list.pending.length === 0 ? (
        <p
          className={cn("m-0", "text-muted-foreground")}
          data-testid="row-invitation-pending-empty"
        >
          承諾を待っている招待はありません。
        </p>
      ) : (
        <ul className={cn("m-0 flex flex-col gap-s1 p-0")}>
          {list.pending.map((row) => (
            <li
              key={row.id}
              className={cn("flex list-none flex-wrap items-center gap-s2", "text-sm")}
              data-testid="row-invitation-pending-item"
            >
              {row.principal_label === undefined ? (
                <span>{row.login}</span>
              ) : (
                <span data-testid="row-invitation-pending-principal">
                  相手の行: {row.principal_label ?? INVITATION_REPRESENTATIVE_HIDDEN}
                </span>
              )}
              <span>権限: {permissionName(row.permission)}</span>
              <span>招待した人: {row.inviter_name}</span>
              <span>期限: {formatInvitationDeadline(row.expires_at)}</span>
              <Button
                size="sm"
                variant="secondary"
                type="button"
                data-testid="row-invitation-revoke"
                onClick={() => void revoke(row.id)}
              >
                取り消す
              </Button>
            </li>
          ))}
        </ul>
      )}
      {revokeErrors === null ? null : (
        <div data-testid="row-invitation-revoke-errors">
          <ErrorList errors={revokeErrors} />
        </div>
      )}
    </section>
  );
}
