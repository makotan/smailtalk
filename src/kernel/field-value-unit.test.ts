/**
 * `number` の値の単位をフィールドに宣言する(`E-G14` / `F-9` の4回目。
 * `V4-M10-T46` / `ADR-0086`)。
 *
 * **限定表の正は [`docs/adr/0086-field-value-unit.md`](../../docs/adr/0086-field-value-unit.md) §Decision 3(12点)**、
 * 完了条件の正は `docs/plan/v4/records/v4-m10.md` §3d の `V4-M10-T46` 節(8点)。
 *
 * ## このファイルが固定すること(カーネル側)
 *
 * 1. **限定1 / 限定2 / 限定7**: 足すキーは `$defs/field` に1本(`unit`)だけ。
 *    `$defs`(28)/ `FIELD_TYPES`(8)/ `RESOURCE_KINDS`(7)/ `DIFF_OPS`(16)/
 *    `$defs/view.properties`(20)/ `view_changes`(14)が1つも動かない。
 * 2. **限定3**: 値は短い文字列1つ。**配列にしない。通貨コードの enum にしない。**
 * 3. **限定4**: `number` 型にだけ書ける。**他の7型に書いたら差分全体を拒否する。**
 * 4. **限定8**: `field_changes` にも同じキーが在り、**`change_field` で後から書けて
 *    値が実際に運ばれる**(`ADR-0076` の `writable_by` が作った穴を繰り返さない)。
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * - **桁区切りは1ミリも動かない**(限定6)。表示の実測は
 *   `web/test/field-value-unit.test.tsx` と chromium の担当である。
 * - **`4256 点` と `24,724 円` は今日も違う書式で並ぶ**(`ADR-0086` §Decision 4-1)。
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { foldOperations } from "./apply-diff.ts";
import type { Field, Manifest, Operation } from "./types.ts";
import { FIELD_TYPES } from "./types.ts";
import { validateManifest } from "./validate.ts";

const ROOT = dirname(dirname(import.meta.dir));

// biome-ignore lint/suspicious/noExplicitAny: スキーマ JSON を素で読むための局所エイリアス。
type Any = any;

function readSchema(name: string): Any {
  return JSON.parse(readFileSync(join(ROOT, "schemas", name), "utf8")) as Any;
}

// --- (a) 増分の総量(限定1 / 限定2 / 限定3 / 限定7)-----------------------------------

test("限定1: $defs/field.properties は 11 で、10キー目は unit である", () => {
  // **【ADR-0086 限定1 の字面との差を正直に書く】** **限定1 は「8 → 9」と書いているが、
  // 実測の着手前は 9 である** —— `ADR-0076`(`writable_by`)が既に9キー目を足していた
  // (`ADR-0086` は `V4-M10` 本体の実装前に書かれた)。**増分が1キーであることは
  // 限定1 のとおりであり、起点だけが1つずれている。**
  //
  // **【V4-M16-T10 / `P-G28` + `P-G22` / `ADR-0090` 限定1 による更新】** **11キー目
  // (`emphasis`)が門A(`V4-M14` 本審査② の単位3)を通って加わった。**
  // **`ADR-0086` の増分が `unit` の1キーであることは1ミリも変わっていない** ——
  // **見る位置を `at(-1)`(末尾)から `[9]`(10キー目)へ直した。末尾は今日
  // `emphasis` だからである。** **期待値を緩めていない**(位置は今日も1つに固定される)。
  // **【V4-M19-T07 / ADR-0119 限定1 で 11 → 12 に更新した】** 12キー目 `hide_when_empty`
  // (値が無いとき行ごと出さない)が門A を通って増えた(V4-M19 単位E-a。2回目の審査。
  // 判定 = 限定採用)。**`unit` の位置(10キー目・index 9)は今日も動いていない。**
  // **本 ADR の増分ではない。**
  // **【V6-M1-T01 / K-G1 / ADR-0288 限定1 で 12 → 13 に更新した】** 13キー目 `reference_picker`
  // (他のテーブルから選ぶ項目の選び方)が門A を通って増えた(V6-M0 単位A。判定 = 限定採用)。
  // **reference 型にだけ書けるキーである。****本 ADR の増分ではない。**
  const properties = Object.keys(readSchema("manifest.schema.json").$defs.field.properties);
  // **【`V6-M3-T02` / `K-G7` / `ADR-0290` 限定1 で 13 → 14 に更新した】** 14キー目 `reference_search_fields`
  // (参照候補の「探せる項目」の、項目ごとの上書き)が門A を通って増えた(`V6-M0` 単位B。判定 = 限定採用)。
  // **`reference` 型にだけ書けるキーである。****本 ADR の増分ではない。**
  // **【`V8-M20-T01` / 台帳 `J-G27` / `J-G28` / 手続きは `ADR-0301` で 14 → 12 に更新した】**
  // 8キー目だった `audience`(この項目を見せる相手)と9キー目だった `writable_by`(この項目を
  // 書ける相手)が**2本とも廃止された**(判定 = 廃止)。**代わりに担うのは `app.roles[].rules` の
  // 「役割 × 対象(項目)× 読取 / 書込」である。****旧値の逐語は 14。**
  expect(properties).toHaveLength(12);
  // **【`V8-M20-T01` / 台帳 `J-G27` / `J-G28` / `ADR-0301` で見る位置を2つ手前へ直した】**
  // **8キー目だった `audience` と9キー目だった `writable_by` が廃止されたので、それより後ろの
  // キーの添字が2つずつ繰り上がった。****期待値を緩めていない。**
  expect(properties[7]).toBe("unit");
});

// 【`V5-M29-T03` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
//   消したテスト名(逐語): 「限定1 / 限定2 / 限定7: $defs 28 / FIELD_TYPES 8 / RESOURCE_KINDS 7 / DIFF_OPS 16 / view 21 / view_changes 15 が1つも動いていない」
//   そのブロックが測っていたもの:
//     - `expect(Object.keys(manifest.$defs)).toHaveLength(28)`
//     - `expect(FIELD_TYPES).toHaveLength(9)`(行末の逐語: 「【`V5-M16` / `ADR-0161`】8 → 9(`file` が9種目)。
//       **この行が固定していたのは「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**」)
//     - `expect(RESOURCE_KINDS).toHaveLength(7)`
//     - `expect(DIFF_OPS).toHaveLength(17)`(行末の逐語: 「【`V5-M17b` / `ADR-0248`】16 → 17(`set_user_kinds` が17種目)。
//       **この行が固定していたのは「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**」)
//     - `expect(Object.keys(manifest.$defs.view.properties)).toHaveLength(28)`
//     - `expect(Object.keys(readSchema("diff.schema.json").$defs.view_changes.properties)).toHaveLength(23)`
//   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `manifest.$defs:` / `FIELD_TYPES:` /
//   `RESOURCE_KINDS:` / `DIFF_OPS:` / `manifest.$defs.view.properties:` /
//   `diff.$defs.view_changes.properties:` で始まる行)。
//   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
//   検出力0のまま `Ran` を水増しする)。
//   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。
//   **このブロックが本文に持っていた「20 → 28」「14 → 23」の18本の【】の経緯注記も、ここで消える。**
//   **`view_changes` の1件(旧 `:116`)は、発注書 §2-4 が数え落としていた2件のうちの1件である**(記録 §3 に全件列挙した)。

test("限定2: FIELD_TYPES に currency が無い(通貨型を作っていない)", () => {
  expect(FIELD_TYPES).not.toContain("currency");
  expect(readSchema("manifest.schema.json").$defs.field_type.enum).toEqual([...FIELD_TYPES]);
});

test("限定3: unit は maxLength つきの文字列1つで、配列でも通貨コードの enum でもない", () => {
  const key = readSchema("manifest.schema.json").$defs.field.properties.unit as Any;
  const { $comment: _c, description: _d, ...shape } = key;
  expect(shape).toEqual({ type: "string", minLength: 1, maxLength: 8 });
  // **配列にしない**(複数の単位を持たせない)。**enum にしない**(「ポイント」「個」
  // 「回」は通貨コードを持たないので ISO 4217 では表せない)。
  expect(key.items).toBeUndefined();
  expect(key.enum).toBeUndefined();
});

test("限定8: field_changes.properties は 10 で、9キー目は unit である", () => {
  // **【V4-M16-T10 / `P-G28` + `P-G22` / `ADR-0090` による更新】** **10キー目
  // (`emphasis`)が加わったので件数を 9 → 10 にし、見る位置を末尾から `[8]`
  // (9キー目)へ直した。** **`ADR-0086` の増分が1キーであることは動いていない。**
  // **【V4-M19-T07 / ADR-0119 限定1 で 10 → 11 に更新した】** 11キー目 `hide_when_empty`
  // (定義は manifest 側の `$ref`)が加わった。**`unit` の位置(9キー目・index 8)は
  // 今日も動いていない。****本 ADR の増分ではない。**
  // **【V6-M1-T02 / K-G4 / ADR-0288 限定10 で 11 → 12 に更新した】** 12個目のキー
  // `reference_picker`(定義は manifest 側の `$ref`)が加わった。**本 ADR の増分ではない。**
  const properties = Object.keys(readSchema("diff.schema.json").$defs.field_changes.properties);
  // **【`V6-M3-T02` / `K-G7` / `ADR-0290` 限定11 で 12 → 13 に更新した】** 13個目のキー
  // `reference_search_fields`(定義は manifest 側の `$ref`)が加わった。**本 ADR の増分ではない。**
  // **【`V8-M20-T01` / 台帳 `J-G28` / 手続きは `ADR-0301` で 13 → 12 に更新した】** 8個目だった
  // `writable_by` が**廃止された**(判定 = 廃止)。**差し替えは差分操作 `set_roles` の全体差し替え
  // であり、`change_field` に相当する部分更新は面に1つも無い。****旧値の逐語は 13。**
  expect(properties).toHaveLength(12);
  // **【`V8-M20-T01` / 台帳 `J-G28` / `ADR-0301` で見る位置を1つ手前へ直した】** **8個目だった
  // `writable_by` が廃止されたので、それより後ろのキーの添字が1つずつ繰り上がった。**
  // **期待値を緩めていない。**
  expect(properties[7]).toBe("unit");
  // **定義を二重に持たない**(manifest 側を `$ref` する。`unique` と同じ作法)。
  expect((readSchema("diff.schema.json").$defs.field_changes.properties.unit as Any).$ref).toBe(
    "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/field/properties/unit",
  );
});

test("限定8: audience を field_changes に足していない(射程外)", () => {
  const properties = Object.keys(readSchema("diff.schema.json").$defs.field_changes.properties);
  expect(properties).not.toContain("audience");
});

// --- (b) 限定4: number 型にだけ書ける(書けるが効かない組み合わせを1つも作らない)------

function manifestWithField(field: Record<string, unknown>): unknown {
  return {
    app: {
      id: "unit-shop",
      name: "単位の店",
      tables: [{ id: "point", name: "ポイント", fields: [field] }],
      views: [{ id: "point-list", type: "list_view", table: "point", columns: [field.id] }],
    },
  };
}

test("限定4: number 型のフィールドには unit を書ける", () => {
  const result = validateManifest(
    manifestWithField({ id: "balance", name: "残高", type: "number", unit: "点" }),
  );
  expect(result.valid).toBe(true);
});

test("限定4: number 以外の7型に unit を書くと、差分全体が拒否される", () => {
  for (const type of FIELD_TYPES.filter((t) => t !== "number")) {
    const field: Record<string, unknown> = { id: "value", name: "値", type, unit: "円" };
    if (type === "select") {
      field.options = ["a"];
    }
    if (type === "reference") {
      field.reference_table = "point";
    }
    const result = validateManifest(manifestWithField(field));
    expect(result.valid, type).toBe(false);
  }
});

// --- (c) 限定8: change_field で後から書けて、値が実際に運ばれる -------------------------

function baseManifest(): Manifest {
  return {
    app: {
      id: "unit-shop",
      name: "単位の店",
      tables: [
        {
          id: "point",
          name: "ポイント",
          fields: [
            { id: "balance", name: "残高", type: "number" },
            { id: "memo", name: "メモ", type: "text" },
          ],
        },
      ],
      views: [{ id: "point-list", type: "list_view", table: "point", columns: ["balance"] }],
    },
  };
}

function fieldOf(manifest: Manifest, id: string): Field & { unit?: string } {
  const field = manifest.app.tables[0]?.fields.find((f) => f.id === id);
  if (field === undefined) {
    throw new Error(`フィールド ${id} が無い`);
  }
  return field;
}

test("限定8: change_field で書いた unit が適用後マニフェストに残る(書けるが効かない、にしない)", () => {
  const result = foldOperations(baseManifest(), [
    { op: "change_field", table: "point", field: "balance", changes: { unit: "点" } } as Operation,
  ]);
  expect(result.valid).toBe(true);
  if (!result.valid) {
    return;
  }
  expect(fieldOf(result.manifest, "balance").unit).toBe("点");
});

test("限定8: unit を書いたフィールドに別のキーを change_field しても値が消えない", () => {
  const first = foldOperations(baseManifest(), [
    { op: "change_field", table: "point", field: "balance", changes: { unit: "点" } } as Operation,
  ]);
  expect(first.valid).toBe(true);
  if (!first.valid) {
    return;
  }
  const second = foldOperations(first.manifest, [
    {
      op: "change_field",
      table: "point",
      field: "balance",
      changes: { name: "ポイント残高" },
    } as Operation,
  ]);
  expect(second.valid).toBe(true);
  if (!second.valid) {
    return;
  }
  expect(fieldOf(second.manifest, "balance").unit).toBe("点");
});

test("限定4: change_field で number 以外の型のフィールドに unit を書くと拒否される", () => {
  const result = foldOperations(baseManifest(), [
    { op: "change_field", table: "point", field: "memo", changes: { unit: "円" } } as Operation,
  ]);
  expect(result.valid).toBe(false);
  if (result.valid) {
    return;
  }
  expect(result.errors[0]?.path).toBe("/operations/0/changes/unit");
  expect(result.errors[0]?.message).toContain("number");
});

test("限定4: change_field で number → text にすると、引き継いだ unit は落ちる(適用後の形が valid のまま)", () => {
  // **`options` / `reference_table` の既存の作法と同じである** —— 型が変わってその型が
  // 持てないキーは消す。**これは「書けるが効かない」ではない** —— **この差分は `unit` を
  // 1文字も書いていない。** 明示的に書いた `unit` は上の検査のとおり拒否される。
  const first = foldOperations(baseManifest(), [
    { op: "change_field", table: "point", field: "balance", changes: { unit: "点" } } as Operation,
  ]);
  expect(first.valid).toBe(true);
  if (!first.valid) {
    return;
  }
  const second = foldOperations(first.manifest, [
    { op: "change_field", table: "point", field: "balance", changes: { type: "text" } },
  ]);
  expect(second.valid).toBe(true);
  if (!second.valid) {
    return;
  }
  expect(fieldOf(second.manifest, "balance").unit).toBeUndefined();
  expect(validateManifest(second.manifest).valid).toBe(true);
});

test("限定9: 書かなかったフィールドに unit キーは生えない(既定は「単位を出さない」)", () => {
  const result = foldOperations(baseManifest(), [
    { op: "change_field", table: "point", field: "balance", changes: { name: "残高(点)" } },
  ]);
  expect(result.valid).toBe(true);
  if (!result.valid) {
    return;
  }
  expect("unit" in fieldOf(result.manifest, "balance")).toBe(false);
});

// --- (d) 限定11: テーマ・CSS に1バイトも触っていない -----------------------------------

test("限定11: $defs/theme の required 25スロットが1つも動いていない", () => {
  const theme = readSchema("manifest.schema.json").$defs.theme as Any;
  expect(theme.required).toHaveLength(25);
  expect(Object.keys(theme.properties)).toHaveLength(25);
});

test("限定11: $defs/field に色・寸法・書体のキーが1つも無い", () => {
  const keys = Object.keys(readSchema("manifest.schema.json").$defs.field.properties);
  for (const forbidden of ["color", "theme", "style", "width", "align", "font", "format"]) {
    expect(keys).not.toContain(forbidden);
  }
});
