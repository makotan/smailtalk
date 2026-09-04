/**
 * **削除の後の行き先**(`V10-M1-T02`。`NV-G4` / `ADR-0359` §4a 限定1〜限定11)。
 *
 * ## これは何で、何ではないか(**先に書く。誇張しない**)
 *
 * - **足したのは `$defs/view` の1本(`after_delete`)と、`view_changes` の同名1本だけである**
 *   (限定1 / `ADR-0359` §Decision 2)。**`$defs` の本数(30)は1つも増やしていない。**
 * - **書けるのは `detail_view` だけである**(限定2)—— `list_view` / `form` / `report_view` は
 *   `allOf` の `then` で `false` に閉じている。
 * - **行き先にできるのは「1件の行を必要としない画面」だけである**(限定4)——
 *   **`detail_view` / `form` を指した差分は apply 時に拒否される。**
 * - **【禁止】「退会したらお別れの画面へ」が書けるようになったと読まない**(限定7)——
 *   **行き先は同じアプリの実在するビューIDであり、テーブルに紐づかない案内ページは
 *   `E-G3`(却下)で今日も作れない。**
 * - **`flow` を1バイトも実装していない** —— **それは `V10-M4` の担当である**
 *   (`ADR-0359` §4b)。
 *
 * ## 表示層はここでは測っていない
 *
 * **削除が成立したあとに実際に宣言した画面へ移ること、宣言が無いときの既定が1文字も
 * 変わっていないことは `web/test/detail-view-after-delete.test.tsx` が測る。**
 * ここが見るのは宣言の器だけである。
 */

import { describe, expect, test } from "bun:test";
import diffSchema from "../../schemas/diff.schema.json" with { type: "json" };
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import { foldOperations } from "./apply-diff.ts";
import type { Manifest, View } from "./types.ts";
import { validateManifest, validateManifestFull } from "./validate.ts";

/** 本 ADR が足したキー。**異なり1語である**(`flow` は `V10-M4` の担当)。 */
const KEY = "after_delete";

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
    id: "order-list",
    type: "list_view",
    table: "orders",
    columns: ["memo"],
    ...overrides,
  } as unknown as View;
}

function detailView(overrides: Record<string, unknown> = {}): View {
  return {
    id: "order-detail",
    type: "detail_view",
    table: "orders",
    ...overrides,
  } as unknown as View;
}

function formView(overrides: Record<string, unknown> = {}): View {
  return {
    id: "order-form",
    type: "form",
    table: "orders",
    fields: ["memo"],
    ...overrides,
  } as unknown as View;
}

function reportView(overrides: Record<string, unknown> = {}): View {
  return {
    id: "order-report",
    type: "report_view",
    table: "orders",
    report: { group_by: [{ field: "state" }], aggregates: [{ type: "count" }] },
    ...overrides,
  } as unknown as View;
}

// ---------------------------------------------------------------------------
// (a) 限定2: 書けるのは detail_view だけ
// ---------------------------------------------------------------------------

