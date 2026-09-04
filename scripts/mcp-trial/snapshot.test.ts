import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertIsolatedDataRoot, diffSnapshots, takeSnapshot } from "./snapshot.ts";
import type { Snapshot } from "./types.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gp-mcp-trial-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("takeSnapshot", () => {
  test("配下の全ファイルを相対パス・SHA-256・mtime で採取する", () => {
    mkdirSync(join(root, "apps", "reading-log"), { recursive: true });
    writeFileSync(join(root, "kernel.sqlite"), "k");
    writeFileSync(join(root, "apps", "reading-log", "manifest.json"), "{}");

    const snap = takeSnapshot(root, "before", 1);
    expect(snap.phase).toBe("before");
    expect(snap.turn).toBe(1);
    expect(snap.files.map((f) => f.path)).toEqual([
      "apps/reading-log/manifest.json",
      "kernel.sqlite",
    ]);
    // "k" の SHA-256
    expect(snap.files[1]?.sha256).toBe(
      "8254c329a92850f6d539dd376f4816ee2764517da5e0235514af433164480d7a",
    );
    expect(snap.files[1]?.size).toBe(1);
    expect(snap.files[1]?.mtimeMs).toBeGreaterThan(0);
  });

  test("ディレクトリが存在しなければ空のスナップショットになる", () => {
    expect(takeSnapshot(join(root, "nope"), "after", 2).files).toEqual([]);
  });
});

describe("diffSnapshots", () => {
  const snap = (files: { path: string; sha256: string; mtimeMs?: number }[]): Snapshot => ({
    phase: "before",
    turn: 1,
    takenAt: "2026-07-19T00:00:00.000Z",
    files: files.map((f) => ({ path: f.path, sha256: f.sha256, mtimeMs: f.mtimeMs ?? 1, size: 1 })),
  });

  test("変化なし", () => {
    expect(
      diffSnapshots(snap([{ path: "a", sha256: "x" }]), snap([{ path: "a", sha256: "x" }])),
    ).toEqual([]);
  });

  test("追加・変更・削除を分類する", () => {
    const before = snap([
      { path: "a", sha256: "x" },
      { path: "b", sha256: "y" },
    ]);
    const after = snap([
      { path: "a", sha256: "z", mtimeMs: 99 },
      { path: "c", sha256: "w", mtimeMs: 50 },
    ]);
    expect(diffSnapshots(before, after)).toEqual([
      { path: "a", kind: "modified", mtimeMs: 99 },
      { path: "b", kind: "removed", mtimeMs: null },
      { path: "c", kind: "added", mtimeMs: 50 },
    ]);
  });

  test("内容が同じなら mtime だけ動いても変化とみなさない", () => {
    const before = snap([{ path: "a", sha256: "x", mtimeMs: 1 }]);
    const after = snap([{ path: "a", sha256: "x", mtimeMs: 2 }]);
    expect(diffSnapshots(before, after)).toEqual([]);
  });
});

describe("assertIsolatedDataRoot", () => {
  test("リポジトリの data/ は拒否する", () => {
    expect(() => assertIsolatedDataRoot("data")).toThrow(/data\//);
    expect(() => assertIsolatedDataRoot("./data")).toThrow(/data\//);
    expect(() => assertIsolatedDataRoot("/repo/data/")).toThrow(/data\//);
  });

  test("data- で始まらない名前も拒否する", () => {
    expect(() => assertIsolatedDataRoot("tmpdata")).toThrow(/data-/);
  });

  test("data-cp6 のような評価専用ルートは通す", () => {
    expect(assertIsolatedDataRoot("data-cp6")).toBe("data-cp6");
    expect(assertIsolatedDataRoot("/tmp/data-trial")).toBe("/tmp/data-trial");
  });
});
