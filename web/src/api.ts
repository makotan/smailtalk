/**
 * HTTP API クライアント(V0-P3-T03 / ADR-0003)。
 *
 * ここに置くのは「URL を組み立てて JSON を読む」ことだけで、マニフェストの
 * 解釈も検証も行わない。エラーは ADR-0003 §3 のとおり常に
 * `{ errors: ValidationError[] }` で返ってくるので、そのまま例外に載せて運ぶ
 * (フロント側で文面を作り直さない = カーネルの文面を一本に保つ)。
 *
 * ## `src/kernel/` からの import について
 *
 * 原則は「**型としてのみ** import する」である。`import type` は `verbatimModuleSyntax`
 * によって完全に消えるため、`bun:sqlite` に依存するカーネル実装がブラウザ用バンドルに
 * 入り込むことはない。
 *
 * **例外が1つだけある —— 下の `normalizeSort`(`:17`)は値の import である。**
 * ADR-0009 が門A で**限定採用**した1件で、`web/src/` がカーネルの値を import している
 * 箇所はこのリポジトリでここだけである(ADR-0009 限定2)。`sort` は単数表記と配列表記の
 * 2つを受理するので、その正規化を画面側に複製すると**同じマニフェストが画面とカーネルで
 * 別の並び順を意味しうる**。複製ではなく共有を採ったのはそのためで、`normalizeSort` が
 * 「型ではないのに越えてよい」唯一の理由もそこにある。
 *
 * **この例外が成立しているのは、`src/kernel/types.ts` が import を1つも持たないからにすぎない。**
 * `types.ts` に import が1行入れば、そこから実装が推移的に辿られて `vite build` が壊れる
 * (`web/src/table-resolution.ts:14-16` が名指しで避けた失敗そのもの)。この前提は
 * ADR-0009 限定3 であり、`scripts/kernel-types-no-import.test.ts` が機械的に固定している。
 *
 * **新しい値の import をここに足してよいという意味ではない。** 足すには ADR-0009 の
 * 限定1・限定2 を改訂する必要がある(門A + 個別 ADR)。
 */
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import type { Role } from "../../src/auth/types.ts";
/*
 * `V10-M32-T01`: **型だけを取る**(`import type`)。**値は1つも取らない** ——
 * `comment-store.ts` は `bun:sqlite` へ推移的に依存するが、`verbatimModuleSyntax` に
 * よって型 import は完全に消え、バンドルには1バイトも入らない(`CommentPanel.tsx` の
 * `CommentAnchorForm` が既に同じ位置にある)。**`scripts/kernel-import-snapshot.txt` は
 * 値 import しか採らないので、この行では1行も動かない。**
 */
import type { CommentState } from "../../src/kernel/comment-store.ts";
import type { ValidationError } from "../../src/kernel/errors.ts";
import type { AppRecord } from "../../src/kernel/meta-store.ts";
import type { RecordInput, RecordRow, RecordValue } from "../../src/kernel/records.ts";
/*
 * V1-M8-T02 / ADR-0025 限定9: **Web はカーネルから型のみ import する。**
 * `requirements-doc.ts` は `bun:sqlite` へ推移的に依存するが、`import type` は
 * `verbatimModuleSyntax` によって完全に消えるのでバンドルには1バイトも入らない
 * (`meta-store.ts` からの `AppRecord` が既に同じ位置にある)。**値は1つも取らない。**
 */
import type {
  RequirementIdentifiers,
  RequirementSection,
  RequirementStatement,
  StatementSource,
} from "../../src/kernel/requirements-doc.ts";
import type {
  FilterCondition,
  FilterNode,
  Manifest,
  SetThemeOperation,
  Sort,
  Table,
  View,
} from "../../src/kernel/types.ts";
import { normalizeSort } from "../../src/kernel/types.ts";
import { runPasskeyLogin, runPasskeyRegistration } from "./auth/passkey.ts";

export type {
  AppRecord,
  CommentState,
  FilterCondition,
  RecordInput,
  RecordRow,
  RequirementIdentifiers,
  RequirementSection,
  RequirementStatement,
  Role,
  Sort,
  StatementSource,
  ValidationError,
};

/**
 * 認証済みユーザの最小表現(サーバの `/api/apps/:app_id/auth/*` が `{ user }` で返す形。ADR-0014 §6)。
 * cookie はサーバが HttpOnly で管理するので、フロントはこの表示用の値しか持たない。
 * `role` は V1-M3-T02 で追加(per-app の権限。owner/editor/viewer)。
 */
export type AuthUser = {
  id: string;
  username: string;
  displayName: string | null;
  role: Role;
};

/**
 * owner 向けのユーザ管理一覧の1行(サーバの `GET /auth/users` が返す形。V1-M3-T02)。
 * `AuthUser` に登録日時を足したもの。
 */
export type AppUser = AuthUser & {
  createdAt: string;
};

/** API が統一形式で返したエラー。`errors` は常に配列(ADR-0003 §3)。 */
export class ApiError extends Error {
  readonly status: number;
  readonly errors: ValidationError[];

