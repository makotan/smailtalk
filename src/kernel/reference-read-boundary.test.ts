import { Database } from "bun:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldOperations } from "./apply-diff.ts";
import {
  armManifestForAutomation,
  FIXTURE_ACTOR_ID,
  fixtureOwnerValues,
  seedAutomationActor,
} from "./automation-actor-fixture.test.ts";
import { applyManifestDdl as applyManifestDdlRaw } from "./ddl.ts";
import type { ValidationError, ValidationResult } from "./errors.ts";
import { ensureIslandRuntimeReady } from "./island-runner.ts";
import {
  createRecord as createRecordRaw,
  listRecords,
  type RecordRow,
  updateRecord as updateRecordRaw,
} from "./records.ts";
import { validateReferentialIntegrity } from "./referential-integrity.ts";
import { appDbPath } from "./storage-paths.ts";
import type { Manifest, Operation, Workflow } from "./types.ts";
import { validateDiff, validateManifest } from "./validate.ts";
import { WORKFLOW_MAX_DEPTH } from "./workflow-runner.ts";

/*
 * --- **【`V8-M26`(2026-08-10)で題材に「壁を開ける下ごしらえ」が入った】** -------------
 *
 * **`V8-M26-T03` が面(役割に束ねた権限)の既定を「閉じる」側へ倒したので、
 * ワークフロー・島の書込が題材ごと止まった。** **本ファイルの主題は面ではないので、
 * 題材の側で壁を開ける** —— **実装は1バイトも緩めていない。**
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
  armManifestForAutomation(target);
  return createRecordRaw(database, target, tableId, fixtureOwnerValues(target, tableId, values));
}

/** 行を更新する(**`st_owner` は1バイトも触らない**)。 */
function updateRecord(
  database: Database,
  target: Manifest,
  tableId: string,
  recordId: string,
  values: Record<string, unknown>,
): ReturnType<typeof updateRecordRaw> {
  armManifestForAutomation(target);
  return updateRecordRaw(database, target, tableId, recordId, values);
}

/**
 * **V3-M9-T03: 越えない線の非退行検査。**
 *
 * `D-G14`(参照先を読む計算)は `V3-M9-T00` の門A本審査で**限定採用**され、`V3-M9-T01` が
 * 複数入力として実装した(`ADR-0062` の限定表12点)。`D-G15`(他テーブルの現在値に基づく
 * 更新)は**保留**であり、**実装は1バイトも無い。**
 *
 * 本ファイルは **製品コードを1バイトも変更せず**、次の6点を検査する:
 *
 * 1. 1ホップを越える形(多段参照・join・クエリ言語)が書けないこと —— **破壊実験**。
 *    **`V3-M9-T01` が既に34ケース行っているので、本ファイルは T01 が当てていない角度だけを取る**
 *    (`related` / `target` / `write_back` / `filter` / 差分操作(`update_view` / `change_field` /
 *    `update_function`)経由で、表示側・書込側から計算側へ越えられないか)。
 * 2. 表示側の1ホップ固定(`ADR-0044` の `related`)が緩んでいないこと。
 * 3. `RUN_FUNCTION_LIMITS` の3値が変わっていないこと + 複数入力でも上限で fail-closed すること。
 *    **この定数は非 export である**(`ADR-0062` 限定11 = `src/kernel/` の公開 export を1本も
 *    足さない)ため、**export を足さずにソースをテキストとして読んで固定する**(限界は §3 の
 *    コメントに書いた)。
 * 4. `$defs/action_value` が今日と同一であること(`ADR-0013` 限定12 不可侵)。
 * 5. 売り越し —— **`D-G15` が実装されていないので「今日は経路が無い」ことを実測する。**
 *    **CAS が効いている対照は作れない**(ワークフロー経路に版を渡す口が存在しないため)。
 * 6. 連鎖の上限(`WORKFLOW_MAX_DEPTH` / `firedRecords`)が保たれること ——
 *    **複数入力を持つ `run_function` が別行の `on_create` / `on_update` を発火させる経路を含めて。**
 */

beforeAll(async () => {
  await ensureIslandRuntimeReady();
});

// biome-ignore lint/suspicious/noExplicitAny: 異常系の構造を意図的に組み立てるため
type Any = any;

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** 正準スキーマ(`schemas/*.schema.json`)をそのまま読む。 */
function canonicalSchema(file: string): Any {
  return JSON.parse(readFileSync(join(REPO_ROOT, "schemas", file), "utf-8")) as Any;
}

/** 製品コードを**テキストとして**読む(export を1本も足さないため。§3)。 */
function sourceText(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), "utf-8");
}

/** 失敗であることを確認しつつ errors を取り出す。 */
function expectInvalid(result: ValidationResult): ValidationError[] {
  expect(result.valid).toBe(false);
  if (result.valid) {
    throw new Error("expected invalid");
  }
  return result.errors;
}

/** 履歴テーブルの5列(規約どおり)。 */
function historyFields() {
  return [
    { id: "ran_at", name: "実行時刻", type: "date" as const },
    { id: "workflow", name: "ワークフロー", type: "text" as const },
    { id: "trigger_type", name: "きっかけ", type: "text" as const },
    { id: "status", name: "結果", type: "text" as const },
    { id: "error", name: "エラー", type: "long_text" as const },
  ];
}

// =============================================================================
// 共通のマニフェスト —— 親(customers)/ 子(orders)/ 孫(order-lines)の3階層。
//
// **3階層あることが本ファイルの要点である** —— 「孫まで辿れないか」を破壊実験で当てる
// ためには、辿ろうとする先が実在していなければならない(実在しないから弾かれた、では
// 1ホップ固定の検査にならない)。
// =============================================================================

function threeLevelManifest(): Manifest {
  return {
    app: {
      id: "boundary-app",
      name: "境界検査",
      tables: [
        {
          id: "customers",
          name: "顧客",
          fields: [
            { id: "title", name: "名前", type: "text" },
            { id: "rank", name: "等級", type: "text" },
          ],
        },
        {
          id: "orders",
          name: "注文",
          fields: [
            { id: "customer", name: "顧客", type: "reference", reference_table: "customers" },
            { id: "subtotal", name: "小計", type: "number" },
          ],
        },
        {
          id: "order-lines",
          name: "明細",
          fields: [
            { id: "order", name: "注文", type: "reference", reference_table: "orders" },
            { id: "amount", name: "金額", type: "number" },
          ],
        },
        {
          id: "tax-rates",
          name: "税率",
          fields: [{ id: "rate", name: "率", type: "number" }],
        },
      ],
      views: [
        {
          id: "order-detail",
          type: "detail_view",
          table: "orders",
          name: "注文の詳細",
          fields: ["customer", "subtotal"],
          related: [{ table: "order-lines", via: "order", columns: ["amount"] }],
        },
        {
          id: "order-list",
          type: "list_view",
          table: "orders",
          name: "注文の一覧",
          columns: ["subtotal"],
        },
        {
          id: "order-form",
          type: "form",
          table: "orders",
          name: "注文の入力",
          fields: ["customer", "subtotal"],
        },
      ],
    },
  };
}

