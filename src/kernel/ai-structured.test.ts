import { describe, expect, test } from "bun:test";
import { buildStructuredPrompt, parseAiValue } from "./ai-structured.ts";
import type { Field } from "./types.ts";

const selectField: Field = {
  id: "category",
  name: "分類",
  type: "select",
  options: ["bug", "feature", "question"],
};

describe("buildStructuredPrompt", () => {
  test("select フィールドは選択肢を明示し、JSON 形式を要求する", () => {
    const prompt = buildStructuredPrompt("分類してください", { text: "落ちる" }, selectField);
    expect(prompt).toContain("bug / feature / question");
    expect(prompt).toContain("text: 落ちる");
    expect(prompt).toContain('{"value": <答え>}');
  });

  test("input が空でも壊れない", () => {
    const prompt = buildStructuredPrompt("答えて", {}, selectField);
    expect(prompt).toContain("bug / feature / question");
  });
});

describe("parseAiValue", () => {
  test("素の JSON から value を取り出す", () => {
    expect(parseAiValue('{"value":"bug"}')).toBe("bug");
  });

  test("前置きの散文やコードフェンスを跨いで拾う", () => {
    expect(parseAiValue('答えは:\n```json\n{"value": "feature"}\n```')).toBe("feature");
  });

  test("数値・真偽は文字列へ正規化する", () => {
    expect(parseAiValue('{"value": 42}')).toBe("42");
    expect(parseAiValue('{"value": true}')).toBe("true");
  });

  test("JSON でない / value が無い / 値がオブジェクト → null", () => {
    expect(parseAiValue("ただの文章")).toBeNull();
    expect(parseAiValue('{"answer":"bug"}')).toBeNull();
    expect(parseAiValue('{"value": {"nested": 1}}')).toBeNull();
  });
});
