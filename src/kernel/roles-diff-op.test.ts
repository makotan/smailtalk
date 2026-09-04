/**
 * **役割の一覧の器を新設する**(`V8-M16-T02` / `T03`。台帳 `J-G1b` / ユーザ決定 `D-V8-31` /
 * メインの裁定 `R-1` `R-2` = `$defs/app` の9本目 `roles` ・
 * `$defs/operation.properties` の10キー目 `roles` ・ `DIFF_OPS` 17 → 18)。
 *
 * ## この検査が測るもの / 測らないもの(**先に書く**)
 *
 * **測るもの**:
 * 1. **`$defs/app` が9キーで閉じること**、そして **`$defs` の総数が 28 のままであること**
 *    (`user_kinds` = `ADR-0158` 限定8 と同じ作法 —— 値域をインラインで書き、
 *    新しい `$defs` を1本も作らない)。
 * 2. **`roles[]` の要素が `id` / `name` の2キーだけであること**(`rules` は `V8-M17` が足す。
 *    **本タスクは1バイトも書かない**)。
 * 3. **`roles[].id` の値域** = 予約4語(`owner` / `editor` / `viewer` / `anonymous`)
 *    ∪ `app.user_kinds[].id` と同じ形の文字列(`^[a-z0-9_]{1,32}$`)。
 * 4. **`$defs/app.user_kinds` の `items.id` の `not: { enum: [...] }` が1バイトも動いていないこと**
 *    (裁定 `R-2`。**「運営3ロールの予約が解けた」とは書かない**)。
 * 5. **18種目 `set_roles` が語彙に在ること**(`DIFF_OPS` の本数と全要素名)、
 *    **`$defs/operation.properties` が10キーで閉じること**、
 *    **既存17分岐すべてが `roles` を `false` で禁じること**。
 * 6. **同じ `id` を2回書けないこと**(適用時検査。`referential-integrity.ts`)。
 * 7. **`undo` / `redo` / `dry_run_diff` / `_changelog` / 要件定義書がこの op をどう扱うか**。
 *
 * **測らないもの(誇張しない)**:
 * 1. **判定の実装は本タスクに1バイトも無い。** 役割を宣言しても、行の読取・書込・削除の
 *    ふるまいは今日どおりである(面の規則 `rules` は `V8-M17`、条件 `when` は `V8-M18`)。
 * 2. **`_auth_users.role` の列にも、7本目の付与表にも1バイトも触っていない。**
 * 3. **HTTP の口を1本も足していない**(`J-G4` は却下。`HTTP_ENTRY_POINTS` は動かない)。
 * 4. **ブラウザで画面を1枚も開いていない。**
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import diffSchema from "../../schemas/diff.schema.json" with { type: "json" };
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import { applyDiff } from "./apply-diff.ts";
import { applyManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { dryRunDiff } from "./dry-run.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { generateRequirementsDoc } from "./requirements-doc.ts";
import { DIFF_OPS, type Diff, type Manifest } from "./types.ts";
import { previewRedo, previewUndo, redo, undo } from "./undo.ts";

type Any = Record<string, unknown>;

const APP_ID = "shop";

let dataRoot: string;
let store: KernelMetaStore;

function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "店",
      tables: [
        {
          id: "orders",
          name: "注文",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
        },
      ],
      views: [{ id: "order-list", type: "list_view", table: "orders", columns: ["title"] }],
    },
  };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-roles-op-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "店", { app_id: APP_ID });
  const applied = applyManifest(dataRoot, APP_ID, baseManifest());
  if (!applied.valid) {
    throw new Error("テスト前提の初期マニフェスト投入に失敗しました。");
  }
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

/*
 * **【2026-08-09。`V8-M17` が既定3本を消せないようにしたことによる追随】**
 * **旧の逐語**: `const ROLES = [{ id: "owner", name: "運営" }, { id: "member", name: "会員" }];`
 * **`V8-M17` が「既定の役割定義3本(`owner` / `editor` / `viewer`)は消せない」を
 * 適用時検査で塞いだ**(台帳 `J-G2` / ユーザ決定 `D-V8-26` / メインの判断。
 * 検査は `src/kernel/referential-integrity.ts` の類型17)ので、**`set_roles` を打つ検査は
 * どれも3本を含めて書く。** **本ファイルが測っている主題(18種目の op が在ること・
 * 全体差し替えであること・器が閉じていること)は1ミリも変えていない。**
 */
