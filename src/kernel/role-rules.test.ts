/**
 * **役割に「できること」を束ねる**(`V8-M17`。台帳 `J-G6` / `J-G7` / `J-G8` / `J-G9` /
 * `J-G10` / `J-G11`。メインの裁定 `R-1` / `R-2` / `R-4` / `R-13`)。
 *
 * **`V8-M16` が立てた器(`$defs/app.roles` / `set_roles` / `$defs/operation.properties.roles`)の
 * 内側を作る。** 器そのものの検査は `src/kernel/roles-diff-op.test.ts` にあり、
 * **本ファイルはそこに1行も重複させない**(あちらは器、こちらは内側)。
 *
 * ## この検査が測るもの(**先に書く**)
 *
 * 1. **`roles[]` の要素が `id` / `name` / `rules` の3キーで閉じること。**
 * 2. **`rules[]` の1本が「対象 × 動詞」であること** —— **対象は4種ちょうど**(表 / 項目 /
 *    画面 / ボタン)、**動詞は3語ちょうど**(`read` / `write` / `delete`。`J-G10`)。
 * 3. **対象ごとに書ける動詞の部分集合が確定形で固定されていること**(`J-G10` の限定の逐語)
 *    —— 表 = 読取/書込/削除・項目 = 読取/書込・画面 = 読取・ボタン = 読取。
 *    **これ以外の組を書いた差分が `apply` 時に拒否されること**(完了条件 (ii))。
 * 4. **`anonymous` の要素だけ、対象から項目が除かれ、動詞が読取に絞られること**
 *    (`J-G11` の限定の逐語。**分岐は `schemas/manifest.schema.json` に書く。サーバ層で
 *    握りつぶさない**)。
 * 5. **拒否(deny)を表す値域が1つも無いこと**(`J-G2` の限定「引き算を1つも書けない」)。
 * 6. **【`V8-M26` / `D-V8-66`(2026-08-10)で反転した】旧の逐語は「**対象が指す先の実在検査**
 *    (表ID・項目ID・画面ID・ボタンID)が適用時に効くこと(`src/kernel/referential-integrity.ts`)」。
 *    **今日は逆である** —— **役割の規則については、実在しない先を名指ししても拒否しない。**
 *    詳細と根拠は下の (T-6) 群と `src/kernel/role-rule-stale-target.test.ts` に書いた。
 * 7. **`$defs/view_action` にボタンの識別子のキーが1本増えて9キーになること**(`J-G9`)、
 *    **同じ画面の中で識別子が重複しないこと。**
 * 8. **`set_roles` が `rules` を含めて全体差し替えできること。**
 *
 * ## この検査が測らないもの(**誇張しない**)
 *
 * 1. **判定の実装は本タスクに1バイトも無い。** **役割に規則を書いても、行の読取・書込・
 *    削除のふるまいは今日どおりである** —— **サーバ層の判定は次の担当(`V8-M19` 系)が書く。**
 *    **`src/server/` を1バイトも触っていない。**
 * 2. **条件(`when`)を1バイトも作っていない**(`V8-M18` の担当)。
 * 3. **既定の役割定義3本(`owner` / `editor` / `viewer`)に `rules` を1本も入れていない**
 *    (裁定 `R-13-3`)—— **したがって「宣言0件の新しいアプリの既定は着手前と同じ」である。**
 * 4. **`V8-M17` 時点では、面(役割の規則)と点(v7 の行ごとの付与)は AND である。**
 *    **`V8-M19` が `D-V8-23` に従って OR に変える**(裁定 `R-13-4`)。
 *    **【禁止】「一時的だから問題ない」と書かない。**
 * 5. **ブラウザで画面を1枚も開いていない。MCP サーバも1度も起動していない。**
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import diffSchema from "../../schemas/diff.schema.json" with { type: "json" };
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import { applyDiff } from "./apply-diff.ts";
import { applyManifest, readCurrentManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { DIFF_OPS, type Diff, type Manifest, type RoleRule } from "./types.ts";

type Any = Record<string, unknown>;

const APP_ID = "shop";

let dataRoot: string;
let store: KernelMetaStore;

/**
 * 4対象すべてを名指しできる土台。
 *
 * - 表 = `orders` / 項目 = `orders.memo`
 * - 画面 = `order-list`(一覧)/ `order-detail`(詳細)
 * - ボタン = `order-detail` の操作起点 `mark-done`(値の書換の形。`ADR-0100`)
 */
function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "店",
      tables: [
        {
          id: "orders",
          name: "注文",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "memo", name: "備考", type: "text" },
          ],
        },
      ],
      views: [
        { id: "order-list", type: "list_view", table: "orders", columns: ["title"] },
        {
          id: "order-detail",
          type: "detail_view",
          table: "orders",
          fields: ["title", "memo"],
          actions: [{ id: "mark-done", name: "完了にする", set: { field: "title", value: "済" } }],
        },
      ],
    },
  } as unknown as Manifest;
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-role-rules-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "店", { app_id: APP_ID });
  const applied = applyManifest(dataRoot, APP_ID, baseManifest());
  if (!applied.valid) {
    throw new Error(
      `テスト前提の初期マニフェスト投入に失敗しました: ${JSON.stringify(applied.errors)}`,
    );
  }
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

function setRolesDiff(roles: unknown, diffId = "d1"): Diff {
  return {
    diff_id: diffId,
    intent: "役割に規則を束ねる",
    operations: [{ op: "set_roles", roles }],
  } as unknown as Diff;
}

/**
 * 既定の役割定義3本(`owner` / `editor` / `viewer`)を先頭に足す。
 *
 * **`V8-M17` が「既定3本は消せない」を適用時検査で塞いだ**(台帳 `J-G2` / `D-V8-26` /
 * メインの判断)ので、**`set_roles` を打つ検査はどれも3本を含めて書く必要がある。**
 * **既に書かれている `id` は二重に足さない**(重複は別の検査が拒否する)。
 *
 * **【2026-08-11 追記(`V8-M28`。台帳 `T-G16a` = 限定採用。ユーザ決定 `D-V8-59`)。
 * 旧の実装の逐語を残す。1バイトも消していない】**
 * **旧: `...["owner", "editor", "viewer"].filter((id) => !declared.has(id)).map((id) => ({ id })),`**
 * —— **既定3本を「`id` だけの箱」で足していた。**
 * **今日はそれでは通らない** —— **類型17 の拡張が、`owner` に
 * `{"target":"app","can":["write"]}` と `{"target":"role","can":["write"]}` の
 * **2本とも**在ることを要求する**(片方でも欠けた `set_roles` は拒否される)。
 */
const OWNER_DEFINITION_RULES: Any[] = [
  { target: "app", can: ["write"] },
  { target: "role", can: ["write"] },
];

function withDefaults(roles: Any[]): Any[] {
  const declared = new Set(roles.map((role) => role.id as string));
  return [
    ...["owner", "editor", "viewer"]
      .filter((id) => !declared.has(id))
      .map((id) =>
        id === "owner" ? { id, rules: structuredClone(OWNER_DEFINITION_RULES) } : { id },
      ),
    ...roles,
  ];
}

/** 1つの役割に規則を1本だけ束ねて適用する(`member` は予約語ではない普通の役割)。 */
function applyRule(rule: unknown, roleId = "member"): ReturnType<typeof applyDiff> {
  return applyDiff(
    dataRoot,
    APP_ID,
    setRolesDiff(withDefaults([{ id: roleId, name: "会員", rules: [rule] }])),
  );
}

function appliedRoles(result: ReturnType<typeof applyDiff>): unknown {
  return result.valid ? (result.manifest.app as unknown as Any).roles : undefined;
}

function manifestDefs(): Record<string, Any> {
  return (manifestSchema as unknown as { $defs: Record<string, Any> }).$defs;
}

function rolesSchema(): Any {
  return ((manifestDefs().app?.properties as Any)?.roles ?? {}) as Any;
}

function roleItemSchema(): Any {
  return (rolesSchema().items ?? {}) as Any;
}

function rulesSchema(): Any {
  return ((roleItemSchema().properties as Any).rules ?? {}) as Any;
}

function ruleItemSchema(): Any {
  return (rulesSchema().items ?? {}) as Any;
}

/** `rules[]` の `allOf` から、対象名で分岐を引く。 */
function ruleBranch(target: string): Any | undefined {
  return ((ruleItemSchema().allOf ?? []) as Any[]).find(
    (branch) => ((((branch.if as Any)?.properties ?? {}) as Any).target as Any)?.const === target,
  );
}

