/**
 * SQ-M3: システムテーブルの読取が `kernel.sqlite` を開いて SQL 経路を通ることの検査。
 *
 * ## この検査が固定すること
 *
 * 1. **読取が本当に SQL 経路を通っている**(投影元のストアAPIを経由していない)。
 *    **これを書かないと、以下の3件は「実装0バイトのまま全部緑」になる** ——
 *    **着手時に実測した**: 3件は当時の実装(投影元のストアを開いて JS で絞る経路)でも
 *    そのまま緑になり、本結線の有無を1件も判別できなかった。
 * 2. **DDL 副作用の穴が塞がっている**。`KernelMetaStore.open` は開くたびに
 *    `db.exec(SCHEMA)` と `ALTER TABLE ... ADD COLUMN kind / undo_target_seq` を流し、
 *    `AiCapabilityStore.openForKernel` は `ai_usage` を作る。読取専用で開くだけでは
 *    これらが走らず `no such column` / `no such table` になる。
 *    - 2a. `kind` / `undo_target_seq` を欠く古い形の `kernel.sqlite`
 *    - 2b. `ai_usage` 表が1度も作られていないデータルート
 *    - 2c. `kernel.sqlite` が1バイトも無いデータルート
 * 3. **`app.sqlite` を1度も開かない**(ADR-0006 §7b)。壊れたアプリでも `_apps` は見られる。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiCapabilityStore } from "./ai-capability-store.ts";
import type { ValidationError } from "./errors.ts";
import { KernelMetaStore } from "./meta-store.ts";
import {
  type ReadSource,
  readRecord,
  readRecordCount,
  readRecordCountAndSum,
  readRecordList,
} from "./read-records.ts";
import { kernelDbPath } from "./storage-paths.ts";
import type { Manifest } from "./types.ts";

const manifest: Manifest = {
  app: { id: "probe-app", name: "読取接続の検査", tables: [], views: [] },
};

let dataRoot: string;
let source: ReadSource;
/** `appDb`(= `app.sqlite`)が呼ばれた回数。システムテーブルでは 0 でなければならない。 */
let appDbCalls: number;

