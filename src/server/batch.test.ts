/**
 * バッチ書込(EC-G7 / ADR-0039。V2-M4-T01)の HTTP 統合テスト + MCP との経路一致。
 *
 * `POST /api/apps/:app_id/batch` が MCP `write_records` と**同じカーネル関門 `writeRecords`**
 * を通ることを、両経路で同じ振る舞い(全成功 / 部分適用ゼロ / CAS 競合)を示して確認する。
 * 認可(editor/owner)・監査 INSERT の同一 tx 束ね・監査のロールバックも確認する。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AuthStore } from "../auth/store.ts";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createMcpServer } from "../mcp/server.ts";
import { createServerApp } from "./app.ts";
import { authed, seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "ec";

function ecManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "参照EC",
      tables: [
        {
          id: "products",
          name: "商品",
          fields: [
            { id: "name", name: "商品名", type: "text", required: true },
            { id: "stock", name: "在庫", type: "number", required: true },
          ],
        },
        {
          id: "orders",
          name: "注文",
          fields: [
            { id: "customer", name: "顧客", type: "text", required: true },
            { id: "status", name: "状態", type: "select", options: ["pending", "paid"] },
          ],
        },
        {
          id: "order_lines",
          name: "注文明細",
          fields: [
            { id: "order", name: "注文", type: "reference", reference_table: "orders" },
            { id: "product", name: "商品", type: "reference", reference_table: "products" },
            { id: "quantity", name: "数量", type: "number", required: true },
          ],
        },
      ],
      views: [],
    },
  };
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
let ownerCookie: string;
/** **【`V8-M31`】MCP の名乗り**に使う、このアプリに実在する利用者(`seedSession` の戻り)。 */
let ownerSeed: ReturnType<typeof seedSession>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-batch-http-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "参照EC", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`】既定が閉じたので、題材へ規則を足す。**
  // **この題材(`ec`)には個人所有(`st_owner`)の表が1つも無い** —— **したがって
  // 3表すべてに既定どおり配っても、本ファイルの主題(バッチの原子性・CAS・監査)は
  // 1ミリも変わらない。** **`viewer` は今日も `read` だけであり、書込の 403 は生きている。**
  const applied = applyManifest(dataRoot, APP_ID, withDefaultRoleRules(ecManifest()));
  expect(applied.valid).toBe(true);
  app = createServerApp({ dataRoot });
  ownerSeed = seedSession(dataRoot, APP_ID);
  ownerCookie = ownerSeed.cookie;
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

/** cookie/Origin 付きで batch を POST する。 */
async function batch(cookie: string, ops: unknown): Promise<Response> {
  return app.request(
    authed(cookie)(`/api/apps/${APP_ID}/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ops }),
    }),
  );
}

/** 1件だけ create して _id を返す(HTTP 経由)。 */
async function createProduct(
  name: string,
  stock: number,
): Promise<{ id: string; version: string }> {
  const res = await app.request(
    authed(ownerCookie)(`/api/apps/${APP_ID}/tables/products/records`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, stock }),
    }),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { record: { _id: string; _updated_at: string } };
  return { id: body.record._id, version: body.record._updated_at };
}

async function listCount(tableId: string): Promise<number> {
  const res = await app.request(
    authed(ownerCookie)(`/api/apps/${APP_ID}/tables/${tableId}/records`),
  );
  const body = (await res.json()) as { records: unknown[] };
  return body.records.length;
}

async function stockOf(id: string): Promise<number> {
  const res = await app.request(
    authed(ownerCookie)(`/api/apps/${APP_ID}/tables/products/records/${id}`),
  );
  const body = (await res.json()) as { record: { stock: number } };
  return body.record.stock;
}

test("HTTP: order + 明細 ×2 + 在庫更新 ×2 を1バッチで全成功で書ける", async () => {
  const order = await createOrder();
  const p1 = await createProduct("りんご", 10);
  const p2 = await createProduct("みかん", 5);

  const res = await batch(ownerCookie, [
    {
      op: "create",
      table: "order_lines",
      values: { order: order.id, product: p1.id, quantity: 3 },
    },
    {
      op: "create",
      table: "order_lines",
      values: { order: order.id, product: p2.id, quantity: 2 },
    },
    { op: "update", table: "products", target: p1.id, values: { stock: 7 }, if_match: p1.version },
    { op: "update", table: "products", target: p2.id, values: { stock: 3 }, if_match: p2.version },
  ]);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { records: unknown[] };
  expect(body.records).toHaveLength(4);
  expect(await listCount("order_lines")).toBe(2);
  expect(await stockOf(p1.id)).toBe(7);
  expect(await stockOf(p2.id)).toBe(3);
});