const ROLES = [
  {
    id: "owner",
    name: "運営",
    rules: [
      // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
      { target: "app", can: ["write"] },
      { target: "role", can: ["write"] },
    ],
  },
  { id: "editor", name: "編集者" },
  { id: "viewer", name: "閲覧者" },
  { id: "member", name: "会員" },
];

/** 既定3本(`V8-M17` が必須にした)を先頭に足す。 */
function withDefaultRoles(roles: { id: string; name?: string }[]): { id: string; name?: string }[] {
  const declared = new Set(roles.map((role) => role.id));
  // **【`V8-M28` / `T-G16a`(2026-08-11)。旧の逐語を残す】**
  // **旧: `.map((id) => ({ id })),`** —— **今日は持ち主に2本の規則が要る**(類型17 の拡張)。
  return [
    ...["owner", "editor", "viewer"]
      .filter((id) => !declared.has(id))
      .map((id) =>
        id === "owner"
          ? ({
              id,
              rules: [
                { target: "app", can: ["write"] },
                { target: "role", can: ["write"] },
              ],
            } as { id: string; name?: string })
          : { id },
      ),
    ...roles,
  ];
}

function setRolesDiff(roles: unknown, diffId = "d1"): Diff {
  return {
    diff_id: diffId,
    intent: "役割を宣言する",
    operations: [{ op: "set_roles", roles }],
  } as unknown as Diff;
}

function manifestDefs(): Record<string, Any> {
  return (manifestSchema as unknown as { $defs: Record<string, Any> }).$defs;
}

function appDefs(): Any {
  return manifestDefs().app as Any;
}

function rolesSchema(): Any {
  return ((appDefs().properties as Any).roles ?? {}) as Any;
}

function operationDefs(): Any {
  return ((diffSchema as unknown as { $defs: Record<string, Any> }).$defs.operation ?? {}) as Any;
}

// ---------------------------------------------------------------------------
// (T02-1) `$defs/app` の9本目 —— **`$defs` は1本も増えない**
// ---------------------------------------------------------------------------

/*
 * **【`V8-M18` / 台帳 `J-G12`(`ADR-0007` 門A 本審査 = 限定採用)による追随。2026-08-09】**
 * **旧 describe 名の逐語**: 「**(T02-1) `$defs/app` は9キーで閉じ、`$defs` の総数は
 * 28 のままである**」。**旧テスト名の逐語**: 「**`$defs` の総数は 28(値域をインラインで
 * 書き、新しい `$defs` を1本も作らない)**」。**旧本体の逐語**:
 * `expect(Object.keys(manifestDefs())).toHaveLength(28)`。
 *
 * **28 → 29 にしたのは `V8-M18` の条件(`when`)であり、旧本体のコメントが
 * 「`V8-M18` の条件 `when` だけが 28 → 29 を行う」と名指しで予告していたとおりである**
 * (裁定 `R-7` / `R-17-1`)。**`V8-M16` の増分は今日も `$defs` を1本も増やしていない** ——
 * **9本目の `roles` は値域をインラインで書いている**(`ADR-0158` 限定8 と同じ作法)。
 * **旧文を1バイトも消していない。**
 */
