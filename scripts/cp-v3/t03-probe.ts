/**
 * V3-M7-T03 の実証スクリプト②(計測)。**テストではない。**
 *
 * ## なぜ `web/e2e/` の外に、`*.test.ts` / `*.spec.ts` 以外の名前で置くのか
 *
 * `docs/plan/v3/records/v3-m7.md` §2 の `V3-M7-T03` 完了条件7(= `V3-M7-T02` 完了条件7 と
 * 同じ制約)が要求している。理由は2つ:
 *
 * - **`bun test` はリポジトリ全体の `*.test.ts` を拾う**(同 §0-1c (11))。本スクリプトは
 *   `.gitignore:4` の無視規則に載る複製データルート(`data-m7-t03-live` / `data-m7-t03-base`)で
 *   起動済みの Web サーバ2本を前提にする。`*.test.ts` の名前で置けば実 CI の `checks` が必ず赤になる。
 * - **playwright は `web/e2e/` 配下の `.e2e.ts` を拾う**(同 §0-1c (12))。同じ理由で
 *   `web/e2e/` にも置けない。
 *
 * ## 何を測るか
 *
 * **ローカルの本物 chromium の計算後スタイル**である(`V3-M7-T03` 完了条件1 の判定根拠は
 * `V3-M7-T02` と同じ)。T02 の計測に無かったものを3つ足している:
 *
 * 1. **疑似要素(`::before` / `::after`)の計算後スタイルと `content`** —— 逃げ道は要素を
 *    足す手段として疑似要素を使うので、これを測らないと到達を判定できない。
 * 2. **媒体・配色設定の切り替え**(`emulateMedia`)—— 印刷の媒体と暗い配色設定は、
 *    画面の媒体の計測では原理的に測れない。
 * 3. **窓幅を変えた計測** —— 幅の狭い端末の見え方。
 *
 * **スクリーンショットは参考資料であり判定に使わない**(`v3-m7.md` §0-4 (8))。
 *
 * ## 限界(隠さず書く)
 *
 * - **ローカルの chromium は macOS の chromium である**(同 §0-4 (2))。
 * - **参照アプリの複製に対する計測である**(同 §0-4 (3))。
 *
 * 使い方:
 *   bun run scripts/cp-v3/t03-probe.ts <baselineUrl> <baselineCookie> <hatchUrl> <hatchCookie> <outDir> [--shots]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, chromium, type Page } from "@playwright/test";

const [, , baseUrl, baseCookie, hatchUrl, hatchCookie, outDir, ...rest] = process.argv;
if (
  baseUrl === undefined ||
  baseCookie === undefined ||
  hatchUrl === undefined ||
  hatchCookie === undefined ||
  outDir === undefined
) {
  throw new Error(
    "usage: t03-probe.ts <baselineUrl> <baselineCookie> <hatchUrl> <hatchCookie> <outDir> [--shots]",
  );
}
const wantShots = rest.includes("--shots");
/** 引数を狭めた別名(関数の中から使うため。宣言の巻き上げで絞り込みが効かない)。 */
const OUT_DIR: string = outDir;

/** 計測する CSS プロパティ。T02 の46件に、逃げ道の判定に要るものを足した。 */
const PROPS = [
  "color",
  "background-color",
  "background-image",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "text-align",
  "text-decoration-line",
  "padding-top",
  "padding-left",
  "margin-top",
  "margin-left",
  "border-top-width",
  "border-top-style",
  "border-left-width",
  "border-left-color",
  "border-radius",
  "box-shadow",
  "max-width",
  "min-height",
  "width",
  "height",
  "display",
  "position",
  "order",
  "flex-basis",
  "column-gap",
  "grid-template-columns",
  "text-overflow",
  "white-space",
  "overflow-x",
  "opacity",
  "content",
  "transition-duration",
  "transition-property",
  "vertical-align",
  "cursor",
] as const;

