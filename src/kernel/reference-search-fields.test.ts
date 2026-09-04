/**
 * 参照候補の「探せる項目」を、参照先テーブルの既定と参照項目側の上書きで宣言する
 * (`K-G6` / `K-G7` / `K-G8`。`V6-M3-T01` / `V6-M3-T02` / `V6-M3-T03`)。
 *
 * **審査の正は `docs/plan/v6/records/v6-m0.md` §7-3(単位B)の限定表11点**、
 * 完了条件の正は `docs/plan/v6/01-reference-picker-baseline.md` §7 の `V6-M3` の行 (i)〜(iv)。
 *
 * ## このファイルが固定すること(カーネル側)
 *
 * 1. **限定1**: 足すキーは `$defs/table` に1本・`$defs/field` に1本の**計2本だけ**。
 *    **`representative_field` を1バイトも書き換えない。**
 * 2. **限定2 / 限定3**: 値は「フィールドIDの配列」だけ。**1本以上8本以下・重複不可。**
 *    **演算子・比較・論理結合・条件式・関数呼び出し・文字列連結・ワイルドカードを
 *    1つも書けない。**
 * 3. **限定4 / 限定5 / 限定6**: **実在する `text` / `long_text` だけ**・**役割の規則
 *    (`app.roles[].rules`)が名指しした項目は不可**を、
 *    **`src/kernel/referential-integrity.ts` の1箇所**で判定し、
 *    **【`V8-M20-T02` / 台帳 `J-G28` / `ADR-0301`。2026-08-10】3つ目の着手前の逐語は
 *    「**`audience` を宣言した項目は不可**」だった。そのキーは廃止された。**
 *    **`add_*` / `change_*` の両経路を覆う。拒否は「全か無か」。**
 * 4. **限定11**: `table_changes` / `field_changes` の**両方**に足し、**`foldChangeTable` /
 *    `buildChangedField` が値を実際に運ぶ**(「キーは在るが効かない」を作らない)。
 * 5. **限定10**: **画面ごとの上書きを作らない** —— `$defs/view` にも `view_changes` にも
 *    本キーが1バイトも無い(`D-V6-20`)。
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * - **打った文字で候補が絞られることを1件も実測していない**(照合の実装は `V6-M4`)。
 *   **今日この宣言を書いても、画面の候補は今日どおり全件がプルダウンに出る。**
 * - **既定(どちらも書かないとき代表の項目1本になる)の実測は
 *   `web/test/reference-search-fields.test.tsx` の担当である**(表示層。`K-G9` / `K-G10`)。
 * - **既知の穴を1件も塞いでいない**(`ADR-0112` §4 の 4 の5件は今日も5件)。
 *   **【`V8-M20-T02`】着手前の逐語は「**`audience` の既知の穴**」。宣言の置き場が
 *   役割の規則へ移っただけで、穴の数は動いていない。**
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { foldOperations } from "./apply-diff.ts";
import type { Manifest, Operation, Table } from "./types.ts";
import { validateDiff, validateManifestFull } from "./validate.ts";

const ROOT = dirname(dirname(import.meta.dir));

// biome-ignore lint/suspicious/noExplicitAny: スキーマ JSON を素で読むための局所エイリアス。
type Any = any;

function readSchema(name: string): Any {
  return JSON.parse(readFileSync(join(ROOT, "schemas", name), "utf8")) as Any;
}

/** 本マイルストーンが足したキーの名前。**テーブル側と項目側で同じ1語である。** */
const KEY = "reference_search_fields";

// --- (a) 増分の総量(限定1 / 限定10)-----------------------------------------------------

// 【`V7-M1-T01` / `Z-G2`】**テスト名を「5キー」から「6キー」へ書き換えた。**
//   本キー(`reference_search_fields`)は今日も5キー目のままである。
test("限定1: $defs/table.properties は6キーで、5キー目が reference_search_fields である", () => {
  const properties = Object.keys(readSchema("manifest.schema.json").$defs.table.properties);
  // **【`V7-M1-T01` / `Z-G2` で 5 → 6 に更新した】** 6キー目 `access_control`
  // (この表でアクセス権管理を使うことと、付与・グループ・メンバーの置き場所の宣言)が
  // 門A を通って増えた(`V7-M0`。判定 = 限定採用)。**本 ADR の増分ではない。**
  expect(properties).toEqual([
    "id",
    "name",
    "fields",
    "representative_field",
    KEY,
    "access_control",
  ]);
});

