/**
 * 画面の中の並べ方の木 `layout`(`V20-M5-T01`)。カーネル側(語彙・適用時の拒否・差分の運び・改名の追随)。
 *
 * **条文の正は `docs/adr/0471-layout-tree-node-keys.md`**(`ADR-0462` 限定6 の「木が持てるキーは3つ」を
 * 引き直した)と、**`ADR-0462` の限定1〜限定5 と 限定6 の残り**(今日の正のまま)。
 *
 * ## このファイルが固定すること
 *
 * 1. `$defs` の31本目 `layout_node`。型ごとの `oneOf`(6枝。`type` を `const` で判別)、各枝
 *    `additionalProperties: false`。子は「葉(文字列)か節(`$ref` の自己参照)」。
 * 2. 値はすべて有限の `enum`(間隔5値・寄せ3値・脇の幅3値・脇の側2値・切り替え幅3値・最小幅3値)。
 *    数値・長さのリテラルを1つも受けない(PRD `NF7` / 計画 完了条件18)。
 * 3. 書ける分岐は入力フォーム・詳細画面・一覧の3つ。集計表の分岐は `false`。
 * 4. 適用時の拒否(差分全体): 4段目の節 / 表示項目に無い項目の葉 / 同じ葉が2回 / 画面に無いボタン /
 *    一覧でカードの形を画面に書いていない / まとまり(`field_sections`)と両方。
 * 5. `update_view` で書け、値が適用後マニフェストに残る。項目の改名に追随する。
 *    項目を表示項目から外して葉が宙に浮く差分は拒否する(`group_by` / `field_width` / `field_sections` と同じ)。
 * 6. 要件定義書には1文も出さない(`silent`)。
 *
 * ## このファイルが証明しないこと
 *
 * - 描画(6種が実際に並ぶこと・幅で組み替わること)は `V20-M5-T03` の持ち分である。
 * - 参照されなかった表示項目を末尾に積むのは描画の側である(ここでは「拒否しない」ことだけを見る)。
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyDiff, foldOperations } from "./apply-diff.ts";
import { readCurrentManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { MAX_LAYOUT_DEPTH } from "./referential-integrity.ts";
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

function layoutNode(): Any {
  return readSchema("manifest.schema.json").$defs.layout_node;
}

/** 型ごとの枝を `type` の `const` で引く。 */
function branchOf(type: string): Any {
  const found = (layoutNode().oneOf as Any[]).find(
    (candidate) => candidate.properties?.type?.const === type,
  );
  expect(found, `${type} の枝`).toBeDefined();
  return found;
}

const LAYOUT_TYPES = ["stack", "cluster", "sidebar", "switcher", "grid", "split"];

function baseManifest(): Manifest {
  return {
    app: {
      id: "layout-app",
      name: "並べ方",
      tables: [
        {
          id: "customers",
          name: "顧客",
          fields: [
            { id: "name", name: "名前", type: "text", required: true },
            { id: "email", name: "メール", type: "text" },
            { id: "phone", name: "電話", type: "text" },
            { id: "note", name: "メモ", type: "long_text" },
            { id: "postal_code", name: "郵便番号", type: "text" },
          ],
        },
        {
          id: "orders",
          name: "注文",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "category", name: "種類", type: "select", options: ["食品", "雑貨"] },
            { id: "customer", name: "顧客", type: "reference", reference_table: "customers" },
            { id: "amount", name: "金額", type: "number" },
            { id: "memo", name: "メモ", type: "long_text" },
          ],
        },
      ],
      views: [
        {
          id: "customer-list",
          type: "list_view",
          table: "customers",
          columns: ["name", "email", "phone"],
          preset_list_shape: "card",
          actions: [
            { id: "order", name: "注文する", form: "order-form", prefill: { field: "customer" } },
          ],
        },
        {
          id: "order-form",
          type: "form",
          table: "orders",
          fields: ["title", "category", "customer", "amount"],
        },
        {
          id: "customer-detail",
          type: "detail_view",
          table: "customers",
          fields: ["name", "email", "phone", "note"],
          actions: [
            { id: "order", name: "注文する", form: "order-form", prefill: { field: "customer" } },
            { name: "名前の無いボタン", form: "order-form", prefill: { field: "customer" } },
          ],
        },
        { id: "customer-detail-all", type: "detail_view", table: "customers" },
        {
          id: "order-report",
          type: "report_view",
          table: "orders",
          report: { group_by: [{ field: "category" }], aggregates: [{ type: "count" }] },
        },
      ],
    },
  } as unknown as Manifest;
}

const LIST = 0;
const FORM = 1;
const DETAIL = 2;
const DETAIL_ALL = 3;
const REPORT = 4;

function withKey(viewIndex: number, key: string, value: unknown): Manifest {
  const manifest = baseManifest();
  (manifest.app.views[viewIndex] as Any)[key] = value;
  return manifest;
}

function withLayout(viewIndex: number, layout: unknown): Manifest {
  return withKey(viewIndex, "layout", layout);
}

function errorsOf(
  manifest: Manifest,
): { path: string; message: string; allowed_values?: string[]; hint?: string }[] {
  const result = validateManifestFull(manifest);
  expect(result.valid).toBe(false);
  return result.valid ? [] : (result.errors as Any[]);
}

