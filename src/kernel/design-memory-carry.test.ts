/**
 * **選んだ形の記録と型は、差分として見え・元に戻せ・持ち出しに含まれる**(`V20-M15-T03`。
 * 計画 `docs/plan/v20/17-v20-m15-plan.md` §3 の `T03`・§9-4 の 6・§9-5-2 の 15〜18・§10-4・§10-5 中8・§10-6 /
 * [`ADR-0479`](../../../../docs/adr/0479-design-memory-choices-patterns-and-compare-off-pattern.md) /
 * `D-V20-18`・`D-V20-56`・`D-V20-58`・`D-V20-60`・`D-V20-61`・`D-V20-62`・`D-V20-63`・`D-V20-64`)。
 *
 * ## この検査が測るもの(**推論で書かない。撃つ**)
 *
 * **`D-V20-18` が置き場をマニフェストに選んだ理由(「差分として見え、元に戻せ、持ち出しに含まれる」)は、
 * 「マニフェストの中に在るから当然成り立つ」と書いて済ませてはならない**(`T03` (d))。 下の3群はどれも
 * **本物の口**(HTTP は `createServerApp`・MCP はプロセス内で道具を直に呼ぶ・控え/戻し/移し替え/配布物の
 * 組み立ては本物の関数)を撃ち、返ってきたものを読む。
 *
 * 1. **(a) 差分として見える** —— 見比べの適用と同じ形の `POST /diffs` 1回(案の op の末尾に `remember_design`
 *    の `choice` を1本)で変更履歴が**ちょうど1行**増え、その行の操作に案の op と `remember_design` が並ぶ。
 *    選ばれなかった案の名前は本物の定義にも変更履歴にも1バイトも入らない(§10-3 重1 の歯止め)。
 * 2. **(b) 元に戻せる** —— `POST /undo` 1回で案の変更(**画面の描画に効く列の並び**を含む)と選んだ記録が
 *    **両方**戻り、MCP の `redo` で両方戻る。 21件目で最古が落ち、`undo` で**復活**する。 型は21件目で消えない。
 *    型の書き換え・外し(空配列)も1行ずつ変更履歴に残り、`undo` で戻る。
 * 3. **(c) 持ち出しに含まれる** —— 計画 §10-4 の16経路を1本ずつ撃ち、`patterns` と `choices`(と理由)が
 *    返ってきたものに**在るか**を読む。 期待値は §10-4 の表の値である(食い違えば赤くなる)。
 * 4. **条件26** —— 新しく作った `kernel.sqlite` の `sqlite_master` が着手前(`T00` §3-1)と一致する
 *    (核の DB に表も列も足していない)。
 *
 * ## 測らないもの(**誇張しない**)
 *
 * - **生成器の `previous-manifest.json`** は生成器の作業単位の `design-memory.test.ts`(`T01A`)が撃つ。
 *   ここでは撃ち直さない(生成器の作業単位で打つ。記録 `v20-m15-t03.md` に打ち直した出力を書く)。
 * - **見比べの画面の OK ボタン**(`web/src/ComparePage.tsx`)は `T01C` / `T04E` が撃つ。 ここは画面が送るのと
 *   **同じ形**の本文を HTTP に直に送る。
 *
 * **データはすべて一時ディレクトリの中で作る**(リポジトリの `data/` に1バイトも触らない)。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { buildRunnerData } from "../../scripts/build-runner-data.ts";
import { migrateVolume } from "../../scripts/migrate-volume.ts";
import { createMcpServer } from "../mcp/server.ts";
import { createServerApp } from "../server/app.ts";
import { runBackup } from "../server/backup.ts";
import { restoreBackup } from "../server/restore.ts";
import { authed, seedSession, TEST_ORIGIN } from "../server/test-helpers.ts";
import { RUNNER_BUILD_VERSION } from "../shared/runner-build-version.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { appDbPath, appManifestPath, appSnapshotsDir, kernelDbPath } from "./storage-paths.ts";

const APP_ID = "carry";
const TABLE_ID = "notes";
const VIEW_ID = "notes-list";
const BOOTSTRAP_ACTOR = "bootstrap";
const OWNER = "alice";
const PREVIEW_BASE_URL = "http://127.0.0.1:3000";

/** 選んだ記録の3点と型の目印(ほかのどの文にも現れない綴り)。 */
const CHOICE_NAME = "CARRY-CHOICE-NAME-0001";
const CHOICE_TRADEOFF = "CARRY-TRADEOFF-0002";
const CHOICE_REASON = "CARRY-REASON-0003";
const PATTERN = "CARRY-PATTERN-0004 入力フォームは区切りのある1カラム";
const CHOICE = { name: CHOICE_NAME, tradeoff: CHOICE_TRADEOFF, reason: CHOICE_REASON };

