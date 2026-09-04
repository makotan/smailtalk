/**
 * **条件(かつ・または・でない)と「自分」**(`V8-M18`。台帳 `J-G12` / `J-G13` / `J-G14` /
 * `J-G15` / `J-G16`。メインの裁定 `R-7` / `R-17`。ユーザ決定 `D-V8-17` / `D-V8-22`)。
 *
 * **`V8-M17` が立てた規則(`roles[].rules[]` = 対象 × 動詞)の内側に、条件(`when`)を足す。**
 * 規則そのものの検査は `src/kernel/role-rules.test.ts` にあり、**本ファイルはそこに
 * 1行も重複させない**(あちらは対象 × 動詞、こちらは条件)。
 *
 * ## この検査が測るもの(**先に書く**)
 *
 * 1. **`$defs` が 28 から 29 へ、1本だけ増えたこと**(`J-G12` の限定。裁定 `R-17-1`)。
 *    **新設したのは `role_condition` 1本だけである。**
 * 2. **組み立ては「かつ」「または」「でない」の3つちょうど**(`D-V8-17` / 裁定 `R-17-2`)。
 * 3. **葉は2種ちょうど** —— 項目の値が定数と等しい / 項目の値が要求している人と等しい
 *    (`D-V8-22`)。**3種目を足さない。**
 * 4. **センチネル文字列を1文字も作らないこと**(`J-G13` の限定)。**「自分」は専用のキー
 *    (`equals_current_user`)の形で表す。** **`@current_user` のような文字列は書けない**
 *    (`ADR-0016` §9 が却下している)。
 * 5. **入れ子の深さが `src/kernel/records.ts` の `MAX_FILTER_DEPTH` で止まること**
 *    (`J-G14`)—— **上限に当たった宣言が拒否される。** **同じ値を2箇所が別々に持たない。**
 * 6. **条件から見えるものが2つだけであること**(`J-G15`)—— 判定している行の項目の値と、
 *    要求している人の識別子。**項目の指し先の実在を適用時に検査する。**
 * 7. **誰も通さない条件・全員を通す条件が、書いた人に返る形で伝わること**(`J-G16`)——
 *    **拒否しない。適用は通る。知らせるだけである。**
 *
 * ## この検査が測らないもの(**誇張しない**)
 *
 * 1. **条件の評価器は1バイトも無い。** **`src/server/` を1バイトも触っていない** ——
 *    **条件を書いても、行の読取・書込・削除のふるまいは今日どおりである。**
 *    **カーネルがするのは形の検査(値域・深さ・指し先の実在)だけである。**
 * 2. **未ログインで「自分」が偽に評価されること**(`J-G13` の限定)は、**評価器を持つ
 *    サーバ層の担当である。** **本ファイルが測るのは、その前提でカーネルが出す
 *    「誰も通さない」の知らせだけである。**
 * 3. **「矛盾を全部見つける」ことは1つも主張していない。** **検出できない形を (T-6) に
 *    名指しで固定してある。**
 * 4. **ブラウザで画面を1枚も開いていない。MCP サーバも1度も起動していない。**
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import { applyDiff } from "./apply-diff.ts";
import { applyManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { MAX_FILTER_DEPTH } from "./records.ts";
import type { Diff, Manifest, RoleConditionNotice } from "./types.ts";

type Any = Record<string, unknown>;

const APP_ID = "shop";
const REPO_ROOT = dirname(dirname(import.meta.dir));

let dataRoot: string;
let store: KernelMetaStore;

/** 条件が指せる項目を持つ土台(`orders.status` / `orders.assignee`)。 */
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
            { id: "status", name: "状態", type: "text" },
            { id: "assignee", name: "担当", type: "text" },
          ],
        },
      ],
      views: [
        { id: "order-list", type: "list_view", table: "orders", columns: ["title"] },
        {
          id: "order-detail",
          type: "detail_view",
          table: "orders",
          fields: ["title", "status"],
          actions: [{ id: "mark-done", name: "完了にする", set: { field: "title", value: "済" } }],
        },
      ],
    },
  } as unknown as Manifest;
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-role-cond-"));
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

