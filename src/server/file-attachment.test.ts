/**
 * 一般のファイルの添付(`V5-M16-T02` / `T03` / `T04`。`G-G12` / `G-G13`。`ADR-0161` +
 * **`ADR-0161` 限定6 を覆した `D-V5-84`**)。
 *
 * ## このファイルが固定すること
 *
 * 1. **`T02`(アップロード)**: `POST /api/apps/:app_id/files` の `kind` パート。
 *    - `kind` 省略 / `kind=image` → **今日の挙動を1バイトも変えない**(画像4種 + 先頭バイト
 *      検査 + 5 MiB)。
 *    - `kind=file` → **受け入れる種類の制限は0件**(`D-V5-84`。HTML / SVG / zip / 実行形式 /
 *      拡張子なしが**どれも 201**)。上限は **20,000,000 バイト**(`ADR-0161` 限定7)。
 *    - `kind` に他の値 → 422。
 * 2. **`T03`(配信)**: **実体の先頭バイトが4種の画像と判定できないなら、必ずダウンロードで返す。**
 *    - `Content-Type: application/octet-stream` + `Content-Disposition: attachment` +
 *      `X-Content-Type-Options: nosniff` の3点。
 *    - **HTML / SVG を実物のバイト列で上げて、3点が成り立つことを実測する**(字面の grep で
 *      済ませない)。
 *    - **画像の配信は着手前と1バイトも変わらない**(`Content-Disposition` が付かない)。
 * 3. **`T04`(未認証配信)**: **`file` 型が参照するファイルは、公開行が参照していても未認証で
 *    配信されない**(`ADR-0161` 限定5。`image` より狭い)。
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * - **蓄積型 XSS が「起きない」ことを証明していない。** 見ているのは**応答ヘッダの3点**だけで
 *   あり、**実際のブラウザで開いて script が走らないことは1度も確かめていない**
 *   (chromium を1回も起動していない)。
 * - **上限を上げたときのサービス停止(DoS)の面は、ここでは1バイトも測っていない**
 *   (`ADR-0161` 限定12 の実測は記録 `docs/plan/v5/records/v5-m16.md` §5 が持つ)。
 * - **アップロードの種類が0件制限であることは「試した種類の数」でしか言えない。**
 *   ここで実際に上げたのは7種類である —— **すべての MIME を試したのではない。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import {
  ALLOWED_IMAGE_MIME,
  MAX_FILE_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
} from "../shared/files-table.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP = "office";

function officeManifest(): Manifest {
  return {
    app: {
      id: APP,
      name: "事務所",
      tables: [
        {
          // 公開テーブル(st_public)。**image と file の両方を持つ** ——
          // 同じ公開行から、image は未認証に配信され、file は配信されないことを見る。
          id: "notices",
          name: "お知らせ",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "photo", name: "写真", type: "image" },
            { id: "doc", name: "添付", type: "file" },
            { id: "st_public", name: "公開", type: "boolean" },
          ],
        },
        {
          // 顧客スコープテーブル(st_owner)。file を持つ。
          id: "invoices",
          name: "請求書",
          fields: [
            { id: "pdf", name: "請求書PDF", type: "file" },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
      ],
      views: [],
      // **【`V8-M26`】`customer` は既定3役割に入っていないので、ここで宣言する。**
      // **足すのは請求書の読み書きだけである** —— **この検査の主題(`st_owner` による
      // 配信の絞り込み)に要る最小限であり、お知らせ側には1本も足していない。**
      // **`owner` / `editor` / `viewer` の宣言と規則は `withDefaultRoleRules` が足す。**
      roles: [
        {
          id: "customer",
          name: "顧客",
          rules: [{ target: "table", table: "invoices", can: ["read", "write"] }],
        },
        // **【`V8-M26`】未ログイン(`anonymous`)に「お知らせ」の読取だけを手で足す。**
        // **`withDefaultRoleRules` は `anonymous` へ1本も配らない**(`D-V8-45` / `T-G26a`)ので、
        // これを書かないと **`image` も未認証で 404 になり、「`file` は `image` より狭い」という
        // 本検査の主題そのものが消える**(`ADR-0161` 限定5 を何も測っていないことになる)。
        // **足すのは `notices` の読取1本だけである** —— **`invoices` には1本も足していない。**
        // **これは実アプリの既定ではない** —— **`apply-diff.ts` の自動付与は `anonymous` に
        // 1本も配らないので、差分だけで作ったアプリでは公開行の画像も未認証では出ない。**
        {
          id: "anonymous",
          name: "未ログイン",
          rules: [{ target: "table", table: "notices", can: ["read"] }],
        },
      ],
    },
  } as unknown as Manifest;
}

function pngBytes(tag = 1): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, tag, tag + 1, tag + 2]);
}

/** **本物の HTML(script を含む)** —— 同じサイトから実行されると蓄積型 XSS になる。 */
const HTML_XSS = "<!doctype html><html><body><script>alert(document.cookie)</script></body></html>";
/** **本物の SVG(script を含む)** —— `<img>` では走らないが、直接開かれると走る。 */
const SVG_XSS =
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>';

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
let ownerCookie: string;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-file-attach-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "事務所", { app_id: APP });
  } finally {
    store.close();
  }
  // **【`V8-M26`】題材に既定3役割の規則を足す**(実アプリでは `apply-diff.ts` が自動で入れる)。
  expect(applyManifest(dataRoot, APP, withDefaultRoleRules(officeManifest())).valid).toBe(true);
  app = createServerApp({ dataRoot });
  ownerCookie = seedSession(dataRoot, APP).cookie; // owner 既定
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function upload(
  data: Uint8Array | string,
  filename: string,
  opts?: { kind?: string; cookie?: string },
): Promise<Response> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const form = new FormData();
  form.set("file", new Blob([Uint8Array.from(bytes)]), filename);
  if (opts?.kind !== undefined) {
    form.set("kind", opts.kind);
  }
  return Promise.resolve(
    app.request(
      new Request(`http://localhost/api/apps/${APP}/files`, {
        method: "POST",
        headers: { cookie: opts?.cookie ?? ownerCookie, origin: TEST_ORIGIN },
        body: form,
      }),
    ),
  ) as Promise<Response>;
}

