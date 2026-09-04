/**
 * 表ごとに「この表はアクセス権管理を使う」と宣言し、付与・グループ・メンバーを
 * どこに記録するかを表の定義が持つ(`Z-G2` / `Z-G3` / `Z-G4` / `Z-G6` / `Z-G7` /
 * `Z-G10` / `Z-G11` / `Z-G12` / `Z-G15` / `Z-G20`。`V7-M1-T01`)。
 *
 * **決定の正は `docs/plan/v7/records/v7-m0.md` §5-2 の (a)**(綴り・値域・確定形)。
 * **審査の正は同 §6**(判定 = 限定採用)。**限定表は `V7-M1-T07` が起草する個別 ADR。**
 *
 * ## このファイルが固定すること(schema 側)
 *
 * 1. **足すキーは `$defs/table` に1本だけ**(5 → 6)。**7つ目を足してはならない。**
 * 2. **新しい `$defs` を1つも作らない**(`$defs` 28 のまま)。値域はインラインで書き、
 *    識別子は既存の `resource_id` を `$ref` で受ける。
 * 3. **`required` に入れない** —— **`access_control` を書いていないマニフェストが
 *    今日どおり通る**(`Z-G20` の schema 側の担保)。
 * 4. `additionalProperties: false` を `$defs/table` でも `access_control` の中でも保つ。
 * 5. **`representative_field` / `reference_search_fields` を1バイトも書き換えない。**
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * - **判定の実装を1バイトも測っていない。** 今日この宣言を書いても、行の読取・書込・削除の
 *   ふるまいは今日どおりである(**書けるが今日は効かない**)。当たり先は `V7-M2` 以降。
 * - **`permissions[].id` の重複・`creator_permission` の実在・`grant` / `members` /
 *   `groups` が指した表と列の実在と型を、この schema は1つも止めない**(JSON Schema で
 *   表せない)。**適用時検査は `V7-M1-T05` の担当である。** 下の (e) がその「今日は通る」を
 *   そのまま固定している。
 * - **サーバがこの宣言を読むかどうかを測っていない**(`V7-M1-T04`)。
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateDiff, validateManifest, validateManifestFull } from "./validate.ts";

const ROOT = dirname(dirname(import.meta.dir));

// biome-ignore lint/suspicious/noExplicitAny: スキーマ JSON を素で読むための局所エイリアス。
type Any = any;

function readSchema(name: string): Any {
  return JSON.parse(readFileSync(join(ROOT, "schemas", name), "utf8")) as Any;
}

/** 本タスクが足したキーの名前。**`$defs/table` の6キー目である。** */
const KEY = "access_control";

// --- (a) 増分の総量 ---------------------------------------------------------------------

test("Z-G2: $defs/table.properties は6キーで、6キー目が access_control である", () => {
  const properties = Object.keys(readSchema("manifest.schema.json").$defs.table.properties);
  expect(properties).toEqual([
    "id",
    "name",
    "fields",
    "representative_field",
    "reference_search_fields",
    KEY,
  ]);
});

// **【`V8-M18` / 台帳 `J-G12`(`ADR-0007` 門A 本審査 = 限定採用)による期待値の更新。2026-08-09】**
// **旧テスト名の逐語**: 「**Z-G2: 新しい $defs を1つも作っていない($defs 28 のまま)**」。
// **旧本体の逐語**: `expect(Object.keys(readSchema("manifest.schema.json").$defs)).toHaveLength(28)`。
// **`Z-G2` の増分は今日も `$defs` を1本も作っていない**(`access_control` の値域はインライン)。
// **28 → 29 にしたのは `V8-M18` が新設した `role_condition`(役割の規則の条件)1本だけである。**
// **旧文を1バイトも消していない。**
test("Z-G2: 新しい $defs を1つも作っていない($defs は 29 で、増やしたのは V8-M18 の1本だけ)", () => {
  const defs = Object.keys(readSchema("manifest.schema.json").$defs);
  // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 29 → 30 へ書き換えた。**
  // **旧行の逐語**: `expect(defs).toHaveLength(29);`
  // **書き換えた理由**: この行が固定していたのは「**その決定**が新しい `$defs` を作らなかったこと」
  // であり、**30本目を作ったのは別の決定である**(`V8-M8` が集計表の中身 `$defs/report` を新設した)。
  // **検査は消していない。**
  expect(defs).toHaveLength(30);
  expect(defs).toContain("role_condition");
});

