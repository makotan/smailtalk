/**
 * AI ジョブの非同期配送(V1-M5-T02〜T04 / ADR-0021 §3c)。
 *
 * `runAction` の `ai_transform` 分岐(実行層の遮断点)は capability チェック・上限判定・
 * 連鎖深度判定を同期で行い、許可されたジョブを ai_jobs に**積むだけ**である
 * (`src/kernel/workflow-runner.ts`)。実際の推論・構造化出力の検証・レコードへの書き戻しは、
 * この非同期ディスパッチャが**別実行**で行う —— 書き込み経路(`records.ts` 以下)を
 * async 化しないための分離である(`call_external` の `dispatchOutbox` と同型。§3 改訂2 の理由)。
 *
 * **記録なしに AI を呼べる経路を作らない**(ADR-0021 §8c-7)—— provider を呼ぶ経路は必ず
 * `ai_usage` に1行書く。上限 / 連鎖で止めた blocked も記録する(§4 / §5)。
 *
 * **secret の扱い(ADR-0020 §2d を継承)**:
 * - secret は ai_jobs に載っていない。capability の参照だけがある。
 * - `openai_compatible` の API キーは配送時に初めて `resolveSecret` で use-time 解決する。
 * - `claude_cli` は secret を持たない(CLI 自身の認証)。
 * - 解決値は provider のスコープを出さない。error / ログ / usage のどの列にも secret を入れない。
 *
 * **`call_external` との唯一の違いは結果をレコードへ書き戻すこと**である(§3c)。書き戻しは
 * `updateRecord`(同一アプリのテーブルへの通常の書き込み)で行い、それ自体が `on_update`
 * ワークフローを発火させうる —— それが連鎖増幅の源であり、`withAiChainDepth` で書き戻しの間の
 * 配送深度を1つ上げることで、そこで積まれる次のジョブに深度を継がせる(§5)。
 *
 * **配送は逐次(1ジョブずつ・`Promise.all` を使わない)。**`withAiChainDepth` が
 * モジュールスコープのカウンタに依存するため、並行にすると深度が混ざる(ai-limits.ts の警告)。
 */
import { Database } from "bun:sqlite";
import { AiCapabilityStore } from "./ai-capability-store.ts";
import { estimateCostUsd, isKnownModel } from "./ai-cost.ts";
import { AI_MAX_CHAIN_DEPTH, aiUsageDate, checkAiLimit, withAiChainDepth } from "./ai-limits.ts";
import { type AiProvider, defaultAiProvider } from "./ai-provider.ts";
import { buildStructuredPrompt, parseAiValue } from "./ai-structured.ts";
import { readCurrentManifest } from "./apply-manifest.ts";
import { systemClock } from "./clock.ts";
import { updateRecord } from "./records.ts";
import { isApplyInProgress } from "./recovery.ts";
import { resolveSecret } from "./secret-resolver.ts";
import { appDbPath } from "./storage-paths.ts";
import type { Field, Manifest } from "./types.ts";

/** 配送結果の集計(スモーク / 監視用)。 */
export interface DispatchAiResult {
  done: number;
  failed: number;
  blocked: number;
  /** 書き込み先アプリが適用中で見送ったジョブ(pending のまま次周期に再試行)。 */
  deferred: number;
}

/**
 * ai_jobs の pending をすべて配送する(V1-M5-T02〜T04)。
 *
 * @param provider テスト用の注入口(実 CLI / 実ネットワークに触れずスパイで検査する)。
 *   省略時は `defaultAiProvider`(capability.provider で claude_cli / openai_compatible を分岐)。
 */
