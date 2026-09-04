/**
 * inbound capability(受信 endpoint)ストア(V2-M5-T01 / ADR-0041 §1・§3)。
 *
 * **capability-store.ts(送信 = connection)の鏡写しである。**
 * ADR-0041 の対称表: connection↔inbound endpoint / grant↔inbound grant /
 * fetch 直前の grant 検査↔書込直前の署名検査 / secret 非保管↔署名検証鍵非保管。
 *
 * **inbound endpoint は人間(owner)専用・AI 不可視である。**
 * MCP ツール / `apply_diff` 経路から**発行に**到達させてはならない(ADR-0041 限定1 = ADR-0020
 * §2b/§8c-3 の対称)。AI が到達できるのは `requestInboundEndpoint`(受信口の申請)までで、
 * 発行(`issueInboundEndpoint`)は人間 owner の専用経路(サーバ側 issuance)だけが行う。
 * 本 T01 ではこのストアをどの MCP ツールにも・どのサーバルートにも結線しない
 * (発行の HTTP 結線は後続 T02。request 側の MCP 結線は別途)。テスト関数からのみ呼ぶ。
 *
 * 置き場は `kernel.sqlite`(capability-store.ts と同じ。ADR-0041 限定5)。理由:
 * - AI 不可視・人間専用・**undo 非対象**・**マニフェストに現れない**の制約を既定で満たすのは
 *   kernel.sqlite だけ(undo は `app.sqlite` と `manifest.json` しか書き戻さない。ADR-0004)。
 * - meta-store.ts / capability-store.ts と同じ WAL DB を別ハンドルで開くため、PRAGMA を倣う。
 *   `CREATE TABLE IF NOT EXISTS` を足すだけで、既存の `apps` / `changelog` / `connections`
 *   テーブルには一切触れない。
 *
 * **署名検証鍵の本体を保存する列を作らない**(ADR-0041 限定4 = ADR-0020 §2d の対称)。
 * `secret_source_value` は取得元の参照(環境変数名 / コマンド行)であって、鍵の値ではない。
 * 値は use-time に `secret-resolver.ts` の `resolveSecret` で解決し、どこにも残さない。
 *
 * **inbound grant は endpoint が内包する**(ADR-0041 §1 の対称表・限定3)。connection が
 * `allowed_hosts` を内包するのと同型に、inbound endpoint は `target_table`(書込先テーブル1つ)
 * を内包する = 「この endpoint が指定テーブル1つへ書いてよい」付与を別テーブルにせず表現する
 * (最小形。新リソース種を足さない)。
 *
 * capability-store.ts に倣い:
 * - ドライバは Bun 組み込みの `bun:sqlite`(外部依存を足さない)
 * - 日時は ISO8601 UTC 文字列(`created_at`)で TEXT 保存
 * - SQL 識別子は常にダブルクォート、値は必ずプレースホルダでバインド
 * - 検出するのは呼び出し側のプログラミングエラーと I/O エラーなので例外で失敗させる
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import {
  DEFAULT_INBOUND_SIGNATURE_FORMAT,
  INBOUND_SIGNATURE_FORMATS,
  INBOUND_SIGNATURE_HEADER,
  INBOUND_SIGNATURE_HEADERS,
  type InboundSignatureFormat,
  type InboundSignatureHeader,
} from "./inbound-verify.ts";
import type { SecretSource } from "./secret-resolver.ts";
import { kernelDbPath } from "./storage-paths.ts";

/**
 * `IN ('a','b','c')` の中身を**値域の配列そのもの**から作る(`ADR-0160` 限定2 / 限定4)。
 * **綴りを SQL に2度書かない** —— 値域を1つ増やしたら CHECK 制約も自動で追随するので、
 * 「コードは3値・DB は2値」のような食い違いが構造的に起きない。
 */
function sqlEnum(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(",");
}

