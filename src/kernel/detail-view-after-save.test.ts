/**
 * **詳細画面の書換ボタンが成立したあとの行き先**(`V10-M1-T01`。`NV-G3a` / `ADR-0358`
 * 限定1〜限定9)。
 *
 * ## これは何で、何ではないか(**先に書く。誇張しない**)
 *
 * - **解いたのは `manifest.schema.json` の `detail_view` 分岐の `"after_save": false,`
 *   1箇所だけである**(限定1)。**`list_view` / `report_view` の `false` は1バイトも
 *   解いていない**(`NV-G3b` = **却下**)。
 * - **【禁止】「一覧からも行き先が書けるようになった」と書かない**(限定9)。
 * - **【禁止】「保存後の行き先を詳細画面にも置いた」と読まない** —— **詳細画面に
 *   『保存』は無い。** **発火するのは `set` 形(値の書換)のボタンの書込が成立したとき
 *   だけであり、`run` 形(自動処理の起動)の後は1ミリも遷移しない**(限定2)。
 * - **キーを1本も足していない**(限定4)—— `$defs/view.properties` は **29**、
 *   `$defs` は **30**、`view_changes` は **25** のままである。
 *   **【2026-08-20 追記。`V10-M1-T02` / `NV-G4` / `ADR-0359`。上の1文を1バイトも
 *   書き換えていない。ただし絶対値は今日は偽である】** —— **`ADR-0359`(門A /
 *   判定 = 限定採用)が `after_delete` を足したので、今日は **30** / **30** / **26**
 *   である。** **`ADR-0358` の増分が0キーであることは今日も真である。**
 *
 * ## 表示層はここでは測っていない
 *
 * **`set` の成立で実際に画面が移ることと、`run` の後に移らないことは
 * `web/test/detail-view-after-save.test.tsx` が測る。** ここが見るのは宣言の器だけである。
 */

import { describe, expect, test } from "bun:test";
import diffSchema from "../../schemas/diff.schema.json" with { type: "json" };
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import { foldOperations } from "./apply-diff.ts";
import type { Manifest, View } from "./types.ts";
import { validateManifest, validateManifestFull } from "./validate.ts";

/** 本 ADR が解いたキー。**新しいキーを1本も足していない**(限定4)。 */
const KEY = "after_save";

type Any = Record<string, unknown>;

function defs(): Record<string, Any> {
  return (manifestSchema as unknown as { $defs: Record<string, Any> }).$defs;
}

function viewSchema(): Any {
  return defs().view as Any;
}