export async function dispatchAiJobs(
  dataRoot: string,
  provider: AiProvider = defaultAiProvider,
): Promise<DispatchAiResult> {
  const store = AiCapabilityStore.openForKernel(dataRoot);
  const result: DispatchAiResult = { done: 0, failed: 0, blocked: 0, deferred: 0 };
  try {
    for (const job of store.listPendingJobs()) {
      const capability = store.getCapability(job.capabilityId);
      if (capability === undefined) {
        // 失効:capability が消えているので呼べない(secret も引けない)。
        store.markJob(job.id, "failed", { error: "AI capability が失効しています" });
        result.failed += 1;
        continue;
      }

      const usageDate = aiUsageDate(systemClock);
      const recordBlocked = (reason: string): void => {
        store.recordUsage({
          appId: job.appId,
          capabilityId: capability.id,
          workflowId: job.workflowId,
          actor: job.actor,
          model: capability.model,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          status: "blocked",
          usageDate,
          calledAt: systemClock.now().toISOString(),
        });
        store.markJob(job.id, "blocked", { error: reason });
        result.blocked += 1;
      };

      // 多層防御(1): 連鎖深度の再判定(§5。enqueue で既に弾いているが配送でも見る)。
      if (job.chainDepth >= AI_MAX_CHAIN_DEPTH) {
        recordBlocked(`AI 呼び出しの連鎖が深度上限(${AI_MAX_CHAIN_DEPTH})に達しました`);
        continue;
      }

      // 多層防御(2): 当日の上限の再判定(§5。enqueue と配送の間に上限へ達しうる)。
      const totals = store.usageTotalsForDate(capability.id, usageDate);
      const verdict = checkAiLimit(totals, capability.limit);
      if (verdict.exceeded) {
        recordBlocked(`AI 呼び出しの上限に達しました: ${verdict.reason}`);
        continue;
      }

      // 書き戻し先アプリが適用中なら、この周期は見送る(pending のまま。scheduler と同型)。
      // **provider を呼ぶ前に見送る** —— 書き戻せないのに推論コストを払わないため。
      if (isApplyInProgress(dataRoot, job.appId).inProgress) {
        result.deferred += 1;
        continue;
      }

      // マニフェストと書き戻し先フィールドを読む(消えていれば呼ばずに failed)。
      let manifest: Manifest;
      try {
        manifest = readCurrentManifest(dataRoot, job.appId);
      } catch (error) {
        store.markJob(job.id, "failed", {
          error: `マニフェストを読めませんでした: ${error instanceof Error ? error.message : String(error)}`,
        });
        result.failed += 1;
        continue;
      }
      const field = findField(manifest, job.targetTable, job.outputField);
      if (field === undefined) {
        store.markJob(job.id, "failed", {
          error: `書き戻し先フィールド "${job.outputField}"(テーブル "${job.targetTable}")が見つかりません`,
        });
        result.failed += 1;
        continue;
      }

      // 推論を呼ぶ。secret は use-time 解決(openai_compatible のみ)。
      const prompt = buildStructuredPrompt(job.prompt, job.input, field);
      let providerResult: { text: string; inputTokens: number; outputTokens: number };
      try {
        providerResult = await provider(capability, prompt, resolveSecret);
      } catch (error) {
        // **呼び出し失敗も必ず記録する**(§8c-7)。トークンは不明なので 0、status=failure。
        // failure は当日の呼び出し回数に数える(失敗の連打で上限を回避させない。§5)。
        store.recordUsage({
          appId: job.appId,
          capabilityId: capability.id,
          workflowId: job.workflowId,
          actor: job.actor,
          model: capability.model,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          status: "failure",
          usageDate,
          calledAt: systemClock.now().toISOString(),
        });
        // 呼び出しが失敗しても、フォールバックを書き戻す(§3b。憲法6: 黙って空にしない)。
        const wrote = writeBack(dataRoot, manifest, job, null);
        store.markJob(job.id, "failed", {
          error: `AI 呼び出しが失敗しました: ${error instanceof Error ? error.message : String(error)}`,
          resultValue: wrote.value ?? undefined,
        });
        result.failed += 1;
        continue;
      }

      // **呼び出しは成功した(トークンを消費した)。コストを推定して必ず記録する。**
      const costUsd = estimateCostUsd(
        capability.model,
        providerResult.inputTokens,
        providerResult.outputTokens,
      );
      store.recordUsage({
        appId: job.appId,
        capabilityId: capability.id,
        workflowId: job.workflowId,
        actor: job.actor,
        model: capability.model,
        inputTokens: providerResult.inputTokens,
        outputTokens: providerResult.outputTokens,
        // 未知モデルはコスト 0(捏造しない。ai-cost.ts)。0 が「単価表に無かった」ことは
        // isKnownModel で判別できるので、その旨をエラー列に残して見えるようにする。
        costUsd,
        status: "success",
        usageDate,
        calledAt: systemClock.now().toISOString(),
      });

      // 構造化出力を検証して書き戻す。不正ならフォールバック(§3b)。
      const parsed = parseAiValue(providerResult.text);
      const wrote = writeBack(dataRoot, manifest, job, parsed);
      if (wrote.ok) {
        const costNote = isKnownModel(capability.model)
          ? undefined
          : `(注: モデル "${capability.model}" は単価表に無く、推定コストは 0 で記録されています)`;
        store.markJob(job.id, wrote.usedFallback ? "failed" : "done", {
          error: wrote.usedFallback
            ? `AI 出力が不正だったためフォールバック値を書き戻しました${costNote ? ` ${costNote}` : ""}`
            : costNote,
          resultValue: wrote.value ?? undefined,
        });
        if (wrote.usedFallback) {
          result.failed += 1;
        } else {
          result.done += 1;
        }
      } else {
        store.markJob(job.id, "failed", {
          error: `AI 出力もフォールバックも書き戻せませんでした: ${wrote.error}`,
        });
        result.failed += 1;
      }
    }
  } finally {
    store.close();
  }
  return result;
}