// =============================================================================
// §1 【完了条件1】1ホップを越える形が書けない —— **破壊実験(T01 が当てていない角度)**
//
// T01(`v3-m9-t01.md` §4)は `function.input` そのものに34ケースを当てた。
// **同じものをもう一度書かない。** 本節が当てるのは「表示側(related)/ 書込側(target /
// write_back)/ 絞り込み側(filter)/ 差分操作(update_view / change_field / update_function)
// から、計算側の1ホップを越えられないか」である。
// =============================================================================

describe("V3-M9-T03 完了条件1: 1ホップを越える形が書けない(T01 が当てていない角度)", () => {
  // --- D1: 表示側 → 計算側。related を持つ detail_view を関数入力にできない -----
  test("D1: `related`(1ホップ展開)を持つ detail_view を function.input に指せない —— 類型9 が拒否する", () => {
    const manifest = threeLevelManifest();
    manifest.app.functions = [
      {
        id: "peek",
        name: "覗く",
        code: "(rows) => rows",
        // detail_view は「行の絞り込み・並び」を持たない。related の展開結果を関数へ
        // 吸い上げる最短経路がここである。
        input: { source: "view", view: "order-detail" },
        output: { fields: [{ id: "amount", type: "number" }] },
        capabilities: [],
      },
    ];
    // **schema は通る**(view は resource_id なので形の上では書ける)。
    expect(validateManifest(manifest)).toEqual({ valid: true });
    // 止めるのは参照整合性の類型9 である。
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/app/functions/0/input/view");
    // 候補に detail_view / form は1つも出ない(list_view だけ)。
    expect(errors[0]?.allowed_values).toEqual(["order-list"]);
  });

  test("D1b: 配列形(複数入力)の要素で detail_view を指しても、同じ類型9 が要素位置つきで拒否する", () => {
    const manifest = threeLevelManifest();
    manifest.app.functions = [
      {
        id: "peek",
        name: "覗く",
        code: "(inputs) => inputs[0]",
        input: [
          { source: "table", table: "orders" },
          { source: "view", view: "order-detail" },
        ] as Any,
        output: { fields: [{ id: "amount", type: "number" }] },
        capabilities: [],
      },
    ];
    expect(validateManifest(manifest)).toEqual({ valid: true });
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    expect(errors).toHaveLength(1);
    // **どの要素が越えようとしたかが読める**(新しい語彙ではない)。
    expect(errors[0]?.path).toBe("/app/functions/0/input/1/view");
  });

  // --- D2: related の要素にクエリ/結合キーを足せない ---------------------------
  test("D2: `related[]` に join / through / filter / where / select / group_by / expand を書けない(7ケース)", () => {
    const forbidden = ["join", "through", "filter", "where", "select", "group_by", "expand"];
    for (const key of forbidden) {
      const manifest = threeLevelManifest();
      const view = manifest.app.views[0] as Any;
      view.related = [
        { table: "order-lines", via: "order", columns: ["amount"], [key]: { field: "amount" } },
      ];
      expectInvalid(validateManifest(manifest));
    }
    // 7ケースとも弾かれたので、ここに到達する。
    expect(forbidden).toHaveLength(7);
  });

  test("D2b: `related[]` の中に `related` を入れ子にできない(孫)", () => {
    const manifest = threeLevelManifest();
    const view = manifest.app.views[0] as Any;
    view.related = [
      {
        table: "order-lines",
        via: "order",
        columns: ["amount"],
        related: [{ table: "order-lines", via: "order", columns: ["amount"] }],
      },
    ];
    expectInvalid(validateManifest(manifest));
  });

  // --- D3: related の via に多段を書けない -------------------------------------
  test("D3: `related[].via` に多段(`order.customer` / `a.b.c`)を書けない —— resource_id が拒否する", () => {
    for (const via of ["order.customer", "a.b.c", "order/customer"]) {
      const manifest = threeLevelManifest();
      const view = manifest.app.views[0] as Any;
      view.related = [{ table: "order-lines", via, columns: ["amount"] }];
      expectInvalid(validateManifest(manifest));
    }
  });

  test("D3b: `related[].table` に孫テーブルを置いて親を跨ごうとしても、via が対象テーブルを指していなければ類型14 が拒否する", () => {
    // 顧客の詳細画面に、**孫**(order-lines)を直に並べようとする = 2ホップ。
    const manifest = threeLevelManifest();
    manifest.app.views.push({
      id: "customer-detail",
      type: "detail_view",
      table: "customers",
      name: "顧客の詳細",
      fields: ["title"],
      related: [{ table: "order-lines", via: "order", columns: ["amount"] }],
    } as Any);
    // **schema は通る**(形の上では書ける)。止めるのは類型14 である。
    expect(validateManifest(manifest)).toEqual({ valid: true });
    const errors = expectInvalid(validateReferentialIntegrity(manifest));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/app/views/3/related/0/via");
    // 「参照先が対象テーブルと一致しない」= 2ホップ目に当たる、という理由が読める。
    expect(errors[0]?.message).toContain("orders");
    expect(errors[0]?.message).toContain("customers");
  });

  // --- D4: 差分操作(update_view)経由で related を後から足せない ---------------
  test("D4: `update_view` の changes に `related` を書けない(14キーに related は無い)", () => {
    const diff = {
      diff_id: "d1",
      intent: "related を後から足そうとする",
      operations: [
        {
          op: "update_view",
          view: "order-detail",
          changes: { related: [{ table: "order-lines", via: "order", columns: ["amount"] }] },
        },
      ],
    };
    expectInvalid(validateDiff(diff));
    // **15キー**の一覧そのものを固定する(`related` / `join` / `actions` が入っていない)。
    // **【V4-M10-T45 / `E-G12` / ADR-0084 限定6 による更新】** 14キー目 `menu_listed` が
    // 加わったが、**`related` / `actions` は今日も `view_changes` に無い**
    // (`ADR-0084` 限定6 が「それらを足すことは射程外である」と明記している)——
    // **本テストの主張は1ミリも緩んでいない。**
    // **【V4-M16-T12 / `P-G17` の (C) 側 / ADR-0092 限定2 による更新】** 15キー目
    // `field_groups`(詳細画面の項目のまとまり)が門A を通って加わった。**これも「1ホップを
    // 越える形」ではない** —— 書けるのは**同じ画面の項目のまとまり**だけで、
    // **`related` / `actions` は今日も `view_changes` に無い。****主張は1ミリも緩んでいない。**
    const viewChanges = canonicalSchema("diff.schema.json").$defs.view_changes;
    expect(Object.keys(viewChanges.properties)).toEqual([
      "name",
      "columns",
      "sort",
      "filter",
      "fields",
      "preset_column_align",
      "preset_column_width",
      "preset_pager_position",
      "preset_label_placement",
      "preset_field_columns",
      "preset_image_size",
      "preset_text_preview",
      "custom_css",
      "menu_listed",
      "field_groups",
      // **V4-M16-T13 / `P-G24` の (C) 側 / ADR-0093 限定2 が足した16キー目 `preset_list_shape`。**
      // **`update_view` で後から書けて、カーネルが値を実際に運ぶ**(`applyViewChanges` の
      // `list_view` 分岐。**`CHANGE_KEYS_BY_VIEW_TYPE` に足すだけでは運ばれない**)。
      "preset_list_shape",
      // **V4-M18-T03 / `P-G14` の (C) 側 / ADR-0095 限定6 が足した17キー目 `modal`。**
      // **これも「1ホップを越える形」ではない** —— 書けるのは**この画面を重ねて出すかの
      // 真偽値1つ**だけで、**`related` / `actions` は今日も `view_changes` に無い。**
      // **主張は1ミリも緩んでいない。**
      "modal",
      // **V4-M22-T01 / `E-G7` の (C) 側 / ADR-0112 限定2 が足した18キー目 `search_fields`。**
      // **これも「1ホップを越える形」ではない** —— 書けるのは**同じ画面の対象テーブルに
      // 実在するフィールドIDの配列**だけで、**`related` / `actions` は今日も
      // `view_changes` に無い。****主張は1ミリも緩んでいない。**
      "search_fields",
      // **V4-M22-T05 / ADR-0113 限定2 が足した19キー目 `page_size`。**
      // **これも「1ホップを越える形」ではない** —— 書けるのは**1ページに出す件数の
      // 段階値1つ**だけで、**`related` / `actions` は今日も `view_changes` に無い。**
      // **主張は1ミリも緩んでいない。**
      "page_size",
      // **【V4-M19-T03 / ADR-0118 限定1 で 19 → 20 に更新した】** 20キー目 `preset_density`
      // (画面の詰まり具合)が門A を通って増えた(V4-M19 単位C。2回目の審査。判定 = 限定採用)。
      // **これも「1ホップを越える形」ではない** —— 書けるのは**画面の詰まり具合の2値**だけで、
      // **`related` / `actions` は今日も `view_changes` に無い。****主張は1ミリも緩んでいない。**
      // **本 ADR の増分ではない。**
      "preset_density",
      // **【V4-M20-T04 / ADR-0102 限定2 で 20 → 21 に更新した】** 21キー目 `after_save`
      // (保存が成立したあとに行く画面のID)が門A を通って増えた(V4-M20 単位D。2回目の
      // 審査。判定 = 限定採用)。**これも「1ホップを越える形」ではない** —— 書けるのは
      // **同じアプリの実在するビューID1つ**だけで、**`related` / `actions` は今日も
      // `view_changes` に無い。****主張は1ミリも緩んでいない。****本 ADR の増分ではない。**
      "after_save",
      // **【V4-M23-T01 / ADR-0104 限定採用で 21 → 22 に更新した】** 22キー目 `sum_field`
      // (合計を出す列。`list_view` でだけ書ける)が門A を通って増えた。**これも「1ホップを
      // 越える形」ではない** —— 書けるのは**同じ画面の対象テーブルに実在する number 型
      // フィールドID1つ**だけで、**`related` / `actions` は今日も `view_changes` に無い。**
      // **主張は1ミリも緩んでいない。****本 ADR の増分ではない。**
      "sum_field",
      // **【V5-M21-T03 / `L-G4` / ADR-0172 限定1】23キー目 `actions`(操作起点)が末尾に
      // 入った** —— 門A の本審査(`V5-M20` 面1 の `L-G4`。判定 = 限定採用)を通った増分で
      // ある。**`related` / `audience` は今日も無い。****列挙を消して件数に丸めない。**
      "actions",
      // **【`V6-M2-T02` / `K-G3` / `ADR-0289` 限定1】24キー目 `reference_pickers`
      // (参照項目の選び方の、入力画面ごとの上書き。`form` でだけ書ける)が末尾に入った** ——
      // 門A の本審査(`V6-M0` 単位A の `K-G3`。判定 = 限定採用)を通った増分である。
      // **これも「1ホップを越える形」ではない** —— 書けるのは**同じ画面の対象テーブルに
      // 実在する reference 型フィールドID → 有限3値**だけで、**参照先のテーブルの中身を
      // 1バイトも指していない。****`related` / `audience` は今日も無い。**
      // **主張は1ミリも緩んでいない。****列挙を消して件数に丸めない。**
      "reference_pickers",
      // **【2026-08-14。`V8-M8` / 台帳 `Q-G1` / 門A 本審査 = `V8-M7`】25キー目 `report`
      // (集計表の中身。`report_view` でだけ書ける)が末尾に入った。****これも「1ホップを
      // 越える形」ではない** —— **束ねるキーも合計する列も、同じ画面の対象テーブルに実在する
      // フィールドIDだけで、参照先のテーブルの中身を1バイトも指していない**(参照で束ねても
      // 束ねるのは参照先のIDである)。**結合(join)を1つも書けない。**
      // **`related` / `audience` は今日も無い。****主張は1ミリも緩んでいない。**
      // **列挙を消して件数に丸めない。**
      /*
       * **【2026-08-14。`V8-M9`。台帳 `Q-G6`〜`Q-G9`。門A 本審査 = `V8-M7`。
       * 判定 = 限定採用。上の行を1バイトも書き換えていない】**
       *
       * **上の逐語「結合(join)を1つも書けない。」は今日は偽である。**
       * **`$defs/report` の中に `join` が入った**(`$defs/report.properties` は 3本 → 4本)。
       * **したがって「集計表の中では、表を最大5本まで(段数3まで)結合できる」。**
       *
       * **この期待値(`view_changes` の25キー)は1バイトも変わらない** ——
       * **`join` は `view_changes` のキーではなく、`report` の**中**のキーだからである。**
       * **`related` / `audience` は今日も `view_changes` に無い。**
       *
       * **【`ADR-0062` 限定7 の担保について、正直に書く】**
       * **本ファイル(`V3-M9-T03` の破壊実験43件)は `V8-M9` の後も 34 test / 0 fail で
       * 緑のままである** —— **43件はどれも `function.input` / `related` / `target` /
       * `write_back` / `filter` / 差分操作の6経路を撃っており、集計表の宣言を1件も
       * 撃っていないからである。**
       * **したがって「限定7 を破ったのに担保は赤くならなかった」が今日の事実である。**
       * **【禁止】これを「限定7 を破っていない」と読まない** —— **破っている。**
       * **破ったのは集計表の中だけであり、上の6経路は今日も1ホップのままである。**
       */
      "report",
      // **【2026-08-20。`V10-M1-T02` / `NV-G4` / `ADR-0359` §Decision 2 が足した26キー目
      // `after_delete`。****これも「1ホップを越える形」ではない** —— 書けるのは
      // **同じアプリに実在するビューID 1つ**だけで、**`related` / `actions` は今日も
      // `view_changes` に無い。****主張は1ミリも緩んでいない。**
      "after_delete",
      // **【2026-08-20。`V10-M4-T01` / `NV-G9` / `ADR-0359` §Decision 2 が足した27キー目
      // `flow`。****これも「1ホップを越える形」ではない** —— 書けるのは
      // **流れの名前と位置と段の種類の3つ**だけで、**参照を1ホップも辿らない。**
      // **`related` は今日も `view_changes` に無い。****主張は1ミリも緩んでいない。**
      "flow",
    ]);
    expect(viewChanges.additionalProperties).toBe(false);
  });

  test("D4b: `update_view` の filter に `$record.<field>` を書いても、動的な絞り込みにはならない(リテラル文字列として畳まれる)", () => {
    const diff = {
      diff_id: "d2",
      intent: "filter に $record を書こうとする",
      operations: [
        {
          op: "update_view",
          view: "order-list",
          changes: { filter: [{ field: "subtotal", equals: "$record.subtotal" }] },
        },
      ],
    };
    // **schema は通る**(equals はリテラル。`$record` を弾く仕組みは filter に無い)。
    expect(validateDiff(diff)).toEqual({ valid: true });
    const folded = foldOperations(threeLevelManifest(), diff.operations as Operation[]);
    expect(folded.valid).toBe(true);
    if (!folded.valid) {
      throw new Error("fold に失敗した");
    }
    const view = folded.manifest.app.views.find((v) => v.id === "order-list") as Any;
    // **文字列 "$record.subtotal" がそのまま入る** —— 参照として解決される場所はどこにも無い。
    expect(view.filter).toEqual([{ field: "subtotal", equals: "$record.subtotal" }]);
    // 正準スキーマの `$defs/filter` 側にも `$record` は1つも現れない。
    const defs = canonicalSchema("manifest.schema.json").$defs;
    for (const key of ["filter", "filter_and_array", "filter_node", "filter_leaf"]) {
      if (defs[key] === undefined) {
        continue;
      }
      expect(JSON.stringify(defs[key])).not.toContain("$record");
    }
  });

  // --- D5: change_field で型を変えた後も1ホップの土台が崩れない ----------------
  test("D5: `change_field` で `related[].via` の型を reference → text に変えると、類型14 が拒否する(型を変えて越える道が無い)", () => {
    const operations: Operation[] = [
      {
        op: "change_field",
        table: "order-lines",
        field: "order",
        changes: { type: "text" },
      } as Any,
    ];
    const folded = foldOperations(threeLevelManifest(), operations);
    expect(folded.valid).toBe(true);
    if (!folded.valid) {
      throw new Error("fold に失敗した");
    }
    // 形としては通る(text 型のフィールドになった)。
    expect(validateManifest(folded.manifest)).toEqual({ valid: true });
    // **止めるのは類型14 である。** `via` が reference でなくなった瞬間に赤くなる。
    const errors = expectInvalid(validateReferentialIntegrity(folded.manifest));
    expect(errors.some((e) => e.path === "/app/views/0/related/0/via")).toBe(true);
    expect(errors.some((e) => (e.message ?? "").includes("reference 型ではありません"))).toBe(true);
  });

  // --- D6: 差分操作(update_function)経由で禁止キーを書けない -------------------
  test("D6: `add_function` / `update_function` の差分でも、入力に join / where / select / group_by / on を書けない(10ケース)", () => {
    const forbidden = ["join", "where", "select", "group_by", "on"];
    let rejected = 0;
    for (const op of ["add_function", "update_function"]) {
      for (const key of forbidden) {
        const diff = {
          diff_id: "d3",
          intent: "関数の入力に結合キーを書こうとする",
          operations: [
            {
              op,
              function: {
                id: "peek",
                name: "覗く",
                code: "(rows) => rows",
                input: [
                  { source: "table", table: "orders" },
                  { source: "table", table: "customers", [key]: "customer" },
                ],
                output: { fields: [{ id: "amount", type: "number" }] },
                capabilities: [],
              },
            },
          ],
        };
        expectInvalid(validateDiff(diff));
        rejected += 1;
      }
    }
    expect(rejected).toBe(10);
  });

  // --- D7: 書込側 → 計算側。target に多段を書けない ----------------------------
  test("D7: `update_record` の `target` に多段(`$record.customer.rank`)を書けない —— action_value の pattern が単一トークンに固定している(5ケース)", () => {
    const bad = [
      "$record.customer.rank",
      "$record.customer._id",
      "$record.a.b.c",
      "$record.customer[0]",
      "$record.customer|rank",
    ];
    for (const target of bad) {
      const manifest = threeLevelManifest();
      manifest.app.workflows = [
        {
          id: "w",
          name: "越えようとする",
          trigger: { type: "on_create", table: "orders" },
          actions: [
            { action: "update_record", table: "customers", target, values: { rank: "gold" } },
          ],
          history_table: "wf-runs",
        } as Any,
      ];
      manifest.app.tables.push({ id: "wf-runs", name: "実行履歴", fields: historyFields() });
      expectInvalid(validateManifest(manifest));
    }
  });

  test("D7b: `values` に相対更新の式(`$record.subtotal - 1` 等)を書けない(6ケース)", () => {
    const bad = [
      "$record.subtotal - 1",
      "$record.subtotal-$record.discount",
      "$record.stock - qty",
      `$` + "{record.subtotal}",
      "$sum(record.subtotal)",
      "$record.customer.rank",
    ];
    for (const value of bad) {
      const manifest = threeLevelManifest();
      manifest.app.tables.push({ id: "wf-runs", name: "実行履歴", fields: historyFields() });
      manifest.app.workflows = [
        {
          id: "w",
          name: "相対更新を書こうとする",
          trigger: { type: "on_create", table: "orders" },
          actions: [
            {
              action: "update_record",
              table: "orders",
              target: "$record._id",
              values: { subtotal: value },
            },
          ],
          history_table: "wf-runs",
        } as Any,
      ];
      expectInvalid(validateManifest(manifest));
    }
  });

  // --- D8: write_back で別テーブル・別行を狙えない -----------------------------
  test("D8: `write_back` に `$record` 以外(別テーブル / 参照フィールド / 式)を書けない —— const 固定(5ケース)", () => {
    const bad = [
      "$record.customer",
      "customers",
      "$record.customer.rank",
      "$record._id",
      "$parent",
    ];
    for (const writeBack of bad) {
      const manifest = threeLevelManifest();
      manifest.app.tables.push({ id: "wf-runs", name: "実行履歴", fields: historyFields() });
      manifest.app.functions = [
        {
          id: "calc",
          name: "計算",
          code: "(rec) => [{ subtotal: 1 }]",
          input: { source: "record" },
          output: { fields: [{ id: "subtotal", type: "number" }] },
          capabilities: [],
        },
      ];
      manifest.app.workflows = [
        {
          id: "w",
          name: "別行へ書こうとする",
          trigger: { type: "on_create", table: "orders" },
          actions: [{ action: "run_function", function: "calc", write_back: writeBack }],
          history_table: "wf-runs",
        } as Any,
      ];
      expectInvalid(validateManifest(manifest));
    }
    // 正準スキーマ側の固定も直接読む。
    const writeBack =
      canonicalSchema("manifest.schema.json").$defs.workflow_action.properties.write_back;
    expect(writeBack.const).toBe("$record");
    expect(writeBack.enum).toBeUndefined();
  });
});

