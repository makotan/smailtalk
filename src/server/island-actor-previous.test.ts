/**
 * **島の入力 `source: "actor"` / `source: "previous"`**(`V23-M4-T06`。`D-V23-93`・`D-V23-97`・
 * `D-V23-103`。 門A `ADR-0500` §Decision 1-3 と限定7・20 / `ADR-0524` §Decision 1-4)。
 *
 * - `actor` … 起点の `$actor` と同じ `{ id, login, role }`(HTTP = ログイン中の利用者・手動起動 =
 *   押した人・時刻起動 = 空と `schedule`・連鎖 = 起点を引き継ぐ)。
 * - `previous` … 更新前の行全体(`on_update` の `run_function` だけ)。 形は `source: "record"` と同じ
 *   (同じ読み方の行。 伏せる項目の扱いも同じ = どちらも伏せない)。
 * - 配列形の中でも使える。 宣言しない島の入力は今日と同じ。
 * - 島が返した値・島が入力を書き換えたことで、`$actor` を選べない(`ADR-0500` §Decision 1-3)。
 *
 * 島の出力を `output_table` に「受け取った入力の JSON」として書かせて、島が受け取った値を見る。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appDbPath,
  applyManifest,
  createApp,
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

const APP_ID = "island-actor-previous";

const HISTORY_FIELDS = [
  { id: "ran_at", name: "実行時刻", type: "date" },
  { id: "workflow", name: "ワークフロー", type: "text" },
  { id: "trigger_type", name: "きっかけ", type: "text" },
  { id: "status", name: "結果", type: "text" },
  { id: "error", name: "エラー", type: "long_text" },
];

/** 受け取った入力をそのまま JSON にして1行で返す島。 */
const DUMP_CODE =
  "export default function (input) { return [{ payload: JSON.stringify(input) }]; }";
const DUMP_OUTPUT = { fields: [{ id: "payload", type: "long_text" }] };
const SEEN_FIELDS = [{ id: "payload", name: "受け取った入力", type: "long_text" }];

function seen(id: string): Record<string, unknown> {
  return { id, name: id, fields: SEEN_FIELDS };
}

