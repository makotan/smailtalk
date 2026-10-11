/**
 * **退会の連鎖と、本人の `name` 列**(`V23-M1-T06`。単位 `SC-G3`・`SC-G4`。上位:
 * `docs/adr/0497-auto-enroll-and-last-row-admin.md` §Decision 1、計画 `docs/plan/v23/00-v23-plan.md`
 * §4 の M1-A「振る舞い」の4・5)。
 *
 * - (W) 退会すると、自動登録を宣言した名簿のその人の行と、その行を相手にした付与の行が消える。
 *   宣言していない名簿は今日どおり残る。
 * - (N) 本人は自分の名簿の行の `name` 列だけを書ける。 他の列・他人の行・作成・削除は今日どおり 403。
 *   `name` を宣言していない名簿・自動登録の無いアプリでは今日どおり 403。
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
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN } from "./test-helpers.ts";

const APP_ID = "scs-withdraw";

const OWNER_RULES = [
  { target: "app", can: ["write"] },
  { target: "role", can: ["write"] },
  { target: "table", table: "orgs", can: ["read", "write", "delete"] },
  { target: "table", table: "mem", can: ["read", "write", "delete"] },
  { target: "table", table: "og", can: ["read", "write", "delete"] },
];
const WORKER_RULES = [
  { target: "table", table: "orgs", can: ["read", "write"] },
  { target: "table", table: "mem", can: ["read", "write", "delete"] },
  { target: "table", table: "og", can: ["read", "write"] },
];

type Shape = "declared" | "declared-no-name" | "undeclared";

function manifest(shape: Shape): Manifest {
  const autoEnroll =
    shape === "declared"
      ? { auto_enroll: { roles: ["member"], name: "display" } }
      : shape === "declared-no-name"
        ? { auto_enroll: { roles: ["member"] } }
        : {};
  return {
    app: {
      id: APP_ID,
      name: "退会",
      tables: [
        {
          id: "orgs",
          name: "組織",
          fields: [{ id: "title", name: "名", type: "text" }],
          access_control: {
            enabled: true,
            permissions: [{ id: "keeper", name: "管理", read: true, write: true, delete: true }],
            creator_permission: "keeper",
            creatable_by_roles: ["member"],
            grant: { table: "og", target: "org", member: "member", permission: "permission" },
            members: { table: "mem", account: "account", ...autoEnroll },
          },
        },
        {
          id: "mem",
          name: "名簿",
          fields: [
            { id: "account", name: "利用者", type: "text" },
            { id: "display", name: "表示名", type: "text" },
            { id: "note", name: "メモ", type: "text" },
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
      ],
      views: [],
      roles: [
        { id: "owner", name: "持ち主", rules: OWNER_RULES },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
        { id: "member", name: "会員", signup: "open", rules: WORKER_RULES },
      ],
    },
  } as unknown as Manifest;
}

let dataRoot: string | undefined;
let server: ReturnType<typeof createServerApp>;
let ownerCookie = "";
let ownerId = "";

async function makeApp(shape: Shape): Promise<void> {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-auto-enroll-withdraw-"));
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, "退会", { app_id: APP_ID });
  } finally {
    meta.close();
  }
  const applied = applyManifest(dataRoot, APP_ID, manifest(shape));
  if (!applied.valid) {
    throw new Error(JSON.stringify(applied.errors));
  }
  const owner = seedSession(dataRoot, APP_ID, { role: "owner", username: "owner1" });
  ownerCookie = owner.cookie;
  ownerId = owner.userId;
  server = createServerApp({ dataRoot });
}

afterEach(async () => {
  if (dataRoot !== undefined) {
    await rm(dataRoot, { recursive: true, force: true });
    dataRoot = undefined;
  }
});

async function send(
  method: string,
  path: string,
  body: unknown,
  cookie: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await server.request(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "content-type": "application/json", origin: TEST_ORIGIN, cookie, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

function sessionCookie(response: Response): string {
  const match = /st_session=[^;]+/.exec(response.headers.get("set-cookie") ?? "");
  return match === null ? "" : match[0];
}

/** セルフ登録して、その人のクッキーと利用者 ID を返す。 */
async function register(username: string): Promise<{ cookie: string; id: string }> {
  const res = await send(
    "POST",
    `/api/apps/${APP_ID}/auth/signup/password/register`,
    { username, password: "pw-123456", user_kind: "member" },
    "",
  );
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as { user: { id: string } };
  return { cookie: sessionCookie(res), id: body.user.id };
}