// =============================================================================
// §2 【完了条件2】表示側の1ホップ固定(ADR-0044 の related)が緩んでいない
// =============================================================================

describe("V3-M9-T03 完了条件2: 表示側の1ホップ固定(ADR-0044 の related)が緩んでいない", () => {
  const defs = canonicalSchema("manifest.schema.json").$defs;

  test("`$defs/related_list` の要素は6キー(名札 `id` を1本足した)・必須3キー・additionalProperties:false のまま", () => {
    // **【`V10-M24-T01` / `CM-G22` / `ADR-0371` 限定1】5キー → 6キー。** **足したのは名札
    // (`id`)1本だけで、値域は既存の `#/$defs/resource_id` の再利用である**(新しい `$defs` を
    // 1本も作っていない)。**`required` は `["table","via","columns"]` のまま1バイトも変えて
    // いない**(名札は任意。既存アプリは1本も `valid=false` にならない)。**`additionalProperties:
    // false` も1バイトも解いていない** —— **6キー目以外は今日も書けない。**
    const items = defs.related_list.items;
    expect(Object.keys(items.properties)).toEqual([
      "id",
      "table",
      "via",
      "columns",
      "sort",
      "name",
    ]);
    expect(items.required).toEqual(["table", "via", "columns"]);
    expect(items.additionalProperties).toBe(false);
    expect(defs.related_list.minItems).toBe(1);
  });

  test("`$defs/related_list` に join / on / through / expand / where / select / group_by / filter のキーが1つも無い", () => {
    const keys = new Set<string>();
    const walk = (node: Any): void => {
      if (Array.isArray(node)) {
        for (const child of node) {
          walk(child);
        }
        return;
      }
      if (node !== null && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
          keys.add(key);
          walk(value);
        }
      }
    };
    walk(defs.related_list.items);
    for (const forbidden of [
      "join",
      "on",
      "through",
      "expand",
      "where",
      "select",
      "group_by",
      "filter",
      "related",
    ]) {
      expect(keys.has(forbidden)).toBe(false);
    }
  });

  test("`related` は detail_view でだけ許され、list_view / form では false に固定されている", () => {
    const branches = defs.view.allOf as Any[];
    const falseFor = branches
      .filter((b) => b.then?.properties?.related === false)
      .map((b) => b.if?.properties?.type?.const);
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値に `report_view` を足した。**
    // **旧行の逐語**: `expect(falseFor.sort()).toEqual(["form", "list_view"]);`
    // **書き換えた理由**: **画面種別に4種目(集計表)が加わり、その分岐でも `related` は
    // `false` で閉じてある。****「`related` は `detail_view` でだけ許される」という
    // 本来の主張は1ミリも弱めていない** —— **閉じている分岐が1つ増えただけである。**
    expect(falseFor.sort()).toEqual(["form", "list_view", "report_view"]);
  });

  test("`related` は list_view に書くと拒否される(1ホップの置き場を増やしていない)", () => {
    const manifest = threeLevelManifest();
    const listView = manifest.app.views[1] as Any;
    listView.related = [{ table: "order-lines", via: "order", columns: ["amount"] }];
    expectInvalid(validateManifest(manifest));
  });

  test("類型14 は via が「対象テーブルを参照する reference 型」であることを今も要求する(1ホップの定義そのもの)", () => {
    // (a) 正しい1ホップは valid。
    expect(validateReferentialIntegrity(threeLevelManifest())).toEqual({ valid: true });
    // (b) via が非 reference。
    const nonRef = threeLevelManifest();
    (nonRef.app.views[0] as Any).related = [
      { table: "order-lines", via: "amount", columns: ["amount"] },
    ];
    expectInvalid(validateReferentialIntegrity(nonRef));
    // (c) via が実在しない。
    const missing = threeLevelManifest();
    (missing.app.views[0] as Any).related = [
      { table: "order-lines", via: "nope", columns: ["amount"] },
    ];
    expectInvalid(validateReferentialIntegrity(missing));
  });

  test("`related` の $comment が「join・参照展開・孫・多段には広げない」を今も明記している(ADR-0044 §3a)", () => {
    const comment = String(defs.related_list.$comment);
    expect(comment).toContain("1ホップ");
    expect(comment).toContain("join");
    expect(comment).toContain("$record.<ref>.<field>");
    expect(comment).toContain("孫");
    expect(comment).toContain("多段");
  });
});

