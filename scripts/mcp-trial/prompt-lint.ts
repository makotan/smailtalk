/**
 * 人間ターンの本文検査(純関数)。
 *
 * 計画書 docs/plan/v0/07-bootstrap.md:20 は「マニフェストやdiffの手書き・手動修正は禁止」
 * と定めている。ところがこの禁止は **ツールを1つも使わずに破れる** ―― 完成形の JSON を
 * プロンプトに貼り付ければ、AI は考えずに転記するだけになり、
 * 「会話だけで作れた」という主張が成り立たなくなる。
 *
 * そこで人間ターンの本文にコードブロック・JSON リテラルが含まれていないことを機械的に判定する。
 * 語彙名(`add_table` など)への言及そのものは禁止しない。**構造を貼ったか**だけを見る。
 */

export type PromptViolationKind =
  | "code_fence"
  | "json_literal"
  | "inline_code_brace"
  | "indented_block";

export interface PromptViolation {
  kind: PromptViolationKind;
  /** 該当箇所の抜粋。 */
  excerpt: string;
}

/** JSON オブジェクトリテラル: `{` のあとに引用符付きキーと `:` が来る形。 */
const JSON_OBJECT = /\{\s*["'][^"'\n]+["']\s*:/;
/** オブジェクトの配列: `[{` または `[ {`。 */
const ARRAY_OF_OBJECT = /\[\s*\{/;
/** インラインコード。 */
const INLINE_CODE = /`([^`\n]+)`/g;

/** プロンプト本文を検査する。空配列なら合格。 */
export function lintPrompt(prompt: string): PromptViolation[] {
  const violations: PromptViolation[] = [];
  const text = prompt.replace(/\r\n/g, "\n");

  if (/^\s*(```|~~~)/m.test(text)) {
    violations.push({ kind: "code_fence", excerpt: firstMatchingLine(text, /(```|~~~)/) });
  }

  for (const pattern of [JSON_OBJECT, ARRAY_OF_OBJECT]) {
    const hit = pattern.exec(text);
    if (hit !== null) {
      violations.push({ kind: "json_literal", excerpt: excerptAround(text, hit.index) });
    }
  }

  for (const hit of text.matchAll(INLINE_CODE)) {
    const inner = hit[1] ?? "";
    if (inner.includes("{") || inner.includes("}")) {
      violations.push({ kind: "inline_code_brace", excerpt: hit[0] });
      break;
    }
  }

  // 空行のあとに来る4桁インデント行は Markdown のコードブロック。
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    const previous = i === 0 ? "" : (lines[i - 1] ?? "");
    if (/^ {4}\S/.test(line) && previous.trim() === "") {
      violations.push({ kind: "indented_block", excerpt: line.trim() });
      break;
    }
  }

  return violations;
}

function firstMatchingLine(text: string, pattern: RegExp): string {
  for (const line of text.split("\n")) {
    if (pattern.test(line)) return line.trim();
  }
  return "";
}

function excerptAround(text: string, index: number): string {
  return text.slice(Math.max(0, index - 20), index + 60).trim();
}
