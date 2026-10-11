/**
 * **`V21-M2-T00`(`ADR-0482` の `AN-G1` / `AN-G3`)—— 未ログインの表ごとの読取。TDD の赤。**
 *
 * ## 本ファイルが固定するもの
 *
 * **表に「未ログインでも読める」(未ログインの役割の表の読取規則)を書き、公開の印
 * (`st_public`)を持たない表は、未ログインで一覧・単件・子一覧を読める**(`ADR-0482` §1-1)。
 * 条件(`when`)つきの規則なら、条件に合う行だけが見え、合わない行の単件は 404。
 *
 * **開かないもの**(今日どおり 401 のまま。`ADR-0482` §1-2 / `D-V21-14`):
 *  - 所有者で絞る表(`st_owner`)/ 行ごとの付与を有効にした表 / 付与・名簿の表
 *  - いずれかの役割の読取規則の条件に「自分」が在る表(§1-1 の (iii-b))
 *  - 未ログインの読取規則を持たない表
 *  - 書込(作成・更新・削除・一括)/ 集計表 / `file` 型の配信
 *
 * **対照**(答えが1ビットも変わらないこと):
 *  - `st_public` を持つ表は今日どおり公開行だけ(非公開行の単件は 404)
 *  - ログインした人の答え(一覧の件数・予約規約フィールド込み)
 *  - ログインした人の名乗らない読取の壁(`ADR-0435` の `PM-G10`)は今日どおり閉じる
 *
 * **名乗らない読取の壁は、表ごとの読取の枝の未ログインにだけ掛けない**(`ADR-0482` §1-5)——
 * 子一覧の対照は本ファイル(計画 §9-6 の `V21-M2`)。参照の名前表示の対照は `V21-M3`。
 *
 * **本ファイルは隠す項目(`hidden_fields`)を1本も測らない**(`V21-M2B` の担当)。
 *
 * **【置き場所】`src/kernel/` に置いた。** `src/server/` に置くと、カーネルの値の import
 * (`createApp` / `applyManifest` / `KernelMetaStore`)が層またぎの一覧
 * (`scripts/kernel-import-drift.test.ts`。`ADR-0009` 限定2)に3行増え、授権(`ADR-0483`)の外の
 * 基準ファイルを書き換えることになるため。 先例は `src/kernel/role-default-grant-http.test.ts`。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerApp } from "../server/app.ts";
import { OWNER_FIELD, PUBLIC_FIELD } from "../server/owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "../server/test-helpers.ts";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "./index.ts";

const APP_ID = "anon-table-read";

type Any = Record<string, unknown>;

const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる", read: true, write: true, delete: false },
] as const;

/**
 * **題材。**
 *
 * | 表 | 未ログインの読取規則 | 公開の印 | 期待 |
 * |---|---|---|---|
 * | `t_anon` | 条件なし | 無し | 一覧・単件 200(全行)|
 * | `t_child` | 条件なし | 無し | 子一覧 200 |
 * | `t_cond` | 条件つき(`status = open`)| 無し | 一覧は合う行だけ / 合わない行の単件 404 |
 * | `t_public` | 条件なし | 在る | 今日どおり公開行だけ |
 * | `t_norule` | 無し | 無し | 401 |
 * | `t_owner` | 条件なし | 無し(`st_owner` を持つ)| 401 |
 * | `t_ac` / `t_ac_grant` / `t_ac_member` | 条件なし | 無し(付与を有効にした表と付与・名簿の表)| 401 |
 * | `t_self` | 条件なし | 無し(`editor` の規則の条件に「自分」)| 401 |
 *
 * **画面**: `t_anon` / `t_child` には未ログインに開いていない一覧画面・詳細画面を置く
 * (名乗らない読取の壁が今日なら閉じる形)。
 */
