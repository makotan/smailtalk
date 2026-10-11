/**
 * **役割ごとの詰め具合**(`V20-M11-T04` / `T03`(e)。`ADR-0464` / 利用者決定 `D-V20-34` / `D-V20-35`)の chromium 実測。
 *
 * **何を測るか**: **同じ画面を2つの役割で開いたときの計算値の差**である。
 * **happy-dom は CSS を1バイトも計算しない**(`web/test/role-density.test.tsx` は DOM の形しか見ない)ので、
 * **詰まっていることの実測はここにしかない。**
 *
 * - **役割**: 予約の `editor` に `density: "compact"` を書き、`customer` には何も書かない
 *   (`fixture-server.ts` が面の規則を注入する既知の役割。計画 §10 の 7)。
 * - **題材**: `st_public`(公開規約)を持つ表を1つ足し、その一覧を2人が開く —— **`customer` は
 *   運営の表(フィクスチャの `items`)を読めない**ので、両方の役割が読める表が要る。
 * - **測る要素は両方の役割に必ず出るものを testid で名指しする** —— 最初のボタンは役割で別物になる
 *   (`editor` には「新規作成」が出て `customer` には出ない)。**列見出しの並べ替えボタン(`list-sort`)/
 *   行のセル(`list-row` の `td`)/ 絞り込みの入力欄(`list-search-input`)**の3つを使う。
 * - **2人は別の `browser.newContext()`**(`owner-scope.e2e.ts` の先例)。
 *
 * **【正直に書く】行のセルの上下余白は2つの系統で同じである** —— `web/src/ui/table.tsx` の
 * `TableCell` の compact 変種は文字の大きさ(`text-xs`)だけを持つ。**「全部の軸で違う」とは書かない。**
 */
import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";
import type { Manifest } from "../../src/kernel/types.ts";
import {
  buildRecord,
  ensureReferenceTargets,
  type FixtureApp,
  provisionApp,
  seedRoleSession,
} from "./fixture-app.ts";

/** 公開規約を表すフィールド id(`src/server/owner-scope.ts` の `PUBLIC_FIELD`)。 */
const PUBLIC_FIELD = "st_public";
const TABLE_ID = "density_notices";
const TITLE_FIELD = "title";
/** 画面の詰め具合を書いていない一覧。 */
const PLAIN_VIEW = "density-notice-list";
/** 画面に `preset_density: "comfortable"` を書いた一覧(`D-V20-34` 画面の指定が勝つ)。 */
const COMFORTABLE_VIEW = "density-notice-list-comfortable";

/**
 * 公開の表と一覧2枚を足し、`editor` の役割の要素に `density` を書いた(または書かない)マニフェスト。
 *
 * **`set_roles` は全体差し替えである** —— ここでは払い出し直後のマニフェスト(面の規則が
 * 注入済み)を読み戻し、`editor` の要素に `density` だけを足して書き戻す。**規則は1本も消さない。**
 */
function withDensityFixture(manifest: Manifest, editorDensity: "compact" | undefined): Manifest {
  const next = structuredClone(manifest);
  next.app.tables.push({
    id: TABLE_ID,
    name: "お知らせ",
    fields: [
      { id: TITLE_FIELD, name: "見出し", type: "text", required: true },
      { id: PUBLIC_FIELD, name: "公開", type: "boolean" },
    ],
  });
  next.app.views.push(
    {
      id: PLAIN_VIEW,
      type: "list_view",
      table: TABLE_ID,
      columns: [TITLE_FIELD],
      search_fields: [TITLE_FIELD],
    },
    {
      id: COMFORTABLE_VIEW,
      type: "list_view",
      table: TABLE_ID,
      columns: [TITLE_FIELD],
      search_fields: [TITLE_FIELD],
      preset_density: "comfortable",
    },
  );
  const roles = next.app.roles ?? [];
  // **払い出し直後は `customer` を持たない** —— `fixture-server.ts` が `customer` の規則を注入するのは
  // 公開規約か個人所有の表が在るときだけで、フィクスチャの表はどちらも持たない。**この差し替えで
  // 公開の表を足すと、差し替えの側(`replaceManifest` → `grantFixtureRoleRules`)が `customer` を足す。**
  expect(
    roles.map((role) => role.id),
    "払い出したアプリは運営の役割を持つ(fixture-server が注入する)",
  ).toEqual(expect.arrayContaining(["editor"]));
  for (const role of roles) {
    // **どの役割にも density を書いていない**ことを先に確かめる(払い出しの既定)。
    expect(role.density, `役割 ${role.id} は払い出し直後に density を持たない`).toBeUndefined();
    if (role.id === "editor" && editorDensity !== undefined) {
      role.density = editorDensity;
    }
  }
  return next;
}

