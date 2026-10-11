/**
 * **名簿・付与の書込点の起点の操作者(`$actor`)**(`V23-M4-T03`。`D-V23-93`・`D-V23-102`・`D-V23-105`。
 * 門A `ADR-0524` §Decision 1-1)。
 *
 * - 自己登録・招待の承諾 = 登録した本人。
 * - 役割の変更 = 操作した人(対象者ではない)。
 * - 差分の適用に伴う埋め戻し(`POST /diffs`・MCP `apply_diff`)= 差分を適用した人。
 * - 作成者への付与(HTTP)= 行を作った、ログイン中の利用者。
 *
 * 名簿の表と付与の表の `on_create` に、`values` に `$actor.*` を書いた自動処理を置き、記録の表に
 * 書かれた値を見る。 入口が起点を渡し忘れると3つとも空文字になって赤くなる。
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AuthStore } from "../auth/store.ts";
import {
  appDbPath,
  applyManifest,
  createApp,
  KernelMetaStore,
  type Manifest,
} from "../kernel/index.ts";
import { createMcpServer } from "../mcp/server.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "actor-roster";

const PERMS = [{ id: "keeper", name: "管理", read: true, write: true, delete: true }];

const WORKER_RULES = [
  { target: "table", table: "orgs", can: ["read", "write"] },
  { target: "table", table: "mem", can: ["read"] },
  { target: "table", table: "og", can: ["read", "write"] },
  { target: "table", table: "actor_log", can: ["read", "write"] },
];

function declaration(autoEnroll: boolean): Record<string, unknown> {
  return {
    enabled: true,
    permissions: PERMS,
    creator_permission: "keeper",
    creatable_by_roles: ["member", "expert", "editor"],
    grant: { table: "og", target: "org", member: "member", permission: "permission" },
    members: {
      table: "mem",
      account: "account",
      ...(autoEnroll ? { auto_enroll: { roles: ["member", "expert"], name: "display" } } : {}),
    },
  };
}

function logWorkflow(
  id: string,
  table: string,
  src: string,
  item: string,
): Record<string, unknown> {
  return {
    id,
    name: id,
    trigger: { type: "on_create", table },
    history_table: "wf_log",
    actions: [
      {
        action: "create_record",
        table: "actor_log",
        values: {
          src,
          item,
          aid: "$actor.id",
          alogin: "$actor.login",
          arole: "$actor.role",
        },
      },
    ],
  };
}

function manifest(autoEnroll: boolean): Manifest {
  const base = {
    app: {
      id: APP_ID,
      name: "名簿の操作者",
      tables: [
        {
          id: "orgs",
          name: "組織",
          fields: [{ id: "title", name: "名", type: "text" }],
          access_control: declaration(autoEnroll),
        },
        {
          id: "mem",
          name: "名簿",
          fields: [
            { id: "account", name: "利用者", type: "text" },
            { id: "display", name: "表示名", type: "text" },
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
      roles: [
        { id: "owner", name: "持ち主" },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
        { id: "member", name: "会員", signup: "open", rules: WORKER_RULES },
        { id: "expert", name: "専門家", signup: "invite", rules: WORKER_RULES },
      ],
      workflows: [
        logWorkflow("wf_mem", "mem", "roster", "$record.account"),
        logWorkflow("wf_og", "og", "grant", "$record.org"),
      ],
    },
  };
  return withDefaultRoleRules(base as unknown as Manifest, { skipTables: ["orgs"] });
}

let dataRoot: string | undefined;

afterEach(async () => {
  if (dataRoot !== undefined) {
    await rm(dataRoot, { recursive: true, force: true });
    dataRoot = undefined;
  }
});

async function makeApp(autoEnroll: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gp-actor-roster-"));
  dataRoot = root;
  const meta = KernelMetaStore.open(root);
  try {
    createApp(meta, "名簿の操作者", { app_id: APP_ID });
  } finally {
    meta.close();
  }
  const applied = applyManifest(root, APP_ID, manifest(autoEnroll));
  if (!applied.valid) {
    throw new Error(JSON.stringify(applied.errors));
  }
  return root;
}

async function send(
  root: string,
  method: string,
  path: string,
  body: unknown,
  cookie?: string,
): Promise<Response> {
  return await createServerApp({ dataRoot: root }).request(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        origin: TEST_ORIGIN,
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify(body),
    }),
  );
}

function logsOf(root: string, src: string): Record<string, unknown>[] {
  const db = new Database(appDbPath(root, APP_ID), { readonly: true });
  try {
    return db
      .query<Record<string, unknown>, []>(`SELECT * FROM "actor_log" ORDER BY rowid`)
      .all()
      .filter((row) => row.src === src);
  } finally {
    db.close();
  }
}

function actorOf(row: Record<string, unknown> | undefined): Record<string, unknown> {
  return { id: row?.aid, login: row?.alogin, role: row?.arole };
}

/** 利用者の表の行から、期待する `$actor`(id・ログイン名・アカウントの役割の列)を作る。 */
function accountActor(root: string, username: string): Record<string, unknown> {
  const store = AuthStore.openForApp(root, APP_ID);
  try {
    const user = store.findUserByUsername(username);
    return { id: user?.id, login: user?.username, role: user?.role };
  } finally {
    store.close();
  }
}