function rows(tableId: string): Record<string, unknown>[] {
  const db = new Database(appDbPath(dataRoot as string, APP_ID), { readonly: true });
  try {
    return db.query<Record<string, unknown>, []>(`SELECT * FROM "${tableId}"`).all();
  } finally {
    db.close();
  }
}

/** 宣言の無い名簿の行を運営が置く(自動登録が無いので、手で置く)。 */
async function ownerAddsMember(account: string, display: string): Promise<void> {
  const res = await send(
    "POST",
    `/api/apps/${APP_ID}/tables/mem/records`,
    { account, display },
    ownerCookie,
  );
  expect(res.status, await res.clone().text()).toBe(201);
}

function memRowOf(account: string): { _id: string; _updated_at: string } {
  const found = rows("mem").find((row) => row.account === account);
  if (found === undefined) {
    throw new Error(`名簿の行が無い: ${account}`);
  }
  return { _id: String(found._id), _updated_at: String(found._updated_at) };
}

async function patchMem(
  cookie: string,
  account: string,
  changes: Record<string, unknown>,
): Promise<Response> {
  const row = memRowOf(account);
  return await send("PATCH", `/api/apps/${APP_ID}/tables/mem/records/${row._id}`, changes, cookie, {
    "if-match": row._updated_at,
  });
}

describe("V23-M1-T06 退会の連鎖", () => {
  test("(W-1) 宣言した名簿: 退会すると、その人の名簿の行と、その行を相手にした付与の行が消える(他の人と組織は残る)", async () => {
    await makeApp("declared");
    const alice = await register("alice");
    const bob = await register("bob");
    expect(
      (
        await send(
          "POST",
          `/api/apps/${APP_ID}/tables/orgs/records`,
          { title: "A 社" },
          alice.cookie,
        )
      ).status,
    ).toBe(201);
    expect(
      (await send("POST", `/api/apps/${APP_ID}/tables/orgs/records`, { title: "B 社" }, bob.cookie))
        .status,
    ).toBe(201);
    const aliceRow = memRowOf(alice.id)._id;
    expect(rows("og").filter((row) => row.member === aliceRow)).toHaveLength(1);

    const res = await send("DELETE", `/api/apps/${APP_ID}/auth/me`, undefined, alice.cookie);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(rows("mem").map((row) => row.account)).toEqual([bob.id]);
    expect(rows("og").filter((row) => row.member === aliceRow)).toEqual([]);
    expect(rows("og")).toHaveLength(1);
    expect(rows("orgs")).toHaveLength(2);
  });

  test("(W-2) 陰性対照: 宣言していない名簿は、退会しても名簿の行も付与の行も今日どおり残る", async () => {
    await makeApp("undeclared");
    const alice = await register("alice");
    await ownerAddsMember(alice.id, "alice");
    expect(
      (
        await send(
          "POST",
          `/api/apps/${APP_ID}/tables/orgs/records`,
          { title: "A 社" },
          alice.cookie,
        )
      ).status,
    ).toBe(201);
    const res = await send("DELETE", `/api/apps/${APP_ID}/auth/me`, undefined, alice.cookie);
    expect(res.status).toBe(200);
    expect(rows("mem").map((row) => row.account)).toEqual([alice.id]);
    expect(rows("og")).toHaveLength(1);
  });

  test("(W-3) 退会が断られたら(最後の運営)、名簿の行も消えない(同じトランザクション)", async () => {
    await makeApp("declared");
    // 運営の名簿の行を手で置く(運営は自動登録の対象の役割ではないため)。
    await ownerAddsMember(ownerId, "owner1");
    const res = await send("DELETE", `/api/apps/${APP_ID}/auth/me`, undefined, ownerCookie);
    expect(res.status).toBe(409);
    expect(rows("mem").map((row) => row.account)).toEqual([ownerId]);
  });
});

