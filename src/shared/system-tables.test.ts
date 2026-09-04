import { describe, expect, test } from "bun:test";
import { findSystemTable, isSystemTableId, SYSTEM_TABLES } from "./system-tables.ts";

/**
 * システムテーブル定数(ADR-0006 §4 / §6)のテスト。
 *
 * ここで固定するのは「定義が TypeScript の定数として存在し、外部の状態に一切
 * 依存しない」ことである(ADR-0006 §3 の憲法1・一方向依存の1つ目)。
 */
describe("SYSTEM_TABLES", () => {
  test("v0 のシステムテーブルは _apps と _changelog の2つだけ(ADR-0006 §4)", () => {
    expect(SYSTEM_TABLES.map((table) => table.id)).toEqual(["_apps", "_changelog", "_ai_usage"]);
  });

  test("_apps は ADR-0006 §6 のスキーマどおりの列を持つ", () => {
    const table = findSystemTable("_apps");
    expect(table?.fields.map((field) => `${field.id}:${field.type}`)).toEqual([
      "app_id:text",
      "name:text",
      "created_at:date",
      "status:select",
    ]);
    const status = table?.fields.find((field) => field.id === "status");
    expect(status?.type === "select" ? status.options : undefined).toEqual(["active", "archived"]);
  });

  test("_changelog は ADR-0006 §6 のスキーマどおりの列を持つ", () => {
    const table = findSystemTable("_changelog");
    expect(table?.fields.map((field) => `${field.id}:${field.type}`)).toEqual([
      "seq:number",
      "app_id:text",
      "diff_id:text",
      "intent:long_text",
      "applied_at:date",
      "kind:select",
      "undo_target_seq:number",
    ]);
    const kind = table?.fields.find((field) => field.id === "kind");
    // ADR-0032(V1-M9-T05)で redo を足したので3値。
    expect(kind?.type === "select" ? kind.options : undefined).toEqual(["apply", "undo", "redo"]);
  });

  test("「出さなかったもの」は列に含まれない(ADR-0006 出さなかったもの)", () => {
    const changelog = findSystemTable("_changelog");
    const ids = changelog?.fields.map((field) => field.id) ?? [];
    expect(ids).not.toContain("snapshot");
    expect(ids).not.toContain("operations");
  });

  test("reference 型のフィールドを一切持たない(裏口を作らないため)", () => {
    for (const table of SYSTEM_TABLES) {
      expect(table.fields.every((field) => field.type !== "reference")).toBe(true);
    }
  });

  test("_changelog の名前は apply_diff 経由の変更のみが載ることを示す(Consequences)", () => {
    expect(findSystemTable("_changelog")?.name).toContain("apply_diff");
  });

  // V1-M0-T05 で createApp が第0行を書くようになり、「apply_diff 経由のみ」は不正確に
  // なった。**本体の警告(applyManifest 経由は載らない)を弱めずに**アプリ作成という
  // 例外を名乗ることを固定する(ADR-0007 Δ5)。
  test("_changelog の名前はアプリ作成も載ることを示す(V1-M0-T05)", () => {
    const name = findSystemTable("_changelog")?.name ?? "";
    expect(name).toContain("アプリ作成");
    // 「のみ」を落とすと画面が「起きたことの全部」に見えて嘘になる。
    expect(name).toContain("のみ");
  });
});

describe("isSystemTableId", () => {
  test("システムテーブルIDだけを true にする", () => {
    expect(isSystemTableId("_apps")).toBe(true);
    expect(isSystemTableId("_changelog")).toBe(true);
  });

  test("ユーザ定義しうるID・未定義のシステム風IDは false", () => {
    expect(isSystemTableId("books")).toBe(false);
    expect(isSystemTableId("_snapshots")).toBe(false);
    expect(isSystemTableId("_Apps")).toBe(false);
    expect(isSystemTableId("")).toBe(false);
  });
});

describe("findSystemTable", () => {
  test("未知のIDには undefined を返す", () => {
    expect(findSystemTable("books")).toBeUndefined();
    expect(findSystemTable("_snapshots")).toBeUndefined();
  });
});
