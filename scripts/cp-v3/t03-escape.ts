/**
 * V3-M7-T03 の実証スクリプト①(逃げ道の申請 → 発行 → 参照)。**テストではない。**
 *
 * ## なぜ `web/e2e/` の外に、`*.test.ts` / `*.spec.ts` 以外の名前で置くのか
 *
 * `docs/plan/v3/records/v3-m7.md` §2 の `V3-M7-T03` 完了条件7(= `V3-M7-T02` 完了条件7 と
 * 同じ制約)が要求している。理由は2つ:
 *
 * - **`bun test` はリポジトリ全体の `*.test.ts` を拾う**(同 §0-1c (11))。本スクリプトは
 *   `.gitignore:4` の無視規則に載る複製データルート(`data-m7-t03-live`)と、起動済みの
 *   Web サーバを前提にする。`*.test.ts` の名前で置けば実 CI の `checks` が必ず赤になる。
 * - **playwright は `web/e2e/` 配下の `.e2e.ts` を拾う**(同 §0-1c (12))。同じ理由で
 *   `web/e2e/` にも置けない。
 *
 * ## 何をするか(3手。ADR-0055 の4層をそのままなぞる)
 *
 * 1. **AI の申請** —— MCP の `request_custom_css` を呼ぶ。**AI はここまでしかできない**
 *    (ADR-0055 §1 の表。CSS の本文を渡す引数が無い)。
 * 2. **owner の発行** —— `POST /api/apps/:app_id/escape-hatch-assets` に owner の
 *    セッション cookie を付けて、**名前 / CSS 本文 / 作用域(scopeViews)** を渡す。
 *    **これが CSS のバイト列を置ける唯一の経路である**(`src/server/auth-routes.ts:1161`
 *    の逐語「**この POST /escape-hatch-assets だけ**で、MCP ツール / apply_diff / HTTP の
 *    データ経路からは1本も到達しない」)。
 * 3. **AI が参照を書く** —— MCP の `apply_diff` の `update_view` に `custom_css`
 *    (資産名 + sha256)を書く。**本文は1バイトも書けない。**
 *
 * ## 1画面に書ける逃げ道は1つだけである(実装の帰結。ここが束ね方を決めている)
 *
 * `$defs/view.custom_css` は**1キー**であり、配列ではない。したがって1つの画面に
 * 2つの資産を当てることはできない。**画面ごとに「その画面に要るもの全部」を1本の
 * CSS に束ねるしかない。** 本スクリプトの `bundleFor()` はその束ね方そのものである。
 *
 * 使い方:
 *   bun run scripts/cp-v3/t03-escape.ts <dataRoot> <baseUrl> <ownerCookieValue> <outDir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../src/mcp/server.ts";

const [, , dataRoot, baseUrl, ownerCookie, outDir, rawLabel] = process.argv;
if (
  dataRoot === undefined ||
  baseUrl === undefined ||
  ownerCookie === undefined ||
  outDir === undefined
) {
  throw new Error("usage: t03-escape.ts <dataRoot> <baseUrl> <ownerCookieValue> <outDir> [label]");
}
/** 版の名前。**資産名は版をまたいで同じにする**(同じ名前で内容だけが違う = 別の版)。 */
const LABEL = rawLabel ?? "v1";

const APP_ID = "ref-ec";

/* ------------------------------------------------------------------------------------------- *
 * CSS の断片。**どの要求(M7-RXX)に向けて書いたか**をコメントで1つずつ名指しする。
 * 本文は `.app-theme { … }` の入れ子に包まれて配信される(`web/src/views/ViewHost.tsx:170`)。
 * したがってここに書く選択子は `.app-theme` の子孫に解決される。
 * ------------------------------------------------------------------------------------------- */

