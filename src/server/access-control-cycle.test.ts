/**
 * **`V7-M4-T03` / `Z-G16`**: **循環したときに止まる。**
 *
 * ## 何を測るか(起票の完了条件の逐語)
 *
 * > **内容**: 訪問済み集合による循環検出。**専用の検査を置く。**
 * > **完了条件**: A の親が B、B の親が A のマニフェストで、`API` が**応答を返す**
 * > (サーバが止まらない・無限に辿らない)ことを示す。
 * > **検証方法**: HTTP の生出力 + 応答時間。
 *
 * **`v7-m0.md` §6-4 `Z-G16` の限定(逐語)**:
 * > (1) 訪問済み集合による検出。1回の判定の中で同じ(表, 行)を2度訪れない。
 * > (2) 専用の検査を置き、段数の上限に依存しない形で書く(上限を動かしても検査が
 * > 守り続けること)。(3) 循環を検出しても拒否に落とさない。判定は正常に完了する。
 * > `Z-G17` の打ち切りとは応答の形が違う。この違いを限定表に1行として書く。
 * > (4) `src/kernel/` に1バイトも差分を出さない。(5) 個別 ADR を持たない。
 *
 * ## 実装の所在(**このファイルが新設したのではない**)
 *
 * **訪問済み集合による循環検出は、`V7-M4-T02`(`Z-G14`)の実装がすでに持っている**
 * (`src/server/owner-scope.ts:1086`-`:1105`(段0を含む全段の訪問済み判定)/ `:1149`
 * (親を積む直前の訪問済みチェック))。**本タスクが新たに足した実装は0バイトである** ——
 * **`Z-G16` の `S2` 自身が「`Z-G14` の限定6 の実体であり独立した増分を1バイトも持たない」
 * と明記している。** **本ファイルの役割は「専用の検査を置く」ことそのものであり、
 * (a)〜(e) の5本柱で、既存の訪問済み集合が実際に循環を止めていることを実測で固定する。**
 *
 * ## (a)〜(e) の対応
 *
 *  - **(a) API・2段の循環**(A の親が B、B の親が A): 一覧 GET / 単件 GET が応答を返す。
 *  - **(b) API・自己参照**(A の親が A 自身)。
 *  - **(c) API・3つ以上の環**(A→B→C→A)。
 *  - **(d) 【最重要】純関数 `resolveRecordAccess` を直接呼び、`readRow` の呼び出し回数を
 *    数えて、同じ (表, 行) を2度読んでいないことを固定する。** **段数の上限(のちに5段)より
 *    短い環(長さ2)で測ることで、「上限があるから止まった」のではなく「訪問済み集合が
 *    止めた」ことを実測で示す。**
 *  - **(e) 循環しても判定は正常に完了する**(拒否に落ちない)。**環の中に実在する付与が
 *    届いていれば行が読める**ことを `API` から示す。
 *
 * ## **【誇張しない。本ファイルが測っていないこと】**
 *
 *  1. **段数・件数の上限**(`Z-G17` / `V7-M4-T04` の担当)。**今日の実装に上限は1つも無い。**
 *  2. **「上限に当たった」の応答と「循環を検出した」の応答の**対比の実測**。**今日はまだ
 *     打ち切り(`Z-G17`)が実装されていないため測れない。** (e) のテストのコメントに
 *     その旨を明記する。
 *  3. **性能を1件も測っていない。** **応答時間の上限(5秒)は「止まらないこと」の粗い
 *     目安であって、性能 SLO の主張ではない。**
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appDbPath,
  applyManifest,
  createApp,
  createRecord,
  KernelMetaStore,
  type Manifest,
} from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { resolveRecordAccess } from "./owner-scope.ts";
import { seedSession } from "./test-helpers.ts";

const APP_ID = "cycle-guard";

/** 権限名2つ(`T02` と同じ形。`Z-G14` 限定3: 各段で適用する規則は同一)。 */
const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる", read: true, write: true, delete: false },
] as const;

function declaration(target: string, inheritFrom: readonly string[]): Record<string, unknown> {
  return {
    enabled: true,
    permissions: [...PERMISSIONS],
    creator_permission: "writer",
    grant: { table: "cyc_grant", target, member: "member", permission: "permission" },
    members: { table: "cyc_member", account: "account" },
    inherit_from: [...inheritFrom],
  };
}

