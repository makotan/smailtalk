import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * バリデーションCLIの統合テスト(V0-P1-T06)。
 *
 * CLIは「別プロセスとして起動して exit code と標準出力を見る」ものなので、
 * 関数を直接呼ぶのではなく実際にサブプロセスとして実行して検証する。
 * ここが壊れると以降のフェーズの人間のデバッグ手段が失われる。
 */

const ROOT = join(import.meta.dir, "..", "..");
const CLI = join(ROOT, "src", "cli", "validate.ts");
const FIXTURES = join(ROOT, "fixtures");

/** 終了コードの契約。 */
const EXIT_OK = 0;
const EXIT_INVALID = 1;
const EXIT_INPUT_ERROR = 2;

type RunResult = { code: number; stdout: string; stderr: string };

async function runCli(...args: string[]): Promise<RunResult> {
  const proc = Bun.spawn([process.execPath, "run", CLI, ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

function fixture(relative: string): string {
  return join(FIXTURES, relative);
}

/** 壊れた入力など、フィクスチャに置きたくない一時ファイルの置き場。 */
const TEMP_DIR = mkdtempSync(join(tmpdir(), "gp-validate-cli-"));

describe("validate CLI: 正常系", () => {
  test("正常なマニフェストは exit 0 で成功メッセージを出す", async () => {
    const result = await runCli(fixture("valid/book-tracker.json"));
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain("OK");
    expect(result.stdout).toContain("マニフェスト");
  });

  test("正常な diff は中身から自動判定して exit 0", async () => {
    const result = await runCli(fixture("valid/diff-all-ops.json"));
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain("OK");
    expect(result.stdout).toContain("差分パッチ");
  });

  test("--kind を明示しても通る", async () => {
    const result = await runCli(
      fixture("valid/inventory-all-field-types.json"),
      "--kind",
      "manifest",
    );
    expect(result.code).toBe(EXIT_OK);
  });

  test("--json で機械可読な成功出力を出す", async () => {
    const result = await runCli(fixture("valid/book-tracker.json"), "--json");
    expect(result.code).toBe(EXIT_OK);
    const parsed = JSON.parse(result.stdout) as { valid: boolean; kind: string };
    expect(parsed.valid).toBe(true);
    expect(parsed.kind).toBe("manifest");
  });
});

describe("validate CLI: 異常系", () => {
  test("参照切れのマニフェストは exit 1 で統一形式エラーを出す", async () => {
    const result = await runCli(fixture("invalid/broken-view-table.json"));
    expect(result.code).toBe(EXIT_INVALID);
    // パス・理由・許可値の3点が揃っていること(handover 3.8)。
    expect(result.stdout).toContain("/app/views/0/table");
    expect(result.stdout).toContain("存在しません");
    expect(result.stdout).toContain("許可される値: books");
  });

  test("語彙外フィールド型のマニフェストは exit 1 で許可値一覧を出す", async () => {
    const result = await runCli(fixture("invalid/unknown-field-type.json"));
    expect(result.code).toBe(EXIT_INVALID);
    expect(result.stdout).toContain("/app/tables/0/fields/1/type");
    expect(result.stdout).toContain(
      "text / long_text / number / boolean / date / select / reference",
    );
  });

  test("intent 欠落の diff は --kind diff で exit 1", async () => {
    const result = await runCli(fixture("invalid/diff-missing-intent.json"), "--kind", "diff");
    expect(result.code).toBe(EXIT_INVALID);
    expect(result.stdout).toContain("intent");
  });

  test("未知 op の diff は自動判定でも exit 1", async () => {
    const result = await runCli(fixture("invalid/diff-unknown-op.json"));
    expect(result.code).toBe(EXIT_INVALID);
    expect(result.stdout).toContain("/operations/0/op");
    expect(result.stdout).toContain("add_table / add_field / add_view / update_view");
  });

  test("--json で機械可読なエラー出力を出す", async () => {
    const result = await runCli(fixture("invalid/broken-view-table.json"), "--json");
    expect(result.code).toBe(EXIT_INVALID);
    const parsed = JSON.parse(result.stdout) as {
      valid: boolean;
      errors: { path: string; message: string; allowed_values?: string[] }[];
    };
    expect(parsed.valid).toBe(false);
    expect(parsed.errors[0]?.path).toBe("/app/views/0/table");
    // view.table の候補には読み取り専用のシステムテーブルも含む(ADR-0006 §9)。
    expect(parsed.errors[0]?.allowed_values).toEqual(["books", "_apps", "_changelog", "_ai_usage"]);
  });
});

describe("validate CLI: 入力エラー", () => {
  test("存在しないファイルは exit 2 で分かりやすいエラーを出す", async () => {
    const result = await runCli(fixture("valid/does-not-exist.json"));
    expect(result.code).toBe(EXIT_INPUT_ERROR);
    expect(result.stdout).toContain("does-not-exist.json");
    expect(result.stdout).toContain("読み込めません");
  });

  test("JSONとして壊れたファイルは exit 2", async () => {
    const path = join(TEMP_DIR, "broken-fixture.json");
    await Bun.write(path, "{ this is not json ");
    const result = await runCli(path);
    expect(result.code).toBe(EXIT_INPUT_ERROR);
    expect(result.stdout).toContain("JSON");
  });

  test("引数なしは exit 2 で使い方を出す", async () => {
    const result = await runCli();
    expect(result.code).toBe(EXIT_INPUT_ERROR);
    expect(result.stdout).toContain("使い方");
  });

  test("--kind の値が不正なら exit 2 で許可値を出す", async () => {
    const result = await runCli(fixture("valid/book-tracker.json"), "--kind", "schema");
    expect(result.code).toBe(EXIT_INPUT_ERROR);
    expect(result.stdout).toContain("manifest / diff");
  });

  test("app も operations も無いJSONは種別を判定できず exit 2", async () => {
    const path = join(TEMP_DIR, "unknown-kind.json");
    await Bun.write(path, JSON.stringify({ hello: "world" }));
    const result = await runCli(path);
    expect(result.code).toBe(EXIT_INPUT_ERROR);
    expect(result.stdout).toContain("判定できません");
  });
});
