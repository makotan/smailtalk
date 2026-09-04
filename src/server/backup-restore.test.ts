/**
 * V1-M3-T07 の検証方法そのもの: バックアップ → リストアの E2E(データ一致確認)。
 *
 * 複数アプリ・複数行を作って runBackup し、**別の空データルート**へ restoreBackup して、
 * 全アプリの全行・manifest・kernel の changelog が元と一致することを確認する。
 * 破壊(app.sqlite を消す/壊す)からの復旧も確認する。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appBlobsDir,
  appDbPath,
  applyManifest,
  appManifestPath,
  createApp,
  createRecord,
  getBlob,
  KernelMetaStore,
  kernelDbPath,
  type Manifest,
  putBlob,
} from "../kernel/index.ts";
import { runBackup } from "./backup.ts";
import { restoreBackup } from "./restore.ts";

let rootA: string;
let rootB: string;

beforeEach(() => {
  rootA = mkdtempSync(join(tmpdir(), "gp-br-src-"));
  rootB = mkdtempSync(join(tmpdir(), "gp-br-dst-"));
});

afterEach(() => {
  rmSync(rootA, { recursive: true, force: true });
  rmSync(rootB, { recursive: true, force: true });
});

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

function buildApp(dataRoot: string, appId: string, rows: number): void {
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

/** app.sqlite の notes 全行(_id 順)を素の SQL で読む。 */
function readNotes(dataRoot: string, appId: string): Array<Record<string, unknown>> {
  const db = new Database(appDbPath(dataRoot, appId), { readonly: true });
  try {
    return db.query('SELECT * FROM "notes" ORDER BY "_id"').all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

/** kernel.sqlite の changelog 全行を素の SQL で読む。 */
function readChangelog(dataRoot: string): Array<Record<string, unknown>> {
  const db = new Database(kernelDbPath(dataRoot), { readonly: true });
  try {
    return db.query('SELECT * FROM "changelog" ORDER BY "seq"').all() as Array<
      Record<string, unknown>
    >;
  } finally {
    db.close();
  }
}

describe("V1-M3-T07 バックアップ→リストア E2E(データ一致)", () => {
  test("別の空データルートへ復元して全行・manifest・changelog が一致する", () => {
    buildApp(rootA, "alpha", 7);
    buildApp(rootA, "beta", 3);

    const before = {
      alpha: readNotes(rootA, "alpha"),
      beta: readNotes(rootA, "beta"),
      changelog: readChangelog(rootA),
    };

    const backup = runBackup(rootA, fixedClock("2026-07-21T01:00:00.000Z"));

    // まっさらな rootB へ復元する(バックアップが自己完結であることの証明)。
    const restored = restoreBackup(backup.dir, rootB);
    expect(restored.apps.sort()).toEqual(["alpha", "beta"]);
    expect(restored.kernel).toBe(true);

    // データ一致。
    expect(readNotes(rootB, "alpha")).toEqual(before.alpha);
    expect(readNotes(rootB, "beta")).toEqual(before.beta);
    expect(readChangelog(rootB)).toEqual(before.changelog);

    // manifest も一致。
    const mA = readFileSync(appManifestPath(rootA, "alpha"), "utf-8");
    const mB = readFileSync(appManifestPath(rootB, "alpha"), "utf-8");
    expect(mB.length).toBeGreaterThan(0);
    expect(mB).toBe(mA);
  });

  test("app.sqlite を壊しても、復元で元のデータに戻る", () => {
    buildApp(rootA, "alpha", 5);
    const before = readNotes(rootA, "alpha");
    const backup = runBackup(rootA, fixedClock("2026-07-21T01:00:00.000Z"));

    // app.sqlite を壊す(ゴミで上書き)。
    writeFileSync(appDbPath(rootA, "alpha"), "corrupted");

    // 同じ rootA へ上書き復元する。
    restoreBackup(backup.dir, rootA);
    expect(readNotes(rootA, "alpha")).toEqual(before);
  });

  test("kernel.sqlite の無いバックアップは throw する", () => {
    buildApp(rootA, "alpha", 1);
    const backup = runBackup(rootA, fixedClock("2026-07-21T01:00:00.000Z"));
    rmSync(join(backup.dir, "kernel.sqlite"), { force: true });
    expect(() => restoreBackup(backup.dir, rootB)).toThrow();
  });

  test("復元先に残った古い kernel.sqlite の WAL sidecar を消す(stale WAL の巻き込み防止)", () => {
    buildApp(rootA, "alpha", 2);
    const backup = runBackup(rootA, fixedClock("2026-07-21T01:00:00.000Z"));
    // 復元先 rootB に古い kernel sidecar を置いておく(kernel.sqlite は WAL モード)。
    writeFileSync(`${kernelDbPath(rootB)}-wal`, "stale");
    writeFileSync(`${kernelDbPath(rootB)}-shm`, "stale");
    restoreBackup(backup.dir, rootB);
    // 復元後、stale sidecar は消えている。
    expect(existsSync(`${kernelDbPath(rootB)}-wal`)).toBe(false);
    expect(existsSync(`${kernelDbPath(rootB)}-shm`)).toBe(false);
  });
});

/**
 * 画像 blob の backup→restore(V2-M2-T04 / ADR-0035 §4「(backup)」)。
 *
 * snapshot は blob を含めないが、**backup は含める**(災害復旧の完全性)。backup が blob を写し、
 * restore が別データルートへ blob を戻し、復元後に実体が読めることを固定する。
 */
describe("V2-M2-T04 画像 blob の backup→restore", () => {
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  test("backup が blobs/ を含め、restore が blob 実体を復元する", () => {
    buildApp(rootA, "gamma", 1);
    const sha = putBlob(rootA, "gamma", new Uint8Array(PNG));

    const backup = runBackup(rootA, fixedClock("2026-07-21T02:00:00.000Z"));
    // (1) backup 世代に blob 実体が含まれている。
    expect(existsSync(join(backup.dir, "apps", "gamma", "blobs", sha))).toBe(true);

    // (2) まっさらな rootB へ復元 → blob 実体が戻り、内容も一致する。
    restoreBackup(backup.dir, rootB);
    const restored = getBlob(rootB, "gamma", sha);
    expect(restored).not.toBeNull();
    expect([...(restored ?? new Uint8Array())]).toEqual(PNG);
  });

  test("災害復旧: blob を失っても backup 世代から復元できる", () => {
    buildApp(rootA, "delta", 1);
    const sha = putBlob(rootA, "delta", new Uint8Array(PNG));
    const backup = runBackup(rootA, fixedClock("2026-07-21T03:00:00.000Z"));

    // 現用の blob 実体を失う(ディスク障害の模擬)。
    rmSync(join(appBlobsDir(rootA, "delta"), sha), { force: true });
    expect(getBlob(rootA, "delta", sha)).toBeNull();

    // backup 世代を現用データルートへ戻すと blob が復活する。
    restoreBackup(backup.dir, rootA);
    expect(getBlob(rootA, "delta", sha)).not.toBeNull();
  });

  test("画像未アップロードのアプリは blobs/ を作らない(backup も restore も無害)", () => {
    buildApp(rootA, "epsilon", 1);
    const backup = runBackup(rootA, fixedClock("2026-07-21T04:00:00.000Z"));
    expect(existsSync(join(backup.dir, "apps", "epsilon", "blobs"))).toBe(false);
    expect(() => restoreBackup(backup.dir, rootB)).not.toThrow();
    expect(existsSync(appBlobsDir(rootB, "epsilon"))).toBe(false);
  });
});
