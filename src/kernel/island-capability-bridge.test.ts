import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiCapabilityStore, type AiLimit } from "./ai-capability-store.ts";
import { CapabilityStore } from "./capability-store.ts";
import { buildCapabilityBridges } from "./island-capability-bridge.ts";
import { type IslandLimits, runIsland } from "./island-runner.ts";
import { appDbPath } from "./storage-paths.ts";
import { resetWorkflowClock, setWorkflowClock } from "./workflow-runner.ts";

/**
 * 島(QuickJS 関数)→ capability ブリッジの許可/不許可マトリクス + 迂回試行(V1-M6-T04 / ADR-0024)。
 *
 * `call_external.test.ts`(M4)/ `ai-transform.test.ts`(M5)の兄弟である。**遮断は実行層にある** ——
 * 島の外部到達手段は `runIsland(...hostFunctions)` にホストが注入した関数だけであり
 * (`island-runner.ts` のアンビエント権限ゼロ)、そのホスト関数は**宣言 + 付与された capability の
 * 分しか生えない**。宣言外の capability にはホスト関数が存在しない = 島から到達する扉が無い
 * (構造的遮断)。ブリッジの中では M4/M5 と全く同じ照合 → スコープ/上限チェック → 投函を行う。
 *
 * **本物の CapabilityStore / AiCapabilityStore / QuickJS を使う**(モックで遮断を偽装しない)。
 * app DB は実在の `<tmp>/apps/<appId>/app.sqlite` に置く(`parseAppDbPath` が逆算できる正規レイアウト)。
 */

const APP_ID = "island-cap-app";
const LIMITS: IslandLimits = {
  timeoutMillis: 5000,
  memoryBytes: 64 * 1024 * 1024,
  maxInputBytes: 1_000_000,
};
const AI_FIXED_CLOCK = { now: () => new Date("2026-07-22T04:05:06.000Z") };

let dataRoot: string;
let db: Database;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-island-cap-"));
  // app.sqlite を **<dataRoot>/apps/<appId>/app.sqlite** の正規レイアウトで作る
  // (ブリッジが db.filename から dataRoot / appId を逆算するため。:memory: は throw → 全遮断)。
  await mkdir(join(dataRoot, "apps", APP_ID), { recursive: true });
  db = new Database(appDbPath(dataRoot, APP_ID), { create: true });
});

afterEach(async () => {
  db.close();
  resetWorkflowClock();
  await rm(dataRoot, { recursive: true, force: true });
});

/** 接続を1本発行する(人間の owner 操作の代役)。 */
function issueConnection(name: string, allowedHosts: string[]): void {
  const store = CapabilityStore.openForKernel(dataRoot);
  try {
    store.createConnection({
      appId: APP_ID,
      name,
      allowedHosts,
      secretSource: { kind: "env", value: "ST_T04_SECRET" },
    });
  } finally {
    store.close();
  }
}

/** AI capability を1本発行する。 */
function issueAiCapability(name: string, limit: AiLimit): void {
  const store = AiCapabilityStore.openForKernel(dataRoot);
  try {
    store.createCapability({
      appId: APP_ID,
      name,
      provider: "claude_cli",
      model: "claude-opus-4-8",
      limit,
    });
  } finally {
    store.close();
  }
}

/** kernel.sqlite の outbox の pending を読み出す(検査用)。 */
function pendingOutbox() {
  const store = CapabilityStore.openForKernel(dataRoot);
  try {
    return store.listPendingOutbox();
  } finally {
    store.close();
  }
}

/** kernel.sqlite の ai_jobs の pending を読み出す(検査用)。 */
function pendingJobs() {
  const store = AiCapabilityStore.openForKernel(dataRoot);
  try {
    return store.listPendingJobs();
  } finally {
    store.close();
  }
}

/** kernel.sqlite の ai_usage(このアプリ分)を読み出す(検査用)。 */
function usageRows() {
  const store = AiCapabilityStore.openForKernel(dataRoot);
  try {
    return store.listUsage(APP_ID);
  } finally {
    store.close();
  }
}

