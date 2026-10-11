/**
 * **自分宛ての行の招待を受け取る画面**(`V23-M5-T06`。決定 `D-V23-126`・`D-V23-129`、門A `ADR-0532` §Decision 1-7・1-8)。
 *
 * - 場所は `/apps/<app_id>/invitations`(`Route` の `app` の印 `invitations`)。 メニューの「招待」は
 *   `workspace.invitations` を宣言したアプリだけに出す({@link invitationsMenuLabel})。 **宣言の無いアプリの画面は変えない。**
 * - 1件ごとに、サーバが返す6つの値のうち5つ(表の表示名・代表項目・招待者の表示名・権限の表示名・期限)を出し、
 *   「承諾」「辞退」を置く。 代表項目が `null`(受け手の役割で隠れている・空)なら「(表示できません)」。
 * - 【2026-09-30。`V23-M5-T11` の処置(`ADR-0537` §2)。上の行を消していない】サーバは今日は7つ目の値
 *   `changes_group`(承諾で所属グループが替わるか)を返す。 真の招待にだけ、承諾すると所属グループが替わり
 *   今のグループを通した権限が無くなることを1文で出す({@link INVITATION_CHANGES_GROUP_NOTE})。 グループの名前は出さない。
 * - 承諾・辞退は返答の口(`action`)。 **断り(403 の理由・422 のアプリの文言)はその招待の場所に出し、招待は残す。**
 *   成功すると一覧から消える。
 *
 * - 【2026-10-01。`V23-M6-T06b`(決定 `D-V23-155`・`D-V23-166`)の追記。上の行を消していない】コードの招待の1件には、
 *   サーバが8つ目の値 `principal_label`(宛先の行の代表項目)を付ける。 その1件にだけ「どの行として受けるか」を1行で出す
 *   (`null` なら「(表示できません)」)。 名前の招待にはキーが無いので、DOM は着手前と同じ。
 *
 * **画面は判定を持たない。** 承諾できるかを決めるのはサーバであり、ここは断りの文をそのまま出すだけである。
 * 育成用の版(`AppWorkspace.tsx`)と配る版(`runner-app.tsx`)の両方がこの1本を描く。 CSS のファイルは足さず、
 * クラスは静的な Tailwind の綴りだけ。
 */
import { useCallback, useEffect, useState } from "react";
import type { Manifest } from "../../src/kernel/types.ts";
import {
  APP_REJECTED_KIND,
  ApiError,
  answerRowInvitation,
  fetchMyRowInvitations,
  type MyRowInvitation,
  type ValidationError,
} from "./api.ts";
import { toValidationErrors } from "./async.ts";
import { ErrorList } from "./ErrorList.tsx";
import { Button } from "./ui/button.tsx";
import { Card } from "./ui/surfaces.tsx";
import { cn } from "./ui/utils.ts";

/** メニューの「招待」の文言(`workspace.invitations.label`)。 宣言が無ければ `undefined`(= 出さない)。 */
export function invitationsMenuLabel(manifest: Manifest | undefined): string | undefined {
  const declared = manifest?.app?.workspace?.invitations;
  if (declared === undefined || declared === null) {
    return undefined;
  }
  return typeof declared.label === "string" && declared.label !== "" ? declared.label : "招待";
}

/** 承諾で所属グループが替わる招待に添える文(`V23-M5-T11`)。 */
const INVITATION_CHANGES_GROUP_NOTE =
  "承諾すると所属グループが替わり、今のグループを通した権限は無くなります。";

/** 代表項目が出せないときの文言。 */
export const INVITATION_REPRESENTATIVE_HIDDEN = "(表示できません)";