test("限定1: $defs/field.properties は14キーで、14キー目が reference_search_fields である", () => {
  const properties = Object.keys(readSchema("manifest.schema.json").$defs.field.properties);
  // **【`V8-M20-T01` / 台帳 `J-G27` / `J-G28` / 手続きは `ADR-0301` で 14 → 12 に更新した】**
  // 8キー目だった `audience`(この項目を見せる相手)と9キー目だった `writable_by`(この項目を
  // 書ける相手)が**2本とも廃止された**(判定 = 廃止)。**代わりに担うのは `app.roles[].rules` の
  // 「役割 × 対象(項目)× 読取 / 書込」である。****旧値の逐語は 14。**
  expect(properties).toHaveLength(12);
  expect(properties.at(-1)).toBe(KEY);
  expect(properties.at(-2)).toBe("reference_picker");
});

test("限定1: representative_field の定義を1バイトも書き換えていない", () => {
  // **着手前(`3d3c639`)の実物と1文字ずつ突き合わせる。**
  // **`$comment` と `description` と `$ref` の3つが、着手前の逐語のままであること。**
  const key = readSchema("manifest.schema.json").$defs.table.properties.representative_field as Any;
  expect(key.$ref).toBe("#/$defs/resource_id");
  expect(key.$comment).toContain("**$defs/table の4キー目である。");
  expect(key.$comment).toContain(
    "**値は自テーブルの text 型フィールドID を1本だけである (限定2)**",
  );
  expect(key.description).toContain("自テーブルの text 型フィールドID を1本だけ書ける");
  // **形のキーそのものが増えていない**(3つちょうど)。
  expect(Object.keys(key).sort()).toEqual(["$comment", "$ref", "description"]);
});

test("限定10 / D-V6-20: 画面ごとの上書きを作っていない($defs/view にも view_changes にも無い)", () => {
  const manifest = readSchema("manifest.schema.json");
  const diff = readSchema("diff.schema.json");
  expect(manifest.$defs.view.properties[KEY]).toBeUndefined();
  expect(diff.$defs.view_changes.properties[KEY]).toBeUndefined();
  // **`$defs/view.properties` は `V6-M2` が置いた29のままである。**
  // **【`V8-M20-T01` / 台帳 `J-G27` / 手続きは `ADR-0301` で 29 → 28 に更新した】** 19キー目
  // だった `audience`(この画面を見せる相手)が**廃止された**(判定 = 廃止)。**代わりに担うのは
  // `app.roles[].rules` の「役割 × 対象(画面)× 読取」である。****旧値の逐語は 29。**
  // **このリポジトリで語彙が減ったのはこれが初めてであり、増分ではなく減分である。**
  // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 28 → 29 へ書き換えた。**
  // **旧行の逐語**: `expect(Object.keys(manifest.$defs.view.properties)).toHaveLength(28);`
  // **書き換えた理由**: この行が固定していたのは「**その決定**が `$defs/view.properties` の本数 を増やさなかったこと」であり、
  // **29本目を足したのは別の決定である**(`V8-M8` が 集計表の宣言 `report` を29キー目として足した)。**検査は消していない。**
  // **【2026-08-20。`V10-M1-T02`。台帳 `NV-G4`。ADR = `0359`】期待値を 29 → 30 へ書き換えた。**
  // **旧行の逐語**: `expect(Object.keys(manifest.$defs.view.properties)).toHaveLength(29);`
  // **30本目を足したのは別の決定である**(`ADR-0359` の `after_delete`)。
  // **画面ごとの参照検索列の上書きは今日も1本も無い**(限定10 / `D-V6-20`)。
  // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
  // **期待値を 30 → 31 へ書き換えた。****旧行の逐語**: `expect(Object.keys(manifest.$defs.view.properties)).toHaveLength(30);`
  // **31本目を足したのは別の決定である**(`ADR-0359` §4b 限定1 が一続きの流れの中の段
  // `flow` を**末尾に**31キー目として足した。**`list_view` / `form` / `detail_view` の3種別で
  // 書け、集計表(`report_view`)には書けない**)。
  // **本ファイルが測っている決定の増分ではない。****検査は消していない。**
  expect(Object.keys(manifest.$defs.view.properties)).toHaveLength(31);
  // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 24 → 25 へ書き換えた。**
  // **旧行の逐語**: `expect(Object.keys(diff.$defs.view_changes.properties)).toHaveLength(24);`
  // **書き換えた理由**: この行が固定していたのは「**その決定**が `view_changes.properties` の本数 を増やさなかったこと」であり、
  // **25本目を足したのは別の決定である**(`V8-M8` が 集計表の宣言 `report` を25キー目として足した)。**検査は消していない。**
  // **【2026-08-20。`V10-M1-T02`。台帳 `NV-G4`。ADR = `0359` §Decision 2】期待値を 25 → 26 へ
  // 書き換えた。****旧行の逐語**: `expect(Object.keys(diff.$defs.view_changes.properties)).toHaveLength(25);`
  // **26本目を足したのは別の決定である**(`after_delete`)。**検査は消していない。**
  // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
  // **期待値を 26 → 27 へ書き換えた。****旧行の逐語**: `expect(Object.keys(diff.$defs.view_changes.properties)).toHaveLength(26);`
  // **27本目を足したのは別の決定である**(`flow` を `view_changes` の末尾に足した。
  // `ADR-0359` §Decision 2)。**本ファイルが測っている決定の増分ではない。**
  // **検査は消していない。**
  expect(Object.keys(diff.$defs.view_changes.properties)).toHaveLength(27);
});

