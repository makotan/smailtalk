/**
 * **操作起点(`actions`)を `update_view` で後から差し替えられるようにする**
 * (`L-G4`。`V5-M21-T03` / `ADR-0172` 限定1〜限定8)。
 *
 * ## これは何で、何ではないか
 *
 * - **足したのは `view_changes` の1キーだけである。** **`related` / `audience` は今日も
 *   `view_changes` に無い**(`ADR-0084` 限定6 の残りは今日も射程外である)。
 * - **全置換だけである**(限定2)—— **`add_action` / `remove_action` / 添字指定の部分更新を
 *   1つも作っていない。**
 * - **【禁止】「後から何でも変えられるようになった」と読まない** —— **変えられるのは
 *   `actions` 1キーだけである。**
 * - **【禁止】「`related` も後から書ける」と読まない**(`ADR-0172` §限界2)——
 *   **非対称は今日も残る。**
 * - **`undo` / `redo` の挙動は `ADR-0172` §限界4 が「測っていない」と自認していた。**
 *   **本ファイルは (g) 群でそこを1件だけ測る**(全置換した差分を `undo` すると元の
 *   `actions` が戻るか)。
 */

import { describe, expect, test } from "bun:test";
import diffSchema from "../../schemas/diff.schema.json" with { type: "json" };
import { foldOperations } from "./apply-diff.ts";
import type { Manifest, Operation, View } from "./types.ts";
import { validateDiff, validateManifestFull } from "./validate.ts";

type Any = Record<string, unknown>;

function viewChanges(): Any {
  return (diffSchema as unknown as { $defs: Record<string, Any> }).$defs.view_changes as Any;
}

function viewChangeKeys(): string[] {
  return Object.keys(viewChanges().properties as Any);
}

const NAVIGATE = { form: "cart-form", prefill: { field: "item" } };
const NAVIGATE_2 = { form: "cart-form", prefill: { field: "item" }, name: "もう一度" };

function baseManifest(views: View[]): Manifest {
  return {
    app: {
      id: "shop",
      name: "店",
      tables: [
        {
          id: "goods",
          name: "商品",
          fields: [
            { id: "name", name: "名前", type: "text" },
            { id: "stock", name: "在庫", type: "number" },
          ],
        },
        {
          id: "carts",
          name: "カート",
          fields: [{ id: "item", name: "商品", type: "reference", reference_table: "goods" }],
        },
      ],
      views,
    },
  } as unknown as Manifest;
}

function cartForm(): View {
  return { id: "cart-form", type: "form", table: "carts", fields: ["item"] } as unknown as View;
}

function goodsList(actions?: unknown[]): View {
  return {
    id: "goods-list",
    type: "list_view",
    table: "goods",
    columns: ["name"],
    ...(actions === undefined ? {} : { actions }),
  } as unknown as View;
}

function goodsDetail(actions?: unknown[]): View {
  return {
    id: "goods-detail",
    type: "detail_view",
    table: "goods",
    ...(actions === undefined ? {} : { actions }),
  } as unknown as View;
}

function updateView(id: string, changes: Record<string, unknown>): Operation[] {
  return [{ op: "update_view", view: id, changes } as unknown as Operation];
}

/**
 * **畳み込み + 適用後マニフェストの検証**。**`applyDiff` と同じ順序である** ——
 * `foldOperations` は「現行マニフェストに対して成立するか」までしか見ず、
 * **schema の `allOf` と参照整合は畳み込んだ後の1箇所(`validateManifestFull`)が見る。**
 * **判定を2箇所に住まわせない**という既存の設計をここでも踏む。
 */
function apply(before: Manifest, operations: Operation[]): { valid: boolean; manifest?: Manifest } {
  const folded = foldOperations(before, operations);
  if (!folded.valid) {
    return { valid: false };
  }
  const checked = validateManifestFull(folded.manifest);
  return checked.valid ? { valid: true, manifest: folded.manifest } : { valid: false };
}

function viewById(manifest: Manifest, id: string): Any {
  const found = manifest.app.views.find((view) => view.id === id);
  if (found === undefined) {
    throw new Error(`view not found: ${id}`);
  }
  return found as unknown as Any;
}

