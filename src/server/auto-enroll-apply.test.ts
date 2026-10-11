/**
 * **名簿への自動登録の宣言を差分で足したときの埋め戻しと、`account` 列の一意索引の張り外し**
 * (`V23-M1-T03`。単位 `SC-G1`・`SC-G2`。上位: `docs/adr/0497-auto-enroll-and-last-row-admin.md`
 * §Decision 1、`docs/adr/0510-v23-m1-guard-authorization-and-pre-start-decisions.md` §Decision 1、
 * 計画 `docs/plan/v23/00-v23-plan.md` §4 の M1-A「振る舞い」の1・2)。
 *
 * - (a) 対象の役割を実効で持つ利用者が3人いるアプリに宣言を足すと、名簿の行が3行できる
 * - (b) 既に行がある人には増えない
 * - (c) `apply_diff` と `POST /diffs` で同じ結果になる
 * - (d) 利用者が0人のアプリでは0件で正常に終わる
 * - (e) 書けない行が1件あれば差分全体が断られ、定義も名簿も変わらない
 * - (f) 適用の後に `account` の一意索引が在る(`sqlite_master` を読む)
 * - (g) 宣言を外すと索引が消え、行は残る
 * - (h) `undo` で索引と行が両方戻る
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  appDbPath,
  applyDiff,
  applyManifest,
  createApp,
  KernelMetaStore,
  type Manifest,
  readCurrentManifest,
  undo,
} from "../kernel/index.ts";
import { createMcpServer } from "../mcp/server.ts";
import { createServerApp } from "./app.ts";
import { autoEnrollBackfill } from "./auto-enroll-backfill.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const PERMS = [{ id: "keeper", name: "管理", read: true, write: true, delete: true }];

function declaration(autoEnroll?: Record<string, unknown>): Record<string, unknown> {
  return {
    enabled: true,
    permissions: PERMS,
    creator_permission: "keeper",
    creatable_by_roles: ["editor"],
    grant: { table: "og", target: "org", member: "member", permission: "permission" },
    members: {
      table: "mem",
      account: "account",
      ...(autoEnroll === undefined ? {} : { auto_enroll: autoEnroll }),
    },
  };
}

/**
 * **【`V23-M9-T03`】埋め戻しの時の検査用**: 名簿の表・付与の表・役割・`enabled` を選べる宣言。
 * `declaration` は1バイトも変えていない(既存の検査の形を保つ)。
 */
function declarationOf(options: {
  roles?: string[];
  enabled?: boolean;
  second?: boolean;
}): Record<string, unknown> {
  const second = options.second === true;
  return {
    enabled: options.enabled ?? true,
    permissions: PERMS,
    creator_permission: "keeper",
    creatable_by_roles: ["editor"],
    grant: {
      table: second ? "og2" : "og",
      target: "org",
      member: "member",
      permission: "permission",
    },
    members: {
      table: second ? "mem2" : "mem",
      account: "account",
      ...(options.roles === undefined
        ? {}
        : { auto_enroll: { roles: options.roles, name: "display" } }),
    },
  };
}

function changeDiff(
  diffId: string,
  ...declarations: Record<string, unknown>[]
): Record<string, unknown> {
  return {
    diff_id: diffId,
    intent: "名簿への自動登録の宣言を変える",
    operations: declarations.map((access) => ({
      op: "change_table",
      table: "orgs",
      changes: { access_control: access },
    })),
  };
}

function unrelatedDiff(diffId: string): Record<string, unknown> {
  return {
    diff_id: diffId,
    intent: "組織に列を足す",
    operations: [
      { op: "add_field", table: "orgs", field: { id: "memo", name: "メモ", type: "text" } },
    ],
  };
}