/** 着手前(`T00` §3-1)の `sqlite_master` の sha256。 */
const KERNEL_SQLITE_MASTER_SHA256 =
  "c7f067e6159869ef7c66a26b9f4ec12c90f404f6dc0845380ed8d6136b8f85e4";

let work = "";
let dataRoot = "";
let previewRoot = "";
let ownerCookie = "";
let server: ReturnType<typeof createServerApp>;

// ---------------------------------------------------------------------------------------------
// 足場
// ---------------------------------------------------------------------------------------------

async function callTool(
  name: string,
  args: Record<string, unknown>,
  actor = OWNER,
  root = dataRoot,
): Promise<CallToolResult> {
  const mcp = createMcpServer({
    dataRoot: root,
    previewBaseUrl: PREVIEW_BASE_URL,
    previewRoot,
    actor,
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
    await mcp.close();
  }
}

function okData(result: CallToolResult): Record<string, unknown> {
  if (result.isError === true) {
    throw new Error(`ツールが失敗した: ${JSON.stringify(result.structuredContent)}`);
  }
  return result.structuredContent as Record<string, unknown>;
}

type Carry = "含む" | "含まない";

/**
 * **返ってきたものに型と選んだ記録が在るかを読む**(3値の「含む / 含まない」を機械で決める)。
 * 選んだ記録は名前・トレードオフ・理由の3点が**揃って在る**なら「含む」、**1点も無い**なら「含まない」。
 * 一部だけ在るなら例外(表の3値に丸めない)。
 */
function carried(text: string): { patterns: Carry; choices: Carry } {
  const hits = [CHOICE_NAME, CHOICE_TRADEOFF, CHOICE_REASON].filter((m) => text.includes(m));
  if (hits.length !== 0 && hits.length !== 3) {
    throw new Error(`選んだ記録の一部だけが在る: ${hits.join(", ")}`);
  }
  return {
    patterns: text.includes(PATTERN) ? "含む" : "含まない",
    choices: hits.length === 3 ? "含む" : "含まない",
  };
}

function sha(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifestBytes(root = dataRoot, appId = APP_ID): Buffer {
  return readFileSync(appManifestPath(root, appId));
}

function request(path: string, init: RequestInit = {}, cookie: string | null = ownerCookie) {
  const url = `http://localhost${path}`;
  if (cookie === null) {
    const headers = new Headers(init.headers);
    headers.set("origin", TEST_ORIGIN);
    return server.request(new Request(url, { ...init, headers }));
  }
  return server.request(authed(cookie)(url, init));
}

async function getJson(
  path: string,
  cookie: string | null = ownerCookie,
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const response = await request(path, {}, cookie);
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

async function postJson(
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const response = await request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

type Op = Record<string, unknown> & { op: string };
type Entry = { diff_id: string; intent: string; operations: Op[]; kind?: string };
type AppManifest = {
  app: {
    views: { id: string; columns?: string[] }[];
    tables: { id: string; fields: { id: string }[] }[];
    design_memory?: {
      choices?: { name: string; tradeoff: string; reason?: string }[];
      patterns?: string[];
    };
  };
};

async function changelog(): Promise<Entry[]> {
  const got = await getJson(`/api/apps/${APP_ID}/changelog`);
  expect(got.status).toBe(200);
  return got.body.changelog as Entry[];
}

async function manifest(): Promise<AppManifest> {
  const got = await getJson(`/api/apps/${APP_ID}/manifest`);
  expect(got.status).toBe(200);
  return got.body as unknown as AppManifest;
}

/** 見比べの画面が送るのと同じ形: 案の差分の `operations` の末尾に `remember_design` の `choice` を1本。 */
function chosen(candidate: { diff_id: string; intent: string; operations: Op[] }, choice: object) {
  return {
    ...candidate,
    operations: [...candidate.operations, { op: "remember_design", design_memory: { choice } }],
  };
}

async function applyOk(body: unknown): Promise<Record<string, unknown>> {
  const got = await postJson(`/api/apps/${APP_ID}/diffs`, body);
  expect(got.status, got.text).toBe(201);
  return got.body;
}

async function undoOk(): Promise<Record<string, unknown>> {
  const got = await postJson(`/api/apps/${APP_ID}/undo`, {});
  expect(got.status, got.text).toBe(200);
  return got.body;
}

/** 案: 覚え書きの欄を足し、一覧の列に並べる(**列の並びは画面の描画に効くキー**)。 */
function memoCandidate(diffId = "d-memo") {
  return {
    diff_id: diffId,
    intent: "メモに覚え書きの欄を足し、一覧に並べたい",
    operations: [
      { op: "add_field", table: TABLE_ID, field: { id: "memo", name: "覚え書き", type: "text" } },
      { op: "update_view", view: VIEW_ID, changes: { columns: ["title", "memo"] } },
    ] as Op[],
  };
}

function rememberDiff(diffId: string, designMemory: Record<string, unknown>) {
  return {
    diff_id: diffId,
    intent: "選んだ形を記録する",
    operations: [{ op: "remember_design", design_memory: designMemory }],
  };
}

/** 型と選んだ記録を1件ずつ持たせる(持ち出しの経路の前提)。 */
async function seedMemory(): Promise<void> {
  await applyOk(rememberDiff("d-seed-memory", { choice: CHOICE, patterns: [PATTERN] }));
}

/** ディレクトリの下の全ファイル(相対パス)。 */
function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const r = rel === "" ? name : `${rel}/${name}`;
      if (statSync(full).isDirectory()) walk(full, r);
      else out.push(r);
    }
  };
  if (existsSync(root)) walk(root, "");
  return out.sort();
}

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "gp-design-memory-carry-"));
  dataRoot = join(work, "data");
  previewRoot = join(work, "previews");
  okData(await callTool("create_app", { name: "持ち出しの器", app_id: APP_ID }, BOOTSTRAP_ACTOR));
  ownerCookie = seedSession(dataRoot, APP_ID, { username: OWNER }).cookie;
  okData(
    await callTool("apply_diff", {
      app_id: APP_ID,
      diff: {
        diff_id: "setup",
        intent: "メモの表と一覧を用意する",
        operations: [
          {
            op: "add_table",
            table: {
              id: TABLE_ID,
              name: "メモ",
              fields: [{ id: "title", name: "題", type: "text", required: true }],
            },
          },
          {
            op: "add_view",
            view: { id: VIEW_ID, type: "list_view", table: TABLE_ID, columns: ["title"] },
          },
        ],
      },
    }),
  );
  server = createServerApp({ dataRoot, preview: { root: previewRoot } });
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// (a) 差分として見える
// ---------------------------------------------------------------------------------------------

