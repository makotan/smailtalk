/**
 * 現在ユーザの per-app ロールを、書込 UI を持つ深い階層(views/*)まで運ぶための
 * 最小コンテキスト(V1-M3-T02 / ADR-0015)。
 *
 * ロールは `AppWorkspace` の認証ゲートでしか分からないが、書込ボタン(form の保存 /
 * detail の編集・削除)は `ViewHost` の下の各レンダラにある。`ViewHost` / `ViewBody` は
 * マニフェストを解釈するだけの純粋なディスパッチ層で、ロールという表示に無関係な関心事を
 * props で通すと**その2層に権限の知識が漏れる**。そこで prop ドリリングではなく
 * コンテキストで運ぶ(これはビューの描画に効く「表示状態」ではなく、利用者の権限=横断関心)。
 *
 * **~~provider の外(既定)では `role = null` = 書込可~~**(**2026-08-03 に反転した。下記**)。
 * UI の先回りガードはあくまで補助であり、**最終防衛線はサーバの 403**(viewer の書込を
 * 必ず弾く)である。
 *
 * ## 【V4-M2-T06 の改訂】**provider の外(`role === null`)は書込不可に反転した**
 *
 * **`ADR-0074`(`B-G5` の門A本審査 = 限定採用)限定6 の逐語**:
 * 「**`canWriteRole(null, table)` が `false` を返す。**」
 *
 * **理由**: **未ログインでも見られる画面が入ったので、`RoleProvider` が包んでいない
 * subtree に `null` が流れる経路が実際にできた**(審査記録
 * `docs/plan/v4/records/v4-m2-gate-a-anonymous-view.md` §3 の S3-2a)。
 * **旧既定のままだと、匿名に保存・編集・削除ボタンが出る。**
 *
 * **旧既定の理由(「各レンダラを単体で描く既存テストの挙動を変えないため」)は消えていない**
 * —— **その代償は払った**: `web/test/form.test.tsx` / `web/test/detail-view.test.tsx` が
 * レンダラを単体で描くときに `RoleProvider role="owner"` で包む形へ直した(**書込の流れを
 * 測るテストなので、書ける立場を明示する側が本来の意図に近い**)。
 * **【誇張しない】これは遮断ではない。** **匿名の書込を止めているのは今日もサーバである**
 * (未認証の POST / PATCH / DELETE は 401。`ADR-0034` 限定2 の構造保証)。
 *
 * ## 【V3-M3-T04 の追記】customer は「ロールだけ」では決まらない(D-G12b。ユーザ決定 D-M3-1 =「隠す」)
 *
 * 既存3ロール(owner / editor / viewer)は**ロールだけ**で可否が決まるが、**customer は
 * テーブル単位で分かれる**(ADR-0033 限定4/5)。その判定はサーバの純関数
 * `nonAdminTableAccess`(`src/server/owner-scope.ts:116`)1本にあり、**ここは同じ規約を
 * 再実装せず、その関数を import して使う**(V3-M3 の門A本審査が採った案(i))。
 * `web/src/navigation.tsx:99`〜`:100` が「同じ `.find()` が2箇所にあると規約を変えたときに
 * 片方だけが変わる」として名指しで禁じた形を、ここでも作らない。
 *
 * **`src/server/` の値を web が import するのは、これが最初の例である**(V3-M0 の実測: 前例0件)。
 * ADR-0006 §6 は「フロントが値として触ってよいのは `src/shared/*` だけ」と書いているが、
 * その理由は **`src/kernel/*` を辿ると `bun:sqlite` が推移的に入って `vite build` が壊れる**
 * ことである。`owner-scope.ts` の import は **`import type` の1行だけ**(`src/kernel/index.ts`
 * の型)なので実行時依存は0本で、その理由は当たらない。**`bun run build:web` が通ることを
 * V3-M3-T04 が実測した。**
 *
 * ## ~~既定(provider 外 = `role === null`)は据え置く~~ —— **書込については 2026-08-03 に覆した**
 *
 * **V3-M3-T04 の決定(判定時点の記述。1文字も書き換えない)**: 「テーブルを引数に取れる
 * ようにしたので『テーブルが分からないときどうするか』を決め直す必要があった。**決定:
 * `role === null`(provider 外)は今までどおり『読める・書ける』に倒す。** 変えると各
 * レンダラを単体で描く既存テストの前提が動き、UI の先回りガードが『最終防衛線』に見えて
 * しまう。**例外は customer だけである** —— ロールが customer だと分かっていてテーブルが
 * 分からないときは fail-closed(不可)に倒す。」
 *
 * **今日の状態(2026-08-03 / V4-M2-T06 / `ADR-0074` 限定6)**:
 *
 * - **書込(`canWriteRole`)は `role === null` で `false` に倒れる**(上の改訂節)。
 *   **覆したのはこの1点だけである。**
 * - **読取(`canReadTableRole`)は今日も「読める」に倒れる。1バイトも変えていない。**
 *   **匿名の画面一覧をこれで決めていない** —— 匿名は `isViewAnonymousVisible` という
 *   別の述語で決まる(`canUseView` の分岐)。**混ぜると、宣言を1つも書いていない既存アプリが
 *   未ログインに全画面を晒す**(審査記録 §3 の S3-2a が名指しした穴)。
 * - **customer の fail-closed も1バイトも変えていない。**
 */
import { createContext, type ReactNode, useContext } from "react";
// **【`V8-M27-T04` / `T-G5`】`isReservedRole` の import は撤去した。**
// **旧(逐語)**: `import { DEFAULT_USER_KIND, isReservedRole, type ReservedRole } from "../../../src/auth/types.ts";`
import { DEFAULT_USER_KIND, type ReservedRole } from "../../../src/auth/types.ts";
import type { Manifest, Table, View } from "../../../src/kernel/types.ts";
// 顧客のテーブル単位の可否は**サーバの判定1本**を使う(案(i))。ここに再実装しないこと。
import {
  ANONYMOUS_AUDIENCE,
  // **【`V8-M29` 第1波 / `D-V8-79`】役割の表示名も**サーバと同じ述語1本**を使う。
  // **`user_kinds` 側(すぐ下)の import は1バイトも消していない** —— **撤去は次の波である。**
  // **【2026-08-11。`V8-M29` 第2波 / 台帳 `T-G9a`。上の1行は第1波の逐語であり消していない】**
  // **旧(逐語)**: この直後に `declaredUserKinds,` と `effectiveUserKindIds,` の2名が在った。
  // **どちらも `src/server/owner-scope.ts` から消えたので、import からも落とした。**
  declaredRoleIds,
  declaredRoleKinds,
  isOwnerVisible,
  // **【`V8-M22` / `J-G38`】面の**ボタンの規則**が立てた「表 × 書込の種類」の壁も、
  // **サーバと同じ述語1本**を使う(`src/server/app.ts:3947` / `:4164` が呼んでいるのと
  // **同じ関数**)。**表示層に壁を再実装しない。**
  isRoleActionWriteAllowed,
  // **【`V8-M17` / `J-G8` / `V8-M20`】役割に束ねた権限(面)の判定は**サーバと同じ述語1本**を
  // 使う。**表示層に判定を再実装しない**(`J-G38` の門外判定が拠っている形である)。
  // **`V8-M20` が `isViewAnonymousVisible` / `isViewAudienceAllowed` / `viewAudience` の
  // 3本の import を落とした** —— **画面の「見せる相手」(`view.audience`)を撤去したため。**
  judgeRoleAccess,
  // **【`V8-M27-T04` / `T-G5`】`nonAdminTableAccess` の import は撤去した**(関数ごと消えた)。
  OWNER_FIELD,
  personalOwnerField,
  type RoleActionWriteKind,
  // **【`V8-M26-T03b`】「規則がその対象を名指ししているか」だけを見る述語。**
  // **既定が閉じた今日、`judgeRoleAccess(...).governed` は「管轄内か」であって
  // 「宣言が実在するか」ではない** —— **名乗り(`?view=`)を決めるのは後者である。**
  roleRulesNameTarget,
  type UserKind,
} from "../../../src/server/owner-scope.ts";
import type { Role } from "../api.ts";
import { resolveViewTable } from "../table-resolution.ts";