function runInto(
  id: string,
  trigger: Record<string, unknown>,
  fn: string,
  output: string,
): Record<string, unknown> {
  return {
    id,
    name: id,
    trigger,
    history_table: "wf_log",
    actions: [{ action: "run_function", function: fn, output_table: output }],
  };
}

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "島の入力",
      tables: [
        {
          id: "items",
          name: "品目",
          fields: [
            { id: "title", name: "題", type: "text" },
            { id: "st_updated_by", name: "更新者", type: "text" },
          ],
        },
        {
          id: "orders",
          name: "指図",
          fields: [
            { id: "target", name: "対象", type: "reference", reference_table: "items" },
            { id: "newv", name: "新しい題", type: "text" },
          ],
        },
        { id: "pokes", name: "島への指図", fields: [{ id: "note", name: "メモ", type: "text" }] },
        { id: "ext", name: "島が作る行", fields: [{ id: "note", name: "メモ", type: "text" }] },
        {
          id: "actor_log",
          name: "操作者の記録",
          fields: [
            { id: "src", name: "出どころ", type: "text" },
            { id: "aid", name: "ID", type: "text" },
            { id: "alogin", name: "ログイン名", type: "text" },
            { id: "arole", name: "役割", type: "text" },
          ],
        },
        seen("seen_update"),
        seen("seen_plain"),
        seen("seen_manual"),
        seen("seen_sched"),
        seen("seen_after"),
        { id: "wf_log", name: "実行履歴", fields: HISTORY_FIELDS },
      ],
      views: [
        {
          id: "item_list",
          type: "list_view",
          table: "items",
          columns: ["title"],
          actions: [{ id: "press", run: "wf_manual", name: "押す" }],
        },
      ],
      functions: [
        {
          id: "f_all",
          name: "行と更新前と操作者",
          code: DUMP_CODE,
          input: [{ source: "record" }, { source: "previous" }, { source: "actor" }],
          output: DUMP_OUTPUT,
        },
        {
          id: "f_plain",
          name: "宣言しない島",
          code: DUMP_CODE,
          input: [{ source: "record" }, { source: "table", table: "items" }],
          output: DUMP_OUTPUT,
        },
        {
          id: "f_actor",
          name: "操作者だけ",
          code: DUMP_CODE,
          input: { source: "actor" },
          output: DUMP_OUTPUT,
        },
        {
          id: "f_evil",
          name: "操作者を書き換えようとする島",
          code: 'export default function (input) { input.id = "evil"; input.login = "evil"; input.role = "owner"; return [{ op: "create", table: "ext", values: { note: JSON.stringify(input) } }]; }',
          input: { source: "actor" },
          output: { ops: true },
        },
      ],
      workflows: [
        runInto("wf_upd", { type: "on_update", table: "items" }, "f_all", "seen_update"),
        runInto("wf_plain", { type: "on_update", table: "items" }, "f_plain", "seen_plain"),
        // 連鎖: 指図の作成 → 品目の更新 → wf_upd / wf_plain。
        {
          id: "wf_order",
          name: "指図で品目を直す",
          trigger: { type: "on_create", table: "orders" },
          history_table: "wf_log",
          actions: [
            {
              action: "update_record",
              table: "items",
              target: "$record.target",
              values: { title: "$record.newv" },
            },
          ],
        },
        runInto("wf_manual", { type: "manual", table: "items" }, "f_actor", "seen_manual"),
        runInto(
          "wf_sched",
          { type: "schedule", at: { hour: 9, minute: 0 } },
          "f_actor",
          "seen_sched",
        ),
        // 島が入力を書き換え、書き換えた値を行に書く → その行の作成の $actor と、後のアクションの島の入力。
        {
          id: "wf_evil",
          name: "島が操作者を書き換えようとする",
          trigger: { type: "on_create", table: "pokes" },
          history_table: "wf_log",
          actions: [
            { action: "run_function", function: "f_evil", write_ops: true },
            { action: "run_function", function: "f_actor", output_table: "seen_after" },
          ],
        },
        {
          id: "wf_ext",
          name: "島が作った行の操作者",
          trigger: { type: "on_create", table: "ext" },
          history_table: "wf_log",
          actions: [
            {
              action: "create_record",
              table: "actor_log",
              values: {
                src: "ext",
                aid: "$actor.id",
                alogin: "$actor.login",
                arole: "$actor.role",
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
};

const dataRoots: string[] = [];

beforeAll(async () => {
  await ensureIslandRuntimeReady();
});

afterEach(async () => {
  resetWorkflowClock();
  for (const dir of dataRoots.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeRig(m: Manifest = manifest()): Promise<Rig> {
  const dataRoot = await mkdtemp(join(tmpdir(), "gp-island-actor-previous-"));
  dataRoots.push(dataRoot);
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, "島の入力", { app_id: APP_ID });
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

/** 島が受け取った入力(出力の表の1行の JSON を読み戻す)。 */
function received(rig: Rig, table: string): unknown[] {
  return rowsOf(rig, table).map((row) => JSON.parse(String(row.payload)));
}

function historyOf(rig: Rig, workflow: string): Record<string, unknown>[] {
  return rowsOf(rig, "wf_log").filter((row) => row.workflow === workflow);
}

function expectedActor(who: SeededSession): Record<string, unknown> {
  return { id: who.userId, login: who.username, role: who.role };
}

describe("V23-M4-T06 on_update の run_function が [record, previous, actor] を受け取る", () => {
  test("(http-patch) HTTP の PATCH: record は更新後の行、previous は更新前の行全体、actor は更新した人", async () => {
    const rig = await makeRig();
    const item = await mustCreate(rig, rig.alice, "items", { title: "旧" });
    const before = rowsOf(rig, "items")[0];
    await mustPatch(rig, rig.bob, "items", item, { title: "新" });
    const after = rowsOf(rig, "items")[0];
    expect(historyOf(rig, "wf_upd").map((row) => row.status)).toEqual(["success"]);
    const got = received(rig, "seen_update");
    expect(got).toHaveLength(1);
    const [record, previous, actor] = got[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(record).toEqual(after as Record<string, unknown>);
    expect(previous).toEqual(before as Record<string, unknown>);
    expect(previous.title).toBe("旧");
    expect(record.title).toBe("新");
    // 更新前の行の更新者は作った人、更新後は更新した人。
    expect(previous.st_updated_by).toBe(rig.alice.userId);
    expect(record.st_updated_by).toBe(rig.bob.userId);
    // previous は record と同じ形(同じ鍵。伏せる項目の扱いも同じ)。
    expect(Object.keys(previous).sort()).toEqual(Object.keys(record).sort());
    expect(actor).toEqual(expectedActor(rig.bob));
  });

  test("(chain) 連鎖: 指図の作成が起こした更新でも、previous は更新前・actor は起点(指図を作った人)", async () => {
    const rig = await makeRig();
    const item = await mustCreate(rig, rig.alice, "items", { title: "旧" });
    const before = rowsOf(rig, "items")[0];
    await mustCreate(rig, rig.bob, "orders", { target: item, newv: "指図の題" });
    const got = received(rig, "seen_update");
    expect(got).toHaveLength(1);
    const [record, previous, actor] = got[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(previous).toEqual(before as Record<string, unknown>);
    expect(record.title).toBe("指図の題");
    expect(actor).toEqual(expectedActor(rig.bob));
  });

  test("(undeclared) actor / previous を宣言しない島は、今日と同じ [record, table の全行] を受け取る", async () => {
    const rig = await makeRig();
    const item = await mustCreate(rig, rig.alice, "items", { title: "旧" });
    await mustCreate(rig, rig.alice, "items", { title: "もう1つ" });
    await mustPatch(rig, rig.bob, "items", item, { title: "新" });
    const all = rowsOf(rig, "items");
    const got = received(rig, "seen_plain");
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual([all.find((row) => row._id === item), all]);
    // 2要素のまま(actor・previous が紛れ込まない)。
    expect((got[0] as unknown[]).length).toBe(2);
  });
});

describe("V23-M4-T06 手動起動と時刻起動の actor", () => {
  test("(manual) 手動起動は押した人", async () => {
    const rig = await makeRig();
    const item = await mustCreate(rig, rig.alice, "items", { title: "一" });
    const res = await send(
      rig,
      rig.bob,
      "POST",
      `/api/apps/${APP_ID}/views/item_list/actions/run?workflow=wf_manual&record=${item}`,
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect(received(rig, "seen_manual")).toEqual([expectedActor(rig.bob)]);
  });

  test("(schedule) 時刻起動は id・login が空、role は schedule", async () => {
    const rig = await makeRig();
    // 2026-09-30 10:00(Asia/Tokyo)。 9:00 の時刻起動が期限を過ぎている。
    setWorkflowClock({ now: () => new Date("2026-09-30T01:00:00.000Z") });
    runSchedulerTick({ dataRoot: rig.dataRoot, timeZone: "Asia/Tokyo" });
    expect(historyOf(rig, "wf_sched").map((row) => row.status)).toEqual(["success"]);
    expect(received(rig, "seen_sched")).toEqual([{ id: "", login: "", role: "schedule" }]);
  });
});

describe("V23-M4-T06 島が返した値で actor を選べない(ADR-0500 §Decision 1-3)", () => {
  test("(island-cannot-choose) 島が入力の actor を書き換えて返しても、起こした発火と後の島の actor は起点のまま", async () => {
    const rig = await makeRig();
    await mustCreate(rig, rig.bob, "pokes", { note: "押す" });
    expect(historyOf(rig, "wf_evil").map((row) => row.status)).toEqual(["success"]);
    // 島が書いた行には、島が書き換えた値が入る(島の中の書き換え自体は島の自由)。
    const ext = rowsOf(rig, "ext");
    expect(ext).toHaveLength(1);
    expect(JSON.parse(String(ext[0]?.note))).toEqual({ id: "evil", login: "evil", role: "owner" });
    // その行の作成が起こした発火の $actor は、起点(指図を作った人)のまま。
    const logs = rowsOf(rig, "actor_log").filter((row) => row.src === "ext");
    expect(logs).toHaveLength(1);
    const logged: Record<string, unknown> = {
      id: logs[0]?.aid,
      login: logs[0]?.alogin,
      role: logs[0]?.arole,
    };
    expect(logged).toEqual(expectedActor(rig.bob));
    // 同じワークフローの後のアクションの島も、書き換えられていない actor を受け取る。
    expect(received(rig, "seen_after")).toEqual([expectedActor(rig.bob)]);
  });
});
