/**
 * 故障注入テストハーネス(V1-M1-T04)。
 *
 * ## 「プロセスクラッシュ」を実際に作る
 *
 * **例外を投げるテストは、ここでは検証にならない。** `try/finally` が走ってしまい、
 * `applyDiff` の `catch` による巻き戻しが動く。それは「例外からの復帰」であって
 * 「クラッシュからの復帰」ではない。計画書 V1-M1-T04 の完了条件は
 * **「適用途中の各段階でプロセスを強制終了しても」**である。
 *
 * そこで本ハーネスは、
 *
 * 1. 子プロセス(`bun run <一時ファイル>`)で本物の `applyDiff` を走らせ、
 * 2. 指定した kill ポイントに到達した瞬間に **`process.kill(process.pid, "SIGKILL")`** を撃つ。
 *
 * **SIGKILL はハンドラを持てず `finally` も `process.on("exit")` も走らない。**
 * 親プロセス側で `signalCode === "SIGKILL"` を実測してから復旧を検証する。
 *
 * ## kill ポイントの注入に、製品コードへフックを1行も入れない
 *
 * `Bun.mock.module()` を子プロセスの中で使い、**カーネルが実際に呼ぶ依存**
 * (`node:fs` / `bun:sqlite` / `convert.ts` / `migrate.ts` / `meta-store.ts`)を
 * 薄く包んで、指定の瞬間に SIGKILL を撃つ。**製品コードは1バイトも変えていない**
 * ので、「テスト用フックがあるから通った」という抜け道が生まれない。
 * 包むのは子プロセスの中だけで、親(このテスト)の実行環境には影響しない。
 *
 * ## 実際の処理順序(計画書の kill ポイント一覧との差)
 *
 * 詳細化 §2-4 は (b) 一時ファイル書き込み後・`renameSync` の前 / (c) `renameSync` の
 * 直後・**DDL の前** を挙げているが、**`apply-manifest.ts:165-186` の実装順序は
 * 「一時ファイル書き込み → DDL → `renameSync`」であり、「`renameSync` の直後で
 * DDL の前」という時点は存在しない。** 存在しない時点は踏めないので、
 * **DDL を挟む3点**(一時ファイル書き込み後・DDL の前 / DDL 後・`renameSync` の前 /
 * `renameSync` の直後)に置き換えて全部踏む。詳細は記録 §3。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { applyManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { createRecord } from "./records.ts";
import { beginApply, endApply, isApplyInProgress, recover } from "./recovery.ts";
import { listSnapshots } from "./snapshot.ts";
import { appDbPath, appDir, appManifestPath } from "./storage-paths.ts";
import type { Diff, Manifest } from "./types.ts";

const APP_ID = "book-tracker";
/** `beginApply` が置く進行中マーカー(`recovery.ts` と同じ名前)。 */
const MARKER = ".st-applying.json";

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
            { id: "memo", name: "メモ", type: "long_text" },
            { id: "rating", name: "評価", type: "text" },
          ],
        },
        { id: "tags", name: "タグ", fields: [{ id: "label", name: "名前", type: "text" }] },
        { id: "scratch", name: "下書き", fields: [{ id: "body", name: "本文", type: "text" }] },
      ],
      views: [
        { id: "book-list", type: "list_view", table: "books", columns: ["title"] },
        { id: "book-form", type: "form", table: "books", fields: ["title", "memo", "rating"] },
      ],
    },
  };
}

/** 層2(TEXT → NUMERIC)。`rebuild-table.ts` のテーブル再構築を必ず通る差分。 */
function rebuildDiff(): Diff {
  return {
    diff_id: "d-rebuild",
    intent: "評価を数値型にする",
    operations: [
      { op: "change_field", table: "books", field: "rating", changes: { type: "number" } },
    ],
  } as Diff;
}

/** DDL を2文以上発行する差分(rename → drop)。トランザクション内の kill 用。 */
function multiDdlDiff(): Diff {
  return {
    diff_id: "d-multi",
    intent: "タグを整理し、下書きを捨てる",
    operations: [
      { op: "change_table", table: "tags", changes: { id: "labels" } },
      { op: "remove_table", table: "scratch" },
    ],
  } as Diff;
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-recovery-"));
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
      const created = createRecord(db, manifest, "books", {
        title,
        memo: `メモ${index}`,
        rating: String(index + 1),
      });
      if (!created.ok) {
        throw new Error("テスト前提のレコード投入に失敗しました。");
      }
    }
    createRecord(db, manifest, "tags", { label: "小説" });
    createRecord(db, manifest, "scratch", { body: "あとで消す" });
  } finally {
    db.close();
  }
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

