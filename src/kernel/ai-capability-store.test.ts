import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiCapabilityStore } from "./ai-capability-store.ts";

const APP = "store-app";

let dataRoot: string;
let store: AiCapabilityStore;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-ai-store-"));
  store = AiCapabilityStore.openForKernel(dataRoot);
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

function issue(name: string): string {
  return store.createCapability({
    appId: APP,
    name,
    provider: "claude_cli",
    model: "claude-opus-4-8",
    limit: { maxCallsPerDay: 5, maxCostUsdPerDay: 1 },
  }).id;
}

describe("capability", () => {
  test("発行して名前で引ける。secret は claude_cli で null", () => {
    issue("c1");
    const found = store.findCapabilityByName(APP, "c1");
    expect(found?.provider).toBe("claude_cli");
    expect(found?.secretSource).toBeNull();
    expect(found?.limit.maxCallsPerDay).toBe(5);
  });

  test("同一 app 内で名前が重複したら拒否する", () => {
    issue("dup");
    expect(() => issue("dup")).toThrow(/既に存在/);
  });

  test("上限は更新できる(owner の HTTP 経路が使う)", () => {
    const id = issue("c2");
    store.updateCapabilityLimit(id, { maxCallsPerDay: 99, maxCostUsdPerDay: 9 });
    expect(store.getCapability(id)?.limit.maxCallsPerDay).toBe(99);
  });

  test("openai_compatible は secretSource を保持する(値は取得元の参照)", () => {
    const id = store.createCapability({
      appId: APP,
      name: "or",
      provider: "openai_compatible",
      model: "openai/gpt-4o-mini",
      baseUrl: "https://openrouter.ai/api/v1",
      secretSource: { kind: "env", value: "OPENROUTER_API_KEY" },
      limit: { maxCallsPerDay: 1, maxCostUsdPerDay: 1 },
    }).id;
    const cap = store.getCapability(id);
    expect(cap?.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(cap?.secretSource).toEqual({ kind: "env", value: "OPENROUTER_API_KEY" });
  });
});

describe("usage 合計(上限判定の入力)", () => {
  test("blocked は当日合計に数えない(success + failure だけ)", () => {
    const capId = issue("c3");
    const base = {
      appId: APP,
      capabilityId: capId,
      workflowId: "wf",
      actor: null,
      model: "claude-opus-4-8",
      inputTokens: 0,
      outputTokens: 0,
      usageDate: "2026-07-22",
      calledAt: "2026-07-22T00:00:00.000Z",
    };
    store.recordUsage({ ...base, costUsd: 0.1, status: "success" });
    store.recordUsage({ ...base, costUsd: 0, status: "failure" });
    store.recordUsage({ ...base, costUsd: 0, status: "blocked" });

    const totals = store.usageTotalsForDate(capId, "2026-07-22");
    // blocked を除いて 2件・コスト 0.1。
    expect(totals.calls).toBe(2);
    expect(totals.costUsd).toBeCloseTo(0.1, 5);
  });

  test("別の日の使用量は当日合計に混ざらない", () => {
    const capId = issue("c4");
    store.recordUsage({
      appId: APP,
      capabilityId: capId,
      workflowId: "wf",
      actor: null,
      model: "m",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 5,
      status: "success",
      usageDate: "2026-07-21",
      calledAt: "2026-07-21T00:00:00.000Z",
    });
    expect(store.usageTotalsForDate(capId, "2026-07-22").calls).toBe(0);
  });
});

describe("申請(AI が到達できる上限)", () => {
  test("申請は pending で作られ、発行(capability)には触れない", () => {
    store.createRequest({ appId: APP, requestedName: "want", purpose: "分類したい" });
    expect(store.listPendingRequests(APP)).toHaveLength(1);
    // 申請しただけでは capability は0本。
    expect(store.listCapabilities(APP)).toHaveLength(0);
  });
});
