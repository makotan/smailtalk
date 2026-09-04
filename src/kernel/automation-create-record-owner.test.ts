/**
 * **`V8-M37` / 台帳 `F-G4`(門A)—— 同じ発火で `create_record` と島の `write_ops` の
 * 持ち主の入り方を揃える。**
 *
 * ## **着手前の実物(2026-08-13。`docs/plan/v8/records/v8-m35-prestate-m33.md` §C)**
 *
 * **`src/kernel/workflow-runner.ts` の `create_record` は
 * `createRecord(db, manifest, action.table, values.value)` を呼ぶだけで、
 * 持ち主の列に1バイトも書かなかった。** **一方、同じ発火から動く島の `write_ops` は
 * サーバ層の `judgeOwnerScopedOp` が `mutableValues[OWNER_FIELD] = actorId` で押していた。**
 * **同じ1回の発火で、行の持ち主が入る経路と入らない経路が並んでいた。**
 *
 * ## **採った道(`docs/plan/v8/records/v8-m35.md` §5-1。審査 = 限定採用)**
 *
 * **道A = 島の側に揃える(= `create_record` も持ち主を押す)。**
 *
 * ## **【限定。この検査が固定する境界】**
 *
 * | | 固定するもの |
 * |---|---|
 * | 1 | **押すのは、その表が持ち主の列(`text` かつ `required` でない)を持つときだけ** |
 * | 2 | **時刻起動(`schedule`)では1バイトも変えない** —— **主体が解けないためである** |
 * | 3 | **主体が解けない発火では今日どおり書かない**(fail-open にしない) |
 * | 4 | **押す値は島とまったく同じ1本の主体である**(`resolveWorkflowActor` の答え) |
 * | 5 | **`src/kernel/` の公開 export を1つも増やしていない**(`Δ8` 非発火) |
 *
 * ## **この検査が言わないこと(誇張しない)**
 *
 * - **「揃った」と言い切れるのは非時刻起動だけである**(`docs/plan/v8/records/v8-m35.md`
 *   §5-4 の `S3` の 2)。**時刻起動は今日も揃っていない。**
 * - **AI(MCP)の経路は1件も通っていない。**
 * - **`update_record` は射程外である** —— **押すのは作成だけである。**
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedAutomationActor } from "./automation-actor-fixture.test.ts";
import { applyManifestDdl } from "./ddl.ts";
import { ensureIslandRuntimeReady } from "./island-runner.ts";
import { createRecord, listRecords } from "./records.ts";
import type { Manifest, Workflow } from "./types.ts";
import { runScheduledWorkflow } from "./workflow-runner.ts";

/** 履歴テーブルの5列(規約どおりの形。**1本も足していない**)。 */
const HISTORY_FIELDS = [
  { id: "ran_at", name: "実行時刻", type: "date" as const },
  { id: "workflow", name: "ワークフロー", type: "text" as const },
  { id: "trigger_type", name: "きっかけ", type: "text" as const },
  { id: "status", name: "結果", type: "text" as const },
  { id: "error", name: "エラー", type: "long_text" as const },
];

/** 書き手(`_auth_users` に立てる1人)。 */
const WRITER = "u-writer";

/**
 * **題材。**
 *
 * - `orders` … きっかけの表。**持ち主の列を持つ**ので、この表の行から書き手が決まる。
 * - `notes` … 書込先。**持ち主の列を持つ**(押される側)。
 * - `plain_notes` … 書込先。**持ち主の列を持たない**(押されない側 = 限定1 の対照)。
 * - `wf-runs` … 履歴。
 */
function baseManifest(workflows: Workflow[]): Manifest {
  return {
    app: {
      id: "create-record-owner",
      name: "作成の持ち主",
      tables: [
        {
          id: "orders",
          name: "注文",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "st_owner", name: "持ち主", type: "text" },
          ],
        },
        {
          id: "notes",
          name: "メモ",
          fields: [
            { id: "body", name: "本文", type: "text" },
            { id: "st_owner", name: "持ち主", type: "text" },
          ],
        },
        {
          id: "plain_notes",
          name: "持ち主のないメモ",
          fields: [{ id: "body", name: "本文", type: "text" }],
        },
        { id: "wf-runs", name: "実行履歴", fields: HISTORY_FIELDS },
      ],
      views: [],
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            { target: "table", table: "orders", can: ["read", "write", "delete"] },
            { target: "table", table: "notes", can: ["read", "write", "delete"] },
            { target: "table", table: "plain_notes", can: ["read", "write", "delete"] },
            { target: "table", table: "wf-runs", can: ["read", "write", "delete"] },
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
          ],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
      functions: [
        {
          id: "island",
          name: "島も1行作る",
          // **島は持ち主を1文字も選べない** —— ここで書いても呼び出し側が上書きする。
          code:
            'export default function () { return [{ op: "create", table: "notes", ' +
            'values: { body: "島から", st_owner: "someone-else" } }]; }',
          input: { source: "record" },
          output: { ops: true },
        },
      ],
      workflows,
    },
  } as unknown as Manifest;
}

