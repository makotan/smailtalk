/**
 * **見本のモードの写し**(`V20-M13-T03`。計画 §9-5・§10-6 / `D-V20-44`「見本だけにする」)。
 *
 * **固定するもの**:
 *
 * - 写しの中で実データの行が0件・見本が表ごとに5件(当てた後の欄にも見本が入る)。
 * - 見本は生の SQL で入る —— **自動処理が走らない**(`on_create` の自動処理を持つ表に見本を入れても、
 *   書き込み先の表・実行の履歴の表は見本の5行のまま。外への送信も0件)。
 * - 見本のモードでは、そのアプリのコメント・操作の記録・`_files` の行・変更履歴も空。
 * - 本体の5点(マニフェストのバイト列・スキーマ・データ・変更履歴・スナップショットの置き場)と、
 *   データルート配下のファイルの一覧が不変。
 * - **実データの目印が写しの全ファイルのバイト列に0件**(陽性対照: 見本にする前の写しでは当たる)。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, recordActivity } from "../auth/store.ts";
import { applyDiff } from "../kernel/apply-diff.ts";
import { applyManifest } from "../kernel/apply-manifest.ts";
import { CapabilityStore } from "../kernel/capability-store.ts";
import { CommentStore } from "../kernel/comment-store.ts";
import { createApp } from "../kernel/create-app.ts";
import { dryRunDiff } from "../kernel/dry-run.ts";
import { type ChangelogEntry, KernelMetaStore } from "../kernel/meta-store.ts";
import { createRecord } from "../kernel/records.ts";
import { appDbPath, appManifestPath, appSnapshotsDir } from "../kernel/storage-paths.ts";
import type { Manifest } from "../kernel/types.ts";
import { ensureFilesTable, insertFileRecord } from "../server/files-store.ts";
import { listDataRootFiles } from "../server/test-helpers.ts";
import { createPreview, SAMPLE_CLEARED_KERNEL_TABLES } from "./preview.ts";
import { sampleRowId } from "./sample-rows.ts";

const ROOT = join(import.meta.dir, "..", "..");
const APP_ID = "loan-desk";
/** 実データの目印(本体の行・変更履歴の意図・コメント・操作の記録・_files・外への送信に入れる)。 */
const DATA_MARKER = "REALDATA-MARKER-BORROWER-7F3A";
const INTENT_MARKER = "REALDATA-MARKER-INTENT-7F3B";
const COMMENT_MARKER = "REALDATA-MARKER-COMMENT-7F3C";
const ACTIVITY_MARKER = "REALDATA-MARKER-ACTIVITY-7F3D";
const FILE_MARKER = "REALDATA-MARKER-FILENAME-7F3E.pdf";
const OUTBOX_MARKER = "REALDATA-MARKER-OUTBOX-7F3F";
const MARKERS = [
  DATA_MARKER,
  INTENT_MARKER,
  COMMENT_MARKER,
  ACTIVITY_MARKER,
  FILE_MARKER,
  OUTBOX_MARKER,
];
const CREATOR_TABLES = ["loans", "loan_logs", "workflow_runs"];

let work = "";
let dataRoot = "";
let previewRoot = "";
let aliceId = "";

function loanManifest(): Manifest {
  const m = JSON.parse(
    readFileSync(join(ROOT, "fixtures", "valid", "loan-tracker-with-workflows.json"), "utf8"),
  ) as Manifest;
  m.app.id = APP_ID;
  return m;
}

function diff(): unknown {
  return {
    diff_id: "d-sample-preview",
    intent: "貸出にメモを持たせたい",
    operations: [
      { op: "add_field", table: "loans", field: { id: "memo", name: "メモ", type: "text" } },
    ],
  };
}

function allBytes(dir: string): string {
  const chunks: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else chunks.push(readFileSync(p).toString("latin1"));
    }
  };
  walk(dir);
  return chunks.join("\n");
}

/** 目印は ASCII なので latin1 の連結でそのまま探せる。 */
function hits(dir: string): string[] {
  const hay = allBytes(dir);
  return MARKERS.filter((m) => hay.includes(m));
}

