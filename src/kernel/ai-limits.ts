/**
 * AI 呼び出しの上限判定(V1-M5-T04 / ADR-0021 §5)。**単一ソース。**
 *
 * `host-scope.ts` が `call_external` の宛先照合の単一ソースであるのと同じ位置づけで、
 * この純関数は AI 呼び出しの上限照合の単一ソースである。2箇所から呼ばれる:
 * - `workflow-runner.ts` の `runAiTransform` —— **enqueue 時**の遮断点。
 * - `ai-dispatcher.ts` の `dispatchAiJobs` —— **配送時**の再検証(多層防御。§5)。
 *
 * enqueue と dispatch の間には時間差があり、その間に他の呼び出しが上限へ達しうるので、
 * **両方が同じ関数を通る**ことが、上限を跨いだ呼び出しを配送直前に弾ける根拠になる。
 *
 * 「当日」の境界はタイムゾーン(`ST_TIMEZONE`、既定 `Asia/Tokyo`)で決まる —— スケジューラの
 * 発火済み判定(ADR-0013 §6c)と同じ壁時計の日付で、`ai_usage` の `usage_date` 列と突き合わせる。
 * **新しい状態を持たない**(§5)—— 判定は毎回 `ai_usage` の当日合計から導く。
 */

import type { AiLimit, AiUsageTotals } from "./ai-capability-store.ts";
import { type Clock, resolveTimeZone, zonedNow } from "./clock.ts";

/** 上限判定の結果。超過なら人間可読な理由を持つ。 */
export type AiLimitVerdict = { exceeded: false } | { exceeded: true; reason: string };

/**
 * `ST_TIMEZONE` を解決する。**上限判定はスケジューラと違い、不正な TZ で起動を止めない** ——
 * 止めると「1つの設定ミスで AI 呼び出しが全部落ちる」ことになり、暴走防止のための機構が
 * 逆に可用性を壊す。不正なら既定(`Asia/Tokyo`)に落ちる(境界がずれるだけで、上限自体は効く)。
 */
export function resolveAiTimeZone(): string {
  const resolution = resolveTimeZone(process.env.ST_TIMEZONE);
  return resolution.ok ? resolution.timeZone : "Asia/Tokyo";
}

/** その時刻源の「今日」を、上限判定に使う TZ の壁時計日付(YYYY-MM-DD)で返す。 */
export function aiUsageDate(clock: Clock): string {
  return zonedNow(clock, resolveAiTimeZone()).date;
}

/**
 * 当日の使用量合計が上限に達しているか(§5)。
 *
 * - 回数上限: 当日の呼び出し回数(success + failure)が `maxCallsPerDay` **以上**なら超過。
 * - コスト上限: 当日の推定コスト合計が `maxCostUsdPerDay` **以上**なら超過。
 *
 * **「以上」で弾く**(`>=`)—— 上限ちょうどに達したら、それ以上は呼ばせない。
 * どちらか一方でも超えていれば超過とし、両方の理由を畳んで返す(片方だけ直しても
 * もう片方で止まることが分かるように)。
 */
export function checkAiLimit(totals: AiUsageTotals, limit: AiLimit): AiLimitVerdict {
  const reasons: string[] = [];
  if (totals.calls >= limit.maxCallsPerDay) {
    reasons.push(
      `当日の呼び出し回数(${totals.calls})が上限(${limit.maxCallsPerDay})に達しています`,
    );
  }
  if (totals.costUsd >= limit.maxCostUsdPerDay) {
    reasons.push(
      `当日の推定コスト($${totals.costUsd.toFixed(4)})が上限($${limit.maxCostUsdPerDay})に達しています`,
    );
  }
  if (reasons.length === 0) {
    return { exceeded: false };
  }
  return {
    exceeded: true,
    reason: `${reasons.join(" / ")}。上限は人間(owner)のみが変更できます。`,
  };
}

/**
 * AI 呼び出しの連鎖増幅を止める深度上限(§5)。
 *
 * `ai_transform` の書き戻し(§3c)が別の `ai_transform` を誘発する連鎖を、ジョブの
 * `chain_depth` で止める。**`WORKFLOW_MAX_DEPTH`(同期連鎖)とは別機構である** ——
 * 非同期配送を跨ぐ連鎖のカウントで、配送のたびに同期側の depth が 0 に戻るため、
 * 同期側だけでは AI 連鎖を止められない。日次上限が最終 backstop で、これは
 * 「1回のユーザ操作から派生する連鎖」を早期に止める。
 *
 * ## 差し替える口を置かない(`WORKFLOW_MAX_DEPTH` と同じ規律)
 *
 * `const` であって setter を持たない。実行時に動かせると、本番で何段連鎖するのかが
 * コードを読んでも決まらなくなる。
 */
export const AI_MAX_CHAIN_DEPTH = 5;

/**
 * 現在の「AI 配送深度」(§5)。**中立なモジュールに置く**理由:
 * `workflow-runner.ts`(enqueue)と `ai-dispatcher.ts`(配送)の両方が読み書きするが、
 * 両者を直接依存させると循環になる(dispatcher → records → workflow-runner)。
 * この状態を依存の無い `ai-limits.ts` に置けば、両者は循環せずに同じカウンタを共有できる。
 *
 * **なぜモジュールスコープで足りるか**: `dispatchAiJobs` が**逐次**(1ジョブずつ・
 * `Promise.all` を使わない・多重実行ガードつき)で回り、書き戻し(`updateRecord`)が
 * **同期**だからである。`workflow-runner.ts` の `depth` と同じ条件で、**AI 配送を並行に
 * した瞬間に壊れる**(§Consequences 限界6)。
 */
let aiDispatchDepth = 0;

/** enqueue 時に、積むジョブの `chain_depth` に使う現在の配送深度を読む。 */
export function currentAiChainDepth(): number {
  return aiDispatchDepth;
}

/**
 * 配送深度を `depth` に立てて `fn`(書き戻し = 同期の `updateRecord`)を実行する。
 * その最中に `runAiTransform` が enqueue するジョブは、この深度を `chain_depth` に継ぐ。
 * **`fn` は同期でなければならない**(await を跨ぐと深度が別の配送と混ざる。上の doc)。
 */
export function withAiChainDepth<T>(depth: number, fn: () => T): T {
  const previous = aiDispatchDepth;
  aiDispatchDepth = depth;
  try {
    return fn();
  } finally {
    aiDispatchDepth = previous;
  }
}
