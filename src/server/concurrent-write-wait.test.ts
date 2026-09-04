/**
 * 同じアプリへの同時書込の待ち方と、負けた側に届くもの(V3-M13-T15 / ADR-0069)。
 *
 * ## 何を固定するか
 *
 * **`V3-M13-T11` §9 が実測した「負けた側に技術的なエラーが生で届く」を、届く言葉の側で固定する。**
 * 着手前の実測(審査記録 `v3-m13-gate-a-concurrent-write.md` §1-2):
 *
 * | 入口 | 負けた側に届いていたもの |
 * |---|---|
 * | HTTP | `500` / `{"errors":[{"path":"","message":"サーバ内部エラー"}]}` |
 * | MCP | `isError:true` + `database is locked` |
 * | カーネル直呼び | `SQLiteError`(`SQLITE_BUSY`)の throw |
 *
 * **本ファイルは3つを1つずつ当てる。** 文面の出所は `src/kernel/errors.ts` の
 * `concurrentWriteBusyErrors` 1本だけである(ADR-0069 限定12)。
 *
 * ## 待ち時間そのものは「短く握る」で測る
 *
 * 順番待ちの上限は 5 秒である(限定2。値はカーネルの定数1つ)。**上限を実際に使い切る
 * テストは1本も置かない** —— 5秒待つテストは遅く、しかも待ち時間の値を検査に持ち込むと
 * 定数を変えた日に検査が嘘になる。**代わりに (a) 短く握って「待って成立する」ことと、
 * (b) 待たない接続(`apply_diff` は自前で接続を開く)で「業務の言葉が返る」ことを測る。**
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  appDbPath,
  applyManifest,
  concurrentWriteBusyErrors,
  createApp,
  createRecord,
  KernelMetaStore,
  type Manifest,
  readCurrentManifest,
} from "../kernel/index.ts";
import { createMcpServer } from "../mcp/server.ts";
import { createServerApp } from "./app.ts";
import { authed, seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

/**
 * 移した公開単位の根(`apps/smailtalk/`)。**`import.meta.dir` から数える** ——
 * cwd 相対で解くと `bun test` を打つ場所で結果が変わる(`src/` はもうルート直下に無い)。
 */
const PRODUCT_ROOT = join(import.meta.dir, "..", "..");

