/**
 * 要件ドキュメント生成CLIの統合テスト(V1-M8-T02)。
 *
 * CLI は「別プロセスとして起動して exit code と標準出力を見る」ものなので、
 * 関数を直接呼ばず実際にサブプロセスとして実行する(`validate.test.ts` と同じ作法)。
 * 試材は `scripts/cp-v1-8-fixture.ts` がカーネルの本物の経路で育てたものを使い、
 * 一時ディレクトリに閉じる(実 `data/` を汚さない)。
 *
 * **ここで検査するのは入口としての振る舞いだけである** —— 文面の正しさ・出典の正しさは
 * カーネルのユニットテストと `scripts/cp-v1-8-audit.ts` の担当であり、二重化しない。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { buildFixture } from "../../scripts/cp-v1-8-fixture.ts";

const ROOT = join(import.meta.dir, "..", "..");
const CLI = join(ROOT, "src", "cli", "requirements-doc.ts");

let dataRoot: string;
let appId: string;

type RunResult = { code: number; stdout: string };

async function runCli(...args: string[]): Promise<RunResult> {
  const proc = Bun.spawn([process.execPath, "run", CLI, ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, stdout };
}

beforeAll(async () => {
  const fixture = await buildFixture();
  dataRoot = fixture.dataRoot;
  appId = fixture.appId;
});

afterAll(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

test("標準出力に markdown が出る(空でない)", async () => {
  const result = await runCli("--data-root", dataRoot, "--app", appId);
  expect(result.code).toBe(0);
  expect(result.stdout.length).toBeGreaterThan(500);
  expect(result.stdout).toContain("# 要件定義書");
  expect(result.stdout).toContain(`\`${appId}\``);
});

test("--out / --json に書き出せる", async () => {
  const markdownPath = join(dataRoot, "out.md");
  const jsonPath = join(dataRoot, "out.json");
  const result = await runCli(
    "--data-root",
    dataRoot,
    "--app",
    appId,
    "--out",
    markdownPath,
    "--json",
    jsonPath,
  );
  expect(result.code).toBe(0);
  expect(existsSync(markdownPath)).toBe(true);
  expect(existsSync(jsonPath)).toBe(true);

  const doc = JSON.parse(readFileSync(jsonPath, "utf-8")) as {
    app_id: string;
    statements: unknown[];
    markdown: string;
  };
  expect(doc.app_id).toBe(appId);
  expect(doc.statements.length).toBeGreaterThan(0);
  expect(doc.markdown).toBe(readFileSync(markdownPath, "utf-8"));
});

test("存在しないアプリは exit 1(生成の失敗)", async () => {
  const result = await runCli("--data-root", dataRoot, "--app", "no-such-app");
  expect(result.code).toBe(1);
  expect(result.stdout).toContain("NG:");
});

test("引数が足りなければ exit 2(入力エラー)", async () => {
  const result = await runCli("--data-root", dataRoot);
  expect(result.code).toBe(2);
  expect(result.stdout).toContain("使い方:");
});
