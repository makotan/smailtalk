/**
 * MCP ツール結果の組み立て(V0-P5-T02 / ADR-0005)。
 *
 * MCP のツール結果には2つの面がある。
 *
 * - `content`: クライアントが会話に差し込む、人間/LLM 向けの表現
 * - `structuredContent`: 機械可読な構造化データ
 *
 * 片方だけを埋めると、クライアント実装によっては情報が届かない。ここでは
 * **常に両方を埋め、しかも同じ JSON を指す**ことを規約にする。ADR-0003 §3 が
 * HTTP のエラーを `{ errors: [...] }` に統一したのと同じ狙いで、入口が違っても
 * LLM が読む形は1つに保つ。
 *
 * `outputSchema` はあえて宣言していない。宣言すると SDK が結果を zod で検証する
 * ため、マニフェスト全体のような**カーネルが型の真実を持っている構造**を、
 * MCP 層でもう一度スキーマとして書き直す羽目になる。二重定義は必ず片方が腐る
 * (ADR-0003 §7 の「カーネルにしか置かない」と同じ判断)。
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ValidationError } from "../kernel/index.ts";

/** 成功結果。`data` がそのまま `structuredContent` になる。 */
export function toolOk(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

/**
 * 失敗結果。
 *
 * `isError: true` は「**何も変わっていない**」ことを意味する、というのが
 * このサーバ全体の規約である(カーネルの変更系は検証を全部通してから書くので、
 * エラーなら副作用は無い)。LLM がこの合図を見て安全に再試行できる。
 */
export function toolError(errors: ValidationError[]): CallToolResult {
  const data = { errors };
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
    isError: true,
  };
}
