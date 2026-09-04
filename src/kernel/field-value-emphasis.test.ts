/**
 * 値の意味に応じた強調をフィールドに宣言する(`P-G28` + `P-G22` の (C) 側。
 * `V4-M16-T10` / `ADR-0090`)。
 *
 * **限定表の正は [`docs/adr/0090-value-emphasis-declaration.md`](../../docs/adr/0090-value-emphasis-declaration.md)
 * §Decision 2(限定1〜限定10)**、完了条件の正は `docs/plan/v4/records/v4-m16.md` §2-3 の
 * `V4-M16-T10` の行(9点)。
 *
 * ## このファイルが固定すること(カーネル側)
 *
 * 1. **限定1 / 限定5**: 足すキーは `$defs/field` に1本(`emphasis`)だけ。
 *    `$defs`(28)/ `$defs/view.properties`(20)/ `$defs/theme`(25 / 25)が1つも動かない。
 * 2. **限定2**: `FIELD_TYPES`(8)/ `RESOURCE_KINDS`(7)/ `DIFF_OPS`(16)が動かない。
 *    **`emphasis` 型も `status` 型も作っていない。**
 * 3. **限定3**: 意味の名前は有限 enum 4値ちょうど。**5値目も、色の実値も、CSS 文字列も
 *    1バイトも書けない。**
 * 4. **限定4**: `select` 型にだけ書ける。**他の7型に書いたら差分全体を拒否する**
 *    (`add_field` / `add_table` / `change_field` の3経路とも)。**`options` に無い値を
 *    キーに書いても拒否する。**
 * 5. **限定8 の裏**: `change_field` で後から書けて、**値が適用後マニフェストに実際に残る**
 *    (`ADR-0076` の `writable_by` が作った「書けるが効かない」穴を繰り返さない)。
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * - **どの値が注意かをプラットフォームは1度も検証しない**(`ADR-0090` §Context 4 の 4)。
 *   検証するのは「そのキーが `options` に在るか」だけであって、**「決済できず」が本当に
 *   注意を要するかは、アプリが宣言した主張のまま通る。**
 * - **強調色と背景色の対はコントラスト検査に1組も載っていない**(同 5)。**読みやすさを
 *   本ファイルは1件も担保しない。**
 * - **描画の実測は `web/test/value-emphasis.test.tsx` と chromium の担当である。**
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { foldOperations } from "./apply-diff.ts";
import type { Field, Manifest, Operation } from "./types.ts";
import { FIELD_TYPES } from "./types.ts";
import { validateDiff, validateManifest, validateManifestFull } from "./validate.ts";

const ROOT = dirname(dirname(import.meta.dir));

// biome-ignore lint/suspicious/noExplicitAny: スキーマ JSON を素で読むための局所エイリアス。
type Any = any;

function readSchema(name: string): Any {
  return JSON.parse(readFileSync(join(ROOT, "schemas", name), "utf8")) as Any;
}

/** 意味の名前(限定3。**この4値がすべてである**)。 */
const EMPHASIS_NAMES = ["neutral", "info", "caution", "danger"] as const;

// --- (a) 増分の総量(限定1 / 限定5)-----------------------------------------------------

test("限定1: $defs/field.properties は 11 で、11キー目は emphasis である", () => {
  // **【V4-M19-T07 / ADR-0119 限定1 で 11 → 12 に更新した】** 12キー目 `hide_when_empty`
  // (値が無いとき行ごと出さない)が門A を通って増えた(V4-M19 単位E-a。2回目の審査。
  // 判定 = 限定採用)。**見る位置を `at(-1)`(末尾)から `[10]`(11キー目)へ直した。
  // 末尾は今日 `hide_when_empty` だからである。** **期待値を緩めていない**
  // (位置は今日も1つに固定される)。**本 ADR の増分ではない。**
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
  expect(properties[8]).toBe("emphasis");
});

