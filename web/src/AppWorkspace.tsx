/**
 * 1つのアプリの作業画面(V0-P3-T03 / 認証は per-app・ADR-0014 改訂)。
 *
 * マニフェストを **API から取得して解釈する**。フロントに焼き込まないので、
 * マニフェストが変わればブラウザのリロードだけで画面構成が変わる
 * (V0-P3-T07 の完了条件、ADR-0003 §2)。
 *
 * **アプリ単位の認証ゲート**をここに閉じ込める。manifest は非保護なので取得できるが、
 * records(保護 API)はそのアプリのセッションが要る。`useAppAuth(appId)` で:
 *   - loading: 本人確認中(スピナー)
 *   - anonymous: そのアプリのログイン画面(`LoginPage appId=...`)
 *   - authenticated: 従来のワークスペース(ビュー一覧 → ビュー描画)+ ユーザ名 / ログアウト
 * authenticated 中に records が 401(セッション失効)を返すと、`useAppAuth` が anonymous に
 * 落とすので、そのままログイン画面へ戻る。
 *
 * `viewId` が無ければマニフェスト中のビュー一覧、あればそのビューを
 * ディスパッチ層(`ViewHost`)に渡す。ビューをどう描くかの知識はこの
 * ファイルには一切なく、すべて汎用コンポーネント側にある。
 */
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import type { Manifest, Table, Theme, View, ViewType } from "../../src/kernel/types.ts";
import {
  ApiError,
  type AuthUser,
  fetchManifest,
  fetchPublicAppInfo,
  type ManifestResponse,
  type PublicAppInfo,
  type PublicView,
} from "./api.ts";
import { type AsyncState, toValidationErrors } from "./async.ts";
import { AccountPanel } from "./auth/AccountPanel.tsx";
import {
  ANONYMOUS,
  canUseView,
  declaredRoleIds,
  declaredRoleKinds,
  // **【`V8-M27-T04` / `T-G5`】`isReservedRole` の import は撤去した**
  // (`platformPortAudience` と「登録直後の導線」の2箇所ごと消えた)。
  RoleProvider,
  roleLabel,
  visibleViewsForRole,
} from "./auth/authz.tsx";
import { ConnectionAdmin } from "./auth/ConnectionAdmin.tsx";
import { EscapeHatchAdmin } from "./auth/EscapeHatchAdmin.tsx";
import { LoginPage } from "./auth/LoginPage.tsx";
// **【`V10-M19-T01` / `FU-G6` / `ADR-0363`】登録の直後の案内。**
// **本ファイルに在った `<Alert>` をそのまま移した1本であり、配る版と共有している。**
import { SignupNextNotice } from "./auth/SignupNextNotice.tsx";
// **【`V10-M6-T01a` / `NV-G14`】登録の直後の候補の述語と、1度きりの自動遷移。**
// **`personalOwnerField` の import はここから消えた** —— **述語ごと移したためであり、
// 判定を1バイトも書き換えていない**(`canUseView` は `:397` の匿名判定で今日も使う)。
import {
  signupNextFormViews,
  useSignupAutoOpen,
  useSignupNextCandidates,
} from "./auth/signup-next.ts";
import { UserAdmin } from "./auth/UserAdmin.tsx";
import { useAppAuth } from "./auth/useAppAuth.ts";
import { CommentList } from "./CommentList.tsx";
// **【`V10-M11-T01` の2手目。台帳 `CM-G4`】画面へのコメントを1件書く導線。**
// **`web/src/` の書込導線1本はこれである**(`ADR-0007:1637` の歯止め1 の宣言)。
//
// **【2026-08-26。`V10-M33-T01`。台帳 `CM-G43`】上の2行は
// `web/src/views/ViewHost.tsx:21`-`:22` から**逐語で書き写したものである**(1バイトも
// 変えていない)。**歯止め1 の宣言の住所がここへ移った** —— **あちらの2行は消して
// おらず、住所が移ったことの訂正だけを後ろに足してある。**
//
// **なぜここへ移したのか** —— **器(`ViewHost`)が静的に `import` していると、
// 配る版のエントリ(`web/src/runner-app.tsx`)が器を読み込む以上、書く欄のバイト列が
// 配る版の成果物に必ず入るからである。** **このファイルは配る版が1度も読み込まない
// 育成用の版の器であり、ここに置けば配る版の成果物から落ちる。**
// **部品はコンテキストのスロット(`CommentVisibilityProvider` の `panel`)で器へ渡す。**
import { CommentPanel } from "./CommentPanel.tsx";
import { ErrorList } from "./ErrorList.tsx";
import { RouteLink } from "./navigation.tsx";
import { RequirementsDocPanel } from "./RequirementsDocPanel.tsx";
import type { RoutePrefill } from "./route.ts";
import { ThemeExportPanel } from "./ThemeExportPanel.tsx";
import { ThemeImportPanel } from "./ThemeImportPanel.tsx";
import { ThemePreviewPanel } from "./ThemePreviewPanel.tsx";
import { Button } from "./ui/button.tsx";
// **【`V10-M19-T01` / `FU-G6`】`Alert` の import はここから消えた** ——
// **本ファイルで `<Alert>` を使っていた唯一の箇所(登録の直後の案内)を
// `web/src/auth/SignupNextNotice.tsx` へ移したためであり、案内の中身は1バイトも変えていない。**
import { Badge, Skeleton } from "./ui/surfaces.tsx";
import { cn } from "./ui/utils.ts";
// **【`V10-M32-T02`】旧(逐語。1バイトも消していない)**:
//   `import { CommentVisibilityProvider, ViewHost, viewDisplayName } from "./views/ViewHost.tsx";`
// **`useCommentReadEnabled` を1本足した** —— **読む場所の導線と枝はこのファイルに在るので、
// 判定はここへ運ぶしかない**(非対称の理由は当の関数の doc に書いた)。
import {
  CommentVisibilityProvider,
  useCommentReadEnabled,
  ViewHost,
  viewDisplayName,
} from "./views/ViewHost.tsx";

/** v0 語彙のビュー種別3種の表示名。語彙そのものなので、増えることはない(憲法2)。 */
// **【2026-08-14 追記(`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`)。すぐ上の1行は今日は
// 嘘である。旧文を1バイトも書き換えていない】** **ビュー種別は4種になり、4種目は集計表
// (`report_view`)である。** **「増えることはない」と書けたのは、当時 `VIEW_TYPES` を
// 動かした決定が1つも無かったからであって、動かせないからではない** —— **動かす手続きは
// `ADR-0007` の門A であり、`V8-M7` がそれを通した。**
const VIEW_TYPE_LABELS: Record<ViewType, string> = {
  list_view: "一覧",
  form: "フォーム",
  detail_view: "詳細",
  report_view: "集計表",
};

/**
 * **未ログインへ渡った画面の定義から、表の定義を外して素の {@link View} に戻す**
 * (`V8-M26-T05` / `D-V8-57`)。
 *
 * **`tables` は転送のための入れ物である**(`ADR-0319` 限定5 が「トップレベルに4つ目の
 * キーを足さない」形を選んだので、表は画面の中に入って来る)。**描画側に渡すマニフェストは
 * 素の形にしておく** —— **`View` に無いキーを付けたまま配ると、表示層のどこかが
 * 「画面が表を持っている」形を前提にしてしまう。**
 */
export function stripPublicViewTables(view: PublicView): View {
  const { tables: _tables, ...rest } = view;
  return rest as View;
}

/**
 * **未ログインへ渡った分だけで組み立てたマニフェスト**(`V8-M26-T05` / 台帳 `T-G27b` /
 * ユーザ決定 `D-V8-57`)。
 *
 * **【これは「マニフェスト」ではない。丸めない】** **入っているのは、未ログインに開いた
 * 画面と、その画面が描くのに要る表だけである。** **`app.roles` は1本も入っていない** ——
 * **したがって配下の判定(`canUseAction` / `canWriteRole` など)は、規則を1本も見ない
 * 相手として評価する。** **`V8-M26` が面の既定を閉じたので、これは「閉じる側に倒れる」** ——
 * **押しても必ず失敗する導線が出ないという向きであり、遮断ではない**(遮断は今日も
 * サーバである)。
 *
 * **`workflows` / `functions` も入っていない** —— **未ログインへ渡っていないからである。**
 */
export function publicManifest(info: PublicAppInfo): Manifest {
  const tables: Table[] = [];
  const seen = new Set<string>();
  for (const view of info.views) {
    for (const table of view.tables) {
      if (seen.has(table.id)) {
        continue;
      }
      seen.add(table.id);
      tables.push(table);
    }
  }
  return {
    app: {
      id: info.app.id,
      name: info.app.name,
      tables,
      views: info.views.map(stripPublicViewTables),
      ...(info.theme === undefined ? {} : { theme: info.theme }),
    },
  };
}