// --- 観測 ------------------------------------------------------------------

/** マニフェストのバイト列。 */
function manifestBytes(): string {
  return readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8");
}

/** app.sqlite の実スキーマ(テーブル→列名と宣言型)。 */
function schema(): Record<string, string[]> {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    const tables = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      )
      .all();
    const out: Record<string, string[]> = {};
    for (const { name } of tables) {
      const columns = db
        .query<{ name: string; type: string }, []>(`PRAGMA table_info("${name}")`)
        .all();
      out[name] = columns.map((column) => `${column.name}:${column.type}`);
    }
    return out;
  } finally {
    db.close();
  }
}

/** 全テーブルの全行(型まで見る。`"1"` と `1` を区別するため)。 */
function rows(): Record<string, unknown[]> {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    const tables = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      )
      .all();
    const out: Record<string, unknown[]> = {};
    for (const { name } of tables) {
      const all = db.query(`SELECT * FROM "${name}" ORDER BY _id`).all() as Record<
        string,
        unknown
      >[];
      out[name] = all.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, `${typeof value}:${String(value)}`]),
        ),
      );
    }
    return out;
  } finally {
    db.close();
  }
}

function changelogIds(): string[] {
  const s = KernelMetaStore.open(dataRoot);
  try {
    return s.listChangelog(APP_ID).map((entry) => `${entry.kind}:${entry.diff_id}`);
  } finally {
    s.close();
  }
}

type State = {
  manifest: string;
  schema: Record<string, string[]>;
  rows: Record<string, unknown[]>;
  changelog: string[];
};

function snapshotState(): State {
  return { manifest: manifestBytes(), schema: schema(), rows: rows(), changelog: changelogIds() };
}

function markerExists(): boolean {
  return existsSync(join(appDir(dataRoot, APP_ID), MARKER));
}

// --- 子プロセスのハーネス --------------------------------------------------

const KERNEL_DIR = import.meta.dir;

/**
 * 子プロセス用のスクリプトを一時ディレクトリに書き出す。
 *
 * **リポジトリにファイルを増やさない**(歯止め1 の宣言を守る)ため、テスト実行時に
 * データルート直下へ生成して使い捨てる。
 */