// =============================================================================
// §3 【完了条件3】RUN_FUNCTION_LIMITS の3値 + 複数入力でも上限で fail-closed
//
// ## **export を1本も足さずに固定する**(ADR-0062 限定11 との衝突。v3-m9.md §2a-2 (G) 5)
//
// `RUN_FUNCTION_LIMITS` は `workflow-runner.ts` の**非 export の const** である。
// `export` を足せば `scripts/kernel-export-drift.test.ts` が赤くなり、差し戻し条件1 に
// 当たる。したがって**ソースをテキストとして読んで逐語で固定する。**
//
// **この形の限界を隠さない**:
// - テキスト照合は「その文字列がソースに在る」ことしか言えない。**その定数が実際に
//   `runIslandSync` へ渡っているか**は別の検査(下の呼び出し箇所の照合)で補うが、
//   それも**テキスト照合**であって値の到達を実行で確かめたものではない。
// - 実行で確かめられるのは `maxInputBytes` だけである(1 MiB を越えさせれば落ちる)。
//   **`timeoutMillis` / `memoryBytes` の値そのものを実行で測ってはいない。**
// - ソースの整形(改行位置・空白)が変わるだけで赤くなる。**それは偽陽性であって、
//   限定6 が破られたことを意味しない。**
// =============================================================================

