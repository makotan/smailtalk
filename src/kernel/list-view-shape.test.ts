/**
 * 一覧の形を画面ごとに選ぶ8つ目のプリセットキー(`P-G24` の (C) 側。`V4-M16-T13` / `ADR-0093`)。
 *
 * **限定表の正は [`docs/adr/0093-list-view-shape.md`](../../docs/adr/0093-list-view-shape.md) §Decision 2(限定1〜限定10)**、
 * 完了条件の正は `docs/plan/v4/records/v4-m16.md` §2-3 の `V4-M16-T13` 節(10点)。
 *
 * **門A の判定 = 限定採用**(審査記録 = `docs/plan/v4/records/v4-m14-gate-a-list-shape.md`)。
 *
 * ## このファイルが固定すること(カーネル側)
 *
 * 1. **限定1**: 足すキーは `$defs/view` に1本(`preset_list_shape`)だけ。**`$defs` の本数 28 /
 *    `$defs/field.properties` 11 / `$defs/table.properties` 6 / `$defs/theme` 25 / 25 /
 *    `RESOURCE_KINDS` 7 / `FIELD_TYPES` 8 / `DIFF_OPS` 16 が1つも動かない。**
 *    【`V7-M1-T02`】**`$defs/table.properties` の数を 4 → 6 に是正した** —— `V6-M3-T01`
 *    (`ADR-0290`。4 → 5)と `V7-M1-T01`(`Z-G2`。5 → 6)が本体を動かしたのに、この行だけが
 *    `4` のまま残っていた(`v7-m0.md` §4-3 の表の5 が名指しした食い違い)。
 *    **【直していないものを正直に書く】同じ行の `$defs/field.properties` 11(実物 14)/
 *    `FIELD_TYPES` 8(実物 9)/ `DIFF_OPS` 16(実物 17)も今日の実物と食い違っている。**
 *    **本タスクの担当は `$defs/table` の1本だけなので、この3つは直していない。**
 * 2. **限定2**: `list_view` 分岐でだけ許す(`detail_view` / form 分岐では `false`)。
 *    **3つの分岐の `false` の本数を数える。**
 * 3. **限定3**: 値域は2値ちょうど。**3値目(`grid` / `kanban` / `calendar` / `timeline`)を
 *    書いた差分は拒否される。自由文字列も自由な数値も受けない。**
 * 4. **限定8**: **`card` と列の軸の組み合わせは機械では止めていない** —— 受理されることを
 *    実測で固定し、**説明文がその事実を述べていること**をもって「黙って作っていない」を示す。
 * 5. **限定10 / 完了条件 (7)(9)**: `view_changes.properties` は 16 で、**`update_view` で
 *    書いた値が適用後マニフェストに実際に残る**(「書けるが効かない」を作っていないことの実測)。
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * - **カードの描画は表示層である** —— `web/test/list-view-shape.test.tsx` の担当。
 *   **このファイルは1ピクセルも見ていない。**
 * - **`card` が実地で見やすいかを1件も測っていない。** 測ったのは「書けるか」「運ばれるか」だけである。
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { VOCABULARY_SCOPE } from "../mcp/vocabulary.ts";
import { foldOperations } from "./apply-diff.ts";
import type { ListView, Manifest, Operation } from "./types.ts";
import { validateDiff, validateManifestFull } from "./validate.ts";

const ROOT = dirname(dirname(import.meta.dir));

// biome-ignore lint/suspicious/noExplicitAny: スキーマ JSON を素で読むための局所エイリアス(既存の検査と同じ作法)。
type Any = any;

function readSchema(name: string): Any {
  return JSON.parse(readFileSync(join(ROOT, "schemas", name), "utf8")) as Any;
}

function manifestSchema(): Any {
  return readSchema("manifest.schema.json");
}

function diffSchema(): Any {
  return readSchema("diff.schema.json");
}

/** `allOf` の3分岐を種別で引く(`if.properties.type.const` が種別名)。 */
function branch(type: "list_view" | "form" | "detail_view"): Any {
  const found = (manifestSchema().$defs.view.allOf as Any[]).find(
    (candidate) => candidate.if?.properties?.type?.const === type,
  );
  expect(found, `${type} 分岐`).toBeDefined();
  return found;
}

/** `then.properties` のうち値が `false`(= 書けない)のキー名。 */
function falseKeys(type: "list_view" | "form" | "detail_view"): string[] {
  const properties = (branch(type).then?.properties ?? {}) as Record<string, unknown>;
  return Object.entries(properties)
    .filter(([, value]) => value === false)
    .map(([key]) => key)
    .sort();
}

