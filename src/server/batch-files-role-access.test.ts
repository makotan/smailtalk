/**
 * **`V8-M27-T03` —— まとめ書き込み(`POST /api/apps/:app_id/batch`)と
 * ファイルのアップロード(`POST /api/apps/:app_id/files`)に、面(役割に束ねた権限)を
 * 効かせることの検査。**
 *
 * ユーザ決定 `D-V8-71`(`docs/plan/v8/03-user-decisions.md` §4p)の逐語:
 * > **まとめ書き込みとファイルのアップロードにも役割の規則を効かせてから、古い層を外します。**
 * > **穴が一瞬も開きませんが、この回の作業が増えます。**
 * > **まとめ書き込みは複数の表をまたぐので、どの表の権限を見るかを決める必要があります。**
 *
 * ## 「どの表の権限を見るか」(本タスクで決めたこと)
 *
 * - **まとめ書き込み**: **要求に含まれる op が触る表を全部集め、そのすべてについて
 *   動詞ごとの判定を通す。1つでも通らなければ要求全体を拒否する**(AND)。
 *   **部分適用を作らない**(`writeRecords` は1 IMMEDIATE トランザクションである)。
 * - **ファイルのアップロード**: **要求は表を1つも名乗らない**(実測。`multipart` のパートは
 *   `kind` と `file` の2つだけで、書き込む先は システムテーブル `_files` である)。
 *   **したがって「結び付く表」は要求からは決まらない。** **代わりに、上げたファイルが
 *   最終的に着地しうる先 —— `image` / `file` 型の項目を持つ表 —— を全部集め、
 *   そのうち1つでも書込を許されていれば通す**(OR)。**1つも無ければ 403。**
 *
 * ## この検査が固定していないこと(誇張しない)
 *
 * - **古い層(`hasAdminWriteRole`。「運営の予約3ロールか否か」)は今日も両経路に立っている。**
 *   **本ファイルは2枚目の壁(面)だけを測る** —— **`editor` は古い層を通り抜けたうえで
 *   面に止められる、という形で測ってある。** 古い層の撤去は `V8-M27` の次のタスクである。
 * - **点(行ごとの付与)との合成は測っていない** —— それは
 *   `src/server/role-grant-union.test.ts` の担当である。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN } from "./test-helpers.ts";

const APP_ID = "wire-shop";

/**
 * 題材の役割宣言。
 *
 * - `orders` … **`owner` だけが読み・書き・消せる。** **`image` 項目を持つ唯一の表である。**
 * - `archive` … **3役割とも「見る」しか書いていない。**
 * - `ledger` … **どの役割も名指ししていない**(= 既定が閉じる。`V8-M26` / `D-V8-45`)。
 */
const ROLES = [
  {
    id: "owner",
    name: "持ち主",
    rules: [
      // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
      { target: "app", can: ["write"] },
      { target: "role", can: ["write"] },
      { target: "table", table: "orders", can: ["read", "write", "delete"] },
      { target: "table", table: "archive", can: ["read"] },
    ],
  },
  {
    id: "editor",
    name: "編集者",
    rules: [{ target: "table", table: "archive", can: ["read"] }],
  },
  { id: "viewer", name: "閲覧者" },
];

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "配線の店",
      tables: [
        {
          id: "orders",
          name: "注文",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "photo", name: "写真", type: "image" },
          ],
        },
        {
          id: "archive",
          name: "書庫",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
        },
        {
          id: "ledger",
          name: "台帳",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
        },
      ],
      views: [],
      roles: ROLES,
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
let owner: ReturnType<typeof seedSession>;
let editor: ReturnType<typeof seedSession>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-wire-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "配線の店", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, manifest()).valid).toBe(true);
  app = createServerApp({ dataRoot });
  owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  editor = seedSession(dataRoot, APP_ID, { role: "editor" });
});

afterEach(async () => {
  await rm(dataRoot as string, { recursive: true, force: true });
});

function batch(cookie: string, ops: unknown[]): Request {
  return new Request(`http://localhost/api/apps/${APP_ID}/batch`, {
    method: "POST",
    headers: { cookie, origin: TEST_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ ops }),
  });
}

async function countRows(cookie: string, tableId: string): Promise<number> {
  const res = await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/tables/${tableId}/records`, {
      headers: { cookie },
    }),
  );
  if (res.status !== 200) {
    return -res.status;
  }
  const body = (await res.json()) as { records?: unknown[] };
  return (body.records ?? []).length;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function upload(cookie: string): Request {
  const form = new FormData();
  form.set("file", new Blob([Uint8Array.from(PNG)]), "photo.png");
  return new Request(`http://localhost/api/apps/${APP_ID}/files`, {
    method: "POST",
    headers: { cookie, origin: TEST_ORIGIN },
    body: form,
  });
}

// --- (a) 規則を持たない表を1つでも触ると、要求**全体**が 403 ------------------------------

test("(a) まとめ書き込みは、規則を1本も書いていない表を1つ含むだけで要求全体が 403(1行も書かれない)", async () => {
  const res = await app.request(
    batch(owner.cookie, [
      { op: "create", table: "orders", values: { title: "梅干し" } },
      { op: "create", table: "ledger", values: { title: "闇の帳簿" } },
    ]),
  );
  expect(res.status).toBe(403);
  // **面が止めた表の名前が応答に出る**(`forbiddenRoleAccessError`)。
  const body = (await res.json()) as { errors: { message: string }[] };
  expect(body.errors[0]?.message).toContain("ledger");
  // **部分適用が起きていないこと** —— **通るはずだった `orders` の op も書かれていない。**
  expect(await countRows(owner.cookie, "orders")).toBe(0);
});

