/**
 * capability(connection)ストア(V1-M4-T02 / ADR-0020 §2c・§2d・§2e)。
 *
 * **connection は人間(owner)専用・AI 不可視である。**
 * MCP ツール / `apply_diff` 経路から到達させてはならない(ADR-0020 §2b/§8c-3)。
 * 本 T02 ではこのストアをどの MCP ツールにも・どのサーバルートにも結線しない
 * (T04 で owner 専用 UI から使う)。テスト関数とストア自身からのみ呼ぶ。
 *
 * 置き場は `kernel.sqlite`(ADR-0020 §2c の (b))。理由:
 * - AI 不可視・人間専用・**undo 非対象**の3制約を既定で満たすのは kernel.sqlite だけ
 *   (undo は `app.sqlite` と `manifest.json` しか書き戻さない。ADR-0004)。
 * - meta-store.ts と同じ WAL DB を別ハンドルで開くため、PRAGMA(WAL / foreign_keys)を
 *   meta-store.ts に倣って設定する。`CREATE TABLE IF NOT EXISTS connections` を足すだけで、
 *   既存の `apps` / `changelog` テーブルには一切触れない。
 *
 * **secret 本体を保存する列を作らない**(§2d)。`secret_source_value` は取得元の参照
 * (環境変数名 / コマンド行)であって、secret の値ではない。値は use-time に
 * `secret-resolver.ts` の `resolveSecret` で解決し、どこにも残さない。
 *
 * meta-store.ts / auth/store.ts に倣い:
 * - ドライバは Bun 組み込みの `bun:sqlite`(外部依存を足さない)
 * - 日時は ISO8601 UTC 文字列(`created_at`)で TEXT 保存
 * - SQL 識別子は常にダブルクォート、値は必ずプレースホルダでバインド
 * - 検出するのは呼び出し側のプログラミングエラーと I/O エラーなので例外で失敗させる
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import type { SecretSource } from "./secret-resolver.ts";
import { kernelDbPath } from "./storage-paths.ts";

/**
 * connection テーブル。**secret 本体の列は無い。**
 * `allowed_hosts` は宛先ホストのホワイトリスト(JSON 配列文字列。既定 "[]" = 何も許可しない)。
 * `secret_source_kind` / `secret_source_value` は取得元(参照)であって secret 値ではない。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS "connections" (
  "id"                  TEXT PRIMARY KEY,
  "app_id"              TEXT NOT NULL,
  "name"                TEXT NOT NULL,
  "allowed_hosts"       TEXT NOT NULL,
  "secret_source_kind"  TEXT NOT NULL CHECK("secret_source_kind" IN ('env','command')),
  "secret_source_value" TEXT NOT NULL,
  "created_at"          TEXT NOT NULL,
  UNIQUE ("app_id", "name")
);

CREATE INDEX IF NOT EXISTS "connections_app_id" ON "connections" ("app_id");

CREATE TABLE IF NOT EXISTS "outbox" (
  "id"             TEXT PRIMARY KEY,
  "app_id"         TEXT NOT NULL,
  "connection_id"  TEXT NOT NULL,
  "destination"    TEXT NOT NULL,
  "payload"        TEXT NOT NULL,
  "status"         TEXT NOT NULL CHECK("status" IN ('pending','sent','failed')),
  "created_at"     TEXT NOT NULL,
  "dispatched_at"  TEXT,
  "error"          TEXT
);

CREATE INDEX IF NOT EXISTS "outbox_status_created_at" ON "outbox" ("status", "created_at");

CREATE TABLE IF NOT EXISTS "connection_requests" (
  "id"             TEXT PRIMARY KEY,
  "app_id"         TEXT NOT NULL,
  "requested_name" TEXT NOT NULL,
  "purpose"        TEXT NOT NULL,
  "suggested_hosts" TEXT NOT NULL,
  "status"         TEXT NOT NULL CHECK("status" IN ('pending','approved','rejected')),
  "created_at"     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "connection_requests_app_status"
  ON "connection_requests" ("app_id", "status");
`;

/** connection の1行(取得元の参照を含む。secret 値は持たない)。 */
export interface Connection {
  id: string;
  appId: string;
  name: string;
  allowedHosts: string[];
  secretSource: SecretSource;
  createdAt: string;
}

/** connection 作成の入力。`id` / `createdAt` は内部生成する。 */
export interface CreateConnectionInput {
  appId: string;
  name: string;
  allowedHosts: string[];
  secretSource: SecretSource;
}

type ConnectionRow = {
  id: string;
  app_id: string;
  name: string;
  allowed_hosts: string;
  secret_source_kind: string;
  secret_source_value: string;
  created_at: string;
};

