/**
 * 一覧の形を画面ごとに選ぶ8つ目のプリセットキー —— **表示層**(`V4-M16-T13` / `ADR-0093`)。
 *
 * **限定表の正は [`docs/adr/0093-list-view-shape.md`](../../docs/adr/0093-list-view-shape.md) §Decision 2(限定1〜限定10)**、
 * 完了条件の正は `docs/plan/v4/records/v4-m16.md` §2-3 の `V4-M16-T13` 節(10点)。
 *
 * **門A の判定 = 限定採用**(審査記録 = `docs/plan/v4/records/v4-m14-gate-a-list-shape.md`)。
 *
 * ## 【前提】器を作ったのは本タスクである
 *
 * **`ADR-0093` は「器(カードの CSS 規則とレンダラーの分岐)は `V4-M15-T15` が作る」と
 * 書いている**(限定6 / §Consequences)。**しかし `docs/plan/v4/records/v4-m15-t19.md` §T15 の 3 は
 * 「器を作っていない」と申告している。** **したがって宣言と器を同じ差分で作ったのは本タスクである。**
 * **【禁止】「`V4-M15` が器を作った」と書かない。**
 *
 * ## このファイルが固定すること(表示層)
 *
 * | # | 限定 | 検査 |
 * |---|---|---|
 * | (d) | **限定4** 既定は `table`。書かなかった画面は今日と1ピクセルも変わらない | 着手前の DOM を採った fixture と**完全一致**。`"table"` と明示しても同じ DOM |
 * | (e) | **限定6** 当たり先(実際に描画を変える CSS 規則)が `card` について実在する | 配られる CSS の集合(`style-source-set.ts` の `STYLE_SOURCES`)に規則が在る |
 * | (f) | **限定5** 座標系9プロパティを1つも使わない | 手で書く CSS の全量を読む |
 * | (g) | **限定7** `related` の子一覧には当たらない | **当たり方の表**を検査で固定する |
 * | (i) | **限定9** マニフェストの値からクラス名を生やさない | レンダラーのソースと構成ファイル |
 * | (k) | 器そのもの | `card` の DOM を1件ずつ実測する |
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * 1. **ブラウザの計算値を1つも測っていない。** happy-dom は CSS を解決しない ——
 *    測っているのは「DOM がこう出る」と「その DOM に当たる規則のテキストが在る」の2辺だけである。
 * 2. **カードが「見やすい」ことを1件も測っていない。**
 * 3. **支援技術で使えるかを1本も測っていない。**
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import type { DetailView, ListView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";
import { HANDWRITTEN_SOURCES, readStyleSource, WEB_SRC_DIR } from "./style-source-set.ts";

const REPO_ROOT = dirname(dirname(import.meta.dir));
const LIST_RENDERER_PATH = join(WEB_SRC_DIR, "views", "ListViewRenderer.tsx");
const DETAIL_RENDERER_PATH = join(WEB_SRC_DIR, "views", "DetailViewRenderer.tsx");
const PLAIN_LIST_HTML = readFileSync(
  join(import.meta.dir, "__fixtures__", "list-view-plain.html"),
  "utf-8",
).trim();

/** 手で書く側の CSS の全量(`ADR-0088` 限定2 / 限定5)。 */
const handwrittenCss = HANDWRITTEN_SOURCES.map(readStyleSource).join("\n");

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

// ---------------------------------------------------------------------------
// フィクスチャ(**`__fixtures__/list-view-plain.html` を採ったものと同一**)
// ---------------------------------------------------------------------------

const APP_ID = "shape-app";

/**
 * 一覧を描くときに名乗るロール(`V4-M19-T10` の追記)。**定数にしてあるのは、
 * `<RoleProvider role="owner">` と文字列で書くと biome の `useValidAriaRole` が
 * `role` を ARIA 属性と読んで赤にするためである。**
 */
const OWNER_ROLE: Role = "owner";
const RECORD_A = "rec-a";
const RECORD_B = "rec-b";