function writeHarness(): string {
  const path = join(dataRoot, "harness.ts");
  writeFileSync(
    path,
    `
import { mock } from "bun:test";

const KERNEL = ${JSON.stringify(KERNEL_DIR)};
const kill = process.env.ST_KILL ?? "";
const sqlRe = process.env.ST_KILL_SQL === undefined ? null : new RegExp(process.env.ST_KILL_SQL);
const nth = Number(process.env.ST_KILL_NTH ?? "1");

/** ハンドラを持てない強制終了。finally も exit ハンドラも走らない。 */
function die(tag) {
  process.kill(process.pid, "SIGKILL");
  // ここには到達しない。到達したら SIGKILL が効いていない証拠なので落とす。
  throw new Error("SIGKILL did not take effect: " + tag);
}

let count = 0;
function nthHit() {
  count += 1;
  return count >= nth;
}

// **mock.module は既存の import 束縛も差し替える。** したがって元の実装は
// mock を張る**前に**ローカル変数へ退避しておかないと、包んだ関数が自分自身を
// 呼んで無限再帰になる(実際に一度そうなった。記録 §5-2)。
if (kill === "snapshot" || kill === "before-rename" || kill === "after-rename") {
  const realFs = await import("node:fs");
  const realCopy = realFs.copyFileSync;
  const realRename = realFs.renameSync;
  mock.module("node:fs", () => ({
    ...realFs,
    default: realFs.default,
    // takeSnapshot は manifest.json を copyFileSync してから VACUUM INTO する。
    // 実コピーを済ませてから撃つので、スナップショットは manifest.json だけの半端な状態になる。
    copyFileSync: (...args) => {
      realCopy(...args);
      if (kill === "snapshot") { die("snapshot"); }
    },
    renameSync: (...args) => {
      if (kill === "before-rename") { die("before-rename"); }
      realRename(...args);
      if (kill === "after-rename") { die("after-rename"); }
    },
  }));
}

if (kill === "before-ddl") {
  const realMigrate = await import(KERNEL + "/migrate.ts");
  mock.module(KERNEL + "/migrate.ts", () => ({
    ...realMigrate,
    applyMigrationPlan: () => die("before-ddl"),
  }));
}

if (kill === "in-ddl" || kill === "after-sql") {
  const realSqlite = await import("bun:sqlite");
  class Killer extends realSqlite.Database {
    exec(sql, ...rest) {
      const hit = sqlRe !== null && sqlRe.test(sql);
      if (hit && kill === "in-ddl") { die("in-ddl:" + sql); }
      const result = super.exec(sql, ...rest);
      if (hit && kill === "after-sql") { die("after-sql:" + sql); }
      return result;
    }
  }
  mock.module("bun:sqlite", () => ({ ...realSqlite, Database: Killer }));
}

if (kill === "convert") {
  const realConvert = await import(KERNEL + "/convert.ts");
  const realConvertValue = realConvert.convertValue;
  mock.module(KERNEL + "/convert.ts", () => ({
    ...realConvert,
    convertValue: (...args) => {
      const out = realConvertValue(...args);
      if (nthHit()) { die("convert"); }
      return out;
    },
  }));
}

if (kill === "before-changelog" || kill === "after-changelog") {
  // **ここは mock.module を使わない。** \`KernelMetaStore.open\` は静的メソッドの中で
  // 実クラスを直接 new するので、サブクラスに差し替えても open は実クラスを返す
  // (実際にそうなり、kill が空振りした。記録 §5-2)。プロトタイプを直接差し替える。
  const realStore = await import(KERNEL + "/meta-store.ts");
  const realAppend = realStore.KernelMetaStore.prototype.appendChangelog;
  realStore.KernelMetaStore.prototype.appendChangelog = function (input) {
    if (kill === "before-changelog") { die("before-changelog"); }
    const entry = realAppend.call(this, input);
    die("after-changelog");
    return entry;
  };
}

const { applyDiff } = await import(KERNEL + "/apply-diff.ts");
const [dataRoot, appId, diffJson] = process.argv.slice(2);
const result = applyDiff(dataRoot, appId, JSON.parse(diffJson));
console.log("NOT_KILLED " + JSON.stringify(result.valid));
`,
    "utf-8",
  );
  return path;
}

type CrashOptions = { sql?: string; nth?: number };

/** 子プロセスで applyDiff を走らせ、指定 kill ポイントで SIGKILL する。 */
function crashDuringApply(killPoint: string, diff: Diff, options: CrashOptions = {}): void {
  const harness = writeHarness();
  const env: Record<string, string> = { ...process.env, ST_KILL: killPoint };
  if (options.sql !== undefined) {
    env.ST_KILL_SQL = options.sql;
  }
  if (options.nth !== undefined) {
    env.ST_KILL_NTH = String(options.nth);
  }
  const proc = Bun.spawnSync({
    cmd: ["bun", "run", harness, dataRoot, APP_ID, JSON.stringify(diff)],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  // **ここが「本当にクラッシュさせたか」の実測である。**
  // 正常終了・例外終了だったら、この検証は成立していないので落とす。
  if (proc.signalCode !== "SIGKILL") {
    throw new Error(
      `kill ポイント "${killPoint}" で SIGKILL に到達しませんでした` +
        `(signal=${String(proc.signalCode)} exit=${String(proc.exitCode)})。\n` +
        `stdout: ${stdout}\nstderr: ${stderr}`,
    );
  }
  if (stdout.includes("NOT_KILLED")) {
    throw new Error(`kill ポイント "${killPoint}" を通過して apply が完走しました。`);
  }
}

// --- テスト ----------------------------------------------------------------

describe("起動時の整合性チェックは、正常時に副作用を持たない", () => {
  /** データルート配下の全ファイルの相対パス・内容・mtime を採る。 */
  function tree(): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        const stat = statSync(full);
        out[relative(dataRoot, full)] =
          `${Bun.hash(readFileSync(full)).toString(16)}@${stat.mtimeMs}`;
      }
    };
    walk(dataRoot);
    return out;
  }

  test("適用が1度も無い状態で recover を呼んでも、1バイトも書き換わらない", () => {
    const before = tree();
    const outcomes = recover(dataRoot);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["clean"]);
    expect(tree()).toEqual(before);
  });

  test("apply が正常完了した後に recover を呼んでも、1バイトも書き換わらない", () => {
    const proc = Bun.spawnSync({
      cmd: ["bun", "run", writeHarness(), dataRoot, APP_ID, JSON.stringify(rebuildDiff())],
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.stdout.toString()).toContain("NOT_KILLED true");
    expect(markerExists()).toBe(false);

    const before = tree();
    const outcomes = recover(dataRoot);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["clean"]);
    expect(tree()).toEqual(before);
  });

  test("recover を2回続けて呼んでも2回目は何もしない(冪等)", () => {
    crashDuringApply("before-changelog", rebuildDiff());
    expect(recover(dataRoot)[0]?.status).toBe("rolled_back");
    const after = tree();
    expect(recover(dataRoot).map((outcome) => outcome.status)).toEqual(["clean"]);
    expect(tree()).toEqual(after);
  });
});

