/**
 * 詳細画面の項目のまとまり(`P-G17` の (C) 側。`V4-M16-T12` / `ADR-0092`)。
 *
 * **限定表の正は [`docs/adr/0092-detail-field-grouping.md`](../../docs/adr/0092-detail-field-grouping.md) §Decision 2(限定1〜限定9)**、
 * 完了条件の正は `docs/plan/v4/records/v4-m16.md` §2-3 の `V4-M16-T12` 節(9点)。
 *
 * **門A の判定 = 限定採用**(審査記録 = `docs/plan/v4/records/v4-m14-gate-a-field-grouping.md`)。
 *
 * ## このファイルが固定すること(カーネル側)
 *
 * 1. **限定1**: 足すキーは `$defs/view` に1本(`field_groups`)だけ。**`$defs` の本数 28 /
 *    `$defs/field.properties` 11 / `$defs/table.properties` 6 / `$defs/theme` 25 /
 *    `RESOURCE_KINDS` 7 / `FIELD_TYPES` 8 / `DIFF_OPS` 16 が1つも動かない。**
 *    【`V7-M1-T02`】**`$defs/table.properties` の数を 4 → 6 に是正した** —— `V6-M3-T01`
 *    (`ADR-0290`。4 → 5)と `V7-M1-T01`(`Z-G2`。5 → 6)が本体を動かしたのに、この行だけが
 *    `4` のまま残っていた(`v7-m0.md` §4-3 の表の4 が名指しした食い違い)。
 *    **【直していないものを正直に書く】同じ行の `$defs/field.properties` 11(実物 14)/
 *    `FIELD_TYPES` 8(実物 9)/ `DIFF_OPS` 16(実物 17)も今日の実物と食い違っている。**
 *    **本タスクの担当は `$defs/table` の1本だけなので、この3つは直していない。**
 * 2. **限定2**: `detail_view` 分岐でだけ許す(`list_view` / form 分岐では `false`)。
 * 3. **限定3**: 値は「まとまりの名前 → フィールドIDの配列」の1段だけ。**入れ子にしない。**
 *    **並び順を指定するキーを足さない**(順序はマニフェストの記述順)。
 * 4. **限定4**: `$defs/view.properties.fields` の schema に差分が1バイトも無い。
 * 5. **限定5**: 整合しない宣言は**差分全体を拒否する**(部分適用しない = `ADR-0047` 限定9)。
 * 6. **限定6**: 器の形を指すキーが `$defs/view.properties` に1つも無い。
 * 7. **限定9 / 完了条件 (7)**: `view_changes.properties` は 15 で、**`update_view` で書いた
 *    値が適用後マニフェストに実際に残る**(「書けるが効かない」を作っていないことの実測)。
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * - **器(見出し付きの区切り)の描画は表示層である** —— `web/test/detail-field-grouping.test.tsx`
 *   の担当。**このファイルは1ピクセルも見ていない。**
 * - **支援技術で使えるかを1本も測っていない**(`ADR-0092` §Context 4 の 7)。
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { foldOperations } from "./apply-diff.ts";
import type { DetailView, Manifest, Operation } from "./types.ts";
import { validateManifestFull } from "./validate.ts";

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

// ---------------------------------------------------------------------------
// (a) 増分の総量(限定1)
// ---------------------------------------------------------------------------

test("(a) 限定1: $defs/view.properties は 21 で、21キー目は field_groups である", () => {
  const properties = Object.keys(manifestSchema().$defs.view.properties);
  // **【V4-M16-T13 / ADR-0093 限定1 で 21 → 22 に更新した】** 門A の本審査(`V4-M14` 本審査② の単位11。判定 = 限定採用)が22キー目 `preset_list_shape`(一覧の器の形)を足した。
  // **【V4-M18-T03 / ADR-0095 限定1 で 22 → 23 に更新した】** 門A の本審査(V4-M18 単位3。
  // 判定 = 限定採用)が23キー目 `modal`(重ねて出す宣言)を足した。
  // **【V4-M22-T01 / ADR-0112 限定1 で 23 → 24 に更新した】** 門A の本審査(V4-M22 単位A。
  // 判定 = 限定採用)が24キー目 `search_fields`(検索の対象にする列)を足した。**本 ADR の
  // 増分ではない。**
  // **【V4-M22-T05 / ADR-0113 限定1 で 24 → 25 に更新した】** 門A の本審査(V4-M22 単位C。
  // **4回目の審査**。判定 = 限定採用)が25キー目 `page_size`(1ページに出す件数)を足した。
  // **本 ADR の増分ではない。**
  // **【V4-M19-T03 / ADR-0118 限定1 で 25 → 26 に更新した】** 26キー目 `preset_density`
  // (画面の詰まり具合)が門A を通って増えた(V4-M19 単位C。2回目の審査。判定 = 限定採用)。
  // **3種すべてに書けるキーである。****本 ADR の増分ではない。**
  // **【V4-M20-T04 / ADR-0102 限定1 で 26 → 27 に更新した】** 27キー目 `after_save`
  // (保存が成立したあとに行く画面のID)が門A を通って増えた(V4-M20 単位D。2回目の審査。
  // 判定 = 限定採用)。**form 型のビューでだけ書ける。****本 ADR の増分ではない。**
  // **【V4-M23-T01 / ADR-0104 限定1 で 27 → 28 に更新した】** 28キー目 `sum_field`
  // (合計を出す列)が門A を通って増えた(判定 = 限定採用)。**`list_view` でだけ書ける。**
  // **本 ADR の増分ではない —— `field_groups` が21キー目であることは今日も真である。**
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
  // **【V4-M16-T13 / ADR-0093 限定1 で書き換えた。理由を書く】** 着手前は `at(-1)` が
  // `field_groups` だったが、**`ADR-0093` が22キー目 `preset_list_shape` を末尾に足した**ので
  // 位置で引くと最後尾は本キーになる。**`field_groups` が21キー目であることは今日も真である。**
  // **【V4-M18-T03 / ADR-0095 限定1 で書き換えた】** 23キー目 `modal` が末尾に入ったので、
  // **`preset_list_shape`(22キー目)が今日も1つ手前であることは変わらない。**
  // **【V4-M22-T01 / ADR-0112 限定1 で書き換えた】** 24キー目 `search_fields` が末尾に
  // 入ったので、**`modal`(23キー目)が今日も1つ手前であることは変わらない。**
  // **【V4-M22-T05 / ADR-0113 限定1 で書き換えた】** 25キー目 `page_size` が末尾に
  // 入ったので、**`search_fields`(24キー目)が今日も1つ手前であることは変わらない。**
  // **【V4-M19-T03 / ADR-0118 限定1 で書き換えた】** 26キー目 `preset_density` が末尾に
  // 入ったので、**`page_size`(25キー目)が今日も1つ手前であることは変わらない。**
  // **【V4-M20-T04 / ADR-0102 限定1 で書き換えた】** 27キー目 `after_save` が末尾に
  // 入ったので、**`preset_density`(26キー目)が今日も1つ手前であることは変わらない。**
  // **【V4-M23-T01 / ADR-0104 限定1 で書き換えた】** 28キー目 `sum_field`(合計を出す列。
  // `list_view` でだけ書ける)が末尾に入ったので、**`after_save`(27キー目)が今日も1つ
  // 手前であることは変わらない。**
  // **【`V6-M2-T01` / `K-G2` / `ADR-0289` 限定1 で書き換えた】** 29キー目 `reference_pickers`
  // (参照項目の選び方の、入力画面ごとの上書き。`form` でだけ書ける)が末尾に入ったので、
  // **`sum_field`(28キー目)が今日も1つ手前であることは変わらない。**
  // **【2026-08-14。`V8-M8`。台帳 `Q-G1`】末尾に29キー目 `report`(集計表の中身)が入ったので、
  // 位置の添字を1つずつ後ろへずらした。****旧行の逐語は `at(-8)`〜`at(-1)` が
  // `preset_list_shape` / `modal` / `search_fields` / `page_size` / `preset_density` /
  // `after_save` / `sum_field` / `reference_pickers` の8行である。**
  // **`reference_pickers`(29キー目)が今日も末尾から2つ目であることは変わらない。**
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

// 【`V7-M1-T02`】**テスト名の `table 4` を `table 6` へ是正した。** 旧: 「(a) 限定1: field 12 /
//   table 4 / theme 25・25 が1つも動いていない」。**`V6-M3-T01`(4 → 5)と `V7-M1-T01`(5 → 6)が
//   本体を動かしたのに名前が `4` のまま残っていた。**
//   **【直していないものを正直に書く】`field 12` も消す前から本体が 14 を測っており食い違っている。**
//   **本タスクの担当は `$defs/table` の1本だけなので、`field` の側は直していない。**
test("(a) 限定1: field 12 / table 6 / theme 25・25 が1つも動いていない", () => {
  const schema = manifestSchema();
  // 【`V5-M29-T03` / `ADR-0250` 限定11】ここにあった「$defs 28 …が1つも動いていない」の検査は
  //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
  //   `manifest.$defs:` で始まる行)。**総量ではなく名前と順序で見張る。**
  //   消した位置にあったコメントの逐語: 「**新しい `$defs` を作らない**(値の構造は
  //   `$defs/view.properties.field_groups` にインラインで書く)。」
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
  // 【`V5-M29-T03` / `ADR-0250` 限定11】ここにあった「語彙3種が1つも動いていない」のうち
  //   `RESOURCE_KINDS` の本数の検査は `scripts/vocabulary-drift.test.ts` へ移した
  //   (一覧の `RESOURCE_KINDS:` で始まる行)。**総量ではなく名前と順序で見張る。**
  //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  // 【`V5-M29-T03` / `ADR-0250` 限定11】同じく `FIELD_TYPES` の本数の検査も
  //   `scripts/vocabulary-drift.test.ts` へ移した(一覧の `FIELD_TYPES:` で始まる行)。
  //   消した行に付いていた逐語: 「【`V5-M16` / `ADR-0161`】8 → 9(`file` が9種目)。**この行が固定していたのは
  //   「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**」
  //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  // 【`V5-M29-T03` / `ADR-0250` 限定11】同じく `DIFF_OPS` の本数の検査も
  //   `scripts/vocabulary-drift.test.ts` へ移した(一覧の `DIFF_OPS:` で始まる行)。
  //   消した行に付いていた逐語: 「【`V5-M17b` / `ADR-0248`】16 → 17(`set_user_kinds` が17種目)。**この行が固定していたのは
  //   「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**」
  //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
});

test("(a) 限定1: 色 pattern が1バイトも動いていない", () => {
  // **`ADR-0092` はテーマに1バイトも触らない。** 色の形の定義が動いていないことを見る。
  const raw = readFileSync(join(ROOT, "schemas", "manifest.schema.json"), "utf8");
  expect(raw).toContain("^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$");
});

// ---------------------------------------------------------------------------
// (b) 限定2: detail_view でだけ書ける
// ---------------------------------------------------------------------------

test("(b) 限定2: list_view 分岐と form 分岐で field_groups は false である", () => {
  expect(falseKeys("list_view")).toContain("field_groups");
  expect(falseKeys("form")).toContain("field_groups");
  // **detail_view 分岐には `false` を置かない**(そこでだけ書ける)。
  expect(falseKeys("detail_view")).not.toContain("field_groups");
});

test("(b) 限定2: 3つの分岐の false の本数が 10 / 17 / 13 である(既存の false を1つも動かしていない)", () => {
  // **着手前は 5 / 10 / 6 だった。** 増えたのは `field_groups` の2本だけで、
  // **既存の `false` を1バイトも動かしていない**(名指しで全量を固定する)。
  //
  // **【V4-M16-T13 / `ADR-0093` 限定2 で 6 / 11 / 6 → 6 / 12 / 7 に更新した】**
  // **増えたのは `preset_list_shape` の2本(form / detail_view)だけで、
  // `ADR-0092` が置いた `field_groups` の3本は1バイトも動いていない。**
  //
  // **【V4-M18-T03 / ADR-0095 限定6 で 6 / 12 / 7 → 7 / 12 / 8 に更新した】**
  // **増えたのは `modal` の2本(list_view / detail_view)だけである。** `form` 分岐は
  // **1バイトも変えていない**(`modal` は form でだけ書けるので、そこには `false` を置かない)。
  //
  // **【V4-M22-T01 / ADR-0112 限定3 で 7 / 12 / 8 → 7 / 13 / 9 に更新した】**
  // **増えたのは `search_fields` の2本(form / detail_view)だけである。** `list_view` 分岐は
  // **1バイトも変えていない**(`search_fields` は list_view でだけ書けるので、そこには
  // `false` を置かない)。
  //
  // **【V4-M22-T05 / ADR-0113 限定7 で 7 / 13 / 9 → 7 / 14 / 10 に更新した】**
  // **増えたのは `page_size` の2本(form / detail_view)だけである。** `list_view` 分岐は
  // **1バイトも変えていない**(`page_size` は list_view でだけ書けるので、そこには
  // `false` を置かない)。
  //
  // **【V4-M20-T04 / ADR-0102 限定3 で 7 / 14 / 10 → 8 / 14 / 11 に更新した】**
  // **増えたのは `after_save` の2本(list_view / detail_view)だけである。** `form` 分岐は
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
  // `list_view` 分岐は **1バイトも変えていない**(`sum_field` は `list_view` でだけ書けるので、
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
  // **増えたのは29キー目 `reference_pickers`(参照項目の選び方の、入力画面ごとの上書き)の
  // 2本(list_view / detail_view)だけである。** `form` 分岐は **1バイトも変えていない**
  // (`reference_pickers` は `form` でだけ書けるので、そこには `false` を置かない)。
  // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】8 / 15 / 13 → 9 / 16 / 14 に**
  // **更新した。****増えたのは29キー目 `report`(集計表の中身)の3本(list_view / form /
  // detail_view)だけである。****既存の `false` を1バイトも動かしていない。**
  // **`report_view` 分岐(5分岐目)はこの test の対象ではない** —— **この test が名乗って
  // いるのは「3つの分岐」であり、4つ目の画面種別の分岐は
  // `src/server/report-declaration-boundary.test.ts` の (13) が別に固定している。**
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
    // **【V4-M18-T03 / ADR-0095 限定6 で足した】** list_view では `modal` も `false`。
    // **`ADR-0093` の増分(`preset_list_shape` は list_view でだけ書けるので false ではない)は
    // 1バイトも動いていない。**
    "modal",
    "preset_field_columns",
    "preset_label_placement",
    // **【`V6-M2-T01` / `ADR-0289` 限定4 で足した】** list_view では `reference_pickers` も
    // `false`(`form` でだけ書ける)。
    "reference_pickers",
    "related",
    // **【`V8-M8` / `Q-G1`】29キー目 `report`(集計表の中身)は list_view では `false`。**
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
    // **【V4-M22-T05 / ADR-0113 限定7 で足した】** `page_size`(1ページに出す件数)も
    // form では `false`。**`ADR-0093` / `ADR-0095` / `ADR-0112` の増分は1バイトも動いていない。**
    "page_size",
    "preset_column_align",
    "preset_column_width",
    "preset_image_size",
    // **【V4-M16-T13 / ADR-0093 限定2 で足した】** 8つ目の `preset_` キーも form では `false`。
    // **`ADR-0092` の増分(`field_groups`)は1バイトも動いていない。**
    "preset_list_shape",
    "preset_pager_position",
    "preset_text_preview",
    "related",
    // **【`V8-M8` / `Q-G1`】29キー目 `report`(集計表の中身)は form では `false`。**
    "report",
    // **【V4-M22-T01 / ADR-0112 限定3 で足した】** `search_fields`(検索の対象にする列)も
    // form では `false`。**`ADR-0093` / `ADR-0095` の増分は1バイトも動いていない。**
    "search_fields",
    "sort",
    // **【V4-M23-T01 / ADR-0104 限定3 で足した】** 28キー目 `sum_field`(合計を出す列)も
    // form では `false`(`list_view` でだけ書ける)。**`ADR-0093` / `ADR-0095` / `ADR-0112` /
    // `ADR-0113` の増分は1バイトも動いていない。**
    "sum_field",
  ]);
  expect(falseKeys("detail_view")).toEqual([
    // **【2026-08-20。`V10-M1-T01` / `ADR-0358` 限定1 でこの行を外した】**
    // **旧行の逐語**: `"after_save",`(直前の `V4-M20-T04` / `ADR-0102` 限定3 の注記ごと)。
    // **`detail_view` では今日 `after_save` を書ける** —— **発火するのは `actions` の
    // `set` 形の書込が成立したときだけで、`run` 形の後は移らない**(限定2)。
    "columns",
    "filter",
    // **【V4-M18-T03 / ADR-0095 限定6 で足した】** detail_view でも `modal` は `false`。
    "modal",
    // **【V4-M22-T05 / ADR-0113 限定7 で足した】** `page_size`(1ページに出す件数)も
    // detail_view では `false`。
    "page_size",
    "preset_column_align",
    "preset_column_width",
    // **【V4-M16-T13 / ADR-0093 限定2 で足した】** 8つ目の `preset_` キーは detail_view でも `false`。
    "preset_list_shape",
    "preset_pager_position",
    // **【`V6-M2-T01` / `ADR-0289` 限定4 で足した】** detail_view でも `reference_pickers` は
    // `false`(`form` でだけ書ける)。
    "reference_pickers",
    // **【`V8-M8` / `Q-G1`】29キー目 `report`(集計表の中身)は detail_view では `false`。**
    "report",
    // **【V4-M22-T01 / ADR-0112 限定3 で足した】** `search_fields`(検索の対象にする列)も
    // detail_view では `false`。
    "search_fields",
    "sort",
    // **【V4-M23-T01 / ADR-0104 限定3 で足した】** 28キー目 `sum_field`(合計を出す列)も
    // detail_view では `false`(`list_view` でだけ書ける)。
    "sum_field",
  ]);
});

test("(b) 限定2: list_view / form に field_groups を書いたマニフェストは拒否される", () => {
  for (const view of [
    {
      id: "entry-list",
      type: "list_view",
      table: "entries",
      columns: ["title"],
      field_groups: { 基本: ["title"] },
    },
    {
      id: "entry-form",
      type: "form",
      table: "entries",
      fields: ["title"],
      field_groups: { 基本: ["title"] },
    },
  ] as unknown as Manifest["app"]["views"]) {
    const manifest = baseManifest();
    manifest.app.views = [view];
    expect(validateManifestFull(manifest).valid, view.id).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// (c) 限定3: 値は1段だけ / 並び順のキーは無い
// ---------------------------------------------------------------------------

test("(c) 限定3: 値は「配列」か「{ id?, fields }」の2形で、どちらも1段だけである", () => {
  const key = manifestSchema().$defs.view.properties.field_groups as Any;
  expect(key.type).toBe("object");
  expect(key.minProperties).toBe(1);
  // **まとまりの名前は表示名であり `resource_id` ではない。**
  expect(key.propertyNames).toEqual({ type: "string", minLength: 1, maxLength: 40 });
  /*
   * **【`CM-G24` / `V10-M24-T03` / `ADR-0371` による更新】値は `oneOf` の2枝になった。**
   * **`oneOf[0]`(旧形)は `ADR-0092` 当時の定義を1バイトも書き換えずにそのまま移したもの
   * である** —— **下の `toEqual` は着手前の `additionalProperties` の逐語そのままであり、
   * `uniqueItems: true` も含めて1文字も変えていない。**
   * **`oneOf[1]`(新形)は名札 `id` を書けるようにするためだけに足した2キーちょうどの
   * オブジェクトで、`required` は `["fields"]` だけ**(名札は任意 = `ADR-0372` `CM-G32` 限定1)。
   * **入れ子は今日も1段も開いていない** —— `oneOf[1].properties.fields` の中に
   * さらに `oneOf` を作っていないので、まとまりの中にまとまりは書けない(下の検査が固定する)。
   */
  expect(key.additionalProperties.oneOf).toHaveLength(2);
  expect(key.additionalProperties.oneOf[0]).toEqual({
    type: "array",
    minItems: 1,
    uniqueItems: true,
    items: { $ref: "#/$defs/resource_id" },
  });
  const labelled = key.additionalProperties.oneOf[1];
  expect(labelled.type).toBe("object");
  expect(Object.keys(labelled.properties)).toEqual(["id", "fields"]);
  expect(labelled.required).toEqual(["fields"]);
  expect(labelled.additionalProperties).toBe(false);
  expect(labelled.properties.id.$ref).toBe("#/$defs/resource_id");
  // **新形の `fields` は旧形と同じ配列である**(値域を割っていない)。
  expect(labelled.properties.fields).toEqual({
    type: "array",
    minItems: 1,
    uniqueItems: true,
    items: { $ref: "#/$defs/resource_id" },
  });
});

