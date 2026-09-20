/**
 * **`V17-M5-T04`(`AC-G17` + `AC-G18`)—— 行ごとにアクセス権を配っている表を
 * 条件なしで扱う役割の規則を、適用の応答で知らせることの検査。**
 *
 * 台帳(`docs/adr/0007-vocabulary-governance.md` §8)の `AC-G17`(`:1843`)と
 * `AC-G18`(`:1844`)、ユーザ決定 `D-V16-6`(「**今の動きは変えず、設定した人に警告を出す**」)、
 * および `docs/plan/v17/06-v17-m5-plan.md` §2b の 4 / §3-4 が仕様である。
 *
 * ## この検査が固定すること(**§2b の 4 の5項 + ユーザ決定 `D3`**)
 *
 * 1. **HTTP(`POST /diffs`)の応答の `role_condition_notices` に1件載ること。**
 * 2. **MCP(`apply_diff`)の応答にも**同じ1件**が載ること**(**同じ `kind` / `role` / `path`**)——
 *    **`AC-G17` の限定の逐語「同じ配列を HTTP と MCP の両方に出す。片側だけに出さない。」**
 * 3. **適用は今日どおり成立すること**(HTTP は 201 / MCP は `isError` でない / `valid` は真)——
 *    **拒否にしない**(`AC-G18` の限定。`src/kernel/types.ts` の「**拒否ではない。**」)。
 * 4. **陰性対照**: **`access_control` を宣言していない表**への条件なしの規則には知らせが出ない。
 * 5. **陰性対照2**: 既存の `never_matches` / `always_matches` の知らせが同じ形で出る。
 * 6. **ユーザ決定 `D3`(2026-09-08)の履行**: **役割 `owner` の規則には知らせを出さない。**
 *
 * ## この検査が固定していないこと(**誇張しない**)
 *
 * - **ふるまいを1ミリも変えていない** —— **知らせが出ても、行の読取・書込・削除の答えは
 *   今日どおりである。** **面と点の合成の式(`combineRoleAndGrantAccess`)は1バイトも
 *   動いていない。** **本ファイルは合成の答えを1件も測っていない。**
 * - **`AC-G17` の「危ない役割規則」の全量を定義していない** —— **知らせるのは
 *   `AC-G18` の1形(条件なし × 行ごとの付与を宣言した表)だけである。**
 * - **【穴。名指しで残す】** **役割 `owner` の規則は着手後も1件も知らされない**
 *   (ユーザ決定 `D3`)。**実地のアプリでこの形に当たる3件はすべて `owner` であり、
 *   したがって実地では1件も知らされない。** **「塞いだ」とは1文字も書いていない。**
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createMcpServer } from "../mcp/server.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN } from "./test-helpers.ts";

/** HTTP 側の題材アプリ。 */
const HTTP_APP_ID = "grants-bypassed-http";
/** MCP 側の題材アプリ(**同じ土台から始めるため、別アプリにしてある**)。 */
const MCP_APP_ID = "grants-bypassed-mcp";
/** MCP の名乗り(`V8-M31`。名乗りが無いと更新系がすべて `isError` になる)。 */
const ACTOR = "grants-bypassed-actor";

const PERMISSIONS = [
  { id: "keeper", name: "管理", read: true, write: true, delete: true },
  { id: "reader", name: "閲覧", read: true, write: false, delete: false },
];

/**
 * 題材の表は2つである。
 *
 * - **`orders`** … **`access_control` を `enabled: true` で宣言している**(点が立っている表)。
 * - **`plain`** … **宣言していない**(陰性対照)。
 */
function manifest(appId: string): Manifest {
  return {
    app: {
      id: appId,
      name: "点の店",
      tables: [
        {
          id: "orders",
          name: "注文",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "status", name: "状態", type: "text" },
          ],
          access_control: {
            enabled: true,
            permissions: PERMISSIONS,
            creator_permission: "keeper",
            grant: {
              table: "order_grant",
              target: "order",
              member: "member",
              permission: "permission",
            },
            members: { table: "book_member", account: "account" },
          },
        },
        {
          id: "plain",
          name: "掲示",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "status", name: "状態", type: "text" },
          ],
        },
        {
          id: "book_member",
          name: "参加者",
          fields: [{ id: "account", name: "アカウント", type: "text" }],
        },
        {
          id: "order_grant",
          name: "付与",
          fields: [
            { id: "order", name: "注文", type: "reference", reference_table: "orders" },
            { id: "member", name: "人", type: "reference", reference_table: "book_member" },
            { id: "permission", name: "権限", type: "select", options: ["keeper", "reader"] },
          ],
        },
      ],
      views: [],
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
          ],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
    },
  } as unknown as Manifest;
}

