/**
 * **並べ方の木(`layout`)を描く部品**(`V20-M5-T03`。条文 = `ADR-0462` / `ADR-0471`、
 * 置き場の判定 = `docs/plan/v20/records/v20-m5-t02.md`)。
 *
 * ## 置き場は描画側のリテラルである(**`web/src/styles.css` を1バイトも触らない**)
 *
 * **6種の並べ方と各パラメータの値は、下の対応表(値 → Tailwind のクラスの文字列)に閉じている。**
 * 先例は `FormRenderer.tsx` の `FIELD_WIDTH_CLASS`(`V20-M3-T02`)である —— `web/src/tailwind.css`
 * の `@source` がこのファイルを読み、ビルド出力に規則が落ちる。
 *
 * - **対応表のキーは語彙の値域(`schemas/manifest.schema.json` の `$defs/layout_node` の各 `enum`)と
 *   完全一致する**(`web/test/layout-tree.test.tsx` が値域から組み立てて突き合わせる)。
 *   **値を1つ足すと、対応表に行を足さない限り赤くなる**(当たり先の無い値を置かない)。
 * - **長さのリテラル(`10rem` など)はこの対応表の中にしか無い。** マニフェストに現れるのは
 *   値の名前(`sm` / `md` / `lg` ほか)だけである(PRD `NF7`)。
 * - **間隔は既存の余白のトークン(`--space-*`。Tailwind 側の呼び名 `gap-s1`〜`gap-s6`)に写す。**
 *   新しい長さを1つも作っていない。
 *
 * ## 幅への追随は「折り返しの基準」だけで行う(**画面幅の条件を1つも使わない**)
 *
 * **ビューポートの幅を条件にする at-rule を1本も使わない。** Tailwind の画面幅の接頭辞
 * (`sm:` / `lg:` など)も**この部品では1つも使わない**(ビルド出力に幅の条件の規則を増やすため)。
 * 入れ子の器の問い合わせも使わない(`ADR-0089` 限定2)。**切り替わるのは「要素が親の中に
 * どう収まるか」だけであり、条件は親の内側の寸法である**(計画 `07-v20-m5-plan.md` §0-3b)。
 *
 * - `sidebar` —— **脇組みの先例 `.workspace-body`(`web/src/styles.css`)と同じ形**: 脇は
 *   `flex: 1 1 <脇の幅>`、本文は `flex: 999 1 60%` と `min-width: 0`、器は `flex-wrap: wrap`。
 *   **脇の幅が本文の残りに入らなくなった時点で折り返し、上下に積まれる。**
 * - `switcher` —— 子ごとに伸びる比 1(クラス `grow`)と `flex-basis: calc((<切り替え幅> - 100%) * 999)`。
 *   (**伸びる比を宣言の綴りで書かない** —— `web/src/tailwind.css` の `@source` が注釈の綴りも拾い、
 *   使っていないクラスの規則をビルド出力に生やすため。`V20-M5-T07` 軽6)
 *   **器の幅が切り替え幅より広ければ基準幅が負(= 0)になって全部が横に並び、狭ければ基準幅が
 *   極端に大きくなって全部が一斉に縦に積まれる。**
 * - `grid` —— **格子の先例 `.theme-preview-list` と同じ形**:
 *   `repeat(auto-fit, minmax(min(<最小幅>, 100%), 1fr))`。**列数は `auto-fit` が決める。**
 *   `min(…, 100%)` は器が最小幅より狭いときに横へはみ出さないためである。
 * - `stack` / `cluster` / `split` —— 幅の基準を1つも持たない(縦に積む / 折り返す / 両端に振る)。
 *
 * ## 葉の描き方は呼び出し側が持つ
 *
 * **この部品は葉(項目のフィールドID / `"action:<名前>"`)を自分で描かない** —— 呼び出し側
 * (入力フォーム・詳細画面・一覧のカード)が `renderLeaf` で今日と同じ部品を1つずつ渡す。
 * **同じ項目・同じボタンを2本目の実装で描かない**ためである。
 *
 * ## 座標・重ね順を1つも持たない
 *
 * **対応表のクラスに位置指定・重ね順・座標のプロパティは1つも無い。** `side_position: "end"`
 * は**文書順を入れ替える**だけで実現する(並び替えのプロパティも使わない)。
 */
import { Fragment, type ReactNode } from "react";
import type { FormView } from "../../../src/kernel/types.ts";
import { cn } from "../ui/utils.ts";

/** 並べ方の木の節(`$defs/layout_node`)。 */
export type LayoutNode = NonNullable<FormView["layout"]>;
type LayoutChild = string | LayoutNode;
type LayoutType = LayoutNode["type"];
type LayoutGap = NonNullable<Extract<LayoutNode, { type: "stack" }>["gap"]>;
type LayoutJustify = NonNullable<Extract<LayoutNode, { type: "cluster" }>["justify"]>;
type LayoutSideWidth = NonNullable<Extract<LayoutNode, { type: "sidebar" }>["side_width"]>;
type LayoutSidePosition = NonNullable<Extract<LayoutNode, { type: "sidebar" }>["side_position"]>;
type LayoutThreshold = NonNullable<Extract<LayoutNode, { type: "switcher" }>["threshold"]>;
type LayoutMinItem = NonNullable<Extract<LayoutNode, { type: "grid" }>["min_item"]>;