function baseManifest(): Manifest {
  return {
    app: {
      id: "shape-app",
      name: "形のサンプル",
      tables: [
        {
          id: "entries",
          name: "記録",
          fields: [
            { id: "title", name: "件名", type: "text" },
            { id: "amount", name: "金額", type: "number" },
          ],
        },
      ],
      views: [
        { id: "entry-list", type: "list_view", table: "entries", columns: ["title", "amount"] },
        { id: "entry-form", type: "form", table: "entries", fields: ["title", "amount"] },
        { id: "entry-detail", type: "detail_view", table: "entries", fields: ["title", "amount"] },
      ],
    },
  };
}

/** `list_view` に1キーだけ書いたマニフェストを、適用後マニフェストの構造検証に掛ける。 */
function validateListViewWith(extra: Record<string, unknown>): boolean {
  const manifest = baseManifest();
  Object.assign(manifest.app.views[0] as ListView, extra);
  return validateManifestFull(manifest).valid;
}

// ---------------------------------------------------------------------------
// (a) 増分の総量(限定1)
// ---------------------------------------------------------------------------

test("(a) 限定1: $defs/view.properties は 22 で、22キー目は preset_list_shape である", () => {
  const properties = Object.keys(manifestSchema().$defs.view.properties);
  // **【V4-M18-T03 / ADR-0095 限定1 で 22 → 23 に更新した】** 門A の本審査(V4-M18 単位3。
  // 判定 = 限定採用)が23キー目 `modal`(重ねて出す宣言)を足した。**本 ADR の増分ではない
  // —— `preset_list_shape` が22キー目であることは今日も真である。**
  // **【V4-M22-T01 / ADR-0112 限定1 で 23 → 24 に更新した】** 門A の本審査(V4-M22 単位A。
  // 判定 = 限定採用)が24キー目 `search_fields`(検索の対象にする列)を足した。**本 ADR の
  // 増分ではない —— `preset_list_shape` が22キー目であることは今日も真である。**
  // **【V4-M22-T05 / ADR-0113 限定1 で 24 → 25 に更新した】** 門A の本審査(V4-M22 単位C。
  // **4回目の審査**。判定 = 限定採用)が25キー目 `page_size`(1ページに出す件数)を足した。
  // **本 ADR の増分ではない —— `preset_list_shape` が22キー目であることは今日も真である。**
  // **【V4-M19-T03 / ADR-0118 限定1 で 25 → 26 に更新した】** 26キー目 `preset_density`
  // (画面の詰まり具合)が門A を通って増えた(V4-M19 単位C。2回目の審査。判定 = 限定採用)。
  // **3種すべてに書けるキーである。****本 ADR の増分ではない —— `preset_list_shape` が
  // 22キー目であることは今日も真である。**
  // **【V4-M20-T04 / ADR-0102 限定1 で 26 → 27 に更新した】** 27キー目 `after_save`
  // (保存が成立したあとに行く画面のID)が門A を通って増えた(V4-M20 単位D。2回目の審査。
  // 判定 = 限定採用)。**form 型のビューでだけ書ける。****本 ADR の増分ではない ——
  // `preset_list_shape` が22キー目であることは今日も真である。**
  // **【V4-M23-T01 / ADR-0104 限定1 で 27 → 28 に更新した】** 28キー目 `sum_field`
  // (合計を出す列)が門A を通って増えた(判定 = 限定採用)。**`list_view` でだけ書ける。**
  // **本 ADR の増分ではない —— `preset_list_shape` が22キー目であることは今日も真である。**
  // **【`V6-M2-T01` / `K-G2` / `ADR-0289` 限定1 で 28 → 29 に更新した】** 29キー目 `reference_pickers`
  // (参照項目の選び方の、入力画面ごとの上書き)が門A を通って増えた(`V6-M0` 単位A。判定 = 限定採用)。
  // **`form` 型のビューでだけ書ける。****本 ADR の増分ではない。**
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
  // **【`V6-M2-T01` / `K-G2` / `ADR-0289` 限定1 で書き換えた】** 29キー目 `reference_pickers`
  // (参照項目の選び方の、入力画面ごとの上書き。`form` でだけ書ける)が末尾に入ったので、
  // **`sum_field`(28キー目)が今日も1つ手前であることは変わらない。**
  // **【2026-08-14。`V8-M8`。台帳 `Q-G1`】末尾に29キー目 `report`(集計表の中身)が入ったので、
  // 位置の添字を1つずつ後ろへずらした。****旧行の逐語は `at(-8)`〜`at(-1)` が
  // `preset_list_shape` / `modal` / `search_fields` / `page_size` / `preset_density` /
  // `after_save` / `sum_field` / `reference_pickers` の8行である。**
  // **【2026-08-20。`V10-M1-T02`。台帳 `NV-G4`。ADR = `0359`】末尾に `after_delete`
  // (削除が成立したあとの行き先)が入ったので、位置の添字を1つずつ後ろへずらした。**
  // **添字を後ろへずらしただけで、期待値を1つも緩めていない。**
  // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
  // **末尾に `flow`(一続きの流れの中の段)が31キー目として入ったので、
  // 位置の添字を1つ後ろへずらした。****旧行の逐語**: `expect(properties.at(-10)).toBe("preset_list_shape");`
  // **添字を後ろへずらしただけで、期待値を1つも緩めていない。**
  expect(properties.at(-11)).toBe("preset_list_shape");
  expect(properties.at(-10)).toBe("modal");
  expect(properties.at(-9)).toBe("search_fields");
  expect(properties.at(-8)).toBe("page_size");
  expect(properties.at(-7)).toBe("preset_density");
  expect(properties.at(-6)).toBe("after_save");
  expect(properties.at(-5)).toBe("sum_field");
  expect(properties.at(-4)).toBe("reference_pickers");
  expect(properties.at(-3)).toBe("report");
  expect(properties.at(-2)).toBe("after_delete");
  // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。ADR = `0359` / `0360`】末尾は今日 `flow` である。**
  // **`after_delete` はもう末尾ではない** —— **上の行の添字を1つ後ろへずらし、
  // 末尾の位置をここで新しく固定した。****位置の主張を1つも緩めていない。**
  expect(properties.at(-1)).toBe("flow");
  expect(manifestSchema().$defs.view.additionalProperties).toBe(false);
});

