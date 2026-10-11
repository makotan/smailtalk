/**
 * **MCP の3道具の起点の操作者(`$actor`)**(`V23-M4-T03`。`D-V23-93`・`D-V23-102`。
 * 門A `ADR-0500` 限定16 / `ADR-0524` §Decision 1-1 と限定16)。
 *
 * `insert_sample_data`・`update_record`・`write_records` が起こした自動処理の `values` の
 * `$actor.id` / `$actor.login` / `$actor.role` は、`ST_MCP_ACTOR` で名乗った利用者の
 * id・ログイン名・アカウントの役割(`_auth_users.role`)になる。 道具が起点を渡し忘れると
 * 3つとも空文字になって赤くなる。 送信内容に操作者風の値を入れても入らない。
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
import { type SeededSession, seedSession, withDefaultRoleRules } from "../server/test-helpers.ts";
import { createMcpServer } from "./server.ts";

const APP_ID = "mcp-actor-entry";

function actorValues(src: string): Record<string, string> {
  return {
    src,
    item: "$record._id",
    aid: "$actor.id",
    alogin: "$actor.login",
    arole: "$actor.role",
  };
}

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "MCP の操作者",
      tables: [
        {
          id: "items",
          name: "品",
          fields: [
            { id: "title", name: "件名", type: "text" },
            { id: "memo", name: "メモ", type: "text" },
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
          id: "wf_create",
          name: "作成を記録する",
          trigger: { type: "on_create", table: "items" },
          history_table: "wf_log",
          actions: [{ action: "create_record", table: "actor_log", values: actorValues("create") }],
        },
        {
          id: "wf_update",
          name: "更新を記録する",
          trigger: { type: "on_update", table: "items" },
          history_table: "wf_log",
          actions: [{ action: "create_record", table: "actor_log", values: actorValues("update") }],
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
  const dataRoot = await mkdtemp(join(tmpdir(), "gp-mcp-actor-entry-"));
  dataRoots.push(dataRoot);
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, "MCP の操作者", { app_id: APP_ID });
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
  const client = new Client({ name: "t03", version: "0.0.0" });
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

function mustOk(result: CallToolResult): Record<string, unknown> {
  if (result.isError === true) {
    throw new Error(
      `道具が失敗した: ${JSON.stringify(result.structuredContent ?? result.content)}`,
    );
  }
  return result.structuredContent as Record<string, unknown>;
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
  return rowsOf(rig, "actor_log").filter((row) => row.src === src);
}

function actorOf(row: Record<string, unknown> | undefined): Record<string, unknown> {
  return { id: row?.aid, login: row?.alogin, role: row?.arole };
}

function expectedActor(who: SeededSession): Record<string, unknown> {
  return { id: who.userId, login: who.username, role: who.role };
}

describe("V23-M4-T03 MCP の3道具は、名乗った利用者を運ぶ", () => {
  test("(mcp-insert) insert_sample_data の作成は、名乗った人の id・ログイン名・アカウントの役割を書く", async () => {
    const rig = await makeRig();
    mustOk(
      await call(rig, "alice", "insert_sample_data", {
        table_id: "items",
        rows: [{ title: "一" }, { title: "$actor.id", memo: rig.bob.userId }],
      }),
    );
    const logs = logsOf(rig, "create");
    expect(logs).toHaveLength(2);
    for (const log of logs) {
      expect(actorOf(log)).toEqual(expectedActor(rig.alice));
    }
    expect(rig.alice.role).toBe("editor");
  });

  test("(mcp-insert-by-id) 名乗りを id で書いても、ログイン名と役割は利用者の表から入る", async () => {
    const rig = await makeRig();
    mustOk(
      await call(rig, rig.bob.userId, "insert_sample_data", {
        table_id: "items",
        rows: [{ title: "一" }],
      }),
    );
    const logs = logsOf(rig, "create");
    expect(logs).toHaveLength(1);
    expect(actorOf(logs[0])).toEqual(expectedActor(rig.bob));
  });

  test("(mcp-update) update_record の更新は、名乗った人を書く(作った人ではない)", async () => {
    const rig = await makeRig();
    mustOk(
      await call(rig, "alice", "insert_sample_data", {
        table_id: "items",
        rows: [{ title: "一" }],
      }),
    );
    const item = rowsOf(rig, "items")[0] as Record<string, unknown>;
    mustOk(
      await call(rig, "bob", "update_record", {
        table_id: "items",
        record_id: item._id,
        changes: { memo: "直した" },
        if_match: item._updated_at,
      }),
    );
    const logs = logsOf(rig, "update");
    expect(logs).toHaveLength(1);
    expect(actorOf(logs[0])).toEqual(expectedActor(rig.bob));
  });

  test("(mcp-write-records) write_records の作成・更新は、名乗った人を書く", async () => {
    const rig = await makeRig();
    mustOk(
      await call(rig, "alice", "insert_sample_data", {
        table_id: "items",
        rows: [{ title: "一" }],
      }),
    );
    const item = rowsOf(rig, "items")[0] as Record<string, unknown>;
    mustOk(
      await call(rig, "bob", "write_records", {
        ops: [
          { op: "create", table: "items", values: { title: "二" } },
          {
            op: "update",
            table: "items",
            target: item._id,
            values: { memo: "一括" },
            if_match: item._updated_at,
          },
        ],
      }),
    );
    const created = logsOf(rig, "create");
    expect(created).toHaveLength(2);
    expect(actorOf(created[1])).toEqual(expectedActor(rig.bob));
    const updated = logsOf(rig, "update");
    expect(updated).toHaveLength(1);
    expect(actorOf(updated[0])).toEqual(expectedActor(rig.bob));
  });
});
