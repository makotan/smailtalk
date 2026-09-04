/**
 * AI capability ストア(V1-M5-T02 / ADR-0021 §2・§4・§5)。
 *
 * **`capability-store.ts`(接続)の兄弟である。** kernel.sqlite に置き、AI 不可視・
 * 人間(owner)専用・**undo 非対象**の3制約を既定で満たす(undo は app.sqlite と
 * manifest.json しか書き戻さない。ADR-0004)。MCP ツール / `apply_diff` 経路から
 * 発行・上限変更に到達させてはならない(ADR-0021 §2b / §8c-3)—— AI は
 * `request_ai_capability` で申請(pending)まで。
 *
 * 4つの内部テーブルを持つ(いずれも `_apps` / `_changelog` のような投影ではない。
 * ただし `ai_usage` だけは §4 で read-only 投影 `_ai_usage` に写す。ADR-0021 §8c-9):
 * - `ai_capabilities` … 発行済みの AI capability(プロバイダ・モデル・**日次上限**)。
 * - `ai_jobs`         … 実行層が積んだ AI 呼び出しジョブ(outbox の兄弟。非同期配送)。
 * - `ai_usage`        … 全 AI 呼び出しの記録(メータリングの真実源。§4)。
 * - `ai_requests`     … AI が出した接続の申請(pending。§2b。AI が到達できる上限)。
 *
 * **secret 本体は保存しない**(§2d)。`openai_compatible` の API キーは
 * `secret_source_kind` / `secret_source_value`(取得元の参照)だけを持ち、値は
 * `dispatchAiJobs` が use-time に `resolveSecret` で解決する。`claude_cli` は secret を
 * 持たない(CLI 自身の認証を使う)。
 *
 * `capability-store.ts` に倣い、ドライバは `bun:sqlite`、日時は ISO8601 UTC(TEXT)、
 * SQL 識別子は常にダブルクォート・値は必ずプレースホルダでバインドする。
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import type { SecretSource } from "./secret-resolver.ts";
import { kernelDbPath } from "./storage-paths.ts";

/** サポートする AI プロバイダ(ADR-0021 §2a)。既定は `claude_cli`。 */
export type AiProviderKind = "claude_cli" | "openai_compatible";

/** AI capability の日次上限(ADR-0021 §5。発行時必須。既定 = 発行しない = 呼べない)。 */
export interface AiLimit {
  /** 1日あたりの最大呼び出し回数(success + failure。blocked は数えない)。 */
  maxCallsPerDay: number;
  /** 1日あたりの最大推定コスト(USD)。 */
  maxCostUsdPerDay: number;
}

/**
 * AI capability の1行。**secret 本体は持たない**(secretSource は取得元の参照)。
 * `secretSource` / `baseUrl` は `openai_compatible` のときだけ意味を持つ。
 */
export interface AiCapability {
  id: string;
  appId: string;
  name: string;
  provider: AiProviderKind;
  model: string;
  baseUrl: string | null;
  secretSource: SecretSource | null;
  limit: AiLimit;
  createdAt: string;
}

/** AI capability 作成の入力。`id` / `createdAt` は内部生成する。 */
export interface CreateAiCapabilityInput {
  appId: string;
  name: string;
  provider: AiProviderKind;
  model: string;
  baseUrl?: string | null;
  secretSource?: SecretSource | null;
  limit: AiLimit;
}

type AiCapabilityRow = {
  id: string;
  app_id: string;
  name: string;
  provider: string;
  model: string;
  base_url: string | null;
  secret_source_kind: string | null;
  secret_source_value: string | null;
  max_calls_per_day: number;
  max_cost_usd_per_day: number;
  created_at: string;
};

/**
 * AI 呼び出しジョブの1行(outbox の兄弟。ADR-0021 §3)。
 *
 * **secret を持たない。**`capabilityId` が use-time 解決のための参照である。
 * `prompt` / `input` は解決済み(`$record` 解決後)。`targetTable` / `targetRecordId` /
 * `outputField` が書き戻し先(§3c)。`chainDepth` が連鎖増幅の停止に使う(§5)。
 */