// **【V4-M19-T03 / ADR-0118 限定1 で 8 → 9 に更新した】** 9つ目の `preset_` キー `preset_density`
// (画面の詰まり具合)が門A を通って増えた(V4-M19 単位C。2回目の審査。判定 = 限定採用)。
// **3種すべてに書けるキーである。****本 ADR の増分ではない。**
test("(a) 限定1: preset_ で始まるキーは8本ちょうどである(8つ目のプリセットキー)", () => {
  const presetKeys = Object.keys(manifestSchema().$defs.view.properties).filter((key) =>
    key.startsWith("preset_"),
  );
  expect(presetKeys.sort()).toEqual([
    "preset_column_align",
    "preset_column_width",
    "preset_density",
    "preset_field_columns",
    "preset_image_size",
    "preset_label_placement",
    "preset_list_shape",
    "preset_pager_position",
    "preset_text_preview",
  ]);
});

// 【`V7-M1-T02`】**テスト名の `table 4` を `table 6` へ是正した。** 旧: 「(a) 限定1: field 12 /
//   table 4 / theme 25・25 が1つも動いていない」。**`V6-M3-T01`(4 → 5)と `V7-M1-T01`(5 → 6)が
//   本体を動かしたのに名前が `4` のまま残っていた。**
//   **【直していないものを正直に書く】`field 12` も本体が 14 を測っており食い違っている。**
//   **本タスクの担当は `$defs/table` の1本だけなので、`field` の側は直していない。**
test("(a) 限定1: field 12 / table 6 / theme 25・25 が1つも動いていない", () => {
  const schema = manifestSchema();
  // 【`V5-M29-T03` / `ADR-0250` 限定11】ここにあった「$defs 28 が1つも動いていない」の検査は
  //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
  //   `manifest.$defs:` で始まる行)。**総量ではなく名前と順序で見張る。**
  //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  // 【`V5-M29-T03`】**テスト名を書き換えた。** 旧: 「(a) 限定1: $defs 28 / field 11 / table 4 / theme 25 / 語彙3種が1つも動いていない」。
  //   本体から `$defs` と語彙3種を測る `expect` が消えたため(記録 §4-7)。**`field 11` は消す前から本体が 12 を測っており、食い違っていた。**
  // **【V4-M19-T07 / ADR-0119 限定1 で 11 → 12 に更新した】** 12キー目 `hide_when_empty`
  // (値が無いとき行ごと出さない)が門A を通って増えた(V4-M19 単位E-a。2回目の審査。
  // 判定 = 限定採用)。**8型すべてに書けるキーである。****本 ADR の増分ではない。**
  // **【V6-M1-T01 / K-G1 / ADR-0288 限定1 で 12 → 13 に更新した】** 13キー目 `reference_picker`
  // (他のテーブルから選ぶ項目の選び方)が門A を通って増えた(V6-M0 単位A。判定 = 限定採用)。
  // **reference 型にだけ書けるキーである。****本 ADR の増分ではない。**
  // **【`V6-M3-T02` / `K-G7` / `ADR-0290` 限定1 で 13 → 14 に更新した】** 14キー目
  // `reference_search_fields`(参照候補の「探せる項目」の、項目ごとの上書き)が門A を通って
  // 増えた(`V6-M0` 単位B。判定 = 限定採用)。**`reference` 型にだけ書けるキーである。**
  // **本 ADR の増分ではない。**
  // **【`V8-M20-T01` / 台帳 `J-G27` / `J-G28` / 手続きは `ADR-0301` で 14 → 12 に更新した】**
  // 8キー目だった `audience`(この項目を見せる相手)と9キー目だった `writable_by`(この項目を
  // 書ける相手)が**2本とも廃止された**(判定 = 廃止)。**代わりに担うのは `app.roles[].rules` の
  // 「役割 × 対象(項目)× 読取 / 書込」である。****旧値の逐語は 14。**
  expect(Object.keys(schema.$defs.field.properties)).toHaveLength(12);
  // **【`V6-M3-T01` / `K-G6` / `ADR-0290` 限定1 で 4 → 5 に更新した】** 5キー目
  // `reference_search_fields`(このテーブルが参照されたときの「探せる項目」の既定)が門A を
  // 通って増えた(`V6-M0` 単位B。判定 = 限定採用)。**本 ADR の増分ではない。**
  // **【`V7-M1-T01` / `Z-G2` で 5 → 6 に更新した】** 6キー目 `access_control`(この表で
  // アクセス権管理を使うことと、付与・グループ・メンバーの置き場所の宣言)が門A を通って
  // 増えた(`V7-M0`。判定 = 限定採用)。**本 ADR の増分ではない。**
  expect(Object.keys(schema.$defs.table.properties)).toHaveLength(6);
  expect(Object.keys(schema.$defs.theme.properties)).toHaveLength(25);
  expect(schema.$defs.theme.required).toHaveLength(25);
  // 【`V5-M29-T03` / `ADR-0250` 限定11】ここにあった `RESOURCE_KINDS` の本数の検査は
  //   `scripts/vocabulary-drift.test.ts` へ移した(一覧の `RESOURCE_KINDS:` で始まる行)。
  //   **総量ではなく名前と順序で見張る。**
  //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  // 【`V5-M29-T03` / `ADR-0250` 限定11】同じく `FIELD_TYPES` の本数の検査も移した(一覧の `FIELD_TYPES:` で始まる行)。
  //   消した行に付いていた逐語: 「【`V5-M16` / `ADR-0161`】8 → 9(`file` が9種目)。**この行が固定していたのは
  //   「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**」
  //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  // 【`V5-M29-T03` / `ADR-0250` 限定11】同じく `DIFF_OPS` の本数の検査も移した(一覧の `DIFF_OPS:` で始まる行)。
  //   消した行に付いていた逐語: 「【`V5-M17b` / `ADR-0248`】16 → 17(`set_user_kinds` が17種目)。**この行が固定していたのは
  //   「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**」
  //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
});