function unwrap<T>(result: { ok: true; value: T } | { ok: false; errors: ValidationError[] }): T {
  if (!result.ok) {
    throw new Error(`期待に反して失敗しました: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

/** `app.sqlite` を開こうとしたら即座に落ちる読み取り元を作る。 */
function readSourceFor(root: string): ReadSource {
  return {
    dataRoot: root,
    appDb: () => {
      appDbCalls += 1;
      throw new Error("システムテーブルの読み取りで app.sqlite を開いてはならない");
    },
  };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-system-table-conn-"));
  appDbCalls = 0;
  source = readSourceFor(dataRoot);

  const store = KernelMetaStore.open(dataRoot);
  try {
    store.registerApp({
      app_id: "zeta-shop",
      name: "Ａ 全角の店",
      created_at: "2026-08-01T00:00:00.000Z",
    });
    store.registerApp({
      app_id: "kichi-store",
      name: "𠮷野家 まかない帳",
      created_at: "2026-08-02T00:00:00.000Z",
    });
    store.appendChangelog({
      app_id: "zeta-shop",
      diff_id: "d-001",
      intent: "商品の表がほしい",
      operations: [],
      applied_at: "2026-08-01T00:00:00.000Z",
    });
    store.appendChangelog({
      app_id: "kichi-store",
      diff_id: "d-002",
      intent: "まかないの表がほしい",
      operations: [],
      applied_at: "2026-08-02T00:00:00.000Z",
    });
  } finally {
    store.close();
  }
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

describe("SQ-M3: 読取が SQL 経路を通っている(投影元のストアAPIを経由していない)", () => {
  test("_changelog: `operations` が壊れていても一覧が読める(SQL は operations を読まない)", () => {
    // `KernelMetaStore.listAllChangelog()` は行ごとに `JSON.parse(row.operations)` を通す。
    // 壊れた JSON を1行入れると**ストアAPI経由の読取は必ず落ちる**。投影 SELECT は
    // `operations` を1バイトも読まないので落ちない ―― 経路の目印になる。
    const raw = new Database(kernelDbPath(dataRoot));
    try {
      raw.exec(`UPDATE "changelog" SET "operations" = 'これは JSON ではない' WHERE "seq" = 1`);
    } finally {
      raw.close();
    }
    const rows = unwrap(readRecordList(source, manifest, "_changelog"));
    expect(rows.map((row) => row.diff_id)).toEqual(["d-001", "d-002"]);
    expect(unwrap(readRecordCount(source, manifest, "_changelog"))).toBe(2);
    expect(unwrap(readRecord(source, manifest, "_changelog", "1"))?.diff_id).toBe("d-001");
    expect(appDbCalls).toBe(0);
  });

  test("_apps: BMP外文字の並びが UTF-8 バイト順になる(SQLite の ORDER BY と同じ)", () => {
    // JS の文字列比較は UTF-16 符号単位順なので `𠮷`(サロゲート 0xD842…)が
    // `Ａ`(0xFF21)より**前**に来る。SQLite の BINARY collation は UTF-8 バイト順なので
    // `Ａ`(EF BC A1)が `𠮷`(F0 A0 AE B7)より**前**に来る。どちらの実装で並べたかが割れる。
    //
    // **【SQ-M5 との重複について。両方残す理由を1行で書く】**
    // 並びそのものの固定は `system-table-behavior-fixation.test.ts` #3 が引き受けており
    // (3文字 + `gte` / `lte` + ユーザ表との一致まで見る)、**この1件はそれとは目的が違う** ——
    // **ここは「読取が SQL 経路を通っていること」の目印**であって、**投影元のストアAPIを
    // 経由する実装に戻したら**(SQ-M3 の着手前がそうだった)**この1件だけが赤くなる。**
    // 目的が違うので寄せずに両方残す。
    const rows = unwrap(
      readRecordList(source, manifest, "_apps", { sort: { field: "name", order: "asc" } }),
    );
    expect(rows.map((row) => row.app_id)).toEqual(["zeta-shop", "kichi-store"]);
    expect(appDbCalls).toBe(0);
  });
});

describe("SQ-M3 完了条件1: kind / undo_target_seq を欠く古い kernel.sqlite でも _changelog が読める", () => {
  let legacyRoot: string;
  let legacySource: ReadSource;

  beforeEach(async () => {
    legacyRoot = await mkdtemp(join(tmpdir(), "gp-system-table-legacy-"));
    legacySource = readSourceFor(legacyRoot);
    const db = new Database(kernelDbPath(legacyRoot), { create: true });
    try {
      db.exec(`
        CREATE TABLE "apps" (
          "app_id"     TEXT PRIMARY KEY,
          "name"       TEXT NOT NULL,
          "created_at" TEXT NOT NULL,
          "status"     TEXT NOT NULL,
          "ledger_seq" INTEGER NOT NULL
        );
        CREATE TABLE "changelog" (
          "seq"        INTEGER PRIMARY KEY AUTOINCREMENT,
          "app_id"     TEXT NOT NULL REFERENCES "apps"("app_id"),
          "diff_id"    TEXT NOT NULL,
          "intent"     TEXT NOT NULL,
          "operations" TEXT NOT NULL,
          "applied_at" TEXT NOT NULL,
          "snapshot"   TEXT,
          UNIQUE ("app_id", "diff_id")
        );
        INSERT INTO "apps" VALUES ('books', '蔵書管理', '2026-07-18T06:00:00.000Z', 'active', 1);
        INSERT INTO "changelog"
          ("app_id", "diff_id", "intent", "operations", "applied_at", "snapshot")
          VALUES ('books', 'd-old', '旧スキーマ時代の変更', '[]',
                  '2026-07-18T06:00:01.000Z', '0001-d-old');
      `);
    } finally {
      db.close();
    }
  });

  afterEach(async () => {
    await rm(legacyRoot, { recursive: true, force: true });
  });

  test("`no such column` にならず、欠けていた列は apply / null で読める", () => {
    const rows = unwrap(readRecordList(legacySource, manifest, "_changelog"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      _id: "1",
      seq: 1,
      app_id: "books",
      diff_id: "d-old",
      intent: "旧スキーマ時代の変更",
      applied_at: "2026-07-18T06:00:01.000Z",
      kind: "apply",
      undo_target_seq: null,
    });
    expect(appDbCalls).toBe(0);
  });

  test("件数・単体取得・合計も同じ結果になる", () => {
    expect(unwrap(readRecordCount(legacySource, manifest, "_changelog"))).toBe(1);
    expect(unwrap(readRecord(legacySource, manifest, "_changelog", "1"))?.diff_id).toBe("d-old");
    expect(unwrap(readRecordCountAndSum(legacySource, manifest, "_changelog"))).toEqual({
      count: 1,
      sum: null,
    });
    expect(appDbCalls).toBe(0);
  });

  test("`kind` で絞り込める(移行後の列が SQL の WHERE に届いている)", () => {
    const rows = unwrap(
      readRecordList(legacySource, manifest, "_changelog", {
        filter: [{ field: "kind", equals: "apply" }],
      }),
    );
    expect(rows.map((row) => row.diff_id)).toEqual(["d-old"]);
  });
});

describe("SQ-M3 完了条件2: ai_usage 表が1度も作られていないデータルートでも _ai_usage が読める", () => {
  test("`no such table` にならず0件が返る", () => {
    // `KernelMetaStore.open` は `ai_usage` を作らない(作るのは `AiCapabilityStore`)。
    // この beforeEach は `AiCapabilityStore` を1度も開いていないので、この時点の
    // `kernel.sqlite` に `ai_usage` は存在しない。
    const tables = new Database(kernelDbPath(dataRoot), { readonly: true });
    try {
      const found = tables
        .query<{ name: string }, []>(
          `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" = 'ai_usage'`,
        )
        .get();
      expect(found).toBeNull();
    } finally {
      tables.close();
    }

    expect(unwrap(readRecordList(source, manifest, "_ai_usage"))).toEqual([]);
    expect(unwrap(readRecordCount(source, manifest, "_ai_usage"))).toBe(0);
    expect(unwrap(readRecord(source, manifest, "_ai_usage", "ghost"))).toBeNull();
    expect(appDbCalls).toBe(0);
  });

  test("その後に記録された使用量は読める(表を作っただけで壊していない)", () => {
    unwrap(readRecordList(source, manifest, "_ai_usage"));
    const ai = AiCapabilityStore.openForKernel(dataRoot);
    try {
      const cap = ai.createCapability({
        appId: "zeta-shop",
        name: "summarize",
        provider: "claude_cli",
        model: "claude-sonnet-4",
        limit: { maxCallsPerDay: 100, maxCostUsdPerDay: 1 },
      });
      ai.recordUsage({
        appId: "zeta-shop",
        capabilityId: cap.id,
        workflowId: "wf-summary",
        actor: "𠮷田",
        model: "claude-sonnet-4",
        inputTokens: 120,
        outputTokens: 45,
        costUsd: 0.0125,
        status: "success",
        usageDate: "2026-08-04",
        calledAt: "2026-08-04T01:00:00.000Z",
      });
    } finally {
      ai.close();
    }
    const rows = unwrap(readRecordList(source, manifest, "_ai_usage"));
    expect(rows.map((row) => row.actor)).toEqual(["𠮷田"]);
  });
});