/**
 * **API レベルの循環マニフェスト。**
 *
 *  - `node_a` ⇄ `node_b`(**2段の循環**。完了条件 (a))。
 *  - `self_node`(**自己参照**。完了条件 (b))。
 *  - `loop_p` → `loop_q` → `loop_r` → `loop_p`(**3つの環**。完了条件 (c))。
 */
function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "循環検査",
      tables: [
        {
          id: "node_a",
          name: "A",
          fields: [
            { id: "title", name: "名前", type: "text", required: true },
            { id: "parent_b", name: "親(B)", type: "reference", reference_table: "node_b" },
          ],
          access_control: declaration("node_a", ["parent_b"]),
        },
        {
          id: "node_b",
          name: "B",
          fields: [
            { id: "title", name: "名前", type: "text", required: true },
            { id: "parent_a", name: "親(A)", type: "reference", reference_table: "node_a" },
          ],
          access_control: declaration("node_b", ["parent_a"]),
        },
        {
          id: "self_node",
          name: "自己参照",
          fields: [
            { id: "title", name: "名前", type: "text", required: true },
            { id: "parent", name: "親", type: "reference", reference_table: "self_node" },
          ],
          access_control: declaration("self_node", ["parent"]),
        },
        {
          id: "loop_p",
          name: "P",
          fields: [
            { id: "title", name: "名前", type: "text", required: true },
            { id: "parent_q", name: "親(Q)", type: "reference", reference_table: "loop_q" },
          ],
          access_control: declaration("loop_p", ["parent_q"]),
        },
        {
          id: "loop_q",
          name: "Q",
          fields: [
            { id: "title", name: "名前", type: "text", required: true },
            { id: "parent_r", name: "親(R)", type: "reference", reference_table: "loop_r" },
          ],
          access_control: declaration("loop_q", ["parent_r"]),
        },
        {
          id: "loop_r",
          name: "R",
          fields: [
            { id: "title", name: "名前", type: "text", required: true },
            { id: "parent_p", name: "親(P)", type: "reference", reference_table: "loop_p" },
          ],
          access_control: declaration("loop_r", ["parent_p"]),
        },
        {
          id: "cyc_member",
          name: "利用者",
          fields: [{ id: "account", name: "ログイン", type: "text" }],
        },
        {
          id: "cyc_grant",
          name: "付与",
          fields: [
            { id: "node_a", name: "A", type: "reference", reference_table: "node_a" },
            { id: "node_b", name: "B", type: "reference", reference_table: "node_b" },
            { id: "self_node", name: "自己参照", type: "reference", reference_table: "self_node" },
            { id: "loop_p", name: "P", type: "reference", reference_table: "loop_p" },
            { id: "loop_q", name: "Q", type: "reference", reference_table: "loop_q" },
            { id: "loop_r", name: "R", type: "reference", reference_table: "loop_r" },
            { id: "member", name: "相手", type: "reference", reference_table: "cyc_member" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
          ],
        },
      ],
      views: [],
    },
  } as unknown as Manifest;
}

let dataRoot = "";
let app: ReturnType<typeof createServerApp>;

/** 付与を1件も持たない人 / 環の中(B)にだけ付与を持つ人。 */
let nobody: ReturnType<typeof seedSession>;
let grantOnB: ReturnType<typeof seedSession>;

/** 行の id。 */
let a1 = "";
let b1 = "";
let s1 = "";
let p1 = "";

