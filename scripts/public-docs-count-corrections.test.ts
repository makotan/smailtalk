/**
 * 公開する文書のうち「全量」を名乗る語彙の一覧と、その本数が、今日の語彙の正と食い違っていないことを見る。
 *
 * 対象は、語彙の本数や名前の並びを「これが全量」と書いている4本だけである:
 *   - `README.md` の「書けるものの全量」
 *   - `CONTRIBUTING.md` の「このソフトウェアが扱える範囲(全量)について」
 *   - `.github/PULL_REQUEST_TEMPLATE.md` と `.github/ISSUE_TEMPLATE/feature_request.md` の同じ趣旨の段
 *
 * 作法: 旧い本数・旧い並びを書いた行は消さず、その下に訂正を書き足している。
 * したがってこの検査は「旧い本数が1つも無いこと」は見ない。見るのは次の2つだけである:
 *   (1) 名前を並べている文書に、定義を変える操作の今日の全部の名前が現れること
 *   (2) 本数を書いている文書に、今日の本数を書いた訂正の1文が在ること
 *
 * この検査がしないこと(誇張しない):
 *   - 訂正の1文が旧い行の近くに在るかは見ない(ファイルのどこかに在れば通る)。
 *   - 上の4本以外の文書は1つも見ない。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

/**
 * カーネルの配列を値として import しない(`src/kernel/` の外からの値 import は凍結スナップショットが見張っている)。
 * `src/kernel/types.ts` をテキストとして読み、`export const <名前> = [` から `] as const;` までの
 * 引用符つきの要素だけを取り出す(注釈の行は拾わない)。
 */
function kernelArray(name: string): string[] {
  const lines = read("src/kernel/types.ts").split("\n");
  const start = lines.findIndex((line) => line.startsWith(`export const ${name} = [`));
  const end = lines.findIndex((line, index) => index > start && line.startsWith("] as const;"));
  if (start < 0 || end < 0) {
    throw new Error(`src/kernel/types.ts から ${name} を取り出せなかった`);
  }
  return lines
    .slice(start + 1, end)
    .map((line) => /^\s*"([a-z_]+)",?\s*$/.exec(line)?.[1])
    .filter((value): value is string => value !== undefined);
}

const DIFF_OPS = kernelArray("DIFF_OPS");
const FIELD_TYPES = kernelArray("FIELD_TYPES");
const RESOURCE_KINDS = kernelArray("RESOURCE_KINDS");

/** 名前を並べている文書(操作の名前が全部現れること)。 */
const LISTS_NAMES = [
  "README.md",
  "CONTRIBUTING.md",
  ".github/ISSUE_TEMPLATE/feature_request.md",
] as const;

/** 本数を書いている文書(今日の本数を書いた訂正の1文が在ること)。 */
const STATES_COUNTS = [
  "CONTRIBUTING.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/ISSUE_TEMPLATE/feature_request.md",
] as const;

describe("公開文書の全量の一覧が今日の語彙と食い違っていない", () => {
  test("(数0)語彙の本数を取り出せる", () => {
    // 取り出しが壊れて 0 になると、下の検査が空の並びで素通りする。
    expect({
      リソース: RESOURCE_KINDS.length,
      型: FIELD_TYPES.length,
      操作: DIFF_OPS.length,
      // 【`V22-M2-T03b` / `ADR-0486`(門A)/ 授権 = `ADR-0487` 行26】旧(逐語): `}).toEqual({ リソース: 8, 型: 9, 操作: 18 });` —— 19種目 `set_workspace` を足したので 操作 18 → 19(別の決定)。
    }).toEqual({ リソース: 8, 型: 9, 操作: 19 });
  });

  for (const path of LISTS_NAMES) {
    test(`(数1)${path} に定義を変える操作の名前が全部現れる`, () => {
      const doc = read(path);
      const missing = DIFF_OPS.filter((op) => !doc.includes(op));
      expect({ 文書: path, 無い名前: missing }).toEqual({ 文書: path, 無い名前: [] });
    });
  }

  for (const path of STATES_COUNTS) {
    test(`(数2)${path} に今日の操作の本数を書いた訂正が在る`, () => {
      const doc = read(path);
      const sentence = `定義を変える操作は今日${DIFF_OPS.length}種`;
      expect({ 文書: path, 在る: doc.includes(sentence) }).toEqual({ 文書: path, 在る: true });
    });
  }
});

