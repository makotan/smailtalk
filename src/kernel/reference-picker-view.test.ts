/**
 * 参照項目の「選び方」を、**入力画面ごとに上書きし、`update_view` で後から差し替える**
 * (`K-G2` / `K-G3`。`V6-M2-T01` / `V6-M2-T02` / `ADR-0289`)。
 *
 * **限定表の正は [`docs/adr/0289-reference-picker-view-override.md`](../../docs/adr/0289-reference-picker-view-override.md)
 * §Decision 3**、審査の正は `docs/plan/v6/records/v6-m0.md` §7-2(単位A の `K-G2` / `K-G3`)、
 * 完了条件の正は `docs/plan/v6/01-reference-picker-baseline.md` §7 の `V6-M2` の行 (i)〜(v)。
 *
 * ## このファイルが固定すること(カーネル側)
 *
 * 1. **限定1**: 足すキーは `$defs/view` に1本(`reference_pickers`)だけである
 *    (28 → 29)。**`$defs/field` の `reference_picker`(`V6-M1` / `ADR-0288`)を
 *    1バイトも書き換えず、2本目として作り直さない。**
 * 2. **限定4**: **`form` 分岐だけである。** `list_view` / `detail_view` に書いた差分は
 *    **キー単位で拒否される**(マニフェスト側は `allOf` の `false`、差分側は
 *    `CHANGE_KEYS_BY_VIEW_TYPE`)。
 * 3. **値は「どの項目の選び方か」を区別できる形である** —— **1つの入力画面に参照項目が
 *    複数あっても取り違えない**(`v6-m0.md` §5-2 が `search_fields` を流用しない理由として
 *    挙げた穴を、新しいキーで作り直さない)。
 * 4. **限定2 の継承**: **値域は `$defs/field/properties/reference_picker` の有限3値を
 *    `$ref` でそのまま指す。値域の定義を二重に持たない。** 4値目は差分全体の拒否になる。
 * 5. **限定10 の裏(`K-G3`)**: `update_view` で後から書けて、**値が適用後マニフェストに
 *    実際に残る** —— **受付表(`CHANGE_KEYS_BY_VIEW_TYPE`)と適用関数(`applyViewChanges`)の
 *    両方に書かないと「キーは在るが効かない」になる。**
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * - **優先順位(画面 > 項目 > 既定)の解決は表示層に在り、その実測は
 *   `web/test/reference-picker-override.test.tsx` の担当である。**
 * - **3値のうち `type_filter` / `search` の描画は今日1バイトも実装されていない**
 *   (当たり先は `V6-M4` / `V6-M5`)。**したがって今日この2値を画面に書いても、
 *   画面は今日どおりのプルダウンのままである = 「書けるが今日は効かない」。**
 * - **候補の件数・上限・絞り込み・可視性を1つも扱っていない。**
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { foldOperations } from "./apply-diff.ts";
import type { FormView, Manifest, Operation, View } from "./types.ts";
import { validateDiff, validateManifest, validateManifestFull } from "./validate.ts";

const ROOT = dirname(dirname(import.meta.dir));

// biome-ignore lint/suspicious/noExplicitAny: スキーマ JSON を素で読むための局所エイリアス。
type Any = any;

function readSchema(name: string): Any {
  return JSON.parse(readFileSync(join(ROOT, "schemas", name), "utf8")) as Any;
}

/** 有限3値の全量。**正は `$defs/field/properties/reference_picker` であり、ここはその写しである。** */
const PICKERS = ["list", "type_filter", "search"] as const;

/** 画面側のキー名。**`$defs/field` の `reference_picker`(単数)とは別のキーである。** */
const VIEW_KEY = "reference_pickers";

// --- (a) 限定1: 増分は `$defs/view` に1本だけ ----------------------------------------------

