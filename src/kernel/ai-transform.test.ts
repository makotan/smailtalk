import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiCapabilityStore, type AiLimit } from "./ai-capability-store.ts";
import { dispatchAiJobs } from "./ai-dispatcher.ts";
import { AI_MAX_CHAIN_DEPTH } from "./ai-limits.ts";
import type { AiProvider } from "./ai-provider.ts";
import { applyManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { createRecord, getRecord } from "./records.ts";
import { validateReferentialIntegrity } from "./referential-integrity.ts";
import { appDbPath } from "./storage-paths.ts";
import type { Manifest, Workflow } from "./types.ts";

/**
 * `ai_transform` の実行層遮断・配送・メータリング・上限・連鎖停止(V1-M5-T02〜T04 / ADR-0021)。
 *
 * `call_external.test.ts` の兄弟。遮断は runAction(実行層)にあり、許可(capability あり +
 * 当日上限内)だけが ai_jobs に積まれ、実際の推論・出力検証・書き戻しは非同期の
 * `dispatchAiJobs` が担う。**provider は注入で差し替える**(実 CLI / 実ネットワークに触れない)。
 */

const APP_ID = "ai-app";
const DEFAULT_LIMIT: AiLimit = { maxCallsPerDay: 100, maxCostUsdPerDay: 10 };

function historyFields() {
  return [
    { id: "ran_at", name: "実行時刻", type: "date" as const },
    { id: "workflow", name: "ワークフロー", type: "text" as const },
    { id: "trigger_type", name: "きっかけ", type: "text" as const },
    { id: "status", name: "結果", type: "text" as const },
    { id: "error", name: "エラー", type: "long_text" as const },
  ];
}

/** tickets(text + select category)+ 履歴。ai_transform ワークフロー1本を持つ。 */
function classifierManifest(): Manifest {
  const workflow: Workflow = {
    id: "auto-classify",
    name: "入力文を自動分類",
    trigger: { type: "on_create", table: "tickets" },
    actions: [
      {
        action: "ai_transform",
        capability: "classifier",
        prompt: "この問い合わせ文を分類してください。",
        input: { text: "$record.text" },
        output_field: "category",
        fallback: "question",
      },
    ],
    history_table: "wf-runs",
  };
  return {
    app: {
      id: APP_ID,
      name: "AI 分類テスト",
      tables: [
        {
          id: "tickets",
          name: "問い合わせ",
          fields: [
            { id: "text", name: "本文", type: "text", required: true },
            {
              id: "category",
              name: "分類",
              type: "select",
              options: ["bug", "feature", "question"],
            },
          ],
        },
        { id: "wf-runs", name: "実行履歴", fields: historyFields() },
      ],
      views: [],
      workflows: [workflow],
    },
  };
}

let dataRoot: string;
let db: Database;
let manifest: Manifest;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-ai-transform-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "AI 分類テスト", { app_id: APP_ID });
  } finally {
    store.close();
  }
  const applied = applyManifest(dataRoot, APP_ID, classifierManifest());
  if (!applied.valid) {
    throw new Error(`前提のマニフェスト投入に失敗: ${JSON.stringify(applied.errors)}`);
  }
  manifest = applied.manifest;
  db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
});

afterEach(async () => {
  db.close();
  await rm(dataRoot, { recursive: true, force: true });
});

function issueCapability(overrides?: {
  model?: string;
  limit?: AiLimit;
  provider?: "claude_cli" | "openai_compatible";
}): void {
  const store = AiCapabilityStore.openForKernel(dataRoot);
  try {
    store.createCapability({
      appId: APP_ID,
      name: "classifier",
      provider: overrides?.provider ?? "claude_cli",
      model: overrides?.model ?? "claude-opus-4-8",
      limit: overrides?.limit ?? DEFAULT_LIMIT,
    });
  } finally {
    store.close();
  }
}

function withStore<T>(fn: (store: AiCapabilityStore) => T): T {
  const store = AiCapabilityStore.openForKernel(dataRoot);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/** カテゴリを1つ返す provider(呼び出し回数も数える)。 */
function fakeProvider(
  value: string,
  tokens = { input: 120, output: 6 },
): { provider: AiProvider; get calls(): number } {
  let calls = 0;
  const provider: AiProvider = async () => {
    calls += 1;
    return { text: `{"value":"${value}"}`, inputTokens: tokens.input, outputTokens: tokens.output };
  };
  return {
    provider,
    get calls() {
      return calls;
    },
  };
}

function readCategory(id: string): unknown {
  const result = getRecord(db, manifest, "tickets", id);
  if (!result.ok || result.value === null) {
    throw new Error(`レコードを読めません: ${id}`);
  }
  return result.value.category;
}

describe("実行層の遮断(enqueue)", () => {
  test("capability が無ければ ai_jobs に1件も積まれない(fail-closed)", () => {
    // capability を発行しない。
    // 【V3-M13-T02 / ADR-0066 による期待値の更新】遮断は**アクションの失敗**なので、
    // 決定が変わって**発火元の書込ごと成立しなくなった**。遮断そのものは変わっていない。
    const created = createRecord(db, manifest, "tickets", { text: "落ちます" });
    expect(created.ok).toBe(false);
    expect(withStore((s) => s.listPendingJobs())).toHaveLength(0);
  });

  test("capability があれば prompt/input 解決済みのジョブが1件積まれる", () => {
    issueCapability();
    const created = createRecord(db, manifest, "tickets", { text: "ログインできない" });
    expect(created.ok).toBe(true);
    const jobs = withStore((s) => s.listPendingJobs());
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.input).toEqual({ text: "ログインできない" });
    expect(jobs[0]?.outputField).toBe("category");
    expect(jobs[0]?.fallback).toBe("question");
    expect(jobs[0]?.chainDepth).toBe(0);
  });
});

