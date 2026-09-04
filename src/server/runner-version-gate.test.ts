/**
 * `V5-M5-T03` / `V5-M5-T04`(`R-G2` / `R-G3` / `R-G7`)。**起動を止める側の検査。**
 *
 * 固定するのは [`ADR-0251`](../../docs/adr/0251-runner-build-version.md) §5 の
 * **限定4(等しいかの1判定)/ 限定5(fail-closed。迂回口なし)/ 限定6(`user_version = 0`
 * を救済しない)/ 限定7(`kernel.sqlite` も `app.sqlite` も同じ照合関数を通る)** である。
 *
 * ## `src/kernel/` を1本も import しない
 *
 * `scripts/kernel-import-drift.test.ts` の走査対象に `src/server/` が入っており、
 * ここで `createApp` や `appDbPath` を値 import すると `kernel-import-snapshot.txt` が
 * 動く(`ADR-0009` 限定2 の審査対象になる)。**したがってフィクスチャのボリュームは
 * 生の `bun:sqlite` と `node:path` だけで組む。** レイアウト(`ADR-0002`)は
 * `src/kernel/storage-paths.ts` と同一であり、そこに合わせて手で書く
 * (`scripts/kernel-import-snapshot.txt:75` の但し書きと同じ手口)。
 *
 * ## 本物のプロセスを起こす
 *
 * 「起動が止まる」は関数の戻り値では示せない。**`bun run src/server/runner-version-gate.ts`
 * を子プロセスとして起こし、終了コードと標準エラーを観測する。**
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RUNNER_BUILD_VERSION } from "../shared/runner-build-version.ts";
import {
  checkRunnerVersionGate,
  collectVolumeDbVersions,
  formatGateFailure,
} from "./runner-version-gate.ts";

const REPO_ROOT = dirname(dirname(import.meta.dir));
const GATE_ENTRY = join(REPO_ROOT, "src", "server", "runner-version-gate.ts");

let dataRoot: string;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-version-gate-"));
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

/** `<dataRoot>/kernel.sqlite` を作り、版を刻む(WAL。本物の `KernelMetaStore.open` と同じモード)。 */
function makeKernelDb(root: string, userVersion: number): void {
  mkdirSync(root, { recursive: true });
  const db = new Database(join(root, "kernel.sqlite"), { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`CREATE TABLE IF NOT EXISTS "apps" ("app_id" TEXT PRIMARY KEY)`);
  db.exec(`PRAGMA user_version = ${userVersion};`);
  db.close();
}

/** `<dataRoot>/apps/<appId>/app.sqlite` を作り、版を刻む。 */
function makeAppDb(root: string, appId: string, userVersion: number): void {
  const dir = join(root, "apps", appId);
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "app.sqlite"), { create: true });
  db.exec("PRAGMA journal_mode = DELETE;");
  db.exec(`PRAGMA user_version = ${userVersion};`);
  db.close();
}

function runGate(root: string): { exitCode: number; stderr: string; stdout: string } {
  const result = Bun.spawnSync(["bun", "run", GATE_ENTRY, root], {
    cwd: REPO_ROOT,
    env: { ...process.env },
  });
  return {
    exitCode: result.exitCode,
    stderr: new TextDecoder().decode(result.stderr),
    stdout: new TextDecoder().decode(result.stdout),
  };
}

// --- 版が合っているとき ------------------------------------------------------

test("版が合っているボリュームは通る", () => {
  makeKernelDb(dataRoot, RUNNER_BUILD_VERSION);
  makeAppDb(dataRoot, "inv", RUNNER_BUILD_VERSION);

  const result = checkRunnerVersionGate(dataRoot);
  expect(result.ok).toBe(true);
  expect(result.mismatched).toEqual([]);
  expect(result.checked.length).toBe(2);
});

test("版が合っているボリュームでは本物のプロセスが終了コード0で終わる", () => {
  makeKernelDb(dataRoot, RUNNER_BUILD_VERSION);
  makeAppDb(dataRoot, "inv", RUNNER_BUILD_VERSION);

  const { exitCode } = runGate(dataRoot);
  expect(exitCode).toBe(0);
});

// --- 完了条件1: 版が合わないボリュームで起動が止まる --------------------------