test("Z-G20: $defs/table.required は id / name / fields のままで、access_control を含まない", () => {
  const table = readSchema("manifest.schema.json").$defs.table as Any;
  expect(table.required).toEqual(["id", "name", "fields"]);
  expect(table.required).not.toContain(KEY);
});

test("Z-G2: $defs/table の additionalProperties: false を1バイトも変えていない", () => {
  expect(readSchema("manifest.schema.json").$defs.table.additionalProperties).toBe(false);
});

test("Z-G2: representative_field / reference_search_fields の定義を1バイトも書き換えていない", () => {
  const properties = readSchema("manifest.schema.json").$defs.table.properties as Any;
  const representative = properties.representative_field as Any;
  expect(Object.keys(representative).sort()).toEqual(["$comment", "$ref", "description"]);
  expect(representative.$ref).toBe("#/$defs/resource_id");
  expect(representative.$comment).toContain("**$defs/table の4キー目である。");
  const search = properties.reference_search_fields as Any;
  expect(search.$comment).toContain("**$defs/table の5キー目である。**");
  expect(search.maxItems).toBe(8);
  expect(search.items).toEqual({ $ref: "#/$defs/resource_id" });
});

// --- (b) $comment が置き換えとなる新しい不変条件を書いている --------------------------------

test("Z-G2: $comment に個別 ADR の限定表への参照と、置き換えとなる新しい不変条件3点がある", () => {
  const key = readSchema("manifest.schema.json").$defs.table.properties[KEY] as Any;
  // (1) 限定表への参照(ADR-0292)。
  expect(key.$comment).toContain(
    "限定表は ADR-0292(docs/adr/0292-table-access-control.md)の限定表18行",
  );
  // (2) 置き換えとなる新しい不変条件3点。
  expect(key.$comment).toContain("$defs/table のキーは6つ。7つ目を足してはならない。");
  expect(key.$comment).toContain("新しい $defs を1つも作らない ($defs 28 のまま)");
  expect(key.$comment).toContain("required に入れない");
  // (3) **今日は効かないことを隠していない。**
  expect(key.$comment).toContain("書けるが今日は効かない");
  expect(typeof key.description).toBe("string");
});

// --- (c) 値の形 -------------------------------------------------------------------------

function accessControlSchema(): Any {
  return readSchema("manifest.schema.json").$defs.table.properties[KEY] as Any;
}

test("Z-G2: access_control は object・additionalProperties: false・必須4本である", () => {
  const key = accessControlSchema();
  expect(key.type).toBe("object");
  expect(key.additionalProperties).toBe(false);
  expect(key.required).toEqual(["enabled", "permissions", "grant", "creator_permission"]);
  expect(Object.keys(key.properties)).toEqual([
    "enabled",
    "permissions",
    "creator_permission",
    "grant",
    "members",
    "groups",
    "inherit_from",
  ]);
});

test("Z-G10: permissions は1〜8件で、要素は id / name / read / write / delete の5キーである", () => {
  const permissions = accessControlSchema().properties.permissions as Any;
  expect(permissions.type).toBe("array");
  expect(permissions.minItems).toBe(1);
  expect(permissions.maxItems).toBe(8);
  const item = permissions.items as Any;
  expect(item.type).toBe("object");
  expect(item.additionalProperties).toBe(false);
  expect(item.required).toEqual(["id", "name", "read", "write", "delete"]);
  expect(Object.keys(item.properties)).toEqual(["id", "name", "read", "write", "delete"]);
  expect(item.properties.id.pattern).toBe("^[a-z0-9_]{1,32}$");
  for (const flag of ["read", "write", "delete"]) {
    expect(item.properties[flag].type, flag).toBe("boolean");
  }
});

