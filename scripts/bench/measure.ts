/**
 * 計時とディスク使用量の測定ヘルパ(V1-M1-T05)。
 *
 * 計時は `Bun.nanoseconds()`(単調増加時計)を使う。`Date.now()` は
 * システム時刻の調整で巻き戻りうるので使わない。
 *
 * **1回しか測らない数値は載せない。** 同じ操作を複数回繰り返し、中央値・最小・最大を
 * すべて記録する。中央値だけを載せると「たまたま速かった回」と「常に速い」を
 * 区別できなくなる。
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** 繰り返し測定の結果(ミリ秒)。 */
export type Timing = {
  samples_ms: number[];
  median_ms: number;
  min_ms: number;
  max_ms: number;
};

/** 1回の計時。 */
export function timeOnce<T>(body: () => T): { value: T; ms: number } {
  const start = Bun.nanoseconds();
  const value = body();
  return { value, ms: (Bun.nanoseconds() - start) / 1e6 };
}

/** サンプル配列から Timing を作る。 */
export function summarizeTimings(samples: number[]): Timing {
  if (samples.length === 0) {
    throw new Error("summarizeTimings: サンプルが0件です");
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return {
    samples_ms: samples.map(round3),
    median_ms: round3(median),
    min_ms: round3(sorted[0] as number),
    max_ms: round3(sorted[sorted.length - 1] as number),
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** ファイル1つのバイト数。存在しなければ 0。 */
export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** ディレクトリ配下の合計バイト数(再帰)。存在しなければ 0。 */
export function dirSize(path: string): number {
  let total = 0;
  let entries: { name: string; isDirectory: () => boolean }[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? dirSize(child) : fileSize(child);
  }
  return total;
}
