/**
 * 配布先のボリュームを移行する器の検査(`V5-M6-T02` = `R-G4` /
 * [`ADR-0252`](../docs/adr/0252-distribution-migrator.md))。
 *
 * ## この検査が固定するもの
 *
 * 1. **印のあるボリュームを移行したあと、`V5-M5` が作った起動ゲート
 *    (`checkRunnerVersionGate`)が通ること。** 加えて **`ST_SERVER_PROFILE=runner` の
 *    実プロセスが実際にリッスンを始めること**(本物の `bun run src/server/index.ts`)。
 * 2. **`operations` が無い経路では破壊的な移行が1件も通らないこと**
 *    (`ADR-0252` §2 が ② を **W-D** と判定した理由の実測)。
 * 3. **`operations` を伴えば破壊的な移行が通ること。**
 * 4. **移行に失敗したら `restoreSnapshot` で巻き戻ること。**
 *    **同じ実行の中で先に成功したアプリも巻き戻すこと**(commit 後の巻き戻し)。
 * 5. **印の無いボリューム(`user_version = 0`)を1バイトも触らずに拒否すること**
 *    (`ADR-0251` 限定6 / §6 の 3)。
 * 6. **【`ADR-0252` 限定3】`checkUniqueBackfillsForMigration`(再実装)が、本体
 *    (`src/kernel/apply-diff.ts` の非 export な `checkUniqueBackfills`)と
 *    **同じ入力に対して同じ判定を返す**こと。** 本体は非 export なので
 *    **`applyDiff` の返り値**を通して比較する(`apply-diff.ts:1720`〜`:1723` は
 *    `checkUniqueBackfills` の返り値をそのまま `errors` として返しており、
 *    ここを通れば本体の出力を逐語で取れる)。
 * 7. **【`ADR-0252` 限定3 の第2の網】本体の関数の本文が1バイトでも変わったら赤くなること。**
 *    振る舞いの比較は「この検査が渡した入力」しか見ないので、**比較していない入力で
 *    分岐が増えたら静かに素通りする。** 本文の sha を基準値として持ち、
 *    **「片方だけ直した」を必ず赤にする。**
 *
 * ## この検査が**固定しないもの**(正直に書く)
 *
 * - **移行器が Runner のイメージに入っていないこと**は固定していない(`ADR-0252` 限定4)。
 *   **イメージが今日存在しない。** **`V5-M7` の否定形の検査に送る**(記録 §7)。
 * - **利用者環境での移行**は1度も測っていない(`D-V5-3` / `01` §7-4)。
 * - **版に順序が無い**ので、「古い版から新しい版へ」だけを通す判定を持っていない
 *   (`ADR-0251` 限定4 は等値だけを許す)。**印が合わないボリュームはすべて対象になる。**
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyDiff, foldOperations } from "../src/kernel/apply-diff.ts";
import { readCurrentManifest } from "../src/kernel/apply-manifest.ts";
import { createApp } from "../src/kernel/create-app.ts";
import { KernelMetaStore } from "../src/kernel/meta-store.ts";
import { planMigration } from "../src/kernel/migrate.ts";
import { appDbPath, appDir, appManifestPath, kernelDbPath } from "../src/kernel/storage-paths.ts";
import type { Manifest, Operation } from "../src/kernel/types.ts";
import { checkRunnerVersionGate } from "../src/server/runner-version-gate.ts";
import { RUNNER_BUILD_VERSION } from "../src/shared/runner-build-version.ts";
import {
  checkUniqueBackfillsForMigration,
  formatMigrationReport,
  MIGRATION_OPERATIONS_FILENAME,
  migrateVolume,
} from "./migrate-volume.ts";

const REPO_ROOT = dirname(import.meta.dir);
const MIGRATOR_ENTRY = join(import.meta.dir, "migrate-volume.ts");

/**
 * 「この Runner のものではない印」。
 *
 * **`RUNNER_BUILD_VERSION` は今日 1 であり、0 は「印が無い」を意味する**
 * (`ADR-0251` 限定6)。**したがって「1 より古くて印のある版」は today 作れない。**
 * **`ADR-0251` 限定4 は照合を等値だけに限っているので、移行器も「古い/新しい」を
 * 判定しない** —— **合わない印はすべて移行対象である。** ここで使う 7 は
 * 「合わない印」の代表であって、「古い版」ではない。
 */
