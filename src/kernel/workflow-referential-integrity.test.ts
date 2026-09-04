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
import type {
  Diff,
  Manifest,
  Workflow,
  WorkflowActionCreateRecord,
  WorkflowActionUpdateRecord,
} from "./types.ts";
import { WORKFLOW_HISTORY_COLUMNS } from "./workflow-runner.ts";

/**
 * 先頭アクションを `table` / `values` を持つ種別(create_record / update_record)に
 * 絞って取り出す(不正フィクスチャを組むための可変参照)。`call_external` は
 * `table` / `values` を持たないので、フィクスチャ前提として弾く。
 */
function mutableAction(
  action: Workflow["actions"][number] | undefined,
): WorkflowActionCreateRecord | WorkflowActionUpdateRecord {
  if (
    action === undefined ||
    action.action === "call_external" ||
    action.action === "ai_transform" ||
    action.action === "run_function"
  ) {
    throw new Error("fixture broken");
  }
  return action;
}

/**
 * ワークフローの参照整合性(ADR-0013 §1a / §8b / V1-M2-T07 第3段階)の検査。
 *
 * **この段階が ADR-0013 の U6 却下(「組み込みのユーザランドテーブル」という区分を
 * 作らない)の根拠そのものである。**§8b はこう書いている:
 *
 * > `app.workflows` を `referential-integrity.ts` の走査対象に加えると、存在しない
 * > テーブルを指すワークフローは `apply_diff` の時点で拒否される。したがって
 * > **「動くワークフローが存在する ⇒ そのワークフローが指すテーブルが存在する」**が
 * > カーネルで保証される。プラットフォームが作る必要が無い。
 *
 * 最後の describe(「§8b の主張の実証」)は、この含意が**実装で実際に成立している**
 * ことを `applyDiff` の実経路で証明する。ユニットテストではないのは意図的である ——
 * `validateManifestFull` を直接呼んで通ることは、`apply_diff` が拒否することの証明に
 * ならない(間に畳み込みと永続化がいる)。
 *
 * 作法は `referential-integrity.test.ts`(ヘルパ)と `workflow-fold.test.ts`
 * (実ディスク・実DB)に揃えてある。
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

/** 深いコピー(サンプルを壊さずに異常系を作るため)。 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 蔵書管理アプリ。`notifications`(アクションの出力先)と `wf-runs`(実行履歴)は
 * **ユーザが add_table で作る通常のテーブル**である(限定8)。
 */
function baseManifest(): Manifest {
  return {
    app: {
      id: "book-tracker",
      name: "蔵書管理",
      tables: [
        {
          id: "books",
          name: "本",
          fields: [{ id: "title", name: "タイトル", type: "text", required: true }],
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

/** ADR-0013 §1 のサンプルワークフロー(3種の参照をすべて持つ)。 */
function notifyWorkflow(): Workflow {
  return {
    id: "notify-on-new-book",
    name: "新しい本が登録されたら通知する",
    trigger: { type: "on_create", table: "books" },
    actions: [
      {
        action: "create_record",
        table: "notifications",
        values: { title: "新しい本が登録されました", source: "$record.title" },
      },
    ],
    history_table: "wf-runs",
  };
}

/**
 * `schedule` トリガーの健全なワークフロー(**`$record.` を1つも持たない**)。
 *
 * `notifyWorkflow()` は `values.source` に `$record.title` を持つので、
 * **トリガーだけ `schedule` に差し替えると判断3 の検査に引っかかる。**
 * `schedule` の「テーブル実在検査」を見たいテストは、こちらを土台にする。
 */
function scheduledWorkflow(): Workflow {
  return {
    id: "daily-summary",
    name: "毎朝9時にまとめを作る",
    trigger: { type: "schedule", at: { hour: 9, minute: 0 } },
    actions: [
      {
        action: "create_record",
        table: "notifications",
        values: { title: "本日のまとめ", source: "定時実行" },
      },
    ],
    history_table: "wf-runs",
  };
}

/** ワークフローを1本持つマニフェストを組み立てる。 */
function manifestWith(...workflows: Workflow[]): Manifest {
  const manifest = baseManifest();
  manifest.app.workflows = workflows;
  return manifest;
}

// ============================================================================
// 完了条件3 の中心: 存在しないテーブルを指すワークフローは拒否される
// ============================================================================

describe("ワークフローが指すテーブルの実在検査(3種の参照すべて)", () => {
  test("trigger.table が存在しないテーブルを指すと拒否される", () => {
    const workflow = notifyWorkflow();
    workflow.trigger = { type: "on_create", table: "bookz" };

    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(workflow)));
    const error = errorAt(errors, "/app/workflows/0/trigger/table");
    expect(error.message).toContain("bookz");
    expect(error.message).toContain("存在しません");
    expect(error.hint).toBeDefined();
  });

  test("on_update トリガーでも同じく trigger.table が検査される", () => {
    const workflow = notifyWorkflow();
    workflow.trigger = { type: "on_update", table: "bookz" };

    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(workflow)));
    expect(errorAt(errors, "/app/workflows/0/trigger/table").message).toContain("bookz");
  });

  test("actions[].table が存在しないテーブルを指すと拒否される", () => {
    const workflow = notifyWorkflow();
    const action = mutableAction(workflow.actions[0]);
    action.table = "notificationz";

    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(workflow)));
    const error = errorAt(errors, "/app/workflows/0/actions/0/table");
    expect(error.message).toContain("notificationz");
    expect(error.message).toContain("存在しません");
  });

  test("history_table が存在しないテーブルを指すと拒否される", () => {
    const workflow = notifyWorkflow();
    workflow.history_table = "wf-runz";

    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(workflow)));
    const error = errorAt(errors, "/app/workflows/0/history_table");
    expect(error.message).toContain("wf-runz");
    expect(error.message).toContain("存在しません");
  });

  test("update_record アクションの table も検査される(2種のアクションで差が無い)", () => {
    const workflow = notifyWorkflow();
    workflow.actions = [
      {
        action: "update_record",
        table: "nowhere",
        target: "$record.title",
        values: { title: "更新" },
      },
    ];

    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(workflow)));
    expect(errorAt(errors, "/app/workflows/0/actions/0/table").message).toContain("nowhere");
  });

  test("3種の参照が同時に壊れていたら3件とも報告される(最初の1件で打ち切らない)", () => {
    const workflow = notifyWorkflow();
    workflow.trigger = { type: "on_create", table: "nope-1" };
    const action = mutableAction(workflow.actions[0]);
    action.table = "nope-2";
    workflow.history_table = "nope-3";

    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(workflow)));
    const paths = errors.map((error) => error.path);
    expect(paths).toContain("/app/workflows/0/trigger/table");
    expect(paths).toContain("/app/workflows/0/actions/0/table");
    expect(paths).toContain("/app/workflows/0/history_table");
    expect(errors).toHaveLength(3);
  });
});

// ============================================================================
// ADR-0006 §9: 候補一覧が「閉まっている裏口」を宣伝しないこと
// ============================================================================

describe("allowed_values にシステムテーブルが漏れない(ADR-0013 限定10)", () => {
  test.each([
    [
      "trigger.table",
      "/app/workflows/0/trigger/table",
      (workflow: Workflow): void => {
        workflow.trigger = { type: "on_create", table: "missing" };
      },
    ],
    [
      "actions[].table",
      "/app/workflows/0/actions/0/table",
      (workflow: Workflow): void => {
        const action = mutableAction(workflow.actions[0]);
        action.table = "missing";
      },
    ],
    [
      "history_table",
      "/app/workflows/0/history_table",
      (workflow: Workflow): void => {
        workflow.history_table = "missing";
      },
    ],
  ])("%s のエラーは宣言テーブルのみを候補に出す", (_label, path, breakIt) => {
    const workflow = notifyWorkflow();
    breakIt(workflow);

    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(workflow)));
    const error = errorAt(errors, path);

    // ビュー(`viewTargetIds`)と違い、ワークフローはシステムテーブルを対象にできない。
    expect(error.allowed_values).toEqual(["books", "notifications", "wf-runs"]);
    expect(error.allowed_values).not.toContain("_apps");
    expect(error.allowed_values).not.toContain("_changelog");
  });
});