test("限定1: 専用の差分操作もフィールド型も $defs も作っていない", () => {
  const manifest = readSchema("manifest.schema.json");
  const { DIFF_OPS, FIELD_TYPES } = require("./types.ts") as {
    DIFF_OPS: readonly string[];
    FIELD_TYPES: readonly string[];
  };
  expect(DIFF_OPS.some((op) => op.includes("search"))).toBe(false);
  expect(FIELD_TYPES.some((type) => type.includes("search"))).toBe(false);
  // **【`V8-M18` / 台帳 `J-G12` による期待値の更新。2026-08-09】** **旧本体の逐語**:
  // `expect(Object.keys(manifest.$defs)).toHaveLength(28)`。
  // **`K-G6` の増分は今日も `$defs` を1本も作っていない** —— **28 → 29 にしたのは
  // `V8-M18` が新設した `role_condition` 1本だけである。****旧文を1バイトも消していない。**
  // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 29 → 30 へ書き換えた。**
  // **旧行の逐語**: `expect(Object.keys(manifest.$defs)).toHaveLength(29);`
  // **書き換えた理由**: この行が固定していたのは「**その決定**が新しい `$defs` を作らなかったこと」
  // であり、**30本目を作ったのは別の決定である**(`V8-M8` が集計表の中身 `$defs/report` を新設した)。
  // **検査は消していない。**
  expect(Object.keys(manifest.$defs)).toHaveLength(30);
  expect(Object.keys(manifest.$defs)).toContain("role_condition");
});

// --- (b) 限定2 / 限定3: 値の形 -----------------------------------------------------------

test("限定2 / 限定3: 値の形はテーブル側も項目側も『1〜8本・重複不可のフィールドID配列』である", () => {
  const manifest = readSchema("manifest.schema.json");
  for (const owner of ["table", "field"] as const) {
    const key = manifest.$defs[owner].properties[KEY] as Any;
    const { $comment: _c, description: _d, ...shape } = key;
    expect(shape, owner).toEqual({
      type: "array",
      minItems: 1,
      maxItems: 8,
      uniqueItems: true,
      items: { $ref: "#/$defs/resource_id" },
    });
  }
});

