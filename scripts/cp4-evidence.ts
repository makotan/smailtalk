/**
 * CP-4 エビデンス採取スクリプト(docs/evidence/cp-4.md 用)。
 *
 * `src/kernel/cp-4-scenario.test.ts` と**同じ順序**でライフサイクルを1周まわし、
 * テストではアサートするだけで人間には見えない次の3つを、実物として標準出力に出す。
 *
 *   1. changelog の中身(intent が縦に並び、要件定義書として読めるか)
 *   2. previewUndo の中身(undo の前に「何件失われるか」が提示されるか)
 *   3. スナップショットディレクトリの `ls -l`(apply ごとに実在するか)
 *
 * テストの代わりではない。**判定はテストが行い、この出力は読める形で見せるためのもの**である。
 * 一時 dataRoot(`fs.mkdtemp`)を使い、最後に消す。リポジトリの `data/` は触らない。
 *
 * 実行: `mise exec -- bun run scripts/cp4-evidence.ts`
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff } from "../src/kernel/apply-diff.ts";
import { readCurrentManifest } from "../src/kernel/apply-manifest.ts";
import { getChangelog } from "../src/kernel/changelog.ts";
import { createApp } from "../src/kernel/create-app.ts";
import { KernelMetaStore } from "../src/kernel/meta-store.ts";
import { createRecord } from "../src/kernel/records.ts";
import { appDbPath, appSnapshotsDir } from "../src/kernel/storage-paths.ts";
import type { Diff } from "../src/kernel/types.ts";
import { previewUndo, undo } from "../src/kernel/undo.ts";

const APP_ID = "book-tracker";
const APP_NAME = "蔵書管理";

const DIFF_1: Diff = {
  diff_id: "d-001-book-tracker",
  intent:
    "読んだ本を記録して読書状況を管理したい。著者ごとに本をたどれるようにもしたいので、著者は別テーブルにして参照でつなぐ",
  operations: [
    {
      op: "add_table",
      table: {
        id: "authors",
        name: "著者",
        fields: [{ id: "name", name: "氏名", type: "text", required: true }],
      },
    },
    {
      op: "add_table",
      table: {
        id: "books",
        name: "書籍",
        fields: [
          { id: "title", name: "タイトル", type: "text", required: true },
          { id: "status", name: "状態", type: "select", options: ["未読", "読書中", "読了"] },
          { id: "finished_at", name: "読了日", type: "date" },
          { id: "memo", name: "メモ", type: "long_text" },
          { id: "pages", name: "ページ数", type: "number" },
          { id: "owned", name: "所有", type: "boolean" },
          { id: "author", name: "著者", type: "reference", reference_table: "authors" },
        ],
      },
    },
    {
      op: "add_view",
      view: {
        id: "book-list",
        type: "list_view",
        table: "books",
        columns: ["title", "status"],
        sort: { field: "finished_at", order: "desc" },
      },
    },
    {
      op: "add_view",
      view: {
        id: "book-form",
        type: "form",
        table: "books",
        fields: ["title", "status", "finished_at", "memo", "pages", "owned", "author"],
      },
    },
    { op: "add_view", view: { id: "book-detail", type: "detail_view", table: "books" } },
  ],
};

const DIFF_2: Diff = {
  diff_id: "d-002-rating",
  intent: "読んだ本に5段階の評価を付けて、一覧でも評価が見えるようにしたい",
  operations: [
    { op: "add_field", table: "books", field: { id: "rating", name: "評価", type: "number" } },
    { op: "update_view", view: "book-list", changes: { columns: ["title", "status", "rating"] } },
  ],
};

const DIFF_3: Diff = {
  diff_id: "d-003-tags",
  intent: "本をタグで分類して、あとからタグの一覧を見られるようにしたい",
  operations: [
    {
      op: "add_table",
      table: {
        id: "tags",
        name: "タグ",
        fields: [{ id: "label", name: "ラベル", type: "text", required: true }],
      },
    },
    {
      op: "add_view",
      view: { id: "tag-list", type: "list_view", table: "tags", columns: ["label"] },
    },
  ],
};

const dataRoot = mkdtempSync(join(tmpdir(), "gp-cp4-evidence-"));

function apply(diff: Diff): void {
  const result = applyDiff(dataRoot, APP_ID, diff);
  if (!result.valid) {
    throw new Error(`apply に失敗: ${JSON.stringify(result.errors, null, 2)}`);
  }
  console.log(`apply ${diff.diff_id} -> snapshot=${result.snapshot} seq=${result.entry.seq}`);
}

function withDb<T>(fn: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** changelog を「要件定義書として読めるか」が分かる形で縦に並べる。 */
function printChangelog(title: string): void {
  console.log(`\n=== ${title} ===`);
  for (const entry of getChangelog(dataRoot, APP_ID)) {
    const ops = entry.operations.map((op) => op.op).join(", ") || "(なし)";
    console.log(
      `[${String(entry.seq).padStart(2, " ")}] ${entry.kind.padEnd(5, " ")} ${entry.diff_id}`,
    );
    console.log(`     intent   : ${entry.intent}`);
    console.log(`     ops      : ${ops}`);
    console.log(`     applied  : ${entry.applied_at}`);
    console.log(`     snapshot : ${entry.snapshot ?? "(なし)"}`);
    if (entry.undo_target_seq !== null) {
      console.log(`     undo対象 : seq=${entry.undo_target_seq}`);
    }
  }
}