/**
 * **「ロールを持たない者」を指す値**(`B-G5` / `V4-M2-T05` / `ADR-0074` 限定1)。
 *
 * **これはロールではない。** **`Role` 型は今日も4値であり、`ROLE_LABELS` も4値である**
 * (`ADR-0074` §3a-5 = 5ロール目にする提案は `ADR-0033` §3a-1 の門に当たる)。
 * **`src/server/owner-scope.ts` の値をそのまま再輸出する** —— **判定の値を2箇所に書かない。**
 */
export const ANONYMOUS = ANONYMOUS_AUDIENCE;

/**
 * **アプリが宣言した利用者の種類**(`V5-M17-T03` / `ADR-0158`)。
 * **`src/server/owner-scope.ts` の述語をそのまま再輸出する** —— **宣言の読み方を2箇所に書かない。**
 */
/** **運営の予約ロールか**(`V5-M17-T05` / `ADR-0158` 限定1)。**非運営の判定はこの否定1本である。** */
// **【`V8-M27-T04` / `T-G5`】`isReservedRole` の再輸出は撤去した。**
// **旧(逐語)**: `export { declaredUserKinds, effectiveUserKindIds, isReservedRole, type UserKind };`
// **このファイルの3箇所(`canWriteRole` / `isWriteAudienceRole` / `canReadTableRole`)が
// 使っていた述語であり、再輸出はその3箇所の巻き添えである。**
// **`web/` の他のファイルはこの再輸出を1件も使っていなかった**
// (`AppWorkspace.tsx` / `ListViewRenderer.tsx` はこの再輸出経由で読んでいたので、
// そちらは同じタスクで一緒に消した)。
// **【`V8-M29` 第1波】`declaredRoleKinds` を1名足した**(`user_kinds` 側は1つも消していない)。
// **【`V8-M29` 第2波。上の1行は第1波の逐語であり消していない】旧(逐語)**:
//     export { declaredRoleKinds, declaredUserKinds, effectiveUserKindIds, type UserKind };
// **`declaredUserKinds` / `effectiveUserKindIds` の2名を落とした**(元が消えたため)。
// **【`V8-M29` 第2波】`declaredRoleIds` を1名足した** —— **利用者管理の選択肢の出所である**
// (`web/src/AppWorkspace.tsx` が `UserAdmin` の `roleIds` に渡す)。
export { declaredRoleIds, declaredRoleKinds, type UserKind };

/**
 * **画面を見る相手**。ロール4値 + 匿名。**`Role` を拡張していない。**
 *
 * **`null` はこれと別の意味である** —— **「誰として見ているか分からない」**(provider 外)。
 * **匿名を `null` で表さない** —— 表すと「認証を経ていない」と「判定材料が無い」が
 * 区別できなくなる(審査記録 §3 の S3-2a が名指しした穴)。
 */
export type ViewAudienceActor = Role | typeof ANONYMOUS;

const RoleContext = createContext<Role | null>(null);

/**
 * 現在ユーザの id を運ぶコンテキスト(`E-G53` / V4-M6)。**既定は `null` = 「誰として見て
 * いるか分からない」** で、そのときは判定を据え置く(このファイルの既定の向きと同じ)。
 *
 * **ロールと別に持つ理由**: `st_owner`(誰の行か)の判定には**ロールではなく id** が要る。
 * **props では降ろさない**(`ADR-0053` 限定3 =「導線とロールは props に流さない。コンテキスト
 * で運ぶ」)—— **`ViewRendererProps` に1つも足していない。**
 */
const ActorContext = createContext<string | null>(null);

/**
 * 現在ユーザのロール(と、渡されていれば id)を配下に供給する。
 * `AppWorkspace` の認証済み subtree を包む。
 *
 * **`actorId` は任意である** —— 渡さない既存の呼び出し(各レンダラを単体で描くテスト)の
 * 挙動を1ミリも変えない。
 */
export function RoleProvider({
  role,
  actorId,
  children,
}: {
  role: Role;
  actorId?: string | undefined;
  children: ReactNode;
}) {
  return (
    <RoleContext.Provider value={role}>
      <ActorContext.Provider value={actorId ?? null}>{children}</ActorContext.Provider>
    </RoleContext.Provider>
  );
}

/** 現在ユーザのロール(provider 外は `null`)。 */
export function useRole(): Role | null {
  return useContext(RoleContext);
}

/** 現在ユーザの id(渡されていなければ `null`)。 */
export function useActorId(): string | null {
  return useContext(ActorContext);
}

/**
 * **その行を書き換えられる立場にあるか**(`E-G53` / V4-M6)。**ロールの上に重ねる判定である。**
 *
 * **`canWriteRole` が true でも、他人の個人行(`st_owner` が自分でも共有でもない行)は
 * 書けない** —— サーバがそう作られているからである(`ADR-0016` の2軸直交。`ADR-0061` が
 * 開いたのは**読取2経路だけ**で、**書込は1ミリも開いていない**)。**着手前の UI はこれを
 * 見ておらず、運営の注文詳細に「押せば必ず 404 になる削除ボタン」が出ていた**(02 §5-9)。
 *
 * **規約を再実装していない** —— 判定は `src/server/owner-scope.ts` の `personalOwnerField` /
 * `isOwnerVisible` をそのまま呼ぶ(`nonAdminTableAccess` と同じ形。`navigation.tsx:99` が
 * 名指しで禁じた「同じ判定が2箇所」を作らない)。
 *
 * **据え置く条件(fail-open にする側)を明示する**:
 * - **`actorId` が分からない**(provider 外 / 渡していない)…… 判定材料が無いので今までどおり。
 * - **テーブルや行が分からない** …… 同上。
 * - **個人所有テーブルでない** …… `st_owner` の話ではないので今までどおり。
 *
 * **これは遮断ではない。** 最終防衛線は今日もサーバであり(他人の行への `PATCH` / `DELETE` は
 * 404)、**ここで消しているのは「押しても必ず失敗する導線」だけである。**
 */