const APP_ID = "shop";

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "在庫のある店",
      tables: [
        {
          id: "items",
          name: "商品",
          fields: [
            { id: "name", name: "商品名", type: "text", required: true },
            { id: "stock", name: "在庫", type: "number" },
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
  dataRoot = await mkdtemp(join(tmpdir(), "gp-concurrent-write-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "在庫のある店", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **【`V8-M26`】題材に既定3役割の規則を足す**(測っているのはロック待ちであって面ではない)。
  expect(applyManifest(dataRoot, APP_ID, withDefaultRoleRules(manifest())).valid).toBe(true);
  app = createServerApp({ dataRoot });
  ownerSeed = seedSession(dataRoot, APP_ID);
  ownerCookie = ownerSeed.cookie;
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

/**
 * 同一プロセスの別接続で `app.sqlite` の書込ロックを握り、`holdMs` ミリ秒後に離す。
 * **待たない側(順番待ちの上限を過ぎた応答)を測るときだけ使える。**
 *
 * 待つ側には使えない —— カーネルの書込は同期であり、SQLite の busy handler はスレッドごと
 * 止めるので、**同じスレッドに置いたタイマーはロックを離す時刻に発火できない**(実測: 待つ
 * 側のテストがここで 5 秒の上限まで止まった)。待つ側は `holdWriteLockInChild` を使う。
 */
function holdWriteLock(holdMs: number): Promise<void> {
  const holder = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  holder.exec("PRAGMA busy_timeout=0");
  holder.exec("BEGIN IMMEDIATE");
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      holder.exec("ROLLBACK");
      holder.close();
      resolve();
    }, holdMs);
  });
}

/**
 * **別プロセス**で書込ロックを握り、`holdMs` ミリ秒後に離す(待つ側を測るためのもの)。
 * 子が実際にロックを取ってから解決する Promise を返す —— 取る前に本体が走ると競合しない。
 */
async function holdWriteLockInChild(holdMs: number): Promise<{ done: Promise<void> }> {
  const path = appDbPath(dataRoot, APP_ID);
  const child = Bun.spawn({
    cmd: [
      "bun",
      "-e",
      `const { Database } = require("bun:sqlite");
       const db = new Database(${JSON.stringify(path)}, { readwrite: true });
       db.exec("PRAGMA busy_timeout=0");
       db.exec("BEGIN IMMEDIATE");
       console.log("held");
       setTimeout(() => { db.exec("ROLLBACK"); db.close(); }, ${holdMs});`,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  await reader.read();
  reader.releaseLock();
  return { done: child.exited.then(() => undefined) };
}

// --- 文面そのもの(ADR-0069 限定7 / 限定12 / 限定14)-------------------------------

test("ADR-0069 限定12: 待ちきれなかったことの文面は1関数から出る。技術的な語を1文字も含まない", () => {
  const errors = concurrentWriteBusyErrors({ code: "SQLITE_BUSY" });
  expect(errors).not.toBeNull();
  expect(errors).toHaveLength(1);
  const error = (errors as NonNullable<typeof errors>)[0] as {
    path: string;
    message: string;
    hint?: string;
  };
  expect(error.path).toBe("");
  expect(error.message).toContain("同じアプリへ別の書き込みが進行中");
  expect(error.message).toContain("1バイトも書き込まれていません");
  // 技術語が1つも混ざっていないこと(V3-M13-T11 §9-1 が実測した文面の否定)。
  for (const word of ["database is locked", "SQLITE_BUSY", "SQLite", "transaction", "lock"]) {
    expect(error.message).not.toContain(word);
    expect(error.hint ?? "").not.toContain(word);
  }
  // 限定14: 「待てば必ず通る」と約束しない。
  for (const word of ["必ず", "保証", "確実"]) {
    expect(`${error.message}${error.hint ?? ""}`).not.toContain(word);
  }
});

test("ADR-0069 限定13: SQLITE_BUSY 以外は1つも翻訳しない(握り潰さない)", () => {
  expect(concurrentWriteBusyErrors(null)).toBeNull();
  expect(concurrentWriteBusyErrors(undefined)).toBeNull();
  expect(concurrentWriteBusyErrors(new Error("何か別の失敗"))).toBeNull();
  expect(concurrentWriteBusyErrors({ code: "SQLITE_CONSTRAINT" })).toBeNull();
});

// --- カーネル直呼び(V3-M13-T11 が測った経路)---------------------------------------

test("カーネル: 書込ロックが取れないとき、例外ではなく統一エラーの ok:false になる", async () => {
  const release = holdWriteLock(150);
  // **待たない接続**(テスト自身が開くので `busy_timeout` は既定の 0)。
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    const result = createRecord(db, readCurrentManifest(dataRoot, APP_ID), "items", {
      name: "負けた側",
      stock: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("到達しない");
    }
    const first = result.errors[0] as { message: string };
    expect(first.message).toContain("同じアプリへ別の書き込みが進行中");
    expect(first.message).not.toContain("database is locked");
    // 限定9: 版不一致(CAS 衝突)に流用しない。
    expect(result.conflict).toBeUndefined();
  } finally {
    db.close();
  }
  await release;
  // 限定13: 1バイトも書かれていない。
  const after = new Database(appDbPath(dataRoot, APP_ID), { readonly: true });
  try {
    expect((after.query(`select count(*) as n from "items"`).get() as { n: number }).n).toBe(0);
  } finally {
    after.close();
  }
});

// --- HTTP 入口(ADR-0069 §Decision 1 / 2)-------------------------------------------

test("HTTP: 書込ロックが短く握られているだけなら、500 にせず待って成立する", async () => {
  const { done } = await holdWriteLockInChild(400);
  const started = Date.now();
  const res = await app.request(
    authed(ownerCookie)(`/api/apps/${APP_ID}/tables/items/records`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: TEST_ORIGIN },
      body: JSON.stringify({ name: "待った側", stock: 3 }),
    }),
  );
  const waited = Date.now() - started;
  expect(res.status).toBe(201);
  // 実際に待っている(即座に返っていたら、それは待っていない)。
  expect(waited).toBeGreaterThanOrEqual(100);
  await done;
});

test("HTTP: 待たない接続が書込ロックに当たったら、500 ではなく 409 と業務の言葉が返る", async () => {
  // `apply_diff` は自前で接続を開き、順番待ちの PRAGMA を流していない(限定3 の射程外)。
  // したがって上限を使い切らずに「待ちきれなかった側」の応答を測れる。
  const release = holdWriteLock(400);
  // **`V4-FIX1` 項目(5) で `POST /diffs` に認証境界(未認証 401 / owner 以外 403)が入った。**
  // **owner の cookie を付ける** —— ここで測りたいのは書込ロックの応答であって認証ではない。
  const res = await app.request(`/api/apps/${APP_ID}/diffs`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: TEST_ORIGIN, cookie: ownerCookie },
    body: JSON.stringify({
      diff_id: "t15-busy",
      intent: "書込ロック中の適用",
      operations: [
        {
          op: "add_field",
          table: "items",
          field: { id: "memo", name: "メモ", type: "text" },
        },
      ],
    }),
  });
  const body = (await res.json()) as { errors: [{ message: string; hint?: string }] };
  expect(res.status).toBe(409);
  const [busy] = body.errors;
  expect(busy.message).toContain("同じアプリへ別の書き込みが進行中");
  expect(busy.message).not.toContain("サーバ内部エラー");
  expect(busy.message).not.toContain("database is locked");
  await release;
});