type ProbeSpec = { key: string; selector: string; index?: number; pseudo?: string };
type ScreenSpec = {
  id: string;
  path: string;
  recordTable?: string;
  waitFor?: string;
  probes: ProbeSpec[];
  /** ポインタを乗せた状態でもう1度測る(たたんだ入口を開く)。 */
  hover?: { target: string; probes: ProbeSpec[] };
  /** 暗い配色設定で測り直す。 */
  dark?: ProbeSpec[];
  /** 印刷の媒体で測り直す。 */
  print?: ProbeSpec[];
  /** 窓を狭めて測り直す(幅420)。 */
  narrow?: ProbeSpec[];
};

/** どの画面にも当てる共通の計測点(シェル + 逃げ道の遮断表示)。 */
function shellProbes(): ProbeSpec[] {
  return [
    { key: "app-theme", selector: ".app-theme" },
    { key: "shell", selector: ".shell" },
    { key: "app-header-h2", selector: ".app-header h2" },
    { key: "app-header-h2::before", selector: ".app-header h2", pseudo: "::before" },
    { key: "app-header-button", selector: ".app-header button", index: 0 },
    { key: "view-list", selector: ".view-list" },
    { key: "view-list::before", selector: ".view-list", pseudo: "::before" },
    { key: "nav-ul", selector: ".view-list ul" },
    { key: "nav-li-1::before", selector: ".view-list ul li", index: 0, pseudo: "::before" },
    { key: "nav-li-12::before", selector: ".view-list ul li", index: 11, pseudo: "::before" },
    { key: "nav-link", selector: ".view-list ul li a", index: 0 },
    { key: "view-title", selector: "h3[data-testid=view-title]" },
    { key: "section", selector: ".app-theme > section" },
    { key: "section::after", selector: ".app-theme > section", pseudo: "::after" },
    { key: "custom-css-style", selector: "style[data-testid=custom-css]" },
    { key: "custom-css-blocked", selector: "[data-testid=custom-css-blocked]" },
  ];
}

