import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff } from "./apply-diff.ts";
import { applyManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import type { ValidationError, ValidationResult } from "./errors.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { validateReferentialIntegrity } from "./referential-integrity.ts";
import type { Diff, FunctionDef, Manifest } from "./types.ts";

/**
 * 関数の参照整合性(ADR-0024 §8 / V1-M6-T05 第1段)の検査。
 *
 * `workflow-referential-integrity.test.ts` と同型で、**存在しない table / view を指す
 * 関数は `apply_diff` の時点で拒否される**ことを固定する。最後の describe(実経路)は
 * `validateReferentialIntegrity` を直接呼ぶのではなく `applyDiff` を通す —— 間に
 * 畳み込みと永続化がいるので、直接呼びでは apply_diff の拒否の証明にならない。
 *
 * **capabilities は検査しない**(ADR-0024 §8。マニフェスト外の人間ストアを指すので、
 * 実行時にブリッジが fail-closed で照合する。第2段 T04)。それも本ファイルで固定する。
 */

/** 失敗であることを確認しつつ errors を取り出す。 */
function expectInvalid(result: ValidationResult): ValidationError[] {
  expect(result.valid).toBe(false);
  if (result.valid) {
    throw new Error("expected invalid");
  }
  return result.errors;
}

/** 指定パスのエラーを1件だけ取り出す。 */
function errorAt(errors: ValidationError[], path: string): ValidationError {
  const matched = errors.filter((error) => error.path === path);
  expect(matched).toHaveLength(1);
  const error = matched[0];
  if (error === undefined) {
    throw new Error(`no error at ${path}`);
  }
  return error;
}

/** 深いコピー。 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 貸出管理アプリ(list_view と form の両方を持つ)。 */
function baseManifest(): Manifest {
  return {
    app: {
      id: "loan-tracker",
      name: "貸出管理",
      tables: [
        {
          id: "loans",
          name: "貸出",
          fields: [{ id: "borrower", name: "借り手", type: "text", required: true }],
        },
        {
          id: "monthly-counts",
          name: "月次集計",
          fields: [{ id: "month", name: "月", type: "text" }],
        },
      ],
      views: [
        { id: "loan-list", type: "list_view", table: "loans", columns: ["borrower"] },
        { id: "loan-form", type: "form", table: "loans", fields: ["borrower"] },
      ],
    },
  };
}

/** table 入力のサンプル関数。 */
function tableFunction(): FunctionDef {
  return {
    id: "count-by-month",
    name: "月ごとに数える",
    code: "export default (rows) => rows;",
    input: { source: "table", table: "loans" },
    output: { fields: [{ id: "month", type: "text" }] },
    capabilities: [],
  };
}

/** 関数を持つマニフェストを組み立てる。 */
function manifestWith(...functions: FunctionDef[]): Manifest {
  const manifest = baseManifest();
  manifest.app.functions = functions;
  return manifest;
}

// ============================================================================
// input.table / input.view の実在検査
// ============================================================================

describe("関数の入力が指す table / view の実在検査", () => {
  test("input.table が存在しないテーブルを指すと拒否される", () => {
    const fn = tableFunction();
    fn.input = { source: "table", table: "loanz" };

    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(fn)));
    const error = errorAt(errors, "/app/functions/0/input/table");
    expect(error.message).toContain("loanz");
    expect(error.message).toContain("存在しません");
    expect(error.hint).toBeDefined();
  });

  test("input.view が存在しない一覧を指すと拒否される", () => {
    const fn = tableFunction();
    fn.input = { source: "view", view: "no-such-view" };

    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(fn)));
    const error = errorAt(errors, "/app/functions/0/input/view");
    expect(error.message).toContain("no-such-view");
    expect(error.message).toContain("存在しません");
  });

  test("input.view が form ビューを指すと拒否される(list_view だけが候補)", () => {
    const fn = tableFunction();
    fn.input = { source: "view", view: "loan-form" };

    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(fn)));
    const error = errorAt(errors, "/app/functions/0/input/view");
    // 候補には list_view だけが並び、form(loan-form)は入らない。
    expect(error.allowed_values).toEqual(["loan-list"]);
    expect(error.allowed_values).not.toContain("loan-form");
  });

  test("source=record は table / view を参照しないので、存在検査に掛からない", () => {
    const fn = tableFunction();
    fn.input = { source: "record" };
    expect(validateReferentialIntegrity(manifestWith(fn))).toEqual({ valid: true });
  });

  test("実在する table / view を指す関数は通る", () => {
    const tableFn = tableFunction();
    const viewFn = {
      ...tableFunction(),
      id: "from-view",
      input: { source: "view" as const, view: "loan-list" },
    };
    expect(validateReferentialIntegrity(manifestWith(tableFn, viewFn))).toEqual({ valid: true });
  });
});

