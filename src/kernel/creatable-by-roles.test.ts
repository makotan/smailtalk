/**
 * **`access_control` の9キー目 `creatable_by_roles`** —— 「`inherit_from` を持たない
 * **根の表**に行を作れる**役割**」を、表の定義が宣言できるようにする
 * (`AC-G10`。`V17-M5-T03`)。
 *
 * **上位**: [`docs/adr/0412-root-table-creatable-by-role.md`](../../../../docs/adr/0412-root-table-creatable-by-role.md)
 * (門A・**限定採用**・`AC-G10` の限定8点)/
 * [`docs/plan/v16/records/v16-m0.md`](../../../../docs/plan/v16/records/v16-m0.md) /
 * [`docs/plan/v17/06-v17-m5-plan.md`](../../../../docs/plan/v17/06-v17-m5-plan.md) §3-3。
 *
 * **綴りはユーザ決定 `D1`(2026-09-08)で `creatable_by_roles` に確定した。**
 * **`ADR-0412` §Decision の 6 は綴りを1文字も決めていない**(同 §限界7)——
 * **決めたのは本タスク(`V17-M5-T03`)である。**
 *
 * ## このファイルが測るもの(**13本**)
 *
 * | # | 何を撃つか | 着手時 |
 * |---|---|---|
 * | `(a-1)` | `access_control.properties` のキーが9つで、9つ目が `creatable_by_roles` である | **赤** |
 * | `(a-2)` | 値域(`array` / `uniqueItems` / `minItems` / 要素の綴り)がインラインで書かれている | **赤** |
 * | `(a-3)` | `required` は今日どおり4本(9キー目を入れない。`ADR-0412` 限定2) | **緑のまま**(陰性対照) |
 * | `(a-4)` | `permissions[]` の要素は今日どおり5キー(同 限定1) | **緑のまま**(陰性対照) |
 * | ↑ | **【2026-09-10 訂正。上の行を1バイトも消していない】`AC-G4a` / `ADR-0429` が6キー目
 *   `restrictive` を足したので、`(a-4)` の期待値は今日 **6キー** である**(`required` は5キーのまま) | ―― |
 * | `(a-5)` | `$defs` の本数 30 と `$defs/table` の6キーが動かない(同 限定1) | **緑のまま**(陰性対照) |
 * | `(a-6)` | 8キー目 `creatable_by` の値域が1バイトも動かない(同 限定4) | **緑のまま**(陰性対照) |
 * | `(b-1)` | `app.roles[].id` に実在しない綴りを書くと**差分全体が拒否**される(同 限定3 の (i)) | **赤** |
 * | `(b-2)` | `permissions[].id` にしか無い綴りを書いても拒否される(同 限定3 の (ii)) | **赤** |
 * | `(b-3)` | `inherit_from` を宣言した表に書くと拒否される(**根の表専用のキーである**) | **赤** |
 * | `(b-4)` | 根の表に実在する役割名だけを書けば通る | **赤** |
 * | `(b-5)` | 9キー目を書いていない表は今日どおり通る(同 限定2) | **緑のまま**(陰性対照) |
 * | `(b-6)` | 8キー目 `creatable_by` の適用時拒否2本が1バイトも変わらない(同 限定4) | **緑のまま**(陰性対照) |
 * | `(c-1)` | `diff.schema.json` に9キー目の綴りが1文字も無い(同 限定1) | **緑のまま**(陰性対照) |
 * | `(c-2)` | `change_table` 経由で9キー目を含む `access_control` を丸ごと差し替えられる | **赤** |
 *
 * ## このファイルが測らないもの(**先に書く。誇張しない**)
 *
 * - **判定を1バイトも測っていない。** **`creatable_by_roles` を書いても、このファイルが
 *   測る範囲では行の作成のふるまいは1ミリも変わらない。** **`POST /api/apps/:app_id/tables/:table_id/records`
 *   が 403 / 201 になることを撃つのは `V17-M5-T03d` であり、そちらは**本物のサーバに対する
 *   HTTP** で測る**(計画 §2b の 3 の 1 / 2 / 3 / 6)。
 * - **MCP の口(`apply_diff`)を1度も呼んでいない。** **`ADR-0412` 限定3 が求める
 *   「`apply_diff` / `POST /diffs` の**両方**で拒否される」のうち、ここが測るのは
 *   カーネルの `validateManifestFull` / `validateDiff` だけである** —— **両方の口が
 *   このカーネルを通ることを実測で示すのは `T03d` である。**
 * - **実地のアプリを1本も測っていない**(§2-1b の現行7アプリは9キー目を1つも書かない)。
 * - **`app.roles` を1つも宣言していないアプリでの挙動を「良い」と主張していない** ——
 *   **`roles` が `undefined` のアプリでは役割名の集合が空になり、9キー目に何を書いても
 *   拒否される。** **これは「黙って効かない」を作らないための帰結であって、
 *   使いやすさの主張ではない。**
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateDiff, validateManifestFull } from "./validate.ts";

const ROOT = dirname(dirname(import.meta.dir));

// biome-ignore lint/suspicious/noExplicitAny: スキーマ JSON を素で読むための局所エイリアス。
type Any = any;

/** **ユーザ決定 `D1`(2026-09-08)で確定した綴り。** */
const KEY = "creatable_by_roles";

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