// ===========================================================================
// (T-1) 宣言の器 —— `roles[]` の3キー目
// ===========================================================================

describe("(T-1) `roles[]` の要素は `id` / `name` / `rules` の3キーで閉じる", () => {
  test("要素のキーは3つで、`additionalProperties` は false のままである", () => {
    // **`V8-M16` は2キーで閉じていた。****3キー目 `rules` を足したのは `V8-M17` である**
    // (裁定 `R-1` の表 = 「`roles[]` の3キー目 `rules` は `V8-M17`」)。
    //
    // **【2026-08-14 追記(`V8-M1-T02`。台帳 `I-G1` / `I-G6` = どちらも 限定採用。
    // `ADR-0334` 限定1)。上の2行と旧の期待値を1バイトも消していない】**
    // **旧(逐語)**: `expect(Object.keys(roleItemSchema().properties as Any)).toEqual(["id", "name", "rules"]);`
    // **4キー目 `signup`(この役割で登録できるか)を `V8-M1-T02` が足した。**
    // **`ADR-0322` 限定4 の検査の期待値を `7 / 3 / 3` → `7 / 4 / 3` に入れ替えるという
    // `ADR-0334` 限定1 の指示の履行である。****テスト名の「3キー」は当時の逐語である**
    // (テスト名は書き換えない)。**並びは宣言順そのものであり、`signup` は末尾に在る**
    // —— **`ADR-0334` の限定表と `schemas/manifest.schema.json` の新設 `$comment` が
    // どちらも「`id` / `name` / `rules` / `signup` の4キーで閉じる」と書いているので、
    // 宣言順をその文言に揃えた。****当初は `name` と `rules` の間に挿入しており、
    // 文言と宣言順が食い違っていた** —— **見つけたのは `V8-M1-T07`(語彙の名前の一覧
    // との突合)であって、`V8-M1-T02` の検査ではない。**
    expect(Object.keys(roleItemSchema().properties as Any)).toEqual([
      "id",
      "name",
      "rules",
      "signup",
    ]);
    expect(roleItemSchema().additionalProperties).toBe(false);
    expect(roleItemSchema().required).toEqual(["id"]);
  });

  test("条件(`when`)の綴りは1つだけである(`condition` / `filter` を作っていない)", () => {
    // **旧テスト名の逐語**: 「**条件(`when`)を1バイトも作っていない(`V8-M18` の
    // 担当である)**」。**旧本体の逐語**:
    // `expect((ruleItemSchema().properties as Any).when).toBeUndefined()`。
    //
    // **【`V8-M18` / 台帳 `J-G12`〜`J-G16` による追随。2026-08-09】**
    // **`when` は `V8-M18` が足した**(旧テスト名が名指しで予告していたとおりである)。
    // **主張の残り(同じことを指す2つ目・3つ目の綴りを作らない)は1ミリも弱めていない。**
    // **`when` の中身の検査は `src/kernel/role-conditions.test.ts` に在る**(重複させない)。
    expect((ruleItemSchema().properties as Any).when).toBeDefined();
    expect((ruleItemSchema().properties as Any).condition).toBeUndefined();
    expect((ruleItemSchema().properties as Any).filter).toBeUndefined();
  });

  test("`$defs` の総数は 29 である(28 → 29 にしたのは `V8-M18` の1本だけ)", () => {
    // **旧テスト名の逐語**: 「**`$defs` の総数は 28 のままである(`V8-M18` だけが
    // 29 にする)**」。**旧本体の逐語**:
    // `expect(Object.keys(manifestDefs())).toHaveLength(28)`。
    //
    // **【`V8-M18` / 台帳 `J-G12` による追随。2026-08-09】** **旧テスト名が名指しで
    // 予告した1本(`role_condition`)が入った。****`V8-M17` の増分は今日も `$defs` を
    // 1本も増やしていない。****旧文を1バイトも消していない。**
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 29 → 30 へ書き換えた。**
    // **旧行の逐語**: `expect(Object.keys(manifestDefs())).toHaveLength(29);`
    // **書き換えた理由**: この行が固定していたのは「**その決定**が新しい `$defs` を作らなかったこと」
    // であり、**30本目を作ったのは別の決定である**(`V8-M8` が集計表の中身 `$defs/report` を新設した)。
    // **検査は消していない。**
    expect(Object.keys(manifestDefs())).toHaveLength(30);
    expect(Object.keys(manifestDefs())).toContain("role_condition");
  });

  test("`rules` は省略でき、省略は「面の管轄外(全許可)」を意味する(裁定 `R-4`)", () => {
    const roles = withDefaults([{ id: "member", name: "会員" }]);
    const result = applyDiff(dataRoot, APP_ID, setRolesDiff(roles));
    expect(result.valid).toBe(true);
    expect(appliedRoles(result)).toEqual(roles);
  });

  test("空の `rules` は拒否される(「規則を0本書く」と「書かない」を2通りにしない)", () => {
    expect(
      applyDiff(dataRoot, APP_ID, setRolesDiff(withDefaults([{ id: "member", rules: [] }]))).valid,
    ).toBe(false);
  });
});

// ===========================================================================
// (T-2) 4対象それぞれについて、宣言できて読み出せる(**完了条件 (ii) / 4つを別々に**)
// ===========================================================================

describe("(T-2) 4対象それぞれを宣言でき、読み出せる(`J-G6` / `J-G7` / `J-G8` / `J-G9`)", () => {
  test("対象 = 表(`J-G6`): 読取・書込・削除の3語を束ねられる", () => {
    const rule = { target: "table", table: "orders", can: ["read", "write", "delete"] };
    const result = applyRule(rule);
    expect(result.valid).toBe(true);
    expect(appliedRoles(result)).toEqual(
      withDefaults([{ id: "member", name: "会員", rules: [rule] }]),
    );
  });

  test("対象 = 項目(`J-G7`): 読取と書込を別々に書ける", () => {
    const rule = { target: "field", table: "orders", field: "memo", can: ["read"] };
    const result = applyRule(rule);
    expect(result.valid).toBe(true);
    expect(appliedRoles(result)).toEqual(
      withDefaults([{ id: "member", name: "会員", rules: [rule] }]),
    );
    const both = { target: "field", table: "orders", field: "memo", can: ["read", "write"] };
    expect(
      applyDiff(
        dataRoot,
        APP_ID,
        setRolesDiff(withDefaults([{ id: "member", rules: [both] }]), "d2"),
      ).valid,
    ).toBe(true);
  });

  test("対象 = 画面(`J-G8`): 読取だけを書ける", () => {
    const rule = { target: "view", view: "order-list", can: ["read"] };
    const result = applyRule(rule);
    expect(result.valid).toBe(true);
    expect(appliedRoles(result)).toEqual(
      withDefaults([{ id: "member", name: "会員", rules: [rule] }]),
    );
  });

  test("対象 = ボタン(`J-G9`): 画面とボタンの識別子で名指しして読取を書ける", () => {
    const rule = { target: "action", view: "order-detail", action: "mark-done", can: ["read"] };
    const result = applyRule(rule);
    expect(result.valid).toBe(true);
    expect(appliedRoles(result)).toEqual(
      withDefaults([{ id: "member", name: "会員", rules: [rule] }]),
    );
  });

  test("4対象を1つの役割に同居させられる(規則は独立している)", () => {
    const rules = [
      { target: "table", table: "orders", can: ["read"] },
      { target: "field", table: "orders", field: "memo", can: ["read", "write"] },
      { target: "view", view: "order-list", can: ["read"] },
      { target: "action", view: "order-detail", action: "mark-done", can: ["read"] },
    ];
    const roles = withDefaults([{ id: "member", rules }]);
    const result = applyDiff(dataRoot, APP_ID, setRolesDiff(roles));
    expect(result.valid).toBe(true);
    expect(appliedRoles(result)).toEqual(roles);
  });
});

// ===========================================================================
// (T-3) 値域 —— 対象4種ちょうど・動詞3語ちょうど(`J-G10`)
// ===========================================================================