/** order を1件作って _id を返す。 */
async function createOrder(): Promise<{ id: string }> {
  const res = await app.request(
    authed(ownerCookie)(`/api/apps/${APP_ID}/tables/orders/records`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customer: "田中", status: "pending" }),
    }),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { record: { _id: string } };
  return { id: body.record._id };
}

test("HTTP: 1 op 失敗(存在しない table)で全ロールバック(部分適用ゼロ)= 400", async () => {
  const p1 = await createProduct("限定", 5);
  const res = await batch(ownerCookie, [
    { op: "create", table: "orders", values: { customer: "佐藤", status: "pending" } },
    { op: "create", table: "ghost", values: { x: 1 } },
    { op: "update", table: "products", target: p1.id, values: { stock: 0 }, if_match: p1.version },
  ]);
  expect(res.status).toBe(400);
  // orders は書かれていない。在庫も戻っている。
  expect(await listCount("orders")).toBe(0);
  expect(await stockOf(p1.id)).toBe(5);
});

test("HTTP: update op の CAS 競合はバッチ全体を巻き戻し 409(売り越しゼロ)", async () => {
  const p1 = await createProduct("最後の1個", 1);
  const stale = p1.version;
  // 先行更新で版を進める。
  const first = await batch(ownerCookie, [
    { op: "update", table: "products", target: p1.id, values: { stock: 0 }, if_match: stale },
  ]);
  expect(first.status).toBe(200);

  // 後発は古い版(stale)で来る → CAS 失敗 → 409。
  const second = await batch(ownerCookie, [
    { op: "create", table: "orders", values: { customer: "後発", status: "pending" } },
    { op: "update", table: "products", target: p1.id, values: { stock: -1 }, if_match: stale },
  ]);
  expect(second.status).toBe(409);
  // 後発 order は書かれず、在庫はマイナスにならない(0 のまま)。
  expect(await listCount("orders")).toBe(0);
  expect(await stockOf(p1.id)).toBe(0);
});

test("HTTP: 監査行はバッチと同一 tx に束ねられ、失敗時は監査も残らない", async () => {
  // 成功バッチ → 監査2件(create + update)。
  const p1 = await createProduct("A", 5);
  const okRes = await batch(ownerCookie, [
    { op: "create", table: "orders", values: { customer: "監査", status: "pending" } },
    { op: "update", table: "products", target: p1.id, values: { stock: 4 }, if_match: p1.version },
  ]);
  expect(okRes.status).toBe(200);

  const store = AuthStore.openForApp(dataRoot, APP_ID);
  try {
    // createProduct(1件) + バッチの create_record + update_record = 計3件。
    // **多重集合として**比べる —— listActivity は `ORDER BY at, id` で並び、id はランダム
    // UUID なので、バッチの2行(同一 ms = at が同値)の相対順は不定になる(監査が同一 tx に
    // 束ねられている証拠でもある)。順序に依存しない sort 済み比較で意図(3件・内訳)を固定する。
    const actions = store
      .listActivity()
      .map((a) => a.action)
      .sort();
    expect(actions).toEqual(["create_record", "create_record", "update_record"]);
  } finally {
    store.close();
  }

  // 失敗バッチ → 監査は1件も増えない(ロールバック)。
  const failRes = await batch(ownerCookie, [
    { op: "create", table: "orders", values: { customer: "失敗", status: "pending" } },
    { op: "create", table: "ghost", values: { x: 1 } },
  ]);
  expect(failRes.status).toBe(400);
  const store2 = AuthStore.openForApp(dataRoot, APP_ID);
  try {
    expect(store2.listActivity()).toHaveLength(3); // 増えていない
  } finally {
    store2.close();
  }
});

test("HTTP: viewer は 403 / 未認証は 401(バッチに公開窓を開けない)", async () => {
  const viewer = seedSession(dataRoot, APP_ID, { role: "viewer" });
  const forbidden = await batch(viewer.cookie, [
    { op: "create", table: "orders", values: { customer: "閲覧者", status: "pending" } },
  ]);
  expect(forbidden.status).toBe(403);

  // 未認証(cookie 無し)。origin は付ける(CSRF は別軸)。
  const anon = await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/batch`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: TEST_ORIGIN },
      body: JSON.stringify({ ops: [{ op: "create", table: "orders", values: { customer: "x" } }] }),
    }),
  );
  expect(anon.status).toBe(401);
  expect(await listCount("orders")).toBe(0);
});

test("HTTP: ops が配列でない要求は 400", async () => {
  const res = await app.request(
    authed(ownerCookie)(`/api/apps/${APP_ID}/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ops: "not-an-array" }),
    }),
  );
  expect(res.status).toBe(400);
});