test("限定1: $defs/view.properties は 29 で、29キー目が reference_pickers である", () => {
  const properties = Object.keys(readSchema("manifest.schema.json").$defs.view.properties);
  // **【`V8-M20-T01` / 台帳 `J-G27` / 手続きは `ADR-0301` で 29 → 28 に更新した】** 19キー目
  // だった `audience`(この画面を見せる相手)が**廃止された**(判定 = 廃止)。**代わりに担うのは
  // `app.roles[].rules` の「役割 × 対象(画面)× 読取」である。****旧値の逐語は 29。**
  // **このリポジトリで語彙が減ったのはこれが初めてであり、増分ではなく減分である。**
  // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 28 → 29 へ書き換えた。**
  // **旧行の逐語**: `expect(properties).toHaveLength(28);`
  // **書き換えた理由**: この行が固定していたのは「**その決定**が `$defs/view.properties` の本数 を増やさなかったこと」であり、
  // **29本目を足したのは別の決定である**(`V8-M8` が 集計表の宣言 `report` を29キー目として足した)。**検査は消していない。**
  // **【2026-08-20。`V10-M1-T02`。台帳 `NV-G4`。門A 本審査 = `V10-M0` 群A。ADR = `0359`】**
  // **期待値を 29 → 30 へ書き換えた。****旧行の逐語**: `expect(properties).toHaveLength(29);`
  // **30本目を足したのは別の決定である**(`ADR-0359` §4a 限定1 が削除後の行き先
  // `after_delete` を**末尾に**30キー目として足した。**`detail_view` でだけ書ける**)。
  // **本ファイルが測っている決定の増分ではない。****検査は消していない。**
  // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
  // **期待値を 30 → 31 へ書き換えた。****旧行の逐語**: `expect(properties).toHaveLength(30);`
  // **31本目を足したのは別の決定である**(`ADR-0359` §4b 限定1 が一続きの流れの中の段
  // `flow` を**末尾に**31キー目として足した。**`list_view` / `form` / `detail_view` の3種別で
  // 書け、集計表(`report_view`)には書けない**)。
  // **本ファイルが測っている決定の増分ではない。****検査は消していない。**
  expect(properties).toHaveLength(31);
  // **【2026-08-14。`V8-M8`。台帳 `Q-G1`】末尾は今日 `report`(29キー目)である。**
  // **旧行の逐語**: `expect(properties.at(-1)).toBe(VIEW_KEY);`
  // **`reference_pickers` が末尾から2つ目であることを、位置で今日も固定している** ——
  // **「本キーが最後に足された」という主張は、足された順序そのものとして残っている。**
  // **【2026-08-20。`V10-M1-T02` / `NV-G4` / `ADR-0359`】末尾は今日 `after_delete`
  // (30キー目)である。****旧行の逐語**: `expect(properties.at(-2)).toBe(VIEW_KEY);` /
  // `expect(properties.at(-1)).toBe("report");`
  // **添字を1つずつ後ろへずらしただけで、期待値を1つも緩めていない。**
  // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
  // **末尾に `flow`(一続きの流れの中の段)が31キー目として入ったので、
  // 位置の添字を1つ後ろへずらした。****旧行の逐語**: `expect(properties.at(-3)).toBe(VIEW_KEY);`
  // **添字を後ろへずらしただけで、期待値を1つも緩めていない。**
  expect(properties.at(-4)).toBe(VIEW_KEY);
  expect(properties.at(-3)).toBe("report");
  expect(properties.at(-2)).toBe("after_delete");
  // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。ADR = `0359` / `0360`】末尾は今日 `flow` である。**
  // **`after_delete` はもう末尾ではない** —— **上の行の添字を1つ後ろへずらし、
  // 末尾の位置をここで新しく固定した。****位置の主張を1つも緩めていない。**
  expect(properties.at(-1)).toBe("flow");
  expect(properties.filter((key) => key === VIEW_KEY)).toHaveLength(1);
});

test("限定1: $defs/field の reference_picker を1バイトも書き換えず、2本目を作っていない", () => {
  const manifest = readSchema("manifest.schema.json");
  const field = manifest.$defs.field.properties.reference_picker as Any;
  const { $comment: _c, description: _d, ...shape } = field;
  // **`ADR-0288` 限定2 が固定した形そのままである。**
  expect(shape).toEqual({ enum: [...PICKERS] });
  // **`$defs/view` の側に `reference_picker`(単数)は無い** —— 同じものを2本置いていない。
  expect(manifest.$defs.view.properties.reference_picker).toBeUndefined();
  expect(manifest.$defs.table.properties[VIEW_KEY]).toBeUndefined();
  expect(manifest.$defs.field.properties[VIEW_KEY]).toBeUndefined();
});

