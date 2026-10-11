/**
 * 入力欄の幅(`V20-M3-T02`)。カーネル側。
 *
 * **条文の正は `docs/adr/0460-field-sections-and-field-width.md` の限定4〜限定7**
 * (`docs/adr/0469-field-sections-two-branches.md` は幅を1ミリも引き直していない。同 ADR の限定7)。
 *
 * ## このファイルが固定すること
 *
 * 1. 綴りは `field_width`。`preset_` で始めない。形は「フィールドID → 3値」の対応表で、
 *    値は `short` / `medium` / `full` の3値だけ(長さのリテラルを1バイトも書けない)。
 * 2. 書ける分岐は入力フォームの1つだけ。一覧・詳細画面・集計表の分岐では `false`。
 * 3. 対応表のキーは、その入力フォームの `fields` に在るフィールドでなければならない
 *    (無いIDは位置・許される値・ヒントを持つエラーで拒否)。
 * 4. `update_view` で入力フォームにだけ書け、値が適用後マニフェストに残る。
 * 5. 項目の改名(`change_field` の `id`)に対応表のキーが追随する。
 * 6. 要件定義書には1文も出さない(`silent`。理由は `requirements-doc.test.ts` の表に書いた)。
 * 7. **`ADR-0091` 限定5 の置き換えの歯止め** —— `ADR-0460` の式4〜式7 の中身を、
 *    この製品の検査として置く(§(h))。着手前の `ADR-0091` 限定5 の担保は検査ではなく
 *    `git diff` の削除行0であり、本段で破った以上その形は使えないため、ここに置き直した。
 *
 * ## このファイルが証明しないこと
 *
 * - 描画(入力欄の幅が実際に違うこと)は `web/test/form-field-width.test.tsx` と
 *   `web/e2e/form-field-width.e2e.ts` が見る。
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyDiff, foldOperations } from "./apply-diff.ts";
import { createApp } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { generateRequirementsDoc } from "./requirements-doc.ts";
import type { Manifest, Operation } from "./types.ts";
import { validateManifestFull } from "./validate.ts";

const ROOT = dirname(dirname(import.meta.dir));

// biome-ignore lint/suspicious/noExplicitAny: スキーマ JSON を素で読むための局所エイリアス(既存の検査と同じ作法)。
type Any = any;

function readSchema(name: string): Any {
  return JSON.parse(readFileSync(join(ROOT, "schemas", name), "utf8")) as Any;
}

type BranchType = "list_view" | "form" | "detail_view" | "report_view";
const BRANCH_TYPES: BranchType[] = ["list_view", "form", "detail_view", "report_view"];

function branchProperties(type: BranchType): Record<string, unknown> {
  const found = (readSchema("manifest.schema.json").$defs.view.allOf as Any[]).find(
    (candidate) => candidate.if?.properties?.type?.const === type,
  );
  expect(found, `${type} 分岐`).toBeDefined();
  return (found.then?.properties ?? {}) as Record<string, unknown>;
}

function viewProperties(): Record<string, Any> {
  return readSchema("manifest.schema.json").$defs.view.properties as Record<string, Any>;
}

function baseManifest(): Manifest {
  return {
    app: {
      id: "sample-app",
      name: "サンプル",
      tables: [
        {
          id: "entries",
          name: "エントリ",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "memo", name: "メモ", type: "long_text" },
            { id: "amount", name: "金額", type: "number" },
            { id: "done", name: "済み", type: "boolean" },
          ],
        },
      ],
      views: [
        { id: "entry-list", type: "list_view", table: "entries", columns: ["title"] },
        { id: "entry-form", type: "form", table: "entries", fields: ["title", "memo"] },
        { id: "entry-detail", type: "detail_view", table: "entries" },
        {
          id: "entry-report",
          type: "report_view",
          table: "entries",
          report: { group_by: [{ field: "done" }], aggregates: [{ type: "count" }] },
        },
      ],
    },
  } as unknown as Manifest;
}

function withKey(viewIndex: number, key: string, value: unknown): Manifest {
  const manifest = baseManifest();
  (manifest.app.views[viewIndex] as Any)[key] = value;
  return manifest;
}

// ---------------------------------------------------------------------------
// (a) 綴りと置き場
// ---------------------------------------------------------------------------

test("(a) $defs/view.properties に field_width が1本足され 32 本になる($defs は 30 のまま、allOf は5本のまま)", () => {
  const schema = readSchema("manifest.schema.json");
  const keys = Object.keys(schema.$defs.view.properties);
  expect(keys).toContain("field_width");
  // **【2026-09-24。`V20-M4-T02` / `ADR-0470`】期待値を toBe(32) → toBe(33) へ書き換えた。** **33本目は一覧の束ねるキー `group_by`(`$defs/view.properties` の末尾。一覧でだけ書ける)で、本ファイルが測っている決定の増分ではない。****検査は消していない。**
  // **旧行の逐語**: `expect(keys.length).toBe(32);`
  // **【2026-09-24。`V20-M5-T04` / `ADR-0471`(`ADR-0462` 限定1・限定2)で 33 → 34 に更新した】** 旧の期待値は 33。$defs/view.properties.layout(34キー目) が1本増えた。
  // 【2026-10-02。`V23-M8-T02` / 授権 `ADR-0545` 行58】35キー目 history(詳細画面に行の変更履歴を出すか)が末尾に足されて 34 → 35(決定 `D-V23-205`)。 旧行の逐語: `expect(keys.length).toBe(34);` 新しい値は manifest.schema.json の $defs/view.properties を python で読んで数えた。
  expect(keys.length).toBe(35);
  // **【2026-09-24。`V20-M5-T04` / `ADR-0471`(`ADR-0462` 限定1・限定2)で 30 → 31 に更新した】** 旧の期待値は 30。$defs/layout_node(31本目) が1本増えた。
  expect(Object.keys(schema.$defs).length).toBe(31);
  expect(schema.$defs.view.allOf).toHaveLength(5);
});

test("(a) 差分の view_changes に field_width が1本足され 28 本になり、値域は manifest 側を $ref するだけ", () => {
  const properties = readSchema("diff.schema.json").$defs.view_changes.properties;
  const keys = Object.keys(properties);
  expect(keys).toContain("field_width");
  // **【2026-09-24。`V20-M4-T02` / `ADR-0470`】期待値を toBe(28) → toBe(29) へ書き換えた。** **29本目は一覧の束ねるキー `group_by`(差分の `view_changes` の末尾。一覧でだけ書ける)で、本ファイルが測っている決定の増分ではない。****検査は消していない。**
  // **旧行の逐語**: `expect(keys.length).toBe(28);`
  // **【2026-09-24。`V20-M5-T04` / `ADR-0471`(`ADR-0462` 限定1・限定2)で 29 → 30 に更新した】** 旧の期待値は 29。view_changes.layout(30キー目) が1本増えた。
  // 【2026-10-02。`V23-M8-T02` / 授権 `ADR-0545` 行59】31キー目 history が末尾に足されて 30 → 31(決定 `D-V23-205`)。 旧行の逐語: `expect(keys.length).toBe(30);` 新しい値は diff.schema.json の $defs/view_changes.properties を python で読んで数えた。
  expect(keys.length).toBe(31);
  expect(properties.field_width.$ref).toBe(
    "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/view/properties/field_width",
  );
});

// ---------------------------------------------------------------------------
// (b) 書ける分岐は入力フォームの1つだけ
// ---------------------------------------------------------------------------

test("(b) field_width を false で閉じるのは一覧・詳細画面・集計表の3分岐で、開いているのは入力フォームだけ", () => {
  const closed = BRANCH_TYPES.filter((type) => branchProperties(type).field_width === false);
  expect(closed).toEqual(["list_view", "detail_view", "report_view"]);
  const open = BRANCH_TYPES.filter((type) => branchProperties(type).field_width !== false);
  expect(open).toEqual(["form"]);
});

test("(b) 入力フォームに書いたマニフェストは通る", () => {
  expect(
    validateManifestFull(withKey(1, "field_width", { title: "short", memo: "full" })).valid,
  ).toBe(true);
  expect(validateManifestFull(withKey(1, "field_width", { title: "medium" })).valid).toBe(true);
});

test("(b) 一覧・詳細画面・集計表に書いたマニフェストは、位置・許される値・ヒントを持つエラーで拒否される", () => {
  for (const index of [0, 2, 3]) {
    const result = validateManifestFull(withKey(index, "field_width", { title: "short" }));
    expect(result.valid, String(index)).toBe(false);
    if (result.valid) {
      continue;
    }
    const error = result.errors.find((candidate) => candidate.path.endsWith("/field_width"));
    expect(error?.path, String(index)).toBe(`/app/views/${index}/field_width`);
    expect(error?.message, String(index)).toContain("この種別では指定できません");
    expect(error?.allowed_values, String(index)).toBeDefined();
    expect(error?.allowed_values, String(index)).not.toContain("field_width");
    expect(error?.hint, String(index)).toBeDefined();
  }
});

// ---------------------------------------------------------------------------
// (c) 値は3値の有限 enum だけ
// ---------------------------------------------------------------------------

test("(c) 値の形は「フィールドID → short / medium / full」の対応表である(新しい $defs を作らず、その場に書く)", () => {
  const width = viewProperties().field_width;
  expect(width.type).toBe("object");
  expect(width.propertyNames).toEqual({ $ref: "#/$defs/resource_id" });
  expect(width.additionalProperties.type).toBe("string");
  expect(width.additionalProperties.enum).toEqual(["short", "medium", "full"]);
  // 自由文字列の逃げ道(pattern / format)も、数値も、1つも無い。
  expect(width.additionalProperties.pattern).toBeUndefined();
  expect(width.additionalProperties.format).toBeUndefined();
  expect(JSON.stringify(width)).not.toContain('"number"');
  expect(JSON.stringify(width)).not.toContain('"integer"');
});

test("(c) 3値以外の値(段階の別名・長さのリテラル・数値)は、許される値を持つエラーで拒否される", () => {
  for (const value of ["wide", "narrow", "200px", "50%", "10rem", 200]) {
    const result = validateManifestFull(withKey(1, "field_width", { title: value }));
    expect(result.valid, String(value)).toBe(false);
    if (result.valid) {
      continue;
    }
    const error = result.errors.find((candidate) => candidate.path.includes("field_width"));
    expect(error?.path, String(value)).toBe("/app/views/1/field_width/title");
    if (typeof value === "string") {
      expect(error?.allowed_values, String(value)).toEqual(["short", "medium", "full"]);
    }
  }
});

// ---------------------------------------------------------------------------
// (d) 参照整合: 対応表のキーは入力フォームの fields に在るフィールド
// ---------------------------------------------------------------------------

test("(d) 入力フォームの fields に無いIDを対応表に書いたら、位置・許される値・ヒントを持つエラーで拒否される", () => {
  // amount は表に在るが、この入力フォームの fields には無い。
  for (const fieldId of ["amount", "nothing"]) {
    const result = validateManifestFull(withKey(1, "field_width", { [fieldId]: "short" }));
    expect(result.valid, fieldId).toBe(false);
    if (result.valid) {
      continue;
    }
    const error = result.errors.find((candidate) => candidate.path.includes("field_width"));
    expect(error?.path, fieldId).toBe(`/app/views/1/field_width/${fieldId}`);
    expect(error?.message, fieldId).toContain("field_width");
    expect(error?.message, fieldId).toContain(fieldId);
    expect(error?.allowed_values, fieldId).toEqual(["title", "memo"]);
    expect(error?.hint, fieldId).toBeDefined();
  }
});

// ---------------------------------------------------------------------------
// (e) update_view
// ---------------------------------------------------------------------------

test("(e) update_view で入力フォームに書いた field_width が適用後マニフェストに残る", () => {
  const folded = foldOperations(baseManifest(), [
    {
      op: "update_view",
      view: "entry-form",
      changes: { field_width: { title: "short", memo: "full" } },
    },
  ] as unknown as Operation[]);
  expect(folded.valid).toBe(true);
  if (!folded.valid) {
    return;
  }
  expect((folded.manifest.app.views[1] as Any).field_width).toEqual({
    title: "short",
    memo: "full",
  });
  expect(validateManifestFull(folded.manifest).valid).toBe(true);
});

test("(e) update_view の field_width は一覧・詳細画面・集計表では拒否される", () => {
  for (const viewId of ["entry-list", "entry-detail", "entry-report"]) {
    const folded = foldOperations(baseManifest(), [
      { op: "update_view", view: viewId, changes: { field_width: { title: "short" } } },
    ] as unknown as Operation[]);
    expect(folded.valid, viewId).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// (f) 項目の改名に追随する
// ---------------------------------------------------------------------------

test("(f) change_field で項目の id を改めると、対応表のキーも新しい id に写る(値は変わらない)", () => {
  const manifest = withKey(1, "field_width", { title: "short", memo: "full" });
  const folded = foldOperations(manifest, [
    { op: "change_field", table: "entries", field: "memo", changes: { id: "note" } },
  ] as unknown as Operation[]);
  expect(folded.valid).toBe(true);
  if (!folded.valid) {
    return;
  }
  expect((folded.manifest.app.views[1] as Any).field_width).toEqual({
    title: "short",
    note: "full",
  });
  // 畳み込み後のマニフェストが参照整合を通る(改名した項目に幅が残っても拒否されない)。
  expect(validateManifestFull(folded.manifest).valid).toBe(true);
});

// ---------------------------------------------------------------------------
// (g) 要件定義書には1文も出さない(silent)
// ---------------------------------------------------------------------------

test("(g) 要件定義書: field_width を書いても書かなくても、文の並びが1文字も変わらない", async () => {
  const texts: string[][] = [];
  for (const width of [undefined, { title: "short", memo: "full" }]) {
    const dataRoot = await mkdtemp(join(tmpdir(), "gp-field-width-"));
    const store = KernelMetaStore.open(dataRoot);
    try {
      createApp(store, "幅", { app_id: "width-app" });
      const result = applyDiff(dataRoot, "width-app", {
        diff_id: "d-width-1",
        intent: "入力フォームに幅を書く",
        operations: [
          {
            op: "add_table",
            table: {
              id: "entries",
              name: "エントリ",
              fields: [
                { id: "title", name: "件名", type: "text", required: true },
                { id: "memo", name: "メモ", type: "long_text" },
              ],
            },
          },
          {
            op: "add_view",
            view: {
              id: "entry-form",
              type: "form",
              table: "entries",
              fields: ["title", "memo"],
              ...(width === undefined ? {} : { field_width: width }),
            },
          },
        ],
      } as never);
      expect(result.valid).toBe(true);
      // 時刻(作成・適用の時刻)は2回の実行で必ず違うので、同じ印に置き換えてから比べる。
      texts.push(
        generateRequirementsDoc(dataRoot, "width-app").statements.map((s) =>
          s.text.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<時刻>"),
        ),
      );
    } finally {
      store.close();
      await rm(dataRoot, { recursive: true, force: true });
    }
  }
  expect(texts[0]?.length ?? 0).toBeGreaterThan(0);
  expect(texts[1]).toEqual(texts[0] as string[]);
});

// ---------------------------------------------------------------------------
// (h) `ADR-0091` 限定5 の置き換えの歯止め(`ADR-0460` 限定4〜限定7 の式4〜式7 の中身)
// ---------------------------------------------------------------------------

test("(h) 限定4: 幅を書ける分岐は1つを超えない(入力フォームだけ)", () => {
  const exists = "field_width" in viewProperties();
  const allow = BRANCH_TYPES.filter(
    (type) => exists && branchProperties(type).field_width !== false,
  );
  expect(allow.length).toBeLessThanOrEqual(1);
  expect(allow).toEqual(["form"]);
});

test("(h) 限定5: 幅の値域は3値を超えない(short / medium / full。長さのリテラルを書けない)", () => {
  const width = viewProperties().field_width ?? {};
  const values: unknown[] = width.additionalProperties?.enum ?? width.enum ?? [];
  expect(values.length).toBeLessThanOrEqual(3);
  expect(values).toEqual(["short", "medium", "full"]);
});

test("(h) 限定6: 接頭辞 preset_ で始まる画面のキーは9本のまま(幅の綴りは preset_ で始めない)", () => {
  const presetKeys = Object.keys(viewProperties()).filter((key) => key.startsWith("preset_"));
  expect(presetKeys).toEqual([
    "preset_column_align",
    "preset_column_width",
    "preset_pager_position",
    "preset_label_placement",
    "preset_field_columns",
    "preset_image_size",
    "preset_text_preview",
    "preset_list_shape",
    "preset_density",
  ]);
  expect(presetKeys).toHaveLength(9);
});

test("(h) 限定7: 入力欄の高さと必須印の見せ方を指すキーは、画面の器に0本のまま", () => {
  const hits = Object.keys(viewProperties()).filter(
    (key) => key.includes("height") || key.includes("required"),
  );
  expect(hits).toEqual([]);
});

test("(h) 限定4〜限定7 の陽性対照: 式は偽の入力を偽と言う(幅を一覧でも開いた・4値目・10本目の preset_)", () => {
  // 限定4 の式に「一覧でも開いている」形を食わせると、2分岐になって偽になる。
  const allowIfListOpen = BRANCH_TYPES.filter((type) =>
    type === "list_view" ? true : branchProperties(type).field_width !== false,
  );
  expect(allowIfListOpen.length <= 1).toBe(false);
  // 限定5 の式に4値を食わせると偽になる。
  expect(["short", "medium", "full", "wide"].length <= 3).toBe(false);
  // 限定6 の式に10本目を食わせると偽になる。
  const presetKeys = [...Object.keys(viewProperties()), "preset_field_width"].filter((key) =>
    key.startsWith("preset_"),
  );
  expect(presetKeys.length === 9).toBe(false);
});