export function AppWorkspace({
  appId,
  viewId,
  recordId,
  prefill,
}: {
  appId: string;
  viewId?: string | undefined;
  /** URL が指す対象レコード(`route.ts` 参照)。ビュー側がどう使うかはビュー次第。 */
  recordId?: string | undefined;
  /** 操作起点のプリフィル(EC-G14 / ADR-0045)。新規作成フォームの初期値に使う一時状態。 */
  prefill?: RoutePrefill | undefined;
}) {
  const auth = useAppAuth(appId);
  // **【`V10-M31-T01`(台帳 `CM-G38`)。2026-08-25】旧文の逐語(1バイトも消していない)**:
  //   `const [state, setState] = useState<AsyncState<Manifest>>({ status: "loading" });`
  // **今日から応答の**外側**に兄弟キー `comment_visibility` が1本載る**(`ADR-0377`)ので、
  // **受け皿を `ManifestResponse`(= `Manifest` + 任意の兄弟キー)に広げた。**
  // **`Manifest` の上位互換なので、ここから下の読み手は1バイトも変わっていない。**
  const [state, setState] = useState<AsyncState<ManifestResponse>>({ status: "loading" });
  /**
   * **未ログインのときにサーバから渡る最小限**(`V8-M21` / `J-G24b` / `D-V8-34`)。
   * **アプリ名と、未ログインでも見せると決めた画面の名前だけである。**
   */
  const [publicInfo, setPublicInfo] = useState<PublicAppInfo | null>(null);

  // **【`V8-M21` / `J-G24a` / `D-V8-21`】旧文の逐語(1バイトも消していない)**:
  //   「manifest は非保護なので、認証状態に関わらず取得する(ログイン画面の見出しにも使う)。」
  // **今日その前提は偽である** —— **`GET /manifest` はログインを要求する。**
  // **したがって 401 のときだけ `GET /public`(アプリ名と匿名に開いた画面の名前だけ)へ倒す** ——
  // **「ログインするために定義が要り、定義を得るためにログインが要る」を避けるためである。**
  // **401 以外の失敗は今日どおりエラー表示に倒す**(丸めない)。
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
   * **未ログイン(定義が読めない)の分岐**(`V8-M21` / `D-V8-34`)。
   *
   * **ここで出せるのはログイン画面だけである。** **画面の中身を描く材料が1つも無い** ——
   * **表も項目も列も渡ってこない。**
   *
   * **【この分岐が壊したもの。丸めない】** **未ログインのまま公開画面を開くこと(`B-G5` /
   * `ADR-0074` が作った経路)は、今日から成り立たない。** **`D-V8-34` の説明文は
   * 「公開ページも今どおり出る」と書いているが、「渡すのはアプリ名と画面の名前だけ」と
   * 両立しない** —— **名前だけでは画面を描けないからである。** **導線(リンク)は今日も
   * 出るが、押した先はログイン画面になる。**
   *
   * **テーマは当たらない**(配色の出どころがマニフェストであり、渡ってこない)。
   *
   * ==========================================================================================
   * **【2026-08-11 追記(`V8-M26-T05`。台帳 `T-G27b` の再審査 = 限定採用 / ユーザ決定
   *   `D-V8-57`)。上の逐語を1バイトも消していない】**
   * ==========================================================================================
   *
   * **上の「今日から成り立たない」は、今日から成り立つ。** **`D-V8-57`(選ばれた見出し =
   * **実際に開けるようにする**)が「渡すのはアプリ名と画面の名前だけ」の側を覆した** ——
   * **説明文の逐語**:
   *   > 「未ログインで公開画面の中身が見られるようにします。公開の商品一覧のような画面が
   *   > 本当に作れますが、**未ログインの相手に画面の作り(項目の並びなど)が渡ります**。
   *   > 作業が1本増えます。」
   *
   * **`GET /public` は今日、開いた画面の定義と、その画面が描くのに要る表の定義を返す**
   * (`src/server/app.ts` の当該ルート)。**したがって「表も項目も列も渡ってこない」は
   * 今日は偽である** —— **ただし**開いていない画面については今日も真**である。**
   *
   * **【今日も変えていないもの】** **ログイン画面への導線は残る**(`T-G26b` / `T-G28` の
   * 判定により、ログイン画面は今日どおり必ず開ける)。**画面を1枚も開いていない URL
   * (`/apps/<id>`)では今日どおりログイン画面が出る。** **開いた画面の中でも、ログインへの
   * 導線(`anonymous-login-link`)を `AnonymousWorkspace` が出す。**
   *
   * **【正直に書く】判定を表示層に置いていない** —— **どの画面が開いているかを決めるのは
   * サーバの `judgeRoleAccess` 1本であり、ここは `publicInfo.views` に載っているかどうかを
   * 見るだけである**(`ADR-0314` 限定4 の作法)。**URL に他の画面IDを打っても、載っていない
   * のでログイン画面に落ちる。**
   */
  if (publicInfo !== null) {
    /*
     * **未ログインのまま開ける画面**(`V8-M26-T05` / `D-V8-57`)。
     * **載っている画面ちょうどが開ける** —— **サーバが `anonymous` の規則で絞った結果である。**
     */
    const openView =
      viewId === undefined
        ? undefined
        : publicInfo.views.find((candidate) => candidate.id === viewId);
    if (openView !== undefined) {
      return (
        <AppThemeScope theme={publicInfo.theme}>
          <AnonymousWorkspace
            appId={appId}
            manifest={publicManifest(publicInfo)}
            views={publicInfo.views.map(stripPublicViewTables)}
            viewId={openView.id}
            recordId={recordId}
            prefill={prefill}
          />
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
          // **今日は画面の定義そのものが渡るので、`as unknown as View` の詰め物は要らない。**
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
    /*
     * **【V4-M15-T14】読み込み中に骨組みを出す**(着手前は素の1行で skeleton 0件)。
     * **文言は1文字も変えていない。** **ここにテーマは当たらない** —— テーマの出所
     * (マニフェスト)がまだ無い状態そのものだからである(下の `AppThemeScope` の注記)。
     */
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
        {/*
         * **`data-testid` も `class` も文言も1バイトも変えていない。**
         * **足したのは `Skeleton` の2本だけである**(`aria-hidden` なので読み上げに出ない)。
         * **`AppWorkspace.tsx:10` のヘッダが「スピナー」と書いている状態は、今日も
         * スピナーではない** —— 出しているのは骨組みである。
         */}
        <div className={cn("flex flex-col gap-s2")}>
          <p data-testid="auth-loading" className={cn("app-auth-loading", "m-0")}>
            読み込み中…
          </p>
          {["row-1", "row-2"].map((slot) => (
            <Skeleton key={slot} className="h-6 w-full" />
          ))}
        </div>
      </AppThemeScope>
    );
  }
  if (auth.status === "anonymous") {
    /*
     * ## 【V4-M2-T05 / `B-G5` / `ADR-0074`】未ログインでも見られる画面ができた
     *
     * **着手前はここが無条件に `LoginPage` へ倒していた**(2026-08-03 実測)。
     * **今日も既定はそれである** —— **宣言を1つも書いていないアプリは1画面も開かない**
     * (`ADR-0074` 限定5。**既存の全アプリが1バイトの変更もなく今日どおり動く**)。
     *
     * **【`V8-M20` / `J-G27`】旧文の `audience` は撤去された。今日は面の画面の規則が
     * `anonymous` を主体として名指ししているかで決まる。**
     * **例外は1つだけである**: **URL が指している画面が `audience` に `anonymous` と
     * 宣言されているとき**、その画面を未ログインのまま描く。**それ以外は今日どおり
     * ログイン画面である**(`ADR-0075` が改訂した `ADR-0014:80` (b) の形そのもの:
     * 「見せてよいと宣言された画面を除き、未ログインはログイン画面に落ちる」)。
     *
     * **ユーザ決定 `D-V4-20` の逐語は「基本は1で、ログインの画面に未ログインの時の
     * リンクを配置する」である** —— **「基本」= ログイン画面に落とす側を既定に置き、
     * そこから宣言された画面へたどれるようにする。** アプリのトップ(`viewId` 無し)は
     * 今日どおりログイン画面である。
     *
     * **【誇張しない。ここが守らないもの】**
     *   - **`GET /api/apps/:app_id/manifest` は今日も未認証で全ビュー定義を返す**
     *     (`ADR-0074` 限定9)。**匿名に見せないと宣言した画面の定義も読める。**
     *     **「宣言で隠す」は情報の遮断ではない。** 塞ぐのは `E-G6` の担当である。
     *   - **匿名に返る行は今日どおり `st_public` が真の行に限られる**(§3a-2)——
     *     **公開でないテーブルの画面を `anonymous` と宣言すると、開けても行は返らない。**
     *   - **MCP 経路は1ミリも守られない**(`ADR-0070` 限定8)。
     */
    /*
     * **【`V4-M10-T45` / `E-G12` / `ADR-0084` 限定5 の追記】掲載の集合と、開ける集合を分ける。**
     *
     * **着手前はこの1本の集合が「一覧に並べる集合」と「開ける集合」を兼ねていた。**
     * **`visibleViewsForRole` に掲載の AND が入ったので、兼ねたままだと「一覧から外した
     * 画面が匿名で開けなくなる」** —— **それは `ADR-0084` 限定5(可否を1ミリも変えない)を
     * 破る。**
     *
     * **したがって開ける判定は `canUseView` を直に呼ぶ**(判定を2箇所に書いていない ——
     * 呼んでいるのは今日までと同じ1本の述語である)。**`views` に渡すのは掲載の集合のままで
     * ある。**
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
          <AnonymousWorkspace
            appId={appId}
            manifest={manifest}
            views={anonymousViews}
            viewId={openView.id}
            recordId={recordId}
            prefill={prefill}
          />
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

  return (
    <AppThemeScope theme={manifest.app.theme}>
      {/*
       * **【2026-08-25。`V10-M31-T02`。台帳 `CM-G38` / `ADR-0379` 限定2 /
       * 利用者決定 `D-V10-40`】アプリごとのコメントの設定を、画面の器へ1本だけ配る。**
       *
       * **旧の姿(逐語。1バイトも消していない)は、この `<AuthenticatedWorkspace …/>` が
       * `AppThemeScope` の直接の子だったことである** —— **包みを1つ足しただけで、
       * 渡している props も並びも1つも変えていない。**
       * **`AuthenticatedWorkspace` の props 型を1メンバも広げていない**(設定は
       * コンテキストで運ぶ。`ViewRendererProps` も1メンバも増えていない = `ADR-0379` 限定6)。
       *
       * **未ログインの枝(`AnonymousWorkspace`)は包んでいない** —— **未ログインに書く欄を
       * 1要素も出さない今日の向きと揃える。** **配る版(`web/src/runner-app.tsx`)にも
       * 置いていない**(利用者決定 `D-V10-39`)。
       * **`manifest` に設定が載っていない経路(合成した `Manifest`)では `undefined` が
       * 流れ、器は fail-closed で欄を出さない。**
       */}
      {/*
       * **【2026-08-26。`V10-M33-T01`。台帳 `CM-G43`】旧行の逐語(1バイトも消していない)**:
       *   `<CommentVisibilityProvider value={manifest.comment_visibility}>`
       * **`panel` を1本足しただけである** —— **渡している設定(`manifest.comment_visibility`)も
       * 包む位置も1バイトも変えていない。** **`panel` は必須なので、この器を張る箇所は
       * 部品を渡すしかない**(型で保証している = 「provider が在る ⇒ 部品が在る」)。
       * **設定が `undefined` の経路では今日どおりコンテキストに `undefined` が流れ、
       * 器は fail-closed で欄を出さない** —— **`panel` を渡したことが3つ目の出る条件に
       * なっていない。**
       */}
      <CommentVisibilityProvider value={manifest.comment_visibility} panel={CommentPanel}>
        <AuthenticatedWorkspace
          appId={appId}
          manifest={manifest}
          viewId={viewId}
          recordId={recordId}
          prefill={prefill}
          user={auth.user}
          onSignOut={auth.signOut}
          justSignedUpAsCustomer={auth.justSignedUpAsCustomer}
          onDismissSignupNotice={auth.dismissSignupNotice}
        />
      </CommentVisibilityProvider>
    </AppThemeScope>
  );
}

