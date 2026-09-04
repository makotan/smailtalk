/**
 * **実行専用エントリが描く中身**(`V10-M6-T01b` で `web/src/runner-main.tsx` から切り出した)。
 *
 * ## なぜ切り出したのか(正直に書く)
 *
 * **`web/src/runner-main.tsx` は読み込まれた瞬間に副作用を持つ** ——
 * `#root` が無ければ投げ、ビルド時にだけ置き換わる識別子を読み、`createRoot().render()` を
 * 1回走らせる。**そのため検査から素直に読み込めず、読み込めたとしても、複数の検査が
 * 同じ1つのマウントを共有してしまい、題材を変えて描き直せなかった**(`T01b` の実測)。
 * **本ファイルはその副作用を1つも持たない** —— 部品を定義して公開するだけである。
 *
 * ## 何を移したのか / 何を書き換えたのか
 *
 * - **移したのは `RunnerShell` / `SingleApp` / `Body` / `Selected` の4本と、その doc である。**
 * - **中身は1バイトも書き換えていない。** **書き換えたのは1箇所だけで、`RunnerShell` に
 *   `export` を付けたことである**(`web/src/runner-main.tsx` と検査から呼ぶため)。
 * - **【2026-08-21 追記。すぐ上の「1箇所だけ」は、打ち直すと2行である。旧文は1文字も消していない】**
 *   **取り除かれた454行のうち、空白込みの逐語で本ファイルに在るのは 452行である。**
 *   **当たらない2行は `function RunnerShell …`(doc が名指ししているもの)と、`react` からの
 *   `import` 行**(`StrictMode` がエントリ側に残ったため、取り込む名前が割れた)**である。**
 *   **失われた綴りは1つも無い。**
 * - **どのアプリを描くかを外から受け取る口(`readAppId`)は移していない。**
 *   **それはエントリ側(`web/src/runner-main.tsx`)に残っている。**
 *
 * ## 【誇張しない】切り出しても、複製は1本も減っていない
 *
 * **組み立て方(認証の関門 → 画面の並び → 選んだ画面)が `web/src/AppWorkspace.tsx` と
 * 別に書かれている状態は、1ミリも変わっていない。** **片方を変えても、もう片方は
 * 変わらない。** **「追随が容易になった」とは書かない。**
 *
 * ## 【`V10-M6-T01b` / `NV-G14`】登録の直後の自動遷移が入っている
 *
 * **登録の直後で、行き先の候補がちょうど1本のときだけ、その画面を1度だけ自動で開く**
 * (`web/src/auth/signup-next.ts` の `useSignupAutoOpen`)。
 * **配る版には案内の文言を1バイトも足していない —— これはユーザの選択である**
 * (逐語:「**配る版は自動で開くだけ**」)。**育成用の版に在る「次はこちら」の案内は、
 * 配る版には今日も1つも出ない。** **候補が2本以上のときと0本のときの配る版の見え方は、
 * 1ピクセルも変わっていない。**
 */
import { useEffect, useState } from "react";
import type { Manifest, View } from "../../src/kernel/types.ts";
import { AppThemeScope, publicManifest, stripPublicViewTables } from "./AppWorkspace.tsx";
import { ApiError, fetchManifest, fetchPublicAppInfo, type PublicAppInfo } from "./api.ts";
import { type AsyncState, toValidationErrors } from "./async.ts";
import { AccountPanel } from "./auth/AccountPanel.tsx";
import {
  ANONYMOUS,
  canUseView,
  declaredRoleKinds,
  RoleProvider,
  roleLabel,
  visibleViewsForRole,
} from "./auth/authz.tsx";
import { LoginPage } from "./auth/LoginPage.tsx";
// **【`V10-M19-T01` / `FU-G6` / `ADR-0363`】登録の直後の案内。**
// **`web/src/AppWorkspace.tsx` に在った実装をそのまま移した1本を、両方の版が呼ぶ**
// —— **配る版のために2本目を書いていない**(限定1)。
import { SignupNextNotice } from "./auth/SignupNextNotice.tsx";
import {
  signupNextFormViews,
  useSignupAutoOpen,
  useSignupNextCandidates,
} from "./auth/signup-next.ts";
import { useAppAuth } from "./auth/useAppAuth.ts";
import { ErrorList } from "./ErrorList.tsx";
import { RouteLink, useRoute } from "./navigation.tsx";
import type { RoutePrefill } from "./route.ts";
import { Button } from "./ui/button.tsx";
import { resolveUiFamily } from "./ui/family.ts";
import { Badge, Skeleton } from "./ui/surfaces.tsx";
import { cn } from "./ui/utils.ts";
import { ViewHost, viewDisplayName } from "./views/ViewHost.tsx";