/** すべての束に入る共通部分(シェルまわり)。 */
const COMMON = `
/* M7-R01 店の名前の見出しを1行のまま読ませる */
.app-header h2 { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 2rem; }

/* M7-R03 店のロゴを画面の左上に置く(データURIの図像を疑似要素で足す) */
.app-header h2::before {
  content: "";
  display: inline-block;
  width: 32px; height: 32px; margin-right: 10px; vertical-align: -7px;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='16' cy='16' r='15' fill='%238f2320'/><text x='16' y='23' font-size='17' font-family='serif' text-anchor='middle' fill='%23fdfaf5'>S</text></svg>");
  background-size: contain; background-repeat: no-repeat;
}

/* M7-R04 画面への入口はふだんたたんでおき、ポインタを乗せたときだけ開く */
.view-list ul { display: none; }
.view-list:hover ul, .view-list:focus-within ul { display: block; }
.view-list::before {
  content: "画面をさがす";
  display: block; font-weight: 700; padding: 6px 8px;
  border: 1px solid #b9ab93; border-radius: 6px; background-color: #f3e7d3;
}

/* M7-R05 入口の並びをまとまりに分けて見出しを付ける(並びの位置で区切る) */
.view-list ul li:nth-child(1)::before { content: "商品まわり"; display: block; font-weight: 700; font-size: 0.8rem; color: #6d6152; margin-top: 8px; }
.view-list ul li:nth-child(12)::before { content: "注文まわり"; display: block; font-weight: 700; font-size: 0.8rem; color: #6d6152; margin-top: 12px; }
.view-list ul li:nth-child(25)::before { content: "運営まわり"; display: block; font-weight: 700; font-size: 0.8rem; color: #6d6152; margin-top: 12px; }

/* M7-R07 入口を本文の横の縦帯へ移し、本文を画面の上から見せる */
.view-list { position: fixed; left: 12px; top: 96px; width: 190px; max-height: 70vh; overflow: auto; z-index: 2; }
.workspace-links { position: fixed; left: 12px; bottom: 16px; width: 190px; z-index: 1; }
& > section { padding-left: 214px; }

/* M7-R08 運営者だけのボタン群を控えめに */
.app-header button {
  font-size: 0.75rem; background-color: transparent; color: #6d6152;
  border: 1px solid #cbbda3; border-radius: 4px; padding: 2px 6px; opacity: 0.8;
}

/* M7-R09 画面の中のリンクを店の色に */
a { color: #8f2320; text-decoration-line: none; }
a:hover { text-decoration-line: underline; }

/* M7-R10 見出し・本文・注記の大きさにめりはりを付ける */
h3 { font-size: 1.4rem; }
.list-total, .meta { font-size: 0.8rem; }

/* M7-R17 画面のいちばん下に店の連絡先と取引の案内の帯を置く */
& > section::after {
  content: "お問い合わせ: support@example.com / 平日10:00-17:00 ・ 返品は到着後7日以内 ・ 特定商取引法に基づく表記";
  display: block; clear: both; margin-top: 40px; padding: 16px 20px;
  background-color: #efe6d6; color: #4a4a4a; font-size: 0.8rem; border-top: 2px solid #b9ab93;
}

/* M7-R88 状態が変わったときに色がゆっくり変わる動き */
.list-table td, .list-row, button, a { transition: background-color 0.45s ease, color 0.45s ease; }

/* M7-R15 夜に見るときは暗い地に明るい文字で */
@media (prefers-color-scheme: dark) {
  & { background-color: #14110d; color: #f2ece3; }
  .list-table td, .list-table th, .app-header h2, h3, dt, dd { color: #f2ece3; }
  .list-table td, .list-table th { border-color: #4a4238; }
  a { color: #e8b4a0; }
}

/* M7-R86 幅の狭い端末でも表がはみ出さずに読める */
@media (max-width: 700px) {
  & > section { padding-left: 0; }
  .view-list, .workspace-links { position: static; width: auto; max-height: none; }
  .list-table { display: block; overflow-x: auto; }
}
`;

/** 一覧の画面に入る共通部分。 */
const LIST_COMMON = `
/* M7-R18 表の見出しの行に地色を敷く */
.list-table thead th { background-color: #efe1c8; }

/* M7-R19 1行おきに薄い地色を敷く */
.list-table tbody tr:nth-child(even) { background-color: #faf4ea; }

/* M7-R24 中身の無い欄の「未設定」を薄く小さく */
.field-empty { color: #bdb5a8; font-size: 0.75rem; }
`;