// --- V4-M34-T01: 空の ops(`ADR-0131` 単位A = 限定採用)---------------------------
//
// **限定1**(逐語「**判定は `validateBatchStructure` の1箇所のまま。入口ごとの分岐を
// 1つも作らない**」)の機械的検査のうち、**HTTP 経路と MCP 経路の2本**をここに置く
// (3本目 = 島の経路は `src/kernel/run-function.test.ts`)。
//
// **`src/server/app.ts` にも `src/mcp/tools/write.ts` にも「op が0件なら〜」の分岐を
// 1行も書いていない** —— 下の2本が同じ答えを返すのは、両方が同じ `writeRecords` の
// 戻り値をそのまま受けているからである(`ADR-0003` §7)。
//
// **【正直に書く】** この2本は `ADR-0131` §限界2 の代償(AI や外部システムの
// **組み立てミスが黙って成功で返る**)を、そのまま固定する検査でもある。

test("HTTP: 空の ops は 200 かつ records が [](限定1。入口で扱いを変えない)", async () => {
  // 事前に行を作っておく —— 「もともと0件だから増えない」では検査にならない。
  const p1 = await createProduct("空バッチ確認", 5);
  const before = await listCount("orders");

  const res = await batch(ownerCookie, []);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { records: unknown[] };
  expect(body.records).toEqual([]);

  // 限定3: ディスクが1バイトも動かない。
  expect(await listCount("orders")).toBe(before);
  expect(await stockOf(p1.id)).toBe(5);
});

test("HTTP: 空の ops は監査行を1行も足さない(限定3。_auth_activity が増えない)", async () => {
  await createProduct("監査確認", 3);
  const store = AuthStore.openForApp(dataRoot, APP_ID);
  let before: number;
  try {
    before = store.listActivity().length;
  } finally {
    store.close();
  }

  const res = await batch(ownerCookie, []);
  expect(res.status).toBe(200);

  const store2 = AuthStore.openForApp(dataRoot, APP_ID);
  try {
    expect(store2.listActivity()).toHaveLength(before);
  } finally {
    store2.close();
  }
});

// --- MCP write_records と HTTP の経路一致 ------------------------------------------