/**
 * アウトボックス(配送キュー)の1行(V1-M4-T03 / ADR-0020 §3 改訂2)。
 *
 * **secret を持たない。**`payload` は解決済み(`$record` 解決後・secret を含まない)、
 * `destination` は送信先 URL、`connectionId` は use-time に secret を解決するための参照。
 * `error` には secret を絶対に入れない(§8c-6)。
 */
export interface OutboxItem {
  id: string;
  appId: string;
  connectionId: string;
  destination: string;
  payload: Record<string, unknown>;
  status: "pending" | "sent" | "failed";
  createdAt: string;
  dispatchedAt: string | null;
  error: string | null;
}

/** outbox への積み込み入力。`id` / `createdAt` / `status` は内部生成する。 */
export interface EnqueueOutboxInput {
  appId: string;
  connectionId: string;
  destination: string;
  payload: Record<string, unknown>;
}

type OutboxRow = {
  id: string;
  app_id: string;
  connection_id: string;
  destination: string;
  payload: string;
  status: string;
  created_at: string;
  dispatched_at: string | null;
  error: string | null;
};

/**
 * 接続の**申請**(V1-M4-T04 / ADR-0020 §2b・§5)。
 *
 * **AI が到達できるのはここまでである。**AI(MCP `request_connection`)は申請
 * (`status="pending"`)を作れるだけで、**発行(connections への書き込み)には到達しない**
 * (§8c-3。発行は owner の HTTP 操作だけが行う)。`suggested_hosts` は AI の提案であり、
 * owner は承認時にこれを狭めても・上書きしてもよい。**secret はここに持たない**
 * (取得元は承認時に人間が指定する。§2d)。
 */
export interface ConnectionRequest {
  id: string;
  appId: string;
  requestedName: string;
  purpose: string;
  suggestedHosts: string[];
  status: "pending" | "approved" | "rejected";
  createdAt: string;
}

/** 申請作成の入力。`id` / `createdAt` / `status`("pending")は内部生成する。 */
export interface CreateRequestInput {
  appId: string;
  requestedName: string;
  purpose: string;
  suggestedHosts: string[];
}

type ConnectionRequestRow = {
  id: string;
  app_id: string;
  requested_name: string;
  purpose: string;
  suggested_hosts: string;
  status: string;
  created_at: string;
};

/** ISO8601 UTC(ミリ秒つき)の現在時刻。 */
function nowIso(): string {
  return new Date().toISOString();
}

/** DB 行 → OutboxItem。payload は JSON、status は文字列域を CHECK 制約が守る。 */
function toOutboxItem(row: OutboxRow): OutboxItem {
  return {
    id: row.id,
    appId: row.app_id,
    connectionId: row.connection_id,
    destination: row.destination,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    status: toOutboxStatus(row.status),
    createdAt: row.created_at,
    dispatchedAt: row.dispatched_at,
    error: row.error,
  };
}

/** DB の status 列を OutboxItem の status へ写す(CHECK 制約外の値は例外)。 */
function toOutboxStatus(status: string): OutboxItem["status"] {
  if (status === "pending" || status === "sent" || status === "failed") {
    return status;
  }
  throw new Error(`outbox.status に未知の値 "${status}" が入っています。`);
}

/** DB 行 → Connection。allowed_hosts は JSON、secretSource は kind/value 2列から復元する。 */
function toConnection(row: ConnectionRow): Connection {
  return {
    id: row.id,
    appId: row.app_id,
    name: row.name,
    allowedHosts: JSON.parse(row.allowed_hosts) as string[],
    secretSource: toSecretSource(row.secret_source_kind, row.secret_source_value),
    createdAt: row.created_at,
  };
}

/** DB 行 → ConnectionRequest。suggested_hosts は JSON、status は CHECK 制約が守る。 */
function toConnectionRequest(row: ConnectionRequestRow): ConnectionRequest {
  return {
    id: row.id,
    appId: row.app_id,
    requestedName: row.requested_name,
    purpose: row.purpose,
    suggestedHosts: JSON.parse(row.suggested_hosts) as string[],
    status: toRequestStatus(row.status),
    createdAt: row.created_at,
  };
}

/** DB の status 列を ConnectionRequest の status へ写す(CHECK 制約外の値は例外)。 */
function toRequestStatus(status: string): ConnectionRequest["status"] {
  if (status === "pending" || status === "approved" || status === "rejected") {
    return status;
  }
  throw new Error(`connection_requests.status に未知の値 "${status}" が入っています。`);
}

/**
 * DB の kind 列を SecretSource へ写す。値域は CHECK 制約で 'env' / 'command' に限られるが、
 * 万一 DB を外から書き換えられた場合に黙って握り潰さず例外にする(meta-store の作法に倣う)。
 */