/**
 * 画面の器。**`web/src/App.tsx` の器と同じ `class` を使う**(`web/src/styles.css` の
 * `.shell` が当たり先である)。**共通ヘッダを1つも置かない** —— そこに在ったのが
 * アプリの一覧への導線とアプリの切替である。
 */
export function RunnerShell({ appId }: { appId: string }) {
  const route = useRoute();
  const uiFamily = resolveUiFamily();
  /*
   * **URL の中のアプリIDを見ていない。** 描く対象は属性から来た1つだけである ——
   * URL を書き換えて別のアプリを指しても、この画面が読むマニフェストは変わらない。
   * **【正直に書く】URL には今日も `/apps/<app_id>/…` が出る**(`src/shared/route.ts` の
   * 形をそのまま使っている)。**別のIDを打ち込めること自体は止めていない。**
   */
  const viewId = route.kind === "view" ? route.viewId : undefined;
  const recordId = route.kind === "view" ? route.recordId : undefined;
  const prefill = route.kind === "view" ? route.prefill : undefined;
  return (
    <main className="shell group/ui" data-ui-family={uiFamily}>
      <SingleApp
        appId={appId}
        viewId={viewId}
        recordId={recordId}
        {...(prefill === undefined ? {} : { prefill })}
      />
    </main>
  );
}

/**
 * 1つのアプリの画面(認証の関門つき)。
 *
 * **`web/src/AppWorkspace.tsx` の同名の関門と同じ順序である**(読み込み中 → 取得失敗 →
 * 本人確認中 → 未ログイン → ログイン済み)。**判定そのもの(`canUseView` /
 * `visibleViewsForRole`)は既存の1本を呼んでおり、ここに書き写していない。**
 */
