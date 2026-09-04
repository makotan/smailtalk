/**
 * `V5-M25-T04`(`L-G11a` / [`ADR-0175`](../../docs/adr/0175-manual-trigger-idempotency-and-actor.md)
 * 限定7 / 限定8)—— **手動で起こした自動処理が「誰として書くか」**の検査。
 *
 * ## 規則は1本だけである
 *
 * **`act_as` の宣言があればそれが勝ち、無ければ押した人。** **3つ目の規則(条件つきで
 * 押した人が勝つ等)を1つも作っていない**(限定7)。
 *
 * ## **【禁止】「押した人が記録に残るようになった」と、変更履歴について書かない**
 *
 * **`_workflow_history` は今日も5列である**(`ADR-0072` 限定3 / `ADR-0174` 限定10 /
 * `ADR-0175` 限定5)。**`L-G11b` は保留のままである。**
 * **押した人が残るのは既存の監査記録(`_auth_activity`)の側だけであり**(ユーザ決定
 * `D-V5-83`)、**それを測るのは `src/server/manual-trigger-route.test.ts` の (E) 群である。**
 *
 * ## この検査が言えないこと
 *
 * - **押した人と `act_as` が違うことが利用者に見えるかを1件も測っていない**
 *   (`ADR-0175` §限界5: 本 ADR は表示を1つも作っていない)。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armManifestForAutomation,
  fixtureOwnerValues,
  seedAutomationActor,
} from "./automation-actor-fixture.test.ts";
import { applyManifest as applyManifestRaw, createApp, KernelMetaStore } from "./index.ts";
import { ensureIslandRuntimeReady } from "./island-runner.ts";
import type { RecordRow } from "./records.ts";
import { createRecord as createRecordRaw, listRecords } from "./records.ts";
import { appDbPath } from "./storage-paths.ts";
import type { Manifest, Workflow } from "./types.ts";
import { runManualWorkflow, runWorkflows, WORKFLOW_HISTORY_COLUMNS } from "./workflow-runner.ts";

/*
 * --- **【`V8-M26`(2026-08-10)で題材に「壁を開ける下ごしらえ」が入った】** -------------
 *
 * **`V8-M26-T03` が面(役割に束ねた権限)の既定を「閉じる」側へ倒したので、
 * ワークフロー・島の書込が題材ごと止まった。** **本ファイルの主題は面ではないので、
 * 題材の側で壁を開ける** —— **実装は1バイトも緩めていない。**
 * **中身は `src/kernel/automation-actor-fixture.test.ts` の doc に全部書いた。**
 */

/** マニフェストを投入する直前に壁を開け、投入した直後に書き手を1人立てる。 */
function applyManifest(
  root: string,
  appId: string,
  target: Manifest,
): ReturnType<typeof applyManifestRaw> {
  armManifestForAutomation(target);
  const applied = applyManifestRaw(root, appId, target);
  if (applied.valid) {
    const database = new Database(appDbPath(root, appId), { readwrite: true, create: false });
    try {
      seedAutomationActor(database);
    } finally {
      database.close();
    }
  }
  return applied;
}

/**
 * 行を作る(**下ごしらえが持ち主の列を足した表にだけ書き手を入れる**)。
 *
 * **題材が明示した持ち主(`row-owner` など)は、その場で `owner` として登録する** ——
 * **登録しないと面から見て未ログインと同じ主体になり、この題材のどのテーブルにも書けない。**
 */
function createRecord(
  database: Database,
  target: Manifest,
  tableId: string,
  values: Record<string, unknown>,
): ReturnType<typeof createRecordRaw> {
  const declared = values.st_owner;
  if (typeof declared === "string" && declared !== "") {
    seedAutomationActor(database, declared);
  }
  return createRecordRaw(database, target, tableId, fixtureOwnerValues(target, tableId, values));
}

const APP_ID = "manual-actor";
/** 押した人(この人の権限で・この人の行として書かれるか)。 */
const PRESSER = "presser-1";