test("限定1 / 限定5: theme 25・25 が1つも動いていない", () => {
  const manifest = readSchema("manifest.schema.json");
  // 【`V5-M29-T03` / `ADR-0250` 限定11】ここにあった「$defs 28 が1つも動いていない」の検査は
  //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
  //   `manifest.$defs:` で始まる行)。**総量ではなく名前と順序で見張る。**
  //   消した位置にあったコメントの逐語: 「**新しい `$defs` を作らない**(値域は
  //   `$defs/field/properties/emphasis` の中に閉じる)。」
  //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  // 【`V5-M29-T03`】**テスト名を書き換えた。** 旧: 「限定1 / 限定5: $defs 28 / view.properties 20 / theme 25・25 が1つも動いていない」。
  //   本体から `$defs` と `view.properties` を測る `expect` が消えたため(記録 §4-7)。
  //   **`view.properties 20` は消す前から本体が 28 を測っており、食い違っていた。**
  // **`$defs/view` に1バイトも触らない** —— **画面ごとに強調を変えることはできない。**
  // **【V4-M16-T12 / `P-G17` の (C) 側 / ADR-0092 限定1 で 20 → 21 になった。理由を書く】**
  // **「テストが落ちたから直した」のではない。** `V4-M14` 本審査② の単位9 が `P-G17` を
  // **限定採用**し(ADR-0092。限定1 =「`$defs/view` に足すキーは1本だけ」)、
  // **21キー目 `field_groups`(詳細画面の項目のまとまり)が門A を通って増えたためである。**
  // **本 ADR(この検査が守っている判定)の増分が増えたのではない** —— どの ADR の限定が
  // 何を増やしたかを混ぜない。
  // **【V4-M16-T13 / ADR-0093 限定1 で 21 → 22 に更新した】** 門A の本審査(`V4-M14` 本審査② の単位11。判定 = 限定採用)が22キー目 `preset_list_shape`(一覧の器の形)を足した。
  // **【V4-M18-T03 / ADR-0095 限定1 で 22 → 23 に更新した】** 門A の本審査(V4-M18 単位3。
  // 判定 = 限定採用)が23キー目 `modal`(重ねて出す宣言)を足した。**本 ADR の増分ではない。**
  // **【V4-M22-T01 / ADR-0112 限定1 で 23 → 24 に更新した】** 24キー目 `search_fields`
  // (検索の対象にする列)が門A を通って増えた。**本 ADR の増分ではない。**
  // **【V4-M22-T05 / ADR-0113 限定1 で 24 → 25 に更新した】** 25キー目 `page_size`
  // (1ページに出す件数)が門A を通って増えた(V4-M22 単位C。4回目の審査)。**本 ADR の
  // 増分ではない。**
  // **【V4-M19-T03 / ADR-0118 限定1 で 25 → 26 に更新した】** 26キー目 `preset_density`
  // (画面の詰まり具合)が門A を通って増えた(V4-M19 単位C。2回目の審査。判定 = 限定採用)。
  // **3種すべてに書けるキーである。****本 ADR の増分ではない。**
  // **【V4-M20-T04 / ADR-0102 限定1 で 26 → 27 に更新した】** 27キー目 `after_save`
  // (保存が成立したあとに行く画面のID)が門A を通って増えた(V4-M20 単位D。2回目の審査。
  // 判定 = 限定採用)。**form 型のビューでだけ書ける。****本 ADR の増分ではない。**
  // **【V4-M23-T01 / ADR-0104 限定1 で 27 → 28 に更新した】** 28キー目 `sum_field`
  // (合計を出す列)が門A を通って増えた。**`list_view` でだけ書ける。****本 ADR の
  // 増分ではない。**
  // 【`V5-M29-T03` / `ADR-0250` 限定11】ここにあった「$defs/view.properties は 28 のままである」の検査は
  //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
  //   `manifest.$defs.view.properties:` で始まる行)。**総量ではなく名前と順序で見張る。**
  //   **上の8つの【】が書き残した「20 → 28 の経緯」は、中央では追えない。**
  //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  // **新しい色スロットを1つも作らない**(限定5)。
  expect(Object.keys(manifest.$defs.theme.properties)).toHaveLength(25);
  expect(manifest.$defs.theme.required).toHaveLength(25);
});