// **【`V8-M18` / 台帳 `J-G12` による期待値の更新。2026-08-09】** **旧テスト名の逐語**:
// 「**限定1: $defs の本数も view.allOf の分岐数も1つも増えていない**」。**旧本体の逐語**:
// `expect(Object.keys(manifest.$defs)).toHaveLength(28)`。
// **本 ADR の増分は今日も `$defs` を1本も増やしていない** —— **28 → 29 にしたのは
// `V8-M18` が新設した `role_condition` 1本だけである。****旧文を1バイトも消していない。**
test("限定1: $defs は 29(増やしたのは V8-M18 の1本だけ)/ view.allOf の分岐数は1つも増えていない", () => {
  const manifest = readSchema("manifest.schema.json");
  // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 29 → 30 へ書き換えた。**
  // **旧行の逐語**: `expect(Object.keys(manifest.$defs)).toHaveLength(29);`
  // **書き換えた理由**: この行が固定していたのは「**その決定**が新しい `$defs` を作らなかったこと」
  // であり、**30本目を作ったのは別の決定である**(`V8-M8` が集計表の中身 `$defs/report` を新設した)。
  // **検査は消していない。**
  expect(Object.keys(manifest.$defs)).toHaveLength(30);
  expect(Object.keys(manifest.$defs)).toContain("role_condition");
  // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 4 → 5 へ書き換えた。**
  // **旧行の逐語**: `expect(manifest.$defs.view.allOf).toHaveLength(4);`
  // **書き換えた理由**: この行が固定していたのは「**`ADR-0289`(参照項目の選び方)の決定**が
  // 分岐を1つも増やさなかったこと」であり、**5分岐目を足したのは別の決定である**
  // (`V8-M8` が画面種別の4種目 `report_view` の分岐を新設した)。**検査は消していない。**
  expect(manifest.$defs.view.allOf).toHaveLength(5);
  // **【`V6-M3-T01` / `K-G6` / `ADR-0290` 限定1 で 4 → 5 に更新した】** 5キー目
  // `reference_search_fields`(このテーブルが参照されたときの「探せる項目」の既定)が門A を
  // 通って増えた(`V6-M0` 単位B。判定 = 限定採用)。**本 ADR の増分ではない。**
  // **【`V7-M1-T01` / `Z-G2` で 5 → 6 に更新した】** 6キー目 `access_control`(この表で
  // アクセス権管理を使うことと、付与・グループ・メンバーの置き場所の宣言)が門A を通って
  // 増えた(`V7-M0`。判定 = 限定採用)。**`$defs` の本数28 は動いていない**(値域はインライン)。
  // **本 ADR の増分ではない。**
  expect(Object.keys(manifest.$defs.table.properties)).toHaveLength(6);
  // **【`V6-M3-T02` / `K-G7` / `ADR-0290` 限定1 で 13 → 14 に更新した】** 14キー目
  // `reference_search_fields`(参照候補の「探せる項目」の、項目ごとの上書き)が門A を通って
  // 増えた(`V6-M0` 単位B。判定 = 限定採用)。**`reference` 型にだけ書けるキーである。**
  // **本 ADR の増分ではない。**
  // **【`V8-M20-T01` / 台帳 `J-G27` / `J-G28` / 手続きは `ADR-0301` で 14 → 12 に更新した】**
  // 8キー目だった `audience`(この項目を見せる相手)と9キー目だった `writable_by`(この項目を
  // 書ける相手)が**2本とも廃止された**(判定 = 廃止)。**代わりに担うのは `app.roles[].rules` の
  // 「役割 × 対象(項目)× 読取 / 書込」である。****旧値の逐語は 14。**
  expect(Object.keys(manifest.$defs.field.properties)).toHaveLength(12);
});

test("限定1: 専用の差分操作もフィールド型もリソース種も作っていない", () => {
  const { DIFF_OPS, FIELD_TYPES, RESOURCE_KINDS } = require("./types.ts") as {
    DIFF_OPS: readonly string[];
    FIELD_TYPES: readonly string[];
    RESOURCE_KINDS: readonly string[];
  };
  // **【`V8-M16` / `J-G1b` / `D-V8-31`】期待値を 17 → 18 に書き換えた —— 18種目 `set_roles` を足したため。検査は消していない。**
  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】**
  // **旧(逐語)**: `expect(DIFF_OPS).toHaveLength(18);`
  // **`set_user_kinds` を撤去したので 18 → 17。**この検査が測る「参照項目の選び方に専用の op /
  // フィールド型 / リソース種を作っていないこと」は1ミリも弱めていない(下の3行が今日も測る)。
  expect(DIFF_OPS).toHaveLength(17);
  expect(FIELD_TYPES).toHaveLength(9);
  // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 7 → 8 へ書き換えた。**
  // **旧行の逐語**: `expect(RESOURCE_KINDS).toHaveLength(7);`
  // **書き換えた理由**: この行が固定していたのは「**`ADR-0289` の決定**がリソース種を
  // 増やさなかったこと」であり、**8種目を足したのは別の決定である**(`V8-M8` の `report_view`)。
  // **検査は消していない。**
  expect(RESOURCE_KINDS).toHaveLength(8);
  expect(DIFF_OPS.some((op) => op.includes("picker"))).toBe(false);
});