describe("(T-3) 対象は4種ちょうど・動詞は3語ちょうどで閉じる(`J-G10` の限定の逐語)", () => {
  test("対象の値域は table / field / view / action / app / role の6つである", () => {
    // **旧テスト名の逐語**: 「**対象の値域は table / field / view / action の4つだけである**」。
    // **旧本体の逐語**: `expect((ruleItemSchema().properties as Any).target).toMatchObject({`
    // `  enum: ["table", "field", "view", "action"],` `});`
    //
    // **【`V8-M28`(2026-08-11)。台帳 `T-G14` / `T-G17`(どちらも **限定採用**)。
    // ユーザ決定 `D-V8-49`】** **`ADR-0304` 限定2「対象は4種ちょうど。5種目を足さない」を
    // 正面から破った。****破ってよい根拠は `ADR-0007` §8 の台帳2行の判定であり、
    // 「破っていない」と書けない。****旧の期待値を1バイトも消していない。**
    expect((ruleItemSchema().properties as Any).target).toMatchObject({
      enum: ["table", "field", "view", "action", "app", "role"],
    });
  });

  test("動詞の値域は read / write / delete の3語だけである", () => {
    const can = (ruleItemSchema().properties as Any).can as Any;
    expect((can.items as Any).enum).toEqual(["read", "write", "delete"]);
    expect(can.minItems).toBe(1);
    expect(can.uniqueItems).toBe(true);
  });

  test("値域の外の対象を書いた差分は拒否される", () => {
    // **旧テスト名の逐語**: 「**5種目の対象を書いた差分は拒否される**」。
    // **旧本体の逐語**: `for (const target of ["workflow", "function", "app", "record", "column"]) {`
    //
    // **【`V8-M28`】`app` は今日は値域の中に在る**(`T-G14` = 限定採用)——
    // **旧の並びから `app` を外した。****`role` も同様に値域の中である**(`T-G17`)。
    // **【正直に書く】旧の並びの `app` は、今日この形(`table` を併記し `can` が `read`)でも
    // 拒否されるが、拒否する理由が「知らない対象だから」から「`app` の分岐が `table` を
    // 閉じ、動詞を `write` 1語に絞っているから」へ変わっている。**
    // **その別々の拒否は下の (T-11) が対象ごとに測る。**
    for (const target of ["workflow", "function", "record", "column"]) {
      expect(applyRule({ target, table: "orders", can: ["read"] }).valid).toBe(false);
    }
  });

  test("4語目の動詞を書いた差分は拒否される", () => {
    for (const verb of ["create", "update", "publish", "admin", "export"]) {
      expect(applyRule({ target: "table", table: "orders", can: [verb] }).valid).toBe(false);
    }
  });

  test("拒否(deny)を表す値域を1つも作っていない(`J-G2` の限定「引き算を1つも書けない」)", () => {
    const source = JSON.stringify(rulesSchema());
    for (const forbidden of [
      '"deny"',
      '"denied"',
      '"forbid"',
      '"revoke"',
      '"except"',
      '"cannot"',
      '"effect"',
    ]) {
      expect(source).not.toContain(forbidden);
    }
    // **動詞は真偽値ではなく列挙の配列である** —— **`write: false` の形を作ると
    // 「書けない」と書けてしまい、それは引き算である。**
    expect((ruleItemSchema().properties as Any).can).toMatchObject({ type: "array" });
  });

  test("`can` を省略した規則は拒否される(「対象だけ書いて動詞を書かない」を作らない)", () => {
    expect(applyRule({ target: "table", table: "orders" }).valid).toBe(false);
    expect(ruleItemSchema().required).toEqual(["target", "can"]);
  });
});

// ===========================================================================
// (T-4) 対象ごとの動詞の部分集合 —— **確定形で固定し、外は `apply` が拒否する**
//        (完了条件 (ii)。**4対象ぶんを別々の `test()` にする**)
// ===========================================================================

describe("(T-4) 対象ごとに書ける動詞の部分集合は、スキーマの `if`/`then` で確定形に固定されている", () => {
  test("表 = 読取 / 書込 / 削除(3語すべて。部分集合の外は無い)", () => {
    const branch = ruleBranch("table");
    expect(branch).toBeDefined();
    const can = (((branch?.then as Any)?.properties ?? {}) as Any).can as Any;
    expect((can.items as Any).enum).toEqual(["read", "write", "delete"]);
    expect((branch?.then as Any)?.required).toEqual(["table"]);
  });

  test("項目 = 読取 / 書込(**削除は書けない**)。削除を書いた差分は `apply` 時に拒否される", () => {
    const branch = ruleBranch("field");
    const can = (((branch?.then as Any)?.properties ?? {}) as Any).can as Any;
    expect((can.items as Any).enum).toEqual(["read", "write"]);
    expect(
      applyRule({ target: "field", table: "orders", field: "memo", can: ["delete"] }).valid,
    ).toBe(false);
    expect(
      applyRule({ target: "field", table: "orders", field: "memo", can: ["read", "delete"] }).valid,
    ).toBe(false);
  });

  test("画面 = 読取だけ(**書込・削除は書けない**)。書いた差分は `apply` 時に拒否される", () => {
    const branch = ruleBranch("view");
    const can = (((branch?.then as Any)?.properties ?? {}) as Any).can as Any;
    expect((can.items as Any).const).toBe("read");
    expect(applyRule({ target: "view", view: "order-list", can: ["write"] }).valid).toBe(false);
    expect(applyRule({ target: "view", view: "order-list", can: ["delete"] }).valid).toBe(false);
    expect(applyRule({ target: "view", view: "order-list", can: ["read", "write"] }).valid).toBe(
      false,
    );
  });

  test("ボタン = 読取だけ(**書込・削除は書けない**)。書いた差分は `apply` 時に拒否される", () => {
    const branch = ruleBranch("action");
    const can = (((branch?.then as Any)?.properties ?? {}) as Any).can as Any;
    expect((can.items as Any).const).toBe("read");
    const base = { target: "action", view: "order-detail", action: "mark-done" };
    expect(applyRule({ ...base, can: ["write"] }).valid).toBe(false);
    expect(applyRule({ ...base, can: ["delete"] }).valid).toBe(false);
  });

  test("対象ごとに書けるキーも確定形に固定されている(余分なキーを書くと拒否される)", () => {
    // 表の規則に項目IDを書く / 画面の規則に表IDを書く、はどちらも「書けるが効かない
    // 組み合わせ」になる。**`ADR-0086` 限定4 の作法どおり、書けなくする。**
    expect(
      applyRule({ target: "table", table: "orders", field: "memo", can: ["read"] }).valid,
    ).toBe(false);
    expect(
      applyRule({ target: "view", view: "order-list", table: "orders", can: ["read"] }).valid,
    ).toBe(false);
    expect(applyRule({ target: "table", view: "order-list", can: ["read"] }).valid).toBe(false);
    expect(applyRule({ target: "action", view: "order-detail", can: ["read"] }).valid).toBe(false);
  });
});

// ===========================================================================
// (T-5) 未ログインの非対称(`J-G11`)—— **分岐はスキーマに書く**
// ===========================================================================

describe("(T-5) `anonymous` の要素だけ、対象から項目が除かれ、動詞が読取に絞られる(`J-G11`)", () => {
  test("分岐は `schemas/manifest.schema.json` に書いてある(サーバ層で握りつぶさない)", () => {
    const branches = (roleItemSchema().allOf ?? []) as Any[];
    const anonymous = branches.find(
      (branch) =>
        ((((branch.if as Any)?.properties ?? {}) as Any).id as Any)?.const === "anonymous",
    );
    expect(anonymous).toBeDefined();
    const items = ((((anonymous?.then as Any)?.properties ?? {}) as Any).rules as Any)
      ?.items as Any;
    expect(((items.properties as Any).target as Any).enum).toEqual(["table", "view", "action"]);
    expect((((items.properties as Any).can as Any).items as Any).const).toBe("read");
  });

  test("`anonymous` に項目の規則を書いた差分は拒否される", () => {
    const rule = { target: "field", table: "orders", field: "memo", can: ["read"] };
    expect(applyRule(rule, "anonymous").valid).toBe(false);
  });

  test("`anonymous` に書込を書いた差分は拒否される", () => {
    expect(applyRule({ target: "table", table: "orders", can: ["write"] }, "anonymous").valid).toBe(
      false,
    );
    expect(
      applyRule({ target: "table", table: "orders", can: ["read", "write"] }, "anonymous").valid,
    ).toBe(false);
  });

  test("`anonymous` に削除を書いた差分は拒否される", () => {
    expect(
      applyRule({ target: "table", table: "orders", can: ["delete"] }, "anonymous").valid,
    ).toBe(false);
  });

  test("`anonymous` でも表・画面・ボタンの読取は書ける(非対称は項目と動詞だけである)", () => {
    const rules = [
      { target: "table", table: "orders", can: ["read"] },
      { target: "view", view: "order-list", can: ["read"] },
      { target: "action", view: "order-detail", action: "mark-done", can: ["read"] },
    ];
    const roles = withDefaults([{ id: "anonymous", rules }]);
    const result = applyDiff(dataRoot, APP_ID, setRolesDiff(roles));
    expect(result.valid).toBe(true);
    expect(appliedRoles(result)).toEqual(roles);
  });

  test("非対称は `anonymous` にだけ効く(`viewer` は項目にも書込にも書ける)", () => {
    expect(
      applyRule({ target: "field", table: "orders", field: "memo", can: ["write"] }, "viewer")
        .valid,
    ).toBe(true);
  });
});