test("完了条件1: app.sqlite の版が合わないと起動が止まる(終了コード1)", () => {
  makeKernelDb(dataRoot, RUNNER_BUILD_VERSION);
  makeAppDb(dataRoot, "inv", RUNNER_BUILD_VERSION + 1);

  const result = checkRunnerVersionGate(dataRoot);
  expect(result.ok).toBe(false);
  expect(result.mismatched.map((v) => v.label)).toEqual(["apps/inv/app.sqlite"]);

  const { exitCode, stderr } = runGate(dataRoot);
  expect(exitCode).toBe(1);
  expect(stderr).toContain("apps/inv/app.sqlite");
});

test("限定4: 版が古くても新しくても同じように止まる(「以上」で通す経路が無い)", () => {
  makeKernelDb(dataRoot, RUNNER_BUILD_VERSION);
  makeAppDb(dataRoot, "older", RUNNER_BUILD_VERSION - 1);
  makeAppDb(dataRoot, "newer", RUNNER_BUILD_VERSION + 1);

  const result = checkRunnerVersionGate(dataRoot);
  expect(result.ok).toBe(false);
  expect(result.mismatched.map((v) => v.label).sort()).toEqual([
    "apps/newer/app.sqlite",
    "apps/older/app.sqlite",
  ]);
});

// --- 完了条件2(`D-V5-14`): 止めた理由と次に打つべきコマンドが出る -------------

test("完了条件2: 止めた理由と、次に打つべきコマンドが標準エラーに出る", () => {
  makeKernelDb(dataRoot, RUNNER_BUILD_VERSION);
  makeAppDb(dataRoot, "inv", RUNNER_BUILD_VERSION + 1);

  const { exitCode, stderr } = runGate(dataRoot);
  expect(exitCode).toBe(1);
  // 理由: 何が期待され、何が入っていたか。
  expect(stderr).toContain("版が合わないため起動を中止します");
  expect(stderr).toContain(`Runner のイメージの版: ${RUNNER_BUILD_VERSION}`);
  expect(stderr).toContain(`user_version = ${RUNNER_BUILD_VERSION + 1}`);
  // 次に打つべきコマンド(`D-V5-14`)。
  // **`V5-M5` の時点では暫定だった**(移行器が1バイトも存在しなかった)。
  // **`V5-M6` が `scripts/migrate-volume.ts` を作ったので、文面を実体に合わせた**
  // (`v5-m5.md` §7 の 2 の申し送り)。**指す先が実在することもここで固定する。**
  expect(stderr).toContain("次に打つべきコマンド");
  expect(stderr).toContain("scripts/migrate-volume.ts");
  expect(existsSync(join(REPO_ROOT, "scripts/migrate-volume.ts"))).toBe(true);
});

test("完了条件2: 理由とコマンドは formatGateFailure が単独で組み立てる(プロセスに依存しない)", () => {
  makeKernelDb(dataRoot, 0);
  makeAppDb(dataRoot, "inv", 0);

  const message = formatGateFailure(checkRunnerVersionGate(dataRoot));
  expect(message).toContain("kernel.sqlite");
  expect(message).toContain("apps/inv/app.sqlite");
  expect(message).toContain("次に打つべきコマンド");
});

// --- 完了条件3(限定6): `user_version = 0` を救済しない ----------------------

test("完了条件3: user_version = 0 の DB でも起動が止まる(救済しない)", () => {
  makeKernelDb(dataRoot, 0);
  makeAppDb(dataRoot, "inv", 0);

  const result = checkRunnerVersionGate(dataRoot);
  expect(result.ok).toBe(false);
  expect(result.mismatched.map((v) => v.label).sort()).toEqual([
    "apps/inv/app.sqlite",
    "kernel.sqlite",
  ]);

  const { exitCode, stderr } = runGate(dataRoot);
  expect(exitCode).toBe(1);
  expect(stderr).toContain("user_version = 0");
});

test("限定5: 迂回口が1つも無い(--force / 無効化の環境変数を1つも解釈しない)", () => {
  makeKernelDb(dataRoot, 0);
  makeAppDb(dataRoot, "inv", 0);

  // 「それらしい」名前を全部渡しても止まる。
  const result = Bun.spawnSync(["bun", "run", GATE_ENTRY, dataRoot, "--force"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ST_SKIP_VERSION_GATE: "1",
      ST_RUNNER_VERSION_GATE: "off",
      ST_FORCE: "1",
      ST_ALLOW_VERSION_MISMATCH: "true",
    },
  });
  expect(result.exitCode).toBe(1);

  // ソースにも迂回口の語が1つも無い。
  const source = readFileSync(GATE_ENTRY, "utf-8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  for (const word of ["--force", "SKIP", "FORCE", "ALLOW", "IGNORE"]) {
    expect(code.includes(word)).toBe(false);
  }
});