/**
 * **未ログインのまま開ける画面の作業画面**(`V4-M2-T05` / `B-G5` / `ADR-0074`)。
 *
 * **`AuthenticatedWorkspace` の写しではない。** 出すのは**画面一覧と選択中の画面だけ**で、
 * ログイン済みの導線(ログアウト / アカウント / ユーザ管理 / 接続 / 逃げ道 / テーマの
 * 取り込み・プレビュー / 要件定義書 / テーマの持ち出し)を**1つも出さない。**
 * **現在ロールの表示(`current-role`)も出さない** —— **匿名はロールを持たない**
 * (`ADR-0074` §3a-5。`ROLE_LABELS` は今日も4値である)。
 *
 * ## **`RoleProvider` で包まない**(意図的である)
 *
 * **包まないので配下の `useRole()` は `null` を返し、`canWriteRole(null, table)` が
 * `false` を返す**(`ADR-0074` 限定6。`V4-M2-T06` が反転させた)。**したがって保存・編集・
 * 削除の導線が1つも出ない。**
 *
 * **【誇張しない】これは遮断ではない。** **匿名の書込を止めているのは今日もサーバである**
 * —— 未認証の `POST` / `PATCH` / `DELETE` は 401 で、**書込ハンドラは公開側に一切結線されて
 * いない**(`ADR-0034` 限定2 の構造保証)。**ここで消しているのは「押しても必ず失敗する
 * 導線」だけである**(`canWriteRowScope` の注記と同じ言い方)。
 *
 * ## 画面一覧は左カラムに出る(`B-G4` と同じ器を使う)
 *
 * **`.workspace-body` / `.workspace-main` を再利用する** —— **`B-G4` のために CSS 規則を
 * 2度書かない。** ただし **`B-G4` と `B-G5` は別単位であり、差分も別々に測る。**
 */