test("(a) 限定1: キー名が逃げ道の検査(/css|style|escape|hatch/)に当たらない", () => {
  // `web/test/preset-boundary.test.ts` の (iii) が「逃げ道に当たるキーは custom_css ただ1つ」を
  // 固定している。**8つ目のプリセットキーがその集合に混ざってはならない。**
  expect(/css|style|escape|hatch/.test("preset_list_shape")).toBe(false);
});

// ---------------------------------------------------------------------------
// (b) 限定2: list_view 分岐でだけ許す
// ---------------------------------------------------------------------------

test("(b) 限定2: detail_view 分岐と form 分岐で preset_list_shape が false である", () => {
  expect(branch("detail_view").then.properties.preset_list_shape).toBe(false);
  expect(branch("form").then.properties.preset_list_shape).toBe(false);
  // `list_view` 分岐には出てこない(= 書ける)。
  expect(
    Object.keys((branch("list_view").then?.properties ?? {}) as Record<string, unknown>),
  ).not.toContain("preset_list_shape");
});

test("(b) 限定2: 3つの分岐の false の本数が 10 / 17 / 13 である(既存の false を1本も動かしていない)", () => {
  // **着手前は list_view 6 / form 11 / detail_view 6 であった**(2026-08-04 実測)。
  // **増えたのは form と detail_view の各1本(`preset_list_shape`)だけである。**
  //
  // **【V4-M18-T03 / ADR-0095 限定6 で 6 / 12 / 7 → 7 / 12 / 8 に更新した】**
  // **増えたのは `modal` の2本(list_view / detail_view)だけである。** `form` は
  // **1バイトも変えていない**(`modal` は form でだけ書けるので、そこには `false` を置かない)。
  //
  // **【V4-M22-T01 / ADR-0112 限定3 で 7 / 12 / 8 → 7 / 13 / 9 に更新した】**
  // **増えたのは `search_fields` の2本(form / detail_view)だけである。** `list_view` は
  // **1バイトも変えていない**(`search_fields` は list_view でだけ書けるので、そこには
  // `false` を置かない)。
  //
  // **【V4-M22-T05 / ADR-0113 限定7 で 7 / 13 / 9 → 7 / 14 / 10 に更新した】**
  // **増えたのは `page_size` の2本(form / detail_view)だけである。** `list_view` は
  // **1バイトも変えていない**(`page_size` は list_view でだけ書けるので、そこには
  // `false` を置かない)。
  //
  // **【V4-M20-T04 / ADR-0102 限定3 で 7 / 14 / 10 → 8 / 14 / 11 に更新した】**
  // **増えたのは `after_save` の2本(list_view / detail_view)だけである。** `form` は
  // **1バイトも変えていない**(`after_save` は form でだけ書けるので、そこには `false` を
  // 置かない)。
  // **【2026-08-20。`V10-M1-T01` / `NV-G3a` / `ADR-0358` 限定1】直前の逐語
  // 「after_save は form でだけ書ける」は今日は偽である** —— **門A の本審査(`V10-M0` 群A。判定 = 限定採用)が
  // `detail_view` 分岐の `"after_save": false,` を外した。****今日は `form` と
  // `detail_view` の2種別で書ける**(`list_view` / `report_view` には今日も書けない)。
  // **旧文を1バイトも消していない。**
  //
  // **【V4-M23-T01 / ADR-0104 限定3 で 8 / 14 / 11 → 8 / 15 / 12 に更新した】**
  // **増えたのは28キー目 `sum_field`(合計を出す列)の2本(form / detail_view)だけである。**
  // `list_view` は **1バイトも変えていない**(`sum_field` は `list_view` でだけ書けるので、
  // そこには `false` を置かない)。
  //
  // **【V5-M21-T01 / \`L-G1\` / ADR-0171 で 8 / 15 / 12 → 7 / 15 / 12 に更新した】**
  // **減ったのは \`list_view\` の \`actions\` 1本だけである** —— **\`ADR-0171\`(門A /
  // 判定 = 限定採用)が \`list_view\` 分岐の \`"actions": false,\` を解いた。**
  // **これは本ファイルで初めて「false が減る」更新である**(ここまでの6回はすべて増加であった)。
  // **\`form\` は1バイトも変えていない**(限定3)。**\`related\` の \`false\` も両分岐で
  // 1バイトも解いていない**(限定4)。**旧文を1バイトも消していない。**
  //
  // **【`V6-M2-T01` / `K-G2` / `ADR-0289` 限定4 で 7 / 15 / 12 → 8 / 15 / 13 に更新した】**
  // **増えたのは29キー目 `reference_pickers` の2本(list_view / detail_view)だけである。**
  // `form` 分岐は **1バイトも変えていない**(`form` でだけ書けるキーである)。
  //
  // **【2026-08-14。`V8-M8`。台帳 `Q-G1`】8 / 15 / 13 → 9 / 16 / 14 に更新した。**
  // **増えたのは29キー目 `report`(集計表の中身)の3本(list_view / form / detail_view)
  // だけである。****既存の `false` を1バイトも動かしていない。**
  // **テスト名が言う「3つの分岐」に、5分岐目(集計表)は入らない。**
  // **【2026-08-20。`V10-M1-T01` / `NV-G3a` / `ADR-0358` 限定1 で 9 / 16 / 14 → 9 / 16 / 13 に
  // 更新した】** **減ったのは `detail_view` の `after_save` 1本だけである** —— 門A の
  // 本審査(`V10-M0` 群A。判定 = 限定採用)が `detail_view` 分岐の
  // `"after_save": false,` を外し、**詳細画面の書換ボタン(`actions` の `set` 形)が
  // 成立したあとの行き先を書けるようにした。**
  // **`list_view` と `form` は1バイトも変えていない** —— **`list_view` の
  // `after_save` の `false` は今日も残っている**(`NV-G3b` = **却下**)。
  // **旧テスト名の逐語は「3つの分岐の false の本数が 7 / 14 / 10 である」であり、
  // 着手前の実測(9 / 16 / 14)と既に食い違っていた** —— **本タスクはその食い違いも
  // 同時に直した**(名前だけが嘘になる事故を残さない)。
  // **【2026-08-20。`V10-M1-T02` / `NV-G4` / `ADR-0359` §4a 限定2 で 9 / 16 / 13 →
  // 10 / 17 / 13 に更新した】** **増えたのは30キー目 `after_delete`(削除が成立した
  // あとの行き先)の2本(`list_view` / `form`)だけである。** `detail_view` 分岐は
  // **1バイトも変えていない**(`after_delete` は `detail_view` でだけ書けるので、
  // そこには `false` を置かない)。**既存の `false` を1つも動かしていない。**
  // **`report_view` 分岐(5分岐目)にも `"after_delete": false,` を置いたが、
  // この test の対象ではない**(名乗っているのは「3つの分岐」である)。
  expect(falseKeys("list_view")).toEqual([
    // **【`V10-M1-T02` / `NV-G4` / `ADR-0359` 限定2】30キー目 `after_delete` は
    // list_view では `false`(`detail_view` でだけ書ける)。**
    "after_delete",
    "after_save",
    "field_groups",
    "fields",
    "modal",
    "preset_field_columns",
    "preset_label_placement",
    // **【`V6-M2-T01` / `ADR-0289` 限定4 で足した】**
    "reference_pickers",
    "related",
    // **【`V8-M8` / `Q-G1`】29キー目 `report` は list_view では `false`。**
    "report",
  ]);
  expect(falseKeys("form")).toEqual([
    "actions",
    // **【`V10-M1-T02` / `NV-G4` / `ADR-0359` 限定2】30キー目 `after_delete` は
    // form でも `false`(`detail_view` でだけ書ける)。**
    "after_delete",
    "columns",
    "field_groups",
    "filter",
    "page_size",
    "preset_column_align",
    "preset_column_width",
    "preset_image_size",
    "preset_list_shape",
    "preset_pager_position",
    "preset_text_preview",
    "related",
    // **【`V8-M8` / `Q-G1`】29キー目 `report` は form では `false`。**
    "report",
    "search_fields",
    "sort",
    // **【V4-M23-T01 / ADR-0104 限定3 で足した】** 28キー目 `sum_field`(合計を出す列)も
    // form では `false`(`list_view` でだけ書ける)。
    "sum_field",
  ]);
  expect(falseKeys("detail_view")).toEqual([
    // **【2026-08-20。`V10-M1-T01` / `ADR-0358` 限定1 でこの行を外した】**
    // **旧行の逐語**: `"after_save",`(直前の `V4-M20-T04` / `ADR-0102` 限定3 の注記ごと)。
    // **`detail_view` では今日 `after_save` を書ける** —— **発火するのは `actions` の
    // `set` 形の書込が成立したときだけで、`run` 形の後は移らない**(限定2)。
    "columns",
    "filter",
    "modal",
    "page_size",
    "preset_column_align",
    "preset_column_width",
    "preset_list_shape",
    "preset_pager_position",
    // **【`V6-M2-T01` / `ADR-0289` 限定4 で足した】**
    "reference_pickers",
    // **【`V8-M8` / `Q-G1`】29キー目 `report` は detail_view では `false`。**
    "report",
    "search_fields",
    "sort",
    // **【V4-M23-T01 / ADR-0104 限定3 で足した】** 28キー目 `sum_field`(合計を出す列)も
    // detail_view では `false`(`list_view` でだけ書ける)。
    "sum_field",
  ]);
});