async function callWriteRecords(ops: unknown): Promise<CallToolResult> {
  // **【`V8-M31`】MCP は名乗り(`actor`)を要る** —— このアプリに実在する利用者の名を渡す。
  const server = createMcpServer({
    dataRoot,
    previewBaseUrl: "http://127.0.0.1:3000",
    actor: ownerSeed.username,
  });
  const client = new Client({ name: "batch-test", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  try {
    return (await client.callTool({
      name: "write_records",
      arguments: { app_id: APP_ID, ops },
    })) as CallToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

test("MCP write_records も同じ関門を通り、全成功で書ける", async () => {
  const p1 = await createProduct("MCP品", 8);
  const result = await callWriteRecords([
    { op: "create", table: "orders", values: { customer: "MCP", status: "pending" } },
    { op: "update", table: "products", target: p1.id, values: { stock: 6 }, if_match: p1.version },
  ]);
  expect(result.isError).toBeFalsy();
  const data = result.structuredContent as { records: unknown[] };
  expect(data.records).toHaveLength(2);
  expect(await listCount("orders")).toBe(1);
  expect(await stockOf(p1.id)).toBe(6);
});

test("MCP write_records も空の ops を成功として受ける(限定1。HTTP と同じ答え)", async () => {
  const p1 = await createProduct("MCP空バッチ", 4);
  const before = await listCount("orders");

  const result = await callWriteRecords([]);
  expect(result.isError).toBeFalsy();
  const data = result.structuredContent as { records: unknown[] };
  expect(data.records).toEqual([]);

  // 限定3: ディスクが1バイトも動かない。
  expect(await listCount("orders")).toBe(before);
  expect(await stockOf(p1.id)).toBe(4);
});

test("MCP write_records も部分適用ゼロ(1 op 失敗で isError かつ何も変わらない)", async () => {
  const p1 = await createProduct("MCP品2", 8);
  const result = await callWriteRecords([
    { op: "create", table: "orders", values: { customer: "MCP2", status: "pending" } },
    { op: "create", table: "ghost", values: { x: 1 } },
    { op: "update", table: "products", target: p1.id, values: { stock: 0 }, if_match: p1.version },
  ]);
  expect(result.isError).toBe(true);
  // 契約1: isError = 何も変わっていない。
  expect(await listCount("orders")).toBe(0);
  expect(await stockOf(p1.id)).toBe(8);
});

test("MCP write_records の CAS 競合も全ロールバック(HTTP と同じ振る舞い)", async () => {
  const p1 = await createProduct("MCP限定", 1);
  const stale = p1.version;
  // HTTP 経由で先に版を進める。
  await batch(ownerCookie, [
    { op: "update", table: "products", target: p1.id, values: { stock: 0 }, if_match: stale },
  ]);
  // MCP 経由で古い版 → 競合 → 全ロールバック。
  const result = await callWriteRecords([
    { op: "create", table: "orders", values: { customer: "MCP後発", status: "pending" } },
    { op: "update", table: "products", target: p1.id, values: { stock: -1 }, if_match: stale },
  ]);
  expect(result.isError).toBe(true);
  expect(await listCount("orders")).toBe(0);
  expect(await stockOf(p1.id)).toBe(0);
});

// --- V3-M8-T01b: バッチ経路の owner ガード -----------------------------------------
//
// **追加のみ**(上の既存テストを1本も削除・改変していない)。審査は
// `docs/plan/v3/records/v3-m8-gate-a-batch-owner-guard.md`(門外 Δ7 / 却下 = 帰属先は
// サーバ層)、射程の確定は `docs/adr/0061-admin-row-visibility.md` の改訂1 である。
//
// 固定するのは4点:
//   (1) create op の `st_owner` スタンプ(他人 id の詐称を矯正。ADR-0016 §却下(iv))
//   (2) update op の可視性ガード(不可視は 404。バッチ全体が1バイトも書かれない)
//   (3) update op の付け替え / 私物化(claim)の禁止(403。単件 PATCH と同じ判定関数)
//   (4) **可視性の判定が付け替えの判定より先**(逆にすると不可視行の存在が漏れる)
//
// **TOCTOU 窓は閉じていない**(事前読取は `writeRecords` の IMMEDIATE tx の外)。
// **`if_match` は任意のままである**(ADR-0017 の必須化はバッチに掛かっていない)。

const OWNED_APP_ID = "owned";

/**
 * 個人所有テーブル(`st_owner`)・**読取を面の規則で開いた個人所有テーブル**・
 * 非個人テーブルの3種を持つアプリ。**既存の `ecManifest()` を1バイトも変更しない**ため、
 * 同じ dataRoot に別アプリとして作る。
 *
 * **【`V8-M20` / 台帳 `J-G30` / `ADR-0301` / ユーザ決定 `D-V8-35`】**
 * **旧: `admin_notes` に予約規約フィールド `st_admin_readable`(運営可視)を1本立てて
 *   「運営には他人の行も読める」を作っていた。** **その宣言は廃止された。**
 * **新: 面の規則 `app.roles[].rules[]` の `{ target: "table", table: "admin_notes",
 *   can: ["read","write","delete"] }` で同じことを作る** —— **`D-V8-35` により、
 *   面の規則が `read` を許した表では `st_owner` の絞り込みが**読取についてだけ**効かなくなる。**
 * **`write` / `delete` を `can` に入れているのは、対象を名指しした時点で全動詞が allow-list に
 *   なるためである**(入れないと誰もその表へ書けなくなり、フィクスチャの作成が 403 になる)。
 * **`editor` にも同じ規則を書いているのは、`bob`(editor)がこの表に行を作るからである。**
 */
function ownedManifest(): Manifest {
  return {
    app: {
      id: OWNED_APP_ID,
      name: "個人スコープ付きアプリ",
      tables: [
        {
          id: "notes",
          name: "メモ",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
        {
          id: "admin_notes",
          name: "読取を開いたメモ",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "st_owner", name: "所有者", type: "text" },
            // **【`V8-M20` / `J-G30`】旧: `{ id: "st_admin_readable", name: "運営可視",
            //   type: "boolean" }`。** **予約規約フィールドごと廃止したので、下の
            //   `app.roles` の規則へ置き直した。**
          ],
        },
        {
          id: "bulletin",
          name: "掲示",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
        },
      ],
      views: [],
      // **【`V8-M20` / `J-G30` / `D-V8-35`】旧 `st_admin_readable` の置き直し先。**
      // **既定3ロール(`owner` / `editor` / `viewer`)は消せないので、規則を持たない
      //   `viewer` も宣言する**(`referential-integrity.ts` の類型17)。
      roles: [
        {
          id: "owner",
          name: "運営",
          rules: [{ target: "table", table: "admin_notes", can: ["read", "write", "delete"] }],
        },
        {
          id: "editor",
          name: "編集",
          rules: [{ target: "table", table: "admin_notes", can: ["read", "write", "delete"] }],
        },
        { id: "viewer", name: "閲覧" },
      ],
    },
  } as unknown as Manifest;
}

/** `owned` アプリを同じ dataRoot に作る(各テストの先頭で呼ぶ)。 */
function setupOwnedApp(): void {
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "個人スコープ付きアプリ", { app_id: OWNED_APP_ID });
  } finally {
    store.close();
  }
  const applied = applyManifest(
    dataRoot,
    OWNED_APP_ID,
    withDefaultRoleRules(ownedManifest(), { skipTables: ["admin_notes"] }),
  );
  expect(applied.valid).toBe(true);
}

/** 任意アプリへ batch を POST する。 */
async function batchOn(appId: string, cookie: string, ops: unknown): Promise<Response> {
  return app.request(
    authed(cookie)(`/api/apps/${appId}/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ops }),
    }),
  );
}

/** 単件 POST で1行作る(st_owner はサーバがスタンプする)。 */
async function createRow(
  appId: string,
  cookie: string,
  tableId: string,
  values: Record<string, unknown>,
): Promise<{ id: string; version: string; owner: unknown }> {
  const res = await app.request(
    authed(cookie)(`/api/apps/${appId}/tables/${tableId}/records`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(values),
    }),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    record: { _id: string; _updated_at: string; st_owner?: unknown };
  };
  return { id: body.record._id, version: body.record._updated_at, owner: body.record.st_owner };
}

/** 単件 GET(存在/可視の確認に使う)。 */
async function getRow(appId: string, cookie: string, tableId: string, id: string) {
  return app.request(authed(cookie)(`/api/apps/${appId}/tables/${tableId}/records/${id}`));
}

/** 行を共有(st_owner=null)にする —— 単件 PATCH 経由(既存経路。本タスクは触らない)。 */
async function shareRow(
  appId: string,
  cookie: string,
  tableId: string,
  id: string,
  version: string,
): Promise<void> {
  const res = await app.request(
    authed(cookie)(`/api/apps/${appId}/tables/${tableId}/records/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "if-match": version },
      body: JSON.stringify({ st_owner: null }),
    }),
  );
  expect(res.status).toBe(200);
}