// ============================================================================
// システムテーブル(限定7: $defs/resource_id で弾く)/ 候補一覧
// ============================================================================

describe("システムテーブルは入力にできない(ADR-0024 限定7)", () => {
  test("input.table のエラーは宣言テーブルのみを候補に出す(_apps / _changelog は漏れない)", () => {
    const fn = tableFunction();
    fn.input = { source: "table", table: "missing" };

    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(fn)));
    const error = errorAt(errors, "/app/functions/0/input/table");
    // ビュー(viewTargetIds)と違い、関数はシステムテーブルを対象にできない。
    expect(error.allowed_values).toEqual(["loans", "monthly-counts"]);
    expect(error.allowed_values).not.toContain("_apps");
    expect(error.allowed_values).not.toContain("_changelog");
  });
});

// ============================================================================
// capabilities は検査しない(ADR-0024 §8)
// ============================================================================

describe("capabilities は参照整合性検査の対象にしない(ADR-0024 §8)", () => {
  test("マニフェストに現れない capability 名を書いても拒否されない(実行時に照合する)", () => {
    const fn = tableFunction();
    fn.capabilities = ["some-connection", "some-ai-capability"];
    expect(validateReferentialIntegrity(manifestWith(fn))).toEqual({ valid: true });
  });
});

// ============================================================================
// ID重複 / カスケード非抑止 / path
// ============================================================================

describe("関数IDの重複(テーブル・ビュー・ワークフローと揃える)", () => {
  test("同じIDの関数が2本あると拒否される(2件目の位置を指す)", () => {
    const first = tableFunction();
    const second = tableFunction();
    second.name = "別の名前だがIDが同じ";

    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(first, second)));
    const error = errorAt(errors, "/app/functions/1/id");
    expect(error.message).toContain("count-by-month");
    expect(error.message).toContain("重複");
  });
});

describe("path が正しい要素を指す", () => {
  test("2本目の関数が壊れていたら /app/functions/1/... を指す", () => {
    const ok = tableFunction();
    const broken = tableFunction();
    broken.id = "second-function";
    broken.input = { source: "table", table: "nowhere" };

    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(ok, broken)));
    expect(errors).toHaveLength(1);
    expect(errorAt(errors, "/app/functions/1/input/table")).toBeDefined();
  });
});

describe("有効系・後方互換", () => {
  test("正しい関数を持つマニフェストが通る", () => {
    expect(validateReferentialIntegrity(manifestWith(tableFunction()))).toEqual({ valid: true });
  });

  test("functions キーを持たないマニフェストが通る(後方互換)", () => {
    const manifest = baseManifest();
    expect(manifest.app.functions).toBeUndefined();
    expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
  });

  test("functions が空配列でも通る", () => {
    expect(validateReferentialIntegrity(manifestWith())).toEqual({ valid: true });
  });
});

// ============================================================================
// 【最重要】apply_diff の実経路(スキーマ・畳み込み・参照整合性の三層を通す)
// ============================================================================