test("(b) 限定2: detail_view / form に preset_list_shape を書いた差分は拒否される", () => {
  for (const viewId of ["entry-form", "entry-detail"]) {
    const folded = foldOperations(baseManifest(), [
      { op: "update_view", view: viewId, changes: { preset_list_shape: "card" } },
    ] as unknown as Operation[]);
    expect(folded.valid, viewId).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// (c) 限定3: 値域は2値ちょうど。3値目を受けない
// ---------------------------------------------------------------------------

test("(c) 限定3: 値域は table / card の2値ちょうどで、pattern も minLength も無い", () => {
  const schema = manifestSchema().$defs.view.properties.preset_list_shape;
  expect(schema.type).toBe("string");
  expect(schema.enum).toEqual(["table", "card"]);
  // 自由文字列を受ける形(実質なんでも通る `pattern` / `minLength`)を作らない。
  expect(schema.pattern).toBeUndefined();
  expect(schema.minLength).toBeUndefined();
});

test("(c) 限定3: 3値目(grid / kanban / calendar / timeline)を書いた差分は拒否される", () => {
  for (const shape of ["grid", "kanban", "calendar", "timeline"]) {
    // 差分そのものの構造検証(`update_view` の経路)。
    expect(
      validateDiff({
        operations: [
          { op: "update_view", view: "entry-list", changes: { preset_list_shape: shape } },
        ],
      }).valid,
      shape,
    ).toBe(false);
    // 適用後マニフェストの構造検証(`add_view` で書かれた場合も同じ1箇所で閉じる)。
    expect(validateListViewWith({ preset_list_shape: shape }), shape).toBe(false);
  }
});

test("(c) 限定3: 自由文字列も自由な数値も真偽値も配列も受けない", () => {
  for (const value of [
    "",
    "TABLE",
    "card ",
    "display:grid",
    1,
    0,
    true,
    ["card"],
    { shape: "card" },
  ]) {
    expect(validateListViewWith({ preset_list_shape: value }), JSON.stringify(value)).toBe(false);
  }
});

test("(c) 限定3: 2値はどちらも受理される", () => {
  expect(validateListViewWith({ preset_list_shape: "table" })).toBe(true);
  expect(validateListViewWith({ preset_list_shape: "card" })).toBe(true);
});

// ---------------------------------------------------------------------------
// (h) 限定8: card と列の軸の組み合わせを**機械では止めていない**
// ---------------------------------------------------------------------------

test("(h) 限定8: card + preset_column_align / preset_column_width を書いた差分は受理される(止めていない)", () => {
  // **これは「直すべき赤」ではない。** `ADR-0093` 限定8 の第4列が
  // 「**機械的固定は置かない**」と明記している —— 止めるには型とプリセットの対応検査が要り、
  // それは今日この製品に1つも無い(MCP の説明文が既にその穴を認めている)。
  // **本検査はその状態を見える形に固定する**(黙って変わらないようにする)。
  const folded = foldOperations(baseManifest(), [
    {
      op: "update_view",
      view: "entry-list",
      changes: {
        preset_list_shape: "card",
        preset_column_align: { amount: "right" },
        preset_column_width: { title: "wide" },
      },
    },
  ] as unknown as Operation[]);
  expect(folded.valid).toBe(true);
  if (!folded.valid) {
    return;
  }
  const view = folded.manifest.app.views[0] as ListView;
  expect(view.preset_list_shape).toBe("card");
  expect(view.preset_column_align).toEqual({ amount: "right" });
  expect(view.preset_column_width).toEqual({ title: "wide" });
});

test("(h) 限定8: 効かないことを src/mcp/vocabulary.ts が明記している(黙って作っていない)", () => {
  expect(VOCABULARY_SCOPE).toContain("preset_list_shape");
  expect(VOCABULARY_SCOPE).toContain("カード表示のときは列の寄せと列の幅が効きません");
  // **「止めている」と書いていないこと**(逆向きの嘘を作らない)。
  expect(VOCABULARY_SCOPE).toContain("拒否されず");
});

// ---------------------------------------------------------------------------
// (j) 限定10 / 完了条件 (7): view_changes 16 と「値が実際に運ばれる」こと
// ---------------------------------------------------------------------------

test("(j) view_changes.properties は 16 で、16キー目は preset_list_shape である", () => {
  const properties = Object.keys(diffSchema().$defs.view_changes.properties);
  // **【V4-M18-T03 / ADR-0095 限定6 で 16 → 17 に更新した】** `update_view` にも17キー目
  // `modal` が加わった(値は `applyViewChanges` の `form` 分岐が実際に運ぶ)。
  // **`preset_list_shape` が16キー目であることは今日も真である。**
  // **【V4-M22-T01 / ADR-0112 限定2 で 17 → 18 に更新した】** `update_view` にも18キー目
  // `search_fields` が加わった(値は `applyViewChanges` の `list_view` 分岐が実際に運ぶ)。
  // **`preset_list_shape` が16キー目であることは今日も真である。**
  // **【V4-M22-T05 / ADR-0113 限定2 で 18 → 19 に更新した】** `update_view` にも19キー目
  // `page_size` が加わった(値は `applyViewChanges` の `list_view` 分岐が実際に運ぶ)。
  // **`preset_list_shape` が16キー目であることは今日も真である。**
  // **【V4-M19-T03 / ADR-0118 限定1 で 19 → 20 に更新した】** 20キー目 `preset_density`
  // (画面の詰まり具合)が門A を通って増えた(V4-M19 単位C。2回目の審査。判定 = 限定採用)。
  // **3種すべてに書けるキーである。****本 ADR の増分ではない —— `preset_list_shape` が
  // 16キー目であることは今日も真である。**
  // **【V4-M20-T04 / ADR-0102 限定2 で 20 → 21 に更新した】** 21キー目 `after_save` が
  // `update_view` にも加わった(値は `applyViewChanges` の `form` 分岐が実際に運ぶ)。
  // **本 ADR の増分ではない —— `preset_list_shape` が16キー目であることは今日も真である。**
  // **【V4-M23-T01 / ADR-0104 限定2 で 21 → 22 に更新した】** 22キー目 `sum_field`
  // (合計を出す列。`list_view` でだけ書ける)が `update_view` にも加わった(値は
  // `applyViewChanges` の `list_view` 分岐が実際に運ぶ)。**本 ADR の増分ではない ——
  // `preset_list_shape` が16キー目であることは今日も真である。**
  // **【`V6-M2-T02` / `K-G3` / `ADR-0289` 限定1 で 23 → 24 に更新した】** 24キー目 `reference_pickers`
  // (参照項目の選び方の、入力画面ごとの上書き。`form` でだけ書ける)が `update_view` にも加わった
  // (値は `applyViewChanges` の `form` 分岐が実際に運ぶ)。**本 ADR の増分ではない。**
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
  // **【V5-M21-T03 / `L-G4` / ADR-0172 限定1 で 22 → 23 に更新した】** 23キー目 `actions`
  // (操作起点)が末尾に入った(門A の本審査 = `V5-M20` 面1 の `L-G4`。判定 = 限定採用)。
  // **本 ADR の増分ではない。****`related` / `audience` は今日も `view_changes` に無い。**
  // **【`V6-M2-T02` / `K-G3` / `ADR-0289` 限定1 で書き換えた】** 24キー目 `reference_pickers`
  // (`form` でだけ書ける)が末尾に入ったので、**`actions`(23キー目)が今日も1つ手前で
  // あることは変わらない。**
  // **【2026-08-14。`V8-M8`。台帳 `Q-G1`】末尾に25キー目 `report`(集計表の中身)が入ったので、
  // 位置の添字を1つずつ後ろへずらした。****旧行の逐語は `at(-9)`〜`at(-1)` が
  // `preset_list_shape` / `modal` / `search_fields` / `page_size` / `preset_density` /
  // `after_save` / `sum_field` / `actions` / `reference_pickers` の9行である。**
  // **【2026-08-20。`V10-M1-T02`。台帳 `NV-G4`。ADR = `0359`】末尾に `after_delete`
  // (削除が成立したあとの行き先)が入ったので、位置の添字を1つずつ後ろへずらした。**
  // **添字を後ろへずらしただけで、期待値を1つも緩めていない。**
  // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
  // **末尾に `flow`(一続きの流れの中の段)が31キー目として入ったので、
  // 位置の添字を1つ後ろへずらした。****旧行の逐語**: `expect(properties.at(-11)).toBe("preset_list_shape");`
  // **添字を後ろへずらしただけで、期待値を1つも緩めていない。**
  expect(properties.at(-12)).toBe("preset_list_shape");
  expect(properties.at(-11)).toBe("modal");
  expect(properties.at(-10)).toBe("search_fields");
  expect(properties.at(-9)).toBe("page_size");
  expect(properties.at(-8)).toBe("preset_density");
  expect(properties.at(-7)).toBe("after_save");
  expect(properties.at(-6)).toBe("sum_field");
  expect(properties.at(-5)).toBe("actions");
  expect(properties.at(-4)).toBe("reference_pickers");
  expect(properties.at(-3)).toBe("report");
  expect(properties.at(-2)).toBe("after_delete");
  // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。ADR = `0359` / `0360`】末尾は今日 `flow` である。**
  // **`after_delete` はもう末尾ではない** —— **上の行の添字を1つ後ろへずらし、
  // 末尾の位置をここで新しく固定した。****位置の主張を1つも緩めていない。**
  expect(properties.at(-1)).toBe("flow");
  expect(diffSchema().$defs.view_changes.additionalProperties).toBe(false);
  // **定義はマニフェスト側を `$ref` する**(値域の定義を二重に持たない)。
  expect(diffSchema().$defs.view_changes.properties.preset_list_shape.$ref).toBe(
    "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/view/properties/preset_list_shape",
  );
});

test("(j) 既存の $comment を1バイトも書き換えていない(menu_listed = 14キー目 / field_groups = 15キー目)", () => {
  const changes = diffSchema().$defs.view_changes.properties;
  expect(changes.menu_listed.$comment).toContain("**14キー目である。**");
  expect(changes.field_groups.$comment).toContain("**15キー目である。**");
  // マニフェスト側の `preset_column_align` の `$comment`(8つ目を禁じていた文)も無傷である。
  expect(manifestSchema().$defs.view.properties.preset_column_align.$comment).toContain(
    "**8つ目のプリセットキーを足してはならず、各 enum に値を足してもならない**",
  );
  // **9つ目を禁じる新しい `$comment` は本キーの側に置く。**
  expect(manifestSchema().$defs.view.properties.preset_list_shape.$comment).toContain(
    "9つ目のプリセットキーを足してはならない",
  );
});

test("(j) update_view で書いた preset_list_shape が適用後マニフェストに実際に残る", () => {
  const folded = foldOperations(baseManifest(), [
    { op: "update_view", view: "entry-list", changes: { preset_list_shape: "card" } },
  ] as unknown as Operation[]);
  expect(folded.valid).toBe(true);
  if (!folded.valid) {
    return;
  }
  const view = folded.manifest.app.views[0] as ListView;
  expect(view.preset_list_shape).toBe("card");
  // 適用後マニフェストとしても妥当である(= ディスクに書かれる形である)。
  expect(validateManifestFull(folded.manifest).valid).toBe(true);
});

test("(j) update_view はキー単位の差し替えである(書かなかったキーに触らない)", () => {
  const first = foldOperations(baseManifest(), [
    { op: "update_view", view: "entry-list", changes: { preset_list_shape: "card" } },
  ] as unknown as Operation[]);
  expect(first.valid).toBe(true);
  if (!first.valid) {
    return;
  }
  const second = foldOperations(first.manifest, [
    { op: "update_view", view: "entry-list", changes: { preset_pager_position: "top" } },
  ] as unknown as Operation[]);
  expect(second.valid).toBe(true);
  if (!second.valid) {
    return;
  }
  const view = second.manifest.app.views[0] as ListView;
  // **書かなかったキーは黙って消えない**(前進で外す手段が無いことの裏返し = 限定10 前段)。
  expect(view.preset_list_shape).toBe("card");
  expect(view.preset_pager_position).toBe("top");
});

test("(j) 書かなかった list_view には preset_list_shape のキーが生えない(既定は table)", () => {
  const folded = foldOperations(baseManifest(), [
    { op: "update_view", view: "entry-list", changes: { preset_pager_position: "top" } },
  ] as unknown as Operation[]);
  expect(folded.valid).toBe(true);
  if (!folded.valid) {
    return;
  }
  expect("preset_list_shape" in (folded.manifest.app.views[0] as ListView)).toBe(false);
});
