/**
 * 認証状態ストア(V1-M3-T01 / 計画 v3 §データモデル)。
 *
 * 認証状態(ユーザ・WebAuthn/パスワード資格情報・セッション・pending challenge)を、
 * **各アプリの `data/apps/<app_id>/app.sqlite` 内**に `_auth_*` 予約テーブルとして
 * 永続化する(アプリ単位認証)。プラットフォーム全体の単一 `auth.sqlite` は廃止した。
 *
 * カーネルの `meta-store.ts` に倣い:
 * - ドライバは Bun 組み込みの `bun:sqlite`(外部依存を足さない)
 * - 日時は ISO8601 UTC 文字列で TEXT 保存(辞書順比較で時系列順になる)
 * - SQL 識別子は常にダブルクォート、値は必ずプレースホルダでバインド
 * - 検出するのは呼び出し側のプログラミングエラーと I/O エラーなので例外で失敗させる
 *
 * `_auth_*` は既存の app データテーブルと同じ app.sqlite に同居する(`CREATE TABLE
 * IF NOT EXISTS` なので既存テーブル・データには触れない)。app.sqlite は DELETE モード
 * + busy_timeout=0 で運用されるため(`create-app.ts` / `snapshot.ts`)、認証接続は
 * `PRAGMA busy_timeout = 5000` を設定し、トランザクションを短く保って records 書き込みとの
 * 競合を避ける(計画 v3 §データモデル / 接続注意)。WebAuthn の公開鍵は base64url 文字列で
 * 保存し、取り出し時に Uint8Array へ復元する(往復はテストで担保)。
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { appDbPath } from "../kernel/storage-paths.ts";
import type {
  ActivityAction,
  ActivityChange,
  ActivityRecord,
  ChallengePurpose,
  Invitation,
  PasswordCredential,
  PendingChallenge,
  Role,
  Session,
  User,
  WebAuthnCredentialRecord,
} from "./types.ts";

/**
 * `_auth_users.role` 列の DDL(単一ソース)。新規 DB の CREATE(SCHEMA)と
 * 既存 DB の `ALTER TABLE ... ADD COLUMN`(migrateUserRole)の両方から参照し、
 * DEFAULT/CHECK が両経路で必ず一致するようにする。SQLite の ADD COLUMN は
 * 定数 DEFAULT + CHECK を許容する(bun:sqlite で動作確認済み)。
 *
 * CHECK は3箇所同期(この DDL / `Role` 型 / `auth-routes.ts` の `ROLE_VALUES`)の1つで、
 * `role-vocabulary-sync.test.ts` が集合一致を機械的に固定する(V2-M1-T01 / ADR-0033 限定1)。
 *
 * **SQLite CHECK 後方互換の限界(ADR-0033 §4・対処(a))**: SQLite は既存 role 列の CHECK を
 * ALTER で変更できない。したがって role 列を**3値 CHECK 付きで既に持つ古い DB**(M3-T02 で
 * role 列を得た DB)では、この4値 DDL に更新しても CHECK は3値のままで customer INSERT が
 * 弾かれうる。対処は「新規/role列未取得 DB でのみ customer 有効」を既定とし(table rebuild は
 * app.sqlite 同居ゆえ snapshot/undo と交差しリスク高でスコープ外)、限界は
 * `store.test.ts` の「CHECK 後方互換の限界」describe で顕在化する(解決したふりをしない)。
 *
 * ---
 *
 * ## **【`V5-M17-T03` / `G-G5` / `ADR-0158` 限定5 / `ADR-0233`】今日の正はここから下である**
 *
 * **上の段落を1バイトも書き換えていない**(当時の条文を読めるように残す作法)。**食い違って
 * いるのは2点である。**
 *
 * 1. **`CHECK` は値の列挙ではなくなった。** **アプリが利用者の種類を宣言できるように
 *    なったので**(`ADR-0158`。宣言は `schemas/manifest.schema.json` の `$defs/app.user_kinds`)、
 *    **値の集合は実装の定数ではなくアプリのデータである。** **DB が見られるのは
 *    「識別子の形」だけである** —— 小文字英数と `_`・1〜32文字(`ADR-0158` 限定4 と同じ形)。
 *    **「宣言された種類か」を見るのは DB ではなくサーバ層である。**
 * 2. **既存 DB は移行する。** **`ADR-0158` 限定5 は「既存 DB は移行しない」と書いていたが、
 *    `V5-M17` の発注がテーブル再構築による移行を指示した**(`CLAUDE.md` = ユーザの要求を
 *    ADR より優先する)。**変更 ADR は `docs/adr/0233-auth-role-check-migration.md`。**
 *    **実装は {@link AuthStore} の `migrateRoleCheckConstraint` であり、実測は
 *    `role-check-migration.test.ts` が本物の SQLite で行う。**
 *
 * **【誇張しない】** **`ADR-0033` §4 が「スコープ外」とした理由(table rebuild が
 * snapshot/undo と交差する)は消えていない。** **`_auth_users` は `app.sqlite` に同居するので、
 * 移行の直後に巻き戻せば `CHECK` も古い形へ戻る。** **それを試した検査は1本も無い。**
 */
export const ROLE_COLUMN_DDL = `"role" TEXT NOT NULL DEFAULT 'viewer' CHECK("role" <> '' AND length("role") <= 32 AND "role" NOT GLOB '*[^a-z0-9_]*')`;

/**
 * 監査ログの「変更内容」列(`E-G53` / `D-V4-49` / V4-M6)。**新規作成と ALTER の単一ソース。**
 *
 * **JSON テキスト1列で持つ**(`ActivityChange[]` の直列化。無ければ NULL)。**列を項目ごとに
 * 増やさない** —— 変わった項目の数は行ごとに違う。**`ROLE_COLUMN_DDL` と同じ形**(SCHEMA と
 * `ALTER TABLE ADD COLUMN` の両方から同じ文字列を流し、綴りが2箇所に割れないようにする)。
 *
 * **既存の app.sqlite には後から `ALTER TABLE ADD COLUMN` で足す**({@link ensureAuthActivitySchema})
 * —— `CREATE TABLE IF NOT EXISTS` は既存テーブルに列を足さないので、これが無いと**既に
 * `_auth_activity` を持つアプリで INSERT が落ちる**(= 監査と同一 tx の records 書込が全部落ちる)。
 */
export const ACTIVITY_CHANGES_COLUMN_DDL = `"changes" TEXT`;

/**
 * 監査ログ `_auth_activity` の DDL(単一ソース)。SCHEMA(openForApp 経路)と、
 * 生 `Database` を受ける `ensureAuthActivitySchema` の両方から同一 DDL を流す。
 * records 書込と同一接続・同一トランザクションで INSERT するため、server 側の
 * withAppDb 接続でも存在を保証できるよう独立した ensure 関数を用意する。
 */
const AUTH_ACTIVITY_DDL = `
CREATE TABLE IF NOT EXISTS "_auth_activity" (
  "id"        TEXT PRIMARY KEY,
  "user_id"   TEXT NOT NULL,
  "username"  TEXT NOT NULL,
  "action"    TEXT NOT NULL,
  "table_id"  TEXT NOT NULL,
  "record_id" TEXT,
  "at"        TEXT NOT NULL,
  ${ACTIVITY_CHANGES_COLUMN_DDL}
);

CREATE INDEX IF NOT EXISTS "_auth_activity_at" ON "_auth_activity" ("at");
`;

/**
 * `_auth_users` の列定義(**単一ソース**)。`V5-M17-T03` / `ADR-0233`。
 *
 * **新規作成(`SCHEMA`)と移行のテーブル再構築(`migrateRoleCheckConstraint`)の両方が
 * この1つの文字列を流す** —— `ROLE_COLUMN_DDL` が `SCHEMA` と `ALTER ADD COLUMN` の
 * 綴りを1箇所にまとめたのと同じ作法である(**綴りが2箇所に割れると、移行後のテーブルだけ
 * `UNIQUE` を失う、といった事故が起きる**)。
 */
const AUTH_USERS_COLUMNS_DDL = `
  "id"           TEXT PRIMARY KEY,
  "username"     TEXT UNIQUE NOT NULL,
  "display_name" TEXT,
  ${ROLE_COLUMN_DDL},
  "created_at"   TEXT NOT NULL
`;

/** `_auth_users` から移行時に写す列(順序も含めて固定する)。 */
const AUTH_USERS_COLUMN_NAMES = `"id","username","display_name","role","created_at"`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS "_auth_users" (${AUTH_USERS_COLUMNS_DDL});

CREATE TABLE IF NOT EXISTS "_auth_webauthn_credentials" (
  "id"           TEXT PRIMARY KEY,
  "user_id"      TEXT NOT NULL REFERENCES "_auth_users"("id"),
  "public_key"   TEXT NOT NULL,
  "counter"      INTEGER NOT NULL,
  "transports"   TEXT,
  "device_type"  TEXT,
  "backed_up"    INTEGER,
  "created_at"   TEXT NOT NULL,
  "last_used_at" TEXT
);

CREATE INDEX IF NOT EXISTS "_auth_webauthn_credentials_user"
  ON "_auth_webauthn_credentials" ("user_id");

