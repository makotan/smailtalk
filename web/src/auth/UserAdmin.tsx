/**
 * ユーザ/ロール管理画面(owner 限定・V1-M3-T02 / ADR-0015)。
 *
 * `GET /auth/users` で一覧を取り、行ごとの `<select>` でロールを変える。ロール変更は
 * `PATCH /auth/users/:id` を叩き、成功したら手元の一覧を更新する。**最後の owner を
 * 降格しようとするとサーバが 409 を返す**ので、その場合は「最後の管理者は降格できません」
 * と出して元の値に戻す(`isLastOwnerConflict`)。それ以外の失敗はサーバの統一形式文面を
 * そのまま出す(フロントで作り直さない)。
 *
 * この画面に入れるのは owner だけ(導線は `AppWorkspace` が owner のときだけ出す)。
 * 直接開かれても、サーバが非 owner に 403 を返すので一覧は空にならず「権限がありません」で
 * 止まる —— UI の出し分けは先回りで、最終防衛線はサーバである。
 *
 * ## V3-M3-T03(D-G12a)で変えた2点
 *
 * 1. **選択肢を4値にした**(`ROLE_ORDER` に `customer` を追加)。サーバの `ROLE_VALUES` は
 *    もともと4値で `PATCH` も customer を受理していたので、**この画面だけが3値で遅れていた。**
 *    同期は `web/test/role-order-sync.test.ts` が固定する。
 * 2. **owner / editor → customer に確認を挟む**(ユーザ決定 D-M3-3)。**警告であって禁止では
 *    ない** —— 確認すればサーバは受理する。**「構造で防いだ」ではない。**構造で止まるのは
 *    従来どおり「最後の owner の降格」= サーバの 409 だけである(`isLastOwnerConflict`)。
 *
 * ## 【V4-M15-T14】部品体系で組み直した(`ADR-0087` / `ADR-0089`)
 *
 * **文言も `data-testid` も1バイトも変えていない。** 変えたのは器だけである:
 *
 * - **表を `TableFrame`(`overflow-x-auto`)で包んだ**(`D-V4-44`)—— 狭い画面で
 *   ロールの列が画面外に出ないようにするため。**`class="user-admin-table"` は `<table>` に
 *   残してある。**
 * - **読み込み中に `Skeleton` を出す**(着手前 0件)。**文言は変えていない。**
 * - **`role-error` と降格の確認を `Alert variant="destructive"` にした**(着手前は素の
 *   `<p>` / `<div>` で、当たる CSS 規則は0件だった。`03` §4-1 の「警告表示 CSS 0件」)。
 *   **`role="alert"` は `Alert` が持つ。** **`data-from` / `data-to` はそのままである。**
 * - **【禁止を守った】重ねて出す表現(モーダル)を1つも作っていない**(`ADR-0087` 限定8)——
 *   降格の確認は着手前と同じく**文書の流れの中**に出る。
 */
import { useCallback, useEffect, useState } from "react";
// **【2026-08-13。`V8-M38`。台帳 `F-G9`】旧(逐語)**:
//     import { DEFAULT_USER_KIND, RESERVED_ROLES } from "../../../src/auth/types.ts";
// **`roleOrder` の土台から `DEFAULT_USER_KIND` を落としたので、値としての参照が0箇所になった。**
import { RESERVED_ROLES } from "../../../src/auth/types.ts";
import {
  type AppInvitation,
  type AppUser,
  type AppUserList,
  type IssuedInvitationResult,
  isLastOwnerConflict,
  issueInvitation,
  listAppUsers,
  type Role,
  revokeInvitation,
  setAppUserRole,
  type ValidationError,
} from "../api.ts";
import { type AsyncState, toValidationErrors } from "../async.ts";
import { ErrorList } from "../ErrorList.tsx";
import { Button } from "../ui/button.tsx";
import { Input, Label, Select } from "../ui/form-controls.tsx";
import { Alert, Card, Skeleton } from "../ui/surfaces.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table.tsx";
import { cn } from "../ui/utils.ts";
import { roleLabels, type UserKind } from "./authz.tsx";

/**
 * `<select>` に並べるロールの順序(V3-M3-T03 / D-G12a で `customer` を足して4値にした)。
 *
 * **サーバの `ROLE_VALUES`(`src/server/auth-routes.ts`)と集合として一致していなければ
 * ならない。**片方だけ増えると「API は受理するのに選べない / 選べるのに必ず 400」になる。
 * その同期は `web/test/role-order-sync.test.ts` が機械的に固定する(先例は
 * `src/auth/role-vocabulary-sync.test.ts`。門外 Δ7 のため `src/` には置けない)。
 *
 * 並べ順は**権限の広い順**で、`customer` は運営3ロールの後ろに置く —— 誤クリックの
 * 当たり先を既定から遠ざけるためであり、**これは防御ではない**(D-M3-3)。
 *
 * ---
 *
 * ## **【2026-08-13。`V8-M38`。台帳 `F-G9`。判定値 = 限定採用(門外 `Δ7`)】**
 *
 * **上の doc を1バイトも書き換えていない。** **4値目(`customer`)を落とした。**
 *
 * **旧(逐語)**:
 *
 *     export const ROLE_ORDER = [
 *       "owner",
 *       "editor",
 *       "viewer",
 *       "customer",
 *     ] as const satisfies readonly Role[];
 *
 * **サーバの `baseRoleValues()` が `customer` を無条件に足すのをやめたので、
 * 「宣言を1つも持たないアプリの選択肢」も3値になった。**
 * **`customer` を宣言したアプリでは、`roleOrder(roleIds)` が宣言の側から並べる。**
 * **上の「`customer` は運営3ロールの後ろに置く」は、宣言したアプリでは今日も真である。**
 */
export const ROLE_ORDER = ["owner", "editor", "viewer"] as const satisfies readonly Role[];

/**
 * ---
 *
 * ## **【`V5-M17-T08` / `G-G5` / `ADR-0158`】固定4値を宣言から組み立てる形にした**
 *
 * **上の `ROLE_ORDER` を1バイトも消していない** —— **宣言を1つも持たないアプリの選択肢は
 * 今日もこの4値であり、その事実を示す定数として残す**(`web/test/role-order-sync.test.ts`
 * が「宣言が無いときは着手前と同じ4値」を測る)。
 *
 * **宣言があるアプリでは、選択肢は「予約3ロール + 宣言された種類」である。**
 * **並べ順は権限の広い順**(運営3 → 非運営)で、着手前の規律を1ミリも変えていない。
 */