function withDb<T>(run: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

/**
 * **循環を作るための2度目の書込。** **`createRecord` は作成時にしか値を渡せないので、
 * 「両方の行が先に存在しないと張れない参照」(A⇄B / 自己参照 / P→Q→R→P)は、
 * 片方を作ったあとに直接 SQL で埋める。** **本ファイル限定の配線であり、`src/kernel/` の
 * 検査を経由しない書込みだが、読取側(判定)の挙動を確かめるための土台作りに過ぎない。**
 */
function setParent(table: string, recordId: string, column: string, parentId: string): void {
  withDb((db) => {
    db.query(`UPDATE ${table} SET ${column} = ? WHERE _id = ?`).run(parentId, recordId);
  });
}

async function get(path: string, cookie: string): Promise<Response> {
  return await app.request(path, { headers: { cookie } });
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-acc-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "循環検査", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, manifest()).valid).toBe(true);
  app = createServerApp({ dataRoot });

  nobody = seedSession(dataRoot, APP_ID, { role: "editor", username: "nobody" });
  grantOnB = seedSession(dataRoot, APP_ID, { role: "editor", username: "grant-on-b" });

  const loaded = manifest();
  withDb((db) => {
    const id = (result: unknown): string => (result as { value: { _id: string } }).value._id;

    // --- (a) 2段の循環: node_a ⇄ node_b ---------------------------------------
    a1 = id(createRecord(db, loaded, "node_a", { title: "A" }));
    b1 = id(createRecord(db, loaded, "node_b", { title: "B", parent_a: a1 }));
    setParent("node_a", a1, "parent_b", b1); // **ここで循環が閉じる。**

    // --- (b) 自己参照: self_node ------------------------------------------------
    s1 = id(createRecord(db, loaded, "self_node", { title: "S" }));
    setParent("self_node", s1, "parent", s1);

    // --- (c) 3つの環: loop_p → loop_q → loop_r → loop_p ------------------------
    p1 = id(createRecord(db, loaded, "loop_p", { title: "P" }));
    const r1 = id(createRecord(db, loaded, "loop_r", { title: "R", parent_p: p1 }));
    const q1 = id(createRecord(db, loaded, "loop_q", { title: "Q", parent_r: r1 }));
    setParent("loop_p", p1, "parent_q", q1); // **ここで環が閉じる。**

    // --- 利用者とメンバー行 -------------------------------------------------------
    const member = (account: string): string =>
      id(createRecord(db, loaded, "cyc_member", { account }));
    member(nobody.userId);
    const grantOnBMember = member(grantOnB.userId);

    // **`grantOnB` は環の中の B(node_b)にだけ付与を持つ。** **A への直接の付与は無い。**
    const created = createRecord(db, loaded, "cyc_grant", {
      node_b: b1,
      member: grantOnBMember,
      permission: "writer",
    });
    expect(created.ok).toBe(true);
  });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

/** 応答時間の粗い目安(**「止まらないこと」を測るためであり、性能 SLO の主張ではない**)。 */
const RESPONSE_TIME_BUDGET_MS = 5000;

// ---------------------------------------------------------------------------
// (a) API: 2段の循環(A の親が B、B の親が A)でも応答が返る
// ---------------------------------------------------------------------------

describe("V7-M4-T03 (a): 2段の循環(node_a ⇄ node_b)で API が応答を返す", () => {
  test("(a-1) 単件 GET(node_a)は応答が返る(サーバが止まらない)", async () => {
    const startedAt = Date.now();
    const response = await get(`/api/apps/${APP_ID}/tables/node_a/records/${a1}`, nobody.cookie);
    const elapsedMs = Date.now() - startedAt;
    // **付与を1件も持たない人からは 404**(循環が権限を作らない。fail-closed のまま)。
    expect(response.status).toBe(404);
    expect(elapsedMs).toBeLessThan(RESPONSE_TIME_BUDGET_MS);
  });

  test("(a-2) 単件 GET(node_b)も応答が返る(逆向きから辿っても止まる)", async () => {
    const startedAt = Date.now();
    const response = await get(`/api/apps/${APP_ID}/tables/node_b/records/${b1}`, nobody.cookie);
    const elapsedMs = Date.now() - startedAt;
    expect(response.status).toBe(404);
    expect(elapsedMs).toBeLessThan(RESPONSE_TIME_BUDGET_MS);
  });

  test("(a-3) 一覧 GET(node_a)は 200 で応答が返る(空配列)", async () => {
    const startedAt = Date.now();
    const response = await get(`/api/apps/${APP_ID}/tables/node_a/records`, nobody.cookie);
    const elapsedMs = Date.now() - startedAt;
    expect(response.status).toBe(200);
    const body = (await response.json()) as { records: unknown[] };
    expect(body.records).toEqual([]);
    expect(elapsedMs).toBeLessThan(RESPONSE_TIME_BUDGET_MS);
  });

  test("(a-4) 一覧 GET(node_b)も 200 で応答が返る", async () => {
    const startedAt = Date.now();
    const response = await get(`/api/apps/${APP_ID}/tables/node_b/records`, nobody.cookie);
    const elapsedMs = Date.now() - startedAt;
    expect(response.status).toBe(200);
    const body = (await response.json()) as { records: unknown[] };
    expect(body.records).toEqual([]);
    expect(elapsedMs).toBeLessThan(RESPONSE_TIME_BUDGET_MS);
  });
});