CREATE TABLE IF NOT EXISTS "_auth_password_credentials" (
  "user_id"       TEXT PRIMARY KEY REFERENCES "_auth_users"("id"),
  "password_hash" TEXT NOT NULL,
  "updated_at"    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "_auth_sessions" (
  "id"         TEXT PRIMARY KEY,
  "user_id"    TEXT NOT NULL REFERENCES "_auth_users"("id"),
  "created_at" TEXT NOT NULL,
  "expires_at" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "_auth_sessions_user" ON "_auth_sessions" ("user_id");

CREATE TABLE IF NOT EXISTS "_auth_pending_challenges" (
  "id"         TEXT PRIMARY KEY,
  "challenge"  TEXT NOT NULL,
  "purpose"    TEXT NOT NULL,
  "username"   TEXT,
  "created_at" TEXT NOT NULL,
  "expires_at" TEXT NOT NULL
);
${AUTH_ACTIVITY_DDL}
`;

/**
 * **役割の付与列**(`_auth_user_roles.role`)の DDL(**単一ソース**)。`V8-M16-T04` / `J-G3`。
 *
 * **`ROLE_COLUMN_DDL` と値域の形は同じ**(空でない・32文字以内・小文字英数と `_` だけ)
 * **だが、別の文字列である** —— **`DEFAULT 'viewer'` を持たない。** 付与は「明示的に足した
 * ものだけ」であり、既定値の概念が無い(既定の1本目は今日どおり `_auth_users.role` の列である)。
 */
export const USER_ROLE_GRANT_COLUMN_DDL = `"role" TEXT NOT NULL CHECK("role" <> '' AND length("role") <= 32 AND "role" NOT GLOB '*[^a-z0-9_]*')`;

/**
 * **`_auth_*` の7本目 —— 役割の付与**(`V8-M16-T04` / `J-G3` / メインの裁定 `R-3`)。
 *
 * **`_auth_users` を1バイトも作り直さない**(`J-G3` の限定)。**`ADR-0233` のテーブル再構築を
 * 2度目は行わない。** **列は今日のまま残し、2本目以降の役割だけをこの表が持つ。**
 *
 * > **実効ロール集合 = `{_auth_users.role の1値}` ∪ `{この表に在る付与}`。**
 *
 * **`(user_id, role)` を主キーにする** —— 同じ役割を2度足しても行は増えない(冪等)。
 * **`_auth_users("id")` を参照する**(`_auth_sessions` などと同じ形)。**`ON DELETE` は
 * 今日も宣言しない** —— {@link AuthStore.deleteUser} が明示的に消す(既存3本と同じ作法)。
 *
 * **【`SCHEMA` に入れず、移行の**後**に流す理由。実測に基づく】**
 * **`migrateRoleCheckConstraint` は `_auth_users` を `DROP` して作り直す。** 参照している表が
 * 先に在ると、`ALTER TABLE ... RENAME TO "_auth_users"` が「参照先が無い」で落ちうる。
 * **`SCHEMA` → 移行2本 → 本 DDL の順に流せば、その窓が構造的に開かない。**
 */
const USER_ROLE_GRANTS_DDL = `
CREATE TABLE IF NOT EXISTS "_auth_user_roles" (
  "user_id"    TEXT NOT NULL REFERENCES "_auth_users"("id"),
  ${USER_ROLE_GRANT_COLUMN_DDL},
  "granted_at" TEXT NOT NULL,
  PRIMARY KEY ("user_id", "role")
);

CREATE INDEX IF NOT EXISTS "_auth_user_roles_user" ON "_auth_user_roles" ("user_id");
`;

/**
 * **`_auth_*` の8本目 —— 招待**(`V8-M2-T02` / 台帳 `I-G9` / `ADR-0336` §3-1)。
 *
 * **[`ADR-0303`](../../docs/adr/0303-multi-role-grant-table.md) 限定1(`_auth_*` の8本目を
 * 作らない)を正面から破る側である。** **破ってよいと判定したのは
 * [`ADR-0336`](../../docs/adr/0336-invitation-issuance-storage-redemption.md) であり、
 * 同 ADR が `ADR-0303` の front matter に `amended_by` を入れている。**
 * **`ADR-0303` の本文は1バイトも書き換えていない**(このリポジトリの作法)。
 *
 * ## **【この表は「相手がまだ居ない表」である】**(`ADR-0336` 限定4)
 *
 * **`_auth_users("id")` への外部キーを1本も宣言していない。** **招く相手はまだ登録して
 * いないので、参照できる行が存在しないためである。** **既存の `_auth_*` のうち3本
 * (`_auth_password_credentials` / `_auth_sessions` / `_auth_user_roles`)が
 * `REFERENCES "_auth_users"("id")` を持つのに対し、**8本目だけがそれを持たない表になる。**
 *
 * **【帰結を隠さない】孤児の検出も `deleteUser` の連鎖も効かない** ——
 * **登録済みの利用者を消しても、その人が発行した招待は残る**(`ADR-0336` `S3` の 4)。
 *
 * ## **主キーは相手のログイン名である**(`ADR-0336` 限定18)
 *
 * **同じ相手に有効な招待が2件同時に存在しないことを、構造で保証する。**
 * **出し直し({@link AuthStore.issueInvitation} の2回目)は行を差し替えるのであって、
 * 行を増やさない。**
 *
 * **`user_id` という綴りを使っていない** —— **`_auth_*` の他の4本の `user_id` は
 * `_auth_users.id`(不透明なランダム)を指すが、この列に入るのは「これから名乗る
 * ログイン名」である。** **同じ綴りにすると、参照先を取り違えた実装が黙って通る。**
 *
 * ## **列は7つちょうどである**(`ADR-0336` 限定2)
 *
 * **業務データ(アプリのマニフェストが宣言する表・項目)を指す列を1本も置かない** ——
 * **`D-V8-10` の逐語「招待の内容をアプリの業務データ(部署・役職など)と紐づけて持つことは
 * できない」がそのまま制約である。** **8列目を足す提案には門A を改めて課す。**
 *
 * **`used_at` が「1回きり」と「取り消し」の両方を表す**(`ADR-0336` 限定16 / `I-G12`)——
 * **行を削除しない。** **削除すると、その招待が使われた/取り消されたことを運営者が
 * 一覧で確認できなくなる。** **【正直に書く】列が7つに閉じているので、
 * 「使われた」と「取り消された」はこの表からは区別できない。**
 *
 * **役割の列は {@link USER_ROLE_GRANT_COLUMN_DDL} を使い回す**(綴りを2箇所に割らない)。
 */
const INVITATIONS_DDL = `
CREATE TABLE IF NOT EXISTS "_auth_invitations" (
  "username"   TEXT PRIMARY KEY,
  ${USER_ROLE_GRANT_COLUMN_DDL},
  "code"       TEXT NOT NULL,
  "expires_at" TEXT NOT NULL,
  "issued_by"  TEXT NOT NULL,
  "issued_at"  TEXT NOT NULL,
  "used_at"    TEXT
);
`;

/**
 * **招待コードの文字表**(`V8-M2-T03` / 台帳 `I-G14` / `ADR-0336` 限定9)。
 *
 * **`0`-`9` + `A`-`Z` から `I` `L` `O` `U` を除いた 32文字ちょうど。**
 * **33文字目・31文字目を足し引きするには門A の新規審査が要る**(`ADR-0336` §3a の 4)——
 * **値域が変わると総当たりの数字(§3-4 の6行)を全部書き換えることになる。**
 *
 * **【32 である理由は読み上げのためだけではない】** **32 は 256 の約数なので、
 * `byte & 31`(= `byte % 32`)で偏りが生じない**(256 / 32 = 8 ちょうど。剰余の各値が
 * 正確に8通りずつ写る)。 **`I`/`L`/`O`/`U` を除かない36文字表にすると 256 / 36 が
 * 割り切れず、下位の4文字が他より出やすくなる。**
 *
 * **【禁止の履行】「読み間違えない」とは書かない** —— **`0`/`O` と `1`/`I` は片側しか
 * 除いていない**(数字側が残る)。**取り違えは減るが消えない。**
 * **`U` を除くのは卑語の混入を避ける慣行だが、32文字の英数字だけで卑語の生成を防ぐ
 * 仕組みは無い。**
 */
export const INVITATION_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 招待コードの桁数(`ADR-0336` 限定9。**8文字ちょうど**)。 */
export const INVITATION_CODE_LENGTH = 8;

/**
 * **招待の有効期間**(`D-V8-113` / `ADR-0336` 限定14。**24時間で固定**)。
 *
 * **運営者が1件ごとに変えられる引数を、発行の口に1つも置かない。**
 * **期限の値を外から受け取る経路を1本も作らない** —— **期限の判定は ISO8601 文字列の
 * 辞書順比較であり(`src/auth/challenge.ts` の `isExpired`)、型は `string` である。
 * 手で書き換えた値や別形式の値が1つでも入ると黙って壊れる。**
 */
export const INVITATION_TTL_SEC = 24 * 3600;

/**
 * **招待コードを1本発行する**(`V8-M2-T03` / 台帳 `I-G14` / `I-G18`)。
 *
 * **乱数源は {@link randomId} と同じ `crypto.getRandomValues` である。**
 * **剰余で偏りを入れていない** —— **`byte & 31` は 256 を 32 で割り切るので、
 * 32記号が正確に等確率で出る**({@link INVITATION_CODE_ALPHABET} の doc)。
 *
 * **空間は 32^8 = 1,099,511,627,776 = 1.0995e12 通りである。**
 * **【禁止の履行】「十分に長い」「総当たりは不可能」とは書かない** ——
 * **総当たりに要する時間は前提(レート制限のキーが1つに集まるか、IP ごとに割れるか)で
 * 2桁以上変わる。** **数字は `ADR-0336` §3-4 の6行にある**(単一キーで全空間 20,919年 /
 * 前段プロキシが実 IP を載せる構成で 1,000 IP なら 約21年)。**この2つを混ぜて書かない。**
 */
export function randomInvitationCode(): string {
  const bytes = new Uint8Array(INVITATION_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) {
    // biome-ignore lint/style/noNonNullAssertion: 0..31 は必ず 32文字表の範囲に収まる。
    code += INVITATION_CODE_ALPHABET[byte & 31]!;
  }
  return code;
}

/** ISO8601 UTC(ミリ秒つき)の現在時刻。 */
function nowIso(): string {
  return new Date().toISOString();
}

/** 現在時刻から `ttlSec` 秒後の ISO8601 UTC 文字列。 */
function expiresAtIso(ttlSec: number, from: Date = new Date()): string {
  return new Date(from.getTime() + ttlSec * 1000).toISOString();
}

/**
 * 暗号乱数 32byte(256bit)を base64url にした不透明 ID。
 * ユーザ ID / セッション ID / pending ID の生成に使う(計画 §2/軽微4)。
 */
export function randomId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/** バイト列 → base64url 文字列。 */
export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** base64url 文字列 → バイト列。 */
export function fromBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

type UserRow = {
  id: string;
  username: string;
  display_name: string | null;
  role: string;
  created_at: string;
};

type ActivityRow = {
  id: string;
  user_id: string;
  username: string;
  action: string;
  table_id: string;
  record_id: string | null;
  at: string;
  changes: string | null;
};

type CredentialRow = {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  device_type: string | null;
  backed_up: number | null;
  created_at: string;
  last_used_at: string | null;
};

type PasswordRow = {
  user_id: string;
  password_hash: string;
  updated_at: string;
};

type SessionRow = {
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
};

type ChallengeRow = {
  id: string;
  challenge: string;
  purpose: string;
  username: string | null;
  created_at: string;
  expires_at: string;
};

/** `_auth_invitations` の1行(`V8-M2-T02`)。 */
type InvitationRow = {
  username: string;
  role: string;
  code: string;
  expires_at: string;
  issued_by: string;
  issued_at: string;
  used_at: string | null;
};

/** 招待の行 → ドメイン表現。 */
function toInvitation(row: InvitationRow): Invitation {
  return {
    username: row.username,
    role: row.role as Role,
    code: row.code,
    expiresAt: row.expires_at,
    issuedBy: row.issued_by,
    issuedAt: row.issued_at,
    usedAt: row.used_at,
  };
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role as Role,
    createdAt: row.created_at,
  };
}

function toActivity(row: ActivityRow): ActivityRecord {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    action: row.action as ActivityAction,
    tableId: row.table_id,
    recordId: row.record_id,
    at: row.at,
    // **読めない値を落とさない**(壊れた JSON は `null` にして行そのものは返す)——
    // 監査行を1行まるごと消すより、変更内容だけが読めない方がまだ追える。
    changes: parseActivityChanges(row.changes),
  };
}

/** `changes` 列(JSON テキスト)を読む。空・壊れた値は `null`(行は捨てない)。 */
function parseActivityChanges(raw: string | null): ActivityChange[] | null {
  if (raw === null || raw === "") {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ActivityChange[]) : null;
  } catch {
    return null;
  }
}

/**
 * 最後の owner を降格しようとしたときに投げるエラー(オーナー不変条件)。
 * 後続 P-B が判別して 409/422 に変換できるよう `code` を持つ。
 */
export class LastOwnerError extends Error {
  readonly code = "LAST_OWNER";
  constructor(message = "最後の owner は降格できません。") {
    super(message);
    this.name = "LastOwnerError";
  }
}

/**
 * **その人が「人に役割を配れる」かどうかを答える判定**(`V8-M30`。台帳 `T-G29` =
 * **限定採用**。ユーザ決定 `D-V8-47`)。
 *
 * **本ファイル(カーネル層の下)は役割の規則を1バイトも読まない。** **読むのは
 * `src/server/owner-scope.ts` の `judgeRoleAccess`(`target: "role"` / `verb: "write"`)
 * 1本であり、それを包んだ関数をここへ**注入**する**({@link AuthStore.setRoleGrantJudge})。
 *
 * **【なぜ注入なのか。どちらにしたかを書く】** —— **`src/auth/` は `src/server/` を
 * 1本も import していない**(向きは `server → auth` の一方通行であり、逆向きに1本でも
 * 張ると循環になる)。**したがって「判定の家を2本にしない」(`ADR-0305` 限定3)を
 * 守る道は、`src/auth/` に規則の読み方を書き写すことではなく、注入だけである。**
 */
export type RoleGrantJudge = (roles: readonly Role[]) => boolean;

/**
 * **人に役割を配れる人が0人になる操作を拒否したときに投げるエラー**(`V8-M30`。
 * 台帳 `T-G29`)。**{@link LastOwnerError} の**隣**に立つ2本目の不変条件であり、
 * 1本目を1バイトも置き換えない。**
 *
 * **【2本を `AND` で結んでいない】** —— **`AND` にすると片方が0でも通る**
 * (`docs/plan/v8/records/v8-m25.md` §5-2 の (4) の逐語)。**どちらか一方でも0人に
 * なる操作を拒否する** = **例外が2種類あり、先に成立したほうが投げられる。**
 */
export class LastGranterError extends Error {
  readonly code = "LAST_GRANTER";
  constructor(message = "役割を配れる人が0人になる操作はできません。") {
    super(message);
    this.name = "LastGranterError";
  }
}

/**
 * 生 `Database` に `_auth_activity`(監査ログ)を `CREATE IF NOT EXISTS` する。
 * server が withAppDb で開いた records 書込接続に対し、INSERT 前にスキーマ存在を
 * 保証するために使う(DDL は SCHEMA と同一ソース `AUTH_ACTIVITY_DDL`)。冪等。
 */
export function ensureAuthActivitySchema(db: Database): void {
  db.exec(AUTH_ACTIVITY_DDL);
  migrateActivityChanges(db);
}

/**
 * 生 `Database` に `_auth_user_roles`(役割の付与)を `CREATE IF NOT EXISTS` する
 * (`V8-M16-T04` / `J-G3`)。**{@link ensureAuthActivitySchema} と同型。**冪等。
 *
 * **なぜ ensure 関数が要るか** —— `src/server/app.ts` の `withAppDb` が開く records 書込接続は
 * `AuthStore.prepare` を通らない。**この関数が無いまま生の接続からこの表を読み書きすると、
 * 着手前から在るアプリで落ちる**(`_auth_activity.changes` が実際に起こしかけた事故と同じ形。
 * {@link migrateActivityChanges} の doc)。
 *
 * **【正直に書く】着手時点で、生 `Database` からこの表を読む経路は1本も無い。**
 * 実効ロール集合を解決するのは `AuthStore`(= `prepare` を通る接続)だけである。
 * **それでも用意するのは、後から生の接続で読む配線が足されたときに、この関数を呼ぶだけで
 * 済むようにするためである**(`_files` の `ensureFilesTable` と同じ作法)。
 */
export function ensureUserRoleGrantsSchema(db: Database): void {
  db.exec(USER_ROLE_GRANTS_DDL);
}

/**
 * **生 `Database` から実効ロール集合を読む**(`V8-M21` / 台帳 `J-G21` / `J-G22a` / `J-G23`)。
 *
 * **上の {@link ensureUserRoleGrantsSchema} の doc が予告していた「後から生の接続で読む配線」が
 * これである。** **旧の逐語**:
 * > **【正直に書く】着手時点で、生 `Database` からこの表を読む経路は1本も無い。**
 * > 実効ロール集合を解決するのは `AuthStore`(= `prepare` を通る接続)だけである。
 * > **それでも用意するのは、後から生の接続で読む配線が足されたときに、この関数を呼ぶだけで
 * > 済むようにするためである**
 * **今日その経路が1本できた** —— **自動処理・コードの島に**面**(役割に束ねた権限)を
 * 効かせるために、カーネルが書き手の役割を知る必要がある。**
 *
 * **規則は {@link AuthStore.effectiveRoles} と同一である**(`列の1値 ∪ 付与表`。
 * **列の値が必ず1本目に来る。同じ値は1度しか現れない**)。**規則を2本に割っていない** ——
 * **`AuthStore` は自分の接続で同じ SQL を、こちらは渡された接続で同じ SQL を読む。**
 *
 * **【新しい接続を1つも開かない】** —— **`AuthStore.openForApp` を呼ぶと `CREATE TABLE`
 * (= 書込)が走り、書込トランザクションの内側から呼ぶと `SQLITE_BUSY` になりうる。**
 * **判定は書込 tx の内側で走るので、渡された接続をそのまま読む。**
 *
 * **【表が無ければ `null`】** —— **`_auth_*` を用意していない接続・アプリでも落とさない。**
 * **`null` は「役割が1つも分からない」であり、面の判定では未ログインと同じ扱いになる**
 * (`roleSubjectsOf` が `anonymous` に倒す)。**`CREATE TABLE` を1本も走らせない**
 * (読むだけの経路で表を作らない)。
 */
export function effectiveRolesOnDb(db: Database, userId: string): Role[] | null {
  try {
    const column = db
      .query<{ role: string }, [string]>(`SELECT "role" FROM "_auth_users" WHERE "id" = ?`)
      .get(userId);
    if (column === null) {
      return null;
    }
    const roles: Role[] = [column.role as Role];
    const granted = db
      .query<{ role: string }, [string]>(
        `SELECT "role" FROM "_auth_user_roles" WHERE "user_id" = ? ORDER BY "rowid" ASC`,
      )
      .all(userId);
    for (const row of granted) {
      if (!roles.includes(row.role as Role)) {
        roles.push(row.role as Role);
      }
    }
    return roles;
  } catch {
    // **`_auth_users` / `_auth_user_roles` が無い接続**(用意していないアプリ・テスト用の
    // 生 DB)。**落とさず「分からない」に倒す。**
    return null;
  }
}

/**
 * 既存の `_auth_activity` に `changes` 列が無ければ `ALTER TABLE ADD COLUMN` で足す
 * (`E-G53` / V4-M6)。**`migrateUserRole` と同じ形**(`PRAGMA table_info` で見てから足す)。
 *
 * **これが無いと、着手前から在るアプリで監査 INSERT が落ちる** —— `CREATE TABLE IF NOT
 * EXISTS` は既存テーブルに列を足さないためである。**監査 INSERT は records 書込と同一 tx に
 * あるので、落ちれば書込ごと巻き戻る**(= 既存アプリが1行も書けなくなる)。冪等。
 */
function migrateActivityChanges(db: Database): void {
  const columns = db
    .query<{ name: string }, []>(`PRAGMA table_info("_auth_activity")`)
    .all()
    .map((row) => row.name);
  if (!columns.includes("changes")) {
    db.exec(`ALTER TABLE "_auth_activity" ADD COLUMN ${ACTIVITY_CHANGES_COLUMN_DDL};`);
  }
}

/**
 * 生 `Database` に監査ログ1件を INSERT する。id(randomId)と at(ISO8601)を付与し、
 * 記録した `ActivityRecord` を返す。server はカーネル書込と同一トランザクション内で
 * 同じ `db` を渡して呼ぶ(失敗時はトランザクションごと巻き戻る)。
 */
export function recordActivity(
  db: Database,
  input: {
    userId: string;
    username: string;
    action: ActivityAction;
    tableId: string;
    recordId: string | null;
    /**
     * **その更新で実際に値が変わった項目**(`E-G53` / `D-V4-49`。省略・空配列は `null` 扱い)。
     * **作る側(`src/server/app.ts`)が組み立てて渡す** —— ここは受け取った配列を直列化する
     * だけで、**何を残すかの判断を持たない。**
     */
    changes?: readonly ActivityChange[] | null;
  },
): ActivityRecord {
  const changes =
    input.changes === undefined || input.changes === null || input.changes.length === 0
      ? null
      : [...input.changes];
  const record: ActivityRecord = {
    id: randomId(),
    userId: input.userId,
    username: input.username,
    action: input.action,
    tableId: input.tableId,
    recordId: input.recordId,
    at: nowIso(),
    changes,
  };
  db.query(
    `INSERT INTO "_auth_activity"
       ("id", "user_id", "username", "action", "table_id", "record_id", "at", "changes")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.userId,
    record.username,
    record.action,
    record.tableId,
    record.recordId,
    record.at,
    changes === null ? null : JSON.stringify(changes),
  );
  return record;
}

