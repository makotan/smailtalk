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
  type AppUser,
  isLastOwnerConflict,
  listAppUsers,
  type Role,
  setAppUserRole,
} from "../api.ts";
import { type AsyncState, toValidationErrors } from "../async.ts";
import { ErrorList } from "../ErrorList.tsx";
import { Button } from "../ui/button.tsx";
import { Select } from "../ui/form-controls.tsx";
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
  const [state, setState] = useState<AsyncState<AppUser[]>>({ status: "loading" });
  /** ロール変更の失敗文面(409 やその他)。成功でクリアする。 */
  const [roleError, setRoleError] = useState<string | null>(null);
  /** 変更を送信中のユーザID(その行のセレクトを一時的に無効化する)。 */
  const [savingId, setSavingId] = useState<string | null>(null);
  /** 確認待ちの降格(D-M3-3)。`null` のあいだは警告を出さない。 */
  const [pendingDemotion, setPendingDemotion] = useState<PendingDemotion | null>(null);

  const load = useCallback(() => {
    setState({ status: "loading" });
    listAppUsers(appId).then(
      (users) => setState({ status: "ready", value: users }),
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
                value: previous.value.map((user) => (user.id === userId ? updated : user)),
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
        (state.value.length === 0 ? (
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
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.value.map((user) => (
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
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableFrame>
        ))}
    </Card>
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
