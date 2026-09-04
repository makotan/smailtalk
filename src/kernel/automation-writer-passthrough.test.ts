/**
 * **`V8-M26` —— 自動処理の書込に面(役割に束ねた権限)を掛ける条件の検査。**
 *
 * ## **測る1本の線**
 *
 * **書き手が特定できる発火は面の判定を受け、書き手が特定できない発火は今日どおり通る。**
 *
 * ## **なぜ「規則が書かれていないから通す」ではなくなったか(実測。2026-08-10)**
 *
 * **着手前の `judgeAutomationWrite` は、面も点も管轄外の表への自動書込を素通ししていた** ——
 * **その「面が管轄外か」は `judgeRoleAccess(...).governed` で測っていた。**
 * **`V8-M26-T03` が既定を閉じる側へ倒した結果、`governed` は表について**常に真**になった**
 * (`src/server/owner-scope.ts` の `roleRulesNameTarget` の doc が
 * 「`governed` はもう『宣言の実在』の答えではない」と自ら書いている)。
 * **したがって旧の素通しの条件は今日1度も成り立たない。**
 *
 * ## **`D-V8-33` / `U-3` —— 残る素通り1本**
 *
 * **`docs/plan/v8/05-authz-unification-baseline.md` §8 の 6 は「決まった時刻に動く処理が
 * 今日も素通しすることを、実測で示すこと」を完了条件として要求し、§9 の 1 は
 * 「書けるのは『時刻で動く処理を除く経路で効く』までであり、その1本を必ず併記する」と定める。**
 * **本ファイルの (e) / (e-2) がその実測である。**
 *
 * ## **この検査が測らないもの(誇張しない)**
 *
 * - **点(行ごとの付与)の経路を1件も通っていない** —— **測っているのは面だけである。**
 * - **AI(MCP)の経路は1件も通っていない**(素通りの2本目。`V8-M21` の申告)。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_ACTOR_ID, seedAutomationActor } from "./automation-actor-fixture.test.ts";
import { applyManifestDdl } from "./ddl.ts";
import { createRecord, listRecords } from "./records.ts";
import type { Manifest, Workflow } from "./types.ts";
import { runScheduledWorkflow } from "./workflow-runner.ts";

/** 履歴テーブルの5列(規約どおりの形)。 */
const HISTORY_FIELDS = [
  { id: "ran_at", name: "実行時刻", type: "date" as const },
  { id: "workflow", name: "ワークフロー", type: "text" as const },
  { id: "trigger_type", name: "きっかけ", type: "text" as const },
  { id: "status", name: "結果", type: "text" as const },
  { id: "error", name: "エラー", type: "long_text" as const },
];

/**
 * **題材。**
 *
 * - `orders` … きっかけの表。**`st_owner` を持つので、この表の行から書き手が決まる。**
 * - `notes` … 書込先。**規則を1本も書かない** —— **面は閉じている。**
 * - `wf-runs` … 履歴。
 *
 * **`roles` は3役割を宣言するが、規則は引数で受けた分しか書かない。**
 */
function baseManifest(
  rules: Record<string, unknown>[] = [],
  workflows: Workflow[] = [SCHEDULE_WORKFLOW],
): Manifest {
  return {
    app: {
      id: "writer-passthrough",
      name: "書き手の門",
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
          fields: [{ id: "body", name: "本文", type: "text" }],
        },
        { id: "wf-runs", name: "実行履歴", fields: HISTORY_FIELDS },
      ],
      views: [],
      roles: [
        { id: "owner", name: "持ち主", ...(rules.length > 0 ? { rules } : {}) },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
      workflows,
    },
  } as unknown as Manifest;
}

/** **時刻起動。行選択を持たないので、書き手はどこからも決まらない。** */
const SCHEDULE_WORKFLOW = {
  id: "wf-schedule",
  name: "毎朝メモを作る",
  trigger: { type: "schedule", at: { hour: 9, minute: 0 } },
  history_table: "wf-runs",
  actions: [{ action: "create_record", table: "notes", values: { body: "時刻起動から" } }],
} as unknown as Workflow;

/** **時刻起動(行選択つき)。** **書き手は行の `st_owner` から決まる。** */
const SCHEDULE_WITH_TABLE = {
  id: "wf-schedule-rows",
  name: "毎朝、注文ごとにメモを作る",
  trigger: { type: "schedule", at: { hour: 9, minute: 0 }, table: "orders" },
  history_table: "wf-runs",
  actions: [{ action: "create_record", table: "notes", values: { body: "行つき時刻起動から" } }],
} as unknown as Workflow;

/** **登録をきっかけに動く処理。** **書き手はきっかけの行の `st_owner` から決まる。** */
const ON_CREATE_WORKFLOW = {
  id: "wf-on-create",
  name: "注文が入ったらメモを作る",
  trigger: { type: "on_create", table: "orders" },
  history_table: "wf-runs",
  actions: [{ action: "create_record", table: "notes", values: { body: "$record.title" } }],
} as unknown as Workflow;

