/**
 * **「どの列を検索の対象にするか」の宣言**(`V4-M22-T01`。`ADR-0112` 限定1〜限定6・限定8・限定11・限定12)。
 *
 * ## これは何で、何ではないか
 *
 * - **通したのは「列の名前の配列」だけである**(限定4)。**演算子・比較・論理結合・条件式・
 *   関数呼び出し・文字列連結・ワイルドカードを1つも書けない。**
 * - **【禁止】「`filter` に実行時解決が入るようになった」と読まない** —— **`ADR-0064` 限定4 は
 *   1バイトも引き直していない。** **検索語はマニフェストに1バイトも入らず、読取API の
 *   リクエスト引数として渡る**(`ADR-0112` §Decision 2)。
 * - **【禁止】「検索できるようになった」と総括しない** —— **書けるのは「宣言した `text` /
 *   `long_text` の列について、利用者が打った1つの語の部分一致で絞り込める」までである**
 *   (`ADR-0112` Consequences)。
 * - **【禁止】「既知の穴が塞がった」と読まない** —— **`docs/plan/v4/records/v4-fix1-boundary-bypass.md`
 *   §2 (d) の5件は今日も5件である。** **限定6 が止めるのは「新しい口が同じ穴を広げること」だけ。**
 *
 * ## 語彙の総量(**1つも動かしていないことを、ここで数える**)
 *
 * `RESOURCE_KINDS` 7 / `FIELD_TYPES` 8 / `DIFF_OPS` 16 / `$defs` 28 /
 * `$defs/theme` 25・25 / `$defs/field` 11 —— **すべて着手前と同じである。**
 *
 * ## 【本数の実測が限定表と食い違う】
 *
 * **`ADR-0112` 限定1 は「`view.properties` を 22 → 23 にする」/ 限定2 は
 * 「`view_changes.properties` を 16 → 17」と書いている。** **その数値は `$defs/view` が 22
 * だった 2026-08-03 の `3f46121` 時点の実測である**(`ADR-0112` §限界8 が逐語で
 * 「**実装時に数え直すこと**」と課している)。
 * **`V4-M18`(`ADR-0095` の `modal`)が先に main へ入ったので、本タスクの着手前の実測は
 * `$defs/view` = **23** / `view_changes` = **17** である。**
 * **したがって本タスクの増分は 23 → 24 / 17 → 18 である** —— **守ったのは「1本だけ足す」
 * という増分であって、限定表が書いた絶対値ではない。** **`ADR-0112` の本文を1バイトも
 * 書き換えていない**(食い違いの記録は `docs/plan/v4/records/v4-m22-impl.md` が持つ)。
 */

import { describe, expect, test } from "bun:test";
import diffSchema from "../../schemas/diff.schema.json" with { type: "json" };
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import { foldOperations } from "./apply-diff.ts";
import type { Field, ListView, Manifest, View } from "./types.ts";
import { validateManifest, validateManifestFull } from "./validate.ts";

/** 足したキーの名前。**1本だけである**(`ADR-0112` 限定1)。 */
const KEY = "search_fields";

function defs(): Record<string, { properties: Record<string, unknown>; required?: string[] }> {
  return (manifestSchema as unknown as { $defs: Record<string, never> }).$defs as never;
}

function viewSchema(): {
  properties: Record<string, unknown>;
  allOf: { if: unknown; then: { properties?: Record<string, unknown>; required?: string[] } }[];
} {
  return defs().view as never;
}