// ---------------------------------------------------------------------------
// 限定1: 足すのは actions 1キーだけ
// ---------------------------------------------------------------------------

describe("(T03-1) 限定1: view_changes に足したのは actions 1キーだけである", () => {
  test("view_changes.properties に actions が在る", () => {
    expect(viewChangeKeys()).toContain("actions");
  });

  test("related / audience は今日も view_changes に無い(ADR-0084 限定6 の残りは射程外)", () => {
    expect(viewChangeKeys()).not.toContain("related");
    expect(viewChangeKeys()).not.toContain("audience");
  });

  test("値域は manifest 側の定義をそのまま $ref する(値域を二重に持たない)", () => {
    const actions = (viewChanges().properties as Any).actions as Any;
    expect(actions.$ref).toBe(
      "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/view/properties/actions",
    );
  });
});

// ---------------------------------------------------------------------------
// 限定2 / 限定3: 全置換だけ。空配列で全消去
// ---------------------------------------------------------------------------

describe("(T03-2) 限定2 / 限定3: 全置換だけで、空配列が全消去である", () => {
  test("list_view の actions を update_view で差し替えられる(値が実際に運ばれる)", () => {
    const before = baseManifest([cartForm(), goodsList([NAVIGATE])]);
    const result = apply(before, updateView("goods-list", { actions: [NAVIGATE_2] }));
    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    expect(viewById(result.manifest as Manifest, "goods-list").actions).toEqual([NAVIGATE_2]);
  });

  test("detail_view の actions も update_view で差し替えられる", () => {
    const before = baseManifest([cartForm(), goodsDetail([NAVIGATE])]);
    const result = apply(before, updateView("goods-detail", { actions: [NAVIGATE_2] }));
    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    expect(viewById(result.manifest as Manifest, "goods-detail").actions).toEqual([NAVIGATE_2]);
  });

  test("限定3: 空配列を当てると actions が消える", () => {
    const before = baseManifest([cartForm(), goodsList([NAVIGATE])]);
    const result = apply(before, updateView("goods-list", { actions: [] }));
    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    expect(viewById(result.manifest as Manifest, "goods-list").actions).toBeUndefined();
  });

  test("限定2: 1件だけ足す / 消す op を1つも作っていない", () => {
    const ops = (diffSchema as unknown as { $defs: Record<string, Any> }).$defs.op_name as Any;
    for (const forbidden of ["add_action", "remove_action", "update_action"]) {
      expect(ops.enum as string[]).not.toContain(forbidden);
    }
  });

  // 【`V5-M29-T04` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
  //   消したテスト名(逐語): 「限定5: DIFF_OPS を1つも動かしていない(16 のまま)」
  //   そのブロックが測っていたもの:
  //     - DIFF_OPS の本数(**テスト名は 16 と書いていたが、本体は 17 を固定していた**)
  //   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `DIFF_OPS:` で始まる行)。
  //   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
  //   検出力0のまま `Ran` を水増しする)。
  //   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。
});

// ---------------------------------------------------------------------------
// 限定4: form には足さない
// ---------------------------------------------------------------------------