describe("(a) 差分として見える(D-V20-56: 変更履歴の1行)", () => {
  test("案の op と choice を1回の POST /diffs で送ると、変更履歴がちょうど1行増え、その行に両方が並ぶ", async () => {
    const before = await changelog();
    await applyOk(chosen(memoCandidate(), CHOICE));
    const after = await changelog();
    expect(after).toHaveLength(before.length + 1);
    const row = after[after.length - 1] as Entry;
    expect(row.diff_id).toBe("d-memo");
    expect(row.operations.map((o) => o.op)).toEqual([
      "add_field",
      "update_view",
      "remember_design",
    ]);
    expect(row.operations[2]).toEqual({ op: "remember_design", design_memory: { choice: CHOICE } });
    // 本物の定義に選んだ記録が1件(名前・トレードオフ・理由)。
    expect((await manifest()).app.design_memory).toEqual({ choices: [CHOICE] });
  });

  test("型を変える案(patterns だけの1本)を選ぶと2本が1行に並び、型も変わる(D-V20-64)", async () => {
    const before = await changelog();
    const candidate = {
      diff_id: "d-with-pattern",
      intent: "欄を足して型も決めたい",
      operations: [
        ...memoCandidate().operations,
        { op: "remember_design", design_memory: { patterns: [PATTERN] } },
      ] as Op[],
    };
    await applyOk(chosen(candidate, CHOICE));
    const after = await changelog();
    expect(after).toHaveLength(before.length + 1);
    expect((after[after.length - 1] as Entry).operations.map((o) => o.op)).toEqual([
      "add_field",
      "update_view",
      "remember_design",
      "remember_design",
    ]);
    expect((await manifest()).app.design_memory).toEqual({
      choices: [CHOICE],
      patterns: [PATTERN],
    });
  });

  test("型の変更を含まない案を選んでも、型は1バイトも変わらない(D-V20-58 の読み)", async () => {
    await applyOk(rememberDiff("d-pattern", { patterns: [PATTERN, "二つ目の型"] }));
    const patternsBefore = JSON.stringify((await manifest()).app.design_memory?.patterns);
    await applyOk(chosen(memoCandidate(), CHOICE));
    const memory = (await manifest()).app.design_memory;
    expect(JSON.stringify(memory?.patterns)).toBe(patternsBefore);
    expect(memory?.choices).toEqual([CHOICE]);
  });

  test("選ばれなかった案の名前は、本物の定義にも変更履歴にもデータの置き場のどこにも入らない(§10-3 重1)", async () => {
    const LOSER = "CARRY-UNCHOSEN-0005";
    const WINNER = "CARRY-CHOSEN-0006";
    const first = okData(
      await callTool("dry_run_diff", {
        app_id: APP_ID,
        diff: memoCandidate("d-cand-a"),
        preview: "real",
        compare: { name: WINNER, tradeoff: "列が増えるが一覧で読める" },
      }),
    );
    const group = (first.compare as { group: string }).group;
    okData(
      await callTool("dry_run_diff", {
        app_id: APP_ID,
        diff: {
          diff_id: "d-cand-b",
          intent: "覚え書きを詳細だけに出したい",
          operations: [
            {
              op: "add_field",
              table: TABLE_ID,
              field: { id: "memo2", name: "覚え書き", type: "text" },
            },
          ],
        },
        preview: "real",
        compare: { name: LOSER, tradeoff: "一覧は短いまま", group },
      }),
    );
    // 陽性対照: 選ばれなかった案の名前は束(下見の置き場)には在る。
    const inPreviews = filesUnder(previewRoot).filter((f) =>
      readFileSync(join(previewRoot, f)).includes(LOSER),
    );
    expect(inPreviews.length).toBeGreaterThan(0);

    await applyOk(
      chosen(memoCandidate("d-cand-a"), { name: WINNER, tradeoff: "列が増えるが一覧で読める" }),
    );
    expect(manifestBytes().includes(WINNER)).toBe(true);
    const hits = filesUnder(dataRoot).filter((f) =>
      readFileSync(join(dataRoot, f)).includes(LOSER),
    );
    expect(hits).toEqual([]);
    expect(JSON.stringify(await changelog())).not.toContain(LOSER);
  });
});