async function uploadFileId(
  data: Uint8Array | string,
  filename: string,
  kind = "file",
): Promise<string> {
  const res = await upload(data, filename, { kind });
  expect(res.status, `upload ${filename} -> ${await res.clone().text()}`).toBe(201);
  return ((await res.json()) as { file_id: string }).file_id;
}

function deliver(fileId: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  return Promise.resolve(
    app.request(new Request(`http://localhost/api/apps/${APP}/files/${fileId}`, { headers })),
  ) as Promise<Response>;
}

// =====================================================================================
// T02: アップロード —— 種類の制限は0件(D-V5-84 が ADR-0161 限定6 を覆した)
// =====================================================================================

test("T02: kind=file なら種類の制限が0件である —— 7種類を上げて 415 が1件も出ない", async () => {
  const cases: [Uint8Array | string, string][] = [
    [HTML_XSS, "evil.html"],
    [SVG_XSS, "evil.svg"],
    ["%PDF-1.4\n%âãÏÓ\n", "invoice.pdf"],
    ["id,name\n1,foo\n", "rows.csv"],
    ['{"a":1}', "data.json"],
    [new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), "bundle.zip"],
    [new Uint8Array([0x4d, 0x5a, 0x90, 0x00]), "setup.exe"],
  ];
  const statuses: number[] = [];
  for (const [data, filename] of cases) {
    const res = await upload(data, filename, { kind: "file" });
    statuses.push(res.status);
  }
  // **7件すべて 201。415 は0件。**
  expect(statuses).toEqual([201, 201, 201, 201, 201, 201, 201]);
  expect(statuses.filter((s) => s === 415)).toHaveLength(0);
});

