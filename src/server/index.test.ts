/**
 * HTTP サーバの**起動経路**の検査(V1-M1-T04 の追加作業)。
 *
 * 検査するのは `createServerApp` ではなく **`src/server/index.ts`(プロセスの入口)**
 * である。`app.test.ts` が `app.request()` で検証しているのは**定義**の側であり、
 * 「**プロセスを起動したら復旧するか**」はそこでは踏めない。
 *
 * ## 実プロセスを起動して観測する
 *
 * `bun run src/server/index.ts` を子プロセスとして起動し、`PORT=0`(空きポートを
 * OS に選ばせる)でリッスンさせる。**モックも差し替えもしない** —— 起動経路そのものを
 * 動かして、標準出力・標準エラー・終了コード・ファイルシステムを観測する。
 *
 * ## クラッシュ状態の作り方
 *
 * 復旧ロジックそのものは `src/kernel/recovery.test.ts` が **SIGKILL による本物の
 * クラッシュ**10点で検証済みである。**ここで検査するのは配線**(起動経路が `recover` を
 * 呼ぶか)であるが、**状態を手で捏造すると「未完了の適用」を検査したことにならない**ので、
 * ここでも本物のクラッシュを1点だけ再現する(`appendChangelog` の直前で SIGKILL)。
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
const ENTRY = join(REPO_ROOT, "src", "server", "index.ts");
const KERNEL_DIR = join(REPO_ROOT, "src", "kernel");
const LISTENING = "smailtalk server:";
const MCP_READY = "stdio で待機中";

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
  dataRoot = await mkdtemp(join(tmpdir(), "gp-server-start-"));
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

/** データルート配下の全ファイルの「内容ハッシュ@mtime」。 */
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

/** テーブルの全行(型まで見る。`"1"`(TEXT)と `1`(NUMERIC)を区別するため)。 */
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

/**
 * `appendChangelog` の直前で SIGKILL して、未完了の適用を残す。
 *
 * `recovery.test.ts` の kill ポイント (f) と同じ点である —— **DDL は適用済み、
 * changelog は未追記**という、放っておくと「適用したのに履歴に無い」になる状態。
 */
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
 * 明示的に reader を回す。
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

/**
 * `src/server/index.ts` を実プロセスとして起動し、リッスン開始(または終了)まで待つ。
 *
 * `PORT=0` で OS に空きポートを選ばせるので、テストを並行させてもポートが衝突しない。
 */
async function startServer(extraEnv: Record<string, string> = {}): Promise<Started> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", ENTRY],
    cwd: REPO_ROOT,
    env: { ...process.env, ST_DATA_ROOT: dataRoot, PORT: "0", ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await readUntil(proc.stdout, LISTENING, 15_000);
  proc.kill();
  await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode: proc.exitCode };
}

test("正常時: 起動しても1バイトも書き換わらない(起動経路の無副作用)", async () => {
  const before = tree();
  const started = await startServer();

  expect(started.stdout).toContain("smailtalk server:");
  // 復旧が起きていないので、診断ログは1行も出ない。
  expect(started.stderr).not.toContain("未完了の適用");
  expect(tree()).toEqual(before);
});

test("クラッシュ後: 起動しただけで適用前状態へ自動復帰する", async () => {
  const beforeSchema = schemaOf("books");
  const beforeChangelog = changelogIds();
  const beforeRows = rowsOf("books");
  expect(beforeSchema).toContain("rating:TEXT");
  expect(beforeRows).toHaveLength(3);

  crashMidApply();
  expect(markerExists()).toBe(true);

  const started = await startServer();

  expect(started.stdout).toContain("smailtalk server:");
  // **起動しただけで**復旧している。applyDiff は1回も呼んでいない。
  expect(markerExists()).toBe(false);
  expect(schemaOf("books")).toEqual(beforeSchema);
  expect(changelogIds()).toEqual(beforeChangelog);
  expect(changelogIds()).not.toContain("d-crash");
  // **ユーザデータが失われていないこと。** 起動時復旧の目的はここにある。
  expect(rowsOf("books")).toEqual(beforeRows);

  // 黙って直さない(憲法6)。何をしたかを stderr に出している。
  expect(started.stderr).toContain("未完了の適用を処理しました");
  expect(started.stderr).toContain("d-crash");
  expect(started.stderr).toContain("rolled_back");
});