export interface AiJob {
  id: string;
  appId: string;
  capabilityId: string;
  workflowId: string;
  actor: string | null;
  prompt: string;
  input: Record<string, unknown>;
  outputField: string;
  fallback: string;
  targetTable: string;
  targetRecordId: string;
  chainDepth: number;
  status: "pending" | "done" | "failed" | "blocked";
  createdAt: string;
  dispatchedAt: string | null;
  error: string | null;
  resultValue: string | null;
}

/** ジョブ積み込みの入力。`id` / `createdAt` / `status="pending"` は内部生成する。 */
export interface EnqueueAiJobInput {
  appId: string;
  capabilityId: string;
  workflowId: string;
  actor: string | null;
  prompt: string;
  input: Record<string, unknown>;
  outputField: string;
  fallback: string;
  targetTable: string;
  targetRecordId: string;
  chainDepth: number;
}

type AiJobRow = {
  id: string;
  app_id: string;
  capability_id: string;
  workflow_id: string;
  actor: string | null;
  prompt: string;
  input: string;
  output_field: string;
  fallback: string;
  target_table: string;
  target_record_id: string;
  chain_depth: number;
  status: string;
  created_at: string;
  dispatched_at: string | null;
  error: string | null;
  result_value: string | null;
};

/** AI 呼び出しの記録(メータリングの真実源。§4)。1行 = 1呼び出し。 */
export interface AiUsage {
  id: string;
  appId: string;
  capabilityId: string;
  workflowId: string;
  actor: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  status: "success" | "failure" | "blocked";
  usageDate: string;
  calledAt: string;
}

/** 使用量記録の入力。`id` は内部生成する。 */
export interface RecordAiUsageInput {
  appId: string;
  capabilityId: string;
  workflowId: string;
  actor: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  status: "success" | "failure" | "blocked";
  usageDate: string;
  calledAt: string;
}

type AiUsageRow = {
  id: string;
  app_id: string;
  capability_id: string;
  workflow_id: string;
  actor: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  status: string;
  usage_date: string;
  called_at: string;
};

/** 当日の使用量合計(上限判定の入力。§5)。blocked は数えない。 */
export interface AiUsageTotals {
  calls: number;
  costUsd: number;
}

/** AI capability の**申請**(AI が到達できる上限。§2b)。 */
export interface AiRequest {
  id: string;
  appId: string;
  requestedName: string;
  purpose: string;
  suggestedProvider: string | null;
  suggestedModel: string | null;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
}

/** 申請作成の入力。`id` / `createdAt` / `status="pending"` は内部生成する。 */
export interface CreateAiRequestInput {
  appId: string;
  requestedName: string;
  purpose: string;
  suggestedProvider?: string | null;
  suggestedModel?: string | null;
}