/**
 * inbound endpoint テーブル(connections の対称)。**署名検証鍵の本体の列は無い。**
 * `target_table` は書込先テーブル1つ(inbound grant を内包する。connections の allowed_hosts と同型)。
 * `secret_source_kind` / `secret_source_value` は取得元(参照)であって鍵値ではない。
 *
 * inbound_endpoint_requests は connection_requests の対称。**AI はこれを積むだけ**で、
 * 発行(inbound_endpoints への書き込み)には到達しない(発行は人間 owner の専用経路)。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS "inbound_endpoints" (
  "id"                  TEXT PRIMARY KEY,
  "app_id"              TEXT NOT NULL,
  "name"                TEXT NOT NULL,
  "secret_source_kind"  TEXT NOT NULL CHECK("secret_source_kind" IN ('env','command')),
  "secret_source_value" TEXT NOT NULL,
  "target_table"        TEXT NOT NULL,
  "created_at"          TEXT NOT NULL,
  "signature_header"    TEXT NOT NULL DEFAULT '${INBOUND_SIGNATURE_HEADER}'
                          CHECK("signature_header" IN (${sqlEnum(INBOUND_SIGNATURE_HEADERS)})),
  "signature_format"    TEXT NOT NULL DEFAULT '${DEFAULT_INBOUND_SIGNATURE_FORMAT}'
                          CHECK("signature_format" IN (${sqlEnum(INBOUND_SIGNATURE_FORMATS)})),
  UNIQUE ("app_id", "name")
);

CREATE INDEX IF NOT EXISTS "inbound_endpoints_app_id" ON "inbound_endpoints" ("app_id");

CREATE TABLE IF NOT EXISTS "inbound_endpoint_requests" (
  "id"                     TEXT PRIMARY KEY,
  "app_id"                 TEXT NOT NULL,
  "requested_name"         TEXT NOT NULL,
  "purpose"                TEXT NOT NULL,
  "suggested_target_table" TEXT NOT NULL,
  "status"                 TEXT NOT NULL CHECK("status" IN ('pending','approved','rejected')),
  "created_at"             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "inbound_endpoint_requests_app_status"
  ON "inbound_endpoint_requests" ("app_id", "status");
`;

/** inbound endpoint の1行(取得元の参照を含む。署名検証鍵の値は持たない)。 */
export interface InboundEndpoint {
  id: string;
  appId: string;
  name: string;
  /** 署名検証鍵の**取得元**(env|command)。鍵本体ではない(use-time に resolveSecret で解決)。 */
  secretSource: SecretSource;
  /** 書込先テーブル1つ(inbound grant を内包する。1行 create の宛先)。 */
  targetTable: string;
  createdAt: string;
  /**
   * **署名が載るヘッダの名前**(`V5-M15` / `G-G9` / `ADR-0160` 限定2。有限3値)。
   * **1本しか持てない** —— 複数ヘッダ・ヘッダの組み合わせ・クエリパラメータ・
   * body 内の署名フィールドを書く場所は1つも無い(限定1)。
   */
  signatureHeader: InboundSignatureHeader;
  /**
   * **署名の値の書き表し方**(`G-G10` / `ADR-0160` 限定4。有限3値)。
   * **アルゴリズムではない** —— HMAC-SHA256 の1種のままである(限定3)。
   */
  signatureFormat: InboundSignatureFormat;
}

/**
 * inbound endpoint 発行の入力。`id` / `createdAt` は内部生成する。
 * **署名の形は省略できる**(省略すると今日どおりの既定。`ADR-0160` 限定8)。
 */
export interface IssueInboundEndpointInput {
  appId: string;
  name: string;
  secretSource: SecretSource;
  targetTable: string;
  signatureHeader?: InboundSignatureHeader;
  signatureFormat?: InboundSignatureFormat;
}

type InboundEndpointRow = {
  id: string;
  app_id: string;
  name: string;
  secret_source_kind: string;
  secret_source_value: string;
  target_table: string;
  created_at: string;
  signature_header: string;
  signature_format: string;
};

/**
 * 受信口の**申請**(connection_requests の対称。ADR-0041 限定1)。
 *
 * **AI が到達できるのはここまでである。**AI(MCP `request_inbound_endpoint`)は申請
 * (`status="pending"`)を作れるだけで、**発行(inbound_endpoints への書き込み)には到達しない**
 * (発行は owner の HTTP 操作だけが行う)。`suggestedTargetTable` は AI の提案であり、
 * owner は承認時にこれを別テーブルに変えても・上書きしてもよい。**署名検証鍵はここに持たない**
 * (取得元は承認・発行時に人間が指定する)。
 */
