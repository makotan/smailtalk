import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ValidationError, ValidationResult } from "./errors.ts";
import { DIFF_OPS, RESOURCE_KINDS } from "./types.ts";
import { validateDiff, validateManifest } from "./validate.ts";

/**
 * ワークフロー語彙(ADR-0013 / V1-M2-T07 第1段階)の型とスキーマの検査。
 *
 * `validate.test.ts` と同じ作法で、**正準スキーマ(`schemas/*.schema.json`)そのもの**を
 * 読んで構造を固定する検査と、`validateManifest` / `validateDiff` を通した挙動の検査を
 * 併せて置く。前者が無いと、`$defs` を1つ足しても誰も気づかない。
 */
function canonicalSchema(file: string): Any {
  return JSON.parse(
    readFileSync(join(import.meta.dir, "..", "..", "schemas", file), "utf-8"),
  ) as Any;
}

/** テスト用: 失敗であることを確認しつつ errors を取り出す。 */
function expectInvalid(result: ValidationResult): ValidationError[] {
  expect(result.valid).toBe(false);
  if (result.valid) {
    throw new Error("expected invalid");
  }
  return result.errors;
}

/** 深いコピー(サンプルを壊さずに異常系を作るため)。 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// biome-ignore lint/suspicious/noExplicitAny: テストで意図的に不正な構造を組み立てるため
type Any = any;

/**
 * ADR-0013 §1 のサンプル(蔵書管理に通知ワークフローを1本足したもの)。
 *
 * 出力先 `notifications` と実行履歴 `workflow-runs` は**ユーザ(AI)が add_table で作る**
 * 通常のテーブルである(限定8: カーネルはテーブルを1つも自動生成しない)。
 */
const workflowManifest = {
  app: {
    id: "book-tracker",
    name: "蔵書管理",
    tables: [
      {
        id: "books",
        name: "書籍",
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
        id: "workflow-runs",
        name: "実行履歴",
        fields: [{ id: "result", name: "結果", type: "text" }],
      },
    ],
    views: [{ id: "book-list", type: "list_view", table: "books", columns: ["title"] }],
    workflows: [
      {
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
        history_table: "workflow-runs",
      },
    ],
  },
};

/** ワークフロー1本を差し替えたマニフェストを作る。 */
function withWorkflow(mutate: (workflow: Any) => void): Any {
  const manifest = clone(workflowManifest) as Any;
  mutate(manifest.app.workflows[0]);
  return manifest;
}

describe("語彙の定数(ADR-0013 §1 / 限定1・限定2)", () => {
  test("RESOURCE_KINDS は7種で、末尾が function である(ADR-0024 が7種目を足した)", () => {
    expect([...RESOURCE_KINDS]).toEqual([
      "app",
      "table",
      "form",
      "list_view",
      "detail_view",
      "workflow",
      "function",
      // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】8種目 `report_view`
      // (集計表)を足した。****テスト名は1バイトも書き換えていない** —— **この test が
      // 固定しているのは「**`ADR-0024` の決定**が7種目 `function` を足し、その位置と順序が
      // 動いていないこと」であり、その主張は1ミリも弱めていない**(`function` は今日も
      // 7番目である)。**8種目を足したのは別の決定である。**
      "report_view",
    ]);
  });

  // 【`V5-M29-T04` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
  //   消したテスト名(逐語): 「DIFF_OPS は17種で、既存16種の順序が1バイトも変わっていない(ADR-0248 が set_user_kinds を足した)」
  //   そのブロックが測っていたもの:
  //     - DIFF_OPS の17種が、名前も順序も一致する(`toEqual([...])` の B 形)
  //   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `DIFF_OPS:` で始まる行)。
  //   **中央が名前を順序ごと比べていることは、消す前に実測して確かめた** —— 一覧の
  //   `DIFF_OPS:` の17行は、ここにあった配列と**同じ名前・同じ順序**である。
  //   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
  //   検出力0のまま `Ran` を水増しする)。
  //   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。
  //   **なお、直前の行にあった `V5-M17b` / `ADR-0248` の旧テスト名の記録(逐語)も一緒に消えた。**

  test("op_name の enum は DIFF_OPS と1対1・同順である", () => {
    const opName = canonicalSchema("diff.schema.json").$defs.op_name as Any;
    expect(opName.enum).toEqual([...DIFF_OPS]);
  });
});

describe("マニフェストのワークフロー / 正常系", () => {
  test("workflows を持つマニフェストが通過する", () => {
    expect(validateManifest(workflowManifest)).toEqual({ valid: true });
  });

  test("workflows を持たないマニフェストも依然として通過する(後方互換。ADR §1)", () => {
    const manifest = clone(workflowManifest) as Any;
    delete manifest.app.workflows;
    expect(validateManifest(manifest)).toEqual({ valid: true });
  });

  test("workflows が空配列でも通過する", () => {
    const manifest = clone(workflowManifest) as Any;
    manifest.app.workflows = [];
    expect(validateManifest(manifest)).toEqual({ valid: true });
  });

  test("$defs/app.required に workflows は入っていない", () => {
    const app = canonicalSchema("manifest.schema.json").$defs.app as Any;
    expect(app.required).toEqual(["id", "name", "tables", "views"]);
    expect(app.properties.workflows).toBeDefined();
  });

  test("トリガー3種(on_create / on_update / schedule)がそれぞれ通過する", () => {
    expect(
      validateManifest(
        withWorkflow((w) => {
          w.trigger = { type: "on_create", table: "books" };
        }),
      ),
    ).toEqual({ valid: true });
    expect(
      validateManifest(
        withWorkflow((w) => {
          w.trigger = { type: "on_update", table: "books" };
        }),
      ),
    ).toEqual({ valid: true });
    expect(
      validateManifest(
        withWorkflow((w) => {
          w.trigger = { type: "schedule", at: { hour: 9, minute: 0 } };
        }),
      ),
    ).toEqual({ valid: true });
  });

  test("アクション2種(create_record / update_record)がそれぞれ通過する", () => {
    expect(
      validateManifest(
        withWorkflow((w) => {
          w.actions = [
            { action: "create_record", table: "notifications", values: { title: "できた" } },
          ];
        }),
      ),
    ).toEqual({ valid: true });
    expect(
      validateManifest(
        withWorkflow((w) => {
          w.actions = [
            {
              action: "update_record",
              table: "notifications",
              target: "$record._id",
              values: { title: "更新した" },
            },
          ];
        }),
      ),
    ).toEqual({ valid: true });
  });

  test("アクション call_external が通過する(ADR-0020 §3。V1-M4-T03)", () => {
    expect(
      validateManifest(
        withWorkflow((w) => {
          w.actions = [
            {
              action: "call_external",
              connection: "api",
              destination: "https://api.example.com/v1/messages",
              payload: { title: "$record.title", body: "固定文" },
            },
          ];
        }),
      ),
    ).toEqual({ valid: true });
  });

  test("action enum は5種になった(create/update/call_external/ai_transform/run_function)", () => {
    // **run_function は ADR-0024(V1-M6-T05 第2段)で足した5種目**である。
    // capability 必須ではなく、関数リソースを起動する内部アクション(ADR-0024 §増分表)。
    const action = canonicalSchema("manifest.schema.json").$defs.workflow_action as Any;
    expect(action.properties.action.enum).toEqual([
      "create_record",
      "update_record",
      "call_external",
      "ai_transform",
      "run_function",
    ]);
  });

  test("call_external に table を書くと拒否する(宛先は connection のスコープで表す)", () => {
    expectInvalid(
      validateManifest(
        withWorkflow((w) => {
          w.actions = [
            {
              action: "call_external",
              connection: "api",
              destination: "https://api.example.com",
              payload: {},
              table: "notifications",
            },
          ];
        }),
      ),
    );
  });

  test("call_external に connection / destination / payload が無いと拒否する", () => {
    for (const missing of ["connection", "destination", "payload"]) {
      const base: Any = {
        action: "call_external",
        connection: "api",
        destination: "https://api.example.com",
        payload: {},
      };
      delete base[missing];
      expectInvalid(
        validateManifest(
          withWorkflow((w) => {
            w.actions = [base];
          }),
        ),
      );
    }
  });

  test("call_external の payload の値に式を書くと拒否する(限定7)", () => {
    expectInvalid(
      validateManifest(
        withWorkflow((w) => {
          w.actions = [
            {
              action: "call_external",
              connection: "api",
              destination: "https://api.example.com",
              payload: { x: "$record.foo + 1" },
            },
          ];
        }),
      ),
    );
  });

  test("ai_transform は capability / prompt / input / output_field / fallback で通過する", () => {
    expect(
      validateManifest(
        withWorkflow((w) => {
          w.actions = [
            {
              action: "ai_transform",
              capability: "classifier",
              prompt: "分類して",
              input: { text: "$record.title" },
              output_field: "category",
              fallback: "question",
            },
          ];
        }),
      ),
    ).toEqual({ valid: true });
  });

  test("ai_transform に table / values を書くと拒否する(書き戻し先は output_field)", () => {
    expectInvalid(
      validateManifest(
        withWorkflow((w) => {
          w.actions = [
            {
              action: "ai_transform",
              capability: "classifier",
              prompt: "分類して",
              input: {},
              output_field: "category",
              fallback: "question",
              table: "notifications",
            },
          ];
        }),
      ),
    );
  });

  test("ai_transform に必須キーが無いと拒否する", () => {
    for (const missing of ["capability", "prompt", "input", "output_field", "fallback"]) {
      const base: Any = {
        action: "ai_transform",
        capability: "classifier",
        prompt: "分類して",
        input: {},
        output_field: "category",
        fallback: "question",
      };
      delete base[missing];
      expectInvalid(
        validateManifest(
          withWorkflow((w) => {
            w.actions = [base];
          }),
        ),
      );
    }
  });

  test("create_record / update_record は依然として通過する(call_external 追加で壊れない)", () => {
    expect(
      validateManifest(
        withWorkflow((w) => {
          w.actions = [
            { action: "create_record", table: "notifications", values: { title: "できた" } },
          ];
        }),
      ),
    ).toEqual({ valid: true });
    expect(
      validateManifest(
        withWorkflow((w) => {
          w.actions = [
            {
              action: "update_record",
              table: "notifications",
              target: "$record._id",
              values: { title: "更新した" },
            },
          ];
        }),
      ),
    ).toEqual({ valid: true });
  });

  test("values の値はリテラル文字列と $record.<フィールドID> の両方を書ける(限定12)", () => {
    expect(
      validateManifest(
        withWorkflow((w) => {
          w.actions[0].values = {
            title: "新しい本",
            source: "$record._id",
            memo: "$record.title",
          };
        }),
      ),
    ).toEqual({ valid: true });
  });

  test("schedule.at の境界値(0:0 と 23:59)が通過する", () => {
    for (const at of [
      { hour: 0, minute: 0 },
      { hour: 23, minute: 59 },
    ]) {
      expect(
        validateManifest(
          withWorkflow((w) => {
            w.trigger = { type: "schedule", at };
          }),
        ),
      ).toEqual({ valid: true });
    }
  });
});

