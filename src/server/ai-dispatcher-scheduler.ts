/**
 * AI ジョブ配送の常駐スケジューラ(V1-M5-T02 / ADR-0021 §3c)。
 *
 * `outbox-scheduler.ts`(外部送信の配送)の兄弟である。`runAiTransform` が ai_jobs に
 * 積んだジョブを、非同期の `dispatchAiJobs`(`src/kernel/ai-dispatcher.ts`)が周期的に
 * 配送する(推論 → 出力検証 → レコードへ書き戻し)。
 *
 * ## 設計(outbox-scheduler.ts と同型)
 *
 * - `setInterval` で `dispatchAiJobs(dataRoot)` を fire-and-forget で呼ぶ。tick は async に
 *   しない(await を混ぜない)。
 * - **多重実行ガード**: 前回の配送が未完了なら次を起動しない(`running` フラグ)。**これは
 *   `dispatchAiJobs` の逐次前提と AI 連鎖深度カウンタ(ai-limits.ts のモジュールスコープ)を
 *   守るためにも必須である** —— 配送が重なると深度が混ざる。
 * - **secret を扱わない**。secret の use-time 解決と非露出は `dispatchAiJobs` /
 *   `resolveSecret` の責務。ログにも secret を出さない(message だけ)。
 */
import { dispatchAiJobs } from "../kernel/ai-dispatcher.ts";

/** 配送 tick の既定周期(5秒)。**固定定数** —— 実行時に差し替える口は intervalMs だけ。 */
export const AI_DISPATCH_TICK_INTERVAL_MS = 5_000;

export type AiDispatcherOptions = {
  dataRoot: string;
  /** テスト用の周期上書き(省略時は AI_DISPATCH_TICK_INTERVAL_MS)。 */
  intervalMs?: number;
};

export type AiDispatcherHandle = {
  stop(): void;
};

/**
 * AI ジョブ配送の常駐スケジューラを起動する。返るまでにファイルもDBも1つも開かない
 * (タイマーを1つ登録するだけ)。全域で例外を投げない。
 */
export function startAiDispatcher(options: AiDispatcherOptions): AiDispatcherHandle {
  const intervalMs = options.intervalMs ?? AI_DISPATCH_TICK_INTERVAL_MS;
  let running = false;

  const timer = setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    dispatchAiJobs(options.dataRoot)
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[smailtalk ai] 配送 tick に失敗しました: ${detail}\n`);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);

  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return {
    stop: () => clearInterval(timer),
  };
}
