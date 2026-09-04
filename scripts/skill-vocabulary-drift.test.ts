/**
 * `V6-M13-T01`(`H-G5` / `H-G19`): **配布物(plugin 同梱の skill)の記述と、語彙の正とが
 * 黙って食い違わないようにするための突き合わせ検査。**
 *
 * 上位: `docs/plan/v6/records/v6-m8.md` §5-5(`H-G5` 本審査。門外。限定採用)/ §5-19(`H-G19`。同)/
 *       §6-1(問2③ で「生成器を作る側」と「突き合わせ検査を置く側」を比べ、後者を採った)/
 *       §8-5 の `V6-M13-T01` 完了条件 /
 *       `docs/plan/v6/records/v6-m10.md` §6-3(**本検査への申し送り3点**)/
 *       `docs/plan/v6/records/v6-m13.md`(本タスクの実施記録)。
 *
 * ## 何を守るのか
 *
 * skill は語彙の名前・キー・値域を**人手で書き写した**文書である(`V6-M10` は生成器を
 * 1本も作らないと決めた)。したがって **正(`src/kernel/types.ts` の3配列と
 * `schemas/*.json`)が動いた日に、skill だけが古いまま残る。** ここがその検出である。
 *
 * ## `V6-M10` からの申し送り3点(同 §6-3)への対応
 *
 * 1. **語彙の名前の一覧との突き合わせ** → `closed` 行と `covers` 行。
 * 2. **skill の引用ブロックが `CANNOT_DO` の部分文字列であることの照合**
 *    (`H-G20` の限定2。**`V6-M10` は一時スクリプトで1回測っただけだった**)→ `verbatim` 行。
 *    **本検査で常設化した。**
 * 3. **数値リテラルを1つも書かない**(`H-G19` 限定4 / `ADR-0250` §Decision 3 の 3)
 *    → **このファイルに数値リテラルは1つも無い。** 件数は必ず正の側から `.length` で導く。
 *    `{n+1}` の類も、番兵を1つ足した配列の長さとして出している(下の `resolveTemplate`)。
 *
 * ## 一覧(`scripts/skill-vocabulary-inventory.txt`)の行の種類
 *
 * | 種別 | 列 | 何を固定するか |
 * |---|---|---|
 * | `closed` | パス / 見出しの型 / 抽出規則 / 順序 / 正の集合式 | **その節の列挙が正と過不足なく一致する**(両向き) |
 * | `allow` | パス / 見出しの型 / 語 / 理由 | **その節に意図して置いた語彙外の語**(反例・表の見出しなど) |
 * | `covers` | パス / 正の集合式 | **その集合の名前が全部そのファイルに現れる**(片向き) |
 * | `count` | パス / 逐語の型 / 正の集合式 | **散文に書いた件数が正の件数と一致する** |
 * | `verbatim` | パス / 正の定数名 | **そのファイルの引用ブロックが全部その定数の部分文字列である** |
 * | `pair` | パス / 逐語A / 逐語B / 理由 | **逐語A を載せたファイルには逐語B も必ず在る**(片向き) |
 *
 * **`{n}` は集合の件数、`{n+1}` は件数の次の数に展開される。** どちらも一覧側にも
 * 検査側にも数字を書かずに済ませるための仕掛けである。
 *
 * ## `pair` 行を足した理由(`V8-M22` / 台帳 `J-G35`。2026-08-10)
 *
 * **`CANNOT_DO` の中の1文が今日は偽になったとき、このリポジトリの作法は「旧文を1バイトも
 * 消さず、直後に訂正を足す」である**(`ADR-0055` / `ADR-0095` / `ADR-0300` / `ADR-0301` 限定8)。
 * **その作法は `CANNOT_DO` の中では成立するが、説明書(skill)は `CANNOT_DO` を**切り出して**
 * 引く。** **切り出す範囲が旧文で終わっていると、説明書だけを読む相手には訂正が1文字も届かない。**
 * **`verbatim` はそれを検出できない** —— **旧文だけの引用も、立派に `CANNOT_DO` の部分文字列
 * だからである。** **`pair` はその穴だけを塞ぐ。**
 *
 * **`pair` がしないこと**: **訂正が正しいかを1文字も見ていない**(見ているのは「同じファイルに
 * 在るか」だけである)。**`pair` 行を書き忘れた組を検出しない** —— **一覧に書いた組しか見ない。**
 *
 * ## この検査が測っていないもの(**先に書く。誇張しない**)
 *
 * - **散文が正しいかどうかを測っていない。** 測るのは名前と、`{n}` で名指しした件数と、
 *   **`pair` 行に書いた2つの逐語の同居**だけである(`H-G19` の `S3`(a) が先に書いた限界に、
 *   `V8-M22` が `pair` の分を足した)。**言い回し・例示・狙いの説明は1文字も見ていない。**
 * - **赤くなったときに、直すべきが skill か正かを判定しない**(同 `S3`(c))。
 * - **`description` が実際に発火するかを1度も測っていない**(測るのは `V6-M14`)。
 * - **skill 本文が実装より広く読めないかどうかを見ていない** —— それは
 *   `scripts/skill-industry-words.test.ts`(業種依存語の不在)の担当で、**本検査とは別の1本**である。
 * - **一覧の更新は人間が行う。** 「赤くなったので一覧を書き換えた」だけで通せる穴は、
 *   `scripts/vocabulary-drift.test.ts` の doc コメントが先に申告したものと同じで、
 *   **本検査が新しく作る穴ではないが、塞いでもいない。**
 *
 * ## `scripts/vocabulary-drift.test.ts` との関係(`H-G15`)
 *
 * **あちらは1バイトも書き換えていない**(`H-G19` 限定5)。あちらは**正の側**(カーネルの3配列と
 * スキーマのキー)が一覧と一致するかを見る。**こちらは skill の側**が正と一致するかを見る。
 * **読むファイルの集合が交わらない**(`scripts/kernel-import-drift.test.ts` の doc コメントが
 * 提供側/消費側について書いたのと同じ形である)。
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
// **静的 import である**(`scripts/vocabulary-drift.test.ts` が `V5-M29-T06` で動的から静的へ
// 戻したのと同じ理由 —— `scripts/kernel-import-snapshot.txt` に層またぎを載せるため)。
import { DIFF_OPS, FIELD_TYPES, RESOURCE_KINDS } from "../src/kernel/types.ts";
import { CANNOT_DO } from "../src/mcp/vocabulary.ts";

const REPO_ROOT = dirname(import.meta.dir);
const SKILLS_ROOT = join(REPO_ROOT, "plugins", "smailtalk", "skills");
const INVENTORY_PATH = join(import.meta.dir, "skill-vocabulary-inventory.txt");

/** `{n+1}` を数字を書かずに出すための番兵。**値そのものは使わない。** */
const SENTINEL = "__sentinel__";