// ---------------------------------------------------------------------------
// (b) API: 自己参照(A の親が A 自身)でも応答が返る
// ---------------------------------------------------------------------------

describe("V7-M4-T03 (b): 自己参照(self_node)で API が応答を返す", () => {
  test("(b-1) 単件 GET は応答が返る", async () => {
    const startedAt = Date.now();
    const response = await get(`/api/apps/${APP_ID}/tables/self_node/records/${s1}`, nobody.cookie);
    const elapsedMs = Date.now() - startedAt;
    expect(response.status).toBe(404);
    expect(elapsedMs).toBeLessThan(RESPONSE_TIME_BUDGET_MS);
  });

  test("(b-2) 一覧 GET は 200 で応答が返る(空配列)", async () => {
    const startedAt = Date.now();
    const response = await get(`/api/apps/${APP_ID}/tables/self_node/records`, nobody.cookie);
    const elapsedMs = Date.now() - startedAt;
    expect(response.status).toBe(200);
    const body = (await response.json()) as { records: unknown[] };
    expect(body.records).toEqual([]);
    expect(elapsedMs).toBeLessThan(RESPONSE_TIME_BUDGET_MS);
  });
});

// ---------------------------------------------------------------------------
// (c) API: 3つ以上の環(A→B→C→A)でも応答が返る
// ---------------------------------------------------------------------------

describe("V7-M4-T03 (c): 3つの環(loop_p → loop_q → loop_r → loop_p)で API が応答を返る", () => {
  test("(c-1) 単件 GET は応答が返る", async () => {
    const startedAt = Date.now();
    const response = await get(`/api/apps/${APP_ID}/tables/loop_p/records/${p1}`, nobody.cookie);
    const elapsedMs = Date.now() - startedAt;
    expect(response.status).toBe(404);
    expect(elapsedMs).toBeLessThan(RESPONSE_TIME_BUDGET_MS);
  });

  test("(c-2) 一覧 GET は 200 で応答が返る(空配列)", async () => {
    const startedAt = Date.now();
    const response = await get(`/api/apps/${APP_ID}/tables/loop_p/records`, nobody.cookie);
    const elapsedMs = Date.now() - startedAt;
    expect(response.status).toBe(200);
    const body = (await response.json()) as { records: unknown[] };
    expect(body.records).toEqual([]);
    expect(elapsedMs).toBeLessThan(RESPONSE_TIME_BUDGET_MS);
  });
});

// ---------------------------------------------------------------------------
// (d) 【最重要】訪問済み集合が止めていることを、readRow の呼び出し回数で固定する
// ---------------------------------------------------------------------------

/**
 * **純関数レベルの循環マニフェスト**(`API` を経由しない。`resolveRecordAccess` に直接渡す)。
 *
 * **`cyc_x` ⇄ `cyc_y` の2段の環** —— **のちに `V7-M4-T04` が置く段数の上限(5段)より
 * 明確に短い**(2 < 5)。**この短さが本テストの証拠力の核心である** ——
 * **もし「段数の上限があるから止まった」のなら、上限が存在しない今日は
 * 無限に辿り続けて `readRow` が呼ばれ続けるはずである。実際には1回しか呼ばれない
 * (下記アサーション)。止めているのは訪問済み集合であって、存在しない上限ではない。**
 */
function pureCycleManifest(): Manifest {
  return {
    app: {
      id: "pure-cycle",
      name: "純関数版・2段の循環",
      tables: [
        {
          id: "cyc_x",
          name: "X",
          fields: [
            { id: "title", name: "名前", type: "text", required: true },
            { id: "parent_y", name: "親(Y)", type: "reference", reference_table: "cyc_y" },
          ],
          access_control: { enabled: true, inherit_from: ["parent_y"] },
        },
        {
          id: "cyc_y",
          name: "Y",
          fields: [
            { id: "title", name: "名前", type: "text", required: true },
            { id: "parent_x", name: "親(X)", type: "reference", reference_table: "cyc_x" },
          ],
          access_control: { enabled: true, inherit_from: ["parent_x"] },
        },
      ],
    },
  } as unknown as Manifest;
}

