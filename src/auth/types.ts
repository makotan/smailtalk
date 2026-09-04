/**
 * 認証基盤(V1-M3-T01)のコア型定義。
 *
 * これらは**各アプリの `data/apps/<app_id>/app.sqlite` 内**の `_auth_*` 予約テーブル
 * (ADR-0014 v3・アプリ単位認証)に永続化される状態のアプリケーション表現である。DB の列は
 * `store.ts` が TEXT/INTEGER で持ち、ここではドメイン側の自然な型(公開鍵は Uint8Array、
 * 真偽は boolean)で表す。
 *
 * app.sqlite に同居するため、per-app の snapshot/undo で巻き戻る対象になる点に注意
 * (ADR-0014 v3 の受容事項)。
 */

/** WebAuthn オーセンティケータのトランスポート。SimpleWebAuthn の値をそのまま文字列で持つ。 */
export type WebAuthnTransport = string;

/** チャレンジの用途。パスキーの登録儀式と認証儀式を取り違えないための識別子。 */
export type ChallengePurpose = "registration" | "authentication";

/**
 * アプリ単位のロール(V1-M3-T02 / V2-M1-T01)。1ユーザ1ロール(per-app)。
 * - `owner`: 全操作 + ユーザ/ロール管理。
 * - `editor`: records の閲覧 + 書込。
 * - `viewer`: records の閲覧のみ(書込は 403)。
 * - `customer`: 顧客(EC-G2 / ADR-0033)。自己サインアップで割り当てられる第4のロール。
 *   自分の st_owner 行のみ読み書きし、運営テーブルは遮断する(可視性/書込認可は T03 で実装)。
 * 既定は `viewer`(self-register した新規ユーザ)。各アプリ初回ユーザは owner に昇格する。
 *
 * ロール値を足す/変えるときは3箇所(この型 / `store.ts` の CHECK / `auth-routes.ts` の
 * `ROLE_VALUES`)を必ず同期する。`role-vocabulary-sync.test.ts` が同期を機械的に固定する。
 * 5番目のロールを足すには門A の新規審査 + 個別 ADR が要る(ADR-0033 §3a)。
 *
 * ---
 *
 * ## **【`V5-M17-T03` / `G-G5` / `ADR-0158`】今日の正はここから下である**
 *
 * **上の段落を1バイトも書き換えていない**(当時の条文を読めるように残す作法)。
 * **食い違っているのは2点である。**
 *
 * 1. **値の集合は実装の定数ではなくなった。** **運営の3ロール(`owner` / `editor` /
 *    `viewer`)は今日も**予約語**で、実装が持つ**(`ADR-0158` 限定1)。**それ以外の値は
 *    アプリが宣言する**(`schemas/manifest.schema.json` の `$defs/app.user_kinds`)。
 *    **`customer` は「宣言が無いときの既定の1本目」であって、特別なロールではない**
 *    (限定3)。**宣言された種類の認可規則は `customer` と同一に固定されており、
 *    種類ごとに変えられない**(限定2)。
 * 2. **「3箇所の同期」の前提そのものが変わった。** **`role-vocabulary-sync.test.ts` は
 *    削除せず、「予約3ロールが3箇所で一致すること」と「実装が4値目を持たないこと」を
 *    測る形に置き換えた**(`ADR-0158` §1 (c) が「検査を置き換えなければ同期の歯止めが
 *    消える」と書いた点)。
 *
 * **【禁止。この言い方を実装コメントに書かない】** **「4ロール + 宣言」と書かない** ——
 * **`schemas/manifest.schema.json` の `$defs/view/properties/audience` は着手前から
 * **5値**であり(`ADR-0074` が `anonymous` を足した)、`ADR-0159` 限定2 の「既存4ロール」
 * という前提はその時点で実物と食い違っている**(前提の訂正は `ADR-0232`)。
 */
export type Role = ReservedRole | (string & {});

/**
 * **運営の予約ロール**(`ADR-0158` 限定1)。**アプリの宣言で再定義・削除・別名付けができない。**
 *
 * **この3つだけが実装の定数である。** **非運営の種類はアプリが宣言する。**
 */
export const RESERVED_ROLES = ["owner", "editor", "viewer"] as const;

