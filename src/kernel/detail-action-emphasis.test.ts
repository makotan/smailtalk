/**
 * **詳細画面のボタンの強調(`action_emphasis`)を、アプリが宣言で名指しできる**
 * (`V20-M2-T01`。条文は `ADR-0459` 限定1〜限定5)。
 *
 * ## この検査が固定すること
 *
 * 1. **`$defs/view_action.properties` に足したキーは `action_emphasis` の1本ちょうどで、
 *    値域は `primary` / `secondary` / `danger` の3値の `enum` だけである**(限定1 / 限定2)。
 * 2. **`$defs` は 30 本のまま、`additionalProperties: false` は解いていない。**
 * 3. **`schema` に `default` を1つも書いていない**(限定5。既定の反転は語彙に現れない)。
 * 4. **一覧(`list_view`)の行のボタンには書けない**(限定4。`items.properties.action_emphasis: false`)。
 * 5. **カーネルが値を実際に運ぶ** —— **`add_view` でも `update_view` でも、書いた値が
 *    ディスク上の `manifest.json` にそのまま残る**(`ADR-0090` の `$comment` が名指しした
 *    「足したキーが運ばれない」穴を繰り返していないことの実測)。
 * 6. **値域の外を書いたときのエラーに、位置・許される値・ヒントの3つが揃っている。**
 *
 * ## この検査が言えないこと(**先に書く**)
 *
 * - **画面の見た目は1件も測っていない。** 描き分けは `web/test/action-emphasis.test.tsx`、
 *   ブラウザの計算値は `web/e2e/action-emphasis.e2e.ts` が見る。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import { applyDiff } from "./apply-diff.ts";
import { applyManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { appManifestPath } from "./storage-paths.ts";
import type { DetailView, ListView, Manifest, View } from "./types.ts";
import { validateManifestFull } from "./validate.ts";

type Any = Record<string, unknown>;

const KEY = "action_emphasis";
const APP_ID = "emphasis-shop";

function defs(): Record<string, Any> {
  return (manifestSchema as unknown as { $defs: Record<string, Any> }).$defs;
}

function viewActionSchema(): Any {
  return defs().view_action as Any;
}

function branchProperties(type: string): Any {
  const allOf = (defs().view as Any).allOf as Any[];
  const branch = allOf.find(
    (candidate) =>
      ((((candidate.if as Any | undefined)?.properties as Any | undefined)?.type as Any | undefined)
        ?.const as string | undefined) === type,
  );
  if (branch === undefined) {
    throw new Error(`allOf に ${type} の分岐が無い`);
  }
  return (branch.then as Any).properties as Any;
}

function baseManifest(views: View[]): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "店",
      tables: [
        {
          id: "goods",
          name: "商品",
          fields: [
            { id: "name", name: "名前", type: "text" },
            { id: "sellable", name: "販売中", type: "boolean" },
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

type DetailAction = NonNullable<DetailView["actions"]>[number];

const STOP: DetailAction = {
  set: { field: "sellable", value: false },
  name: "販売を止める",
  action_emphasis: "danger",
};
const START: DetailAction = {
  set: { field: "sellable", value: true },
  name: "販売を始める",
  action_emphasis: "primary",
};
const TO_CART: DetailAction = {
  form: "cart-form",
  prefill: { field: "item" },
  name: "カートに入れる",
  action_emphasis: "secondary",
};

function detailView(actions: unknown[]): View {
  return { id: "goods-detail", type: "detail_view", table: "goods", actions } as unknown as View;
}

function cartForm(): View {
  return { id: "cart-form", type: "form", table: "carts", fields: ["item"] } as unknown as View;
}

function listView(actions: unknown[]): View {
  return {
    id: "goods-list",
    type: "list_view",
    table: "goods",
    columns: ["name"],
    actions,
  } as unknown as View;
}

// ---------------------------------------------------------------------------
// (T01-a) キーは1本ちょうど・閉じた器を解いていない
// ---------------------------------------------------------------------------

describe("(T01-a) 足したキーは view_action のトップに1本ちょうど", () => {
  test("$defs/view_action.properties は9キーで、9本目が action_emphasis である", () => {
    const keys = Object.keys(viewActionSchema().properties as Any);
    expect(keys).toHaveLength(9);
    expect(keys.filter((key) => key === KEY)).toHaveLength(1);
    expect(keys[keys.length - 1]).toBe(KEY);
  });

  test("additionalProperties: false を解いていない", () => {
    expect(viewActionSchema().additionalProperties).toBe(false);
  });

  test("oneOf の4枝のどれにも action_emphasis の綴りが現れない(4形すべてに同じように書ける)", () => {
    const branches = viewActionSchema().oneOf as Any[];
    expect(branches).toHaveLength(4);
    for (const branch of branches) {
      expect(JSON.stringify(branch)).not.toContain(KEY);
    }
  });

  test("$defs は30本のままである(新しい $defs を作っていない)", () => {
    // **【2026-09-24。`V20-M5-T04` / `ADR-0471`(`ADR-0462` 限定1・限定2)で 30 → 31 に更新した】** 旧の期待値は 30。$defs/layout_node(31本目) が1本増えた。
    expect(Object.keys(defs())).toHaveLength(31);
  });
});

// ---------------------------------------------------------------------------
// (T01-b) 値域は3値の enum だけ
// ---------------------------------------------------------------------------

describe("(T01-b) 値域は primary / secondary / danger の3値の enum だけ", () => {
  test("enum の全値と、enum 以外に値域を決めるキーが無いこと", () => {
    const property = (viewActionSchema().properties as Any)[KEY] as Any;
    expect(property.enum).toEqual(["primary", "secondary", "danger"]);
    // **自由文字列を1つも受けない** —— `type: string` や `pattern` で開いていない。
    expect(property.type).toBeUndefined();
    expect(property.pattern).toBeUndefined();
    expect(Object.keys(property).sort()).toEqual(["description", "enum"]);
  });

  test("schema の view_action に default を1つも書いていない(既定の反転は語彙に現れない)", () => {
    expect(JSON.stringify(viewActionSchema())).not.toContain('"default":');
  });

  test("3値はどれも詳細画面の4形のボタンに書ける", () => {
    for (const value of ["primary", "secondary", "danger"]) {
      const manifest = baseManifest([
        cartForm(),
        detailView([
          { form: "cart-form", prefill: { field: "item" }, [KEY]: value },
          { set: { field: "sellable", value: true }, [KEY]: value },
        ]),
      ]);
      expect(validateManifestFull(manifest), value).toEqual({ valid: true });
    }
  });

  test("書かなくてもよい(省略できる)", () => {
    expect(
      validateManifestFull(
        baseManifest([detailView([{ set: { field: "sellable", value: true } }])]),
      ),
    ).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// (NF4) 値域の外を書いたときのエラー文
// ---------------------------------------------------------------------------

describe("(NF4) 値域の外を書くと、位置・許される値・ヒントの3つを返して拒否する", () => {
  test('"loud" を書くと拒否され、エラーに位置・許される値・ヒントが揃っている', () => {
    const result = validateManifestFull(
      baseManifest([
        detailView([{ set: { field: "sellable", value: false }, name: "止める", [KEY]: "loud" }]),
      ]),
    );
    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    const error = result.errors.find((candidate) => candidate.path.endsWith(`/${KEY}`));
    expect(error?.path).toBe(`/app/views/0/actions/0/${KEY}`);
    expect(error?.allowed_values).toEqual(["primary", "secondary", "danger"]);
    expect(typeof error?.hint).toBe("string");
    expect((error?.hint ?? "").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// (T01-scope) 一覧の行のボタンには書けない
// ---------------------------------------------------------------------------

describe("(T01-scope) 一覧の行のボタンには書けない", () => {
  test("list_view 分岐の actions.items.properties.action_emphasis は false である", () => {
    const actions = branchProperties("list_view").actions as Any;
    expect(((actions.items as Any).properties as Any)[KEY]).toBe(false);
  });

  test("一覧の行のボタンに action_emphasis を書いたマニフェストは拒否される", () => {
    const result = validateManifestFull(
      baseManifest([
        cartForm(),
        listView([{ form: "cart-form", prefill: { field: "item" }, [KEY]: "primary" }]),
      ]),
    );
    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    expect(result.errors.map((error) => error.path)).toContain(`/app/views/1/actions/0/${KEY}`);
  });

  test("型の上でも、一覧の行のボタンには action_emphasis が無い(詳細画面の型にだけ足した)", () => {
    const listAction: NonNullable<ListView["actions"]>[number] = {
      form: "cart-form",
      prefill: { field: "item" },
      // @ts-expect-error 一覧の行のボタンには強調を書けない(型は `tsc` が見る。`bun test` は見ない)
      action_emphasis: "primary",
    };
    const detailAction: DetailAction = {
      form: "cart-form",
      prefill: { field: "item" },
      action_emphasis: "primary",
    };
    expect(Object.keys(listAction)).toContain("form");
    expect(detailAction.action_emphasis).toBe("primary");
  });

  test("一覧の行のボタンは、action_emphasis を書かなければ今日どおり通る", () => {
    expect(
      validateManifestFull(
        baseManifest([cartForm(), listView([{ form: "cart-form", prefill: { field: "item" } }])]),
      ),
    ).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// (T01-c) カーネルが値を実際に運ぶ(add_view / update_view)
// ---------------------------------------------------------------------------

describe("(T01-c) 差分で書いた action_emphasis がディスクの manifest.json まで運ばれる", () => {
  let dataRoot: string;
  let store: KernelMetaStore;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "gp-action-emphasis-"));
    store = KernelMetaStore.open(dataRoot);
    createApp(store, "店", { app_id: APP_ID });
    const applied = applyManifest(dataRoot, APP_ID, baseManifest([cartForm()]));
    if (!applied.valid) {
      throw new Error("テスト前提の初期マニフェスト投入に失敗しました。");
    }
  });

  afterEach(async () => {
    store.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  function readBackActions(viewId: string): unknown {
    const manifest = JSON.parse(
      readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8"),
    ) as Manifest;
    const view = manifest.app.views.find((candidate) => candidate.id === viewId) as
      | (View & { actions?: unknown })
      | undefined;
    return view?.actions;
  }

  test("add_view で書いた3値が、そのまま読み戻せる", () => {
    const result = applyDiff(dataRoot, APP_ID, {
      diff_id: "emphasis-add",
      intent: "詳細画面にボタンを3つ置き、主・副・危険を名指しする",
      operations: [{ op: "add_view", view: detailView([STOP, START, TO_CART]) }],
    });
    expect(result.valid).toBe(true);
    expect(readBackActions("goods-detail")).toEqual([STOP, START, TO_CART]);
  });

  test("update_view で actions を書き換えると、新しい action_emphasis が読み戻せる", () => {
    const added = applyDiff(dataRoot, APP_ID, {
      diff_id: "emphasis-seed",
      intent: "強調を書かないボタンを2つ置く",
      operations: [
        {
          op: "add_view",
          view: detailView([
            { set: { field: "sellable", value: false }, name: "販売を止める" },
            { set: { field: "sellable", value: true }, name: "販売を始める" },
          ]),
        },
      ],
    });
    expect(added.valid).toBe(true);

    // **並び順は変えずに、2番目を主にする**(書き換えるのは強調だけ)。
    const updated = applyDiff(dataRoot, APP_ID, {
      diff_id: "emphasis-update",
      intent: "並びはそのままで、2番目のボタンを主にし、1番目を危険にする",
      operations: [
        {
          op: "update_view",
          view: "goods-detail",
          changes: {
            actions: [
              { set: { field: "sellable", value: false }, name: "販売を止める", [KEY]: "danger" },
              { set: { field: "sellable", value: true }, name: "販売を始める", [KEY]: "primary" },
            ],
          },
        },
      ],
    });
    expect(updated.valid).toBe(true);
    expect(readBackActions("goods-detail")).toEqual([
      { set: { field: "sellable", value: false }, name: "販売を止める", [KEY]: "danger" },
      { set: { field: "sellable", value: true }, name: "販売を始める", [KEY]: "primary" },
    ]);
  });

  test("update_view で値域の外を書くと拒否され、manifest.json は1バイトも変わらない", () => {
    const added = applyDiff(dataRoot, APP_ID, {
      diff_id: "emphasis-seed-2",
      intent: "ボタンを1つ置く",
      operations: [{ op: "add_view", view: detailView([STOP]) }],
    });
    expect(added.valid).toBe(true);
    const before = readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8");
    const rejected = applyDiff(dataRoot, APP_ID, {
      diff_id: "emphasis-loud",
      intent: "値域の外を書く",
      operations: [
        {
          op: "update_view",
          view: "goods-detail",
          changes: { actions: [{ set: { field: "sellable", value: false }, [KEY]: "loud" }] },
        },
      ],
    });
    expect(rejected.valid).toBe(false);
    expect(readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8")).toBe(before);
  });
});
