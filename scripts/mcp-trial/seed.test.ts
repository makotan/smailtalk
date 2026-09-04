/**
 * seed.ts のテスト。
 *
 * 種そのものが壊れていると、ブートストラップ試行の**事前状態が無言で不成立**になる
 * (アプリが1件しか出ない、changelog が空、など)。しかも試行は本物の LLM を回すので
 * 失敗のコストが高い。ここで押さえるのは次の3点:
 *
 * 1. 種の差分が v0 の語彙で実際に適用できること(スキーマ・参照整合性まで通る)
 * 2. changelog に intent 付きの中身が積まれること(完成条件(2)の検証に要る)
 * 3. 既にアプリがあるデータルートに黙って追い蒔きしないこと
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getChangelog, KernelMetaStore, readCurrentManifest } from "../../src/kernel/index.ts";
import { existingAppIds, SEED_APPS, seedAll } from "./seed.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gp-seed-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("seedAll", () => {
  test("種のアプリが全部、台帳に登録される", () => {
    const created = seedAll(root);

    expect(created).toEqual(SEED_APPS.map((seed) => seed.app_id));
    expect(existingAppIds(root).sort()).toEqual([...created].sort());
  });

  test("アプリが2件以上あるので「一覧」が一覧として成立する", () => {
    seedAll(root);

    // 管理アプリ自身を足す前の時点で既に複数件。ここが1件だと完成条件(1)の
    // 機械照合が退化する(このテストはその退化を検出するためにある)。
    expect(existingAppIds(root).length).toBeGreaterThanOrEqual(2);
  });

  test("各アプリの changelog に intent 付きのエントリが複数積まれる", () => {
    seedAll(root);

    for (const seed of SEED_APPS) {
      const entries = getChangelog(root, seed.app_id);
      // V1-M0-T05: createApp が書く「第0行」(_create-app)+ 種の diff 群。
      expect(entries.length).toBe(seed.diffs.length + 1);
      expect(entries.length).toBeGreaterThan(1);
      for (const entry of entries) {
        expect(entry.intent.length).toBeGreaterThan(0);
        expect(entry.kind).toBe("apply");
      }
      expect(entries.map((e) => e.diff_id)).toEqual([
        "_create-app",
        ...seed.diffs.map((d) => d.diff_id),
      ]);
    }
  });

  test("差分の適用結果がマニフェストに残っている(空マニフェストのままではない)", () => {
    seedAll(root);

    for (const seed of SEED_APPS) {
      const manifest = readCurrentManifest(root, seed.app_id);
      expect(manifest.app.tables.length).toBeGreaterThan(0);
      expect(manifest.app.views.length).toBeGreaterThan(0);
      for (const table of manifest.app.tables) {
        expect(table.fields.length).toBeGreaterThan(0);
      }
    }
  });

  test("台帳のアプリ名が種のとおり(一覧画面の目視照合の基準になる)", () => {
    seedAll(root);

    const store = KernelMetaStore.open(root);
    try {
      const byId = new Map(store.listApps().map((app) => [app.app_id, app.name]));
      for (const seed of SEED_APPS) {
        expect(byId.get(seed.app_id)).toBe(seed.name);
      }
    } finally {
      store.close();
    }
  });

  test("既にアプリがあるデータルートには追い蒔きせず、明示的に拒否する", () => {
    seedAll(root);

    expect(() => seedAll(root)).toThrow(/既にアプリがあります/);
  });

  test("--force 相当なら作り直せる", () => {
    seedAll(root);
    const again = seedAll(root, { force: true });

    expect(again).toEqual(SEED_APPS.map((seed) => seed.app_id));
    expect(existingAppIds(root).sort()).toEqual([...again].sort());
    for (const seed of SEED_APPS) {
      // V1-M0-T05: createApp の第0行(_create-app)ぶん +1。
      expect(getChangelog(root, seed.app_id).length).toBe(seed.diffs.length + 1);
    }
  });

  test("存在しないデータルートでも空扱いで始められる", () => {
    expect(existingAppIds(join(root, "not-created-yet"))).toEqual([]);
  });
});