describe("(T02-a) after_delete を書けるのは detail_view だけである(ADR-0359 §4a 限定2)", () => {
  test("detail_view に書いたマニフェストが通る", () => {
    expect(
      validateManifestFull(baseManifest([listView(), detailView({ [KEY]: "order-list" })])),
    ).toEqual({ valid: true });
  });

  test("list_view / form / report_view に書くと拒否される", () => {
    expect(validateManifest(baseManifest([listView({ [KEY]: "order-list" })])).valid).toBe(false);
    expect(
      validateManifest(baseManifest([listView(), formView({ [KEY]: "order-list" })])).valid,
    ).toBe(false);
    expect(
      validateManifest(baseManifest([listView(), reportView({ [KEY]: "order-list" })])).valid,
    ).toBe(false);
  });

  test("allOf で after_delete を false に閉じている分岐は list_view / form / report_view の3つである", () => {
    const branches = viewSchema().allOf as { if: Any; then?: Any }[];
    const forbidden = branches
      .filter((branch) => (branch.then?.properties as Any)?.[KEY] === false)
      .map((branch) => ((branch.if.properties as Any).type as Any)?.const as string);
    expect(forbidden.sort()).toEqual(["form", "list_view", "report_view"]);
  });

  test("値は文字列1つであり、配列にもオブジェクトにもできない(限定3。新しい構文を1バイトも作らない)", () => {
    for (const value of [["order-list"], { view: "order-list" }, 1, true, null]) {
      expect(
        validateManifest(baseManifest([listView(), detailView({ [KEY]: value })])).valid,
        JSON.stringify(value),
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// (b) 限定4: 行き先にできるのは行を必要としない画面(list_view / report_view)だけ
// ---------------------------------------------------------------------------

describe("(T02-b) 行き先にできるのは list_view / report_view だけである(ADR-0359 §4a 限定4)", () => {
  test("list_view を指した差分は通る", () => {
    expect(
      validateManifestFull(baseManifest([listView(), detailView({ [KEY]: "order-list" })])),
    ).toEqual({ valid: true });
  });

  test("report_view を指した差分も通る", () => {
    expect(
      validateManifestFull(baseManifest([reportView(), detailView({ [KEY]: "order-report" })])),
    ).toEqual({ valid: true });
  });

  test("detail_view を指した差分は拒否される(消した行を開こうとするため)", () => {
    const result = validateManifestFull(
      baseManifest([
        listView(),
        detailView(),
        detailView({ id: "order-detail-2", [KEY]: "order-detail" }),
      ]),
    );
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result)).toContain("order-detail");
  });

  test("form を指した差分は拒否される", () => {
    const result = validateManifestFull(
      baseManifest([listView(), formView(), detailView({ [KEY]: "order-form" })]),
    );
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result)).toContain("order-form");
  });

  test("実在しないビューIDを指した差分は拒否される", () => {
    const result = validateManifestFull(baseManifest([listView(), detailView({ [KEY]: "nope" })]));
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result)).toContain("nope");
  });
});

// ---------------------------------------------------------------------------
// (c) 限定1 / 限定11: 増分はキー2本ちょうどで、語彙定数は1つも動かない
// ---------------------------------------------------------------------------

