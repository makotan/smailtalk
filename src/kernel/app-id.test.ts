import { describe, expect, test } from "bun:test";
import { APP_ID_FALLBACK, generateAppId, slugifyAppName } from "./app-id.ts";
import { isValidResourceId } from "./resource-id.ts";

const nothingTaken = () => false;

describe("slugifyAppName", () => {
  test.each([
    ["英字はそのまま小文字化", "Books", "books"],
    ["空白はハイフンに", "Book Shelf", "book-shelf"],
    ["連続する区切り文字は1つにまとめる", "Book   Shelf!!", "book-shelf"],
    ["前後の区切り文字は落とす", "  -books-  ", "books"],
    ["アンダースコアは温存する", "finished_at", "finished_at"],
    ["ハイフンは温存する", "my-app", "my-app"],
    ["数字は残る", "app 2 go", "app-2-go"],
    ["記号のみは空になる", "!!!", ""],
    ["日本語のみは空になる", "蔵書管理", ""],
  ])("%s: %j -> %j", (_label, input, expected) => {
    expect(slugifyAppName(input)).toBe(expected);
  });

  test("全角英数は半角に正規化される (NFKC)", () => {
    expect(slugifyAppName("Ｂｏｏｋｓ")).toBe("books");
  });
});

describe("generateAppId", () => {
  test("英字名から素直にIDを作る", () => {
    expect(generateAppId("Books", nothingTaken)).toBe("books");
  });

  test("日本語名『蔵書管理』でも必ず有効なIDになる (フォールバック)", () => {
    const id = generateAppId("蔵書管理", nothingTaken);
    expect(id).toBe(APP_ID_FALLBACK);
    expect(isValidResourceId(id)).toBe(true);
  });

  test("先頭が数字になる場合はフォールバックを前置する", () => {
    const id = generateAppId("2026 計画", nothingTaken);
    expect(id).toBe("app-2026");
    expect(isValidResourceId(id)).toBe(true);
  });

  test("衝突時は -2, -3 と連番を振る", () => {
    const taken = new Set<string>();
    const isTaken = (id: string) => taken.has(id);
    const first = generateAppId("Books", isTaken);
    taken.add(first);
    const second = generateAppId("Books", isTaken);
    taken.add(second);
    const third = generateAppId("Books", isTaken);
    expect([first, second, third]).toEqual(["books", "books-2", "books-3"]);
  });

  test("日本語名を連続作成してもIDが衝突しない", () => {
    const taken = new Set<string>();
    const isTaken = (id: string) => taken.has(id);
    const ids = [0, 1, 2].map(() => {
      const id = generateAppId("蔵書管理", isTaken);
      taken.add(id);
      return id;
    });
    expect(ids).toEqual([APP_ID_FALLBACK, `${APP_ID_FALLBACK}-2`, `${APP_ID_FALLBACK}-3`]);
    expect(new Set(ids).size).toBe(3);
  });

  test("長すぎる名前は64文字以内に切り詰められる", () => {
    const id = generateAppId("a".repeat(200), nothingTaken);
    expect(id.length).toBe(64);
    expect(isValidResourceId(id)).toBe(true);
  });

  test("切り詰め後に連番を足しても64文字を超えない", () => {
    const taken = new Set<string>();
    const isTaken = (id: string) => taken.has(id);
    const long = "b".repeat(200);
    const first = generateAppId(long, isTaken);
    taken.add(first);
    const second = generateAppId(long, isTaken);
    expect(second.length).toBeLessThanOrEqual(64);
    expect(second).not.toBe(first);
    expect(isValidResourceId(second)).toBe(true);
  });

  test("生成されたIDは常に isValidResourceId を満たす", () => {
    for (const name of ["蔵書管理", "!!!", "___", "---", "9", "Ｂｏｏｋｓ", "a b c"]) {
      expect(isValidResourceId(generateAppId(name, nothingTaken))).toBe(true);
    }
  });

  test("空の名前は拒否する", () => {
    expect(() => generateAppId("   ", nothingTaken)).toThrow();
  });
});
