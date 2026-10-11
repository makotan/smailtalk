/**
 * 項目のまとまりの言葉を1つに統合する(`V20-M3-T01`)。
 *
 * **条文の正は `docs/adr/0469-field-sections-two-branches.md`(限定1〜限定7)**。
 * `ADR-0460`(限定1〜限定8)のうち「4分岐すべてで許す」の1点を `ADR-0469` が引き直した。
 *
 * ## このファイルが固定すること(カーネル側)
 *
 * 1. 綴りは `field_sections` の1本だけ。旧綴り `field_groups` は設計図(`$defs/view.properties`)
 *    にも差分(`view_changes`)にも無い(`ADR-0460` 限定2 / `ADR-0469` 限定3)。
 * 2. 書ける画面は入力フォームと詳細画面の2分岐ちょうど。一覧と集計表の分岐では `false`
 *    (`ADR-0469` 限定1・限定2)。`allOf` の分岐は5本のまま。
 * 3. 値は今日の2枝のまま(フィールドIDの配列 / `{ id?, fields }`)。
 * 4. 1つのフィールドIDが2つのまとまりに現れたら、入力フォームでも詳細画面でも拒否する
 *    (`ADR-0469` 限定6 / PRD F2)。エラーは位置・ヒントを持つ(PRD NF4)。
 * 5. `update_view` で入力フォームにも書け、適用後マニフェストに値が残る。一覧と集計表では拒否する
 *    (`ADR-0469` 限定5)。
 *
 * ## このファイルが証明しないこと(先に書く)
 *
 * - **入力フォームの描画は1ピクセルも見ていない。** 入力フォームで見出し付きに束ねて描くのは
 *   `V20-M3-T03` の持ち分であり、本葉の時点では「書けるが描画に効かない」。
 * - 詳細画面の描画が統合の前と同じであることは `web/test/detail-field-grouping.test.tsx` が見る。
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

/** 指定した画面に `key` を書き足したマニフェスト。 */
function withKey(viewIndex: number, key: string, value: unknown): Manifest {
  const manifest = baseManifest();
  (manifest.app.views[viewIndex] as Any)[key] = value;
  return manifest;
}

// ---------------------------------------------------------------------------
// (a) 綴り: 新しい綴りが1本、旧綴りは0本
// ---------------------------------------------------------------------------

test("(a) $defs/view.properties に field_sections が在り、field_groups が無い(本数は据え置き)", () => {
  const keys = Object.keys(readSchema("manifest.schema.json").$defs.view.properties);
  expect(keys).toContain("field_sections");
  expect(keys).not.toContain("field_groups");
  // 旧綴り1本が消えて新しい綴り1本が立つので本数は動かない(`V20-M3-T00` §8-4)。
  // **【2026-09-24。`V20-M3-T02` / `ADR-0460` 限定4】期待値を 31 → 32 へ書き換えた。** **32本目は入力欄の幅 `field_width`(`$defs/view.properties` の末尾。入力フォームでだけ書ける)で、本ファイルが測っている決定の増分ではない。****検査は消していない。**
  // **旧行の逐語**: `expect(keys.length).toBe(31);`
  // **【2026-09-24。`V20-M4-T02` / `ADR-0470`】期待値を toBe(32) → toBe(33) へ書き換えた。** **33本目は一覧の束ねるキー `group_by`(`$defs/view.properties` の末尾。一覧でだけ書ける)で、本ファイルが測っている決定の増分ではない。****検査は消していない。**
  // **旧行の逐語**: `expect(keys.length).toBe(32);`
  // **【2026-09-24。`V20-M5-T04` / `ADR-0471`(`ADR-0462` 限定1・限定2)で 33 → 34 に更新した】** 旧の期待値は 33。$defs/view.properties.layout(34キー目) が1本増えた。
  // 【2026-10-02。`V23-M8-T02` / 授権 `ADR-0545` 行72】35キー目 history(詳細画面に行の変更履歴を出すか)が末尾に足されて 34 → 35(決定 `D-V23-205`)。 旧行の逐語: `expect(keys.length).toBe(34);` 新しい値は manifest.schema.json の $defs/view.properties を python で読んで数えた。
  expect(keys.length).toBe(35);
});

