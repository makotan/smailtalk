/**
 * **下見の後始末の時計**(`V20-M13-T05`。計画 `docs/plan/v20/15-v20-m13-plan.md` §9-7・§10-5 /
 * `D-V20-43`「期限が切れると写しを消し」/ `ADR-0476` 2-9 の置き換え)。
 *
 * Web サーバ(`src/server/index.ts`)が起動するときに1回、以後 {@link PREVIEW_SWEEP_INTERVAL_MS}
 * ごとに、次の2つを行う。
 *
 * 1. **置き場の期限切れを全部消す**(`purgeExpiredPreviews`。期限切れの meta・壊れた meta・
 *    期限を過ぎても meta の無い作りかけの残骸。**作ったばかりの meta 無しは作る途中かもしれないので
 *    残す**)。
 * 2. **前段がメモリに持つ写しの2本目のうち、期限切れか置き場の無いものを捨てる**
 *    (`findPreview` が引けないもの)。
 *
 * **Web サーバが動いていれば、期限切れの写しは最長で期限 + 60 秒で消える。** 消す時機は他に、
 * 下見を作るとき(`reservePreview`)と前段が要求を受けたとき(`purgePreviewIfStale`)がある。
 *
 * **置き場の根が無いときは、ディスクに何もしない**(根を作らない。`listEntryIds` が空を返す)。
 * **配る版(`runner`)では始めない**(前段が無く、下見は作られない。`index.ts` が分ける)。
 *
 * **時計(`now`)とタイマー(`timer`)は注入できる** —— 検査で期限の前後を撃ち、周を手で回すため。
 * 他のスケジューラ(`outbox-scheduler.ts` ほか)と同じく、**例外を外に投げず**、タイマーは
 * `unref` してプロセスの終了を妨げない。
 */

import type { PreviewFrontCache } from "./preview-front.ts";
import { findPreview, type PreviewClock, purgeExpiredPreviews } from "./preview-store.ts";

/** 時計の間隔(ミリ秒)。**固定定数**(計画 §10-5「60秒ごとに期限切れを消す」)。 */
export const PREVIEW_SWEEP_INTERVAL_MS = 60_000;

/** 差し替えられるタイマー(既定は `globalThis` の `setInterval` / `clearInterval`)。 */
export type PreviewSweeperTimer = {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};

export type SweepPreviewsInput = {
  /** 置き場の根。 */
  root: string;
  /** 前段の写しの2本目の置き場(省略時はメモリを見ない)。 */
  cache?: PreviewFrontCache;
  now?: PreviewClock;
};

/** 1回の掃除の結果。`removed` = 置き場から消した識別子、`dropped` = メモリから捨てた識別子。 */
export type SweepPreviewsResult = { removed: string[]; dropped: string[] };

/**
 * 1回掃除する。**根が無ければ置き場には何もしない**(根を作らない)。
 * メモリの2本目は、置き場から引けない(期限切れ・置き場が無い・壊れている)ものを捨てる。
 */
export function sweepPreviews(input: SweepPreviewsInput): SweepPreviewsResult {
  const now = input.now ?? (() => new Date());
  const at = now();
  const fixed: PreviewClock = () => at;
  const removed = purgeExpiredPreviews(input.root, fixed);
  const dropped: string[] = [];
  if (input.cache !== undefined) {
    for (const id of [...input.cache.keys()]) {
      if (findPreview(input.root, id, fixed) === null) {
        input.cache.delete(id);
        dropped.push(id);
      }
    }
  }
  return { removed, dropped };
}

export type PreviewSweeperOptions = SweepPreviewsInput & {
  /** 周期の上書き(検査用。省略時は {@link PREVIEW_SWEEP_INTERVAL_MS})。 */
  intervalMs?: number;
  /** タイマーの差し替え(検査用)。 */
  timer?: PreviewSweeperTimer;
};

export type PreviewSweeperHandle = { stop(): void };

const defaultTimer: PreviewSweeperTimer = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    // タイマーがイベントループを握ってプロセスの終了を妨げない(backup.ts ほかと同じ)。
    if (typeof handle.unref === "function") {
      handle.unref();
    }
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** 1回掃除し、失敗は標準エラーに書いて握る(**黙って落ちない。外にも投げない**)。 */
function sweepQuietly(input: SweepPreviewsInput): void {
  try {
    sweepPreviews(input);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[smailtalk preview] 下見の後始末に失敗しました: ${detail}\n`);
  }
}

/**
 * 時計を始める。**始めた時点で1回掃除する**(起動時の掃除。プロセスが落ちた残骸のうち
 * 期限切れのものを拾う)。以後、周期ごとに掃除する。**全域で例外を投げない。**
 */
export function startPreviewSweeper(options: PreviewSweeperOptions): PreviewSweeperHandle {
  const timer = options.timer ?? defaultTimer;
  const input: SweepPreviewsInput = {
    root: options.root,
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  sweepQuietly(input);
  const handle = timer.setInterval(
    () => sweepQuietly(input),
    options.intervalMs ?? PREVIEW_SWEEP_INTERVAL_MS,
  );
  return { stop: () => timer.clearInterval(handle) };
}
