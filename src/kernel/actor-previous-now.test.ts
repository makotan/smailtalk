/**
 * 自動処理から操作者・変更前の値・今の時刻を参照する語彙と、適用時の拒否(`V23-M4-T01`)。
 *
 * 門A は `ADR-0500`(`SC-G13`〜`SC-G16`)と、その未決を埋めた `ADR-0524`。
 * この検査が固定するのは**語彙と適用時**だけである。 値の解決・発火・押すこと(実行時)は
 * `T03` 以降の検査が固定する。
 *
 * 1. スキーマ: `values` だけが5形(`$actor.id` / `$actor.login` / `$actor.role` /
 *    `$previous.<項目ID>` / `$now`)を受け、6形目と `values` の外の位置の新しい形を断る。
 *    `changed_fields` は `on_update` だけで書ける(1件以上・重複なし)。
 *    `function_input.source` に `actor` / `previous` を受ける(enum 案。`D-V23-97`)。
 * 2. 適用時(`referential-integrity.ts`): `$previous` は `on_update` の外で断る(受け入れ基準2)。
 *    `$previous.<x>` と `changed_fields` の項目はトリガー元の表に実在すること。
 *    `source: previous` の入力を持つ関数は `on_update` の外の `run_function` から呼べない。
 *    型の整合(`ADR-0029` の互換表のセルは動かさない)。
 * 3. 文面: `values` の位置の型・形の違反が罠の汎用文にならず、`$record` だけと嘘を言わない。
 * 4. 名前の付け替え(`D-V23-99`): `$previous.<項目>` と `changed_fields` が追随する。
 */
import { describe, expect, test } from "bun:test";
import { foldOperations } from "./apply-diff.ts";
import type { ValidationError, ValidationResult } from "./errors.ts";
import { validateReferentialIntegrity } from "./referential-integrity.ts";
import type { Manifest, Operation, Workflow } from "./types.ts";
import { validateDiff, validateManifest, validateManifestFull } from "./validate.ts";

// --- 題材 --------------------------------------------------------------------------