test("(a-1) access_control のキーは9つで、9つ目が creatable_by_roles である(`ADR-0412` 限定1)", () => {
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
    "creatable_by_roles",
  ]);
});

test("(a-2) creatable_by_roles の値域はインラインで、要素は app.roles[].id と同じ綴りである", () => {
  const node = accessControlSchema().properties[KEY] as Any;
  expect(node.type).toBe("array");
  expect(node.uniqueItems).toBe(true);
  expect(node.minItems).toBe(1);
  // **`$defs` を1つも増やさない(`ADR-0412` 限定1)** —— 値域は `$ref` ではなくインラインで持つ。
  expect(node.$ref).toBeUndefined();
  expect(node.items.$ref).toBeUndefined();
  // **要素の綴りの形は `app.roles[].id` と1文字も違わない。**
  // **【`ADR-0412` §Decision の 2 の 2 が自ら書いている】その形は `permissions[].id` とも
  // 同じであり、JSON Schema の `pattern` では両者を区別できない** ——
  // **区別するのは適用時検査((b-1) / (b-2))の仕事である。**
  const roleId = readSchema("manifest.schema.json").$defs.app.properties.roles.items.properties
    .id as Any;
  expect(node.items.type).toBe("string");
  expect(node.items.pattern).toBe("^[a-z0-9_]{1,32}$");
  expect(node.items.pattern).toBe(roleId.pattern);
  expect(node.items.minLength).toBe(1);
  expect(node.items.maxLength).toBe(32);
});

test("(a-3) 陰性対照: required は今日どおり4本である(9キー目を入れない。`ADR-0412` 限定2)", () => {
  expect(accessControlSchema().required).toEqual([
    "enabled",
    "permissions",
    "grant",
    "creator_permission",
  ]);
});

// ---------------------------------------------------------------------------------
// **【2026-09-10。`V17-M10-T04`。台帳 `AC-G4a` / `ADR-0429`(門A の本審査 = `V17-M10-T02`。
// 判定値 = 限定採用)】期待値を5キー → 6キーへ打ち直した。****旧テスト名の逐語**:
// "(a-4) 陰性対照: permissions[] の要素は今日どおり5キーである(`ADR-0412` 限定1)"
// **旧の期待値の逐語**:
//
//     expect(Object.keys(item.properties)).toEqual(["id", "name", "read", "write", "delete"]);
//
// **`ADR-0412` 限定1 第2項(`permissions[]` の5キーを1つも動かさない)を、`ADR-0429` が
// 引き直した**(`ADR-0429` §Decision 6 の (1) の 15)。**`ADR-0412` の本文は1バイトも
// 書き換えていない。****第1項・第3項・第4項は今日も真である** —— **`access_control` は
// 9キーのまま / `$defs` は 30 のまま / `diff.schema.json` は 0バイト**(すぐ下の (a-5) と
// `table-access-control.test.ts` の (g-5) / (g-7) が撃っている)。
// ---------------------------------------------------------------------------------
test("(a-4) 陰性対照: permissions[] の要素は今日 6キーである(`ADR-0412` 限定1 第2項 → `ADR-0429`)", () => {
  const item = accessControlSchema().properties.permissions.items as Any;
  expect(Object.keys(item.properties)).toEqual([
    "id",
    "name",
    "read",
    "write",
    "delete",
    "restrictive",
  ]);
  expect(item.required).toEqual(["id", "name", "read", "write", "delete"]);
  expect(item.additionalProperties).toBe(false);
});

