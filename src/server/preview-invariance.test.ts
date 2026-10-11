/**
 * **下見は本体に1バイトも触らない**(`V20-M13-T04`。計画 `docs/plan/v20/15-v20-m13-plan.md` §3 の
 * T04・§10-9 の 21 / PRD `§T8` の受け入れ条件2 / `ADR-0476` 2-9 の歯止め)。
 *
 * **5点は `src/kernel/dry-run.test.ts` の `observe()` の内訳をそのまま写した**(減らさない):
 *
 * 1. **マニフェストのバイト列**(`manifest.json` を `utf-8` で読んだ文字列)
 * 2. **実データベースのスキーマ**(`app.sqlite` の `sqlite_master` の表ごとに `PRAGMA table_info` の列名の並び)
 * 3. **データ** —— 先例は表 `books` の全行(`listRecords`)。**ここでは `app.sqlite` の全表の全行**
 *    (`_auth_*` を含む。値の型まで見る)に広げた(強める側)。
 * 4. **変更履歴**(`KernelMetaStore.listChangelog(appId)`)
 * 5. **スナップショットの置き場**(`apps/<app_id>/snapshots/` のディレクトリ名の一覧)
 *
 * **経路**(作る側は MCP の `dry_run_diff` を本物のまま呼ぶ。見る側は前段を HTTP で撃つ):
 *
 * - 作る経路3本: `preview: "real"` の成功 / `preview: "sample"` の成功 / 拒否される差分に `preview` を付けた
 *   (写しも残らない)。
 * - 見る経路: 前段を通して許可リスト内の `GET` / 許可リスト外の `GET` / 断られる
 *   `POST` / `PATCH` / `PUT` / `DELETE`(`Origin` 無し・偽の `Origin`・許された `Origin`)。
 *   **本体と写しの両方**で5点を比べる。
 * - あわせて: `dataRoot` 配下のファイルが1つも増減しない(`dry-run.test.ts:295` の形。real と sample)、
 *   **下見を付けて10回繰り返してもスナップショットの連番を1つも消費しない**(`:301` の形)。
 *
 * **既存の検査と重なる部分**(名指し。ここでは足りない分を書く):
 * `src/kernel/dry-run.test.ts` の残す指定の検査(カーネルの `keepUnder` で5点とファイルの一覧)/
 * `src/mcp/tools/dry-run-preview.test.ts` の「preview を付けても本体(dataRoot)のファイルは1つも増減しない」
 * (real のみ・ファイルの一覧とマニフェストのバイト列)/ `src/mcp/preview-sample.test.ts` の
 * 「見本のモードの前後で、本体の5点と…」(`createPreview` を直に呼ぶ)/ `src/server/preview-front.test.ts` の
 * 18 の書き込み(本体と写しの全ファイルの sha256)。
 *
 * **置き場は自分の一時ディレクトリの下**(`previewRoot` を明示)で、`afterEach` で消す。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  applyDiff,
  applyManifest,
  type ChangelogEntry,
  createApp,
  createRecord,
  KernelMetaStore,
  type Manifest,
} from "../kernel/index.ts";
import { appDbPath, appManifestPath, appSnapshotsDir } from "../kernel/storage-paths.ts";
import { createMcpServer } from "../mcp/server.ts";
import { createServerApp } from "./app.ts";
import {
  PREVIEW_NOT_READABLE_MESSAGE,
  PREVIEW_READ_ONLY_MESSAGE,
  type PreviewFrontCache,
} from "./preview-front.ts";
import { findPreview, type PreviewMeta, parsePreviewAppId } from "./preview-store.ts";
import { listDataRootFiles, seedSession, TEST_ORIGIN } from "./test-helpers.ts";

const APP_ID = "memo-app";
const PREVIEW_BASE_URL = "http://127.0.0.1:3000";

let work = "";
let dataRoot = "";
let previewRoot = "";
let alice: ReturnType<typeof seedSession>;
let rowId = "";

function memoManifest(): Manifest {
  const read = { target: "view", view: "note-list", can: ["read"] };
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
            { id: "body", name: "本文", type: "long_text" },
          ],
        },
      ],
      views: [{ id: "note-list", type: "list_view", table: "notes", columns: ["title"] }],
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            { target: "table", table: "notes", can: ["read", "write", "delete"] },
            read,
          ],
        },
        { id: "editor", name: "編集者", rules: [read] },
        { id: "viewer", name: "閲覧者", rules: [read] },
      ],
    },
  } as Manifest;
}

/** 成功する差分(列を1つ足し、一覧の列を替える)。 */
function goodDiff(diffId = "d-invariance"): Record<string, unknown> {
  return {
    diff_id: diffId,
    intent: "メモに覚え書きの欄を足して一覧に出したい",
    operations: [
      { op: "add_field", table: "notes", field: { id: "memo", name: "覚え書き", type: "text" } },
      { op: "update_view", view: "note-list", changes: { columns: ["title", "memo"] } },
    ],
  };
}

