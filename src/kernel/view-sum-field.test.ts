/**
 * **「一覧が表す集合の合計」の宣言**(`V4-M23-T01`。`ADR-0104` 限定1〜限定4・限定8〜限定11)。
 *
 * ## これは何で、何ではないか
 *
 * - **通したのは `sum` の1演算だけである**(`ADR-0104` 限定2)。**`avg` / `min` / `max` /
 *   `count(distinct)` / `median` を1つも書けない。** **演算の名前を書く場所そのものが
 *   スキーマに無い**(キー名が演算である)。
 * - **`group_by` を1バイトも開いていない**(限定8)—— **束ねるキーを指す語彙が1つも無い。**
 *   **`ADR-0007` §7a `:498` の F-7 の行を1ミリも動かしていない。**
 * - **集計値を `filter` / `sort` / `search_fields` の入力にしていない**(限定9)——
 *   **`having` を作っていない。**
 * - **`function.input`(`ADR-0024` 限定3)と `filter`(`ADR-0043`)を1バイトも動かしていない**
 *   (限定10)。
 * - **【禁止】「集計できるようになった」と総括しない** —— **書けるのは「一覧が今表している
 *   集合について、宣言した `number` 列1本の合計を1つの数として出す」までである。**
 *
 * ## 語彙の総量(**動いた分だけを、ここで数える**)
 *
 * `RESOURCE_KINDS` 7 / `FIELD_TYPES` 8 / `DIFF_OPS` 16 / `$defs` 28 /
 * `$defs/theme` 25・25 / `$defs/field` 12 —— **すべて着手前と同じである。**
 * **動いたのは `$defs/view` 27 → 28 と `$defs/view_changes` 21 → 22 の2本だけである。**
 *
 * ## 【本数の実測が限定表と食い違わない(今回は一致した)】
 *
 * **`ADR-0104` 限定1 は「27 → 28」と書いており、着手前の実測(2026-08-04)も 27 であった。**
 * **`ADR-0112` / `ADR-0113` / `ADR-0118` / `ADR-0102` のときと違い、今回は食い違いが無い。**
 * **食い違いが無いことも実測して書く**(`docs/plan/v4/records/v4-m23-impl.md` §3)。
 */

import { describe, expect, test } from "bun:test";
import diffSchema from "../../schemas/diff.schema.json" with { type: "json" };
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import { foldOperations } from "./apply-diff.ts";
import type { Field, ListView, Manifest, View } from "./types.ts";
import { DIFF_OPS } from "./types.ts";
import { validateManifest, validateManifestFull } from "./validate.ts";

/** 足したキーの名前。**1本だけである**(`ADR-0104` 限定1)。 */
const KEY = "sum_field";

function defs(): Record<string, { properties: Record<string, unknown>; required?: string[] }> {
  return (manifestSchema as unknown as { $defs: Record<string, never> }).$defs as never;
}

function viewSchema(): {
  properties: Record<string, unknown>;
  allOf: { if: unknown; then: { properties?: Record<string, unknown>; required?: string[] } }[];
} {
  return defs().view as never;
}

function viewChangesSchema(): { properties: Record<string, unknown> } {
  return (diffSchema as unknown as { $defs: Record<string, never> }).$defs.view_changes as never;
}

const FIELDS: Field[] = [
  { id: "memo", name: "メモ", type: "text" },
  { id: "body", name: "本文", type: "long_text" },
  { id: "qty", name: "数量", type: "number" },
  { id: "amount", name: "金額", type: "number" },
  { id: "done", name: "完了", type: "boolean" },
  { id: "due", name: "期限", type: "date" },
  { id: "status", name: "状態", type: "select", options: ["新規", "済"] },
  { id: "photo", name: "写真", type: "image" },
  // **役割の規則が名指ししている `number` 項目。** **`ADR-0112` 限定6 と同型の締めの当たり先。**
  // **【`V8-M20-T02` / 台帳 `J-G27` / `J-G28` / 手続きは `ADR-0301`。2026-08-10】**
  // **旧行の逐語**: `{ id: "cost", name: "原価", type: "number", audience: ["owner"] }`
  // (前半のコメントの旧逐語は「**`audience` を宣言した `number` 項目。**」)。
  // **`audience` は廃止された**(判定 = 廃止)。**同じ問いを、代わりに立った面
  // (`app.roles[].rules`)について問い直してある** —— **下の `ROLES` が `target: "field"`
  // でこの項目を名指ししている。**
  { id: "cost", name: "原価", type: "number" },
];

