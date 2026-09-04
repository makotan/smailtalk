/**
 * シナリオ定義(scenarios/*.md)の読み込み。
 *
 * シナリオは「人間が打つプロンプト」そのものなので、**人間が読み書きする形式**
 * (Markdown)を正とする。判定に使うのは frontmatter とターン本文だけで、
 * それ以外の散文は無視する。
 *
 * ターン本文を引用行(`> `)に限定しているのは、シナリオファイル上で
 * 「プロンプトとして送る部分」と「シナリオの説明」を機械が確実に区別できるようにするため。
 */
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Scenario } from "./types.ts";

/** scenarios/ の絶対パス。 */
export function scenariosDir(): string {
  return join(dirname(new URL(import.meta.url).pathname), "scenarios");
}

/** シナリオファイルを読む。id はファイル名と一致していることを要求する。 */
export function loadScenario(path: string): Scenario {
  const scenario = parseScenario(readFileSync(path, "utf-8"));
  const expectedId = basename(path).replace(/\.md$/, "");
  if (scenario.id !== expectedId) {
    throw new Error(
      `シナリオID が不一致です: frontmatter=${scenario.id} / ファイル名=${expectedId}`,
    );
  }
  return scenario;
}

/** id またはパスからシナリオを解決する。 */
export function resolveScenario(idOrPath: string): Scenario {
  const path = idOrPath.endsWith(".md") ? idOrPath : join(scenariosDir(), `${idOrPath}.md`);
  return loadScenario(path);
}

/** Markdown のシナリオ定義をパースする(純関数)。 */
export function parseScenario(source: string): Scenario {
  const text = source.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (match === null) {
    throw new Error("シナリオに frontmatter (--- で囲んだ設定) がありません。");
  }
  const front = parseFrontmatter(match[1] ?? "");
  const body = text.slice(match[0].length);

  const id = requireKey(front, "id");
  const title = requireKey(front, "title");
  const allowedTools = splitList(requireKey(front, "allowed_tools"));
  const disallowedTools = splitList(front.disallowed_tools ?? "");
  const expectedAbsentTools = splitList(front.expected_absent_tools ?? "");

  const sections = splitSections(body);
  const turns: string[] = [];
  let purpose = "";
  for (const section of sections) {
    if (/^ターン\s*\d+/.test(section.heading)) {
      const prompt = extractQuoted(section.body);
      if (prompt === "") {
        throw new Error(`「## ${section.heading}」に引用行(> で始まる行)がありません。`);
      }
      turns.push(prompt);
    } else if (section.heading === "目的") {
      purpose = section.body.trim();
    }
  }
  if (turns.length === 0) {
    throw new Error("「## ターン1」形式のセクションが1つもありません。");
  }

  return { id, title, purpose, allowedTools, disallowedTools, expectedAbsentTools, turns };
}

/** `key: value` だけの最小 frontmatter。YAML の全機能は要らない。 */
function parseFrontmatter(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf(":");
    if (at < 0) throw new Error(`frontmatter の行が "key: value" 形式ではありません: ${trimmed}`);
    result[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
  }
  return result;
}

function requireKey(front: Record<string, string>, key: string): string {
  const value = front[key];
  if (value === undefined || value === "") {
    throw new Error(`frontmatter に必須キー "${key}" がありません。`);
  }
  return value;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

function splitSections(body: string): { heading: string; body: string }[] {
  const sections: { heading: string; body: string }[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  for (const line of body.split("\n")) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading !== null) {
      if (current !== null)
        sections.push({ heading: current.heading, body: current.lines.join("\n") });
      current = { heading: (heading[1] ?? "").trim(), lines: [] };
    } else if (current !== null) {
      current.lines.push(line);
    }
  }
  if (current !== null) sections.push({ heading: current.heading, body: current.lines.join("\n") });
  return sections;
}

/** 引用行だけを取り出して1本のプロンプトにする。 */
function extractQuoted(body: string): string {
  return body
    .split("\n")
    .filter((line) => line.trimStart().startsWith(">"))
    .map((line) => line.trimStart().replace(/^>\s?/, ""))
    .join("\n")
    .trim();
}