  constructor(status: number, errors: ValidationError[]) {
    super(errors.map((error) => error.message).join(" / ") || `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.errors = errors;
  }
}

/**
 * 権限不足(403)か。records 書込で viewer が弾かれた場合や、owner でない者が管理
 * エンドポイントを叩いた場合に返る。**401(セッション失効)とは区別する** —— 401 は
 * 共通ハンドラがログイン画面へ落とすが、403 は「ログイン済みだが権限が無い」ので
 * その場で「閲覧のみ」と伝える(V1-M3-T02)。
 */
export function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

/**
 * 「最後の owner は降格できない」競合(409)か。owner のロール変更でだけ返る
 * (`setAppUserRole`)。呼び出し側はこれを専用の文面で出す(V1-M3-T02)。
 */
export function isLastOwnerConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

// 楽観ロック(M9-T02 / ADR-0017)の 409 は2種類あり、意味も対処も違う:
//  - **適用中** … apply_diff がそのアプリに走っている窓での書込。少し待てば通る。
//  - **版不一致** … 取得後に別の操作が入った(silent-overwrite を防ぐ保護)。取り直してやり直す。
// 統一エラー(`src/kernel/errors.ts` の `ValidationError`)は path/message/hint/allowed_values
// だけで**機械可読な種別コードを持たない**。フロントで種別を足すのは「カーネルの文面を一本に
// 保つ」方針に反するため、サーバ/カーネルが返す**文面の特徴語**で判別する。判別語は下記2つで、
// サーバ側の定義(`src/server/app.ts` の `applyInProgressError` / `src/kernel/records.ts` の
// `versionConflictError`)と対になる。文面がドリフトすれば `web/test/api.test.ts` の実サーバ
// 突き合わせ(実際に版不一致を起こす)が落ちるので、この結合はテストで固定されている。

/** 版不一致メッセージの特徴語。`versionConflictError` の「…変更されています。」に対応。 */
const VERSION_CONFLICT_MARKER = "変更されています";
/** 適用中メッセージの特徴語。`applyInProgressError` の「…適用中です…」に対応。 */
const APPLY_IN_PROGRESS_MARKER = "適用中";

/** 409 の統一エラーで、いずれかのメッセージが `marker` を含むか。 */
function is409WithMarker(error: unknown, marker: string): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.errors.some((entry) => entry.message.includes(marker))
  );
}

/**
 * 差分適用中(409)か。apply_diff がそのアプリに走っている間の records 書込
 * (create/update/delete)で返る(M9-T02)。**版不一致(`isWriteConflict`)とは区別する**
 * —— こちらは「少し待てば通る」ので、呼び出し側は再試行を促す文面を出す。
 */
export function isApplyInProgress(error: unknown): boolean {
  return is409WithMarker(error, APPLY_IN_PROGRESS_MARKER);
}

/**
 * レコードの版不一致(409)か。楽観ロック(`If-Match`)で、取得後に別のユーザ/セッションが
 * 先に同じレコードを変更していたとき、update/delete で返る(M9-T02)。**401(失効)・
 * 403(権限)・409「適用中」(`isApplyInProgress`)とは区別する** —— 呼び出し側は
 * 「最新を取り込んでやり直す」よう促す。
 */
export function isWriteConflict(error: unknown): boolean {
  return is409WithMarker(error, VERSION_CONFLICT_MARKER);
}

/**
 * **ぶら下がっている行があるための断り**(`V18-M7-T05` / `PM-G5` / `ADR-0444` §Decision 3)。
 * **`children_forbidden` は ③(中に、この人には消せない行がある。**件数も表のIDも1文字も載らない**)、
 * `children_confirmation` は ④ / ⑤(件数の印が無い / 合わない。`total` は次に送るべき印の値)。**
 * **`message` / `hint` はサーバの文面そのままで、件数と表のIDはその**文の中**にしか無い**(同
 * §Decision 5 の 行30。応答の鍵は4本のまま)。
 */
export type CascadeDeleteDenial =
  | { kind: "children_forbidden"; message: string; hint: string }
  | { kind: "children_confirmation"; total: number; message: string; hint: string };

/** ③ / ④ / ⑤ に共通の語 / ③ だけが持つ語 / ④ ⑤ から「今の件数」を取り出す形。 */
const CASCADE_CHILDREN_MARKER = "ぶら下がっている行";
const CASCADE_FORBIDDEN_MARKER = "あなたには消せないものがあります";
const CASCADE_TOTAL_PATTERNS = [/ぶら下がっている行が (\d+) 件あります/, /今は (\d+) 件です/];

/**
 * **ぶら下がっている行の断りを読み、③ と ④ / ⑤ を見分ける**(`V18-M7-T05`)。 **呼び出し側はこの
 * 1本を先に読み、`null` のときだけ今までの分岐に落とすこと。**
 * **【新しい 409 が版不一致に吸われないこと】** **`isWriteConflict` は `409` かつ本文に
 * `VERSION_CONFLICT_MARKER` を含むものだけを掴み、サーバの断り文2本にはその語が1度も無い**
 * (`ADR-0444` 限定10。`app.ts` を綴りで走査して 0 件)—— **`isApplyInProgress` にも入らない。**
 * **【誇張しない】文面で見分けている** —— **機械可読な種別コードは今日も無く(鍵は4本)、増やすことは
 * 同 限定13 が禁じている。** **ずれたら静かに `null` を返し、赤にするのは (D-5) だけである。**
 */
export function readCascadeDeleteDenial(error: unknown): CascadeDeleteDenial | null {
  if (!(error instanceof ApiError) || (error.status !== 403 && error.status !== 409)) {
    return null;
  }
  const entry = error.errors.find((row) => row.message.includes(CASCADE_CHILDREN_MARKER));
  if (entry === undefined) {
    return null;
  }
  const hint = entry.hint ?? "";
  if (error.status === 403) {
    return entry.message.includes(CASCADE_FORBIDDEN_MARKER)
      ? { kind: "children_forbidden", message: entry.message, hint }
      : null;
  }
  for (const pattern of CASCADE_TOTAL_PATTERNS) {
    const digits = entry.message.match(pattern)?.[1];
    if (digits !== undefined) {
      const total = Number.parseInt(digits, 10);
      return { kind: "children_confirmation", total, message: entry.message, hint };
    }
  }
  return null;
}

/**
 * セッション失効(保護 API の 401)を **アプリ単位で** 扱うための共通ハンドラ。
 *
 * 認証はアプリ単位(ADR-0014 改訂 / per-app)なので、失効も「どのアプリが切れたか」で
 * 通知する。cookie はサーバが HttpOnly + Path=/api/apps/:app_id で管理するのでフロントから
 * 失効を直接観測できない。そこで「そのアプリの保護 API(records)が 401 を返した=そのアプリの
 * セッションが切れた」とみなし、登録済みハンドラへ **app_id を渡して** 通知する
 * (`useAppAuth(appId)` が自分の appId 宛の通知だけを拾って anonymous へ落とす)。
 *
 * **例外**: `GET .../auth/me` は未ログインでも 401 を返す“正常応答”であり、認証系の POST
 * (login/register の失敗)も 401 を返しうる。これらは呼び出し側が `skipUnauthorized`
 * を付けて叩くので、この共通ハンドラは発火しない(呼び出し側が `ApiError` で扱う)。
 * また manifest / list_apps など非保護 API は `appId` を渡さないので発火しない。
 */
let unauthorizedHandler: ((appId: string) => void) | null = null;

/** セッション失効時に呼ばれるハンドラを登録する(1つだけ。null で解除)。 */
export function setUnauthorizedHandler(handler: ((appId: string) => void) | null): void {
  unauthorizedHandler = handler;
}

/** リクエスト単位の細かな挙動指定。 */
type RequestExtras = {
  /** 401 を「セッション失効」共通ハンドラに渡さない(`me` と認証系 POST で使う)。 */
  skipUnauthorized?: boolean;
  /**
   * このリクエストが属するアプリ。保護 API(records)が 401 を返したとき、この app_id を
   * 載せて失効ハンドラを発火させる。非保護 API では省略し、発火させない。
   */
  appId?: string;
};

/** 失敗応答を `ApiError` に変換し、必要なら 401 共通ハンドラを発火させる。 */
async function toApiError(response: Response, extras: RequestExtras): Promise<ApiError> {
  const errors = await readErrors(response);
  if (response.status === 401 && extras.skipUnauthorized !== true && extras.appId !== undefined) {
    unauthorizedHandler?.(extras.appId);
  }
  return new ApiError(response.status, errors);
}

async function getJson<T>(path: string, extras: RequestExtras = {}): Promise<T> {
  const response = await fetch(path, {
    headers: { accept: "application/json" },
    credentials: "include",
  });
  if (!response.ok) {
    throw await toApiError(response, extras);
  }
  return (await response.json()) as T;
}

/** エラーボディを読む。JSON でない(想定外の)応答でも統一形式に揃えて返す。 */
async function readErrors(response: Response): Promise<ValidationError[]> {
  try {
    const body = (await response.json()) as { errors?: unknown };
    if (Array.isArray(body.errors)) {
      return body.errors as ValidationError[];
    }
  } catch {
    // JSON として読めない応答(プロキシ不調など)。下の既定に落ちる。
  }
  return [{ path: "", message: `サーバが ${response.status} を返しました。` }];
}

/** GET /api/apps */
export async function fetchApps(): Promise<AppRecord[]> {
  const body = await getJson<{ apps: AppRecord[] }>("/api/apps");
  return body.apps;
}

/**
 * GET /api/apps/:app_id/manifest
 *
 * **毎回サーバから取得する**。マニフェストをフロントに焼き込まないこと自体が
 * 解釈実行(憲法3)の実装上の裏付けであり、V0-P3-T07 の完了条件でもある。
 */
/**
 * **アプリごとのコメント設定**(`V10-M31-T01` / 台帳 `CM-G38` / `ADR-0377`)。
 *
 * **`src/kernel/meta-store.ts` から型を import していない** —— **web 側に同じ形を1つ置く。**
 * **`write` は「書く欄を出すか」の合図であって、書込を止める壁ではない**(`D-V10-38`)。
 */
export type CommentVisibilityFlags = { write: boolean; read: boolean };

/**
 * **定義の取得の応答**(`V10-M31-T01`)。**`Manifest` の**外側**に兄弟キーが1本載る。**
 *
 * **任意キー(`?`)である** —— **未ログイン経路の `publicManifest`(`web/src/AppWorkspace.tsx`)が合成する
 * `Manifest` を、そのままこの型として扱えるようにするためである**(サーバから渡る応答には
 * 必ず載るが、合成した側には載らない)。
 */
export type ManifestResponse = Manifest & { comment_visibility?: CommentVisibilityFlags };

export async function fetchManifest(appId: string): Promise<ManifestResponse> {
  // **【`V8-M21` / `J-G24a` / `D-V8-21`】この口は今日からログインを要求する。**
  // **未ログインでは 401 になる** —— **`AppWorkspace` はそれを受けて
  // {@link fetchPublicAppInfo} へ倒す。** **`appId` を渡していないので失効ハンドラは
  // もともと発火しない**(上の `RequestExtras.appId` の doc)。
  // **【`V10-M31-T01`】旧文の逐語(1バイトも消していない)**:
  //   ``return await getJson<Manifest>(`/api/apps/${encodeURIComponent(appId)}/manifest`);``
  // **今日から応答に兄弟キー `comment_visibility` が1本載る**(`ADR-0377` の設定)。
  return await getJson<ManifestResponse>(`/api/apps/${encodeURIComponent(appId)}/manifest`);
}

/**
 * **未ログインへ開いた画面1枚の定義**(`V8-M26-T05` / 台帳 `T-G27b` / `D-V8-57`)。
 *
 * **画面の定義そのもの({@link View})に、その画面が描くのに要る表の定義を
 * `tables` として1本足した形である。** **トップレベルに4つ目のキーを作らない形を
 * 採ったので、表はここに入っている**(`ADR-0319` 限定5)。
 *
 * **`tables` に行(データ)は1行も入っていない** —— **行は今日どおりレコードの口から
 * 取り、そこで面の既定と `st_public` の窓が効く**(`D-V8-64`)。
 */
export type PublicView = View & { name: string; tables: readonly Table[] };

/**
 * **未ログインへ渡る最小限**(`V8-M21` / `J-G24b` / `D-V8-34`)。
 *
 * **【旧文の逐語。1バイトも消していない】** ——
 * 「**返るのは「アプリ名」と「未ログインでも見せると決めた画面の名前」だけである。**
 * **項目名・自動処理・他の画面・権限の宣言(`app.roles`)は1バイトも返らない。**
 *
 * **【この型でできないこと。丸めない】** **画面は描けない** ——
 * **表も列も絞り込みも入っていない。** **使い道はログイン画面の見出しと導線と配色だけである。**」
 *
 * **【2026-08-11(`V8-M26-T05` / 台帳 `T-G27b` / ユーザ決定 `D-V8-57`)。旧文は今日は偽である】**
 *
 * **今日は「未ログインに開いた画面については」描ける** —— **画面の定義そのもの(種別・
 * 対象の表・列・並べ替え・絞り込み・プリセット・子一覧・操作)と、その画面が描くのに
 * 要る表の定義({@link PublicView})が返る。**
 *
 * **【今日も返らないもの。名指しする】** **未ログインに開いていない画面 / その画面が
 * 使わない表 / 自動処理(ワークフロー・関数)/ 権限の宣言(`app.roles`)/ 表の**行**。**
 *
 * **【今日も隠せないもの。丸めない】** **未ログインには項目の規則を1本も書けない**
 * (スキーマが `anonymous` の `target` を `["table","view","action"]` に閉じている)。
 * **したがって公開画面に載せた項目は、運営メモであっても1本も隠せない。**
 */
export type PublicAppInfo = {
  app: { id: string; name: string };
  views: readonly PublicView[];
  /**
   * **テーマ(配色)**。**宣言していないアプリでは `undefined`。**
   *
   * **【メインが足すと決めたもの。黙って足していない】** —— **`D-V8-34` の逐語
   * 「ログイン画面も公開ページも今どおり出る」を根拠に、`V8-M21` の後半の途中で足した。**
   * **配色は「アプリ名と画面の名前**だけ**」の「だけ」の外にある**(サーバ側の
   * `GET /api/apps/:app_id/public` のコメントに同じ断りを書いた)。
   */
  theme?: Manifest["app"]["theme"];
  /**
   * **登録に要る事実**(`V8-M5-T03` / `V8-M5-T04`。**ユーザ決定 `D-V8-114`**)。
   *
   * **`GET /api/apps/:app_id/public` の4つ目のキーである** —— **`ADR-0319` 限定1
   * (トップレベルのキーを4つ目にしない)を `D-V8-115` が引き直した**(引き直す側は
   * `ADR-0338`。**`ADR-0319` の本文は1バイトも書き換えていない**)。
   *
   * **【この型が意味すること。丸めない】** **ログインしていない誰でも、そのアプリに
   * どんな立場があるか(識別子と表示名)と、どれが招待制かを見られる。**
   * **【禁止】「未ログインに見える情報は増えていない」と書かない。**
   *
   * **【行(データ)は1行も入っていない】** **利用者の一覧も、招待の一覧も、招待コードも
   * 1文字も入らない**(`D-V8-64` / `ADR-0338` 限定3 / 限定13)。
   */
  signup?: SignupFacts;
};

/** **セルフ登録で名乗れる立場1つ**(`ADR-0338` §3-1)。**3キーちょうどで閉じる。** */
export type SignupKind = {
  id: string;
  /** **宣言が無ければ識別子がそのまま入る**(`D-V8-79` により `name` は任意)。 */
  name: string;
  /** **その立場で名乗ったとき招待が要るか。** */
  invite: boolean;
};

/**
 * **登録に要る事実の全量**(`ADR-0338` §3-1)。**2キーちょうどで閉じる。**
 *
 * **`kinds` はサーバが受理する値と1対1である** —— **画面はこの値をそのまま描き、
 * 値域を1つも組み直さない**(同 限定4)。
 * **【注記の書き方の限定】** **この注釈に、値域を組むサーバ側の関数名を書き写していない**
 * —— **書くと同 限定4 を測る式が、自分の注釈を数え始める。**
 */
export type SignupFacts = {
  kinds: readonly SignupKind[];
  /** **運営が人を足す口が招待を要求するか**(= 予約3語のどれかが招待制か)。 */
  adminInvite: boolean;
};

/** `GET /api/apps/:app_id/public`(**未ログインでも読める。認証を要求しない**)。 */
export async function fetchPublicAppInfo(appId: string): Promise<PublicAppInfo> {
  return await getJson<PublicAppInfo>(`/api/apps/${encodeURIComponent(appId)}/public`);
}

// --- レコード系(ADR-0003 §4 の #3〜#7) --------------------------------------------

/**
 * ボディ付きの書き込み(POST / PATCH)。成功ボディは呼び出し側の型 `T`。
 *
 * `headers` は既定のヘッダに**上書きマージ**する追加ヘッダ。楽観ロックの `If-Match`
 * (M9-T02)のように、呼び出しごとにしか決まらないヘッダをここから載せる。
 */
async function sendJson<T>(
  path: string,
  method: "POST" | "PATCH",
  body: unknown,
  extras: RequestExtras = {},
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { accept: "application/json", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    credentials: "include",
  });
  if (!response.ok) {
    throw await toApiError(response, extras);
  }
  return (await response.json()) as T;
}

/** レコードのコレクション URL(一覧・作成の共通部分)。 */
function recordsPath(appId: string, tableId: string): string {
  return `/api/apps/${encodeURIComponent(appId)}/tables/${encodeURIComponent(tableId)}/records`;
}

/** レコード1件の URL。 */
function recordPath(appId: string, tableId: string, recordId: string): string {
  return `${recordsPath(appId, tableId)}/${encodeURIComponent(recordId)}`;
}

/**
 * ADR-0003 §5 のクエリ文字列を組み立てる(`sort` / `order` / `filter.<field>`)。
 *
 * 値の文字列化はサーバ側のデコード(`number` は `Number()`、`boolean` は
 * `"true"` / `"false"`)と対称になるよう `String()` に一本化する。ここでは
 * 「マニフェストの意図を URL に写す」以上のことをしない —— 条件が妥当かどうかの
 * 判定はカーネルの担当であり、フロントで先回りして弾かない。
 */
function buildListQuery(options: {
  sort?: Sort | Sort[];
  filter?: FilterCondition[] | FilterNode;
  limit?: number;
  offset?: number;
  view?: string;
  sumField?: string;
}): string {
  const parts: string[] = [];
  // 複合ソート(V1-M0-T03)は sort= と order= の組を**キーの順に**繰り返す。
  // 表記(単数オブジェクト / 配列)の違いは `normalizeSort` で吸収済みなので、
  // ここには「どちらで書かれていたか」の分岐が無い —— これが解釈を割らせないための形である。
  for (const key of normalizeSort(options.sort)) {
    parts.push(`sort=${encodeURIComponent(key.field)}`);
    parts.push(`order=${encodeURIComponent(key.order)}`);
  }
  // filter は **等値AND配列(後方互換)| ブール式(EC-G12 / ADR-0043)**。
  // 配列は従来どおり `filter.<field>=` の平坦形。ブール式は URL で平坦化できないので
  // `filter=<JSON>` の1個で渡す(サーバの parseListOptions がどちらも受ける)。
  if (Array.isArray(options.filter)) {
    for (const condition of options.filter) {
      parts.push(
        `filter.${encodeURIComponent(condition.field)}=${encodeURIComponent(String(condition.equals))}`,
      );
    }
  } else if (options.filter !== undefined) {
    parts.push(`filter=${encodeURIComponent(JSON.stringify(options.filter))}`);
  }
  // ページネーション(EC-G11 / ADR-0042)。ページ位置はリクエスト引数であってマニフェストには
  // 現れない(D-G11)。指定されたときだけ載せる(未指定は全件 = 後方互換)。
  if (options.limit !== undefined) {
    parts.push(`limit=${encodeURIComponent(String(options.limit))}`);
  }
  if (options.offset !== undefined) {
    parts.push(`offset=${encodeURIComponent(String(options.offset))}`);
  }
  // **どの画面から呼んでいるか(V4-M3-T03 / `B-G1` / ADR-0070 限定3)。**
  // **サーバがこの画面の宣言を読んで拒否できるようにするために載せる** ——
  // **【`V8-M20` / `J-G27`】旧文はここで `audience` を名指ししていた。撤去された。**
  // **今日サーバが読むのは面の画面の規則である。**
  // **渡さなければサーバは今日どおり判定しない**(限定4)ので、載せるのは
  // 「その画面の対象テーブルを引くとき」だけである(参照ラベルや `related` の取得には
  // 載せない —— 画面の `table` と URL の table が食い違い、サーバが 400 を返す)。
  if (options.view !== undefined) {
    parts.push(`view=${encodeURIComponent(options.view)}`);
  }
  // **どの列の合計を求めるか(V4-M23-T03 / `D-V4-89` / `E-G31` / ADR-0104 限定3)。**
  // **画面の `list_view.sum_field` を、`filter` / `sort` / `limit` とまったく同じ形で
  // 読取パラメータへ翻訳する**(`ADR-0003` §5 以来の分担。1ミリも変えていない)。
  // **渡さなければ応答に `sum` は1バイトも載らず、URL は着手前と1バイトも変わらない。**
  // **載せるのは「その画面の対象テーブルを引くとき」だけである** —— 参照ラベルの取得
  // (別テーブル)には載せない。
  // **束ねるキーも2つ目の演算も、ここに書く場所が無い**(限定2 / 限定8)。
  if (options.sumField !== undefined) {
    parts.push(`sum=${encodeURIComponent(options.sumField)}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

/**
 * GET /api/apps/:app_id/tables/:table_id/records
 *
 * `options` は `list_view` の `sort` / `filter` をそのまま渡す想定。
 *
 * **【V4-M3-T03 / `B-G1` / ADR-0070 による訂正】** **旧文面は「ビューID をサーバに渡す口は
 * 存在しない(ADR-0003 §5)ので、翻訳は呼び出し側で行う。」だった** —— **今日は `?view=` の
 * 口が在るので、その1文は偽である。** **口が在ることと、渡さなければ今日どおりであること
 * (限定4)を両方書く。** **`sort` / `filter` の翻訳を呼び出し側で行う点は1ミリも変わらない。**
 */
export async function fetchRecords(
  appId: string,
  tableId: string,
  options: { sort?: Sort | Sort[]; filter?: FilterCondition[] | FilterNode; view?: string } = {},
): Promise<RecordRow[]> {
  const body = await getJson<{ records: RecordRow[] }>(
    `${recordsPath(appId, tableId)}${buildListQuery(options)}`,
    { appId },
  );
  return body.records;
}

/**
 * **行1件ぶんの判定**(`V14-M2-T01`。台帳 `RB-G1`。`ADR-0402` §Decision 4)。
 *
 * **正はサーバの `recordRowAccessMap`(`src/server/owner-scope.ts` の `RecordRowAccess`)であり、
 * ここはそれを受け取る側の写しである。** **画面側で値を作らない・和も積も取らない。**
 *
 * **キーは4つちょうどである**(`ADR-0402` 限定2)—— **`blockedBy`(止めた層の名前)を
 * 1バイトも持たない。** **`grant_write` は `read` / `write` / `delete` とは
 * **別の問い**であり、同じ入れ物に置くが混ぜない**(限定18)。
 *
 * **【禁止】`grant_write: true` を「押せば必ず作れる」と読まない** —— **真が意味するのは
 * 「関門 (1)(2) で止まらない」ことだけである**(`ADR-0402` §Decision 5)。
 *
 * **【2026-09-16 訂正(`V18-M8-T02b` / `D-V18-33` / `ADR-0445` §Decision 4・§Decision 5・§Decision 6)。
 * 直前の2行を1バイトも消していない】**
 * **直前の逐語「真が意味するのは「関門 (1)(2) で止まらない」ことだけである」は、今日の正ではない。**
 * **今日の真が意味するのは「関門 (1)(2) と所属の穴で止まらず、**かつ**表示の時点で決まる断りにも
 * 掛からない」ことである** —— **付与表への面の書込 / 直接作成の遮断 / ボタンの規則 /
 * 必ず送る欄の項目規則 / 付与表そのものの宣言が掛ける関門を、サーバの `rowGrantWriteJudge` が写す。**
 * **【禁止】それでも「押せば必ず作れる」と読まない** —— **(3) 相手が自分 / (4) 相手が解決できない /
 * (5) 相手が親を読めない と、持ち主の偽装・条件つきの規則は、今日も1つも写していない**
 * (`ADR-0402` 限定17 の後半 / `ADR-0445` §Decision 4 の表)。
 * **真と出た行を押しても断られる人は、今日も居る。**
 * **`?member=` で他人について問うた答えだけは、面を1つも掛けない**(同 §Decision 6)——
 * **キーの名前は同じでも、一覧・単票の値とは見ている断りの数が違う。**
 *
 * **宣言していない表では、この値がそもそも返ってこない**(限定4)。**そのとき画面は
 * 着手前と1バイトも同じ見え方をする。**
 */
export type RowAccess = {
  readonly read: boolean;
  readonly write: boolean;
  readonly delete: boolean;
  readonly grant_write: boolean;
};

/**
 * GET .../records with pagination — records と total を返す(EC-G11 / ADR-0042)。
 *
 * `fetchRecords`(配列だけ返す)は参照ラベル取得など「全件を1回だけ引く」用途に残し、
 * ページUIを持つ一覧はこちらを使う。`total` は filter 適用後の総件数で、「続きがあるか」は
 * `offset + records.length < total` で導出できる。サーバが total を返さない旧応答に備えて
 * `records.length` にフォールバックする(過剰なフィールドを増やさない)。
 */
export async function fetchRecordPage(
  appId: string,
  tableId: string,
  options: {
    sort?: Sort | Sort[];
    filter?: FilterCondition[] | FilterNode;
    limit?: number;
    offset?: number;
    /** どの画面から呼んでいるか(`B-G1` / ADR-0070)。渡さなければサーバは判定しない。 */
    view?: string;
    /**
     * **合計を出す列**(`V4-M23-T03` / `D-V4-89` / `E-G31` / ADR-0104 限定3)。
     * **画面の `list_view.sum_field` をそのまま渡す。渡さなければサーバは合計しない。**
     */
    sumField?: string;
  } = {},
): Promise<{
  records: RecordRow[];
  total: number;
  sum?: number;
  /**
   * **行ごとの判定**(`V14-M2-T01`。鍵は行の `_id`)。**サーバが返したときだけ持つ。**
   * **宣言していない表では、このキーごと存在しない**(`ADR-0402` 限定4)。
   */
  access?: Record<string, RowAccess>;
}> {
  const body = await getJson<{
    records: RecordRow[];
    total?: number;
    sum?: number;
    access?: Record<string, RowAccess>;
  }>(`${recordsPath(appId, tableId)}${buildListQuery(options)}`, { appId });
  return {
    records: body.records,
    total: body.total ?? body.records.length,
    // **サーバが `sum` を返さなかったときは `undefined` のままにする**(`0` に倒さない)——
    // **`0` に倒すと「合計は0円だった」という嘘になる。** 表示層は `undefined` のとき
    // 合計を1つも描かない。
    ...(typeof body.sum === "number" ? { sum: body.sum } : {}),
    // **`sum` と1バイトも同じ形で載せる**(`V14-M2-T01`)—— **サーバが返さなければ
    // キーごと持たない。** **【禁止】`{}` に倒さない** —— **`{}` は「この一覧の行は
    // 誰も何もできない」という嘘になる。**
    ...(body.access === undefined ? {} : { access: body.access }),
  };
}

/**
 * **集計表の群1つ分のキー**(`V8-M11-T06`。台帳 `Q-G20`)。
 *
 * **`_id` を1つも持たない** —— **群は行ではないので、指せる識別子がそもそも無い**
 * (`src/kernel/report.ts` の `ReportGroupKey`)。
 */
export type ReportGroupKeyValue = { field: string; value: RecordValue };

/** 集計値1つ。**`count` には `field` が付かない**(付ける場所が宣言に無い)。 */
export type ReportAggregateValue = { type: "sum" | "count"; field?: string; value: number };

/** 束ねた群1つ。**`keys` は宣言の `group_by` の順、`aggregates` は `aggregates` の順である。** */
export type ReportGroupRow = { keys: ReportGroupKeyValue[]; aggregates: ReportAggregateValue[] };

/**
 * 集計表1枚の応答(`GET /api/apps/:app_id/views/:view_id/report`)。
 *
 * **`total_groups` も `totals` も、ページを切る**前**の全体である**(`D-V8-129` / `D-V8-122`)。
 * **`groups` だけがページで切られている** —— **サーバは応答に `limit` / `offset` を
 * 1バイトもエコーしない**(`src/server/app.ts` の該当箇所の注記)。
 */
export type ReportPage = {
  groups: ReportGroupRow[];
  total_groups: number;
  totals: ReportAggregateValue[];
};

/**
 * **読取のたびに渡せる並べ替え**(`V8-M11-T03` / `D-V8-130`)。
 *
 * **3つそろっていなければサーバは 400 を返す**(all-or-nothing)—— **したがって
 * 部分的に渡す形をこの型では作れないようにしてある**(3つとも必須)。
 * **`index` は宣言に書いた順の番号で、先頭が 0 である。**
 * **渡した順序は「読むときの1枚」にだけ効き、マニフェストは1バイトも書き換わらない。**
 */
export type ReportSortQuery = {
  target: "group_by" | "aggregate";
  index: number;
  order: "asc" | "desc";
};

/**
 * GET /api/apps/:app_id/views/:view_id/report
 *
 * **`web/` が集計表の API を叩く唯一の口である**(`V8-M11-T06`。**着手前は0本だった**)。
 *
 * **受け取れるクエリは5つちょうどである** —— `limit` / `offset` / `sort_target` /
 * `sort_index` / `sort_order`。**「項目名」を渡す口が1つも無い**(`Q-G22` の読取側。
 * サーバ側の機械的固定は `src/server/report-declaration-boundary.test.ts` の (44))。
 *
 * **`limit` を省くとサーバが先頭 100 群を返す** —— **一覧(省略で全件)とは既定が違う。**
 * **画面はページの幅を1箇所で決めて明示的に渡すので、この違いに寄りかかっていない。**
 *
 * **`{ appId }` を渡している** —— **保護 API なので、401 は「そのアプリのセッションが
 * 切れた」として共通ハンドラへ流す**(レコード読取と同じ扱い)。
 */
export async function fetchReport(
  appId: string,
  viewId: string,
  options: { limit?: number; offset?: number; sort?: ReportSortQuery } = {},
): Promise<ReportPage> {
  const parts: string[] = [];
  if (options.limit !== undefined) {
    parts.push(`limit=${encodeURIComponent(String(options.limit))}`);
  }
  if (options.offset !== undefined) {
    parts.push(`offset=${encodeURIComponent(String(options.offset))}`);
  }
  // **3つを**まとめて**載せる** —— **1つでも欠けるとサーバが 400 を返すので、
  // 「1つだけ載る」経路をここに作らない。**
  if (options.sort !== undefined) {
    parts.push(`sort_target=${encodeURIComponent(options.sort.target)}`);
    parts.push(`sort_index=${encodeURIComponent(String(options.sort.index))}`);
    parts.push(`sort_order=${encodeURIComponent(options.sort.order)}`);
  }
  const query = parts.length === 0 ? "" : `?${parts.join("&")}`;
  return await getJson<ReportPage>(
    `/api/apps/${encodeURIComponent(appId)}/views/${encodeURIComponent(viewId)}/report${query}`,
    { appId },
  );
}

/**
 * GET /api/apps/:app_id/tables/:table_id/records/:record_id
 *
 * **`viewId` を渡すと `?view=` が載り、サーバが画面の宣言を判定する**
 * (V4-M3-T03 / `B-G1` / ADR-0070 限定3)。**渡さなければ今日どおり**(限定4)。
 * **【`V8-M20` / `J-G27`】旧文は `audience` を名指ししていた。撤去された。**
 * **今日サーバが読むのは面の画面の規則(`judgeRoleAccess` の `target: "view"`)である。**
 *
 * **【`V14-M2-T01` の追記。上の説明を1バイトも消していない】** **戻りが `RecordRow`
 * そのものだったのは着手前までである。** **今日は `{ record, access? }` を返す** ——
 * **`access` は行1件ぶんの判定で、サーバが返したときだけキーを持つ**(`ADR-0402` 限定4)。
 * **口を2本立てなかった** —— **一覧と詳細で別々の述語を書かないため**(限定13)。
 *
 * ## **【`V14-M4-T01` の実地で見つかった欠陥。旧文を1バイトも消していない】**
 *
 * **旧の綴りは、サーバから受ける型を `{ record: RecordRow; access?: RowAccess }` と
 * 書いていた**(= 裸の判定オブジェクト)。**これは偽である。**
 *
 * **サーバが返すのは、行の `_id` を鍵にした**写像**である** —— **単票の口も一覧の口と
 * 1バイトも同じ形である**(`src/server/app.ts` の `recordRowAccessMap` /
 * `accessForPage` が両方に同じ形を作る)。**本物のサーバの実測:**
 *
 * ```
 * {"record":{...},"access":{"c6721f33-...":{"read":true,"write":true,"delete":true,"grant_write":true}}}
 * ```
 *
 * **なぜ取り違えたか** —— **`V14-M2-T01` は「行1件ぶんの判定」という**意味**を
 * そのまま型に書き、サーバの**形**を確かめなかった。** **同じファイルの一覧側
 * (`fetchRecordPage`)は着手前から正しく `Record<string, RowAccess>` と書いてあり、
 * 単票側だけが食い違っていた。** **土台(`web/test/row-grant-detail-buttons.test.tsx`)も
 * 裸の形で `fetch` を差し替えていたので、どの検査も赤くならなかった。**
 *
 * **帰結(本物のサーバとブラウザで3人ぶん実測)** —— **`access["write"]` も
 * `access["grant_write"]` も `undefined` になり、`rowAccessAllows` がすべて偽に倒れ、
 * **詳細画面の行ごとの判定が当たるボタンが、権限を持っている人からも全部消えていた。**
 * **一覧は正しく動いていた**(`ListViewRenderer` は写像を行の `_id` で引いている)。
 *
 * **直した場所はここ1箇所である** —— **`DetailViewRenderer` の `access` の使い方も
 * `rowAccessAllows` も1バイトも変えていない**(`ADR-0402` 越えてはならない線2:
 * 形 → 動詞の写像を2本目にしない)。**返り値の型も `RowAccess` のままである。**
 */
export async function fetchRecord(
  appId: string,
  tableId: string,
  recordId: string,
  viewId?: string,
): Promise<{ record: RecordRow; access?: RowAccess }> {
  const query = viewId === undefined ? "" : `?view=${encodeURIComponent(viewId)}`;
  // **サーバから受ける形は、一覧と1バイトも同じ「行の `_id` を鍵にした写像」である**
  // (`V14-M4-T01`)。**裸の `RowAccess` ではない。**
  const body = await getJson<{ record: RecordRow; access?: Record<string, RowAccess> }>(
    `${recordPath(appId, tableId, recordId)}${query}`,
    { appId },
  );
  // **鍵で引くだけである** —— **可否を1ミリも決めていない。** **鍵は URL に載せた
  // `recordId` そのものを使う**(サーバ側の鍵は行の `_id` であり、同じ値である)——
  // **射影(`projectForRoleFields`)が `_id` を落としうる `body.record._id` には
  // 寄りかからない。**
  const rowAccess = body.access === undefined ? undefined : body.access[recordId];
  return {
    record: body.record,
    // **`sum` / 一覧の `access` と1バイトも同じ形である** —— **サーバが返さなければ
    // キーごと持たない。** **【禁止】`{}` に倒さない。**
    //
    // **写像に**この行が載っていないとき**もキーごと持たない**(`V14-M4-T01`)——
    // **既定は「出す」に倒れる**(`rowAccessAllows` の doc / `ADR-0402` 限定4)。
    // **【禁止】「全部偽」に倒さない** —— **それは「この人は何もできない」という嘘になる。**
    ...(rowAccess === undefined ? {} : { access: rowAccess }),
  };
}

/** POST /api/apps/:app_id/tables/:table_id/records(成功は 201) */
export async function createRecord(
  appId: string,
  tableId: string,
  input: RecordInput,
): Promise<RecordRow> {
  const body = await sendJson<{ record: RecordRow }>(recordsPath(appId, tableId), "POST", input, {
    appId,
  });
  return body.record;
}

/**
 * **選んだ行をまとめて更新する**(`V4-M20-T03`。単位C の**将来送りの送り先**)。
 *
 * **`POST /api/apps/:app_id/batch` を叩くだけである** —— **サーバにも `src/kernel/` にも
 * 1バイトの差分も無い。** その口は `V2-M4-T01`(`ADR-0039`)が既に作っており、
 * **1つの IMMEDIATE トランザクションで全成功か全失敗**(部分適用ゼロ)、
 * **`if_match` を渡せば版一致更新(CAS)**である。
 *
 * **語彙を1つも増やしていない** —— マニフェストに書けるものは1バイトも変わらない。
 * **アプリはこの操作を宣言できない**(表示層の既定挙動である)。
 *
 * **書けるのは editor / owner だけである** —— サーバの `batchAuthMiddleware` が
 * viewer / customer / 未ログインを 403 で拒む。**表示層のガードは先回りにすぎない。**
 */
export async function writeRecordsBatch(
  appId: string,
  ops: {
    op: "update";
    table: string;
    target: string;
    values: RecordInput;
    if_match?: string;
  }[],
): Promise<RecordRow[]> {
  const body = await sendJson<{ records: RecordRow[] }>(
    `/api/apps/${encodeURIComponent(appId)}/batch`,
    "POST",
    { ops },
    { appId },
  );
  return body.records;
}

/** アップロード成功時に `POST /files` が返す `_files` の1行(ADR-0035 §1・T02)。 */
export type UploadedFile = {
  file_id: string;
  sha256: string;
  mime: string;
  size: number;
  filename: string | null;
};

/** ファイルのアップロードの URL(配信 URL の親)。 */
function filesPath(appId: string): string {
  return `/api/apps/${encodeURIComponent(appId)}/files`;
}

/**
 * image / file フィールドの配信 URL(V2-M2-T03 / V5-M16-T03)。
 *
 * 値 = `_files.file_id`。表示側(`display.tsx`)はこの URL を組み立てるだけで、file_id を
 * 直接読み手に見せない。**画面側で file_id を解釈しない**(URL を組むこと以上の解釈をしない)。
 *
 * **`image` は `<img src>` にそのまま使える。** **`file` は `<a href download>` に使う** ——
 * **実体が4種の画像と判定できない配信は必ずダウンロードで返る**ので、`<img>` に入れても
 * 何も表示されない。
 */
export function fileDeliveryUrl(appId: string, fileId: string): string {
  return `${filesPath(appId)}/${encodeURIComponent(fileId)}`;
}

/**
 * POST /api/apps/:app_id/files(multipart/form-data。成功は 201。V2-M2-T02 / ADR-0035 §1)
 *
 * image / file フィールドの入力(`input.tsx`)が選択ファイルを `name="file"` パートで送り、返った
 * `file_id` をフォーム値にする。**認証必須**(未認証は 401)・size 上限(413)はサーバが検査する
 * —— フロントで先回りして弾かず、失敗は統一形式(`ApiError`)で運ぶ。
 *
 * **`kind`(`V5-M16` / `ADR-0161`)**:
 * - `"image"`(既定): 4種の画像だけを受け取る(それ以外は 415)。上限 5 MiB。
 * - `"file"`: **受け入れる種類の制限は0件である**(`D-V5-84`)。上限 20,000,000 バイト。
 *   **415 は返らない。** ただし**配信は必ずダウンロードになる**(ブラウザ内で開かない)。
 * `sendJson` は JSON ボディ専用なので multipart はここで直に `fetch` する(`content-type` は
 * ブラウザが boundary 付きで自動設定するため**明示しない**)。
 */
export async function uploadFile(
  appId: string,
  file: File,
  kind: "image" | "file" = "image",
): Promise<UploadedFile> {
  const form = new FormData();
  form.append("file", file);
  // **`kind` は必ず明示して送る**(`V5-M16-T05`)。サーバの既定は `image` だが、
  // 既定に頼ると「どちらの入口を使うつもりか」が呼び出し側のコードから読めなくなる。
  form.append("kind", kind);
  const response = await fetch(filesPath(appId), {
    method: "POST",
    headers: { accept: "application/json" },
    body: form,
    credentials: "include",
  });
  if (!response.ok) {
    throw await toApiError(response, { appId });
  }
  return (await response.json()) as UploadedFile;
}

/**
 * PATCH /api/apps/:app_id/tables/:table_id/records/:record_id(成功は 200)
 *
 * 部分更新である(ADR-0003 §4 補足)。キーを省略すれば「変更しない」、明示的に
 * `null` を送れば「空にする」。全体置換の口はカーネルにもサーバにも無い。
 *
 * **楽観ロック(M9-T02)**: `expectedVersion`(更新前に読んだ対象レコードの
 * `_updated_at`)を `If-Match` ヘッダに載せて送る(サーバは必須。無いと 400)。
 * 版が一致すれば成功し、応答本体の新しい `_updated_at` を持つレコードを返す
 * (`ETag` にも同じ新版が載る)。別のユーザ/セッションが先に変更していれば 409
 * (`isWriteConflict`)、適用中なら 409(`isApplyInProgress`)。
 */
export async function updateRecord(
  appId: string,
  tableId: string,
  recordId: string,
  input: RecordInput,
  expectedVersion: string,
): Promise<RecordRow> {
  const body = await sendJson<{ record: RecordRow }>(
    recordPath(appId, tableId, recordId),
    "PATCH",
    input,
    { appId },
    { "if-match": expectedVersion },
  );
  return body.record;
}

/**
 * DELETE /api/apps/:app_id/tables/:table_id/records/:record_id(成功は 204・ボディ無し)
 *
 * **楽観ロック(M9-T02)**: `expectedVersion`(削除前に読んだ対象レコードの
 * `_updated_at`)を `If-Match` ヘッダに載せて送る(サーバは必須。無いと 400)。
 * 版不一致は 409(`isWriteConflict`)、適用中は 409(`isApplyInProgress`)。
 *
 * **件数の印(`V18-M7-T05` / `ADR-0444` §Decision 4)**: `childrenSeal` を渡すと
 * `If-Match-Children`(10進の整数)に載る。**省けば今日と1バイトも同じ要求で、子が0件の行はこの印
 * を1度も要らない。** **版の印(`If-Match`)の載せ方は1ビットも変えていない。** **断り(403 / 409)
 * は `readCascadeDeleteDenial` で見分けること。**
 */
export async function deleteRecord(
  appId: string,
  tableId: string,
  recordId: string,
  expectedVersion: string,
  childrenSeal?: number,
): Promise<void> {
  const response = await fetch(recordPath(appId, tableId, recordId), {
    method: "DELETE",
    headers: {
      accept: "application/json",
      "if-match": expectedVersion,
      ...(childrenSeal === undefined ? {} : { "if-match-children": String(childrenSeal) }),
    },
    credentials: "include",
  });
  if (!response.ok) {
    throw await toApiError(response, { appId });
  }
  // 204 はボディを持たない。ここで json() を呼ぶと必ず失敗する。
}

/**
 * POST /api/apps/:app_id/views/:view_id/actions/run
 * —— **画面のボタンから自動処理を名指しで起こす**(`V5-M25-T08` / `L-G8` /
 * `ADR-0176` 限定1)。
 *
 * **入口は HTTP に1本だけである。** **本文を1バイトも送らない**(`ADR-0174` 限定4:
 * 引数を1つも渡せない)—— **起こす自動処理と対象の行はクエリ文字列に載せる。**
 * **対象は押した行1行だけである**(限定3)。
 *
 * **応答**: **起動が受理されたか**を表す。**アクションの失敗の説明は `failures` に載る**
 * (空なら失敗0件)。**処理が重なったときは 409**(`isWriteConflict` が真になる)——
 * **【禁止】これを「二重押しが防げる」と読まない**(`ADR-0175` §限界2)。
 */
export async function runViewAction(
  appId: string,
  viewId: string,
  workflowId: string,
  recordId: string,
): Promise<{ workflow: string; record: string; failures: string[] }> {
  const path =
    `/api/apps/${encodeURIComponent(appId)}/views/${encodeURIComponent(viewId)}/actions/run` +
    `?workflow=${encodeURIComponent(workflowId)}&record=${encodeURIComponent(recordId)}`;
  const response = await fetch(path, {
    method: "POST",
    headers: { accept: "application/json" },
    credentials: "include",
  });
  if (!response.ok) {
    throw await toApiError(response, { appId });
  }
  return (await response.json()) as { workflow: string; record: string; failures: string[] };
}

// --- 認証 API(アプリ単位・ADR-0014 改訂 / per-app の JSON 契約) --------------------
//
// 認証はアプリ単位で、すべて `/api/apps/:app_id/auth/*` を叩く(app_id がパスに付く)。
// `credentials:"include"` で cookie(Path=/api/apps/:app_id スコープ)を往復させ、
// 401/403/409/400 は `ApiError`(errors 配列)で表現する。
// login/register/logout/me はセッション失効の共通ハンドラを発火させない(`skipUnauthorized`
// を付け、`appId` を渡さない)—— これらの 401 は「そのアプリでの認証失敗/未ログイン」であって
// 「保護 API のセッション切れ」ではないため、扱いは呼び出し側(LoginPage / useAppAuth)に委ねる。

/** `/api/apps/:app_id/auth/<suffix>` を組み立てる。 */
function authPath(appId: string, suffix: string): string {
  return `/api/apps/${encodeURIComponent(appId)}/auth/${suffix}`;
}

/** GET /api/apps/:app_id/auth/me — そのアプリで認証済みなら本人。未認証は 401(`ApiError`)。 */
export async function authMe(appId: string): Promise<AuthUser> {
  const body = await getJson<{ user: AuthUser }>(authPath(appId, "me"), { skipUnauthorized: true });
  return body.user;
}

/**
 * Passkey 新規登録の儀式(options → `startRegistration` → verify)。
 *
 * **`route` が管理経路(`"passkey"`)と顧客経路(`"signup/passkey"`)を分ける唯一の差**で
 * ある。**ロールは本文で送らない** —— サーバがパスに紐づくポリシー(`ADMIN_SIGNUP` /
 * `CUSTOMER_SIGNUP`)で決めるので、web が role を名乗る手段はここに1つも無い
 * (`src/server/auth-routes.ts`「ロールは経路(policy)が決める。本文からは受け取らない」)。
 */
async function runPasskeyRegisterCeremony(
  appId: string,
  username: string,
  route: "passkey" | "signup/passkey",
  signup?: SignupRequestFields,
): Promise<AuthUser> {
  // **【`V8-M5-T04`。台帳 `I-G8` / ユーザ決定 `D-V8-112`】旧の逐語(1バイトも消していない)**:
  // ```
  //   const options = await sendJson<PublicKeyCredentialCreationOptionsJSON>(
  //     authPath(appId, `${route}/register/options`),
  //     "POST",
  //     { username },
  //     { skipUnauthorized: true },
  //   );
  //   ...
  //   const body = await sendJson<{ user: AuthUser }>(
  //     authPath(appId, `${route}/register/verify`),
  //     "POST",
  //     { response },
  //     { skipUnauthorized: true },
  //   );
  // ```
  // **今日は名乗りと招待コードを**両方の段**に乗せる。**
  // **`options` の段が要る理由**: **サーバはこの段で「有効な招待を引けたときだけ
  // `409`(ログイン名重複)と `403`(env で閉じている)を飛ばす」逃がしを持っている** ——
  // **乗せないと、招待された人が passkey では1人も登録できない**(`D-V8-110`)。
  // **`verify` の段が要る理由**: **役割の確定と招待の消し込みはそこで起きる。**
  const fields = signupFields(signup);
  const options = await sendJson<PublicKeyCredentialCreationOptionsJSON>(
    authPath(appId, `${route}/register/options`),
    "POST",
    { username, ...fields },
    { skipUnauthorized: true },
  );
  const response = await runPasskeyRegistration(options);
  const body = await sendJson<{ user: AuthUser }>(
    authPath(appId, `${route}/register/verify`),
    "POST",
    { response, ...fields },
    { skipUnauthorized: true },
  );
  return body.user;
}

/**
 * **登録の本文に乗せる追加の2キー**(`V8-M5-T04`。台帳 `I-G8`。**ユーザ決定 `D-V8-112`**)。
 *
 * **着手前はどちらも1件も乗っていなかった**(実測: 着手前の
 * `LC_ALL=C /usr/bin/grep -c -e user_kind -e invitation_code web/src/api.ts` = **0**)。
 *
 * **`userKind` は「セルフ登録で名乗る立場」である。** **運営が人を足す口には渡さない** ——
 * **その口はサーバ側で名乗りを1度も読まず、値が不正なら `422` になる。**
 */
export type SignupRequestFields = { userKind?: string; invitationCode?: string };

/**
 * **空欄のキーを1つも送らない**(送ると、着手前の本文と1バイト違う要求になる)。
 * **キー名はサーバの受け口の綴りそのものである** —— **画面の側で別名を作らない。**
 */
function signupFields(input: SignupRequestFields | undefined): Record<string, string> {
  const fields: Record<string, string> = {};
  if (input?.userKind !== undefined && input.userKind !== "") {
    fields.user_kind = input.userKind;
  }
  if (input?.invitationCode !== undefined && input.invitationCode !== "") {
    fields.invitation_code = input.invitationCode;
  }
  return fields;
}

/**
 * Passkey 新規登録(そのアプリに・**管理経路**)。options → `startRegistration` の儀式 →
 * verify を内部で通す。初回ユーザは owner、以降は viewer になる。
 * 既存 username は 409、登録不可は 403、検証失敗は 400 の `ApiError`。
 */
export async function passkeyRegister(
  appId: string,
  username: string,
  /** **【`V8-M5-T04`】招待コードだけを渡す。** **この口は名乗りを1度も読まない。** */
  signup?: Pick<SignupRequestFields, "invitationCode">,
): Promise<AuthUser> {
  return runPasskeyRegisterCeremony(appId, username, "passkey", signup);
}

/**
 * Passkey での**顧客セルフサインアップ**(V3-M3-T03 / D-G12a・ユーザ決定 D-M3-2)。
 *
 * 叩き先は顧客経路(`auth/signup/passkey/register/*`)で、サーバは**常に customer** を
 * 付ける(`CUSTOMER_SIGNUP.resolveRole`)。管理経路と違い「初回ユーザは常に許可」の
 * ブートストラップ例外を持たないので、`ST_AUTH_ALLOW_REGISTRATION=false` の環境では
 * 1人目でも 403 になる(サーバの文面をそのまま画面に出す)。
 *
 * **【2026-08-14 訂正(`V8-M5-T05` の 3)。上の段落を1バイトも書き換えていない】**
 * **「サーバは常に customer を付ける」は今日は偽である** —— **`V8-M29`(`D-V8-78`)が
 * 本文の名乗り(`user_kind`)を読むようにし、`V8-M5-T04` がこの関数からそれを送る
 * ようにした。****付くのは名乗った役割であり、省略したときだけそのアプリの1本目
 * (宣言が無ければ `customer`)になる。**
 * **後半(env で閉じたサーバでは1人目でも 403)は今日も真である** —— **ただし
 * 有効な招待を添えたときだけは env を越えて通る**(`D-V8-110`)。
 */
export async function customerPasskeyRegister(
  appId: string,
  username: string,
  /** **【`V8-M5-T04`】名乗りと招待コードの両方を渡す。** */
  signup?: SignupRequestFields,
): Promise<AuthUser> {
  return runPasskeyRegisterCeremony(appId, username, "signup/passkey", signup);
}

/**
 * Passkey ログイン(そのアプリに)。username を渡せば allowCredentials を絞り、省略すれば
 * discoverable credential でのログインになる。検証失敗は 401 の `ApiError`。
 */
export async function passkeyLogin(appId: string, username?: string): Promise<AuthUser> {
  const options = await sendJson<PublicKeyCredentialRequestOptionsJSON>(
    authPath(appId, "passkey/login/options"),
    "POST",
    username === undefined || username === "" ? {} : { username },
    { skipUnauthorized: true },
  );
  const response = await runPasskeyLogin(options);
  const body = await sendJson<{ user: AuthUser }>(
    authPath(appId, "passkey/login/verify"),
    "POST",
    { response },
    { skipUnauthorized: true },
  );
  return body.user;
}

/**
 * password 新規登録(そのアプリに・**管理経路**)。初回ユーザは owner、以降は viewer。
 * 既存 username は 409、登録不可は 403、欠落は 400 の `ApiError`。
 */
export async function passwordRegister(
  appId: string,
  username: string,
  password: string,
  /** **【`V8-M5-T04`】招待コードだけを渡す。** **この口は名乗りを1度も読まない。** */
  signup?: Pick<SignupRequestFields, "invitationCode">,
): Promise<AuthUser> {
  return registerWithPassword(appId, username, password, "password/register", signup);
}

/**
 * password での**顧客セルフサインアップ**(V3-M3-T03 / D-G12a・ユーザ決定 D-M3-2)。
 *
 * 叩き先は `POST /api/apps/:app_id/auth/signup/password/register` で、サーバは**常に
 * customer** を付ける(`CUSTOMER_SIGNUP.resolveRole`)。**初回でも owner にならない**
 * (`healOwner: false`。ADR-0033 §1b)。
 *
 * **【2026-08-14 訂正(`V8-M5-T05` の 3)。上の段落を1バイトも書き換えていない】**
 * **2文とも今日は偽である。** **(a) 付くのは名乗った役割である**(`D-V8-78`)。
 * **(b) 最初の1人は自分で登録した場合も必ず持ち主になる**(`V8-M30` 第2波 /
 * **ユーザ決定 `D-V8-82`**)—— **「初回でも owner にならない」は今日成り立たない。**
 */
export async function customerPasswordRegister(
  appId: string,
  username: string,
  password: string,
  /** **【`V8-M5-T04`】名乗りと招待コードの両方を渡す。** */
  signup?: SignupRequestFields,
): Promise<AuthUser> {
  return registerWithPassword(appId, username, password, "signup/password/register", signup);
}

/** password 登録の共通実装。**経路(suffix)だけがロールを決める。**本文に role は入らない。 */
async function registerWithPassword(
  appId: string,
  username: string,
  password: string,
  suffix: "password/register" | "signup/password/register",
  signup?: SignupRequestFields,
): Promise<AuthUser> {
  // **【`V8-M5-T04`】旧の逐語(1バイトも消していない)**:
  // ```
  //     { username, password },
  // ```
  // **空欄のキーは1つも乗らないので、招待を使わない登録の本文は着手前と1バイト違わない。**
  const body = await sendJson<{ user: AuthUser }>(
    authPath(appId, suffix),
    "POST",
    { username, password, ...signupFields(signup) },
    { skipUnauthorized: true },
  );
  return body.user;
}

/** password ログイン(そのアプリに)。不一致は 401 の `ApiError`。 */
export async function passwordLogin(
  appId: string,
  username: string,
  password: string,
): Promise<AuthUser> {
  const body = await sendJson<{ user: AuthUser }>(
    authPath(appId, "password/login"),
    "POST",
    { username, password },
    { skipUnauthorized: true },
  );
  return body.user;
}

/** ログアウト(そのアプリから・冪等)。cookie はサーバが削除する。 */
export async function logout(appId: string): Promise<void> {
  await sendJson<{ ok: true }>(authPath(appId, "logout"), "POST", {}, { skipUnauthorized: true });
}

// --- 本人の資格情報のやり直しと退会(E-G68 / V4-M6)-------------------------------------
//
// **どちらも「本人」にしか効かない**(サーバはロールを1つも見ない)。**忘れたときの再設定は
// 無い** —— メールを送る経路がこの製品に1本も無いので、本人確認の手段が作れない。

/**
 * `POST /api/apps/:app_id/auth/password/change` —— 本人のパスワードを差し替える。
 *
 * **現在のパスワードが違えば 401、Passkey だけのアカウントは 409、本文の形が違えば 400**
 * (いずれも `ApiError` の `status` で呼び出し側が判別する)。**成功するとサーバが
 * 「それまでのセッションを全部切り、新しい session cookie を配り直す」**ので、
 * 画面はログインし直さなくてよい。
 */
export async function changePassword(
  appId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  await sendJson<{ ok: true }>(
    authPath(appId, "password/change"),
    "POST",
    { current_password: currentPassword, new_password: newPassword },
    // 401 は「セッション失効」ではなく「今のパスワードが違う」なので、共通ハンドラで
    // ログイン画面へ落とさない(サーバの文面をそのまま画面に出す)。
    { skipUnauthorized: true },
  );
}

/**
 * `DELETE /api/apps/:app_id/auth/me` —— 退会(本人のアカウントを消す)。
 *
 * **最後の owner は 409 で消せない。** **業務データ(その人が作った行)は1行も消えない** ——
 * 消えるのはアカウントと資格情報とセッションだけである。
 */
export async function deleteOwnAccount(appId: string): Promise<void> {
  await getJsonDelete(authPath(appId, "me"), { skipUnauthorized: true });
}

// --- ユーザ/ロール管理(owner 限定・V1-M3-T02 / ADR-0015)-----------------------------
//
// これらは owner だけが叩ける管理 API(サーバがハンドラ内で owner を検査する)。
// 401(セッション失効)は records と同じく `appId` を渡して共通ハンドラに翻訳させ、
// ログイン画面へ落とす。403(非 owner)/ 404(未知ユーザ)/ 409(最後の owner)/
// 400(不正 role)は `ApiError` の `status` で呼び出し側が判別する(`isForbidden` /
// `isLastOwnerConflict`)。

/**
 * **一覧の応答が載せる招待の1件**(`V19-M3-T01` / 台帳 `SV-G2`)。
 *
 * **サーバの `invitationView`(`src/server/auth-routes.ts`)が返す**7つのキーちょうど**である。**
 * **コードを1バイトも持たない** —— **載せるのは発行の応答だけである。**
 * **【禁止の履行】`IssuedInvitation`(コードを持つ型)を一覧の受け皿に流用していない。**
 *
 * **`state` の3値を導出するのはサーバの1関数だけである**(`src/auth/invitations.ts` の
 * `invitationState`)—— **画面はこの値を読むだけで、`usedAt` から組み立て直さない。**
 */
export type AppInvitation = {
  username: string;
  role: Role;
  expiresAt: string;
  issuedBy: string;
  issuedAt: string;
  usedAt: string | null;
  /** 未使用 / 使用済み / 取り消し済み。 */
  state: "unused" | "used" | "revoked";
};

/**
 * **`GET /auth/users` の応答**(`V19-M3-T01`)。
 *
 * **`invitations` はキーごと落ちうる** —— **サーバは `owner` を実効ロールに持つ人にだけ
 * 載せる**(`auth-routes.ts` の `canReadInvitations`)。
 * **落ちたときに空配列へ均さない** —— **「1件も無い」と「読ませてもらえない」は別の状態で
 * あり、混ぜると画面が嘘をつく。**
 */
export type AppUserList = {
  users: AppUser[];
  /**
   * **`| undefined` を明示的に書いている** —— このリポジトリは
   * `exactOptionalPropertyTypes` を有効にしているので、これが無いと
   * 「キーが落ちた応答をそのまま渡す」ことが型で書けない。
   */
  invitations?: readonly AppInvitation[] | undefined;
};

/**
 * GET /api/apps/:app_id/auth/users — ユーザ + ロール + **招待**の一覧(owner のみ)。
 *
 * **【`V19-M3-T01` で受け取る形を広げた】** **旧(逐語)**:
 *
 *     export async function listAppUsers(appId: string): Promise<AppUser[]> {
 *       const body = await getJson<{ users: AppUser[] }>(authPath(appId, "users"), { appId });
 *       return body.users;
 *     }
 *
 * **サーバは着手前から招待を載せていた** —— **捨てていたのはこの関数である。**
 * **サーバ側を1バイトも直していない。**
 */
export async function listAppUsers(appId: string): Promise<AppUserList> {
  const body = await getJson<AppUserList>(authPath(appId, "users"), { appId });
  return { users: body.users, invitations: body.invitations };
}

/**
 * **発行した招待の表現**(`V19-M3-T00` / 台帳 `SV-G1`)。
 *
 * **サーバがコードを載せるのは発行の応答の1箇所だけである**(`issuedInvitationView`)——
 * **一覧の応答はコードを1バイトも持たない。** **【禁止】この型を一覧の受け皿に流用しない。**
 */
export type IssuedInvitation = {
  username: string;
  role: Role;
  expiresAt: string;
  issuedBy: string;
  issuedAt: string;
  usedAt: string | null;
  /** 未使用 / 使用済み / 取り消し済み(導出するのはサーバの1関数だけである)。 */
  state: "unused" | "used" | "revoked";
  /** **発行の応答だけが載せる。** */
  code: string;
};

/**
 * 発行の応答。
 *
 * **登録リンクは、サーバが期待 origin から組み立てられたときだけ載る** ——
 * 組み立てられなければキーごと落ちる(**黙って壊れたリンクを返さない**)。
 */
export type IssuedInvitationResult = {
  invitation: IssuedInvitation;
  signupUrl?: string;
};

/**
 * POST /api/apps/:app_id/auth/invitations — 招待を1件発行する(owner のみ)。
 *
 * **この口は着手前から在る。足したのは画面から呼ぶ経路だけである**(`SV-G1` の個別限定①)。
 *
 * **送れるキーは `username` / `role` / `revoke` の3つだけで、有効期限は24時間で固定である**
 * —— **未知のキーはサーバが 400 で拒む。** **本関数は期限のキーを1つも組み立てない**
 * (「期限を指定したつもりの招待」を黙って作らないため)。
 */
export async function issueInvitation(
  appId: string,
  username: string,
  role: Role,
): Promise<IssuedInvitationResult> {
  return await sendJson<IssuedInvitationResult>(
    authPath(appId, "invitations"),
    "POST",
    { username, role },
    { appId },
  );
}

/**
 * POST /api/apps/:app_id/auth/invitations — **その相手の招待を取り消す**(owner のみ)。
 * (`V19-M3-T02` / 台帳 `SV-G4`)
 *
 * **叩く口は {@link issueInvitation} と同じ1本である**(個別限定・取り消し①)——
 * **`DELETE` のルートを1本も足していない。** **取り消しは `revoke: true` という引数で表す。**
 * **サーバは行を1行も消さない**(同 ②)—— **消えるのではなく `used_at` に
 * `revoked:` + ISO8601 が入り、一覧には「取り消し済み」として出続ける**(`ADR-0336` 限定16)。
 *
 * **応答本文は読み捨てる** —— **サーバは取り消しの応答にコードを1バイトも載せない。**
 * **【禁止の履行】ここで {@link IssuedInvitationResult} を受け取る形にしない** ——
 * **受け取る形にすると「取り消したのにコードが返る」という読み方を画面に持ち込む。**
 *
 * ## 【正直に書く】この関数が防いでいないこと
 *
 * - **既に使用済み / 取り消し済みの招待に撃つと、サーバは `200` を返すのに何も書かない**
 *   (`H-V19-5`)。 **この関数はそれを見分けられない。** **画面の側が、未使用の行にだけ
 *   このボタンを出すことで踏まないようにしている**(`UserAdmin.tsx` の `InvitationActions`)。
 *   **サーバ側の穴は1バイトも塞がっていない。**
 */
export async function revokeInvitation(appId: string, username: string): Promise<void> {
  await sendJson<unknown>(
    authPath(appId, "invitations"),
    "POST",
    { username, revoke: true },
    { appId },
  );
}

/**
 * PATCH /api/apps/:app_id/auth/users/:user_id — ロール変更(owner のみ)。
 * 最後の owner の降格は 409、不正 role は 400、未知ユーザは 404(いずれも `ApiError`)。
 */
export async function setAppUserRole(appId: string, userId: string, role: Role): Promise<AppUser> {
  const body = await sendJson<{ user: AppUser }>(
    `${authPath(appId, "users")}/${encodeURIComponent(userId)}`,
    "PATCH",
    { role },
    { appId },
  );
  return body.user;
}

// --- 接続(capability)の発行・管理(owner 限定・V1-M4-T04 / ADR-0020)-------------------
//
// AI は MCP の `request_connection` で「申請」まで(connection は作れない)。owner だけが
// `POST /connections` で発行できる —— この HTTP 経路が唯一の発行 seam。すべて owner のみで、
// 401(セッション失効)は `appId` を渡して共通ハンドラに翻訳させ、403(非 owner)/ 400(不正
// 入力)/ 409(同名重複)は `ApiError` の `status` と文面で呼び出し側が扱う(`isForbidden`)。
//
// **secretSource は「取得元の参照」(環境変数名 or 取得コマンド)であって secret 値ではない**。
// サーバは解決値を保管も返却もしないので、フロントにも値は一切現れない(取得元の参照だけ)。

/** capability の base path(`/api/apps/:app_id/connections`)。 */
function connectionsPath(appId: string): string {
  return `/api/apps/${encodeURIComponent(appId)}/connections`;
}

/**
 * AI が出した接続の申請(pending のみ)。owner が承認画面で見る形
 * (サーバの `GET /connections/requests` が `{ requests }` で返す)。
 */
export type ConnectionRequest = {
  id: string;
  appId: string;
  requestedName: string;
  purpose: string;
  suggestedHosts: string[];
  status: string;
  createdAt: string;
};

/**
 * 発行済み接続の1件(サーバの `connectionView` が返す形)。**`secretSource` は取得元の参照**
 * (env 名 / 取得コマンド)であって secret 値ではない。
 */
export type ConnectionSummary = {
  id: string;
  name: string;
  allowedHosts: string[];
  secretSource: { kind: "env" | "command"; value: string };
  createdAt: string;
};

/** GET /api/apps/:app_id/connections/requests — 未承認の申請一覧(owner のみ)。 */
export async function listConnectionRequests(appId: string): Promise<ConnectionRequest[]> {
  const body = await getJson<{ requests: ConnectionRequest[] }>(
    `${connectionsPath(appId)}/requests`,
    {
      appId,
    },
  );
  return body.requests;
}

/** GET /api/apps/:app_id/connections — 発行済み接続の一覧(owner のみ)。 */
export async function listConnections(appId: string): Promise<ConnectionSummary[]> {
  const body = await getJson<{ connections: ConnectionSummary[] }>(connectionsPath(appId), {
    appId,
  });
  return body.connections;
}

/**
 * POST /api/apps/:app_id/connections — 接続を発行する(owner のみ)。
 * 不正入力は 400、同名重複は 409(いずれも `ApiError`)。`requestId` を渡すとその申請を締める。
 */
export async function createConnection(
  appId: string,
  input: {
    name: string;
    allowedHosts: string[];
    secretSource: { kind: "env" | "command"; value: string };
    requestId?: string;
  },
): Promise<ConnectionSummary> {
  const body = await sendJson<{ connection: ConnectionSummary }>(
    connectionsPath(appId),
    "POST",
    input,
    { appId },
  );
  return body.connection;
}

/** DELETE /api/apps/:app_id/connections/:connection_id — 接続を失効する(owner のみ・冪等)。 */
export async function revokeConnection(appId: string, connectionId: string): Promise<void> {
  await getJsonDelete(`${connectionsPath(appId)}/${encodeURIComponent(connectionId)}`, { appId });
}

/** DELETE で `{ ok: true }` を返す口(records の 204 とは違い本体を持つ)。 */
async function getJsonDelete(path: string, extras: RequestExtras = {}): Promise<void> {
  const response = await fetch(path, {
    method: "DELETE",
    headers: { accept: "application/json" },
    credentials: "include",
  });
  if (!response.ok) {
    throw await toApiError(response, extras);
  }
  // 本体(`{ ok: true }`)は読み捨てる。呼び出し側は成功/失敗しか要らない。
}

// --- 要件定義書(V1-M8-T02 / ADR-0025 §10)---------------------------------------------

/**
 * `GET /api/apps/:app_id/requirements?format=json` の応答。
 *
 * **`statements` と `markdown` は同じ生成物の2つの表現である。**画面は前者を節ごとに
 * 構造描画し、後者はコピー用にそのまま持つ(**markdown をパースしない**。ADR-0025 限定9)。
 */
export type RequirementsDocResponse = {
  app_id: string;
  format: "json";
  /** 絞り込んだ節(絞っていなければ `null`)。 */
  section: RequirementSection | null;
  statements: RequirementStatement[];
  markdown: string;
  identifiers: RequirementIdentifiers;
};

/**
 * GET /api/apps/:app_id/requirements
 *
 * **毎回サーバから取得する。** 生成物は保存されず(ADR-0025 限定12)、呼ぶたびに
 * その時点のマニフェストと変更履歴から作り直される。`fetchManifest` と同じく
 * **非保護 API** なので、401 の失効ハンドラには繋がない(認可は changelog と同列。§10-1)。
 *
 * **【`V17-M4-T02` による訂正。上の3行は1バイトも消していない】** **台帳 `AC-G20`** ——
 * **この口はもう非保護ではない。** **`GET /manifest` と同じ関門が掛かり、未ログインは
 * 401 である**(認可が changelog と同列であることだけは今日も真で、その changelog も
 * 一緒にログインが要るようになった)。
 *
 * **したがって `appId` を渡す** —— **渡さないと、セッションが切れた人が要件定義書を開いた
 * ときに画面で何も起きない**(`toApiError` は `extras.appId !== undefined` のときだけ
 * 失効ハンドラを撃つ)。 **旧の逐語(1バイトも消していない)**:
 *   ``  \`/api/apps/${encodeURIComponent(appId)}/requirements?${query.toString()}\`,``
 *
 * **【`fetchManifest` は本段では触っていない】** —— **同関数は今日も `appId` を渡さない。**
 * **`GET /manifest` は `V8-M21` から 401 を返すので、そこにも同じ穴が在る** ——
 * **本段が作った穴ではないので直していない**(記録の穴の一覧に書いた)。
 */
export async function fetchRequirementsDoc(
  appId: string,
  section?: RequirementSection,
): Promise<RequirementsDocResponse> {
  const query = new URLSearchParams({ format: "json" });
  if (section !== undefined) {
    query.set("section", section);
  }
  const body = await getJson<{ requirements: RequirementsDocResponse }>(
    `/api/apps/${encodeURIComponent(appId)}/requirements?${query.toString()}`,
    { appId },
  );
  return body.requirements;
}

// --- テーマの差分(V3-M4-T01 / D-G7)------------------------------------------------

/**
 * web が送れる差分の形。**`set_theme` 1操作に閉じている。**
 *
 * **これはこのファイルで最初の「マニフェストを書き換える」経路である**(V3-M4-T00 の実測:
 * 着手前、`web/src/api.ts` にマニフェスト差分を送る関数は0件だった)。開ける以上は
 * **開ける幅を型で決めておく** —— 任意の差分を送れる汎用関数は置かない。**サーバ側は
 * 何でも受ける**(`POST /api/apps/:app_id/diffs` は形の検証をカーネルに委ねている)ので、
 * **この型が縛るのは web だけである。**
 */
export type ThemeDiff = {
  diff_id: string;
  intent: string;
  operations: readonly [SetThemeOperation];
};

/** 適用が成功したときに分かること(採番された差分ID)。 */
export type AppliedThemeDiff = {
  diffId: string;
};

/**
 * POST /api/apps/:app_id/diffs —— テーマの差し替えを1件適用する。
 *
 * **専用のエンドポイントを作っていない。** 送るのは既存の `apply_diff` 経路が受ける普通の
 * 差分であり、`dry_run` / `_changelog` / `undo` / `redo` / スナップショットはそのまま効く
 * (実測は `web/test/theme-candidates.test.ts`)。
 *
 * **このエンドポイントは認証を要求しない**(`src/server/app.ts` の「変更系」節が自ら
 * 「認証は無いままなので、127.0.0.1 バインドが唯一の防御である」と書いている)。**v0 からの
 * 状態であり、本関数がそれを作ったのではない。そして本関数はそれを直してもいない** ——
 * 呼び出し側(`ThemePreviewPanel`)を owner 限定の画面に置いてあるが、**UI が押させない
 * ことはサーバ側の遮断の代わりにならない。**
 *
 * `fetchManifest` / `fetchRequirementsDoc` と同じ非保護 API なので、401 の失効ハンドラには
 * 繋がない(`appId` を `RequestExtras` に載せない)。
 *
 * **【V4-FIX1 項目(5) による改訂。上の2段落は制定時の記述であり1バイトも書き換えていない】**
 * **この経路は今日、認証を要求する**(未認証 401 / owner 以外 403)。**ユーザ決定
 * 「書き換えの口は塞ぐ …(必須)」の履行である。** **画面はもともと owner 限定なので
 * 通常の操作では 401 も 403 も起きないが、`fetchManifest` と同列の「非保護 API」ではなくなった。**
 *
 * **【塞げていない・直していないもの。誇張しない】** **401 の失効ハンドラには今日も繋いでいない**
 * —— セッションが切れた状態でテーマを適用すると、ログイン画面へ落ちずにパネル内のエラー文が出る。
 * **繋ぐと `RequestExtras` の扱いが変わるので、本タスクの射程外として記録に残す。**
 */
export async function applyThemeDiff(appId: string, diff: ThemeDiff): Promise<AppliedThemeDiff> {
  const body = await sendJson<{ change: { entry: { diff_id: string } } }>(
    `/api/apps/${encodeURIComponent(appId)}/diffs`,
    "POST",
    diff,
  );
  return { diffId: body.change.entry.diff_id };
}

// --- 逃げ道(任意 CSS)の資産の発行・失効(owner 限定・V3-M5-T03 / ADR-0055 限定5・7)---------
//
// **形は上の接続(capability)の節と同型である。**AI は MCP の `request_custom_css` で
// 「申請」まで(資産は作れない)。owner だけが `POST /escape-hatch-assets` で発行できる ——
// **この HTTP 経路が CSS のバイト列を置ける唯一の seam である**(ADR-0055 限定5)。
//
// **ここに足した4本は、どれも「UI 側の担保」ではない。**owner 限定を守っているのは
// サーバの `requireOwner`(`src/server/auth-routes.ts`)であって、この4本を呼ばないことでも、
// 導線を出さないことでもない。**UI を迂回して同じ URL を直接叩いても 403 になる**
// (実測は `web/e2e/escape-hatch.e2e.ts` と `src/server/escape-hatch-issuance.test.ts`)。
//
// **配信(`GET /views/:view_id/custom.css`)はここに無い。** V3-M5-T02 が
// `web/src/views/ViewHost.tsx` の中に直に書いており、**本タスクは移していない**
// (移すと2箇所に住むか、T02 のファイルを触ることになる。判断の記録は
// `docs/plan/v3/records/v3-m5-t03.md` の完了条件6)。

/** 逃げ道の資産の base path(`/api/apps/:app_id/escape-hatch-assets`)。 */
function escapeHatchAssetsPath(appId: string): string {
  return `/api/apps/${encodeURIComponent(appId)}/escape-hatch-assets`;
}

/**
 * AI が出した逃げ道の申請(pending のみ)。owner が承認画面で見る形
 * (サーバの `GET /escape-hatch-assets/requests` が `{ requests }` で返す)。
 *
 * **CSS のバイト列を1バイトも含まない** —— 本文を書くのは owner である(ADR-0055 限定5)。
 * `suggestedScopeViews` は AI の**提案**であって宣言ではない(宣言するのは owner)。
 */
export type EscapeHatchAssetRequest = {
  id: string;
  appId: string;
  requestedName: string;
  purpose: string;
  suggestedScopeViews: string[];
  status: string;
  createdAt: string;
};

/**
 * 発行済みの逃げ道の資産1件(サーバの `escapeHatchAssetView` が返す形)。
 *
 * **CSS の本文は含まれない** —— 一覧が返すのは参照(資産名 + 内容ダイジェスト)と
 * 作用域だけである。本文を読むのは配信層(`GET /views/:view_id/custom.css`)だけ。
 */
export type EscapeHatchAssetSummary = {
  id: string;
  name: string;
  digest: string;
  scopeViews: string[];
  createdAt: string;
};

/** GET /api/apps/:app_id/escape-hatch-assets/requests — 未承認の申請一覧(owner のみ)。 */
export async function listEscapeHatchAssetRequests(
  appId: string,
): Promise<EscapeHatchAssetRequest[]> {
  const body = await getJson<{ requests: EscapeHatchAssetRequest[] }>(
    `${escapeHatchAssetsPath(appId)}/requests`,
    { appId },
  );
  return body.requests;
}

/** GET /api/apps/:app_id/escape-hatch-assets — 発行済み資産の一覧(owner のみ)。 */
export async function listEscapeHatchAssets(appId: string): Promise<EscapeHatchAssetSummary[]> {
  const body = await getJson<{ assets: EscapeHatchAssetSummary[] }>(escapeHatchAssetsPath(appId), {
    appId,
  });
  return body.assets;
}

/**
 * POST /api/apps/:app_id/escape-hatch-assets — 逃げ道の資産を発行する(owner のみ)。
 *
 * **`scopeViews` は必須である**(ADR-0055 限定7: 宣言を持たない発行を受理しない /
 * ワイルドカード全許可を既定にしない)。型の上で任意にしないのは、**省略を「全画面許可」と
 * 読む余地を web 側にも作らない**ためである。不正入力は 400、同名・同内容は 409。
 * `requestId` を渡すとその申請を `approved` にして締める。
 */
export async function issueEscapeHatchAsset(
  appId: string,
  input: { name: string; css: string; scopeViews: string[]; requestId?: string },
): Promise<EscapeHatchAssetSummary> {
  const body = await sendJson<{ asset: EscapeHatchAssetSummary }>(
    escapeHatchAssetsPath(appId),
    "POST",
    input,
    { appId },
  );
  return body.asset;
}

/**
 * DELETE /api/apps/:app_id/escape-hatch-assets/:asset_id — 資産を失効する(owner のみ・冪等)。
 *
 * **消えるのは登録だけで、本体(CSS のバイト列)は消えない**(ADR-0055 限定10 が孤児の
 * 自動刈り取りを禁じている)。**失効させた資産は undo で呼び戻せない** —— 参照は戻るが
 * 実体の登録は戻らず、配信層が fail-closed かつ loud に断る(同 §限界3)。
 */
export async function revokeEscapeHatchAsset(appId: string, assetId: string): Promise<void> {
  await getJsonDelete(`${escapeHatchAssetsPath(appId)}/${encodeURIComponent(assetId)}`, { appId });
}

// --- コメント(アプリを使う人が画面へ書く)。V10-M11-T01 / 台帳 `CM-G4` ---------------------
//
// **門 = 門外(`Δ7`)/ 判定値 = 限定採用。** **足した口は書込1本だけである** ——
// **コメントを**読む**口は HTTP に今日1本も無い**(足すのは `V10-M15-T05` / `CM-G21`)。
// **したがってこのファイルにも `GET …/comments` は1本も無い。**
//
// --- **【`V10-M32-T01`(2026-08-26)。上の3行を1バイトも消していない】訂正** ---
//
// **上の「読む口は HTTP に今日1本も無い」は、2026-08-24 の `V10-M15-T05` が偽にした** ——
// **`GET /api/apps/:app_id/comments` が `src/server/auth-routes.ts` に在る。**
// **「したがってこのファイルにも `GET …/comments` は1本も無い」は、本工程が偽にする** ——
// **下の {@link listComments} がその1本目である。** **2本目は作らない**(パスの組み立ては
// 既存の {@link commentsPath} 1本のまま)。

/** コメントのコレクション URL。 */
function commentsPath(appId: string): string {
  return `/api/apps/${encodeURIComponent(appId)}/comments`;
}

/**
 * **積まれたコメント1件**。**`src/kernel/comment-store.ts` の `Comment` の写しである** ——
 * **キーの綴りも並びも1つも変えていない**(サーバの口も同じ写しを返す。整形は1箇所も無い)。
 *
 * **`anchorForm` を型で絞っていない** —— **絞ると、器が実行時に拒否することを web 側が
 * 先回りして判定する形になる**(`CM-G4` 限定5 =「判定も整形もこの口に書かない」の向き)。
 *
 * ## 【`V10-M32-T01`(2026-08-26)】**6キーから10キーへ広げた**
 *
 * **上の doc を1バイトも消していない。** **`anchorForm` を型で絞らない判断も1ミリも
 * 変えていない**(下でも `string` のままである)。
 *
 * **旧の定義(逐語。制定時の6キー)**:
 *
 * ```ts
 * export type CommentSummary = {
 *   id: string;
 *   appId: string;
 *   anchorForm: string;
 *   anchorParts: string[];
 *   body: string;
 *   createdAt: string;
 * };
 * ```
 *
 * **広げた理由**: **読む口({@link listComments})が返すのは器の `Comment` そのもので
 * あり、6キーのままだと `writer` / `state` / `reason` / `diffId` の4つが型の上で
 * 消える** —— **口は落としていないのに web 側だけが見えなくなる、という嘘になる。**
 * **写しは1本のままにする** —— **新しい型を隣に作らない**(同じファイルに `Comment` の
 * 写しが2本並ぶと、どちらが正かを読む人が決められなくなる)。
 *
 * **`state` だけは union(`CommentState`)で受けている** —— **器の3値が動いたら
 * `bunx tsc --noEmit` が落ちる。** **`anchorForm` と扱いが違うのは、`state` は器が
 * 生成して返す側の値であって、web が組み立てて送る値ではないからである**(先回りの
 * 判定にならない)。
 */
export type CommentSummary = {
  id: string;
  appId: string;
  anchorForm: string;
  anchorParts: string[];
  body: string;
  createdAt: string;
  /** 書き手。**未認証で書かれた行は `null`。** 器はこの値を1度も検査しない。 */
  writer: string | null;
  /** 状態。器の3値ちょうど(`open` / `not_applicable` / `applied`)。 */
  state: CommentState;
  /** 理由。**「対応できない」のときだけ非 `null`。** */
  reason: string | null;
  /** 繋がっている差分の識別子。**器はこの値が実在するかを1ミリも確かめない。** */
  diffId: string | null;
};

/**
 * POST /api/apps/:app_id/comments — **画面へのコメントを1件書く**(`V10-M11-T01`)。
 *
 * **ログイン済みであることだけを要求する口である**(役割の規則を1つも見ない。`D-V10-5`)。
 * **未ログインは今日 401** —— 開けるのは `V10-M11-T03`(`CM-G6`)である。
 *
 * **宛先の形が登録簿に在るか・部品の数が形と合うか・本文が空でないかは、すべて器が見る。**
 * **ここでは1つも検査しない** —— **器が投げた理由をそのまま `ApiError` として上げる。**
 */
export async function createComment(
  appId: string,
  input: { anchorForm: string; anchorParts: string[]; body: string },
): Promise<CommentSummary> {
  const body = await sendJson<{ comment: CommentSummary }>(commentsPath(appId), "POST", input, {
    appId,
  });
  return body.comment;
}

/**
 * GET /api/apps/:app_id/comments — **この人に見えるコメントの一覧**(`V10-M32-T01`)。
 *
 * **口そのものは `V10-M15-T05`(`CM-G21` / `ADR-0370`)が 2026-08-24 に足したものであり、
 * 本工程はそこへ web から繋いだだけである。** **サーバ側を1バイトも触っていない。**
 *
 * ## この関数が持たないもの
 *
 * - **絞り込みを1つも持たない。** **誰にどれが見えるかを決めるのは
 *   `src/server/comment-visibility.ts` の可視集合1本だけである** ——
 *   **ここで役割も書き手も状態も1度も見ない**(`CM-G5` 限定1 と同じ規律)。
 * - **並べ替えを1つも持たない。** **器が返した配列を、返ってきた順のまま上へ渡す。**
 * - **2本目のパス組み立てを作らない** —— **URL は既存の {@link commentsPath} 1本である。**
 * - **`state` クエリを渡す口を持たない** —— **口は任意で受けるが、本工程は3値すべてを
 *   読む。** 渡す口を足すと「画面が絞る」ことになり、上の1点目と食い違う。
 *
 * ## `total` を捨てている(**わざとである**)
 *
 * **応答の `total` は「絞ったあと(可視集合)の長さ」であり、返る配列の長さと必ず一致する。**
 * **したがって受け取っても数え方が2本になるだけなので、配列だけを返す。** **画面が件数を
 * 出すときは配列の長さから数える** —— **母集団の件数はこの口からは分からない**(それは
 * 口の側が返していないからであって、ここで落としているのではない)。
 */
export async function listComments(appId: string): Promise<CommentSummary[]> {
  // **【`V10-M32-T04`(2026-08-26)。独立点検の指摘1】旧の本体(逐語。1バイトも消していない)**:
  //   `const body = await getJson<{ comments: CommentSummary[]; total: number }>(commentsPath(appId), {`
  //   `  appId,`
  //   `});`
  //   `return body.comments;`
  // **旧は実行時に形を1度も見ていなかった** —— **`getJson` の型引数は「そう来るはず」と
  // 書いてあるだけで検査ではないので、本文に `comments` が載っていない 200 が返ると
  // `undefined` がそのまま上へ抜け、描く側が例外で落ちて画面が丸ごと消えた**
  // (点検が複製の上で実測している)。**受け皿を広げ、配列でなければ下で倒す。**
  const body = await getJson<{ comments?: unknown; total?: unknown }>(commentsPath(appId), {
    appId,
  });
  if (!Array.isArray(body.comments)) {
    // **既存の失敗の道(`ApiError`)へそのまま倒す** —— **2本目のエラー表現を作らない。**
    // **`toValidationErrors` が `ApiError` をそのまま解くので、画面には他の失敗と同じ
    // `ErrorList` が1つ出る。**
    // **文面は「壊れている」と分かる形にする** —— **「まだ1件も無い」と混ぜない**(憲法6)。
    throw new ApiError(200, [
      {
        path: "/comments",
        message:
          "コメントの応答が壊れています。200 が返りましたが、本文に comments の配列が1本もありません。",
        hint: "「まだコメントが1件も無い」状態とは別です(その場合は空の配列が返ります)。サーバの応答そのものが想定の形になっていません。",
      },
    ]);
  }
  // **中身1件1件の形は今日も1つも見ていない** —— **見るのは「配列であること」だけである。**
  // **隠さずに書いておく: 配列の中に壊れた行が混ざっていれば、今日もそのまま上へ抜ける。**
  return body.comments as CommentSummary[];
}