/** そのアプリのテーブルの件数(cookie の可視範囲で)。 */
async function countIn(appId: string, cookie: string, tableId: string): Promise<number> {
  const res = await app.request(authed(cookie)(`/api/apps/${appId}/tables/${tableId}/records`));
  const body = (await res.json()) as { records: unknown[] };
  return body.records.length;
}

test("batch/owner 1: create op は st_owner を actor.id で必ず上書きする(他人 id の詐称を矯正)", async () => {
  setupOwnedApp();
  const a = seedSession(dataRoot, OWNED_APP_ID, { role: "owner", username: "alice" });
  const b = seedSession(dataRoot, OWNED_APP_ID, { role: "editor", username: "bob" });

  const res = await batchOn(OWNED_APP_ID, a.cookie, [
    { op: "create", table: "notes", values: { title: "詐称", st_owner: b.userId } },
  ]);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { records: { _id: string; st_owner: unknown }[] };
  expect(body.records[0]?.st_owner).toBe(a.userId);

  // **【`V8-M26`。期待値を反転させた。理由を隠さずに書く】**
  // **旧: `// B からは見えない(A の所有に矯正されている)。`**
  // **旧: `expect(asB.status).toBe(404);`**
  //
  // **反転の根拠**: **`V8-M26` が面の既定を「閉じる」側へ倒したので、`notes` に既定3役割の
  // 規則(`owner` / `editor` / `viewer` の読取)を書かないと、この表へは誰も読み書きできない。**
  // **そして `D-V8-35` の1本(`roleReadCrossesOwnerScope`)は「面がその表の**読取**を許した
  // 役割には全員分の行が見える」と決めている** —— **したがって `editor` である B は、
  // A の私物行も読めるようになった。**
  // **これは `D-V8-35` の説明文が予告していた代償そのものである**(逐語:
  // 「**書き方を間違えると、本来自分の分だけ見えるはずだった人に全員分が見えます**」)。
  //
  // **【正直に書く】これは題材の書き方の問題ではなく、今日の既定の姿である** ——
  // **`src/kernel/apply-diff.ts` の自動付与は `add_table` のたびに3役割へ読取を配るので、
  // 差分で作った実アプリでも、運営3役割のあいだでは `st_owner` の読取の壁が立たない。**
  // **【禁止】これを「バッチが `st_owner` を矯正しなくなった」と読まない** ——
  // **矯正は今日も効いており、それは直上の `expect(body.records[0]?.st_owner).toBe(a.userId)`
  // が実測している。** **書込・削除の壁も今日どおりである**(下の 3 / 4 / 8 / 10 が実測)。
  const asB = await getRow(OWNED_APP_ID, b.cookie, "notes", body.records[0]?._id as string);
  expect(asB.status).toBe(200);
  // **見えても「A の行」のままである** —— **所有者は書き換わっていない。**
  // **B から読むと `st_owner` は表示名に解決される**(`ownerDisplayName`。`ADR-0016` §6)ので、
  // **ここで突き合わせるのは A のログイン名である**(A 自身から読めば id が返る —— 下の 5 が実測)。
  expect(((await asB.json()) as { record: { st_owner: unknown } }).record.st_owner).toBe(
    a.username,
  );
});

