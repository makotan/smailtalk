import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ValidationError, ValidationResult } from "./errors.ts";
import { DIFF_OPS, RESOURCE_KINDS } from "./types.ts";
import { validateDiff, validateManifest } from "./validate.ts";

/**
 * 関数リソース `function` の語彙(ADR-0024 / V1-M6-T05 第1段)の型とスキーマの検査。
 *
 * `workflow-schema.test.ts` と同じ作法で、**正準スキーマ(`schemas/*.schema.json`)そのもの**を
 * 読んで構造を固定する検査と、`validateManifest` / `validateDiff` を通した挙動の検査を
 * 併せて置く。
 *
 * **run_function(ワークフローアクション)と島の実行は第2段(T03〜)であり、ここでは
 * 一切足していない** —— 本ファイルは「関数を定義・検証できる」ところだけを固定する。
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
 * ADR-0024 §Decision のサンプル(貸出集計アプリに月ごとに数える関数を1本足したもの)。
 *
 * `loans`(入力テーブル)と `loans-by-month`(list_view)はユーザが add_table / add_view で
 * 作る通常のリソースである。
 */
const functionManifest = {
  app: {
    id: "loan-tracker",
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
    functions: [
      {
        id: "count-by-month",
        name: "月ごとに貸出を数える",
        code: "export default (rows) => { return rows; };",
        input: { source: "table", table: "loans" },
        output: {
          fields: [
            { id: "month", type: "text" },
            { id: "count", type: "number" },
          ],
        },
        capabilities: [],
      },
    ],
  },
};

/** 関数1本を差し替えたマニフェストを作る。 */
function withFunction(mutate: (fn: Any) => void): Any {
  const manifest = clone(functionManifest) as Any;
  mutate(manifest.app.functions[0]);
  return manifest;
}