// ============================================================================
// インデックスの取り違え検査
// ============================================================================

describe("path が正しい要素を指す", () => {
  test("actions の2番目が壊れていたら /app/workflows/0/actions/1/table を指す", () => {
    const workflow = notifyWorkflow();
    workflow.actions = [
      {
        action: "create_record",
        table: "notifications",
        values: { title: "1本目は正しい" },
      },
      {
        action: "create_record",
        table: "broken-target",
        values: { title: "2本目が壊れている" },
      },
    ];

    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(workflow)));
    expect(errors).toHaveLength(1);
    const error = errorAt(errors, "/app/workflows/0/actions/1/table");
    expect(error.message).toContain("broken-target");
  });

  test("2本目のワークフローが壊れていたら /app/workflows/1/... を指す", () => {
    const ok = notifyWorkflow();
    const broken = notifyWorkflow();
    broken.id = "second-workflow";
    broken.history_table = "nowhere";

    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(ok, broken)));
    expect(errors).toHaveLength(1);
    expect(errorAt(errors, "/app/workflows/1/history_table")).toBeDefined();
  });
});

// ============================================================================
// schedule トリガー(table を持たない)
// ============================================================================

describe("schedule トリガーは trigger.table を持たない", () => {
  test("schedule のワークフローが trigger.table の不在で誤って拒否されない", () => {
    const workflow = scheduledWorkflow();

    expect(validateReferentialIntegrity(manifestWith(workflow))).toEqual({ valid: true });
  });

  test("schedule でも actions[].table と history_table は検査される", () => {
    const workflow = scheduledWorkflow();
    const action = mutableAction(workflow.actions[0]);
    action.table = "nope";
    workflow.history_table = "also-nope";

    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(workflow)));
    const paths = errors.map((error) => error.path);
    expect(paths).toEqual(["/app/workflows/0/actions/0/table", "/app/workflows/0/history_table"]);
  });
});

// ============================================================================
// 【V1-M2-T02 判断3】schedule トリガー × `$record.` は適用時に拒否する
// ============================================================================

/**
 * **`schedule` トリガーにはトリガー元レコードが存在しない**(ADR-0013 §6)。
 * したがって `$record.foo` は解決しようが無い。T07 は「実行時に失敗として履歴に残す」
 * 側に倒したが、**T02 の判断3 でこれを覆した**(`docs/plan/v1/02-workflow.md` §2-2)。
 *
 * この検査は**静的**である —— フィールドの実在は問わず、
 * 「トリガーがレコード源を持つか」だけを見る。実行時に倒すと毎日9時に失敗行が
 * 積まれ、ユーザが履歴を見るまで気づかない。適用時に拒否すれば AI は1往復で直せる。
 *
 * **`workflow-runner.ts` の実行時解決器は残してある**(防御の二重化)。
 */
describe("判断3: schedule トリガーのアクションに $record. は書けない", () => {
  test("create_record の values に $record.foo があると拒否される", () => {
    const workflow = scheduledWorkflow();
    const action = mutableAction(workflow.actions[0]);
    action.values = { title: "本日のまとめ", source: "$record.title" };

    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(workflow)));
    const error = errorAt(errors, "/app/workflows/0/actions/0/values/source");
    expect(error.message).toContain("$record.title");
    expect(error.message).toContain("schedule");
    expect(error.hint).toBeDefined();
    // 不在IDのエラーではないので候補一覧は付かない(:15 の作法の適用範囲外)。
    expect(error.allowed_values).toBeUndefined();
    // `title` はリテラルなので巻き添えにならない。
    expect(errors).toHaveLength(1);
  });

  test("update_record の target が $record._id だと拒否される", () => {
    const workflow = scheduledWorkflow();
    workflow.actions = [
      {
        action: "update_record",
        table: "notifications",
        target: "$record._id",
        values: { title: "更新" },
      },
    ];

    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(workflow)));
    const error = errorAt(errors, "/app/workflows/0/actions/0/target");
    expect(error.message).toContain("$record._id");
    expect(error.hint).toBeDefined();
    expect(errors).toHaveLength(1);
  });

  test("values がリテラルだけなら通る(巻き添え拒否をしていない)", () => {
    expect(validateReferentialIntegrity(manifestWith(scheduledWorkflow()))).toEqual({
      valid: true,
    });
  });

  test("`$` で始まらないリテラルは、綴りが紛らわしくても通る", () => {
    const workflow = scheduledWorkflow();
    const action = mutableAction(workflow.actions[0]);
    // 前方一致で `$record.` を見るので、`$record` 単体や `record.title` は該当しない。
    action.values = { title: "record.title", source: "レコードの $record ではない話" };

    expect(validateReferentialIntegrity(manifestWith(workflow))).toEqual({ valid: true });
  });

  test("on_create トリガーの $record. は通る(既存の振る舞いを壊していない)", () => {
    // notifyWorkflow() は values.source に `$record.title` を持つ。
    expect(validateReferentialIntegrity(manifestWith(notifyWorkflow()))).toEqual({ valid: true });
  });

  test("on_update トリガーの target: $record._id は通る", () => {
    const workflow = notifyWorkflow();
    workflow.trigger = { type: "on_update", table: "books" };
    workflow.actions = [
      {
        action: "update_record",
        table: "notifications",
        target: "$record._id",
        values: { title: "$record.title" },
      },
    ];

    expect(validateReferentialIntegrity(manifestWith(workflow))).toEqual({ valid: true });
  });

  test("複数アクションのうち2番目だけが $record. を使うとき、path のインデックスが正しい", () => {
    const workflow = scheduledWorkflow();
    workflow.actions = [
      { action: "create_record", table: "notifications", values: { title: "1番目はリテラル" } },
      {
        action: "update_record",
        table: "notifications",
        target: "$record._id",
        values: { title: "リテラル", source: "$record.title" },
      },
      { action: "create_record", table: "notifications", values: { title: "3番目もリテラル" } },
    ];

    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(workflow)));
    // 2番目のアクションの target と values.source の**2箇所とも**報告される
    // (:12-17 の設計方針: 最初の1件で打ち切らない)。
    expect(errors.map((error) => error.path)).toEqual([
      "/app/workflows/0/actions/1/values/source",
      "/app/workflows/0/actions/1/target",
    ]);
  });

  test("ワークフローが複数あっても、schedule のものだけが拒否される", () => {
    const scheduled = scheduledWorkflow();
    const action = mutableAction(scheduled.actions[0]);
    action.values = { title: "まとめ", source: "$record.title" };

    // 0番目は on_create(通る)、1番目が schedule(拒否)。
    const errors = expectInvalid(
      validateReferentialIntegrity(manifestWith(notifyWorkflow(), scheduled)),
    );
    expect(errors.map((error) => error.path)).toEqual(["/app/workflows/1/actions/0/values/source"]);
  });
});

// ============================================================================
// ID重複(テーブル・ビューと揃える)
// ============================================================================

describe("ワークフローIDの重複", () => {
  test("同じIDのワークフローが2本あると拒否される", () => {
    const first = notifyWorkflow();
    const second = notifyWorkflow();
    second.name = "別の名前だがIDが同じ";

    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(first, second)));
    // 最初の出現を正とするので、報告されるのは2件目の位置。
    const error = errorAt(errors, "/app/workflows/1/id");
    expect(error.message).toContain("notify-on-new-book");
    expect(error.message).toContain("重複");
    expect(error.hint).toBeDefined();
  });

  test("3本重複していたら2件目と3件目が報告される", () => {
    const errors = expectInvalid(
      validateReferentialIntegrity(
        manifestWith(notifyWorkflow(), notifyWorkflow(), notifyWorkflow()),
      ),
    );
    expect(errors.map((error) => error.path)).toEqual([
      "/app/workflows/1/id",
      "/app/workflows/2/id",
    ]);
  });
});