/**
 * 本体の全ファイルの一覧。SQLite の付随ファイル2種(`-shm` と 0 バイトの `-wal`)だけを外す
 * (V20-M13 実 CI の赤で同じ形の比較を見直した。ここは `observe()` が書く接続を開け閉めして
 * Linux の付随ファイルを消した後に一覧を取るので赤くならなかったが、順番に頼らない形にそろえた。
 * 外し方と陽性対照は `src/server/test-helpers.ts` の `listDataRootFiles` と
 * `src/server/preview-invariance.test.ts`)。
 */
function listAllFiles(dir: string): string[] {
  return listDataRootFiles(dir);
}

type Observed = {
  manifestText: string;
  schema: Record<string, string[]>;
  data: Record<string, unknown[]>;
  changelog: ChangelogEntry[];
  snapshots: string[];
};

/** 本体の5点(`dry-run.test.ts` の先例と同じ5点)。 */
function observe(): Observed {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readonly: true });
  const schema: Record<string, string[]> = {};
  const data: Record<string, unknown[]> = {};
  try {
    const names = (
      db
        .query(
          `SELECT "name" FROM "sqlite_master" WHERE "type"='table' AND "name" NOT LIKE 'sqlite_%' ORDER BY "name"`,
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    for (const name of names) {
      schema[name] = (db.query(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map(
        (c) => c.name,
      );
      data[name] = db.query(`SELECT * FROM "${name}" ORDER BY rowid`).all();
    }
  } finally {
    db.close();
  }
  const kernel = KernelMetaStore.open(dataRoot);
  let changelog: ChangelogEntry[];
  try {
    changelog = kernel.listChangelog(APP_ID);
  } finally {
    kernel.close();
  }
  const snapDir = appSnapshotsDir(dataRoot, APP_ID);
  return {
    manifestText: readFileSync(appManifestPath(dataRoot, APP_ID), "utf8"),
    schema,
    data,
    changelog,
    snapshots: existsSync(snapDir) ? readdirSync(snapDir).sort() : [],
  };
}

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "gp-preview-sample-"));
  dataRoot = join(work, "data");
  previewRoot = join(work, "previews");
  const kernel = KernelMetaStore.open(dataRoot);
  try {
    createApp(kernel, "貸出台帳", { app_id: APP_ID });
  } finally {
    kernel.close();
  }
  const applied = applyManifest(dataRoot, APP_ID, loanManifest());
  if (!applied.valid) throw new Error(JSON.stringify(applied));
  // 変更履歴の意図に目印(本体に実適用する)。
  const real = applyDiff(dataRoot, APP_ID, {
    diff_id: "d-real-intent",
    intent: `返却済みを分けたい ${INTENT_MARKER}`,
    operations: [
      { op: "add_field", table: "loan_logs", field: { id: "extra", name: "追記", type: "text" } },
    ],
  });
  if (!real.valid) throw new Error(JSON.stringify(real));

  const auth = AuthStore.openForApp(dataRoot, APP_ID);
  try {
    aliceId = auth.createUser({ username: "alice", role: "owner" }).id;
  } finally {
    auth.close();
  }
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    const manifest = JSON.parse(readFileSync(appManifestPath(dataRoot, APP_ID), "utf8"));
    // 本体の行(on_create の自動処理が走り、loan_logs と workflow_runs にも行が増える)。
    for (const borrower of [DATA_MARKER, `${DATA_MARKER}-2`]) {
      const created = createRecord(db, manifest, "loans", { borrower, status: "貸出中" });
      if (!created.ok) throw new Error(JSON.stringify(created.errors));
    }
    recordActivity(db, {
      userId: aliceId,
      username: "alice",
      action: "create_record",
      tableId: "loans",
      recordId: ACTIVITY_MARKER,
    });
    ensureFilesTable(db);
    insertFileRecord(db, {
      file_id: "file-0001",
      sha256: "0".repeat(64),
      mime: "application/pdf",
      size: 1,
      filename: FILE_MARKER,
      uploaded_by: aliceId,
    });
  } finally {
    db.close();
  }
  const comments = CommentStore.openForKernel(dataRoot);
  try {
    comments.addComment({
      appId: APP_ID,
      anchorForm: "view",
      anchorParts: ["loan-list"],
      body: COMMENT_MARKER,
    });
  } finally {
    comments.close();
  }
  const caps = CapabilityStore.openForKernel(dataRoot);
  try {
    const conn = caps.createConnection({
      appId: APP_ID,
      name: "mail",
      allowedHosts: ["mail.example.com"],
      secretSource: { kind: "env", value: "ST_SAMPLE_SECRET" },
    });
    caps.enqueueOutbox({
      appId: APP_ID,
      connectionId: conn.id,
      destination: "https://mail.example.com/send",
      payload: { body: OUTBOX_MARKER },
    });
  } finally {
    caps.close();
  }
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