describe("語彙の定数(ADR-0024 §増分表)", () => {
  test("RESOURCE_KINDS は7種で、末尾が function である", () => {
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

  test("DIFF_OPS は16種で、関数3種が12〜14番目にある(末尾は ADR-0047 の set_theme)", () => {
    // **V3-M1-T03(ADR-0047)が16種目 set_theme を末尾に足した**(§10 の規則1)。
    // 関数3種の**位置と順序**はここが主張の中身なので、末尾から数えるのをやめて
    // 12〜14番目を名指しする(「末尾3種」は set_theme が入った瞬間に偽になる)。
    expect([...DIFF_OPS].slice(12, 15)).toEqual([
      "add_function",
      "update_function",
      "remove_function",
    ]);
    // **【`V8-M16` / `J-G1b` / `D-V8-31`】期待値を 17 → 18 に書き換えた —— 18種目 `set_roles` を足したため。検査は消していない。**
    // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】**
    // **旧(逐語)**: `expect(DIFF_OPS.length).toBe(18);`
    // **`set_user_kinds` を撤去したので 18 → 17。**関数3種の位置(12〜14番目)は1バイトも動いていない。
    expect(DIFF_OPS.length).toBe(17); // 【`V5-M17b` / `ADR-0248`】16 → 17(`set_user_kinds` が17種目)/【`V8-M16`】17 → 18(`set_roles` が18種目)。**この行が固定していたのは「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**
  });

  test("op_name の enum は DIFF_OPS と1対1・同順である", () => {
    const opName = canonicalSchema("diff.schema.json").$defs.op_name as Any;
    expect(opName.enum).toEqual([...DIFF_OPS]);
  });
});

describe("マニフェストの関数 / 正常系", () => {
  test("functions を持つマニフェストが通過する", () => {
    expect(validateManifest(functionManifest)).toEqual({ valid: true });
  });

  test("functions を持たないマニフェストも通過する(後方互換)", () => {
    const manifest = clone(functionManifest) as Any;
    delete manifest.app.functions;
    expect(validateManifest(manifest)).toEqual({ valid: true });
  });

  test("functions が空配列でも通過する", () => {
    const manifest = clone(functionManifest) as Any;
    manifest.app.functions = [];
    expect(validateManifest(manifest)).toEqual({ valid: true });
  });

  test("$defs/app.required に functions は入っていない(既存マニフェストを壊さない)", () => {
    const app = canonicalSchema("manifest.schema.json").$defs.app as Any;
    expect(app.required).toEqual(["id", "name", "tables", "views"]);
    expect(app.properties.functions).toBeDefined();
  });

  test("capabilities は省略できる(既定 [])", () => {
    expect(
      validateManifest(
        withFunction((fn) => {
          fn.capabilities = undefined;
          delete fn.capabilities;
        }),
      ),
    ).toEqual({ valid: true });
  });

  test("入力3種(table / view / record)がそれぞれ通過する", () => {
    expect(
      validateManifest(
        withFunction((fn) => {
          fn.input = { source: "table", table: "loans" };
        }),
      ),
    ).toEqual({ valid: true });
    expect(
      validateManifest(
        withFunction((fn) => {
          fn.input = { source: "view", view: "loan-list" };
        }),
      ),
    ).toEqual({ valid: true });
    expect(
      validateManifest(
        withFunction((fn) => {
          fn.input = { source: "record" };
        }),
      ),
    ).toEqual({ valid: true });
  });

  test("output.fields の型は FIELD_TYPES の7種すべてを書ける", () => {
    for (const type of ["text", "long_text", "number", "boolean", "date", "select", "reference"]) {
      expect(
        validateManifest(
          withFunction((fn) => {
            fn.output = { fields: [{ id: "value", type }] };
          }),
        ),
      ).toEqual({ valid: true });
    }
  });
});

describe("マニフェストの関数 / 異常系", () => {
  test("必須キー(id / name / code / input / output)が無いと拒否する", () => {
    for (const missing of ["id", "name", "code", "input", "output"]) {
      expectInvalid(
        validateManifest(
          withFunction((fn) => {
            delete fn[missing];
          }),
        ),
      );
    }
  });

  test("関数に未知キーを足すと拒否する(additionalProperties: false)", () => {
    expectInvalid(
      validateManifest(
        withFunction((fn) => {
          fn.enabled = true;
        }),
      ),
    );
  });

  test("input.source が語彙外なら拒否する", () => {
    expectInvalid(
      validateManifest(
        withFunction((fn) => {
          fn.input = { source: "query", table: "loans" };
        }),
      ),
    );
  });

  test("source=table なのに view を書くと拒否する", () => {
    expectInvalid(
      validateManifest(
        withFunction((fn) => {
          fn.input = { source: "table", table: "loans", view: "loan-list" };
        }),
      ),
    );
  });

  test("source=table なのに table が無いと拒否する", () => {
    expectInvalid(
      validateManifest(
        withFunction((fn) => {
          fn.input = { source: "table" };
        }),
      ),
    );
  });

  test("source=view なのに table を書くと拒否する", () => {
    expectInvalid(
      validateManifest(
        withFunction((fn) => {
          fn.input = { source: "view", view: "loan-list", table: "loans" };
        }),
      ),
    );
  });

  test("source=record なのに table / view を書くと拒否する", () => {
    expectInvalid(
      validateManifest(
        withFunction((fn) => {
          fn.input = { source: "record", table: "loans" };
        }),
      ),
    );
    expectInvalid(
      validateManifest(
        withFunction((fn) => {
          fn.input = { source: "record", view: "loan-list" };
        }),
      ),
    );
  });

  test("input にクエリ言語(where / filter / select / count / group_by)を書くと拒否する(限定3)", () => {
    for (const extra of [
      { where: "borrowed_on > 0" },
      { filter: [{ field: "borrower", equals: "x" }] },
      { select: ["borrower"] },
      { count: true },
      { group_by: "borrowed_on" },
    ]) {
      expectInvalid(
        validateManifest(
          withFunction((fn) => {
            fn.input = { source: "table", table: "loans", ...extra };
          }),
        ),
      );
    }
  });

  test("output.fields[].type が語彙外なら拒否する(計算フィールド型を足さない。限定1)", () => {
    expectInvalid(
      validateManifest(
        withFunction((fn) => {
          fn.output = { fields: [{ id: "value", type: "computed" }] };
        }),
      ),
    );
  });

  test("output.fields が空配列なら拒否する", () => {
    expectInvalid(
      validateManifest(
        withFunction((fn) => {
          fn.output = { fields: [] };
        }),
      ),
    );
  });

  test("output.fields[] に未知キーを足すと拒否する", () => {
    expectInvalid(
      validateManifest(
        withFunction((fn) => {
          fn.output = { fields: [{ id: "value", type: "text", options: ["a"] }] };
        }),
      ),
    );
  });

  test("code が空文字なら拒否する", () => {
    expectInvalid(
      validateManifest(
        withFunction((fn) => {
          fn.code = "";
        }),
      ),
    );
  });
});

describe("差分パッチの関数 op(ADR-0024 §4c)", () => {
  const fn = functionManifest.app.functions[0];

  function diffWith(operation: Any): Any {
    return { diff_id: "d-0200", intent: "月ごとの集計を関数で持ちたい", operations: [operation] };
  }

  test("add_function の差分が通過する", () => {
    expect(validateDiff(diffWith({ op: "add_function", function: clone(fn) }))).toEqual({
      valid: true,
    });
  });

  test("update_function の差分が通過する", () => {
    expect(validateDiff(diffWith({ op: "update_function", function: clone(fn) }))).toEqual({
      valid: true,
    });
  });

  test("remove_function の差分が通過する", () => {
    expect(
      validateDiff(diffWith({ op: "remove_function", function: { id: "count-by-month" } })),
    ).toEqual({ valid: true });
  });

  test("add_function に function が無いと拒否する", () => {
    expectInvalid(validateDiff(diffWith({ op: "add_function" })));
  });

  test("add_function に table を書くと拒否する(function 以外のキーを禁止)", () => {
    expectInvalid(
      validateDiff(diffWith({ op: "add_function", function: clone(fn), table: "loans" })),
    );
  });

  test("update_function / remove_function に workflow を書くと拒否する", () => {
    expectInvalid(
      validateDiff(diffWith({ op: "update_function", function: clone(fn), workflow: { id: "w" } })),
    );
    expectInvalid(
      validateDiff(
        diffWith({ op: "remove_function", function: { id: "count-by-month" }, workflow: {} }),
      ),
    );
  });

  test("remove_function の function に id 以外を書くと拒否する", () => {
    expectInvalid(
      validateDiff(
        diffWith({ op: "remove_function", function: { id: "count-by-month", name: "消す対象" } }),
      ),
    );
  });

  test("add_function の function が不正な定義なら拒否する(source=table で view も書いた)", () => {
    const broken = clone(fn) as Any;
    broken.input = { source: "table", table: "loans", view: "loan-list" };
    expectInvalid(validateDiff(diffWith({ op: "add_function", function: broken })));
  });

  test("既存12 op のいずれに function キーを書いても拒否する(全分岐の false 宣言)", () => {
    const bodies: Record<string, Any> = {
      add_table: { table: { id: "t", name: "T", fields: [{ id: "a", name: "A", type: "text" }] } },
      add_field: { table: "loans", field: { id: "a", name: "A", type: "text" } },
      add_view: { view: { id: "v", type: "list_view", table: "loans", columns: ["borrower"] } },
      update_view: { view: "loan-list", changes: { name: "一覧" } },
      remove_field: { table: "loans", field: "borrower" },
      remove_table: { table: "loans" },
      change_table: { table: "loans", changes: { name: "貸出" } },
      change_field: { table: "loans", field: "borrower", changes: { name: "借り手" } },
      remove_view: { view: "loan-list" },
      add_workflow: {
        workflow: {
          id: "w",
          name: "W",
          trigger: { type: "on_create", table: "loans" },
          actions: [{ action: "create_record", table: "loans", values: { borrower: "x" } }],
          history_table: "loans",
        },
      },
      update_workflow: {
        workflow: {
          id: "w",
          name: "W",
          trigger: { type: "on_create", table: "loans" },
          actions: [{ action: "create_record", table: "loans", values: { borrower: "x" } }],
          history_table: "loans",
        },
      },
      remove_workflow: { workflow: { id: "w" } },
    };
    for (const [op, body] of Object.entries(bodies)) {
      // まず function キーを付けない形が通ることを確かめる(前提の健全性)。
      expect(validateDiff(diffWith({ op, ...body }))).toEqual({ valid: true });
      expectInvalid(validateDiff(diffWith({ op, ...body, function: clone(fn) })));
    }
  });
});

// **【`V5-M17b` / `ADR-0248`】旧 describe 名の逐語は「$defs/operation.properties は8キーで閉じる(ADR-0024 §4c → ADR-0047 §4c)」。**
// **【`V8-M16` / `J-G1b` / `D-V8-31`】旧 describe 名の逐語は「$defs/operation.properties は9キーで閉じる(ADR-0024 §4c → ADR-0047 §4c → ADR-0248 §4c)」。**
// **10キー目 `roles` を足したので、名前と期待値を同時に実体へ合わせた(片方だけ直すと条文と実装のどちらかが嘘になる)。**
describe("$defs/operation.properties は10キーで閉じる(ADR-0024 §4c → ADR-0047 §4c → ADR-0248 §4c → V8-M16)", () => {
  const operation = canonicalSchema("diff.schema.json").$defs.operation as Any;

  // **【`V5-M17b` / `ADR-0248`】旧テスト名の逐語は「properties のキーはちょうど8つで、7キー目が function・8キー目が theme である」。**
  // **【`V8-M16` / `J-G1b` / `D-V8-31`】旧テスト名の逐語は「properties のキーはちょうど9つで、7キー目が function・8キー目が theme・9キー目が user_kinds である」。**
  test("properties のキーはちょうど10で、7キー目が function・8キー目が theme・9キー目が user_kinds・10キー目が roles である", () => {
    // **V3-M1-T03(ADR-0047 §4c)が8キー目 theme を足した。**ADR-0024 の「7キーで閉じる」は
    // 「8キーで閉じる」に改まる —— 破るには ADR-0013 §4c の3問に改めて答えたうえで
    // 門A を通すことが要る(ADR-0047 限定11 / §3a 8)。**ここが9つになったら、それは
    // 門A を通らない増分が入った合図である。**
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
      // **テスト名の「ちょうど10」「9キー目が user_kinds」は当時の逐語である**(テスト名は書き換えない)。
      // **【`V8-M16` / `J-G1b` / `D-V8-31`】10キー目。**上の「ここが10 になったら門A を
      // 通らない増分が入った合図」は制定時の文であり消していない —— **本件は門A の本審査
      // (限定採用)を通したうえで足した増分である。**ここが11 になったら、それは門A を
      // 通らない増分が入った合図である。
      "roles",
    ]);
  });

  test("既存12分岐すべてに function: false が入っている", () => {
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
      "add_workflow",
      "update_workflow",
      "remove_workflow",
    ];
    for (const op of existing) {
      const branch = (operation.allOf as Any[]).find(
        (each) => each.if.properties.op.const === op,
      ) as Any;
      expect(branch.then.properties.function).toBe(false);
    }
  });

  // **【`V5-M17b` / `ADR-0248`】旧テスト名の逐語は「関数3 op の分岐は function を必須にし、他5キーを禁止する」。**
  test("関数3 op の分岐は function を必須にし、他6キーを禁止する", () => {
    for (const op of ["add_function", "update_function", "remove_function"]) {
      const branch = (operation.allOf as Any[]).find(
        (each) => each.if.properties.op.const === op,
      ) as Any;
      expect(branch.then.required).toEqual(["function"]);
      const forbidden = Object.entries(branch.then.properties as Record<string, unknown>)
        .filter(([, sub]) => sub === false)
        .map(([name]) => name);
      // **`theme` は ADR-0047 が全既存分岐に足した8キー目の false 宣言である**
      // (§4c 問2 が書き換えた既存分岐を名指しで全15件列挙している)。
      // **【`V5-M17b` / `ADR-0248` §4c 問2】9キー目 `user_kinds` を全既存分岐で禁止した。**
      // **【`V8-M16` / `J-G1b` / `D-V8-31`】10キー目 `roles` を全既存17分岐で禁止したので、
      // 期待値に1件足した。検査は消していない。**
      // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】**
      // **旧(逐語)**: `expect(forbidden).toEqual(["table","field","view","changes","workflow","theme","user_kinds","roles"]);`
      // **`user_kinds` キーが消えたので、関数3分岐が禁じるのは7キーになった。**
      // **テスト名の「他6キー」は当時の逐語である**(テスト名は書き換えない)。
      expect(forbidden).toEqual([
        "table",
        "field",
        "view",
        "changes",
        "workflow",
        "theme",
        "roles",
      ]);
    }
  });
});