function toCredential(row: CredentialRow): WebAuthnCredentialRecord {
  const record: WebAuthnCredentialRecord = {
    id: row.id,
    userId: row.user_id,
    publicKey: fromBase64Url(row.public_key),
    counter: row.counter,
    createdAt: row.created_at,
  };
  if (row.transports !== null) {
    record.transports = JSON.parse(row.transports) as string[];
  }
  if (row.device_type !== null) {
    record.deviceType = row.device_type;
  }
  if (row.backed_up !== null) {
    record.backedUp = row.backed_up === 1;
  }
  if (row.last_used_at !== null) {
    record.lastUsedAt = row.last_used_at;
  }
  return record;
}

/** 入力(登録儀式で新規保存する WebAuthn クレデンシャル)。 */
export type AddWebauthnCredentialInput = {
  id: string;
  userId: string;
  publicKey: Uint8Array;
  counter: number;
  transports?: string[];
  deviceType?: string;
  backedUp?: boolean;
};

/**
 * 認証状態ストア。開くアプリ(app.sqlite)は必ず引数で受け取る
 * (環境変数・ハードコードに依存しない)。運用では `openForApp(dataRoot, appId)` で
 * `data/apps/<app_id>/app.sqlite` を開き、その中に `_auth_*` 予約テーブルを用意する。
 * テストは `open(":memory:")` や `open(<任意path>)` で任意の DB を開ける。
 */