/**
 * **知らせが出るべき役割の並び。**
 *
 * - `roles[0]` = `owner` … **`orders` を条件なしで全部できる規則を `rules[2]` に持つ** ——
 *   **ユーザ決定 `D3` により、これは知らせない。**
 * - `roles[1]` = `editor` … **`plain`(宣言していない表)を条件なしで読む** —— **知らせない。**
 * - `roles[2]` = `viewer` … 規則なし。
 * - `roles[3]` = `member` … **`orders` を条件なしで読む** —— **これだけが知らせに載る。**
 */
const ROLES_WITH_BYPASS = [
  {
    id: "owner",
    name: "持ち主",
    rules: [
      { target: "app", can: ["write"] },
      { target: "role", can: ["write"] },
      { target: "table", table: "orders", can: ["read", "write", "delete"] },
    ],
  },
  {
    id: "editor",
    name: "編集者",
    rules: [{ target: "table", table: "plain", can: ["read"] }],
  },
  { id: "viewer", name: "閲覧者" },
  {
    id: "member",
    name: "会員",
    rules: [{ target: "table", table: "orders", can: ["read"] }],
  },
];

/** 陰性対照2 —— **誰も通さない条件**(既存の `never_matches`)。 */
const ROLES_WITH_NEVER = [
  {
    id: "owner",
    name: "持ち主",
    rules: [
      { target: "app", can: ["write"] },
      { target: "role", can: ["write"] },
    ],
  },
  { id: "editor", name: "編集者" },
  { id: "viewer", name: "閲覧者" },
  {
    id: "member",
    name: "会員",
    rules: [
      {
        target: "table",
        table: "plain",
        can: ["read"],
        when: {
          and: [
            { field: "status", equals: "A" },
            { field: "status", equals: "B" },
          ],
        },
      },
    ],
  },
];

/** 陰性対照 —— **宣言していない表だけを条件なしで扱う**(知らせは1件も出ない)。 */
const ROLES_WITHOUT_BYPASS = [
  {
    id: "owner",
    name: "持ち主",
    rules: [
      { target: "app", can: ["write"] },
      { target: "role", can: ["write"] },
    ],
  },
  {
    id: "editor",
    name: "編集者",
    rules: [{ target: "table", table: "plain", can: ["read"] }],
  },
  { id: "viewer", name: "閲覧者" },
  {
    id: "member",
    name: "会員",
    rules: [{ target: "table", table: "plain", can: ["read", "write"] }],
  },
];

function setRolesDiff(diffId: string, roles: unknown): Record<string, unknown> {
  return {
    diff_id: diffId,
    intent: "役割の規則を置く",
    operations: [{ op: "set_roles", roles }],
  };
}

type NoticeShape = { kind: string; role: string; path: string; message: string; hint: string };

let dataRoot: string | undefined;
let app: ReturnType<typeof createServerApp> | undefined;
let ownerCookie: string | undefined;

async function boot(): Promise<void> {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-grants-bypassed-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "点の店(HTTP)", { app_id: HTTP_APP_ID });
    createApp(store, "点の店(MCP)", { app_id: MCP_APP_ID });
  } finally {
    store.close();
  }
  for (const appId of [HTTP_APP_ID, MCP_APP_ID]) {
    const applied = applyManifest(dataRoot, appId, manifest(appId));
    expect(applied.valid).toBe(true);
  }
  ownerCookie = seedSession(dataRoot, HTTP_APP_ID, { username: "http-owner" }).cookie;
  seedSession(dataRoot, MCP_APP_ID, { username: ACTOR });
  app = createServerApp({ dataRoot });
}

afterEach(async () => {
  if (dataRoot !== undefined) {
    await rm(dataRoot, { recursive: true, force: true });
    dataRoot = undefined;
    app = undefined;
    ownerCookie = undefined;
  }
});

/** HTTP の `POST /diffs` を打ち、`change.role_condition_notices` を返す。 */
type AppliedManifest = {
  app: { roles: { id: string; rules?: { table?: string; when?: unknown }[] }[] };
};

async function postDiff(
  diff: Record<string, unknown>,
): Promise<{ status: number; notices: NoticeShape[]; manifest?: AppliedManifest }> {
  const res = await (app as ReturnType<typeof createServerApp>).request(
    `http://localhost/api/apps/${HTTP_APP_ID}/diffs`,
    {
      method: "POST",
      headers: {
        origin: TEST_ORIGIN,
        cookie: ownerCookie as string,
        "content-type": "application/json",
      },
      body: JSON.stringify(diff),
    },
  );
  if (res.status !== 201) {
    return { status: res.status, notices: [] };
  }
  const body = (await res.json()) as {
    change: { role_condition_notices: NoticeShape[]; manifest: AppliedManifest };
  };
  return {
    status: res.status,
    notices: body.change.role_condition_notices,
    manifest: body.change.manifest,
  };
}

