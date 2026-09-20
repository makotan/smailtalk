/**
 * **`V17-M4-T03`(`AC-G21`)—— 添付ファイルの配布判定を、そのファイルを載せている
 * レコードの読取に揃える。**
 *
 * ## 実装する規則(**ユーザ決定 2026-09-08。`D2` / `D4` / `D5` と、言い直した原則の全部**)
 *
 * > **そのファイルを載せているレコードを読めるなら受け取れる。まだどのレコードにも
 * > 載っていない間は上げた本人だけ。上げた人が分からない古いファイルは誰にも渡さない。
 * > 運営者も例外にしない。**
 *
 * ## この検査が撃つ3つの穴(**着手前はどれも 200 が返る = 赤**)
 *
 * - **(あ) 未参照ファイル** —— **`user1` が上げた、まだどの行にも載せていないファイルを、
 *   無関係な `user3` が受け取れる**(`app.ts` の走査の末尾の fall-through)。
 *   **起票 `V17-M4-T03` が名指しした穴である。** **`owner` も同じく受け取れる** ——
 *   **`D4` は「運営者も例外にしない」と決めた。**
 * - **(い) 行ごとの権限を宣言していない表 + 条件つきの読取** —— **役割の `read` に
 *   `when` を書いた相手が、条件から外れる行に載ったファイルを受け取れる**
 *   (走査は `rowVisible` しか見ておらず、`rowVisible` は役割の規則を1文字も見ない)。
 *   **`D5` の相手である。**
 * - **(う) 他人の個人所有(`st_owner`)の行にだけ載っているファイル** ——
 *   **面が `st_owner` を越えない相手は `rowVisible` が偽になって `continue` するが、
 *   「参照されている」という事実が残らないので、末尾の fall-through が
 *   「未参照」と判断して配ってしまう。** **起票にもユーザ決定にも明示が無く、
 *   計画の担当が読解で見つけ、本ファイルが実行で再現させる穴である。**
 *
 * ## `D2` の再現(**上げた人が分からない古いファイル**)
 *
 * **列を足す前に上げた行を模すため、`_files` の上げた人の列を直接 NULL にしてから
 * `owner` を含む全員が取る。** **誰にも渡さないのが `D2` の答えである。**
 *
 * ## 陰性対照(**着手の前後どちらでも緑でなければならない**)
 *
 * - **未ログイン(匿名)の枝6本** —— **本段は匿名の枝を1バイトも変えない**
 *   (`ADR-0161` 限定5 / `ADR-0034`)。
 * - **`_files` を持たないアプリへの配布は 404。**
 * - **定義が読めないときは誰にも配らない**(`ADR-0321` 限定7 / `D-V8-73`)。
 * - **行に保存したあとの配布判定**(条件に合う行・自分の行・公開行)**が着手前と同じ。**
 *
 * ## この検査が言わないこと(**正直に**)
 *
 * - **性能を1件も測っていない** —— **配布1件ごとに役割の判定が増える。**
 * - **実地データを1バイトも読み書きしていない**(題材は一時ディレクトリに毎回作る)。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP = "office";

/**
 * 題材。**3つの表がそれぞれ別の穴を撃つ**:
 *
 * - `memos`: **行ごとの権限を宣言していない表**(`st_owner` も `st_public` も無い)。
 *   **顧客の `read` は `tag` が `open` の行にだけ当たる** → **(い)**。
 * - `receipts`: **個人所有**(`st_owner`)。**顧客の `read` は自分の行にだけ当たる**
 *   → **面が `st_owner` を越えない** → **(う)**。
 * - `catalog`: **公開表**(`st_public`)。**匿名の枝6本の題材**である。
 */
