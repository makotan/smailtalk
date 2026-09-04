/**
 * 画面ごとの詰まり具合をアプリが宣言する(`P-G32` の (C) 側。`V4-M19-T03` / `ADR-0118`)。
 *
 * **限定表の正は [`docs/adr/0118-view-density-preset.md`](../../docs/adr/0118-view-density-preset.md)
 * §Decision 3(限定1〜限定13)**、完了条件の正は
 * `docs/plan/v4/records/v4-m19.md` §2-1 の `V4-M19-T03` の行(4点)。
 *
 * ## このファイルが固定すること(カーネル側)
 *
 * 1. **限定1**: 足すキーは `$defs/view` に1本(`preset_density`)だけ。**`$defs`(28)/
 *    `$defs/theme`(25 / 25)/ `$defs/field` は1つも動かない。**
 * 2. **限定2**: `preset_` で始まるキーは **9本ちょうど**で閉じる。
 * 3. **限定3**: 値域は2値の `enum`(`comfortable` / `compact`)だけ。**3値目も、自由な文字列も、
 *    自由な数値も、`px` も割合も CSS 文字列も1バイトも書けない。****拒否リストを作らない。**
 * 4. **限定4**: `RESOURCE_KINDS`(7)/ `FIELD_TYPES`(8)/ `DIFF_OPS`(16)/
 *    `$defs/operation.properties`(8)が1つも動かない。**密度専用の op を作らない。**
 * 5. **`ADR-0086` 限定4 の裏**: `update_view` で後から書けて、**値が適用後マニフェストに
 *    実際に残る**(`ADR-0076` の `writable_by` が作った「書けるが効かない」穴を繰り返さない)。
 *
 * ## 【本数の食い違いを隠さない】
 *
 * **`ADR-0118` 限定1 は「`$defs/view.properties` を 22 → 23 にする」「`view_changes` を
 * 16 → 17 にする」と書いているが、それは審査時点(`$defs/view` が 22)の実測である。**
 * **`V4-M18` の `modal` と `V4-M22` の `search_fields` / `page_size` が先に入ったので、
 * 本キーの実際の増分は 25 → 26 / 19 → 20 である。**
 * **守ったのは「1本だけ足す」という増分であって、限定表が書いた絶対値ではない。**
 * **`ADR-0118` の本文を1バイトも書き換えていない**(`ADR-0112` / `ADR-0113` の実装が
 * 採ったのと同じ作法)。
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * - **描画の実測は `web/test/view-density.test.tsx` と chromium の担当である。**
 * - **「画面の見せ方が指定できるようになった」とは書かない**(`ADR-0118` §Decision 5 の 1)。
 * - **2つの系統が全部の軸で違うことを、本ファイルは1件も測っていない**(角丸の軸は差0)。
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { foldOperations } from "./apply-diff.ts";
import type { Manifest, Operation, View } from "./types.ts";
import { DIFF_OPS } from "./types.ts";
import { validateDiff, validateManifest } from "./validate.ts";

const ROOT = dirname(dirname(import.meta.dir));

// biome-ignore lint/suspicious/noExplicitAny: スキーマ JSON を素で読むための局所エイリアス。
type Any = any;

function readSchema(name: string): Any {
  return JSON.parse(readFileSync(join(ROOT, "schemas", name), "utf8")) as Any;
}

/** 密度の値(限定3。**この2値がすべてである**)。 */
const DENSITY_VALUES = ["comfortable", "compact"] as const;

// --- (a) 増分の総量(限定1 / 限定2)-----------------------------------------------------