// ===========================================================================
// (T-6) 対象が指す先の実在検査 —— **`D-V8-66` で撤去された**
// ===========================================================================

/**
 * **【期待値を反転させた。黙って書き換えていない。2026-08-10】**
 *
 * **旧の describe の逐語**: 「(T-6) 対象が指す先が実在しない規則は `apply` 時に拒否される」。
 * **旧の各 test の逐語と期待値**(すべて `valid === false` を期待していた):
 *
 *  - 「実在しない表IDは拒否される」
 *  - 「実在しない項目IDは拒否される(表は実在する)」
 *  - 「実在しない画面IDは拒否される」
 *  - 「実在しないボタンIDは拒否される(画面は実在する)」
 *  - 「ボタンIDが別の画面にあるだけでは拒否される(画面ごとに名指しする)」
 *  - 「エラーは `/app/roles/<i>/rules/<j>/...` の位置を指す」
 *
 * **反転の根拠**: **ユーザ決定 `D-V8-66`(2026-08-10)** ——
 * 「画面はそのまま消せますが、それを名指ししていた権限の行がアプリに残ります。…
 * この基盤は『書けるが必ず効かない宣言を1つも作らない』を明文で守っており、そこを破ります。」
 * **破られた明文の所在は `docs/adr/0086-field-value-unit.md:120`。**
 * **実装の撤去箇所は `src/kernel/referential-integrity.ts` の類型16。**
 *
 * **緩んだのは役割の規則だけである** —— **表・項目・画面そのものの参照整合性は今日どおり
 * 拒否される**(実測は `src/kernel/role-rule-stale-target.test.ts` の (D) 群)。
 */
describe("(T-6) 対象が指す先が実在しない規則も `apply` を通る(`D-V8-66` で反転)", () => {
  test("実在しない表IDは通る(旧: 拒否される)", () => {
    expect(applyRule({ target: "table", table: "ghosts", can: ["read"] }).valid).toBe(true);
  });

  test("実在しない項目IDは通る(表は実在する。旧: 拒否される)", () => {
    expect(
      applyRule({ target: "field", table: "orders", field: "ghost", can: ["read"] }).valid,
    ).toBe(true);
  });

  test("実在しない画面IDは通る(旧: 拒否される)", () => {
    expect(applyRule({ target: "view", view: "ghost-list", can: ["read"] }).valid).toBe(true);
  });

  test("実在しないボタンIDは通る(画面は実在する。旧: 拒否される)", () => {
    expect(
      applyRule({ target: "action", view: "order-detail", action: "ghost", can: ["read"] }).valid,
    ).toBe(true);
  });

  test("ボタンIDが別の画面にあるだけでも通る(旧: 画面ごとに名指しを要求していた)", () => {
    expect(
      applyRule({ target: "action", view: "order-list", action: "mark-done", can: ["read"] }).valid,
    ).toBe(true);
  });

  test("`/app/roles/<i>/rules/<j>/...` を指すエラーが1件も出ない(旧: 位置を指していた)", () => {
    const result = applyRule({ target: "table", table: "ghosts", can: ["read"] });
    expect(result.valid).toBe(true);
    // **旧はここで `/\/app\/roles\/\d+\/rules\/0\/table/` に一致することを期待していた。**
    // **今日は差分が通るので、そもそもエラー配列が無い。**
  });
});

// ===========================================================================
// (T-7) ボタンの識別子(`J-G9`)—— `$defs/view_action` は9キーになる
// ===========================================================================

describe("(T-7) `$defs/view_action` に識別子のキーが1本増えた(`V8-M17` 時点で9キー)", () => {
  test("キーは8つである(**`V8-M20` が `audience` を消して8キーに戻った**)", () => {
    // **【禁止】キー数の期待値を1つの数字に揃えない**(裁定 `R-13-1` / 申し送り2)——
    // **揃えると `V8-M17` と `V8-M20` の完了条件が互いを赤くする。**
    // **【`V8-M20-T01` / 台帳 `J-G29` / 手続きは `ADR-0301`。2026-08-10】**
    // **`audience` が廃止されたので、予告どおり 9 → 8 にした。旧値の逐語は 9。**
    // **`V8-M17` が足した `id` は今日も在る**(下の `toContain("id")` が測っている)。
    const properties = Object.keys((manifestDefs().view_action?.properties as Any) ?? {});
    expect(properties).toHaveLength(8);
    expect(properties).toContain("id");
  });

  test("識別子は既存の `$defs/resource_id` を `$ref` する(新しい値域を作らない)", () => {
    const id = ((manifestDefs().view_action?.properties as Any)?.id ?? {}) as Any;
    expect(id.$ref).toBe("#/$defs/resource_id");
  });

  test("識別子は任意である(書いていない既存のボタンは今日どおり通る)", () => {
    // **required に入れると既存マニフェストが全部 invalid になる**
    // (`workflows` / `functions` / `theme` / `user_kinds` / `roles` と同じ理由)。
    const manifest = baseManifest();
    const actions = ((manifest.app.views[1] as unknown as Any | undefined)?.actions ?? []) as Any[];
    delete actions[0]?.id;
    const result = applyManifest(dataRoot, APP_ID, manifest);
    expect(result.valid).toBe(true);
  });

  test("同じ画面の中で識別子が重複したら `apply` 時に拒否される", () => {
    const manifest = baseManifest();
    (manifest.app.views[1] as unknown as Any).actions = [
      { id: "mark-done", set: { field: "title", value: "済" } },
      { id: "mark-done", set: { field: "memo", value: "x" } },
    ];
    const result = applyManifest(dataRoot, APP_ID, manifest);
    expect(result.valid).toBe(false);
  });

  test("別の画面なら同じ識別子を書ける(一意なのは画面の中だけである)", () => {
    const manifest = baseManifest();
    manifest.app.views.push({
      id: "order-detail-2",
      type: "detail_view",
      table: "orders",
      fields: ["title"],
      actions: [{ id: "mark-done", set: { field: "title", value: "済" } }],
    } as unknown as (typeof manifest.app.views)[number]);
    expect(applyManifest(dataRoot, APP_ID, manifest).valid).toBe(true);
  });

  /*
   * **【`V8-M20-T04` / 台帳 `J-G27` / `J-G28` / `J-G29` / 手続きは `ADR-0301`。2026-08-10】**
   *
   * **`src/kernel/view-action-audience.test.ts` をファイルごと消した。****消したのは
   * 「赤いから」ではなく、そのファイルが測っていたキー(`$defs/view_action.audience`)が
   * 今日は1つも存在しないからである。**
   *
   * **消したテスト名(逐語。19本)**:
   *   1. 「$defs/field.properties の本数は 12 のまま(項目単位にも足していない)」
   *   2. 「$defs/view_action.properties は 8 → 9(`ADR-0177` が増やしたのは audience 1本だけ)」
   *   3. 「$defs/view_action.additionalProperties は false のままである」
   *   4. 「view_action.audience は $defs/view/properties/audience を $ref で指す」
   *   5. 「view_action.audience は enum も items も自分で持たない(宣言された種類を含む値域と必ず一致する)」
   *   6. 「値域の本体は今日も $defs/view/properties/audience の1箇所にしかない」
   *   7. 「遷移の形(form + prefill)に audience を書いたマニフェストが検証を通る」
   *   8. 「行き先の宣言(view)に audience を書いたマニフェストが検証を通る」
   *   9. 「値の書換(set)に audience を書いたマニフェストが検証を通る」
   *  10. 「audience を1つも書かないマニフェストは今日どおり通る(既定を反転させていない)」
   *  11. 「anonymous も書ける(値域は $defs/view/properties/audience そのものである)」
   *  12. 「値域の外の文字列は拒否される(**拒否する層が schema から適用時検査へ移った**)」
   *  13. 「空配列は拒否される(minItems: 1 を $ref がそのまま運ぶ)」
   *  14. 「重複した値は拒否される(uniqueItems を $ref がそのまま運ぶ)」
   *  15. 「FIELD_TYPES は 9 である(8 → 9 にしたのは V5-M16 であって本 ADR ではない)」
   *  16. 「$defs/view_changes.properties に audience が1本も無い」
   *  17. 「view_changes は actions を持っている(audience はその全置換に相乗りする)」
   *  18. 「$defs/related_block に audience が1本も無い」
   *  19. 「audience を持つ $defs は view / field / view_action の3つだけである」
   *
   * **【どれを置き直し、どれを置き直さなかったか】**
   *
   * - **3(`additionalProperties` が false)は置き直していない** —— **同じ検査が
   *   `src/kernel/list-view-action-origin.test.ts` に今日も在る**(逐語
   *   `expect((defs().view_action as Any).additionalProperties).toBe(false);`)。
   * - **2(キーの本数)は置き直していない** —— **すぐ上の (T-7) の1本目が今日も測っている。**
   * - **1(`$defs/field` の本数)は置き直していない** —— **同じ検査が
   *   `src/kernel/view-search-fields.test.ts` ほか十数本に今日も在る。**
   * - **15 は置き直していない** —— **`scripts/vocabulary-drift.test.ts` が中央で測っている。**
   * - **17 は置き直していない** —— **`src/kernel/view-menu-listing.test.ts` の「限定6(改)」が
   *   今日も `toContain("actions")` を測っている。**
   * - **19 / 18(粒度を増やしていない)の面版は置き直し済みである** —— **面の対象は4種
   *   ちょうどであり、それは上の (T-3)「対象の値域は table / field / view / action の
   *   4つだけである」が測っている。****5つ目の粒度を足していないことは、そこで固定される。**
   * - **4 / 5 / 6(値域を二重に持たない)の面版も置き直し済みである** —— **下の (T-8) の
   *   「差分スキーマは値域を二重に持たない(`$ref` 1本のまま)」が測っている。**
   * - **7〜14(値を書けること・値域の外を拒否すること)は置き直していない** ——
   *   **キーが無いので「書ける」も「拒否される」も今日は成立しない。**
   *   **面の同じ問い(規則を書ける / 値域の外を拒否する)は (T-2) 〜 (T-5) が測っている。**
   *
   * **下の1本だけを新しく置いた** —— **「廃止が本当に完了しているか」を測るものは、
   * 着手前どこにも無かったからである。**
   */
  test("廃止された3キー(`audience` / `writable_by`)は、どちらのスキーマにも1本も無い", () => {
    const walk = (node: unknown, hits: string[], path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((child, index) => {
          walk(child, hits, `${path}/${index}`);
        });
        return;
      }
      if (typeof node !== "object" || node === null) return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === "audience" || key === "writable_by") hits.push(`${path}/${key}`);
        walk(value, hits, `${path}/${key}`);
      }
    };
    for (const schema of [manifestSchema, diffSchema]) {
      const hits: string[] = [];
      walk((schema as unknown as { $defs: unknown }).$defs, hits, "$defs");
      expect(hits).toEqual([]);
    }
  });
});

