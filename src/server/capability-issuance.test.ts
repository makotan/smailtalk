/**
 * capability の発行 UX の完了条件そのもの(V1-M4-T04 / ADR-0020 §2b・§5)。
 *
 * **承認前は動かない・承認後に動く**の両方を実証する。加えて、
 * **「AI は申請のみ・発行は owner の HTTP のみ」を経路の不在で固定する**:
 * - MCP `request_connection` は connection_requests に pending を作るだけで、connections を
 *   1件も作らない(発行ではない)。
 * - connection を作れるのは owner の `POST /connections` だけ(非 owner 403 / 未認証 401)。
 *
 * 発火はカーネル経路を直接叩く(`createRecord` → `runWorkflows` → runAction の call_external
 * 分岐)。配送は `dispatchOutbox(spyFetch)` を直接呼び、実ネットワークに触れない。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CapabilityStore } from "../kernel/capability-store.ts";
import {
  appDbPath,
  applyManifest,
  createApp,
  createRecord,
  KernelMetaStore,
  type Manifest,
  type Workflow,
} from "../kernel/index.ts";
import { dispatchOutbox } from "../kernel/outbox-dispatcher.ts";
import { createMcpServer } from "../mcp/server.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "notifier";
const SECRET_VAR = "ST_T04_SECRET";

/** 履歴テーブルの5列(規約どおり)。 */
function historyFields() {
  return [
    { id: "ran_at", name: "実行時刻", type: "date" as const },
    { id: "workflow", name: "ワークフロー", type: "text" as const },
    { id: "trigger_type", name: "きっかけ", type: "text" as const },
    { id: "status", name: "結果", type: "text" as const },
    { id: "error", name: "エラー", type: "long_text" as const },
  ];
}

/** books(トリガー元)+ wf-runs(履歴)を持つマニフェスト。 */
function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "通知アプリ",
      tables: [
        {
          id: "books",
          name: "本",
          fields: [{ id: "title", name: "タイトル", type: "text", required: true }],
        },
        { id: "wf-runs", name: "実行履歴", fields: historyFields() },
      ],
      views: [],
    },
  };
}

/** call_external を1本持つワークフロー(on_create × books)。 */
function callExternalWorkflow(): Workflow {
  return {
    id: "notify-external",
    name: "外部へ通知",
    trigger: { type: "on_create", table: "books" },
    actions: [
      {
        action: "call_external",
        connection: "api",
        destination: "https://api.example.com/x",
        payload: { title: "$record.title" },
      },
    ],
    history_table: "wf-runs",
  };
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
/** **【`V8-M31`】MCP の名乗り**に使う、このアプリに実在する利用者(`seedSession` の戻り)。 */
let mcpActor: ReturnType<typeof seedSession>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-capability-issuance-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "通知アプリ", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **【`V8-M26` / `V8-M28`】題材に既定3役割の規則を足す**(持ち主の
  // `{"target":"app","can":["write"]}` が無いと、名乗った持ち主でも MCP の申請を断られる)。
  expect(applyManifest(dataRoot, APP_ID, withDefaultRoleRules(baseManifest())).valid).toBe(true);
  app = createServerApp({ dataRoot });
  // **【`V8-M31`】MCP は名乗り(`actor`)を要る** —— このアプリに実在する利用者を1人置く。
  mcpActor = seedSession(dataRoot, APP_ID, { role: "owner", username: "mcp-actor" });
});

afterEach(async () => {
  delete process.env[SECRET_VAR];
  await rm(dataRoot, { recursive: true, force: true });
});

/** cookie + origin 付きリクエスト。 */
function req(
  cookie: string | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { origin: TEST_ORIGIN };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return Promise.resolve(app.request(new Request(`http://localhost${path}`, init)));
}

/**
 * books に1件作って on_create のワークフローを発火させる(カーネル経路を直接叩く)。
 *
 * 【V3-M13-T02 / ADR-0066 による期待値の更新】接続が未発行なら call_external は失敗し、
 * **発火元の書込ごと成立しない**(遮断そのものは1バイトも変わっていない)。
 * 発行の前後で成否が変わるので、**成否を呼び出し側に返して1件ずつ突き合わせる。**
 */
function fireWorkflow(title: string): boolean {
  const manifest = baseManifest();
  manifest.app.workflows = [callExternalWorkflow()];
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return createRecord(db, manifest, "books", { title }).ok;
  } finally {
    db.close();
  }
}

/** kernel.sqlite の pending outbox を読む。 */
function pendingOutbox() {
  const store = CapabilityStore.openForKernel(dataRoot);
  try {
    return store.listPendingOutbox();
  } finally {
    store.close();
  }
}