/** MCP の `apply_diff` を in-process の `Client` 経由で打つ(`write.test.ts` と同じ作法)。 */
async function callApplyDiff(diff: Record<string, unknown>): Promise<CallToolResult> {
  const server = createMcpServer({
    dataRoot: dataRoot as string,
    previewBaseUrl: "http://localhost:3000",
    actor: ACTOR,
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return (await client.callTool({
      name: "apply_diff",
      arguments: { app_id: MCP_APP_ID, diff },
    })) as CallToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

function mcpNotices(result: CallToolResult): NoticeShape[] {
  expect(result.isError).toBeFalsy();
  const data = result.structuredContent as Record<string, unknown>;
  return data.role_condition_notices as NoticeShape[];
}

// ---------------------------------------------------------------------------
// (1)(2)(3) HTTP と MCP に同じ1件が載り、適用は成立する
// ---------------------------------------------------------------------------

test("(1) HTTP と MCP の応答に同じ1件が載る(`AC-G17` / `AC-G18`。拒否ではない)", async () => {
  await boot();

  // **(a) HTTP(`POST /diffs`)** —— **201 で適用は通る。知らせるだけ。**
  const http = await postDiff(setRolesDiff("d-http", ROLES_WITH_BYPASS));
  expect(http.status).toBe(201);
  expect(http.notices).toHaveLength(1);
  expect(http.notices[0]?.kind).toBe("grants_bypassed");
  expect(http.notices[0]?.role).toBe("member");
  // **`/when` を付けない** —— **`when` が無い規則なので、指し先が存在しないからである。**
  expect(http.notices[0]?.path).toBe("/app/roles/3/rules/0");

  // **(b) MCP(`apply_diff`)** —— **`isError` にしない。**
  const mcp = mcpNotices(await callApplyDiff(setRolesDiff("d-mcp", ROLES_WITH_BYPASS)));
  expect(mcp).toHaveLength(1);

  // **(c) 同じ1件である** —— **`kind` / `role` / `path` / `message` / `hint` の全量が一致する。**
  expect(mcp[0]).toEqual(http.notices[0] as NoticeShape);
});

test("(3) 適用は今日どおり成立する —— 置いた規則が適用後のマニフェストに残っている", async () => {
  await boot();
  const applied = await postDiff(setRolesDiff("d-applied", ROLES_WITH_BYPASS));
  expect(applied.status).toBe(201);
  const member = applied.manifest?.app.roles.find((role) => role.id === "member");
  expect(member?.rules?.[0]?.table).toBe("orders");
  // **知らせは条件を1つも補わない** —— **`AC-G33` の補完とは別のものである。**
  expect(member?.rules?.[0]?.when).toBeUndefined();
});

// ---------------------------------------------------------------------------
// (4) 陰性対照 —— 宣言していない表には出ない
// ---------------------------------------------------------------------------

test("(4) `access_control` を宣言していない表への条件なしの規則には知らせが出ない", async () => {
  await boot();
  const http = await postDiff(setRolesDiff("d-plain", ROLES_WITHOUT_BYPASS));
  expect(http.status).toBe(201);
  expect(http.notices).toEqual([]);

  const mcp = mcpNotices(await callApplyDiff(setRolesDiff("d-plain-mcp", ROLES_WITHOUT_BYPASS)));
  expect(mcp).toEqual([]);
});

// ---------------------------------------------------------------------------
// (5) 陰性対照2 —— 既存2種は同じ形で出る
// ---------------------------------------------------------------------------

test("(5) 既存の `never_matches` の知らせが、着手後も同じ形で出る", async () => {
  await boot();
  const http = await postDiff(setRolesDiff("d-never", ROLES_WITH_NEVER));
  expect(http.status).toBe(201);
  expect(http.notices.map((notice) => notice.kind)).toEqual(["never_matches"]);
  // **既存2種の `path` は `/when` 付きのままである**(3種目だけが形が違う)。
  expect(http.notices[0]?.path).toBe("/app/roles/3/rules/0/when");
});

// ---------------------------------------------------------------------------
// (6) ユーザ決定 `D3` —— 運営者には出さない(**穴として名指しで固定する**)
// ---------------------------------------------------------------------------

test("(6) 役割 `owner` の条件なしの規則には知らせを出さない(ユーザ決定 `D3`。**穴**)", async () => {
  await boot();
  // **`owner` だけが `orders` を条件なしで扱う題材** —— **知らせは1件も出ない。**
  const onlyOwner = [
    {
      id: "owner",
      name: "持ち主",
      rules: [
        { target: "app", can: ["write"] },
        { target: "role", can: ["write"] },
        { target: "table", table: "orders", can: ["read", "write", "delete"] },
      ],
    },
    { id: "editor", name: "編集者" },
    { id: "viewer", name: "閲覧者" },
  ];
  const http = await postDiff(setRolesDiff("d-owner", onlyOwner));
  expect(http.status).toBe(201);
  // **【禁止の履行】これを「塞いだ」とは1文字も書かない** —— **実地のアプリで
  // この形に当たる規則はすべて `owner` のものであり、着手後も1件も知らされない。**
  expect(http.notices).toEqual([]);
});