export function canWriteRowScope(
  table: Table | undefined,
  row: Record<string, unknown> | undefined,
  actorId: string | null,
): boolean {
  if (table === undefined || row === undefined || actorId === null) {
    return true;
  }
  if (personalOwnerField(table) === undefined) {
    return true;
  }
  return isOwnerVisible(row[OWNER_FIELD], actorId);
}

/**
 * そのロールで records の書込(create/update/delete)が許されるか。
 * **`null`(provider 外)と `ANONYMOUS`(未ログイン)は不可**(`ADR-0074` 限定6。下記)。
 *
 * **`table` を渡すと customer のテーブル単位判定も見る**(V3-M3-T04)。渡さなければ
 * 今までどおりロールだけで決まる —— ただし **customer はテーブル不明なら不可**である
 * (fail-closed。上のヘッダの決定)。owner / editor / viewer / null の答えは
 * `table` を渡しても渡さなくても1つも変わらない。
 */
// **【`V8-M27-T04`】`table` は使わなくなったが、引数からは外さない**(呼び出し側を
// 1箇所も書き換えないため)。**`_` を付けて「使っていない」ことを型検査に伝える。**
export function canWriteRole(role: ViewAudienceActor | null, _table?: Table | undefined): boolean {
  // **【V4-M2-T06 / `B-G5` / `ADR-0074` 限定6 で反転させた】**
  //
  // **着手前は最後の `return true` に落ちて `true` を返していた**(このファイルのヘッダの
  // 「provider の外(既定)では `role = null` = 書込可」。2026-08-03 実測)。
  // **`ADR-0074` 限定6 の逐語**:「**`canWriteRole(null, table)` が `false` を返す。**」
  //
  // **反転させた理由**(審査記録 `v4-m2-gate-a-anonymous-view.md` §3 の S3-2a):
  // **匿名に画面を開くと、`RoleProvider` が包んでいない subtree に `null` が流れ、
  // 保存・編集・削除ボタンが匿名に出る。**「読むだけです」と言いながら保存ボタンが出るのは
  // 憲法6 に正面から反する(審査記録 §5 の問1)。
  //
  // **`ANONYMOUS` も同じ枝に落とす** —— **匿名に書込を通すには `ADR-0034` §3a-1 の門が
  // 要る**(`ADR-0074` §3a-1)。**本 ADR が約束したのは UI に出さないことだけであり、
  // 最終防衛線は今日もサーバである**(未認証の POST / PATCH / DELETE は 401)。
  if (role === null || role === ANONYMOUS) {
    return false;
  }
  if (role === "viewer") {
    return false;
  }
  // **【`V5-M17-T05` / `G-G7` / `ADR-0158` 限定2】`role === "customer"` の等値比較を
  // `isReservedRole` の否定に置き換えた。****宣言された種類も `customer` とまったく同じ
  // 判定を受ける** —— **知らない値は非運営(狭い側)に落ちる。**
  //
  // --- 【`V8-M27-T04` / `T-G5`】**この枝は撤去した。旧文を1バイトも消していない** ---
  //
  // **旧(逐語)**:
  //
  //     if (!isReservedRole(role)) {
  //       // 非運営が書けるのは自分の行を持つテーブル(scoped)だけ。public / denied は 403。
  //       return table !== undefined && nonAdminTableAccess(table) === "scoped";
  //     }
  //
  // **サーバ側の同じ層(`nonAdminTableAccess`)を消したので、ここも消す** ——
  // **表示層に、サーバに存在しない規約を残さない。**
  // **表単位の可否は面(`canWriteFieldRole` / `canWriteTableActionRole` /
  // `canUseView`)が答える。**
  //
  // **【正直に書く】`role === "viewer"` の枝は残した**(すぐ上の2行)。
  // **サーバの `hasAdminWriteRole` は消えたので、面が書込を許した `viewer` は
  // 今日サーバでは書ける** —— **それでも UI は保存ボタンを出さない。**
  // **本タスクの射程は「表単位の可否を決める層」であり、`viewer` の綴りを
  // 表示層から外すことは射程外だからである**(**塞いでいない食い違いとして記録に書く**)。
  return true;
}

/**
 * **面の規則が、その相手にその項目の書込を許しているか**(`V8-M22` / `J-G38`)。
 *
 * ## なぜ要るのか(**着手前の実測**)
 *
 * **`editor` の `form` には、面が「書けない」と決めた項目の入力欄が今日も描かれていた**
 * (`docs/plan/v8/records/v8-m17.md:817` の申し送り。**本タスクが `web/test/` の検査で
 * 実際に赤くして確かめた**)。**`FormRenderer` は解決した項目を全部 `toRecordInput` に
 * 渡すので、書けない項目が1つ混じるだけで保存**全体**が 403 になる**
 * (`src/server/app.ts:3974` / `:4196` の `judgeRoleFieldWrite`)。
 *
 * ## 判定を再実装していない
 *
 * **サーバの `judgeRoleFieldWrite` が呼んでいるのと同じ `judgeRoleAccess` を、同じ引数の形で
 * 呼ぶ**(`target: "field"` × `verb: "write"`)。**規則の読み方を表示層に1文字も書いていない。**
 *
 * ## 据え置く条件(**既定を1ミリも動かさない**)
 *
 * - **規則を1本も書いていない項目は今日どおり `true`**(裁定 `R-4` の no-op)。
 *   **面を宣言していないアプリの `form` は1項目も減らない。**
 * - **`null`(provider 外)と `ANONYMOUS` は `roles: null` として判定する** ——
 *   **{@link canUseAction} とまったく同じ写し方であり、面では未ログインは `anonymous`
 *   として扱われる**(`J-G11`)。
 *
 * **【UI が隠すことは遮断ではない】**(`ADR-0176` 限定5)。**遮断はサーバの 403 である** ——
 * **この関数を消してもサーバは今日どおり 403 を返す。** **ここで消えているのは
 * 「押しても必ず失敗する入力欄」だけである。**
 *
 * **【行ごとの条件(`when`)は見ていない】** **行を渡していないので、条件つきの規則が
 * 立った項目では「通しうる」までしか言えない** —— **`judgeRoleAccess` の `conditional` を
 * 見ていない。** **安全側にも危険側にも倒さず、`allowed` をそのまま使う**(= 条件つきの
 * 項目は入力欄が出たままになりうる。**塞いでいない**)。
 *
 * ## 【`V8-M26-T03` / `T03b` の追記。上の「据え置く条件」は**今日も真である**。1バイトも消していない】
 *
 * **`V8-M26-T03` が既定を閉じる側へ倒したのは `table` / `view` / `action` の3対象だけであり、
 * `field`(項目)は閉じていない**(台帳 `T-G1b` = **却下**。ユーザ決定 `D-V8-58`)。
 * **`unruledRoleAccess`(`src/server/owner-scope.ts`)が `target.target === "field"` のときだけ
 * `UNGOVERNED_ROLE_ACCESS`(`allowed: true`)を返す。**
 *
 * **したがって上の「規則を1本も書いていない項目は今日どおり `true`」は今日も真である** ——
 * **`V8-M26-T03b` が実際に真であることを確かめたうえで、この1行を追記した**
 * (`src/server/role-default-closed.test.ts` が項目だけ通ることを固定している)。
 *
 * **【禁止の履行】これを「項目も閉じた」と書かない** —— **4対象のうち閉じたのは3対象である。**
 * **【正直に書く】これは「閉じ忘れ」ではなく決定である。**
 */
