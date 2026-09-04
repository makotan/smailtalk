/**
 * 他のテーブルから選ぶ項目の「選び方」を、項目ごとに宣言する
 * (`K-G1` / `K-G4` / `K-G5`。`V6-M1-T01` / `V6-M1-T02` / `ADR-0288`)。
 *
 * **限定表の正は [`docs/adr/0288-reference-picker-field.md`](../../docs/adr/0288-reference-picker-field.md)
 * §Decision 3**、審査の正は `docs/plan/v6/records/v6-m0.md` §7-2(単位A)、
 * 完了条件の正は `docs/plan/v6/01-reference-picker-baseline.md` §7 の `V6-M1` の行 (i)〜(iv)。
 *
 * ## このファイルが固定すること(カーネル側)
 *
 * 1. **限定1**: 足すキーは `$defs/field` に1本(`reference_picker`)だけ。
 *    **`$defs/view` にも `$defs/table` にも1バイトも触らない**(画面ごとの上書きは
 *    `V6-M2` の担当であり、**本マイルストーンでは書けない**)。
 * 2. **限定2**: **値域は有限の3値で閉じる。4値目を書いた差分は全体が拒否される**
 *    (部分適用しない = `ADR-0010` 限定7 と同じ側)。
 *    **値の名前に器の名前を1つも書かない。**
 * 3. **`reference` 型にだけ書ける** —— 他の8型に書いた差分は全体が拒否される
 *    (`unit` = number 限定 / `emphasis` = select 限定 と同じ作法)。
 * 4. **限定10 の裏(`K-G4`)**: `change_field` で後から書けて、**値が適用後マニフェストに
 *    実際に残る** —— **`ADR-0076` の `writable_by` が作った「キーは在るが効かない」穴を
 *    新しいキーで踏み直さない。**
 * 5. **限定3(`K-G5`)**: **既定は「今日どおりのプルダウン」であり、書かなかった項目に
 *    キーが生えない。**
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * - **3値のうち「打った文字で絞る」「別の面を開いて探す」の描画は、今日1バイトも
 *   実装されていない**(当たり先は `V6-M4` / `V6-M5`)。**したがって今日この2値を書いても
 *   画面は今日どおりのプルダウンのままである。** **これは「書けるが効かない」状態であり、
 *   隠さない**(記録 `docs/plan/v6/records/v6-m1.md` §4 / ADR §Consequences)。
 * - **描画の実測は `web/test/reference-picker.test.tsx` の担当である。**
 * - **候補の件数・上限・絞り込みを1つも扱っていない**(`K-G11`〜`K-G18` = `V6-M4`)。
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { foldOperations } from "./apply-diff.ts";
import type { Field, Manifest, Operation } from "./types.ts";
import { FIELD_TYPES } from "./types.ts";
import { validateDiff, validateManifest } from "./validate.ts";

const ROOT = dirname(dirname(import.meta.dir));

// biome-ignore lint/suspicious/noExplicitAny: スキーマ JSON を素で読むための局所エイリアス。
type Any = any;

function readSchema(name: string): Any {
  return JSON.parse(readFileSync(join(ROOT, "schemas", name), "utf8")) as Any;
}

/** 有限3値の全量。**この配列がこのファイルにおける「正」である。** */
const PICKERS = ["list", "type_filter", "search"] as const;

// --- (a) 増分の総量(限定1)-------------------------------------------------------------

test("限定1: $defs/field.properties の13キー目は reference_picker である(足したのは1本だけ)", () => {
  const properties = Object.keys(readSchema("manifest.schema.json").$defs.field.properties);
  // **【`V6-M3-T02` / `K-G7` / `ADR-0290` 限定1 で見る位置を直した】** **末尾は今日
  // `reference_search_fields`(14キー目)である。****`at(-1)` から `[12]`(13キー目)へ
  // 直した。****期待値を緩めていない**(位置は今日も1つに固定される)。
  // **`ADR-0288` の増分は今日も1キーである。**
  // **【`V8-M20-T01` / 台帳 `J-G27` / `J-G28` / `ADR-0301` で見る位置を2つ手前へ直した】**
  // **8キー目だった `audience` と9キー目だった `writable_by` が廃止されたので、それより後ろの
  // キーの添字が2つずつ繰り上がった。****期待値を緩めていない。**
  expect(properties[10]).toBe("reference_picker");
  // **同じ名前を2度置いていない。**
  expect(properties.filter((key) => key === "reference_picker")).toHaveLength(1);
});