// ---------------------------------------------------------------------------------------------
// (b) 元に戻せる
// ---------------------------------------------------------------------------------------------

describe("(b) 元に戻せる(案の変更と選んだ記録が一緒に戻る)", () => {
  test("undo 1回で案の変更(一覧の列の並び)と選んだ記録が両方戻り、redo で両方戻る", async () => {
    const before = await manifest();
    const beforeSha = sha(manifestBytes());
    expect(before.app.views.find((v) => v.id === VIEW_ID)?.columns).toEqual(["title"]);
    expect(before.app.design_memory).toBeUndefined();

    await applyOk(chosen(memoCandidate(), CHOICE));
    const applied = await manifest();
    expect(applied.app.views.find((v) => v.id === VIEW_ID)?.columns).toEqual(["title", "memo"]);
    expect(applied.app.design_memory).toEqual({ choices: [CHOICE] });

    await undoOk();
    const undone = await manifest();
    expect(undone).toEqual(before);
    expect(sha(manifestBytes())).toBe(beforeSha);
    expect(undone.app.views.find((v) => v.id === VIEW_ID)?.columns).toEqual(["title"]);
    expect(undone.app.tables[0]?.fields.map((f) => f.id)).toEqual(["title"]);
    expect(undone.app.design_memory).toBeUndefined();

    okData(await callTool("redo", { app_id: APP_ID }));
    expect(await manifest()).toEqual(applied);
  });

  test("選んだ記録は最新20件まで: 21件目で最古が落ち、undo で復活し、redo で再び落ちる。型は落ちない(D-V20-60)", async () => {
    await applyOk(rememberDiff("d-pattern", { patterns: [PATTERN] }));
    const name = (i: number) => `記録${String(i).padStart(2, "0")}`;
    for (let i = 1; i <= 20; i += 1) {
      await applyOk(rememberDiff(`d-choice-${i}`, { choice: { name: name(i), tradeoff: "t" } }));
    }
    const at20 = (await manifest()).app.design_memory;
    expect(at20?.choices?.map((c) => c.name)).toEqual(
      Array.from({ length: 20 }, (_, k) => name(k + 1)),
    );
    expect(at20?.patterns).toEqual([PATTERN]);

    await applyOk(rememberDiff("d-choice-21", { choice: { name: name(21), tradeoff: "t" } }));
    const at21 = (await manifest()).app.design_memory;
    expect(at21?.choices?.map((c) => c.name)).toEqual(
      Array.from({ length: 20 }, (_, k) => name(k + 2)),
    );
    expect(at21?.patterns).toEqual([PATTERN]);

    await undoOk();
    const undone = (await manifest()).app.design_memory;
    expect(undone?.choices?.map((c) => c.name)).toEqual(at20?.choices?.map((c) => c.name));
    expect(undone?.patterns).toEqual([PATTERN]);

    okData(await callTool("redo", { app_id: APP_ID }));
    expect((await manifest()).app.design_memory).toEqual(at21);
  });

  test("型の書き換え・外し(空配列)は1行ずつ変更履歴に残り、undo で1段ずつ戻る(D-V20-58)", async () => {
    const start = (await changelog()).length;
    await applyOk(rememberDiff("d-p1", { patterns: ["型1"] }));
    await applyOk(rememberDiff("d-p2", { patterns: ["型2", "型3"] }));
    await applyOk(rememberDiff("d-clear", { patterns: [] }));
    const rows = await changelog();
    expect(rows.slice(start).map((r) => r.diff_id)).toEqual(["d-p1", "d-p2", "d-clear"]);
    expect((await manifest()).app.design_memory).toBeUndefined();

    await undoOk();
    expect((await manifest()).app.design_memory).toEqual({ patterns: ["型2", "型3"] });
    await undoOk();
    expect((await manifest()).app.design_memory).toEqual({ patterns: ["型1"] });
    await undoOk();
    expect((await manifest()).app.design_memory).toBeUndefined();
  });

  test("元に戻すの控え(snapshots/)に、控えた時点の型と選んだ記録がそのまま入る", async () => {
    await seedMemory();
    await applyOk(memoCandidate("d-after"));
    const snapshots = readdirSync(appSnapshotsDir(dataRoot, APP_ID)).sort();
    const latest = snapshots[snapshots.length - 1] as string;
    const text = readFileSync(
      join(appSnapshotsDir(dataRoot, APP_ID), latest, "manifest.json"),
      "utf-8",
    );
    expect(carried(text)).toEqual({ patterns: "含む", choices: "含む" });
  });
});