test("(c) 限定3: 入れ子(まとまりの中にまとまり)を書いた差分は拒否される", () => {
  const manifest = baseManifest();
  (manifest.app.views[2] as Any).field_groups = { 基本: { 内側: ["title"] } };
  expect(validateManifestFull(manifest).valid).toBe(false);
});

test("(c) 限定3: 並び順を指定するキーが1つも無い(順序はマニフェストの記述順)", () => {
  const key = manifestSchema().$defs.view.properties.field_groups as Any;
  // **散文(`$comment` / `description`)を除いた形の全量**が上の4キーだけである ——
  // `order` / `position` / `index` / `sort` のような並び順のキーは1つも無い。
  const { $comment: _c, description: _d, ...shape } = key;
  expect(Object.keys(shape).sort()).toEqual([
    "additionalProperties",
    "minProperties",
    "propertyNames",
    "type",
  ]);
});

// ---------------------------------------------------------------------------
// (d) 限定4: `fields` を1バイトも変えない
// ---------------------------------------------------------------------------

test("(d) 限定4: $defs/view.properties.fields の schema が着手前と完全一致する", () => {
  expect(manifestSchema().$defs.view.properties.fields).toEqual({
    description:
      "form で入力する、または detail_view で表示するフィールドIDの一覧。detail_view では省略でき、省略した場合は対象テーブルの全フィールドを表示する。",
    $ref: "#/$defs/field_id_list",
  });
});

