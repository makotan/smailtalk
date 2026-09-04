import { describe, expect, test } from "bun:test";
import { isValidResourceId } from "./resource-id.ts";

describe("isValidResourceId", () => {
  describe("正常系", () => {
    test.each([
      ["単一の英小文字", "a"],
      ["英小文字のみ", "resource"],
      ["英小文字と数字", "user42"],
      ["ハイフン区切り", "my-resource-id"],
      ["数字とハイフンの混在", "a1-b2-c3"],
      ["連続ハイフン", "a--b"],
      ["アンダースコアを含む", "my_resource"],
      ["アンダースコア区切り", "my_resource_id"],
      ["連続アンダースコア", "a__b"],
      ["ハイフンとアンダースコアの混在", "my-resource_id"],
      ["handover 3.4 のサンプルID", "finished_at"],
    ])("%s は有効: %s", (_label, id) => {
      expect(isValidResourceId(id)).toBe(true);
    });

    test("kebab-case と snake_case はどちらも有効で、別のIDとして扱われる", () => {
      expect(isValidResourceId("my-field")).toBe(true);
      expect(isValidResourceId("my_field")).toBe(true);
      // 正規化・同一視はしない。文字列として異なる以上、別のリソースIDである。
      expect("my-field").not.toBe("my_field");
    });
  });

  describe("境界値", () => {
    test("1文字(最小長)は有効", () => {
      expect(isValidResourceId("a")).toBe(true);
    });

    test("64文字(最大長)は有効", () => {
      const id = `a${"b".repeat(63)}`;
      expect(id.length).toBe(64);
      expect(isValidResourceId(id)).toBe(true);
    });

    test("65文字(最大長超過)は無効", () => {
      const id = `a${"b".repeat(64)}`;
      expect(id.length).toBe(65);
      expect(isValidResourceId(id)).toBe(false);
    });

    test("0文字(空文字)は無効", () => {
      expect(isValidResourceId("")).toBe(false);
    });
  });

  describe("異常系", () => {
    test.each([
      ["先頭が数字", "1abc"],
      ["先頭がハイフン", "-abc"],
      ["先頭がアンダースコア", "_abc"],
      ["大文字を含む", "Resource"],
      ["全て大文字", "ABC"],
      ["ドットを含む", "my.resource"],
      ["スラッシュを含む", "my/resource"],
      ["空白を含む", "my resource"],
      ["前後の空白", " abc "],
      ["日本語を含む", "リソース"],
      ["絵文字を含む", "a🎉b"],
      ["改行を含む", "abc\ndef"],
      ["末尾の改行(正規表現アンカーの罠)", "abc\n"],
      ["コロンを含む", "a:b"],
      ["プラスを含む", "a+b"],
    ])("%s は無効: %j", (_label, id) => {
      expect(isValidResourceId(id)).toBe(false);
    });
  });
});