// --- 対応表(値 → クラス)。**長さのリテラルはここにしか無い** ------------------------------

/** 6種の器のクラス(パラメータに依らない部分)。 */
export const LAYOUT_TYPE_CLASS: Readonly<Record<LayoutType, string>> = {
  stack: "flex flex-col",
  cluster: "flex flex-wrap items-center",
  sidebar: "flex flex-wrap items-start gap-s3",
  switcher: "flex flex-wrap",
  grid: "grid",
  split: "flex flex-wrap items-center justify-between gap-s3",
};

/** 間隔5値 → 既存の余白のトークン(`--space-1`〜`--space-6` のうち5本)。 */
export const LAYOUT_GAP_CLASS: Readonly<Record<LayoutGap, string>> = {
  xs: "gap-s1",
  sm: "gap-s2",
  md: "gap-s3",
  lg: "gap-s4",
  xl: "gap-s6",
};

/** `cluster` の寄せ方3値。 */
export const LAYOUT_JUSTIFY_CLASS: Readonly<Record<LayoutJustify, string>> = {
  start: "justify-start",
  end: "justify-end",
  between: "justify-between",
};

/** `sidebar` の脇の幅3値(脇に当てる。先例 `.workspace-body > .view-list` の `flex: 1 1 12rem` と同じ形)。 */
export const LAYOUT_SIDE_WIDTH_CLASS: Readonly<Record<LayoutSideWidth, string>> = {
  sm: "flex-[1_1_10rem]",
  md: "flex-[1_1_15rem]",
  lg: "flex-[1_1_20rem]",
};

/** `sidebar` の脇の位置2値。**クラスを持たない** —— 文書順(脇を先に描くか後に描くか)で決める。 */
export const LAYOUT_SIDE_POSITION_ORDER: Readonly<
  Record<LayoutSidePosition, "side-first" | "main-first">
> = {
  start: "side-first",
  end: "main-first",
};

/** `sidebar` の本文に当てるクラス(先例 `.workspace-body > .workspace-main` の `flex: 999 1 60%; min-width: 0`)。 */
export const LAYOUT_SIDEBAR_MAIN_CLASS = "flex-[999_1_60%] min-w-0";

/** `switcher` の切り替え幅3値(子ごとに当てる)。 */
export const LAYOUT_THRESHOLD_CLASS: Readonly<Record<LayoutThreshold, string>> = {
  sm: "grow basis-[calc((20rem_-_100%)_*_999)]",
  md: "grow basis-[calc((30rem_-_100%)_*_999)]",
  lg: "grow basis-[calc((45rem_-_100%)_*_999)]",
};

/** `grid` の最小幅3値(器に当てる)。 */
export const LAYOUT_MIN_ITEM_CLASS: Readonly<Record<LayoutMinItem, string>> = {
  sm: "grid-cols-[repeat(auto-fit,minmax(min(10rem,100%),1fr))]",
  md: "grid-cols-[repeat(auto-fit,minmax(min(15rem,100%),1fr))]",
  lg: "grid-cols-[repeat(auto-fit,minmax(min(20rem,100%),1fr))]",
};

/** `split` の両端の器のクラス。 */
export const LAYOUT_SPLIT_END_CLASS = "flex flex-wrap items-center gap-s2";

/**
 * **パラメータを省略したときの値**(すべて値域の中の名前。省略時に別の長さを持ち込まない)。
 * 省略した節と、同じ値を名指しした節は1文字も同じクラスになる。
 */
export const LAYOUT_DEFAULTS = {
  gap: "md",
  justify: "start",
  side_width: "md",
  side_position: "start",
  threshold: "md",
  min_item: "md",
} as const satisfies {
  gap: LayoutGap;
  justify: LayoutJustify;
  side_width: LayoutSideWidth;
  side_position: LayoutSidePosition;
  threshold: LayoutThreshold;
  min_item: LayoutMinItem;
};

// --- 木を歩く ---------------------------------------------------------------------------------

/** 節の子を、書いた順に返す(`sidebar` は脇 → 本文、`split` は始端 → 終端)。 */
function childrenOf(node: LayoutNode): LayoutChild[] {
  switch (node.type) {
    case "sidebar":
      return [node.side, node.main];
    case "split":
      return [...node.start, ...node.end];
    default:
      return node.children;
  }
}

/** **木に置かれた葉を、書いた順にすべて返す**(呼び出し側が「木に置かなかった項目・ボタン」を求めるため)。 */
export function layoutLeaves(node: LayoutNode): string[] {
  return childrenOf(node).flatMap((child) =>
    typeof child === "string" ? [child] : layoutLeaves(child),
  );
}

/** 葉の綴りのうちボタンを指す接頭辞(`"action:<名前>"`)。 */
export const ACTION_LEAF_PREFIX = "action:";

/** 入力フォームの送信ボタンを指す予約の葉(メインの申1。予約名は `submit` の1つだけ・入力フォームだけ)。 */
export const SUBMIT_LEAF = "action:submit";

