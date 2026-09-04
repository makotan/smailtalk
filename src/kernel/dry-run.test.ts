/**
 * ドライラン機構(V1-M1-T02)のテスト。
 *
 * このファイルが固定するのは2つの外形的性質である。計画書 §V1-M1-T02 の完了条件
 * そのものであり、どちらも「例外が飛ばなかった」を証明にしない。
 *
 * ## 1. 本体不変(証明の水準は `destructive-rejection.test.ts` に揃える)
 *
 * 詳細化 §2-2 が「本体不変の証明の水準を既存テストに合わせる」と要求している。
 * `destructive-rejection.test.ts` の `observe()` が採っている **4+1点の外形的比較**
 *
 *   マニフェスト(バイト列)/ SQLite の実スキーマ / データ / changelog /
 *   スナップショットディレクトリが1つも作られていない
 *
 * を、ドライランの前後でそのまま使う。加えてドライランは**成功ケースでも**本体を
 * 変えてはならないので、拒否ケース(あちらの主張)より要求が強い。
 *
 * ## 2. レポートと実適用結果の一致
 *
 * ドライランを実行 → **同じ差分**を本当に `applyDiff` → 実適用後の状態を同じ手口で
 * 観測し、レポートと突き合わせる。突き合わせるのは
 *
 *   適用後マニフェスト / 適用後の実 SQLite スキーマ / 影響行数 / MigrationPlan
 *
 * の4点であり、拒否ケースでは `errors` が実適用の拒否と**同一**であることを見る。
 *
 * ## T03 との線引き(記録 §1-3)
 *
 * **T02 は語彙を実装しない。** ADR-0010 が定義した破壊的 4 op の適用エンジンは T03 である。
 * したがってここに `remove_field` / `change_field` を使ったケースは1つも無い。
 * 機構の正しさは既存の additive 4 op で実証できる ―― ドライランは「本体ではない場所で
 * `applyDiff` そのものを走らせる」機構であり、`applyDiff` が何 op を解するかに依存しない。
 *
 * **変換不能値の一覧は `valid: false` の `errors` で運ばれる**(ADR-0010 §7 失敗4 が
 * 「`ValidationError[]`。該当行の `_id` と実際の値を最大N件返す」と定めた経路)。
 * T02 はその経路が実適用と一字一句同じものを返すことを、**既存の additive な拒否**
 * (存在しないテーブルへの add_field / 参照整合性違反)で固定する。**実際の変換不能値を
 * 使った実証は T03 の責任である**(そのケースを作る op がまだ無い)。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff } from "./apply-diff.ts";
import { applyManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { DRY_RUN_NOTE, dryRunDiff } from "./dry-run.ts";
import { type ChangelogEntry, KernelMetaStore } from "./meta-store.ts";
import { createRecord, listRecords, type RecordRow } from "./records.ts";
import { appDbPath, appManifestPath, appSnapshotsDir } from "./storage-paths.ts";
import type { Manifest } from "./types.ts";

const APP_ID = "book-tracker";

let dataRoot: string;
let store: KernelMetaStore;

/** 蔵書管理アプリの初期マニフェスト(`destructive-rejection.test.ts` と同じ土台)。 */
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
            { id: "status", name: "状態", type: "select", options: ["未読", "読了"] },
          ],
        },
      ],
      views: [
        {
          id: "book-list",
          type: "list_view",
          table: "books",
          columns: ["title", "memo", "status"],
        },
        { id: "book-form", type: "form", table: "books", fields: ["title", "memo", "status"] },
      ],
    },
  };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-dry-run-test-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "蔵書管理", { app_id: APP_ID });
  const applied = applyManifest(dataRoot, APP_ID, baseManifest());
  if (!applied.valid) {
    throw new Error("テスト前提の初期マニフェスト投入に失敗しました。");
  }
  // 「影響行数」と「データが無傷」を意味のあるアサートにするため、実データを入れておく。
  seedBook({ title: "銀河ヒッチハイク・ガイド", memo: "42", status: "読了" });
  seedBook({ title: "存在の耐えられない軽さ", memo: "", status: "未読" });
  seedBook({ title: "オリエント急行の殺人", memo: "再読", status: "読了" });
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

