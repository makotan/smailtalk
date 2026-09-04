import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatValidationErrors, type ValidationError } from "./errors.ts";
import { FIELD_TYPES, type FieldType, type Manifest } from "./types.ts";
import { validateDiff, validateManifestFull } from "./validate.ts";

/**
 * カタログ駆動フィクスチャテスト(V0-P1-T05)。
 *
 * `fixtures/catalog.json` を唯一の目録とし、
 * - valid のフィクスチャはバリデーションを通過すること
 * - invalid のフィクスチャは、カタログに書かれた期待エラー(パス・メッセージ断片・許可値)を
 *   すべて含んで拒否されること
 * - カタログに載っていないフィクスチャファイルが存在しないこと(取りこぼし防止)
 * - フィールド型9種すべてが、いずれかの正常系マニフェストに登場すること
 *   (**7種 → 8種(`image`。V2-M2)→ 9種(`file`。V5-M16 / ADR-0161)と増えている。**
 *   **見出しの数は当時のままにせず、今日の実数に直した。**)
 * を検証する。
 *
 * カタログの期待は「実装の出力をコピーした結果」ではなく、仕様から先に書いたもの。
 * 実装とカタログが食い違ったときは、まずどちらが仕様どおりかを判断すること。
 */

const FIXTURES_DIR = join(import.meta.dir, "..", "..", "fixtures");
const CATALOG_PATH = join(FIXTURES_DIR, "catalog.json");

/** カタログに書く「期待されるエラー」。 */
type ExpectedError = {
  /** 完全一致で比較する RFC 6901 JSON Pointer。 */
  path: string;
  /** メッセージに含まれていなければならない断片。 */
  message_contains: string;
  /** enum 系エラーで期待する許可値の一覧(順序も含めて一致すること)。 */
  allowed_values?: string[];
};

/** カタログの1エントリ。 */
type CatalogEntry = {
  /** `fixtures/` からの相対パス(区切りは "/")。 */
  file: string;
  kind: "manifest" | "diff";
  expect: "valid" | "invalid";
  name?: string;
  description?: string;
  expected_errors?: ExpectedError[];
};

type Catalog = { fixtures: CatalogEntry[] };

const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf-8")) as Catalog;

function readFixture(file: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf-8")) as unknown;
}

/** `fixtures/` 配下に実在する JSON フィクスチャの相対パス一覧(カタログ自身は除く)。 */
function listFixtureFiles(): string[] {
  return readdirSync(FIXTURES_DIR, { recursive: true, encoding: "utf-8" })
    .map((entry) => entry.split("\\").join("/"))
    .filter((entry) => entry.endsWith(".json") && entry !== "catalog.json")
    .sort();
}

/** 実際のエラー1件が、期待エラーを満たすか。 */
function matches(actual: ValidationError, expected: ExpectedError): boolean {
  if (actual.path !== expected.path) {
    return false;
  }
  if (!actual.message.includes(expected.message_contains)) {
    return false;
  }
  if (expected.allowed_values !== undefined) {
    const allowed = actual.allowed_values;
    if (allowed === undefined || allowed.length !== expected.allowed_values.length) {
      return false;
    }
    return expected.allowed_values.every((value, index) => allowed[index] === value);
  }
  return true;
}

function validateEntry(entry: CatalogEntry) {
  const input = readFixture(entry.file);
  return entry.kind === "manifest" ? validateManifestFull(input) : validateDiff(input);
}

describe("フィクスチャカタログ", () => {
  test("カタログにエントリが存在する", () => {
    expect(catalog.fixtures.length).toBeGreaterThan(0);
  });

  test("カタログに載っていないフィクスチャファイルが存在しない", () => {
    const onDisk = listFixtureFiles();
    const inCatalog = catalog.fixtures.map((entry) => entry.file).sort();
    expect(onDisk).toEqual(inCatalog);
  });

  test("正常系マニフェストが3件以上ある", () => {
    const validManifests = catalog.fixtures.filter(
      (entry) => entry.kind === "manifest" && entry.expect === "valid",
    );
    expect(validManifests.length).toBeGreaterThanOrEqual(3);
  });

  test("異常系が10件以上ある", () => {
    const invalidEntries = catalog.fixtures.filter((entry) => entry.expect === "invalid");
    expect(invalidEntries.length).toBeGreaterThanOrEqual(10);
  });

  test("正常系 diff が additive 4種すべての op を含む", () => {
    const seen = new Set<string>();
    for (const entry of catalog.fixtures) {
      if (entry.kind !== "diff" || entry.expect !== "valid") {
        continue;
      }
      const diff = readFixture(entry.file) as { operations: { op: string }[] };
      for (const operation of diff.operations) {
        seen.add(operation.op);
      }
    }
    expect([...seen].sort()).toEqual(["add_field", "add_table", "add_view", "update_view"]);
  });

  test("フィールド型9種すべてが正常系マニフェストのいずれかに登場する", () => {
    const seen = new Set<string>();
    for (const entry of catalog.fixtures) {
      if (entry.kind !== "manifest" || entry.expect !== "valid") {
        continue;
      }
      const manifest = readFixture(entry.file) as Manifest;
      for (const table of manifest.app.tables) {
        for (const field of table.fields) {
          seen.add(field.type);
        }
      }
    }
    const missing = FIELD_TYPES.filter((type: FieldType) => !seen.has(type));
    expect(missing).toEqual([]);
  });
});

describe.each(catalog.fixtures.map((entry) => [entry.file, entry] as const))(
  "フィクスチャ %s",
  (_file, entry) => {
    if (entry.expect === "valid") {
      test("バリデーションを通過する", () => {
        const result = validateEntry(entry);
        expect(
          result.valid ? true : `想定外のエラー:\n${formatValidationErrors(result.errors)}`,
        ).toBe(true);
      });
      return;
    }

    test("期待エラーがカタログに書かれている", () => {
      expect(entry.expected_errors ?? []).not.toEqual([]);
    });

    test("バリデーションで拒否される", () => {
      const result = validateEntry(entry);
      expect(result.valid).toBe(false);
    });

    test("カタログの期待エラーをすべて含む", () => {
      const result = validateEntry(entry);
      if (result.valid) {
        throw new Error("valid と判定されたため期待エラーを検証できない");
      }
      for (const expected of entry.expected_errors ?? []) {
        const found = result.errors.some((actual) => matches(actual, expected));
        expect(
          found
            ? true
            : `期待エラーが見つかりません: ${JSON.stringify(expected)}\n実際のエラー:\n${formatValidationErrors(result.errors)}`,
        ).toBe(true);
      }
    });
  },
);
