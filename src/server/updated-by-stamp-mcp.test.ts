/**
 * **MCP の3道具の `st_updated_by`**(`V23-M4-T05`。`D-V23-98`・`D-V23-105`。門A `ADR-0524` 限定19・20)。
 *
 * `insert_sample_data`・`update_record`・`write_records` の作成・更新は、`ST_MCP_ACTOR` で名乗った
 * 利用者の id を押す。 送信内容の `st_updated_by` は捨てる。 MCP の読取(`list_records`)は
 * `st_owner` と同じく表示名に差し替えない(差し替えるのは今日 `st_owner` を差し替えている
 * HTTP の一覧・単件だけ)。
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

const APP_ID = "mcp-updated-by";
const UB = "st_updated_by";
const FORGED = "偽の更新者";

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "MCP の更新者",
      tables: [
        {
          id: "notes",
          name: "メモ",
          fields: [
            { id: "title", name: "件名", type: "text" },
            { id: "memo", name: "本文", type: "text" },
            { id: UB, name: "更新者", type: "text" },
          ],
        },
      ],
      views: [],
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
  const dataRoot = await mkdtemp(join(tmpdir(), "gp-mcp-updated-by-"));
  dataRoots.push(dataRoot);
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, "MCP の更新者", { app_id: APP_ID });
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
  const client = new Client({ name: "t05", version: "0.0.0" });
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

function rowsOf(rig: Rig): Record<string, unknown>[] {
  const db = new Database(appDbPath(rig.dataRoot, APP_ID), { readonly: true });
  try {
    return db.query<Record<string, unknown>, []>(`SELECT * FROM "notes" ORDER BY rowid`).all();
  } finally {
    db.close();
  }
}

describe("V23-M4-T05 MCP の3道具は、名乗った利用者を押す", () => {
  test("(mcp-insert) insert_sample_data の作成は名乗った人を押し、送った値は捨てる", async () => {
    const rig = await makeRig();
    mustOk(
      await call(rig, "alice", "insert_sample_data", {
        table_id: "notes",
        rows: [{ title: "一" }, { title: "二", [UB]: rig.bob.userId }],
      }),
    );
    const rows = rowsOf(rig);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row[UB]).toBe(rig.alice.userId);
    }
  });

  test("(mcp-update) update_record の更新は名乗った人を押し、送った値は捨てる", async () => {
    const rig = await makeRig();
    mustOk(
      await call(rig, "alice", "insert_sample_data", {
        table_id: "notes",
        rows: [{ title: "一" }],
      }),
    );
    const row = rowsOf(rig)[0] as Record<string, unknown>;
    mustOk(
      await call(rig, "bob", "update_record", {
        table_id: "notes",
        record_id: row._id,
        changes: { memo: "直した", [UB]: FORGED },
        if_match: row._updated_at,
      }),
    );
    expect(rowsOf(rig)[0]?.[UB]).toBe(rig.bob.userId);
  });

  test("(mcp-write-records) write_records の作成・更新は名乗った人を押す", async () => {
    const rig = await makeRig();
    mustOk(
      await call(rig, "alice", "insert_sample_data", {
        table_id: "notes",
        rows: [{ title: "一" }],
      }),
    );
    const row = rowsOf(rig)[0] as Record<string, unknown>;
    mustOk(
      await call(rig, "bob", "write_records", {
        ops: [
          { op: "create", table: "notes", values: { title: "二", [UB]: rig.alice.userId } },
          {
            op: "update",
            table: "notes",
            target: row._id,
            values: { memo: "一括", [UB]: FORGED },
            if_match: row._updated_at,
          },
        ],
      }),
    );
    const rows = rowsOf(rig);
    expect(rows).toHaveLength(2);
    for (const each of rows) {
      expect(each[UB]).toBe(rig.bob.userId);
    }
  });

  test("(mcp-list) MCP の読取は st_owner と同じく表示名に差し替えない(ID のまま)", async () => {
    const rig = await makeRig();
    mustOk(
      await call(rig, "alice", "insert_sample_data", {
        table_id: "notes",
        rows: [{ title: "一" }],
      }),
    );
    const listed = mustOk(await call(rig, "bob", "list_records", { table_id: "notes" }));
    const records = listed.records as Record<string, unknown>[];
    expect(records).toHaveLength(1);
    expect(records[0]?.[UB]).toBe(rig.alice.userId);
  });
});