type AiRequestRow = {
  id: string;
  app_id: string;
  requested_name: string;
  purpose: string;
  suggested_provider: string | null;
  suggested_model: string | null;
  status: string;
  created_at: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS "ai_capabilities" (
  "id"                   TEXT PRIMARY KEY,
  "app_id"               TEXT NOT NULL,
  "name"                 TEXT NOT NULL,
  "provider"             TEXT NOT NULL CHECK("provider" IN ('claude_cli','openai_compatible')),
  "model"                TEXT NOT NULL,
  "base_url"             TEXT,
  "secret_source_kind"   TEXT CHECK("secret_source_kind" IN ('env','command')),
  "secret_source_value"  TEXT,
  "max_calls_per_day"    INTEGER NOT NULL,
  "max_cost_usd_per_day" REAL NOT NULL,
  "created_at"           TEXT NOT NULL,
  UNIQUE ("app_id", "name")
);

CREATE INDEX IF NOT EXISTS "ai_capabilities_app_id" ON "ai_capabilities" ("app_id");

CREATE TABLE IF NOT EXISTS "ai_jobs" (
  "id"                TEXT PRIMARY KEY,
  "app_id"            TEXT NOT NULL,
  "capability_id"     TEXT NOT NULL,
  "workflow_id"       TEXT NOT NULL,
  "actor"             TEXT,
  "prompt"            TEXT NOT NULL,
  "input"             TEXT NOT NULL,
  "output_field"      TEXT NOT NULL,
  "fallback"          TEXT NOT NULL,
  "target_table"      TEXT NOT NULL,
  "target_record_id"  TEXT NOT NULL,
  "chain_depth"       INTEGER NOT NULL,
  "status"            TEXT NOT NULL CHECK("status" IN ('pending','done','failed','blocked')),
  "created_at"        TEXT NOT NULL,
  "dispatched_at"     TEXT,
  "error"             TEXT,
  "result_value"      TEXT
);

CREATE INDEX IF NOT EXISTS "ai_jobs_status_created_at" ON "ai_jobs" ("status", "created_at");

CREATE TABLE IF NOT EXISTS "ai_usage" (
  "id"             TEXT PRIMARY KEY,
  "app_id"         TEXT NOT NULL,
  "capability_id"  TEXT NOT NULL,
  "workflow_id"    TEXT NOT NULL,
  "actor"          TEXT,
  "model"          TEXT NOT NULL,
  "input_tokens"   INTEGER NOT NULL,
  "output_tokens"  INTEGER NOT NULL,
  "cost_usd"       REAL NOT NULL,
  "status"         TEXT NOT NULL CHECK("status" IN ('success','failure','blocked')),
  "usage_date"     TEXT NOT NULL,
  "called_at"      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "ai_usage_app_date" ON "ai_usage" ("app_id", "usage_date");
CREATE INDEX IF NOT EXISTS "ai_usage_cap_date" ON "ai_usage" ("capability_id", "usage_date");

CREATE TABLE IF NOT EXISTS "ai_requests" (
  "id"                 TEXT PRIMARY KEY,
  "app_id"             TEXT NOT NULL,
  "requested_name"     TEXT NOT NULL,
  "purpose"            TEXT NOT NULL,
  "suggested_provider" TEXT,
  "suggested_model"    TEXT,
  "status"             TEXT NOT NULL CHECK("status" IN ('pending','approved','rejected')),
  "created_at"         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "ai_requests_app_status" ON "ai_requests" ("app_id", "status");
`;

/** ISO8601 UTC(ミリ秒つき)の現在時刻。 */
function nowIso(): string {
  return new Date().toISOString();
}

function toProvider(value: string): AiProviderKind {
  if (value === "claude_cli" || value === "openai_compatible") {
    return value;
  }
  throw new Error(`ai_capabilities.provider に未知の値 "${value}" が入っています。`);
}

function toSecretSource(kind: string | null, value: string | null): SecretSource | null {
  if (kind === null) {
    return null;
  }
  if ((kind === "env" || kind === "command") && value !== null) {
    return { kind, value };
  }
  throw new Error(`ai_capabilities.secret_source_kind に未知の値 "${kind}" が入っています。`);
}

function toCapability(row: AiCapabilityRow): AiCapability {
  return {
    id: row.id,
    appId: row.app_id,
    name: row.name,
    provider: toProvider(row.provider),
    model: row.model,
    baseUrl: row.base_url,
    secretSource: toSecretSource(row.secret_source_kind, row.secret_source_value),
    limit: {
      maxCallsPerDay: row.max_calls_per_day,
      maxCostUsdPerDay: row.max_cost_usd_per_day,
    },
    createdAt: row.created_at,
  };
}

function toJobStatus(status: string): AiJob["status"] {
  if (status === "pending" || status === "done" || status === "failed" || status === "blocked") {
    return status;
  }
  throw new Error(`ai_jobs.status に未知の値 "${status}" が入っています。`);
}

function toJob(row: AiJobRow): AiJob {
  return {
    id: row.id,
    appId: row.app_id,
    capabilityId: row.capability_id,
    workflowId: row.workflow_id,
    actor: row.actor,
    prompt: row.prompt,
    input: JSON.parse(row.input) as Record<string, unknown>,
    outputField: row.output_field,
    fallback: row.fallback,
    targetTable: row.target_table,
    targetRecordId: row.target_record_id,
    chainDepth: row.chain_depth,
    status: toJobStatus(row.status),
    createdAt: row.created_at,
    dispatchedAt: row.dispatched_at,
    error: row.error,
    resultValue: row.result_value,
  };
}

function toUsageStatus(status: string): AiUsage["status"] {
  if (status === "success" || status === "failure" || status === "blocked") {
    return status;
  }
  throw new Error(`ai_usage.status に未知の値 "${status}" が入っています。`);
}

function toUsage(row: AiUsageRow): AiUsage {
  return {
    id: row.id,
    appId: row.app_id,
    capabilityId: row.capability_id,
    workflowId: row.workflow_id,
    actor: row.actor,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    status: toUsageStatus(row.status),
    usageDate: row.usage_date,
    calledAt: row.called_at,
  };
}

function toRequestStatus(status: string): AiRequest["status"] {
  if (status === "pending" || status === "approved" || status === "rejected") {
    return status;
  }
  throw new Error(`ai_requests.status に未知の値 "${status}" が入っています。`);
}

function toRequest(row: AiRequestRow): AiRequest {
  return {
    id: row.id,
    appId: row.app_id,
    requestedName: row.requested_name,
    purpose: row.purpose,
    suggestedProvider: row.suggested_provider,
    suggestedModel: row.suggested_model,
    status: toRequestStatus(row.status),
    createdAt: row.created_at,
  };
}

/**
 * AI capability ストア。開く DB(kernel.sqlite)は必ず `dataRoot` 引数で受け取る。
 * `capability-store.ts` と同じ WAL DB を別ハンドルで開く(PRAGMA を揃える)。
 */
export class AiCapabilityStore {
  private readonly db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  static openForKernel(dataRoot: string): AiCapabilityStore {
    mkdirSync(dataRoot, { recursive: true });
    const db = new Database(kernelDbPath(dataRoot), { create: true });
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
    return new AiCapabilityStore(db);
  }

  close(): void {
    this.db.close();
  }

  // --- capability(発行は owner のみ。ADR-0021 §2b)-----------------------------

  createCapability(input: CreateAiCapabilityInput): AiCapability {
    const capability: AiCapability = {
      id: crypto.randomUUID(),
      appId: input.appId,
      name: input.name,
      provider: input.provider,
      model: input.model,
      baseUrl: input.baseUrl ?? null,
      secretSource: input.secretSource ?? null,
      limit: input.limit,
      createdAt: nowIso(),
    };
    try {
      this.db
        .query(
          `INSERT INTO "ai_capabilities"
             ("id", "app_id", "name", "provider", "model", "base_url",
              "secret_source_kind", "secret_source_value",
              "max_calls_per_day", "max_cost_usd_per_day", "created_at")
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          capability.id,
          capability.appId,
          capability.name,
          capability.provider,
          capability.model,
          capability.baseUrl,
          capability.secretSource?.kind ?? null,
          capability.secretSource?.value ?? null,
          capability.limit.maxCallsPerDay,
          capability.limit.maxCostUsdPerDay,
          capability.createdAt,
        );
    } catch (error) {
      if (error instanceof Error && /UNIQUE/i.test(error.message)) {
        throw new Error(
          `app "${input.appId}" に AI capability 名 "${input.name}" は既に存在します。`,
        );
      }
      throw error;
    }
    return capability;
  }

  getCapability(id: string): AiCapability | undefined {
    const row = this.db
      .query<AiCapabilityRow, [string]>(`SELECT * FROM "ai_capabilities" WHERE "id" = ?`)
      .get(id);
    return row === null ? undefined : toCapability(row);
  }

  /** app スコープ内で capability を**人間可読名**で引く(ai_transform が名前で参照する)。 */
  findCapabilityByName(appId: string, name: string): AiCapability | undefined {
    const row = this.db
      .query<AiCapabilityRow, [string, string]>(
        `SELECT * FROM "ai_capabilities" WHERE "app_id" = ? AND "name" = ?`,
      )
      .get(appId, name);
    return row === null ? undefined : toCapability(row);
  }

  listCapabilities(appId: string): AiCapability[] {
    return this.db
      .query<AiCapabilityRow, [string]>(
        `SELECT * FROM "ai_capabilities" WHERE "app_id" = ?
         ORDER BY "created_at" ASC, "id" ASC`,
      )
      .all(appId)
      .map(toCapability);
  }

  /**
   * 上限を変更する(owner のみ。ADR-0021 §5「上限は人間のみ変更可能」)。
   * この経路は auth-routes(HTTP)からしか呼ばれない —— MCP / apply_diff には結線しない。
   */
  updateCapabilityLimit(id: string, limit: AiLimit): void {
    this.db
      .query(
        `UPDATE "ai_capabilities"
         SET "max_calls_per_day" = ?, "max_cost_usd_per_day" = ?
         WHERE "id" = ?`,
      )
      .run(limit.maxCallsPerDay, limit.maxCostUsdPerDay, id);
  }

  deleteCapability(id: string): void {
    this.db.query(`DELETE FROM "ai_capabilities" WHERE "id" = ?`).run(id);
  }

  // --- ジョブ(実行層が積む。非同期配送。ADR-0021 §3)---------------------------

  enqueueJob(input: EnqueueAiJobInput): AiJob {
    const job: AiJob = {
      id: crypto.randomUUID(),
      appId: input.appId,
      capabilityId: input.capabilityId,
      workflowId: input.workflowId,
      actor: input.actor,
      prompt: input.prompt,
      input: input.input,
      outputField: input.outputField,
      fallback: input.fallback,
      targetTable: input.targetTable,
      targetRecordId: input.targetRecordId,
      chainDepth: input.chainDepth,
      status: "pending",
      createdAt: nowIso(),
      dispatchedAt: null,
      error: null,
      resultValue: null,
    };
    this.db
      .query(
        `INSERT INTO "ai_jobs"
           ("id", "app_id", "capability_id", "workflow_id", "actor", "prompt", "input",
            "output_field", "fallback", "target_table", "target_record_id", "chain_depth",
            "status", "created_at", "dispatched_at", "error", "result_value")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      )
      .run(
        job.id,
        job.appId,
        job.capabilityId,
        job.workflowId,
        job.actor,
        job.prompt,
        JSON.stringify(job.input),
        job.outputField,
        job.fallback,
        job.targetTable,
        job.targetRecordId,
        job.chainDepth,
        job.status,
        job.createdAt,
      );
    return job;
  }

  listPendingJobs(): AiJob[] {
    return this.db
      .query<AiJobRow, []>(
        `SELECT * FROM "ai_jobs" WHERE "status" = 'pending'
         ORDER BY "created_at" ASC, "id" ASC`,
      )
      .all()
      .map(toJob);
  }

  markJob(
    id: string,
    status: "done" | "failed" | "blocked",
    detail?: { error?: string | undefined; resultValue?: string | undefined },
  ): void {
    this.db
      .query(
        `UPDATE "ai_jobs"
         SET "status" = ?, "dispatched_at" = ?, "error" = ?, "result_value" = ?
         WHERE "id" = ?`,
      )
      .run(
        status,
        nowIso(),
        status === "done" ? null : (detail?.error ?? null),
        detail?.resultValue ?? null,
        id,
      );
  }

  // --- メータリング(全 AI 呼び出しの記録。真実源。ADR-0021 §4)-----------------

  recordUsage(input: RecordAiUsageInput): AiUsage {
    const usage: AiUsage = { id: crypto.randomUUID(), ...input };
    this.db
      .query(
        `INSERT INTO "ai_usage"
           ("id", "app_id", "capability_id", "workflow_id", "actor", "model",
            "input_tokens", "output_tokens", "cost_usd", "status", "usage_date", "called_at")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        usage.id,
        usage.appId,
        usage.capabilityId,
        usage.workflowId,
        usage.actor,
        usage.model,
        usage.inputTokens,
        usage.outputTokens,
        usage.costUsd,
        usage.status,
        usage.usageDate,
        usage.calledAt,
      );
    return usage;
  }

  /**
   * ある capability の**当日**の使用量合計(上限判定の入力。§5)。
   * **blocked は数えない**(実際には呼ばれていない。§5)。success + failure だけを数える。
   */
  usageTotalsForDate(capabilityId: string, usageDate: string): AiUsageTotals {
    const row = this.db
      .query<{ calls: number; cost: number | null }, [string, string]>(
        `SELECT COUNT(*) AS "calls", SUM("cost_usd") AS "cost"
         FROM "ai_usage"
         WHERE "capability_id" = ? AND "usage_date" = ?
           AND "status" IN ('success','failure')`,
      )
      .get(capabilityId, usageDate);
    return { calls: row?.calls ?? 0, costUsd: row?.cost ?? 0 };
  }

  /** アプリの全使用量記録(called_at 昇順)。テストと集計が読む。 */
  listUsage(appId: string): AiUsage[] {
    return this.db
      .query<AiUsageRow, [string]>(
        `SELECT * FROM "ai_usage" WHERE "app_id" = ?
         ORDER BY "called_at" ASC, "id" ASC`,
      )
      .all(appId)
      .map(toUsage);
  }

  /**
   * 全アプリの使用量記録(called_at 昇順)。読み取り専用システムテーブル `_ai_usage` の
   * 投影元(ADR-0021 §4)。`_changelog` が全アプリ横断であるのと同じ位置づけ(ADR-0006 §6b)——
   * 画面では `app_id` / `actor` 列で絞ってアプリ別・ユーザ別に集計する。
   */
  listAllUsage(): AiUsage[] {
    return this.db
      .query<AiUsageRow, []>(`SELECT * FROM "ai_usage" ORDER BY "called_at" ASC, "id" ASC`)
      .all()
      .map(toUsage);
  }

  // --- 申請(AI が到達できる上限。ADR-0021 §2b)---------------------------------

  createRequest(input: CreateAiRequestInput): AiRequest {
    const request: AiRequest = {
      id: crypto.randomUUID(),
      appId: input.appId,
      requestedName: input.requestedName,
      purpose: input.purpose,
      suggestedProvider: input.suggestedProvider ?? null,
      suggestedModel: input.suggestedModel ?? null,
      status: "pending",
      createdAt: nowIso(),
    };
    this.db
      .query(
        `INSERT INTO "ai_requests"
           ("id", "app_id", "requested_name", "purpose", "suggested_provider",
            "suggested_model", "status", "created_at")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.id,
        request.appId,
        request.requestedName,
        request.purpose,
        request.suggestedProvider,
        request.suggestedModel,
        request.status,
        request.createdAt,
      );
    return request;
  }

  listPendingRequests(appId: string): AiRequest[] {
    return this.db
      .query<AiRequestRow, [string]>(
        `SELECT * FROM "ai_requests" WHERE "app_id" = ? AND "status" = 'pending'
         ORDER BY "created_at" ASC, "id" ASC`,
      )
      .all(appId)
      .map(toRequest);
  }

  getRequest(id: string): AiRequest | undefined {
    const row = this.db
      .query<AiRequestRow, [string]>(`SELECT * FROM "ai_requests" WHERE "id" = ?`)
      .get(id);
    return row === null ? undefined : toRequest(row);
  }

  markRequest(id: string, status: "approved" | "rejected"): void {
    this.db.query(`UPDATE "ai_requests" SET "status" = ? WHERE "id" = ?`).run(status, id);
  }
}