test("(a) 差分の view_changes に field_sections が在り、field_groups が無い(本数は据え置き)", () => {
  const properties = readSchema("diff.schema.json").$defs.view_changes.properties;
  const keys = Object.keys(properties);
  expect(keys).toContain("field_sections");
  expect(keys).not.toContain("field_groups");
  // **【2026-09-24。`V20-M3-T02` / `ADR-0460` 限定4】期待値を 27 → 28 へ書き換えた。** **28本目は入力欄の幅 `field_width`(差分の `view_changes` の末尾。入力フォームでだけ書ける)で、本ファイルが測っている決定の増分ではない。****検査は消していない。**
  // **旧行の逐語**: `expect(keys.length).toBe(27);`
  // **【2026-09-24。`V20-M4-T02` / `ADR-0470`】期待値を toBe(28) → toBe(29) へ書き換えた。** **29本目は一覧の束ねるキー `group_by`(差分の `view_changes` の末尾。一覧でだけ書ける)で、本ファイルが測っている決定の増分ではない。****検査は消していない。**
  // **旧行の逐語**: `expect(keys.length).toBe(28);`
  // **【2026-09-24。`V20-M5-T04` / `ADR-0471`(`ADR-0462` 限定1・限定2)で 29 → 30 に更新した】** 旧の期待値は 29。view_changes.layout(30キー目) が1本増えた。
  // 【2026-10-02。`V23-M8-T02` / 授権 `ADR-0545` 行73】31キー目 history が末尾に足されて 30 → 31(決定 `D-V23-205`)。 旧行の逐語: `expect(keys.length).toBe(30);` 新しい値は diff.schema.json の $defs/view_changes.properties を python で読んで数えた。
  expect(keys.length).toBe(31);
  // 値域を二重に持たない(manifest 側の定義を $ref するだけ)。
  expect(properties.field_sections.$ref).toBe(
    "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/view/properties/field_sections",
  );
});

test("(a) どの分岐にも旧綴り field_groups が1つも現れない", () => {
  for (const type of BRANCH_TYPES) {
    expect(Object.keys(branchProperties(type)), type).not.toContain("field_groups");
  }
});

// ---------------------------------------------------------------------------
// (b) 書ける分岐は入力フォームと詳細画面の2つちょうど
// ---------------------------------------------------------------------------

test("(b) 分岐の本数は5本のままで、field_sections を false にするのは一覧と集計表の2分岐だけ", () => {
  expect(readSchema("manifest.schema.json").$defs.view.allOf).toHaveLength(5);
  const closed = BRANCH_TYPES.filter((type) => branchProperties(type).field_sections === false);
  expect(closed).toEqual(["list_view", "report_view"]);
  const open = BRANCH_TYPES.filter((type) => branchProperties(type).field_sections !== false);
  expect(open).toEqual(["form", "detail_view"]);
});

test("(b) 入力フォームと詳細画面に書いたマニフェストは通る", () => {
  expect(validateManifestFull(withKey(1, "field_sections", { 基本: ["title"] })).valid).toBe(true);
  expect(
    validateManifestFull(withKey(2, "field_sections", { 基本: ["title"], 金額: ["amount"] })).valid,
  ).toBe(true);
});

test("(b) 一覧と集計表に書いたマニフェストは、位置・許される値・ヒントを持つエラーで拒否される", () => {
  for (const [index, id] of [
    [0, "entry-list"],
    [3, "entry-report"],
  ] as const) {
    const result = validateManifestFull(withKey(index, "field_sections", { 基本: ["title"] }));
    expect(result.valid, id).toBe(false);
    if (result.valid) {
      continue;
    }
    const error = result.errors.find((candidate) => candidate.path.endsWith("/field_sections"));
    expect(error?.path, id).toBe(`/app/views/${index}/field_sections`);
    expect(error?.message, id).toContain("この種別では指定できません");
    expect(error?.allowed_values, id).toBeDefined();
    expect(error?.allowed_values, id).not.toContain("field_sections");
    expect(error?.hint, id).toBeDefined();
  }
});

test("(b) 旧綴り field_groups は、詳細画面に書いても未知のキーとして拒否される", () => {
  const result = validateManifestFull(withKey(2, "field_groups", { 基本: ["title"] }));
  expect(result.valid).toBe(false);
  if (result.valid) {
    return;
  }
  // 未知のキーは、そのキーを持つ画面の位置で拒否される(メッセージが綴りを名指しする)。
  const error = result.errors.find((candidate) => candidate.message.includes('"field_groups"'));
  expect(error?.path).toBe("/app/views/2");
  // 許される値に新しい綴りが在ること = 書き直す先がエラーから分かる。
  expect(error?.allowed_values).toContain("field_sections");
  expect(error?.hint).toBeDefined();
});

// ---------------------------------------------------------------------------
// (c) 値は今日の2枝のまま
// ---------------------------------------------------------------------------