describe("V23-M1-T06 本人の name 列", () => {
  test("(N-1) 本人は自分の名簿の行の name 列を書き換えられる", async () => {
    await makeApp("declared");
    const alice = await register("alice");
    const res = await patchMem(alice.cookie, alice.id, { display: "アリス" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(rows("mem").find((row) => row.account === alice.id)?.display).toBe("アリス");
  });

  test("(N-2) 本人でも、name 以外の列(account・その他)を変える更新は今日どおり 403", async () => {
    await makeApp("declared");
    const alice = await register("alice");
    expect((await patchMem(alice.cookie, alice.id, { note: "メモ" })).status).toBe(403);
    expect((await patchMem(alice.cookie, alice.id, { display: "アリス", note: "x" })).status).toBe(
      403,
    );
    expect((await patchMem(alice.cookie, alice.id, { account: "someone-else" })).status).toBe(403);
  });

  test("(N-3) 他人の行の name 列は今日どおり 403", async () => {
    await makeApp("declared");
    const alice = await register("alice");
    const bob = await register("bob");
    expect((await patchMem(alice.cookie, bob.id, { display: "ボブ" })).status).toBe(403);
  });

  test("(N-4) 作成と削除は今日どおり 403", async () => {
    await makeApp("declared");
    const alice = await register("alice");
    const created = await send(
      "POST",
      `/api/apps/${APP_ID}/tables/mem/records`,
      { account: "x", display: "x" },
      alice.cookie,
    );
    expect(created.status).toBe(403);
    const row = memRowOf(alice.id);
    const deleted = await send(
      "DELETE",
      `/api/apps/${APP_ID}/tables/mem/records/${row._id}`,
      undefined,
      alice.cookie,
      { "if-match": row._updated_at },
    );
    expect(deleted.status).toBe(403);
  });

  test("(N-5) 陰性対照: name を宣言していない名簿・自動登録の無いアプリでは、本人の更新も今日どおり 403", async () => {
    await makeApp("declared-no-name");
    const alice = await register("alice");
    expect((await patchMem(alice.cookie, alice.id, { display: "アリス" })).status).toBe(403);
    await rm(dataRoot as string, { recursive: true, force: true });
    await makeApp("undeclared");
    const bob = await register("bob");
    await ownerAddsMember(bob.id, "bob");
    expect((await patchMem(bob.cookie, bob.id, { display: "ボブ" })).status).toBe(403);
  });

  test("(N-6) MCP の update_record でも、本人は name 列だけを書ける", async () => {
    await makeApp("declared");
    const alice = await register("alice");
    const row = memRowOf(alice.id);
    const mcp = createMcpServer({
      dataRoot: dataRoot as string,
      previewBaseUrl: "http://localhost:3000",
      actor: "alice",
    });
    const client = new Client({ name: "t06", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), mcp.connect(b)]);
    try {
      const ok = (await client.callTool({
        name: "update_record",
        arguments: {
          app_id: APP_ID,
          table_id: "mem",
          record_id: row._id,
          if_match: row._updated_at,
          changes: { display: "アリス" },
        },
      })) as CallToolResult;
      expect(ok.isError === true, JSON.stringify(ok.content)).toBe(false);
      const after = memRowOf(alice.id);
      const ng = (await client.callTool({
        name: "update_record",
        arguments: {
          app_id: APP_ID,
          table_id: "mem",
          record_id: after._id,
          if_match: after._updated_at,
          changes: { note: "メモ" },
        },
      })) as CallToolResult;
      expect(ng.isError).toBe(true);
    } finally {
      await client.close();
      await mcp.close();
    }
    expect(rows("mem").find((row) => row.account === alice.id)?.display).toBe("アリス");
  });
});