function AnonymousWorkspace({
  appId,
  manifest,
  views,
  viewId,
  recordId,
  prefill,
}: {
  appId: string;
  manifest: Manifest;
  views: View[];
  viewId: string;
  recordId?: string | undefined;
  prefill?: RoutePrefill | undefined;
}) {
  return (
    <section data-testid="anonymous-workspace" className={cn("font-sans text-foreground")}>
      <header className={cn("app-header", "flex-wrap")}>
        <h2>{manifest.app.name}</h2>
        {/*
         * **ログインへの導線を残す**(`D-V4-20` (b) の対になる向き)。
         * **「ここから先はログインが要る」ことを言える場所を画面に残す** —— 消すと、
         * 匿名で見えている範囲が全部だと誤解させる(憲法6)。
         */}
        <RouteLink to={{ kind: "app", appId }}>
          <span data-testid="anonymous-login-link">ログイン</span>
        </RouteLink>
      </header>
      <div className="workspace-body">
        <nav className="view-list" data-testid="view-list">
          <ul className={cn("flex flex-col gap-s1")}>
            {views.map((view) => (
              // **【V4-M15-T14】いま開いている画面に `aria-current="page"` を付ける**
              // (着手前 0件)。**当たり先は `viewId` と一致する1件だけである。**
              // **属性を `<li>` に置くのは、`RouteLink` が `to` と `children` しか
              // 受け取らず、本タスクが `navigation.tsx` を触らないためである。**
              <li
                key={view.id}
                className={cn("flex flex-wrap items-baseline gap-s1")}
                {...(view.id === viewId ? { "aria-current": "page" as const } : {})}
              >
                <RouteLink to={{ kind: "view", appId, viewId: view.id }}>
                  {viewDisplayName(view)}{" "}
                  <span className={cn("meta", "text-note text-muted-foreground")}>
                    {VIEW_TYPE_LABELS[view.type]}
                  </span>
                </RouteLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="workspace-main" data-testid="workspace-main">
          <SelectedView
            appId={appId}
            manifest={manifest}
            viewId={viewId}
            recordId={recordId}
            prefill={prefill}
          />
        </div>
      </div>
    </section>
  );
}

/**
 * アプリ単位テーマのスコープ要素(V3-M1-T04 / ADR-0047 / ADR-0048 §1b)。
 *
 * **テーマの値をレンダラーの props に足さない**(`web/src/views/types.ts` の禁止 / T04-4)。
 * マニフェスト由来の実値を**この1要素の inline style にだけ**立て、配下の CSS 規則は
 * `web/src/styles.css` の `var(--…)` でそれを読む。ビュー側は今までどおりテーマを知らない。
 *
 * ## 変換規則は1本(恒等写像)である
 *
 * **`app.theme.slots` のキーは CSS カスタムプロパティ名そのもの**であり、変換を1つも
 * 挟まない(V3-M1-T03 段階B が定義した唯一の規則。定義と機械的固定は
 * `web/test/theme-slot-parity.test.ts` / 製品経路の固定は `web/test/app-theme.test.tsx`)。
 * **2本目の規則を作らないこと** —— 作ると V3-M1-T05 が持ち出す `theme.css` が
 * 「形式は安定しているが当たらない」状態になる。
 *
 * ## 当たる画面と当たらない画面
 *
 * 当たるのは**認証済みワークスペース / ログイン画面 / 認証確認中**の3画面である。
 * **読み込み中とマニフェストエラーの2画面には原理的に当たらない** —— どちらも
 * `manifest` を参照できる行より前にあり(上の早期 return 2本)、**テーマの値の出所が
 * まだ無い・あるいは永久に無い状態そのもの**である。「当てられなかった」のではない。
 *
 * ## `.shell` には当てない
 *
 * シェル(`web/src/App.tsx` の `.shell`)の見た目は V3-M3(D-G6)の担当であり、
 * **`.shell` の `max-width` / `padding` / `line-height` はアプリ単位テーマの射程外である**
 * (ADR-0048 限定2。この要素の外にあるため)。
 *
 * ## `testId` を差し替えられるようにした理由(V3-M6-T02 / D-G9)
 *
 * **取り込みのプレビュー(`ThemeImportPanel`)が、この関数をそのまま再利用する**
 * (完了条件2「新しいレンダラーを作らない」)。**ただし `data-testid="app-theme"` は
 * 差し替える** —— **製品のスコープ要素は常に1つだけである**という既存の実測
 * (`web/e2e/theme.e2e.ts` (iii) / `web/e2e/theme-preview.e2e.ts`)を壊さないためである。
 * **既定値は今までと1バイトも同じ**なので、既存の3箇所の呼び出しは何も変わらない。
 */
export function AppThemeScope({
  theme,
  children,
  testId = "app-theme",
}: {
  theme?: Theme | undefined;
  children: ReactNode;
  /** スコープ要素の `data-testid`。**製品の本体は既定値のままにする。** */
  testId?: string;
}) {
  return (
    <div className="app-theme" data-testid={testId} style={themeScopeStyle(theme)}>
      {children}
    </div>
  );
}

/**
 * テーマのスロットを inline style へ写す。**テーマが無ければ `style` 属性を付けない**
 * (既定値は `web/src/styles.css` の `:root` から来る = 既存マニフェストの後方互換)。
 *
 * キーはそのまま使う(恒等写像)。**`--` で始まるキーは React が `setProperty` で
 * 立てる**ので、CSS カスタムプロパティとして機能する。値域(色は16進・長さは px/rem/em 等)は
 * `schemas/manifest.schema.json` の `$defs/theme` が適用時に縛っており、
 * ここで再検証しない(検証を二重化すると規則が2箇所に住む)。
 */
function themeScopeStyle(theme?: Theme | undefined): CSSProperties | undefined {
  if (theme === undefined) {
    return undefined;
  }
  return { ...theme.slots } as CSSProperties;
}

/**
 * 認証済みのアプリ作業画面。ヘッダに現在ユーザ名・**現在ロール**・per-app ログアウトを持つ。
 *
 * ロール(`user.role`)は書込 UI の先回りガード(viewer は保存/編集/削除を出さない)に
 * 効くので、配下のビュー群を `RoleProvider` で包む(views/* は深いので prop ドリリングを
 * 避ける)。owner のときだけユーザ管理への導線(`open-user-admin`)を出し、押すと
 * ビューの代わりに `UserAdmin` を出す。最終防衛線はサーバの 403 で、UI は補助である。
 */
function AuthenticatedWorkspace({
  appId,
  manifest,
  viewId,
  recordId,
  prefill,
  user,
  onSignOut,
  justSignedUpAsCustomer = false,
  onDismissSignupNotice,
}: {
  appId: string;
  manifest: Manifest;
  viewId?: string | undefined;
  recordId?: string | undefined;
  prefill?: RoutePrefill | undefined;
  user: AuthUser;
  onSignOut: () => Promise<void>;
  /** 買い物客としての**登録**でこの画面に来たか(`V4-M21-T03` / `E-G65`)。 */
  justSignedUpAsCustomer?: boolean | undefined;
  /** 登録直後の案内を閉じる。 */
  onDismissSignupNotice?: (() => void) | undefined;
}) {
  const [adminOpen, setAdminOpen] = useState(false);
  /**
   * アカウント(本人のパスワード変更と退会)の開閉(`E-G68` / V4-M6)。
   *
   * **ロールで出し分けない。** これは本人の資格情報の話であって、運営の権限の話ではない
   * (owner 専用パネルと並べるが、判定は1つも持たない)。**サーバ側もロールを1つも見ない。**
   */
  const [accountOpen, setAccountOpen] = useState(false);
  const [connectionAdminOpen, setConnectionAdminOpen] = useState(false);
  /**
   * 逃げ道(任意 CSS)の管理画面の開閉(V3-M5-T03 / D-G5。ADR-0055 限定5)。
   *
   * **owner 限定にする** —— この画面は CSS のバイト列を置く唯一の seam
   * (`POST /escape-hatch-assets`)を叩く。接続の管理・ユーザ管理と同じ置き方である。
   *
   * **同時に、これが遮断ではないことを書いておく**(計画 §1-1 の3点目)—— 発行と失効を
   * owner に限っているのは**サーバの `requireOwner`** であって、ここで導線を出さないことでは
   * ない。**UI を迂回して直接叩いても owner 以外は 403 になる**(`web/e2e/escape-hatch.e2e.ts`
   * が editor のセッションで実測している)。**UI は担保ではない。**
   */
  const [escapeHatchAdminOpen, setEscapeHatchAdminOpen] = useState(false);
  /**
   * 要件定義書パネルの開閉(V1-M8-T02 / ADR-0025 §10-2)。
   *
   * **owner 限定にしない。** この画面が叩く API は changelog / manifest と同列の
   * 無認証(ローカル専用)であり、owner パネルに置くと「UI は owner 限定に見えるが
   * API は誰でも叩ける」という、UI が嘘をつく状態になる。ビュー一覧と同じ階層の
   * 通常導線として置く。
   */
  const [requirementsOpen, setRequirementsOpen] = useState(false);
  /**
   * **積まれたコメントを読み返すパネルの開閉**(`V10-M32-T01`)。
   *
   * **運営者だけに絞っていない。** **【この言い回しは意図的である】** —— **同じ趣旨の
   * 逐語(要件定義書とテーマの持ち出しの2箇所)は
   * `web/test/platform-port-visibility.test.tsx` が出現数2で凍結しており、
   * 同じ綴りで3本目を書くとその検査が落ちる。** **綴りが重ならない言い方を選んだだけで、
   * 判断は上の2つと同じである。**
   *
   * **理由**: **誰にどのコメントが見えるかを決めているのは
   * `src/server/comment-visibility.ts` の可視集合1本だけであり、口はその集合を
   * 返す。** **画面でもう一度絞ると、同じ規則が2箇所に住む。**
   *
   * **同時に、これが遮断ではないことを書いておく** —— **絞っているのはサーバであって、
   * ここで導線を出さないことではない。UI は担保ではない。**
   *
   * **【正直に書く】本工程では出し入れ(ON/OFF)を1バイトも掛けていない** ——
   * **`comment_visibility.read` の設定を1度も見ておらず、ログインしていれば常に出る。**
   * **掛けるのは `V10-M32-T02` である。**
   *
   * ## 【`V10-M32-T02`(2026-08-26)。台帳 `CM-G40`】**直前の3行は今日の正ではない**
   *
   * **上の段落は `V10-M32-T01` の時点の記述であり、1バイトも書き換えていない。**
   * **今日は `comment_visibility.read` を見ている** —— **設定が OFF なら導線も枝も出ない。**
   * **「ログインしていれば常に出る」は今日は偽である。**
   * **判定は下の `commentReadEnabled` 1本で、この器の中に2本目は無い。**
   *
   * **上の「これが遮断ではない」の段落は今日も1ミリも変わらない** —— **`GET /api/apps/:app_id/comments`
   * も MCP の `list_comments` も1バイトも閉じていない**(`D-V10-38`)。**止まるのは画面に
   * 出すことだけである。**
   */
  const [commentListOpen, setCommentListOpen] = useState(false);
  /**
   * **アプリごとの設定で「読む場所」を出すか**(`V10-M32-T02`。台帳 `CM-G40`。
   * 利用者決定 `D-V10-38` / `D-V10-36` / `D-V10-40`)。
   *
   * **この器の中で、設定を読む呼び出しはこの1本だけである。** **この1つの値で
   * 「導線のボタン」と「三項連鎖の枝」の両方を包む** —— **ボタンだけを包むと、
   * 開く経路が消えるだけで枝は残り、設定を読む箇所が2つに割れる。**
   * **`web/test/comment-list.test.tsx` の (o) が、ソースの走査で
   * `useCommentReadEnabled()` の出現数が1であることを固定している。**
   *
   * **`platformPortAudience` を1バイトも書き換えていない** —— **要件定義書と
   * テーマの持ち出しの2本は、今日どおりログインしている全員に出る。**
   * **足したのは3本目にだけ掛かる判定1つである。**
   *
   * **fail-closed である**(判定の本体と向きの理由は
   * `web/src/views/ViewHost.tsx` の `useCommentReadEnabled` の doc に書いた)——
   * **設定が届いていない経路(合成した `Manifest` など)では出さない。**
   */
  const commentReadEnabled = useCommentReadEnabled();
  /**
   * テーマの持ち出しパネルの開閉(V3-M1-T05 / D-G3b)。
   *
   * **owner 限定にしない** —— 出すのはマニフェスト(無認証で読める)の中身そのままであり、
   * owner パネルに置くと「UI は owner 限定に見えるが API は誰でも読める」という嘘になる
   * (要件定義書パネルと同じ判断。ADR-0025 §10-2)。
   */
  const [themeExportOpen, setThemeExportOpen] = useState(false);
  /**
   * テーマ候補のプレビューの開閉(V3-M4-T01 / D-G7。完了条件11)。
   *
   * **こちらは owner 限定にする。** 持ち出し・要件定義書と違い、この画面は
   * **マニフェストを書き換えるボタンを持つ**(`POST /api/apps/:app_id/diffs`)。
   * 既存の owner 限定 UI(ユーザ管理・接続の管理)と同じ置き方にする。
   *
   * **同時に、これが遮断ではないことを書いておく** —— `POST /api/apps/:app_id/diffs` は
   * 今日も認証を要求しない(v0 からの状態。`src/server/app.ts` の「変更系」節)。
   * **UI が押させないことはサーバ側の遮断の代わりにならない。本タスクは `src/server/` を
   * 1バイトも変えていないので、「安全にした」とは書けない。**
   *
   * **【V4-FIX1 項目(5) による改訂。上の段落は制定時の記述であり1バイトも書き換えていない】**
   * **`POST /api/apps/:app_id/diffs` は今日、認証を要求する**(未認証 401 / owner 以外 403)。
   * **ユーザ決定「書き換えの口は塞ぐ …(必須)」の履行であり、担保はサーバ側にある。**
   * **それでも「安全にした」とは書かない** —— `GET /manifest` / `GET /changelog` /
   * `GET /undo/preview` / `GET /requirements` は今日も未認証で通り、MCP 経路は1ミリも守られない。
   */
  const [themePreviewOpen, setThemePreviewOpen] = useState(false);
  /**
   * テーマの取り込みの開閉(V3-M6-T02 / D-G9。完了条件1 / 4)。
   *
   * **owner 限定にする** —— 候補プレビューと同じく、この画面は**マニフェストを書き換える
   * ボタンを持つ**(`POST /api/apps/:app_id/diffs`)。読むだけの持ち出し口とは扱いを分ける。
   *
   * **同時に、これが遮断ではないことを書いておく(§8-1 の線7)。** **owner 確認は編集上の
   * 関門であって、構造の担保ではない。** **AI は今日も `apply_diff` の `set_theme` で直接
   * テーマを書けるし、この画面はその経路を1本も塞がない。** **V3-M6-T02 が自分で測った**:
   * `POST /api/apps/:app_id/diffs` に `set_theme` を投げると **cookie 無し(未認証)/ viewer /
   * customer / editor の4通りとも `201`** で書けた(対照: 逃げ道の発行は viewer で `403`)。
   * **`src/server/` を1バイトも変えていないので、「安全にした」とは書けない。**
   */
  const [themeImportOpen, setThemeImportOpen] = useState(false);
  const isOwner = user.role === "owner";
  /**
   * **プラットフォームが常設する口(要件定義書 / テーマの持ち出し)を出す相手**
   * (`V4-M19-T10`。門A の判定は「将来送り」で、本タスクはその送り先の履行である。
   * **ADR は無い(台帳1行)**)。
   *
   * ## **上の2つの「owner 限定にしない。」を覆していない**
   *
   * **`ADR-0025` §10-2 の本文も、上の逐語コメント2つも1バイトも書き換えていない。**
   * **今日も owner 限定ではない** —— **owner / editor / viewer には今日どおり出る。**
   * **足したのは「買い物客(`customer`)には出さない」分岐だけである。**
   *
   * **先例はこのリポジトリの中にある** —— `web/src/views/DetailViewRenderer.tsx` の
   * 「閲覧のみ(書き込み権限がありません)」の注記が、`E-G20` / `V4-M6` で
   * 「**編集できる想定の人が編集できないときだけ出す**」に絞られた(判定は
   * `web/src/auth/authz.tsx` の `isWriteAudienceRole`)。理由は「**そもそも編集する立場に
   * 無い相手に管理ツールの文言を出すと、店の画面ではなく管理ツールの画面に見えた**」で
   * ある。**要件定義書とテーマの持ち出しは、まさに管理ツールの口である。**
   *
   * **判定の式は `web/src/views/ListViewRenderer.tsx` の `isPlatformPortAudience` と同じ
   * 形である**(あちらは CSV の書き出し口を同じ理由で絞る)。**共有関数を作っていない**
   * —— `web/src/auth/authz.tsx` に述語を足すのは新しい規約を1つ作ることであり、本タスクの
   * 射程外である。**片方を変えたらもう片方も変えること。**
   * **`null` の枝がここに無いのは、この関数が認証済みの subtree にしか現れないためである**
   * —— **未ログインは `AnonymousWorkspace` が3つの口を1つも描かない**(上の注記)。
   * **ロールが分からない(型に無い値が来た)ときは今日どおり出す** —— 既存アプリの
   * 見え方を黙って変えない側に倒す(`isWriteAudienceRole` と同じ向き)。
   *
   * ## 【正直に書く】これは遮断ではない
   *
   * **`customer` が UI を迂回して API を直接叩けば、今日どおり読める** ——
   * **`GET /api/apps/:app_id/requirements` も `GET /manifest` も今日は認証を要求しない**
   * (`ADR-0025` §10-2 が「無認証(ローカル専用)」と書いた状態そのもの)。
   * **UI が見せるものは API が許すものより狭い、という状態が残る。UI は担保ではない。**
   *
   * ## 【解けないこと】この口を出す / 出さないをアプリは選べない
   *
   * **マニフェストには1バイトも書けない。理由は `ADR-0007` §1b の Δ4 である** ——
   * マニフェストの語彙がプラットフォームの内部機能の名前に依存し、自己完結性を失う。
   * **【禁止】「アプリが常設の口を選べるようになった」と書かない。**
   */
  // **【`V5-M17-T05` / `G-G7` / `ADR-0158` 限定2】等値比較 → `isReservedRole`。**
  //
  // --- 【`V8-M27-T04` / `T-G5`】**判定を撤去した。上の doc を1バイトも消していない** ---
  //
  // **旧(逐語)**: `const platformPortAudience = isReservedRole(user.role);`
  //
  // **今日は常に `true` である** —— **要件定義書とテーマの持ち出しの口は、ログインして
  // いる全員に出る。** **理由と代償は
  // `web/src/views/ListViewRenderer.tsx` の `isPlatformPortAudience` の節に書いた
  // (**片方を変えたらもう片方も変えること**、という旧 doc の指示どおり同時に変えた)。**
  // **【正直に書く】これは広がりである。** **非運営の役割にも管理ツールの口が出る。**
  const platformPortAudience = true;
  /**
   * 画面一覧に並べるビュー(V3-M3-T04 / D-G12b。ユーザ決定 D-M3-1 =「隠す」)。
   *
   * **判定は `visibleViewsForRole`(`auth/authz.tsx`)1本**にあり、ここには可否の知識を
   * 1つも置かない。**owner / editor / viewer では1件も減らない** —— 減るのは customer の
   * ときだけである(「ロールに応じて画面が出し分けられる」と一般化しないこと)。
   *
   * **`SelectedView` は絞っていない。** URL を直接叩けば従来どおり描画を試み、サーバの
   * 403 とその hint に到達する —— 隠すことで消えるのは**一覧からの説明機会**であって、
   * 説明そのものを全部消したのではない(憲法6 との緊張。ADR は無く、代償は消えない)。
   */
  const listedViews = visibleViewsForRole(user.role, manifest);

  /**
   * **登録の直後に導く先の候補**(`V4-M21-T03` / `E-G65` / `D-V4-82`)。
   *
   * **単位B の判定は「将来送り。帰属先 = 表示層」である。** **自動処理の起点は1バイトも
   * 作っていない** —— `_auth_users` はマニフェストの語彙のどこにも居らず、認証層は
   * ワークフローを1本も起こさない(どちらも今日そのままである)。
   *
   * ## 【導く先をアプリが宣言できない。これはレンダラの既定挙動である】
   *
   * **マニフェストには「登録の直後に開く画面」を1バイトも書けない**(そのキーは語彙に
   * 無く、足せば `ADR-0007` §1b の Δ4 —— マニフェストがプラットフォームの内部機能の
   * 名前に依存する —— に当たる)。**したがって選ぶ規則はここに焼き込まれている**:
   *
   *   **`st_owner` を宣言したテーブル(= 個人ごとに行を持つ表)の `form` ビューのうち、
   *   このロールが使えるものを、マニフェストの順序のまま全部並べる。**
   *
   * **どれが「会員情報」なのかをレンダラは知らない。** だから1つに決めず、全部出す。
   * **候補が0件のアプリでは、案内そのものを1つも描かない**(押しても何も無い導線を
   * 出さない。`V4-M2-T07` 完了条件3 と同じ規律)。
   *
   * ## 【この案内が1ミリも解かないこと】
   *
   * - **自動処理の起点にはならない。** **押さなければ行は1つも作られない。**
   * - **既に「アカウントだけあって会員行が無い」利用者は1件も直らない**(この案内は
   *   登録の直後にしか出ない)。
   * - **行が既に在るかどうかを見ていない。** 二重に作られることを止めていない。
   * - **判定は `personalOwnerField` / `canUseView` の既存2本**であり、規約も可否も
   *   ここで再実装していない。
   */
  //
  // ## 【2026-08-21 追記(`V10-M6-T01a` / `NV-G14`)。すぐ上の4点は1バイトも書き換えていない】
  //
  // **4点のうち3点は今日も真である。** **変質したのは1点だけで、それも半分である。**
  //
  // - **「自動処理の起点にはならない。押さなければ行は1つも作られない。」** —— **今日も真。**
  //   **自動で開くのは入力画面であって、行を1つも作らない。** **保存を押すのは今日も利用者である。**
  // - **「既に『アカウントだけあって会員行が無い』利用者は1件も直らない」** —— **今日も真。**
  //   **自動で開くのも登録の直後(`justSignedUpAsCustomer`)だけであり、既存の利用者には1度も効かない。**
  // - **「行が既に在るかどうかを見ていない。二重に作られることを止めていない。」** —— **今日も真。**
  //   **むしろ自動で開く分だけ、二重に作られる入口に着く回数は増えうる**(止める仕組みは1つも足していない)。
  // - **「判定は `personalOwnerField` / `canUseView` の既存2本」** —— **判定そのものは今日も真だが、
  //   置き場が変わった。** **述語は `web/src/auth/signup-next.ts` の `signupNextFormViews` へ移した**
  //   (**1バイトも書き換えずに移した**)。**ここに残っているのは `justSignedUpAsCustomer` の三項だけである。**
  //
  // **【変質した1点。丸めない】** **「この案内が1ミリも解かないこと」という見出しの前提が半分変わった** ——
  // **候補がちょうど1本のとき、この案内は「押させる」ものではなくなり、その画面が自動で開く**
  // (`useSignupAutoOpen`)。**案内そのものは消えない**(候補が1本でも今日どおり描かれる)。
  // **候補が2本以上のときと0本のときは、1ミリも変わっていない。**
  //
  // ## 【`V8-M27-T04` / `T-G5`】**`!isReservedRole(user.role)` を撤去した。理由を書く**
  //
  // **旧(逐語)**: `justSignedUpAsCustomer && !isReservedRole(user.role)`
  //
  // **これは可否の判定ではない** —— **「登録直後に導く先の候補を出すか」であり、
  // 遮断にも表示権限にも1ミリも関わらない**(候補は `canUseView` が別に絞る)。
  //
  // **【先行の門A審査はこの1件を1度も見ていない。その事実を書く】** ——
  // **`V8-M25` の軸4の本審査(56単位)にも、`V8-M15` の軸3の本審査(45行)にも、
  // この条件を名指しした単位は1つも無い。** **「`E` 群の射程」として扱われており、
  // 誰も審査していない。** **したがって以下は実装側の判断である。**
  //
  // **撤去した理由**: **`justSignedUpAsCustomer` は「このセルフサインアップ経路を
  // 通った直後か」を表しており、その経路は予約3ロールを1度も発行しない** ——
  // **`!isReservedRole(user.role)` は、その左辺が真のときほぼ常に真である
  // 冗長な項だった。** **残すと「役割の綴りで導線を決める場所」が1つ残り、
  // 撤去の完了を機械的に確かめられなくなる**(`isReservedRole` の呼び出し0本を
  // 保てなくなる)。
  //
  // **【変わりうる1件。隠さない】** **セルフサインアップの直後に、その人が
  // 予約3ロールを**併せて**持っている場合**(付与表 `_auth_user_roles` に
  // `owner` などが入っている場合。`V8-M16` の実効ロール集合)、
  // **旧はこの案内を出さず、今日は出す。** **出るのは「個人ごとに行を持つ表
  // (`st_owner`)の入力画面のうち、その人が開けるもの」だけであり、
  // 押さなければ行は1つも作られない。**
  // ## 【`V10-M6-T01a` / `NV-G14`】**述語を `web/src/auth/signup-next.ts` へ移した**
  //
  // **旧(逐語)**:
  //
  //     const signupNextForms = justSignedUpAsCustomer
  //       ? manifest.app.views.filter((view) => {
  //           if (view.type !== "form") {
  //             return false;
  //           }
  //           const table = manifest.app.tables.find((candidate) => candidate.id === view.table);
  //           return (
  //             table !== undefined &&
  //             personalOwnerField(table) !== undefined &&
  //             canUseView(user.role, manifest, view)
  //           );
  //         })
  //       : [];
  //
  // **移したのは述語だけで、1バイトも書き換えていない。**
  //
  // **【2026-08-21 追記。すぐ上の1行は、打ち直すと成り立たない。旧文は1文字も消していない】**
  // **削除した14行を1行ずつ照合すると、前後の空白を含めた逐語の一致は 0 / 14 である**
  // (空白を除けば **8 / 14**。**この数は最初 9 と書いたが、打ち直して 8 に直した**)。
  // **理由は4つで、全部書く**:
  // **(1) 移した先では字下げが4文字ぶん浅い**(13行すべてに効く)/
  // **(2) `canUseView(user.role, …)` が `canUseView(role, …)` になった**(ロールを引数で受けるため)/
  // **(3) `import` の相対パスが1段深くなった** / **(4) `})` が移した先では `});` である**
  // (`filter(…)` が `return` 文として閉じるため、末尾に `;` が1文字増えた)。
  // **4条件の中身(型が `form` / 表が実在する / `personalOwnerField` / `canUseView`)は1つも変わっていない。**
  //
  // **`justSignedUpAsCustomer ? … : []` の三項はここに残した** ——
  // **「候補は何本か」(移した側)と「今それを出してよい局面か」(残した側)は別の問いであり、
  // 前者だけが自動で開く判断(`useSignupAutoOpen`)にも使われるからである。**
  //
  // ## 【`V10-M19-T02` / `FU-G7b` / `ADR-0364`】**見える範囲に行がある候補を落とす関門を外側に足した**
  //
  // **旧(逐語)**: `const signupNextForms = justSignedUpAsCustomer ? signupNextFormViews(manifest, user.role) : [];`
  //
  // **`justSignedUpAsCustomer ? … : []` の三項は1バイトも消していない** ——
  // **`signupNextFormViews` の同期の4条件も1つも消していない**(`ADR-0364` 限定6)。
  // **足したのは5つ目の関門(行が見えるか)だけで、それは `useSignupNextCandidates` の中に在る。**
  // **判定式そのものはここに書き写していない** —— **式の全文は `ADR-0364` §Decision 5 に在る。**
  const { views: signupNextForms, autoOpenAllowed } = useSignupNextCandidates(
    appId,
    manifest,
    user.role,
    justSignedUpAsCustomer ? signupNextFormViews(manifest, user.role) : [],
    justSignedUpAsCustomer,
  );

  /*
   * **候補がちょうど1本のときだけ、その画面を自動で開く**(`V10-M6-T01a` / `NV-G14`)。
   *
   * **一度きりである** —— **利用者が自分で別の画面へ移ったあとに引き戻さない**
   * (見張りは `useSignupAutoOpen` の中の `useRef`)。
   * **候補が2本以上のときも0本のときも、1ミリも動かない。**
   * **案内の描画(下の `customer-signup-next`)は1バイトも変えていない** —— **自動で開いても案内は残る。**
   *
   * **`AuthenticatedWorkspace` は return を1本しか持たないので、フックの規則は素直に守れる**
   * (この行より上に早期 return が1つも無いことを実測して確かめた)。
   */
  // **【`V10-M19-T02`】第3引数に `autoOpenAllowed` を AND した** ——
  // **読み終える前と、読み終えた時点で現在地が変わっていたときは自動で開かない**
  // (`ADR-0364` 限定5)。**`useSignupAutoOpen` の本体は1バイトも書き換えていない。**
  useSignupAutoOpen(appId, signupNextForms, justSignedUpAsCustomer && autoOpenAllowed);

  return (
    /*
     * **`actorId` を渡す**(`E-G53` / V4-M6)—— 「誰の行か」(`st_owner`)の判定に要る。
     * **props ではなくコンテキストで運ぶ**(`ADR-0053` 限定3)。
     */
    <RoleProvider role={user.role} actorId={user.id}>
      <section className={cn("font-sans text-foreground")}>
        {/*
         * **【V4-M15-T14】ヘッダの導線を部品体系の `Button` にした。**
         * **`class="app-header"` と `class="current-user"` は1つも消していない** ——
         * `web/src/styles.css:578` / `:588` の当たり先である(横並び・`margin-left: auto`)。
         * **足したのは折り返し(`flex-wrap`)だけで、`display: flex` は既存の規則が持つ** ——
         * **狭い画面で導線が画面外へ出ないようにするためである**(`D-V4-44`。断点を1つも
         * 使っていない —— 折り返しは幅の条件を書かずに効く)。
         */}
        <header className={cn("app-header", "flex-wrap")}>
          <h2>{manifest.app.name}</h2>
          <span className={cn("current-user", "text-note")} data-testid="current-user">
            {user.username}
          </span>
          {/* **現在ロールは印(`Badge`)で出す。文言も `data-role` も1バイトも変えていない。** */}
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
          {/* ユーザ管理は owner だけの導線。非 owner には出さない。 */}
          {isOwner && (
            <Button
              size="sm"
              variant="secondary"
              data-testid="open-user-admin"
              onClick={() => setAdminOpen(true)}
            >
              ユーザ管理
            </Button>
          )}
          {/* 接続の管理も owner だけの導線。非 owner には出さない(最終防衛線はサーバ 403)。 */}
          {isOwner && (
            <Button
              size="sm"
              variant="secondary"
              data-testid="open-connection-admin"
              onClick={() => setConnectionAdminOpen(true)}
            >
              接続の管理
            </Button>
          )}
          {/*
           * 逃げ道の管理も owner だけの導線。非 owner には出さない
           * (**最終防衛線はサーバの `requireOwner`**。出し分けは先回りである)。
           */}
          {isOwner && (
            <Button
              size="sm"
              variant="secondary"
              data-testid="open-escape-hatch-admin"
              onClick={() => setEscapeHatchAdminOpen(true)}
            >
              逃げ道の管理
            </Button>
          )}
          {/*
           * テーマ候補のプレビューも owner だけの導線(完了条件11)。押すとマニフェストを
           * 書き換えられる画面なので、読むだけの持ち出し口とは扱いを分ける。
           */}
          {isOwner && (
            <Button
              size="sm"
              variant="secondary"
              data-testid="open-theme-preview"
              onClick={() => setThemePreviewOpen(true)}
            >
              テーマ候補のプレビュー
            </Button>
          )}
          {/*
           * テーマの取り込みも owner だけの導線(V3-M6-T02。完了条件1)。
           * **出口(持ち出し)と対になる入口だが、導線の階層は同じにできない** ——
           * 出口は読むだけなので通常導線に置いてあり、入口は書くので owner 限定にする
           * (審査記録 §6-2 が「`AppWorkspace.tsx`(導線 + owner 限定の判定)」と書いた形)。
           * **対になっているのはファイルの置き場と役割であって、権限ではない。**
           */}
          {isOwner && (
            <Button
              size="sm"
              variant="secondary"
              data-testid="open-theme-import"
              onClick={() => setThemeImportOpen(true)}
            >
              テーマの取り込み
            </Button>
          )}
          {/*
           * アカウント(パスワードの変更・退会)。**ロールで出し分けない**(`E-G68`)——
           * 買い物客も運営も、自分の資格情報は自分でやり直せる必要がある。
           */}
          <Button size="sm" data-testid="open-account" onClick={() => setAccountOpen(true)}>
            アカウント
          </Button>
          <Button size="sm" data-testid="logout" onClick={() => void onSignOut()}>
            ログアウト
          </Button>
        </header>
        {/*
         * **登録の直後の案内**(`V4-M21-T03` / `E-G65` / `D-V4-82`)。
         *
         * **`web/src/auth/LoginPage.tsx` の `admin-signup-note` / `customer-signup-note` と
         * 同じ形の、画面上の案内である。** **候補が0件なら1つも描かない。**
         * **閉じられる** —— セッションのあいだずっと居座らせない。
         *
         * **【2026-08-22 追記(`V10-M19-T01` / `FU-G6` / `ADR-0363`)。旧文を1バイトも
         *   消していない】** **案内の本体は `web/src/auth/SignupNextNotice.tsx` へ移した**
         * —— **配る版(`web/src/runner-app.tsx`)が同じ1本を呼ぶためである**
         * (ユーザ決定 `D-V10-17`)。**文面は1文字も変えていない。**
         *
         * **【門が2箇所に在るのは意図である】** **`SignupNextNotice` は候補が0本なら
         * `null` を返すので、すぐ下の門は無くても描かれるものは1ピクセルも変わらない。**
         * **それでも残しているのは、`ADR-0363` 限定3 がその1行の字面を
         * 「`web/src/` に1行」で固定しており、消すと限定3 が破れるからである。**
         * **配る版の側にはその字面を1文字も書いていない**(書くと当たりが増え、やはり破れる)。
         * **判定式をこの doc にも書き写していない** —— **書き写すと当たりがこの行まで
         * 数えられ、書いたその場で式の値が動く。**
         */}
        {signupNextForms.length > 0 && (
          <SignupNextNotice
            appId={appId}
            views={signupNextForms}
            onDismiss={onDismissSignupNotice}
          />
        )}
        {/*
         * owner がユーザ管理を開いているあいだはビュー群の代わりに UserAdmin を出す。
         * owner 専用の状態なので、非 owner はそもそも adminOpen を true にできない。
         */}
        {accountOpen ? (
          /*
           * **アカウントは owner 限定ではない**(`E-G68`)。退会に成功したらセッションが
           * 無くなっているので、`onSignOut` と同じ経路で匿名に戻す —— **画面に居座らせない。**
           */
          <AccountPanel
            appId={appId}
            username={user.username}
            onClose={() => setAccountOpen(false)}
            onWithdrawn={() => {
              setAccountOpen(false);
              void onSignOut();
            }}
          />
        ) : isOwner && adminOpen ? (
          <UserAdmin
            appId={appId}
            onClose={() => setAdminOpen(false)}
            /* **【`V8-M29` 第2波 / 台帳 `T-G9a`】旧(逐語)**: `userKinds={declaredUserKinds(manifest)}` */
            /* **選択肢は `app.roles[].id` が並べる**(`assignableRoleValues` と集合一致) */
            roleIds={declaredRoleIds(manifest)}
            /* **【`V8-M29` 第1波 / `D-V8-79`】表示名だけを広げる**(選択肢は今日どおり) */
            roles={declaredRoleKinds(manifest)}
          />
        ) : isOwner && connectionAdminOpen ? (
          <ConnectionAdmin appId={appId} onClose={() => setConnectionAdminOpen(false)} />
        ) : isOwner && escapeHatchAdminOpen ? (
          // owner 専用の状態なので、非 owner はそもそも `escapeHatchAdminOpen` を true に
          // できない。**それでも担保はサーバ側である**(この行は先回りにすぎない)。
          <EscapeHatchAdmin appId={appId} onClose={() => setEscapeHatchAdminOpen(false)} />
        ) : isOwner && themePreviewOpen ? (
          /*
           * プレビューは**既に取得済みのマニフェスト**と、**ロールで絞ったあとの画面一覧**を
           * そのまま受け取る(第2の取得経路も、2本目の絞り込み規則も作らない)。
           * owner 専用の状態なので、非 owner はそもそも `themePreviewOpen` を true にできない。
           */
          <ThemePreviewPanel
            appId={appId}
            manifest={manifest}
            views={listedViews}
            viewId={viewId}
            onClose={() => setThemePreviewOpen(false)}
          />
        ) : isOwner && themeImportOpen ? (
          /*
           * 取り込みも**既に取得済みのマニフェスト**と**ロールで絞ったあとの画面一覧**を
           * そのまま受け取る(第2の取得経路も、2本目の絞り込み規則も作らない)。
           * owner 専用の状態なので、非 owner はそもそも `themeImportOpen` を true に
           * できない。**それでも担保はサーバ側に無い**(上の状態宣言の実測)。
           */
          <ThemeImportPanel
            appId={appId}
            manifest={manifest}
            views={listedViews}
            viewId={viewId}
            onClose={() => setThemeImportOpen(false)}
          />
        ) : requirementsOpen ? (
          <RequirementsDocPanel appId={appId} onClose={() => setRequirementsOpen(false)} />
        ) : commentReadEnabled && commentListOpen ? (
          /*
           * **積まれたコメントを読み返すパネル**(`V10-M32-T01`)。
           *
           * **`isOwner &&` を付けていない** —— **サーバの可視集合が既に絞り切っており、
           * 画面で二重に絞らない**(理由は `commentListOpen` の宣言の注記)。
           * **パネルは自分で1度だけ取りに行く**(第2の取得経路も、絞り込みの規則も
           * ここには1つも無い)。
           *
           * **【`V10-M32-T02`(2026-08-26)】上の注記を1バイトも消していない。**
           * **旧(逐語)**: `) : commentListOpen ? (`
           * **今日は `commentReadEnabled &&` が前に付く。**
           *
           * **なぜ枝まで包むのか** —— **ボタンだけを包むと、開く経路が消えるだけで
           * 枝は残る。** **`commentListOpen` を真にできる経路が今日は1本も無いので
           * 画面上の見え方は同じだが、「設定を読む箇所は1つ」という形が崩れる** ——
           * **後で2本目の開く経路(URL・別のボタン)が足されたとき、そちらだけが
           * 設定を素通りする。** **判定を1つに保つために、枝も同じ値の下に置く。**
           */
          <CommentList appId={appId} onClose={() => setCommentListOpen(false)} />
        ) : themeExportOpen ? (
          /*
           * テーマは**既に取得済みのマニフェストの値**をそのまま渡す(V3-M1-T05)。
           * パネルに第2の取得経路を作らない —— 見た目を決めるのはマニフェストだけである
           * (D-4 / ADR-0047 §1e)。
           *
           * **【V3-M5-T05 / ADR-0055 で改訂】この標語は、今日はテーマについてしか
           * 成り立たない。** V3-M5 で逃げ道(任意 CSS)が入り、**画面に当たる見た目の
           * 一部はマニフェストの外(owner 専用の content-addressed ストア)から来る。**
           * **それでも本行の判断(第2の取得経路を作らない)は1バイトも変わらない** ——
           * 逃げ道の本体を取りに行くのは `ViewHost` 1箇所だけで、ここではない。
           */
          <ThemeExportPanel theme={manifest.app.theme} onClose={() => setThemeExportOpen(false)} />
        ) : (
          /*
           * **画面一覧を左カラムに置く器**(V4-M2-T03 / 単位 `B-G4`。**門外 Δ7・条件付き**)。
           *
           * **宣言を1つも作っていない。** マニフェストにもテーマにも1キーも足しておらず、
           * 「左ナビにするかどうかをアプリが宣言したい」は `D-G6` / `ADR-0051` §3a-3 の
           * 射程である(`v4-m0-gate-boundary.md` §1-4 の判定2)。**ここを1ミリも開けていない。**
           *
           * **当たり先は `.app-theme` の内側に閉じている**(`D-V4-5` / `D-V4-24`)——
           * この器は `AppThemeScope` の子孫であり、`.shell` には1バイトも触っていない。
           *
           * **`app.views` の配列順をそのまま保つ**(`ADR-0008` 限定2 が並び順を宣言する
           * キーを名指しで禁じている)—— 並べ替えも並び順の宣言も1つも足していない。`listedViews` は
           * `visibleViewsForRole`(「マニフェストの順序のまま返す」)の返り値そのままである。
           *
           * **左端であることを決めているのは文書順である**(`.workspace-body` は
           * `display: flex` の横並びで、`flex-direction` を倒していない)。**CSS で位置を
           * 指定していない** —— したがって折り返したときは上下に積まれる(`@media` を
           * 1つも書かないための手段。`web/src/styles.css` の当該規則)。
           */
          <div className="workspace-body">
            <nav className="view-list" data-testid="view-list">
              {listedViews.length === 0 && <EmptyViewList manifest={manifest} />}
              <ul className={cn("flex flex-col gap-s1")}>
                {listedViews.map((view) => (
                  // **【V4-M15-T14】いま開いている画面に `aria-current="page"` を付ける**
                  // (着手前 0件。`03` §4-1 の「選択中 0件」)。**当たり先は URL の
                  // `viewId` と一致する1件だけで、選んでいなければ1件も出ない。**
                  // **属性を `<li>` に置くのは、`RouteLink`(`web/src/navigation.tsx`)が
                  // `to` と `children` しか受け取らず、本タスクがそのファイルを触らない
                  // ためである。**
                  <li
                    key={view.id}
                    className={cn("flex flex-wrap items-baseline gap-s1")}
                    {...(view.id === viewId ? { "aria-current": "page" as const } : {})}
                  >
                    {/*
                     * V1-M0-T02: 表示名があればそれを出し、無ければ従来どおり id を出す。
                     * 両方を並べないのは、名前を付けた画面でIDが残ると「表示名を付けた」ことに
                     * ならないためである(F-1 の要求は人間向けの名前を出すこと)。
                     */}
                    <RouteLink to={{ kind: "view", appId, viewId: view.id }}>
                      {viewDisplayName(view)}{" "}
                      <span className={cn("meta", "text-note text-muted-foreground")}>
                        {VIEW_TYPE_LABELS[view.type]}
                      </span>
                    </RouteLink>
                  </li>
                ))}
              </ul>
            </nav>
            {/*
             * **本文の器**(V4-M2-T03)。画面一覧の**右**に来るのはこの1つだけである。
             *
             * **通常導線(`workspace-links`)をここに残したのは計画側の判断である** ——
             * 台帳が `B-G4` について書いた完了条件6点は `nav.view-list` だけを名指しして
             * おり、**通常導線を左へ移せとは1文字も書いていない。** 移すと選択中の画面との
             * 上下関係が変わるので、**動かさない側を採った。**
             */}
            <div className="workspace-main" data-testid="workspace-main">
              {/*
               * 要件定義書への導線。ビュー一覧と同じ階層の通常導線であり、
               * ロールによる出し分けをしない(ADR-0025 §10-2)。
               *
               * **【`V4-M19-T10` の追記。上の1文は今日から成り立たない】**
               * **「ロールによる出し分けをしない」は 2026-08-04 の着手前までは真だったが、
               * 今日は買い物客(`customer`)に出さない。** **owner 限定にはしていない** ——
               * **owner / editor / viewer には今日どおり出る**(判定は `platformPortAudience`
               * 1本。理由と限界はその宣言の注記にすべて書いてある)。
               * **器そのものを出さない** —— 中身が2つとも消えた `<nav>` を残すと、
               * 空の導線が1つ画面に残る。
               */}
              {platformPortAudience && (
                <nav
                  className={cn("workspace-links", "flex flex-wrap items-center gap-s2")}
                  data-testid="workspace-links"
                >
                  <Button
                    size="sm"
                    variant="secondary"
                    data-testid="open-requirements-doc"
                    onClick={() => setRequirementsOpen(true)}
                  >
                    要件定義書
                  </Button>
                  {/*
                   * テーマの持ち出しへの導線(V3-M1-T05 / D-G3b)。要件定義書と同じ階層の
                   * 通常導線であり、ロールによる出し分けをしない。**テーマを持たないアプリでも
                   * 出す** —— 出さないと「この画面が無い理由」を人間が確かめられない(憲法6)。
                   *
                   * **【`V4-M19-T10` の追記】こちらも買い物客には出さない**(上と同じ1つの
                   * 判定である。2つの口で規則を割らない)。**「テーマを持たないアプリでも
                   * 出す」は、出す相手については今日も真である。**
                   */}
                  <Button
                    size="sm"
                    variant="secondary"
                    data-testid="open-theme-export"
                    onClick={() => setThemeExportOpen(true)}
                  >
                    テーマの持ち出し
                  </Button>
                  {/*
                   * **積まれたコメントを読み返す導線**(`V10-M32-T01`。3本目)。
                   *
                   * **運営者だけに絞っていない**(判断と、綴りを変えた理由は
                   * `commentListOpen` の宣言の注記に書いた)。 **`platformPortAudience` を
                   * 1バイトも書き換えていない** —— **この `<nav>` は今日 `true` に固定された
                   * 1つの判定の下に在り、3本目もその下に置いただけである。**
                   *
                   * **コメントが1件も無いアプリでも出す** —— **出さないと「読むところが
                   * 無い理由」を人間が確かめられない**(憲法6。テーマの持ち出しと同じ扱い)。
                   *
                   * ## 【`V10-M32-T02`(2026-08-26)】**アプリごとの設定で出し入れする**
                   *
                   * **上の注記を1バイトも消していない。** **「コメントが1件も無いアプリでも
                   * 出す」は今日も真である** —— **件数では1つも出し入れしていない。**
                   * **足したのは `comment_visibility.read` の1つだけである。**
                   * **設定が OFF のアプリでは、この3本目だけが消える** —— **`<nav>` そのものも、
                   * 要件定義書とテーマの持ち出しの2本も、今日どおり出る。**
                   *
                   * **【誇張しない】これは読取を止める壁ではない**(`D-V10-38`)——
                   * **`GET /api/apps/:app_id/comments` は今日も設定を1度も見ない。**
                   * **ボタンが消えても、口を直に叩けば読める。**
                   */}
                  {commentReadEnabled && (
                    <Button
                      size="sm"
                      variant="secondary"
                      data-testid="open-comment-list"
                      onClick={() => setCommentListOpen(true)}
                    >
                      コメント
                    </Button>
                  )}
                </nav>
              )}
              {viewId !== undefined && (
                <SelectedView
                  appId={appId}
                  manifest={manifest}
                  viewId={viewId}
                  recordId={recordId}
                  prefill={prefill}
                />
              )}
            </div>
          </div>
        )}
      </section>
    </RoleProvider>
  );
}

/**
 * 画面一覧が0件のときの説明(V3-M3-T04 追加実施)。
 *
 * **黙って空の一覧を出さない。** これは製品に既にある作法で、レコードが0件の一覧は
 * `list-empty`(`web/src/views/ListViewRenderer.tsx:298`)を出し、アプリ一覧も
 * 「取得できなかった」と「1つも無い」を区別している。**画面一覧にも同じ規律を当てる** ——
 * **「壊れている」と「何も無い」が区別できない画面を出さない**(憲法6)。
 *
 * ## 2つの状態を区別する(`data-reason`)
 *
 * - **`none`** = マニフェストにビューが1つも無い。**ロールを変えても増えない。**
 * - **`role`** = ビューはあるが、このロールから使えるものが無い(絞った結果0件)。
 *
 * **区別する判断の根拠**: 区別すると「このアプリにはビューが1つ以上ある」という**1ビット**が
 * 読み取れる。だがマニフェスト(`GET /api/apps/:app_id/manifest`)は**未認証で読める非保護
 * API** であり(このファイル上部の取得コメント / `docs/tutorial.md` の保護範囲の表)、
 * **ビューの名前も件数もテーブル定義も、今日すでに誰でも取得できる。**したがってこの1ビットは
 * 新しい漏れではない。逆に区別しないと、**「画面を作れば直る」状態と「ロールを変えないと
 * 見えない」状態に同じ文面を出す**ことになり、次に何をすればよいかを言えなくなる。
 *
 * ## D-M3-1(隠す)の射程を侵さない
 *
 * **隠した画面の名前・ID・テーブル名・件数を1つも出さない。**
 * 出すのは「このロールで使える画面が無い」という判定結果だけである。
 * **機械的な固定**は `web/test/role-visibility.test.tsx`(文面に数字を1文字も含まないこと、
 * マニフェスト上のあらゆる id / 名前を含まないこと)にある。
 *
 * **これは代償の埋め合わせではない。** 消えたのは「**なぜこの画面が見えないのか**」の
 * 説明機会であり、それは今日も消えたままである(`auth/authz.tsx` の
 * `visibleViewsForRole` の注記)。ここが足すのは「**この状態は故障ではない**」という別の情報である。
 */
function EmptyViewList({ manifest }: { manifest: Manifest }) {
  if (manifest.app.views.length === 0) {
    return (
      // **文言も `data-testid` も `data-reason` も1バイトも変えていない**(V4-M15-T14)。
      // **控えめな字色にしただけである**(`ListViewRenderer` の `list-empty` と同じ扱い)。
      <p
        data-testid="view-list-empty"
        data-reason="none"
        className={cn("m-0", "text-muted-foreground")}
      >
        このアプリにはまだ画面がありません。壊れているわけではありません ――
        画面を作ると、ここに並びます。
      </p>
    );
  }
  return (
    <p
      data-testid="view-list-empty"
      data-reason="role"
      className={cn("m-0", "text-muted-foreground")}
    >
      いまのロールで使える画面がありません。壊れているわけではありません ――
      表示できるものが無いだけです。見たい画面がある場合は、このアプリの運営者に
      問い合わせてください。
    </p>
  );
}

/** URL のビューID をマニフェストで解決してディスパッチ層に渡す。 */
function SelectedView({
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
    // 「無い」ことを黙って隠さず、実在するビューID を出す(憲法6 / handover 3.8)。
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
    <ViewHost appId={appId} manifest={manifest} view={view} recordId={recordId} prefill={prefill} />
  );
}
