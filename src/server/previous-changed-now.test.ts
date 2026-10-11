/**
 * **更新前の値(`$previous.<項目>`)・`changed_fields`・今の時刻(`$now`)**(`V23-M4-T04`。
 * `D-V23-95`・`D-V23-96`・`D-V23-101`・`D-V23-104`・`D-V23-105`。 門A `ADR-0500` 限定15・17・18 /
 * `ADR-0524` §Decision 1-2・1-3 と限定15・18)。
 *
 * - 入口ごと(HTTP の PATCH・一括・連鎖・島の `write_ops`・AI の書き戻し)に、`$previous.x` が
 *   更新前の値になる。 MCP の2道具は `previous-changed-now-mcp.test.ts`。 受信口は行を作るだけで
 *   更新の口を持たない(`inbound-route.ts` に `updateRecord` の呼び出しは0件)。
 * - `changed_fields`: 列挙したどれかが「変わった」ときだけ発火し、変わらなければ発火も履歴の行も無い。
 *   「変わった」は `null`・`""` を同じ空、boolean は空と `false` を同じ、number は数の等価、
 *   それ以外は文字列の等価。 書かないワークフローは今日どおり毎回。 自分の表の別の項目を書く更新で
 *   再発火しない(抑止の履歴の行も書かない)。
 * - `$now`: 時刻源は `getWorkflowClock` の1つだけ。 `date` の項目には年月日、それ以外は時差付きの秒まで。
 *   時間帯は `ST_TIMEZONE`(無効・無しなら `Asia/Tokyo`)。
 * - 受け入れ基準1 の核: 評価の表を HTTP で更新すると、履歴の表に「操作者・更新前・更新後・時刻」の1行。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiCapabilityStore } from "../kernel/ai-capability-store.ts";
import { dispatchAiJobs } from "../kernel/ai-dispatcher.ts";
import type { AiProvider } from "../kernel/ai-provider.ts";
import {
  appDbPath,
  applyManifest,
  createApp,
  KernelMetaStore,
  type Manifest,
} from "../kernel/index.ts";
import { ensureIslandRuntimeReady } from "../kernel/island-runner.ts";
import { resetWorkflowClock, setWorkflowClock } from "../kernel/workflow-runner.ts";
import { createServerApp } from "./app.ts";
import {
  type SeededSession,
  seedSession,
  TEST_ORIGIN,
  withDefaultRoleRules,
} from "./test-helpers.ts";

const APP_ID = "previous-changed-now";

const HISTORY_FIELDS = [
  { id: "ran_at", name: "実行時刻", type: "date" },
  { id: "workflow", name: "ワークフロー", type: "text" },
  { id: "trigger_type", name: "きっかけ", type: "text" },
  { id: "status", name: "結果", type: "text" },
  { id: "error", name: "エラー", type: "long_text" },
];

/** 評価の表に掛ける `on_update` の記録(`src` でどれが書いたかを見分ける)。 */
function logOnUpdate(
  id: string,
  src: string,
  changedFields: string[] | undefined,
  values: Record<string, string> = {},
): Record<string, unknown> {
  return {
    id,
    name: id,
    trigger: {
      type: "on_update",
      table: "assessments",
      ...(changedFields === undefined ? {} : { changed_fields: changedFields }),
    },
    history_table: "wf_log",
    actions: [
      {
        action: "create_record",
        table: "assessment_log",
        values: { src, item: "$record._id", ...values },
      },
    ],
  };
}

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "更新前と今",
      tables: [
        {
          id: "holders",
          name: "担当",
          fields: [
            { id: "name", name: "名前", type: "text" },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
        {
          id: "assessments",
          name: "評価",
          fields: [
            { id: "verdict", name: "判定", type: "text" },
            { id: "score", name: "点", type: "number" },
            { id: "flag", name: "印", type: "boolean" },
            { id: "memo", name: "メモ", type: "text" },
            { id: "due", name: "期日", type: "date" },
            { id: "other", name: "その他", type: "text" },
          ],
        },
        {
          id: "assessment_log",
          name: "評価の履歴",
          fields: [
            { id: "src", name: "出どころ", type: "text" },
            { id: "item", name: "対象", type: "text" },
            { id: "actor", name: "操作者", type: "text" },
            { id: "before", name: "更新前", type: "text" },
            { id: "after", name: "更新後", type: "text" },
            { id: "before_score", name: "更新前の点", type: "number" },
            { id: "at", name: "時刻", type: "text" },
            { id: "at_date", name: "日付", type: "date" },
          ],
        },
        {
          id: "orders",
          name: "指図",
          fields: [
            { id: "target", name: "対象", type: "reference", reference_table: "assessments" },
            { id: "newv", name: "新しい判定", type: "text" },
          ],
        },
        {
          id: "pokes",
          name: "島への指図",
          fields: [
            { id: "target", name: "対象", type: "text" },
            { id: "v", name: "値", type: "text" },
          ],
        },
        {
          id: "tickets",
          name: "票",
          fields: [
            { id: "state", name: "状態", type: "text" },
            { id: "touched", name: "触った時刻", type: "text" },
            { id: "touched_on", name: "触った日", type: "date" },
          ],
        },
        {
          id: "aitab",
          name: "AI の対象",
          fields: [
            { id: "memo", name: "メモ", type: "text" },
            { id: "label", name: "ラベル", type: "text" },
            { id: "holder", name: "担当", type: "reference", reference_table: "holders" },
          ],
        },
        { id: "wf_log", name: "実行履歴", fields: HISTORY_FIELDS },
      ],
      views: [],
      functions: [
        {
          id: "isl",
          name: "島が評価を直す",
          code: 'export default function (input) { const poke = input[0]; const row = input[1].find((r) => r._id === poke.target); return [{ op: "update", table: "assessments", target: row._id, if_match: row._updated_at, values: { verdict: poke.v } }]; }',
          input: [{ source: "record" }, { source: "table", table: "assessments" }],
          output: { ops: true },
        },
      ],
      workflows: [
        // 受け入れ基準1 の核: 操作者・更新前・更新後・時刻。
        logOnUpdate("wf_hist", "hist", ["verdict"], {
          actor: "$actor.id",
          before: "$previous.verdict",
          after: "$record.verdict",
          at: "$now",
          at_date: "$now",
        }),
        // changed_fields を書かない = 今日どおり毎回。
        logOnUpdate("wf_every", "every", undefined, {
          before: "$previous.memo",
          after: "$record.memo",
        }),
        logOnUpdate("wf_num", "num", ["score"], { before_score: "$previous.score" }),
        logOnUpdate("wf_flag", "flag", ["flag"]),
        logOnUpdate("wf_due", "due", ["due"]),
        logOnUpdate("wf_multi", "multi", ["verdict", "score"]),
        // 連鎖: 指図の作成 → 評価の更新 → wf_hist。
        {
          id: "wf_order",
          name: "指図で評価を直す",
          trigger: { type: "on_create", table: "orders" },
          history_table: "wf_log",
          actions: [
            {
              action: "update_record",
              table: "assessments",
              target: "$record.target",
              values: { verdict: "$record.newv" },
            },
          ],
        },
        // 島の write_ops: 島への指図の作成 → 島が評価を直す → wf_hist。
        {
          id: "wf_poke",
          name: "島を走らせる",
          trigger: { type: "on_create", table: "pokes" },
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "isl", write_ops: true }],
        },
        // 再発火しない: 状態が変わったら、同じ行の別の項目に今の時刻を書く。
        {
          id: "wf_touch",
          name: "触った時刻を書く",
          trigger: { type: "on_update", table: "tickets", changed_fields: ["state"] },
          history_table: "wf_log",
          actions: [
            {
              action: "update_record",
              table: "tickets",
              target: "$record._id",
              values: { touched: "$now", touched_on: "$now" },
            },
          ],
        },
        {
          id: "wf_tlog",
          name: "票の状態を記録する",
          trigger: { type: "on_update", table: "tickets", changed_fields: ["state"] },
          history_table: "wf_log",
          actions: [
            {
              action: "create_record",
              table: "assessment_log",
              values: {
                src: "ticket",
                item: "$record._id",
                before: "$previous.state",
                after: "$record.state",
              },
            },
          ],
        },
        // AI の書き戻し: メモが変わったらラベルを付ける。 ラベルが変わったら記録する。
        {
          id: "wf_ai",
          name: "AI でラベルを付ける",
          trigger: { type: "on_update", table: "aitab", changed_fields: ["memo"] },
          history_table: "wf_log",
          act_as: "$record.holder",
          actions: [
            {
              action: "ai_transform",
              capability: "labeler",
              prompt: "ラベルを決めてください。",
              input: { memo: "$record.memo" },
              output_field: "label",
              fallback: "none",
            },
          ],
        },
        {
          id: "wf_ai_log",
          name: "ラベルを記録する",
          trigger: { type: "on_update", table: "aitab", changed_fields: ["label"] },
          history_table: "wf_log",
          actions: [
            {
              action: "create_record",
              table: "assessment_log",
              values: {
                src: "ai",
                item: "$record._id",
                before: "$previous.label",
                after: "$record.label",
              },
            },
          ],
        },
      ],
    },
  } as unknown as Manifest;
}