/** 既定3本(`owner` / `editor` / `viewer`)は消せない(`V8-M17` の適用時検査)。 */
function withDefaults(roles: Any[]): Any[] {
  const declared = new Set(roles.map((role) => role.id as string));
  // **【`V8-M28` / `T-G16a`(2026-08-11)。旧の逐語を残す】**
  // **旧: `.map((id) => ({ id })),`** —— **既定3本を「`id` だけの箱」で足していた。**
  // **今日は持ち主に `app`+`write` / `role`+`write` の2本が要る**(類型17 の拡張)。
  return [
    ...["owner", "editor", "viewer"]
      .filter((id) => !declared.has(id))
      .map((id) =>
        id === "owner"
          ? {
              id,
              rules: [
                { target: "app", can: ["write"] },
                { target: "role", can: ["write"] },
              ],
            }
          : { id },
      ),
    ...roles,
  ];
}

/** `diff_id` は履歴の中で一意でなければならない(1つの検査で2回適用することがある)。 */
let diffSeq = 0;

function setRolesDiff(roles: unknown): Diff {
  diffSeq += 1;
  return {
    diff_id: `d${diffSeq}`,
    intent: "役割の規則に条件を付ける",
    operations: [{ op: "set_roles", roles }],
  } as unknown as Diff;
}

/** 表を対象にした規則1本に条件を付けて適用する。 */
function applyWhen(
  when: unknown,
  options: { roleId?: string; can?: string[] } = {},
): ReturnType<typeof applyDiff> {
  const { roleId = "member", can = ["read"] } = options;
  return applyDiff(
    dataRoot,
    APP_ID,
    setRolesDiff(
      withDefaults([
        {
          id: roleId,
          name: "会員",
          rules: [{ target: "table", table: "orders", can, when }],
        },
      ]),
    ),
  );
}

function notices(result: ReturnType<typeof applyDiff>): RoleConditionNotice[] {
  return result.valid ? result.role_condition_notices : [];
}

function errorPaths(result: ReturnType<typeof applyDiff>): string[] {
  return result.valid ? [] : result.errors.map((error) => error.path);
}

function manifestDefs(): Record<string, Any> {
  return (manifestSchema as unknown as { $defs: Record<string, Any> }).$defs;
}

function conditionSchema(): Any {
  return manifestDefs().role_condition as Any;
}

function ruleItemSchema(): Any {
  const roles = ((manifestDefs().app?.properties as Any)?.roles ?? {}) as Any;
  return (((roles.items as Any).properties as Any).rules as Any).items as Any;
}

/** `rules[]` の `allOf` から、対象名で分岐を引く。 */
function ruleBranch(target: string): Any | undefined {
  return ((ruleItemSchema().allOf ?? []) as Any[]).find(
    (branch) => ((((branch.if as Any)?.properties ?? {}) as Any).target as Any)?.const === target,
  );
}

/**
 * 条件の定義から**散文**(`$comment` / `description`)を落とした木。
 *
 * **見えないものを名指しで列挙する散文と、実際の値域とを取り違えないため。**
 * 散文の側は別の検査(「`$comment` が見えないものを名指しで列挙している」)が見る。
 */
function conditionValueSpace(): unknown {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node === null || typeof node !== "object") return node;
    const out: Any = {};
    for (const [key, value] of Object.entries(node as Any)) {
      if (key === "$comment" || key === "description") continue;
      out[key] = strip(value);
    }
    return out;
  };
  return strip(conditionSchema());
}

/** `role_condition` の `anyOf` の各形が持つキーの集合(宣言順)。 */
function conditionShapes(): string[][] {
  return ((conditionSchema().anyOf ?? []) as Any[]).map((shape) =>
    Object.keys((shape.properties ?? {}) as Any),
  );
}

/** 葉 `{field, equals}` を作る。 */
function eq(field: string, value: string | number | boolean): Any {
  return { field, equals: value };
}

/** 葉 `{field, equals_current_user}` を作る(「自分」)。 */
function me(field: string): Any {
  return { field, equals_current_user: true };
}

/** `not` を `depth` 段だけ重ねた条件を作る(葉は最下段)。 */
function nest(depth: number): Any {
  let node: Any = eq("status", "進行中");
  for (let i = 0; i < depth; i += 1) node = { not: node };
  return node;
}

// ===========================================================================
// (T-1) 器 —— `$defs` を1本だけ新設し、`rules[]` に `when` を1本足す
// ===========================================================================

