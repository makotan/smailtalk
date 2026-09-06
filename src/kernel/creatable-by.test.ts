/**
 * **`access_control` の8キー目 `creatable_by`** —— 「その表に行を作れる権限名」を
 * 表の定義が宣言できるようにする(`CR-G2`。`V15-M1-T01`)。
 *
 * **上位**: [`docs/adr/0405-creatable-by-and-creator-permission-split.md`](../../../../docs/adr/0405-creatable-by-and-creator-permission-split.md)
 * (門A・**限定採用**・`CR-G2` の限定8点)/
 * [`docs/plan/v15/records/v15-m0.md`](../../../../docs/plan/v15/records/v15-m0.md) §5-4 /
 * [`docs/plan/v15/02-v15-m1-tasks.md`](../../../../docs/plan/v15/02-v15-m1-tasks.md) §1。
 *
 * ## このファイルが測るもの(**11本**)
 *
 * | # | 何を撃つか | 着手時 |
 * |---|---|---|
 * | `(a-1)` | `access_control.properties` のキーが8つで、8つ目が `creatable_by` である | **赤** |
 * | `(a-2)` | 値域(`array` / `uniqueItems` / `minItems` / 要素の綴り)がインラインで書かれている | **赤** |
 * | `(a-3)` | `required` は今日どおり4本(`creatable_by` を入れない) | **緑のまま**(陰性対照) |
 * | `(a-4)` | `permissions[]` の要素は today どおり5キー | **緑のまま**(陰性対照) |
 * | `(a-5)` | `$defs` の本数・`$defs/table` の6キーが動かない | **緑のまま**(陰性対照) |
 * | `(b-1)` | 実在しない権限名を書くと適用時に拒否される | **赤** |
 * | `(b-2)` | `inherit_from` を宣言していない表に書くと適用時に拒否される | **赤** |
 * | `(b-3)` | `inherit_from` を宣言した表に実在する権限名だけを書けば通る | **赤** |
 * | `(b-4)` | `creatable_by` を書いていない表は今日どおり通る | **緑のまま**(陰性対照) |
 * | `(c-1)` | `diff.schema.json` に `creatable_by` の綴りが1文字も無い | **緑のまま**(陰性対照) |
 * | `(c-2)` | `change_table` 経由で `creatable_by` を含む `access_control` を丸ごと差し替えられる | **赤** |
 *
 * ## このファイルが測らないもの(**先に書く。誇張しない**)
 *
 * - **判定を1バイトも測っていない。** **`creatable_by` を書いても、今日は行の作成の
 *   ふるまいが1ミリも変わらない**(= **「書けるが今日は効かない」**)。**当たり先は
 *   `V15-M2` であり、`V15-M1` は `src/server/` を1バイトも触っていない**
 *   (`ADR-0405` §Decision の 5 / `02-v15-m1-tasks.md` §2)。
 * - **`creator_permission` の兼用(`CR-G4`)を1バイトも直していない。** **判定の入力から
 *   外すのは `V15-M2` である。**
 * - **実地のアプリを1本も測っていない。** **今日ディスク上に `inherit_from` を書いた表は
 *   0件であり、この宣言が効くアプリは1本も無い**(`ADR-0405` §Status の 7)。
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateDiff, validateManifestFull } from "./validate.ts";

const ROOT = dirname(dirname(import.meta.dir));

// biome-ignore lint/suspicious/noExplicitAny: スキーマ JSON を素で読むための局所エイリアス。
type Any = any;

const KEY = "creatable_by";

function readSchema(name: string): Any {
  return JSON.parse(readFileSync(join(ROOT, "schemas", name), "utf8")) as Any;
}

/** `$defs/table.properties.access_control` の値域(schema の実物)。 */
function accessControlSchema(): Any {
  return readSchema("manifest.schema.json").$defs.table.properties.access_control as Any;
}

// ---------------------------------------------------------------------------------------
// (a) schema の姿
// ---------------------------------------------------------------------------------------