type JsonNode = {
  properties?: Record<string, JsonNode>;
  additionalProperties?: JsonNode;
  enum?: readonly (string | number)[];
  $defs?: Record<string, JsonNode>;
};

function readSchema(fileName: string): JsonNode {
  return JSON.parse(readFileSync(join(REPO_ROOT, "schemas", fileName), "utf-8")) as JsonNode;
}

const manifestDefs = readSchema("manifest.schema.json").$defs ?? {};
const diffDefs = readSchema("diff.schema.json").$defs ?? {};

function propertyNames(def: JsonNode | undefined): readonly string[] {
  return Object.keys(def?.properties ?? {});
}

function enumValues(def: JsonNode | undefined): readonly string[] {
  const direct = def?.enum ?? def?.additionalProperties?.enum ?? [];
  return direct.map((value) => String(value));
}

/**
 * `V8-M47`: **配列の `items` と `required` を取り出すための最小の拡張。**
 * **`JsonNode` を1バイトも書き換えずに済ませるため、交差型で受け直している。**
 */
type SchemaNode = JsonNode & { items?: JsonNode; required?: readonly string[] };

/** 配列定義の `items`(**1段だけ降りる**)。 */
function itemsOf(def: JsonNode | undefined): JsonNode | undefined {
  return (def as SchemaNode | undefined)?.items;
}

/** その定義の `required`(**無ければ空**)。 */
function requiredNames(def: JsonNode | undefined): readonly string[] {
  return (def as SchemaNode | undefined)?.required ?? [];
}

/** 表の定義の `access_control`(**`V8-M47` の説明書が全量を書いた先**)。 */
const ACCESS_CONTROL = manifestDefs.table?.properties?.access_control;

