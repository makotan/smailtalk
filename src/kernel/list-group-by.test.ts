/**
 * 一覧の束ねるキー(`V20-M4-T02`)。カーネル側(語彙・適用時の拒否・差分の運び・改名の追随)。
 *
 * **条文の正は `docs/adr/0470-list-group-by-object-value.md`**(`ADR-0461` 限定1 を引き直した)と、
 * **`ADR-0461` の限定2〜限定4**(今日の正のまま)。
 *
 * ## このファイルが固定すること
 *
 * 1. 綴りは `group_by`(集計表と同じ綴り)。置き場は `$defs/view.properties`。値は**オブジェクト1つ**
 *    (`field` 必須 / `granularity` は日付の項目のときだけ)。配列にしない・1本ちょうど・1段。
 * 2. `granularity` の値域は集計表の束ねるキーの要素の `granularity` を `$ref` で共有する(3値ちょうど)。
 * 3. 書ける分岐は一覧の1つだけ。入力フォーム・詳細画面・集計表の分岐では `false`。
 * 4. 適用時の拒否(ADR-0470 §Decision 3): 表示列(`columns`)に在ること / 型は select / reference /
 *    boolean / date の4種 / date には粒度が必須 / date 以外には粒度を書けない / `_id` は書けない。
 * 5. `update_view` で一覧にだけ書け、値が適用後マニフェストに残る。項目の改名に追随する。
 * 6. 要件定義書には1文も出さない(`silent`。理由は `requirements-doc.test.ts` の表)。
 * 7. **`ADR-0470` の式1b / 式5 / 式6 と、`ADR-0461` の式2〜式4 を検査に写す**
 *    (同 ADR 限界3 の「式を見張る検査が1本も無い」を、この段で塞ぐ。先例 = `field-width.test.ts` (h))。
 *
 * ## このファイルが証明しないこと
 *
 * - **読取の並び(束ねるキーを第1キーにする)を1つも見ていない。** サーバの並びは本葉で実装していない
 *   (記録 `docs/plan/v20/records/v20-m4-t01.md` の「止めた理由」)。
 *   **【2026-09-24 追記】並びは後に案A で入った** —— 見るのは `list-group-order.test.ts` と
 *   `src/server/list-group-by-order.test.ts` である。
 * - 描画(見出しを挟むこと)は `V20-M4-T03` の持ち分である。
 */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyDiff, foldOperations } from "./apply-diff.ts";
import { readCurrentManifest } from "./apply-manifest.ts";
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

const GRANULARITY_REF = "#/$defs/report/properties/group_by/items/properties/granularity";