const SCREENS: ScreenSpec[] = [
  {
    id: "catalog-list",
    path: "/apps/ref-ec/views/catalog-list",
    waitFor: ".list-table",
    probes: [
      ...shellProbes(),
      { key: "list-view", selector: ".list-view" },
      { key: "list-table", selector: ".list-table" },
      { key: "th-0", selector: ".list-table thead th", index: 0 },
      { key: "tr-0", selector: ".list-table tbody tr", index: 0 },
      { key: "tr-1", selector: ".list-table tbody tr", index: 1 },
      { key: "td-name", selector: ".list-table td[data-field=name]", index: 0 },
      { key: "list-total", selector: ".list-total", index: 0 },
      { key: "meta", selector: ".view-list .meta", index: 0 },
      {
        key: "td-image-empty",
        selector: ".list-table td[data-field=image] .field-empty",
        index: 0,
      },
      { key: "link", selector: ".list-table a", index: 0 },
      { key: "nav-current", selector: '.view-list a[href$="/views/catalog-list"]' },
      // M7-R16(店として今日やることの枠)/ M7-R23(行のどこを押しても遷移)の当て先
      { key: "summary-box", selector: ".list-view > .summary" },
      // M7-R87(図)/ M7-R90(文字の大きさを変える入口)の当て先。**どちらも0件のままであることを測る。**
      { key: "chart", selector: ".list-view svg, .list-view canvas" },
      { key: "font-size-control", selector: "[data-testid=font-size-control]" },
      { key: "tr-0-cursor", selector: ".list-table tbody tr", index: 0 },
    ],
    hover: {
      target: ".view-list",
      probes: [
        { key: "nav-ul", selector: ".view-list ul" },
        { key: "nav-link", selector: ".view-list ul li a", index: 0 },
      ],
    },
    dark: [
      { key: "app-theme", selector: ".app-theme" },
      { key: "td-name", selector: ".list-table td[data-field=name]", index: 0 },
      { key: "link", selector: ".list-table a", index: 0 },
    ],
    narrow: [
      { key: "list-table", selector: ".list-table" },
      { key: "section", selector: ".app-theme > section" },
      { key: "view-list", selector: ".view-list" },
    ],
  },
  {
    id: "variant-list",
    path: "/apps/ref-ec/views/variant-list",
    waitFor: ".list-table",
    probes: [
      ...shellProbes(),
      { key: "td-price", selector: ".list-table td[data-field=price]", index: 0 },
      {
        key: "td-price::after",
        selector: ".list-table td[data-field=price]",
        index: 0,
        pseudo: "::after",
      },
      { key: "td-stock", selector: ".list-table td[data-field=stock]", index: 0 },
      { key: "td-status", selector: ".list-table td[data-field=status]", index: 0 },
      { key: "th-0", selector: ".list-table thead th", index: 0 },
      { key: "tr-1", selector: ".list-table tbody tr", index: 1 },
    ],
  },
  {
    id: "category-list",
    path: "/apps/ref-ec/views/category-list",
    waitFor: ".list-table",
    probes: [
      ...shellProbes(),
      { key: "th-0", selector: ".list-table thead th", index: 0 },
      { key: "tr-1", selector: ".list-table tbody tr", index: 1 },
      { key: "td-parent-0", selector: ".list-table td[data-field=parent]", index: 0 },
      { key: "td-parent-1", selector: ".list-table td[data-field=parent]", index: 1 },
    ],
  },
  {
    id: "admin-order-list",
    path: "/apps/ref-ec/views/admin-order-list",
    waitFor: ".list-table",
    probes: [
      ...shellProbes(),
      { key: "list-total", selector: ".list-total", index: 0 },
      { key: "td-status-span", selector: ".list-table td[data-field=status] > span", index: 0 },
      { key: "td-total", selector: ".list-table td[data-field=total]", index: 0 },
      { key: "td-payment-0", selector: ".list-table td[data-field=payment_status]", index: 0 },
      { key: "th-0", selector: ".list-table thead th", index: 0 },
      { key: "tr-1", selector: ".list-table tbody tr", index: 1 },
      { key: "filter-box", selector: ".list-view form" },
    ],
  },
  {
    id: "admin-order-line-list",
    path: "/apps/ref-ec/views/admin-order-line-list",
    waitFor: ".list-table",
    probes: [
      ...shellProbes(),
      { key: "th-1", selector: ".list-table thead th", index: 1 },
      { key: "td-order-id", selector: ".list-table td[data-field=order_id]", index: 0 },
      { key: "th-0", selector: ".list-table thead th", index: 0 },
    ],
  },
  {
    id: "admin-unpaid-order-list",
    path: "/apps/ref-ec/views/admin-unpaid-order-list",
    waitFor: ".list-view",
    probes: [...shellProbes(), { key: "list-view", selector: ".list-view" }],
  },
  {
    id: "address-list",
    path: "/apps/ref-ec/views/address-list",
    waitFor: ".list-view",
    probes: [
      ...shellProbes(),
      { key: "list-empty", selector: "p[data-testid=list-empty]" },
      { key: "list-empty::before", selector: "p[data-testid=list-empty]", pseudo: "::before" },
      { key: "list-empty::after", selector: "p[data-testid=list-empty]", pseudo: "::after" },
      { key: "img", selector: ".list-view img" },
    ],
  },
  {
    id: "cart-totals-list",
    path: "/apps/ref-ec/views/cart-totals-list",
    waitFor: ".list-view",
    probes: [
      ...shellProbes(),
      { key: "list-view", selector: ".list-view" },
      { key: "list-view::before", selector: ".list-view", pseudo: "::before" },
      { key: "list-empty", selector: "p[data-testid=list-empty]" },
    ],
  },
  {
    id: "wf-run-list",
    path: "/apps/ref-ec/views/wf-run-list",
    waitFor: ".list-table",
    probes: [
      ...shellProbes(),
      { key: "field-long-text", selector: ".field-long-text", index: 0 },
      { key: "td-status", selector: ".list-table td[data-field=status]", index: 0 },
      { key: "td-ran-at", selector: ".list-table td[data-field=ran_at]", index: 0 },
    ],
  },
  {
    id: "payment-event-list",
    path: "/apps/ref-ec/views/payment-event-list",
    waitFor: ".list-table",
    probes: [
      ...shellProbes(),
      { key: "td-order", selector: ".list-table td[data-field=order]", index: 0 },
      { key: "field-unresolved", selector: ".field-unresolved", index: 0 },
    ],
  },
  {
    id: "order-event-list",
    path: "/apps/ref-ec/views/order-event-list",
    waitFor: ".list-table",
    probes: [...shellProbes(), { key: "th-0", selector: ".list-table thead th", index: 0 }],
  },
  {
    id: "order-action-list",
    path: "/apps/ref-ec/views/order-action-list",
    waitFor: ".list-view",
    probes: [
      ...shellProbes(),
      { key: "td-order", selector: ".list-table td[data-field=order]", index: 0 },
    ],
  },
  {
    id: "tax-rate-list",
    path: "/apps/ref-ec/views/tax-rate-list",
    waitFor: ".list-table",
    probes: [
      ...shellProbes(),
      { key: "td-rate", selector: ".list-table td[data-field=rate]", index: 0 },
      {
        key: "td-rate::after",
        selector: ".list-table td[data-field=rate]",
        index: 0,
        pseudo: "::after",
      },
    ],
  },
  {
    id: "coupon-list",
    path: "/apps/ref-ec/views/coupon-list",
    waitFor: ".list-table",
    probes: [
      ...shellProbes(),
      { key: "td-discount-type", selector: ".list-table td[data-field=discount_type]", index: 0 },
      { key: "td-is-active", selector: ".list-table td[data-field=is_active]", index: 0 },
    ],
  },
  {
    id: "shipping-method-list",
    path: "/apps/ref-ec/views/shipping-method-list",
    waitFor: ".list-table",
    probes: [
      ...shellProbes(),
      { key: "td-free-over", selector: ".list-table td[data-field=free_over]", index: 0 },
    ],
  },
  {
    id: "product-detail",
    path: "/apps/ref-ec/views/product-detail/records/",
    recordTable: "product",
    waitFor: ".detail-fields",
    probes: [
      ...shellProbes(),
      { key: "detail-fields", selector: ".detail-fields" },
      { key: "field-name", selector: ".detail-field:has(> dd[data-field=name])" },
      {
        key: "field-name::before",
        selector: ".detail-field:has(> dd[data-field=name])",
        pseudo: "::before",
      },
      {
        key: "field-status::before",
        selector: ".detail-field:has(> dd[data-field=status])",
        pseudo: "::before",
      },
      { key: "btn-edit", selector: "button[data-testid=detail-edit]" },
      { key: "btn-delete", selector: "button[data-testid=detail-delete]" },
      { key: "field-image", selector: ".field-image" },
      { key: "field-long-text", selector: ".field-long-text", index: 0 },
      { key: "dd-st-public", selector: "dd[data-field=st_public]" },
      { key: "detail-actions-top", selector: ".detail-view > .detail-actions:first-child" },
      { key: "related-table", selector: ".related-table" },
    ],
  },
  {
    id: "category-detail",
    path: "/apps/ref-ec/views/category-detail/records/",
    recordTable: "category",
    waitFor: ".detail-fields",
    probes: [
      ...shellProbes(),
      { key: "detail-fields", selector: ".detail-fields" },
      { key: "related-th-0", selector: ".related-table th", index: 0 },
      { key: "related-img", selector: ".related-table img" },
    ],
  },
  {
    id: "variant-detail",
    path: "/apps/ref-ec/views/variant-detail/records/",
    recordTable: "variant",
    waitFor: ".detail-fields",
    probes: [
      ...shellProbes(),
      { key: "btn-cart", selector: "button[data-testid=action-origin-cart-line-form]" },
      { key: "btn-edit", selector: "button[data-testid=detail-edit]" },
      { key: "dd-stock", selector: "dd[data-field=stock]" },
      { key: "dd-stock::after", selector: "dd[data-field=stock]", pseudo: "::after" },
    ],
  },
  {
    id: "admin-order-detail",
    path: "/apps/ref-ec/views/admin-order-detail/records/",
    recordTable: "order_admin",
    waitFor: ".detail-fields",
    probes: [
      ...shellProbes(),
      { key: "field-order-id", selector: ".detail-field:has(> dd[data-field=order_id])" },
      { key: "field-status", selector: ".detail-field:has(> dd[data-field=status])" },
      { key: "field-payment", selector: ".detail-field:has(> dd[data-field=payment_status])" },
      { key: "field-subtotal", selector: ".detail-field:has(> dd[data-field=subtotal])" },
      { key: "field-total", selector: ".detail-field:has(> dd[data-field=total])" },
      { key: "dd-total", selector: "dd[data-field=total]" },
      { key: "dd-status", selector: "dd[data-field=status]" },
      { key: "field-order-number", selector: ".detail-field:has(> dd[data-field=order_number])" },
    ],
    print: [
      { key: "app-header", selector: ".app-header" },
      { key: "view-list", selector: ".view-list" },
      { key: "detail-actions", selector: ".detail-actions" },
      { key: "detail-view::before", selector: ".detail-view", pseudo: "::before" },
      { key: "detail-fields", selector: ".detail-fields" },
    ],
  },
  {
    id: "cart-detail",
    path: "/apps/ref-ec/views/cart-detail",
    waitFor: ".app-theme",
    probes: [
      ...shellProbes(),
      { key: "errors", selector: ".errors" },
      { key: "errors-li", selector: ".errors li" },
      { key: "hint", selector: ".errors .hint" },
    ],
  },
  {
    id: "order-form",
    path: "/apps/ref-ec/views/order-form",
    waitFor: ".record-form",
    probes: [
      ...shellProbes(),
      { key: "record-form", selector: ".record-form" },
      { key: "field-0", selector: ".record-form .field", index: 0 },
      { key: "required-0", selector: ".record-form .required", index: 0 },
      { key: "input-order-number", selector: "#order-form-order_number" },
      { key: "input-currency", selector: "#order-form-currency" },
      { key: "input-note", selector: "#order-form-note" },
      {
        key: "field-order-number::before",
        selector: ".record-form .field:has(> label[data-testid=field-label-order_number])",
        pseudo: "::before",
      },
      {
        key: "field-ship-to::before",
        selector: ".record-form .field:has(> label[data-testid=field-label-ship_to])",
        pseudo: "::before",
      },
      {
        key: "field-total::after",
        selector: ".record-form .field:has(> label[data-testid=field-label-total])",
        pseudo: "::after",
      },
      { key: "submit", selector: ".record-form button[type=submit]" },
      { key: "buttons", selector: ".record-form button" },
      { key: "input-placed-at", selector: "#order-form-placed_at" },
    ],
  },
  {
    id: "product-form",
    path: "/apps/ref-ec/views/product-form",
    waitFor: ".record-form",
    probes: [
      ...shellProbes(),
      { key: "textarea", selector: ".record-form textarea", index: 0 },
      { key: "checkbox", selector: ".record-form input[type=checkbox]" },
      {
        key: "field-checkbox::after",
        selector: ".record-form .field:has(input[type=checkbox])",
        pseudo: "::after",
      },
      { key: "input-file", selector: ".record-form input[type=file]" },
    ],
  },
  {
    id: "cart-form",
    path: "/apps/ref-ec/views/cart-form",
    waitFor: ".record-form",
    probes: [
      ...shellProbes(),
      { key: "select-customer", selector: "#cart-form-customer" },
      {
        key: "field-customer::after",
        selector: ".record-form .field:has(> select > option:only-child)",
        pseudo: "::after",
      },
    ],
  },
  {
    id: "cart-line-form",
    path: "/apps/ref-ec/views/cart-line-form",
    waitFor: ".record-form",
    probes: [...shellProbes(), { key: "select-variant", selector: "#cart-line-form-variant" }],
  },
  {
    id: "address-form",
    path: "/apps/ref-ec/views/address-form",
    waitFor: ".record-form",
    probes: [
      ...shellProbes(),
      {
        key: "field-postal::after",
        selector: ".record-form .field:has(> label[data-testid=field-label-postal_code])",
        pseudo: "::after",
      },
      {
        key: "field-prefecture::after",
        selector: ".record-form .field:has(> label[data-testid=field-label-prefecture])",
        pseudo: "::after",
      },
    ],
  },
  {
    id: "category-form",
    path: "/apps/ref-ec/views/category-form",
    waitFor: ".record-form",
    probes: [
      ...shellProbes(),
      {
        key: "label-slug::after",
        selector: "label[data-testid=field-label-slug]",
        pseudo: "::after",
      },
    ],
  },
  {
    // 逃げ道の参照を1件も書いていない画面。**シェルの指定がアプリ全体に及ばないことの当て先。**
    id: "app-home",
    path: "/apps/ref-ec",
    waitFor: ".app-header",
    probes: shellProbes(),
  },
];