function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "形のサンプル",
      tables: [
        {
          id: "items",
          name: "備品",
          fields: [
            { id: "name", name: "備品名", type: "text" },
            { id: "quantity", name: "数量", type: "number" },
            { id: "vendor", name: "仕入先", type: "reference", reference_table: "vendors" },
          ],
        },
        {
          id: "vendors",
          name: "仕入先",
          fields: [{ id: "vendor_name", name: "名称", type: "text" }],
        },
      ],
      views: [
        {
          id: "item-list",
          type: "list_view",
          table: "items",
          columns: ["name", "quantity", "vendor"],
        },
        { id: "item-detail", type: "detail_view", table: "items" },
        { id: "vendor-detail", type: "detail_view", table: "vendors" },
      ],
    },
  };
}

function listWith(presets: Partial<ListView>): Manifest {
  const manifest = baseManifest();
  Object.assign(manifest.app.views[0] as ListView, presets);
  return manifest;
}

const ITEM_ROWS = [
  {
    _id: RECORD_A,
    _created_at: "",
    _updated_at: "",
    name: "会議テーブル",
    quantity: 3,
    vendor: "vendor-1",
  },
  { _id: RECORD_B, _created_at: "", _updated_at: "", name: "椅子", quantity: 12, vendor: null },
];

const VENDOR_ROWS = [
  { _id: "vendor-1", _created_at: "", _updated_at: "", vendor_name: "山田商会" },
];

const NOTE_ROWS = [
  { _id: "note-1", _created_at: "", _updated_at: "", body: "めも", item: RECORD_A },
];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes(`/tables/items/records/${RECORD_A}`)) {
      return jsonResponse({ record: ITEM_ROWS[0] });
    }
    if (url.includes("/tables/items/records")) {
      return jsonResponse({ records: ITEM_ROWS, total: ITEM_ROWS.length });
    }
    if (url.includes("/tables/vendors/records")) {
      return jsonResponse({ records: VENDOR_ROWS, total: VENDOR_ROWS.length });
    }
    if (url.includes("/tables/notes/records")) {
      return jsonResponse({ records: NOTE_ROWS, total: NOTE_ROWS.length });
    }
    return jsonResponse({ records: [], total: 0 });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

async function renderList(manifest: Manifest = baseManifest()): Promise<HTMLElement> {
  // **【`V4-M19-T10` の追記。既存の行を1バイトも消していない】**
  // **`RoleProvider role="owner"` で包むようになった** —— `V4-M19-T10` が CSV の書き出し口を
  // 「買い物客と未ログインには出さない」に絞ったので、**包まずに描くと `useRole()` が `null` を
  // 返して口が消え、(d) のフィクスチャ完全一致が「口が無い DOM」になる。**
  // **フィクスチャが表しているのは「運営が見ている素の一覧」である。**
  // **包んでも DOM に要素は1つも増えない**(`RoleProvider` はコンテキストだけである)ので、
  // **(d) が見ている「着手前の DOM そのもの」という性質は変わらない。**
  // 先例は `V4-M2-T06` が `form.test.tsx` / `detail-view.test.tsx` を包んだ形である。
  render(
    <RoleProvider role={OWNER_ROLE}>
      {createElement(ListViewRenderer, {
        appId: APP_ID,
        manifest,
        view: manifest.app.views[0] as ListView,
      })}
    </RoleProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("view-renderer-list_view")).toBeDefined());
  await waitFor(() =>
    expect(screen.queryByTestId("list-table") ?? screen.queryByTestId("list-cards")).not.toBeNull(),
  );
  return screen.getByTestId("view-renderer-list_view");
}

/** `.list-view` の直下の並び(件数表示とページャの位置の固定と同じ読み方)。 */
function sectionOrder(section: HTMLElement): string[] {
  return [...section.children].map(
    (child) => child.getAttribute("data-testid") ?? child.tagName.toLowerCase(),
  );
}