try {
  console.log(`dataRoot = ${dataRoot}\n`);

  // --- ステップ1: create_app → 初期マニフェストを applyDiff で構築 → データ投入 ---
  const store = KernelMetaStore.open(dataRoot);
  createApp(store, APP_NAME, { app_id: APP_ID });
  store.close();
  console.log(`create_app(name="${APP_NAME}") -> app_id=${APP_ID}(マニフェストは空)`);

  apply(DIFF_1);

  const manifestV1 = readCurrentManifest(dataRoot, APP_ID);
  const statuses = ["未読", "読書中", "読了"] as const;
  withDb((db) => {
    const author = createRecord(db, manifestV1, "authors", { name: "夏目 漱石" });
    if (!author.ok) {
      throw new Error("著者の投入に失敗しました。");
    }
    for (let i = 0; i < 5; i++) {
      const created = createRecord(db, manifestV1, "books", {
        title: `蔵書 ${i + 1}`,
        status: statuses[i % 3],
        finished_at: `2026-0${i + 1}-1${i}`,
        memo: `メモ ${i}`,
        pages: i % 2 === 0 ? 100 + i : 12.5 + i,
        owned: i % 2 === 0,
        author: author.value._id,
      });
      if (!created.ok) {
        throw new Error(`書籍 ${i} の投入に失敗しました。`);
      }
    }
  });
  console.log("データ投入: authors 1件 / books 5件");

  // --- ステップ2・3 ---
  apply(DIFF_2);
  apply(DIFF_3);

  printChangelog("ステップ3 時点の changelog(apply 3件)");

  // --- ステップ4: diff#3 の後にデータを足してから previewUndo → undo ---
  const manifestV3 = readCurrentManifest(dataRoot, APP_ID);
  withDb((db) => {
    const tag = createRecord(db, manifestV3, "tags", { label: "名作" });
    const book = createRecord(db, manifestV3, "books", { title: "diff#3 の後で足した本" });
    if (!tag.ok || !book.ok) {
      throw new Error("diff#3 後のデータ投入に失敗しました。");
    }
  });
  console.log("\ndiff#3 の後に追加: tags 1件 / books 1件(合計 books 6件, tags 1件)");

  const preview = previewUndo(dataRoot, APP_ID);
  console.log("\n=== previewUndo の実出力(undo の前に何が失われるか)===");
  console.log(JSON.stringify(preview, null, 2));

  const undone = undo(dataRoot, APP_ID);
  if (!undone.valid) {
    throw new Error(`undo に失敗: ${JSON.stringify(undone.errors, null, 2)}`);
  }
  console.log(
    `\nundo -> restored_from=${undone.restored_from} / 新スナップショット=${undone.snapshot}`,
  );
  console.log(
    `undo 後のテーブル: ${withDb((db) =>
      (
        db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
          name: string;
        }[]
      )
        .map((row) => row.name)
        .join(", "),
    )}`,
  );

  printChangelog("undo 後の changelog(apply 3件 + undo 1件)");

  // --- ステップ5: 破壊的 diff は拒否される ---
  const destructive = [
    {
      diff_id: "d-004-remove",
      intent: "評価は要らなくなったので消したい",
      operations: [{ op: "remove_field", table: "books", field: "rating" }],
    },
    {
      diff_id: "d-005-swap",
      intent: "一覧の列を別の項目に差し替えたい",
      operations: [
        { op: "update_view", view: "book-list", changes: { columns: ["title", "score"] } },
      ],
    },
  ];
  console.log("\n=== 破壊的 diff の拒否(実際のエラー)===");
  for (const diff of destructive) {
    const rejected = applyDiff(dataRoot, APP_ID, diff);
    console.log(`\n--- ${diff.diff_id}: valid=${rejected.valid} ---`);
    if (!rejected.valid) {
      console.log(JSON.stringify(rejected.errors, null, 2));
    }
  }

  console.log("\n=== スナップショットディレクトリ ===");
  console.log(`$ ls -l ${appSnapshotsDir(dataRoot, APP_ID)}`);
  const listing = Bun.spawnSync(["ls", "-lR", appSnapshotsDir(dataRoot, APP_ID)]);
  console.log(new TextDecoder().decode(listing.stdout).trimEnd());
} finally {
  rmSync(dataRoot, { recursive: true, force: true });
}
