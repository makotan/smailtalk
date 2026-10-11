/**
 * **下見の前段**(`V20-M13-T02b`。計画 `docs/plan/v20/15-v20-m13-plan.md` §9-1・§9-4・§10-2・§10-4 /
 * `ADR-0476` §Decision 1)。
 *
 * **HTTP で撃つ**(`createServerApp(...).request(...)`)。固定するもの(完了条件 §10-9 の 15・16・18):
 *
 * - **15** 未ログインで下見が開ける(一覧・1行・マニフェストが 200)/ 識別子を1文字変えると 410 /
 *   置き場を消してから開くと 410 で、メモリの2本目も捨てる。
 * - **16** 頼んだ人の見え方になる(頼んだ人にだけ見える行が見える / 別の役割の人のクッキーを
 *   付けても頼んだ人の見え方 / ブラウザのクッキーは写しに届かない)。
 * - **18** `GET` / `HEAD` 以外(`Origin` 無し・偽の `Origin` を含む)は 403 と文言で、写しも本体も
 *   変わらない / 許可リスト外の `GET` は1本ずつ 403 / 許可リスト内は通る。
 * - 応答の頭(`Referrer-Policy: no-referrer` / `Cache-Control: no-store` / `Set-Cookie` 無し /
 *   下見の頭 `X-Smailtalk-Preview`)。
 * - 本物のアプリが `pv-<32桁>` の綴りで実在するときは前段が受けない。
 * - **`runner` の版には前段が登録されない。**
 *
 * **置き場は自分の一時ディレクトリの下**(`preview.root` を明示)で、`afterEach` で消す。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AuthStore } from "../auth/store.ts";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { appDbPath } from "../kernel/storage-paths.ts";
import { createPreview } from "../mcp/preview.ts";
import { attachCandidate } from "../mcp/preview-compare.ts";
import { createServerApp } from "./app.ts";
import type { AuthEnv } from "./auth-context.ts";
import {
  COMPARE_NOT_FOUND_MESSAGE,
  COMPARE_NOT_READABLE_MESSAGE,
  PREVIEW_COMPARE_PATH,
  PREVIEW_EXPIRED_MESSAGE,
  PREVIEW_FRONT_OWN_READS,
  PREVIEW_HEADER,
  PREVIEW_NOT_READABLE_MESSAGE,
  PREVIEW_READ_ALLOWLIST,
  PREVIEW_READ_ONLY_MESSAGE,
  PREVIEW_REQUESTER_LABEL,
  type PreviewFrontCache,
  registerPreviewFront,
  toPreviewResponse,
} from "./preview-front.ts";
import { manifestSha256, type PreviewMeta, previewAppId } from "./preview-store.ts";
import { authed, seedSession, TEST_ORIGIN } from "./test-helpers.ts";

const APP_ID = "memo-app";

/** 書いた人の行(と持ち主の無い行)だけ。 */
const MINE = {
  or: [
    { field: "st_owner", equals_current_user: true },
    { field: "st_owner", is_empty: true },
  ],
};

function memoManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "メモ帳",
      tables: [
        {
          id: "notes",
          name: "メモ",
          fields: [
            { id: "title", name: "題", type: "text", required: true },
            // 個人スコープ(書いた人にだけ見える)。
            { id: "st_owner", name: "持ち主", type: "text" },
          ],
        },
      ],
      views: [
        {
          id: "note-list",
          type: "list_view",
          name: "メモ一覧",
          table: "notes",
          columns: ["title"],
        },
      ],
      // **行は書いた人にだけ見える**(`st_owner` の条件つきの規則)。 **差分を当てるとカーネルが
      // 同じ条件を自分で足すので、最初から書いておく**(本体と写しで見え方の前提を揃える)。
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            { target: "table", table: "notes", can: ["read", "write", "delete"], when: MINE },
            { target: "view", view: "note-list", can: ["read"] },
          ],
        },
        {
          id: "editor",
          name: "編集者",
          rules: [
            { target: "table", table: "notes", can: ["read", "write"], when: MINE },
            { target: "view", view: "note-list", can: ["read"] },
          ],
        },
        {
          id: "viewer",
          name: "閲覧者",
          rules: [
            { target: "table", table: "notes", can: ["read"], when: MINE },
            { target: "view", view: "note-list", can: ["read"] },
          ],
        },
      ],
    },
  } as Manifest;
}

/** 下見で当てる差分: 列 `memo` を足し、一覧の名前と列を替える。 */
function previewDiff(): unknown {
  return {
    diff_id: "d-preview-front",
    intent: "メモに本文を持たせ、一覧で見たい",
    operations: [
      { op: "add_field", table: "notes", field: { id: "memo", name: "本文", type: "long_text" } },
      {
        op: "update_view",
        view: "note-list",
        changes: { name: "メモ一覧(下見)", columns: ["title", "memo"] },
      },
    ],
  };
}

let work = "";
let dataRoot = "";
let previewRoot = "";
let alice = { cookie: "", userId: "", sessionId: "" };
let bob = { cookie: "", userId: "", sessionId: "" };
let meta: PreviewMeta;
let pv = "";
let cache: PreviewFrontCache;
let app: ReturnType<typeof createServerApp>;
let aliceRowId = "";
let bobRowId = "";

function req(method: string, path: string, init: RequestInit = {}): Promise<Response> {
  return Promise.resolve(app.request(new Request(`http://localhost${path}`, { method, ...init })));
}

async function postNote(cookie: string, title: string): Promise<string> {
  const response = await app.request(
    authed(cookie)(`/api/apps/${APP_ID}/tables/notes/records`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    }),
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { record?: { _id?: string }; _id?: string };
  const id = body.record?._id ?? body._id;
  if (typeof id !== "string") throw new Error(`行の ID が返らなかった: ${JSON.stringify(body)}`);
  return id;
}