// --- 観測(`destructive-rejection.test.ts` の observe() と同じ4+1点)-------------------

function readManifestFile(): Manifest {
  return JSON.parse(readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8")) as Manifest;
}

/** manifest.json のバイト列(整形の揺れも含めて比較する)。 */
function readManifestText(): string {
  return readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8");
}

function withDb<T>(fn: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** app.sqlite の実スキーマ(テーブル→列名の並び)を PRAGMA で読む。 */
function readSchema(): Record<string, string[]> {
  return withDb((db) => {
    const tables = db
      .query<{ name: string }, []>(
        `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%' ORDER BY "name"`,
      )
      .all()
      .map((row) => row.name);
    const schema: Record<string, string[]> = {};
    for (const table of tables) {
      schema[table] = db
        .query<{ name: string }, []>(`PRAGMA table_info("${table}")`)
        .all()
        .map((row) => row.name);
    }
    return schema;
  });
}

function seedBook(input: Record<string, unknown>): RecordRow {
  return withDb((db) => {
    const result = createRecord(db, readManifestFile(), "books", input);
    if (!result.ok) {
      throw new Error(`テスト前提のレコード投入に失敗しました: ${JSON.stringify(result.errors)}`);
    }
    return result.value;
  });
}

function allBooks(): RecordRow[] {
  return withDb((db) => {
    const result = listRecords(db, readManifestFile(), "books");
    if (!result.ok) {
      throw new Error(`レコード一覧に失敗しました: ${JSON.stringify(result.errors)}`);
    }
    return [...result.value].sort((a, b) => a._id.localeCompare(b._id));
  });
}

function readChangelog(): ChangelogEntry[] {
  const reader = KernelMetaStore.open(dataRoot);
  try {
    return reader.listChangelog(APP_ID);
  } finally {
    reader.close();
  }
}

function listSnapshotDirs(): string[] {
  const dir = appSnapshotsDir(dataRoot, APP_ID);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

type ObservedState = {
  manifestText: string;
  schema: Record<string, string[]>;
  records: RecordRow[];
  changelog: ChangelogEntry[];
  snapshots: string[];
};

function observe(): ObservedState {
  return {
    manifestText: readManifestText(),
    schema: readSchema(),
    records: allBooks(),
    changelog: readChangelog(),
    snapshots: listSnapshotDirs(),
  };
}

/** データルート配下の全ファイルの相対パス一覧(作業領域の漏れ出しを検出する)。 */
function listAllFiles(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listAllFiles(join(dir, entry.name), rel));
    } else {
      files.push(rel);
    }
  }
  return files.sort();
}

// --- 差分 -----------------------------------------------------------------------

/** additive な差分(テーブル1つ追加 + 既存テーブルへ列1つ追加 + ビュー更新)。 */
function additiveDiff(diffId = "d-dry-run"): unknown {
  return {
    diff_id: diffId,
    intent: "貸出記録を管理したい。あと本にISBNを持たせたい",
    operations: [
      {
        op: "add_table",
        table: {
          id: "loans",
          name: "貸出",
          fields: [
            { id: "borrower", name: "借りた人", type: "text", required: true },
            { id: "due", name: "返却期限", type: "date" },
          ],
        },
      },
      {
        op: "add_field",
        table: "books",
        field: { id: "isbn", name: "ISBN", type: "text" },
      },
      {
        op: "add_view",
        view: { id: "loan-list", type: "list_view", table: "loans", columns: ["borrower", "due"] },
      },
      {
        op: "update_view",
        view: "book-list",
        changes: { columns: ["title", "isbn", "status"] },
      },
    ],
  };
}

// --- 1. 本体不変 ------------------------------------------------------------------

