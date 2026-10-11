/**
 * **名簿・付与の書込点の `st_updated_by`**(`V23-M4-T05`。`D-V23-98`・`D-V23-105`。門A `ADR-0524` 限定19)。
 *
 * 名簿の表と付与の表が `st_updated_by`(text・必須でない)を持つとき、次の書込点で押す値を見る。
 *
 * - 自己登録・招待の承諾 = 登録した本人。
 * - 役割の変更 = 操作した人(対象者ではない)。
 * - 差分の適用に伴う埋め戻し(`POST /diffs`・MCP `apply_diff`)= 差分を適用した人。
 * - 作成者への付与(HTTP)= 行を作った、ログイン中の利用者。
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

const APP_ID = "updated-by-roster";
const UB = "st_updated_by";

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
      name: "名簿の更新者",
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
            { id: UB, name: "更新者", type: "text" },
          ],
        },
        {
          id: "og",
          name: "付与",
          fields: [
            { id: "org", name: "組織", type: "reference", reference_table: "orgs" },
            { id: "member", name: "相手", type: "reference", reference_table: "mem" },
            { id: "permission", name: "権限", type: "select", options: ["keeper"] },
            { id: UB, name: "更新者", type: "text" },
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
  const root = await mkdtemp(join(tmpdir(), "gp-updated-by-roster-"));
  dataRoot = root;
  const meta = KernelMetaStore.open(root);
  try {
    createApp(meta, "名簿の更新者", { app_id: APP_ID });
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

function rowsOf(root: string, table: string): Record<string, unknown>[] {
  const db = new Database(appDbPath(root, APP_ID), { readonly: true });
  try {
    return db.query<Record<string, unknown>, []>(`SELECT * FROM "${table}" ORDER BY rowid`).all();
  } finally {
    db.close();
  }
}

describe("V23-M4-T05 名簿・付与の書込点の st_updated_by", () => {
  test("(signup) 自己登録で名簿に入った行は、登録した本人を押す", async () => {
    const root = await makeApp(true);
    seedSession(root, APP_ID, { role: "owner", username: "owner1" });
    const res = await selfRegister(root, "alice", "member");
    expect(res.status, await res.clone().text()).toBe(200);
    const rows = rowsOf(root, "mem");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.[UB]).toBe(accountActor(root, "alice").id);
  });

  test("(invite) 招待の承諾で名簿に入った行も、登録した本人を押す", async () => {
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
    const rows = rowsOf(root, "mem");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.[UB]).toBe(accountActor(root, "bob").id);
  });

  test("(role-change) 役割の変更で名簿に入った行は、操作した人を押す(対象者ではない)", async () => {
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
    const rows = rowsOf(root, "mem");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.account).toBe(carol.userId);
    expect(rows[0]?.[UB]).toBe(owner.userId);
  });

  test("(backfill-http) POST /diffs の埋め戻しは、差分を適用した人を押す", async () => {
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
    const rows = rowsOf(root, "mem");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row[UB]).toBe(owner.userId);
    }
  });

  test("(backfill-mcp) MCP apply_diff の埋め戻しは、名乗った人を押す", async () => {
    const root = await makeApp(false);
    const owner = seedSession(root, APP_ID, { role: "owner", username: "owner1" });
    seedSession(root, APP_ID, { role: "member", username: "m1" });
    const server = createMcpServer({
      dataRoot: root,
      previewBaseUrl: "http://localhost:3000",
      actor: "owner1",
    });
    const client = new Client({ name: "t05", version: "0.0.0" });
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
    const rows = rowsOf(root, "mem");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.[UB]).toBe(owner.userId);
  });

  test("(creator-grant) 作成者への付与の行は、行を作った人を押す", async () => {
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
    const rows = rowsOf(root, "og");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.[UB]).toBe(accountActor(root, "alice").id);
  });
});