async function installFixture(
  request: APIRequestContext,
  app: FixtureApp,
  editorDensity: "compact" | undefined,
): Promise<Manifest> {
  const replaced = await request.post(`/__e2e__/apps/${app.appId}/manifest`, {
    data: withDensityFixture(app.manifest, editorDensity),
  });
  expect(replaced.status(), await replaced.text()).toBe(200);
  const applied = ((await replaced.json()) as { manifest: Manifest }).manifest;
  // **読み戻し**: 2つの役割が在り、書いた値だけが残っている(`customer` には何も書いていない)。
  const roleOf = (id: string) => applied.app.roles?.find((role) => role.id === id);
  expect(roleOf("editor"), "editor が在る").toBeDefined();
  expect(roleOf("customer"), "customer が在る(公開の表を足したので注入された)").toBeDefined();
  expect(roleOf("editor")?.density).toBe(editorDensity);
  expect(roleOf("customer")?.density).toBeUndefined();
  expect(
    (applied.app.roles ?? []).filter((role) => role.density !== undefined).length,
    "density を書いた役割の数",
  ).toBe(editorDensity === undefined ? 0 : 1);
  // 公開の行を2件(運営の既定セッション = owner で書く)。
  for (const title of ["お知らせ-1", "お知らせ-2"]) {
    await app.createRecord(TABLE_ID, { [TITLE_FIELD]: title, [PUBLIC_FIELD]: true });
  }
  return applied;
}

/** 1つの要素の計算値(寸法と色)。 */
type Measured = {
  height: string;
  paddingTop: string;
  paddingBottom: string;
  paddingLeft: string;
  fontSize: string;
  color: string;
  backgroundColor: string;
  borderColor: string;
};

type Reading = {
  sort: Measured;
  cell: Measured;
  search: Measured;
  scopes: number;
  scopeFamily: string | null;
};

/** 画面を開き、3つの要素の計算値と作用域の数を読む。 */
async function openAndRead(page: Page, appId: string, viewId: string): Promise<Reading> {
  await page.goto(`/apps/${appId}/views/${viewId}`);
  await expect(page.getByTestId("list-table")).toBeVisible();
  await expect(page.getByTestId("list-row").first()).toBeVisible();
  return await page.evaluate(() => {
    const pick = (selector: string): HTMLElement => {
      const element = document.querySelector<HTMLElement>(selector);
      if (element === null) throw new Error(`測る要素が見つからない: ${selector}`);
      return element;
    };
    const measure = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      return {
        height: style.height,
        paddingTop: style.paddingTop,
        paddingBottom: style.paddingBottom,
        paddingLeft: style.paddingLeft,
        fontSize: style.fontSize,
        color: style.color,
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
      };
    };
    const scopes = document.querySelectorAll('[data-testid="view-density-scope"]');
    return {
      sort: measure(pick('[data-testid="list-sort"]')),
      cell: measure(pick('[data-testid="list-row"] td')),
      search: measure(pick('[data-testid="list-search-input"]')),
      scopes: scopes.length,
      scopeFamily: scopes[0]?.getAttribute("data-ui-family") ?? null,
    };
  });
}

/** 色に当たる3本だけを抜く(`D-V20-17`。色は役割で変えない)。 */
function colorsOf(reading: Reading) {
  const pickColors = (measured: Measured) => ({
    color: measured.color,
    backgroundColor: measured.backgroundColor,
    borderColor: measured.borderColor,
  });
  return {
    sort: pickColors(reading.sort),
    cell: pickColors(reading.cell),
    search: pickColors(reading.search),
  };
}

/** `editor` と `customer` を別の context でログインさせ、同じ画面を開いて読む。 */
async function readBothRoles(
  browser: Browser,
  request: APIRequestContext,
  app: FixtureApp,
  viewId: string,
): Promise<{ editor: Reading; customer: Reading }> {
  const editor = await seedRoleSession(request, app.appId, "editor");
  const customer = await seedRoleSession(request, app.appId, "customer");
  const contextEditor = await browser.newContext();
  const contextCustomer = await browser.newContext();
  try {
    await editor.authenticate(contextEditor);
    await customer.authenticate(contextCustomer);
    const pageEditor = await contextEditor.newPage();
    const pageCustomer = await contextCustomer.newPage();
    const readEditor = await openAndRead(pageEditor, app.appId, viewId);
    await expect(pageEditor.getByTestId("current-role")).toHaveAttribute("data-role", "editor");
    const readCustomer = await openAndRead(pageCustomer, app.appId, viewId);
    await expect(pageCustomer.getByTestId("current-role")).toHaveAttribute("data-role", "customer");
    // **アプリ・画面・役割を指す属性を1つも新設していない**(`ADR-0118` 限定10 と同じ向き)。
    for (const page of [pageEditor, pageCustomer]) {
      expect(await page.locator("[data-app-id], [data-view-id], [data-role-density]").count()).toBe(
        0,
      );
    }
    return { editor: readEditor, customer: readCustomer };
  } finally {
    await contextEditor.close();
    await contextCustomer.close();
  }
}

