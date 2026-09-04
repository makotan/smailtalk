/**
 * AI プロバイダ抽象(V1-M5-T02 / ADR-0021 §3d)。
 *
 * **1つのインターフェースに閉じ、実装2種を持つ**(ユーザ=owner が capability 発行時に選ぶ):
 * - `claude_cli`(既定): `claude -p <prompt> --output-format json` を実行する。secret 不要
 *   (CLI 自身の認証を使う)。CLI パスは環境変数 `ST_CLAUDE_CLI`(既定 `claude`)。
 * - `openai_compatible`: `POST {baseUrl}/chat/completions` に Bearer で送る。OpenRouter 等。
 *   **枠を用意するだけで、実接続の疎通は OpenRouter トークンが得られてから**(ADR-0021 §3d /
 *   §Consequences 限界5)。
 *
 * プロバイダは**テキスト in・テキスト out + トークン数**だけを返す純粋な口である ——
 * 構造化出力の組み立て・検証は `ai-structured.ts`(呼び出し側)の責務で、ここには持ち込まない。
 * **テストは `AiProvider` を注入で差し替える**(実ネットワーク / 実 CLI に触れずに検証する)。
 */
import type { AiCapability } from "./ai-capability-store.ts";
import type { SecretSource } from "./secret-resolver.ts";
import { resolveSecret } from "./secret-resolver.ts";

/** プロバイダ呼び出しの結果。トークン数はメータリングの入力(§4)。 */
export interface AiProviderResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * プロバイダの口。capability(プロバイダ種別・モデル・base_url を持つ)と解決済みプロンプトを
 * 受け取り、本文とトークン数を返す。`resolveSecretFor` は use-time の secret 解決を注入する
 * (テストはここを差し替えて実 secret 解決を避ける)。
 */
export type AiProvider = (
  capability: AiCapability,
  prompt: string,
  resolveSecretFor: (source: SecretSource) => Promise<string>,
) => Promise<AiProviderResult>;

/** `claude -p` を実行して本文とトークン数を得る(§3d)。secret を使わない。 */
async function runClaudeCli(capability: AiCapability, prompt: string): Promise<AiProviderResult> {
  const cli = process.env.ST_CLAUDE_CLI ?? "claude";
  const proc = Bun.spawn(
    [cli, "-p", prompt, "--output-format", "json", "--model", capability.model],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`claude CLI が失敗しました(exit code: ${exitCode})。stderr: ${stderr}`);
  }
  // `--output-format json` の stdout は { result, usage: { input_tokens, output_tokens }, ... }。
  // 形が想定と違ってもクラッシュさせず、読める分だけ拾う(トークン不明なら 0)。
  let parsed: {
    result?: unknown;
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    throw new Error("claude CLI の出力を JSON として解釈できませんでした。");
  }
  return {
    text: typeof parsed.result === "string" ? parsed.result : "",
    inputTokens: numberOr0(parsed.usage?.input_tokens),
    outputTokens: numberOr0(parsed.usage?.output_tokens),
  };
}

/** OpenAI 互換 HTTP エンドポイントを叩く(§3d。枠。実疎通は OpenRouter トークン待ち)。 */
async function runOpenAiCompatible(
  capability: AiCapability,
  prompt: string,
  resolveSecretFor: (source: SecretSource) => Promise<string>,
): Promise<AiProviderResult> {
  if (capability.baseUrl === null || capability.baseUrl === "") {
    throw new Error("openai_compatible の capability に base_url がありません。");
  }
  if (capability.secretSource === null) {
    throw new Error("openai_compatible の capability に secret の取得元がありません。");
  }
  const secret = await resolveSecretFor(capability.secretSource);
  const url = `${capability.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({
      model: capability.model,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    // **本文に secret は載らない**(認可ヘッダは送信側)。ステータスだけ手がかりに残す。
    throw new Error(`openai_compatible が失敗応答を返しました(status: ${res.status})。`);
  }
  const body = (await res.json()) as {
    choices?: { message?: { content?: unknown } }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  };
  const content = body.choices?.[0]?.message?.content;
  return {
    text: typeof content === "string" ? content : "",
    inputTokens: numberOr0(body.usage?.prompt_tokens),
    outputTokens: numberOr0(body.usage?.completion_tokens),
  };
}

function numberOr0(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * 本番のプロバイダ。capability.provider で分岐する。
 * secret 解決は本物の `resolveSecret` を使う(use-time。値をどこにも残さない)。
 */
export const defaultAiProvider: AiProvider = (capability, prompt) => {
  if (capability.provider === "claude_cli") {
    return runClaudeCli(capability, prompt);
  }
  return runOpenAiCompatible(capability, prompt, resolveSecret);
};