export function canWriteFieldRole(
  role: ViewAudienceActor | null,
  manifest: Manifest,
  tableId: string,
  fieldId: string,
): boolean {
  // **`judgeRoleFieldWrite`(サーバ)がしているのとまったく同じ1回の呼び出しである。**
  // **`governed` を別に見ないのは、規則が1本も無いとき `allowed` が `true` で返るからである**
  // (`UNGOVERNED_ROLE_ACCESS`)—— **既定の向きは判定側が持っており、ここには持たない。**
  return judgeRoleAccess({
    manifest,
    roles: role === null || role === ANONYMOUS ? null : role,
    target: { target: "field", table: tableId, field: fieldId },
    verb: "write",
  }).allowed;
}

/**
 * **面のボタンの規則が立てた「表 × 書込の種類」の壁を、その相手が通れるか**
 * (`V8-M22` / `J-G38`)。
 *
 * ## なぜ要るのか(**着手前の実測**)
 *
 * **サーバは `POST` / `PATCH` のボディを読む前に `isRoleActionWriteAllowed` の壁を当てる**
 * (`src/server/app.ts:3947` / `:4164`)。**壁は(アプリ, 表, 書込の種類)だけで決まり、
 * 要求が画面を名乗ったかどうかを1ミリも見ない** —— **したがって、その表を書き先とする
 * 名前つきの操作起点を1本も読めない相手は、`form` の「保存」でも必ず 403 になる。**
 * **着手前の `form` はその相手にも保存ボタンを出していた**(本タスクが実測した。
 * **先行の記録はこの1件を名指ししていない**)。
 *
 * ## 判定を再実装していない
 *
 * **サーバが呼んでいるのと同じ `isRoleActionWriteAllowed` を、同じ引数で呼ぶ。**
 * **「どの操作起点がどの表に何を書くか」の解決(`actionWriteTarget`)は
 * `src/server/owner-scope.ts` の中にあり、表示層は1文字も持たない。**
 *
 * ## 据え置く条件
 *
 * - **名前つきの操作起点が1本も無い表では壁が立たない**(裁定 `R-4`)——
 *   **面を宣言していないアプリの保存ボタンは1つも消えない。**
 * - **識別子(`view_action.id`)を持たない操作起点は壁の材料にならない**(`J-G9`)。
 * - **`DELETE` には1バイトも掛からない**(書込の種類は `create` / `update` の2つだけ)。
 *
 * **【UI が隠すことは遮断ではない】** **遮断はサーバの 403 である。**
 */
export function canWriteTableActionRole(
  role: ViewAudienceActor | null,
  manifest: Manifest,
  tableId: string,
  kind: RoleActionWriteKind,
): boolean {
  return isRoleActionWriteAllowed(
    manifest,
    tableId,
    kind,
    role === null || role === ANONYMOUS ? null : role,
  );
}

/**
 * その相手が、このテーブルについて **そもそも「編集する立場」にあるか**(`E-G20` / V4-M6)。
 *
 * **`canWriteRole` とは問いが違う。** `canWriteRole` は「いま書けるか」を答えるが、こちらは
 * 「書けない理由を説明する相手か」を答える。**買い物客に商品ページの権限の話をしない**ため
 * だけに使う判定であり、**遮断には1ミリも関わらない**(遮断は今日もサーバの 403 である)。
 *
 * - **customer × 公開テーブル(`st_public`)/ 運営テーブル** … **編集する立場に無い。**
 *   店の商品ページは「見るための画面」であって、書き込み権限の有無を告げる場所ではない。
 * - **customer × 自分のテーブル(`st_owner`)** … 立場にある(そちらは `canWriteRole` が
 *   `true` を返すので注記自体が出ない)。
 * - **owner / editor / viewer / provider 外** … **1ミリも変わらない。** とくに **viewer には
 *   今日どおり注記を出す** —— viewer は「編集できる想定の人が編集できない」場合そのものである。
 *
 * **新しい規約を1つも作っていない。** 可否を決めるのは `nonAdminTableAccess` 1本である
 * (`canWriteRole` と同じ関数を見る。判定を2箇所に割らない)。
 */
// **【`V8-M27-T04`】引数は2つとも使わなくなった**(下の doc)。**呼び出し側を
// 1箇所も書き換えないために引数は残す。**
export function isWriteAudienceRole(_role: Role | null, _table?: Table | undefined): boolean {
  // **【`V5-M17-T05`】等値比較 → `isReservedRole`(上と同じ理由)。**
  // **`null` / `undefined`(provider 外・ロール欄を持たない応答)は今日どおり `true` に
  // 倒す** —— **`isReservedRole(null)` は `false` なので、明示的に分けないと据え置きの
  // 向きが変わってしまう**(着手前の `role !== "customer"` は `null` でも `undefined` でも
  // `true` だった)。**`== null` で両方を拾う。****据え置きの向きを1ミリも変えない。**
  //
  // --- 【`V8-M27-T04` / `T-G5`】**この2枝は撤去した。旧文を1バイトも消していない** ---
  //
  // **旧(逐語)**:
  //
  //     if (role == null || isReservedRole(role)) {
  //       return true;
  //     }
  //     return table !== undefined && nonAdminTableAccess(table) === "scoped";
  //
  // **今日は常に `true` である** —— **「編集する立場に無い相手」を役割の綴りで
  // 決めていた層が消えたので、注記は着手前の `V4-M6` より前の姿(誰にでも出す)に戻る。**
  // **【正直に書く。これは広がりである】** **買い物客の商品ページに
  // 「閲覧のみ(書き込み権限がありません)」の注記が再び出うる。**
  // **`E-G20` / `V4-M6` が消した導線が1つ戻った** —— **それを役割の綴りを使わずに
  // 消す手だては、今日の面の語彙には無い**(**塞いでいない穴として記録に書く**)。
  return true;
}

