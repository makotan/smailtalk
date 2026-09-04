/**
 * アウトボックス配送の常駐スケジューラ(V1-M4-T04 / ADR-0020 §3 改訂2・§Consequences 限界7)。
 *
 * `runAction` の `call_external` 分岐は、capability チェック(同期)を通ったものを outbox に
 * **積むだけ**である(`src/kernel/workflow-runner.ts`)。実際の外部 fetch は非同期の
 * `dispatchOutbox`(`src/kernel/outbox-dispatcher.ts`)が別実行で行う —— T03 まではこの関数を
 * どのスケジューラにも結線していなかった。**本モジュールがその配線である。**
 *
 * ## 設計(backup.ts / workflow-scheduler.ts の作法に倣う)
 *
 * - `setInterval` で周期的に `dispatchOutbox(dataRoot)` を呼ぶ。**tick コールバックは async に
 *   しない** —— コールバック内で `dispatchOutbox(...).catch(...)`(fire-and-forget)し、例外を
 *   握る。await を tick に混ぜない(workflow-scheduler.ts の同期性の思想に合わせる)。
 * - **多重実行ガード**: 前回の dispatch が未完了なら次を起動しない(`running` フラグ)。配送は
 *   結果整合であり、重ならないことが outbox の二重送信を防ぐ最小の担保になる。
 * - 差し替え口は最小限(テスト用に `intervalMs` を受ける程度)。既定周期は固定定数。
 *
 * ## secret を扱わない
 *
 * このモジュールは `dispatchOutbox` を**呼ぶだけ**で、secret に一切触れない。secret の
 * use-time 解決と非露出は `dispatchOutbox` / `resolveSecret` の責務である(§2d)。エラーは
 * `dispatchOutbox` が握って outbox の error 列(secret 非混入)に残すので、ここで拾う例外は
 * 予期しない I/O 失敗等に限られる。**ログにも secret を出さない**(message だけを出す)。
 */
import { dispatchOutbox } from "../kernel/outbox-dispatcher.ts";

/** 配送 tick の既定周期(5秒)。**固定定数** —— 実行時に差し替える口は intervalMs だけ。 */
export const OUTBOX_TICK_INTERVAL_MS = 5_000;

export type OutboxDispatcherOptions = {
  dataRoot: string;
  /** テスト用の周期上書き(省略時は OUTBOX_TICK_INTERVAL_MS)。 */
  intervalMs?: number;
};

export type OutboxDispatcherHandle = {
  stop(): void;
};

/**
 * アウトボックス配送の常駐スケジューラを起動する。返るまでにファイルもDBも1つも開かない
 * (タイマーを1つ登録するだけ)ので、正常時の起動は1バイトも書き換えない。全域で例外を投げない。
 */
export function startOutboxDispatcher(options: OutboxDispatcherOptions): OutboxDispatcherHandle {
  const intervalMs = options.intervalMs ?? OUTBOX_TICK_INTERVAL_MS;
  // 前回の dispatch が未完了なら次を起動しない(多重実行ガード)。
  let running = false;

  const timer = setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    // **tick は同期のまま**。dispatch は fire-and-forget し、例外を握って running を戻す。
    dispatchOutbox(options.dataRoot)
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        // secret を出さない(message だけ)。dispatchOutbox 自身も error に secret を残さない。
        process.stderr.write(`[smailtalk outbox] 配送 tick に失敗しました: ${detail}\n`);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);

  // タイマーがイベントループを握ってプロセス終了を妨げないようにする(backup.ts と同じ)。
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return {
    stop: () => clearInterval(timer),
  };
}
