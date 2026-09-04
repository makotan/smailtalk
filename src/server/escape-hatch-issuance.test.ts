/**
 * 逃げ道(任意 CSS)の発行 UX の完了条件そのもの(V3-M5-T01 / ADR-0055 限定5・7・9)。
 *
 * **`src/server/capability-issuance.test.ts` と同型である。**同ファイルが
 * 「AI は申請のみ・発行は owner の HTTP のみ」を**経路の不在**で固定しているのと同じ形を、
 * 逃げ道の資産について張る:
 *
 * - MCP `request_custom_css` は `escape_hatch_asset_requests` に pending を作るだけで、
 *   **発行済み資産を1件も作らず、CSS のバイト列を1バイトも置かない**(完了条件2:
 *   申請だけでは見た目が1ピクセルも変わらない)。
 * - 資産を作れるのは owner の `POST /escape-hatch-assets` だけ(非 owner 403 / 未認証 401)。
 * - **「説明文にそう書いた」は担保ではない**(`src/mcp/tools/write.ts:1026`〜`:1029`)。
 *   担保は**経路の不在**であり、末尾の構造検査がソースの上でそれを固定する。
 *
 * 加えて ADR-0055 限定7(作用域を発行時に必須で受ける。**宣言を持たない発行を受理しない。
 * ワイルドカード全許可を既定にしない**)を HTTP 層で固定する。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  EscapeHatchStore,
  escapeHatchBodyExists,
  getEscapeHatchBody,
} from "../kernel/escape-hatch-store.ts";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { appEscapeHatchDir, appManifestPath } from "../kernel/storage-paths.ts";
import { createMcpServer } from "../mcp/server.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "bookshelf";
const CSS = ".gp-view .gp-list-table td { padding-block: 2px; }";

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
/** **【`V8-M31`】MCP の名乗り**に使う、このアプリに実在する利用者(`seedSession` の戻り)。 */
let mcpActor: ReturnType<typeof seedSession>;

function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "本棚",
      tables: [
        {
          id: "books",
          name: "本",
          fields: [{ id: "title", name: "タイトル", type: "text", required: true }],
        },
      ],
      views: [
        {
          id: "books-list",
          name: "本の一覧",
          type: "list_view",
          table: "books",
          columns: ["title"],
        },
      ],
    },
  };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-escape-hatch-issuance-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "本棚", { app_id: APP_ID });
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
  await rm(dataRoot, { recursive: true, force: true });
});

/** cookie + origin 付きリクエスト(capability-issuance.test.ts と同型)。 */
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

/** 発行済み資産を読む。 */
function listAssets() {
  const store = EscapeHatchStore.openForKernel(dataRoot);
  try {
    return store.listEscapeHatchAssets(APP_ID);
  } finally {
    store.close();
  }
}

/** 置かれた実体(CSS のバイト列)の名前一覧。ディレクトリごと無ければ空。 */
function bodyNames(): string[] {
  const dir = appEscapeHatchDir(dataRoot, APP_ID);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function sha256HexOf(text: string): string {
  return createHash("sha256").update(new TextEncoder().encode(text)).digest("hex");
}

// --- 発行(owner の HTTP ルート1本)------------------------------------------------------

test("owner が発行できる: 資産1件 + content-addressed な実体1つができ、digest が返る", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const res = await req(owner.cookie, "POST", `/api/apps/${APP_ID}/escape-hatch-assets`, {
    name: "compact-rows",
    css: CSS,
    scopeViews: ["books-list"],
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    asset: { id: string; name: string; digest: string; scopeViews: string[] };
  };
  expect(body.asset.name).toBe("compact-rows");
  expect(body.asset.digest).toBe(sha256HexOf(CSS));
  expect(body.asset.scopeViews).toEqual(["books-list"]);

  // 実体は content-addressed に1つだけ置かれ、中身は送った CSS と同一である。
  expect(bodyNames()).toEqual([body.asset.digest]);
  expect(getEscapeHatchBody(dataRoot, APP_ID, body.asset.digest)).toEqual(
    new TextEncoder().encode(CSS),
  );
  expect(listAssets()).toHaveLength(1);
});

test("限定9: 同じ CSS を別名で2回発行しても実体は1つ(de-dup。既存実体を上書きしない)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const first = await req(owner.cookie, "POST", `/api/apps/${APP_ID}/escape-hatch-assets`, {
    name: "a",
    css: CSS,
    scopeViews: ["books-list"],
  });
  expect(first.status).toBe(200);
  const digest = sha256HexOf(CSS);
  const before = statSync(join(appEscapeHatchDir(dataRoot, APP_ID), digest));

  const second = await req(owner.cookie, "POST", `/api/apps/${APP_ID}/escape-hatch-assets`, {
    name: "b",
    css: CSS,
    scopeViews: ["books-list"],
  });
  expect(second.status).toBe(200);
  const after = statSync(join(appEscapeHatchDir(dataRoot, APP_ID), digest));

  expect(bodyNames()).toEqual([digest]);
  expect(after.ino).toBe(before.ino);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(listAssets()).toHaveLength(2);
});