function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "未ログインの表ごとの読取",
      tables: [
        {
          id: "t_anon",
          name: "商品",
          fields: [
            { id: "name", name: "名前", type: "text", required: true },
            { id: "photo", name: "写真", type: "image" },
            { id: "spec", name: "仕様書", type: "file" },
          ],
        },
        {
          id: "t_child",
          name: "口コミ",
          fields: [
            { id: "parent", name: "商品", type: "reference", reference_table: "t_anon" },
            { id: "note", name: "本文", type: "text" },
          ],
        },
        {
          id: "t_cond",
          name: "条件つき",
          fields: [
            { id: "title", name: "題", type: "text", required: true },
            { id: "status", name: "状態", type: "text" },
            { id: "photo", name: "写真", type: "image" },
          ],
        },
        {
          id: "t_public",
          name: "公開の印の表",
          fields: [
            { id: "name", name: "名前", type: "text", required: true },
            { id: "photo", name: "写真", type: "image" },
            { id: PUBLIC_FIELD, name: "公開", type: "boolean" },
          ],
        },
        {
          id: "t_norule",
          name: "規則の無い表",
          fields: [{ id: "sku", name: "SKU", type: "text", required: true }],
        },
        {
          id: "t_owner",
          name: "所有者で絞る表",
          fields: [
            { id: "title", name: "題", type: "text", required: true },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
          ],
        },
        {
          id: "t_ac",
          name: "付与の表で守る表",
          fields: [{ id: "title", name: "題", type: "text", required: true }],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "writer",
            grant: {
              table: "t_ac_grant",
              target: "row",
              member: "member",
              permission: "permission",
            },
            members: { table: "t_ac_member", account: "account" },
          },
        },
        {
          id: "t_ac_member",
          name: "利用者",
          fields: [{ id: "account", name: "ログイン", type: "text" }],
        },
        {
          id: "t_ac_grant",
          name: "付与",
          fields: [
            { id: "row", name: "行", type: "reference", reference_table: "t_ac" },
            { id: "member", name: "相手", type: "reference", reference_table: "t_ac_member" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
          ],
        },
        {
          id: "t_self",
          name: "「自分」の条件を持つ表",
          fields: [
            { id: "title", name: "題", type: "text", required: true },
            { id: "assignee", name: "担当", type: "text" },
          ],
        },
      ],
      views: [
        { id: "v_anon_admin", type: "list_view", table: "t_anon", columns: ["name"] },
        { id: "v_anon_detail_admin", type: "detail_view", table: "t_anon", fields: ["name"] },
        { id: "v_child_admin", type: "list_view", table: "t_child", columns: ["note"] },
        {
          id: "v_rep",
          type: "report_view",
          table: "t_child",
          name: "集計",
          report: { group_by: [{ field: "parent" }], aggregates: [{ type: "count" }] },
        },
      ],
      roles: [
        {
          id: "editor",
          name: "編集者",
          rules: [
            {
              target: "table",
              table: "t_self",
              can: ["read"],
              when: { field: "assignee", equals_current_user: true },
            },
          ],
        },
        {
          // **ログインした人の壁の対照**: 表は読めるが、画面は1枚も読めない役割。
          id: "partner",
          name: "協力会社",
          rules: [{ target: "table", table: "t_anon", can: ["read"] }],
        },
        {
          id: "anonymous",
          name: "未ログイン",
          rules: [
            { target: "table", table: "t_anon", can: ["read"] },
            { target: "table", table: "t_child", can: ["read"] },
            {
              target: "table",
              table: "t_cond",
              can: ["read"],
              when: { field: "status", equals: "open" },
            },
            { target: "table", table: "t_public", can: ["read"] },
            { target: "table", table: "t_owner", can: ["read"] },
            { target: "table", table: "t_ac", can: ["read"] },
            { target: "table", table: "t_ac_member", can: ["read"] },
            { target: "table", table: "t_ac_grant", can: ["read"] },
            { target: "table", table: "t_self", can: ["read"] },
          ],
        },
      ],
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
let ownerCookie: string;
/** `t_anon` の行 id(3行)。 */
let anonIds: string[] = [];
/** `t_child` の行 id(`t_anon` の1行目に2行、2行目に1行)。 */
let childIds: string[] = [];
let condOpen = "";
let condClosed = "";
let publicOpen = "";
let publicClosed = "";
let fileAnonImage = "";
let fileAnonFile = "";
let fileCondOpen = "";
let fileCondClosed = "";
let filePublicClosed = "";
let ownerRow = "";

function pngBytes(tag: number): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, tag, tag + 1, tag + 2]);
}

function makeApp(clock?: { now: () => number }): ReturnType<typeof createServerApp> {
  if (clock === undefined) {
    return createServerApp({ dataRoot });
  }
  return createServerApp({
    dataRoot,
    rateLimit: {
      publicGet: { limit: 2, windowMs: 1_000, now: clock.now },
      auth: { limit: 100, windowMs: 1_000, now: clock.now },
    },
  } as Parameters<typeof createServerApp>[0]);
}