// --- (b) 値の形: どの項目の選び方かを区別できる -------------------------------------------

test("値は「フィールドID → 選び方」の対応であり、値域を二重に持たない", () => {
  const key = readSchema("manifest.schema.json").$defs.view.properties[VIEW_KEY] as Any;
  const { $comment: _c, description: _d, ...shape } = key;
  expect(shape).toEqual({
    type: "object",
    propertyNames: { $ref: "#/$defs/resource_id" },
    // **値域は `$defs/field/properties/reference_picker` を指すだけである**
    // (`enum` をここに写していない = 値域の定義が1箇所)。
    additionalProperties: { $ref: "#/$defs/field/properties/reference_picker" },
  });
});

test("限定3: スキーマに default を1つも書いていない(既定は表示層が持つ)", () => {
  const key = readSchema("manifest.schema.json").$defs.view.properties[VIEW_KEY] as Any;
  expect("default" in key).toBe(false);
});

function manifestWith(view: Record<string, unknown>): unknown {
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
            { id: "supplier_id", name: "仕入先", type: "reference", reference_table: "customer" },
          ],
        },
      ],
      views: [view],
    },
  };
}

function formView(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "order-form",
    type: "form",
    table: "order",
    fields: ["memo", "customer_id", "supplier_id"],
    ...extra,
  };
}

test("(i) form に3値それぞれを書いたマニフェストが検証を通る", () => {
  for (const picker of PICKERS) {
    const result = validateManifest(
      manifestWith(formView({ [VIEW_KEY]: { customer_id: picker } })),
    );
    expect(result.valid, picker).toBe(true);
  }
});

test("1つの入力画面に参照項目が2本あっても、項目ごとに別の選び方を書ける(取り違えない)", () => {
  const result = validateManifest(
    manifestWith(formView({ [VIEW_KEY]: { customer_id: "search", supplier_id: "type_filter" } })),
  );
  expect(result.valid).toBe(true);
});

test("限定2 の継承: 4値目・空文字・真偽値・配列・数値は拒否される", () => {
  for (const value of ["popup", "dropdown", "", true, ["list"], 1, null]) {
    const result = validateManifest(manifestWith(formView({ [VIEW_KEY]: { customer_id: value } })));
    expect(result.valid, JSON.stringify(value)).toBe(false);
  }
});

test("キー名が resource_id の形でないものは拒否される", () => {
  const result = validateManifest(manifestWith(formView({ [VIEW_KEY]: { "not an id!": "list" } })));
  expect(result.valid).toBe(false);
});

// --- (c) 限定4: form 分岐だけ ---------------------------------------------------------------

test("(iv) list_view に書いたマニフェストは拒否される", () => {
  const result = validateManifest(
    manifestWith({
      id: "order-list",
      type: "list_view",
      table: "order",
      columns: ["memo"],
      [VIEW_KEY]: { customer_id: "search" },
    }),
  );
  expect(result.valid).toBe(false);
});

test("(iv) detail_view に書いたマニフェストは拒否される", () => {
  const result = validateManifest(
    manifestWith({
      id: "order-detail",
      type: "detail_view",
      table: "order",
      [VIEW_KEY]: { customer_id: "search" },
    }),
  );
  expect(result.valid).toBe(false);
});

test("限定4: allOf の list_view / detail_view 分岐が false で閉じている(機械的な担保)", () => {
  const branches = readSchema("manifest.schema.json").$defs.view.allOf as Any[];
  for (const type of ["list_view", "detail_view"]) {
    const branch = branches.find((entry) => entry.if?.properties?.type?.const === type);
    expect(branch?.then?.properties?.[VIEW_KEY], type).toBe(false);
  }
  // **form 分岐は `false` を持たない**(書ける唯一の種別である)。
  const form = branches.find((entry) => entry.if?.properties?.type?.const === "form");
  expect(form?.then?.properties?.[VIEW_KEY]).toBeUndefined();
});