// ---------------------------------------------------------------------------
// (d) 限定4: 書かなかった画面は今日と1ピクセルも変わらない
// ---------------------------------------------------------------------------

test("(d) 限定4: preset_list_shape を書かない一覧の DOM が着手前と完全一致する", async () => {
  const section = await renderList();
  // **完全一致**(属性1つ・器1つの追加も赤になる)。基準は本タスクの着手時に、
  // **実装を1バイトも入れる前に**同じフィクスチャで採った実物である。
  /*
   * **【V4-M20-T03 でフィクスチャを1度だけ採り直した。隠さない】**
   *
   * **単位C の送り先(表示層だけの一括操作)が `.list-view` の直下に入口のボタンを
   * 1つ足したので、この基準は「V4-M16-T13 の着手前の DOM」ではなくなった。**
   * **表すものが1段変わっている** —— **今日の基準は「運営(owner)が見ている素の一覧」で
   * ある**(`V4-M19-T06` / `V4-M19-T10` が同じフィクスチャを採り直したときと同型の変化で
   * ある)。**`ADR-0093` 限定4 の主張(`preset_list_shape` を書いても DOM が変わらない)は
   * 今日も真であり、それを固定する向きは1ミリも弱めていない。**
   */
  expect(section.outerHTML).toBe(PLAIN_LIST_HTML);
});

test('(d) 限定4: "table" と明示した一覧の DOM も、書かなかった場合と完全一致する', async () => {
  const section = await renderList(listWith({ preset_list_shape: "table" }));
  // **既定は `table` である** —— 明示しても DOM は1バイトも変わらない
  // (`table` の側には属性も器も1つも増やしていない)。
  expect(section.outerHTML).toBe(PLAIN_LIST_HTML);
});