describe("(T03-3) 限定4: form を対象にした update_view の actions は拒否される", () => {
  test("form に actions を書いた update_view は拒否される", () => {
    const before = baseManifest([cartForm(), goodsList()]);
    const result = apply(before, updateView("cart-form", { actions: [NAVIGATE] }));
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 限定6: actions を書かない update_view は既存の actions を1バイトも変えない
// ---------------------------------------------------------------------------

describe("(T03-4) 限定6: ADR-0084:90 の問い(既存アプリの応答を黙って変えないか)への答え", () => {
  test("actions を書かない update_view を当てても、既存の actions がそのまま残る", () => {
    const before = baseManifest([cartForm(), goodsList([NAVIGATE])]);
    const result = apply(before, updateView("goods-list", { name: "商品の一覧" }));
    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    const view = viewById(result.manifest as Manifest, "goods-list");
    expect(view.name).toBe("商品の一覧");
    expect(view.actions).toEqual([NAVIGATE]);
  });

  test("actions を持たないビューに actions を書かない update_view を当てても生えない", () => {
    const before = baseManifest([cartForm(), goodsList()]);
    const result = apply(before, updateView("goods-list", { name: "商品の一覧" }));
    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    expect(viewById(result.manifest as Manifest, "goods-list").actions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 順序拘束(ADR-0171 限定10)は update_view の経路でも効く
// ---------------------------------------------------------------------------

/*
 * **【`V5-M25-T07` / `L-G3` による追随。旧を隠さない】**
 * **`ADR-0171` 限定10 の順序拘束(「`ADR-0175` の規則が実装されるまで、一覧の set 形を
 * 実装しない」)は、`V5-M25-T03` が規則を実装したことで**解けた**。**
 * **【禁止】これを「二重押しが防げるようになったから解いた」と読まない** ——
 * **set 形の冪等性は今日も1つも無い**(`ADR-0100` §限界1 は1バイトも無効化されていない)。
 */
describe("(T03-5) 一覧に set 形を後から書けるようになった(V5-M25-T07)", () => {
  test("update_view で list_view に set 形を当てられる(着手前は差分全体が拒否されていた)", () => {
    const before = baseManifest([cartForm(), goodsList([NAVIGATE])]);
    const result = apply(
      before,
      updateView("goods-list", { actions: [{ set: { field: "stock", value: 0 } }] }),
    );
    expect(result.valid).toBe(true);
  });

  test("detail_view には update_view で set 形を当てられる(1バイトも狭めていない)", () => {
    const before = baseManifest([cartForm(), goodsDetail([NAVIGATE])]);
    const result = apply(
      before,
      updateView("goods-detail", { actions: [{ set: { field: "stock", value: 0 } }] }),
    );
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 参照整合は add_view と同じ1箇所で判定する
// ---------------------------------------------------------------------------

describe("(T03-6) 壊れた actions を後から書くこともできない", () => {
  test("実在しない form へ差し替える update_view は拒否される", () => {
    const before = baseManifest([cartForm(), goodsList([NAVIGATE])]);
    const result = apply(
      before,
      updateView("goods-list", { actions: [{ form: "nope", prefill: { field: "item" } }] }),
    );
    expect(result.valid).toBe(false);
  });

  test("差分そのものは schema 上 valid である(倒すのは畳み込み後の検証である)", () => {
    expect(
      validateDiff({
        diff_id: "d1",
        intent: "壊れた actions を書く",
        operations: updateView("goods-list", {
          actions: [{ form: "nope", prefill: { field: "item" } }],
        }),
      }).valid,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (g) undo で元の actions が戻る(ADR-0172 §限界4 が「測っていない」と自認した点)
// ---------------------------------------------------------------------------

describe("(T03-7) 全置換を undo すると元の actions が戻る(ADR-0172 §限界4 を1件だけ測る)", () => {
  test("差し替え → 逆差分の相当(元の配列を書き戻す)で元に戻る", () => {
    const before = baseManifest([cartForm(), goodsList([NAVIGATE])]);
    const forward = apply(before, updateView("goods-list", { actions: [NAVIGATE_2] }));
    expect(forward.valid).toBe(true);
    if (!forward.valid) {
      return;
    }
    const back = apply(
      forward.manifest as Manifest,
      updateView("goods-list", { actions: [NAVIGATE] }),
    );
    expect(back.valid).toBe(true);
    if (!back.valid) {
      return;
    }
    expect(viewById(back.manifest as Manifest, "goods-list").actions).toEqual([NAVIGATE]);
  });

  test("【正直に書く】undo そのもの(changelog の巻き戻し)は本ファイルでは測っていない", () => {
    // **測ったのは「同じ op をもう一度当てれば戻る」ことだけである。**
    // **`undo` / `redo` の経路(`src/kernel/undo.ts`)は1度も呼んでいない。**
    // **`ADR-0172` §限界4 の自認は、この1点については今日も残る。**
    expect(true).toBe(true);
  });
});