function officeManifest(): Manifest {
  return {
    app: {
      id: APP,
      name: "事務所",
      tables: [
        {
          id: "memos",
          name: "メモ",
          fields: [
            { id: "tag", name: "区分", type: "text" },
            { id: "pic", name: "画像", type: "image" },
          ],
        },
        {
          id: "receipts",
          name: "レシート",
          fields: [
            { id: "img", name: "画像", type: "image" },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
        {
          id: "catalog",
          name: "カタログ",
          fields: [
            { id: "name", name: "商品名", type: "text", required: true },
            { id: "photo", name: "商品画像", type: "image" },
            { id: "st_public", name: "公開", type: "boolean" },
          ],
        },
      ],
      views: [],
    },
  };
}

function officeManifestWithRoles(): Manifest {
  const manifest = withDefaultRoleRules(officeManifest());
  manifest.app.roles = [
    ...(manifest.app.roles ?? []),
    {
      id: "customer",
      name: "顧客",
      rules: [
        // **(い) の相手** —— **条件つきの読取。`tag` が `open` の行にしか当たらない。**
        {
          target: "table",
          table: "memos",
          can: ["read", "write"],
          when: { field: "tag", equals: "open" },
        },
        // **(う) の相手** —— **条件つきなので、面は `st_owner` の絞り込みを越えない。**
        {
          target: "table",
          table: "receipts",
          can: ["read", "write"],
          when: { field: "st_owner", equals_current_user: true },
        },
        { target: "table", table: "catalog", can: ["read"] },
      ],
    },
    // **匿名には `catalog` の読取1本だけを配る**(自動付与は `anonymous` に1本も配らない)。
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
let user1: { cookie: string; userId: string };
let user3: { cookie: string; userId: string };

async function uploadAs(cookie: string, data: Uint8Array): Promise<string> {
  const form = new FormData();
  form.set("file", new Blob([Uint8Array.from(data)]), "photo.png");
  const res = await app.request(
    new Request(`http://localhost/api/apps/${APP}/files`, {
      method: "POST",
      headers: { cookie, origin: TEST_ORIGIN },
      body: form,
    }),
  );
  expect(res.status, `upload -> ${await res.clone().text()}`).toBe(201);
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
  expect(res.status, `create ${tableId} -> ${await res.clone().text()}`).toBe(201);
}

async function deliverStatus(fileId: string, cookie?: string): Promise<number> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  const res = await app.request(
    new Request(`http://localhost/api/apps/${APP}/files/${fileId}`, { headers }),
  );
  return res.status;
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-file-uploader-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "事務所", { app_id: APP });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP, officeManifestWithRoles()).valid).toBe(true);
  app = createServerApp({ dataRoot });
  ownerCookie = seedSession(dataRoot, APP).cookie; // owner 既定
  const u1 = seedSession(dataRoot, APP, { role: "customer", username: "user1" });
  const u3 = seedSession(dataRoot, APP, { role: "customer", username: "user3" });
  user1 = { cookie: u1.cookie, userId: u1.userId };
  user3 = { cookie: u3.cookie, userId: u3.userId };
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

// =====================================================================================
// (あ) 未参照ファイル —— **上げた本人だけ**(`D4`。**運営者も例外にしない**)
// =====================================================================================

test("(あ-1) `user1` が上げた未参照ファイルは、`user1` に 200(着手の前後とも)", async () => {
  const orphan = await uploadAs(user1.cookie, pngBytes(10));
  expect(await deliverStatus(orphan, user1.cookie)).toBe(200);
});

test("(あ-2) `user1` が上げた未参照ファイルは、無関係な `user3` に 404", async () => {
  const orphan = await uploadAs(user1.cookie, pngBytes(11));
  expect(await deliverStatus(orphan, user3.cookie)).toBe(404);
});

test("(あ-3) `user1` が上げた未参照ファイルは、`owner` にも 404(運営者も例外にしない)", async () => {
  const orphan = await uploadAs(user1.cookie, pngBytes(12));
  expect(await deliverStatus(orphan, ownerCookie)).toBe(404);
});

// =====================================================================================
// (い) 宣言していない表 + 条件つきの読取(`D5`)
// =====================================================================================

test("(い) 条件から外れる行に載ったファイルは 404(宣言していない表)", async () => {
  const closed = await uploadAs(ownerCookie, pngBytes(20));
  await createRecord(ownerCookie, "memos", { tag: "closed", pic: closed });
  expect(await deliverStatus(closed, user1.cookie)).toBe(404);
});

test("(い-陰性) 条件に合う行に載ったファイルは 200(着手の前後とも)", async () => {
  const open = await uploadAs(ownerCookie, pngBytes(21));
  await createRecord(ownerCookie, "memos", { tag: "open", pic: open });
  expect(await deliverStatus(open, user1.cookie)).toBe(200);
});

// =====================================================================================
// (う) 他人の個人所有(`st_owner`)の行にだけ載っているファイル
// =====================================================================================

test("(う) 他人の `st_owner` 行にだけ載っているファイルは 404", async () => {
  const theirs = await uploadAs(user3.cookie, pngBytes(30));
  await createRecord(user3.cookie, "receipts", { img: theirs });
  expect(await deliverStatus(theirs, user1.cookie)).toBe(404);
});

test("(う-陰性) 自分の `st_owner` 行に載っているファイルは 200(着手の前後とも)", async () => {
  const mine = await uploadAs(user1.cookie, pngBytes(31));
  await createRecord(user1.cookie, "receipts", { img: mine });
  expect(await deliverStatus(mine, user1.cookie)).toBe(200);
});

// =====================================================================================
// `D2` —— **上げた人が分からない古いファイルは誰にも渡さない**
// =====================================================================================

test("(D2) 上げた人の記録が無い未参照ファイルは、`owner` を含む全員に 404", async () => {
  const orphan = await uploadAs(user1.cookie, pngBytes(40));
  // **列を足す前に上げた行を模す** —— **直接 NULL にする。**
  const db = new Database(join(dataRoot, "apps", APP, "app.sqlite"));
  try {
    db.exec(`UPDATE "_files" SET "uploaded_by" = NULL`);
  } finally {
    db.close();
  }
  expect(await deliverStatus(orphan, user1.cookie)).toBe(404);
  expect(await deliverStatus(orphan, user3.cookie)).toBe(404);
  expect(await deliverStatus(orphan, ownerCookie)).toBe(404);
});

// =====================================================================================
// 陰性対照(1) —— **未ログイン(匿名)の枝6本を1バイトも変えない**
// =====================================================================================

test("(陰性-匿名1) 公開行の image は未認証で 200", async () => {
  const filePublic = await uploadAs(ownerCookie, pngBytes(50));
  await createRecord(ownerCookie, "catalog", {
    name: "公開商品",
    photo: filePublic,
    st_public: true,
  });
  expect(await deliverStatus(filePublic)).toBe(200);
});

test("(陰性-匿名2) 非公開行(st_public=false)の image は未認証で 404", async () => {
  const filePrivate = await uploadAs(ownerCookie, pngBytes(51));
  await createRecord(ownerCookie, "catalog", {
    name: "非公開商品",
    photo: filePrivate,
    st_public: false,
  });
  expect(await deliverStatus(filePrivate)).toBe(404);
});

test("(陰性-匿名3) 宣言も公開も持たない表の image は未認証で 404", async () => {
  const fileMemo = await uploadAs(ownerCookie, pngBytes(52));
  await createRecord(ownerCookie, "memos", { tag: "open", pic: fileMemo });
  expect(await deliverStatus(fileMemo)).toBe(404);
});

test("(陰性-匿名4) 個人所有の行の image は未認証で 404", async () => {
  const mine = await uploadAs(user1.cookie, pngBytes(53));
  await createRecord(user1.cookie, "receipts", { img: mine });
  expect(await deliverStatus(mine)).toBe(404);
});

test("(陰性-匿名5) どのレコードからも参照されない file は未認証で 404", async () => {
  const orphan = await uploadAs(user1.cookie, pngBytes(54));
  expect(await deliverStatus(orphan)).toBe(404);
});

test("(陰性-匿名6) 存在しない file_id は未認証で 404(列挙耐性)", async () => {
  expect(await deliverStatus("00000000-0000-4000-8000-000000000000")).toBe(404);
});

// =====================================================================================
// 陰性対照(2) —— `_files` を持たないアプリ / 定義が読めないとき
// =====================================================================================

test("(陰性) `_files` を持たないアプリ(1件も上げていない)への配布は 404", async () => {
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "空店", { app_id: "empty" });
  } finally {
    store.close();
  }
  expect(
    applyManifest(dataRoot, "empty", { app: { id: "empty", name: "空店", tables: [], views: [] } })
      .valid,
  ).toBe(true);
  const ownerEmpty = seedSession(dataRoot, "empty").cookie;
  const res = await app.request(
    new Request(`http://localhost/api/apps/empty/files/anything`, {
      headers: { cookie: ownerEmpty },
    }),
  );
  expect(res.status).toBe(404);
});