function SingleApp({
  appId,
  viewId,
  recordId,
  prefill,
}: {
  appId: string;
  viewId?: string | undefined;
  recordId?: string | undefined;
  prefill?: RoutePrefill | undefined;
}) {
  const auth = useAppAuth(appId);
  const [state, setState] = useState<AsyncState<Manifest>>({ status: "loading" });
  const [accountOpen, setAccountOpen] = useState(false);
  /**
   * **未ログインのときにサーバから渡る最小限**(`V8-M21` / `J-G24b` / `D-V8-34`)。
   * **アプリ名と、未ログインでも見せると決めた画面の名前だけである。**
   */
  const [publicInfo, setPublicInfo] = useState<PublicAppInfo | null>(null);

  /**
   * マニフェストの取得。**`web/src/api.ts` の1本を呼ぶだけで、第2の取得経路を作らない。**
   * **`web/src/AppWorkspace.tsx` と同じ形をもう一度書いている**(このファイル冒頭の
   * 「複製しているもの」に数えてある)。
   *
   * **【`V8-M21` / `J-G24a` / `D-V8-21`】この口は今日からログインを要求する。**
   * **配布物(Runner)はログイン画面から始まるので、401 のときは
   * `GET /public`(アプリ名と匿名に開いた画面の名前だけ)へ倒す** ——
   * **倒さないと Runner が起動できない**(`D-V8-34` の問いそのもの)。
   */
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setPublicInfo(null);
    fetchManifest(appId).then(
      (manifest) => {
        if (!cancelled) {
          setState({ status: "ready", value: manifest });
        }
      },
      (reason: unknown) => {
        if (cancelled) {
          return;
        }
        if (reason instanceof ApiError && reason.status === 401) {
          fetchPublicAppInfo(appId).then(
            (info) => {
              if (!cancelled) {
                setPublicInfo(info);
              }
            },
            (publicReason: unknown) => {
              if (!cancelled) {
                setState({ status: "error", errors: toValidationErrors(publicReason) });
              }
            },
          );
          return;
        }
        setState({ status: "error", errors: toValidationErrors(reason) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [appId]);

  // **【`V8-M21` の後半】ログインが成立したら、定義を取り直す。**
  //
  // **`GET /manifest` が今日からログインを要求するので、ログインの前と後で答えが変わる。**
  // **取り直さないと、ログインに成功しても未ログインの画面のまま止まる**(実測: E2E の
  // `auth` / `customer-signup` / `theme` などが `view-list` を見つけられずに落ちた)。
  //
  // **上の1本目に混ぜていない理由は実測である** —— **1本目の依存に本人確認の状態を足すと、
  // セッションが在る人でも定義を2回取り、画面の行の取得まで2倍になった**
  // (`web/test/theme-preview.test.tsx` の「プレビューを開くとレコード取得の回数が
  // 候補数の倍だけ増える」が `single` = 1 → 2 で落ちた)。
  // **したがって取り直すのは「未ログインの最小限で描いていた」ときだけである。**
  useEffect(() => {
    if (auth.status !== "authenticated" || publicInfo === null) {
      return;
    }
    let cancelled = false;
    fetchManifest(appId).then(
      (manifest) => {
        if (!cancelled) {
          setPublicInfo(null);
          setState({ status: "ready", value: manifest });
        }
      },
      (reason: unknown) => {
        if (!cancelled) {
          setPublicInfo(null);
          setState({ status: "error", errors: toValidationErrors(reason) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [appId, auth.status, publicInfo]);

  /*
   * **登録の直後、行き先の候補がちょうど1本のときだけ、その画面を自動で開く**
   * (`V10-M6-T01b` / `NV-G14`。見張りは `web/src/auth/signup-next.ts` の `useSignupAutoOpen`)。
   *
   * ## 【配る版には案内を1バイトも足していない。これはユーザの選択である】
   *
   * **育成用の版(`web/src/AppWorkspace.tsx`)は、候補を「次はこちら」の案内として並べて描く。**
   * **配る版はそれを1つも描かない —— 今日も、この差分の後も描かない。**
   * **したがって配る版で起きることは「自動で開く」だけであり、
   * 候補が2本以上のときと0本のときの見え方は1ピクセルも変わっていない**
   * (`useSignupAutoOpen` はその2つの場合に何もしないため)。
   *
   * ## 【フックの規則を守るために、ここに置いている】
   *
   * **この関数は、この行より下に早期 return を7本持つ**(機械で数えた。分岐としては5つ ——
   * 公開情報での分岐が2本・読み込み中が1本・取得失敗が1本・本人確認中が1本・未ログインが2本)。
   * **したがって候補の算出も見張りの呼び出しも、最初の return より前に置かなければならない。**
   * **`web/src/AppWorkspace.tsx` の側は return を1本しか持たないので、あちらは末尾に置いてある**
   * —— **同じ結線が2つの版で別の位置に在る。**
   *
   * ## 【誇張しない】
   *
   * - **候補を数えられるのは、本人確認が済み、かつ定義が読めているときだけである。**
   *   **それ以外は空配列を渡す** —— **空配列では見張りは1度も動かない。**
   * - **判定は既存の1本(`signupNextFormViews`)を呼ぶだけで、ここに書き写していない。**
   * - **行が既に在るかどうかは見ていない。** **二重に作られることを止めていない。**
   *
   * ## 【2026-08-22 訂正(`V10-M19-T01` / `FU-G6` / `ADR-0363`)。旧文を1バイトも消していない】
   *
   * **上の「## 【配る版には案内を1バイトも足していない。これはユーザの選択である】」の節は、
   * 今日の正ではない。** **配る版も、登録の直後の案内を描く。**
   *
   * - **描く1本は `web/src/auth/SignupNextNotice.tsx` である** ——
   *   **育成用の版(`web/src/AppWorkspace.tsx`)と同じ1本を呼んでおり、2本目を書いていない。**
   *   **文面は1文字も新しく作っていない。**
   * - **したがって、配る版で起きることは「自動で開く」だけではなくなった。**
   *   **候補が2本以上のときは、自動では開かないが案内は出る**(見え方が変わった)。
   *   **候補が0本のときは今日も1ピクセルも変わっていない** —— **案内を1つも描かない**
   *   (`ADR-0363` §Decision 3。ユーザ決定 `D-V10-24`)。
   * - **旧文を消していない理由は `ADR-0363` §Context 2 に書いてある** ——
   *   **旧文は「これはユーザの選択である」と書いており、その選択(`D-V10-11` / `D-V10-14`)は
   *   今日も文書として実在する。** **消すと、なぜ一度そう決めたのかが読めなくなる。**
   *   **【禁止】これを「doc を今日の正にした」とだけ読まない** —— **読む人は、
   *   「出さない」と書いた文と「出す」と書いた文の両方に出会う。**
   * - **選び直したのはユーザ決定 `D-V10-17` である。**
   */
  //
  // ## 【`V10-M19-T02` / `FU-G7b` / `ADR-0364`】**見える範囲に行がある候補を落とす関門を外側に足した**
  //
  // **旧(逐語)**:
  //
  //     const signupNextForms =
  //       auth.status === "authenticated" && state.status === "ready"
  //         ? signupNextFormViews(state.value, auth.user.role)
  //         : [];
  //     useSignupAutoOpen(appId, signupNextForms, auth.justSignedUpAsCustomer);
  //
  // **旧の右辺はそのまま `base` として渡している** —— **1つも条件を消していない。**
  // **下の JSX の `auth.justSignedUpAsCustomer ? signupNextForms : []` も1バイトも
  // 書き換えていない**(外すと `g-2` / `g-6` が赤くなる。`V10-M19-T01` の実測)。
  //
  // **【`justSignedUp` を渡す意味。ここが配る版で効く】** **上の `base` は「登録の直後か」を
  // 1ミリも見ていないので、渡さないとログインしているあいだずっと読取が走る。**
  // **`ADR-0364` が増やすと言ったのは「登録のたびに、候補1本につき1往復」だけである。**
  const { views: signupNextForms, autoOpenAllowed } = useSignupNextCandidates(
    appId,
    state.status === "ready" ? state.value : undefined,
    auth.status === "authenticated" ? auth.user.role : "",
    auth.status === "authenticated" && state.status === "ready"
      ? signupNextFormViews(state.value, auth.user.role)
      : [],
    auth.justSignedUpAsCustomer,
  );
  useSignupAutoOpen(appId, signupNextForms, auth.justSignedUpAsCustomer && autoOpenAllowed);

  /*
   * **未ログイン(定義が読めない)の分岐**(`V8-M21` / `D-V8-34`)。
   * **`web/src/AppWorkspace.tsx` と同じ形をもう一度書いている**(複製しているものに数える)。
   * **【丸めない】** **未ログインのまま公開画面を開くことは、配布物でも今日から
   * 成り立たない** —— **名前しか渡らないので、画面を描く材料が1つも無い。**
   *
   * **【2026-08-11 追記(`V8-M26-T05` / 台帳 `T-G27b` / `D-V8-57`)。旧文を1バイトも
   *   消していない】** **上の「配布物でも今日から成り立たない」は、今日から成り立つ。**
   * **`GET /public` が画面の定義と、その画面が描くのに要る表の定義を返すようになった。**
   * **`web/src/AppWorkspace.tsx` と同じ形をもう一度書いている**(複製しているものに数える)
   * —— **組み立ての本体(`publicManifest`)だけはあちらから import しており、2度書いていない。**
   */
  if (publicInfo !== null) {
    const openPublicView =
      viewId === undefined
        ? undefined
        : publicInfo.views.find((candidate) => candidate.id === viewId);
    if (openPublicView !== undefined) {
      const manifest = publicManifest(publicInfo);
      return (
        <AppThemeScope theme={publicInfo.theme}>
          <section data-testid="anonymous-workspace" className={cn("font-sans text-foreground")}>
            <header className={cn("app-header", "flex-wrap")}>
              <h2>{manifest.app.name}</h2>
              {/* **ログインへの導線は残す**(`T-G26b` / `T-G28`)。 */}
              <RouteLink to={{ kind: "app", appId }}>
                <span data-testid="anonymous-login-link">ログイン</span>
              </RouteLink>
            </header>
            <Body
              appId={appId}
              manifest={manifest}
              views={publicInfo.views.map(stripPublicViewTables)}
              viewId={openPublicView.id}
              recordId={recordId}
              {...(prefill === undefined ? {} : { prefill })}
            />
          </section>
        </AppThemeScope>
      );
    }
    return (
      // **テーマの器を立て、配色も当てる**(`data-testid="app-theme"` の要素)。
      // **【旧文の逐語。1バイトも消していない】** —— 「**ただし配色は1つも渡らない** ——
      // **テーマの出どころはアプリの定義であり、未ログインには渡らないからである**
      // (`D-V8-34`)。**【丸めない】** **未ログインのログイン画面は、今日から既定の配色で
      // 描かれる。**」
      // **メインが `D-V8-34` の逐語「ログイン画面も公開ページも今どおり出る」を根拠に、
      // `GET /public` へ配色を1キー足すと判断した** —— **したがって旧文は今日は偽である。**
      <AppThemeScope theme={publicInfo.theme}>
        <LoginPage
          appId={appId}
          appName={publicInfo.app.name}
          // **【`V8-M26-T05`】旧の逐語(1バイトも消していない)**:
          //   `publicInfo.views.map((view) => ({ id: view.id, name: view.name }) as unknown as View)`
          anonymousViews={publicInfo.views.map(stripPublicViewTables)}
          // **【`V8-M5-T04`。ユーザ決定 `D-V8-114`】登録に要る事実をそのまま渡す。**
          // **画面はこれを描くだけで、値域も可否も1つも組み立てていない。**
          // **宣言が無い応答(古いサーバ)では `undefined` になり、着手前の画面が出る。**
          signup={publicInfo.signup}
          onAuthenticated={auth.setAuthenticated}
        />
      </AppThemeScope>
    );
  }

  if (state.status === "loading") {
    return (
      <div className={cn("flex flex-col gap-s2 font-sans")}>
        <p className={cn("m-0", "text-note text-muted-foreground")}>読み込み中…</p>
        {["head", "body-1", "body-2"].map((slot) => (
          <Skeleton key={slot} className="h-6 w-full" />
        ))}
      </div>
    );
  }
  if (state.status === "error") {
    return <ErrorList errors={state.errors} />;
  }
  const manifest = state.value;

  if (auth.status === "loading") {
    return (
      <AppThemeScope theme={manifest.app.theme}>
        <p data-testid="auth-loading" className={cn("app-auth-loading", "m-0")}>
          読み込み中…
        </p>
      </AppThemeScope>
    );
  }

  if (auth.status === "anonymous") {
    /*
     * **未ログインでも見られると宣言された画面**(`ADR-0074`)。**既定はログイン画面で
     * ある** —— 宣言を1つも書いていないアプリは、ここでは1画面も開かない。
     */
    const anonymousViews = visibleViewsForRole(ANONYMOUS, manifest);
    const openView =
      viewId === undefined
        ? undefined
        : manifest.app.views.find(
            (view) => view.id === viewId && canUseView(ANONYMOUS, manifest, view),
          );
    if (openView !== undefined) {
      return (
        <AppThemeScope theme={manifest.app.theme}>
          <section data-testid="anonymous-workspace" className={cn("font-sans text-foreground")}>
            <header className={cn("app-header", "flex-wrap")}>
              <h2>{manifest.app.name}</h2>
              <RouteLink to={{ kind: "app", appId }}>
                <span data-testid="anonymous-login-link">ログイン</span>
              </RouteLink>
            </header>
            <Body
              appId={appId}
              manifest={manifest}
              views={anonymousViews}
              viewId={openView.id}
              recordId={recordId}
              {...(prefill === undefined ? {} : { prefill })}
            />
          </section>
        </AppThemeScope>
      );
    }
    return (
      <AppThemeScope theme={manifest.app.theme}>
        <LoginPage
          appId={appId}
          appName={manifest.app.name}
          anonymousViews={anonymousViews}
          onAuthenticated={auth.setAuthenticated}
        />
      </AppThemeScope>
    );
  }

  const user = auth.user;
  return (
    <AppThemeScope theme={manifest.app.theme}>
      <RoleProvider role={user.role} actorId={user.id}>
        <section className={cn("font-sans text-foreground")}>
          <header className={cn("app-header", "flex-wrap")}>
            <h2>{manifest.app.name}</h2>
            <span className={cn("current-user", "text-note")} data-testid="current-user">
              {user.username}
            </span>
            <Badge
              variant="muted"
              className={cn("current-role")}
              data-testid="current-role"
              data-role={user.role}
            >
              {/* **【`V8-M29` 第1波 / `D-V8-79`】`app.roles[].name` も見る**(`user_kinds` 側は残す) */}
              {/* **【`V8-M29` 第2波】旧(逐語)**: `roleLabel(user.role, declaredUserKinds(manifest), declaredRoleKinds(manifest))` */}
              {roleLabel(user.role, declaredRoleKinds(manifest))}
            </Badge>
            {/*
             * **本人の資格情報の口だけを残す**(パスワードの変更と退会)。**運営の権限の
             * 話ではないので、配布物から外す理由が無い。** **外した7本との違いは
             * `docs/plan/v5/records/v5-m4.md` §2 に列挙してある。**
             */}
            <Button size="sm" data-testid="open-account" onClick={() => setAccountOpen(true)}>
              アカウント
            </Button>
            <Button size="sm" data-testid="logout" onClick={() => void auth.signOut()}>
              ログアウト
            </Button>
          </header>
          {/*
           * **登録の直後の案内**(`V10-M19-T01` / `FU-G6` / `ADR-0363`)。
           *
           * **外側の門を書いていない** —— **`SignupNextNotice` が候補0本で `null` を返す。**
           * **候補の本数を見る門の字面をこのファイルに1文字も書かないのは、
           * `ADR-0363` 限定3 がその当たりを `web/src/` で1行に固定しているためである**
           * (**その式をこの doc に書き写すことも同じ理由でしない** ——
           * **書き写した瞬間に当たりが増えて、式の値が動く**)。
           *
           * **位置は「ヘッダの直後・本体の手前」である**(`ADR-0363` の限界1 が
           * 「決めるのは `V10-M19-T01` である」と書いている)——
           * **育成用の版(`web/src/AppWorkspace.tsx`)と同じ並び順にした。**
           * **アカウントの画面を開いているあいだも出る** —— **そこも育成用の版と同じである。**
           *
           * **【`justSignedUpAsCustomer` の関門をここで掛けている。実測で分かった】**
           * **上の `signupNextForms` は「登録の直後か」を1ミリも見ていない** ——
           * **見張り(`useSignupAutoOpen`)がその判定を自分で持っているため、
           * 掛ける必要が無かったからである。** **育成用の版の側の同名の定数は
           * `justSignedUpAsCustomer ? … : []` で既に絞ってある**(`AppWorkspace.tsx`)。
           * **絞らずに渡すと、登録の直後でなくても —— ただログインしただけでも ——
           * 案内が出続ける**(`web/test/runner-signup-auto-open.test.tsx` の `g-6` が、
           * 実際にその形で赤くなった)。 **`signupNextForms` の定義は1バイトも書き換えず、
           * 関門をこの1箇所に足した** —— **見張りに渡す配列を変えないためである。**
           */}
          <SignupNextNotice
            appId={appId}
            views={auth.justSignedUpAsCustomer ? signupNextForms : []}
            onDismiss={auth.dismissSignupNotice}
          />
          {accountOpen ? (
            <AccountPanel
              appId={appId}
              username={user.username}
              onClose={() => setAccountOpen(false)}
              onWithdrawn={() => {
                setAccountOpen(false);
                void auth.signOut();
              }}
            />
          ) : (
            <Body
              appId={appId}
              manifest={manifest}
              views={visibleViewsForRole(user.role, manifest)}
              viewId={viewId}
              recordId={recordId}
              {...(prefill === undefined ? {} : { prefill })}
            />
          )}
        </section>
      </RoleProvider>
    </AppThemeScope>
  );
}

/**
 * 画面の並びと、選んだ画面。**画面の並びの器(`.workspace-body` / `.view-list` /
 * `.workspace-main`)は `web/src/styles.css` の既存の規則をそのまま使う** ——
 * CSS を1行も足していない。
 */
function Body({
  appId,
  manifest,
  views,
  viewId,
  recordId,
  prefill,
}: {
  appId: string;
  manifest: Manifest;
  views: readonly View[];
  viewId?: string | undefined;
  recordId?: string | undefined;
  prefill?: RoutePrefill | undefined;
}) {
  return (
    <div className="workspace-body">
      <nav className="view-list" data-testid="view-list">
        {views.length === 0 && (
          // **黙って空の並びを出さない**(憲法6)。**「壊れている」と「何も無い」を
          // 区別できない画面を出さない。**
          <p data-testid="view-list-empty" className={cn("m-0", "text-muted-foreground")}>
            いま使える画面がありません。壊れているわけではありません。
          </p>
        )}
        <ul className={cn("flex flex-col gap-s1")}>
          {views.map((view) => (
            <li
              key={view.id}
              className={cn("flex flex-wrap items-baseline gap-s1")}
              {...(view.id === viewId ? { "aria-current": "page" as const } : {})}
            >
              <RouteLink to={{ kind: "view", appId, viewId: view.id }}>
                {viewDisplayName(view)}
              </RouteLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="workspace-main" data-testid="workspace-main">
        {viewId !== undefined && (
          <Selected
            appId={appId}
            manifest={manifest}
            viewId={viewId}
            recordId={recordId}
            {...(prefill === undefined ? {} : { prefill })}
          />
        )}
      </div>
    </div>
  );
}

/** URL のビューID をマニフェストで解決してディスパッチ層に渡す。 */
function Selected({
  appId,
  manifest,
  viewId,
  recordId,
  prefill,
}: {
  appId: string;
  manifest: Manifest;
  viewId: string;
  recordId?: string | undefined;
  prefill?: RoutePrefill | undefined;
}) {
  const view = manifest.app.views.find((candidate) => candidate.id === viewId);
  if (view === undefined) {
    return (
      <ErrorList
        errors={[
          {
            path: "",
            message: `ビュー "${viewId}" はこのアプリのマニフェストにありません。`,
            allowed_values: manifest.app.views.map((candidate) => candidate.id),
          },
        ]}
      />
    );
  }
  return (
    <ViewHost
      appId={appId}
      manifest={manifest}
      view={view}
      recordId={recordId}
      {...(prefill === undefined ? {} : { prefill })}
    />
  );
}