// ============================================================================
// 有効系・後方互換
// ============================================================================

describe("有効系", () => {
  test("正しいワークフローを持つマニフェストが通る", () => {
    expect(validateReferentialIntegrity(manifestWith(notifyWorkflow()))).toEqual({ valid: true });
  });

  test("workflows キーを持たないマニフェストが通る(後方互換 / ADR-0013 §1)", () => {
    const manifest = baseManifest();
    expect(manifest.app.workflows).toBeUndefined();
    expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
  });

  test("workflows が空配列でも通る", () => {
    expect(validateReferentialIntegrity(manifestWith())).toEqual({ valid: true });
  });

  /**
   * **V1-M2-T05a D1 で土台のテーブルを `books` から `wf-runs` に変えた。**
   * 主張(3参照が同じテーブルを指してよい)は1文字も変えていないが、
   * **`history_table` に指すテーブルは列の規約を満たしていなければならなくなった** ——
   * `books` は `title` しか持たないので、D1 の検査が正しく拒否する。
   * 「同じテーブルでよい」と「どのテーブルでもよい」は別の主張である。
   */
  test("同じテーブルを trigger と actions と history_table で指してもよい", () => {
    const workflow = notifyWorkflow();
    workflow.trigger = { type: "on_create", table: "wf-runs" };
    workflow.actions = [{ action: "create_record", table: "wf-runs", values: { result: "複製" } }];
    workflow.history_table = "wf-runs";

    expect(validateReferentialIntegrity(manifestWith(workflow))).toEqual({ valid: true });
  });

  test("history_table に規約を満たさない業務テーブルを指すと拒否される", () => {
    const workflow = notifyWorkflow();
    workflow.history_table = "books";

    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(workflow)));
    expect(errorAt(errors, "/app/workflows/0/history_table").message).toContain("規約");
  });
});

// ============================================================================
// カスケード抑止の方針: 止めない(3参照は互いに独立)
// ============================================================================

describe("カスケード抑止", () => {
  test("trigger.table が不明でも actions[].table と history_table は検査される", () => {
    const workflow = notifyWorkflow();
    workflow.trigger = { type: "on_create", table: "unknown-source" };
    const action = mutableAction(workflow.actions[0]);
    action.table = "unknown-target";
    workflow.history_table = "unknown-history";

    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(workflow)));
    // ビュー(`views.forEach` の :130-132)は table が不明なら配下をスキップするが、
    // ワークフローは**スキップしない** —— 3つの参照は互いに独立で、trigger が
    // 分からなくても actions / history_table の検査は意味を持つ。1往復で全部直せる。
    expect(errors).toHaveLength(3);
  });
});

// ============================================================================
// 【V1-M9-T13 (2) / ADR-0029】アクションの値と書き込み先フィールドの型整合
// ============================================================================

/**
 * 型整合検査用の土台。トリガー元(`src`)と書き込み先(`dst`)に7型を揃える。
 * history_table は規約(5列)を満たす `wf-runs` を使う。
 */
function typedManifest(): Manifest {
  return {
    app: {
      id: "typed-app",
      name: "型整合検査",
      tables: [
        {
          id: "src",
          name: "トリガー元",
          fields: [
            { id: "name", name: "名前", type: "text" },
            { id: "memo", name: "メモ", type: "long_text" },
            { id: "age", name: "年齢", type: "number" },
            { id: "active", name: "有効", type: "boolean" },
            { id: "due", name: "期日", type: "date" },
            { id: "status", name: "状態", type: "select", options: ["a", "b"] },
          ],
        },
        {
          id: "dst",
          name: "書き込み先",
          fields: [
            { id: "label", name: "ラベル", type: "text" },
            { id: "note", name: "メモ", type: "long_text" },
            { id: "count", name: "件数", type: "number" },
            { id: "flag", name: "フラグ", type: "boolean" },
            { id: "when", name: "日時", type: "date" },
            { id: "kind", name: "種別", type: "select", options: ["x", "y"] },
            { id: "ref", name: "参照", type: "reference", reference_table: "src" },
          ],
        },
        {
          id: "wf-runs",
          name: "実行履歴",
          fields: [
            { id: "ran_at", name: "実行時刻", type: "date" },
            { id: "workflow", name: "ワークフロー", type: "text" },
            { id: "trigger_type", name: "きっかけ", type: "text" },
            { id: "status", name: "結果", type: "text" },
            { id: "error", name: "エラー", type: "long_text" },
          ],
        },
      ],
      views: [{ id: "src-list", type: "list_view", table: "src", columns: ["name"] }],
    },
  };
}

/** `src` を on_create トリガー、`dst` を create_record 先にした1本ワークフローを組む。 */
function typedWorkflow(values: Record<string, string>): Workflow {
  return {
    id: "wf",
    name: "型整合テスト",
    trigger: { type: "on_create", table: "src" },
    actions: [{ action: "create_record", table: "dst", values }],
    history_table: "wf-runs",
  };
}

function typedManifestWith(values: Record<string, string>): Manifest {
  const manifest = typedManifest();
  manifest.app.workflows = [typedWorkflow(values)];
  return manifest;
}

describe("型整合検査: 静的に確定する不整合(❌セル)は適用時に拒否する", () => {
  test("boolean 列へ text 参照($record.<text列>)は拒否される", () => {
    const errors = expectInvalid(
      validateReferentialIntegrity(typedManifestWith({ flag: "$record.name" })),
    );
    const error = errorAt(errors, "/app/workflows/0/actions/0/values/flag");
    expect(error.message).toContain("boolean");
    expect(error.message).toContain("文字列");
    expect(error.hint).toBeDefined();
    // 「文字列にしてください」で罠へ誘導しない。
    expect(error.hint).not.toContain("引用符で囲んで文字列にすれば");
  });

  test("number 列へ boolean 参照($record.<boolean列>)は拒否される", () => {
    const errors = expectInvalid(
      validateReferentialIntegrity(typedManifestWith({ count: "$record.active" })),
    );
    const error = errorAt(errors, "/app/workflows/0/actions/0/values/count");
    expect(error.message).toContain("number");
    expect(error.message).toContain("真偽値");
  });

  test("number 列へリテラル文字列は拒否される(D3 が塞いだリテラル側と同じ穴)", () => {
    const errors = expectInvalid(validateReferentialIntegrity(typedManifestWith({ count: "3" })));
    const error = errorAt(errors, "/app/workflows/0/actions/0/values/count");
    expect(error.message).toContain("number");
    // リテラルであることを明示する。
    expect(error.message).toContain("固定の文字列");
  });

  test("boolean 列へリテラル文字列は拒否される", () => {
    const errors = expectInvalid(validateReferentialIntegrity(typedManifestWith({ flag: "true" })));
    expect(errorAt(errors, "/app/workflows/0/actions/0/values/flag").message).toContain("boolean");
  });

  test("boolean 列へ number 参照は拒否される", () => {
    const errors = expectInvalid(
      validateReferentialIntegrity(typedManifestWith({ flag: "$record.age" })),
    );
    expect(errorAt(errors, "/app/workflows/0/actions/0/values/flag").message).toContain("boolean");
  });

  test("update_record の values も同じく検査される(target は対象外)", () => {
    const manifest = typedManifest();
    manifest.app.workflows = [
      {
        id: "wf",
        name: "更新",
        trigger: { type: "on_create", table: "src" },
        actions: [
          {
            action: "update_record",
            table: "dst",
            // **V2-M4-T02(EC-G13 / ADR-0040)で target 語彙が確定し、`"bogus"` は
            // apply 時に拒否されるようになった**(D2-a 選択肢A = リテラル target は UUID 形のみ)。
            // かつては「target は型整合検査の対象外(v2 送り)」で `"bogus"` を素通りさせ
            // ここに置いていたが、それは v2 で解消された。この検査の主旨(update_record の
            // **values** も create_record と同じく型整合検査に掛かる)を保つため、target は
            // 正規形の1つ `$record._id`(自己更新)に置き換える。`"bogus"` 拒否そのものは
            // `workflow-target-vocabulary.test.ts` が固定する。
            target: "$record._id",
            values: { count: "$record.name" },
          },
        ],
        history_table: "wf-runs",
      },
    ];
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    // count(number)へ name(text=string)→ 拒否。target=$record._id は正規形なので何も出さない。
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/app/workflows/0/actions/0/values/count");
  });

  test("schedule トリガーでもリテラルの型不整合は拒否される(類型7 が見ないリテラル側)", () => {
    const manifest = typedManifest();
    manifest.app.workflows = [
      {
        id: "wf",
        name: "定時",
        trigger: { type: "schedule", at: { hour: 9, minute: 0 } },
        actions: [{ action: "create_record", table: "dst", values: { flag: "true" } }],
        history_table: "wf-runs",
      },
    ];
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    expect(errorAt(errors, "/app/workflows/0/actions/0/values/flag").message).toContain("boolean");
  });
});