/** 役割(`app.roles[]`)の1件の定義。**`$defs` ではなくインラインで書かれている。** */
const ROLE_ITEM = itemsOf(manifestDefs.app?.properties?.roles);

/** 画面定義のうち `preset_` で始まるキー(**宣言順のまま**)。 */
const PRESET_KEYS = propertyNames(manifestDefs.view).filter((key) => key.startsWith("preset_"));

/**
 * 正の集合の登録簿。**すべて `src/kernel/types.ts` と `schemas/*.json` から導いている。**
 * **名前を1つも手書きしていない**(キー名だけがこのファイルの字面である)。
 */
const VOCABULARY_SETS: Record<string, readonly string[]> = {
  "kernel:RESOURCE_KINDS": RESOURCE_KINDS,
  "kernel:FIELD_TYPES": FIELD_TYPES,
  "kernel:DIFF_OPS": DIFF_OPS,
  "diff:operation.properties": propertyNames(diffDefs.operation),
  "diff:view_changes.properties": propertyNames(diffDefs.view_changes),
  "diff:table_changes.properties": propertyNames(diffDefs.table_changes),
  "diff:field_changes.properties": propertyNames(diffDefs.field_changes),
  "manifest:table.properties": propertyNames(manifestDefs.table),
  "manifest:field.properties": propertyNames(manifestDefs.field),
  "manifest:view.properties": propertyNames(manifestDefs.view),
  "manifest:view.preset_properties": PRESET_KEYS,
  // **`preset_` の選べる値の全量。** 同じ値が別のキーに現れる(`standard` が2箇所)ので、
  // キー名で修飾して一意にしてある。**件数の突き合わせ(`count`)にだけ使う。**
  "manifest:view.preset_option_values": PRESET_KEYS.flatMap((key) =>
    enumValues(manifestDefs.view?.properties?.[key]).map((value) => `${key}:${value}`),
  ),
  "manifest:view_type.enum": enumValues(manifestDefs.view_type),
  "manifest:workflow.properties": propertyNames(manifestDefs.workflow),
  "manifest:workflow_action.properties": propertyNames(manifestDefs.workflow_action),
  "manifest:workflow_action.action.enum": enumValues(
    manifestDefs.workflow_action?.properties?.action,
  ),
  "manifest:workflow_trigger.type.enum": enumValues(
    manifestDefs.workflow_trigger?.properties?.type,
  ),
  "manifest:function.properties": propertyNames(manifestDefs.function),
  "manifest:function_input.source.enum": enumValues(
    manifestDefs.function_input?.properties?.source,
  ),
  // **`V8-M47`(既存の説明書3本への追記)で名指しした集合。** 名前は1つも手書きしていない。
  "manifest:table.access_control.properties": propertyNames(ACCESS_CONTROL),
  "manifest:table.access_control.required": requiredNames(ACCESS_CONTROL),
  "manifest:access_control.grant.properties": propertyNames(ACCESS_CONTROL?.properties?.grant),
  "manifest:access_control.grant.required": requiredNames(ACCESS_CONTROL?.properties?.grant),
  "manifest:access_control.members.properties": propertyNames(ACCESS_CONTROL?.properties?.members),
  "manifest:access_control.members.required": requiredNames(ACCESS_CONTROL?.properties?.members),
  "manifest:access_control.groups.properties": propertyNames(ACCESS_CONTROL?.properties?.groups),
  "manifest:access_control.permission.properties": propertyNames(
    itemsOf(ACCESS_CONTROL?.properties?.permissions),
  ),
  "manifest:view_action.properties": propertyNames(manifestDefs.view_action),
  "manifest:filter_leaf.properties": propertyNames(manifestDefs.filter_leaf),
  "manifest:role.properties": propertyNames(ROLE_ITEM),
  "manifest:role.signup.enum": enumValues(ROLE_ITEM?.properties?.signup),
};

/** 語彙の正の定数(`verbatim` 行が名指しする先)。 */
const VERBATIM_SOURCES: Record<string, string> = { CANNOT_DO };

/** `a+b` を連結して1つの期待列にする(**宣言順のまま。ソートしない**)。 */
function resolveSetExpression(expression: string): readonly string[] {
  return expression.split("+").flatMap((name) => {
    const found = VOCABULARY_SETS[name.trim()];
    if (found === undefined) throw new Error(`一覧が知らない集合名: ${name}`);
    return [...found];
  });
}