/** 発行済み connection を読む。 */
function listConnections() {
  const store = CapabilityStore.openForKernel(dataRoot);
  try {
    return store.listConnections(APP_ID);
  } finally {
    store.close();
  }
}

/** spyFetch(実ネットワークに触れない)。呼び出しを記録して 200 を返す。 */
function makeSpyFetch(): {
  fetch: typeof fetch;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

// --- 完了条件: 承認前は動かない / 承認後に動く ------------------------------------------

test("承認前後の対比: 発行前は送信されず、owner が発行した後にのみ送信される", async () => {
  const sentinel = `SENTINEL-${crypto.randomUUID()}`;

  // === 承認前 ===
  // connection を1本も発行しない状態でワークフローを発火する。
  // 発行前: call_external が遮断され、書込も成立しない(ADR-0066)。
  expect(fireWorkflow("承認前")).toBe(false);
  // 実行層(runCallExternal)が接続なしで遮断 → outbox に1件も積まれない。
  expect(pendingOutbox()).toHaveLength(0);

  // dispatchOutbox を呼んでも spyFetch は呼ばれない(送信は物理的に始まらない)。
  const before = makeSpyFetch();
  expect(await dispatchOutbox(dataRoot, before.fetch)).toEqual({ sent: 0, failed: 0 });
  expect(before.calls).toHaveLength(0);

  // === 承認(owner の HTTP 発行)===
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const issue = await req(owner.cookie, "POST", `/api/apps/${APP_ID}/connections`, {
    name: "api",
    allowedHosts: ["api.example.com"],
    secretSource: { kind: "env", value: SECRET_VAR },
  });
  expect(issue.status).toBe(200);
  const issued = (await issue.json()) as {
    connection: { id: string; name: string; allowedHosts: string[]; secretSource: unknown };
  };
  expect(issued.connection.name).toBe("api");
  expect(issued.connection.allowedHosts).toEqual(["api.example.com"]);
  // secretSource は取得元の参照(値ではない)。secret の解決値は返らない。
  expect(issued.connection.secretSource).toEqual({ kind: "env", value: SECRET_VAR });

  // === 承認後 ===
  process.env[SECRET_VAR] = sentinel;
  // 発行後: 送信予約が積まれ、書込も成立する。
  expect(fireWorkflow("承認後")).toBe(true);
  const pending = pendingOutbox();
  expect(pending).toHaveLength(1);
  expect(pending[0]?.destination).toBe("https://api.example.com/x");
  expect(pending[0]?.payload).toEqual({ title: "承認後" });

  const after = makeSpyFetch();
  expect(await dispatchOutbox(dataRoot, after.fetch)).toEqual({ sent: 1, failed: 0 });
  expect(after.calls).toHaveLength(1);
  expect(after.calls[0]?.url).toBe("https://api.example.com/x");
  const headers = after.calls[0]?.init?.headers as Record<string, string>;
  expect(headers.authorization).toBe(`Bearer ${sentinel}`);
  expect(headers["content-type"]).toBe("application/json");
  expect(after.calls[0]?.init?.body).toBe(JSON.stringify({ title: "承認後" }));

  // 配送済み = pending から外れている。
  expect(pendingOutbox()).toHaveLength(0);
});

// --- owner ルートの認可(発行は owner の HTTP のみ)-------------------------------------

test("POST /connections は owner のみ: editor 403 / viewer 403 / 未認証 401、いずれも connection を作らない", async () => {
  const editor = seedSession(dataRoot, APP_ID, { role: "editor" });
  const viewer = seedSession(dataRoot, APP_ID, { role: "viewer" });
  const body = {
    name: "api",
    allowedHosts: ["api.example.com"],
    secretSource: { kind: "env", value: SECRET_VAR },
  };

  expect((await req(editor.cookie, "POST", `/api/apps/${APP_ID}/connections`, body)).status).toBe(
    403,
  );
  expect((await req(viewer.cookie, "POST", `/api/apps/${APP_ID}/connections`, body)).status).toBe(
    403,
  );
  expect((await req(undefined, "POST", `/api/apps/${APP_ID}/connections`, body)).status).toBe(401);

  // どの拒否でも connection は1件も作られていない。
  expect(listConnections()).toHaveLength(0);
});

test("GET /connections と /connections/requests も owner のみ(viewer 403 / 未認証 401)", async () => {
  const viewer = seedSession(dataRoot, APP_ID, { role: "viewer" });
  expect((await req(viewer.cookie, "GET", `/api/apps/${APP_ID}/connections`)).status).toBe(403);
  expect((await req(undefined, "GET", `/api/apps/${APP_ID}/connections`)).status).toBe(401);
  expect((await req(viewer.cookie, "GET", `/api/apps/${APP_ID}/connections/requests`)).status).toBe(
    403,
  );
  expect((await req(undefined, "GET", `/api/apps/${APP_ID}/connections/requests`)).status).toBe(
    401,
  );
});

test("Origin 不一致は 403(auth/* と同じ CSRF 検査が connections/* にも掛かる)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const res = await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/connections`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example.com",
        cookie: owner.cookie,
      },
      body: JSON.stringify({
        name: "api",
        allowedHosts: [],
        secretSource: { kind: "env", value: SECRET_VAR },
      }),
    }),
  );
  expect(res.status).toBe(403);
  expect(listConnections()).toHaveLength(0);
});

