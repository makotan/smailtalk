/**
 * AI capability の発行 UX の完了条件(V1-M5-T04 / ADR-0021 §2b・§5)。
 *
 * `capability-issuance.test.ts`(接続)の兄弟。**「AI は申請のみ・発行と上限変更は owner の
 * HTTP のみ」を経路の不在で固定する**:
 * - MCP `request_ai_capability` は ai_requests に pending を作るだけで、ai_capabilities を
 *   1件も作らない(発行ではない)。
 * - capability を作れるのは owner の `POST /ai-capabilities` だけ(非 owner 403 / 未認証 401)。
 * - 上限を変えられるのは owner の `PATCH .../limit` だけ(§5「上限は人間のみ変更可能」)。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AiCapabilityStore } from "../kernel/ai-capability-store.ts";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createMcpServer } from "../mcp/server.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "ai-issuer";

function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "AI 発行テスト",
      tables: [
        {
          id: "tickets",
          name: "問い合わせ",
          fields: [{ id: "text", name: "本文", type: "text", required: true }],
        },
      ],
      views: [],
    },
  };
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
/** **【`V8-M31`】MCP の名乗り**に使う、このアプリに実在する利用者(`seedSession` の戻り)。 */
let mcpActor: ReturnType<typeof seedSession>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-ai-issuance-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "AI 発行テスト", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **【`V8-M26` / `V8-M28`】題材に既定3役割の規則を足す**(持ち主の
  // `{"target":"app","can":["write"]}` が無いと、名乗った持ち主でも申請を断られる)。
  // **測っているのは「AI は申請しかできない」であって、面の既定ではない。**
  expect(applyManifest(dataRoot, APP_ID, withDefaultRoleRules(baseManifest())).valid).toBe(true);
  app = createServerApp({ dataRoot });
  // **【`V8-M31`】MCP は名乗り(`actor`)を要る** —— このアプリに実在する利用者を1人置く。
  mcpActor = seedSession(dataRoot, APP_ID, { role: "owner", username: "mcp-actor" });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

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

function listCapabilities() {
  const store = AiCapabilityStore.openForKernel(dataRoot);
  try {
    return store.listCapabilities(APP_ID);
  } finally {
    store.close();
  }
}

test("POST /ai-capabilities は owner のみ: editor 403 / viewer 403 / 未認証 401、いずれも作らない", async () => {
  const editor = seedSession(dataRoot, APP_ID, { role: "editor" });
  const viewer = seedSession(dataRoot, APP_ID, { role: "viewer" });
  const body = {
    name: "classifier",
    provider: "claude_cli",
    model: "claude-opus-4-8",
    maxCallsPerDay: 100,
    maxCostUsdPerDay: 5,
  };
  const base = `/api/apps/${APP_ID}/ai-capabilities`;
  expect((await req(editor.cookie, "POST", base, body)).status).toBe(403);
  expect((await req(viewer.cookie, "POST", base, body)).status).toBe(403);
  expect((await req(undefined, "POST", base, body)).status).toBe(401);
  expect(listCapabilities()).toHaveLength(0);
});

test("owner は claude_cli の capability を上限つきで発行できる(secret 不要)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const res = await req(owner.cookie, "POST", `/api/apps/${APP_ID}/ai-capabilities`, {
    name: "classifier",
    provider: "claude_cli",
    model: "claude-opus-4-8",
    maxCallsPerDay: 100,
    maxCostUsdPerDay: 5,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    capability: { name: string; provider: string; maxCallsPerDay: number; secretSource: unknown };
  };
  expect(body.capability.provider).toBe("claude_cli");
  expect(body.capability.maxCallsPerDay).toBe(100);
  expect(body.capability.secretSource).toBeNull();
  expect(listCapabilities()).toHaveLength(1);
});