test("限定1: field_changes.properties の12個目は reference_picker で、値域を二重に持たない", () => {
  const fieldChanges = readSchema("diff.schema.json").$defs.field_changes;
  const properties = Object.keys(fieldChanges.properties);
  // **【`V6-M3-T02` / `K-G7` / `ADR-0290` 限定11 で見る位置を直した】** **末尾は今日
  // `reference_search_fields`(13個目)である。****`at(-1)` から `[11]`(12個目)へ直した。**
  // **期待値を緩めていない。**
  // **【`V8-M20-T01` / 台帳 `J-G28` / `ADR-0301` で見る位置を1つ手前へ直した】** **8個目だった
  // `writable_by` が廃止されたので、それより後ろのキーの添字が1つずつ繰り上がった。**
  // **期待値を緩めていない。**
  expect(properties[10]).toBe("reference_picker");
  expect((fieldChanges.properties.reference_picker as Any).$ref).toBe(
    "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/field/properties/reference_picker",
  );
});

test("限定1: $defs/view にも $defs/table にも view_changes にも1バイトも触っていない", () => {
  const manifest = readSchema("manifest.schema.json");
  const diff = readSchema("diff.schema.json");
  expect(manifest.$defs.view.properties.reference_picker).toBeUndefined();
  expect(manifest.$defs.table.properties.reference_picker).toBeUndefined();
  expect(diff.$defs.view_changes.properties.reference_picker).toBeUndefined();
  expect(diff.$defs.table_changes.properties.reference_picker).toBeUndefined();
});

test("限定1: 専用の差分操作もフィールド型も作っていない", () => {
  // **書き込む口は既存の `add_field` / `add_table` / `change_field` だけである。**
  const { DIFF_OPS } = require("./types.ts") as { DIFF_OPS: readonly string[] };
  expect(DIFF_OPS.some((op) => op.includes("picker"))).toBe(false);
  expect(FIELD_TYPES.some((type) => type.includes("picker"))).toBe(false);
});

// --- (b) 限定2: 値域は有限3値。4値目は差分全体の拒否 --------------------------------------

test("限定2: 値域は有限3値ちょうどで、enum 以外の形を1つも持たない", () => {
  const key = readSchema("manifest.schema.json").$defs.field.properties.reference_picker as Any;
  const { $comment: _c, description: _d, ...shape } = key;
  expect(shape).toEqual({ enum: [...PICKERS] });
});

test("限定2: 値の名前に器の名前を1つも書いていない", () => {
  // **`ADR-0094` の器3つ(小窓 / 開くメニュー / 一時的な知らせ)と、`modal` を名指ししない。**
  // **`ADR-0288` 限定2 の当たり先である。**
  const forbidden = ["dialog", "menu", "notice", "modal", "popover", "tab", "toast", "overlay"];
  for (const picker of PICKERS) {
    for (const word of forbidden) {
      expect(picker.includes(word), `${picker} に ${word} が入っている`).toBe(false);
    }
  }
});

function manifestWithReference(field: Record<string, unknown>): unknown {
  return {
    app: {
      id: "picker-shop",
      name: "選び方の店",
      tables: [
        { id: "customer", name: "取引先", fields: [{ id: "title", name: "名前", type: "text" }] },
        {
          id: "order",
          name: "注文",
          fields: [{ id: "memo", name: "メモ", type: "text" }, field],
        },
      ],
      views: [{ id: "order-form", type: "form", table: "order", fields: ["memo"] }],
    },
  };
}

test("(i) 3値それぞれを書いたマニフェストが検証を通る", () => {
  for (const picker of PICKERS) {
    const result = validateManifest(
      manifestWithReference({
        id: "customer_id",
        name: "取引先",
        type: "reference",
        reference_table: "customer",
        reference_picker: picker,
      }),
    );
    expect(result.valid, picker).toBe(true);
  }
});