describe("配送(dispatch)+ メータリング + フォールバック", () => {
  test("正常系: AI が選択肢を返す → category が埋まり、usage に success 1件が記録される", async () => {
    issueCapability({ model: "claude-opus-4-8" });
    const created = createRecord(db, manifest, "tickets", { text: "ボタンが反応しない" });
    if (!created.ok) throw new Error("setup");

    const provider = fakeProvider("bug");
    const result = await dispatchAiJobs(dataRoot, provider.provider);
    expect(result.done).toBe(1);
    expect(provider.calls).toBe(1);

    // 書き戻し: select フィールドが埋まった(CP-V1-5 点1「入力文を自動分類する」)。
    expect(readCategory(created.value._id)).toBe("bug");

    // メータリング: success 1件・トークン・推定コスト > 0(既知モデル)。
    const usage = withStore((s) => s.listUsage(APP_ID));
    expect(usage).toHaveLength(1);
    expect(usage[0]?.status).toBe("success");
    expect(usage[0]?.inputTokens).toBe(120);
    expect(usage[0]?.outputTokens).toBe(6);
    expect(usage[0]?.costUsd).toBeGreaterThan(0);
    expect(usage[0]?.workflowId).toBe("auto-classify");
  });

  test("不正出力(選択肢外)→ フォールバックを書き戻し、呼び出しは success として記録(課金は発生)", async () => {
    issueCapability();
    const created = createRecord(db, manifest, "tickets", { text: "?" });
    if (!created.ok) throw new Error("setup");

    // "urgent" は options に無い → updateRecord が拒否 → fallback "question"。
    const result = await dispatchAiJobs(dataRoot, fakeProvider("urgent").provider);
    expect(result.failed).toBe(1); // ジョブは failed(フォールバックを書いた)
    expect(readCategory(created.value._id)).toBe("question");

    // **呼び出し自体は起きた(トークンを消費した)ので usage は success。**
    const usage = withStore((s) => s.listUsage(APP_ID));
    expect(usage).toHaveLength(1);
    expect(usage[0]?.status).toBe("success");
  });

  test("解釈不能な出力 → フォールバック", async () => {
    issueCapability();
    const created = createRecord(db, manifest, "tickets", { text: "?" });
    if (!created.ok) throw new Error("setup");

    const junkProvider: AiProvider = async () => ({
      text: "たぶんバグだと思います(JSON ではない散文)",
      inputTokens: 10,
      outputTokens: 10,
    });
    await dispatchAiJobs(dataRoot, junkProvider);
    expect(readCategory(created.value._id)).toBe("question");
  });

  test("provider が例外 → フォールバックを書き戻し、usage は failure として記録", async () => {
    issueCapability();
    const created = createRecord(db, manifest, "tickets", { text: "?" });
    if (!created.ok) throw new Error("setup");

    const boomProvider: AiProvider = async () => {
      throw new Error("network down");
    };
    const result = await dispatchAiJobs(dataRoot, boomProvider);
    expect(result.failed).toBe(1);
    expect(readCategory(created.value._id)).toBe("question");

    const usage = withStore((s) => s.listUsage(APP_ID));
    expect(usage).toHaveLength(1);
    expect(usage[0]?.status).toBe("failure");
  });

  test("未知モデルは推定コスト 0 で記録される(捏造しない)", async () => {
    issueCapability({ model: "some-unlisted-model" });
    const created = createRecord(db, manifest, "tickets", { text: "x" });
    if (!created.ok) throw new Error("setup");

    await dispatchAiJobs(dataRoot, fakeProvider("bug").provider);
    const usage = withStore((s) => s.listUsage(APP_ID));
    expect(usage[0]?.status).toBe("success");
    expect(usage[0]?.costUsd).toBe(0);
  });
});

describe("メータリングの完全性(記録漏れ経路が無い。CP-V1-5 点3)", () => {
  test("provider を呼んだ回数と usage(success+failure)の件数が一致する", async () => {
    issueCapability();
    for (const text of ["a", "b", "c"]) {
      const created = createRecord(db, manifest, "tickets", { text });
      if (!created.ok) throw new Error("setup");
    }
    const provider = fakeProvider("bug");
    await dispatchAiJobs(dataRoot, provider.provider);

    const usage = withStore((s) => s.listUsage(APP_ID));
    const called = usage.filter((u) => u.status === "success" || u.status === "failure").length;
    // **呼んだ回数 == 記録された呼び出し数。**記録なしに呼べる経路が無いことの実証。
    expect(called).toBe(provider.calls);
    expect(provider.calls).toBe(3);
  });
});

