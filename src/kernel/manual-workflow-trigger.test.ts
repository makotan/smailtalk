/**
 * `V5-M25-T01`(`L-G8` / `L-G9` / [`ADR-0174`](../../docs/adr/0174-manual-workflow-trigger.md))
 * —— **行のボタンから自動処理を名指しで起こせるようにした**ことの検査。
 *
 * ## これは何で、何ではないか(**丸めない**)
 *
 * - **通したのは「`manual` と宣言した、外部送信を含まないワークフローを、押した行1行を
 *   対象に起こせるようにする」ことだけである**(`ADR-0174` §限界3 の逐語どおり)。
 * - **【禁止】「行から自動処理を起こせるようになった」と限定なしに書かない。**
 * - **【禁止】「二重押しが防げるようになった」と書かない** —— 規則は
 *   [`ADR-0175`](../../docs/adr/0175-manual-trigger-idempotency-and-actor.md) が持ち、
 *   防ぐのは**実行中の重複だけ**である。
 * - **【禁止】「押した人が記録に残るようになった」と、変更履歴について書かない** ——
 *   **`_workflow_history` は今日も5列である**(`L-G11b` = 保留)。
 * - **`L-G9`(行のボタンからコードの島を起こす)は将来送りである。** **島の起動口を
 *   1本も作っていない**(限定7。下の (T01-7) 群が非テスト呼び出しの本数を数えている)。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import {
  armManifestForAutomation,
  fixtureOwnerValues,
  seedAutomationActor,
} from "./automation-actor-fixture.test.ts";
import { applyManifestDdl as applyManifestDdlRaw } from "./ddl.ts";
import { createRecord as createRecordRaw, listRecords, type RecordRow } from "./records.ts";
import type { Manifest, View, Workflow } from "./types.ts";
import { DIFF_OPS } from "./types.ts";
import { validateManifest, validateManifestFull } from "./validate.ts";
import { runManualWorkflow, WORKFLOW_HISTORY_COLUMNS } from "./workflow-runner.ts";

type Any = Record<string, unknown>;

/*
 * --- **【`V8-M26`(2026-08-10)で題材に「壁を開ける下ごしらえ」が入った】** -------------
 *
 * **`V8-M26-T03` が面(役割に束ねた権限)の既定を「閉じる」側へ倒したので、
 * 手動起動のアクションが書けなくなった。** **本ファイルの主題は手動起動の形と実行であって
 * 面ではないので、題材の側で壁を開ける** —— **実装は1バイトも緩めていない。**
 * **中身は `src/kernel/automation-actor-fixture.test.ts` の doc に全部書いた。**
 */

/** DDL を当てる直前に壁を開け、当てた直後に書き手を1人立てる。 */
function applyManifestDdl(database: Database, target: Manifest): void {
  armManifestForAutomation(target);
  applyManifestDdlRaw(database, target);
  seedAutomationActor(database);
}

/** 行を作る(**下ごしらえが持ち主の列を足した表にだけ書き手を入れる**)。 */
function createRecord(
  database: Database,
  target: Manifest,
  tableId: string,
  values: Record<string, unknown>,
): ReturnType<typeof createRecordRaw> {
  return createRecordRaw(database, target, tableId, fixtureOwnerValues(target, tableId, values));
}

function defs(): Record<string, Any> {
  return (manifestSchema as unknown as { $defs: Record<string, Any> }).$defs;
}

function triggerSchema(): Any {
  return defs().workflow_trigger as Any;
}

function viewActionSchema(): Any {
  return defs().view_action as Any;
}

function historyFields() {
  return [
    { id: "ran_at", name: "実行時刻", type: "date" as const },
    { id: "workflow", name: "ワークフロー", type: "text" as const },
    { id: "trigger_type", name: "きっかけ", type: "text" as const },
    { id: "status", name: "結果", type: "text" as const },
    { id: "error", name: "エラー", type: "long_text" as const },
  ];
}

/** `manual` のワークフロー1本(通知を1件作るだけ。外部送信を1つも含まない)。 */
const SHIP_WORKFLOW: Workflow = {
  id: "ship",
  name: "発送する",
  trigger: { type: "manual", table: "orders" },
  actions: [
    {
      action: "create_record",
      table: "notifications",
      values: { title: "発送しました", source: "$record._id" },
    },
  ],
  history_table: "wf-runs",
} as unknown as Workflow;