let dir: string;
let db: Database;

function boot(
  rules: Record<string, unknown>[] = [],
  workflows: Workflow[] = [SCHEDULE_WORKFLOW],
): Manifest {
  const manifest = baseManifest(rules, workflows);
  applyManifestDdl(db, manifest);
  // **書き手を1人立てる** —— **`_auth_users` に居ないと実効ロール集合が引けず、
  // 面から見て未ログインと同じ主体になる。**
  seedAutomationActor(db);
  return manifest;
}

function noteBodies(manifest: Manifest): string[] {
  const result = listRecords(db, manifest, "notes", {});
  return result.ok
    ? (result.value as unknown as { body: string }[]).map((row) => row.body)
    : ["<読めなかった>"];
}

/** 履歴に残った失敗の理由(**黙って止まっていないことを見る**)。 */
function historyErrors(manifest: Manifest): string[] {
  const result = listRecords(db, manifest, "wf-runs", {});
  return result.ok
    ? (result.value as unknown as { error: string | null }[])
        .map((row) => row.error ?? "")
        .filter((one) => one !== "")
    : [];
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gp-writer-passthrough-"));
  db = new Database(join(dir, "app.sqlite"), { create: true });
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (e) **時刻で動く処理は今日も素通りする**(`D-V8-33` / `U-3`)
// ---------------------------------------------------------------------------

test("(e) 時刻起動の発火は、書込先に規則が1本も無くても今日どおり書ける", () => {
  const manifest = boot();
  runScheduledWorkflow(db, manifest, SCHEDULE_WORKFLOW);
  expect(noteBodies(manifest)).toEqual(["時刻起動から"]);
  expect(historyErrors(manifest)).toEqual([]);
});

test("(e-2)【正直に書く】行選択つきの時刻起動も素通りする —— 書き手は決まるのに掛けていない", () => {
  // **登録をきっかけに動く処理は題材に入れない** —— **`orders` に行を1つ置くこと自体が
  // 面の判定を受けてしまい、測りたい線が混ざるからである。**
  const manifest = boot([], [SCHEDULE_WITH_TABLE]);
  const seeded = createRecord(db, manifest, "orders", {
    title: "朝の注文",
    st_owner: FIXTURE_ACTOR_ID,
  });
  expect(seeded.ok, JSON.stringify(seeded)).toBe(true);
  const rows = listRecords(db, manifest, "orders", {});
  expect(rows.ok).toBe(true);
  runScheduledWorkflow(db, manifest, SCHEDULE_WITH_TABLE, {
    records: rows.ok ? (rows.value as never) : ([] as never),
  });
  // **書き手は行の `st_owner` から決まるが、時刻起動なので面の判定を1度も受けない。**
  // **これが本軸の完了後に残る唯一の素通りである**(`D-V8-33` / `U-3`)。
  expect(noteBodies(manifest)).toEqual(["行つき時刻起動から"]);
  expect(historyErrors(manifest)).toEqual([]);
});

// ---------------------------------------------------------------------------
// (f) **書き手が特定できる発火は、今日どおり面に止められる**
//
// **`createRecord`(`src/kernel/records.ts`)は、その中で登録の発火を走らせる** ——
// **`runWorkflows` を手で呼ぶと2度走ってしまうので、呼ばない。**
// ---------------------------------------------------------------------------

test("(f) 登録をきっかけに動く処理は、書込先に規則が無ければ止まる(素通りさせない)", () => {
  const manifest = boot([], [ON_CREATE_WORKFLOW]);
  const created = createRecord(db, manifest, "orders", {
    title: "注文A",
    st_owner: FIXTURE_ACTOR_ID,
  });
  expect(created.ok).toBe(false);
  const message = created.ok ? "" : JSON.stringify(created.errors);
  expect(message).toContain("アクセス権");
  // **止めた層を名指ししている**(面 = `role`)。
  expect(message).toContain("role");
  expect(noteBodies(manifest)).toEqual([]);
});

test("(f-2) 同じ発火でも、書込先の規則が1本あれば今日どおり通る(閉じただけで塞いでいない)", () => {
  const manifest = boot(
    [{ target: "table", table: "notes", can: ["read", "write"] }],
    [ON_CREATE_WORKFLOW],
  );
  const created = createRecord(db, manifest, "orders", {
    title: "注文B",
    st_owner: FIXTURE_ACTOR_ID,
  });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  expect(noteBodies(manifest)).toEqual(["注文B"]);
});

test("(f-3) 書き手が特定できない登録の発火は、今日どおり通る(『規則が無いから』ではなく『書き手が居ないから』)", () => {
  const manifest = boot([], [ON_CREATE_WORKFLOW]);
  // **`st_owner` を書かないと、`resolveWorkflowActor` は空文字 = 書き手なしに倒れる。**
  const created = createRecord(db, manifest, "orders", { title: "持ち主のいない注文" });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  expect(noteBodies(manifest)).toEqual(["持ち主のいない注文"]);
});
