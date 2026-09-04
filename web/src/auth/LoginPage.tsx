/**
 * アプリ単位のログイン/新規登録画面(V1-M3-T01 / ADR-0014 改訂 = per-app)。
 *
 * 認証はアプリごとに独立しているので、この画面は **`appId` を受け取り、そのアプリ配下の
 * 認証エンドポイント(`/api/apps/:appId/auth/*`)を叩く**。**Passkey を優先提示**し、
 * id/password を併用手段として下に置く(**この優先は3つの塊のそれぞれの中で保つ**。
 * 塊の順序は下の「登録の入口」を参照)。エラーはサーバが統一形式(`{ errors: [...] }`)で
 * 返す日本語文面をそのまま出す(フロントで作り直さない =カーネルの文面を一本に保つ /
 * ADR-0003 §3)。cookie はサーバが HttpOnly + Path スコープで管理するので、この画面は
 * cookie を一切触らない。成功時は `onAuthenticated(user)` を呼ぶだけ。
 *
 * `appName` を渡せば「〈アプリ名〉にログイン」の見出しを出す(manifest から取れれば)。
 * `data-testid` は E2E が使う確定版(計画 §6)。増減させないこと。
 *
 * ## 登録の入口は2種類ある(V3-M3-T03 / D-G12a)
 *
 * サーバは**経路でロールを決める**(本文で role を受け取らない)。この画面はその2経路を
 * そのまま2組のボタンにしただけで、判定を1つも持っていない:
 *
 *   - **管理経路**(`auth/password/register` / `auth/passkey/register/*`)= 運営。
 *     初回 owner・以降 viewer(`ADMIN_SIGNUP`)。
 *   - **顧客経路**(`auth/customer/...`)= 買い物客。**常に customer**(`CUSTOMER_SIGNUP`)。
 *
 * **【2026-08-14 訂正(`V8-M5-T05` の 3)。上の2行を1バイトも書き換えていない】**
 * **2点とも今日は偽である。** **(a) 顧客経路のパスは `auth/signup/...` である**
 * (`V5-M17` / `G-G6` が変えた)。 **(b) 「常に customer」ではない** —— **本文の名乗り
 * (`user_kind`)で役割が決まり、省略したときだけそのアプリの1本目になる**(`D-V8-78`)。
 * **さらに、最初の1人は自分で登録した場合も必ず持ち主になる**(`D-V8-82`)。
 *
 * **どちらを押すべきかは画面の外の知識**(自分は店員か客か)なので、`admin-signup-note` /
 * `customer-signup-note` の2つの説明を画面の中に置く(T03 完了条件2)。
 *
 * ## 【`E-G5` / V4-M6】並びは「ログイン → 買い物客の登録 → 運営の登録」である
 *
 * **着手前は運営の登録がログインの隣(画面の一番上)に既定として置かれており、店に来た客が
 * 一番目立つ「新規登録」を押すと閲覧者(運営)になった。** 押す前に読めば分かる注記は在った
 * が、**押しやすさと順序は運営側に倒れたままだった**(02 §5-1 `E-G5`)。**今日の並びは
 * 買い物客を既定とする。** **サーバの経路もロールの決まり方も1バイトも変えていない** ——
 * 変えたのは順序と見出しだけである。**`data-testid` は6つのまま増減させていない。**
 * **登録可否(`ST_AUTH_ALLOW_REGISTRATION`)をこの画面は知らない** —— 知る API が無く、
 * サーバを変えないのが D-G12a の門の前提である。閉じている環境では押せて 403 になり、
 * サーバの文面が `auth-error` に出る。**「押せるのに登録できない」は解消していない。**
 *
 * **【2026-08-14 訂正(`V8-M5-T05` の 3)。上の段落を1バイトも書き換えていない】**
 * **「知る API が無く」は半分だけ今日も真である** —— **`GET /api/apps/:app_id/public` が
 * 「どの立場が招待制か」を返すようになった**(`D-V8-114`)。 **返らないのは
 * `ST_AUTH_ALLOW_REGISTRATION` の値そのものだけである。**
 * **したがって「押せるのに登録できない」は、招待制については**画面で先に分かる**が、
 * env で閉じたサーバについては今日も解消していない。**
 *
 * ## 【V4-M15-T14】部品体系で組み直した(`ADR-0087` / `ADR-0089`)
 *
 * **変えていないもの(規律)**:
 *
 * - **文言を1文字も足しても変えてもいない。**
 * - **`data-testid` を1つも落としていない**(冒頭の「増減させないこと」をそのまま守る)。
 *   **ボタン6つの並びも1つも動かしていない**(`web/test/login-page.test.tsx` の固定)。
 * - **`class="shell"` / `class="login"` / `class="login-form"` / `class="login-error"` を
 *   1つも消していない** —— `web/src/styles.css` の `.login`(最大幅・影)/ `.login-form label`
 *   / `.login-form .passkey-actions` / `.login-error` の各規則の当たり先である。
 *   **部品のクラスは既存クラスに「足す」形でしか入れていない。**
 *
 * **変えたもの**:
 *
 * - **入力欄を `Input`、ボタンを `Button`、エラーの器を `Alert variant="destructive"` にした。**
 *   **押している最中(`busy`)は6つとも `disabled` である**(着手前もそうだったが、
 *   **見た目が変わるのは今日からである** —— `:disabled` の宣言は部品側が持つ)。
 * - **ラベルを `<label>` の入れ子から `Label htmlFor` + `Input id` の対に変えた。**
 *   **`Label` は `htmlFor` を型で必須にしているので、結ばれないラベルを作れない。**
 *   **`getByLabelText` からの引き方は変わらない。**
 * - **幅への対応(`D-V4-44`)**: 狭い画面ではボタンを幅いっぱいにし、`sm`(40rem)から
 *   自然幅に戻す。**使う断点は `sm` 1本だけである**(`ADR-0089` 限定3)。
 */
