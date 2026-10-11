/**
 * **選んだ形の記録と型**(`V20-M15-T01A`。[`ADR-0479`](../../../../docs/adr/0479-design-memory-choices-patterns-and-compare-off-pattern.md)。
 * 門A = `ADR-0466`(`DS-S22` = 限定採用)。ユーザの決定 `D-V20-18` / `D-V20-56`〜`D-V20-64`)。
 *
 * ## この検査が測るもの / 測らないもの(**先に書く**)
 *
 * **測るもの**:
 * 1. **設計図の形** —— `$defs/app` の9本目 `design_memory` の中は `choices` / `patterns` の2キー
 *    (`ADR-0479` 限定1)、選んだ記録の要素は `name` / `tradeoff` / `reason` の3キー(限定2)、
 *    18種目 `remember_design` の値は `choice` / `patterns` の2キー(限定3)。
 * 2. **型の上限と重複不可が定義側と操作側で一致し、操作側だけ `minItems` を持たない**(限定5)。
 * 3. **`ADR-0013` §4c の3問の答えが設計図の `$comment` に在る**(限定9)。
 * 4. **受理**(`choice` だけ / `patterns` だけ / 両方 / `patterns` の空配列)と
 *    **拒否の7形**(`path` と文言まで。計画 §9-3-3)。
 * 5. **拒否の文言の分岐は `design_memory` の下でだけ効く** —— 既存の `maxItems` /
 *    `uniqueItems` の拒否の出力は着手前(`records/v20-m15-t00.md` §3-2)と1バイトも違わない(陰性対照)。
 * 6. **畳み込み** —— 末尾に足す / 上限+1件目で最古が落ちる(上限は設計図の `maxItems` から読む。
 *    カーネルの定数は読まない)/ `patterns` の丸ごとの置き換え / 空配列で外す / 空の器を残さない /
 *    `patterns` を省けば型に触らない / 同じ差分に2本なら先頭から順に畳む。
 * 7. **`design_memory` を書いていない定義は1バイトも変わらない。**
 * 8. **適用・移行・要件定義書の履歴節** —— 適用すると定義に入る / 移行の段を1つも生まない /
 *    選んだ記録の名前・トレードオフ・理由の文字列が要件定義書に1文字も出ない。
 *
 * **測らないもの(誇張しない)**:
 * 1. **見比べの画面・`dry_run_diff` の `compare`・下見の写し**(`T01B` / `T01C`)。
 * 2. **要件定義書が型の文を述べること**(`screens.design_pattern` は `T01D`)。
 * 3. **型が AI の案の既定として効くこと**(製品は機械で確かめられない。`H-V20-201` の候補)。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import diffSchema from "../../schemas/diff.schema.json" with { type: "json" };
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import { applyDiff, foldOperations } from "./apply-diff.ts";
import { applyManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { planMigration } from "./migrate.ts";
import { generateRequirementsDoc } from "./requirements-doc.ts";
import type { Manifest, Operation } from "./types.ts";
import { DIFF_OPS } from "./types.ts";
import { validateDiff, validateManifest, validateManifestFull } from "./validate.ts";

type Any = Record<string, unknown>;

const DEFS = "$defs";
const M = (manifestSchema as unknown as Any)[DEFS] as Any;
const D = (diffSchema as unknown as Any)[DEFS] as Any;

function appDesignMemory(): Any {
  return (((M.app as Any).properties as Any).design_memory ?? {}) as Any;
}

function operationDef(): Any {
  return D.operation as Any;
}

function branchOf(op: string): Any | undefined {
  const branches = (operationDef().allOf ?? []) as Any[];
  return branches.find((b) => ((((b.if as Any)?.properties ?? {}) as Any).op as Any)?.const === op);
}

function rememberDesignValue(): Any {
  const then = (branchOf("remember_design")?.then ?? {}) as Any;
  return (((then.properties ?? {}) as Any).design_memory ?? {}) as Any;
}

function baseManifest(): Manifest {
  return {
    app: {
      id: "shop",
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

function diffOf(operations: unknown[]): unknown {
  return { diff_id: "remember-1", intent: "選んだ形を記録する", operations };
}

function choice(n: number, reason?: string): Any {
  const c: Any = { name: `案${n}`, tradeoff: `トレードオフ${n}` };
  if (reason !== undefined) {
    c.reason = reason;
  }
  return c;
}

function fold(current: Manifest, operations: unknown[]): Manifest {
  const result = foldOperations(current, operations as Operation[]);
  if (!result.valid) {
    throw new Error(`畳み込みが失敗しました: ${JSON.stringify(result.errors)}`);
  }
  return result.manifest;
}

function designMemoryOf(manifest: Manifest): Any | undefined {
  return (manifest.app as unknown as Any).design_memory as Any | undefined;
}

// =====================================================================================
// 1. 設計図の形(ADR-0479 限定1・2・3・5・9)
// =====================================================================================

describe("(1) 設計図の形 —— `design_memory` / `remember_design` / 10キー目", () => {
  // **【`V22-M2-T02` / `ADR-0486`(門A = `MN-G1` / `MN-G2`。授権 `ADR-0487` 行4)】10本目 `workspace` が末尾に入ったので、`design_memory` は末尾ではなくなった。**
  // **「末尾」の固定を「最初の9が着手前のまま」へ直した(テスト名は当時の逐語のまま)。**
  // **旧(逐語)**: `expect(Object.keys((M.app as Any).properties as Any)).toEqual([ ...9キー... ]);`
  test("`$defs/app` の9本目(末尾)が `design_memory` で、既存8キーの並びは動かない", () => {
    expect(Object.keys((M.app as Any).properties as Any).slice(0, 9)).toEqual([
      "id",
      "name",
      "tables",
      "views",
      "workflows",
      "functions",
      "theme",
      "roles",
      "design_memory",
    ]);
    expect((M.app as Any).additionalProperties).toBe(false);
    expect((M.app as Any).required).toEqual(["id", "name", "tables", "views"]);
  });

  test("限定1: `design_memory` の中は `choices` / `patterns` の2キーで閉じ、空の器を許さない", () => {
    const dm = appDesignMemory();
    expect(dm.type).toBe("object");
    expect(dm.additionalProperties).toBe(false);
    expect(dm.minProperties).toBe(1);
    expect(Object.keys(dm.properties as Any)).toEqual(["choices", "patterns"]);
  });

  test("限定2: 選んだ記録の要素は `name` / `tradeoff` / `reason` の3キー(必須2)で、字数は 40 / 80 / 200", () => {
    const choices = ((appDesignMemory().properties as Any).choices ?? {}) as Any;
    expect(choices.type).toBe("array");
    expect(choices.minItems).toBe(1);
    const items = choices.items as Any;
    expect(items.additionalProperties).toBe(false);
    expect(Object.keys(items.properties as Any)).toEqual(["name", "tradeoff", "reason"]);
    expect(items.required).toEqual(["name", "tradeoff"]);
    const props = items.properties as Record<string, Any>;
    expect([props.name?.maxLength, props.tradeoff?.maxLength, props.reason?.maxLength]).toEqual([
      40, 80, 200,
    ]);
    for (const key of ["name", "tradeoff", "reason"]) {
      expect(props[key]?.minLength).toBe(1);
      expect(props[key]?.pattern).toBe("^[^\\r\\n\\u2028\\u2029]+$");
    }
  });

  test("`op_name` と `DIFF_OPS` の末尾(18種目)が `remember_design` で、最初の17は着手前のまま", () => {
    const before = [
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
      "set_roles",
    ];
    const enumValues = (D.op_name as Any).enum as string[];
    // **【`V22-M2-T02` / `ADR-0486`(門A = `MN-G1` / `MN-G2`。授権 `ADR-0487` 行4)】19種目 `set_workspace` が末尾に入ったので、「末尾」の固定を「最初の18が着手前のまま」へ直した。**
    // **旧(逐語)**: `expect(enumValues).toEqual([...before, "remember_design"]);`
    expect(enumValues.slice(0, 18)).toEqual([...before, "remember_design"]);
    expect([...DIFF_OPS] as string[]).toEqual(enumValues);
  });

  // **【`V22-M2-T02` / `ADR-0486`(門A = `MN-G1` / `MN-G2`。授権 `ADR-0487` 行4)】11キー目 `workspace` が末尾に入ったので、「末尾」の固定を「最初の10が着手前のまま」へ直した。**
  // **旧(逐語)**: `expect(Object.keys(operationDef().properties as Any)).toEqual([ ...10キー... ]);`
  test("操作の器の10キー目(末尾)が `design_memory` で、既存9キーの並びは動かない", () => {
    expect(Object.keys(operationDef().properties as Any).slice(0, 10)).toEqual([
      "op",
      "table",
      "field",
      "view",
      "changes",
      "workflow",
      "function",
      "theme",
      "roles",
      "design_memory",
    ]);
  });

  test("限定3: `remember_design` の値は `choice` / `patterns` の2キーで閉じ、残る8キーを `false` で禁じる", () => {
    const branch = branchOf("remember_design");
    expect(branch).toBeDefined();
    const then = branch?.then as Any;
    expect(then.required).toEqual(["design_memory"]);
    const value = rememberDesignValue();
    expect(value.type).toBe("object");
    expect(value.additionalProperties).toBe(false);
    expect(value.minProperties).toBe(1);
    expect(Object.keys(value.properties as Any)).toEqual(["choice", "patterns"]);
    expect(((value.properties as Any).choice as Any).$ref).toBe(
      "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/app/properties/design_memory/properties/choices/items",
    );
    const others = Object.entries(then.properties as Any).filter(([k]) => k !== "design_memory");
    expect(others).toEqual([
      ["table", false],
      ["field", false],
      ["view", false],
      ["changes", false],
      ["workflow", false],
      ["function", false],
      ["theme", false],
      ["roles", false],
      // **【`V22-M2-T02` / `ADR-0486`(門A = `MN-G1` / `MN-G2`。授権 `ADR-0487` 行4)】11キー目 `workspace` を `false` で禁じる1件が末尾に加わった(残る8キー → 9キー)。**
      // **旧の期待値は直上の `["roles", false]` で終わる8件である(逐語)。**
      ["workspace", false],
    ]);
  });

  test("既存17分岐はすべて `design_memory` を末尾で `false` にする(ADR-0013 §4c 問2)", () => {
    const branches = (operationDef().allOf ?? []) as Any[];
    // **【`V22-M2-T02` / `ADR-0486`(門A = `MN-G1` / `MN-G2`。授権 `ADR-0487` 行4)】19本目 `set_workspace` の分岐が入り、既存分岐の末尾に `"workspace": false` が加わった。**
    // **旧(逐語)**: `expect(branches).toHaveLength(18);` / `if (op === "remember_design") {` /
    // `expect(keys[keys.length - 1]).toBe("design_memory");` —— `design_memory` は末尾から2番目になった
    // (17分岐の名指しと `false` であることは1バイトも緩めていない)。
    expect(branches).toHaveLength(19);
    const named: string[] = [];
    for (const b of branches) {
      const op = ((((b.if as Any)?.properties ?? {}) as Any).op as Any)?.const as string;
      if (op === "remember_design" || op === "set_workspace") {
        continue;
      }
      const keys = Object.keys((b.then as Any).properties as Any);
      expect(keys[keys.length - 2]).toBe("design_memory");
      expect(keys[keys.length - 1]).toBe("workspace");
      expect(((b.then as Any).properties as Any).design_memory).toBe(false);
      named.push(op);
    }
    expect(named).toEqual([...DIFF_OPS].slice(0, 17));
  });

  test("限定5: 型の上限10と重複不可は定義側と操作側で一致し、操作側だけ `minItems` を持たない", () => {
    const defSide = ((appDesignMemory().properties as Any).patterns ?? {}) as Any;
    const opSide = ((rememberDesignValue().properties as Any).patterns ?? {}) as Any;
    expect(defSide.maxItems).toBe(10);
    expect(opSide.maxItems).toBe(defSide.maxItems);
    expect(defSide.uniqueItems).toBe(true);
    expect(opSide.uniqueItems).toBe(defSide.uniqueItems);
    expect(defSide.minItems).toBe(1);
    expect("minItems" in opSide).toBe(false);
    expect((opSide.items as Any).$ref).toBe(
      "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/app/properties/design_memory/properties/patterns/items",
    );
    const item = defSide.items as Any;
    expect([item.type, item.minLength, item.maxLength, item.pattern]).toEqual([
      "string",
      1,
      80,
      "^[^\\r\\n\\u2028\\u2029]+$",
    ]);
  });

  test("限定9: `ADR-0013` §4c の3問の答えが `$comment` に在る(10キーで閉じる / 17分岐の名指し / 2面)", () => {
    const keyComment = String(
      (((operationDef().properties as Any).design_memory ?? {}) as Any).$comment ?? "",
    );
    const opComment = String(operationDef().$comment ?? "");
    for (const comment of [keyComment, opComment]) {
      expect(comment).toContain("問1");
      expect(comment).toContain("問2");
      expect(comment).toContain("問3");
      expect(comment).toContain(
        "op / table / field / view / changes / workflow / function / theme / roles / design_memory の10キーで閉じる。11キー目を足してはならない。",
      );
      expect(comment).toContain([...DIFF_OPS].slice(0, 17).join(" / "));
      expect(comment).toContain("ADR-0479");
    }
    expect(keyComment).toContain("2面");
    // **【`V22-M2-T02` / `ADR-0486`(門A = `MN-G1` / `MN-G2`。授権 `ADR-0487` 行4)】`op_name` の description は「計19種」になった。 旧の description は `$comment` の末尾に逐語で残した
    // (「description の旧文 (逐語)」)。 **旧(逐語)**: `expect(String((D.op_name as Any).description)).toContain("計18種");`
    expect(String((D.op_name as Any).description)).toContain("計19種");
    expect(String((D.op_name as Any).$comment)).toContain(
      "set_theme・set_roles・remember_design の計18種。",
    );
  });

  test("新しい `$defs` を1本も作らない(manifest 31 / diff 5)", () => {
    expect(Object.keys(M)).toHaveLength(31);
    expect(Object.keys(D)).toHaveLength(5);
  });
});

// =====================================================================================
// 2. 受理と拒否の形(計画 §9-3-3。ADR-0003 の { path, message, hint? })
// =====================================================================================

describe("(2) `remember_design` の受理", () => {
  test.each([
    ["choice だけ", { choice: choice(1) }],
    ["choice(理由つき)だけ", { choice: choice(1, "一覧が見やすいから") }],
    ["patterns だけ", { patterns: ["フォームは区切りのある1カラム"] }],
    ["両方", { choice: choice(1), patterns: ["一覧は詰めて表示"] }],
    ["patterns の空配列(型を全部外す)", { patterns: [] }],
  ])("%s は通る", (_label, designMemory) => {
    const result = validateDiff(diffOf([{ op: "remember_design", design_memory: designMemory }]));
    expect(result).toEqual({ valid: true });
  });

  test("40字 / 80字 / 200字ちょうどは通る(コードポイントで数える)", () => {
    const result = validateDiff(
      diffOf([
        {
          op: "remember_design",
          design_memory: {
            choice: { name: "名".repeat(40), tradeoff: "🙂".repeat(80), reason: "理".repeat(200) },
            patterns: ["型".repeat(80)],
          },
        },
      ]),
    );
    expect(result).toEqual({ valid: true });
  });
});

describe("(2) `remember_design` の拒否の7形(`path` と文言まで)", () => {
  function errorsOf(designMemory: unknown, op = "remember_design"): unknown {
    const result = validateDiff(diffOf([{ op, design_memory: designMemory }]));
    expect(result.valid).toBe(false);
    return result.valid ? [] : result.errors;
  }

  test("空の器 `{}`", () => {
    expect(errorsOf({})).toEqual([
      {
        path: "/operations/0/design_memory",
        message: "design_memory に指定すべき項目がありません。1件以上指定してください。",
      },
    ]);
  });

  test("名前41字", () => {
    expect(errorsOf({ choice: { name: "名".repeat(41), tradeoff: "t" } })).toEqual([
      {
        path: "/operations/0/design_memory/choice/name",
        message: "name が長すぎます。40文字以内にしてください。",
      },
    ]);
  });

  test("トレードオフに改行(識別子の規約とは言わない)", () => {
    expect(errorsOf({ choice: { name: "n", tradeoff: "x\ny" } })).toEqual([
      {
        path: "/operations/0/design_memory/choice/tradeoff",
        message: "tradeoff に改行は書けません。1行で書いてください。",
      },
    ]);
  });

  test("型の文に U+2028(改行の4文字のうちの1つ)", () => {
    expect(errorsOf({ patterns: ["a b"] })).toEqual([
      {
        path: "/operations/0/design_memory/patterns/0",
        message: "patterns の1番目に改行は書けません。1行で書いてください。",
      },
    ]);
  });

  test("空の理由は1件だけ(`minLength`。改行の文言を重ねない)", () => {
    expect(errorsOf({ choice: { name: "n", tradeoff: "t", reason: "" } })).toEqual([
      {
        path: "/operations/0/design_memory/choice/reason",
        message: "reason が空です。1文字以上の値を指定してください。",
      },
    ]);
  });

  test("型の重複(日本語で、何番目と何番目か)", () => {
    expect(errorsOf({ patterns: ["a", "b", "a"] })).toEqual([
      {
        path: "/operations/0/design_memory/patterns",
        message: "patterns に同じ型が2つあります(1番目と3番目)。",
      },
    ]);
  });

  test("型11件(操作の側)", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `型${i}`);
    expect(errorsOf({ patterns: eleven })).toEqual([
      { path: "/operations/0/design_memory/patterns", message: "patterns は10件までです。" },
    ]);
  });

  test("選んだ記録21件・型11件を直接書いた定義(定義の側)", () => {
    const manifest = baseManifest() as unknown as { app: Any };
    manifest.app.design_memory = {
      choices: Array.from({ length: 21 }, (_, i) => choice(i)),
      patterns: Array.from({ length: 11 }, (_, i) => `型${i}`),
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.valid ? [] : result.errors).toEqual([
      { path: "/app/design_memory/choices", message: "choices は20件までです。" },
      { path: "/app/design_memory/patterns", message: "patterns は10件までです。" },
    ]);
  });

  test("`set_theme` に `design_memory` は書けない(既存の文言のまま)", () => {
    const errors = errorsOf({ patterns: ["a"] }, "set_theme") as Any[];
    expect(errors).toContainEqual(
      expect.objectContaining({
        path: "/operations/0/design_memory",
        message: 'プロパティ "design_memory" は、この種別では指定できません。',
      }),
    );
  });

  test("選んだ記録に4つ目のキー(頼んだ人・日時など)は書けない", () => {
    const errors = errorsOf({ choice: { name: "n", tradeoff: "t", by: "alice" } }) as Any[];
    expect(errors.map((e) => e.path)).toEqual(["/operations/0/design_memory/choice"]);
  });

  test("`choice` を配列にはできない(1件ずつ)", () => {
    const errors = errorsOf({ choice: [choice(1)] }) as Any[];
    expect(errors.length).toBeGreaterThan(0);
  });

  test("`design_memory` を欠いた `remember_design` は必須の誤り", () => {
    const result = validateDiff(diffOf([{ op: "remember_design" }]));
    expect(result.valid).toBe(false);
    expect(result.valid ? [] : result.errors).toContainEqual(
      expect.objectContaining({ path: "/operations/0" }),
    );
  });
});

describe("(2) 陰性対照 —— 既存の `maxItems` / `uniqueItems` の拒否の出力は着手前と1バイトも違わない", () => {
  // 着手前の出力は `docs/plan/v20/records/v20-m15-t00.md` §3-2 の逐語。
  function bookTracker(): Any {
    const path = join(import.meta.dir, "..", "..", "fixtures", "valid", "book-tracker.json");
    return JSON.parse(readFileSync(path, "utf8")) as Any;
  }

  test("`maxItems`(`/app/roles` 13件)", () => {
    const manifest = bookTracker();
    (manifest.app as Any).roles = Array.from({ length: 13 }, (_, i) => ({ id: `r${i}` }));
    const result = validateManifest(manifest);
    expect(JSON.stringify(result.valid ? [] : result.errors)).toBe(
      '[{"path":"/app/roles","message":"roles が不正です(maxItems: must NOT have more than 12 items)。"}]',
    );
  });

  test("`uniqueItems`(`can` に read を2度)", () => {
    const manifest = bookTracker();
    (manifest.app as Any).roles = [
      { id: "member", rules: [{ target: "table", table: "books", can: ["read", "read"] }] },
    ];
    const result = validateManifest(manifest);
    expect(JSON.stringify(result.valid ? [] : result.errors)).toBe(
      '[{"path":"/app/roles/0/rules/0/can","message":"can が不正です(uniqueItems: must NOT have duplicate items (items ## 0 and 1 are identical))。"}]',
    );
  });
});

// =====================================================================================
// 3. 畳み込み(ADR-0479 §Decision 2 の 4)
// =====================================================================================

describe("(3) 畳み込み", () => {
  test("`choice` は `choices` の末尾に足す(古い順・末尾が最新)", () => {
    const once = fold(baseManifest(), [
      { op: "remember_design", design_memory: { choice: choice(1) } },
    ]);
    expect(designMemoryOf(once)).toEqual({ choices: [choice(1)] });
    const twice = fold(once, [
      { op: "remember_design", design_memory: { choice: choice(2, "理由") } },
    ]);
    expect(designMemoryOf(twice)).toEqual({ choices: [choice(1), choice(2, "理由")] });
  });

  test("限定4: 上限(設計図の `maxItems`)+1件目で最古の1件だけが落ち、上限件ちょうどになる", () => {
    const limit = Number(
      (((appDesignMemory().properties as Any).choices ?? {}) as Any).maxItems ?? Number.NaN,
    );
    expect(Number.isInteger(limit)).toBe(true);
    let manifest = baseManifest();
    for (let i = 0; i < limit; i++) {
      manifest = fold(manifest, [{ op: "remember_design", design_memory: { choice: choice(i) } }]);
    }
    const atLimit = designMemoryOf(manifest)?.choices as Any[];
    expect(atLimit).toHaveLength(limit);
    expect(atLimit[0]).toEqual(choice(0));
    const over = fold(manifest, [
      { op: "remember_design", design_memory: { choice: choice(limit) } },
    ]);
    const after = designMemoryOf(over)?.choices as Any[];
    expect(after).toHaveLength(limit);
    expect(after[0]).toEqual(choice(1));
    expect(after[after.length - 1]).toEqual(choice(limit));
    expect(validateManifestFull(over)).toEqual({ valid: true });
  });

  test("型は選んだ記録の上限で消えない", () => {
    let manifest = fold(baseManifest(), [
      { op: "remember_design", design_memory: { patterns: ["型A"] } },
    ]);
    for (let i = 0; i < 25; i++) {
      manifest = fold(manifest, [{ op: "remember_design", design_memory: { choice: choice(i) } }]);
    }
    expect(designMemoryOf(manifest)?.patterns).toEqual(["型A"]);
  });

  test("`patterns` は丸ごと置き換える", () => {
    const first = fold(baseManifest(), [
      { op: "remember_design", design_memory: { patterns: ["型A", "型B"] } },
    ]);
    const second = fold(first, [{ op: "remember_design", design_memory: { patterns: ["型C"] } }]);
    expect(designMemoryOf(second)).toEqual({ patterns: ["型C"] });
  });

  test("`patterns` の空配列で型を外す。選んだ記録は残る", () => {
    const first = fold(baseManifest(), [
      { op: "remember_design", design_memory: { choice: choice(1), patterns: ["型A"] } },
    ]);
    const second = fold(first, [{ op: "remember_design", design_memory: { patterns: [] } }]);
    expect(designMemoryOf(second)).toEqual({ choices: [choice(1)] });
    expect(validateManifestFull(second)).toEqual({ valid: true });
  });

  test("空の器を残さない —— 型しか無いアプリで型を外すと `design_memory` のキーが消える", () => {
    const first = fold(baseManifest(), [
      { op: "remember_design", design_memory: { patterns: ["型A"] } },
    ]);
    const second = fold(first, [{ op: "remember_design", design_memory: { patterns: [] } }]);
    expect("design_memory" in (second.app as unknown as Any)).toBe(false);
    expect(JSON.stringify(second)).toBe(JSON.stringify(baseManifest()));
  });

  test("型の無いアプリに空配列を送っても器は生まれない", () => {
    const result = fold(baseManifest(), [
      { op: "remember_design", design_memory: { patterns: [] } },
    ]);
    expect(JSON.stringify(result)).toBe(JSON.stringify(baseManifest()));
  });

  test("`patterns` を省いた操作は型に1バイトも触らない", () => {
    const first = fold(baseManifest(), [
      { op: "remember_design", design_memory: { patterns: ["型A", "型B"] } },
    ]);
    const second = fold(first, [{ op: "remember_design", design_memory: { choice: choice(1) } }]);
    expect(JSON.stringify(designMemoryOf(second)?.patterns)).toBe(
      JSON.stringify(designMemoryOf(first)?.patterns),
    );
  });

  test("同じ差分に2本あれば先頭から順に畳む", () => {
    const result = fold(baseManifest(), [
      { op: "remember_design", design_memory: { choice: choice(1), patterns: ["型A"] } },
      { op: "remember_design", design_memory: { choice: choice(2), patterns: ["型B"] } },
    ]);
    expect(designMemoryOf(result)).toEqual({
      choices: [choice(1), choice(2)],
      patterns: ["型B"],
    });
  });

  test("元の定義を書き換えない(純粋関数)", () => {
    const current = baseManifest();
    const before = JSON.stringify(current);
    fold(current, [{ op: "remember_design", design_memory: { choice: choice(1) } }]);
    expect(JSON.stringify(current)).toBe(before);
  });

  test("`design_memory` を書いていない定義は、他の op を畳んでも1バイトも `design_memory` を持たない", () => {
    const result = fold(baseManifest(), [
      {
        op: "add_field",
        table: "orders",
        field: { id: "memo", name: "メモ", type: "long_text" },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("design_memory");
  });
});

// =====================================================================================
// 4. 適用・移行・要件定義書の履歴節
// =====================================================================================

describe("(4) 適用・移行・要件定義書", () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "gp-design-memory-"));
    const store = KernelMetaStore.open(dataRoot);
    createApp(store, "店", { app_id: "shop" });
    const applied = applyManifest(dataRoot, "shop", baseManifest());
    if (!applied.valid) {
      throw new Error("テスト前提の初期マニフェスト投入に失敗しました。");
    }
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  test("適用すると定義に入り、移行の段を1つも生まない", () => {
    const result = applyDiff(
      dataRoot,
      "shop",
      diffOf([
        {
          op: "remember_design",
          design_memory: {
            choice: {
              name: "詰めた一覧",
              tradeoff: "情報量は多いが目が疲れる",
              reason: "毎日使うから",
            },
            patterns: ["一覧は詰めて表示する"],
          },
        },
      ]),
    );
    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    expect(designMemoryOf(result.manifest)).toEqual({
      choices: [
        { name: "詰めた一覧", tradeoff: "情報量は多いが目が疲れる", reason: "毎日使うから" },
      ],
      patterns: ["一覧は詰めて表示する"],
    });
    expect(result.plan.add_tables).toEqual([]);
    expect(result.plan.add_fields).toEqual([]);
    expect(result.plan.steps ?? []).toEqual([]);
  });

  test("移行の計画は `remember_design` に段を1つも生まない(直接)", () => {
    const operations = [
      { op: "remember_design", design_memory: { choice: choice(1) } },
    ] as unknown as Operation[];
    const planned = planMigration(baseManifest(), fold(baseManifest(), operations), operations);
    expect(planned.valid).toBe(true);
    if (planned.valid) {
      expect(planned.plan.add_tables).toEqual([]);
      expect(planned.plan.add_fields).toEqual([]);
      expect(planned.plan.steps ?? []).toEqual([]);
    }
  });

  test("選んだ記録の名前・トレードオフ・理由の文字列は要件定義書に1文字も出ない(履歴節を含む)", () => {
    const result = applyDiff(
      dataRoot,
      "shop",
      diffOf([
        {
          op: "remember_design",
          design_memory: {
            choice: { name: "ZQXNAME", tradeoff: "ZQXTRADEOFF", reason: "ZQXREASON" },
          },
        },
      ]),
    );
    expect(result.valid).toBe(true);
    const doc = generateRequirementsDoc(dataRoot, "shop");
    expect(doc.markdown).toContain("remember_design");
    for (const secret of ["ZQXNAME", "ZQXTRADEOFF", "ZQXREASON"]) {
      expect(doc.markdown).not.toContain(secret);
    }
  });
});