/** 拒否される差分(無い表に列を足す)。 */
function badDiff(): Record<string, unknown> {
  return {
    diff_id: "d-bad",
    intent: "無い表に列を足す",
    operations: [{ op: "add_field", table: "ghosts", field: { id: "x", name: "X", type: "text" } }],
  };
}

// --- 5点(`dry-run.test.ts` の `observe()` の写し)---------------------------------------

type Observed = {
  manifestText: string;
  schema: Record<string, string[]>;
  data: Record<string, string[]>;
  changelog: ChangelogEntry[];
  snapshots: string[];
};

function observe(root: string): Observed {
  const manifestText = readFileSync(appManifestPath(root, APP_ID), "utf-8");
  const db = new Database(appDbPath(root, APP_ID), { readonly: true });
  const schema: Record<string, string[]> = {};
  const data: Record<string, string[]> = {};
  try {
    const tables = db
      .query<{ name: string }, []>(
        `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%' ORDER BY "name"`,
      )
      .all()
      .map((row) => row.name);
    for (const table of tables) {
      schema[table] = db
        .query<{ name: string }, []>(`PRAGMA table_info("${table}")`)
        .all()
        .map((row) => row.name);
      data[table] = db
        .query(`SELECT * FROM "${table}" ORDER BY rowid`)
        .all()
        .map((row) =>
          Object.entries(row as Record<string, unknown>)
            .map(([key, value]) => `${key}=${typeof value}:${String(value)}`)
            .join(","),
        );
    }
  } finally {
    db.close();
  }
  const kernel = KernelMetaStore.open(root);
  let changelog: ChangelogEntry[];
  try {
    changelog = kernel.listChangelog(APP_ID);
  } finally {
    kernel.close();
  }
  const snapDir = appSnapshotsDir(root, APP_ID);
  const snapshots = existsSync(snapDir) ? readdirSync(snapDir).sort() : [];
  return { manifestText, schema, data, changelog, snapshots };
}

/**
 * 配下の全ファイルの相対パスの一覧(`dry-run.test.ts` の `listAllFiles` と同じ形)。
 *
 * **SQLite の付随ファイルは {@link listDataRootFiles} の決めた2種だけを外す**(V20-M13 実 CI の赤。
 * 記録 `docs/plan/v20/records/v20-m13.md` §6)。`kernel.sqlite` は WAL で、読むだけの接続
 * (`dry-run.ts` の `copyDatabaseConsistently`)が閉じても Linux の SQLite は `-wal`(0 バイト)と
 * `-shm` を残し、macOS の SQLite は最初から残したままにする。**台によって在るか無いかが変わる
 * だけで中身ではない**ので、比較から外す。外すのは「一覧に在る SQLite ファイルの `-shm`」と
 * 「同じく 0 バイトの `-wal`」だけで、**書き込みを抱えた(0 バイトでない)`-wal` は外さない**
 * (外すと本体への未反映の書き込みを見落とす)。外し方の陽性対照はこのファイルの末尾にある。
 */
