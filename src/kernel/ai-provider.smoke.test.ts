/**
 * `claude -p`(claude_cli プロバイダ)の実 API スモークテスト(V1-M5-T02 検証方法)。
 *
 * **既定ではスキップする**(実 API を叩き、トークンを消費するため)。実行するには
 * `ST_AI_SMOKE=1` を設定する:
 *
 *   ST_AI_SMOKE=1 bun test src/kernel/ai-provider.smoke.test.ts
 *
 * これは `defaultAiProvider` が本物の `claude` CLI を spawn し、`--output-format json` の
 * stdout から本文とトークン数を正しく読めることを実証する。**モック検証(ai-transform.test.ts)
 * では捉えられない「実 CLI の JSON 形状との噛み合わせ」を確認する唯一のテストである。**
 *
 * 実測(2026-07-22 / claude CLI 2.1.215)の JSON 形状:
 *   { "result": "pong", "usage": { "input_tokens": 2, "output_tokens": 4, ... }, ... }
 * → `ai-provider.ts` の `runClaudeCli` は `result` / `usage.input_tokens` / `usage.output_tokens`
 *   を読む。この形状はスモークで一度確認済み(docs/evidence/cp-v1-5.md)。
 */
import { expect, test } from "bun:test";
import type { AiCapability } from "./ai-capability-store.ts";
import { defaultAiProvider } from "./ai-provider.ts";
import { resolveSecret } from "./secret-resolver.ts";

const RUN = process.env.ST_AI_SMOKE === "1";

const capability: AiCapability = {
  id: "smoke",
  appId: "smoke",
  name: "smoke",
  provider: "claude_cli",
  model: "claude-haiku-4-5",
  baseUrl: null,
  secretSource: null,
  limit: { maxCallsPerDay: 1, maxCostUsdPerDay: 1 },
  createdAt: "2026-07-22T00:00:00.000Z",
};

test.if(RUN)("claude -p が本文とトークン数を返す(実 API)", async () => {
  const result = await defaultAiProvider(
    capability,
    'Reply with exactly the JSON: {"value": "pong"}',
    resolveSecret,
  );
  expect(result.text).toContain("pong");
  expect(result.inputTokens).toBeGreaterThanOrEqual(0);
  expect(result.outputTokens).toBeGreaterThan(0);
});

test.if(!RUN)("スモークは既定でスキップ(ST_AI_SMOKE=1 で実行)", () => {
  // 既定では実 API を叩かない。この test は「ファイルに実行可能な test が1つはある」ことを保つ。
  expect(RUN).toBe(false);
});
