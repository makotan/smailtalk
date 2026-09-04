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
import type { Diff, Manifest, Workflow } from "./types.ts";
import { undo } from "./undo.ts";

/**
 * ワークフロー3 op の畳み込み(ADR-0013 / V1-M2-T07 第2段階)の検査。
 *
 * 第1段階(`workflow-schema.test.ts`)が「スキーマと型がワークフローを受け付ける」ことを
 * 固定したのに対し、ここは **`foldOperations` / `applyDiff` / `planMigration` が
 * 実際にワークフローを適用できる**ことを固定する。
 *
 * 作法は `apply-diff.test.ts` / `undo.test.ts` に完全に揃えてある(実ディスク・実DB・
 * 実 changelog を使い、モックを1つも置かない)。
 */

const APP_ID = "book-tracker";

let dataRoot: string;
let store: KernelMetaStore;

/**
 * 蔵書管理アプリの初期マニフェスト。**`workflows` キーを持たない** ——
 * 後方互換(`undefined` の初期化)の検査を、特別な前提を作らずに全ケースで
 * 兼ねさせるためである(ADR-0013 §1: 省略は「1つも無い」と同じ意味)。
 *
 * `notifications`(アクションの出力先)と `wf-runs`(実行履歴)は**ユーザが
 * add_table で作る通常のテーブル**である(限定8: カーネルは1本も自動生成しない)。
 */
function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "蔵書管理",
      tables: [
        {
          id: "books",
          name: "本",
          fields: [
            { id: "title", name: "タイトル", type: "text", required: true },
            { id: "memo", name: "メモ", type: "long_text" },
          ],
        },
        {
          id: "notifications",
          name: "通知",
          fields: [
            { id: "title", name: "件名", type: "text" },
            { id: "source", name: "対象", type: "text" },
          ],
        },
        {
          id: "wf-runs",
          name: "実行履歴",
          /*
           * **V1-M2-T05a D1 で規約どおりの5列に直した。**
           * それまでは `result` の1列だけで、`writeHistory` が書く5キーと1つも
           * 合っていなかった —— T05 の実地検証で AI が3試行とも作った形と同じである。
           * D1 の列構成検査が入ったことで、このフィクスチャは
           * `validateReferentialIntegrity` に拒否されるようになった。
           * **フィクスチャが赤くなったこと自体が、検査が効いている証拠である。**
           * `result` は既存テストが参照しているので残す(規約外の列を**足す**のは
           * ADR-0013 §8c 問2 が認めている)。
           */
          fields: [
            { id: "ran_at", name: "実行時刻", type: "date" },
            { id: "workflow", name: "ワークフロー", type: "text" },
            { id: "trigger_type", name: "きっかけ", type: "text" },
            { id: "status", name: "結果", type: "text" },
            { id: "error", name: "エラー", type: "long_text" },
            { id: "result", name: "結果(このフィクスチャ独自の追加列)", type: "text" },
          ],
        },
      ],
      views: [{ id: "book-list", type: "list_view", table: "books", columns: ["title"] }],
    },
  };
}

/** ADR-0013 §1 のサンプルワークフロー。 */
function notifyWorkflow(): Workflow {
  return {
    id: "notify-on-new-book",
    name: "新しい本が登録されたら通知する",
    trigger: { type: "on_create", table: "books" },
    actions: [
      {
        action: "create_record",
        table: "notifications",
        values: { title: "新しい本が登録されました", source: "$record._id" },
      },
    ],
    history_table: "wf-runs",
  };
}

/** 同じIDで中身だけ差し替えた版(update_workflow の対象)。 */
function notifyWorkflowV2(): Workflow {
  return {
    id: "notify-on-new-book",
    name: "本が更新されたら通知する",
    trigger: { type: "schedule", at: { hour: 9, minute: 0 } },
    actions: [{ action: "create_record", table: "notifications", values: { title: "定時通知" } }],
    history_table: "wf-runs",
  };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-workflow-fold-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "蔵書管理", { app_id: APP_ID });
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

/** `add_workflow` を1本入れた状態を作る(不在エラー検査などの前提)。 */
function seedWorkflow(): void {
  apply(
    diffWith("d-seed", "通知ワークフローを入れる", {
      op: "add_workflow",
      workflow: notifyWorkflow(),
    }),
  );
}