function listAllFiles(dir: string): string[] {
  return listDataRootFiles(dir);
}

/** 配下の全ファイルの (相対パス → sha256)。 */
function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of listAllFiles(dir)) {
    out[rel] = createHash("sha256")
      .update(readFileSync(join(dir, rel)))
      .digest("hex");
  }
  return out;
}

function entries(): string[] {
  return existsSync(previewRoot) ? readdirSync(previewRoot).sort() : [];
}

// --- MCP ---------------------------------------------------------------------------

async function dryRunTool(args: Record<string, unknown>): Promise<CallToolResult> {
  const server = createMcpServer({
    dataRoot,
    previewBaseUrl: PREVIEW_BASE_URL,
    previewRoot,
    actor: alice.username,
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return (await client.callTool({ name: "dry_run_diff", arguments: args })) as CallToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

/** 下見を作り、登録票を返す(成功しなければ投げる)。 */
async function makePreview(mode: "real" | "sample", diffId?: string): Promise<PreviewMeta> {
  const result = await dryRunTool({ app_id: APP_ID, diff: goodDiff(diffId), preview: mode });
  if (result.isError === true) throw new Error(JSON.stringify(result.structuredContent));
  const url = ((result.structuredContent as { preview?: { url?: string } }).preview?.url ??
    "") as string;
  const appId = /\/apps\/(pv-[0-9a-f]{32})\/$/.exec(url)?.[1] ?? "";
  const meta = findPreview(previewRoot, parsePreviewAppId(appId) ?? "");
  if (meta === null) throw new Error(`下見が登録されていない: ${url}`);
  return meta;
}

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "gp-preview-invariance-"));
  dataRoot = join(work, "data");
  previewRoot = join(work, "previews");
  const kernel = KernelMetaStore.open(dataRoot);
  try {
    createApp(kernel, "メモ帳", { app_id: APP_ID });
  } finally {
    kernel.close();
  }
  const applied = applyManifest(dataRoot, APP_ID, memoManifest());
  if (!applied.valid) throw new Error(JSON.stringify(applied.errors));
  alice = seedSession(dataRoot, APP_ID, { username: "alice", role: "owner" });
  seedSession(dataRoot, APP_ID, { username: "bob", role: "editor" });
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    for (const title of ["買い物", "打ち合わせ", "読書"]) {
      const created = createRecord(db, memoManifest(), "notes", { title, body: `${title}の本文` });
      if (!created.ok) throw new Error(JSON.stringify(created.errors));
      rowId = created.value._id;
    }
  } finally {
    db.close();
  }
  // 1度は実適用して、変更履歴とスナップショットが空でない状態から撃つ(不変を意味のある比較にする)。
  const first = applyDiff(dataRoot, APP_ID, {
    diff_id: "d-setup",
    intent: "一覧に本文も出す",
    operations: [{ op: "update_view", view: "note-list", changes: { columns: ["title", "body"] } }],
  });
  if (!first.valid) throw new Error(JSON.stringify(first.errors));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

// --- 作る経路3本 ---------------------------------------------------------------------