/**
 * ---
 *
 * ## **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a` / `T-G12`。判定値 = 廃止】**
 *
 * **上の doc を1バイトも書き換えていない。** **引数を「宣言された利用者の種類」から
 * 「宣言された役割の識別子」へ差し替えた。**
 *
 * **旧(逐語)**:
 *
 *     export function roleOrder(kinds: readonly UserKind[] = []): readonly Role[] {
 *       return [...RESERVED_ROLES, ...(kinds.length === 0 ? ["customer"] : kinds.map((k) => k.id))];
 *     }
 *
 * **【第1波が「広げていない」と正直に書いた穴を、この波で塞いだ】** ——
 * **着手前、API は `app.roles` で宣言した役割を受理するのに、画面のセレクトには
 * 出なかった。** **今日の戻りは `src/server/auth-routes.ts` の `assignableRoleValues` と
 * 集合として一致する**(`web/test/role-order-sync.test.ts` が機械的に固定する)。
 *
 * **並べ順は権限の広い順のままである**(運営3 → `customer` → アプリが宣言した役割)。
 * **`anonymous` は宣言されていても並べない** —— **人に付けられない値だからである**
 * (ユーザ決定 `D-V8-80`。サーバ側の `customRoleIds` と同じ落とし方)。
 *
 * **【判定を2箇所に持っていることを隠さない】** **サーバの `customRoleIds` を
 * import できない**(`src/server/auth-routes.ts` は Hono を引き込む)ので、
 * **同じ形をここに書き直している。** **ずれたら `role-order-sync.test.ts` が赤くなる。**
 *
 * ---
 *
 * ## **【2026-08-13。`V8-M38`。台帳 `F-G9`。判定値 = 限定採用(門外 `Δ7`)】**
 *
 * **上の doc を1バイトも書き換えていない。** **土台から `DEFAULT_USER_KIND` を落とした。**
 *
 * **旧(逐語)**:
 *
 *     const base: readonly string[] = [...RESERVED_ROLES, DEFAULT_USER_KIND];
 *
 * **したがって上の「並べ順は権限の広い順のままである(運営3 → `customer` →
 * アプリが宣言した役割)」の `customer` の位置は、今日から偽である** ——
 * **`customer` を宣言したアプリでは、`customer` は「アプリが宣言した役割」の側に並ぶ。**
 *
 * **ここを直したのは、サーバの `baseRoleValues()` が `customer` を落としたためである** ——
 * **直さないと「画面には出るのに API が必ず 400 で断る」選択肢が1本できる**
 * (`web/test/role-order-sync.test.ts` が集合一致を機械的に固定している)。
 * **`anonymous` の落とし方は1バイトも触っていない**(`D-V8-80`)。
 */
