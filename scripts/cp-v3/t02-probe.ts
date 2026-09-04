/**
 * V3-M7-T02 の実証スクリプト①(計測)。**テストではない。**
 *
 * ## なぜ `web/e2e/` の外に、`*.test.ts` / `*.spec.ts` 以外の名前で置くのか
 *
 * `docs/plan/v3/records/v3-m7.md` §2 の `V3-M7-T02` 完了条件7 が要求している。理由は2つ:
 *
 * - **`bun test` はリポジトリ全体の `*.test.ts` を拾う**(同 §0-1c (11))。本スクリプトは
 *   `ST_DATA_ROOT=data-m7-t02-live` で起動済みのサーバと、`.gitignore:4` の `data-` で始まる無視規則に
 *   載る複製データルートを前提にする。`*.test.ts` という名前で置くと実 CI の `checks` が
 *   必ず赤になる(複製はリポジトリに1バイトも入っていないため)。
 * - **playwright は `web/e2e/` 配下の `.e2e.ts` を拾う**(同 §0-1c (12))。`web/e2e/` 配下に
 *   置くと実 CI の `e2e` ジョブが同じ理由で赤になる。
 *
 * したがって置き場は `scripts/` 配下、名前は `t02-probe.ts` である(先例:
 * `scripts/cp5-screenshot.ts` — 同じく「テストではない採取スクリプト」)。
 *
 * ## 何を測るか
 *
 * **ローカルの本物 chromium の計算後スタイル**(`docs/plan/v3/records/v3-m7.md` §2 の
 * `V3-M7-T02` 完了条件6)。DOM に在るかどうかではなく、`getComputedStyle` が返す値と
 * `getBoundingClientRect` の実寸を記録する。テーマ/プリセットを当てる前(before)と
 * 後(after)で同じ計測を行い、**変わったか変わらなかったか**を要求90件の判定に使う。
 *
 * **スクリーンショットは参考資料であり判定に使わない**(同 §0-4 (8))。`--shots` を
 * 付けたときだけ撮る。
 *
 * ## 限界(隠さず書く)
 *
 * - **ローカルの chromium は macOS の chromium である**(同 §0-4 (2))。Linux の
 *   chromium と値が違いうる。「どの環境でも同じ見た目になる」ことは測っていない。
 * - **参照アプリの複製に対する計測である**(同 §0-4 (3))。ユーザが日常使っている
 *   `data-demo/` そのものは1バイトも読み書きしていない。
 *
 * 使い方:
 *   bun run scripts/cp-v3/t02-probe.ts <baseUrl> <sessionCookieValue> <label> <outDir> [--shots]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const [, , baseUrl, cookieValue, label, outDir, ...rest] = process.argv;
if (
  baseUrl === undefined ||
  cookieValue === undefined ||
  label === undefined ||
  outDir === undefined
) {
  throw new Error("usage: t02-probe.ts <baseUrl> <sessionCookieValue> <label> <outDir> [--shots]");
}
const wantShots = rest.includes("--shots");

/** 計測する CSS プロパティ(計算後の値)。要求90件のどれを見るときも同じ集合を取る。 */
const PROPS = [
  "color",
  "background-color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "text-align",
  "text-decoration-line",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "border-top-width",
  "border-bottom-width",
  "border-bottom-color",
  "border-bottom-style",
  "border-radius",
  "box-shadow",
  "outline-color",
  "outline-width",
  "outline-style",
  "max-width",
  "min-height",
  "width",
  "height",
  "display",
  "flex-direction",
  "flex-basis",
  "column-count",
  "column-gap",
  "row-gap",
  "gap",
  "table-layout",
  "grid-template-columns",
  "text-overflow",
  "white-space",
  "overflow-x",
  "overflow-y",
  "position",
  "cursor",
  "list-style-type",
  "opacity",
  "visibility",
] as const;