/** `{n}` / `{n+1}` を正の件数から展開する。**数字を1文字も書かない。** */
function resolveTemplate(template: string, names: readonly string[]): string {
  const next = [...names, SENTINEL];
  return template.replaceAll("{n+1}", String(next.length)).replaceAll("{n}", String(names.length));
}

function headingLevel(line: string): number | undefined {
  const [, hashes] = /^(#+)/.exec(line) ?? [];
  return hashes === undefined ? undefined : hashes.length;
}

/** 見出し行の**次**から、同じか上の階層の見出しが来るまでを返す。見つからなければ `undefined`。 */
function regionOf(text: string, heading: string): readonly string[] | undefined {
  let level: number | undefined;
  const collected: string[] = [];
  for (const line of text.split("\n")) {
    if (level === undefined) {
      if (line.startsWith(heading)) level = headingLevel(line);
      continue;
    }
    const here = headingLevel(line);
    if (here !== undefined && here <= level) break;
    collected.push(line);
  }
  return level === undefined ? undefined : collected;
}

/** 行内コード(`` `x` ``)を**出現順のまま**取り出す。 */
function codeSpans(text: string): readonly string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map(([, inner]) => inner ?? "");
}

/** 表の各行の**先頭の**行内コードだけを取り出す(表の第1列が名前である節のため)。 */
function rowHeadSpans(lines: readonly string[]): readonly string[] {
  const heads: string[] = [];
  for (const line of lines) {
    if (!line.trimStart().startsWith("|")) continue;
    const [first] = codeSpans(line);
    if (first !== undefined) heads.push(first);
  }
  return heads;
}

type Extraction = "spans" | "rowhead";

function extract(lines: readonly string[], rule: Extraction): readonly string[] {
  return rule === "rowhead" ? rowHeadSpans(lines) : codeSpans(lines.join("\n"));
}

/** 引用ブロック(`>` 始まりの連続行)を1件ずつ取り出す。 */
function quoteBlocks(text: string): readonly string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith(">")) {
      current.push(line.replace(/^>\s?/, ""));
      continue;
    }
    if (current.some(() => true)) blocks.push(current.join("\n"));
    current = [];
  }
  if (current.some(() => true)) blocks.push(current.join("\n"));
  return blocks;
}

type ClosedRow = {
  path: string;
  heading: string;
  rule: Extraction;
  ordered: boolean;
  expression: string;
};
type AllowRow = { path: string; heading: string; span: string; reason: string };
type CoversRow = { path: string; expression: string };
type CountRow = { path: string; template: string; expression: string };
type VerbatimRow = { path: string; source: string };
/** `V8-M22` / `J-G35`: **偽になった旧文だけを切り出して配らない**ための組。 */
type PairRow = { path: string; left: string; right: string; reason: string };

const closedRows: ClosedRow[] = [];
const allowRows: AllowRow[] = [];
const coversRows: CoversRow[] = [];
const countRows: CountRow[] = [];
const verbatimRows: VerbatimRow[] = [];
const pairRows: PairRow[] = [];

for (const raw of readFileSync(INVENTORY_PATH, "utf-8").split("\n")) {
  const line = raw.trimEnd();
  if (line.trim() === "" || line.startsWith("#")) continue;
  const [kind, ...rest] = line.split("\t");
  if (kind === "closed") {
    const [path, heading, rule, order, expression] = rest;
    closedRows.push({
      path: path ?? "",
      heading: heading ?? "",
      rule: rule === "rowhead" ? "rowhead" : "spans",
      ordered: order === "ordered",
      expression: expression ?? "",
    });
  } else if (kind === "allow") {
    const [path, heading, span, reason] = rest;
    allowRows.push({
      path: path ?? "",
      heading: heading ?? "",
      span: span ?? "",
      reason: reason ?? "",
    });
  } else if (kind === "covers") {
    const [path, expression] = rest;
    coversRows.push({ path: path ?? "", expression: expression ?? "" });
  } else if (kind === "count") {
    const [path, template, expression] = rest;
    countRows.push({ path: path ?? "", template: template ?? "", expression: expression ?? "" });
  } else if (kind === "verbatim") {
    const [path, source] = rest;
    verbatimRows.push({ path: path ?? "", source: source ?? "" });
  } else if (kind === "pair") {
    const [path, left, right, reason] = rest;
    pairRows.push({
      path: path ?? "",
      left: left ?? "",
      right: right ?? "",
      reason: reason ?? "",
    });
  } else {
    throw new Error(`一覧が知らない行の種類: ${kind}`);
  }
}