/** 画面ごとの上乗せ。**キーは画面ID。** */
const SPECIFIC: Record<string, string> = {
  "catalog-list": `
/* M7-R06 いま開いている画面を入口の並びの中で目立たせる(この画面だけに効く指定) */
.view-list a[href$="/views/catalog-list"] {
  display: block; font-weight: 700; color: #1a1a1a;
  background-color: #f3e7d3; border-left: 4px solid #8f2320; padding: 2px 6px;
}

/* M7-R11 本文が画面の左半分に寄るのを直す。
   **これは ADR-0055 §限界2 が予告した「決意した書き手は外へ出られる」形そのものである** ——
   .app-theme の外側にある .shell を :root:has(&) で捕まえている。限定13(逃げ道は
   .app-theme の内側に閉じる)が「既定の書き方では漏れない」までしか保証していないことの実測。 */
:root:has(&) .shell { max-width: none; width: auto; }

/* M7-R21 写真の欄に写真の入る枠を出す(値が未設定のときの升目)。
   **文字を消さない** —— 消すと同じ升目を名指しした M7-R24(「未設定」を薄く小さく)が
   同じ画面で観測できなくなる。1画面に当てられる逃げ道は1つだけなので、2つの要求は
   1本の CSS の中で両立させるしかない。 */
.list-table td[data-field="image"] .field-empty {
  display: inline-block; width: 72px; height: 72px;
  border: 2px dashed #b9ab93; border-radius: 6px; background-color: #f7f1e6;
}
`,
  "variant-list": `
/* M7-R27 金額に円の単位を添える */
.list-table td[data-field="price"]::after { content: "円"; margin-left: 2px; font-size: 0.8em; color: #5b5b5b; }
`,
  "admin-order-list": `
/* M7-R32 注文の状態を色の付いた小さな札の形で出す */
.list-table td[data-field="status"] > span {
  display: inline-block; padding: 2px 10px; border-radius: 12px;
  background-color: #f3e7d3; border: 1px solid #b9ab93; font-size: 0.85rem;
}

/* M7-R35 合計の金額の欄を太字にして強く見せる */
.list-table td[data-field="total"] { font-weight: 700; font-size: 1.05rem; }

/* M7-R36 件数の案内を画面の見出しの横に大きく出す */
.list-view { position: relative; }
.list-view > .list-total:first-child {
  position: absolute; top: -2.6rem; left: 14rem; margin: 0;
  font-size: 1.5rem; font-weight: 700; color: #8f2320;
}
`,
  "admin-order-line-list": `
/* M7-R37 内部の識別子の欄を画面から隠す(2列目) */
.list-table col:nth-child(2), .list-table th:nth-child(2), .list-table td:nth-child(2) { display: none; }
`,
  "admin-unpaid-order-list": `
/* M7-R45 注意を促す画面なので地の色を他の一覧と変える */
& { background-color: #fdf0ee; }
`,
  "address-list": `
/* M7-R39 1件も無いときにさし絵を添える */
.list-view p[data-testid="list-empty"]::before {
  content: ""; display: block; width: 132px; height: 132px; margin: 8px auto 12px;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect x='6' y='18' width='52' height='34' rx='4' fill='%23f3e7d3' stroke='%23b9ab93' stroke-width='2'/><path d='M6 22 L32 40 L58 22' fill='none' stroke='%23b9ab93' stroke-width='2'/></svg>");
  background-size: contain; background-repeat: no-repeat;
}

/* M7-R38 1件も無いときに次にすることを添える */
.list-view p[data-testid="list-empty"]::after {
  content: "まだお届け先がありません。左の「お届け先の登録・編集」から1件目を登録してください。";
  display: block; margin-top: 10px; font-size: 0.95rem; color: #4a4a4a;
}
`,
  "cart-totals-list": `
/* M7-R46 この画面が何を出す画面なのかを画面の上で説明する */
.list-view::before {
  content: "この画面はカートごとの小計・割引・送料・消費税・合計を出します。カートを作ると1行ずつ現れます。";
  display: block; margin-bottom: 12px; padding: 12px 16px;
  background-color: #f3e7d3; border-left: 4px solid #b9ab93; color: #4a4a4a; font-size: 0.95rem;
}
`,
  "product-detail": `
/* M7-R57 まとまりごとに区切って見出しを付ける */
.detail-field:has(> dd[data-field="name"])::before {
  content: "基本の情報"; display: block; width: 100%; order: -1;
  font-weight: 700; color: #6d6152; border-top: 2px solid #b9ab93; margin: 4px 0 6px; padding-top: 8px;
}
.detail-field:has(> dd[data-field="status"])::before {
  content: "公開の設定"; display: block; width: 100%; order: -1;
  font-weight: 700; color: #6d6152; border-top: 2px solid #b9ab93; margin: 16px 0 6px; padding-top: 8px;
}

/* M7-R60 「削除」だけを危ないと分かる見た目に */
.detail-actions button[data-testid="detail-delete"] {
  background-color: #8f2320; color: #fdfaf5; border: 1px solid #6d1a18; font-weight: 700;
}
`,
  "variant-detail": `
/* M7-R67 「カートに入れる」をいちばん目立つボタンに */
button[data-testid="action-origin-cart-line-form"] {
  background-color: #8f2320; color: #fdfaf5; border: 1px solid #6d1a18;
  font-size: 1.15rem; font-weight: 700; padding: 10px 22px;
}
`,
  "admin-order-detail": `
/* M7-R62 画面の先頭の内部の識別子を見せない */
.detail-field:has(> dd[data-field="order_id"]) { display: none; }

/* M7-R63 金額の5項目を伝票のようにまとめ、合計だけを強く出す */
.detail-field:has(> dd[data-field="subtotal"]),
.detail-field:has(> dd[data-field="discount"]),
.detail-field:has(> dd[data-field="shipping_fee"]),
.detail-field:has(> dd[data-field="tax"]) {
  background-color: #f7f2e8; border-top: 1px dotted #b9ab93;
}
.detail-field:has(> dd[data-field="total"]) { background-color: #f3e7d3; border-top: 2px solid #8f2320; }
.detail-field:has(> dd[data-field="total"]) dd { font-weight: 700; font-size: 1.5rem; color: #8f2320; }

/* M7-R64 注文の状態と決済の状態を画面のいちばん上の帯に大きく出す */
.detail-field:has(> dd[data-field="status"]),
.detail-field:has(> dd[data-field="payment_status"]) {
  order: -1; background-color: #f3e7d3; border: 1px solid #b9ab93; padding: 8px 12px;
}
.detail-field:has(> dd[data-field="status"]) dd,
.detail-field:has(> dd[data-field="payment_status"]) dd { font-size: 1.3rem; font-weight: 700; }

/* M7-R65 印刷したときに納品書として使える体裁に */
@media print {
  .app-header, .view-list, .workspace-links, .detail-actions, .detail-action-origins { display: none; }
  & { background-color: #ffffff; }
  & > section { padding-left: 0; }
  .detail-fields { display: block; }
  .detail-view::before { content: "納品書"; display: block; font-size: 1.6rem; font-weight: 700; margin-bottom: 12px; }
}
`,
  "cart-detail": `
/* M7-R85 案内をただの説明として落ち着いた見た目に */
.errors { background-color: #f5f1e8; border-left: 4px solid #b9ab93; padding: 12px 16px; }
.errors li { color: #4a4a4a; }
.errors .hint { color: #5b5b5b; }
`,
  "order-form": `
/* M7-R69 18項目を2つの段に分けて縦を短くする */
.record-form { display: grid; grid-template-columns: 1fr 1fr; column-gap: 28px; }
.record-form button[type="submit"] { grid-column: 1 / -1; }

/* M7-R70 入力の欄の幅を中身に合った幅にする */
.record-form input { box-sizing: border-box; width: 100%; }
.record-form .field:has(> label[data-testid="field-label-currency"]) input { width: 6rem; }
.record-form .field:has(> label[data-testid="field-label-placed_at"]) input { width: 12rem; }

/* M7-R71 項目をまとまりに分けて見出しを付ける */
.record-form .field:has(> label[data-testid="field-label-order_number"])::before {
  content: "注文者"; display: block; font-weight: 700; color: #6d6152;
  border-top: 2px solid #b9ab93; margin-bottom: 6px; padding-top: 8px;
}
.record-form .field:has(> label[data-testid="field-label-ship_to"])::before {
  content: "お届け先"; display: block; font-weight: 700; color: #6d6152;
  border-top: 2px solid #b9ab93; margin-bottom: 6px; padding-top: 8px;
}
.record-form .field:has(> label[data-testid="field-label-subtotal"])::before {
  content: "金額"; display: block; font-weight: 700; color: #6d6152;
  border-top: 2px solid #b9ab93; margin-bottom: 6px; padding-top: 8px;
}
.record-form .field:has(> label[data-testid="field-label-status"])::before {
  content: "状態"; display: block; font-weight: 700; color: #6d6152;
  border-top: 2px solid #b9ab93; margin-bottom: 6px; padding-top: 8px;
}

/* M7-R72 「必須」の印をはっきり示す */
.record-form .required {
  font-size: 0.95rem; background-color: #8f2320; color: #fdfaf5;
  padding: 1px 10px; border-radius: 10px; margin-left: 8px;
}

/* M7-R73 金額の入力の欄に円の単位を添える */
.record-form .field:has(> label[data-testid="field-label-subtotal"])::after,
.record-form .field:has(> label[data-testid="field-label-total"])::after {
  content: "円"; display: inline-block; margin-left: 6px; color: #5b5b5b;
}

/* M7-R75 保存のボタンを大きくして画面の下に貼り付ける */
.record-form button[type="submit"] {
  position: sticky; bottom: 0; width: 100%;
  font-size: 1.2rem; padding: 12px 0; background-color: #8f2320; color: #fdfaf5; border: none;
}
`,
  "product-form": `
/* M7-R81 長い文を入れる欄を大きく取る */
.record-form textarea { min-height: 12rem; }

/* M7-R83 はい・いいえの四角を大きくして横に言葉を添える */
.record-form input[type="checkbox"] { width: 24px; height: 24px; }
.record-form .field:has(input[type="checkbox"])::after {
  content: "チェックを入れると店頭に公開されます";
  display: block; font-size: 0.8rem; color: #5b5b5b; margin-top: 4px;
}
`,
  "cart-form": `
/* M7-R78 選ぶ欄の幅を確保し、選べるものが無いことを伝える */
.record-form select { min-width: 16rem; }
.record-form .field:has(> select > option:only-child)::after {
  content: "選べるものがありません(先に顧客を登録してください)";
  display: block; color: #8f2320; font-size: 0.85rem; margin-top: 4px;
}
`,
  "address-form": `
/* M7-R79 郵便番号や都道府県に入力の例を添える */
.record-form .field:has(> label[data-testid="field-label-postal_code"])::after {
  content: "例: 150-0001"; display: block; font-size: 0.8rem; color: #5b5b5b; margin-top: 2px;
}
.record-form .field:has(> label[data-testid="field-label-prefecture"])::after {
  content: "例: 東京都"; display: block; font-size: 0.8rem; color: #5b5b5b; margin-top: 2px;
}
`,
  "category-form": `
/* M7-R80 何を入れる欄なのかの短い説明を項目名の下に添える */
.record-form label[data-testid="field-label-slug"]::after {
  content: "URL に使う短い英字の名前です(例: shirts)";
  display: block; font-size: 0.8rem; font-weight: 400; color: #5b5b5b; margin-top: 2px;
}
`,
};

