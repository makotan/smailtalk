/**
 * `V7-M4-T01`: `access_control.inherit_from`(「何を親とみなすか」の宣言)が、
 * 発注の完了条件どおりに閉じていることを固定する。
 *
 * **正**: `docs/plan/v7/records/v7-m4.md` の `V7-M4-T01`。
 * 内容: `inherit_from` は自表の `reference` フィールドIDの配列(0..2件)。
 * `$record.<ref>.<field>` の形も演算子も条件式も1つも書けない(ミニ言語を作らない。`ADR-0079` §3a-2)。
 * 実在しない項目・`reference` でない項目を指した差分は apply 時に拒否する。
 *
 * ## このファイルが「新規に守った範囲」と「すでに守られていた範囲」(正直に書く)
 *
 * `inherit_from` というキー自体、そのschema定義(`maxItems: 2` / `uniqueItems: true` /
 * `items: { "$ref": "#/$defs/resource_id" }`)、および apply 時検査(項目6: 実在チェック +
 * reference型チェック)は、**すべて `V7-M1-T01` / `V7-M1-T05` がすでに実装済みである**
 * (`schemas/manifest.schema.json:433`-`439`、`src/kernel/referential-integrity.ts:2461`-`2471`)。
 * 本タスク(`V7-M4-T01`)はこれらの完了条件を**新しく実装したのではなく、実測して確認しただけ**
 * である。以下のテストのうち、
 *
 * - (i) 3件目の拒否 は `src/kernel/table-access-control.test.ts:341`
 *   「`Z-G15: inherit_from は3件書くと拒否される`」と**重複する**(すでに守られていた)。
 * - (ii) reference でない項目 / 実在しない項目の拒否 は
 *   `src/kernel/referential-integrity.test.ts:1276`-`1290`
 *   「`(6a)` / `(6b)`」と**重複する**(すでに守られていた)。
 * - (iv) `uniqueItems` の重複拒否は、`table-access-control.test.ts:180`-`187` が
 *   schema の**プロパティ値**(`uniqueItems: true` という宣言)を確認しているのに対し、
 *   本ファイルはその宣言が**実際に検証器を通して効く**ことを初めて確認する
 *   (このファイルが新しく足した検証)。
 * - (iii) `$record.parent` のような文字列が schema で拒否されることを、実際に検証器を
 *   通して固定するテストは、既存2ファイルのどちらにも無い(このファイルが新しく足した検証)。
 *
 * 重複させているのは、`V7-M0` の審査(`Z-G15` の `S2`)が本ファイルを変更予定ファイルとして
 * 名指ししたためであり、発注の完了条件 (i)〜(iv) をこのファイル単体で独立して読めるように
 * するためである。
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateReferentialIntegrity } from "./referential-integrity.ts";
import type { Manifest } from "./types.ts";
import { validateManifest, validateManifestFull } from "./validate.ts";

const ROOT = dirname(dirname(import.meta.dir));

// biome-ignore lint/suspicious/noExplicitAny: スキーマ JSON を素で読むための局所エイリアス。
type Any = any;

function readSchema(name: string): Any {
  return JSON.parse(readFileSync(join(ROOT, "schemas", name), "utf8")) as Any;
}

/** `access_control.inherit_from` の schema 定義そのもの。 */
function inheritFromSchema(): Any {
  return readSchema("manifest.schema.json").$defs.table.properties.access_control.properties
    .inherit_from as Any;
}

/**
 * `#/$defs/resource_id` の `pattern`。
 *
 * `schemas/manifest.schema.json:18`(`$defs.resource_id.pattern`)に**逐語**で
 * `"^[a-z][a-z0-9_-]*$"` とある。この正規表現は英小文字で始まり、英小文字・数字・
 * ハイフン・アンダースコアのみを許す —— `$` と `.` はどちらもこの文字集合に無いので、
 * `$record.parent` のような文字列は正規表現より前の時点で1文字目 `$` から一致しない。
 * 完了条件 (iii) はこの `pattern` に**依存して**成立している。
 */
const RESOURCE_ID_PATTERN = "^[a-z][a-z0-9_-]*$";