type ProbeSpec = {
  /** 記録上の名前。要求の判定からこの名前で引く。 */
  key: string;
  selector: string;
  /** 同じセレクタが複数当たるときの位置(既定 0)。 */
  index?: number;
};

type ScreenSpec = {
  id: string;
  path: string;
  /**
   * 単票の画面で開くレコードを、実行時に一覧 API から解決するためのテーブル名。
   * **決め打ちの `_id` を書かない** —— `order_admin` のような投影テーブルは
   * ワークフローが作り直すたびに `_id` が変わるので、before と after で同じ
   * 決め打ちの値が両方とも「存在しないレコード」になりうる(実際に1度そうなった)。
   */
  recordTable?: string;
  /** 描画の完了を待つためのセレクタ。 */
  waitFor?: string;
  probes: ProbeSpec[];
  /** ポインタを乗せた状態でもう1度測る対象(ホバーの計算後スタイル)。 */
  hover?: { key: string; selector: string; index?: number };
};

/** 一覧画面に共通の計測点。 */
function listProbes(extra: ProbeSpec[] = []): ProbeSpec[] {
  return [
    { key: "body", selector: "body" },
    { key: "app-theme", selector: ".app-theme" },
    { key: "shell", selector: ".shell" },
    { key: "app-header-h2", selector: ".app-header h2" },
    { key: "list-view", selector: ".list-view" },
    { key: "list-total", selector: ".list-total" },
    { key: "list-pager", selector: ".list-pager" },
    { key: "list-table", selector: ".list-table" },
    { key: "th-0", selector: ".list-table thead th", index: 0 },
    { key: "th-1", selector: ".list-table thead th", index: 1 },
    { key: "tr-0", selector: ".list-table tbody tr", index: 0 },
    { key: "td-0", selector: ".list-table tbody tr td", index: 0 },
    { key: "td-1", selector: ".list-table tbody tr td", index: 1 },
    { key: "td-2", selector: ".list-table tbody tr td", index: 2 },
    { key: "td-3", selector: ".list-table tbody tr td", index: 3 },
    { key: "td-4", selector: ".list-table tbody tr td", index: 4 },
    { key: "col-0", selector: ".list-table col", index: 0 },
    { key: "col-1", selector: ".list-table col", index: 1 },
    { key: "field-empty", selector: ".field-empty" },
    { key: "field-unresolved", selector: ".field-unresolved" },
    // **【`V10-M18-T02`(`FU-G2`)の注記。この計測点を1つも消していない】**
    // **今日この計測点は当たらない** —— `V10-M18-T02` が注記そのものを画面から出さなく
    // したので、`.list-detail-target-note` が付いた要素は DOM に1つも無い(CSS の規則は
    // 残っているが、当たり先が無い)。**当時の測定結果(`docs/evidence/cp-v3/` の JSON)は
    // 1バイトも書き換えていない** —— **あれは `V3-M7-T02` の時点の実測であり、今日の
    // 実物ではない。** **この行を残すのは、再実行したときに「当たらなくなったこと」
    // 自体が記録に出るようにするためである**(このスクリプトは合否を1つも判定しない)。
    { key: "detail-target-note", selector: ".list-detail-target-note" },
    { key: "link", selector: ".list-table a" },
    ...extra,
  ];
}

