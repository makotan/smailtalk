/**
 * **一覧の区切りの描画**(`V20-M4-T03`。条文 = `ADR-0470` / `ADR-0461`、メインの裁定3・4・6・8、申1・申4)。
 *
 * ## 決めたこと(名指し)
 *
 * - **表(`table`)は、群ごとに `<tbody>` を分ける。** 各 `<tbody>` の先頭に
 *   `<tr><th colspan=列数 scope="rowgroup">見出し</th></tr>` を1行置く(裁定8)。
 *   **列数は実際に描いている列の数**(選択の列・表示列・操作の列)。**行を束ねて1行にしていない** ——
 *   レコードの行(`data-testid="list-row"`)は今日どおり1件ずつ、見出しの行とは別の `<tr>` である。
 * - **カード(`card`)は、群ごとに見出し要素(`<h4>`)とその群のカードを1つの器に入れる。**
 *   見出しの段は画面名の `<h3 data-testid="view-title">`(`ViewHost.tsx`)の1段下である。
 * - **見出しの文字は、列のセルがその値を出す部品(`FieldValue`)そのもので作る**(申4)。
 *   参照は代表値、真偽は ✓ / ✕(読み上げは「はい」/「いいえ」)、日付は丸めた値。
 *   **値が無い群は「(値なし)」**(申1。集計表と同じ綴り)。
 * - **日付の丸めは画面に1文字も書かない**(`ADR-0339` 限定7)。**サーバが応答の `group_keys` に
 *   行ごとの群の値(丸めた値)を添え、画面はそれを出すだけである**(理由は
 *   `src/server/list-group-keys.test.ts` の冒頭)。
 * - **見出しはサーバが並べた行の順のまま、群の値が変わる所と、各ページの先頭の行の前に挟む**
 *   (裁定6。前ページから続く群でもページの先頭に出す)。**表示中の行からだけ作る**ので、
 *   絞り込みで0件になった群の見出しは出ない(裁定3)。
 * - **見出しにボタンを1つも付けない**(裁定4)。行ボタンは今日どおり各行に付く。
 *
 * ## 着手前の DOM(`__fixtures__/list-undeclared-group-by-before.dom.txt`)
 *
 * **束ねるキーを書いていない一覧を、表とカードの2通りで描いた DOM**(1行目 = 表、2行目 = カード)。
 * **撮ったのは実装を1バイトも入れる前で、`web/src/` は土台 `6414a735` と差分0行だった**
 * (`git diff 6414a735 --quiet -- web/src` が真)。題材は `list-group-by-fixture.tsx`。
 * **拡張子を `.html` にしていないのは、整形器(biome)が HTML として読むのを避けるためである**
 * (`V20-M3` の先例と同じ)。
 *
 * ## このファイルが証明しないこと
 *
 * - **本物のサーバと並びを突き合わせていない**(応答は手書き)。並びと `group_keys` はサーバの
 *   検査(`src/server/list-group-by-order.test.ts` / `list-group-keys.test.ts`)、画面と本物の
 *   サーバを通しで撃つのは `web/e2e/list-group-by.e2e.ts` である。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { RecordRow } from "../../src/kernel/records.ts";
import {
  groupManifest,
  ITEM_ROWS,
  ITEMS_PATH,
  installGroupFetch,
  itemRequests,
  renderGroupList,
  restoreGroupFetch,
  setItemResponder,
} from "./list-group-by-fixture.tsx";
import { WEB_SRC_DIR } from "./style-source-set.ts";

const BEFORE = readFileSync(
  join(import.meta.dir, "__fixtures__", "list-undeclared-group-by-before.dom.txt"),
  "utf8",
)
  .trimEnd()
  .split("\n");

beforeEach(installGroupFetch);
afterEach(() => {
  cleanup();
  restoreGroupFetch();
});

const byId = (id: string): RecordRow => ITEM_ROWS.find((row) => row._id === id) as RecordRow;

/** 表の見出しの `<th>` を、表示順に。 */
function tableHeadings(section: HTMLElement): HTMLElement[] {
  return [...section.querySelectorAll<HTMLElement>('th[scope="rowgroup"]')];
}

/** カードの見出しを、表示順に。 */
function cardHeadings(section: HTMLElement): HTMLElement[] {
  return [...section.querySelectorAll<HTMLElement>('[data-testid="list-group-heading"]')];
}

/** 種類で束ねた応答(サーバが並べた後の形)。 */
const CATEGORY_RESPONSE = {
  records: ["i1", "i2", "i3", "i4", "i5"].map(byId),
  total: 5,
  group_keys: ["食品", "食品", "雑貨", "雑貨", null],
};