describe("作る経路: 本体の5点・ファイルの一覧・全バイト列が不変", () => {
  test("前提: 本体は変更履歴2件(作成と d-setup)・スナップショット1つ・行3つ(空の比較にしない)", () => {
    const state = observe(dataRoot);
    expect(state.changelog.map((e) => e.diff_id)).toEqual(["_create-app", "d-setup"]);
    expect(state.snapshots).toEqual(["0001-d-setup"]);
    expect(state.data.notes).toHaveLength(3);
    expect(state.data._auth_users).toHaveLength(2);
  });

  for (const mode of ["real", "sample"] as const) {
    test(`preview: "${mode}" で成功する経路`, async () => {
      const before = observe(dataRoot);
      const filesBefore = listAllFiles(dataRoot);
      const bytesBefore = fingerprint(dataRoot);

      const meta = await makePreview(mode);
      expect(meta.mode).toBe(mode);
      expect(entries()).toEqual([meta.preview_id]);

      expect(listAllFiles(dataRoot)).toEqual(filesBefore);
      expect(fingerprint(dataRoot)).toEqual(bytesBefore);
      expect(observe(dataRoot)).toEqual(before);

      // 陽性対照: 同じ5点の式が、写しでは「当てた後」を返す(式が恒真でない)。
      const shadow = observe(meta.shadow_data_root);
      expect(shadow.manifestText).not.toBe(before.manifestText);
      expect(shadow.schema.notes).toContain("memo");
      expect(before.schema.notes).not.toContain("memo");
    });
  }

  test("拒否される差分に preview を付けた経路: 本体不変・写しも残らない・URL も無い", async () => {
    const before = observe(dataRoot);
    const filesBefore = listAllFiles(dataRoot);
    const bytesBefore = fingerprint(dataRoot);

    for (const mode of ["real", "sample"] as const) {
      const result = await dryRunTool({ app_id: APP_ID, diff: badDiff(), preview: mode });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.structuredContent)).not.toContain("pv-");
    }

    expect(entries()).toEqual([]);
    expect(listAllFiles(dataRoot)).toEqual(filesBefore);
    expect(fingerprint(dataRoot)).toEqual(bytesBefore);
    expect(observe(dataRoot)).toEqual(before);
  });

  test("下見を付けて10回(real と sample を交互)繰り返しても、スナップショットの連番を1つも消費しない", async () => {
    const before = observe(dataRoot);
    for (let i = 0; i < 10; i += 1) {
      await makePreview(i % 2 === 0 ? "real" : "sample", `d-repeat-${i}`);
    }
    expect(entries()).toHaveLength(10);
    expect(observe(dataRoot)).toEqual(before);
    expect(observe(dataRoot).snapshots).toEqual(["0001-d-setup"]);

    // 連番が汚れていないことを、実適用が 0002 を取ることで示す(`dry-run.test.ts:301` の形)。
    const applied = applyDiff(dataRoot, APP_ID, goodDiff("d-after-previews"));
    expect(applied.valid).toBe(true);
    if (!applied.valid) return;
    expect(applied.snapshot).toBe("0002-d-after-previews");
  });
});

// --- 見比べの束を作る経路(`V20-M14-T01A`)---------------------------------------------

describe("見比べの束を作る経路: 本体の5点・ファイルの一覧・全バイト列が不変(`V20-M14-T01A`)", () => {
  test("compare 付きで3案・4案目の断り・データが失われる差分の断り・形の誤りの前後", async () => {
    const before = observe(dataRoot);
    const filesBefore = listAllFiles(dataRoot);
    const bytesBefore = fingerprint(dataRoot);

    const first = await dryRunTool({
      app_id: APP_ID,
      diff: goodDiff("d-c1"),
      preview: "real",
      compare: { name: "案1", tradeoff: "覚え書きを一覧に出す" },
    });
    expect(first.isError).not.toBe(true);
    const group = (first.structuredContent as { compare: { group: string } }).compare.group;
    for (const i of [2, 3, 4]) {
      const next = await dryRunTool({
        app_id: APP_ID,
        diff: goodDiff(`d-c${i}`),
        preview: "real",
        compare: { name: `案${i}`, tradeoff: "覚え書きを一覧に出す", group },
      });
      expect(next.isError).not.toBe(true);
    }
    const destructive = await dryRunTool({
      app_id: APP_ID,
      diff: {
        diff_id: "d-c-change",
        intent: "本文の欄の名前を変えたい",
        operations: [
          { op: "change_field", table: "notes", field: "body", changes: { name: "中身" } },
        ],
      },
      preview: "real",
      compare: { name: "変える案", tradeoff: "欄の名前が変わる" },
    });
    expect(Object.keys(destructive.structuredContent as object).sort()).toEqual([
      "preview_refused",
      "report",
    ]);
    const malformed = await dryRunTool({
      app_id: APP_ID,
      diff: goodDiff("d-c-bad"),
      preview: "real",
      compare: { name: "", tradeoff: "" },
    });
    expect(malformed.isError).toBe(true);

    // 置き場: 案3つ + 束1つ(4案目・消す案・形の誤りは何も残さない)。
    expect(entries()).toHaveLength(4);
    expect(listAllFiles(dataRoot)).toEqual(filesBefore);
    expect(fingerprint(dataRoot)).toEqual(bytesBefore);
    expect(observe(dataRoot)).toEqual(before);
  });
});

