/**
 * **招待が今使えるかの述語**(`V8-M2-T05` / 台帳 `I-G15` / `I-G16` / `ADR-0336`)。
 *
 * ## なぜ `store.ts` の中ではなく、この1ファイルなのか
 *
 * **期限の判定は `src/auth/challenge.ts` の {@link isExpired} 1本だけが持つ**
 * (`ADR-0336` 限定15)。 **ところが `challenge.ts` は `store.ts` を import しているので、
 * `store.ts` から `challenge.ts` を import すると循環になる。**
 * **したがって述語だけをこの層に置いた** —— **import の向きは
 * `invitations.ts` → `challenge.ts` → `store.ts` の一方通行である。**
 *
 * **判定関数を2本目に増やしていない**(`isExpired` を呼ぶだけである)。
 *
 * ## **`V8-M2` の時点で在るのは「使えない招待を出せる状態」である**
 *
 * **引き換え(この述語を登録経路に配線して、実際に登録を通すこと)は `V8-M3` が作る。**
 * **`signupAllowed`(`src/server/auth-routes.ts`)の `invited` 引数は、今日も常に `false`
 * である。** **【禁止】この中間状態を「一時的だから問題ない」と書かない。**
 *
 * ## **【2026-08-14 訂正(`V8-M4-T03`。裁定 `M4-3`)。上の節を1バイトも消していない】**
 *
 * **上の節は今日は偽である。** **`V8-M3` が引き換えの経路を作った** ——
 * **{@link findUsableInvitation} は `invitationFrom`(`src/server/auth-routes.ts`)から
 * 呼ばれ、`signupAllowed` の `invited` 引数には `invitation !== undefined` が渡る。**
 * **したがって「使えない招待を出せる状態」は今日は在らない。**
 * **ただし画面(`web/`)はまだ招待コードの入力欄を持たない**(`V8-M5` の担当)。
 *
 * ## 測っていないこと(誇張しない)
 *
 * - **コードの照合は素の文字列比較である。** **時間差(タイミング)を測っていない。**
 * - **大文字小文字を正規化していない。** **運営者が伝えたコードを小文字で打ち込むと通らない。**
 *   **`ADR-0336` は正規化を1文字も定めていないので、決めずに素のまま照合している。**
 */

import { isExpired } from "./challenge.ts";
import type { AuthStore } from "./store.ts";
import type { Invitation } from "./types.ts";

export { INVITATION_CODE_ALPHABET, INVITATION_TTL_SEC, randomInvitationCode } from "./store.ts";

/**
 * **その招待が今使えるか**(**未使用** かつ **期限内**)。
 *
 * **コードは見ていない** —— **コードの照合は {@link findUsableInvitation} が行う。**
 */
export function invitationIsUsable(invitation: Invitation): boolean {
  return invitation.usedAt === null && !isExpired(invitation.expiresAt);
}

/**
 * **(ログイン名 + コード)の組で、今使える招待を引く。** 引けなければ `undefined`。
 *
 * **落ちる理由を戻り値で区別していない** —— **「そんな招待は無い」「コードが違う」
 * 「期限切れ」「使用済み」がすべて `undefined` になる。** **`I-G23`(失敗の文面を漏らさない)
 * は本タスクの担当ではないが、区別を持たない形にしておけば、後から漏らしようがない。**
 *
 * **`D-V8-1` の逐語「2つを一緒に入れて」がこの引数2本である** ——
 * **コードだけでは1件も引けない。**
 */
export function findUsableInvitation(
  store: AuthStore,
  username: string,
  code: string,
): Invitation | undefined {
  const invitation = store.findInvitation(username);
  if (invitation === undefined) {
    return undefined;
  }
  if (invitation.code !== code) {
    return undefined;
  }
  return invitationIsUsable(invitation) ? invitation : undefined;
}