test("限定1: $defs/view.properties は 26 で、26キー目は preset_density である", () => {
  // **【V4-M20-T04 / ADR-0102 限定1 で 26 → 27 に更新した】** 27キー目 `after_save`
  // (保存が成立したあとに行く画面のID)が門A を通って増えた(V4-M20 単位D。2回目の審査。
  // 判定 = 限定採用)。**`preset_density` が26キー目(末尾から2番目)であることは今日も
  // 真である** —— `.at(-1)` を `.at(-2)` に直したのは末尾に1本増えたためで、位置の主張
  // 自体は1ミリも緩めていない。**本 ADR の増分ではない。**
  // **【V4-M23-T01 / ADR-0104 限定採用で 27 → 28 に更新した】** 28キー目 `sum_field`
  // (合計を出す列。`list_view` でだけ書ける)が門A を通って増えた。**`preset_density` が
  // 26キー目(末尾から3番目)であることは今日も真である** —— `.at(-2)` を `.at(-3)` に
  // 直したのは末尾にもう1本増えたためで、位置の主張自体は1ミリも緩めていない。
  // **本 ADR の増分ではない。**
  const properties = Object.keys(readSchema("manifest.schema.json").$defs.view.properties);
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
  // 位置の添字を1つずつ後ろへずらした。****旧行の逐語は `at(-4)`〜`at(-1)` が
  // `preset_density` / `after_save` / `sum_field` / `reference_pickers` の4行である。**
  // **【2026-08-20。`V10-M1-T02`。台帳 `NV-G4`。ADR = `0359`】末尾に `after_delete`
  // (削除が成立したあとの行き先)が入ったので、位置の添字を1つずつ後ろへずらした。**
  // **添字を後ろへずらしただけで、期待値を1つも緩めていない。**
  // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
  // **末尾に `flow`(一続きの流れの中の段)が31キー目として入ったので、
  // 位置の添字を1つ後ろへずらした。****旧行の逐語**: `expect(properties.at(-6)).toBe("preset_density");`
  // **添字を後ろへずらしただけで、期待値を1つも緩めていない。**
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
});

// **【`V5-M29-T04` / `ADR-0250` 限定14 がテスト名を更新した】** 旧名(逐語)は
// 「**限定1: $defs 28 / $defs/theme 25・25 が1つも動いていない**」。
// **`$defs` の総量を固定していた `expect` を中央へ移したので、この test に残るのは
// `$defs/theme` の 25・25 だけである**(`$defs/theme` は8主題の外にあり、中央へは移していない)。
test("限定1: $defs/theme 25・25 が1つも動いていない", () => {
  const manifest = readSchema("manifest.schema.json");
  // **新しい `$defs` を作らない**(値域は `$defs/view/properties/preset_density` の中に閉じる)。
  // 【`V5-M29-T04` / `ADR-0250` 限定11】ここにあった「限定1: $defs 28 / $defs/theme 25・25 が1つも動いていない」の検査は
  //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
  //   `manifest.$defs:` で始まる行)。**総量ではなく名前と順序で見張る。**
  //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  // **`--space-1`〜`--space-6` の名前も値も1バイトも変えない**(限定5)。
  expect(Object.keys(manifest.$defs.theme.properties)).toHaveLength(25);
  expect(manifest.$defs.theme.required).toHaveLength(25);
});

test("限定1: $defs/field には preset_density を1バイトも足していない", () => {
  // **項目ごと・列ごとに密度を変えることはできない**(`ADR-0118` §Decision 4 の 4)。
  const field = readSchema("manifest.schema.json").$defs.field.properties;
  expect(field.preset_density).toBeUndefined();
  expect(
    readSchema("diff.schema.json").$defs.field_changes.properties.preset_density,
  ).toBeUndefined();
});

test("限定1: view_changes.properties は 20 で、preset_density を含む", () => {
  // **【V4-M20-T04 / ADR-0102 限定2 で 20 → 21 に更新した】** 21キー目 `after_save` が
  // `update_view` にも加わった(値は `applyViewChanges` の `form` 分岐が実際に運ぶ)。
  // **本 ADR の増分ではない。**
  // **【V4-M23-T01 / ADR-0104 限定採用で 21 → 22 に更新した】** 22キー目 `sum_field`
  // (合計を出す列。`list_view` でだけ書ける)が `update_view` にも加わった(値は
  // `applyViewChanges` の `list_view` 分岐が実際に運ぶ)。**本 ADR の増分ではない。**
  const properties = Object.keys(readSchema("diff.schema.json").$defs.view_changes.properties);
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
  expect(properties).toContain("preset_density");
});

test("限定2: preset_ で始まるキーは 9本ちょうどである", () => {
  const properties = Object.keys(readSchema("manifest.schema.json").$defs.view.properties);
  const presetKeys = properties.filter((key) => key.startsWith("preset_"));
  expect(presetKeys).toHaveLength(9);
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
});

