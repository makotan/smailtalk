/**
 * `src/kernel/types.ts` の権限の型に6キー目 `restrictive?: boolean` が在ることを固定する
 * (`V17-M10B-T06b`。授権は `ADR-0430` 単位 (β) / 同 `:213` の許す範囲の表の1行目)。
 *
 * ## 授権の逐語(`docs/adr/0430-upper-bound-through-group-and-inheritance.md:21`)
 *
 * > **(β)** **`apps/smailtalk/src/kernel/types.ts` の権限の型に6キー目 `restrictive?: boolean` を
 * > **1行ちょうど**足す**(ユーザ決定 `D-V17-K`)。
 *
 * ## 授権の逐語(同 `:213`)
 *
 * > **`access_control.permissions[]` の要素の型に `restrictive?: boolean` を**1行ちょうど**足すことだけ。**
 * > **`?` を外して必須にしない**(定義の形の `required` が5キーのままだからである)。
 * > **同じファイルの他の型を1バイトも動かさない。** **新しい `export` を1本も足さない**
 *
 * ## なぜ検出器を2種立てるのか
 *
 * このリポジトリでは「**型だけの行は走査では捕まらない**」「**走査だけでは緑のまま嘘になる**」が
 * 繰り返し起きている(`docs/plan` の記録に「型だけの行は tsc でしか捕まらない」「逐語の残置が
 * 検査を騙す」として残っている型)。**片方だけでは足りない**ので、次の2種を立てる。
 *
 * - **(a) 逐語走査** —— `src/kernel/types.ts` を読み、`access_control.permissions[]` の要素の型の
 *   中に `restrictive?: boolean;` の行が在ることを撃つ。**キーが6つちょうどであること**、
 *   **`?` が付いていること**(必須化していないこと)も同時に撃つ。
 *   走査だけだと、たとえば行がコメントの中にあっても緑になりうる。だから (b) が要る。
 *
 * - **(b) 型として実際に効いていること** —— `restrictive: true` を持つ要素を**型注釈つきで**書き、
 *   **`restrictive` 以外の未知キーは通らない**ことを `@ts-expect-error` で撃つ。
 *   **これを赤くするのは `bun test` ではなく `tsc --noEmit`(= `bun run typecheck`)である。**
 *   本ファイルは `tsconfig.json` の `include` が持つ `"scripts"` の下にあるので、typecheck の
 *   対象に入る。**したがって (b) の担保は `bun run typecheck` の exit=0 が運ぶ。**
 *   `bun test` 側では、下の値を実行時にも読んで「宣言だけ書いて使っていない」状態を作らない。
 *
 * ## 置き場所について
 *
 * `src/kernel/` の中には置けない。`ADR-0430:213` の表が
 * 「**`apps/smailtalk/src/kernel/` の他のファイル | 0バイト**」と書いており、
 * 検査ファイルであってもそこに1本足せば `CP-V17` 条件7 に反する。
 * `scripts/` に置いたのは `scripts/kernel-types-no-import.test.ts` の先例に倣ったもので、
 * 同ファイルが挙げる理由(`tsconfig.json` の `include` が `["src", "web", "scripts"]` である)が
 * ここでは (b) の成立条件そのものになっている。
 *
 * ## この検査が担保しないもの(先に書く)
 *
 * 1. **判定の実装は本葉では1バイトも無い。** **この1行を足しても、行の読取・書込・削除の
 *    ふるまいは今日どおりである。** 和集合の2段化と関門は `V17-M10B-T06` の担当である。
 * 2. **`restrictive` を書いた権限名が実在するか・矛盾する組み合わせかは、ここでは1つも見ない。**
 * 3. **`export` が増えていないことは本ファイルでは撃たない** —— それは
 *    `scripts/kernel-export-drift.test.ts`(Δ8 の機械検査)の担当であり、
 *    同検査が緑であることで示す。
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Table } from "../src/kernel/types.ts";

/** このファイルは <apps/smailtalk>/scripts にあるので、単位のルートはひとつ上。cwd に依存させない。 */
const unitRoot = join(import.meta.dir, "..");
const typesPath = join(unitRoot, "src", "kernel", "types.ts");
const source = readFileSync(typesPath, "utf8");

