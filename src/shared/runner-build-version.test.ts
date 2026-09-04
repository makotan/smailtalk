/**
 * `V5-M5-T03`(`R-G2` / `R-G3`)。**版の定数と照合関数だけを見る検査。**
 *
 * 固定するのは [`ADR-0251`](../../docs/adr/0251-runner-build-version.md) §5 の限定のうち
 * **限定2(版の定数は1箇所)/ 限定3(単調増加の整数1本)/ 限定4(等しいかの1判定だけ)**
 * の3点である。**ここでは起動を1度も止めない** —— 止める側は
 * `src/server/runner-version-gate.test.ts` が見る。
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { matchesRunnerBuildVersion, RUNNER_BUILD_VERSION } from "./runner-build-version.ts";

const REPO_ROOT = dirname(dirname(import.meta.dir));
const MODULE_PATH = join(import.meta.dir, "runner-build-version.ts");

/** 走査対象のルート(`docs/` は除く。文書には版の数字が説明として現れる)。 */
const SEARCH_ROOTS = ["src", "scripts", "web", "schemas"];

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) {
      continue;
    }
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (full.endsWith(".ts") || full.endsWith(".tsx") || full.endsWith(".json")) {
      out.push(full);
    }
  }
  return out;
}

test("限定3: 版は単調増加の整数1本である(文字列でもセマンティックバージョンでもない)", () => {
  expect(typeof RUNNER_BUILD_VERSION).toBe("number");
  expect(Number.isInteger(RUNNER_BUILD_VERSION)).toBe(true);
  // 0 は「印が無い」を表す値なので、版として使えない(限定6)。
  expect(RUNNER_BUILD_VERSION).toBeGreaterThanOrEqual(1);
  // `PRAGMA user_version` は 32bit 符号付き整数である(限定3 の逐語)。
  expect(RUNNER_BUILD_VERSION).toBeLessThanOrEqual(2_147_483_647);
});

test("限定4: 照合は「等しいか」の1判定だけである", () => {
  expect(matchesRunnerBuildVersion(RUNNER_BUILD_VERSION)).toBe(true);
  expect(matchesRunnerBuildVersion(RUNNER_BUILD_VERSION + 1)).toBe(false);
  expect(matchesRunnerBuildVersion(RUNNER_BUILD_VERSION - 1)).toBe(false);
  // 「印の無い DB」を通さない(限定6)。
  expect(matchesRunnerBuildVersion(0)).toBe(false);
});

test("限定4: 照合関数の本体に分岐が1本も無い(「以上」「未満」「互換範囲」を作れない)", () => {
  const source = readFileSync(MODULE_PATH, "utf-8");
  const body = source.slice(source.indexOf("export function matchesRunnerBuildVersion"));
  // コメントを落としてから見る(条文の説明に「以上」等の語が出るため)。
  const code = body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .split("\n")
    .slice(0, 4)
    .join("\n");
  expect(code).toContain("===");
  for (const forbidden of ["if", "else", "switch", "?", ">", "<", "&&", "||"]) {
    expect(code.includes(forbidden)).toBe(false);
  }
});

test("限定2: 版の定数の宣言は公開単位(apps/smailtalk)の中で1箇所だけである", () => {
  const files: string[] = [];
  for (const root of SEARCH_ROOTS) {
    walk(join(REPO_ROOT, root), files);
  }
  const declarations = files.filter((file) =>
    /export\s+const\s+RUNNER_BUILD_VERSION\s*=/.test(readFileSync(file, "utf-8")),
  );
  expect(declarations.map((file) => relative(REPO_ROOT, file))).toEqual([
    "src/shared/runner-build-version.ts",
  ]);
});

test("走査対象を実際に読めている(空集合で緑にならないことの確認)", () => {
  const files: string[] = [];
  for (const root of SEARCH_ROOTS) {
    walk(join(REPO_ROOT, root), files);
  }
  expect(files.length).toBeGreaterThan(100);
});