function sampleCopy() {
  const result = createPreview({
    dataRoot,
    appId: APP_ID,
    diff: diff(),
    mode: "sample",
    requesterUserId: aliceId,
    previewRoot,
  });
  if (result.kind !== "created") throw new Error(JSON.stringify(result));
  return result;
}

function count(db: Database, table: string, where = "", ...args: string[]): number {
  return (
    db.query(`SELECT COUNT(*) AS n FROM "${table}" ${where}`).get(...args) as {
      n: number;
    }
  ).n;
}

describe("実データの目印が写しの全ファイルに0件(陽性対照つき)", () => {
  test("陽性対照: 見本にする前の写し(残す指定で当てただけ)では、目印が全部当たる", () => {
    const keepParent = join(work, "raw");
    mkdirSync(keepParent);
    const raw = dryRunDiff(dataRoot, APP_ID, diff(), { keepUnder: keepParent });
    expect(raw.valid).toBe(true);
    expect(hits(keepParent)).toEqual(MARKERS);
  });

  test("陽性対照: 実データのモードの下見では、行の目印が当たる", () => {
    const result = createPreview({
      dataRoot,
      appId: APP_ID,
      diff: diff(),
      mode: "real",
      requesterUserId: aliceId,
      previewRoot,
    });
    if (result.kind !== "created") throw new Error(JSON.stringify(result));
    expect(hits(join(previewRoot, result.meta.preview_id))).toContain(DATA_MARKER);
  });

  test("見本のモードの下見の置き場では0件", () => {
    const result = sampleCopy();
    expect(hits(join(previewRoot, result.meta.preview_id))).toEqual([]);
    // 本体には残っている(本体は1バイトも変えない)。
    expect(hits(dataRoot)).toEqual(expect.arrayContaining([DATA_MARKER, INTENT_MARKER]));
  });
});

