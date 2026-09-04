/**
 * playwright.config.ts の reporter 決定ロジックのテスト(V1 CP close)。
 *
 * config 本体は `defineConfig` を default export しており、Playwright が
 * モジュール評価時に読むため env を切り替えたテストが書けない。そのため
 * reporter の決定だけを `resolveReporter` として純関数に切り出し、ここで
 * 直接検証する。
 */
import { describe, expect, test } from "bun:test";
import { resolveReporter } from "./playwright.config";

describe("resolveReporter", () => {
  test("CI 環境では line と html(open: never) の両方を含む配列を返す", () => {
    const reporter = resolveReporter("true");

    expect(Array.isArray(reporter)).toBe(true);
    const entries = reporter as ReadonlyArray<readonly [string, unknown?]>;

    const line = entries.find(([name]) => name === "line");
    expect(line).toBeDefined();

    const html = entries.find(([name]) => name === "html");
    expect(html).toBeDefined();
    expect(html?.[1]).toEqual({ open: "never" });
  });

  test("非 CI 環境では従来どおり list を返す", () => {
    const reporter = resolveReporter(undefined);
    expect(reporter).toBe("list");
  });
});
