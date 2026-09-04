import { describe, expect, test } from "bun:test";
import {
  appDbPath,
  appDir,
  appManifestPath,
  appSnapshotsDir,
  appsDir,
  kernelDbPath,
  parseAppDbPath,
  snapshotDir,
} from "./storage-paths.ts";

describe("storage-paths (ADR-0002 のレイアウト)", () => {
  const root = "/tmp/data";

  test("kernel.sqlite はデータルート直下", () => {
    expect(kernelDbPath(root)).toBe("/tmp/data/kernel.sqlite");
  });

  test("アプリは data/apps/<app_id>/ 配下", () => {
    expect(appsDir(root)).toBe("/tmp/data/apps");
    expect(appDir(root, "books")).toBe("/tmp/data/apps/books");
  });

  test("マニフェスト・DB・スナップショット置き場", () => {
    expect(appManifestPath(root, "books")).toBe("/tmp/data/apps/books/manifest.json");
    expect(appDbPath(root, "books")).toBe("/tmp/data/apps/books/app.sqlite");
    expect(appSnapshotsDir(root, "books")).toBe("/tmp/data/apps/books/snapshots");
  });

  test("スナップショットは <連番>-<diff_id> ディレクトリ", () => {
    expect(snapshotDir(root, "books", "0001-d-0042")).toBe(
      "/tmp/data/apps/books/snapshots/0001-d-0042",
    );
  });

  test("相対パスのデータルートも扱える", () => {
    expect(kernelDbPath("data")).toBe("data/kernel.sqlite");
  });
});

describe("parseAppDbPath(appDbPath の逆算。V1-M4-T03)", () => {
  const root = "/tmp/data";

  test("appDbPath と往復一致する(絶対パス)", () => {
    expect(parseAppDbPath(appDbPath(root, "books"))).toEqual({ dataRoot: root, appId: "books" });
  });

  test("appDbPath と往復一致する(相対パスのデータルート)", () => {
    expect(parseAppDbPath(appDbPath("data", "books"))).toEqual({
      dataRoot: "data",
      appId: "books",
    });
  });

  test("ネストの深いデータルートでも appId / dataRoot を正しく取り出す", () => {
    expect(parseAppDbPath("/srv/gp/store/apps/customer-app/app.sqlite")).toEqual({
      dataRoot: "/srv/gp/store",
      appId: "customer-app",
    });
  });

  test(":memory: は弾く(想定外パス)", () => {
    expect(() => parseAppDbPath(":memory:")).toThrow();
  });

  test("末尾が app.sqlite でないパスは弾く", () => {
    expect(() => parseAppDbPath("/tmp/data/apps/books/other.sqlite")).toThrow();
  });

  test("親ディレクトリが apps でないパスは弾く", () => {
    expect(() => parseAppDbPath("/tmp/data/tables/books/app.sqlite")).toThrow();
  });

  test("構造が浅すぎるパスは弾く", () => {
    expect(() => parseAppDbPath("app.sqlite")).toThrow();
  });
});