describe("(T-1) 器(`J-G12` / 裁定 `R-17-1`)", () => {
  test("`$defs` は 29 である(28 から**1本だけ**増えた)", () => {
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 29 → 30 へ書き換えた。**
    // **旧行の逐語**: `expect(Object.keys(manifestDefs())).toHaveLength(29);`
    // **書き換えた理由**: この行が固定していたのは「**その決定**が新しい `$defs` を作らなかったこと」
    // であり、**30本目を作ったのは別の決定である**(`V8-M8` が集計表の中身 `$defs/report` を新設した)。
    // **検査は消していない。**
    expect(Object.keys(manifestDefs())).toHaveLength(30);
  });

  test("新設した `$defs` は `role_condition` の1本だけである", () => {
    // **`V8-M17` 時点の28本の全量**(`role-rules.test.ts` が 28 で固定していた集合)。
    const before = [
      "resource_id",
      "view_table_id",
      "app",
      "theme",
      "table",
      "field_type",
      "field",
      "view_type",
      "sort_key",
      "sort",
      "filter",
      "filter_and_array",
      "filter_leaf",
      "filter_node",
      "related_list",
      "view_action",
      "view_actions",
      "field_id_list",
      "view",
      "schedule_at",
      "workflow_trigger",
      "action_value",
      "workflow_action",
      "workflow",
      "function_input",
      "function_output_field",
      "function_output",
      "function",
    ];
    const today = Object.keys(manifestDefs());
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値に `report` を足した。**
    // **旧行の逐語**: `expect(today.filter((name) => !before.includes(name))).toEqual(["role_condition"]);`
    // **書き換えた理由**: この行が固定していたのは「**`V8-M18` の決定**が新設した `$defs` は
    // `role_condition` の1本だけであること」であり、**30本目 `report` を新設したのは別の決定である**
    // (`V8-M8` の集計表)。**「`V8-M18` が1本しか作っていない」という本来の主張は1ミリも
    // 弱めていない** —— **今日の差集合が2本ちょうどであることを順序ごと固定している。**
    // **並びは宣言順である** —— **`report` は `$defs/view` の直前に置いたので、
    // `role_condition`(末尾)より前に来る。**
    expect(today.filter((name) => !before.includes(name))).toEqual(["report", "role_condition"]);
    expect(before.filter((name) => !today.includes(name))).toEqual([]);
  });

  test("`rules[]` の4キー目が `when` で、`$defs/role_condition` を `$ref` で受ける", () => {
    const properties = ruleItemSchema().properties as Any;
    expect(Object.keys(properties)).toEqual([
      "target",
      "table",
      "field",
      "view",
      "action",
      "can",
      "when",
    ]);
    expect(Object.keys(properties.when as Any)).toEqual(["$comment", "description", "$ref"]);
    expect((properties.when as Any).$ref).toBe("#/$defs/role_condition");
  });

  test("`when` は省略できる(省略したら今日どおり「常に通る」)", () => {
    expect(ruleItemSchema().required).toEqual(["target", "can"]);
    const roles = withDefaults([
      { id: "member", rules: [{ target: "table", table: "orders", can: ["read"] }] },
    ]);
    const result = applyDiff(dataRoot, APP_ID, setRolesDiff(roles));
    expect(result.valid).toBe(true);
    // **省略は「知らせ」の対象ではない** —— 条件を書いていないことは矛盾ではない。
    expect(notices(result)).toEqual([]);
  });

  test("`roles[]` 自身には `when` を足していない(条件は規則ごとに書く)", () => {
    const roleItem = (((manifestDefs().app?.properties as Any)?.roles ?? {}) as Any).items as Any;
    // **【2026-08-14 追記(`V8-M1-T02`。台帳 `I-G1` / `I-G6` = どちらも 限定採用。
    // `ADR-0334` 限定1)。旧の期待値を1バイトも消していない】**
    // **旧(逐語)**: `expect(Object.keys(roleItem.properties as Any)).toEqual(["id", "name", "rules"]);`
    // **4キー目 `signup` を `V8-M1-T02` が足した。****この検査が見ている `when` は
    // 1バイトも動いていない** —— **条件は今日も `rules[]` の内側にだけ在る。**
    expect(Object.keys(roleItem.properties as Any)).toEqual(["id", "name", "rules", "signup"]);
    expect((roleItem.properties as Any).when).toBeUndefined();
  });

  test("`role_condition` は自分自身を `$ref` する(再帰的な定義である)", () => {
    expect(JSON.stringify(conditionSchema())).toContain('"#/$defs/role_condition"');
  });
});

// ===========================================================================
// (T-2) 組み立ては「かつ」「または」「でない」の3つちょうど(`D-V8-17`)
//        **3つを別々の `test()` に置く**(完了条件2)。
// ===========================================================================

