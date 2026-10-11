/**
 * **予約規約フィールド `st_updated_by`(更新者)**(`V23-M4-T05`。`D-V23-91`・`D-V23-92`・`D-V23-98`・
 * `D-V23-103`・`D-V23-105`。門A `ADR-0500` 限定16・19・20 / `ADR-0524` §Decision 1-5 と限定19・20)。
 *
 * - 型が text で必須でない `st_updated_by` を持つ表では、行の作成と更新のたびに、カーネルの1か所で
 *   起点の操作者の id を押す(受信口・時刻起動・起点の無い呼び出しは空文字)。
 * - 送信内容・自動処理の `values`・島の op に書かれた値は捨てる。
 * - 実行履歴の行には押さない。 型が text でないか必須なら、ただの項目。
 * - 読取(HTTP の一覧・単件)では表示名に差し替え、未ログインには伏せる。 絞り込みは ID のまま。
 * - 宣言の無い表は今日どおり(送れば「存在しません」)。
 *
 * MCP の道具は `updated-by-stamp-mcp.test.ts`、名簿・付与の書込点は `updated-by-stamp-roster.test.ts`。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "../auth/store.ts";
import { AiCapabilityStore } from "../kernel/ai-capability-store.ts";
import { dispatchAiJobs } from "../kernel/ai-dispatcher.ts";
import type { AiProvider } from "../kernel/ai-provider.ts";
import { InboundStore } from "../kernel/inbound-store.ts";
import {
  appDbPath,
  applyManifest,
  createApp,
  createRecord,
  KernelMetaStore,
  type Manifest,
  updateRecord,
} from "../kernel/index.ts";
import { ensureIslandRuntimeReady } from "../kernel/island-runner.ts";
import { resetWorkflowClock, setWorkflowClock } from "../kernel/workflow-runner.ts";
import { runSchedulerTick } from "../kernel/workflow-scheduler.ts";
import { createServerApp } from "./app.ts";
import {
  type SeededSession,
  seedSession,
  TEST_ORIGIN,
  withDefaultRoleRules,
} from "./test-helpers.ts";

const APP_ID = "updated-by";
const SIGNING_KEY = "updated-by-signing-key";
const KEY_ENV_VAR = "ST_TEST_UPDATED_BY_KEY";
const UB = "st_updated_by";
const FORGED = "偽の更新者";

const HISTORY_FIELDS = [
  { id: "ran_at", name: "実行時刻", type: "date" },
  { id: "workflow", name: "ワークフロー", type: "text" },
  { id: "trigger_type", name: "きっかけ", type: "text" },
  { id: "status", name: "結果", type: "text" },
  { id: "error", name: "エラー", type: "long_text" },
];

const UB_FIELD = { id: UB, name: "更新者", type: "text" };

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "更新者",
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
          id: "notes",
          name: "メモ",
          fields: [
            { id: "title", name: "件名", type: "text" },
            { id: "memo", name: "本文", type: "text" },
            UB_FIELD,
          ],
        },
        {
          id: "items",
          name: "品",
          fields: [
            { id: "title", name: "件名", type: "text" },
            { id: "note", name: "メモ", type: "reference", reference_table: "notes" },
            { id: "holder", name: "担当", type: "reference", reference_table: "holders" },
          ],
        },
        {
          id: "wbt",
          name: "書き戻し",
          fields: [
            { id: "n", name: "数", type: "number" },
            { id: "memo", name: "本文", type: "text" },
            UB_FIELD,
          ],
        },
        {
          id: "otab",
          name: "出力",
          fields: [{ id: "total", name: "合計", type: "number" }, UB_FIELD],
        },
        {
          id: "inbox",
          name: "受信",
          fields: [{ id: "ev", name: "知らせ", type: "text", unique: true }, UB_FIELD],
        },
        {
          id: "aitab",
          name: "AI の対象",
          fields: [
            { id: "memo", name: "メモ", type: "text" },
            { id: "label", name: "ラベル", type: "text" },
            { id: "holder", name: "担当", type: "reference", reference_table: "holders" },
            UB_FIELD,
          ],
        },
        {
          id: "nontext",
          name: "数の更新者",
          fields: [
            { id: "title", name: "件名", type: "text" },
            { id: UB, name: "更新者", type: "number" },
          ],
        },
        {
          id: "reqd",
          name: "必須の更新者",
          fields: [
            { id: "title", name: "件名", type: "text" },
            { id: UB, name: "更新者", type: "text", required: true },
          ],
        },
        { id: "plain", name: "宣言なし", fields: [{ id: "title", name: "件名", type: "text" }] },
        { id: "wf_log", name: "実行履歴", fields: HISTORY_FIELDS },
        { id: "hist_ub", name: "更新者つきの実行履歴", fields: [...HISTORY_FIELDS, UB_FIELD] },
      ],
      views: [
        {
          id: "item_list",
          type: "list_view",
          table: "items",
          columns: ["title"],
          actions: [
            { id: "press", run: "wf_manual", name: "押す" },
            { id: "press_as", run: "wf_manual_as", name: "担当として押す" },
          ],
        },
      ],
      roles: [
        { id: "owner", name: "持ち主" },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
        {
          id: "anonymous",
          name: "未ログイン",
          rules: [{ target: "table", table: "notes", can: ["read"] }],
        },
      ],
      functions: [
        {
          id: "isl",
          name: "島が作る",
          code: `export default function () { return [{ op: "create", table: "notes", values: { title: "島", ${UB}: "${FORGED}" } }]; }`,
          input: { source: "record" },
          output: { ops: true },
        },
        {
          id: "wbfn",
          name: "書き戻す",
          code: "export default function () { return [{ n: 7 }]; }",
          input: { source: "record" },
          output: { fields: [{ id: "n", type: "number" }] },
        },
        {
          id: "ofn",
          name: "出力する",
          code: "export default function () { return [{ total: 1 }]; }",
          input: { source: "record" },
          output: { fields: [{ id: "total", type: "number" }] },
        },
      ],
      workflows: [
        {
          id: "wf_note_from_item",
          name: "品からメモを作る",
          trigger: { type: "on_create", table: "items" },
          history_table: "hist_ub",
          actions: [
            {
              action: "create_record",
              table: "notes",
              values: { title: "$record.title", [UB]: FORGED },
            },
          ],
        },
        {
          id: "wf_note_update",
          name: "品の更新でメモを直す",
          trigger: { type: "on_update", table: "items" },
          history_table: "wf_log",
          actions: [
            {
              action: "update_record",
              table: "notes",
              target: "$record.note",
              values: { memo: "$record.title", [UB]: FORGED },
            },
          ],
        },
        {
          id: "wf_island",
          name: "島を走らせる",
          trigger: { type: "on_create", table: "items" },
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "isl", write_ops: true }],
        },
        {
          id: "wf_out",
          name: "出力の表へ",
          trigger: { type: "on_create", table: "items" },
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "ofn", output_table: "otab" }],
        },
        {
          id: "wf_wb",
          name: "書き戻す",
          trigger: { type: "on_create", table: "wbt" },
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "wbfn", write_back: "$record" }],
        },
        {
          id: "wf_manual",
          name: "押す",
          trigger: { type: "manual", table: "items" },
          history_table: "wf_log",
          actions: [{ action: "create_record", table: "notes", values: { title: "manual" } }],
        },
        {
          id: "wf_manual_as",
          name: "担当として押す",
          trigger: { type: "manual", table: "items" },
          history_table: "wf_log",
          act_as: "$record.holder",
          actions: [{ action: "create_record", table: "notes", values: { title: "manual_as" } }],
        },
        {
          id: "wf_sched",
          name: "時刻で作る",
          trigger: { type: "schedule", at: { hour: 9, minute: 0 } },
          history_table: "wf_log",
          actions: [{ action: "create_record", table: "notes", values: { title: "sched" } }],
        },
        {
          id: "wf_sched_upd",
          name: "時刻で直す",
          trigger: { type: "schedule", at: { hour: 9, minute: 0 }, table: "wbt" },
          history_table: "wf_log",
          actions: [
            {
              action: "update_record",
              table: "wbt",
              target: "$record._id",
              values: { memo: "時刻" },
            },
          ],
        },
        {
          id: "wf_ai",
          name: "AI でラベルを付ける",
          trigger: { type: "on_update", table: "aitab" },
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
      ],
    },
  } as unknown as Manifest;
}

type Rig = {
  dataRoot: string;
  server: ReturnType<typeof createServerApp>;
  boss: SeededSession;
  alice: SeededSession;
  bob: SeededSession;
  carol: SeededSession;
  inboxEndpoint: string;
  plainEndpoint: string;
};

const dataRoots: string[] = [];

beforeAll(async () => {
  await ensureIslandRuntimeReady();
});

afterEach(async () => {
  delete process.env[KEY_ENV_VAR];
  resetWorkflowClock();
  for (const dir of dataRoots.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeRig(shape: (source: Manifest) => Manifest = (source) => source): Promise<Rig> {
  const dataRoot = await mkdtemp(join(tmpdir(), "gp-updated-by-"));
  dataRoots.push(dataRoot);
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, "更新者", { app_id: APP_ID });
  } finally {
    meta.close();
  }
  const applied = applyManifest(dataRoot, APP_ID, withDefaultRoleRules(shape(manifest())));
  if (!applied.valid) {
    throw new Error(JSON.stringify(applied.errors));
  }
  process.env[KEY_ENV_VAR] = SIGNING_KEY;
  const inbound = InboundStore.openForKernel(dataRoot);
  let inboxEndpoint: string;
  let plainEndpoint: string;
  try {
    inboxEndpoint = inbound.issueInboundEndpoint({
      appId: APP_ID,
      name: "inbox",
      secretSource: { kind: "env", value: KEY_ENV_VAR },
      targetTable: "inbox",
    }).id;
    plainEndpoint = inbound.issueInboundEndpoint({
      appId: APP_ID,
      name: "plain",
      secretSource: { kind: "env", value: KEY_ENV_VAR },
      targetTable: "plain",
    }).id;
  } finally {
    inbound.close();
  }
  return {
    dataRoot,
    server: createServerApp({ dataRoot }),
    boss: seedSession(dataRoot, APP_ID, { role: "owner", username: "boss" }),
    alice: seedSession(dataRoot, APP_ID, { role: "editor", username: "alice" }),
    bob: seedSession(dataRoot, APP_ID, { role: "editor", username: "bob" }),
    carol: seedSession(dataRoot, APP_ID, { role: "editor", username: "carol" }),
    inboxEndpoint,
    plainEndpoint,
  };
}

/** 署名つきで受信口へ送る。 */
async function sendInbound(rig: Rig, endpoint: string, body: unknown): Promise<Response> {
  const rawBody = JSON.stringify(body);
  const signature = `sha256=${createHmac("sha256", SIGNING_KEY).update(Buffer.from(rawBody, "utf-8")).digest("hex")}`;
  return await rig.server.request(
    new Request(`http://localhost/inbound/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Mock-PSP-Signature": signature },
      body: rawBody,
    }),
  );
}

async function send(
  rig: Rig,
  who: SeededSession | undefined,
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
        ...(who === undefined ? {} : { cookie: who.cookie }),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

const recordsPath = (table: string): string => `/api/apps/${APP_ID}/tables/${table}/records`;

async function patch(
  rig: Rig,
  who: SeededSession,
  table: string,
  id: string,
  values: Record<string, unknown>,
): Promise<Response> {
  const version = rowsOf(rig, table).find((row) => row._id === id)?._updated_at;
  return await send(rig, who, "PATCH", `${recordsPath(table)}/${id}`, values, {
    "if-match": String(version),
  });
}

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

function rowsOf(rig: Rig, table: string): Record<string, unknown>[] {
  const db = new Database(appDbPath(rig.dataRoot, APP_ID), { readonly: true });
  try {
    return db.query<Record<string, unknown>, []>(`SELECT * FROM "${table}" ORDER BY rowid`).all();
  } finally {
    db.close();
  }
}

function rowOf(rig: Rig, table: string, id: string): Record<string, unknown> | undefined {
  return rowsOf(rig, table).find((row) => row._id === id);
}

function notesTitled(rig: Rig, title: string): Record<string, unknown>[] {
  return rowsOf(rig, "notes").filter((row) => row.title === title);
}

describe("V23-M4-T05 画面・HTTP の書込は、ログイン中の利用者を押す", () => {
  test("(http-post) 作成は作った人の id を押し、送った他人の id は捨てる", async () => {
    const rig = await makeRig();
    const id = await mustCreate(rig, rig.alice, "notes", { title: "一", [UB]: rig.bob.userId });
    expect(rowOf(rig, "notes", id)?.[UB]).toBe(rig.alice.userId);
  });

  test("(http-post-omit) 送らなくても押す", async () => {
    const rig = await makeRig();
    const id = await mustCreate(rig, rig.bob, "notes", { title: "一" });
    expect(rowOf(rig, "notes", id)?.[UB]).toBe(rig.bob.userId);
  });

  test("(http-patch) 更新は更新した人を押し、偽の値・型の違う値も捨てる", async () => {
    const rig = await makeRig();
    const id = await mustCreate(rig, rig.alice, "notes", { title: "一" });
    const res = await patch(rig, rig.bob, "notes", id, { memo: "直した", [UB]: FORGED });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(rowOf(rig, "notes", id)?.[UB]).toBe(rig.bob.userId);
    const res2 = await patch(rig, rig.carol, "notes", id, { memo: "また直した", [UB]: 5 });
    expect(res2.status, await res2.clone().text()).toBe(200);
    expect(rowOf(rig, "notes", id)?.[UB]).toBe(rig.carol.userId);
  });

  test("(http-patch-other-field) 更新者だけを送る更新も、更新した人になる", async () => {
    const rig = await makeRig();
    const id = await mustCreate(rig, rig.alice, "notes", { title: "一" });
    const res = await patch(rig, rig.bob, "notes", id, { [UB]: rig.alice.userId });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(rowOf(rig, "notes", id)?.[UB]).toBe(rig.bob.userId);
  });

  test("(http-batch) 一括の作成・更新は送った人を押す", async () => {
    const rig = await makeRig();
    const id = await mustCreate(rig, rig.alice, "notes", { title: "一" });
    const res = await send(rig, rig.carol, "POST", `/api/apps/${APP_ID}/batch`, {
      ops: [
        { op: "create", table: "notes", values: { title: "二", [UB]: rig.alice.userId } },
        { op: "update", table: "notes", target: id, values: { memo: "一括", [UB]: FORGED } },
      ],
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(notesTitled(rig, "二")[0]?.[UB]).toBe(rig.carol.userId);
    expect(rowOf(rig, "notes", id)?.[UB]).toBe(rig.carol.userId);
  });
});

describe("V23-M4-T05 自動処理と島の書込は、起点の操作者を押す", () => {
  test("(wf-create) create_record は起点の人を押し、values の値は捨てる。実行履歴の行には押さない", async () => {
    const rig = await makeRig();
    await mustCreate(rig, rig.bob, "items", { title: "品一" });
    const notes = notesTitled(rig, "品一");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.[UB]).toBe(rig.bob.userId);
    const history = rowsOf(rig, "hist_ub");
    expect(history.length).toBeGreaterThanOrEqual(1);
    for (const row of history) {
      expect(row[UB]).toBeNull();
    }
  });

  test("(wf-update) update_record は起点の人を押し、values の値は捨てる", async () => {
    const rig = await makeRig();
    const note = await mustCreate(rig, rig.alice, "notes", { title: "対象" });
    const item = await mustCreate(rig, rig.alice, "items", { title: "品一", note });
    expect(rowOf(rig, "notes", note)?.[UB]).toBe(rig.alice.userId);
    const res = await patch(rig, rig.carol, "items", item, { title: "品二" });
    expect(res.status, await res.clone().text()).toBe(200);
    const row = rowOf(rig, "notes", note);
    expect(row?.memo).toBe("品二");
    expect(row?.[UB]).toBe(rig.carol.userId);
  });

  test("(island-write-ops) 島の op の作成は起点の人を押し、op の値は捨てる", async () => {
    const rig = await makeRig();
    await mustCreate(rig, rig.alice, "items", { title: "品一" });
    const notes = notesTitled(rig, "島");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.[UB]).toBe(rig.alice.userId);
  });

  test("(island-output-table) 島の出力の表の行は起点の人を押す", async () => {
    const rig = await makeRig();
    await mustCreate(rig, rig.carol, "items", { title: "品一" });
    const rows = rowsOf(rig, "otab");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.[UB]).toBe(rig.carol.userId);
  });

  test("(island-write-back) 島の書き戻しの更新は起点の人を押す(空にしない)", async () => {
    const rig = await makeRig();
    const id = await mustCreate(rig, rig.bob, "wbt", { n: 1 });
    const row = rowOf(rig, "wbt", id);
    expect(row?.n).toBe(7);
    expect(row?.[UB]).toBe(rig.bob.userId);
  });

  test("(manual) 手動起動は押した人を押す(act_as があっても押した人)", async () => {
    const rig = await makeRig();
    const holder = await mustCreate(rig, rig.carol, "holders", { name: "かろるの担当" });
    const item = await mustCreate(rig, rig.alice, "items", { title: "品一", holder });
    const pressPath = (workflow: string) =>
      `/api/apps/${APP_ID}/views/item_list/actions/run?workflow=${workflow}&record=${item}`;
    const res1 = await send(rig, rig.bob, "POST", pressPath("wf_manual"));
    expect(res1.status, await res1.clone().text()).toBe(200);
    expect(notesTitled(rig, "manual")[0]?.[UB]).toBe(rig.bob.userId);
    const res2 = await send(rig, rig.alice, "POST", pressPath("wf_manual_as"));
    expect(res2.status, await res2.clone().text()).toBe(200);
    expect(notesTitled(rig, "manual_as")[0]?.[UB]).toBe(rig.alice.userId);
  });

  test("(ai) AI の書き戻しはジョブの主体を押す(更新した人と割れる)", async () => {
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
    const target = await mustCreate(rig, rig.alice, "aitab", { memo: "元", holder });
    const res = await patch(rig, rig.alice, "aitab", target, { memo: "見直し" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(rowOf(rig, "aitab", target)?.[UB]).toBe(rig.alice.userId);
    const provider: AiProvider = async () => ({
      text: '{"value":"good"}',
      inputTokens: 1,
      outputTokens: 1,
    });
    await dispatchAiJobs(rig.dataRoot, provider);
    const row = rowOf(rig, "aitab", target);
    expect(row?.label).toBe("good");
    expect(row?.[UB]).toBe(rig.carol.userId);
  });
});

describe("V23-M4-T05 受信口・時刻起動・起点の無い呼び出しは空文字", () => {
  test("(inbound) 受信口の作成は空文字を押し、送信内容の更新者は捨てる", async () => {
    const rig = await makeRig();
    const rawBody = JSON.stringify({ ev: "e1", [UB]: rig.alice.userId });
    const signature = `sha256=${createHmac("sha256", SIGNING_KEY).update(Buffer.from(rawBody, "utf-8")).digest("hex")}`;
    const res = await rig.server.request(
      new Request(`http://localhost/inbound/${rig.inboxEndpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Mock-PSP-Signature": signature },
        body: rawBody,
      }),
    );
    expect(res.status, await res.clone().text()).toBe(201);
    const rows = rowsOf(rig, "inbox");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.[UB]).toBe("");
  });

  test("(inbound-undeclared) 列を持たない表への受信で送信内容に st_updated_by があれば、今日どおり 400(捨てない)", async () => {
    const rig = await makeRig();
    const res = await sendInbound(rig, rig.plainEndpoint, { title: "一", [UB]: rig.alice.userId });
    expect(res.status, await res.clone().text()).toBe(400);
    expect(await res.text()).toContain(UB);
    expect(rowsOf(rig, "plain")).toHaveLength(0);
    const ok = await sendInbound(rig, rig.plainEndpoint, { title: "二" });
    expect(ok.status, await ok.clone().text()).toBe(201);
    expect(rowsOf(rig, "plain")).toHaveLength(1);
  });

  test("(schedule) 時刻起動の作成・更新は空文字を押す", async () => {
    const rig = await makeRig();
    const id = await mustCreate(rig, rig.alice, "wbt", { n: 1 });
    expect(rowOf(rig, "wbt", id)?.[UB]).toBe(rig.alice.userId);
    setWorkflowClock({ now: () => new Date("2026-09-30T01:00:00.000Z") });
    runSchedulerTick({ dataRoot: rig.dataRoot, timeZone: "Asia/Tokyo" });
    const created = notesTitled(rig, "sched");
    expect(created).toHaveLength(1);
    expect(created[0]?.[UB]).toBe("");
    const updated = rowOf(rig, "wbt", id);
    expect(updated?.memo).toBe("時刻");
    expect(updated?.[UB]).toBe("");
  });

  test("(kernel-direct) カーネルを直に呼んだ作成・更新は空文字(null ではない)", async () => {
    const rig = await makeRig();
    const id = await mustCreate(rig, rig.alice, "notes", { title: "一" });
    const db = new Database(appDbPath(rig.dataRoot, APP_ID));
    try {
      const m = withDefaultRoleRules(manifest());
      const created = createRecord(db, m, "notes", { title: "直", [UB]: FORGED });
      expect(created.ok).toBe(true);
      const updated = updateRecord(db, m, "notes", id, { memo: "直", [UB]: FORGED });
      expect(updated.ok).toBe(true);
    } finally {
      db.close();
    }
    expect(notesTitled(rig, "直")[0]?.[UB]).toBe("");
    expect(rowOf(rig, "notes", id)?.[UB]).toBe("");
  });
});