function baseManifest(): Manifest {
  return {
    app: {
      id: "sample-app",
      name: "サンプル",
      tables: [
        {
          id: "customers",
          name: "顧客",
          fields: [{ id: "name", name: "名前", type: "text", required: true }],
        },
        {
          id: "orders",
          name: "注文",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "memo", name: "メモ", type: "long_text" },
            { id: "amount", name: "金額", type: "number" },
            { id: "done", name: "済み", type: "boolean" },
            { id: "ordered_on", name: "注文日", type: "date" },
            { id: "category", name: "種類", type: "select", options: ["食品", "雑貨"] },
            {
              id: "customer",
              name: "顧客",
              type: "reference",
              reference_table: "customers",
            },
            { id: "photo", name: "写真", type: "image" },
            { id: "manual", name: "説明書", type: "file" },
            { id: "hidden_kind", name: "表に出さない種類", type: "select", options: ["x", "y"] },
          ],
        },
      ],
      views: [
        {
          id: "order-list",
          type: "list_view",
          table: "orders",
          columns: [
            "title",
            "memo",
            "amount",
            "done",
            "ordered_on",
            "category",
            "customer",
            "photo",
            "manual",
          ],
        },
        { id: "order-form", type: "form", table: "orders", fields: ["title", "category"] },
        { id: "order-detail", type: "detail_view", table: "orders" },
        {
          id: "order-report",
          type: "report_view",
          table: "orders",
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

function listWith(groupBy: unknown): Manifest {
  return withKey(0, "group_by", groupBy);
}

// ---------------------------------------------------------------------------
// (a) 綴りと置き場・形(集計表の束ねるキーの要素と並べる)
// ---------------------------------------------------------------------------

test("(a) $defs/view.properties に group_by が1本足され 33 本になる($defs は 30 のまま、allOf は5本のまま)", () => {
  const schema = readSchema("manifest.schema.json");
  const keys = Object.keys(schema.$defs.view.properties);
  expect(keys).toContain("group_by");
  // **【2026-09-24。`V20-M5-T04` / `ADR-0471`(`ADR-0462` 限定1・限定2)で 33 → 34 に更新した】** 旧の期待値は 33。$defs/view.properties.layout(34キー目) が1本増えた。
  // 【2026-10-02。`V23-M8-T02` / 授権 `ADR-0545` 行62】35キー目 history(詳細画面に行の変更履歴を出すか)が末尾に足されて 34 → 35(決定 `D-V23-205`)。 旧行の逐語: `expect(keys.length).toBe(34);` 新しい値は manifest.schema.json の $defs/view.properties を python で読んで数えた。
  expect(keys.length).toBe(35);
  // **【2026-09-24。`V20-M5-T04` / `ADR-0471`(`ADR-0462` 限定1・限定2)で 30 → 31 に更新した】** 旧の期待値は 30。$defs/layout_node(31本目) が1本増えた。
  expect(Object.keys(schema.$defs).length).toBe(31);
  expect(schema.$defs.view.allOf).toHaveLength(5);
});

test("(a) 値はオブジェクト1つ。キーは field / granularity の2本ちょうど、必須は field だけ、未知のキーを受けない", () => {
  const groupBy = viewProperties().group_by;
  expect(groupBy.type).toBe("object");
  expect(groupBy.additionalProperties).toBe(false);
  expect(groupBy.required).toEqual(["field"]);
  expect(Object.keys(groupBy.properties).sort()).toEqual(["field", "granularity"]);
  expect(groupBy.properties.field.$ref).toBe("#/$defs/resource_id");
  expect(groupBy.properties.granularity.$ref).toBe(GRANULARITY_REF);
  // 配列にしない(集計表は配列。一覧は1段だけ)。
  expect(groupBy.items).toBeUndefined();
  expect(groupBy.maxItems).toBeUndefined();
});

test("(a) 集計表の束ねるキーの要素と同型である(field 必須・未知キー拒否・粒度は同じ定義)。違いは id / table を持たないことだけ", () => {
  const schema = readSchema("manifest.schema.json");
  const reportItem = schema.$defs.report.properties.group_by.items;
  const listGroupBy = schema.$defs.view.properties.group_by;
  expect(reportItem.type).toBe(listGroupBy.type);
  expect(reportItem.additionalProperties).toBe(listGroupBy.additionalProperties);
  expect(reportItem.required).toEqual(listGroupBy.required);
  const reportKeys = Object.keys(reportItem.properties).sort();
  const listKeys = Object.keys(listGroupBy.properties).sort();
  expect(reportKeys).toEqual(["field", "granularity", "id", "table"]);
  expect(reportKeys.filter((key) => !listKeys.includes(key))).toEqual(["id", "table"]);
});

test("(a) 差分の view_changes に group_by が1本足され 29 本になり、値域は manifest 側を $ref するだけ", () => {
  const properties = readSchema("diff.schema.json").$defs.view_changes.properties;
  const keys = Object.keys(properties);
  expect(keys).toContain("group_by");
  // **【2026-09-24。`V20-M5-T04` / `ADR-0471`(`ADR-0462` 限定1・限定2)で 29 → 30 に更新した】** 旧の期待値は 29。view_changes.layout(30キー目) が1本増えた。
  // 【2026-10-02。`V23-M8-T02` / 授権 `ADR-0545` 行63】31キー目 history が末尾に足されて 30 → 31(決定 `D-V23-205`)。 旧行の逐語: `expect(keys.length).toBe(30);` 新しい値は diff.schema.json の $defs/view_changes.properties を python で読んで数えた。
  expect(keys.length).toBe(31);
  expect(properties.group_by.$ref).toBe(
    "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/view/properties/group_by",
  );
  // ADR-0470 式5: 設計図の定義を参照する1行だけ($comment も置かない)。
  expect(properties.group_by).toEqual({
    $ref: "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/view/properties/group_by",
  });
});

test("(a) 一覧に書いたマニフェストは通る(select / reference / boolean / date+粒度3値)", () => {
  for (const groupBy of [
    { field: "category" },
    { field: "customer" },
    { field: "done" },
    { field: "ordered_on", granularity: "day" },
    { field: "ordered_on", granularity: "week" },
    { field: "ordered_on", granularity: "month" },
  ]) {
    const result = validateManifestFull(listWith(groupBy));
    expect(result.valid, JSON.stringify(groupBy)).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// (b) 粒度は3値ちょうど
// ---------------------------------------------------------------------------

test("(b) 粒度の値域は day / week / month の3値ちょうど(参照先の enum。4値目が無い)", () => {
  const schema = readSchema("manifest.schema.json");
  const granularity = schema.$defs.report.properties.group_by.items.properties.granularity;
  expect(granularity.enum).toEqual(["day", "week", "month"]);
  expect(granularity.enum).toHaveLength(3);
});

test("(b) 3値以外の粒度(year / quarter / hour)はスキーマで拒否される", () => {
  for (const value of ["year", "quarter", "hour"]) {
    const result = validateManifestFull(listWith({ field: "ordered_on", granularity: value }));
    expect(result.valid, value).toBe(false);
  }
});

test("(b) date 以外の項目に粒度を書くと、差分全体が拒否される(位置・ヒント付き)", () => {
  for (const field of ["category", "customer", "done"]) {
    const result = validateManifestFull(listWith({ field, granularity: "month" }));
    expect(result.valid, field).toBe(false);
    if (result.valid) {
      continue;
    }
    const error = result.errors.find((candidate) => candidate.path.includes("group_by"));
    expect(error?.path, field).toBe("/app/views/0/group_by/granularity");
    expect(error?.message, field).toContain("date 型のフィールドだけ");
    expect(error?.hint, field).toBeDefined();
  }
});

test("(b) date の項目に粒度を書かないと拒否される(書ける値の一覧 = 3値)", () => {
  const result = validateManifestFull(listWith({ field: "ordered_on" }));
  expect(result.valid).toBe(false);
  if (result.valid) {
    return;
  }
  const error = result.errors.find((candidate) => candidate.path.includes("group_by"));
  expect(error?.path).toBe("/app/views/0/group_by");
  expect(error?.message).toContain("granularity");
  expect(error?.allowed_values).toEqual(["day", "week", "month"]);
  expect(error?.hint).toBeDefined();
});

// ---------------------------------------------------------------------------
// (c) 書けるが効かない組み合わせを作らない(3分岐 false / 形 / 型 / 表示列 / `_id`)
// ---------------------------------------------------------------------------

test("(c) group_by を false で閉じるのは入力フォーム・詳細画面・集計表の3分岐で、開いているのは一覧だけ", () => {
  const closed = BRANCH_TYPES.filter((type) => branchProperties(type).group_by === false);
  expect(closed).toEqual(["form", "detail_view", "report_view"]);
  const open = BRANCH_TYPES.filter((type) => branchProperties(type).group_by !== false);
  expect(open).toEqual(["list_view"]);
});

test("(c) 入力フォーム・詳細画面・集計表に書いたマニフェストは、位置・許される値を持つエラーで拒否される", () => {
  for (const index of [1, 2, 3]) {
    const result = validateManifestFull(withKey(index, "group_by", { field: "category" }));
    expect(result.valid, String(index)).toBe(false);
    if (result.valid) {
      continue;
    }
    const error = result.errors.find((candidate) => candidate.path.endsWith("/group_by"));
    expect(error?.path, String(index)).toBe(`/app/views/${index}/group_by`);
    expect(error?.message, String(index)).toContain("この種別では指定できません");
    expect(error?.allowed_values, String(index)).not.toContain("group_by");
  }
});

test("(c) 配列・文字列・未知のキーはスキーマで拒否される(1本ちょうど・1段)", () => {
  for (const value of [
    [{ field: "category" }],
    "category",
    { field: "category", order: "desc" },
    { field: "category", table: "orders" },
    { granularity: "month" },
  ]) {
    const result = validateManifestFull(listWith(value));
    expect(result.valid, JSON.stringify(value)).toBe(false);
  }
});

test("(c) `_id` は書けない(行そのもので束ねると1行1群になる)", () => {
  const result = validateManifestFull(listWith({ field: "_id" }));
  expect(result.valid).toBe(false);
});

test("(c) 束ねられない型(text / long_text / number / image / file)は、書ける項目の一覧つきで拒否される", () => {
  for (const field of ["title", "memo", "amount", "photo", "manual"]) {
    const result = validateManifestFull(listWith({ field }));
    expect(result.valid, field).toBe(false);
    if (result.valid) {
      continue;
    }
    const error = result.errors.find((candidate) => candidate.path.includes("group_by"));
    expect(error?.path, field).toBe("/app/views/0/group_by/field");
    expect(error?.message, field).toContain("select / reference / boolean / date");
    // 書ける値 = この一覧の表示列のうち、束ねられる型の項目(表示列の順)。
    expect(error?.allowed_values, field).toEqual(["done", "ordered_on", "category", "customer"]);
    expect(error?.hint, field).toBeDefined();
  }
});

test("(c) 一覧の表示列(columns)に無い項目は、表に在っても拒否される", () => {
  for (const field of ["hidden_kind", "nothing"]) {
    const result = validateManifestFull(listWith({ field }));
    expect(result.valid, field).toBe(false);
    if (result.valid) {
      continue;
    }
    const error = result.errors.find((candidate) => candidate.path.includes("group_by"));
    expect(error?.path, field).toBe("/app/views/0/group_by/field");
    expect(error?.message, field).toContain("表示列(columns)");
    expect(error?.message, field).toContain(field);
    expect(error?.allowed_values, field).toEqual(["done", "ordered_on", "category", "customer"]);
    expect(error?.hint, field).toBeDefined();
  }
});

// ---------------------------------------------------------------------------
// (d) update_view
// ---------------------------------------------------------------------------

test("(d) update_view で一覧に書いた group_by が適用後マニフェストに残る", () => {
  const folded = foldOperations(baseManifest(), [
    {
      op: "update_view",
      view: "order-list",
      changes: { group_by: { field: "ordered_on", granularity: "week" } },
    },
  ] as unknown as Operation[]);
  expect(folded.valid).toBe(true);
  if (!folded.valid) {
    return;
  }
  expect((folded.manifest.app.views[0] as Any).group_by).toEqual({
    field: "ordered_on",
    granularity: "week",
  });
  expect(validateManifestFull(folded.manifest).valid).toBe(true);
});

test("(d) update_view の group_by は入力フォーム・詳細画面・集計表では拒否される", () => {
  for (const viewId of ["order-form", "order-detail", "order-report"]) {
    const folded = foldOperations(baseManifest(), [
      { op: "update_view", view: viewId, changes: { group_by: { field: "category" } } },
    ] as unknown as Operation[]);
    expect(folded.valid, viewId).toBe(false);
  }
});

test("(d) update_view で型の合わない group_by を書くと差分全体が拒否される(全か無か。同じ差分の改名も残らない)", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "gp-list-group-by-d-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "区切り", { app_id: "group-app" });
    const created = applyDiff(dataRoot, "group-app", {
      diff_id: "d-group-d-1",
      intent: "表と一覧",
      operations: [
        {
          op: "add_table",
          table: {
            id: "entries",
            name: "エントリ",
            fields: [
              { id: "title", name: "件名", type: "text", required: true },
              { id: "category", name: "種類", type: "select", options: ["a", "b"] },
            ],
          },
        },
        {
          op: "add_view",
          view: {
            id: "entry-list",
            type: "list_view",
            table: "entries",
            columns: ["title", "category"],
          },
        },
      ],
    } as never);
    expect(created.valid).toBe(true);
    const rejected = applyDiff(dataRoot, "group-app", {
      diff_id: "d-group-d-2",
      intent: "改名と、型の合わない束ねるキー",
      operations: [
        { op: "update_view", view: "entry-list", changes: { name: "改名" } },
        { op: "update_view", view: "entry-list", changes: { group_by: { field: "title" } } },
      ],
    } as never);
    expect(rejected.valid).toBe(false);
    if (rejected.valid) {
      return;
    }
    expect(rejected.errors.some((error) => error.path.includes("group_by"))).toBe(true);
    const after = readCurrentManifest(dataRoot, "group-app").app.views[0] as Any;
    expect(after.name).toBeUndefined();
    expect(after.group_by).toBeUndefined();
    // 通る形なら同じ経路で適用できる(拒否が経路そのものの故障でないことの対照)。
    const accepted = applyDiff(dataRoot, "group-app", {
      diff_id: "d-group-d-3",
      intent: "種類で区切る",
      operations: [
        { op: "update_view", view: "entry-list", changes: { group_by: { field: "category" } } },
      ],
    } as never);
    expect(accepted.valid).toBe(true);
  } finally {
    store.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (e) 項目の改名に追随する
// ---------------------------------------------------------------------------

test("(e) change_field で項目の id を改めると、束ねるキーの field も新しい id に写る(粒度は変わらない)", () => {
  const manifest = listWith({ field: "ordered_on", granularity: "month" });
  const folded = foldOperations(manifest, [
    { op: "change_field", table: "orders", field: "ordered_on", changes: { id: "placed_on" } },
  ] as unknown as Operation[]);
  expect(folded.valid).toBe(true);
  if (!folded.valid) {
    return;
  }
  expect((folded.manifest.app.views[0] as Any).group_by).toEqual({
    field: "placed_on",
    granularity: "month",
  });
  expect(validateManifestFull(folded.manifest).valid).toBe(true);
});

test("(e) 別の項目を改名しても束ねるキーは動かない", () => {
  const manifest = listWith({ field: "category" });
  const folded = foldOperations(manifest, [
    { op: "change_field", table: "orders", field: "memo", changes: { id: "note" } },
  ] as unknown as Operation[]);
  expect(folded.valid).toBe(true);
  if (!folded.valid) {
    return;
  }
  expect((folded.manifest.app.views[0] as Any).group_by).toEqual({ field: "category" });
});

// ---------------------------------------------------------------------------
// (f) 要件定義書には1文も出さない(silent)
// ---------------------------------------------------------------------------

test("(f) 要件定義書: group_by を書いても書かなくても、文の並びが1文字も変わらない", async () => {
  const texts: string[][] = [];
  for (const groupBy of [undefined, { field: "category" }]) {
    const dataRoot = await mkdtemp(join(tmpdir(), "gp-list-group-by-"));
    const store = KernelMetaStore.open(dataRoot);
    try {
      createApp(store, "区切り", { app_id: "group-app" });
      const result = applyDiff(dataRoot, "group-app", {
        diff_id: "d-group-1",
        intent: "一覧を種類で区切る",
        operations: [
          {
            op: "add_table",
            table: {
              id: "entries",
              name: "エントリ",
              fields: [
                { id: "title", name: "件名", type: "text", required: true },
                { id: "category", name: "種類", type: "select", options: ["a", "b"] },
              ],
            },
          },
          {
            op: "add_view",
            view: {
              id: "entry-list",
              type: "list_view",
              table: "entries",
              columns: ["title", "category"],
              ...(groupBy === undefined ? {} : { group_by: groupBy }),
            },
          },
        ],
      } as never);
      expect(result.valid).toBe(true);
      texts.push(
        generateRequirementsDoc(dataRoot, "group-app").statements.map((s) =>
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
// (g) 限定の式を検査に写す(`ADR-0470` 式1b / 式5 / 式6、`ADR-0461` 式2〜式4)
// ---------------------------------------------------------------------------

/** Python の `json.dumps(x, sort_keys=True, ensure_ascii=False)` と同じ文字列を作る。 */
function pythonJsonDumps(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(pythonJsonDumps).join(", ")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}: ${pythonJsonDumps((value as Record<string, unknown>)[key])}`,
      );
    return `{${entries.join(", ")}}`;
  }
  return JSON.stringify(value);
}

test("(g) ADR-0470 式1b: 一覧の束ねるキーは1本を超えず、オブジェクト1つ(field は resource_id、粒度は集計表の定義を参照)", () => {
  const groupBy = viewProperties().group_by;
  const exists = groupBy !== undefined;
  expect(Number(exists)).toBeLessThanOrEqual(1);
  expect(exists).toBe(true);
  expect(
    groupBy.type === "object" &&
      groupBy.additionalProperties === false &&
      JSON.stringify(groupBy.required) === JSON.stringify(["field"]) &&
      JSON.stringify(Object.keys(groupBy.properties).sort()) ===
        JSON.stringify(["field", "granularity"]) &&
      groupBy.properties.field.$ref === "#/$defs/resource_id" &&
      groupBy.properties.granularity.$ref === GRANULARITY_REF,
  ).toBe(true);
});

// **【2026-09-24。`V20-M5-T04`】`ADR-0470` 限定4(式6「30 を超えない」)は `ADR-0471` が 31 に引き直した**
// (31本目は並べ方の木 `layout_node`。`ADR-0462` 限定1 が先に授権していた)。**旧の上限は 30。** テスト名は書いた日の値である。
test("(g) ADR-0470 式6: $defs は 30 を超えない", () => {
  expect(Object.keys(readSchema("manifest.schema.json").$defs).length).toBeLessThanOrEqual(31);
});

test("(g) ADR-0461 式2: 束ねるキーを書ける分岐は一覧の1つだけ", () => {
  const allow = BRANCH_TYPES.filter((type) => branchProperties(type).group_by !== false);
  expect(allow.length).toBeLessThanOrEqual(1);
  expect(allow).toEqual(["list_view"]);
});

test("(g) ADR-0461 式3: 集計表の器は JSON として着手前と完全一致(指紋 d3680a4bcdf19b70)", () => {
  const report = readSchema("manifest.schema.json").$defs.report;
  const fingerprint = createHash("sha256")
    .update(pythonJsonDumps(report), "utf8")
    .digest("hex")
    .slice(0, 16);
  expect(Object.keys(report.properties)).toHaveLength(6);
  expect(report.properties.group_by.maxItems).toBe(3);
  expect(report.properties.aggregates.maxItems).toBe(3);
  expect(report.required).toHaveLength(2);
  expect(fingerprint).toBe("d3680a4bcdf19b70");
});

test("(g) ADR-0461 式4: 接頭辞 group_ で始まる画面のキーは1本を超えない(群の件数・ページ送り・折り畳みのキーが無い)", () => {
  const keys = Object.keys(viewProperties()).filter((key) => key.startsWith("group_"));
  expect(keys).toEqual(["group_by"]);
});

test("(g) 陽性対照: 式は偽の入力を偽と言う(文字列の形・4分岐目・集計表の器を1文字変えた・2本目の group_)", () => {
  // 式1b に ADR-0461 本文の形(文字列)を食わせると偽。
  const stringShape: Any = { type: "string" };
  expect(stringShape.type === "object" && stringShape.additionalProperties === false).toBe(false);
  // 式2 に「入力フォームでも開いている」形を食わせると2分岐になって偽。
  const allowIfFormOpen = BRANCH_TYPES.filter((type) =>
    type === "form" ? true : branchProperties(type).group_by !== false,
  );
  expect(allowIfFormOpen.length <= 1).toBe(false);
  // 式3 の器を1文字変えると指紋が変わる。
  const report = readSchema("manifest.schema.json").$defs.report;
  report.properties.group_by.description = `${report.properties.group_by.description}。`;
  const changed = createHash("sha256")
    .update(pythonJsonDumps(report), "utf8")
    .digest("hex")
    .slice(0, 16);
  expect(changed === "d3680a4bcdf19b70").toBe(false);
  // 式4 に2本目を食わせると偽。
  const twoKeys = [...Object.keys(viewProperties()), "group_count"].filter((key) =>
    key.startsWith("group_"),
  );
  expect(twoKeys.length <= 1).toBe(false);
});

// ---------------------------------------------------------------------------
// (h) 母集団の判定は束ねるキーを1文字も知らない(裁定5 / `ADR-0343` の (C-1) と同じ形)
// ---------------------------------------------------------------------------

test("(h) src/server/owner-scope.ts に group_by の綴りが0件(母集団の判定は群を知らない)", async () => {
  const source = await Bun.file(new URL("../server/owner-scope.ts", import.meta.url)).text();
  expect(source.split("group_by").length - 1).toBe(0);
  // 陽性対照: 同じ式は在る綴りを数えられる(常に 0 を返す式ではない)。
  expect(source.split("st_owner").length - 1).toBeGreaterThan(0);
});

test("(h) 本葉の時点では、一覧の読取(records.ts / read-records.ts)は束ねるキーを1文字も読まない", async () => {
  // **並びを変える実装は本葉で止めた**(記録 `v20-m4-t01.md`)。**読まないことを固定しておき、
  // 並びを入れる段がこの検査を意図して書き換えることにする**(黙って読み始めない)。
  // **【2026-09-24。並びを入れた(メインの裁定 案A)。上の2行を消していない】** **並びは
  // `list-group-order.ts` に置き、一覧の SQL(この2本)は今日も束ねるキーを1文字も読まない** ——
  // **したがってこの検査は書き換えずに真のまま残る**(`ADR-0339` 限定7 の側の見張りとして効く)。
  for (const name of ["records.ts", "read-records.ts"]) {
    const source = await Bun.file(new URL(`./${name}`, import.meta.url)).text();
    // **注釈行を除いた製品コードで数える**(`records.ts` の注釈には `ADR-0104` 限定8 の説明として
    // 同じ綴りが1件在る。`report-declaration-boundary.test.ts` (26) と同じ作法)。
    const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
    expect(
      code.filter((line) => line.includes("group_by")),
      name,
    ).toEqual([]);
  }
});

// ---------------------------------------------------------------------------
// (i) 役割の規則が名指しした項目(`V20-M4-T07`。点検 `T06` の指摘1 への裁定)
//
// **一覧の `group_by` を、集計表の `group_by` / `search_fields` / `sum_field` と同じ側に並べる** ——
// 名指しした項目を指す宣言は適用の時点で拒否する(「書けるが効かない組み合わせ」を作らない)。
// 読取の壁(`group_by=<名指しした項目>` の読取は 400)はそのまま残る(`src/server/list-group-by-order.test.ts` (w))。
// ---------------------------------------------------------------------------

/** `baseManifest` に、役割 `owner` の項目の規則で `category` を名指しした宣言を足す(既定3本を含める)。 */
function withNamedCategory(manifest: Manifest): Manifest {
  (manifest.app as Any).roles = [
    {
      id: "owner",
      name: "運営",
      rules: [
        { target: "app", can: ["write"] },
        { target: "role", can: ["write"] },
        { target: "field", table: "orders", field: "category", can: ["read"] },
      ],
    },
    { id: "editor", name: "編集" },
    { id: "viewer", name: "閲覧" },
  ];
  return manifest;
}

test("(i) 役割の規則が名指しした項目は、一覧の group_by に書けない(書ける値の一覧に名指しした項目を出さない)", () => {
  const result = validateManifestFull(withNamedCategory(listWith({ field: "category" })));
  expect(result.valid).toBe(false);
  if (result.valid) {
    return;
  }
  const error = result.errors.find((candidate) => candidate.path.includes("group_by"));
  expect(error?.path).toBe("/app/views/0/group_by/field");
  expect(error?.message).toContain("役割の規則が名指ししている項目です");
  expect(error?.message).toContain("category");
  // 書ける値 = 表示列のうち束ねられる型で、名指しされていない項目(表示列の順)。category を出さない。
  expect(error?.allowed_values).toEqual(["done", "ordered_on", "customer"]);
  expect(error?.hint).toBeDefined();
  // 対照: 同じ宣言のまま、名指ししていない項目なら通る。
  expect(validateManifestFull(withNamedCategory(listWith({ field: "done" }))).valid).toBe(true);
});

test("(i) 型や表示列で拒否するときも、書ける値の一覧に名指しした項目を出さない", () => {
  for (const field of ["title", "hidden_kind"]) {
    const result = validateManifestFull(withNamedCategory(listWith({ field })));
    expect(result.valid, field).toBe(false);
    if (result.valid) {
      continue;
    }
    const error = result.errors.find((candidate) => candidate.path.includes("group_by"));
    expect(error?.allowed_values, field).toEqual(["done", "ordered_on", "customer"]);
  }
});

test("(i) 後から set_roles で既に使っている項目を名指しすると、sum_field / 集計表の group_by / 一覧の group_by は3つとも同じく差分全体が拒否される", async () => {
  const cases = [
    {
      kind: "sum_field",
      field: "amt",
      view: {
        id: "v",
        type: "list_view",
        table: "t",
        columns: ["title", "amt"],
        sum_field: "amt",
      },
      path: "/app/views/0/sum_field",
    },
    {
      kind: "report.group_by",
      field: "cat",
      view: {
        id: "v",
        type: "report_view",
        table: "t",
        report: { group_by: [{ field: "cat" }], aggregates: [{ type: "count" }] },
      },
      path: "/app/views/0/report/group_by/0/field",
    },
    {
      kind: "list.group_by",
      field: "cat",
      view: {
        id: "v",
        type: "list_view",
        table: "t",
        columns: ["title", "cat"],
        group_by: { field: "cat" },
      },
      path: "/app/views/0/group_by/field",
    },
  ];
  for (const c of cases) {
    const dataRoot = await mkdtemp(join(tmpdir(), "gp-list-group-by-i-"));
    const store = KernelMetaStore.open(dataRoot);
    try {
      createApp(store, "区切り", { app_id: "group-app" });
      const created = applyDiff(dataRoot, "group-app", {
        diff_id: "d-group-i-1",
        intent: "表と画面",
        operations: [
          {
            op: "add_table",
            table: {
              id: "t",
              name: "T",
              fields: [
                { id: "title", name: "件名", type: "text", required: true },
                { id: "amt", name: "額", type: "number" },
                { id: "cat", name: "種", type: "select", options: ["a", "b"] },
              ],
            },
          },
          { op: "add_view", view: c.view },
        ],
      } as never);
      expect(created.valid, c.kind).toBe(true);
      const roles = structuredClone(readCurrentManifest(dataRoot, "group-app").app.roles) as Any[];
      const ownerRole = roles.find((role) => role.id === "owner");
      ownerRole.rules = [
        ...(ownerRole.rules ?? []),
        { target: "field", table: "t", field: c.field, can: ["read"] },
      ];
      const named = applyDiff(dataRoot, "group-app", {
        diff_id: "d-group-i-2",
        intent: "後から名指し",
        operations: [{ op: "set_roles", roles }],
      } as never);
      expect(named.valid, c.kind).toBe(false);
      if (named.valid) {
        continue;
      }
      const error = named.errors.find((candidate) => candidate.path === c.path);
      expect(error?.message, c.kind).toContain("役割の規則が名指ししている項目です");
      expect(error?.allowed_values, c.kind).toEqual([]);
      // 全か無か: 名指しの規則は残らない。
      const after = readCurrentManifest(dataRoot, "group-app").app.roles as Any[];
      expect(JSON.stringify(after), c.kind).not.toContain(`"field":"${c.field}"`);
    } finally {
      store.close();
      await rm(dataRoot, { recursive: true, force: true });
    }
  }
});
