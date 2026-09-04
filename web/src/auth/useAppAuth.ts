/**
 * アプリ単位の認証状態フック(V1-M3-T01 / ADR-0014 改訂 = per-app)。
 *
 * 認証はアプリごとに独立している(ユーザ・セッションは各 app.sqlite 内)。このフックは
 * **1つのアプリ(`appId`)についての認証状態**だけを見る。マウント時(および `appId` 変更時)
 * に `GET /api/apps/:appId/auth/me` を1回叩き、`loading → authenticated | anonymous` を決める。
 * **`me` の 401 は「そのアプリに未ログイン」の正常応答**なのでエラーにせず anonymous に落とす。
 * 通信不能などその他の失敗も、ログイン画面へ誘導するため anonymous に倒す。
 *
 * ログイン/登録の成功で `setAuthenticated` を呼ぶと authenticated へ、`signOut` で
 * `logout(appId)` を投げてから anonymous へ遷移する。加えて `api.ts` の 401 共通ハンドラに
 * 接続し、**このアプリ**の保護 API(records)がセッション失効(401)を返したら anonymous へ落とす
 * (他アプリ宛の失効通知は無視する)。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { type AuthUser, authMe, logout, setUnauthorizedHandler } from "../api.ts";

export type AuthState =
  | { status: "loading" }
  | { status: "authenticated"; user: AuthUser }
  | { status: "anonymous" };

/**
 * `setAuthenticated` に添える「どうやって認証されたか」(`V4-M21-T03` / `E-G65`)。
 *
 * **状態そのものではなく、直後の1回だけ効く合図である。** ログインと登録を区別する必要が
 * あるのは表示層の案内(登録の直後だけ出す)だけであり、**サーバも `AuthUser` も1バイトも
 * 変わっていない。** **省略できる**(既存の呼び出しは1つも書き換えていない)。
 */
export type AuthenticatedOptions = {
  /** 買い物客としての**新規登録**でこの認証に至ったか。 */
  signedUpAsCustomer?: boolean;
};

export type UseAppAuthResult = AuthState & {
  /**
   * **買い物客として登録した直後か**(`V4-M21-T03`)。
   *
   * **`dismissSignupNotice()` を呼ぶまで、またはログアウト/失効まで真である。**
   * **これは「会員行が在るか」ではない** —— 行の有無を知る手段をこの層は持たない。
   */
  justSignedUpAsCustomer: boolean;
  /** 登録直後の案内を閉じる。 */
  dismissSignupNotice: () => void;
  /** ログイン/登録の成功時に呼ぶ(LoginPage から)。 */
  setAuthenticated: (user: AuthUser, options?: AuthenticatedOptions) => void;
  /** ログアウト。`logout(appId)` 後に anonymous へ。失敗しても anonymous に倒す。 */
  signOut: () => Promise<void>;
  /** `me` を叩き直して状態を取り直す。 */
  refresh: () => void;
};

export function useAppAuth(appId: string): UseAppAuthResult {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  // **登録の直後だけ真になる合図**(V4-M21-T03)。認証状態そのものには混ぜない ——
  // 混ぜると「ログインし直したら会員扱いが変わる」ように読めてしまう。
  const [justSignedUpAsCustomer, setJustSignedUpAsCustomer] = useState(false);
  // 進行中の `me` 確認を識別する連番。状態を確定させる操作(login/logout/失効/appId 変更)は
  // これを進め、**古い `me` 応答が新しい状態を上書きしない**ようにする(cancel トークン兼用)。
  const requestId = useRef(0);

  // `me` を叩いて loading → authenticated | anonymous を確定する。マウント時と refresh から使う。
  const runMeCheck = useCallback(() => {
    const id = ++requestId.current;
    setState({ status: "loading" });
    setJustSignedUpAsCustomer(false);
    authMe(appId).then(
      (user) => {
        if (id === requestId.current) {
          setState({ status: "authenticated", user });
        }
      },
      () => {
        // me の 401(そのアプリに未ログイン)も、通信不能・想定外応答も anonymous に倒す。
        if (id === requestId.current) {
          setState({ status: "anonymous" });
        }
      },
    );
  }, [appId]);

  const setAuthenticated = useCallback((user: AuthUser, options?: AuthenticatedOptions) => {
    // 進行中の me 確認を無効化してから authenticated を確定する。
    requestId.current += 1;
    setState({ status: "authenticated", user });
    // **登録経路から来たときだけ真にする**(ログインでは常に偽に戻す)。
    setJustSignedUpAsCustomer(options?.signedUpAsCustomer === true);
  }, []);

  const dismissSignupNotice = useCallback(() => {
    setJustSignedUpAsCustomer(false);
  }, []);

  const signOut = useCallback(async () => {
    requestId.current += 1;
    setJustSignedUpAsCustomer(false);
    try {
      await logout(appId);
    } finally {
      setState({ status: "anonymous" });
    }
  }, [appId]);

  const refresh = useCallback(() => {
    runMeCheck();
  }, [runMeCheck]);

  // このアプリの保護 API のセッション失効(401)を anonymous に翻訳する。
  // 他アプリ宛の通知は無視する(複数アプリに同時ログインしうるため)。
  useEffect(() => {
    setUnauthorizedHandler((failedAppId) => {
      if (failedAppId === appId) {
        requestId.current += 1;
        setState({ status: "anonymous" });
        setJustSignedUpAsCustomer(false);
      }
    });
    return () => {
      setUnauthorizedHandler(null);
    };
  }, [appId]);

  // マウント時・appId 変更時に本人確認。アンマウント/切替時は連番を進めて古い応答を無効化。
  useEffect(() => {
    runMeCheck();
    return () => {
      requestId.current += 1;
    };
  }, [runMeCheck]);

  return {
    ...state,
    justSignedUpAsCustomer,
    dismissSignupNotice,
    setAuthenticated,
    signOut,
    refresh,
  };
}