describe("V3-M9-T03 完了条件3: RUN_FUNCTION_LIMITS の3値が変わっていない(export を1本も足さずに固定する)", () => {
  const runner = sourceText("src/kernel/workflow-runner.ts");

  test("3値が逐語で今日と同一である(timeout 1000ms / memory 64MiB / maxInput 1MiB)", () => {
    const block = runner.match(
      /const RUN_FUNCTION_LIMITS: IslandLimits = \{([\s\S]*?)\};/,
    )?.[1] as string;
    expect(block).toBeDefined();
    const normalized = block.replace(/\s+/g, " ").trim();
    expect(normalized).toBe(
      "timeoutMillis: 1000, memoryBytes: 64 * 1024 * 1024, maxInputBytes: 1024 * 1024,",
    );
  });

  test("`RUN_FUNCTION_LIMITS` は非 export のままである(限定11 = 公開 export を1本も足さない)", () => {
    expect(runner).toContain("const RUN_FUNCTION_LIMITS: IslandLimits = {");
    expect(runner).not.toContain("export const RUN_FUNCTION_LIMITS");
    // スナップショット(export 集合の凍結)にも現れない。
    const snapshot = sourceText("scripts/kernel-export-snapshot.txt");
    expect(snapshot).not.toContain("RUN_FUNCTION_LIMITS");
  });

  test("その定数が `runIslandSync` の limits としてそのまま渡っている(別名・上書きを挟んでいない)", () => {
    expect(runner).toContain("limits: RUN_FUNCTION_LIMITS,");
    // 値を作り替える経路(スプレッドでの上書き / プロパティへの再代入)がどこにも無い。
    expect(runner).not.toMatch(/\.\.\.RUN_FUNCTION_LIMITS/);
    expect(runner).not.toMatch(/RUN_FUNCTION_LIMITS\.\w+\s*=/);
  });
});

// =============================================================================
// §4 【完了条件4】$defs/action_value が今日と同一(ADR-0013 限定12 不可侵)
//
// 既存の `src/kernel/run-function.test.ts:703`(V2-M3-T02)は**消していない。**
// 本節はそこに**足す** —— あちらは `type` / `if` / `then` / `else` の4点を見ており、
// こちらは**キー集合ごと**(`$comment` / `description` を含む全バイト)を固定する。
// =============================================================================