test("(陰性) 定義が読めないときは、上げた本人にも `owner` にも配らない", async () => {
  const orphan = await uploadAs(user1.cookie, pngBytes(60));
  await writeFile(join(dataRoot, "apps", APP, "manifest.json"), "壊れています", "utf8");
  app = createServerApp({ dataRoot });
  expect(await deliverStatus(orphan, user1.cookie)).toBe(404);
  expect(await deliverStatus(orphan, ownerCookie)).toBe(404);
  expect(await deliverStatus(orphan)).toBe(404);
});

// =====================================================================================
// 遅延マイグレーション —— **列を持たない `_files` を既に持つアプリでも上げられる**
// =====================================================================================

/**
 * **陽性対照つき**(`V17-M4-T03b` の出口)。
 *
 * **着手前から在るアプリの `_files` は6列である。** **`CREATE TABLE IF NOT EXISTS` は
 * 既存テーブルに列を1本も足さない**ので、`ensureFilesTable` の `ALTER TABLE ADD COLUMN` が
 * 無いと INSERT が `no such column: uploaded_by` で落ち、**そのアプリは1件も上げられなくなる。**
 *
 * **本検査は「6列の `_files` を手で作ってから上げる」** —— **通れば移行が効いている。**
 * **移行を外したときに実際に落ちることは、実施担当が製品コードから一時的に外して
 * 打って確かめた**(記録 `docs/plan/v17/records/v17-m4.md` §3)。
 */