type Measured = {
  found: boolean;
  count: number;
  text?: string;
  textLength?: number;
  rect?: { x: number; y: number; w: number; h: number };
  css?: Record<string, string>;
};

async function measureScreen(
  page: Page,
  context: BrowserContext,
  origin: string,
  screen: ScreenSpec,
  shotDir: string | undefined,
): Promise<Record<string, Record<string, Measured>>> {
  let path = screen.path;
  if (screen.recordTable !== undefined) {
    const response = await context.request.get(
      `${origin}/api/apps/ref-ec/tables/${screen.recordTable}/records?limit=1`,
    );
    const body = (await response.json()) as { records?: { _id?: string }[] };
    const first = (body.records ?? [])[0];
    if (first?._id === undefined) {
      throw new Error(`${screen.id}: ${screen.recordTable} に読めるレコードが1件も無い`);
    }
    path = `${screen.path}${first._id}`;
  }
  await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
  if (screen.waitFor !== undefined) {
    await page
      .locator(screen.waitFor)
      .first()
      .waitFor({ timeout: 15_000 })
      .catch(() => undefined);
  }

  const run = async (probes: ProbeSpec[]): Promise<Record<string, Measured>> =>
    await page.evaluate(
      ({ probes, props }) => {
        const result: Record<string, Measured> = {};
        for (const probe of probes) {
          let nodes: NodeListOf<Element>;
          try {
            nodes = document.querySelectorAll(probe.selector);
          } catch {
            result[probe.key] = { found: false, count: -1 };
            continue;
          }
          const node = nodes[probe.index ?? 0];
          if (!(node instanceof Element)) {
            result[probe.key] = { found: false, count: nodes.length };
            continue;
          }
          const computed = window.getComputedStyle(node, probe.pseudo ?? null);
          const css: Record<string, string> = {};
          for (const prop of props) {
            css[prop] = computed.getPropertyValue(prop);
          }
          const rect = node.getBoundingClientRect();
          const text = node.textContent ?? "";
          result[probe.key] = {
            found: true,
            count: nodes.length,
            text: text.slice(0, 180),
            textLength: text.length,
            rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
            css,
          };
        }
        return result;
      },
      { probes, props: PROPS as unknown as string[] },
    );

  const modes: Record<string, Record<string, Measured>> = { screen: await run(screen.probes) };

  if (screen.hover !== undefined) {
    await page
      .locator(screen.hover.target)
      .first()
      .hover()
      .catch(() => undefined);
    modes.hover = await run(screen.hover.probes);
    await page.mouse.move(1270, 890);
  }
  if (screen.dark !== undefined) {
    await page.emulateMedia({ colorScheme: "dark" });
    modes.dark = await run(screen.dark);
    await page.emulateMedia({ colorScheme: "light" });
  }
  if (screen.print !== undefined) {
    await page.emulateMedia({ media: "print" });
    modes.print = await run(screen.print);
    await page.emulateMedia({ media: "screen" });
  }
  if (screen.narrow !== undefined) {
    await page.setViewportSize({ width: 420, height: 900 });
    modes.narrow = await run(screen.narrow);
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    modes.narrow["#document"] = {
      found: true,
      count: 1,
      css: {
        scrollWidth: String(overflow.scrollWidth),
        innerWidth: String(overflow.innerWidth),
      },
    };
    await page.setViewportSize({ width: 1280, height: 900 });
  }

  modes.meta = {
    "#title": { found: true, count: 1, text: await page.title() },
  };

  if (shotDir !== undefined) {
    await page
      .screenshot({ path: join(shotDir, `${screen.id}.png`), fullPage: true })
      .catch(() => undefined);
  }
  return modes;
}

