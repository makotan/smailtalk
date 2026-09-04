/**
 * **一続きの流れ(`flow`)の宣言の器**(`V10-M4-T01`。`NV-G9` / `ADR-0359` §4b 限定1〜限定8 /
 * `NV-G11` / `ADR-0360` 限定1・限定2)。
 *
 * ## これは何で、何ではないか(**先に書く。誇張しない**)
 *
 * - **足したのは `$defs/view` の1本(`flow`)と、`view_changes` の同名1本だけである**
 *   (`ADR-0359` §4b 限定1 / §Decision 2)。**`$defs` の本数(30)は1つも増やしていない** ——
 *   **`custom_css` と同じインラインで書いた。**
 * - **値の形は3つで閉じる**(限定2)—— `id`(流れのID)/ `step`(位置。1から始まる整数)/
 *   `kind`(段の種類。**今日は2値**)。**4つ目のサブキーを作っていない。条件・式・演算を
 *   1つも作っていない。**
 * - **書けるのは `form` / `list_view` / `detail_view` の3種別である。**
 *   **`report_view` は `allOf` で `false` に閉じてある** —— **これは `ADR-0359` にも
 *   `ADR-0360` にも1条も書かれていない判断であり、「語彙は狭く始める」に倒した
 *   メインの決定である**(`V10-M4` 計画 §2 決1)。
 *   **【正直に書く】ここに非対称が1つ生まれる** —— **`after_delete` は行き先として
 *   `report_view` を許している**(`ADR-0359` §4a 限定4)。**つまり「削除の後に集計表へ
 *   飛べるが、集計表は流れの段になれない」。**
 * - **確認の段(`kind: "confirm"`)を置けるのは `detail_view` だけである**
 *   (`ADR-0360` 限定2)—— **`form` / `list_view` は `allOf` で `kind` を `"input"` に
 *   固定してある。**
 * - **位置の重複と欠番は差分の適用時に拒否する**(`ADR-0359` §4b 限定3)。
 *
 * ## ここで**書いていない**検査2本と、その理由(**隠さない**)
 *
 * `ADR-0359` §Consequences は `V10-M4-T01` に3本の適用時検査を課しているが、
 * **そのうち2本は構造的に対象が無い**(`V10-M4` 計画 §2 決11):
 *
 * 1. **「実在するビューID」の検査は書いていない** —— **`flow` の値の形にビューIDが
 *    1つも無いからである。** `flow.id` は**流れ**の名前であって画面の名前ではない。
 *    (`after_delete` はビューIDを値に取るので実在の検査が要った。ここは形が違う。)
 * 2. **「流れIDの一意」の検査も書いていない** —— **同じ `flow.id` を複数の画面が持つのが
 *    正常な姿だからである**(同じ流れIDを持つ画面を位置で並べたものが流れである。
 *    限定3)。**「一意」を主張する別のものが構造的に存在しない。**
 *    **その代わり「1つの流れの中で位置が一意(重複しない)」を (g) が測る。**
 *
 * ## 表示層はここでは測っていない
 *
 * **段の並びを読んで次の段への導線を描くこと・確認の段の描画は `V10-M4-T02` /
 * `V10-M4-T03` の担当である。** ここが見るのは宣言の器だけである。
 */

import { describe, expect, test } from "bun:test";
import diffSchema from "../../schemas/diff.schema.json" with { type: "json" };
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import { foldOperations } from "./apply-diff.ts";
import type { Manifest, View } from "./types.ts";
import { DIFF_OPS, FIELD_TYPES, RESOURCE_KINDS } from "./types.ts";
import { validateManifest, validateManifestFull } from "./validate.ts";

/** 本タスクが足したキー。**異なり1語である。** */
const KEY = "flow";

type Any = Record<string, unknown>;

function defs(): Record<string, Any> {
  return (manifestSchema as unknown as { $defs: Record<string, Any> }).$defs;
}

function viewSchema(): Any {
  return defs().view as Any;
}

function viewChangesSchema(): Any {
  return (diffSchema as unknown as { $defs: Record<string, Any> }).$defs.view_changes as Any;
}

