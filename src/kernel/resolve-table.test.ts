import { describe, expect, test } from "bun:test";
import { resolveTable } from "./resolve-table.ts";
import type { Manifest } from "./types.ts";

const manifest: Manifest = {
  app: {
    id: "book-tracker",
    name: "蔵書管理",
    tables: [
      {
        id: "books",
        name: "書籍",
        fields: [{ id: "title", name: "タイトル", type: "text", required: true }],
      },
    ],
    views: [],
  },
};

/** テーブル解決の一本化(ADR-0006 §7)。 */
describe("resolveTable", () => {
  test("マニフェストが宣言したテーブルを解決する", () => {
    expect(resolveTable(manifest, "books")?.name).toBe("書籍");
  });

  test("マニフェストに現れないシステムテーブルも解決する(ADR-0006 §5)", () => {
    expect(resolveTable(manifest, "_apps")?.id).toBe("_apps");
    expect(resolveTable(manifest, "_changelog")?.id).toBe("_changelog");
  });

  test("テーブルが1つも無いマニフェストでもシステムテーブルは解決する", () => {
    const empty: Manifest = { app: { id: "empty", name: "空", tables: [], views: [] } };
    expect(resolveTable(empty, "_apps")?.id).toBe("_apps");
  });

  test("未知のIDは undefined(解決できないことは黙って握り潰さない)", () => {
    expect(resolveTable(manifest, "bookz")).toBeUndefined();
    expect(resolveTable(manifest, "_snapshots")).toBeUndefined();
  });
});