// ---------------------------------------------------------------------------------------------
// (c) 持ち出しの経路(計画 §10-4 の16行)
// ---------------------------------------------------------------------------------------------

describe("(c) 持ち出しの経路ごとに、型と選んだ記録が含まれるか(§10-4)", () => {
  beforeEach(async () => {
    await seedMemory();
  });

  test("MCP get_manifest: 型 = 含む / 選んだ記録 = 含む", async () => {
    const text = JSON.stringify(okData(await callTool("get_manifest", { app_id: APP_ID })));
    expect(carried(text)).toEqual({ patterns: "含む", choices: "含む" });
  });

  test("HTTP GET /manifest: 役割を問わずログインした全員に 含む / 含む(未ログインは 401)", async () => {
    const viewer = seedSession(dataRoot, APP_ID, { role: "viewer" }).cookie;
    const undeclared = seedSession(dataRoot, APP_ID, { role: "customer" }).cookie;
    for (const cookie of [ownerCookie, viewer, undeclared]) {
      const got = await getJson(`/api/apps/${APP_ID}/manifest`, cookie);
      expect(got.status).toBe(200);
      expect(carried(got.text)).toEqual({ patterns: "含む", choices: "含む" });
    }
    expect((await getJson(`/api/apps/${APP_ID}/manifest`, null)).status).toBe(401);
  });

  test("HTTP GET /changelog: 役割を問わずログインした全員に 含む / 含む(操作の中に理由。未ログインは 401)", async () => {
    const viewer = seedSession(dataRoot, APP_ID, { role: "viewer" }).cookie;
    const undeclared = seedSession(dataRoot, APP_ID, { role: "customer" }).cookie;
    for (const cookie of [ownerCookie, viewer, undeclared]) {
      const got = await getJson(`/api/apps/${APP_ID}/changelog`, cookie);
      expect(got.status).toBe(200);
      expect(carried(got.text)).toEqual({ patterns: "含む", choices: "含む" });
    }
    expect((await getJson(`/api/apps/${APP_ID}/changelog`, null)).status).toBe(401);
  });

  test("HTTP GET /requirements と MCP generate_requirements_doc: 型 = 含む / 選んだ記録 = 含まない(D-V20-61)", async () => {
    for (const format of ["json", "markdown"]) {
      const got = await getJson(`/api/apps/${APP_ID}/requirements?format=${format}`);
      expect(got.status).toBe(200);
      expect(carried(got.text)).toEqual({ patterns: "含む", choices: "含まない" });
    }
    const text = JSON.stringify(
      okData(await callTool("generate_requirements_doc", { app_id: APP_ID })),
    );
    expect(carried(text)).toEqual({ patterns: "含む", choices: "含まない" });
  });

  test("HTTP GET /public(未ログイン): 含まない / 含まない(キーは3つのまま)", async () => {
    const got = await getJson(`/api/apps/${APP_ID}/public`, null);
    expect(got.status).toBe(200);
    expect(Object.keys(got.body)).toEqual(["app", "views", "signup"]);
    expect(carried(got.text)).toEqual({ patterns: "含まない", choices: "含まない" });
  });

  test("POST /diffs と POST /undo の応答(change.manifest / undo.manifest): 含む / 含む", async () => {
    const applied = await applyOk(memoCandidate("d-later"));
    const change = applied.change as { manifest: unknown };
    expect(carried(JSON.stringify(change.manifest))).toEqual({ patterns: "含む", choices: "含む" });
    const undone = await undoOk();
    const back = undone.undo as { manifest: unknown };
    expect(carried(JSON.stringify(back.manifest))).toEqual({ patterns: "含む", choices: "含む" });
  });

  test("MCP apply_diff / undo / redo の返り値(manifest): 含む / 含む", async () => {
    const applied = okData(
      await callTool("apply_diff", { app_id: APP_ID, diff: memoCandidate("d-mcp") }),
    );
    expect(carried(JSON.stringify(applied))).toEqual({ patterns: "含む", choices: "含む" });
    const undone = okData(await callTool("undo", { app_id: APP_ID }));
    expect(carried(JSON.stringify(undone))).toEqual({ patterns: "含む", choices: "含む" });
    const redone = okData(await callTool("redo", { app_id: APP_ID }));
    expect(carried(JSON.stringify(redone))).toEqual({ patterns: "含む", choices: "含む" });
  });

  // **【計画 §10-4 の表と食い違った行。実測を正にする】** 表は preview_redo を「含む / 含む」と書いたが、
  // `previewRedo` の対象は **undo の行**であり、その `operations` は空である(`src/kernel/undo.ts` の
  // `computePreview` の注釈「redo 対象(undo エントリ)は operations が空」)。 定義そのものも返さない。
  // **したがって preview_redo は「含まない / 含まない」**(記録 `v20-m15-t03.md` に書く)。
  test("MCP preview_undo は取り消す操作が記録の差分なら 含む / 含む、preview_redo は 含まない / 含まない(どちらも定義は返さない)", async () => {
    // 直前の変更 = 記録の差分(seedMemory)。
    const pu = okData(await callTool("preview_undo", { app_id: APP_ID }));
    expect(carried(JSON.stringify(pu))).toEqual({ patterns: "含む", choices: "含む" });
    expect(JSON.stringify(pu)).not.toContain('"app":{');
    await undoOk();
    const pr = okData(await callTool("preview_redo", { app_id: APP_ID }));
    expect(carried(JSON.stringify(pr))).toEqual({ patterns: "含まない", choices: "含まない" });
    expect((pr.preview as { operations: unknown[] }).operations).toEqual([]);
    expect(JSON.stringify(pr)).not.toContain('"app":{');
    // 陰性対照: 直前の変更が記録と無関係なら、取り消す操作に記録は現れない。
    okData(await callTool("redo", { app_id: APP_ID }));
    await applyOk(memoCandidate("d-unrelated"));
    const other = okData(await callTool("preview_undo", { app_id: APP_ID }));
    expect(carried(JSON.stringify(other))).toEqual({ patterns: "含まない", choices: "含まない" });
  });

  test("MCP dry_run_diff の報告の manifest: 含む / 含む", async () => {
    const data = okData(
      await callTool("dry_run_diff", { app_id: APP_ID, diff: memoCandidate("d-dry") }),
    );
    expect(carried(JSON.stringify(data.report))).toEqual({ patterns: "含む", choices: "含む" });
  });

  test("MCP get_changelog: 含む / 含む", async () => {
    const text = JSON.stringify(okData(await callTool("get_changelog", { app_id: APP_ID })));
    expect(carried(text)).toEqual({ patterns: "含む", choices: "含む" });
  });

  test("控えの作成と戻し(runBackup / restoreBackup): 含む / 含む(定義と変更履歴の両方)", async () => {
    const backup = runBackup(dataRoot);
    expect(backup.apps).toContain(APP_ID);
    expect(
      carried(readFileSync(join(backup.dir, "apps", APP_ID, "manifest.json"), "utf-8")),
    ).toEqual({
      patterns: "含む",
      choices: "含む",
    });
    const db = new Database(join(backup.dir, "kernel.sqlite"), { readonly: true });
    const ops = db
      .query<{ operations: string }, [string]>("SELECT operations FROM changelog WHERE app_id = ?")
      .all(APP_ID)
      .map((r) => r.operations)
      .join("\n");
    db.close();
    expect(carried(ops)).toEqual({ patterns: "含む", choices: "含む" });

    const restored = join(work, "restored");
    restoreBackup(backup.dir, restored);
    expect(carried(readFileSync(appManifestPath(restored, APP_ID), "utf-8"))).toEqual({
      patterns: "含む",
      choices: "含む",
    });
  });

  test("下見の写し(未ログインが下見の URL で読む /manifest): 型 = 含む / 選んだ記録 = 含まない(D-V20-62)", async () => {
    const data = okData(
      await callTool("dry_run_diff", {
        app_id: APP_ID,
        diff: memoCandidate("d-pv"),
        preview: "real",
      }),
    );
    const url = (data.preview as { url: string }).url;
    const id = /\/apps\/(pv-[0-9a-f]{32})\/$/.exec(url)?.[1] ?? "";
    expect(id).not.toBe("");
    const got = await getJson(`/api/apps/${id}/manifest`, null);
    expect(got.status).toBe(200);
    expect(carried(got.text)).toEqual({ patterns: "含む", choices: "含まない" });
    // 本物は1バイトも変わっていない(陽性対照: 本物には選んだ記録が在る)。
    expect(carried(manifestBytes().toString("utf-8"))).toEqual({
      patterns: "含む",
      choices: "含む",
    });
  });

  test("/compare の案の diff: 案が型を書けば 型 = 含む / 選んだ記録 = 含まない(choice は案に入れられない)", async () => {
    const NEW_PATTERN = "CARRY-PATTERN-0007 一覧は詰める";
    const data = okData(
      await callTool("dry_run_diff", {
        app_id: APP_ID,
        diff: {
          ...memoCandidate("d-cmp"),
          operations: [
            ...memoCandidate().operations,
            { op: "remember_design", design_memory: { patterns: [PATTERN, NEW_PATTERN] } },
          ],
        },
        preview: "real",
        compare: { name: "型を足す案", tradeoff: "型が2つになる" },
      }),
    );
    const group = (data.compare as { group: string }).group;
    const got = await getJson(`/api/apps/${group}/compare`, null);
    expect(got.status, got.text).toBe(200);
    expect(got.text).toContain(NEW_PATTERN);
    expect(carried(got.text)).toEqual({ patterns: "含む", choices: "含まない" });
    // choice を書いた案は作る時点で断られる(束に入る経路が無い)。
    const refused = okData(
      await callTool("dry_run_diff", {
        app_id: APP_ID,
        diff: chosen(memoCandidate("d-cmp-choice"), CHOICE),
        preview: "real",
        compare: { name: "選んだ記録を書く案", tradeoff: "断られる", group },
      }),
    );
    expect(Object.keys(refused).sort()).toEqual(["preview_refused", "report"]);
    expect(carried((await getJson(`/api/apps/${group}/compare`, null)).text).choices).toBe(
      "含まない",
    );
  });

  test("置き場の移し替え(scripts/migrate-volume.ts): イメージの定義の型と選んだ記録がボリュームに入る(含む / 含む)", async () => {
    // ボリューム = 記録を持たない版のアプリ。 イメージ = 同じ定義 + 型と選んだ記録(本物の定義をそのまま使う)。
    const volume = join(work, "volume");
    const image = join(work, "image");
    okData(
      await callTool("create_app", { name: "移し替え", app_id: APP_ID }, BOOTSTRAP_ACTOR, volume),
    );
    seedSession(volume, APP_ID, { username: OWNER });
    const real = JSON.parse(manifestBytes().toString("utf-8")) as AppManifest;
    const withoutMemory = structuredClone(real);
    delete withoutMemory.app.design_memory;
    okData(
      await callTool(
        "apply_diff",
        {
          app_id: APP_ID,
          diff: {
            diff_id: "setup",
            intent: "メモの表と一覧を用意する",
            operations: [
              {
                op: "add_table",
                table: {
                  id: TABLE_ID,
                  name: "メモ",
                  fields: [{ id: "title", name: "題", type: "text", required: true }],
                },
              },
              {
                op: "add_view",
                view: { id: VIEW_ID, type: "list_view", table: TABLE_ID, columns: ["title"] },
              },
            ],
          },
        },
        OWNER,
        volume,
      ),
    );
    expect(carried(manifestBytes(volume).toString("utf-8"))).toEqual({
      patterns: "含まない",
      choices: "含まない",
    });
    mkdirSync(join(image, "apps", APP_ID), { recursive: true });
    const volumeManifest = JSON.parse(manifestBytes(volume).toString("utf-8")) as AppManifest;
    const memory = real.app.design_memory;
    if (memory === undefined)
      throw new Error("本物の定義に型と選んだ記録が無い(seedMemory の前提が崩れた)");
    volumeManifest.app.design_memory = memory;
    writeFileSync(appManifestPath(image, APP_ID), `${JSON.stringify(volumeManifest, null, 2)}\n`);
    for (const path of [kernelDbPath(volume), appDbPath(volume, APP_ID)]) {
      const db = new Database(path, { readwrite: true, create: false });
      db.exec(`PRAGMA user_version = ${RUNNER_BUILD_VERSION + 6};`);
      db.close();
    }
    const result = migrateVolume({ volumeDataRoot: volume, imageDataRoot: image });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(carried(manifestBytes(volume).toString("utf-8"))).toEqual({
      patterns: "含む",
      choices: "含む",
    });
  });

  test("配布物のデータの組み立て(scripts/build-runner-data.ts): 定義と1アプリ分の変更履歴に 含む / 含む", async () => {
    const target = join(work, "runner-data");
    buildRunnerData({ sourceDataRoot: dataRoot, targetDataRoot: target, appId: APP_ID });
    expect(carried(readFileSync(appManifestPath(target, APP_ID), "utf-8"))).toEqual({
      patterns: "含む",
      choices: "含む",
    });
    const db = new Database(kernelDbPath(target), { readonly: true });
    const ops = db
      .query<{ operations: string }, []>("SELECT operations FROM changelog")
      .all()
      .map((r) => r.operations)
      .join("\n");
    db.close();
    expect(carried(ops)).toEqual({ patterns: "含む", choices: "含む" });
  });
});

