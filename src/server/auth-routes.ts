/**
 * 認証エンドポイント(V1-M3-T01 / ADR-0014 §6 / 計画 v3・アプリ単位認証)。
 *
 * パスは **`/api/apps/:app_id/auth/*`**。各 handler は `app_id` を取り、その**アプリの
 * app.sqlite 内**の `_auth_*` テーブルを `AuthStore.openForApp(dataRoot, appId)` で開いて
 * 処理する(ユーザ・セッション・資格情報はアプリごとに独立)。app が存在しなければ 404。
 *
 * 実処理はすべて `src/auth/` の公開 API に委譲する(このファイルは「HTTP ⇄ 認証コア」の
 * 変換とセッション cookie の出し入れだけを担う)。JSON 契約はフロント(`web/src/auth/`)と
 * E2E が共有する確定版である。すべてのエラーは統一形式 `{ errors: [ValidationError] }`。
 *
 * ## Cookie の Path スコープ(計画 v3 §Cookie 設計)
 * `st_session` / `st_pending` はいずれも **Path=/api/apps/:app_id** で発行する。これにより
 * アプリごとに cookie が分離し、複数アプリへ同時ログインできる(ブラウザは Path 前置一致で
 * 該当アプリの配下にだけ cookie を送る)。削除も同じ Path で行う。
 *
 * ## チャレンジの流儀(ADR-0014 §4)
 * `buildRegistrationOptions` / `buildAuthenticationOptions` が challenge を生成して返す。
 * 返った `options.challenge` を `store.savePendingChallenge` に保存し、verify には
 * その同じ値を `expectedChallenge` として渡す(自前で challenge を注入しない=二重エンコード回避)。
 * pending の id は短命 cookie `st_pending` で往復させる。
 *
 * ## セッション固定対策(ADR-0014 §3)
 * ログイン・登録の成功経路はいずれも `issueSession` で**新規**セッションを発行し、
 * `st_session` を再セットする。pending は verify 時に必ず消費(取得即削除)+ cookie 削除する。
 */
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AuthConfig } from "../auth/config.ts";
// **【`V8-M3-T02` / 台帳 `I-G20` / `ADR-0337` 限定13】招待の照合は既存の1本を呼ぶ。**
// **2本目の照合関数をこのファイルに書かない**(`ADR-0337` §3-1 の逐語)。
import {
  findUsableInvitation,
  INVITATION_REVOKED_PREFIX,
  invitationState,
} from "../auth/invitations.ts";
import {
  buildAuthenticationOptions,
  buildRegistrationOptions,
  verifyAuthentication,
  verifyRegistration,
} from "../auth/passkey.ts";
import { hashPassword, verifyPassword } from "../auth/password.ts";
import { issueSession, resolveSession, revokeSession } from "../auth/session.ts";
import {
  AuthStore,
  InvitationUnavailableError,
  LastGranterError,
  LastOwnerError,
  randomId,
} from "../auth/store.ts";
import {
  type ChallengePurpose,
  DEFAULT_USER_KIND,
  /** **招待1件**(`V8-M2-T04` / 台帳 `I-G9`。`ADR-0336`)。 */
  type Invitation,
  // **【`V8-M27-T04` / `D-V8-72`】`isReservedRole` の import は撤去した**
  // (このファイルの2箇所 = セルフサインアップの歯止めと、その hint 分岐ごと消えた)。
  // **`RESERVED_ROLES` は残る** —— `reservedRoleValues()` が値域として返し続ける。
  type PendingChallenge,
  RESERVED_ROLES,
  type Role,
  type Session,
  type User,
} from "../auth/types.ts";
import type { AiCapability, AiProviderKind } from "../kernel/ai-capability-store.ts";
import { AiCapabilityStore } from "../kernel/ai-capability-store.ts";
import type { Connection } from "../kernel/capability-store.ts";
import { CapabilityStore } from "../kernel/capability-store.ts";
// **【`V10-M11-T01` / 台帳 `CM-G4`(**門外**(`Δ7`)/ 限定採用)】コメントの器を**呼ぶだけ**である。**
// **`src/kernel/comment-store.ts` は1バイトも変えていない**(`CM-G4` 限定4 = 門外の主張の
// 唯一の機械的な担保)—— **`CommentStore` と `addComment` は `V10-M10-T01` が `CM-G1` /
// `CM-G3` の門A(`Δ8`)/ 限定採用として通したものである**(`ADR-0007` §1d 歯止め2 の (a))。
import type { Comment } from "../kernel/comment-store.ts";
import { CommentStore } from "../kernel/comment-store.ts";
import type { EscapeHatchAsset } from "../kernel/escape-hatch-store.ts";
import { EscapeHatchStore, putEscapeHatchBody } from "../kernel/escape-hatch-store.ts";
// **【`V8-M41` / 台帳 `F-G14` / `ADR-0332`】受信口の**発行**を1本だけ結線する。**
// **`src/kernel/inbound-store.ts` は1バイトも変えていない** —— **`issueInboundEndpoint` は
// `ADR-0041`(`V2-M5-T01`)が既に置いたものであり、ここは**呼ぶだけ**である。**
// **`ADR-0007` §1d の歯止め2 の帰属先 = `InboundStore.issueInboundEndpoint` / 出自 `ADR-0041`
// (その追加自体が門A を通っている。`docs/plan/v2/records/v2-m5-gate-a-inbound.md:77` / `:141`)。**
import type { InboundEndpoint } from "../kernel/inbound-store.ts";
import { InboundStore } from "../kernel/inbound-store.ts";
import type { InboundSignatureFormat, InboundSignatureHeader } from "../kernel/inbound-verify.ts";
import type { ValidationError } from "../kernel/index.ts";
import type { SecretSource } from "../kernel/secret-resolver.ts";
import type { AuthEnv, AuthUser } from "./auth-context.ts";
// **【`V10-M15-T05` / `CM-G21` / `ADR-0370`】「誰に見えるか」の合成は1本だけを呼ぶ**
// (判定の家を2軒目にしない)。**`judgeRoleAccess` をこの口が直に呼ばない。**
import { declaresNoRules, visibleComments } from "./comment-visibility.ts";
// **【`V8-M28` 第2波】配布の不変条件2本の判定**(台帳 `T-G20`。`ADR-0305` 限定3 =
// **判定の家は1本**)。**同じファイルに `judgeGrantWrite`(`U-2` を塞いだ関数)が住んでいる。**
import { judgeRoleAssignment } from "./owner-scope.ts";

/** 認証ルートが依存するもの(app スコープで用意して注入する)。 */
export type AuthRouteDeps = {
  authConfig: AuthConfig;
  /** データルート(`data/` 相当)。app_id ごとに `openForApp(dataRoot, appId)` する。 */
  dataRoot: string;
  /** アプリの実在確認。実在すれば null、しなければ 404 用のエラー(app.ts と共有)。 */
  ensureApp: (appId: string) => ValidationError | null;
  /**
   * **逃げ道(任意 CSS)の資産の発行・失効・一覧・申請一覧の4本を登録するか**
   * (`V5-M3b` / `D-V5-96`。2026-08-06)。
   *
   * **`false` を渡すのは実行専用の起動プロファイル(`profile: "runner"`)だけである。**
   * **`D-V5-96` は「配った先で運営者に残す口」から**見た目の手直しを外した** ——
   * **残るのは利用者の管理3本 / 外部との連携4本 / AI の能力5本の計12本である。**
   *
   * **【禁止】「編集の口を全部外した」と読まないこと** —— **12本が残る。**
   * **【禁止】「逃げ道CSSが効かなくなる」と読まないこと** —— **落とすのは発行・失効の口で
   * あって、既に発行済みの CSS を配る口
   * (`GET /api/apps/:app_id/views/:view_id/custom.css`。`app.ts` 側)は1本も落としていない。**
   *
   * **必須にしてある**(`?` を付けない)。**省略できると、新しい呼び出し側が黙って
   * 登録する側に倒れる。**
   */
  escapeHatchAssetRoutes: boolean;
  /**
   * **【2026-08-11。`V8-M29` 第2波 / 台帳 `T-G9a`。判定値 = 廃止】**
   * **ここに在った `userKindIds: (appId: string) => readonly string[];` を取り除いた。**
   * **注入元(`src/server/app.ts`)の `effectiveUserKindIds` ごと消えたためである。**
   * **代わりに立つのは下の {@link AuthRouteDeps.roleIds} である**(`ADR-0301` 限定2)。
   */
  /**
   * **そのアプリが宣言した役割の識別子の一覧**(`V8-M29` 第1波 / 台帳 `T-G10`)。
   *
   * **宣言が無ければ空配列** —— **そのとき値域は着手前と1文字も変わらない**
   * ({@link assignableRoleValues} / {@link signupKindValues})。
   * **並びは宣言の順そのままで、予約4語も落とさずに渡ってくる** ——
   * **落とすのは値域を組む側の仕事である**(`owner` が既定の1本目になる穴を、
   * 落とす場所を1箇所に閉じて塞ぐため)。
   *
   * **`userKindIds` と同じ理由でここに注入している** —— **マニフェストを読むのは
   * `app.ts` の側であり、認証ルートはカーネルの読取 API を1本も知らない。**
   * **読み方の本体は `src/server/owner-scope.ts` の `declaredRoleIds` 1本である。**
   */
  roleIds: (appId: string) => readonly string[];
  /**
   * **そのアプリで `signup: "invite"` が書かれた役割の識別子の一覧**
   * (`V8-M1-T04`。台帳 `I-G1` / `I-G6` / `I-G5` / `I-G26`。`ADR-0334` / `ADR-0335`)。
   *
   * **宣言が無ければ空配列** —— **そのとき登録の応答は着手前と1バイトも変わらない**
   * (`I-G3` / `ADR-0335` 限定4)。
   * **並びは宣言の順そのままで、予約4語も落とさずに渡ってくる** ——
   * **どう読むかは {@link signupAllowed} が経路ごとに決める**(`ADR-0334` 限定14)。
   *
   * **{@link AuthRouteDeps.roleIds} とまったく同じ形にしてある** —— **マニフェストを
   * 読むのは `app.ts` の側であり、認証ルートはカーネルの読取 API を1本も知らない**
   * (着手前からの層の分け方を1ミリも変えない)。
   * **読めないアプリでは空に倒す** —— **認証経路を 500 にせず、着手前と同じところへ
   * 落とす**(`roleIds` と同じ向き。**閉じる側には倒さない**)。
   *
   * **【`src/server/owner-scope.ts` の `export` を1つも増やしていない】**
   * (`ADR-0334` 限定8)—— **読み方は `app.ts` の注入の中にインラインで書いてある。**
   */
  inviteOnlyRoleIds: (appId: string) => readonly string[];
  /**
   * **その実効ロール集合が「人に役割を配る」ことを許されているか**
   * (`V8-M28` 第2波。台帳 `T-G18` / ユーザ決定 `D-V8-41` / `D-V8-49` / `D-V8-77`)。
   *
   * **判定そのものは `src/server/owner-scope.ts` の `judgeRoleAccess`
   * (`target: "role"` / `verb: "write"`)1本が持つ**(`ADR-0305` 限定3 = **判定の家は1本**)。
   * **ここへ渡ってくるのはその答え(真偽)だけである。**
   *
   * **`userKindIds` と同じ理由でここに注入している** —— **マニフェストを読むのは `app.ts`
   * の側であり、認証ルートはカーネルの読取 API を1本も知らない**(着手前からの層の
   * 分け方を1ミリも変えない)。
   *
   * **【この1本が掛かる口は2本ちょうどである】** —— **`PATCH .../auth/users/:user_id`
   * (役割を配る)と `GET .../auth/users`(人と役割の一覧)。** **残り8箇所の
   * `requireOwner` は1バイトも触っていない。**
   */
  canDistributeRoles: (appId: string, roles: readonly string[]) => boolean;
  /**
   * **そのアプリのマニフェスト(読めなければ `undefined`)**(`V10-M15-T05` / `CM-G21`)。
   *
   * **`readCurrentManifest` を `auth-routes.ts` に import しない** —— **理由は、層またぎの
   * 台帳(`scripts/kernel-import-snapshot.txt`)に1行も足さないためである。**
   * **`canDistributeRoles` / `roleIds` / `inviteOnlyRoleIds` とまったく同じ「注入」の形で
   * あり、新しい形を発明していない。**
   *
   * **読めないアプリでは `undefined` に倒す**(閉じる側。`canDistributeRoles` と同じ向き)。
   * **`roleIds` と違って開く側に倒さない** —— **開くと、読めないマニフェストのアプリで
   * 全件が見えてしまう**(`GET /api/apps/:app_id/comments` が {@link visibleComments} へ
   * この値を渡す)。
   */
  manifestFor: (appId: string) => unknown;
};

const PENDING_COOKIE = "st_pending";
const SESSION_COOKIE = "st_session";

/** cookie の Path スコープ(アプリ単位の分離)。 */
function cookiePath(appId: string): string {
  return `/api/apps/${appId}`;
}

/** ADR-0003 §3: エラーは常に `{ errors: [...] }`。 */
function errorBody(errors: ValidationError[]): { errors: ValidationError[] } {
  return { errors };
}

/**
 * 表示用のユーザ表現(cookie/セッションの外に出す最小限。role を含む: V1-M3-T02)。
 *
 * **【`V8-M16` / `J-G3`】実効ロール集合(`roles`)を足した。** **既存の `role`(列の1値)は
 * 1バイトも消していない** —— **列の値 = 既定の1本目であり、`roles[0]` に等しい。**
 * **`roles` は `store` から引く**(`{列の1値} ∪ {付与表}`)。
 */
function userView(
  store: AuthStore,
  user: Pick<User, "id" | "username" | "displayName" | "role">,
): AuthUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    roles: store.effectiveRoles(user.id),
  };
}

/**
 * 管理エンドポイント(owner 用)のユーザ表現。createdAt まで含める。
 *
 * **【`V8-M16` / `J-G3`】実効ロール集合(`roles`)を足した。** **一覧の口が N+1 を撃たない
 * よう、付与は呼び出し側が1度に読んで渡す**({@link AuthStore.roleGrantsByUser})。
 */
function userAdminView(
  user: User,
  grants: readonly Role[] = [],
): {
  id: string;
  username: string;
  displayName: string | null;
  role: Role;
  roles: Role[];
  createdAt: string;
} {
  const roles: Role[] = [user.role];
  for (const granted of grants) {
    if (!roles.includes(granted)) {
      roles.push(granted);
    }
  }
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    roles,
    createdAt: user.createdAt,
  };
}

/**
 * ロール語彙(管理 API の role バリデーション用)。`Role` 型 / `store.ts` の CHECK と
 * 併せて3箇所を同期し、`role-vocabulary-sync.test.ts` が同期を機械的に固定する
 * (V2-M1-T01 / ADR-0033 限定1)。`satisfies readonly Role[]` で「Role 外の文字列を
 * 載せられない」を、`as const` で「要素をリテラル union として観測できる」を両立させる。
 * 5番目のロールを足すには門A の新規審査 + 個別 ADR が要る(ADR-0033 §3a)。
 */
export function reservedRoleValues(): typeof RESERVED_ROLES {
  return RESERVED_ROLES;
}

/**
 * **そのアプリで受理するロールのうち、宣言に依らない土台**
 * (`V5-M17-T03` / `ADR-0158` 限定1・限定2 → `V8-M29` 第2波で引数を落とした)。
 *
 * **【2026-08-11。台帳 `T-G9a` / `T-G12`。判定値 = 廃止】旧(逐語)**:
 *
 *     export function roleValuesForKinds(kinds: readonly string[]): readonly Role[] {
 *       return [...RESERVED_ROLES, ...(kinds.length === 0 ? [DEFAULT_USER_KIND] : kinds)];
 *     }
 *
 * **引数 `kinds` の唯一の出所(`effectiveUserKindIds`)が本波で消えたので、引数を落とし、
 * 名前を `baseRoleValues` に改めた。** **戻りは着手前に `kinds` が空だったときとまったく
 * 同じ4値である** —— **`["owner","editor","viewer","customer"]`。**
 *
 * **【誇張しない。ここが本波の唯一の値域の変化である】** **着手前は `user_kinds` を
 * 宣言したアプリで `customer` が値域から**外れた**。** **今日は外れない** ——
 * **`customer` は常に入る。** **担い手は無い**(`ADR-0301` 限定6 の ④)。
 *
 * **`role-order-sync` の基準としての役目は、この関数がそのまま引き継ぐ**
 * (`web/test/role-order-sync.test.ts` が「宣言が無いアプリの4値」を作るのに使う)。
 *
 * ---
 *
 * ## **【2026-08-13。`V8-M38`。台帳 `F-G9`。判定値 = 限定採用(門外 `Δ7`)】**
 *
 * **上の doc を1バイトも書き換えていない。** **`DEFAULT_USER_KIND` の無条件追加をやめた。**
 *
 * **旧(逐語)**:
 *
 *     export function baseRoleValues(): readonly Role[] {
 *       return [...RESERVED_ROLES, DEFAULT_USER_KIND];
 *     }
 *
 * **したがって上の「戻りは …`["owner","editor","viewer","customer"]`」と
 * 「`customer` は常に入る」の2文は、今日から偽である。**
 * **今日の戻りは `["owner","editor","viewer"]`(予約3ロール)である。**
 *
 * **【なぜ変えたか】** **アプリが `customer` を1度も宣言していなくても、人に付けられる
 * 役割の一覧に入っていた。** **`V8-M26` が既定を閉じたので、宣言していない役割を人に
 * 付けると、その人はどの規則にも当たらない**(何も見えない・何もできない役割が
 * 付けられてしまう)。
 *
 * **【採らなかった側を書く】** **側β(`customer` を既定の役割として `app.roles` に
 * 入れる)は採らない** —— **`src/kernel/types.ts` の `DEFAULT_ROLE_IDS`(3語)が動き、
 * `Δ7`(門外)が壊れて門A に落ちる。** **`ADR-0318` 限定3 とも当たる。**
 *
 * **【射程は `customer` の1語だけである】** **`RESERVED_ROLES` の側を1バイトも
 * 触っていない。** **`anonymous` は着手前と同じく入らない**(`D-V8-80`。落としているのは
 * {@link customRoleIds} の側であり、本関数ではない)。
 *
 * **【消えていない道】** **アプリが `customer` を宣言していれば、{@link customRoleIds}
 * の側から今日どおり値域に入る**(`customer` は `RESERVED_ROLES` に入っていないので、
 * 予約語として落とされない)。
 *
 * **【`signupKindValues` には効かない】** **登録のときに名乗れる値を組む
 * {@link signupKindValues} は本関数を1度も呼ばず、`DEFAULT_USER_KIND` を自前で持つ** ——
 * **「登録で名乗れる値が0本になる」退行は起きない**(`role-value-domain.test.ts` の (8-e))。
 */
export function baseRoleValues(): readonly Role[] {
  return [...RESERVED_ROLES];
}

// =====================================================================================
// **【`V8-M29` 第1波(2026-08-11)。台帳 `T-G10` / ユーザ決定 `D-V8-78` / `D-V8-80`】**
// **「人に付けられる値」と「登録で名乗れる値」の出所に `app.roles[].id` を立てる**
// =====================================================================================
//
// **上の `roleValuesForKinds` を1バイトも書き換えていない。** **撤去は次の波である** ——
// **`user_kinds` / `set_user_kinds` はこの波では1バイトも消していない。**
//
// **【「差し替え」ではなく「和」にした理由を、丸めずに書く】**
// **台帳 `T-G10` の帰属先は「`roleValuesForKinds` の引き先を `app.roles[].id` へ差し替える」
// である。** **本波はその出所を**足した**が、`user_kinds` 側の出所を**落としていない**。**
// **理由は1点である** —— **`user_kinds` は今日も語彙に在り、それを書いた既存のアプリは
// 今日どおり動かなければならない**(この波の禁止事項)。**落とす一手は撤去の波が持つ。**
// **【禁止】これを「差し替えた」と書かない。** **今日の値域は両方の和である。**
//
// **【`anonymous` を必ず除く】**(`T-G10` の限定3 / `D-V8-80`)——
// **`anonymous` を主体にした規則は未ログイン向けに書かれる。** **ログイン済みの人が
// その役割を名乗ると、未ログイン向けの規則がログイン済みの誰かに当たり、判定の向きが
// 逆になる。** **除くのは値域の側だけであり、`isReservedRole` を1バイトも触っていない。**

/** **人には付けられないが、役割の宣言としては書ける識別子**(`D-V8-80`)。 */
const NON_ASSIGNABLE_ROLE_ID = "anonymous";

