/**
 * 日次バックアップの世代に**コメント表示設定が入る**ことの実測
 * (`V10-M30-T01` = `CM-G36` / `ADR-0377`)。
 *
 * ## なぜこれを測るのか
 *
 * **`ADR-0377` §Consequences は「`delete_app` と日次バックアップと配布データ生成は
 * 列の追加を1バイトの変更もなく引き継ぐ**見込み**である —— 見込みであって、測っていない」
 * と書いた。** **測るのは `V10-M30-T01` である**(同 §この決定の限界 5)。ここがその実測である。
 *
 * 設定の器は `apps` 表の**列2本**であり、`runBackup` は `kernel.sqlite` を丸ごと
 * `VACUUM INTO` する(`src/server/backup.ts:178`)。したがって**世代の `kernel.sqlite` を
 * 開けば列も倒した値もそのまま在る。** **本検査が主張するのは「入る」である。「入らない」ではない。**
 *
 * 形は `src/server/comment-backup-inclusion.test.ts`(`CM-G3` の実測)に倣った ——
 * `fixedClock` / `runBackup` / 世代の `kernel.sqlite` を `Database` で開く、の3点。
 *
 * ## 陰性対照の前提(**アプリを先に1本作る**)
 *
 * **アプリが1本も無いと、世代に `apps/` が生まれず `app.sqlite` が存在しない。**
 * **存在しないファイルに「無い」を確かめても何も測っていない。**
 * そこで `beforeEach` で `createApp` → `applyManifest` を通し、`r.apps` が1本以上で
 * あることを**陽性対照として先に確かめてから**、世代の `app.sqlite` を実際に開く。
 *
 * ## この検査が固定しないもの
 *
 * **設定を読み書きする HTTP の口も AI の道具も、本単位には1本も無い**(`ADR-0377` 限定6)。
 * ここが触るのは `KernelMetaStore` のメソッドだけであり、`src/server/app.ts` を1バイトも
 * 読み書きしていない。**【禁止】本検査を「画面や AI から切り替えられる」と読まない。**
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { runBackup } from "./backup.ts";

const APP_ID = "book-tracker";

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

/** その SQLite ファイルの表 `table` が持つ列の名前。 */
function columnsOf(dbPath: string, table: string): string[] {
  const db = new Database(dbPath, { readwrite: true, create: false });
  try {
    return db
      .query<{ name: string }, []>(`PRAGMA table_info("${table}")`)
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

/** 設定を倒してから1世代取る。世代のディレクトリと `apps` の一覧を返す。 */
function setVisibilityAndBackup(): { dir: string; apps: string[] } {
  // **書く=true / 読む=false** —— 片側だけを倒す。1本の列に畳んだ実装ならここで割れる。
  store.setCommentVisibility(APP_ID, { write: true, read: false });
  const result = runBackup(dataRoot, fixedClock("2026-08-25T03:00:00.000Z"));
  return { dir: result.dir, apps: [...result.apps] };
}

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "gp-comment-visibility-backup-"));
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

test("(cvb1) 世代の kernel.sqlite の apps 表に、設定の列2本がそのまま在る", () => {
  const { dir, apps } = setVisibilityAndBackup();

  // **陽性対照(先に置く)** —— アプリが1本以上あり、世代に `apps/` が生まれている。
  // ここが空だと、下の (cvb2) の陰性対照が空回りになる。
  expect(apps).toContain(APP_ID);

  const columns = columnsOf(join(dir, "kernel.sqlite"), "apps");
  expect(columns).toContain("comment_write_enabled");
  expect(columns).toContain("comment_read_enabled");
  // **陽性対照** —— 元からの列も同じ世代に在る(設定の2本だけを持つ台ではない)。
  expect(columns).toContain("app_id");
  expect(columns).toContain("ledger_seq");
});

test("(cvb2) 世代の kernel.sqlite から、倒した値が 1 / 0 のまま読み出せる", () => {
  const { dir } = setVisibilityAndBackup();

  const db = new Database(join(dir, "kernel.sqlite"), { readwrite: true, create: false });
  try {
    const rows = db
      .query<{ app_id: string; comment_write_enabled: number; comment_read_enabled: number }, []>(
        `SELECT "app_id", "comment_write_enabled", "comment_read_enabled" FROM "apps"`,
      )
      .all();
    expect(rows).toEqual([{ app_id: APP_ID, comment_write_enabled: 1, comment_read_enabled: 0 }]);
  } finally {
    db.close();
  }

  // **陰性対照** —— 設定はアプリ側の `app.sqlite` に1バイトも入らない。
  // **世代の `apps/<app_id>/app.sqlite` を実際に開いて確かめる**(存在しないファイルに
  // 「無い」を言わないため、まず在ることを確かめる)。
  const appDb = join(dir, "apps", APP_ID, "app.sqlite");
  expect(existsSync(appDb)).toBe(true);
  const appTables = new Database(appDb, { readwrite: true, create: false });
  try {
    const names = appTables
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
      )
      .all()
      .map((row) => row.name);
    // 陽性対照: アプリ側のユーザテーブルは在る。
    expect(names).toContain("books");
    // そもそも `apps` 表がアプリ側に無いので、列も在りようがない。
    expect(names).not.toContain("apps");
    const ddl = appTables
      .query<{ sql: string }, []>(`SELECT COALESCE(sql, '') AS sql FROM sqlite_master`)
      .all()
      .map((row) => row.sql)
      .join("\n");
    expect(ddl).not.toContain("comment_write_enabled");
  } finally {
    appTables.close();
  }
});