describe("ドライランは本体を1バイトも変えない(完了条件の前半)", () => {
  test("成功するドライランの前後で、マニフェスト・実スキーマ・データ・changelog・スナップショットがすべて不変", () => {
    const before = observe();
    expect(before.snapshots).toEqual([]);

    const result = dryRunDiff(dataRoot, APP_ID, additiveDiff());
    expect(result.valid).toBe(true);

    const after = observe();
    // `destructive-rejection.test.ts` と同じ4+1点。強度を落とさない。
    expect(after.manifestText).toBe(before.manifestText);
    expect(after.schema).toEqual(before.schema);
    expect(after.records).toEqual(before.records);
    expect(after.changelog).toEqual(before.changelog);
    expect(after.snapshots).toEqual([]);
  });

  test("拒否されるドライランでも同じ4+1点が不変", () => {
    const before = observe();

    const result = dryRunDiff(dataRoot, APP_ID, {
      diff_id: "d-broken",
      intent: "存在しないテーブルに列を足そうとする",
      operations: [
        { op: "add_field", table: "ghosts", field: { id: "x", name: "X", type: "text" } },
      ],
    });
    expect(result.valid).toBe(false);

    const after = observe();
    expect(after.manifestText).toBe(before.manifestText);
    expect(after.schema).toEqual(before.schema);
    expect(after.records).toEqual(before.records);
    expect(after.changelog).toEqual(before.changelog);
    expect(after.snapshots).toEqual([]);
  });

  test("データルート配下にファイルが1つも増減しない(作業領域が dataRoot の外にある証明)", () => {
    const before = listAllFiles(dataRoot);
    dryRunDiff(dataRoot, APP_ID, additiveDiff());
    expect(listAllFiles(dataRoot)).toEqual(before);
  });

  test("ドライランを10回繰り返してもスナップショットの連番を1つも消費しない", () => {
    for (let i = 0; i < 10; i += 1) {
      expect(dryRunDiff(dataRoot, APP_ID, additiveDiff(`d-repeat-${i}`)).valid).toBe(true);
    }
    expect(listSnapshotDirs()).toEqual([]);

    // 連番が汚れていないことを、実適用が 0001 を取ることで示す。
    const applied = applyDiff(dataRoot, APP_ID, additiveDiff("d-after-dry-runs"));
    expect(applied.valid).toBe(true);
    if (!applied.valid) return;
    expect(applied.snapshot).toBe("0001-d-after-dry-runs");
  });

  test("同じ差分をドライラン→実適用できる(ドライランが diff_id を消費しない)", () => {
    const dry = dryRunDiff(dataRoot, APP_ID, additiveDiff());
    expect(dry.valid).toBe(true);

    const applied = applyDiff(dataRoot, APP_ID, additiveDiff());
    expect(applied.valid).toBe(true);
  });
});

// --- 2. レポートと実適用結果の一致 ---------------------------------------------------