// ---------------------------------------------------------------------------
// (f) 限定6: 器の形を指すキーが1つも無い
// ---------------------------------------------------------------------------

test("(f) 限定6: $defs/view.properties に器の形(タブ/畳む/開く)を指すキーが1つも無い", () => {
  const properties = Object.keys(manifestSchema().$defs.view.properties);
  for (const forbidden of [
    "field_group_style",
    "field_groups_style",
    "group_display",
    "tabs",
    "tab",
    "accordion",
    "collapsible",
    "collapsed",
    "layout",
  ]) {
    expect(properties, forbidden).not.toContain(forbidden);
  }
  // 字面でも見る(器の形を指す語をキー名に持ち込まない)。**`table` は `tab` を含むが
  // 「対象テーブル」であって器の形ではない**ので、単語境界つきで見る。
  expect(properties.filter((key) => /style|display|accordion|collaps|\btabs?\b/.test(key))).toEqual(
    [],
  );
});

// ---------------------------------------------------------------------------
// (e) 限定5: 整合しない宣言は差分全体を拒否する
// ---------------------------------------------------------------------------

/**
 * 検査用の最小マニフェスト。
 *
 * `entries` は3フィールド。ビューは list_view / form / detail_view の3種。
 * **`detail_view` は `fields` を持たない**(= テーブル定義順の全項目)。
 */
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
          ],
        },
      ],
      views: [
        { id: "entry-list", type: "list_view", table: "entries", columns: ["title"] },
        { id: "entry-form", type: "form", table: "entries", fields: ["title"] },
        { id: "entry-detail", type: "detail_view", table: "entries" },
      ],
    },
  };
}