type Rig = {
  dataRoot: string;
  server: ReturnType<typeof createServerApp>;
  alice: SeededSession;
  bob: SeededSession;
  carol: SeededSession;
};

const dataRoots: string[] = [];
const savedTimeZone = process.env.ST_TIMEZONE;

beforeAll(async () => {
  await ensureIslandRuntimeReady();
});

afterEach(async () => {
  resetWorkflowClock();
  if (savedTimeZone === undefined) {
    delete process.env.ST_TIMEZONE;
  } else {
    process.env.ST_TIMEZONE = savedTimeZone;
  }
  for (const dir of dataRoots.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeRig(m: Manifest = manifest()): Promise<Rig> {
  const dataRoot = await mkdtemp(join(tmpdir(), "gp-previous-changed-now-"));
  dataRoots.push(dataRoot);
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, "更新前と今", { app_id: APP_ID });
  } finally {
    meta.close();
  }
  const applied = applyManifest(dataRoot, APP_ID, withDefaultRoleRules(m));
  if (!applied.valid) {
    throw new Error(JSON.stringify(applied.errors));
  }
  seedSession(dataRoot, APP_ID, { role: "owner", username: "boss" });
  return {
    dataRoot,
    server: createServerApp({ dataRoot }),
    alice: seedSession(dataRoot, APP_ID, { role: "editor", username: "alice" }),
    bob: seedSession(dataRoot, APP_ID, { role: "editor", username: "bob" }),
    carol: seedSession(dataRoot, APP_ID, { role: "editor", username: "carol" }),
  };
}

async function send(
  rig: Rig,
  who: SeededSession,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return await rig.server.request(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        origin: TEST_ORIGIN,
        cookie: who.cookie,
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

const recordsPath = (table: string): string => `/api/apps/${APP_ID}/tables/${table}/records`;

async function mustCreate(
  rig: Rig,
  who: SeededSession,
  table: string,
  values: Record<string, unknown>,
): Promise<string> {
  const res = await send(rig, who, "POST", recordsPath(table), values);
  if (res.status !== 201) {
    throw new Error(`${table} に行を置けない: ${res.status} ${await res.text()}`);
  }
  return ((await res.json()) as { record: { _id: string } }).record._id;
}

/** 行の今の版(`_updated_at`)を If-Match に付けて更新し、200 を確かめる。 */
async function mustPatch(
  rig: Rig,
  who: SeededSession,
  table: string,
  id: string,
  values: Record<string, unknown>,
): Promise<void> {
  const version = rowsOf(rig, table).find((row) => row._id === id)?._updated_at;
  const res = await send(rig, who, "PATCH", `${recordsPath(table)}/${id}`, values, {
    "if-match": String(version),
  });
  if (res.status !== 200) {
    throw new Error(`${table} を更新できない: ${res.status} ${await res.text()}`);
  }
}

function rowsOf(rig: Rig, table: string): Record<string, unknown>[] {
  const db = new Database(appDbPath(rig.dataRoot, APP_ID), { readonly: true });
  try {
    return db.query<Record<string, unknown>, []>(`SELECT * FROM "${table}" ORDER BY rowid`).all();
  } finally {
    db.close();
  }
}

function logsOf(rig: Rig, src: string): Record<string, unknown>[] {
  return rowsOf(rig, "assessment_log").filter((row) => row.src === src);
}

/** そのワークフローの実行履歴の行(発火しなければ0行)。 */
function historyOf(rig: Rig, workflow: string): Record<string, unknown>[] {
  return rowsOf(rig, "wf_log").filter((row) => row.workflow === workflow);
}

/** 評価の行を1つ作る(作成は on_update を起こさない)。 */
async function seedAssessment(rig: Rig, values: Record<string, unknown>): Promise<string> {
  return await mustCreate(rig, rig.alice, "assessments", values);
}

describe("V23-M4-T04 受け入れ基準1: 評価の表を更新すると、履歴の表に操作者・更新前・更新後・時刻の1行", () => {
  test("(core) HTTP の PATCH で判定を変えると、$actor.id・$previous.verdict・$record.verdict・$now が1行に入る", async () => {
    const rig = await makeRig();
    const item = await seedAssessment(rig, { verdict: "保留" });
    setWorkflowClock({ now: () => new Date("2026-09-30T01:23:45.678Z") });
    delete process.env.ST_TIMEZONE;
    await mustPatch(rig, rig.bob, "assessments", item, { verdict: "承認" });
    const logs = logsOf(rig, "hist");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      item,
      actor: rig.bob.userId,
      before: "保留",
      after: "承認",
      at: "2026-09-30T10:23:45+09:00",
      at_date: "2026-09-30",
    });
    expect(historyOf(rig, "wf_hist")).toHaveLength(1);
    expect(historyOf(rig, "wf_hist")[0]?.status).toBe("success");
  });
});

describe("V23-M4-T04 入口ごとに $previous.x は更新前の値", () => {
  test("(http-patch) 2回目の更新の $previous は1回目の更新後の値", async () => {
    const rig = await makeRig();
    const item = await seedAssessment(rig, { verdict: "一", memo: "m0" });
    await mustPatch(rig, rig.alice, "assessments", item, { verdict: "二", memo: "m1" });
    await mustPatch(rig, rig.bob, "assessments", item, { verdict: "三", memo: "m2" });
    const logs = logsOf(rig, "hist");
    expect(logs.map((row) => [row.before, row.after])).toEqual([
      ["一", "二"],
      ["二", "三"],
    ]);
    const every = logsOf(rig, "every");
    expect(every.map((row) => [row.before, row.after])).toEqual([
      ["m0", "m1"],
      ["m1", "m2"],
    ]);
  });

  test("(http-number) $previous.<数値の列> は数値のまま数値の列へ入る", async () => {
    const rig = await makeRig();
    const item = await seedAssessment(rig, { score: 3 });
    await mustPatch(rig, rig.alice, "assessments", item, { score: 7 });
    const logs = logsOf(rig, "num");
    expect(logs).toHaveLength(1);
    expect(logs[0]?.before_score).toBe(3);
  });

  test("(http-empty) 更新前が空(未記入)なら $previous は空(null)", async () => {
    const rig = await makeRig();
    const item = await seedAssessment(rig, { memo: "m" });
    await mustPatch(rig, rig.alice, "assessments", item, { verdict: "承認" });
    const logs = logsOf(rig, "hist");
    expect(logs).toHaveLength(1);
    expect(logs[0]?.before).toBeNull();
    expect(logs[0]?.after).toBe("承認");
  });

  test("(http-batch) 一括の更新でも $previous は更新前の値", async () => {
    const rig = await makeRig();
    const item = await seedAssessment(rig, { verdict: "保留" });
    const res = await send(rig, rig.carol, "POST", `/api/apps/${APP_ID}/batch`, {
      ops: [{ op: "update", table: "assessments", target: item, values: { verdict: "却下" } }],
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const logs = logsOf(rig, "hist");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actor: rig.carol.userId, before: "保留", after: "却下" });
  });

  test("(chain) 連鎖の update_record が起こした on_update の $previous は、その行の更新前の値", async () => {
    const rig = await makeRig();
    const item = await seedAssessment(rig, { verdict: "保留" });
    await mustCreate(rig, rig.bob, "orders", { target: item, newv: "連鎖で承認" });
    expect(rowsOf(rig, "assessments")[0]?.verdict).toBe("連鎖で承認");
    const logs = logsOf(rig, "hist");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actor: rig.bob.userId, before: "保留", after: "連鎖で承認" });
  });

  test("(island) 島の write_ops の更新が起こした on_update の $previous は、その行の更新前の値", async () => {
    const rig = await makeRig();
    const item = await seedAssessment(rig, { verdict: "保留" });
    await mustCreate(rig, rig.carol, "pokes", { target: item, v: "島で承認" });
    expect(rowsOf(rig, "assessments")[0]?.verdict).toBe("島で承認");
    const logs = logsOf(rig, "hist");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actor: rig.carol.userId, before: "保留", after: "島で承認" });
  });

  test("(ai) AI の書き戻しが起こした on_update の $previous は書き戻す前の値。 書き戻しでメモの側は再発火しない", async () => {
    const rig = await makeRig();
    const store = AiCapabilityStore.openForKernel(rig.dataRoot);
    try {
      store.createCapability({
        appId: APP_ID,
        name: "labeler",
        provider: "claude_cli",
        model: "claude-opus-4-8",
        limit: { maxCallsPerDay: 100, maxCostUsdPerDay: 10 },
      });
    } finally {
      store.close();
    }
    const holder = await mustCreate(rig, rig.carol, "holders", { name: "かろるの担当" });
    const target = await mustCreate(rig, rig.alice, "aitab", {
      memo: "元",
      label: "旧",
      holder,
    });
    await mustPatch(rig, rig.alice, "aitab", target, { memo: "見直し" });
    expect(historyOf(rig, "wf_ai")).toHaveLength(1);
    // メモだけが変わったので、ラベルの記録は発火しない。
    expect(historyOf(rig, "wf_ai_log")).toHaveLength(0);
    const provider: AiProvider = async () => ({
      text: '{"value":"good"}',
      inputTokens: 1,
      outputTokens: 1,
    });
    await dispatchAiJobs(rig.dataRoot, provider);
    expect(rowsOf(rig, "aitab")[0]?.label).toBe("good");
    const logs = logsOf(rig, "ai");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ item: target, before: "旧", after: "good" });
    // 書き戻しはラベルだけを変えたので、メモの側(AI を呼ぶ側)は再発火しない。
    expect(historyOf(rig, "wf_ai")).toHaveLength(1);
  });
});