test("Z-G11: read / write / delete は boolean であり、条件式を書ける形を1つも持たない", () => {
  const item = accessControlSchema().properties.permissions.items as Any;
  for (const flag of ["read", "write", "delete"]) {
    expect(item.properties[flag].enum, flag).toBeUndefined();
    expect(item.properties[flag].oneOf, flag).toBeUndefined();
    expect(item.properties[flag].anyOf, flag).toBeUndefined();
  }
});

test("Z-G3 / Z-G4: grant は table / target / permission が必須で、member / group は任意である", () => {
  const grant = accessControlSchema().properties.grant as Any;
  expect(grant.type).toBe("object");
  expect(grant.additionalProperties).toBe(false);
  expect(grant.required).toEqual(["table", "target", "permission"]);
  expect(Object.keys(grant.properties)).toEqual([
    "table",
    "target",
    "member",
    "group",
    "permission",
  ]);
});

test("Z-G7: members は table / account が必須で、group は任意である", () => {
  const members = accessControlSchema().properties.members as Any;
  expect(members.type).toBe("object");
  expect(members.additionalProperties).toBe(false);
  expect(members.required).toEqual(["table", "account"]);
  expect(Object.keys(members.properties)).toEqual(["table", "account", "group"]);
});

test("Z-G6: groups は table 1本だけである", () => {
  const groups = accessControlSchema().properties.groups as Any;
  expect(groups.type).toBe("object");
  expect(groups.additionalProperties).toBe(false);
  expect(groups.required).toEqual(["table"]);
  expect(Object.keys(groups.properties)).toEqual(["table"]);
});

test("Z-G15: inherit_from は0〜2件で、minItems を置いていない", () => {
  const inherit = accessControlSchema().properties.inherit_from as Any;
  expect(inherit.type).toBe("array");
  expect(inherit.maxItems).toBe(2);
  expect(inherit.minItems).toBeUndefined();
  expect(inherit.uniqueItems).toBe(true);
  expect(inherit.items).toEqual({ $ref: "#/$defs/resource_id" });
});

test("Z-G2: 表・列を指す値はすべて既存の resource_id を $ref で受ける(新しい $defs を作らない)", () => {
  const key = accessControlSchema();
  const refs: string[] = [];
  const walk = (node: Any): void => {
    if (node === null || typeof node !== "object") return;
    if (typeof node.$ref === "string") refs.push(node.$ref);
    for (const value of Object.values(node)) walk(value as Any);
  };
  walk(key);
  expect(refs).not.toEqual([]);
  expect([...new Set(refs)]).toEqual(["#/$defs/resource_id"]);
});

// --- (d) オプトイン(Z-G20 の前半)-------------------------------------------------------

function manifestWith(accessControl?: unknown): unknown {
  const project: Record<string, unknown> = {
    id: "project",
    name: "案件",
    fields: [
      { id: "title", name: "件名", type: "text" },
      { id: "memo", name: "覚え書き", type: "long_text" },
    ],
  };
  if (accessControl !== undefined) {
    project[KEY] = accessControl;
  }
  return {
    app: {
      id: "grant-shop",
      name: "付与の店",
      tables: [
        project,
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
          fields: [
            { id: "account", name: "ログイン", type: "text" },
            { id: "group", name: "グループ", type: "reference", reference_table: "team" },
          ],
        },
        {
          id: "team",
          name: "グループ",
          fields: [{ id: "title", name: "名前", type: "text" }],
        },
      ],
      views: [{ id: "project-form", type: "form", table: "project", fields: ["title"] }],
    },
  };
}

/** `v7-m0.md` §5-2 (a) の確定形をそのまま書いた、通るはずの宣言。 */
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
  members: { table: "member", account: "account", group: "group" },
  groups: { table: "team" },
  inherit_from: [],
};

test("Z-G20: access_control を書いていないマニフェストは今日どおり通る(incoming / stored の両方)", () => {
  expect(validateManifestFull(manifestWith(), "incoming").valid).toBe(true);
  expect(validateManifestFull(manifestWith(), "stored").valid).toBe(true);
});

test("Z-G2: 確定形どおりに書いた access_control は構造検査を通る", () => {
  const result = validateManifestFull(manifestWith(VALID));
  expect(result.valid, JSON.stringify(result)).toBe(true);
});