/** 画面の種別(束の共通部分を決める)。 */
const LIST_VIEWS = [
  "catalog-list",
  "variant-list",
  "category-list",
  "admin-order-list",
  "admin-order-line-list",
  "admin-unpaid-order-list",
  "address-list",
  "cart-totals-list",
  "wf-run-list",
  "payment-event-list",
  "order-event-list",
  "order-action-list",
  "tax-rate-list",
  "coupon-list",
  "shipping-method-list",
];
const DETAIL_VIEWS = [
  "product-detail",
  "category-detail",
  "variant-detail",
  "admin-order-detail",
  "cart-detail",
];
const FORM_VIEWS = [
  "order-form",
  "product-form",
  "cart-form",
  "cart-line-form",
  "address-form",
  "category-form",
];

const TARGET_VIEWS = [...LIST_VIEWS, ...DETAIL_VIEWS, ...FORM_VIEWS];

function bundleFor(viewId: string): string {
  const kind = LIST_VIEWS.includes(viewId) ? LIST_COMMON : "";
  return `${COMMON}${kind}${SPECIFIC[viewId] ?? ""}`.trim();
}

/* ------------------------------------------------------------------------------------------- *
 * 同じ本文になった画面は1つの資産を共有する(content-addressed なので本体も de-dup される)。
 * ------------------------------------------------------------------------------------------- */