test("限定2: 演算子・条件式・ワイルドカードを書ける形を1つも持たない", () => {
  // **値の要素は `$defs/resource_id`(`^[a-z][a-z0-9_-]*$`)だけである** ——
  // `*` も `%` も `>` も `AND` も `$` も、そもそも綴りとして通らない。
  const manifest = readSchema("manifest.schema.json");
  const pattern = (manifest.$defs.resource_id as Any).pattern as string;
  expect(pattern).toBe("^[a-z][a-z0-9_-]*$");
  for (const owner of ["table", "field"] as const) {
    const key = manifest.$defs[owner].properties[KEY] as Any;
    expect(key.items.$ref, owner).toBe("#/$defs/resource_id");
    // **`oneOf` / `anyOf` / `if` を1つも持たない**(条件式の入口を作らない)。
    expect(key.oneOf, owner).toBeUndefined();
    expect(key.anyOf, owner).toBeUndefined();
    expect(key.if, owner).toBeUndefined();
  }
});

// --- (c) 限定4: 項目側は reference 型にだけ書ける ------------------------------------------

/**
 * **役割の規則が `customer.secret` を名指ししている宣言**(`V8-M20-T02`。台帳 `J-G28`)。
 *
 * **既定の3本(`owner` / `editor` / `viewer`)を必ず含める** —— **`set_roles` は全体差し替え
 * であり、既定を落とした宣言は適用時検査が拒否する**(`V8-M17` / 台帳 `J-G2`)。
 */
const SECRET_ROLES = [
  {
    id: "owner",
    name: "運営",
    rules: [{ target: "field", table: "customer", field: "secret", can: ["read"] }],
  },
  { id: "editor", name: "編集" },
  { id: "viewer", name: "閲覧" },
];

function manifestWith(options: {
  customerFields?: Record<string, unknown>[];
  orderField?: Record<string, unknown>;
  tableDefault?: unknown;
  roles?: unknown;
}): unknown {
  const customer: Record<string, unknown> = {
    id: "customer",
    name: "取引先",
    fields: options.customerFields ?? [
      { id: "title", name: "名前", type: "text" },
      { id: "note", name: "覚え書き", type: "long_text" },
      { id: "score", name: "点", type: "number" },
    ],
  };
  if (options.tableDefault !== undefined) {
    customer[KEY] = options.tableDefault;
  }
  return {
    app: {
      id: "search-shop",
      name: "探せる店",
      tables: [
        customer,
        {
          id: "order",
          name: "注文",
          fields: [
            { id: "memo", name: "メモ", type: "text" },
            options.orderField ?? {
              id: "customer_id",
              name: "取引先",
              type: "reference",
              reference_table: "customer",
            },
          ],
        },
      ],
      views: [{ id: "order-form", type: "form", table: "order", fields: ["memo"] }],
      ...(options.roles === undefined ? {} : { roles: options.roles }),
    },
  };
}

test("限定4: 項目側の宣言は reference 型にだけ書ける(他の8型は差分全体が拒否される)", () => {
  const byType: Record<string, Record<string, unknown>> = {
    text: {},
    long_text: {},
    number: {},
    boolean: {},
    date: {},
    select: { options: ["a"] },
    reference: { reference_table: "customer" },
    image: {},
    file: {},
  };
  const { FIELD_TYPES } = require("./types.ts") as { FIELD_TYPES: readonly string[] };
  for (const type of FIELD_TYPES) {
    const result = validateManifestFull(
      manifestWith({
        orderField: { id: "value", name: "値", type, [KEY]: ["title"], ...byType[type] },
      }),
    );
    expect(result.valid, type).toBe(type === "reference");
  }
});

// --- (d) 限定2 / 限定3 の拒否(構造)------------------------------------------------------