function baseManifest(views: View[]): Manifest {
  return {
    app: {
      id: "shop",
      name: "店",
      tables: [
        { id: "orders", name: "注文", fields: [{ id: "memo", name: "メモ", type: "text" }] },
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

function reportView(overrides: Record<string, unknown> = {}): View {
  return {
    id: "order-report",
    type: "report_view",
    table: "orders",
    report: { group_by: [{ field: "memo" }], aggregates: [{ id: "n", type: "count" }] },
    ...overrides,
  } as unknown as View;
}

// ---------------------------------------------------------------------------
// (a) 限定1: detail_view に書ける
// ---------------------------------------------------------------------------

describe("(T01-a) detail_view に after_save を書ける(ADR-0358 限定1)", () => {
  test("detail_view に書いたマニフェストが通る", () => {
    expect(
      validateManifestFull(baseManifest([listView(), detailView({ [KEY]: "order-list" })])),
    ).toEqual({
      valid: true,
    });
  });

  test("値は文字列1つであり、配列にもオブジェクトにもできない(限定3。新しい構文を1バイトも作らない)", () => {
    for (const value of [["order-list"], { view: "order-list" }, 1, true, null]) {
      expect(
        validateManifest(baseManifest([listView(), detailView({ [KEY]: value })])).valid,
        JSON.stringify(value),
      ).toBe(false);
    }
  });

  test("実在しないビューIDを指すと差分全体が拒否される(限定3の『実在する』)", () => {
    const result = validateManifestFull(baseManifest([detailView({ [KEY]: "nope" })]));
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result)).toContain("nope");
  });
});

// ---------------------------------------------------------------------------
// (b) 限定1: list_view / report_view は1バイトも解いていない
// ---------------------------------------------------------------------------

describe("(T01-b) list_view / report_view には今日どおり書けない(ADR-0358 限定1。NV-G3b = 却下)", () => {
  test("list_view に書くと拒否される", () => {
    expect(validateManifest(baseManifest([listView({ [KEY]: "order-list" })])).valid).toBe(false);
  });

  test("report_view に書くと拒否される", () => {
    expect(
      validateManifest(baseManifest([listView(), reportView({ [KEY]: "order-list" })])).valid,
    ).toBe(false);
  });

  test("allOf で after_save を false に閉じている分岐は list_view と report_view の2つだけである", () => {
    const branches = viewSchema().allOf as { if: Any; then?: Any }[];
    const forbidden = branches
      .filter((branch) => (branch.then?.properties as Any)?.[KEY] === false)
      .map((branch) => ((branch.if.properties as Any).type as Any)?.const);
    expect(forbidden.sort()).toEqual(["list_view", "report_view"]);
  });
});

// ---------------------------------------------------------------------------
// (c) 限定4: キーを1本も足していない
// ---------------------------------------------------------------------------

describe("(T01-c) キーを1本も足していない(ADR-0358 限定4)", () => {
  // **【2026-08-20。`V10-M1-T02`。台帳 `NV-G4`。ADR = `0359`。テスト名と期待値を直した】**
  // **着手前の名前と期待値は「29 / 30 / 25 のまま」であり、今日は偽である** ——
  // **`ADR-0359`(門A / 判定 = 限定採用)が `after_delete` を `$defs/view` の30キー目と
  // `view_changes` の26キー目に足した。**
  // **`ADR-0358`(本ファイルが測っている決定)の増分は今日も0キーである** ——
  // **増やしたのは別の決定である。****どの ADR の限定が何を増やしたかを混ぜない。**
  // **`$defs` の本数(30)はどちらの決定でも1つも動いていない。**
  // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。ADR = `0359` §4b。題名の数を直した】**
  // **旧名の逐語**: `ADR-0358 の増分は0キーである($defs/view.properties 30 / $defs 30 / view_changes 26 のうち、本 ADR が足したのは0本)`
  test("ADR-0358 の増分は0キーである($defs/view.properties 31 / $defs 30 / view_changes 27 のうち、本 ADR が足したのは0本)", () => {
    // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
    // **期待値を 30 → 31 へ書き換えた。****旧行の逐語**: `expect(Object.keys(viewSchema().properties as Any)).toHaveLength(30);`
    // **31本目を足したのは別の決定である**(`ADR-0359` §4b 限定1 が一続きの流れの中の段
    // `flow` を**末尾に**31キー目として足した。**`list_view` / `form` / `detail_view` の3種別で
    // 書け、集計表(`report_view`)には書けない**)。
    // **本ファイルが測っている決定の増分ではない。****検査は消していない。**
    expect(Object.keys(viewSchema().properties as Any)).toHaveLength(31);
    // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。ADR = `0359` §4b】**
    // **旧行の逐語**: `expect(Object.keys(viewSchema().properties as Any)).not.toContain("flow");`
    // **`flow` は今日 `$defs/view.properties` に実在する** —— **`V10-M4-T01` が31キー目として
    // 足した。****向きを反転させて残す**(検査を消さない)—— **測りたいのは
    // 「`ADR-0358`(本ファイルが測っている決定)が `flow` を足したのではない」ことである。**
    expect(Object.keys(viewSchema().properties as Any)).toContain("flow");
    expect(Object.keys(defs())).toHaveLength(30);
    const viewChanges = (diffSchema as unknown as { $defs: Record<string, Any> }).$defs
      .view_changes as Any;
    // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
    // **期待値を 26 → 27 へ書き換えた。****旧行の逐語**: `expect(Object.keys(viewChanges.properties as Any)).toHaveLength(26);`
    // **27本目を足したのは別の決定である**(`flow` を `view_changes` の末尾に足した。
    // `ADR-0359` §Decision 2)。**本ファイルが測っている決定の増分ではない。**
    // **検査は消していない。**
    expect(Object.keys(viewChanges.properties as Any)).toHaveLength(27);
  });

  test("ボタンごとの行き先を作っていない($defs/view_action.properties は 8 のまま。限定5)", () => {
    expect(Object.keys((defs().view_action as Any).properties as Any)).toHaveLength(8);
  });

  test("成功 / 失敗で分けるキーも確認の段のキーも1本も足していない(限定3)", () => {
    const keys = Object.keys(viewSchema().properties as Any);
    for (const forbidden of [
      "after_set",
      "after_run",
      "after_save_success",
      "after_save_failure",
      "on_success",
      "on_error",
      "confirm",
      "confirm_view",
    ]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// (d) 限定8: update_view で後から書けて、畳み込み後に値が残る
// ---------------------------------------------------------------------------

describe("(T01-d) update_view で後から書けて、値が実際に残る(ADR-0358 限定8)", () => {
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

  test("list_view を対象にした update_view は今日どおりキー単位で拒否される", () => {
    const folded = foldOperations(baseManifest([listView(), detailView()]), [
      { op: "update_view", view: "order-list", changes: { [KEY]: "order-list" } },
    ] as never);
    expect(folded.valid).toBe(false);
  });

  test("update_view で実在しないビューIDを書くと、畳み込み後のマニフェスト検証が差分全体を拒否する", () => {
    const folded = foldOperations(baseManifest([listView(), detailView()]), [
      { op: "update_view", view: "order-detail", changes: { [KEY]: "nope" } },
    ] as never);
    expect(folded.valid).toBe(true);
    if (!folded.valid) {
      throw new Error("fold failed");
    }
    expect(validateManifestFull(folded.manifest).valid).toBe(false);
  });
});