describe("(T02-c) 増分はキー1本ちょうどである(ADR-0359 §4a 限定1・限定11)", () => {
  // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。ADR = `0359` §4b。題名の数を直した】**
  // **旧名の逐語**: `$defs/view.properties は 30 / $defs は 30 / view_changes は 26 である`
  test("$defs/view.properties は 31 / $defs は 30 / view_changes は 27 である", () => {
    // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
    // **期待値を 30 → 31 へ書き換えた。****旧行の逐語**: `expect(Object.keys(viewSchema().properties as Any)).toHaveLength(30);`
    // **31本目を足したのは別の決定である**(`ADR-0359` §4b 限定1 が一続きの流れの中の段
    // `flow` を**末尾に**31キー目として足した。**`list_view` / `form` / `detail_view` の3種別で
    // 書け、集計表(`report_view`)には書けない**)。
    // **本ファイルが測っている決定の増分ではない。****検査は消していない。**
    expect(Object.keys(viewSchema().properties as Any)).toHaveLength(31);
    expect(Object.keys(defs())).toHaveLength(30);
    // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
    // **期待値を 26 → 27 へ書き換えた。****旧行の逐語**: `expect(Object.keys(viewChangesSchema().properties as Any)).toHaveLength(26);`
    // **27本目を足したのは別の決定である**(`flow` を `view_changes` の末尾に足した。
    // `ADR-0359` §Decision 2)。**本ファイルが測っている決定の増分ではない。**
    // **検査は消していない。**
    expect(Object.keys(viewChangesSchema().properties as Any)).toHaveLength(27);
  });

  // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。ADR = `0359` §4b。題名が嘘になったので直した】**
  // **旧名の逐語**: `after_delete は $defs/view.properties の末尾(30本目)である`
  // **`expect` は添字を固定しているので緑のままだった** —— **嘘になるのは題名だけである。**
  // **31キー目 `flow` が末尾に入ったので、`after_delete` はもう末尾ではない。**
  // **添字(29)は1バイトも動かしていない**(位置は今日も1つに固定される)。
  test("after_delete は $defs/view.properties の30本目である(末尾ではなくなった)", () => {
    const keys = Object.keys(viewSchema().properties as Any);
    expect(keys[29]).toBe(KEY);
    // **末尾は `flow` である**(`V10-M4-T01` が足した31キー目)。
    expect(keys[30]).toBe("flow");
  });

  // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。ADR = `0359` §Decision 2。題名を直した】**
  // **旧名の逐語**: `after_delete は view_changes.properties の末尾(26本目)である`
  test("after_delete は view_changes.properties の26本目である(末尾ではなくなった)", () => {
    const keys = Object.keys(viewChangesSchema().properties as Any);
    expect(keys[25]).toBe(KEY);
    expect(keys[26]).toBe("flow");
  });

  // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。ADR = `0359` §4b。向きを反転させた】**
  // **旧名の逐語**: `flow を1バイトも実装していない(V10-M4 の担当。ADR-0359 §4b)`
  // **旧行の逐語**: `expect(Object.keys(viewSchema().properties as Any)).not.toContain("flow");`
  // **旧行の逐語**: `expect(Object.keys(viewChangesSchema().properties as Any)).not.toContain("flow");`
  // **`V10-M4-T01` がその担当を果たしたので、`flow` は今日どちらにも実在する。**
  // **検査を消さずに向きだけ反転させた** —— **`ADR-0359` が同じ門で通した2本目が
  // 実装されたことを、ここが機械で押さえ続ける。**
  test("flow は V10-M4-T01 が実装した(ADR-0359 §4b。同じ門で通った2本目)", () => {
    expect(Object.keys(viewSchema().properties as Any)).toContain("flow");
    expect(Object.keys(viewChangesSchema().properties as Any)).toContain("flow");
  });

  test("却下・将来送りの形を1つも作っていない(条件分岐・確認の段・ボタン文言)", () => {
    const keys = Object.keys(viewSchema().properties as Any);
    for (const forbidden of [
      "after_delete_confirm",
      "after_delete_label",
      "on_delete",
      "delete_confirm",
      "delete_label",
    ]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// (d) 限定10: update_view で後から書けて、畳み込み後に値が残る
// ---------------------------------------------------------------------------

describe("(T02-d) update_view で後から書けて、値が実際に残る(ADR-0359 §4a 限定10)", () => {
  test("detail_view を対象にした update_view が通り、畳み込み後のマニフェストに値が残る", () => {
    const folded = foldOperations(baseManifest([listView(), detailView()]), [
      { op: "update_view", view: "order-detail", changes: { [KEY]: "order-list" } },
    ] as never);
    expect(folded.valid).toBe(true);
    if (!folded.valid) {
      throw new Error("fold failed");
    }
    expect((folded.manifest.app.views[1] as Any)[KEY]).toBe("order-list");
    expect(validateManifestFull(folded.manifest)).toEqual({ valid: true });
  });

  test("list_view / form / report_view を対象にした update_view はキー単位で拒否される", () => {
    for (const target of ["order-list", "order-form", "order-report"]) {
      const folded = foldOperations(
        baseManifest([listView(), formView(), reportView(), detailView()]),
        [{ op: "update_view", view: target, changes: { [KEY]: "order-list" } }] as never,
      );
      expect(folded.valid, target).toBe(false);
    }
  });

  test("update_view で detail_view を行き先に書くと、畳み込み後のマニフェスト検証が差分全体を拒否する", () => {
    const folded = foldOperations(
      baseManifest([listView(), detailView(), detailView({ id: "order-detail-2" })]),
      [{ op: "update_view", view: "order-detail", changes: { [KEY]: "order-detail-2" } }] as never,
    );
    expect(folded.valid).toBe(true);
    if (!folded.valid) {
      throw new Error("fold failed");
    }
    expect(validateManifestFull(folded.manifest).valid).toBe(false);
  });
});
