/**
 * 非同期取得の状態(V0-P3-T03)。
 *
 * 「読み込み中」「取得できた」「エラー」の3状態しか持たない。エラーは
 * ADR-0003 §3 の `ValidationError[]` をそのまま運ぶ。フロントで文面を
 * 作り直さないので、HTTP 経由でも MCP 経由でも利用者が見る言葉が一致する。
 */
import { ApiError, type ValidationError } from "./api.ts";

export type AsyncState<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; errors: ValidationError[] };

/** 何が飛んできても統一形式の `ValidationError[]` に落とす。 */
export function toValidationErrors(reason: unknown): ValidationError[] {
  if (reason instanceof ApiError) {
    return reason.errors;
  }
  const message = reason instanceof Error ? reason.message : String(reason);
  return [
    {
      path: "",
      message: `サーバと通信できませんでした: ${message}`,
      hint: "API サーバ(bun run server)が起動しているか確認してください。",
    },
  ];
}