export interface InboundEndpointRequest {
  id: string;
  appId: string;
  requestedName: string;
  purpose: string;
  suggestedTargetTable: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
}

/** 申請作成の入力。`id` / `createdAt` / `status`("pending")は内部生成する。 */
export interface RequestInboundEndpointInput {
  appId: string;
  requestedName: string;
  purpose: string;
  suggestedTargetTable: string;
}

type InboundEndpointRequestRow = {
  id: string;
  app_id: string;
  requested_name: string;
  purpose: string;
  suggested_target_table: string;
  status: string;
  created_at: string;
};

/** ISO8601 UTC(ミリ秒つき)の現在時刻。 */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * **`V5-M15` より前に作られた `kernel.sqlite` を移行する**(`ADR-0160` 限定8)。
 *
 * `CREATE TABLE IF NOT EXISTS` は既に在るテーブルに列を足さないので、**既存の受信口を持つ
 * データベースでは2列が欠けたままになる。** 欠けている列だけを `ALTER TABLE ADD COLUMN` で
 * 足す —— **既定値つき・CHECK 制約つきで足すので、新規作成した DB と定義が一致する**
 * (「新しい DB は3値に縛られるが古い DB は何でも入る」という食い違いを作らない)。
 *
 * **既に在る行は既定値(今日どおりの形)になる** —— **1つも壊れない・1つも挙動が変わらない。**
 */
function migrateSignatureShapeColumns(db: Database): void {
  const columns = new Set(
    db
      .query<{ name: string }, []>(`PRAGMA table_info("inbound_endpoints")`)
      .all()
      .map((c) => c.name),
  );
  if (!columns.has("signature_header")) {
    db.exec(
      `ALTER TABLE "inbound_endpoints" ADD COLUMN "signature_header" TEXT NOT NULL ` +
        `DEFAULT '${INBOUND_SIGNATURE_HEADER}' ` +
        `CHECK("signature_header" IN (${sqlEnum(INBOUND_SIGNATURE_HEADERS)}))`,
    );
  }
  if (!columns.has("signature_format")) {
    db.exec(
      `ALTER TABLE "inbound_endpoints" ADD COLUMN "signature_format" TEXT NOT NULL ` +
        `DEFAULT '${DEFAULT_INBOUND_SIGNATURE_FORMAT}' ` +
        `CHECK("signature_format" IN (${sqlEnum(INBOUND_SIGNATURE_FORMATS)}))`,
    );
  }
}

/**
 * 発行・更新の入力に書かれた署名の形を値域に照らす(`ADR-0160` 限定2 / 限定4)。
 *
 * **DB の CHECK 制約より手前で弾く** —— 弾かれた発行・更新が**1行も書かない**ことを
 * 呼び出し側から確かめられるようにするためである(CHECK だけに任せると、
 * 「どちらの列が悪いのか」がエラー文から読み取れない)。
 */
function checkSignatureShape(input: {
  signatureHeader?: InboundSignatureHeader;
  signatureFormat?: InboundSignatureFormat;
}): { signatureHeader: InboundSignatureHeader; signatureFormat: InboundSignatureFormat } {
  const header = input.signatureHeader ?? INBOUND_SIGNATURE_HEADER;
  const format = input.signatureFormat ?? DEFAULT_INBOUND_SIGNATURE_FORMAT;
  if (!INBOUND_SIGNATURE_HEADERS.some((h) => h === header)) {
    throw new Error(
      `inbound_endpoints.signature_header に "${header}" は指定できません。` +
        `許可される値: ${INBOUND_SIGNATURE_HEADERS.join(" / ")}(自由文字列は書けません)。`,
    );
  }
  if (!INBOUND_SIGNATURE_FORMATS.some((f) => f === format)) {
    throw new Error(
      `inbound_endpoints.signature_format に "${format}" は指定できません。` +
        `許可される値: ${INBOUND_SIGNATURE_FORMATS.join(" / ")}` +
        `(署名アルゴリズムは HMAC-SHA256 の1種だけで、選べません)。`,
    );
  }
  return { signatureHeader: header, signatureFormat: format };
}

