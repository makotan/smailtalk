/**
 * **一覧の区切り(`group_by`)をブラウザで実際に見る**(`V20-M4-T03` (d)。条文 = `ADR-0470`、
 * メインの裁定3・4・6・8)。
 *
 * **見出し・並べ替え・絞り込み・行ボタンを、同じ一覧の上で続けて撃つ**(表とカードの両方)。
 * 本物のサーバ(`fixture-server.ts`)を通すので、並び(群が第1キー、列見出しの並べ替えが群の中の
 * 第2キー)と、見出しの文字の元になる群の値(応答の `group_keys`)は、サーバが実際に返したものである。
 *
 * - **見出し**: 表は群ごとの `<tbody>` の先頭の `th[scope="rowgroup"]`、カードは群ごとの `<h4>`。
 * - **並べ替え**: 列見出し(品名)を押すと、群の順は変わらず、群の中の行の順だけが入れ替わる。
 *   見出しの位置(各 `<tbody>` の先頭)は行に追随する。**カードには列見出しが無い**ので撃てない
 *   (`ListViewRenderer.tsx` の `activeSortKey` の注。T00 記録 §6-4 の6)。
 * - **絞り込み**: 検索の語で行が0件になった群の見出しは消える(裁定3)。
 * - **ボタン**: 行ボタンを実際に押すと、その行の詳細画面が開く(裁定4)。見出しにボタンは無い。
 * - **ページ送り**(`V20-M4-T07`。点検 `T06` の指摘3): 「次へ」を押して2ページ目へ移ると、
 *   前のページから続く群でも2ページ目の先頭に見出しが出る(裁定6。表とカードの両方)。
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Diff } from "../../src/kernel/types.ts";
import { type FixtureApp, provisionApp } from "./fixture-app.ts";

const TABLE_VIEW = "grouped-table";
const CARD_VIEW = "grouped-card";

/** 作成順と品名の順と群の順が食い違うように置く(種類の値の昇順: 新品 < 良好 < 値なし)。 */
const ROWS = [
  { name: "b-新品", condition: "新品" },
  { name: "d-良好", condition: "良好" },
  { name: "a-新品", condition: "新品" },
  { name: "e-なし" },
  { name: "c-良好", condition: "良好" },
] as const;

async function setUp(request: Parameters<typeof provisionApp>[0]): Promise<{
  app: FixtureApp;
  ids: Map<string, string>;
}> {
  const app = await provisionApp(request);
  const common = {
    type: "list_view",
    table: "items",
    columns: ["name", "condition", "in_use"],
    group_by: { field: "condition" },
    search_fields: ["name"],
    actions: [{ view: "item-detail", name: "詳しく" }],
  };
  const diff = {
    diff_id: "list-group-by-e2e",
    intent: "品目の一覧を状態ごとに区切って見たい(表とカード)",
    operations: [
      { op: "add_view", view: { id: TABLE_VIEW, ...common } },
      { op: "add_view", view: { id: CARD_VIEW, ...common, preset_list_shape: "card" } },
    ],
  } as unknown as Diff;
  const applied = await request.post(`/api/apps/${app.appId}/diffs`, {
    data: diff,
    headers: app.authHeaders,
  });
  expect(applied.status(), await applied.text()).toBe(201);
  const ids = new Map<string, string>();
  for (const row of ROWS) {
    ids.set(row.name, await app.createRecord("items", { quantity: 1, ...row }));
  }
  return { app, ids };
}

/** 表の群ごとに [見出し, 行の品名...]。**各 `<tbody>` の先頭の行が見出しの行であることも見る。** */
async function tableGroups(page: Page): Promise<string[][]> {
  return page.locator("table.list-table > tbody").evaluateAll((bodies) =>
    bodies.map((body) => {
      const rows = [...body.querySelectorAll(":scope > tr")];
      const [first, ...rest] = rows;
      const heading = first?.querySelector(':scope > th[scope="rowgroup"]');
      return [
        heading === null || heading === undefined
          ? "(見出しが先頭に無い)"
          : (heading.textContent ?? ""),
        ...rest.map((tr) =>
          tr.getAttribute("data-testid") === "list-row"
            ? (tr.querySelector('[data-field="name"]')?.textContent ?? "")
            : "(行でない tr)",
        ),
      ];
    }),
  );
}