const FIELDS: Field[] = [
  { id: "memo", name: "メモ", type: "text" },
  { id: "body", name: "本文", type: "long_text" },
  { id: "qty", name: "数量", type: "number" },
  { id: "done", name: "完了", type: "boolean" },
  { id: "due", name: "期限", type: "date" },
  { id: "status", name: "状態", type: "select", options: ["新規", "済"] },
  { id: "photo", name: "写真", type: "image" },
  // **役割の規則が名指ししている項目。****限定6 の当たり先である。**
  // **【`V8-M20-T02` / 台帳 `J-G27` / `J-G28` / 手続きは `ADR-0301`。2026-08-10】**
  // **旧行の逐語**: `{ id: "secret", name: "秘密メモ", type: "text", audience: ["owner"] }`
  // (前半のコメントの旧逐語は「**`audience` を宣言した項目**(`ADR-0071`)」)。
  // **`audience` は廃止された**(判定 = 廃止)。**同じ問いを、代わりに立った面
  // (`app.roles[].rules`)について問い直してある** —— **下の `ROLES` が
  // `target: "field"` でこの項目を名指ししている。**
  { id: "secret", name: "秘密メモ", type: "text" },
];

/**
 * **役割の規則が `secret` を名指ししている宣言**(`V8-M20-T02`)。
 *
 * **既定の3本(`owner` / `editor` / `viewer`)を必ず含める** —— **`set_roles` は全体差し替え
 * であり、既定を落とした宣言は適用時検査が拒否する**(`V8-M17` / 台帳 `J-G2`)。
 * **名指ししているのは1本だけである** —— **`can` の中身も条件も、この検査は1バイトも見ない。**
 */