// ===========================================================================
// (T-8) `set_roles` は `rules` を含めて全体差し替えする
// ===========================================================================

describe("(T-8) `set_roles` は `rules` を含めて丸ごと差し替える(部分更新の op は無い)", () => {
  test("規則を持つ宣言で、規則を持たない宣言を上書きできる", () => {
    expect(applyDiff(dataRoot, APP_ID, setRolesDiff(withDefaults([{ id: "member" }]))).valid).toBe(
      true,
    );
    const rules = [{ target: "table", table: "orders", can: ["read"] }];
    const next = withDefaults([{ id: "member", rules }]);
    const result = applyDiff(dataRoot, APP_ID, setRolesDiff(next, "d2"));
    expect(result.valid).toBe(true);
    expect(appliedRoles(result)).toEqual(next);
  });

  test("規則を持たない宣言で、規則を持つ宣言を上書きできる(規則が消える)", () => {
    const rules = [{ target: "table", table: "orders", can: ["read"] }];
    expect(
      applyDiff(dataRoot, APP_ID, setRolesDiff(withDefaults([{ id: "member", rules }]))).valid,
    ).toBe(true);
    const next = withDefaults([{ id: "member" }]);
    const result = applyDiff(dataRoot, APP_ID, setRolesDiff(next, "d2"));
    expect(result.valid).toBe(true);
    expect(appliedRoles(result)).toEqual(next);
  });

  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】**
  // **`set_user_kinds` を撤去したので 18 → 17。**
  // **旧(逐語)**: `expect(DIFF_OPS).toHaveLength(18);`
  // **この検査が測っているのは「`V8-M17` が19種目を足していないこと」であり、そちらは1ミリも弱めていない**
  // (下の禁止5語の絞り込みが今日も測る)。**テスト名の「18」は当時の逐語である**(テスト名は書き換えない)。
  test("`DIFF_OPS` は 18 のままである(19種目を足していない)", () => {
    expect(DIFF_OPS).toHaveLength(17);
    for (const forbidden of ["set_rules", "add_rule", "remove_rule", "grant", "revoke"]) {
      expect(DIFF_OPS as readonly string[]).not.toContain(forbidden);
    }
  });

  test("差分スキーマは値域を二重に持たない(`$ref` 1本のまま)", () => {
    const branches = ((diffSchema as unknown as { $defs: Record<string, Any> }).$defs.operation
      ?.allOf ?? []) as Any[];
    const branch = branches.find(
      (b) => ((((b.if as Any)?.properties ?? {}) as Any).op as Any)?.const === "set_roles",
    );
    const payload = (((branch?.then as Any)?.properties ?? {}) as Any).roles as Any;
    expect(payload.$ref).toBe(
      "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/app/properties/roles",
    );
    expect(payload.items).toBeUndefined();
  });

  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a` / `T-G11`。判定値 = 廃止】**
  // **`user_kinds` キーを撤去したので 10 → 9。**
  // **旧(逐語)**: `expect(Object.keys(operation.properties as Any)).toHaveLength(10);`
  // **この検査が測っているのは「`V8-M17` が11キー目を足していないこと」であり、そちらは1ミリも弱めていない。**
  // **テスト名の「10キー」は当時の逐語である**(テスト名は書き換えない)。
  test("`$defs/operation.properties` は10キーのままである(11キー目を足していない)", () => {
    const operation = ((diffSchema as unknown as { $defs: Record<string, Any> }).$defs.operation ??
      {}) as Any;
    expect(Object.keys(operation.properties as Any)).toHaveLength(9);
  });
});

// ===========================================================================
// (T-9) 型(`src/kernel/types.ts`)—— **サーバ層の担当へ渡す**
// ===========================================================================

describe("(T-9) 型が `rules` を表せる(サーバ層の判定の担当が読む先)", () => {
  test("`RoleRule` は対象4種と動詞3語を型で閉じている", () => {
    // **型検査は `bun run typecheck` が行う。**ここは値として往復できることだけを見る。
    const rules: RoleRule[] = [
      { target: "table", table: "orders", can: ["read", "write", "delete"] },
      { target: "field", table: "orders", field: "memo", can: ["read", "write"] },
      { target: "view", view: "order-list", can: ["read"] },
      { target: "action", view: "order-detail", action: "mark-done", can: ["read"] },
    ];
    const roles = withDefaults([{ id: "member", rules }]);
    const result = applyDiff(dataRoot, APP_ID, setRolesDiff(roles));
    expect(result.valid).toBe(true);
    expect(appliedRoles(result)).toEqual(roles);
  });
});

// ===========================================================================
// (T-10) 既定の役割定義3本(`J-G2`)—— **入っていること。そして消せないこと**
//
// **【2026-08-09。メインの判断で塞いだ】** **見出しの旧文の逐語は
// 「入っていること。そして消せること」である。****1バイトも消していない。**
// **`V8-M17` の実測で「`set_roles` で既定3本を消せる」ことが分かり、メインが塞ぐと
// 決めた** —— 根拠は `04` §7 の `V8-M16` の完了条件 (ii)(運営3ロールが既定の役割として
// 残っていること。`D-V8-26`)と、台帳 `J-G2` の限定(足すことしかできない)である。
// ===========================================================================

describe("(T-10) 既定の役割定義3本(`J-G2`)", () => {
  test("新しく作ったアプリには `owner` / `editor` / `viewer` の3本が最初から在る", () => {
    // **`beforeEach` の `applyManifest` は本ファイルの土台マニフェスト(役割を1本も
    // 書いていない)で丸ごと上書きするので、ここでは別のアプリを作って確かめる。**
    createApp(store, "既定の確認", { app_id: "defaults" });
    const roles = (
      readCurrentManifest(dataRoot, "defaults").app as unknown as {
        roles?: { id: string; rules?: unknown }[];
      }
    ).roles;
    expect(roles?.map((role) => role.id)).toEqual(["owner", "editor", "viewer"]);
  });

  test("既定3本のうち `owner` だけが規則2本を持つ(`D-V8-59`。`R-13-3` は今日は成り立たない)", () => {
    // **旧テスト名の逐語**: 「**既定3本は規則を1本も持たない(裁定 `R-13-3`。面は全許可の
    // ままである)**」。**旧本体の逐語**: `for (const role of roles) {`
    // `  expect(role.rules).toBeUndefined();` `}`
    //
    // **【`V8-M28`(2026-08-11)。ユーザ決定 `D-V8-59` の選ばれた見出しの逐語
    // 「**閉じる。持ち主には最初から2行入れておく**」】**
    // **`ADR-0304` 限定11 の「既定の役割定義3本は `rules` を1本も持たない箱として入る」は
    // 今日から成り立たない。****`editor` / `viewer` には1本も入らない**(`D-V8-59` は
    // 持ち主だけを名指ししている)。**旧の期待値を1バイトも消していない。**
    createApp(store, "既定の確認", { app_id: "defaults2" });
    const roles =
      (
        readCurrentManifest(dataRoot, "defaults2").app as unknown as {
          roles?: { id: string; rules?: unknown }[];
        }
      ).roles ?? [];
    for (const role of roles) {
      if (role.id === "owner") {
        expect(role.rules).toEqual([
          { target: "app", can: ["write"] },
          { target: "role", can: ["write"] },
        ]);
      } else {
        expect(role.rules).toBeUndefined();
      }
    }
  });

  /*
   * **【2026-08-09。`V8-M17` が塞いだ。旧テスト名と旧本体の主張を逐語で残す】**
   *
   * **旧テスト名(逐語)**: 「**【正直に書く】`set_roles` で既定3本を消せる(塞いでいない)**」。
   * **旧本体が測っていたもの(逐語)**: 「`set_roles` は全体差し替えの op である
   * (`set_theme` / `set_user_kinds` と同型)。したがって既定3本を1本も含まない宣言を
   * 書けば、既定は消える。`J-G2` の限定は『アプリの作者は既定に足すことしかできず、
   * 引き算(拒否)を1つも書けない』と書いているが、それを担保しているのは `rules` に
   * 拒否の値域が無いことだけであり、既定の役割そのものを消せないようにする仕掛けは
   * 今日1つも無い。」
   *
   * **いつ・何を根拠に塞いだか**: **2026-08-09。メインの判断。**
   * **`04` §7 の `V8-M16` の完了条件 (ii) の逐語「運営3ロールが既定の役割として
   * 残っていること(`D-V8-26`)—— 3つとも `API` から確認する」は、消せるなら
   * 「残っている」と書けない。****台帳 `J-G2` の限定「アプリの作者は既定に足すことしか
   * できず、引き算(拒否)を1つも書けない」も、既定そのものを消すことを許していない。**
   * **`D-V8-26` の説明文の逐語「この3つを『最初から用意されている役割』として残し、
   * アプリはそこに役割を追加していく」が、同じことを言っている。**
   *
   * **どこで塞いだか**: **`src/kernel/referential-integrity.ts` の類型17**
   * (`roles[].id` の重複検査のすぐ下)。**`set_roles` も `applyManifest` も同じ1箇所を
   * 通る** —— **判定を2箇所に住まわせない。**
   */
  test("既定3本は消せない(`V8-M17` で塞いだ)", () => {
    createApp(store, "既定の確認", { app_id: "defaults3" });
    const result = applyDiff(dataRoot, "defaults3", setRolesDiff([{ id: "member", name: "会員" }]));
    expect(result.valid).toBe(false);
    // **拒否されても、ディスク上の宣言は1バイトも変わらない。**
    const roles = (
      readCurrentManifest(dataRoot, "defaults3").app as unknown as { roles?: { id: string }[] }
    ).roles;
    expect(roles?.map((role) => role.id)).toEqual(["owner", "editor", "viewer"]);
  });

  test.each([["owner"], ["editor"], ["viewer"]])(
    "既定の `%s` が1本欠けた `set_roles` は拒否される",
    (missing) => {
      createApp(store, "既定の確認", { app_id: `drop-${missing}` });
      // **【`V8-M28` / `T-G16a`】旧の逐語: `.map((id) => ({ id }));`** ——
      // **`owner` が残る場合は2本の規則を入れておく**(入れないと「既定が欠けた」以外の
      // エラーが混ざり、この検査が何を測っているのか分からなくなる)。
      const roles = ["owner", "editor", "viewer"]
        .filter((id) => id !== missing)
        .map((id) =>
          id === "owner" ? { id, rules: structuredClone(OWNER_DEFINITION_RULES) } : { id },
        );
      const result = applyDiff(dataRoot, `drop-${missing}`, setRolesDiff(roles));
      expect(result.valid).toBe(false);
      if (!result.valid) {
        // **書いた人が何を直せばよいか分かる形である** —— **消えた役割を名指しする。**
        const text = JSON.stringify(result.errors);
        expect(text).toContain("/app/roles");
        expect(text).toContain(missing);
        expect(text).toContain("既定の役割");
      }
    },
  );

  test("既定3本を残したまま4本目を足す `set_roles` は通る(**足すことはできる**)", () => {
    createApp(store, "既定の確認", { app_id: "add-fourth" });
    // **【`V8-M28` / `T-G16a`】旧の逐語: `{ id: "owner" },`** ——
    // **今日の類型17 は `owner` に `app`+`write` / `role`+`write` の2本を要求する。**
    const roles = [
      { id: "owner", rules: structuredClone(OWNER_DEFINITION_RULES) },
      { id: "editor" },
      { id: "viewer" },
      { id: "member", name: "会員" },
    ];
    const result = applyDiff(dataRoot, "add-fourth", setRolesDiff(roles));
    expect(result.valid).toBe(true);
    expect(
      (
        readCurrentManifest(dataRoot, "add-fourth").app as unknown as { roles?: { id: string }[] }
      ).roles?.map((role) => role.id),
    ).toEqual(["owner", "editor", "viewer", "member"]);
  });

  test("既定3本に規則(`rules`)を足す `set_roles` は通る(`J-G2` の「足すことしかできない」の中身)", () => {
    // **【`V8-M28` / `T-G16a`】旧の逐語: `{ id: "owner" },`。**
    const roles = [
      { id: "owner", rules: structuredClone(OWNER_DEFINITION_RULES) },
      { id: "editor" },
      {
        id: "viewer",
        name: "閲覧者",
        rules: [{ target: "view", view: "order-list", can: ["read"] }],
      },
    ];
    // **本ファイルの土台アプリ(`shop`)には `order-list` が実在する。**
    const result = applyDiff(dataRoot, APP_ID, setRolesDiff(roles));
    expect(result.valid).toBe(true);
    expect(appliedRoles(result)).toEqual(roles);
  });

  test("既定3本の表示名(`name`)は変えられる(要求するのは `id` が全部在ることだけ)", () => {
    // **メインの裁定**: **`name` は変えてよい**(表示名なので、アプリの言い回しに
    // 合わせられるべきである)。
    // **【`V8-M28` / `T-G16a`】旧の逐語: `{ id: "owner", name: "店長" },`。**
    const roles = [
      { id: "owner", name: "店長", rules: structuredClone(OWNER_DEFINITION_RULES) },
      { id: "editor", name: "スタッフ" },
      { id: "viewer", name: "お客さま" },
    ];
    const result = applyDiff(dataRoot, APP_ID, setRolesDiff(roles));
    expect(result.valid).toBe(true);
    expect(appliedRoles(result)).toEqual(roles);
  });

  test("並び順は問わない(既定3本が在ればよい)", () => {
    // **【`V8-M28` / `T-G16a`】旧の逐語: `{ id: "owner" },`。**
    const roles = [
      { id: "viewer" },
      { id: "member", name: "会員" },
      { id: "owner", rules: structuredClone(OWNER_DEFINITION_RULES) },
      { id: "editor" },
    ];
    expect(applyDiff(dataRoot, APP_ID, setRolesDiff(roles)).valid).toBe(true);
  });

  test("`app.roles` を1つも宣言していないアプリには当たらない(既存の定義を壊さない)", () => {
    // **本ファイルの土台マニフェスト(`beforeEach`)は `roles` を1本も持たない。**
    // **それでも `applyManifest` は通っている** —— **通っていなければ `beforeEach` が
    // 例外を投げ、このファイルの全検査が落ちる。**
    const manifest = readCurrentManifest(dataRoot, APP_ID);
    expect((manifest.app as unknown as { roles?: unknown }).roles).toBeUndefined();
    expect(applyManifest(dataRoot, APP_ID, baseManifest()).valid).toBe(true);
  });

  /**
   * **【期待値を反転させた。黙って書き換えていない。2026-08-10】**
   *
   * **旧の test 名の逐語**: 「既定に規則を足す形でも、指す先が実在しなければ拒否される」。
   * **旧の期待値の逐語**: `expect(applyDiff(dataRoot, "defaults4", setRolesDiff(next)).valid).toBe(false);`
   * **旧のコメントの逐語**: 「**画面 `any-view` は `defaults4` に実在しないので、適用時検査が
   * 拒否する** —— **「実在する先しか名指しできない」ことが既定の役割にも同じように効く。**」
   *
   * **反転の根拠**: **ユーザ決定 `D-V8-66`(2026-08-10)**。撤去箇所は
   * `src/kernel/referential-integrity.ts` の類型16。破られた明文は
   * `docs/adr/0086-field-value-unit.md:120`。
   */
  test("既定に規則を足す形なら、指す先が実在しなくても通る(`D-V8-66` で反転)", () => {
    createApp(store, "既定の確認", { app_id: "defaults4" });
    // **【`V8-M28` / `T-G16a`】旧の逐語: `{ id: "owner", name: "持ち主" },`。**
    const next = [
      { id: "owner", name: "持ち主", rules: structuredClone(OWNER_DEFINITION_RULES) },
      { id: "editor", name: "編集者" },
      {
        id: "viewer",
        name: "閲覧者",
        rules: [{ target: "view", view: "any-view", can: ["read"] }],
      },
    ];
    // **画面 `any-view` は `defaults4` に実在しないが、今日は拒否しない** ——
    // **残った行は、その識別子の画面が在るあいだしか効かない。**
    expect(applyDiff(dataRoot, "defaults4", setRolesDiff(next)).valid).toBe(true);
  });
});

// ===========================================================================
// (T-11) **対象が2つ増えた** —— アプリの設定(`app`)と人の役割(`role`)
//        (`V8-M28`。台帳 `T-G14` / `T-G17` = どちらも **限定採用**。
//         ユーザ決定 `D-V8-49` / `D-V8-59` / `D-V8-61` / `D-V8-62`)
//
// **`ADR-0304` 限定2「対象は4種ちょうど」を正面から破っている。**
// **破ってよい根拠は `ADR-0007` §8 の台帳2行(`T-G14` / `T-G17`)の判定である。**
// ===========================================================================

describe("(T-11) 新しい2対象(`app` / `role`)を宣言できる(`T-G14` / `T-G17`)", () => {
  test("対象 = アプリの設定(`T-G14`): `write` 1語だけを書ける", () => {
    const rule = { target: "app", can: ["write"] };
    const result = applyRule(rule);
    expect(result.valid).toBe(true);
    expect(appliedRoles(result)).toEqual(
      withDefaults([{ id: "member", name: "会員", rules: [rule] }]),
    );
  });

  test("対象 = 人の役割(`T-G17`): `write` 1語だけを書ける", () => {
    const rule = { target: "role", can: ["write"] };
    const result = applyRule(rule);
    expect(result.valid).toBe(true);
    expect(appliedRoles(result)).toEqual(
      withDefaults([{ id: "member", name: "会員", rules: [rule] }]),
    );
  });

  test("2つは別々に書ける(`T-G19` の完了の考え方 (i) の逐語「**別々に**書けること」)", () => {
    // **「設定は変えられないが人を追加できる受付係」** —— **`role` だけを持つ役割。**
    // **「人は配れないが設定は変えられる」** —— **`app` だけを持つ役割。**
    // **1本の `set_roles` に2つ並べる**(同じ `diff_id` は同じアプリに2度打てない)。
    const roles = withDefaults([
      { id: "reception", name: "受付", rules: [{ target: "role", can: ["write"] }] },
      { id: "builder", name: "作り手", rules: [{ target: "app", can: ["write"] }] },
    ]);
    const result = applyDiff(dataRoot, APP_ID, setRolesDiff(roles));
    expect(result.valid).toBe(true);
    expect(appliedRoles(result)).toEqual(roles);
  });

  test.each([["app"], ["role"]])(
    "`%s` に `read` / `delete` を書いた差分は拒否される(動詞は `write` 1語ちょうど)",
    (target) => {
      for (const can of [["read"], ["delete"], ["read", "write"], ["write", "delete"]]) {
        expect(applyRule({ target, can }).valid).toBe(false);
      }
    },
  );

  test.each([["app"], ["role"]])(
    "`%s` に `table` / `field` / `view` / `action` / `when` を併記した差分は拒否される",
    (target) => {
      const extras: Any[] = [
        { table: "orders" },
        { field: "memo" },
        { view: "order-list" },
        { action: "mark-done" },
        { when: { field: "memo", equals: "x" } },
      ];
      for (const extra of extras) {
        expect(applyRule({ target, can: ["write"], ...extra }).valid).toBe(false);
      }
    },
  );

  test.each([["app"], ["role"]])(
    "`%s` は名指しする対象を持たない(`required` は増えていない。`target` と `can` だけで通る)",
    (target) => {
      expect(applyRule({ target, can: ["write"] }).valid).toBe(true);
      expect(ruleItemSchema().required).toEqual(["target", "can"]);
    },
  );

  test.each([["app"], ["role"]])(
    "未ログイン(`anonymous`)は `%s` の規則を書けない(定義を変えたり役割を配ったりできない)",
    (target) => {
      expect(applyRule({ target, can: ["write"] }, "anonymous").valid).toBe(false);
    },
  );

  test("`anonymous` の分岐は `schemas/manifest.schema.json` が閉じている(サーバ層で握りつぶさない)", () => {
    // **既存の分岐は「書ける対象」を**正の列挙**で絞る形である** ——
    // **`["table","view","action"]` の3語ちょうどなので、`app` / `role` は
    // 列挙に無いことによって既に閉じている。****enum に2語を足してはならない
    // (足すと逆に開いてしまう)。**
    const branch = (roleItemSchema().allOf as Any[])[0] as Any;
    const rules = ((branch.then as Any).properties as Any).rules as Any;
    const targetSchema = (((rules.items as Any).properties as Any).target as Any).enum as string[];
    expect(targetSchema).toEqual(["table", "view", "action"]);
    expect(targetSchema).not.toContain("app");
    expect(targetSchema).not.toContain("role");
  });

  test("`can` の値域(`items.enum`)は今日も3語ちょうどである(4語目を足していない)", () => {
    const can = (ruleItemSchema().properties as Any).can as Any;
    expect((can.items as Any).enum).toEqual(["read", "write", "delete"]);
  });

  test("`allOf` の分岐は 4本 → 6本になった(対象1つにつき1本ちょうど)", () => {
    const branches = (ruleItemSchema().allOf ?? []) as Any[];
    expect(branches).toHaveLength(6);
    for (const target of ["table", "field", "view", "action", "app", "role"]) {
      expect(ruleBranch(target)).toBeDefined();
    }
  });

  test.each([["app"], ["role"]])("`%s` の分岐は5キーを `false` で閉じている", (target) => {
    const then = (ruleBranch(target) as Any).then as Any;
    const properties = then.properties as Any;
    for (const key of ["table", "field", "view", "action", "when"]) {
      expect(properties[key]).toBe(false);
    }
    // **`required` を増やしていない**(名指しする対象を持たない)。
    expect(then.required).toBeUndefined();
    // **動詞は `write` 1語ちょうど。**
    expect(properties.can).toMatchObject({ minItems: 1, maxItems: 1 });
    expect(((properties.can as Any).items as Any).const).toBe("write");
  });
});

// ===========================================================================
// (T-12) **器の本数は1つも動いていない**(`T-G42` の判定「`ADR-0013` §4c の3問は
//        発火しない」の実測。**動いたのは `target.enum` の 4 → 6 だけである**)
// ===========================================================================

describe("(T-12) 器の本数は着手前(`V8-M28` の着手時実測)と1つも変わらない", () => {
  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】**
  // **`$defs/app.properties` から `user_kinds` の器が消えたので 9 → 8。**
  // **旧(逐語)**: `expect(Object.keys((manifestDefs().app as Any).properties as Any)).toHaveLength(9);`
  // **`$defs` の 29 と `$defs/table.properties` の 6 は1バイトも動いていない**
  // (減ったのは `app` 直下の1本だけであることを、この2行が今日も固定する)。
  // **テスト名の「9」は当時の逐語である**(テスト名は書き換えない)。
  test("`$defs` は 29 / `$defs/app` は 9 / `$defs/table` は 6 のままである", () => {
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 29 → 30 へ書き換えた。**
    // **旧行の逐語**: `expect(Object.keys(manifestDefs())).toHaveLength(29);`
    // **書き換えた理由**: この行が固定していたのは「**その決定**が新しい `$defs` を作らなかったこと」
    // であり、**30本目を作ったのは別の決定である**(`V8-M8` が集計表の中身 `$defs/report` を新設した)。
    // **検査は消していない。**
    expect(Object.keys(manifestDefs())).toHaveLength(30);
    expect(Object.keys((manifestDefs().app as Any).properties as Any)).toHaveLength(8);
    expect(Object.keys((manifestDefs().table as Any).properties as Any)).toHaveLength(6);
  });

  test("`rules.items.properties` は 7 / `roles.items.properties` は 3 のままである", () => {
    expect(Object.keys(ruleItemSchema().properties as Any)).toEqual([
      "target",
      "table",
      "field",
      "view",
      "action",
      "can",
      "when",
    ]);
    // **【2026-08-14。`V8-M1-T02`。台帳 `I-G1` / `I-G6`。判定値 = 限定採用(`ADR-0334`)】**
    // **`roles.items.properties` に4キー目 `signup` を足したので 3 → 4。**
    // **旧(逐語)**: `expect(Object.keys(roleItemSchema().properties as Any)).toEqual(["id", "name", "rules"]);`
    // **`ADR-0322` 限定4 の期待値 `7 / 3 / 3` は今日 `7 / 4 / 3` である**
    // (`ADR-0334` 限定1 が入れ替えを指示している)。**`rules.items.properties` の 7 と
    // `can.items.enum` の3語は1バイトも動いていない。****テスト名の「3」は当時の逐語である**
    // (テスト名は書き換えない)。**`signup` は宣言の末尾に在る**(`ADR-0334` の限定表と
    // 新設 `$comment` の文言「`id` / `name` / `rules` / `signup`」に宣言順を揃えた)。
    expect(Object.keys(roleItemSchema().properties as Any)).toEqual([
      "id",
      "name",
      "rules",
      "signup",
    ]);
  });

  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a` / `T-G11`。判定値 = 廃止】**
  // **`user_kinds` キーと `set_user_kinds` を撤去したので 10 → 9 / 18 → 17。**
  // **旧(逐語)**: `expect(Object.keys(operation.properties as Any)).toHaveLength(10);`
  // **旧(逐語)**: `expect(DIFF_OPS).toHaveLength(18);`
  // **`V8-M28`(この describe が測っていた決定)は今日も器を1つも動かしていない** ——
  // **動かしたのは別の決定(本廃止)である。テスト名の「10」「18」は当時の逐語である**(テスト名は書き換えない)。
  test("`$defs/operation.properties` は 10 / `DIFF_OPS` は 18 のままである", () => {
    const operation = (diffSchema as unknown as { $defs: Record<string, Any> }).$defs
      .operation as Any;
    expect(Object.keys(operation.properties as Any)).toHaveLength(9);
    expect(DIFF_OPS).toHaveLength(17);
  });

  test("動いたのは `target.enum` の 4 → 6 だけである", () => {
    expect((ruleItemSchema().properties as Any).target).toMatchObject({
      enum: ["table", "field", "view", "action", "app", "role"],
    });
  });
});