describe("(T-2) 組み立て3種(`D-V8-17` / 裁定 `R-17-2`)", () => {
  test("「かつ」が書ける(`and`)", () => {
    const when = { and: [eq("status", "進行中"), me("assignee")] };
    const result = applyWhen(when);
    expect(result.valid).toBe(true);
    expect(
      (((result.valid ? result.manifest.app : {}) as Any).roles as Any[]).at(-1),
    ).toMatchObject({
      rules: [{ target: "table", table: "orders", can: ["read"], when }],
    });
  });

  test("「または」が書ける(`or`)", () => {
    const when = { or: [eq("status", "進行中"), me("assignee")] };
    expect(applyWhen(when).valid).toBe(true);
  });

  test("「でない」が書ける(`not`)", () => {
    const when = { not: eq("status", "完了") };
    expect(applyWhen(when).valid).toBe(true);
  });

  test("組み立ては3つちょうどで、4つ目(`xor` / `nand` / `implies`)は書けない", () => {
    const shapes = conditionShapes();
    // 葉2形 + 組み立て3形 = 5形ちょうど。
    // **【`V8-M26` / ユーザ決定 `D-V8-70`(2026-08-11)。直前の1行の字面は1バイトも
    // 消していない】** **今日は 葉3形 + 組み立て3形 = 6形ちょうどである。**
    // **足したのは末尾の `["field", "is_empty"]` 1形だけで、既存5形は位置ごと1バイトも
    // 動いていない**(この配列は順序ごと突き合わせるので、位置が動けば赤くなる)。
    // **この test が測っている「組み立ては3つちょうど」は今日も1ミリも動いていない** ——
    // **増えたのは葉である。**
    expect(shapes).toEqual([
      ["field", "equals"],
      ["field", "equals_current_user"],
      ["and"],
      ["or"],
      ["not"],
      ["field", "is_empty"],
    ]);
    for (const bad of ["xor", "nand", "implies", "any_of", "all_of"]) {
      expect(applyWhen({ [bad]: [eq("status", "A"), eq("status", "B")] }).valid).toBe(false);
    }
  });

  test("「かつ」「または」は2本以上を束ねる(1本だけの束は書けない)", () => {
    expect(applyWhen({ and: [eq("status", "進行中")] }).valid).toBe(false);
    expect(applyWhen({ or: [eq("status", "進行中")] }).valid).toBe(false);
  });

  test("入れ子に組み立てを混ぜられる(かつ の中に または と でない)", () => {
    const when = {
      and: [{ or: [eq("status", "進行中"), eq("status", "保留")] }, { not: me("assignee") }],
    };
    expect(applyWhen(when).valid).toBe(true);
  });
});

// ===========================================================================
// (T-3) 葉は2種ちょうど / 「自分」はセンチネル文字列を1文字も作らない(`J-G13`)
// ===========================================================================