test("入力検証: name 空 / allowedHosts 非配列 / secretSource.kind 不正 は 400", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const base = `/api/apps/${APP_ID}/connections`;
  expect(
    (
      await req(owner.cookie, "POST", base, {
        name: "",
        allowedHosts: [],
        secretSource: { kind: "env", value: SECRET_VAR },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await req(owner.cookie, "POST", base, {
        name: "api",
        allowedHosts: "not-an-array",
        secretSource: { kind: "env", value: SECRET_VAR },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await req(owner.cookie, "POST", base, {
        name: "api",
        allowedHosts: [],
        secretSource: { kind: "bogus", value: "x" },
      })
    ).status,
  ).toBe(400);
  expect(listConnections()).toHaveLength(0);
});

// --- 申請 → 承認 → 発行の締め -----------------------------------------------------------

test("申請ライフサイクル: MCP で申請 → owner GET で見える → 発行(requestId)で申請が pending から外れる", async () => {
  // MCP `request_connection` で申請を出す(AI の役)。
  const requestId = await requestConnectionViaMcp("api", "外部へ通知したい", ["api.example.com"]);

  // **発行はされていない**(connections は0件)。申請だけができた。
  expect(listConnections()).toHaveLength(0);
  const capBefore = CapabilityStore.openForKernel(dataRoot);
  try {
    expect(capBefore.listPendingRequests(APP_ID).map((r) => r.id)).toContain(requestId);
  } finally {
    capBefore.close();
  }

  // owner が申請一覧を見る。
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const reqs = await req(owner.cookie, "GET", `/api/apps/${APP_ID}/connections/requests`);
  expect(reqs.status).toBe(200);
  const reqBody = (await reqs.json()) as { requests: { id: string; requestedName: string }[] };
  expect(reqBody.requests.some((r) => r.id === requestId && r.requestedName === "api")).toBe(true);

  // owner が発行する(requestId を添えて締める)。
  const issue = await req(owner.cookie, "POST", `/api/apps/${APP_ID}/connections`, {
    name: "api",
    allowedHosts: ["api.example.com"],
    secretSource: { kind: "env", value: SECRET_VAR },
    requestId,
  });
  expect(issue.status).toBe(200);

  // 申請は pending から外れ、connection が1件できた。
  const capAfter = CapabilityStore.openForKernel(dataRoot);
  try {
    expect(capAfter.listPendingRequests(APP_ID)).toHaveLength(0);
    expect(capAfter.getRequest(requestId)?.status).toBe("approved");
    expect(capAfter.listConnections(APP_ID)).toHaveLength(1);
  } finally {
    capAfter.close();
  }
});

test("MCP request_connection は connection を作れない(申請だけで connections は0件のまま)", async () => {
  await requestConnectionViaMcp("api", "x", ["api.example.com"]);
  await requestConnectionViaMcp("api2", "y", []);
  // 申請は2件でも、発行(connections)は0件。
  expect(listConnections()).toHaveLength(0);
  const cap = CapabilityStore.openForKernel(dataRoot);
  try {
    expect(cap.listPendingRequests(APP_ID)).toHaveLength(2);
  } finally {
    cap.close();
  }
});

/** in-memory MCP クライアントで request_connection を呼び、requestId を返す。 */
async function requestConnectionViaMcp(
  name: string,
  purpose: string,
  hosts: string[],
): Promise<string> {
  const server = createMcpServer({
    dataRoot,
    previewBaseUrl: "http://127.0.0.1:3000",
    actor: mcpActor.username,
  });
  const client = new Client({ name: "issuance-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = (await client.callTool({
      name: "request_connection",
      arguments: { app_id: APP_ID, name, purpose, hosts },
    })) as { isError?: boolean; structuredContent?: { requestId?: string } };
    expect(result.isError ?? false).toBe(false);
    const requestId = result.structuredContent?.requestId;
    expect(typeof requestId).toBe("string");
    return requestId as string;
  } finally {
    await client.close();
    await server.close();
  }
}