/**
 * そのロールでそのテーブルの records を読めるか(V3-M3-T04 / D-G12b)。
 *
 * customer 以外はテーブルによらず読める —— **viewer について隠すべきものは0件である**
 * (V3-M0 審査記録 §5 S3-5)。customer だけが運営テーブル(denied)で 403 になる。
 */
// **【`V8-M27-T04`】引数は2つとも使わなくなった**(下の doc)。**呼び出し側を
// 1箇所も書き換えないために引数は残す。**
export function canReadTableRole(_role: Role | null, _table: Table | undefined): boolean {
  // **【`V5-M17-T05`】等値比較 → `isReservedRole`(上と同じ理由)。**
  // **`null` / `undefined` を明示的に分ける理由は `isWriteAudienceRole` と同じである**
  // (読取は今日も「読める」に倒れる。この向きは1バイトも変えていない)。
  //
  // --- 【`V8-M27-T04` / `T-G5`】**この2枝は撤去した。旧文を1バイトも消していない** ---
  //
  // **旧(逐語)**:
  //
  //     if (role == null || isReservedRole(role)) {
  //       return true;
  //     }
  //     return table !== undefined && nonAdminTableAccess(table) !== "denied";
  //
  // **今日は常に `true` である** —— **表単位の読取の可否を決めるのは面である。**
  // **`canUseView` はこの関数と `judgeRoleAccess` の `AND` を取っており、
  // 画面の出し分けは今日そちらが1本で決める**(`V8-M26` が既定を閉じたので、
  // 規則を書いていない画面は誰にも並ばない)。
  // **【正直に書く】この関数はもう1件も落とさない。** **残してあるのは、
  // 呼び出し側(`canUseView`)の `AND` の形と、`V3-M3-T04` が置いた
  // 「読取と書込を別の述語で答える」構造を崩さないためである。**
  return true;
}

/**
 * そのロールでその画面を**開けるか**(V3-M3-T04 / D-G12b。ユーザ決定 D-M3-1 =「隠す」)。
 *
 * **判定は「対象テーブルを読めるか」1本である。**ビュー種別で分けない ——
 * 3種のどれも、開けば必ずレコードを読む(`form` の編集も既存レコードの GET から始まる)。
 *
 * **`form` を「書けないなら使えない画面」として隠す案は採らなかった。** 採ると viewer の
 * form が全部消えるが、**V3-M0 審査記録 §5 S3-5 は「viewer について隠すべきビューは0件で、
 * 消えるのは書込ボタンだけである」と判定している。**書けない form は今日 viewer に対して
 * 「閲覧のみ」を出して開いており、customer の公開テーブルでも同じ扱いにする(規則を
 * ロールごとに割らない)。**その結果、画面の出し分けが起きるのは customer だけになる。**
 *
 * **新しい規約を1つも作っていない。** 可否を決めるのは `nonAdminTableAccess` 1本である。
 *
 * ## 【V4-M3-T04 / `B-G1` / ADR-0070 限定3 の追記】画面ごとの宣言も読む
 *
 * **判定は2本の AND になった**:
 *
 * 1. **対象テーブルを読めるか**(`nonAdminTableAccess`。今日までと1バイトも変わらない)。
 * 2. **【`V8-M20` / `J-G27`】画面の `audience` は撤去した。** **代わりに立つのは
 *    面(`judgeRoleAccess` の `target: "view"` x `read`)であり、
 *    **`src/server/owner-scope.ts` の述語を web から import する** —— サーバと
 *    **同じ関数**を見る。**判定を2箇所に書かない**のは案(i)の作法そのものである。
 *
 * **宣言を書いていない画面の答えは1つも変わらない**(`ADR-0070` 限定4)。
 *
 * **【UI が隠すことは遮断ではない】**(`ADR-0053:41`)。**遮断はサーバの 403 である** ——
 * `T03` が `recordsAuthMiddleware` に同じ判定を入れており、**この関数を消しても
 * サーバは今日どおり 403 を返す。** **逆にこの関数だけを残す実装は `ADR-0070` 限定3 の
 * 「表示層だけの実装を認めない」に当たる。**
 *
 * **【射程を誇張しない】** **`ADR-0053:40` の逐語「画面が減るのは customer のときだけである。
 * owner / editor / viewer では**1画面も減らない**」は、`audience` を書いた画面については
 * **今日から偽である**(`web/test/view-audience-visibility.test.tsx` が実測で固定した)。
 * **宣言を書いていないアプリでは今日も真である。**
 */