// --- 完了条件(`T04`)1: `kernel.sqlite` と `app.sqlite` が同じ照合関数を通る ---

test("T04 完了条件1: kernel.sqlite だけ版が合わなくても止まる", () => {
  makeKernelDb(dataRoot, RUNNER_BUILD_VERSION + 1);
  makeAppDb(dataRoot, "inv", RUNNER_BUILD_VERSION);

  const result = checkRunnerVersionGate(dataRoot);
  expect(result.ok).toBe(false);
  expect(result.mismatched.map((v) => v.label)).toEqual(["kernel.sqlite"]);
});

test("T04 完了条件1: 照合関数の呼び出し箇所は1つだけである(2つ目の仕組みを作らない)", () => {
  const source = readFileSync(GATE_ENTRY, "utf-8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const calls = [...code.matchAll(/matchesRunnerBuildVersion\(/g)];
  expect(calls.length).toBe(1);
});

// --- `ADR-0251` §1 の (e): 1つの版が全アプリの起動を同時に止める ---------------

test("(e) kernel.sqlite の版が1つ合わないだけで、版の合う全アプリの起動が同時に止まる", () => {
  makeKernelDb(dataRoot, RUNNER_BUILD_VERSION + 1);
  for (const appId of ["alpha", "bravo", "charlie"]) {
    makeAppDb(dataRoot, appId, RUNNER_BUILD_VERSION);
  }

  const result = checkRunnerVersionGate(dataRoot);
  // **合っていないのは kernel.sqlite の1本だけである。**
  expect(result.mismatched.map((v) => v.label)).toEqual(["kernel.sqlite"]);
  expect(result.checked.filter((v) => v.label.startsWith("apps/")).length).toBe(3);
  // **それでもプロセスは止まる = 3アプリすべてが起動しない。**
  expect(result.ok).toBe(false);
  expect(runGate(dataRoot).exitCode).toBe(1);
});

// --- `ADR-0251` 限界2: WAL モードの `kernel.sqlite` での `PRAGMA user_version` ---

test("限界2 の実測: WAL モードの kernel.sqlite でも user_version が保たれる", () => {
  mkdirSync(dataRoot, { recursive: true });
  const path = join(dataRoot, "kernel.sqlite");
  const db = new Database(path, { create: true });
  const mode = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL").get();
  expect(mode?.journal_mode).toBe("wal");

  db.exec(`PRAGMA user_version = ${RUNNER_BUILD_VERSION};`);
  db.exec(`CREATE TABLE "t" ("a" TEXT)`);
  db.query(`INSERT INTO "t" ("a") VALUES (?)`).run("x");
  // WAL に載ったまま(チェックポイント前)読める。
  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(
    RUNNER_BUILD_VERSION,
  );
  db.close();

  // 閉じて開き直しても保たれる。
  const reopened = new Database(path, { readonly: true });
  expect(
    reopened.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
  ).toBe(RUNNER_BUILD_VERSION);
  reopened.close();

  // ゲートも同じ値を読む。
  expect(collectVolumeDbVersions(dataRoot)[0]?.user_version).toBe(RUNNER_BUILD_VERSION);
});

// --- ボリュームの走査そのもの -------------------------------------------------

test("kernel.sqlite が無いボリュームでも app.sqlite だけを見て止まる", () => {
  makeAppDb(dataRoot, "inv", 0);
  const result = checkRunnerVersionGate(dataRoot);
  expect(result.checked.map((v) => v.label)).toEqual(["apps/inv/app.sqlite"]);
  expect(result.ok).toBe(false);
});

test("snapshots/ 配下の app.sqlite は起動の対象ではないので数えない", () => {
  makeKernelDb(dataRoot, RUNNER_BUILD_VERSION);
  makeAppDb(dataRoot, "inv", RUNNER_BUILD_VERSION);
  const snapshotDir = join(dataRoot, "apps", "inv", "snapshots", "0001-d-x");
  mkdirSync(snapshotDir, { recursive: true });
  const db = new Database(join(snapshotDir, "app.sqlite"), { create: true });
  db.exec("PRAGMA user_version = 0;");
  db.close();

  const result = checkRunnerVersionGate(dataRoot);
  expect(result.checked.map((v) => v.label).sort()).toEqual([
    "apps/inv/app.sqlite",
    "kernel.sqlite",
  ]);
  expect(result.ok).toBe(true);
});
