/**
 * **権限名の値域を有限に閉じる**(`Z-G10` / `Z-G12`。`V7-M2-T01`)。
 *
 * **審査の正**: [`docs/plan/v7/records/v7-m0.md`](../../docs/plan/v7/records/v7-m0.md) §6-4 の
 * `Z-G10`(判定 = 限定採用)/ `Z-G12`(判定 = 限定採用(同伴))。
 * **予約4語の裁定**: 同 §6-4b の1(**メインが決めた**)。
 * **実施記録**: [`docs/plan/v7/records/v7-m2.md`](../../docs/plan/v7/records/v7-m2.md) §2-1。
 *
 * ## このファイルが測るもの
 *
 * **`access_control.permissions` の値域が、どこで・どう閉じているか**の全量である。
 * **`Z-G12` 限定 (4) の逐語「値域の閉じ方は `schemas/` の側に置く。`src/server/` の定数に
 * 逃がさない。」**を、実際に schema 側で止まっていることの実測として固定する。
 *
 * ## **着手前から緑だったもの / `V7-M2-T01` が足したもの**(**自分の成果として書かない**)
 *
 * **`V7-M1-T01`(schema)と `V7-M1-T05`(適用時検査)が、着手前にすでに次を止めていた** ——
 * **本ファイルはそれを新しく作ったのではなく、`Z-G10` / `Z-G12` の完了条件として
 * 1箇所にまとめて測り直しているだけである**:
 *
 * | 完了条件 | 着手前 | 止めている場所 |
 * |---|---|---|
 * | (i) 9件目の宣言が拒否される | **すでに緑** | schema(`maxItems: 8`。`V7-M1-T01`) |
 * | (ii) `id` が値域外の宣言が拒否される | **すでに緑** | schema(`pattern`。`V7-M1-T01`) |
 * | (iii) `permissions` に無い `creator_permission` が拒否される | **すでに緑** | 適用時検査 項目4(`V7-M1-T05`) |
 * | `id` の重複が拒否される | **すでに緑** | 適用時検査 項目5(`V7-M1-T05`) |
 * | **予約4語が `id` に書けない** | **着手前は通った** | **`V7-M2-T01` が schema に足した(`not` / `enum`)** |
 *
 * ## このファイルが測らないもの(**先に書く。誇張しない**)
 *
 * - **判定(誰に何が見えるか)を1バイトも測っていない。** **今日この宣言を書いても、行の
 *   読取・書込・削除のふるまいは今日どおりである**(当たり先は `V7-M2-T02` 以降)。
 * - **上限8件に実地の根拠を1つも持っていない。** **`user_kinds` の8に合わせただけである**
 *   (`v7-m0.md` §6-4 の `Z-G12` `S3` の2)。**「8で足りる」とは書けない。** 本ファイルが
 *   測るのは「9件目が拒否される」ことだけであって、8が適切かどうかではない。
 * - **`grant` / `members` / `groups` が指した表と列の実在と型**は測らない
 *   (`V7-M1-T05` の担当。`src/kernel/referential-integrity.test.ts` が測っている)。
 * - **`src/kernel/table-access-control.test.ts` を1本も置き換えていない**(別ファイルである)。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ValidationError, ValidationResult } from "./errors.ts";
import { validateManifest, validateManifestFull } from "./validate.ts";

const ROOT = dirname(dirname(import.meta.dir));

// biome-ignore lint/suspicious/noExplicitAny: スキーマ JSON を素で読むための局所エイリアス。
type Any = any;

function readManifestSchema(): Any {
  return JSON.parse(readFileSync(join(ROOT, "schemas", "manifest.schema.json"), "utf8")) as Any;
}

/** `$defs/table.properties.access_control` の値域(schema の実物)。 */
function accessControlSchema(): Any {
  return readManifestSchema().$defs.table.properties.access_control as Any;
}

/** 権限名1件。**`id` 以外は全部同じにして、測る軸を `id` だけに絞る。** */
function permission(id: string): Record<string, unknown> {
  return { id, name: "権限の表示名", read: true, write: false, delete: false };
}

/**
 * `v7-m0.md` §5-2 (a) の確定形。
 *
 * **`V7-M2-T01` 以降、`id` に予約4語を書けない**ので、この確定形の `id` は
 * `reader` / `writer` である(**着手前の `viewer` / `editor` から変えた**)。
 */
