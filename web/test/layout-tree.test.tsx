/**
 * **並べ方の木(`layout`)の描画**(`V20-M5-T03`。条文 = `ADR-0462` / `ADR-0471`、メインの裁定
 * (置き場 (B)・申6・申7)、置き場の判定 = `docs/plan/v20/records/v20-m5-t02.md`)。
 *
 * ## 決めたこと(名指し)
 *
 * - **6種の並べ方は `web/src/views/LayoutTree.tsx` の1部品が描く。** 値 → クラスの対応表は
 *   同ファイルに閉じ、**対応表のキーは語彙の値域と完全一致する**(下の (e)。申6)。
 * - **葉は今日と同じ部品で1つずつ描く**(入力フォームの項目の枠 `div.field`、詳細画面の項目、
 *   一覧のカードの項目、宣言ボタン)。**名指しされたボタンは葉の位置に描き、元の場所には描かない**
 *   (申7)。名指しされなかったボタンは今日の場所のまま。
 * - **木に置かなかった表示項目は、木の後ろに今日の既定の並びで縦に積む**(`ADR-0471` §Decision 3
 *   の「拒否しないもの」)。
 * - **詳細画面の項目の器は、木を書いた画面だけ `dl` から `div` にする**(申7)。1項目は
 *   `dl.detail-field`(中に `dt` / `dd`)で描く —— `div` の中に `dt` / `dd` を直に置かないため。
 *
 * ## 着手前の DOM(`__fixtures__/layout-undeclared-before.dom.txt`)
 *
 * **木を書いていない4画面(入力フォーム / 詳細画面 / 一覧の表 / 一覧のカード)の DOM**(1行1画面)。
 * **撮ったのは実装を1バイトも入れる前で、`web/src/` は土台 `b769c4cb` と差分0行だった**
 * (`git diff b769c4cb --quiet -- web/src` が真。作業台の HEAD は `f0387a7b`)。題材は
 * `layout-tree-fixture.tsx`。**同じ手順で2回撮って1バイト同じだった**(揺れが無い)。
 * 拡張子を `.html` にしていないのは、整形器(biome)が HTML として読むのを避けるためである
 * (`V20-M3` / `V20-M4` の先例と同じ)。
 *
 * ## このファイルが証明しないこと
 *
 * - **幅で組み替わること**は見ない(happy-dom は CSS を計算しない)。それは
 *   `web/e2e/layout-tree.e2e.ts` がブラウザの計算値で見る。
 * - **適用時の拒否**(葉の実在・重複・深さ・一覧が表の形)は見ない。それは
 *   `src/kernel/layout-tree.test.ts` が見る。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  LAYOUT_DEFAULTS,
  LAYOUT_GAP_CLASS,
  LAYOUT_JUSTIFY_CLASS,
  LAYOUT_MIN_ITEM_CLASS,
  LAYOUT_SIDE_POSITION_ORDER,
  LAYOUT_SIDE_WIDTH_CLASS,
  LAYOUT_SIDEBAR_MAIN_CLASS,
  LAYOUT_SPLIT_END_CLASS,
  LAYOUT_THRESHOLD_CLASS,
  LAYOUT_TYPE_CLASS,
  type LayoutNode,
  LayoutTree,
  layoutLeaves,
} from "../src/views/LayoutTree.tsx";
import {
  installLayoutFetch,
  layoutManifest,
  renderLayoutDetail,
  renderLayoutForm,
  renderLayoutList,
  restoreLayoutFetch,
  TO_TARGET,
} from "./layout-tree-fixture.tsx";

const ROOT = dirname(dirname(import.meta.dir));
const BEFORE = readFileSync(
  join(import.meta.dir, "__fixtures__", "layout-undeclared-before.dom.txt"),
  "utf8",
)
  .trimEnd()
  .split("\n");

beforeEach(installLayoutFetch);
afterEach(() => {
  cleanup();
  restoreLayoutFetch();
});

/** 文書順で `a` が `b` より前か。 */
function precedes(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

function only(root: ParentNode, selector: string): HTMLElement {
  const found = root.querySelectorAll<HTMLElement>(selector);
  if (found.length !== 1) {
    throw new Error(`${selector} が ${found.length} 個ある(1個のはず)`);
  }
  return found[0] as HTMLElement;
}

// ---------------------------------------------------------------------------
// (d) 木を書いていない画面は着手前と完全一致する(完了条件11)
// ---------------------------------------------------------------------------

test("T03 (d) layout を書いていない4画面(入力フォーム / 詳細画面 / 一覧の表 / 一覧のカード)の DOM が着手前と完全一致する", async () => {
  expect(BEFORE).toHaveLength(4);
  const drawn = [
    (await renderLayoutForm(layoutManifest("form"))).outerHTML,
    await (async () => {
      cleanup();
      return (await renderLayoutDetail(layoutManifest("detail"))).outerHTML;
    })(),
    await (async () => {
      cleanup();
      return (await renderLayoutList(layoutManifest("list"))).outerHTML;
    })(),
    await (async () => {
      cleanup();
      return (await renderLayoutList(layoutManifest("list", { preset_list_shape: "card" })))
        .outerHTML;
    })(),
  ];
  for (const [index, html] of drawn.entries()) {
    expect(html, String(index)).toBe(BEFORE[index] as string);
  }
});

// ---------------------------------------------------------------------------
// (e) 対応表のキーは語彙の値域と完全一致する(申6)
// ---------------------------------------------------------------------------

type Branch = { properties: Record<string, { const?: string; enum?: string[] }> };

function layoutBranches(): Branch[] {
  const schema = JSON.parse(
    readFileSync(join(ROOT, "schemas", "manifest.schema.json"), "utf8"),
  ) as { $defs: Record<string, { oneOf?: Branch[] }> };
  const branches = schema.$defs.layout_node?.oneOf;
  if (branches === undefined) {
    throw new Error("$defs/layout_node の oneOf が無い");
  }
  return branches;
}

/** 値域(`enum`)を持つパラメータ名 → 値の一覧。**同じ名前の値域は全枝で同じであることも見る。** */
function paramDomains(): Map<string, string[]> {
  const domains = new Map<string, string[]>();
  for (const branch of layoutBranches()) {
    for (const [name, prop] of Object.entries(branch.properties)) {
      if (prop.enum === undefined) {
        continue;
      }
      const seen = domains.get(name);
      if (seen !== undefined) {
        expect(prop.enum, name).toEqual(seen);
      }
      domains.set(name, prop.enum);
    }
  }
  return domains;
}

const sorted = (values: Iterable<string>): string[] => [...values].sort();

test("T03 (e) 対応表のキーが $defs/layout_node の値域と完全一致する(型6種と、値域を持つパラメータ6つ)", () => {
  const types = layoutBranches().map((branch) => branch.properties.type?.const as string);
  expect(sorted(Object.keys(LAYOUT_TYPE_CLASS))).toEqual(sorted(types));
  expect(types).toHaveLength(6);

  const tables: Record<string, Readonly<Record<string, unknown>>> = {
    gap: LAYOUT_GAP_CLASS,
    justify: LAYOUT_JUSTIFY_CLASS,
    side_width: LAYOUT_SIDE_WIDTH_CLASS,
    side_position: LAYOUT_SIDE_POSITION_ORDER,
    threshold: LAYOUT_THRESHOLD_CLASS,
    min_item: LAYOUT_MIN_ITEM_CLASS,
  };
  const domains = paramDomains();
  // 値域を持つパラメータの**名前の集合**も一致する(語彙にパラメータを足すと、対応表を
  // 足さない限りここが赤くなる)。
  expect(sorted(domains.keys())).toEqual(sorted(Object.keys(tables)));
  for (const [name, domain] of domains) {
    expect(sorted(Object.keys(tables[name] as object)), name).toEqual(sorted(domain));
  }
  // 省略時の値も同じ6つの名前を持ち、値域の中の名前である。
  expect(sorted(Object.keys(LAYOUT_DEFAULTS))).toEqual(sorted(domains.keys()));
  for (const [name, value] of Object.entries(LAYOUT_DEFAULTS)) {
    expect(domains.get(name), name).toContain(value);
  }
});

test("T03 (e) 対応表の値は値ごとに別の当たり先を持つ(同じクラスに畳まれた値が1つも無い)", () => {
  for (const table of [
    LAYOUT_TYPE_CLASS,
    LAYOUT_GAP_CLASS,
    LAYOUT_JUSTIFY_CLASS,
    LAYOUT_SIDE_WIDTH_CLASS,
    LAYOUT_SIDE_POSITION_ORDER,
    LAYOUT_THRESHOLD_CLASS,
    LAYOUT_MIN_ITEM_CLASS,
  ]) {
    const values = Object.values(table);
    expect(new Set(values).size).toBe(values.length);
  }
});

test("T07 軽3 対応表の値(25項目)と子の器のクラス2本が逐語で一致する(長さの値 10/15/20rem・20/30/45rem・60% を固定する)", () => {
  // **キーの一致((e))と禁止トークンの走査では、長さの値そのものが動いても赤くならない**
  // (`V20-M5-T07` の壊す点検 B17)。値を変えるなら、この表を同じ差分で書き換えること。
  expect({
    type: LAYOUT_TYPE_CLASS,
    gap: LAYOUT_GAP_CLASS,
    justify: LAYOUT_JUSTIFY_CLASS,
    side_width: LAYOUT_SIDE_WIDTH_CLASS,
    side_position: LAYOUT_SIDE_POSITION_ORDER,
    threshold: LAYOUT_THRESHOLD_CLASS,
    min_item: LAYOUT_MIN_ITEM_CLASS,
    sidebar_main: LAYOUT_SIDEBAR_MAIN_CLASS,
    split_end: LAYOUT_SPLIT_END_CLASS,
  }).toEqual({
    type: {
      stack: "flex flex-col",
      cluster: "flex flex-wrap items-center",
      sidebar: "flex flex-wrap items-start gap-s3",
      switcher: "flex flex-wrap",
      grid: "grid",
      split: "flex flex-wrap items-center justify-between gap-s3",
    },
    gap: { xs: "gap-s1", sm: "gap-s2", md: "gap-s3", lg: "gap-s4", xl: "gap-s6" },
    justify: { start: "justify-start", end: "justify-end", between: "justify-between" },
    side_width: { sm: "flex-[1_1_10rem]", md: "flex-[1_1_15rem]", lg: "flex-[1_1_20rem]" },
    side_position: { start: "side-first", end: "main-first" },
    threshold: {
      sm: "grow basis-[calc((20rem_-_100%)_*_999)]",
      md: "grow basis-[calc((30rem_-_100%)_*_999)]",
      lg: "grow basis-[calc((45rem_-_100%)_*_999)]",
    },
    min_item: {
      sm: "grid-cols-[repeat(auto-fit,minmax(min(10rem,100%),1fr))]",
      md: "grid-cols-[repeat(auto-fit,minmax(min(15rem,100%),1fr))]",
      lg: "grid-cols-[repeat(auto-fit,minmax(min(20rem,100%),1fr))]",
    },
    sidebar_main: "flex-[999_1_60%] min-w-0",
    split_end: "flex flex-wrap items-center gap-s2",
  });
  const valueCount = [
    LAYOUT_TYPE_CLASS,
    LAYOUT_GAP_CLASS,
    LAYOUT_JUSTIFY_CLASS,
    LAYOUT_SIDE_WIDTH_CLASS,
    LAYOUT_SIDE_POSITION_ORDER,
    LAYOUT_THRESHOLD_CLASS,
    LAYOUT_MIN_ITEM_CLASS,
  ].reduce((sum, table) => sum + Object.keys(table).length, 0);
  expect(valueCount).toBe(25);
});

// ---------------------------------------------------------------------------
// (a) 6種を1つずつ撃つ(部品そのもの)
// ---------------------------------------------------------------------------

function drawTree(node: LayoutNode): HTMLElement {
  const { container } = render(
    <LayoutTree node={node} renderLeaf={(leaf) => <span data-leaf={leaf}>{leaf}</span>} />,
  );
  return container.firstElementChild as HTMLElement;
}

const leavesIn = (root: Element): string[] =>
  [...root.querySelectorAll("[data-leaf]")].map((node) => node.getAttribute("data-leaf") ?? "");

test("T03 (a) stack: 縦に積む器に間隔のクラスが当たり、葉が書いた順に並ぶ", () => {
  const root = drawTree({ type: "stack", gap: "lg", children: ["a", "b", "c"] });
  expect(root.getAttribute("data-layout")).toBe("stack");
  expect(root.className).toBe("flex flex-col gap-s4");
  expect(leavesIn(root)).toEqual(["a", "b", "c"]);
  expect([...root.children].map((child) => child.getAttribute("data-leaf"))).toEqual([
    "a",
    "b",
    "c",
  ]);
});

test("T03 (a) cluster: 折り返す横並びに間隔と寄せ方のクラスが当たる", () => {
  const root = drawTree({ type: "cluster", gap: "xs", justify: "between", children: ["a", "b"] });
  expect(root.getAttribute("data-layout")).toBe("cluster");
  expect(root.className).toBe("flex flex-wrap items-center gap-s1 justify-between");
  expect(leavesIn(root)).toEqual(["a", "b"]);
});

test("T03 (a) sidebar: 脇と本文の器が出て、脇に幅のクラスが当たる。side_position=end は文書順で本文が先になる", () => {
  const start = drawTree({ type: "sidebar", side: "s", main: "m", side_width: "lg" });
  expect(start.getAttribute("data-layout")).toBe("sidebar");
  expect(start.className).toBe("flex flex-wrap items-start gap-s3");
  const slots = [...start.children].map((child) => child.getAttribute("data-layout-slot"));
  expect(slots).toEqual(["side", "main"]);
  expect((start.children[0] as HTMLElement).className).toBe("flex-[1_1_20rem]");
  expect((start.children[1] as HTMLElement).className).toBe("flex-[999_1_60%] min-w-0");
  expect(leavesIn(start.children[0] as Element)).toEqual(["s"]);
  expect(leavesIn(start.children[1] as Element)).toEqual(["m"]);
  cleanup();

  const end = drawTree({ type: "sidebar", side: "s", main: "m", side_position: "end" });
  expect([...end.children].map((child) => child.getAttribute("data-layout-slot"))).toEqual([
    "main",
    "side",
  ]);
  expect((end.children[1] as HTMLElement).className).toBe("flex-[1_1_15rem]");
});

test("T03 (a) switcher: 子ごとに切り替え幅の基準のクラスが当たる", () => {
  const root = drawTree({ type: "switcher", threshold: "sm", gap: "sm", children: ["a", "b"] });
  expect(root.getAttribute("data-layout")).toBe("switcher");
  expect(root.className).toBe("flex flex-wrap gap-s2");
  const items = [...root.children] as HTMLElement[];
  expect(items).toHaveLength(2);
  for (const item of items) {
    expect(item.getAttribute("data-layout-slot")).toBe("item");
    expect(item.className).toBe("grow basis-[calc((20rem_-_100%)_*_999)]");
  }
  expect(leavesIn(root)).toEqual(["a", "b"]);
});

test("T03 (a) grid: 器に auto-fit の列と間隔のクラスが当たる", () => {
  const root = drawTree({ type: "grid", min_item: "lg", gap: "xl", children: ["a", "b", "c"] });
  expect(root.getAttribute("data-layout")).toBe("grid");
  expect(root.className).toBe(
    "grid gap-s6 grid-cols-[repeat(auto-fit,minmax(min(20rem,100%),1fr))]",
  );
  expect(leavesIn(root)).toEqual(["a", "b", "c"]);
});

test("T03 (a) split: 始端と終端の器が出て、葉がそれぞれに入る(始端が空でも器は出る)", () => {
  const root = drawTree({ type: "split", start: [], end: ["x", "y"] });
  expect(root.getAttribute("data-layout")).toBe("split");
  expect(root.className).toBe("flex flex-wrap items-center justify-between gap-s3");
  const [start, end] = [...root.children] as HTMLElement[];
  expect(start?.getAttribute("data-layout-slot")).toBe("start");
  expect(end?.getAttribute("data-layout-slot")).toBe("end");
  expect(leavesIn(start as Element)).toEqual([]);
  expect(leavesIn(end as Element)).toEqual(["x", "y"]);
});

test("T03 (a) 入れ子(3段)と、パラメータを省略した節は md / start と同じクラスになる", () => {
  const root = drawTree({
    type: "stack",
    children: [
      { type: "switcher", children: ["a", { type: "cluster", children: ["b", "c"] }] },
      "d",
    ],
  });
  expect(root.className).toBe(`flex flex-col ${LAYOUT_GAP_CLASS.md}`);
  const switcher = only(root, '[data-layout="switcher"]');
  expect(switcher.className).toBe(`flex flex-wrap ${LAYOUT_GAP_CLASS.md}`);
  expect((switcher.children[0] as HTMLElement).className).toBe(LAYOUT_THRESHOLD_CLASS.md);
  const cluster = only(root, '[data-layout="cluster"]');
  expect(cluster.className).toBe("flex flex-wrap items-center gap-s3 justify-start");
  expect(leavesIn(root)).toEqual(["a", "b", "c", "d"]);
});

test("T03 layoutLeaves は木に置かれた葉を書いた順に返す(sidebar は脇 → 本文、split は始端 → 終端)", () => {
  expect(
    layoutLeaves({
      type: "stack",
      children: [
        { type: "sidebar", side: "s", main: { type: "grid", children: ["g1", "g2"] } },
        { type: "split", start: ["p"], end: ["action:submit"] },
      ],
    }),
  ).toEqual(["s", "g1", "g2", "p", "action:submit"]);
});

// ---------------------------------------------------------------------------
// (b) 入力フォーム: 葉の配置・送信ボタンの移動・木に置かない項目は末尾
// ---------------------------------------------------------------------------

const FORM_TREE = {
  type: "stack",
  gap: "md",
  children: [
    { type: "switcher", children: ["f_b", "f_a"] },
    { type: "split", start: [], end: ["action:submit"] },
  ],
};

function fieldWrapper(section: Element, fieldId: string): HTMLElement {
  const wrapper = section
    .querySelector(`[data-testid="field-label-${fieldId}"]`)
    ?.closest(".field");
  if (!(wrapper instanceof HTMLElement)) {
    throw new Error(`${fieldId} の項目の枠が無い`);
  }
  return wrapper;
}

test("T03 (b) 入力フォーム: 項目の葉は木の中に今日と同じ項目の枠で描かれ、書いた順に並ぶ", async () => {
  const section = await renderLayoutForm(layoutManifest("form", { layout: FORM_TREE }));
  const form = only(section, "form.record-form");
  const tree = only(form, ':scope > [data-layout="stack"]');
  const switcher = only(tree, '[data-layout="switcher"]');
  const b = fieldWrapper(section, "f_b");
  const a = fieldWrapper(section, "f_a");
  expect(switcher.contains(b)).toBe(true);
  expect(switcher.contains(a)).toBe(true);
  expect(precedes(b, a)).toBe(true);
  // 項目の枠のクラスは木を書かない画面と1文字も同じ(同じ部品で描いている)。
  expect(a.className).toBe("field flex flex-col gap-s1 sm:max-w-md");
});

test("T03 (b) 入力フォーム: action:submit を置くと送信ボタンは葉の位置に1つだけ描かれ、元の場所(form の直下)には描かれない", async () => {
  const section = await renderLayoutForm(layoutManifest("form", { layout: FORM_TREE }));
  const buttons = section.querySelectorAll('button[type="submit"]');
  expect(buttons).toHaveLength(1);
  const end = only(section, '[data-layout="split"] > [data-layout-slot="end"]');
  expect(end.contains(buttons[0] as Element)).toBe(true);
  expect(section.querySelectorAll('form.record-form > button[type="submit"]')).toHaveLength(0);
});

test("T03 (b) 入力フォーム: action:submit を置かなければ送信ボタンは今日の場所(form の直下の最後)のまま", async () => {
  const section = await renderLayoutForm(
    layoutManifest("form", { layout: { type: "cluster", children: ["f_a"] } }),
  );
  const button = only(section, 'button[type="submit"]');
  const form = only(section, "form.record-form");
  // happy-dom の `parentElement` は同じ要素でも `===` が偽になる(実測)ので、子の一覧で見る。
  expect([...form.children].includes(button)).toBe(true);
  expect(form.lastElementChild === button).toBe(true);
});

test("T03 (b) 入力フォーム: 木に置かなかった項目は木の後ろに今日の並び(fields の順)で縦に積まれる", async () => {
  const section = await renderLayoutForm(layoutManifest("form", { layout: FORM_TREE }));
  const form = only(section, "form.record-form");
  const tree = only(form, ':scope > [data-layout="stack"]');
  const rest = ["f_c", "f_d", "f_e", "f_f", "f_g"].map((id) => fieldWrapper(section, id));
  for (const wrapper of rest) {
    expect(tree.contains(wrapper)).toBe(false);
    expect(precedes(tree, wrapper)).toBe(true);
    expect([...form.children].includes(wrapper)).toBe(true);
  }
  for (let index = 1; index < rest.length; index += 1) {
    expect(precedes(rest[index - 1] as Element, rest[index] as Element)).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// (b) 詳細画面: 器が div になる・ボタンが葉へ移る・残りは今日の場所
// ---------------------------------------------------------------------------

const DETAIL_TREE = {
  type: "sidebar",
  side: "f_a",
  main: { type: "cluster", children: ["f_b", "action:to_target"] },
};

test("T03 (b) 詳細画面: 木を書くと項目の器は div になり、項目の葉は dl.detail-field(dt / dd)で木の中に描かれる", async () => {
  const section = await renderLayoutDetail(layoutManifest("detail", { layout: DETAIL_TREE }));
  const holder = section.querySelector('[data-testid="detail-fields"]') as HTMLElement;
  expect(holder.tagName).toBe("DIV");
  const tree = only(holder, ':scope > [data-layout="sidebar"]');
  const side = only(tree, ':scope > [data-layout-slot="side"]');
  const a = section.querySelector('[data-testid="detail-field-f_a"]') as HTMLElement;
  expect(side.contains(a)).toBe(true);
  const item = a.closest(".detail-field") as HTMLElement;
  expect(item.tagName).toBe("DL");
  expect([...item.children].map((child) => child.tagName)).toEqual(["DT", "DD"]);
});

test("T03 (b) 詳細画面: action:to_target は葉の位置に1つだけ描かれ、宣言ボタンの器には名指ししなかった mark だけが残る", async () => {
  const section = await renderLayoutDetail(layoutManifest("detail", { layout: DETAIL_TREE }));
  const moved = section.querySelectorAll('[data-testid="action-origin-target-form"]');
  expect(moved).toHaveLength(1);
  const cluster = only(section, '[data-layout="cluster"]');
  expect(cluster.contains(moved[0] as Element)).toBe(true);
  const origins = only(section, '[data-testid="detail-action-origins"]');
  expect([...origins.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
    "赤にする",
  ]);
});

test("T03 (b) 詳細画面: ボタンを全部名指しすると宣言ボタンの器そのものが出ない", async () => {
  const section = await renderLayoutDetail(
    layoutManifest("detail", {
      layout: { type: "cluster", children: ["action:mark", "action:to_target"] },
    }),
  );
  expect(section.querySelectorAll('[data-testid="detail-action-origins"]')).toHaveLength(0);
  const cluster = only(section, '[data-layout="cluster"]');
  expect([...cluster.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
    "赤にする",
    "参照先を作る",
  ]);
});

test("T03 (b) 詳細画面: 木に置かなかった項目は木の後ろに今日の器(dl.detail-fields)で縦に積まれる", async () => {
  const section = await renderLayoutDetail(layoutManifest("detail", { layout: DETAIL_TREE }));
  const holders = [...section.querySelectorAll('[data-testid="detail-fields"]')];
  expect(holders.map((holder) => holder.tagName)).toEqual(["DIV", "DL"]);
  const rest = holders[1] as HTMLElement;
  expect(
    [...rest.querySelectorAll("dd[data-field]")].map((dd) => dd.getAttribute("data-field")),
  ).toEqual(["f_c", "f_d", "f_e", "f_f", "f_g"]);
  expect(precedes(holders[0] as Element, rest)).toBe(true);
});

/**
 * **穴 `H-V20-61` の実測**(`V20-M5-T07` 軽9)。**正しい振る舞いを固定する検査ではない** ——
 * 今日の振る舞い(名指しした起動ボタンの失敗の表示が、葉の位置ではなく宣言ボタンの器に出る)を
 * 描画で撃って書き残す。**この穴を塞ぐ段は、この検査を書き換えること**(`unfixed-holes.md` §17)。
 */
function withRunAction(allNamed: boolean): Parameters<typeof renderLayoutDetail>[0] {
  const runAction = { id: "ship_it", run: "ship", name: "発送する" };
  const built = layoutManifest("detail", {
    actions: [TO_TARGET, runAction],
    layout: {
      type: "cluster",
      children: allNamed
        ? ["f_a", "action:to_target", "action:ship_it"]
        : ["f_a", "action:ship_it"],
    },
  });
  const app = built.app as { workflows?: unknown[]; roles?: { id: string; rules?: unknown[] }[] };
  app.workflows = [
    {
      id: "ship",
      name: "発送する",
      trigger: { type: "manual", table: "entries" },
      actions: [{ action: "update_record", values: { f_b: "発送済み" } }],
    },
  ];
  const owner = app.roles?.find((role) => role.id === "owner");
  owner?.rules?.push({ target: "action", view: "entry-detail", action: "ship_it", can: ["read"] });
  return built;
}

async function clickFailingRun(section: HTMLElement): Promise<HTMLElement> {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if ((init?.method ?? "GET") === "POST" && url.includes("/actions/run")) {
      return new Response(
        JSON.stringify({
          workflow: "ship",
          record: "entry-0001",
          failures: ["アクション1 が失敗しました"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return inner(input, init);
  }) as typeof fetch;
  const button = only(section, '[data-testid="action-run-ship"]');
  fireEvent.click(button);
  await waitFor(() =>
    expect(section.querySelector('[data-testid="detail-action-run-error"]')).not.toBeNull(),
  );
  return button;
}

test("T07 H-V20-61 詳細画面: 木に置いた起動ボタンの失敗は、葉の位置ではなく宣言ボタンの器に出る(穴の実測)", async () => {
  const section = await renderLayoutDetail(withRunAction(false));
  const cluster = only(section, '[data-layout="cluster"]');
  const button = await clickFailingRun(section);
  expect(cluster.contains(button)).toBe(true);
  const error = only(section, '[data-testid="detail-action-run-error"]');
  expect(error.textContent).toContain("失敗");
  // 失敗の表示は木の外(宣言ボタンの器の中)に在り、押したボタンの隣ではない。
  expect(cluster.contains(error)).toBe(false);
  expect(error.closest('[data-testid="detail-action-origins"]')).not.toBeNull();
});

test("T07 H-V20-61 詳細画面: ボタンを全部名指しした画面では、失敗が在るときだけ宣言ボタンの器が出る(穴の実測)", async () => {
  const section = await renderLayoutDetail(withRunAction(true));
  expect(section.querySelectorAll('[data-testid="detail-action-origins"]')).toHaveLength(0);
  await clickFailingRun(section);
  const origins = only(section, '[data-testid="detail-action-origins"]');
  expect(origins.querySelectorAll("button")).toHaveLength(0);
  expect(only(origins, '[data-testid="detail-action-run-error"]').textContent).toContain("失敗");
});

// ---------------------------------------------------------------------------
// (b) 一覧のカード: 葉の配置・行ボタンの移動・残りは末尾
// ---------------------------------------------------------------------------

const CARD_TREE = { type: "split", start: ["f_a"], end: ["action:to_target"] };

test("T03 (b) 一覧のカード: 項目とボタンの葉がカードの中の木に描かれ、ボタンはカードの末尾に描かれない", async () => {
  const section = await renderLayoutList(
    layoutManifest("list", { preset_list_shape: "card", layout: CARD_TREE }),
  );
  const card = only(section, '[data-testid="list-card"]');
  const tree = only(card, ':scope > [data-layout="split"]');
  const start = only(tree, ':scope > [data-layout-slot="start"]');
  const end = only(tree, ':scope > [data-layout-slot="end"]');
  expect(start.querySelector('[data-field="f_a"]')).not.toBeNull();
  const buttons = card.querySelectorAll('[data-testid="list-action-origin-target-form"]');
  expect(buttons).toHaveLength(1);
  expect(end.contains(buttons[0] as Element)).toBe(true);
  expect(card.querySelectorAll(":scope > .list-action-origins")).toHaveLength(0);
});

test("T03 (b) 一覧のカード: 木に置かなかった列は木の後ろに今日の並び(columns の順)で積まれる", async () => {
  const section = await renderLayoutList(
    layoutManifest("list", { preset_list_shape: "card", layout: CARD_TREE }),
  );
  const card = only(section, '[data-testid="list-card"]');
  const tree = only(card, ':scope > [data-layout="split"]');
  const rest = [...card.querySelectorAll(":scope > .list-card-field")];
  expect(rest.map((node) => node.getAttribute("data-field"))).toEqual([
    "f_b",
    "f_c",
    "f_d",
    "f_e",
    "f_f",
    "f_g",
  ]);
  for (const node of rest) {
    expect(precedes(tree, node)).toBe(true);
  }
});

test("T03 (b) 一覧のカード: ボタンを名指ししなければ行ボタンは今日の場所(カードの末尾)のまま", async () => {
  const section = await renderLayoutList(
    layoutManifest("list", {
      preset_list_shape: "card",
      layout: { type: "cluster", children: ["f_b", "f_a"] },
    }),
  );
  const card = only(section, '[data-testid="list-card"]');
  expect(card.lastElementChild?.classList.contains("list-action-origins")).toBe(true);
});