/** 予約ロールの union。 */
export type ReservedRole = (typeof RESERVED_ROLES)[number];

/**
 * **宣言が無いときの非運営の種類**(`ADR-0158` 限定3 の「`customer` を既定の1本目として含む」)。
 *
 * **アプリが `user_kinds` を書かなければ、そのアプリの非運営の種類はこの1種だけである。**
 * **書いた場合は、書いた種類がそのアプリの非運営の種類である。**
 */
export const DEFAULT_USER_KIND = "customer";

/**
 * **その値が運営の予約ロールか。**
 *
 * **非運営の判定はこの関数の否定で行う** —— **`role === "customer"` という等値比較を
 * 実装に1件も残さない**(`ADR-0158` 限定2 =「宣言された種類の認可規則を `customer` と
 * 同一に固定する」を**構造で**満たすため。同 §1 (d) が「1箇所でも書き漏らすと運営データが
 * 非運営に開く」と挙げた不利な材料への答えでもある)。
 *
 * **この向きに閉じたのは fail-safe だからである** —— **知らない値が来たら、いちばん狭い側
 * (非運営)に落ちる。** **逆向き(「宣言された種類の一覧に載っているか」で非運営を判定する)
 * で書くと、宣言を読めなかったときに運営として扱われうる。**
 */
export function isReservedRole(role: string | null | undefined): role is ReservedRole {
  return role != null && (RESERVED_ROLES as readonly string[]).includes(role);
}

/**
 * **認証まわりの予約テーブルの接頭辞**(`V10-M28-T03`)。
 *
 * **`src/auth/store.ts` が `app.sqlite` の中に作る表は、すべてこの接頭辞で始まる**
 * (`src/auth/store.test.ts` の「作成されるテーブルはすべて `_auth_` プレフィックス」が
 * それを固定している)。**今日の実物は8本である。**
 *
 * **【なぜ接頭辞1つで、表名の一覧ではないのか】** —— **一覧を書くと、9本目が足された日に
 * 黙って漏れる。** **`_auth_*` の本数は 7 → 8 と実際に増えている**(`ADR-0336` 限定1)。
 * **接頭辞なら、増えた表も同じ側に落ちる。**
 *
 * **【同じ綴りを2箇所に置かない】** —— **この文字列リテラルを他所へ写さず、
 * 判定は必ず {@link isAuthTableName} を通すこと。**
 */
export const AUTH_TABLE_PREFIX = "_auth_";

/**
 * **その表名が認証まわりの予約テーブルか**(`V10-M28-T03`)。
 *
 * **判定の向きは「開く側に倒さない」である** —— **接頭辞に一致すれば認証まわりとして
 * 扱う。** **ユーザ定義のリソースIDは `_` 始まりにできない**(`src/kernel/resource-id.ts`)
 * ので、**アプリ自身の表がこの判定に巻き込まれることはない。**
 */
export function isAuthTableName(name: string): boolean {
  return name.startsWith(AUTH_TABLE_PREFIX);
}

/**
 * 監査対象の操作。HTTP データ経路のセッションユーザに紐づく。
 *
 * **【`V5-M25-T06` / ユーザ決定 `D-V5-83`】4値目 `manual_run` を足した(3 → 4)。**
 * **上の「records 書込」という説明は今日から不正確である** —— **4値目は records 書込では
 * なく「画面のボタンから自動処理を起こしたこと」である。**
 *
 * **`D-V5-83` の逐語**: 「**`L-G11b` の保留を覆さない** —— **変更履歴(`ADR-0072` 限定3 の
 * 5列)は1バイトも触らない。** **代わりに既存の監査記録の側に「誰が押したか」を残す。**
 * **したがって履歴画面には出ない**」。
 *
 * **【区別を丸めない】`manual_run` の行はレコードの書込ではない。**
 * **`table_id` / `record_id` は「押した行」であって、その行が書き換えられたわけではない。**
 * **`changes` は常に `null` である**(何が書かれたかは、自動処理が実際に書いた先と
 * 実行履歴の側にある)。**成否もこの行には1文字も入らない。**
 *
 * **【この拡張はどの門A審査も通っていない。隠さない】** **`V5-M20` の門A本審査は
 * `L-G11b`(押した人を記録に残す)を**保留**にし、`D-V5-83` はその保留を覆さずに
 * 置き場を変えるユーザ決定である。** **`ActivityAction` は `RESOURCE_KINDS` /
 * `FIELD_TYPES` / `DIFF_OPS` のどれでもないので `ADR-0007` の `Δ1` には当たらないが、
 * **値域が1つ増えたことは事実である**(記録に実数で書く)。
 */