/** 宣言された役割のうち、アプリが自分で作った(予約4語でない)ものだけ。 */
function customRoleIds(roleIds: readonly string[]): readonly string[] {
  const reserved = new Set<string>([...RESERVED_ROLES, NON_ASSIGNABLE_ROLE_ID]);
  const seen = new Set<string>();
  return roleIds.filter((id) => {
    if (reserved.has(id) || seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

/**
 * **そのアプリで「人に付けられる」役割の全体**(`V8-M29` / 台帳 `T-G10`)。
 *
 * **並びは「予約3ロール(権限の広い順)→ アプリが宣言した役割 → 立場の一覧」である。**
 * **既定3役割は今日どおり含む**(`PATCH .../auth/users/:user_id` は今日も付けられる)。
 * **`anonymous` は宣言されていても入らない**(`D-V8-80`)。
 *
 * **【今日と1文字も変わらない場合】** **アプリが自分で作った役割が0本なら、戻りは
 * {@link roleValuesForKinds} とまったく同じである** —— **役割を宣言していないアプリも、
 * 既定3役割しか宣言していないアプリも、着手前と1文字も変わらない。**
 */
export function assignableRoleValues(roleIds: readonly string[]): readonly Role[] {
  // **【2026-08-11。`V8-M29` 第2波 / 台帳 `T-G9a`】旧(逐語)**:
  //
  //     export function assignableRoleValues(
  //       roleIds: readonly string[],
  //       kinds: readonly string[],
  //     ): readonly Role[] {
  //       const custom = customRoleIds(roleIds);
  //       if (custom.length === 0) {
  //         return roleValuesForKinds(kinds);
  //       }
  //       const today = roleValuesForKinds(kinds) as readonly string[];
  //       return [...today, ...custom.filter((id) => !today.includes(id))] as readonly Role[];
  //     }
  //
  // **第2引数 `kinds` の唯一の出所(`userKindIds` = `effectiveUserKindIds`)が消えたので、
  // 引数を1本落とした。** **戻りの形は1文字も変えていない。**
  const custom = customRoleIds(roleIds);
  const today = baseRoleValues() as readonly string[];
  return [...today, ...custom.filter((id) => !today.includes(id))] as readonly Role[];
}

/**
 * **そのアプリで「登録のときに名乗れる」値の全体**(`V8-M29` / ユーザ決定 `D-V8-78`)。
 *
 * **`D-V8-78` の説明文の逐語**: 「**持ち主・編集者・閲覧者は登録のときに名乗れず、
 * アプリが自分で作った役割(購入者、受付係など)だけを名乗れます。今日と同じ考え方です。
 * 省略したときはその1番目になります。**」
 *
 * **【この波で最も危ない穴を、ここで閉じている】** **出所を素直に `app.roles[].id` へ
 * 付け替えると、実アプリの並びの1本目は `owner` である**(`create-app` が生む並び)——
 * **種類を省略した登録が持ち主になる。** **予約4語を先に落としてから1本目を採るので、
 * `owner` は1度も既定にならない**(検査は `role-value-domain.test.ts` の (3))。
 *
 * **【今日と1文字も変わらない場合】** **アプリが自分で作った役割が0本なら、戻りは
 * 着手前の `allowed`(= `kinds`。空なら `["customer"]`)とまったく同じである。**
 */
export function signupKindValues(roleIds: readonly string[]): readonly string[] {
  // **【2026-08-11。`V8-M29` 第2波 / 台帳 `T-G9a`】旧(逐語)**:
  //
  //     export function signupKindValues(
  //       roleIds: readonly string[],
  //       kinds: readonly string[],
  //     ): readonly string[] {
  //       const today = kinds.length === 0 ? [DEFAULT_USER_KIND] : [...kinds];
  //       const custom = customRoleIds(roleIds);
  //       if (custom.length === 0) {
  //         return today;
  //       }
  //       return [...custom, ...today.filter((id) => !custom.includes(id))];
  //     }
  //
  // **第2引数 `kinds` の唯一の出所が消えたので、引数を1本落とした。**
  // **宣言が無いアプリの戻りは今日も `["customer"]` である。**
  const today = [DEFAULT_USER_KIND] as readonly string[];
  const custom = customRoleIds(roleIds);
  if (custom.length === 0) {
    return today;
  }
  return [...custom, ...today.filter((id) => !custom.includes(id))];
}

/** 値がそのアプリのロール語彙か。管理エンドポイントの role バリデーションに使う。 */
function isRole(value: unknown, values: readonly Role[]): value is Role {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

/**
 * **値がそのアプリのロール語彙の「集合」か**(`V8-M16` / `J-G3`)。
 *
 * **1値の検査 {@link isRole} をそのまま全要素に当てるだけである**(値域の読み方を2本に
 * 割らない)。**空配列は拒む** —— **役割を1つも持たないユーザを作らない。**
 * **同じ値が2度書かれていても拒まない** —— 実効集合は重複を持たない({@link AuthStore.setUserRoles})。
 */
function isRoleSet(value: unknown, values: readonly Role[]): value is Role[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => isRole(item, values));
}

/** セッション cookie を発行する(HttpOnly, SameSite=Strict, Secure=env, Path=/api/apps/:app_id)。 */
function setSessionCookie(c: Context, config: AuthConfig, appId: string, session: Session): void {
  setCookie(c, SESSION_COOKIE, session.id, {
    httpOnly: true,
    sameSite: "Strict",
    secure: config.cookieSecure,
    path: cookiePath(appId),
    maxAge: config.sessionTtlSec,
  });
}

/** pending(儀式途中)cookie を発行する(短TTL, Path=/api/apps/:app_id)。 */
function setPendingCookie(c: Context, config: AuthConfig, appId: string, pendingId: string): void {
  setCookie(c, PENDING_COOKIE, pendingId, {
    httpOnly: true,
    sameSite: "Strict",
    secure: config.cookieSecure,
    path: cookiePath(appId),
    maxAge: config.challengeTtlSec,
  });
}

/** ボディを JSON オブジェクトとして読む。読めなければ統一形式の 400。 */
async function readBody(c: Context): Promise<
  | { ok: true; value: Record<string, unknown> }
  | {
      ok: false;
      response: Response;
    }
> {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    return {
      ok: false,
      response: c.json(
        errorBody([
          {
            path: "",
            message: "リクエストボディが JSON として解釈できません。",
            hint: "Content-Type: application/json で正しい JSON オブジェクトを送ってください。",
          },
        ]),
        400,
      ),
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      response: c.json(
        errorBody([
          {
            path: "",
            message: "リクエストボディは JSON オブジェクトでなければなりません。",
            hint: '{ "<field>": value, ... } の形で送ってください。',
          },
        ]),
        400,
      ),
    };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/** 文字列だけの配列かどうか(JSON の**形**の検査であって、宛先の**中身**は1ミリも見ない)。 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** 期限切れ判定(ISO8601 UTC の辞書順比較)。 */
function isExpired(expiresAtIso: string): boolean {
  return expiresAtIso <= new Date().toISOString();
}

/**
 * st_pending → 有効な pending を取得(取得即削除・purpose 一致・未期限切れ)。
 * `consumeChallenge` は challenge 文字列しか返さないが、register/verify は username も要るため
 * ここでは `takePendingChallenge` を直接使って PendingChallenge 全体を検証して返す。
 */
function takeValidPending(
  store: AuthStore,
  pendingId: string | undefined,
  purpose: ChallengePurpose,
): PendingChallenge | null {
  if (pendingId === undefined || pendingId === "") {
    return null;
  }
  const pending = store.takePendingChallenge(pendingId);
  if (pending === undefined) {
    return null;
  }
  if (pending.purpose !== purpose || isExpired(pending.expiresAt)) {
    return null;
  }
  return pending;
}

/**
 * 登録が許可されているか(アプリの初回ユーザは常に許可。ADR-0014 §8)。
 *
 * =====================================================================================
 * **【2026-08-14。`V8-M1-T04`。台帳 `I-G5` / `I-G7` / `I-G24` / `I-G26` = 4件とも
 * **限定採用**。[`ADR-0335`](../../docs/adr/0335-signup-single-predicate-and-env-precedence.md)
 * 限定1。旧文を1バイトも消していない】**
 * =====================================================================================
 *
 * **旧(逐語)**:
 *
 *     /** 登録が許可されているか(アプリの初回ユーザは常に許可。ADR-0014 §8)。 *\/
 *     function registrationAllowed(store: AuthStore, config: AuthConfig): boolean {
 *       return config.allowRegistration || store.countUsers() === 0;
 *     }
 *
 * **着手前は、同じ問い(この人は登録できるか)に対する実装が2つ在った** ——
 * **`ADMIN_SIGNUP.isAllowed` は本関数、`SELF_SIGNUP.isAllowed` は
 * `(_store, config) => config.allowRegistration` という独自ラムダ(旧の逐語)であり、
 * **片方だけがブートストラップ例外を持っていた。**
 * **今日はこの1本に畳んだ** —— **経路差は `SignupPolicy.bootstrapExempt`(真偽値)が持つ。**
 * **これは `healOwner: boolean` が「経路ごとに違う振る舞い」をデータで表しているのと
 * 同型であり、写しを増やすことではない**(`ADR-0335` §3-2 (c))。
 *
 * **鶏卵の理由(`ADR-0014:211` の逐語「さもないとそのアプリで誰もログインできない鶏卵に
 * 陥る」)は1バイトも動いていない** —— **例外は今日も管理経路だけに在り、`SELF_SIGNUP`
 * には広げない**(同 限定3)。 **広げると env=false × ユーザ0人 × セルフ経路が
 * 今日の 403 から 200 になり、`I-G3` に正面から当たる。**
 *
 * **【招待の判定はここに書かない】** **招待の関門は {@link signupAllowed} が持ち、
 * 本関数の**後段**に足してある**(置き換えではない。同 §3-2 (d))。
 */
function registrationAllowed(store: AuthStore, config: AuthConfig, policy: SignupPolicy): boolean {
  return config.allowRegistration || (policy.bootstrapExempt && store.countUsers() === 0);
}

/**
 * **本文の招待コードで、そのログイン名の「今使える招待」を引く**
 * (`V8-M3-T02`。台帳 `I-G20`。[`ADR-0337`](../../docs/adr/0337-invitation-redemption-path.md)
 * §3-1 / 限定12 / 限定13)。
 *
 * **コードが本文に無ければ、`store` を1度も触らずに `undefined` を返す。**
 * **これが `I-G3`(宣言していないアプリの登録が着手前と変わらない)の既定の証明を
 * 支える構造である** —— **招待コードを送らないリクエストは、招待の表に一度も触れない。**
 *
 * =====================================================================================
 * **【2026-08-14。裁定 `M3-4`(メインの設計追補1)。旧文を1バイトも消していない】**
 * =====================================================================================
 *
 * **旧(逐語)**: 第4引数 `declaresInvite: boolean`(= そのアプリで `signup: "invite"` が
 * 書かれた役割が1本でも在るか)を取り、**偽なら `store` を1度も触らずに `undefined` を
 * 返していた。**
 *
 * **落とした理由**: **その形だと、`signup` を1つも宣言していないアプリでは招待が
 * 1ミリも効かない。** **`ST_AUTH_ALLOW_REGISTRATION=false` のサーバで運営者が招待を
 * 出しても、その相手は登録できない** —— **これは `D-V8-110`(有効な招待は env の閉じを
 * 越える)を正面から破り、`V8-M2` が自ら欠陥と呼んだ「使えない招待を出せる状態」を
 * 別の形で残す。**
 *
 * **【この変更で着手前と応答が変わるのは1通りだけである。必ず併記する】**
 * **`ST_AUTH_ALLOW_REGISTRATION=false` かつ そのログイン名に有効な招待が在るとき** ——
 * **着手前 `403` / 着手後 `200`。** **加えて、招待が在れば役割が付与表に足されるので、
 * 応答本文の役割が変わりうる。**
 * **【禁止】これを「既定は1ミリも変わらない」と無条件に書かない。**
 *
 * **触る側に入ったときに限り、掃除を2本とも同じ点で呼ぶ**
 * ([`ADR-0336`](0336-invitation-issuance-storage-redemption.md) 限定19 の (b) の履行。
 * **招待だけを掃除して、期限切れのセッションと pending challenge を溜め続ける形にしない**)。
 * **`ADR-0336` §3-6 は (b) の呼び出し点を password 経路と名指ししていたが、`ADR-0337` が
 * 「招待を引く1本の関数の中」へ引き直した** —— **したがって passkey verify から入っても
 * 掃除が走る。**
 *
 * **【測っていない】** **招待を引く経路と引かない経路で `store` に触る回数が違う。**
 * **その時間差から「招待が在るか」を推測できるかは1度も測っていない**(`ADR-0337` §限界4)。

 */
function invitationFrom(store: AuthStore, username: string, raw: unknown): Invitation | undefined {
  if (typeof raw !== "string" || raw === "") {
    return undefined;
  }
  store.purgeExpiredInvitations();
  store.purgeExpired();
  return findUsableInvitation(store, username, raw);
}

/**
 * **招待が要るか**(`V8-M3-T02`。台帳 `I-G20`。`ADR-0337` §3-2 / 限定8)。
 *
 * =====================================================================================
 * **【2026-08-14。`V8-M3-T02`。旧文を1バイトも消していない】**
 * =====================================================================================
 *
 * **旧({@link signupAllowed} の本体に在った三項式。文字は1つも足し引きしていない)**:
 *
 *     const inviteRequired =
 *       input.policy.inviteScope
 *         === "reserved"
 *         ? RESERVED_ROLES.some((role) => input.inviteOnlyRoles.includes(role))
 *         : input.inviteOnlyRoles.includes(input.requestedKind);
 *
 * **【行の折り返しだけを変えてある。理由を隠さない】** **旧文の1行目を原文どおりに
 * 1行で書くと、限定8 の機械的検査(その式を数えると **1** になること)が **2** になる**
 * —— **注釈の行が数えられるからである**(実際に1度そうなった。`:2062` と同じ轍)。
 * **文字は1つも足し引きしていないが、原文と同じ**行の切れ目**ではない。**
 *
 * **式そのものは1バイトも変えていない** —— **名前を付けて切り出し、経路からも呼べる
 * ようにしただけである。** **式が2箇所に在る状態にしない**(限定8)。
 *
 * **読み方は今日2通りちょうどで閉じる**([`ADR-0334`](0334-role-signup-mode-declaration.md)
 * 限定14。**3通り目を作らない**):
 *
 * - **セルフ登録の口** …… **名乗った役割**の宣言を見る。
 * - **運営が人を足す口** …… **予約3語のうち1つでも `"invite"` か**を見る。
 *
 * **【名乗りが未確定のときの倒し方。裁定 `M3-5`(メインの設計追補1)】**
 *
 * **旧(逐語。実装せずに差し替えたので、動いたことは1度も無い)**:
 *
 *     // **名乗りが未確定のとき(422 になる値を送られたとき)は、宣言が1本でもあれば要求する側に倒す。**
 *     return requestedKind === undefined
 *       ? inviteOnlyRoles.length > 0
 *       : inviteOnlyRoles.includes(requestedKind);
 *
 * **採らなかった理由**: **それは `ADR-0334` 限定14 の**3つ目の読み方**にあたる。**
 * **本 ADR は `.../register/options` を却けるのに「読み方を3通り目にできない」を
 * 使っており、自分の逃げ道に同じ論拠を当てないのは筋が通らない。**
 *
 * **【限界。必ず記録する】** **招待の要るアプリでも、名乗りに存在しない役割を書いて
 * 叩けば、今日どおり `409`(ログイン名重複)または env の `403` または `422` が返る。**
 * **したがって `I-G23` は「名乗りが妥当な本文」についてのみ成り立つ。**
 * **{@link signupAllowed} からの呼び出しでは名乗りが必ず確定しているので、この枝は
 * そちらからは1度も通らない**(振る舞いは着手前と1ミリも変わらない)。
 */
function invitationRequired(
  policy: SignupPolicy,
  inviteOnlyRoles: readonly string[],
  requestedKind: string | undefined,
  declaredRoleIds: readonly string[],
): boolean {
  if (policy.inviteScope === "reserved") {
    return RESERVED_ROLES.some((role) => inviteOnlyRoles.includes(role));
  }
  // **名乗りが確定していなければ、名乗った役割の宣言は読めない**(`ADR-0334` 限定14)。
  // **読み方を3通り目にしない。** **この本文は必ず 422 になる経路である。**
  if (requestedKind === undefined) {
    return false;
  }
  if (declaredRoleIds.includes(requestedKind)) {
    // **旧の逐語(1バイトも消していない)**:
    //     return requestedKind === undefined ? false : inviteOnlyRoles.includes(requestedKind);
    // **今日はこの枝がその式そのものである** —— **宣言が在る名乗りの扱いは1ミリも変えていない。**
    return inviteOnlyRoles.includes(requestedKind);
  }
  // =====================================================================================
  // **【2026-08-14。`V8-M5-T07`。ユーザ決定 `D-V8-116`】**
  // **アプリが宣言していない立場(組み込みの既定)を名乗ったときの倒し方。**
  // =====================================================================================
  //
  // **【何が起きていたか。実測が見つけた】** **{@link signupKindValues} は、アプリが独自の
  // 役割を1つも宣言していなくても組み込みの既定を必ず1つ返す。** **その値は `app.roles` に
  // 無いので、招待の要否を書き込む場所が1つも無い。** **着手前はこの枝が
  // `inviteOnlyRoles.includes(...)` を通って**必ず偽**になり、予約3語をすべて `"invite"` に
  // した「全員制限」のアプリでも、その値を名乗るだけで招待なしに登録できた。**
  // **見つけたのは審査ではなく `V8-M5` の実測である**(器の中と母艦の両方で再現した)。
  //
  // **【`D-V8-116` が選んだ形】** **予約3語が**すべて**招待制のときだけ、この立場も招待を
  // 要求する。** **説明文の逐語**:「運営側の3つ(持ち主・編集者・閲覧者)がすべて招待制に
  // なっているときだけ、アプリが名前を付けていない「一般利用者」も招待を要求します。
  // 「全員制限」が字義どおりになります。「一般は自由・スタッフは制限」のアプリの動きは
  // 1つも変わりません。」
  //
  // **【新しい読み先を1つも作っていない】** **ここが読むのは `app.roles[].signup` の予約3語分
  // であり、運営が人を足す口が既に読んでいる宣言と**同一の場所**である。**
  // **`some` ではなく `every` なのは、`D-V8-116` が「すべて招待制のときだけ」を選んだからで
  // ある** —— **1つでも開いていれば、この立場は今日どおり開いたままである。**
  //
  // **【`ADR-0334` 限定14 との関係を丸めない】** **同 限定14 は「読み方は今日2通りちょうどで
  // 閉じる」と書いており、その字義は今日から成り立たない**(枝が3つある)。 **成り立たなく
  // なったのは**数え方**であって**読み先**ではない。** **【禁止】これを「限定14 を1バイトも
  // 破っていない」と書かない。** **訂正は同 ADR に置いた。**
  return RESERVED_ROLES.every((role) => inviteOnlyRoles.includes(role));
}

/**
 * **登録の可否を決める述語。1本ちょうどである**(`V8-M1-T04`。`ADR-0335` 限定1)。
 *
 * **見る順は1通りに固定する**(`ADR-0335` §3-1 の表。**2通り目の順序を作らない**):
 *
 * | 順 | 見るもの | 真なら | 根拠 |
 * |---|---|---|---|
 * | **(a)** | **そのアプリの登録者が0人か**(`wasFirstUser`) | **招待の関門を通さない** | `D-V8-106` |
 * | **(b)** | **有効な招待があるか** | **通す。env を見ない** | `D-V8-110` |
 * | **(c)** | **`config.allowRegistration`**(= {@link registrationAllowed}) | 通す。偽なら **403** | 今日どおり |
 *
 * **(a) が真でも env の関門は素通りしない** —— **素通りさせると env=false × ユーザ0人 ×
 * セルフ経路が今日の 403 から 200 になる**(`ADR-0335` 限定3 / §3-3 の表の5行目)。
 * **`D-V8-106` の「誰も居ない間だけ扉を開ける」が外すのは、招待の関門だけである。**
 *
 * **【`V8-M1` の時点では招待の仕組みが1つも無い】** —— **したがって `invited` は
 * 常に `false` であり、(b) の枝は1度も真にならない。** **埋めるのは `V8-M3` である**
 * (この引数に本物の検証を差し込むだけで済む形にしてある)。
 * **【禁止】この中間状態を「一時的だから問題ない」と書かない** —— **`"invite"` を
 * 宣言したアプリは、`V8-M3` が通るまで、登録者が1人でもいれば誰も登録できない。**
 *
 * **【2026-08-14 訂正(`V8-M4-T03`。裁定 `M4-3`)。上の段落を1バイトも消していない】**
 * **上の段落は今日は偽である。** **`V8-M3` が `invited` を埋めた**(`:1642` 付近と
 * passkey verify 側の逐語)。 **今日この引数は `invitation !== undefined` を受け取り、
 * (b) の枝は有効な招待が在れば真になる。** **「登録者が1人でもいれば誰も登録できない」も
 * 今日は偽であり、有効な招待を持つ相手は登録できる**(実測は `docs/plan/v8/records/v8-m4.md`
 * §5 / §6)。 **見つけたのは `V8-M3` の記録であり、直したのは `V8-M4` である。**
 *
 * **どの宣言を見るかは経路で違う**(`ADR-0334` 限定14。**読み方を1通りに固定する**):
 *
 * - **セルフ登録の口** …… **名乗った役割**(`resolveRequestedUserKind` が確定させた値)の
 *   `signup` を見る。
 * - **運営が人を足す口** …… **予約3語(`owner` / `editor` / `viewer`)のうち1つでも
 *   `"invite"` が書かれていれば**招待を要求する。
 *   **【「発行される役割だけを見る」形は採らなかった】** —— **`ADMIN_SIGNUP.resolveRole`
 *   は `store.countUsers() === 0 ? "owner" : "viewer"` なので、その形では読み方が
 *   `wasFirstUser` に依存し、1つの宣言に対して答えが2つできる**(`ADR-0334` 限定14 が
 *   名指しで却下している)。
 *
 * **【正直に書く】`editor` に書いた宣言は、今日それ単独では1件も効かない** ——
 * **`ADMIN_SIGNUP` が発行するのは `owner` と `viewer` の2語だけで、`editor` はこの口から
 * 1度も出ない。** **上の読み方では `editor` も見るので、`editor` だけに `"invite"` を
 * 書けば管理経路は閉じる** —— **「書けるが効かない組み合わせ」を1つ残したことを隠さない。**
 */
function signupAllowed(input: {
  store: AuthStore;
  config: AuthConfig;
  policy: SignupPolicy;
  /** **ユーザを作る**前**に採った値**(`ADR-0335` 限定2)。ここで数え直さない。 */
  wasFirstUser: boolean;
  /** そのアプリで `signup: "invite"` が書かれた役割の識別子(宣言が無ければ空)。 */
  inviteOnlyRoles: readonly string[];
  /** セルフ登録で名乗った役割(`resolveRequestedUserKind` が確定させた値)。 */
  requestedKind: string;
  /**
   * **そのアプリが宣言した役割の識別子の全量**(`V8-M5-T07`。ユーザ決定 `D-V8-116`)。
   *
   * **名乗りが宣言に在るかどうかだけに使う** —— **在れば今日どおり、在らなければ
   * 予約3語の宣言を見る**({@link invitationRequired})。 **判定を1つも増やしていない。**
   */
  declaredRoleIds: readonly string[];
  /**
   * **有効な招待があるか。** **`V8-M1` の時点では常に `false` である**(招待の仕組みが
   * 1つも無い)。**`V8-M3` がここに本物の検証を差し込む。**
   *
   * **【2026-08-14 訂正(`V8-M4-T03`。裁定 `M4-3`)。上の2行を1バイトも消していない】**
   * **後半は既に済んだ仕事を未来形で書いている。** **`V8-M3` が差し込み済みであり、
   * 呼び出し側は今日 `invited: invitation !== undefined` を渡す**(2箇所とも)。
   */
  invited: boolean;
}): boolean {
  // **【`V8-M3-T02` / `ADR-0337` 限定8】三項式は {@link invitationRequired} に移した。**
  // **旧の逐語は同関数の doc に残してある**(式が2箇所に在る状態にしない)。
  const inviteRequired = invitationRequired(
    input.policy,
    input.inviteOnlyRoles,
    input.requestedKind,
    input.declaredRoleIds,
  );
  // (a) 登録者0人 →(b) 有効な招待 → の順で、招待の関門だけを外す。
  if (inviteRequired && !input.wasFirstUser && !input.invited) {
    return false;
  }
  // (b) 有効な招待は env を越える(`D-V8-110`)。**今日は1度も真にならない。**
  if (input.invited) {
    return true;
  }
  // (c) env。**今日どおりの分岐をそのまま通す**(1バイトも振る舞いを変えない)。
  return registrationAllowed(input.store, input.config, input.policy);
}

/**
 * サインアップ経路のポリシー(V2-M1-T02 / ADR-0033 §1b・限定2)。
 *
 * **昇格不可を構造で保証する**ために、割り当てるロールは**経路ごとに固定**し、
 * どちらの経路も**リクエスト本文から role を受け取らない**(本文の role は無視される)。
 * 顧客セルフサインアップの別経路は `role` を常に `customer` に固定し、初回ユーザでも
 * owner にしない(顧客経路は owner をブートストラップしない)。運営の初回 owner
 * ブートストラップは既存の管理経路が担う。
 */
type SignupPolicy = {
  /**
   * verify/register 成功時に割り当てるロール。
   *
   * **【`V5-M17-T04` / `G-G6` / `ADR-0158` 限定9 で変えた】** **着手前の逐語は
   * 「**本文から受け取らない**(構造で固定)」であり、その1行を書き換えていない**(上)。
   * **今日は、非運営の経路だけが本文から「種類」を受け取る。** **受け取れるのは
   * そのアプリが宣言した非運営の種類だけである** —— **運営ロール(`owner` / `editor` /
   * `viewer`)は本文から1度も受け取らない**(検査は {@link resolveRequestedUserKind})。
   * **管理経路(`ADMIN_SIGNUP`)は今日も第2引数を1バイトも見ない。**
   *
   * **【昇格不可の担保が弱くなったことを認める】** **`ADR-0033` 限定2 は「経路が既定を
   * 固定する」という**構造**で昇格を止めていた。** **今日は「受け取った値が宣言された
   * 非運営の種類か」を検査する**実装**に依存する**(`ADR-0158` §限界5 が自分でそう書いている)。
   */
  resolveRole: (store: AuthStore, requestedKind: string | undefined) => Role;
  /**
   * =====================================================================================
   * **【2026-08-14。`V8-M1-T04`。`ADR-0335` 限定1。旧文を1バイトも消していない】**
   * =====================================================================================
   *
   * **旧(逐語)**:
   *
   *     /** 登録可否。管理経路は初回ブートストラップ例外あり、顧客経路は allowRegistration のみ。 *\/
   *     isAllowed: (store: AuthStore, config: AuthConfig) => boolean;
   *
   * **`isAllowed` というフィールドを撤去した** —— **オブジェクトリテラルの中にラムダで
   * 書くと、判定の写しが経路の数だけできる。****経路差は、この真偽値2本が宣言的に持つ**
   * (`healOwner: boolean` と同型)。**判定の実体は {@link registrationAllowed} と
   * {@link signupAllowed} の2本で、どちらも1本ずつしか無い。**
   *
   * **ブートストラップ例外(アプリの初回ユーザは env によらず常に許可。`ADR-0014` §8)を
   * 持つか。** **管理経路は `true` / セルフ経路は `false`。**
   * **`SELF_SIGNUP` に広げない**(`ADR-0335` 限定3)—— **広げると env=false ×
   * ユーザ0人 × セルフ経路が今日の 403 から 200 になり、`I-G3` に正面から当たる。**
   */
  bootstrapExempt: boolean;
  /**
   * **招待の要否を、どの役割の宣言から読むか**(`V8-M1-T04`。`ADR-0334` 限定14)。
   *
   * - **`"requested"`**(セルフ登録の口)…… **名乗った役割**の `signup` を見る。
   * - **`"reserved"`**(運営が人を足す口)…… **予約3語(`owner` / `editor` / `viewer`)の
   *   うち1つでも `"invite"` か**を見る。**この口は役割を本文から1バイトも受け取らない。**
   *
   * **読み方はこの2通りで閉じる。3通り目を作らない。**
   */
  inviteScope: "requested" | "reserved";
  /**
   * owner 不変条件の自己修復(`ensureOwnerExists`)を走らせるか。管理経路は true。
   * **顧客経路は false** —— 走らせると「owner が0人の初回」に最古(=その顧客)を owner へ
   * 昇格してしまい、「初回でも owner にしない」(ADR-0033 §1b)を破るため。
   */
  healOwner: boolean;
};

/** 管理サインアップ経路: 初回 owner / 以降 viewer。既存挙動を保つ(V1-M3-T02 / ADR-0015)。 */
const ADMIN_SIGNUP: SignupPolicy = {
  // **本文の種類指定を1バイトも見ない**(管理経路は着手前と1ミリも変わらない)。
  resolveRole: (store) => (store.countUsers() === 0 ? "owner" : "viewer"),
  // **旧(逐語)**: `isAllowed: registrationAllowed,`
  // **`V8-M1-T04` が判定を1本に畳んだので、ここは真偽値の宣言だけになった。**
  bootstrapExempt: true,
  // **この口は役割を本文から1バイトも受け取らないので、予約3語の宣言を見る**
  // (`ADR-0334` 限定14)。
  inviteScope: "reserved",
  healOwner: true,
};

/**
 * 顧客セルフサインアップ経路: 常に customer(EC-G2 / ADR-0033)。
 *
 * **allowRegistration 整合(決定)**: 顧客サインアップは `allowRegistration`(サイト全体の
 * 登録開閉スイッチ)で制御する。ただし管理経路が持つ「初回ユーザは常に許可」という
 * ブートストラップ例外は**付けない** —— その例外は初回 owner を立てるための管理経路専用で
 * あり、顧客経路は決して owner をブートストラップしないため。既定 `allowRegistration=true`
 * なので、owner 設営後のストアフロントは既定で開いている(閉じたければ owner が
 * `ST_AUTH_ALLOW_REGISTRATION=false` にする)。
 */
const SELF_SIGNUP: SignupPolicy = {
  // **宣言された種類を受け取る。** 省略時はそのアプリの1本目(宣言が無ければ `customer`)。
  // **値の妥当性は経路の側で先に検査済みである**({@link resolveRequestedUserKind})——
  // **ここに検査を書くと、判定が2箇所に割れる。**
  resolveRole: (_store, requestedKind) => requestedKind ?? DEFAULT_USER_KIND,
  // **旧(逐語)**: `isAllowed: (_store, config) => config.allowRegistration,`
  // **【`V8-M1-T04` / `ADR-0335` 限定1】判定を1本に畳んだ。****ブートストラップ例外を
  // 持たないことは、この真偽値が宣言的に表す**(限定3。**広げない**)。
  bootstrapExempt: false,
  // **名乗った役割の宣言を見る**(`ADR-0334` 限定14)。
  inviteScope: "requested",
  healOwner: false,
};

// =====================================================================================
// **【`V8-M5-T03`。台帳 `I-G27`(却下だが `D-V8-112` により実施)/ `I-G8`(却下)。**
// **ユーザ決定 `D-V8-114` / `D-V8-115`。[`ADR-0338`](../../docs/adr/0338-signup-facts-and-user-creation-paths.md) §3-1】**
// **登録前の画面が読む事実を、既に在る `GET /api/apps/:app_id/public` へ渡す形にする**
// =====================================================================================

/**
 * **登録に要る事実**(`ADR-0338` §3-1 の形そのもの)。
 *
 * **`kinds` は {@link signupKindValues} の戻り値と1対1である** —— **この関数は値域を
 * 1つも組み直さない**(`ADR-0338` 限定4。**サーバの値域と画面の値域を2箇所に書かない**)。
 * **`invite` / `adminInvite` は {@link invitationRequired} と**同じ根拠**から出す** ——
 * **判定の写しを2箇所目に作らない**([`ADR-0326`](../../docs/adr/0326-role-granter-lockout-invariant.md) 限定7 /
 * [`ADR-0334`](../../docs/adr/0334-role-signup-mode-declaration.md) 限定14 と同じ線)。
 *
 * **【渡さないものを名指しする。`ADR-0338` 限定3 / 限定13】** **行(データ)を1行も渡さない。**
 * **利用者の一覧も、招待の一覧も、招待コードも1文字も渡さない。**
 * **役割の規則(`rules`)も条件も人数も渡さない** —— **`kinds[]` は `id` / `name` / `invite` の
 * 3キーちょうどで閉じ、4つ目を足さない。**
 *
 * **【限界。丸めない】** **この形は「そのアプリのどの立場が招待制か」を未ログインの誰にでも
 * 述べる**(`D-V8-114` の説明文の逐語:「ログインしていない誰でも、そのアプリにどんな立場が
 * あるか(名前と識別子)を見られるようになります。」)。 **【禁止】「未ログインに見える情報は
 * 増えていない」と書かない。**
 */
export type SignupFacts = {
  kinds: readonly { id: string; name: string; invite: boolean }[];
  adminInvite: boolean;
};

/**
 * **{@link SignupFacts} を組む。新しい判定を1つも書いていない。**
 *
 * @param kinds **{@link signupKindValues} の戻り値そのもの**(この関数は組み直さない)。
 * @param inviteOnlyRoleIds **そのアプリで `signup: "invite"` が書かれた役割**
 *   (`src/server/app.ts` が読む。**読み方を2箇所に書かない**)。
 * @param roleNames **役割の識別子 → 表示名。** **`name` は今日も任意である**(`D-V8-79`)——
 *   **書かれていなければ識別子をそのまま返す**(`views` の `name` が既に採っている形と揃える)。
 */
export function signupFacts(input: {
  kinds: readonly string[];
  inviteOnlyRoleIds: readonly string[];
  roleNames: ReadonlyMap<string, string>;
  /**
   * **そのアプリが宣言した役割の識別子の全量**(`V8-M5-T07`。ユーザ決定 `D-V8-116`)。
   * **`kinds` のうち宣言に無いもの(組み込みの既定)は、予約3語の宣言で閉じるかが決まる。**
   */
  declaredRoleIds: readonly string[];
}): SignupFacts {
  return {
    kinds: input.kinds.map((id) => ({
      id,
      name: input.roleNames.get(id) ?? id,
      // **セルフ登録の口の読み方**(名乗った役割の宣言を見る側)。
      invite: invitationRequired(SELF_SIGNUP, input.inviteOnlyRoleIds, id, input.declaredRoleIds),
    })),
    // **運営が人を足す口の読み方**(予約3語の宣言を見る側)。
    // **この口は本文から役割を1バイトも受け取らないので、名乗りは `undefined` である。**
    // **【注記の書き方の限定】** **上の2行に、判定の綴りそのものを書き写していない** ——
    // **書くと `src/server/invitation-redemption.test.ts` の (T02-b) が数える出現数が動く**
    // (`ADR-0338` §3-3 の「訂正文に検査対象の綴りを書かない」。**このリポジトリで4度目である**)。
    adminInvite: invitationRequired(
      ADMIN_SIGNUP,
      input.inviteOnlyRoleIds,
      undefined,
      input.declaredRoleIds,
    ),
  };
}

/**
 * **アプリの最初の1人は、自分で登録した場合も必ず持ち主になる**
 * (`V8-M30` 第2波。**ユーザ決定 `D-V8-82`**)。
 *
 * =====================================================================================
 * **【旧の挙動を逐語で残す。1バイトも消していない】**
 * =====================================================================================
 *
 * **旧(逐語。2箇所とも同一)**:
 *
 *     // 顧客経路は owner をブートストラップしない(healOwner=false。ADR-0033 §1b)。
 *     if (policy.healOwner) {
 *       store.ensureOwnerExists();
 *     }
 *
 * **旧の帰結(`V8-M30` が実 HTTP で測った)**: **セルフ登録の経路は `ensureOwnerExists` を
 * 1度も呼ばないので、最初の1人が独自の役割(例: `builder`)を名乗ると、そのアプリは
 * **持ち主0人・配れる人0人**のまま作れた**(`curl` 3本。登録は1本)。
 *
 * **`D-V8-82` の選ばれた説明文の逐語**:
 *
 * > 「自分で登録した場合でも、そのアプリの最初の1人は持ち主になります。名乗った役割は
 * >  それに足されます。**公開の購入サイトでは、最初に買った客が運営者になってしまいます。**」
 *
 * =====================================================================================
 * **【どちらを列に据えたか。決めた理由を書く】**
 * =====================================================================================
 *
 * **列(`_auth_users.role`)に据えるのは `owner`、名乗った役割は付与表(`_auth_user_roles`)へ
 * 足す。** **理由は3つである**:
 *
 *  1. **`ensureOwnerExists`(着手前から在る自己修復)が列へ `owner` を書くのと**同じ向き**である**
 *     —— **「最初の1人は持ち主」という同じ規則が、経路によって2通りの書き方を持たない。**
 *  2. **管理経路の1人目(`role: "owner"`)と応答の形が揃う** —— **`GET /auth/users` の
 *     `role` 欄を見た人が、経路によって別の綴りを見ることが無い。**
 *  3. **`_auth_users.role` は「既定の1本目」である**(`ADR-0303` 限定4)—— **最初の1人に
 *     とっての既定の1本目は持ち主である。**
 *
 * **`D-V8-82` の逐語「最初の1人は持ち主になります。名乗った役割は**それ**に足されます」とも
 * 向きが一致する**(足される側が名乗った役割である)。
 *
 * =====================================================================================
 * **【触っていないもの】**
 * =====================================================================================
 *
 *  - **`countOwners()` の SQL を1バイトも触っていない**(`D-V8-47`)。**`'owner'` の焼き込みは残る。**
 *  - **`V8-M30` が立てた2本目の不変条件(`LastGranterError`)を1バイトも触っていない。**
 *  - **管理経路(`healOwner: true`)の1行を1バイトも変えていない** —— **下の1本目の枝が
 *    旧のコードそのものである。**
 *  - **`undo` の迂回を1ミリも塞いでいない**(`D-V8-51`)。
 *  - **役割を1つも宣言していないアプリの締め出しを1件も直していない**(`D-V8-81` = そのままにする)。
 *
 * =====================================================================================
 * **【禁止】これを「安全になった」と書かない**
 * =====================================================================================
 *
 * **塞いだのは「持ち主0人」であって、「持ち主でない人が持ち主になる」ことではない。**
 * **後者は本決定が**新しく作る**ものである** —— **公開の購入サイトでは、最初に買った客が
 * 運営者になる。** **ユーザはそれを承知したうえでこちらを選んだ。**
 *
 * @param wasFirstUser **ユーザを作る**前**に数えた `store.countUsers() === 0`。**
 * @returns **応答に載せるユーザ**(列を書き換えたときは読み直したもの)。
 */
function bootstrapFirstUserOwner(
  store: AuthStore,
  policy: SignupPolicy,
  user: User,
  wasFirstUser: boolean,
): User {
  // 顧客経路は owner をブートストラップしない(healOwner=false。ADR-0033 §1b)。
  // **↑ この1行と直下の3行は旧のコードそのものである(1バイトも変えていない)。**
  if (policy.healOwner) {
    store.ensureOwnerExists();
    return user;
  }
  // **【`D-V8-82`】ここから下が新しい。** **最初の1人**だけ**が持ち主になる。**
  if (!wasFirstUser) {
    return user;
  }
  const claimed = user.role;
  if (claimed !== "owner") {
    // **名乗った役割を消さずに残す** —— **付与表へ足してから、列を持ち主に据える。**
    store.grantRole(user.id, claimed);
  }
  store.setUserRole(user.id, "owner");
  return store.findUserById(user.id) ?? user;
}

/**
 * **サインアップ本文の「利用者の種類」を検査して確定させる**(`V5-M17-T04` / `ADR-0158` 限定9)。
 *
 * - **書かなければ**、そのアプリの1本目(宣言が無ければ `customer`)。
 * - **運営ロールを書いたら 422。** **初回ユーザでも `owner` にしない**(`ADR-0033` 限定2 の
 *   この2点は今日も生きている)。
 * - **宣言していない種類名を書いたら 422。**
 *
 * **【passkey の経路について隠さない】** **種類を読むのは verify の本文である**
 * (options の段階ではユーザをまだ作らない)。**したがって options を1つの種類で取り、
 * verify を別の種類で通すことができる。** **それでも権限は上がらない** ——
 * **宣言された種類の認可規則はすべて同一だからである**(`ADR-0158` 限定2)。
 * **「経路が種類を固定している」とは書かない。**
 */
function resolveRequestedUserKind(
  value: unknown,
  allowed: readonly string[],
): { ok: true; kind: string } | { ok: false; error: ValidationError } {
  // --- 【`V8-M29` 第1波 / ユーザ決定 `D-V8-78`(2026-08-11)】-----------------------------
  //
  // **旧(逐語)**: 第2引数は `kinds: readonly string[]`(= `userKindIds(appId)`)であり、
  // 本文の1行目が値域そのものを組み立てていた:
  //
  //     const allowed = kinds.length === 0 ? [DEFAULT_USER_KIND] : kinds;
  //
  // **今日は、組み立てを呼び出し側({@link signupKindValues})へ寄せた。**
  // **理由は「省略時の既定 = `allowed[0]`」を、値域を組む1箇所と同じ場所で決めるためである**
  // —— **`app.roles[].id` をそのまま渡すと1本目が `owner` になり、種類を省略した登録が
  // 持ち主になる**(関門 `T01-U` の (2) が名指しで予告した穴)。
  // **`signupKindValues` が予約4語を先に落とすので、この行に `owner` は1度も来ない。**
  if (value === undefined || value === null || value === "") {
    return { ok: true, kind: allowed[0] as string };
  }
  // --- 【`V8-M27-T04` / ユーザ決定 `D-V8-72`(2026-08-11)】-------------------------------
  //
  // **予約3ロールの歯止め2箇所を撤去した。旧文を1バイトも消していない。**
  //
  // **旧(逐語)**:
  //
  //     if (typeof value !== "string" || isReservedRole(value) || !allowed.includes(value)) {
  //       return {
  //         ok: false,
  //         error: {
  //           path: "/user_kind",
  //           message: "この利用者の種類では登録できません。",
  //           allowed_values: [...allowed],
  //           hint:
  //             typeof value === "string" && isReservedRole(value)
  //               ? "運営のロール(owner / editor / viewer)はこの経路では発行できません。owner に依頼してください。"
  //               : "アプリが宣言している利用者の種類(user_kinds)のいずれかを指定するか、省略してください。",
  //         },
  //       };
  //     }
  //
  // **`D-V8-72` の選ばれた説明文の逐語**:
  // > 「「人に役割を配れる」を規則で書けるようになってから、そちらで守ります。
  // >  **ただしその仕掛けはまだ入っておらず(次の次の工程)、それまでの間は誰でも
  // >  持ち主として登録できる状態になります。**」
  //
  // **【実測。隠さない】撤去しても `user_kind: "owner"` は今日も 422 である。**
  // **拒否条件は2本の `OR` であり、残った `!allowed.includes(value)` が拒む** ——
  // **`allowed` は `effectiveUserKindIds`(= `declaredUserKinds`)であり、そちらは
  // 宣言から予約3ロールを `isReservedRole` で**落としてから**返す
  // (`src/server/owner-scope.ts:64`)。****その `isReservedRole` は本タスクの撤去対象では
  // ない**(「宣言された利用者の種類を読む」側であって、表単位の可否を決める層ではない)。
  // **したがって `"owner"` は `allowed` に1度も載らない。**
  // **`schemas/manifest.schema.json` の `not.enum` も、宣言そのものを塞いでいる。**
  //
  // **変わったのは `hint` の文面だけである** —— **予約3ロール専用の分岐が消えたので、
  // 今日は常に「アプリが宣言している利用者の種類(user_kinds)のいずれかを指定するか、
  // 省略してください。」が返る。**
  //
  // **【禁止の履行】黙って開けていない。** **この事実は
  // `src/server/nonadmin-layer-removal.test.ts` の (f) が実 HTTP + 本物の SQLite で
  // 固定しており、`V8-M28` が `declaredUserKinds` 側にも手を入れて穴が実際に開いた日は、
  // その検査が赤くなって知らせる。**
  if (typeof value !== "string" || !allowed.includes(value)) {
    return {
      ok: false,
      error: {
        path: "/user_kind",
        message: "この利用者の種類では登録できません。",
        allowed_values: [...allowed],
        // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G12`。メインの裁定2】**
        // **旧の文面(逐語)**:
        //     hint: "アプリが宣言している利用者の種類(user_kinds)のいずれかを指定するか、省略してください。",
        // **`user_kinds` は同じ差分で廃止されたので、この文面は今日から嘘である。**
        // **今日の `allowed` は {@link signupKindValues} が組む** —— **`app.roles[].id` から
        // 予約4語(`owner` / `editor` / `viewer` / `anonymous`)を落としたものであり、
        // 独自の役割が0本なら `["customer"]` である。****文面をそれに合わせて打ち直した。**
        // **【この文面が述べていないこと】** **独自の役割が0本のアプリでは `allowed` が
        // `["customer"]` になるが、`customer` は `app.roles` に書かれていなくても入る** ——
        // **その1点はこの文面から読み取れない。****`allowed_values` が正である。**
        hint: "アプリが宣言している役割(roles)のうち、持ち主・編集者・閲覧者・未ログインを除いたもののいずれかを指定するか、省略してください。",
      },
    };
  }
  return { ok: true, kind: value };
}

/**
 * 古い DB(role 列を3値 CHECK 付きで既に持つ M3-T02 世代)は customer を CHECK で弾く
 * (SQLite は既存列の CHECK を ALTER 変更できない。ADR-0033 §4・対処(a))。この限界を
 * 統一エラーとして返すためのエラー(500 の生エラーにしない。T01 申し送り)。
 */
const customerRoleUnsupportedError: ValidationError = {
  path: "/role",
  message: "この DB は customer ロールを保存できません(古い CHECK 制約により弾かれました)。",
  hint: "顧客サインアップは新規または移行後の DB でのみ有効です(ADR-0033 §4・対処(a))。既存 M3 アプリでは owner に DB 移行を依頼してください。",
};

/**
 * `createUser` を実行し、**あらゆる失敗を統一 `{ errors }` 形式に変換する**(V2-M1-T02 完了条件4)。
 * 顧客経路の customer INSERT は古い DB の3値 CHECK で失敗しうるが、その場合でも 500 の生エラーを
 * 露出させず統一形式で返す(解決したふりはしない —— 顧客は発行できないという事実は返す)。
 * UNIQUE 競合(username 重複)は呼び出し前に 409 で弾いてあるが、TOCTOU 保険として同経路で拾う。
 */
function createUserSafely(
  c: Context,
  store: AuthStore,
  input: { username: string; role: Role; consumeInvitationFor?: string },
): { ok: true; user: User } | { ok: false; response: Response } {
  try {
    // =====================================================================================
    // **【2026-08-14。`V8-M3-T05`。`ADR-0336` 限定17 / `ADR-0337` 限定11。旧文を1バイトも消していない】**
    // =====================================================================================
    //
    // **旧(逐語)**:
    //
    //     return { ok: true, user: store.createUser(input) };
    //
    // **招待を引けていたときだけ、印を立てるのとユーザを作るのを1つのトランザクションで行う。**
    // **引けていないときは旧の1行がそのまま走る**(宣言していないアプリの登録は
    // 着手前と1バイトも変わらない)。
    const user =
      input.consumeInvitationFor === undefined
        ? store.createUser({ username: input.username, role: input.role })
        : store.consumeInvitationAndCreateUser(input.consumeInvitationFor, {
            username: input.username,
            role: input.role,
          });
    return { ok: true, user };
  } catch (error) {
    // **招待が競合で取られていたら、畳んだ 403 に落とす**(`I-G23`。**500 にしない**)。
    if (error instanceof InvitationUnavailableError) {
      return { ok: false, response: c.json(errorBody([invitationRejectedError]), 403) };
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE/i.test(message) || /既に使われています/.test(message)) {
      return { ok: false, response: c.json(errorBody([usernameTakenError(input.username)]), 409) };
    }
    if (/CHECK/i.test(message)) {
      return { ok: false, response: c.json(errorBody([customerRoleUnsupportedError]), 500) };
    }
    return {
      ok: false,
      response: c.json(
        errorBody([{ path: "", message: "ユーザの作成に失敗しました。", hint: message }]),
        500,
      ),
    };
  }
}

const usernameRequired: ValidationError = {
  path: "/username",
  message: "username は必須です。",
  hint: "登録・ログインする username を文字列で指定してください。",
};

function usernameTakenError(username: string): ValidationError {
  return {
    path: "/username",
    message: `ユーザ名 "${username}" は既に使われています。`,
    hint: "別の username を選ぶか、既存アカウントでログインしてください。",
  };
}

/**
 * **サーバ全体の設定(`ST_AUTH_ALLOW_REGISTRATION`)で登録が閉じているときの文面。**
 *
 * =====================================================================================
 * **【2026-08-14。`V8-M4-T01`。裁定 `M4-1` = [`ADR-0335`](0335-signup-single-predicate-and-env-precedence.md)
 * 限定8 の履行。旧文を1バイトも消していない】**
 * =====================================================================================
 *
 * **旧の `hint`(逐語)**:
 *
 *     hint: "管理者に ST_AUTH_ALLOW_REGISTRATION を有効化してもらうか、既存アカウントでログインしてください。",
 *
 * **`message` は1バイトも変えていない**(`新規登録は許可されていません。`)。
 *
 * **足した理由**: **`ADR-0335` 限定8 の逐語** ——「**`registrationClosedError` の `hint` に、
 * 招待があれば通ることを書く**」。 **`D-V8-110` により、`ST_AUTH_ALLOW_REGISTRATION=false`
 * のサーバでも有効な招待だけは env を越えて通る**(実測: `V8-M4` の (C)-3 / (C)-4)。
 * **旧の文面はその道を1文字も書いておらず、招待を持つ人には「管理者に env を変えて
 * もらう」しか道が無いように読めた。**
 *
 * **【`I-G23` を破っていない】** **この文面は次の3つを1文字も述べない**:
 * **そのアプリが招待制か / その相手が招待されているか / そのログイン名が実在するか。**
 * **述べるのは「招待という道が在る」という、すべてのアプリに等しく真な事実だけである。**
 * **{@link invitationRejectedError}(招待経路で失敗したときの文面)とは今日も別である**
 * (`ADR-0337` 限定10)。
 *
 * **【代償。丸めない】** **宣言していないアプリの応答が着手前と変わるものが、これで
 * 3通り目になる**(1: env=false かつ有効な招待が在るとき `403` → `200` /
 * 2: `.../register/options` に既存のログイン名 + 有効な招待で `409` → `200` /
 * 3: 本項の `hint` の文面)。 **【禁止】「既定は1ミリも変わらない」と書かない。**
 */
const registrationClosedError: ValidationError = {
  path: "",
  // **キーの並びを1バイトも変えていない**(`path` → `message` → `hint`)。
  // **応答本文の JSON はキーの順に直列化されるので、並べ替えは本文を変えることになる。**
  message: "新規登録は許可されていません。",
  hint: "管理者に ST_AUTH_ALLOW_REGISTRATION を有効化してもらうか、既存アカウントでログインしてください。有効な招待(運営者から伝えられたログイン名と招待コード)をお持ちの場合は、この設定のままでも登録できます。",
};

/**
 * **招待を要求する経路で登録が成立しなかったときの、たった1つの文面**
 * (`V8-M3-T03`。台帳 `I-G23`。裁定 `M3-3`。`ADR-0337` 限定10)。
 *
 * **次の5つがすべてこの1つになる**(**status も本文も1バイト違わない**):
 * ログイン名が既に使われている / その相手への招待が1件も無い / コードが違う /
 * 招待の期限が切れている / 招待が既に使われている。
 * **`409` を先に返さない** —— **返すと「そのログイン名は実在する」が漏れる。**
 *
 * **{@link registrationClosedError}(env で閉じたときの文面)とは別である**(限定10)。
 *
 * **【漏れるものを先に書く。3点】**
 *
 * 1. **「このアプリが招待制であること」はこの文面から分かる**(`ADR-0337` §限界3)。
 *    **漏らさないと決めたのは「その相手が招待されているか」と「そのログイン名が
 *    実在するか」の2つだけである**(同 §3-8)。
 * 2. **`.../register/options` の2本はこの文面を1度も返さない** —— **あちらは今日どおり
 *    `409` と `403` を返し分ける**(裁定 `M3-2`。同 §限界2)。
 * 3. **応答時間の差を1度も測っていない**(同 §限界4)。
 */
const invitationRejectedError: ValidationError = {
  path: "",
  message: "ユーザIDかコードが違います。",
  hint: "このアプリは招待された人だけが登録できます。運営者から伝えられたログイン名と招待コードを両方そのまま入れてください。コードには期限があります(発行から24時間)。",
};

const challengeInvalidError: ValidationError = {
  path: "",
  message: "認証の途中状態が無効です(期限切れか、やり直しが必要です)。",
  hint: "最初からやり直してください(options の取得からやり直すと新しいチャレンジが発行されます)。",
};

const invalidCredentialsError: ValidationError = {
  path: "",
  message: "username またはパスワードが正しくありません。",
  hint: "入力を確認して再度お試しください。",
};

const passkeyRejectedError: ValidationError = {
  path: "",
  message: "パスキーによる認証を検証できませんでした。",
  hint: "同じ認証器でやり直すか、別の手段でログインしてください。",
};

const notAuthenticatedError: ValidationError = {
  path: "",
  message: "認証されていません。",
  hint: "ログインしてから再度お試しください。",
};

/**
 * **コメントの本文の**形**が違う**(`V10-M11-T01` / 台帳 `CM-G4`)。
 *
 * **口が自分で拒否するのはこれ**1つ**だけである** —— **器(`CommentStore.addComment`)を
 * 呼べない形だからである。** **宛先の形が登録簿に在るか・部品の数が合うか・本文が空でないかは
 * **器**が見る**(`CM-G4` 限定5 = 「口は器の書込関数を1本呼ぶだけ。判定も整形もこの口に書かない」)。
 */
const commentShapeError: ValidationError = {
  path: "",
  message:
    "コメントは anchorForm(文字列)/ anchorParts(文字列の配列)/ body(文字列)の3つで送ってください。",
  hint: '例: { "anchorForm": "view_field", "anchorParts": ["cart", "qty"], "body": "ここは数量を先に出したい" }',
};

/**
 * **コメントの状態を書き換える本文の**形**が違う**(`V10-M13-T02` / `V10-M13-T03` /
 * 台帳 `CM-G19` / `CM-G20`)。
 *
 * **口が自分で拒否するのはこれだけである** —— **器(`CommentStore.updateCommentState`)を
 * 呼べない形だからである。** **`state` の値域(3値のどれか)・`reason` の要否(対応できない
 * という値かどうか)は**器**が見る**(`CM-G19` 限定4 / `CM-G20` 限定3 と同じ設計 ——
 * 口はここでも型に絞らず、文字列をそのまま渡す)。
 */
const commentUpdateShapeError: ValidationError = {
  path: "",
  message:
    "コメントの状態を書き換えるときは comment_id(文字列)/ state(文字列)/ " +
    "reason(文字列。任意)で送ってください。",
  hint: '例: { "comment_id": "<id>", "state": "not_applicable", "reason": "今日の語彙では対応できません" }',
};

/**
 * **コメントの繋ぎ(差分への `diff_id`)を書く本文の**形**が違う**(`V10-M15-T01` /
 * 台帳 `CM-G14`)。
 *
 * **口が自分で拒否するのはこれだけである** —— **器(`CommentStore.linkCommentToDiff`)を
 * 呼べない形だからである。** **`diff_id` が空文字・空白だけかどうかは**器**が見る**
 * (`commentUpdateShapeError` と同じ設計 —— 口はここでも型に絞らず、文字列をそのまま渡す)。
 */
const commentLinkShapeError: ValidationError = {
  path: "",
  message: "差分に繋ぐときは comment_id(文字列)/ diff_id(文字列)で送ってください。",
  hint: '例: { "comment_id": "<id>", "diff_id": "<差分の識別子>" }',
};

/**
 * `state` と `diff_id` を同じ呼びに同時に送った場合(`V10-M15-T01`)。
 *
 * **1回の呼びで2つの列を倒さない**(状態を倒す枝と繋ぎを書く枝を分ける裁定)。
 */
const commentLinkAndStateConflictError: ValidationError = {
  path: "",
  message:
    "state と diff_id は同じ呼びに同時に送れません。1回の呼びでどちらか一方だけを送ってください。",
  hint: "状態を倒すときは state だけ、差分に繋ぐときは diff_id だけを送ってください。",
};

/** 書き換えようとした `comment_id` が今日存在しない場合(404)。 */
function unknownCommentError(commentId: string): ValidationError {
  return {
    path: "",
    message: `コメント "${commentId}" は存在しません。`,
    hint: "comment_id が正しいか確かめてください。存在しない id を倒すことはできません。",
  };
}

/** 管理操作(ユーザ/ロール管理)に owner が要るのに満たない場合(403)。 */
const ownerRequiredError: ValidationError = {
  path: "",
  message: "この操作は owner のみが行えます。",
  allowed_values: ["owner"],
  hint: "ユーザとロールの管理は owner ロールが必要です。owner に依頼してください。",
};

/*
 * =====================================================================================
 * **【`V8-M28` 第2波(2026-08-11)。台帳 `T-G18` / `T-G20`。
 * ユーザ決定 `D-V8-41` / `D-V8-75` / `D-V8-76` / `D-V8-77`】**
 * =====================================================================================
 *
 * **すぐ上の `ownerRequiredError` は1バイトも消していない** —— **残り8箇所の
 * `requireOwner`(監査記録2 / 外部接続2 / AI 能力3 / 逃げ道の資産1)が今日も使っている。**
 *
 * **下の4つは、規則の側へ移した2本の口(役割の配布 / 人と役割の一覧)のための応答体である。**
 * **`allowed_values` に役割の綴りを1つも焼き込んでいない** —— **誰が通るかはアプリごとの
 * 規則で決まるので、固定の一覧を返すと嘘になる。**
 */

/** 役割を配る口に、役割の規則の権限が無い場合(403)。 */
const roleDistributionRuleRequiredError: ValidationError = {
  path: "",
  message:
    "人に役割を配れるのは、その権限を役割の規則で与えられた人だけです。あなたの役割には与えられていません。",
  hint: '役割の規則(app の roles)に「人に役割を配れる」(target: "role" / can: ["write"])が要ります。規則を書ける人に依頼してください。',
};

/**
 * 人と役割の一覧に、役割の規則の権限が無い場合(403)。
 *
 * **【`D-V8-77` の帰結を隠さない】** —— **新2対象の動詞は `write` 1語ちょうどなので、
 * 一覧の可否は「見る」ではなく「**配れるか**」で判定している。** **したがって
 * 「一覧は見せるが配らせない」役割は今日書けない。** **【禁止】これを「一覧に閲覧の権限が
 * 掛かるようになった」と書かない** —— **掛かったのは配布の権限である。**
 */
const userListRuleRequiredError: ValidationError = {
  path: "",
  message:
    "利用者の一覧を見られるのは、人に役割を配れる人だけです。あなたの役割には与えられていません。",
  hint: '役割の規則(app の roles)に「人に役割を配れる」(target: "role" / can: ["write"])が要ります(一覧は配布とひとつづきの権限です)。',
};

/** 自分自身の役割を書き換えようとした場合(403。`D-V8-76`)。 */
const selfRoleAssignmentError: ValidationError = {
  path: "",
  message: "自分自身の役割は変更できません。",
  hint: "自分に役割を足すことも、自分から外すこともできません。別の、役割を配れる人に依頼してください。",
};

/** `owner` を持たない人が `owner` を配ろうとした場合(403。`D-V8-75`)。 */
const ownerAssignmentRequiresOwnerError: ValidationError = {
  path: "/roles",
  message: "owner を配れるのは、自分が owner を持つ人だけです。",
  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G12`。メインの裁定2と同じ理由】**
  // **旧の文面(逐語)**:
  //     hint: "owner 以外の役割(editor / viewer / このアプリが宣言している利用者の種類)は、今までどおり配れます。",
  // **「このアプリが宣言している利用者の種類」は `app.user_kinds` を指しており、今日は嘘である。**
  // **今日の値域は {@link assignableRoleValues} が組む**(予約3ロール + `customer` +
  // `app.roles[].id` のうち予約4語を除いたもの)。**この文面を逐語で固定する検査は1本も無い**
  // (実測: `LC_ALL=C grep -rn "今までどおり配れます" src web scripts` は本行の1件だけ)。
  hint: "owner 以外の役割(editor / viewer / このアプリが宣言している役割)は、今までどおり配れます。",
};

/** 不正な role 指定(400)。 */
/**
 * **`roles`(複数)が不正なときのエラー**(`V8-M16` / `J-G3`)。
 *
 * **`invalidRoleError` と同じ値域を出す** —— 値域の写しを増やさない。**違うのは `path` と
 * 文面だけである**(どこを直せばよいかが読み手に分かるように)。
 */
function invalidRolesError(values: readonly Role[]): ValidationError {
  return {
    path: "/roles",
    message: "roles の値が不正です。",
    allowed_values: [...values],
    hint: "roles には、このアプリで有効な役割を1つ以上、配列で指定してください(空配列は指定できません)。",
  };
}

function invalidRoleError(values: readonly Role[]): ValidationError {
  return {
    path: "/role",
    message: "role の値が不正です。",
    // **【`V5-M17-T03`】値域はアプリごとに変わる**(予約3ロール + 宣言された種類)。
    // **【`V8-M29` 第1波】そこへ `app.roles[].id` が加わった**(`anonymous` を除く)。
    allowed_values: [...values],
    hint: "role は運営の owner / editor / viewer か、このアプリが宣言している役割(app の roles)・利用者の種類のいずれかを指定してください。",
  };
}

/** パスワード変更の本文の形が違う場合(400。E-G68)。 */
const passwordChangeShapeError: ValidationError = {
  path: "",
  message: "current_password と new_password を文字列で指定してください。",
  hint: '{ "current_password": "いまのパスワード", "new_password": "新しいパスワード" } の形で送ってください。',
};

/** パスワードを持たない(Passkey だけの)本人が変更を求めた場合(409。E-G68)。 */
const noPasswordCredentialError: ValidationError = {
  path: "",
  message: "このアカウントにはパスワードが設定されていません。",
  hint: "Passkey だけで登録したアカウントです。パスワードを後から設定する経路は今日ありません。",
};

/** 最後の owner が退会しようとした場合(409。E-G68)。 */
const lastOwnerWithdrawalError: ValidationError = {
  path: "",
  message: "最後の owner は退会できません。",
  hint: "先に別のユーザを owner に昇格してから、もう一度お試しください。",
};

/** 最後の owner を降格しようとした場合(409)。 */
const lastOwnerRejectedError: ValidationError = {
  path: "/role",
  message: "最後の owner は降格できません。",
  hint: "先に別のユーザを owner に昇格してから、このユーザのロールを変更してください。",
};

/**
 * **人に役割を配れる人が0人になる操作を拒否した場合**(409。`V8-M30`。台帳 `T-G29` /
 * ユーザ決定 `D-V8-47`)。**`lastOwnerRejectedError`(1本目)とは別の文面である** ——
 * **止めている理由が違うので、同じ文面に畳まない。**
 */
const lastGranterRejectedError: ValidationError = {
  path: "",
  message: "役割を配れる人が0人になるため、この操作はできません。",
  hint: "先に別のユーザへ「人に役割を配れる」役割(role + write の規則を持つ役割)を付けてから、もう一度お試しください。",
};

/** 管理対象のユーザが存在しない場合(404)。 */
function unknownUserError(userId: string): ValidationError {
  return {
    path: "",
    message: `ユーザ "${userId}" は存在しません。`,
    hint: "GET /api/apps/<app_id>/auth/users で実在するユーザ一覧を取得できます。",
  };
}

/**
 * `/api/apps/:app_id/auth/*` を app に登録する。
 * Origin 検査(CSRF)は app.ts 側の middleware が先に張ってある(認証は要求しない)。
 */
export function registerAuthRoutes(app: Hono<AuthEnv>, deps: AuthRouteDeps): void {
  const {
    authConfig,
    canDistributeRoles,
    dataRoot,
    ensureApp,
    escapeHatchAssetRoutes,
    inviteOnlyRoleIds,
    manifestFor,
    roleIds,
  } = deps;

  /**
   * **そのアプリで人に付けられる役割の全体**(`V8-M29` 第1波)。
   * **値域を組む式をこのファイルの2箇所に書かない** —— **1本に閉じる。**
   */
  const assignableValues = (appId: string): readonly Role[] => assignableRoleValues(roleIds(appId));

  /** **そのアプリで登録のときに名乗れる値の全体**(`D-V8-78`)。同じく1本に閉じる。 */
  const signupValues = (appId: string): readonly string[] => signupKindValues(roleIds(appId));

  /** app 実在を確かめて per-app store を開く。実在しなければ 404 応答を返す。 */
  const openStore = (
    c: Context<AuthEnv>,
    appId: string,
  ): { ok: true; store: AuthStore } | { ok: false; response: Response } => {
    const appError = ensureApp(appId);
    if (appError !== null) {
      return { ok: false, response: c.json(errorBody([appError]), 404) };
    }
    const store = AuthStore.openForApp(dataRoot, appId);
    // **【`V8-M30`。台帳 `T-G29`】締め出しの防止の2本目を、この接続に配線する。**
    //
    // **判定の家は1本のままである**(`ADR-0305` 限定3)—— **渡しているのは
    // `canDistributeRoles`(= `judgeRoleAccess({ target: "role", verb: "write" })`)であり、
    // `src/auth/store.ts` に規則を読む条件式を1行も書いていない。**
    //
    // **【なぜ import ではなく注入なのか】** **`src/auth/` は `src/server/` を1本も
    // import していない**(向きは一方通行で、逆向きに張ると循環になる)。**したがって
    // 判定を渡す形を採った。** **`src/server/owner-scope.ts` は1バイトも触っていない。**
    store.setRoleGrantJudge((roles) => canDistributeRoles(appId, roles));
    return { ok: true, store };
  };

  /**
   * 管理エンドポイント用のガード。セッションを解決し、owner ロールを要求する。
   * 未認証は 401、認証済みだが owner でなければ 403(records の書込 403 と同型)。
   * middleware は auth/* に認証を掛けないので、/auth/me と同様ここで自前解決する。
   */
  const requireOwner = (
    c: Context<AuthEnv>,
    store: AuthStore,
  ): { ok: true; user: User } | { ok: false; response: Response } => {
    const sessionId = getCookie(c, SESSION_COOKIE);
    if (sessionId !== undefined && sessionId !== "") {
      const session = resolveSession(store, sessionId);
      if (session !== null) {
        const user = store.findUserById(session.userId);
        if (user !== undefined) {
          // **【`V8-M16` / `J-G3`】実効ロール集合に `owner` が1つでも在れば通る。**
          // **根拠は限定の逐語「複数の役割は和集合1本で合成する」である** ——
          // **列に在るか付与表に在るかを、ここでは区別しない。**
          if (!store.effectiveRoles(user.id).includes("owner")) {
            return { ok: false, response: c.json(errorBody([ownerRequiredError]), 403) };
          }
          return { ok: true, user };
        }
      }
    }
    return { ok: false, response: c.json(errorBody([notAuthenticatedError]), 401) };
  };

  /**
   * **役割を配れる人だけを通すガード**(`V8-M28` 第2波。台帳 `T-G18` /
   * ユーザ決定 `D-V8-41` / `D-V8-77`)。**{@link requireOwner} の役割の綴りの等値1本を、
   * 役割の規則の判定へ置き換えたものである。**
   *
   * **セッションの解き方は {@link requireOwner} と1バイトも変えていない**
   * (未認証は今日どおり 401)。**変わったのは可否の決め方だけである** ——
   * **`store.effectiveRoles(user.id).includes("owner")` から
   * `canDistributeRoles(appId, store.effectiveRoles(user.id))` へ。**
   *
   * **判定そのものは `src/server/owner-scope.ts` の `judgeRoleAccess` 1本が持つ**
   * (`ADR-0305` 限定3)—— **ここに規則を読む条件式は1行も無い。**
   *
   * @param denied **403 のときに返す本文。** **口ごとに文面を分けられるようにしてある**
   *   (配布と一覧で「何ができないのか」が違うため)。
   */
  const requireRoleDistribution = (
    c: Context<AuthEnv>,
    store: AuthStore,
    appId: string,
    denied: ValidationError,
  ): { ok: true; user: User; roles: readonly Role[] } | { ok: false; response: Response } => {
    const sessionId = getCookie(c, SESSION_COOKIE);
    if (sessionId !== undefined && sessionId !== "") {
      const session = resolveSession(store, sessionId);
      if (session !== null) {
        const user = store.findUserById(session.userId);
        if (user !== undefined) {
          // **【`V8-M16` / `J-G3`】実効ロール集合を渡す**(列に在るか付与表に在るかを区別しない)。
          const roles = store.effectiveRoles(user.id);
          if (!canDistributeRoles(appId, roles)) {
            return { ok: false, response: c.json(errorBody([denied]), 403) };
          }
          return { ok: true, user, roles };
        }
      }
    }
    return { ok: false, response: c.json(errorBody([notAuthenticatedError]), 401) };
  };

  // --- Passkey 登録 ----------------------------------------------------------
  //
  // 管理経路(初回 owner / 以降 viewer)と顧客経路(常に customer)は、**ロール決定
  // (SignupPolicy)だけを差し替えた同一の実装**を共有する(重複を避けつつ、昇格不可を
  // 経路固定で構造保証する。ADR-0033 §1b・限定2)。ロールは本文から一切受け取らない。

  // 未登録 username のみ新規作成できる(既存は 409。ADR-0014 §9)。
  const passkeyRegisterOptions =
    (policy: SignupPolicy) =>
    async (c: Context<AuthEnv>): Promise<Response> => {
      const appId = c.req.param("app_id") as string;
      const body = await readBody(c);
      if (!body.ok) {
        return body.response;
      }
      const username = body.value.username;
      if (typeof username !== "string" || username === "") {
        return c.json(errorBody([usernameRequired]), 400);
      }
      const opened = openStore(c, appId);
      if (!opened.ok) {
        return opened.response;
      }
      const store = opened.store;
      try {
        // =====================================================================
        // **【`V8-M3-T04`。裁定 `M3-2`。`ADR-0337` §3-3 / 限定14】**
        // **この口には関門を置いていない。** **入れたのは**逃がし**1つだけである。**
        // =====================================================================
        //
        // **旧(逐語。下の `if (invitation === undefined) { ... }` の中身がそれである)**:
        //
        //     if (store.findUserByUsername(username) !== undefined) {
        //       return c.json(errorBody([usernameTakenError(username)]), 409);
        //     }
        //     if (!registrationAllowed(store, authConfig, policy)) {
        //       return c.json(errorBody([registrationClosedError]), 403);
        //     }
        //
        // **有効な招待を引けたときだけ、この2つを**どちらも飛ばす**。**
        // **引けなければ旧の分岐に1バイトも触っていない。**
        //
        // **【なぜ逃がしが要るのか】** **`D-V8-110`(有効な招待は env の閉じを越える)を
        // passkey 経路でも成立させるためである** —— **無いと、`ST_AUTH_ALLOW_REGISTRATION=false`
        // のサーバでは招待された人が passkey で登録できない**(この口で 403 になる)。
        //
        // **【この口は名乗った役割を1バイトも読まない】**(限定14)——
        // **読むと `ADR-0334` 限定14 の読み方が3通り目になる。**
        //
        // **【限界。隠さない】** **招待を持たない相手に対しては、今日どおり 409 と 403 を
        // 返し分ける。** **したがって `I-G23`(そのログイン名が実在するかを漏らさない)は
        // この口では成り立たない**(`ADR-0337` §限界2)。
        const invitation = invitationFrom(store, username, body.value.invitation_code);
        if (invitation === undefined) {
          if (store.findUserByUsername(username) !== undefined) {
            return c.json(errorBody([usernameTakenError(username)]), 409);
          }
          if (!registrationAllowed(store, authConfig, policy)) {
            return c.json(errorBody([registrationClosedError]), 403);
          }
        }
        // WebAuthn userID 用に不透明 id を割り当てる(user 本体は verify 時に作る)。
        // role は WebAuthn options に出ない表示用の暫定値(実ロールは verify 時に確定する)。
        const provisionalUser: User = {
          id: randomId(),
          username,
          displayName: null,
          role: "viewer",
          createdAt: new Date().toISOString(),
        };
        const options = await buildRegistrationOptions({
          config: authConfig,
          user: provisionalUser,
          existingCredentials: [],
        });
        const pending = store.savePendingChallenge({
          challenge: options.challenge,
          purpose: "registration",
          username,
          ttlSec: authConfig.challengeTtlSec,
        });
        setPendingCookie(c, authConfig, appId, pending.id);
        return c.json(options, 200);
      } finally {
        store.close();
      }
    };

  const passkeyRegisterVerify =
    (policy: SignupPolicy) =>
    async (c: Context<AuthEnv>): Promise<Response> => {
      const appId = c.req.param("app_id") as string;
      const body = await readBody(c);
      if (!body.ok) {
        return body.response;
      }
      const opened = openStore(c, appId);
      if (!opened.ok) {
        return opened.response;
      }
      const store = opened.store;
      try {
        const pending = takeValidPending(store, getCookie(c, PENDING_COOKIE), "registration");
        if (pending === null || pending.username === null) {
          deleteCookie(c, PENDING_COOKIE, { path: cookiePath(appId) });
          return c.json(errorBody([challengeInvalidError]), 400);
        }
        deleteCookie(c, PENDING_COOKIE, { path: cookiePath(appId) });

        // =====================================================================
        // **【`V8-M3-T04`。台帳 `I-G20` / `I-G23`。裁定 `M3-3`。`ADR-0337` §3-4】**
        // **副作用の無い値を先に採る。** **早期 `return` の順序は1バイトも変えていない。**
        // =====================================================================
        //
        // **旧(逐語)**:
        //
        //     if (store.findUserByUsername(pending.username) !== undefined) {
        //       return c.json(errorBody([usernameTakenError(pending.username)]), 409);
        //     }
        //     if (!registrationAllowed(store, authConfig, policy)) {
        //       return c.json(errorBody([registrationClosedError]), 403);
        //     }
        //
        // **照合に使うログイン名は本文ではなく `pending.username` である**(`ADR-0337` §3-4)。
        //
        // **【名乗りの検査の位置は1ミリも動かしていない】** —— **`resolveRequestedUserKind`
        // は副作用を持たないので**値だけ**をここで採り、`422` を返すのは今日と同じ位置
        // (WebAuthn の検証の**後**)である。** **`store.countUsers()` も同じで、
        // 間にユーザを作る処理が1つも無いので値は変わらない。**
        const taken = store.findUserByUsername(pending.username) !== undefined;
        const requested = resolveRequestedUserKind(body.value.user_kind, signupValues(appId));
        const invitation = invitationFrom(store, pending.username, body.value.invitation_code);
        // **【`V8-M30` 第2波 / `D-V8-82`】ユーザを作る**前**に数える**
        // (作ったあとでは必ず1人以上になる)。
        const wasFirstUser = store.countUsers() === 0;
        const gate = invitationRequired(
          policy,
          inviteOnlyRoleIds(appId),
          requested.ok ? requested.kind : undefined,
          roleIds(appId),
        );
        if (gate && !wasFirstUser) {
          // **招待を要求する枝。5つの失敗を1つの `403` に畳む**(裁定 `M3-3`)——
          // **ログイン名重複 / 招待が無い / コードが違う / 期限切れ / 使用済み。**
          // **`409` を先に返さない。**
          if (invitation === undefined || taken) {
            return c.json(errorBody([invitationRejectedError]), 403);
          }
        } else {
          // **今日どおりの順序。招待が無いかぎり1バイトも変わらない。**
          if (taken) {
            return c.json(errorBody([usernameTakenError(pending.username)]), 409);
          }
          // **【裁定 `M3-4` / `D-V8-110`】有効な招待は env を越える** ——
          // **宣言の有無を問わない。** **旧の逐語は
          // `if (!registrationAllowed(store, authConfig, policy)) {` である。**
          if (invitation === undefined && !registrationAllowed(store, authConfig, policy)) {
            return c.json(errorBody([registrationClosedError]), 403);
          }
        }

        let verification: Awaited<ReturnType<typeof verifyRegistration>>;
        try {
          // SimpleWebAuthn の startRegistration 出力(JSON)をそのまま透過する。
          const response = body.value.response as RegistrationResponseJSON;
          verification = await verifyRegistration({
            config: authConfig,
            response,
            expectedChallenge: pending.challenge,
          });
        } catch {
          return c.json(errorBody([passkeyRejectedError]), 400);
        }
        if (!verification.verified) {
          return c.json(errorBody([passkeyRejectedError]), 400);
        }

        // ロールは経路(policy)が決める。**【`V5-M17-T04` / `ADR-0158` 限定9】非運営の
        // 経路だけが本文の `user_kind` を受け取る**(運営ロールは1度も受け取らない)。
        // **【`V8-M29` 第1波 / `D-V8-78`】旧: `resolveRequestedUserKind(body.value.user_kind, userKindIds(appId))`**
        // **名乗れるのは「アプリが自分で作った役割」だけである**(予約4語は入らない)。
        // **【`V8-M3-T04`】値を採る行は上へ移したが、`422` を返す位置はここのままである。**
        if (!requested.ok) {
          return c.json(errorBody([requested.error]), 422);
        }
        // **【`V8-M1-T04` / `ADR-0335` 限定1・限定2】登録の可否は述語1本が決める。**
        // **ここはユーザを作る**前**であり、名乗った役割が確定した**後**である** ——
        // **`ADR-0334` 限定14 の「役割ごとの指定」は、この位置でしか効かせられない。**
        // **【`V8-M3-T04`。旧の逐語は `invited: false,`】** **今日はじめて `false` 以外が
        // 入る** —— **`ADR-0337` §S3 の 6 が予告した「今日常に `false` である」という
        // 記述は、この行によって偽になった。**
        if (
          !signupAllowed({
            store,
            config: authConfig,
            policy,
            wasFirstUser,
            inviteOnlyRoles: inviteOnlyRoleIds(appId),
            requestedKind: requested.kind,
            declaredRoleIds: roleIds(appId),
            invited: invitation !== undefined,
          })
        ) {
          return c.json(errorBody([registrationClosedError]), 403);
        }
        const created = createUserSafely(c, store, {
          username: pending.username,
          role: policy.resolveRole(store, requested.kind),
          // **【`V8-M3-T05`】印を立てるのとユーザを作るのを1つのトランザクションに入れる**
          // (`ADR-0336` 限定17 / `ADR-0337` 限定11)。
          ...(invitation === undefined ? {} : { consumeInvitationFor: invitation.username }),
        });
        if (!created.ok) {
          return created.response;
        }
        // **【`V8-M30` 第2波 / `D-V8-82`。旧の4行を逐語で残す】**
        //
        //     const user = created.user;
        //     // 顧客経路は owner をブートストラップしない(healOwner=false。ADR-0033 §1b)。
        //     if (policy.healOwner) {
        //       store.ensureOwnerExists();
        //     }
        //
        // **判定は {@link bootstrapFirstUserOwner} 1本が持つ**(2経路に写しを作らない)。
        const user = bootstrapFirstUserOwner(store, policy, created.user, wasFirstUser);
        // **【`V8-M3-T06`。台帳 `I-G22`。裁定 `M0-2`。`ADR-0337` §3-6】**
        // **役割は招待の行から来る** —— **本文の `role` を1度も読まない**(限定6)。
        // **これが `ADR-0158` 限定9 の「昇格不可の構造保証」を保つ理由である。**
        //
        // **【限界。隠さない】** **最初の1人は列が `owner` に据わり、招待に書かれた役割は
        // それに**足される**** —— **「招待に書かれたとおりの立場になる」は最初の1人に
        // ついては成り立たない**(`ADR-0337` §限界1)。
        // **判定を2箇所に写していない** —— **`bootstrapFirstUserOwner` は1バイトも
        // 変えていない**(限定7)。
        if (invitation !== undefined) {
          store.grantRole(user.id, invitation.role);
        }
        store.addWebauthnCredential({
          id: verification.credential.id,
          userId: user.id,
          publicKey: verification.credential.publicKey,
          counter: verification.credential.counter,
          ...(verification.credential.transports === undefined
            ? {}
            : { transports: verification.credential.transports }),
          deviceType: verification.deviceType,
          backedUp: verification.backedUp,
        });
        const session = issueSession(store, user.id, authConfig.sessionTtlSec);
        setSessionCookie(c, authConfig, appId, session);
        return c.json({ user: userView(store, user) }, 200);
      } finally {
        store.close();
      }
    };

  // 管理経路(初回 owner / 以降 viewer)。
  app.post("/api/apps/:app_id/auth/passkey/register/options", passkeyRegisterOptions(ADMIN_SIGNUP));
  app.post("/api/apps/:app_id/auth/passkey/register/verify", passkeyRegisterVerify(ADMIN_SIGNUP));
  // **非運営のセルフサインアップ経路**(`V5-M17-T04` / `G-G6` / `ADR-0158` 限定9)。
  // **【着手前は `/auth/customer/...` だった】** —— **HTTP パスに種類の名前が焼き込まれて
  // おり、アプリが種類を名付けられるようになると嘘になる**(04 §4-2 の `G-G6`)。
  // **`signup` は種類の名前ではなく「この経路が何をするか」である。**
  app.post(
    "/api/apps/:app_id/auth/signup/passkey/register/options",
    passkeyRegisterOptions(SELF_SIGNUP),
  );
  app.post(
    "/api/apps/:app_id/auth/signup/passkey/register/verify",
    passkeyRegisterVerify(SELF_SIGNUP),
  );

  // --- Passkey ログイン ------------------------------------------------------

  app.post("/api/apps/:app_id/auth/passkey/login/options", async (c) => {
    const appId = c.req.param("app_id");
    const body = await readBody(c);
    if (!body.ok) {
      return body.response;
    }
    const opened = openStore(c, appId);
    if (!opened.ok) {
      return opened.response;
    }
    const store = opened.store;
    try {
      const username = body.value.username;
      const options = await buildAuthenticationOptions({
        config: authConfig,
        ...(typeof username === "string" && username !== ""
          ? (() => {
              const user = store.findUserByUsername(username);
              return user === undefined
                ? {}
                : { allowCredentials: store.getWebauthnCredentialsByUser(user.id) };
            })()
          : {}),
      });
      const pending = store.savePendingChallenge({
        challenge: options.challenge,
        purpose: "authentication",
        ttlSec: authConfig.challengeTtlSec,
      });
      setPendingCookie(c, authConfig, appId, pending.id);
      return c.json(options, 200);
    } finally {
      store.close();
    }
  });

  app.post("/api/apps/:app_id/auth/passkey/login/verify", async (c) => {
    const appId = c.req.param("app_id");
    const body = await readBody(c);
    if (!body.ok) {
      return body.response;
    }
    const opened = openStore(c, appId);
    if (!opened.ok) {
      return opened.response;
    }
    const store = opened.store;
    try {
      const pending = takeValidPending(store, getCookie(c, PENDING_COOKIE), "authentication");
      deleteCookie(c, PENDING_COOKIE, { path: cookiePath(appId) });
      if (pending === null) {
        return c.json(errorBody([challengeInvalidError]), 401);
      }
      // SimpleWebAuthn の startAuthentication 出力(JSON)。id は credential ID(base64url)。
      const rawResponse = body.value.response;
      if (typeof rawResponse !== "object" || rawResponse === null) {
        return c.json(errorBody([passkeyRejectedError]), 401);
      }
      const response = rawResponse as AuthenticationResponseJSON;
      const credentialId = typeof response.id === "string" ? response.id : undefined;
      if (credentialId === undefined) {
        return c.json(errorBody([passkeyRejectedError]), 401);
      }
      const credential = store.getWebauthnCredentialById(credentialId);
      if (credential === undefined) {
        return c.json(errorBody([passkeyRejectedError]), 401);
      }

      let verification: Awaited<ReturnType<typeof verifyAuthentication>>;
      try {
        verification = await verifyAuthentication({
          config: authConfig,
          response,
          expectedChallenge: pending.challenge,
          credential,
        });
      } catch {
        // counter 後退(クローン疑い)を含む検証失敗はすべて 401 に倒す。
        return c.json(errorBody([passkeyRejectedError]), 401);
      }
      if (!verification.verified) {
        return c.json(errorBody([passkeyRejectedError]), 401);
      }
      store.updateCredentialCounter(credential.id, verification.newCounter);
      const user = store.findUserById(credential.userId);
      if (user === undefined) {
        return c.json(errorBody([passkeyRejectedError]), 401);
      }
      // owner 不変条件の自己修復(password login と同型)。
      store.ensureOwnerExists();
      const healed = store.findUserById(user.id) ?? user;
      const session = issueSession(store, user.id, authConfig.sessionTtlSec);
      setSessionCookie(c, authConfig, appId, session);
      return c.json({ user: userView(store, healed) }, 200);
    } finally {
      store.close();
    }
  });

  // --- password ログイン/登録 ------------------------------------------------

  const passwordRegister =
    (policy: SignupPolicy) =>
    async (c: Context<AuthEnv>): Promise<Response> => {
      const appId = c.req.param("app_id") as string;
      const body = await readBody(c);
      if (!body.ok) {
        return body.response;
      }
      const username = body.value.username;
      const password = body.value.password;
      if (typeof username !== "string" || username === "") {
        return c.json(errorBody([usernameRequired]), 400);
      }
      if (typeof password !== "string" || password === "") {
        return c.json(errorBody([{ path: "/password", message: "password は必須です。" }]), 400);
      }
      const opened = openStore(c, appId);
      if (!opened.ok) {
        return opened.response;
      }
      const store = opened.store;
      try {
        // =====================================================================
        // **【`V8-M3-T04`。台帳 `I-G20` / `I-G23`。裁定 `M3-3`。`ADR-0337` §3-4】**
        // **副作用の無い値を先に採る。** **早期 `return` の順序は1バイトも変えていない。**
        // =====================================================================
        //
        // **旧(逐語)**:
        //
        //     if (store.findUserByUsername(username) !== undefined) {
        //       return c.json(errorBody([usernameTakenError(username)]), 409);
        //     }
        //     if (!registrationAllowed(store, authConfig, policy)) {
        //       return c.json(errorBody([registrationClosedError]), 403);
        //     }
        //
        // **分岐は写るが、述語は写っていない**(`ADR-0337` §S3 の 2 の自認)——
        // **`invitationRequired` も `invitationFrom` も1本ずつである。**
        const taken = store.findUserByUsername(username) !== undefined;
        // ロールは経路(policy)が決める。**【`V5-M17-T04` / `ADR-0158` 限定9】非運営の
        // 経路だけが本文の `user_kind` を受け取る**(運営ロールは1度も受け取らない)。
        // **【`V8-M29` 第1波 / `D-V8-78`】旧: `resolveRequestedUserKind(body.value.user_kind, userKindIds(appId))`**
        // **名乗れるのは「アプリが自分で作った役割」だけである**(予約4語は入らない)。
        const requested = resolveRequestedUserKind(body.value.user_kind, signupValues(appId));
        const invitation = invitationFrom(store, username, body.value.invitation_code);
        // **【`V8-M30` 第2波 / `D-V8-82`】ユーザを作る**前**に数える。**
        const wasFirstUser = store.countUsers() === 0;
        const gate = invitationRequired(
          policy,
          inviteOnlyRoleIds(appId),
          requested.ok ? requested.kind : undefined,
          roleIds(appId),
        );
        if (gate && !wasFirstUser) {
          // **招待を要求する枝。5つの失敗を1つの `403` に畳む**(裁定 `M3-3`)。
          if (invitation === undefined || taken) {
            return c.json(errorBody([invitationRejectedError]), 403);
          }
        } else {
          // **今日どおりの順序。招待が無いかぎり1バイトも変わらない。**
          if (taken) {
            return c.json(errorBody([usernameTakenError(username)]), 409);
          }
          // **【裁定 `M3-4` / `D-V8-110`】有効な招待は env を越える** ——
          // **宣言の有無を問わない。** **旧の逐語は
          // `if (!registrationAllowed(store, authConfig, policy)) {` である。**
          if (invitation === undefined && !registrationAllowed(store, authConfig, policy)) {
            return c.json(errorBody([registrationClosedError]), 403);
          }
        }
        // **名乗りの検査は招待経路でも今日どおり残す**(`ADR-0337` §3-4)。
        if (!requested.ok) {
          return c.json(errorBody([requested.error]), 422);
        }
        // **【`V8-M1-T04` / `ADR-0335` 限定1・限定2】登録の可否は述語1本が決める。**
        // **写しを作らない** —— **passkey verify と同じ関数を、同じ位置で呼んでいる。**
        // **【`V8-M3-T04`。旧の逐語は `invited: false,`】**
        if (
          !signupAllowed({
            store,
            config: authConfig,
            policy,
            wasFirstUser,
            inviteOnlyRoles: inviteOnlyRoleIds(appId),
            requestedKind: requested.kind,
            declaredRoleIds: roleIds(appId),
            invited: invitation !== undefined,
          })
        ) {
          return c.json(errorBody([registrationClosedError]), 403);
        }
        const created = createUserSafely(c, store, {
          username,
          role: policy.resolveRole(store, requested.kind),
          // **【`V8-M3-T05`】印を立てるのとユーザを作るのを1つのトランザクションに入れる**
          // (`ADR-0336` 限定17 / `ADR-0337` 限定11)。
          ...(invitation === undefined ? {} : { consumeInvitationFor: invitation.username }),
        });
        if (!created.ok) {
          return created.response;
        }
        store.setPassword(created.user.id, await hashPassword(password));
        // **【`V8-M30` 第2波 / `D-V8-82`。旧の6行を逐語で残す】**
        //
        //     const user = created.user;
        //     store.setPassword(user.id, await hashPassword(password));
        //     // 顧客経路は owner をブートストラップしない(healOwner=false。ADR-0033 §1b)。
        //     // 管理経路は移行 DB 等で owner=0 になっていれば最古を昇格する。
        //     if (policy.healOwner) {
        //       store.ensureOwnerExists();
        //     }
        //
        // **判定は {@link bootstrapFirstUserOwner} 1本が持つ**(2経路に写しを作らない)。
        const user = bootstrapFirstUserOwner(store, policy, created.user, wasFirstUser);
        // **【`V8-M3-T06`。台帳 `I-G22`。裁定 `M0-2`。`ADR-0337` §3-6】**
        // **役割は招待の行から来る** —— **本文の `role` を1度も読まない**(限定6)。
        // **これが `ADR-0158` 限定9 の「昇格不可の構造保証」を保つ理由である。**
        //
        // **【限界。隠さない】** **最初の1人は列が `owner` に据わり、招待に書かれた役割は
        // それに**足される**** —— **「招待に書かれたとおりの立場になる」は最初の1人に
        // ついては成り立たない**(`ADR-0337` §限界1)。
        // **判定を2箇所に写していない** —— **`bootstrapFirstUserOwner` は1バイトも
        // 変えていない**(限定7)。
        if (invitation !== undefined) {
          store.grantRole(user.id, invitation.role);
        }
        const session = issueSession(store, user.id, authConfig.sessionTtlSec);
        setSessionCookie(c, authConfig, appId, session);
        return c.json({ user: userView(store, user) }, 200);
      } finally {
        store.close();
      }
    };

  // 管理経路(初回 owner / 以降 viewer)。
  app.post("/api/apps/:app_id/auth/password/register", passwordRegister(ADMIN_SIGNUP));
  // **非運営のセルフサインアップ経路**(`V5-M17-T04` / `G-G6`。着手前は `/auth/customer/...`)。
  app.post("/api/apps/:app_id/auth/signup/password/register", passwordRegister(SELF_SIGNUP));

  app.post("/api/apps/:app_id/auth/password/login", async (c) => {
    const appId = c.req.param("app_id");
    const body = await readBody(c);
    if (!body.ok) {
      return body.response;
    }
    const username = body.value.username;
    const password = body.value.password;
    if (typeof username !== "string" || typeof password !== "string") {
      // ユーザ有無を漏らさないため、形式不備も同じ 401 に倒す。
      return c.json(errorBody([invalidCredentialsError]), 401);
    }
    const opened = openStore(c, appId);
    if (!opened.ok) {
      return opened.response;
    }
    const store = opened.store;
    try {
      const user = store.findUserByUsername(username);
      if (user === undefined) {
        return c.json(errorBody([invalidCredentialsError]), 401);
      }
      const credential = store.getPassword(user.id);
      if (credential === undefined) {
        return c.json(errorBody([invalidCredentialsError]), 401);
      }
      const ok = await verifyPassword(password, credential.passwordHash);
      if (!ok) {
        return c.json(errorBody([invalidCredentialsError]), 401);
      }
      // owner 不変条件の自己修復(T01 移行 DB で owner=0 になっていれば最古を昇格)。
      // 読み取り経路には置かず、認証成功のこの書込経路でのみ実行する(計画 v2 §オーナー不変条件)。
      store.ensureOwnerExists();
      const healed = store.findUserById(user.id) ?? user;
      const session = issueSession(store, user.id, authConfig.sessionTtlSec);
      setSessionCookie(c, authConfig, appId, session);
      return c.json({ user: userView(store, healed) }, 200);
    } finally {
      store.close();
    }
  });

  // --- セッション ------------------------------------------------------------

  // 未認証でも無害に 200(冪等)。cookie があれば失効させる。
  app.post("/api/apps/:app_id/auth/logout", (c) => {
    const appId = c.req.param("app_id");
    const opened = openStore(c, appId);
    if (!opened.ok) {
      return opened.response;
    }
    const store = opened.store;
    try {
      const sessionId = getCookie(c, SESSION_COOKIE);
      if (sessionId !== undefined && sessionId !== "") {
        revokeSession(store, sessionId);
      }
    } finally {
      store.close();
    }
    deleteCookie(c, SESSION_COOKIE, { path: cookiePath(appId) });
    return c.json({ ok: true }, 200);
  });

  // 認証済みなら本人を返す。未認証は 401(フロントはこれをログイン誘導に翻訳する)。
  // middleware は auth/* に認証を掛けないので、ここで自分でセッションを解決する。
  app.get("/api/apps/:app_id/auth/me", (c) => {
    const appId = c.req.param("app_id");
    const opened = openStore(c, appId);
    if (!opened.ok) {
      return opened.response;
    }
    const store = opened.store;
    try {
      const sessionId = getCookie(c, SESSION_COOKIE);
      if (sessionId !== undefined && sessionId !== "") {
        const session = resolveSession(store, sessionId);
        if (session !== null) {
          const user = store.findUserById(session.userId);
          if (user !== undefined) {
            return c.json({ user: userView(store, user) }, 200);
          }
        }
      }
      return c.json(errorBody([notAuthenticatedError]), 401);
    } finally {
      store.close();
    }
  });

  // --- 本人の資格情報のやり直しと退会(E-G68 / V4-M6)-------------------------------
  //
  // **着手前は、パスワードの変更も、忘れたときの再設定も、退会も1本も無かった**
  // (`store.setPassword` を呼ぶのは登録経路だけ / ユーザを消すルートは0本。02 §5-10 `E-G68`)。
  // **客がパスワードを忘れたら二度とそのアカウントに戻れず、個人情報の削除要求にも応えられない。**
  //
  // **ここで開けるのは「本人がやり直せる2本」だけである**(どちらも認証済みの本人にしか
  // 効かない。ロールを1つも見ない = owner の特権を1ミリも増やさない):
  //   1. **`POST .../auth/password/change`** —— 現在のパスワードを確かめてから差し替える。
  //   2. **`DELETE .../auth/me`** —— 退会(最後の owner は 409)。
  //
  // **足していないもの(「できるようになった」と書かないために明記する)**:
  //   - **忘れたときの再設定** —— **メールを送る経路がこの製品に1本も無い**ので、本人確認の
  //     手段が作れない。**「パスワードを忘れても戻れる」とは今日も書けない。**
  //   - **運営による他人のパスワード再発行** —— 他人の資格情報を書き換える権限を owner に
  //     与える変更であり、`E-G53` と同じ「線の引き直し」に当たる(審査の対象)。
  //   - **Passkey の付け外し** —— 退会では credentials ごと消えるが、**個別に外す口は無い。**

  /**
   * 本人であることだけを要求するガード(ロールを1つも見ない)。未認証は 401。
   * `requireOwner` と対で、**開ける相手が「本人」か「owner」かを型と関数名で分ける。**
   */
  const requireUser = (
    c: Context<AuthEnv>,
    store: AuthStore,
  ): { ok: true; user: User } | { ok: false; response: Response } => {
    const sessionId = getCookie(c, SESSION_COOKIE);
    if (sessionId !== undefined && sessionId !== "") {
      const session = resolveSession(store, sessionId);
      if (session !== null) {
        const user = store.findUserById(session.userId);
        if (user !== undefined) {
          return { ok: true, user };
        }
      }
    }
    return { ok: false, response: c.json(errorBody([notAuthenticatedError]), 401) };
  };

  /**
   * ログインしていれば利用者を返し、していなければ `null` を返す(**401 にしない**)。
   * `requireUser` / `requireOwner` と違い、未ログインを**拒否ではなく「値が無い」**として
   * 扱う —— `V10-M13-T01`(`CM-G10`)がコメントの書き手を解決するために使う。
   *
   * **本人であることは1ミリも確かめない**(`actor-guard.ts:19`-`:24` と同じ扱い)。
   * セッションが指す利用者が今日も実在することしか見ない。
   */
  const resolveOptionalUser = (c: Context<AuthEnv>, store: AuthStore): User | null => {
    const sessionId = getCookie(c, SESSION_COOKIE);
    if (sessionId === undefined || sessionId === "") {
      return null;
    }
    const session = resolveSession(store, sessionId);
    if (session === null) {
      return null;
    }
    return store.findUserById(session.userId) ?? null;
  };

  app.post("/api/apps/:app_id/auth/password/change", async (c) => {
    const appId = c.req.param("app_id");
    const opened = openStore(c, appId);
    if (!opened.ok) {
      return opened.response;
    }
    const store = opened.store;
    try {
      const authed = requireUser(c, store);
      if (!authed.ok) {
        return authed.response;
      }
      const body = await readBody(c);
      if (!body.ok) {
        return body.response;
      }
      const current = body.value.current_password;
      const next = body.value.new_password;
      if (typeof current !== "string" || typeof next !== "string" || next === "") {
        return c.json(errorBody([passwordChangeShapeError]), 400);
      }
      const credential = store.getPassword(authed.user.id);
      if (credential === undefined) {
        // Passkey だけで登録した本人には、確かめる「現在のパスワード」が無い。
        // **黙って設定させない** —— それは「パスワードを知らない誰かが後から付けられる」経路になる。
        return c.json(errorBody([noPasswordCredentialError]), 409);
      }
      if (!(await verifyPassword(current, credential.passwordHash))) {
        return c.json(errorBody([invalidCredentialsError]), 401);
      }
      store.setPassword(authed.user.id, await hashPassword(next));
      // **それまでのセッションを全部切る** —— 盗まれた session を、変更で確実に無効化できる
      // ようにする(ADR-0014 §3 のセッション固定対策と同じ向き)。**本人には新しい session を
      // 発行し直す**ので、変更した画面からログインし直す必要は無い。
      store.deleteSessionsByUser(authed.user.id);
      const session = issueSession(store, authed.user.id, authConfig.sessionTtlSec);
      setSessionCookie(c, authConfig, appId, session);
      return c.json({ ok: true }, 200);
    } finally {
      store.close();
    }
  });

  app.delete("/api/apps/:app_id/auth/me", (c) => {
    const appId = c.req.param("app_id");
    const opened = openStore(c, appId);
    if (!opened.ok) {
      return opened.response;
    }
    const store = opened.store;
    try {
      const authed = requireUser(c, store);
      if (!authed.ok) {
        return authed.response;
      }
      try {
        store.deleteUser(authed.user.id);
      } catch (error) {
        if (error instanceof LastOwnerError) {
          return c.json(errorBody([lastOwnerWithdrawalError]), 409);
        }
        // **【`V8-M30`。台帳 `T-G29`】2本目の不変条件**(配れる人が0人になる退会)。
        // **1本目と `AND` にしていない** —— **別の `if` であり、文面も別である。**
        if (error instanceof LastGranterError) {
          return c.json(errorBody([lastGranterRejectedError]), 409);
        }
        throw error;
      }
      deleteCookie(c, SESSION_COOKIE, { path: cookiePath(appId) });
      return c.json({ ok: true }, 200);
    } finally {
      store.close();
    }
  });

  // --- ユーザ/ロール管理(owner 限定。V1-M3-T02 / ADR-0015)-----------------------
  //
  // これらは records middleware の対象外パス(/auth/*)なので、ハンドラ内で owner を検査する。
  // 未認証 401 / 非 owner 403 / app 不在 404(openStore が担う)。

  // ユーザ + ロール一覧(**役割を配れる人限定**。`V8-M28` 第2波 / `D-V8-77`)。
  app.get("/api/apps/:app_id/auth/users", (c) => {
    const appId = c.req.param("app_id");
    const opened = openStore(c, appId);
    if (!opened.ok) {
      return opened.response;
    }
    const store = opened.store;
    try {
      // **【`V8-M28` 第2波。台帳 `T-G18` / ユーザ決定 `D-V8-77`。旧の1行を逐語で残す】**
      //
      // **旧**: `const owner = requireOwner(c, store);`
      //
      // **`D-V8-77` の選ばれた見出しは「**見られるようにする**」であり、その説明文の逐語は
      // 「**先行審査は「この口は触らない」と書いていたので、そこを1本広げることになります**」。**
      // **`T-G18` の帰属先の逐語は「残り9箇所の `requireOwner` は1バイトも触らない」だが、
      // 本決定がその9を8へ動かした。**
      //
      // **【帰結を隠さない】** **新2対象の動詞は `write` 1語ちょうどなので、一覧の可否は
      // 「見る」ではなく「**配れるか**」で判定している。** **「一覧は見せるが配らせない」
      // 役割は今日書けない。**
      const owner = requireRoleDistribution(c, store, appId, userListRuleRequiredError);
      if (!owner.ok) {
        return owner.response;
      }
      // **【`V8-M16` / `J-G3`】実効ロール集合を応答に出す。** 付与は1度に読む(N+1 を撃たない)。
      const grants = store.roleGrantsByUser();
      // **【`V8-M2-T04` / 台帳 `I-G13`。`ADR-0336` 限定12】招待を同じ応答に足した。**
      //
      // **一覧のために新しい HTTP の口を足していない** —— **提供先は「発行の応答本文」と
      // 「この既存の口の応答」の2箇所だけである。** **先例は `J-G3`(既存の口の引数を
      // 広げた)と同型で、こちらは**応答**を広げている。**
      //
      // **【2026-09-18 訂正(`V19-M2-T02`。単位 `SV-G7a`。`D-V19-6`)。上の3行を1バイトも
      //   消していない】**
      // **上の3行のうち「提供先は…2箇所だけである」は今日は偽である** ——
      // **コードの提供先は「**発行の応答本文**」の**1箇所ちょうど**になった**
      // (`ADR-0452` 限定⑮)。 **この口の応答には招待は今日どおり全件載るが、
      // **コードは1バイトも載らない**(`invitationView` が載せない)。**
      // **「一覧のために新しい HTTP の口を足していない」の側は今日も真である**(口は53本のまま)。
      //
      // **使用済み・取り消し済み・期限切れの招待も落としていない**(`ADR-0336` 限定16)——
      // **落とすと `I-G12` の「取り消したことを確認できる」が成立しない。**
      // **【正直に書く】この応答は `usedAt` に時刻が入っていることしか示せない** ——
      // **列が7つに閉じているので、「使われた」と「取り消された」を区別できない。**
      //
      // **【2026-09-18 訂正(`V19-M2-T00`。単位 `SV-G5`)。上の2行を1バイトも消していない】**
      // **上の2行は今日は偽である。** **取り消しは同じ列に**素の時刻ではない値**を書くので、
      // この応答でも2つが分かれる** —— **状態は `state` という**別のキー**で載り、
      // `usedAt` は今日どおり ISO8601 のまま返る**(印を応答に1バイトも出さない)。
      // **【正直に書く】この版より前に作られた行は「使用済み」と読む**(復元しない)。
      // **【正直に書く】コードは平文で返る**(`ADR-0336` §3-8)。
      //
      // **【`V8-M2` のメインの裁定 `M2-1`。この口は「役割を配れる人」に開いており
      // `requireOwner` より広い**(`V8-M28` 第2波 / `D-V8-77` がそう決めた)——
      // **したがって招待をそのまま載せると、発行できない人が発行済みのコードを読めた。**
      // **`D-V8-10` で**ユーザが選んだ選択肢の説明文の逐語**は
      // 「**招待リストが他の利用者に見えてしまう事故が構造的に起きない**」であり、
      // **役割を配れる人は運営者とは限らない**(= 他の利用者でありうる)。
      // **そこで招待は `owner` を実効ロール集合に持つ人にだけ載せる。**
      // **`requireOwner` を11箇所目に増やさない** —— **この口の可否そのものは
      // `requireRoleDistribution` のままであり**(`ADR-0323` 限定3 を1バイトも破らない)、
      // **応答に載せるかどうかだけを役割の綴りで分ける。**
      // **【禁止】これを「owner だけが招待を読める仕組みにした」と一般化して書かない** ——
      // **分けているのはこの1つの応答のフィールドだけである。**
      const canReadInvitations = store.effectiveRoles(owner.user.id).includes("owner");
      const users = store.listUsers().map((user) => userAdminView(user, grants.get(user.id) ?? []));
      return c.json(
        canReadInvitations
          ? { users, invitations: store.listInvitations().map(invitationView) }
          : { users },
        200,
      );
    } finally {
      store.close();
    }
  });

  // ロール変更(owner 限定)。最後の owner の降格は 409。不正 role は 400。対象不在は 404。
  //
  // --- **【`V8-M16` / `J-G3`】引数を広げた —— HTTP の口は1本も足していない** ------------
  //
  // **`J-G4`(付け外しに HTTP の口を足す)は門A が却下した**(再審査条件が「付け外しに
  // HTTP の口を足す提案」である)。**したがって新しいルートを1本も登録せず、この既存の
  // `PATCH` の**引数**だけを広げる。** **`HTTP_ENTRY_POINTS` の46本は1本も動いていない**
  // (機械的な確認は `src/server/entry-point-inventory.test.ts`)。
  //
  // **受ける形は2つである**(どちらも今日と同じ1回の `PATCH`):
  //   - `{ "role": "editor" }`   … **着手前と1バイトも変わらない。** 列の値だけを変える。
  //   - `{ "roles": ["viewer","editor"] }` … **実効ロール集合を丸ごと置き換える**
  //     (= 付けるも外すも、これ1本で表せる)。**列は既定の1本目として残る。**
  //   - 両方を書いた場合は、`role` が集合に含まれていることを要求する(列の値を名指しできる)。
  app.patch("/api/apps/:app_id/auth/users/:user_id", async (c) => {
    const appId = c.req.param("app_id");
    const userId = c.req.param("user_id");
    const opened = openStore(c, appId);
    if (!opened.ok) {
      return opened.response;
    }
    const store = opened.store;
    try {
      // **【`V8-M28` 第2波。台帳 `T-G18` / ユーザ決定 `D-V8-41`。旧の1行を逐語で残す】**
      //
      // **旧**: `const owner = requireOwner(c, store);`
      //
      // **`D-V8-41` の説明文の逐語**: 「**「この役割の人は、アプリの設定を変えられる」と
      // 「この役割の人は、他の人に役割を配れる」を、別々に書けます。**」
      // **この口が「配れる」側である**(10箇所の `requireOwner` のうち、配布はこの1本だけ)。
      const owner = requireRoleDistribution(c, store, appId, roleDistributionRuleRequiredError);
      if (!owner.ok) {
        return owner.response;
      }
      const body = await readBody(c);
      if (!body.ok) {
        return body.response;
      }
      // **【`V8-M29` 第1波。旧の1行を逐語で残す】**
      //
      // **旧**: `const kinds = userKindIds(appId);`
      //
      // **値域だけを広げた** —— **この口の**判定**(誰が配れるか。すぐ上の
      // `requireRoleDistribution` = `judgeRoleAccess({target:"role"})`)は1バイトも
      // 触っていない。** **`judgeRoleAssignment`(配布の不変条件2本)も、
      // `countOwners` / `ensureOwnerExists` / `LastOwnerError` も1バイトも触っていない。**
      const values = assignableValues(appId);
      // **【`V8-M16` / `J-G3`】`roles`(複数)を先に読む。** 書かれていなければ今日どおり。
      const requestedRoles = body.value.roles;
      const wantsSet = requestedRoles !== undefined;
      if (wantsSet && !isRoleSet(requestedRoles, values)) {
        return c.json(errorBody([invalidRolesError(values)]), 400);
      }
      const wantsColumn = body.value.role !== undefined;
      if (wantsColumn && !isRole(body.value.role, values)) {
        return c.json(errorBody([invalidRoleError(values)]), 400);
      }
      if (!wantsSet && !wantsColumn) {
        // どちらも書かれていない要求は今日どおり `role` の不正として扱う(形を増やさない)。
        return c.json(errorBody([invalidRoleError(values)]), 400);
      }
      if (
        wantsSet &&
        wantsColumn &&
        !(requestedRoles as Role[]).includes(body.value.role as Role)
      ) {
        return c.json(errorBody([invalidRolesError(values)]), 400);
      }
      if (store.findUserById(userId) === undefined) {
        return c.json(errorBody([unknownUserError(userId)]), 404);
      }
      // =====================================================================================
      // **【`V8-M28` 第2波】配布の不変条件2本**(台帳 `T-G20`。
      // ユーザ決定 `D-V8-75`(`owner` は `owner` を持つ人だけが配れる)/
      // `D-V8-76`(自分自身は変えられない))。
      // =====================================================================================
      //
      // **着手前は、要求者と対象者を突き合わせる行が1行も無かった**
      // (`scratchpad/m28-before.md` §E-3 / §G-4 の実測)——
      // **`owner` は自分にも他人にも `owner` を含む任意の集合を書けた。**
      //
      // **判定は `src/server/owner-scope.ts` の `judgeRoleAssignment` 1本が持つ**
      // (`ADR-0305` 限定3 = **判定の家は1本**)—— **ここに条件式を1つも書いていない。**
      // **`src/auth/store.ts` の `setUserRoles` / `setUserRole` には1行も足していない。**
      //
      // **【`LastOwnerError` の 409 は1バイトも触っていない】** —— **最後の持ち主を
      // 降ろせないことは今日どおり `store` の側が止める**(下の `catch`)。
      const assignedRoles: readonly Role[] = wantsSet
        ? (requestedRoles as Role[])
        : [body.value.role as Role];
      const rejected = judgeRoleAssignment({
        actorId: owner.user.id,
        targetUserId: userId,
        actorRoles: [...owner.roles],
        // **この要求が対象者へ**新しく据える**役割を渡す** —— **`roles` は実効ロール集合の
        // 全置換なのでそのまま、`role` だけの要求は列に据える1値である。**
        // **【正直に書く】`role` だけの要求では、対象者が付与表に既に持っている役割を
        // ここで数えていない。** **数える必要が無い** —— **その要求はそれらを1つも
        // 増やさないからであり、止めたいのは「この要求による `owner` への昇格」だけである。**
        assignedRoles,
      });
      if (rejected !== undefined) {
        return c.json(
          errorBody([
            rejected.kind === "self" ? selfRoleAssignmentError : ownerAssignmentRequiresOwnerError,
          ]),
          403,
        );
      }
      let updated: User;
      try {
        if (wantsSet) {
          // **実効ロール集合を丸ごと置き換える。** `role` も書かれていればそれを列に据える。
          const set = requestedRoles as Role[];
          const ordered = wantsColumn
            ? [body.value.role as Role, ...set.filter((role) => role !== body.value.role)]
            : set;
          updated = store.setUserRoles(userId, ordered);
        } else {
          updated = store.setUserRole(userId, body.value.role as Role);
        }
      } catch (error) {
        if (error instanceof LastOwnerError) {
          return c.json(errorBody([lastOwnerRejectedError]), 409);
        }
        // **【`V8-M30`。台帳 `T-G29`】2本目の不変条件**(配れる人が0人になる役割の変更)。
        // **【正直に書く】この口でこの 409 を出せる要求を、本 MS は1つも作れていない** ——
        // **この口を叩けるのは配れる人だけであり、その人は `D-V8-76` により自分自身を
        // 書き換えられないので、要求が通ったあとも要求者自身が配れる人として残る。**
        // **それでも分岐を置く** —— **`judgeRoleAccess` に条件(`when`)が入れば届きうる。**
        if (error instanceof LastGranterError) {
          return c.json(errorBody([lastGranterRejectedError]), 409);
        }
        throw error;
      }
      // 変更後に owner 不変条件を自己修復(縁の owner=0 を最古昇格で埋める)。
      store.ensureOwnerExists();
      return c.json({ user: userAdminView(updated, store.roleGrants(userId)) }, 200);
    } finally {
      store.close();
    }
  });

  // =====================================================================================
  // --- 招待の発行・取り消し・出し直し(owner 限定。`V8-M2-T04` / 台帳 `I-G9` / `I-G12` /
  //     `I-G13` / `I-G17` / `I-G18`。`ADR-0336`)---------------------------------------
  // =====================================================================================
  //
  // ## **HTTP の口は1本ちょうどである**(`ADR-0336` 限定5)
  //
  // **足したのは `POST /api/apps/:app_id/auth/invitations` の1本だけである。**
  // **`HTTP_ENTRY_POINTS` は 48 → 49 になった**(`src/server/entry-point-inventory.test.ts`。
  // **45 → 46 → 47 → 48 → 49 の4世代目で、旧の期待値は3世代とも逐語で残っている**)。
  // **同じパスに `GET` / `DELETE` / `PATCH` を1本も作っていない** ——
  // **取り消し(`I-G12`)も出し直しも、この1本の**引数**で表す。**
  // **先例は同じファイルの `PATCH .../auth/users/:user_id`(`J-G3`。役割の付け外しを
  // 引数で表した)である。**
  //
  // **【正直に書く】1本の `POST` に「発行」と「取り消し」の2義を持たせている。**
  // **同型の2義化は `schemas/diff.schema.json` が別の場所で名指しで禁じている**
  // (「`roles` キーの意味は1義に閉じる」)。**その禁止は `schemas/` の中のキーについての
  // ものであって HTTP の口には及ばないが、同型の緊張であることは書いておく。**
  //
  // ## **関門は `requireOwner` である**(`ADR-0336` 限定8。**10箇所目**)
  //
  // **`requireRoleDistribution` を3箇所目にしていない** —— **`ADR-0323` 限定3 の機械的検査
  // (呼び出しの行を数えると **2** になること)を1バイトも破らない。**
  // **【この注釈に、数える対象の文字列そのものを書いていない】** —— **書くと、注釈の行が
  // 検査に数えられて 3 になる**(実際に1度そうなった)。**数え方の全文は `ADR-0323` 限定3 と
  // `src/server/invitation-issuance.test.ts` の (e) に在る。**
  //
  // **【隠さない。2点】**
  // 1. **これは軸4(権限の言葉を1つに畳む)の向きに、`ADR-0332`(9箇所目)に続いて2度目に
  //    逆らうことである。** **`ADR-0332` の自認「畳む向きとは逆に1本増やしている」が
  //    そのまま当たる。**
  // 2. **非対称が1つできる。** **役割の規則で「役割を配れる」人(`target: "role"` /
  //    `can: ["write"]`)は、`PATCH .../auth/users/:user_id` から**既存の利用者に同じ役割を
  //    直接付けられる**のに、**その役割の招待を1件も出せない。**
  //    **【禁止】これを「招待のほうが厳しいから安全である」と書かない** —— **同じ結果へ、
  //    より緩い経路が今日も開いている。**
  //
  // ## **レート制限は掛けない**(`ADR-0336` 限定20)
  //
  // **`src/server/app.ts` を1バイトも触っていない**(掛け先は今日も5行ちょうど)。
  // **根拠は同ファイルの明文である** —— 逐語:「対象は register/login だけで、logout / me /
  // **users(管理)** / connections / ai-capabilities には掛けない(**認証済み管理経路は
  // 非対象。条件7**)。」 **発行の口は運営者だけが叩ける認証済み管理経路なので、この条件7に
  // 従う。** **【禁止】これを「総当たりに強い」と読まない** —— **総当たりが問題になるのは
  // 招待を**検証する**口(= `V8-M3` が作る登録経路)であり、そちらは既存5行が覆う。**
  //
  // ## **コードは平文で保管する**(`ADR-0336` §3-8 / 限定11)
  //
  // **ハッシュにしていない。** **見せる先は2箇所だけである** —— **この発行の応答本文と、
  // 既存の `GET /api/apps/:app_id/auth/users` の応答。** **`_auth_activity`(監査記録)には
  // コードを1バイトも書かない**(2つ目の場所を作らない)。
  //
  // **【2026-09-18 訂正(`V19-M2-T02`。単位 `SV-G7a`。`D-V19-6`)。上の3行を1バイトも
  //   消していない】**
  // **「見せる先は2箇所だけ」は今日は偽である** —— **見せる先は**この発行の応答本文だけ**の
  // **1箇所ちょうど**になった**(`ADR-0452` 限定⑮ が `ADR-0336` 限定12 を置き直した)。
  // **「ハッシュにしていない」「監査記録に1バイトも書かない」の2つは今日も真である**
  // (限定11 の**内容欄**は1バイトも破っていない)。
  // **【正直に書く】監査記録に現れないことの検査は、今日この表が空であるために
  // 陽性対照を持てていない**(実測は `invitation-issuance.test.ts` の `(h3)`)。
  // **【禁止】これを「平文でも安全である」と書かない** —— **`app.sqlite` を直接読める人は、
  // そのアプリの未使用の招待コードを全部読める。** **未使用の招待は「まだ登録していない
  // 誰かの、その役割での登録権」そのものである。**
  //
  // ## **`V8-M2` の時点では、この招待を引き換える経路がまだ無い**
  //
  // **`signupAllowed` の `invited` 引数は今日も常に `false` である**(`V8-M3` が埋める)。
  // **すなわち今日在るのは「使えない招待を出せる状態」である。**
  // **【禁止】この中間状態を「一時的だから問題ない」と書かない。**
  //
  // **【2026-08-14 訂正(`V8-M4-T03`。裁定 `M4-3`)。上の3行を1バイトも消していない】**
  // **上の3行は今日は偽である。** **`V8-M3` が引き換えの経路を作り、`invited` 引数に
  // 本物の検証を差し込んだ**(password register / passkey verify の2箇所)。
  // **今日在るのは「使える招待を出せる状態」である** —— **発行した招待で実際に登録でき、
  // 招待に書いた役割が付与される**(実測は `docs/plan/v8/records/v8-m4.md` §5 / §6)。
  // **ただし画面(`web/`)はまだ招待コードの入力欄を持たない**(`V8-M5` の担当)。
  // **【禁止】これを「招待制ができるようになった」と無条件に書かない。**

  // **【2026-09-18 追記(`V19-M2-T00`。単位 `SV-G5`)。下の1行を1バイトも消していない】**
  // **状態は `state` という**別のキー**で載せる**(`ADR-0452` 限定⑮ / `T02-1-4` の 5)。
  // **`usedAt` は今日どおり ISO8601 のまま返す** —— **取り消しの印(素の時刻ではない値)を
  // 応答に1バイトも出さない。** **読む側に値の形を解釈させない**(`S3` の 8 の払い方 (b))。
  // **3値の導出は `src/auth/invitations.ts` の1関数だけが行う**(限定⑨)。
  // **【2026-09-18 訂正(`V19-M2-T02`。単位 `SV-G7a`。`D-V19-6`)。下の1行を1バイトも消して
  //   いない】**
  // **下の1行の「**コードを含む**」は今日は偽である** —— **この関数(`invitationView`)は
  // コードを1バイトも載せない。** **コードの提供先は「**発行の応答本文**」の**1箇所ちょうど**に
  // 狭めた**(`ADR-0452` 限定⑮。`ADR-0336` 限定12 の置き直し)。
  // **載せる側は下の `issuedInvitationView` **1本だけ**である。**
  // **【正直に書く】保管の形は1バイトも変えていない** —— **`app.sqlite` を直接開ける人は、
  // 未使用のコードを今日も全部読める**(`ADR-0452` の「塞がないもの」5)。
  /** 招待の応答表現(**コードを含む**。owner だけが受け取る)。 */
  const invitationView = (invitation: Invitation) => {
    const state = invitationState(invitation);
    const raw = invitation.usedAt;
    const usedAt =
      state === "revoked" && raw !== null ? raw.slice(INVITATION_REVOKED_PREFIX.length) : raw;
    return {
      username: invitation.username,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      issuedBy: invitation.issuedBy,
      issuedAt: invitation.issuedAt,
      usedAt,
      state,
    };
  };

  /**
   * **発行の口の応答表現**(`V19-M2-T02`。**コードを載せる唯一の形**)。
   *
   * **`ADR-0452` 限定⑮ の「提供先は発行の応答本文の1箇所ちょうど」を、コードを足す箇所を
   * この1関数に閉じることで構造的に保つ。** **一覧の応答は上の `invitationView` を使い、
   * コードを1バイトも受け取らない。**
   * **【禁止】これを「コードが守られるようになった」と書かない** —— **狭めたのは**応答**だけで
   * あり、保管の形は1バイトも変えていない。**
   */
  const issuedInvitationView = (invitation: Invitation) => ({
    ...invitationView(invitation),
    code: invitation.code,
  });

  /**
   * **登録リンクを組み立てる**(`ADR-0336` 限定13)。
   *
   * **`ST_AUTH_EXPECTED_ORIGIN` の**先頭**から組む**(カンマ区切りで複数持てる)。
   * **【その値が「正規の公開 URL」である保証は今日は無い】** —— **これは WebAuthn の儀式と
   * CSRF 検査のために許可する origin 群であって、公開 URL の宣言ではない。**
   * **組み立てられないときはリンクを省いてコードだけを返す**(**黙って壊れたリンクを
   * 返さない**。憲法6)。
   */
  const signupUrlFor = (appId: string): string | undefined => {
    const origin = authConfig.expectedOrigins[0];
    return origin === undefined || origin === "" ? undefined : `${origin}/apps/${appId}`;
  };

  /**
   * **発行の口が受け取る引数**(`ADR-0336` 限定14)。
   *
   * **期限を受け取るキーを1つも置いていない。** **未知のキーは 400 で拒否する** ——
   * **`expiresAt` / `ttlSec` のような名前が黙って無視されると、「期限を指定したつもりの
   * 招待」が24時間で切れる。**
   */
  const INVITATION_KEYS = ["username", "role", "revoke"] as const;

  const validateInvitationInput = (
    body: Record<string, unknown>,
    values: readonly Role[],
  ):
    | { ok: true; value: { username: string; role?: Role; revoke: boolean } }
    | { ok: false; errors: ValidationError[] } => {
    const unknown = Object.keys(body).filter(
      (key) => !(INVITATION_KEYS as readonly string[]).includes(key),
    );
    if (unknown.length > 0) {
      return {
        ok: false,
        errors: unknown.map((key) => ({
          path: `/${key}`,
          message: `招待の発行で指定できないキーです: ${key}`,
          hint: `指定できるのは ${INVITATION_KEYS.join(" / ")} だけです。有効期限は24時間で固定で、1件ごとには変えられません。`,
        })),
      };
    }
    const username = body.username;
    if (typeof username !== "string" || username === "") {
      return {
        ok: false,
        errors: [
          {
            path: "/username",
            message: "招く相手のログイン名を指定してください。",
            hint: "その人がこれから登録するときに名乗る名前です(まだ登録していない相手を書きます)。",
          },
        ],
      };
    }
    const revoke = body.revoke === true;
    if (revoke) {
      if (body.role !== undefined) {
        return {
          ok: false,
          errors: [
            {
              path: "/role",
              message: "取り消しのときに役割は指定できません。",
              hint: "取り消すときは username と revoke だけを送ってください。出し直すときは revoke を外して role を指定します。",
            },
          ],
        };
      }
      return { ok: true, value: { username, revoke: true } };
    }
    if (!isRole(body.role, values)) {
      return { ok: false, errors: [invalidRoleError(values)] };
    }
    return { ok: true, value: { username, role: body.role as Role, revoke: false } };
  };

  app.post("/api/apps/:app_id/auth/invitations", async (c) => {
    const appId = c.req.param("app_id");
    const opened = openStore(c, appId);
    if (!opened.ok) {
      return opened.response;
    }
    const store = opened.store;
    try {
      const owner = requireOwner(c, store);
      if (!owner.ok) {
        return owner.response;
      }
      // **【`I-G17`。掃除の呼び出し点はここである】**(`ADR-0336` 限定19)
      //
      // **5本目のスケジューラを足していない**(`src/server/index.ts` は0バイト)。
      // **同じ点で既存の `purgeExpired()` も呼ぶ** —— **招待だけを掃除して、期限切れの
      // セッションと pending challenge を今日どおり溜め続ける形にしない。**
      // **`purgeExpired()` は着手前まで本番からの呼び出しが0件だった**(実測の全出力は
      // `src/auth/invitations.test.ts` の冒頭に逐語で貼ってある)。
      //
      // **【禁止の履行】これを「v8 が既存の穴を塞いだ」と単独で書かない** —— **掃除が
      // 走るのは「招待を発行したとき」だけであり、招待を1度も使わないアプリでは
      // `purgeExpired()` は今日どおり0回である。** **もう1つの呼び出し点(招待を検証する
      // 登録経路)は `V8-M3` が作る。**
      //
      // **どちらも「そのアプリの `app.sqlite` を既に開いている」経路なので、掃除のために
      // 新しく接続を開かない。** **全アプリを走査しない。**
      store.purgeExpiredInvitations();
      store.purgeExpired();

      const body = await readBody(c);
      if (!body.ok) {
        return body.response;
      }
      const validated = validateInvitationInput(body.value, assignableValues(appId));
      if (!validated.ok) {
        return c.json(errorBody(validated.errors), 400);
      }
      if (validated.value.revoke) {
        const revoked = store.revokeInvitation(validated.value.username);
        if (revoked === undefined) {
          return c.json(
            errorBody([
              {
                path: "/username",
                message: `その相手の招待は在りません: ${validated.value.username}`,
                // **【2026-09-18 打ち直し(`V19-M2-T02`。`unfixed-holes.md` `§5` の申し送り5)】**
                // **旧の文面(逐語)**: 「期限が切れた招待は掃除で消えます。取り消したい招待が
                // 見当たらないときは、既に切れているか、使われた後に掃除されたと考えられます。」
                // **偽だったのは「使われた後に掃除された」である** —— **掃除が消すのは
                // **期限を過ぎた**行だけであり、使われただけの行も、取り消した行も、期限が
                // 来るまでは消えない**(`purgeExpiredInvitations`)。 **取り消しも使用と同じ列に
                // 入るので、「見当たらない = 使われた」とは限らない。**
                hint: "取り消せるのは、期限内で行が残っている招待だけです。見当たらないときは、その相手にまだ発行していないか、期限(発行から24時間)を過ぎて掃除で消えたと考えられます。使われた招待も取り消した招待も、期限が来るまでは行が残り、利用者の一覧に出ます。",
              },
            ]),
            404,
          );
        }
        return c.json({ invitation: issuedInvitationView(revoked) }, 200);
      }
      // **出し直しは行を差し替える**(行を増やさない。`ADR-0336` 限定18)——
      // **同じ相手に有効な招待が2件同時に存在しないことを、主キーで構造的に保証している。**
      const invitation = store.issueInvitation({
        username: validated.value.username,
        role: validated.value.role as Role,
        issuedBy: owner.user.id,
      });
      const signupUrl = signupUrlFor(appId);
      return c.json(
        {
          invitation: issuedInvitationView(invitation),
          ...(signupUrl === undefined ? {} : { signupUrl }),
        },
        200,
      );
    } finally {
      store.close();
    }
  });

  // --- 監査記録の読取(owner 限定。E-G59 / V4-M6)-----------------------------------
  //
  // **既に取れている監査記録(`_auth_activity`)を、運営が読める経路が1本も無かった。**
  // 記録そのものは `ADR-0015` §3 の実装(`writeWithAudit` → `recordActivity`)が v1 から
  // 残しているが、**読む口はどこにも無く**、records API からは「このアプリに存在しません」
  // (404)になる —— **app.sqlite を直接開ける人だけが真相を知れる**状態だった
  // (02 §5-9 `E-G59`。実地で `admin-order-action-list` に操作者の列が1つも無いことを実測)。
  //
  // **`B-G6`(V4-M1)と向きが逆であることを明記する。** `B-G6` はシステムテーブル
  // (`_apps` / `_changelog` / `_ai_usage`)の**未認証**読取を塞いだ。**本経路は owner にだけ
  // 開ける**(未認証 401 / 非 owner 403 / app 不在 404 = ユーザ管理と同じ関門)。
  // **`B-G6` が塞いだものを1バイトも開け直していない**:
  //   - **`_auth_activity` を `SYSTEM_TABLE_IDS` に足していない**(`src/shared/system-tables.ts`
  //     は1バイトも触っていない = Δ2 非発火)。records 経路にこのテーブルは今日も現れない。
  //   - 経路は `/auth/*` の下にあり、**`B-G6` が直した `records` ルートを1バイトも通らない。**
  //
  // **これは「運営が画面で読める」ことではない。** 出したのは API だけで、**この記録を見せる
  // 画面は今日も無い**(プラットフォームの外枠に触れない = `D-V4-24`)。**「誰がやったかが
  // 運営に見えるようになった」とは書けない。**

  /** 監査ページングの上限(1ページで返す最大件数)。 */
  const ACTIVITY_MAX_LIMIT = 1000;
  /** 監査ページングの既定件数(指定が無いとき)。 */
  const ACTIVITY_DEFAULT_LIMIT = 200;

  /** `limit` / `offset` を読む。範囲外・数値でないものは 400(黙って既定に倒さない)。 */
  const parseActivityPaging = (
    url: URL,
  ): { ok: true; limit: number; offset: number } | { ok: false; error: ValidationError } => {
    const read = (
      name: string,
      fallback: number,
      min: number,
      max: number,
    ): { ok: true; value: number } | { ok: false; error: ValidationError } => {
      const raw = url.searchParams.get(name);
      if (raw === null || raw === "") {
        return { ok: true, value: fallback };
      }
      const value = Number(raw);
      if (!Number.isInteger(value) || value < min || value > max) {
        return {
          ok: false,
          error: {
            path: `/${name}`,
            message: `${name} は ${min} 以上 ${max} 以下の整数で指定してください(指定値: ${raw})。`,
            hint: `${name} を省略すると ${fallback} になります。`,
          },
        };
      }
      return { ok: true, value };
    };
    const limit = read("limit", ACTIVITY_DEFAULT_LIMIT, 1, ACTIVITY_MAX_LIMIT);
    if (!limit.ok) {
      return limit;
    }
    const offset = read("offset", 0, 0, Number.MAX_SAFE_INTEGER);
    if (!offset.ok) {
      return offset;
    }
    return { ok: true, limit: limit.value, offset: offset.value };
  };

  app.get("/api/apps/:app_id/auth/activity", (c) => {
    const appId = c.req.param("app_id");
    const opened = openStore(c, appId);
    if (!opened.ok) {
      return opened.response;
    }
    const store = opened.store;
    try {
      const owner = requireOwner(c, store);
      if (!owner.ok) {
        return owner.response;
      }
      const paging = parseActivityPaging(new URL(c.req.url));
      if (!paging.ok) {
        return c.json(errorBody([paging.error]), 400);
      }
      const page = store.listActivityPage({ limit: paging.limit, offset: paging.offset });
      return c.json({ activity: page.rows, total: page.total }, 200);
    } finally {
      store.close();
    }
  });

  // --- capability(connection)の発行・管理(owner 限定。V1-M4-T04 / ADR-0020 §2b・§5)---
  //
  // **ここが発行の seam である。**connection を作れる経路は**この POST /connections だけ**で、
  // MCP ツール / apply_diff からは到達しない(§8c-3。AI は request_connection で「申請」まで)。
  // すべて owner のみ(未認証 401 / 非 owner 403 / app 不在 404)。Origin 検査(CSRF)は
  // app.ts の `/api/apps/:app_id/connections/*` middleware が先に張る(auth/* と同型)。
  //
  // **secretSource は「取得元の参照」(env 名 / コマンド)であって secret 値ではない**ので
  // owner に見せてよい(§2d)。secret の解決値は保管も返却もしない(そもそも保管が無い)。

  /** owner 検査を通してから CapabilityStore を開いて処理する共通形。 */
  const withCapabilityStore = (
    c: Context<AuthEnv>,
    appId: string,
    run: (cap: CapabilityStore) => Response,
  ): Response => {
    const opened = openStore(c, appId);
    if (!opened.ok) {
      return opened.response;
    }
    const store = opened.store;
    try {
      const owner = requireOwner(c, store);
      if (!owner.ok) {
        return owner.response;
      }
      const cap = CapabilityStore.openForKernel(dataRoot);
      try {
        return run(cap);
      } finally {
        cap.close();
      }
    } finally {
      store.close();
    }
  };

  // 未承認の申請一覧(owner が承認画面で見る)。
  app.get("/api/apps/:app_id/connections/requests", (c) => {
    const appId = c.req.param("app_id");
    return withCapabilityStore(c, appId, (cap) =>
      c.json({ requests: cap.listPendingRequests(appId) }, 200),
    );
  });

  // 発行済み connection の一覧(secretSource は取得元の参照。secret 値ではない)。
  app.get("/api/apps/:app_id/connections", (c) => {
    const appId = c.req.param("app_id");
    return withCapabilityStore(c, appId, (cap) =>
      c.json({ connections: cap.listConnections(appId).map(connectionView) }, 200),
    );
  });

  // **発行(owner のみ)。**body の name/allowedHosts/secretSource を検証して connection を作る。
  // requestId があれば、その申請を approved にする(申請 → 承認 → 発行の締め)。
  app.post("/api/apps/:app_id/connections", async (c) => {
    const appId = c.req.param("app_id");
    const opened = openStore(c, appId);
    if (!opened.ok) {
      return opened.response;
    }
    const store = opened.store;
    try {
      const owner = requireOwner(c, store);
      if (!owner.ok) {
        return owner.response;
      }
      const body = await readBody(c);
      if (!body.ok) {
        return body.response;
      }
      const validated = validateConnectionInput(body.value);
      if (!validated.ok) {
        return c.json(errorBody(validated.errors), 400);
      }
      const cap = CapabilityStore.openForKernel(dataRoot);
      try {
        let connection: Connection;
        try {
          connection = cap.createConnection({
            appId,
            name: validated.value.name,
            allowedHosts: validated.value.allowedHosts,
            secretSource: validated.value.secretSource,
          });
        } catch (error) {
          // UNIQUE(app_id, name) 違反 = 同名の接続が既にある。409 で返す。
          return c.json(
            errorBody([
              {
                path: "/name",
                message: error instanceof Error ? error.message : String(error),
                hint: "別の接続名を指定するか、既存の接続を削除してから発行してください。",
              },
            ]),
            409,
          );
        }
        // 申請の締め(あれば)。存在しない requestId でも markRequest は冪等なので害はない。
        if (validated.value.requestId !== undefined) {
          cap.markRequest(validated.value.requestId, "approved");
        }
        return c.json({ connection: connectionView(connection) }, 200);
      } finally {
        cap.close();
      }
    } finally {
      store.close();
    }
  });

  // 失効(owner のみ)。deleteConnection は冪等。
  app.delete("/api/apps/:app_id/connections/:connection_id", (c) => {
    const appId = c.req.param("app_id");
    const connectionId = c.req.param("connection_id");
    return withCapabilityStore(c, appId, (cap) => {
      cap.deleteConnection(connectionId);
      return c.json({ ok: true }, 200);
    });
  });

  // --- AI capability の発行・管理(owner 限定。V1-M5-T04 / ADR-0021 §2b・§5)---
  //
  // **ここが AI 呼び出し capability の発行 seam である。**capability を作れる経路は
  // **この POST /ai-capabilities だけ**で、上限を変えられるのは **PATCH .../limit だけ**である
  // (どちらも owner のみ)。MCP ツール / apply_diff からは到達しない(§8c-3。AI は
  // request_ai_capability で「申請」まで)。**上限は人間のみ変更可能**(§5)。
  // `connections` の owner 検査・Origin 検査(app.ts のミドルウェア)と同型。

  const withAiStore = (
    c: Context<AuthEnv>,
    appId: string,
    run: (ai: AiCapabilityStore) => Response,
  ): Response => {
    const opened = openStore(c, appId);
    if (!opened.ok) {
      return opened.response;
    }
    const store = opened.store;
    try {
      const owner = requireOwner(c, store);
      if (!owner.ok) {
        return owner.response;
      }
      const ai = AiCapabilityStore.openForKernel(dataRoot);
      try {
        return run(ai);
      } finally {
        ai.close();
      }
    } finally {
      store.close();
    }
  };

  // 未承認の申請一覧(owner が承認画面で見る)。
  app.get("/api/apps/:app_id/ai-capabilities/requests", (c) => {
    const appId = c.req.param("app_id");
    return withAiStore(c, appId, (ai) => c.json({ requests: ai.listPendingRequests(appId) }, 200));
  });

  // 発行済み capability の一覧(secretSource は取得元の参照。secret 値ではない)。
  app.get("/api/apps/:app_id/ai-capabilities", (c) => {
    const appId = c.req.param("app_id");
    return withAiStore(c, appId, (ai) =>
      c.json({ capabilities: ai.listCapabilities(appId).map(aiCapabilityView) }, 200),
    );
  });

  // **発行(owner のみ)。**provider / model / 上限(必須)/(openai_compatible なら
  // base_url + secretSource)を検証して capability を作る。requestId があればその申請を承認済みに。
  app.post("/api/apps/:app_id/ai-capabilities", async (c) => {
    const appId = c.req.param("app_id");
    const opened = openStore(c, appId);
    if (!opened.ok) {
      return opened.response;
    }
    const store = opened.store;
    try {
      const owner = requireOwner(c, store);
      if (!owner.ok) {
        return owner.response;
      }
      const body = await readBody(c);
      if (!body.ok) {
        return body.response;
      }
      const validated = validateAiCapabilityInput(body.value);
      if (!validated.ok) {
        return c.json(errorBody(validated.errors), 400);
      }
      const ai = AiCapabilityStore.openForKernel(dataRoot);
      try {
        let capability: AiCapability;
        try {
          capability = ai.createCapability({ appId, ...validated.value.capability });
        } catch (error) {
          return c.json(
            errorBody([
              {
                path: "/name",
                message: error instanceof Error ? error.message : String(error),
                hint: "別の capability 名を指定するか、既存の capability を削除してから発行してください。",
              },
            ]),
            409,
          );
        }
        if (validated.value.requestId !== undefined) {
          ai.markRequest(validated.value.requestId, "approved");
        }
        return c.json({ capability: aiCapabilityView(capability) }, 200);
      } finally {
        ai.close();
      }
    } finally {
      store.close();
    }
  });

  // **上限の変更(owner のみ。ADR-0021 §5「上限は人間のみ変更可能」)。**
  app.patch("/api/apps/:app_id/ai-capabilities/:capability_id/limit", async (c) => {
    const appId = c.req.param("app_id");
    const capabilityId = c.req.param("capability_id");
    const opened = openStore(c, appId);
    if (!opened.ok) {
      return opened.response;
    }
    const store = opened.store;
    try {
      const owner = requireOwner(c, store);
      if (!owner.ok) {
        return owner.response;
      }
      const body = await readBody(c);
      if (!body.ok) {
        return body.response;
      }
      const limit = validateAiLimit(body.value);
      if (!limit.ok) {
        return c.json(errorBody(limit.errors), 400);
      }
      const ai = AiCapabilityStore.openForKernel(dataRoot);
      try {
        const existing = ai.getCapability(capabilityId);
        if (existing === undefined || existing.appId !== appId) {
          return c.json(
            errorBody([{ path: "", message: `capability が見つかりません。`, hint: "" }]),
            404,
          );
        }
        ai.updateCapabilityLimit(capabilityId, limit.value);
        const updated = ai.getCapability(capabilityId);
        return c.json(
          { capability: updated === undefined ? null : aiCapabilityView(updated) },
          200,
        );
      } finally {
        ai.close();
      }
    } finally {
      store.close();
    }
  });

  // 失効(owner のみ)。deleteCapability は冪等。
  app.delete("/api/apps/:app_id/ai-capabilities/:capability_id", (c) => {
    const appId = c.req.param("app_id");
    const capabilityId = c.req.param("capability_id");
    return withAiStore(c, appId, (ai) => {
      ai.deleteCapability(capabilityId);
      return c.json({ ok: true }, 200);
    });
  });

  // --- 受信口(inbound endpoint)の**発行**(owner 限定。`V8-M41` / 台帳 `F-G14` /
  //     `ADR-0332` / `ADR-0041` §1・§3)---------------------------------------------------
  //
  // ## **着手前まで、この口は1本も存在しなかった**
  //
  // **`src/kernel/inbound-store.ts:359`-`:362` のコメントの逐語**: 「**AI 経路
  // (`requestInboundEndpoint`)からはここに到達しない。**発行は owner の HTTP 操作だけが
  // 呼ぶ(本 T01 ではどのルートにも結線しない = テストからのみ呼ぶ)。」
  // **`src/mcp/vocabulary.ts:1270` の逐語**: 「**発行は owner の UI 操作だけが行い、その経路は
  // MCP / apply_diff に1本も結線されていません**」。
  // **`v8-m33.md` §1-A の `A-8` が実測した**: 「**HTTP にも MCP にも発行の口が1本も無い。
  // `request_inbound_endpoint` は申請まで**」。 **その「owner の UI 操作」が叩く口が、
  // 今日この1本で初めて立った** —— **`src/mcp/` は1バイトも触っていない**
  // (**空約束だった文が真になるだけであり、嘘にならない**。`v8-m35.md` §4-4 の 3)。
  //
  // ## **口は1本ちょうどである**(`ADR-0332` 限定3)
  //
  // **再発行・失効・一覧・申請一覧の口を1本も作っていない。** **`InboundStore` には
  // `deleteInboundEndpoint` / `listInboundEndpoints` / `updateInboundEndpointSignature` /
  // `listPendingInboundEndpointRequests` が実在するが、HTTP からはどれにも到達しない。**
  // **`HTTP_ENTRY_POINTS` は 47 → 48 である**(`src/server/entry-point-inventory.test.ts`)。
  // **【正直に書く】これは「発行はできるが止められない」状態を作る**(`ADR-0332` の
  // `S3` の2点目が自認している)。**止める手段は今日 `kernel.sqlite` を直に触ることだけである。**
  //
  // ## **関門は `requireOwner` である**(`ADR-0332` 限定2)
  //
  // **`ADR-0041` 限定1 の逐語「inbound endpoint は人間(owner)専用・AI 不可視である」に
  // 素直な形を採った。** **`app` × `write` の役割の規則(`ADR-0323` が2箇所で採った形)は
  // 採らなかった** —— **理由と、採らなかった側の読みは `ADR-0332` §4 に書いてある。**
  // **`requireOwner` の呼び出しはこれで8箇所から9箇所になる。**
  //
  // ## **返すもの・返さないもの**
  //
  // **`secretSource` は取得元の**参照**(env 名 / コマンド行)であって鍵の値ではない**ので
  // owner に返してよい(`ADR-0041` 限定4 = `ADR-0020` §2d の対称)。**署名検証鍵の本体は
  // そもそも保管していないので、返しようがない** —— **`issueInboundEndpoint` の戻り値
  // (`InboundEndpoint`)に鍵の本体を持つフィールドは1つも無い。**
  // **Origin 検査(CSRF)は app.ts の `/api/apps/:app_id/inbound-endpoints` middleware が
  // 先に張る**(connections と同型)。

  app.post("/api/apps/:app_id/inbound-endpoints", async (c) => {
    const appId = c.req.param("app_id");
    const opened = openStore(c, appId);
    if (!opened.ok) {
      return opened.response;
    }
    const store = opened.store;
    try {
      const owner = requireOwner(c, store);
      if (!owner.ok) {
        return owner.response;
      }
      const body = await readBody(c);
      if (!body.ok) {
        return body.response;
      }
      const validated = validateInboundEndpointInput(body.value);
      if (!validated.ok) {
        return c.json(errorBody(validated.errors), 400);
      }
      const inbound = InboundStore.openForKernel(dataRoot);
      try {
        let endpoint: InboundEndpoint;
        try {
          endpoint = inbound.issueInboundEndpoint({
            appId,
            name: validated.value.name,
            secretSource: validated.value.secretSource,
            targetTable: validated.value.targetTable,
            ...(validated.value.signatureHeader === undefined
              ? {}
              : { signatureHeader: validated.value.signatureHeader }),
            ...(validated.value.signatureFormat === undefined
              ? {}
              : { signatureFormat: validated.value.signatureFormat }),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // UNIQUE(app_id, name) 違反 = 同名の受信口が既にある。409 で返す(connections と同型)。
          if (message.includes("既に存在します")) {
            return c.json(
              errorBody([
                {
                  path: "/name",
                  message,
                  hint: "別の受信口の名前を指定してください(既存の受信口を消す口は在りません)。",
                },
              ]),
              409,
            );
          }
          // **署名の形の値域違反**(`checkSignatureShape` が投げる。`ADR-0160` 限定2 / 限定4)。
          // **1行も書く前に投げているので 400 で返す**(500 にしない)。
          return c.json(
            errorBody([
              {
                path: "/signatureHeader",
                message,
                hint: "signatureHeader / signatureFormat は有限の値域です。省略すると既定の形になります。",
              },
            ]),
            400,
          );
        }
        // 申請の締め(あれば)。存在しない requestId でも mark は冪等なので害はない
        // (connections の作法をそのまま採った)。
        if (validated.value.requestId !== undefined) {
          inbound.markInboundEndpointRequest(validated.value.requestId, "approved");
        }
        return c.json({ endpoint: inboundEndpointView(endpoint) }, 200);
      } finally {
        inbound.close();
      }
    } finally {
      store.close();
    }
  });

  // --- 逃げ道(任意 CSS)の資産の発行・失効(owner 限定。V3-M5-T01 / ADR-0055 限定5・7・9)---
  //
  // **ここが逃げ道の唯一の発行 seam である。**CSS のバイト列を置ける経路は
  // **この POST /escape-hatch-assets だけ**で、MCP ツール / apply_diff / HTTP のデータ経路
  // からは1本も到達しない(限定5。AI は request_custom_css で「申請」まで)。
  // すべて owner のみ(未認証 401 / 非 owner 403 / app 不在 404)。Origin 検査(CSRF)は
  // app.ts の `/api/apps/:app_id/escape-hatch-assets*` middleware が先に張る(connections と同型)。
  //
  // **「説明文にそう書いた」は担保ではない**(`src/mcp/tools/write.ts:1026`〜`:1029`)。
  // 担保は経路の不在であり、`src/server/escape-hatch-issuance.test.ts` がソースの上で固定する。
  //
  // **カーネルもサーバ層も CSS を1バイトも解釈しない**(限定8 / 憲法1)——
  // 許可リストも拒否リストも作らない。ここが検査するのは name / css の有無と
  // **作用域の宣言**(限定7)だけである。

  /** owner 検査を通してから EscapeHatchStore を開いて処理する共通形(withCapabilityStore と同型)。 */
  // **【`V5-M3b` / `D-V5-96`(2026-08-06)】この4本は実行専用の起動プロファイルでは登録しない。**
  // **落とすのは発行・失効・一覧・申請一覧の4本だけであり、既に発行済みの CSS を配る口**
  // **(`GET /api/apps/:app_id/views/:view_id/custom.css`。`app.ts` 側)は1本も落としていない。**
  // **【禁止】「編集の口を全部外した」と読まないこと** —— **運営者の口は12本残る。**
  if (escapeHatchAssetRoutes) {
    const withEscapeHatchStore = (
      c: Context<AuthEnv>,
      appId: string,
      run: (hatch: EscapeHatchStore) => Response,
    ): Response => {
      const opened = openStore(c, appId);
      if (!opened.ok) {
        return opened.response;
      }
      const store = opened.store;
      try {
        const owner = requireOwner(c, store);
        if (!owner.ok) {
          return owner.response;
        }
        const hatch = EscapeHatchStore.openForKernel(dataRoot);
        try {
          return run(hatch);
        } finally {
          hatch.close();
        }
      } finally {
        store.close();
      }
    };

    // 未承認の申請一覧(owner が承認画面で見る)。
    app.get("/api/apps/:app_id/escape-hatch-assets/requests", (c) => {
      const appId = c.req.param("app_id");
      return withEscapeHatchStore(c, appId, (hatch) =>
        c.json({ requests: hatch.listPendingEscapeHatchAssetRequests(appId) }, 200),
      );
    });

    // 発行済み資産の一覧。**CSS のバイト列は返さない** —— 返すのは参照(名前 + ダイジェスト)と
    // 作用域だけである(マニフェストに載るのと同じ2要素 + owner が宣言した作用域)。
    app.get("/api/apps/:app_id/escape-hatch-assets", (c) => {
      const appId = c.req.param("app_id");
      return withEscapeHatchStore(c, appId, (hatch) =>
        c.json({ assets: hatch.listEscapeHatchAssets(appId).map(escapeHatchAssetView) }, 200),
      );
    });

    // **発行(owner のみ)。**body の name / css / scopeViews を検証し、本体を content-addressed に
    // 置いてから資産を登録する。requestId があれば、その申請を approved にする
    // (申請 → 承認 → 発行の締め。connections の `:979`〜`:982` と同じ作法)。
    app.post("/api/apps/:app_id/escape-hatch-assets", async (c) => {
      const appId = c.req.param("app_id");
      const opened = openStore(c, appId);
      if (!opened.ok) {
        return opened.response;
      }
      const store = opened.store;
      try {
        const owner = requireOwner(c, store);
        if (!owner.ok) {
          return owner.response;
        }
        const body = await readBody(c);
        if (!body.ok) {
          return body.response;
        }
        const validated = validateEscapeHatchAssetInput(body.value);
        if (!validated.ok) {
          return c.json(errorBody(validated.errors), 400);
        }
        // **本体を先に置く。**content-addressed なので、同一内容なら既存実体を上書きせず
        // 再利用する(de-dup。限定9)。登録が UNIQUE で弾かれても実体は不変のまま残るだけで、
        // 過去の版を1バイトも壊さない。
        const digest = putEscapeHatchBody(
          dataRoot,
          appId,
          new TextEncoder().encode(validated.value.css),
        );
        const hatch = EscapeHatchStore.openForKernel(dataRoot);
        try {
          let asset: EscapeHatchAsset;
          try {
            asset = hatch.issueEscapeHatchAsset({
              appId,
              name: validated.value.name,
              digest,
              scopeViews: validated.value.scopeViews,
            });
          } catch (error) {
            // UNIQUE(app_id, name, digest) 違反 = 同名・同内容の資産が既にある。409 で返す。
            return c.json(
              errorBody([
                {
                  path: "/name",
                  message: error instanceof Error ? error.message : String(error),
                  hint: "同じ名前で内容を変えるなら CSS を編集してから発行してください(別の版として並びます)。同じものを2つ持つ必要はありません。",
                },
              ]),
              409,
            );
          }
          // 申請の締め(あれば)。存在しない requestId でも mark は冪等なので害はない。
          if (validated.value.requestId !== undefined) {
            hatch.markEscapeHatchAssetRequest(validated.value.requestId, "approved");
          }
          return c.json({ asset: escapeHatchAssetView(asset) }, 200);
        } finally {
          hatch.close();
        }
      } finally {
        store.close();
      }
    });

    // 失効(owner のみ)。deleteEscapeHatchAsset は冪等。
    // **本体(CSS のバイト列)は消さない** —— 消すと過去のスナップショットが参照する版を
    // 復元できなくなる(ADR-0055 限定10 は孤児の自動刈り取りを禁じ、検出のみとした)。
    app.delete("/api/apps/:app_id/escape-hatch-assets/:asset_id", (c) => {
      const appId = c.req.param("app_id");
      const assetId = c.req.param("asset_id");
      return withEscapeHatchStore(c, appId, (hatch) => {
        hatch.deleteEscapeHatchAsset(assetId);
        return c.json({ ok: true }, 200);
      });
    });
  }

  // --- コメント(アプリを使う人が画面へ書く)。V10-M11-T01 / 台帳 `CM-G4` -----------------
  //
  // **門 = 門外(`Δ7`)/ 判定値 = 限定採用。** **カーネル語彙を1語も増やさず、
  // `schemas/` と `src/kernel/` を1バイトも触らずに、サーバ層へ口を1本足したものである。**
  //
  // **【`if (escapeHatchAssetRoutes)` の外に置いている。意図的である】**
  // **`CM-G4` 限定3 は「`full` と `runner` の両方に登録する。片方だけに登録しない」であり、
  // `registerAuthRoutes` はプロファイルで分岐せずに呼ばれる**(`app.ts` の `registerAuthRoutes(app, {`)。
  // **`src/server/change-routes.ts` に置くとこれが破れる** —— **`registerChangeRoutes` は
  // `profile === "full"` のときだけ呼ばれるので、`runner-profile.test.ts` の `dropped` が
  // 12 → 13 になって赤くなる**(`V10-M11-T01` が実物で1度赤くして確かめた)。
  //
  // **【この口は今日ログイン必須である。未ログインは 401】**
  // **開けるのは `V10-M11-T03`(`CM-G6`)である** —— **`/api/*` にグローバルな認証は1本も
  // 無いので、何も掛けずに作るとこの口は最初から未ログインで通り、`V10-M11-T03` の実装が
  // 0バイトになる。** **`CM-G4` の審査(`S3` の 4)も「本単位が『ログイン済みだけ』で止めても、
  // その次の単位が同じ口を開ける」と自分で書いている。**
  //
  // **【状態と理由の更新の枝は1行も無い】**
  // **今日、器に状態の列も理由の列も無く**(`gp_comments` は7列)、**`CM-G4` 限定4 が
  // `src/kernel/` 0バイトを課している。** **`M9-T11-DECISIONS.md` 決定2(「新規と更新の両方を
  // この1本の口が受ける」)は、**2本目の口を作らない**ことで履行する** ——
  // **状態・理由の枝を**この同じ口**に足すのは `V10-M13-T02` / `V10-M13-T03` である。**
  // **【禁止】これを「両方を受ける口を作った」と書かない。**
  //
  // **【`CM-G4` 限定5】口は器の書込関数を1本呼ぶだけである。**
  // **`readCurrentManifest` を1度も呼ばず(マニフェストを1バイトも解釈しない)、
  // `judgeRoleAccess` も1度も呼ばない** —— **「誰に見えるか」の合成は `CM-G5`
  // (`V10-M11-T02`)の持ち物であり、そちらは**読出**に効く。**
  // **【正直に書く】限定5 の条文は「ハンドラの中に `judgeRoleAccess` の直接呼び出しが
  // 1件ちょうど」である。****本工程は 0件である** —— **`D-V10-5`(使う人も含めて誰でも
  // 書ける)により、書込の口で役割の規則を見ないからである。** **食い違いは記録に立てた。**
  //
  // **【V10-M11-T01 ハンドラ ここから】**(限定5 の式は、この範囲だけを切り出して数える)
  app.post("/api/apps/:app_id/comments", async (c) => {
    const appId = c.req.param("app_id");
    const opened = openStore(c, appId);
    if (!opened.ok) {
      return opened.response;
    }
    const store = opened.store;
    try {
      // **役割を1つも見ない**(`requireOwner` ではない)。**見るのは「ログインしているか」だけ。**
      // **`V10-M11-T03` が外すのはこの3行である。**
      //
      // **【`V10-M11-T03`(2026-08-24。台帳 `CM-G6` / `ADR-0367`。**門A** / 限定採用)。
      // 上の2行の注は制定時の記述であり、1バイトも書き換えていない】**
      // **外した。** **旧の3行(逐語)**:
      //   `const authed = requireUser(c, store);`
      //   `if (!authed.ok) {`
      //   `  return authed.response;`
      //   `}`
      // **【この注の逐語が grep を騙すことを、先に書いておく】**
      // **上の4行は旧の実装の逐語であり(作法どおり1バイトも消していない)、
      // そのせいで、旧の呼び出しの関数名を `LC_ALL=C /usr/bin/grep -c` で数えると、この範囲で
      // **0ではなく1**になる。** **呼び出しは1件も無い**(数えているのは注である)。
      // **同ファイルの他の2箇所(`:2256` / `:2299`)は今日も本物の呼び出しである。**
      //
      // **この口は今日、ログインしていなくても通る** —— **`ADR-0367` §Decision 1
      // 「匿名に開けるのは、新設の書込の口1本ちょうどである」の1本がこれである。**
      // **出所 = ユーザ決定 `D-V10-27`(ログインしていなくても書けるようにする)。**
      //
      // **【レート制限を1つも掛けていない】**(`ADR-0367` 限定4 / ユーザ決定 `D-V10-31`)。
      // **この口はどのリミッタにも入らない** —— **`authLimiter` / `publicGetLimiter` /
      // `inboundLimiter` の結線を1バイトも動かしていない。**
      // **【禁止】これを「荒らし対策を入れた」と読まない** —— **入れていない。**
      // **止められないことは `CANNOT_DO` に書き、`comment-api.test.ts` の検査4 が
      // 「遮断されないこと」を常設で測る。**
      //
      // **【読取は1ミリも開けていない】**(限定2)。 **HTTP に読出の口は今日1本も無く、
      // 可視性の合成(`comment-visibility.ts`)は名乗りの無い相手に1件も返さない。**
      // **未ログインで書いた本人も、自分のコメントを1件も読み返せない**(`ADR-0367` 限界5)。
      //
      // **【`V10-M27-T02`(2026-08-25。`ADR-0375`)。すぐ上の3行を訂正する。
      // 上の3行は制定時の記述であり、1バイトも書き換えていない】**
      // **今日の正**: **HTTP の読出の口は `V10-M15-T05` が1本足しており、
      // その口は「役割の規則を1本も書いていないアプリ」に限って未ログインにも開く。**
      // **そのアプリでは、未ログインで書いた本人も自分のコメントを読み返せる。**
      // **規則を1本でも書いているアプリでは、上の3行は今日も真である。**
      // **【禁止】これを「未ログインに読取を全部開けた」と読まない。**
      //
      // **【公開の予約規約フィールドを1バイトも触っていない】**(限定3)。
      // **その綴りをこの注に書かない** —— **履行を測る式(`LC_ALL=C /usr/bin/grep -c`)は
      // このファイルを走査するので、逐語を注に残すと、1バイトも触っていないのに
      // 0件にならない**(`comment-store.ts` / `comment-visibility.ts` が同じ作法を採っている)。
      //
      // **【残っているもの】** **`openStore` は外していない** ——
      // **実在しないアプリが 404 になる枝は今日どおりである**(`ensureApp`)。
      const parsed = await readBody(c);
      if (!parsed.ok) {
        return parsed.response;
      }
      // **【`V10-M13-T02`(2026-08-24。台帳 `CM-G19` / `ADR-0369`。**門A** / 限定採用)。
      // ここから状態を書き換える枝を足した】**
      // **同じ口の同じ本文の**形**で分岐する** —— **`comment_id` が本文に在れば update、
      // 無ければ create(今日どおり)。** **`PATCH` を足していない**(裁定E。口の本数を
      // 1本ちょうどのまま保つ)。
      const commentId = parsed.value.comment_id;
      if (commentId !== undefined) {
        const state = parsed.value.state;
        // **【`V10-M13-T03`(2026-08-24。台帳 `CM-G20` / `ADR-0369`。**門A** /
        // 判定値 = 限定採用)。理由を本文からそのまま渡す枝を足した】**
        // **口は理由を1度も組み立てない**(§6-1)。渡された文字列をそのまま
        // {@link CommentStore.updateCommentState} の第3引数へ渡すだけであり、値域
        // (対応できないという値に理由が必須・他の2値には理由を渡せない)は**器**が見る。
        const reason = parsed.value.reason;
        // **【`V10-M15-T01`(2026-08-24。台帳 `CM-G14` / `ADR-0370`。**門A** / 限定採用)。
        // ここから差分に繋ぐ枝を足した】**
        // **`diff_id` が本文に在れば繋ぎ、無ければ今日どおり状態を倒す枝へ進む。**
        // **`state` と `diff_id` を同時に送るのは 400**(1回の呼びで2つの列を倒さない。
        // 枝を2本に割らず、同じ update 枝の中で先に分ける)。
        const diffId = parsed.value.diff_id;
        if (diffId !== undefined) {
          if (state !== undefined) {
            return c.json(errorBody([commentLinkAndStateConflictError]), 400);
          }
          // **口が拒否するのはここだけである**(器を呼べない**形**)。
          if (typeof commentId !== "string" || typeof diffId !== "string") {
            return c.json(errorBody([commentLinkShapeError]), 400);
          }
          // **繋ぎを書く枝もログイン必須である(未ログインは 401)。** 状態を倒す枝
          // (裁定F)と同じ扱いを採る —— 匿名に開ける決定は審査にも条文にも無い。
          const authed = requireUser(c, store);
          if (!authed.ok) {
            return authed.response;
          }
          const comments = CommentStore.openForKernel(dataRoot);
          try {
            // **404 は口が決める**(`comment_id` が今日存在するかを先に見る。既存の
            // 状態更新の枝と同じ設計)。
            const existing = comments.getComment(commentId);
            if (existing === undefined) {
              return c.json(errorBody([unknownCommentError(commentId)]), 404);
            }
            // **400(識別子の値域違反)は器が決める**(`linkCommentToDiff` が投げた
            // 例外を口が写すだけで、同じ検査を2本目として書かない)。
            let linked: Comment;
            try {
              linked = comments.linkCommentToDiff(commentId, diffId);
            } catch (error) {
              return c.json(
                errorBody([
                  {
                    path: "",
                    message: error instanceof Error ? error.message : String(error),
                    hint: "diff_id に空文字・空白だけの文字列は送れません。",
                  },
                ]),
                400,
              );
            }
            return c.json({ comment: linked }, 200);
          } finally {
            comments.close();
          }
        }
        // **口が拒否するのはここだけである**(器を呼べない**形**)。`reason` は
        // 未指定(`undefined`)か文字列でなければ、ここで 400 になる。
        if (
          typeof commentId !== "string" ||
          typeof state !== "string" ||
          (reason !== undefined && typeof reason !== "string")
        ) {
          return c.json(errorBody([commentUpdateShapeError]), 400);
        }
        // **【裁定F】状態を倒す枝はログイン必須である(未ログインは 401)。**
        // **create 枝(`resolveOptionalUser`)とは違い、ここは `requireUser` を呼ぶ** ——
        // **`ADR-0367` が匿名に開けたのは create の口1本だけであり、状態を倒すことを
        // 匿名に開ける決定は審査にも条文にも無い(本工程が今日決めた裁定)。**
        const authed = requireUser(c, store);
        if (!authed.ok) {
          return authed.response;
        }
        // **役割を1つも見ない**(裁定G)。**ログインしてさえいれば、他人が書いたコメントの
        // 状態も倒せる**(限界。記録に書く)。
        const comments = CommentStore.openForKernel(dataRoot);
        try {
          // **404 は口が決める**(`comment_id` が今日存在するかを先に見る)。
          const existing = comments.getComment(commentId);
          if (existing === undefined) {
            return c.json(errorBody([unknownCommentError(commentId)]), 404);
          }
          // **400(状態・理由の値域違反)は器が決める**(`updateCommentState` が投げた
          // 例外を口が写すだけで、同じ検査を2本目として書かない。`CM-G19` 限定5 /
          // `CM-G20` 限定3 と同じ設計)。
          let updated: Comment;
          try {
            updated = comments.updateCommentState(commentId, state, reason);
          } catch (error) {
            return c.json(
              errorBody([
                {
                  path: "",
                  message: error instanceof Error ? error.message : String(error),
                  hint: "state に渡せる状態の一覧・理由の要否に合わせて送り直してください。",
                },
              ]),
              400,
            );
          }
          return c.json({ comment: updated }, 200);
        } finally {
          comments.close();
        }
      }
      const anchorForm = parsed.value.anchorForm;
      const anchorParts = parsed.value.anchorParts;
      const text = parsed.value.body;
      // **口が拒否するのはここだけである**(器を呼べない**形**)。
      if (
        typeof anchorForm !== "string" ||
        !isStringArray(anchorParts) ||
        typeof text !== "string"
      ) {
        return c.json(errorBody([commentShapeError]), 400);
      }
      // **【`V10-M13-T01`(2026-08-24。台帳 `CM-G10` / `ADR-0369`。**門A** / 限定採用)。
      // ここから3行が今回の追加である】**
      // **ログイン済みならセッションの利用者IDを `writer` に渡し、未ログインなら `null` の
      // ままにする。** **口はここでも書き手を1度も検証しない**(`resolveOptionalUser` は
      // セッションが指す利用者が実在するかしか見ず、名乗りが本人かは1ミリも確かめない)。
      const resolvedUser = resolveOptionalUser(c, store);
      const writer = resolvedUser === null ? null : resolvedUser.id;
      const comments = CommentStore.openForKernel(dataRoot);
      try {
        let comment: Comment;
        try {
          comment = comments.addComment({ appId, anchorForm, anchorParts, body: text, writer });
        } catch (error) {
          // **拒否したのは器である**(登録簿に無い形 / 部品の数が形と合わない /
          // 部品が空白だけ / 本文が空)。**口は例外の文面をそのまま写すだけで、
          // 同じ検査を2本目として書かない**(限定5)。
          return c.json(
            errorBody([
              {
                path: "",
                message: error instanceof Error ? error.message : String(error),
                hint: "宛先の形と部品の数を、受け付ける形の一覧に合わせて送り直してください。",
              },
            ]),
            400,
          );
        }
        // **返す本文は `Comment` 型の**写し**である** —— **キーの綴りも並びも1つも変えない
        // (`id` / `appId` / `anchorForm` / `anchorParts` / `body` / `createdAt`)。**
        // **`auth-routes.ts` の既存の口(`connectionView` / `inboundEndpointView`)と同じ
        // camelCase であり、口の側で整形しない**(限定5)。 **落とす欄も足す欄も1つも無い。**
        return c.json({ comment }, 201);
      } finally {
        comments.close();
      }
    } finally {
      store.close();
    }
  });
  // **【V10-M11-T01 ハンドラ ここまで】**

  // **【V10-M15-T05 ハンドラ ここから】**(`2026-08-24`。台帳 `CM-G21` / `ADR-0370`。
  // **門A** / 限定採用。ここから読出の口を1本足した)
  //
  // **対応できないまま残ったコメントを一覧する読出の口である。** **クエリは `state` だけ**
  // (任意。省略すると3値すべて)。**`limit` / `offset` を置かない** —— **2つ目のページの
  // 切り方を作らない**(量の歯止めが1つも無いことは限界として記録に書く)。
  //
  // **削除・編集・状態を変える機能を1つも持たせない**(`ADR-0370` の線5)。
  // **`GET` を1本足すだけで、同じパスの `PATCH` / `DELETE` / `PUT` は Hono の既定の
  // 404 のままである。**
  app.get("/api/apps/:app_id/comments", (c) => {
    const appId = c.req.param("app_id");
    const opened = openStore(c, appId);
    if (!opened.ok) {
      return opened.response;
    }
    const store = opened.store;
    try {
      // **壁は `requireUser`。未ログインは 401。役割を見るのは可視性の合成だけである。**
      //
      // **【`V10-M27-T02`(2026-08-25。`ADR-0375`)。壁が条件つきになった。
      // すぐ上の1行は制定時の記述であり、1バイトも書き換えていない】**
      // **今日の正**: **規則を1本も書いていないアプリでは、未ログインを 401 にしない** ——
      // **名乗りを `null` のまま合成へ渡し、合成が全件を返す。**
      // **開く条件(2つの `AND`)を口の側に1つも書き写していない** —— **読むのは合成が
      // 公開している述語1本だけである**(条件式が2箇所に割れないようにするため)。
      // **`manifestFor` は読めないアプリで `undefined` を返し、述語はそれを閉じる側に倒す** ——
      // **定義が壊れて読めないアプリは今日どおり 401 である。**
      const manifest = manifestFor(appId);
      const authed = requireUser(c, store);
      if (!authed.ok && !declaresNoRules(manifest)) {
        return authed.response;
      }
      const roles = authed.ok ? store.effectiveRoles(authed.user.id) : null;
      const stateParam = c.req.query("state");
      const comments = CommentStore.openForKernel(dataRoot);
      try {
        let rows: Comment[];
        if (stateParam === undefined) {
          rows = comments.listComments(appId);
        } else {
          // **400(値域違反)は器が決める**(`listCommentsByState` が投げた例外を口が
          // 写すだけで、同じ検査を2本目として書かない。**器はここでも既存の
          // `resolveCommentState` しか見ない**)。
          try {
            rows = comments.listCommentsByState(appId, stateParam);
          } catch (error) {
            return c.json(
              errorBody([
                {
                  path: "",
                  message: error instanceof Error ? error.message : String(error),
                  hint: "state に渡せる状態の一覧に合わせて送り直してください。",
                },
              ]),
              400,
            );
          }
        }
        // **必ず `visibleComments` を通す**(この口が `judgeRoleAccess` を直に呼ばない
        // —— 判定の家は1軒のまま)。**`manifestFor` は読めないアプリで `undefined` に
        // 倒す**(閉じる側)。
        const visible = visibleComments({ manifest, roles, comments: rows });
        // **`total` は絞ったあと(可視集合)の長さである。** **母集団を割らない**
        // (`src/mcp/tools/read.ts` の `total: visible.length,` と同じ作法)。
        return c.json({ comments: visible, total: visible.length }, 200);
      } finally {
        comments.close();
      }
    } finally {
      store.close();
    }
  });
  // **【V10-M15-T05 ハンドラ ここまで】**
}

/**
 * 逃げ道の資産の外向き表現。**CSS のバイト列を含まない** —— 返すのは参照
 * (資産名 + 内容ダイジェスト)と作用域だけである。appId は URL で確定しているので返さない。
 */
function escapeHatchAssetView(asset: EscapeHatchAsset): {
  id: string;
  name: string;
  digest: string;
  scopeViews: string[];
  createdAt: string;
} {
  return {
    id: asset.id,
    name: asset.name,
    digest: asset.digest,
    scopeViews: asset.scopeViews,
    createdAt: asset.createdAt,
  };
}

/**
 * POST /escape-hatch-assets の body を検証する(ADR-0055 限定7・限定8)。
 *
 * name 非空 / css 非空文字列 / **scopeViews は非空の文字列配列**。
 * **`scopeViews` の欠落を全許可にフォールバックさせない**(限定7:「宣言を持たない発行を
 * 受理しない。ワイルドカード全許可を既定にしない」)。`"*"` も明示的に拒む。
 *
 * **CSS の中身は1バイトも検査しない**(限定8:「CSS プロパティの許可リストも拒否リストも
 * 作らない」)—— 見るのは「文字列であること」「空でないこと」だけである。
 */
function validateEscapeHatchAssetInput(body: Record<string, unknown>):
  | {
      ok: true;
      value: { name: string; css: string; scopeViews: string[]; requestId?: string };
    }
  | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  const name = body.name;
  if (typeof name !== "string" || name.trim() === "") {
    errors.push({
      path: "/name",
      message: "name は必須です(1文字以上の資産名)。",
      hint: "マニフェストの画面がこの名前で逃げ道を参照します。",
    });
  }

  const css = body.css;
  if (typeof css !== "string" || css === "") {
    errors.push({
      path: "/css",
      message: "css は必須です(1文字以上の CSS 本文)。",
      hint: "本文はそのまま保存され、内容の sha256 で content-addressed に置かれます。中身は解釈も検査もされません。",
    });
  }

  const rawScope = body.scopeViews;
  let scopeViews: string[] = [];
  if (!Array.isArray(rawScope) || rawScope.some((v) => typeof v !== "string")) {
    errors.push({
      path: "/scopeViews",
      message: "scopeViews は画面ID(文字列)の配列である必要があります(必須)。",
      hint: 'この資産を当ててよい画面を1つずつ列挙してください。例: ["books-list"]。省略しても全画面許可にはなりません。',
    });
  } else if (rawScope.length === 0) {
    errors.push({
      path: "/scopeViews",
      message: "scopeViews を空にはできません(作用域の宣言が無い発行は受理しません)。",
      hint: "当ててよい画面を1つ以上指定してください。空の宣言は「全部許可」とも「何も許可しない」とも解釈しません。",
    });
  } else if (rawScope.some((v) => v === "*" || (v as string).trim() === "")) {
    errors.push({
      path: "/scopeViews",
      message: 'scopeViews にワイルドカード "*" や空文字は指定できません。',
      hint: "全画面に当てる手段は用意していません(ADR-0055 限定7)。当ててよい画面を1つずつ列挙してください。",
    });
  } else {
    scopeViews = rawScope as string[];
  }

  const rawRequestId = body.requestId;
  let requestId: string | undefined;
  if (rawRequestId !== undefined) {
    if (typeof rawRequestId !== "string") {
      errors.push({
        path: "/requestId",
        message: "requestId は文字列である必要があります。",
        hint: "承認する申請(request)の id を指定してください(省略可)。",
      });
    } else {
      requestId = rawRequestId;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      name: (name as string).trim(),
      css: css as string,
      scopeViews,
      ...(requestId === undefined ? {} : { requestId }),
    },
  };
}

/**
 * AI capability の外向き表現。**secretSource は取得元の参照(env 名 / コマンド)であって
 * secret 値ではない**ので owner に返してよい(§2d)。`claude_cli` は secretSource が null。
 */
function aiCapabilityView(capability: AiCapability): {
  id: string;
  name: string;
  provider: AiProviderKind;
  model: string;
  baseUrl: string | null;
  secretSource: { kind: "env" | "command"; value: string } | null;
  maxCallsPerDay: number;
  maxCostUsdPerDay: number;
  createdAt: string;
} {
  return {
    id: capability.id,
    name: capability.name,
    provider: capability.provider,
    model: capability.model,
    baseUrl: capability.baseUrl,
    secretSource:
      capability.secretSource === null
        ? null
        : { kind: capability.secretSource.kind, value: capability.secretSource.value },
    maxCallsPerDay: capability.limit.maxCallsPerDay,
    maxCostUsdPerDay: capability.limit.maxCostUsdPerDay,
    createdAt: capability.createdAt,
  };
}

/** 日次上限(回数・コスト)を検証する。負数・非数は拒否。 */
function validateAiLimit(body: Record<string, unknown>):
  | { ok: true; value: { maxCallsPerDay: number; maxCostUsdPerDay: number } }
  | {
      ok: false;
      errors: ValidationError[];
    } {
  const errors: ValidationError[] = [];
  const calls = body.maxCallsPerDay;
  const cost = body.maxCostUsdPerDay;
  if (typeof calls !== "number" || !Number.isFinite(calls) || calls < 0) {
    errors.push({
      path: "/maxCallsPerDay",
      message: "maxCallsPerDay は 0 以上の数値である必要があります。",
      hint: "1日あたりの最大呼び出し回数。0 = 呼べない(最小権限)。",
    });
  }
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
    errors.push({
      path: "/maxCostUsdPerDay",
      message: "maxCostUsdPerDay は 0 以上の数値である必要があります。",
      hint: "1日あたりの最大推定コスト(USD)。0 = 呼べない(最小権限)。",
    });
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: { maxCallsPerDay: calls as number, maxCostUsdPerDay: cost as number } };
}

/**
 * POST /ai-capabilities の body を検証する。name 非空 / provider が claude_cli|openai_compatible /
 * model 非空 / 上限(必須)/ openai_compatible なら base_url + secretSource 必須。
 */
function validateAiCapabilityInput(body: Record<string, unknown>):
  | {
      ok: true;
      value: {
        capability: {
          name: string;
          provider: AiProviderKind;
          model: string;
          baseUrl: string | null;
          secretSource: SecretSource | null;
          limit: { maxCallsPerDay: number; maxCostUsdPerDay: number };
        };
        requestId?: string;
      };
    }
  | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  const name = body.name;
  if (typeof name !== "string" || name.trim() === "") {
    errors.push({
      path: "/name",
      message: "name は必須です(1文字以上の capability 名)。",
      hint: "ワークフローの ai_transform が参照する capability 名を指定してください。",
    });
  }

  const provider = body.provider;
  if (provider !== "claude_cli" && provider !== "openai_compatible") {
    errors.push({
      path: "/provider",
      message: "provider は claude_cli または openai_compatible である必要があります。",
      hint: "既定は claude_cli(claude -p を使う。secret 不要)。",
    });
  }

  const model = body.model;
  if (typeof model !== "string" || model.trim() === "") {
    errors.push({
      path: "/model",
      message: "model は必須です(モデル識別子)。",
      hint: "例: claude-opus-4-8 / openai/gpt-4o-mini。",
    });
  }

  const limit = validateAiLimit(body);
  if (!limit.ok) {
    errors.push(...limit.errors);
  }

  // openai_compatible のときだけ base_url と secretSource を要求する。
  let baseUrl: string | null = null;
  let secretSource: SecretSource | null = null;
  if (provider === "openai_compatible") {
    const rawBaseUrl = body.baseUrl;
    if (typeof rawBaseUrl !== "string" || rawBaseUrl.trim() === "") {
      errors.push({
        path: "/baseUrl",
        message: "openai_compatible には baseUrl が必須です。",
        hint: "例: https://openrouter.ai/api/v1。",
      });
    } else {
      baseUrl = rawBaseUrl;
    }
    const rawSource = body.secretSource;
    if (typeof rawSource !== "object" || rawSource === null || Array.isArray(rawSource)) {
      errors.push({
        path: "/secretSource",
        message: "openai_compatible には secretSource(API キーの取得元)が必須です。",
        hint: '例: { "kind": "env", "value": "OPENROUTER_API_KEY" }。値は保管しません(use-time 解決)。',
      });
    } else {
      const source = rawSource as Record<string, unknown>;
      const kind = source.kind;
      const value = source.value;
      if ((kind !== "env" && kind !== "command") || typeof value !== "string" || value === "") {
        errors.push({
          path: "/secretSource",
          message: "secretSource.kind は env|command、value は非空文字列である必要があります。",
          hint: "kind=env なら value は環境変数名、kind=command なら取得コマンド行。",
        });
      } else {
        secretSource = { kind, value };
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
  return {
    ok: true,
    value: {
      capability: {
        name: (name as string).trim(),
        provider: provider as AiProviderKind,
        model: (model as string).trim(),
        baseUrl,
        secretSource,
        limit: (limit as { ok: true; value: { maxCallsPerDay: number; maxCostUsdPerDay: number } })
          .value,
      },
      ...(requestId === undefined ? {} : { requestId }),
    },
  };
}

/**
 * connection の外向き表現。**secretSource は取得元の参照(env 名 / コマンド)であって
 * secret 値ではない**ので owner に返してよい(§2d)。appId は URL で確定しているので返さない。
 */
function connectionView(connection: Connection): {
  id: string;
  name: string;
  allowedHosts: string[];
  secretSource: { kind: "env" | "command"; value: string };
  createdAt: string;
} {
  return {
    id: connection.id,
    name: connection.name,
    allowedHosts: connection.allowedHosts,
    secretSource: { kind: connection.secretSource.kind, value: connection.secretSource.value },
    createdAt: connection.createdAt,
  };
}

/**
 * POST /connections の body を検証する。name 非空 / allowedHosts が文字列配列 /
 * secretSource.kind が env|command / value 非空。不正は 400 用のエラー配列。
 */
function validateConnectionInput(body: Record<string, unknown>):
  | {
      ok: true;
      value: {
        name: string;
        allowedHosts: string[];
        secretSource: { kind: "env" | "command"; value: string };
        requestId?: string;
      };
    }
  | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  const name = body.name;
  if (typeof name !== "string" || name.trim() === "") {
    errors.push({
      path: "/name",
      message: "name は必須です(1文字以上の接続名)。",
      hint: "ワークフローの call_external が参照する接続名を指定してください。",
    });
  }

  const rawHosts = body.allowedHosts;
  let allowedHosts: string[] = [];
  if (!Array.isArray(rawHosts) || rawHosts.some((h) => typeof h !== "string")) {
    errors.push({
      path: "/allowedHosts",
      message: "allowedHosts はホスト名(文字列)の配列である必要があります。",
      hint: '例: ["api.example.com"]。既定は空配列 = 何も許可しない(最小権限)。',
    });
  } else {
    allowedHosts = rawHosts as string[];
  }

  const rawSource = body.secretSource;
  let secretSource: { kind: "env" | "command"; value: string } | undefined;
  if (typeof rawSource !== "object" || rawSource === null || Array.isArray(rawSource)) {
    errors.push({
      path: "/secretSource",
      message: "secretSource は { kind, value } のオブジェクトである必要があります。",
      hint: 'secret 本体ではなく取得元を指定します。例: { "kind": "env", "value": "STRIPE_API_KEY" }。',
    });
  } else {
    const source = rawSource as Record<string, unknown>;
    const kind = source.kind;
    const value = source.value;
    if (kind !== "env" && kind !== "command") {
      errors.push({
        path: "/secretSource/kind",
        message: "secretSource.kind は env または command のいずれかです。",
        allowed_values: ["env", "command"],
        hint: "env は環境変数名、command は取得コマンド行を value に入れます。",
      });
    }
    if (typeof value !== "string" || value === "") {
      errors.push({
        path: "/secretSource/value",
        message: "secretSource.value は必須です(取得元の参照)。",
        hint: "kind=env なら環境変数名、kind=command なら取得コマンド行を指定してください。",
      });
    }
    if ((kind === "env" || kind === "command") && typeof value === "string" && value !== "") {
      secretSource = { kind, value };
    }
  }

  const rawRequestId = body.requestId;
  let requestId: string | undefined;
  if (rawRequestId !== undefined) {
    if (typeof rawRequestId !== "string") {
      errors.push({
        path: "/requestId",
        message: "requestId は文字列である必要があります。",
        hint: "承認する申請(request)の id を指定してください(省略可)。",
      });
    } else {
      requestId = rawRequestId;
    }
  }

  if (errors.length > 0 || name === undefined || secretSource === undefined) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      name: name as string,
      allowedHosts,
      secretSource,
      ...(requestId === undefined ? {} : { requestId }),
    },
  };
}

/**
 * **受信口の外向き表現**(`V8-M41` / 台帳 `F-G14` / `ADR-0332`。`connectionView` の鏡写し)。
 *
 * **`secretSource` は取得元の参照(env 名 / コマンド行)であって鍵の値ではない**ので
 * owner に返してよい(`ADR-0041` 限定4 = `ADR-0020` §2d の対称)。
 * **署名検証鍵の本体はそもそも保管していないので、返す手段が無い** ——
 * `InboundEndpoint` に鍵本体のフィールドは1つも無い(`src/kernel/inbound-store.ts` の
 * SCHEMA に鍵の列が無い)。
 *
 * **`appId` は URL で確定しているので返さない**(`connectionView` と同じ作法)。
 * **`signatureHeader` / `signatureFormat` は返す** —— **受信側(送り手)がどのヘッダに
 * どの書き表し方で署名を載せればよいかを、発行の応答だけで確定できないと、
 * 「発行 → 受信」の2本続きが人の手で繋がらないからである。**
 */
function inboundEndpointView(endpoint: InboundEndpoint): {
  id: string;
  name: string;
  targetTable: string;
  secretSource: { kind: "env" | "command"; value: string };
  createdAt: string;
  signatureHeader: InboundSignatureHeader;
  signatureFormat: InboundSignatureFormat;
} {
  return {
    id: endpoint.id,
    name: endpoint.name,
    targetTable: endpoint.targetTable,
    secretSource: { kind: endpoint.secretSource.kind, value: endpoint.secretSource.value },
    createdAt: endpoint.createdAt,
    signatureHeader: endpoint.signatureHeader,
    signatureFormat: endpoint.signatureFormat,
  };
}

/**
 * `POST /inbound-endpoints` の body を検証する(`validateConnectionInput` の鏡写し)。
 *
 * **name 非空 / targetTable 非空 / secretSource.kind が env|command / value 非空。**
 * **`signatureHeader` / `signatureFormat` は省略可で、書くなら文字列であること**だけを見る ——
 * **値域はカーネルの `checkSignatureShape` 1本が持つ**(`ADR-0160` 限定2 / 限定4)。
 * **サーバ層に3値の綴りを2度書かない** —— **書くと「コードは3値・DB は2値」の食い違いが
 * 構造的に起きうる**(`src/kernel/inbound-store.ts` の `sqlEnum` の doc が同じ理由を書いている)。
 * **値域の外は 1行も書かれる前に例外になり、この口はそれを 400 に落とす。**
 *
 * **【この検査がしないこと。丸めない】** **`targetTable` がマニフェストに実在するかを
 * 1バイトも見ない。** **実在しない表を指す受信口を発行できる**(その受信口へ Webhook が
 * 来たときに `POST /inbound/:endpoint_id` の側が断る)。 **`validateConnectionInput` が
 * `allowedHosts` の実在を見ないのと同じ水準に揃えた** —— **`ADR-0332` の限界に書いてある。**
 */
function validateInboundEndpointInput(body: Record<string, unknown>):
  | {
      ok: true;
      value: {
        name: string;
        targetTable: string;
        secretSource: { kind: "env" | "command"; value: string };
        signatureHeader?: InboundSignatureHeader;
        signatureFormat?: InboundSignatureFormat;
        requestId?: string;
      };
    }
  | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  const name = body.name;
  if (typeof name !== "string" || name.trim() === "") {
    errors.push({
      path: "/name",
      message: "name は必須です(1文字以上の受信口の名前)。",
      hint: "同じアプリの中で重複しない名前を指定してください(名前を変える口も消す口も在りません)。",
    });
  }

  const targetTable = body.targetTable;
  if (typeof targetTable !== "string" || targetTable.trim() === "") {
    errors.push({
      path: "/targetTable",
      message: "targetTable は必須です(受信した1件を書き込むテーブルID)。",
      hint: "受信口が書けるのはこのテーブル1つだけです(ADR-0041 限定3。後から変える口は在りません)。",
    });
  }

  const rawSource = body.secretSource;
  let secretSource: { kind: "env" | "command"; value: string } | undefined;
  if (typeof rawSource !== "object" || rawSource === null || Array.isArray(rawSource)) {
    errors.push({
      path: "/secretSource",
      message: "secretSource は { kind, value } のオブジェクトである必要があります。",
      hint: '署名検証鍵の本体ではなく取得元を指定します。例: { "kind": "env", "value": "PSP_WEBHOOK_SECRET" }。',
    });
  } else {
    const source = rawSource as Record<string, unknown>;
    const kind = source.kind;
    const value = source.value;
    if (kind !== "env" && kind !== "command") {
      errors.push({
        path: "/secretSource/kind",
        message: "secretSource.kind は env または command のいずれかです。",
        allowed_values: ["env", "command"],
        hint: "env は環境変数名、command は取得コマンド行を value に入れます。",
      });
    }
    if (typeof value !== "string" || value === "") {
      errors.push({
        path: "/secretSource/value",
        message: "secretSource.value は必須です(取得元の参照)。",
        hint: "kind=env なら環境変数名、kind=command なら取得コマンド行を指定してください。",
      });
    }
    if ((kind === "env" || kind === "command") && typeof value === "string" && value !== "") {
      secretSource = { kind, value };
    }
  }

  const rawHeader = body.signatureHeader;
  if (rawHeader !== undefined && typeof rawHeader !== "string") {
    errors.push({
      path: "/signatureHeader",
      message: "signatureHeader は文字列である必要があります(省略すると既定のヘッダ)。",
      hint: "署名が載るヘッダの名前を有限の値域から1つ選びます(自由文字列は書けません)。",
    });
  }
  const rawFormat = body.signatureFormat;
  if (rawFormat !== undefined && typeof rawFormat !== "string") {
    errors.push({
      path: "/signatureFormat",
      message: "signatureFormat は文字列である必要があります(省略すると既定の書き表し方)。",
      hint: "署名の値の書き表し方を有限の値域から1つ選びます(署名アルゴリズムは選べません)。",
    });
  }

  const rawRequestId = body.requestId;
  let requestId: string | undefined;
  if (rawRequestId !== undefined) {
    if (typeof rawRequestId !== "string") {
      errors.push({
        path: "/requestId",
        message: "requestId は文字列である必要があります。",
        hint: "承認する申請(request_inbound_endpoint が積んだもの)の id を指定してください(省略可)。",
      });
    } else {
      requestId = rawRequestId;
    }
  }

  if (
    errors.length > 0 ||
    typeof name !== "string" ||
    typeof targetTable !== "string" ||
    secretSource === undefined
  ) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      name,
      targetTable,
      secretSource,
      // **値域はカーネルが閉じる**(上の doc)。ここでは型だけを合わせて渡す。
      ...(rawHeader === undefined ? {} : { signatureHeader: rawHeader as InboundSignatureHeader }),
      ...(rawFormat === undefined ? {} : { signatureFormat: rawFormat as InboundSignatureFormat }),
      ...(requestId === undefined ? {} : { requestId }),
    },
  };
}