describe("型整合検査: ✅セルは必ず通す(過剰拒否をしない)", () => {
  test("boolean → boolean($record.<boolean列> → boolean列)は通す(009 の整合ケース)", () => {
    expect(validateReferentialIntegrity(typedManifestWith({ flag: "$record.active" }))).toEqual({
      valid: true,
    });
  });

  test("number → number($record.<number列> → number列)は通す", () => {
    expect(validateReferentialIntegrity(typedManifestWith({ count: "$record.age" }))).toEqual({
      valid: true,
    });
  });

  test("string → text / long_text(リテラル・$record.<text列>)は通す", () => {
    expect(
      validateReferentialIntegrity(
        typedManifestWith({ label: "固定文字列", note: "$record.memo" }),
      ),
    ).toEqual({ valid: true });
  });

  test("string → date は通す(ISO 形式は per-record・実行時に委ねる)", () => {
    // リテラルでも $record.<date列> でも、静的には string 同士なので通す。
    expect(validateReferentialIntegrity(typedManifestWith({ when: "きのう" }))).toEqual({
      valid: true,
    });
    expect(validateReferentialIntegrity(typedManifestWith({ when: "$record.due" }))).toEqual({
      valid: true,
    });
  });

  test("string → select は通す(options 一致は per-record・実行時に委ねる)", () => {
    expect(validateReferentialIntegrity(typedManifestWith({ kind: "options外の値" }))).toEqual({
      valid: true,
    });
  });

  test("string → reference は通す($record._id・実在は per-firing・実行時に委ねる)", () => {
    expect(validateReferentialIntegrity(typedManifestWith({ ref: "$record._id" }))).toEqual({
      valid: true,
    });
  });

  test("$record.<text列> → date/select/reference もすべて string 同士で通す", () => {
    expect(
      validateReferentialIntegrity(
        typedManifestWith({ when: "$record.name", kind: "$record.name", ref: "$record.name" }),
      ),
    ).toEqual({ valid: true });
  });
});

describe("型整合検査: 射程の限定(存在しない列・不明な参照)", () => {
  test("書き込み先に存在しない列への値は型検査しない(ADR-0029 の決定)", () => {
    // "unknown" は dst に無い列。型不整合ではなく「存在しない列」なので (2) の射程外。
    expect(validateReferentialIntegrity(typedManifestWith({ unknown: "3" }))).toEqual({
      valid: true,
    });
  });

  test("$record.<トリガー元に無い列> は型を確定できないのでスキップ(二重報告しない)", () => {
    // src に "ghost" は無い。元の型が引けないので型検査はスキップ(射程外)。
    expect(validateReferentialIntegrity(typedManifestWith({ count: "$record.ghost" }))).toEqual({
      valid: true,
    });
  });
});

// ============================================================================
// 【最重要】ADR-0013 §8b の主張の実証(applyDiff の実経路)
// ============================================================================