describe("kill ポイント: 適用の各段階でプロセスを強制終了しても適用前状態へ自動復帰する", () => {
  /** 「クラッシュ → 別プロセス(このテスト)で復旧 → 適用前と完全一致」を1本で検査する。 */
  function expectRollback(
    killPoint: string,
    diff: Diff,
    options: CrashOptions = {},
  ): { before: State } {
    const before = snapshotState();
    crashDuringApply(killPoint, diff, options);
    // クラッシュ直後は進行中マーカーが残っている(= 未完了の適用が居ることが分かる)。
    expect(markerExists()).toBe(true);

    const outcomes = recover(dataRoot);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.app_id).toBe(APP_ID);
    expect(outcomes[0]?.diff_id).toBe(diff.diff_id);

    expect(snapshotState()).toEqual(before);
    expect(markerExists()).toBe(false);
    return { before };
  }

  test("(a) スナップショット取得の途中", () => {
    const before = snapshotState();
    crashDuringApply("snapshot", rebuildDiff());
    expect(markerExists()).toBe(true);
    const outcomes = recover(dataRoot);
    // スナップショットは半端(manifest.json だけ)。だが **本体はまだ1バイトも変わっていない**
    // ので、復元すべきものが無い。巻き戻しではなく「変更が無かった」と判定されるのが正しい。
    expect(outcomes[0]?.status).toBe("no_changes");
    expect(snapshotState()).toEqual(before);
    expect(markerExists()).toBe(false);
    // 半端なスナップショットは**消さない**(失敗の痕跡を消さない。apply-diff.ts の既存方針)。
    // changelog から参照されていないので undo の対象にはならず、害が無い。
    expect(listSnapshots(dataRoot, APP_ID)).toEqual(["0001-d-rebuild"]);
    expect(
      existsSync(join(dataRoot, "apps", APP_ID, "snapshots", "0001-d-rebuild", "app.sqlite")),
    ).toBe(false);
  });

  test("(b) マニフェスト一時ファイル書き込み後・DDL の前", () => {
    expectRollback("before-ddl", rebuildDiff());
    expect(recover(dataRoot)[0]?.status).toBe("clean");
    // 中断した一時ファイルを残さない。
    expect(existsSync(`${appManifestPath(dataRoot, APP_ID)}.tmp`)).toBe(false);
  });

  test("(b2) DDL 完了後・renameSync の前", () => {
    expectRollback("before-rename", rebuildDiff());
    expect(existsSync(`${appManifestPath(dataRoot, APP_ID)}.tmp`)).toBe(false);
  });

  test("(c) renameSync の直後", () => {
    expectRollback("after-rename", rebuildDiff());
  });

  test("(d) DDL 群のトランザクション内(1文目は実行済み・2文目の手前)", () => {
    // multiDdlDiff は rename_table → remove_table の2文を1トランザクションで出す。
    // DROP の手前で撃つので、RENAME だけが未コミットで残った状態になる。
    expectRollback("in-ddl", multiDdlDiff(), { sql: "^DROP TABLE" });
  });

  test("(e-1) データ変換の途中(テーブル再構築の全行変換の2行目)", () => {
    // convertValue は「事前検証の全行走査」(3行)→「再構築の全行変換」(3行)の順で
    // 呼ばれる。5回目は**再構築側の2行目**であり、DDL はまだ1文も出ていない。
    expectRollback("convert", rebuildDiff(), { nth: 5 });
  });

  test("(e-2) テーブル再構築の途中: 元テーブルを消す前", () => {
    expectRollback("in-ddl", rebuildDiff(), { sql: '^DROP TABLE "books"' });
  });

  test("(e-3) テーブル再構築の途中: 元テーブルを消した後", () => {
    // ここが最も危険な瞬間である —— 元テーブルは DROP 済み、新テーブルはまだ RENAME
    // されていない。復帰できなければ books のデータが丸ごと消える。
    expectRollback("after-sql", rebuildDiff(), { sql: '^DROP TABLE "books"' });
  });

  test("(f) DDL 完了後・appendChangelog の前(別 DB の隙間)", () => {
    const { before } = expectRollback("before-changelog", rebuildDiff());
    // 「適用したのに履歴に無い」が起きていないこと。
    expect(before.changelog).not.toContain("apply:d-rebuild");
    expect(changelogIds()).toEqual(before.changelog);
  });

  test("すべての kill ポイントで status は rolled_back か no_changes のいずれかである", () => {
    crashDuringApply("before-changelog", rebuildDiff());
    expect(recover(dataRoot)[0]?.status).toBe("rolled_back");
  });
});

