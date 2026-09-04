import { describe, expect, test } from "bun:test";
import { estimateCostUsd, isKnownModel } from "./ai-cost.ts";

describe("estimateCostUsd", () => {
  test("既知モデルはトークン数 × 単価で推定する", () => {
    // claude-opus-4-8: 入力 $15/Mtok・出力 $75/Mtok。
    // 1,000,000 入力 + 1,000,000 出力 = 15 + 75 = 90 USD。
    expect(estimateCostUsd("claude-opus-4-8", 1_000_000, 1_000_000)).toBeCloseTo(90, 5);
  });

  test("入力と出力で別単価が効く", () => {
    // 出力のほうが高いので、同トークンなら出力側が大きい。
    const inputOnly = estimateCostUsd("claude-opus-4-8", 1_000_000, 0);
    const outputOnly = estimateCostUsd("claude-opus-4-8", 0, 1_000_000);
    expect(outputOnly).toBeGreaterThan(inputOnly);
  });

  test("未知モデルは 0 を返す(捏造しない)", () => {
    expect(estimateCostUsd("unknown-model", 1_000_000, 1_000_000)).toBe(0);
    expect(isKnownModel("unknown-model")).toBe(false);
  });

  test("isKnownModel は既定の単価表を認識する", () => {
    expect(isKnownModel("claude-opus-4-8")).toBe(true);
    expect(isKnownModel("openai/gpt-4o-mini")).toBe(true);
  });
});