function manifest(actAs?: string): Manifest {
  const manual: Record<string, unknown> = {
    id: "grant-manual",
    name: "手動でポイントを積む",
    trigger: { type: "manual", table: "payment_event" },
    history_table: "wf_history",
    actions: [{ action: "run_function", function: "grant", write_ops: true }],
  };
  if (actAs !== undefined) {
    manual.act_as = actAs;
  }
  return {
    app: {
      id: APP_ID,
      name: "手動起動の実行者",
      tables: [
        {
          id: "orders",
          name: "注文",
          fields: [
            { id: "item", name: "品目", type: "text" },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
        {
          id: "payment_event",
          name: "決済イベント",
          fields: [
            { id: "amount", name: "金額", type: "number" },
            { id: "order", name: "注文", type: "reference", reference_table: "orders" },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
        {
          id: "point_ledger",
          name: "ポイント台帳",
          fields: [
            { id: "points", name: "点数", type: "number" },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
        {
          id: "wf_history",
          name: "実行履歴",
          fields: [
            { id: "ran_at", name: "実行時刻", type: "date" },
            { id: "workflow", name: "ワークフロー", type: "text" },
            { id: "trigger_type", name: "起点", type: "text" },
            { id: "status", name: "結果", type: "text" },
            { id: "error", name: "詳細", type: "long_text" },
          ],
        },
      ],
      views: [
        {
          id: "event-list",
          type: "list_view",
          table: "payment_event",
          columns: ["amount"],
          actions: [{ run: "grant-manual", name: "積む" }],
        },
      ],
      functions: [
        {
          id: "grant",
          name: "ポイントを積む",
          // **島は actor を1文字も選べない**(`ADR-0079` 限定10)。
          code: 'export default function () { return [{ op: "create", table: "point_ledger", values: { points: 10, st_owner: "someone-else" } }]; }',
          input: { source: "record" },
          output: { ops: true },
        },
      ],
      workflows: [
        manual as never,
        {
          id: "grant-auto",
          name: "自動でポイントを積む",
          trigger: { type: "on_create", table: "payment_event" },
          history_table: "wf_history",
          actions: [{ action: "run_function", function: "grant", write_ops: true }],
        } as never,
      ],
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let db: Database;

beforeEach(async () => {
  await ensureIslandRuntimeReady();
  dataRoot = await mkdtemp(join(tmpdir(), "gp-manual-actor-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "手動起動の実行者", { app_id: APP_ID });
  } finally {
    store.close();
  }
});

afterEach(async () => {
  db?.close();
  await rm(dataRoot, { recursive: true, force: true });
});

function setup(actAs?: string): Manifest {
  const m = manifest(actAs);
  expect(applyManifest(dataRoot, APP_ID, m).valid).toBe(true);
  db = new Database(join(dataRoot, "apps", APP_ID, "app.sqlite"));
  // **【`V8-M26`(2026-08-10)】押した人を `owner` として登録する。**
  // **登録しないと、面から見て未ログインと同じ主体になり、`point_ledger` へ1行も書けない**
  // (`anonymous` には書込の規則を1本も書けないので、規則をどう配っても通らない)。
  // **「誰の行として書かれるか」を測る本ファイルの主題は1ミリも変わらない。**
  seedAutomationActor(db, PRESSER);
  return m;
}

function ledgerOwners(m: Manifest): unknown[] {
  const result = listRecords(db, m, "point_ledger", {});
  expect(result.ok).toBe(true);
  return result.ok
    ? (result.value as unknown as Record<string, unknown>[]).map((r) => r.st_owner)
    : [];
}

function historyDetail(m: Manifest): string {
  const result = listRecords(db, m, "wf_history", {});
  const rows = result.ok ? (result.value as unknown as Record<string, unknown>[]) : [];
  return rows.map((row) => `${String(row.status)}:${String(row.error)}`).join(" | ");
}

/** トリガー元の行を1件作る(**発火させずに**)。 */
function seedEvent(m: Manifest, values: Record<string, unknown>): RecordRow {
  const saved = m.app.workflows ?? [];
  m.app.workflows = [];
  const created = createRecord(db, m, "payment_event", values);
  m.app.workflows = saved;
  expect(created.ok).toBe(true);
  if (!created.ok) {
    throw new Error("seed failed");
  }
  return created.value;
}

function manualWorkflow(m: Manifest): Workflow {
  return (m.app.workflows ?? []).find((w) => w.id === "grant-manual") as Workflow;
}

// ---------------------------------------------------------------------------
// (a) 宣言が無ければ「押した人」として書く(ADR-0175 §6-3)
// ---------------------------------------------------------------------------

test("(a) act_as が無ければ、押した人の行として書かれる(トリガー元の持ち主ではない)", () => {
  const m = setup();
  const event = seedEvent(m, { amount: 100, st_owner: "someone-with-the-row" });
  const failures = runManualWorkflow(db, m, manualWorkflow(m), event, PRESSER);
  expect(failures, historyDetail(m)).toEqual([]);
  // **押した人の行になる。** **トリガー元の `st_owner`("someone-with-the-row")ではない。**
  expect(ledgerOwners(m)).toEqual([PRESSER]);
});

test("(a) 島が返した st_owner は今日どおり無視される(ADR-0079 限定10 を1バイトも解いていない)", () => {
  const m = setup();
  const event = seedEvent(m, { amount: 100, st_owner: "someone-with-the-row" });
  runManualWorkflow(db, m, manualWorkflow(m), event, PRESSER);
  expect(ledgerOwners(m)).not.toContain("someone-else");
});

// ---------------------------------------------------------------------------
// (b) 宣言があればそれが勝つ(限定7。規則は1本だけ)
// ---------------------------------------------------------------------------

test("(b) act_as の宣言があれば、押した人ではなくその参照先の持ち主として書かれる", () => {
  const m = setup("$record.order");
  const order = createRecord(db, m, "orders", { item: "本", st_owner: "order-owner" });
  expect(order.ok).toBe(true);
  if (!order.ok) return;
  const event = seedEvent(m, {
    amount: 100,
    order: order.value._id as string,
    st_owner: "someone-with-the-row",
  });
  const failures = runManualWorkflow(db, m, manualWorkflow(m), event, PRESSER);
  expect(failures, historyDetail(m)).toEqual([]);
  // **`act_as` が勝つ。** **押した人の権限を無視する**(`ADR-0175` §Context 4 の 4 が
  // 不利な材料として挙げている性質そのものである)。
  expect(ledgerOwners(m)).toEqual(["order-owner"]);
});

test("(b) act_as が辿れないときは今日どおり fail-closed(押した人へ倒れない)", () => {
  const m = setup("$record.order");
  // 参照が空のまま起こす。**「辿れないなら押した人」という3つ目の規則を作っていない。**
  const event = seedEvent(m, { amount: 100, st_owner: "someone-with-the-row" });
  const failures = runManualWorkflow(db, m, manualWorkflow(m), event, PRESSER);
  expect(failures.length).toBeGreaterThan(0);
  expect(ledgerOwners(m)).toEqual([]);
});

// ---------------------------------------------------------------------------
// (c) 既存3種に1バイトも触っていない(限定4)
// ---------------------------------------------------------------------------

test("(c) on_create 経路の実行者は今日どおりトリガー元の持ち主である", () => {
  const m = setup();
  const event = seedEvent(m, { amount: 100, st_owner: "row-owner" });
  const failures = runWorkflows(db, m, "payment_event", "on_create", event);
  expect(failures, historyDetail(m)).toEqual([]);
  // **押した人という概念が無いので、今日どおりトリガー元の `st_owner` である。**
  expect(ledgerOwners(m)).toEqual(["row-owner"]);
});

// ---------------------------------------------------------------------------
// (d) 分岐は2本のまま / 履歴の列は5本のまま(限定7 / 限定5)
// ---------------------------------------------------------------------------

test("(d) resolveWorkflowActor の分岐は2本のままである(3つ目の規則を作っていない)", () => {
  const source = readFileSync(join(import.meta.dir, "workflow-runner.ts"), "utf-8");
  const start = source.indexOf("function resolveWorkflowActor(");
  expect(start).toBeGreaterThan(0);
  const withComments = source.slice(start, source.indexOf("\n}\n", start));
  // **コメントを取り除いてから見る** —— **doc に書いた説明文が「実装が見ている」と
  // 誤判定されないようにするためである**(`v5-merge-repair-2.md` §5 の測り方に倣う)。
  const body = withComments.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  // **`act_as` の宣言を見るのは1箇所だけである。**
  expect(body.split("workflow.act_as").length - 1).toBe(1);
  // **`trigger.type` を1度も見ていない** —— **「手動のときだけ別の規則」を作っていない。**
  expect(body).not.toContain("trigger.type");
  // **押した人は「宣言が無いときの既定」に入るだけである**(2本目の分岐の中)。
  expect(body).toContain("manualActor");
});

test("(d) _workflow_history の列は5本のままである(L-G11b = 保留)", () => {
  expect(WORKFLOW_HISTORY_COLUMNS).toHaveLength(5);
  expect([...WORKFLOW_HISTORY_COLUMNS]).not.toContain("actor");
});