const FOREIGN_VERSION = RUNNER_BUILD_VERSION + 6;

let volumeRoot: string;
let imageRoot: string;

beforeEach(() => {
  volumeRoot = join(mkdtempSync(join(tmpdir(), "gp-m6-vol-")), "data");
  imageRoot = join(mkdtempSync(join(tmpdir(), "gp-m6-img-")), "data");
});

afterEach(() => {
  rmSync(join(volumeRoot, ".."), { recursive: true, force: true });
  rmSync(join(imageRoot, ".."), { recursive: true, force: true });
});

/** 品目テーブルを1本持つアプリを、**本物の `createApp` と `applyDiff`** で作る。 */
function seedApp(root: string, appId: string): void {
  const store = KernelMetaStore.open(root);
  try {
    createApp(store, `${appId} のアプリ`, { app_id: appId });
  } finally {
    store.close();
  }
  const result = applyDiff(root, appId, {
    diff_id: "d-init",
    intent: "品目テーブルを作る",
    operations: [
      {
        op: "add_table",
        table: {
          id: "item",
          name: "品目",
          fields: [
            { id: "name", name: "名前", type: "text" },
            { id: "code", name: "コード", type: "text" },
          ],
        },
      },
    ],
  });
  if (!result.valid) {
    throw new Error(`seedApp が失敗しました: ${JSON.stringify(result.errors)}`);
  }
}

/** `PRAGMA user_version` を書く(**検査のセットアップ専用**。移行器は自分で書く)。 */
function stamp(path: string, version: number): void {
  const db = new Database(path, { readwrite: true, create: false });
  try {
    db.exec(`PRAGMA user_version = ${version};`);
  } finally {
    db.close();
  }
}

/** `PRAGMA user_version` を読む。 */
function userVersionOf(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  } finally {
    db.close();
  }
}

/** ボリューム全体を「この Runner のものではない印」にする。 */
function stampVolume(root: string, version: number, appIds: string[]): void {
  stamp(kernelDbPath(root), version);
  for (const appId of appIds) {
    stamp(appDbPath(root, appId), version);
  }
}