export function canUseView(
  role: ViewAudienceActor | null,
  manifest: Manifest,
  view: View,
): boolean {
  // ## 【V4-M2-T05 / `B-G5` / `ADR-0074` 限定5・限定7 の追記】匿名は別の述語で決まる
  //
  // **匿名は `canReadTableRole` を通さない。** 通すと**宣言を1つも書いていない既存アプリが
  // 未ログインに全画面を晒す** —— **`canReadTableRole(null, table)` は今日も `true` に
  // 倒れる**(そちらは1バイトも変えていない)。**審査記録 §3 の S3-2a が名指しした穴である。**
  //
  // **【`V8-M20` / `J-G27`】匿名の可視集合を決めていた `isViewAnonymousVisible`
  // (「`audience` に `anonymous` と書かれた画面だけ」。`ADR-0074` 限定7)は撤去した。**
  // **代わりに立つのは面である** —— **未ログインは `anonymous` を主体として判定され、
  // 規則が書かれた画面は許された役割にだけ見える**(`J-G11`)。
  //
  // **【非対称が1つ消えたことを正直に書く】** **旧層では「宣言の無い画面は匿名に見せない」
  // (既定は閉じる)だったが、面の既定は「規則を1本も書いていない対象は管轄外(全許可)」
  // (裁定 `R-4`)である。** **したがって規則を1本も書いていないアプリでは、未ログインに
  // 画面が並ぶ側に倒れる。** **【禁止の履行】これを「同じ挙動を保った」と書かない。**
  //
  // ## 【`V8-M17` / `J-G8` の追記】面(役割に束ねた権限)の画面の規則も見る
  //
  // **判定は3本の AND になった。** **足したのは `judgeRoleAccess` 1本の呼び出しだけで、
  // 規則の読み方は1文字も書いていない**(サーバと**同じ関数**を見る)。
  // **規則を1本も書いていない画面の答えは1つも変わらない**(裁定 `R-4`)。
  // **未ログイン(`ANONYMOUS`)にも当てる** —— **面では未ログインは `anonymous` として
  // 判定される**(`J-G11`)。**匿名の可視集合を決める `isViewAnonymousVisible` の側は
  // 1バイトも変えていない**(あちらは「宣言の無い画面を見せない」で、こちらは「規則の
  // 書かれた画面を許された役割にだけ見せる」であり、問いが違う)。
  //
  // **【UI が隠すことは遮断ではない】** **遮断はサーバの 403 である**
  // (`rejectNamedView` と手動起動の入口が同じ判定を持つ)。
  //
  // ## 【`V8-M26-T03` / `T03b` の追記。上の2つの記述は今日から偽である。1バイトも消していない】
  //
  // **偽になった1つ目**: 上の「**規則を1本も書いていない画面の答えは1つも変わらない**
  // (裁定 `R-4`)」。**今日は変わる** —— **`V8-M26-T03` が既定を閉じる側へ倒し、
  // 画面(`target: "view"`)は規則が1本も無ければ `allowed: false` で返る**
  // (ユーザ決定 `D-V8-45` / `D-V8-58` / `D-V8-65`)。**したがって規則を1本も書いていない
  // アプリでは、この関数は今日 `false` を返す = 画面が1つも出ない。**
  //
  // **偽になった2つ目**: 上の「**したがって規則を1本も書いていないアプリでは、未ログインに
  // 画面が並ぶ側に倒れる。**」。**今日は逆側に倒れる**(未ログインも `anonymous` として
  // 閉じられる。台帳 `T-G26a`)。**旧層の閉じる向きの既定が、面の側に戻ってきた形である。**
  //
  // **【正直に書く】これは「同じ挙動を保った」ではない。** **既定が反転した。**
  // **反転の埋め合わせは `V8-M26-T04`(表・画面・ボタンを作るたびに既定3役割の規則を
  // 自動で足す)が担うのであって、この関数は1バイトも埋め合わせていない。**
  //
  // **【`T03b`】この関数は今日も `judgeRoleAccess` を見る** —— **付け替えたのは
  // `viewIdForRecordRequest`(名乗り)だけであり、可否を決めるこちらは1バイトも変えていない。**
  const roleAllowsView = judgeRoleAccess({
    manifest,
    roles: role === ANONYMOUS ? null : role,
    target: { target: "view", view: view.id },
    verb: "read",
  }).allowed;
  if (role === ANONYMOUS) {
    return roleAllowsView;
  }
  return canReadTableRole(role, resolveViewTable(manifest, view.table)) && roleAllowsView;
}

/**
 * **サーバに名乗るべき画面ID**(V4-M3-T04 / `B-G1` / ADR-0070 限定3・限定4)。
 *
 * **【`V8-M20` / `T02` の置き直し】面の規則が名指ししている画面だけを名乗る。**
 * **旧は「`audience` を書いた画面だけ」だった** —— **問いの形は1ミリも変えていない
 * (「サーバが判定に使う宣言を持つ画面か」)。** **見る宣言だけが `view.audience` から
 * 面(`app.roles[].rules`)へ移った。**
 *
 * **なぜ「常に名乗る」にしないのか(明示的な決定である)**:
 * **`ADR-0070` 限定4 の逐語は「**宣言の無い画面は今日どおり動く** … **既存の全アプリが
 * 1バイトの変更もなく動き続ける**」である。** 常に名乗ると、**宣言を1つも書いていない
 * アプリのレコード取得 URL まで今日と変わる**(`?view=` が付く)。**それは「1バイトの
 * 変更もなく」ではない。** サーバ側の判定は宣言の無い画面では何もしないので、
 * **名乗る利益も0である。**
 *
 * **したがってこれは遮断の強度を1ミリも下げていない** —— 名乗らない画面は、名乗っても
 * 素通りする画面だからである。
 *
 * **【これが遮断ではないことを繰り返す】** 悪意ある相手は `?view=` を外して直接叩ける。
 * **その要求は今日どおり通る**(限定4)。**ここで増えるのは、UI の不具合で運営用の画面が
 * 出てしまったときにサーバが止める、という層だけである。**
 *
 * ## 【`V8-M26-T03b` の置き直し。上の記述は1バイトも消していない】
 *
 * **見る述語が `judgeRoleAccess(...).governed` から {@link roleRulesNameTarget} へ変わった。**
 * **問いの形は1ミリも変えていない**(「サーバが判定に使う宣言を持つ画面か」)——
 * **同じ問いに答えていた1つの旗が2つに割れたので、こちらの問いに答える側へ付け替えた。**
 *
 * **なぜ割れたか**: **`V8-M26-T03` が既定を閉じる側へ倒し、規則を1本も書いていない画面も
 * `governed: true`(閉じる側の管轄内)で返るようになった。** **そのまま `governed` を
 * 見続けると `governed` が常に真になり、全リクエストが `?view=` を名乗る。**
 *
 * **それは上の doc が自分で禁じた形である** —— **「常に名乗ると、宣言を1つも書いていない
 * アプリのレコード取得 URL まで今日と変わる。それは『1バイトの変更もなく』ではない」。**
 * **実測でも、付け替える前は `web/test/` の赤が 384 本に増えていた**(URL が全部変わったため)。
 *
 * **したがって今日の答えは着手前と1バイトも変わらない** —— **{@link roleRulesNameTarget} は
 * 「既定を閉じる前の `governed`」そのものだからである。**
 */
export function viewIdForRecordRequest(manifest: Manifest, view: View): string | undefined {
  return roleRulesNameTarget({
    manifest,
    target: { target: "view", view: view.id },
  })
    ? view.id
    : undefined;
}

/**
 * **その操作起点(ボタン)を、その相手に出してよいか**(`V8-M20` / `T02` の置き直し)。
 *
 * **`web/src/views/action-audience.ts`(表示層の再実装)を消した代わりである。**
 * **あちらは `action.audience` を表示層で**自分で読んで**おり、同じ宣言をサーバの
 * `owner-scope.ts` も読むという「同じ宣言を2箇所が別々に読む」形だった**
 * (そのファイル自身がヘッダで不揃いを申告していた)。
 *
 * **今日は表示層に判定を1バイトも持たない** —— **サーバと同じ `judgeRoleAccess` を呼ぶ。**
 *
 * **【UI が隠すことは遮断ではない】** **遮断はサーバの 403 である**
 * (`isRoleActionWriteAllowed` が書込の壁を立てている)。
 * **識別子(`id`)を持たない操作起点は面から名指しできないので、今日どおり出る。**
 */
export function canUseAction(
  manifest: Manifest,
  viewId: string,
  action: unknown,
  role: ViewAudienceActor | null,
): boolean {
  const actionId = (action as { id?: unknown } | null | undefined)?.id;
  if (typeof actionId !== "string") {
    return true;
  }
  return judgeRoleAccess({
    manifest,
    roles: role === null || role === ANONYMOUS ? null : role,
    target: { target: "action", view: viewId, action: actionId },
    verb: "read",
  }).allowed;
}