describe("ADR-0013 §8b: 動くワークフローが存在する ⇒ そのテーブルが存在する", () => {
  const APP_ID = "book-tracker";
  let dataRoot: string;
  let store: KernelMetaStore;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "gp-workflow-ri-"));
    store = KernelMetaStore.open(dataRoot);
    createApp(store, "蔵書管理", { app_id: APP_ID });
    const applied = applyManifest(dataRoot, APP_ID, baseManifest());
    if (!applied.valid) {
      throw new Error(`前提の投入に失敗: ${JSON.stringify(applied.errors)}`);
    }
    // ワークフローを1本入れる(ここが「動くワークフローが存在する」状態)。
    const seeded = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-seed",
      intent: "新しい本が登録されたら通知したい",
      operations: [{ op: "add_workflow", workflow: notifyWorkflow() }],
    });
    if (!seeded.valid) {
      throw new Error(`前提の add_workflow に失敗: ${JSON.stringify(seeded.errors)}`);
    }
  });

  afterEach(async () => {
    store.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  /** 1 op の差分を適用する(成否をそのまま返す)。 */
  function tryApply(diffId: string, intent: string, operation: Diff["operations"][number]) {
    return applyDiff(dataRoot, APP_ID, { diff_id: diffId, intent, operations: [operation] });
  }

  /*
   * --- V1-M2-T05a D1: 列を後から崩す経路も、同じ検査に掛かる ------------------
   *
   * D1 の検査は**適用後のマニフェスト全体**に対して働くので、
   * 「add_workflow の時点では正しかったが、後から列を消した / 型を変えた」
   * という経路も自然に掛かるはずである。**はずである、では足りないので実経路で見る。**
   * (`applyDiff` を通すのが要点。`validateReferentialIntegrity` を直接呼んでも
   * 「apply_diff が拒否する」ことの証明にはならない —— 間に畳み込みと永続化がいる。)
   */
  test.each([
    ["ran_at", "date"],
    ["workflow", "text"],
    ["trigger_type", "text"],
    ["status", "text"],
    ["error", "long_text"],
  ])("履歴テーブルの %s 列を remove_field で消す差分は apply_diff が拒否する", (fieldId, _type) => {
    const result = tryApply("d-drop-col", `${fieldId} 列はもう要らない`, {
      op: "remove_field",
      table: "wf-runs",
      field: fieldId,
    });

    expect(result.valid).toBe(false);
    if (result.valid) {
      throw new Error("expected rejection");
    }
    const error = result.errors.find(
      (candidate) => candidate.path === "/app/workflows/0/history_table",
    );
    expect(error).toBeDefined();
    expect(error?.message).toContain(fieldId);
  });

  test("履歴テーブルの status を change_field で select にする差分は apply_diff が拒否する", () => {
    // **最も踏みやすい罠**(`WORKFLOW_HISTORY_TABLE_TEMPLATE` が名指ししている形)。
    // failure を書こうとして options 不一致で弾かれ、最も知りたい1行が消える。
    const result = tryApply("d-select", "結果を選択式にしたい", {
      op: "change_field",
      table: "wf-runs",
      field: "status",
      changes: { type: "select", options: ["success", "failure"] },
    });

    expect(result.valid).toBe(false);
    if (result.valid) {
      throw new Error("expected rejection");
    }
    const error = result.errors.find(
      (candidate) => candidate.path === "/app/workflows/0/history_table",
    );
    expect(error?.message).toContain("select");
    expect(error?.hint).toContain("select 型を使ってはいけません");
  });

  test("履歴テーブルの独自の追加列は remove_field で消せる(検査が効きすぎていない)", () => {
    // 検査は「少なくとも5列」なので、規約外の列は自由に足し引きできる。
    // **ここが緑でないと、ADR-0013 §8c 問2(add_field で足せる)と矛盾する。**
    const result = tryApply("d-drop-extra", "独自の列を消したい", {
      op: "remove_field",
      table: "wf-runs",
      field: "result",
    });

    expect(result.valid).toBe(true);
  });

  test.each([
    ["trigger.table", "books", "/app/workflows/0/trigger/table"],
    ["actions[].table", "notifications", "/app/workflows/0/actions/0/table"],
    ["history_table", "wf-runs", "/app/workflows/0/history_table"],
  ])(
    "%s が指すテーブルを remove_table で消す差分は apply_diff が拒否する",
    (_label, tableId, expectedPath) => {
      const result = tryApply("d-remove", `${tableId} を消したい`, {
        op: "remove_table",
        table: tableId,
      });

      expect(result.valid).toBe(false);
      if (result.valid) {
        throw new Error("expected rejection");
      }
      expect(result.errors.map((error) => error.path)).toContain(expectedPath);
    },
  );

  test("先に remove_workflow すれば remove_table が通る(ADR-0012 のビューと同型)", () => {
    // 1) ワークフローが残ったままでは通らない。
    const blocked = tryApply("d-1", "通知テーブルを消したい", {
      op: "remove_table",
      table: "notifications",
    });
    expect(blocked.valid).toBe(false);

    // 2) ワークフローを先に消す。
    const removedWorkflow = tryApply("d-2", "通知の自動化はもう要らない", {
      op: "remove_workflow",
      workflow: { id: "notify-on-new-book" },
    });
    expect(removedWorkflow.valid).toBe(true);

    // 3) 同じ remove_table が今度は通る。
    const removedTable = tryApply("d-3", "通知テーブルを消したい", {
      op: "remove_table",
      table: "notifications",
    });
    expect(removedTable.valid).toBe(true);
  });

  test("同じ差分の中で remove_workflow → remove_table の順に並べても通る", () => {
    const result = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-both",
      intent: "通知の自動化ごとテーブルを片付けたい",
      operations: [
        { op: "remove_workflow", workflow: { id: "notify-on-new-book" } },
        { op: "remove_table", table: "notifications" },
      ],
    });
    expect(result.valid).toBe(true);
  });

  test("存在しないテーブルを指す add_workflow は apply_diff が拒否する", () => {
    const workflow = clone(notifyWorkflow());
    workflow.id = "ghost-workflow";
    workflow.history_table = "table-that-does-not-exist";

    const result = tryApply("d-ghost", "存在しないテーブルに履歴を書きたい", {
      op: "add_workflow",
      workflow,
    });

    expect(result.valid).toBe(false);
    if (result.valid) {
      throw new Error("expected rejection");
    }
    expect(result.errors.map((error) => error.path)).toContain("/app/workflows/1/history_table");
  });

  /**
   * 【判断3】**`validateManifestFull` を直接呼んでも証明にならない** ——
   * 間に畳み込みと永続化がいる。`apply_diff` の実経路で拒否されることを見る。
   */
  test("schedule × $record. を含む add_workflow は apply_diff が拒否する", () => {
    const result = tryApply("d-scheduled", "毎朝9時に本の名前で通知したい", {
      op: "add_workflow",
      workflow: {
        id: "daily-summary",
        name: "毎朝9時にまとめを作る",
        trigger: { type: "schedule", at: { hour: 9, minute: 0 } },
        actions: [
          {
            action: "create_record",
            table: "notifications",
            values: { title: "本日のまとめ", source: "$record.title" },
          },
        ],
        history_table: "wf-runs",
      },
    });

    expect(result.valid).toBe(false);
    if (result.valid) {
      throw new Error("expected rejection");
    }
    // 既存の notify-on-new-book が 0番目、追加されたものが 1番目。
    expect(result.errors.map((error) => error.path)).toContain(
      "/app/workflows/1/actions/0/values/source",
    );
  });

  test("schedule でも $record. を使わない add_workflow は通る", () => {
    const result = tryApply("d-scheduled-ok", "毎朝9時に定型文で通知したい", {
      op: "add_workflow",
      workflow: {
        id: "daily-summary-ok",
        name: "毎朝9時にまとめを作る",
        trigger: { type: "schedule", at: { hour: 9, minute: 0 } },
        actions: [
          {
            action: "create_record",
            table: "notifications",
            values: { title: "本日のまとめ", source: "定時実行" },
          },
        ],
        history_table: "wf-runs",
      },
    });

    expect(result.valid).toBe(true);
  });
});

// ============================================================================
// V1-M2-T05a D1: history_table の列構成の検査
// ============================================================================

/**
 * **V1-M2-T05a(差し戻し)で足した検査のテスト。**
 *
 * ADR-0013 §8c 問2 は「ワークフローが書く列が存在しない場合、実行を失敗として
 * 履歴に残す。黙って書かない(憲法6)」と約束していたが、**実装は黙っていた** ——
 * `defaultHistoryFailureHandler` が `console.error` するだけで、MCP の応答は
 * 成功に見える。T05 の実地検証では**3試行すべてが履歴を1行も残せなかった。**
 *
 * 対処は「実行時に失敗として残す」ではなく**差分適用時に拒否する**方に倒した
 * (`schedule` × `$record.` を適用時に倒したのと同じ理由。実行時に倒すと
 * ユーザが履歴を見に行くまで気づかない —— そしてその履歴こそが壊れている)。
 *
 * **検査の強さ:「ちょうど5列」ではなく「少なくとも規約の5列が正しい型で在ること」。**
 * ADR-0013 §8c 問2 が `add_field` による列の追加を明示的に認めているので、
 * 完全一致にすると ADR の判定と矛盾する。
 */