function readSkill(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf-8");
}

function collectMarkdown(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...collectMarkdown(full));
    else if (entry.endsWith(".md")) found.push(full);
  }
  return found.sort();
}

const skillFiles = collectMarkdown(SKILLS_ROOT).map((file) =>
  relative(REPO_ROOT, file).replaceAll("\\", "/"),
);

// --- 一覧そのものの健全性 ---

test("一覧が1行以上読める(0行なら本検査は何も測っていない)", () => {
  expect([...closedRows, ...coversRows, ...countRows, ...verbatimRows, ...pairRows]).not.toEqual(
    [],
  );
});

test("skill 本文が1本以上見つかる", () => {
  expect(skillFiles).not.toEqual([]);
});

test("一覧が実在しない skill ファイルを指していない", () => {
  const known = new Set(skillFiles);
  const declared = [...closedRows, ...coversRows, ...countRows, ...verbatimRows, ...pairRows].map(
    (row) => row.path,
  );
  expect([...new Set(declared)].filter((path) => !known.has(path))).toEqual([]);
});

test("skill 本文が1本残らず一覧に現れる(新しい説明書を黙って足せない)", () => {
  const declared = new Set(
    [...closedRows, ...coversRows, ...countRows, ...verbatimRows, ...pairRows].map(
      (row) => row.path,
    ),
  );
  expect(skillFiles.filter((path) => !declared.has(path))).toEqual([]);
});

test("`allow` 行には必ず理由が書いてある(黙って除外しない)", () => {
  expect(allowRows.filter((row) => row.reason.trim() === "")).toEqual([]);
});

// --- `closed`: 節の列挙が正と過不足なく一致するか(両向き) ---

for (const row of closedRows) {
  const label = `${row.path} :: ${row.heading} [${row.expression}]`;

  test(`${label}: 節が実在する`, () => {
    const expected = resolveSetExpression(row.expression);
    const heading = resolveTemplate(row.heading, expected);
    expect(
      regionOf(readSkill(row.path), heading),
      `見出しが見つからない: ${heading}`,
    ).toBeDefined();
  });

  test(`${label}: 正に在る名前が1つ残らず節に書いてある`, () => {
    const expected = resolveSetExpression(row.expression);
    const heading = resolveTemplate(row.heading, expected);
    const found = new Set(extract(regionOf(readSkill(row.path), heading) ?? [], row.rule));
    expect(expected.filter((name) => !found.has(name))).toEqual([]);
  });

  test(`${label}: 節に、正に無い名前が書かれていない(宣言したものを除く)`, () => {
    const expected = resolveSetExpression(row.expression);
    const heading = resolveTemplate(row.heading, expected);
    const expectedSet = new Set(expected);
    const allowed = new Set(
      allowRows
        .filter((allow) => allow.path === row.path && allow.heading === row.heading)
        .map((allow) => allow.span),
    );
    const actual = extract(regionOf(readSkill(row.path), heading) ?? [], row.rule);
    expect(
      [...new Set(actual)].filter((span) => !expectedSet.has(span) && !allowed.has(span)),
    ).toEqual([]);
  });

  if (row.ordered) {
    test(`${label}: 節の並びが正の並びと一致する(順序ごと比べる)`, () => {
      const expected = resolveSetExpression(row.expression);
      const heading = resolveTemplate(row.heading, expected);
      const expectedSet = new Set(expected);
      const seen = new Set<string>();
      const actualOrder = extract(regionOf(readSkill(row.path), heading) ?? [], row.rule).filter(
        (span) => {
          if (!expectedSet.has(span) || seen.has(span)) return false;
          seen.add(span);
          return true;
        },
      );
      expect(actualOrder).toEqual([...expected]);
    });
  }
}

test("`allow` 行が、実在する `closed` 行を指している(古い宣言が残っていない)", () => {
  const declared = new Set(closedRows.map((row) => `${row.path}\t${row.heading}`));
  expect(allowRows.filter((row) => !declared.has(`${row.path}\t${row.heading}`))).toEqual([]);
});