test("batch/owner 2: 非個人テーブルの create は素通り(st_owner を足さない)", async () => {
  setupOwnedApp();
  const a = seedSession(dataRoot, OWNED_APP_ID, { role: "owner", username: "alice" });

  const res = await batchOn(OWNED_APP_ID, a.cookie, [
    { op: "create", table: "bulletin", values: { title: "お知らせ" } },
  ]);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { records: Record<string, unknown>[] };
  expect(Object.hasOwn(body.records[0] as object, "st_owner")).toBe(false);
});

test("batch/owner 3: 不可視の行を狙う update は 404 で、バッチ全体が1バイトも書かれない", async () => {
  setupOwnedApp();
  const a = seedSession(dataRoot, OWNED_APP_ID, { role: "owner", username: "alice" });
  const b = seedSession(dataRoot, OWNED_APP_ID, { role: "editor", username: "bob" });
  const victim = await createRow(OWNED_APP_ID, b.cookie, "notes", { title: "Bの私物" });

  const res = await batchOn(OWNED_APP_ID, a.cookie, [
    { op: "create", table: "bulletin", values: { title: "巻き添え" } },
    { op: "update", table: "notes", target: victim.id, values: { title: "乗っ取り" } },
  ]);
  expect(res.status).toBe(404);
  // 同一バッチの create も書かれていない(部分適用ゼロ)。
  expect(await countIn(OWNED_APP_ID, a.cookie, "bulletin")).toBe(0);
  // 被害行も1バイトも変わっていない。
  const still = await getRow(OWNED_APP_ID, b.cookie, "notes", victim.id);
  expect(((await still.json()) as { record: { title: string } }).record.title).toBe("Bの私物");
});

test("batch/owner 4: 404 応答に対象行の内容が1バイトも現れない", async () => {
  setupOwnedApp();
  const a = seedSession(dataRoot, OWNED_APP_ID, { role: "owner", username: "alice" });
  const b = seedSession(dataRoot, OWNED_APP_ID, { role: "editor", username: "bob" });
  const victim = await createRow(OWNED_APP_ID, b.cookie, "notes", { title: "ヒミツの件名" });

  const res = await batchOn(OWNED_APP_ID, a.cookie, [
    { op: "update", table: "notes", target: victim.id, values: { title: "x" } },
  ]);
  expect(res.status).toBe(404);
  const text = await res.text();
  expect(text.includes("ヒミツの件名")).toBe(false);
  expect(text.includes(b.userId)).toBe(false);
  expect(text.includes(victim.version)).toBe(false);
});

test("batch/owner 5: 自分の行の st_owner を他人 id へ付け替える update は 403", async () => {
  setupOwnedApp();
  const a = seedSession(dataRoot, OWNED_APP_ID, { role: "owner", username: "alice" });
  const b = seedSession(dataRoot, OWNED_APP_ID, { role: "editor", username: "bob" });
  const mine = await createRow(OWNED_APP_ID, a.cookie, "notes", { title: "自分の" });

  const res = await batchOn(OWNED_APP_ID, a.cookie, [
    { op: "update", table: "notes", target: mine.id, values: { st_owner: b.userId } },
  ]);
  expect(res.status).toBe(403);
  const still = await getRow(OWNED_APP_ID, a.cookie, "notes", mine.id);
  // --- 【`V8-M37` / 台帳 `F-G5`。期待値を入れ替えた。旧を逐語で残す】 ---
  // **旧(逐語)**:
  //   ```
  //   expect(((await still.json()) as { record: { st_owner: unknown } }).record.st_owner).toBe(
  //     a.userId,
  //   );
  //   ```
  // **`F-G5` が読取の側で「自分の行も表示名で返す」ようにしたので、単件 `GET` の応答は
  // 生 id ではなく表示名(この題材では `display_name` が無いので `username`)になる。**
  // **この検査の主題(付け替えが 403 で、行の持ち主が動いていないこと)は1ミリも
  // 変わっていない** —— **`b` の名前でも id でもないことを、同じ1行で見ている。**
  const owner = ((await still.json()) as { record: { st_owner: unknown } }).record.st_owner;
  expect(owner).toBe("alice");
  expect(owner).not.toBe(b.userId);
});