export type ActivityAction = "create_record" | "update_record" | "delete_record" | "manual_run";

/**
 * 監査ログの「どの項目を何から何に変えたか」1件(`E-G53` / `D-V4-49` / V4-M6)。
 *
 * **`ADR-0015` の `_auth_activity` は着手前まで「誰がいつ・どのテーブルのどの行を」までしか
 * 持たず、変更内容を1つも持っていなかった。** ユーザ決定 `D-V4-49`(04 §1-5)は「引き直す。
 * **変更内容まで記録に残す**」と定めており、その粒度をここで表す。
 *
 * **値は「表示用に切り詰めた文字列」か `null` である**(生の値をそのまま持たない)——
 * 監査行が本文の写しになると、消したはずの長文が監査に残り続ける。
 */
export interface ActivityChange {
  /** 変わったフィールドの id。 */
  field: string;
  /** 変更前(切り詰め済み)。値が無かった場合は `null`。 */
  from: string | null;
  /** 変更後(切り詰め済み)。値を消した場合は `null`。 */
  to: string | null;
}

/**
 * 監査ログ1件(app.sqlite の `_auth_activity`)。records 書込のたびに
 * カーネル書込と同一トランザクションで記録される(undo で一緒に巻き戻る)。
 * `username` は非正規化して持つ(ユーザ削除後も追跡可能にするため)。
 */
export interface ActivityRecord {
  /** 不透明なランダム ID(base64url)。 */
  id: string;
  /** 実行ユーザの `User.id`。 */
  userId: string;
  /** 実行ユーザ名(非正規化)。 */
  username: string;
  action: ActivityAction;
  /** 対象テーブル ID。 */
  tableId: string;
  /** 対象レコード ID。create は生成後の id、対象が特定できない場合は null。 */
  recordId: string | null;
  /** ISO8601 UTC 文字列。 */
  at: string;
  /**
   * **その更新で実際に値が変わった項目**(`E-G53` / `D-V4-49`)。**更新以外は `null`。**
   *
   * **「全項目の差分」ではない** —— 送ったが値が同じだった項目は現れない。
   * **作成と削除にも持たせない**(作成は行そのものが記録に残り、削除は「何が消えたか」を
   * ここに写すと監査が本文の保管庫になる)。
   */
  changes: ActivityChange[] | null;
}

/**
 * ユーザ。`id` は不透明なランダム文字列(WebAuthn userID に使う)。
 * username/email をキーにしないのは、後から表示名や識別子を変えても
 * クレデンシャルの紐付けが壊れないようにするため(計画 §2)。
 */
export type User = {
  /** 不透明なランダム ID(base64url)。 */
  id: string;
  /** ログイン名。UNIQUE。 */
  username: string;
  /** 表示名。未設定なら null。 */
  displayName: string | null;
  /** アプリ単位のロール(V1-M3-T02)。既定 `viewer`。 */
  role: Role;
  /** ISO8601 UTC 文字列。 */
  createdAt: string;
};

/**
 * WebAuthn クレデンシャル1件。
 * `publicKey` はドメイン側では Uint8Array で扱い、DB には base64url で保存する
 * (`store.ts` が往復変換する)。`counter` はクローン検出(counter 後退検査)に使う。
 */
export type WebAuthnCredentialRecord = {
  /** クレデンシャル ID(base64url)。 */
  id: string;
  /** 所有ユーザの `User.id`。 */
  userId: string;
  /** 公開鍵(生バイト列)。保存時は base64url。 */
  publicKey: Uint8Array;
  /** 署名カウンタ。認証のたびに単調増加する(後退はクローンの疑い)。 */
  counter: number;
  /** 利用可能なトランスポート("internal" / "usb" など)。 */
  transports?: WebAuthnTransport[];
  /** 単一デバイス("singleDevice")か複数デバイス("multiDevice")か。 */
  deviceType?: string;
  /** マルチデバイスクレデンシャルがバックアップ済みか。 */
  backedUp?: boolean;
  /** ISO8601 UTC 文字列。 */
  createdAt: string;
  /** 最終利用時刻(ISO8601 UTC)。未使用なら未設定。 */
  lastUsedAt?: string;
};

