/**
 * ロール語彙の3箇所同期テスト(V2-M1-T01 / ADR-0033 限定1)。
 *
 * `customer` の追加は「1語足すだけ」の差分だが、足す場所が3つに分かれている:
 *   1. `Role` 型          —— `src/auth/types.ts`
 *   2. CHECK 制約         —— `src/auth/store.ts` の `ROLE_COLUMN_DDL`
 *   3. `ROLE_VALUES`      —— `src/server/auth-routes.ts`(バリデーション語彙)
 *
 * 3つがずれると「型は customer を許すのに CHECK が弾く」等の齟齬が静かに入る。ADR-0033
 * §3 限定1 / この ADR の限界1 に従い、**ずれたら赤くなる**機械検査でここを固定する。
 * 5番目のロールを1箇所にだけ足しても、このテストと tsc が落ちる。
 *
 * ---
 *
 * ## **【`V5-M17-T03` / `G-G5` / `ADR-0158` §1 (c)】前提そのものが変わったので置き換えた**
 *
 * **上の段落を1バイトも書き換えていない**(当時の条文を読めるように残す作法)。
 * **`ADR-0158` §1 (c) の逐語**: 「**ロール値の集合が「実装が持つ定数」から「アプリが持つ
 * データ」へ移る。** 今日 `Role` の union / `CHECK` / `ROLE_VALUES` の3箇所を機械的に
 * 同期させている検査 … は、**その前提そのものが変わる。** 検査を置き換えなければ、
 * 同期の歯止めが消える。」
 *
 * **したがって、このファイルは削除していない。** **測る対象を入れ替えた。**
 *
 * | 着手前に測っていたこと | 今日測ること |
 * |---|---|
 * | `ROLE_VALUES` が `customer` を含む**4値**である | **予約3ロールが3箇所で一致する** |
 * | `CHECK` の `IN (...)` が `ROLE_VALUES` と集合一致する | **`CHECK` は値を列挙せず識別子の形だけを見る**(`ADR-0158` 限定5 / `ADR-0233`) |
 * | ―― | **実装が非運営の種類を4値目の定数として持たない** |
 * | ―― | **非運営の判定が `isReservedRole` の否定1本である** |
 *
 * ## **この置き換えで測らなくなったこと(隠さない)**
 *
 * **「型 / `CHECK` / `ROLE_VALUES` の3箇所が同じ**値の集合**を持つ」ことは、もう測れない。**
 * **`CHECK` は形しか見ず、`ROLE_VALUES` はアプリごとに変わるからである。**
 * **`ADR-0158` §1 (c) が言うとおり、歯止めの一部は消えた。** **消えた分を部分的に埋めるのは、
 * 非運営の判定を `isReservedRole` の否定1本に閉じたこと(`src/auth/types.ts`)と、
 * それを機械的に固定する `src/server/declared-user-kind-scope.test.ts` である。**
 * **「同じ強さで置き換えた」とは書かない** —— **測っていない。**
 */
import { describe, expect, test } from "bun:test";
// **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】旧(逐語)**:
//     import { reservedRoleValues, roleValuesForKinds } from "../server/auth-routes.ts";
// **`roleValuesForKinds(kinds)` は引数の唯一の出所(`app.user_kinds`)ごと廃止され、
// 引数を持たない `baseRoleValues()` になった。**
import { baseRoleValues, reservedRoleValues } from "../server/auth-routes.ts";
import { ROLE_COLUMN_DDL } from "./store.ts";
import { DEFAULT_USER_KIND, isReservedRole, RESERVED_ROLES, type ReservedRole } from "./types.ts";

/** `B` が `A` に代入可能(B ⊆ A)なときだけ型チェックが通る補助。 */
type AssertExtends<A, B extends A> = B;

/** `reservedRoleValues()` の要素として観測される文字列リテラル union。 */
type ReservedRoleValuesElement = ReturnType<typeof reservedRoleValues>[number];

// --- コンパイル時: `ReservedRole` ⟺ `reservedRoleValues()` の要素 union が双方向一致する ---
// (a) ReservedRole ⊆ ReservedRoleValuesElement: 予約ロールはすべて API 側の語彙に載っている。
type _ReservedCoveredByValues = AssertExtends<ReservedRoleValuesElement, ReservedRole>;
// (b) ReservedRoleValuesElement ⊆ ReservedRole: API 側の予約語彙に予約ロール外が混じらない。
type _ValuesAreReserved = AssertExtends<ReservedRole, ReservedRoleValuesElement>;
const _reservedCovered: _ReservedCoveredByValues = "owner";
const _valuesAreReserved: _ValuesAreReserved = "owner";

/** CHECK 制約 DDL の `IN ('a','b',...)` から role 文字列集合を取り出す。 */
function checkRolesFromDdl(ddl: string): Set<string> {
  const match = ddl.match(/IN\s*\(([^)]*)\)/i);
  const inner = match?.[1];
  if (inner === undefined) {
    return new Set();
  }
  return new Set([...inner.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? ""));
}

