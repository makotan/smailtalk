/**
 * AI の構造化出力の組み立てと解析(V1-M5-T02 / ADR-0021 §3b)。
 *
 * **AI の出力をそのまま信頼しない。**AI には常に `{"value": "..."}` という1形の JSON を
 * 求め、返ってきたテキストからその `value` を取り出す。取り出せない / 制約に通らないときは
 * フォールバックする(検証は呼び出し側 = ディスパッチャが `updateRecord` で行う。§3b)。
 *
 * ここは**プロンプトの組み立て**と**出力からの value 抽出**という2つの純関数だけを持つ ——
 * プロバイダ(`ai-provider.ts`)にも検証(`updateRecord`)にも依存しない。
 */
import type { Field } from "./types.ts";

/**
 * 構造化出力を促すプロンプトを組み立てる。
 *
 * - `basePrompt`: ワークフローが書いた指示(用途)。
 * - `input`: 解決済みの文脈(キー → 値)。
 * - `field`: 書き戻し先フィールド。`select` なら選択肢を明示し、その中から選ばせる
 *   (**AI の出力を選択肢に閉じ込める第一の壁**。第二の壁は `updateRecord` の検証)。
 *
 * **出力形式を1形に固定する** —— `{"value": ...}` だけを求める。自由記述を許すと
 * 抽出規則が増え、AI ごとの揺れを吸収しきれない。
 */
export function buildStructuredPrompt(
  basePrompt: string,
  input: Record<string, unknown>,
  field: Field,
): string {
  const lines: string[] = [basePrompt.trim(), ""];

  const inputEntries = Object.entries(input);
  if (inputEntries.length > 0) {
    lines.push("## 入力");
    for (const [key, value] of inputEntries) {
      lines.push(`- ${key}: ${stringifyInput(value)}`);
    }
    lines.push("");
  }

  lines.push("## 出力");
  if (field.type === "select" && field.options !== undefined && field.options.length > 0) {
    lines.push(`次の選択肢のいずれか1つを選んでください: ${field.options.join(" / ")}`);
  } else if (field.type === "boolean") {
    lines.push("true または false を答えてください。");
  } else if (field.type === "number") {
    lines.push("数値を答えてください。");
  } else {
    lines.push(`フィールド「${field.name}」に入れる値を答えてください。`);
  }
  lines.push("");
  lines.push('**必ず次の形の JSON だけを、前後に説明を付けず返してください: {"value": <答え>}**');

  return lines.join("\n");
}

function stringifyInput(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * AI の出力テキストから `value` を取り出す。取り出せなければ `null`。
 *
 * 揺れに強くする(**AI は前後に説明を付けたりコードフェンスで囲んだりする**):
 * 1. まずテキスト全体を JSON として読む。
 * 2. 失敗したら、最初の `{` から最後の `}` までを切り出して JSON として読む
 *    (コードフェンスや前置きの散文を跨いで `{"value": ...}` を拾う)。
 * `value` は文字列 / 数値 / 真偽のいずれかを想定し、文字列へ正規化して返す
 * (`updateRecord` の検証がフィールド型へ最終変換する)。
 */
export function parseAiValue(text: string): string | null {
  const direct = tryParseValue(text);
  if (direct !== null) {
    return direct;
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return tryParseValue(text.slice(start, end + 1));
  }
  return null;
}

function tryParseValue(candidate: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("value" in parsed)) {
    return null;
  }
  const value = (parsed as { value: unknown }).value;
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}