test("限定3: 0本・9本・重複・文字列・入れ子はテーブル側でも項目側でも拒否される", () => {
  const bad: unknown[] = [
    [],
    ["title", "note", "title2", "title3", "title4", "title5", "title6", "title7", "title8"],
    ["title", "title"],
    "title",
    [["title"]],
    [{ field: "title" }],
    ["title *"],
  ];
  for (const value of bad) {
    expect(
      validateManifestFull(manifestWith({ tableDefault: value })).valid,
      `table:${JSON.stringify(value)}`,
    ).toBe(false);
    expect(
      validateManifestFull(
        manifestWith({
          orderField: {
            id: "customer_id",
            name: "取引先",
            type: "reference",
            reference_table: "customer",
            [KEY]: value,
          },
        }),
      ).valid,
      `field:${JSON.stringify(value)}`,
    ).toBe(false);
  }
});

test("1本と8本(境界)はテーブル側でも項目側でも通る", () => {
  const eight = Array.from({ length: 8 }, (_, index) => `c${index}`);
  const fields = eight.map((id) => ({ id, name: id, type: "text" }));
  expect(
    validateManifestFull(manifestWith({ customerFields: fields, tableDefault: [eight[0]] })).valid,
  ).toBe(true);
  expect(
    validateManifestFull(manifestWith({ customerFields: fields, tableDefault: eight })).valid,
  ).toBe(true);
});

// --- (e) 限定4 / 限定5 / 限定6: 値域の検査は1箇所・両経路・全か無か -------------------------

test("限定4: 実在しないフィールドIDは、テーブル側でも項目側でも拒否される", () => {
  const table = validateManifestFull(manifestWith({ tableDefault: ["nope"] }));
  expect(table.valid).toBe(false);
  expect(JSON.stringify(table)).toContain("/app/tables/0/reference_search_fields/0");
  const field = validateManifestFull(
    manifestWith({
      orderField: {
        id: "customer_id",
        name: "取引先",
        type: "reference",
        reference_table: "customer",
        [KEY]: ["nope"],
      },
    }),
  );
  expect(field.valid).toBe(false);
  expect(JSON.stringify(field)).toContain("/app/tables/1/fields/1/reference_search_fields/0");
});

test("限定4: 項目側の照合先は『参照先テーブル』である(自テーブルの列を書いても通らない)", () => {
  // **`memo` は注文テーブルの text 列であって、取引先テーブルには無い。**
  // **これが `v6-m0.md` §5-2 の 2「照合先のテーブルが違う」への実測の回答である。**
  const result = validateManifestFull(
    manifestWith({
      orderField: {
        id: "customer_id",
        name: "取引先",
        type: "reference",
        reference_table: "customer",
        [KEY]: ["memo"],
      },
    }),
  );
  expect(result.valid).toBe(false);
  expect(JSON.stringify(result)).toContain("memo");
});

test("限定5: text / long_text 以外の型を名指しすると拒否される(両方の置き場で)", () => {
  for (const type of ["number", "boolean", "date", "select", "reference", "image", "file"]) {
    const fields = [
      { id: "title", name: "名前", type: "text" },
      type === "select"
        ? { id: "other", name: "他", type, options: ["a"] }
        : type === "reference"
          ? { id: "other", name: "他", type, reference_table: "customer" }
          : { id: "other", name: "他", type },
    ];
    const result = validateManifestFull(
      manifestWith({ customerFields: fields, tableDefault: ["other"] }),
    );
    expect(result.valid, type).toBe(false);
    expect(JSON.stringify(result), type).toContain("text / long_text");
  }
});

test("限定5: text と long_text はどちらも通る", () => {
  expect(validateManifestFull(manifestWith({ tableDefault: ["title", "note"] })).valid).toBe(true);
});

/*
 * **【`V8-M20-T02` / 台帳 `J-G27` / `J-G28` / 手続きは `ADR-0301`。2026-08-10】**
 * **旧テスト名(逐語)**: 「**限定6: audience を宣言した項目を名指しすると拒否される
 * (両方の置き場で)**」。**旧本体は項目に `audience: ["owner"]` を書き、
 * `expect(JSON.stringify(table)).toContain("audience")` で見ていた。**
 *
 * **`audience` は廃止された。****検査は撤去していない** —— **同じ問いを、代わりに立った面
 * (`app.roles[].rules` が `target: "field"` でその項目を名指ししているか)について
 * 問い直してある。****旧文を1バイトも消していない。**
 *
 * **【旧本体が持っていた偽の緑を、ここで正す】** **旧本体は `audience` を書いた時点で
 * スキーマの `additionalProperties` に落ちるようになっており、`valid: false` も
 * `"audience"` の含有も、参照整合の検査を1度も通らずに成立しうる状態だった。**
 * **新しい本体は、拒否の位置(JSON Pointer)まで見る。**
 */