describe("コスト上限と暴走防止(T04)", () => {
  test("回数上限 0 → enqueue で遮断され、ジョブは積まれず blocked が記録される", () => {
    issueCapability({ limit: { maxCallsPerDay: 0, maxCostUsdPerDay: 10 } });
    // 【期待値の更新】上限超過も**アクションの失敗**なので、書込ごと成立しない(ADR-0066)。
    // **上限の判定と blocked の記録は1バイトも変わっていない**(下の2行が測っている)。
    const created = createRecord(db, manifest, "tickets", { text: "x" });
    expect(created.ok).toBe(false);

    expect(withStore((s) => s.listPendingJobs())).toHaveLength(0);
    const usage = withStore((s) => s.listUsage(APP_ID));
    expect(usage).toHaveLength(1);
    expect(usage[0]?.status).toBe("blocked");
  });

  test("上限に達すると以後の呼び出しが止まる(1回目 success・2回目 blocked)", async () => {
    issueCapability({ limit: { maxCallsPerDay: 1, maxCostUsdPerDay: 10 } });

    const first = createRecord(db, manifest, "tickets", { text: "1件目" });
    if (!first.ok) throw new Error("setup");
    await dispatchAiJobs(dataRoot, fakeProvider("bug").provider);
    expect(readCategory(first.value._id)).toBe("bug");

    // 2件目: 当日 usage が1件(success)= 上限 1 に達している → enqueue で遮断。
    // 【期待値の更新】遮断されたので、2件目の書込自体が成立しない(ADR-0066)。
    const second = createRecord(db, manifest, "tickets", { text: "2件目" });
    expect(second.ok).toBe(false);
    expect(withStore((s) => s.listPendingJobs())).toHaveLength(0);

    const usage = withStore((s) => s.listUsage(APP_ID));
    expect(usage.filter((u) => u.status === "success")).toHaveLength(1);
    expect(usage.filter((u) => u.status === "blocked")).toHaveLength(1);
  });

  test("連鎖深度上限に達したジョブは配送時に blocked(推論を呼ばない)", async () => {
    issueCapability();
    // chain_depth = AI_MAX_CHAIN_DEPTH のジョブを直接積む(連鎖の末端を模す)。
    const capId = withStore((s) => s.findCapabilityByName(APP_ID, "classifier"))?.id;
    if (capId === undefined) throw new Error("capability missing");
    const ticket = createRecord(
      db,
      { ...manifest, app: { ...manifest.app, workflows: [] } },
      "tickets",
      {
        text: "末端",
      },
    );
    if (!ticket.ok) throw new Error("setup");
    withStore((s) =>
      s.enqueueJob({
        appId: APP_ID,
        capabilityId: capId,
        workflowId: "auto-classify",
        actor: null,
        prompt: "分類",
        input: {},
        outputField: "category",
        fallback: "question",
        targetTable: "tickets",
        targetRecordId: ticket.value._id,
        chainDepth: AI_MAX_CHAIN_DEPTH,
      }),
    );

    const provider = fakeProvider("bug");
    const result = await dispatchAiJobs(dataRoot, provider.provider);
    expect(result.blocked).toBe(1);
    expect(provider.calls).toBe(0); // **推論を呼んでいない。**
    const usage = withStore((s) => s.listUsage(APP_ID));
    expect(usage.filter((u) => u.status === "blocked")).toHaveLength(1);
  });
});

describe("apply 時の静的検査", () => {
  test("schedule トリガーの ai_transform は参照整合性が拒否する(valid なのに動かないを作らない)", () => {
    const bad: Manifest = classifierManifest();
    // workflow を schedule に差し替える。
    bad.app.workflows = [
      {
        id: "bad",
        name: "ダメ",
        trigger: { type: "schedule", at: { hour: 9, minute: 0 } },
        actions: [
          {
            action: "ai_transform",
            capability: "classifier",
            prompt: "x",
            input: {},
            output_field: "category",
            fallback: "question",
          },
        ],
        history_table: "wf-runs",
      },
    ];
    const result = validateReferentialIntegrity(bad);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("should be invalid");
    expect(result.errors.some((e) => e.message.includes("ai_transform"))).toBe(true);
  });
});

describe("_ai_usage の投影(集計可能。CP-V1-5 点3)", () => {
  test("記録された使用量が _ai_usage システムテーブルから読める", async () => {
    issueCapability();
    const created = createRecord(db, manifest, "tickets", { text: "x" });
    if (!created.ok) throw new Error("setup");
    await dispatchAiJobs(dataRoot, fakeProvider("bug").provider);

    const usage = withStore((s) => s.listAllUsage());
    expect(usage).toHaveLength(1);
    expect(usage[0]?.appId).toBe(APP_ID);
  });
});