test("Z-G2: 任意キー(members / groups / inherit_from)は schema の必須ではない", () => {
  // **【`V7-M1-T05` による期待値の更新。検査は1本も消していない】**
  // **着手前はこの1本が `validateManifestFull` で `true` を測っていた。**
  // **今日は `validateManifestFull` に適用時検査(`Z-G9`)が入っており、
  // 「利用者を指す項目を書いたのに利用者の表を宣言していない」宣言は拒否される。**
  // **測り方を「schema の必須ではない」と「適用時検査は別に見る」の2段に割った。**
  const { members: _m, groups: _g, inherit_from: _i, ...minimal } = VALID;
  // (1) **schema(構造)は今日も通す** —— 3本とも任意キーだからである。
  expect(validateManifest(manifestWith(minimal)).valid).toBe(true);
  // (2) **適用時検査は拒否する**(`V7-M1-T05` の項目9)。
  expect(validateManifestFull(manifestWith(minimal)).valid).toBe(false);
  // (3) **`groups` / `inherit_from` を落とした宣言は、適用時検査も通る** ——
  //     **任意キーが本当に任意であることは、この形で今日も成り立っている。**
  const { groups: _g2, inherit_from: _i2, ...withMembers } = VALID;
  const narrowed = { ...withMembers, members: { table: "member", account: "account" } };
  const result = validateManifestFull(manifestWith(narrowed));
  expect(result.valid, JSON.stringify(result)).toBe(true);
});

test("Z-G2: 必須4本のどれか1本でも欠けると拒否される", () => {
  for (const missing of ["enabled", "permissions", "grant", "creator_permission"]) {
    const broken = { ...VALID };
    delete (broken as Record<string, unknown>)[missing];
    expect(validateManifestFull(manifestWith(broken)).valid, missing).toBe(false);
  }
});

test("Z-G2: 近そうな名前を1つ足すと拒否される(additionalProperties: false)", () => {
  const broken = { ...VALID, owner_permission: "editor" };
  expect(validateManifestFull(manifestWith(broken)).valid).toBe(false);
});

test("Z-G10: permissions は0件でも9件でも拒否される", () => {
  expect(validateManifestFull(manifestWith({ ...VALID, permissions: [] })).valid).toBe(false);
  const nine = Array.from({ length: 9 }, (_, index) => ({
    id: `p${index}`,
    name: `権限${index}`,
    read: true,
    write: false,
    delete: false,
  }));
  expect(validateManifestFull(manifestWith({ ...VALID, permissions: nine })).valid).toBe(false);
});

test("Z-G10: permissions の要素に近そうなキーを足す / 5キーのどれかを欠くと拒否される", () => {
  const extra = [{ ...(VALID.permissions as Any[])[0], share: true }];
  expect(validateManifestFull(manifestWith({ ...VALID, permissions: extra })).valid).toBe(false);
  const lacking = [{ id: "reader", name: "参照のみ", read: true, write: false }];
  expect(validateManifestFull(manifestWith({ ...VALID, permissions: lacking })).valid).toBe(false);
});

test("Z-G10: permissions[].id の綴りは ^[a-z0-9_]{1,32}$ に閉じている", () => {
  for (const id of ["Viewer", "view-er", "", "a".repeat(33)]) {
    const permissions = [{ id, name: "名前", read: true, write: false, delete: false }];
    expect(
      validateManifestFull(manifestWith({ ...VALID, permissions, creator_permission: "reader" }))
        .valid,
      id,
    ).toBe(false);
  }
});

test("Z-G15: inherit_from は3件書くと拒否される", () => {
  const broken = { ...VALID, inherit_from: ["a", "b", "c"] };
  expect(validateManifestFull(manifestWith(broken)).valid).toBe(false);
});

test("Z-G2: enabled は boolean 以外を書くと拒否される", () => {
  expect(validateManifestFull(manifestWith({ ...VALID, enabled: "true" })).valid).toBe(false);
});

// --- (e) この schema が今日は止めないもの(**正直に固定する**)------------------------------