test("限定6: 役割の規則が名指しした項目を名指しすると拒否される(両方の置き場で)", () => {
  const fields = [
    { id: "title", name: "名前", type: "text" },
    { id: "secret", name: "内緒", type: "text" },
  ];
  const table = validateManifestFull(
    manifestWith({ customerFields: fields, tableDefault: ["secret"], roles: SECRET_ROLES }),
  );
  expect(table.valid).toBe(false);
  expect(JSON.stringify(table)).toContain("役割の規則");
  expect((table as { errors?: { path: string }[] }).errors?.[0]?.path).toBe(
    `/app/tables/0/${KEY}/0`,
  );
  const field = validateManifestFull(
    manifestWith({
      customerFields: fields,
      roles: SECRET_ROLES,
      orderField: {
        id: "customer_id",
        name: "取引先",
        type: "reference",
        reference_table: "customer",
        [KEY]: ["secret"],
      },
    }),
  );
  expect(field.valid).toBe(false);
  expect(JSON.stringify(field)).toContain("役割の規則");
});

/*
 * **【`V8-M20-T02` / 台帳 `J-G28` / 手続きは `ADR-0301`。2026-08-10】** **旧本体は
 * `{ id: "secret", name: "内緒", type: "text", audience: ["owner"] }` を置いていた。**
 * **`audience` は廃止されたので、同じ「候補から外れる項目」を役割の規則で作っている。**
 * **測っている主張(候補の一覧に、名指しされた項目も number も出ない)は1ミリも
 * 弱めていない。**
 */
test("限定6: 拒否のエラーには『書ける項目の一覧』が入る(1往復で直せる)", () => {
  const fields = [
    { id: "title", name: "名前", type: "text" },
    { id: "secret", name: "内緒", type: "text" },
    { id: "score", name: "点", type: "number" },
  ];
  const result = validateManifestFull(
    manifestWith({ customerFields: fields, tableDefault: ["score"], roles: SECRET_ROLES }),
  );
  expect(result.valid).toBe(false);
  const errors = (result as { errors?: { allowed_values?: string[] }[] }).errors ?? [];
  expect(errors[0]?.allowed_values).toEqual(["title"]);
});

test("限定6: 検査は1箇所にしか無い(判定を2箇所に住まわせない)", () => {
  const source = readFileSync(join(ROOT, "src", "kernel", "referential-integrity.ts"), "utf8");
  // **判定の本体は1つの局所関数だけである。**
  expect(source.split("function validateReferenceSearchFields").length - 1).toBe(1);
  // **`src/kernel/` の他のファイルは本キーの値域を1バイトも判定していない。**
  const applyDiff = readFileSync(join(ROOT, "src", "kernel", "apply-diff.ts"), "utf8");
  expect(applyDiff).not.toContain("text / long_text だけです");
});

// --- (f) 限定11: 後から変えられ、値が実際に運ばれる ----------------------------------------

function baseManifest(): Manifest {
  return {
    app: {
      id: "search-shop",
      name: "探せる店",
      tables: [
        {
          id: "customer",
          name: "取引先",
          fields: [
            { id: "title", name: "名前", type: "text" },
            { id: "note", name: "覚え書き", type: "long_text" },
          ],
        },
        {
          id: "order",
          name: "注文",
          fields: [
            { id: "memo", name: "メモ", type: "text" },
            { id: "customer_id", name: "取引先", type: "reference", reference_table: "customer" },
          ],
        },
      ],
      views: [{ id: "order-form", type: "form", table: "order", fields: ["memo"] }],
    },
  };
}