test("(d) 限定4: 書かない/`table` の一覧にカードの器が1つも出ない", async () => {
  for (const manifest of [baseManifest(), listWith({ preset_list_shape: "table" })]) {
    const section = await renderList(manifest);
    expect(section.querySelectorAll(".list-cards")).toHaveLength(0);
    expect(section.querySelectorAll(".list-card")).toHaveLength(0);
    expect(section.querySelectorAll('[data-testid="list-cards"]')).toHaveLength(0);
    expect(section.querySelectorAll('[data-testid="list-card"]')).toHaveLength(0);
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (k) card の器そのもの
// ---------------------------------------------------------------------------

test("(k) card: レコード1件ごとにカードが1枚描かれ、列見出しがカードの中に出る", async () => {
  const section = await renderList(listWith({ preset_list_shape: "card" }));
  // 表は1つも描かれない(器が入れ替わる)。
  expect(section.querySelectorAll("table")).toHaveLength(0);
  expect(screen.queryByTestId("list-table")).toBeNull();

  const cards = [...section.querySelectorAll('[data-testid="list-card"]')];
  expect(cards).toHaveLength(ITEM_ROWS.length);

  // **1件ずつ見る**(件数だけで済ませない)。
  const first = cards[0] as HTMLElement;
  expect(
    [...first.querySelectorAll("[data-field]")].map((n) => n.getAttribute("data-field")),
  ).toEqual(["name", "quantity", "vendor"]);
  expect(
    [...first.querySelectorAll("[data-field]")].map((n) => n.getAttribute("data-field-type")),
  ).toEqual(["text", "number", "reference"]);
  // 列見出し(`Field.name`)がカードの中に出る —— 表の `<th>` に当たるものである。
  expect([...first.querySelectorAll(".list-card-label")].map((n) => n.textContent)).toEqual([
    "備品名",
    "数量",
    "仕入先",
  ]);
  expect(first.textContent).toContain("会議テーブル");
  expect(first.textContent).toContain("山田商会");

  const second = cards[1] as HTMLElement;
  expect(second.textContent).toContain("椅子");
  // 未設定の参照は表のときと同じ表示関数が描く(`.field-empty`)。
  expect(second.querySelector(".field-empty")?.textContent).toBe("未設定");
});

test("(k) card: `.list-view` の直下の並びは、表のときと同じ形である(list-table の位置に list-cards)", async () => {
  const table = await renderList();
  const tableOrder = sectionOrder(table);
  cleanup();
  const card = await renderList(listWith({ preset_list_shape: "card" }));
  const cardOrder = sectionOrder(card);
  /*
   * **【V4-M20-T03 で `list-bulk` が1つ増えた】** 単位C(画面で選んでまとめて操作する)の
   * 判定は**将来送り**であり、その送り先が `V4-M20-T03`(**表示層だけで作り、カーネル語彙を
   * 1つも増やさない**)である。**入口のボタンは `.list-view` の直下に立つので、この並びの
   * 先頭に1つ増える。****出るのは editor / owner のときだけである**(本ファイルは owner で
   * 描いている)。**器の形(表 / カード)で並びが割れないという主張は今日も真である** ——
   * 下の写像の検査がそれを固定しており、1ミリも弱めていない。
   */
  expect(tableOrder).toEqual(["list-bulk", "list-total", "list-table"]);
  expect(cardOrder).toEqual(["list-bulk", "list-total", "list-cards"]);
  // **`list-table` の位置がそのまま `list-cards` になる**(直下の子を1つも増減させない)。
  expect(cardOrder.map((id) => (id === "list-cards" ? "list-table" : id))).toEqual(tableOrder);
});

test("(k) card: 行クリックの遷移が表のときと同じに働く(リンクからの二重発火も同じに避ける)", async () => {
  const section = await renderList(listWith({ preset_list_shape: "card" }));
  const card = section.querySelector('[data-testid="list-card"]') as HTMLElement;
  // クリックできる形(表の `.list-row-interactive` と同じクラスと `tabindex`)。
  expect(card.className).toContain("list-row-interactive");
  expect(card.getAttribute("tabindex")).toBe("0");

  window.history.replaceState({}, "", `/apps/${APP_ID}/views/item-list`);
  card.click();
  expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/item-detail/records/${RECORD_A}`);

  // 参照セルのリンクを押したときは行の遷移が起きない(表の `ListRow` と同じ判定)。
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/item-list`);
  const link = card.querySelector("a") as HTMLElement;
  expect(link).not.toBeNull();
  link.click();
  expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/vendor-detail/records/vendor-1`);
});

test("(k) card: CSV の書き出し口が同じ testid で残っている(器の中に置く)", async () => {
  const section = await renderList(listWith({ preset_list_shape: "card" }));
  const copy = screen.getByTestId("list-csv-copy");
  expect(copy.textContent).toBe("このページを CSV でコピー");
  // **`.list-view` の直下の子を増やさない**ため、口はカードの器の中に置く。
  expect(copy.closest('[data-testid="list-cards"]')).toBe(screen.getByTestId("list-cards"));
  expect(section.querySelectorAll('[data-testid="list-csv-copy"]')).toHaveLength(1);
});

test("(k) card: 0件のときは表のときと同じ空表示になる(カードの器を出さない)", async () => {
  globalThis.fetch = (async () =>
    jsonResponse({ records: [], total: 0 })) as unknown as typeof fetch;
  render(
    createElement(ListViewRenderer, {
      appId: APP_ID,
      manifest: listWith({ preset_list_shape: "card" }),
      view: listWith({ preset_list_shape: "card" }).app.views[0] as ListView,
    }),
  );
  await waitFor(() => expect(screen.getByTestId("list-empty")).toBeDefined());
  expect(screen.queryByTestId("list-cards")).toBeNull();
});

// ---------------------------------------------------------------------------
// (e) 限定6: 当たり先(実際に描画を変える CSS 規則)が `card` について実在する
// ---------------------------------------------------------------------------

test("(e) 限定6: card の当たり先の CSS 規則が、配られる CSS の集合に実在する", () => {
  const body = stripComments(handwrittenCss);
  // **「当たり先の無い enum 値を置いてはならない」**(`ADR-0050` §3a 3 の逐語)。
  for (const selector of [".list-cards", ".list-card", ".list-card-field", ".list-card-label"]) {
    expect(body.includes(`${selector} {`), selector).toBe(true);
  }
  // **実際に描画を変える宣言を持つ**(空の規則を置いて「実在する」と言わない)。
  const cardsRule = body.slice(body.indexOf(".list-cards {"));
  expect(cardsRule.slice(0, cardsRule.indexOf("}"))).toContain("display: flex");
  const cardRule = body.slice(body.indexOf(".list-card {"));
  expect(cardRule.slice(0, cardRule.indexOf("}"))).toContain("border");
});

test("(e) 限定6: カードの規則に色のリテラルが1バイトも無い(使うのは25スロットの var() だけ)", () => {
  const body = stripComments(handwrittenCss);
  const start = body.indexOf(".list-cards {");
  const end = body.indexOf(".field-empty {", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = body.slice(start, end);
  expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(block).not.toMatch(/\b(rgb|rgba|hsl|hsla|oklch|color)\(/);
});

// ---------------------------------------------------------------------------
// (f) 限定5: 座標系9プロパティを1つも使わない
// ---------------------------------------------------------------------------

test("(f) 限定5: 手で書く CSS に座標系9プロパティが1つも無い", () => {
  const body = stripComments(handwrittenCss);
  for (const property of [
    "position",
    "z-index",
    "top",
    "left",
    "right",
    "bottom",
    "inset",
    "float",
    "transform",
  ]) {
    const pattern = new RegExp(`(^|[;{])\\s*${property}\\s*:`, "m");
    expect(pattern.test(body), property).toBe(false);
  }
});

test("(f) 限定5: カードを重ねて出していない(器は縦に並べるだけである)", () => {
  const body = stripComments(handwrittenCss);
  const start = body.indexOf(".list-cards {");
  const block = body.slice(start, body.indexOf("}", start));
  expect(block).toContain("flex-direction: column");
});

// ---------------------------------------------------------------------------
// (g) 限定7: `related` の子一覧には当たらない —— **当たり方の表**
// ---------------------------------------------------------------------------

/**
 * **当たり方の表**(`ADR-0050` §4 と同じ形。**先に決めて書く**)。
 *
 * | 対象 | `preset_list_shape` が当たるか | 根拠 |
 * |---|---|---|
 * | `list_view` の一覧そのもの(`.list-view` の中の表 / カード) | **当たる** | 本キーは `list_view` にだけ書ける(`allOf` の他2分岐は `false`) |
 * | `detail_view` の `related` の子一覧(`.related-table`) | **当たらない** | **`related` は `detail_view` の中の定義であり、本キーを書く場所がそもそも無い。**加えて器の分岐は `ListViewRenderer` の中にしかなく、`RelatedList`(`DetailViewRenderer.tsx`)を1バイトも変えていない |
 * | `detail_view` の項目そのもの(`.detail-fields`) | **当たらない** | 同上(`detail_view` 分岐で `false`) |
 * | 入力フォーム(`.record-form`) | **当たらない** | 同上(form 分岐で `false`) |
 *
 * **代償**: **子一覧をカードで出すことはできない**(`ADR-0093` §Decision 4 の 4 の門)。
 */
const HIT_TABLE_MARKER = "当たり方の表(`ADR-0093` 限定7)";

test("(g) 限定7: 当たり方の表がレンダラーのコメントに書いてある", () => {
  const source = readFileSync(LIST_RENDERER_PATH, "utf-8");
  expect(source).toContain(HIT_TABLE_MARKER);
  expect(source).toContain(".related-table");
});

test("(g) 限定7: RelatedList(DetailViewRenderer)にカードの分岐が1つも無い", () => {
  const source = readFileSync(DETAIL_RENDERER_PATH, "utf-8");
  expect(source).not.toContain("preset_list_shape");
  expect(source).not.toContain("list-cards");
  expect(source).not.toContain("list-card");
});

test("(g) 限定7: related の子一覧は今日どおり表のままである", async () => {
  const manifest = baseManifest();
  manifest.app.tables.push({
    id: "notes",
    name: "メモ",
    fields: [
      { id: "body", name: "本文", type: "text" },
      { id: "item", name: "備品", type: "reference", reference_table: "items" },
    ],
  });
  const detail = manifest.app.views[1] as DetailView;
  detail.related = [{ table: "notes", via: "item", columns: ["body"] }];
  render(
    createElement(DetailViewRenderer, {
      appId: APP_ID,
      manifest,
      view: detail,
      recordId: RECORD_A,
    }),
  );
  const section = await waitFor(() => screen.getByTestId("view-renderer-detail_view"));
  await waitFor(() => expect(section.querySelector(".related-table")).not.toBeNull());
  // **表のままである**(カードの器が1つも出ない)。
  expect(section.querySelectorAll(".list-cards")).toHaveLength(0);
  expect(section.querySelectorAll(".list-card")).toHaveLength(0);
  expect(section.querySelector(".related-table")?.tagName.toLowerCase()).toBe("table");
});

// ---------------------------------------------------------------------------
// (i) 限定9: マニフェストの値からクラス名を生やさない
// ---------------------------------------------------------------------------

test("(i) 限定9: レンダラーが有限 enum を分岐してリテラルのクラス名を選んでいる", () => {
  const source = readFileSync(LIST_RENDERER_PATH, "utf-8");
  // **値をクラス名に埋め込む形(テンプレートリテラル / 連結)が1つも無い。**
  expect(source).not.toMatch(/`[^`]*\$\{[^}]*preset_list_shape[^}]*\}[^`]*`/);
  expect(source).not.toMatch(/"list-"\s*\+/);
  // 使うクラス名はソースにリテラルとして現れる(`ADR-0087` 限定6)。
  expect(source).toContain('"list-cards"');
  expect(source).toContain('"list-card"');
});

test("(i) 限定9: 構成ファイルに safelist の設定が1つも無い", () => {
  // **散文としての「safelist を1行も置いていない」は `web/vite.config.ts` のコメントに在る** ——
  // 本検査が見るのは**設定としての出現**(`safelist:` / `@source inline(...)`)だけである。
  for (const relative of ["vite.config.ts", "src/tailwind.css"]) {
    const text = readFileSync(join(dirname(WEB_SRC_DIR), relative), "utf-8");
    expect(text, relative).not.toMatch(/safelist\s*[:=]/i);
    expect(text, relative).not.toContain("@source inline(");
  }
});

test("(i) 限定9: マニフェストの値が DOM の属性値にも class にも現れない(器は分岐で選ぶ)", async () => {
  const section = await renderList(listWith({ preset_list_shape: "card" }));
  // **`data-preset-shape` のような属性を1つも出していない** —— 器の選択は
  // レンダラーの分岐であって、CSS 側の属性セレクタではない。
  expect(section.querySelectorAll("[data-preset-shape]")).toHaveLength(0);
  expect(section.outerHTML).not.toContain("preset_list_shape");
});

// ---------------------------------------------------------------------------
// (v) `ViewRendererProps` / 表示関数の引数を1本も増やしていない
// ---------------------------------------------------------------------------

test("(v) ViewRendererProps にも表示関数にも props / 引数を1つも足していない", () => {
  const types = readFileSync(join(WEB_SRC_DIR, "views", "types.ts"), "utf-8");
  expect(types).not.toContain("preset_list_shape");
  expect(types).not.toContain("shape");
  const display = readFileSync(join(WEB_SRC_DIR, "fields", "display.tsx"), "utf-8");
  expect(display).not.toContain("preset_list_shape");
  // **CSV の書き出し口も表示関数も、器の形を1つも知らない。**
  expect(readFileSync(join(REPO_ROOT, "web", "src", "ui", "table.tsx"), "utf-8")).not.toContain(
    "list-card",
  );
});