test("T02: kind=file は拡張子が無いファイルも受け取る(申告 MIME 空)", async () => {
  const res = await upload(new Uint8Array([1, 2, 3, 4]), "noextension", { kind: "file" });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { mime: string; filename: string | null };
  expect(body.mime).toBe("application/octet-stream");
  expect(body.filename).toBe("noextension");
});

test("T02: kind を書かない / kind=image は今日どおり画像4種だけを受け取る(415)", async () => {
  // 省略 = image。
  expect((await upload(HTML_XSS, "evil.html")).status).toBe(415);
  expect((await upload(HTML_XSS, "evil.html", { kind: "image" })).status).toBe(415);
  // 画像は今日どおり通る。
  expect((await upload(pngBytes(), "a.png")).status).toBe(201);
  expect((await upload(pngBytes(2), "b.png", { kind: "image" })).status).toBe(201);
});

test("T02: kind=image は先頭バイト検査を今日どおり掛ける(拡張子偽装は 415)", async () => {
  // 中身は HTML だが名前は .png。
  expect((await upload(HTML_XSS, "fake.png", { kind: "image" })).status).toBe(415);
});

test("T02: kind に image / file 以外を書くと 422", async () => {
  const res = await upload(pngBytes(), "a.png", { kind: "document" });
  expect(res.status).toBe(422);
  const body = (await res.json()) as { errors: { allowed_values?: string[] }[] };
  expect(body.errors[0]?.allowed_values).toEqual(["image", "file"]);
});

test("T02: 上限は image が 5 MiB のまま / file が 20,000,000 バイト(限定2 / 限定7)", () => {
  // **限定2: image の定数は1バイトも変わっていない。**
  expect(MAX_UPLOAD_BYTES).toBe(5 * 1024 * 1024);
  expect([...ALLOWED_IMAGE_MIME]).toEqual(["image/jpeg", "image/png", "image/webp", "image/gif"]);
  // **限定7: 1000 基数で 20 MB。**
  expect(MAX_FILE_UPLOAD_BYTES).toBe(20 * 1000 * 1000);
});

test("T02: kind=file は 20,000,000 バイトちょうどを通し、1バイト超で 413", async () => {
  const ok = new Uint8Array(MAX_FILE_UPLOAD_BYTES);
  expect((await upload(ok, "big.bin", { kind: "file" })).status).toBe(201);
  const over = new Uint8Array(MAX_FILE_UPLOAD_BYTES + 1);
  expect((await upload(over, "toobig.bin", { kind: "file" })).status).toBe(413);
});

test("T02: kind=image の上限は上がっていない(5 MiB 超は今日どおり 413)", async () => {
  const over = new Uint8Array(MAX_UPLOAD_BYTES + 1);
  over.set(pngBytes(), 0);
  expect((await upload(over, "big.png", { kind: "image" })).status).toBe(413);
});

// =====================================================================================
// T03: 配信 —— 実体が画像でなければ必ずダウンロード(D-V5-84 の申し添え)
// =====================================================================================

/** 応答が「ブラウザ内で実行されない形」であることの3点。 */
function expectDownloadShape(res: Response, label: string): void {
  expect(res.status, label).toBe(200);
  expect(res.headers.get("content-type"), label).toBe("application/octet-stream");
  expect(res.headers.get("content-disposition") ?? "", label).toMatch(/^attachment/);
  expect(res.headers.get("x-content-type-options"), label).toBe("nosniff");
}

test("T03: HTML を添付すると、ブラウザ内で実行される形では返らない(3点を実測)", async () => {
  const fileId = await uploadFileId(HTML_XSS, "evil.html");
  const res = await deliver(fileId, ownerCookie);
  expectDownloadShape(res, "html");
  // **本文は改竄していない**(返るバイト列は上げたものと同じ)。
  expect(await res.text()).toBe(HTML_XSS);
  // **`text/html` で返っていない**ことを名指しで固定する。
  expect(res.headers.get("content-type")).not.toContain("html");
});