describe("V23-M4-T05 型が text でないか必須なら、ただの項目", () => {
  test("(non-text) number の st_updated_by は送った値のまま(押さない)", async () => {
    const rig = await makeRig();
    const id = await mustCreate(rig, rig.alice, "nontext", { title: "一", [UB]: 42 });
    expect(rowOf(rig, "nontext", id)?.[UB]).toBe(42);
    const blank = await mustCreate(rig, rig.alice, "nontext", { title: "二" });
    expect(rowOf(rig, "nontext", blank)?.[UB]).toBeNull();
  });

  test("(required) 必須の st_updated_by は送った値のまま、送らなければ必須の断り", async () => {
    const rig = await makeRig();
    const id = await mustCreate(rig, rig.alice, "reqd", { title: "一", [UB]: "手書き" });
    expect(rowOf(rig, "reqd", id)?.[UB]).toBe("手書き");
    const res = await send(rig, rig.alice, "POST", recordsPath("reqd"), { title: "二" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: { path: string; message: string }[] };
    expect(body.errors.map((error) => error.path)).toEqual([`/${UB}`]);
    expect(body.errors[0]?.message).toContain(`フィールド "${UB}" は必須です。`);
  });

  test("(undeclared) 宣言の無い表へ送った st_updated_by は今日どおり「存在しません」で断る", async () => {
    const rig = await makeRig();
    const res = await send(rig, rig.alice, "POST", recordsPath("plain"), {
      title: "一",
      [UB]: rig.alice.userId,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: { path: string; message: string }[] };
    expect(body.errors.map((error) => error.message)).toEqual([
      `フィールド "${UB}" はテーブル "plain" に存在しません。`,
    ]);
    const ok = await mustCreate(rig, rig.alice, "plain", { title: "二" });
    expect(Object.keys(rowOf(rig, "plain", ok) ?? {}).sort()).toEqual([
      "_created_at",
      "_id",
      "_updated_at",
      "title",
    ]);
  });
});

describe("V23-M4-T05 読取で表示名に差し替え、未ログインには伏せる(判定・絞り込みは ID)", () => {
  async function listNotes(rig: Rig, who: SeededSession | undefined, query = "") {
    const res = await send(rig, who, "GET", `${recordsPath("notes")}${query}`);
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { records: Record<string, unknown>[] }).records;
  }

  test("(read-list-detail) 一覧と単件では表示名、保存の値は ID のまま", async () => {
    const rig = await makeRig();
    const store = AuthStore.openForApp(rig.dataRoot, APP_ID);
    let dora: { cookie: string; userId: string };
    try {
      const user = store.createUser({ username: "dora", displayName: "ドラ", role: "editor" });
      dora = { cookie: `st_session=${store.createSession(user.id, 3600).id}`, userId: user.id };
    } finally {
      store.close();
    }
    const byDora = (
      (await (
        await send(
          rig,
          { ...rig.alice, cookie: dora.cookie, userId: dora.userId } as SeededSession,
          "POST",
          recordsPath("notes"),
          { title: "ドラのメモ" },
        )
      ).json()) as { record: { _id: string } }
    ).record._id;
    const byAlice = await mustCreate(rig, rig.alice, "notes", { title: "アリスのメモ" });
    const list = await listNotes(rig, rig.bob);
    expect(list.find((row) => row._id === byDora)?.[UB]).toBe("ドラ");
    expect(list.find((row) => row._id === byAlice)?.[UB]).toBe("alice");
    const detail = await send(rig, rig.bob, "GET", `${recordsPath("notes")}/${byDora}`);
    expect(detail.status, await detail.clone().text()).toBe(200);
    expect(((await detail.json()) as { record: Record<string, unknown> }).record[UB]).toBe("ドラ");
    expect(rowOf(rig, "notes", byDora)?.[UB]).toBe(dora.userId);
  });

  test("(read-empty-departed) 空文字は空のまま、退会した人は不明なユーザ", async () => {
    const rig = await makeRig();
    const store = AuthStore.openForApp(rig.dataRoot, APP_ID);
    let gone: SeededSession;
    try {
      const user = store.createUser({ username: "gone", role: "editor" });
      gone = {
        ...rig.alice,
        cookie: `st_session=${store.createSession(user.id, 3600).id}`,
        userId: user.id,
        username: "gone",
      };
    } finally {
      store.close();
    }
    const byGone = await mustCreate(rig, gone, "notes", { title: "去った人" });
    const store2 = AuthStore.openForApp(rig.dataRoot, APP_ID);
    try {
      store2.deleteUser(gone.userId);
    } finally {
      store2.close();
    }
    setWorkflowClock({ now: () => new Date("2026-09-30T01:00:00.000Z") });
    runSchedulerTick({ dataRoot: rig.dataRoot, timeZone: "Asia/Tokyo" });
    const list = await listNotes(rig, rig.bob);
    expect(list.find((row) => row._id === byGone)?.[UB]).toBe("(不明なユーザ)");
    expect(list.find((row) => row.title === "sched")?.[UB]).toBe("");
  });

  test("(read-filter) 絞り込みは ID で当たり、表示名では当たらない", async () => {
    const rig = await makeRig();
    await mustCreate(rig, rig.alice, "notes", { title: "アリスのメモ" });
    await mustCreate(rig, rig.bob, "notes", { title: "ボブのメモ" });
    const byId = await listNotes(rig, rig.carol, `?filter.${UB}=${rig.alice.userId}`);
    expect(byId.map((row) => row.title)).toEqual(["アリスのメモ"]);
    expect(byId[0]?.[UB]).toBe("alice");
    const byName = await listNotes(rig, rig.carol, `?filter.${UB}=alice`);
    expect(byName).toHaveLength(0);
  });

  test("(read-anonymous) 未ログインの読み手には更新者を伏せる", async () => {
    const rig = await makeRig();
    const id = await mustCreate(rig, rig.alice, "notes", { title: "公開" });
    const list = await listNotes(rig, undefined);
    const row = list.find((candidate) => candidate._id === id);
    expect(row?.title).toBe("公開");
    expect(row !== undefined && UB in row).toBe(false);
    const detail = await send(rig, undefined, "GET", `${recordsPath("notes")}/${id}`);
    expect(detail.status, await detail.clone().text()).toBe(200);
    const record = ((await detail.json()) as { record: Record<string, unknown> }).record;
    expect(UB in record).toBe(false);
  });
});

/**
 * 未ログインの読み手にも `nontext`(number の `st_updated_by`)と `plain`(列の無い表)を読ませた定義。
 * `V23-M4-T10` の処置の検査(中1。`ADR-0531` 2・限定1・限定2)だけが使う。
 */
function withAnonymousReadOfOthers(source: Manifest): Manifest {
  const copy = structuredClone(source) as unknown as {
    app: { roles: { id: string; rules?: { target: string; table: string; can: string[] }[] }[] };
  };
  const anonymous = copy.app.roles.find((role) => role.id === "anonymous");
  anonymous?.rules?.push(
    { target: "table", table: "nontext", can: ["read"] },
    { target: "table", table: "plain", can: ["read"] },
  );
  return copy as unknown as Manifest;
}

describe("V23-M4-T10 未ログインは更新者で絞り込めず並べ替えられない(存在しない項目と同じ 400)", () => {
  type ErrorBody = { errors: { path: string; message: string; allowed_values?: unknown[] }[] };

  async function anonymousGet(rig: Rig, table: string, query: string) {
    const res = await send(rig, undefined, "GET", `${recordsPath(table)}${query}`);
    return { status: res.status, body: (await res.json()) as ErrorBody };
  }

  test("(anon-filter) filter.st_updated_by は、存在しない項目と同じ 400(値で当てられない)", async () => {
    const rig = await makeRig();
    await mustCreate(rig, rig.alice, "notes", { title: "アリスのメモ" });
    const hit = await anonymousGet(rig, "notes", `?filter.${UB}=${rig.alice.userId}`);
    const miss = await anonymousGet(rig, "notes", `?filter.${UB}=nobody`);
    const unknown = await anonymousGet(rig, "notes", "?filter.no_such_field=x");
    expect(hit.status).toBe(400);
    expect(miss.status).toBe(400);
    expect(unknown.status).toBe(400);
    const shape = (body: ErrorBody, fieldId: string) =>
      JSON.stringify(body).split(fieldId).join("<項目>");
    expect(shape(hit.body, UB)).toBe(shape(unknown.body, "no_such_field"));
    expect(shape(miss.body, UB)).toBe(shape(unknown.body, "no_such_field"));
    expect(JSON.stringify(hit.body)).not.toContain(rig.alice.userId);
  });

  test("(anon-filter-json) ブール式の絞り込みでも同じ 400", async () => {
    const rig = await makeRig();
    await mustCreate(rig, rig.alice, "notes", { title: "アリスのメモ" });
    const expr = (field: string) =>
      `?filter=${encodeURIComponent(JSON.stringify({ field, equals: rig.alice.userId }))}`;
    const hit = await anonymousGet(rig, "notes", expr(UB));
    const unknown = await anonymousGet(rig, "notes", expr("no_such_field"));
    expect(hit.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(JSON.stringify(hit.body).split(UB).join("<項目>")).toBe(
      JSON.stringify(unknown.body).split("no_such_field").join("<項目>"),
    );
  });

  test("(anon-sort) sort=st_updated_by は、存在しない項目と同じ 400。allowed_values にも出ない", async () => {
    const rig = await makeRig();
    await mustCreate(rig, rig.alice, "notes", { title: "アリスのメモ" });
    const hit = await anonymousGet(rig, "notes", `?sort=${UB}`);
    const unknown = await anonymousGet(rig, "notes", "?sort=no_such_field");
    expect(hit.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(JSON.stringify(hit.body).split(UB).join("<項目>")).toBe(
      JSON.stringify(unknown.body).split("no_such_field").join("<項目>"),
    );
    expect(hit.body.errors[0]?.allowed_values ?? []).not.toContain(UB);
  });

  test("(logged-in-unchanged) ログインした読み手は今日どおり ID で絞り込み・並べ替えできる", async () => {
    const rig = await makeRig();
    await mustCreate(rig, rig.alice, "notes", { title: "アリスのメモ" });
    await mustCreate(rig, rig.bob, "notes", { title: "ボブのメモ" });
    const filtered = await send(
      rig,
      rig.carol,
      "GET",
      `${recordsPath("notes")}?filter.${UB}=${rig.bob.userId}`,
    );
    expect(filtered.status).toBe(200);
    const rows = ((await filtered.json()) as { records: Record<string, unknown>[] }).records;
    expect(rows.map((row) => row.title)).toEqual(["ボブのメモ"]);
    const sorted = await send(rig, rig.carol, "GET", `${recordsPath("notes")}?sort=${UB}`);
    expect(sorted.status).toBe(200);
  });

  test("(anon-other-tables) 押さない st_updated_by の表・列の無い表は今日と同じ", async () => {
    const rig = await makeRig(withAnonymousReadOfOthers);
    await mustCreate(rig, rig.alice, "nontext", { title: "一", [UB]: 42 });
    await mustCreate(rig, rig.alice, "plain", { title: "二" });
    const nontextFilter = await send(
      rig,
      undefined,
      "GET",
      `${recordsPath("nontext")}?filter.${UB}=42`,
    );
    expect(nontextFilter.status).toBe(200);
    const nontextSort = await send(rig, undefined, "GET", `${recordsPath("nontext")}?sort=${UB}`);
    expect(nontextSort.status).toBe(200);
    const plain = await anonymousGet(rig, "plain", `?filter.${UB}=x`);
    expect(plain.status).toBe(400);
    expect(plain.body.errors.map((error) => error.message)).toEqual([
      `絞り込みに指定されたフィールド "${UB}" はテーブル "plain" に存在しません。`,
    ]);
  });
});

/**
 * **【`V23-M9-T04`。`D-V23-253`。門A `ADR-0549` §Decision 1-5】AI の書き戻しで主体が空なら、更新者を上書きしない。**
 *
 * 主体はジョブの `act_as` の先か、トリガー元の行の `st_owner`。 どちらも無い表では主体が空で、
 * 着手前は `st_updated_by` が空文字で上書きされていた。 今日は直前の値のまま残す。
 * 主体があるときは今日どおり主体の id を押す。 列の無い表は今日どおり(列が無いので何も押さない)。
 */
describe("D-V23-253 AI の書き戻しで主体が空なら、更新者は直前の値のまま", () => {
  /** `wf_ai` から `act_as` を外し、持ち主の列を持つ表と更新者の列の無い表に同じ AI の処理を足す。 */
  function aiShape(source: Manifest): Manifest {
    const app = source.app as unknown as {
      tables: { id: string; name: string; fields: unknown[] }[];
      workflows: Record<string, unknown>[];
    };
    const aiAction = {
      action: "ai_transform",
      capability: "labeler",
      prompt: "ラベルを決めてください。",
      input: { memo: "$record.memo" },
      output_field: "label",
      fallback: "none",
    };
    app.tables.push(
      {
        id: "aiown",
        name: "持ち主つきの AI の対象",
        fields: [
          { id: "memo", name: "メモ", type: "text" },
          { id: "label", name: "ラベル", type: "text" },
          { id: "st_owner", name: "所有者", type: "text" },
          UB_FIELD,
        ],
      },
      {
        id: "aiplain",
        name: "更新者の無い AI の対象",
        fields: [
          { id: "memo", name: "メモ", type: "text" },
          { id: "label", name: "ラベル", type: "text" },
        ],
      },
    );
    app.workflows = app.workflows.map((workflow) => {
      if (workflow.id !== "wf_ai") {
        return workflow;
      }
      const { act_as: _dropped, ...rest } = workflow;
      return rest;
    });
    app.workflows.push(
      {
        id: "wf_ai_own",
        name: "持ち主つきの表に AI でラベルを付ける",
        trigger: { type: "on_update", table: "aiown" },
        history_table: "wf_log",
        actions: [aiAction],
      },
      {
        id: "wf_ai_chain",
        name: "AI の書き戻しの後にメモを作る",
        trigger: { type: "on_update", table: "aitab" },
        history_table: "wf_log",
        actions: [{ action: "create_record", table: "notes", values: { title: "$record.label" } }],
      },
      {
        id: "wf_ai_plain",
        name: "更新者の無い表に AI でラベルを付ける",
        trigger: { type: "on_update", table: "aiplain" },
        history_table: "wf_log",
        actions: [aiAction],
      },
    );
    return source;
  }

  function grantLabeler(rig: Rig): void {
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
  }

  const provider: AiProvider = async () => ({
    text: '{"value":"good"}',
    inputTokens: 1,
    outputTokens: 1,
  });

  test("D-V23-253 (empty-actor) 持ち主の列も act_as も無い表: 人が更新した後の AI の書き戻しで、更新者は人のまま", async () => {
    const rig = await makeRig(aiShape);
    grantLabeler(rig);
    const target = await mustCreate(rig, rig.bob, "aitab", { memo: "元" });
    const res = await patch(rig, rig.alice, "aitab", target, { memo: "見直し" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(rowOf(rig, "aitab", target)?.[UB]).toBe(rig.alice.userId);
    await dispatchAiJobs(rig.dataRoot, provider);
    const row = rowOf(rig, "aitab", target);
    expect(row?.label).toBe("good");
    expect(row?.[UB]).toBe(rig.alice.userId);
  });

  test("D-V23-253 (empty-actor-fallback) 主体が空でフォールバックを書くときも、更新者は人のまま", async () => {
    const rig = await makeRig(aiShape);
    grantLabeler(rig);
    const target = await mustCreate(rig, rig.bob, "aitab", { memo: "元" });
    const res = await patch(rig, rig.alice, "aitab", target, { memo: "見直し" });
    expect(res.status, await res.clone().text()).toBe(200);
    const broken: AiProvider = async () => ({ text: "読めない", inputTokens: 1, outputTokens: 1 });
    await dispatchAiJobs(rig.dataRoot, broken);
    const row = rowOf(rig, "aitab", target);
    expect(row?.label).toBe("none");
    expect(row?.[UB]).toBe(rig.alice.userId);
  });

  test("D-V23-253 (chain) 主体が空の書き戻しが起こした連鎖の作成は、今日どおり更新者に空文字を押す", async () => {
    const rig = await makeRig(aiShape);
    grantLabeler(rig);
    const target = await mustCreate(rig, rig.bob, "aitab", { memo: "元" });
    const res = await patch(rig, rig.alice, "aitab", target, { memo: "見直し" });
    expect(res.status, await res.clone().text()).toBe(200);
    await dispatchAiJobs(rig.dataRoot, provider);
    const chained = notesTitled(rig, "good");
    expect(chained).toHaveLength(1);
    expect(chained[0]?.[UB]).toBe("");
  });

  test("D-V23-253 (act-as) act_as がある処理は今日どおりジョブの主体を押す", async () => {
    const rig = await makeRig();
    grantLabeler(rig);
    const holder = await mustCreate(rig, rig.carol, "holders", { name: "かろるの担当" });
    const target = await mustCreate(rig, rig.alice, "aitab", { memo: "元", holder });
    const res = await patch(rig, rig.alice, "aitab", target, { memo: "見直し" });
    expect(res.status, await res.clone().text()).toBe(200);
    await dispatchAiJobs(rig.dataRoot, provider);
    expect(rowOf(rig, "aitab", target)?.[UB]).toBe(rig.carol.userId);
  });

  test("D-V23-253 (st-owner) 持ち主の列がある表は今日どおり行の持ち主(ジョブの主体)を押す", async () => {
    const rig = await makeRig(aiShape);
    grantLabeler(rig);
    const target = await mustCreate(rig, rig.carol, "aiown", { memo: "元" });
    expect(rowOf(rig, "aiown", target)?.st_owner).toBe(rig.carol.userId);
    const res = await patch(rig, rig.carol, "aiown", target, { memo: "見直し" });
    expect(res.status, await res.clone().text()).toBe(200);
    // 書き戻しが主体を押すことを見分けるため、書き戻しの前に更新者だけを別の値にしておく。
    const db = new Database(appDbPath(rig.dataRoot, APP_ID));
    try {
      db.query(`UPDATE "aiown" SET "${UB}" = ? WHERE "_id" = ?`).run("前の値", target);
    } finally {
      db.close();
    }
    await dispatchAiJobs(rig.dataRoot, provider);
    const row = rowOf(rig, "aiown", target);
    expect(row?.label).toBe("good");
    expect(row?.[UB]).toBe(rig.carol.userId);
  });

  test("D-V23-253 (no-column) 更新者の列の無い表は今日どおり(書き戻しの行の列は同じ)", async () => {
    const rig = await makeRig(aiShape);
    grantLabeler(rig);
    const target = await mustCreate(rig, rig.bob, "aiplain", { memo: "元" });
    const res = await patch(rig, rig.alice, "aiplain", target, { memo: "見直し" });
    expect(res.status, await res.clone().text()).toBe(200);
    await dispatchAiJobs(rig.dataRoot, provider);
    const row = rowOf(rig, "aiplain", target);
    expect(row?.label).toBe("good");
    expect(Object.keys(row ?? {}).includes(UB)).toBe(false);
  });
});
