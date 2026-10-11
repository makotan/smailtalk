import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 注意の文面・綴りに使わない3語(重大度の段を持つ別の仕組みと取り違えさせないため)。
 * **綴りを組み立てて書く** —— 逐語で書くと、製品コードの中の綴りを数える式
 * (`grep -rn '<綴り>' src web/src schemas`)がこの検査自身を数えてしまう。
 */
const FORBIDDEN_WORDS = [
  ["警", "告"].join(""),
  ["warn", "ings"].join(""),
  ["sever", "ity"].join(""),
];

/**
 * 画面の作りの点検コマンド(`bun run lint:design`)の統合テスト。
 *
 * `validate` の統合テストと同じく、別プロセスとして起こして終了コードと出力を見る。
 * **`bun run lint:design` 経由ではなく `bun src/cli/lint-design.ts` で直に起こす** ——
 * `bun run <script名>` は自分で標準エラーに1行を出すので、「標準エラーに1バイトも
 * 書かない」を撃てなくなるため。
 */

const ROOT = join(import.meta.dir, "..", "..");
const CLI = join(ROOT, "src", "cli", "lint-design.ts");
const FIXTURES = join(ROOT, "fixtures");

/** 終了コードの契約(`validate` と同じ3値)。 */
const EXIT_OK = 0;
const EXIT_INVALID = 1;
const EXIT_INPUT_ERROR = 2;

type RunResult = { code: number; stdout: string; stderr: string };

async function runCli(...args: string[]): Promise<RunResult> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
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

const TEMP_DIR = mkdtempSync(join(tmpdir(), "gp-lint-design-cli-"));
afterAll(() => {
  rmSync(TEMP_DIR, { recursive: true, force: true });
});

/**
 * 検証には通るが注意が2件出るマニフェスト(同梱の詳細画面の題材を写し、
 * 主ボタンを2つにし、ボタンを8個にしたもの)。
 */
function writeNoticeManifest(): string {
  const source = JSON.parse(
    readFileSync(fixture("valid/detail-action-emphasis.json"), "utf-8"),
  ) as { app: { views: { id: string; actions?: Record<string, unknown>[] }[] } };
  const detail = source.app.views.find((view) => view.id === "goods-detail");
  if (!detail?.actions) {
    throw new Error("題材の詳細画面が見つからない");
  }
  const first = detail.actions[0];
  if (first) {
    first.action_emphasis = "primary";
  }
  for (let i = 0; i < 4; i += 1) {
    detail.actions.push({ form: "cart-form", prefill: { field: "item" }, name: `追加${i + 1}` });
  }
  const path = join(TEMP_DIR, "with-notices.json");
  writeFileSync(path, JSON.stringify(source));
  return path;
}

describe("終了コード 0: 検証に通った", () => {
  test("注意の無いマニフェストは 0 で、注意 0件と出す", async () => {
    const result = await runCli(fixture("valid/book-tracker.json"));
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain("OK");
    expect(result.stdout).toContain("注意 0件");
    expect(result.stderr).toBe("");
  });

  test("注意があっても 0(注意は止めない)。件数と箇所を人向けに出す", async () => {
    const path = writeNoticeManifest();
    const result = await runCli(path);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain("注意 2件");
    expect(result.stdout).toContain("/app/views/1/actions");
    expect(result.stdout).toContain("multiple_primary_actions");
    expect(result.stdout).toContain("too_many_actions");
    expect(result.stderr).toBe("");
  });

  test("--json の形: { file, kind: manifest, valid: true, notices, not_counted, limits }", async () => {
    const path = writeNoticeManifest();
    const result = await runCli(path, "--json");
    expect(result.code).toBe(EXIT_OK);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      "file",
      "kind",
      "valid",
      "notices",
      "not_counted",
      "limits",
    ]);
    expect(parsed.file).toBe(path);
    expect(parsed.kind).toBe("manifest");
    expect(parsed.valid).toBe(true);
    const notices = parsed.notices as { rule: string; count: number }[];
    expect(notices.map((n) => [n.rule, n.count])).toEqual([
      ["multiple_primary_actions", 2],
      ["too_many_actions", 8],
    ]);
    expect((parsed.not_counted as unknown[]).length).toBe(1);
    expect((parsed.limits as unknown[]).length).toBe(6);
    // `validate` と同じ `JSON.stringify(..., null, 2)` の整形である。
    expect(result.stdout).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
  });

  test("--json で注意が無いときも notices は空配列として在る", async () => {
    const result = await runCli(fixture("valid/book-tracker.json"), "--json");
    expect(result.code).toBe(EXIT_OK);
    const parsed = JSON.parse(result.stdout) as { notices: unknown[] };
    expect(parsed.notices).toEqual([]);
  });
});