// --- (d) `K-G3`: view_changes の24キー目 ---------------------------------------------------

test("(iii) view_changes.properties は 24 で、24キー目が reference_pickers である", () => {
  const viewChanges = readSchema("diff.schema.json").$defs.view_changes;
  const properties = Object.keys(viewChanges.properties);
  // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 24 → 25 へ書き換えた。**
  // **旧行の逐語**: `expect(properties).toHaveLength(24);`
  // **書き換えた理由**: この行が固定していたのは「**その決定**が `view_changes.properties` の本数 を増やさなかったこと」であり、
  // **25本目を足したのは別の決定である**(`V8-M8` が 集計表の宣言 `report` を25キー目として足した)。**検査は消していない。**
  // **【2026-08-20。`V10-M1-T02`。台帳 `NV-G4`。ADR = `0359` §Decision 2】**
  // **期待値を 25 → 26 へ書き換えた。****旧行の逐語**: `expect(properties).toHaveLength(25);`
  // **26本目を足したのは別の決定である**(`after_delete` を `view_changes` の末尾に足した)。
  // **本ファイルが測っている決定の増分ではない。****検査は消していない。**
  // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
  // **期待値を 26 → 27 へ書き換えた。****旧行の逐語**: `expect(properties).toHaveLength(26);`
  // **27本目を足したのは別の決定である**(`flow` を `view_changes` の末尾に足した。
  // `ADR-0359` §Decision 2)。**本ファイルが測っている決定の増分ではない。**
  // **検査は消していない。**
  expect(properties).toHaveLength(27);
  // **【2026-08-14。`V8-M8`。台帳 `Q-G1`】末尾は今日 `report`(25キー目)である。**
  // **旧行の逐語**: `expect(properties.at(-1)).toBe(VIEW_KEY);`
  // **【2026-08-20。`V10-M1-T02` / `ADR-0359` §Decision 2】末尾は今日 `after_delete`
  // (26キー目)である。****旧行の逐語**: `expect(properties.at(-2)).toBe(VIEW_KEY);` /
  // `expect(properties.at(-1)).toBe("report");`
  // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
  // **末尾に `flow`(一続きの流れの中の段)が31キー目として入ったので、
  // 位置の添字を1つ後ろへずらした。****旧行の逐語**: `expect(properties.at(-3)).toBe(VIEW_KEY);`
  // **添字を後ろへずらしただけで、期待値を1つも緩めていない。**
  expect(properties.at(-4)).toBe(VIEW_KEY);
  expect(properties.at(-3)).toBe("report");
  expect(properties.at(-2)).toBe("after_delete");
  // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。ADR = `0359` / `0360`】末尾は今日 `flow` である。**
  // **`after_delete` はもう末尾ではない** —— **上の行の添字を1つ後ろへずらし、
  // 末尾の位置をここで新しく固定した。****位置の主張を1つも緩めていない。**
  expect(properties.at(-1)).toBe("flow");
  expect((viewChanges.properties[VIEW_KEY] as Any).$ref).toBe(
    "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/view/properties/reference_pickers",
  );
});

test("既存 $comment を1バイトも書き換えていない(actions の逐語が着手前のまま在る)", () => {
  const viewChanges = readSchema("diff.schema.json").$defs.view_changes;
  const actions = (viewChanges.properties.actions as Any).$comment as string;
  expect(actions).toContain("**23キー目である。**");
  expect(actions).toContain("**置き換えとなる新しい不変条件: 24キー目を足してはならない。**");
  // **新しい $comment の側に、置き換えとなる新しい不変条件を書く。**
  const added = (viewChanges.properties[VIEW_KEY] as Any).$comment as string;
  expect(added).toContain("**24キー目である。**");
  expect(added).toContain("25キー目を足してはならない");
});

test("既存の漏れの是正: view_changes.description が24キーを1つ残らず列挙している", () => {
  // **これは v6 の成果ではない。** 着手前の description は16キーしか列挙していなかった
  // (実測23)。**`01` §4-2 (d) の注記が名指しした既存の漏れである。**
  const viewChanges = readSchema("diff.schema.json").$defs.view_changes;
  const description = viewChanges.description as string;
  for (const key of Object.keys(viewChanges.properties)) {
    expect(description, key).toContain(key);
  }
});

