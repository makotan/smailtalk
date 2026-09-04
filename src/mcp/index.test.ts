/**
 * MCP stdio エントリポイントの**起動経路**の検査(V1-M1-T04 の追加作業)。
 *
 * 検査するのは `createMcpServer` ではなく **`src/mcp/index.ts`(プロセスの入口)**
 * である。`server.test.ts` が検証しているのは**定義**の側であり、
 * 「**プロセスを起動したら復旧するか**」はそこでは踏めない。
 *
 * ## stdout を汚さないことも同時に検査する
 *
 * MCP は stdin / stdout で JSON-RPC を流すので、**起動時の復旧ログが stdout へ
 * 1バイトでも出たらプロトコルが壊れる**(モジュール冒頭の警告)。復旧は
 * 「黙って直さない」ことを要求する(憲法6)一方で、その出力先を間違えると
 * 製品が壊れる。**両立していることを実測で固定する。**
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { applyManifest } from "../kernel/apply-manifest.ts";
import { createApp } from "../kernel/create-app.ts";
import { KernelMetaStore } from "../kernel/meta-store.ts";
import { createRecord } from "../kernel/records.ts";
import { appDbPath, appDir } from "../kernel/storage-paths.ts";
import type { Manifest } from "../kernel/types.ts";

const APP_ID = "book-tracker";
const MARKER = ".st-applying.json";
const REPO_ROOT = dirname(dirname(import.meta.dir));
const ENTRY = join(REPO_ROOT, "src", "mcp", "index.ts");
const KERNEL_DIR = join(REPO_ROOT, "src", "kernel");
const READY = "stdio で待機中";

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
          fields: [
            { id: "title", name: "タイトル", type: "text", required: true },
            { id: "rating", name: "評価", type: "text" },
          ],
        },
      ],
      views: [{ id: "book-list", type: "list_view", table: "books", columns: ["title"] }],
    },
  };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-mcp-start-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "蔵書管理", { app_id: APP_ID });
  const applied = applyManifest(dataRoot, APP_ID, baseManifest());
  if (!applied.valid) {
    throw new Error("テスト前提の初期マニフェスト投入に失敗しました。");
  }
  const manifest = baseManifest();
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    for (const [index, title] of ["坊っちゃん", "こころ", "門"].entries()) {
      createRecord(db, manifest, "books", { title, rating: String(index + 1) });
    }
  } finally {
    db.close();
  }
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

function tree(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      out[relative(dataRoot, full)] =
        `${Bun.hash(readFileSync(full)).toString(16)}@${statSync(full).mtimeMs}`;
    }
  };
  walk(dataRoot);
  return out;
}

function markerExists(): boolean {
  return existsSync(join(appDir(dataRoot, APP_ID), MARKER));
}

function schemaOf(table: string): string[] {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return db
      .query<{ name: string; type: string }, []>(`PRAGMA table_info("${table}")`)
      .all()
      .map((column) => `${column.name}:${column.type}`);
  } finally {
    db.close();
  }
}

/** テーブルの全行(型まで見る)。 */
function rowsOf(table: string): string[] {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return db
      .query(`SELECT * FROM "${table}" ORDER BY _id`)
      .all()
      .map((row) =>
        Object.entries(row as Record<string, unknown>)
          .map(([key, value]) => `${key}=${typeof value}:${String(value)}`)
          .join(","),
      );
  } finally {
    db.close();
  }
}

function changelogIds(): string[] {
  const s = KernelMetaStore.open(dataRoot);
  try {
    return s.listChangelog(APP_ID).map((entry) => entry.diff_id);
  } finally {
    s.close();
  }
}

/** `appendChangelog` の直前で SIGKILL して、未完了の適用を残す(kill ポイント (f))。 */
function crashMidApply(): void {
  const harness = join(dataRoot, "crash.ts");
  writeFileSync(
    harness,
    `
import { mock } from "bun:test";
const KERNEL = ${JSON.stringify(KERNEL_DIR)};
const realStore = await import(KERNEL + "/meta-store.ts");
realStore.KernelMetaStore.prototype.appendChangelog = function () {
  process.kill(process.pid, "SIGKILL");
  throw new Error("SIGKILL did not take effect");
};
const { applyDiff } = await import(KERNEL + "/apply-diff.ts");
applyDiff(process.argv[2], process.argv[3], {
  diff_id: "d-crash",
  intent: "評価を数値型にする",
  operations: [
    { op: "change_field", table: "books", field: "rating", changes: { type: "number" } },
  ],
});
console.log("NOT_KILLED");
`,
    "utf-8",
  );
  const proc = Bun.spawnSync({
    cmd: ["bun", "run", harness, dataRoot, APP_ID],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.signalCode !== "SIGKILL" || proc.stdout.toString().includes("NOT_KILLED")) {
    throw new Error(
      `クラッシュ状態を作れませんでした(signal=${String(proc.signalCode)})。\n` +
        proc.stderr.toString(),
    );
  }
}

type Started = { stdout: string; stderr: string; exitCode: number | null };

/**
 * ストリームを、目印の文字列が現れるまで(または終わるまで)読む。
 *
 * `for await (const chunk of stream)` は Bun の実行時には動くが、
 * `ReadableStream` の型に `[Symbol.asyncIterator]` が無いので `tsc` が通らない。
 */
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

/** `src/mcp/index.ts` を実プロセスとして起動し、待機開始(または終了)まで待つ。 */
async function startMcp(): Promise<Started> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", ENTRY],
    cwd: REPO_ROOT,
    env: { ...process.env, ST_DATA_ROOT: dataRoot },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await readUntil(proc.stderr, READY, 15_000);
  proc.kill();
  await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  return { stdout, stderr, exitCode: proc.exitCode };
}

test("正常時: 起動しても1バイトも書き換わらない(起動経路の無副作用)", async () => {
  const before = tree();
  const started = await startMcp();

  expect(started.stderr).toContain(READY);
  expect(started.stderr).not.toContain("未完了の適用");
  expect(tree()).toEqual(before);
});

test("クラッシュ後: 起動しただけで適用前状態へ自動復帰し、stdout を汚さない", async () => {
  const beforeSchema = schemaOf("books");
  const beforeChangelog = changelogIds();
  const beforeRows = rowsOf("books");
  expect(beforeRows).toHaveLength(3);

  crashMidApply();
  expect(markerExists()).toBe(true);

  const started = await startMcp();

  expect(started.stderr).toContain(READY);
  expect(markerExists()).toBe(false);
  expect(schemaOf("books")).toEqual(beforeSchema);
  expect(changelogIds()).toEqual(beforeChangelog);
  expect(changelogIds()).not.toContain("d-crash");
  // **ユーザデータが失われていないこと。** 起動時復旧の目的はここにある。
  expect(rowsOf("books")).toEqual(beforeRows);

  // 黙って直さない(憲法6)。
  expect(started.stderr).toContain("未完了の適用を処理しました");
  expect(started.stderr).toContain("d-crash");

  // **かつ stdout は1バイトも汚れていない。** ここが汚れると JSON-RPC が壊れる。
  expect(started.stdout).toBe("");
});

test("復旧に失敗したら起動しない(壊れたまま静かに起動しない)", async () => {
  crashMidApply();
  writeFileSync(join(appDir(dataRoot, APP_ID), MARKER), "{ 壊れた JSON", "utf-8");

  const started = await startMcp();

  expect(started.stderr).not.toContain(READY);
  expect(started.exitCode).toBe(1);
  expect(started.stderr).toContain("起動時の整合性チェックに失敗したため起動を中止します");
  expect(started.stdout).toBe("");
  expect(markerExists()).toBe(true);
});
