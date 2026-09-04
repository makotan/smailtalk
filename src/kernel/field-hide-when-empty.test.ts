/**
 * 値が無いとき項目の行ごと出さないことを、アプリが項目ごとに宣言する
 * (`E-G17` / `D-V4-84` の一部。`V4-M19-T07` / `ADR-0119`)。
 *
 * **限定表の正は [`docs/adr/0119-field-hide-when-empty.md`](../../docs/adr/0119-field-hide-when-empty.md)
 * §Decision 3(限定1〜限定12)**、完了条件の正は
 * `docs/plan/v4/records/v4-m19.md` §2-1 の `V4-M19-T07` の行(3点)。
 *
 * ## このファイルが固定すること(カーネル側)
 *
 * 1. **限定1**: 足すキーは `$defs/field` に1本(`hide_when_empty`)だけ。
 *    **`$defs`(28)/ `$defs/theme`(25 / 25)/ `$defs/view.properties` は1つも動かない。**
 *    **`$defs/view` に1バイトも触らない** —— **画面ごとに出し分けを変えることはできない。**
 * 2. **限定2**: 値は真偽値1つ。**`enum` も `pattern` も `minLength` も書かない。**
 *    **条件式・比較・しきい値・`when` を1つも作らない。**
 * 3. **限定7**: `RESOURCE_KINDS`(7)/ `FIELD_TYPES`(8)/ `DIFF_OPS`(16)/
 *    `$defs/operation.properties`(8)が1つも動かない。**専用の op を作らない。**
 * 4. **限定8**: `ADR-0090` の `emphasis` と1バイトも重ならない(値域・書ける型・`allOf` の
 *    分岐を1つも変えない)。
 * 5. **限定6 の裏**: `change_field` で後から書けて、**値が適用後マニフェストに実際に残る**
 *    (`ADR-0076` の `writable_by` が作った「書けるが効かない」穴を繰り返さない)。
 *
 * ## 【本数の食い違いを隠さない】
 *
 * **`ADR-0119` Consequences は「`$defs/view.properties` 22(`ADR-0118` を実装するなら 23)」と
 * 書いているが、それは `modal` / `search_fields` / `page_size` が入る前の実測である。**
 * **今日の実数は 26 である**(`ADR-0118` の実装を含む)。
 * **`$defs/field.properties` の 11 → 12 と `field_changes` の 10 → 11 は限定表どおりである。**
 * **`ADR-0119` の本文を1バイトも書き換えていない。**
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * - **空文字 `""` には効かない。** **`web/src/fields/display.tsx` は空文字を「値がある」側に
 *   置いており、本キーはそれを1バイトも変えない**(`ADR-0119` 限定3)。
 * - **任意の条件で行を消すことはできない**(限定2)。**扱うのは「値が無い」の1条件だけである。**
 * - **描画の実測は `web/test/field-hide-when-empty.test.tsx` と chromium の担当である。**
 * - **アプリが「この項目は消してよい」と主張し、カーネルはその主張を1度も検証しない。**
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { foldOperations } from "./apply-diff.ts";
import type { Field, Manifest, Operation } from "./types.ts";
import { DIFF_OPS, FIELD_TYPES } from "./types.ts";
import { validateDiff, validateManifest } from "./validate.ts";

const ROOT = dirname(dirname(import.meta.dir));

// biome-ignore lint/suspicious/noExplicitAny: スキーマ JSON を素で読むための局所エイリアス。
type Any = any;

function readSchema(name: string): Any {
  return JSON.parse(readFileSync(join(ROOT, "schemas", name), "utf8")) as Any;
}

// --- (a) 増分の総量(限定1)-------------------------------------------------------------

test("限定1: $defs/field.properties は 12 で、12キー目は hide_when_empty である", () => {
  // **【V6-M1-T01 / K-G1 / ADR-0288 限定1 で 12 → 13 に更新した】** 13キー目 `reference_picker`
  // (他のテーブルから選ぶ項目の選び方)が門A を通って増えた(V6-M0 単位A。判定 = 限定採用)。
  // **見る位置を `at(-1)`(末尾)から `[11]`(12キー目)へ直した。末尾は今日
  // `reference_picker` だからである。** **期待値を緩めていない**(位置は今日も1つに固定される)。
  // **本 ADR の増分ではない。**
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
  expect(properties[9]).toBe("hide_when_empty");
});

test("限定1: field_changes.properties は 11 で、11キー目は hide_when_empty である", () => {
  // **【V6-M1-T02 / K-G4 / ADR-0288 限定10 で 11 → 12 に更新した】** 12個目のキー
  // `reference_picker`(定義は manifest 側の `$ref`)が加わった。**見る位置を `at(-1)`
  // (末尾)から `[10]`(11個目)へ直した。末尾は今日 `reference_picker` だからである。**
  // **期待値を緩めていない。****本 ADR の増分ではない。**
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
  expect(properties[9]).toBe("hide_when_empty");
  // **値域の定義を二重に持たない**(`unique` / `unit` / `emphasis` と同じ作法)。
  expect(
    (readSchema("diff.schema.json").$defs.field_changes.properties.hide_when_empty as Any).$ref,
  ).toBe(
    "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/field/properties/hide_when_empty",
  );
});

test("限定1: $defs/theme 25・25 が1つも動いていない", () => {
  const manifest = readSchema("manifest.schema.json");
  // 【`V5-M29-T03` / `ADR-0250` 限定11】ここにあった「$defs 28 が1つも動いていない」の検査は
  //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
  //   `manifest.$defs:` で始まる行)。**総量ではなく名前と順序で見張る。**
  //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  // 【`V5-M29-T03`】**テスト名を書き換えた。** 旧: 「限定1: $defs 28 / $defs/theme 25・25 が1つも動いていない」。
  //   本体から `$defs` の本数を測る `expect` が消えたため(記録 §4-7)。
  expect(Object.keys(manifest.$defs.theme.properties)).toHaveLength(25);
  expect(manifest.$defs.theme.required).toHaveLength(25);
});

test("限定1: $defs/view には1バイトも触っていない(画面ごとに出し分けを変えられない)", () => {
  const manifest = readSchema("manifest.schema.json");
  // **【本数の食い違いを隠さない】`ADR-0119` は 22(`ADR-0118` を実装するなら 23)と
  // 書いているが、今日の実数は 26 である**(`modal` / `search_fields` / `page_size` が
  // 先に入っている)。**本 ADR の増分は 0 である。**
  // **【V4-M20-T04 / ADR-0102 限定1 で 26 → 27 に更新した】** 27キー目 `after_save`
  // (保存が成立したあとに行く画面のID)が門A を通って増えた(V4-M20 単位D。2回目の審査。
  // 判定 = 限定採用)。**本 ADR(`ADR-0119`)の増分ではない。**
  // **【V4-M23-T01 / ADR-0104 限定1 で 27 → 28 に更新した】** 28キー目 `sum_field`
  // (合計を出す列。`list_view` でだけ書ける)が門A を通って増えた。
  // **本 ADR(`ADR-0119`)の増分ではない。**
  // 【`V5-M29-T03` / `ADR-0250` 限定11】ここにあった「$defs/view.properties は 28 のままである」の検査は
  //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
  //   `manifest.$defs.view.properties:` で始まる行)。**総量ではなく名前と順序で見張る。**
  //   **上の3つの【】が書き残した「22 / 26 / 27 / 28 へ動いた経緯」は、中央では追えない。**
  //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  expect(manifest.$defs.view.properties.hide_when_empty).toBeUndefined();
  expect(
    readSchema("diff.schema.json").$defs.view_changes.properties.hide_when_empty,
  ).toBeUndefined();
});

test("限定7: operation.properties 9 が動いていない(専用の op を作らない)", () => {
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
  // 【`V5-M29-T03`】**テスト名を書き換えた。** 旧: 「限定7: RESOURCE_KINDS 7 / FIELD_TYPES 8 / DIFF_OPS 16 / operation.properties 8 が動いていない」。
  //   本体から語彙3種を測る `expect` が消えたため(記録 §4-7)。**`FIELD_TYPES 8` / `DIFF_OPS 16` / `operation.properties 8` は
  //   消す前から本体が 9 / 17 / 9 を測っており、食い違っていた。**
  // **【`V8-M16` / `J-G1b` / `D-V8-31`】期待値を 9 → 10 に書き換えた —— 10キー目 `roles` を足したため。検査は消していない。**
  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】**
  // **旧(逐語)**: `expect(Object.keys(readSchema("diff.schema.json").$defs.operation.properties)).toHaveLength(10);`
  // **`user_kinds` キーを撤去したので 10 → 9。**この検査が測る「この決定がキーを足していないこと」は1ミリも弱めていない。
  expect(Object.keys(readSchema("diff.schema.json").$defs.operation.properties)).toHaveLength(9); // 【`V5-M17b` / `ADR-0248` 限定4】8 → 9(`user_kinds` が9キー目)/【`V8-M16`】9 → 10(`roles` が10キー目)。**この行が固定していたのは「その決定がキーを足さなかったこと」であり、足したのは別の決定である。**
  // **専用の op を作らない** —— 書き込みは既存の `add_field` / `change_field` だけである。
  expect(DIFF_OPS.some((op) => op.includes("hide"))).toBe(false);
});

// --- (b) 限定2: 値は真偽値1つ ------------------------------------------------------------

test("限定2: 値は真偽値1つで、enum も pattern も minLength も default も書いていない", () => {
  const key = readSchema("manifest.schema.json").$defs.field.properties.hide_when_empty as Any;
  const { $comment: _c, description: _d, ...shape } = key;
  expect(shape).toEqual({ type: "boolean" });
});

function manifestWithField(field: Record<string, unknown>): unknown {
  return {
    app: {
      id: "hide-shop",
      name: "出し分けの店",
      tables: [{ id: "order", name: "注文", fields: [field] }],
      views: [{ id: "order-detail", type: "detail_view", table: "order" }],
    },
  };
}

test("限定2: 条件式・しきい値・文字列を書いたマニフェストは拒否される", () => {
  for (const value of ["always", { gte: 1 }, 1, ""]) {
    const result = validateManifest(
      manifestWithField({ id: "memo", name: "メモ", type: "text", hide_when_empty: value }),
    );
    expect(result.valid).toBe(false);
  }
});

// --- (c) 8型すべてに書ける(値が無いことはどの型でも起こる)---------------------------------

test("8型すべてに書ける(型で絞っていない)", () => {
  const byType: Record<string, Record<string, unknown>> = {
    text: {},
    long_text: {},
    number: {},
    boolean: {},
    date: {},
    select: { options: ["a"] },
    reference: { reference_table: "order" },
    image: {},
  };
  for (const type of FIELD_TYPES) {
    const result = validateManifest(
      manifestWithField({
        id: "value",
        name: "値",
        type,
        hide_when_empty: true,
        ...byType[type],
      }),
    );
    expect(result.valid, type).toBe(true);
  }
});

// --- (d) 限定8: ADR-0090 の emphasis と1バイトも重ならない ---------------------------------

test("限定8: emphasis の値域・書ける型・allOf の分岐を1つも変えていない", () => {
  const manifest = readSchema("manifest.schema.json");
  const emphasis = manifest.$defs.field.properties.emphasis as Any;
  expect(emphasis.type).toBe("object");
  expect(emphasis.additionalProperties.enum).toEqual(["neutral", "info", "caution", "danger"]);
  // **`allOf` の分岐の本数も、どの分岐にも `hide_when_empty` が現れないことも固定する。**
  const branches = manifest.$defs.field.allOf as Any[];
  for (const branch of branches) {
    expect(JSON.stringify(branch)).not.toContain("hide_when_empty");
  }
});

// --- (e) 限定6 の裏: change_field で書けて、値が実際に残る -----------------------------------

function baseManifest(): Manifest {
  return {
    app: {
      id: "hide-shop",
      name: "出し分けの店",
      tables: [
        {
          id: "order",
          name: "注文",
          fields: [
            { id: "memo", name: "メモ", type: "text" },
            { id: "total", name: "合計", type: "number", unit: "円" },
          ],
        },
      ],
      views: [{ id: "order-detail", type: "detail_view", table: "order" }],
    },
  };
}

function fieldOf(manifest: Manifest, id: string): Field & { hide_when_empty?: boolean } {
  const field = manifest.app.tables[0]?.fields.find((candidate) => candidate.id === id);
  if (field === undefined) {
    throw new Error(`フィールド ${id} が無い`);
  }
  return field;
}

test("change_field で書いた hide_when_empty が適用後マニフェストに残る", () => {
  const result = foldOperations(baseManifest(), [
    {
      op: "change_field",
      table: "order",
      field: "memo",
      changes: { hide_when_empty: true },
    } as Operation,
  ]);
  expect(result.valid).toBe(true);
  if (!result.valid) {
    throw new Error("畳み込みに失敗した");
  }
  expect(fieldOf(result.manifest, "memo").hide_when_empty).toBe(true);
});

test("hide_when_empty を書いたフィールドに別のキーを change_field しても値が消えない", () => {
  const first = foldOperations(baseManifest(), [
    {
      op: "change_field",
      table: "order",
      field: "memo",
      changes: { hide_when_empty: true },
    } as Operation,
  ]);
  if (!first.valid) {
    throw new Error("1回目の畳み込みに失敗した");
  }
  const second = foldOperations(first.manifest, [
    { op: "change_field", table: "order", field: "memo", changes: { name: "備考" } } as Operation,
  ]);
  expect(second.valid).toBe(true);
  if (!second.valid) {
    throw new Error("2回目の畳み込みに失敗した");
  }
  expect(fieldOf(second.manifest, "memo").hide_when_empty).toBe(true);
  expect(fieldOf(second.manifest, "memo").name).toBe("備考");
});

test("change_field で型を変えても hide_when_empty は落ちない(型に依存しないキーである)", () => {
  // **`unit`(number 限定)や `emphasis`(select 限定)と違い、本キーは全型に書ける。**
  // **したがって型変換で落とす理由が無い** —— 落とすと「書いたのに黙って消える」になる。
  const first = foldOperations(baseManifest(), [
    {
      op: "change_field",
      table: "order",
      field: "memo",
      changes: { hide_when_empty: true },
    } as Operation,
  ]);
  if (!first.valid) {
    throw new Error("1回目の畳み込みに失敗した");
  }
  const second = foldOperations(first.manifest, [
    {
      op: "change_field",
      table: "order",
      field: "memo",
      changes: { type: "long_text" },
    } as Operation,
  ]);
  expect(second.valid).toBe(true);
  if (!second.valid) {
    throw new Error("2回目の畳み込みに失敗した");
  }
  expect(fieldOf(second.manifest, "memo").hide_when_empty).toBe(true);
});

test("change_field で false に戻せる(前進で外せるかを測ったうえで書く。限定11)", () => {
  const first = foldOperations(baseManifest(), [
    {
      op: "change_field",
      table: "order",
      field: "memo",
      changes: { hide_when_empty: true },
    } as Operation,
  ]);
  if (!first.valid) {
    throw new Error("1回目の畳み込みに失敗した");
  }
  const second = foldOperations(first.manifest, [
    {
      op: "change_field",
      table: "order",
      field: "memo",
      changes: { hide_when_empty: false },
    } as Operation,
  ]);
  expect(second.valid).toBe(true);
  if (!second.valid) {
    throw new Error("2回目の畳み込みに失敗した");
  }
  // **偽に戻せる = 「書く前の見え方」へ前進で戻せる。** **ただしキーそのものは消えない。**
  expect(fieldOf(second.manifest, "memo").hide_when_empty).toBe(false);
});

test("add_field でも書ける(3経路のうち2つ目)", () => {
  const result = foldOperations(baseManifest(), [
    {
      op: "add_field",
      table: "order",
      field: { id: "note", name: "備考", type: "long_text", hide_when_empty: true },
    } as Operation,
  ]);
  expect(result.valid).toBe(true);
  if (!result.valid) {
    throw new Error("畳み込みに失敗した");
  }
  expect(fieldOf(result.manifest, "note").hide_when_empty).toBe(true);
});

test("change_field で真偽値以外を書いた差分は、差分の時点で拒否される", () => {
  const result = validateDiff({
    diff_id: "d-hide-1",
    operations: [
      { op: "change_field", table: "order", field: "memo", changes: { hide_when_empty: "yes" } },
    ],
  });
  expect(result.valid).toBe(false);
});

// --- (f) 限定3: 既定は「出す」(書かなかった項目は1文字も変わらない)-------------------------

test("限定3: 書かなかった項目にキーが生えない(既定を反転させていない)", () => {
  const result = foldOperations(baseManifest(), [
    { op: "change_field", table: "order", field: "memo", changes: { name: "備考" } } as Operation,
  ]);
  expect(result.valid).toBe(true);
  if (!result.valid) {
    throw new Error("畳み込みに失敗した");
  }
  expect("hide_when_empty" in fieldOf(result.manifest, "memo")).toBe(false);
  // **`unit` を持つフィールドも、本キーが生えないことを1件見る。**
  expect("hide_when_empty" in fieldOf(result.manifest, "total")).toBe(false);
});