test("(c) 値は「配列」か「{ id?, fields }」の2枝で、3枝目も畳みもない", () => {
  const sections = readSchema("manifest.schema.json").$defs.view.properties.field_sections;
  const branches = sections.additionalProperties.oneOf as Any[];
  expect(branches.map((branch) => branch.type)).toEqual(["array", "object"]);
  expect(branches[0].items).toEqual({ $ref: "#/$defs/resource_id" });
  expect(Object.keys(branches[1].properties)).toEqual(["id", "fields"]);
  // 新形の書き方でも通る(入力フォームで)。
  expect(
    validateManifestFull(withKey(1, "field_sections", { 基本: { id: "basic", fields: ["title"] } }))
      .valid,
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// (d) 重複と不在の拒否(入力フォームでも効く)
// ---------------------------------------------------------------------------

test("(d) 入力フォームで同じフィールドIDが2つのまとまりに現れたら、位置とヒントを持つエラーで拒否される", () => {
  const result = validateManifestFull(
    withKey(1, "field_sections", { 基本: ["title", "memo"], 補足: ["memo"] }),
  );
  expect(result.valid).toBe(false);
  if (result.valid) {
    return;
  }
  const error = result.errors.find((candidate) => candidate.path.includes("field_sections"));
  expect(error?.path).toBe("/app/views/1/field_sections/補足/0");
  expect(error?.message).toContain("field_sections");
  expect(error?.message).toContain("2つのまとまり");
  expect(error?.message).toContain("memo");
  expect(error?.message).toContain("基本");
  expect(error?.hint).toBeDefined();
});

test("(d) 新形 { fields } の中の重複も、入力フォームで拒否される", () => {
  const result = validateManifestFull(
    withKey(1, "field_sections", { 基本: { fields: ["title"] }, 補足: { fields: ["title"] } }),
  );
  expect(result.valid).toBe(false);
});

test("(d) 入力フォームの fields に無いIDを書いたら、候補(許される値)付きで拒否される", () => {
  const result = validateManifestFull(withKey(1, "field_sections", { 基本: ["amount"] }));
  expect(result.valid).toBe(false);
  if (result.valid) {
    return;
  }
  const error = result.errors.find((candidate) => candidate.path.includes("field_sections"));
  expect(error?.path).toBe("/app/views/1/field_sections/基本/0");
  expect(error?.allowed_values).toEqual(["title", "memo"]);
  expect(error?.hint).toBeDefined();
  // ヒントが画面の種別を取り違えない(入力フォームに「detail_view」と言わない)。
  expect(error?.hint).not.toContain("detail_view");
});

// ---------------------------------------------------------------------------
// (e) update_view
// ---------------------------------------------------------------------------

test("(e) update_view で入力フォームに書いた field_sections が適用後マニフェストに残る", () => {
  const folded = foldOperations(baseManifest(), [
    {
      op: "update_view",
      view: "entry-form",
      changes: { field_sections: { 基本: ["title"], 補足: ["memo"] } },
    },
  ] as unknown as Operation[]);
  expect(folded.valid).toBe(true);
  if (!folded.valid) {
    return;
  }
  expect((folded.manifest.app.views[1] as Any).field_sections).toEqual({
    基本: ["title"],
    補足: ["memo"],
  });
  expect(validateManifestFull(folded.manifest).valid).toBe(true);
});

test("(e) update_view で詳細画面に書いた field_sections が適用後マニフェストに残る", () => {
  const folded = foldOperations(baseManifest(), [
    { op: "update_view", view: "entry-detail", changes: { field_sections: { 基本: ["title"] } } },
  ] as unknown as Operation[]);
  expect(folded.valid).toBe(true);
  if (!folded.valid) {
    return;
  }
  expect((folded.manifest.app.views[2] as Any).field_sections).toEqual({ 基本: ["title"] });
});

test("(e) update_view の field_sections は一覧と集計表では拒否される", () => {
  for (const viewId of ["entry-list", "entry-report"]) {
    const folded = foldOperations(baseManifest(), [
      { op: "update_view", view: viewId, changes: { field_sections: { 基本: ["title"] } } },
    ] as unknown as Operation[]);
    expect(folded.valid, viewId).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// (f) 要件定義書
// ---------------------------------------------------------------------------

test("(f) 要件定義書: 入力フォームのまとまりにも既存の2種の文が出る(新しい文面を足していない)", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "gp-field-sections-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "まとまり", { app_id: "sections-app" });
    const result = applyDiff(dataRoot, "sections-app", {
      diff_id: "d-sections-1",
      intent: "入力フォームにまとまりを書く",
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
            field_sections: { 基本: ["title"] },
          },
        },
      ],
    } as never);
    expect(result.valid).toBe(true);
    const statements = generateRequirementsDoc(dataRoot, "sections-app").statements;
    expect(
      statements.filter((s) => s.template === "screens.field_group").map((s) => s.text),
    ).toEqual(["画面 `entry-form` の `1` 番目の項目のまとまりの名前は 「基本」 である。"]);
    expect(
      statements.filter((s) => s.template === "screens.field_group_item").map((s) => s.text),
    ).toEqual([
      "画面 `entry-form` の `1` 番目の項目のまとまりは、`1` 番目の項目としてフィールド `title` を含む。",
    ]);
  } finally {
    store.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