test.describe("役割ごとの詰め具合(V20-M11-T04)", () => {
  test("(a)(b) 同じ一覧を editor(compact)と customer(宣言なし)で開くと、詰まり具合だけが違い色は完全一致する", async ({
    browser,
    request,
  }) => {
    const app = await provisionApp(request);
    // 書いた値が適用後のマニフェストに残っていることは `installFixture` の中で読み戻して確かめる。
    await installFixture(request, app, "compact");

    const { editor, customer } = await readBothRoles(browser, request, app, PLAIN_VIEW);
    console.log(`[role-density (a)] editor=${JSON.stringify(editor)}`);
    console.log(`[role-density (a)] customer=${JSON.stringify(customer)}`);

    // --- (a) 作用域: editor にだけ compact の器が立ち、customer には器が1つも出ない ---
    expect(editor.scopes).toBe(1);
    expect(editor.scopeFamily).toBe("compact");
    expect(customer.scopes).toBe(0);
    expect(customer.scopeFamily).toBeNull();

    // --- (a) 実際に詰まっている(差が0でない軸を1つずつ名指しで固定する)---
    expect(editor.sort.height).not.toBe(customer.sort.height);
    expect(editor.sort.fontSize).not.toBe(customer.sort.fontSize);
    expect(editor.cell.fontSize).not.toBe(customer.cell.fontSize);
    expect(editor.search.height).not.toBe(customer.search.height);
    // **【正直に書く】セルの上下余白は同じである**(`TableCell` の compact 変種は文字の大きさだけ)。
    expect(editor.cell.paddingTop).toBe(customer.cell.paddingTop);
    expect(editor.cell.paddingBottom).toBe(customer.cell.paddingBottom);
    // 向き: editor の側が小さい(px の数値で比べる)。
    const px = (value: string): number => Number.parseFloat(value);
    expect(px(editor.sort.height)).toBeLessThan(px(customer.sort.height));
    expect(px(editor.sort.fontSize)).toBeLessThan(px(customer.sort.fontSize));
    expect(px(editor.cell.fontSize)).toBeLessThan(px(customer.cell.fontSize));
    expect(px(editor.search.height)).toBeLessThan(px(customer.search.height));

    // --- (b) 色は1バイトも変わらない(色に当たる3本 × 3要素が完全一致)---
    expect(colorsOf(editor)).toEqual(colorsOf(customer));
  });

  test("(c) 画面に preset_density: comfortable を書いた一覧では、editor(compact)でも comfortable になる", async ({
    browser,
    request,
  }) => {
    const app = await provisionApp(request);
    await installFixture(request, app, "compact");

    const onComfortable = await readBothRoles(browser, request, app, COMFORTABLE_VIEW);
    const onPlain = await readBothRoles(browser, request, app, PLAIN_VIEW);
    console.log(`[role-density (c)] editor=${JSON.stringify(onComfortable.editor)}`);
    console.log(`[role-density (c)] customer=${JSON.stringify(onComfortable.customer)}`);

    // 画面の宣言が勝つ: 2人とも comfortable の器が立つ。
    expect(onComfortable.editor.scopes).toBe(1);
    expect(onComfortable.editor.scopeFamily).toBe("comfortable");
    expect(onComfortable.customer.scopes).toBe(1);
    expect(onComfortable.customer.scopeFamily).toBe("comfortable");
    // 計算値は2人で完全一致し、宣言なしの customer(= 既定)とも一致する(既定を反転させていない)。
    expect(onComfortable.editor).toEqual(onComfortable.customer);
    expect({ ...onComfortable.editor, scopes: 0, scopeFamily: null }).toEqual(onPlain.customer);
    // 同じアプリの宣言なしの画面では editor は compact のまま(画面ごとに勝ち負けが決まる)。
    expect(onPlain.editor.scopeFamily).toBe("compact");
  });

  test("(d) どの役割にも density を書いていないアプリでは、作用域が0個で計算値は今日の既定と同じ", async ({
    browser,
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await installFixture(request, app, undefined);

    const { editor, customer } = await readBothRoles(browser, request, app, PLAIN_VIEW);
    console.log(`[role-density (d)] editor=${JSON.stringify(editor)}`);
    console.log(`[role-density (d)] customer=${JSON.stringify(customer)}`);
    expect(editor.scopes).toBe(0);
    expect(customer.scopes).toBe(0);
    // 2つの役割で計算値が完全一致する(寸法も色も)。
    expect(editor).toEqual(customer);
    // **着手前(`8c56148a` の `web/src` で同じ題材を読んだ値)と完全一致する**(条件11 / `ADR-0118` 限定8)。
    expect(editor).toEqual(PRE_STATE_PLAIN_READING);

    // **`preset.e2e.ts` の (ix) と同じ読み方で、フィクスチャの一覧を owner で読む。**
    // **値は (ix) の「書かなかった画面」と同じ(`web/e2e/preset.e2e.ts` の `plain`)。**
    // (ix) は値を並べて比べるだけで数を固定していないので、本段の着手前(`8c56148a` の `web/src`)で
    // 同じ読み方で出た値をここに固定した(`docs/plan/v20/records/v20-m11-t04.md`)。
    await app.authenticate(page.context());
    const fixtureList = app.manifest.app.views.find((view) => view.type === "list_view");
    if (fixtureList === undefined) throw new Error("フィクスチャに list_view が無い");
    const table = app.tableOf(fixtureList.table);
    // (ix) の `seed(app, table, 2)` と同じ作り方で2件入れる。
    const referenceIds = await ensureReferenceTargets(app, table);
    for (let index = 0; index < 2; index += 1) {
      await app.createRecord(table.id, buildRecord(table, index, referenceIds));
    }
    await page.goto(`/apps/${app.appId}/views/${fixtureList.id}`);
    await expect(page.getByTestId("list-table")).toBeVisible();
    const ix = await page.evaluate(() => {
      const button = document.querySelector<HTMLElement>(".list-view button");
      const cell = document.querySelector<HTMLElement>(".list-table tbody td");
      if (button === null || cell === null) throw new Error("測る要素が見つからない");
      const bs = getComputedStyle(button);
      const cs = getComputedStyle(cell);
      return {
        buttonHeight: bs.height,
        buttonPaddingLeft: bs.paddingLeft,
        buttonFontSize: bs.fontSize,
        buttonBorderRadius: bs.borderTopLeftRadius,
        cellFontSize: cs.fontSize,
        scopes: document.querySelectorAll('[data-testid="view-density-scope"]').length,
      };
    });
    console.log(`[role-density (d)] ix-style=${JSON.stringify(ix)}`);
    expect(ix).toEqual(IX_PLAIN_BASELINE);
  });
});

/**
 * **`preset.e2e.ts` (ix) の読み方で、書かなかった画面を読んだ値**(本段の着手前 `8c56148a` の実測)。
 * 実測の出力は `docs/plan/v20/records/v20-m11-t04.md` に在る。
 */
const IX_PLAIN_BASELINE = {
  buttonHeight: "36px",
  buttonPaddingLeft: "12px",
  buttonFontSize: "14px",
  buttonBorderRadius: "0px",
  cellFontSize: "14px",
  scopes: 0,
};

/**
 * **本段の着手前(`8c56148a` の `web/src`)で、上の題材(公開の表の一覧・役割に density なし)を読んだ値。**
 * `editor` と `customer` で同じだった。実測の出力は `docs/plan/v20/records/v20-m11-t04.md` に在る。
 */
const PRE_STATE_PLAIN_READING: Reading = {
  sort: {
    height: "32px",
    paddingTop: "0px",
    paddingBottom: "0px",
    paddingLeft: "8px",
    fontSize: "14px",
    color: "rgb(0, 0, 0)",
    backgroundColor: "rgba(0, 0, 0, 0)",
    borderColor: "rgba(0, 0, 0, 0)",
  },
  cell: {
    height: "29px",
    paddingTop: "4px",
    paddingBottom: "4px",
    paddingLeft: "8px",
    fontSize: "14px",
    color: "rgb(0, 0, 0)",
    backgroundColor: "rgba(0, 0, 0, 0)",
    borderColor: "rgb(0, 0, 0) rgb(0, 0, 0) rgb(221, 221, 221)",
  },
  search: {
    height: "36px",
    paddingTop: "4px",
    paddingBottom: "4px",
    paddingLeft: "8px",
    fontSize: "14px",
    color: "rgb(0, 0, 0)",
    backgroundColor: "rgb(255, 255, 255)",
    borderColor: "rgb(221, 221, 221)",
  },
  scopes: 0,
  scopeFamily: null,
};