/**
 * パスワードクレデンシャル。1ユーザにつき1件(user_id が PK)。
 * `passwordHash` は Bun.password(argon2id)のハッシュ文字列(平文は保持しない)。
 */
export type PasswordCredential = {
  userId: string;
  passwordHash: string;
  /** ISO8601 UTC 文字列。 */
  updatedAt: string;
};

/**
 * セッション。**認証済みのみ**が持つ(challenge は持たない。計画 §2/中4)。
 * `id` は不透明なランダム(256bit → base64url)で、HttpOnly cookie で往復する。
 */
export type Session = {
  id: string;
  userId: string;
  /** ISO8601 UTC 文字列。 */
  createdAt: string;
  /** ISO8601 UTC 文字列。これを過ぎたセッションは無効。 */
  expiresAt: string;
};

/**
 * **招待1件**(`V8-M2-T02` / 台帳 `I-G9`。`ADR-0336` §3-1)。
 *
 * **`_auth_*` の8本目(`_auth_invitations`)の1行に対応する。** **列は7つちょうどで、
 * 8列目を足すには門A の新規審査が要る**(`ADR-0336` §3a の 1)。
 *
 * **【`username` は `_auth_users.id` ではない】** —— **相手はまだ登録していないので、
 * 参照できる行が存在しない**(`ADR-0336` 限定4 が外部キーを禁じている理由と同じ)。
 * **ここに入るのは「その人がこれから名乗るログイン名」であり、`_auth_users.username` と
 * 同じ値域である。** **`_auth_*` の他の4本が持つ `user_id`(= `_auth_users.id` を指す)とは
 * 別物なので、綴りを分けてある。**
 *
 * **`code` は平文である**(`ADR-0336` §3-8。**ハッシュにしていない**)。
 * **`app.sqlite` を直接読める人は、そのアプリの未使用の招待コードを全部読める。**
 * **【禁止】これを「平文でも安全である」と書かない。**
 *
 * **app.sqlite に同居するため、per-app の snapshot/undo で巻き戻る**
 * (このファイル冒頭の受容事項がそのまま当たる。実測は `undo-invitations.test.ts`)。
 */
export type Invitation = {
  /** 招く相手のログイン名(**まだ登録していない**。主キー)。 */
  username: string;
  /** 与える役割(`app.roles[].id` の1語)。 */
  role: Role;
  /** 招待コード(**平文**。8文字・32字表)。 */
  code: string;
  /** ISO8601 UTC 文字列。発行時刻 + 24時間で固定(`D-V8-113`)。 */
  expiresAt: string;
  /** 発行した運営者の `User.id`。 */
  issuedBy: string;
  /** ISO8601 UTC 文字列。 */
  issuedAt: string;
  /**
   * **使用時刻**(ISO8601 UTC)。**未使用は `null`。**
   *
   * **1回きりは「行の削除」ではなく、この列で表す**(`ADR-0336` 限定16)。
   * **取り消し(`I-G12`)も同じ列に時刻を入れる** —— **列は7つに閉じているので、
   * 「使われた」と「取り消された」を区別する8列目は持てない。**
   */
  usedAt: string | null;
};

/**
 * 発行済みだが未消費のチャレンジ(パスキー儀式の途中状態)。
 * 短 TTL(既定5分)で、verify 時に即削除する使い捨て(リプレイ防止。計画 §3)。
 */
export type PendingChallenge = {
  id: string;
  /** base64url のチャレンジ文字列。 */
  challenge: string;
  purpose: ChallengePurpose;
  /** 登録儀式のときの対象ユーザ名(任意)。 */
  username: string | null;
  /** ISO8601 UTC 文字列。 */
  createdAt: string;
  /** ISO8601 UTC 文字列。これを過ぎたチャレンジは無効。 */
  expiresAt: string;
};