test("MCP サーバと同時に起動しても二重復旧にならない(同じ dataRoot の共有)", async () => {
  const beforeSchema = schemaOf("books");
  const beforeChangelog = changelogIds();

  crashMidApply();

  // **同じ dataRoot に対して2つのプロセスを同時に起動する。**
  // ADR-0005 が定めるとおり MCP サーバと Web サーバは別プロセスで
  // `ST_DATA_ROOT` を共有するので、これは実運用で起こりうる並びである。
  const mcpEntry = join(REPO_ROOT, "src", "mcp", "index.ts");
  const [web, mcp] = await Promise.all([
    startServer(),
    (async () => {
      const proc = Bun.spawn({
        cmd: ["bun", "run", mcpEntry],
        cwd: REPO_ROOT,
        env: { ...process.env, ST_DATA_ROOT: dataRoot },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = await readUntil(proc.stderr, MCP_READY, 15_000);
      proc.kill();
      await proc.exited;
      return stderr;
    })(),
  ]);

  // 両方とも起動に成功している。
  expect(web.stdout).toContain("smailtalk server:");
  expect(mcp).toContain(MCP_READY);

  // **結果は1回だけ復旧したときと同一である。**
  // `recover` は「固定のスナップショットへ書き戻す」だけで、累積する作用を持たない。
  // changelog にも1行も足さないので、二重に実行されても二重には効かない。
  expect(markerExists()).toBe(false);
  expect(schemaOf("books")).toEqual(beforeSchema);
  expect(changelogIds()).toEqual(beforeChangelog);
  expect(changelogIds()).not.toContain("d-crash");

  // 少なくとも一方は実際に復旧を報告している(両方報告することもある)。
  expect(`${web.stderr}${mcp}`).toContain("未完了の適用を処理しました");
});

// ---------------------------------------------------------------------------
// V1-M2-T08 単位2: タイムゾーンの解決とスケジューラの起動
// ---------------------------------------------------------------------------

test("ST_TIMEZONE 未設定なら既定(Asia/Tokyo)で起動する", async () => {
  const started = await startServer();

  expect(started.stdout).toContain("smailtalk server:");
  // **どの TZ で動いているかを起動ログに出す。**発火時刻の解釈がここでしか読めない。
  expect(started.stdout).toContain("timeZone=Asia/Tokyo");
});

test("ST_TIMEZONE に妥当な値を渡すと、その TZ で起動する", async () => {
  const started = await startServer({ ST_TIMEZONE: "utc" });

  expect(started.stdout).toContain("smailtalk server:");
  // `Intl` の正規形で出る(綴りの揺れを入口で吸収している)。
  expect(started.stdout).toContain("timeZone=UTC");
});

test("ST_TIMEZONE が不正なら起動しない(黙って既定に落とさない)", async () => {
  // **黙って `Asia/Tokyo` に落とすと、発火時刻が静かにずれる**(判断1)。
  // これは「タイマーの失敗」ではなく**設定の誤り**なので、起動を止める側に倒す。
  const started = await startServer({ ST_TIMEZONE: "Mars/Olympus_Mons" });

  expect(started.stdout).not.toContain("smailtalk server:");
  expect(started.exitCode).toBe(1);
  expect(started.stderr).toContain("ST_TIMEZONE");
  // 直し方が読める(何を書けばよいのかが書いてある)。
  expect(started.stderr).toContain("Asia/Tokyo");
});

test("認証設定(ST_AUTH_*)が不正なら起動しない(黙って既定に落とさない)", async () => {
  // rpID が expectedOrigin の登録可能サフィックスでない設定。`validateAuthConfig` が throw し、
  // timezone と同じ作法で**リッスン前に**落ちる(ADR-0014 §10)。
  const started = await startServer({
    ST_AUTH_RP_ID: "example.com",
    ST_AUTH_EXPECTED_ORIGIN: "http://localhost:5173",
  });

  expect(started.stdout).not.toContain("smailtalk server:");
  expect(started.exitCode).toBe(1);
  expect(started.stderr).toContain("認証設定");
});

test("スケジューラの前提が壊れていても、サーバはリッスンを続ける(完了条件5)", async () => {
  // **台帳にはあるが manifest.json が無いアプリ。**スケジューラがこれを読むと必ず失敗する。
  // `recover` はマーカーが無いので何もせず、起動は正常系のまま通る。
  const broken = "broken-app";
  const s = KernelMetaStore.open(dataRoot);
  try {
    createApp(s, "壊れたアプリ", { app_id: broken });
  } finally {
    s.close();
  }
  writeFileSync(join(appDir(dataRoot, broken), "manifest.json"), "{ 壊れた JSON", "utf-8");

  const started = await startServer();

  // **`recover` の exit(1) を真似ていない。**リッスンは始まる。
  expect(started.stdout).toContain("smailtalk server:");
  expect(started.exitCode).not.toBe(1);
  expect(started.stderr).not.toContain("起動を中止します");
});

test("復旧に失敗したら起動しない(壊れたまま静かに起動しない)", async () => {
  crashMidApply();
  // マーカーを壊す。`recover` は「未完了の適用が居ることは確かだが、何なのか読めない」
  // 状態なので例外を投げる。
  writeFileSync(join(appDir(dataRoot, APP_ID), MARKER), "{ 壊れた JSON", "utf-8");

  const started = await startServer();

  expect(started.stdout).not.toContain("smailtalk server:");
  expect(started.exitCode).toBe(1);
  expect(started.stderr).toContain("起動時の整合性チェックに失敗したため起動を中止します");
  // 壊れた状態はそのまま残っている(黙って消さない)。
  expect(markerExists()).toBe(true);
});

// --- 版の照合(`V5-M5-T03` / `V5-M5-T05` / `ADR-0251`)-------------------------
//
// **掛ける先は実行専用の起動プロファイル(`runner`)だけである。** 開発・編集用の
// `full`(既定)には掛けない —— 掛けると、**今日ディスクにある `user_version = 0` の
// ボリュームが二度と起動しなくなる**(`ADR-0251` §6 の 3 により、印の無い DB の救済は
// 門A を新規に通さないとできない)。**判断と選ばなかった案は
// `docs/plan/v5/records/v5-m5.md` §3 にある。**

/** このボリュームの `app.sqlite` の版を書き換える(**版だけ**。中身は1バイトも触らない)。 */
function setAppDbUserVersion(value: number): void {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    db.exec(`PRAGMA user_version = ${value};`);
  } finally {
    db.close();
  }
}

test("runner プロファイル: 版が合わないボリュームでは起動しない(理由と次のコマンドが出る)", async () => {
  setAppDbUserVersion(999);

  const started = await startServer({ ST_SERVER_PROFILE: "runner" });

  expect(started.stdout).not.toContain("smailtalk server:");
  expect(started.exitCode).toBe(1);
  expect(started.stderr).toContain("版が合わないため起動を中止します");
  expect(started.stderr).toContain("user_version = 999");
  expect(started.stderr).toContain("次に打つべきコマンド");
});

test("runner プロファイル: user_version = 0 のボリュームでも起動しない(救済しない)", async () => {
  setAppDbUserVersion(0);

  const started = await startServer({ ST_SERVER_PROFILE: "runner" });

  expect(started.exitCode).toBe(1);
  expect(started.stderr).toContain("user_version = 0");
  // **`V5-M6` が文面を実体に合わせたので語が変わった** —— 移行器が実在する今日は
  // 「移行器が出来ても救済されない」ではなく「移行器はこれを1バイトも触らずに拒否する」
  // と書いている(`ADR-0251` 限定6 / §6 の 3。**救済しないことは変わっていない**)。
  expect(started.stderr).toContain("印の無いボリューム");
  expect(started.stderr).toContain("上のコマンドを打っても直らない");
});

test("runner プロファイル: 版が合っていれば今日どおり起動する", async () => {
  const started = await startServer({ ST_SERVER_PROFILE: "runner" });

  expect(started.stdout).toContain("smailtalk server:");
  expect(started.stderr).not.toContain("版が合わないため起動を中止します");
});

test("full プロファイル(既定): 版が合わなくても起動する —— 既存の開発環境を止めない", async () => {
  setAppDbUserVersion(0);

  const started = await startServer();

  expect(started.stdout).toContain("smailtalk server:");
  expect(started.stderr).not.toContain("版が合わないため起動を中止します");
});