function layoutErrors(manifest: Manifest): Any[] {
  return errorsOf(manifest).filter((error) => error.path.includes("/layout"));
}

/** PRD F3 の例を、この台の名前で書き直したもの(`action:cancel` は外した)。 */
const PRD_LIKE_FORM_LAYOUT = {
  type: "stack",
  gap: "md",
  children: [
    { type: "switcher", children: ["title", "category"] },
    "customer",
    {
      type: "sidebar",
      side: "amount",
      main: { type: "stack", children: [] as string[] },
      side_width: "sm",
    },
    { type: "split", start: [], end: ["action:submit"] },
  ],
};

// ---------------------------------------------------------------------------
// (a) 綴りと置き場・形
// ---------------------------------------------------------------------------

test("(a) $defs に31本目 layout_node が足され、oneOf の枝の中から $ref で自分自身を指している", () => {
  const defs = readSchema("manifest.schema.json").$defs;
  expect(Object.keys(defs)).toContain("layout_node");
  expect(Object.keys(defs).length).toBe(31);
  const refs = JSON.stringify(defs.layout_node).match(/"\$ref":"#\/\$defs\/layout_node"/g) ?? [];
  // 子を持つ口は children(4枝)/ side / main(sidebar)/ start / end(split)の8箇所。
  expect(refs.length).toBe(8);
});

test("(a) layout_node は型ごとの oneOf 6枝で閉じ、各枝は additionalProperties:false と type の const を持つ", () => {
  const node = layoutNode();
  expect(node.oneOf).toHaveLength(6);
  expect(node.properties).toBeUndefined();
  const consts = (node.oneOf as Any[]).map((branch) => branch.properties.type.const);
  expect(consts).toEqual(LAYOUT_TYPES);
  for (const branch of node.oneOf as Any[]) {
    expect(branch.type, String(branch.properties.type.const)).toBe("object");
    expect(branch.additionalProperties, String(branch.properties.type.const)).toBe(false);
    expect(branch.required, String(branch.properties.type.const)).toContain("type");
  }
});

test("(a) 型ごとのキーは PRD F3 の表どおり(9キーを足した。sidebar と split は gap を持たない)", () => {
  const keysOf = (type: string) => Object.keys(branchOf(type).properties).sort();
  expect(keysOf("stack")).toEqual(["children", "gap", "type"]);
  expect(keysOf("cluster")).toEqual(["children", "gap", "justify", "type"]);
  expect(keysOf("sidebar")).toEqual(["main", "side", "side_position", "side_width", "type"]);
  expect(keysOf("switcher")).toEqual(["children", "gap", "threshold", "type"]);
  expect(keysOf("grid")).toEqual(["children", "gap", "min_item", "type"]);
  expect(keysOf("split")).toEqual(["end", "start", "type"]);
  const all = new Set(LAYOUT_TYPES.flatMap((type) => Object.keys(branchOf(type).properties)));
  const beyondThree = [...all].filter((key) => !["type", "gap", "children"].includes(key)).sort();
  expect(beyondThree).toEqual(
    [
      "end",
      "justify",
      "main",
      "min_item",
      "side",
      "side_position",
      "side_width",
      "start",
      "threshold",
    ].sort(),
  );
  expect(branchOf("sidebar").required.sort()).toEqual(["main", "side", "type"]);
  expect(branchOf("split").required.sort()).toEqual(["end", "start", "type"]);
});

test("(a) $comment が filter_node と同じ作法(自己参照で任意段・歯止めはコード側の MAX_LAYOUT_DEPTH)を書き、先例2本を名指しする", () => {
  const comment = layoutNode().$comment as string;
  expect(comment).toContain("MAX_LAYOUT_DEPTH");
  expect(comment).toContain("$defs/filter_node");
  expect(comment).toContain("$defs/role_condition");
  expect(comment).toContain("コード側");
  expect(comment).toContain("ADR-0471");
});

test("(a) $defs/view.properties に layout が1本足され 34 本。値は layout_node を $ref するだけ", () => {
  const view = readSchema("manifest.schema.json").$defs.view;
  expect(Object.keys(view.properties)).toContain("layout");
  // 【2026-10-02。`V23-M8-T02` / 授権 `ADR-0545` 行30】35キー目 history(詳細画面に行の変更履歴を出すか)が末尾に足されて 34 → 35(決定 `D-V23-205`)。 旧行の逐語: `expect(Object.keys(view.properties).length).toBe(34);` 新しい値は manifest.schema.json の $defs/view.properties を python で読んで数えた。
  expect(Object.keys(view.properties).length).toBe(35);
  expect(view.properties.layout.$ref).toBe("#/$defs/layout_node");
  expect(view.allOf).toHaveLength(5);
});

test("(a) layout を false で閉じるのは集計表の分岐だけで、入力フォーム・詳細画面・一覧は開いている", () => {
  const closed = BRANCH_TYPES.filter((type) => branchProperties(type).layout === false);
  expect(closed).toEqual(["report_view"]);
});