describe("マニフェストのワークフロー / 異常系", () => {
  test("trigger.type が語彙外なら拒否する", () => {
    const errors = expectInvalid(
      validateManifest(
        withWorkflow((w) => {
          w.trigger = { type: "on_delete", table: "books" };
        }),
      ),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  test("on_create に at を書くと拒否する", () => {
    expectInvalid(
      validateManifest(
        withWorkflow((w) => {
          w.trigger = { type: "on_create", table: "books", at: { hour: 9, minute: 0 } };
        }),
      ),
    );
  });

  test("on_update に at を書くと拒否する", () => {
    expectInvalid(
      validateManifest(
        withWorkflow((w) => {
          w.trigger = { type: "on_update", table: "books", at: { hour: 9, minute: 0 } };
        }),
      ),
    );
  });

  /*
   * 【V3-M10-T01 / `D-G16a` / ADR-0063】**この検査の期待値を反転させた。検査は消していない。**
   *
   * - **更新前**: `test("schedule に table を書くと拒否する", ...)` —— 中身は
   *   `expectInvalid(validateManifest(withWorkflow(w => { w.trigger = { type:"schedule", at:{hour:9,minute:0}, table:"books" }; })))`。
   * - **更新後**: 下の `valid: true`。
   *
   * 反転の根拠は `docs/adr/0063-schedule-row-selection.md` §Decision 1(`allOf` の
   * schedule 分岐から `"table": false` を外す)である。**`skip` 化・削除・条件の緩和では
   * なく、同じ入力に対する期待値そのものを差し替えた** —— schedule に `table` を書いた
   * マニフェストが受理されることが、まさに `D-G16a` の実装の中身だからである。
   */
  test("schedule に table を書ける(D-G16a / ADR-0063。対象表の行を発火の対象にする)", () => {
    expect(
      validateManifest(
        withWorkflow((w) => {
          w.trigger = { type: "schedule", at: { hour: 9, minute: 0 }, table: "books" };
        }),
      ),
    ).toEqual({ valid: true });
  });

  test("schedule の trigger.table にシステムテーブルは書けない(ADR-0063 限定3)", () => {
    // `$defs/resource_id` の pattern(`^[a-z][a-z0-9_-]*$`)が `_` 始まりを弾く ——
    // **`ADR-0013` 限定10 の機械的な担保をそのまま継承している**(新しい検査を作っていない)。
    for (const systemTable of ["_apps", "_changelog", "_ai_usage"]) {
      expectInvalid(
        validateManifest(
          withWorkflow((w) => {
            w.trigger = { type: "schedule", at: { hour: 9, minute: 0 }, table: systemTable };
          }),
        ),
      );
    }
  });

  test("schedule に at が無ければ table があっても拒否する(at は依然必須)", () => {
    expectInvalid(
      validateManifest(
        withWorkflow((w) => {
          w.trigger = { type: "schedule", table: "books" };
        }),
      ),
    );
  });

  test("on_create に table が無いと拒否する", () => {
    expectInvalid(
      validateManifest(
        withWorkflow((w) => {
          w.trigger = { type: "on_create" };
        }),
      ),
    );
  });

  test("schedule に at が無いと拒否する", () => {
    expectInvalid(
      validateManifest(
        withWorkflow((w) => {
          w.trigger = { type: "schedule" };
        }),
      ),
    );
  });

  test("schedule.at.hour が 24 なら拒否する", () => {
    expectInvalid(
      validateManifest(
        withWorkflow((w) => {
          w.trigger = { type: "schedule", at: { hour: 24, minute: 0 } };
        }),
      ),
    );
  });

  test("schedule.at.minute が 60 なら拒否する", () => {
    expectInvalid(
      validateManifest(
        withWorkflow((w) => {
          w.trigger = { type: "schedule", at: { hour: 9, minute: 60 } };
        }),
      ),
    );
  });

  test("schedule.at に cron 式のような文字列は書けない(限定6 / ADR §6b)", () => {
    expectInvalid(
      validateManifest(
        withWorkflow((w) => {
          w.trigger = { type: "schedule", at: "0 9 * * *" };
        }),
      ),
    );
  });

  test("schedule.at に曜日指定を足すと拒否する(限定6)", () => {
    expectInvalid(
      validateManifest(
        withWorkflow((w) => {
          w.trigger = { type: "schedule", at: { hour: 9, minute: 0, weekday: "mon" } };
        }),
      ),
    );
  });

  test("create_record に target を書くと拒否する", () => {
    expectInvalid(
      validateManifest(
        withWorkflow((w) => {
          w.actions = [
            {
              action: "create_record",
              table: "notifications",
              target: "$record._id",
              values: { title: "だめ" },
            },
          ];
        }),
      ),
    );
  });

  test("update_record に target が無いと拒否する", () => {
    expectInvalid(
      validateManifest(
        withWorkflow((w) => {
          w.actions = [
            { action: "update_record", table: "notifications", values: { title: "だめ" } },
          ];
        }),
      ),
    );
  });

  test("action が語彙外なら拒否する(delete_record は足していない。限定5)", () => {
    expectInvalid(
      validateManifest(
        withWorkflow((w) => {
          w.actions = [{ action: "delete_record", table: "notifications", values: {} }];
        }),
      ),
    );
  });

  test("actions が空配列なら拒否する", () => {
    expectInvalid(
      validateManifest(
        withWorkflow((w) => {
          w.actions = [];
        }),
      ),
    );
  });

  test("trigger.table にシステムテーブル _apps を書くと拒否する(限定10)", () => {
    expectInvalid(
      validateManifest(
        withWorkflow((w) => {
          w.trigger = { type: "on_create", table: "_apps" };
        }),
      ),
    );
  });

  test("trigger.table に _changelog を書くと拒否する(限定10)", () => {
    expectInvalid(
      validateManifest(
        withWorkflow((w) => {
          w.trigger = { type: "on_update", table: "_changelog" };
        }),
      ),
    );
  });

  test("actions[].table にシステムテーブルを書くと拒否する(限定10)", () => {
    expectInvalid(
      validateManifest(
        withWorkflow((w) => {
          w.actions[0].table = "_changelog";
        }),
      ),
    );
  });

  test("history_table にシステムテーブルを書くと拒否する(限定10)", () => {
    expectInvalid(
      validateManifest(
        withWorkflow((w) => {
          w.history_table = "_apps";
        }),
      ),
    );
  });

  test("values に式を書くと拒否する(限定12: 演算子・関数・連結を足さない)", () => {
    for (const expression of [
      "$record.foo + 1",
      "$record.foo == 1",
      "$now()",
      "$record.foo $record.bar",
      "$RECORD.foo",
      "$record.",
      "$record",
    ]) {
      expectInvalid(
        validateManifest(
          withWorkflow((w) => {
            w.actions[0].values = { title: expression };
          }),
        ),
      );
    }
  });

  test("target に式を書くと拒否する(限定12)", () => {
    expectInvalid(
      validateManifest(
        withWorkflow((w) => {
          w.actions = [
            {
              action: "update_record",
              table: "notifications",
              target: "$record.foo + 1",
              values: { title: "だめ" },
            },
          ];
        }),
      ),
    );
  });

  test("workflow に未知キーを足すと拒否する", () => {
    expectInvalid(
      validateManifest(
        withWorkflow((w) => {
          w.enabled = true;
        }),
      ),
    );
  });

  test("workflow に history_table が無いと拒否する", () => {
    expectInvalid(
      validateManifest(
        withWorkflow((w) => {
          delete w.history_table;
        }),
      ),
    );
  });
});

describe("差分パッチのワークフロー op(ADR-0013 §4c)", () => {
  const workflow = workflowManifest.app.workflows[0];

  function diffWith(operation: Any): Any {
    return {
      diff_id: "d-0100",
      intent: "新しい本が登録されたら通知したい",
      operations: [operation],
    };
  }

  test("add_workflow の差分が通過する", () => {
    expect(validateDiff(diffWith({ op: "add_workflow", workflow: clone(workflow) }))).toEqual({
      valid: true,
    });
  });

  test("update_workflow の差分が通過する", () => {
    expect(validateDiff(diffWith({ op: "update_workflow", workflow: clone(workflow) }))).toEqual({
      valid: true,
    });
  });

  test("remove_workflow の差分が通過する", () => {
    expect(
      validateDiff(diffWith({ op: "remove_workflow", workflow: { id: "notify-on-new-book" } })),
    ).toEqual({ valid: true });
  });

  test("add_workflow に workflow が無いと拒否する", () => {
    expectInvalid(validateDiff(diffWith({ op: "add_workflow" })));
  });

  test("add_workflow に table を書くと拒否する", () => {
    expectInvalid(
      validateDiff({
        diff_id: "d-0100",
        intent: "だめな差分",
        operations: [{ op: "add_workflow", workflow: clone(workflow), table: "books" }],
      }),
    );
  });

  test("update_workflow / remove_workflow に view や changes を書くと拒否する", () => {
    expectInvalid(
      validateDiff(
        diffWith({ op: "update_workflow", workflow: clone(workflow), view: "book-list" }),
      ),
    );
    expectInvalid(
      validateDiff(
        diffWith({ op: "remove_workflow", workflow: { id: "notify-on-new-book" }, changes: {} }),
      ),
    );
  });

  test("remove_workflow の workflow に id 以外を書くと拒否する", () => {
    expectInvalid(
      validateDiff(
        diffWith({
          op: "remove_workflow",
          workflow: { id: "notify-on-new-book", name: "消す対象" },
        }),
      ),
    );
  });

  test("add_workflow の workflow が不正な定義なら拒否する", () => {
    const broken = clone(workflow) as Any;
    broken.trigger = { type: "on_delete", table: "books" };
    expectInvalid(validateDiff(diffWith({ op: "add_workflow", workflow: broken })));
  });

  test("既存9 op のいずれに workflow キーを書いても拒否する(全分岐の false 宣言)", () => {
    const bodies: Record<string, Any> = {
      add_table: { table: { id: "t", name: "T", fields: [{ id: "a", name: "A", type: "text" }] } },
      add_field: { table: "books", field: { id: "a", name: "A", type: "text" } },
      add_view: { view: { id: "v", type: "list_view", table: "books", columns: ["title"] } },
      update_view: { view: "book-list", changes: { name: "一覧" } },
      remove_field: { table: "books", field: "title" },
      remove_table: { table: "books" },
      change_table: { table: "books", changes: { name: "書籍" } },
      change_field: { table: "books", field: "title", changes: { name: "題名" } },
      remove_view: { view: "book-list" },
    };
    for (const [op, body] of Object.entries(bodies)) {
      // まず workflow キーを付けない形が通ることを確かめる(前提の健全性)。
      expect(validateDiff(diffWith({ op, ...body }))).toEqual({ valid: true });
      expectInvalid(validateDiff(diffWith({ op, ...body, workflow: clone(workflow) })));
    }
  });
});

describe("限定3 の新しい不変条件($defs/operation.properties は6キーで閉じる)", () => {
  const operation = canonicalSchema("diff.schema.json").$defs.operation as Any;

  // **【`V5-M17b` / `ADR-0248`】旧テスト名の逐語は「properties のキーはちょうど8つで、8キー目が theme である(ADR-0047 が足した)」。**
  // **【`V8-M16-T03` / `J-G1b` / `D-V8-31`】旧テスト名の逐語は「properties のキーはちょうど9つで、9キー目が user_kinds である(ADR-0248 が足した)」である。**
  // **10キー目 `roles` を足したので、名前と期待値を同時に実体へ合わせた。検査は消していない。**
  test("properties のキーはちょうど10で、10キー目が roles である(V8-M16 が足した)", () => {
    // ADR-0024 が7キー目 function を、**ADR-0047(V3-M1-T03)が8キー目 theme を**足した。
    expect(Object.keys(operation.properties)).toEqual([
      "op",
      "table",
      "field",
      "view",
      "changes",
      "workflow",
      "function",
      "theme",
      // **【`V5-M17b` / `ADR-0248` §4c】9キー目。**ここが10 になったら、それは門A を
      // 通らない増分が入った合図である(ADR-0248 限定4 / §3a 4)。
      // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】**
      // **旧(逐語)**: `"user_kinds",` —— キーごと撤去されたので期待値から1行外した(10 → 9)。
      // **テスト名の「ちょうど10」「10キー目」は当時の逐語である**(テスト名は書き換えない)。
      // **【`V8-M16-T03` / `J-G1b` / `D-V8-31`】10キー目。**直上の1行は制定時の文であり
      // 消していない —— **本件は門A の本審査(限定採用)を通したうえで足した増分である。**
      // ここが11 になったら、それは門A を通らない増分が入った合図である。
      "roles",
    ]);
  });

  test("allOf は op ごとに1分岐ずつあり、DIFF_OPS と1対1・同順に対応する", () => {
    const branchOps = (operation.allOf as Any[]).map((branch) => branch.if.properties.op.const);
    expect(branchOps).toEqual([...DIFF_OPS]);
  });

  test("allOf の各要素は if / then / else 以外のキーを持たない", () => {
    // ajv-error-adapter.ts の resolveAllowedProperties が「解釈できない分岐」として
    // 諦め、未知プロパティのエラーから allowed_values が消える(V1-M1-T03 で実際に踏んだ)。
    for (const branch of operation.allOf as Any[]) {
      for (const key of Object.keys(branch)) {
        expect(["if", "then", "else"]).toContain(key);
      }
    }
  });

  test("既存9分岐すべてに workflow: false が入っている", () => {
    const existing = [
      "add_table",
      "add_field",
      "add_view",
      "update_view",
      "remove_field",
      "remove_table",
      "change_table",
      "change_field",
      "remove_view",
    ];
    for (const op of existing) {
      const branch = (operation.allOf as Any[]).find(
        (each) => each.if.properties.op.const === op,
      ) as Any;
      expect(branch.then.properties.workflow).toBe(false);
    }
  });

  // **【`V5-M17b` / `ADR-0248`】旧テスト名の逐語は「ワークフロー3 op の分岐は workflow を必須にし、他4キーを禁止する」。**
  test("ワークフロー3 op の分岐は workflow を必須にし、他6キーを禁止する", () => {
    for (const op of ["add_workflow", "update_workflow", "remove_workflow"]) {
      const branch = (operation.allOf as Any[]).find(
        (each) => each.if.properties.op.const === op,
      ) as Any;
      expect(branch.then.required).toEqual(["workflow"]);
      const forbidden = Object.entries(branch.then.properties as Record<string, unknown>)
        .filter(([, sub]) => sub === false)
        .map(([name]) => name);
      // ADR-0024 が7キー目 function を足したので、ワークフロー3 op も function を禁止する。
      // **ADR-0047 が8キー目 theme を足したので、theme も禁止する**(§4c 問2)。
      // **【`V5-M17b` / `ADR-0248` §4c 問2】9キー目 `user_kinds` を全既存分岐で禁止した。**
      // **【`V8-M16-T03` / `J-G1b`】10キー目 `roles` を全既存17分岐で禁止したので、期待値に1件足した。検査は消していない。**
      // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】**
      // **旧(逐語)**: `expect(forbidden).toEqual(["table","field","view","changes","function","theme","user_kinds","roles"]);`
      // **`user_kinds` キーが消えたので、ワークフロー3分岐が禁じるのは7キーになった。**
      // **テスト名の「他6キー」は当時の逐語である**(テスト名は書き換えない)。
      expect(forbidden).toEqual([
        "table",
        "field",
        "view",
        "changes",
        "function",
        "theme",
        "roles",
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// V1-M2-T05e D2-a: 置換されると誤解しやすい記法(口ひげ記法)を適用時に拒否する
//
// 門A 本審査 = `docs/plan/v1/records/v1-m2-t05d.md`。判定は**限定採用**であり、
// 増分は**規則1つ**(「`$` で始まらない値に `{` `}` を書けない」)に限定されている。
//
// **双方向で固定する。**「拒否されること」だけを書くと、次に誰かが `else` を
// 広げすぎたときに `$record.name` や `未点検` が巻き添えで死んでも誰も気づかない
// (T05c A-5 が確立した作法)。以下は T05d §5-1 の全件表11行をそのまま写したものである。
// ---------------------------------------------------------------------------
describe("V1-M2-T05e: action_value のリテラル側の絞り込み(T05d §5-1 の全件表)", () => {
  /** T05d §5-1 の「通る」側(4行)。**巻き添えが出ていないことの歯止め。** */
  const accepted = ["$record.name", "$record._id", "未点検", "新しい申し込みが来ました"];

  /** T05d §5-1 の「拒否」側のうち、本タスクが**新たに**拒否するもの(5行)。 */
  const newlyRejected = [
    "{{record.name}}",
    "{{name}}",
    "{name}",
    "新しい申し込みが来ました: {{record.name}}",
    "予算 {申請中}",
  ];

  /** T05d §5-1 の「拒否」側のうち、**制約前から拒否されていた**もの(2行。変更なしの歯止め)。 */
  const alreadyRejected = ["$foo", "$record.name}}"];

  for (const value of accepted) {
    test(`values に "${value}" は通る(巻き添えが無いことの歯止め)`, () => {
      expect(
        validateManifest(
          withWorkflow((w) => {
            w.actions[0].values = { title: value };
          }),
        ),
      ).toEqual({ valid: true });
    });
  }

  for (const value of [...newlyRejected, ...alreadyRejected]) {
    test(`values に "${value}" は拒否される`, () => {
      expectInvalid(
        validateManifest(
          withWorkflow((w) => {
            w.actions[0].values = { title: value };
          }),
        ),
      );
    });
  }

  /**
   * T05d 完了条件5 / §6-3。**`target` に何も書き足していないのに掛かる**ことの証明。
   *
   * `$defs/workflow_action.properties.target` が `{"$ref": "#/$defs/action_value"}` で
   * あることの帰結であり、位置を数え上げた結果ではない(限定15)。
   */
  test("target に口ひげ記法を書くと拒否される($ref 経由で自動的に掛かる)", () => {
    for (const value of ["{{record._id}}", "{record._id}"]) {
      expectInvalid(
        validateManifest(
          withWorkflow((w) => {
            w.actions = [
              {
                action: "update_record",
                table: "notifications",
                target: value,
                values: { title: "だめ" },
              },
            ];
          }),
        ),
      );
    }
  });

  test("差分経路(add_workflow)にも同じ制約が掛かる", () => {
    const result = validateDiff({
      diff_id: "d-1",
      intent: "口ひげ記法",
      operations: [
        {
          op: "add_workflow",
          workflow: {
            id: "notify",
            name: "通知",
            trigger: { type: "on_create", table: "books" },
            history_table: "workflow-runs",
            actions: [
              {
                action: "create_record",
                table: "notifications",
                values: { title: "{{record.title}}" },
              },
            ],
          },
        },
      ],
    });
    expectInvalid(result);
  });

  /**
   * 限定13(T05d §10-2): **拒否するのは `{` と `}` の2文字だけである。**
   * 禁止する記法の一覧を作ってはならない。**一覧を作ればそれ自体がミニ言語**であり、
   * 限定12 が表側で禁じたものを裏側で作ることになる。
   */
  test("限定13: 波括弧以外のテンプレート記法は拒否しない(禁止一覧を作っていないことの歯止め)", () => {
    for (const value of ["<%= record.name %>", "%record.name%", "[[record.name]]"]) {
      expect(
        validateManifest(
          withWorkflow((w) => {
            w.actions[0].values = { title: value };
          }),
        ),
      ).toEqual({ valid: true });
    }
  });

  test("スキーマ上、増分は $defs/action_value の else 1つだけである(if/then/type は不変)", () => {
    const manifest = canonicalSchema("manifest.schema.json");
    const actionValue = manifest.$defs.action_value as Any;
    expect(Object.keys(actionValue).sort()).toEqual([
      "$comment",
      "description",
      "else",
      "if",
      "then",
      "type",
    ]);
    expect(actionValue.type).toBe("string");
    expect(actionValue.if).toEqual({ type: "string", pattern: "^\\$" });
    expect(actionValue.then).toEqual({ pattern: "^\\$record\\.(_id|[a-z][a-z0-9_-]*)$" });
    expect(actionValue.else).toEqual({ pattern: "^[^{}]*$" });
  });
});

// ============================================================================
// V2-M3-T01: EC-G5 条件分岐(最小述語 `when`。ADR-0036)のスキーマ検査
// ============================================================================

describe("V2-M3-T01: EC-G5 条件分岐(when)のスキーマ", () => {
  /** アクションに `when` を差し込んだマニフェストを作る。 */
  function withWhen(when: Any): Any {
    return withWorkflow((w) => {
      w.actions[0].when = when;
    });
  }

  test("when を持つ create_record が通過する", () => {
    expect(validateManifest(withWhen({ field: "title", equals: "完了" }))).toEqual({ valid: true });
  });

  test("equals は string / number / boolean のいずれも通過する", () => {
    expect(validateManifest(withWhen({ field: "title", equals: "文字列" }))).toEqual({
      valid: true,
    });
    expect(validateManifest(withWhen({ field: "title", equals: 42 }))).toEqual({ valid: true });
    expect(validateManifest(withWhen({ field: "title", equals: true }))).toEqual({ valid: true });
  });

  test("when は update_record にも書ける(全アクション共通の任意プロパティ)", () => {
    expect(
      validateManifest(
        withWorkflow((w) => {
          w.actions = [
            {
              action: "update_record",
              table: "notifications",
              target: "$record._id",
              values: { title: "x" },
              when: { field: "title", equals: "done" },
            },
          ];
        }),
      ),
    ).toEqual({ valid: true });
  });

  test("when 無しは従来どおり通過する(後方互換)", () => {
    // workflowManifest の既定アクションは when を持たない。
    expect(validateManifest(workflowManifest)).toEqual({ valid: true });
  });

  test("演算子キー(operator / lt / gt)を足すと拒否する —— ミニ言語の入口を開けない", () => {
    expectInvalid(validateManifest(withWhen({ field: "title", equals: "x", operator: "lt" })));
    expectInvalid(validateManifest(withWhen({ field: "title", lt: 5 })));
    expectInvalid(validateManifest(withWhen({ field: "title", gt: 5, equals: "x" })));
  });

  test("論理結合(and / or)を足すと拒否する", () => {
    expectInvalid(
      validateManifest(
        withWhen({
          and: [
            { field: "title", equals: "a" },
            { field: "title", equals: "b" },
          ],
        }),
      ),
    );
    expectInvalid(validateManifest(withWhen({ field: "title", equals: "x", or: [] })));
  });

  test("else を足すと拒否する", () => {
    expectInvalid(
      validateManifest(withWhen({ field: "title", equals: "x", else: { field: "title" } })),
    );
  });

  test("ネストした条件(条件式の入れ子)は書けない —— equals はリテラルのみ", () => {
    expectInvalid(validateManifest(withWhen({ field: "title", equals: { field: "title" } })));
    expectInvalid(validateManifest(withWhen({ field: "title", equals: ["a", "b"] })));
  });

  test("field / equals のどちらかが欠けると拒否する(最小述語1形は両方必須)", () => {
    expectInvalid(validateManifest(withWhen({ field: "title" })));
    expectInvalid(validateManifest(withWhen({ equals: "x" })));
  });

  test("スキーマ上、when は $defs/filter の要素と同型(field / equals・additionalProperties:false)", () => {
    const manifest = canonicalSchema("manifest.schema.json");
    const when = manifest.$defs.workflow_action.properties.when as Any;
    expect(when.type).toBe("object");
    expect(when.additionalProperties).toBe(false);
    expect([...when.required].sort()).toEqual(["equals", "field"]);
    expect(Object.keys(when.properties).sort()).toEqual(["equals", "field"]);
    expect(when.properties.equals.type).toEqual(["string", "number", "boolean"]);
    // list_view.filter の等値AND配列(後方互換の前例。EC-G12 / ADR-0043 で filter は
    // anyOf 化されたが、when が写している等値1形は $defs/filter_and_array.items のまま)と
    // 同じ形であることを機械的に固定する。when はブール式には広がらない(ADR-0036 / ADR-0043 §2)。
    const filterItem = manifest.$defs.filter_and_array.items as Any;
    expect(when.properties.field).toEqual(filterItem.properties.field);
    expect(when.properties.equals.type).toEqual(filterItem.properties.equals.type);
  });

  test("when は required に入っていない(任意プロパティ・後方互換)", () => {
    const manifest = canonicalSchema("manifest.schema.json");
    const action = manifest.$defs.workflow_action as Any;
    expect(action.required).toEqual(["action"]);
    expect(action.properties.when).toBeDefined();
  });
});

// ============================================================================
// V3-M10-T01(`D-G16a`。ADR-0063)—— 増分の限定を schema の形で固定する
//
// **限定を散文で書かず機械的検査に落とす**(ADR-0063 §3 末尾)。ここが当てるのは
// **同 §3 の限定表8点のうち、schema の形で固定できる 1 / 2 / 6 / 7 の4点**である
// (限定3 は上の「システムテーブルは書けない」/ 限定4・5 は `workflow-scheduler.test.ts`
// / 限定8 は `src/mcp/vocabulary.test.ts`)。
// ============================================================================

describe("V3-M10-T01 / ADR-0063: 増分の限定(schema 側)", () => {
  test("限定1: ADR-0063 は $defs/workflow_trigger にキーを1つも足していない・type の enum は3値のまま", () => {
    const trigger = canonicalSchema("manifest.schema.json").$defs.workflow_trigger as Any;
    /*
     * 【V3-M10-T02 / `D-G16b` / ADR-0064 限定1 で期待値を更新した。検査は消していない】
     * - **更新前**: `expect(Object.keys(trigger.properties).sort()).toEqual(["at", "table", "type"]);`
     * - **更新後**: 下の4キー(`older_than` が4キー目)。
     *
     * **`ADR-0063`(`D-G16a`)は今日もキーを1つも足していない** —— 4キー目を足したのは
     * `ADR-0064`(`D-G16b`)であり、**期待値を更新する権限は `ADR-0064` の側にしか無い**
     * (`ADR-0064` §Consequences / `v3-m10.md` §2a-3)。`for_each` 等を足すとここが赤くなる
     * (`web/test/shell-navigation-boundary.test.ts:203` と同じことを、より近い場所で言う)。
     */
    expect(Object.keys(trigger.properties).sort()).toEqual(["at", "older_than", "table", "type"]);
    expect(trigger.additionalProperties).toBe(false);
    expect(trigger.required).toEqual(["type"]);
    /*
     * **【`V5-M25-T01` / `L-G8` / `ADR-0174` 限定1 による追随。旧を隠さない】**
     * **旧**: `expect([...trigger.properties.type.enum]).toEqual(["on_create", "on_update", "schedule"]);`
     * **`ADR-0013` 限定4 の「3種だけ」という**数**は `ADR-0174` が無効化した**(同 §7 の5)。
     * **名指しで禁じられた4つ(`on_delete` / `on_view` / `on_undo` / `on_error`)は
     * 今日も1つも足していない** —— **その禁止は1ミリも弱めていない**(下の行が固定する)。
     */
    expect([...trigger.properties.type.enum]).toEqual([
      "on_create",
      "on_update",
      "schedule",
      "manual",
    ]);
    for (const forbidden of ["on_delete", "on_view", "on_undo", "on_error"]) {
      expect([...trigger.properties.type.enum]).not.toContain(forbidden);
    }
    // `table` は `$defs/resource_id` を指したまま(`view_table_id` にしない。限定3)。
    expect(trigger.properties.table.$ref).toBe("#/$defs/resource_id");
  });

  test("限定1: schedule 分岐から外したのは `table: false` だけである(at の必須は残る)", () => {
    const trigger = canonicalSchema("manifest.schema.json").$defs.workflow_trigger as Any;
    const branches = trigger.allOf as Any[];
    /*
     * 【V3-M10-T02 / ADR-0064 限定5 で期待値を更新した。検査は消していない】
     * - **更新前**: `expect(branches).toHaveLength(3);`
     * - **更新後**: 4(`ADR-0064` が「schedule かつ table 無し → `older_than` を書けない」
     *   分岐を1本足した)。**既存3分岐の中身は下でそのまま突き合わせている。**
     *
     * **【`V5-M25-T01` / `ADR-0174` による追随】** **旧: `toHaveLength(4)`。**
     * **`ADR-0174` が `manual` の分岐を1本足した(4 → 5)。**
     * **既存4分岐の中身は下でそのまま突き合わせている。**
     */
    expect(branches).toHaveLength(5);
    const scheduleBranch = branches.find(
      (branch) => branch.if.properties.type.const === "schedule" && branch.if.not === undefined,
    ) as Any;
    expect(scheduleBranch.then.required).toEqual(["at"]);
    // **`"table": false` が消えていること**が `D-G16a` の実装そのものである。
    expect(scheduleBranch.then.properties?.table).toBeUndefined();
    // on_create / on_update 側は1バイトも変えていない(`at` を書けないまま)。
    for (const type of ["on_create", "on_update"]) {
      const branch = branches.find(
        (candidate) => candidate.if.properties.type.const === type,
      ) as Any;
      expect(branch.then.required).toEqual(["table"]);
      expect(branch.then.properties.at).toBe(false);
    }
  });

  test("限定2: $defs/schedule_at は hour / minute の2キーのまま(cron・曜日・間隔は0件)", () => {
    const at = canonicalSchema("manifest.schema.json").$defs.schedule_at as Any;
    expect(Object.keys(at.properties).sort()).toEqual(["hour", "minute"]);
    expect(at.additionalProperties).toBe(false);
    expect([...at.required].sort()).toEqual(["hour", "minute"]);
    // 「毎日1回」であることを述べた $comment を残す(足すなら門A を改めて通す旨)。
    expect(at.$comment).toContain("曜日指定・月指定・間隔指定を足さないこと");
    expect(at.description).toContain("毎日この時刻に1回発火する");
  });

  test("限定6: $defs/workflow_action.when は等値1形のまま(schedule 側の拒否可否だけを変えた)", () => {
    const when = canonicalSchema("manifest.schema.json").$defs.workflow_action.properties
      .when as Any;
    expect(Object.keys(when.properties).sort()).toEqual(["equals", "field"]);
    expect(when.additionalProperties).toBe(false);
    expect(when.$comment).toContain("演算子");
  });

  test("限定7: $defs/action_value を1バイトも触っていない(ADR-0013 限定12 不可侵)", () => {
    const actionValue = canonicalSchema("manifest.schema.json").$defs.action_value as Any;
    expect(actionValue.type).toBe("string");
    expect(actionValue.if).toEqual({ type: "string", pattern: "^\\$" });
    expect(actionValue.then).toEqual({ pattern: "^\\$record\\.(_id|[a-z][a-z0-9_-]*)$" });
    expect(actionValue.else).toEqual({ pattern: "^[^{}]*$" });
  });

  test("限定8: table の description と workflow_trigger の $comment が schedule での意味を述べている", () => {
    const trigger = canonicalSchema("manifest.schema.json").$defs.workflow_trigger as Any;
    // 実装 → 記述。**`schedule` で `table` が書けるのに description が
    // 「on_create / on_update で監視する対象」だけを述べていたら嘘になる。**
    expect(trigger.properties.table.description).toContain("schedule");
    expect(trigger.properties.table.description).toContain("ADR-0013 限定10");
    // 限定3 の担保(resource_id であって view_table_id ではない)の記述は残す。
    expect(trigger.$comment).toContain("$defs/view_table_id");
    // 記述 → 実装。ADR-0063 を名指しした以上、schedule 分岐に `table: false` は無い。
    expect(trigger.$comment).toContain("ADR-0063");
  });
});

// ============================================================================
// V3-M10-T02(`D-G16b`。ADR-0064)—— 経過時間の述語 `older_than` を schema の形で固定する
//
// **限定を散文で書かず機械的検査に落とす**(ADR-0064 §3 末尾)。ここが当てるのは
// **同 §3 の限定表6点のうち、schema の形で固定できる 1 / 2 / 3 / 4 / 5 の5点**である
// (限定6 = Δ5 文言点検は `src/mcp/vocabulary.test.ts`、
//  発火の振る舞いと境界は `src/kernel/workflow-scheduler.test.ts`、
//  `older_than.field` の実在と型は `src/kernel/workflow-referential-integrity.test.ts`)。
// ============================================================================

/** `schedule` + `table` + `older_than` を持つトリガー(`D-G16b` の正常形)。 */
function olderThanTrigger(older: Any = { field: "finished_at", days: 3 }): Any {
  return { type: "schedule", at: { hour: 9, minute: 0 }, table: "books", older_than: older };
}

describe("V3-M10-T02 / ADR-0064 限定1: 足すキーは older_than 1つだけ(平坦な1形)", () => {
  test("$defs/workflow_trigger の properties は4キーである(at / older_than / table / type)", () => {
    /*
     * 【V3-M10-T02 / `D-G16b` / ADR-0064 限定1 で期待値を更新した。検査は消していない】
     * - **更新前**: `expect(Object.keys(trigger.properties).sort()).toEqual(["at", "table", "type"]);`
     *   (V3-M10-T01 が `ADR-0063` 限定1「新しいキーを1つも作らない」を固定したもの)
     * - **更新後**: 下の4キー。**更新する権限は `ADR-0064` の側にしか無い**
     *   (`ADR-0064` §Consequences / `v3-m10.md` §2a-3)。
     */
    const trigger = canonicalSchema("manifest.schema.json").$defs.workflow_trigger as Any;
    expect(Object.keys(trigger.properties).sort()).toEqual(["at", "older_than", "table", "type"]);
    expect(trigger.additionalProperties).toBe(false);
    expect(trigger.required).toEqual(["type"]);
    /*
     * **【`V5-M25-T01` / `L-G8` / `ADR-0174` 限定1 による追随。旧を隠さない】**
     * **旧コメント(逐語)**: 「**トリガー種別は3値のまま**(ADR-0013 限定4。
     * `older_than` は種別を1つも足さない)。」
     * **`older_than` は今日も種別を1つも足していない** —— **4値目を足したのは
     * `ADR-0174` である。** **`ADR-0064` の増分は今日も `older_than` 1キーである。**
     */
    expect([...trigger.properties.type.enum]).toEqual([
      "on_create",
      "on_update",
      "schedule",
      "manual",
    ]);
  });

  test("older_than は { field, days } の平坦な1形である(ネスト・配列・複数述語を持たない)", () => {
    const older = (canonicalSchema("manifest.schema.json").$defs.workflow_trigger as Any).properties
      .older_than;
    expect(older.type).toBe("object");
    expect(Object.keys(older.properties).sort()).toEqual(["days", "field"]);
    expect([...older.required].sort()).toEqual(["days", "field"]);
    expect(older.additionalProperties).toBe(false);
    // `field` は `$defs/resource_id`(システムテーブル形 `_xxx` を弾く既存の担保を継承)。
    expect(older.properties.field.$ref).toBe("#/$defs/resource_id");
    // `days` は**整数リテラル**であり、式でも関数呼び出しでもない(ADR-0036 §3a 第5項)。
    expect(older.properties.days.type).toBe("integer");
    expect(older.properties.days.minimum).toBe(1);
    expect(older.properties.days.maximum).toBe(3650);
    // **入れ子を1つも持たない**(第4項)。値スキーマの中に object / array が現れない。
    expect(JSON.stringify(older)).not.toContain('"array"');
    expect(older.properties.field.type).toBeUndefined();
  });

  test("$defs を1つも新設していない(older_than は workflow_trigger の中にインラインで在る)", () => {
    const defs = canonicalSchema("manifest.schema.json").$defs as Any;
    expect(defs.older_than).toBeUndefined();
    expect(defs.schedule_older_than).toBeUndefined();
    expect(defs.elapsed_time).toBeUndefined();
  });

  test("older_than に未知キーを足すと拒否される(ついでに足す を塞ぐ)", () => {
    for (const extra of [
      { field: "finished_at", days: 3, hours: 2 },
      { field: "finished_at", days: 3, newer_than: 1 },
      { field: "finished_at", days: 3, and: [] },
    ]) {
      expectInvalid(
        validateManifest(
          withWorkflow((w) => {
            w.trigger = olderThanTrigger(extra);
          }),
        ),
      );
    }
  });

  test("days は 1〜3650 の整数だけを受ける(0 / 3651 / 小数 / 文字列は拒否)", () => {
    for (const days of [1, 3650]) {
      expect(
        validateManifest(
          withWorkflow((w) => {
            w.trigger = olderThanTrigger({ field: "finished_at", days });
          }),
        ),
      ).toEqual({ valid: true });
    }
    for (const days of [0, -1, 3651, 1.5, "3"]) {
      expectInvalid(
        validateManifest(
          withWorkflow((w) => {
            w.trigger = olderThanTrigger({ field: "finished_at", days });
          }),
        ),
      );
    }
  });

  test("field / days のどちらが欠けても拒否される(required は2キーとも)", () => {
    for (const older of [{ field: "finished_at" }, { days: 3 }, {}]) {
      expectInvalid(
        validateManifest(
          withWorkflow((w) => {
            w.trigger = olderThanTrigger(older);
          }),
        ),
      );
    }
  });

  test("older_than の $comment が「時刻専用であり一般の比較演算子ではない」ことを述べている", () => {
    const older = (canonicalSchema("manifest.schema.json").$defs.workflow_trigger as Any).properties
      .older_than;
    expect(older.$comment).toContain("ADR-0064");
    expect(older.$comment).toContain("時刻専用");
    expect(older.$comment).toContain("一般の比較演算子ではない");
    // 論理結合を足さないことを schema に焼く(限定1。散文でなく schema に置く)。
    expect(older.$comment).toContain("論理結合");
  });
});

describe("V3-M10-T02 / ADR-0064 限定5: older_than は schedule かつ table が在るときだけ書ける", () => {
  test("schedule + table なら受理される", () => {
    expect(
      validateManifest(
        withWorkflow((w) => {
          w.trigger = olderThanTrigger();
        }),
      ),
    ).toEqual({ valid: true });
  });

  test("table の無い schedule に書くと拒否される", () => {
    expectInvalid(
      validateManifest(
        withWorkflow((w) => {
          w.trigger = {
            type: "schedule",
            at: { hour: 9, minute: 0 },
            older_than: { field: "finished_at", days: 3 },
          };
        }),
      ),
    );
  });

  test("on_create / on_update に書くと拒否される(ADR-0064 §3a 3 の門を先取りさせない)", () => {
    for (const type of ["on_create", "on_update"]) {
      expectInvalid(
        validateManifest(
          withWorkflow((w) => {
            w.trigger = { type, table: "books", older_than: { field: "finished_at", days: 3 } };
          }),
        ),
      );
    }
  });

  test("allOf は5分岐であり、そのうち1本が「schedule かつ table 無し → older_than false」である", () => {
    /*
     * 【期待値の更新。検査は消していない】
     * - **更新前**(V3-M10-T01): `expect(branches).toHaveLength(3);`
     * - **更新後**: 4。**足したのは1分岐だけ**であり、既存3分岐の中身は下で1つずつ突き合わせる。
     *
     * **【`V5-M25-T01` / `ADR-0174` による追随。テスト名も書き換えた】**
     * **旧テスト名(逐語)**: 「**allOf は4分岐であり、4本目が「schedule かつ table 無し →
     * older_than false」である**」。**`ADR-0174` が `manual` の分岐を**3本目と4本目の間**に
     * 足したので、`ADR-0064` が足した分岐は**5本目**になった。**
     * **本 test が固定しているのは `ADR-0064` の分岐そのものであり、位置ではない** ——
     * **したがって位置ではなく述語で引き当てる形に変えた。**
     */
    const trigger = canonicalSchema("manifest.schema.json").$defs.workflow_trigger as Any;
    const branches = trigger.allOf as Any[];
    expect(branches).toHaveLength(5);

    const added = branches.find((branch: Any) => (branch.if as Any).not !== undefined) as Any;
    expect(added.if.properties.type.const).toBe("schedule");
    expect(added.if.not).toEqual({ required: ["table"] });
    expect(added.then.properties.older_than).toBe(false);

    // 既存の schedule 分岐(`ADR-0063`)は1バイトも動いていない。
    const scheduleBranch = branches.find(
      (branch) => branch.if.properties.type.const === "schedule" && branch.if.not === undefined,
    ) as Any;
    expect(scheduleBranch.then.required).toEqual(["at"]);
    expect(scheduleBranch.then.properties?.table).toBeUndefined();

    // on_create / on_update は `at` を書けないまま + `older_than` も書けない。
    for (const type of ["on_create", "on_update"]) {
      const branch = branches.find(
        (candidate) => candidate.if.properties.type.const === type,
      ) as Any;
      expect(branch.then.required).toEqual(["table"]);
      expect(branch.then.properties.at).toBe(false);
      expect(branch.then.properties.older_than).toBe(false);
    }
  });
});

describe("V3-M10-T02 完了条件4 / ADR-0064 限定2: ADR-0036 §3a の5項目を1つも破っていない", () => {
  function when(): Any {
    return canonicalSchema("manifest.schema.json").$defs.workflow_action.properties.when;
  }

  test("第1項(比較演算子): when の properties は field / equals の2キーのままである", () => {
    expect(Object.keys(when().properties).sort()).toEqual(["equals", "field"]);
    expect([...when().required].sort()).toEqual(["equals", "field"]);
    expect(when().additionalProperties).toBe(false);
    expect(when().properties.equals.type).toEqual(["string", "number", "boolean"]);
    // 比較演算子のキーが1つも生えていない。
    for (const operator of ["lt", "gt", "lte", "gte", "before", "after", "older_than"]) {
      expect(when().properties[operator]).toBeUndefined();
    }
  });

  test("第2項(論理結合): when にも trigger にも and / or / not のキーが1つも無い", () => {
    const trigger = canonicalSchema("manifest.schema.json").$defs.workflow_trigger as Any;
    for (const key of ["and", "or", "not", "any_of", "all_of"]) {
      expect(when().properties[key]).toBeUndefined();
      expect(trigger.properties[key]).toBeUndefined();
      expect(trigger.properties.older_than.properties[key]).toBeUndefined();
    }
    // **AND は2層の合成で得る**(`when` の等値 × `trigger.older_than` の経過)。
    // 述語そのものを結合可能にしていないことが、この検査の言っていることである。
  });

  test("第3項(else): 不成立時の別アクションを表すキーが1つも無い", () => {
    const trigger = canonicalSchema("manifest.schema.json").$defs.workflow_trigger as Any;
    for (const key of ["else", "otherwise", "else_actions"]) {
      expect(when().properties[key]).toBeUndefined();
      expect(trigger.properties[key]).toBeUndefined();
      expect(trigger.properties.older_than.properties[key]).toBeUndefined();
    }
  });

  test("第4項(ネスト): older_than は自己参照も入れ子の述語も持たない", () => {
    const older = (canonicalSchema("manifest.schema.json").$defs.workflow_trigger as Any).properties
      .older_than;
    expect(JSON.stringify(older)).not.toContain('$ref":"#/$defs/workflow_trigger');
    expect(JSON.stringify(older)).not.toContain("filter_node");
    for (const value of Object.values(older.properties) as Any[]) {
      expect(value.properties).toBeUndefined();
      expect(value.items).toBeUndefined();
    }
  });

  test("第5項(条件式・関数呼び出し): days は整数であり、$defs/action_value を1バイトも触っていない", () => {
    const older = (canonicalSchema("manifest.schema.json").$defs.workflow_trigger as Any).properties
      .older_than;
    expect(older.properties.days.type).toBe("integer");
    expect(older.properties.days.pattern).toBeUndefined();

    const actionValue = canonicalSchema("manifest.schema.json").$defs.action_value as Any;
    expect(actionValue.type).toBe("string");
    expect(actionValue.if).toEqual({ type: "string", pattern: "^\\$" });
    expect(actionValue.then).toEqual({ pattern: "^\\$record\\.(_id|[a-z][a-z0-9_-]*)$" });
    expect(actionValue.else).toEqual({ pattern: "^[^{}]*$" });
  });

  test("`:858` の $comment が5項目を1文で述べたまま残っている(逐語)", () => {
    // **5項目すべてを1文で述べている唯一の場所である**(ADR-0064 §1b の実測)。
    expect(when().$comment).toContain(
      "**演算子・比較 (lt/gt/lte/gte)・論理結合 (and/or)・else・ネスト・条件式・関数呼び出しを1つも足してはならない**",
    );
    expect(when().$comment).toContain("最小述語1形のみ");
    expect(when().description).toContain("等値の最小述語1形のみ");
  });
});

describe("V3-M10-T02 完了条件6 / ADR-0064 限定4: filter を1バイトも触っていない", () => {
  function sourceText(relative: string): string {
    return readFileSync(join(import.meta.dir, "..", "..", relative), "utf-8");
  }

  test("$defs/filter_leaf の葉演算子は5種のままである", () => {
    const leaf = canonicalSchema("manifest.schema.json").$defs.filter_leaf as Any;
    expect(Object.keys(leaf.properties).sort()).toEqual([
      "contains",
      "equals",
      "field",
      "gte",
      "in",
      "lte",
    ]);
    expect(leaf.additionalProperties).toBe(false);
    expect((leaf.oneOf as Any[]).map((branch) => branch.required[0]).sort()).toEqual([
      "contains",
      "equals",
      "gte",
      "in",
      "lte",
    ]);
  });

  test("$defs/filter_node の結合は and / or / not の3種のままである", () => {
    const node = canonicalSchema("manifest.schema.json").$defs.filter_node as Any;
    const keys = new Set<string>();
    for (const branch of node.anyOf as Any[]) {
      for (const key of Object.keys(branch.properties ?? {})) {
        keys.add(key);
      }
    }
    expect([...keys].sort()).toEqual(["and", "not", "or"]);
  });

  test("`LEAF_OPERATORS` は5種の逐語のままで、`MAX_FILTER_DEPTH` は8である", () => {
    const records = sourceText("src/kernel/records.ts");
    expect(records).toContain(
      'const LEAF_OPERATORS = ["equals", "contains", "gte", "lte", "in"] as const;',
    );
    expect(records).toContain("export const MAX_FILTER_DEPTH = 8;");
  });

  test("filter の値に実行時解決を1つも許していない($record. が compileFilter 領域に0件)", () => {
    // **`compileFilter` 領域**(`MAX_FILTER_DEPTH` の宣言から `isFilterArray` の後の
    // コンパイル群まで)に `$record` が現れないことを走査する。ADR-0064 限定4 の
    // 「filter の値に実行時解決を1つも許さない」の機械的な当たり先である。
    const records = sourceText("src/kernel/records.ts");
    const start = records.indexOf("export const MAX_FILTER_DEPTH = 8;");
    const end = records.indexOf("export function listRecords(");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const region = records.slice(start, end);
    expect(region).not.toContain("$record");
    expect(region).not.toContain("older_than");
  });
});

describe("V3-M10-T02 完了条件7 / ADR-0043:87: when の等値1形は schedule 以外の経路でも不変である", () => {
  test("on_create の when は今日どおり {field, equals} だけを受ける", () => {
    expect(
      validateManifest(
        withWorkflow((w) => {
          w.actions[0].when = { field: "title", equals: "x" };
        }),
      ),
    ).toEqual({ valid: true });
    for (const bad of [
      { field: "title", gte: "x" },
      { field: "title", equals: "x", and: [] },
      { and: [{ field: "title", equals: "x" }] },
      { field: "title", equals: "x", older_than: { field: "finished_at", days: 3 } },
    ]) {
      expectInvalid(
        validateManifest(
          withWorkflow((w) => {
            w.actions[0].when = bad;
          }),
        ),
      );
    }
  });

  test("`older_than` は trigger 側にしか書けない(action 側に生えていない)", () => {
    const action = canonicalSchema("manifest.schema.json").$defs.workflow_action as Any;
    expect(action.properties.older_than).toBeUndefined();
    // **`older_than` は action 側に1つも生えていない**(ADR-0064 限定2 は今日も不変)。
    // **【V3-M13-T09 による期待値の更新】キー数は 16 → 17 になった** —— 増やしたのは
    // `ADR-0064` ではなく `ADR-0067`(D-G15 の4回目 = 限定採用)の `write_ops` 1本であり、
    // **`ADR-0064` 限定2 の「trigger 側にしか書けない」は1バイトも破られていない。**
    expect(Object.keys(action.properties)).toHaveLength(17);
    expect(Object.keys(action.properties)).toContain("write_ops");
  });

  test("$defs/schedule_at は hour / minute の2キーのままである(ADR-0064 限定3)", () => {
    const at = canonicalSchema("manifest.schema.json").$defs.schedule_at as Any;
    expect(Object.keys(at.properties).sort()).toEqual(["hour", "minute"]);
    expect(at.additionalProperties).toBe(false);
    expect([...at.required].sort()).toEqual(["hour", "minute"]);
    expect(at.$comment).toContain("曜日指定・月指定・間隔指定を足さないこと");
  });
});

// ===========================================================================
// V3-M10-T04: 越えない線の非退行検査(schema / 実装の走査の側)
//
// **製品コードを1バイトも変更しない**(`v3-m10.md` §2 T04 / §2a-5)。
//
// **重複を作らないために、着手前に「今日どのファイルが何を検査しているか」を実測した**
// (2026-07-31。位置はその日のもの):
//
// - `$defs/schedule_at` の2キー …… 本ファイルの「限定2」(T01)と
//   「ADR-0064 限定3」(T02)の**2本**が既に当てている。**足さない。**
// - `$defs/filter_leaf` の葉演算子5種 …… 本ファイル(T02)+ `src/mcp/vocabulary.test.ts`
//   + `web/test/shell-navigation-boundary.test.ts` の `DEF_PROPERTY_KEYS` が当てている。
//   **ただし当たっていた写しは `src/kernel/records.ts` の `LEAF_OPERATORS` だけであった** ——
//   **2つ目の写し `src/kernel/read-records.ts` の `MEMORY_LEAF_OPERATORS` は、今日どの
//   検査からも当たっていない。** ここで足すのはその1点である。
//   **【SQ-M4 追記】その2つ目の写しは、システムテーブルの絞り込みを SQL へ一本化した
//   ときに消えた。** 検査は「2つ目が再び生えていないこと」へ置き換えてある(下記)。
// - `$defs/action_value` …… `src/kernel/reference-read-boundary.test.ts:639` の describe。
//   **本タスクは1本も新設しない**(T04 完了条件5)。
// ---------------------------------------------------------------------------

/** ソースを読む(逐語の走査用)。 */
function kernelText(relative: string): string {
  return readFileSync(join(import.meta.dir, "..", "..", relative), "utf-8");
}

describe("V3-M10-T04 完了条件3: `schedule_at` の2キーは型宣言層でも増えていない", () => {
  test("`ScheduleAt` 型は hour / minute の2キーのままである", () => {
    // **T01 / T02 が当てたのは schema 側だけである。** `src/kernel/types.ts` は
    // T01 / T02 が2回はみ出して触ったファイルであり(`v3-m10.md` §2a-2 (1) / §2a-3 (1))、
    // そこに曜日・間隔が生えても schema 側の検査は1本も赤くならない。
    const block = kernelText("src/kernel/types.ts").match(
      /export type ScheduleAt = \{([\s\S]*?)\};/,
    )?.[1] as string;
    expect(block).toBeDefined();
    const keys = block
      .split("\n")
      .map((line) => line.match(/^\s{2}(\w+)\??:/)?.[1])
      .filter((key): key is string => key !== undefined);
    expect(keys).toEqual(["hour", "minute"]);
  });

  test("`WorkflowTriggerSchedule` のキーは type / at / table / older_than の4つだけである", () => {
    const block = kernelText("src/kernel/types.ts").match(
      /export type WorkflowTriggerSchedule = \{([\s\S]*?)\n\};/,
    )?.[1] as string;
    expect(block).toBeDefined();
    const keys = block
      .split("\n")
      .map((line) => line.match(/^\s{2}(\w+)\??:/)?.[1])
      .filter((key): key is string => key !== undefined);
    // cron / 曜日 / 月 / 間隔 は0件である(ADR-0013 §6b / 限定6。V3-M10 の射程外)。
    expect(keys).toEqual(["type", "at", "table", "older_than"]);
  });
});

describe("V3-M10-T04 完了条件4: `filter` の葉演算子は5種のままであり、写しは1本しか無い", () => {
  /**
   * **【SQ-M4 で書き換えた。旧文を消さずに理由を残す】**
   *
   * T04 が足したのは「**2つ目の写し** `src/kernel/read-records.ts` の
   * `MEMORY_LEAF_OPERATORS` も5種のままか」だった —— **当時そこに当たる検査が1本も
   * 無かったからである。** SQ-M4 でシステムテーブルの絞り込みを SQL へ一本化し、
   * **2つ目の写しそのものを消した。**
   *
   * **守るべきものは「片方だけが増える経路を塞ぐ」ことであって、写しの本数ではない。**
   * 写しが1本しか無いなら、その状態を固定するのが同じことを守る最短の形である ——
   * したがって検査を「2つ目の写しが**再び生えていない**こと」に置き換えた。
   * 消して済ませると、`read-records.ts` に2本目を書き足す経路が無検査に戻る。
   */
  test("`read-records.ts` に葉演算子の2つ目の写しが無い(SQL の1本へ寄せた)", () => {
    const readRecords = kernelText("src/kernel/read-records.ts");
    expect(readRecords).not.toMatch(/const \w*LEAF_OPERATORS\b/);
    expect(readRecords).not.toContain('"equals", "contains", "gte", "lte", "in"');
  });

  test("唯一の写しと schema が同じ5種を指している(片方だけ増える経路を塞ぐ)", () => {
    const extract = (relative: string, name: string): string[] => {
      const matched = kernelText(relative).match(
        new RegExp(`const ${name} = \\[([^\\]]*)\\] as const;`),
      )?.[1] as string;
      expect(matched).toBeDefined();
      return matched.split(",").map((part) => part.trim().replace(/"/g, ""));
    };
    const fromRecords = extract("src/kernel/records.ts", "LEAF_OPERATORS");
    const fromSchema = Object.keys(
      (canonicalSchema("manifest.schema.json").$defs.filter_leaf as Any).properties,
    ).filter((key) => key !== "field");

    expect(fromRecords).toHaveLength(5);
    expect([...fromRecords].sort()).toEqual([...fromSchema].sort());
  });
});

describe("V3-M10-T04 完了条件7: `select` / `group_by` / 式言語が1つも実装されていない", () => {
  /** schema の全 `properties` キーと全 `$defs` 名を集める。 */
  function declaredKeys(): string[] {
    const found = new Set<string>();
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== "object") {
        return;
      }
      if (Array.isArray(node)) {
        for (const child of node) {
          walk(child);
        }
        return;
      }
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (
          (key === "properties" || key === "$defs") &&
          value !== null &&
          typeof value === "object"
        ) {
          for (const name of Object.keys(value as Record<string, unknown>)) {
            found.add(name);
          }
        }
        walk(value);
      }
    };
    walk(canonicalSchema("manifest.schema.json"));
    return [...found].sort();
  }

  /**
   * **【`V4-M23-T01` / `ADR-0104`(門A・限定採用)で、この検査の題名の一部が偽になった】**
   *
   * **旧題「射影・集約・結合・式のキーが1つも無い」のうち、「集約」の側は今日 成り立たない**
   * —— **`$defs/view` の28キー目 `sum_field`(一覧が表す集合について `number` 列1本の合計を
   * 出す)が門A を通って入った。** **題名も検査も消さない**(`ADR-0007` §6 規律1)。
   * **偽になった1語ぶんだけを、名指しの例外に切り出す。**
   *
   * **偽になったのは `sum` の1語だけである** —— **`select` / `group_by` / `having` /
   * `order_by` / `aggregate` / `formula` / `expression` / `expr` / `compute` / `count` /
   * `avg` / `join` / `distinct` / `where` の14語は今日も0件である。**
   * **例外は `sum_field` の1キーだけを名指しし、他の `sum*` キーは1つも許さない。**
   */
  /**
   * **【`V7-M1-T01` / `Z-G2` で、禁止語の**部分一致**が1件だけ当たるようになった】**
   *
   * **`access_control.members.account`(利用者の表のうち、ログインアカウントのIDを持つ列の
   * 名前を指すキー)は、`count` を部分文字列として含む。** **集約の `count` とは無関係である。**
   * **検査も禁止語の一覧も消さない**(`ADR-0007` §6 規律1)—— **`sum_field` のときと同じ形で、
   * この1キーだけを名指しの例外に切り出す。** **他の `*count*` キーは1つも許さない。**
   *
   * **`v7-m0.md` §4-3 の12箇所の列挙には、この検査は入っていなかった**
   * (`V7-M1-T02` の記録に「全量ではなかった」として書いた)。
   */
  /*
   * **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】除外を2語足した。**
   *
   * **旧行の逐語**:
   * `  const SUBSTRING_EXCEPTIONS: Record<string, readonly string[]> = { count: ["account"] };`
   *
   * **足した理由**: **集計表(`report_view`)の宣言 `$defs/report` が、束ねるキー
   * (`group_by`)と集計の種類(`count`)を実際に持つようになった。**
   * **`V3-M10-T04` 完了条件7 が固定していたのは「**その決定**(時刻起点の後追い処理)が
   * 射影・結合・式を1つも実装していないこと」であり、`group_by` を開いたのは別の決定である。**
   * **開いていない側は1ミリも緩めていない** —— **`having` / `join` / `distinct` /
   * `select` / `order_by` / `formula` / `expression` / `compute` / `avg` は今日も
   * マニフェストの語彙に1本も無く、この走査がそれを測り続ける。**
   * **【正直に書く】この2語の除外により、この test は `report` の中の `group_by` /
   * `count` が増えても気づかなくなった** —— **その2キーの形は
   * `src/server/report-declaration-boundary.test.ts` の (10) / (12) / (27) が
   * 値域つきで別に固定している。**
   */
  /*
   * **【2026-08-14。`V8-M9`。台帳 `Q-G6`〜`Q-G9`。門A 本審査 = `V8-M7`。判定 = 限定採用】
   * 除外を1語足した。**
   *
   * **旧行の逐語**:
   * ```
   *   const SUBSTRING_EXCEPTIONS: Record<string, readonly string[]> = {
   *     count: ["account"],
   *     group_by: ["group_by"],
   *     aggregate: ["aggregates"],
   *   };
   * ```
   *
   * **足した理由**: **集計表(`report_view`)の宣言 `$defs/report` が、結合(`join`)を
   * 実際に持つようになった。** **`V3-M10-T04` 完了条件7 が固定していたのは
   * 「**その決定**(時刻起点の後追い処理)が射影・結合・式を1つも実装していないこと」
   * であり、`join` を開いたのは別の決定である**(`V8-M7` の門A 本審査。判定 = 限定採用)。
   * **開いていない側は1ミリも緩めていない** —— **`having` / `distinct` / `select` /
   * `order_by` / `formula` / `expression` / `compute` / `avg` / `where` は今日も
   * マニフェストの語彙に1本も無く、この走査がそれを測り続ける。**
   * **【正直に書く】この除外により、この test は `report` の中に `join` が増えても
   * 気づかなくなった** —— **`join` の値域(`table` / `via` の2キーちょうど・`maxItems: 4`)
   * は `src/server/report-join-boundary.test.ts` の (20) が別に固定している。**
   * **【禁止】これを「結合はどこにでも書けるようになった」と読まない** ——
   * **`join` が書けるのは `$defs/report` の中だけである**(下の `toEqual` が、
   * `report` に書けるキーの全量を名指しで固定している)。
   */
  const SUBSTRING_EXCEPTIONS: Record<string, readonly string[]> = {
    count: ["account"],
    group_by: ["group_by"],
    aggregate: ["aggregates"],
    join: ["join"],
  };

  test("マニフェストの語彙に、射影・結合・式のキーが1つも無い(集約は sum_field の1本だけ)", () => {
    const keys = declaredKeys();
    // **走査の網が空でないことを先に示す**(0件を走査して0件と言わない)。
    expect(keys.length).toBeGreaterThan(100);
    for (const forbidden of [
      "select",
      "group_by",
      "having",
      "order_by",
      "aggregate",
      "formula",
      "expression",
      "expr",
      "compute",
      "count",
      "avg",
      "join",
      "distinct",
      "where",
    ]) {
      const allowed = SUBSTRING_EXCEPTIONS[forbidden] ?? [];
      expect(
        keys.filter((key) => key.toLowerCase().includes(forbidden) && !allowed.includes(key)),
        forbidden,
      ).toEqual([]);
    }
    // **`sum` を含むキーは `sum_field` の**ちょうど1本**である。**
    // **2本目が生えたらここが赤くなる**(`ADR-0104` 限定2「2つ目の演算を足さない」)。
    expect(keys.filter((key) => key.toLowerCase().includes("sum"))).toEqual(["sum_field"]);
    // **【2026-08-14。`V8-M8` / `Q-G1`】集計表の宣言が持つのは、束ねるキー(`group_by`)と
    // 集計(`aggregates`)と絞り込み(`filter`)の3本ちょうどである。****4本目が生えたら
    // ここが赤くなる** —— **とくに `having`(集計値で絞る)を1本も持たない。**
    expect(
      Object.keys(
        (canonicalSchema("manifest.schema.json").$defs as Record<string, Any>).report.properties,
      ),
      // **【2026-08-14。`V8-M9` / `Q-G6`〜`Q-G9`】期待値に `join`(結合)を足した。**
      // **旧行の逐語**: `    ).toEqual(["group_by", "aggregates", "filter"]);`
      // **書き換えた理由**: **結合が門A(`V8-M7`)を通って `$defs/report` に入り、
      // 3本 → 4本になった。** **`having` を1本も持たないという主張は1ミリも弱めていない**
      // —— **5本目が生えたら今日もここが赤くなる。**
      //
      // **【2026-08-15。`V8-M11-T02` / `Q-G21a` / `Q-G12`。ユーザ決定 `D-V8-130`】
      // 期待値に `sort`(並べ替え)を足した。**
      // **旧行の逐語**: `    ).toEqual(["join", "group_by", "aggregates", "filter"]);`
      // **【上の2つの注釈は1バイトも書き換えていない。ただし次の逐語は今日は偽である】**
      //   - **「集計表の宣言が持つのは …(略)… の3本ちょうどである」**(**今日は5本**)
      //   - **「4本目が生えたらここが赤くなる」**(**その4本目は `V8-M9` の `join`、
      //     5本目が本追記の `sort` である。宣言どおり、生えるたびにここが赤くなった**)
      //   - **「5本目が生えたら今日もここが赤くなる」** —— **これは偽ではない。**
      //     **実際に赤くなり、審査(`V8-M7` の門A。判定 = 限定採用)を経て期待値を直した。**
      // **`having`(集計値で群を落とす)を1本も持たないという主張は今日も1ミリも
      // 弱めていない** —— **開いたのは「並べる」側だけで、「絞る」側は1つも無い。**
      // **6本目が生えたら今日もここが赤くなる。**
      //
      // **【2026-08-15。`V8-M12-T02` / `Q-G23`(集計の数字を棒グラフと折れ線グラフで
      // 見たい)。門A 本審査 = `V8-M7`。判定 = 限定採用。ユーザ決定 `D-V8-131`】
      // 期待値に `chart`(グラフ種別)を足した。**
      // **旧行の逐語**: `    ).toEqual(["join", "group_by", "aggregates", "filter", "sort"]);`
      // **【上の3つの注釈は1バイトも書き換えていない。ただし次の逐語は今日は偽である】**
      //   - **「集計表の宣言が持つのは …(略)… の3本ちょうどである」**(**今日は6本**)
      //   - **「6本目が生えたら今日もここが赤くなる」** —— **これは偽ではない。**
      //     **実際に赤くなり、審査(`V8-M7` の門A。判定 = 限定採用)を経て期待値を直した。**
      // **この test が本来固定している主張は1ミリも弱めていない** —— **本題は
      // 「射影・結合・式のキーが1つも無い」ことであり、`chart` は射影でも式でもない**
      // (**上の禁止語 14語のどれも部分文字列として含まない**)。
      // **`having`(集計値で群を落とす)を1本も持たないという主張も今日も1ミリも
      // 弱めていない** —— **`chart` が決めるのはグラフの種別だけで、群の数も群の中身も
      // 1つも変えない。**
      // **7本目が生えたら今日もここが赤くなる。**
    ).toEqual(["join", "group_by", "aggregates", "filter", "sort", "chart"]);
  });

  test("V4-M23-T01: 開いたのは合計だけで、他の演算のキーは1本も無い(ADR-0104 限定2)", () => {
    const keys = declaredKeys();
    for (const forbidden of [
      "avg_field",
      "average_field",
      "min_field",
      "max_field",
      "count_field",
      "median_field",
      "sum_fields",
      "sum_by",
      "sum_group",
    ]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  test("`select` の出現はフィールド型の enum 値だけであって、キーではない", () => {
    // **語としての `select` は語彙に在る**(フィールド型の1つ)。**それは射影ではない。**
    // 「0件」と書けない事実を、区別して固定する。
    const schema = canonicalSchema("manifest.schema.json") as Any;
    expect(schema.$defs.field_type.enum).toContain("select");
    expect(declaredKeys()).not.toContain("select");
  });

  test("カーネルのクエリ組み立てに GROUP BY / HAVING が0件である", () => {
    for (const relative of ["src/kernel/records.ts", "src/kernel/read-records.ts"]) {
      const source = kernelText(relative);
      expect(source).not.toContain("GROUP BY");
      expect(source).not.toContain("HAVING");
    }
    // **`COUNT(` は2件ある。**どちらもマニフェストの語彙から呼べる集約ではない ——
    // 1件はテーブルの実在確認、もう1件はページネーションの総件数である
    // (ADR-0042)。**「集約が1件も無い」と丸めずに、在るものを名指しする。**
    //
    // **【V4-M23-T02 / `D-V4-89` / `E-G31` / ADR-0104 限定6 で 2 → 3 になった】**
    // **3件目は `countAndSumRecords` の `SELECT COUNT(*) AS n${sumClause} …` である。**
    // **これは上の2件と違い、マニフェストの語彙(`list_view.sum_field`)から呼べる。**
    // **旧文を1バイトも消していない** —— **「どちらもマニフェストの語彙から呼べる集約では
    // ない」は、その2件については今日も真である。**
    // **注釈行を除いた製品コードの行だけを数える**(注釈にも `COUNT(` の語が現れる)。
    const recordsCode = kernelText("src/kernel/records.ts")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
    expect(recordsCode.filter((line) => line.includes("COUNT("))).toHaveLength(3);
    expect(kernelText("src/kernel/records.ts")).toContain(
      'SELECT COUNT(*) AS n FROM "sqlite_master"',
    );
    // **`read-records.ts` は件数の SQL を1文も持たない**(`countRecords` へ委譲する)。
    // **注釈にこの綴りを書いても赤くなる**(全文で見ている)。SQ-M4 の一本化のあとも同じ。
    expect(kernelText("src/kernel/read-records.ts")).not.toContain("COUNT(");
  });

  /**
   * **【V4-M23-T02 / ADR-0104 限定2・限定6・限定8】カーネルが組み立てる集約は `SUM` 1つだけ。**
   *
   * **`GROUP BY` / `HAVING` は上の検査が0件で固定している** —— **本タスクは
   * `apply-diff.ts` の一意制約検査(ユーザの宣言では動かない経路)を1バイトも触っていない。**
   */
  test("V4-M23-T02: 読取のクエリ組み立てに在る集約関数は COUNT と SUM の2種だけである", () => {
    /** 注釈行を除いた製品コードの行だけを返す(注釈の `SUM()` を数に含めない)。 */
    const codeOf = (relative: string): string[] =>
      kernelText(relative)
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));

    const records = codeOf("src/kernel/records.ts");
    // **`SUM(` を組み立てているのは1箇所だけである**(集約列)。
    const sumLines = records.filter((line) => line.includes("SUM("));
    expect(sumLines).toHaveLength(1);
    // **列名は識別子として引用してから差し込んでいる**(値をそのまま SQL に置かない)。
    // **`${` を含む文字列リテラルを検査に書かない**ため、部分ごとに見る。
    expect(sumLines[0]).toContain("SUM(");
    expect(sumLines[0]).toContain("quoteIdentifier(field.id)");
    expect(sumLines[0]).toContain(") AS s");
    // **2つ目の演算を1つも組み立てていない**(限定2)。
    for (const forbidden of ["AVG(", "MIN(", "MAX(", "TOTAL(", "GROUP_CONCAT("]) {
      expect(
        records.filter((line) => line.includes(forbidden)),
        forbidden,
      ).toEqual([]);
    }
    // **システムテーブルの投影は集約を1つも組み立てていない。**
    //
    // **【SQ-M4 で前提が変わった。旧文の要求は1バイトも緩めていない】** かつてここには
    // 「**メモリ側(システムテーブルの投影)は SQL を1文も組み立てていない**」と書いていた。
    // **今日は組み立てている**(投影を副問合せとして FROM に差し込む)。**しかし
    // 組み立てているのは列を名前で並べる SELECT だけであり、集約は1つも無い** ——
    // **合計は `records.ts` の1本を通る**(`readRecordCountAndSum` が委譲する)。
    // **したがってこの検査が要求する0件は、今日も同じ強さで効いている。**
    const projection = codeOf("src/kernel/read-records.ts");
    for (const forbidden of ["SUM(", "AVG(", "MIN(", "MAX(", "GROUP BY", "HAVING"]) {
      expect(
        projection.filter((line) => line.includes(forbidden)),
        forbidden,
      ).toEqual([]);
    }
  });
});
