/**
 * 画像アップロード API + image フィールド結線のテスト(V2-M2-T02 / ADR-0035)。
 *
 * `POST /api/apps/:app_id/files`:
 *   - 認証必須(未認証 401)/ 認可 editor|owner(viewer・customer 403)/ Origin 検査(403)
 *   - MIME allowlist + マジックナンバー(415)/ size 上限(413)/ file パート欠落(422)
 *   - 受理で file_id を返す(201)/ 同一内容の de-dup(sha256 一致・file_id 別)
 * image フィールド結線:
 *   - 実在 file_id は 201、不在 file_id は 422(`_files` 実在確認 = T01 の枠を T02 で結線)
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appDbPath,
  applyManifest,
  createApp,
  KernelMetaStore,
  type Manifest,
} from "../kernel/index.ts";
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
          id: "products",
          name: "商品",
          fields: [
            { id: "name", name: "商品名", type: "text", required: true },
            { id: "photo", name: "商品画像", type: "image" },
          ],
        },
      ],
      views: [],
    },
  };
}

// --- 各画像形式の最小マジックナンバー付きバイト列 ---
function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
}
function pngBytesAlt(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6, 5]);
}
function jpegBytes(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
}
function gifBytes(): Uint8Array {
  return new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]);
}
function webpBytes(): Uint8Array {
  return new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 1, 2,
  ]);
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
let cookie: string; // owner

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-files-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "商店", { app_id: APP });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP, withDefaultRoleRules(shopManifest())).valid).toBe(true);
  app = createServerApp({ dataRoot });
  cookie = seedSession(dataRoot, APP).cookie; // owner 既定
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

/**
 * multipart/form-data のアップロード Request を組む。
 *
 * **申告 MIME は `filename` の拡張子で決まる**(Bun の `req.formData()` はパートの Content-Type を
 * 無視し拡張子から File.type を導く。V2-M2-T02 実測)。したがってテストは拡張子で申告 MIME を、
 * `data` で実体を、独立に制御する。手書きの multipart にして part の Content-Type を明示しても
 * Bun は拾わないので、FormData/Blob で十分。
 */
function uploadRequest(
  data: Uint8Array,
  filename: string,
  opts?: { cookie?: string | null; origin?: string | null; noFile?: boolean },
): Request {
  const form = new FormData();
  if (opts?.noFile !== true) {
    form.set("file", new Blob([Uint8Array.from(data)]), filename);
  } else {
    form.set("other", "x");
  }
  const headers = new Headers();
  if (opts?.cookie !== null) {
    headers.set("cookie", opts?.cookie ?? cookie);
  }
  if (opts?.origin !== null) {
    headers.set("origin", opts?.origin ?? TEST_ORIGIN);
  }
  return new Request(`http://localhost/api/apps/${APP}/files`, {
    method: "POST",
    headers,
    body: form,
  });
}

async function upload(
  data: Uint8Array,
  filename: string,
  opts?: Parameters<typeof uploadRequest>[2],
): Promise<Response> {
  return app.request(uploadRequest(data, filename, opts));
}

// --- 認証・認可 ---

test("未認証は 401(書込は一切公開しない)", async () => {
  const res = await upload(pngBytes(), "photo.png", { cookie: null });
  expect(res.status).toBe(401);
});

test("viewer は 403", async () => {
  const viewer = seedSession(dataRoot, APP, { role: "viewer" }).cookie;
  const res = await upload(pngBytes(), "photo.png", { cookie: viewer });
  expect(res.status).toBe(403);
});

// **【`V5-M16-T06` / `G-G14`】旧題は「商品画像アップロードは運営操作・EC スコープ外」だった。**
// **今日のアップロードは商品画像に限らない**(`kind=file` で一般のファイルも上げられる)ので、
// 業種の前提を外した。**customer が 403 であることは1バイトも変わっていない。**
test("customer は 403(ファイルのアップロードはアプリを育てる側の操作)", async () => {
  const customer = seedSession(dataRoot, APP, { role: "customer" }).cookie;
  const res = await upload(pngBytes(), "photo.png", { cookie: customer });
  expect(res.status).toBe(403);
});

test("editor は許可(201)", async () => {
  const editor = seedSession(dataRoot, APP, { role: "editor" }).cookie;
  const res = await upload(pngBytes(), "photo.png", { cookie: editor });
  expect(res.status).toBe(201);
});

test("クロスオリジンの Origin は 403(CSRF 多重防御)", async () => {
  const res = await upload(pngBytes(), "photo.png", { origin: "http://evil.example" });
  expect(res.status).toBe(403);
});

// --- MIME allowlist + マジックナンバー(申告 MIME は拡張子由来)---

test("allowlist 外の申告 MIME(.pdf → application/pdf)は 415", async () => {
  const res = await upload(pngBytes(), "doc.pdf");
  expect(res.status).toBe(415);
});

