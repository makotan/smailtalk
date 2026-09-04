/**
 * MCP の **HTTP エントリポイント**(`src/mcp/http-entry.ts`)の起動経路の検査。
 * `V5-M9` / `R-G15-a` / `R-G15-c`。
 *
 * `src/mcp/index.test.ts` が stdio のエントリに対して行っているのと同じことを、
 * HTTP のエントリに対して行う —— **プロセスとして起動したときに何が起きるか**は、
 * `http-transport.test.ts`(ライブラリを直接呼ぶ検査)では踏めない。
 *
 * ## この検査が固定する決定(02 §6-1 の 5 が「決めずに黙って外さないこと」と書いたもの)
 *
 * 1. **stdout へ1バイトも書かない。** stdio のエントリと同じ規律を HTTP でも守る。
 *    **HTTP では stdout は JSON-RPC のフレームではないので、壊れる理由は無い。**
 *    それでも守るのは、(a) 同じリポジトリで入口ごとにログの出し先が違うと
 *    運用時に読み分けが要る、(b) 将来 stdio と HTTP を同じスーパバイザから
 *    起動したときに出し分けが要る、の2つによる。**「不要になったから外す」を
 *    黙ってやらない。**
 * 2. **起動時の2つの失敗の扱いを、常駐プロセスでも stdio と同じにする。**
 *    復旧の失敗 → **起動しない**(`process.exit(1)`)。島ランタイムの事前ロードの
 *    失敗 → **起動は止めない**。**接続のたびではなく、プロセスの起動時に1回だけ判断する。**
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyManifest } from "../kernel/apply-manifest.ts";
import { createApp } from "../kernel/create-app.ts";
import { KernelMetaStore } from "../kernel/meta-store.ts";
import { createRecord } from "../kernel/records.ts";
import { appDbPath, appDir } from "../kernel/storage-paths.ts";
import type { Manifest } from "../kernel/types.ts";

const APP_ID = "book-tracker";
const MARKER = ".st-applying.json";
const REPO_ROOT = dirname(dirname(import.meta.dir));
const ENTRY = join(REPO_ROOT, "src", "mcp", "http-entry.ts");
const READY = "HTTP で待機中";

let dataRoot: string;
let store: KernelMetaStore;

function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "蔵書管理",
      tables: [
        {
          id: "books",
          name: "本",
          fields: [{ id: "title", name: "タイトル", type: "text", required: true }],
        },
      ],
      views: [{ id: "book-list", type: "list_view", table: "books", columns: ["title"] }],
    },
  };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "st-mcp-http-entry-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "蔵書管理", { app_id: APP_ID });
  const applied = applyManifest(dataRoot, APP_ID, baseManifest());
  if (!applied.valid) {
    throw new Error("テスト前提の初期マニフェスト投入に失敗しました。");
  }
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    createRecord(db, baseManifest(), "books", { title: "坊っちゃん" });
  } finally {
    db.close();
  }
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

async function readUntil(
  stream: ReadableStream<Uint8Array>,
  needle: string,
  timeoutMs: number,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      text += decoder.decode(value, { stream: true });
      if (text.includes(needle)) {
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return text;
}

type Started = {
  proc: Bun.Subprocess;
  stderr: string;
  url: string | undefined;
  origin: string | undefined;
};

async function startHttpEntry(extraEnv: Record<string, string> = {}): Promise<Started> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", ENTRY],
    cwd: REPO_ROOT,
    env: { ...process.env, ST_DATA_ROOT: dataRoot, ST_MCP_HTTP_PORT: "0", ...extraEnv },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await readUntil(proc.stderr as ReadableStream<Uint8Array>, READY, 20_000);
  const match = /url=(\S+?)[,)]/.exec(stderr);
  const url = match?.[1];
  const origin = url === undefined ? undefined : new URL(url).origin;
  return { proc, stderr, url, origin };
}

test("HTTP エントリ: 127.0.0.1 で待機し、tools/list が23本を返し、stdout を1バイトも汚さない", async () => {
  const started = await startHttpEntry();
  try {
    expect(started.stderr).toContain(READY);
    expect(started.url).toBeDefined();
    expect(new URL(started.url as string).hostname).toBe("127.0.0.1");
    expect(new URL(started.url as string).pathname).toBe("/mcp");

    const response = await fetch(started.url as string, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        origin: started.origin as string,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result?: { tools?: unknown[] } };
    // **【2026-08-15。`V8-M13-T02`。台帳 `Q-G28` = 限定採用(門A)】期待値を 23 → 24 へ
    // 書き換えた。** **旧行の逐語**: `expect(body.result?.tools?.length).toBe(23);`
    // **足したのは `read_report`(集計表を1枚読む参照系)1本だけである。**
    // **テスト名は1バイトも書き換えていない**(「23本」は 2026-08-14 までの事実)。
    // **【2026-08-24。`V10-M12-T01`。台帳 `CM-G7` / `ADR-0368`】期待値を 24 → 25 へ
    // 書き換えた。** **旧行の逐語**: `expect(body.result?.tools?.length).toBe(24);`
    // **足したのは `list_comments`(コメントを読む参照系)1本だけである。**
    // **【2026-08-25。`V10-M30-T02`。台帳 `CM-G37` / `ADR-0378`】期待値を 25 → 26 へ
    // 書き換えた。** **旧行の逐語**: `expect(body.result?.tools?.length).toBe(25);`
    // **足したのは `set_comment_visibility`(コメントの出し入れを切り替える更新系)1本だけである。**
    expect(body.result?.tools?.length).toBe(26);
  } finally {
    started.proc.kill();
    await started.proc.exited;
  }

  const stdout = await new Response(started.proc.stdout as ReadableStream<Uint8Array>).text();
  expect(stdout).toBe("");
});

test("HTTP エントリ: Origin の無い要求は実プロセス越しでも 403 で落ちる", async () => {
  const started = await startHttpEntry();
  try {
    const response = await fetch(started.url as string, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(403);
  } finally {
    started.proc.kill();
    await started.proc.exited;
  }
});

test("HTTP エントリ: 起動時の復旧に失敗したら待機しない(stdio と同じ扱い)", async () => {
  writeFileSync(join(appDir(dataRoot, APP_ID), MARKER), "{ 壊れた JSON", "utf-8");

  const proc = Bun.spawn({
    cmd: ["bun", "run", ENTRY],
    cwd: REPO_ROOT,
    env: { ...process.env, ST_DATA_ROOT: dataRoot, ST_MCP_HTTP_PORT: "0" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await readUntil(
    proc.stderr as ReadableStream<Uint8Array>,
    "起動時の整合性チェックに失敗したため起動を中止します",
    20_000,
  );
  await proc.exited;

  expect(stderr).not.toContain(READY);
  expect(stderr).toContain("起動時の整合性チェックに失敗したため起動を中止します");
  expect(proc.exitCode).toBe(1);
  const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
  expect(stdout).toBe("");
});