const ROLES = [
  {
    id: "owner",
    name: "運営",
    rules: [
      // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(類型17 の拡張)。
      { target: "app", can: ["write"] },
      { target: "role", can: ["write"] },
      { target: "field", table: "orders", field: "secret", can: ["read"] },
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
// 限定1 / 限定11: 足すキーは `$defs/view` に1本だけ / 語彙の総量は1つも動かない
// ---------------------------------------------------------------------------

describe("(T01-1) 語彙の総量(ADR-0112 限定1 / 限定11)", () => {
  // **【V4-M22-T05 / ADR-0113 限定1 で 24 → 25 に更新した】** 門A の本審査(V4-M22 単位C。
  // **4回目の審査**。判定 = 限定採用)が25キー目 `page_size`(1ページに出す件数)を足した。
  // **本 ADR の増分ではない。**
  // **【V4-M19-T03 / ADR-0118 限定1 で 25 → 26 に更新した】** 26キー目 `preset_density`
  // (画面の詰まり具合)が門A を通って増えた(V4-M19 単位C。2回目の審査。判定 = 限定採用)。
  // **3種すべてに書けるキーである。****本 ADR の増分ではない。**
  // **【V4-M20-T04 / ADR-0102 限定1 で 26 → 27 に更新した】** 27キー目 `after_save`
  // (保存が成立したあとに行く画面のID)が門A を通って増えた(V4-M20 単位D。2回目の審査。
  // 判定 = 限定採用)。**form 型のビューでだけ書ける。****本 ADR の増分ではない。**
  // **【V4-M23-T01 / ADR-0104 限定採用で 27 → 28 に更新した】** 28キー目 `sum_field`
  // (合計を出す列)が門A を通って増えた。**`list_view` でだけ書ける。****本 ADR の増分では
  // ない。****`search_fields` が24キー目であることは今日も真である。**
  test("$defs/view の properties が25本になり、その25本目が本キーである(限定表の 22 → 23 は modal が入る前の値)", () => {
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
    // `after_delete` を**末尾に**30キー目として足した。**`detail_view` でだけ書ける**)。
    // **本ファイルが測っている決定の増分ではない。****検査は消していない。**
    // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
    // **期待値を 30 → 31 へ書き換えた。****旧行の逐語**: `expect(keys).toHaveLength(30);`
    // **31本目を足したのは別の決定である**(`ADR-0359` §4b 限定1 が一続きの流れの中の段
    // `flow` を**末尾に**31キー目として足した。**`list_view` / `form` / `detail_view` の3種別で
    // 書け、集計表(`report_view`)には書けない**)。
    // **本ファイルが測っている決定の増分ではない。****検査は消していない。**
    expect(keys).toHaveLength(31);
    expect(keys).toContain(KEY);
    // **23キー目までの並びを1バイトも動かしていない**(末尾に足した)。
    // **【`V8-M20-T01` / 台帳 `J-G27` / `ADR-0301` で見る位置を1つ手前へ直した】** **19キー目だった
    // `audience` が廃止されたので、それより後ろのキーの添字が1つずつ繰り上がった。**
    // **期待値を緩めていない**(位置は今日も1つに固定される)。
    expect(keys[22]).toBe(KEY);
  });

  // 【`V5-M29-T04` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
  //   消したテスト名(逐語): 「$defs の本数 28 が1つも増えていない(新しい $defs を作らない = 限定4 後半)」
  //   そのブロックが測っていたもの:
  //     - $defs の本数 28 が1つも増えていない(新しい $defs を作らない = 限定4 後半)
  //   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `manifest.$defs:` で始まる行)。
  //   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
  //   検出力0のまま `Ran` を水増しする)。
  //   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。

  // **【`V5-M29-T04` / `ADR-0250` 限定14 がテスト名を更新した】** 旧名(逐語)は
  // 「**$defs/theme 25・25 / $defs/field 11 / RESOURCE_KINDS 7 / FIELD_TYPES 8 / DIFF_OPS 16 が1つも動かない**」。
  // **`RESOURCE_KINDS` / `FIELD_TYPES` / `DIFF_OPS` の総量を固定していた3件を中央へ移したので、
  // この test に残るのは `$defs/theme` と `$defs/field`(どちらも8主題の外)だけである。**
  // **旧名の `$defs/field 11` は、消す前から本体が 12 を測っており食い違っていた。**
  test("$defs/theme 25・25 / $defs/field 12 が1つも動かない", () => {
    expect(Object.keys(defs().theme?.properties ?? {})).toHaveLength(25);
    expect(defs().theme?.required ?? []).toHaveLength(25);
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
    expect(Object.keys(defs().field?.properties ?? {})).toHaveLength(12);
    // 【`V5-M29-T04` / `ADR-0250` 限定11】ここにあった「$defs/theme 25・25 / $defs/field 11 / RESOURCE_KINDS 7 / FIELD_TYPES 8 / DIFF_OPS 16 が1つも動かない」の検査は
    //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
    //   `RESOURCE_KINDS:` で始まる行)。**総量ではなく名前と順序で見張る。**
    //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
    // 【`V5-M29-T04` / `ADR-0250` 限定11】ここにあった「$defs/theme 25・25 / $defs/field 11 / RESOURCE_KINDS 7 / FIELD_TYPES 8 / DIFF_OPS 16 が1つも動かない」の検査は
    //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
    //   `FIELD_TYPES:` で始まる行)。**総量ではなく名前と順序で見張る。**
    //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
    // 【`V5-M29-T04` / `ADR-0250` 限定11】ここにあった「$defs/theme 25・25 / $defs/field 11 / RESOURCE_KINDS 7 / FIELD_TYPES 8 / DIFF_OPS 16 が1つも動かない」の検査は
    //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
    //   `DIFF_OPS:` で始まる行)。**総量ではなく名前と順序で見張る。**
    //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  });

  test("件数・ページ位置のキーを1本も足していない(それは ADR-0113 の射程である = 限定11)", () => {
    const keys = Object.keys(viewSchema().properties);
    for (const forbidden of ["offset", "page", "limit", "cursor"]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  test("sort を1バイトも触っていない(限定11)", () => {
    expect(viewSchema().properties.sort).toEqual({ $ref: "#/$defs/sort" });
  });
});

// ---------------------------------------------------------------------------
// 限定4: 値は「対象テーブルに実在するフィールドIDの配列」だけ・長さは1以上8以下
// ---------------------------------------------------------------------------

describe("(T01-4) 値は列の名前の配列だけ(ADR-0112 限定4)", () => {
  test("schema は array / items は $defs/resource_id / minItems 1 / maxItems 8 / uniqueItems", () => {
    const property = viewSchema().properties[KEY] as Record<string, unknown>;
    expect(property.type).toBe("array");
    expect(property.items).toEqual({ $ref: "#/$defs/resource_id" });
    expect(property.minItems).toBe(1);
    expect(property.maxItems).toBe(8);
    expect(property.uniqueItems).toBe(true);
  });

  test("空配列は拒否される", () => {
    expect(validateManifest(baseManifest([listView({ [KEY]: [] } as never)])).valid).toBe(false);
  });

  test("9本目は拒否される(上限8)", () => {
    const nine = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    expect(validateManifest(baseManifest([listView({ [KEY]: nine } as never)])).valid).toBe(false);
  });

  test("同じ列を2度書くと拒否される(uniqueItems)", () => {
    expect(
      validateManifest(baseManifest([listView({ [KEY]: ["memo", "memo"] } as never)])).valid,
    ).toBe(false);
  });

  test("演算子・条件式・ワイルドカード・オブジェクトを1つも書けない", () => {
    for (const value of [
      [{ field: "memo", operator: "contains" }],
      ["memo*"],
      ["memo OR body"],
      "memo",
      { memo: true },
      [1],
      [null],
    ]) {
      expect(
        validateManifest(baseManifest([listView({ [KEY]: value } as never)])).valid,
        JSON.stringify(value),
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 限定3: `list_view` 分岐でだけ許す
// ---------------------------------------------------------------------------

describe("(T01-3) 書けるのは list_view だけ(ADR-0112 限定3)", () => {
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

  test("list_view には書ける", () => {
    expect(validateManifestFull(baseManifest([listView({ [KEY]: ["memo"] } as never)]))).toEqual({
      valid: true,
    });
  });

  test("form に書くと差分全体が拒否される", () => {
    const result = validateManifest(
      baseManifest([
        {
          id: "order-form",
          type: "form",
          table: "orders",
          fields: ["memo"],
          [KEY]: ["memo"],
        } as unknown as View,
      ]),
    );
    expect(result.valid).toBe(false);
  });

  test("detail_view に書くと差分全体が拒否される", () => {
    const result = validateManifest(
      baseManifest([
        { id: "order-detail", type: "detail_view", table: "orders", [KEY]: ["memo"] } as never,
      ]),
    );
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 限定12: 書かなかった画面は今日と1バイトも変わらない(既定は「口を出さない」)
// ---------------------------------------------------------------------------

describe("(T01-12) 既定は「検索の口を出さない」(ADR-0112 限定12)", () => {
  test("本キーは必須ではなく、書かないマニフェストが今日どおり通る", () => {
    const required = (viewSchema() as unknown as { required?: string[] }).required ?? [];
    expect(required).not.toContain(KEY);
    expect(validateManifestFull(baseManifest([listView()]))).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// 限定5 / 限定6: 実在照合・型の対応・役割の規則が名指しした項目の禁止(拒否は「全か無か」)
// **【`V8-M20-T02` / 台帳 `J-G27` / `J-G28` / `ADR-0301`。2026-08-10】旧見出しの逐語は**
// **「限定5 / 限定6: 実在照合・型の対応・`audience` の名指し禁止(拒否は「全か無か」)」。**
// ---------------------------------------------------------------------------

describe("(T01-5) 実在しない列・text / long_text 以外の型を名指しすると差分全体が拒否される(ADR-0112 限定5)", () => {
  test("実在しないフィールドIDは拒否され、allowed_values が出る", () => {
    const result = validateManifestFull(baseManifest([listView({ [KEY]: ["nope"] } as never)]));
    expect(result.valid).toBe(false);
    const errors = (result as { errors: { path: string; allowed_values?: string[] }[] }).errors;
    expect(errors[0]?.path).toBe("/app/views/0/search_fields/0");
    expect(errors[0]?.allowed_values).toContain("memo");
  });

  test("text と long_text は書ける", () => {
    expect(
      validateManifestFull(baseManifest([listView({ [KEY]: ["memo", "body"] } as never)])),
    ).toEqual({ valid: true });
  });

  test("number / boolean / date / select / reference / image は拒否される", () => {
    for (const id of ["qty", "done", "due", "status", "photo"]) {
      const result = validateManifestFull(baseManifest([listView({ [KEY]: [id] } as never)]));
      expect(result.valid, id).toBe(false);
    }
  });

  test("reference も拒否される", () => {
    const fields: Field[] = [
      ...FIELDS,
      { id: "buyer", name: "客", type: "reference", reference_table: "orders" },
    ];
    const result = validateManifestFull(
      baseManifest([listView({ [KEY]: ["buyer"] } as never)], fields),
    );
    expect(result.valid).toBe(false);
  });

  test("拒否は「全か無か」である —— 1本でも違反していれば差分全体が通らない(ADR-0047 限定9)", () => {
    const result = validateManifestFull(
      baseManifest([listView({ [KEY]: ["memo", "qty"] } as never)]),
    );
    expect(result.valid).toBe(false);
  });
});

/*
 * **【`V8-M20-T02` / 台帳 `J-G27` / `J-G28` / 手続きは `ADR-0301`。2026-08-10】**
 * **旧 describe 名(逐語)**: 「**(T01-6) audience を宣言した項目を検索対象に書けない
 * (ADR-0112 限定6)**」。**旧テスト名(逐語)**: 「**audience つきフィールドを名指しした
 * 差分は全体が拒否される**」/「**audience つきは text 型であっても拒否される(型の検査を
 * 通り抜けない)**」/「**既知の穴を1件も塞いでいない —— view.filter には今日どおり
 * audience つきの列を書ける**」。
 *
 * **`audience` は廃止された。****検査は撤去していない** —— **同じ問いを、代わりに立った面
 * (`app.roles[].rules` が `target: "field"` でその項目を名指ししているか)について
 * 問い直してある。****理由の文(絞り込みの当たり外れから隠した項目の値が推測できる)は
 * 今日も真である。****旧文を1バイトも消していない。**
 */
describe("(T01-6) 役割の規則が名指しした項目を検索対象に書けない(ADR-0112 限定6 の置き直し)", () => {
  test("役割の規則が名指しした項目を書いた差分は全体が拒否される", () => {
    const result = validateManifestFull(baseManifest([listView({ [KEY]: ["secret"] } as never)]));
    expect(result.valid).toBe(false);
    const errors = (result as { errors: { path: string; message: string }[] }).errors;
    expect(errors[0]?.path).toBe("/app/views/0/search_fields/0");
    // **旧本体の逐語**: `expect(errors[0]?.message).toContain("audience");`
    expect(errors[0]?.message).toContain("役割の規則");
  });

  test("名指しされた項目は text 型であっても拒否される(型の検査を通り抜けない)", () => {
    const secret = FIELDS.find((field) => field.id === "secret");
    expect(secret?.type).toBe("text");
    expect(
      validateManifestFull(baseManifest([listView({ [KEY]: ["memo", "secret"] } as never)])).valid,
    ).toBe(false);
  });

  test("既知の穴を1件も塞いでいない —— view.filter には今日どおり名指しされた列を書ける", () => {
    // **`ADR-0071` 限定4 が「検索(`filter`)の挙動を1バイトも変えない」と明文で書いている。**
    // **【`V8-M20-T02`】その `ADR-0071` のキーは今日は存在しないが、穴は移っただけで
    // 塞がっていない** —— **役割の規則が名指しした項目でも `filter` は今日どおり書ける。**
    // **本タスクはその穴を塞いでいない。** **塞いでいないことを、ここで固定する** ——
    // 「塞いだ」と誤って書かないためである(`v4-fix1-boundary-bypass.md` §2 (d) の1)。
    expect(
      validateManifestFull(
        baseManifest([listView({ filter: { field: "secret", equals: "X" } } as never)]),
      ),
    ).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// 限定2: view_changes にも同じキーを1本 / カーネルが値を実際に運ぶ
// ---------------------------------------------------------------------------

describe("(T01-2) update_view で後から書けて、値が実際に運ばれる(ADR-0112 限定2)", () => {
  // **【V4-M22-T05 / ADR-0113 限定2 で 18 → 19 に更新した】** `update_view` にも19キー目
  // `page_size` が加わった(値は `applyViewChanges` の `list_view` 分岐が実際に運ぶ)。
  // **【V4-M19-T03 / ADR-0118 限定1 で 19 → 20 に更新した】** 20キー目 `preset_density`
  // (画面の詰まり具合)が門A を通って増えた(V4-M19 単位C。2回目の審査。判定 = 限定採用)。
  // **3種すべてに書けるキーである。****本 ADR の増分ではない。**
  // **【V4-M20-T04 / ADR-0102 限定2 で 20 → 21 に更新した】** 21キー目 `after_save` が
  // `update_view` にも加わった(値は `applyViewChanges` の `form` 分岐が実際に運ぶ)。
  // **本 ADR の増分ではない。**
  // **【V4-M23-T01 / ADR-0104 限定採用で 21 → 22 に更新した】** 22キー目 `sum_field`
  // (合計を出す列。`list_view` でだけ書ける)が `update_view` にも加わった(値は
  // `applyViewChanges` の `list_view` 分岐が実際に運ぶ)。**本 ADR の増分ではない。**
  test("diff.schema.json の view_changes が19本になっている(限定表の 16 → 17 は modal が入る前の値)", () => {
    const changes = (diffSchema as unknown as { $defs: { view_changes: { properties: object } } })
      .$defs.view_changes.properties;
    const keys = Object.keys(changes);
    // **【`V6-M2-T02` / `K-G3` / `ADR-0289` 限定1 で 23 → 24 に更新した】** 24キー目 `reference_pickers`
    // (参照項目の選び方の、入力画面ごとの上書き。`form` でだけ書ける)が `update_view` にも加わった
    // (値は `applyViewChanges` の `form` 分岐が実際に運ぶ)。**本 ADR の増分ではない。**
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 24 → 25 へ書き換えた。**
    // **旧行の逐語**: `expect(keys).toHaveLength(24);`
    // **書き換えた理由**: この行が固定していたのは「**その決定**が `view_changes.properties` の本数 を増やさなかったこと」であり、
    // **25本目を足したのは別の決定である**(`V8-M8` が 集計表の宣言 `report` を25キー目として足した)。**検査は消していない。**
    // **【2026-08-20。`V10-M1-T02`。台帳 `NV-G4`。ADR = `0359` §Decision 2】**
    // **期待値を 25 → 26 へ書き換えた。****旧行の逐語**: `expect(keys).toHaveLength(25);`
    // **26本目を足したのは別の決定である**(`after_delete` を `view_changes` の末尾に足した)。
    // **本ファイルが測っている決定の増分ではない。****検査は消していない。**
    // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
    // **期待値を 26 → 27 へ書き換えた。****旧行の逐語**: `expect(keys).toHaveLength(26);`
    // **27本目を足したのは別の決定である**(`flow` を `view_changes` の末尾に足した。
    // `ADR-0359` §Decision 2)。**本ファイルが測っている決定の増分ではない。**
    // **検査は消していない。**
    expect(keys).toHaveLength(27);
    expect(keys[17]).toBe(KEY);
    expect(keys[18]).toBe("page_size");
  });

  /** `applyDiff` と**同じ順序**で畳み込みと検証を行う(`modal-view.test.ts` と同じ形)。 */
  function fold(current: Manifest, changes: Record<string, unknown>, view = "order-list") {
    const folded = foldOperations(current, [{ op: "update_view", view, changes } as never]);
    if (!folded.valid) {
      return { valid: false as const, manifest: undefined };
    }
    const validated = validateManifestFull(folded.manifest);
    return validated.valid
      ? { valid: true as const, manifest: folded.manifest }
      : { valid: false as const, manifest: undefined };
  }

  test("値がマニフェストへ運ばれる(「キーは在るが効かない」穴を踏まない)", () => {
    const result = fold(baseManifest([listView()]), { [KEY]: ["memo", "body"] });
    expect(result.valid).toBe(true);
    const view = result.manifest?.app.views.find((candidate) => candidate.id === "order-list");
    expect((view as unknown as Record<string, unknown>)[KEY]).toEqual(["memo", "body"]);
  });

  test("update_view で form に書こうとすると拒否される", () => {
    const current = baseManifest([
      { id: "order-form", type: "form", table: "orders", fields: ["memo"] } as unknown as View,
    ]);
    expect(fold(current, { [KEY]: ["memo"] }, "order-form").valid).toBe(false);
  });

  test("update_view でも型の検査と役割の規則の検査が効く(add_view と同じ1箇所で判定する)", () => {
    expect(fold(baseManifest([listView()]), { [KEY]: ["qty"] }).valid).toBe(false);
    expect(fold(baseManifest([listView()]), { [KEY]: ["secret"] }).valid).toBe(false);
  });

  test("書かなかったキーは触られない(キー単位の差し替えである)", () => {
    const current = baseManifest([listView({ [KEY]: ["memo"] } as never)]);
    const result = fold(current, { name: "注文一覧" });
    expect(result.valid).toBe(true);
    const view = result.manifest?.app.views.find((candidate) => candidate.id === "order-list");
    expect((view as unknown as Record<string, unknown>)[KEY]).toEqual(["memo"]);
  });
});

// ---------------------------------------------------------------------------
// 限定8: `ADR-0064` 限定4 / `ADR-0043` 限定1〜6 を1バイトも引き直さない
// ---------------------------------------------------------------------------

describe("(T01-8) ADR-0064 限定4 / ADR-0043 限定1〜6 は不可侵(ADR-0112 限定8)", () => {
  test("葉演算子5種・ネスト深度上限8 が1バイトも動いていない", async () => {
    const source = await Bun.file(new URL("./records.ts", import.meta.url)).text();
    expect(source).toContain(
      'const LEAF_OPERATORS = ["equals", "contains", "gte", "lte", "in"] as const;',
    );
    expect(source).toContain("export const MAX_FILTER_DEPTH = 8;");
  });

  test("MAX_FILTER_DEPTH 〜 listRecords の区間に $record / older_than が1件も無い(既存の走査と同じ区間)", async () => {
    const source = await Bun.file(new URL("./records.ts", import.meta.url)).text();
    const start = source.indexOf("export const MAX_FILTER_DEPTH = 8;");
    const end = source.indexOf("export function listRecords(");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const region = source.slice(start, end);
    expect(region).not.toContain("$record");
    expect(region).not.toContain("older_than");
  });

  test("検索語をマニフェストに書く場所を1つも作っていない —— 本キーの値域に文字列の自由入力が無い", () => {
    const property = viewSchema().properties[KEY] as Record<string, unknown>;
    // 配列の要素は `resource_id`(`^[a-z][a-z0-9_-]*$` の1〜64文字)だけであり、
    // 検索語(任意の文字列)を書ける場所はここに1つも無い。
    expect(property.items).toEqual({ $ref: "#/$defs/resource_id" });
    expect(property.pattern).toBeUndefined();
    expect(property.enum).toBeUndefined();
  });
});