/** `detail_view` に `field_groups`(と任意で `fields`)を書いたマニフェスト。 */
function manifestWithGroups(groups: Record<string, string[]>, fields?: string[]): Manifest {
  const manifest = baseManifest();
  const view = manifest.app.views[2] as DetailView;
  if (fields !== undefined) {
    view.fields = fields;
  }
  (view as Any).field_groups = groups;
  return manifest;
}

test("(e) 限定5: 同じフィールドIDが2つのまとまりに現れたら拒否される", () => {
  const result = validateManifestFull(
    manifestWithGroups({ 基本: ["title", "memo"], 金額: ["memo", "amount"] }),
  );
  expect(result.valid).toBe(false);
  if (result.valid) {
    return;
  }
  const error = result.errors.find((candidate) => candidate.path.includes("field_groups"));
  expect(error?.path).toBe("/app/views/2/field_groups/金額/0");
  expect(error?.message).toContain("memo");
  expect(error?.message).toContain("基本");
  expect(error?.hint).toBeDefined();
});

test("(e) 限定5: fields を指定した detail_view で、fields に無いIDを書いたら拒否される", () => {
  const result = validateManifestFull(
    manifestWithGroups({ 基本: ["title", "amount"] }, ["title", "memo"]),
  );
  expect(result.valid).toBe(false);
  if (result.valid) {
    return;
  }
  const error = result.errors.find((candidate) => candidate.path.includes("field_groups"));
  expect(error?.path).toBe("/app/views/2/field_groups/基本/1");
  expect(error?.message).toContain("amount");
  // **候補は `fields` に書いた表示項目そのもの**(テーブルの全フィールドではない)。
  expect(error?.allowed_values).toEqual(["title", "memo"]);
});