// 【`V7-M1-T02`】**テスト名の「4」を「6」へ是正した。** 旧: 「限定1: $defs/table.properties 4 も動いていない」。
//   **`V6-M3-T01` が本体を 4 → 5 に更新したときにテスト名を直しておらず、着手前から
//   名前と期待値が食い違っていた**(`v7-m0.md` §4-3 の表の2 が名指しした3箇所のうちの1件)。
//   **本タスクで是正した。**
test("限定1: $defs/table.properties 6 も動いていない", () => {
  // **【V4-M16-T12 / ADR-0092 限定2 で 14 → 15 になった。理由を書く】** 15キー目
  // `field_groups` は **detail_view でだけ書ける**キーで、**門A の本審査(判定 = 限定採用)を
  // 通った増分である。****本 ADR の増分が増えたのではない。**
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
  // (合計を出す列。`list_view` でだけ書ける)が `update_view` にも加わった
  // (値は `applyViewChanges` の `list_view` 分岐が実際に運ぶ)。**本 ADR の増分ではない。**
  // **【V5-M21-T03 / `L-G4` / ADR-0172 限定1 で 22 → 23 に更新した】** 23キー目 `actions`
  // (操作起点)が末尾に入った(門A の本審査 = `V5-M20` 面1 の `L-G4`。判定 = 限定採用)。
  // **本 ADR の増分ではない。****`related` / `audience` は今日も `view_changes` に無い。**
  // 【`V5-M29-T03` / `ADR-0250` 限定11】ここにあった「view_changes の本数は 23 のままである」の検査は
  //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
  //   `diff.$defs.view_changes.properties:` で始まる行)。**総量ではなく名前と順序で見張る。**
  //   **上の10本の【】が書き残した「14 → 23 の経緯」は、中央では追えない。**
  //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  //   **この1件は発注書 §2-4 が数え落としていた2件のうちの1件である**(記録 §3 に全件列挙した)。
  // 【`V5-M29-T03`】**テスト名を書き換えた。** 旧: 「限定1: view_changes 15 / $defs/table.properties 4 も動いていない」。
  //   本体から `view_changes` を測る `expect` が消えたため(記録 §4-7)。
  //   **`view_changes 15` は消す前から本体が 23 を測っており、食い違っていた。**
  // **【`V6-M3-T01` / `K-G6` / `ADR-0290` 限定1 で 4 → 5 に更新した】** 5キー目 `reference_search_fields`
  // (このテーブルが参照されたときの「探せる項目」の既定)が門A を通って増えた(`V6-M0` 単位B。判定 = 限定採用)。
  // **本 ADR の増分ではない。**
  // **【`V7-M1-T01` / `Z-G2` で 5 → 6 に更新した】** 6キー目 `access_control`(この表で
  // アクセス権管理を使うことと、付与・グループ・メンバーの置き場所の宣言)が門A を通って
  // 増えた(`V7-M0`。判定 = 限定採用)。**本 ADR の増分ではない。**
  expect(Object.keys(readSchema("manifest.schema.json").$defs.table.properties)).toHaveLength(6);
});

// --- (b) 限定2: 型・リソース種・差分操作を1つも動かさない --------------------------------