test("(iii) 受付表(CHANGE_KEYS_BY_VIEW_TYPE)の form にだけ入っている", () => {
  const source = readFileSync(join(ROOT, "src", "kernel", "apply-diff.ts"), "utf8");
  const table = source.slice(
    source.indexOf("const CHANGE_KEYS_BY_VIEW_TYPE"),
    source.indexOf("* 破壊的操作", source.indexOf("const CHANGE_KEYS_BY_VIEW_TYPE")),
  );
  expect(table.split(`"${VIEW_KEY}",`).length - 1).toBe(1);
});

function baseManifest(): Manifest {
  return manifestWith(formView()) as Manifest;
}

function viewOf(manifest: Manifest, id: string): View & { reference_pickers?: unknown } {
  const view = manifest.app.views?.find((candidate) => candidate.id === id);
  if (view === undefined) {
    throw new Error(`ビュー ${id} が無い`);
  }
  return view;
}

function fold(manifest: Manifest, operations: Operation[]): Manifest {
  const result = foldOperations(manifest, operations);
  if (!result.valid) {
    throw new Error(`畳み込みに失敗した: ${JSON.stringify(result.errors)}`);
  }
  return result.manifest;
}

test("(iii) update_view で書いた reference_pickers が適用後マニフェストに実際に残る", () => {
  const next = fold(baseManifest(), [
    {
      op: "update_view",
      view: "order-form",
      changes: { [VIEW_KEY]: { customer_id: "search" } },
    } as Operation,
  ]);
  expect(viewOf(next, "order-form").reference_pickers).toEqual({ customer_id: "search" });
});

test("(iii) 別のキーを update_view しても reference_pickers は消えない", () => {
  const first = fold(baseManifest(), [
    {
      op: "update_view",
      view: "order-form",
      changes: { [VIEW_KEY]: { customer_id: "type_filter" } },
    } as Operation,
  ]);
  const second = fold(first, [
    { op: "update_view", view: "order-form", changes: { name: "注文の入力" } } as Operation,
  ]);
  expect(viewOf(second, "order-form").reference_pickers).toEqual({ customer_id: "type_filter" });
  expect(viewOf(second, "order-form").name).toBe("注文の入力");
});

test("(iii) 全置換である(2本書いてから1本だけ書くと1本になる)", () => {
  const first = fold(baseManifest(), [
    {
      op: "update_view",
      view: "order-form",
      changes: { [VIEW_KEY]: { customer_id: "search", supplier_id: "type_filter" } },
    } as Operation,
  ]);
  const second = fold(first, [
    {
      op: "update_view",
      view: "order-form",
      changes: { [VIEW_KEY]: { supplier_id: "list" } },
    } as Operation,
  ]);
  expect(viewOf(second, "order-form").reference_pickers).toEqual({ supplier_id: "list" });
});

test("add_view でも書ける(2経路のうち2つ目)", () => {
  const next = fold(baseManifest(), [
    {
      op: "add_view",
      view: {
        id: "order-form-2",
        type: "form",
        table: "order",
        fields: ["customer_id"],
        [VIEW_KEY]: { customer_id: "search" },
      },
    } as Operation,
  ]);
  expect(viewOf(next, "order-form-2").reference_pickers).toEqual({ customer_id: "search" });
});

// --- (e) 限定4 の差分側: キー単位の拒否 -----------------------------------------------------

function listAndDetailManifest(): Manifest {
  const manifest = baseManifest();
  manifest.app.views = [
    ...(manifest.app.views ?? []),
    { id: "order-list", type: "list_view", table: "order", columns: ["memo"] },
    { id: "order-detail", type: "detail_view", table: "order" },
  ];
  return manifest;
}

test("(iv) list_view を対象にした update_view はキー単位で拒否される", () => {
  const result = foldOperations(listAndDetailManifest(), [
    {
      op: "update_view",
      view: "order-list",
      changes: { [VIEW_KEY]: { customer_id: "search" } },
    } as Operation,
  ]);
  expect(result.valid).toBe(false);
  if (result.valid) {
    throw new Error("拒否されなかった");
  }
  expect(JSON.stringify(result.errors)).toContain(VIEW_KEY);
});

