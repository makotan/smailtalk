/**
 * **登録と役割の付与で、宣言した名簿へ自動で1行入る**(`V23-M1-T04`。単位 `SC-G1`。上位:
 * `docs/adr/0497-auto-enroll-and-last-row-admin.md` §Decision 1、
 * `docs/adr/0510-v23-m1-guard-authorization-and-pre-start-decisions.md` §Decision 3、
 * 計画 `docs/plan/v23/00-v23-plan.md` §4 の M1-A「振る舞い」の3)。
 *
 * - (a) `signup: open` の役割でセルフ登録した直後、名簿に1行あり、組織の表に行を作れる(受け入れ1)
 * - (b) 招待コードで専門家として登録した人に、名簿の行ができる(受け入れ2)
 * - (c) 運営が役割を配ったときに、行ができる
 * - (d) 対象外の役割では、行ができない
 * - (e) 既に行がある人には、増えない
 * - (f) 利用者の作成が失敗したら名簿の行も無く、名簿の行が書けなければ利用者も作られない
 * - (g) 宣言の無いアプリでは、名簿の行が1行も増えない(陰性対照。今日の 400 のまま)
 * - (h) 呼び出しは `auth-routes.ts` の3か所ちょうど
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
import { seedSession, TEST_ORIGIN } from "./test-helpers.ts";

const APP_ID = "scs";

const OWNER_RULES = [
  { target: "app", can: ["write"] },
  { target: "role", can: ["write"] },
  { target: "table", table: "orgs", can: ["read", "write", "delete"] },
  { target: "table", table: "mem", can: ["read", "write", "delete"] },
  { target: "table", table: "og", can: ["read", "write", "delete"] },
];
const WORKER_RULES = [
  { target: "table", table: "orgs", can: ["read", "write"] },
  { target: "table", table: "mem", can: ["read"] },
  { target: "table", table: "og", can: ["read", "write"] },
];

function scsManifest(options: {
  autoEnroll: boolean;
  requiredExtra?: boolean;
  // **【`V23-M12-T05`】省けば今日と1バイトも同じ**。 真なら会員と専門家に名簿の表への書込の規則を足す
  // (役割の層で止まらず、名簿の断りまで届くようにする)。
  memWrite?: boolean;
}): Manifest {
  const workerRules =
    options.memWrite === true
      ? [
          ...WORKER_RULES.filter((rule) => rule.table !== "mem"),
          { target: "table", table: "mem", can: ["read", "write", "delete"] },
        ]
      : WORKER_RULES;
  return {
    app: {
      id: APP_ID,
      name: "評価",
      tables: [
        {
          id: "orgs",
          name: "組織",
          fields: [{ id: "title", name: "名", type: "text" }],
          access_control: {
            enabled: true,
            permissions: [{ id: "keeper", name: "管理", read: true, write: true, delete: true }],
            creator_permission: "keeper",
            creatable_by_roles: ["member", "expert"],
            grant: { table: "og", target: "org", member: "member", permission: "permission" },
            members: {
              table: "mem",
              account: "account",
              ...(options.autoEnroll
                ? { auto_enroll: { roles: ["member", "expert"], name: "display" } }
                : {}),
            },
          },
        },
        {
          id: "mem",
          name: "名簿",
          fields: [
            { id: "account", name: "利用者", type: "text" },
            { id: "display", name: "表示名", type: "text" },
            ...(options.requiredExtra === true
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
      ],
      views: [],
      roles: [
        { id: "owner", name: "持ち主", rules: OWNER_RULES },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
        { id: "member", name: "会員", signup: "open", rules: workerRules },
        { id: "expert", name: "専門家", signup: "invite", rules: workerRules },
      ],
    },
  } as unknown as Manifest;
}

let dataRoot: string | undefined;
let server: ReturnType<typeof createServerApp>;
let ownerCookie = "";

async function makeApp(options: {
  autoEnroll: boolean;
  requiredExtra?: boolean;
  memWrite?: boolean;
}): Promise<void> {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-auto-enroll-"));
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, "評価", { app_id: APP_ID });
  } finally {
    meta.close();
  }
  const applied = applyManifest(dataRoot, APP_ID, scsManifest(options));
  if (!applied.valid) {
    throw new Error(JSON.stringify(applied.errors));
  }
  // 最初の1人(運営)を先に置く(登録する人が「最初の1人」にならないように)。
  ownerCookie = seedSession(dataRoot, APP_ID, { role: "owner", username: "owner1" }).cookie;
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
  cookie?: string,
): Promise<Response> {
  return await server.request(
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

async function selfRegister(username: string, userKind: string, code?: string): Promise<Response> {
  return await send("POST", `/api/apps/${APP_ID}/auth/signup/password/register`, {
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

function memRows(): { account: string; display: string | null }[] {
  const db = new Database(appDbPath(dataRoot as string, APP_ID), { readonly: true });
  try {
    return db
      .query<{ account: string; display: string | null }, []>(
        `SELECT "account", "display" FROM "mem" ORDER BY "rowid"`,
      )
      .all();
  } finally {
    db.close();
  }
}

function userId(username: string): string | undefined {
  const store = AuthStore.openForApp(dataRoot as string, APP_ID);
  try {
    return store.findUserByUsername(username)?.id;
  } finally {
    store.close();
  }
}

function countUsers(): number {
  const store = AuthStore.openForApp(dataRoot as string, APP_ID);
  try {
    return store.countUsers();
  } finally {
    store.close();
  }
}

function issueInvitation(username: string, role: string): string {
  const store = AuthStore.openForApp(dataRoot as string, APP_ID);
  try {
    return store.issueInvitation({ username, role: role as never, issuedBy: "owner1" }).code;
  } finally {
    store.close();
  }
}

describe("V23-M1-T04 登録と役割の付与で名簿に入る", () => {
  test("(a) signup: open の役割でセルフ登録した直後、名簿に1行あり、組織の表に行を作れる", async () => {
    await makeApp({ autoEnroll: true });
    const res = await selfRegister("alice", "member");
    expect(res.status, await res.clone().text()).toBe(200);
    expect(memRows()).toEqual([{ account: userId("alice") as string, display: "alice" }]);
    const created = await send(
      "POST",
      `/api/apps/${APP_ID}/tables/orgs/records`,
      { title: "A 社" },
      sessionCookie(res),
    );
    expect(created.status, await created.clone().text()).toBe(201);
  });

  test("(b) 招待コードで専門家として登録した人に、名簿の行ができる", async () => {
    await makeApp({ autoEnroll: true });
    const code = issueInvitation("bob", "expert");
    const res = await selfRegister("bob", "expert", code);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(memRows()).toEqual([{ account: userId("bob") as string, display: "bob" }]);
  });

  test("(c) 運営が役割を配ったときに、行ができる", async () => {
    await makeApp({ autoEnroll: true });
    const carol = seedSession(dataRoot as string, APP_ID, { role: "viewer", username: "carol" });
    expect(memRows()).toEqual([]);
    const res = await send(
      "PATCH",
      `/api/apps/${APP_ID}/auth/users/${carol.userId}`,
      { role: "member" },
      ownerCookie,
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect(memRows()).toEqual([{ account: carol.userId, display: "carol" }]);
  });

  test("(d) 対象外の役割では、行ができない", async () => {
    await makeApp({ autoEnroll: true });
    const carol = seedSession(dataRoot as string, APP_ID, { role: "viewer", username: "carol" });
    const res = await send(
      "PATCH",
      `/api/apps/${APP_ID}/auth/users/${carol.userId}`,
      { role: "editor" },
      ownerCookie,
    );
    expect(res.status).toBe(200);
    expect(memRows()).toEqual([]);
  });

  test("(e) 既に行がある人には、増えない", async () => {
    await makeApp({ autoEnroll: true });
    const res = await selfRegister("alice", "member");
    expect(res.status).toBe(200);
    const aliceId = userId("alice") as string;
    const again = await send(
      "PATCH",
      `/api/apps/${APP_ID}/auth/users/${aliceId}`,
      { roles: ["member", "expert"] },
      ownerCookie,
    );
    expect(again.status, await again.clone().text()).toBe(200);
    expect(memRows()).toEqual([{ account: aliceId, display: "alice" }]);
  });

  test("(f-1) 利用者の作成が失敗したら(名前の重複)、名簿の行も無い", async () => {
    await makeApp({ autoEnroll: true });
    expect((await selfRegister("alice", "member")).status).toBe(200);
    const before = memRows();
    const dup = await selfRegister("alice", "member");
    expect(dup.status).toBe(409);
    expect(memRows()).toEqual(before);
  });

  test("(f-2) 名簿の行が書けなければ、登録ごと断られ、利用者も作られない(同じトランザクション)", async () => {
    await makeApp({ autoEnroll: true, requiredExtra: true });
    const usersBefore = countUsers();
    const res = await selfRegister("alice", "member");
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: { path: string }[] };
    expect(body.errors.some((error) => error.path === "/org_code")).toBe(true);
    expect(countUsers()).toBe(usersBefore);
    expect(userId("alice")).toBeUndefined();
    expect(memRows()).toEqual([]);
  });

  test("(g) 陰性対照: 宣言の無いアプリでは、名簿の行が1行も増えず、組織は今日どおり作れない", async () => {
    await makeApp({ autoEnroll: false });
    const res = await selfRegister("alice", "member");
    expect(res.status).toBe(200);
    const carol = seedSession(dataRoot as string, APP_ID, { role: "viewer", username: "carol" });
    expect(
      (
        await send(
          "PATCH",
          `/api/apps/${APP_ID}/auth/users/${carol.userId}`,
          { role: "member" },
          ownerCookie,
        )
      ).status,
    ).toBe(200);
    expect(memRows()).toEqual([]);
    const created = await send(
      "POST",
      `/api/apps/${APP_ID}/tables/orgs/records`,
      { title: "A 社" },
      sessionCookie(res),
    );
    expect(created.status).toBe(400);
  });

  test("(h) 名簿へ入れる呼び出しは auth-routes.ts の3か所ちょうど(1関数)", () => {
    const live = readFileSync(join(import.meta.dir, "auth-routes.ts"), "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"));
    expect(live.filter((line) => line.includes("enrollIfDeclared(")).length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 【`V23-M12-T05`】断りの文 (5): 名簿(`D-V23-360`・`D-V23-407`)
// ---------------------------------------------------------------------------

const ROSTER_OWN_NAME =
  "参加者の表で書き換えられるのは、自分の行の名前だけです。ほかの欄と、ほかの人の行は、アプリの運営者だけが書き換えられます。";
const ROSTER_TODAY = "参加者の表は、アプリの運営者だけが書き換えられます。";
const ROSTER_HINT =
  "自分の所属や、自分のアカウントの結びつきを自分で書き換えることはできません(書き換えられると、他の人に配ってある権限を受け取れてしまうためです)。変更が必要なときは、アプリの運営者に頼んでください。";

function memRowOf(account: string): { id: string; version: string } {
  const db = new Database(appDbPath(dataRoot as string, APP_ID), { readonly: true });
  try {
    const row = db
      .query<{ _id: string; _updated_at: string }, [string]>(
        `SELECT "_id", "_updated_at" FROM "mem" WHERE "account" = ?`,
      )
      .get(account);
    if (row === null) throw new Error(`名簿の行が無い: ${account}`);
    return { id: row._id, version: row._updated_at };
  } finally {
    db.close();
  }
}

async function write(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  cookie: string,
  body?: unknown,
  version?: string,
): Promise<string> {
  const response = await server.request(
    new Request(`http://localhost/api/apps/${APP_ID}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        origin: TEST_ORIGIN,
        cookie,
        ...(version === undefined ? {} : { "if-match": version }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  if (response.status < 300) return String(response.status);
  const parsed = JSON.parse(text) as { errors?: { message?: string; hint?: string }[] };
  return `${response.status} ${parsed.errors?.[0]?.message} / ${parsed.errors?.[0]?.hint}`;
}

async function mcpCall(
  actor: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const mcp = createMcpServer({
    dataRoot: dataRoot as string,
    previewBaseUrl: "http://localhost:3000",
    actor,
  });
  const client = new Client({ name: "t05", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), mcp.connect(b)]);
  try {
    const result = (await client.callTool({
      name,
      arguments: { app_id: APP_ID, ...args },
    })) as CallToolResult;
    return { isError: result.isError === true, text: JSON.stringify(result.content) };
  } finally {
    await client.close();
    await mcp.close();
  }
}

describe("V23-M12-T05 D-V23-360・D-V23-407: 名簿の断りの文 (5)", () => {
  test("P2 D-V23-407: 名簿が本人の名前の欄を宣言していれば、本人の行のほかの欄・ほかの人の行・作成・削除の断りは新しい文(添える文は今日のまま)", async () => {
    await makeApp({ autoEnroll: true, memWrite: true });
    const alice = sessionCookie(await selfRegister("alice", "member"));
    expect((await selfRegister("bob", "member")).status).toBe(200);
    const own = memRowOf(userId("alice") as string);
    const other = memRowOf(userId("bob") as string);
    const refused = `403 ${ROSTER_OWN_NAME} / ${ROSTER_HINT}`;
    expect([
      await write("PATCH", `/tables/mem/records/${own.id}`, alice, { account: "x" }, own.version),
      await write(
        "PATCH",
        `/tables/mem/records/${other.id}`,
        alice,
        { display: "y" },
        other.version,
      ),
      await write("POST", "/tables/mem/records", alice, { account: "z", display: "z" }),
      await write("DELETE", `/tables/mem/records/${other.id}`, alice, undefined, other.version),
    ]).toEqual([refused, refused, refused, refused]);
    // 陽性対照: 本人の行の名前だけの書き換えは今日どおり通る。
    expect(
      await write("PATCH", `/tables/mem/records/${own.id}`, alice, { display: "あ" }, own.version),
    ).toBe("200");
  });

  test("P2 D-V23-360 (5): AI の口でも同じ文", async () => {
    await makeApp({ autoEnroll: true, memWrite: true });
    expect((await selfRegister("alice", "member")).status).toBe(200);
    expect((await selfRegister("bob", "member")).status).toBe(200);
    const other = memRowOf(userId("bob") as string);
    const result = await mcpCall("alice", "update_record", {
      table_id: "mem",
      record_id: other.id,
      if_match: other.version,
      changes: { display: "y" },
    });
    expect({ isError: result.isError, shown: result.text.includes(ROSTER_OWN_NAME) }).toEqual({
      isError: true,
      shown: true,
    });
  });

  test("N D-V23-360 (5): 名簿が名前の欄を宣言していなければ、断りは今日の文のまま", async () => {
    await makeApp({ autoEnroll: false, memWrite: true });
    const alice = sessionCookie(await selfRegister("alice", "member"));
    expect(
      await write("POST", "/tables/mem/records", alice, {
        account: userId("alice") as string,
        display: "a",
      }),
    ).toBe(`403 ${ROSTER_TODAY} / ${ROSTER_HINT}`);
  });
});