// --- 見比べの束を見る経路(`V20-M14-T01B`)---------------------------------------------

describe("見比べの束を見る経路: /compare の前後で本体と写しの5点が不変(`V20-M14-T01B`)", () => {
  test("GET / HEAD /compare・束の他の読み物(403)・束への書き込み(403)・案の /compare(404)の前後", async () => {
    const created: string[] = [];
    let group = "";
    for (const i of [1, 2]) {
      const result = await dryRunTool({
        app_id: APP_ID,
        diff: goodDiff(`d-view-${i}`),
        preview: "real",
        compare: {
          name: `案${i}`,
          tradeoff: "覚え書きを一覧に出す",
          ...(group === "" ? {} : { group }),
        },
      });
      if (result.isError === true) throw new Error(JSON.stringify(result.structuredContent));
      const content = result.structuredContent as {
        preview: { url: string };
        compare: { group: string };
      };
      group = content.compare.group;
      created.push(/\/apps\/(pv-[0-9a-f]{32})\/$/.exec(content.preview.url)?.[1] ?? "");
    }
    const shadows = created.map((pv) => {
      const meta = findPreview(previewRoot, parsePreviewAppId(pv) ?? "");
      if (meta === null) throw new Error(`案が無い: ${pv}`);
      return meta.shadow_data_root;
    });
    const app = createServerApp({ dataRoot, profile: "full", preview: { root: previewRoot } });
    const hit = (method: string, path: string): Promise<Response> => {
      const init: RequestInit = { method };
      if (method !== "GET" && method !== "HEAD") {
        init.headers = { origin: TEST_ORIGIN, "content-type": "application/json" };
        init.body = "{}";
      }
      return Promise.resolve(app.request(new Request(`http://localhost${path}`, init)));
    };

    const mainBefore = observe(dataRoot);
    const mainBytes = fingerprint(dataRoot);
    const shadowBefore = shadows.map((root) => observe(root));
    const shadowBytes = shadows.map((root) => fingerprint(root));

    const expectations: Array<[string, string, number]> = [
      ["GET", `/api/apps/${group}/compare`, 200],
      ["HEAD", `/api/apps/${group}/compare`, 200],
      ["GET", `/api/apps/${group}/manifest`, 403],
      ["GET", `/api/apps/${group}/tables/notes/records`, 403],
      ["POST", `/api/apps/${group}/compare`, 403],
      ["POST", `/api/apps/${group}/diffs`, 403],
      ["POST", `/api/apps/${group}/tables/notes/records`, 403],
      ["GET", `/api/apps/${created[0]}/compare`, 404],
      ["GET", `/api/apps/${created[1]}/manifest`, 200],
    ];
    for (let round = 0; round < 3; round += 1) {
      for (const [method, path, status] of expectations) {
        const response = await hit(method, path);
        expect({ method, path, status: response.status }).toEqual({ method, path, status });
        await response.arrayBuffer();
      }
    }

    expect(observe(dataRoot)).toEqual(mainBefore);
    expect(fingerprint(dataRoot)).toEqual(mainBytes);
    shadows.forEach((root, i) => {
      expect(observe(root)).toEqual(shadowBefore[i] as Observed);
      expect(fingerprint(root)).toEqual(shadowBytes[i] as Record<string, string>);
    });
  });
});