/** ディレクトリの下の全ファイルの (相対パス → sha256)。 */
function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      const r = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(p, r);
      else out[r] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir, "");
  return out;
}

function countRows(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.query('SELECT COUNT(*) AS n FROM "notes"').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

function titlesOf(body: unknown): string[] {
  const records = (body as { records?: Array<Record<string, unknown>> }).records ?? [];
  return records.map((r) => String(r.title)).sort();
}

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "gp-preview-front-"));
  dataRoot = join(work, "data");
  previewRoot = join(work, "previews");
  const kernel = KernelMetaStore.open(dataRoot);
  try {
    createApp(kernel, "メモ帳", { app_id: APP_ID });
  } finally {
    kernel.close();
  }
  expect(applyManifest(dataRoot, APP_ID, memoManifest()).valid).toBe(true);
  alice = seedSession(dataRoot, APP_ID, { username: "alice", role: "owner" });
  bob = seedSession(dataRoot, APP_ID, { username: "bob", role: "editor" });
  cache = new Map();
  app = createServerApp({ dataRoot, profile: "full", preview: { root: previewRoot, cache } });
  aliceRowId = await postNote(alice.cookie, "アリスのメモ1");
  await postNote(alice.cookie, "アリスのメモ2");
  bobRowId = await postNote(bob.cookie, "ボブのメモ");

  const created = createPreview({
    dataRoot,
    appId: APP_ID,
    diff: previewDiff(),
    mode: "real",
    requesterUserId: alice.userId,
    previewRoot,
  });
  if (created.kind !== "created") throw new Error(`下見を作れなかった: ${JSON.stringify(created)}`);
  meta = created.meta;
  pv = previewAppId(meta.preview_id);
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("15: 未ログインで下見が開ける", () => {
  test("未ログイン(クッキー無し)で マニフェスト・一覧・1行 が 200 で、差分を当てた後の姿が返る", async () => {
    const manifest = await req("GET", `/api/apps/${pv}/manifest`);
    expect(manifest.status).toBe(200);
    const manifestText = await manifest.text();
    expect(manifestText).toContain("メモ一覧(下見)");
    expect(manifestText).toContain('"memo"');

    const list = await req("GET", `/api/apps/${pv}/tables/notes/records`);
    expect(list.status).toBe(200);
    expect(titlesOf(await list.json())).toEqual(["アリスのメモ1", "アリスのメモ2"]);

    const one = await req("GET", `/api/apps/${pv}/tables/notes/records/${aliceRowId}`);
    expect(one.status).toBe(200);
    expect(JSON.stringify(await one.json())).toContain("アリスのメモ1");

    const me = await req("GET", `/api/apps/${pv}/auth/me`);
    expect(me.status).toBe(200);
    expect(JSON.stringify(await me.json())).toContain(alice.userId);

    // HEAD も通る(本文は無い)。
    const head = await req("HEAD", `/api/apps/${pv}/manifest`);
    expect(head.status).toBe(200);
  });

  test("陰性対照: 本体の同じ口は今日どおり未ログインで 401(本体は1バイトも開いていない)", async () => {
    const list = await req("GET", `/api/apps/${APP_ID}/tables/notes/records`);
    expect(list.status).toBe(401);
    const manifest = await req("GET", `/api/apps/${APP_ID}/manifest`);
    expect(manifest.status).toBe(401);
  });

  test("陰性: 識別子を1文字変えると 410 と「この下見は期限切れです」", async () => {
    const last = meta.preview_id.slice(-1);
    const changed = `pv-${meta.preview_id.slice(0, -1)}${last === "0" ? "1" : "0"}`;
    const response = await req("GET", `/api/apps/${changed}/tables/notes/records`);
    expect(response.status).toBe(410);
    const body = (await response.json()) as { errors: Array<{ path: string; message: string }> };
    expect(body.errors[0]?.path).toBe("");
    expect(body.errors[0]?.message).toBe(PREVIEW_EXPIRED_MESSAGE);
    expect(PREVIEW_EXPIRED_MESSAGE).toBe("この下見は期限切れです");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("置き場を消してから開くと 410 で、メモリの2本目も捨てる", async () => {
    const first = await req("GET", `/api/apps/${pv}/tables/notes/records`);
    expect(first.status).toBe(200);
    expect(cache.has(meta.preview_id)).toBe(true);

    rmSync(join(previewRoot, meta.preview_id), { recursive: true, force: true });
    const after = await req("GET", `/api/apps/${pv}/tables/notes/records`);
    expect(after.status).toBe(410);
    expect(
      ((await after.json()) as { errors: Array<{ message: string }> }).errors[0]?.message,
    ).toBe(PREVIEW_EXPIRED_MESSAGE);
    expect(cache.has(meta.preview_id)).toBe(false);
  });

  test("meta.json が壊れていると 410 で、置き場ごと消す", async () => {
    await req("GET", `/api/apps/${pv}/manifest`);
    writeFileSync(join(previewRoot, meta.preview_id, "meta.json"), "{ broken");
    const response = await req("GET", `/api/apps/${pv}/manifest`);
    expect(response.status).toBe(410);
    expect(existsSync(join(previewRoot, meta.preview_id))).toBe(false);
    expect(cache.has(meta.preview_id)).toBe(false);
  });

  test("作っている途中(meta.json がまだ無い)の置き場は、410 を返しても消さない", async () => {
    const midway = "0123456789abcdef0123456789abcdef";
    mkdirSync(join(previewRoot, midway), { recursive: true });
    const response = await req("GET", `/api/apps/pv-${midway}/manifest`);
    expect(response.status).toBe(410);
    expect(existsSync(join(previewRoot, midway))).toBe(true);
  });

  test("期限を過ぎると 410 で、置き場ごと消す(時計を進めて撃つ)", async () => {
    const expiresAt = Date.parse(meta.expires_at);
    const late = createServerApp({
      dataRoot,
      profile: "full",
      preview: { root: previewRoot, now: () => new Date(expiresAt) },
    });
    const response = await late.request(
      new Request(`http://localhost/api/apps/${pv}/tables/notes/records`),
    );
    expect(response.status).toBe(410);
    expect(existsSync(join(previewRoot, meta.preview_id))).toBe(false);
  });

  test("画面の URL /apps/pv-…/ は今日の配り方(SPA の index.html)で出る", async () => {
    const dist = join(work, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>SPA</title>");
    const withDist = createServerApp({
      dataRoot,
      profile: "full",
      webDistDir: dist,
      preview: { root: previewRoot },
    });
    const response = await withDist.request(new Request(`http://localhost/apps/${pv}/`));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>SPA</title>");
  });
});

describe("16: 頼んだ人の見え方になる", () => {
  test("陽性対照: 本体では bob の行は bob にだけ見える(alice には見えない)", async () => {
    const asAlice = await app.request(
      authed(alice.cookie)(`/api/apps/${APP_ID}/tables/notes/records`),
    );
    expect(titlesOf(await asAlice.json())).toEqual(["アリスのメモ1", "アリスのメモ2"]);
    const asBob = await app.request(authed(bob.cookie)(`/api/apps/${APP_ID}/tables/notes/records`));
    expect(titlesOf(await asBob.json())).toEqual(["ボブのメモ"]);
  });

  test("別の役割でログインしている人(bob)の本体のクッキーを付けて開いても、頼んだ人(alice)の見え方", async () => {
    const response = await req("GET", `/api/apps/${pv}/tables/notes/records`, {
      headers: { cookie: bob.cookie },
    });
    expect(response.status).toBe(200);
    expect(titlesOf(await response.json())).toEqual(["アリスのメモ1", "アリスのメモ2"]);
    const hidden = await req("GET", `/api/apps/${pv}/tables/notes/records/${bobRowId}`, {
      headers: { cookie: bob.cookie },
    });
    expect(hidden.status).not.toBe(200);
    const me = await req("GET", `/api/apps/${pv}/auth/me`, { headers: { cookie: bob.cookie } });
    expect(JSON.stringify(await me.json())).toContain(alice.userId);
  });

  test("ブラウザのクッキーは写しに届かない: 写しの中で効く bob のセッションを付けても alice の見え方", async () => {
    // 写しの中にだけ bob のセッションを作る(届けば bob の見え方になるクッキー)。
    const store = AuthStore.openForApp(meta.shadow_data_root, APP_ID);
    let bobInCopy = "";
    try {
      bobInCopy = store.createSession(bob.userId, 3600).id;
    } finally {
      store.close();
    }
    // 陽性対照: 写しを直に開けば、このクッキーは bob の見え方になる。
    const direct = createServerApp({
      dataRoot: meta.shadow_data_root,
      profile: "full",
      preview: false,
    });
    const directResponse = await direct.request(
      authed(`st_session=${bobInCopy}`)(`/api/apps/${APP_ID}/tables/notes/records`),
    );
    expect(titlesOf(await directResponse.json())).toEqual(["ボブのメモ"]);

    const viaFront = await req("GET", `/api/apps/${pv}/tables/notes/records`, {
      headers: { cookie: `st_session=${bobInCopy}; other=1` },
    });
    expect(viaFront.status).toBe(200);
    expect(titlesOf(await viaFront.json())).toEqual(["アリスのメモ1", "アリスのメモ2"]);
  });
});

describe("18: GET 以外と許可リスト外は文言つきで断られる", () => {
  const WRITES: Array<{ method: string; path: string; origin: string | undefined }> = [];
  for (const origin of [undefined, "http://evil.example", TEST_ORIGIN, "http://localhost"]) {
    WRITES.push({ method: "POST", path: "/tables/notes/records", origin });
    WRITES.push({ method: "PATCH", path: "/tables/notes/records/X", origin });
    WRITES.push({ method: "PUT", path: "/tables/notes/records/X", origin });
    WRITES.push({ method: "DELETE", path: "/tables/notes/records/X", origin });
    WRITES.push({ method: "POST", path: "/diffs", origin });
    WRITES.push({ method: "POST", path: "/batch", origin });
    WRITES.push({ method: "POST", path: "/auth/logout", origin });
    WRITES.push({ method: "DELETE", path: "/auth/me", origin });
  }

  test("GET / HEAD 以外は 403「下見なので保存されません」で、写しも本体も1バイトも変わらない", async () => {
    expect(PREVIEW_READ_ONLY_MESSAGE).toBe("下見なので保存されません");
    // 先に1度開いて、写しの DB の WAL などを落ち着かせてから指紋を取る。
    expect((await req("GET", `/api/apps/${pv}/tables/notes/records`)).status).toBe(200);
    const beforeMain = fingerprint(dataRoot);
    const beforeCopy = fingerprint(meta.shadow_data_root);
    const beforeRows = [
      countRows(appDbPath(dataRoot, APP_ID)),
      countRows(appDbPath(meta.shadow_data_root, APP_ID)),
    ];

    for (const shot of WRITES) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        cookie: alice.cookie,
      };
      if (shot.origin !== undefined) headers.origin = shot.origin;
      const path = `/api/apps/${pv}${shot.path.replace("/X", `/${aliceRowId}`)}`;
      const response = await req(shot.method, path, {
        headers,
        body: JSON.stringify({ title: "書き込めてはならない", ops: [] }),
      });
      const label = `${shot.method} ${shot.path} origin=${String(shot.origin)}`;
      expect(response.status, label).toBe(403);
      const body = (await response.json()) as {
        errors: Array<{ path: string; message: string; hint?: string }>;
      };
      expect(body.errors[0]?.path, label).toBe("");
      expect(body.errors[0]?.message, label).toBe(PREVIEW_READ_ONLY_MESSAGE);
      expect(typeof body.errors[0]?.hint, label).toBe("string");
      expect(response.headers.get(PREVIEW_HEADER), label).toContain("mode=real");
    }

    expect(fingerprint(dataRoot)).toEqual(beforeMain);
    expect(fingerprint(meta.shadow_data_root)).toEqual(beforeCopy);
    expect([
      countRows(appDbPath(dataRoot, APP_ID)),
      countRows(appDbPath(meta.shadow_data_root, APP_ID)),
    ]).toEqual(beforeRows);
    expect(beforeRows).toEqual([3, 3]);
  });

  /** 許可リストの外の GET(1本ずつ撃つ)。`ADR-0419` の3本を含む。 */
  const REFUSED_GETS = [
    "/auth/users",
    "/auth/activity",
    "/connections",
    "/connections/requests",
    "/ai-capabilities",
    "/ai-capabilities/requests",
    "/escape-hatch-assets",
    "/escape-hatch-assets/requests",
    "/comments",
    "/changelog",
    "/undo/preview",
    "/requirements",
    "/requirements?format=json",
    "/tables/notes/unreachable-records",
    "/tables/notes/records/ROW/access-sources",
    "/diffs",
    "/no-such-thing",
  ];

  for (const suffix of REFUSED_GETS) {
    test(`許可リスト外の GET ${suffix} は 403「下見では開けません」`, async () => {
      const path = `/api/apps/${pv}${suffix.replace("ROW", aliceRowId)}`;
      const response = await req("GET", path);
      expect(response.status).toBe(403);
      const body = (await response.json()) as { errors: Array<{ path: string; message: string }> };
      expect(body.errors[0]?.message).toBe(PREVIEW_NOT_READABLE_MESSAGE);
      expect(response.headers.get("cache-control")).toBe("no-store");
      // 写しの2本目を作ってもいない(断るのは写しへ渡す前)。
      expect(cache.has(meta.preview_id)).toBe(false);
    });
  }

  // **【`V20-M13` 点検の処置 重1】** 許可リストの records 2形の `:table_id` にシステムの表
  // (`_changelog` / `_ai_usage` / `_apps`。`src/shared/system-tables.ts`)を入れると、頼んだ人が
  // owner なら写しの2本目が答えて変更履歴の意図の本文が出ていた。 **頼んだ人は owner**(alice)。
  // `%5F` で `_` を隠した綴り・`_` で始まる未知の表も同じく断る。
  const SYSTEM_TABLE_GETS = [
    "/tables/_changelog/records",
    "/tables/_changelog/records/1",
    "/tables/_ai_usage/records",
    "/tables/_ai_usage/records/1",
    "/tables/_apps/records",
    "/tables/_apps/records/1",
    "/tables/%5Fchangelog/records",
    "/tables/%5fchangelog/records/1",
    "/tables/_no_such_system/records",
  ];
  for (const suffix of SYSTEM_TABLE_GETS) {
    test(`システムの表 GET ${suffix} は、頼んだ人が owner でも 403「下見では開けません」`, async () => {
      const response = await req("GET", `/api/apps/${pv}${suffix}`);
      const text = await response.text();
      expect(response.status, text).toBe(403);
      expect(JSON.parse(text).errors[0]?.message).toBe(PREVIEW_NOT_READABLE_MESSAGE);
      expect(text).not.toContain("intent");
      expect(text).not.toContain("メモに本文を持たせ");
      // 写しの2本目を作ってもいない(断るのは写しへ渡す前)。
      expect(cache.has(meta.preview_id)).toBe(false);
    });
  }

  test("陰性対照: 作り手の表(notes)は一覧も1行も 200 のまま・本体の owner には _changelog が開く(式が空振りしていない)", async () => {
    expect((await req("GET", `/api/apps/${pv}/tables/notes/records`)).status).toBe(200);
    expect((await req("GET", `/api/apps/${pv}/tables/notes/records/${aliceRowId}`)).status).toBe(
      200,
    );
    const real = await app.request(
      authed(alice.cookie)(`/api/apps/${APP_ID}/tables/_changelog/records`),
    );
    expect(real.status).toBe(200);
  });

  test("許可リストは8本で、名指しした形ちょうど", () => {
    expect(PREVIEW_READ_ALLOWLIST.map((entry) => entry.pattern)).toEqual([
      "/manifest",
      "/public",
      "/auth/me",
      "/tables/:table_id/records",
      "/tables/:table_id/records/:record_id",
      "/views/:view_id/report",
      "/views/:view_id/custom.css",
      "/files/:file_id",
    ]);
  });

  test("許可リスト内の GET は前段に断られずに写しへ届く(8本すべて)", async () => {
    const paths = [
      "/manifest",
      "/public",
      "/auth/me",
      "/tables/notes/records",
      `/tables/notes/records/${aliceRowId}`,
      "/views/note-list/report",
      "/views/note-list/custom.css",
      "/files/no-such-file",
    ];
    for (const suffix of paths) {
      const response = await req("GET", `/api/apps/${pv}${suffix}`);
      const text = await response.text();
      expect(text, suffix).not.toContain(PREVIEW_NOT_READABLE_MESSAGE);
      expect(text, suffix).not.toContain(PREVIEW_READ_ONLY_MESSAGE);
      expect(response.status, suffix).not.toBe(410);
      expect(response.headers.get(PREVIEW_HEADER), suffix).toContain("mode=real");
    }
  });

  test("偽の Origin を付けた GET も読み物は読める(オリジンの検査は書き込みにしか掛からない)", async () => {
    const response = await req("GET", `/api/apps/${pv}/tables/notes/records`, {
      headers: { origin: "http://evil.example" },
    });
    expect(response.status).toBe(200);
  });
});

describe("頼んだ人のログイン名を見る人に渡さない(`V20-M13` 点検の処置 軽2)", () => {
  test("/auth/me の username と displayName は「下見」に置き換わり、id・役割は残る", async () => {
    const response = await req("GET", `/api/apps/${pv}/auth/me`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("alice");
    const body = JSON.parse(text) as {
      user: {
        id: string;
        username: string;
        displayName: string | null;
        role: string;
        roles: string[];
      };
    };
    expect(body.user.username).toBe(PREVIEW_REQUESTER_LABEL);
    expect(body.user.displayName).toBe(PREVIEW_REQUESTER_LABEL);
    expect(PREVIEW_REQUESTER_LABEL).toBe("下見");
    expect(body.user.id).toBe(alice.userId);
    expect(body.user.role).toBe("owner");
    expect(body.user.roles).toContain("owner");
    // 長さの頭は置き換えた本文と合う(古い長さを残さない)。
    const length = response.headers.get("content-length");
    if (length !== null) expect(Number(length)).toBe(new TextEncoder().encode(text).length);
  });

  test("陽性対照: 本体の /auth/me は今日どおりログイン名を返す", async () => {
    const real = await app.request(authed(alice.cookie)(`/api/apps/${APP_ID}/auth/me`));
    expect(await real.text()).toContain("alice");
  });

  test("HEAD /auth/me も 200 で本文は無い", async () => {
    const head = await req("HEAD", `/api/apps/${pv}/auth/me`);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
});

describe("期限切れの hint(`V20-M13` 点検の処置 軽4)", () => {
  test("410 の hint に、作った側と開く側で置き場(ST_PREVIEW_ROOT)が違うと期限切れに見える旨が在る", async () => {
    const response = await req("GET", `/api/apps/pv-${"f".repeat(32)}/manifest`);
    expect(response.status).toBe(410);
    const body = (await response.json()) as { errors: Array<{ hint?: string }> };
    expect(body.errors[0]?.hint ?? "").toContain("ST_PREVIEW_ROOT");
    expect(body.errors[0]?.hint ?? "").toContain("作った直後");
  });
});

describe("応答の頭", () => {
  test("no-referrer・no-store・Set-Cookie 無し・下見の頭(モードと期限)", async () => {
    for (const suffix of ["/manifest", "/tables/notes/records", "/auth/me"]) {
      const response = await req("GET", `/api/apps/${pv}${suffix}`);
      expect(response.status, suffix).toBe(200);
      expect(response.headers.get("referrer-policy"), suffix).toBe("no-referrer");
      expect(response.headers.get("cache-control"), suffix).toBe("no-store");
      expect(response.headers.get("set-cookie"), suffix).toBeNull();
      expect(response.headers.get(PREVIEW_HEADER), suffix).toBe(
        `mode=real; expires_at=${meta.expires_at}`,
      );
    }
    expect(PREVIEW_HEADER).toBe("X-Smailtalk-Preview");
  });

  test("転送した応答の Set-Cookie は落とす(応答を整える関数を直に撃つ)", async () => {
    const inner = new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "set-cookie": "st_session=leak; Path=/api/apps/memo-app",
        "cache-control": "max-age=60",
      },
    });
    const shaped = toPreviewResponse(inner, meta);
    expect(shaped.headers.get("set-cookie")).toBeNull();
    expect(shaped.headers.get("cache-control")).toBe("no-store");
    expect(shaped.headers.get("referrer-policy")).toBe("no-referrer");
    expect(shaped.headers.get(PREVIEW_HEADER)).toBe(`mode=real; expires_at=${meta.expires_at}`);
    expect(await shaped.text()).toBe("{}");
  });
});

describe("前段が受けない場合", () => {
  test("本物のアプリが pv-<32桁> の綴りで実在するときは前段が受けない(本体が今日どおり答える)", async () => {
    // 下見と同じ綴りの本物のアプリを作る。
    const kernel = KernelMetaStore.open(dataRoot);
    try {
      createApp(kernel, "同じ綴りの本物", { app_id: pv });
    } finally {
      kernel.close();
    }
    const response = await req("GET", `/api/apps/${pv}/tables/notes/records`);
    expect(response.status).not.toBe(200);
    expect(response.status).not.toBe(410);
    expect(response.headers.get(PREVIEW_HEADER)).toBeNull();
    const manifest = await req("GET", `/api/apps/${pv}/manifest`);
    expect(manifest.status).toBe(401); // 本体の manifest の関門
    expect(manifest.headers.get(PREVIEW_HEADER)).toBeNull();
  });

  test("綴りが pv-<16進32桁> でないアプリID は前段が受けない(大文字・31桁・33桁)", async () => {
    for (const id of [
      `pv-${meta.preview_id.toUpperCase()}`,
      `pv-${meta.preview_id.slice(1)}`,
      `pv-${meta.preview_id}0`,
    ]) {
      const response = await req("GET", `/api/apps/${id}/tables/notes/records`);
      expect(response.status, id).not.toBe(200);
      expect(response.status, id).not.toBe(410);
      expect(response.headers.get(PREVIEW_HEADER), id).toBeNull();
    }
  });

  test("runner の版には前段が登録されない(同じ下見の URL が 200 にも 410 にもならない)", async () => {
    const runner = createServerApp({ dataRoot, profile: "runner", preview: { root: previewRoot } });
    const routes = (runner as unknown as { routes: Array<{ method: string; path: string }> })
      .routes;
    expect(routes.map((r) => `${r.method} ${r.path}`)).not.toContain("ALL /api/apps/:app_id/*");
    const response = await runner.request(
      new Request(`http://localhost/api/apps/${pv}/tables/notes/records`),
    );
    expect(response.status).not.toBe(200);
    expect(response.status).not.toBe(410);
    expect(response.headers.get(PREVIEW_HEADER)).toBeNull();

    // 陽性対照: full の版には登録されている。
    const fullRoutes = (app as unknown as { routes: Array<{ method: string; path: string }> })
      .routes;
    expect(fullRoutes.map((r) => `${r.method} ${r.path}`)).toContain("ALL /api/apps/:app_id/*");
  });

  test("preview: false の版(写しを描く2本目)には前段が登録されない", () => {
    const inner = createServerApp({ dataRoot, profile: "full", preview: false });
    const routes = (inner as unknown as { routes: Array<{ method: string; path: string }> }).routes;
    expect(routes.map((r) => `${r.method} ${r.path}`)).not.toContain("ALL /api/apps/:app_id/*");
  });
});

// ---------------------------------------------------------------------------
// **V20-M14-T01B 見比べの束の `/compare`**(計画 `16-v20-m14-plan.md` §9-2・§10-2・§10-3 / `ADR-0478` §Decision 1-4〜1-7)
// ---------------------------------------------------------------------------

/** 見比べの案を n 個作って束ねる。返すのは束の識別子(16進32桁)と案の登録票(作った順)。 */
function makeCompareGroup(
  n: number,
  // **【`V20-M15-T01B`】案ごとの `off_pattern`(省略すると渡さない = 票には `false`)。**
  offPatterns: readonly boolean[] = [],
): { groupId: string; metas: PreviewMeta[]; diffs: unknown[] } {
  let groupId = "";
  const metas: PreviewMeta[] = [];
  const diffs: unknown[] = [];
  for (let i = 0; i < n; i += 1) {
    const body = {
      diff_id: `d-compare-${i}`,
      intent: `案${i + 1}の意図: メモに本文を持たせたい`,
      operations: [
        {
          op: "add_field",
          table: "notes",
          field: { id: `memo${i}`, name: `本文${i}`, type: "text" },
        },
      ],
    };
    const baseManifestSha = manifestSha256(dataRoot, APP_ID);
    const created = createPreview({
      dataRoot,
      appId: APP_ID,
      diff: body,
      mode: "real",
      requesterUserId: alice.userId,
      previewRoot,
    });
    if (created.kind !== "created") throw new Error(JSON.stringify(created));
    const attached = attachCandidate({
      previewRoot,
      meta: created.meta,
      name: `案${i + 1}`,
      tradeoff: `トレードオフ${i + 1}`,
      diff: body,
      designNotices: [],
      baseManifestSha,
      group: i === 0 ? undefined : previewAppId(groupId),
      ...(offPatterns[i] === undefined ? {} : { offPattern: offPatterns[i] }),
    });
    if (!attached.ok) throw new Error(attached.reason);
    groupId = attached.groupId;
    metas.push(created.meta);
    diffs.push(body);
  }
  return { groupId, metas, diffs };
}

type CompareBody = {
  compare: {
    group: string;
    app_id: string;
    mode: string;
    expires_at: string;
    candidates: Array<Record<string, unknown>>;
  };
};

describe("V20-M14-T01B: 束の識別子への /compare", () => {
  test("前段が自分で答える読み物は /compare の1本ちょうどで、許可リスト(8本)には入っていない", () => {
    expect(PREVIEW_FRONT_OWN_READS).toEqual(["/compare"]);
    expect(PREVIEW_COMPARE_PATH).toBe("/compare");
    expect(PREVIEW_READ_ALLOWLIST).toHaveLength(8);
    expect(PREVIEW_READ_ALLOWLIST.map((entry) => entry.pattern)).not.toContain("/compare");
  });

  // **【`V20-M15-T01B` / `ADR-0479` §Decision 4-4】案のキーは 8 → 9(`off_pattern`)。 テスト名の「案8」は旧のまま残す(トップ1・中5は不変)。**
  test("未ログインの GET /compare は 200 で、応答のキーは ADR-0478 §Decision 1-5 の全量ちょうど(トップ1・中5・案8)", async () => {
    const { groupId, metas, diffs } = makeCompareGroup(3);
    const response = await req("GET", `/api/apps/pv-${groupId}/compare`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as CompareBody;
    expect(Object.keys(body)).toEqual(["compare"]);
    expect(Object.keys(body.compare).sort()).toEqual([
      "app_id",
      "candidates",
      "expires_at",
      "group",
      "mode",
    ]);
    expect(body.compare.group).toBe(`pv-${groupId}`);
    expect(body.compare.app_id).toBe(APP_ID);
    expect(body.compare.mode).toBe("real");
    expect(body.compare.expires_at).toBe(metas[0]?.expires_at as string);
    expect(body.compare.candidates).toHaveLength(3);
    body.compare.candidates.forEach((candidate, i) => {
      expect(Object.keys(candidate).sort()).toEqual([
        "design_notices",
        "diff",
        "id",
        "intent",
        "name",
        // 【`V20-M15-T01B`】9つ目。 旧(逐語)は "name" の次が "stale" の8キーだった。
        "off_pattern",
        "stale",
        "tradeoff",
        "url",
      ]);
      expect(candidate.off_pattern).toBe(false);
      const id = metas[i]?.preview_id as string;
      expect(candidate.id).toBe(`pv-${id}`);
      expect(candidate.url).toBe(`/apps/pv-${id}/`);
      expect(candidate.name).toBe(`案${i + 1}`);
      expect(candidate.tradeoff).toBe(`トレードオフ${i + 1}`);
      expect(candidate.intent).toBe(`案${i + 1}の意図: メモに本文を持たせたい`);
      expect(candidate.diff).toEqual(diffs[i]);
      expect(candidate.design_notices).toEqual([]);
      expect(candidate.stale).toBe(false);
    });
    // 行(レコード)を1行も返さない(`ADR-0478` §Decision 3 の `ADR-0014` の読み)。
    expect(JSON.stringify(body)).not.toContain("アリスのメモ");
    expect(JSON.stringify(body)).not.toContain(alice.userId);
  });

  test("【V20-M15-T01B】案の off_pattern は票の値のまま(付けた案だけ true)・票に無ければ false・トップ1と中5は不変", async () => {
    const { groupId, metas } = makeCompareGroup(3, [true, false]);
    // 3案目は票から off_pattern を消す(着手前に書かれた古い票と同じ形)。
    const legacy = join(previewRoot, metas[2]?.preview_id as string, "candidate.json");
    const saved = JSON.parse(readFileSync(legacy, "utf-8")) as Record<string, unknown>;
    delete saved.off_pattern;
    writeFileSync(legacy, JSON.stringify(saved), "utf-8");
    const response = await req("GET", `/api/apps/pv-${groupId}/compare`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as CompareBody;
    expect(Object.keys(body)).toEqual(["compare"]);
    expect(Object.keys(body.compare)).toHaveLength(5);
    expect(body.compare.candidates.map((c) => c.off_pattern)).toEqual([true, false, false]);
    for (const candidate of body.compare.candidates) {
      expect(Object.keys(candidate)).toHaveLength(9);
    }
  });

  test("応答の頭: no-referrer・no-store・Set-Cookie 無し・下見の頭(X-Smailtalk-Preview)は付けない", async () => {
    const { groupId } = makeCompareGroup(1);
    const response = await req("GET", `/api/apps/pv-${groupId}/compare`);
    expect(response.status).toBe(200);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get(PREVIEW_HEADER)).toBeNull();
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  test("HEAD /compare は 200 で本文が無い", async () => {
    const { groupId } = makeCompareGroup(1);
    const response = await req("HEAD", `/api/apps/pv-${groupId}/compare`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get(PREVIEW_HEADER)).toBeNull();
  });

  test("束の識別子への他の読み物(許可リストの8本を含む)は 403「見比べの画面では開けません」", async () => {
    const { groupId } = makeCompareGroup(1);
    expect(COMPARE_NOT_READABLE_MESSAGE).toBe("見比べの画面では開けません");
    for (const suffix of [
      "/manifest",
      "/public",
      "/auth/me",
      "/tables/notes/records",
      `/tables/notes/records/${aliceRowId}`,
      "/views/note-list/report",
      "/views/note-list/custom.css",
      "/files/no-such-file",
      "/auth/users",
      "/changelog",
      "/compare/extra",
    ]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await req(method, `/api/apps/pv-${groupId}${suffix}`);
        expect({ suffix, method, status: response.status }).toEqual({
          suffix,
          method,
          status: 403,
        });
        expect(response.headers.get(PREVIEW_HEADER), suffix).toBeNull();
        if (method === "GET") {
          const json = (await response.json()) as { errors: Array<{ message: string }> };
          expect(json.errors[0]?.message, suffix).toBe(COMPARE_NOT_READABLE_MESSAGE);
        }
      }
    }
  });

  test("束の識別子への GET / HEAD 以外は既存と同じ 403「下見なので保存されません」", async () => {
    const { groupId } = makeCompareGroup(1);
    for (const [method, suffix] of [
      ["POST", "/compare"],
      ["PUT", "/compare"],
      ["DELETE", "/compare"],
      ["POST", "/tables/notes/records"],
      ["POST", "/diffs"],
      ["PATCH", `/tables/notes/records/${aliceRowId}`],
    ] as const) {
      const response = await req(method, `/api/apps/pv-${groupId}${suffix}`, {
        headers: { origin: TEST_ORIGIN, "content-type": "application/json" },
        body: "{}",
      });
      expect({ method, suffix, status: response.status }).toEqual({ method, suffix, status: 403 });
      const json = (await response.json()) as { errors: Array<{ message: string }> };
      expect(json.errors[0]?.message).toBe(PREVIEW_READ_ONLY_MESSAGE);
    }
  });

  test("期限切れの束は 410「この下見は期限切れです」で、束の置き場を消す(時計を進めて撃つ)", async () => {
    const { groupId, metas } = makeCompareGroup(2);
    const late = createServerApp({
      dataRoot,
      profile: "full",
      preview: {
        root: previewRoot,
        now: () => new Date(Date.parse(metas[0]?.expires_at as string)),
      },
    });
    const response = await late.request(
      new Request(`http://localhost/api/apps/pv-${groupId}/compare`),
    );
    expect(response.status).toBe(410);
    const json = (await response.json()) as { errors: Array<{ message: string }> };
    expect(json.errors[0]?.message).toBe(PREVIEW_EXPIRED_MESSAGE);
    expect(response.headers.get(PREVIEW_HEADER)).toBeNull();
    expect(existsSync(join(previewRoot, groupId))).toBe(false);
    // 陽性対照: 期限の1ミリ秒前は 200。
    const before = createServerApp({
      dataRoot,
      profile: "full",
      preview: {
        root: previewRoot,
        now: () => new Date(Date.parse(metas[1]?.expires_at as string) - 1),
      },
    });
    const kept = makeCompareGroup(1);
    const ok = await before.request(
      new Request(`http://localhost/api/apps/pv-${kept.groupId}/compare`),
    );
    expect(ok.status).toBe(200);
  });

  test("登録の無い識別子への /compare は 410(不在)", async () => {
    const response = await req("GET", `/api/apps/pv-${"f".repeat(32)}/compare`);
    expect(response.status).toBe(410);
  });

  test("案の識別子(1案の下見)への /compare は 404(ADR-0003 §3 の形)。案の他の読み物は今日どおり", async () => {
    const { metas } = makeCompareGroup(2);
    for (const id of [meta.preview_id, metas[0]?.preview_id as string]) {
      const response = await req("GET", `/api/apps/pv-${id}/compare`);
      expect(response.status).toBe(404);
      const json = (await response.json()) as { errors: Array<{ path: string; message: string }> };
      expect(Object.keys(json)).toEqual(["errors"]);
      expect(json.errors[0]?.message).toBe(COMPARE_NOT_FOUND_MESSAGE);
      expect(typeof json.errors[0]?.path).toBe("string");
      const manifest = await req("GET", `/api/apps/pv-${id}/manifest`);
      expect(manifest.status).toBe(200);
    }
  });

  test("stale: 本物のアプリの manifest.json が変われば true、アプリが無ければ true(前段が比べる)", async () => {
    const { groupId } = makeCompareGroup(2);
    const staleOf = async (): Promise<unknown[]> => {
      const response = await req("GET", `/api/apps/pv-${groupId}/compare`);
      expect(response.status).toBe(200);
      return ((await response.json()) as CompareBody).compare.candidates.map((c) => c.stale);
    };
    expect(await staleOf()).toEqual([false, false]);
    // 本物に別の変更を当てる(マニフェストの生バイトが動く)。
    const changed = memoManifest();
    (changed.app.views[0] as { name: string }).name = "メモ一覧(本物で変えた)";
    expect(applyManifest(dataRoot, APP_ID, changed).valid).toBe(true);
    expect(await staleOf()).toEqual([true, true]);
    // 本物のアプリが無い。
    rmSync(join(dataRoot, "apps", APP_ID), { recursive: true, force: true });
    expect(await staleOf()).toEqual([true, true]);
  });

  test("案の置き場が消えていれば、その案は並ばない(残りは作った順のまま)", async () => {
    const { groupId, metas } = makeCompareGroup(3);
    rmSync(join(previewRoot, metas[1]?.preview_id as string), { recursive: true, force: true });
    const response = await req("GET", `/api/apps/pv-${groupId}/compare`);
    expect(response.status).toBe(200);
    const ids = ((await response.json()) as CompareBody).compare.candidates.map((c) => c.id);
    expect(ids).toEqual([`pv-${metas[0]?.preview_id}`, `pv-${metas[2]?.preview_id}`]);
  });

  test("本物のアプリが pv-<32桁> の綴りで実在するときは、束の綴りでも前段が受けない", async () => {
    const { groupId } = makeCompareGroup(1);
    const kernel = KernelMetaStore.open(dataRoot);
    try {
      createApp(kernel, "同じ綴り", { app_id: `pv-${groupId}` });
    } finally {
      kernel.close();
    }
    const response = await req("GET", `/api/apps/pv-${groupId}/compare`);
    expect(response.status).not.toBe(200);
    expect(response.status).not.toBe(403);
    expect(response.status).not.toBe(410);
  });
});

// ---------------------------------------------------------------------------
// **V20-M14-T05 負荷の回数**(計画 `16-v20-m14-plan.md` §3 T05 / §10-5。**回数だけを数える。時間は測らない**)
// ---------------------------------------------------------------------------

describe("V20-M14-T05: /compare が本物の manifest.json を読む回数", () => {
  /** 前段だけを登録した版(`manifestSha` を数える包みに替える。中身は製品と同じ `manifestSha256`)。 */
  function countingFront(): { front: Hono<AuthEnv>; reads: string[] } {
    const reads: string[] = [];
    const front = new Hono<AuthEnv>();
    registerPreviewFront(front, {
      root: previewRoot,
      realAppExists: () => false,
      createInnerApp: () => ({ fetch: () => new Response(null, { status: 500 }) }),
      manifestSha: (appId) => {
        reads.push(appId);
        return manifestSha256(dataRoot, appId);
      },
    });
    return { front, reads };
  }

  for (const k of [1, 2, 3]) {
    test(`${k}案の束: GET /compare 1回につき本物の manifest.json を1回読む(案の数に依らない)。HEAD も1回`, async () => {
      const { groupId } = makeCompareGroup(k);
      const { front, reads } = countingFront();
      const get = await front.request(`/api/apps/pv-${groupId}/compare`);
      expect(get.status).toBe(200);
      expect(((await get.json()) as CompareBody).compare.candidates).toHaveLength(k);
      expect(reads).toEqual([APP_ID]);
      const head = await front.request(`/api/apps/pv-${groupId}/compare`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(reads).toEqual([APP_ID, APP_ID]);
    });
  }

  test("案の識別子への /compare(404)・束の他の読み物(403)・期限切れ(410)は manifest.json を読まない", async () => {
    const { groupId, metas } = makeCompareGroup(2);
    const { front, reads } = countingFront();
    const single = await front.request(`/api/apps/pv-${metas[0]?.preview_id}/compare`);
    expect(single.status).toBe(404);
    const other = await front.request(`/api/apps/pv-${groupId}/manifest`);
    expect(other.status).toBe(403);
    const missing = await front.request(`/api/apps/pv-${"f".repeat(32)}/compare`);
    expect(missing.status).toBe(410);
    expect(reads).toEqual([]);
  });
});
