/**
 * **入口ごとの起点の操作者(`$actor`)**(`V23-M4-T03`。`D-V23-93`・`D-V23-102`・`D-V23-103`。
 * 門A `ADR-0500` 限定16・19 / `ADR-0524` §Decision 1-1 と限定16・17・24)。
 *
 * 各入口で、`values` に `$actor.id` / `$actor.login` / `$actor.role` を書いた自動処理が
 * 別の表(`actor_log`)に書く値を見る。 入口が起点の操作者を渡し忘れると、3つとも空文字になって
 * ここが赤くなる(`D-V23-102`: 引数を渡さない呼び出しは空)。
 *
 * - 画面・HTTP(単件の作成・更新・一括)= ログイン中の利用者。
 * - 受信口 = `id`・`login` は空、`role` は `inbound`。
 * - 手動起動 = 押した人(`act_as` があっても)。 判定の主体(`st_owner` の押し方)は今日どおり `act_as` が勝つ。
 * - 時刻起動 = `id`・`login` は空、`role` は `schedule`(行を選ぶもの・選ばないもの)。
 * - 連鎖(2段)と島の `write_ops` = 起点をそのまま引き継ぐ。
 * - AI の書き戻し = ジョブの主体(判定の主体。起点の人と割れる)。
 * - 送信内容から1バイトも読まない。 並行の要求で混ざらない。
 *
 * MCP の3道具は `src/mcp/actor-entry-points-mcp.test.ts`。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const APP_ID = "actor-entry";
const SIGNING_KEY = "actor-entry-signing-key";
const KEY_ENV_VAR = "ST_TEST_ACTOR_ENTRY_KEY";

const HISTORY_FIELDS = [
  { id: "ran_at", name: "実行時刻", type: "date" },
  { id: "workflow", name: "ワークフロー", type: "text" },
  { id: "trigger_type", name: "きっかけ", type: "text" },
  { id: "status", name: "結果", type: "text" },
  { id: "error", name: "エラー", type: "long_text" },
];

/** 操作者の3つの値を書く `values`(`src` で、どの自動処理が書いたかを見分ける)。 */
function actorValues(src: string): Record<string, string> {
  return {
    src,
    item: "$record._id",
    aid: "$actor.id",
    alogin: "$actor.login",
    arole: "$actor.role",
  };
}