function branchOf(type: string): { if: Any; then?: Any } | undefined {
  return (viewSchema().allOf as { if: Any; then?: Any }[]).find(
    (branch) => ((branch.if.properties as Any)?.type as Any)?.const === type,
  );
}

function baseManifest(views: View[]): Manifest {
  return {
    app: {
      id: "shop",
      name: "店",
      tables: [
        {
          id: "orders",
          name: "注文",
          fields: [
            { id: "memo", name: "メモ", type: "text" },
            { id: "state", name: "状態", type: "select", options: ["受付", "完了"] },
          ],
        },
      ],
      views,
    },
  } as unknown as Manifest;
}

function listView(overrides: Record<string, unknown> = {}): View {
  return {
    id: "cart",
    type: "list_view",
    table: "orders",
    columns: ["memo"],
    ...overrides,
  } as unknown as View;
}

function formView(overrides: Record<string, unknown> = {}): View {
  return {
    id: "address",
    type: "form",
    table: "orders",
    fields: ["memo"],
    ...overrides,
  } as unknown as View;
}

function detailView(overrides: Record<string, unknown> = {}): View {
  return {
    id: "confirm",
    type: "detail_view",
    table: "orders",
    ...overrides,
  } as unknown as View;
}

function reportView(overrides: Record<string, unknown> = {}): View {
  return {
    id: "summary",
    type: "report_view",
    table: "orders",
    report: { group_by: [{ field: "state" }], aggregates: [{ type: "count" }] },
    ...overrides,
  } as unknown as View;
}

/** 入力の段。 */
function input(id: string, step: number): Record<string, unknown> {
  return { [KEY]: { id, step, kind: "input" } };
}

/** 確認の段(`detail_view` だけに置ける)。 */
function confirm(id: string, step: number): Record<string, unknown> {
  return { [KEY]: { id, step, kind: "confirm" } };
}

// ---------------------------------------------------------------------------
// (a) 限定1: 増分はキー1本ちょうどで、語彙の定数は1つも動かない
// ---------------------------------------------------------------------------

