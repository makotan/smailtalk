/**
 * 画像配信 API + 公開整合のテスト(V2-M2-T03 / ADR-0035 §1c・限定6)。
 *
 * `GET /api/apps/:app_id/files/:file_id`:
 *   - `_files` を引き blob 実体を正しい Content-Type(sniff 済み mime)で返す。
 *     `X-Content-Type-Options: nosniff` を付ける。存在しない file_id / `_files` 不在は 404。
 *   - **公開整合(未認証の最小性)**: 未認証で配信してよいのは「st_public が真の公開行の
 *     image フィールドが参照する file_id」のみ。非公開行/運営テーブル/未参照 file は
 *     未認証では 404(存在秘匿 = 列挙耐性の側)。
 *   - **認証済みの可視範囲**: owner/editor/viewer は全 file 配信可。customer は
 *     「自分の scoped 行(st_owner)+ 公開行(st_public=真)」が参照する file のみ(それ以外 404)。
 *   - **read-only の構造保証**: 配信は GET のみ。`/files/:file_id` への POST/PATCH/DELETE は
 *     経路が無い(404)。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP = "shop";

function shopManifest(): Manifest {
  return {
    app: {
      id: APP,
      name: "商店",
      tables: [
        {
          // 公開テーブル(st_public。st_owner 無し)= 商品カタログ(EC-G1)。
          id: "catalog",
          name: "カタログ",
          fields: [
            { id: "name", name: "商品名", type: "text", required: true },
            { id: "photo", name: "商品画像", type: "image" },
            { id: "st_public", name: "公開", type: "boolean" },
          ],
        },
        {
          // 顧客スコープテーブル(st_owner。個人所有)= レシート等。image を持つ。
          id: "receipts",
          name: "レシート",
          fields: [
            { id: "img", name: "画像", type: "image" },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
        {
          // 運営テーブル(st_public も st_owner も無い)= 顧客に見せない管理データ。
          id: "admin",
          name: "管理",
          fields: [{ id: "pic", name: "画像", type: "image" }],
        },
      ],
      views: [],
    },
  };
}

/**
 * **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`】題材へ役割の規則を足す。**
 *
 * **既定が「閉じる」側へ倒れたので、規則を1本も名指ししていない表は 403 になる。**
 * **本検査の主題は「配信の可視範囲(`st_public` / `st_owner`)」であって面の権限ではない**
 * ので、面は主題を壊さない最小限だけ開ける。
 *
 * - 運営3役割(`owner` / `editor` / `viewer`)には既定の規則を配る
 *   (`apply-diff.ts` の自動付与と同じ形。実アプリなら差分を通した時点で必ず入る)。
 * - **顧客(`customer`)には `catalog` の読取と `receipts` の読み書きだけを足す。**
 *   **`admin`(運営テーブル)には1本も足さない** —— **「顧客に運営テーブルの画像は
 *   見せない」ことが本検査の主題であり、面を開けるとその測定が丸ごと無効になる。**
 */
function shopManifestWithRoles(): Manifest {
  const manifest = withDefaultRoleRules(shopManifest());
  manifest.app.roles = [
    ...(manifest.app.roles ?? []),
    {
      id: "customer",
      name: "顧客",
      rules: [
        { target: "table", table: "catalog", can: ["read"] },
        { target: "table", table: "receipts", can: ["read", "write"] },
      ],
    },
    // **【`V8-M26`】未ログイン(`anonymous`)に `catalog` の読取だけを手で足す。**
    // **`withDefaultRoleRules` は `anonymous` へ1本も配らない**(`D-V8-45` / `T-G26a`)ので、
    // ここを書かないと「公開行の画像は未認証で配信できる」という本検査の主題そのものが
    // 消える(6本の匿名検査が全部 404 になり、何も測っていないことになる)。
    // **足すのは `catalog` の読取1本だけである** —— **`receipts`(scoped)にも
    // `admin`(運営)にも1本も足していない**ので、「未認証の最小性」は今日も測れている。
    // **これは実アプリの既定ではない** —— **差分の自動付与は `anonymous` に1本も配らない。**
    {
      id: "anonymous",
      name: "未ログイン",
      rules: [{ target: "table", table: "catalog", can: ["read"] }],
    },
  ];
  return manifest;
}

function pngBytes(tag: number): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, tag, tag + 1, tag + 2]);
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
let ownerCookie: string;

// テストで使う file_id(owner がアップロード)とレコード配置。
let filePublic: string; // 公開カタログ行(st_public=true)が参照
let filePrivate: string; // 非公開カタログ行(st_public=false)が参照
let fileAdmin: string; // 運営テーブル行が参照
let fileScopedC1: string; // customer1 の scoped 行(receipts)が参照
let fileOrphan: string; // どのレコードからも参照されない
let customer1: { cookie: string; userId: string };
let customer2: { cookie: string };