import { type FormEvent, useState } from "react";
import type { View } from "../../../src/kernel/types.ts";
import {
  type AuthUser,
  customerPasskeyRegister,
  customerPasswordRegister,
  passkeyLogin,
  passkeyRegister,
  passwordLogin,
  passwordRegister,
  type SignupFacts,
  type ValidationError,
} from "../api.ts";
import { toValidationErrors } from "../async.ts";
import { ErrorList } from "../ErrorList.tsx";
import { RouteLink } from "../navigation.tsx";
import { Button } from "../ui/button.tsx";
import { Input, Label } from "../ui/form-controls.tsx";
import { Alert, Card } from "../ui/surfaces.tsx";
import { cn } from "../ui/utils.ts";
import { viewDisplayName } from "../views/ViewHost.tsx";

export function LoginPage({
  appId,
  appName,
  anonymousViews,
  onAuthenticated,
  signup,
}: {
  appId: string;
  appName?: string | undefined;
  /**
   * **未ログインでも見られると宣言された画面**(`V4-M2-T07` / `D-V4-20` (b) / `ADR-0074`)。
   *
   * **絞り込みをここで行わない** —— 渡ってくるのは `AppWorkspace` が
   * `visibleViewsForRole(ANONYMOUS, manifest)` で作った集合そのままである
   * (**判定を2箇所に書かない**。`web/src/navigation.tsx:99` が名指しで禁じた形)。
   * **省略・0件なら導線を1つも描かない**(`V4-M2-T07` 完了条件3 =
   * **押しても何も無い導線を出さない**)。
   */
  anonymousViews?: readonly View[] | undefined;
  /**
   * 認証に至ったことを通知する。**第2引数は `V4-M21-T03` で足した任意の合図**で、
   * **買い物客としての登録経路からだけ `signedUpAsCustomer: true` を渡す** ——
   * 登録の直後に「自分の情報を登録する画面」へ導く案内を出すためである
   * (案内そのものはこの画面ではなく作業画面が描く。**ここは判定を1つも持たない**)。
   */
  onAuthenticated: (user: AuthUser, options?: { signedUpAsCustomer?: boolean }) => void;
  /**
   * **登録に要る事実**(`V8-M5-T04`。台帳 `I-G8` / `I-G27`。**ユーザ決定 `D-V8-112` /
   * `D-V8-114`**)。 **出どころは `GET /api/apps/:app_id/public` の `signup` 1本である。**
   *
   * **【判定をここに書かない】** **この画面は値域を1つも組まない** —— **サーバが返した
   * `kinds` をそのまま描くだけである**(`ADR-0338` 限定4)。
   * **【注記の書き方の限定】** **この注釈に、値域を組むサーバ側の関数名を書き写していない**
   * —— **書くと同 限定4 の「`web/` にその綴りが0件であること」を測る式が、自分の注釈を
   * 数え始める**(`ADR-0338` §3-3 と同型の落とし穴)。
   *
   * **【禁止】「画面に欄が出ない」を制限の担保にしない** —— **サーバが同じ判定を持つことが
   * 本体である**(`I-G20`)。 **欄を隠しても、API を直に叩けば同じ判定を受ける。**
   *
   * **省略されたときは、招待コードの欄も立場を選ぶ欄も1つも描かない**(着手前の画面と
   * 1バイト違わない)。
   */
  signup?: SignupFacts | undefined;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<ValidationError[] | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * **【`V8-M5-T04`】招待コードと、名乗る立場。**
   *
   * **どちらも既定は空である。** **空のキーは本文に1つも乗らない**(`web/src/api.ts` の
   * `signupFields`)—— **したがって招待を使わない登録の要求は着手前と1バイト違わない。**
   */
  const [invitationCode, setInvitationCode] = useState("");
  const [userKind, setUserKind] = useState("");

  /**
   * **招待コードの欄を出すか。** **そのアプリが招待を要求**しうる**ときだけ出す**
   * (裁定 `M5-3`)—— **名乗れる立場のどれかが招待制か、運営が人を足す口が招待制か。**
   */
  const invitationPossible =
    signup !== undefined && (signup.adminInvite || signup.kinds.some((kind) => kind.invite));
  /** **立場を選ぶ欄を出すか。** **2つ以上あるときだけ**(1つなら選ばせる意味が1つも無い)。 */
  const kindChoices = signup === undefined || signup.kinds.length < 2 ? [] : signup.kinds;
  /**
   * **選ばれている立場。** **欄を出していないときは空**(= 本文にキーが1つも乗らず、
   * サーバ側の既定がそのまま効く)。 **欄を出しているときは、既定として先頭を選ぶ** ——
   * **その先頭はサーバが返した並びの先頭そのものであり、本文を省いたときにサーバが
   * 選ぶ値と同じである**(画面が別の既定を発明していない)。
   */
  const selectedKind = userKind !== "" ? userKind : (kindChoices[0]?.id ?? "");
  /** **セルフ登録の口へ渡すもの。** **運営の口へは `userKind` を渡さない。** */
  const selfSignupFields = { userKind: selectedKind, invitationCode };
  const adminSignupFields = { invitationCode };

  /**
   * 認証アクションを実行し、成功で通知・失敗で統一形式エラーを表示する。
   *
   * **`signedUpAsCustomer` は買い物客の登録経路の2本だけが渡す**(`V4-M21-T03`)。
   * **経路がロールを決めるのと同じ形**で、ここに判定を1つも書かない。
   */
  async function run(
    action: () => Promise<AuthUser>,
    options?: { signedUpAsCustomer?: boolean },
  ): Promise<void> {
    setBusy(true);
    setErrors(null);
    try {
      const user = await action();
      onAuthenticated(user, options);
    } catch (reason: unknown) {
      setErrors(toValidationErrors(reason));
    } finally {
      setBusy(false);
    }
  }

  // password ログインはフォーム送信(Enter / 送信ボタン)で発火する。
  function handlePasswordLogin(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void run(() => passwordLogin(appId, username, password));
  }

  return (
    <main className="shell">
      {/*
       * **器は `Card` である**(`ADR-0087`)。**`class="login"` は消していない** ——
       * `web/src/styles.css:555` の最大幅と影の当たり先がここだからである。
       * **`Card` は `<div>` を描く**(着手前は `<section>` だった)。**隠さない。**
       */}
      <Card className={cn("login")} data-testid="login-page">
        <h1 className={cn("m-0", "text-foreground")}>
          {appName === undefined ? "ログイン" : `${appName}にログイン`}
        </h1>
        {/*
         * **未ログインでも見られる画面への導線**(`V4-M2-T07` / **ユーザ決定 `D-V4-20` (b)**)。
         *
         * **決定の逐語は「基本は1で、ログインの画面に未ログインの時のリンクを配置する」である。**
         * **これは `B-G5` の起票にも 02 の `E-G1`〜`E-G6` にも書かれていなかった新しい要求で
         * ある**(04 §3-3 #2)。**黙って落とさない。**
         *
         * **0件のときは何も描かない**(完了条件3 = **押しても何も無い導線を出さない**)。
         * **`data-testid` を1つも消していない** —— 足したのは `anonymous-views` 1つで、
         * 冒頭注記の「増減させないこと」に反する削除は0件である。
         *
         * **【誇張しない】ここに並ぶのは「宣言された画面」だけである。** 並んでいない画面が
         * 存在しないわけではない —— **`GET /api/apps/:app_id/manifest` は今日も未認証で
         * 全ビュー定義を返す**(`ADR-0074` 限定9)。**「宣言で隠す」は情報の遮断ではない。**
         */}
        {anonymousViews !== undefined && anonymousViews.length > 0 && (
          <nav
            className={cn("anonymous-views", "flex flex-col gap-s1 font-sans")}
            data-testid="anonymous-views"
          >
            <p className={cn("m-0", "text-note text-muted-foreground")}>
              ログインしなくても見られる画面があります。
            </p>
            <ul className={cn("flex flex-col gap-s1")}>
              {anonymousViews.map((view) => (
                <li key={view.id}>
                  <RouteLink to={{ kind: "view", appId, viewId: view.id }}>
                    {viewDisplayName(view)}
                  </RouteLink>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <form className={cn("login-form", "font-sans")} onSubmit={handlePasswordLogin}>
          {/*
           * **ラベルと入力欄を `htmlFor` / `id` の対で結ぶ。** 着手前は `<label>` で
           * 入れ子にしていた。**どちらでも `getByLabelText` から引けるが、`Label` は
           * `htmlFor` を型で必須にしているので、結ばれないラベルを作れない。**
           * **`.login-form label` の既存規則(block + 下余白)はそのまま当たる。**
           */}
          <div className={cn("flex flex-col gap-s1")}>
            <Label htmlFor="auth-username">ユーザ名</Label>
            <Input
              id="auth-username"
              data-testid="auth-username"
              type="text"
              name="username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>

          {/* Passkey を優先提示(ADR-0014 §1)。 */}
          <div className={cn("passkey-actions", "flex-col sm:flex-row")}>
            <Button
              data-testid="passkey-login"
              type="button"
              className="w-full sm:w-auto"
              disabled={busy}
              onClick={() => void run(() => passkeyLogin(appId, username || undefined))}
            >
              Passkeyでログイン
            </Button>
          </div>

          {/* 併用手段: id/password。 */}
          <div className={cn("flex flex-col gap-s1")}>
            <Label htmlFor="auth-password">パスワード</Label>
            <Input
              id="auth-password"
              data-testid="auth-password"
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          {/*
           * =====================================================================
           * **【`V8-M5-T04`。台帳 `I-G8` / `I-G27`。ユーザ決定 `D-V8-112` / `D-V8-114`】**
           * **招待コードの欄と、名乗る立場を選ぶ欄。**
           * =====================================================================
           *
           * **どちらも `GET /api/apps/:app_id/public` の `signup` を見て出し分ける** ——
           * **この画面は値域も可否も1つも組み立てていない**(`ADR-0338` 限定4)。
           *
           * **【禁止】「欄が出ないから登録できない」と読まない** —— **欄を隠しても
           * API を直に叩けばサーバの同じ判定を受ける。** **制限の本体はサーバである。**
           *
           * **【`data-testid` を2つ足した】** **冒頭のヘッダの規律は「落とさない」で
           * あり、足すことは `anonymous-views` の先例で既に行っている。**
           * **ボタン6つの `data-testid` は1つも動かしていない。**
           */}
          {kindChoices.length > 0 && (
            <div className={cn("flex flex-col gap-s1")}>
              <Label htmlFor="auth-user-kind">登録する立場</Label>
              <select
                id="auth-user-kind"
                data-testid="auth-user-kind"
                name="user_kind"
                className={cn(
                  "rounded-ui border-[length:var(--border-width)] border-solid border-border",
                  "bg-background text-foreground p-s2 font-sans",
                )}
                value={selectedKind}
                onChange={(event) => setUserKind(event.target.value)}
              >
                {kindChoices.map((kind) => (
                  <option key={kind.id} value={kind.id}>
                    {kind.invite ? `${kind.name}(招待コードが要ります)` : kind.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {invitationPossible && (
            <div className={cn("flex flex-col gap-s1")}>
              <Label htmlFor="auth-invitation-code">招待コード</Label>
              <Input
                id="auth-invitation-code"
                data-testid="auth-invitation-code"
                type="text"
                name="invitation_code"
                autoComplete="off"
                value={invitationCode}
                onChange={(event) => setInvitationCode(event.target.value)}
              />
              <p className={cn("m-0", "text-note text-muted-foreground")}>
                このアプリには、運営者から招待を受けた方だけが登録できる立場があります。
                招待コードをお持ちの場合はここに入れてください。
              </p>
            </div>
          )}

          <div className={cn("password-actions", "flex-col sm:flex-row")}>
            <Button
              data-testid="password-login"
              type="submit"
              variant="secondary"
              className="w-full sm:w-auto"
              disabled={busy}
            >
              パスワードでログイン
            </Button>
          </div>

          {/*
           * 顧客セルフサインアップ(V3-M3-T03 / D-G12a・ユーザ決定 D-M3-2 = 両方)。
           *
           * 叩き先は顧客経路で、**ロールを名乗る手段は無い** —— サーバが常に customer を
           * 付ける(`CUSTOMER_SIGNUP.resolveRole`)。ユーザ名・パスワードの入力欄は上と
           * 共有する(2組に増やすと「どちらに打つのか」がもう1つ増える)。
           *
           * **【2026-08-14 訂正(`V8-M5-T05` の 3)。上の1文を1バイトも書き換えていない】**
           * **「ロールを名乗る手段は無い」は今日は偽である** —— **`V8-M29`(`D-V8-78`)が
           * 本文の名乗りを読むようにし、`V8-M5-T04` がこの画面に立場を選ぶ欄を足した。**
           * **選べるのはアプリが自分で作った役割だけであり、予約3語は今日も名乗れない。**
           *
           * **登録が閉じている環境(`ST_AUTH_ALLOW_REGISTRATION=false`)でもこのボタンは
           * 出す。** 現状 web から登録可否を知る手段が無く(その値を返す API は無い)、
           * サーバを1バイトも変えないのが D-G12a の門の前提だからである。押した結果は
           * 403 で、サーバの文面と hint がそのまま下の `auth-error` に出る —— **押せるのに
           * 登録できない状態は消えていない。理由が画面に出るだけである。**
           */}
          <fieldset
            className={cn(
              "customer-signup",
              "rounded-ui border-[length:var(--border-width)] border-solid border-border p-s3",
            )}
            data-testid="customer-signup"
          >
            <legend className={cn("px-s1 text-sm font-medium text-label")}>
              はじめての方の登録
            </legend>
            <p
              className={cn("signup-note", "m-0 mb-s2 text-note text-muted-foreground")}
              data-testid="customer-signup-note"
            >
              このアプリを使う方はこちら。登録すると<strong>一般利用者</strong>
              になり、自分に関わる記録だけが見えます。運営の画面は開けません。
            </p>
            <div className={cn("passkey-actions", "flex-col sm:flex-row")}>
              <Button
                data-testid="customer-passkey-register"
                type="button"
                className="w-full sm:w-auto"
                disabled={busy}
                onClick={() =>
                  void run(() => customerPasskeyRegister(appId, username, selfSignupFields), {
                    signedUpAsCustomer: true,
                  })
                }
              >
                Passkeyで一般利用者として登録
              </Button>
            </div>
            <div className={cn("password-actions", "flex-col sm:flex-row")}>
              <Button
                data-testid="customer-password-register"
                type="button"
                variant="secondary"
                className="w-full sm:w-auto"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => customerPasswordRegister(appId, username, password, selfSignupFields),
                    { signedUpAsCustomer: true },
                  )
                }
              >
                パスワードで一般利用者として登録
              </Button>
            </div>
          </fieldset>

          {/*
           * 運営(店員・管理者)の登録(**`E-G5` / V4-M6 でここへ動かした**)。
           *
           * **着手前は、この2本が画面の一番上・ログインの隣に既定として置かれていた。**
           * その結果、店に来た客が一番目立つ「新規登録」を押すと**買い物客ではなく閲覧者
           * (運営)になり**、買い物が1つもできない(会員情報もカートも作れない)のに
           * 在庫の増減・決済結果・売上集計は読めるアカウントを持った(02 §5-1 `E-G5`。
           * `POST /auth/password/register` → HTTP 200 / `"role":"viewer"` を実測)。
           *
           * **直したのは順序と見出しだけである。** **サーバの経路も割り当てロールも1バイトも
           * 変えていない**(`ADMIN_SIGNUP` / `CUSTOMER_SIGNUP` はそのまま)。**`data-testid` も
           * 6つのまま増減させていない**(上のヘッダの規律)。
           *
           * **押し間違えたあとにロールをやり直す導線は、今日も画面に無い** —— owner が
           * ロールを変えれば直るが、それは `auth/users` の管理画面であって、この画面ではない。
           * **`E-G5` はそこまでは解いていない。**
           */}
          {/* **`data-testid` は増やしていない**(器には付けない。中の注記が既存の id を持つ)。 */}
          <fieldset
            className={cn(
              "admin-signup",
              "rounded-ui border-[length:var(--border-width)] border-solid border-border p-s3",
            )}
          >
            <legend className={cn("px-s1 text-sm font-medium text-label")}>
              運営(管理者)の登録
            </legend>
            <p
              className={cn("signup-note", "m-0 mb-s2 text-note text-muted-foreground")}
              data-testid="admin-signup-note"
            >
              こちらは<strong>運営(管理者)</strong>
              のためのものです。最初の1人はオーナー、2人目以降は閲覧者になります。
              このアプリを使いたいだけの方は、上の「一般利用者として登録」を使ってください。
            </p>
            <div className={cn("passkey-actions", "flex-col sm:flex-row")}>
              <Button
                data-testid="passkey-register"
                type="button"
                className="w-full sm:w-auto"
                disabled={busy}
                onClick={() => void run(() => passkeyRegister(appId, username, adminSignupFields))}
              >
                Passkeyで新規登録
              </Button>
            </div>
            <div className={cn("password-actions", "flex-col sm:flex-row")}>
              <Button
                data-testid="password-register"
                type="button"
                variant="secondary"
                className="w-full sm:w-auto"
                disabled={busy}
                onClick={() =>
                  void run(() => passwordRegister(appId, username, password, adminSignupFields))
                }
              >
                パスワードで新規登録
              </Button>
            </div>
          </fieldset>

          {/*
           * **中身は `ErrorList` のままである** —— サーバが返した `path` / `message` /
           * `hint` を1つも要約しない(`ADR-0003` §3)。**器だけを
           * `Alert variant="destructive"` にした。**`ErrorList` 自身も `Alert` を持つので、
           * 外側の枠と余白を落としてある**(`p-0 border-none`)—— **枠が二重に出ないように
           * するためで、見える枠は今日も1つだけである。** **`class="login-error"` と
           * `data-testid="auth-error"` はこの外側が持つ**(どちらも消していない)。
           */}
          {errors !== null && (
            <Alert
              variant="destructive"
              data-testid="auth-error"
              className={cn("login-error", "p-0 border-none")}
            >
              <ErrorList errors={errors} />
            </Alert>
          )}
        </form>
      </Card>
    </main>
  );
}