/** 期限を利用者の時計の `YYYY-MM-DD HH:MM` にする(読めない値はそのまま)。 */
export function formatInvitationDeadline(expiresAt: string): string {
  const at = new Date(expiresAt);
  if (Number.isNaN(at.getTime())) {
    return expiresAt;
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

type InboxState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly errors: ValidationError[] }
  | { readonly status: "ready"; readonly items: readonly MyRowInvitation[] };

export function InvitationInbox({ appId, label }: { appId: string; label: string }) {
  const [state, setState] = useState<InboxState>({ status: "loading" });
  /** 招待ごとの断り(その招待の場所に出す)。 */
  const [refusals, setRefusals] = useState<Readonly<Record<string, ValidationError[]>>>({});
  /** 押している最中の招待。 */
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchMyRowInvitations(appId).then(
      (items) => {
        if (alive) {
          setState({ status: "ready", items });
        }
      },
      (reason: unknown) => {
        if (!alive) {
          return;
        }
        // **【`V23-M5-T10`】`workspace.invitations` だけを宣言し、表に招待の宣言が1つも無いアプリでは、
        // 自分宛ての一覧の口が 404 になる**(口は表の宣言で開く)。 届く招待は1件も無いので、
        // 口の 404 の文(開発者向け)を出さず、空の文にする。 ほかの失敗は今日どおり断りを出す。
        if (reason instanceof ApiError && reason.status === 404) {
          setState({ status: "ready", items: [] });
          return;
        }
        setState({ status: "error", errors: toValidationErrors(reason) });
      },
    );
    return () => {
      alive = false;
    };
  }, [appId]);

  const answer = useCallback(
    async (invitation: MyRowInvitation, action: "accept" | "decline") => {
      setPending(invitation.id);
      setNotice(null);
      setRefusals((current) =>
        Object.fromEntries(Object.entries(current).filter(([id]) => id !== invitation.id)),
      );
      try {
        await answerRowInvitation(appId, invitation.id, action);
        setState((current) =>
          current.status === "ready"
            ? {
                status: "ready",
                items: current.items.filter((item) => item.id !== invitation.id),
              }
            : current,
        );
        setNotice(action === "accept" ? "招待を承諾しました。" : "招待を辞退しました。");
      } catch (reason: unknown) {
        // **【`V23-M12-T05`。`D-V23-360` の (7)】アプリが決めた理由の断り(`422` と `kind: "app_rejected"`)は、
        // 項目の綴り(位置)を前に付けない(位置だけを空にする。文と添える文は今日どおり)。 製品の断りは今日どおり。
        // 旧の1行(逐語): `const errors = toValidationErrors(reason);`
        const errors =
          reason instanceof ApiError && reason.kind === APP_REJECTED_KIND
            ? reason.errors.map((error) => ({ ...error, path: "" }))
            : toValidationErrors(reason);
        setRefusals((current) => ({ ...current, [invitation.id]: errors }));
      } finally {
        setPending(null);
      }
    },
    [appId],
  );

  return (
    <section className={cn("flex flex-col gap-s3")} data-testid="invitation-inbox">
      <h3 className={cn("m-0")}>{label}</h3>
      {notice === null ? null : (
        <p className={cn("m-0")} data-testid="invitation-inbox-notice" role="status">
          {notice}
        </p>
      )}
      {state.status === "loading" ? (
        <p className={cn("m-0", "text-muted-foreground")}>読み込み中…</p>
      ) : state.status === "error" ? (
        <div data-testid="invitation-inbox-load-error">
          <ErrorList errors={state.errors} />
        </div>
      ) : state.items.length === 0 ? (
        <p className={cn("m-0", "text-muted-foreground")} data-testid="invitation-inbox-empty">
          届いている招待はありません。
        </p>
      ) : (
        <ul className={cn("m-0 flex flex-col gap-s2 p-0")}>
          {state.items.map((invitation) => {
            const refused = refusals[invitation.id];
            return (
              <li
                key={invitation.id}
                className={cn("list-none")}
                data-testid="invitation-inbox-item"
              >
                <Card className={cn("flex flex-col gap-s2 p-s3")}>
                  <p className={cn("m-0", "text-sm text-muted-foreground")}>
                    <span data-testid="invitation-inbox-table">{invitation.table_name}</span>
                  </p>
                  <p className={cn("m-0", "font-medium")}>
                    <span data-testid="invitation-inbox-representative">
                      {invitation.representative ?? INVITATION_REPRESENTATIVE_HIDDEN}
                    </span>
                  </p>
                  {invitation.principal_label === undefined ? null : (
                    <p className={cn("m-0", "text-sm")} data-testid="invitation-inbox-principal">
                      受ける行: {invitation.principal_label ?? INVITATION_REPRESENTATIVE_HIDDEN}
                    </p>
                  )}
                  <dl className={cn("m-0 flex flex-wrap gap-x-s3 gap-y-s1", "text-sm")}>
                    <div className={cn("flex gap-s1")} data-testid="invitation-inbox-inviter">
                      <dt>招待した人:</dt>
                      <dd className={cn("m-0")}>{invitation.inviter_name}</dd>
                    </div>
                    <div className={cn("flex gap-s1")} data-testid="invitation-inbox-permission">
                      <dt>権限:</dt>
                      <dd className={cn("m-0")}>{invitation.permission_name}</dd>
                    </div>
                    <div className={cn("flex gap-s1")} data-testid="invitation-inbox-expires">
                      <dt>期限:</dt>
                      <dd className={cn("m-0")}>
                        {formatInvitationDeadline(invitation.expires_at)}
                      </dd>
                    </div>
                  </dl>
                  {invitation.changes_group === true ? (
                    <p
                      className={cn("m-0", "text-sm font-medium")}
                      data-testid="invitation-inbox-changes-group"
                    >
                      {INVITATION_CHANGES_GROUP_NOTE}
                    </p>
                  ) : null}
                  <div className={cn("flex flex-wrap items-center gap-s2")}>
                    <Button
                      size="sm"
                      type="button"
                      data-testid="invitation-accept"
                      disabled={pending === invitation.id}
                      onClick={() => void answer(invitation, "accept")}
                    >
                      承諾
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      type="button"
                      data-testid="invitation-decline"
                      disabled={pending === invitation.id}
                      onClick={() => void answer(invitation, "decline")}
                    >
                      辞退
                    </Button>
                  </div>
                  {refused === undefined ? null : (
                    <div data-testid="invitation-inbox-error" role="alert">
                      <ErrorList errors={refused} />
                    </div>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