test("限定9: 同名で内容を差し替えても過去の版の実体が壊れない(2実体が並ぶ)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const oldCss = ".gp-view { --x: 1px; }";
  const newCss = ".gp-view { --x: 2px; }";
  for (const css of [oldCss, newCss]) {
    const res = await req(owner.cookie, "POST", `/api/apps/${APP_ID}/escape-hatch-assets`, {
      name: "same-name",
      css,
      scopeViews: ["books-list"],
    });
    expect(res.status).toBe(200);
  }
  expect(bodyNames()).toEqual([sha256HexOf(oldCss), sha256HexOf(newCss)].sort());
  expect(getEscapeHatchBody(dataRoot, APP_ID, sha256HexOf(oldCss))).toEqual(
    new TextEncoder().encode(oldCss),
  );
});

test("同一 name + 同一 CSS の二重発行は 409(UNIQUE)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const body = { name: "dup", css: CSS, scopeViews: ["books-list"] };
  expect(
    (await req(owner.cookie, "POST", `/api/apps/${APP_ID}/escape-hatch-assets`, body)).status,
  ).toBe(200);
  expect(
    (await req(owner.cookie, "POST", `/api/apps/${APP_ID}/escape-hatch-assets`, body)).status,
  ).toBe(409);
  expect(listAssets()).toHaveLength(1);
});

// --- 限定5: 発行は owner の HTTP だけ ---------------------------------------------------

test("POST /escape-hatch-assets は owner のみ: editor 403 / viewer 403 / 未認証 401、いずれも資産も実体も作らない", async () => {
  const editor = seedSession(dataRoot, APP_ID, { role: "editor" });
  const viewer = seedSession(dataRoot, APP_ID, { role: "viewer" });
  const body = { name: "compact", css: CSS, scopeViews: ["books-list"] };
  const path = `/api/apps/${APP_ID}/escape-hatch-assets`;

  expect((await req(editor.cookie, "POST", path, body)).status).toBe(403);
  expect((await req(viewer.cookie, "POST", path, body)).status).toBe(403);
  expect((await req(undefined, "POST", path, body)).status).toBe(401);

  // **どの拒否でも CSS は1バイトも置かれていない。**
  expect(listAssets()).toHaveLength(0);
  expect(bodyNames()).toEqual([]);
});

test("GET /escape-hatch-assets と /requests も owner のみ(viewer 403 / 未認証 401)", async () => {
  const viewer = seedSession(dataRoot, APP_ID, { role: "viewer" });
  const base = `/api/apps/${APP_ID}/escape-hatch-assets`;
  expect((await req(viewer.cookie, "GET", base)).status).toBe(403);
  expect((await req(undefined, "GET", base)).status).toBe(401);
  expect((await req(viewer.cookie, "GET", `${base}/requests`)).status).toBe(403);
  expect((await req(undefined, "GET", `${base}/requests`)).status).toBe(401);
});

test("Origin 不一致は 403(connections/* と同じ CSRF 検査が escape-hatch-assets/* にも掛かる)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const res = await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/escape-hatch-assets`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example.com",
        cookie: owner.cookie,
      },
      body: JSON.stringify({ name: "compact", css: CSS, scopeViews: ["books-list"] }),
    }),
  );
  expect(res.status).toBe(403);
  expect(listAssets()).toHaveLength(0);
  expect(bodyNames()).toEqual([]);
});

// --- 限定7: 作用域は発行時に必須。ワイルドカード全許可を既定にしない ---------------------

test("限定7: 宣言を持たない発行を受理しない(scopeViews 欠落 / 空配列 / '*' はすべて 400)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const path = `/api/apps/${APP_ID}/escape-hatch-assets`;

  // 欠落 —— **既定で全画面許可にフォールバックしない。**
  expect((await req(owner.cookie, "POST", path, { name: "a", css: CSS })).status).toBe(400);
  // 空配列 —— 宣言の形はあるが中身が無い。
  expect(
    (await req(owner.cookie, "POST", path, { name: "a", css: CSS, scopeViews: [] })).status,
  ).toBe(400);
  // ワイルドカード —— 全許可を書く手段を持たせない。
  expect(
    (await req(owner.cookie, "POST", path, { name: "a", css: CSS, scopeViews: ["*"] })).status,
  ).toBe(400);
  expect(
    (
      await req(owner.cookie, "POST", path, {
        name: "a",
        css: CSS,
        scopeViews: ["books-list", "*"],
      })
    ).status,
  ).toBe(400);
  expect(
    (await req(owner.cookie, "POST", path, { name: "a", css: CSS, scopeViews: "books-list" }))
      .status,
  ).toBe(400);

  // **1件も発行されず、CSS も1バイトも置かれない。**
  expect(listAssets()).toHaveLength(0);
  expect(bodyNames()).toEqual([]);
});