// --- 見る経路 -----------------------------------------------------------------------

describe("見る経路: 前段を通した GET と断られる書き込みの前後で、本体と写しの5点が不変", () => {
  let meta: PreviewMeta;
  let pv = "";
  let cache: PreviewFrontCache;
  let app: ReturnType<typeof createServerApp>;

  function hit(method: string, rest: string, origin?: string): Promise<Response> {
    const headers: Record<string, string> = {};
    let body: string | undefined;
    if (origin !== undefined) headers.origin = origin;
    if (method !== "GET" && method !== "HEAD") {
      headers["content-type"] = "application/json";
      body = JSON.stringify({ title: "書き込めてはいけない" });
    }
    return Promise.resolve(
      app.request(
        new Request(`http://localhost/api/apps/${pv}${rest}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
        }),
      ),
    );
  }

  async function open(mode: "real" | "sample"): Promise<void> {
    meta = await makePreview(mode);
    pv = `pv-${meta.preview_id}`;
    cache = new Map();
    app = createServerApp({ dataRoot, profile: "full", preview: { root: previewRoot, cache } });
  }

  for (const mode of ["real", "sample"] as const) {
    test(`${mode}: 許可リスト内の GET と HEAD・許可リスト外の GET・断られる書き込み(Origin 3通り)の前後`, async () => {
      await open(mode);
      const mainBefore = observe(dataRoot);
      const mainBytes = fingerprint(dataRoot);
      const shadowBefore = observe(meta.shadow_data_root);

      // 許可リスト内の GET(通る)。描画に要る4本は 200。
      for (const rest of ["/manifest", "/public", "/auth/me", "/tables/notes/records"]) {
        const response = await hit("GET", rest);
        expect({ rest, status: response.status }).toEqual({ rest, status: 200 });
        await response.arrayBuffer();
      }
      // 許可リスト内でも、題材に実体の無いもの(見本では本体の行 ID が写しに無い・逃げ道の CSS・ファイル)は
      // 2本目の答え(404 など)がそのまま返る。前段の断り(403 / 410)にはならない。
      for (const rest of [
        `/tables/notes/records/${rowId}`,
        "/views/note-list/custom.css",
        "/files/no-such-file",
      ]) {
        const response = await hit("GET", rest);
        expect({ rest, refused: [403, 410].includes(response.status) }).toEqual({
          rest,
          refused: false,
        });
        await response.arrayBuffer();
      }
      expect((await hit("HEAD", "/manifest")).status).toBe(200);
      // 偽の Origin を付けた GET も通る(読み物にはオリジンの検査が掛からない)。
      expect((await hit("GET", "/tables/notes/records", "http://evil.example")).status).toBe(200);

      // 許可リスト外の GET(断られる)。
      for (const rest of [
        "/auth/users",
        "/changelog",
        "/comments",
        "/undo/preview",
        "/requirements",
      ]) {
        const response = await hit("GET", rest);
        expect({ rest, status: response.status }).toEqual({ rest, status: 403 });
        const json = (await response.json()) as { errors: Array<{ message: string }> };
        expect(json.errors[0]?.message).toBe(PREVIEW_NOT_READABLE_MESSAGE);
      }

      // 断られる書き込み: 4つの動詞 × Origin 3通り(無し・偽・許されたもの)。
      const writes: Array<[string, string]> = [
        ["POST", "/tables/notes/records"],
        ["PATCH", `/tables/notes/records/${rowId}`],
        ["PUT", `/tables/notes/records/${rowId}`],
        ["DELETE", `/tables/notes/records/${rowId}`],
        ["POST", "/diffs"],
        ["POST", "/undo"],
      ];
      for (const [method, rest] of writes) {
        for (const origin of [undefined, "http://evil.example", TEST_ORIGIN]) {
          const response = await hit(method, rest, origin);
          expect({ method, rest, origin, status: response.status }).toEqual({
            method,
            rest,
            origin,
            status: 403,
          });
          const json = (await response.json()) as { errors: Array<{ message: string }> };
          expect(json.errors[0]?.message).toBe(PREVIEW_READ_ONLY_MESSAGE);
        }
      }

      // 本体: 5点・全ファイルのバイト列が不変。
      expect(observe(dataRoot)).toEqual(mainBefore);
      expect(fingerprint(dataRoot)).toEqual(mainBytes);
      // 写し: 5点が不変(読んだだけで写しの行も定義も変わらない)。
      expect(observe(meta.shadow_data_root)).toEqual(shadowBefore);
    });
  }

  test("陽性対照: 同じ5点の式は、本体に書き込めば変化を捕まえる(式が恒真でない)", async () => {
    const before = observe(dataRoot);
    const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
    try {
      const created = createRecord(db, memoManifest(), "notes", { title: "足した行" });
      expect(created.ok).toBe(true);
    } finally {
      db.close();
    }
    expect(observe(dataRoot)).not.toEqual(before);
  });
});

// --- 付随ファイルの外し方の陽性対照(V20-M13 実 CI の赤。記録 §6)------------------------

describe("付随ファイルの外し方: 外すのは SQLite の -shm と 0 バイトの -wal だけ", () => {
  test("作り置きの台: 外れるのは2件だけで、よく似た名前・中身のある -wal・持ち主の無い付随ファイルは残る", () => {
    const dir = join(work, "sidecar-probe");
    mkdirSync(join(dir, "apps", "a"), { recursive: true });
    const files: Record<string, string> = {
      "kernel.sqlite": "db",
      "kernel.sqlite-wal": "", // 外れる(0 バイト)
      "kernel.sqlite-shm": "index", // 外れる
      "kernel.sqlite-journal": "", // 残る(WAL の付随ファイルではない)
      "apps/a/app.sqlite": "db",
      "apps/a/app.sqlite-wal": "frames", // 残る(書き込みを抱えた -wal)
      "apps/a/app.sqlite-shm": "index", // 外れない側の -wal と対になる -shm は外れる
      "orphan.sqlite-wal": "", // 残る(本体のファイルが無い)
      "orphan.sqlite-shm": "index", // 残る(本体のファイルが無い)
      "notes-wal": "", // 残る(SQLite の付随ファイルの綴りでない)
      "stray.txt": "x", // 残る
    };
    for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body);
    expect(listDataRootFiles(dir)).toEqual(
      [
        "apps/a/app.sqlite",
        "apps/a/app.sqlite-wal",
        "kernel.sqlite",
        "kernel.sqlite-journal",
        "notes-wal",
        "orphan.sqlite-shm",
        "orphan.sqlite-wal",
        "stray.txt",
      ].sort(),
    );
  });

  test("本物の台: 下見の後に本体へ1ファイル足せば、一覧の比較が捕まえる", async () => {
    const filesBefore = listAllFiles(dataRoot);
    await makePreview("real");
    writeFileSync(join(dataRoot, "apps", APP_ID, "stray.txt"), "x");
    expect(listAllFiles(dataRoot)).not.toEqual(filesBefore);
    expect(listAllFiles(dataRoot)).toContain(`apps/${APP_ID}/stray.txt`);
  });

  test("本物の台: kernel.sqlite に書いたまま接続を開いておくと、中身のある -wal が一覧の比較に出る", async () => {
    const filesBefore = listAllFiles(dataRoot);
    await makePreview("real");
    const kernel = KernelMetaStore.open(dataRoot);
    try {
      createApp(kernel, "もう1本", { app_id: "other-app" });
      expect(listAllFiles(dataRoot)).toContain("kernel.sqlite-wal");
      expect(listAllFiles(dataRoot)).not.toEqual(filesBefore);
    } finally {
      kernel.close();
    }
  });
});