describe("(T01-a) 増分はキー1本ちょうどである(ADR-0359 §4b 限定1)", () => {
  test("$defs/view.properties は 31 / $defs は 30 / view_changes は 27 である", () => {
    expect(Object.keys(viewSchema().properties as Any)).toHaveLength(31);
    // **`$defs` の本数は 30 のまま1つも増えない** —— **`flow` は `custom_css` と同じ
    // インラインで書いた。****新しい `$defs` を作らない**(限定1 / 限定3)。
    expect(Object.keys(defs())).toHaveLength(30);
    expect(Object.keys(viewChangesSchema().properties as Any)).toHaveLength(27);
  });

  test("flow は $defs/view.properties の末尾(31本目)である", () => {
    const keys = Object.keys(viewSchema().properties as Any);
    expect(keys[30]).toBe(KEY);
  });

  test("flow は view_changes.properties の末尾(27本目)である", () => {
    const keys = Object.keys(viewChangesSchema().properties as Any);
    expect(keys[26]).toBe(KEY);
  });

  test("RESOURCE_KINDS(8)/ FIELD_TYPES(9)/ DIFF_OPS(17)を1要素も増やしていない", () => {
    expect(RESOURCE_KINDS).toHaveLength(8);
    expect(FIELD_TYPES).toHaveLength(9);
    expect(DIFF_OPS).toHaveLength(17);
  });

  test("$defs/view_type の5種目を作っていない(4値のまま)", () => {
    expect((defs().view_type as Any).enum as string[]).toHaveLength(4);
  });

  test("$defs/view_action の5形目を作っていない(ADR-0360 限定3)", () => {
    expect(Object.keys((defs().view_action as Any).properties as Any)).toHaveLength(8);
  });

  test("差分スキーマ側は manifest 側を $ref するだけで、定義を二重に持たない", () => {
    const flow = (viewChangesSchema().properties as Any)[KEY] as Any;
    expect(flow.$ref).toBe(
      "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/view/properties/flow",
    );
    expect(flow.type).toBeUndefined();
    expect(flow.properties).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (b) 限定2: 値の形は3つで閉じる
// ---------------------------------------------------------------------------

describe("(T01-b) 値の形は id / step / kind の3つで閉じる(ADR-0359 §4b 限定2)", () => {
  test("3つそろえば通る", () => {
    expect(validateManifestFull(baseManifest([listView(input("checkout", 1))]))).toEqual({
      valid: true,
    });
  });

  test("id / step / kind はどれも省けない(3つとも required)", () => {
    for (const partial of [
      { id: "checkout", step: 1 },
      { id: "checkout", kind: "input" },
      { step: 1, kind: "input" },
      {},
    ]) {
      expect(
        validateManifest(baseManifest([listView({ [KEY]: partial })])).valid,
        JSON.stringify(partial),
      ).toBe(false);
    }
  });

  test("4つ目のサブキーは書けない(additionalProperties: false)", () => {
    for (const extra of ["name", "label", "icon", "progress", "when", "condition"]) {
      expect(
        validateManifest(
          baseManifest([
            listView({ [KEY]: { id: "checkout", step: 1, kind: "input", [extra]: "x" } }),
          ]),
        ).valid,
        extra,
      ).toBe(false);
    }
  });

  test("値はオブジェクトであり、文字列にも配列にもできない", () => {
    for (const value of ["checkout", ["checkout"], 1, true, null]) {
      expect(
        validateManifest(baseManifest([listView({ [KEY]: value })])).valid,
        JSON.stringify(value),
      ).toBe(false);
    }
  });

  test("step は1から始まる整数である(0 / 負 / 小数 / 文字列は拒否)", () => {
    for (const step of [0, -1, 1.5, "1", null]) {
      expect(
        validateManifest(
          baseManifest([listView({ [KEY]: { id: "checkout", step, kind: "input" } })]),
        ).valid,
        JSON.stringify(step),
      ).toBe(false);
    }
  });

  test("kind は input / confirm の2値だけである(3値目を書けない)", () => {
    expect(((viewSchema().properties as Any)[KEY] as Any).properties as Any).toHaveProperty("kind");
    const kind = (((viewSchema().properties as Any)[KEY] as Any).properties as Any).kind as Any;
    expect(kind.enum).toEqual(["input", "confirm"]);
    for (const bad of ["done", "review", "start", "INPUT"]) {
      expect(
        validateManifest(
          baseManifest([listView({ [KEY]: { id: "checkout", step: 1, kind: bad } })]),
        ).valid,
        bad,
      ).toBe(false);
    }
  });

  test("流れは1つのアプリの中に閉じる —— 外部 URL を1文字も書けない(限定4)", () => {
    for (const id of ["https://example.com/checkout", "../other-app", "other app"]) {
      expect(
        validateManifest(baseManifest([listView({ [KEY]: { id, step: 1, kind: "input" } })])).valid,
        id,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// (c) 書ける種別 —— report_view だけ閉じている(メインの決定。ADR には無い)
// ---------------------------------------------------------------------------

describe("(T01-c) flow を書けるのは form / list_view / detail_view の3種別である", () => {
  test("3種別のどれに書いても通る", () => {
    expect(
      validateManifestFull(
        baseManifest([
          listView(input("checkout", 1)),
          formView(input("checkout", 2)),
          detailView(input("checkout", 3)),
        ]),
      ),
    ).toEqual({ valid: true });
  });

  test("report_view に書いた差分は拒否される", () => {
    const result = validateManifest(baseManifest([reportView(input("checkout", 1))]));
    expect(result.valid).toBe(false);
  });

  test("allOf で flow を false に閉じている分岐は report_view の1つだけである", () => {
    const branches = viewSchema().allOf as { if: Any; then?: Any }[];
    const forbidden = branches
      .filter((branch) => (branch.then?.properties as Any)?.[KEY] === false)
      .map((branch) => ((branch.if.properties as Any).type as Any)?.const as string);
    expect(forbidden).toEqual(["report_view"]);
  });
});

// ---------------------------------------------------------------------------
// (d) ADR-0360 限定2: 確認の段を置けるのは detail_view だけ
// ---------------------------------------------------------------------------

describe("(T01-d) 確認の段(kind: confirm)を置けるのは detail_view だけである(ADR-0360 限定2)", () => {
  test("detail_view には置ける", () => {
    expect(validateManifestFull(baseManifest([detailView(confirm("checkout", 1))]))).toEqual({
      valid: true,
    });
  });

  test("form に置いた差分は拒否される", () => {
    expect(validateManifest(baseManifest([formView(confirm("checkout", 1))])).valid).toBe(false);
  });

  test("list_view に置いた差分は拒否される", () => {
    expect(validateManifest(baseManifest([listView(confirm("checkout", 1))])).valid).toBe(false);
  });

  test("form / list_view の分岐は kind を input に固定している(値域を丸ごと閉じてはいない)", () => {
    for (const type of ["form", "list_view"]) {
      const flow = (branchOf(type)?.then?.properties as Any)?.[KEY] as Any;
      expect(flow, type).toBeDefined();
      expect(flow, type).not.toBe(false);
      expect(((flow.properties as Any).kind as Any).const, type).toBe("input");
    }
  });

  test("detail_view の分岐は flow について1文字も書いていない(2値とも許す)", () => {
    expect((branchOf("detail_view")?.then?.properties as Any)?.[KEY]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (e) 限定3: 位置の重複と欠番は適用時に拒否する
// ---------------------------------------------------------------------------

describe("(T01-e) 位置の重複と欠番は適用時に拒否される(ADR-0359 §4b 限定3)", () => {
  test("1..N の連番なら通る", () => {
    expect(
      validateManifestFull(
        baseManifest([
          listView(input("checkout", 1)),
          formView(input("checkout", 2)),
          detailView(confirm("checkout", 3)),
        ]),
      ),
    ).toEqual({ valid: true });
  });

  test("同じ流れの中で位置が重複していると拒否される", () => {
    const result = validateManifestFull(
      baseManifest([listView(input("checkout", 1)), formView(input("checkout", 1))]),
    );
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result)).toContain("重複");
  });

  test("位置に欠番があると拒否される(1 と 3 だけを書く)", () => {
    const result = validateManifestFull(
      baseManifest([listView(input("checkout", 1)), formView(input("checkout", 3))]),
    );
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result)).toContain("2");
  });

  test("1から始まっていないと拒否される(2 と 3 だけを書く)", () => {
    const result = validateManifestFull(
      baseManifest([listView(input("checkout", 2)), formView(input("checkout", 3))]),
    );
    expect(result.valid).toBe(false);
  });

  test("重複と欠番はそれぞれ別のメッセージで報告される", () => {
    const result = validateManifestFull(
      baseManifest([
        listView(input("checkout", 1)),
        formView(input("checkout", 1)),
        detailView(input("checkout", 4)),
      ]),
    );
    expect(result.valid).toBe(false);
    const text = JSON.stringify(result);
    expect(text).toContain("重複");
    expect(text).toContain("抜けています");
  });

  test("流れが2本あっても、位置は流れごとに数える(別々の流れは干渉しない)", () => {
    expect(
      validateManifestFull(
        baseManifest([
          listView({ id: "cart", ...input("checkout", 1) }),
          formView({ id: "address", ...input("checkout", 2) }),
          formView({ id: "signup-1", ...input("signup", 1) }),
          detailView({ id: "signup-2", ...input("signup", 2) }),
        ]),
      ),
    ).toEqual({ valid: true });
  });

  test("段が1つだけの流れ(step: 1 が1画面)も通る", () => {
    expect(validateManifestFull(baseManifest([listView(input("checkout", 1))]))).toEqual({
      valid: true,
    });
  });
});

// ---------------------------------------------------------------------------
// (f) 決11: 書かなかった検査2本 —— 対象が構造的に無いことを実測で示す
// ---------------------------------------------------------------------------

describe("(T01-f) 書かなかった検査2本(V10-M4 計画 §2 決11)", () => {
  test("flow の値の形にビューIDは1つも無い(だから「実在するビューID」の検査は書いていない)", () => {
    const flow = (viewSchema().properties as Any)[KEY] as Any;
    expect(Object.keys(flow.properties as Any)).toEqual(["id", "step", "kind"]);
    // **`after_delete` は `#/$defs/resource_id` を「ビューID」として `$ref` している。**
    // **`flow.id` も同じ**綴りの規約**を `$ref` するが、指すのは**流れ**であって画面ではない。**
    // **画面を名指しするサブキーが1つも無いことが、実在の検査を書かなかった理由である。**
    expect(JSON.stringify(flow)).not.toContain("view_table_id");
  });

  test("同じ flow.id を複数の画面が持つのが正常である(だから「流れIDの一意」の検査は書いていない)", () => {
    expect(
      validateManifestFull(
        baseManifest([
          listView(input("checkout", 1)),
          formView(input("checkout", 2)),
          detailView(input("checkout", 3)),
        ]),
      ),
    ).toEqual({ valid: true });
  });

  test("flow.id はビューIDと同じ綴りでもよい(名前空間を共有しない)", () => {
    expect(
      validateManifestFull(
        baseManifest([listView({ [KEY]: { id: "cart", step: 1, kind: "input" } })]),
      ),
    ).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// (g) 限定10 相当: update_view で後から書けて、値が実際に残る
// ---------------------------------------------------------------------------

describe("(T01-g) update_view で後から書けて、値が実際に残る", () => {
  test("3種別のどれを対象にしても update_view が通り、畳み込み後のマニフェストに値が残る", () => {
    for (const [index, target] of ["cart", "address", "confirm"].entries()) {
      const folded = foldOperations(baseManifest([listView(), formView(), detailView()]), [
        {
          op: "update_view",
          view: target,
          changes: { [KEY]: { id: "checkout", step: 1, kind: "input" } },
        },
      ] as never);
      expect(folded.valid, target).toBe(true);
      if (!folded.valid) {
        throw new Error("fold failed");
      }
      expect((folded.manifest.app.views[index] as Any)[KEY], target).toEqual({
        id: "checkout",
        step: 1,
        kind: "input",
      });
      expect(validateManifestFull(folded.manifest), target).toEqual({ valid: true });
    }
  });

  test("report_view を対象にした update_view はキー単位で拒否される", () => {
    const folded = foldOperations(baseManifest([reportView()]), [
      {
        op: "update_view",
        view: "summary",
        changes: { [KEY]: { id: "checkout", step: 1, kind: "input" } },
      },
    ] as never);
    expect(folded.valid).toBe(false);
  });

  test("update_view で位置を重複させると、畳み込み後のマニフェスト検証が差分全体を拒否する", () => {
    const folded = foldOperations(
      baseManifest([listView(input("checkout", 1)), formView(input("checkout", 2))]),
      [
        {
          op: "update_view",
          view: "address",
          changes: { [KEY]: { id: "checkout", step: 1, kind: "input" } },
        },
      ] as never,
    );
    expect(folded.valid).toBe(true);
    if (!folded.valid) {
      throw new Error("fold failed");
    }
    expect(validateManifestFull(folded.manifest).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (h) 越えてはならない線 —— 却下・将来送りの形を1つも作っていない
// ---------------------------------------------------------------------------

describe("(T01-h) 却下・将来送りの形を1つも作っていない", () => {
  test("段の名前・進捗・条件・持ち回しを表すキーが $defs/view に1つも無い", () => {
    const keys = Object.keys(viewSchema().properties as Any);
    for (const forbidden of [
      "flow_step",
      "flow_label",
      "flow_progress",
      "flow_back",
      "flow_state",
      "wizard",
      "steps",
    ]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  test("ワークフローの起動条件に on_view を足していない(限定6)", () => {
    // **`$comment` の散文には `on_view` の綴りが在る**(`ADR-0174` が「名指しで禁じられた
    // 4つ」を逐語で列挙しているためである)。**見るのは値域の側である。**
    const trigger = defs().workflow_trigger as Any;
    const type = (trigger.properties as Any).type as Any;
    expect(type.enum as string[]).toEqual(["on_create", "on_update", "schedule", "manual"]);
  });
});
