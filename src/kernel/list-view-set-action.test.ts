/**
 * **一覧の行の set 形**(`V5-M25-T07` = `V5-M21-T02` の実装。`L-G3` / `ADR-0171` 限定10)。
 *
 * ## 何が起きたのか(**順序の拘束が解けた**)
 *
 * **`ADR-0171` 限定10 の逐語**: 「**[`ADR-0175`](../../docs/adr/0175-manual-trigger-idempotency-and-actor.md)
 * の規則が実装されるまで、一覧の set 形を実装しない(順序の拘束)**」。
 *
 * **`V5-M21` はこの拘束に従って実装せず、`schemas/manifest.schema.json` の `list_view` 分岐に
 * `actions.items.properties.set: false` を置いて機械的に閉じた**(`v5-m21.md` §「`L-G3`」)。
 * **`V5-M25-T03` が `ADR-0175` の規則(実行中の重複を 409 で拒む)を実装したので、
 * 拘束が解けた。** **本ファイルはその1箇所を外したことを固定する。**
 *
 * ## **【禁止】「二重押しが防げるようになったから解いた」と書かない**
 *
 * **`ADR-0175` が防ぐのは実行中の重複だけであり、set 形の冪等性は今日も1つも無い**
 * (`ADR-0100` §限界1 は set 形については1バイトも無効化されていない)——
 * **押した回数だけ書込が起き、`on_update` もそのたびに発火する。**
 * **拘束が求めていたのは「規則が実在すること」であって「二重押しが防げること」ではない。**
 */
import { describe, expect, test } from "bun:test";
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import type { Manifest, View } from "./types.ts";
import { validateManifest, validateManifestFull } from "./validate.ts";

type Any = Record<string, unknown>;

function defs(): Record<string, Any> {
  return (manifestSchema as unknown as { $defs: Record<string, Any> }).$defs;
}

function viewBranch(type: string): Any {
  const branches = (defs().view as Any).allOf as { if: Any; then?: Any }[];
  const found = branches.find(
    (branch) => ((branch.if.properties as Any).type as Any)?.const === type,
  );
  if (found === undefined) {
    throw new Error(`branch not found: ${type}`);
  }
  return (found.then ?? {}) as Any;
}

function baseManifest(actions?: unknown[]): Manifest {
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
            { id: "state", name: "状態", type: "select", options: ["new", "done"] },
          ],
        },
      ],
      views: [
        {
          id: "order-list",
          type: "list_view",
          table: "orders",
          columns: ["title", "state"],
          ...(actions === undefined ? {} : { actions }),
        } as unknown as View,
      ],
    },
  } as unknown as Manifest;
}

describe("V5-M25-T07: 一覧の行の set 形(ADR-0171 限定10 の順序拘束が解けた)", () => {
  test("list_view 分岐の actions から items.properties.set の false が外れている(外した先は1箇所)", () => {
    const actions = (viewBranch("list_view").properties as Any).actions as Any | undefined;
    // **`actions` そのものの `false` は `V5-M21` が既に外している。**
    expect(actions).not.toBe(false);
    const items = (actions?.items ?? {}) as Any;
    const properties = (items.properties ?? {}) as Any;
    expect(properties.set).toBeUndefined();
  });

  test("一覧に set 形を書いたマニフェストが検証を通る", () => {
    const manifest = baseManifest([{ set: { field: "state", value: "done" }, name: "完了にする" }]);
    expect(validateManifest(manifest).valid).toBe(true);
    expect(validateManifestFull(manifest)).toEqual({ valid: true });
  });

  test("set.field がその一覧の対象テーブルに無ければ適用時に倒れる(検査は詳細画面と同じ1本)", () => {
    const manifest = baseManifest([{ set: { field: "nope", value: "done" } }]);
    expect(validateManifestFull(manifest).valid).toBe(false);
  });

  test("set.value が select の選択肢に無ければ適用時に倒れる", () => {
    const manifest = baseManifest([{ set: { field: "state", value: "shipped" } }]);
    expect(validateManifestFull(manifest).valid).toBe(false);
  });

  test("入力フォームには今日も actions を1つも書けない(ADR-0171 限定3 を1バイトも解いていない)", () => {
    expect((viewBranch("form").properties as Any).actions).toBe(false);
  });

  test("related は両分岐で今日も false のままである(ADR-0171 限定4)", () => {
    expect((viewBranch("list_view").properties as Any).related).toBe(false);
    expect((viewBranch("form").properties as Any).related).toBe(false);
  });

  test("詳細画面の分岐は3形目(view)を今日も閉じている(L-G7 = 却下。1バイトも解いていない)", () => {
    const actions = (viewBranch("detail_view").properties as Any).actions as Any;
    expect(((actions.items as Any).properties as Any).view).toBe(false);
  });
});
