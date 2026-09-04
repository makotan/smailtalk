/**
 * `V5-M5-T03` / `V5-M5-T04`。**版を刻む側の検査。**
 *
 * [`ADR-0251`](../../docs/adr/0251-runner-build-version.md) §5 の
 * **限定1(置き場は `PRAGMA user_version` の1箇所だけ)/ 限定2(アプリごとに別の版を
 * 持たない)/ 限定6(印の無い DB を救済しない)/ 限定7(`kernel.sqlite` にも同じ形を
 * 1つだけ)** を固定する。
 *
 * ## 「新しく作る DB にだけ刻む」ことを固定する
 *
 * **既に在る `user_version = 0` の DB を開いても、刻み直さない。** 刻み直すと
 * 「印が無い DB を新しいものとみなす」ことになり、**限定6 に正面から反する。**
 * この検査はその境界を両側から押さえる。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNNER_BUILD_VERSION } from "../shared/runner-build-version.ts";
import { createApp } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { appDbPath, kernelDbPath } from "./storage-paths.ts";

let dataRoot: string;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-version-stamp-"));
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function userVersionOf(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? -1;
  } finally {
    db.close();
  }
}

test("新規に作った kernel.sqlite に Runner のビルド単位の版が刻まれる", () => {
  const store = KernelMetaStore.open(dataRoot);
  store.close();
  expect(userVersionOf(kernelDbPath(dataRoot))).toBe(RUNNER_BUILD_VERSION);
});

test("createApp が作った app.sqlite に同じ版が刻まれる(VACUUM を挟んでも保たれる)", () => {
  const store = KernelMetaStore.open(dataRoot);
  createApp(store, "蔵書管理", { app_id: "book-tracker" });
  store.close();
  expect(userVersionOf(appDbPath(dataRoot, "book-tracker"))).toBe(RUNNER_BUILD_VERSION);
});

test("限定2: アプリが2本あっても版は同じ1つである(アプリごとに別の版を持たない)", () => {
  const store = KernelMetaStore.open(dataRoot);
  createApp(store, "在庫", { app_id: "inv" });
  createApp(store, "受注", { app_id: "orders" });
  store.close();
  expect(userVersionOf(appDbPath(dataRoot, "inv"))).toBe(RUNNER_BUILD_VERSION);
  expect(userVersionOf(appDbPath(dataRoot, "orders"))).toBe(RUNNER_BUILD_VERSION);
});

test("限定6: 既に在る user_version = 0 の kernel.sqlite を開いても刻み直さない", () => {
  // 先に「印の無い」kernel.sqlite を作る(今日ディスクに在るものと同じ形)。
  const first = KernelMetaStore.open(dataRoot);
  first.close();
  const zeroed = new Database(kernelDbPath(dataRoot), { readwrite: true });
  zeroed.exec("PRAGMA user_version = 0;");
  zeroed.close();
  expect(userVersionOf(kernelDbPath(dataRoot))).toBe(0);

  // 開き直しても救済しない。
  const second = KernelMetaStore.open(dataRoot);
  second.close();
  expect(userVersionOf(kernelDbPath(dataRoot))).toBe(0);
});

test("限定1: 版の置き場は PRAGMA user_version だけである(テーブルを1本も作らない)", () => {
  const store = KernelMetaStore.open(dataRoot);
  createApp(store, "在庫", { app_id: "inv" });
  store.close();

  const kernel = new Database(kernelDbPath(dataRoot), { readonly: true });
  const kernelTables = kernel
    .query<{ name: string }, []>(`SELECT "name" FROM "sqlite_master" WHERE "type" = 'table'`)
    .all()
    .map((row) => row.name);
  kernel.close();
  expect(kernelTables.filter((name) => /version/i.test(name))).toEqual([]);

  const app = new Database(appDbPath(dataRoot, "inv"), { readonly: true });
  const appTables = app
    .query<{ name: string }, []>(`SELECT "name" FROM "sqlite_master" WHERE "type" = 'table'`)
    .all()
    .map((row) => row.name);
  app.close();
  expect(appTables.filter((name) => /version/i.test(name))).toEqual([]);
});