// 【`V5-M29-T03` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
//   消したテスト名(逐語): 「限定2: FIELD_TYPES 8 / RESOURCE_KINDS 7 / DIFF_OPS 16 が1つも動いていない」
//   そのブロックが測っていたもの:
//     - `expect(FIELD_TYPES).toHaveLength(9)`(行末の逐語: 「【`V5-M16` / `ADR-0161`】8 → 9(`file` が9種目)。
//       **この行が固定していたのは「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**」)
//     - `expect(RESOURCE_KINDS).toHaveLength(7)`
//     - `expect(DIFF_OPS).toHaveLength(17)`(行末の逐語: 「【`V5-M17b` / `ADR-0248`】16 → 17(`set_user_kinds` が17種目)。
//       **この行が固定していたのは「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**」)
//   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `FIELD_TYPES:` / `RESOURCE_KINDS:` / `DIFF_OPS:` で始まる行)。
//   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
//   検出力0のまま `Ran` を水増しする)。
//   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。

test("限定2: emphasis 型も status 型も作っていない", () => {
  expect(FIELD_TYPES).not.toContain("emphasis");
  expect(FIELD_TYPES).not.toContain("status");
  expect(readSchema("manifest.schema.json").$defs.field_type.enum).toEqual([...FIELD_TYPES]);
});

// --- (c) 限定3: 値域は有限 enum 4値ちょうど --------------------------------------------

test("限定3: 値域は「options の値 → 意味の名前」の対応表で、意味の名前は enum 4値ちょうどである", () => {
  const key = readSchema("manifest.schema.json").$defs.field.properties.emphasis as Any;
  const { $comment: _c, description: _d, ...shape } = key;
  expect(shape).toEqual({
    type: "object",
    minProperties: 1,
    propertyNames: { type: "string", minLength: 1 },
    additionalProperties: { enum: [...EMPHASIS_NAMES] },
  });
  // **5値目を足すとここが落ちる。**
  expect(shape.additionalProperties.enum).toHaveLength(4);
});

function manifestWithField(field: Record<string, unknown>): unknown {
  return {
    app: {
      id: "emphasis-shop",
      name: "強調の店",
      tables: [{ id: "order", name: "注文", fields: [field] }],
      views: [{ id: "order-list", type: "list_view", table: "order", columns: [field.id] }],
    },
  };
}

/** `select` 型のフィールド1本(`options` は `ADR-0090` の目的文が名指しした2値)。 */
function statusField(emphasis?: unknown): Record<string, unknown> {
  const field: Record<string, unknown> = {
    id: "payment_status",
    name: "決済状態",
    type: "select",
    options: ["入金済み", "決済できず"],
  };
  if (emphasis !== undefined) {
    field.emphasis = emphasis;
  }
  return field;
}

test("限定3: 意味の名前4値はそのまま通る", () => {
  const result = validateManifestFull(
    manifestWithField(statusField({ 入金済み: "info", 決済できず: "danger" })),
  );
  expect(result.valid).toBe(true);
});

test("限定3: 4値それぞれが単独でも通る(当たり先が4つあることの前提)", () => {
  for (const name of EMPHASIS_NAMES) {
    const result = validateManifestFull(manifestWithField(statusField({ 入金済み: name })));
    expect(result.valid, name).toBe(true);
  }
});

test("限定3: 5値目を書いた差分は拒否される", () => {
  for (const fifth of ["success", "warning", "error", "primary", "muted"]) {
    const result = validateManifest(manifestWithField(statusField({ 入金済み: fifth })));
    expect(result.valid, fifth).toBe(false);
  }
});

test("限定3: 色の実値も CSS 文字列も長さも1バイトも書けない", () => {
  for (const literal of [
    "#f00",
    "#ff0000",
    "red",
    "rgb(255,0,0)",
    "color: red",
    "background-color:#fff;",
    "1px",
    "bold",
  ]) {
    const result = validateManifest(manifestWithField(statusField({ 決済できず: literal })));
    expect(result.valid, literal).toBe(false);
  }
});