test("(a) 差分の view_changes に layout が1本足され 30 本。値域は manifest 側を $ref するだけ", () => {
  const properties = readSchema("diff.schema.json").$defs.view_changes.properties;
  expect(Object.keys(properties)).toContain("layout");
  // 【2026-10-02。`V23-M8-T02` / 授権 `ADR-0545` 行31】31キー目 history が末尾に足されて 30 → 31(決定 `D-V23-205`)。 旧行の逐語: `expect(Object.keys(properties).length).toBe(30);` 新しい値は diff.schema.json の $defs/view_changes.properties を python で読んで数えた。
  expect(Object.keys(properties).length).toBe(31);
  expect(properties.layout).toEqual({
    $ref: "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/view/properties/layout",
  });
});

// ---------------------------------------------------------------------------
// (b) 値域はすべて有限の enum(数値・長さのリテラルを1つも受けない)
// ---------------------------------------------------------------------------

test("(b) 値域を全部印字する: 型6種・間隔5値・寄せ3値・脇の幅3値・脇の側2値・切り替え幅3値・最小幅3値", () => {
  const domains: Record<string, string[]> = {};
  for (const branch of layoutNode().oneOf as Any[]) {
    for (const [key, schema] of Object.entries(branch.properties as Record<string, Any>)) {
      if (Array.isArray(schema.enum)) {
        domains[key] = schema.enum;
      }
    }
  }
  expect(domains).toEqual({
    gap: ["xs", "sm", "md", "lg", "xl"],
    justify: ["start", "end", "between"],
    side_width: ["sm", "md", "lg"],
    side_position: ["start", "end"],
    threshold: ["sm", "md", "lg"],
    min_item: ["sm", "md", "lg"],
  });
});

test("(b) 同じキーの値域は枝をまたいで同じ(gap は4枝とも同じ5値)", () => {
  const gaps = LAYOUT_TYPES.map((type) => branchOf(type).properties.gap?.enum).filter(
    (value) => value !== undefined,
  );
  expect(gaps).toHaveLength(4);
  for (const gap of gaps) {
    expect(gap).toEqual(["xs", "sm", "md", "lg", "xl"]);
  }
});

test("(b) 木の中に type:number / integer は0件、pattern だけの string は葉(名前の参照)の1箇所だけ", () => {
  const numbers: string[] = [];
  const patterns: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        walk(item, `${path}/${index}`);
      }
      return;
    }
    if (value === null || typeof value !== "object") {
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.type === "number" || record.type === "integer") {
      numbers.push(path);
    }
    if (typeof record.pattern === "string") {
      patterns.push(record.pattern);
    }
    for (const [key, child] of Object.entries(record)) {
      if (key !== "$comment" && key !== "description") {
        walk(child, `${path}/${key}`);
      }
    }
  };
  walk(layoutNode(), "#/$defs/layout_node");
  expect(numbers).toEqual([]);
  // 葉の形は8つの子の口で同じ1つの定義を使う(同じ文字列が口の数だけ現れる)。
  expect(new Set(patterns).size).toBe(1);
  // 葉の本体は $defs/resource_id と同じ規約(英小文字始まり)。数字や記号で始まる長さは通らない。
  const resourceIdBody = (readSchema("manifest.schema.json").$defs.resource_id.pattern as string)
    .replace(/^\^/, "")
    .replace(/\$$/, "");
  expect([...new Set(patterns)]).toEqual([`^(action:)?${resourceIdBody}$`]);
});

test('(b) 数値・長さの間隔は語彙外として拒否される(gap: 8 / "12px" / "1rem")。書ける値の一覧は5値', () => {
  for (const gap of [8, "12px", "1rem", "xxl"]) {
    const errors = layoutErrors(withLayout(FORM, { type: "stack", gap, children: ["title"] }));
    const gapError = errors.find((error) => error.path === "/app/views/1/layout/gap");
    expect(gapError, JSON.stringify(gap)).toBeDefined();
    expect(gapError?.allowed_values, JSON.stringify(gap)).toEqual(["xs", "sm", "md", "lg", "xl"]);
  }
});

test("(b) 型ごとに持てないキーは拒否される(sidebar に gap / split に children / stack に justify)", () => {
  for (const node of [
    { type: "sidebar", side: "title", main: "category", gap: "md" },
    { type: "split", start: ["title"], end: [], children: ["category"] },
    { type: "stack", justify: "between", children: ["title"] },
  ]) {
    const result = validateManifestFull(withLayout(FORM, node));
    expect(result.valid, JSON.stringify(node)).toBe(false);
  }
});

test("(b) 語彙外の型(center / cover / frame / reel / app_shell)は拒否され、書ける型の一覧は6種", () => {
  for (const type of ["center", "cover", "frame", "reel", "app_shell"]) {
    const errors = layoutErrors(withLayout(FORM, { type, children: ["title"] }));
    const typeError = errors.find((error) => error.path === "/app/views/1/layout/type");
    expect(typeError, type).toBeDefined();
    expect(typeError?.allowed_values, type).toEqual(LAYOUT_TYPES);
  }
});

test('(b) 葉に長さ・大文字・空文字は書けない("12px" / "Title" / "" / "action:")', () => {
  for (const leaf of ["12px", "Title", "", "action:", "action:Submit"]) {
    const result = validateManifestFull(withLayout(FORM, { type: "stack", children: [leaf] }));
    expect(result.valid, leaf).toBe(false);
  }
});