test("(iv) 4値目・空文字・真偽値・配列を書いたマニフェストは拒否される", () => {
  for (const value of ["popup", "dropdown", "", true, ["list"], 1]) {
    const result = validateManifest(
      manifestWithReference({
        id: "customer_id",
        name: "取引先",
        type: "reference",
        reference_table: "customer",
        reference_picker: value,
      }),
    );
    expect(result.valid, JSON.stringify(value)).toBe(false);
  }
});

test("(iv) 4値目を含む差分は、正しい操作が同じ差分にあっても全体が拒否される(部分適用しない)", () => {
  const result = validateDiff({
    diff_id: "d-picker-1",
    operations: [
      {
        op: "add_field",
        table: "order",
        field: {
          id: "supplier_id",
          name: "仕入先",
          type: "reference",
          reference_table: "customer",
          reference_picker: "list",
        },
      },
      {
        op: "change_field",
        table: "order",
        field: "customer_id",
        changes: { reference_picker: "popup" },
      },
    ],
  });
  expect(result.valid).toBe(false);
  // **拒否は差分全体である** —— 1つ目の操作だけが通る形にしていない。
  expect(JSON.stringify(result)).toContain("reference_picker");
});

// --- (c) reference 型にだけ書ける ---------------------------------------------------------

test("reference 以外の8型に書いたマニフェストは拒否される", () => {
  const byType: Record<string, Record<string, unknown>> = {
    text: {},
    long_text: {},
    number: {},
    boolean: {},
    date: {},
    select: { options: ["a"] },
    reference: { reference_table: "customer" },
    image: {},
    file: {},
  };
  for (const type of FIELD_TYPES) {
    const result = validateManifest(
      manifestWithReference({
        id: "value",
        name: "値",
        type,
        reference_picker: "list",
        ...byType[type],
      }),
    );
    expect(result.valid, type).toBe(type === "reference");
  }
});

// --- (d) 限定10 の裏: change_field で書けて、値が実際に残る(K-G4)---------------------------

function baseManifest(): Manifest {
  return {
    app: {
      id: "picker-shop",
      name: "選び方の店",
      tables: [
        { id: "customer", name: "取引先", fields: [{ id: "title", name: "名前", type: "text" }] },
        {
          id: "order",
          name: "注文",
          fields: [
            { id: "memo", name: "メモ", type: "text" },
            { id: "customer_id", name: "取引先", type: "reference", reference_table: "customer" },
          ],
        },
      ],
      views: [{ id: "order-form", type: "form", table: "order", fields: ["memo"] }],
    },
  };
}

function fieldOf(manifest: Manifest, id: string): Field & { reference_picker?: string } {
  const field = manifest.app.tables[1]?.fields.find((candidate) => candidate.id === id);
  if (field === undefined) {
    throw new Error(`フィールド ${id} が無い`);
  }
  return field;
}

function fold(manifest: Manifest, operations: Operation[]): Manifest {
  const result = foldOperations(manifest, operations);
  if (!result.valid) {
    throw new Error(`畳み込みに失敗した: ${JSON.stringify(result.errors)}`);
  }
  return result.manifest;
}

test("(iii) change_field で書いた reference_picker が適用後マニフェストに実際に残る", () => {
  const next = fold(baseManifest(), [
    {
      op: "change_field",
      table: "order",
      field: "customer_id",
      changes: { reference_picker: "search" },
    } as Operation,
  ]);
  expect(fieldOf(next, "customer_id").reference_picker).toBe("search");
});

test("(iii) 別のキーを change_field しても reference_picker は消えない", () => {
  const first = fold(baseManifest(), [
    {
      op: "change_field",
      table: "order",
      field: "customer_id",
      changes: { reference_picker: "type_filter" },
    } as Operation,
  ]);
  const second = fold(first, [
    {
      op: "change_field",
      table: "order",
      field: "customer_id",
      changes: { name: "お取引先" },
    } as Operation,
  ]);
  expect(fieldOf(second, "customer_id").reference_picker).toBe("type_filter");
  expect(fieldOf(second, "customer_id").name).toBe("お取引先");
});