test("(a-5) 陰性対照: $defs の本数 30 と $defs/table の6キーが動かない(`ADR-0412` 限定1)", () => {
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

test("(a-6) 陰性対照: 8キー目 creatable_by の値域が1バイトも動かない(`ADR-0412` 限定4)", () => {
  const node = accessControlSchema().properties.creatable_by as Any;
  expect(node.type).toBe("array");
  expect(node.uniqueItems).toBe(true);
  expect(node.minItems).toBe(1);
  expect(node.$ref).toBeUndefined();
  expect(node.items).toEqual({
    type: "string",
    minLength: 1,
    maxLength: 32,
    pattern: "^[a-z0-9_]{1,32}$",
  });
});

// ---------------------------------------------------------------------------------------
// (b) 適用時検査
// ---------------------------------------------------------------------------------------

/**
 * **根の表**(`inherit_from` を持たない)を主役にしたマニフェストを作る。
 *
 * **`app.roles` と `access_control.permissions` で名前空間を割っている** ——
 * 役割名は `owner` / `editor` / `viewer` / `member` / `guest` の5つ、
 * 権限名は `reader` / `writer` の2つで、**1つも重ならない。**
 * **これが `ADR-0412` 限定3 の (ii)(`permissions[].id` にしか無い綴りも拒否する)を
 * 測るためのフィクスチャである。**
 */
function manifestWith(accessControl?: unknown): unknown {
  const projects: Record<string, unknown> = {
    id: "projects",
    name: "案件",
    fields: [
      { id: "title", name: "件名", type: "text" },
      { id: "folder", name: "入れ物", type: "reference", reference_table: "folder" },
    ],
  };
  if (accessControl !== undefined) {
    projects.access_control = accessControl;
  }
  return {
    app: {
      id: "root-creatable",
      name: "根の表の店",
      tables: [
        projects,
        {
          id: "folder",
          name: "入れ物",
          fields: [{ id: "title", name: "名前", type: "text" }],
        },
        {
          id: "projects_grant",
          name: "案件の付与",
          fields: [
            { id: "target", name: "案件", type: "reference", reference_table: "projects" },
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
      views: [{ id: "projects-form", type: "form", table: "projects", fields: ["title"] }],
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
          ],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
        { id: "member", name: "会員" },
        { id: "guest", name: "お客さん" },
      ],
    },
  };
}

/**
 * **9キー目を足す前から通っている確定形。** **ここには `creatable_by_roles` を書かない。**
 * **権限名(`reader` / `writer`)は役割名と1つも重ならない。**
 */
const VALID: Record<string, unknown> = {
  enabled: true,
  permissions: [
    { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
    { id: "writer", name: "編集可", read: true, write: true, delete: false },
  ],
  creator_permission: "writer",
  grant: {
    table: "projects_grant",
    target: "target",
    member: "member",
    permission: "permission",
  },
  members: { table: "member", account: "account" },
};

function fullResultFor(overrides: Record<string, unknown>) {
  return validateManifestFull(manifestWith({ ...VALID, ...overrides }));
}

test("(b-1) creatable_by_roles に app.roles[].id に無い名前を書くと差分全体が拒否される(`ADR-0412` 限定3 の (i))", () => {
  const result = fullResultFor({ [KEY]: ["member", "boss"] });
  expect(result.valid, JSON.stringify(result)).toBe(false);
  const errors = result.valid ? [] : result.errors;
  // **`path` は要素の位置まで指す**(項目10 と同じ形である)。
  const hit = errors.find((error) => error.path === `/app/tables/0/access_control/${KEY}/1`);
  expect(hit, JSON.stringify(errors)).toBeDefined();
  expect(hit?.message).toContain('"boss"');
  expect(hit?.message).toContain("役割");
  expect(hit?.allowed_values).toEqual(["owner", "editor", "viewer", "member", "guest"]);
});

test("(b-2) permissions[].id にしか無い綴りを書いても拒否される(`ADR-0412` 限定3 の (ii))", () => {
  // **`writer` はこの表の `permissions[].id` に実在するが、`app.roles[].id` には無い。**
  // **1つのキーに2つの名前空間を持たせない**(`ADR-0412` §Decision の 2 の 2)。
  const result = fullResultFor({ [KEY]: ["writer"] });
  expect(result.valid, JSON.stringify(result)).toBe(false);
  const errors = result.valid ? [] : result.errors;
  const hit = errors.find((error) => error.path === `/app/tables/0/access_control/${KEY}/0`);
  expect(hit, JSON.stringify(errors)).toBeDefined();
  expect(hit?.message).toContain('"writer"');
  expect(hit?.allowed_values).toEqual(["owner", "editor", "viewer", "member", "guest"]);
});

test("(b-3) inherit_from を宣言した表に creatable_by_roles を書くと拒否される(根の表専用のキーである)", () => {
  // **【この拒否は `ADR-0412` の限定表に無い。計画(§3-3 の (3))が足したものである】** ——
  // **`ADR-0412` §Decision の 2 の 7 の逐語「9キー目は『親の無い表について、どの役割か』
  // である」の射程を、機械で閉じるために足した。** **`creatable_by`(8キー目)の
  // 逆向きの制約であり、「書けるが黙って効かない」を1本も作らないためである。**
  const result = fullResultFor({ inherit_from: ["folder"], [KEY]: ["member"] });
  expect(result.valid, JSON.stringify(result)).toBe(false);
  const errors = result.valid ? [] : result.errors;
  const hit = errors.find((error) => error.path === `/app/tables/0/access_control/${KEY}`);
  expect(hit, JSON.stringify(errors)).toBeDefined();
  expect(hit?.message).toContain("inherit_from");
});

test("(b-4) 根の表に実在する役割名だけを書けば通る", () => {
  const result = fullResultFor({ [KEY]: ["member", "editor"] });
  expect(result.valid, JSON.stringify(result)).toBe(true);
});

test("(b-5) 陰性対照: creatable_by_roles を書いていない表は今日どおり通る(`ADR-0412` 限定2)", () => {
  expect(validateManifestFull(manifestWith(VALID)).valid).toBe(true);
  expect(validateManifestFull(manifestWith({ ...VALID, inherit_from: ["folder"] })).valid).toBe(
    true,
  );
});

test("(b-6) 陰性対照: 8キー目 creatable_by の適用時拒否2本が1バイトも変わらない(`ADR-0412` 限定4)", () => {
  // (i) 根の表に `creatable_by` を書いたら今日どおり拒否される。
  const root = fullResultFor({ creatable_by: ["writer"] });
  expect(root.valid, JSON.stringify(root)).toBe(false);
  const rootErrors = root.valid ? [] : root.errors;
  const rootHit = rootErrors.find(
    (error) => error.path === "/app/tables/0/access_control/creatable_by",
  );
  expect(rootHit, JSON.stringify(rootErrors)).toBeDefined();
  expect(rootHit?.message).toBe(
    "creatable_by は inherit_from を宣言した表にしか書けません(親が決まらない表では、誰が行を作れるかを判定する材料がありません)。",
  );

  // (ii) `inherit_from` を宣言した表では、要素は今日どおり `permissions[].id` である
  //      —— **役割名(`member`)を書いたら拒否される。**
  const inherited = fullResultFor({ inherit_from: ["folder"], creatable_by: ["member"] });
  expect(inherited.valid, JSON.stringify(inherited)).toBe(false);

  // (iii) 実在する権限名だけを書けば今日どおり通る。
  const ok = fullResultFor({ inherit_from: ["folder"], creatable_by: ["reader", "writer"] });
  expect(ok.valid, JSON.stringify(ok)).toBe(true);
});

// ---------------------------------------------------------------------------------------
// (c) 差分の口(`change_table`)
// ---------------------------------------------------------------------------------------

test("(c-1) 陰性対照: diff.schema.json に creatable_by_roles の綴りが1文字も無い(`ADR-0412` 限定1)", () => {
  // **値域を書き写さない** —— 写すと2つのファイルが黙ってずれる。
  expect(readFileSync(join(ROOT, "schemas", "diff.schema.json"), "utf8")).not.toContain(KEY);
});

test("(c-2) change_table 経由で creatable_by_roles を含む access_control を丸ごと差し替えられる", () => {
  // **差分操作を1つも増やしていない** —— `$defs/table_changes.access_control` の `$ref` に
  // 自動で乗る(`ADR-0412` §Decision の 6 の 4)。
  const diff = {
    diff_id: "d-creatable-by-roles",
    intent: "根の表に行を作れる役割を宣言する",
    operations: [
      {
        op: "change_table",
        table: "projects",
        changes: {
          access_control: { ...VALID, [KEY]: ["member"] },
        },
      },
    ],
  };
  const result = validateDiff(diff);
  expect(result.valid, JSON.stringify(result)).toBe(true);
});