describe("changelog に載った後のクラッシュは巻き戻さない(commit 点の判定)", () => {
  test("(g) appendChangelog の直後にクラッシュしても、適用は取り消されない", () => {
    crashDuringApply("after-changelog", rebuildDiff());
    expect(markerExists()).toBe(true);

    const outcomes = recover(dataRoot);
    expect(outcomes[0]?.status).toBe("committed");
    expect(markerExists()).toBe(false);

    // 適用は生きている: rating が NUMERIC になり、値も数値になっている。
    expect(schema().books).toContain("rating:NUMERIC");
    expect(changelogIds().at(-1)).toBe("apply:d-rebuild");
  });
});

describe("未完了の適用が残っている状態では、次の applyDiff が先に復旧する", () => {
  test("クラッシュ後に applyDiff を呼ぶと、適用前状態から始まる", async () => {
    const before = snapshotState();
    crashDuringApply("before-changelog", rebuildDiff());

    const { applyDiff } = await import("./apply-diff.ts");
    const result = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-after",
      intent: "別の変更",
      operations: [
        { op: "add_field", table: "books", field: { id: "isbn", name: "ISBN", type: "text" } },
      ],
    });
    expect(result.valid).toBe(true);
    expect(markerExists()).toBe(false);
    // クラッシュした差分は適用されていない(rating は TEXT のまま)。
    expect(schema().books).toContain("rating:TEXT");
    expect(before.schema.books).toContain("rating:TEXT");
    expect(changelogIds().at(-1)).toBe("apply:d-after");
    expect(changelogIds()).not.toContain("apply:d-rebuild");
  });
});

describe("isApplyInProgress: apply 窓ガード述語(V1-M9-T02)", () => {
  test("マーカーが無ければ inProgress:false(startedAt なし)", () => {
    const status = isApplyInProgress(dataRoot, APP_ID);
    expect(status.inProgress).toBe(false);
    expect(status.startedAt).toBeUndefined();
  });

  test("beginApply 後は inProgress:true で startedAt が付く", () => {
    beginApply(dataRoot, APP_ID, "d-guard");
    const status = isApplyInProgress(dataRoot, APP_ID);
    expect(status.inProgress).toBe(true);
    expect(typeof status.startedAt).toBe("string");
    // beginApply が書いた started_at をそのまま surface する(配線層のエラー文面用)。
    const startedAt = status.startedAt as string;
    expect(new Date(startedAt).toISOString()).toBe(startedAt);
  });

  test("endApply 後はふたたび inProgress:false", () => {
    beginApply(dataRoot, APP_ID, "d-guard");
    endApply(dataRoot, APP_ID);
    expect(isApplyInProgress(dataRoot, APP_ID).inProgress).toBe(false);
  });

  test("読み取りのみで recover を呼ばない(マーカーを消さない)", () => {
    beginApply(dataRoot, APP_ID, "d-guard");
    isApplyInProgress(dataRoot, APP_ID);
    // 述語はマーカーを一切変更しない(2回目も進行中のまま)。
    expect(isApplyInProgress(dataRoot, APP_ID).inProgress).toBe(true);
  });
});
