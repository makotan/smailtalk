import { describe, expect, test } from "bun:test";
import { formatValidationErrors, invalid, valid } from "./errors.ts";

describe("valid / invalid", () => {
  test("valid() は { valid: true } を返す", () => {
    expect(valid()).toEqual({ valid: true });
  });

  test("invalid() はエラー配列を保持する", () => {
    const result = invalid([{ path: "/app/id", message: "id が不正です。" }]);
    expect(result).toEqual({
      valid: false,
      errors: [{ path: "/app/id", message: "id が不正です。" }],
    });
  });
});

describe("formatValidationErrors", () => {
  test("パス・理由・許可値を1行にまとめる", () => {
    const text = formatValidationErrors([
      {
        path: "/app/tables/0/fields/2/type",
        message: "type が不正です。",
        allowed_values: ["text", "number"],
        hint: "date を使ってください。",
      },
    ]);
    expect(text).toContain("/app/tables/0/fields/2/type");
    expect(text).toContain("type が不正です。");
    expect(text).toContain("text");
    expect(text).toContain("number");
    expect(text).toContain("date を使ってください。");
  });

  test("空配列は空文字を返す", () => {
    expect(formatValidationErrors([])).toBe("");
  });

  test("ルート(空パス)は / として表示する", () => {
    expect(formatValidationErrors([{ path: "", message: "app が必要です。" }])).toContain("/");
  });
});