describe("V23-M4-T04 changed_fields: 変わったときだけ発火する(ADR-0500 限定18)", () => {
  test("(changed) 列挙した項目が変わった更新で1回、履歴も1行", async () => {
    const rig = await makeRig();
    const item = await seedAssessment(rig, { verdict: "保留", score: 1 });
    await mustPatch(rig, rig.alice, "assessments", item, { verdict: "承認" });
    expect(logsOf(rig, "hist")).toHaveLength(1);
    expect(historyOf(rig, "wf_hist")).toHaveLength(1);
    // 列挙していない点は変わっていない。
    expect(logsOf(rig, "num")).toHaveLength(0);
    expect(historyOf(rig, "wf_num")).toHaveLength(0);
  });

  test("(unchanged-other) 列挙していない項目だけを変えた更新では発火せず、履歴の行も無い。 書かないワークフローは発火する", async () => {
    const rig = await makeRig();
    const item = await seedAssessment(rig, { verdict: "保留" });
    await mustPatch(rig, rig.alice, "assessments", item, { other: "別の項目" });
    for (const src of ["hist", "num", "flag", "due", "multi"]) {
      expect(logsOf(rig, src), src).toHaveLength(0);
    }
    for (const wf of ["wf_hist", "wf_num", "wf_flag", "wf_due", "wf_multi"]) {
      expect(historyOf(rig, wf), wf).toHaveLength(0);
    }
    expect(logsOf(rig, "every")).toHaveLength(1);
    expect(historyOf(rig, "wf_every")).toHaveLength(1);
  });

  test("(screen-save) 画面の保存を模して全項目を同じ値で送る(未記入の真偽は false・未記入の文字は null)と、0回", async () => {
    const rig = await makeRig();
    const item = await seedAssessment(rig, { verdict: "保留", score: 3, due: "2026-09-30" });
    const before = rowsOf(rig, "assessments")[0];
    expect(before?.flag).toBeNull();
    expect(before?.memo).toBeNull();
    await mustPatch(rig, rig.alice, "assessments", item, {
      verdict: "保留",
      score: 3,
      flag: false,
      memo: null,
      due: "2026-09-30",
      other: null,
    });
    for (const wf of ["wf_hist", "wf_num", "wf_flag", "wf_due", "wf_multi"]) {
      expect(historyOf(rig, wf), wf).toHaveLength(0);
    }
    expect(rowsOf(rig, "assessment_log").filter((row) => row.src !== "every")).toHaveLength(0);
    // 書かないワークフローは今日どおり毎回。
    expect(historyOf(rig, "wf_every")).toHaveLength(1);
    // もう一度同じ保存をしても同じ。
    await mustPatch(rig, rig.alice, "assessments", item, {
      verdict: "保留",
      score: 3,
      flag: false,
      memo: null,
      due: "2026-09-30",
      other: null,
    });
    for (const wf of ["wf_hist", "wf_num", "wf_flag", "wf_due", "wf_multi"]) {
      expect(historyOf(rig, wf), wf).toHaveLength(0);
    }
    expect(historyOf(rig, "wf_every")).toHaveLength(2);
  });

  test("(boolean) 真偽の空(null)と false は同じ。 false → true は変わった", async () => {
    const rig = await makeRig();
    const item = await seedAssessment(rig, { verdict: "保留" });
    await mustPatch(rig, rig.alice, "assessments", item, { flag: false });
    expect(historyOf(rig, "wf_flag")).toHaveLength(0);
    await mustPatch(rig, rig.alice, "assessments", item, { flag: true });
    expect(historyOf(rig, "wf_flag")).toHaveLength(1);
    await mustPatch(rig, rig.alice, "assessments", item, { flag: null });
    expect(historyOf(rig, "wf_flag")).toHaveLength(2);
    await mustPatch(rig, rig.alice, "assessments", item, { flag: false });
    expect(historyOf(rig, "wf_flag")).toHaveLength(2);
  });

  test('(empty-string) 文字の空文字と null は同じ空(null → ""、"" → null のどちらも0回)', async () => {
    const rig = await makeRig();
    const item = await seedAssessment(rig, { memo: "m" });
    expect(rowsOf(rig, "assessments")[0]?.verdict).toBeNull();
    await mustPatch(rig, rig.alice, "assessments", item, { verdict: "" });
    expect(rowsOf(rig, "assessments")[0]?.verdict).toBe("");
    expect(historyOf(rig, "wf_hist")).toHaveLength(0);
    await mustPatch(rig, rig.alice, "assessments", item, { verdict: null });
    expect(historyOf(rig, "wf_hist")).toHaveLength(0);
    await mustPatch(rig, rig.alice, "assessments", item, { verdict: "承認" });
    expect(historyOf(rig, "wf_hist")).toHaveLength(1);
  });

  test("(number) 数は数として比べる。 同じ数は0回、違う数・空への変化は1回ずつ", async () => {
    const rig = await makeRig();
    const item = await seedAssessment(rig, { score: 1 });
    await mustPatch(rig, rig.alice, "assessments", item, { score: 1.0 });
    expect(historyOf(rig, "wf_num")).toHaveLength(0);
    await mustPatch(rig, rig.alice, "assessments", item, { score: 2 });
    expect(historyOf(rig, "wf_num")).toHaveLength(1);
    await mustPatch(rig, rig.alice, "assessments", item, { score: 0 });
    expect(historyOf(rig, "wf_num")).toHaveLength(2);
    await mustPatch(rig, rig.alice, "assessments", item, { score: null });
    expect(historyOf(rig, "wf_num")).toHaveLength(3);
  });

  test("(date) 日付の書き方の違い(2026-09-30 と 2026-09-30T00:00:00Z)は変わったとみなす", async () => {
    const rig = await makeRig();
    const item = await seedAssessment(rig, { due: "2026-09-30" });
    await mustPatch(rig, rig.alice, "assessments", item, { due: "2026-09-30" });
    expect(historyOf(rig, "wf_due")).toHaveLength(0);
    await mustPatch(rig, rig.alice, "assessments", item, { due: "2026-09-30T00:00:00Z" });
    expect(historyOf(rig, "wf_due")).toHaveLength(1);
  });

  test("(any-of) 列挙したどれか1つが変われば発火する", async () => {
    const rig = await makeRig();
    const item = await seedAssessment(rig, { verdict: "保留", score: 1 });
    await mustPatch(rig, rig.alice, "assessments", item, { score: 5 });
    expect(historyOf(rig, "wf_multi")).toHaveLength(1);
    await mustPatch(rig, rig.alice, "assessments", item, { verdict: "承認" });
    expect(historyOf(rig, "wf_multi")).toHaveLength(2);
    await mustPatch(rig, rig.alice, "assessments", item, { other: "x" });
    expect(historyOf(rig, "wf_multi")).toHaveLength(2);
  });

  test("(no-refire) 自分の表の別の項目を update_record しても再発火せず、抑止の履歴の行も書かない", async () => {
    const rig = await makeRig();
    const ticket = await mustCreate(rig, rig.alice, "tickets", { state: "新規" });
    setWorkflowClock({ now: () => new Date("2026-09-30T01:23:45.678Z") });
    delete process.env.ST_TIMEZONE;
    await mustPatch(rig, rig.bob, "tickets", ticket, { state: "対応中" });
    const row = rowsOf(rig, "tickets")[0];
    expect(row?.touched).toBe("2026-09-30T10:23:45+09:00");
    expect(row?.touched_on).toBe("2026-09-30");
    expect(historyOf(rig, "wf_touch").map((h) => h.status)).toEqual(["success"]);
    expect(historyOf(rig, "wf_tlog").map((h) => h.status)).toEqual(["success"]);
    expect(rowsOf(rig, "wf_log").filter((h) => h.status === "suppressed")).toHaveLength(0);
    const logs = logsOf(rig, "ticket");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ before: "新規", after: "対応中" });
  });
});