test("限定3: 値の側にオブジェクト・配列・数値・真偽値を書けない(実値の入口を1つも開けない)", () => {
  for (const value of [{ color: "#f00" }, ["danger"], 1, true, null]) {
    const result = validateManifest(manifestWithField(statusField({ 決済できず: value })));
    expect(result.valid, JSON.stringify(value)).toBe(false);
  }
});

test("限定3: 空の対応表({})は書けない(minProperties 1)", () => {
  expect(validateManifest(manifestWithField(statusField({}))).valid).toBe(false);
});

// --- (d) 限定4: select 型にだけ書ける(3経路とも差分全体を拒否する)----------------------

test("限定4: select 以外の7型に emphasis を書いたマニフェストは拒否される", () => {
  for (const type of FIELD_TYPES.filter((t) => t !== "select")) {
    const field: Record<string, unknown> = {
      id: "value",
      name: "値",
      type,
      emphasis: { 入金済み: "info" },
    };
    if (type === "reference") {
      field.reference_table = "order";
    }
    const result = validateManifest(manifestWithField(field));
    expect(result.valid, type).toBe(false);
  }
});

/** `add_field` / `add_table` の差分1本。**差分の時点で拒否されることを見る。** */
function diffWith(operations: unknown[]): unknown {
  return {
    diff_id: "d-emphasis-1",
    intent: "強調の宣言を試す",
    operations,
  };
}

test("限定4: add_field で number 型に emphasis を書いた差分は、差分の時点で全体が拒否される", () => {
  const result = validateDiff(
    diffWith([
      {
        op: "add_field",
        table: "order",
        field: { id: "total", name: "合計", type: "number", emphasis: { 入金済み: "info" } },
      },
    ]),
  );
  expect(result.valid).toBe(false);
});

test("限定4: add_table のフィールド定義に text 型 + emphasis を書いた差分も全体が拒否される", () => {
  const result = validateDiff(
    diffWith([
      {
        op: "add_table",
        table: {
          id: "memo",
          name: "メモ",
          fields: [{ id: "body", name: "本文", type: "text", emphasis: { a: "caution" } }],
        },
      },
    ]),
  );
  expect(result.valid).toBe(false);
});

function baseManifest(): Manifest {
  return {
    app: {
      id: "emphasis-shop",
      name: "強調の店",
      tables: [
        {
          id: "order",
          name: "注文",
          fields: [
            {
              id: "payment_status",
              name: "決済状態",
              type: "select",
              options: ["入金済み", "決済できず"],
            },
            { id: "memo", name: "メモ", type: "text" },
          ],
        },
      ],
      views: [{ id: "order-list", type: "list_view", table: "order", columns: ["payment_status"] }],
    },
  };
}

function fieldOf(manifest: Manifest, id: string): Field & { emphasis?: Record<string, string> } {
  const field = manifest.app.tables[0]?.fields.find((f) => f.id === id);
  if (field === undefined) {
    throw new Error(`フィールド ${id} が無い`);
  }
  return field;
}

test("限定4: change_field で select 以外の型に emphasis を書くと、名指しで拒否される", () => {
  const result = foldOperations(baseManifest(), [
    {
      op: "change_field",
      table: "order",
      field: "memo",
      changes: { emphasis: { 入金済み: "info" } },
    } as Operation,
  ]);
  expect(result.valid).toBe(false);
  if (result.valid) {
    return;
  }
  expect(result.errors[0]?.path).toBe("/operations/0/changes/emphasis");
  expect(result.errors[0]?.message).toContain("select");
});