/**
 * 画面一覧に並べてよいビューだけを、**マニフェストの順序のまま**返す(V3-M3-T04)。
 *
 * **射程を誇張しない**: owner / editor / viewer / provider 外では**1件も減らない**。
 * 減るのは customer のときだけである。
 *
 * **代償(憲法6 との緊張。V3-M0 審査記録 §5 S3-4)**: 隠すと「無い」と「見えない」が
 * 区別できなくなり、**なぜ見えないのかを説明する機会が一覧から消える**。今日サーバが
 * 返している 403 の hint(「顧客が閲覧できるのは自分の行を持つテーブルと公開テーブルだけ
 * です」)は、一覧から画面を開かなくなった分だけ人の目に触れなくなる。**ユーザ決定
 * D-M3-1 はこの緊張を承知で「隠す」を選んだ。代償は消えない。**(URL を直接叩く経路は
 * 絞っていないので、そちらでは従来どおり 403 とその hint に到達する。)
 *
 * ## 【`V4-M10-T45` / `E-G12` / `ADR-0084` 限定4 の追記】掲載の宣言も読む
 *
 * **判定は AND 1本になった**: **`canUseView`(可否)** **かつ** **`isViewMenuListed`(掲載)**。
 *
 * **「どちらが勝つか」の規則を1つも作っていない**(`ADR-0074` 限定2 の精神)——
 * 右辺に1項足しただけであり、**2本目の「隠す」規則ではない**(限定9)。
 *
 * **【可否と掲載を混ぜない】** **本関数が減らした画面は、開けなくなったのではない。**
 * `canUseView` は `menu_listed: false` の画面にも今日どおり `true` を返し、
 * **行クリック / URL 直叩きからは到達できる**(限定5)。**サーバの応答は1バイトも
 * 変わらない**(限定8)。**したがってこの関数は「一覧に載せる集合」であって
 * 「開ける集合」ではない** —— **開ける集合が要るところでは `canUseView` を直に呼ぶこと**
 * (`web/src/AppWorkspace.tsx` の匿名の経路がそうしている)。
 *
 * **【匿名にも同じ AND が当たる】**(`v4-m10.md` §4d 申し送り3 が実装者に決定を求めた点)。
 * **AND を `canUseView` の**外**に置いたので、匿名の枝(`isViewAnonymousVisible`)にも
 * ログイン済みの枝にも同じ1本が当たる。** **枝ごとに別の規則を作っていない。**
 */
export function visibleViewsForRole(role: ViewAudienceActor | null, manifest: Manifest): View[] {
  return manifest.app.views.filter(
    (view) => canUseView(role, manifest, view) && isViewMenuListed(view),
  );
}

/**
 * **その画面を画面一覧(メニュー)に並べてよいか**(`V4-M10-T45` / `E-G12` / `ADR-0084`)。
 *
 * **書かなかった画面は `true`**(限定3。既定は「出す」)——
 * **既定を反転させると既存の全アプリのメニューが黙って変わる。**
 *
 * **`View` 型はカーネルにあり、`menu_listed` は `ViewMenuListing` として在る**が、
 * ここでは `audience` の先例(`src/server/owner-scope.ts` の `isViewAudienceAllowed`)と
 * 同じく**未知の値も安全側に倒す**形で読む
 * (**【`V8-M20` / `J-G27`。旧文を1バイトも消していない】** **その先例は撤去された** ——
 * **今日その位置に在るのは面の画面の規則(`judgeRoleAccess` の `target: "view"`)である。**
 * **「未知の値を安全側に倒す」という読み方そのものは1ミリも変えていない**) —— **真偽値でない値が入っていたら「出す」に
 * 倒す**(既定と同じ。既存アプリの見え方を黙って変えない)。
 */
function isViewMenuListed(view: View): boolean {
  return (view as { menu_listed?: unknown }).menu_listed !== false;
}

/**
 * ロールの表示名。`Role` 型と網羅一致(`Record<Role, string>` なのでロールを足すと
 * ここが tsc で落ちる)。V2-M1-T01 で customer(顧客)を追加した(ADR-0033 限定1)。
 * customer の書込可否・可視性の UI 制御は V2-M1-T03 で扱う(本追加は表示名のみ)。
 *
 * **【V4-M2-T06 の判定】`anonymous` をここに足さない**(`ADR-0074` §3a-5)。
 * **理由**: **`Role` 型が増えると `ADR-0033` §3a-1 の逐語(「5番目・6番目のロール(店員 /
 * 配送業者 / ゲスト 等)を足す … **本 ADR は先例を作らない。**」)に正面から当たる。**
 * **`ADR-0074` が足したのは `audience` の値域の1値であって、認証のロールではない** ——
 * **`anonymous` は「ロールを持たない者」を指す値である。** **この区別を消す提案は別の門を
 * 通ること。** **したがって匿名の画面には現在ロールの表示(`current-role`)を出さない。**
 *
 * **【`V5-M13` / `G-G4`】`customer` の表示名を「顧客」から「一般利用者」に変えた。**
 * **変えたのは値(表示名の文字列)だけで、キー4値を1つも変えていない** —— したがって
 * `ADR-0070` 限定2 の検査欄が指す「`ROLE_LABELS` の4値と一致」は1ミリも動いていない。
 * 判定は `V5-M12` の門A本審査で**門外(`Δ7`)・`(記録)`**(`docs/plan/v5/records/v5-m12.md` §3-1)。
 * **`V5-M17` はここを2度目に触る** —— 「宣言された種類の表示名を引く」形へ作り替える
 * 予定であり(同 §2-3)、**そのときこの固定マップそのものが対象になる。**
 */
/**
 * ---
 *
 * ## **【`V5-M17-T08` / `G-G5` / `ADR-0159` 限定5】固定マップを置き換えた**
 *
 * **上の段落を1バイトも書き換えていない。** **食い違っているのは「4値の固定マップである」
 * という点だけである。**
 *
 * **今日の形**: **運営の予約3ロールの表示名は実装が持ち**({@link RESERVED_ROLE_LABELS})、
 * **非運営の種類の表示名はアプリの宣言(`$defs/app.user_kinds` の `name`)から引く。**
 * **宣言が無いアプリでは、非運営は `customer` 1種で表示名は「一般利用者」である** ——
 * **`V5-M13` が置いた文字列を1文字も変えていない**(`v5-m13.md` §7 の 2 が
 * 「既定になるのか消えるのかを決める必要がある」と申し送った点への答え = **既定として残す**)。
 *
 * **`ADR-0159` 限定5 の逐語**: 「**`ROLE_LABELS` の4値と一致」を「`ROLE_VALUES` の運営3値 +
 * 宣言された種類の集合と一致」に置き換える。**検査を削除しない**」。
 * **置き換え先の検査は `web/test/industry-neutral-wording.test.tsx` と
 * `web/test/anonymous-view.test.tsx` に在る。**
 */