describe("レポートは実際の適用結果と一致する(完了条件の後半)", () => {
  test("適用後マニフェスト・実スキーマ・MigrationPlan が実適用の結果と一致する", () => {
    const dry = dryRunDiff(dataRoot, APP_ID, additiveDiff());
    expect(dry.valid).toBe(true);
    if (!dry.valid) return;

    const applied = applyDiff(dataRoot, APP_ID, additiveDiff());
    expect(applied.valid).toBe(true);
    if (!applied.valid) return;

    // 適用後マニフェスト: 実適用の返り値とも、ディスク上の manifest.json とも一致する。
    expect(dry.report.manifest).toEqual(applied.manifest);
    expect(dry.report.manifest).toEqual(readManifestFile());
    // 適用後の実 SQLite スキーマ(マニフェストではなく PRAGMA が返す実体)。
    expect(dry.report.schema).toEqual(readSchema());
    // マイグレーション計画。
    expect(dry.report.plan).toEqual(applied.plan);
  });

  test("影響行数が実適用で実際に変化した行の数と一致する", () => {
    const dry = dryRunDiff(dataRoot, APP_ID, additiveDiff());
    expect(dry.valid).toBe(true);
    if (!dry.valid) return;

    const impacts = Object.fromEntries(dry.report.impacts.map((i) => [i.table, i]));

    // books: 既存3行に列 isbn が生える。影響行数は3。
    expect(impacts.books).toEqual({
      table: "books",
      rows_before: 3,
      rows_after: 3,
      added_columns: ["isbn"],
      removed_columns: [],
      affected_rows: 3,
    });
    // loans: 新規テーブル。適用前は存在しないので影響行数は0。
    expect(impacts.loans).toEqual({
      table: "loans",
      rows_before: null,
      rows_after: 0,
      added_columns: ["_id", "_created_at", "_updated_at", "borrower", "due"],
      removed_columns: [],
      affected_rows: 0,
    });

    // 実適用して、報告した数が実測と合うことを確かめる。
    expect(applyDiff(dataRoot, APP_ID, additiveDiff()).valid).toBe(true);
    const schema = readSchema();
    expect(schema.books).toContain("isbn");
    expect(allBooks().length).toBe(3);
    expect(Object.keys(schema).sort()).toContain("loans");
  });

  test("ビューだけを変える差分では影響行数が0になる", () => {
    const viewOnly = {
      diff_id: "d-view-only",
      intent: "一覧からメモを外したい",
      operations: [{ op: "update_view", view: "book-list", changes: { columns: ["title"] } }],
    };
    const dry = dryRunDiff(dataRoot, APP_ID, viewOnly);
    expect(dry.valid).toBe(true);
    if (!dry.valid) return;

    expect(dry.report.impacts.every((i) => i.affected_rows === 0)).toBe(true);
    expect(dry.report.impacts.every((i) => i.added_columns.length === 0)).toBe(true);
  });

  test("拒否の errors が実適用の拒否と完全に一致する(変換不能値が載る経路)", () => {
    // ADR-0010 §7 失敗4 は、変換不能値をこの errors 経路で返すと定めている。
    // T02 の時点で作れる拒否(存在しないテーブル / 参照整合性違反)で、
    // ドライランの拒否が実適用の拒否と一字一句同じであることを固定する。
    const cases: unknown[] = [
      {
        diff_id: "d-missing-table",
        intent: "存在しないテーブルに列を足す",
        operations: [
          { op: "add_field", table: "ghosts", field: { id: "x", name: "X", type: "text" } },
        ],
      },
      {
        diff_id: "d-dangling-ref",
        intent: "存在しない列を一覧に出す",
        operations: [
          { op: "update_view", view: "book-list", changes: { columns: ["title", "ghost"] } },
        ],
      },
      {
        diff_id: "d-bad-op",
        intent: "語彙に無い op を送る",
        operations: [{ op: "remove_field", table: "books", field: "memo" }],
      },
    ];

    for (const diff of cases) {
      const dry = dryRunDiff(dataRoot, APP_ID, diff);
      const applied = applyDiff(dataRoot, APP_ID, diff);
      expect(dry.valid).toBe(false);
      expect(applied.valid).toBe(false);
      if (dry.valid || applied.valid) continue;
      expect(dry.errors).toEqual(applied.errors);
    }
  });

  test("diff_id の重複もドライランで再現する(changelog を複製しているため)", () => {
    expect(applyDiff(dataRoot, APP_ID, additiveDiff("d-once")).valid).toBe(true);

    // 同じ diff_id をもう一度。実適用は履歴重複で拒否する。ドライランも同じ拒否を返す。
    const second = {
      diff_id: "d-once",
      intent: "同じ diff_id を使い回す",
      operations: [{ op: "update_view", view: "book-list", changes: { columns: ["title"] } }],
    };
    const dry = dryRunDiff(dataRoot, APP_ID, second);
    const applied = applyDiff(dataRoot, APP_ID, second);
    expect(dry.valid).toBe(false);
    expect(applied.valid).toBe(false);
    if (dry.valid || applied.valid) return;
    expect(dry.errors).toEqual(applied.errors);
  });
});

// --- 3. 注記 ---------------------------------------------------------------------

describe("レポートは自分の限界を隠さない(憲法6)", () => {
  test("レポートに DRY_RUN_NOTE が必ず入る", () => {
    const dry = dryRunDiff(dataRoot, APP_ID, additiveDiff());
    expect(dry.valid).toBe(true);
    if (!dry.valid) return;
    expect(dry.report.note).toBe(DRY_RUN_NOTE);
  });

  test("DRY_RUN_NOTE は「ドライランの成功が適用の成功を保証しない」ことを述べている", () => {
    // 文言そのものではなく、述べている内容の骨を固定する。
    expect(DRY_RUN_NOTE).toContain("保証");
    expect(DRY_RUN_NOTE.length).toBeGreaterThan(30);
  });
});