describe("SQ-M3 完了条件3: kernel.sqlite が1バイトも無いデータルートでも3表が読める", () => {
  let emptyRoot: string;
  let emptySource: ReadSource;

  beforeEach(async () => {
    emptyRoot = await mkdtemp(join(tmpdir(), "gp-system-table-empty-"));
    emptySource = readSourceFor(emptyRoot);
  });

  afterEach(async () => {
    await rm(emptyRoot, { recursive: true, force: true });
  });

  test("3表とも例外にならず0件を返す", () => {
    for (const tableId of ["_apps", "_changelog", "_ai_usage"]) {
      expect(unwrap(readRecordList(emptySource, manifest, tableId))).toEqual([]);
      expect(unwrap(readRecordCount(emptySource, manifest, tableId))).toBe(0);
      expect(unwrap(readRecordCountAndSum(emptySource, manifest, tableId))).toEqual({
        count: 0,
        sum: null,
      });
      expect(unwrap(readRecord(emptySource, manifest, tableId, "ghost"))).toBeNull();
    }
    expect(appDbCalls).toBe(0);
  });

  test("データルートのディレクトリ自体が無くても落ちない", async () => {
    const missing = join(emptyRoot, "not-created-yet");
    const missingSource = readSourceFor(missing);
    expect(unwrap(readRecordList(missingSource, manifest, "_apps"))).toEqual([]);
    expect(appDbCalls).toBe(0);
    await rm(missing, { recursive: true, force: true });
  });
});