test("batch/owner 6: 共有行の私物化(claim)は 403", async () => {
  setupOwnedApp();
  const a = seedSession(dataRoot, OWNED_APP_ID, { role: "owner", username: "alice" });
  const b = seedSession(dataRoot, OWNED_APP_ID, { role: "editor", username: "bob" });
  const shared = await createRow(OWNED_APP_ID, a.cookie, "notes", { title: "共有" });
  await shareRow(OWNED_APP_ID, a.cookie, "notes", shared.id, shared.version);

  const res = await batchOn(OWNED_APP_ID, b.cookie, [
    { op: "update", table: "notes", target: shared.id, values: { st_owner: b.userId } },
  ]);
  expect(res.status).toBe(403);
});

test("batch/owner 7: 自分の行を共有化する update(st_owner:null)は通る", async () => {
  setupOwnedApp();
  const a = seedSession(dataRoot, OWNED_APP_ID, { role: "owner", username: "alice" });
  const b = seedSession(dataRoot, OWNED_APP_ID, { role: "editor", username: "bob" });
  const mine = await createRow(OWNED_APP_ID, a.cookie, "notes", { title: "手放す" });

  const res = await batchOn(OWNED_APP_ID, a.cookie, [
    { op: "update", table: "notes", target: mine.id, values: { st_owner: null } },
  ]);
  expect(res.status).toBe(200);
  // 共有になったので B からも見える。
  expect((await getRow(OWNED_APP_ID, b.cookie, "notes", mine.id)).status).toBe(200);
});

test("batch/owner 8: 不可視かつ付け替えの update は 404(可視性が先。403 ではない)", async () => {
  setupOwnedApp();
  const a = seedSession(dataRoot, OWNED_APP_ID, { role: "owner", username: "alice" });
  const b = seedSession(dataRoot, OWNED_APP_ID, { role: "editor", username: "bob" });
  const victim = await createRow(OWNED_APP_ID, b.cookie, "notes", { title: "Bの私物" });

  // 「不可視」かつ「st_owner の付け替え」の両方に該当する1 op。
  // 付け替えの判定を先に置くと 403 になり、**不可視の行が実在すること**が漏れる。
  const res = await batchOn(OWNED_APP_ID, a.cookie, [
    { op: "update", table: "notes", target: victim.id, values: { st_owner: a.userId } },
  ]);
  expect(res.status).toBe(404);
});

// **【`V8-M20` / 台帳 `J-G30` / `ADR-0301` / ユーザ決定 `D-V8-35`】検査は消さずに置き直した。**
// **旧のテスト名: 「batch/owner 9: st_admin_readable 宣言済みでも owner は batch で他人の行を
//   書けない(読取だけが開いた)」。**
// **趣旨は `D-V8-35` のもとでも1ミリも変わらない** —— **面の規則で読取が個人スコープを
//   越えても、書込・削除では `st_owner` が今日どおり `AND` で効く。**
test("batch/owner 9: 面の規則で読取が開いた表でも owner は batch で他人の行を書けない(読取だけが開いた)", async () => {
  setupOwnedApp();
  const a = seedSession(dataRoot, OWNED_APP_ID, { role: "owner", username: "alice" });
  const b = seedSession(dataRoot, OWNED_APP_ID, { role: "editor", username: "bob" });
  const victim = await createRow(OWNED_APP_ID, b.cookie, "admin_notes", { title: "Bの行" });

  // 読取は開いている(`D-V8-35`。旧は V3-M8-T01 / ADR-0061 限定1〜2 が開けていた)。
  expect((await getRow(OWNED_APP_ID, a.cookie, "admin_notes", victim.id)).status).toBe(200);
  // 書込は1ミリも開いていない(本タスクが固定する)。
  const res = await batchOn(OWNED_APP_ID, a.cookie, [
    { op: "update", table: "admin_notes", target: victim.id, values: { title: "書換" } },
  ]);
  expect(res.status).toBe(404);
});

test("batch/owner 10: editor も同じガードを受ける(不可視は 404)", async () => {
  setupOwnedApp();
  const a = seedSession(dataRoot, OWNED_APP_ID, { role: "owner", username: "alice" });
  const b = seedSession(dataRoot, OWNED_APP_ID, { role: "editor", username: "bob" });
  const victim = await createRow(OWNED_APP_ID, a.cookie, "notes", { title: "Aの私物" });

  const res = await batchOn(OWNED_APP_ID, b.cookie, [
    { op: "update", table: "notes", target: victim.id, values: { title: "書換" } },
  ]);
  expect(res.status).toBe(404);
});

test("batch/owner 11: 個人テーブルでも自分の行の通常 update は 200 のまま", async () => {
  setupOwnedApp();
  const a = seedSession(dataRoot, OWNED_APP_ID, { role: "owner", username: "alice" });
  const mine = await createRow(OWNED_APP_ID, a.cookie, "notes", { title: "旧" });

  const res = await batchOn(OWNED_APP_ID, a.cookie, [
    {
      op: "update",
      table: "notes",
      target: mine.id,
      values: { title: "新" },
      if_match: mine.version,
    },
  ]);
  expect(res.status).toBe(200);
  const still = await getRow(OWNED_APP_ID, a.cookie, "notes", mine.id);
  expect(((await still.json()) as { record: { title: string } }).record.title).toBe("新");
});