export class AuthStore {
  private readonly db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  /**
   * `_auth_*` テーブルを `CREATE TABLE IF NOT EXISTS` で用意し、
   * app.sqlite の DELETE モード運用に合わせて `busy_timeout` を設定する。
   * `_auth_*` の整合(user_id 参照)のため foreign_keys も接続単位で有効化する
   * (接続ローカルの pragma なので、records を書く他接続には影響しない)。
   */
  private static prepare(db: Database): void {
    // app.sqlite は DELETE モード + busy_timeout=0。短い競合を待てるよう明示設定する
    // (計画 v3 §データモデル / snapshot.ts:112 の作法)。
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
    // T01 当時の app.sqlite(role 列なし)を開いたときに role 列を足す(単一ソース DDL)。
    // ensureOwnerExists は書込を誘発するので prepare には置かない(明示呼び出し専用)。
    AuthStore.migrateUserRole(db);
    // V5-M17-T03 / ADR-0233: 値を列挙する古い CHECK を持つ DB を作り替える。
    AuthStore.migrateRoleCheckConstraint(db);
    // **V8-M16-T04 / J-G3: 7本目の表は `_auth_users` の作り替えの**後**に作る。**
    // **順序に意味がある** —— 参照する表が先に在ると、上の再構築の `RENAME` が落ちうる
    // (理由の全文は `USER_ROLE_GRANTS_DDL` の doc)。**既存 DB は開いた瞬間に表を得る。**
    ensureUserRoleGrantsSchema(db);
    // **V8-M2-T02 / I-G9 / ADR-0336: 8本目の表(招待)。**
    // **`_auth_users` を1バイトも参照しないので、上の再構築との順序に依存しない** ——
    // **それでも7本目と同じ位置(再構築の後)に置く**(読む人が順序の意味を1通りに読めるため)。
    db.exec(INVITATIONS_DDL);
  }

  /**
   * **値を列挙する古い `CHECK` を持つ `_auth_users` を、識別子の形を見る新しい `CHECK` へ
   * 作り替える**(`V5-M17-T03` / `G-G5` / `ADR-0233`)。
   *
   * **SQLite は既存列の `CHECK` を `ALTER` で変更できない**(`ROLE_COLUMN_DDL` の上の段落)。
   * **したがってテーブル再構築で行う** —— 新表を作り、行を全部写し、旧表を落とし、名前を
   * 付け替える(SQLite 公式が案内する手順)。**1つのトランザクションに収める。**
   *
   * **冪等である** —— 新しい形(`NOT GLOB`)を既に持つ DB では何もしない。
   *
   * **`PRAGMA foreign_keys` をこの関数の中だけ落とす** —— `_auth_users` は
   * `_auth_webauthn_credentials` / `_auth_password_credentials` / `_auth_sessions` から
   * 参照されており、参照を有効にしたまま旧表を落とせないためである。**接続ローカルの
   * pragma なので、他の接続に影響しない。****終わったら必ず戻す**(`finally`)。
   *
   * **【誇張しない】** **移行の途中で電源が落ちた場合を1度も試していない。**
   * **スナップショット / undo との交差も1度も試していない**(`ADR-0033` §4 が
   * 「スコープ外」とした理由は今日も消えていない)。**`_auth_users` は `app.sqlite` に
   * 同居するので、移行の直後に巻き戻せば `CHECK` も古い形に戻る。**
   */
  private static migrateRoleCheckConstraint(db: Database): void {
    const stored =
      db
        .query<{ sql: string | null }, []>(
          `SELECT sql FROM sqlite_master WHERE type='table' AND name='_auth_users'`,
        )
        .get()?.sql ?? "";
    // **新しい形の目印は `NOT GLOB` である**(`ROLE_COLUMN_DDL` と同じ綴り)。
    if (stored === "" || stored.includes("NOT GLOB")) {
      return;
    }
    db.exec("PRAGMA foreign_keys = OFF;");
    try {
      db.exec("BEGIN;");
      try {
        db.exec(`CREATE TABLE "_auth_users_migrated" (${AUTH_USERS_COLUMNS_DDL});`);
        db.exec(
          `INSERT INTO "_auth_users_migrated" (${AUTH_USERS_COLUMN_NAMES})
             SELECT ${AUTH_USERS_COLUMN_NAMES} FROM "_auth_users";`,
        );
        db.exec(`DROP TABLE "_auth_users";`);
        db.exec(`ALTER TABLE "_auth_users_migrated" RENAME TO "_auth_users";`);
        db.exec("COMMIT;");
      } catch (error) {
        db.exec("ROLLBACK;");
        throw error;
      }
    } finally {
      db.exec("PRAGMA foreign_keys = ON;");
    }
  }

  /**
   * 既存 DB の `_auth_users` に `role` 列が無ければ `ALTER TABLE ADD COLUMN` で足す。
   * 列定義は `ROLE_COLUMN_DDL`(SCHEMA と同一ソース)を使う。新規 DB は SCHEMA で
   * 既に role 列を持つので何もしない(冪等)。
   */
  private static migrateUserRole(db: Database): void {
    const columns = db
      .query<{ name: string }, []>(`PRAGMA table_info("_auth_users")`)
      .all()
      .map((c) => c.name);
    if (!columns.includes("role")) {
      db.exec(`ALTER TABLE "_auth_users" ADD COLUMN ${ROLE_COLUMN_DDL};`);
    }
  }