test("入力検証: name 空 / css 非文字列 / css 空 は 400(いずれも実体を置かない)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const path = `/api/apps/${APP_ID}/escape-hatch-assets`;
  expect(
    (await req(owner.cookie, "POST", path, { name: "", css: CSS, scopeViews: ["books-list"] }))
      .status,
  ).toBe(400);
  expect(
    (await req(owner.cookie, "POST", path, { name: "a", css: 123, scopeViews: ["books-list"] }))
      .status,
  ).toBe(400);
  expect(
    (await req(owner.cookie, "POST", path, { name: "a", css: "", scopeViews: ["books-list"] }))
      .status,
  ).toBe(400);
  expect(listAssets()).toHaveLength(0);
  expect(bodyNames()).toEqual([]);
});

// --- 失効(冪等。実体は壊さない)----------------------------------------------------------

test("完了条件5: 失効は冪等で、失効しても実体(過去の版)を壊さない", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const issued = await req(owner.cookie, "POST", `/api/apps/${APP_ID}/escape-hatch-assets`, {
    name: "compact",
    css: CSS,
    scopeViews: ["books-list"],
  });
  expect(issued.status).toBe(200);
  const asset = ((await issued.json()) as { asset: { id: string; digest: string } }).asset;

  const path = `/api/apps/${APP_ID}/escape-hatch-assets/${asset.id}`;
  expect((await req(owner.cookie, "DELETE", path)).status).toBe(200);
  // 2回目も 200(冪等。`DELETE /connections/:id` と同型)。
  expect((await req(owner.cookie, "DELETE", path)).status).toBe(200);
  expect(
    (await req(owner.cookie, "DELETE", `/api/apps/${APP_ID}/escape-hatch-assets/no-such-id`))
      .status,
  ).toBe(200);

  expect(listAssets()).toHaveLength(0);
  // **登録は消えたが実体は残る**(過去のスナップショットが参照する版を壊さない)。
  expect(escapeHatchBodyExists(dataRoot, APP_ID, asset.digest)).toBe(true);
});

test("失効も owner のみ(viewer 403 / 未認証 401。資産は消えない)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const issued = await req(owner.cookie, "POST", `/api/apps/${APP_ID}/escape-hatch-assets`, {
    name: "compact",
    css: CSS,
    scopeViews: ["books-list"],
  });
  const asset = ((await issued.json()) as { asset: { id: string } }).asset;
  const viewer = seedSession(dataRoot, APP_ID, { role: "viewer" });
  const path = `/api/apps/${APP_ID}/escape-hatch-assets/${asset.id}`;
  expect((await req(viewer.cookie, "DELETE", path)).status).toBe(403);
  expect((await req(undefined, "DELETE", path)).status).toBe(401);
  expect(listAssets()).toHaveLength(1);
});

// --- 申請 → 承認 → 発行の締め -------------------------------------------------------------

test("完了条件2: MCP request_custom_css は申請だけ —— 資産も CSS の実体もマニフェストも1バイトも変わらない", async () => {
  const manifestBefore = readFileSync(appManifestPath(dataRoot, APP_ID));

  await requestCustomCssViaMcp("compact", "一覧の行間を詰めたい", ["books-list"]);
  await requestCustomCssViaMcp("wide", "詳細を広く", []);

  // **見た目を決めるものが1つも動いていない**(申請だけでは1ピクセルも変わらない)。
  expect(readFileSync(appManifestPath(dataRoot, APP_ID))).toEqual(manifestBefore);
  expect(listAssets()).toHaveLength(0);
  expect(bodyNames()).toEqual([]);

  const store = EscapeHatchStore.openForKernel(dataRoot);
  try {
    expect(store.listPendingEscapeHatchAssetRequests(APP_ID)).toHaveLength(2);
  } finally {
    store.close();
  }
});

test("申請ライフサイクル: MCP で申請 → owner GET で見える → 発行(requestId)で pending から外れる", async () => {
  const requestId = await requestCustomCssViaMcp("compact", "行間を詰めたい", ["books-list"]);
  expect(listAssets()).toHaveLength(0);

  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const reqs = await req(owner.cookie, "GET", `/api/apps/${APP_ID}/escape-hatch-assets/requests`);
  expect(reqs.status).toBe(200);
  const reqBody = (await reqs.json()) as {
    requests: { id: string; requestedName: string; suggestedScopeViews: string[] }[];
  };
  expect(reqBody.requests.some((r) => r.id === requestId && r.requestedName === "compact")).toBe(
    true,
  );

  const issue = await req(owner.cookie, "POST", `/api/apps/${APP_ID}/escape-hatch-assets`, {
    name: "compact",
    css: CSS,
    scopeViews: ["books-list"],
    requestId,
  });
  expect(issue.status).toBe(200);

  const store = EscapeHatchStore.openForKernel(dataRoot);
  try {
    expect(store.listPendingEscapeHatchAssetRequests(APP_ID)).toHaveLength(0);
    expect(store.getEscapeHatchAssetRequest(requestId)?.status).toBe("approved");
    expect(store.listEscapeHatchAssets(APP_ID)).toHaveLength(1);
  } finally {
    store.close();
  }
});