// **【`V5-M29-T04` / `ADR-0250` 限定14 がテスト名を更新した】** 旧名(逐語)は
// 「**限定4: RESOURCE_KINDS 7 / FIELD_TYPES 8 / DIFF_OPS 16 / operation.properties 8 が動いていない**」。
// **`RESOURCE_KINDS` / `FIELD_TYPES` / `DIFF_OPS` の総量を固定していた3件を中央へ移したので、
// この test に残るのは `operation.properties` 9(8主題の外)と「密度専用の op が無い」の2件である。**
test("限定4: operation.properties 9 が動いておらず、密度専用の op も無い", () => {
  // 【`V5-M29-T04` / `ADR-0250` 限定11】ここにあった「限定4: RESOURCE_KINDS 7 / FIELD_TYPES 8 / DIFF_OPS 16 / operation.properties 8 が動いていない」の検査は
  //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
  //   `RESOURCE_KINDS:` で始まる行)。**総量ではなく名前と順序で見張る。**
  //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  // 【`V5-M29-T04` / `ADR-0250` 限定11】ここにあった「限定4: RESOURCE_KINDS 7 / FIELD_TYPES 8 / DIFF_OPS 16 / operation.properties 8 が動いていない」の検査は
  //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
  //   `FIELD_TYPES:` で始まる行)。**総量ではなく名前と順序で見張る。**
  //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  // 【`V5-M29-T04` / `ADR-0250` 限定11】ここにあった「限定4: RESOURCE_KINDS 7 / FIELD_TYPES 8 / DIFF_OPS 16 / operation.properties 8 が動いていない」の検査は
  //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
  //   `DIFF_OPS:` で始まる行)。**総量ではなく名前と順序で見張る。**
  //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  // **【`V8-M16` / `J-G1b` / `D-V8-31`】期待値を 9 → 10 に書き換えた —— 10キー目 `roles` を足したため。検査は消していない。**
  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】**
  // **旧(逐語)**: `expect(Object.keys(readSchema("diff.schema.json").$defs.operation.properties)).toHaveLength(10);`
  // **`user_kinds` キーを撤去したので 10 → 9。**この検査が測る「密度専用の op を作らないこと」は1ミリも弱めていない(下の1行が今日も測る)。
  expect(Object.keys(readSchema("diff.schema.json").$defs.operation.properties)).toHaveLength(9); // 【`V5-M17b` / `ADR-0248` 限定4】8 → 9(`user_kinds` が9キー目)/【`V8-M16`】9 → 10(`roles` が10キー目)。**この行が固定していたのは「その決定がキーを足さなかったこと」であり、足したのは別の決定である。**
  // **密度専用の op を作らない** —— 書き込みは既存の `add_view` / `update_view` だけである。
  expect(DIFF_OPS.some((op) => op.includes("density"))).toBe(false);
});

// --- (b) 限定3: 値域は2値の enum ちょうど -------------------------------------------------

test("限定3: 値域は enum 2値ちょうどで、pattern も minLength も default も書いていない", () => {
  const key = readSchema("manifest.schema.json").$defs.view.properties.preset_density as Any;
  const { $comment: _c, description: _d, ...shape } = key;
  expect(shape).toEqual({ type: "string", enum: [...DENSITY_VALUES] });
  // **3値目を足すとここが落ちる。**
  expect(shape.enum).toHaveLength(2);
});

function manifestWithView(view: Record<string, unknown>): unknown {
  return {
    app: {
      id: "density-shop",
      name: "密度の店",
      tables: [
        {
          id: "order",
          name: "注文",
          fields: [{ id: "memo", name: "メモ", type: "text" }],
        },
      ],
      views: [view],
    },
  };
}

test("限定3: 3値目(cozy)を書いたマニフェストは拒否される", () => {
  const result = validateManifest(
    manifestWithView({
      id: "order-list",
      type: "list_view",
      table: "order",
      columns: ["memo"],
      preset_density: "cozy",
    }),
  );
  expect(result.valid).toBe(false);
});

test("限定3: 自由な文字列(CSS 値)も自由な数値も1つも受けない", () => {
  for (const value of ["8px", "0.5rem", "50%", 8, true]) {
    const result = validateManifest(
      manifestWithView({
        id: "order-list",
        type: "list_view",
        table: "order",
        columns: ["memo"],
        preset_density: value,
      }),
    );
    expect(result.valid).toBe(false);
  }
});

// --- (c) 3種すべての画面に書ける(器はどの種別にも在る)-----------------------------------

test("3種(list_view / form / detail_view)すべてに書ける", () => {
  const views: Record<string, unknown>[] = [
    { id: "order-list", type: "list_view", table: "order", columns: ["memo"] },
    { id: "order-form", type: "form", table: "order", fields: ["memo"] },
    { id: "order-detail", type: "detail_view", table: "order" },
  ];
  for (const view of views) {
    for (const density of DENSITY_VALUES) {
      const result = validateManifest(manifestWithView({ ...view, preset_density: density }));
      expect(result.valid).toBe(true);
    }
  }
});