/** カードの群ごとに [見出し, カードの品名...]。 */
async function cardGroups(page: Page): Promise<string[][]> {
  return page.getByTestId("list-card-group").evaluateAll((groups) =>
    groups.map((group) => {
      const heading = group.firstElementChild;
      return [
        heading?.tagName === "H4" ? (heading.textContent ?? "") : "(見出しが先頭に無い)",
        ...[...group.querySelectorAll('[data-testid="list-card"]')].map((card) => {
          const nameField = card.querySelector('[data-field="name"]');
          const label = nameField?.querySelector(".list-card-label")?.textContent ?? "";
          return (nameField?.textContent ?? "").replace(label, "");
        }),
      ];
    }),
  );
}

/**
 * **群の中の既定の並び(作成順)は、同じミリ秒に作った行どうしで `_id` の順になり、撃つたびに揺れうる。**
 * 並べ替えを押す前は、群の順と見出しと群の中身(集合)だけを見る。
 */
function membersSorted(groups: string[][]): string[][] {
  return groups.map(([heading, ...names]) => [heading ?? "", ...names.sort()]);
}

async function expectNoControlsInHeadings(headings: Locator): Promise<void> {
  const count = await headings.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    await expect(headings.nth(index).locator("button, a, input, select, textarea")).toHaveCount(0);
  }
}

