/**
 * EC-G8 一意制約(ADR-0038)が **MCP / HTTP 両経路**で効くことの統合テスト。
 *
 * unique の書込時検査はカーネルの `records.ts`(`createRecord` / `updateRecord`)—— **唯一の
 * 書込関門**——に置いてある。MCP(`insert_sample_data` / `update_record`)も HTTP
 * (`POST/PATCH .../records`)もこの関門を通るので、経路で振る舞いが割れない(ADR-0003 §7)。
 * 本テストは両入口から重複書込が拒否されることを実測で固定する(計画 §1 T03 検証観点)。
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  applyDiff,
  createApp,
  type Diff,
  KernelMetaStore,
  type RecordRow,
} from "../../kernel/index.ts";
import { createServerApp } from "../../server/app.ts";
import { seedSession, TEST_ORIGIN } from "../../server/test-helpers.ts";
import { createMcpServer } from "../server.ts";

const APP_ID = "members-app";
const TABLE_ID = "members";

/**
 * **【`V8-M31` 第3波】MCP の名乗り。** `V8-M31` で MCP は「誰として動くか」を要求するように
 * なったので、`createMcpServer` に `actor` を渡し、このアプリに同名の利用者を1人作る。
 * 本テストが測るのは一意制約であって権限ではないので、`seedSession` の既定(`owner`)でよい。
 */
const ACTOR = "mcp-actor";

/** email に unique を付けたテーブルと一覧画面を足す差分。 */
const setupDiff: Diff = {
  diff_id: "setup",
  intent: "会員テーブル(メール一意)を用意する",
  operations: [
    {
      op: "add_table",
      table: {
        id: TABLE_ID,
        name: "会員",
        fields: [
          { id: "email", name: "メール", type: "text", unique: true },
          { id: "name", name: "氏名", type: "text", required: true },
        ],
      },
    },
    {
      op: "add_view",
      view: { id: "members-list", type: "list_view", table: TABLE_ID, columns: ["email", "name"] },
    },
  ],
};

let dataRoot = "";

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-unique-dual-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "会員管理", { app_id: APP_ID });
  } finally {
    store.close();
  }
  const applied = applyDiff(dataRoot, APP_ID, setupDiff);
  if (!applied.valid) {
    throw new Error(`テスト前提の差分適用に失敗: ${JSON.stringify(applied.errors)}`);
  }
  seedSession(dataRoot, APP_ID, { username: ACTOR });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

// --- MCP 経路 -------------------------------------------------------------------

async function callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const server = createMcpServer({
    dataRoot,
    previewBaseUrl: "http://127.0.0.1:3000",
    actor: ACTOR,
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

test("MCP: insert_sample_data は重複する unique 値を弾き、重複行を作らない", async () => {
  const result = await callTool("insert_sample_data", {
    app_id: APP_ID,
    table_id: TABLE_ID,
    rows: [
      { email: "dup@example.com", name: "A" },
      { email: "dup@example.com", name: "B" },
    ],
  });
  // 部分成功: 1行目は入り、2行目(重複)は failed に落ちる(isError:false の規約)。
  expect(result.isError).toBeFalsy();
  const data = result.structuredContent as {
    inserted: RecordRow[];
    failed: { index: number; errors: { path: string; message: string }[] }[];
  };
  expect(data.inserted).toHaveLength(1);
  expect(data.failed).toHaveLength(1);
  expect(data.failed[0]?.index).toBe(1);
  expect(data.failed[0]?.errors[0]?.path).toBe("/email");
  expect(data.failed[0]?.errors[0]?.message).toContain("一意");

  // 実データは1件だけ(重複は書かれていない)。
  const list = await callTool("list_records", { app_id: APP_ID, table_id: TABLE_ID });
  const records = (list.structuredContent as { records: RecordRow[] }).records;
  expect(records).toHaveLength(1);
});

// --- HTTP 経路 ------------------------------------------------------------------

test("HTTP: POST .../records は重複する unique 値を 400 で拒否する", async () => {
  const app = createServerApp({ dataRoot });
  const cookie = seedSession(dataRoot, APP_ID).cookie;
  const path = `/api/apps/${APP_ID}/tables/${TABLE_ID}/records`;

  const postReq = (body: unknown): Request =>
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: TEST_ORIGIN },
      body: JSON.stringify(body),
    });

  const first = await app.request(postReq({ email: "http@example.com", name: "先客" }));
  expect(first.status).toBe(201);

  const dup = await app.request(postReq({ email: "http@example.com", name: "後客" }));
  expect(dup.status).toBe(400);
  const body = (await dup.json()) as { errors: { path: string; message: string }[] };
  expect(body.errors[0]?.path).toBe("/email");
  expect(body.errors[0]?.message).toContain("一意");
});