describe("予約3ロールの3箇所同期(`ReservedRole` 型 / CHECK / `reservedRoleValues`)", () => {
  test("`RESERVED_ROLES` は運営3ロールちょうどである(4値目を実装が持たない)", () => {
    expect([...RESERVED_ROLES].sort()).toEqual(["editor", "owner", "viewer"]);
    expect(RESERVED_ROLES as readonly string[]).not.toContain(DEFAULT_USER_KIND);
    expect(RESERVED_ROLES as readonly string[]).not.toContain("anonymous");
  });

  test("`reservedRoleValues()` は `RESERVED_ROLES` と集合として一致する", () => {
    expect(new Set(reservedRoleValues())).toEqual(new Set(RESERVED_ROLES));
  });

  test("CHECK 制約は値を1つも列挙しない(値域はアプリの宣言に移った)", () => {
    // **着手前はここで `IN ('owner','editor','viewer','customer')` との集合一致を見ていた。**
    // **`ADR-0158` 限定5 / `ADR-0233` が `CHECK` を「識別子の形」に作り替えたので、
    // 列挙は1つも無い。**
    expect(checkRolesFromDdl(ROLE_COLUMN_DDL).size).toBe(0);
    expect(ROLE_COLUMN_DDL).toContain("NOT GLOB");
  });

  test("予約3ロールと既定の1本目は、新しい CHECK の形を1つも外れていない", () => {
    // **実際に SQLite で通ることは `role-check-migration.test.ts` が本物の DB で測る。**
    // **ここでは綴りの側からだけ見る。**
    for (const role of [...RESERVED_ROLES, DEFAULT_USER_KIND]) {
      expect(role).toMatch(/^[a-z0-9_]{1,32}$/);
    }
  });

  test("`isReservedRole` は予約3ロールだけを真にする(非運営の判定はこの否定1本)", () => {
    for (const role of RESERVED_ROLES) {
      expect(isReservedRole(role)).toBe(true);
    }
    for (const role of [
      DEFAULT_USER_KIND,
      "member",
      "supplier",
      "anonymous",
      "",
      null,
      undefined,
    ]) {
      expect(isReservedRole(role)).toBe(false);
    }
  });

  // ---------------------------------------------------------------------------------
  // **【2026-08-13。`V8-M38`。台帳 `F-G9`。判定値 = 限定採用(門外 `Δ7`)】**
  // **テスト名と期待値を入れ替えた。** **検査は1本も消していない。**
  //
  // **旧テスト名の逐語**: 「ロール語彙は「予約3 + 既定の1本目」であり、それ以外を1つも含まない」。
  // **旧の本体(逐語。中のコメントブロックは下にそのまま残してある)**:
  //
  //     expect(baseRoleValues()).toEqual(["owner", "editor", "viewer", "customer"]);
  //     // **予約3ロールが先頭に、権限の広い順で並ぶ。**
  //     expect(baseRoleValues().slice(0, 3)).toEqual([...reservedRoleValues()]);
  //     // **4値目は既定の非運営の種類1本だけである。**
  //     expect(baseRoleValues()).toHaveLength(4);
  //
  // **`baseRoleValues()` が `DEFAULT_USER_KIND`(= `customer`)を無条件に足すのをやめた。**
  // **`customer` を1度も宣言していないアプリの「人に付けられる値」から `customer` が消えた。**
  // **宣言したアプリでは今日どおり入る**(出所は `assignableRoleValues(roleIds)` の
  // `customRoleIds` 側。`src/server/role-value-domain.test.ts` の (8-c) が測る)。
  // ---------------------------------------------------------------------------------
  test("ロール語彙は予約3ロールちょうどであり、それ以外を1つも含まない", () => {
    // ---------------------------------------------------------------------------------
    // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】**
    // **旧テスト名の逐語**: 「ロール語彙は「予約3 + 宣言」であり、それ以外を1つも含まない」。
    // **旧の本体(逐語)**:
    //
    //     expect(roleValuesForKinds(["member", "supplier"])).toEqual([
    //       "owner",
    //       "editor",
    //       "viewer",
    //       "member",
    //       "supplier",
    //     ]);
    //     // **宣言が無ければ着手前と1つも変わらない4値である。**
    //     expect(roleValuesForKinds([])).toEqual(["owner", "editor", "viewer", "customer"]);
    //
    // **「宣言」を渡す口(第1引数 = `app.user_kinds` の識別子)が廃止された。**
    // **宣言ぶんを足すのは今日 `assignableRoleValues(roleIds)` の役目であり、
    // その検査は `src/server/role-value-domain.test.ts` の (1-a) / (5-a) に在る。**
    // **ここでは土台の4値だけを測る** —— **検査は消していない。**
    // ---------------------------------------------------------------------------------
    expect(baseRoleValues()).toEqual(["owner", "editor", "viewer"]);
    // **予約3ロールが先頭に、権限の広い順で並ぶ。**
    expect(baseRoleValues().slice(0, 3)).toEqual([...reservedRoleValues()]);
    // **【`V8-M38` / `F-G9`】4値目は無い。** **`customer` は宣言したアプリにだけ入る。**
    expect(baseRoleValues()).toHaveLength(3);
    expect(baseRoleValues() as readonly string[]).not.toContain(DEFAULT_USER_KIND);
  });

  test("コンパイル時アサーションで置いた値が予約語彙の要素である(実行時の裏取り)", () => {
    expect((reservedRoleValues() as readonly string[]).includes(_reservedCovered)).toBe(true);
    expect((reservedRoleValues() as readonly string[]).includes(_valuesAreReserved)).toBe(true);
  });
});
