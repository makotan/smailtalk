import { describe, expect, test } from "bun:test";
import type { AiLimit } from "./ai-capability-store.ts";
import {
  AI_MAX_CHAIN_DEPTH,
  checkAiLimit,
  currentAiChainDepth,
  withAiChainDepth,
} from "./ai-limits.ts";

const limit: AiLimit = { maxCallsPerDay: 10, maxCostUsdPerDay: 1 };

describe("checkAiLimit", () => {
  test("上限内なら超過しない", () => {
    expect(checkAiLimit({ calls: 9, costUsd: 0.5 }, limit).exceeded).toBe(false);
  });

  test("回数がちょうど上限に達したら超過(>= で弾く)", () => {
    const verdict = checkAiLimit({ calls: 10, costUsd: 0 }, limit);
    expect(verdict.exceeded).toBe(true);
    if (verdict.exceeded) {
      expect(verdict.reason).toContain("回数");
    }
  });

  test("コストがちょうど上限に達したら超過", () => {
    const verdict = checkAiLimit({ calls: 0, costUsd: 1 }, limit);
    expect(verdict.exceeded).toBe(true);
    if (verdict.exceeded) {
      expect(verdict.reason).toContain("コスト");
    }
  });

  test("両方超過したら両方の理由を畳んで返す", () => {
    const verdict = checkAiLimit({ calls: 10, costUsd: 1 }, limit);
    expect(verdict.exceeded).toBe(true);
    if (verdict.exceeded) {
      expect(verdict.reason).toContain("回数");
      expect(verdict.reason).toContain("コスト");
      expect(verdict.reason).toContain("人間");
    }
  });
});

describe("AI 配送深度", () => {
  test("既定は 0、withAiChainDepth の中だけ上がり、抜けると戻る", () => {
    expect(currentAiChainDepth()).toBe(0);
    withAiChainDepth(3, () => {
      expect(currentAiChainDepth()).toBe(3);
      withAiChainDepth(4, () => {
        expect(currentAiChainDepth()).toBe(4);
      });
      expect(currentAiChainDepth()).toBe(3);
    });
    expect(currentAiChainDepth()).toBe(0);
  });

  test("例外が出ても深度は戻る", () => {
    try {
      withAiChainDepth(2, () => {
        throw new Error("boom");
      });
    } catch {
      // 無視
    }
    expect(currentAiChainDepth()).toBe(0);
  });

  test("上限は正の定数(暴走の安全弁)", () => {
    expect(AI_MAX_CHAIN_DEPTH).toBeGreaterThan(0);
  });
});
