/**
 * **MCP の更新の2道具での更新前の値と `changed_fields`**(`V23-M4-T04`。`D-V23-96`。
 * 門A `ADR-0500` 限定18 / `ADR-0524` 限定15)。
 *
 * `update_record`・`write_records` の更新が起こした `on_update` の `$previous.x` は更新前の値で、
 * `changed_fields` の項目が変わらない更新では発火しない(履歴の行も無い)。 HTTP の入口は
 * `previous-changed-now.test.ts`。
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  appDbPath,
  applyManifest,
  createApp,
  KernelMetaStore,
  type Manifest,
} from "../kernel/index.ts";
import { createMcpServer } from "../mcp/server.ts";
import { type SeededSession, seedSession, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "mcp-previous-changed";

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "MCP の更新前",
      tables: [
        {
          id: "assessments",
          name: "評価",
          fields: [
            { id: "verdict", name: "判定", type: "text" },
            { id: "memo", name: "メモ", type: "text" },
          ],
        },
        {
          id: "assessment_log",
          name: "評価の履歴",
          fields: [
            { id: "src", name: "出どころ", type: "text" },
            { id: "actor", name: "操作者", type: "text" },
            { id: "before", name: "更新前", type: "text" },
            { id: "after", name: "更新後", type: "text" },
          ],
        },
        {
          id: "wf_log",
          name: "実行履歴",
          fields: [
            { id: "ran_at", name: "実行時刻", type: "date" },
            { id: "workflow", name: "ワークフロー", type: "text" },
            { id: "trigger_type", name: "きっかけ", type: "text" },
            { id: "status", name: "結果", type: "text" },
            { id: "error", name: "エラー", type: "long_text" },
          ],
        },
      ],
      views: [],
      workflows: [
        {
          id: "wf_hist",
          name: "判定の履歴",
          trigger: { type: "on_update", table: "assessments", changed_fields: ["verdict"] },
          history_table: "wf_log",
          actions: [
            {
              action: "create_record",
              table: "assessment_log",
              values: {
                src: "hist",
                actor: "$actor.id",
                before: "$previous.verdict",
                after: "$record.verdict",
              },
            },
          ],
        },
        {
          id: "wf_every",
          name: "毎回の履歴",
          trigger: { type: "on_update", table: "assessments" },
          history_table: "wf_log",
          actions: [
            {
              action: "create_record",
              table: "assessment_log",
              values: { src: "every", before: "$previous.memo", after: "$record.memo" },
            },
          ],
        },
      ],
    },
  } as unknown as Manifest;
}

type Rig = { dataRoot: string; alice: SeededSession; bob: SeededSession };

const dataRoots: string[] = [];

afterEach(async () => {
  for (const dir of dataRoots.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeRig(): Promise<Rig> {
  const dataRoot = await mkdtemp(join(tmpdir(), "gp-mcp-previous-changed-"));
  dataRoots.push(dataRoot);
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, "MCP の更新前", { app_id: APP_ID });
  } finally {
    meta.close();
  }
  const applied = applyManifest(dataRoot, APP_ID, withDefaultRoleRules(manifest()));
  if (!applied.valid) {
    throw new Error(JSON.stringify(applied.errors));
  }
  seedSession(dataRoot, APP_ID, { role: "owner", username: "boss" });
  return {
    dataRoot,
    alice: seedSession(dataRoot, APP_ID, { role: "editor", username: "alice" }),
    bob: seedSession(dataRoot, APP_ID, { role: "editor", username: "bob" }),
  };
}

async function call(
  rig: Rig,
  actor: string,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const server = createMcpServer({
    dataRoot: rig.dataRoot,
    previewBaseUrl: "http://localhost:3000",
    actor,
  });
  const client = new Client({ name: "t04", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  try {
    return JSON.parse(
      JSON.stringify(await client.callTool({ name, arguments: { app_id: APP_ID, ...args } })),
    ) as CallToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

function mustOk(result: CallToolResult): void {
  if (result.isError === true) {
    throw new Error(
      `道具が失敗した: ${JSON.stringify(result.structuredContent ?? result.content)}`,
    );
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

function historyOf(rig: Rig, workflow: string): Record<string, unknown>[] {
  return rowsOf(rig, "wf_log").filter((row) => row.workflow === workflow);
}

async function seed(rig: Rig): Promise<Record<string, unknown>> {
  mustOk(
    await call(rig, "alice", "insert_sample_data", {
      table_id: "assessments",
      rows: [{ verdict: "保留", memo: "m0" }],
    }),
  );
  return rowsOf(rig, "assessments")[0] as Record<string, unknown>;
}

describe("V23-M4-T04 MCP の更新の道具でも $previous は更新前の値", () => {
  test("(mcp-update) update_record の更新の $previous は更新前の値", async () => {
    const rig = await makeRig();
    const item = await seed(rig);
    mustOk(
      await call(rig, "bob", "update_record", {
        table_id: "assessments",
        record_id: item._id,
        changes: { verdict: "承認", memo: "m1" },
        if_match: item._updated_at,
      }),
    );
    const logs = logsOf(rig, "hist");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actor: rig.bob.userId, before: "保留", after: "承認" });
    expect(logsOf(rig, "every")[0]).toMatchObject({ before: "m0", after: "m1" });
  });

  test("(mcp-write-records) write_records の更新の $previous は更新前の値", async () => {
    const rig = await makeRig();
    const item = await seed(rig);
    mustOk(
      await call(rig, "bob", "write_records", {
        ops: [
          {
            op: "update",
            table: "assessments",
            target: item._id,
            values: { verdict: "却下" },
            if_match: item._updated_at,
          },
        ],
      }),
    );
    const logs = logsOf(rig, "hist");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actor: rig.bob.userId, before: "保留", after: "却下" });
  });
});

describe("V23-M4-T04 MCP の更新の道具でも changed_fields が効く", () => {
  test("(mcp-unchanged) 判定を同じ値で送る更新では発火せず、履歴の行も無い。 書かないワークフローは発火する", async () => {
    const rig = await makeRig();
    const item = await seed(rig);
    mustOk(
      await call(rig, "bob", "update_record", {
        table_id: "assessments",
        record_id: item._id,
        changes: { verdict: "保留", memo: "m1" },
        if_match: item._updated_at,
      }),
    );
    expect(logsOf(rig, "hist")).toHaveLength(0);
    expect(historyOf(rig, "wf_hist")).toHaveLength(0);
    expect(historyOf(rig, "wf_every")).toHaveLength(1);
    const again = rowsOf(rig, "assessments")[0] as Record<string, unknown>;
    mustOk(
      await call(rig, "bob", "write_records", {
        ops: [
          {
            op: "update",
            table: "assessments",
            target: again._id,
            values: { verdict: "保留" },
            if_match: again._updated_at,
          },
        ],
      }),
    );
    expect(historyOf(rig, "wf_hist")).toHaveLength(0);
    expect(historyOf(rig, "wf_every")).toHaveLength(2);
  });
});