describe("apply_diff の実経路: 存在しない table / view を指す関数は拒否される", () => {
  const APP_ID = "loan-tracker";
  let dataRoot: string;
  let store: KernelMetaStore;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "gp-function-ri-"));
    store = KernelMetaStore.open(dataRoot);
    createApp(store, "貸出管理", { app_id: APP_ID });
    const applied = applyManifest(dataRoot, APP_ID, baseManifest());
    if (!applied.valid) {
      throw new Error(`前提の投入に失敗: ${JSON.stringify(applied.errors)}`);
    }
    const seeded = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-seed",
      intent: "集計関数を入れる",
      operations: [{ op: "add_function", function: tableFunction() }],
    });
    if (!seeded.valid) {
      throw new Error(`前提の add_function に失敗: ${JSON.stringify(seeded.errors)}`);
    }
  });

  afterEach(async () => {
    store.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  function tryApply(diffId: string, intent: string, operation: Diff["operations"][number]) {
    return applyDiff(dataRoot, APP_ID, { diff_id: diffId, intent, operations: [operation] });
  }

  test("存在しないテーブルを入力に指す add_function は apply_diff が拒否する", () => {
    const fn = clone(tableFunction());
    fn.id = "ghost";
    fn.input = { source: "table", table: "table-that-does-not-exist" };

    const result = tryApply("d-ghost", "存在しないテーブルを数えたい", {
      op: "add_function",
      function: fn,
    });

    expect(result.valid).toBe(false);
    if (result.valid) {
      throw new Error("expected rejection");
    }
    expect(result.errors.map((e) => e.path)).toContain("/app/functions/1/input/table");
  });

  test("入力テーブルを remove_table で消す差分は apply_diff が拒否する(カスケードが順序を強制)", () => {
    const result = tryApply("d-remove", "貸出テーブルを消したい", {
      op: "remove_table",
      table: "loans",
    });

    expect(result.valid).toBe(false);
    if (result.valid) {
      throw new Error("expected rejection");
    }
    expect(result.errors.map((e) => e.path)).toContain("/app/functions/0/input/table");
  });

  test("先に remove_function すれば remove_table が通る(定義を外してから消す)", () => {
    // `monthly-counts` はどのビューからも参照されていない —— したがってこれを塞いでいるのは
    // 下で足す関数だけであり、「関数を外せば remove_table が通る」を純粋に見られる
    // (`loans` はビュー loan-list / loan-form からも参照されているので題材にできない)。
    const onCounts: FunctionDef = {
      id: "count-of-counts",
      name: "月次集計を数える",
      code: "export default (rows) => rows;",
      input: { source: "table", table: "monthly-counts" },
      output: { fields: [{ id: "n", type: "number" }] },
    };
    const seededOnCounts = tryApply("d-0", "月次集計を入力にする関数を足す", {
      op: "add_function",
      function: onCounts,
    });
    expect(seededOnCounts.valid).toBe(true);

    // 1) 関数が残ったままでは通らない。
    const blocked = tryApply("d-1", "月次集計テーブルを消したい", {
      op: "remove_table",
      table: "monthly-counts",
    });
    expect(blocked.valid).toBe(false);

    // 2) 関数を先に外す。
    const removedFn = tryApply("d-2", "集計はもう要らない", {
      op: "remove_function",
      function: { id: "count-of-counts" },
    });
    expect(removedFn.valid).toBe(true);

    // 3) 同じ remove_table が今度は通る。
    const removedTable = tryApply("d-3", "月次集計テーブルを消したい", {
      op: "remove_table",
      table: "monthly-counts",
    });
    expect(removedTable.valid).toBe(true);
  });

  test("入力テーブルを change_table でリネームすると、関数の input.table が追随する(§5d)", () => {
    const result = tryApply("d-rename", "貸出テーブルの名前を変えたい", {
      op: "change_table",
      table: "loans",
      changes: { id: "checkouts" },
    });
    // 追随しなければ参照整合性がこの rename を拒否する。通ることが追随の証拠である。
    expect(result.valid).toBe(true);
    if (!result.valid) {
      throw new Error(`expected success: ${JSON.stringify(result.errors)}`);
    }
    const fn = result.manifest.app.functions?.[0];
    expect(fn?.input).toEqual({ source: "table", table: "checkouts" });
  });

  test("存在する list_view を入力に指す add_function は通る", () => {
    const result = tryApply("d-view-ok", "一覧から数えたい", {
      op: "add_function",
      function: {
        id: "from-view",
        name: "一覧から数える",
        code: "export default (rows) => rows;",
        input: { source: "view", view: "loan-list" },
        output: { fields: [{ id: "month", type: "text" }] },
      },
    });
    expect(result.valid).toBe(true);
  });
});