/** **純関数レベルの自己参照マニフェスト。** */
function pureSelfManifest(): Manifest {
  return {
    app: {
      id: "pure-self",
      name: "純関数版・自己参照",
      tables: [
        {
          id: "self_x",
          name: "S",
          fields: [
            { id: "title", name: "名前", type: "text", required: true },
            { id: "parent", name: "親", type: "reference", reference_table: "self_x" },
          ],
          access_control: { enabled: true, inherit_from: ["parent"] },
        },
      ],
    },
  } as unknown as Manifest;
}

describe("V7-M4-T03 (d): resolveRecordAccess は同じ (表, 行) を2度読まない", () => {
  test("(d-1) 長さ2の環(cyc_x ⇄ cyc_y): readRow はちょうど1回しか呼ばれない", () => {
    const rowX = { _id: "x-1", parent_y: "y-1" };
    const rowY = { _id: "y-1", parent_x: "x-1" };
    const readRowCalls: [string, string][] = [];
    const readRow = (tableId: string, recordId: string): Record<string, unknown> | undefined => {
      readRowCalls.push([tableId, recordId]);
      if (tableId === "cyc_y" && recordId === "y-1") return rowY;
      if (tableId === "cyc_x" && recordId === "x-1") return rowX;
      return undefined;
    };

    const resolution = resolveRecordAccess({
      manifest: pureCycleManifest(),
      tableId: "cyc_x",
      row: rowX,
      actorId: "user-a",
      readRows: () => [],
      readRow,
    });

    // **判定は正常に完了する**(拒否に落ちない。限定3)。
    expect(resolution.kind).toBe("verdict");

    // **【核心】`readRow` は1回しか呼ばれていない** —— **段0(`x-1`)は最初から `row` として
    // 渡されているので読まない。段1(`y-1`)を読むために1回呼ばれる。段2で `x-1` に
    // 戻ろうとするが、`x-1` は既に訪問済み集合に入っているので、`readRow` を呼ぶ前に
    // 枝が止まる**(`owner-scope.ts:1149` の `visited.has(...)` チェック)。
    expect(readRowCalls.length).toBe(1);
    expect(readRowCalls[0]).toEqual(["cyc_y", "y-1"]);

    // **呼ばれた (表, 行) の対に重複が無い**(=同じ対を2度読んでいないことの機械的な固定)。
    const uniqueKeys = new Set(readRowCalls.map(([tableId, recordId]) => `${tableId}:${recordId}`));
    expect(uniqueKeys.size).toBe(readRowCalls.length);
  });

  test("(d-2) 自己参照(self_x → self_x): readRow は1度も呼ばれない", () => {
    const row = { _id: "s-1", parent: "s-1" };
    const readRowCalls: [string, string][] = [];
    const readRow = (tableId: string, recordId: string): Record<string, unknown> | undefined => {
      readRowCalls.push([tableId, recordId]);
      return undefined;
    };

    const resolution = resolveRecordAccess({
      manifest: pureSelfManifest(),
      tableId: "self_x",
      row,
      actorId: "user-a",
      readRows: () => [],
      readRow,
    });

    expect(resolution.kind).toBe("verdict");
    // **段0 の時点で (表, 行) = (self_x, s-1) が訪問済みに入るので、親(同じ行)を
    // 積む前に枝が止まる。`readRow` を呼ぶ機会そのものが1度も無い。**
    expect(readRowCalls.length).toBe(0);
  });

  test("(d-3) 長さ3の環(loop_x → loop_y → loop_z → loop_x): readRow はちょうど2回", () => {
    const manifestObj: Manifest = {
      app: {
        id: "pure-loop3",
        name: "純関数版・3段の環",
        tables: [
          {
            id: "loop_x",
            name: "X",
            fields: [
              { id: "title", name: "名前", type: "text", required: true },
              { id: "parent_y", name: "親(Y)", type: "reference", reference_table: "loop_y" },
            ],
            access_control: { enabled: true, inherit_from: ["parent_y"] },
          },
          {
            id: "loop_y",
            name: "Y",
            fields: [
              { id: "title", name: "名前", type: "text", required: true },
              { id: "parent_z", name: "親(Z)", type: "reference", reference_table: "loop_z" },
            ],
            access_control: { enabled: true, inherit_from: ["parent_z"] },
          },
          {
            id: "loop_z",
            name: "Z",
            fields: [
              { id: "title", name: "名前", type: "text", required: true },
              { id: "parent_x", name: "親(X)", type: "reference", reference_table: "loop_x" },
            ],
            access_control: { enabled: true, inherit_from: ["parent_x"] },
          },
        ],
      },
    } as unknown as Manifest;

    const rowX = { _id: "x-1", parent_y: "y-1" };
    const rowY = { _id: "y-1", parent_z: "z-1" };
    const rowZ = { _id: "z-1", parent_x: "x-1" };
    const readRowCalls: [string, string][] = [];
    const readRow = (tableId: string, recordId: string): Record<string, unknown> | undefined => {
      readRowCalls.push([tableId, recordId]);
      if (tableId === "loop_y" && recordId === "y-1") return rowY;
      if (tableId === "loop_z" && recordId === "z-1") return rowZ;
      if (tableId === "loop_x" && recordId === "x-1") return rowX;
      return undefined;
    };

    const resolution = resolveRecordAccess({
      manifest: manifestObj,
      tableId: "loop_x",
      row: rowX,
      actorId: "user-a",
      readRows: () => [],
      readRow,
    });

    expect(resolution.kind).toBe("verdict");
    // **段0(x-1)は渡された行。段1(y-1)・段2(z-1)を読むために2回呼ばれ、段3で
    // x-1 に戻ろうとした瞬間に訪問済みで止まる。** **環の長さが伸びても「訪問済み集合が
    // 止めている」ことに変わりが無いことを、2段の環(d-1)との対比で示す。**
    expect(readRowCalls.length).toBe(2);
    const uniqueKeys = new Set(readRowCalls.map(([tableId, recordId]) => `${tableId}:${recordId}`));
    expect(uniqueKeys.size).toBe(readRowCalls.length);
  });
});

