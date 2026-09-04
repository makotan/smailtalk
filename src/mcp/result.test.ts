/**
 * MCP ツール結果の組み立て(`toolOk` / `toolError`)のユニットテスト(V0-P5-T02)。
 *
 * MCP のツール結果は「人間/LLM が読む `content`」と「機械が読む
 * `structuredContent`」の2面を持つ。ADR-0003 §3 が HTTP で
 * 「エラーは常に `{ errors: [...] }`」に統一したのと同じ理由で、MCP 側も
 * **両面が常に同じ JSON を指す**ことをここで固定する。片方だけを見て
 * 実装した LLM が取りこぼす形にしない。
 */
import { expect, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ValidationError } from "../kernel/index.ts";
import { toolError, toolOk } from "./result.ts";

/**
 * `content[0]` を text ブロックとして読み、その JSON をパースして返す。
 * SDK の content は image / resource も取りうる union なので、
 * 「text であること」自体をアサートしてから中身を見る。
 */
function parseFirstTextBlock(result: CallToolResult): unknown {
  const first = result.content[0];
  expect(first?.type).toBe("text");
  if (first === undefined || first.type !== "text") {
    throw new Error("content[0] が text ブロックではありません。");
  }
  return JSON.parse(first.text);
}

test("toolOk は content(JSON文字列)と structuredContent に同じデータを載せる", () => {
  const result = toolOk({ apps: [{ app_id: "demo" }] });

  expect(result.isError).toBeUndefined();
  expect(result.structuredContent).toEqual({ apps: [{ app_id: "demo" }] });
  expect(parseFirstTextBlock(result)).toEqual({ apps: [{ app_id: "demo" }] });
});

test("toolError は isError:true と structuredContent.errors を返す", () => {
  const errors: ValidationError[] = [
    { path: "/app_id", message: 'アプリ "nope" は存在しません。', allowed_values: ["demo"] },
  ];
  const result = toolError(errors);

  expect(result.isError).toBe(true);
  expect(result.structuredContent).toEqual({ errors });
  expect(parseFirstTextBlock(result)).toEqual({ errors });
});