test("(iv) detail_view を対象にした update_view はキー単位で拒否される", () => {
  const result = foldOperations(listAndDetailManifest(), [
    {
      op: "update_view",
      view: "order-detail",
      changes: { [VIEW_KEY]: { customer_id: "search" } },
    } as Operation,
  ]);
  expect(result.valid).toBe(false);
});

test("(iv) 正しい操作が同じ差分にあっても、拒否は差分全体である(部分適用しない)", () => {
  const result = foldOperations(listAndDetailManifest(), [
    {
      op: "update_view",
      view: "order-form",
      changes: { [VIEW_KEY]: { customer_id: "search" } },
    } as Operation,
    {
      op: "update_view",
      view: "order-list",
      changes: { [VIEW_KEY]: { customer_id: "search" } },
    } as Operation,
  ]);
  expect(result.valid).toBe(false);
});

test("update_view で4値目を書いた差分は、差分の時点で拒否される", () => {
  const result = validateDiff({
    diff_id: "d-picker-view-1",
    operations: [
      {
        op: "update_view",
        view: "order-form",
        changes: { [VIEW_KEY]: { customer_id: "typeahead" } },
      },
    ],
  });
  expect(result.valid).toBe(false);
});

// --- (f) 限定3: 書かなかった画面にキーが生えない --------------------------------------------

test("(ii) 書かなかった画面にキーが生えない(既定を反転させていない)", () => {
  const next = fold(baseManifest(), [
    { op: "update_view", view: "order-form", changes: { name: "注文の入力" } } as Operation,
  ]);
  expect(VIEW_KEY in viewOf(next, "order-form")).toBe(false);
});

// --- (f-2) 実在照合と型の照合(`ADR-0086` 限定4)-------------------------------------------

test("実在しないフィールドIDを書いた add_view 相当のマニフェストは拒否される", () => {
  // **黙って通って黙って効かない(`representative_field` の穴)を3件目として作らない。**
  const result = validateManifestFull(
    manifestWith(formView({ [VIEW_KEY]: { no_such_field: "search" } })),
  );
  expect(result.valid).toBe(false);
  if (result.valid) {
    throw new Error("拒否されなかった");
  }
  expect(
    result.errors.some((error) => error.path.endsWith("/reference_pickers/no_such_field")),
  ).toBe(true);
});

test("reference でない型のフィールドIDを書いたマニフェストは拒否される", () => {
  const result = validateManifestFull(manifestWith(formView({ [VIEW_KEY]: { memo: "search" } })));
  expect(result.valid).toBe(false);
  if (result.valid) {
    throw new Error("拒否されなかった");
  }
  expect(result.errors.some((error) => error.path.endsWith("/reference_pickers/memo"))).toBe(true);
});

test("同じ照合が update_view の経路でも効く(判定を2箇所に住まわせていない)", () => {
  for (const fieldId of ["no_such_field", "memo"]) {
    const folded = fold(baseManifest(), [
      {
        op: "update_view",
        view: "order-form",
        changes: { [VIEW_KEY]: { [fieldId]: "search" } },
      } as Operation,
    ]);
    // **畳み込み自体は通る** —— **拒否するのは適用後マニフェストを見る1箇所である**
    // (`applyDiff` はこの順で `validateManifestFull` を必ず通す)。
    const result = validateManifestFull(folded);
    expect(result.valid, fieldId).toBe(false);
    if (result.valid) {
      throw new Error("拒否されなかった");
    }
    expect(JSON.stringify(result.errors), fieldId).toContain("reference_pickers");
  }
});

// --- (g) 型(src/kernel/types.ts)にも同じ形が入っていること ---------------------------------

test("src/kernel/types.ts の FormView と ViewChanges の両方に同じ形が入っている", () => {
  const source = readFileSync(join(ROOT, "src", "kernel", "types.ts"), "utf8");
  const declaration = 'reference_pickers?: Record<ResourceId, "list" | "type_filter" | "search">;';
  expect(source.split(declaration).length - 1).toBe(2);
});

test("型の上でも3値だけが受かる(4値目は typecheck が止める)", () => {
  const view: FormView = {
    id: "order-form",
    type: "form",
    table: "order",
    fields: ["customer_id"],
    reference_pickers: { customer_id: "search" },
  };
  expect(view.reference_pickers?.customer_id).toBe("search");
  const changes: import("./types.ts").ViewChanges = {
    reference_pickers: { customer_id: "type_filter" },
  };
  expect(changes.reference_pickers?.customer_id).toBe("type_filter");
});