function baseManifest(views: View[] = [], workflows: Workflow[] = [SHIP_WORKFLOW]): Manifest {
  return {
    app: {
      id: "shop",
      name: "店",
      tables: [
        {
          id: "orders",
          name: "注文",
          fields: [
            { id: "title", name: "件名", type: "text" },
            { id: "state", name: "状態", type: "text" },
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
        { id: "wf-runs", name: "実行履歴", fields: historyFields() },
      ],
      views,
      workflows,
    },
  } as unknown as Manifest;
}

function orderList(actions?: unknown[]): View {
  return {
    id: "order-list",
    type: "list_view",
    table: "orders",
    columns: ["title"],
    ...(actions === undefined ? {} : { actions }),
  } as unknown as View;
}

function orderDetail(actions?: unknown[]): View {
  return {
    id: "order-detail",
    type: "detail_view",
    table: "orders",
    ...(actions === undefined ? {} : { actions }),
  } as unknown as View;
}

// ---------------------------------------------------------------------------
// (T01-1) `trigger.type` の4値目(ADR-0174 限定1)
// ---------------------------------------------------------------------------

describe("(T01-1) trigger.type に manual が1値だけ増えた(ADR-0174 限定1)", () => {
  test("enum は4値ちょうどで、綴りは manual に固定されている", () => {
    const type = (triggerSchema().properties as Any).type as Any;
    expect(type.enum).toEqual(["on_create", "on_update", "schedule", "manual"]);
  });

  test("名指しで禁じられた4つ(on_delete / on_view / on_undo / on_error)は1つも入っていない", () => {
    const type = (triggerSchema().properties as Any).type as Any;
    for (const forbidden of ["on_delete", "on_view", "on_undo", "on_error"]) {
      expect(type.enum as string[]).not.toContain(forbidden);
    }
  });

  test("manual は table 必須で、at / older_than を1つも書けない", () => {
    const manifest = baseManifest([], [SHIP_WORKFLOW]);
    expect(validateManifestFull(manifest)).toEqual({ valid: true });

    const noTable = baseManifest(
      [],
      [{ ...SHIP_WORKFLOW, trigger: { type: "manual" } } as unknown as Workflow],
    );
    expect(validateManifest(noTable).valid).toBe(false);

    const withAt = baseManifest(
      [],
      [
        {
          ...SHIP_WORKFLOW,
          trigger: { type: "manual", table: "orders", at: { hour: 3, minute: 0 } },
        } as unknown as Workflow,
      ],
    );
    expect(validateManifest(withAt).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (T01-2) `$defs/view_action` の4形目(ADR-0174 限定4)
// ---------------------------------------------------------------------------

describe("(T01-2) 操作起点の4形目 run(ADR-0174 限定4)", () => {
  test("oneOf は4要素で、additionalProperties:false が残っている", () => {
    expect(viewActionSchema().oneOf).toHaveLength(4);
    expect(viewActionSchema().additionalProperties).toBe(false);
  });

  /*
   * **【`V8-M20-T01` / 台帳 `J-G29` / 手続きは `ADR-0301`。2026-08-10】**
   * **旧テスト名(逐語)**: 「**4形目に書けるのは run / name / visible_when / audience だけ
   * (引数も条件も複数指定も無い)**」。**`audience` は廃止されたので名前から落とした。**
   * **本体は1バイトも変えていない** —— **測っているのは「他の3形のキーが `false` で
   * 閉じていること」であり、そこは今日も同じである。****旧文を1バイトも消していない。**
   */
  test("4形目に書けるのは run / name / visible_when / id だけ(引数も条件も複数指定も無い)", () => {
    const form = (viewActionSchema().oneOf as Any[])[3] as Any;
    expect(form?.required).toEqual(["run"]);
    // 他の3形のキーは、この形では false で閉じている。
    expect(form?.properties).toEqual({ form: false, prefill: false, set: false, view: false });
  });

  test("既存3形はどれも run を false で閉じている(形が混ざらない)", () => {
    for (const form of (viewActionSchema().oneOf as Any[]).slice(0, 3)) {
      expect((form.properties as Any).run).toBe(false);
    }
  });

  /*
   * **【`V8-M17` / `J-G9`(`ADR-0007` 門A 本審査 = 限定採用)による追随。2026-08-09】**
   * **9キー目 `id`(ボタンの識別子)を足したのは `V8-M17` であり、役割に束ねた規則
   * (`app.roles[].rules` の `target: action`)からボタンを名指しするためである。**
   * **旧文・旧値を1バイトも消していない。**
   * **【期待値を1つの数字に揃えてはならない。メインの裁定 `R-13-1` / 審査の申し送り2】**
   * **`$defs/view_action` は `V8-M17` 時点で9キー、`V8-M20` が `audience` を消して
   * 8キーに戻る。****揃えると `V8-M17` と `V8-M20` の完了条件が互いを赤くする。**
   * **【`V8-M20-T01` / 台帳 `J-G29` / 手続きは `ADR-0301`。2026-08-10】**
   * **`audience` が廃止されたので、予告どおり9キー → 8キーに戻した。**
   * **旧値の逐語は 9 で、消えたキーの逐語は `audience` である。**
   * **代わりに担うのは `app.roles[].rules` の「役割 × 対象(表)× 書込」と
   * 「役割 × 対象(ボタン)× 読取」の2本である。****旧文を1バイトも消していない。**
   */
  test("$defs/view_action.properties は8キーである(着手前は7。`V8-M17` で9・`V8-M20` で8)", () => {
    expect(Object.keys(viewActionSchema().properties as Any)).toEqual([
      "form",
      "view",
      "prefill",
      "set",
      "name",
      "visible_when",
      "run",
      "id",
    ]);
  });

  test("一覧にも詳細にも run 形を書ける", () => {
    const manifest = baseManifest([orderList([{ run: "ship" }]), orderDetail([{ run: "ship" }])]);
    expect(validateManifestFull(manifest)).toEqual({ valid: true });
  });

  test("入力フォームには今日も actions を1つも書けない(ADR-0171 限定3 を1バイトも解いていない)", () => {
    const branches = ((defs().view as Any).allOf as { if: Any; then?: Any }[]).find(
      (branch) => ((branch.if.properties as Any).type as Any)?.const === "form",
    );
    const then = branches?.then as Any | undefined;
    expect((then?.properties as Any | undefined)?.actions).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (T01-3) 起こせるのは `manual` と宣言したものだけ(ADR-0174 限定2)
// ---------------------------------------------------------------------------

describe("(T01-3) 起こせるのは manual と宣言したワークフローだけ(ADR-0174 限定2)", () => {
  test("run が実在しないワークフローを指すと適用時に倒れる", () => {
    const result = validateManifestFull(baseManifest([orderList([{ run: "nope" }])]));
    expect(result.valid).toBe(false);
  });

  test("run が on_update のワークフローを指すと適用時に倒れる(既存の3種は手動で起こせない)", () => {
    const auto: Workflow = {
      id: "auto",
      name: "自動",
      trigger: { type: "on_update", table: "orders" },
      actions: [{ action: "create_record", table: "notifications", values: { title: "x" } }],
      history_table: "wf-runs",
    } as unknown as Workflow;
    const result = validateManifestFull(
      baseManifest([orderList([{ run: "auto" }])], [SHIP_WORKFLOW, auto]),
    );
    expect(result.valid).toBe(false);
  });

  test("run が指すワークフローの対象テーブルと、その画面の対象テーブルが違うと適用時に倒れる", () => {
    const otherTable: Workflow = {
      ...SHIP_WORKFLOW,
      id: "notify",
      trigger: { type: "manual", table: "notifications" },
    } as unknown as Workflow;
    const result = validateManifestFull(
      baseManifest([orderList([{ run: "notify" }])], [SHIP_WORKFLOW, otherTable]),
    );
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (T01-4) 外部への送信を含むワークフローは起こせない(ADR-0174 限定5)
// ---------------------------------------------------------------------------

describe("(T01-4) 外部送信を含むワークフローは manual にできない(ADR-0174 限定5)", () => {
  test("call_external を含むワークフローは manual にできない", () => {
    const external: Workflow = {
      ...SHIP_WORKFLOW,
      actions: [
        {
          action: "call_external",
          connection: "psp",
          destination: "https://psp.test/charge",
          payload: { amount: "$record.title" },
        },
      ],
    } as unknown as Workflow;
    const result = validateManifestFull(baseManifest([], [external]));
    expect(result.valid).toBe(false);
    // **倒したのが限定5 であることを、文面で確かめる**(スキーマの別の不備で
    // たまたま倒れているのではないことを見る)。
    expect(
      (result as { errors: { message: string }[] }).errors.map((error) => error.message).join("\n"),
    ).toContain("発火条件を manual にできません");
  });

  test("ai_transform を含むワークフローは manual にできない", () => {
    const ai: Workflow = {
      ...SHIP_WORKFLOW,
      actions: [
        {
          action: "ai_transform",
          capability: "summarize",
          input: { title: "$record.title" },
          output_field: "state",
          fallback: "unknown",
          prompt: "件名を短くまとめてください。",
        },
      ],
    } as unknown as Workflow;
    const result = validateManifestFull(baseManifest([], [ai]));
    expect(result.valid).toBe(false);
    expect(
      (result as { errors: { message: string }[] }).errors.map((error) => error.message).join("\n"),
    ).toContain("発火条件を manual にできません");
  });

  test("capability を1つも宣言していない関数の run_function は manual でも通る(L-G9 の送り先)", () => {
    // **`v5-m20.md` §2 の逐語**: 「**追加の増分は0** —— 「行のボタン → `manual` の
    // ワークフロー → `run_function` → 島」で満たされる」。**この経路が実際に通ることを測る。**
    const withIsland: Workflow = {
      ...SHIP_WORKFLOW,
      actions: [
        {
          action: "run_function",
          function: "calc",
          output_table: "notifications",
        },
      ],
    } as unknown as Workflow;
    const manifest = baseManifest([], [withIsland]);
    (manifest.app as Any).functions = [
      {
        id: "calc",
        name: "計算",
        code: "export default function (input) { return []; }",
        input: { source: "record" },
        output: { fields: [{ id: "title", type: "text" }] },
      },
    ];
    expect(validateManifestFull(manifest)).toEqual({ valid: true });
  });

  test("capability を宣言した関数の run_function は manual にできない(限定5)", () => {
    const withDoor: Workflow = {
      ...SHIP_WORKFLOW,
      actions: [
        {
          action: "run_function",
          function: "notify",
          output_table: "notifications",
        },
      ],
    } as unknown as Workflow;
    const manifest = baseManifest([], [withDoor]);
    (manifest.app as Any).functions = [
      {
        id: "notify",
        name: "通知",
        code: "export default function (input) { return []; }",
        input: { source: "record" },
        output: { fields: [{ id: "title", type: "text" }] },
        capabilities: ["mailer"],
      },
    ];
    const result = validateManifestFull(manifest);
    expect(result.valid).toBe(false);
    expect(
      (result as { errors: { message: string }[] }).errors.map((error) => error.message).join("\n"),
    ).toContain("発火条件を manual にできません");
  });

  test("同じアクションを on_update で書くのは今日どおり通る(限定5 は manual にだけ掛かる)", () => {
    // **`ai_transform` を `on_update` に書いたものは今日どおり通る。**
    // **本タスクは `on_create` / `on_update` / `schedule` に1バイトも触っていない。**
    const ai: Workflow = {
      id: "summarize",
      name: "要約",
      trigger: { type: "on_update", table: "orders" },
      actions: [
        {
          action: "ai_transform",
          capability: "summarize",
          input: { title: "$record.title" },
          output_field: "state",
          fallback: "unknown",
          prompt: "件名を短くまとめてください。",
        },
      ],
      history_table: "wf-runs",
    } as unknown as Workflow;
    expect(validateManifestFull(baseManifest([], [ai]))).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// (T01-5) 語彙の本数(ADR-0174 限定6 / 限定10)
// ---------------------------------------------------------------------------

describe("(T01-5) 語彙の本数と履歴の列(ADR-0174 限定6 / 限定10)", () => {
  test("run_workflow を diff op にしていない", () => {
    // 【`V5-M29-T03` / `ADR-0250` 限定11】ここにあった `DIFF_OPS` の本数の検査は
    //   `scripts/vocabulary-drift.test.ts` へ移した(一覧の `DIFF_OPS:` で始まる行)。
    //   消した行に付いていた逐語: 「【`V5-M17b` / `ADR-0248`】16 → 17(`set_user_kinds` が17種目)。**この行が固定していたのは
    //   「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**」
    //   **総量ではなく名前と順序で見張る。**
    //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
    expect(DIFF_OPS as readonly string[]).not.toContain("run_workflow");
    // 【`V5-M29-T03` / `ADR-0250` 限定11】ここにあった `RESOURCE_KINDS` の本数の検査も移した
    //   (一覧の `RESOURCE_KINDS:` で始まる行)。**総量ではなく名前と順序で見張る。**
    //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
    // 【`V5-M29-T03` / `ADR-0250` 限定11】ここにあった `FIELD_TYPES` の本数の検査も移した
    //   (一覧の `FIELD_TYPES:` で始まる行)。消した位置にあったコメントの逐語: 「**`FIELD_TYPES` は 9 である**
    //   (`V5-M16` / `ADR-0161` が `file` を9種目にした。本マイルストーンは1つも動かしていない)。」
    //   **総量ではなく名前と順序で見張る。**
    //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
    // 【`V5-M29-T03`】**テスト名を書き換えた。** 旧: 「DIFF_OPS 16 / RESOURCE_KINDS 7 を1つも動かしていない(run_workflow を diff op にしていない)」。
    //   本体から本数を測る `expect` が消えたため(記録 §4-7)。**`DIFF_OPS 16` は消す前から本体が 17 を測っており、食い違っていた。**
  });

  test("_workflow_history の列は5本のままである(L-G11b = 保留)", () => {
    expect(WORKFLOW_HISTORY_COLUMNS).toHaveLength(5);
    expect([...WORKFLOW_HISTORY_COLUMNS]).toEqual([
      "ran_at",
      "workflow",
      "trigger_type",
      "status",
      "error",
    ]);
  });

  // 【`V5-M29-T03` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
  //   消したテスト名(逐語): 「$defs 28 / $defs/view.properties 28 を1つも動かしていない」
  //   そのブロックが測っていたもの:
  //     - `expect(Object.keys(defs())).toHaveLength(28)`
  //     - `expect(Object.keys((defs().view as Any).properties as Any)).toHaveLength(28)`
  //   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `manifest.$defs:` /
  //   `manifest.$defs.view.properties:` で始まる行)。
  //   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
  //   検出力0のまま `Ran` を水増しする)。
  //   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。
});

// ---------------------------------------------------------------------------
// (T01-6) 島の起動口を1本も作っていない(ADR-0174 限定7 / `L-G9` = 将来送り)
// ---------------------------------------------------------------------------

describe("(T01-6) 島の起動口を1本も作っていない(L-G9 = 将来送り。ADR-0174 限定7)", () => {
  test("runIsland / runIslandSync の非テスト呼び出しは1箇所のままである", () => {
    // **`src/kernel/workflow-runner.ts` の1箇所だけ**(`src/kernel/index.ts:139` の逐語
    // 「`runIslandSync` / `runIsland` はカーネル内部(`workflow-runner.ts`)からのみ呼ぶ」)。
    const runner = readFileSync(join(import.meta.dir, "workflow-runner.ts"), "utf-8");
    const calls = runner.match(/\brunIslandSync\(|\brunIsland\(/g) ?? [];
    // import 行の1件を除いた呼び出しは1件である。
    expect(calls).toHaveLength(1);
  });

  test("view_action の4形目に、島を名指しで起こすキーが1つも無い", () => {
    const keys = Object.keys(viewActionSchema().properties as Any);
    for (const forbidden of ["function", "run_function", "island", "code"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// (T01-7) 実際に起こす(ADR-0174 §限界1 の「走らせて確かめていない」を繰り返さない)
// ---------------------------------------------------------------------------

describe("(T01-7) 本物の SQLite で実際に起こす", () => {
  let dir: string;
  let db: Database;
  let manifest: Manifest;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gp-manual-trigger-"));
    db = new Database(join(dir, "app.sqlite"));
    manifest = baseManifest([orderList([{ run: "ship" }])]);
    applyManifestDdl(db, manifest);
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  function rows(tableId: string): RecordRow[] {
    const result = listRecords(db, manifest, tableId);
    if (!result.ok) {
      throw new Error(JSON.stringify(result.errors));
    }
    return result.value;
  }

  function seedOrder(): RecordRow {
    const created = createRecord(db, manifest, "orders", { title: "注文1", state: "new" });
    if (!created.ok) {
      throw new Error(JSON.stringify(created.errors));
    }
    return created.value;
  }

  test("押した行1行を対象にアクションが実際に走る", () => {
    const order = seedOrder();
    const failures = runManualWorkflow(db, manifest, SHIP_WORKFLOW, order);
    expect(failures).toEqual([]);
    const notifications = rows("notifications");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.source).toBe(order._id);
  });

  test("履歴に1行残り、trigger_type は manual である(列は増えていない)", () => {
    const order = seedOrder();
    runManualWorkflow(db, manifest, SHIP_WORKFLOW, order);
    const history = rows("wf-runs");
    expect(history).toHaveLength(1);
    expect(history[0]?.trigger_type).toBe("manual");
    expect(history[0]?.status).toBe("success");
    // **「誰が押したか」を書く列は無い**(`L-G11b` = 保留)。
    expect(Object.keys(history[0] ?? {})).not.toContain("actor");
  });

  test("`manual` でないワークフローを渡しても走らない(fail-closed)", () => {
    const order = seedOrder();
    const auto: Workflow = {
      ...SHIP_WORKFLOW,
      id: "auto",
      trigger: { type: "on_update", table: "orders" },
    } as unknown as Workflow;
    const failures = runManualWorkflow(db, manifest, auto, order);
    expect(failures.length).toBeGreaterThan(0);
    expect(rows("notifications")).toHaveLength(0);
    // **走らなかったので履歴も1行も書かない。**
    expect(rows("wf-runs")).toHaveLength(0);
  });

  /*
   * **【`V5-M25-T02` 完了条件3】再発火抑止(`firedRecords`)がどう効いたかを測る。**
   *
   * **`ADR-0174` §限界2 は「`ADR-0072`(再発火抑止)に及ばないことを、実測で示していない」と
   * 自認していた。** **本 test が測った結果は「及んだ」である** ——
   * **手動起動は押した行を抑止の集合に入れるので、その行を更新する `on_update` は
   * 同じ操作の中では発火せず、履歴に `suppressed` として残る。**
   * **黙って消えていない**(憲法6)。**丸めずに記録に書く。**
   */
  test("手動起動が押した行そのものを更新すると、その行の on_update は抑止される(履歴に suppressed が残る)", () => {
    const order = seedOrder();
    const selfUpdate: Workflow = {
      id: "self-update",
      name: "自分を更新する",
      trigger: { type: "manual", table: "orders" },
      actions: [
        {
          action: "update_record",
          table: "orders",
          target: "$record._id",
          values: { state: "shipped" },
        },
      ],
      history_table: "wf-runs",
    } as unknown as Workflow;
    const onUpdate: Workflow = {
      id: "notify-on-update",
      name: "更新されたら通知する",
      trigger: { type: "on_update", table: "orders" },
      actions: [
        { action: "create_record", table: "notifications", values: { title: "更新されました" } },
      ],
      history_table: "wf-runs",
    } as unknown as Workflow;
    manifest.app.workflows = [selfUpdate, onUpdate];
    const failures = runManualWorkflow(db, manifest, selfUpdate, order);
    expect(failures).toEqual([]);
    const history = rows("wf-runs");
    // **手動起動の1行と、抑止された `on_update` の1行の2行が残る。**
    expect(history.map((row) => `${String(row.workflow)}:${String(row.status)}`).sort()).toEqual([
      "notify-on-update:suppressed",
      "self-update:success",
    ]);
    // **`on_update` のアクションは1件も走っていない。**
    expect(rows("notifications")).toHaveLength(0);
  });

  test("2回続けて起こせば2回走る(完了後の再押下は通る。ADR-0175 限定3)", () => {
    const order = seedOrder();
    runManualWorkflow(db, manifest, SHIP_WORKFLOW, order);
    runManualWorkflow(db, manifest, SHIP_WORKFLOW, order);
    expect(rows("notifications")).toHaveLength(2);
    expect(rows("wf-runs")).toHaveLength(2);
  });
});