test("申告は許可 MIME(.png)だが中身がテキスト(マジックナンバー不一致)は 415", async () => {
  const notImage = new TextEncoder().encode("this is definitely not a png");
  const res = await upload(notImage, "photo.png");
  expect(res.status).toBe(415);
});

test("申告(.png)と実体(JPEG)が食い違っても、実体を正として受理し MIME は実体になる", async () => {
  // 「Content-Type/拡張子を信用しすぎない」= 実体(sniff)を保存 MIME の正とする。
  const res = await upload(jpegBytes(), "photo.png");
  expect(res.status).toBe(201);
  const body = (await res.json()) as { mime: string };
  expect(body.mime).toBe("image/jpeg");
});

test("jpeg / gif / webp も受理される(201)", async () => {
  expect((await upload(jpegBytes(), "a.jpg")).status).toBe(201);
  expect((await upload(gifBytes(), "a.gif")).status).toBe(201);
  expect((await upload(webpBytes(), "a.webp")).status).toBe(201);
});

// --- size 上限 ---

test("size 上限超過は 413", async () => {
  // 先頭は PNG マジックにしておく(MIME 検査より先に size で弾かれることの確認)。
  const big = new Uint8Array(6 * 1024 * 1024);
  big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const res = await upload(big, "big.png");
  expect(res.status).toBe(413);
});

// --- file パート欠落 ---

test("file パートが無いと 422", async () => {
  const res = await upload(pngBytes(), "photo.png", { noFile: true });
  expect(res.status).toBe(422);
});

// --- 受理レスポンス + de-dup ---

test("受理で file_id / sha256 / mime / size / filename を返す", async () => {
  const res = await upload(pngBytes(), "cat.png");
  expect(res.status).toBe(201);
  const body = (await res.json()) as Record<string, unknown>;
  expect(typeof body.file_id).toBe("string");
  expect((body.file_id as string).length).toBeGreaterThan(0);
  expect(typeof body.sha256).toBe("string");
  expect(body.sha256 as string).toMatch(/^[0-9a-f]{64}$/);
  expect(body.mime).toBe("image/png");
  expect(body.size).toBe(pngBytes().byteLength);
  expect(body.filename).toBe("cat.png");
  // file_id は sha256 とは別物(UUID)。
  expect(body.file_id).not.toBe(body.sha256);
});

test("同一内容を2回上げると sha256 は一致し file_id は別(de-dup)", async () => {
  const a = (await (await upload(pngBytes(), "photo.png")).json()) as Record<string, unknown>;
  const b = (await (await upload(pngBytes(), "photo.png")).json()) as Record<string, unknown>;
  expect(a.sha256).toBe(b.sha256);
  expect(a.file_id).not.toBe(b.file_id);
});

test("異なる内容は別 sha256", async () => {
  const a = (await (await upload(pngBytes(), "photo.png")).json()) as Record<string, unknown>;
  const b = (await (await upload(pngBytesAlt(), "photo.png")).json()) as Record<string, unknown>;
  expect(a.sha256).not.toBe(b.sha256);
});

// --- image フィールド結線(T01 の枠を T02 で `_files` 実体と結線)---

async function createProduct(body: unknown): Promise<Response> {
  return app.request(
    new Request(`http://localhost/api/apps/${APP}/tables/products/records`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: TEST_ORIGIN },
      body: JSON.stringify(body),
    }),
  );
}

test("アップロード済み file_id は image フィールドに書ける(201)", async () => {
  const uploaded = (await (await upload(pngBytes(), "photo.png")).json()) as {
    file_id: string;
  };
  const res = await createProduct({ name: "帽子", photo: uploaded.file_id });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { record: Record<string, unknown> };
  expect(body.record.photo).toBe(uploaded.file_id);
});

test("存在しない file_id を image フィールドに書くと 422", async () => {
  const res = await createProduct({ name: "帽子", photo: crypto.randomUUID() });
  expect(res.status).toBe(400); // 統一形式のバリデーション不合格(HTTP 400)
  const body = (await res.json()) as { errors: { message: string }[] };
  expect(body.errors.some((e) => e.message.includes("_files"))).toBe(true);
});

test("image フィールドは省略可能(null 許容・required でない)", async () => {
  const res = await createProduct({ name: "画像なし商品" });
  expect(res.status).toBe(201);
});

// --- 既存アプリの遅延マイグレーション(本機能導入前に作られたアプリに `_files` が無い場合)---

test("`_files` が無い既存アプリでも、アップロード時に遅延生成されて受理される", async () => {
  // 本機能導入前の状態を模して `_files` を落とす。
  const db = new Database(appDbPath(dataRoot, APP), { readwrite: true });
  try {
    db.exec('DROP TABLE IF EXISTS "_files"');
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='_files'").get(),
    ).toBeNull();
  } finally {
    db.close();
  }
  const res = await upload(pngBytes(), "photo.png");
  expect(res.status).toBe(201);
});