export function roleOrder(roleIds: readonly string[] = []): readonly Role[] {
  const reserved = new Set<string>([...RESERVED_ROLES, "anonymous"]);
  const base: readonly string[] = [...RESERVED_ROLES];
  const seen = new Set<string>(base);
  const custom: string[] = [];
  for (const id of roleIds) {
    if (reserved.has(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    custom.push(id);
  }
  return [...base, ...custom] as readonly Role[];
}

/**
 * そのロール変更が「運営から締め出す」型の降格か(V3-M3-T03 / ユーザ決定 D-M3-3)。
 *
 * customer はテーブル単位で運営データを遮断される(`nonAdminTableAccess` が "denied" を
 * 返すテーブルは GET も書込も 403)。owner / editor をここへ落とすと運営画面から出られなく
 * なるので、**確認を挟む**。
 *
 * **これは警告であって禁止ではない。** 確認すれば PATCH は飛び、サーバは受理する。
 * 構造で止まるのは「最後の owner の降格」(サーバの 409)だけである。
 *
 * **viewer → customer は対象にしていない。** T03 の完了条件4 が名指ししているのが
 * owner / editor の2つだからである(viewer も運営テーブルの読みは失うので、
 * 警告が要るかは本タスクでは判定していない)。
 *
 * ---
 *
 * ## 【`V8-M27-T04` / `T-G5`(2026-08-11)の訂正。**上の旧文を1バイトも消していない**】
 *
 * **上の1文目「customer はテーブル単位で運営データを遮断される(`nonAdminTableAccess` が
 * "denied" を返すテーブルは GET も書込も 403)」は今日から偽である。**
 * **`nonAdminTableAccess` は撤去された**(`src/server/owner-scope.ts`)——
 * **今日、表単位の可否を決めるのは面(`app.roles[].rules`)であり、役割の綴りではない。**
 *
 * ## **この関数と `roleOrder` を残した理由**(**先行の門A審査はどちらも1度も見ていない。
 * その事実を先に書く** —— `V8-M15` の軸3の本審査45行にも `V8-M25` の軸4の本審査56単位にも、
 * この2件を名指しした単位は1つも無い。**以下は実装側の判断である**)
 *
 * - **`roleOrder`(`RESERVED_ROLES` の展開)は残す。** **これは可否の判定ではなく、
 *   ロール変更セレクトの**選択肢の並び**である。** **`RESERVED_ROLES` は値域として
 *   今日も生きており**(`schemas/manifest.schema.json` の `not.enum` 2箇所 /
 *   `src/auth/role-vocabulary-sync.test.ts`)、**予約3ロールが実在する以上、
 *   選択肢に並べないほうが誤りである。**
 * - **`isLockoutDemotion` も残す。** **警告の中身は「表単位の遮断」ではなくなったが、
 *   **予約3ロールを外すと今日も実際に失うものが在る** —— **`POST /diffs` /
 *   `POST /undo` / `requireOwner`(10箇所)/ 初回 owner ブートストラップは
 *   `owner` を名指しで要求しており、`V8-M27` はそこを1バイトも撤去していない。**
 *   **したがって owner / editor を非運営の種類へ落とす操作は、今日も
 *   「アプリの作りを変える口から締め出す」変更である。**
 * - **【正直に書く】警告の**文面**は運営データの遮断を前提にしている可能性がある** ——
 *   **本タスクは文面を1バイトも書き換えていない**(射程外)。**確認の必要性そのものは
 *   上の理由で今日も立つが、理由が入れ替わったことは記録に書く。**
 */
export function isLockoutDemotion(from: Role, to: Role): boolean {
  // **【`V5-M17-T05`】`to === "customer"` の等値比較をやめた。**
  // **今日は「運営の予約ロールでない値へ落とす」が条件である** —— **宣言された種類も
  // 運営データから遮断されるので、警告が要る条件は `customer` に限られない**
  // (`ADR-0158` 限定2 = 宣言された種類の認可規則は `customer` と同一)。
  // **宣言を1つも持たないアプリでの答えは着手前と1つも変わらない**(非運営 = `customer`)。
  return (
    !RESERVED_ROLES.includes(to as (typeof RESERVED_ROLES)[number]) &&
    (from === "owner" || from === "editor")
  );
}

/** 確認待ちのロール変更(降格警告の対象)。 */
type PendingDemotion = { userId: string; username: string; from: Role; to: Role };

export function UserAdmin({
  appId,
  onClose,
  roleIds = [],
  roles = [],
}: {
  appId: string;
  onClose?: () => void;
  /**
   * **アプリが宣言した役割の識別子**(`V8-M29` 第2波 / 台帳 `T-G9a`)。
   *
   * **旧(逐語)**: `userKinds?: readonly UserKind[];`(**アプリが宣言した利用者の種類**
   * (`V5-M17-T08`)。渡さなければ着手前と同じ4値になる。)
   * **渡さなければ着手前と同じ4値になる、という性質は今日も変わらない。**
   */
  roleIds?: readonly string[];
  /**
   * **アプリが宣言した役割のうち、表示名を持つもの**(`V8-M29` 第1波 / `D-V8-79`)。
   *
   * **表示名の解決にだけ使う。** **選択肢(`roleOrder`)には1バイトも効かない** ——
   * **画面のセレクトは今日も `user_kinds` だけを並べる**(この波の限界。
   * **API が受理する値と、画面が並べる値は今日ずれている**)。
   * **【`V8-M29` 第2波。上の3行は第1波の逐語であり消していない】** **今日は選択肢を
   * `roleIds` が並べ、`assignableRoleValues` と集合として一致する** —— **ずれは無い。**
   * **本 prop は今日も表示名の解決にだけ使う**(`name` を書かなかった役割は載らない)。
   * **表示名を書かなかった役割はここに載らず、識別子が生で出る**(`D-V8-79`)。
   */
  roles?: readonly UserKind[];
}) {
  const labels = roleLabels(roles);
  const [state, setState] = useState<AsyncState<AppUserList>>({ status: "loading" });
  /** ロール変更の失敗文面(409 やその他)。成功でクリアする。 */
  const [roleError, setRoleError] = useState<string | null>(null);
  /** 変更を送信中のユーザID(その行のセレクトを一時的に無効化する)。 */
  const [savingId, setSavingId] = useState<string | null>(null);
  /** 確認待ちの降格(D-M3-3)。`null` のあいだは警告を出さない。 */
  const [pendingDemotion, setPendingDemotion] = useState<PendingDemotion | null>(null);
  /**
   * **発行 / 出し直しで受け取った招待**(`V19-M3-T02`。台帳 `SV-G3`)。
   *
   * **着手前はこの値を `InvitePanel` が自分で持っていた。** **この段が親へ持ち上げた** ——
   * **出し直しは一覧の行から撃つが、出たコードを見せる場所は発行の結果欄 1箇所のままに
   * したいからである**(`ADR-0452` ⑮「コードの提供先は発行の応答本文の1箇所ちょうど」)。
   *
   * **【禁止の履行】コードを一覧の行に出す経路を1本も作っていない** ——
   * **作ると `web/test/invitation-list-panel.test.tsx` の `(3-a)` / `(3-b)` と
   * `web/e2e/invitation-list.e2e.ts` の (4) が守っているものが崩れる。**
   */
  const [issued, setIssued] = useState<IssuedInvitationResult | null>(null);

  const load = useCallback(() => {
    setState({ status: "loading" });
    listAppUsers(appId).then(
      // **招待も一緒に受け取る**(`V19-M3-T01`)—— **着手前はここで招待を捨てていた。**
      (list) => setState({ status: "ready", value: list }),
      (reason: unknown) => setState({ status: "error", errors: toValidationErrors(reason) }),
    );
  }, [appId]);

  useEffect(() => {
    load();
  }, [load]);

  const changeRole = useCallback(
    async (userId: string, role: Role) => {
      setSavingId(userId);
      setRoleError(null);
      try {
        const updated = await setAppUserRole(appId, userId, role);
        setState((previous) =>
          previous.status === "ready"
            ? {
                status: "ready",
                value: {
                  ...previous.value,
                  users: previous.value.users.map((user) => (user.id === userId ? updated : user)),
                },
              }
            : previous,
        );
      } catch (reason: unknown) {
        // 409 は「最後の owner は降格できない」の専用文面。それ以外はサーバの文面を出す。
        setRoleError(
          isLastOwnerConflict(reason)
            ? "最後の管理者は降格できません。"
            : toValidationErrors(reason)
                .map((error) => error.message)
                .join(" / "),
        );
      } finally {
        setSavingId(null);
      }
    },
    [appId],
  );

  /**
   * セレクトの変更を受ける入口。**降格なら送らずに確認待ちへ入れる**(D-M3-3)。
   * セレクトは `value={user.role}` の制御コンポーネントなので、送らなければ再描画で
   * 元の値に戻る = 画面上も「まだ変わっていない」。
   */
  const requestRoleChange = useCallback(
    (user: AppUser, next: Role) => {
      if (next === user.role) {
        return;
      }
      if (isLockoutDemotion(user.role, next)) {
        setRoleError(null);
        setPendingDemotion({ userId: user.id, username: user.username, from: user.role, to: next });
        return;
      }
      void changeRole(user.id, next);
    },
    [changeRole],
  );

  return (
    <Card className={cn("user-admin")} data-testid="user-admin">
      <header
        className={cn("user-admin-header", "flex flex-wrap items-center justify-between gap-s2")}
      >
        <h3 className={cn("m-0")}>ユーザ管理</h3>
        {onClose !== undefined && (
          <Button size="sm" variant="secondary" data-testid="close-user-admin" onClick={onClose}>
            閉じる
          </Button>
        )}
      </header>

      {roleError !== null && (
        <Alert
          variant="destructive"
          className={cn("user-admin-role-error")}
          data-testid="role-error"
        >
          {roleError}
        </Alert>
      )}

      {pendingDemotion !== null && (
        <DemotionWarning
          pending={pendingDemotion}
          onConfirm={() => {
            const target = pendingDemotion;
            setPendingDemotion(null);
            void changeRole(target.userId, target.to);
          }}
          onCancel={() => setPendingDemotion(null)}
          labels={labels}
        />
      )}

      {state.status === "loading" && (
        // **文言は1文字も変えていない。骨組みを3本足しただけである**(V4-M15-T14)。
        <div className={cn("flex flex-col gap-s2")}>
          <p className={cn("m-0", "text-note text-muted-foreground")}>読み込み中…</p>
          {["head", "row-1", "row-2"].map((slot) => (
            <Skeleton key={slot} className="h-8 w-full" />
          ))}
        </div>
      )}
      {state.status === "error" && <ErrorList errors={state.errors} />}
      {state.status === "ready" &&
        (state.value.users.length === 0 ? (
          <p data-testid="user-admin-empty" className={cn("m-0", "text-muted-foreground")}>
            ユーザがいません。
          </p>
        ) : (
          // **表は横に溢れうるので包む**(`D-V4-44`)。**`class` は `<table>` に残す。**
          <TableFrame>
            <Table className={cn("user-admin-table")}>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col" className="px-s2 py-s1">
                    ユーザ名
                  </TableHead>
                  <TableHead scope="col" className="px-s2 py-s1">
                    表示名
                  </TableHead>
                  <TableHead scope="col" className="px-s2 py-s1">
                    ロール
                  </TableHead>
                  {/*
                   * **【`V13-M1-T01` / 台帳 `UM-G1`】利用者IDの列を足した。**
                   * **既存3本の見出しの文言も順序も1バイト変えていない** —— 足したのは
                   * **後ろ(ロールの右)の1本だけ**である(`web/test/user-admin-user-id.test.tsx`
                   * が4本の並びを逐語で固定する)。
                   */}
                  <TableHead scope="col" className="px-s2 py-s1">
                    利用者ID
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.value.users.map((user) => (
                  <TableRow
                    key={user.id}
                    className={cn("user-row")}
                    data-testid="user-row"
                    data-user-id={user.id}
                  >
                    <TableCell data-testid="user-row-username" className="px-s2 py-s1">
                      {user.username}
                    </TableCell>
                    <TableCell className="px-s2 py-s1">{user.displayName ?? ""}</TableCell>
                    <TableCell className="px-s2 py-s1">
                      {/*
                       * **送信中はこのセレクトだけが押せない**(着手前からの挙動)。
                       * **見た目が変わるのは今日からである** —— `:disabled` の宣言を
                       * 持つのは部品側(`form-controls.tsx`)であり、着手前は
                       * `web/src` に `:disabled` が0件だった(`03` §4-1)。
                       */}
                      <Select
                        data-testid="role-select"
                        value={user.role}
                        disabled={savingId === user.id}
                        onChange={(event) => {
                          requestRoleChange(user, event.target.value as Role);
                        }}
                      >
                        {roleOrder(roleIds).map((role) => (
                          <option key={role} value={role}>
                            {labels[role] ?? role}
                          </option>
                        ))}
                      </Select>
                    </TableCell>
                    <TableCell className="px-s2 py-s1">
                      <UserIdCell userId={user.id} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableFrame>
        ))}

      {/*
       * **【`V19-M3-T01` / 台帳 `SV-G2`】発行済みの招待の一覧を足した。**
       * **サーバが招待を載せなかったときは、この節ごと出さない** ——
       * **持ち主でない人の応答では `invitations` がキーごと落ちる。**
       * **空配列(= 読めるが1件も無い)とは別の状態であり、混ぜない。**
       */}
      {state.status === "ready" && state.value.invitations !== undefined && (
        <InvitationList
          appId={appId}
          invitations={state.value.invitations}
          users={state.value.users}
          labels={labels}
          onReissued={(result) => {
            // **出たコードは発行の結果欄に出す**(出どころを2箇所に割らない)。
            setIssued(result);
            load();
          }}
          onRevoked={() => {
            // **取り消したのに前のコードが残っていると、まだ使えるように見える。**
            setIssued(null);
            load();
          }}
        />
      )}

      {/*
       * **【`V19-M3-T00` / 台帳 `SV-G1`】発行の口をこの画面に足した。**
       * **既存4本の列も、その見出しの文言も、行の目印も1バイト変えていない** ——
       * 足したのは**表の後ろ**の1節だけである。
       */}
      <InvitePanel
        appId={appId}
        roleIds={roleIds}
        labels={labels}
        issued={issued}
        setIssued={setIssued}
        onIssued={load}
      />
    </Card>
  );
}

/**
 * **既定で選ばれる立場**(`V19-M3-T00`)。
 *
 * **運営3ロールのうち、できることが最も少ないものを既定にする。**
 * **これは新しい方針ではない** —— **この画面は着手前から「誤クリックの当たり先を既定から
 * 遠ざける」という規律を持っており**(`ROLE_ORDER` の doc)、**同じ規律をここに当てている。**
 * **並びの先頭(最も強い立場)を既定にすると、押し間違いが「運営者を1人増やす」になる。**
 *
 * **【これは防御ではない】** —— **選び直せば強い立場でも発行できる。** **止めているものは無い。**
 */
export function defaultInviteRole(options: readonly Role[]): Role {
  return options.find((role) => role === "viewer") ?? options[options.length - 1] ?? "viewer";
}

/**
 * **招待を発行する節**(`V19-M3-T00`。台帳 `SV-G1`)。
 *
 * ## 作りの4点
 *
 * - **叩く口は着手前から在るものである**(`POST /api/apps/:app_id/auth/invitations`)——
 *   **新しい口を1本も足していない**(個別限定①)。
 * - **行のロール変更セレクトとは別の目印を付けている。** **同じ目印にすると、
 *   `web/test/customer-signup.test.tsx` が**添字**で行を特定しているので、黙って別の行を指す**
 *   (`UserIdCell` の doc が同じ理由で同じ規律を書いている)。
 * - **失敗はサーバの文面をそのまま出す** —— **フロントで作り直さない**(この画面が
 *   着手前から採っている作法。`changeRole` の catch と同じ)。
 * - **登録リンクはサーバが載せたときだけ出す。** **サーバは期待 origin から組み立てられない
 *   ときキーごと落とす** —— **画面の側でリンクを発明すると、黙って壊れたリンクを配ることになる。**
 *
 * ## 【正直に書く】ここで担保していないこと
 *
 * - **発行できる人の範囲を、この節は1ミリも決めていない。** **決めるのはサーバの
 *   `requireOwner` である。** **【禁止】「画面に出さないこと」を制限の担保にしない。**
 * - **同じ相手に2度発行すると、サーバは行を差し替える**(主キーが相手の名前1列)——
 *   **前の状態は消える。** **この節はそれを見せも止めもしない**(`V19-M3-T02` の射程)。
 * - **出したコードを画面から消す仕掛けは1つも無い**(`V19-M3-T04` = `SV-G7b` の射程)。
 */
function InvitePanel({
  appId,
  roleIds,
  labels,
  onIssued,
  issued,
  setIssued,
}: {
  appId: string;
  roleIds: readonly string[];
  /** **ロール → 表示名。** 行のセレクトと同じものを使う(2箇所で別の名前を出さない)。 */
  labels: Record<string, string>;
  /**
   * **発行に成功したら呼ぶ**(`V19-M3-T01`)。
   *
   * **一覧を取り直すためである** —— **これが無いと、発行した直後の画面は
   * 「発行したのに一覧に出ていない」状態になる**(手元の一覧が古いまま残る)。
   * **失敗したときは呼ばない。**
   */
  onIssued?: () => void;
  /**
   * **発行 / 出し直しで受け取った招待**(`V19-M3-T02`)。
   *
   * **【2026-09-18。`V19-M3-T02`】この2本は着手前この節の中の `useState` だった。**
   * **旧(逐語)**: `const [issued, setIssued] = useState<IssuedInvitationResult | null>(null);`
   * **親へ持ち上げたのは、一覧の行から撃つ出し直しも同じ欄に結果を出すためである。**
   * **この節が出す中身も、出す条件も、1バイトも変わっていない。**
   */
  issued: IssuedInvitationResult | null;
  setIssued: (result: IssuedInvitationResult | null) => void;
}) {
  const options = roleOrder(roleIds);
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<Role>(() => defaultInviteRole(options));
  const [issuing, setIssuing] = useState(false);
  const [errors, setErrors] = useState<ValidationError[] | null>(null);

  const submit = useCallback(async () => {
    setIssuing(true);
    setErrors(null);
    try {
      setIssued(await issueInvitation(appId, username, role));
      // **成功したときだけ一覧を取り直す**(`V19-M3-T01`)。
      onIssued?.();
    } catch (reason: unknown) {
      // **失敗したのだから、前の結果を画面に残さない** —— 残すと「今の操作が通った」に見える。
      setIssued(null);
      setErrors(toValidationErrors(reason));
    } finally {
      setIssuing(false);
    }
    // **【2026-09-18。`V19-M3-T02`】`setIssued` を1つ足した。**
    // **旧(逐語)**: `}, [appId, username, role, onIssued]);`
    // **親から受け取る値になったので、依存に挙げないと `biome` が
    // `useExhaustiveDependencies` で赤くする。** **挙動は1ミリも変わらない**
    // (渡ってくるのは `useState` の setter であり、描画のたびに変わらない)。
  }, [appId, username, role, onIssued, setIssued]);

  return (
    <section
      className={cn("user-admin-invite", "flex flex-col gap-s2")}
      data-testid="user-admin-invite"
    >
      <h4 className={cn("m-0")}>招待を発行する</h4>
      <p className={cn("m-0", "text-note text-muted-foreground")}>
        まだ登録していない相手に、登録のときに使う招待コードを発行します。有効期限は発行から24時間で、1件ごとには変えられません。
      </p>

      {/*
       * **ラベルと入力欄は `htmlFor` / `id` の対で結ぶ**(`LoginPage` と同じ作法)——
       * **`Label` は `htmlFor` を型で必須にしているので、結ばれないラベルを作れない。**
       */}
      <div className={cn("flex flex-col gap-s1")}>
        <Label htmlFor="invite-username-field">招く相手のログイン名</Label>
        <Input
          id="invite-username-field"
          data-testid="invite-username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
      </div>

      <div className={cn("flex flex-col gap-s1")}>
        <Label htmlFor="invite-role-field">立場</Label>
        <Select
          id="invite-role-field"
          data-testid="invite-role"
          value={role}
          onChange={(event) => setRole(event.target.value as Role)}
        >
          {options.map((candidate) => (
            <option key={candidate} value={candidate}>
              {labels[candidate] ?? candidate}
            </option>
          ))}
        </Select>
      </div>

      <div>
        <Button
          data-testid="invite-submit"
          disabled={issuing}
          onClick={() => {
            void submit();
          }}
        >
          発行する
        </Button>
      </div>

      {errors !== null && (
        <div data-testid="invite-error">
          <ErrorList errors={errors} />
        </div>
      )}

      {issued !== null && (
        <div className={cn("invite-result", "flex flex-col gap-s1")} data-testid="invite-result">
          <p className={cn("m-0", "text-note")}>「{issued.invitation.username}」への招待コード</p>
          <code data-testid="invite-code">{issued.invitation.code}</code>
          {issued.signupUrl !== undefined && (
            <>
              <p className={cn("m-0", "text-note text-muted-foreground")}>登録リンク</p>
              <a data-testid="invite-signup-url" href={issued.signupUrl}>
                {issued.signupUrl}
              </a>
            </>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * **招待の状態の表示名**(`V19-M3-T01`。台帳 `SV-G2`)。
 *
 * **3値を導出するのはサーバの1関数だけである**(`src/auth/invitations.ts` の
 * `invitationState`)—— **画面は受け取った値を引き当てるだけである。**
 *
 * **【禁止の履行】使用の時刻(`usedAt`)の有無から状態を組み立てない** ——
 * **取り消しも使用と同じ列に入るので、時刻から導くと2つが同じ表示になる。**
 * **この画面は `usedAt` を1列も描いていない。**
 *
 * **受けるのは `Record<string, string>` である** —— **知らない値が来たら、その値を
 * そのまま出す**(黙って別の状態に化けさせない)。
 */
const INVITATION_STATE_LABELS: Record<string, string> = {
  unused: "未使用",
  used: "使用済み",
  revoked: "取り消し済み",
};

/**
 * **発行済みの招待の一覧**(`V19-M3-T01`。台帳 `SV-G2`)。
 *
 * ## 作りの5点
 *
 * - **新しい HTTP の口を1本も足していない**(個別限定①)—— **並べるのは一覧の口
 *   (`GET /auth/users`)が**着手前から**返していた値である。** **捨てていたのは
 *   `web/src/api.ts` の受け皿のほうだった。** **サーバを1バイトも直していない。**
 * - **コードの列を1本も持たない**(個別限定②)—— **サーバが一覧の応答にコードを
 *   1バイトも載せていないのに加えて、画面の側にも出す口を作らない。**
 * - **使用済み・取り消し済みを1件も落とさない**(`ADR-0336` 限定16 / 個別限定③)——
 *   **絞り込みも「未使用だけ」の既定も持たない。** **受け取った順にそのまま並べる。**
 * - **状態はサーバの `state` を読む**({@link INVITATION_STATE_LABELS})。
 * - **期限はサーバが返した値をそのまま出す** —— **画面で組み直さない**(表示のために
 *   時刻を作り替えると、どの時間帯で読んだかによって別の値が出る)。
 *
 * ## 【正直に書く】ここで担保していないこと
 *
 * - **誰がこの一覧を読めるかを、この節は1ミリも決めていない。** **決めるのはサーバで
 *   あり、持ち主でなければ `invitations` はキーごと落ちる。**
 *   **【禁止】「画面に出さないこと」を制限の担保にしない。**
 * - **期限が切れた行がいつ消えるかは、この節は1つも示していない** —— **掃除が走るのは
 *   招待を発行したときだけである**(サーバの `purgeExpiredInvitations`)。
 * - **出し直し / 取り消しの操作は1つも持たない**(`V19-M3-T02` / `T03` の射程)。
 *
 * =====================================================================================
 * **【2026-09-18。`V19-M3-T02`。台帳 `SV-G3` / `SV-G4`。直前の1行は着手前の逐語であり
 *   1バイトも消していない —— 今日この節は2つの操作を持つ】**
 * =====================================================================================
 *
 * - **叩く口は着手前から在る1本だけである**(`POST /api/apps/:app_id/auth/invitations`)——
 *   **出し直しは `{ username, role }` の再送、取り消しは同じ口への `{ username, revoke: true }`。**
 *   **`DELETE` のルートを1本も足していない。** **行を1行も消さない。**
 * - **立場を選び直させない** —— **出し直しは、その行が今持っている `role` をそのまま送る。**
 *   **選ばせる形にすると `role-select` が行の数だけ増え、`web/test/customer-signup.test.tsx`
 *   が**添字**で指している行が黙ってずれる**(`UserIdCell` と `InvitePanel` が同じ理由で
 *   同じ規律を書いている)。
 * - **列を1本も足していない。** **2つのボタンは「状態」の欄に同居する** ——
 *   **同じ形の先例がこのファイルの中に在る**(`UserIdCell`: 値の `<span>` と `Button` が
 *   1つのセルに同居し、検査は `<span>` の文字列を読む)。
 *
 * ## 【正直に書く】この2つのボタンが持ち込む嘘と、持ち込まない嘘
 *
 * - **【持ち込まない】取り消しは「未使用」の行にだけ出す**(`H-V19-5`)——
 *   **使用済み / 取り消し済みの招待に取り消しを掛けると、サーバは `200` を返すのに
 *   何も書かない。** **押せるようにすると、画面が「取り消した」と見せて嘘をつく。**
 *   **サーバ側の穴は1バイトも塞いでいない**(塞ぐ段は v19 の中に1本も無い。計画 `§9-B-6`)。
 *   **【禁止の履行】行そのものは1行も隠していない**(`ADR-0336` 限定16)——
 *   **隠すのはボタンだけである。**
 * - **【持ち込む。塞がない】出し直すと、前の状態が消える**(罠23 / `H-V19-1`)——
 *   **取り消し済みの行から出し直すと `used_at` が `null` に戻り、表示が「未使用」に戻る。**
 *   **「取り消した」という事実は、どこにも残らない。** **この節はそれを見せも止めもしない。**
 *   **`web/e2e/invitation-actions.e2e.ts` が、塞がずにそのまま撃って示す。**
 * - **使用済みの行には出し直しを出さない** —— **その相手は既に登録を済ませており、
 *   出し直すと「登録済みなのに未使用と出る行」と「誰も使えないコード」ができる。**
 *   **これは防御ではない** —— **HTTP の口は今日もそれを受理する。** **止めていない。**
 * - **押し間違いを止める確認は1つも無い。** **取り消すは押した瞬間に送る。**
 *   **戻す手段は出し直しだが、戻すと上の1点(取り消した事実が消える)を踏む。**
 */
function InvitationList({
  appId,
  invitations,
  users,
  labels,
  onReissued,
  onRevoked,
}: {
  appId: string;
  invitations: readonly AppInvitation[];
  /** **発行者の欄を引くためだけに使う**(同じ応答で受け取った相手の一覧)。 */
  users: readonly AppUser[];
  /** **ロール → 表示名。** 行のセレクトと同じものを使う(2箇所で別の名前を出さない)。 */
  labels: Record<string, string>;
  /** **出し直しに成功したら呼ぶ。** 受け取った招待(コードを持つ)をそのまま親へ渡す。 */
  onReissued: (result: IssuedInvitationResult) => void;
  /** **取り消しに成功したら呼ぶ。** **応答本文を1バイトも渡さない**(コードが載らない)。 */
  onRevoked: () => void;
}) {
  /** **出し直し / 取り消しの失敗文面。** **サーバの文面をそのまま出す**(作り直さない)。 */
  const [actionError, setActionError] = useState<ValidationError[] | null>(null);
  /** **送信中の相手。** その行の2つのボタンだけを一時的に押せなくする。 */
  const [busy, setBusy] = useState<string | null>(null);

  const reissue = useCallback(
    async (invitation: AppInvitation) => {
      setBusy(invitation.username);
      setActionError(null);
      try {
        // **発行とまったく同じ呼び出しである** —— **出し直し専用の関数も口も作っていない。**
        onReissued(await issueInvitation(appId, invitation.username, invitation.role));
      } catch (reason: unknown) {
        setActionError(toValidationErrors(reason));
      } finally {
        setBusy(null);
      }
    },
    [appId, onReissued],
  );

  const revoke = useCallback(
    async (invitation: AppInvitation) => {
      setBusy(invitation.username);
      setActionError(null);
      try {
        await revokeInvitation(appId, invitation.username);
        onRevoked();
      } catch (reason: unknown) {
        setActionError(toValidationErrors(reason));
      } finally {
        setBusy(null);
      }
    },
    [appId, onRevoked],
  );

  return (
    <section
      className={cn("user-admin-invitations", "flex flex-col gap-s2")}
      data-testid="user-admin-invitations"
    >
      <h4 className={cn("m-0")}>発行済みの招待</h4>
      {/*
       * **出し直し / 取り消しの失敗**(`V19-M3-T02`)。**節に1つだけ置く。**
       * **形は `invite-error` と同じで、出すのはサーバが返した文面そのままである。**
       */}
      {actionError !== null && (
        <div data-testid="invitation-action-error">
          <ErrorList errors={actionError} />
        </div>
      )}
      {invitations.length === 0 ? (
        <p
          data-testid="user-admin-invitations-empty"
          className={cn("m-0", "text-muted-foreground")}
        >
          発行済みの招待はありません。
        </p>
      ) : (
        // **表は横に溢れうるので包む**(利用者の表と同じ作法。`D-V4-44`)。
        <TableFrame>
          <Table className={cn("user-admin-invitations-table")}>
            <TableHeader>
              <TableRow>
                <TableHead scope="col" className="px-s2 py-s1">
                  相手
                </TableHead>
                <TableHead scope="col" className="px-s2 py-s1">
                  立場
                </TableHead>
                <TableHead scope="col" className="px-s2 py-s1">
                  期限
                </TableHead>
                <TableHead scope="col" className="px-s2 py-s1">
                  発行者
                </TableHead>
                <TableHead scope="col" className="px-s2 py-s1">
                  状態
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invitations.map((invitation) => (
                // **主キーは相手の名前1列である**(同じ相手の行は1つしか無い)。
                <TableRow
                  key={invitation.username}
                  className={cn("invitation-row")}
                  data-testid="invitation-row"
                  data-username={invitation.username}
                >
                  <TableCell data-testid="invitation-row-username" className="px-s2 py-s1">
                    {invitation.username}
                  </TableCell>
                  <TableCell data-testid="invitation-row-role" className="px-s2 py-s1">
                    {labels[invitation.role] ?? invitation.role}
                  </TableCell>
                  <TableCell data-testid="invitation-row-expires" className="px-s2 py-s1">
                    {invitation.expiresAt}
                  </TableCell>
                  <TableCell data-testid="invitation-row-issuer" className="px-s2 py-s1">
                    {/*
                     * **手元の一覧に居る人なら、その人の名前で出す。**
                     * **居なければ受け取った値をそのまま出す** —— **名前を発明しない**
                     * (発行した人が既に退会していることがある)。
                     */}
                    {users.find((user) => user.id === invitation.issuedBy)?.username ??
                      invitation.issuedBy}
                  </TableCell>
                  {/*
                   * **【2026-09-18。`V19-M3-T02`】このセルに2つのボタンを同居させた。**
                   * **旧(逐語)**:
                   *
                   *     <TableCell data-testid="invitation-row-state" className="px-s2 py-s1">
                   *       {INVITATION_STATE_LABELS[invitation.state] ?? invitation.state}
                   *     </TableCell>
                   *
                   * **`data-testid` はセルから `<span>` へ移した** —— **状態の文字列を読む
                   * 既存の検査(`web/test/invitation-list-panel.test.tsx` の `(2-a)`〜`(2-d)`、
                   * `web/e2e/invitation-list.e2e.ts`、`web/e2e/invitation-states.e2e.ts`)が
                   * ボタンの文字を巻き込まないようにするためである。**
                   * **同じ形の先例が `UserIdCell` である**(値の `<span>` と `Button` の同居)。
                   */}
                  <TableCell className="px-s2 py-s1">
                    <div className={cn("flex flex-wrap items-center gap-s1")}>
                      <span data-testid="invitation-row-state">
                        {INVITATION_STATE_LABELS[invitation.state] ?? invitation.state}
                      </span>
                      {/* **使用済みには出さない**(登録済みの相手に使えないコードを配らない)。 */}
                      {invitation.state !== "used" && (
                        <Button
                          size="sm"
                          variant="secondary"
                          data-testid="invitation-row-reissue"
                          disabled={busy === invitation.username}
                          onClick={() => {
                            void reissue(invitation);
                          }}
                        >
                          出し直す
                        </Button>
                      )}
                      {/* **未使用にだけ出す**(`H-V19-5` を踏まない。行は隠していない)。 */}
                      {invitation.state === "unused" && (
                        <Button
                          size="sm"
                          variant="secondary"
                          data-testid="invitation-row-revoke"
                          disabled={busy === invitation.username}
                          onClick={() => {
                            void revoke(invitation);
                          }}
                        >
                          取り消す
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableFrame>
      )}
    </section>
  );
}

/**
 * **利用者IDのセル**(`V13-M1-T01` / 台帳 `UM-G1`)。
 *
 * ## なぜ足したか
 *
 * **説明書は着手前から「画面なら利用者管理の一覧。そこに出る `id` が利用者IDである」と
 * 書いていたが、その `id` は `<tr data-user-id>` の属性に入っているだけで、画面には
 * 1文字も出ていなかった** —— **利用者は開発者ツールを開かないと自分のIDを読めなかった。**
 * **この工程がその記述を真に戻す。**
 *
 * ## 作りの2点
 *
 * - **`data-testid="user-row-user-id"` を持つのは値そのものだけである**(ボタンの文言や
 *   結果の文言を含まない)。**API の返した `id` と逐語一致させるためであり、
 *   `web/test/user-admin-user-id.test.tsx` がその一致を機械的に固定する。**
 * - **コピーの形は発明していない** —— `RequirementsDocPanel` の `CopyMarkdownButton` /
 *   `ThemeExportPanel` の `CopyThemeCssButton` / `ListViewRenderer` の CSV コピーと
 *   **同一の形**である(`navigator.clipboard as Clipboard | undefined` を取り、
 *   `undefined` なら失敗として出す)。**クリップボードは環境によって使えない
 *   (非セキュアコンテキストなど)ので、使えなかったことを黙って隠さない**(憲法6)。
 *
 * ## 【正直に書く】ここで担保していないこと
 *
 * - **`data-testid="role-select"` を1つも増やしていない** ——
 *   `web/test/customer-signup.test.tsx` が `getAllByTestId("role-select")` の**添字**で
 *   行を特定しており、増やすと黙って別の行を指すからである。**この規律を守っていることの
 *   見張りは検査側に置いた**(個数 = 人数)が、**「将来この画面に `role-select` を足さない」
 *   ことを構造で禁じてはいない。**
 * - **`data-user-id` 属性は残してある**(`web/e2e/authz.e2e.ts` /
 *   `web/e2e/customer-signup.e2e.ts` が行の同定に使っている)。
 * - **「コピーできた」ことの実証はしていない** —— 検査が見ているのは `writeText` に
 *   渡った引数までであり、OS のクリップボードの中身は1バイトも読んでいない。
 */
function UserIdCell({ userId }: { userId: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);

  return (
    <div className={cn("flex flex-wrap items-center gap-s1")}>
      <span data-testid="user-row-user-id" className={cn("text-note")}>
        {userId}
      </span>
      <Button
        size="sm"
        variant="secondary"
        data-testid="user-row-copy-id"
        onClick={() => {
          // クリップボードは環境によって使えない(非セキュアコンテキストなど)。
          // 使えなかったことを黙って隠さず、失敗として出す(憲法6)。形は
          // `ThemeExportPanel` の `CopyThemeCssButton` と同一である。
          const clipboard = navigator.clipboard as Clipboard | undefined;
          if (clipboard === undefined) {
            setCopied(false);
            return;
          }
          void clipboard.writeText(userId).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
      >
        コピー
      </Button>
      {copied !== null && (
        <span
          className={cn("text-note text-muted-foreground")}
          data-testid="user-row-copy-id-result"
        >
          {copied ? "コピーしました。" : "コピーできませんでした。"}
        </span>
      )}
    </div>
  );
}

/**
 * 降格の確認(V3-M3-T03 / ユーザ決定 D-M3-3)。
 *
 * **出しているのは警告と確認だけである。****構造では禁じていない** —— 「変更する」を押せば
 * `PATCH /auth/users/:id` はそのまま飛び、サーバは受理する(ロール検証 `ROLE_VALUES` は
 * customer を許す)。**構造で止まるのは「最後の owner の降格」= サーバの 409 だけ**であり、
 * それは本コンポーネントの外(`changeRole` の catch)がそのまま扱う。
 *
 * owner を落とす場合だけ一文を足す —— **顧客経路は owner をブートストラップしない**
 * (`CUSTOMER_SIGNUP.healOwner = false`)ので、owner が居なくなると誰もこの画面を
 * 開けなくなりうるためである(サーバの 409 が最後の1人は守るが、2人居るうちの1人を
 * customer にしてからもう1人を、という手順は止まらない)。
 */
function DemotionWarning({
  pending,
  onConfirm,
  onCancel,
  labels,
}: {
  pending: PendingDemotion;
  onConfirm: () => void;
  onCancel: () => void;
  /** **ロール → 表示名**(`V5-M17-T08`。宣言された種類の表示名もここから引く)。 */
  labels: Record<string, string>;
}) {
  return (
    // **【V4-M15-T14】器を `Alert variant="destructive"` にした。**
    // **重ねて出していない** —— 着手前と同じく文書の流れの中に出る(`ADR-0087` 限定8)。
    // **`role="alert"` は `Alert` が持ち、`data-from` / `data-to` はそのままである。**
    <Alert
      variant="destructive"
      className={cn("role-demotion-warning")}
      data-testid="role-demotion-warning"
      data-from={pending.from}
      data-to={pending.to}
    >
      <p className={cn("m-0")}>
        「{pending.username}」を{labels[pending.from] ?? pending.from}から
        {labels[pending.to] ?? pending.to}
        に変更します。{labels[pending.to] ?? pending.to}
        になると<strong>運営の画面とデータから締め出されます</strong>
        —— ユーザ管理も接続の管理も開けなくなり、見えるのは自分の行だけになります。
        {pending.from === "owner" &&
          "オーナーを減らすと、この画面を開ける人が居なくなることがあります(顧客として登録し直しても、オーナーには戻れません)。"}
        戻せるのは、残っているオーナーだけです。
      </p>
      <div className={cn("role-demotion-actions", "flex flex-col gap-s2 sm:flex-row")}>
        <Button
          variant="destructive"
          className="w-full sm:w-auto"
          data-testid="confirm-role-demotion"
          onClick={onConfirm}
        >
          それでも{labels[pending.to] ?? pending.to}に変更する
        </Button>
        <Button
          variant="secondary"
          className="w-full sm:w-auto"
          data-testid="cancel-role-demotion"
          onClick={onCancel}
        >
          やめる
        </Button>
      </div>
    </Alert>
  );
}