describe("V3-M9-T03 完了条件4: `$defs/action_value` が今日と同一である", () => {
  const actionValue = canonicalSchema("manifest.schema.json").$defs.action_value;

  test("キー集合が6つのまま(演算子・関数・連結の置き場を1つも作っていない)", () => {
    expect(Object.keys(actionValue)).toEqual([
      "$comment",
      "description",
      "type",
      "if",
      "then",
      "else",
    ]);
  });

  test("pattern が単一トークンのまま(既存検査と同じ4点。消さずに重ねる)", () => {
    expect(actionValue.type).toBe("string");
    expect(actionValue.if).toEqual({ type: "string", pattern: "^\\$" });
    expect(actionValue.then).toEqual({ pattern: "^\\$record\\.(_id|[a-z][a-z0-9_-]*)$" });
    expect(actionValue.else).toEqual({ pattern: "^[^{}]*$" });
  });

  test("$comment が「演算子・条件式・関数呼び出し・文字列連結を1つも足してはならない」を今も持つ", () => {
    expect(String(actionValue.$comment)).toContain(
      "演算子・条件式・関数呼び出し・文字列連結を1つも足してはならない",
    );
    expect(String(actionValue.$comment)).toContain("門A");
  });

  test("`target` / `values` / `payload` / `fallback` / `input` は今も `action_value` を共有している(式の抜け道を作っていない)", () => {
    const props = canonicalSchema("manifest.schema.json").$defs.workflow_action.properties;
    expect(props.target.$ref).toBe("#/$defs/action_value");
    expect(props.values.additionalProperties.$ref).toBe("#/$defs/action_value");
    expect(props.payload.additionalProperties.$ref).toBe("#/$defs/action_value");
    expect(props.fallback.$ref).toBe("#/$defs/action_value");
    expect(props.input.additionalProperties.$ref).toBe("#/$defs/action_value");
  });
});

// =============================================================================
// §5 / §6 実行を伴う検査(本物の SQLite・本物の QuickJS-WASM)
// =============================================================================

const APP_ID = "boundary-app";
let dataRoot: string;
let db: Database;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-v3m9-t03-"));
  await mkdir(join(dataRoot, "apps", APP_ID), { recursive: true });
  db = new Database(appDbPath(dataRoot, APP_ID), { create: true });
});

afterEach(async () => {
  db.close();
  await rm(dataRoot, { recursive: true, force: true });
});

function rowsOf(manifest: Manifest, tableId: string): RecordRow[] {
  const result = listRecords(db, manifest, tableId);
  if (!result.ok) {
    throw new Error(`${tableId} を読めませんでした`);
  }
  return result.value;
}

function history(manifest: Manifest): { status: string; error: string | null }[] {
  return rowsOf(manifest, "wf-runs").map((row) => ({
    status: row.status as string,
    error: (row.error ?? null) as string | null,
  }));
}