/** 登録をきっかけに動く処理。**`create_record` と島の `write_ops` を同じ発火で並べる。** */
const ON_CREATE_BOTH = {
  id: "wf-both",
  name: "注文が入ったら、両方の経路で1行ずつ作る",
  trigger: { type: "on_create", table: "orders" },
  history_table: "wf-runs",
  actions: [
    { action: "create_record", table: "notes", values: { body: "$record.title" } },
    { action: "run_function", function: "island", write_ops: true },
  ],
} as unknown as Workflow;

/** 登録をきっかけに動く処理(`create_record` だけ)。 */
const ON_CREATE_ONLY = {
  id: "wf-create",
  name: "注文が入ったらメモを作る",
  trigger: { type: "on_create", table: "orders" },
  history_table: "wf-runs",
  actions: [{ action: "create_record", table: "notes", values: { body: "$record.title" } }],
} as unknown as Workflow;

/** **ワークフロー定義が持ち主を名指ししている形**(島と同じく上書きされることを見る)。 */
const ON_CREATE_DECLARED_OWNER = {
  id: "wf-declared",
  name: "定義が持ち主を名指しする",
  trigger: { type: "on_create", table: "orders" },
  history_table: "wf-runs",
  actions: [
    {
      action: "create_record",
      table: "notes",
      values: { body: "$record.title", st_owner: "someone-else" },
    },
  ],
} as unknown as Workflow;

/** 持ち主の列を持たない表へ作る形(限定1 の対照)。 */
const ON_CREATE_PLAIN = {
  id: "wf-plain",
  name: "持ち主のない表に作る",
  trigger: { type: "on_create", table: "orders" },
  history_table: "wf-runs",
  actions: [{ action: "create_record", table: "plain_notes", values: { body: "$record.title" } }],
} as unknown as Workflow;

/** **時刻起動(行選択なし)。** **主体が解けない。** */
const SCHEDULE_PLAIN = {
  id: "wf-schedule",
  name: "毎朝メモを作る",
  trigger: { type: "schedule", at: { hour: 9, minute: 0 } },
  history_table: "wf-runs",
  actions: [{ action: "create_record", table: "notes", values: { body: "時刻起動から" } }],
} as unknown as Workflow;

/** **時刻起動(行選択つき)。** **主体は解けるのに掛けない**(`D-V8-99` / `U-3`)。 */
const SCHEDULE_WITH_TABLE = {
  id: "wf-schedule-rows",
  name: "毎朝、注文ごとにメモを作る",
  trigger: { type: "schedule", at: { hour: 9, minute: 0 }, table: "orders" },
  history_table: "wf-runs",
  actions: [{ action: "create_record", table: "notes", values: { body: "行つき時刻起動から" } }],
} as unknown as Workflow;

let dir: string;
let db: Database;

function boot(workflows: Workflow[]): Manifest {
  const manifest = baseManifest(workflows);
  applyManifestDdl(db, manifest);
  seedAutomationActor(db, WRITER);
  return manifest;
}

function rows(manifest: Manifest, tableId: string): Record<string, unknown>[] {
  const result = listRecords(db, manifest, tableId, {});
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result.ok ? (result.value as unknown as Record<string, unknown>[]) : [];
}

/** 履歴に残った失敗の理由(**黙って止まっていないことを見る**)。 */
function historyErrors(manifest: Manifest): string[] {
  return rows(manifest, "wf-runs")
    .map((row) => (typeof row.error === "string" ? row.error : ""))
    .filter((one) => one !== "");
}

