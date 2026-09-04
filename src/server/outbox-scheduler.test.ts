/**
 * アウトボックス配送スケジューラの配線検査(V1-M4-T04 / ADR-0020 §3 改訂2)。
 *
 * **ネットワークに触れない。**seed する outbox の connection は取得元が未設定の環境変数を
 * 指すので、`dispatchOutbox` は `resolveSecret` の段階で失敗し、**fetch を呼ばずに** failed に
 * する(`outbox-dispatcher.ts` の順序: resolveSecret → outboundFetch)。したがって tick が
 * 発火したことは「outbox が pending から failed へ動いた」ことで観測できる。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityStore } from "../kernel/capability-store.ts";
import { startOutboxDispatcher } from "./outbox-scheduler.ts";

let dataRoot: string;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-outbox-scheduler-"));
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

/** 取得元が未設定の env を指す connection と、その宛の outbox を1件 seed する。 */
function seedPendingItem(): void {
  const store = CapabilityStore.openForKernel(dataRoot);
  try {
    const conn = store.createConnection({
      appId: "app-a",
      name: "api",
      allowedHosts: ["api.example.com"],
      // 未設定の環境変数 → dispatch は resolveSecret で失敗し、fetch を呼ばない。
      secretSource: { kind: "env", value: "ST_T04_SCHEDULER_UNSET" },
    });
    store.enqueueOutbox({
      appId: "app-a",
      connectionId: conn.id,
      destination: "https://api.example.com/x",
      payload: { title: "本" },
    });
  } finally {
    store.close();
  }
}

/** pending の件数を読む。 */
function pendingCount(): number {
  const store = CapabilityStore.openForKernel(dataRoot);
  try {
    return store.listPendingOutbox().length;
  } finally {
    store.close();
  }
}

/** 条件が満たされるまでポーリングする(最大 timeoutMs)。 */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

test("tick が dispatchOutbox を発火し、pending が捌ける", async () => {
  delete process.env.ST_T04_SCHEDULER_UNSET;
  seedPendingItem();
  expect(pendingCount()).toBe(1);

  const handle = startOutboxDispatcher({ dataRoot, intervalMs: 20 });
  try {
    // 未設定 env のため failed になり pending から外れる = tick が発火した証拠。
    expect(await waitFor(() => pendingCount() === 0)).toBe(true);
  } finally {
    handle.stop();
  }
});

test("stop() 後は新しい tick で dispatch されない", async () => {
  delete process.env.ST_T04_SCHEDULER_UNSET;

  const handle = startOutboxDispatcher({ dataRoot, intervalMs: 20 });
  // 走り出した直後に止める(まだ何も積んでいない)。
  handle.stop();

  // 止めた後に積む。以後どれだけ待っても捌かれない。
  seedPendingItem();
  expect(pendingCount()).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(pendingCount()).toBe(1);
});