const byBody = new Map<string, string[]>();
for (const viewId of TARGET_VIEWS) {
  const body = bundleFor(viewId);
  const list = byBody.get(body) ?? [];
  list.push(viewId);
  byBody.set(body, list);
}

type Plan = { name: string; css: string; scopeViews: string[] };
const plans: Plan[] = [];
for (const [css, views] of byBody) {
  // 名前は「その束を必要とした画面」から作る。共有された束は共有であることが名前で分かる形にする。
  const name = views.length === 1 ? `screen-${views[0]}` : `shared-${views.length}-screens`;
  plans.push({ name, css, scopeViews: views });
}
// 共有束が複数できた場合に名前が衝突しないよう連番を振る。
const seen = new Map<string, number>();
for (const plan of plans) {
  const n = (seen.get(plan.name) ?? 0) + 1;
  seen.set(plan.name, n);
  if (n > 1) {
    plan.name = `${plan.name}-${n}`;
  }
}

/* ------------------------------------------------------------------------------------------- *
 * 手1: AI の申請(MCP)。
 * ------------------------------------------------------------------------------------------- */
const server = createMcpServer({ dataRoot, previewBaseUrl: baseUrl });
const client = new Client({ name: "v3-m7-t03-escape", version: "0.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

const callLog: { tool: string; summary: string }[] = [];
async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  const data = (result.structuredContent ?? {}) as Record<string, unknown>;
  if (result.isError === true) {
    throw new Error(`${name} が失敗した: ${JSON.stringify(data)}`);
  }
  callLog.push({ tool: name, summary: JSON.stringify(args).slice(0, 200) });
  return data;
}

const issued: {
  name: string;
  digest: string;
  scopeViews: string[];
  bytes: number;
  requestId: string;
}[] = [];

for (const plan of plans) {
  // --- 手1: AI は「申請」しかできない(CSS の本文を渡す引数が無い) ---
  const requested = (await call("request_custom_css", {
    app_id: APP_ID,
    name: plan.name,
    purpose:
      "有限のプリセットとテーマのスロットでは当て先が無かった見た目の要求を、この画面にまとめて当てたい",
    views: plan.scopeViews,
  })) as { request_id?: string; requestId?: string };
  const requestId = requested.request_id ?? requested.requestId ?? "";

  // --- 手2: owner が発行する(CSS のバイト列を置ける唯一の経路) ---
  const response = await fetch(`${baseUrl}/api/apps/${APP_ID}/escape-hatch-assets`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `st_session=${ownerCookie}`,
      Origin: baseUrl,
    },
    body: JSON.stringify({
      name: plan.name,
      css: plan.css,
      scopeViews: plan.scopeViews,
      ...(requestId === "" ? {} : { requestId }),
    }),
  });
  const body = (await response.json()) as {
    asset?: { name: string; digest: string; scopeViews: string[] };
    errors?: unknown;
  };
  if (response.status !== 200 || body.asset === undefined) {
    throw new Error(`発行に失敗した(${plan.name}): ${response.status} ${JSON.stringify(body)}`);
  }
  issued.push({
    name: body.asset.name,
    digest: body.asset.digest,
    scopeViews: body.asset.scopeViews,
    bytes: new TextEncoder().encode(plan.css).length,
    requestId,
  });
  console.error(
    `[t03-escape] 発行: ${body.asset.name} digest=${body.asset.digest.slice(0, 12)}… scope=${body.asset.scopeViews.length}画面 ${new TextEncoder().encode(plan.css).length}バイト`,
  );
}