test.describe("V20-M4-T03 一覧の区切り(見出し・並べ替え・絞り込み・ボタン)", () => {
  test("表: 群ごとの tbody の先頭に見出し。列見出しの並べ替えで群の中だけが入れ替わり、絞り込みで0件の群の見出しが消え、行ボタンが押せる", async ({
    page,
    request,
  }) => {
    const { app, ids } = await setUp(request);
    await app.authenticate(page.context());
    await page.goto(`/apps/${app.appId}/views/${TABLE_VIEW}`);
    await expect(page.getByTestId("list-table")).toBeVisible();

    // 見出し: サーバの並び(群が第1キー)のまま、群の値が変わる所に挟まる。
    await expect
      .poll(async () => membersSorted(await tableGroups(page)))
      .toEqual([
        ["新品", "a-新品", "b-新品"],
        ["良好", "c-良好", "d-良好"],
        ["(値なし)", "e-なし"],
      ]);
    const headings = page.locator('th[scope="rowgroup"]');
    await expect(headings.first()).toHaveAttribute("colspan", "4"); // 表示列3 + 操作の列1
    await expectNoControlsInHeadings(headings);
    await expect(page.getByTestId("list-row")).toHaveCount(5);

    // 並べ替え: 品名の列見出しを押す(昇順 → 降順)。群の順は変わらず、群の中だけが入れ替わる。
    const sortByName = page.locator('[data-testid="list-sort"][data-field="name"]');
    await sortByName.click();
    await expect
      .poll(() => tableGroups(page))
      .toEqual([
        ["新品", "a-新品", "b-新品"],
        ["良好", "c-良好", "d-良好"],
        ["(値なし)", "e-なし"],
      ]);
    await sortByName.click();
    await expect
      .poll(() => tableGroups(page))
      .toEqual([
        ["新品", "b-新品", "a-新品"],
        ["良好", "d-良好", "c-良好"],
        ["(値なし)", "e-なし"],
      ]);

    // 絞り込み: 「良好」の行だけが残る語 → 新品と値なしの見出しが消える。
    await page.getByTestId("list-search-input").fill("良好");
    await expect.poll(() => tableGroups(page)).toEqual([["良好", "d-良好", "c-良好"]]);
    await expectNoControlsInHeadings(headings);

    // ボタン: 見出しの直後の行(c-良好 ではなく先頭の d-良好)の行ボタンを押す → その行の詳細画面。
    const firstRow = page
      .locator("table.list-table > tbody")
      .first()
      .getByTestId("list-row")
      .first();
    await expect(firstRow.locator('[data-field="name"]')).toHaveText("d-良好");
    await firstRow.getByTestId("list-action-link-item-detail").click();
    await expect(page).toHaveURL(
      `/apps/${app.appId}/views/item-detail/records/${ids.get("d-良好")}`,
    );
  });

  test("カード: 群ごとに h4 の見出しとその群のカード。絞り込みで0件の群の見出しが消え、行ボタンが押せる", async ({
    page,
    request,
  }) => {
    const { app, ids } = await setUp(request);
    await app.authenticate(page.context());
    await page.goto(`/apps/${app.appId}/views/${CARD_VIEW}`);
    await expect(page.getByTestId("list-cards")).toBeVisible();

    await expect
      .poll(async () => membersSorted(await cardGroups(page)))
      .toEqual([
        ["新品", "a-新品", "b-新品"],
        ["良好", "c-良好", "d-良好"],
        ["(値なし)", "e-なし"],
      ]);
    // 見出しの段は画面名(h3)の1段下。
    await expect(page.getByTestId("view-title")).toHaveJSProperty("tagName", "H3");
    const headings = page.getByTestId("list-group-heading");
    await expect(headings).toHaveCount(3);
    await expectNoControlsInHeadings(headings);
    await expect(page.getByTestId("list-card")).toHaveCount(5);

    await page.getByTestId("list-search-input").fill("新品");
    await expect
      .poll(async () => membersSorted(await cardGroups(page)))
      .toEqual([["新品", "a-新品", "b-新品"]]);

    const card = page
      .getByTestId("list-card-group")
      .first()
      .getByTestId("list-card")
      .filter({ hasText: "a-新品" });
    await card.getByTestId("list-action-link-item-detail").click();
    await expect(page).toHaveURL(
      `/apps/${app.appId}/views/item-detail/records/${ids.get("a-新品")}`,
    );
  });
  test("ページ送り: 次へを押した2ページ目の先頭には、前のページから続く群でも見出しが出る(表とカード)", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    const common = {
      type: "list_view",
      table: "items",
      columns: ["name", "condition", "in_use"],
      group_by: { field: "condition" },
      // 1ページ10行(書ける最小の件数)。新品11行 + 良好1行 → 新品の群が1ページ目と2ページ目をまたぐ。
      page_size: 10,
      // 群の中を品名の昇順にして、2ページ目の行を決める(作成順は同じミリ秒で揺れうる)。
      sort: { field: "name", order: "asc" },
    };
    const diff = {
      diff_id: "list-group-by-e2e-pager",
      intent: "品目の一覧を状態ごとに区切り、ページを送っても見出しが読めるか見たい",
      operations: [
        { op: "add_view", view: { id: "grouped-paged-table", ...common } },
        {
          op: "add_view",
          view: { id: "grouped-paged-card", ...common, preset_list_shape: "card" },
        },
      ],
    } as unknown as Diff;
    const applied = await request.post(`/api/apps/${app.appId}/diffs`, {
      data: diff,
      headers: app.authHeaders,
    });
    expect(applied.status(), await applied.text()).toBe(201);
    for (let n = 1; n <= 11; n += 1) {
      await app.createRecord("items", {
        quantity: 1,
        name: `n${String(n).padStart(2, "0")}-新品`,
        condition: "新品",
      });
    }
    await app.createRecord("items", { quantity: 1, name: "r12-良好", condition: "良好" });
    await app.authenticate(page.context());

    // 表。
    await page.goto(`/apps/${app.appId}/views/grouped-paged-table`);
    await expect(page.getByTestId("list-table")).toBeVisible();
    await expect(page.getByTestId("list-row")).toHaveCount(10);
    await expect
      .poll(async () => (await tableGroups(page)).map((group) => group[0]))
      .toEqual(["新品"]);
    await page.getByTestId("list-next").click();
    await expect
      .poll(() => tableGroups(page))
      .toEqual([
        ["新品", "n11-新品"],
        ["良好", "r12-良好"],
      ]);
    await expectNoControlsInHeadings(page.locator('th[scope="rowgroup"]'));

    // カード。
    await page.goto(`/apps/${app.appId}/views/grouped-paged-card`);
    await expect(page.getByTestId("list-cards")).toBeVisible();
    await expect(page.getByTestId("list-card")).toHaveCount(10);
    await expect
      .poll(async () => (await cardGroups(page)).map((group) => group[0]))
      .toEqual(["新品"]);
    await page.getByTestId("list-next").click();
    await expect
      .poll(() => cardGroups(page))
      .toEqual([
        ["新品", "n11-新品"],
        ["良好", "r12-良好"],
      ]);
  });
});