/** 畳み込みだけを回す(ディスクを触らない検査用)。 */
function fold(operations: Diff["operations"]): ReturnType<typeof foldOperations> {
  return foldOperations(baseManifest(), operations);
}

describe("完了条件1: ワークフロー3 op が差分として適用でき、changelog に intent が載る", () => {
  test("add_workflow がマニフェストに反映され、changelog に intent 付きで記録される", () => {
    const result = apply(
      diffWith("d-0001", "新しい本が登録されたら通知したい", {
        op: "add_workflow",
        workflow: notifyWorkflow(),
      }),
    );

    expect(readManifestFile().app.workflows).toEqual([notifyWorkflow()]);
    expect(result.entry.intent).toBe("新しい本が登録されたら通知したい");
    expect(result.entry.operations).toEqual([{ op: "add_workflow", workflow: notifyWorkflow() }]);

    const logged = store.listChangelog(APP_ID).find((entry) => entry.diff_id === "d-0001");
    expect(logged?.intent).toBe("新しい本が登録されたら通知したい");
    expect(logged?.kind).toBe("apply");
  });

  test("update_workflow が同じIDのワークフローを丸ごと置き換え、changelog に載る", () => {
    seedWorkflow();
    const result = apply(
      diffWith("d-0002", "通知のきっかけを定時実行に変えたい", {
        op: "update_workflow",
        workflow: notifyWorkflowV2(),
      }),
    );

    // **丸ごと置き換え**である。差分マージではないので、trigger も actions も name も入れ替わる。
    expect(readManifestFile().app.workflows).toEqual([notifyWorkflowV2()]);
    expect(result.entry.intent).toBe("通知のきっかけを定時実行に変えたい");

    const logged = store.listChangelog(APP_ID).find((entry) => entry.diff_id === "d-0002");
    expect(logged?.intent).toBe("通知のきっかけを定時実行に変えたい");
    expect(logged?.operations).toEqual([{ op: "update_workflow", workflow: notifyWorkflowV2() }]);
  });

  test("remove_workflow がワークフローを取り除き、changelog に載る", () => {
    seedWorkflow();
    const result = apply(
      diffWith("d-0003", "通知はもう要らない", {
        op: "remove_workflow",
        workflow: { id: "notify-on-new-book" },
      }),
    );

    expect(readManifestFile().app.workflows).toEqual([]);
    expect(result.entry.intent).toBe("通知はもう要らない");

    const logged = store.listChangelog(APP_ID).find((entry) => entry.diff_id === "d-0003");
    expect(logged?.intent).toBe("通知はもう要らない");
    expect(logged?.operations).toEqual([
      { op: "remove_workflow", workflow: { id: "notify-on-new-book" } },
    ]);
  });

  test("同じ差分の中で add してから update できる(畳み込みは先頭から順に効く)", () => {
    const folded = fold([
      { op: "add_workflow", workflow: notifyWorkflow() },
      { op: "update_workflow", workflow: notifyWorkflowV2() },
    ]);
    expect(folded.valid).toBe(true);
    if (!folded.valid) {
      return;
    }
    expect(folded.manifest.app.workflows).toEqual([notifyWorkflowV2()]);
  });
});

describe("完了条件2: undo で元に戻る", () => {
  test("add_workflow を undo すると workflows が消える", () => {
    const before = readManifestFile();
    apply(diffWith("d-0011", "通知を入れる", { op: "add_workflow", workflow: notifyWorkflow() }));
    expect(readManifestFile().app.workflows).toHaveLength(1);

    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    // **キーごと元に戻る** —— 適用前は `workflows` が存在しなかった。
    expect(readManifestFile()).toEqual(before);
  });

  test("update_workflow を undo すると置き換え前の定義に戻る", () => {
    seedWorkflow();
    const before = readManifestFile();
    apply(
      diffWith("d-0012", "定時実行に変える", {
        op: "update_workflow",
        workflow: notifyWorkflowV2(),
      }),
    );
    expect(readManifestFile().app.workflows).toEqual([notifyWorkflowV2()]);

    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    expect(readManifestFile()).toEqual(before);
    expect(readManifestFile().app.workflows).toEqual([notifyWorkflow()]);
  });

  test("remove_workflow を undo すると消したワークフローが戻る", () => {
    seedWorkflow();
    const before = readManifestFile();
    apply(
      diffWith("d-0013", "通知を消す", {
        op: "remove_workflow",
        workflow: { id: "notify-on-new-book" },
      }),
    );
    expect(readManifestFile().app.workflows).toEqual([]);

    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    expect(readManifestFile()).toEqual(before);
    expect(readManifestFile().app.workflows).toEqual([notifyWorkflow()]);
  });
});