test("(a-1) access_control のキーは8つで、8つ目が creatable_by である(`ADR-0405` 限定1)", () => {
  // **順序ごと固定する** —— `scripts/vocabulary-snapshot.txt` が名前と順序の両方を見るため。
  expect(Object.keys(accessControlSchema().properties)).toEqual([
    "enabled",
    "permissions",
    "creator_permission",
    "grant",
    "members",
    "groups",
    "inherit_from",
    "creatable_by",
  ]);
});

test("(a-2) creatable_by の値域はインラインで、要素は permissions[].id と同じ綴りである", () => {
  const node = accessControlSchema().properties[KEY] as Any;
  expect(node.type).toBe("array");
  expect(node.uniqueItems).toBe(true);
  expect(node.minItems).toBe(1);
  // **`$defs` を1つも増やさない(限定3)** —— 値域は `$ref` ではなくインラインで持つ。
  expect(node.$ref).toBeUndefined();
  expect(node.items.$ref).toBeUndefined();
  // **要素の綴りは `permissions[].id` と1文字も違わない**(新しい名前空間を作らない)。
  const permissionId = accessControlSchema().properties.permissions.items.properties.id as Any;
  expect(node.items.type).toBe("string");
  expect(node.items.pattern).toBe("^[a-z0-9_]{1,32}$");
  expect(node.items.pattern).toBe(permissionId.pattern);
  expect(node.items.minLength).toBe(permissionId.minLength);
  expect(node.items.maxLength).toBe(permissionId.maxLength);
});

test("(a-3) 陰性対照: required は今日どおり4本である(creatable_by を入れない。限定4)", () => {
  expect(accessControlSchema().required).toEqual([
    "enabled",
    "permissions",
    "grant",
    "creator_permission",
  ]);
});

test("(a-4) 陰性対照: permissions[] の要素は今日どおり5キーである(限定2)", () => {
  const item = accessControlSchema().properties.permissions.items as Any;
  expect(Object.keys(item.properties)).toEqual(["id", "name", "read", "write", "delete"]);
  expect(item.required).toEqual(["id", "name", "read", "write", "delete"]);
  expect(item.additionalProperties).toBe(false);
});

test("(a-5) 陰性対照: $defs の本数と $defs/table の6キーが動かない(限定3 / 限定8)", () => {
  const schema = readSchema("manifest.schema.json");
  expect(Object.keys(schema.$defs)).toHaveLength(30);
  expect(Object.keys(schema.$defs.table.properties)).toEqual([
    "id",
    "name",
    "fields",
    "representative_field",
    "reference_search_fields",
    "access_control",
  ]);
});

// ---------------------------------------------------------------------------------------
// (b) 適用時検査
// ---------------------------------------------------------------------------------------

/**
 * 保護対象表・付与表・利用者表・親の表がそろった、規約どおりのマニフェストを作る。
 *
 * **`project` は `folder` を参照する項目 `folder` を持つ** —— `inherit_from` に書ける
 * 項目が1本も無いと `(b-3)` を測れないためである。
 */
