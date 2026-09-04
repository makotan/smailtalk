/**
 * 参照候補の「探せる項目」の**解決**(項目 > テーブル > 代表の1本)と、
 * **ポップアップの一覧に並べる列を既存の宣言から導くこと**
 * (`K-G9` / `K-G10`。`V6-M3-T04` / `V6-M3-T05` / `ADR-0290` 限定7)。
 *
 * **完了条件の正は `docs/plan/v6/01-reference-picker-baseline.md` §7 の `V6-M3` の行の
 * (i) / (ii) / (iv)。**
 *
 * ## このファイルが固定すること
 *
 * 1. **(i) 参照項目側の上書きが、参照先テーブルの既定より優先される。**
 * 2. **(ii) どちらも書かなければ、代表の項目1本が対象になる** ——
 *    **その解決は `representativeField` の**唯一の実装**を通る。**
 *    **新しい解決規則を作っていない**(検査がソースを走査して機械で固定する)。
 * 3. **(iv) ポップアップの一覧に並べる列は、`K-G6` / `K-G7` の宣言から導く** ——
 *    **そのための新しいキーを1本も足していない。**
 * 4. **代表項目を面(`app.roles[].rules`)が名指ししているとき何が起きるかを実測する**
 *    (`V6-M3-T04` の完了条件)。**【`V8-M20` / `J-G28`】旧文は「代表項目に `audience` が
 *    付いているとき」だった** —— **そのキーは撤去され、名指しは面へ移った。**
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * - **打った文字で候補が絞られることを1件も測っていない。** **照合の実装は今日
 *   1バイトも無い**(当たり先は `V6-M4`)。**したがって今日この宣言を書いても、
 *   画面の候補は今日どおり全件がプルダウンに出る = 「書けるが今日は効かない」。**
 * - **ポップアップという器そのものが今日1つも無い**(`V6-M5`)。**測っているのは
 *   「どの列を並べることになるか」を返す関数の返り値だけであり、画面で確かめた実測は
 *   1件も無い。**
 * - **「見せる相手」の穴を1件も塞いでいない。** **代表項目を面が名指ししていると
 *   規則の外の相手は1件も当てられない**ことを、下の検査が正直に固定している。
 *   **【`V8-M20` / `J-G28`】旧文は「`audience` の穴」「代表項目に `audience` が付いていると」
 *   だった** —— **穴そのものは1ミリも塞がっていない。**
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Field, Manifest, Table } from "../../src/kernel/types.ts";
// **面が項目を名指ししているかは、サーバと**同じ述語1本**を見る**(判定を2箇所に書かない)。
import { isRoleGovernedField } from "../../src/server/owner-scope.ts";
import {
  referencePopupColumns,
  referenceSearchFields,
  representativeField,
} from "../src/fields/reference-label.ts";

const WEB_SRC = join(dirname(import.meta.dir), "src");
const LABEL_PATH = join(WEB_SRC, "fields", "reference-label.ts");

/** 名前つき関数の**本体だけ**を切り出す(doc コメントも後続の関数も含めない)。 */
function bodyOf(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`);
  if (start < 0) {
    throw new Error(`関数 ${name} が無い`);
  }
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end < 0 ? undefined : end);
}

type ReferenceField = Extract<Field, { type: "reference" }>;

/**
 * **その項目を面(役割の規則)が名指ししているマニフェスト。**
 *
 * **【`V8-M20` / `J-G28`】旧は項目に `audience: ["owner"]` を直接書いていた** ——
 * **そのキーは撤去されたので、名指しは `app.roles[].rules` の側へ移った。**
 */
function manifestGoverning(tableId: string, fieldId: string): Manifest {
  return {
    app: {
      id: "picker-app",
      name: "参照の題材",
      tables: [],
      views: [],
      roles: [
        {
          id: "owner",
          rules: [{ target: "field", table: tableId, field: fieldId, can: ["read"] }],
        },
      ],
    },
  };
}

function customerTable(options: { tableDefault?: string[] } = {}): Table {
  const title: Record<string, unknown> = { id: "title", name: "名前", type: "text" };
  const table: Table = {
    id: "customer",
    name: "取引先",
    fields: [
      title as unknown as Field,
      { id: "code", name: "取引先コード", type: "text" },
      { id: "note", name: "覚え書き", type: "long_text" },
      { id: "score", name: "点", type: "number" },
    ],
  };
  if (options.tableDefault !== undefined) {
    table.reference_search_fields = options.tableDefault;
  }
  return table;
}

function referenceFieldWith(override?: string[]): ReferenceField {
  const field = {
    id: "customer_id",
    name: "取引先",
    type: "reference",
    reference_table: "customer",
  } as ReferenceField;
  if (override !== undefined) {
    field.reference_search_fields = override;
  }
  return field;
}

// --- (a) (i) 2階建て: 項目側 > テーブル側 --------------------------------------------------

test("(i) 参照項目側の上書きが、参照先テーブルの既定より優先される", () => {
  const table = customerTable({ tableDefault: ["title"] });
  const resolved = referenceSearchFields(table, referenceFieldWith(["code", "note"]));
  expect(resolved.map((field) => field.id)).toEqual(["code", "note"]);
});

test("(i) 項目側が書いていなければ、参照先テーブルの既定に倒れる", () => {
  const table = customerTable({ tableDefault: ["code", "note"] });
  expect(referenceSearchFields(table, referenceFieldWith()).map((f) => f.id)).toEqual([
    "code",
    "note",
  ]);
  // **第2引数そのものを渡さない呼び出しも「項目側の宣言が無い」と同じに倒れる。**
  expect(referenceSearchFields(table).map((f) => f.id)).toEqual(["code", "note"]);
});

test("(i) テーブル側が書いていなくても、項目側だけで効く(2階建ての片側ずつ)", () => {
  const table = customerTable();
  expect(referenceSearchFields(table, referenceFieldWith(["note"])).map((f) => f.id)).toEqual([
    "note",
  ]);
});

test("(i) 4通り(書く / 書かない の組み合わせ)を全部測る", () => {
  const cases: [string[] | undefined, string[] | undefined, string[]][] = [
    [["title"], ["code"], ["code"]],
    [["title"], undefined, ["title"]],
    [undefined, ["code"], ["code"]],
    // **どちらも書かないときは代表の1本**(下の (b) 群が同じことを別角度から固定する)。
    [undefined, undefined, ["title"]],
  ];
  for (const [tableDefault, override, expected] of cases) {
    const table = customerTable(tableDefault === undefined ? {} : { tableDefault });
    const resolved = referenceSearchFields(table, referenceFieldWith(override));
    expect(
      resolved.map((field) => field.id),
      JSON.stringify([tableDefault, override]),
    ).toEqual(expected);
  }
});

// --- (b) (ii) どちらも書かなければ代表の項目1本 --------------------------------------------

test("(ii) どちらも書かなければ、返るのは representativeField が解決した1本だけである", () => {
  const table = customerTable();
  const resolved = referenceSearchFields(table);
  expect(resolved).toHaveLength(1);
  // **同一オブジェクトである** —— **写しでも作り直しでもない。**
  expect(resolved[0]).toBe(representativeField(table));
});

test("(ii) representative_field を宣言していれば、探す対象もその1本になる(解決が1本である証拠)", () => {
  const table = customerTable();
  (table as { representative_field?: string }).representative_field = "code";
  expect(referenceSearchFields(table).map((f) => f.id)).toEqual(["code"]);
  expect(referenceSearchFields(table)[0]).toBe(representativeField(table));
});

test("(ii) text を1本も持たないテーブルでは、探す対象が0本になる(代表が引けない)", () => {
  const table: Table = {
    id: "ticket",
    name: "券",
    fields: [{ id: "score", name: "点", type: "number" }],
  };
  expect(representativeField(table)).toBeUndefined();
  expect(referenceSearchFields(table)).toEqual([]);
});

test("(ii) 参照先テーブルが引けないときも落ちない(0本を返す)", () => {
  expect(referenceSearchFields(undefined)).toEqual([]);
  expect(referenceSearchFields(undefined, referenceFieldWith(["title"]))).toEqual([]);
});

test("(ii) 解決の規則は1箇所にしか無い(新しい解決規則を作っていない)", () => {
  // **`representativeField` の宣言は製品に1つだけである。**
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (full.endsWith(".ts") || full.endsWith(".tsx")) {
        files.push(full);
      }
    }
  };
  walk(WEB_SRC);
  const declaring = files.filter((file) =>
    readFileSync(file, "utf8").includes("export function representativeField"),
  );
  expect(declaring.map((file) => relative(WEB_SRC, file))).toEqual(["fields/reference-label.ts"]);
  // **`reference_search_fields` の字面を含む `web/src` のファイルも1つだけである。**
  const reading = files.filter((file) =>
    readFileSync(file, "utf8").includes("reference_search_fields"),
  );
  expect(reading.map((file) => relative(WEB_SRC, file))).toEqual(["fields/reference-label.ts"]);
  const source = readFileSync(LABEL_PATH, "utf8");
  expect(source.split("export function referenceSearchFields").length - 1).toBe(1);
  // **既定(代表の1本)を持つのは `representativeField` の呼び出し1箇所だけである** ——
  // **「最初の text フィールド」の規則をここに写していない。**
  // **「text 型を選ぶ」規則の実装は `representativeField` の本体の中にしか無い** ——
  // **ファイル全体の出現数(2。宣言つきの1段目と、既定の2段目)が、そのまま
  // `representativeField` の本体の出現数と一致する。**
  const RULE = 'field.type === "text"';
  expect(source.split(RULE).length - 1).toBe(2);
  expect(bodyOf(source, "representativeField").split(RULE).length - 1).toBe(2);
  expect(bodyOf(source, "referenceSearchFields")).not.toContain('type === "text"');
});

// --- (c) 面が名指しした代表項目 —— 何が起きるかを実測して書く(V6-M3-T04 の完了条件) ---

test("代表項目を面の規則が名指ししていても、探す対象はその1本のままである(拒否は1件も起きない)", () => {
  // **【`V8-M20` / 台帳 `J-G28`(判定 = 廃止)/ 手続きは `ADR-0301` で宣言の置き場を移した。
  // 旧のテスト名と旧の逐語を1バイトも消していない】**
  //
  // **旧テスト名**: 「代表項目に audience が付いていても、探す対象はその1本のままである
  // (拒否は1件も起きない)」。
  // **旧のコメント(逐語)**: 「**`ADR-0112` 限定6 は `search_fields` に `audience` 付きを
  // 書くことを差分の拒否で防いでいる。** **`reference_search_fields` にも同じ拒否を課した**
  // (`src/kernel/reference-search-fields.test.ts` の限定6 群)。 **しかし「どちらも
  // 書かなかったときの既定」はその拒否を通らない** —— **代表項目の側には今日も検査が
  // 1件も無いからである**(`ADR-0080` 限定6 の帰結)。」
  // **旧の期待値**: `expect((resolved[0] as { audience?: unknown }).audience).toEqual(["owner"]);`
  //
  // **今日**: **`field.audience` は撤去され、項目を名指しするのは
  // `app.roles[].rules` の `{ target: "field", table, field, can: [...] }` である。**
  // **測っている問い(名指しされた項目がそのまま探す対象になる = 穴が残っている)は
  // 1ミリも変えていない。**
  const table = customerTable();
  const manifest = manifestGoverning("customer", "title");
  const resolved = referenceSearchFields(table);
  // **【実測。誇張しない】面が名指ししている項目が、そのまま探す対象になる。**
  expect(resolved.map((field) => field.id)).toEqual(["title"]);
  expect(isRoleGovernedField(manifest, "customer", "title")).toBe(true);
  // **その相手(規則に載っていない閲覧者)には値が届かないので、探しても1件も
  // 当たらない。** **この非対称は本マイルストーンが作ったのではなく、
  // `representative_field` の側に今日すでにある。**
  // **【禁止の履行】これを「見せる相手の穴を塞いだ」と書かない。塞いでいない。**
  expect(referenceSearchFields(table, referenceFieldWith(["code"])).map((f) => f.id)).toEqual([
    "code",
  ]);
});

// --- (d) (iv) ポップアップの列は既存の宣言から導く(新しいキーを1本も足さない)--------------

test("(iv) ポップアップの一覧に並べる列は、探せる項目の解決結果そのものである", () => {
  const table = customerTable({ tableDefault: ["code", "note"] });
  expect(referencePopupColumns(table).map((field) => field.id)).toEqual(["code", "note"]);
  expect(referencePopupColumns(table, referenceFieldWith(["title"])).map((f) => f.id)).toEqual([
    "title",
  ]);
});

test("(iv) どちらも書かなければ、並ぶ列は代表の1本だけである(今日の見え方と同じ)", () => {
  const table = customerTable();
  expect(referencePopupColumns(table).map((field) => field.id)).toEqual(["title"]);
});

test("(iv) 列のための新しいキーを1本も足していない(schemas を機械で見る)", () => {
  const root = dirname(dirname(import.meta.dir));
  const manifest = JSON.parse(
    readFileSync(join(root, "schemas", "manifest.schema.json"), "utf8"),
    // biome-ignore lint/suspicious/noExplicitAny: スキーマ JSON を素で読むための局所エイリアス。
  ) as any;
  // **`$defs/table` は6キー・`$defs/field` は14キー**(本マイルストーンが足した2本を含む)。
  // **そのうち「列」のためのキーは1本も無い。**
  // **【`V7-M1-T01` / `Z-G2` で 5 → 6 に更新した】** 6キー目 `access_control`(この表で
  // アクセス権管理を使うことと、付与・グループ・メンバーの置き場所の宣言)が門A を通って
  // 増えた(`V7-M0`。判定 = 限定採用)。**本マイルストーンの増分ではない。**
  // **`v7-m0.md` §4-3 の12箇所の列挙には、この行は入っていなかった**(`V7-M1-T02` の記録に書いた)。
  // **【`V8-M20` / 台帳 `J-G28`(判定 = 廃止)/ 手続きは `ADR-0301` で 14 → 12 に更新した】**
  // **旧の期待値**: `expect(fieldKeys).toHaveLength(14);`
  // **減った2キーは `audience`(この項目を見せる相手)と `writable_by`(この項目を書ける相手)。**
  // **代わりに担うのは `app.roles[].rules` の
  // `{ target: "field", table: <表ID>, field: <項目ID>, can: ["read"] / ["write"] }` である。**
  // **本マイルストーン(`V6-M3`)の増分は今日も2本のままで、1本も動いていない。**
  // **`$defs/table` の6キーも1本も動いていない。**
  const tableKeys = Object.keys(manifest.$defs.table.properties);
  const fieldKeys = Object.keys(manifest.$defs.field.properties);
  expect(tableKeys).toHaveLength(6);
  expect(fieldKeys).toHaveLength(12);
  for (const key of [...tableKeys, ...fieldKeys]) {
    expect(key.includes("column"), key).toBe(false);
    expect(key.includes("popup"), key).toBe(false);
  }
  // **導出の実装は既存の2つの宣言しか読まない** —— `columns` も `preset_` も読まない。
  const source = readFileSync(LABEL_PATH, "utf8");
  expect(source).not.toContain("preset_");
  expect(source.includes("view.columns")).toBe(false);
});

test("(iv) 列を導く関数は、探せる項目の解決を再実装せずそのまま通す", () => {
  // **`referencePopupColumns` は `referenceSearchFields` を呼ぶだけである** ——
  // **列の決め方が2箇所に住むことを機械で止める。**
  const source = readFileSync(LABEL_PATH, "utf8");
  const body = bodyOf(source, "referencePopupColumns");
  expect(body).toContain("return referenceSearchFields(");
  // **代表の解決も「最初の text」の規則も、この関数の中には1文字も無い。**
  expect(body.split("representativeField(").length - 1).toBe(0);
  expect(body).not.toContain('type === "text"');
});