/** 評価の表(トリガー元)と、その履歴の表(書き込み先)と、実行履歴の表。 */
function baseManifest(): Manifest {
  return {
    app: {
      id: "assessment-app",
      name: "評価",
      tables: [
        {
          id: "assessments",
          name: "評価",
          fields: [
            { id: "verdict", name: "判定", type: "text" },
            { id: "score", name: "点数", type: "number" },
            { id: "passed", name: "合格", type: "boolean" },
            { id: "due", name: "期日", type: "date" },
          ],
        },
        {
          id: "assessment_log",
          name: "評価の履歴",
          fields: [
            { id: "assessment", name: "評価", type: "text" },
            { id: "actor", name: "操作者", type: "text" },
            { id: "actor_login", name: "ログイン名", type: "text" },
            { id: "actor_role", name: "役割", type: "text" },
            { id: "before", name: "更新前", type: "text" },
            { id: "after", name: "更新後", type: "text" },
            { id: "score_before", name: "更新前の点数", type: "number" },
            { id: "passed_before", name: "更新前の合否", type: "boolean" },
            { id: "at", name: "時刻", type: "text" },
            { id: "day", name: "日付", type: "date" },
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
      views: [],
    },
  };
}

/** 評価の行が更新されたら、履歴の表に1行書くワークフロー(`ADR-0500` §Decision 1 の例の形)。 */
function logWorkflow(values: Record<string, string>, trigger?: Workflow["trigger"]): Workflow {
  return {
    id: "log_change",
    name: "評価の変更を残す",
    trigger: trigger ?? { type: "on_update", table: "assessments" },
    actions: [{ action: "create_record", table: "assessment_log", values }],
    history_table: "wf-runs",
  };
}

function manifestWith(...workflows: Workflow[]): Manifest {
  const manifest = baseManifest();
  manifest.app.workflows = workflows;
  return manifest;
}

function expectInvalid(result: ValidationResult): ValidationError[] {
  expect(result.valid).toBe(false);
  if (result.valid) {
    throw new Error("expected invalid");
  }
  return result.errors;
}

function errorsAt(errors: readonly ValidationError[], path: string): ValidationError[] {
  return errors.filter((error) => error.path === path);
}

function oneErrorAt(errors: readonly ValidationError[], path: string): ValidationError {
  const matched = errorsAt(errors, path);
  if (matched.length !== 1 || matched[0] === undefined) {
    throw new Error(`パス ${path} のエラーが1件ではありません: ${JSON.stringify(errors)}`);
  }
  return matched[0];
}

function whole(error: ValidationError): string {
  return `${error.message}${error.hint ?? ""}`;
}

const VALUES_PATH = "/app/workflows/0/actions/0/values";

// --- 1. スキーマ ---------------------------------------------------------------------

describe("スキーマ: values だけが5形を受ける", () => {
  test("5形はどれも values に書ける(on_update)", () => {
    const manifest = manifestWith(
      logWorkflow({
        assessment: "$record._id",
        actor: "$actor.id",
        actor_login: "$actor.login",
        actor_role: "$actor.role",
        before: "$previous.verdict",
        after: "$record.verdict",
        at: "$now",
      }),
    );
    expect(validateManifest(manifest)).toEqual({ valid: true });
    expect(validateManifestFull(manifest)).toEqual({ valid: true });
  });

  test("今日の形($record の2形・リテラル)は今日どおり受ける", () => {
    const manifest = manifestWith(
      logWorkflow({ assessment: "$record._id", after: "$record.verdict", before: "固定の文字列" }),
    );
    expect(validateManifestFull(manifest)).toEqual({ valid: true });
  });

  for (const sixth of [
    "$actor.email",
    "$actor",
    "$actor.",
    "$actor.id.x",
    "$previous._id",
    "$previous._updated_at",
    "$previous.",
    "$previous.Verdict",
    "$previous.a.b",
    "$nowx",
    "$now.x",
    "$now()",
    "$foo",
    "$today",
  ]) {
    test(`6形目 ${sixth} は values でも断る`, () => {
      const errors = expectInvalid(validateManifest(manifestWith(logWorkflow({ before: sixth }))));
      expect(errorsAt(errors, `${VALUES_PATH}/before`).length).toBeGreaterThan(0);
    });
  }

  test("5形を前置き・連結の形で書くことはできない", () => {
    for (const joined of ["$now です", "by $actor.id", "$actor.id$now", " $now"]) {
      // `$` で始まらない値はリテラルとして通る(今日の action_value の else と同じ)ので、
      // `$` で始まる連結だけが断られる。リテラルとして通ったものは置換されない。
      const result = validateManifest(manifestWith(logWorkflow({ before: joined })));
      if (joined.startsWith("$")) {
        expect(result.valid).toBe(false);
      } else {
        expect(result.valid).toBe(true);
      }
    }
  });

  for (const fresh of ["$actor.id", "$now", "$previous.verdict"]) {
    test(`update_record の target に ${fresh} は書けない`, () => {
      const workflow = logWorkflow({ after: "x" });
      workflow.actions = [
        { action: "update_record", table: "assessments", target: fresh, values: { verdict: "x" } },
      ];
      const errors = expectInvalid(validateManifest(manifestWith(workflow)));
      expect(errorsAt(errors, "/app/workflows/0/actions/0/target").length).toBeGreaterThan(0);
    });

    test(`call_external の payload に ${fresh} は書けない`, () => {
      const workflow = logWorkflow({ after: "x" });
      workflow.actions = [
        {
          action: "call_external",
          connection: "外部",
          destination: "https://example.com/hook",
          payload: { who: fresh },
        },
      ];
      const errors = expectInvalid(validateManifest(manifestWith(workflow)));
      expect(errorsAt(errors, "/app/workflows/0/actions/0/payload/who").length).toBeGreaterThan(0);
    });

    test(`ai_transform の input と fallback に ${fresh} は書けない`, () => {
      const workflow = logWorkflow({ after: "x" });
      workflow.actions = [
        {
          action: "ai_transform",
          capability: "要約",
          prompt: "要約して",
          input: { text: fresh },
          output_field: "verdict",
          fallback: fresh,
        },
      ];
      const errors = expectInvalid(validateManifest(manifestWith(workflow)));
      expect(errorsAt(errors, "/app/workflows/0/actions/0/input/text").length).toBeGreaterThan(0);
      expect(errorsAt(errors, "/app/workflows/0/actions/0/fallback").length).toBeGreaterThan(0);
    });
  }
});

describe("スキーマ: changed_fields は on_update だけで書ける", () => {
  test("on_update に changed_fields を書ける", () => {
    const manifest = manifestWith(
      logWorkflow(
        { before: "$previous.verdict", after: "$record.verdict" },
        { type: "on_update", table: "assessments", changed_fields: ["verdict", "score"] },
      ),
    );
    expect(validateManifestFull(manifest)).toEqual({ valid: true });
  });

  const others: Workflow["trigger"][] = [
    { type: "on_create", table: "assessments", changed_fields: ["verdict"] } as never,
    { type: "manual", table: "assessments", changed_fields: ["verdict"] } as never,
    { type: "schedule", at: { hour: 9, minute: 0 }, changed_fields: ["verdict"] } as never,
    {
      type: "schedule",
      table: "assessments",
      at: { hour: 9, minute: 0 },
      changed_fields: ["verdict"],
    } as never,
  ];
  for (const trigger of others) {
    test(`${trigger.type}${trigger.table === undefined ? "" : "(table あり)"} には changed_fields を書けない`, () => {
      const errors = expectInvalid(
        validateManifest(manifestWith(logWorkflow({ after: "x" }, trigger))),
      );
      const found = errorsAt(errors, "/app/workflows/0/trigger/changed_fields");
      expect(found.length).toBeGreaterThan(0);
      expect(found[0]?.message).toContain("changed_fields");
    });
  }

  test("空の配列と重複は断る", () => {
    for (const changed of [[], ["verdict", "verdict"]]) {
      const errors = expectInvalid(
        validateManifest(
          manifestWith(
            logWorkflow(
              { after: "x" },
              { type: "on_update", table: "assessments", changed_fields: changed },
            ),
          ),
        ),
      );
      expect(errorsAt(errors, "/app/workflows/0/trigger/changed_fields").length).toBeGreaterThan(0);
    }
  });

  test("_ で始まる項目(予約列)は書けない", () => {
    const errors = expectInvalid(
      validateManifest(
        manifestWith(
          logWorkflow(
            { after: "x" },
            { type: "on_update", table: "assessments", changed_fields: ["_updated_at"] },
          ),
        ),
      ),
    );
    expect(errorsAt(errors, "/app/workflows/0/trigger/changed_fields/0").length).toBeGreaterThan(0);
  });

  test("差分の経路(add_workflow)でも on_create の changed_fields を断る", () => {
    const errors = expectInvalid(
      validateDiff({
        diff_id: "d-cf",
        intent: "変わったときだけ",
        operations: [
          {
            op: "add_workflow",
            workflow: logWorkflow({ after: "x" }, {
              type: "on_create",
              table: "assessments",
              changed_fields: ["verdict"],
            } as never),
          },
        ],
      }),
    );
    expect(
      errorsAt(errors, "/operations/0/workflow/trigger/changed_fields").length,
    ).toBeGreaterThan(0);
  });
});

/** 島(関数)を1つ持ち、それを呼ぶワークフローを持つマニフェスト。 */
function islandManifest(input: unknown, trigger: Workflow["trigger"]): Manifest {
  const manifest = manifestWith({
    id: "run_island",
    name: "島を呼ぶ",
    trigger,
    actions: [{ action: "run_function", function: "calc", output_table: "assessment_log" }],
    history_table: "wf-runs",
  });
  manifest.app.functions = [
    {
      id: "calc",
      name: "計算",
      input: input as never,
      code: "export default function () { return []; }",
      output: { fields: [{ id: "before", type: "text" }] },
    },
  ];
  return manifest;
}

describe("スキーマ: function_input.source に actor と previous を受ける", () => {
  test("source: actor / previous を書ける(on_update から呼ぶ)", () => {
    for (const source of ["actor", "previous"]) {
      const manifest = islandManifest({ source }, { type: "on_update", table: "assessments" });
      expect(validateManifestFull(manifest)).toEqual({ valid: true });
    }
  });

  test("配列形の要素にも書ける", () => {
    const manifest = islandManifest(
      [{ source: "record" }, { source: "actor" }, { source: "previous" }],
      { type: "on_update", table: "assessments" },
    );
    expect(validateManifestFull(manifest)).toEqual({ valid: true });
  });

  test("source: actor / previous に table / view / via は書けない", () => {
    for (const source of ["actor", "previous"]) {
      for (const extra of [{ table: "assessments" }, { view: "v" }, { via: "x" }]) {
        const result = validateManifest(
          islandManifest({ source, ...extra }, { type: "on_update", table: "assessments" }),
        );
        expect(result.valid).toBe(false);
      }
    }
  });

  test("6値目は語彙に無い", () => {
    const result = validateManifest(
      islandManifest({ source: "now" }, { type: "on_update", table: "assessments" }),
    );
    expect(result.valid).toBe(false);
  });
});

// --- 2. 適用時(参照整合性) -------------------------------------------------------------

describe("適用時: $previous は on_update の外で断る(受け入れ基準2)", () => {
  const outside: [string, Workflow["trigger"]][] = [
    ["on_create", { type: "on_create", table: "assessments" }],
    [
      "schedule(table あり)",
      { type: "schedule", table: "assessments", at: { hour: 9, minute: 0 } },
    ],
    ["schedule(table なし)", { type: "schedule", at: { hour: 9, minute: 0 } }],
    ["manual", { type: "manual", table: "assessments" }],
  ];
  for (const [label, trigger] of outside) {
    test(`${label} のワークフローの $previous を理由つきで断る`, () => {
      const manifest = manifestWith(logWorkflow({ before: "$previous.verdict" }, trigger));
      expect(validateManifest(manifest)).toEqual({ valid: true });
      const errors = expectInvalid(validateReferentialIntegrity(manifest));
      const error = oneErrorAt(errors, `${VALUES_PATH}/before`);
      expect(error.message).toContain("$previous.verdict");
      expect(error.message).toContain("on_update");
      expect(error.hint ?? "").toContain("on_update");
    });
  }

  test("on_update の $previous は受ける", () => {
    const manifest = manifestWith(logWorkflow({ before: "$previous.verdict" }));
    expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
  });

  test("$actor と $now は on_create・schedule・manual でも受ける", () => {
    const triggers: Workflow["trigger"][] = [
      { type: "on_create", table: "assessments" },
      { type: "schedule", at: { hour: 9, minute: 0 } },
      { type: "manual", table: "assessments" },
    ];
    for (const trigger of triggers) {
      const manifest = manifestWith(
        logWorkflow({ actor: "$actor.id", actor_role: "$actor.role", at: "$now" }, trigger),
      );
      expect(validateManifestFull(manifest)).toEqual({ valid: true });
    }
  });

  test("update_record の values の $previous も同じく断る", () => {
    const workflow = logWorkflow({}, { type: "on_create", table: "assessments" });
    workflow.actions = [
      {
        action: "update_record",
        table: "assessments",
        target: "$record._id",
        values: { verdict: "$previous.verdict" },
      },
    ];
    const errors = expectInvalid(validateReferentialIntegrity(manifestWith(workflow)));
    expect(oneErrorAt(errors, `${VALUES_PATH}/verdict`).message).toContain("on_update");
  });
});

describe("適用時: 項目の実在", () => {
  test("$previous.<x> の項目がトリガー元の表に無ければ断る", () => {
    const manifest = manifestWith(logWorkflow({ before: "$previous.nothing" }));
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = oneErrorAt(errors, `${VALUES_PATH}/before`);
    expect(error.message).toContain("nothing");
    expect(error.allowed_values).toEqual(["verdict", "score", "passed", "due"]);
  });

  test("書き込み先にだけ在る項目名を $previous に書いても断る(見るのはトリガー元)", () => {
    const manifest = manifestWith(logWorkflow({ before: "$previous.actor_login" }));
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    expect(oneErrorAt(errors, `${VALUES_PATH}/before`).message).toContain("actor_login");
  });

  test("changed_fields の項目がトリガー元の表に無ければ断る", () => {
    const manifest = manifestWith(
      logWorkflow(
        { after: "$record.verdict" },
        { type: "on_update", table: "assessments", changed_fields: ["verdict", "nothing"] },
      ),
    );
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    const error = oneErrorAt(errors, "/app/workflows/0/trigger/changed_fields/1");
    expect(error.message).toContain("nothing");
    expect(error.allowed_values).toEqual(["verdict", "score", "passed", "due"]);
    expect(errorsAt(errors, "/app/workflows/0/trigger/changed_fields/0")).toHaveLength(0);
  });
});

describe("適用時: source: previous の入力を持つ関数は on_update の外から呼べない(ADR-0083 限定4 の作法)", () => {
  const outside: Workflow["trigger"][] = [
    { type: "on_create", table: "assessments" },
    { type: "schedule", table: "assessments", at: { hour: 9, minute: 0 } },
    { type: "schedule", at: { hour: 9, minute: 0 } },
    { type: "manual", table: "assessments" },
  ];
  for (const trigger of outside) {
    test(`${trigger.type}${trigger.table === undefined ? "" : "(table あり)"} から呼ぶと断る`, () => {
      const manifest = islandManifest({ source: "previous" }, trigger);
      expect(validateManifest(manifest)).toEqual({ valid: true });
      const errors = expectInvalid(validateReferentialIntegrity(manifest));
      const error = oneErrorAt(errors, "/app/functions/0/input/source");
      expect(error.message).toContain("run_island");
      expect(error.message).toContain("on_update");
    });
  }

  test("配列形の要素でも、その要素の位置で断る", () => {
    const manifest = islandManifest([{ source: "record" }, { source: "previous" }], {
      type: "on_create",
      table: "assessments",
    });
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    oneErrorAt(errors, "/app/functions/0/input/1/source");
  });

  test("source: actor はどのトリガーから呼んでも受ける", () => {
    for (const trigger of outside) {
      const manifest = islandManifest({ source: "actor" }, trigger);
      expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
    }
  });
});

describe("適用時: 型の整合(ADR-0029 の互換表のセルは動かさない)", () => {
  test("$previous.<数値の列> を数値の列へ、$previous.<真偽の列> を真偽の列へ書ける", () => {
    const manifest = manifestWith(
      logWorkflow({ score_before: "$previous.score", passed_before: "$previous.passed" }),
    );
    expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
  });

  test("$previous.<数値の列> を text の列へ書くと、$record.<数値の列> と同じく断る", () => {
    const viaRecord = expectInvalid(
      validateReferentialIntegrity(manifestWith(logWorkflow({ before: "$record.score" }))),
    );
    const viaPrevious = expectInvalid(
      validateReferentialIntegrity(manifestWith(logWorkflow({ before: "$previous.score" }))),
    );
    expect(errorsAt(viaRecord, `${VALUES_PATH}/before`)).toHaveLength(1);
    const error = oneErrorAt(viaPrevious, `${VALUES_PATH}/before`);
    expect(error.message).toContain("$previous.score");
    expect(error.message).toContain("数値");
  });

  test("$actor.* と $now は string として扱う(text・date の列へ書ける)", () => {
    const manifest = manifestWith(
      logWorkflow({
        actor: "$actor.id",
        actor_login: "$actor.login",
        actor_role: "$actor.role",
        at: "$now",
        day: "$now",
      }),
    );
    expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });
  });

  test("$actor.* と $now は数値・真偽の列へは書けない", () => {
    for (const value of ["$actor.id", "$actor.role", "$now"]) {
      const errors = expectInvalid(
        validateReferentialIntegrity(
          manifestWith(logWorkflow({ score_before: value, passed_before: value })),
        ),
      );
      expect(oneErrorAt(errors, `${VALUES_PATH}/score_before`).message).toContain("文字列");
      expect(oneErrorAt(errors, `${VALUES_PATH}/passed_before`).message).toContain("文字列");
    }
  });
});

// --- 3. 文面 -------------------------------------------------------------------------

describe("文面: values の位置の違反が罠の汎用文にならず、$record だけと嘘を言わない", () => {
  function valuesError(value: unknown): ValidationError {
    const errors = expectInvalid(
      validateManifest(manifestWith(logWorkflow({ before: value as string }))),
    );
    const found = errorsAt(errors, `${VALUES_PATH}/before`);
    if (found.length !== 1 || found[0] === undefined) {
      throw new Error(`values の位置のエラーが1件ではありません: ${JSON.stringify(errors)}`);
    }
    return found[0];
  }

  test("6形目($actor.email)に識別子の汎用文(英小文字で始まり…)を出さない", () => {
    const error = valuesError("$actor.email");
    expect(whole(error)).not.toContain("英小文字で始まり");
    expect(error.message).toContain("$actor.email");
    // 書ける5形を字面で示す。
    for (const form of ["$actor.id", "$actor.login", "$actor.role", "$previous.", "$now"]) {
      expect(whole(error)).toContain(form);
    }
  });

  test("$foo にも、values の位置では「$record の形だけ」と言わない", () => {
    const error = valuesError("$foo");
    expect(whole(error)).not.toContain("英小文字で始まり");
    expect(whole(error)).not.toContain(
      '値の全体が "$record.<フィールドID>" であるか、全体が固定の文字列であるかの、どちらかです。',
    );
    expect(whole(error)).toContain("$record.<フィールドID>");
    expect(whole(error)).toContain("$previous.<フィールドID>");
    expect(whole(error)).toContain("$now");
  });

  test("波括弧(口ひげ記法)は今日どおり「そのまま書き込まれる」側の文で、5形も示す", () => {
    const error = valuesError("{{actor.id}}");
    expect(error.message).toContain("そのまま");
    expect(whole(error)).toContain("$actor.id");
  });

  test("true を書いたとき「string を指定してください」と言わず、5形を隠さない", () => {
    const error = valuesError(true);
    expect(whole(error)).not.toContain("string を指定してください");
    expect(error.message).not.toContain('(固定の文字列か、"$record.<フィールドID>" の形の参照)');
    expect(error.message).toContain("$previous.<フィールドID>");
    expect(error.message).toContain("$now");
  });

  test("values の外の位置(target)は今日の文面のまま(5形を書けると言わない)", () => {
    const workflow = logWorkflow({ after: "x" });
    workflow.actions = [
      { action: "update_record", table: "assessments", target: "$foo", values: { verdict: "x" } },
    ];
    const errors = expectInvalid(validateManifest(manifestWith(workflow)));
    const error = oneErrorAt(errors, "/app/workflows/0/actions/0/target");
    expect(whole(error)).toContain("$record.<フィールドID>");
    expect(whole(error)).not.toContain("$previous");
    expect(whole(error)).not.toContain("$actor");
  });

  test("changed_fields を on_create に書いたとき、書ける種別(on_update)が分かる", () => {
    const errors = expectInvalid(
      validateManifest(
        manifestWith(
          logWorkflow({ after: "x" }, {
            type: "on_create",
            table: "assessments",
            changed_fields: ["verdict"],
          } as never),
        ),
      ),
    );
    const error = oneErrorAt(errors, "/app/workflows/0/trigger/changed_fields");
    expect(error.message).toContain("changed_fields");
    expect(error.message).toContain("指定できません");
  });
});

// --- 4. 名前の付け替え(D-V23-99) -------------------------------------------------------

describe("名前の付け替え: $previous と changed_fields が追随する", () => {
  function renamed(operations: Operation[]): Manifest {
    const manifest = manifestWith(
      logWorkflow(
        { before: "$previous.verdict", after: "$record.verdict", score_before: "$previous.score" },
        { type: "on_update", table: "assessments", changed_fields: ["verdict", "score"] },
      ),
    );
    const folded = foldOperations(manifest, operations);
    if (!folded.valid) {
      throw new Error(`畳み込みに失敗しました: ${JSON.stringify(folded.errors)}`);
    }
    return folded.manifest;
  }

  test("トリガー元の項目名を付け替えると、$previous と changed_fields が新しい名前になる", () => {
    const next = renamed([
      { op: "change_field", table: "assessments", field: "verdict", changes: { id: "judgement" } },
    ]);
    const workflow = next.app.workflows?.[0];
    expect(workflow?.trigger).toEqual({
      type: "on_update",
      table: "assessments",
      changed_fields: ["judgement", "score"],
    });
    const action = workflow?.actions[0];
    expect(action?.action === "create_record" ? action.values : undefined).toEqual({
      before: "$previous.judgement",
      after: "$record.judgement",
      score_before: "$previous.score",
    });
    expect(validateManifestFull(next)).toEqual({ valid: true });
  });

  test("書き込み先の表の同じ名前の項目を付け替えても、$previous と changed_fields は動かない", () => {
    const next = renamed([
      { op: "change_field", table: "assessment_log", field: "before", changes: { id: "prior" } },
    ]);
    const workflow = next.app.workflows?.[0];
    expect(workflow?.trigger).toEqual({
      type: "on_update",
      table: "assessments",
      changed_fields: ["verdict", "score"],
    });
    const action = workflow?.actions[0];
    expect(action?.action === "create_record" ? action.values : undefined).toEqual({
      prior: "$previous.verdict",
      after: "$record.verdict",
      score_before: "$previous.score",
    });
  });

  test("前方一致で壊さない($previous.score の付け替えは $previous.score_x に及ばない)", () => {
    const manifest = baseManifest();
    const assessments = manifest.app.tables[0];
    assessments?.fields.push({ id: "score_x", name: "別の点数", type: "number" });
    manifest.app.workflows = [
      logWorkflow(
        { score_before: "$previous.score_x" },
        { type: "on_update", table: "assessments", changed_fields: ["score_x"] },
      ),
    ];
    const folded = foldOperations(manifest, [
      { op: "change_field", table: "assessments", field: "score", changes: { id: "points" } },
    ]);
    if (!folded.valid) {
      throw new Error(`畳み込みに失敗しました: ${JSON.stringify(folded.errors)}`);
    }
    const workflow = folded.manifest.app.workflows?.[0];
    expect(workflow?.trigger).toEqual({
      type: "on_update",
      table: "assessments",
      changed_fields: ["score_x"],
    });
    const action = workflow?.actions[0];
    expect(action?.action === "create_record" ? action.values : undefined).toEqual({
      score_before: "$previous.score_x",
    });
  });
});

// --- 5. `V23-M4-T10` の処置(独立点検の中3。`ADR-0531` 3・限定3)-------------------------

describe("適用時: $actor.* の書き込み先は文字の項目(text・long_text)だけ", () => {
  /** 書き込み先の表に、文字でない文字列系の項目(date・select・reference・image・file)を足した題材。 */
  function manifestWithStringish(values: Record<string, string>): Manifest {
    const manifest = manifestWith(logWorkflow(values));
    const log = manifest.app.tables.find((table) => table.id === "assessment_log");
    log?.fields.push(
      { id: "memo", name: "メモ", type: "long_text" },
      { id: "kind", name: "種別", type: "select", options: ["a", "b"] },
      { id: "who", name: "担当", type: "reference", reference_table: "assessments" },
      { id: "pic", name: "写真", type: "image" },
      { id: "doc", name: "書類", type: "file" },
    );
    return manifest;
  }

  test("text・long_text の項目へは今日どおり書ける", () => {
    for (const value of ["$actor.id", "$actor.login", "$actor.role"]) {
      expect(
        validateReferentialIntegrity(manifestWithStringish({ actor: value, memo: value })),
      ).toEqual({
        valid: true,
      });
    }
  });

  test("date・select・reference・image・file の項目へ書く差分は、理由つきで断る", () => {
    for (const value of ["$actor.id", "$actor.login", "$actor.role"]) {
      for (const [key, type] of [
        ["day", "date"],
        ["kind", "select"],
        ["who", "reference"],
        ["pic", "image"],
        ["doc", "file"],
      ] as const) {
        const errors = expectInvalid(
          validateReferentialIntegrity(manifestWithStringish({ [key]: value })),
        );
        const error = oneErrorAt(errors, `${VALUES_PATH}/${key}`);
        expect(error.message).toContain(value);
        expect(error.message).toContain(type);
        expect(whole(error)).toContain("text");
        expect(whole(error)).toContain("long_text");
      }
    }
  });

  test("$now を date へ、固定の文字列・$record を date へ書く形は今日どおり(互換表のセルは動かさない)", () => {
    expect(validateReferentialIntegrity(manifestWithStringish({ day: "$now", kind: "a" }))).toEqual(
      {
        valid: true,
      },
    );
    expect(
      validateReferentialIntegrity(
        manifestWithStringish({ day: "2026-09-30", who: "$record._id" }),
      ),
    ).toEqual({ valid: true });
  });

  test("update_record の values でも同じく断る", () => {
    const manifest = manifestWithStringish({ actor: "$actor.id" });
    manifest.app.workflows = [
      {
        id: "fix_day",
        name: "日付を直す",
        trigger: { type: "on_update", table: "assessments" },
        actions: [
          {
            action: "update_record",
            table: "assessment_log",
            target: "$record._id",
            values: { day: "$actor.id" },
          },
        ],
        history_table: "wf-runs",
      } as unknown as Workflow,
    ];
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    expect(oneErrorAt(errors, `${VALUES_PATH}/day`).message).toContain("$actor.id");
  });
});