describe("(T02-1) `$defs/app` は9キーで閉じ、`$defs` の総数は 29 である", () => {
  test("`$defs` の総数は 29(`V8-M16` は1本も増やしておらず、増やしたのは `V8-M18` の1本だけ)", () => {
    // **`user_kinds`(`ADR-0158` 限定8)と同じ作法である。**
    // ここが 30 になったら、それは門A を通していない `$defs` が入った合図である。
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値を 29 → 30 へ書き換えた。**
    // **旧行の逐語**: `expect(Object.keys(manifestDefs())).toHaveLength(29);`
    // **書き換えた理由**: この行が固定していたのは「**その決定**が新しい `$defs` を作らなかったこと」
    // であり、**30本目を作ったのは別の決定である**(`V8-M8` が集計表の中身 `$defs/report` を新設した)。
    // **検査は消していない。**
    expect(Object.keys(manifestDefs())).toHaveLength(30);
    // **増えた1本の名前を固定する** —— 件数だけを見ると「1本消して1本足す」が素通りする。
    expect(Object.keys(manifestDefs())).toContain("role_condition");
  });

  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】**
  // **`app.user_kinds` の器を撤去したので、期待値から `"user_kinds"` を1行外した(9 → 8)。**
  // **旧(逐語)**: `expect(Object.keys(appDefs().properties as Any)).toEqual(["id","name","tables","views","workflows","functions","theme","user_kinds","roles"]);`
  // **テスト名の「user_kinds」と「9つ」は当時の逐語である**(テスト名は書き換えない。検査は1本も減らしていない)。
  test("キーは id / name / tables / views / workflows / functions / theme / user_kinds / roles の9つ", () => {
    expect(Object.keys(appDefs().properties as Any)).toEqual([
      "id",
      "name",
      "tables",
      "views",
      "workflows",
      "functions",
      "theme",
      // **`V8-M16-T02` が足した9本目。**10本目を足す提案は `ADR-0013` §4c の3問に
      // 改めて答えたうえで門A を通すこと。
      // **本廃止で `roles` は8本目(最後)になった。**
      "roles",
    ]);
  });

  test("`required` は着手前と同じ4本のままである(`roles` は省略できる)", () => {
    expect(appDefs().required).toEqual(["id", "name", "tables", "views"]);
    expect(appDefs().additionalProperties).toBe(false);
  });

  test("`$comment` は `ADR-0013` §4c の3問と、10本目への同じ関門を書いている", () => {
    const comment = String(rolesSchema().$comment ?? "");
    expect(comment).toContain("ADR-0013");
    expect(comment).toContain("§4c");
    expect(comment).toContain("10本目");
  });
});

// ---------------------------------------------------------------------------
// (T02-2) `roles[]` の形 —— **`id` / `name` の2キーだけ**
// ---------------------------------------------------------------------------

/*
 * **【`V8-M17` / `J-G6`〜`J-G11`(`ADR-0007` 門A 本審査 = 6行とも限定採用)による追随。
 * 2026-08-09】** **旧 describe 名の逐語**: 「**(T02-2) `roles[]` の要素は `id` / `name` の
 * 2キーだけで閉じる**」。**3キー目 `rules`(役割に束ねた「できること」)を足したのは
 * `V8-M17` であり、メインの裁定 `R-1` の表が追跡先を割った結果である**
 * (`V8-M16` = 器 / `V8-M17` = 器の内側)。**`V8-M16` の増分は今日も `id` / `name` の
 * 2本である。****旧文を1バイトも消していない。**
 * **`rules` そのものの検査は `src/kernel/role-rules.test.ts` に在る** —— **ここは
 * 「器が3キーで閉じていること」だけを見る**(重複させない)。
 */