function toSecretSource(kind: string, value: string): SecretSource {
  if (kind === "env" || kind === "command") {
    return { kind, value };
  }
  throw new Error(
    `connections.secret_source_kind に未知の値 "${kind}" が入っています。許可される値: env / command。`,
  );
}

/**
 * capability(connection)ストア。開く DB(kernel.sqlite)は必ず `dataRoot` 引数で受け取る
 * (環境変数・ハードコードに依存しない)。テストは一時ディレクトリを渡してリポジトリの
 * `data/` を汚さずに動かせる。
 */
export class CapabilityStore {
  private readonly db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  /**
   * `<dataRoot>/kernel.sqlite` を開き(なければ作る)、`connections` を用意する。
   * meta-store.ts と同じ WAL DB を別ハンドルで開くため、PRAGMA を meta-store に倣う。
   * `CREATE TABLE IF NOT EXISTS` なので既存の apps / changelog テーブルには触れない。
   */
  static openForKernel(dataRoot: string): CapabilityStore {
    mkdirSync(dataRoot, { recursive: true });
    const db = new Database(kernelDbPath(dataRoot), { create: true });
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
    return new CapabilityStore(db);
  }

  /** DB を閉じる。以後の操作はエラーになる。 */
  close(): void {
    this.db.close();
  }

