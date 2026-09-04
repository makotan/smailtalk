/**
 * **名乗りのガードと、主体の解決**(`V8-M31-T02` / `V8-M31-T03`。台帳 `T-G21a` / `T-G21b` / `T-G22`)。
 *
 * `app-guard.ts`(app_id の実在ガード)の隣に置く —— どちらも「カーネルに触る前に、
 * 入口で1往復で直せる失敗を統一形式へ変える」ためのものであり、責務の高さが同じである。
 *
 * ## なぜ環境変数1本なのか(**ここで決めたのではなく、決まっていたことを実装している**)
 *
 * ユーザ決定 `D-V8-46` の逐語「**起動時に一度だけ**決める」「**指定を忘れると何もできない
 * 状態で立ち上がります**」。したがって:
 *
 * - **ツールの引数を1本も増やさない。** 会話の途中で AI が名乗りを選べる形にすると、
 *   「誰として動くか」を AI 自身が決められることになる。**引数の全量を固定した番人が
 *   5本ある**ことも、この形を裏から支えている(`m31-before.md` §B-4 の #4/#5/#7/#9/#10)。
 * - **起動は成功する。** 名乗りが無いことを起動時の例外にしない —— MCP クライアントから
 *   見ると「サーバが立ち上がらない」は原因の分からない沈黙になる。**立ち上がって、
 *   23本すべてが「名乗っていない」と答える**ほうが、直し方が伝わる。
 *
 * ## **認可であって認証ではない**(`D-V8-54`: 名乗りに**証明を求めない**)
 *
 * **この層は、名乗った文字列がその人本人であることを1ミリも確かめない。** 確かめるのは
 * 「**そのアプリにその利用者が居るか**」だけである。**起動できる人は誰の名前でも書ける。**
 * HTTP の口(`src/server/app.ts`)が Cookie のセッションから主体を得ているのとは、
 * **得方が根本的に違う**(`m31-before.md` §C-5)。
 *
 * ## 二段(**新しい接続を書込の窓の内側で開かない**。裁定 `M31-4`)
 *
 * **(i) ここ**(要求の入口。`requireApp` が通った**あと**)で `AuthStore.openForApp` を
 * **1度だけ**開き、`findUserById` → `findUserByUsername` の順に解決し、実効ロール集合を
 * 取り、**書込の窓を開く前に閉じる**。
 * **(ii) 行の判定の中では、この関数を呼ばない** —— 渡された接続をそのまま読む
 * (`effectiveRolesOnDb(db, userId)`。`src/auth/store.ts:430`)。
 *
 * **理由はリポジトリ自身が書いている。逐語(`src/auth/store.ts:420`-`:423`):**
 *
 * > **【新しい接続を1つも開かない】** —— **`AuthStore.openForApp` を呼ぶと `CREATE TABLE`
 * > (= 書込)が走り、書込トランザクションの内側から呼ぶと `SQLITE_BUSY` になりうる。**
 * > **判定は書込 tx の内側で走るので、渡された接続をそのまま読む。**
 *
 * **`CREATE TABLE` が走るということは、開いた時点でファイルが生えるということでもある**
 * (`src/auth/store.ts:671`-`:677` の `mkdirSync` + `new Database(dbPath, { create: true })`)。
 * **だから解決は `requireApp` の後に置く** —— 先に置くと、AI がタイプミスした app_id で
 * ディレクトリと `app.sqlite` が1つ生える。
 */
import { AuthStore } from "../auth/store.ts";
import type { Role } from "../auth/types.ts";
import type { ValidationError } from "../kernel/index.ts";
import { requireApp } from "./app-guard.ts";

/**
 * 起動設定の直し方(2つの断り文で共有する)。**環境変数の名前と、書ける値の種類を名指しする。**
 * **候補の一覧(`allowed_values`)は付けない** —— サーバは「名乗れる値」の集合を持たないし、
 * そのアプリの利用者名を並べれば、名乗っていない相手に登録済みの人を教えることになる。
 */
const ACTOR_HINT =
  "起動設定の ST_MCP_ACTOR に、そのアプリに登録済みの利用者のログイン名または利用者IDを書いて、" +
  "MCP サーバを起動し直してください(この名乗りが無いと、23本のツールはすべて失敗します)。" +
  // **【`V8-M13-T04`。台帳 `Q-G30`】** **直前の本数は今日は偽である** ——
  // **`V8-M13-T02` が `read_report` を足したので 23 → 24 になった。**
  // **旧文を1バイトも消していない**(このリポジトリの作法。訂正は追記)。
  // **この文字列は接続直後のペイロードに入らない**(断り文の `hint` である)ので、
  // **`CONNECT_TOTAL_MAX` の財布を1文字も使わない。**
  "(直前の「23本」は今日は24本です)。" +
  // **【`V10-M12-T01`。台帳 `CM-G7` / `ADR-0368`】** **直前の本数も今日は偽である** ——
  // **`V10-M12-T01` が `list_comments` を足したので 24 → 25 になった。**
  // **旧文を1バイトも消していない。** **この文字列も接続直後のペイロードに入らない。**
  "(直前の「24本」は今日は25本です)。" +
  // **【`V10-M30-T02`。台帳 `CM-G37` / `ADR-0378`】** **直前の本数も今日は偽である** ——
  // **`V10-M30-T02` が `set_comment_visibility` を足したので 25 → 26 になった。**
  // **旧文を1バイトも消していない。** **この文字列も接続直後のペイロードに入らない。**
  "(直前の「25本」は今日は26本です)。";