test("(b) 拒否の文面に他の枝の都合が混ざらない(葉は葉の形を言い、型の無い節は type が無いとだけ言う)", () => {
  const leafErrors = layoutErrors(withLayout(FORM, { type: "stack", children: ["12px"] }));
  expect(leafErrors).toHaveLength(1);
  expect(leafErrors[0]?.path).toBe("/app/views/1/layout/children/0");
  expect(leafErrors[0]?.message).toContain("並べ方の木の葉");
  expect(leafErrors[0]?.hint).toContain("action:");
  const sidebarErrors = layoutErrors(
    withLayout(FORM, { type: "sidebar", side: "title", main: "category", gap: "md" }),
  );
  expect(sidebarErrors).toHaveLength(1);
  expect(sidebarErrors[0]?.allowed_values).toEqual([
    "type",
    "side",
    "main",
    "side_width",
    "side_position",
  ]);
  const noType = layoutErrors(withLayout(FORM, { type: "stack", children: [{ children: [] }] }));
  expect(noType.map((error) => error.message)).toEqual(['必須プロパティ "type" がありません。']);
});

test("(b) 葉の位置に文字列でも節でもない値(数値・真偽・null・配列)を書くと、文字列の葉と節の両方を書けると言う(NF4。V20-M5-T07 軽5)", () => {
  const cases: [unknown, string][] = [
    [{ type: "stack", children: [8] }, "/app/views/1/layout/children/0"],
    [{ type: "stack", children: ["title", true] }, "/app/views/1/layout/children/1"],
    [{ type: "stack", children: [null] }, "/app/views/1/layout/children/0"],
    [{ type: "stack", children: [["title"]] }, "/app/views/1/layout/children/0"],
    [{ type: "sidebar", side: 8, main: "title" }, "/app/views/1/layout/side"],
    [{ type: "sidebar", side: "title", main: 8 }, "/app/views/1/layout/main"],
    [{ type: "split", start: [8], end: [] }, "/app/views/1/layout/start/0"],
    [{ type: "split", start: [], end: [8] }, "/app/views/1/layout/end/0"],
  ];
  for (const [layout, path] of cases) {
    const errors = layoutErrors(withLayout(FORM, layout));
    expect(
      errors.map((error) => error.path),
      JSON.stringify(layout),
    ).toEqual([path]);
    const text = `${errors[0]?.message} ${errors[0]?.hint}`;
    // 文字列の葉(項目名 / action:<名前>)と、節(object)の両方を言う。
    expect(text, JSON.stringify(layout)).toContain("項目名");
    expect(text, JSON.stringify(layout)).toContain("action:<名前>");
    expect(text, JSON.stringify(layout)).toContain("並べ方の節(object)");
  }
});

test("(b) 木の根に object でない値を書くと、根は並べ方の節(object)だけと言う(根に葉は置けない)", () => {
  for (const layout of [8, "title", ["title"]]) {
    const errors = layoutErrors(withLayout(FORM, layout));
    expect(
      errors.map((error) => error.path),
      JSON.stringify(layout),
    ).toEqual(["/app/views/1/layout"]);
    const text = `${errors[0]?.message} ${errors[0]?.hint}`;
    expect(text, JSON.stringify(layout)).toContain("並べ方の節(object)");
    expect(text, JSON.stringify(layout)).not.toContain("action:<名前>");
  }
});