test("T03: SVG を添付すると、ブラウザ内で実行される形では返らない(3点を実測)", async () => {
  const fileId = await uploadFileId(SVG_XSS, "evil.svg");
  const res = await deliver(fileId, ownerCookie);
  expectDownloadShape(res, "svg");
  expect(await res.text()).toBe(SVG_XSS);
  expect(res.headers.get("content-type")).not.toContain("svg");
});

test("T03: 非画像は7種類すべてダウンロードで返る(inline で返るものが1件も無い)", async () => {
  const cases: [Uint8Array | string, string][] = [
    [HTML_XSS, "evil.html"],
    [SVG_XSS, "evil.svg"],
    ["%PDF-1.4\n", "invoice.pdf"],
    ["id,name\n1,foo\n", "rows.csv"],
    ['{"a":1}', "data.json"],
    [new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), "bundle.zip"],
    [new Uint8Array([0x4d, 0x5a, 0x90, 0x00]), "setup.exe"],
  ];
  let inlineCount = 0;
  for (const [data, filename] of cases) {
    const fileId = await uploadFileId(data, filename);
    const res = await deliver(fileId, ownerCookie);
    expectDownloadShape(res, filename);
    if ((res.headers.get("content-disposition") ?? "").startsWith("inline")) {
      inlineCount += 1;
    }
  }
  expect(inlineCount).toBe(0);
});

test("T03: kind=file で上げた画像も、実体が画像なら今日どおり inline で返る(添付だから隠す、ではない)", async () => {
  const fileId = await uploadFileId(pngBytes(7), "photo.png");
  const res = await deliver(fileId, ownerCookie);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(res.headers.get("content-disposition")).toBeNull();
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
});

test("T03: 画像(kind=image)の配信は着手前と1バイトも変わらない", async () => {
  const res0 = await upload(pngBytes(3), "a.png", { kind: "image" });
  expect(res0.status).toBe(201);
  const fileId = ((await res0.json()) as { file_id: string }).file_id;
  const res = await deliver(fileId, ownerCookie);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(res.headers.get("content-disposition")).toBeNull();
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
});

test("T03: ファイル名に改行や引用符が入っていても応答ヘッダが壊れない", async () => {
  const nasty = 'a"b\r\nX-Injected: 1\r\n\r\nc.html';
  const fileId = await uploadFileId(HTML_XSS, nasty);
  const res = await deliver(fileId, ownerCookie);
  expectDownloadShape(res, "nasty");
  const disposition = res.headers.get("content-disposition") ?? "";
  expect(disposition).not.toContain("\r");
  expect(disposition).not.toContain("\n");
  // 注入しようとしたヘッダが独立したヘッダとして生えていない。
  expect(res.headers.get("x-injected")).toBeNull();
});

test("T03: 日本語のファイル名は RFC 5987 の filename* で運ばれる", async () => {
  const fileId = await uploadFileId("%PDF-1.4\n", "請求書.pdf");
  const res = await deliver(fileId, ownerCookie);
  const disposition = res.headers.get("content-disposition") ?? "";
  expect(disposition).toContain("filename*=UTF-8''");
  expect(disposition).toContain(encodeURIComponent("請求書.pdf"));
});

// =====================================================================================
// T04: file は未認証配信しない(ADR-0161 限定5)
// =====================================================================================

async function createRecordAs(
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
  expect(res.status, `create ${tableId} -> ${await res.text()}`).toBe(201);
}

test("T04: 公開行が参照していても、file 型のファイルは未認証で 404(image より狭い)", async () => {
  const photoId = await uploadFileId(pngBytes(4), "p.png", "image");
  const docId = await uploadFileId("%PDF-1.4\n", "public.pdf");
  await createRecordAs(ownerCookie, "notices", {
    title: "公開のお知らせ",
    photo: photoId,
    doc: docId,
    st_public: true,
  });

  // **image は今日どおり未認証で 200**(ADR-0035 限定6 は無効化していない)。
  expect((await deliver(photoId)).status).toBe(200);
  // **file は未認証で 404**(ADR-0161 限定5)。
  expect((await deliver(docId)).status).toBe(404);
  // 認証済み(owner)なら 200。
  expect((await deliver(docId, ownerCookie)).status).toBe(200);
});