function fold(manifest: Manifest, operations: Operation[]): Manifest {
  const result = foldOperations(manifest, operations);
  if (!result.valid) {
    throw new Error(`畳み込みに失敗した: ${JSON.stringify(result.errors)}`);
  }
  return result.manifest;
}

function customerOf(manifest: Manifest): Table & { reference_search_fields?: string[] } {
  const table = manifest.app.tables[0];
  if (table === undefined) {
    throw new Error("取引先テーブルが無い");
  }
  return table;
}

test("限定11: change_table で書いた既定が適用後マニフェストに実際に残る(『効かないキー』を作らない)", () => {
  const next = fold(baseManifest(), [
    { op: "change_table", table: "customer", changes: { [KEY]: ["title", "note"] } } as Operation,
  ]);
  expect(customerOf(next).reference_search_fields).toEqual(["title", "note"]);
});

test("限定11: change_field で書いた上書きが適用後マニフェストに実際に残る", () => {
  const next = fold(baseManifest(), [
    {
      op: "change_field",
      table: "order",
      field: "customer_id",
      changes: { [KEY]: ["note"] },
    } as Operation,
  ]);
  const field = next.app.tables[1]?.fields.find((candidate) => candidate.id === "customer_id");
  expect((field as { reference_search_fields?: string[] })?.reference_search_fields).toEqual([
    "note",
  ]);
});

test("限定11: 別のキーを変えても既定も上書きも消えない(全置換であって併合ではない)", () => {
  let manifest = fold(baseManifest(), [
    { op: "change_table", table: "customer", changes: { [KEY]: ["title", "note"] } } as Operation,
    {
      op: "change_field",
      table: "order",
      field: "customer_id",
      changes: { [KEY]: ["note"] },
    } as Operation,
  ]);
  manifest = fold(manifest, [
    { op: "change_table", table: "customer", changes: { name: "お取引先" } } as Operation,
    {
      op: "change_field",
      table: "order",
      field: "customer_id",
      changes: { name: "お取引先" },
    } as Operation,
  ]);
  expect(customerOf(manifest).reference_search_fields).toEqual(["title", "note"]);
  expect(customerOf(manifest).name).toBe("お取引先");
  // **全置換である** —— 書いたら前の配列は残らない。
  manifest = fold(manifest, [
    { op: "change_table", table: "customer", changes: { [KEY]: ["note"] } } as Operation,
  ]);
  expect(customerOf(manifest).reference_search_fields).toEqual(["note"]);
});

test("限定11: add_table / add_field でも書ける(4経路とも通る)", () => {
  const next = fold(baseManifest(), [
    {
      op: "add_table",
      table: {
        id: "supplier",
        name: "仕入先",
        fields: [{ id: "title", name: "名前", type: "text" }],
        [KEY]: ["title"],
      },
    } as Operation,
    {
      op: "add_field",
      table: "order",
      field: {
        id: "supplier_id",
        name: "仕入先",
        type: "reference",
        reference_table: "supplier",
        [KEY]: ["title"],
      },
    } as Operation,
  ]);
  const supplier = next.app.tables.find((table) => table.id === "supplier");
  expect((supplier as { reference_search_fields?: string[] })?.reference_search_fields).toEqual([
    "title",
  ]);
  const field = next.app.tables[1]?.fields.find((candidate) => candidate.id === "supplier_id");
  expect((field as { reference_search_fields?: string[] })?.reference_search_fields).toEqual([
    "title",
  ]);
});

test("限定11: 書かなかったテーブル・項目にキーが生えない(既定はカーネルに1つも無い)", () => {
  const next = fold(baseManifest(), [
    { op: "change_table", table: "customer", changes: { name: "お取引先" } } as Operation,
  ]);
  expect(KEY in customerOf(next)).toBe(false);
  const field = next.app.tables[1]?.fields.find((candidate) => candidate.id === "customer_id");
  expect(field !== undefined && KEY in field).toBe(false);
});

test("限定11: reference でない型にしながら上書きを書いた change_field は名指しで拒否される", () => {
  const result = foldOperations(baseManifest(), [
    {
      op: "change_field",
      table: "order",
      field: "customer_id",
      changes: { type: "text", [KEY]: ["title"] },
    } as Operation,
  ]);
  expect(result.valid).toBe(false);
  expect(JSON.stringify(result)).toContain(KEY);
});