const SCREENS: ScreenSpec[] = [
  {
    id: "workspace",
    path: "/apps/ref-ec",
    waitFor: ".app-header",
    probes: [
      { key: "body", selector: "body" },
      { key: "app-theme", selector: ".app-theme" },
      { key: "shell", selector: ".shell" },
      { key: "shell-header", selector: ".shell header" },
      { key: "app-header", selector: ".app-header" },
      { key: "app-header-h2", selector: ".app-header h2" },
      { key: "current-user", selector: ".current-user" },
      { key: "nav-ul", selector: ".app-theme ul" },
      { key: "nav-li", selector: ".app-theme ul li" },
      { key: "nav-link", selector: ".app-theme ul li a" },
      { key: "button-0", selector: "button", index: 0 },
    ],
  },
  {
    id: "catalog-list",
    path: "/apps/ref-ec/views/catalog-list",
    waitFor: ".list-table",
    probes: listProbes(),
    hover: { key: "tr-0-hover", selector: ".list-table tbody tr", index: 0 },
  },
  {
    id: "variant-list",
    path: "/apps/ref-ec/views/variant-list",
    waitFor: ".list-table",
    probes: listProbes([
      { key: "td-5", selector: ".list-table tbody tr td", index: 5 },
      { key: "td-6", selector: ".list-table tbody tr td", index: 6 },
      { key: "field-number", selector: ".field-number" },
    ]),
  },
  {
    id: "category-list",
    path: "/apps/ref-ec/views/category-list",
    waitFor: ".list-table",
    probes: listProbes([{ key: "field-boolean", selector: ".field-boolean" }]),
  },
  {
    id: "admin-order-list",
    path: "/apps/ref-ec/views/admin-order-list",
    waitFor: ".list-table",
    probes: listProbes([{ key: "td-5", selector: ".list-table tbody tr td", index: 5 }]),
  },
  {
    id: "admin-order-line-list",
    path: "/apps/ref-ec/views/admin-order-line-list",
    waitFor: ".list-table",
    probes: listProbes(),
  },
  {
    id: "wf-run-list",
    path: "/apps/ref-ec/views/wf-run-list",
    waitFor: ".list-table",
    probes: listProbes([{ key: "field-long-text", selector: ".field-long-text" }]),
  },
  {
    id: "payment-event-list",
    path: "/apps/ref-ec/views/payment-event-list",
    waitFor: ".list-table",
    probes: listProbes(),
  },
  {
    id: "order-event-list",
    path: "/apps/ref-ec/views/order-event-list",
    waitFor: ".list-table",
    probes: listProbes(),
  },
  {
    id: "order-action-list",
    path: "/apps/ref-ec/views/order-action-list",
    waitFor: ".list-table",
    probes: listProbes(),
  },
  {
    id: "tax-rate-list",
    path: "/apps/ref-ec/views/tax-rate-list",
    waitFor: ".list-table",
    probes: listProbes(),
  },
  {
    id: "coupon-list",
    path: "/apps/ref-ec/views/coupon-list",
    waitFor: ".list-table",
    probes: listProbes(),
  },
  {
    id: "shipping-method-list",
    path: "/apps/ref-ec/views/shipping-method-list",
    waitFor: ".list-table",
    probes: listProbes(),
  },
  {
    id: "admin-unpaid-order-list",
    path: "/apps/ref-ec/views/admin-unpaid-order-list",
    waitFor: ".list-view",
    probes: listProbes(),
  },
  {
    id: "address-list",
    path: "/apps/ref-ec/views/address-list",
    waitFor: ".list-view",
    probes: [
      { key: "body", selector: "body" },
      { key: "app-theme", selector: ".app-theme" },
      { key: "list-view", selector: ".list-view" },
      { key: "list-view-p", selector: ".list-view p" },
      { key: "list-table", selector: ".list-table" },
      { key: "list-total", selector: ".list-total" },
      { key: "img", selector: ".list-view img" },
    ],
  },
  {
    id: "cart-totals-list",
    path: "/apps/ref-ec/views/cart-totals-list",
    waitFor: ".list-view",
    probes: [
      { key: "body", selector: "body" },
      { key: "app-theme", selector: ".app-theme" },
      { key: "list-view", selector: ".list-view" },
      { key: "list-view-p", selector: ".list-view p" },
      { key: "list-view-h2", selector: ".list-view h2" },
      { key: "list-table", selector: ".list-table" },
    ],
  },
  {
    id: "product-detail",
    path: "/apps/ref-ec/views/product-detail/records/",
    recordTable: "product",
    waitFor: ".detail-fields",
    probes: [
      { key: "body", selector: "body" },
      { key: "app-theme", selector: ".app-theme" },
      { key: "detail-view", selector: ".detail-view" },
      { key: "detail-fields", selector: ".detail-fields" },
      { key: "detail-field-0", selector: ".detail-field", index: 0 },
      { key: "detail-field-1", selector: ".detail-field", index: 1 },
      { key: "dt-0", selector: ".detail-field dt", index: 0 },
      { key: "dd-0", selector: ".detail-field dd", index: 0 },
      { key: "dd-1", selector: ".detail-field dd", index: 1 },
      { key: "field-long-text", selector: ".field-long-text" },
      { key: "field-empty", selector: ".field-empty" },
      { key: "field-image", selector: ".field-image" },
      { key: "field-boolean", selector: ".field-boolean" },
      { key: "detail-actions", selector: ".detail-actions" },
      { key: "detail-action-btn-0", selector: ".detail-actions button", index: 0 },
      { key: "detail-action-btn-1", selector: ".detail-actions button", index: 1 },
      { key: "related-list", selector: ".related-list" },
      { key: "related-heading", selector: ".related-heading" },
      { key: "related-table", selector: ".related-table" },
      { key: "related-th-0", selector: ".related-table th", index: 0 },
    ],
  },
  {
    id: "category-detail",
    path: "/apps/ref-ec/views/category-detail/records/",
    recordTable: "category",
    waitFor: ".detail-fields",
    probes: [
      { key: "detail-fields", selector: ".detail-fields" },
      { key: "detail-field-0", selector: ".detail-field", index: 0 },
      { key: "dt-0", selector: ".detail-field dt", index: 0 },
      { key: "related-table", selector: ".related-table" },
      { key: "related-th-0", selector: ".related-table th", index: 0 },
    ],
  },
  {
    id: "variant-detail",
    path: "/apps/ref-ec/views/variant-detail/records/",
    recordTable: "variant",
    waitFor: ".detail-fields",
    probes: [
      { key: "detail-fields", selector: ".detail-fields" },
      { key: "detail-field-0", selector: ".detail-field", index: 0 },
      { key: "dt-0", selector: ".detail-field dt", index: 0 },
      { key: "detail-actions", selector: ".detail-actions" },
      { key: "detail-action-btn-0", selector: ".detail-actions button", index: 0 },
      { key: "detail-action-btn-1", selector: ".detail-actions button", index: 1 },
      { key: "detail-action-btn-2", selector: ".detail-actions button", index: 2 },
      { key: "field-number", selector: ".field-number" },
    ],
  },
  {
    id: "admin-order-detail",
    path: "/apps/ref-ec/views/admin-order-detail/records/",
    recordTable: "order_admin",
    waitFor: ".detail-fields",
    probes: [
      { key: "detail-fields", selector: ".detail-fields" },
      { key: "detail-field-0", selector: ".detail-field", index: 0 },
      { key: "dt-0", selector: ".detail-field dt", index: 0 },
      { key: "dd-0", selector: ".detail-field dd", index: 0 },
      { key: "detail-actions", selector: ".detail-actions" },
    ],
  },
  {
    id: "cart-detail",
    path: "/apps/ref-ec/views/cart-detail",
    waitFor: ".app-theme",
    probes: [
      { key: "app-theme", selector: ".app-theme" },
      { key: "errors", selector: ".errors" },
      { key: "errors-li", selector: ".errors li" },
      { key: "hint", selector: ".hint" },
      // **【`V10-M18-T02`(`FU-G2`)の注記】** 上の一覧側と同じ理由で、**今日この計測点は
      // 当たらない**(注記を画面から出さなくした)。**計測点も当時の測定結果も1バイトも
      // 消していない。**
      { key: "detail-target-note", selector: ".detail-target-note" },
      { key: "p-0", selector: ".app-theme p", index: 0 },
    ],
  },
  {
    id: "order-form",
    path: "/apps/ref-ec/views/order-form",
    waitFor: ".record-form",
    probes: [
      { key: "app-theme", selector: ".app-theme" },
      { key: "record-form", selector: ".record-form" },
      { key: "field-0", selector: ".record-form .field", index: 0 },
      { key: "field-6", selector: ".record-form .field", index: 6 },
      { key: "label-0", selector: ".record-form label", index: 0 },
      { key: "required-0", selector: ".record-form .required", index: 0 },
      { key: "input-0", selector: ".record-form input", index: 0 },
      { key: "input-6", selector: ".record-form input", index: 6 },
      { key: "select-0", selector: ".record-form select", index: 0 },
      { key: "textarea-0", selector: ".record-form textarea", index: 0 },
      { key: "submit", selector: ".record-form button[type=submit]" },
      { key: "buttons", selector: ".record-form button" },
    ],
  },
  {
    id: "product-form",
    path: "/apps/ref-ec/views/product-form",
    waitFor: ".record-form",
    probes: [
      { key: "record-form", selector: ".record-form" },
      { key: "field-0", selector: ".record-form .field", index: 0 },
      { key: "label-0", selector: ".record-form label", index: 0 },
      { key: "textarea-0", selector: ".record-form textarea", index: 0 },
      { key: "input-file", selector: ".record-form input[type=file]" },
      { key: "input-checkbox", selector: ".record-form input[type=checkbox]" },
      { key: "submit", selector: ".record-form button[type=submit]" },
    ],
  },
  {
    id: "cart-form",
    path: "/apps/ref-ec/views/cart-form",
    waitFor: ".record-form",
    probes: [
      { key: "record-form", selector: ".record-form" },
      { key: "select-0", selector: ".record-form select", index: 0 },
      { key: "label-0", selector: ".record-form label", index: 0 },
    ],
  },
  {
    id: "cart-line-form",
    path: "/apps/ref-ec/views/cart-line-form",
    waitFor: ".record-form",
    probes: [
      { key: "record-form", selector: ".record-form" },
      { key: "select-0", selector: ".record-form select", index: 0 },
      { key: "select-1", selector: ".record-form select", index: 1 },
    ],
  },
  {
    id: "address-form",
    path: "/apps/ref-ec/views/address-form",
    waitFor: ".record-form",
    probes: [
      { key: "record-form", selector: ".record-form" },
      { key: "label-0", selector: ".record-form label", index: 0 },
      { key: "input-0", selector: ".record-form input", index: 0 },
    ],
  },
  {
    id: "category-form",
    path: "/apps/ref-ec/views/category-form",
    waitFor: ".record-form",
    probes: [
      { key: "record-form", selector: ".record-form" },
      { key: "label-0", selector: ".record-form label", index: 0 },
      { key: "input-0", selector: ".record-form input", index: 0 },
    ],
  },
];