// ===========================================================================
// (T-13) **類型17 の拡張** —— `owner` から定義変更・役割配布の2本を抜けなくする
//        (`V8-M28`。台帳 `T-G16a` = **限定採用**。ユーザ決定 `D-V8-47` / `D-V8-59`)
//
// **この検査は `ADR-0304` 限定11 の「既定に `rules` を足してよい(= 抜いてもよい)」を破る。**
// ===========================================================================

describe("(T-13) `owner` から `app`+`write` / `role`+`write` を抜いた `set_roles` は拒否される", () => {
  test.each([
    ["app", [{ target: "role", can: ["write"] }]],
    ["role", [{ target: "app", can: ["write"] }]],
    ["両方", [] as Any[]],
  ])("`%s` を抜いた `set_roles` は拒否される", (_label, rules) => {
    const roles = [
      ...((rules as Any[]).length === 0
        ? [{ id: "owner" }]
        : [{ id: "owner", rules: rules as Any[] }]),
      { id: "editor" },
      { id: "viewer" },
    ];
    const result = applyDiff(dataRoot, APP_ID, setRolesDiff(roles));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const text = JSON.stringify(result.errors);
      // **`path` は `/app/roles` の位置まで指す。**
      expect(result.errors.some((error) => error.path === "/app/roles")).toBe(true);
      // **何が足りないかを名指しする。**
      expect(text).toContain("owner");
      // **回復経路が無いことを `hint` に書く。**
      expect(text).toContain("二度と");
    }
  });

  test("両方在れば通る", () => {
    const roles = [
      { id: "owner", rules: structuredClone(OWNER_DEFINITION_RULES) },
      { id: "editor" },
      { id: "viewer" },
    ];
    expect(applyDiff(dataRoot, APP_ID, setRolesDiff(roles)).valid).toBe(true);
  });

  test("2本のほかに規則を足すのは通る(足すことはできる)", () => {
    const roles = [
      {
        id: "owner",
        rules: [
          ...structuredClone(OWNER_DEFINITION_RULES),
          { target: "table", table: "orders", can: ["read", "write", "delete"] },
        ],
      },
      { id: "editor" },
      { id: "viewer" },
    ];
    expect(applyDiff(dataRoot, APP_ID, setRolesDiff(roles)).valid).toBe(true);
  });

  test("`owner` の表示名(`name`)を変えるだけなら通る", () => {
    const roles = [
      { id: "owner", name: "店長", rules: structuredClone(OWNER_DEFINITION_RULES) },
      { id: "editor" },
      { id: "viewer" },
    ];
    expect(applyDiff(dataRoot, APP_ID, setRolesDiff(roles)).valid).toBe(true);
  });

  test("4本目の役割を足すのは通る", () => {
    const roles = [
      { id: "owner", rules: structuredClone(OWNER_DEFINITION_RULES) },
      { id: "editor" },
      { id: "viewer" },
      { id: "member", name: "会員" },
    ];
    expect(applyDiff(dataRoot, APP_ID, setRolesDiff(roles)).valid).toBe(true);
  });

  test("`editor` / `viewer` の `rules` は1件も見ない(2本を入れなくても通る)", () => {
    const roles = [
      { id: "owner", rules: structuredClone(OWNER_DEFINITION_RULES) },
      { id: "editor", rules: [{ target: "table", table: "orders", can: ["read"] }] },
      { id: "viewer" },
    ];
    expect(applyDiff(dataRoot, APP_ID, setRolesDiff(roles)).valid).toBe(true);
  });

  test("`app.roles` を1つも宣言していないアプリには当たらない(類型17 と同じ条件)", () => {
    // **本ファイルの土台マニフェスト(`beforeEach`)は `roles` を1本も持たない。**
    expect(applyManifest(dataRoot, APP_ID, baseManifest()).valid).toBe(true);
  });
});