describe("V23-M4-T04 $now(ADR-0500 限定17・D-V23-104)", () => {
  const LATE_UTC = "2026-09-30T20:00:00.000Z";

  async function histAt(timeZone: string | undefined): Promise<Record<string, unknown>> {
    const rig = await makeRig();
    const item = await seedAssessment(rig, { verdict: "保留" });
    setWorkflowClock({ now: () => new Date(LATE_UTC) });
    if (timeZone === undefined) {
      delete process.env.ST_TIMEZONE;
    } else {
      process.env.ST_TIMEZONE = timeZone;
    }
    await mustPatch(rig, rig.alice, "assessments", item, { verdict: "承認" });
    const logs = logsOf(rig, "hist");
    expect(logs).toHaveLength(1);
    return logs[0] as Record<string, unknown>;
  }

  test("(now-default) 時間帯の指定が無ければ Asia/Tokyo。 date の列は年月日、text の列は時差付きの秒まで", async () => {
    const log = await histAt(undefined);
    expect(log.at).toBe("2026-10-01T05:00:00+09:00");
    expect(log.at_date).toBe("2026-10-01");
  });

  test("(now-utc) ST_TIMEZONE=UTC なら時差は +00:00、日付も UTC の日", async () => {
    const log = await histAt("UTC");
    expect(log.at).toBe("2026-09-30T20:00:00+00:00");
    expect(log.at_date).toBe("2026-09-30");
  });

  test("(now-new-york) 負の時差も書ける", async () => {
    const log = await histAt("America/New_York");
    expect(log.at).toBe("2026-09-30T16:00:00-04:00");
    expect(log.at_date).toBe("2026-09-30");
  });

  test("(now-invalid) 無効な時間帯は既定(Asia/Tokyo)に落ちる", async () => {
    const log = await histAt("Nowhere/Invalid");
    expect(log.at).toBe("2026-10-01T05:00:00+09:00");
    expect(log.at_date).toBe("2026-10-01");
  });

  test("(now-clock-source) 時刻源を差し替えると値が変わる(実時刻を読まない)", async () => {
    const rig = await makeRig();
    const item = await seedAssessment(rig, { verdict: "一" });
    delete process.env.ST_TIMEZONE;
    setWorkflowClock({ now: () => new Date("2001-02-03T04:05:06.000Z") });
    await mustPatch(rig, rig.alice, "assessments", item, { verdict: "二" });
    setWorkflowClock({ now: () => new Date("2031-12-31T15:00:00.000Z") });
    await mustPatch(rig, rig.alice, "assessments", item, { verdict: "三" });
    expect(logsOf(rig, "hist").map((row) => [row.at, row.at_date])).toEqual([
      ["2001-02-03T13:05:06+09:00", "2001-02-03"],
      ["2032-01-01T00:00:00+09:00", "2032-01-01"],
    ]);
  });

  test("(now-single-source) 実行器の注釈でない行に、2本目の時刻源(Date.now( と引数なしの new Date())が無い", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "kernel", "workflow-runner.ts"),
      "utf-8",
    );
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");
    expect(code.split("Date.now(").length - 1).toBe(0);
    expect(code.split("new Date()").length - 1).toBe(0);
    // 時刻は getWorkflowClock の口(モジュールの時刻源)からだけ読む。
    expect(code).toContain("workflowClock.now()");
  });
});

describe("V23-M4-T04 $previous は on_update の外では適用時に断る(ADR-0500 限定15)", () => {
  test("(apply-reject) on_create のワークフローに $previous を書いた定義は理由つきで断られる", async () => {
    const m = manifest();
    const workflows = (m.app.workflows ?? []) as unknown as Record<string, unknown>[];
    workflows.push({
      id: "wf_bad",
      name: "作成で更新前を読む",
      trigger: { type: "on_create", table: "assessments" },
      history_table: "wf_log",
      actions: [
        {
          action: "create_record",
          table: "assessment_log",
          values: { src: "bad", before: "$previous.verdict" },
        },
      ],
    });
    const dataRoot = await mkdtemp(join(tmpdir(), "gp-previous-changed-now-"));
    dataRoots.push(dataRoot);
    const meta = KernelMetaStore.open(dataRoot);
    try {
      createApp(meta, "更新前と今", { app_id: APP_ID });
    } finally {
      meta.close();
    }
    const applied = applyManifest(dataRoot, APP_ID, withDefaultRoleRules(m));
    expect(applied.valid).toBe(false);
    const text = JSON.stringify(applied.valid ? [] : applied.errors);
    expect(text).toContain("on_update");
    expect(text).toContain("$previous.verdict");
  });
});