test("owner の一覧は発行済み資産を返す(CSS のバイト列そのものは返さない —— 参照だけ)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  await req(owner.cookie, "POST", `/api/apps/${APP_ID}/escape-hatch-assets`, {
    name: "compact",
    css: CSS,
    scopeViews: ["books-list"],
  });
  const res = await req(owner.cookie, "GET", `/api/apps/${APP_ID}/escape-hatch-assets`);
  expect(res.status).toBe(200);
  const text = await res.text();
  const body = JSON.parse(text) as { assets: { name: string; digest: string }[] };
  expect(body.assets.map((a) => a.name)).toEqual(["compact"]);
  expect(body.assets[0]?.digest).toBe(sha256HexOf(CSS));
  // 一覧は参照(名前 + ダイジェスト + 作用域)であって本文ではない。
  expect(text).not.toContain("padding-block");
});

// --- **経路の不在**(担保。説明文ではない)-------------------------------------------------
//
// ADR-0055 限定5:「本体を書ける経路は owner の HTTP ルート1本だけ。MCP ツール /
// `apply_diff` / HTTP のデータ経路に1本も結線しない」。**「説明文にそう書いた」は担保では
// ない**(`src/mcp/tools/write.ts:1026`〜`:1029`)。ここでソースの上で経路の不在を固定する。

const SRC_ROOT = join(dirname(import.meta.dir));

/** `src/` 配下の非テスト .ts を列挙する。 */
function productionSources(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        files.push(full);
      }
    }
  };
  walk(SRC_ROOT);
  return files.sort();
}

/** 与えた識別子を含む製品コード(非テスト)のリポジトリ相対パス一覧。 */
function callersOf(identifier: string): string[] {
  return productionSources()
    .filter((file) => readFileSync(file, "utf-8").includes(identifier))
    .map((file) => relative(dirname(SRC_ROOT), file).replaceAll("\\", "/"))
    .sort();
}

test("限定5(経路の不在): CSS のバイト列を書ける製品コードは owner ルートと store 自身だけである", () => {
  // `putEscapeHatchBody`(実体を置く)を呼べる場所が2つしかない ——
  // 定義元(`src/kernel/escape-hatch-store.ts`)と owner の HTTP ルート
  // (`src/server/auth-routes.ts`)。**`src/mcp/` にも `apply-diff.ts` にも1件も無い。**
  expect(callersOf("putEscapeHatchBody")).toEqual([
    "src/kernel/escape-hatch-store.ts",
    "src/server/auth-routes.ts",
  ]);
});

test("限定5(経路の不在): 資産を発行できる製品コードは owner ルートと store 自身だけである", () => {
  expect(callersOf("issueEscapeHatchAsset")).toEqual([
    "src/kernel/escape-hatch-store.ts",
    "src/server/auth-routes.ts",
  ]);
});

test("限定5(経路の不在): src/mcp/ が触れる逃げ道の口は申請と承認記録だけである", () => {
  const mcpFiles = productionSources().filter((file) => file.includes(`${join("src", "mcp")}`));
  const mcpSource = mcpFiles.map((file) => readFileSync(file, "utf-8")).join("\n");
  // AI 側の口は「申請」1本だけ。
  expect(mcpSource).toContain("requestEscapeHatchAsset");
  // 発行・実体書込・失効のどれにも触れていない。
  for (const forbidden of [
    "issueEscapeHatchAsset",
    "putEscapeHatchBody",
    "deleteEscapeHatchAsset",
    "markEscapeHatchAssetRequest",
  ]) {
    expect(mcpSource).not.toContain(forbidden);
  }
});

/** in-memory MCP クライアントで request_custom_css を呼び、requestId を返す。 */
async function requestCustomCssViaMcp(
  name: string,
  purpose: string,
  views: string[],
): Promise<string> {
  const server = createMcpServer({
    dataRoot,
    previewBaseUrl: "http://127.0.0.1:3000",
    actor: mcpActor.username,
  });
  const client = new Client({ name: "escape-hatch-issuance-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = (await client.callTool({
      name: "request_custom_css",
      arguments: { app_id: APP_ID, name, purpose, views },
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