  /**
   * connection を作成する。`id`(uuid)と `createdAt`(ISO8601)は内部生成する。
   * **secret 本体は保存しない**(`secretSource` は取得元の参照)。
   * @throws 同一 app 内で `name` が重複する場合(UNIQUE 違反)
   */
  createConnection(input: CreateConnectionInput): Connection {
    const connection: Connection = {
      id: crypto.randomUUID(),
      appId: input.appId,
      name: input.name,
      allowedHosts: input.allowedHosts,
      secretSource: input.secretSource,
      createdAt: nowIso(),
    };
    try {
      this.db
        .query(
          `INSERT INTO "connections"
             ("id", "app_id", "name", "allowed_hosts",
              "secret_source_kind", "secret_source_value", "created_at")
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          connection.id,
          connection.appId,
          connection.name,
          JSON.stringify(connection.allowedHosts),
          connection.secretSource.kind,
          connection.secretSource.value,
          connection.createdAt,
        );
    } catch (error) {
      if (error instanceof Error && /UNIQUE/i.test(error.message)) {
        throw new Error(`app "${input.appId}" に connection 名 "${input.name}" は既に存在します。`);
      }
      throw error;
    }
    return connection;
  }

  /** id で connection を取得する。未登録なら undefined。 */
  getConnection(id: string): Connection | undefined {
    const row = this.db
      .query<ConnectionRow, [string]>(
        `SELECT "id", "app_id", "name", "allowed_hosts",
                "secret_source_kind", "secret_source_value", "created_at"
         FROM "connections" WHERE "id" = ?`,
      )
      .get(id);
    return row === null ? undefined : toConnection(row);
  }

  /** 指定アプリの connection を created_at 昇順(同時刻は id 昇順)で返す。 */
  listConnections(appId: string): Connection[] {
    return this.db
      .query<ConnectionRow, [string]>(
        `SELECT "id", "app_id", "name", "allowed_hosts",
                "secret_source_kind", "secret_source_value", "created_at"
         FROM "connections" WHERE "app_id" = ?
         ORDER BY "created_at" ASC, "id" ASC`,
      )
      .all(appId)
      .map(toConnection);
  }

  /**
   * app スコープ内で connection を**人間可読名**で引く(V1-M4-T03)。
   * ワークフローの `call_external` は connection を ID ではなく名前で参照するため。
   * 未登録なら undefined。
   */
  findConnectionByName(appId: string, name: string): Connection | undefined {
    const row = this.db
      .query<ConnectionRow, [string, string]>(
        `SELECT "id", "app_id", "name", "allowed_hosts",
                "secret_source_kind", "secret_source_value", "created_at"
         FROM "connections" WHERE "app_id" = ? AND "name" = ?`,
      )
      .get(appId, name);
    return row === null ? undefined : toConnection(row);
  }

  /** connection を削除する(冪等)。 */
  deleteConnection(id: string): void {
    this.db.query(`DELETE FROM "connections" WHERE "id" = ?`).run(id);
  }

  /**
   * 送信内容(宛先 + 解決済み payload + connection の参照)を outbox に積む(V1-M4-T03)。
   * `id`(uuid)/ `createdAt`(ISO8601)/ `status="pending"` は内部生成する。
   * **secret は載せない**(payload は解決済みで secret を含まない。dispatch 時に use-time 解決)。
   */
  enqueueOutbox(input: EnqueueOutboxInput): OutboxItem {
    const item: OutboxItem = {
      id: crypto.randomUUID(),
      appId: input.appId,
      connectionId: input.connectionId,
      destination: input.destination,
      payload: input.payload,
      status: "pending",
      createdAt: nowIso(),
      dispatchedAt: null,
      error: null,
    };
    this.db
      .query(
        `INSERT INTO "outbox"
           ("id", "app_id", "connection_id", "destination", "payload",
            "status", "created_at", "dispatched_at", "error")
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        item.id,
        item.appId,
        item.connectionId,
        item.destination,
        JSON.stringify(item.payload),
        item.status,
        item.createdAt,
      );
    return item;
  }

  /** 未送信(status="pending")の outbox を created_at 昇順(同時刻は id 昇順)で返す。 */
  listPendingOutbox(): OutboxItem[] {
    return this.db
      .query<OutboxRow, []>(
        `SELECT "id", "app_id", "connection_id", "destination", "payload",
                "status", "created_at", "dispatched_at", "error"
         FROM "outbox" WHERE "status" = 'pending'
         ORDER BY "created_at" ASC, "id" ASC`,
      )
      .all()
      .map(toOutboxItem);
  }

  /**
   * outbox の1件を配送結果で更新する(V1-M4-T03)。
   * `dispatched_at` を now に設定する。**`error` は failed のときだけ入れる**
   * (sent のときは NULL のまま。誤って secret を入れないよう呼び出し側の責務でもある)。
   */
  markOutbox(id: string, status: "sent" | "failed", error?: string): void {
    this.db
      .query(
        `UPDATE "outbox"
         SET "status" = ?, "dispatched_at" = ?, "error" = ?
         WHERE "id" = ?`,
      )
      .run(status, nowIso(), status === "failed" ? (error ?? null) : null, id);
  }

  // --- 接続の申請(V1-M4-T04 / ADR-0020 §2b・§5)-------------------------------
  //
  // **AI が到達できる上限がこの4メソッドである。**申請は作れる(createRequest)が、
  // 発行(createConnection)には**別経路(owner の HTTP)からしか**到達しない(§8c-3)。
  // markRequest は承認/却下の記録であって、それ自体は発行しない —— 発行は
  // owner ルートが createConnection で行い、そのついでに markRequest(id,"approved") する。

  /**
   * 接続の申請を作成する(`status="pending"`)。`id`(uuid)/ `createdAt`(ISO8601)は内部生成。
   * **secret は受け取らない**(取得元は承認時に人間が指定する。§2d)。
   */
  createRequest(input: CreateRequestInput): ConnectionRequest {
    const request: ConnectionRequest = {
      id: crypto.randomUUID(),
      appId: input.appId,
      requestedName: input.requestedName,
      purpose: input.purpose,
      suggestedHosts: input.suggestedHosts,
      status: "pending",
      createdAt: nowIso(),
    };
    this.db
      .query(
        `INSERT INTO "connection_requests"
           ("id", "app_id", "requested_name", "purpose", "suggested_hosts", "status", "created_at")
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.id,
        request.appId,
        request.requestedName,
        request.purpose,
        JSON.stringify(request.suggestedHosts),
        request.status,
        request.createdAt,
      );
    return request;
  }

  /** 指定アプリの**未承認**(status="pending")の申請を created_at 昇順(同時刻は id 昇順)で返す。 */
  listPendingRequests(appId: string): ConnectionRequest[] {
    return this.db
      .query<ConnectionRequestRow, [string]>(
        `SELECT "id", "app_id", "requested_name", "purpose", "suggested_hosts", "status", "created_at"
         FROM "connection_requests" WHERE "app_id" = ? AND "status" = 'pending'
         ORDER BY "created_at" ASC, "id" ASC`,
      )
      .all(appId)
      .map(toConnectionRequest);
  }

  /** id で申請を取得する。未登録なら undefined。 */
  getRequest(id: string): ConnectionRequest | undefined {
    const row = this.db
      .query<ConnectionRequestRow, [string]>(
        `SELECT "id", "app_id", "requested_name", "purpose", "suggested_hosts", "status", "created_at"
         FROM "connection_requests" WHERE "id" = ?`,
      )
      .get(id);
    return row === null ? undefined : toConnectionRequest(row);
  }

  /** 申請の status を承認/却下に更新する(冪等)。 */
  markRequest(id: string, status: "approved" | "rejected"): void {
    this.db.query(`UPDATE "connection_requests" SET "status" = ? WHERE "id" = ?`).run(status, id);
  }
}