function manifestWith(accessControl?: unknown): unknown {
  const project: Record<string, unknown> = {
    id: "project",
    name: "案件",
    fields: [
      { id: "title", name: "件名", type: "text" },
      { id: "folder", name: "入れ物", type: "reference", reference_table: "folder" },
    ],
  };
  if (accessControl !== undefined) {
    project.access_control = accessControl;
  }
  return {
    app: {
      id: "grant-shop",
      name: "付与の店",
      tables: [
        project,
        {
          id: "folder",
          name: "入れ物",
          fields: [{ id: "title", name: "名前", type: "text" }],
        },
        {
          id: "project_grant",
          name: "案件の付与",
          fields: [
            { id: "target", name: "案件", type: "reference", reference_table: "project" },
            { id: "member", name: "利用者", type: "reference", reference_table: "member" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
          ],
        },
        {
          id: "member",
          name: "利用者",
          fields: [{ id: "account", name: "ログイン", type: "text" }],
        },
      ],
      views: [{ id: "project-form", type: "form", table: "project", fields: ["title"] }],
    },
  };
}

/** `ADR-0405` が足す前から通っている確定形。**ここには `creatable_by` を書かない。** */
const VALID: Record<string, unknown> = {
  enabled: true,
  permissions: [
    { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
    { id: "writer", name: "編集可", read: true, write: true, delete: false },
  ],
  creator_permission: "writer",
  grant: {
    table: "project_grant",
    target: "target",
    member: "member",
    permission: "permission",
  },
  members: { table: "member", account: "account" },
};

function fullResultFor(overrides: Record<string, unknown>) {
  return validateManifestFull(manifestWith({ ...VALID, ...overrides }));
}

test("(b-1) creatable_by に permissions[].id に無い名前を書くと適用時に拒否される(限定5)", () => {
  const result = fullResultFor({ inherit_from: ["folder"], creatable_by: ["reader", "boss"] });
  expect(result.valid, JSON.stringify(result)).toBe(false);
  const errors = result.valid ? [] : result.errors;
  // **項目4(`creator_permission`)と同じ形で書く** —— `path` は要素の位置まで指す。
  const hit = errors.find((error) => error.path === "/app/tables/0/access_control/creatable_by/1");
  expect(hit, JSON.stringify(errors)).toBeDefined();
  expect(hit?.message).toContain('"boss"');
  expect(hit?.message).toContain("宣言されていません");
  expect(hit?.allowed_values).toEqual(["reader", "writer"]);
});

test("(b-2) inherit_from を宣言していない表に creatable_by を書くと適用時に拒否される(限定6)", () => {
  // **「書けるが黙って効かない」を1本も作らない**(`ADR-0405` §Decision の 5 の最終行)。
  const absent = fullResultFor({ creatable_by: ["writer"] });
  expect(absent.valid, JSON.stringify(absent)).toBe(false);
  const absentErrors = absent.valid ? [] : absent.errors;
  const absentHit = absentErrors.find(
    (error) => error.path === "/app/tables/0/access_control/creatable_by",
  );
  expect(absentHit, JSON.stringify(absentErrors)).toBeDefined();
  expect(absentHit?.message).toContain("inherit_from");

  // **空配列も「宣言していない」と同じ扱いである** —— 親が1件も決まらないためである。
  const empty = fullResultFor({ inherit_from: [], creatable_by: ["writer"] });
  expect(empty.valid, JSON.stringify(empty)).toBe(false);
  const emptyErrors = empty.valid ? [] : empty.errors;
  expect(
    emptyErrors.some((error) => error.path === "/app/tables/0/access_control/creatable_by"),
    JSON.stringify(emptyErrors),
  ).toBe(true);
});

test("(b-3) inherit_from を宣言した表に実在する権限名だけを書けば通る", () => {
  const result = fullResultFor({ inherit_from: ["folder"], creatable_by: ["reader", "writer"] });
  expect(result.valid, JSON.stringify(result)).toBe(true);
});

test("(b-4) 陰性対照: creatable_by を書いていない表は今日どおり通る(限定4)", () => {
  expect(validateManifestFull(manifestWith(VALID)).valid).toBe(true);
  expect(validateManifestFull(manifestWith({ ...VALID, inherit_from: ["folder"] })).valid).toBe(
    true,
  );
});

// ---------------------------------------------------------------------------------------
// (c) 差分の口(`change_table`)
// ---------------------------------------------------------------------------------------

test("(c-1) 陰性対照: diff.schema.json に creatable_by の綴りが1文字も無い(限定7)", () => {
  // **値域を書き写さない** —— 写すと2つのファイルが黙ってずれる。
  expect(readFileSync(join(ROOT, "schemas", "diff.schema.json"), "utf8")).not.toContain(KEY);
});

test("(c-2) change_table 経由で creatable_by を含む access_control を丸ごと差し替えられる", () => {
  // **差分操作を1つも増やしていない** —— `$defs/table_changes.access_control` の `$ref` に
  // 自動で乗る(`ADR-0405` §Decision の 5「差分の口: 1つも増やさない」)。
  const diff = {
    diff_id: "d-creatable-by",
    intent: "行を作れる権限名を宣言する",
    operations: [
      {
        op: "change_table",
        table: "project",
        changes: {
          access_control: { ...VALID, inherit_from: ["folder"], creatable_by: ["writer"] },
        },
      },
    ],
  };
  const result = validateDiff(diff);
  expect(result.valid, JSON.stringify(result)).toBe(true);
});
