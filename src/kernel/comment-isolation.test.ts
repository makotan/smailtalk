/**
 * コメントの器が**アプリの定義とデータから切れている**ことの見張り
 * (`V10-M10-T03` / `CM-G3` / `ADR-0366` / `ADR-0373`)。
 *
 * 起票(`docs/plan/v10/records/v10-m9.md:8920`)の完了条件のうち **(2)(3)(4)** をここに置く。
 * **(1)(`schemas/` のドリフト)は `scripts/schemas-drift.test.ts`、
 * (5)(日次バックアップ)は `src/server/comment-backup-inclusion.test.ts` に在る** ——
 * (5) は `src/server/backup.ts` を呼ぶので、カーネル層のこのファイルには置けない。
 *
 * ## 道具ではなく関数を直に呼んでいる(先に断る)
 *
 * 起票の逐語は `undo` / `generate_requirements_doc` という **MCP の道具名**で書かれているが、
 * **本ファイルは MCP の道具を1本も経由していない** —— 呼んでいるのは `undo(dataRoot, appId)` と
 * `generateRequirementsDoc(dataRoot, appId)` というカーネルの関数である。
 * **HTTP の口も MCP の道具も1本も通っていない。**
 *
 * ## `(ci1)` は既存の式の**7箇所目**である(重複を隠さない)
 *
 * 着手前、`SYSTEM_TABLES` が3本であることは **5ファイル・6箇所**で既に逐語で固定されている
 * (`src/shared/system-tables.test.ts:12` / `src/kernel/system-tables-guarantees.test.ts:462` /
 *  `src/auth/invitations.test.ts:208`,`:209` /
 *  `src/server/report-declaration-boundary.test.ts:862` /
 *  `src/kernel/workflow-scheduler.test.ts:1397`)。
 * **`(ci1)` の名前の一覧はその7箇所目であり、新設ではない。**
 * **本当に新しいのは `isSystemTableId("gp_comments") === false` の1行だけである** ——
 * この式は着手前、リポジトリ全体に **0件** であった。
 * **【禁止】`(ci1)` を「(2) の見張りを新設した」と書かない。**
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSystemTableId, SYSTEM_TABLE_IDS, SYSTEM_TABLES } from "../shared/system-tables.ts";
import { applyDiff } from "./apply-diff.ts";
import { applyManifest } from "./apply-manifest.ts";
import { COMMENT_ANCHOR_FORMS, CommentStore } from "./comment-store.ts";
import { createApp } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { generateRequirementsDoc } from "./requirements-doc.ts";
import { appManifestPath, kernelDbPath } from "./storage-paths.ts";
import type { Diff, Manifest } from "./types.ts";
import { undo } from "./undo.ts";

const APP_ID = "book-tracker";

let dataRoot: string;
let store: KernelMetaStore;

/** 蔵書管理アプリの初期マニフェスト(`src/kernel/undo.test.ts` の `baseManifest()` と同型)。 */
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
          ],
        },
      ],
      views: [
        { id: "book-list", type: "list_view", table: "books", columns: ["title"] },
        { id: "book-form", type: "form", table: "books", fields: ["title", "memo"] },
      ],
    },
  };
}

function addFieldDiff(diffId: string, fieldId: string): Diff {
  return {
    diff_id: diffId,
    intent: `${fieldId} を記録したい`,
    operations: [
      { op: "add_field", table: "books", field: { id: fieldId, name: fieldId, type: "text" } },
    ],
  };
}

function apply(diff: Diff): void {
  const result = applyDiff(dataRoot, APP_ID, diff);
  if (!result.valid) {
    throw new Error(`テスト前提の apply に失敗しました: ${JSON.stringify(result.errors)}`);
  }
}

