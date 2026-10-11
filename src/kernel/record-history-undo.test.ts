/**
 * **行の変更履歴と undo / redo**(計画 §27-3 の T06。決定 `D-V23-206`・`D-V23-214`)。
 *
 * - undo すると、その差分より後の履歴も消え(業務の行と同じく、差分の直前の `app.sqlite` に戻る)、redo で戻る。
 * - 内部表の無いスナップショットへ戻した後も、宣言した表へ書ける(書く直前の `CREATE TABLE IF NOT EXISTS`)。
 *   戻した直後に読むと0件(読む側は表を作らない)。
 * - `preview_undo` の応答は変わらない(内部表は数えない。宣言の無い同じアプリと同じ答え)。
 *
 * 置き場は `src/kernel`(`kernel-import-drift` の写しに行を足さないため)。
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../mcp/server.ts";
import { createServerApp } from "../server/app.ts";
import { seedSession, TEST_ORIGIN } from "../server/test-helpers.ts";
import {
  appDbPath,
  applyDiff,
  applyManifest,
  createApp,
  KernelMetaStore,
  type Manifest,
  redo,
  undo,
} from "./index.ts";

type Any = Record<string, unknown>;

function manifest(appId: string, history: boolean): Manifest {
  return {
    app: {
      id: appId,
      name: "履歴と undo",
      tables: [
        {
          id: "items",
          name: "品目",
          ...(history ? { history: true } : {}),
          fields: [
            { id: "title", name: "名前", type: "text" },
            { id: "qty", name: "数", type: "number" },
          ],
        },
      ],
      views: [],
      roles: [
        {
          id: "owner",
          name: "運営",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            { target: "table", table: "items", can: ["read", "write", "delete"] },
          ],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
    },
  } as unknown as Manifest;
}

type Rig = {
  appId: string;
  dataRoot: string;
  server: ReturnType<typeof createServerApp>;
  cookie: string;
};

const dataRoots: string[] = [];

afterEach(async () => {
  for (const dir of dataRoots.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeRig(appId: string, history = true, dataRoot?: string): Promise<Rig> {
  const root = dataRoot ?? (await mkdtemp(join(tmpdir(), "gp-rh-undo-")));
  if (dataRoot === undefined) {
    dataRoots.push(root);
  }
  const meta = KernelMetaStore.open(root);
  try {
    createApp(meta, "履歴と undo", { app_id: appId });
  } finally {
    meta.close();
  }
  const applied = applyManifest(root, appId, manifest(appId, history));
  if (!applied.valid) {
    throw new Error(JSON.stringify(applied.errors));
  }
  const session = seedSession(root, appId, { role: "owner", username: "boss" });
  return {
    appId,
    dataRoot: root,
    server: createServerApp({ dataRoot: root }),
    cookie: session.cookie,
  };
}

function withDb<T>(rig: Rig, run: (db: Database) => T): T {
  const db = new Database(appDbPath(rig.dataRoot, rig.appId));
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function hasHistoryTable(rig: Rig): boolean {
  return withDb(
    rig,
    (db) =>
      (db
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '_record_history'",
        )
        .get()?.n ?? 0) > 0,
  );
}

function historyOps(rig: Rig): string[] {
  if (!hasHistoryTable(rig)) {
    return [];
  }
  return withDb(rig, (db) =>
    db
      .query<{ op: string; record_id: string }, []>(
        "SELECT op, record_id FROM _record_history ORDER BY seq",
      )
      .all()
      .map((row) => `${row.op}:${row.record_id}`),
  );
}

async function send(rig: Rig, method: string, path: string, body?: unknown, extra: Any = {}) {
  const res = await rig.server.request(
    new Request(`http://localhost/api/apps/${rig.appId}${path}`, {
      method,
      headers: {
        cookie: rig.cookie,
        ...(method === "GET" ? {} : { origin: TEST_ORIGIN, "content-type": "application/json" }),
        ...(extra as Record<string, string>),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text || "{}") as Any, text };
}

async function create(rig: Rig, values: Any): Promise<string> {
  const sent = await send(rig, "POST", "/tables/items/records", values);
  expect(sent.status, sent.text).toBe(201);
  return String((sent.body.record as Any)._id);
}

async function update(rig: Rig, id: string, values: Any): Promise<void> {
  const version = withDb(rig, (db) =>
    db.query<{ v: string }, [string]>("SELECT _updated_at AS v FROM items WHERE _id = ?").get(id),
  )?.v as string;
  const sent = await send(rig, "PATCH", `/tables/items/records/${id}`, values, {
    "if-match": version,
  });
  expect(sent.status, sent.text).toBe(200);
}

function addField(rig: Rig, diffId: string): void {
  const applied = applyDiff(rig.dataRoot, rig.appId, {
    diff_id: diffId,
    intent: "項目を足す",
    operations: [
      { op: "add_field", table: "items", field: { id: diffId, name: diffId, type: "text" } },
    ],
  });
  expect((applied as { valid?: boolean }).valid, JSON.stringify(applied)).toBe(true);
}

async function mcp(rig: Rig, name: string, args: Any): Promise<CallToolResult> {
  const server = createMcpServer({
    dataRoot: rig.dataRoot,
    previewBaseUrl: "http://localhost:3000",
    actor: "boss",
  });
  const client = new Client({ name: "rh-undo", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  try {
    return JSON.parse(
      JSON.stringify(await client.callTool({ name, arguments: { app_id: rig.appId, ...args } })),
    ) as CallToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

function textOf(result: CallToolResult): string {
  return (result.content as { text?: string }[] | undefined)?.[0]?.text ?? "";
}

describe("(U) undo と redo", () => {
  test("(U-1) undo でその差分より後の履歴も消え、redo で戻る(HTTP と MCP の読みも同じ)", async () => {
    const rig = await makeRig("rh-undo-a");
    const first = await create(rig, { title: "一", qty: 1 });
    expect(historyOps(rig)).toEqual([`create:${first}`]);
    addField(rig, "memo1");
    await update(rig, first, { qty: 2 });
    const second = await create(rig, { title: "二", qty: 5 });
    const after = [`create:${first}`, `update:${first}`, `create:${second}`];
    expect(historyOps(rig)).toEqual(after);

    const undone = undo(rig.dataRoot, rig.appId);
    expect(undone.valid, JSON.stringify(undone)).toBe(true);
    expect(historyOps(rig)).toEqual([`create:${first}`]);
    const read = await send(rig, "GET", `/tables/items/records/${first}?history=1`);
    expect(read.status).toBe(200);
    expect(((read.body.history as Any).items as Any[]).map((item) => item.op)).toEqual(["create"]);
    const viaMcp = await mcp(rig, "list_record_history", { table_id: "items", record_id: first });
    expect(viaMcp.isError, textOf(viaMcp)).not.toBe(true);
    expect(JSON.parse(textOf(viaMcp)).total).toBe(1);

    const redone = redo(rig.dataRoot, rig.appId);
    expect(redone.valid, JSON.stringify(redone)).toBe(true);
    expect(historyOps(rig)).toEqual(after);
    const back = await send(rig, "GET", `/tables/items/records/${first}?history=1`);
    expect(((back.body.history as Any).items as Any[]).map((item) => item.op)).toEqual([
      "update",
      "create",
    ]);
  });

  test("(U-2) 内部表の無いスナップショットへ戻した後も、宣言した表へ書ける(戻した直後の読みは0件)", async () => {
    const rig = await makeRig("rh-undo-b");
    expect(hasHistoryTable(rig)).toBe(false);
    addField(rig, "memo1");
    const first = await create(rig, { title: "一", qty: 1 });
    expect(hasHistoryTable(rig)).toBe(true);

    const undone = undo(rig.dataRoot, rig.appId);
    expect(undone.valid, JSON.stringify(undone)).toBe(true);
    // 差分の直前の app.sqlite には内部表が無い。
    expect(hasHistoryTable(rig)).toBe(false);
    const viaMcp = await mcp(rig, "list_record_history", { table_id: "items", record_id: first });
    // 行も戻って消えている(運営だけが読める消した行の扱いでもなく、履歴が無いので見つからない)。
    expect(viaMcp.isError).toBe(true);
    expect(hasHistoryTable(rig)).toBe(false);

    const again = await create(rig, { title: "戻した後", qty: 3 });
    expect(hasHistoryTable(rig)).toBe(true);
    expect(historyOps(rig)).toEqual([`create:${again}`]);
    const read = await send(rig, "GET", `/tables/items/records/${again}?history=1`);
    expect((read.body.history as Any).total).toBe(1);
  });

  test("(U-3) preview_undo の応答は変わらない(内部表を数えず、宣言の無い同じアプリと同じ答え)", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "gp-rh-undo-"));
    dataRoots.push(dataRoot);
    const withHistory = await makeRig("rh-undo-h", true, dataRoot);
    const without = await makeRig("rh-undo-n", false, dataRoot);
    const previews: Any[] = [];
    for (const rig of [withHistory, without]) {
      const first = await create(rig, { title: "一", qty: 1 });
      addField(rig, "memo1");
      await update(rig, first, { qty: 2 });
      await create(rig, { title: "二", qty: 5 });
      const result = await mcp(rig, "preview_undo", {});
      expect(result.isError, textOf(result)).not.toBe(true);
      expect(textOf(result)).not.toContain("_record_history");
      previews.push((JSON.parse(textOf(result)) as { preview: Any }).preview);
    }
    expect(hasHistoryTable(withHistory)).toBe(true);
    expect(hasHistoryTable(without)).toBe(false);
    const [h, n] = previews as [Any, Any];
    expect(Object.keys(h).sort()).toEqual(Object.keys(n).sort());
    for (const key of [
      "lost_records",
      "restored_records",
      "changed_records",
      "removed_resources",
    ]) {
      expect(h[key], key).toEqual(n[key]);
    }
    expect(h.lost_records).toEqual({ items: 1 });
  });
});