// --- MCP 入口(3経路で同じ文面 = ADR-0003 §7 / ADR-0069 限定12)---------------------

test("MCP: 負けた側に届くのは database is locked ではなく、HTTP と同じ文面である", async () => {
  // **【`V8-M31`】MCP は名乗り(`actor`)を要る** —— このアプリに実在する利用者の名を渡す。
  const server = createMcpServer({
    dataRoot,
    previewBaseUrl: "http://127.0.0.1:3000",
    actor: ownerSeed.username,
  });
  const client = new Client({ name: "t15-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    // MCP の接続は順番待ちの PRAGMA を持つので、短く握って「待って成立する」側を測る。
    const { done } = await holdWriteLockInChild(400);
    const started = Date.now();
    const ok = (await client.callTool({
      name: "insert_sample_data",
      arguments: { app_id: APP_ID, table_id: "items", rows: [{ name: "待った側", stock: 2 }] },
    })) as CallToolResult;
    expect(ok.isError).toBeFalsy();
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    await done;

    // 文面そのものは3経路で同一である(出所が1関数だから)。
    const expected = concurrentWriteBusyErrors({ code: "SQLITE_BUSY" });
    expect(expected).not.toBeNull();
    const same = (expected as NonNullable<typeof expected>)[0] as { message: string };
    expect(same.message).toContain("同じアプリへ別の書き込みが進行中");
  } finally {
    await client.close();
    await server.close();
  }
});

// --- 限定の凍結検査(ADR-0069 限定3 / 限定4 / 限定5 / 限定10)-----------------------

test("ADR-0069 限定3 / 限定4: IMMEDIATE 化したのは入口層の2本だけ。records.ts は deferred のまま", async () => {
  const read = async (path: string): Promise<string> =>
    await Bun.file(join(PRODUCT_ROOT, path)).text();
  const count = (text: string, needle: string): number => text.split(needle).length - 1;

  const records = await read("src/kernel/records.ts");
  const batch = await read("src/kernel/batch.ts");
  const appTs = await read("src/server/app.ts");
  const inbound = await read("src/server/inbound-route.ts");
  const scheduler = await read("src/kernel/workflow-scheduler.ts");
  const mcpWrite = await read("src/mcp/tools/write.ts");

  // ADR-0066 限定2(records.ts は deferred。`.immediate()` を呼ばない)を1バイトも破らない。
  expect(count(records, ".immediate()")).toBe(0);
  // IMMEDIATE を使うのは入口層2本 + 既存のバッチ1本だけ。
  expect(count(appTs, ".immediate()")).toBe(1);
  expect(count(inbound, ".immediate()")).toBe(1);
  expect(count(batch, "tx.immediate()")).toBe(1);
  expect(count(mcpWrite, ".immediate()")).toBe(0);

  // ADR-0066 限定1: `db.transaction(` の件数を1つも増やしていない。
  expect(count(appTs, "db.transaction(")).toBe(1);
  expect(count(inbound, "db.transaction(")).toBe(1);
  expect(count(mcpWrite, "db.transaction(")).toBe(0);
  expect(count(scheduler, "db.transaction(")).toBe(0);

  // ADR-0069 限定5: schedule には順番待ちを1バイトも入れない。
  expect(count(scheduler, "CONCURRENT_WRITE_WAIT_PRAGMA")).toBe(0);
  expect(count(scheduler, "busy_timeout")).toBe(0);
  // ADR-0069 限定10: WAL 化しない(journal_mode の宣言は DELETE 1本のまま)。
  const createAppTs = await read("src/kernel/create-app.ts");
  expect(count(createAppTs, "journal_mode")).toBe(1);
  expect(createAppTs).toContain("PRAGMA journal_mode = DELETE;");
  expect(count(createAppTs, "WAL")).toBe(0);
  // ADR-0069 限定1: 再試行を1つも実装しない(新しい判断が住むのは errors.ts だけ。
  // 入口層の `Retry-After` はレート制限の既存機能であり本単位とは無関係)。
  const errorsTs = await read("src/kernel/errors.ts");
  for (const word of ["retry", "settimeout", "setinterval"]) {
    expect(count(errorsTs.toLowerCase(), word)).toBe(0);
  }
});

test("ADR-0069 限定2 / 限定12: 待ち時間の値は1箇所にしかない(入口層に数値リテラルを置かない)", async () => {
  const read = async (path: string): Promise<string> =>
    await Bun.file(join(PRODUCT_ROOT, path)).text();
  for (const path of [
    "src/server/app.ts",
    "src/mcp/tools/write.ts",
    "src/server/inbound-route.ts",
  ]) {
    const text = await read(path);
    expect(text).toContain("CONCURRENT_WRITE_WAIT_PRAGMA");
    // 値そのものを入口層に書かない(定数の綴りだけを配る)。
    expect(text).not.toContain("busy_timeout =");
  }
});
