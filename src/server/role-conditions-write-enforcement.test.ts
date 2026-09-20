/**
 * **`V17-M3` / `AC-G15` / `AC-G16` —— 条件つきの規則を、書込の側でも評価することの検査。**
 *
 * ## 塞ぐ穴(`docs/plan/v17/records/a5-*` §3 / 計画 §2-1c / 記録 §6 の実測)
 *
 * **条件つきの `read` / `write` / `delete` を1本だけ持つ相手は、一覧でも単件でもその行を
 * 1バイトも読めないのに、`POST` は 201・`PATCH` は 200・`DELETE` は 204 を返していた。**
 * **MCP の `write_records` の `create` / `update` も同じく通っていた。**
 * **原因は2段である**(計画 §3-5):
 *
 * 1. `evaluateRoleCondition` が **行を伴わない判定を「通しうる」** として返す(`holds: true`)。
 *    **これは1バイトも倒さない** —— 倒すと 141本が赤くなる(`role-conditions-enforcement.test.ts`
 *    の `(G)` が `expect(withoutRow.allowed).toBe(true)` で名指しで固定している)。
 * 2. **行ごとの判定の配管(`recordAccessJudge`)は、点(行ごとの付与)を宣言した表でしか走らない。**
 *    **読取側は一覧と単件の2箇所で個別に補っているが、書込側にその補いが1本も無かった。**
 *
 * **本検査が固定するのは「書込側にも同じ補いが在ること」である。**
 *
 * ## この検査が固定していないこと(**誇張しない**)
 *
 * - **`_id` / `_created_at` / `_updated_at` を条件に書いた規則は、作成(`POST`)のときだけ
 *   偽になる** —— **書く前にこれらの値が存在しないからである**(計画 §3-5 の末尾)。
 * - **MCP の `write_records` に `delete` op は無い**(`allowed_values: ["create","update"]`)。
 *   **そちらは撃っていない**(計画 §2-3)。
 * - **点(行ごとの付与)を宣言した表には、この補いは1ミリも掛からない** —— **あちらは
 *   `recordAccessJudge` の配管が今日どおり判定する**(面と点は `OR`)。
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../mcp/server.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN } from "./test-helpers.ts";

const APP_ID = "role-write-conditions";
/** **条件つきの規則を1本だけ持つ表**(主題)。 */
const GUARDED = "notes";
/** **条件を1本も書いていない表**(**陰性対照**。着手前と着手後で1ミリも変わってはならない)。 */
const OPEN = "open_notes";
/**
 * **「書けるが読めない」相手のための表**(`AC-G16` の題材)。
 *
 * **面の `write` は条件なし・`read` は条件つきである** —— **したがって `AC-G15` の後も
 * `PATCH` は 200 のままであり、`AC-G16` の当て先(**200 の応答本文**)が残る。**
 */
const WRITABLE = "writable_notes";

let dataRoot: string | undefined;
let app: ReturnType<typeof createServerApp>;
let owner: ReturnType<typeof seedSession>;
let viewer: ReturnType<typeof seedSession>;