test("batch/owner 12: 非個人テーブルの update は他人が作った行でも 200 のまま(素通り)", async () => {
  setupOwnedApp();
  const a = seedSession(dataRoot, OWNED_APP_ID, { role: "owner", username: "alice" });
  const b = seedSession(dataRoot, OWNED_APP_ID, { role: "editor", username: "bob" });
  const row = await createRow(OWNED_APP_ID, b.cookie, "bulletin", { title: "Bの掲示" });

  const res = await batchOn(OWNED_APP_ID, a.cookie, [
    { op: "update", table: "bulletin", target: row.id, values: { title: "Aが直した" } },
  ]);
  expect(res.status).toBe(200);
});

test("batch/owner 13: customer は従来どおり 403(middleware。本タスクは1ミリも触らない)", async () => {
  setupOwnedApp();
  const c = seedSession(dataRoot, OWNED_APP_ID, { role: "customer", username: "carol" });

  const res = await batchOn(OWNED_APP_ID, c.cookie, [
    { op: "create", table: "notes", values: { title: "顧客" } },
  ]);
  expect(res.status).toBe(403);
});

test("batch/owner 14: MCP write_records には owner ガードが掛からない(ADR-0016 実装追記 (E) の既知の非対称)", async () => {
  setupOwnedApp();
  const b = seedSession(dataRoot, OWNED_APP_ID, { role: "editor", username: "bob" });
  const victim = await createRow(OWNED_APP_ID, b.cookie, "notes", { title: "Bの私物" });
  // **【`V8-M31`】MCP は名乗り(`actor`)を要る** —— **行の持ち主ではない別人(`alice`)を
  // 名乗らせる**(名乗りを `bob` にすると「他人の行を書けるか」を1ミリも測れなくなる)。
  const a = seedSession(dataRoot, OWNED_APP_ID, { role: "owner", username: "alice" });

  const server = createMcpServer({
    dataRoot,
    previewBaseUrl: "http://127.0.0.1:3000",
    actor: a.username,
  });
  const client = new Client({ name: "batch-owner-test", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  let result: CallToolResult;
  try {
    result = (await client.callTool({
      name: "write_records",
      arguments: {
        app_id: OWNED_APP_ID,
        ops: [{ op: "update", table: "notes", target: victim.id, values: { title: "MCPが書換" } }],
      },
    })) as CallToolResult;
  } finally {
    await client.close();
    await server.close();
  }
  // **【`V8-M31` 第3波。期待値は1バイトも変えていない —— 注釈だけを実測に合わせた】**
  // **旧の注釈(逐語)**: `// **塞いでいない**(MCP は無認証で actor が居ない)。この非対称を検査で可視にしておく。`
  // **今日の実測**: **名乗り(`actor`)は要るようになったが、穴はそのまま開いている** ——
  // **行の持ち主ではない `alice` を名乗っても `bob` の私物行を書き換えられる**
  // (個人スコープ `st_owner` の絞り込みは、今日も MCP の `write_records` に入っていない)。
  // この非対称を検査で可視にしておく。
  //
  // =====================================================================================
  // **【`V8-M31` 第6波・裁定 `M31-13`。ここで期待値を反転させた。旧を逐語で残す】**
  // =====================================================================================
  //
  // **旧の期待値(逐語。3行)**:
  //
  //       expect(result.isError).toBeFalsy();
  //       const still = await getRow(OWNED_APP_ID, b.cookie, "notes", victim.id);
  //       expect(((await still.json()) as { record: { title: string } }).record.title).toBe("MCPが書換");
  //
  // **反転させた理由**: **`judgeOwnerScopedOp`(HTTP のバッチが呼んでいるのと同じ関数)を
  // MCP の `write_records` に配線したので、宣言どおりこの検査が実際に赤くなった。**
  // **`ADR-0016` 実装追記 (E) が受容していた非対称は、今日から `write_records` には無い。**
  // **`test` の名前は1バイトも書き換えていない。** **検査を消しても `skip` にもしていない。**
  //
  // **今日の実測**: **他人の行への update op は「存在しません」で伏せられ(HTTP は 404)、
  // 行は1バイトも変わらない。**
  expect(result.isError).toBe(true);
  const still = await getRow(OWNED_APP_ID, b.cookie, "notes", victim.id);
  expect(((await still.json()) as { record: { title: string } }).record.title).toBe("Bの私物");
});