/** 蔵書アプリ想定の最小マニフェストを組み立てる。`books.parent` が唯一の reference 項目。 */
function manifestWith(inheritFrom: unknown): Manifest {
  return {
    app: {
      id: "book-tracker",
      name: "蔵書管理",
      tables: [
        {
          id: "books",
          name: "書籍",
          fields: [
            { id: "title", name: "タイトル", type: "text" },
            { id: "parent", name: "親の本", type: "reference", reference_table: "books" },
          ],
          access_control: {
            enabled: true,
            permissions: [
              { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
            ],
            creator_permission: "reader",
            grant: {
              table: "book_grant",
              target: "target",
              member: "member",
              permission: "permission",
            },
            members: { table: "member", account: "account" },
            inherit_from: inheritFrom,
          },
        },
        {
          id: "book_grant",
          name: "書籍の付与",
          fields: [
            { id: "target", name: "書籍", type: "reference", reference_table: "books" },
            { id: "member", name: "利用者", type: "reference", reference_table: "member" },
            { id: "permission", name: "権限", type: "select", options: ["reader"] },
          ],
        },
        {
          id: "member",
          name: "利用者",
          fields: [{ id: "account", name: "ログイン", type: "text" }],
        },
      ],
      views: [],
    },
  } as unknown as Manifest;
}

// --- (iii) resource_id の pattern に $ と . が無いことを、まず schema 側で固定する ------

test("resource_id.pattern は逐語で ^[a-z][a-z0-9_-]*$ であり、$ と . を許していない", () => {
  const resourceIdPattern = readSchema("manifest.schema.json").$defs.resource_id.pattern as Any;
  expect(resourceIdPattern).toBe(RESOURCE_ID_PATTERN);
  expect(new RegExp(resourceIdPattern).test("$record.parent")).toBe(false);
});

test("inherit_from.items は #/$defs/resource_id を $ref しており、専用の緩い pattern を持っていない", () => {
  const inherit = inheritFromSchema();
  expect(inherit.items).toEqual({ $ref: "#/$defs/resource_id" });
});

// --- (i) 3件目の要素が拒否される(schema 側。maxItems: 2) -----------------------------
// **すでに守られていた範囲**: table-access-control.test.ts:341 と重複する。

test("(i) inherit_from に3件書いた差分は schema で拒否される", () => {
  // uniqueItems には触れないよう、3件とも異なる有効な resource_id 形にする(maxItems だけを見る)。
  const threeItems = manifestWith(["a", "b", "c"]);
  expect(validateManifest(threeItems).valid).toBe(false);
});

test("(i) 0件・1件・2件は schema で拒否されない(maxItems の境界を正しく実測する)", () => {
  expect(validateManifest(manifestWith([])).valid).toBe(true);
  expect(validateManifest(manifestWith(["parent"])).valid).toBe(true);
  // 2件目は実在する reference 項目が1つしかないため、schema (件数)は通っても
  // apply 時検査(実在チェック)では2件目の "other" で拒否される。ここでは
  // 「schema が件数2件を拒否しないこと」だけを見る。
  expect(validateManifest(manifestWith(["parent", "other"])).valid).toBe(true);
});

// --- (ii) reference でない項目 / 実在しない項目を指す宣言が apply 時に拒否される ----------
// **すでに守られていた範囲**: referential-integrity.test.ts:1276-1290 (6a)/(6b) と重複する。

test("(ii) 実在しない項目IDを指すと apply 時に拒否され、エラー文が利用者の言葉になっている", () => {
  const manifest = manifestWith(["nope"]);
  const result = validateReferentialIntegrity(manifest);
  expect(result.valid).toBe(false);
  if (result.valid) throw new Error("unreachable");
  const error = result.errors.find(
    (candidate) => candidate.path === "/app/tables/0/access_control/inherit_from/0",
  );
  expect(error).toBeDefined();
  if (error === undefined) throw new Error("unreachable");
  expect(error.message).toContain("nope");
  expect(error.message).toContain("ありません");
  // 利用者の言葉になっている(内部記号が漏れていない)ことを確認する。
  for (const symbol of ["Z-G", "D-V7-", "access_control", "referential", "undefined"]) {
    expect(error.message.includes(symbol)).toBe(false);
  }
  expect(error.message.length).toBeGreaterThan(0);
});

test("(ii) reference でない項目(text)を指すと apply 時に拒否され、エラー文が利用者の言葉になっている", () => {
  const manifest = manifestWith(["title"]);
  const result = validateReferentialIntegrity(manifest);
  expect(result.valid).toBe(false);
  if (result.valid) throw new Error("unreachable");
  const error = result.errors.find(
    (candidate) => candidate.path === "/app/tables/0/access_control/inherit_from/0",
  );
  expect(error).toBeDefined();
  if (error === undefined) throw new Error("unreachable");
  // 「参照」という言葉でreference型を要求していることを利用者に伝えている。
  expect(error.message).toContain("参照");
  for (const symbol of ["Z-G", "D-V7-", "access_control", "referential", "undefined"]) {
    expect(error.message.includes(symbol)).toBe(false);
  }
  expect(error.message.length).toBeGreaterThan(0);
});

test("(ii) 規約どおりの宣言(reference項目 parent 1件)は apply 時検査を通る", () => {
  const manifest = manifestWith(["parent"]);
  expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
  expect(validateManifestFull(manifest).valid).toBe(true);
});

// --- (iii) $record. を含む文字列が schema で拒否される(本ファイルが新しく固定する) --------

test("(iii) $record.parent という文字列は resource_id の pattern に一致せず、schema で拒否される", () => {
  const manifest = manifestWith(["$record.parent"]);
  const result = validateManifest(manifest);
  expect(result.valid).toBe(false);
});

test("(iii) $record. で始まる/含む代表的なミニ言語表現が、どれも schema で拒否される", () => {
  const candidates = [
    "$record.parent",
    "$record.parent.title",
    "parent==title",
    "parent.title",
    "$parent",
  ];
  for (const candidate of candidates) {
    const manifest = manifestWith([candidate]);
    expect(validateManifest(manifest).valid, candidate).toBe(false);
  }
});

// --- (iv) 同じ項目を2度書けない(uniqueItems が実際に効く。本ファイルが新しく固定する) -----
// table-access-control.test.ts:185 は `uniqueItems: true` という**宣言の値**しか見ていない。
// ここでは検証器に実際に通して、重複が本当に拒否されることを確認する。

test("(iv) 同じ項目IDを2度書いた宣言は schema (uniqueItems) で拒否される", () => {
  const manifest = manifestWith(["parent", "parent"]);
  expect(validateManifest(manifest).valid).toBe(false);
});

test("(iv) 異なる2件(たとえ2件目が未実在でも)は schema (uniqueItems) では拒否されない", () => {
  // uniqueItems は「値として重複していないか」だけを見る。実在チェックは別レイヤー(項目6)。
  const manifest = manifestWith(["parent", "other"]);
  expect(validateManifest(manifest).valid).toBe(true);
});
