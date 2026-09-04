/**
 * 認証 middleware がリクエスト context に載せるユーザ表現(V1-M3-T01 / ADR-0014 §6/§7)。
 *
 * middleware(`app.ts`)が `st_session` を解決できたら `c.set("user", ...)` で載せ、
 * 認証エンドポイント(`auth-routes.ts`)や将来のデータ API が `c.get("user")` で参照する。
 * 「ログイン後に自ユーザとして操作できる」(完了条件3)を型で通すための最小の共有点。
 */

import type { Role } from "../auth/types.ts";

/** context に載る認証済みユーザ(cookie の外に出す最小限)。 */
export type AuthUser = {
  id: string;
  username: string;
  displayName: string | null;
  /** アプリ単位のロール(V1-M3-T02)。書込・管理の enforcement に使う。 */
  role: Role;
  /**
   * **実効ロール集合**(`V8-M16` / `J-G3`。**1人が複数の役割を持てる**)。
   *
   * > **実効ロール集合 = `{_auth_users.role の1値}` ∪ `{_auth_user_roles に在る付与}`。**
   * > **判定は「実効ロール集合と宣言集合の積が空でなければ通る」の1本に閉じる。**
   *
   * **根拠は門A の限定 `J-G3` の逐語「複数の役割は和集合1本で合成する」である。**
   * **【この規則は着手時点でどこにも定義されていなかった。`V8-M16` が初めて定義する】** ——
   * 着手前は1ユーザ1値しか持てず、合成規則そのものが存在しなかった。
   *
   * **上の `role` は1バイトも消していない。** **列の値 = 既定の1本目であり、`roles[0]` に
   * 等しい。** **`role` を消さなかったのは、非テストの47箇所へ流れているためである** ——
   * **全部を書き換えるのは `V8-M16` の射程を越える。****判定の側だけを和集合に変えた。**
   */
  roles: Role[];
};

/** Hono の型引数。`c.set("user")` / `c.get("user")` を型付きにする。 */
export type AuthEnv = {
  Variables: {
    user?: AuthUser;
    /**
     * 匿名公開読み取り窓が開いているか(V2-M1-T04 / ADR-0034)。middleware が「未認証 GET で、
     * 対象テーブルが公開規約フィールドを持つ」場合にだけ true を立てる。GET ハンドラはこの
     * フラグを見て「st_public===true の行だけ・予約規約フィールドを伏せて」返す。書込には
     * 立たない(read-only を構造で守る。限定2)。
     */
    anonymousPublic?: boolean;
  };
};