async function upload(tag: number): Promise<string> {
  const form = new FormData();
  form.set("file", new Blob([Uint8Array.from(pngBytes(tag))]), `f${tag}.png`);
  const res = await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/files`, {
      method: "POST",
      headers: { cookie: ownerCookie, origin: TEST_ORIGIN },
      body: form,
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { file_id: string }).file_id;
}

async function create(table: string, body: Any): Promise<string> {
  const res = await app.request(
    new Request(`http://localhost${R(table)}`, {
      method: "POST",
      headers: { cookie: ownerCookie, origin: TEST_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  expect(res.status, `create ${table} -> ${await res.clone().text()}`).toBe(201);
  return ((await res.json()) as { record: { _id: string } }).record._id;
}

const R = (table: string, id?: string, query = "") =>
  `/api/apps/${APP_ID}/tables/${table}/records${id === undefined ? "" : `/${id}`}${query}`;

function get(path: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  return Promise.resolve(app.request(new Request(`http://localhost${path}`, { headers })));
}

function anonWrite(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: { origin: TEST_ORIGIN, "content-type": "application/json" },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return Promise.resolve(app.request(new Request(`http://localhost${path}`, init)));
}

async function listIds(path: string, cookie?: string): Promise<{ ids: string[]; total: number }> {
  const res = await get(path, cookie);
  expect(res.status, `${path} -> ${await res.clone().text()}`).toBe(200);
  const body = (await res.json()) as { records: Any[]; total: number };
  return { ids: body.records.map((row) => String(row._id)).sort(), total: body.total };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-anon-table-read-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "未ログインの表ごとの読取", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **既定3役割の規則は `withDefaultRoleRules` が足す**(表の読み書き・画面の読取)。
  // **未ログイン・`partner` の規則は題材が手で書いたものだけ**(既定は1本も足さない)。
  const applied = applyManifest(dataRoot, APP_ID, withDefaultRoleRules(manifest()));
  expect(applied.valid, JSON.stringify(applied)).toBe(true);
  app = makeApp();
  ownerCookie = seedSession(dataRoot, APP_ID).cookie;

  fileAnonImage = await upload(10);
  fileAnonFile = await upload(20);
  fileCondOpen = await upload(30);
  fileCondClosed = await upload(40);
  const filePublicOpen = await upload(50);
  filePublicClosed = await upload(60);

  anonIds = [
    await create("t_anon", { name: "一", photo: fileAnonImage, spec: fileAnonFile }),
    await create("t_anon", { name: "二" }),
    await create("t_anon", { name: "三" }),
  ];
  childIds = [
    await create("t_child", { parent: anonIds[0], note: "a" }),
    await create("t_child", { parent: anonIds[0], note: "b" }),
    await create("t_child", { parent: anonIds[1], note: "c" }),
  ];
  condOpen = await create("t_cond", { title: "開", status: "open", photo: fileCondOpen });
  condClosed = await create("t_cond", { title: "閉", status: "closed", photo: fileCondClosed });
  publicOpen = await create("t_public", {
    name: "公開",
    photo: filePublicOpen,
    [PUBLIC_FIELD]: true,
  });
  publicClosed = await create("t_public", {
    name: "非公開",
    photo: filePublicClosed,
    [PUBLIC_FIELD]: false,
  });
  await create("t_norule", { sku: "x" });
  ownerRow = await create("t_owner", { title: "持ち主の行" });
  await create("t_self", { title: "担当つき", assignee: "someone" });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

// --- (A) 表ごとの読取の陽性(C1)---------------------------------------------------------

test("(A-1) 未ログイン: 規則あり・公開の印なしの表の一覧は 200、total は全行数", async () => {
  const { ids, total } = await listIds(R("t_anon"));
  expect(total).toBe(3);
  expect(ids).toEqual([...anonIds].sort());
});

test("(A-2) 未ログイン: 同じ表の単件は 200", async () => {
  const res = await get(R("t_anon", anonIds[1]));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { record: Any };
  expect(body.record._id).toBe(anonIds[1]);
  expect(body.record.name).toBe("二");
});

test("(A-3) 未ログイン: 子一覧(詳細画面の子一覧と同じ URL)は 200、件数は DB の子の行数", async () => {
  const { ids, total } = await listIds(R("t_child", undefined, `?filter.parent=${anonIds[0]}`));
  expect(total).toBe(2);
  expect(ids).toEqual(childIds.slice(0, 2).sort());
});

test("(A-4) 未ログイン: 予約規約フィールドは応答に載らない(射影)", async () => {
  const { ids } = await listIds(R("t_anon"));
  expect(ids).toHaveLength(3);
  const res = await get(R("t_anon"));
  const { records } = (await res.json()) as { records: Any[] };
  for (const row of records) {
    expect(Object.keys(row).filter((key) => key.startsWith("st_"))).toEqual([]);
  }
});

// --- (B) 条件つきの規則(計画 §9-1 の重2)-------------------------------------------------

test("(B-1) 未ログイン: 条件つきの規則の表は、条件に合う行だけが一覧に出る", async () => {
  const { ids, total } = await listIds(R("t_cond"));
  expect(total).toBe(1);
  expect(ids).toEqual([condOpen]);
});

test("(B-2) 未ログイン: 条件に合う行の単件は 200、合わない行の単件は 404", async () => {
  expect((await get(R("t_cond", condOpen))).status).toBe(200);
  expect((await get(R("t_cond", condClosed))).status).toBe(404);
});

// --- (C) 書込は今日どおり 401(C2)--------------------------------------------------------

test("(C-1) 未ログイン: 規則のある表でも作成・更新・削除・一括書込は 401", async () => {
  expect((await anonWrite("POST", R("t_anon"), { name: "x" })).status).toBe(401);
  expect((await anonWrite("PATCH", R("t_anon", anonIds[0]), { name: "y" })).status).toBe(401);
  expect((await anonWrite("DELETE", R("t_anon", anonIds[0]))).status).toBe(401);
  const batch = await anonWrite("POST", `/api/apps/${APP_ID}/batch`, {
    operations: [{ op: "create", table: "t_anon", values: { name: "z" } }],
  });
  expect(batch.status).toBe(401);
  // **行は1件も増えていない。**
  expect((await listIds(R("t_anon"))).total).toBe(3);
});

// --- (D) 開かない表は今日どおり 401(C3 / C6')---------------------------------------------

test("(D-1) 未ログイン: 規則の無い表は 401(一覧・単件)", async () => {
  expect((await get(R("t_norule"))).status).toBe(401);
  expect((await get(R("t_norule", "x"))).status).toBe(401);
});

test("(D-2) 未ログイン: 所有者で絞る表は、規則を書いても 401", async () => {
  expect((await get(R("t_owner"))).status).toBe(401);
  expect((await get(R("t_owner", ownerRow))).status).toBe(401);
});

test("(D-3) 未ログイン: 付与を有効にした表・付与の表・名簿の表は、規則を書いても 401", async () => {
  for (const table of ["t_ac", "t_ac_grant", "t_ac_member"]) {
    expect(`${table}:${(await get(R(table))).status}`).toBe(`${table}:401`);
    expect(`${table}:${(await get(R(table, "x"))).status}`).toBe(`${table}:401`);
  }
});

test("(D-4) 未ログイン: 「自分」の条件を持つ規則が在る表は、未ログインの規則を書いても 401", async () => {
  expect((await get(R("t_self"))).status).toBe(401);
  expect((await get(R("t_self", "x"))).status).toBe(401);
});

// --- (E) 公開の印の表は1ビットも変わらない(C4)-------------------------------------------

test("(E-1) 未ログイン: 公開の印の表は今日どおり公開行だけ、非公開行の単件は 404", async () => {
  const { ids, total } = await listIds(R("t_public"));
  expect(total).toBe(1);
  expect(ids).toEqual([publicOpen]);
  expect((await get(R("t_public", publicOpen))).status).toBe(200);
  expect((await get(R("t_public", publicClosed))).status).toBe(404);
});

// --- (F) ログインした人の答えは変わらない ------------------------------------------------

test("(F-1) ログイン済み(owner): 表ごとの読取の表も今日どおり全行", async () => {
  const { total } = await listIds(R("t_anon"), ownerCookie);
  expect(total).toBe(3);
  const cond = await listIds(R("t_cond"), ownerCookie);
  expect(cond.total).toBe(2);
});

test("(F-2) ログイン済み: 画面を1枚も読めない役割の名乗らない読取は、今日どおり壁で 0件・単件 404", async () => {
  const partner = seedSession(dataRoot, APP_ID, { role: "partner" });
  const { ids, total } = await listIds(R("t_anon"), partner.cookie);
  expect(total).toBe(0);
  expect(ids).toEqual([]);
  expect((await get(R("t_anon", anonIds[0]), partner.cookie)).status).toBe(404);
});

// --- (G) 画像の配信(C8)------------------------------------------------------------------

function file(fileId: string): Promise<Response> {
  return get(`/api/apps/${APP_ID}/files/${fileId}`);
}

test("(G-1) 未ログイン: 読める行の image は 200", async () => {
  expect((await file(fileAnonImage)).status).toBe(200);
  expect((await file(fileCondOpen)).status).toBe(200);
});

test("(G-2) 未ログイン: 読める行の file 型は配らない(404)", async () => {
  expect((await file(fileAnonFile)).status).toBe(404);
});

test("(G-3) 未ログイン: 条件に合わない行の image・公開の印の表の非公開行の image は 404", async () => {
  expect((await file(fileCondClosed)).status).toBe(404);
  expect((await file(filePublicClosed)).status).toBe(404);
});

// --- (H) 集計表と回数の制限(C9)---------------------------------------------------------

test("(H-1) 未ログイン: 集計表は今日どおり 401", async () => {
  expect((await get(`/api/apps/${APP_ID}/views/v_rep/report`)).status).toBe(401);
});

test("(H-2) 未ログイン: 表ごとの読取にも回数の制限が掛かる(上限+1 回目が 429 と Retry-After)", async () => {
  const clock = { value: 1_000, now: () => clock.value };
  app = makeApp(clock);
  expect((await get(R("t_anon"))).status).toBe(200);
  expect((await get(R("t_anon"))).status).toBe(200);
  const limited = await get(R("t_anon"));
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).not.toBeNull();
});