async function measureAll(
  origin: string,
  cookie: string,
  label: string,
): Promise<Record<string, Record<string, Record<string, Measured>>>> {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const url = new URL(origin);
  await context.addCookies([
    { name: "st_session", value: cookie, domain: url.hostname, path: "/" },
  ]);
  const page = await context.newPage();
  let shotDir: string | undefined;
  if (wantShots) {
    shotDir = join(OUT_DIR, "screenshots", "t03", label);
    mkdirSync(shotDir, { recursive: true });
  }
  const out: Record<string, Record<string, Record<string, Measured>>> = {};
  for (const screen of SCREENS) {
    out[screen.id] = await measureScreen(page, context, origin, screen, shotDir);
    console.error(`[t03-probe:${label}] ${screen.id}`);
  }
  await browser.close();
  return out;
}

const baseline = await measureAll(baseUrl, baseCookie, "baseline");
const hatch = await measureAll(hatchUrl, hatchCookie, "hatch");

/** 変化した計測点だけを拾う(値の対で残す)。 */
type Diff = { screen: string; mode: string; probe: string; prop: string; from: string; to: string };
const diffs: Diff[] = [];
for (const screenId of Object.keys(hatch)) {
  for (const mode of Object.keys(hatch[screenId] ?? {})) {
    const after = hatch[screenId]?.[mode] ?? {};
    const before = baseline[screenId]?.[mode] ?? {};
    for (const probe of Object.keys(after)) {
      const a = after[probe];
      const b = before[probe];
      if (a === undefined) continue;
      if (b === undefined || a.found !== b.found) {
        diffs.push({
          screen: screenId,
          mode,
          probe,
          prop: "#found",
          from: String(b?.found ?? "(未計測)"),
          to: String(a.found),
        });
        if (!a.found) continue;
      }
      for (const prop of Object.keys(a.css ?? {})) {
        const av = a.css?.[prop] ?? "";
        const bv = b?.css?.[prop] ?? "";
        if (av !== bv) {
          diffs.push({ screen: screenId, mode, probe, prop, from: bv, to: av });
        }
      }
      if (a.rect !== undefined && b?.rect !== undefined) {
        for (const k of ["x", "y", "w", "h"] as const) {
          const av = Math.round((a.rect[k] ?? 0) * 100) / 100;
          const bv = Math.round((b.rect[k] ?? 0) * 100) / 100;
          if (av !== bv) {
            diffs.push({
              screen: screenId,
              mode,
              probe,
              prop: `rect.${k}`,
              from: String(bv),
              to: String(av),
            });
          }
        }
      }
      if (a.text !== b?.text) {
        diffs.push({
          screen: screenId,
          mode,
          probe,
          prop: "#text",
          from: b?.text ?? "",
          to: a.text ?? "",
        });
      }
    }
  }
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  join(OUT_DIR, "t03-measurements.json"),
  `${JSON.stringify({ baselineUrl: baseUrl, hatchUrl, baseline, hatch }, null, 2)}\n`,
);
writeFileSync(
  join(OUT_DIR, "t03-diffs.json"),
  `${JSON.stringify({ count: diffs.length, diffs }, null, 2)}\n`,
);
console.error(`[t03-probe] 変化した計測点: ${diffs.length} 件`);