function logTo(id: string, trigger: Record<string, unknown>, src: string): Record<string, unknown> {
  return {
    id,
    name: id,
    trigger,
    history_table: "wf_log",
    actions: [{ action: "create_record", table: "actor_log", values: actorValues(src) }],
  };
}

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "入口ごとの操作者",
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
          id: "items",
          name: "品",
          fields: [
            { id: "title", name: "件名", type: "text" },
            { id: "memo", name: "メモ", type: "text" },
            { id: "holder", name: "担当", type: "reference", reference_table: "holders" },
          ],
        },
        { id: "stage2", name: "二段目", fields: [{ id: "note", name: "メモ", type: "text" }] },
        { id: "ext", name: "島の先", fields: [{ id: "note", name: "メモ", type: "text" }] },
        {
          id: "inbox",
          name: "受信",
          fields: [{ id: "ev", name: "知らせ", type: "text", unique: true }],
        },
        { id: "strig", name: "時刻の対象", fields: [{ id: "note", name: "メモ", type: "text" }] },
        {
          id: "aitab",
          name: "AI の対象",
          fields: [
            { id: "memo", name: "メモ", type: "text" },
            { id: "label", name: "ラベル", type: "text" },
            { id: "holder", name: "担当", type: "reference", reference_table: "holders" },
          ],
        },
        {
          id: "actor_log",
          name: "操作者の記録",
          fields: [
            { id: "src", name: "出どころ", type: "text" },
            { id: "item", name: "対象", type: "text" },
            { id: "aid", name: "操作者ID", type: "text" },
            { id: "alogin", name: "ログイン名", type: "text" },
            { id: "arole", name: "役割", type: "text" },
          ],
        },
        {
          id: "owned_log",
          name: "持ち主つきの記録",
          fields: [
            { id: "src", name: "出どころ", type: "text" },
            { id: "item", name: "対象", type: "text" },
            { id: "aid", name: "操作者ID", type: "text" },
            { id: "alogin", name: "ログイン名", type: "text" },
            { id: "arole", name: "役割", type: "text" },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
        { id: "wf_log", name: "実行履歴", fields: HISTORY_FIELDS },
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
      functions: [
        {
          id: "isl",
          name: "島が作る",
          code: 'export default function () { return [{ op: "create", table: "ext", values: { note: "島" } }]; }',
          input: { source: "record" },
          output: { ops: true },
        },
      ],
      workflows: [
        logTo("wf_create", { type: "on_create", table: "items" }, "create"),
        logTo("wf_update", { type: "on_update", table: "items" }, "update"),
        // 連鎖: items の作成 → stage2 を作る → stage2 の作成で記録する(2段)。
        {
          id: "wf_chain1",
          name: "二段目を作る",
          trigger: { type: "on_create", table: "items" },
          history_table: "wf_log",
          actions: [
            { action: "create_record", table: "stage2", values: { note: "$record.title" } },
          ],
        },
        logTo("wf_chain2", { type: "on_create", table: "stage2" }, "chain"),
        // 島の write_ops → ext の作成で記録する。
        {
          id: "wf_island",
          name: "島を走らせる",
          trigger: { type: "on_create", table: "items" },
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "isl", write_ops: true }],
        },
        logTo("wf_ext", { type: "on_create", table: "ext" }, "island"),
        logTo("wf_inbox", { type: "on_create", table: "inbox" }, "inbound"),
        // 手動起動(act_as なし・あり)。
        {
          id: "wf_manual",
          name: "押す",
          trigger: { type: "manual", table: "items" },
          history_table: "wf_log",
          actions: [{ action: "create_record", table: "owned_log", values: actorValues("manual") }],
        },
        {
          id: "wf_manual_as",
          name: "担当として押す",
          trigger: { type: "manual", table: "items" },
          history_table: "wf_log",
          act_as: "$record.holder",
          actions: [
            { action: "create_record", table: "owned_log", values: actorValues("manual_as") },
          ],
        },
        // 時刻起動(行を選ばない・選ぶ)。
        {
          id: "wf_sched",
          name: "時刻で記録する",
          trigger: { type: "schedule", at: { hour: 9, minute: 0 } },
          history_table: "wf_log",
          actions: [
            {
              action: "create_record",
              table: "actor_log",
              values: {
                src: "sched",
                aid: "$actor.id",
                alogin: "$actor.login",
                arole: "$actor.role",
              },
            },
          ],
        },
        logTo(
          "wf_sched_rows",
          { type: "schedule", at: { hour: 9, minute: 0 }, table: "strig" },
          "sched_rows",
        ),
        // AI の書き戻し(担当として動く = ジョブの主体は担当の持ち主)。
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
        logTo("wf_ai_log", { type: "on_update", table: "aitab" }, "ai"),
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
  inboxEndpoint: string;
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

async function makeRig(): Promise<Rig> {
  const dataRoot = await mkdtemp(join(tmpdir(), "gp-actor-entry-"));
  dataRoots.push(dataRoot);
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, "入口ごとの操作者", { app_id: APP_ID });
  } finally {
    meta.close();
  }
  const applied = applyManifest(dataRoot, APP_ID, withDefaultRoleRules(manifest()));
  if (!applied.valid) {
    throw new Error(JSON.stringify(applied.errors));
  }
  process.env[KEY_ENV_VAR] = SIGNING_KEY;
  const inbound = InboundStore.openForKernel(dataRoot);
  let inboxEndpoint: string;
  try {
    inboxEndpoint = inbound.issueInboundEndpoint({
      appId: APP_ID,
      name: "inbox",
      secretSource: { kind: "env", value: KEY_ENV_VAR },
      targetTable: "inbox",
    }).id;
  } finally {
    inbound.close();
  }
  // 最初の1人は運営(`owner`)。 操作者の役割を見分けるため、3人は `editor` にする。
  seedSession(dataRoot, APP_ID, { role: "owner", username: "boss" });
  return {
    dataRoot,
    server: createServerApp({ dataRoot }),
    alice: seedSession(dataRoot, APP_ID, { role: "editor", username: "alice" }),
    bob: seedSession(dataRoot, APP_ID, { role: "editor", username: "bob" }),
    carol: seedSession(dataRoot, APP_ID, { role: "editor", username: "carol" }),
    inboxEndpoint,
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

/** 行の今の版(`_updated_at`)を If-Match に付けて更新する。 */
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

function rowsOf(rig: Rig, table: string): Record<string, unknown>[] {
  const db = new Database(appDbPath(rig.dataRoot, APP_ID), { readonly: true });
  try {
    return db.query<Record<string, unknown>, []>(`SELECT * FROM "${table}" ORDER BY rowid`).all();
  } finally {
    db.close();
  }
}

/** 記録の行から、操作者の3つの値だけを抜く。 */
function actorOf(row: Record<string, unknown> | undefined): Record<string, unknown> {
  return { id: row?.aid, login: row?.alogin, role: row?.arole };
}

function logsOf(rig: Rig, src: string, table = "actor_log"): Record<string, unknown>[] {
  return rowsOf(rig, table).filter((row) => row.src === src);
}

function expectedActor(who: SeededSession): Record<string, unknown> {
  return { id: who.userId, login: who.username, role: who.role };
}

const EMPTY = { id: "", login: "", role: "" };

describe("V23-M4-T03 画面・HTTP の入口は、ログイン中の利用者を運ぶ", () => {
  test("(http-post) 作成の on_create は、作った人の id・ログイン名・アカウントの役割を書く", async () => {
    const rig = await makeRig();
    const item = await mustCreate(rig, rig.alice, "items", { title: "一" });
    const logs = logsOf(rig, "create");
    expect(logs).toHaveLength(1);
    expect(logs[0]?.item).toBe(item);
    expect(actorOf(logs[0])).toEqual(expectedActor(rig.alice));
    expect(rig.alice.role).toBe("editor");
  });

  test("(http-patch) 更新の on_update は、更新した人を書く(作った人ではない)", async () => {
    const rig = await makeRig();
    const item = await mustCreate(rig, rig.alice, "items", { title: "一" });
    const res = await patch(rig, rig.bob, "items", item, { memo: "直した" });
    expect(res.status, await res.clone().text()).toBe(200);
    const logs = logsOf(rig, "update");
    expect(logs).toHaveLength(1);
    expect(actorOf(logs[0])).toEqual(expectedActor(rig.bob));
  });

  test("(http-batch) 一括の作成・更新は、送った人を書く", async () => {
    const rig = await makeRig();
    const item = await mustCreate(rig, rig.alice, "items", { title: "一" });
    const res = await send(rig, rig.carol, "POST", `/api/apps/${APP_ID}/batch`, {
      ops: [
        { op: "create", table: "items", values: { title: "二" } },
        { op: "update", table: "items", target: item, values: { memo: "一括" } },
      ],
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const created = logsOf(rig, "create");
    expect(created).toHaveLength(2);
    expect(actorOf(created[1])).toEqual(expectedActor(rig.carol));
    const updated = logsOf(rig, "update");
    expect(updated).toHaveLength(1);
    expect(updated[0]?.item).toBe(item);
    expect(actorOf(updated[0])).toEqual(expectedActor(rig.carol));
  });

  test("(chain) 連鎖(2段)は起点の操作者をそのまま引き継ぐ", async () => {
    const rig = await makeRig();
    await mustCreate(rig, rig.bob, "items", { title: "一" });
    const logs = logsOf(rig, "chain");
    expect(logs).toHaveLength(1);
    expect(actorOf(logs[0])).toEqual(expectedActor(rig.bob));
  });

  test("(island) 島の write_ops が起こした発火も起点の操作者を引き継ぐ", async () => {
    const rig = await makeRig();
    await mustCreate(rig, rig.carol, "items", { title: "一" });
    expect(rowsOf(rig, "ext")).toHaveLength(1);
    const logs = logsOf(rig, "island");
    expect(logs).toHaveLength(1);
    expect(actorOf(logs[0])).toEqual(expectedActor(rig.carol));
  });
});

describe("V23-M4-T03 送信内容から1バイトも読まない(ADR-0500 限定16)", () => {
  test("(forge) 参照の綴りや偽の id を送っても、記録されるのはログイン中の利用者", async () => {
    const rig = await makeRig();
    const res = await send(rig, rig.alice, "POST", recordsPath("items"), {
      title: "$actor.id",
      memo: rig.bob.userId,
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const logs = logsOf(rig, "create");
    expect(logs).toHaveLength(1);
    expect(actorOf(logs[0])).toEqual(expectedActor(rig.alice));
    // 送信内容は行にリテラルのまま入る(参照として解かない)。
    expect(rowsOf(rig, "items")[0]?.title).toBe("$actor.id");
  });

  test("(forge-extra) 知らない欄に操作者を名乗る値を足した一括は断られ、記録は1行も増えない", async () => {
    const rig = await makeRig();
    const res = await send(rig, rig.alice, "POST", `/api/apps/${APP_ID}/batch`, {
      ops: [
        {
          op: "create",
          table: "items",
          values: { title: "二", actor: { id: rig.bob.userId, login: "bob", role: "owner" } },
        },
      ],
    });
    expect(res.status).not.toBe(200);
    expect(logsOf(rig, "create")).toHaveLength(0);
  });

  test("(forge-log) 記録の表へ直接書いた偽の値は、自動処理の書く値に混ざらない", async () => {
    const rig = await makeRig();
    await mustCreate(rig, rig.alice, "actor_log", {
      src: "create",
      aid: rig.bob.userId,
      alogin: "bob",
      arole: "owner",
    });
    await mustCreate(rig, rig.alice, "items", { title: "一" });
    const logs = logsOf(rig, "create");
    expect(logs).toHaveLength(2);
    expect(actorOf(logs[1])).toEqual(expectedActor(rig.alice));
  });
});

describe("V23-M4-T03 並行の要求で混ざらない(ADR-0524 限定17)", () => {
  test("(concurrent) 別の人の PATCH を同時に撃っても、各行の記録はその行を更新した人", async () => {
    const rig = await makeRig();
    const people = [rig.alice, rig.bob, rig.carol];
    const items: string[] = [];
    for (let i = 0; i < 9; i += 1) {
      items.push(await mustCreate(rig, rig.alice, "items", { title: `品${i}` }));
    }
    const responses = await Promise.all(
      items.map((item, i) =>
        patch(rig, people[i % 3] as SeededSession, "items", item, { memo: `並行${i}` }),
      ),
    );
    for (const res of responses) {
      expect(res.status).toBe(200);
    }
    const logs = logsOf(rig, "update");
    expect(logs).toHaveLength(9);
    items.forEach((item, i) => {
      const log = logs.find((row) => row.item === item);
      expect(actorOf(log)).toEqual(expectedActor(people[i % 3] as SeededSession));
    });
  });
});

describe("V23-M4-T03 受信口と時刻起動", () => {
  test("(inbound) 受信口の作成は id・login が空、role は inbound", async () => {
    const rig = await makeRig();
    const rawBody = JSON.stringify({ ev: "e1" });
    const signature = `sha256=${createHmac("sha256", SIGNING_KEY).update(Buffer.from(rawBody, "utf-8")).digest("hex")}`;
    const res = await rig.server.request(
      new Request(`http://localhost/inbound/${rig.inboxEndpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Mock-PSP-Signature": signature },
        body: rawBody,
      }),
    );
    expect(res.status, await res.clone().text()).toBe(201);
    const logs = logsOf(rig, "inbound");
    expect(logs).toHaveLength(1);
    expect(actorOf(logs[0])).toEqual({ id: "", login: "", role: "inbound" });
  });

  test("(schedule) 時刻起動は、行を選ばないもの・選ぶものとも id・login が空、role は schedule", async () => {
    const rig = await makeRig();
    await mustCreate(rig, rig.alice, "strig", { note: "対象1" });
    await mustCreate(rig, rig.bob, "strig", { note: "対象2" });
    // 2026-09-30 10:00(Asia/Tokyo)。 9:00 の時刻起動が期限を過ぎている。
    setWorkflowClock({ now: () => new Date("2026-09-30T01:00:00.000Z") });
    runSchedulerTick({ dataRoot: rig.dataRoot, timeZone: "Asia/Tokyo" });
    const plain = logsOf(rig, "sched");
    expect(plain).toHaveLength(1);
    expect(actorOf(plain[0])).toEqual({ id: "", login: "", role: "schedule" });
    const rows = logsOf(rig, "sched_rows");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(actorOf(row)).toEqual({ id: "", login: "", role: "schedule" });
    }
  });
});

describe("V23-M4-T03 手動起動は押した人(判定の主体は今日どおり、ADR-0500 限定19)", () => {
  async function press(rig: Rig, who: SeededSession, workflow: string, item: string) {
    return await send(
      rig,
      who,
      "POST",
      `/api/apps/${APP_ID}/views/item_list/actions/run?workflow=${workflow}&record=${item}`,
    );
  }

  test("(manual) act_as の無いボタンは、押した人を書き、持ち主も押した人", async () => {
    const rig = await makeRig();
    const item = await mustCreate(rig, rig.alice, "items", { title: "一" });
    const res = await press(rig, rig.bob, "wf_manual", item);
    expect(res.status, await res.clone().text()).toBe(200);
    const logs = logsOf(rig, "manual", "owned_log");
    expect(logs).toHaveLength(1);
    expect(actorOf(logs[0])).toEqual(expectedActor(rig.bob));
    expect(logs[0]?.st_owner).toBe(rig.bob.userId);
  });

  test("(manual-act-as) act_as のあるボタンも $actor は押した人。持ち主(判定の主体)は act_as の先の持ち主のまま", async () => {
    const rig = await makeRig();
    const holder = await mustCreate(rig, rig.carol, "holders", { name: "かろるの担当" });
    expect(rowsOf(rig, "holders")[0]?.st_owner).toBe(rig.carol.userId);
    const item = await mustCreate(rig, rig.alice, "items", { title: "一", holder });
    const res = await press(rig, rig.alice, "wf_manual_as", item);
    expect(res.status, await res.clone().text()).toBe(200);
    const logs = logsOf(rig, "manual_as", "owned_log");
    expect(logs).toHaveLength(1);
    expect(actorOf(logs[0])).toEqual(expectedActor(rig.alice));
    // 判定の主体は今日どおり act_as が勝つ(押した人ではない)。
    expect(logs[0]?.st_owner).toBe(rig.carol.userId);
  });
});

describe("V23-M4-T03 AI の書き戻しはジョブの主体(D-V23-103)", () => {
  test("(ai) 書き戻しが起こした on_update の $actor は、判定の主体(act_as の先の持ち主)で、更新した人と割れる", async () => {
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
    const byPatch = logsOf(rig, "ai");
    expect(byPatch).toHaveLength(1);
    expect(actorOf(byPatch[0])).toEqual(expectedActor(rig.alice));

    const provider: AiProvider = async () => ({
      text: '{"value":"good"}',
      inputTokens: 1,
      outputTokens: 1,
    });
    await dispatchAiJobs(rig.dataRoot, provider);
    expect(rowsOf(rig, "aitab")[0]?.label).toBe("good");
    const logs = logsOf(rig, "ai");
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(actorOf(logs[1])).toEqual(expectedActor(rig.carol));
  });
});

describe("V23-M4-T03 起点を渡さない呼び出しは空", () => {
  test("(kernel-direct) カーネルを直に呼んだ作成は、3つとも空文字", async () => {
    const rig = await makeRig();
    const db = new Database(appDbPath(rig.dataRoot, APP_ID));
    try {
      const m = withDefaultRoleRules(manifest());
      const created = createRecord(db, m, "items", { title: "直" });
      expect(created.ok).toBe(true);
    } finally {
      db.close();
    }
    const logs = logsOf(rig, "create");
    expect(logs).toHaveLength(1);
    expect(actorOf(logs[0])).toEqual(EMPTY);
  });
});