/** 名乗りが無い(未設定・空文字・空白だけ)。 */
export function missingActorError(): ValidationError {
  return {
    // 引数空間の位置ではない(名乗りはツールの引数ではなく起動設定である)ので、
    // 根(`""`)を指す。`applyInProgressError` が同じ理由で `""` を使っている。
    path: "",
    message:
      "この MCP サーバは、どの利用者として動くのかを名乗っていません。この状態では何もできません。",
    hint: ACTOR_HINT,
  };
}

/**
 * 名乗った利用者が、そのアプリに居ない。
 *
 * **名乗った文字列をそのまま返さない。** 返しても直し方は増えず(直す場所は起動設定であって
 * 引数ではない)、**「その名前は存在しない」を1件ずつ試せる形**にする理由も無い。
 */
export function unknownActorError(): ValidationError {
  return {
    path: "",
    message: "名乗った利用者は、このアプリに登録されていません。",
    hint: ACTOR_HINT,
  };
}

/**
 * 名乗りを正規化する。**未設定・空文字・空白だけは「名乗り無し」**(`undefined`)。
 *
 * `.mcp.json` に**空の欄**を置く形(`D-V8-84`)を採るので、**空文字は「書き忘れ」ではなく
 * 「まだ書いていない」の既定値として実際に届く。**
 */
export function normalizeActor(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
}

/** 解決できた主体。**`roles` は実効ロール集合**(列の1値 ∪ 付与表)。 */
export type ResolvedActor = {
  id: string;
  username: string;
  roles: Role[];
};

/** 解決の結果。失敗は既存の `{ errors: [...] }` の形に載せる(新しい形式を発明しない)。 */
export type ActorResolution =
  | { ok: true; value: ResolvedActor }
  | { ok: false; errors: ValidationError[] };

/**
 * 名乗りの有無だけを見る(**解決しない**)。
 *
 * `list_apps`(`app_id` を取らない。`D-V8-85`)と `create_app`(アプリがまだ無いので
 * 解決先が無い。`D-V8-53`)の2本が使う。
 *
 * @returns 名乗っていれば `null`、いなければ返すべきエラー配列
 */
export function requireActor(actor: string | undefined): ValidationError[] | null {
  return normalizeActor(actor) === undefined ? [missingActorError()] : null;
}

/**
 * 名乗りをそのアプリの利用者へ解決する(**`AuthStore` を1度だけ開いて、必ず閉じる**)。
 *
 * **IDを優先する** —— ユーザ決定 `D-V8-83` の逐語「名乗りは**ログイン名でもIDでも受ける**。
 * **両方一致ならID優先**」。ログイン名は自由な文字列なので、他人の利用者IDと同じ名前の
 * 利用者を実際に作れる。**その衝突でIDの側が負けると、名乗りの意味が利用者の入力で
 * ひっくり返る。**
 */
export function resolveActor(
  dataRoot: string,
  appId: string,
  actor: string | undefined,
): ActorResolution {
  const named = normalizeActor(actor);
  if (named === undefined) {
    // ここに来るのは呼び出し側が `requireActor` を飛ばしたときだけである。
    // **黙って通さない**(fail-closed)。
    return { ok: false, errors: [missingActorError()] };
  }

  // **開いたら必ず閉じる。****書込の窓(`withAppDb` / `applyDiff`)より前に閉じる**のが
  // 裁定 `M31-4` の (i) であり、そのためにこの関数は行を1つも返さない。
  const store = AuthStore.openForApp(dataRoot, appId);
  try {
    const user = store.findUserById(named) ?? store.findUserByUsername(named);
    if (user === undefined) {
      return { ok: false, errors: [unknownActorError()] };
    }
    return {
      ok: true,
      value: {
        id: user.id,
        username: user.username,
        // **実効ロール集合**(`V8-M16` / `J-G3`。列の1値 ∪ 付与表)——
        // HTTP の口が `src/server/app.ts:1992` で取っているものと同じ。
        roles: store.effectiveRoles(user.id),
      },
    };
  } finally {
    store.close();
  }
}

/**
 * **アプリを名指しする21本が使う関門**(`list_apps` / `create_app` 以外の全部)。
 *
 * **順序が意味を持つ**: 名乗りの有無 → **アプリの実在** → 主体の解決。
 *
 * **【旧の記述を残す】** この関門ができるまで、各ツールの冒頭には次の4行が直に並んでいた:
 *
 * ```
 *       const missing = requireApp(dataRoot, app_id);
 *       if (missing !== null) {
 *         return toolError(missing);
 *       }
 * ```
 *
 * **その4行は消えていない** —— **同じ順序で、この関門の中に在る。** 前後に足したのが
 * 名乗りの検査と主体の解決であり、`requireApp` を後ろに回してはいない(理由はモジュール
 * 冒頭の「`CREATE TABLE` が走る」)。
 */
export function requireActorAndApp(
  dataRoot: string,
  appId: string,
  actor: string | undefined,
): ActorResolution {
  const unnamed = requireActor(actor);
  if (unnamed !== null) {
    return { ok: false, errors: unnamed };
  }
  const missing = requireApp(dataRoot, appId);
  if (missing !== null) {
    return { ok: false, errors: missing };
  }
  return resolveActor(dataRoot, appId, actor);
}