test("限定11: 上書きを書かずに型を変えると、引き継いだ上書きは落ちる(options と同じ作法)", () => {
  const first = fold(baseManifest(), [
    {
      op: "change_field",
      table: "order",
      field: "customer_id",
      changes: { [KEY]: ["title"] },
    } as Operation,
  ]);
  const second = fold(first, [
    { op: "change_field", table: "order", field: "customer_id", changes: { type: "text" } },
  ] as Operation[]);
  const field = second.app.tables[1]?.fields.find((candidate) => candidate.id === "customer_id");
  expect(field !== undefined && KEY in field).toBe(false);
});

// --- (g) 限定6 後段: 拒否は「全か無か」 ----------------------------------------------------

test("限定6: 正しい操作が同じ差分にあっても、値域を破った操作があれば差分全体が拒否される", () => {
  const result = foldOperations(baseManifest(), [
    { op: "change_table", table: "customer", changes: { name: "お取引先" } },
    { op: "change_table", table: "customer", changes: { [KEY]: ["nope"] } },
  ] as Operation[]);
  // **`foldOperations` は構造だけを畳むので、値域の判定は適用後マニフェストの検証で出る。**
  const folded = result.valid ? result.manifest : undefined;
  expect(folded).toBeDefined();
  const checked = validateManifestFull(folded);
  expect(checked.valid).toBe(false);
  // **部分適用しない** —— 差分全体が拒否されるので、1つ目の rename も残らない。
  expect(JSON.stringify(checked)).toContain("nope");
});

test("限定3 の形は差分の側でも同じである(diff.schema.json は値域を二重に持たない)", () => {
  const diff = readSchema("diff.schema.json");
  expect((diff.$defs.table_changes.properties[KEY] as Any).$ref).toBe(
    "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/table/properties/reference_search_fields",
  );
  expect((diff.$defs.field_changes.properties[KEY] as Any).$ref).toBe(
    "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/field/properties/reference_search_fields",
  );
  // **【`V7-M1-T03` / `Z-G37` で 4 → 5 に更新した】** 5キー目 `access_control`
  // (すでに使っている表に、あとからアクセス権管理を有効にする宣言)が門A を通って増えた。
  // **本 ADR の増分ではない。** **本キー(`reference_search_fields`)は今日も4キー目である。**
  expect(Object.keys(diff.$defs.table_changes.properties)).toEqual([
    "id",
    "name",
    "representative_field",
    KEY,
    "access_control",
  ]);
  // **【`V8-M20-T01` / 台帳 `J-G28` / 手続きは `ADR-0301` で 13 → 12 に更新した】** 8個目だった
  // `writable_by` が**廃止された**(判定 = 廃止)。**差し替えは差分操作 `set_roles` の全体差し替え
  // であり、`change_field` に相当する部分更新は面に1つも無い。****旧値の逐語は 13。**
  expect(Object.keys(diff.$defs.field_changes.properties)).toHaveLength(12);
});

test("値域を破った change_table / change_field は validateDiff では通り、適用時に倒れる", () => {
  // **形(1〜8本のフィールドID配列)は差分の構造検証が見る。**
  // **実在・型・役割の規則の名指しは適用後マニフェストの検査が見る**(判定を2箇所に住まわせない)。
  // **【`V8-M20-T02`】3つ目の着手前の逐語は `audience` だった。そのキーは廃止された。**
  expect(
    validateDiff({
      diff_id: "d-search-1",
      intent: "探せる項目を空にする",
      operations: [{ op: "change_table", table: "customer", changes: { [KEY]: [] } }],
    }).valid,
  ).toBe(false);
  expect(
    validateDiff({
      diff_id: "d-search-2",
      intent: "実在しない列を探せる項目にする",
      operations: [{ op: "change_table", table: "customer", changes: { [KEY]: ["nope"] } }],
    }).valid,
  ).toBe(true);
});