/**
 * `access_control?: {` の内側の `permissions: {` ... `}[];` の本体だけを切り出す。
 *
 * ファイル全体を撃つと、doc コメントの中の `restrictive` や、別の型の同名キーで
 * 偽の緑になる。**要素の型の中に在ること**を主張したいので、範囲を絞ってから撃つ。
 */
function permissionElementBody(text: string): string {
  const acIndex = text.indexOf("access_control?: {");
  if (acIndex === -1) throw new Error("src/kernel/types.ts に `access_control?: {` が無い");
  const permIndex = text.indexOf("permissions: {", acIndex);
  if (permIndex === -1) throw new Error("`access_control?: {` の後に `permissions: {` が無い");
  const bodyStart = permIndex + "permissions: {".length;
  const bodyEnd = text.indexOf("}[];", bodyStart);
  if (bodyEnd === -1) throw new Error("`permissions: {` を閉じる `}[];` が無い");
  return text.slice(bodyStart, bodyEnd);
}

describe("(a) 逐語走査: ADR-0430 (β) —— 権限の型の6キー目", () => {
  const body = permissionElementBody(source);
  /** 要素の型の中の `キー名(?): 型;` の行だけを拾う。空行は落とす。 */
  const keyLines = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  test("検査対象のファイルを実際に読めている(空文字列に対して緑にならない)", () => {
    // 下の主張は「在る/ちょうど」なので空を読めば全部落ちるが、
    // 切り出しの側が壊れて空になったのか本文が壊れたのかを区別できるようにしておく。
    expect(source).toContain("FIELD_TYPES");
    expect(keyLines.length).toBeGreaterThan(0);
  });

  test("`restrictive?: boolean;` の行が1行ちょうど在る", () => {
    const hits = keyLines.filter((line) => /^restrictive\?: boolean;$/.test(line));
    expect(
      hits.length,
      "ADR-0430 単位 (β) / 同 :213 は `access_control.permissions[]` の要素の型に " +
        "`restrictive?: boolean` を1行ちょうど足すことを授権している。" +
        `いま拾えた行は ${JSON.stringify(keyLines)} である。`,
    ).toBe(1);
  });

  test("`?` を外して必須にしていない", () => {
    // ADR-0430:213 の逐語:「**`?` を外して必須にしない**(定義の形の `required` が
    // 5キーのままだからである)」。必須化は schemas 側の required と食い違う。
    expect(
      keyLines.some((line) => /^restrictive: boolean;$/.test(line)),
      "`restrictive` が必須(`?` 無し)で書かれている。ADR-0430:213 が名指しで禁じている。",
    ).toBe(false);
  });

  test("要素の型のキーは6つちょうど(7つ目を足していない)", () => {
    const keys = keyLines.map((line) => line.replace(/\?/, "").split(":")[0]?.trim());
    expect(keys).toEqual(["id", "name", "read", "write", "delete", "restrictive"]);
  });
});

/**
 * (b) 型として実際に効いていること。
 *
 * **赤くするのは `tsc --noEmit`(= `bun run typecheck`)であって `bun test` ではない。**
 * `restrictive` が型に無ければ、下の `withRestrictive` が TS2353(既知でないプロパティ)で落ちる。
 */
type PermissionElement = NonNullable<Table["access_control"]>["permissions"][number];

const withRestrictive: PermissionElement = {
  id: "viewer-cap",
  name: "閲覧までに絞る",
  read: true,
  write: false,
  delete: false,
  restrictive: true,
};

/** `?` が付いているので、5キーのままの要素も通り続ける(既存の宣言を偽にしない)。 */
const withoutRestrictive: PermissionElement = {
  id: "viewer",
  name: "閲覧",
  read: true,
  write: false,
  delete: false,
};

const withUnknownKey: PermissionElement = {
  id: "typo",
  name: "綴り違い",
  read: true,
  write: false,
  delete: false,
  // @ts-expect-error `restrictive` 以外の未知キーは通らない(6キー目だけが増えたことの裏取り)。
  restrictiv: true,
};

describe("(b) 型として効いている(担保は bun run typecheck 側)", () => {
  test("上の3つの値を実行時にも読む(宣言だけ書いて使っていない状態を作らない)", () => {
    expect(withRestrictive.restrictive).toBe(true);
    expect(withoutRestrictive.restrictive).toBeUndefined();
    expect(Object.keys(withUnknownKey)).toContain("restrictiv");
  });
});