/**
 * **役割の規則が `cost` を名指ししている宣言**(`V8-M20-T02`)。
 *
 * **既定の3本(`owner` / `editor` / `viewer`)を必ず含める** —— **`set_roles` は全体差し替え
 * であり、既定を落とした宣言は適用時検査が拒否する**(`V8-M17` / 台帳 `J-G2`)。
 */
const ROLES = [
  {
    id: "owner",
    name: "運営",
    rules: [
      // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
      { target: "app", can: ["write"] },
      { target: "role", can: ["write"] },
      { target: "field", table: "orders", field: "cost", can: ["read"] },
    ],
  },
  { id: "editor", name: "編集" },
  { id: "viewer", name: "閲覧" },
];

function baseManifest(views: View[], fields: Field[] = FIELDS): Manifest {
  return {
    app: {
      id: "shop",
      name: "店",
      tables: [{ id: "orders", name: "注文", fields }],
      views,
      roles: ROLES,
    },
  } as unknown as Manifest;
}

/** `validateManifestFull` の失敗形からエラー配列を取り出す(型を絞る)。 */
function errorsOf(result: ReturnType<typeof validateManifestFull>): { message: string }[] {
  return result.valid ? [] : result.errors;
}

function listView(overrides: Partial<ListView> = {}): View {
  return {
    id: "order-list",
    type: "list_view",
    table: "orders",
    columns: ["memo"],
    ...overrides,
  } as unknown as View;
}

// ---------------------------------------------------------------------------
// 限定1: 足すキーは `$defs/view` に1本だけ。`$defs` の本数28 を1つも増やさない
// ---------------------------------------------------------------------------