test("限定4: 拒否された差分は部分適用されない(先行 op の変更も1バイトも残らない)", () => {
  // **op0 は単体なら通る変更である。** op1 が拒否されたら **差分全体が拒否され、
  // op0 の結果も残らない**(`ADR-0010` 限定7 と同じ側)。
  const before = baseManifest();
  const result = foldOperations(before, [
    { op: "change_field", table: "order", field: "memo", changes: { name: "備考" } } as Operation,
    {
      op: "change_field",
      table: "order",
      field: "memo",
      changes: { emphasis: { 入金済み: "info" } },
    } as Operation,
  ]);
  expect(result.valid).toBe(false);
  if (result.valid) {
    return;
  }
  // **戻り値にマニフェストが1つも入っていない** = 呼び出し元が書ける適用後の形が無い。
  expect("manifest" in result).toBe(false);
  // **入力のマニフェストも書き換わっていない。**
  expect(before.app.tables[0]?.fields[1]?.name).toBe("メモ");
});

test("限定4: add_field で emphasis つきの number を混ぜた差分は、適用後マニフェストの検証でも拒否される", () => {
  // **`applyDiff` は `foldOperations` の後で `validateManifestFull` を通す**(:1304)。
  // **そこで落ちる = ディスクには1バイトも書かれない。**
  const folded = foldOperations(baseManifest(), [
    { op: "add_field", table: "order", field: { id: "note", name: "注記", type: "text" } },
    {
      op: "add_field",
      table: "order",
      field: {
        id: "total",
        name: "合計",
        type: "number",
        emphasis: { 入金済み: "info" },
      } as unknown as Field,
    },
  ]);
  expect(folded.valid).toBe(true);
  if (!folded.valid) {
    return;
  }
  expect(validateManifestFull(folded.manifest).valid).toBe(false);
});

// --- (e) 限定4 後段: options に無い値をキーに書いたら拒否する ----------------------------

test("限定4 後段: options に無い値をキーに書いたマニフェストは拒否される", () => {
  const result = validateManifestFull(
    manifestWithField(statusField({ 入金済み: "info", 返金済み: "caution" })),
  );
  expect(result.valid).toBe(false);
  if (result.valid) {
    return;
  }
  const error = result.errors[0];
  expect(error?.path).toBe("/app/tables/0/fields/0/emphasis/返金済み");
  expect(error?.allowed_values).toEqual(["入金済み", "決済できず"]);
  expect(error?.message).toContain("返金済み");
});

test("限定4 後段: change_field で options に無いキーを書いた差分も、適用後の検証で拒否される", () => {
  const folded = foldOperations(baseManifest(), [
    {
      op: "change_field",
      table: "order",
      field: "payment_status",
      changes: { emphasis: { 返金済み: "caution" } },
    } as Operation,
  ]);
  expect(folded.valid).toBe(true);
  if (!folded.valid) {
    return;
  }
  const result = validateManifestFull(folded.manifest);
  expect(result.valid).toBe(false);
  if (result.valid) {
    return;
  }
  expect(result.errors[0]?.path).toBe("/app/tables/0/fields/0/emphasis/返金済み");
});

test("限定4 後段: options を先に足してからキーを書けば通る(検査は適用後マニフェストを見ている)", () => {
  const folded = foldOperations(baseManifest(), [
    {
      op: "change_field",
      table: "order",
      field: "payment_status",
      changes: {
        options: ["入金済み", "決済できず", "返金済み"],
        emphasis: { 返金済み: "caution" },
      },
    } as Operation,
  ]);
  expect(folded.valid).toBe(true);
  if (!folded.valid) {
    return;
  }
  expect(validateManifestFull(folded.manifest).valid).toBe(true);
});

// --- (f) 限定8 の裏: change_field で書いた値が適用後マニフェストに実際に残る ---------------

test("限定8 の裏: change_field で書いた emphasis が適用後マニフェストに残る(書けるが効かない、にしない)", () => {
  const result = foldOperations(baseManifest(), [
    {
      op: "change_field",
      table: "order",
      field: "payment_status",
      changes: { emphasis: { 決済できず: "danger" } },
    } as Operation,
  ]);
  expect(result.valid).toBe(true);
  if (!result.valid) {
    return;
  }
  expect(fieldOf(result.manifest, "payment_status").emphasis).toEqual({ 決済できず: "danger" });
});