/* ------------------------------------------------------------------------------------------- *
 * 手3: AI が参照を書く(update_view の custom_css。本文は1バイトも書けない)。
 * ------------------------------------------------------------------------------------------- */
const operations = issued.flatMap((asset) =>
  asset.scopeViews.map((viewId) => ({
    op: "update_view" as const,
    view: viewId,
    changes: { custom_css: { asset: asset.name, digest: asset.digest } },
  })),
);

await call("apply_diff", {
  app_id: APP_ID,
  diff: {
    diff_id: `m7-t03-escape-${LABEL}`,
    intent:
      "プリセットとテーマでは当て先が無かった見た目の要求に応えたい、という要望に対して owner が発行した逃げ道の資産を画面ごとに当てた",
    operations,
  },
});

const finalManifest = await call("get_manifest", { app_id: APP_ID });

await client.close();
await server.close();

mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, `t03-manifest-after-${LABEL}.json`),
  `${JSON.stringify(finalManifest.manifest, null, 2)}\n`,
);
writeFileSync(
  join(outDir, `t03-assets-${LABEL}.json`),
  `${JSON.stringify(
    {
      dataRoot,
      baseUrl,
      assetCount: issued.length,
      referenceCount: operations.length,
      assets: issued,
      callLog,
    },
    null,
    2,
  )}\n`,
);

console.error(
  `[t03-escape] 資産 ${issued.length} 件 / 参照 ${operations.length} 件 / MCP 呼び出し ${callLog.length} 回`,
);