async function selfRegister(
  root: string,
  username: string,
  userKind: string,
  code?: string,
): Promise<Response> {
  return await send(root, "POST", `/api/apps/${APP_ID}/auth/signup/password/register`, {
    username,
    password: "pw-123456",
    user_kind: userKind,
    ...(code === undefined ? {} : { invitation_code: code }),
  });
}

function sessionCookie(response: Response): string {
  const raw = response.headers.get("set-cookie") ?? "";
  const match = /st_session=[^;]+/.exec(raw);
  return match === null ? "" : match[0];
}

function declareDiff(diffId: string): Record<string, unknown> {
  return {
    diff_id: diffId,
    intent: "名簿へ自動で入れる",
    operations: [
      { op: "change_table", table: "orgs", changes: { access_control: declaration(true) } },
    ],
  };
}

describe("V23-M4-T03 名簿の書込点の $actor", () => {
  test("(signup) 自己登録で名簿に入った行の on_create は、登録した本人を書く", async () => {
    const root = await makeApp(true);
    seedSession(root, APP_ID, { role: "owner", username: "owner1" });
    const res = await selfRegister(root, "alice", "member");
    expect(res.status, await res.clone().text()).toBe(200);
    const logs = logsOf(root, "roster");
    expect(logs).toHaveLength(1);
    const alice = accountActor(root, "alice");
    expect(logs[0]?.item).toBe(alice.id);
    expect(actorOf(logs[0])).toEqual(alice);
    expect(alice.login).toBe("alice");
  });

  test("(invite) 招待の承諾で名簿に入った行の on_create も、登録した本人を書く", async () => {
    const root = await makeApp(true);
    seedSession(root, APP_ID, { role: "owner", username: "owner1" });
    const store = AuthStore.openForApp(root, APP_ID);
    let code: string;
    try {
      code = store.issueInvitation({
        username: "bob",
        role: "expert" as never,
        issuedBy: "owner1",
      }).code;
    } finally {
      store.close();
    }
    const res = await selfRegister(root, "bob", "expert", code);
    expect(res.status, await res.clone().text()).toBe(200);
    const logs = logsOf(root, "roster");
    expect(logs).toHaveLength(1);
    expect(actorOf(logs[0])).toEqual(accountActor(root, "bob"));
  });

  test("(role-change) 役割の変更で名簿に入った行の on_create は、操作した人を書く(対象者ではない)", async () => {
    const root = await makeApp(true);
    const owner = seedSession(root, APP_ID, { role: "owner", username: "owner1" });
    const carol = seedSession(root, APP_ID, { role: "viewer", username: "carol" });
    const res = await send(
      root,
      "PATCH",
      `/api/apps/${APP_ID}/auth/users/${carol.userId}`,
      { role: "member" },
      owner.cookie,
    );
    expect(res.status, await res.clone().text()).toBe(200);
    const logs = logsOf(root, "roster");
    expect(logs).toHaveLength(1);
    expect(logs[0]?.item).toBe(carol.userId);
    expect(actorOf(logs[0])).toEqual({ id: owner.userId, login: "owner1", role: "owner" });
  });

  test("(backfill-http) POST /diffs の埋め戻しは、差分を適用した人を書く", async () => {
    const root = await makeApp(false);
    seedSession(root, APP_ID, { role: "member", username: "m1" });
    seedSession(root, APP_ID, { role: "member", username: "m2" });
    const owner = seedSession(root, APP_ID, { role: "owner", username: "owner2" });
    const res = await send(
      root,
      "POST",
      `/api/apps/${APP_ID}/diffs`,
      declareDiff("d1"),
      owner.cookie,
    );
    expect(res.status, await res.clone().text()).toBe(201);
    const logs = logsOf(root, "roster");
    expect(logs).toHaveLength(2);
    for (const log of logs) {
      expect(actorOf(log)).toEqual({ id: owner.userId, login: "owner2", role: "owner" });
    }
  });

  test("(backfill-mcp) MCP apply_diff の埋め戻しは、名乗った人を書く", async () => {
    const root = await makeApp(false);
    const owner = seedSession(root, APP_ID, { role: "owner", username: "owner1" });
    seedSession(root, APP_ID, { role: "member", username: "m1" });
    const server = createMcpServer({
      dataRoot: root,
      previewBaseUrl: "http://localhost:3000",
      actor: "owner1",
    });
    const client = new Client({ name: "t03", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    let result: CallToolResult;
    try {
      result = (await client.callTool({
        name: "apply_diff",
        arguments: { app_id: APP_ID, diff: declareDiff("d2") },
      })) as CallToolResult;
    } finally {
      await client.close();
      await server.close();
    }
    expect(result.isError === true, JSON.stringify(result.structuredContent)).toBe(false);
    const logs = logsOf(root, "roster");
    expect(logs).toHaveLength(1);
    expect(actorOf(logs[0])).toEqual({ id: owner.userId, login: "owner1", role: "owner" });
  });

  test("(creator-grant) 作成者への付与の行の on_create は、行を作った人を書く", async () => {
    const root = await makeApp(true);
    seedSession(root, APP_ID, { role: "owner", username: "owner1" });
    const reg = await selfRegister(root, "alice", "member");
    expect(reg.status, await reg.clone().text()).toBe(200);
    const created = await send(
      root,
      "POST",
      `/api/apps/${APP_ID}/tables/orgs/records`,
      { title: "A 社" },
      sessionCookie(reg),
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const logs = logsOf(root, "grant");
    expect(logs).toHaveLength(1);
    expect(actorOf(logs[0])).toEqual(accountActor(root, "alice"));
  });
});