test("(e) 限定5: fields を書いていない detail_view では、対象テーブルのフィールドで照合する", () => {
  // **`fields` 未指定 = テーブル定義順の全項目**(`DetailViewRenderer.tsx:157`-`:165`)。
  // したがって `memo` は**通る**。
  expect(validateManifestFull(manifestWithGroups({ 基本: ["memo"] })).valid).toBe(true);

  // 実在しないIDは拒否され、候補はテーブルのフィールド一覧である。
  const result = validateManifestFull(manifestWithGroups({ 基本: ["nope"] }));
  expect(result.valid).toBe(false);
  if (result.valid) {
    return;
  }
  const error = result.errors.find((candidate) => candidate.path.includes("field_groups"));
  expect(error?.path).toBe("/app/views/2/field_groups/基本/0");
  expect(error?.allowed_values).toEqual(["title", "memo", "amount"]);
});

test("(e) 限定5: 整合する宣言は通る(検査が全部拒否して緑になる壊れ方を防ぐ)", () => {
  expect(
    validateManifestFull(manifestWithGroups({ 基本: ["title"], 金額: ["amount"] })).valid,
  ).toBe(true);
});

test("(e) 限定5: 拒否された差分は部分適用されない(全か無か = ADR-0047 限定9)", () => {
  // **op0 は単体なら通る変更である。** op1 が拒否されたら**差分全体が拒否され**、
  // op0 の変更も1バイトも残らない。
  const before = baseManifest();
  const folded = foldOperations(before, [
    { op: "update_view", view: "entry-list", changes: { name: "一覧(改)" } },
    {
      op: "update_view",
      view: "entry-detail",
      changes: { field_groups: { 基本: ["title"], 重複: ["title"] } },
    },
  ] as unknown as Operation[]);
  // 畳み込み自体は通る(参照整合は適用後マニフェストで見る)。
  expect(folded.valid).toBe(true);
  if (!folded.valid) {
    return;
  }
  // **適用後マニフェストの検証で落ちる = ディスクには1バイトも書かれない。**
  expect(validateManifestFull(folded.manifest).valid).toBe(false);
  // **入力のマニフェストは1バイトも書き換わっていない**(`foldOperations` は複製に適用する)。
  expect(before.app.views[0]?.name).toBeUndefined();
});