test("(b) 条件・式・座標のキーは1つも書けない(when / if / x / position / media)", () => {
  for (const key of ["when", "if", "x", "position", "media", "width"]) {
    const result = validateManifestFull(
      withLayout(FORM, { type: "stack", children: ["title"], [key]: "md" }),
    );
    expect(result.valid, key).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// (c) 書ける画面と、通る形
// ---------------------------------------------------------------------------

test("(c) 6種とも入力フォームに書いて通る", () => {
  for (const node of [
    { type: "stack", gap: "xs", children: ["title", "category"] },
    { type: "cluster", gap: "sm", justify: "between", children: ["title", "category"] },
    { type: "sidebar", side: "title", main: "category", side_width: "lg", side_position: "end" },
    { type: "switcher", gap: "lg", threshold: "md", children: ["title", "category"] },
    { type: "grid", gap: "xl", min_item: "sm", children: ["title", "category"] },
    { type: "split", start: ["title"], end: ["category", "action:submit"] },
  ]) {
    const result = validateManifestFull(withLayout(FORM, node));
    expect(result.valid, `${JSON.stringify(node)} ${JSON.stringify(result)}`).toBe(true);
  }
});

test("(c) PRD F3 の例と同じ形(3段・送信ボタン入り)が入力フォームで通る", () => {
  const result = validateManifestFull(withLayout(FORM, PRD_LIKE_FORM_LAYOUT));
  expect(result.valid, JSON.stringify(result)).toBe(true);
});

test("(c) 詳細画面(fields あり / 省略)とカードの一覧に書いて通る(宣言ボタンを識別子で置ける)", () => {
  expect(
    validateManifestFull(
      withLayout(DETAIL, {
        type: "stack",
        children: [{ type: "cluster", children: ["name", "email"] }, "note", "action:order"],
      }),
    ).valid,
  ).toBe(true);
  // fields を書いていない詳細画面は表の全項目が表示項目である。
  expect(
    validateManifestFull(
      withLayout(DETAIL_ALL, { type: "grid", min_item: "md", children: ["name", "postal_code"] }),
    ).valid,
  ).toBe(true);
  expect(
    validateManifestFull(
      withLayout(LIST, {
        type: "split",
        start: ["name"],
        end: ["action:order"],
      }),
    ).valid,
  ).toBe(true);
});

test("(c) 集計表に書くと、この種別では指定できないとして拒否される", () => {
  const errors = errorsOf(withLayout(REPORT, { type: "stack", children: ["category"] }));
  const error = errors.find((candidate) => candidate.path === "/app/views/4/layout");
  expect(error?.message).toContain("この種別では指定できません");
  expect(error?.allowed_values ?? []).not.toContain("layout");
});

test("(c) 参照されなかった表示項目があっても拒否しない(描画が末尾に積む)", () => {
  const result = validateManifestFull(withLayout(FORM, { type: "stack", children: ["title"] }));
  expect(result.valid).toBe(true);
});

// ---------------------------------------------------------------------------
// (d) 深さの上限(ADR-0462 限定4。MAX_LAYOUT_DEPTH = 3。根の節が1段目)
// ---------------------------------------------------------------------------

test("(d) 上限は MAX_LAYOUT_DEPTH = 3 の1本(MAX_FILTER_DEPTH を共有しない)", () => {
  expect(MAX_LAYOUT_DEPTH).toBe(3);
});

test("(d) 3段目の節までは通る(stack > cluster > switcher)", () => {
  const layout = {
    type: "stack",
    children: [
      { type: "cluster", children: [{ type: "switcher", children: ["title", "category"] }] },
    ],
  };
  const result = validateManifestFull(withLayout(FORM, layout));
  expect(result.valid, JSON.stringify(result)).toBe(true);
});

test("(d) 4段目の節は差分全体が拒否される(位置はその4段目の節。children / side / main / start / end のどの口でも)", () => {
  const cases: [unknown, string][] = [
    [
      {
        type: "stack",
        children: [
          {
            type: "cluster",
            children: [{ type: "switcher", children: [{ type: "grid", children: ["title"] }] }],
          },
        ],
      },
      "/app/views/1/layout/children/0/children/0/children/0",
    ],
    [
      {
        type: "sidebar",
        side: "title",
        main: {
          type: "stack",
          children: [{ type: "split", start: [{ type: "stack", children: ["amount"] }], end: [] }],
        },
      },
      "/app/views/1/layout/main/children/0/start/0",
    ],
    [
      {
        type: "split",
        start: [],
        end: [
          {
            type: "sidebar",
            side: { type: "stack", children: [] },
            main: { type: "grid", children: [{ type: "cluster", children: ["title"] }] },
          },
        ],
      },
      "/app/views/1/layout/end/0/main/children/0",
    ],
  ];
  for (const [layout, path] of cases) {
    const errors = layoutErrors(withLayout(FORM, layout));
    const depth = errors.filter((error) => error.message.includes("深すぎます"));
    expect(
      depth.map((error) => error.path),
      path,
    ).toEqual([path]);
    expect(depth[0]?.message, path).toContain(`${MAX_LAYOUT_DEPTH} 段`);
    expect(depth[0]?.hint, path).toBeDefined();
    expect(depth[0]?.allowed_values, path).toBeUndefined();
  }
});

// ---------------------------------------------------------------------------
// (e) 葉の参照先が実在すること(項目 / ボタン)
// ---------------------------------------------------------------------------

test("(e) 表示項目に無い項目の葉は拒否される(表に在っても。書ける値の一覧はその画面の表示項目)", () => {
  for (const leaf of ["memo", "nothing"]) {
    const errors = layoutErrors(withLayout(FORM, { type: "stack", children: ["title", leaf] }));
    expect(
      errors.map((error) => error.path),
      leaf,
    ).toEqual(["/app/views/1/layout/children/1"]);
    expect(errors[0]?.message, leaf).toContain(`"${leaf}"`);
    expect(errors[0]?.message, leaf).toContain("表示項目");
    expect(errors[0]?.allowed_values, leaf).toEqual(["title", "category", "customer", "amount"]);
    expect(errors[0]?.hint, leaf).toBeDefined();
  }
});

test("(e) 一覧の葉は表示列(columns)に照合し、詳細画面(fields 省略)は表の全項目に照合する", () => {
  const listErrors = layoutErrors(withLayout(LIST, { type: "stack", children: ["note"] }));
  expect(listErrors.map((error) => error.path)).toEqual(["/app/views/0/layout/children/0"]);
  expect(listErrors[0]?.message).toContain("columns");
  expect(listErrors[0]?.allowed_values).toEqual(["name", "email", "phone"]);
  const allErrors = layoutErrors(withLayout(DETAIL_ALL, { type: "stack", children: ["title"] }));
  expect(allErrors[0]?.allowed_values).toEqual(["name", "email", "phone", "note", "postal_code"]);
});

test("(e) 詳細画面で fields を書いたときは fields に照合する(表に在っても fields の外の項目の葉は拒否。V20-M5-T07 中1)", () => {
  // 題材の詳細画面の fields は name / email / phone / note。postal_code は表に在るが fields に無い
  // (= 画面に出ない)。表の全項目へ照合を広げると、書けるが効かない葉が通ってしまう。
  const errors = layoutErrors(
    withLayout(DETAIL, { type: "stack", children: ["name", "postal_code"] }),
  );
  expect(errors.map((error) => error.path)).toEqual(["/app/views/2/layout/children/1"]);
  expect(errors[0]?.message).toContain('"postal_code"');
  expect(errors[0]?.message).toContain("fields");
  expect(errors[0]?.allowed_values).toEqual(["name", "email", "phone", "note"]);
});

test("(e) 画面に無いボタンの葉は拒否される(書ける値の一覧は action: と宣言ボタンの識別子)", () => {
  const errors = layoutErrors(
    withLayout(DETAIL, { type: "stack", children: ["name", "action:approve"] }),
  );
  expect(errors.map((error) => error.path)).toEqual(["/app/views/2/layout/children/1"]);
  expect(errors[0]?.message).toContain("action:approve");
  expect(errors[0]?.allowed_values).toEqual(["action:order"]);
  expect(errors[0]?.hint).toBeDefined();
});

test("(e) 入力フォームで書けるボタンは予約名 action:submit の1つだけ(action:cancel は拒否)", () => {
  expect(
    validateManifestFull(withLayout(FORM, { type: "stack", children: ["title", "action:submit"] }))
      .valid,
  ).toBe(true);
  const errors = layoutErrors(withLayout(FORM, { type: "stack", children: ["action:cancel"] }));
  expect(errors.map((error) => error.path)).toEqual(["/app/views/1/layout/children/0"]);
  expect(errors[0]?.allowed_values).toEqual(["action:submit"]);
});

test("(e) 予約名 submit は入力フォームだけ(詳細画面・一覧では拒否)", () => {
  for (const index of [LIST, DETAIL]) {
    const errors = layoutErrors(withLayout(index, { type: "stack", children: ["action:submit"] }));
    expect(errors.length, String(index)).toBe(1);
    expect(errors[0]?.allowed_values, String(index)).toEqual(["action:order"]);
  }
});

// ---------------------------------------------------------------------------
// (f) 同じ葉を2回置かない
// ---------------------------------------------------------------------------

test("(f) 同じ項目の葉を2回置くと拒否される(位置は2回目。書ける値の一覧は付けない)", () => {
  const errors = layoutErrors(
    withLayout(FORM, {
      type: "stack",
      children: ["title", { type: "cluster", children: ["category", "title"] }],
    }),
  );
  expect(errors.map((error) => error.path)).toEqual(["/app/views/1/layout/children/1/children/1"]);
  expect(errors[0]?.message).toContain('"title"');
  expect(errors[0]?.message).toContain("2回");
  expect(errors[0]?.allowed_values).toBeUndefined();
  expect(errors[0]?.hint).toBeDefined();
});

test("(f) 同じボタンの葉を2回置くと拒否される(sidebar の side と main でも)", () => {
  const errors = layoutErrors(
    withLayout(DETAIL, {
      type: "sidebar",
      side: "action:order",
      main: { type: "stack", children: ["name", "action:order"] },
    }),
  );
  expect(errors.map((error) => error.path)).toEqual(["/app/views/2/layout/main/children/1"]);
  expect(errors[0]?.message).toContain("2回");
});

// ---------------------------------------------------------------------------
// (g) 書けるが効かない組み合わせを作らない(一覧はカード / まとまりと両方)
// ---------------------------------------------------------------------------

test("(g) 一覧で画面自身に preset_list_shape: card を書いていないと拒否される(省略も table も)", () => {
  for (const shape of [undefined, "table"]) {
    const manifest = withLayout(LIST, { type: "stack", children: ["name"] });
    if (shape === undefined) {
      delete (manifest.app.views[LIST] as Any).preset_list_shape;
    } else {
      (manifest.app.views[LIST] as Any).preset_list_shape = shape;
    }
    const errors = layoutErrors(manifest);
    expect(
      errors.map((error) => error.path),
      String(shape),
    ).toEqual(["/app/views/0/layout"]);
    expect(errors[0]?.message, String(shape)).toContain("card");
    expect(errors[0]?.hint, String(shape)).toBeDefined();
  }
});

test("(g) 入力フォーム・詳細画面で layout と field_sections の両方を書くと拒否される", () => {
  for (const [index, field] of [
    [FORM, "title"],
    [DETAIL, "name"],
  ] as const) {
    const manifest = withLayout(index, { type: "stack", children: [field] });
    (manifest.app.views[index] as Any).field_sections = { 基本: [field] };
    const errors = layoutErrors(manifest);
    expect(
      errors.map((error) => error.path),
      String(index),
    ).toEqual([`/app/views/${index}/layout`]);
    expect(errors[0]?.message, String(index)).toContain("field_sections");
    expect(errors[0]?.hint, String(index)).toBeDefined();
  }
});

// ---------------------------------------------------------------------------
// (h) update_view で書け、全か無かで拒否される
// ---------------------------------------------------------------------------

test("(h) update_view で入力フォーム・詳細画面・一覧に書いた layout が適用後マニフェストに残る", () => {
  for (const [viewId, layout] of [
    ["order-form", { type: "stack", children: ["title", "action:submit"] }],
    ["customer-detail", { type: "cluster", children: ["name", "action:order"] }],
    ["customer-list", { type: "split", start: ["name"], end: ["action:order"] }],
  ] as const) {
    const folded = foldOperations(baseManifest(), [
      { op: "update_view", view: viewId, changes: { layout } },
    ] as unknown as Operation[]);
    expect(folded.valid, viewId).toBe(true);
    if (!folded.valid) {
      continue;
    }
    const view = folded.manifest.app.views.find((candidate) => candidate.id === viewId) as Any;
    expect(view.layout, viewId).toEqual(layout);
    expect(validateManifestFull(folded.manifest).valid, viewId).toBe(true);
  }
});

test("(h) update_view の layout は集計表では拒否される", () => {
  const folded = foldOperations(baseManifest(), [
    {
      op: "update_view",
      view: "order-report",
      changes: { layout: { type: "stack", children: [] } },
    },
  ] as unknown as Operation[]);
  expect(folded.valid).toBe(false);
});

test("(h) layout が残る一覧の形を table に変える update_view は拒否される", async () => {
  const manifest = withLayout(LIST, { type: "stack", children: ["name"] });
  expect(validateManifestFull(manifest).valid).toBe(true);
  const folded = foldOperations(manifest, [
    { op: "update_view", view: "customer-list", changes: { preset_list_shape: "table" } },
  ] as unknown as Operation[]);
  // 畳み込みは形だけ見る。拒否は畳み込み後のマニフェスト検証が持つ(判定を2箇所に住まわせない)。
  if (folded.valid) {
    const errors = layoutErrors(folded.manifest);
    expect(errors.map((error) => error.path)).toEqual(["/app/views/0/layout"]);
  } else {
    expect(folded.errors.some((error) => error.path.includes("layout"))).toBe(true);
  }
});

test("(h) 葉が指す項目を表示項目から外す update_view は拒否される(自動で外さない。group_by / field_width と同じ)", () => {
  const manifest = withLayout(FORM, { type: "stack", children: ["title", "category"] });
  const folded = foldOperations(manifest, [
    { op: "update_view", view: "order-form", changes: { fields: ["title", "customer"] } },
  ] as unknown as Operation[]);
  expect(folded.valid).toBe(true);
  if (!folded.valid) {
    return;
  }
  const errors = layoutErrors(folded.manifest);
  expect(errors.map((error) => error.path)).toEqual(["/app/views/1/layout/children/1"]);
  expect((folded.manifest.app.views[FORM] as Any).layout).toEqual({
    type: "stack",
    children: ["title", "category"],
  });
});

test("(h) 実際の適用で、4段目の節を含む差分は全体が拒否され、同じ差分の改名も残らない", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "gp-layout-h-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "並べ方", { app_id: "layout-app" });
    const created = applyDiff(dataRoot, "layout-app", {
      diff_id: "d-layout-h-1",
      intent: "表と入力フォーム",
      operations: [
        {
          op: "add_table",
          table: {
            id: "entries",
            name: "エントリ",
            fields: [
              { id: "title", name: "件名", type: "text", required: true },
              { id: "body", name: "本文", type: "long_text" },
            ],
          },
        },
        {
          op: "add_view",
          view: { id: "entry-form", type: "form", table: "entries", fields: ["title", "body"] },
        },
      ],
    } as never);
    expect(created.valid).toBe(true);
    const rejected = applyDiff(dataRoot, "layout-app", {
      diff_id: "d-layout-h-2",
      intent: "改名と、深すぎる木",
      operations: [
        { op: "update_view", view: "entry-form", changes: { name: "改名" } },
        {
          op: "update_view",
          view: "entry-form",
          changes: {
            layout: {
              type: "stack",
              children: [
                {
                  type: "stack",
                  children: [{ type: "stack", children: [{ type: "stack", children: ["title"] }] }],
                },
              ],
            },
          },
        },
      ],
    } as never);
    expect(rejected.valid).toBe(false);
    if (rejected.valid) {
      return;
    }
    expect(rejected.errors.some((error) => error.message.includes("深すぎます"))).toBe(true);
    const after = readCurrentManifest(dataRoot, "layout-app").app.views[0] as Any;
    expect(after.name).toBeUndefined();
    expect(after.layout).toBeUndefined();
    const accepted = applyDiff(dataRoot, "layout-app", {
      diff_id: "d-layout-h-3",
      intent: "件名と本文を縦に積む",
      operations: [
        {
          op: "update_view",
          view: "entry-form",
          changes: {
            layout: { type: "stack", gap: "lg", children: ["title", "body", "action:submit"] },
          },
        },
      ],
    } as never);
    expect(accepted.valid).toBe(true);
  } finally {
    store.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (i) 項目の改名に追随する
// ---------------------------------------------------------------------------

test("(i) change_field で項目の id を改めると、木の中の項目の葉も新しい id に写る(ボタンの葉は動かない)", () => {
  const manifest = withLayout(FORM, {
    type: "sidebar",
    side: "amount",
    main: { type: "stack", children: ["title", "action:submit"] },
  });
  const folded = foldOperations(manifest, [
    { op: "change_field", table: "orders", field: "title", changes: { id: "subject" } },
  ] as unknown as Operation[]);
  expect(folded.valid, JSON.stringify(folded)).toBe(true);
  if (!folded.valid) {
    return;
  }
  expect((folded.manifest.app.views[FORM] as Any).layout).toEqual({
    type: "sidebar",
    side: "amount",
    main: { type: "stack", children: ["subject", "action:submit"] },
  });
  expect(validateManifestFull(folded.manifest).valid).toBe(true);
});

test("(i) change_field の改名は、一覧(カード)と詳細画面(fields あり / 省略)の木の葉にも写り、差分が通る(V20-M5-T07 中2)", () => {
  const manifest = baseManifest();
  (manifest.app.views[LIST] as Any).layout = {
    type: "split",
    start: ["name", "email"],
    end: ["action:order"],
  };
  (manifest.app.views[DETAIL] as Any).layout = {
    type: "sidebar",
    side: "email",
    main: { type: "stack", children: ["name", "action:order"] },
  };
  (manifest.app.views[DETAIL_ALL] as Any).layout = {
    type: "grid",
    children: ["email", "postal_code"],
  };
  const folded = foldOperations(manifest, [
    { op: "change_field", table: "customers", field: "email", changes: { id: "mail" } },
  ] as unknown as Operation[]);
  expect(folded.valid, JSON.stringify(folded)).toBe(true);
  if (!folded.valid) {
    return;
  }
  expect((folded.manifest.app.views[LIST] as Any).layout).toEqual({
    type: "split",
    start: ["name", "mail"],
    end: ["action:order"],
  });
  expect((folded.manifest.app.views[DETAIL] as Any).layout).toEqual({
    type: "sidebar",
    side: "mail",
    main: { type: "stack", children: ["name", "action:order"] },
  });
  expect((folded.manifest.app.views[DETAIL_ALL] as Any).layout).toEqual({
    type: "grid",
    children: ["mail", "postal_code"],
  });
  expect(validateManifestFull(folded.manifest).valid).toBe(true);
});

// ---------------------------------------------------------------------------
// (j) 要件定義書には1文も出さない(silent)
// ---------------------------------------------------------------------------

test("(j) 要件定義書: layout を書いても書かなくても、文の並びが1文字も変わらない", async () => {
  const texts: string[][] = [];
  for (const layout of [
    undefined,
    { type: "stack", gap: "md", children: ["title", "action:submit"] },
  ]) {
    const dataRoot = await mkdtemp(join(tmpdir(), "gp-layout-j-"));
    const store = KernelMetaStore.open(dataRoot);
    try {
      createApp(store, "並べ方", { app_id: "layout-app" });
      const result = applyDiff(dataRoot, "layout-app", {
        diff_id: "d-layout-j-1",
        intent: "入力フォームを縦に積む",
        operations: [
          {
            op: "add_table",
            table: {
              id: "entries",
              name: "エントリ",
              fields: [{ id: "title", name: "件名", type: "text", required: true }],
            },
          },
          {
            op: "add_view",
            view: {
              id: "entry-form",
              type: "form",
              table: "entries",
              fields: ["title"],
              ...(layout === undefined ? {} : { layout }),
            },
          },
        ],
      } as never);
      expect(result.valid).toBe(true);
      texts.push(
        generateRequirementsDoc(dataRoot, "layout-app").statements.map((s) =>
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
// (k) 限定の式を検査に写す(`ADR-0471` 式1〜式3。`ADR-0462` 式3 / 式6 は oneOf の形では空で真になる)
// ---------------------------------------------------------------------------

test("(k) ADR-0471 式1: 枝を1本ずつ開いて型を数える(6種ちょうど・const で判別・各枝 additionalProperties:false)", () => {
  const node = layoutNode();
  const branches = node.oneOf as Any[];
  const types = branches.map((branch) => branch.properties?.type?.const);
  expect(types.length).toBeLessThanOrEqual(6);
  expect(new Set(types).size).toBe(types.length);
  expect(branches.every((branch) => branch.additionalProperties === false)).toBe(true);
  expect(node.discriminator).toEqual({ propertyName: "type" });
  expect(node.properties).toBeUndefined();
});

test("(k) ADR-0471 式4: $defs は 31 を超えない(ADR-0470 式6 の 30 を引き直した)", () => {
  expect(Object.keys(readSchema("manifest.schema.json").$defs).length).toBeLessThanOrEqual(31);
});

test("(k) ADR-0471 式2: 型ごとのキーの和集合は12キーちょうど(3キー + 9キー)", () => {
  const union = new Set(
    (layoutNode().oneOf as Any[]).flatMap((branch) => Object.keys(branch.properties)),
  );
  expect(union.size).toBe(12);
});

test("(k) 陽性対照: ADR-0462 式3 / 式6 の読み方(平らな properties)では何も数えずに真になる", () => {
  const node = layoutNode();
  // 式3: n.get('properties',{}).get('type',{}).get('enum',[]) の写し。
  const flatTypes = node.properties?.type?.enum ?? [];
  const flatGaps = node.properties?.gap?.enum ?? [];
  expect(flatTypes).toEqual([]);
  expect(flatGaps).toEqual([]);
  // 式6: sorted(n.get('properties',{})) の写し。
  expect(Object.keys(node.properties ?? {})).toEqual([]);
});