function manifest(appId: string, requiredExtra = false, secondRoster = false): Manifest {
  const base = {
    app: {
      id: appId,
      name: "埋め戻し",
      tables: [
        {
          id: "orgs",
          name: "組織",
          fields: [{ id: "title", name: "名", type: "text" }],
          access_control: declaration(),
        },
        {
          id: "mem",
          name: "名簿",
          fields: [
            { id: "account", name: "利用者", type: "text" },
            { id: "display", name: "表示名", type: "text" },
            ...(requiredExtra
              ? [{ id: "org_code", name: "必須の列", type: "text", required: true }]
              : []),
          ],
        },
        {
          id: "og",
          name: "付与",
          fields: [
            { id: "org", name: "組織", type: "reference", reference_table: "orgs" },
            { id: "member", name: "相手", type: "reference", reference_table: "mem" },
            { id: "permission", name: "権限", type: "select", options: ["keeper"] },
          ],
        },
        ...(secondRoster
          ? [
              {
                id: "mem2",
                name: "新しい名簿",
                fields: [
                  { id: "account", name: "利用者", type: "text" },
                  { id: "display", name: "表示名", type: "text" },
                ],
              },
              {
                id: "og2",
                name: "新しい付与",
                fields: [
                  { id: "org", name: "組織", type: "reference", reference_table: "orgs" },
                  { id: "member", name: "相手", type: "reference", reference_table: "mem2" },
                  { id: "permission", name: "権限", type: "select", options: ["keeper"] },
                ],
              },
            ]
          : []),
      ],
      views: [],
      roles: [
        { id: "owner", name: "持ち主" },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
    },
  };
  return withDefaultRoleRules(base as unknown as Manifest, { skipTables: ["orgs"] });
}

function declareDiff(diffId: string): Record<string, unknown> {
  return {
    diff_id: diffId,
    intent: "名簿へ自動で入れる",
    operations: [
      {
        op: "change_table",
        table: "orgs",
        changes: { access_control: declaration({ roles: ["editor"], name: "display" }) },
      },
    ],
  };
}

function undeclareDiff(diffId: string): Record<string, unknown> {
  return {
    diff_id: diffId,
    intent: "名簿への自動登録をやめる",
    operations: [{ op: "change_table", table: "orgs", changes: { access_control: declaration() } }],
  };
}

const INDEX_NAME = "_auto_enroll__mem__account";

let dataRoot = "";
beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-auto-enroll-apply-"));
});
afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function setup(appId: string, requiredExtra = false, secondRoster = false): void {
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, appId, { app_id: appId });
  } finally {
    store.close();
  }
  const applied = applyManifest(dataRoot, appId, manifest(appId, requiredExtra, secondRoster));
  if (!applied.valid) {
    throw new Error(JSON.stringify(applied.errors));
  }
}

/** 対象の役割(editor)を実効で持つ3人・対象外1人・運営1人。 */
function seedUsers(appId: string): Record<string, string> {
  const ids: Record<string, string> = {};
  ids.owner1 = seedSession(dataRoot, appId, { role: "owner", username: "owner1" }).userId;
  ids.alice = seedSession(dataRoot, appId, { role: "editor", username: "alice" }).userId;
  ids.bob = seedSession(dataRoot, appId, { role: "editor", username: "bob" }).userId;
  ids.dave = seedSession(dataRoot, appId, {
    role: "viewer",
    username: "dave",
    grants: ["editor"],
  }).userId;
  ids.carol = seedSession(dataRoot, appId, { role: "viewer", username: "carol" }).userId;
  return ids;
}

function memRows(appId: string, table = "mem"): { account: string; display: string | null }[] {
  const db = new Database(appDbPath(dataRoot, appId), { readonly: true });
  try {
    return db
      .query<{ account: string; display: string | null }, []>(
        `SELECT "account", "display" FROM "${table}" ORDER BY "display", "account"`,
      )
      .all();
  } finally {
    db.close();
  }
}

function indexExists(appId: string): boolean {
  const db = new Database(appDbPath(dataRoot, appId), { readonly: true });
  try {
    const row = db
      .query<{ sql: string }, [string]>(
        `SELECT "sql" FROM "sqlite_master" WHERE "type" = 'index' AND "name" = ?`,
      )
      .get(INDEX_NAME);
    return row !== null && /UNIQUE/i.test(row.sql) && row.sql.includes('"account"');
  } finally {
    db.close();
  }
}

function declared(appId: string): boolean {
  return JSON.stringify(readCurrentManifest(dataRoot, appId).app.tables[0]).includes("auto_enroll");
}