type Measured = {
  found: boolean;
  count: number;
  tag?: string;
  className?: string;
  attrs?: Record<string, string>;
  text?: string;
  textLength?: number;
  rect?: { x: number; y: number; w: number; h: number };
  css?: Record<string, string>;
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const url = new URL(baseUrl);
await context.addCookies([
  { name: "st_session", value: cookieValue, domain: url.hostname, path: "/" },
]);
const page = await context.newPage();

const out: Record<string, Record<string, Measured>> = {};
const docTitles: Record<string, string> = {};
const domOrder: Record<string, string[]> = {};

const shotsDir = join(outDir, "screenshots", "t02", label);
if (wantShots) {
  mkdirSync(shotsDir, { recursive: true });
}

const resolvedPaths: Record<string, string> = {};

for (const screen of SCREENS) {
  let path = screen.path;
  if (screen.recordTable !== undefined) {
    const listUrl = `${baseUrl}/api/apps/ref-ec/tables/${screen.recordTable}/records?limit=1`;
    const response = await context.request.get(listUrl);
    const body = (await response.json()) as { records?: { _id?: string }[] };
    const first = (body.records ?? [])[0];
    if (first?._id === undefined) {
      throw new Error(`${screen.id}: ${screen.recordTable} に読めるレコードが1件も無い`);
    }
    path = `${screen.path}${first._id}`;
  }
  resolvedPaths[screen.id] = path;
  await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle" });
  if (screen.waitFor !== undefined) {
    await page
      .locator(screen.waitFor)
      .first()
      .waitFor({ timeout: 15_000 })
      .catch(() => undefined);
  }
  docTitles[screen.id] = await page.title();

  const measured = await page.evaluate(
    ({ probes, props }) => {
      const result: Record<string, Measured> = {};
      for (const probe of probes) {
        const nodes = document.querySelectorAll(probe.selector);
        const node = nodes[probe.index ?? 0];
        if (!(node instanceof Element)) {
          result[probe.key] = { found: false, count: nodes.length };
          continue;
        }
        const computed = window.getComputedStyle(node);
        const css: Record<string, string> = {};
        for (const prop of props) {
          css[prop] = computed.getPropertyValue(prop);
        }
        const rect = node.getBoundingClientRect();
        const attrs: Record<string, string> = {};
        for (const attr of Array.from(node.attributes)) {
          attrs[attr.name] = attr.value;
        }
        const text = node.textContent ?? "";
        result[probe.key] = {
          found: true,
          count: nodes.length,
          tag: node.tagName.toLowerCase(),
          className: node.getAttribute("class") ?? "",
          attrs,
          text: text.slice(0, 240),
          textLength: text.length,
          rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
          css,
        };
      }
      return result;
    },
    { probes: screen.probes, props: PROPS as unknown as string[] },
  );

  // 画面直下の要素の並び(件数表示・表・ページャの前後関係を機械的に残す)。
  domOrder[screen.id] = await page.evaluate(() => {
    const host = document.querySelector(".list-view") ?? document.querySelector(".app-theme");
    if (host === null) {
      return [];
    }
    return Array.from(host.children).map(
      (child) => `${child.tagName.toLowerCase()}.${child.getAttribute("class") ?? ""}`,
    );
  });

  if (screen.hover !== undefined) {
    const hover = screen.hover;
    const target = page.locator(hover.selector).nth(hover.index ?? 0);
    await target.hover().catch(() => undefined);
    const hovered = await page.evaluate(
      ({ selector, index, props }) => {
        const nodes = document.querySelectorAll(selector);
        const node = nodes[index];
        if (!(node instanceof Element)) {
          return { found: false, count: nodes.length } satisfies Measured;
        }
        const computed = window.getComputedStyle(node);
        const css: Record<string, string> = {};
        for (const prop of props) {
          css[prop] = computed.getPropertyValue(prop);
        }
        return { found: true, count: nodes.length, css } satisfies Measured;
      },
      { selector: hover.selector, index: hover.index ?? 0, props: PROPS as unknown as string[] },
    );
    measured[hover.key] = hovered;
    await page.mouse.move(0, 0);
  }

  out[screen.id] = measured;

  if (wantShots) {
    await page.screenshot({ path: join(shotsDir, `${screen.id}.png`), fullPage: true });
  }
  console.error(`[t02-probe:${label}] ${screen.id} done (${Object.keys(measured).length} probes)`);
}

await browser.close();

mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `t02-measurements-${label}.json`);
writeFileSync(
  outPath,
  `${JSON.stringify({ label, baseUrl, capturedAt: new Date().toISOString(), resolvedPaths, docTitles, domOrder, screens: out }, null, 2)}\n`,
);
console.error(`[t02-probe:${label}] wrote ${outPath}`);
