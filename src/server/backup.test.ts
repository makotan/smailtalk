/**
 * V1-M3-T07 自動バックアップの単体テスト。
 *
 * runBackup が「全アプリ(app.sqlite + manifest.json)+ kernel.sqlite」を
 * data/backups/<stamp>/ に取ること、retention が7世代に刈ること、apply 窓中の
 * アプリを skip すること、VACUUM INTO で作ったコピーが開けて行が読めることを固定する。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appDbPath,
  applyManifest,
  createApp,
  createRecord,
  KernelMetaStore,
  type Manifest,
} from "../kernel/index.ts";
import {
  BACKUP_DIR_NAME,
  formatBackupStamp,
  parseBackupStamp,
  RETENTION,
  runBackup,
} from "./backup.ts";

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "gp-backup-"));
});

afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

/** 時刻を注入できる Clock。 */
function fixedClock(iso: string) {
  return { now: () => new Date(iso) };
}

function manifest(appId: string): Manifest {
  return {
    app: {
      id: appId,
      name: `app ${appId}`,
      tables: [
        {
          id: "notes",
          name: "メモ",
          fields: [
            { id: "title", name: "題", type: "text", required: true },
            { id: "body", name: "本文", type: "long_text" },
          ],
        },
      ],
      views: [{ id: "note-list", type: "list_view", table: "notes", columns: ["title"] }],
    },
  };
}

/** アプリを1つ作り notes に rows 行入れる。 */
function buildApp(appId: string, rows: number): void {
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, appId, { app_id: appId });
  } finally {
    store.close();
  }
  const m = manifest(appId);
  const applied = applyManifest(dataRoot, appId, m);
  if (!applied.valid) {
    throw new Error(`setup failed: ${JSON.stringify(applied.errors)}`);
  }
  const db = new Database(appDbPath(dataRoot, appId), { readwrite: true, create: false });
  try {
    for (let i = 0; i < rows; i++) {
      const r = createRecord(db, m, "notes", { title: `t-${i}`, body: `b-${i}` });
      if (!r.ok) {
        throw new Error(`insert failed: ${JSON.stringify(r.errors)}`);
      }
    }
  } finally {
    db.close();
  }
}

describe("V1-M3-T07 runBackup", () => {
  test("全アプリ(app.sqlite + manifest.json)+ kernel.sqlite をコピーする", () => {
    buildApp("alpha", 3);
    buildApp("beta", 5);

    const result = runBackup(dataRoot, fixedClock("2026-07-21T01:00:00.000Z"));

    expect(result.kernel).toBe(true);
    expect(result.apps.sort()).toEqual(["alpha", "beta"]);
    expect(result.skipped).toEqual([]);
    expect(existsSync(join(result.dir, "kernel.sqlite"))).toBe(true);
    for (const appId of ["alpha", "beta"]) {
      expect(existsSync(join(result.dir, "apps", appId, "app.sqlite"))).toBe(true);
      expect(existsSync(join(result.dir, "apps", appId, "manifest.json"))).toBe(true);
    }
  });

  test("VACUUM INTO で取ったコピーは開けて行が読める(データ一致の下地)", () => {
    buildApp("alpha", 4);
    const result = runBackup(dataRoot, fixedClock("2026-07-21T01:00:00.000Z"));

    const original = new Database(appDbPath(dataRoot, "alpha"), { readonly: true });
    const copied = new Database(join(result.dir, "apps", "alpha", "app.sqlite"), {
      readonly: true,
    });
    try {
      const a = original.query('SELECT count(*) AS n FROM "notes"').get() as { n: number };
      const b = copied.query('SELECT count(*) AS n FROM "notes"').get() as { n: number };
      expect(b.n).toBe(4);
      expect(b.n).toBe(a.n);
    } finally {
      original.close();
      copied.close();
    }
  });

  test("apply 窓中(.st-applying.json 在)のアプリは skip し skipped に載る", () => {
    buildApp("alpha", 2);
    buildApp("beta", 2);
    // beta を apply 窓中に見せる(recovery のマーカーを直接置く)。
    writeFileSync(
      join(dataRoot, "apps", "beta", ".st-applying.json"),
      JSON.stringify({ diff_id: "x", started_at: "2026-07-21T00:00:00.000Z" }),
    );

    const result = runBackup(dataRoot, fixedClock("2026-07-21T01:00:00.000Z"));

    expect(result.apps).toEqual(["alpha"]);
    expect(result.skipped).toEqual(["beta"]);
    expect(existsSync(join(result.dir, "apps", "beta"))).toBe(false);
    // kernel は取れている。
    expect(existsSync(join(result.dir, "kernel.sqlite"))).toBe(true);
  });

  test("retention: 世代が RETENTION を超えると最古から刈られる", () => {
    buildApp("alpha", 1);
    const dirs: string[] = [];
    for (let i = 0; i < RETENTION + 3; i++) {
      // 1時間ずつずらして固定幅 stamp が時系列に並ぶようにする。
      const hour = String(i).padStart(2, "0");
      const r = runBackup(dataRoot, fixedClock(`2026-07-21T${hour}:00:00.000Z`));
      dirs.push(r.stamp);
    }
    const root = join(dataRoot, BACKUP_DIR_NAME);
    // 残っているのは新しい RETENTION 個だけ。
    const remaining = dirs.filter((s) => existsSync(join(root, s)));
    expect(remaining.length).toBe(RETENTION);
    // 最古の3個は消えている。
    expect(existsSync(join(root, dirs[0] as string))).toBe(false);
    expect(existsSync(join(root, dirs[2] as string))).toBe(false);
    expect(existsSync(join(root, dirs[3] as string))).toBe(true);
  });

  test("アプリが1つも無くても投げず、kernel.sqlite だけ取る", () => {
    // kernel.sqlite を用意するため空の store を開いて閉じる。
    const store = KernelMetaStore.open(dataRoot);
    store.close();
    const result = runBackup(dataRoot, fixedClock("2026-07-21T01:00:00.000Z"));
    expect(result.apps).toEqual([]);
    expect(result.kernel).toBe(true);
  });

  test("同一 stamp の二重実行は throw する(黙って上書きしない)", () => {
    buildApp("alpha", 1);
    const clock = fixedClock("2026-07-21T01:00:00.000Z");
    runBackup(dataRoot, clock);
    expect(() => runBackup(dataRoot, clock)).toThrow();
  });
});

describe("V1-M3-T07 stamp 命名", () => {
  test("固定幅・区切り安全形式で、辞書順=時系列", () => {
    const a = formatBackupStamp(new Date("2026-07-21T09:00:00.000Z"));
    const b = formatBackupStamp(new Date("2026-07-21T10:00:00.000Z"));
    expect(a).toBe("20260721T090000000Z");
    expect(a < b).toBe(true);
    expect(a).not.toContain(":");
  });

  test("format と parse は往復する", () => {
    const d = new Date("2026-07-21T10:30:45.123Z");
    const stamp = formatBackupStamp(d);
    expect(parseBackupStamp(stamp)).toBe(d.getTime());
    expect(parseBackupStamp("not-a-stamp")).toBe(null);
  });
});