async function uploadAsOwner(data: Uint8Array): Promise<string> {
  const form = new FormData();
  form.set("file", new Blob([Uint8Array.from(data)]), "photo.png");
  const res = await app.request(
    new Request(`http://localhost/api/apps/${APP}/files`, {
      method: "POST",
      headers: { cookie: ownerCookie, origin: TEST_ORIGIN },
      body: form,
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { file_id: string }).file_id;
}

async function createRecord(
  cookie: string,
  tableId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const res = await app.request(
    new Request(`http://localhost/api/apps/${APP}/tables/${tableId}/records`, {
      method: "POST",
      headers: { cookie, origin: TEST_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  expect(res.status, `create ${tableId} ${JSON.stringify(body)} -> ${await res.text()}`).toBe(201);
}

function deliver(fileId: string, cookie?: string): Response | Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  return app.request(new Request(`http://localhost/api/apps/${APP}/files/${fileId}`, { headers }));
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-files-del-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "商店", { app_id: APP });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP, shopManifestWithRoles()).valid).toBe(true);
  app = createServerApp({ dataRoot });
  ownerCookie = seedSession(dataRoot, APP).cookie; // owner 既定

  const c1 = seedSession(dataRoot, APP, { role: "customer" });
  customer1 = { cookie: c1.cookie, userId: c1.userId };
  customer2 = { cookie: seedSession(dataRoot, APP, { role: "customer" }).cookie };

  filePublic = await uploadAsOwner(pngBytes(10));
  filePrivate = await uploadAsOwner(pngBytes(20));
  fileAdmin = await uploadAsOwner(pngBytes(30));
  fileScopedC1 = await uploadAsOwner(pngBytes(40));
  fileOrphan = await uploadAsOwner(pngBytes(50));

  await createRecord(ownerCookie, "catalog", {
    name: "公開商品",
    photo: filePublic,
    st_public: true,
  });
  await createRecord(ownerCookie, "catalog", {
    name: "非公開商品",
    photo: filePrivate,
    st_public: false,
  });
  await createRecord(ownerCookie, "admin", { pic: fileAdmin });
  // customer1 が自分の scoped 行を作る(st_owner は customer1.id にスタンプされる)。
  await createRecord(customer1.cookie, "receipts", { img: fileScopedC1 });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

// --- 未認証(匿名)配信 = 公開行の image のみ -----------------------------------------

test("公開行の image は未認証で 200・正しい Content-Type・nosniff・実体一致", async () => {
  const res = await deliver(filePublic);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  const body = new Uint8Array(await res.arrayBuffer());
  expect(Array.from(body)).toEqual(Array.from(pngBytes(10)));
});

test("非公開行(st_public=false)の image は未認証で 404(存在秘匿)", async () => {
  expect((await deliver(filePrivate)).status).toBe(404);
});

test("運営テーブルの image は未認証で 404", async () => {
  expect((await deliver(fileAdmin)).status).toBe(404);
});

test("scoped 行の image は未認証で 404", async () => {
  expect((await deliver(fileScopedC1)).status).toBe(404);
});

test("どのレコードからも参照されない file は未認証で 404", async () => {
  expect((await deliver(fileOrphan)).status).toBe(404);
});

test("存在しない file_id は未認証で 404(非公開 file と同じ 404 = 列挙耐性)", async () => {
  expect((await deliver("00000000-0000-0000-0000-000000000000")).status).toBe(404);
});

// --- 認証済み owner/editor/viewer = 全 file 配信可 --------------------------------------

test("owner は全 file(公開/非公開/運営/scoped/未参照)を 200 で配信できる", async () => {
  for (const id of [filePublic, filePrivate, fileAdmin, fileScopedC1, fileOrphan]) {
    expect((await deliver(id, ownerCookie)).status).toBe(200);
  }
});

test("editor も全 file を 200 で配信できる", async () => {
  const editor = seedSession(dataRoot, APP, { role: "editor" }).cookie;
  for (const id of [filePrivate, fileAdmin, fileScopedC1, fileOrphan]) {
    expect((await deliver(id, editor)).status).toBe(200);
  }
});

test("owner でも存在しない file_id は 404", async () => {
  expect((await deliver("no-such-file", ownerCookie)).status).toBe(404);
});

// --- customer = 自分の scoped 行 + 公開行が参照する file のみ ------------------------------

test("customer は公開行の image を 200 で配信できる", async () => {
  expect((await deliver(filePublic, customer1.cookie)).status).toBe(200);
});

test("customer は自分の scoped 行の image を 200 で配信できる", async () => {
  expect((await deliver(fileScopedC1, customer1.cookie)).status).toBe(200);
});

// **【`V8-M27-T04` / `T-G5`。期待値を反転させた。旧のテスト名と旧の期待値を逐語で残す】**
// **旧: `test("customer は非公開行(st_public=false)の image は 404(公開行のみ)")` /
//       `expect((await deliver(filePrivate, customer1.cookie)).status).toBe(404);`**
// **根拠**: **`V8-M27` / `T-G5` / `D-V8-38`。**
// **`st_public` の行ごとの絞り込みは、レコード経路では**未認証のときにしか掛かっていない**
// (`app.ts` の `anonymousPublic`)。** **旧のファイル配信だけが、ログイン済みの
// 非運営の役割にもこの絞り込みを掛けていた** —— **`reserved` の旗で分岐する層の
// 「非運営の側」だったためである。** **層を外したので、レコード経路と同じになった。**
// **【正直に書く】これは広がりである。** **未認証は今日も公開行だけである**(下の匿名の検査群)。
test("customer は非公開行(st_public=false)の image も 200(旧: 404。レコード経路に揃えた)", async () => {
  expect((await deliver(filePrivate, customer1.cookie)).status).toBe(200);
});

test("customer は運営テーブルの image は 404", async () => {
  expect((await deliver(fileAdmin, customer1.cookie)).status).toBe(404);
});

// **【`V8-M27-T04` / `T-G5`。期待値を反転させた。旧のテスト名と旧の期待値を逐語で残す】**
// **旧: `test("別の customer の scoped 行の image は 404(自分の行だけ)")` /
//       `expect((await deliver(fileScopedC1, customer2.cookie)).status).toBe(404);`**
// **根拠**: **`V8-M27` / `T-G5` / `D-V8-38` / `D-V8-35`。**
// **本フィクスチャの `customer` は `receipts` に**条件のない** `read` を持っている** ——
// **`D-V8-35` により、面が読取を許した役割は `st_owner` を読取について越える。**
// **レコード経路では着手前からそうなっており**(2026-08-11 に実測)、
// **ファイル配信だけが層のせいで狭かった。** **層を外して揃えた。**
// **「自分の行だけ」を保ちたいアプリは規則に条件(`when`)を書く。**
test("別の customer の scoped 行の image も 200(条件なしの read を書いた表。旧: 404)", async () => {
  expect((await deliver(fileScopedC1, customer2.cookie)).status).toBe(200);
});

// **【`V8-M27-T04` / `T-G5`。期待値を反転させた。旧のテスト名と旧の期待値を逐語で残す】**
// **旧: `test("customer は未参照 file は 404")` /
//       `expect((await deliver(fileOrphan, customer1.cookie)).status).toBe(404);`**
// **根拠**: **`V8-M27` / `T-G5`。** **「どの行からも参照されていない file は予約3ロール
// だけが受け取れる」という条件から、ロールの綴りを外した。** **今日はログインしていれば
// 受け取れる** —— **上げた直後(まだどの行にも保存していない)のプレビューを、
// アップロードの口が開いた相手に見せられなくなるためである。**
// **未認証は今日も 404 である**(匿名の検査群が測っている)。
test("customer も未参照 file は 200(旧: 404。上げた直後のプレビューのため)", async () => {
  expect((await deliver(fileOrphan, customer1.cookie)).status).toBe(200);
});

// --- read-only の構造保証: 配信は GET のみ ------------------------------------------

test("配信パスへの POST/PATCH/DELETE は経路が無い(404)", async () => {
  for (const method of ["POST", "PATCH", "DELETE"]) {
    const res = await app.request(
      new Request(`http://localhost/api/apps/${APP}/files/${filePublic}`, {
        method,
        headers: { cookie: ownerCookie, origin: TEST_ORIGIN },
      }),
    );
    expect(res.status, method).toBe(404);
  }
});

// --- `_files` 不在(画像未アップロードのアプリ)---------------------------------------

test("`_files` が無いアプリ(画像未アップロード)への配信は 404", async () => {
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "空店", { app_id: "empty" });
  } finally {
    store.close();
  }
  expect(
    applyManifest(dataRoot, "empty", {
      app: { id: "empty", name: "空店", tables: [], views: [] },
    }).valid,
  ).toBe(true);
  const ownerEmpty = seedSession(dataRoot, "empty").cookie;
  const res = await app.request(
    new Request(`http://localhost/api/apps/empty/files/anything`, {
      headers: { cookie: ownerEmpty },
    }),
  );
  expect(res.status).toBe(404);
});
