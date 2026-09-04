import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff, foldOperations } from "./apply-diff.ts";
import { applyManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { appManifestPath } from "./storage-paths.ts";
import type { Diff, Manifest, Workflow } from "./types.ts";
import { undo } from "./undo.ts";

/**
 * rename の参照追随(§5d)が `app.workflows` に及ぶことの検査(V1-M2-T07 差し戻し)。
 *
 * `apply-diff.ts:336-343` の doc が「追随させないと rename は必ず参照整合性エラーに
 * なり、op が使えない」「追随の範囲は同一マニフェスト内に限る」と定めている。
 * **ワークフローは同一マニフェスト内にある。**したがって追随の範囲内である。
 *
 * 検査対象は2つ:
 *   欠陥1: `change_table` の rename が `trigger.table` / `actions[].table` /
 *          `history_table` に及ぶこと。**及ばないと参照整合性が rename を拒否する。**
 *   欠陥2: `change_field` の rename が `actions[].values` のキーと、`values` の値 /
 *          `target` に書かれた `$record.<フィールドID>` に及ぶこと。
 *          **参照整合性は `values` を検査しないので、及ばないと黙って壊れる**
 *          (憲法6)。
 *
 * 作法は `workflow-fold.test.ts` に揃えてある(実ディスク・実DB、モックを1つも置かない)。
 */

const APP_ID = "book-tracker";

let dataRoot: string;
let store: KernelMetaStore;

/**
 * 蔵書管理アプリ。`books`(トリガー元)/ `notifications`(アクションの出力先)/
 * `wf-runs`(実行履歴)の3テーブルを持つ。
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
            { id: "title_kana", name: "タイトルかな", type: "text" },
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

/**
 * `books` を3つの役割すべてで参照するワークフロー
 * (`trigger.table` / `actions[].table` / `history_table`)。
 */
function bookWorkflow(): Workflow {
  return {
    id: "notify-on-new-book",
    name: "新しい本が登録されたら通知する",
    trigger: { type: "on_create", table: "books" },
    actions: [
      {
        action: "create_record",
        table: "notifications",
        values: { title: "$record.title", source: "$record._id" },
      },
      {
        action: "update_record",
        table: "books",
        target: "$record._id",
        values: { memo: "$record.title", title_kana: "リテラルな title" },
      },
    ],
    history_table: "wf-runs",
  };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-workflow-rename-"));
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

function readManifestFile(): Manifest {
  return JSON.parse(readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8")) as Manifest;
}

function diffWith(diffId: string, intent: string, ...operations: Diff["operations"]): Diff {
  return { diff_id: diffId, intent, operations };
}

function apply(diff: Diff): Extract<ReturnType<typeof applyDiff>, { valid: true }> {
  const result = applyDiff(dataRoot, APP_ID, diff);
  if (!result.valid) {
    throw new Error(`差分の適用に失敗しました: ${JSON.stringify(result.errors)}`);
  }
  return result;
}

/** 畳み込みだけを回し、成功形に絞って返す。 */
function foldOk(manifest: Manifest, operations: Diff["operations"]): Manifest {
  const folded = foldOperations(manifest, operations);
  if (!folded.valid) {
    throw new Error(`畳み込みに失敗しました: ${JSON.stringify(folded.errors)}`);
  }
  return folded.manifest;
}

/** ワークフローを1本以上入れたマニフェストを作る(畳み込み単体検査用)。 */
function manifestWith(...workflows: Workflow[]): Manifest {
  const manifest = baseManifest();
  manifest.app.workflows = workflows;
  return manifest;
}

/** ワークフローを1本以上ディスクに入れる(applyDiff 実経路の前提)。 */
function seed(...workflows: Workflow[]): void {
  apply(
    diffWith(
      "d-seed",
      "ワークフローを入れる",
      ...workflows.map((workflow) => ({ op: "add_workflow" as const, workflow })),
    ),
  );
}

/** `update_record` の `target` を取り出す(`create_record` は `target` を持たない)。 */
function targetOf(action: Workflow["actions"][number] | undefined): string | undefined {
  return action?.action === "update_record" ? action.target : undefined;
}

/**
 * `values` を取り出す(`create_record` / `update_record` のみが持つ。`call_external` は
 * `payload` を持ち `values` を持たないので、union の絞り込みでここを通す)。
 */
function valuesOf(
  action: Workflow["actions"][number] | undefined,
): Record<string, string> | undefined {
  return action?.action === "create_record" || action?.action === "update_record"
    ? action.values
    : undefined;
}

/** 書き込み先 `table` を取り出す(`call_external` は内部テーブルを持たない)。 */
function tableOf(action: Workflow["actions"][number] | undefined): string | undefined {
  return action?.action === "create_record" || action?.action === "update_record"
    ? action.table
    : undefined;
}

/** 適用後のワークフローを1本取り出す。 */
function workflowOf(manifest: Manifest, id: string): Workflow {
  const found = (manifest.app.workflows ?? []).find((workflow) => workflow.id === id);
  if (found === undefined) {
    throw new Error(`ワークフロー "${id}" が見つかりません。`);
  }
  return found;
}

describe("欠陥1: change_table の rename がワークフローの3参照に追随する", () => {
  test("trigger.table / actions[].table / history_table が3つとも追随する", () => {
    const next = foldOk(manifestWith(bookWorkflow()), [
      { op: "change_table", table: "books", changes: { id: "volumes" } },
    ]);

    const workflow = workflowOf(next, "notify-on-new-book");
    // trigger.table(入力側)
    expect(workflow.trigger).toEqual({ type: "on_create", table: "volumes" });
    // actions[].table(出力側)—— `books` を指していたものだけが動く
    expect(tableOf(workflow.actions[1])).toBe("volumes");
    // 別テーブルを指すアクションは巻き添えにならない
    expect(tableOf(workflow.actions[0])).toBe("notifications");
    // history_table(出力側)
    expect(workflow.history_table).toBe("wf-runs");
  });

  test("1つのワークフローが同じテーブルを複数の役割で参照していても全部追随する", () => {
    const selfLogging: Workflow = {
      id: "self-logging",
      name: "本の変更を本に記録する",
      trigger: { type: "on_update", table: "books" },
      actions: [{ action: "create_record", table: "books", values: { title: "写し" } }],
      history_table: "books",
    };

    const next = foldOk(manifestWith(selfLogging), [
      { op: "change_table", table: "books", changes: { id: "volumes" } },
    ]);

    const workflow = workflowOf(next, "self-logging");
    expect(workflow.trigger).toEqual({ type: "on_update", table: "volumes" });
    expect(tableOf(workflow.actions[0])).toBe("volumes");
    expect(workflow.history_table).toBe("volumes");
  });

  test("history_table だけが対象テーブルのときも追随する", () => {
    const historyOnly: Workflow = {
      id: "history-only",
      name: "定時実行の履歴だけを wf-runs に残す",
      trigger: { type: "schedule", at: { hour: 9, minute: 0 } },
      actions: [{ action: "create_record", table: "notifications", values: { title: "定時" } }],
      history_table: "wf-runs",
    };

    const next = foldOk(manifestWith(historyOnly), [
      { op: "change_table", table: "wf-runs", changes: { id: "runs" } },
    ]);

    const workflow = workflowOf(next, "history-only");
    expect(workflow.history_table).toBe("runs");
    // 他の参照は動かない
    expect(workflow.trigger).toEqual({ type: "schedule", at: { hour: 9, minute: 0 } });
    expect(tableOf(workflow.actions[0])).toBe("notifications");
  });

  test("別のテーブルを参照しているワークフローは巻き添えで書き換わらない", () => {
    const unrelated: Workflow = {
      id: "unrelated",
      name: "通知が増えたら履歴を残す",
      trigger: { type: "on_create", table: "notifications" },
      actions: [{ action: "create_record", table: "notifications", values: { title: "写し" } }],
      history_table: "wf-runs",
    };

    const next = foldOk(manifestWith(bookWorkflow(), unrelated), [
      { op: "change_table", table: "books", changes: { id: "volumes" } },
    ]);

    expect(workflowOf(next, "unrelated")).toEqual(unrelated);
  });

  test("**この修正の目的**: ワークフローが参照しているテーブルの rename が applyDiff の実経路で通る", () => {
    seed(bookWorkflow());

    // 修正前はここで参照整合性(ワークフローの trigger.table / actions[].table が
    // 存在しないテーブル "books" を指す)に落ちて **rename が使えなかった**。
    const result = applyDiff(
      dataRoot,
      APP_ID,
      diffWith("d-rename-table", "books を volumes に改名したい", {
        op: "change_table",
        table: "books",
        changes: { id: "volumes" },
      }),
    );

    expect(result.valid).toBe(true);

    const persisted = workflowOf(readManifestFile(), "notify-on-new-book");
    expect(persisted.trigger).toEqual({ type: "on_create", table: "volumes" });
    expect(tableOf(persisted.actions[1])).toBe("volumes");
    expect(persisted.history_table).toBe("wf-runs");
  });

  test("テーブル rename を undo すると3参照とも元に戻る", () => {
    seed(bookWorkflow());
    apply(
      diffWith("d-rename-table", "books を volumes に改名したい", {
        op: "change_table",
        table: "books",
        changes: { id: "volumes" },
      }),
    );

    const undone = undo(dataRoot, APP_ID);
    expect(undone.valid).toBe(true);

    expect(workflowOf(readManifestFile(), "notify-on-new-book")).toEqual(bookWorkflow());
  });
});

describe("欠陥2: change_field の rename がワークフローのフィールド参照に追随する", () => {
  test("actions[].values のキーが追随する(書き込み先テーブルのフィールドID)", () => {
    const next = foldOk(manifestWith(bookWorkflow()), [
      { op: "change_field", table: "notifications", field: "source", changes: { id: "origin" } },
    ]);

    const workflow = workflowOf(next, "notify-on-new-book");
    // `notifications` に書くアクションのキーだけが動く
    expect(valuesOf(workflow.actions[0])).toEqual({
      title: "$record.title",
      origin: "$record._id",
    });
  });

  test("**別テーブルのアクションが同名のキーを持っていても触らない**", () => {
    const sameKey: Workflow = {
      id: "same-key",
      name: "同名キーを持つアクションが2つある",
      trigger: { type: "on_create", table: "books" },
      actions: [
        // 書き込み先が `notifications` —— こちらの `title` は notifications.title
        { action: "create_record", table: "notifications", values: { title: "通知の件名" } },
        // 書き込み先が `wf-runs` —— こちらに `title` は無いが、あっても別のフィールド
        { action: "create_record", table: "wf-runs", values: { result: "ok" } },
      ],
      history_table: "wf-runs",
    };

    const next = foldOk(manifestWith(sameKey), [
      { op: "change_field", table: "wf-runs", field: "result", changes: { id: "outcome" } },
    ]);

    const workflow = workflowOf(next, "same-key");
    // wf-runs のアクションだけが動く
    expect(valuesOf(workflow.actions[1])).toEqual({ outcome: "ok" });
    // notifications のアクションは無傷
    expect(valuesOf(workflow.actions[0])).toEqual({ title: "通知の件名" });
  });

  test("別テーブルのアクションの同名キーは、rename 対象と同じ綴りでも動かない", () => {
    const collide: Workflow = {
      id: "collide",
      name: "notifications と books の両方に title がある",
      trigger: { type: "on_create", table: "books" },
      actions: [
        { action: "create_record", table: "notifications", values: { title: "通知の件名" } },
        {
          action: "update_record",
          table: "books",
          target: "$record._id",
          values: { title: "写し" },
        },
      ],
      history_table: "wf-runs",
    };

    // **`notifications.title` を rename する。**`books` のアクションが持つ `title` は
    // 別テーブルのフィールドなので動いてはならない。
    const next = foldOk(manifestWith(collide), [
      { op: "change_field", table: "notifications", field: "title", changes: { id: "subject" } },
    ]);

    const workflow = workflowOf(next, "collide");
    expect(valuesOf(workflow.actions[0])).toEqual({ subject: "通知の件名" });
    expect(valuesOf(workflow.actions[1])).toEqual({ title: "写し" });
  });

  test("$record.<フィールドID> が values の値と target の両方で追随する", () => {
    const next = foldOk(manifestWith(bookWorkflow()), [
      { op: "change_field", table: "books", field: "title", changes: { id: "book_title" } },
    ]);

    const workflow = workflowOf(next, "notify-on-new-book");
    // values の値(2つのアクションの両方)
    expect(valuesOf(workflow.actions[0])?.title).toBe("$record.book_title");
    expect(valuesOf(workflow.actions[1])?.memo).toBe("$record.book_title");
    // target
    expect(targetOf(workflow.actions[1])).toBe("$record._id");
  });

  test("target の $record.<フィールドID> が追随する", () => {
    const targeting: Workflow = {
      id: "targeting",
      name: "target にフィールド参照を書く",
      trigger: { type: "on_update", table: "books" },
      actions: [
        {
          action: "update_record",
          table: "notifications",
          target: "$record.title",
          values: { source: "$record.memo" },
        },
      ],
      history_table: "wf-runs",
    };

    const next = foldOk(manifestWith(targeting), [
      { op: "change_field", table: "books", field: "title", changes: { id: "book_title" } },
    ]);

    const action = workflowOf(next, "targeting").actions[0];
    expect(action?.action === "update_record" ? action.target : undefined).toBe(
      "$record.book_title",
    );
  });

  test("**trigger.table が rename 対象テーブルでないワークフローの $record. は触らない**", () => {
    const otherTrigger: Workflow = {
      id: "other-trigger",
      name: "通知が増えたら発火する",
      trigger: { type: "on_create", table: "notifications" },
      actions: [
        // ここの `$record.title` は **notifications.title** を指す
        { action: "create_record", table: "wf-runs", values: { result: "$record.title" } },
      ],
      history_table: "wf-runs",
    };

    // **books.title** を rename する。トリガー元が違うので動いてはならない。
    const next = foldOk(manifestWith(otherTrigger), [
      { op: "change_field", table: "books", field: "title", changes: { id: "book_title" } },
    ]);

    expect(workflowOf(next, "other-trigger")).toEqual(otherTrigger);
  });

  test("**schedule トリガーのワークフローの $record. は触らない**(トリガー元テーブルが無い)", () => {
    const scheduled: Workflow = {
      id: "scheduled",
      name: "定時実行",
      trigger: { type: "schedule", at: { hour: 9, minute: 0 } },
      actions: [{ action: "create_record", table: "wf-runs", values: { result: "$record.title" } }],
      history_table: "wf-runs",
    };

    const next = foldOk(manifestWith(scheduled), [
      { op: "change_field", table: "books", field: "title", changes: { id: "book_title" } },
    ]);

    expect(workflowOf(next, "scheduled")).toEqual(scheduled);
  });

  test("**$record._id は触られない**(ユーザ定義フィールドではないので rename の対象になりえない)", () => {
    const next = foldOk(manifestWith(bookWorkflow()), [
      { op: "change_field", table: "books", field: "title", changes: { id: "book_title" } },
    ]);

    const workflow = workflowOf(next, "notify-on-new-book");
    expect(valuesOf(workflow.actions[0])?.source).toBe("$record._id");
    expect(targetOf(workflow.actions[1])).toBe("$record._id");
  });

  test("**リテラル文字列は、たまたま旧フィールドIDと同じ綴りでも触られない**", () => {
    const literal: Workflow = {
      id: "literal",
      name: "リテラルが旧IDと同じ綴り",
      trigger: { type: "on_create", table: "books" },
      actions: [
        {
          action: "create_record",
          table: "notifications",
          // `$` で始まらない = リテラル(限定12)。**フィールド参照ではない。**
          values: { title: "title", source: "record.title" },
        },
      ],
      history_table: "wf-runs",
    };

    const next = foldOk(manifestWith(literal), [
      { op: "change_field", table: "books", field: "title", changes: { id: "book_title" } },
    ]);

    expect(valuesOf(workflowOf(next, "literal").actions[0])).toEqual({
      title: "title",
      source: "record.title",
    });
  });

  test("**部分一致で壊さない**: $record.title_kana は title の rename で動かない", () => {
    const prefixed: Workflow = {
      id: "prefixed",
      name: "前方一致で壊れる形",
      trigger: { type: "on_create", table: "books" },
      actions: [
        {
          action: "create_record",
          table: "notifications",
          values: { title: "$record.title_kana", source: "$record.title" },
        },
      ],
      history_table: "wf-runs",
    };

    const next = foldOk(manifestWith(prefixed), [
      { op: "change_field", table: "books", field: "title", changes: { id: "book_title" } },
    ]);

    const values = valuesOf(workflowOf(next, "prefixed").actions[0]);
    // `title_kana` は別のフィールドである。前方一致で判定すると
    // `$record.book_title_kana` に壊れる。
    expect(values?.title).toBe("$record.title_kana");
    expect(values?.source).toBe("$record.book_title");
  });

  test("フィールド rename が applyDiff の実経路で永続化される", () => {
    seed(bookWorkflow());
    apply(
      diffWith("d-rename-field", "title を book_title に改名したい", {
        op: "change_field",
        table: "books",
        field: "title",
        changes: { id: "book_title" },
      }),
    );

    const persisted = workflowOf(readManifestFile(), "notify-on-new-book");
    expect(valuesOf(persisted.actions[0])?.title).toBe("$record.book_title");
    expect(valuesOf(persisted.actions[1])?.memo).toBe("$record.book_title");
  });

  test("フィールド rename を undo するとワークフローの参照も元に戻る", () => {
    seed(bookWorkflow());
    apply(
      diffWith("d-rename-field", "title を book_title に改名したい", {
        op: "change_field",
        table: "books",
        field: "title",
        changes: { id: "book_title" },
      }),
    );

    const undone = undo(dataRoot, APP_ID);
    expect(undone.valid).toBe(true);

    expect(workflowOf(readManifestFile(), "notify-on-new-book")).toEqual(bookWorkflow());
  });
});

describe("共通: 不変性", () => {
  test("呼び出し側が渡した diff オブジェクトが書き換わらない", () => {
    const operations: Diff["operations"] = [
      { op: "change_table", table: "books", changes: { id: "volumes" } },
      { op: "change_field", table: "volumes", field: "title", changes: { id: "book_title" } },
    ];
    const snapshot = structuredClone(operations);

    foldOk(manifestWith(bookWorkflow()), operations);

    expect(operations).toEqual(snapshot);
  });

  test("呼び出し側が渡した現在マニフェストが書き換わらない", () => {
    const current = manifestWith(bookWorkflow());
    const snapshot = structuredClone(current);

    foldOk(current, [{ op: "change_table", table: "books", changes: { id: "volumes" } }]);

    expect(current).toEqual(snapshot);
  });
});