describe("(T-3) 葉2種と「自分」(`D-V8-22` / `J-G13`)", () => {
  test("葉(1): 項目の値が定数と等しい(「状態が進行中」)", () => {
    expect(applyWhen(eq("status", "進行中")).valid).toBe(true);
    // 定数は文字列・数値・真偽値の3型。
    expect(applyWhen(eq("status", 3)).valid).toBe(true);
    expect(applyWhen(eq("status", true)).valid).toBe(true);
  });

  test("葉(2): 項目の値が要求している人と等しい(「担当が自分」)", () => {
    const when = me("assignee");
    const result = applyWhen(when);
    expect(result.valid).toBe(true);
    expect(
      (((result.valid ? result.manifest.app : {}) as Any).roles as Any[]).at(-1),
    ).toMatchObject({ rules: [{ when: { field: "assignee", equals_current_user: true } }] });
  });

  test("「状態が進行中 かつ 担当が自分」が1本の条件として書ける(`D-V8-17` の説明文の例)", () => {
    const when = {
      and: [
        { field: "status", equals: "進行中" },
        { field: "assignee", equals_current_user: true },
      ],
    };
    expect(applyWhen(when).valid).toBe(true);
  });

  test("葉は2種ちょうど —— 3種目(`contains` / `gte` / `lte` / `in`)は書けない", () => {
    for (const bad of [
      { field: "status", contains: "進行" },
      { field: "status", gte: 3 },
      { field: "status", lte: 3 },
      { field: "status", in: ["進行中", "保留"] },
      { field: "status", not_equals: "完了" },
    ]) {
      expect(applyWhen(bad).valid).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // **【`V8-M26` / ユーザ決定 `D-V8-70`(2026-08-11)】葉の3種目(その項目が空か)。**
  //
  // **直前の test 名「葉は2種ちょうど」は今日は偽である。** **名前を1バイトも書き換えて
  // いない** —— **測っている当のもの(`contains` / `gte` / `lte` / `in` / `not_equals` が
  // 1つも書けないこと)は今日も1ミリも動いていないからである。**
  // -------------------------------------------------------------------------

  test("葉(3): その項目が空(`is_empty`)が書ける", () => {
    const when = { field: "assignee", is_empty: true };
    const result = applyWhen(when);
    expect(result.valid).toBe(true);
    expect(
      (((result.valid ? result.manifest.app : {}) as Any).roles as Any[]).at(-1),
    ).toMatchObject({ rules: [{ when: { field: "assignee", is_empty: true } }] });
  });

  test("「自分の行、または持ち主が空の行」が1本の条件として書ける(`D-V8-70` の説明文の形)", () => {
    const when = {
      or: [
        { field: "assignee", equals_current_user: true },
        { field: "assignee", is_empty: true },
      ],
    };
    expect(applyWhen(when).valid).toBe(true);
  });

  test("`is_empty` に書けるのは `true` だけで、`false`(= 空でない)は書けない", () => {
    // **葉に否定形を1つも作らない**(`equals_current_user` が採ったのと同じ線)。
    expect(applyWhen({ field: "assignee", is_empty: false }).valid).toBe(false);
    // **「空でない」は組み立ての `not` で書く。**
    expect(applyWhen({ not: { field: "assignee", is_empty: true } }).valid).toBe(true);
  });

  test("`is_empty` の葉に3キー目は書けない(`equals` との同居も含めて閉じている)", () => {
    expect(applyWhen({ field: "assignee", is_empty: true, equals: "" }).valid).toBe(false);
    expect(applyWhen({ field: "assignee", is_empty: true, equals_current_user: true }).valid).toBe(
      false,
    );
    // **`field` を省くと形として成り立たない**(`required` が2キーちょうど)。
    expect(applyWhen({ is_empty: true }).valid).toBe(false);
  });

  test("`is_empty` の `field` も、その規則が名指しした表に実在しなければ差分全体が拒否される", () => {
    // **`equals` / `equals_current_user` と同じ適用時検査(類型16 補遺)を通る** ——
    // **葉を1形足したことで、指し先の実在検査に抜けを作っていない。**
    const result = applyWhen({ field: "no_such_field", is_empty: true });
    expect(result.valid).toBe(false);
  });

  test("「自分」は専用のキーであり、`equals_current_user: false`(= 自分でない)は書けない", () => {
    // **「でない」は組み立て(`not`)の側で書く。****葉に否定形を1つも作らない。**
    expect(applyWhen({ field: "assignee", equals_current_user: false }).valid).toBe(false);
    expect(applyWhen({ not: me("assignee") }).valid).toBe(true);
  });

  test("【センチネル文字列を1文字も作っていない】スキーマ全体を `grep` して示す", async () => {
    const text = await readFile(join(REPO_ROOT, "schemas/manifest.schema.json"), "utf-8");
    // **`ADR-0016` §9 が却下した形と、その近傍の綴り。**
    // **短い綴りは JSON の文字列リテラルの形で見る** —— 素の `@me` は既存の散文の
    // `@media`(`ADR-0050` / `ADR-0156`)に当たってしまい、測りたいものを測れない。
    for (const sentinel of [
      "@current_user",
      "__current_user__",
      "current_user()",
      '"@me"',
      '"@self"',
      '"@owner"',
      '"$me"',
      '"$current_user"',
      // `$` と `{…}` を続けてソースに書くと lint の `noTemplateCurlyInString` に当たるので、
      // 2つに割って組み立てる(**測っている綴りは `"${current_user}"` そのものである**)。
      `"$${"{"}current_user}"`,
    ]) {
      expect(text.includes(sentinel), sentinel).toBe(false);
    }
    // **値域の側からも示す** —— `role_condition` の中に現れる `const` / `enum` の値は
    // **真偽値の `true` ただ1つ**であり、**文字列の値域を1つも持たない。**
    const literals: unknown[] = [];
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      for (const [key, value] of Object.entries(node as Any)) {
        if (key === "const") literals.push(value);
        else if (key === "enum") literals.push(...(value as unknown[]));
        else if (key !== "$comment" && key !== "description") walk(value);
      }
    };
    walk(conditionSchema());
    // **【`V8-M26` / ユーザ決定 `D-V8-70`(2026-08-11)。上の「真偽値の `true` ただ1つ」は
    // 今日は2つである。旧のコメントを1バイトも消していない】**
    // **2つ目は葉の3種目 `is_empty` の `const: true` である。**
    // **測っている当のもの(**文字列**の値域が1つも無いこと = センチネル文字列を作って
    // いないこと)は1ミリも動いていない** —— **増えたのは真偽値の `true` の本数だけである。**
    expect(literals).toEqual([true, true]);
    expect(literals.every((literal) => literal === true)).toBe(true);
  });

  test("定数(`equals`)に書けるのは値であって、他の行を指す言葉ではない", () => {
    const text = JSON.stringify(conditionValueSpace());
    // **`$record.` は参照先を読む言葉である**(`ADR-0062`)。**値域には1文字も無い。**
    expect(text.includes("$record.")).toBe(false);
    expect(text.includes("{{")).toBe(false);
  });
});

// ===========================================================================
// (T-4) 深さの上限は `MAX_FILTER_DEPTH` を共有する(`J-G14`)
// ===========================================================================

describe("(T-4) 深さの上限(`J-G14` / 裁定 `R-17-4`)", () => {
  test("上限の値は `src/kernel/records.ts` の `MAX_FILTER_DEPTH` である(実測 8)", () => {
    expect(MAX_FILTER_DEPTH).toBe(8);
  });

  test("上限ちょうどの深さは通る(根を 0 段と数える)", () => {
    expect(applyWhen(nest(MAX_FILTER_DEPTH)).valid).toBe(true);
  });

  test("上限に当たった宣言は拒否される(1段深いだけで通らない)", () => {
    const result = applyWhen(nest(MAX_FILTER_DEPTH + 1));
    expect(result.valid).toBe(false);
    expect(errorPaths(result).some((path) => path.startsWith("/app/roles/"))).toBe(true);
    expect(result.valid ? [] : result.errors.map((error) => error.message).join("\n")).toContain(
      String(MAX_FILTER_DEPTH),
    );
  });

  test("【同じ値を2箇所が別々に持たない】検査側は定数を宣言せず `records.ts` から import する", async () => {
    const source = await readFile(join(REPO_ROOT, "src/kernel/referential-integrity.ts"), "utf-8");
    expect(source).toContain("MAX_FILTER_DEPTH");
    // **第2の宣言(`= 8`)を1つも持たない** —— 持てば、片方だけ直されて食い違う。
    expect(source.includes("MAX_FILTER_DEPTH =")).toBe(false);
    expect(source.includes('from "./records.ts"')).toBe(true);
  });

  test("深さの検査は適用時にカーネルで行う(スキーマは深さを1つも数えない)", () => {
    expect(JSON.stringify(conditionSchema()).includes("maxDepth")).toBe(false);
    // 深すぎる条件は**構造としては**スキーマに適合する(自己 `$ref` は無限段を許す)。
    // 止めているのは適用時検査である。
    const result = applyWhen(nest(MAX_FILTER_DEPTH + 1));
    expect(result.valid).toBe(false);
  });
});

// ===========================================================================
// (T-5) 条件から見えるもの・見えないもの(`J-G15`)
// ===========================================================================

describe("(T-5) 見えるもの・見えないもの(`J-G15` / 裁定 `R-17-3`)", () => {
  test("項目の指し先が実在しない条件は拒否される(表を対象にした規則)", () => {
    const result = applyWhen(eq("nonexistent", "x"));
    expect(result.valid).toBe(false);
    expect(errorPaths(result)).toContain("/app/roles/3/rules/0/when/field");
  });

  test("項目の指し先が実在しない条件は拒否される(入れ子の奥でも位置を指す)", () => {
    const result = applyWhen({
      and: [eq("status", "進行中"), { not: me("nonexistent") }],
    });
    expect(result.valid).toBe(false);
    expect(errorPaths(result)).toContain("/app/roles/3/rules/0/when/and/1/not/field");
  });

  test("項目を対象にした規則にも条件を書ける(指し先はその表の項目である)", () => {
    const result = applyDiff(
      dataRoot,
      APP_ID,
      setRolesDiff(
        withDefaults([
          {
            id: "member",
            rules: [
              {
                target: "field",
                table: "orders",
                field: "status",
                can: ["read"],
                when: me("assignee"),
              },
            ],
          },
        ]),
      ),
    );
    expect(result.valid).toBe(true);
  });

  test("画面・ボタンを対象にした規則には条件を書けない(判定する行が1つも無いため)", () => {
    for (const target of ["view", "action"]) {
      const branch = ruleBranch(target);
      expect(branch, target).toBeDefined();
      expect(((branch as Any).then as Any).properties as Any).toMatchObject({ when: false });
    }
    const viewRule = applyDiff(
      dataRoot,
      APP_ID,
      setRolesDiff(
        withDefaults([
          {
            id: "member",
            rules: [{ target: "view", view: "order-list", can: ["read"], when: me("assignee") }],
          },
        ]),
      ),
    );
    expect(viewRule.valid).toBe(false);
  });

  test("【見えないもの】その語が条件の**値域**に1つも無い", () => {
    const text = JSON.stringify(conditionValueSpace());
    // 他の表 / 他の行 / 時刻 / 環境変数 / 集計値 / 参照先の中身。
    for (const invisible of [
      '"table"',
      '"related"',
      '"view"',
      '"now"',
      '"today"',
      '"older_than"',
      '"env"',
      '"secret"',
      '"count"',
      '"sum"',
      '"avg"',
      '"group_by"',
      '"join"',
      '"$record"',
    ]) {
      expect(text.includes(invisible), invisible).toBe(false);
    }
  });

  test("【`$comment` が「見えないもの」を名指しで列挙している】(完了条件5)", () => {
    const comment = String(conditionSchema().$comment ?? "");
    for (const invisible of ["他の表", "他の行", "時刻", "環境変数", "集計値", "参照先の中身"]) {
      expect(comment.includes(invisible), invisible).toBe(true);
    }
    // **見える2つも名指しで書いてある。**
    expect(comment).toContain("判定している行の項目の値");
    expect(comment).toContain("要求している人の識別子");
  });

  test("見えるのは2つだけである —— 条件に書けるキーの全量が6語で閉じている", () => {
    const keys = new Set(conditionShapes().flat());
    // **【`V8-M26` / ユーザ決定 `D-V8-70`(2026-08-11)。test 名の「6語」は今日は7語である。
    // 名前の逐語は1バイトも書き換えていない】** **7語目は葉の3種目 `is_empty`。**
    // **この test が測っている当のもの(**見えるのは2つだけ** = 判定している行の項目の値と、
    // 要求している人の識別子)は1ミリも動いていない** —— **`is_empty` が見るのも、
    // 判定している行の項目の値ただ1つである**(表・行・時刻・環境変数・集計値・参照先の
    // 中身を指す語は今日も1つも無い)。
    expect([...keys].sort()).toEqual([
      "and",
      "equals",
      "equals_current_user",
      "field",
      "is_empty",
      "not",
      "or",
    ]);
    for (const shape of (conditionSchema().anyOf ?? []) as Any[]) {
      expect(shape.additionalProperties).toBe(false);
    }
  });
});

// ===========================================================================
// (T-6) 誰も通さない条件・全員を通す条件を知らせる(`J-G16`)
// ===========================================================================

describe("(T-6) 知らせ(`J-G16` / 裁定 `R-17-6`)", () => {
  test("誰も通さない条件を書くと、応答に知らせが出る(同じ項目に2つの定数)", () => {
    const result = applyWhen({ and: [eq("status", "進行中"), eq("status", "完了")] });
    // **拒否しない。適用は通る。知らせるだけである。**
    expect(result.valid).toBe(true);
    expect(notices(result)).toHaveLength(1);
    expect(notices(result)[0]).toMatchObject({
      kind: "never_matches",
      role: "member",
      path: "/app/roles/3/rules/0/when",
    });
    expect(notices(result)[0]?.message).toContain("誰も通さない");
  });

  test("誰も通さない条件を書くと、応答に知らせが出る(X かつ X でない)", () => {
    const result = applyWhen({ and: [me("assignee"), { not: me("assignee") }] });
    expect(result.valid).toBe(true);
    expect(notices(result).map((notice) => notice.kind)).toEqual(["never_matches"]);
  });

  test("誰も通さない条件を書くと、応答に知らせが出る(未ログインに「自分」)", () => {
    // **未ログインでは「自分」は偽に評価される**(`J-G13` の限定)ので、
    // **`anonymous` に「担当が自分」を書くと1人も通らない。**
    const result = applyDiff(
      dataRoot,
      APP_ID,
      setRolesDiff(
        withDefaults([
          {
            id: "anonymous",
            rules: [{ target: "table", table: "orders", can: ["read"], when: me("assignee") }],
          },
        ]),
      ),
    );
    expect(result.valid).toBe(true);
    expect(notices(result).map((notice) => notice.kind)).toEqual(["never_matches"]);
  });

  test("全員を通す条件を書くと、応答に知らせが出る(X または X でない)", () => {
    const result = applyWhen({
      or: [eq("status", "進行中"), { not: eq("status", "進行中") }],
    });
    expect(result.valid).toBe(true);
    expect(notices(result).map((notice) => notice.kind)).toEqual(["always_matches"]);
    expect(notices(result)[0]?.message).toContain("全員を通す");
  });

  test("矛盾していない条件では知らせが1件も出ない", () => {
    expect(notices(applyWhen({ and: [eq("status", "進行中"), me("assignee")] }))).toEqual([]);
    expect(notices(applyWhen({ or: [eq("status", "進行中"), eq("status", "保留")] }))).toEqual([]);
    expect(notices(applyWhen({ not: eq("status", "完了") }))).toEqual([]);
  });

  test("知らせは規則ごとに1件ずつ出る(どの役割のどの規則かを名指しする)", () => {
    const result = applyDiff(
      dataRoot,
      APP_ID,
      setRolesDiff(
        withDefaults([
          {
            id: "member",
            rules: [
              { target: "table", table: "orders", can: ["read"] },
              {
                target: "table",
                table: "orders",
                can: ["write"],
                when: { and: [eq("status", "A"), eq("status", "B")] },
              },
            ],
          },
        ]),
      ),
    );
    expect(result.valid).toBe(true);
    expect(notices(result)).toHaveLength(1);
    expect(notices(result)[0]?.path).toBe("/app/roles/3/rules/1/when");
  });

  // -------------------------------------------------------------------------
  // **【この形は検出しない】** —— 完了条件6 が要求する「検出できない形」の固定。
  // **名前に書いて固定する。将来これを検出するようになったら、この検査が赤くなる。**
  // -------------------------------------------------------------------------

  test("【この形は検出しない】業務上両立しない2つの定数(綴りが違えば別物としか見ない)", () => {
    // 「進行中」と「進行済み」が同時に成り立たないことは、カーネルには分からない。
    // **同じ項目に対する `or` なので、形の上では矛盾していない。**
    const result = applyWhen({ or: [eq("status", "進行中"), eq("status", "進行済み")] });
    expect(result.valid).toBe(true);
    expect(notices(result)).toEqual([]);
  });

  test("【この形は検出しない】実データに1行も無い値を指す条件(カーネルは行を1件も読まない)", () => {
    const result = applyWhen(eq("status", "この値の行は1件も無い"));
    expect(result.valid).toBe(true);
    expect(notices(result)).toEqual([]);
  });

  test("【この形は検出しない】兄弟どうしでない矛盾(入れ子をまたぐ組)", () => {
    // `{and: [{or: [A, B]}, {not: A}, {not: B}]}` は実際には誰も通さないが、
    // **直下の兄弟どうしの突き合わせしか行わないので見つけない。**
    const a = eq("status", "A");
    const b = eq("status", "B");
    const result = applyWhen({ and: [{ or: [a, b] }, { not: a }, { not: b }] });
    expect(result.valid).toBe(true);
    expect(notices(result)).toEqual([]);
  });

  test("【この形は検出しない】規則2本にまたがる重なり(規則は1本ずつしか見ない)", () => {
    // 同じ表に「条件なしで読める」と「誰も通さない条件つきで読める」を並べても、
    // **2本の関係を1つも見ない**(前者があるので後者は無意味だが、知らせない)。
    const result = applyDiff(
      dataRoot,
      APP_ID,
      setRolesDiff(
        withDefaults([
          {
            id: "member",
            rules: [
              { target: "table", table: "orders", can: ["read"] },
              { target: "table", table: "orders", can: ["read"], when: eq("status", "進行中") },
            ],
          },
        ]),
      ),
    );
    expect(result.valid).toBe(true);
    expect(notices(result)).toEqual([]);
  });

  test("【この形は検出しない】型の食い違い(真偽値の項目に文字列の定数)", () => {
    // `status` は text なので、数値の定数はどの行にも一致しないかもしれないが、
    // **カーネルは項目の型と定数の型を1度も突き合わせない。**
    const result = applyWhen(eq("status", 12345));
    expect(result.valid).toBe(true);
    expect(notices(result)).toEqual([]);
  });

  test("【この形は検出しない】ログイン済みの人に「自分」が常に偽になる場合", () => {
    // `assignee` に誰の識別子も入っていなければ「担当が自分」は1行も通さないが、
    // **データを1行も読まないので分からない**(`anonymous` のときだけ形から分かる)。
    const result = applyWhen(me("assignee"));
    expect(result.valid).toBe(true);
    expect(notices(result)).toEqual([]);
  });

  test("【禁止の履行】「黙って何もしない」を作っていない —— 知らせの欄は常に在る", () => {
    const result = applyWhen(eq("status", "進行中"));
    expect(result.valid).toBe(true);
    expect(Array.isArray(result.valid ? result.role_condition_notices : undefined)).toBe(true);
  });
});