// =====================================================================================
// **【`V8-M27-T04` / `T-G5`。期待値を反転させた。旧のテスト名と旧の期待値を逐語で残す】**
//
// **旧のテスト名と旧の期待値**:
//   `T04: customer は自分の行が参照する file を落とせるが、他人の行のものは 404`
//       expect((await deliver(theirs, c1.cookie)).status).toBe(404);
//   `T04: どのレコードからも参照されない file は customer に 404、owner には 200`
//       expect((await deliver(orphan, c1.cookie)).status).toBe(404);
//
// **根拠**: **`V8-M27` / 台帳 `T-G5` / ユーザ決定 `D-V8-38`。**
//
// **1本目**: **本フィクスチャの `customer` は `invoices` に**条件のない** `read` を
// 持っている**(上の `roles` 宣言)。**`D-V8-35` により、面が表の読取を許した役割は
// `st_owner` を読取について越える**(`roleReadCrossesOwnerScope`)——
// **したがってレコード経路では、着手前から `customer` が他人の請求書の**行**を読めていた。**
// **2026-08-11 に実測して確かめた**(条件なしの `read` を書いた表で、別の利用者の行が
// 一覧に1件返る)。**旧のファイル配信だけが、そのレコード経路より狭かった** ——
// **`reserved` の旗で分岐する層が、非運営に `st_owner` の絞り込みを無条件で掛けていたためである。**
// **層を外した今日、ファイル配信はレコード経路と同じ規則になった。**
// **【正直に書く】これは広がりである。** **「自分の行だけ」を保ちたいアプリは、
// 規則に条件(`when: { field: st_owner, equals_current_user: true }`)を書く**
// (`src/server/customer-scope.test.ts` の題材がその形である)。
//
// **2本目**: **どの行からも参照されていない file は、今日はログインしている全員に配信される。**
// **`V8-M27-T03` がアップロードの口を面で開いた結果、`viewer` と宣言された種類も
// 上げられるようになった** —— **上げた直後のプレビューを 404 にすると、上げる口だけが
// 開いていて中身を確かめられない状態になる。** **未ログインは今日も1件も受け取れない。**
// =====================================================================================
test("T04(反転): customer も、面が条件なしで read を許した表の他人の行の file を落とせる", async () => {
  const c1 = seedSession(dataRoot, APP, { role: "customer" });
  const c2 = seedSession(dataRoot, APP, { role: "customer" });
  const mine = await uploadFileId("%PDF-1.4\nmine\n", "mine.pdf");
  const theirs = await uploadFileId("%PDF-1.4\ntheirs\n", "theirs.pdf");
  await createRecordAs(c1.cookie, "invoices", { pdf: mine });
  await createRecordAs(c2.cookie, "invoices", { pdf: theirs });

  expect((await deliver(mine, c1.cookie)).status).toBe(200);
  expect((await deliver(theirs, c1.cookie)).status).toBe(200);
  // 未認証はどちらも 404。**この2行は1バイトも変わっていない。**
  expect((await deliver(mine)).status).toBe(404);
  expect((await deliver(theirs)).status).toBe(404);
});

test("T04(反転): どのレコードからも参照されない file は、ログイン済みの全員に 200(未認証は 404)", async () => {
  const c1 = seedSession(dataRoot, APP, { role: "customer" });
  const orphan = await uploadFileId("%PDF-1.4\norphan\n", "orphan.pdf");
  expect((await deliver(orphan, c1.cookie)).status).toBe(200);
  expect((await deliver(orphan, ownerCookie)).status).toBe(200);
  // **未認証は今日も 404 である**(この1行は新しく足した歯止め)。
  expect((await deliver(orphan)).status).toBe(404);
});