describe("終了コード 1: 検証に失敗した", () => {
  test("語彙外のマニフェストは 1 で、validate と同じ統一形式のエラーを出す", async () => {
    const result = await runCli(fixture("invalid/unknown-field-type.json"));
    expect(result.code).toBe(EXIT_INVALID);
    expect(result.stdout).toContain("NG");
    expect(result.stdout).toContain("/app/tables/0/fields/1/type");
    expect(result.stderr).toBe("");
  });

  test("--json の形: { file, kind: manifest, valid: false, errors }", async () => {
    const result = await runCli(fixture("invalid/broken-view-table.json"), "--json");
    expect(result.code).toBe(EXIT_INVALID);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["file", "kind", "valid", "errors"]);
    expect(parsed.kind).toBe("manifest");
    expect(parsed.valid).toBe(false);
    const errors = parsed.errors as { path: string }[];
    expect(errors[0]?.path).toBe("/app/views/0/table");
    expect(result.stdout).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
  });

  test("深すぎる入れ子は注意ではなく拒否のまま(1)", async () => {
    const result = await runCli(fixture("invalid/layout-too-deep.json"));
    expect(result.code).toBe(EXIT_INVALID);
    expect(result.stdout).toContain("深すぎます");
  });
});

describe("終了コード 2: 入力が扱えなかった", () => {
  test("存在しないファイルは 2", async () => {
    const result = await runCli(fixture("valid/does-not-exist.json"));
    expect(result.code).toBe(EXIT_INPUT_ERROR);
    expect(result.stdout).toContain("読み込めません");
    expect(result.stderr).toBe("");
  });

  test("JSON として壊れたファイルは 2", async () => {
    const path = join(TEMP_DIR, "broken.json");
    await Bun.write(path, "{ not json ");
    const result = await runCli(path);
    expect(result.code).toBe(EXIT_INPUT_ERROR);
    expect(result.stdout).toContain("JSON");
    expect(result.stderr).toBe("");
  });

  test("差分ファイルは点検できないので 2", async () => {
    const result = await runCli(fixture("valid/diff-all-ops.json"));
    expect(result.code).toBe(EXIT_INPUT_ERROR);
    expect(result.stdout).toContain("差分");
    expect(result.stderr).toBe("");
  });

  test("app も operations も無い JSON は 2", async () => {
    const path = join(TEMP_DIR, "unknown-kind.json");
    await Bun.write(path, JSON.stringify({ hello: "world" }));
    const result = await runCli(path);
    expect(result.code).toBe(EXIT_INPUT_ERROR);
  });

  test("引数なしは 2 で使い方を出す", async () => {
    const result = await runCli();
    expect(result.code).toBe(EXIT_INPUT_ERROR);
    expect(result.stdout).toContain("使い方");
    expect(result.stderr).toBe("");
  });

  test("閾値を引数で渡せない(未知のオプションとして 2)", async () => {
    const result = await runCli(fixture("valid/book-tracker.json"), "--max-actions", "3");
    expect(result.code).toBe(EXIT_INPUT_ERROR);
    expect(result.stdout).toContain("未知のオプション");
  });

  test("--json の形: { file, kind: null, valid: false, errors }", async () => {
    const result = await runCli(fixture("valid/diff-all-ops.json"), "--json");
    expect(result.code).toBe(EXIT_INPUT_ERROR);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["file", "kind", "valid", "errors"]);
    expect(parsed.kind).toBeNull();
    expect(parsed.valid).toBe(false);
    expect((parsed.errors as unknown[]).length).toBe(1);
  });
});

describe("綴り", () => {
  test("出力にも本体にも禁じた3つの綴り(下の FORBIDDEN_WORDS)が無い", async () => {
    const path = writeNoticeManifest();
    const human = await runCli(path);
    const json = await runCli(path, "--json");
    const text = `${human.stdout}\n${json.stdout}\n${readFileSync(CLI, "utf-8")}`;
    for (const word of FORBIDDEN_WORDS) {
      expect(text).not.toContain(word);
    }
  });

  test("本体は src/cli/validate.ts を import しない(読み込むと終了してしまうため)", () => {
    const source = readFileSync(CLI, "utf-8");
    expect(source).not.toMatch(/from\s+["']\.\/validate(\.ts)?["']/);
  });
});