/** 実テーブルの列名を読む。 */
function columnsOf(root: string, appId: string, table: string): string[] {
  const db = new Database(appDbPath(root, appId), { readonly: true });
  try {
    return db
      .query<{ name: string }, []>(`PRAGMA table_info("${table}")`)
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

/** イメージ側に「移行先のマニフェスト」と、任意で `operations` を置く。 */
function putImageTarget(appId: string, manifest: Manifest, operations?: Operation[]): void {
  mkdirSync(appDir(imageRoot, appId), { recursive: true });
  writeFileSync(appManifestPath(imageRoot, appId), `${JSON.stringify(manifest, null, 2)}\n`);
  if (operations !== undefined) {
    writeFileSync(
      join(appDir(imageRoot, appId), MIGRATION_OPERATIONS_FILENAME),
      `${JSON.stringify(operations, null, 2)}\n`,
    );
  }
}

/**
 * ボリュームの現行マニフェストに `operations` を当てた結果を、
 * **本物の `foldOperations`(= `planMigration` の前段)と同じ経路**で作る。
 * 検査が手で組み立てた「次のマニフェスト」とイメージ側の宣言がずれないようにする。
 */
function foldedManifest(root: string, appId: string, operations: Operation[]): Manifest {
  const folded = foldOperations(readCurrentManifest(root, appId), operations);
  if (!folded.valid) {
    throw new Error(`foldedManifest が失敗しました: ${JSON.stringify(folded.errors)}`);
  }
  return folded.manifest;
}

// =============================================================================
// T02 完了条件2: 移行 → 起動ゲート通過 → 実際に起動
// =============================================================================

test("T02 完了条件2: 印の合わないボリュームを移行すると、起動ゲートが通るようになる", () => {
  seedApp(volumeRoot, "inv");
  stampVolume(volumeRoot, FOREIGN_VERSION, ["inv"]);
  expect(checkRunnerVersionGate(volumeRoot).ok).toBe(false);

  const operations: Operation[] = [
    { op: "add_field", table: "item", field: { id: "qty", name: "数量", type: "number" } },
  ];
  putImageTarget("inv", foldedManifest(volumeRoot, "inv", operations), operations);

  const result = migrateVolume({ volumeDataRoot: volumeRoot, imageDataRoot: imageRoot });

  expect(result.ok).toBe(true);
  expect(result.apps.map((app) => app.status)).toEqual(["migrated"]);
  expect(result.kernel.status).toBe("migrated");
  // 版が両方とも書き換わっている。
  expect(userVersionOf(appDbPath(volumeRoot, "inv"))).toBe(RUNNER_BUILD_VERSION);
  expect(userVersionOf(kernelDbPath(volumeRoot))).toBe(RUNNER_BUILD_VERSION);
  // 実スキーマにも列が増えている(印だけ書き換えていない)。
  expect(columnsOf(volumeRoot, "inv", "item")).toContain("qty");
  // マニフェストも新しいものになっている。
  expect(
    readCurrentManifest(volumeRoot, "inv").app.tables[0]?.fields.map((field) => field.id),
  ).toEqual(["name", "code", "qty"]);
  // **`V5-M5` の起動ゲートが通る。**
  expect(checkRunnerVersionGate(volumeRoot).ok).toBe(true);
});

test("T02 完了条件2: 移行したボリュームで ST_SERVER_PROFILE=runner の実プロセスが起動する", async () => {
  seedApp(volumeRoot, "inv");
  stampVolume(volumeRoot, FOREIGN_VERSION, ["inv"]);
  const operations: Operation[] = [
    { op: "add_field", table: "item", field: { id: "qty", name: "数量", type: "number" } },
  ];
  putImageTarget("inv", foldedManifest(volumeRoot, "inv", operations), operations);

  // 移行の前は止まる。
  const before = Bun.spawnSync(["bun", "run", join(REPO_ROOT, "src/server/index.ts")], {
    cwd: REPO_ROOT,
    env: { ...process.env, ST_DATA_ROOT: volumeRoot, PORT: "0", ST_SERVER_PROFILE: "runner" },
  });
  expect(before.exitCode).toBe(1);

  expect(migrateVolume({ volumeDataRoot: volumeRoot, imageDataRoot: imageRoot }).ok).toBe(true);

  // 移行の後はリッスンを始める。
  const after = Bun.spawn(["bun", "run", join(REPO_ROOT, "src/server/index.ts")], {
    cwd: REPO_ROOT,
    env: { ...process.env, ST_DATA_ROOT: volumeRoot, PORT: "0", ST_SERVER_PROFILE: "runner" },
    stdout: "pipe",
    stderr: "pipe",
  });
  let listened = "";
  const reader = after.stdout.getReader();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !listened.includes("smailtalk server:")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    listened += new TextDecoder().decode(chunk.value);
  }
  after.kill();
  await after.exited;
  expect(listened).toContain("smailtalk server:");
});

// =============================================================================
// T02: `operations` の有無で通る移行が変わる(`ADR-0252` §2 の ② が W-D だった理由)
// =============================================================================

test("operations が無い経路では破壊的な移行(フィールド削除)を1件も通さず、1バイトも書かない", () => {
  seedApp(volumeRoot, "inv");
  stampVolume(volumeRoot, FOREIGN_VERSION, ["inv"]);
  const before = readFileSync(appDbPath(volumeRoot, "inv"));

  // `code` を落としたマニフェストだけを置く(`operations` は置かない)。
  const current = readCurrentManifest(volumeRoot, "inv");
  const target: Manifest = structuredClone(current);
  const table = target.app.tables[0];
  if (table === undefined) throw new Error("テーブルが無い");
  table.fields = table.fields.filter((field) => field.id !== "code");
  putImageTarget("inv", target);

  const result = migrateVolume({ volumeDataRoot: volumeRoot, imageDataRoot: imageRoot });

  expect(result.ok).toBe(false);
  expect(result.apps[0]?.status).toBe("failed");
  expect(userVersionOf(appDbPath(volumeRoot, "inv"))).toBe(FOREIGN_VERSION);
  expect(columnsOf(volumeRoot, "inv", "item")).toContain("code");
  expect(readFileSync(appDbPath(volumeRoot, "inv")).equals(before)).toBe(true);
});

test("operations を伴えば破壊的な移行(フィールド削除)が通る", () => {
  seedApp(volumeRoot, "inv");
  stampVolume(volumeRoot, FOREIGN_VERSION, ["inv"]);
  const operations: Operation[] = [{ op: "remove_field", table: "item", field: "code" }];
  putImageTarget("inv", foldedManifest(volumeRoot, "inv", operations), operations);

  const result = migrateVolume({ volumeDataRoot: volumeRoot, imageDataRoot: imageRoot });

  expect(result.ok).toBe(true);
  expect(columnsOf(volumeRoot, "inv", "item")).not.toContain("code");
  expect(userVersionOf(appDbPath(volumeRoot, "inv"))).toBe(RUNNER_BUILD_VERSION);
});

test("operations の畳み込み結果がイメージのマニフェストと一致しなければ拒否する", () => {
  seedApp(volumeRoot, "inv");
  stampVolume(volumeRoot, FOREIGN_VERSION, ["inv"]);
  const operations: Operation[] = [
    { op: "add_field", table: "item", field: { id: "qty", name: "数量", type: "number" } },
  ];
  // マニフェストだけ別のもの(`qty` を含まない現行のまま)を置く。
  putImageTarget("inv", readCurrentManifest(volumeRoot, "inv"), operations);

  const result = migrateVolume({ volumeDataRoot: volumeRoot, imageDataRoot: imageRoot });

  expect(result.ok).toBe(false);
  expect(result.apps[0]?.status).toBe("failed");
  expect(result.apps[0]?.failure).toContain("一致しません");
  expect(columnsOf(volumeRoot, "inv", "item")).not.toContain("qty");
  expect(userVersionOf(appDbPath(volumeRoot, "inv"))).toBe(FOREIGN_VERSION);
});

// =============================================================================
// T02 完了条件3: 失敗したら巻き戻す
// =============================================================================

test("T02 完了条件3: 移行が途中で失敗したら restoreSnapshot で巻き戻る(先に成功したアプリも戻す)", () => {
  seedApp(volumeRoot, "alpha");
  seedApp(volumeRoot, "bravo");
  stampVolume(volumeRoot, FOREIGN_VERSION, ["alpha", "bravo"]);

  const alphaOps: Operation[] = [
    { op: "add_field", table: "item", field: { id: "qty", name: "数量", type: "number" } },
  ];
  putImageTarget("alpha", foldedManifest(volumeRoot, "alpha", alphaOps), alphaOps);

  // `bravo` は **DDL が必ず落ちる**形にする —— マニフェストに無いテーブルが
  // 実DBに既に在るので、`add_table` が `table ghost already exists` で throw する。
  const ghostDb = new Database(appDbPath(volumeRoot, "bravo"), { readwrite: true, create: false });
  try {
    ghostDb.exec(`CREATE TABLE "ghost" ("id" TEXT);`);
  } finally {
    ghostDb.close();
  }
  const bravoOps: Operation[] = [
    {
      op: "add_table",
      table: { id: "ghost", name: "亡霊", fields: [{ id: "id", name: "ID", type: "text" }] },
    },
  ];
  putImageTarget("bravo", foldedManifest(volumeRoot, "bravo", bravoOps), bravoOps);

  const result = migrateVolume({ volumeDataRoot: volumeRoot, imageDataRoot: imageRoot });

  expect(result.ok).toBe(false);
  const alpha = result.apps.find((app) => app.app_id === "alpha");
  const bravo = result.apps.find((app) => app.app_id === "bravo");
  expect(bravo?.status).toBe("failed");
  // **`alpha` は commit まで進んでいたのに、`restoreSnapshot` で戻っている。**
  expect(alpha?.status).toBe("rolled-back");
  expect(columnsOf(volumeRoot, "alpha", "item")).not.toContain("qty");
  expect(
    readCurrentManifest(volumeRoot, "alpha").app.tables[0]?.fields.map((field) => field.id),
  ).toEqual(["name", "code"]);
  // **版は両方とも元のままである**(印だけ進むことがない)。
  expect(userVersionOf(appDbPath(volumeRoot, "alpha"))).toBe(FOREIGN_VERSION);
  expect(userVersionOf(appDbPath(volumeRoot, "bravo"))).toBe(FOREIGN_VERSION);
  // **`kernel.sqlite` の印も進んでいない。**
  expect(userVersionOf(kernelDbPath(volumeRoot))).toBe(FOREIGN_VERSION);
  expect(result.kernel.status).toBe("skipped");
});

// =============================================================================
// T02: 印の無いボリュームを救済しない(`ADR-0251` 限定6)
// =============================================================================

test("印の無いボリューム(user_version = 0)は1バイトも触らずに拒否する", () => {
  seedApp(volumeRoot, "inv");
  stampVolume(volumeRoot, 0, ["inv"]);
  const beforeDb = readFileSync(appDbPath(volumeRoot, "inv"));
  const beforeManifest = readFileSync(appManifestPath(volumeRoot, "inv"));

  const operations: Operation[] = [
    { op: "add_field", table: "item", field: { id: "qty", name: "数量", type: "number" } },
  ];
  putImageTarget("inv", foldedManifest(volumeRoot, "inv", operations), operations);

  const result = migrateVolume({ volumeDataRoot: volumeRoot, imageDataRoot: imageRoot });

  expect(result.ok).toBe(false);
  expect(result.unstamped.sort()).toEqual(["apps/inv/app.sqlite", "kernel.sqlite"]);
  expect(result.apps).toEqual([]);
  expect(readFileSync(appDbPath(volumeRoot, "inv")).equals(beforeDb)).toBe(true);
  expect(readFileSync(appManifestPath(volumeRoot, "inv")).equals(beforeManifest)).toBe(true);
  expect(userVersionOf(appDbPath(volumeRoot, "inv"))).toBe(0);
  // 文面が「救済しない」ことを言っている(打っても直らないコマンドを勧めない)。
  expect(formatMigrationReport(result)).toContain("印の無い");
});

test("版が既に一致しているボリュームは1バイトも書かない", () => {
  seedApp(volumeRoot, "inv");
  // `createApp` / `KernelMetaStore.open` が刻んだままなので既に一致している。
  expect(checkRunnerVersionGate(volumeRoot).ok).toBe(true);
  const beforeDb = readFileSync(appDbPath(volumeRoot, "inv"));

  putImageTarget("inv", readCurrentManifest(volumeRoot, "inv"));
  const result = migrateVolume({ volumeDataRoot: volumeRoot, imageDataRoot: imageRoot });

  expect(result.ok).toBe(true);
  expect(result.apps.map((app) => app.status)).toEqual(["already-current"]);
  expect(result.kernel.status).toBe("already-current");
  expect(readFileSync(appDbPath(volumeRoot, "inv")).equals(beforeDb)).toBe(true);
});

test("イメージ側にマニフェストが無いアプリは移行せず、1バイトも書かない", () => {
  seedApp(volumeRoot, "inv");
  stampVolume(volumeRoot, FOREIGN_VERSION, ["inv"]);
  const beforeDb = readFileSync(appDbPath(volumeRoot, "inv"));

  const result = migrateVolume({ volumeDataRoot: volumeRoot, imageDataRoot: imageRoot });

  expect(result.ok).toBe(false);
  expect(result.apps[0]?.status).toBe("failed");
  expect(result.apps[0]?.failure).toContain("manifest.json");
  expect(readFileSync(appDbPath(volumeRoot, "inv")).equals(beforeDb)).toBe(true);
});

// =============================================================================
// T02: CLI の入口
// =============================================================================

test("CLI: 引数が足りなければ終了コード2、移行できれば0", () => {
  seedApp(volumeRoot, "inv");
  stampVolume(volumeRoot, FOREIGN_VERSION, ["inv"]);
  const operations: Operation[] = [
    { op: "add_field", table: "item", field: { id: "qty", name: "数量", type: "number" } },
  ];
  putImageTarget("inv", foldedManifest(volumeRoot, "inv", operations), operations);

  const usage = Bun.spawnSync(["bun", "run", MIGRATOR_ENTRY], { cwd: REPO_ROOT });
  expect(usage.exitCode).toBe(2);

  const run = Bun.spawnSync(["bun", "run", MIGRATOR_ENTRY, volumeRoot, imageRoot], {
    cwd: REPO_ROOT,
  });
  expect(run.exitCode).toBe(0);
  expect(new TextDecoder().decode(run.stdout)).toContain("移行");
  expect(checkRunnerVersionGate(volumeRoot).ok).toBe(true);
});

// =============================================================================
// 【`ADR-0252` 限定3】再実装が本体と同じ判定を返す
// =============================================================================

/**
 * 本体側(`src/kernel/apply-diff.ts` の非 export な `checkUniqueBackfills`)の出力を
 * **`applyDiff` の返り値として**取り出す。
 *
 * `apply-diff.ts:1719`〜`:1724`(逐語 `const uniqueErrors = checkUniqueBackfills(...)` /
 * `return { valid: false, errors: uniqueErrors };`)により、**後付け unique で落ちたときの
 * `errors` は `checkUniqueBackfills` の返り値そのものである。** 本体を export に変えずに
 * 逐語で比較できる唯一の経路である(`ADR-0252` 限定1)。
 */
function kernelSideUniqueErrors(root: string, appId: string, operations: Operation[]): unknown[] {
  const result = applyDiff(root, appId, {
    diff_id: "d-unique-parity",
    intent: "後付け unique の判定を本体から取り出す",
    operations,
  });
  return result.valid ? [] : result.errors;
}

/** 移行器側の再実装に、本体と同じ `uniqueChecks` を渡す。 */
function migratorSideUniqueErrors(root: string, appId: string, operations: Operation[]): unknown[] {
  const current = readCurrentManifest(root, appId);
  const planned = planMigration(current, current, operations);
  if (!planned.valid) {
    throw new Error(`planMigration が失敗しました: ${JSON.stringify(planned.errors)}`);
  }
  return checkUniqueBackfillsForMigration(root, appId, planned.uniqueChecks ?? []);
}

/** `item` に行を入れる(`st_owner` は任意)。 */
function insertItems(root: string, appId: string, rows: [string, string | null][]): void {
  const db = new Database(appDbPath(root, appId), { readwrite: true, create: false });
  try {
    const now = new Date().toISOString();
    let serial = 0;
    for (const [code, owner] of rows) {
      serial += 1;
      const id = `r-${serial}-${Math.random().toString(36).slice(2, 8)}`;
      if (owner === null) {
        db.run(
          `INSERT INTO "item" ("_id","_created_at","_updated_at","name","code") VALUES (?,?,?,?,?)`,
          [id, now, now, code, code],
        );
      } else {
        db.run(
          `INSERT INTO "item" ("_id","_created_at","_updated_at","name","code","st_owner") VALUES (?,?,?,?,?,?)`,
          [id, now, now, code, code, owner],
        );
      }
    }
  } finally {
    db.close();
  }
}

const uniqueOps: Operation[] = [
  { op: "change_field", table: "item", field: "code", changes: { unique: true } },
];
const ownerUniqueOps: Operation[] = [
  { op: "change_field", table: "item", field: "code", changes: { unique: "owner" } },
];

test("限定3: 重複がある列の後付け unique —— 再実装が本体と同じ ValidationError を返す", () => {
  seedApp(volumeRoot, "inv");
  insertItems(volumeRoot, "inv", [
    ["a", null],
    ["a", null],
    ["b", null],
  ]);

  const migrator = migratorSideUniqueErrors(volumeRoot, "inv", uniqueOps);
  const kernel = kernelSideUniqueErrors(volumeRoot, "inv", uniqueOps);

  expect(migrator.length).toBe(1);
  expect(migrator).toEqual(kernel);
});

test("限定3: 重複が打ち切り件数を超える場合も、再実装が本体と同じ文面を返す", () => {
  seedApp(volumeRoot, "inv");
  const rows: [string, string | null][] = [];
  for (let i = 0; i < 9; i += 1) {
    rows.push([`code-${i}`, null], [`code-${i}`, null]);
  }
  insertItems(volumeRoot, "inv", rows);

  const migrator = migratorSideUniqueErrors(volumeRoot, "inv", uniqueOps);
  const kernel = kernelSideUniqueErrors(volumeRoot, "inv", uniqueOps);

  expect(JSON.stringify(migrator)).toContain("ほか");
  expect(migrator).toEqual(kernel);
});

test("限定3: 重複が無ければ、再実装も本体も0件を返す", () => {
  seedApp(volumeRoot, "inv");
  insertItems(volumeRoot, "inv", [
    ["a", null],
    ["b", null],
  ]);

  expect(migratorSideUniqueErrors(volumeRoot, "inv", uniqueOps)).toEqual([]);
  expect(kernelSideUniqueErrors(volumeRoot, "inv", uniqueOps)).toEqual([]);
});

test("限定3: NULL は重複に数えない —— 再実装も本体も0件を返す", () => {
  seedApp(volumeRoot, "inv");
  const db = new Database(appDbPath(volumeRoot, "inv"), { readwrite: true, create: false });
  try {
    const now = new Date().toISOString();
    for (let i = 0; i < 3; i += 1) {
      db.run(`INSERT INTO "item" ("_id","_created_at","_updated_at","name") VALUES (?,?,?,?)`, [
        `r-null-${i}`,
        now,
        now,
        "名",
      ]);
    }
  } finally {
    db.close();
  }

  expect(migratorSideUniqueErrors(volumeRoot, "inv", uniqueOps)).toEqual([]);
  expect(kernelSideUniqueErrors(volumeRoot, "inv", uniqueOps)).toEqual([]);
});

test("限定3: 持ち主スコープ付き unique —— 再実装が本体と同じ判定を返す(持ち主が違えば重複でない)", () => {
  // **アプリを2本に分ける。** `kernelSideUniqueErrors` は `applyDiff` を通すので、
  // **通ってしまった側はマニフェストを実際に書き換える**(`unique` が既に `"owner"` に
  // なり、次に同じ op を渡しても `false → true` の遷移が起きない)。
  // 同じアプリで「重複なし」と「重複あり」を続けて測ると、2回目が空振りする。
  for (const appId of ["own-ok", "own-dup"]) {
    seedApp(volumeRoot, appId);
    // 予約規約フィールド `st_owner` を実テーブルに足す(`ADR-0078` の規約列)。
    const db = new Database(appDbPath(volumeRoot, appId), { readwrite: true, create: false });
    try {
      db.exec(`ALTER TABLE "item" ADD COLUMN "st_owner" TEXT;`);
    } finally {
      db.close();
    }
  }
  // 持ち主が違う同値 → 重複ではない。
  insertItems(volumeRoot, "own-ok", [
    ["a", "u1"],
    ["a", "u2"],
  ]);
  expect(migratorSideUniqueErrors(volumeRoot, "own-ok", ownerUniqueOps)).toEqual([]);
  expect(kernelSideUniqueErrors(volumeRoot, "own-ok", ownerUniqueOps)).toEqual([]);

  // 同じ持ち主の同値 → 重複である。
  insertItems(volumeRoot, "own-dup", [
    ["a", "u1"],
    ["a", "u1"],
    ["a", "u2"],
  ]);
  const migrator = migratorSideUniqueErrors(volumeRoot, "own-dup", ownerUniqueOps);
  const kernel = kernelSideUniqueErrors(volumeRoot, "own-dup", ownerUniqueOps);
  expect(migrator.length).toBe(1);
  expect(migrator).toEqual(kernel);
});

test("限定3: app.sqlite が無いアプリでは、再実装が0件を返す(本体と同じ早期 return)", () => {
  // 本体はこの経路を `applyDiff` からは踏めない(`readCurrentManifest` が先に落ちる)。
  // **したがってここは振る舞いの比較ではなく、再実装単体の固定である。**
  expect(checkUniqueBackfillsForMigration(volumeRoot, "missing", [])).toEqual([]);
});

// =============================================================================
// 【`ADR-0252` 限定3 の第2の網】本体の本文が変わったら赤くなる
// =============================================================================

test("限定3: 本体 checkUniqueBackfills の本文が変わったら赤くなる(基準値の sha)", () => {
  const source = readFileSync(join(REPO_ROOT, "src/kernel/apply-diff.ts"), "utf-8");
  const start = source.indexOf("function checkUniqueBackfills(");
  expect(start).toBeGreaterThan(0);
  // 関数の閉じ括弧(桁0の `}`)までを本文とする。
  const end = source.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  const body = source.slice(start, end + 2);
  const digest = createHash("sha256").update(body).digest("hex").slice(0, 16);

  // **基準値。本体を1バイトでも直したらここが赤くなる。**
  // **赤くなったら、`scripts/migrate-volume.ts` の再実装を同じ内容に直してから
  //   この値を更新すること**(`ADR-0252` 限定3。「片方だけ直した」を静かに通さない)。
  expect(digest).toBe("114e8a7eed8ede91");

  // 併せて、依存している2つの規約(スコープ列名と打ち切り件数)も本体から読めることを固定する。
  expect(source).toContain('const OWNER_SCOPE_COLUMN = "st_owner";');
});