/** DB 行 → InboundEndpoint。secretSource は kind/value 2列から復元する。 */
function toInboundEndpoint(row: InboundEndpointRow): InboundEndpoint {
  return {
    id: row.id,
    appId: row.app_id,
    name: row.name,
    secretSource: toSecretSource(row.secret_source_kind, row.secret_source_value),
    targetTable: row.target_table,
    createdAt: row.created_at,
    signatureHeader: toSignatureHeader(row.signature_header),
    signatureFormat: toSignatureFormat(row.signature_format),
  };
}

/**
 * DB の `signature_header` 列を値域へ写す(`ADR-0160` 限定2)。
 * **CHECK 制約と二重に守る** —— DB を外から書き換えられた場合に黙って握り潰さず例外にする
 * (`toSecretSource` の作法に倣う)。
 */
function toSignatureHeader(value: string): InboundSignatureHeader {
  const found = INBOUND_SIGNATURE_HEADERS.find((h) => h === value);
  if (found === undefined) {
    throw new Error(
      `inbound_endpoints.signature_header に未知の値 "${value}" が入っています。` +
        `許可される値: ${INBOUND_SIGNATURE_HEADERS.join(" / ")}。`,
    );
  }
  return found;
}

/** DB の `signature_format` 列を値域へ写す(`ADR-0160` 限定4)。上と同じ理由で例外にする。 */
function toSignatureFormat(value: string): InboundSignatureFormat {
  const found = INBOUND_SIGNATURE_FORMATS.find((f) => f === value);
  if (found === undefined) {
    throw new Error(
      `inbound_endpoints.signature_format に未知の値 "${value}" が入っています。` +
        `許可される値: ${INBOUND_SIGNATURE_FORMATS.join(" / ")}。`,
    );
  }
  return found;
}

/** DB 行 → InboundEndpointRequest。status は CHECK 制約が守る。 */
function toInboundEndpointRequest(row: InboundEndpointRequestRow): InboundEndpointRequest {
  return {
    id: row.id,
    appId: row.app_id,
    requestedName: row.requested_name,
    purpose: row.purpose,
    suggestedTargetTable: row.suggested_target_table,
    status: toRequestStatus(row.status),
    createdAt: row.created_at,
  };
}

/** DB の status 列を InboundEndpointRequest の status へ写す(CHECK 制約外の値は例外)。 */
function toRequestStatus(status: string): InboundEndpointRequest["status"] {
  if (status === "pending" || status === "approved" || status === "rejected") {
    return status;
  }
  throw new Error(`inbound_endpoint_requests.status に未知の値 "${status}" が入っています。`);
}

/**
 * DB の kind 列を SecretSource へ写す。値域は CHECK 制約で 'env' / 'command' に限られるが、
 * 万一 DB を外から書き換えられた場合に黙って握り潰さず例外にする(capability-store の作法に倣う)。
 */
function toSecretSource(kind: string, value: string): SecretSource {
  if (kind === "env" || kind === "command") {
    return { kind, value };
  }
  throw new Error(
    `inbound_endpoints.secret_source_kind に未知の値 "${kind}" が入っています。許可される値: env / command。`,
  );
}

/**
 * inbound capability(受信 endpoint)ストア。開く DB(kernel.sqlite)は必ず `dataRoot` 引数で
 * 受け取る(環境変数・ハードコードに依存しない)。テストは一時ディレクトリを渡してリポジトリの
 * `data/` を汚さずに動かせる。
 */
export class InboundStore {
  private readonly db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  /**
   * `<dataRoot>/kernel.sqlite` を開き(なければ作る)、inbound テーブルを用意する。
   * meta-store.ts / capability-store.ts と同じ WAL DB を別ハンドルで開くため、PRAGMA を倣う。
   * `CREATE TABLE IF NOT EXISTS` なので既存の apps / changelog / connections テーブルには触れない。
   */
  static openForKernel(dataRoot: string): InboundStore {
    mkdirSync(dataRoot, { recursive: true });
    const db = new Database(kernelDbPath(dataRoot), { create: true });
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
    migrateSignatureShapeColumns(db);
    return new InboundStore(db);
  }