describe("重複・不在の拒否", () => {
  test("同じIDの add_workflow を2回送ると拒否する", () => {
    const folded = fold([
      { op: "add_workflow", workflow: notifyWorkflow() },
      { op: "add_workflow", workflow: notifyWorkflowV2() },
    ]);
    expect(folded.valid).toBe(false);
    if (folded.valid) {
      return;
    }
    expect(folded.errors).toHaveLength(1);
    const error = folded.errors[0];
    expect(error?.path).toBe("/operations/1/workflow/id");
    expect(error?.message).toContain("notify-on-new-book");
    expect(error?.hint).toContain("update_workflow");
  });

  test("既にあるワークフローを add_workflow すると拒否する(適用済みの状態に対して)", () => {
    seedWorkflow();
    const result = applyDiff(
      dataRoot,
      APP_ID,
      diffWith("d-0021", "もう一度足す", {
        op: "add_workflow",
        workflow: notifyWorkflow(),
      }),
    );
    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    expect(result.errors[0]?.path).toBe("/operations/0/workflow/id");
  });

  test("存在しないIDの update_workflow を拒否し、allowed_values に現在のID一覧を出す", () => {
    const folded = fold([
      { op: "add_workflow", workflow: notifyWorkflow() },
      { op: "update_workflow", workflow: { ...notifyWorkflowV2(), id: "no-such-workflow" } },
    ]);
    expect(folded.valid).toBe(false);
    if (folded.valid) {
      return;
    }
    expect(folded.errors).toHaveLength(1);
    const error = folded.errors[0];
    expect(error?.path).toBe("/operations/1/workflow");
    expect(error?.message).toContain("no-such-workflow");
    expect(error?.allowed_values).toEqual(["notify-on-new-book"]);
    expect(error?.hint).toContain("add_workflow");
  });

  test("存在しないIDの remove_workflow を拒否し、allowed_values に現在のID一覧を出す", () => {
    const folded = fold([
      { op: "add_workflow", workflow: notifyWorkflow() },
      { op: "remove_workflow", workflow: { id: "no-such-workflow" } },
    ]);
    expect(folded.valid).toBe(false);
    if (folded.valid) {
      return;
    }
    const error = folded.errors[0];
    expect(error?.path).toBe("/operations/1/workflow");
    expect(error?.allowed_values).toEqual(["notify-on-new-book"]);
    expect(error?.hint).toBeDefined();
  });

  test("workflows が1つも無い状態の allowed_values は空配列である(キーは必ず入る)", () => {
    const folded = fold([{ op: "remove_workflow", workflow: { id: "notify-on-new-book" } }]);
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
        op: "remove_workflow",
        workflow: { id: "no-such-workflow" },
      }),
    );
    expect(result.valid).toBe(false);
    expect(readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8")).toBe(before);
  });
});