describe("(T01-1) 語彙の総量(ADR-0104 限定1)", () => {
  // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。ADR = `0359` §4b。題名の数を直した】**
  // **旧名の逐語**: `$defs/view の properties は今日 30本で、その27本目(添字26)が本キーである`
  test("$defs/view の properties は今日 31本で、その27本目(添字26)が本キーである", () => {
    const keys = Object.keys(viewSchema().properties);
    // **【`V6-M2-T01` / `K-G2` / `ADR-0289` 限定1 で 28 → 29 に更新した】** 29キー目 `reference_pickers`
    // (参照項目の選び方の、入力画面ごとの上書き)が門A を通って増えた(`V6-M0` 単位A。判定 = 限定採用)。
    // **`form` 型のビューでだけ書ける。****本 ADR の増分ではない。**
    // **【`V8-M20-T01` / 台帳 `J-G27` / 手続きは `ADR-0301` で 29 → 28 に更新した】** 19キー目
    // だった `audience`(この画面を見せる相手)が**廃止された**(判定 = 廃止)。**代わりに担うのは
    // `app.roles[].rules` の「役割 × 対象(画面)× 読取」である。****旧値の逐語は 29。**
    // **このリポジトリで語彙が減ったのはこれが初めてであり、増分ではなく減分である。**
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 28 → 29 へ書き換えた。**
    // **旧行の逐語**: `expect(keys).toHaveLength(28);`
    // **書き換えた理由**: この行が固定していたのは「**その決定**が `$defs/view.properties` の本数 を増やさなかったこと」であり、
    // **29本目を足したのは別の決定である**(`V8-M8` が 集計表の宣言 `report` を29キー目として足した)。**検査は消していない。**
    // **【2026-08-20。`V10-M1-T02`。台帳 `NV-G4`。門A 本審査 = `V10-M0` 群A。ADR = `0359`】**
    // **期待値を 29 → 30 へ書き換えた。****旧行の逐語**: `expect(keys).toHaveLength(29);`
    // **30本目を足したのは別の決定である**(`ADR-0359` §4a 限定1 が削除後の行き先
    // `after_delete` を**末尾に**30キー目として足した)。**本キーの添字26 は1つも動いていない。**
    // **検査は消していない。****本 ADR の増分ではない。**
    // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
    // **期待値を 30 → 31 へ書き換えた。****旧行の逐語**: `expect(keys).toHaveLength(30);`
    // **31本目を足したのは別の決定である**(`ADR-0359` §4b 限定1 が一続きの流れの中の段
    // `flow` を**末尾に**31キー目として足した。**`list_view` / `form` / `detail_view` の3種別で
    // 書け、集計表(`report_view`)には書けない**)。
    // **本ファイルが測っている決定の増分ではない。****検査は消していない。**
    expect(keys).toHaveLength(31);
    expect(keys).toContain(KEY);
    // **27キー目までの並びを1バイトも動かしていない**(末尾に足した)。
    // **【`V8-M20-T01` / 台帳 `J-G27` / `ADR-0301` で見る位置を1つ手前へ直した】** **19キー目だった
    // `audience` が廃止されたので、それより後ろのキーの添字が1つずつ繰り上がった。**
    // **期待値を緩めていない**(位置は今日も1つに固定される)。
    expect(keys[26]).toBe(KEY);
  });

  // 【`V5-M29-T04` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
  //   消したテスト名(逐語): 「$defs の本数 28 が1つも増えていない(新しい $defs を作らない)」
  //   そのブロックが測っていたもの:
  //     - $defs の本数 28 が1つも増えていない(新しい $defs を作らない)
  //   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `manifest.$defs:` で始まる行)。
  //   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
  //   検出力0のまま `Ran` を水増しする)。
  //   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。

  // **【`V5-M29-T04` / `ADR-0250` 限定14 がテスト名を更新した】** 旧名(逐語)は
  // 「**$defs/theme 25・25 / $defs/field 12 / RESOURCE_KINDS 7 / FIELD_TYPES 8 / DIFF_OPS 16 が1つも動かない**」。
  // **`RESOURCE_KINDS` / `FIELD_TYPES` / `DIFF_OPS` の総量を固定していた3件を中央へ移したので、
  // この test に残るのは `$defs/theme` と `$defs/field`(どちらも8主題の外)だけである。**
  test("$defs/theme 25・25 / $defs/field 12 が1つも動かない", () => {
    expect(Object.keys(defs().theme?.properties ?? {})).toHaveLength(25);
    expect(defs().theme?.required ?? []).toHaveLength(25);
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
    expect(Object.keys(defs().field?.properties ?? {})).toHaveLength(12);
    // 【`V5-M29-T04` / `ADR-0250` 限定11】ここにあった「$defs/theme 25・25 / $defs/field 12 / RESOURCE_KINDS 7 / FIELD_TYPES 8 / DIFF_OPS 16 が1つも動かない」の検査は
    //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
    //   `RESOURCE_KINDS:` で始まる行)。**総量ではなく名前と順序で見張る。**
    //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
    // 【`V5-M29-T04` / `ADR-0250` 限定11】ここにあった「$defs/theme 25・25 / $defs/field 12 / RESOURCE_KINDS 7 / FIELD_TYPES 8 / DIFF_OPS 16 が1つも動かない」の検査は
    //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
    //   `FIELD_TYPES:` で始まる行)。**総量ではなく名前と順序で見張る。**
    //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
    // 【`V5-M29-T04` / `ADR-0250` 限定11】ここにあった「$defs/theme 25・25 / $defs/field 12 / RESOURCE_KINDS 7 / FIELD_TYPES 8 / DIFF_OPS 16 が1つも動かない」の検査は
    //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
    //   `DIFF_OPS:` で始まる行)。**総量ではなく名前と順序で見張る。**
    //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  });

  test("$defs/view_changes は 21 → 22 になり、22本目が本キーである", () => {
    const keys = Object.keys(viewChangesSchema().properties);
    // **【`V6-M2-T02` / `K-G3` / `ADR-0289` 限定1 で 23 → 24 に更新した】** 24キー目 `reference_pickers`
    // (参照項目の選び方の、入力画面ごとの上書き。`form` でだけ書ける)が `update_view` にも加わった
    // (値は `applyViewChanges` の `form` 分岐が実際に運ぶ)。**本 ADR の増分ではない。**
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 24 → 25 へ書き換えた。**
    // **旧行の逐語**: `expect(keys).toHaveLength(24);`
    // **書き換えた理由**: この行が固定していたのは「**その決定**が `view_changes.properties` の本数 を増やさなかったこと」であり、
    // **25本目を足したのは別の決定である**(`V8-M8` が 集計表の宣言 `report` を25キー目として足した)。**検査は消していない。**
    // **【2026-08-20。`V10-M1-T02`。台帳 `NV-G4`。ADR = `0359`】期待値を 25 → 26 へ書き換えた。**
    // **旧行の逐語**: `expect(keys).toHaveLength(25);`
    // **26本目を足したのは別の決定である**(`ADR-0359` §Decision 2 が `after_delete` を
    // `view_changes` の**末尾に**足した)。**本キーの添字21 は1つも動いていない。**
    // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
    // **期待値を 26 → 27 へ書き換えた。****旧行の逐語**: `expect(keys).toHaveLength(26);`
    // **27本目を足したのは別の決定である**(`flow` を `view_changes` の末尾に足した。
    // `ADR-0359` §Decision 2)。**本ファイルが測っている決定の増分ではない。**
    // **検査は消していない。**
    expect(keys).toHaveLength(27);
    expect(keys[21]).toBe(KEY);
  });
});

// ---------------------------------------------------------------------------
// 限定2: 演算は合計(`sum`)の1種だけ。2つ目の演算を足さない
// ---------------------------------------------------------------------------

describe("(T01-2) 演算は合計の1種だけ(ADR-0104 限定2)", () => {
  test("2つ目の演算を書く場所がスキーマに1つも無い", () => {
    const keys = Object.keys(viewSchema().properties);
    for (const forbidden of [
      "avg_field",
      "average_field",
      "min_field",
      "max_field",
      "count_field",
      "median_field",
      "aggregate",
      "aggregates",
      "aggregation",
      "summary",
    ]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  test("演算の名前を値として書く口が無い(値はフィールドID 1本だけ)", () => {
    const property = viewSchema().properties[KEY] as Record<string, unknown>;
    // **値域は既存の `resource_id` への `$ref` 1本だけである** —— `op` / `operator` /
    // `function` を持つオブジェクトではなく、`enum` も `oneOf` も持たない。
    expect(property.$ref).toBe("#/$defs/resource_id");
    for (const forbidden of ["type", "enum", "oneOf", "anyOf", "properties", "items"]) {
      expect(property[forbidden], forbidden).toBeUndefined();
    }
  });

  test("演算名を書いたオブジェクトは拒否される", () => {
    for (const value of [
      { op: "sum", field: "qty" },
      { field: "qty" },
      ["qty"],
      { avg: "qty" },
      42,
      true,
      null,
    ]) {
      expect(
        validateManifest(baseManifest([listView({ [KEY]: value } as never)])).valid,
        JSON.stringify(value),
      ).toBe(false);
    }
  });

  /*
   * **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`。テスト名は1バイトも
   * 書き換えていない】**
   *
   * **`"group_by"` は今日、スキーマに在る** —— **`$defs/report`(集計表の中身)の
   * 必須キーの1つである。** **`ADR-0104` 限定8「`group_by` を1バイトも開いていない」は
   * `sum_field` についての言明であり、それは今日も真である**(`sum_field` の値域は今日も
   * `resource_id` への `$ref` 1本だけで、束ねるキーを書く場所を持たない —— すぐ上の2本の
   * test がそれを測っている)。**開いたのは別の決定であり、別のキー(`report`)の中である。**
   *
   * **本体をこう書き換えた**:
   *  - **`"avg"` / `"having"` / `"group by"` の3語は、今日もスキーマ全文に1つも無い**
   *    (**この3語についての主張は1ミリも弱めていない**)。
   *  - **`"group_by"` は `$defs/report` の中にだけ在る** —— **`$defs/report` を落とした
   *    残り全部には今日も1つも無いことを、機械で確かめている。**
   *
   * **旧行の逐語**:
   * `    for (const forbidden of ['"avg"', '"group_by"', '"having"', '"group by"']) {`
   * `      expect(source, forbidden).not.toContain(forbidden);`
   * `    }`
   */
  test("スキーマ全文に avg / group_by / having の語が1つも無い", async () => {
    const source = await Bun.file(
      new URL("../../schemas/manifest.schema.json", import.meta.url),
    ).text();
    for (const forbidden of ['"avg"', '"having"', '"group by"']) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    // **`group_by` は `$defs/report` の中にだけ在る。**
    const schema = JSON.parse(source) as { $defs: Record<string, unknown> };
    expect(
      Object.keys((schema.$defs.report as { properties: Record<string, unknown> }).properties),
    ).toContain("group_by");
    const { report: _report, ...rest } = schema.$defs;
    expect(JSON.stringify({ ...schema, $defs: rest })).not.toContain('"group_by"');
  });
});

// ---------------------------------------------------------------------------
// 限定3: 対象は `number` 型のフィールドだけ(`ADR-0086` 限定4 と同型の適用時検査)
// ---------------------------------------------------------------------------

describe("(T01-3) 対象は number 型だけ(ADR-0104 限定3)", () => {
  test("number 型を指した宣言は通る", () => {
    const result = validateManifestFull(baseManifest([listView({ [KEY]: "qty" } as never)]));
    expect(result.valid, JSON.stringify(errorsOf(result))).toBe(true);
  });

  test("number 以外の7型を指した差分は全体が拒否される", () => {
    for (const fieldId of ["memo", "body", "done", "due", "status", "photo"]) {
      const result = validateManifestFull(baseManifest([listView({ [KEY]: fieldId } as never)]));
      expect(result.valid, fieldId).toBe(false);
      expect(
        errorsOf(result).some((error) => error.message.includes("合計")),
        fieldId,
      ).toBe(true);
    }
  });

  test("存在しないフィールドを指した差分は拒否される(参照整合性)", () => {
    const result = validateManifestFull(baseManifest([listView({ [KEY]: "nope" } as never)]));
    expect(result.valid).toBe(false);
  });

  test("reference 型を指した差分も拒否される", () => {
    const fields: Field[] = [
      { id: "memo", name: "メモ", type: "text" },
      { id: "ref", name: "参照", type: "reference", reference_table: "orders" } as unknown as Field,
    ];
    const result = validateManifestFull(
      baseManifest([listView({ [KEY]: "ref" } as never)], fields),
    );
    expect(result.valid).toBe(false);
  });

  /**
   * **【限定表を越えて締めた1点。正直に書く】**
   *
   * **`ADR-0104` 限定3 は「`number` 型だけ・実在すること」しか要求していない。**
   * **本実装はそれに加えて「役割の規則が名指しした項目は合計の対象にできない」を課した** ——
   * **`ADR-0112` 限定6 が `search_fields` に課したのと同型の締めである。**
   * **理由**: 合計は行ごとの伏せ字を通らない1つの数であり、
   * **見えない列の合計だけが見える**という形になる。**開く側ではなく閉じる側の差である。**
   *
   * **【`V8-M20-T02` / 台帳 `J-G27` / `J-G28` / 手続きは `ADR-0301`。2026-08-10】**
   * **旧テスト名(逐語)**: 「**audience を宣言した number 項目は合計の対象にできない
   * (ADR-0112 限定6 と同型の締め)**」。**旧本体の逐語**:
   * `expect(errorsOf(result).some((error) => error.message.includes("audience"))).toBe(true);`
   * **上の段落の旧逐語は「`audience` を宣言した項目は合計の対象にできない」/「合計は行の
   * 射影(`projectForFieldAudience`)を通らない1つの数」だった。**
   * **`audience` は廃止された。****検査は撤去していない** —— **同じ問いを、代わりに立った面
   * (`app.roles[].rules` が `target: "field"` でその項目を名指ししているか)について
   * 問い直してある。****旧文を1バイトも消していない。**
   */
  test("役割の規則が名指しした number 項目は合計の対象にできない(ADR-0112 限定6 と同型の締め)", () => {
    const result = validateManifestFull(baseManifest([listView({ [KEY]: "cost" } as never)]));
    expect(result.valid).toBe(false);
    expect(errorsOf(result).some((error) => error.message.includes("役割の規則"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 限定4: `list_view` のときだけ書ける(`detail_view` / `form` では `false`)
// ---------------------------------------------------------------------------

describe("(T01-4) 書けるのは list_view だけ(ADR-0104 限定4)", () => {
  test("form / detail_view の分岐で false になっている", () => {
    const branches = viewSchema().allOf;
    for (const type of ["form", "detail_view"]) {
      const branch = branches.find(
        (candidate) =>
          ((candidate.if as { properties?: { type?: { const?: string } } }).properties?.type
            ?.const ?? "") === type,
      );
      expect(branch?.then.properties?.[KEY], type).toBe(false);
    }
  });

  test("分岐は oneOf / anyOf ではなく allOf + if/then である", () => {
    const schema = viewSchema() as unknown as Record<string, unknown>;
    expect(Array.isArray(schema.allOf)).toBe(true);
    expect(schema.oneOf).toBeUndefined();
    expect(schema.anyOf).toBeUndefined();
  });

  test("detail_view に書いた宣言は拒否される", () => {
    const view = {
      id: "order-detail",
      type: "detail_view",
      table: "orders",
      fields: ["memo"],
      [KEY]: "qty",
    } as unknown as View;
    expect(validateManifest(baseManifest([view])).valid).toBe(false);
  });

  test("form に書いた宣言は拒否される", () => {
    const view = {
      id: "order-form",
      type: "form",
      table: "orders",
      fields: ["memo"],
      [KEY]: "qty",
    } as unknown as View;
    expect(validateManifest(baseManifest([view])).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 限定8: `group_by` を1つも足さない
// ---------------------------------------------------------------------------

describe("(T01-8) group_by を1バイトも開いていない(ADR-0104 限定8)", () => {
  test("束ねるキーを指す語彙がスキーマに1つも無い", () => {
    const keys = [
      ...Object.keys(viewSchema().properties),
      ...Object.keys(viewChangesSchema().properties),
    ];
    for (const forbidden of ["group_by", "groupBy", "group", "bucket", "pivot", "breakdown"]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  test("$defs の名前にも束ねる語が1つも無い", () => {
    for (const name of Object.keys(defs())) {
      expect(name).not.toContain("group");
      expect(name).not.toContain("aggregate");
    }
  });
});

// ---------------------------------------------------------------------------
// 限定9: 集計値を `filter` / `sort` / `search_fields` の入力にしない(`having` を作らない)
// ---------------------------------------------------------------------------

describe("(T01-9) having を作っていない(ADR-0104 限定9)", () => {
  test("$defs/filter と $defs/sort の定義に本キーが1文字も出てこない", async () => {
    const source = await Bun.file(
      new URL("../../schemas/manifest.schema.json", import.meta.url),
    ).text();
    const schema = JSON.parse(source) as { $defs: Record<string, unknown> };
    for (const name of ["filter", "filter_node", "filter_condition", "sort"]) {
      const def = schema.$defs[name];
      if (def === undefined) {
        continue;
      }
      expect(JSON.stringify(def), name).not.toContain(KEY);
      expect(JSON.stringify(def), name).not.toContain("sum");
    }
  });

  test("search_fields の定義を1バイトも触っていない", () => {
    expect(viewSchema().properties.search_fields).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 8,
      uniqueItems: true,
    });
  });
});

// ---------------------------------------------------------------------------
// 限定10: `function.input` と `filter` を1バイトも動かさない
// ---------------------------------------------------------------------------

describe("(T01-10) function.input と filter が1バイトも動いていない(ADR-0104 限定10)", () => {
  test("$defs/function_input のキーが着手前のままである", () => {
    const keys = Object.keys(defs().function_input?.properties ?? {});
    expect(keys.sort()).toEqual(["source", "table", "via", "view"]);
  });

  test("$defs/function_input の $comment(クエリ言語を足さない)が1バイトも変わっていない", () => {
    const comment = (defs().function_input as unknown as { $comment: string }).$comment;
    expect(comment).toContain(
      "カーネルにクエリ言語 (where / filter / select / count / group_by) を1つも足さない",
    );
  });

  test("$defs/filter の葉演算子が5種のままである(ADR-0043 不可侵)", async () => {
    const source = await Bun.file(
      new URL("../../schemas/manifest.schema.json", import.meta.url),
    ).text();
    const schema = JSON.parse(source) as { $defs: Record<string, unknown> };
    // **葉の演算子名が増えていないこと** —— `sum` を葉に置いていない。
    expect(JSON.stringify(schema.$defs)).not.toContain('"sum":');
  });
});

// ---------------------------------------------------------------------------
// 限定11: 合計は読取専用の導出値である(書込経路を1本も作らない)
// ---------------------------------------------------------------------------

describe("(T01-11) 書込経路を1本も作っていない(ADR-0104 限定11)", () => {
  test("DIFF_OPS に集計専用の op を1つも足していない", () => {
    // 【`V5-M29-T04` / `ADR-0250` 限定11】ここにあった「DIFF_OPS に集計専用の op を1つも足していない」の検査は
    //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
    //   `DIFF_OPS:` で始まる行)。**総量ではなく名前と順序で見張る。**
    //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
    for (const op of DIFF_OPS) {
      expect(op).not.toContain("sum");
      expect(op).not.toContain("aggregate");
    }
  });

  test("$defs/operation.properties が8キーのままである(差分スキーマ側)", () => {
    const operation = (diffSchema as unknown as { $defs: Record<string, never> }).$defs
      .operation as unknown as { properties: Record<string, unknown> };
    // **【`V8-M16` / `J-G1b` / `D-V8-31`】期待値を 9 → 10 に書き換えた —— 10キー目 `roles` を足したため。検査は消していない。**
    // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】**
    // **旧(逐語)**: `expect(Object.keys(operation.properties)).toHaveLength(10);`
    // **`user_kinds` キーを撤去したので 10 → 9。**この検査が測る「書込経路を1本も作っていないこと」は1ミリも弱めていない。
    // **テスト名の「8キーのまま」は当時の逐語である**(テスト名は書き換えない)。
    expect(Object.keys(operation.properties)).toHaveLength(9); // 【`V5-M17b` / `ADR-0248` 限定4】8 → 9(`user_kinds` が9キー目)/【`V8-M16`】9 → 10(`roles` が10キー目)。**この行が固定していたのは「その決定がキーを足さなかったこと」であり、足したのは別の決定である。**
  });
});

// ---------------------------------------------------------------------------
// update_view で後から書ける(カーネルが値を実際に運ぶ = 「書けるが効かない」を作らない)
// ---------------------------------------------------------------------------

describe("(T01-a) update_view が値を実際に運ぶ(ADR-0086 限定4)", () => {
  test("add_view で書いた宣言がマニフェストに載る", () => {
    const folded = foldOperations(
      { app: { id: "shop", name: "店", tables: [], views: [] } } as never,
      [
        {
          op: "add_table",
          table: {
            id: "orders",
            name: "注文",
            fields: [{ id: "qty", name: "数量", type: "number" }],
          },
        },
        {
          op: "add_view",
          view: {
            id: "order-list",
            type: "list_view",
            table: "orders",
            name: "注文一覧",
            columns: ["qty"],
            sum_field: "qty",
          },
        },
      ] as never,
    );
    expect(folded.valid).toBe(true);
    const view = (folded as { manifest: Manifest }).manifest.app.views[0] as unknown as Record<
      string,
      unknown
    >;
    expect(view[KEY]).toBe("qty");
  });

  test("update_view で後から書ける(値が実際に運ばれる)", () => {
    const folded = foldOperations(
      { app: { id: "shop", name: "店", tables: [], views: [] } } as never,
      [
        {
          op: "add_table",
          table: {
            id: "orders",
            name: "注文",
            fields: [{ id: "qty", name: "数量", type: "number" }],
          },
        },
        {
          op: "add_view",
          view: {
            id: "order-list",
            type: "list_view",
            table: "orders",
            name: "注文一覧",
            columns: ["qty"],
          },
        },
        { op: "update_view", view: "order-list", changes: { sum_field: "qty" } },
      ] as never,
    );
    expect(folded.valid).toBe(true);
    const view = (folded as { manifest: Manifest }).manifest.app.views[0] as unknown as Record<
      string,
      unknown
    >;
    expect(view[KEY]).toBe("qty");
  });

  test("form / detail_view に update_view で書くことはできない", () => {
    const folded = foldOperations(
      { app: { id: "shop", name: "店", tables: [], views: [] } } as never,
      [
        {
          op: "add_table",
          table: {
            id: "orders",
            name: "注文",
            fields: [{ id: "qty", name: "数量", type: "number" }],
          },
        },
        {
          op: "add_view",
          view: {
            id: "order-form",
            type: "form",
            table: "orders",
            name: "注文入力",
            fields: ["qty"],
          },
        },
        { op: "update_view", view: "order-form", changes: { sum_field: "qty" } },
      ] as never,
    );
    expect(folded.valid).toBe(false);
  });
});