  /** DB を閉じる。以後の操作はエラーになる。 */
  close(): void {
    this.db.close();
  }

  // --- inbound endpoint の発行(人間 owner 専用。ADR-0041 限定1)------------------
  //
  // **AI 経路(requestInboundEndpoint)からはここに到達しない。**発行は owner の
  // HTTP 操作だけが呼ぶ(本 T01 ではどのルートにも結線しない = テストからのみ呼ぶ)。

  /**
   * inbound endpoint を発行する。`id`(uuid)と `createdAt`(ISO8601)は内部生成する。
   * **署名検証鍵の本体は保存しない**(`secretSource` は取得元の参照)。
   * `targetTable` は書込先テーブル1つ(inbound grant を内包する。ADR-0041 限定3)。
   * @throws 同一 app 内で `name` が重複する場合(UNIQUE 違反)
   */
  issueInboundEndpoint(input: IssueInboundEndpointInput): InboundEndpoint {
    // **値域の外は1行も書く前に弾く**(ADR-0160 限定2 / 限定4)。
    const shape = checkSignatureShape(input);
    const endpoint: InboundEndpoint = {
      id: crypto.randomUUID(),
      appId: input.appId,
      name: input.name,
      secretSource: input.secretSource,
      targetTable: input.targetTable,
      createdAt: nowIso(),
      signatureHeader: shape.signatureHeader,
      signatureFormat: shape.signatureFormat,
    };
    try {
      this.db
        .query(
          `INSERT INTO "inbound_endpoints"
             ("id", "app_id", "name",
              "secret_source_kind", "secret_source_value", "target_table", "created_at",
              "signature_header", "signature_format")
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          endpoint.id,
          endpoint.appId,
          endpoint.name,
          endpoint.secretSource.kind,
          endpoint.secretSource.value,
          endpoint.targetTable,
          endpoint.createdAt,
          endpoint.signatureHeader,
          endpoint.signatureFormat,
        );
    } catch (error) {
      if (error instanceof Error && /UNIQUE/i.test(error.message)) {
        throw new Error(
          `app "${input.appId}" に inbound endpoint 名 "${input.name}" は既に存在します。`,
        );
      }
      throw error;
    }
    return endpoint;
  }

  /** id で inbound endpoint を取得する。未登録なら undefined。返り値に鍵本体は含まない。 */
  getInboundEndpoint(id: string): InboundEndpoint | undefined {
    const row = this.db
      .query<InboundEndpointRow, [string]>(
        `SELECT "id", "app_id", "name",
                "secret_source_kind", "secret_source_value", "target_table", "created_at",
                "signature_header", "signature_format"
         FROM "inbound_endpoints" WHERE "id" = ?`,
      )
      .get(id);
    return row === null ? undefined : toInboundEndpoint(row);
  }

  /** 指定アプリの inbound endpoint を created_at 昇順(同時刻は id 昇順)で返す。 */
  listInboundEndpoints(appId: string): InboundEndpoint[] {
    return this.db
      .query<InboundEndpointRow, [string]>(
        `SELECT "id", "app_id", "name",
                "secret_source_kind", "secret_source_value", "target_table", "created_at",
                "signature_header", "signature_format"
         FROM "inbound_endpoints" WHERE "app_id" = ?
         ORDER BY "created_at" ASC, "id" ASC`,
      )
      .all(appId)
      .map(toInboundEndpoint);
  }

  /**
   * 発行済みの受信口の**署名の形**(ヘッダ名 / 値の形式)を差し替える(`ADR-0160` 限定6)。
   *
   * **これは人間 owner の更新の口である。** `issueInboundEndpoint` と同じく、
   * **MCP / `apply_diff` からはここに1本も結線されていない**(`ADR-0041` 限定1 を1ミリも
   * 緩めない)。AI 経路が届くのは `requestInboundEndpoint`(申請)までで、
   * 申請の入力に署名の形を書く場所は1つも無い。
   *
   * **値域の外は1バイトも書かずに例外にする**(限定2 / 限定4)。存在しない id は何もしない(冪等)。
   *
   * **これは部分更新ではなく差し替えである** —— **省略した側は既定に戻る**(2列を常に両方書く)。
   */
  updateInboundEndpointSignature(
    id: string,
    input: {
      signatureHeader?: InboundSignatureHeader;
      signatureFormat?: InboundSignatureFormat;
    },
  ): void {
    const shape = checkSignatureShape(input);
    this.db
      .query(
        `UPDATE "inbound_endpoints"
            SET "signature_header" = ?, "signature_format" = ?
          WHERE "id" = ?`,
      )
      .run(shape.signatureHeader, shape.signatureFormat, id);
  }

  /** inbound endpoint を失効(削除)する(冪等)。人間 owner の操作。 */
  deleteInboundEndpoint(id: string): void {
    this.db.query(`DELETE FROM "inbound_endpoints" WHERE "id" = ?`).run(id);
  }

  // --- 受信口の申請(AI 経路。ADR-0041 限定1)------------------------------------
  //
  // **AI が到達できる上限がこの4メソッドである。**申請は作れる(requestInboundEndpoint)が、
  // 発行(issueInboundEndpoint)には**別経路(owner の HTTP)からしか**到達しない。
  // markInboundEndpointRequest は承認/却下の記録であって、それ自体は発行しない —— 発行は
  // owner ルートが issueInboundEndpoint で行い、そのついでに mark(id,"approved") する。

  /**
   * 受信口の申請を作成する(`status="pending"`)。`id`(uuid)/ `createdAt`(ISO8601)は内部生成。
   * **署名検証鍵は受け取らない**(取得元は承認・発行時に人間が指定する)。
   */
  requestInboundEndpoint(input: RequestInboundEndpointInput): InboundEndpointRequest {
    const request: InboundEndpointRequest = {
      id: crypto.randomUUID(),
      appId: input.appId,
      requestedName: input.requestedName,
      purpose: input.purpose,
      suggestedTargetTable: input.suggestedTargetTable,
      status: "pending",
      createdAt: nowIso(),
    };
    this.db
      .query(
        `INSERT INTO "inbound_endpoint_requests"
           ("id", "app_id", "requested_name", "purpose", "suggested_target_table", "status", "created_at")
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.id,
        request.appId,
        request.requestedName,
        request.purpose,
        request.suggestedTargetTable,
        request.status,
        request.createdAt,
      );
    return request;
  }

  /** 指定アプリの**未承認**(status="pending")の申請を created_at 昇順(同時刻は id 昇順)で返す。 */
  listPendingInboundEndpointRequests(appId: string): InboundEndpointRequest[] {
    return this.db
      .query<InboundEndpointRequestRow, [string]>(
        `SELECT "id", "app_id", "requested_name", "purpose", "suggested_target_table", "status", "created_at"
         FROM "inbound_endpoint_requests" WHERE "app_id" = ? AND "status" = 'pending'
         ORDER BY "created_at" ASC, "id" ASC`,
      )
      .all(appId)
      .map(toInboundEndpointRequest);
  }

  /** id で申請を取得する。未登録なら undefined。 */
  getInboundEndpointRequest(id: string): InboundEndpointRequest | undefined {
    const row = this.db
      .query<InboundEndpointRequestRow, [string]>(
        `SELECT "id", "app_id", "requested_name", "purpose", "suggested_target_table", "status", "created_at"
         FROM "inbound_endpoint_requests" WHERE "id" = ?`,
      )
      .get(id);
    return row === null ? undefined : toInboundEndpointRequest(row);
  }

  /** 申請の status を承認/却下に更新する(冪等)。owner の審査経路。 */
  markInboundEndpointRequest(id: string, status: "approved" | "rejected"): void {
    this.db
      .query(`UPDATE "inbound_endpoint_requests" SET "status" = ? WHERE "id" = ?`)
      .run(status, id);
  }
}