describe("history_table の列構成の検査(V1-M2-T05a D1)", () => {
  /** 規約どおりの5列を持つ履歴テーブル(`WORKFLOW_HISTORY_COLUMNS` と同じ並び)。 */
  function conformingHistoryTable() {
    return {
      id: "wf-runs",
      name: "実行履歴",
      fields: [
        { id: "ran_at", name: "実行時刻", type: "date" as const },
        { id: "workflow", name: "ワークフロー", type: "text" as const },
        { id: "trigger_type", name: "きっかけ", type: "text" as const },
        { id: "status", name: "結果", type: "text" as const },
        { id: "error", name: "エラー", type: "long_text" as const },
      ],
    };
  }

  /** `wf-runs` を差し替えたマニフェストを組む。 */
  function manifestWithHistory(fields: { id: string; name: string; type: string }[]): Manifest {
    const manifest = manifestWith(notifyWorkflow());
    const tables = manifest.app.tables;
    const index = tables.findIndex((table) => table.id === "wf-runs");
    tables[index] = { id: "wf-runs", name: "実行履歴", fields } as never;
    return manifest;
  }

  test("規約どおりの5列を持つ履歴テーブルは通る", () => {
    const result = validateReferentialIntegrity(
      manifestWithHistory(conformingHistoryTable().fields),
    );
    expect(result.valid).toBe(true);
  });

  test("列が1つも合っていない履歴テーブルは拒否される(実地 001 / 002 が作った形)", () => {
    // 001 は `memo` の1列だけ、002 は `note` の1列だけを作った。
    const errors = expectInvalid(
      validateReferentialIntegrity(
        manifestWithHistory([{ id: "memo", name: "メモ", type: "text" }]),
      ),
    );
    const error = errorAt(errors, "/app/workflows/0/history_table");
    // 足りない列を**全部**挙げること(1往復で直せること)。
    for (const column of ["ran_at", "workflow", "trigger_type", "status", "error"]) {
      expect(error.message).toContain(column);
    }
    // 正しい形を示すこと。
    expect(error.hint).toBeDefined();
    expect(error.hint).toContain("long_text");
  });

  test("`error` 列だけを欠いても拒否される(最も知りたい1行だけが消える形)", () => {
    const fields = conformingHistoryTable().fields.filter((field) => field.id !== "error");
    const errors = expectInvalid(validateReferentialIntegrity(manifestWithHistory(fields)));
    expect(errorAt(errors, "/app/workflows/0/history_table").message).toContain("error");
  });

  test("列はあるが型が違うと拒否される(status に select を使った場合)", () => {
    const fields = conformingHistoryTable().fields.map((field) =>
      field.id === "status"
        ? { id: "status", name: "結果", type: "select", options: ["success", "failure"] }
        : field,
    );
    const errors = expectInvalid(
      validateReferentialIntegrity(manifestWithHistory(fields as never)),
    );
    const error = errorAt(errors, "/app/workflows/0/history_table");
    expect(error.message).toContain("status");
    expect(error.message).toContain("select");
    expect(error.message).toContain("text");
  });

  test("`error` が text(long_text でない)でも拒否される", () => {
    const fields = conformingHistoryTable().fields.map((field) =>
      field.id === "error" ? { id: "error", name: "エラー", type: "text" } : field,
    );
    const errors = expectInvalid(
      validateReferentialIntegrity(manifestWithHistory(fields as never)),
    );
    expect(errorAt(errors, "/app/workflows/0/history_table").message).toContain("error");
  });

  test("規約外の列を**足す**のは許される(ADR-0013 §8c 問2 が add_field を認めている)", () => {
    const fields = [
      ...conformingHistoryTable().fields,
      { id: "record_ref", name: "対象", type: "reference", reference_table: "books" },
    ];
    const result = validateReferentialIntegrity(manifestWithHistory(fields as never));
    expect(result.valid).toBe(true);
  });

  test("列の並び順は問わない(規約は id と type の組であって順序ではない)", () => {
    const fields = [...conformingHistoryTable().fields].reverse();
    expect(validateReferentialIntegrity(manifestWithHistory(fields)).valid).toBe(true);
  });

  /**
   * **双方向の歯止め。**`referential-integrity.ts` の `WORKFLOW_HISTORY_FIELD_SPEC` は
   * `workflow-runner.ts` の `WORKFLOW_HISTORY_COLUMNS` を**import せずに写している**
   * (純粋な検証層が `bun:sqlite` を引く実行層に依存しないため)。
   * **写しである以上、乖離しうる。**ここで機械的に止める。
   */
  test("検査する列は WORKFLOW_HISTORY_COLUMNS と1つ残らず一致する", () => {
    const manifest = manifestWithHistory(conformingHistoryTable().fields);
    expect(validateReferentialIntegrity(manifest).valid).toBe(true);

    // 規約の5列を1つずつ落とすと、必ず拒否される(過不足なく検査していること)。
    for (const column of WORKFLOW_HISTORY_COLUMNS) {
      const fields = conformingHistoryTable().fields.filter((field) => field.id !== column);
      const result = validateReferentialIntegrity(manifestWithHistory(fields));
      expect(result.valid).toBe(false);
    }
    // 逆向き: 検査対象が5列ちょうどであること(検査が増えていたらここで気づく)。
    expect(WORKFLOW_HISTORY_COLUMNS).toHaveLength(conformingHistoryTable().fields.length);
  });

  test("history_table が実在しないときは列の検査を重ねない(カスケードさせない)", () => {
    const workflow = notifyWorkflow();
    workflow.history_table = "wf-runz";
    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(workflow)));
    // 「存在しません」の1件だけ。列不足のエラーを重ねない。
    expect(errors.filter((error) => error.path === "/app/workflows/0/history_table")).toHaveLength(
      1,
    );
  });

  // --------------------------------------------------------------------------
  // V1-M2-T05a 追補: `error` 列の required
  // --------------------------------------------------------------------------

  /**
   * **T05a 記録 §5-3 が自分で申告した穴を塞ぐ。**
   *
   * D1 は列の **id と type しか見ていない。**ところが:
   *
   * - `workflow-runner.ts:645` は成功時に `error: null` を**明示的に書く**
   * - `records.ts:365` の `isMissingValue` は `null` を required 違反として**弾く**
   *
   * したがって `error` 列に `required: true` を付けると、
   * **成功した実行の履歴だけが1行も残らなくなる。**しかも履歴の書き込みは
   * all-or-nothing なので、消えるのは1列ではなく**その実行の記録まるごと**である。
   * D1 が塞いだのと**同じ類型の沈黙**であり、D1 の検査は素通りする。
   *
   * **`error` 列だけを対象にする。**他の4列は常に非空の値が書かれる
   * (`ran_at` は時刻源、`workflow` は id、`trigger_type` と `status` はリテラル)ので、
   * `required: true` を付けても壊れない。**壊れないものまで拒否すると、
   * 正当なマニフェストを弾く新しい嘘になる。**下の「効きすぎていない」テストが
   * その逆向きを固定する(D1 の「規約外の列を足すのは許される」と同じ作法)。
   */
  test("`error` 列に required: true を付けると拒否される(成功の記録だけが消える形)", () => {
    const fields = conformingHistoryTable().fields.map((field) =>
      field.id === "error" ? { ...field, required: true } : field,
    );
    const errors = expectInvalid(
      validateReferentialIntegrity(manifestWithHistory(fields as never)),
    );
    const error = errorAt(errors, "/app/workflows/0/history_table");

    expect(error.message).toContain("error");
    expect(error.message).toContain("required");
    // **理由を書くこと。**AI がこれを読んで直せなければ検査を足した意味が無い。
    expect(error.message).toContain("成功");
    expect(error.hint).toBeDefined();
    expect(error.hint).toContain("required");
  });

  /**
   * **効きすぎていないことの逆向きの固定。**
   * `error` 以外の4列は常に非空の値が書かれるので、`required: true` は壊さない。
   */
  test("`error` 以外の4列に required: true を付けても通る(効きすぎていないこと)", () => {
    for (const column of ["ran_at", "workflow", "trigger_type", "status"]) {
      const fields = conformingHistoryTable().fields.map((field) =>
        field.id === column ? { ...field, required: true } : field,
      );
      const result = validateReferentialIntegrity(manifestWithHistory(fields as never));
      expect({ column, valid: result.valid }).toEqual({ column, valid: true });
    }
  });

  /** 4列すべてに同時に付けても通る(組み合わせでも効きすぎない)。 */
  test("`error` 以外の4列すべてに required: true を付けても通る", () => {
    const fields = conformingHistoryTable().fields.map((field) =>
      field.id === "error" ? field : { ...field, required: true },
    );
    expect(validateReferentialIntegrity(manifestWithHistory(fields as never)).valid).toBe(true);
  });

  /** `required: false` や未指定は当然通る(既定は required でない)。 */
  test("`error` 列の required が false / 未指定なら通る", () => {
    const explicitFalse = conformingHistoryTable().fields.map((field) =>
      field.id === "error" ? { ...field, required: false } : field,
    );
    expect(validateReferentialIntegrity(manifestWithHistory(explicitFalse as never)).valid).toBe(
      true,
    );
    expect(
      validateReferentialIntegrity(manifestWithHistory(conformingHistoryTable().fields)).valid,
    ).toBe(true);
  });
});

// ============================================================================
// V2-M3-T01: EC-G5 条件分岐(when)の適用時検査(ADR-0036。類型11)
// ============================================================================