function readManifestFile(): Manifest {
  return JSON.parse(readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8")) as Manifest;
}

function fieldIdsOfBooks(): string[] {
  const table = readManifestFile().app.tables.find((entry) => entry.id === "books");
  return (table?.fields ?? []).map((field) => field.id);
}

/** コメントの器を開いて1つ仕事をし、必ず閉じる。 */
function withComments<T>(fn: (comments: CommentStore) => T): T {
  const comments = CommentStore.openForKernel(dataRoot);
  try {
    return fn(comments);
  } finally {
    comments.close();
  }
}

/**
 * `gp_comments` の**全行・全列**を、器の API を1つも通さずに読み出す。
 *
 * **突き合わせを「件数」ではなく「全行の dump」でやる** —— 件数だけを見ると、
 * 1件消えて1件増えた入れ替わりを素通りさせる。列も並びも固定する。
 */
type CommentDumpRow = {
  id: string;
  app_id: string;
  anchor_form: string;
  anchor_1: string | null;
  anchor_2: string | null;
  body: string;
  created_at: string;
};

function dumpComments(): CommentDumpRow[] {
  const db = new Database(kernelDbPath(dataRoot), { readwrite: true, create: false });
  try {
    return db
      .query<CommentDumpRow, []>(
        `SELECT "id", "app_id", "anchor_form", "anchor_1", "anchor_2", "body", "created_at"
         FROM "gp_comments" ORDER BY "id" ASC`,
      )
      .all();
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-comment-isolation-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "蔵書管理", { app_id: APP_ID });
  const applied = applyManifest(dataRoot, APP_ID, baseManifest());
  if (!applied.valid) {
    throw new Error("テスト前提の初期マニフェスト投入に失敗しました。");
  }
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

// --- (2) SYSTEM_TABLES ------------------------------------------------------------

test("(ci1) SYSTEM_TABLES は今日も _apps / _changelog / _ai_usage の3本ちょうどで、gp_comments はその1本でもない(陽性対照: _changelog は true)", () => {
  // **名前の一覧で固定する**(件数のリテラルを書かない —— 本数はこの一覧から導く)。
  // **この式は既存6箇所と逐語で同じであり、7箇所目の重複である**(冒頭の doc 参照)。
  expect(SYSTEM_TABLES.map((table) => table.id)).toEqual(["_apps", "_changelog", "_ai_usage"]);
  // 判定の出所が2つに割れていないこと(`SYSTEM_TABLE_IDS` は `SYSTEM_TABLES` から導かれる)。
  expect([...SYSTEM_TABLE_IDS]).toEqual(SYSTEM_TABLES.map((table) => table.id));

  // **ここからが着手前 0件 だった式である。** `gp_comments` は `kernel.sqlite` の表であって、
  // ユーザランドのシステムテーブルではない(`ADR-0366` `CM-G3` 限定2 = `ADR-0366:141`)。
  expect(isSystemTableId("gp_comments")).toBe(false);
  // **陽性対照** —— 判定関数そのものが常に false を返しているのではない。
  expect(isSystemTableId("_changelog")).toBe(true);

  // 器の表の名前が、システムテーブルの一覧に**綴りとしても**入っていない。
  expect(SYSTEM_TABLES.map((table) => table.id)).not.toContain("gp_comments");
});

// --- (3) undo ---------------------------------------------------------------------

test("(ci2) undo を実際に走らせても、コメントは1件も巻き戻らない", () => {
  apply(addFieldDiff("d-001", "finished_at"));
  expect(fieldIdsOfBooks()).toContain("finished_at");

  const written = withComments((comments) => [
    comments.addComment({
      appId: APP_ID,
      anchorForm: "view",
      anchorParts: ["book-list"],
      body: "一覧の並び順が分かりにくい",
    }),
    comments.addComment({
      appId: APP_ID,
      anchorForm: "view_field",
      anchorParts: ["book-form", "memo"],
      body: "メモ欄が狭い",
    }),
  ]);

  const result = undo(dataRoot, APP_ID);
  expect(result.valid).toBe(true);

  // **陽性対照** —— 同じ `undo` でマニフェストは実際に巻き戻っている。
  // ここが緑にならないなら、下の「コメントが残っている」は
  // 「そもそも undo が何もしなかった」の言い換えにすぎない。
  expect(fieldIdsOfBooks()).not.toContain("finished_at");

  // **`id` で並べ直してから比べる。** `listComments` は `created_at` 昇順・同時刻は `id` 昇順で
  // 返すが、**2件が同じミリ秒に書かれるとランダムな UUID の順になる** ——
  // 挿入順を期待値にすると、この検査は**書いた順に依存して不安定になる**
  // (実測: 同じ木で3回中3回、順序だけが入れ替わって赤くなった)。
  // **測りたいのは順序ではなく「1件も消えていないこと」である。**
  const byId = (rows: { id: string }[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
  const after = withComments((comments) => comments.listComments(APP_ID));
  expect(byId(after)).toEqual(byId(written));
});

test("(ci3) undo の前後で gp_comments の全行 dump が1バイトも変わらない(陽性対照: 1行 UPDATE すれば変わる)", () => {
  // **`kernel.sqlite` の sha256 は undo で変わる** —— changelog に undo のエントリが
  // 追記されるからである。**したがって固定するのは器の表の全行 dump である。**
  apply(addFieldDiff("d-002", "isbn"));
  withComments((comments) => {
    comments.addComment({
      appId: APP_ID,
      anchorForm: "app",
      anchorParts: [],
      body: "アプリ全体の感想",
    });
    comments.addComment({
      appId: APP_ID,
      anchorForm: "view_after_delete",
      anchorParts: ["book-list"],
      body: "消したあとの行き先が分からない",
    });
  });

  const before = dumpComments();
  expect(before).not.toEqual([]);

  const result = undo(dataRoot, APP_ID);
  expect(result.valid).toBe(true);
  expect(fieldIdsOfBooks()).not.toContain("isbn");

  expect(dumpComments()).toEqual(before);

  // **陽性対照** —— dump が何を変えても同じ値を返す壊れ方をしていない。
  const db = new Database(kernelDbPath(dataRoot), { readwrite: true, create: false });
  try {
    db.query(`UPDATE "gp_comments" SET "body" = ? WHERE "anchor_form" = ?`).run(
      "書き換えた",
      "app",
    );
  } finally {
    db.close();
  }
  expect(dumpComments()).not.toEqual(before);
});

// --- (4) 要件ドキュメント -----------------------------------------------------------

test("(ci4) generate_requirements_doc の文の本数は、11形すべてにコメントを書いても1文も変わらない", () => {
  // **【この見張りは今日どんな変更でも赤くならない】**
  // `generateRequirementsDoc` はマニフェストを読み、`CommentStore` は `kernel.sqlite` に
  // 書く。**両者を結ぶ線が1本も無い**(`ADR-0366` の限界3 が「コメントは要件ドキュメントに
  // 1文も現れない」と書いている)。**したがってこの検査は、線が1本引かれた日に初めて
  // 意味を持つ。** それまでは「引かれていないこと」の記録である。
  const before = generateRequirementsDoc(dataRoot, APP_ID);

  // **11形すべてに1件ずつ書く。** 部品は形の定義の長さぶんだけ埋める(器は中身を見ない)。
  withComments((comments) => {
    for (const entry of COMMENT_ANCHOR_FORMS) {
      comments.addComment({
        appId: APP_ID,
        anchorForm: entry.form,
        anchorParts: entry.parts.map((part) => `${part}-値`),
        body: `${entry.form} への意見`,
      });
    }
  });
  const writtenCount = withComments((comments) => comments.listComments(APP_ID).length);
  // 実際に書けていること(0件に対して「変わらない」を確かめる空回りをしない)。
  expect(writtenCount).toBe(COMMENT_ANCHOR_FORMS.length);

  const after = generateRequirementsDoc(dataRoot, APP_ID);
  expect(after.statements.length).toBe(before.statements.length);
  expect(after.markdown).toBe(before.markdown);

  // **陽性対照** —— 文の本数はそもそも動くものである。定義を1本足せば増える。
  apply(addFieldDiff("d-003", "publisher"));
  const afterDiff = generateRequirementsDoc(dataRoot, APP_ID);
  expect(afterDiff.statements.length).toBeGreaterThan(before.statements.length);
});