test("【正直に書く】permissions[].id の重複を、この schema は今日止めない(V7-M1-T05 の担当)", () => {
  const duplicated = [
    { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
    { id: "reader", name: "参照のみ(2)", read: true, write: true, delete: false },
  ];
  const input = manifestWith({ ...VALID, permissions: duplicated, creator_permission: "reader" });
  // **JSON Schema では「配列要素の1キーだけが一意」を表せない。**
  expect(validateManifest(input).valid).toBe(true);
  // **【`V7-M1-T05` による期待値の更新。検査は1本も消していない】**
  // **着手前はここが `validateManifestFull` で `true` を測っていた**(「今日は通る」)。
  // **今日は適用時検査(`Z-G9` の項目5)が拒否する。** **schema が止めないことは今日も真である。**
  expect(validateManifestFull(input).valid).toBe(false);
});

test("【正直に書く】creator_permission が permissions に無くても、この schema は今日通す", () => {
  const input = manifestWith({ ...VALID, creator_permission: "nobody" });
  expect(validateManifest(input).valid).toBe(true);
  // **【`V7-M1-T05` による期待値の更新】** 適用時検査(項目4)が拒否する。
  expect(validateManifestFull(input).valid).toBe(false);
});

test("【正直に書く】grant / members / groups が実在しない表や列を指しても、この schema は今日通す", () => {
  const input = manifestWith({
    ...VALID,
    grant: { table: "no_such_table", target: "no_such_field", permission: "no_such_field" },
    members: { table: "no_such_table", account: "no_such_field" },
    groups: { table: "no_such_table" },
  });
  expect(validateManifest(input).valid).toBe(true);
  // **【`V7-M1-T05` による期待値の更新】** 適用時検査(項目1)が拒否する。
  expect(validateManifestFull(input).valid).toBe(false);
});

// --- (f) `V7-M1-T03` / `Z-G37`: `change_table` の5キー目 ----------------------------------
//
// **`schemas/diff.schema.json` の `$defs/table_changes` に `access_control` を足す(4 → 5)。**
// **既存の `$comment` の逐語「置き換えとなる新しい不変条件: 5つ目のキーを足してはならない。」**
// **を1バイトも消さず、新しい `$comment` の側に「6つ目を足してはならない」を書く**
// (`ADR-0290` が `ADR-0080` に対して採った作法)。**引き直しの連鎖の4代目である。**

/** `$defs/table_changes` の5キー目。**`$defs/table` の6キー目と同じ1語である。** */
const DIFF_KEYS = ["id", "name", "representative_field", "reference_search_fields", KEY];

/** `V7-M1-T01` が `manifest.schema.json` に置いた値域を、`diff.schema.json` から指す先。 */
const ACCESS_CONTROL_REF =
  "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/table/properties/access_control";

function tableChanges(): Any {
  return readSchema("diff.schema.json").$defs.table_changes as Any;
}

function diffWithChanges(changes: unknown): unknown {
  return {
    diff_id: "d-access-control",
    intent: "すでに使っている表にアクセス権管理を有効にする",
    operations: [{ op: "change_table", table: "project", changes }],
  };
}

test("Z-G37: $defs/table_changes.properties は5キーで、5キー目が access_control である", () => {
  expect(Object.keys(tableChanges().properties)).toEqual(DIFF_KEYS);
});

test("Z-G37: diff.schema.json に新しい $defs を1つも作っていない(5 のまま)", () => {
  expect(Object.keys(readSchema("diff.schema.json").$defs)).toEqual([
    "op_name",
    "table_changes",
    "field_changes",
    "view_changes",
    "operation",
  ]);
});

test("Z-G37: table_changes の additionalProperties: false / minProperties: 1 を1バイトも変えていない", () => {
  const changes = tableChanges();
  expect(changes.additionalProperties).toBe(false);
  expect(changes.minProperties).toBe(1);
  expect(changes.type).toBe("object");
});

test("Z-G37: 値域は manifest 側の定義を $ref で受け、複写を1つも置いていない", () => {
  const node = tableChanges().properties[KEY] as Any;
  // **書き方は `representative_field` / `reference_search_fields` と同じである**
  // (`$comment` / `description` / `$ref` の3キー)。
  expect(Object.keys(node).sort()).toEqual(["$comment", "$ref", "description"]);
  expect(node.$ref).toBe(ACCESS_CONTROL_REF);
  // **`$ref` の指し先を実際に辿り、`$defs/table.properties.access_control` と
  // 1バイトも違わないことを機械で確かめる。**
  const manifest = readSchema("manifest.schema.json") as Any;
  const resolved = ACCESS_CONTROL_REF.split("#/")[1]
    ?.split("/")
    .reduce<Any>((node2, key) => node2?.[key.replace(/~1/g, "/")], manifest);
  expect(resolved).toBeDefined();
  expect(JSON.stringify(resolved)).toBe(
    JSON.stringify(manifest.$defs.table.properties[KEY] as Any),
  );
  // **値域の複写が1文字も無い**(複写すると2つのファイルが黙ってずれる)。
  expect(readFileSync(join(ROOT, "schemas", "diff.schema.json"), "utf8")).not.toContain(
    "creator_permission",
  );
});

test("Z-G37: 既存の $comment 逐語「5つ目のキーを足してはならない」を1バイトも消していない", () => {
  const properties = tableChanges().properties as Any;
  const search = properties.reference_search_fields as Any;
  expect(search.$comment).toContain(
    "**置き換えとなる新しい不変条件: 5つ目のキーを足してはならない。**",
  );
  // **長さごと固定する** —— 1文字でも消したり書き換えたりすれば赤くなる。
  expect(search.$comment).toHaveLength(907);
  expect(Object.keys(search).sort()).toEqual(["$comment", "$ref", "description"]);
  const representative = properties.representative_field as Any;
  expect(representative.$comment).toContain("**3つ目のキーである。**");
  expect(representative.$comment).toHaveLength(287);
  // `table_changes` 自身の `$comment`(`ADR-0010` 限定2 の逐語)も1バイトも消していない。
  expect(tableChanges().$comment).toContain("ADR-0010 限定2: キーは列挙固定 (id / name の2つ)。");
  expect(tableChanges().$comment).toHaveLength(108);
});

test("Z-G37: 新しい $comment が、置き換えとなる新しい不変条件と引き直しの4代目を書いている", () => {
  const comment = (tableChanges().properties[KEY] as Any).$comment as string;
  expect(comment).toContain("**5つ目のキーである。**");
  expect(comment).toContain(
    "**置き換えとなる新しい不変条件: $defs/table_changes のキーは5つ。6つ目のキーを足してはならない。**",
  );
  // 引き直しの連鎖(`ADR-0010` 限定2 → `ADR-0080` 限定3/4 → `ADR-0290` → 本件)。
  expect(comment).toContain("ADR-0010 限定2");
  expect(comment).toContain("ADR-0080");
  expect(comment).toContain("ADR-0290");
  expect(comment).toContain("4代目");
  // 限定表への参照(**番号はまだ採られていない**)。
  expect(comment).toContain("V7-M1-T07");
});

test("Z-G37: change_table で access_control を書いた差分が形の検査を通る", () => {
  const result = validateDiff(diffWithChanges({ [KEY]: VALID }));
  expect(result.valid, JSON.stringify(result)).toBe(true);
});

test("Z-G37: change_table でも値域の外は拒否される($ref が実際に効いている)", () => {
  // 9件(`maxItems: 8` の外)。
  const nine = Array.from({ length: 9 }, (_, index) => ({
    id: `p${index}`,
    name: `権限${index}`,
    read: true,
    write: false,
    delete: false,
  }));
  expect(validateDiff(diffWithChanges({ [KEY]: { ...VALID, permissions: nine } })).valid).toBe(
    false,
  );
  // 近そうな名前(`additionalProperties: false`)。
  expect(
    validateDiff(diffWithChanges({ [KEY]: { ...VALID, owner_permission: "editor" } })).valid,
  ).toBe(false);
  // 必須4本の欠落。
  const { enabled: _e, ...missing } = VALID;
  expect(validateDiff(diffWithChanges({ [KEY]: missing })).valid).toBe(false);
});

test("Z-G37: changes に近そうな6つ目のキーを書くと拒否される(additionalProperties: false)", () => {
  expect(validateDiff(diffWithChanges({ access_controls: VALID })).valid).toBe(false);
  expect(validateDiff(diffWithChanges({})).valid).toBe(false);
});