// --- (b) 全部の表に規則があれば通る -------------------------------------------------------

test("(b) まとめ書き込みは、触る表すべてに書込の規則があれば通る", async () => {
  const res = await app.request(
    batch(owner.cookie, [
      { op: "create", table: "orders", values: { title: "梅干し" } },
      { op: "create", table: "orders", values: { title: "沢庵" } },
    ]),
  );
  expect(res.status).toBe(200);
  expect(await countRows(owner.cookie, "orders")).toBe(2);
});

// --- (c) 規則が「見る」しか無い表へ書こうとすると 403 -------------------------------------

test("(c) まとめ書き込みは、規則が「見る」しか無い表へ書こうとすると 403", async () => {
  const res = await app.request(
    batch(owner.cookie, [{ op: "create", table: "archive", values: { title: "古文書" } }]),
  );
  expect(res.status).toBe(403);
  const body = (await res.json()) as { errors: { message: string }[] };
  expect(body.errors[0]?.message).toContain("archive");
});

// --- (d) ファイルのアップロードは、規則を持たない相手には 403 ------------------------------

test("(d) ファイルのアップロードは、着地しうる表への書込を1つも許されていない相手には 403", async () => {
  // **`editor` は古い層(`hasAdminWriteRole`)を通り抜ける** —— **止めているのは面である。**
  const denied = await app.request(upload(editor.cookie));
  expect(denied.status).toBe(403);

  // **`orders`(`image` 項目を持つ表)への書込を許されている `owner` は今日どおり通る。**
  const allowed = await app.request(upload(owner.cookie));
  expect(allowed.status).toBe(201);
});

// --- (f) 着地しうる表が0件のアプリでは、持ち主でもアップロードできない(**挙動が変わった1点**)

test("(f) `image` / `file` 項目を1つも持たないアプリでは、持ち主のアップロードも 403 になる", async () => {
  // **これは `V8-M27-T03` で挙動が変わった1点である。** **着手前(`f5edc77`)は 201 だった** ——
  // **`hasAdminWriteRole` しか立っておらず、`owner` は無条件で上げられた。**
  // **今日は「上げたものが着地しうる表」が1つも無いので、面が名指しできる対象が0件であり、
  // 403 に倒している**(`filesAuthMiddleware` の doc)。
  // **【これができなくなった、と正直に書く】** —— **`image` / `file` 項目を後から足す
  // つもりで先にファイルを上げる、という順序は今日できない。**
  const otherRoot = await mkdtemp(join(tmpdir(), "gp-wire-nofile-"));
  try {
    const store = KernelMetaStore.open(otherRoot);
    try {
      createApp(store, "帳面だけの店", { app_id: "wire-nofile" });
    } finally {
      store.close();
    }
    const plain = {
      app: {
        id: "wire-nofile",
        name: "帳面だけの店",
        tables: [
          {
            id: "notes",
            name: "覚え書き",
            fields: [{ id: "body", name: "本文", type: "text", required: true }],
          },
        ],
        views: [],
        roles: [
          {
            id: "owner",
            name: "持ち主",
            rules: [
              // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
              { target: "app", can: ["write"] },
              { target: "role", can: ["write"] },
              { target: "table", table: "notes", can: ["read", "write", "delete"] },
            ],
          },
          { id: "editor", name: "編集者" },
          { id: "viewer", name: "閲覧者" },
        ],
      },
    } as unknown as Manifest;
    expect(applyManifest(otherRoot, "wire-nofile", plain).valid).toBe(true);
    const other = createServerApp({ dataRoot: otherRoot });
    const plainOwner = seedSession(otherRoot, "wire-nofile", { role: "owner" });

    const form = new FormData();
    form.set("file", new Blob([Uint8Array.from(PNG)]), "photo.png");
    const res = await other.request(
      new Request(`http://localhost/api/apps/wire-nofile/files`, {
        method: "POST",
        headers: { cookie: plainOwner.cookie, origin: TEST_ORIGIN },
        body: form,
      }),
    );
    expect(res.status).toBe(403);
  } finally {
    await rm(otherRoot, { recursive: true, force: true });
  }
});

// --- (e) この2経路の拒否は 403 である(`ADR-0305` 限定11 の作法は当てはまらない)-----------

test("(e) 面が止めたときの応答は、両経路とも 403 である(404 で伏せない)", async () => {
  // **`ADR-0305` 限定11 の作法(一覧は応答から落とし、単件は 404 で伏せる)は読取の作法である**
  // —— **「その表が在る」ことを役割の外へ漏らさないために、読取だけを 404 に倒している。**
  // **本ファイルの2経路はどちらも書込である。** **書込を 404 に倒すと、要求した側は
  // 「表が無い」と読んで作り直しに行く** —— **止めた理由が権限であることが伝わらない。**
  // **したがって 403 が正しい**(単件 `POST` / `PATCH` / `DELETE` と同じ向き)。
  const batched = await app.request(
    batch(owner.cookie, [{ op: "create", table: "ledger", values: { title: "闇" } }]),
  );
  expect(batched.status).toBe(403);
  expect(batched.status).not.toBe(404);

  const uploaded = await app.request(upload(editor.cookie));
  expect(uploaded.status).toBe(403);
  expect(uploaded.status).not.toBe(404);
});
