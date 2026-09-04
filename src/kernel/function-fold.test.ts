import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff, foldOperations } from "./apply-diff.ts";
import { applyManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { planMigration } from "./migrate.ts";
import { appManifestPath } from "./storage-paths.ts";
import type { Diff, FunctionDef, Manifest } from "./types.ts";
import { undo } from "./undo.ts";

/**
 * 関数3 op の畳み込み(ADR-0024 / V1-M6-T05 第1段)の検査。
 *
 * `workflow-fold.test.ts` と完全に同型で、**`foldOperations` / `applyDiff` /
 * `planMigration` が実際に関数を適用できる**ことを固定する。作法は
 * `workflow-fold.test.ts` / `apply-diff.test.ts` / `undo.test.ts` に揃えてある
 * (実ディスク・実DB・実 changelog を使い、モックを1つも置かない)。
 *
 * **run_function(実行)は第2段(T03〜)であり、ここでは一切足していない。**
 */

const APP_ID = "loan-tracker";

let dataRoot: string;
let store: KernelMetaStore;

/**
 * 貸出管理アプリの初期マニフェスト。**`functions` キーを持たない** —— 後方互換
 * (`undefined` の初期化)の検査を、特別な前提を作らずに全ケースで兼ねさせるため。
 */
function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "貸出管理",
      tables: [
        {
          id: "loans",
          name: "貸出",
          fields: [
            { id: "borrower", name: "借り手", type: "text", required: true },
            { id: "borrowed_on", name: "貸出日", type: "date" },
          ],
        },
        {
          id: "monthly-counts",
          name: "月次集計",
          fields: [
            { id: "month", name: "月", type: "text" },
            { id: "count", name: "件数", type: "number" },
          ],
        },
      ],
      views: [{ id: "loan-list", type: "list_view", table: "loans", columns: ["borrower"] }],
    },
  };
}

/** ADR-0024 §Decision のサンプル関数(table 入力)。 */
function countFunction(): FunctionDef {
  return {
    id: "count-by-month",
    name: "月ごとに貸出を数える",
    code: "export default (rows) => rows;",
    input: { source: "table", table: "loans" },
    output: {
      fields: [
        { id: "month", type: "text" },
        { id: "count", type: "number" },
      ],
    },
    capabilities: [],
  };
}

/** 同じIDで中身だけ差し替えた版(update_function の対象)。 */
function countFunctionV2(): FunctionDef {
  return {
    id: "count-by-month",
    name: "貸出中の一覧から数える",
    code: "export default (rows) => rows.filter(() => true);",
    input: { source: "view", view: "loan-list" },
    output: { fields: [{ id: "month", type: "text" }] },
    capabilities: [],
  };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-function-fold-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "貸出管理", { app_id: APP_ID });
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