// ---------------------------------------------------------------------------
// T03 (c) 束ねるキーを書いていない一覧は、着手前と完全一致する
// ---------------------------------------------------------------------------

test("T03 (c) group_by を書いていない一覧の DOM が、着手前と完全一致する(表とカードの2通り)", async () => {
  expect(BEFORE).toHaveLength(2);
  for (const [index, extra] of [{}, { preset_list_shape: "card" }].entries()) {
    const section = await renderGroupList(groupManifest(extra));
    expect(section.outerHTML, String(index)).toBe(BEFORE[index] as string);
    cleanup();
  }
});

test("T03 (c) group_by を書いていない一覧の読取 URL は着手前と同じで、group_by / granularity の引数を1つも持たない", async () => {
  for (const extra of [{}, { preset_list_shape: "card" }]) {
    itemRequests.length = 0;
    await renderGroupList(groupManifest(extra));
    expect(itemRequests).toEqual([`${ITEMS_PATH}?limit=50`]);
    for (const url of itemRequests) {
      expect(url).not.toContain("group_by");
      expect(url).not.toContain("granularity");
    }
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 画面の group_by を読取の引数へ翻訳する
// ---------------------------------------------------------------------------

test("T03 画面の group_by は読取の引数 group_by= / granularity= へ翻訳される(日付だけ粒度が載る)", async () => {
  setItemResponder(() => CATEGORY_RESPONSE);
  await renderGroupList(groupManifest({ group_by: { field: "category" } }));
  expect(itemRequests).toEqual([`${ITEMS_PATH}?limit=50&group_by=category`]);
  cleanup();

  itemRequests.length = 0;
  setItemResponder(() => ({
    records: ITEM_ROWS,
    total: 5,
    group_keys: ["2026-09-14", "2026-09-21", "2026-09-21", "2026-09-28", null],
  }));
  await renderGroupList(groupManifest({ group_by: { field: "due", granularity: "week" } }));
  expect(itemRequests).toEqual([`${ITEMS_PATH}?limit=50&group_by=due&granularity=week`]);
});

// ---------------------------------------------------------------------------
// T03 (a)(b) 見出しが挟まる —— 表
// ---------------------------------------------------------------------------

test("T03 (a)(b) 表: 群ごとに tbody を分け、先頭に colspan=列数・scope=rowgroup の見出しの行を1行置く。レコードの行は1件ずつ別の tr", async () => {
  setItemResponder(() => CATEGORY_RESPONSE);
  const section = await renderGroupList(groupManifest({ group_by: { field: "category" } }));
  const table = section.querySelector("table.list-table") as HTMLTableElement;
  const bodies = [...table.querySelectorAll(":scope > tbody")];
  expect(bodies).toHaveLength(3);
  // 表示列5 + 操作の列1 = 6 列。
  const headerCells = table.querySelectorAll(":scope > thead > tr > th");
  expect(headerCells).toHaveLength(6);
  const expected = [
    { heading: "食品", rows: ["りんご", "パン"] },
    { heading: "雑貨", rows: ["はさみ", "のり"] },
    { heading: "(値なし)", rows: ["未分類"] },
  ];
  for (const [index, body] of bodies.entries()) {
    const rows = [...body.querySelectorAll(":scope > tr")];
    const [first, ...rest] = rows;
    // 見出しの行: セルは th 1つだけ。レコードの行ではない。
    expect(first?.getAttribute("data-testid")).not.toBe("list-row");
    const cells = [...(first?.children ?? [])];
    expect(cells).toHaveLength(1);
    const th = cells[0] as HTMLTableCellElement;
    expect(th.tagName).toBe("TH");
    expect(th.getAttribute("scope")).toBe("rowgroup");
    expect(th.getAttribute("colspan")).toBe("6");
    expect(th.textContent).toBe(expected[index]?.heading as string);
    // レコードの行は今日どおり1件ずつ。
    expect(rest.map((tr) => tr.getAttribute("data-testid"))).toEqual(rest.map(() => "list-row"));
    expect(rest.map((tr) => tr.querySelector('[data-field="name"]')?.textContent)).toEqual(
      expected[index]?.rows as string[],
    );
  }
  // 行の総数は5のまま(見出しで行を減らしも束ねもしない)。
  expect(section.querySelectorAll('[data-testid="list-row"]')).toHaveLength(5);
});

test("T03 (b) 表: 選択の列が出ているあいだは、見出しの colspan も1つ増える(実際の列数に合わせる)", async () => {
  setItemResponder(() => CATEGORY_RESPONSE);
  const section = await renderGroupList(groupManifest({ group_by: { field: "category" } }));
  fireEvent.click(screen.getByTestId("list-bulk-toggle"));
  await waitFor(() => expect(screen.queryByTestId("list-select-all")).not.toBeNull());
  const headerCells = section.querySelectorAll("table.list-table > thead > tr > th");
  expect(headerCells).toHaveLength(7);
  expect(tableHeadings(section)).toHaveLength(3);
  for (const th of tableHeadings(section)) {
    expect(th.getAttribute("colspan")).toBe("7");
  }
});

// ---------------------------------------------------------------------------
// T03 (a)(b) 見出しが挟まる —— カード
// ---------------------------------------------------------------------------

test("T03 (a)(b) カード: 群ごとに見出し要素(h4)とその群のカードが出る。見出しはカードと別の要素", async () => {
  setItemResponder(() => CATEGORY_RESPONSE);
  const section = await renderGroupList(
    groupManifest({ group_by: { field: "category" }, preset_list_shape: "card" }),
  );
  const headings = cardHeadings(section);
  expect(headings.map((h) => h.tagName)).toEqual(["H4", "H4", "H4"]);
  expect(headings.map((h) => h.textContent)).toEqual(["食品", "雑貨", "(値なし)"]);
  for (const heading of headings) {
    expect(heading.closest('[data-testid="list-card"]')).toBeNull();
  }
  const groups = [...section.querySelectorAll('[data-testid="list-card-group"]')];
  expect(groups).toHaveLength(3);
  expect(
    groups.map((group) =>
      [...group.querySelectorAll('[data-testid="list-card"] [data-field="name"]')].map((n) =>
        n.textContent?.replace("品名", ""),
      ),
    ),
  ).toEqual([["りんご", "パン"], ["はさみ", "のり"], ["未分類"]]);
  // 各群の最初の子が見出し。
  for (const group of groups) {
    expect(group.firstElementChild?.getAttribute("data-testid")).toBe("list-group-heading");
  }
  expect(section.querySelectorAll('[data-testid="list-card"]')).toHaveLength(5);
  // 表は描かない。
  expect(section.querySelectorAll("table")).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// 裁定6 各ページの先頭の行の前に見出し
// ---------------------------------------------------------------------------

test("T03 裁定6 各ページの先頭の行の前には、前ページから続く群でも見出しが出る(表とカード)", async () => {
  // 1ページ3行。2ページ目の先頭(のり)は1ページ目から続く「雑貨」の群。
  setItemResponder((url) =>
    url.includes("offset=3")
      ? { records: [byId("i4"), byId("i5")], total: 5, group_keys: ["雑貨", null] }
      : {
          records: [byId("i1"), byId("i2"), byId("i3")],
          total: 5,
          group_keys: ["食品", "食品", "雑貨"],
        },
  );
  for (const extra of [{}, { preset_list_shape: "card" }]) {
    const card = "preset_list_shape" in extra;
    const section = await renderGroupList(
      groupManifest({ group_by: { field: "category" }, page_size: 3, ...extra }),
    );
    const headings = () => (card ? cardHeadings(section) : tableHeadings(section));
    expect(headings().map((h) => h.textContent)).toEqual(["食品", "雑貨"]);
    fireEvent.click(screen.getByTestId("list-next"));
    await waitFor(() => expect(section.textContent).toContain("未分類"));
    expect(headings().map((h) => h.textContent)).toEqual(["雑貨", "(値なし)"]);
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 見出しの文字
// ---------------------------------------------------------------------------

test("T03 日付の見出しは、サーバが丸めた値(日 / 週 / 月)をそのまま出す(表とカード)", async () => {
  const keys = {
    day: ["2026-09-20", "2026-09-21", "2026-09-27", "2026-10-01", null],
    week: ["2026-09-14", "2026-09-21", "2026-09-21", "2026-09-28", null],
    month: ["2026-09", "2026-09", "2026-09", "2026-10", null],
  } as const;
  const expected = {
    day: ["2026-09-20", "2026-09-21", "2026-09-27", "2026-10-01", "(値なし)"],
    week: ["2026-09-14", "2026-09-21", "2026-09-28", "(値なし)"],
    month: ["2026-09", "2026-10", "(値なし)"],
  };
  for (const granularity of ["day", "week", "month"] as const) {
    for (const extra of [{}, { preset_list_shape: "card" }]) {
      setItemResponder(() => ({ records: ITEM_ROWS, total: 5, group_keys: keys[granularity] }));
      const section = await renderGroupList(
        groupManifest({ group_by: { field: "due", granularity }, ...extra }),
      );
      const headings =
        "preset_list_shape" in extra ? cardHeadings(section) : tableHeadings(section);
      expect(
        headings.map((h) => h.textContent),
        granularity,
      ).toEqual(expected[granularity]);
      cleanup();
    }
  }
});

test("T03 申4 参照と真偽の見出しは、その値を列のセルが出す文字(と読み上げ)と同じ", async () => {
  // 参照: 山田商会(v1)/ 田中商店(v2)/ 値なし。
  setItemResponder(() => ({
    records: ["i1", "i3", "i2", "i4", "i5"].map(byId),
    total: 5,
    group_keys: ["v1", "v1", "v2", null, null],
  }));
  let section = await renderGroupList(groupManifest({ group_by: { field: "vendor" } }));
  let headings = tableHeadings(section);
  expect(headings.map((h) => h.textContent)).toEqual(["山田商会", "田中商店", "(値なし)"]);
  for (const [index, id] of ["i1", "i2"].entries()) {
    const cell = [...section.querySelectorAll('[data-testid="list-row"]')]
      .find((tr) => tr.querySelector('[data-field="name"]')?.textContent === byId(id).name)
      ?.querySelector('[data-field="vendor"]');
    expect(headings[index]?.innerHTML).toBe(cell?.innerHTML as string);
  }
  cleanup();

  // 真偽: ✓(はい)/ ✕(いいえ)/ 値なし。
  setItemResponder(() => ({
    records: ["i1", "i3", "i2", "i5", "i4"].map(byId),
    total: 5,
    group_keys: [true, true, false, false, null],
  }));
  section = await renderGroupList(groupManifest({ group_by: { field: "urgent" } }));
  headings = tableHeadings(section);
  expect(headings.map((h) => h.textContent)).toEqual(["✓", "✕", "(値なし)"]);
  expect(headings.map((h) => h.querySelector("[aria-label]")?.getAttribute("aria-label"))).toEqual([
    "はい",
    "いいえ",
    undefined,
  ]);
  for (const [index, id] of ["i1", "i2"].entries()) {
    const cell = [...section.querySelectorAll('[data-testid="list-row"]')]
      .find((tr) => tr.querySelector('[data-field="name"]')?.textContent === byId(id).name)
      ?.querySelector('[data-field="urgent"]');
    expect(headings[index]?.innerHTML).toBe(cell?.innerHTML as string);
  }
});

test("T03 申1 値が無い群の見出しは「(値なし)」で、列のセルの「未設定」とは別の綴り(集計表と同じ)", async () => {
  setItemResponder(() => CATEGORY_RESPONSE);
  const section = await renderGroupList(groupManifest({ group_by: { field: "category" } }));
  const last = tableHeadings(section).at(-1) as HTMLElement;
  expect(last.textContent).toBe("(値なし)");
  const report = readFileSync(join(WEB_SRC_DIR, "views", "ReportViewRenderer.tsx"), "utf8");
  expect(report).toContain('const EMPTY_GROUP_KEY_LABEL = "(値なし)";');
});

// ---------------------------------------------------------------------------
// 裁定4 見出しにボタンを付けない / 行ボタンは今日どおり
// ---------------------------------------------------------------------------

test("T03 裁定4 見出しにボタン・リンク・入力欄が1つも無く、行ボタンは各行に1つずつ今日どおり出る(表とカード)", async () => {
  for (const extra of [{}, { preset_list_shape: "card" }]) {
    setItemResponder(() => CATEGORY_RESPONSE);
    const section = await renderGroupList(
      groupManifest({ group_by: { field: "category" }, ...extra }),
    );
    const card = "preset_list_shape" in extra;
    const headings = card ? cardHeadings(section) : tableHeadings(section);
    expect(headings.length).toBe(3);
    for (const heading of headings) {
      const holder = card ? heading : (heading.parentElement as HTMLElement);
      expect(holder.querySelectorAll("button, a, input, select, textarea")).toHaveLength(0);
      expect(holder.hasAttribute("tabindex")).toBe(false);
    }
    expect(section.querySelectorAll('[data-testid="list-action-origin-note-form"]')).toHaveLength(
      5,
    );
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 裁定3 絞り込みで0件になった群の見出しは出ない
// ---------------------------------------------------------------------------

test("T03 裁定3 表示中の行が無い群の見出しは出ない(0件のときは見出しも1つも出ない)", async () => {
  setItemResponder(() => ({
    records: [byId("i1"), byId("i2")],
    total: 2,
    group_keys: ["食品", "食品"],
  }));
  let section = await renderGroupList(groupManifest({ group_by: { field: "category" } }));
  expect(tableHeadings(section).map((h) => h.textContent)).toEqual(["食品"]);
  cleanup();

  setItemResponder(() => ({ records: [], total: 0, group_keys: [] }));
  section = await renderGroupList(groupManifest({ group_by: { field: "category" } }));
  expect(screen.getByTestId("list-empty")).toBeDefined();
  expect(tableHeadings(section)).toHaveLength(0);
  expect(cardHeadings(section)).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// ADR-0339 限定7 画面に日付の丸めを書いていない
// ---------------------------------------------------------------------------

test("T03 ADR-0339 限定7 一覧の描画と読取の口に、日付の丸めが1文字も無い(週の計算をしていない)", () => {
  for (const path of [
    join(WEB_SRC_DIR, "views", "ListViewRenderer.tsx"),
    join(WEB_SRC_DIR, "api.ts"),
  ]) {
    const source = readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(source, path).not.toMatch(
      /getUTCDay|getDay\(|setUTCDate|setDate\(|truncateToGranularity/,
    );
  }
});

// ---------------------------------------------------------------------------
// T04 上限(裁定7)と、塞がない穴の今日の姿(`V20-M4-T04`)
// ---------------------------------------------------------------------------

/** 画面の1ページの件数(`page_size`)として書ける4値。 */
const PAGE_SIZES = [10, 20, 50, 100] as const;

test("T04 (a) 裁定7 見出しの数は1ページの行数を超えない(全行が別の群でも、群の値が飛び飛びでも。表とカード。page_size の4値)", async () => {
  const rows = ["i1", "i2", "i3", "i4", "i5"].map(byId);
  const cases: { keys: (string | null)[]; headings: number }[] = [
    // 全行が別の群(最悪の場合): 見出しの数 = 行の数。
    { keys: ["食品", "雑貨", "書籍", "文具", null], headings: 5 },
    // 同じ値が飛び飛び(サーバはこう並べないが、画面は連続する同じ値だけを1群にする): それでも行の数まで。
    { keys: ["食品", "雑貨", "食品", "雑貨", null], headings: 5 },
    // 全行が同じ群: 見出しは1つ。
    { keys: ["食品", "食品", "食品", "食品", "食品"], headings: 1 },
  ];
  for (const pageSize of PAGE_SIZES) {
    for (const { keys, headings: expectedHeadings } of cases) {
      setItemResponder(() => ({ records: rows, total: rows.length, group_keys: keys }));
      for (const extra of [{}, { preset_list_shape: "card" }]) {
        const card = "preset_list_shape" in extra;
        itemRequests.length = 0;
        const section = await renderGroupList(
          groupManifest({ group_by: { field: "category" }, page_size: pageSize, ...extra }),
        );
        const label = `${pageSize} ${keys.join(",")} ${card ? "card" : "table"}`;
        // 画面は必ず limit=<page_size> で読む(行の数は page_size を超えない)。
        expect(itemRequests.at(-1), label).toContain(`limit=${pageSize}`);
        const shown = card
          ? section.querySelectorAll('[data-testid="list-card"]').length
          : section.querySelectorAll('[data-testid="list-row"]').length;
        const headingCount = (card ? cardHeadings(section) : tableHeadings(section)).length;
        expect(shown, label).toBe(rows.length);
        expect(headingCount, label).toBe(expectedHeadings);
        expect(headingCount, label).toBeLessThanOrEqual(shown);
        expect(shown, label).toBeLessThanOrEqual(pageSize);
        cleanup();
      }
    }
  }
});

test("T04 【塞がない穴】group_keys が無い・行と長さが違う応答では、見出しを1つも出さず、理由も出さずに区切らない形で描く", async () => {
  const rows = ["i1", "i2", "i3", "i4", "i5"].map(byId);
  for (const response of [
    { records: rows, total: 5 },
    { records: rows, total: 5, group_keys: ["食品", "食品", "雑貨"] },
  ]) {
    setItemResponder(() => response);
    const section = await renderGroupList(groupManifest({ group_by: { field: "category" } }));
    const label = JSON.stringify(Object.keys(response));
    expect(tableHeadings(section), label).toHaveLength(0);
    expect(section.querySelectorAll('[data-testid="list-row"]'), label).toHaveLength(5);
    // 表の本体は1本のまま(区切らない形)。
    const table = section.querySelector("table.list-table") as HTMLTableElement;
    expect(table.querySelectorAll(":scope > tbody"), label).toHaveLength(1);
    // 画面に理由(エラーや注意)を1つも出さない。
    expect(section.querySelector('[role="alert"]'), label).toBeNull();
    cleanup();
  }
});