test("(iii) 3値のあいだを change_field で往復できる", () => {
  let manifest = baseManifest();
  for (const picker of [...PICKERS, "list"] as const) {
    manifest = fold(manifest, [
      {
        op: "change_field",
        table: "order",
        field: "customer_id",
        changes: { reference_picker: picker },
      } as Operation,
    ]);
    expect(fieldOf(manifest, "customer_id").reference_picker).toBe(picker);
  }
});

test("add_field でも書ける(3経路のうち2つ目)", () => {
  const next = fold(baseManifest(), [
    {
      op: "add_field",
      table: "order",
      field: {
        id: "supplier_id",
        name: "仕入先",
        type: "reference",
        reference_table: "customer",
        reference_picker: "search",
      },
    } as Operation,
  ]);
  expect(fieldOf(next, "supplier_id").reference_picker).toBe("search");
});

test("reference でない型にしながら reference_picker を書いた change_field は名指しで拒否される", () => {
  const result = foldOperations(baseManifest(), [
    {
      op: "change_field",
      table: "order",
      field: "customer_id",
      changes: { type: "text", reference_picker: "search" },
    } as Operation,
  ]);
  expect(result.valid).toBe(false);
  if (result.valid) {
    throw new Error("拒否されなかった");
  }
  // **`unit` / `emphasis` と同じ形の名指しの拒否である**(どのキーが原因かが読める)。
  expect(result.errors.some((error) => error.path.endsWith("/changes/reference_picker"))).toBe(
    true,
  );
});

test("reference_picker を1文字も書かずに型を変えたら、引き継いだ値は落ちる(書けるが効かないを作らない)", () => {
  // **`options`(select)/ `reference_table`(reference)/ `unit`(number)と同じ作法である。**
  // **その差分は `reference_picker` を1文字も書いていない。**
  const first = fold(baseManifest(), [
    {
      op: "change_field",
      table: "order",
      field: "customer_id",
      changes: { reference_picker: "search" },
    } as Operation,
  ]);
  const second = fold(first, [
    { op: "change_field", table: "order", field: "customer_id", changes: { type: "text" } },
  ] as Operation[]);
  expect("reference_picker" in fieldOf(second, "customer_id")).toBe(false);
});

test("change_field で4値目を書いた差分は、差分の時点で拒否される", () => {
  const result = validateDiff({
    diff_id: "d-picker-2",
    operations: [
      {
        op: "change_field",
        table: "order",
        field: "customer_id",
        changes: { reference_picker: "typeahead" },
      },
    ],
  });
  expect(result.valid).toBe(false);
});

// --- (e) 限定3: 既定は「今日どおりのプルダウン」(K-G5)-------------------------------------

test("(ii) 書かなかった項目にキーが生えない(既定を反転させていない)", () => {
  const next = fold(baseManifest(), [
    {
      op: "change_field",
      table: "order",
      field: "customer_id",
      changes: { name: "お取引先" },
    } as Operation,
  ]);
  expect("reference_picker" in fieldOf(next, "customer_id")).toBe(false);
  expect("reference_picker" in fieldOf(next, "memo")).toBe(false);
});

test("限定3: スキーマに default を1つも書いていない(既定は表示層が持つ)", () => {
  const key = readSchema("manifest.schema.json").$defs.field.properties.reference_picker as Any;
  expect("default" in key).toBe(false);
});

// --- (f) 型(src/kernel/types.ts)にも同じ値域が入っていること -------------------------------

test("src/kernel/types.ts の Field と FieldChanges の両方に同じ値域が入っている", () => {
  const source = readFileSync(join(ROOT, "src", "kernel", "types.ts"), "utf8");
  const union = PICKERS.map((picker) => `"${picker}"`).join(" | ");
  const occurrences = source.split(`reference_picker?: ${union};`).length - 1;
  expect(occurrences).toBe(2);
});

test("型の上でも3値だけが受かる(4値目は typecheck が止める)", () => {
  // **`bun test` では型は測れないので、値の側から3値の全量を固定する。**
  // **型の側は `bun run typecheck` が下の代入で測る。**
  const declared: Extract<Field, { type: "reference" }>["reference_picker"][] = [...PICKERS];
  expect(declared).toHaveLength(3);
  const changes: import("./types.ts").FieldChanges = { reference_picker: "type_filter" };
  expect(changes.reference_picker).toBe("type_filter");
});
