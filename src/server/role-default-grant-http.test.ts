/**
 * **`V8-M26-T04`(実 HTTP)—— 作った直後に、持ち主がその表を読み書き削除できることの検査。**
 *
 * ユーザ決定 `D-V8-56` の説明文の逐語「**作った直後から本人には見えます**」の履行を、
 * **実 HTTP + 本物の SQLite** で示す(`src/kernel/role-default-grant.test.ts` は
 * マニフェストの形だけを測っており、行に1バイトも触っていない)。
 *
 * ## この検査が測る経路
 *
 * 1. **`applyDiff` で表と画面を作る**(`add_table` / `add_view`)——
 *    **自動付与はここで走る**(`applyManifest` では走らない)。
 * 2. **`createServerApp` を立て、既定3役割それぞれのセッションで実際に叩く。**
 *
 * ## この検査が固定していないこと(**誇張しない**)
 *
 * - **`V8-M26-T03` より前に作られた表には1本も入らない** —— **本ファイルはその向きを
 *   測っておらず、実測は `src/server/role-default-closed.test.ts` の (a)〜(d) が持つ。**
 * - **`anonymous` には1本も入らない** —— **未ログインの向きは形の検査
 *   (`src/kernel/role-default-grant.test.ts` の (d))が持つ。**
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyDiff,
  applyManifest,
  createApp,
  KernelMetaStore,
  type Manifest,
} from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN } from "./test-helpers.ts";

const APP_ID = "grant-http-shop";

let dataRoot: string | undefined;
let app: ReturnType<typeof createServerApp>;

/** **役割は3本とも宣言するが、規則は1本も書かない**(自動付与だけを測る土台)。 */
function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "自動付与の店",
      tables: [
        {
          id: "seed",
          name: "土台",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
        },
      ],
      views: [{ id: "seed-list", type: "list_view", table: "seed", columns: ["title"] }],
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
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

/** **表と画面を差分で作る** —— **自動付与が走るのはこの経路だけである。** */
async function boot(): Promise<void> {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-role-default-grant-http-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "自動付与の店", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, baseManifest()).valid).toBe(true);
  const created = applyDiff(dataRoot, APP_ID, {
    diff_id: "d-create",
    intent: "表と画面を作る",
    operations: [
      {
        op: "add_table",
        table: {
          id: "orders",
          name: "注文",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
        },
      },
      {
        op: "add_view",
        view: { id: "order-list", type: "list_view", table: "orders", columns: ["title"] },
      },
    ],
  });
  expect(created.valid).toBe(true);
  app = createServerApp({ dataRoot });
}

afterEach(async () => {
  if (dataRoot !== undefined) {
    await rm(dataRoot, { recursive: true, force: true });
    dataRoot = undefined;
  }
});

function req(
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
  extra?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = { origin: TEST_ORIGIN, cookie, ...(extra ?? {}) };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return Promise.resolve(app.request(new Request(`http://localhost${path}`, init)));
}

const records = (table: string) => `/api/apps/${APP_ID}/tables/${table}/records`;

function session(role: "owner" | "editor" | "viewer") {
  return seedSession(dataRoot as string, APP_ID, {
    role,
    username: `${role}-${Math.random().toString(36).slice(2, 10)}`,
  });
}

// ---------------------------------------------------------------------------
// (g) 作った直後に、持ち主が読み書き削除できる
// ---------------------------------------------------------------------------

test("(g) 表を作った直後、持ち主は実 HTTP でその表を作成・一覧・更新・削除できる", async () => {
  await boot();
  const owner = session("owner");

  // --- 作成 ---
  const created = await req(owner.cookie, "POST", records("orders"), { title: "梅干し" });
  expect(created.status).toBe(201);
  const row = ((await created.json()) as { record: Record<string, unknown> }).record;

  // --- 一覧(**作った直後から本人には見える**) ---
  const listed = await req(owner.cookie, "GET", records("orders"));
  expect(listed.status).toBe(200);
  expect(
    ((await listed.json()) as { records: { _id: string }[] }).records.map((r) => r._id),
  ).toEqual([row._id as string]);

  // --- 単件 ---
  const path = `${records("orders")}/${row._id as string}`;
  const one = await req(owner.cookie, "GET", path);
  expect(one.status).toBe(200);

  // --- 更新(**楽観ロックの `If-Match` は今日どおり要る**) ---
  const updated = await req(
    owner.cookie,
    "PATCH",
    path,
    { title: "沢庵" },
    {
      "if-match": row._updated_at as string,
    },
  );
  expect(updated.status).toBe(200);
  const after = ((await updated.json()) as { record: Record<string, unknown> }).record;

  // --- 削除(**`If-Match` は削除にも要る** —— 付けないと 400 で返る。実測) ---
  const removed = await req(owner.cookie, "DELETE", path, undefined, {
    "if-match": after._updated_at as string,
  });
  expect([200, 204]).toContain(removed.status);
});

test("(g-2) 作った直後の画面を名乗った一覧も、持ち主は 200 で読める(画面の規則も自動で入る)", async () => {
  await boot();
  const owner = session("owner");
  await req(owner.cookie, "POST", records("orders"), { title: "梅干し" });
  const res = await req(owner.cookie, "GET", `${records("orders")}?view=order-list`);
  expect(res.status).toBe(200);
});

test("(g-3) 編集者は見る+書くまで、閲覧者は見るだけ(D-V8-61 の逐語)", async () => {
  await boot();
  const owner = session("owner");
  const editor = session("editor");
  const viewer = session("viewer");
  const created = await req(owner.cookie, "POST", records("orders"), { title: "梅干し" });
  expect(created.status).toBe(201);
  const row = ((await created.json()) as { record: Record<string, unknown> }).record;
  const path = `${records("orders")}/${row._id as string}`;

  // **編集者**: 読める・書ける。
  expect((await req(editor.cookie, "GET", records("orders"))).status).toBe(200);
  const editorWrite = await req(
    editor.cookie,
    "PATCH",
    path,
    { title: "沢庵" },
    {
      "if-match": row._updated_at as string,
    },
  );
  expect(editorWrite.status).toBe(200);

  // **閲覧者**: 読めるが、書けない。
  expect((await req(viewer.cookie, "GET", records("orders"))).status).toBe(200);
  const viewerWrite = await req(viewer.cookie, "POST", records("orders"), { title: "だめ" });
  expect(viewerWrite.status).toBe(403);
});