describe("EC-G5 条件分岐(when)の適用時検査", () => {
  /** create_record アクションに `when` を差し込んだ通知ワークフロー。 */
  function notifyWorkflowWithWhen(when: {
    field: string;
    equals: string | number | boolean;
  }): Workflow {
    const workflow = notifyWorkflow();
    const action = mutableAction(workflow.actions[0]);
    action.when = when;
    return workflow;
  }

  test("when.field がトリガー元テーブルに実在すれば通る", () => {
    // books は `title` を持つ。
    const workflow = notifyWorkflowWithWhen({ field: "title", equals: "完了" });
    expect(validateReferentialIntegrity(manifestWith(workflow)).valid).toBe(true);
  });

  test("when 無しのワークフローは従来どおり通る(後方互換)", () => {
    expect(validateReferentialIntegrity(manifestWith(notifyWorkflow())).valid).toBe(true);
  });

  test("when.field がトリガー元テーブルに存在しないと apply 時に拒否される", () => {
    const workflow = notifyWorkflowWithWhen({ field: "nope", equals: "x" });
    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(workflow)));
    const error = errorAt(errors, "/app/workflows/0/actions/0/when/field");
    expect(error.message).toContain("nope");
    expect(error.message).toContain("存在しません");
    // 実在するフィールドの候補が提示される(1往復で直せる)。
    expect(error.allowed_values).toContain("title");
    expect(error.hint).toBeDefined();
  });

  test("schedule トリガー × when は fail-closed(レコード源が無いので解決不能)", () => {
    const workflow = scheduledWorkflow();
    const action = mutableAction(workflow.actions[0]);
    action.when = { field: "title", equals: "x" };
    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(workflow)));
    const error = errorAt(errors, "/app/workflows/0/actions/0/when");
    expect(error.message).toContain("schedule");
    expect(error.message).toContain("解決できません");
    expect(error.hint).toBeDefined();
  });

  test("apply_diff の実経路でも、存在しないフィールドを指す when は拒否される", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "gp-when-ri-"));
    const store = KernelMetaStore.open(dataRoot);
    const APP_ID = "book-tracker";
    try {
      createApp(store, "蔵書管理", { app_id: APP_ID });
      const applied = applyManifest(dataRoot, APP_ID, baseManifest());
      if (!applied.valid) {
        throw new Error(`前提の投入に失敗: ${JSON.stringify(applied.errors)}`);
      }

      // 存在しないフィールド "nope" を指す when を持つワークフローを足す。
      const badWorkflow: Workflow = {
        id: "notify",
        name: "通知",
        trigger: { type: "on_create", table: "books" },
        actions: [
          {
            action: "create_record",
            table: "notifications",
            values: { title: "x" },
            when: { field: "nope", equals: "y" },
          },
        ],
        history_table: "wf-runs",
      };
      const result = applyDiff(dataRoot, APP_ID, {
        diff_id: "d-bad-when",
        intent: "存在しない列を条件にする",
        operations: [{ op: "add_workflow", workflow: badWorkflow }],
      });
      // 実経路(畳み込み + 永続化 + 参照整合性)を通して拒否される。
      expect(result.valid).toBe(false);
    } finally {
      store.close();
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// V3-M10-T01(`D-G16a`。ADR-0063)—— `schedule` × `trigger.table` の適用時検査
//
// **`D-G16a` が変えたのは「拒否するか否かの分岐条件」だけであり、拒否そのものを
// 1本も消していない。**変わったのは次の2類型である(ADR-0063 §Decision 1 の層別表):
//
// | 類型 | `table` の無い schedule(今日どおり) | `table` の在る schedule(新設) |
// |---|---|---|
// | **類型7**(`$record.`) | `values` / `payload` / `target` の `$record.` を拒否 | **許す**(行がトリガー元になる) |
// | **類型11**(`when`) | 拒否 | **許す**(`when.field` の実在は検査する) |
//
// **残るもの**(`table` の有無によらず schedule では拒否し続けるもの):
// `ai_transform`(類型7 の 0.)/ `run_function` の `write_back`(同 run_function 分岐)。
// どちらも実行層が `trigger.type === "schedule"` で fail-closed するので、
// 許すと「valid なのに永久に動かないワークフロー」ができる —— 類型7 の趣旨そのものである。
// ============================================================================

/** `trigger.table` を持つ `schedule` ワークフロー(`D-G16a`)。 */
function scheduledOverRows(): Workflow {
  return {
    id: "daily-sweep",
    name: "毎朝9時に本を1件ずつ処理する",
    trigger: { type: "schedule", at: { hour: 9, minute: 0 }, table: "books" },
    actions: [
      {
        action: "create_record",
        table: "notifications",
        values: { title: "$record.title", source: "定時実行" },
      },
    ],
    history_table: "wf-runs",
  };
}

describe("V3-M10-T01 / ADR-0063: schedule の trigger.table(類型6)", () => {
  test("trigger.table が実在すれば受理される", () => {
    expect(validateReferentialIntegrity(manifestWith(scheduledOverRows()))).toEqual({
      valid: true,
    });
  });

  test("trigger.table が存在しないテーブルを指すと拒否される(類型6 が schedule にも当たる)", () => {
    const workflow = scheduledOverRows();
    workflow.trigger = { type: "schedule", at: { hour: 9, minute: 0 }, table: "bookz" };

    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(workflow)));
    const error = errorAt(errors, "/app/workflows/0/trigger/table");
    expect(error.message).toContain("bookz");
    expect(error.message).toContain("存在しません");
    expect(error.allowed_values).toBeDefined();
  });

  test("table の無い schedule は今日どおり trigger.table の不在で拒否されない(非退行)", () => {
    expect(validateReferentialIntegrity(manifestWith(scheduledWorkflow()))).toEqual({
      valid: true,
    });
  });
});

describe("V3-M10-T01 / ADR-0063: 類型7 は trigger.table の有無で分岐する", () => {
  test("table が在れば values の $record.<フィールド> が許される", () => {
    expect(validateReferentialIntegrity(manifestWith(scheduledOverRows()))).toEqual({
      valid: true,
    });
  });

  test("table が無ければ今日どおり拒否される(非退行)", () => {
    const workflow = scheduledWorkflow();
    const action = mutableAction(workflow.actions[0]);
    action.values = { title: "$record.title", source: "定時実行" };

    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(workflow)));
    expect(errorAt(errors, "/app/workflows/0/actions/0/values/title").message).toContain(
      "schedule",
    );
  });

  test("table が在っても、トリガー元テーブルに無いフィールドを指す $record. は型検査に落ちない(射程外)", () => {
    // **ADR-0029 の射程を広げない。**`$record.<不在列>` は静的に型が確定しないので
    // 類型10 は素通りさせる(実行時に fail-closed する)。**ここは今日と同じ扱いである。**
    const workflow = scheduledOverRows();
    const action = mutableAction(workflow.actions[0]);
    action.values = { title: "$record.nope", source: "定時実行" };

    expect(validateReferentialIntegrity(manifestWith(workflow))).toEqual({ valid: true });
  });

  test("table が在るとき、類型10(型整合)がトリガー元テーブルの列型を見るようになる", () => {
    const manifest = manifestWith(scheduledOverRows());
    // `books` に number 列を足し、それを text 列 `title` に書こうとする。
    manifest.app.tables[0]?.fields.push({ id: "pages", name: "ページ数", type: "number" });
    const workflow = manifest.app.workflows?.[0];
    if (workflow === undefined) {
      throw new Error("fixture broken");
    }
    const action = mutableAction(workflow.actions[0]);
    action.values = { title: "$record.pages", source: "定時実行" };

    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const message = errorAt(errors, "/app/workflows/0/actions/0/values/title").message;
    expect(message).toContain("$record.pages");
    expect(message).toContain("数値型");
  });

  test("table が在っても ai_transform は拒否され続ける(実行層が schedule で fail-closed するため)", () => {
    const workflow = scheduledOverRows();
    workflow.actions = [
      {
        action: "ai_transform",
        capability: "summarizer",
        prompt: "要約して",
        input: { title: "$record.title" },
        output_field: "title",
        fallback: "skip",
      },
    ];

    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(workflow)));
    expect(errorAt(errors, "/app/workflows/0/actions/0/action").message).toContain("ai_transform");
  });

  test("table が在っても run_function の write_back は拒否され続ける", () => {
    const manifest = manifestWith(scheduledOverRows());
    const workflow = manifest.app.workflows?.[0];
    if (workflow === undefined) {
      throw new Error("fixture broken");
    }
    workflow.actions = [{ action: "run_function", function: "calc", write_back: "$record" }];
    manifest.app.functions = [
      {
        id: "calc",
        name: "計算",
        input: { source: "table", table: "books" },
        code: "export default function () { return []; }",
        output: { fields: [{ id: "title", type: "text" }] },
      },
    ];

    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    expect(errorAt(errors, "/app/workflows/0/actions/0/write_back").message).toContain(
      "write_back",
    );
  });

  test("table が在るとき、update_record の target `$record.<非 reference 列>` は類型13 が拒否する", () => {
    const workflow = scheduledOverRows();
    workflow.actions = [
      {
        action: "update_record",
        table: "notifications",
        target: "$record.title",
        values: { source: "定時実行" },
      },
    ];

    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(workflow)));
    expect(errorAt(errors, "/app/workflows/0/actions/0/target").message).toContain("reference");
  });
});