describe("島 capability ブリッジの許可/不許可マトリクス", () => {
  test("1. 宣言 + 付与された connection → 島が呼ぶと outbox に pending 1件(payload はそのまま)", async () => {
    issueConnection("notifier", ["api.example.com"]);
    const bridges = buildCapabilityBridges({
      db,
      declaredCapabilities: ["notifier"],
      actor: "user-1",
    });

    const code = `(input) => notifier({ destination: input.destination, payload: { title: input.title } })`;
    const result = await runIsland({
      code,
      input: { destination: "https://api.example.com/send", title: "吾輩は猫である" },
      limits: LIMITS,
      hostFunctions: bridges,
    });

    expect(result).toMatchObject({ status: "success", output: { ok: true, kind: "connection" } });
    const pending = pendingOutbox();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.destination).toBe("https://api.example.com/send");
    expect(pending[0]?.appId).toBe(APP_ID);
    expect(pending[0]?.payload).toEqual({ title: "吾輩は猫である" });
    // secret は outbox に載らない(payload に secret 参照が混ざらない)。
    expect(JSON.stringify(pending[0]?.payload)).not.toContain("ST_T04_SECRET");
  });

  test("2. 宣言していない capability → 島内で typeof === undefined、呼ぶと失敗・outbox/ai_jobs 0件(構造的遮断)", async () => {
    // notifier は発行済み connection だが、**宣言していない**(declaredCapabilities に入れない)。
    issueConnection("notifier", ["api.example.com"]);
    const bridges = buildCapabilityBridges({
      db,
      declaredCapabilities: [],
      actor: "user-1",
    });

    // 宣言外の名前は島の global に生えていない(= 扉が無い)。
    const probe = await runIsland({
      code: `(input) => ({ notifier: typeof notifier, fetch: typeof fetch })`,
      input: {},
      limits: LIMITS,
      hostFunctions: bridges,
    });
    expect(probe).toMatchObject({
      status: "success",
      output: { notifier: "undefined", fetch: "undefined" },
    });

    // 呼ぼうとすると島の実行が失敗する(存在しない関数の呼び出し)。
    const call = await runIsland({
      code: `(input) => notifier({ destination: "https://api.example.com/x" })`,
      input: {},
      limits: LIMITS,
      hostFunctions: bridges,
    });
    expect(call.status).toBe("failure");

    // **どちらの投函キューにも1件も積まれていない。**
    expect(pendingOutbox()).toHaveLength(0);
    expect(pendingJobs()).toHaveLength(0);
  });

  test("3. 宣言したが connection 未発行 → ブリッジが {ok:false} を返し、outbox 0件", async () => {
    // 接続を1本も発行しない。宣言はされているので扉は生えるが、call-time の照合で弾かれる。
    const bridges = buildCapabilityBridges({
      db,
      declaredCapabilities: ["notifier"],
      actor: "user-1",
    });

    const result = await runIsland({
      code: `(input) => notifier({ destination: "https://api.example.com/x", payload: {} })`,
      input: {},
      limits: LIMITS,
      hostFunctions: bridges,
    });

    expect(result.status).toBe("success");
    expect(result).toMatchObject({ output: { ok: false } });
    expect(pendingOutbox()).toHaveLength(0);
  });

  test("4a. 宣言したが destination がスコープ外(allowedHosts に無い)→ 拒否・outbox 0件", async () => {
    issueConnection("notifier", ["api.example.com"]);
    const bridges = buildCapabilityBridges({
      db,
      declaredCapabilities: ["notifier"],
      actor: "user-1",
    });

    const result = await runIsland({
      code: `(input) => notifier({ destination: "https://evil.example.net/x", payload: {} })`,
      input: {},
      limits: LIMITS,
      hostFunctions: bridges,
    });

    expect(result.status).toBe("success");
    expect(result).toMatchObject({ output: { ok: false } });
    expect(pendingOutbox()).toHaveLength(0);
  });

  test("4b. スコープの既定は deny: allowedHosts が空なら常に不許可 → 拒否・outbox 0件", async () => {
    issueConnection("locked", []); // 何も許可しない(既定 deny)。
    const bridges = buildCapabilityBridges({
      db,
      declaredCapabilities: ["locked"],
      actor: "user-1",
    });

    const result = await runIsland({
      code: `(input) => locked({ destination: "https://api.example.com/x", payload: {} })`,
      input: {},
      limits: LIMITS,
      hostFunctions: bridges,
    });

    expect(result).toMatchObject({ status: "success", output: { ok: false } });
    expect(pendingOutbox()).toHaveLength(0);
  });

  test("5. 宣言 + 付与された ai_capability → 上限内なら ai_jobs に pending 1件", async () => {
    issueAiCapability("summarizer", { maxCallsPerDay: 100, maxCostUsdPerDay: 10 });
    setWorkflowClock(AI_FIXED_CLOCK);
    const bridges = buildCapabilityBridges({
      db,
      declaredCapabilities: ["summarizer"],
      actor: "user-7",
      workflowId: "wf-island",
    });

    const code = `(input) => summarizer({ prompt: "要約して", input: { text: input.text }, outputField: "summary", targetTable: "docs", targetRecordId: input.id })`;
    const result = await runIsland({
      code,
      input: { text: "長い本文", id: "rec-1" },
      limits: LIMITS,
      hostFunctions: bridges,
    });

    expect(result).toMatchObject({
      status: "success",
      output: { ok: true, kind: "ai_capability" },
    });
    const jobs = pendingJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.prompt).toBe("要約して");
    expect(jobs[0]?.input).toEqual({ text: "長い本文" });
    expect(jobs[0]?.workflowId).toBe("wf-island");
    expect(jobs[0]?.actor).toBe("user-7");
    expect(jobs[0]?.targetTable).toBe("docs");
    expect(jobs[0]?.targetRecordId).toBe("rec-1");
    expect(jobs[0]?.outputField).toBe("summary");
  });

  test("6. AI 日次上限超過 → 拒否・ai_jobs 0件 かつ ai_usage に status:'blocked' が1件", async () => {
    // maxCallsPerDay: 0 = 当日 0 回でも「0 >= 0」で上限到達(常に超過)。
    issueAiCapability("summarizer", { maxCallsPerDay: 0, maxCostUsdPerDay: 10 });
    setWorkflowClock(AI_FIXED_CLOCK);
    const bridges = buildCapabilityBridges({
      db,
      declaredCapabilities: ["summarizer"],
      actor: "user-7",
      workflowId: "wf-island",
    });

    const result = await runIsland({
      code: `(input) => summarizer({ prompt: "要約して", input: {}, outputField: "summary" })`,
      input: {},
      limits: LIMITS,
      hostFunctions: bridges,
    });

    expect(result).toMatchObject({ status: "success", output: { ok: false } });
    expect(pendingJobs()).toHaveLength(0);
    // 黙って止めない: blocked を1件記録する(監査証跡。§4/§5)。
    const blocked = usageRows().filter((u) => u.status === "blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.actor).toBe("user-7");
    expect(blocked[0]?.workflowId).toBe("wf-island");
  });
});