test("openai_compatible は base_url + secretSource 必須(欠けると 400)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const base = `/api/apps/${APP_ID}/ai-capabilities`;
  // base_url も secretSource も無い → 400。
  expect(
    (
      await req(owner.cookie, "POST", base, {
        name: "or",
        provider: "openai_compatible",
        model: "openai/gpt-4o-mini",
        maxCallsPerDay: 10,
        maxCostUsdPerDay: 1,
      })
    ).status,
  ).toBe(400);
  // 揃えれば発行できる。secretSource は取得元の参照(値ではない)。
  const ok = await req(owner.cookie, "POST", base, {
    name: "or",
    provider: "openai_compatible",
    model: "openai/gpt-4o-mini",
    baseUrl: "https://openrouter.ai/api/v1",
    secretSource: { kind: "env", value: "OPENROUTER_API_KEY" },
    maxCallsPerDay: 10,
    maxCostUsdPerDay: 1,
  });
  expect(ok.status).toBe(200);
  const body = (await ok.json()) as { capability: { secretSource: unknown } };
  expect(body.capability.secretSource).toEqual({ kind: "env", value: "OPENROUTER_API_KEY" });
});

test("上限は owner のみ変更できる(§5): PATCH は viewer 403、owner なら反映される", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const viewer = seedSession(dataRoot, APP_ID, { role: "viewer" });
  const issue = await req(owner.cookie, "POST", `/api/apps/${APP_ID}/ai-capabilities`, {
    name: "classifier",
    provider: "claude_cli",
    model: "claude-opus-4-8",
    maxCallsPerDay: 100,
    maxCostUsdPerDay: 5,
  });
  const capId = ((await issue.json()) as { capability: { id: string } }).capability.id;
  const limitPath = `/api/apps/${APP_ID}/ai-capabilities/${capId}/limit`;

  // viewer は変更できない。
  expect(
    (await req(viewer.cookie, "PATCH", limitPath, { maxCallsPerDay: 9999, maxCostUsdPerDay: 999 }))
      .status,
  ).toBe(403);

  // owner は変更できる。
  const patched = await req(owner.cookie, "PATCH", limitPath, {
    maxCallsPerDay: 3,
    maxCostUsdPerDay: 0.5,
  });
  expect(patched.status).toBe(200);
  expect(listCapabilities()[0]?.limit.maxCallsPerDay).toBe(3);
});

test("申請ライフサイクル: MCP で申請 → owner で発行(requestId)→ 申請が pending から外れる", async () => {
  const requestId = await requestViaMcp("classifier", "入力文を自動分類したい");
  // 発行はされていない(capabilities は0件)。申請だけができた。
  expect(listCapabilities()).toHaveLength(0);

  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const reqs = await req(owner.cookie, "GET", `/api/apps/${APP_ID}/ai-capabilities/requests`);
  const reqBody = (await reqs.json()) as { requests: { id: string; requestedName: string }[] };
  expect(reqBody.requests.some((r) => r.id === requestId)).toBe(true);

  const issue = await req(owner.cookie, "POST", `/api/apps/${APP_ID}/ai-capabilities`, {
    name: "classifier",
    provider: "claude_cli",
    model: "claude-opus-4-8",
    maxCallsPerDay: 100,
    maxCostUsdPerDay: 5,
    requestId,
  });
  expect(issue.status).toBe(200);

  const store = AiCapabilityStore.openForKernel(dataRoot);
  try {
    expect(store.listPendingRequests(APP_ID)).toHaveLength(0);
    expect(store.getRequest(requestId)?.status).toBe("approved");
    expect(store.listCapabilities(APP_ID)).toHaveLength(1);
  } finally {
    store.close();
  }
});

test("MCP request_ai_capability は capability を作れない(申請だけで capabilities は0件のまま)", async () => {
  await requestViaMcp("a", "x");
  await requestViaMcp("b", "y");
  expect(listCapabilities()).toHaveLength(0);
  const store = AiCapabilityStore.openForKernel(dataRoot);
  try {
    expect(store.listPendingRequests(APP_ID)).toHaveLength(2);
  } finally {
    store.close();
  }
});

async function requestViaMcp(name: string, purpose: string): Promise<string> {
  const server = createMcpServer({
    dataRoot,
    previewBaseUrl: "http://127.0.0.1:3000",
    actor: mcpActor.username,
  });
  const client = new Client({ name: "ai-issuance-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = (await client.callTool({
      name: "request_ai_capability",
      arguments: { app_id: APP_ID, name, purpose },
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