function req(
  cookie: string | undefined,
  method: string,
  path: string,
  body?: unknown,
  ifMatch?: string,
): Promise<Response> {
  const headers: Record<string, string> = { origin: TEST_ORIGIN };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  if (ifMatch !== undefined) {
    headers["if-match"] = ifMatch;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return Promise.resolve(app.request(new Request(`http://localhost${path}`, init)));
}

const records = (table: string) => `/api/apps/${APP_ID}/tables/${table}/records`;

type Row = { _id: string; _updated_at: string; [key: string]: unknown };

async function createdBy(cookie: string, table: string, values: unknown): Promise<Row> {
  const res = await req(cookie, "POST", records(table), values);
  expect(res.status).toBe(201);
  return ((await res.json()) as { record: Row }).record;
}

/**
 * **題材を組む。**
 *
 * **`POST /diffs` の `add_table` は3つの役割すべてに規則を1本ずつ生やす** ——
 * **`viewer` のそれは**条件なしの `read`** である。** **面と点は `OR` なので、
 * これが1本あると条件が丸ごと無効になる**(記憶 `face-or-point-no-read-face`)。
 * **`set_roles` で外してから測る**(記録 §6-2 が実物を貼っている)。
 */
async function boot(): Promise<void> {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-role-write-cond-"));
  // **アプリは MCP の道具で作る。カーネルの関数を1本も import しない** ——
  // **`scripts/kernel-import-drift.test.ts`(層またぎのスナップショット)を、この検査の
  // ためだけに太らせないためである**(`src/mcp/actor-authz.test.ts` と同じ判断)。
  const createdApp = await callTool(
    "create_app",
    { name: "条件つきのメモ帳", app_id: APP_ID },
    "bootstrap",
  );
  expect(createdApp.isError).toBeFalsy();
  app = createServerApp({ dataRoot });
  owner = seedSession(dataRoot, APP_ID, { role: "owner", username: "cond-owner" });
  viewer = seedSession(dataRoot, APP_ID, { role: "viewer", username: "cond-viewer" });

  const fields = [
    { id: "title", name: "件名", type: "text", required: true },
    { id: "body", name: "本文", type: "text" },
  ];
  const added = await req(owner.cookie, "POST", `/api/apps/${APP_ID}/diffs`, {
    diff_id: "add-tables",
    intent: "主題の表と陰性対照の表を足す",
    operations: [
      { op: "add_table", table: { id: GUARDED, name: "メモ", fields } },
      { op: "add_table", table: { id: OPEN, name: "開いたメモ", fields } },
      { op: "add_table", table: { id: WRITABLE, name: "書けるが読めないメモ", fields } },
    ],
  });
  expect(added.status).toBe(201);

  const rolesAfterAdd = (
    (await added.json()) as {
      change: { manifest: { app: { roles: { id: string; rules?: unknown[] }[] } } };
    }
  ).change.manifest.app.roles;
  // **【罠の証拠】** `add_table` が `viewer` に生やしたのは**条件なしの `read`** である。
  const viewerBefore = rolesAfterAdd.find((role) => role.id === "viewer");
  expect(viewerBefore?.rules).toContainEqual({
    target: "table",
    table: GUARDED,
    can: ["read"],
  });

  const nextRoles = rolesAfterAdd.map((role) =>
    role.id !== "viewer"
      ? role
      : {
          ...role,
          rules: [
            // **主題**: 条件つきの `read` / `write` / `delete` を**1本だけ**。
            {
              target: "table",
              table: GUARDED,
              can: ["read", "write", "delete"],
              when: { field: "title", equals: "__never__" },
            },
            // **陰性対照**: 条件を1本も書かない。
            { target: "table", table: OPEN, can: ["read", "write", "delete"] },
            // **「書けるが読めない」** —— **書込は条件なし、読取は誰にも当たらない条件つき。**
            { target: "table", table: WRITABLE, can: ["write"] },
            {
              target: "table",
              table: WRITABLE,
              can: ["read"],
              when: { field: "title", equals: "__never__" },
            },
          ],
        },
  );
  const set = await req(owner.cookie, "POST", `/api/apps/${APP_ID}/diffs`, {
    diff_id: "set-roles",
    intent: "viewer の規則を条件つき1本と条件なし1本にする",
    operations: [{ op: "set_roles", roles: nextRoles }],
  });
  expect(set.status).toBe(201);
}

afterEach(async () => {
  if (dataRoot !== undefined) {
    await rm(dataRoot, { recursive: true, force: true });
    dataRoot = undefined;
  }
});

async function callTool(
  name: string,
  args: Record<string, unknown>,
  actor: string,
): Promise<CallToolResult> {
  const server = createMcpServer({
    dataRoot: dataRoot as string,
    previewBaseUrl: "http://127.0.0.1:3000",
    actor,
  });
  const client = new Client({ name: "role-write-conditions", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

// =====================================================================================
// (AC-G15) 書込の3つの口が、条件つきの規則を評価する
// =====================================================================================

test("(AC-G15-1) 読めない相手の POST / PATCH / DELETE が、HTTP で3つとも 403 になる", async () => {
  await boot();
  const row = await createdBy(owner.cookie, GUARDED, {
    title: "運営者のメモ",
    body: "見えてはいけない",
  });

  // **前提** —— **この相手はこの行を1バイトも読めない。**
  const list = await req(viewer.cookie, "GET", records(GUARDED));
  expect(((await list.json()) as { total: number }).total).toBe(0);
  expect((await req(viewer.cookie, "GET", `${records(GUARDED)}/${row._id}`)).status).toBe(404);

  // **(1) 作成** —— 着手前は 201。
  const created = await req(viewer.cookie, "POST", records(GUARDED), {
    title: "閲覧者のメモ",
    body: "閲覧者が書いた",
  });
  expect(created.status).toBe(403);

  // **(2) 更新** —— 着手前は 200。
  const patched = await req(
    viewer.cookie,
    "PATCH",
    `${records(GUARDED)}/${row._id}`,
    { title: "書き換えた" },
    row._updated_at,
  );
  expect(patched.status).toBe(403);

  // **(3) 削除** —— 着手前は 204。
  const deleted = await req(
    viewer.cookie,
    "DELETE",
    `${records(GUARDED)}/${row._id}`,
    undefined,
    row._updated_at,
  );
  expect(deleted.status).toBe(403);

  // **1行も書かれていない**(帳簿は運営者の1行のまま)。
  const ledger = await req(owner.cookie, "GET", records(GUARDED));
  const body = (await ledger.json()) as { records: Row[]; total: number };
  expect(body.total).toBe(1);
  expect(body.records[0]?.title).toBe("運営者のメモ");
});

test("(AC-G15-2) まとめ書き(POST /batch)の create / update も断られる", async () => {
  await boot();
  const row = await createdBy(owner.cookie, GUARDED, { title: "運営者のメモ", body: "内緒" });

  const created = await req(viewer.cookie, "POST", `/api/apps/${APP_ID}/batch`, {
    ops: [{ op: "create", table: GUARDED, values: { title: "まとめて作る" } }],
  });
  expect(created.status).toBe(403);

  const updated = await req(viewer.cookie, "POST", `/api/apps/${APP_ID}/batch`, {
    ops: [{ op: "update", table: GUARDED, target: row._id, values: { title: "まとめて書く" } }],
  });
  expect(updated.status).toBe(403);

  const ledger = await req(owner.cookie, "GET", records(GUARDED));
  expect(((await ledger.json()) as { total: number }).total).toBe(1);
});

test("(AC-G15-3) MCP の write_records の create と update が断られる", async () => {
  await boot();
  const row = await createdBy(owner.cookie, GUARDED, {
    title: "運営者のメモ2",
    body: "見えてはいけない2",
  });

  // **前提** —— **MCP から読んでも0件である。**
  const listed = await callTool(
    "list_records",
    { app_id: APP_ID, table_id: GUARDED },
    viewer.userId,
  );
  expect((listed.structuredContent as { total: number }).total).toBe(0);

  const created = await callTool(
    "write_records",
    {
      app_id: APP_ID,
      ops: [{ op: "create", table: GUARDED, values: { title: "AI が作った" } }],
    },
    viewer.userId,
  );
  expect(created.isError).toBe(true);

  const updated = await callTool(
    "write_records",
    {
      app_id: APP_ID,
      ops: [{ op: "update", table: GUARDED, target: row._id, values: { title: "AI が書いた" } }],
    },
    viewer.userId,
  );
  expect(updated.isError).toBe(true);

  // **1行も書かれていない。**
  const ledger = await req(owner.cookie, "GET", records(GUARDED));
  expect(((await ledger.json()) as { total: number }).total).toBe(1);
});

test("(AC-G15-4) MCP の update_record / delete_record / insert_sample_data も断られる", async () => {
  await boot();
  const row = await createdBy(owner.cookie, GUARDED, { title: "運営者のメモ3", body: "内緒3" });

  const inserted = await callTool(
    "insert_sample_data",
    { app_id: APP_ID, table_id: GUARDED, rows: [{ title: "AI の投入" }] },
    viewer.userId,
  );
  expect(inserted.isError).toBe(true);

  const updated = await callTool(
    "update_record",
    {
      app_id: APP_ID,
      table_id: GUARDED,
      record_id: row._id,
      changes: { title: "AI が書いた" },
      if_match: row._updated_at,
    },
    viewer.userId,
  );
  expect(updated.isError).toBe(true);

  const deleted = await callTool(
    "delete_record",
    { app_id: APP_ID, table_id: GUARDED, record_id: row._id, if_match: row._updated_at },
    viewer.userId,
  );
  expect(deleted.isError).toBe(true);

  const ledger = await req(owner.cookie, "GET", records(GUARDED));
  expect(((await ledger.json()) as { total: number }).total).toBe(1);
});

test("(AC-G15-5) 【陰性対照】条件を1本も書いていない表は、着手前と1ミリも変わらない", async () => {
  await boot();
  const row = await createdBy(owner.cookie, OPEN, { title: "誰でも読める", body: "公開" });

  // **前提** —— **この表は読める。**
  const list = await req(viewer.cookie, "GET", records(OPEN));
  expect(((await list.json()) as { total: number }).total).toBe(1);

  const created = await req(viewer.cookie, "POST", records(OPEN), { title: "閲覧者のメモ" });
  expect(created.status).toBe(201);

  const patched = await req(
    viewer.cookie,
    "PATCH",
    `${records(OPEN)}/${row._id}`,
    { title: "書き換えた" },
    row._updated_at,
  );
  expect(patched.status).toBe(200);

  const next = ((await patched.json()) as { record: Row }).record._updated_at;
  const deleted = await req(
    viewer.cookie,
    "DELETE",
    `${records(OPEN)}/${row._id}`,
    undefined,
    next,
  );
  expect(deleted.status).toBe(204);

  // **MCP も今日どおり通る。**
  const mcp = await callTool(
    "write_records",
    { app_id: APP_ID, ops: [{ op: "create", table: OPEN, values: { title: "AI が作った" } }] },
    viewer.userId,
  );
  expect(mcp.isError).toBeFalsy();
});

test("(AC-G15-6) 【実測】HTTP の POST /batch に delete op を投げると、語彙にないと断られる", async () => {
  await boot();
  const row = await createdBy(owner.cookie, OPEN, { title: "消す相手", body: "" });

  // **運営者で打つ**(`batchAuthMiddleware` は `viewer` を 403 で落とすので、
  // 「`delete` が語彙に在るか」を測れるのは運営の側だけである)。
  const res = await req(owner.cookie, "POST", `/api/apps/${APP_ID}/batch`, {
    ops: [{ op: "delete", table: OPEN, target: row._id }],
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as {
    errors: { path: string; message: string; allowed_values?: string[] }[];
  };
  expect(body.errors[0]?.message).toBe('バッチの操作 "delete" は語彙にありません。');
  expect(body.errors[0]?.allowed_values).toEqual(["create", "update"]);

  // **したがって `AC-G15` の当て先に「まとめ書きの `delete` op」は無い。**
  const ledger = await req(owner.cookie, "GET", records(OPEN));
  expect(((await ledger.json()) as { total: number }).total).toBe(1);
});

// =====================================================================================
// (T06c) 読取が1ミリも変わっていないこと
// =====================================================================================

/**
 * **相手になる着手前の値は、`T05a` で実装担当が自分で打ったものである**
 * (記録 `docs/plan/v17/records/v17-m3.md` §6-5。**計画 §2-1c の4つとも一致した**):
 *
 * ```
 * 帳簿の実件数               : 3
 * owner        の一覧 GET    : 3 件
 * viewer       の一覧 GET    : 0 件
 * MCP(viewer)の list_records : {"records":[],"total":0}
 * ```
 *
 * **`AC-G15` の直しは書込ハンドラの中だけに在り、読取の経路を1バイトも触っていない** ——
 * **この検査はそれを実物で確かめる。**
 * **【正直に】着手前の帳簿の3行は、`a5` の手順(`viewer` の作成・削除を含む)の結果である。**
 * **`AC-G15` の後はその手順が 403 で止まるので、同じ3行を運営者が作って件数を突き合わせている** ——
 * **同じ「作り方」ではなく、同じ「読み方」を突き合わせている。**
 */
test("(AC-G16-0) 条件つき read を持つ表の一覧 GET は、着手前と同じ件数を返す(3 / 0 / 0)", async () => {
  await boot();
  await createdBy(owner.cookie, GUARDED, { title: "1本目", body: "内緒1" });
  await createdBy(owner.cookie, GUARDED, { title: "2本目", body: "内緒2" });
  await createdBy(owner.cookie, GUARDED, { title: "3本目", body: "内緒3" });

  const ownerList = (await (await req(owner.cookie, "GET", records(GUARDED))).json()) as {
    records: Row[];
    total: number;
  };
  const viewerList = (await (await req(viewer.cookie, "GET", records(GUARDED))).json()) as {
    records: Row[];
    total: number;
  };
  const mcpList = await callTool(
    "list_records",
    { app_id: APP_ID, table_id: GUARDED },
    viewer.userId,
  );

  expect(ownerList.total).toBe(3);
  expect(ownerList.records).toHaveLength(3);
  expect(viewerList.records).toHaveLength(0);
  expect(mcpList.structuredContent).toEqual({ records: [], total: 0 });

  // **単件 `GET` も着手前と同じである**(運営者は 200 / 条件に合わない相手は 404)。
  const one = ownerList.records[0] as Row;
  expect((await req(owner.cookie, "GET", `${records(GUARDED)}/${one._id}`)).status).toBe(200);
  expect((await req(viewer.cookie, "GET", `${records(GUARDED)}/${one._id}`)).status).toBe(404);
});

test("(AC-G16-0b) 条件を1本も書いていない表の読取も、着手前と同じである", async () => {
  await boot();
  await createdBy(owner.cookie, OPEN, { title: "1本目", body: "公開1" });
  await createdBy(owner.cookie, OPEN, { title: "2本目", body: "公開2" });

  const viewerList = (await (await req(viewer.cookie, "GET", records(OPEN))).json()) as {
    records: Row[];
    total: number;
  };
  expect(viewerList.total).toBe(2);
  const mcpList = await callTool("list_records", { app_id: APP_ID, table_id: OPEN }, viewer.userId);
  expect((mcpList.structuredContent as { total: number }).total).toBe(2);
});

// =====================================================================================
// (AC-G16) 書込の応答に、読取が隠している列を載せない
// =====================================================================================

/**
 * **題材は「書けるが読めない」相手である**(面の `write` が条件なし・`read` が条件つき)——
 * **`AC-G15` の後も `PATCH` は 200 のままなので、当て先(200 の応答本文)が残る。**
 *
 * **落とすのは `table.fields` の id 集合ちょうどである** ——
 * **`_id` / `_created_at` / `_updated_at` は `table.fields` に無いので自動的に残る**
 * (`ADR-0134` 限定4「`_updated_at` を落とさない」を守る側である)。
 */
const RESERVED_KEYS = ["_created_at", "_id", "_updated_at"];

test("(AC-G16-1) 読めない相手の PATCH の応答から、業務の列が全部落ちる(200 のまま)", async () => {
  await boot();
  const row = await createdBy(owner.cookie, WRITABLE, {
    title: "運営者のメモ",
    body: "見えてはいけない",
  });

  // **前提** —— **この相手はこの行を1バイトも読めない。**
  expect((await req(viewer.cookie, "GET", `${records(WRITABLE)}/${row._id}`)).status).toBe(404);
  const list = await req(viewer.cookie, "GET", records(WRITABLE));
  expect(((await list.json()) as { total: number }).total).toBe(0);

  const patched = await req(
    viewer.cookie,
    "PATCH",
    `${records(WRITABLE)}/${row._id}`,
    { title: "書き換えた" },
    row._updated_at,
  );
  // **【`ADR-0134` 限定7】書込の可否を1ミリも変えない** —— **200 のままである。**
  expect(patched.status).toBe(200);
  const record = ((await patched.json()) as { record: Row }).record;
  expect(Object.keys(record).sort()).toEqual(RESERVED_KEYS);
  expect(Object.keys(record)).not.toContain("body");
  expect(Object.keys(record)).not.toContain("title");

  // **【`ADR-0134` 限定7】落としたのは応答だけである** —— **帳簿には書けている。**
  const read = await req(owner.cookie, "GET", `${records(WRITABLE)}/${row._id}`);
  expect(((await read.json()) as { record: Row }).record.title).toBe("書き換えた");
});

test("(AC-G16-2) 【`ADR-0134` 限定4】その応答の _updated_at は、次の If-Match にそのまま使える", async () => {
  await boot();
  const row = await createdBy(owner.cookie, WRITABLE, { title: "1回目", body: "内緒" });

  const first = await req(
    viewer.cookie,
    "PATCH",
    `${records(WRITABLE)}/${row._id}`,
    { title: "2回目" },
    row._updated_at,
  );
  expect(first.status).toBe(200);
  const version = ((await first.json()) as { record: Row }).record._updated_at;
  expect(typeof version).toBe("string");

  const second = await req(
    viewer.cookie,
    "PATCH",
    `${records(WRITABLE)}/${row._id}`,
    { title: "3回目" },
    version,
  );
  expect(second.status).toBe(200);
});

test("(AC-G16-3) 作成(POST)とまとめ書き(POST /batch)の応答からも落ちる", async () => {
  await boot();

  const created = await req(viewer.cookie, "POST", records(WRITABLE), {
    title: "閲覧者が作った",
    body: "内緒",
  });
  expect(created.status).toBe(201);
  const one = ((await created.json()) as { record: Row }).record;
  expect(Object.keys(one).sort()).toEqual(RESERVED_KEYS);

  // **まとめ書き** —— **`viewer` は `batchAuthMiddleware` が 403 で落とすので、
  // 「書けるが読めない」相手をまとめ書きで作るには `editor` が要る。**
  // **`editor` はこの表について規則を1本も持たない** —— **面の表の関門で 403 になる。**
  // **そこで運営者で打ち、運営者の応答が1ミリも変わらないことを並べて撃つ**(陽性対照)。
  const batched = await req(owner.cookie, "POST", `/api/apps/${APP_ID}/batch`, {
    ops: [{ op: "create", table: WRITABLE, values: { title: "運営者がまとめて作った" } }],
  });
  expect(batched.status).toBe(200);
  const rows = ((await batched.json()) as { records: Row[] }).records;
  expect(rows[0]?.title).toBe("運営者がまとめて作った");
});

test("(AC-G16-4) 【ユーザ決定 2026-09-07】AI(MCP)の書込の応答からも落ちる", async () => {
  await boot();
  const row = await createdBy(owner.cookie, WRITABLE, {
    title: "運営者のメモ",
    body: "見えてはいけない",
  });

  // **(1) `write_records` の `update`** —— **着手前は `"body":"見えてはいけない"` が載っていた。**
  const updated = await callTool(
    "write_records",
    {
      app_id: APP_ID,
      ops: [{ op: "update", table: WRITABLE, target: row._id, values: { title: "AI が書いた" } }],
    },
    viewer.userId,
  );
  expect(updated.isError).toBeFalsy();
  const mcpRows = (updated.structuredContent as { records: Row[] }).records;
  expect(Object.keys(mcpRows[0] as object).sort()).toEqual(RESERVED_KEYS);

  // **(2) `update_record`**
  const single = await callTool(
    "update_record",
    {
      app_id: APP_ID,
      table_id: WRITABLE,
      record_id: row._id,
      changes: { title: "AI が2度目" },
      if_match: String(mcpRows[0]?._updated_at),
    },
    viewer.userId,
  );
  expect(single.isError).toBeFalsy();
  expect(Object.keys((single.structuredContent as { record: Row }).record).sort()).toEqual(
    RESERVED_KEYS,
  );

  // **(3) `insert_sample_data`**
  const inserted = await callTool(
    "insert_sample_data",
    { app_id: APP_ID, table_id: WRITABLE, rows: [{ title: "AI が作った" }] },
    viewer.userId,
  );
  expect(inserted.isError).toBeFalsy();
  const insertedRows = (inserted.structuredContent as { inserted: Row[] }).inserted;
  expect(Object.keys(insertedRows[0] as object).sort()).toEqual(RESERVED_KEYS);

  // **帳簿には書けている**(落としたのは応答だけである)。
  const read = await req(owner.cookie, "GET", `${records(WRITABLE)}/${row._id}`);
  expect(((await read.json()) as { record: Row }).record.title).toBe("AI が2度目");
});

test("(AC-G16-5) 【`ADR-0134` 限定3】読める相手の書込の応答は、読取の応答とキーが一致する", async () => {
  await boot();
  const created = await req(owner.cookie, "POST", records(WRITABLE), {
    title: "運営者のメモ",
    body: "内緒",
  });
  expect(created.status).toBe(201);
  const written = ((await created.json()) as { record: Row }).record;

  const read = await req(owner.cookie, "GET", `${records(WRITABLE)}/${written._id}`);
  expect(read.status).toBe(200);
  const readRecord = ((await read.json()) as { record: Row }).record;
  expect(Object.keys(written).sort()).toEqual(Object.keys(readRecord).sort());
  expect(Object.keys(written)).toContain("title");
});

test("(AC-G16-6) 【`ADR-0134` 限定9】宣言0本の表の応答は、着手前と1ミリも変わらない", async () => {
  await boot();
  const created = await req(viewer.cookie, "POST", records(OPEN), {
    title: "閲覧者のメモ",
    body: "本文",
  });
  expect(created.status).toBe(201);
  const one = ((await created.json()) as { record: Row }).record;
  expect(Object.keys(one).sort()).toEqual(["_created_at", "_id", "_updated_at", "body", "title"]);

  const patched = await req(
    viewer.cookie,
    "PATCH",
    `${records(OPEN)}/${one._id}`,
    { title: "書き換えた" },
    one._updated_at,
  );
  expect(patched.status).toBe(200);
  expect(((await patched.json()) as { record: Row }).record.title).toBe("書き換えた");

  const mcp = await callTool(
    "write_records",
    { app_id: APP_ID, ops: [{ op: "create", table: OPEN, values: { title: "AI" } }] },
    viewer.userId,
  );
  expect(mcp.isError).toBeFalsy();
  expect((mcp.structuredContent as { records: Row[] }).records[0]?.title).toBe("AI");
});