describe("島 capability ブリッジの迂回試行(アンビエント権限ゼロ + スコープ照合の突破不能)", () => {
  test("7a. fetch/require/process/globalThis/Function コンストラクタから外へ出られない・別 capability B も見えない", async () => {
    // alpha は宣言 + 付与。beta は**発行済みだが宣言していない**(= 島からは見えないはず)。
    issueConnection("alpha", ["alpha.example.com"]);
    issueConnection("beta", ["beta.example.com"]);
    const bridges = buildCapabilityBridges({
      db,
      declaredCapabilities: ["alpha"],
      actor: "user-1",
    });

    const code = `(input) => {
      // Function コンストラクタで動的にコードを作っても、同じ VM の中に閉じている。
      const dyn = new Function("return typeof fetch + ',' + typeof process + ',' + typeof require");
      return {
        fetch: typeof fetch,
        require: typeof require,
        process: typeof process,
        globalThisFetch: typeof globalThis.fetch,
        beta: typeof beta,
        alpha: typeof alpha,
        dynamic: dyn(),
      };
    }`;
    const result = await runIsland({ code, input: {}, limits: LIMITS, hostFunctions: bridges });

    expect(result).toMatchObject({
      status: "success",
      output: {
        fetch: "undefined",
        require: "undefined",
        process: "undefined",
        globalThisFetch: "undefined",
        beta: "undefined",
        alpha: "function",
        dynamic: "undefined,undefined,undefined",
      },
    });
    // 探りを入れただけで、投函は1件も無い。
    expect(pendingOutbox()).toHaveLength(0);
  });

  test("7b. 宣言した alpha のブリッジ経由で、alpha のスコープ外の宛先(=別接続 beta の許可先)へ到達しようとしても弾かれる", async () => {
    issueConnection("alpha", ["alpha.example.com"]);
    issueConnection("beta", ["beta.example.com"]);
    const bridges = buildCapabilityBridges({
      db,
      declaredCapabilities: ["alpha"],
      actor: "user-1",
    });

    // beta.example.com は beta の許可先だが、alpha の許可先ではない。
    // alpha のブリッジを通す限り、照合は alpha.allowedHosts で行われるので弾かれる。
    const result = await runIsland({
      code: `(input) => alpha({ destination: "https://beta.example.com/x", payload: {} })`,
      input: {},
      limits: LIMITS,
      hostFunctions: bridges,
    });

    expect(result).toMatchObject({ status: "success", output: { ok: false } });
    expect(pendingOutbox()).toHaveLength(0);
  });

  test("7c. app DB が :memory: 等でアプリを特定できない → 全 capability が拒否・投函0件", async () => {
    // parseAppDbPath が throw する DB でブリッジを作ると、宣言済みでも全て拒否になる(fail-closed)。
    const memDb = new Database(":memory:");
    try {
      const bridges = buildCapabilityBridges({
        db: memDb,
        declaredCapabilities: ["alpha"],
        actor: "user-1",
      });
      const result = await runIsland({
        code: `(input) => alpha({ destination: "https://alpha.example.com/x", payload: {} })`,
        input: {},
        limits: LIMITS,
        hostFunctions: bridges,
      });
      expect(result).toMatchObject({ status: "success", output: { ok: false } });
      expect(pendingOutbox()).toHaveLength(0);
      expect(pendingJobs()).toHaveLength(0);
    } finally {
      memDb.close();
    }
  });
});