describe("(T02-2) `roles[]` の要素は `id` / `name` / `rules` の3キーだけで閉じる", () => {
  test("要素のキーは3つで、`additionalProperties` は false", () => {
    const items = rolesSchema().items as Any;
    // **【2026-08-14 追記(`V8-M1-T02`。台帳 `I-G1` / `I-G6` = どちらも 限定採用。
    // `ADR-0334` 限定1)。旧の期待値を1バイトも消していない】**
    // **旧(逐語)**: `expect(Object.keys(items.properties as Any)).toEqual(["id", "name", "rules"]);`
    // **4キー目 `signup`(この役割で登録できるか)を `V8-M1-T02` が足した** ——
    // **`V8-M16` の増分は今日も `id` / `name` の2本であり、`rules` は `V8-M17`、
    // `signup` は `V8-M1` の増分である**(足した主体を混ぜない)。
    // **`signup` そのものの検査は `src/kernel/role-signup-mode.test.ts` に在る** ——
    // **ここは「器が4キーで閉じていること」だけを見る**(重複させない)。
    // **テスト名の「3キー」は当時の逐語である**(テスト名は書き換えない)。
    expect(Object.keys(items.properties as Any)).toEqual(["id", "name", "rules", "signup"]);
    expect(items.additionalProperties).toBe(false);
    expect(items.required).toEqual(["id"]);
  });

  test("条件(`when`)は `roles[]` ではなく `rules[]` の内側に在る(器は3キーのまま)", () => {
    // **旧テスト名の逐語(その1。`V8-M16` 当時)**: 「**`rules` を1バイトも書いていない
    // (`V8-M17` の担当である)**」。
    // **旧テスト名の逐語(その2。`V8-M17` 当時)**: 「**条件(`when`)を1バイトも
    // 書いていない(`V8-M18` の担当である)**」。**旧本体の逐語(その2)**:
    // `expect(((((items.properties as Any).rules as Any).items as Any).properties as Any).when)
    //   .toBeUndefined()`。
    //
    // **【`V8-M18` / 台帳 `J-G12`〜`J-G16` による追随。2026-08-09】**
    // **`when` は `V8-M18` が足した。****主張の残りは1ミリも弱めていない** ——
    // **器(`roles[]` の要素)は今日も `id` / `name` / `rules` の3キーで閉じており、
    // `when` は `rules[]` の**内側**のキーである**(裁定 `R-17-1` の逐語
    // 「**`roles[]` 自身には `when` を足さない**」)。**旧文を1バイトも消していない。**
    const items = rolesSchema().items as Any;
    expect((items.properties as Any).rules).toBeDefined();
    expect((items.properties as Any).when).toBeUndefined();
    expect(((items.properties as Any).rules as Any).items).toBeDefined();
    expect(
      ((((items.properties as Any).rules as Any).items as Any).properties as Any).when,
    ).toBeDefined();
  });

  test("要素数の上限は 12(予約4 + 宣言分8。`user_kinds` の上限8 と同型)", () => {
    expect(rolesSchema().minItems).toBe(1);
    expect(rolesSchema().maxItems).toBe(12);
    expect(rolesSchema().uniqueItems).toBe(true);
  });

  test("`id` の値域は予約4語 ∪ `user_kinds[].id` と同じ形である", () => {
    const id = ((rolesSchema().items as Any).properties as Any).id as Any;
    expect(id.pattern).toBe("^[a-z0-9_]{1,32}$");
    // **`user_kinds` と違って `not: { enum: [...] }` を持たない** —— 予約4語は
    // `roles[].id` の**主体として書ける**(裁定 `R-2`)。
    expect(id.not).toBeUndefined();
  });

  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a` / `T-G11`。判定値 = 廃止】**
  // **`app.user_kinds` の器そのものが撤去されたので、この検査が見ていた場所は今日1つも無い。**
  // **旧(逐語)**:
  //     `const kinds = (appDefs().properties as Any).user_kinds as Any;`
  //     `expect(((kinds.items as Any).properties as Any).id).toMatchObject({`
  //     `  pattern: "^[a-z0-9_]{1,32}$",`
  //     `  not: { enum: ["owner", "editor", "viewer", "anonymous"] },`
  //     `});`
  //     `expect(kinds.minItems).toBe(1);`
  //     `expect(kinds.maxItems).toBe(8);`
  //     `expect(kinds.uniqueItems).toBe(true);`
  // **検査は消していない。測る対象を「器が消えたこと」と「裁定 `R-2` が守っていた予約が
  // どこで効いているか」へ移した** —— **「運営3ロールの予約が解けた」とは今日も書かない。**
  // **予約は行ごとのアクセス権の側(`table.access_control.permissions[].id`)で効いている。**
  // **テスト名の `$defs/app.user_kinds` は当時の逐語である**(テスト名は書き換えない)。
  test("`$defs/app.user_kinds` の `items.id` の予約語除外は1バイトも動いていない", () => {
    // (1) 器そのものが今日は無い。
    expect(Object.hasOwn(appDefs().properties as Any, "user_kinds")).toBe(false);
    // (2) 予約4語の締め出しは、行ごとのアクセス権の側に今日も在る(1バイトも触っていない)。
    const permissionId = ((
      ((((manifestDefs().table as Any).properties as Any).access_control as Any).properties as Any)
        .permissions as Any
    ).items ?? {}) as Any;
    expect((permissionId.properties as Any).id).toMatchObject({
      pattern: "^[a-z0-9_]{1,32}$",
      not: { enum: ["owner", "editor", "viewer", "anonymous"] },
    });
  });
});

// ---------------------------------------------------------------------------
// (T03-1) 語彙 —— 18種目が在る
// ---------------------------------------------------------------------------

describe("(T03-1) `DIFF_OPS` は 17 → 18 になり、増えたのは `set_roles` の1つだけである", () => {
  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】**
  // **`set_user_kinds` を撤去したので 18 → 17。**
  // **旧(逐語)**: `expect(DIFF_OPS).toHaveLength(18);`
  // **テスト名の「18」は当時の逐語である**(テスト名は書き換えない。検査は1本も減らしていない)。
  test("本数は 18 である", () => {
    expect(DIFF_OPS).toHaveLength(17);
  });

  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】**
  // **`set_user_kinds` は今日の語彙に無いので、期待値の末尾から1件外した(17 → 16)。**
  // **旧(逐語)**: 一覧の末尾は `"set_theme", "set_user_kinds",` の2件であった。
  // **`V8-M16` 着手前の17 op のうち、消えたのはこの1本だけである**(残る16本は1つも消えていない)。
  // **テスト名の「17 op」は当時の逐語である**(テスト名は書き換えない)。
  test("着手前の17 op が1つも消えていない(名前で持つ)", () => {
    expect(DIFF_OPS).toEqual(
      expect.arrayContaining([
        "add_table",
        "add_field",
        "add_view",
        "update_view",
        "remove_field",
        "remove_table",
        "change_table",
        "change_field",
        "remove_view",
        "add_workflow",
        "update_workflow",
        "remove_workflow",
        "add_function",
        "update_function",
        "remove_function",
        "set_theme",
      ]),
    );
  });

  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】**
  // **`set_user_kinds` の撤去で添字が1つ前へ寄り、`set_roles` は17種目(末尾)になった。**
  // **旧(逐語)**: `expect(DIFF_OPS[17]).toBe("set_roles");`
  // **テスト名の「18種目」は当時の逐語である**(テスト名は書き換えない)。
  // **「末尾である」という主張は1ミリも弱めていない**(下の1行が添字ではなく末尾で測り直す)。
  test("18種目は末尾の `set_roles` である", () => {
    expect(DIFF_OPS[16]).toBe("set_roles");
    expect(DIFF_OPS[DIFF_OPS.length - 1]).toBe("set_roles");
  });

  test("19種目を足していない(部分更新・削除の op は1つも無い)", () => {
    // **全体差し替えの1本だけである**(`set_user_kinds` / `set_theme` と同型)。
    for (const forbidden of [
      "add_role",
      "remove_role",
      "update_role",
      "unset_roles",
      "change_roles",
      "grant_role",
      "revoke_role",
    ]) {
      expect(DIFF_OPS as readonly string[]).not.toContain(forbidden);
    }
  });

  test("`schemas/diff.schema.json` の `op_name.enum` は `DIFF_OPS` と同順・同内容である", () => {
    const opName = (diffSchema as unknown as { $defs: Record<string, Any> }).$defs.op_name as Any;
    expect(opName.enum).toEqual([...DIFF_OPS]);
  });
});

// ---------------------------------------------------------------------------
// (T03-2) `$defs/operation.properties` は10キーで閉じる
// ---------------------------------------------------------------------------

describe("(T03-2) `$defs/operation.properties` は10キーで閉じる", () => {
  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a` / `T-G11`。判定値 = 廃止】**
  // **`user_kinds` キーを撤去したので、期待値から1行外した(10 → 9)。**
  // **旧(逐語)**: `expect(Object.keys(operationDefs().properties as Any)).toEqual(["op","table","field","view","changes","workflow","function","theme","user_kinds","roles"]);`
  // **テスト名の「user_kinds」と「10」は当時の逐語である**(テスト名は書き換えない)。
  test("キーは op / table / field / view / changes / workflow / function / theme / user_kinds / roles の10", () => {
    expect(Object.keys(operationDefs().properties as Any)).toEqual([
      "op",
      "table",
      "field",
      "view",
      "changes",
      "workflow",
      "function",
      "theme",
      "roles",
    ]);
  });

  test("`set_roles` 以外の全17分岐が `roles` を `false` で禁じる(`ADR-0013` §4c 問2 の名指し)", () => {
    const branches = (operationDefs().allOf ?? []) as Any[];
    const denied: string[] = [];
    for (const branch of branches) {
      const ifProps = ((branch.if as Any)?.properties ?? {}) as Any;
      const op = ((ifProps.op ?? {}) as Any).const as string | undefined;
      const thenProps = (((branch.then as Any)?.properties ?? {}) as Any).roles;
      if (op !== undefined && op !== "set_roles" && thenProps === false) {
        denied.push(op);
      }
    }
    // **数ではなく名指しで全17件**(`ADR-0013` §4c 問2 の作法)。
    // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】**
    // **`set_user_kinds` の分岐そのものが無くなったので、名指しの一覧から1件外した(17 → 16)。**
    // **旧(逐語)**: 一覧の末尾は `"set_theme", "set_user_kinds",` の2件であった。
    // **テスト名の「全17分岐」は当時の逐語である**(テスト名は書き換えない)。
    expect(denied).toEqual([
      "add_table",
      "add_field",
      "add_view",
      "update_view",
      "remove_field",
      "remove_table",
      "change_table",
      "change_field",
      "remove_view",
      "add_workflow",
      "update_workflow",
      "remove_workflow",
      "add_function",
      "update_function",
      "remove_function",
      "set_theme",
    ]);
  });

  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】**
  // **`user_kinds` キーが消えたので、`set_roles` の分岐が禁じるのは他7キーになった(他9キー → 他7キー)。**
  // **旧(逐語)**: `expect(thenProps.user_kinds).toBe(false);` の1行が `theme` の次に在った。
  // **テスト名の「他9キー」は当時の逐語である**(テスト名は書き換えない。検査は1本も減らしていない)。
  test("`set_roles` の分岐は他9キーをすべて `false` で禁じる(全体差し替え)", () => {
    const branches = (operationDefs().allOf ?? []) as Any[];
    const branch = branches.find(
      (b) => ((((b.if as Any)?.properties ?? {}) as Any).op as Any)?.const === "set_roles",
    );
    expect(branch).toBeDefined();
    const thenProps = ((branch?.then as Any)?.properties ?? {}) as Any;
    expect(thenProps.table).toBe(false);
    expect(thenProps.field).toBe(false);
    expect(thenProps.view).toBe(false);
    expect(thenProps.changes).toBe(false);
    expect(thenProps.workflow).toBe(false);
    expect(thenProps.function).toBe(false);
    expect(thenProps.theme).toBe(false);
    // **`user_kinds` は器ごと撤去されたので、禁じる相手が今日1つも無い**(上のコメント参照)。
    expect(Object.hasOwn(thenProps, "user_kinds")).toBe(false);
    expect((branch?.then as Any)?.required).toEqual(["roles"]);
  });

  test("値域の定義は1箇所しか無い(差分スキーマは `$ref` するだけ)", () => {
    const branches = (operationDefs().allOf ?? []) as Any[];
    const branch = branches.find(
      (b) => ((((b.if as Any)?.properties ?? {}) as Any).op as Any)?.const === "set_roles",
    );
    const payload = (((branch?.then as Any)?.properties ?? {}) as Any).roles as Any;
    expect(payload.$ref).toBe(
      "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/app/properties/roles",
    );
    expect(payload.enum).toBeUndefined();
    expect(payload.maxItems).toBeUndefined();
    expect(payload.items).toBeUndefined();
  });

  test("`allOf` の各要素は if / then / else 以外のキーを持たない(新分岐も同じ)", () => {
    for (const branch of (operationDefs().allOf ?? []) as Any[]) {
      for (const key of Object.keys(branch)) {
        expect(["if", "then", "else"]).toContain(key);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// (T03-3) 適用と拒否
// ---------------------------------------------------------------------------

describe("(T03-3) `set_roles` を適用すると宣言がマニフェストに入る", () => {
  test("宣言が無いアプリに初回適用できる", () => {
    const result = applyDiff(dataRoot, APP_ID, setRolesDiff(ROLES));
    expect(result.valid).toBe(true);
    const manifest = result.valid ? result.manifest : undefined;
    expect((manifest?.app as unknown as Any | undefined)?.roles).toEqual(ROLES);
  });

  test("予約4語(owner / editor / viewer / anonymous)を主体として書ける(裁定 `R-2`)", () => {
    const reserved = [
      {
        id: "owner",
        name: "運営",
        rules: [
          // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
          { target: "app", can: ["write"] },
          { target: "role", can: ["write"] },
        ],
      },
      { id: "editor", name: "編集者" },
      { id: "viewer", name: "閲覧者" },
      { id: "anonymous", name: "未ログイン" },
    ];
    const result = applyDiff(dataRoot, APP_ID, setRolesDiff(reserved));
    expect(result.valid).toBe(true);
    const manifest = result.valid ? result.manifest : undefined;
    expect((manifest?.app as unknown as Any | undefined)?.roles).toEqual(reserved);
  });

  test("`name` は省略できる(`id` だけの要素が通る)", () => {
    const result = applyDiff(dataRoot, APP_ID, setRolesDiff(withDefaultRoles([{ id: "member" }])));
    expect(result.valid).toBe(true);
  });

  test("既に宣言があるアプリでは丸ごと差し替わる(部分更新ではない)", () => {
    expect(applyDiff(dataRoot, APP_ID, setRolesDiff(ROLES)).valid).toBe(true);
    const next = withDefaultRoles([{ id: "viewer", name: "閲覧者だけ残す" }]);
    const result = applyDiff(dataRoot, APP_ID, setRolesDiff(next, "d2"));
    expect(result.valid).toBe(true);
    const manifest = result.valid ? result.manifest : undefined;
    expect((manifest?.app as unknown as Any | undefined)?.roles).toEqual(next);
  });

  test("テーブル・ビュー・レコードを1つも失わない", () => {
    const result = applyDiff(dataRoot, APP_ID, setRolesDiff(ROLES));
    expect(result.valid).toBe(true);
    const manifest = result.valid ? result.manifest : undefined;
    expect(manifest?.app.tables).toHaveLength(1);
    expect(manifest?.app.views).toHaveLength(1);
  });

  test("空配列は拒否される(宣言を消す手段を作らない)", () => {
    expect(applyDiff(dataRoot, APP_ID, setRolesDiff([])).valid).toBe(false);
  });

  test("13件目は拒否される(上限12 = 予約4 + 宣言分8)", () => {
    const thirteen = Array.from({ length: 13 }, (_, i) => ({ id: `r${i}`, name: `役割${i}` }));
    expect(applyDiff(dataRoot, APP_ID, setRolesDiff(thirteen)).valid).toBe(false);
  });

  test("同じ `id` を2回書くと拒否される(名前が違っても拒否する)", () => {
    // **`user_kinds` が今日も塞げていない穴**(`uniqueItems` はオブジェクト全体の
    // 同値でしか効かない)を、`roles` では適用時検査で塞いでいる。
    const dup = withDefaultRoles([
      { id: "member", name: "会員" },
      { id: "member", name: "メンバー" },
    ]);
    expect(applyDiff(dataRoot, APP_ID, setRolesDiff(dup)).valid).toBe(false);
  });

  test("識別子の形の外(日本語 / 空白 / 33文字 / 大文字)は拒否される", () => {
    for (const bad of ["会員", "two words", "a".repeat(33), "Member"]) {
      expect(
        applyDiff(dataRoot, APP_ID, setRolesDiff(withDefaultRoles([{ id: bad, name: "x" }]))).valid,
      ).toBe(false);
    }
  });

  test("空の `rules` を書くと拒否される", () => {
    // **旧テスト名の逐語**: 「**`rules` を書くと拒否される(`V8-M17` が足すまで存在しない)**」。
    // **`V8-M17` が `rules` を足したので、拒否の理由が変わった** —— **今日は
    // `minItems: 1` が空配列を拒否している**(「規則を0本書く」と「書かない」の
    // 2通りを作らないため)。**この差分が拒否されること自体は1ミリも変わっていない。**
    const withRules = withDefaultRoles([{ id: "member", name: "会員" }]).map((role) =>
      role.id === "member" ? { ...role, rules: [] } : role,
    );
    expect(applyDiff(dataRoot, APP_ID, setRolesDiff(withRules)).valid).toBe(false);
  });

  test("`changes` を同居させると拒否される", () => {
    const diff = {
      diff_id: "d9",
      intent: "x",
      operations: [{ op: "set_roles", roles: ROLES, changes: { name: "y" } }],
    } as unknown as Diff;
    expect(applyDiff(dataRoot, APP_ID, diff).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (T03-4) undo / redo / dry_run_diff / 変更履歴 / 要件定義書 —— **実測**
// ---------------------------------------------------------------------------

describe("(T03-4) 差分操作を足すと当たる先(**実測。推測を書かない**)", () => {
  test("`dry_run_diff` は状態を1バイトも変えずに valid を返す", () => {
    const dry = dryRunDiff(dataRoot, APP_ID, setRolesDiff(ROLES));
    expect(dry.valid).toBe(true);
    const manifestPath = join(dataRoot, "apps", APP_ID, "manifest.json");
    const onDisk = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    expect((onDisk.app as unknown as Any).roles).toBeUndefined();
  });

  test("`dry_run_diff` は不正な宣言を適用前に弾く", () => {
    expect(dryRunDiff(dataRoot, APP_ID, setRolesDiff([])).valid).toBe(false);
  });

  test("`undo` は宣言を「宣言が無い状態」へ戻す", () => {
    expect(applyDiff(dataRoot, APP_ID, setRolesDiff(ROLES)).valid).toBe(true);
    expect(previewUndo(dataRoot, APP_ID).valid).toBe(true);
    const result = undo(dataRoot, APP_ID);
    expect(result.valid).toBe(true);
    const manifest = result.valid ? result.manifest : undefined;
    expect((manifest?.app as unknown as Any | undefined)?.roles).toBeUndefined();
  });

  test("`redo` は宣言を戻す", () => {
    expect(applyDiff(dataRoot, APP_ID, setRolesDiff(ROLES)).valid).toBe(true);
    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    expect(previewRedo(dataRoot, APP_ID).valid).toBe(true);
    const result = redo(dataRoot, APP_ID);
    expect(result.valid).toBe(true);
    const manifest = result.valid ? result.manifest : undefined;
    expect((manifest?.app as unknown as Any | undefined)?.roles).toEqual(ROLES);
  });

  test("`_changelog` に op 名と宣言の中身がそのまま残る", () => {
    expect(applyDiff(dataRoot, APP_ID, setRolesDiff(ROLES)).valid).toBe(true);
    const applied = store.listChangelog(APP_ID).filter((e) => e.kind === "apply");
    expect(applied.length).toBeGreaterThan(0);
    const last = applied[applied.length - 1];
    expect(JSON.stringify(last?.operations)).toContain("set_roles");
    expect(JSON.stringify(last?.operations)).toContain("member");
  });

  test("要件定義書の履歴節に op 名が出る(`diff_op` の語彙は `DIFF_OPS` から来る)", () => {
    expect(applyDiff(dataRoot, APP_ID, setRolesDiff(ROLES)).valid).toBe(true);
    const doc = generateRequirementsDoc(dataRoot, APP_ID);
    expect(doc.markdown).toContain("set_roles");
  });

  test("要件定義書は宣言の**中身**を1文も述べない(**述べていないことを書く**)", () => {
    // **【`V8-M22`。ユーザ決定 `D-V8-36`(2026-08-10。逐語は
    // `docs/plan/v8/03-user-decisions.md` §4e)/ `ADR-0315` による追随。旧を消さず書き分ける】**
    // **旧(当時。テスト名の逐語のまま残す)**: `set_theme` / `set_user_kinds` と同じ扱いで、
    // 履歴節に op 名は出るが、宣言した役割の表示名(運営 / 会員)を述べる文は1つも作って
    // いなかった —— `expect(text).not.toContain("会員")` が当時は真だった。
    // **今日**: `D-V8-36` が「役割と、できることまで載せる」を選んだ([選ばれた見出し])。
    // 説明文の逐語(§4e)が「この案では『会員は注文を見られます / 書けます』のように、
    // 役割の名前と、その役割ができることが文章として出ます」と述べるとおり、
    // `role_id` / `role_name` は今日 features 節に文として出る(`ADR-0315`)。
    // **【禁止】assertion を弱めて緑にしない】** —— 「述べない」側の主張を消すのではなく、
    // 「述べていること」を積極的に確かめる形へ入れ替える。
    expect(applyDiff(dataRoot, APP_ID, setRolesDiff(ROLES)).valid).toBe(true);
    const text = generateRequirementsDoc(dataRoot, APP_ID).markdown;
    expect(text).toContain("会員");
    // 4本の役割すべてについて、識別子の文と表示名の文が両方出ることを確かめる
    // (`ADR-0315` が `role_id` はバッククォート・`role_name` は鉤括弧で描くと定めた形)。
    for (const role of ROLES) {
      expect(text).toContain(`このアプリは役割 \`${role.id}\` を持つ。`);
      expect(text).toContain(`役割 \`${role.id}\` の表示名は 「${role.name}」 である。`);
    }
  });

  test("マイグレーションを1つも生まない(物理スキーマを1バイトも動かさない)", () => {
    const dry = dryRunDiff(dataRoot, APP_ID, setRolesDiff(ROLES));
    expect(dry.valid).toBe(true);
    if (dry.valid) {
      expect(dry.report.plan.add_tables).toHaveLength(0);
      expect(dry.report.plan.add_fields).toHaveLength(0);
      expect(dry.report.plan.steps ?? []).toHaveLength(0);
    }
  });
});