const VALID_DECLARATION: Record<string, unknown> = {
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

/** 保護対象表・付与表・利用者表がそろった、規約どおりのマニフェストを作る。 */
function manifestWith(accessControl?: unknown): unknown {
  const project: Record<string, unknown> = {
    id: "project",
    name: "案件",
    fields: [{ id: "title", name: "件名", type: "text" }],
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

/** 宣言を1箇所だけ差し替えて、適用時検査まで通した結果を返す。 */
function fullResultFor(overrides: Record<string, unknown>): ValidationResult {
  return validateManifestFull(manifestWith({ ...VALID_DECLARATION, ...overrides }));
}

/** 拒否されたときのエラー全件。**通ってしまったらそこで落とす**(空配列で静かに緑にしない)。 */
function errorsOf(result: ValidationResult): ValidationError[] {
  expect(result.valid, JSON.stringify(result)).toBe(false);
  return result.valid ? [] : result.errors;
}

// --- (0) 基準形 --------------------------------------------------------------------------

test("基準形: 規約どおりの宣言は今日も通る(これが赤いと以下の測定は意味を持たない)", () => {
  const result = validateManifestFull(manifestWith(VALID_DECLARATION));
  expect(result.valid, JSON.stringify(result)).toBe(true);
});

// --- (1) 完了条件 (i): 本数 ----------------------------------------------------------------
//
// **【着手前からすでに緑である】** **止めているのは `V7-M1-T01` が書いた `maxItems: 8`。**

describe("(1) 権限名は1件以上8件以下である(`Z-G12` 限定 (1)。**着手前からすでに緑**)", () => {
  const permissions = (count: number) =>
    Array.from({ length: count }, (_, index) => permission(`p${index}`));

  test("1件は通る", () => {
    expect(fullResultFor({ permissions: permissions(1), creator_permission: "p0" }).valid).toBe(
      true,
    );
  });

  test("8件は通る", () => {
    expect(fullResultFor({ permissions: permissions(8), creator_permission: "p0" }).valid).toBe(
      true,
    );
  });

  test("**9件目は拒否される**(完了条件 (i))", () => {
    expect(fullResultFor({ permissions: permissions(9), creator_permission: "p0" }).valid).toBe(
      false,
    );
  });

  test("0件は拒否される(`minItems: 1`)", () => {
    expect(fullResultFor({ permissions: [], creator_permission: "p0" }).valid).toBe(false);
  });

  test("止めているのは schema 側である(適用時検査を通す前の構造検査で落ちる)", () => {
    const input = manifestWith({
      ...VALID_DECLARATION,
      permissions: permissions(9),
      creator_permission: "p0",
    });
    expect(validateManifest(input).valid).toBe(false);
  });

  test("**上限8に実地の根拠は1つも無い** —— schema の値が 8 であることだけを固定する", () => {
    // **`user_kinds` の8に合わせただけである**(`v7-m0.md` §6-4 の `Z-G12` `S3` の2)。
    // **「8で足りる」ことは1件も測っていない。** 測れているのは「9件目が拒否される」だけ。
    const permissionsSchema = accessControlSchema().properties.permissions as Any;
    expect(permissionsSchema.minItems).toBe(1);
    expect(permissionsSchema.maxItems).toBe(8);
    // ---------------------------------------------------------------------------------
    // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】**
    //
    // **旧(逐語)**:
    //
    //     expect(readManifestSchema().$defs.app.properties.user_kinds.maxItems).toBe(8);
    //
    // **この1行が主張していたのは「`permissions` の 8 は `user_kinds` の 8 と同じ数である」
    // という**由来の固定**である。** **`user_kinds` が廃止され、読む先が消えた**
    // (残すと `TypeError: undefined is not an object` を投げる。関門 `T01-U` の (5) が
    // メモリ上でキーを削って実測した逐語である)。
    //
    // **【置き換え先が無かった。行を消さず、測る先を `permissions` 自身に変えた】**
    // **`maxItems` の全件を機械で数えた実測**(関門 `T01-U` の (5)):
    // `app.roles` は **12**(8 ではない)/ `reference_search_fields` と `search_fields` の
    // 8 は由来が違う(この検査のコメントが逐語で「`user_kinds` の8に合わせただけ」と
    // 書いている)。**8 という数を持つ独立した第2の出所は、今日1つも無い。**
    //
    // **【`ADR-0301` 限定2 / 限定6 の ④ に対する答え —— 担い手が無い】**
    // **「上限8 の出所」を取り除いたあと、その役割を担うものは1つも無い。**
    // **今日この行は「自分を自分で測る形」になった** —— **すぐ上の `toBe(8)` と同じ値を
    // 2度読むだけであり、独立した第2の出所を失った。** **`V8-M25` の C群 が
    // 「担い手が無い2件」の1つとして予告したものが、そのとおりに起きた。**
    // **【禁止の履行】これを「`permissions` 側で測れるので問題ない」と書かない。**
    // ---------------------------------------------------------------------------------
    expect((accessControlSchema().properties.permissions as Any).maxItems).toBe(
      permissionsSchema.maxItems,
    );
  });
});

// --- (2) 完了条件 (ii): `id` の綴り ---------------------------------------------------------
//
// **【着手前からすでに緑である】** **止めているのは `V7-M1-T01` が書いた `pattern`。**

describe("(2) `id` は `^[a-z0-9_]{1,32}$` に閉じている(**着手前からすでに緑**)", () => {
  const outOfRange: [string, string][] = [
    ["大文字を含む", "Reader"],
    ["ハイフンを含む", "read-er"],
    ["空白を含む", "read er"],
    ["日本語", "参照"],
    ["空文字", ""],
    ["33文字", "a".repeat(33)],
  ];

  for (const [label, id] of outOfRange) {
    test(`**${label}** の \`id\` は拒否される(完了条件 (ii))`, () => {
      expect(
        fullResultFor({ permissions: [permission(id)], creator_permission: id }).valid,
        label,
      ).toBe(false);
    });
  }

  test("32文字ちょうどは通る(境界の反対側も測る)", () => {
    const id = "a".repeat(32);
    expect(fullResultFor({ permissions: [permission(id)], creator_permission: id }).valid).toBe(
      true,
    );
  });

  test("止めているのは schema 側である", () => {
    const input = manifestWith({
      ...VALID_DECLARATION,
      permissions: [permission("Reader")],
      creator_permission: "Reader",
    });
    expect(validateManifest(input).valid).toBe(false);
    const idSchema = accessControlSchema().properties.permissions.items.properties.id as Any;
    expect(idSchema.pattern).toBe("^[a-z0-9_]{1,32}$");
  });
});

// --- (3) 完了条件 (iii): `creator_permission` -----------------------------------------------
//
// **【着手前からすでに緑である】** **止めているのは `V7-M1-T05` の適用時検査 項目4。**

describe("(3) `permissions` に無い `creator_permission` は拒否される(**着手前からすでに緑**)", () => {
  test("**宣言していない権限名を作成者に与える宣言が拒否される**(完了条件 (iii))", () => {
    expect(fullResultFor({ creator_permission: "nobody" }).valid).toBe(false);
  });

  test("拒否は適用時検査で起きる(schema は今日もこれを通す)", () => {
    const input = manifestWith({ ...VALID_DECLARATION, creator_permission: "nobody" });
    // **JSON Schema では「同じ宣言の中の別の配列に実在するか」を表せない。**
    expect(validateManifest(input).valid).toBe(true);
    expect(validateManifestFull(input).valid).toBe(false);
  });

  test("エラー文言が利用者の言葉である(内部記号を出さない)", () => {
    const messages = errorsOf(fullResultFor({ creator_permission: "nobody" }))
      .map((error) => error.message)
      .join("\n");
    expect(messages).toContain("宣言されていません");
    expect(messages).not.toContain("Z-G");
    expect(messages).not.toContain("ADR-");
  });
});

// --- (4) `id` の重複 ------------------------------------------------------------------------
//
// **【着手前からすでに緑である】** **止めているのは `V7-M1-T05` の適用時検査 項目5。**
// **`user_kinds` はこれを今日も止められていない**(`declared-user-kinds.test.ts` の冒頭が
// 限界として名指ししている)。**`access_control` 側は `src/kernel/` に検査を置けたので止まる。**

describe("(4) `id` の重複は拒否される(`Z-G12` 限定 (3)。**着手前からすでに緑**)", () => {
  test("**同じ `id` を2度書いた宣言が拒否される**", () => {
    const duplicated = [permission("reader"), { ...permission("reader"), name: "参照のみ(2)" }];
    expect(fullResultFor({ permissions: duplicated, creator_permission: "reader" }).valid).toBe(
      false,
    );
  });

  test("止めているのは適用時検査である(`uniqueItems` では表せない)", () => {
    const duplicated = [permission("reader"), { ...permission("reader"), name: "参照のみ(2)" }];
    const input = manifestWith({
      ...VALID_DECLARATION,
      permissions: duplicated,
      creator_permission: "reader",
    });
    expect(validateManifest(input).valid).toBe(true);
    expect(validateManifestFull(input).valid).toBe(false);
  });
});

// --- (5) 予約4語(**`V7-M2-T01` が足した唯一の増分**)----------------------------------------
//
// **裁定は `v7-m0.md` §6-4b の1(メインが決めた)。** **`Z-G12` 限定 (7)。**
// **理由3つと、`user_kinds` の理由を流用していないことは、schema 側の `$comment` に逐語で在る**
// (下の (6) がその実在を固定している)。

describe("(5) 予約4語は `id` に書けない(`Z-G12` 限定 (7)。**`V7-M2-T01` が足した**)", () => {
  for (const reserved of ["owner", "editor", "viewer", "anonymous"]) {
    test(`\`${reserved}\` を権限名にした宣言が拒否される`, () => {
      expect(
        fullResultFor({ permissions: [permission(reserved)], creator_permission: reserved }).valid,
        reserved,
      ).toBe(false);
    });
  }

  test("2件目以降に混ぜても拒否される(先頭だけを見ていない)", () => {
    const permissions = [permission("reader"), permission("owner")];
    expect(fullResultFor({ permissions, creator_permission: "reader" }).valid).toBe(false);
  });

  test("**止めているのは `schemas/` の側である**(`Z-G12` 限定 (4))", () => {
    // **逐語: 「値域の閉じ方は `schemas/` の側に置く。`src/server/` の定数に逃がさない。」**
    // **`not` / `enum` で表せたので、適用時検査には1バイトも置いていない。**
    const input = manifestWith({
      ...VALID_DECLARATION,
      permissions: [permission("owner")],
      creator_permission: "owner",
    });
    expect(validateManifest(input).valid).toBe(false);
  });

  test("**エラー文言が利用者の言葉である**(内部記号も Ajv の内部の言葉も出さない)", () => {
    const result = fullResultFor({
      permissions: [permission("owner")],
      creator_permission: "owner",
    });
    const error = errorsOf(result).find((candidate) =>
      candidate.path.endsWith("/permissions/0/id"),
    );
    expect(error).toBeDefined();
    expect(error?.message).toBe(
      '"owner" は運営ロールの名前として使われているため、権限の名前には使えません。',
    );
    // **`must NOT be valid` は Ajv の内部の言葉である。利用者に出さない。**
    expect(error?.message).not.toContain("must NOT be valid");
    expect(error?.message).not.toContain("Z-G");
    expect(error?.message).not.toContain("ADR-");
    // **予約4語の一覧は hint 側にある**(何を避ければよいかが1度で分かる)。
    expect(error?.hint).toContain('"owner" / "editor" / "viewer" / "anonymous"');
  });

  test("**`anonymous` の理由は `owner` と違う**(1つの文面にまとめて嘘をつかない)", () => {
    // **`anonymous` はロールではない** —— `$defs/view.audience` の「ログインしていない人」である。
    const result = fullResultFor({
      permissions: [permission("anonymous")],
      creator_permission: "anonymous",
    });
    const error = errorsOf(result).find((candidate) =>
      candidate.path.endsWith("/permissions/0/id"),
    );
    expect(error?.message).toBe(
      '"anonymous" はログインしていない人を表す名前として使われているため、権限の名前には使えません。',
    );
  });

  test("**`user_kinds` の題材は今日1件も残っていない**(器ごと廃止されたため)", () => {
    // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a` / `T-G13`】**
    // **旧テスト名の逐語**:
    // 「**`user_kinds` 側の文面は1バイトも変えていない**(直していないものを直したと書かない)」。
    // **旧の本体(逐語)**:
    //
    //     // **`Z-G10` 限定 (5)「`user_kinds` の中に1バイトも書かない」を守った結果である。**
    //     // **したがって「予約4語の拒否の文面はどこでも利用者の言葉である」とは書けない。**
    //     const withReservedKind = { app: { …, user_kinds: [{ id: "owner", name: "運営" }], … } };
    //     const error = errorsOf(validateManifestFull(withReservedKind)).find((candidate) =>
    //       candidate.path.endsWith("/user_kinds/0/id"),
    //     );
    //     expect(error?.message).toBe("id が不正です(not: must NOT be valid)。");
    //
    // **題材そのもの(`app.user_kinds`)が廃止されたので、測る対象が消えた。**
    // **測る先を「その宣言が今日どう拒まれるか」に入れ替えた** —— **検査は消していない。**
    // **【この入れ替えで失われたもの。丸めない】** **「予約4語の拒否の文面が2種類ある
    // (片方は利用者の言葉、片方は ajv の生の文)」という不揃いを固定していた検査が、
    // 今日は片方しか無いので測れない。** **担い手は無い。**
    const withReservedKind = {
      app: {
        id: "grant-shop",
        name: "付与の店",
        user_kinds: [{ id: "owner", name: "運営" }],
        tables: [
          { id: "project", name: "案件", fields: [{ id: "title", name: "件名", type: "text" }] },
        ],
        views: [],
      },
    };
    const errors = errorsOf(validateManifestFull(withReservedKind));
    expect(errors.some((candidate) => candidate.path.endsWith("/user_kinds/0/id"))).toBe(false);
    const error = errors.find((candidate) => candidate.path === "/app");
    expect(error?.message).toBe('未知のプロパティ "user_kinds" は指定できません。');
  });

  test("予約語でない名前は今日どおり書ける(`customer` / `admin` / `member`)", () => {
    for (const id of ["customer", "admin", "member"]) {
      expect(
        fullResultFor({ permissions: [permission(id)], creator_permission: id }).valid,
        id,
      ).toBe(true);
    }
  });

  test("予約4語は `creator_permission` にも実質書けない(`permissions` に入れられないため)", () => {
    // **`creator_permission` 側に `not` を足していない** —— **足さなくても、適用時検査 項目4 が
    // 「宣言されていない権限名」として拒否する。** **どちらの経路でも通らないことを測る。**
    expect(fullResultFor({ creator_permission: "owner" }).valid).toBe(false);
  });
});

// --- (6) 予約4語を止めている場所と、裁定の理由が schema に逐語で在ること ----------------------

describe("(6) 予約4語の値域と、裁定の理由3つが schema に在る", () => {
  test("`permissions[].id` に `not` / `enum` で予約4語が並んでいる", () => {
    const idSchema = accessControlSchema().properties.permissions.items.properties.id as Any;
    expect(idSchema.not.enum).toEqual(["owner", "editor", "viewer", "anonymous"]);
  });

  test("**予約4語を締め出す `not.enum` は、今日この1箇所だけである**(比較相手が廃止された)", () => {
    // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a` / `T-G13`】旧テスト名の逐語**:
    // 「**`user_kinds` とまったく同じ書き方に揃えてある**(AIが覚える規則を1つ増やさない)」。
    // **旧の本体(逐語)**:
    //
    //     const userKindId = readManifestSchema().$defs.app.properties.user_kinds.items.properties
    //       .id as Any;
    //     const permissionId = accessControlSchema().properties.permissions.items.properties.id as Any;
    //     expect(permissionId.pattern).toBe(userKindId.pattern);
    //     expect(permissionId.not).toEqual(userKindId.not);
    //
    // **比較相手(`user_kinds` 側の `id`)が廃止されたので、この検査は「揃っていること」を
    // 今日1バイトも測れない。** **担い手は無い**(`ADR-0301` 限定6 の ④)。
    // **代わりに、締め出しが1箇所に減ったこと自体を固定する** ——
    // **`V8-M25` §5-3 の (1) が「消えるのは片方だけ」と書いた実測が、今日そのとおりである。**
    const permissionId = accessControlSchema().properties.permissions.items.properties.id as Any;
    expect(permissionId.pattern).toBe("^[a-z0-9_]{1,32}$");
    expect(permissionId.not).toEqual({ enum: ["owner", "editor", "viewer", "anonymous"] });
    // **`app.roles[].id` には今日も `not` が1つも無い**(本廃止は役割の側を1バイトも触っていない)。
    const roleId = readManifestSchema().$defs.app.properties.roles.items.properties.id as Any;
    expect(roleId.not).toBeUndefined();
  });

  test("裁定の理由3つ (a)(b)(c) が `$comment` に逐語で在る", () => {
    const idSchema = accessControlSchema().properties.permissions.items.properties.id as Any;
    expect(idSchema.$comment).toContain("src/auth/types.ts:62 の RESERVED_ROLES そのもの");
    expect(idSchema.$comment).toContain("$defs/view.audience の値である");
    expect(idSchema.$comment).toContain("AI が覚える規則が1つ**減る**");
  });

  test("**`user_kinds` の理由を流用していないこと**が `$comment` に書いてある", () => {
    const idSchema = accessControlSchema().properties.permissions.items.properties.id as Any;
    expect(idSchema.$comment).toContain("名前空間の衝突");
    expect(idSchema.$comment).toContain("先例の流用ではない");
  });

  test("`description` にも予約4語が書いてある(schema を読む人が先に気づける)", () => {
    const idSchema = accessControlSchema().properties.permissions.items.properties.id as Any;
    expect(idSchema.description).toContain("owner / editor / viewer / anonymous は書けない");
  });
});

// --- (7) 増分の総量(**1つも動かしていないもの**)---------------------------------------------

describe("(7) `V7-M2-T01` が動かしていないもの", () => {
  // **【`V8-M18` / 台帳 `J-G12` による期待値の更新。2026-08-09】** **旧テスト名の逐語**:
  // 「**`$defs` は 28 のまま / `$defs/table.properties` は 6キーのまま**」。
  // **旧本体の逐語**: `expect(Object.keys(schema.$defs)).toHaveLength(28)`。
  // **`V7-M2-T01` は今日も `$defs` を1本も動かしていない** —— **28 → 29 にしたのは
  // `V8-M18` が新設した `role_condition` 1本だけである。****旧文を1バイトも消していない。**
  test("`$defs` は 29(増やしたのは V8-M18 の1本だけ)/ `$defs/table.properties` は 6キーのまま", () => {
    const schema = readManifestSchema();
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 29 → 30 へ書き換えた。**
    // **旧行の逐語**: `expect(Object.keys(schema.$defs)).toHaveLength(29);`
    // **書き換えた理由**: この行が固定していたのは「**その決定**が新しい `$defs` を作らなかったこと」
    // であり、**30本目を作ったのは別の決定である**(`V8-M8` が集計表の中身 `$defs/report` を新設した)。
    // **検査は消していない。**
    expect(Object.keys(schema.$defs)).toHaveLength(30);
    expect(Object.keys(schema.$defs)).toContain("role_condition");
    expect(Object.keys(schema.$defs.table.properties)).toEqual([
      "id",
      "name",
      "fields",
      "representative_field",
      "reference_search_fields",
      "access_control",
    ]);
    expect(schema.$defs.table.required).toEqual(["id", "name", "fields"]);
  });

  test("`permissions` の要素は今日も5キーちょうどである(`Z-G10` 限定 (2))", () => {
    const item = accessControlSchema().properties.permissions.items as Any;
    expect(Object.keys(item.properties)).toEqual(["id", "name", "read", "write", "delete"]);
    expect(item.required).toEqual(["id", "name", "read", "write", "delete"]);
    expect(item.additionalProperties).toBe(false);
  });

  test("**完了条件 (iv)**: `user_kinds` は今日 `$defs/app` に1本も無い(器ごと廃止された)", () => {
    // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`】旧テスト名の逐語**:
    // 「**完了条件 (iv)**: `user_kinds` の要素キーは `id` / `name` の2本のままである」。
    // **旧の本体(逐語)**:
    //
    //     const item = readManifestSchema().$defs.app.properties.user_kinds.items as Any;
    //     expect(Object.keys(item.properties).sort()).toEqual(["id", "name"]);
    //     expect(item.additionalProperties).toBe(false);
    //
    // **`Z-G10` 限定 (5) の「`user_kinds` の中に1バイトも書かない」は、今日は
    // 「書く中身が無い」という形で満たされている。** **これを「守った」とは書かない。**
    const appProperties = readManifestSchema().$defs.app.properties as Any;
    expect(Object.hasOwn(appProperties, "user_kinds")).toBe(false);
    expect(Object.keys(appProperties)).toHaveLength(8);
  });

  test("`src/kernel/referential-integrity.ts` の公開エクスポートは今日も1本である(`Z-G10` `S2`)", () => {
    const source = readFileSync(join(ROOT, "src", "kernel", "referential-integrity.ts"), "utf8");
    const exported = source.split("\n").filter((line) => line.startsWith("export "));
    expect(exported).toHaveLength(1);
    expect(exported[0]).toContain("validateReferentialIntegrity");
  });
});