  /**
   * `data/apps/<app_id>/app.sqlite` を開き(なければ作る)、`_auth_*` を用意する。
   * app.sqlite は通常カーネルの create-app が先に作っている前提だが、テストでは
   * 事前に作って渡してよい。既存の app データテーブルには触れない
   * (`_auth_*` のみ `CREATE TABLE IF NOT EXISTS` で追加する)。
   * journal_mode は既存の app.sqlite のモード(DELETE)をそのまま尊重し、上書きしない。
   */
  static openForApp(dataRoot: string, appId: string): AuthStore {
    const dbPath = appDbPath(dataRoot, appId);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath, { create: true });
    AuthStore.prepare(db);
    return new AuthStore(db);
  }

  /**
   * `dbPath` を直接開く(なければ作る)。":memory:" を渡すとオンメモリで開く。
   * 任意のパスを開けるのでテスト用途向け(単一 `auth.sqlite` を作る経路は廃止した)。
   * テーブルは毎回 `CREATE TABLE IF NOT EXISTS` で用意するため既存 DB に対しても安全。
   */
  static open(dbPath: string): AuthStore {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    const db = new Database(dbPath, { create: true });
    AuthStore.prepare(db);
    return new AuthStore(db);
  }

  /** DB を閉じる。以後の操作はエラーになる。 */
  close(): void {
    this.db.close();
  }

  // --- users -----------------------------------------------------------------

  /**
   * ユーザを作成する。`id` は不透明なランダムを発行する。
   * @throws username が既に使われている場合(UNIQUE 違反)
   */
  createUser(input: { username: string; displayName?: string | null; role?: Role }): User {
    const user: User = {
      id: randomId(),
      username: input.username,
      displayName: input.displayName ?? null,
      role: input.role ?? "viewer",
      createdAt: nowIso(),
    };
    try {
      this.db
        .query(
          `INSERT INTO "_auth_users" ("id", "username", "display_name", "role", "created_at")
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(user.id, user.username, user.displayName, user.role, user.createdAt);
    } catch (error) {
      if (error instanceof Error && /UNIQUE/i.test(error.message)) {
        throw new Error(`ユーザ名 "${input.username}" は既に使われています。`);
      }
      throw error;
    }
    return user;
  }

  /** id でユーザを取得する。未登録なら undefined。 */
  findUserById(id: string): User | undefined {
    const row = this.db
      .query<UserRow, [string]>(
        `SELECT "id", "username", "display_name", "role", "created_at" FROM "_auth_users" WHERE "id" = ?`,
      )
      .get(id);
    return row === null ? undefined : toUser(row);
  }

  /**
   * 登録済みユーザ数を返す。「初回ユーザは登録ポリシーによらず常に許可」の判定に使う
   * (ADR-0014 §8: users が0件なら allowRegistration=false でも登録を通す)。
   */
  countUsers(): number {
    const row = this.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "_auth_users"`).get();
    return row?.n ?? 0;
  }

  /** username でユーザを取得する。未登録なら undefined。 */
  findUserByUsername(username: string): User | undefined {
    const row = this.db
      .query<UserRow, [string]>(
        `SELECT "id", "username", "display_name", "role", "created_at" FROM "_auth_users" WHERE "username" = ?`,
      )
      .get(username);
    return row === null ? undefined : toUser(row);
  }

  /**
   * 全ユーザを created_at 昇順(同時刻は rowid 昇順 = 挿入順)で返す。管理エンドポイント用。
   *
   * **【`V9-M11-T05` / `X-G37` / `ADR-0356`】第2キーは `id`(32バイト乱数)ではなく `rowid`
   * である。** **`id` は順序に意味を持たないので、同じミリ秒に作られた2人の並びが乱数で
   * 決まっていた。** **一覧の先頭と {@link ensureOwnerExists} が昇格させる1人を一致させる
   * ため、両方を同じ並びにそろえた**(ユーザ決定 `D-V9-23`)。
   */
  listUsers(): User[] {
    return this.db
      .query<UserRow, []>(
        `SELECT "id", "username", "display_name", "role", "created_at"
         FROM "_auth_users" ORDER BY "created_at" ASC, rowid ASC`,
      )
      .all()
      .map(toUser);
  }

  // --- 役割の付与(`_auth_user_roles`。V8-M16-T04 / J-G3)------------------------------
  //
  // **【この規則は着手時点でどこにも定義されていなかった。`V8-M16` が初めて定義する】**
  //
  // > **実効ロール集合 = `{_auth_users.role の1値}` ∪ `{_auth_user_roles に在る付与}`。**
  // > **判定は「実効ロール集合と宣言集合の積が空でなければ通る」の1本に閉じる。**
  //
  // **根拠は門A の限定 `J-G3` の逐語「複数の役割は和集合1本で合成する」である。**
  // **「今日どおり」ではない** —— 着手前の実装は1ユーザ1値しか持てず、合成規則そのものが
  // 存在しなかった(実測B §3-2 (e) が「規則が未定義」と名指しした箇所)。

  /**
   * **付与表に在る役割**(列の1値は含まない)。付与した順(同時刻は役割名の昇順)。
   * 未登録のユーザには空配列を返す。
   */
  roleGrants(userId: string): Role[] {
    return this.db
      .query<{ role: string }, [string]>(
        `SELECT "role" FROM "_auth_user_roles" WHERE "user_id" = ?
         ORDER BY "rowid" ASC`,
      )
      .all(userId)
      .map((row) => row.role as Role);
  }

  /**
   * **実効ロール集合**(列の1値 ∪ 付与表)。**列の値が必ず1本目に来る**(= 既定の1本目)。
   * **同じ値は1度しか現れない。** ユーザが存在しなければ空配列(= 誰でもない)。
   */
  effectiveRoles(userId: string): Role[] {
    const column = this.db
      .query<{ role: string }, [string]>(`SELECT "role" FROM "_auth_users" WHERE "id" = ?`)
      .get(userId);
    if (column === null) {
      return [];
    }
    const roles: Role[] = [column.role as Role];
    for (const granted of this.roleGrants(userId)) {
      if (!roles.includes(granted)) {
        roles.push(granted);
      }
    }
    return roles;
  }

  /** 全ユーザの付与を `user_id → Role[]` で1度に読む(一覧の口が N+1 を撃たないため)。 */
  roleGrantsByUser(): Map<string, Role[]> {
    const rows = this.db
      .query<{ user_id: string; role: string }, []>(
        `SELECT "user_id", "role" FROM "_auth_user_roles"
         ORDER BY "rowid" ASC`,
      )
      .all();
    const map = new Map<string, Role[]>();
    for (const row of rows) {
      const list = map.get(row.user_id);
      if (list === undefined) {
        map.set(row.user_id, [row.role as Role]);
      } else if (!list.includes(row.role as Role)) {
        list.push(row.role as Role);
      }
    }
    return map;
  }

  /** 付与を1つ足す(**冪等**。既に在れば何もしない)。列と同じ値でも表に持てる。 */
  grantRole(userId: string, role: Role): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO "_auth_user_roles" ("user_id","role","granted_at") VALUES (?, ?, ?)`,
      )
      .run(userId, role, nowIso());
  }

  /**
   * 付与を1つ外す(**冪等**)。**列の1値には触らない** —— 列の値を外すには
   * {@link setUserRole} / {@link setUserRoles} を使う。
   */
  revokeRole(userId: string, role: Role): void {
    this.db
      .query(`DELETE FROM "_auth_user_roles" WHERE "user_id" = ? AND "role" = ?`)
      .run(userId, role);
  }

  /**
   * **実効ロール集合を丸ごと置き換える**(付け外しの1本の口)。更新後の User を返す。
   *
   * - **列は既定の1本目として残る** —— 今の列の値が集合に在ればそのまま、無ければ集合の先頭が
   *   列の値になる。残りが付与表に入る。
   * - **単一トランザクション内**で不変条件を検査する(接続跨ぎ TOCTOU 緩和)。
   * - **`roles` が空なら拒否する** —— 役割を1つも持たないユーザを作らない。
   *
   * @throws 対象ユーザが存在しない場合 / `roles` が空の場合
   * @throws {LastOwnerError} 実効集合から owner が消え、owner が他に1人も居なくなる場合
   */
  setUserRoles(userId: string, roles: readonly Role[]): User {
    const unique: Role[] = [];
    for (const role of roles) {
      if (!unique.includes(role)) {
        unique.push(role);
      }
    }
    const tx = this.db.transaction((): User => {
      const current = this.findUserById(userId);
      if (current === undefined) {
        throw new Error(`ユーザ "${userId}" は存在しません。`);
      }
      if (unique.length === 0) {
        throw new Error("役割を1つも持たないユーザは作れません。");
      }
      // **【`V8-M30`。台帳 `T-G29`】2本目の不変条件の「操作前」の人数を先に採る。**
      // **1本目の判定式は1バイトも触っていない**(すぐ下)。
      const grantersBefore = this.roleGrantersBefore();
      // **持ち主の不変条件は列と表の**両方**を数える**(`J-G5` / `R-3`)。
      if (
        this.effectiveRoles(userId).includes("owner") &&
        !unique.includes("owner") &&
        this.countOwners() === 1
      ) {
        throw new LastOwnerError();
      }
      const primary = unique.includes(current.role) ? current.role : (unique[0] as Role);
      this.db.query(`UPDATE "_auth_users" SET "role" = ? WHERE "id" = ?`).run(primary, userId);
      this.db.query(`DELETE FROM "_auth_user_roles" WHERE "user_id" = ?`).run(userId);
      const at = nowIso();
      for (const role of unique) {
        if (role === primary) {
          continue;
        }
        this.db
          .query(`INSERT INTO "_auth_user_roles" ("user_id","role","granted_at") VALUES (?, ?, ?)`)
          .run(userId, role, at);
      }
      // **【`V8-M30`。台帳 `T-G29`】2本目の不変条件。** **1本目(すぐ上の `LastOwnerError`)
      // と `AND` で結んでいない** —— **別の `if` であり、どちらか一方でも0人になれば拒否する。**
      this.guardRoleGranters(grantersBefore);
      const updated = this.findUserById(userId);
      if (updated === undefined) {
        throw new Error(`ユーザ "${userId}" は存在しません。`);
      }
      return updated;
    });
    return tx();
  }

  /**
   * **owner の実効ロールを持つ「人」の数**(オーナー不変条件の検査に使う)。
   *
   * **【`V8-M16-T04` / `J-G3` で意味が変わった。先に書く】** **着手前は
   * `WHERE "role" = 'owner'` の等値1本、つまり**列だけ**を数えていた。** **今日は
   * 列と付与表の**両方**を数える** —— **どちらか片方にだけ owner が在る状態でも 0人 と
   * 判定しない。****数えるのは行ではなく人である**(列と表の両方に owner が在る人は1人)。
   */
  countOwners(): number {
    const row = this.db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM "_auth_users" AS u
          WHERE u."role" = 'owner'
             OR EXISTS (
                  SELECT 1 FROM "_auth_user_roles" AS g
                   WHERE g."user_id" = u."id" AND g."role" = 'owner'
                )`,
      )
      .get();
    return row?.n ?? 0;
  }

  /**
   * **「人に役割を配れる」役割を実効ロール集合に持つ「人」の数**(`V8-M30`。台帳 `T-G29`。
   * ユーザ決定 `D-V8-47`)。**{@link countOwners} の**隣**に立つ2本目の数え方である。**
   *
   * **【1本目との違いを1文で書く】** —— **{@link countOwners} は
   * **`'owner'` という綴りの役割を持つ人**を数える(SQL に綴りが焼き込まれている)。
   * **本メソッドは**綴りを1文字も見ない** —— **役割の規則で `role` + `write` を許された
   * 役割を、実効ロール集合に1つでも持つ人**を数える。**
   * **`V8-M25` の H群が実測した穴(「`owner` が1人居る」は「配れる人が1人居る」を
   * 保証しない)を、この2本目が数え直す。**
   *
   * **数え方は1本目とまったく同じ形である** —— **列(`_auth_users.role`)と付与表
   * (`_auth_user_roles`)の**両方**を見る**({@link effectiveRoles} が和集合1本で合成する。
   * `ADR-0303` 限定5 / 限定7)。**数えるのは行ではなく人である。**
   *
   * **【SQL に焼き込まない理由】** —— **「配れる役割」の集合はアプリごとの宣言で決まり、
   * DB の中に無い。** **判定は注入で受け取る**({@link RoleGrantJudge})。
   */
  countRoleGranters(judge: RoleGrantJudge): number {
    let count = 0;
    for (const user of this.listUsers()) {
      if (judge(this.effectiveRoles(user.id))) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * **「配れるか」の判定をこの接続に注入する**(`V8-M30`。台帳 `T-G29`)。
   *
   * **呼ばなければ2本目の不変条件は1件も発火しない** —— **カーネル層を直接叩く経路
   * (MCP など)はこの検査を1ミリも通らない。** **隠さずに書く。**
   */
  setRoleGrantJudge(judge: RoleGrantJudge | undefined): void {
    this.roleGrantJudge = judge;
  }

  /**
   * **注入された判定**(`V8-M30`)。**未注入(`undefined`)は「この接続では2本目を
   * 検査しない」を意味する。**
   */
  private roleGrantJudge: RoleGrantJudge | undefined;

  /**
   * **2本目の不変条件**(`V8-M30`。台帳 `T-G29`)。**書込のあとに呼ぶ** ——
   * **投げるとトランザクションが巻き戻るので、拒否された操作は1バイトも残らない。**
   *
   * **止めるのは「0人にする操作」だけである** —— **`before` が既に0人なら1件も止めない。**
   * **【なぜそうしたか】** **既に0人の状態で全部を拒否すると、締め出しからの回復そのもの
   * (誰かに配れる役割を付け直す操作)が通らなくなる。** **1本目(`LastOwnerError`)が
   * `countOwners() === 1` / `<= 1` のときにしか投げないのと同じ形である。**
   *
   * @throws {LastGranterError} 配れる人が `before > 0` から 0人 になる場合
   */
  private guardRoleGranters(before: number): void {
    const judge = this.roleGrantJudge;
    if (judge === undefined || before === 0) {
      return;
    }
    if (this.countRoleGranters(judge) === 0) {
      throw new LastGranterError();
    }
  }

  /** 2本目の不変条件の「操作前」の人数。**判定が未注入なら数えない**(0 を返す)。 */
  private roleGrantersBefore(): number {
    const judge = this.roleGrantJudge;
    return judge === undefined ? 0 : this.countRoleGranters(judge);
  }

  /**
   * ユーザのロールを変更し、更新後 User を返す。**単一トランザクション内**で
   * 「最後の owner の降格」を検査する(接続跨ぎ TOCTOU 緩和)。対象が現在 owner かつ
   * 変更後が owner 以外かつ owner が1人だけなら {@link LastOwnerError} を投げる。
   * @throws 対象ユーザが存在しない場合
   * @throws {LastOwnerError} 最後の owner を降格しようとした場合
   */
  setUserRole(userId: string, role: Role): User {
    const tx = this.db.transaction((): User => {
      const current = this.findUserById(userId);
      if (current === undefined) {
        throw new Error(`ユーザ "${userId}" は存在しません。`);
      }
      // **【`V8-M16-T04` / `J-G3` で判定が変わった。列と表の両方を数える】**
      // **着手前は `current.role === "owner"`(列だけ)を見ていた。** **今日は実効ロール
      // 集合を見る** —— **付与表にだけ owner が在る人の列を降ろしても、実効集合からは
      // owner が消えないので通す。** **消えるときだけ、他に持ち主が居るかを数える。**
      const effective = this.effectiveRoles(userId);
      const nextHasOwner = role === "owner" || this.roleGrants(userId).includes("owner");
      // **【`V8-M30`。台帳 `T-G29`】2本目の「操作前」の人数**(1本目の判定式は無傷)。
      const grantersBefore = this.roleGrantersBefore();
      if (effective.includes("owner") && !nextHasOwner && this.countOwners() === 1) {
        throw new LastOwnerError();
      }
      this.db.query(`UPDATE "_auth_users" SET "role" = ? WHERE "id" = ?`).run(role, userId);
      // **【`V8-M30`】2本目の不変条件。`AND` にしない。**
      this.guardRoleGranters(grantersBefore);
      const updated = this.findUserById(userId);
      if (updated === undefined) {
        throw new Error(`ユーザ "${userId}" は存在しません。`);
      }
      return updated;
    });
    return tx();
  }

  /**
   * オーナー不変条件の自己修復: ユーザが1人以上いて owner が0人なら、最古
   * (created_at 昇順、同時刻は rowid 昇順 = 先に INSERT された側)を owner に昇格する。
   * ユーザが0人なら何もしない。
   * 書込を伴うので prepare() には置かず、register / role 変更 / サーバ起動時に明示呼び出しする。
   *
   * **【`V8-M16-T04` / `J-G3`】「owner が0人か」は {@link countOwners} が答える。**
   * **その数え方が列と表の両方を見るようになったので、**付与表にだけ owner が在る状態で
   * 最古を勝手に昇格させることが無くなった。** **昇格の書込先は今日どおり列である。**
   *
   * **【`V9-M11-T05` / `X-G37` / `ADR-0356`】第2キーを `id` から `rowid` へ変えた。**
   * **`id` は32バイトの暗号乱数(順序に意味が無い)なので、同じミリ秒に作られた2人のうち
   * どちらが昇格するかがコインフリップになっていた。** **`rowid` は挿入順なので、
   * 同じミリ秒の2人でも「先に INSERT された側」に一意に決まる。**
   * **第1キー(created_at の昇順)は1文字も変えていない。**
   * **【測っていないこと】同じミリ秒に3人以上入った場合・`VACUUM` を挟んだ場合は測っていない。**
   */
  ensureOwnerExists(): void {
    const tx = this.db.transaction((): void => {
      if (this.countUsers() === 0) {
        return;
      }
      if (this.countOwners() > 0) {
        return;
      }
      const oldest = this.db
        .query<{ id: string }, []>(
          `SELECT "id" FROM "_auth_users" ORDER BY "created_at" ASC, rowid ASC LIMIT 1`,
        )
        .get();
      if (oldest !== null) {
        this.db.query(`UPDATE "_auth_users" SET "role" = 'owner' WHERE "id" = ?`).run(oldest.id);
      }
    });
    tx();
  }

  /**
   * ユーザを1人消す(**退会**。`E-G68` / V4-M6)。**資格情報とセッションを道連れにする。**
   *
   * 消すのは `_auth_users` の1行と、それを `REFERENCES` している
   * `_auth_webauthn_credentials` / `_auth_password_credentials` / `_auth_sessions` の行である
   * (**外部キーの ON DELETE は宣言されていないので、明示的に消す**)。**1つのトランザクション
   * で行う** —— 途中で落ちて「ユーザは消えたのに資格情報が残る」状態を作らない。
   *
   * **最後の owner は消せない**({@link LastOwnerError})。`setUserRole` の降格ガードと同じ
   * 不変条件(owner が0人のアプリを作らない)を、退会経路にも当てる。
   *
   * **消さないもの(正直に書く)**:
   * - **監査記録(`_auth_activity`)は1行も消さない。** `username` を非正規化して持つのは
   *   「ユーザ削除後も追跡できるようにするため」であり(`types.ts` のコメント)、**消すと
   *   その設計意図が壊れる。**
   * - **そのユーザが作った業務データ(`st_owner` にその id を持つ行)は1行も消さない。**
   *   **結果として、その行は誰にも見えなくなる**(所有者 id に一致するユーザがもう居ない)——
   *   運営可視を宣言したテーブルだけは owner から読めるままである。**「個人情報が消えた」とは
   *   書けない。**
   */
  deleteUser(userId: string): void {
    const tx = this.db.transaction(() => {
      const user = this.db
        .query<{ role: string }, [string]>(`SELECT "role" FROM "_auth_users" WHERE "id" = ?`)
        .get(userId);
      if (user === null) {
        return;
      }
      // **【`V8-M16-T04` / `J-G3` で判定が変わった。列と表の両方を数える】**
      // **着手前は `user.role === "owner"`(列だけ)を見ていた。** **今日は実効ロール集合を
      // 見る** —— **付与表にだけ owner が在る人も「持ち主」である。**
      // **【`V8-M30`。台帳 `T-G29`】2本目の「操作前」の人数**(1本目の判定式は無傷)。
      const grantersBefore = this.roleGrantersBefore();
      if (this.effectiveRoles(userId).includes("owner") && this.countOwners() <= 1) {
        throw new LastOwnerError("最後の owner は退会できません。");
      }
      // **付与行を先に消す** —— `_auth_user_roles` は `_auth_users("id")` を参照しており、
      // `ON DELETE` は今日も宣言していない(既存3本と同じ作法)。
      this.db.query(`DELETE FROM "_auth_user_roles" WHERE "user_id" = ?`).run(userId);
      this.db.query(`DELETE FROM "_auth_sessions" WHERE "user_id" = ?`).run(userId);
      this.db.query(`DELETE FROM "_auth_webauthn_credentials" WHERE "user_id" = ?`).run(userId);
      this.db.query(`DELETE FROM "_auth_password_credentials" WHERE "user_id" = ?`).run(userId);
      this.db.query(`DELETE FROM "_auth_users" WHERE "id" = ?`).run(userId);
      // **【`V8-M30`。台帳 `T-G29`】2本目の不変条件。`AND` にしない。**
      // **投げるとこのトランザクションが丸ごと巻き戻るので、資格情報もセッションも戻る。**
      this.guardRoleGranters(grantersBefore);
    });
    tx();
  }

  // --- activity (監査) --------------------------------------------------------

  /** 監査ログを at 昇順で全件返す(テスト・管理用途)。 */
  listActivity(): ActivityRecord[] {
    return this.db
      .query<ActivityRow, []>(
        `SELECT "id", "user_id", "username", "action", "table_id", "record_id", "at", "changes"
         FROM "_auth_activity" ORDER BY "at" ASC, "id" ASC`,
      )
      .all()
      .map(toActivity);
  }

  /**
   * 監査ログを **at 降順(新しい順)** で1ページぶん返し、総件数を添える(`E-G59` / V4-M6)。
   *
   * **`listActivity`(昇順・全件)は1バイトも変えていない** —— 既存の呼び出し(テストと
   * バッチの検査)の並びが動くと、そちらの主張が黙って変わるためである。**運営が読む経路が
   * 欲しいのは「直前に何が起きたか」なので、新しい順で返す。**
   *
   * **ページングは DB 側の LIMIT / OFFSET で行う**(全件をメモリに載せない)。**総件数は
   * 同じ接続の `COUNT(*)` である** —— ページの外に何件あるかを運営が知れないと、
   * 「これで全部だ」と読み違える。
   */
  listActivityPage(options: { limit: number; offset: number }): {
    rows: ActivityRecord[];
    total: number;
  } {
    const counted = this.db
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "_auth_activity"`)
      .get();
    const total = counted?.n ?? 0;
    const rows = this.db
      .query<ActivityRow, [number, number]>(
        `SELECT "id", "user_id", "username", "action", "table_id", "record_id", "at", "changes"
         FROM "_auth_activity" ORDER BY "at" DESC, "id" DESC LIMIT ? OFFSET ?`,
      )
      .all(options.limit, options.offset)
      .map(toActivity);
    return { rows, total };
  }

  // --- webauthn credentials --------------------------------------------------

  /** WebAuthn クレデンシャルを追加する。公開鍵は base64url で保存する。 */
  addWebauthnCredential(input: AddWebauthnCredentialInput): WebAuthnCredentialRecord {
    const createdAt = nowIso();
    const transports = input.transports === undefined ? null : JSON.stringify(input.transports);
    const deviceType = input.deviceType ?? null;
    const backedUp = input.backedUp === undefined ? null : input.backedUp ? 1 : 0;
    this.db
      .query(
        `INSERT INTO "_auth_webauthn_credentials"
           ("id", "user_id", "public_key", "counter", "transports", "device_type",
            "backed_up", "created_at", "last_used_at")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        input.id,
        input.userId,
        toBase64Url(input.publicKey),
        input.counter,
        transports,
        deviceType,
        backedUp,
        createdAt,
      );
    const record: WebAuthnCredentialRecord = {
      id: input.id,
      userId: input.userId,
      publicKey: input.publicKey,
      counter: input.counter,
      createdAt,
    };
    if (input.transports !== undefined) {
      record.transports = input.transports;
    }
    if (input.deviceType !== undefined) {
      record.deviceType = input.deviceType;
    }
    if (input.backedUp !== undefined) {
      record.backedUp = input.backedUp;
    }
    return record;
  }

  /** ユーザの全クレデンシャルを取得する(excludeCredentials 生成などに使う)。 */
  getWebauthnCredentialsByUser(userId: string): WebAuthnCredentialRecord[] {
    return this.db
      .query<CredentialRow, [string]>(
        `SELECT "id", "user_id", "public_key", "counter", "transports", "device_type",
                "backed_up", "created_at", "last_used_at"
         FROM "_auth_webauthn_credentials" WHERE "user_id" = ? ORDER BY "created_at" ASC`,
      )
      .all(userId)
      .map(toCredential);
  }

  /** クレデンシャル ID で取得する。未登録なら undefined。 */
  getWebauthnCredentialById(id: string): WebAuthnCredentialRecord | undefined {
    const row = this.db
      .query<CredentialRow, [string]>(
        `SELECT "id", "user_id", "public_key", "counter", "transports", "device_type",
                "backed_up", "created_at", "last_used_at"
         FROM "_auth_webauthn_credentials" WHERE "id" = ?`,
      )
      .get(id);
    return row === null ? undefined : toCredential(row);
  }

  /** 認証成功時に署名カウンタを更新し、最終利用時刻を記録する。 */
  updateCredentialCounter(id: string, counter: number): void {
    this.db
      .query(
        `UPDATE "_auth_webauthn_credentials" SET "counter" = ?, "last_used_at" = ? WHERE "id" = ?`,
      )
      .run(counter, nowIso(), id);
  }

  // --- password credentials --------------------------------------------------

  /** パスワードハッシュを設定する(なければ作成、あれば更新)。 */
  setPassword(userId: string, passwordHash: string): void {
    this.db
      .query(
        `INSERT INTO "_auth_password_credentials" ("user_id", "password_hash", "updated_at")
         VALUES (?, ?, ?)
         ON CONFLICT("user_id") DO UPDATE SET
           "password_hash" = excluded."password_hash",
           "updated_at" = excluded."updated_at"`,
      )
      .run(userId, passwordHash, nowIso());
  }

  /** パスワードクレデンシャルを取得する。未設定なら undefined。 */
  getPassword(userId: string): PasswordCredential | undefined {
    const row = this.db
      .query<PasswordRow, [string]>(
        `SELECT "user_id", "password_hash", "updated_at"
         FROM "_auth_password_credentials" WHERE "user_id" = ?`,
      )
      .get(userId);
    return row === null
      ? undefined
      : { userId: row.user_id, passwordHash: row.password_hash, updatedAt: row.updated_at };
  }

  // --- sessions --------------------------------------------------------------

  /** セッションを新規発行する。`id` は必ず新しく生成される(セッション固定対策)。 */
  createSession(userId: string, ttlSec: number): Session {
    const now = new Date();
    const session: Session = {
      id: randomId(),
      userId,
      createdAt: now.toISOString(),
      expiresAt: expiresAtIso(ttlSec, now),
    };
    this.db
      .query(
        `INSERT INTO "_auth_sessions" ("id", "user_id", "created_at", "expires_at")
         VALUES (?, ?, ?, ?)`,
      )
      .run(session.id, session.userId, session.createdAt, session.expiresAt);
    return session;
  }

  /**
   * セッションを取得する。期限切れは無効扱い(undefined を返し、行を掃除する)。
   * 期限比較は ISO8601 UTC 文字列の辞書順で行う。
   */
  findSession(sessionId: string): Session | undefined {
    const row = this.db
      .query<SessionRow, [string]>(
        `SELECT "id", "user_id", "created_at", "expires_at" FROM "_auth_sessions" WHERE "id" = ?`,
      )
      .get(sessionId);
    if (row === null) {
      return undefined;
    }
    if (row.expires_at <= nowIso()) {
      this.deleteSession(sessionId);
      return undefined;
    }
    return {
      id: row.id,
      userId: row.user_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  /** セッションを失効させる(冪等)。 */
  deleteSession(sessionId: string): void {
    this.db.query(`DELETE FROM "_auth_sessions" WHERE "id" = ?`).run(sessionId);
  }

  /** ユーザの全セッションを失効させる(パスワード変更や全端末ログアウト用)。 */
  deleteSessionsByUser(userId: string): void {
    this.db.query(`DELETE FROM "_auth_sessions" WHERE "user_id" = ?`).run(userId);
  }

  // --- pending challenges ----------------------------------------------------

  /** チャレンジを保存する。`id` は不透明なランダムを発行する。 */
  savePendingChallenge(input: {
    challenge: string;
    purpose: ChallengePurpose;
    username?: string | null;
    ttlSec: number;
  }): PendingChallenge {
    const now = new Date();
    const pending: PendingChallenge = {
      id: randomId(),
      challenge: input.challenge,
      purpose: input.purpose,
      username: input.username ?? null,
      createdAt: now.toISOString(),
      expiresAt: expiresAtIso(input.ttlSec, now),
    };
    this.db
      .query(
        `INSERT INTO "_auth_pending_challenges"
           ("id", "challenge", "purpose", "username", "created_at", "expires_at")
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        pending.id,
        pending.challenge,
        pending.purpose,
        pending.username,
        pending.createdAt,
        pending.expiresAt,
      );
    return pending;
  }

  /**
   * チャレンジを取得すると同時に削除する(使い捨て=リプレイ防止)。
   * 期限切れかどうかの判定は呼び出し側(`consumeChallenge`)が行うが、
   * ここでは見つかった行を必ず削除する(2回目の取得は undefined になる)。
   */
  takePendingChallenge(id: string): PendingChallenge | undefined {
    const row = this.db
      .query<ChallengeRow, [string]>(
        `DELETE FROM "_auth_pending_challenges" WHERE "id" = ?
         RETURNING "id", "challenge", "purpose", "username", "created_at", "expires_at"`,
      )
      .get(id);
    if (row === null) {
      return undefined;
    }
    return {
      id: row.id,
      challenge: row.challenge,
      purpose: row.purpose as ChallengePurpose,
      username: row.username,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  // --- invitations(`_auth_*` の8本目。`V8-M2` / `I-G9`〜`I-G17` / `ADR-0336`)-------------
  //
  // **ここに在るのは保管だけである。** **引き換え(登録経路からの消費)は `V8-M3` が作る** ——
  // **`V8-M2` の完了時点で在るのは「使えない招待を出せる状態」である。**
  // **【禁止】この中間状態を「一時的だから問題ない」と書かない。**
  //
  // **【2026-08-14 訂正(`V8-M4-T03`。裁定 `M4-3`)。上の3行を1バイトも消していない】**
  // **今日は保管だけではない** —— **`V8-M3` が {@link consumeInvitationAndCreateUser}
  // を足し、登録経路がそこから招待を消費する。** **「`V8-M2` の完了時点で」という
  // 時点の限定は真のままだが、それを今日の状態として読んではならない。**
  //
  // **期限の判定をここに書いていない** —— **判定は `src/auth/challenge.ts` の `isExpired`
  // 1本だけが持つ**(`ADR-0336` 限定15。**綴りが2箇所に割れると片方だけが直る**)。
  // **述語は `src/auth/invitations.ts` の `findUsableInvitation` に在る。**

  /**
   * **招待を1件発行する**(`I-G9`)。**同じ相手に2度目を出すと、行を差し替える**
   * (`I-G12` の「出し直し」。**行を増やさない** = `ADR-0336` 限定18)。
   *
   * **期限は発行時に `INVITATION_TTL_SEC`(24時間)で確定させる固定値である**
   * (`ADR-0336` 限定14)。**呼び出し側から期限を受け取る引数を1つも置いていない。**
   *
   * **出し直しは使用時刻を空に戻す** —— **前の招待が使われていても、新しいコードは
   * 使える。** **【正直に書く】これは「1人が2度登録できる」ことを意味しない**(登録名は
   * `_auth_users.username` が UNIQUE である)が、**その判定はこの表の外に在る。**
   *
   * **【2026-09-18 追記(`V19-M2-T00`)。上の行を1バイトも消していない】**
   * **出し直しは取り消しの印も消す** —— **使用時刻を空に戻すので、取り消し済みの相手に
   * 出し直すと「取り消した」という事実がこの表から消える。** **扱いを1つに決めるのは
   * `V19-M2-T04` である**(`ADR-0452` §塞がないもの 2)。
   */
  issueInvitation(input: { username: string; role: Role; issuedBy: string }): Invitation {
    const now = new Date();
    const invitation: Invitation = {
      username: input.username,
      role: input.role,
      code: randomInvitationCode(),
      expiresAt: expiresAtIso(INVITATION_TTL_SEC, now),
      issuedBy: input.issuedBy,
      issuedAt: now.toISOString(),
      usedAt: null,
    };
    this.db
      .query(
        `INSERT INTO "_auth_invitations"
           ("username", "role", "code", "expires_at", "issued_by", "issued_at", "used_at")
         VALUES (?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT("username") DO UPDATE SET
           "role"       = excluded."role",
           "code"       = excluded."code",
           "expires_at" = excluded."expires_at",
           "issued_by"  = excluded."issued_by",
           "issued_at"  = excluded."issued_at",
           "used_at"    = NULL`,
      )
      .run(
        invitation.username,
        invitation.role,
        invitation.code,
        invitation.expiresAt,
        invitation.issuedBy,
        invitation.issuedAt,
      );
    return invitation;
  }

  /** その相手の招待1件(**期限切れ・使用済みでも返す**。判定は呼び出し側)。 */
  findInvitation(username: string): Invitation | undefined {
    const row = this.db
      .query<InvitationRow, [string]>(
        `SELECT "username", "role", "code", "expires_at", "issued_by", "issued_at", "used_at"
           FROM "_auth_invitations" WHERE "username" = ?`,
      )
      .get(username);
    return row === null ? undefined : toInvitation(row);
  }

  /**
   * **招待の全量**(発行順)。**使用済みの行も期限切れの行も落とさない** ——
   * **`I-G13`(運営者が読み取れる)と `I-G12`(取り消したことを確認できる)が、
   * 落とすと同時に成立しなくなる**(`ADR-0336` 限定16)。
   */
  listInvitations(): Invitation[] {
    return this.db
      .query<InvitationRow, []>(
        `SELECT "username", "role", "code", "expires_at", "issued_by", "issued_at", "used_at"
           FROM "_auth_invitations" ORDER BY "issued_at" ASC, "username" ASC`,
      )
      .all()
      .map(toInvitation);
  }

  /**
   * **その招待を使用済みにする**(`I-G16`)。**既に使用済みなら偽を返す**(冪等に落とす)。
   * **行を削除しない。**
   *
   * **【`V8-M3` への申し送り】** **この更新と「ユーザを作る挿入」は同一トランザクションに
   * 入れる必要がある**(`ADR-0336` 限定17)。**入っていないと、ユーザ作成が失敗したときに
   * 印だけが残って枠を1つ失うか、印を立てる前に2回目が通って枠が2回使える。**
   * **`V8-M2` はその境界を1度も測っていない。**
   *
   * **【2026-09-18 追記(`V19-M2-T00`)。上の行を1バイトも消していない】**
   * **この更新は取り消しにも使われる** —— **{@link revokeInvitation} が、素の時刻ではない
   * 値を `at` に渡して同じ列に書く。** **SQL は1バイトも変えていない**(`WHERE "used_at"
   * IS NULL` を保つので、既に印の在る行に2度目を書かない)。 **どちらの印であるかは値の
   * 形で分かれ、判定は `src/auth/invitations.ts` の1関数だけが行う。**
   */
  markInvitationUsed(username: string, at: string = nowIso()): boolean {
    const result = this.db
      .query(
        `UPDATE "_auth_invitations" SET "used_at" = ? WHERE "username" = ? AND "used_at" IS NULL`,
      )
      .run(at, username);
    return result.changes > 0;
  }

  /**
   * **招待に印を立てるのと、ユーザを作るのを、1つのトランザクションで行う**
   * (`V8-M3-T05`。台帳 `I-G20`。`ADR-0336` 限定17 の履行。`ADR-0337` 限定11)。
   *
   * **`AuthStore` に足したメソッドはこの1本だけである**(限定11)。
   *
   * **【入っていないと何が起きるか。`ADR-0337` §3-5 の逐語】**
   * **(a) ユーザ作成が失敗したときに印だけが残って枠を1つ失う、または
   * (b) 印を立てる前に2回目が通って枠が2回使える。**
   *
   * **印を先に立てる** —— **{@link markInvitationUsed} は
   * `WHERE "used_at" IS NULL` を持つので、2本目は `changes` が 0 になり
   * {@link InvitationUnavailableError} で落ちる。** **そのあとユーザ作成が落ちたら、
   * トランザクションが丸ごと巻き戻るので印も消える。**
   *
   * **【`createUser` の UNIQUE の扱いを1バイトも変えていない】** ——
   * **同じ例外がそのまま外へ出る**(`createUserSafely` の 409 の分岐は今日のまま)。
   *
   * **【測っていない】** **本当に同時の2本(別接続・別プロセス)で走らせていない。**
   * **SQLite の書込は直列化されるので理屈では両方は通らないが、それを実測した
   * 出力はこの実装には無い。**
   *
   * =====================================================================================
   * **【2026-08-14。`V8-M4-T02`。裁定 `M4-2`。旧文を1バイトも消していない】**
   * =====================================================================================
   *
   * **旧(逐語)**: `return tx();` —— **`bun:sqlite` の `transaction(fn)()` は
   * `BEGIN DEFERRED` である。** **`ADR-0337` §3-5 は「1つの `IMMEDIATE` トランザクション」
   * と書いたが、実物はそうなっていなかった**(`v8-m3.md` §7 の 10 が自認した)。
   *
   * **今日は `bun:sqlite` の `transaction()` が返す関数の `immediate` 版で走らせる**
   * (`BEGIN IMMEDIATE`)。 **【この doc に検査対象の綴りを書かない】** —— **書くと
   * `/usr/bin/grep -c` の期待値が1件ずれる**(`v8-m2.md` §8-1 の罠1 と同じ形)。
   * **根拠は `ADR-0018`(`M3-T06` の負荷試験)** —— **「deferred tx + read-then-CAS-update は
   * `busy_timeout` を無視して 500 になる。`IMMEDIATE` が実解」と実測で結論している。**
   * **招待の消費は「印を確かめて書く」形そのものであり、まさにこの罠に当たる。**
   *
   * **【`ADR-0337` の本文は1バイトも書き換えていない】** —— **直したのは実物の側である。**
   * **【測っていない】** **`IMMEDIATE` にしたことの効果を、同時の2本で1度も測っていない**
   * (下の「測っていない」と同じ範囲のままである)。
   *
   * @throws {InvitationUnavailableError} その招待に印を立てられなかった場合
   * @throws `createUser` が投げるもの(ログイン名の UNIQUE 違反など)
   */
  consumeInvitationAndCreateUser(
    invitationUsername: string,
    input: { username: string; displayName?: string | null; role?: Role },
  ): User {
    const tx = this.db.transaction((): User => {
      if (!this.markInvitationUsed(invitationUsername)) {
        throw new InvitationUnavailableError();
      }
      return this.createUser(input);
    });
    return tx.immediate();
  }

  /**
   * **招待を取り消す**(`I-G12`)。**行を消さず、{@link markInvitationUsed} と同じ列に
   * 時刻を入れる** —— **列が7つに閉じているので、取り消し専用の列は持てない。**
   * **【正直に書く】この表からは「使われた」と「取り消された」を区別できない。**
   *
   * **【禁止の履行】「取り消せるようになった」と単独で書かない** —— **取り消した招待は
   * `undo` で復活して再び使える**(24時間以内なら。実測は `undo-invitations.test.ts`)。
   *
   * **【2026-09-18 訂正(`V19-M2-T00`。単位 `SV-G5`)。上の行を1バイトも消していない】**
   * **上の「この表からは『使われた』と『取り消された』を区別できない」は今日は偽である。**
   * **取り消しは同じ列に**素の時刻ではない値**を書くので、値の形で2つが分かれる**
   * (`ADR-0452`)。 **導出は `src/auth/invitations.ts` の1関数だけが行う。**
   * **【正直に書く】列は今日も7列ちょうどであり、8列目を1本も足していない。**
   * **【正直に書く】この版より前に作られた行は区別できない** —— **素の時刻しか入って
   * おらず、「使用済み」と読む**(復元する材料がどこにも無い)。
   */
  revokeInvitation(username: string): Invitation | undefined {
    const existing = this.findInvitation(username);
    if (existing === undefined) {
      return undefined;
    }
    // **【`V19-M2-T00`】取り消しは素の時刻ではない値を書く**(`ADR-0452` 限定⑬)。
    // **{@link markInvitationUsed} の SQL は1バイトも変えていない**
    // (`WHERE "used_at" IS NULL` を保つ)。
    this.markInvitationUsed(username, `${INVITATION_REVOKED_PREFIX}${nowIso()}`);
    return this.findInvitation(username);
  }

  /**
   * **期限切れの招待を消す**(`I-G17`)。戻り値は削除件数。
   *
   * **呼ぶのはリクエストの中である**(`ADR-0336` 限定19。**5本目のスケジューラを足さない**)。
   * **【限界】掃除が走るのは「招待を発行したとき」だけであり、招待を1度も使わないアプリでは
   * この関数も {@link purgeExpired} も今日どおり0回である。**
   *
   * **使用済みでも期限内なら残る**(運営者が一覧で確認できる窓を、期限まで開けておく)。
   * **裏返すと、期限を過ぎた時点で「使われた」記録も消える** —— **`_auth_activity` にも
   * changelog にも残らないので、そこから先は追えない。**
   */
  purgeExpiredInvitations(): number {
    return this.db.query(`DELETE FROM "_auth_invitations" WHERE "expires_at" <= ?`).run(nowIso())
      .changes;
  }

  // --- maintenance -----------------------------------------------------------

  /** 期限切れの pending challenge と session を掃除する。戻り値は削除件数の合計。 */
  purgeExpired(): number {
    const now = nowIso();
    const pending = this.db
      .query(`DELETE FROM "_auth_pending_challenges" WHERE "expires_at" <= ?`)
      .run(now);
    const sessions = this.db.query(`DELETE FROM "_auth_sessions" WHERE "expires_at" <= ?`).run(now);
    return pending.changes + sessions.changes;
  }
}

// =====================================================================================
// **【`V8-M3-T05`】この宣言をファイルの**末尾**に置いた理由を書く**
// =====================================================================================
//
// **他の例外クラス(`LastOwnerError` / `LastGranterError`)は上部に在るのに、これだけが
// 末尾に在る。** **揃っていないのは意図である** —— **上部に置くと `randomId` より下・
// `createUser` より上の行番号がすべて動き、`web/e2e/access-control-servicedesk.e2e.ts` の
// `V7-M7-T05` が固定している逐語の行番号(`src/auth/store.ts` の `843` / `845`)が
// ずれて赤くなる。** **それを直すには `web/` に書く必要があり、`ADR-0337` 限定4
// (**`web/` に0バイト**)を破る。**
// **実際に1度上部へ置いて赤を見てから、ここへ移した。**
//
// **【正直に書く】これは「読みやすいから」ではなく「限定を破らないため」の配置である。**

/**
 * **取り消しの印**(`V19-M2-T00`。`ADR-0452` 限定⑬ / `records/v19-m0.md` の `T02-1-4` の 2)。
 *
 * **取り消しは `used_at` に「この印 + ISO8601 UTC」を書く。** **形は1つに固定する** ——
 * **2つ目の形を作ると、読む側が3通りを判定することになる。**
 * **使用は今日どおり素の ISO8601 を書く**(同 3。`markInvitationUsed` の SQL は不変)。
 *
 * **【なぜ `invitations.ts` ではなくここに在るのか】** **`ADR-0452` 限定⑬ は置き場を
 * 「`:845` より下」か「`src/auth/invitations.ts`」の2つに限っており、計画 §9-C の B6 が
 * 前者に決めた。** **依存の向きは `invitations.ts` → `store.ts` の一方通行で(今日すでに
 * 在る向き)、逆向きは 0件 である** —— **ここに置けば新しい循環が生まれない。**
 *
 * **【状態の導出はここでは行わない】** —— **導出は `src/auth/invitations.ts` の
 * `invitationState` 1本だけが行う**(限定⑨。**綴りを2箇所に割らない**)。
 *
 * **【この綴りを doc・コメント・テスト名に書き足さない】** —— **`ADR-0452` 限定⑩ の式が
 * この語を数えるので、説明文に書くと実装と無関係に値が動く**(計画 §9-C の B7)。
 * **訂正文では「素の時刻ではない値」と呼ぶ。**
 */
export const INVITATION_REVOKED_PREFIX = "revoked:";

/**
 * **その招待がもう使えないときに投げるエラー**(`V8-M3-T05`。台帳 `I-G20`。
 * [`ADR-0336`](../../docs/adr/0336-invitation-issuance-storage-redemption.md) 限定17 /
 * [`ADR-0337`](../../docs/adr/0337-invitation-redemption-path.md) 限定11)。
 *
 * **{@link AuthStore.consumeInvitationAndCreateUser} が、印を立てられなかった
 * (= 既に使用済み・取り消し済み・行が無い)ときだけ投げる。**
 *
 * **【これが投げられるのは競合したときだけである】** —— **順に叩くかぎり、登録経路は
 * その手前で招待を引けずに `403` を返す**(`src/server/auth-routes.ts` の畳んだ文面)。
 * **この例外が要るのは、同じコードで2本が同時に走ったときに**両方**が通らないように
 * するためである。** **【正直に書く】その競合を実際に走らせて測ってはいない** ——
 * **測ったのは「同じ接続から2回叩くと2回目が投げる」ことと、「ユーザ作成が落ちると
 * 印も巻き戻る」ことである。**
 */
export class InvitationUnavailableError extends Error {
  readonly code = "INVITATION_UNAVAILABLE";
  constructor(message = "その招待はもう使えません。") {
    super(message);
    this.name = "InvitationUnavailableError";
  }
}
