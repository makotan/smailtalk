/**
 * 日次バックアップの世代に**コメントが入る**ことの実測
 * (`V10-M10-T03` の完了条件 (5) / `CM-G3` / `ADR-0366`)。
 *
 * ## この検査が主張するのは「混ざる」である。「混ざらない」ではない
 *
 * **`D-V10-8` の説明文は「バックアップやエクスポートにも混ざりません」と書いた。**
 * **実測はその逆である** —— コメントの器は `kernel.sqlite` の1表であり、
 * `runBackup` は `kernel.sqlite` を丸ごと `VACUUM INTO` するので(`src/server/backup.ts:178`)、
 * **世代の `kernel.sqlite` を開けば `gp_comments` が在り、本文がそのまま読み出せる。**
 *
 * **これは本検査が見つけた食い違いではない。** **`ADR-0366` §Decision 5 の表が、判定の時点で
 * 「バックアップ」= **満たさない** と書いている。** 本検査が足したのは**実測**である
 * (`v10-m10.md` §9-2 の逐語:「本工程はバックアップを1度も走らせていない。
 *  `backup.ts` を読んでもいない」——そこを埋める)。
 * **【禁止】本検査を「バックアップに混ざらないことを満たした」と読まない。**
 *
 * ## 「エクスポートに混ざらない」は今日も測れない
 *
 * **HTTP に export の口が0本である。** **満たしたのではなく、対象が無い。**
 *
 * ## 陰性対照の前提(**アプリを先に1本作る**)
 *
 * **アプリが1本も無いと、世代に `apps/` が生まれず `app.sqlite` が存在しない**
 * (実測: `r.apps` = `[]` / 世代の中身 = `["kernel.sqlite"]` の1件だけ)。
 * **存在しないファイルに「無い」を確かめても何も測っていない。**
 * したがって `beforeEach` で `KernelMetaStore.open` → `createApp` → `applyManifest` を通し、
 * **`r.apps` が1本以上であることを陽性対照として先に確かめてから**、
 * 世代の `apps/<app_id>/app.sqlite` を実際に開く。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommentStore } from "../kernel/comment-store.ts";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { runBackup } from "./backup.ts";

const APP_ID = "book-tracker";
const BODY = "この一覧の並び順が分かりにくい";

let dataRoot: string;
let store: KernelMetaStore;

/** 時刻を注入できる Clock(`src/server/backup.test.ts` の `fixedClock` と同型)。 */
function fixedClock(iso: string) {
  return { now: () => new Date(iso) };
}

function manifest(): Manifest {
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

/** その SQLite ファイルが持つ表の名前(辞書順)。 */
function tableNamesOf(dbPath: string): string[] {
  const db = new Database(dbPath, { readwrite: true, create: false });
  try {
    return db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
      )
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

/** コメントを1件書いてから1世代取る。世代のディレクトリと `apps` の一覧を返す。 */
function writeCommentAndBackup(): { dir: string; apps: string[] } {
  const comments = CommentStore.openForKernel(dataRoot);
  try {
    comments.addComment({
      appId: APP_ID,
      anchorForm: "view",
      anchorParts: ["book-list"],
      body: BODY,
    });
  } finally {
    comments.close();
  }
  const result = runBackup(dataRoot, fixedClock("2026-08-24T03:00:00.000Z"));
  return { dir: result.dir, apps: [...result.apps] };
}

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "gp-comment-backup-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "蔵書管理", { app_id: APP_ID });
  const applied = applyManifest(dataRoot, APP_ID, manifest());
  if (!applied.valid) {
    throw new Error("テスト前提の初期マニフェスト投入に失敗しました。");
  }
});

afterEach(() => {
  store.close();
  rmSync(dataRoot, { recursive: true, force: true });
});

test("(cb1) 日次バックアップの世代の kernel.sqlite に gp_comments が入る(sqlite_master の実出力)", () => {
  const { dir, apps } = writeCommentAndBackup();

  // **陽性対照(先に置く)** —— アプリが1本以上あり、世代に `apps/` が生まれている。
  // ここが空だと、下の (cb2) の陰性対照が「存在しないファイルに無いと言う」空回りになる。
  expect(apps).toContain(APP_ID);

  const names = tableNamesOf(join(dir, "kernel.sqlite"));
  // **器の表が世代に在る**(条件 (5) の本体)。
  expect(names).toContain("gp_comments");
  // **陽性対照** —— 既存の表も同じ世代に在る(`gp_comments` だけを持つ台ではない)。
  expect(names).toContain("apps");
  expect(names).toContain("changelog");
});

test("(cb2) 世代の kernel.sqlite から、書いた本文がそのまま読み出せる(D-V10-8 の説明文と食い違う)", () => {
  const { dir } = writeCommentAndBackup();

  const db = new Database(join(dir, "kernel.sqlite"), { readwrite: true, create: false });
  try {
    const rows = db
      .query<{ app_id: string; anchor_form: string; body: string }, []>(
        `SELECT "app_id", "anchor_form", "body" FROM "gp_comments"`,
      )
      .all();
    expect(rows).toEqual([{ app_id: APP_ID, anchor_form: "view", body: BODY }]);
  } finally {
    db.close();
  }

  // **陰性対照** —— 器は `app.sqlite` に1バイトも入らない。
  // **世代の `apps/<app_id>/app.sqlite` を実際に開いて確かめる**(存在しないファイルに
  // 「無い」を言わないため、まず在ることを確かめる)。
  const appDb = join(dir, "apps", APP_ID, "app.sqlite");
  expect(existsSync(appDb)).toBe(true);
  const appTables = tableNamesOf(appDb);
  expect(appTables).toContain("books");
  expect(appTables).not.toContain("gp_comments");
});
