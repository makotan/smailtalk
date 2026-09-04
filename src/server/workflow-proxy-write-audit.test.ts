/**
 * 代理で書いた事実が `GET /auth/activity` から読める(`V4-M10-T10` 完了条件4。
 * **`ADR-0079` 限定8**)。**本物の HTTP で確かめる。**
 *
 * **着手前の実測(2026-08-03)**: `recordActivity` の非テストの呼び出しは
 * `src/server/app.ts` の2箇所と `src/server/inbound-route.ts` の1箇所だけで、
 * **`src/kernel/workflow-runner.ts` からは1度も呼ばれていなかった** ——
 * **ワークフロー / 島の書込は監査に1行も残らなかった**(`V4-M10-T10` 完了条件1)。
 *
 * ## この検査が言わないこと(誇張しない)
 *
 * - **残るのは「どの自動処理が / 誰の行として / どのテーブルの / どの行を」までである。**
 *   **「何を書いたか」は残らない**(`ActivityRecord.changes` は更新以外 `null`。`ADR-0079` §限界4)。
 * - **残るのは島の `write_ops` 経路だけである。** **ワークフローの `create_record` /
 *   `update_record` アクションは actor を持たない経路であり、今日も監査に1行も残らない。**
 *   **`ADR-0079` 限定8 が求めたのは「代理で書いた事実」であって、すべてのワークフロー書込ではない。**
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyManifest,
  createApp,
  createRecord,
  ensureIslandRuntimeReady,
  KernelMetaStore,
  type Manifest,
} from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "proxy-audit-app";

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "代理書込の監査",
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
      views: [{ id: "ledger-list", type: "list_view", table: "point_ledger", columns: ["points"] }],
      functions: [
        {
          id: "grant",
          name: "ポイントを積む",
          code: 'export default function () { return [{ op: "create", table: "point_ledger", values: { points: 10 } }]; }',
          input: { source: "record" },
          output: { ops: true },
        },
      ],
      workflows: [
        {
          id: "grant-points",
          name: "決済イベントからポイントを積む",
          trigger: { type: "on_create", table: "payment_event" },
          history_table: "wf_history",
          act_as: "$record.order",
          actions: [{ action: "run_function", function: "grant", write_ops: true }],
        },
      ],
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  await ensureIslandRuntimeReady();
  dataRoot = await mkdtemp(join(tmpdir(), "gp-proxy-audit-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "代理書込の監査", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **【`V8-M26`】題材に既定3役割の規則を足す** —— **島の `write_ops` は `act_as` の人の
  // 実効役割で判定される。規則が1本も無いと `point_ledger` への書込が閉じる。**
  expect(applyManifest(dataRoot, APP_ID, withDefaultRoleRules(manifest())).valid).toBe(true);
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

test("T10 完了条件4: 代理で書いた事実が GET /auth/activity から読める(本物の HTTP)", async () => {
  // owner セッションを1本作る(`GET /auth/activity` は owner 限定)。
  const admin = seedSession(dataRoot, APP_ID, { role: "owner", username: "admin" });

  // 発火はカーネル経路で起こす(= ワークフロー / 島が通る経路。actor を持たない)。
  const db = new Database(join(dataRoot, "apps", APP_ID, "app.sqlite"));
  let ledgerId: string;
  try {
    // **【`V8-M26`】発火に渡す題材も、適用したものと同じ(規則付きの)形にする。**
    const m = withDefaultRoleRules(manifest());
    const order = createRecord(db, m, "orders", { item: "本", st_owner: admin.userId });
    expect(order.ok).toBe(true);
    if (!order.ok) throw new Error("order create failed");
    const event = createRecord(db, m, "payment_event", {
      amount: 100,
      order: order.value._id as string,
    });
    expect(event.ok).toBe(true);
    const ledger = db.query<{ _id: string }, []>('SELECT "_id" FROM "point_ledger"').all();
    expect(ledger).toHaveLength(1);
    ledgerId = ledger[0]?._id as string;
  } finally {
    db.close();
  }

  const res = await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/auth/activity`, {
      headers: { cookie: admin.cookie, origin: TEST_ORIGIN },
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    activity: {
      userId: string;
      username: string;
      action: string;
      tableId: string;
      recordId: string | null;
      changes: unknown;
    }[];
    total: number;
  };
  expect(body.total).toBe(1);
  const row = body.activity[0];
  // **誰の行として / どの自動処理が / どのテーブルの / どの行を。**
  expect(row?.userId).toBe(admin.userId);
  expect(row?.username).toBe("workflow:grant-points");
  expect(row?.action).toBe("create_record");
  expect(row?.tableId).toBe("point_ledger");
  expect(row?.recordId).toBe(ledgerId);
  // **「何を書いたか」は残らない**(`ADR-0079` §限界4)。
  expect(row?.changes).toBeNull();
});