/*
 * **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`。テスト名は1バイトも
 * 書き換えていない】**
 *
 * **`allOf` の分岐は4本から5本になり、5本目(集計表 = `report_view`)は
 * `preset_density` を `false` で閉じている。** **テスト名が言う「3分岐」は
 * `list_view` / `form` / `detail_view` の3つであり、その3つについての主張
 * (`ADR-0118` 限定1「3種すべてに書ける」)は今日も1ミリも弱めていない。**
 * **集計表に詰まり具合を書けないのは、そもそも並べる行が1行も無いからである。**
 *
 * **旧行の逐語**: `  for (const branch of branches) {` /
 * `    expect(branch.then?.properties?.preset_density).toBeUndefined();` / `  }`
 */
test("allOf の3分岐のどれも preset_density を false にしていない", () => {
  const branches = readSchema("manifest.schema.json").$defs.view.allOf as Any[];
  for (const branch of branches) {
    // **集計表の分岐だけは対象外である**(すぐ上の理由)。
    if (branch.if?.properties?.type?.const === "report_view") {
      expect(branch.then?.properties?.preset_density).toBe(false);
      continue;
    }
    expect(branch.then?.properties?.preset_density).toBeUndefined();
  }
});

// --- (d) ADR-0086 限定4 の裏: update_view で書けて、値が実際に残る -------------------------

function baseManifest(): Manifest {
  return {
    app: {
      id: "density-shop",
      name: "密度の店",
      tables: [
        {
          id: "order",
          name: "注文",
          fields: [{ id: "memo", name: "メモ", type: "text" }],
        },
      ],
      views: [
        { id: "order-list", type: "list_view", table: "order", columns: ["memo"] },
        { id: "order-form", type: "form", table: "order", fields: ["memo"] },
        { id: "order-detail", type: "detail_view", table: "order" },
      ],
    },
  };
}

function viewOf(manifest: Manifest, id: string): View & { preset_density?: string } {
  const view = manifest.app.views.find((candidate) => candidate.id === id);
  if (view === undefined) {
    throw new Error(`ビュー ${id} が無い`);
  }
  return view;
}

test("update_view で書いた preset_density が、3種すべてで適用後マニフェストに残る", () => {
  for (const viewId of ["order-list", "order-form", "order-detail"]) {
    const result = foldOperations(baseManifest(), [
      { op: "update_view", view: viewId, changes: { preset_density: "compact" } } as Operation,
    ]);
    expect(result.valid).toBe(true);
    if (!result.valid) {
      throw new Error("畳み込みに失敗した");
    }
    expect(viewOf(result.manifest, viewId).preset_density).toBe("compact");
  }
});

test("update_view で他のキーを書いても preset_density が消えない(軸ごとに独立)", () => {
  const first = foldOperations(baseManifest(), [
    { op: "update_view", view: "order-list", changes: { preset_density: "compact" } } as Operation,
  ]);
  if (!first.valid) {
    throw new Error("1回目の畳み込みに失敗した");
  }
  const second = foldOperations(first.manifest, [
    { op: "update_view", view: "order-list", changes: { name: "注文一覧" } } as Operation,
  ]);
  expect(second.valid).toBe(true);
  if (!second.valid) {
    throw new Error("2回目の畳み込みに失敗した");
  }
  expect(viewOf(second.manifest, "order-list").preset_density).toBe("compact");
  expect(viewOf(second.manifest, "order-list").name).toBe("注文一覧");
});

test("update_view で 3値目を書いた差分は、差分の時点で拒否される(値域はスキーマが閉じる)", () => {
  const result = validateDiff({
    diff_id: "d-density-1",
    operations: [{ op: "update_view", view: "order-list", changes: { preset_density: "cozy" } }],
  });
  expect(result.valid).toBe(false);
});

test("update_view で自由な CSS 文字列を書いた差分も、差分の時点で拒否される", () => {
  const result = validateDiff({
    diff_id: "d-density-2",
    operations: [{ op: "update_view", view: "order-list", changes: { preset_density: "4px" } }],
  });
  expect(result.valid).toBe(false);
});

// --- (e) 既定は書かないこと(限定8。書かなかった画面は今日と1ピクセルも変わらない)--------

test("限定8: schema に default を1つも書いていない(既定は表示層の1箇所が持つ)", () => {
  const key = readSchema("manifest.schema.json").$defs.view.properties.preset_density as Any;
  expect(key.default).toBeUndefined();
  const change = readSchema("diff.schema.json").$defs.view_changes.properties.preset_density as Any;
  expect(change.default).toBeUndefined();
});