test("`allow` に書いた語が今も節に実在する(消えた反例の宣言を残さない)", () => {
  const stale: string[] = [];
  for (const row of allowRows) {
    const closed = closedRows.find(
      (candidate) => candidate.path === row.path && candidate.heading === row.heading,
    );
    if (closed === undefined) continue;
    const expected = resolveSetExpression(closed.expression);
    const heading = resolveTemplate(closed.heading, expected);
    const actual = extract(regionOf(readSkill(row.path), heading) ?? [], closed.rule);
    if (!actual.some((span) => span === row.span)) stale.push(`${row.path} :: ${row.span}`);
  }
  expect(stale).toEqual([]);
});

// --- `covers`: 集合の名前が全部そのファイルに現れるか(片向き) ---

for (const row of coversRows) {
  test(`${row.path}: ${row.expression} の名前が1つ残らず本文に現れる`, () => {
    const found = new Set(codeSpans(readSkill(row.path)));
    expect(resolveSetExpression(row.expression).filter((name) => !found.has(name))).toEqual([]);
  });
}

// --- `count`: 散文に書いた件数が正の件数と一致するか ---

for (const row of countRows) {
  test(`${row.path}: 件数の記述「${row.template}」が正と一致する`, () => {
    const resolved = resolveTemplate(row.template, resolveSetExpression(row.expression));
    expect(readSkill(row.path), `この字面が本文に無い: ${resolved}`).toContain(resolved);
  });
}

// --- `verbatim`: 引用ブロックが語彙の正の逐語であるか(`H-G20` 限定2 の常設化) ---

for (const row of verbatimRows) {
  test(`${row.path}: 引用ブロックが ${row.source} の逐語である`, () => {
    const source = VERBATIM_SOURCES[row.source];
    expect(source, `一覧が知らない定数名: ${row.source}`).toBeDefined();
    const blocks = quoteBlocks(readSkill(row.path));
    expect(blocks, "引用ブロックが1件も無い").not.toEqual([]);
    expect(blocks.filter((block) => !(source ?? "").includes(block))).toEqual([]);
  });
}

// --- `pair`: 偽になった旧文だけを切り出して配っていないか(`V8-M22` / `J-G35`) ---

for (const row of pairRows) {
  test(`${row.path}: 「${row.left}」を載せたなら「${row.right}」も載っている`, () => {
    const text = readSkill(row.path);
    // **左が消えていたら、この行は古い宣言である**(`allow` 行と同じ扱いで、黙って通さない)。
    expect(text, `逐語A が本文に無い(一覧の行が古い): ${row.left}`).toContain(row.left);
    expect(text, `逐語B が本文に無い(訂正が届いていない): ${row.right}`).toContain(row.right);
  });
}

test("`pair` 行には必ず理由が書いてある(黙って組を作らない)", () => {
  expect(pairRows.filter((row) => row.reason.trim() === "")).toEqual([]);
});

test("歯9: `pair` は逐語B が消えたら赤になる", () => {
  const [first] = pairRows;
  expect(first, "pair 行が無いと歯9 は何も測らない").toBeDefined();
  const text = readSkill(first?.path ?? "");
  // **加工するのは読み込んだ複製であって、実ファイルではない**(歯1〜歯8 と同じ作法)。
  const tampered = text.replaceAll(first?.right ?? "", "");
  expect(tampered.includes(first?.left ?? "")).toBe(true);
  expect(tampered.includes(first?.right ?? "")).toBe(false);
});

test("`verbatim` を宣言していない skill 本文に引用ブロックが無い(照合外の引用を作らない)", () => {
  const declared = new Set(verbatimRows.map((row) => row.path));
  const undeclared = skillFiles
    .filter((path) => !declared.has(path))
    .filter((path) => quoteBlocks(readSkill(path)).some(() => true));
  expect(undeclared).toEqual([]);
});

// --- 歯があることの自己検査(**加工するのは読み込んだ複製であって、実ファイルではない**) ---

const TOOTH_ROW = closedRows.find((row) => row.ordered);

test("歯0: 順序まで見ている `closed` 行が一覧に1本以上ある", () => {
  expect(TOOTH_ROW, "ordered の closed 行が無いと歯1〜歯4 が何も測らない").toBeDefined();
});