// ---------------------------------------------------------------------------
// (e) 循環を検出しても拒否に落とさない —— 判定は正常に完了する
// ---------------------------------------------------------------------------

describe("V7-M4-T03 (e): 循環していても、環の中に実在する付与が届けば行が読める", () => {
  test("(e-1) 環の中(B)にある付与が、A まで届く(200)", async () => {
    // **`grantOnB` は node_b(=B)にだけ付与を持つ。node_a(=A)への直接の付与は無い。**
    // **A の親は B、B の親は A という循環構造の中で、A → B と辿って B の付与を見つけ、
    // かつ B → A へ戻ろうとする枝は訪問済みで止まる** —— **循環があっても判定は
    // 「拒否」に落ちず、実在する付与のとおり読める。**
    const response = await get(`/api/apps/${APP_ID}/tables/node_a/records/${a1}`, grantOnB.cookie);
    expect(response.status).toBe(200);
  });

  test("(e-2) 付与を持たない人は、同じ循環構造でも 404 のまま(循環が権限を作らない)", async () => {
    const response = await get(`/api/apps/${APP_ID}/tables/node_a/records/${a1}`, nobody.cookie);
    expect(response.status).toBe(404);
  });

  /*
   * **【正直に書く。今日は測れない】**
   *
   * `Z-G16` の限定3 は「循環の検出は拒否に落とさず正常完了する。これは `Z-G17` の
   * 打ち切り(のちに 4xx)とは応答の形が違う」と定めている。**その対比 ——
   * 「循環に当たったときの応答」と「段数・件数の上限に当たったときの応答」を
   * 実際に並べて比べること —— は、本ファイルでは行っていない。**
   *
   * 理由: **段数・件数の上限(`Z-G17`)は今日1つも実装されていない**
   * (`V7-M4-T04` の担当。`owner-scope.ts:1061` の doc コメントが同じことを書いている)。
   * 上に見えているのはどちらも「循環していても 200 / 404 という**今日どおりの**
   * 応答が返る」ことだけであり、「打ち切りの 4xx」という比較対象そのものが
   * 存在しない。**この対比の実測は `V7-M4-T04` の担当であり、本タスクでは
   * 「今日は測れない」とだけ正直に書く。**
   */
});