/** ディスク上の manifest.json をそのまま読む(applyDiff の戻り値ではなく永続化結果を見る)。 */
function readManifestFile(): Manifest {
  return JSON.parse(readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8")) as Manifest;
}

/** 1 operation の差分を組み立てる。 */
function diffWith(diffId: string, intent: string, operation: Diff["operations"][number]): Diff {
  return { diff_id: diffId, intent, operations: [operation] };
}

/** 差分を適用し、失敗したらエラー内容を添えて落とす。成功形に絞って返す。 */
function apply(diff: Diff): Extract<ReturnType<typeof applyDiff>, { valid: true }> {
  const result = applyDiff(dataRoot, APP_ID, diff);
  if (!result.valid) {
    throw new Error(`差分の適用に失敗しました: ${JSON.stringify(result.errors)}`);
  }
  return result;
}

/** `add_function` を1本入れた状態を作る(不在エラー検査などの前提)。 */
function seedFunction(): void {
  apply(diffWith("d-seed", "集計関数を入れる", { op: "add_function", function: countFunction() }));
}

/** 畳み込みだけを回す(ディスクを触らない検査用)。 */
function fold(operations: Diff["operations"]): ReturnType<typeof foldOperations> {
  return foldOperations(baseManifest(), operations);
}

describe("完了条件1: 関数3 op が差分として適用でき、changelog に intent が載る", () => {
  test("add_function がマニフェストに反映され、changelog に intent 付きで記録される", () => {
    const result = apply(
      diffWith("d-0001", "月ごとの集計を関数で持ちたい", {
        op: "add_function",
        function: countFunction(),
      }),
    );

    expect(readManifestFile().app.functions).toEqual([countFunction()]);
    expect(result.entry.intent).toBe("月ごとの集計を関数で持ちたい");
    expect(result.entry.operations).toEqual([{ op: "add_function", function: countFunction() }]);

    const logged = store.listChangelog(APP_ID).find((entry) => entry.diff_id === "d-0001");
    expect(logged?.intent).toBe("月ごとの集計を関数で持ちたい");
    expect(logged?.kind).toBe("apply");
  });

  test("update_function が同じIDの関数を丸ごと置き換え、changelog に載る", () => {
    seedFunction();
    const result = apply(
      diffWith("d-0002", "入力を一覧ビューに変えたい", {
        op: "update_function",
        function: countFunctionV2(),
      }),
    );

    // **丸ごと置き換え**である。差分マージではないので、code も input も name も入れ替わる。
    expect(readManifestFile().app.functions).toEqual([countFunctionV2()]);
    expect(result.entry.intent).toBe("入力を一覧ビューに変えたい");

    const logged = store.listChangelog(APP_ID).find((entry) => entry.diff_id === "d-0002");
    expect(logged?.operations).toEqual([{ op: "update_function", function: countFunctionV2() }]);
  });

  test("remove_function が関数を取り除き、changelog に載る", () => {
    seedFunction();
    const result = apply(
      diffWith("d-0003", "集計はもう要らない", {
        op: "remove_function",
        function: { id: "count-by-month" },
      }),
    );

    expect(readManifestFile().app.functions).toEqual([]);
    expect(result.entry.intent).toBe("集計はもう要らない");

    const logged = store.listChangelog(APP_ID).find((entry) => entry.diff_id === "d-0003");
    expect(logged?.operations).toEqual([
      { op: "remove_function", function: { id: "count-by-month" } },
    ]);
  });

  test("同じ差分の中で add してから update できる(畳み込みは先頭から順に効く)", () => {
    const folded = fold([
      { op: "add_function", function: countFunction() },
      { op: "update_function", function: countFunctionV2() },
    ]);
    expect(folded.valid).toBe(true);
    if (!folded.valid) {
      return;
    }
    expect(folded.manifest.app.functions).toEqual([countFunctionV2()]);
  });
});

describe("完了条件2: undo で元に戻る", () => {
  test("add_function を undo すると functions が消える(キーごと戻る)", () => {
    const before = readManifestFile();
    apply(diffWith("d-0011", "集計を入れる", { op: "add_function", function: countFunction() }));
    expect(readManifestFile().app.functions).toHaveLength(1);

    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    // 適用前は `functions` が存在しなかった。
    expect(readManifestFile()).toEqual(before);
    expect(readManifestFile().app.functions).toBeUndefined();
  });

  test("update_function を undo すると置き換え前の定義に戻る", () => {
    seedFunction();
    const before = readManifestFile();
    apply(
      diffWith("d-0012", "入力を変える", { op: "update_function", function: countFunctionV2() }),
    );
    expect(readManifestFile().app.functions).toEqual([countFunctionV2()]);

    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    expect(readManifestFile()).toEqual(before);
    expect(readManifestFile().app.functions).toEqual([countFunction()]);
  });

  test("remove_function を undo すると消した関数が戻る", () => {
    seedFunction();
    const before = readManifestFile();
    apply(
      diffWith("d-0013", "集計を消す", {
        op: "remove_function",
        function: { id: "count-by-month" },
      }),
    );
    expect(readManifestFile().app.functions).toEqual([]);

    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    expect(readManifestFile()).toEqual(before);
    expect(readManifestFile().app.functions).toEqual([countFunction()]);
  });
});

describe("重複・不在の拒否", () => {
  test("同じIDの add_function を2回送ると拒否する", () => {
    const folded = fold([
      { op: "add_function", function: countFunction() },
      { op: "add_function", function: countFunctionV2() },
    ]);
    expect(folded.valid).toBe(false);
    if (folded.valid) {
      return;
    }
    expect(folded.errors).toHaveLength(1);
    const error = folded.errors[0];
    expect(error?.path).toBe("/operations/1/function/id");
    expect(error?.message).toContain("count-by-month");
    expect(error?.hint).toContain("update_function");
  });

  test("既にある関数を add_function すると拒否する(適用済みの状態に対して)", () => {
    seedFunction();
    const result = applyDiff(
      dataRoot,
      APP_ID,
      diffWith("d-0021", "もう一度足す", { op: "add_function", function: countFunction() }),
    );
    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    expect(result.errors[0]?.path).toBe("/operations/0/function/id");
  });

  test("存在しないIDの update_function を拒否し、allowed_values に現在のID一覧を出す", () => {
    const folded = fold([
      { op: "add_function", function: countFunction() },
      { op: "update_function", function: { ...countFunctionV2(), id: "no-such-function" } },
    ]);
    expect(folded.valid).toBe(false);
    if (folded.valid) {
      return;
    }
    const error = folded.errors[0];
    expect(error?.path).toBe("/operations/1/function");
    expect(error?.message).toContain("no-such-function");
    expect(error?.allowed_values).toEqual(["count-by-month"]);
    expect(error?.hint).toContain("add_function");
  });

  test("存在しないIDの remove_function を拒否し、allowed_values に現在のID一覧を出す", () => {
    const folded = fold([
      { op: "add_function", function: countFunction() },
      { op: "remove_function", function: { id: "no-such-function" } },
    ]);
    expect(folded.valid).toBe(false);
    if (folded.valid) {
      return;
    }
    const error = folded.errors[0];
    expect(error?.path).toBe("/operations/1/function");
    expect(error?.allowed_values).toEqual(["count-by-month"]);
    expect(error?.hint).toBeDefined();
  });

  test("functions が1つも無い状態の allowed_values は空配列である(キーは必ず入る)", () => {
    const folded = fold([{ op: "remove_function", function: { id: "count-by-month" } }]);
    expect(folded.valid).toBe(false);
    if (folded.valid) {
      return;
    }
    expect(folded.errors[0]?.allowed_values).toEqual([]);
  });

  test("拒否されたときはマニフェストもディスクも1バイトも変わらない", () => {
    const before = readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8");
    const result = applyDiff(
      dataRoot,
      APP_ID,
      diffWith("d-0025", "存在しないものを消す", {
        op: "remove_function",
        function: { id: "no-such-function" },
      }),
    );
    expect(result.valid).toBe(false);
    expect(readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8")).toBe(before);
  });
});

describe("不変性: 呼び出し側が渡した diff は書き換わらない", () => {
  test("applyDiff の後も diff オブジェクトが1バイトも変わっていない", () => {
    const diff = diffWith("d-0031", "集計を入れる", {
      op: "add_function",
      function: countFunction(),
    });
    const snapshot = structuredClone(diff);
    apply(diff);
    expect(diff).toEqual(snapshot);
  });

  test("マニフェスト側の関数は diff の関数と別オブジェクトである", () => {
    const fn = countFunction();
    const folded = fold([{ op: "add_function", function: fn }]);
    expect(folded.valid).toBe(true);
    if (!folded.valid) {
      return;
    }
    const stored = folded.manifest.app.functions?.[0];
    expect(stored).toEqual(fn);
    expect(stored).not.toBe(fn);
  });

  test("現行マニフェストも書き換わらない(foldOperations は純粋関数である)", () => {
    const current = baseManifest();
    const folded = foldOperations(current, [{ op: "add_function", function: countFunction() }]);
    expect(folded.valid).toBe(true);
    expect(current).toEqual(baseManifest());
    expect(current.app.functions).toBeUndefined();
  });
});

describe("完了条件4 の読み替え: 関数は MigrationStep を1つも生まない", () => {
  test("関数3 op を含む operations から MigrationStep は1つも出ない", () => {
    const current = baseManifest();
    for (const operation of [
      { op: "add_function", function: countFunction() },
      { op: "update_function", function: countFunctionV2() },
      { op: "remove_function", function: { id: "count-by-month" } },
    ] as const) {
      const planned = planMigration(current, current, [operation]);
      expect(planned.valid).toBe(true);
      if (!planned.valid) {
        continue;
      }
      expect(planned.plan.steps).toEqual([]);
      expect(planned.plan.add_tables).toEqual([]);
      expect(planned.plan.add_fields).toEqual([]);
      expect(planned.conversions).toEqual([]);
    }
  });

  test("applyDiff が返す plan も関数では空である", () => {
    const result = apply(
      diffWith("d-0041", "集計を入れる", { op: "add_function", function: countFunction() }),
    );
    expect(result.plan.add_tables).toEqual([]);
    expect(result.plan.add_fields).toEqual([]);
    expect(result.plan.steps ?? []).toEqual([]);
  });
});

describe("後方互換: functions を持たないマニフェスト", () => {
  test("functions が undefined のマニフェストに add_function を適用できる", () => {
    expect(readManifestFile().app.functions).toBeUndefined();
    apply(diffWith("d-0051", "集計を入れる", { op: "add_function", function: countFunction() }));
    expect(readManifestFile().app.functions).toEqual([countFunction()]);
  });

  test("functions が undefined でも update / remove は不在エラーになる(例外にならない)", () => {
    for (const operation of [
      { op: "update_function", function: countFunction() },
      { op: "remove_function", function: { id: "count-by-month" } },
    ] as const) {
      const folded = fold([operation]);
      expect(folded.valid).toBe(false);
      if (folded.valid) {
        continue;
      }
      expect(folded.errors[0]?.allowed_values).toEqual([]);
    }
  });
});