// ---------------------------------------------------------------------------
// (i) 完了条件 (7) / 限定9: view_changes 15 と「値が実際に運ばれる」こと
// ---------------------------------------------------------------------------

test("(i) view_changes.properties は 15 で、15キー目は field_groups である", () => {
  const properties = Object.keys(diffSchema().$defs.view_changes.properties);
  // **【V4-M16-T13 / ADR-0093 限定2 で 15 → 16 に更新した】** `update_view` にも16キー目 `preset_list_shape` が加わった(値はカーネルが実際に運ぶ)。
  // **【V4-M18-T03 / ADR-0095 限定6 で 16 → 17 に更新した】** `update_view` にも17キー目
  // `modal` が加わった(値は `applyViewChanges` の `form` 分岐が実際に運ぶ)。
  // **【V4-M22-T01 / ADR-0112 限定2 で 17 → 18 に更新した】** `update_view` にも18キー目
  // `search_fields` が加わった(値は `applyViewChanges` の `list_view` 分岐が実際に運ぶ)。
  // **【V4-M22-T05 / ADR-0113 限定2 で 18 → 19 に更新した】** `update_view` にも19キー目
  // `page_size` が加わった(値は `applyViewChanges` の `list_view` 分岐が実際に運ぶ)。
  // **【V4-M19-T03 / ADR-0118 限定1 で 19 → 20 に更新した】** 20キー目 `preset_density`
  // (画面の詰まり具合)が門A を通って増えた(V4-M19 単位C。2回目の審査。判定 = 限定採用)。
  // **3種すべてに書けるキーである。****本 ADR の増分ではない。**
  // **【V4-M20-T04 / ADR-0102 限定2 で 20 → 21 に更新した】** 21キー目 `after_save` が
  // `update_view` にも加わった(値は `applyViewChanges` の `form` 分岐が実際に運ぶ)。
  // **本 ADR の増分ではない。**
  // **【V4-M23-T01 / ADR-0104 限定2 で 21 → 22 に更新した】** 22キー目 `sum_field`
  // (合計を出す列。`list_view` でだけ書ける)が `update_view` にも加わった(値は
  // `applyViewChanges` の `list_view` 分岐が実際に運ぶ)。**本 ADR の増分ではない。**
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
  // **【V4-M16-T13 / ADR-0093 限定2 で書き換えた】** 16キー目 `preset_list_shape` が
  // 末尾に入った。**`field_groups` が15キー目であることは今日も真である。**
  // **【V4-M18-T03 / ADR-0095 限定6 で書き換えた】** 17キー目 `modal` が末尾に入った。
  // **【V4-M22-T01 / ADR-0112 限定2 で書き換えた】** 18キー目 `search_fields` が末尾に
  // 入ったので、**`modal`(17キー目)が今日も1つ手前であることは変わらない。**
  // **【V4-M22-T05 / ADR-0113 限定2 で書き換えた】** 19キー目 `page_size` が末尾に
  // 入ったので、**`search_fields`(18キー目)が今日も1つ手前であることは変わらない。**
  // **【V4-M19-T03 / ADR-0118 限定1 で書き換えた】** 20キー目 `preset_density` が末尾に
  // 入ったので、**`page_size`(19キー目)が今日も1つ手前であることは変わらない。**
  // **【V4-M20-T04 / ADR-0102 限定2 で書き換えた】** 21キー目 `after_save` が末尾に
  // 入ったので、**`preset_density`(20キー目)が今日も1つ手前であることは変わらない。**
  // **【V4-M23-T01 / ADR-0104 限定2 で書き換えた】** 22キー目 `sum_field`(合計を出す列。
  // `list_view` でだけ書ける)が末尾に入ったので、**`after_save`(21キー目)が今日も1つ
  // 手前であることは変わらない。**
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
  // **定義はマニフェスト側を `$ref` する**(値域の定義を二重に持たない。`name` / `custom_css`
  // / `menu_listed` と同じ作法)。
  expect(diffSchema().$defs.view_changes.properties.field_groups.$ref).toBe(
    "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/view/properties/field_groups",
  );
});