function insertMem(appId: string, account: string, display: string): void {
  const db = new Database(appDbPath(dataRoot, appId));
  try {
    db.query(
      `INSERT INTO "mem" ("_id", "_created_at", "_updated_at", "account", "display") VALUES (?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      new Date().toISOString(),
      new Date().toISOString(),
      account,
      display,
    );
  } finally {
    db.close();
  }
}

async function postDiff(appId: string, cookie: string, diff: unknown): Promise<Response> {
  const app = createServerApp({ dataRoot });
  return app.request(`/api/apps/${appId}/diffs`, {
    method: "POST",
    headers: { cookie, origin: TEST_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(diff),
  });
}

async function mcpApplyDiff(appId: string, actor: string, diff: unknown): Promise<CallToolResult> {
  const server = createMcpServer({ dataRoot, previewBaseUrl: "http://localhost:3000", actor });
  const client = new Client({ name: "t03", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  try {
    return (await client.callTool({
      name: "apply_diff",
      arguments: { app_id: appId, diff },
    })) as CallToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

describe("V23-M1-T03 埋め戻しと索引", () => {
  test("(a)(f) POST /diffs で宣言を足すと、対象の役割を実効で持つ3人ぶん名簿に行ができ、account の一意索引が張られる", async () => {
    setup("t03a");
    const ids = seedUsers("t03a");
    const owner = seedSession(dataRoot, "t03a", { role: "owner", username: "owner2" });
    const res = await postDiff("t03a", owner.cookie, declareDiff("d-t03a"));
    expect(res.status, await res.clone().text()).toBe(201);
    expect(declared("t03a")).toBe(true);
    expect(memRows("t03a")).toEqual([
      { account: ids.alice as string, display: "alice" },
      { account: ids.bob as string, display: "bob" },
      { account: ids.dave as string, display: "dave" },
    ]);
    expect(indexExists("t03a")).toBe(true);
  });

  test("(b) 既に名簿に行がある人には増えない", async () => {
    setup("t03b");
    const ids = seedUsers("t03b");
    insertMem("t03b", ids.alice as string, "既にいる");
    const owner = seedSession(dataRoot, "t03b", { role: "owner", username: "owner2" });
    const res = await postDiff("t03b", owner.cookie, declareDiff("d-t03b"));
    expect(res.status).toBe(201);
    const rows = memRows("t03b");
    expect(rows.filter((row) => row.account === ids.alice)).toEqual([
      { account: ids.alice as string, display: "既にいる" },
    ]);
    expect(rows).toHaveLength(3);
  });

  test("(c) apply_diff(MCP)と POST /diffs(HTTP)で同じ名簿の行ができる", async () => {
    setup("t03http");
    setup("t03mcp");
    seedUsers("t03http");
    seedUsers("t03mcp");
    const owner = seedSession(dataRoot, "t03http", { role: "owner", username: "owner2" });
    const res = await postDiff("t03http", owner.cookie, declareDiff("d-t03c"));
    expect(res.status).toBe(201);
    const result = await mcpApplyDiff("t03mcp", "owner1", declareDiff("d-t03c"));
    expect(result.isError === true, JSON.stringify(result.structuredContent)).toBe(false);
    const displays = (appId: string) => memRows(appId).map((row) => row.display);
    expect(displays("t03mcp")).toEqual(["alice", "bob", "dave"]);
    expect(displays("t03mcp")).toEqual(displays("t03http"));
    expect(indexExists("t03mcp")).toBe(true);
  });

  test("(d) 利用者の表が無いアプリでは、0件で正常に終わる(索引は張る)", () => {
    setup("t03d");
    const result = applyDiff(dataRoot, "t03d", declareDiff("d-t03d"), {
      afterMigrate: autoEnrollBackfill,
    });
    expect(result.valid, JSON.stringify(result)).toBe(true);
    expect(memRows("t03d")).toEqual([]);
    expect(declared("t03d")).toBe(true);
    expect(indexExists("t03d")).toBe(true);
  });

  test("(e) 書けない行が1件あれば、差分全体が断られ、定義も名簿も索引も変わらない", () => {
    setup("t03e", true);
    seedSession(dataRoot, "t03e", { role: "editor", username: "alice" });
    const before = JSON.stringify(readCurrentManifest(dataRoot, "t03e"));
    const result = applyDiff(dataRoot, "t03e", declareDiff("d-t03e"), {
      afterMigrate: autoEnrollBackfill,
    });
    expect(result.valid).toBe(false);
    expect(
      (result.valid ? [] : result.errors).some((error) => error.path === "/org_code"),
      JSON.stringify(result),
    ).toBe(true);
    expect(JSON.stringify(readCurrentManifest(dataRoot, "t03e"))).toBe(before);
    expect(memRows("t03e")).toEqual([]);
    expect(indexExists("t03e")).toBe(false);
  });

  test("(g) 宣言を外すと索引が消え、名簿の行は残る", async () => {
    setup("t03g");
    seedUsers("t03g");
    const owner = seedSession(dataRoot, "t03g", { role: "owner", username: "owner2" });
    expect((await postDiff("t03g", owner.cookie, declareDiff("d-t03g-1"))).status).toBe(201);
    expect(indexExists("t03g")).toBe(true);
    expect((await postDiff("t03g", owner.cookie, undeclareDiff("d-t03g-2"))).status).toBe(201);
    expect(declared("t03g")).toBe(false);
    expect(indexExists("t03g")).toBe(false);
    expect(memRows("t03g")).toHaveLength(3);
  });

  test("(h) undo で、索引と名簿の行が両方戻る", async () => {
    setup("t03h");
    seedUsers("t03h");
    const owner = seedSession(dataRoot, "t03h", { role: "owner", username: "owner2" });
    expect((await postDiff("t03h", owner.cookie, declareDiff("d-t03h-1"))).status).toBe(201);
    expect(memRows("t03h")).toHaveLength(3);
    // 外した後の undo で、索引が戻る(行は外しても残っている)。
    expect((await postDiff("t03h", owner.cookie, undeclareDiff("d-t03h-2"))).status).toBe(201);
    expect(indexExists("t03h")).toBe(false);
    expect(undo(dataRoot, "t03h").valid).toBe(true);
    expect(indexExists("t03h")).toBe(true);
    expect(declared("t03h")).toBe(true);
    // 宣言の差分の undo で、索引も埋め戻しの行も消える(宣言の前に戻る)。
    expect(undo(dataRoot, "t03h").valid).toBe(true);
    expect(declared("t03h")).toBe(false);
    expect(indexExists("t03h")).toBe(false);
    expect(memRows("t03h")).toEqual([]);
  });

  test("陰性対照: 宣言の無い差分では、名簿の行も索引もできない", async () => {
    setup("t03n");
    seedUsers("t03n");
    const owner = seedSession(dataRoot, "t03n", { role: "owner", username: "owner2" });
    const res = await postDiff("t03n", owner.cookie, {
      diff_id: "d-t03n",
      intent: "名簿に列を足す",
      operations: [
        { op: "add_field", table: "mem", field: { id: "memo", name: "メモ", type: "text" } },
      ],
    });
    expect(res.status).toBe(201);
    expect(memRows("t03n")).toEqual([]);
    expect(indexExists("t03n")).toBe(false);
  });
});

/** 運営者が名簿の行を消したのと同じ状態を作る(行を直に消す)。 */
function deleteMem(appId: string, account: string): void {
  const db = new Database(appDbPath(dataRoot, appId));
  try {
    db.query(`DELETE FROM "mem" WHERE "account" = ?`).run(account);
  } finally {
    db.close();
  }
}

const displays = (appId: string, table = "mem") => memRows(appId, table).map((row) => row.display);

describe("V23-M9-T03 D-V23-236・D-V23-252: 名簿の埋め戻しは、自動登録の対象の組(名簿の表・役割)が増えた差分のときだけ、増えた組の役割の人だけを入れる", () => {
  test("D-V23-236: 関係の無い差分(POST /diffs)では、消した名簿の行が戻らない", async () => {
    setup("m9a");
    const ids = seedUsers("m9a");
    const owner = seedSession(dataRoot, "m9a", { role: "owner", username: "owner2" });
    expect((await postDiff("m9a", owner.cookie, declareDiff("d-m9a-1"))).status).toBe(201);
    deleteMem("m9a", ids.alice as string);
    const res = await postDiff("m9a", owner.cookie, unrelatedDiff("d-m9a-2"));
    expect(res.status, await res.clone().text()).toBe(201);
    expect(displays("m9a")).toEqual(["bob", "dave"]);
  });

  test("D-V23-236: 関係の無い差分(apply_diff)でも、消した名簿の行が戻らない", async () => {
    setup("m9a2");
    const ids = seedUsers("m9a2");
    expect((await mcpApplyDiff("m9a2", "owner1", declareDiff("d-m9a2-1"))).isError).not.toBe(true);
    deleteMem("m9a2", ids.alice as string);
    const result = await mcpApplyDiff("m9a2", "owner1", unrelatedDiff("d-m9a2-2"));
    expect(result.isError === true, JSON.stringify(result.structuredContent)).toBe(false);
    expect(displays("m9a2")).toEqual(["bob", "dave"]);
  });

  test("D-V23-236: 同じ差分の中で宣言を外して足し直しても、消した名簿の行は戻らない", async () => {
    setup("m9b");
    const ids = seedUsers("m9b");
    const owner = seedSession(dataRoot, "m9b", { role: "owner", username: "owner2" });
    expect((await postDiff("m9b", owner.cookie, declareDiff("d-m9b-1"))).status).toBe(201);
    deleteMem("m9b", ids.alice as string);
    const res = await postDiff(
      "m9b",
      owner.cookie,
      changeDiff("d-m9b-2", declarationOf({}), declarationOf({ roles: ["editor"] })),
    );
    expect(res.status, await res.clone().text()).toBe(201);
    expect(declared("m9b")).toBe(true);
    expect(displays("m9b")).toEqual(["bob", "dave"]);
  });

  test("D-V23-236: 対象の役割を減らす差分では、消した名簿の行は戻らない", async () => {
    setup("m9c");
    const ids = seedUsers("m9c");
    const owner = seedSession(dataRoot, "m9c", { role: "owner", username: "owner2" });
    expect(
      (
        await postDiff(
          "m9c",
          owner.cookie,
          changeDiff("d-m9c-1", declarationOf({ roles: ["editor", "viewer"] })),
        )
      ).status,
    ).toBe(201);
    expect(displays("m9c")).toEqual(["alice", "bob", "carol", "dave"]);
    deleteMem("m9c", ids.alice as string);
    const res = await postDiff(
      "m9c",
      owner.cookie,
      changeDiff("d-m9c-2", declarationOf({ roles: ["editor"] })),
    );
    expect(res.status, await res.clone().text()).toBe(201);
    expect(displays("m9c")).toEqual(["bob", "carol", "dave"]);
  });

  test("D-V23-236: 対象の役割を足す差分では、足した役割を持つ人だけが入る(消した他の役割の人は戻らない)", async () => {
    setup("m9d");
    const ids = seedUsers("m9d");
    const owner = seedSession(dataRoot, "m9d", { role: "owner", username: "owner2" });
    expect((await postDiff("m9d", owner.cookie, declareDiff("d-m9d-1"))).status).toBe(201);
    deleteMem("m9d", ids.alice as string);
    deleteMem("m9d", ids.dave as string);
    const res = await postDiff(
      "m9d",
      owner.cookie,
      changeDiff("d-m9d-2", declarationOf({ roles: ["editor", "viewer"] })),
    );
    expect(res.status, await res.clone().text()).toBe(201);
    // carol(viewer)と dave(viewer に editor を足された人)は足した役割 viewer を持つので入る。
    // alice(editor だけ)は戻らない。
    expect(displays("m9d")).toEqual(["bob", "carol", "dave"]);
  });

  test("D-V23-236: enabled を外す差分と付ける差分を別々に当てると、付けた差分で消した行が戻る", async () => {
    setup("m9e");
    const ids = seedUsers("m9e");
    const owner = seedSession(dataRoot, "m9e", { role: "owner", username: "owner2" });
    expect((await postDiff("m9e", owner.cookie, declareDiff("d-m9e-1"))).status).toBe(201);
    deleteMem("m9e", ids.alice as string);
    const off = await postDiff(
      "m9e",
      owner.cookie,
      changeDiff("d-m9e-2", declarationOf({ roles: ["editor"], enabled: false })),
    );
    expect(off.status, await off.clone().text()).toBe(201);
    expect(displays("m9e")).toEqual(["bob", "dave"]);
    const on = await postDiff(
      "m9e",
      owner.cookie,
      changeDiff("d-m9e-3", declarationOf({ roles: ["editor"] })),
    );
    expect(on.status, await on.clone().text()).toBe(201);
    expect(displays("m9e")).toEqual(["alice", "bob", "dave"]);
  });

  test("D-V23-236: 名簿の表を付け替えると、新しい表の組が増えたので、対象の役割の人が新しい表に入る(古い表は戻らない)", async () => {
    setup("m9f", false, true);
    const ids = seedUsers("m9f");
    const owner = seedSession(dataRoot, "m9f", { role: "owner", username: "owner2" });
    expect((await postDiff("m9f", owner.cookie, declareDiff("d-m9f-1"))).status).toBe(201);
    deleteMem("m9f", ids.alice as string);
    const res = await postDiff(
      "m9f",
      owner.cookie,
      changeDiff("d-m9f-2", declarationOf({ roles: ["editor"], second: true })),
    );
    expect(res.status, await res.clone().text()).toBe(201);
    expect(displays("m9f", "mem2")).toEqual(["alice", "bob", "dave"]);
    expect(displays("m9f")).toEqual(["bob", "dave"]);
  });

  test("D-V23-236: 名簿への書込が断られる状態でも、関係の無い差分は通る", async () => {
    setup("m9g", true);
    // 利用者が0人のうちに宣言を足す(埋める人がいないので通る)。
    expect(
      applyDiff(dataRoot, "m9g", declareDiff("d-m9g-1"), { afterMigrate: autoEnrollBackfill })
        .valid,
    ).toBe(true);
    // その後に入った対象の役割の人は名簿に行が無く、名簿は必須の列のせいで書けない。
    seedSession(dataRoot, "m9g", { role: "editor", username: "alice" });
    const owner = seedSession(dataRoot, "m9g", { role: "owner", username: "owner2" });
    const res = await postDiff("m9g", owner.cookie, unrelatedDiff("d-m9g-2"));
    expect(res.status, await res.clone().text()).toBe(201);
    expect(memRows("m9g")).toEqual([]);
  });

  test("D-V23-236: 宣言を新しく書いた差分は、今日どおり対象の役割を持つ全員を入れる", () => {
    setup("m9h");
    const ids = seedUsers("m9h");
    const result = applyDiff(dataRoot, "m9h", declareDiff("d-m9h-1"), {
      afterMigrate: autoEnrollBackfill,
    });
    expect(result.valid, JSON.stringify(result)).toBe(true);
    expect(memRows("m9h")).toEqual([
      { account: ids.alice as string, display: "alice" },
      { account: ids.bob as string, display: "bob" },
      { account: ids.dave as string, display: "dave" },
    ]);
  });

  test("D-V23-252: 消した名簿の行は、運営者がその人の役割を配り直すと戻る", async () => {
    setup("m9i");
    const ids = seedUsers("m9i");
    const owner = seedSession(dataRoot, "m9i", { role: "owner", username: "owner2" });
    expect((await postDiff("m9i", owner.cookie, declareDiff("d-m9i-1"))).status).toBe(201);
    deleteMem("m9i", ids.alice as string);
    expect((await postDiff("m9i", owner.cookie, unrelatedDiff("d-m9i-2"))).status).toBe(201);
    expect(displays("m9i")).toEqual(["bob", "dave"]);
    const app = createServerApp({ dataRoot });
    const res = await app.request(`/api/apps/m9i/auth/users/${ids.alice}`, {
      method: "PATCH",
      headers: { cookie: owner.cookie, origin: TEST_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ role: "editor" }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(displays("m9i")).toEqual(["alice", "bob", "dave"]);
  });
});