test("限定8 の裏: emphasis を書いたフィールドに別のキーを change_field しても値が消えない", () => {
  const first = foldOperations(baseManifest(), [
    {
      op: "change_field",
      table: "order",
      field: "payment_status",
      changes: { emphasis: { 決済できず: "danger" } },
    } as Operation,
  ]);
  expect(first.valid).toBe(true);
  if (!first.valid) {
    return;
  }
  const second = foldOperations(first.manifest, [
    {
      op: "change_field",
      table: "order",
      field: "payment_status",
      changes: { name: "支払い状態" },
    } as Operation,
  ]);
  expect(second.valid).toBe(true);
  if (!second.valid) {
    return;
  }
  expect(fieldOf(second.manifest, "payment_status").emphasis).toEqual({ 決済できず: "danger" });
});

test("限定4: change_field で select → text にすると、引き継いだ emphasis は落ちる(適用後の形が valid のまま)", () => {
  // **`options` / `reference_table` / `unit` の既存の作法と同じである** —— 型が変わって
  // その型が持てないキーは消す。**これは「書けるが効かない」ではない** —— **この差分は
  // `emphasis` を1文字も書いていない。** 明示的に書いた `emphasis` は上の検査のとおり拒否される。
  const first = foldOperations(baseManifest(), [
    {
      op: "change_field",
      table: "order",
      field: "payment_status",
      changes: { emphasis: { 決済できず: "danger" } },
    } as Operation,
  ]);
  expect(first.valid).toBe(true);
  if (!first.valid) {
    return;
  }
  const second = foldOperations(first.manifest, [
    { op: "change_field", table: "order", field: "payment_status", changes: { type: "text" } },
  ]);
  expect(second.valid).toBe(true);
  if (!second.valid) {
    return;
  }
  expect(fieldOf(second.manifest, "payment_status").emphasis).toBeUndefined();
  expect(validateManifestFull(second.manifest).valid).toBe(true);
});

test("限定8: 書かなかったフィールドに emphasis キーは生えない(既定は「強調しない」)", () => {
  const result = foldOperations(baseManifest(), [
    { op: "change_field", table: "order", field: "payment_status", changes: { name: "支払い" } },
  ]);
  expect(result.valid).toBe(true);
  if (!result.valid) {
    return;
  }
  expect("emphasis" in fieldOf(result.manifest, "payment_status")).toBe(false);
});

// --- (g) 限定8: field_changes 側にも同じキーが在る --------------------------------------

test("限定8: field_changes.properties は 10 で、10キー目は emphasis である", () => {
  // **【V4-M19-T07 / ADR-0119 限定1 で 10 → 11 に更新した】** 11キー目 `hide_when_empty`
  // (定義は manifest 側の `$ref`)が加わった。**見る位置を `at(-1)`(末尾)から `[9]`
  // (10キー目)へ直した。末尾は今日 `hide_when_empty` だからである。**
  // **期待値を緩めていない**(位置は今日も1つに固定される)。**本 ADR の増分ではない。**
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
  expect(properties[8]).toBe("emphasis");
  // **定義を二重に持たない**(manifest 側を `$ref` する。`unit` / `unique` と同じ作法)。
  expect((readSchema("diff.schema.json").$defs.field_changes.properties.emphasis as Any).$ref).toBe(
    "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/field/properties/emphasis",
  );
});

// --- 限定5: 色の実値がマニフェストの語彙に1バイトも現れない -------------------------------

test("限定5: $defs/field に色・寸法・書体のキーが1つも無い(足したのは意味の名前である)", () => {
  const keys = Object.keys(readSchema("manifest.schema.json").$defs.field.properties);
  for (const forbidden of [
    "color",
    "theme",
    "style",
    "width",
    "align",
    "font",
    "format",
    "badge",
  ]) {
    expect(keys).not.toContain(forbidden);
  }
});