/** 書き戻しの結果。`usedFallback` は AI 出力が不正でフォールバックを書いたことを表す。 */
interface WriteBackResult {
  ok: boolean;
  usedFallback: boolean;
  value: string | null;
  error?: string;
}

/**
 * AI の出力(`value`。不正なら `null`)を `output_field` へ書き戻す。検証は
 * `updateRecord`(フィールド制約 = 型 / select 選択肢)が行う —— **新しい検証器を発明しない**
 * (ADR-0021 §3b)。`value` が `null` / 検証に通らないときは `fallback` を書く。それも通らなければ
 * `{ ok: false }`(書かずに failed)。
 *
 * **書き戻しの間だけ配送深度を1つ上げる**(`withAiChainDepth`)—— この書き込みが誘発する
 * `on_update` の `ai_transform` は、深度を継いだジョブとして積まれる(§5)。書き戻しは同期。
 */
function writeBack(
  dataRoot: string,
  manifest: Manifest,
  job: {
    appId: string;
    targetTable: string;
    targetRecordId: string;
    outputField: string;
    fallback: string;
    chainDepth: number;
  },
  value: string | null,
): WriteBackResult {
  const db = new Database(appDbPath(dataRoot, job.appId), { readwrite: true, create: false });
  try {
    return withAiChainDepth(job.chainDepth + 1, () => {
      // まず AI 出力を試す(null = 抽出失敗なので最初からフォールバックへ)。
      if (value !== null) {
        const result = updateRecord(db, manifest, job.targetTable, job.targetRecordId, {
          [job.outputField]: value,
        });
        if (result.ok) {
          return { ok: true, usedFallback: false, value };
        }
      }
      // フォールバック(§3b)。これも通らなければ書かない。
      const fallbackResult = updateRecord(db, manifest, job.targetTable, job.targetRecordId, {
        [job.outputField]: job.fallback,
      });
      if (fallbackResult.ok) {
        return { ok: true, usedFallback: true, value: job.fallback };
      }
      return {
        ok: false,
        usedFallback: true,
        value: null,
        error: fallbackResult.errors.map((e) => e.message).join(" / "),
      };
    });
  } finally {
    db.close();
  }
}

function findField(manifest: Manifest, tableId: string, fieldId: string): Field | undefined {
  return manifest.app.tables
    .find((table) => table.id === tableId)
    ?.fields.find((field) => field.id === fieldId);
}