describe("V3-M10-T01 / ADR-0063: 類型11(when)は trigger.table の有無で分岐する", () => {
  test("table が在れば when を書ける(when の形は1バイトも変わっていない)", () => {
    const workflow = scheduledOverRows();
    const action = mutableAction(workflow.actions[0]);
    action.when = { field: "title", equals: "対象" };

    expect(validateReferentialIntegrity(manifestWith(workflow))).toEqual({ valid: true });
  });

  test("table が在るとき、when.field の実在は検査される(類型11 の 2 がそのまま効く)", () => {
    const workflow = scheduledOverRows();
    const action = mutableAction(workflow.actions[0]);
    action.when = { field: "nope", equals: "対象" };

    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(workflow)));
    const error = errorAt(errors, "/app/workflows/0/actions/0/when/field");
    expect(error.message).toContain("nope");
    expect(error.allowed_values).toEqual(["title"]);
  });

  test("table が無ければ when は今日どおり拒否される(非退行)", () => {
    const workflow = scheduledWorkflow();
    const action = mutableAction(workflow.actions[0]);
    action.when = { field: "title", equals: "対象" };

    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(workflow)));
    expect(errorAt(errors, "/app/workflows/0/actions/0/when").message).toContain("schedule");
  });
});

// ============================================================================
// V3-M10-T02(`D-G16b`。ADR-0064)—— `trigger.older_than` の適用時検査(類型16)
//
// **`ADR-0064` 限定5 が課した3つを apply 時に倒す**:
//
// 1. `table` の無い `schedule` に `older_than` を書いた定義を拒否する。
// 2. `older_than.field` が `trigger.table` に**実在する**こと。
// 3. その `field` が **`date` 型**であること。
//
// **既存の拒否を1本も消していない** —— 類型16 は新設であり、`older_than` を書かない
// 定義は今日と1バイトも変わらない(下の非退行検査が固定する)。
// ============================================================================

/** `orders`(`date` 型の `placed_on` と、`date` でない列)を足したマニフェスト。 */
function olderThanManifest(workflow: Workflow): Manifest {
  const manifest = manifestWith(workflow);
  manifest.app.tables.push({
    id: "orders",
    name: "注文",
    fields: [
      { id: "placed_on", name: "注文日", type: "date" },
      { id: "settled_on", name: "確定日", type: "date" },
      { id: "status", name: "状態", type: "text" },
      { id: "amount", name: "金額", type: "number" },
    ],
  });
  return manifest;
}

/** `older_than` を持つ `schedule` ワークフロー(`D-G16b` の正常形)。 */
function sweepOlderThan(
  older: { field: string; days: number } = { field: "placed_on", days: 3 },
): Workflow {
  return {
    id: "stale-order-sweep",
    name: "3日以上滞留した注文を毎朝9時に処理する",
    trigger: {
      type: "schedule",
      at: { hour: 9, minute: 0 },
      table: "orders",
      older_than: older,
    },
    actions: [
      {
        action: "create_record",
        table: "notifications",
        values: { title: "$record.status", source: "sweep" },
        when: { field: "status", equals: "pending_payment" },
      },
    ],
    history_table: "wf-runs",
  };
}

describe("V3-M10-T02 / ADR-0064 限定5: 類型16(trigger.older_than)", () => {
  test("date 型の実在フィールドを指していれば受理される", () => {
    expect(validateReferentialIntegrity(olderThanManifest(sweepOlderThan()))).toEqual({
      valid: true,
    });
  });

  test("実在しないフィールドを指すと拒否される(allowed_values が付く)", () => {
    const errors = expectInvalid(
      validateReferentialIntegrity(olderThanManifest(sweepOlderThan({ field: "placed", days: 3 }))),
    );
    const error = errorAt(errors, "/app/workflows/0/trigger/older_than/field");
    expect(error.message).toContain("placed");
    expect(error.message).toContain("orders");
    // **候補は `date` 型のフィールドだけ**である(text を勧めると次の往復でまた倒れる)。
    expect(error.allowed_values).toEqual(["placed_on", "settled_on"]);
  });

  test("date 型でないフィールドを指すと拒否される(text / number)", () => {
    for (const field of ["status", "amount"]) {
      const errors = expectInvalid(
        validateReferentialIntegrity(olderThanManifest(sweepOlderThan({ field, days: 3 }))),
      );
      const error = errorAt(errors, "/app/workflows/0/trigger/older_than/field");
      expect(error.message).toContain("date");
      expect(error.allowed_values).toEqual(["placed_on", "settled_on"]);
    }
  });

  test("table の無い schedule に older_than を書くと拒否される(ADR-0063 に完全従属する)", () => {
    const workflow = sweepOlderThan();
    workflow.trigger = {
      type: "schedule",
      at: { hour: 9, minute: 0 },
      older_than: { field: "placed_on", days: 3 },
    };
    // `when` は table 無し schedule では類型11 が倒すので、ここでは外して older_than だけを見る。
    const action = mutableAction(workflow.actions[0]);
    delete action.when;
    action.values = { title: "本日のまとめ", source: "定時実行" };

    const errors = expectInvalid(validateReferentialIntegrity(olderThanManifest(workflow)));
    const error = errorAt(errors, "/app/workflows/0/trigger/older_than");
    expect(error.message).toContain("table");
    expect(error.hint).toContain("table");
  });

  test("trigger.table が実在しないときは二重報告しない(類型6 だけが出る)", () => {
    const workflow = sweepOlderThan();
    workflow.trigger = {
      type: "schedule",
      at: { hour: 9, minute: 0 },
      table: "orderz",
      older_than: { field: "placed_on", days: 3 },
    };

    const errors = expectInvalid(validateReferentialIntegrity(olderThanManifest(workflow)));
    expect(errors.filter((e) => e.path.startsWith("/app/workflows/0/trigger/older_than"))).toEqual(
      [],
    );
    expect(errorAt(errors, "/app/workflows/0/trigger/table")).toBeDefined();
  });

  test("非退行: older_than を書かない schedule / on_create は今日どおり受理される", () => {
    expect(validateReferentialIntegrity(manifestWith(scheduledWorkflow()))).toEqual({
      valid: true,
    });
    expect(validateReferentialIntegrity(manifestWith(notifyWorkflow()))).toEqual({ valid: true });
    expect(validateReferentialIntegrity(manifestWith(scheduledOverRows()))).toEqual({
      valid: true,
    });
  });

  test("older_than と when は独立に検査される(2層の合成であって1つの述語ではない)", () => {
    // `when.field` が実在しない × `older_than.field` が実在しない → **2件とも報告する**。
    const workflow = sweepOlderThan({ field: "nope", days: 3 });
    mutableAction(workflow.actions[0]).when = { field: "nostatus", equals: "x" };

    const errors = expectInvalid(validateReferentialIntegrity(olderThanManifest(workflow)));
    expect(errorAt(errors, "/app/workflows/0/trigger/older_than/field")).toBeDefined();
    expect(errorAt(errors, "/app/workflows/0/actions/0/when/field")).toBeDefined();
  });
});