function toothMaterial(): {
  expected: readonly string[];
  actual: readonly string[];
  allowed: ReadonlySet<string>;
} {
  const row = TOOTH_ROW ?? { path: "", heading: "", rule: "spans" as const, expression: "" };
  const expected = resolveSetExpression(row.expression);
  const heading = resolveTemplate(row.heading, expected);
  const allowed = new Set(
    allowRows
      .filter((allow) => allow.path === row.path && allow.heading === row.heading)
      .map((allow) => allow.span),
  );
  return {
    expected,
    actual: extract(regionOf(readSkill(row.path), heading) ?? [], row.rule),
    allowed,
  };
}

/** 節の抽出結果と正を突き合わせ、食い違いがあれば `false` を返す(3種を一度に見る)。 */
function agrees(
  actual: readonly string[],
  expected: readonly string[],
  allowed: ReadonlySet<string>,
): boolean {
  const expectedSet = new Set(expected);
  const found = new Set(actual);
  const missing = expected.filter((name) => !found.has(name));
  const extra = [...found].filter((span) => !expectedSet.has(span) && !allowed.has(span));
  const seen = new Set<string>();
  const order = actual.filter((span) => {
    if (!expectedSet.has(span) || seen.has(span)) return false;
    seen.add(span);
    return true;
  });
  const misordered = order.some((name, index) => name !== expected[index]);
  return !missing.some(() => true) && !extra.some(() => true) && !misordered;
}

test("歯1: 今の skill と正は食い違っていない(自己検査の土台)", () => {
  const { expected, actual, allowed } = toothMaterial();
  expect(agrees(actual, expected, allowed)).toBe(true);
});

test("歯2: skill 側の名前を1つ改名すると赤になる", () => {
  const { expected, actual, allowed } = toothMaterial();
  const [first, ...rest] = actual;
  expect(agrees([`${first ?? ""}-renamed-by-self-check`, ...rest], expected, allowed)).toBe(false);
});

test("歯3: skill 側から名前を1つ落とすと赤になる", () => {
  const { expected, actual, allowed } = toothMaterial();
  const [, ...withoutFirst] = actual;
  expect(agrees(withoutFirst, expected, allowed)).toBe(false);
});

test("歯4: skill 側に語彙に無い名前を1つ足すと赤になる", () => {
  const { expected, actual, allowed } = toothMaterial();
  expect(agrees([...actual, "self-check:added-name"], expected, allowed)).toBe(false);
});

test("歯5: 正の側が1つ増えたのに skill が追随していなければ赤になる", () => {
  const { expected, actual, allowed } = toothMaterial();
  expect(agrees(actual, [...expected, "self-check:new-vocabulary"], allowed)).toBe(false);
});

test("歯6: 名前の集合が同じでも並びが入れ替わったら赤になる(順序ごと比べていることの実測)", () => {
  const { expected, actual, allowed } = toothMaterial();
  const [first, second, ...rest] = expected;
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  const swapped = [second ?? "", first ?? "", ...rest];
  // 名前の集合は同じである —— それでも赤になるのが「順序ごと」の意味である。
  expect(new Set(swapped)).toEqual(new Set(expected));
  expect(agrees(actual, swapped, allowed)).toBe(false);
});

test("歯7: 引用ブロックを1文字書き換えると逐語照合が赤になる", () => {
  const [firstVerbatim] = verbatimRows;
  expect(firstVerbatim).toBeDefined();
  const source = VERBATIM_SOURCES[firstVerbatim?.source ?? ""] ?? "";
  const [block] = quoteBlocks(readSkill(firstVerbatim?.path ?? ""));
  expect(block).toBeDefined();
  expect(source.includes(block ?? "")).toBe(true);
  expect(source.includes(`${block ?? ""}-tampered-by-self-check`)).toBe(false);
});

test("歯8: 件数の記述は、正の件数が変われば一致しなくなる", () => {
  const [firstCount] = countRows;
  expect(firstCount).toBeDefined();
  const expected = resolveSetExpression(firstCount?.expression ?? "");
  const text = readSkill(firstCount?.path ?? "");
  expect(text).toContain(resolveTemplate(firstCount?.template ?? "", expected));
  // **正が1つ増えた世界**の字面は、今日の本文には無い。
  expect(text).not.toContain(
    resolveTemplate(firstCount?.template ?? "", [...expected, "self-check:new-vocabulary"]),
  );
});