describe("写しの中身", () => {
  test("作り手の表は見本だけが5行ずつ(実データの行は0件)・当てた後の欄にも見本が入る", () => {
    const result = sampleCopy();
    const db = new Database(appDbPath(result.meta.shadow_data_root, APP_ID), { readonly: true });
    try {
      for (const table of CREATOR_TABLES) {
        const ids = (
          db.query(`SELECT "_id" FROM "${table}" ORDER BY "_id"`).all() as {
            _id: string;
          }[]
        ).map((r) => r._id);
        const expected = [1, 2, 3, 4, 5].map((i) => sampleRowId(table, i)).sort();
        expect(`${table}:${JSON.stringify(ids)}`).toBe(`${table}:${JSON.stringify(expected)}`);
      }
      const memo = (
        db.query(`SELECT "memo" FROM "loans" ORDER BY "_id"`).all() as {
          memo: string;
        }[]
      ).map((r) => r.memo);
      expect([...memo].sort()).toEqual(["見本 1", "見本 2", "見本 3", "見本 4", "見本 5"]);
      expect(count(db, "loans", `WHERE "borrower" LIKE '%MARKER%'`)).toBe(0);
    } finally {
      db.close();
    }
  });

  test("自動処理が走らない: on_create の書き込み先と実行の履歴の表は見本の5行のまま・外への送信は0件", () => {
    const result = sampleCopy();
    const db = new Database(appDbPath(result.meta.shadow_data_root, APP_ID), { readonly: true });
    try {
      // 本体では2行の作成で loan_logs / workflow_runs に行が増えていた(前提の確認)。
      const body = new Database(appDbPath(dataRoot, APP_ID), { readonly: true });
      try {
        expect(count(body, "loan_logs")).toBe(2);
        expect(count(body, "workflow_runs")).toBeGreaterThanOrEqual(2);
      } finally {
        body.close();
      }
      expect(count(db, "loan_logs")).toBe(5);
      expect(count(db, "workflow_runs")).toBe(5);
      expect(count(db, "loan_logs", `WHERE "note" = '貸出を登録しました'`)).toBe(0);
    } finally {
      db.close();
    }
    const kernel = new Database(join(result.meta.shadow_data_root, "kernel.sqlite"), {
      readonly: true,
    });
    try {
      expect(count(kernel, "outbox")).toBe(0);
    } finally {
      kernel.close();
    }
  });

  test("コメント・操作の記録・_files の行・変更履歴が空、利用者と頼んだ人のセッションは残る", () => {
    const result = sampleCopy();
    const db = new Database(appDbPath(result.meta.shadow_data_root, APP_ID), { readonly: true });
    try {
      expect(count(db, "_files")).toBe(0);
      expect(count(db, "_auth_activity")).toBe(0);
      expect(count(db, "_auth_users")).toBe(1);
      expect(count(db, "_auth_sessions")).toBe(1);
    } finally {
      db.close();
    }
    expect([...SAMPLE_CLEARED_KERNEL_TABLES].sort()).toEqual(
      ["ai_jobs", "ai_usage", "changelog", "gp_comments", "outbox"].sort(),
    );
    const kernel = new Database(join(result.meta.shadow_data_root, "kernel.sqlite"), {
      readonly: true,
    });
    try {
      for (const table of ["changelog", "gp_comments", "outbox"]) {
        expect(`${table}:${count(kernel, table)}`).toBe(`${table}:0`);
      }
      expect(count(kernel, "apps", `WHERE "app_id" = ?`, APP_ID)).toBe(1);
      expect(count(kernel, "connections")).toBe(1);
    } finally {
      kernel.close();
    }
  });

  // **【`V20-M13` 点検の処置 軽1】この検査の向きを反転した。** `real` の写しでも対象のアプリの
  // 変更履歴・コメント・外への送信・AI の依頼と使用量を消す(許可リストで届かなくても1時間ディスクに残るため)。
  // **旧の名前の逐語**: 「実データのモードでは、見本の処置(変更履歴・コメントを消す)をしない(対照)」
  // **旧の期待の逐語**: `expect(count(kernel, "changelog")).toBeGreaterThan(0);` /
  // `expect(count(kernel, "gp_comments")).toBe(1);`
  test("実データのモードでも、変更履歴・コメントは消える(見本の行は入れない)", () => {
    const result = createPreview({
      dataRoot,
      appId: APP_ID,
      diff: diff(),
      mode: "real",
      requesterUserId: aliceId,
      previewRoot,
    });
    if (result.kind !== "created") throw new Error(JSON.stringify(result));
    const kernel = new Database(join(result.meta.shadow_data_root, "kernel.sqlite"), {
      readonly: true,
    });
    try {
      expect(count(kernel, "changelog")).toBe(0);
      expect(count(kernel, "gp_comments")).toBe(0);
    } finally {
      kernel.close();
    }
    // 陽性対照: 本体には在る(消したのは写しだけ)。
    const main = new Database(join(dataRoot, "kernel.sqlite"), { readonly: true });
    try {
      expect(count(main, "changelog", `WHERE "app_id" = ?`, APP_ID)).toBeGreaterThan(0);
      expect(count(main, "gp_comments", `WHERE "app_id" = ?`, APP_ID)).toBe(1);
    } finally {
      main.close();
    }
  });
});

describe("本体は1バイトも変わらない", () => {
  test("見本のモードの前後で、本体の5点とデータルート配下のファイルの一覧が不変", () => {
    const before = observe();
    const filesBefore = listAllFiles(dataRoot);
    const bytesBefore = allBytes(dataRoot);
    sampleCopy();
    expect(observe()).toEqual(before);
    expect(listAllFiles(dataRoot)).toEqual(filesBefore);
    expect(allBytes(dataRoot)).toBe(bytesBefore);
  });
});