export const RESERVED_ROLE_LABELS: Record<ReservedRole, string> = {
  owner: "オーナー",
  editor: "編集者",
  viewer: "閲覧者",
};

/**
 * **宣言が無いときの非運営の種類(`customer`)の表示名。**
 *
 * **`V5-M13` / `G-G4` が「顧客」から変えた文字列そのものである。** **アプリが
 * `user_kinds` を宣言すれば、この文字列は1度も使われない。**
 */
export const DEFAULT_USER_KIND_LABEL = "一般利用者";

/**
 * **そのアプリのロール → 表示名の対応表。**
 *
 * **宣言(`declaredUserKinds` の戻り)を渡すこと。** **渡さなければ「宣言が無いアプリ」
 * として扱われ、着手前と1文字も変わらない4値**(`owner` / `editor` / `viewer` / `customer`)
 * **を返す。**
 */
/**
 * ---
 *
 * ## **【`V8-M29` 第1波 / ユーザ決定 `D-V8-79`】`app.roles[].name` も見るようにした**
 *
 * **上の doc を1バイトも書き換えていない。** **第1引数(`user_kinds` 側)の扱いは
 * 1文字も変えていない** —— **足したのは第2引数だけである。**
 *
 * **【どちらを先に見るかを決めた】** **見る順は次の3段である**:
 *
 *  1. **`user_kinds[].name`**(第1引数。**今日の出どころ。最優先**)——
 *     **今日 `user_kinds` で日本語名を付けているアプリの表示を1文字も変えないためである。**
 *  2. **予約3ロールの固定文字列**({@link RESERVED_ROLE_LABELS})——
 *     **`app.roles` に `{"id":"owner","name":"持ち主"}` と書いてあっても、画面は今日どおり
 *     「オーナー」と出る。** **`V8-M29` は運営3語の表示を動かさない。**
 *  3. **`app.roles[].name`**(第2引数。**新しい出どころ**)。
 *
 * **どこにも無ければ識別子が生で出る**({@link roleLabel} の `?? role`)——
 * **`roles[].name` は今日も任意である**(`D-V8-79` = 必須化しない)。
 * **`D-V8-79` の説明文の逐語**:「**表示名を書かなければ、利用者管理の画面に英字の識別子
 * (reception など)がそのまま出ます。**」
 *
 * **【`user_kinds` 側の参照を1バイトも消していない】** —— **撤去は次の波である。**
 *
 * ---
 *
 * ## **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a` / `T-G12`。判定値 = 廃止】**
 *
 * **上の doc を1バイトも書き換えていない。** **第1引数(`user_kinds` 側)を落とした。**
 *
 * **旧(逐語)**:
 *
 *     export function roleLabels(
 *       kinds: readonly UserKind[] = [],
 *       roles: readonly UserKind[] = [],
 *     ): Record<string, string> {
 *       const declared =
 *         kinds.length === 0
 *           ? { [DEFAULT_USER_KIND]: DEFAULT_USER_KIND_LABEL }
 *           : Object.fromEntries(kinds.map((kind) => [kind.id, kind.name]));
 *       const fromRoles = Object.fromEntries(roles.map((role) => [role.id, role.name]));
 *       return { ...fromRoles, ...RESERVED_ROLE_LABELS, ...declared };
 *     }
 *
 * **【見る順を書き直した。3段 → 3段】**
 *
 *  1. **`customer` の既定の表示名**({@link DEFAULT_USER_KIND_LABEL} = 「一般利用者」)——
 *     **`customer` は今日つねに値域に入る**(`baseRoleValues`)ので、つねに置く。
 *  2. **`app.roles[].name`** —— **`customer` に表示名を書けば、上の既定に勝つ。**
 *     **これは着手前に `user_kinds` に `{"id":"customer","name":"…"}` と書いたときの
 *     ふるまいと同じである。**
 *  3. **予約3ロールの固定文字列**({@link RESERVED_ROLE_LABELS})—— **最優先。**
 *     **`app.roles` に `{"id":"owner","name":"持ち主"}` と書いても「オーナー」のままである**
 *     (第1波が決めた線を1ミリも動かしていない)。
 *
 * **どこにも無ければ識別子が生で出る**({@link roleLabel} の `?? role`)。
 *
 * **【担い手が無いもの (`ADR-0301` 限定6 の ④)】** **「`customer` を対応表から消す」
 * 機能。** **着手前は `user_kinds` を宣言すると `customer` が対応表から消えた。**
 */
export function roleLabels(roles: readonly UserKind[] = []): Record<string, string> {
  const fromRoles = Object.fromEntries(roles.map((role) => [role.id, role.name]));
  return {
    [DEFAULT_USER_KIND]: DEFAULT_USER_KIND_LABEL,
    ...fromRoles,
    ...RESERVED_ROLE_LABELS,
  };
}

/**
 * ロールを表示名に。ロール一覧のセレクトと現在ロール表示の両方が使う。
 *
 * **宣言に無い種類には、その識別子をそのまま返す** —— **`undefined` を返して画面に
 * 「undefined」と出す事故を作らない。** **`user_kinds` を宣言したアプリに残っている
 * 古い `customer` のユーザが、まさにこの枝に落ちる**(`effectiveUserKindIds` の帰結)。
 *
 * **【2026-08-11。`V8-M29` 第2波】旧(逐語)**:
 *
 *     export function roleLabel(
 *       role: Role,
 *       kinds: readonly UserKind[] = [],
 *       roles: readonly UserKind[] = [],
 *     ): string {
 *       return roleLabels(kinds, roles)[role] ?? role;
 *     }
 *
 * **第2引数(`user_kinds` 側)を落とした。** **上の doc の最後の1文が名指しする
 * `effectiveUserKindIds` は今日このリポジトリに1本も無い** —— **それでも
 * 「宣言に無い識別子には、その識別子をそのまま返す」ふるまいは1文字も変わっていない。**
 */
export function roleLabel(role: Role, roles: readonly UserKind[] = []): string {
  return roleLabels(roles)[role] ?? role;
}

/**
 * 現在ユーザが records を書込できるか(viewer は不可)。provider 外は既定で許可。
 *
 * **対象テーブルを渡すこと**(V3-M3-T04)。customer はテーブル単位で可否が分かれるので、
 * 渡さないと「ロールが customer だがテーブルが分からない」= fail-closed になる。
 */
export function useCanWrite(table?: Table | undefined): boolean {
  return canWriteRole(useRole(), table);
}