describe("不変性: 呼び出し側が渡した diff は書き換わらない(apply-diff.ts:187-193 の再発検査)", () => {
  test("applyDiff の後も diff オブジェクトが1バイトも変わっていない", () => {
    const diff = diffWith("d-0031", "通知を入れる", {
      op: "add_workflow",
      workflow: notifyWorkflow(),
    });
    const snapshot = structuredClone(diff);

    apply(diff);

    expect(diff).toEqual(snapshot);
  });

  test("マニフェスト側のワークフローは diff のワークフローと別オブジェクトである", () => {
    const workflow = notifyWorkflow();
    const folded = fold([{ op: "add_workflow", workflow }]);
    expect(folded.valid).toBe(true);
    if (!folded.valid) {
      return;
    }
    const stored = folded.manifest.app.workflows?.[0];
    expect(stored).toEqual(workflow);
    // **参照が同じだと、後からマニフェストを触っただけで diff が書き換わる。**
    expect(stored).not.toBe(workflow);
  });

  test("畳み込み結果を書き換えても、渡した operation は変わらない(add / update の両方)", () => {
    const added = notifyWorkflow();
    const updated = notifyWorkflowV2();
    const folded = fold([
      { op: "add_workflow", workflow: added },
      { op: "update_workflow", workflow: updated },
    ]);
    expect(folded.valid).toBe(true);
    if (!folded.valid) {
      return;
    }
    const stored = folded.manifest.app.workflows?.[0];
    expect(stored).not.toBe(updated);
    if (stored !== undefined) {
      stored.name = "書き換えた";
      stored.actions.push({
        action: "create_record",
        table: "notifications",
        values: { title: "混入" },
      });
    }
    expect(added).toEqual(notifyWorkflow());
    expect(updated).toEqual(notifyWorkflowV2());
  });

  test("現行マニフェストも書き換わらない(foldOperations は純粋関数である)", () => {
    const current = baseManifest();
    const folded = foldOperations(current, [{ op: "add_workflow", workflow: notifyWorkflow() }]);
    expect(folded.valid).toBe(true);
    expect(current).toEqual(baseManifest());
    expect(current.app.workflows).toBeUndefined();
  });
});

describe("完了条件4 の読み替え: ワークフローは MigrationStep を1つも生まない", () => {
  test("ワークフローだけが違う2つのマニフェストから MigrationStep は出ない(v0 経路)", () => {
    const current = baseManifest();
    const next = baseManifest();
    next.app.workflows = [notifyWorkflow()];

    // operations 無し = `planFromManifestDiff`。`app.workflows` はそもそも走査されない。
    const planned = planMigration(current, next);
    expect(planned.valid).toBe(true);
    if (!planned.valid) {
      return;
    }
    expect(planned.plan.add_tables).toEqual([]);
    expect(planned.plan.add_fields).toEqual([]);
    expect(planned.plan.steps ?? []).toEqual([]);
  });

  test("ワークフローを消す方向でも v0 経路は破壊的と判定しない", () => {
    const current = baseManifest();
    current.app.workflows = [notifyWorkflow()];
    const next = baseManifest();

    const planned = planMigration(current, next);
    expect(planned.valid).toBe(true);
  });

  test("ワークフロー3 op を含む operations から MigrationStep は1つも出ない", () => {
    const current = baseManifest();
    for (const operation of [
      { op: "add_workflow", workflow: notifyWorkflow() },
      { op: "update_workflow", workflow: notifyWorkflowV2() },
      { op: "remove_workflow", workflow: { id: "notify-on-new-book" } },
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

  test("applyDiff が返す plan もワークフローでは空である", () => {
    const result = apply(
      diffWith("d-0041", "通知を入れる", { op: "add_workflow", workflow: notifyWorkflow() }),
    );
    expect(result.plan.add_tables).toEqual([]);
    expect(result.plan.add_fields).toEqual([]);
    expect(result.plan.steps ?? []).toEqual([]);
  });
});

describe("後方互換: workflows を持たないマニフェスト", () => {
  test("workflows が undefined のマニフェストに add_workflow を適用できる", () => {
    // 前提: 初期マニフェストは `workflows` キーを持たない。
    expect(readManifestFile().app.workflows).toBeUndefined();

    apply(diffWith("d-0051", "通知を入れる", { op: "add_workflow", workflow: notifyWorkflow() }));
    expect(readManifestFile().app.workflows).toEqual([notifyWorkflow()]);
  });

  test("workflows が undefined でも update / remove は不在エラーになる(例外にならない)", () => {
    for (const operation of [
      { op: "update_workflow", workflow: notifyWorkflow() },
      { op: "remove_workflow", workflow: { id: "notify-on-new-book" } },
    ] as const) {
      const folded = fold([operation]);
      expect(folded.valid).toBe(false);
      if (folded.valid) {
        continue;
      }
      expect(folded.errors[0]?.allowed_values).toEqual([]);
    }
  });

  test("空配列の workflows に対しても add_workflow が効く", () => {
    const current = baseManifest();
    current.app.workflows = [];
    const folded = foldOperations(current, [{ op: "add_workflow", workflow: notifyWorkflow() }]);
    expect(folded.valid).toBe(true);
    if (!folded.valid) {
      return;
    }
    expect(folded.manifest.app.workflows).toEqual([notifyWorkflow()]);
  });
});