/**
 * 追記(同じ日)。AI にも配る差分のスキーマ `schemas/diff.schema.json` の先頭の `description` は
 * 「op は … の計9種」と書いたまま残っている。旧文は消さず、同じ `description` の末尾に訂正を足した。
 * ここで見るのは、その訂正が今日の操作の本数を書いていることだけである(旧文の有無は見ない)。
 */
describe("差分のスキーマの先頭の説明が今日の操作の本数を書いている", () => {
  test("(数3)diff.schema.json の先頭の description に今日の本数の訂正が在る", () => {
    const schema = JSON.parse(read("schemas/diff.schema.json")) as { description: string };
    const sentence = `op は今日${DIFF_OPS.length}種である`;
    expect({ 在る: schema.description.includes(sentence) }).toEqual({ 在る: true });
  });
});

/**
 * 追記(同じ日。点検の後の直し)。
 * (数4)公開する `MANUAL.md` の「できないこと」の表は「ボタンの体裁も語彙に無い」と書いたまま残っている。
 *   詳細画面のボタンの見た目の強さ(主・副・危険)は今日は選べるので、同じ欄の末尾に訂正を足した。旧文の有無は見ない。
 * (設1)説明書の参照ファイル `design-candidates.md` の軸の表で、`preset_field_columns` の「書ける画面」の欄が
 *   正準スキーマ(`$defs/view.allOf` の分岐で `false` にされていない画面)と一致すること。
 *   見るのはこの1行だけで、表のほかの行は見ない。
 */
describe("点検の後の直し(ボタンの見た目の強さ・段組の書ける画面)", () => {
  test("(数4)MANUAL.md の「ボタンの体裁も語彙に無い」の欄に、詳細画面のボタンの見た目の強さは選べるという訂正が在る", () => {
    const doc = read("MANUAL.md");
    const row = doc.split("\n").find((line) => line.includes("ボタンの体裁も語彙に無い"));
    expect(row).toBeDefined();
    expect(row).toContain(
      "詳細画面のボタンの見た目の強さ(主・副・危険)は今日は選べる(`action_emphasis`。一覧の行のボタンには書けない)",
    );
  });

  test("(設1)design-candidates.md の preset_field_columns の書ける画面が、正準スキーマと一致する", () => {
    type Branch = {
      if?: { properties?: { type?: { const?: string } } };
      then?: { properties?: Record<string, unknown> };
    };
    const schema = JSON.parse(read("schemas/manifest.schema.json")) as {
      $defs: { view: { allOf: Branch[] }; view_type: { enum: string[] } };
    };
    const closed = new Set(
      schema.$defs.view.allOf
        .filter((branch) => branch.then?.properties?.preset_field_columns === false)
        .map((branch) => branch.if?.properties?.type?.const),
    );
    const expected = schema.$defs.view_type.enum.filter((type) => !closed.has(type)).sort();
    const doc = read("plugins/smailtalk/skills/view-shape/reference/design-candidates.md");
    const row = doc
      .split("\n")
      .find((line) => line.startsWith("|") && line.includes("`preset_field_columns`"));
    expect(row).toBeDefined();
    const cells = (row as string).split("|").map((cell) => cell.trim());
    const screens = (cells[cells.length - 2] ?? "")
      .split("/")
      .map((s) => s.trim())
      .sort();
    expect({ 書ける画面: screens }).toEqual({ 書ける画面: expected });
  });
});