beforeEach(async () => {
  await ensureIslandRuntimeReady();
  dir = await mkdtemp(join(tmpdir(), "gp-create-record-owner-"));
  db = new Database(join(dir, "app.sqlite"), { create: true });
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (1) **揃った** —— 同じ発火の2経路が同じ持ち主を書く
// ---------------------------------------------------------------------------

test("(F-G4 1) 同じ発火の create_record と島の write_ops が、同じ持ち主の行を作る", () => {
  const manifest = boot([ON_CREATE_BOTH]);
  const created = createRecord(db, manifest, "orders", { title: "注文A", st_owner: WRITER });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  expect(historyErrors(manifest)).toEqual([]);

  const notes = rows(manifest, "notes");
  expect(notes).toHaveLength(2);
  const byBody = new Map(notes.map((row) => [String(row.body), row.st_owner]));
  // **着手前は `create_record` の側だけが `null` だった**(島の側は書き手が入っていた)。
  expect(byBody.get("注文A")).toBe(WRITER);
  expect(byBody.get("島から")).toBe(WRITER);
  expect(byBody.get("注文A")).toBe(byBody.get("島から"));
});

test("(F-G4 2) create_record だけの発火でも、作った行の持ち主はきっかけの行の持ち主になる", () => {
  const manifest = boot([ON_CREATE_ONLY]);
  const created = createRecord(db, manifest, "orders", { title: "注文B", st_owner: WRITER });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  expect(rows(manifest, "notes").map((row) => row.st_owner)).toEqual([WRITER]);
});

test("(F-G4 3) 定義が持ち主を名指ししていても、解決した主体で上書きされる(島とまったく同じ)", () => {
  const manifest = boot([ON_CREATE_DECLARED_OWNER]);
  const created = createRecord(db, manifest, "orders", { title: "注文C", st_owner: WRITER });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  expect(rows(manifest, "notes").map((row) => row.st_owner)).toEqual([WRITER]);
});

// ---------------------------------------------------------------------------
// (2) **限定1** —— 持ち主の列を持たない表には1バイトも書かない
// ---------------------------------------------------------------------------

test("(F-G4 4) 持ち主の列を持たない表への create_record は1ミリも変わらない", () => {
  const manifest = boot([ON_CREATE_PLAIN]);
  const created = createRecord(db, manifest, "orders", { title: "注文D", st_owner: WRITER });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  const plain = rows(manifest, "plain_notes");
  expect(plain).toHaveLength(1);
  expect(plain[0]).not.toHaveProperty("st_owner");
  expect(historyErrors(manifest)).toEqual([]);
});

// ---------------------------------------------------------------------------
// (3) **限定2 / 限定3** —— 時刻起動と、主体が解けない発火は今日どおり
// ---------------------------------------------------------------------------

test("(F-G4 5)【正直に書く】時刻起動(行選択なし)の create_record は今日どおり持ち主を書かない", () => {
  const manifest = boot([SCHEDULE_PLAIN]);
  runScheduledWorkflow(db, manifest, SCHEDULE_PLAIN);
  expect(rows(manifest, "notes").map((row) => row.st_owner)).toEqual([null]);
  expect(historyErrors(manifest)).toEqual([]);
});

test("(F-G4 6)【正直に書く】行選択つきの時刻起動も今日どおり —— 主体は解けるのに押していない", () => {
  const manifest = boot([SCHEDULE_WITH_TABLE]);
  const seeded = createRecord(db, manifest, "orders", { title: "朝の注文", st_owner: WRITER });
  expect(seeded.ok, JSON.stringify(seeded)).toBe(true);
  const source = listRecords(db, manifest, "orders", {});
  expect(source.ok).toBe(true);
  runScheduledWorkflow(db, manifest, SCHEDULE_WITH_TABLE, {
    records: source.ok ? (source.value as never) : ([] as never),
  });
  // **これが本単位の完了後にも残る食い違いである**(`D-V8-99` / `U-3`)。
  expect(rows(manifest, "notes").map((row) => row.st_owner)).toEqual([null]);
  expect(historyErrors(manifest)).toEqual([]);
});

test("(F-G4 7) 主体が解けない発火では、今日どおり持ち主を書かない(fail-open にしない)", () => {
  const manifest = boot([ON_CREATE_ONLY]);
  // **きっかけの行に持ち主が無い** → `resolveWorkflowActor` は空文字に倒れる。
  const created = createRecord(db, manifest, "orders", { title: "持ち主のいない注文" });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  expect(rows(manifest, "notes").map((row) => row.st_owner)).toEqual([null]);
});