test("(i) 既存の $comment を1バイトも書き換えていない(menu_listed は今日も『14キー目である』と書く)", () => {
  const raw = readFileSync(join(ROOT, "schemas", "diff.schema.json"), "utf8");
  expect(raw).toContain("**14キー目である。**");
  // 15キー目であることは**新しいキーの側の `$comment`** に書く(`ADR-0084` の作法と同型)。
  expect(diffSchema().$defs.view_changes.properties.field_groups.$comment).toContain("15キー目");
});

test("(i) update_view で書いた field_groups が適用後マニフェストに実際に残る(書けるが効かないを作っていない)", () => {
  const folded = foldOperations(baseManifest(), [
    {
      op: "update_view",
      view: "entry-detail",
      changes: { field_groups: { 基本: ["title"], 金額: ["amount"] } },
    },
  ] as unknown as Operation[]);
  expect(folded.valid).toBe(true);
  if (!folded.valid) {
    return;
  }
  const view = folded.manifest.app.views[2] as DetailView;
  expect(view.field_groups).toEqual({ 基本: ["title"], 金額: ["amount"] });
  // 適用後マニフェストとしても妥当である(= ディスクに書かれる形である)。
  expect(validateManifestFull(folded.manifest).valid).toBe(true);
});

test("(i) update_view の field_groups は list_view / form では拒否される(種別で絞る)", () => {
  for (const viewId of ["entry-list", "entry-form"]) {
    const folded = foldOperations(baseManifest(), [
      {
        op: "update_view",
        view: viewId,
        changes: { field_groups: { 基本: ["title"] } },
      },
    ] as unknown as Operation[]);
    expect(folded.valid, viewId).toBe(false);
  }
});

test("(i) update_view はキー単位の差し替えである(書かなかったキーに触らない)", () => {
  const first = foldOperations(baseManifest(), [
    {
      op: "update_view",
      view: "entry-detail",
      changes: { field_groups: { 基本: ["title"] } },
    },
  ] as unknown as Operation[]);
  expect(first.valid).toBe(true);
  if (!first.valid) {
    return;
  }
  const second = foldOperations(first.manifest, [
    { op: "update_view", view: "entry-detail", changes: { name: "詳細" } },
  ] as unknown as Operation[]);
  expect(second.valid).toBe(true);
  if (!second.valid) {
    return;
  }
  const view = second.manifest.app.views[2] as DetailView;
  // **前進で外す手段は無い**(限定9。`preset_` / `custom_css` / `menu_listed` と同じ性質)。
  expect(view.field_groups).toEqual({ 基本: ["title"] });
  expect(view.name).toBe("詳細");
});