function mustCreate(
  manifest: Manifest,
  tableId: string,
  input: Record<string, unknown>,
): RecordRow {
  const result = createRecord(db, manifest, tableId, input);
  if (!result.ok) {
    throw new Error(`${tableId} の作成に失敗: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

// =============================================================================
// §5 【完了条件5】売り越し —— **今日は経路が無い**
//
// `D-G15` は保留であり、実装は1バイトも無い。したがって本節が示すのは次の3点である:
//
//   (a) ワークフローの `update_record` / `write_back` は版(`expectedVersion`)を渡さない
//       —— **ソースの実測**(`workflow-runner.ts:665` / `:1089` の逐語と、呼び出しの引数の数)。
//   (b) その経路は LWW である —— 読み取り-計算-書込を挟むと**先の書込が黙って消える。**
//   (c) 相対更新(`stock - qty`)をマニフェストに書く口が今日は無い(§1 の D7b が実測済み)。
//
// ## **CAS が効いている対照は作れなかった。作れなかったと書く**
//
// 対照になりうるのは「同じワークフロー経路に版一致更新が入った形」だが、**その形は
// 存在しない**(`D-G15` 保留)。`updateRecord` の第6引数 `expectedVersion` を渡す CAS は
// `records.ts` の API に実在し、`src/kernel/records.test.ts:770`〜`:790` が既に検査して
// いるが、**それはワークフロー経路の対照ではない**(配線層の話であり、本節が測っている
// 経路には掛からない)。**本ファイルはそれを対照として作らない。**
// =============================================================================

function stockManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "在庫",
      tables: [
        {
          id: "products",
          name: "商品",
          fields: [
            { id: "title", name: "名前", type: "text" },
            { id: "stock", name: "在庫", type: "number" },
          ],
        },
        {
          id: "orders",
          name: "注文",
          fields: [
            { id: "product", name: "商品", type: "reference", reference_table: "products" },
            { id: "qty", name: "数量", type: "number" },
          ],
        },
        { id: "wf-runs", name: "実行履歴", fields: historyFields() },
      ],
      views: [],
    },
  };
}

describe("V3-M9-T03 完了条件5: 売り越しの破壊実験 —— D-G15 は保留で、今日は経路が無い", () => {
  test("(a) ワークフローの `update_record` は版(expectedVersion)を渡さない —— ソースの実測", () => {
    const runner = sourceText("src/kernel/workflow-runner.ts");
    expect(runner).toContain("**版(expectedVersion)は渡さない = LWW を維持する**");
    // 呼び出しの引数は5つ(第6引数 expectedVersion が無い)。
    expect(runner).toContain(
      "const result = updateRecord(db, manifest, action.table, target.value, values.value);",
    );
    // `write_back` の書き戻しも同じ(6引数目が無い)。
    expect(runner).toContain(
      "const result = updateRecord(db, manifest, targetTable, record._id, row);",
    );
    // ファイル全体で `expectedVersion` は**コメントに2回現れるだけ**で、引数として1度も渡らない。
    const occurrences = runner.match(/expectedVersion/g) ?? [];
    expect(occurrences).toHaveLength(2);
    expect(runner).not.toMatch(/updateRecord\([^)]*expectedVersion/);
  });

  test("(b) その経路は LWW である —— 読み取り-計算-書込を挟むと先の書込が黙って消える(売り越し)", () => {
    const manifest = stockManifest();
    applyManifestDdl(db, manifest);
    const product = mustCreate(manifest, "products", { title: "本", stock: 10 });

    // **「同時に来た2つの注文」を、カーネルが今日持っている経路だけで再現する。**
    // ワークフローには読み取り-計算-書込が無い(D7b で実測済み)ので、読み取りと計算は
    // 呼び出し側(= 本テスト)が行うしかない。これが `D-G15` が解こうとしている形である。
    const readA = rowsOf(manifest, "products")[0] as RecordRow;
    const readB = rowsOf(manifest, "products")[0] as RecordRow;
    expect(readA.stock).toBe(10);
    expect(readB.stock).toBe(10);

    // A が 3 個引き当てる(10 - 3 = 7)。
    const wroteA = updateRecord(db, manifest, "products", product._id, {
      stock: (readA.stock as number) - 3,
    });
    expect(wroteA.ok).toBe(true);
    // B が 5 個引き当てる(**古い 10 を見たまま** 10 - 5 = 5)。
    const wroteB = updateRecord(db, manifest, "products", product._id, {
      stock: (readB.stock as number) - 5,
    });
    // **拒否されない。** 版が進んでいても、この経路は衝突を1度も見ない。
    expect(wroteB.ok).toBe(true);

    // 正しければ 10 - 3 - 5 = 2 のはずが、**5 になる**(A の引き当てが消えた = 売り越し)。
    expect(rowsOf(manifest, "products")[0]?.stock).toBe(5);
    expect(rowsOf(manifest, "products")[0]?.stock).not.toBe(2);
  });

  test("(c) 在庫を減らすワークフローは今日1本も書けない —— 相対更新も、別行の現在値の読み取りも、宣言する場所が無い", () => {
    // (c-1) 相対更新をリテラルとして書くと、apply 前に拒否される(§1 D7b と同じ関門)。
    const relative = stockManifest();
    relative.app.workflows = [
      {
        id: "reserve",
        name: "在庫を引き当てる",
        trigger: { type: "on_create", table: "orders" },
        actions: [
          {
            action: "update_record",
            table: "products",
            target: "$record.product",
            values: { stock: "$record.stock - $record.qty" },
          },
        ],
        history_table: "wf-runs",
      } as Any,
    ];
    expectInvalid(validateManifest(relative));

    // (c-2) 「別行の現在値」を指す語彙も無い —— `$record.` はトリガー元1行のフィールドだけで、
    //       更新先(products)の現在値を指すトークンは `action_value` の pattern に無い。
    const crossRow = stockManifest();
    crossRow.app.workflows = [
      {
        id: "reserve",
        name: "在庫を引き当てる",
        trigger: { type: "on_create", table: "orders" },
        actions: [
          {
            action: "update_record",
            table: "products",
            target: "$record.product",
            values: { stock: "$target.stock" },
          },
        ],
        history_table: "wf-runs",
      } as Any,
    ];
    expectInvalid(validateManifest(crossRow));

    // (c-2b) **数値フィールドにはリテラルすら書けない**(類型10 の型整合)——
    //        `stock: "0"` は「文字列を number 列へ」として apply 時に拒否される。
    //        つまり在庫列に書ける値は「トリガー元の number 列の値」だけである。
    const literalZero = stockManifest();
    literalZero.app.workflows = [
      {
        id: "reserve",
        name: "在庫を0にする",
        trigger: { type: "on_create", table: "orders" },
        actions: [
          {
            action: "update_record",
            table: "products",
            target: "$record.product",
            values: { stock: "0" },
          },
        ],
        history_table: "wf-runs",
      } as Any,
    ];
    expect(validateManifest(literalZero)).toEqual({ valid: true });
    expectInvalid(validateReferentialIntegrity(literalZero));

    // (c-3) **今日書ける唯一の形は「トリガー元の number 列の値でそのまま上書きする」である。**
    //       書けることを実測し、それが引き当て(減算)になっていないことを示す。
    const overwrite = stockManifest();
    overwrite.app.workflows = [
      {
        id: "reserve",
        name: "在庫を注文数量で上書きする",
        trigger: { type: "on_create", table: "orders" },
        actions: [
          {
            action: "update_record",
            table: "products",
            target: "$record.product",
            values: { stock: "$record.qty" },
          },
        ],
        history_table: "wf-runs",
      } as Workflow,
    ];
    expect(validateManifest(overwrite)).toEqual({ valid: true });
    expect(validateReferentialIntegrity(overwrite)).toEqual({ valid: true });

    applyManifestDdl(db, overwrite);
    const product = mustCreate(overwrite, "products", { title: "本", stock: 10 });
    mustCreate(overwrite, "orders", { product: product._id, qty: 3 });
    // 10 - 3 = 7 にはならない。**注文数量 3 がそのまま在庫になる**(現在値を読んでいない)。
    expect(rowsOf(overwrite, "products")[0]?.stock).toBe(3);
    expect(rowsOf(overwrite, "products")[0]?.stock).not.toBe(7);
    expect(history(overwrite).filter((h) => h.status === "success")).toHaveLength(1);
  });
});

// =============================================================================
// §6 【完了条件6】連鎖の上限 —— **複数入力を持つ run_function を経路に含めて**
// =============================================================================

/** 2要素の入力(トリガー元レコード + マスタ表)を持つ関数を1本持つマニフェスト。 */
function chainManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "連鎖",
      tables: [
        { id: "catalog", name: "マスタ", fields: [{ id: "price", name: "価格", type: "number" }] },
        {
          id: "orders",
          name: "注文",
          fields: [
            { id: "qty", name: "数量", type: "number" },
            { id: "label", name: "見出し", type: "text" },
            { id: "product", name: "商品", type: "reference", reference_table: "products" },
          ],
        },
        { id: "signals", name: "合図", fields: [{ id: "note", name: "覚書", type: "text" }] },
        {
          id: "products",
          name: "商品",
          fields: [{ id: "title", name: "名前", type: "text" }],
        },
        { id: "wf-runs", name: "実行履歴", fields: historyFields() },
      ],
      views: [],
      functions: [
        {
          id: "calc",
          name: "複数入力の計算",
          // **島が突き合わせる。カーネルは1ホップも辿らない。**
          /*
           * **【`V8-M26`(2026-08-10)】島の出力に持ち主を1つ足した。**
           * **島が書いた `signals` の行が、次の段(`w-signal`)の発火の書き手になる。**
           * **持ち主が入っていないと書き手が `null` になり、連鎖が1段目で止まって
           * 「連鎖の上限」を測れない。** **測っている連鎖の長さは1バイトも変えていない。**
           */
          code: `(inputs) => { const rec = inputs[0]; const catalog = inputs[1]; return [{ note: String((rec.qty || 0) * (catalog.length ? catalog[0].price : 0)), st_owner: ${JSON.stringify(FIXTURE_ACTOR_ID)} }]; }`,
          input: [{ source: "record" }, { source: "table", table: "catalog" }],
          output: {
            fields: [
              { id: "note", type: "text" },
              { id: "st_owner", type: "text" },
            ],
          },
          capabilities: [],
        } as Any,
      ],
    },
  };
}

describe("V3-M9-T03 完了条件6: 連鎖の上限が保たれる(複数入力の run_function を経路に含めて)", () => {
  test("`WORKFLOW_MAX_DEPTH` は 20 のままである", () => {
    expect(WORKFLOW_MAX_DEPTH).toBe(20);
  });

  test("複数入力の run_function が別行の on_create を発火させる連鎖は、深度上限ちょうどで止まる", () => {
    const manifest = chainManifest();
    manifest.app.workflows = [
      {
        id: "w-order",
        name: "注文 → 島(複数入力)→ signals へ全置換",
        trigger: { type: "on_create", table: "orders" },
        actions: [{ action: "run_function", function: "calc", output_table: "signals" }],
        history_table: "wf-runs",
      },
      {
        id: "w-signal",
        name: "signals → 新しい注文",
        trigger: { type: "on_create", table: "signals" },
        actions: [{ action: "create_record", table: "orders", values: { label: "次" } }],
        history_table: "wf-runs",
      },
    ];
    expect(validateManifest(manifest)).toEqual({ valid: true });
    expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });

    applyManifestDdl(db, manifest);
    mustCreate(manifest, "catalog", { price: 100 });
    // 【V3-M13-T02 / ADR-0066 による期待値の更新】上限到達は「失敗」になった(限定16)ので、
    // **連鎖ごと巻き戻る。**上限で止まること自体は1バイトも変わっていない ——
    // 変わったのは「止まったときに何が残るか」である。
    const created = createRecord(db, manifest, "orders", { qty: 1 });
    expect(created.ok).toBe(false);
    if (created.ok) {
      throw new Error("失敗するはずの書込が成功しました。");
    }
    const message = String(created.errors[0]?.message);
    expect(message).toContain("深度上限");
    expect(message).toContain(String(WORKFLOW_MAX_DEPTH));
    // **島が毎段走っても上限は伸びない。**行は1つも残らない。
    expect(rowsOf(manifest, "orders")).toHaveLength(0);
    expect(rowsOf(manifest, "signals")).toHaveLength(0);
    // 【V3-M13-T04 による期待値の更新】**段ごとの失敗の記録は書き直されて残る**
    // (ADR-0066 限定5)。数は上限から機械的に導く(0 段目から上限に当たった段まで)。
    const runs = history(manifest);
    expect(runs).toHaveLength(WORKFLOW_MAX_DEPTH + 1);
    expect(runs.every((row) => row.status === "failure")).toBe(true);
  });

  test("複数入力の run_function が別行の on_update を発火させる連鎖は、再発火抑止で止まる(深度上限より先に効く)", () => {
    const manifest = chainManifest();
    applyManifestDdl(db, manifest);
    mustCreate(manifest, "catalog", { price: 100 });
    // **定数 UUID で別行を狙う = ADR-0040 の3形のうち (iii)。1ホップも越えていない。**
    const product = mustCreate(manifest, "products", { title: "初期" });

    manifest.app.workflows = [
      {
        id: "w-order",
        name: "注文 → 島(複数入力)→ signals へ全置換",
        trigger: { type: "on_create", table: "orders" },
        actions: [{ action: "run_function", function: "calc", output_table: "signals" }],
        history_table: "wf-runs",
      },
      {
        id: "w-signal",
        name: "signals → 別行(商品)の更新",
        trigger: { type: "on_create", table: "signals" },
        actions: [
          {
            action: "update_record",
            table: "products",
            target: product._id,
            values: { title: "触れた" },
          },
        ],
        history_table: "wf-runs",
      },
      {
        id: "w-product",
        name: "商品の更新 → 新しい注文",
        trigger: { type: "on_update", table: "products" },
        actions: [{ action: "create_record", table: "orders", values: { label: "商品から" } }],
        history_table: "wf-runs",
      },
    ];
    expect(validateManifest(manifest)).toEqual({ valid: true });
    expect(validateReferentialIntegrity(manifest)).toEqual({ valid: true });

    // 【期待値の更新(ADR-0066 §改訂1 = V3-M13-T13)】**再発火抑止は「失敗」ではない。**
    // `V3-M13-T02` の時点では抑止も失敗だったので連鎖ごと巻き戻っていた。今日は
    // 連鎖が有限で止まり、**発火元の書込は成立する**(V2-M3 以前と同じ形へ戻った)。
    const created = createRecord(db, manifest, "orders", { qty: 1 });
    expect(created.ok).toBe(true);
    // 止まった理由が **「再発火抑止」**であること(深度上限ではない)を履歴で読む。
    // 【V4-M4-T02 / ADR-0072 による期待値の更新】抑止の履歴行の `status` が3値目になった。
    // **行が残ることは1バイトも変わっていない**(限定5)。
    const suppressed = rowsOf(manifest, "wf-runs").filter((row) => row.status === "suppressed");
    expect(suppressed.length).toBeGreaterThanOrEqual(1);
    // **抑止は「失敗」として数えられない**(限定1 の射程はここだけ)。
    expect(rowsOf(manifest, "wf-runs").filter((row) => row.status === "failure")).toHaveLength(0);
    const errors = suppressed.map((row) => String(row.error)).join("\n");
    expect(errors).toContain("再発火");
    expect(errors).not.toContain("深度上限");
    // 商品は1度だけ「触れた」に変わる(連鎖は暴走していない)。
    expect(rowsOf(manifest, "products")[0]?.title).toBe("触れた");
  });
});

// =============================================================================
// §3b 【完了条件3 の後半】複数入力でも入力サイズの上限で fail-closed する
//
// T01 は「2表 × 約660KB」で和が 1 MiB を越えることを実測した。**本節は角度を変えて
// `maxItems` ちょうどの5要素**で測る(T01 が測っていない側)。
// =============================================================================

describe("V3-M9-T03 完了条件3(後半): 5要素(maxItems ちょうど)でも総バイト数の上限で fail-closed する", () => {
  function bigManifest(): Manifest {
    const bulk = (id: string) => ({
      id,
      name: id,
      fields: [{ id: "body", name: "本文", type: "long_text" as const }],
    });
    return {
      app: {
        id: APP_ID,
        name: "大きな入力",
        tables: [
          { id: "orders", name: "注文", fields: [{ id: "qty", name: "数量", type: "number" }] },
          bulk("b1"),
          bulk("b2"),
          bulk("b3"),
          bulk("b4"),
          { id: "out", name: "出力", fields: [{ id: "note", name: "覚書", type: "text" }] },
          { id: "wf-runs", name: "実行履歴", fields: historyFields() },
        ],
        views: [],
        functions: [
          {
            id: "calc",
            name: "5要素",
            code: "(inputs) => [{ note: String(inputs.length) }]",
            input: [
              { source: "record" },
              { source: "table", table: "b1" },
              { source: "table", table: "b2" },
              { source: "table", table: "b3" },
              { source: "table", table: "b4" },
            ],
            output: { fields: [{ id: "note", type: "text" }] },
            capabilities: [],
          } as Any,
        ],
        workflows: [
          {
            id: "w",
            name: "実行",
            trigger: { type: "on_create", table: "orders" },
            actions: [{ action: "run_function", function: "calc", output_table: "out" }],
            history_table: "wf-runs",
          },
        ],
      },
    };
  }

  test("5要素の合計が 1 MiB を越えると `input_too_large` で fail-closed し、出力は1バイトも書かれない", () => {
    const manifest = bigManifest();
    expect(validateManifest(manifest)).toEqual({ valid: true });
    applyManifestDdl(db, manifest);
    // 4表 × 20行 × 16000 文字 ≒ 1.28 MB(> 1 MiB)。**和であって積ではない。**
    const body = "x".repeat(16000);
    for (const table of ["b1", "b2", "b3", "b4"]) {
      for (let i = 0; i < 20; i += 1) {
        mustCreate(manifest, table, { body });
      }
    }
    // 【期待値の更新(ADR-0066)】fail-closed が発火元の書込ごと落とす。
    // **上限は1バイトも動かしていない**(限定15)。
    const created = createRecord(db, manifest, "orders", { qty: 1 });
    expect(created.ok).toBe(false);
    if (created.ok) {
      throw new Error("失敗するはずの書込が成功しました。");
    }
    expect(String(created.errors[0]?.message)).toContain("input_too_large");
    expect(rowsOf(manifest, "out")).toHaveLength(0);
  });

  test("同じ5要素でも合計が上限内なら通る(落ちた理由が「要素数」ではなく「総バイト数」であること)", () => {
    const manifest = bigManifest();
    applyManifestDdl(db, manifest);
    const body = "x".repeat(1000);
    for (const table of ["b1", "b2", "b3", "b4"]) {
      for (let i = 0; i < 5; i += 1) {
        mustCreate(manifest, table, { body });
      }
    }
    mustCreate(manifest, "orders", { qty: 1 });

    const rows = history(manifest);
    expect(rows.filter((r) => r.status === "failure")).toHaveLength(0);
    // 島は宣言順に並んだ**5要素の配列**を受け取った(カーネルは結合していない)。
    expect(rowsOf(manifest, "out")[0]?.note).toBe("5");
  });
});