test("(移行) 上げた人の列を持たない `_files` を既に持つアプリでも、アップロードが落ちない", async () => {
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "旧店", { app_id: "legacy" });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, "legacy", legacyManifest()).valid).toBe(true);
  // **着手前の `_files`(6列ちょうど)を手で作る。**
  const db = new Database(join(dataRoot, "apps", "legacy", "app.sqlite"));
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS "_files" (\n` +
        `  "file_id" TEXT PRIMARY KEY,\n` +
        `  "sha256" TEXT NOT NULL,\n` +
        `  "mime" TEXT NOT NULL,\n` +
        `  "size" INTEGER NOT NULL,\n` +
        `  "filename" TEXT,\n` +
        `  "created_at" TEXT NOT NULL\n` +
        `)`,
    );
    expect(db.query(`PRAGMA table_info("_files")`).all().length).toBe(6);
  } finally {
    db.close();
  }
  const ownerLegacy = seedSession(dataRoot, "legacy").cookie;
  const form = new FormData();
  form.set("file", new Blob([Uint8Array.from(pngBytes(70))]), "photo.png");
  const res = await app.request(
    new Request(`http://localhost/api/apps/legacy/files`, {
      method: "POST",
      headers: { cookie: ownerLegacy, origin: TEST_ORIGIN },
      body: form,
    }),
  );
  expect(res.status, `upload -> ${await res.clone().text()}`).toBe(201);
  const fileId = ((await res.json()) as { file_id: string }).file_id;

  // **列は 6 → 7 ちょうど**(8本目を足していない)。
  const after = new Database(join(dataRoot, "apps", "legacy", "app.sqlite"));
  try {
    const columns = (after.query(`PRAGMA table_info("_files")`).all() as { name: string }[]).map(
      (column) => column.name,
    );
    expect(columns.length).toBe(7);
    expect(columns).toEqual([
      "file_id",
      "sha256",
      "mime",
      "size",
      "filename",
      "created_at",
      "uploaded_by",
    ]);
  } finally {
    after.close();
  }

  // **上げた本人は受け取れる。** **上げていない人は受け取れない。**
  const otherLegacy = seedSession(dataRoot, "legacy", { role: "editor" }).cookie;
  const mine = await app.request(
    new Request(`http://localhost/api/apps/legacy/files/${fileId}`, {
      headers: { cookie: ownerLegacy },
    }),
  );
  expect(mine.status).toBe(200);
  const theirs = await app.request(
    new Request(`http://localhost/api/apps/legacy/files/${fileId}`, {
      headers: { cookie: otherLegacy },
    }),
  );
  expect(theirs.status).toBe(404);
});

/** 移行の題材(`memos` 1本だけ。**上の題材とは別のアプリである**)。 */
function legacyManifest(): Manifest {
  return withDefaultRoleRules({
    app: {
      id: "legacy",
      name: "旧店",
      tables: [
        {
          id: "memos",
          name: "メモ",
          fields: [
            { id: "tag", name: "区分", type: "text" },
            { id: "pic", name: "画像", type: "image" },
          ],
        },
      ],
      views: [],
    },
  });
}