/** 葉がボタンを指していればその名前を、項目を指していれば `undefined` を返す。 */
export function actionLeafName(leaf: string): string | undefined {
  return leaf.startsWith(ACTION_LEAF_PREFIX) ? leaf.slice(ACTION_LEAF_PREFIX.length) : undefined;
}

// --- 描く -------------------------------------------------------------------------------------

export type RenderLeaf = (leaf: string) => ReactNode;

/**
 * **並べ方の木を1本描く。** 節ごとに `div` を1つ出し、`data-layout` に型の名前を写す。
 * 子の器(脇 / 本文 / 始端 / 終端 / 切り替えの子)には `data-layout-slot` を付ける。
 */
export function LayoutTree({ node, renderLeaf }: { node: LayoutNode; renderLeaf: RenderLeaf }) {
  return <LayoutNodeView node={node} renderLeaf={renderLeaf} />;
}

function LayoutChildView({ child, renderLeaf }: { child: LayoutChild; renderLeaf: RenderLeaf }) {
  return typeof child === "string" ? (
    renderLeaf(child)
  ) : (
    <LayoutNodeView node={child} renderLeaf={renderLeaf} />
  );
}

/** 子の並びを描く。**葉の綴りは木の中で一意である**(適用時に重複を拒否している)ので鍵に使う。 */
function childList(children: LayoutChild[], renderLeaf: RenderLeaf, wrapClass?: string) {
  return children.map((child, index) => {
    const key = typeof child === "string" ? `leaf:${child}` : `node:${index}`;
    return wrapClass === undefined ? (
      <Fragment key={key}>
        <LayoutChildView child={child} renderLeaf={renderLeaf} />
      </Fragment>
    ) : (
      <div className={wrapClass} data-layout-slot="item" key={key}>
        <LayoutChildView child={child} renderLeaf={renderLeaf} />
      </div>
    );
  });
}

function LayoutNodeView({ node, renderLeaf }: { node: LayoutNode; renderLeaf: RenderLeaf }) {
  switch (node.type) {
    case "stack":
      return (
        <div
          className={cn(LAYOUT_TYPE_CLASS.stack, LAYOUT_GAP_CLASS[node.gap ?? LAYOUT_DEFAULTS.gap])}
          data-layout="stack"
        >
          {childList(node.children, renderLeaf)}
        </div>
      );
    case "cluster":
      return (
        <div
          className={cn(
            LAYOUT_TYPE_CLASS.cluster,
            LAYOUT_GAP_CLASS[node.gap ?? LAYOUT_DEFAULTS.gap],
            LAYOUT_JUSTIFY_CLASS[node.justify ?? LAYOUT_DEFAULTS.justify],
          )}
          data-layout="cluster"
        >
          {childList(node.children, renderLeaf)}
        </div>
      );
    case "sidebar": {
      const side = (
        <div
          className={LAYOUT_SIDE_WIDTH_CLASS[node.side_width ?? LAYOUT_DEFAULTS.side_width]}
          data-layout-slot="side"
          key="side"
        >
          <LayoutChildView child={node.side} renderLeaf={renderLeaf} />
        </div>
      );
      const main = (
        <div className={LAYOUT_SIDEBAR_MAIN_CLASS} data-layout-slot="main" key="main">
          <LayoutChildView child={node.main} renderLeaf={renderLeaf} />
        </div>
      );
      const order = LAYOUT_SIDE_POSITION_ORDER[node.side_position ?? LAYOUT_DEFAULTS.side_position];
      return (
        <div className={LAYOUT_TYPE_CLASS.sidebar} data-layout="sidebar">
          {order === "side-first" ? [side, main] : [main, side]}
        </div>
      );
    }
    case "switcher":
      return (
        <div
          className={cn(
            LAYOUT_TYPE_CLASS.switcher,
            LAYOUT_GAP_CLASS[node.gap ?? LAYOUT_DEFAULTS.gap],
          )}
          data-layout="switcher"
        >
          {childList(
            node.children,
            renderLeaf,
            LAYOUT_THRESHOLD_CLASS[node.threshold ?? LAYOUT_DEFAULTS.threshold],
          )}
        </div>
      );
    case "grid":
      return (
        <div
          className={cn(
            LAYOUT_TYPE_CLASS.grid,
            LAYOUT_GAP_CLASS[node.gap ?? LAYOUT_DEFAULTS.gap],
            LAYOUT_MIN_ITEM_CLASS[node.min_item ?? LAYOUT_DEFAULTS.min_item],
          )}
          data-layout="grid"
        >
          {childList(node.children, renderLeaf)}
        </div>
      );
    case "split":
      return (
        <div className={LAYOUT_TYPE_CLASS.split} data-layout="split">
          <div className={LAYOUT_SPLIT_END_CLASS} data-layout-slot="start">
            {childList(node.start, renderLeaf)}
          </div>
          <div className={LAYOUT_SPLIT_END_CLASS} data-layout-slot="end">
            {childList(node.end, renderLeaf)}
          </div>
        </div>
      );
  }
}