// ---------------------------------------------------------------------------------------------
// 条件26: 核の DB に表も列も足していない
// ---------------------------------------------------------------------------------------------

describe("条件26: 新しく作った kernel.sqlite の sqlite_master が着手前と一致する", () => {
  function masterDigest(root: string): { rows: number; tables: string[]; sha: string } {
    KernelMetaStore.open(root).close();
    const db = new Database(kernelDbPath(root), { readonly: true });
    try {
      const rows = db
        .query<{ type: string; name: string; sql: string }, []>(
          "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name",
        )
        .all();
      const text = rows
        .map((r) => `${r.type} ${r.name} :: ${r.sql.replace(/\s+/g, " ")}`)
        .join("\n");
      return {
        rows: rows.length,
        tables: rows.filter((r) => r.type === "table").map((r) => r.name),
        sha: sha(text),
      };
    } finally {
      db.close();
    }
  }

  test("KernelMetaStore.open だけで作った一覧の sha256 が T00 §3-1 の値と同じ", () => {
    const got = masterDigest(join(work, "fresh-kernel"));
    expect(got).toEqual({
      rows: 4,
      tables: ["apps", "changelog", "sqlite_sequence"],
      sha: KERNEL_SQLITE_MASTER_SHA256,
    });
  });

  test("陰性対照: 空の一覧の sha256 とは一致しない(一覧に changelog の表が在る)", () => {
    expect(sha("")).not.toBe(KERNEL_SQLITE_MASTER_SHA256);
    expect(masterDigest(join(work, "fresh-kernel-2")).tables).toContain("changelog");
  });
});
