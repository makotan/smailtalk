/**
 * **集計表の画面の E2E**(`V8-M11-T07`。台帳 `Q-G20` / `Q-G21a` / `Q-G21b` / `Q-G12`。
 * ユーザ決定 `D-V8-129` / `D-V8-130`。判定方法は `v8-m11.md` §1-0c の**決定9**)。
 *
 * ## なぜこの4本が要るのか
 *
 * **`T06`(画面)は本物のサーバに1度も当たっていない** —— **`web/test/report-view.test.tsx`
 * の 21本は `fetch` をスタブに差し替えており、「その条件で投げ直したこと」しか見ていない。**
 * **本ファイルが、本物のサーバ(`fixture-server.ts` が立てる `src/server/app.ts` そのもの)に
 * 本物のブラウザで当てる唯一の経路である。**
 *
 * ## 判定の作法(**計画文書 §8 の8 の (vi) が認めた例外の形**)
 *
 * - **「描かれるか」だけは画面で確かめてよい** —— それがこの4本である。
 * - **表に渡っている数が正しいことは `API` の側で示す** —— **本ファイルは期待値を1つも
 *   発明しない。** **同じ条件で `GET …/report` を叩いた応答を期待値にし、DOM と突き合わせる。**
 *   **画面に出た数が `API` の応答と1文字でも違えば赤くなる。**
 * - **【禁止】スクリーンショットの目視を判定に使わない**(`v3-m6` の実測でスクショ目視抽出は
 *   0/9 で全件外れた)。**このファイルは画像を1枚も撮らない。**
 *
 * ## アプリ固有の名前を1つも書かない(既存 E2E と同じ作法)
 *
 * **表・項目・画面の名前はフィクスチャから機械的に導く**(`fixture-app.ts` の doc)。
 * **集計表そのものはフィクスチャに無いので、製品の経路(`POST /api/apps/:id/diffs` の
 * `add_view`)でテストの中から足す** —— **`view-name.e2e.ts` が `name` について採ったのと
 * 同じ形である。**
 */
import { expect, type Page, test } from "@playwright/test";
import type { Field, Manifest, Table } from "../../src/kernel/types.ts";
import { buildRecord, type FixtureApp, fixture, fixturePath, provisionApp } from "./fixture-app.ts";

/** 集計表の題材にできる表(**束ねられる `select` と、合計できる `number` を持つもの**)。 */
function reportTable(manifest: Manifest): Table {
  const table = manifest.app.tables.find(
    (candidate) =>
      candidate.fields.some((field) => field.type === "select") &&
      candidate.fields.some((field) => field.type === "number"),
  );
  if (table === undefined) {
    throw new Error(`フィクスチャに select と number を併せ持つ表がありません: ${fixturePath}`);
  }
  return table;
}

function fieldOfType(table: Table, type: Field["type"]): Field {
  const field = table.fields.find((candidate) => candidate.type === type);
  if (field === undefined) {
    throw new Error(`フィクスチャが壊れています: ${table.id} に ${type} の項目がありません。`);
  }
  return field;
}

/** 集計表を1枚足す(**製品の経路**。`add_view` は追加なので既存の画面を1つも壊さない)。 */
async function addReportView(
  app: FixtureApp,
  request: Parameters<typeof provisionApp>[0],
  viewId: string,
  report: Record<string, unknown>,
  tableId: string,
): Promise<void> {
  const created = await request.post(`/api/apps/${app.appId}/diffs`, {
    headers: app.authHeaders,
    data: {
      diff_id: `d-e2e-report-${viewId}-${Date.now()}`,
      intent: "集計表の画面を1枚足して、ブラウザで開けることを確かめたい",
      operations: [
        { op: "add_view", view: { id: viewId, type: "report_view", table: tableId, report } },
      ],
    },
  });
  expect(created.status(), await created.text()).toBe(201);
}

type ReportResponse = {
  groups: { keys: { field: string; value: unknown }[]; aggregates: { value: number }[] }[];
  total_groups: number;
  totals: { type: string; field: string | null; value: number }[];
};

/** 上限に当たったときの応答(**`errors[].message` が、どの上限に当たったかを名乗る**)。 */
type ReportLimitResponse = { errors: { message: string; hint?: string }[] };

/**
 * **同じ条件で `API` を叩く**(期待値の出どころ)。
 *
 * **画面は必ず `limit=100` を載せて読む**(`ReportViewRenderer` の `REPORT_PAGE_SIZE`)ので、
 * **突き合わせる `API` 呼び出しにも同じクエリを載せる。**
 */
async function apiReport(
  app: FixtureApp,
  request: Parameters<typeof provisionApp>[0],
  viewId: string,
  query = "?limit=100",
): Promise<ReportResponse> {
  const response = await request.get(`/api/apps/${app.appId}/views/${viewId}/report${query}`, {
    headers: app.authHeaders,
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as ReportResponse;
}

/** `API` の1群を、画面のセルの並び(束ねるキー → 集計値)に写す。 */
function expectedCells(group: ReportResponse["groups"][number]): string[] {
  return [
    ...group.keys.map((key) => (key.value === null ? "(値なし)" : String(key.value))),
    ...group.aggregates.map((aggregate) => String(aggregate.value)),
  ];
}

/** 画面に出ている行(セルの文字列の配列)。 */
async function shownRows(page: Page): Promise<string[][]> {
  return await page
    .locator('[data-testid="report-row"]')
    .evaluateAll((rows) =>
      rows.map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent ?? "")),
    );
}

const table = reportTable(fixture);
const groupField = fieldOfType(table, "select");
const sumField = fieldOfType(table, "number");
/**
 * **束ねると群をいくらでも増やせる項目**(`V8-M12-T06` の (E-12) が使う)。
 *
 * **`select` は選択肢の数だけしか群を作れない**(このフィクスチャでは3群)。
 * **`_id` なら行の数だけ群ができるが、見出しが生の UUID(36字)になり、
 * 横軸のラベルは間引いた後でも重なる** —— **日付を1日ずつずらせば、短い見出し
 * (`2026-01-01`)の群を好きな数だけ作れる。**
 */
const dateField = fieldOfType(table, "date");

/** 束ねるキー1本 + 集計2本(合計と件数)。**3群できる題材である。** */
const simpleReport = {
  group_by: [{ field: groupField.id }],
  aggregates: [{ type: "sum", field: sumField.id }, { type: "count" }],
};

/** 題材の行を作る(**値はフィールドの型から機械的に導く**。`buildRecord` そのまま)。 */
function rows(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_unused, index) => buildRecord(table, index, new Map()));
}

// =====================================================================================
// (E-1) 描かれること —— **本物のサーバに本物のブラウザで当てる**
// =====================================================================================
test("集計表の画面が、本物のサーバに当てたときに表として描かれる", async ({ page, request }) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());
  for (const values of rows(6)) {
    await app.createRecord(table.id, values);
  }
  const viewId = `${table.id}-report-drawn`;
  await addReportView(app, request, viewId, simpleReport, table.id);

  await page.goto(`/apps/${app.appId}/views/${viewId}`);

  // **画面が「まだ表示できません」で終わらない**(着手前の `ViewHost` の知らせ)。
  await expect(page.getByTestId("view-renderer-report_view")).toBeVisible();
  await expect(page.getByTestId("report-error")).toHaveCount(0);

  // **表として描かれる** —— `<table>` / `<thead>` / `<tbody>` / `<th>` / `<td>` が実在する。
  const frame = page.getByTestId("report-table");
  await expect(frame).toBeVisible();
  await expect(frame.locator("table")).toHaveCount(1);
  await expect(frame.locator("thead tr")).toHaveCount(1);
  // 列は「束ねるキー1本 + 集計2本」= 3本ちょうど。
  await expect(frame.locator("thead th")).toHaveCount(3);
  await expect(frame.locator("tbody tr")).toHaveCount(3);
  await expect(frame.locator("tbody tr").first().locator("td")).toHaveCount(3);

  // **見出しには項目の表示名が出る**(ID ではない)。
  await expect(frame.locator("thead th").first()).toContainText(groupField.name);

  // **群が本当に0件のときの知らせは出ていない**(`Q-G18` の取り違えを起こしていない)。
  await expect(page.getByTestId("report-empty")).toHaveCount(0);
});

// =====================================================================================
// (E-2) 数の一致 —— **期待値は `API` の応答である**(§8 の8 の (vi))
// =====================================================================================
test("表に出ている数と全体の合計が、同じ条件で API を叩いた応答と一致する", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());
  for (const values of rows(6)) {
    await app.createRecord(table.id, values);
  }
  const viewId = `${table.id}-report-numbers`;
  await addReportView(app, request, viewId, simpleReport, table.id);

  await page.goto(`/apps/${app.appId}/views/${viewId}`);
  await expect(page.getByTestId("report-table")).toBeVisible();

  const reported = await apiReport(app, request, viewId);
  // **画面の行 = `API` の群**(順序も値も1文字違わない)。
  expect(await shownRows(page)).toEqual(reported.groups.map(expectedCells));

  // **全体の合計も `API` の `totals` そのものである** —— 画面で足し直していない。
  const totals = page.getByTestId("report-totals");
  for (const total of reported.totals) {
    await expect(totals).toContainText(String(total.value));
  }
  // **ページを切る前の全体の群数が、画面の文言にそのまま出る**(`D-V8-129`)。
  await expect(page.getByTestId("report-total-scope")).toContainText(String(reported.total_groups));
});

// =====================================================================================
// (E-3) 列の見出しを**実際に押す** —— 並びが変わり、`API` の応答と一致する
// =====================================================================================
test("列の見出しを押すと並びが変わり、並んだ順序が API の応答と一致する", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());
  for (const values of rows(6)) {
    await app.createRecord(table.id, values);
  }
  const viewId = `${table.id}-report-sort`;
  await addReportView(app, request, viewId, simpleReport, table.id);

  await page.goto(`/apps/${app.appId}/views/${viewId}`);
  await expect(page.getByTestId("report-table")).toBeVisible();

  const header = page.locator("thead th").first();
  await expect(header).toHaveAttribute("aria-sort", "none");

  // --- 1回押す = 昇順 ---------------------------------------------------------
  await page.getByTestId("report-sort").first().click();
  await expect(header).toHaveAttribute("aria-sort", "ascending");
  const ascending = await apiReport(
    app,
    request,
    viewId,
    "?limit=100&sort_target=group_by&sort_index=0&sort_order=asc",
  );
  await expect(page.locator('[data-testid="report-row"] td:first-child')).toHaveText(
    ascending.groups.map((group) => expectedCells(group)[0] ?? ""),
  );

  // --- もう1回押す = 降順(同じ列なら向きが反転する) --------------------------
  await page.getByTestId("report-sort").first().click();
  await expect(header).toHaveAttribute("aria-sort", "descending");
  const descending = await apiReport(
    app,
    request,
    viewId,
    "?limit=100&sort_target=group_by&sort_index=0&sort_order=desc",
  );
  await expect(page.locator('[data-testid="report-row"] td:first-child')).toHaveText(
    descending.groups.map((group) => expectedCells(group)[0] ?? ""),
  );
  // **並べ替えても群の数は1つも変わらない**(`having` を持たない。`ADR-0104` 限定9)。
  expect(descending.total_groups).toBe(ascending.total_groups);
  // **降順の並びは昇順の逆である**(値が空の群はこの題材に無い)。
  expect(descending.groups.map(expectedCells)).toEqual(
    [...ascending.groups].reverse().map(expectedCells),
  );
});

// =====================================================================================
// (E-4) 「次へ」を**実際に押す** —— ページが送れ、送った先が `API` の応答と一致する
// =====================================================================================
test("「次へ」を押すとページが送れ、送った先の群と全体の合計が API の応答と一致する", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());

  // **1ページ(100群)を超える題材を作る** —— **行そのもの(`_id`)で束ねると
  // 群の数は行数と等しい。** **1回のバッチ(1つのトランザクション)で入れる。**
  const batch = await request.post(`/api/apps/${app.appId}/batch`, {
    headers: app.authHeaders,
    data: {
      ops: rows(101).map((values) => ({ op: "create", table: table.id, values })),
    },
  });
  expect(batch.status(), await batch.text()).toBe(200);

  const viewId = `${table.id}-report-pager`;
  await addReportView(
    app,
    request,
    viewId,
    {
      group_by: [{ field: "_id" }],
      aggregates: [{ type: "sum", field: sumField.id }, { type: "count" }],
    },
    table.id,
  );

  await page.goto(`/apps/${app.appId}/views/${viewId}`);
  await expect(page.getByTestId("report-table")).toBeVisible();

  const first = await apiReport(app, request, viewId, "?limit=100");
  expect(first.total_groups).toBe(101);
  // 1ページ目は 100群ちょうど(**既定の `limit` はサーバにもあるが、画面は明示して渡す**)。
  await expect(page.locator('[data-testid="report-row"]')).toHaveCount(100);
  expect(await shownRows(page)).toEqual(first.groups.map(expectedCells));
  await expect(page.getByTestId("report-prev")).toBeDisabled();
  await expect(page.getByTestId("report-next")).toBeEnabled();

  // --- 「次へ」を押す ---------------------------------------------------------
  await page.getByTestId("report-next").click();
  await expect(page.locator('[data-testid="report-row"]')).toHaveCount(1);
  const second = await apiReport(app, request, viewId, "?limit=100&offset=100");
  expect(await shownRows(page)).toEqual(second.groups.map(expectedCells));
  await expect(page.getByTestId("report-next")).toBeDisabled();
  await expect(page.getByTestId("report-prev")).toBeEnabled();

  // **全体の合計はページを切る**前**の値のままである**(`D-V8-122` / `D-V8-129`)——
  // **2ページ目に出ている1群ぶんの合計ではない。**
  const totals = page.getByTestId("report-totals");
  for (const total of second.totals) {
    await expect(totals).toContainText(String(total.value));
  }
  expect(second.totals).toEqual(first.totals);
  await expect(page.getByTestId("report-total-scope")).toContainText(String(second.total_groups));

  // --- 「前へ」で戻れる -------------------------------------------------------
  await page.getByTestId("report-prev").click();
  await expect(page.locator('[data-testid="report-row"]')).toHaveCount(100);
  await expect(page.getByTestId("report-prev")).toBeDisabled();
});

// =====================================================================================
// **【`V8-M12-T06` の追記。ここから下がグラフの実証である】**
//
// **上の (E-1)〜(E-4) を1バイトも書き換えていない**(テスト名も1つも変えていない)。
//
// ## この節が引き受けたもの
//
// - **`T04` は本物のブラウザに1度も当たっていない** —— **`web/test/report-view.test.tsx`
//   は happy-dom であり、`var(--…)` は1つも解決されない**(属性の文字列のまま残る)。
//   **「テーマの色が本当に棒と線に届いているか」は、ここでしか測れない。**
// - **`T04` が「実測で hover を打っても1文字も出なかった」と書いた折れ線のツールチップ**を、
//   **chromium で打ち直す**((E-7))。
// - **`v8-m11.md` §5 の 2 の持ち越し(上限に当たったときの画面)**((E-9))。
//
// ## この節が**していない**こと
//
// - **描画の所要時間を1件も測っていない** —— **実 CI の `e2e` は `timeout-minutes: 10` で、
//   毎回 `playwright install` と `build:web` を回す。** **群1,000の台を毎回作ると窓を食う。**
//   **計測は使い捨てのスクリプトで行い、実数は `v8-m12.md` に書く**(`T06` の (iii))。
// - **スクリーンショットを1枚も撮っていない**(上の doc の【禁止】と同じ)。
// =====================================================================================

/** 折れ線の宣言(**種別だけが `simpleReport` と違う**)。 */
const lineReport = { ...simpleReport, chart: "line" as const };
/** 棒の宣言(**省略時も棒だが、ここは「書いたときに棒になる」ほうを測る**)。 */
const barReport = { ...simpleReport, chart: "bar" as const };

/**
 * **グラフから測った実測値**(**1度の `evaluate` で採る** —— 2度に分けると、
 * 測った瞬間が違う2つの値を突き合わせることになる)。
 */
type ChartMeasurement = {
  svgCount: number;
  /** 棒(`rect`)。**系列の番号・`fill` 属性・ブラウザが解決した色・説明**。 */
  bars: {
    series: number;
    fillAttr: string;
    computedFill: string;
    slotColor: string;
    title: string;
  }[];
  /** 折れ線(`path`)。**`d` はそのまま持って帰り、突き合わせは呼び出し側で行う。** */
  paths: {
    strokeAttr: string;
    computedStroke: string;
    slotColor: string;
    fillAttr: string;
    d: string;
  }[];
  /** 点(`circle`)の数。 */
  circleCount: number;
  /** 凡例の項目の文字列と、色見本のブラウザが解決した地色。 */
  legend: { label: string; swatch: string }[];
};

/**
 * **グラフを1度だけ読む。**
 *
 * **`var(--…)` の解決は、グラフの中に置いた使い捨ての `span` で行う** ——
 * **カスタムプロパティは `.app-theme` の内側でしか値を持たないので、`document.body` 直下に
 * 置いた要素では解決できない**(`web/e2e/overlay.e2e.ts` が採ったのと同じ形)。
 * **色の実値(16進も `rgb()` も)をこのファイルに1文字も書いていない。**
 */
async function measureChart(page: Page): Promise<ChartMeasurement> {
  return await page.getByTestId("report-chart").evaluate((node) => {
    const probe = document.createElement("span");
    node.appendChild(probe);
    /** その CSS 値をブラウザに解決させる(**`var()` はここで初めて色になる**)。 */
    const resolve = (value: string): string => {
      probe.style.color = "";
      probe.style.color = value;
      return getComputedStyle(probe).color;
    };
    const bars = [...node.querySelectorAll('[data-testid="report-chart-bar"]')].map((bar) => {
      const fillAttr = bar.getAttribute("fill") ?? "";
      return {
        series: Number(bar.getAttribute("data-report-series")),
        fillAttr,
        computedFill: getComputedStyle(bar).fill,
        slotColor: resolve(fillAttr),
        title: bar.querySelector("title")?.textContent ?? "",
      };
    });
    const paths = [...node.querySelectorAll("svg path")].map((path) => {
      const strokeAttr = path.getAttribute("stroke") ?? "";
      return {
        strokeAttr,
        computedStroke: getComputedStyle(path).stroke,
        slotColor: resolve(strokeAttr),
        fillAttr: path.getAttribute("fill") ?? "",
        d: path.getAttribute("d") ?? "",
      };
    });
    const legend = [...node.querySelectorAll('[data-testid="report-chart-legend-item"]')].map(
      (item) => ({
        label: item.textContent ?? "",
        swatch: getComputedStyle(
          item.querySelector('[data-testid="report-chart-legend-swatch"]') as Element,
        ).backgroundColor,
      }),
    );
    probe.remove();
    return {
      svgCount: node.querySelectorAll("svg").length,
      bars,
      paths,
      circleCount: node.querySelectorAll("svg circle").length,
      legend,
    };
  });
}

/** 集計の列の見出し(**表の `<th>` そのもの**。束ねるキーの列を除いた後ろ側)。 */
async function aggregateHeaders(page: Page, groupByCount: number): Promise<string[]> {
  return (await page.locator("thead th").allTextContents()).slice(groupByCount);
}

/**
 * **横軸のラベルの実測**(`V8-M12-T06` の (E-12)。メインの裁定「直す1」)。
 *
 * **文字の**幅**を読む唯一の場所である** —— **happy-dom は幅を1ミリも計算しないので、
 * 単体では「10本になった」までしか言えず、「重ならなくなった」は言えない。**
 * **横軸のラベルは `text-anchor="middle"`、縦軸の目盛りは `"end"` で描き分かれている**
 * (`@nivo/axes`。実測)—— **その1つで縦軸の数と混ざらずに拾える。**
 */
async function measureAxisBottom(
  page: Page,
): Promise<{ labels: string[]; overlaps: number; pitch: number }> {
  return await page.getByTestId("report-chart").evaluate((node) => {
    const boxes = [...(node.querySelector("svg")?.querySelectorAll("text") ?? [])]
      .filter((text) => text.getAttribute("text-anchor") === "middle")
      .map((text) => {
        const rect = text.getBoundingClientRect();
        return { x: rect.x, width: rect.width, text: text.textContent ?? "" };
      })
      .sort((left, right) => left.x - right.x);
    let overlaps = 0;
    for (let index = 1; index < boxes.length; index += 1) {
      const previous = boxes[index - 1];
      const current = boxes[index];
      if (
        previous !== undefined &&
        current !== undefined &&
        previous.x + previous.width > current.x
      ) {
        overlaps += 1;
      }
    }
    const first = boxes[0];
    const last = boxes.at(-1);
    return {
      labels: boxes.map((box) => box.text),
      overlaps,
      pitch:
        boxes.length > 1 && first !== undefined && last !== undefined
          ? (last.x - first.x) / (boxes.length - 1)
          : 0,
    };
  });
}

/** 群1つを、その6行の題材から作る。**題材は既存の (E-1) と同じ 6行である。** */
async function seedRows(app: FixtureApp, count: number): Promise<void> {
  for (const values of rows(count)) {
    await app.createRecord(table.id, values);
  }
}

// =====================================================================================
// (E-5) **棒が実際に描かれ、色がブラウザで解決されている**
//
// **これが「テーマの色が本当に届いている」ことの唯一の証拠である** ——
// **happy-dom では `fill` が `var(--color-danger)` という文字列のまま残り、
// 色になったかどうかを1ミリも見ていない。**
// =====================================================================================
test("棒グラフが描かれ、棒の色が var() のままではなくブラウザが解決した色になっている", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());
  await seedRows(app, 6);
  const viewId = `${table.id}-report-chart-bar`;
  await addReportView(app, request, viewId, barReport, table.id);

  await page.goto(`/apps/${app.appId}/views/${viewId}`);
  const chart = page.getByTestId("report-chart");
  await expect(chart).toBeVisible();
  // **種別は宣言そのままである**(`"bar"` と書いたら棒)。
  await expect(chart).toHaveAttribute("data-report-chart", "bar");
  await expect(page.getByTestId("report-error")).toHaveCount(0);

  const reported = await apiReport(app, request, viewId);
  const seriesCount = simpleReport.aggregates.length;
  const measured = await measureChart(page);

  // **`svg` が実在し、1枚だけである**(`ADR-0007:1467` の限定4「1つの集計表に置けるグラフは1つ」)。
  expect(measured.svgCount).toBe(1);
  // **棒の数は「群の数 × 系列の数」ちょうどである。**
  expect(reported.groups.length).toBeGreaterThan(0);
  expect(measured.bars.length).toBe(reported.groups.length * seriesCount);

  for (const bar of measured.bars) {
    // **生成側は `var(--…)` の文字列しか書いていない**(色の実値を1文字も持たない)。
    expect(bar.fillAttr).toMatch(/^var\(--[a-z0-9-]+\)$/);
    // **ブラウザが解決した色になっている** —— **`var(` のまま残っていない。**
    expect(bar.computedFill).toMatch(/^rgba?\(/);
    expect(bar.computedFill).not.toContain("var(");
    // **解決先は、そのスロットをブラウザに引かせた値そのものである。**
    expect(bar.computedFill).toBe(bar.slotColor);
  }
  // **系列ごとに色が割れている**(全部同じ色なら「色が届いた」と言えない)。
  const colorsBySeries = new Map<number, Set<string>>();
  for (const bar of measured.bars) {
    const set = colorsBySeries.get(bar.series) ?? new Set<string>();
    set.add(bar.computedFill);
    colorsBySeries.set(bar.series, set);
  }
  expect([...colorsBySeries.keys()].sort()).toEqual([...Array(seriesCount).keys()]);
  for (const set of colorsBySeries.values()) {
    expect(set.size).toBe(1);
  }
  const distinct = new Set([...colorsBySeries.values()].map((set) => [...set][0]));
  expect(distinct.size).toBe(seriesCount);
});

// =====================================================================================
// (E-6) **折れ線が描かれ、線の色がブラウザで解決されている**
// =====================================================================================
test("折れ線グラフが描かれ、線の本数が系列の数と一致し、色がブラウザが解決した色になっている", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());
  await seedRows(app, 6);
  const viewId = `${table.id}-report-chart-line`;
  await addReportView(app, request, viewId, lineReport, table.id);

  await page.goto(`/apps/${app.appId}/views/${viewId}`);
  const chart = page.getByTestId("report-chart");
  await expect(chart).toBeVisible();
  await expect(chart).toHaveAttribute("data-report-chart", "line");

  const reported = await apiReport(app, request, viewId);
  const seriesCount = simpleReport.aggregates.length;
  const measured = await measureChart(page);

  expect(measured.svgCount).toBe(1);
  // **棒は1本も無い**(種別で描き分かれている)。
  expect(measured.bars).toHaveLength(0);
  // **`path` の本数 = 系列の数**(軸も目盛りも `line` 要素であり `path` にならない)。
  expect(measured.paths).toHaveLength(seriesCount);
  // **点は「群の数 × 系列の数」ある。**
  expect(measured.circleCount).toBe(reported.groups.length * seriesCount);

  for (const path of measured.paths) {
    expect(path.fillAttr).toBe("none");
    expect(path.strokeAttr).toMatch(/^var\(--[a-z0-9-]+\)$/);
    expect(path.computedStroke).toMatch(/^rgba?\(/);
    expect(path.computedStroke).not.toContain("var(");
    expect(path.computedStroke).toBe(path.slotColor);
  }
  // **2本の線が同じ色で描かれていない。**
  expect(new Set(measured.paths.map((path) => path.computedStroke)).size).toBe(seriesCount);
});

// =====================================================================================
// (E-7) **折れ線のツールチップ**(`T04` からの持ち越し。**メインの裁定「直す2」で出るようになった**)
//
// ## ここに至るまでの実測(**隠さない**)
//
// 1. **`T04` は happy-dom で1件も測れなかった**(当たり判定が `getBoundingClientRect` に依り、
//    happy-dom は全部 0 を返す)。**実証は `T06`(chromium)の担当と書かれた。**
// 2. **`T06` が chromium で打ったところ、それでも1文字も出なかった** —— **原因は当たり判定の
//    精度ではなく、当たり判定を持つ層が1つも描かれていなかったことである。**
//    **`@nivo/line@0.99.0` の svg 既定は `useMesh: false` である**(`svgDefaultProps`)。
// 3. **メインの裁定「直す2」で `useMesh` を `true` にした** —— **`mesh` 層
//    (`<rect data-ref="mesh-interceptor">`)が描かれ、点に寄せると出るようになった。**
//    **`enableSlices` / `isFocusable` は1つも触っていない。**
//
// ## **【正直に書く】ツールチップに群の名前は出ない。出るのは群の位置の番号である**
//
// **実測の文面は `x: 1, y: 5` である** —— **`x` は群の**位置の番号**であって、
// 群の見出し(`新品` など)ではない。** **横軸の値に位置の番号を使っているためであり
// (`chartRows` の doc。同じ文字列の群が2つあっても1本に潰れないようにするため)、
// `xFormat` を1つも渡していないので番号がそのまま出る。**
// **【直していない】** —— **裁定は「`useMesh` を `true` にする。それ以上のことはしない」である。**
//
// ## **説明の出し方が、棒と折れ線で割れている**(**色の渡し方が割れているのと同じ系列の事実**)
//
// - **棒**: **SVG の `<title>`**。**`群の見出し・系列の見出し: 値`** が出る((E-9) が突き合わせる)。
// - **折れ線**: **`@nivo` のツールチップ**。**`x: 位置の番号, y: 値`** が出る。
//
// **したがって、同じ数を指しても出てくる文面が2種で違う** —— **群の名前が出るのは棒だけ、
// マウスを寄せるだけで出るのは折れ線だけである**(`<title>` はブラウザの既定の遅延を待つ)。
// **`ReportViewRenderer.tsx` の冒頭の追記節に、色の渡し方が割れている理由と同じ場所で書いてある。**
// =====================================================================================
test("折れ線の点にマウスを寄せると、ツールチップに API の値が出る(useMesh を足して出るようになった)", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());
  await seedRows(app, 6);
  const viewId = `${table.id}-report-chart-hover`;
  await addReportView(app, request, viewId, lineReport, table.id);

  await page.goto(`/apps/${app.appId}/views/${viewId}`);
  await expect(page.getByTestId("report-chart")).toBeVisible();

  // **当たり判定の層が実在する**(`useMesh` を足す前は0件だった)。
  const mesh = page.locator('[data-testid="report-chart"] svg rect[data-ref="mesh-interceptor"]');
  await expect(mesh).toHaveCount(1);

  const reported = await apiReport(app, request, viewId);
  const measured = await measureChart(page);
  /** 1本目の系列の名前(**点の `data-testid` は `line.point.<系列名>.<群の位置>`**)。 */
  const seriesLabel = measured.legend[0]?.label ?? "";
  expect(seriesLabel).not.toBe("");

  /** ツールチップの器(**`@nivo/tooltip` は class を1つも付けないので、体裁で指す**)。 */
  const tooltip = page.locator('[data-testid="report-chart"] div[style*="position: absolute"]');
  await expect(tooltip).toHaveCount(0);

  /*
   * **群の真ん中の点に寄せる**(**両端は `mesh` の矩形の境界そのものに載るので外す**)。
   * **`steps` を刻んで動かす** —— **1回の跳躍では `mesh` に `mousemove` が届かないことが
   * あった**(実測。刻むと毎回出る)。**`locator.hover()` は使わない**((E-7) の旧文と
   * 同じ理由 —— 格子の `<line>` が点に重なると 30 秒待ち続ける)。
   */
  const middle = Math.floor(reported.groups.length / 2);
  const target = page.locator(`[data-testid="line.point.${seriesLabel}.${middle}"]`);
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(
    (box?.x ?? 0) + (box?.width ?? 0) / 2,
    (box?.y ?? 0) + (box?.height ?? 0) / 2,
    { steps: 8 },
  );

  // **出る。** **中身は `API` の応答の値そのものである**(このテストは数を1つも発明しない)。
  await expect(tooltip).toHaveCount(1);
  const expectedValue = reported.groups[middle]?.aggregates[0]?.value;
  expect(expectedValue).not.toBeUndefined();
  await expect(tooltip).toContainText(`y: ${expectedValue}`);
  // **群の名前は出ない**(上の doc)—— **出るのは位置の番号である。**
  await expect(tooltip).toContainText(`x: ${middle}`);
});

// =====================================================================================
// (E-8) **凡例** —— 項目の数が系列の数と一致し、色が系列と同じ**実際の**色である
// =====================================================================================
test("凡例の項目が系列の数だけ出て、色見本が棒と同じブラウザ解決済みの色である", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());
  await seedRows(app, 6);
  const viewId = `${table.id}-report-chart-legend`;
  await addReportView(app, request, viewId, barReport, table.id);

  await page.goto(`/apps/${app.appId}/views/${viewId}`);
  await expect(page.getByTestId("report-chart")).toBeVisible();
  const seriesCount = simpleReport.aggregates.length;
  const measured = await measureChart(page);

  // **凡例は系列の数だけ出る。**
  await expect(page.getByTestId("report-chart-legend")).toBeVisible();
  expect(measured.legend).toHaveLength(seriesCount);
  // **凡例の文字列は、表の集計列の見出しそのものである**(2本目の見出しを作っていない)。
  expect(measured.legend.map((item) => item.label)).toEqual(
    await aggregateHeaders(page, simpleReport.group_by.length),
  );
  // **色見本の地色は、同じ系列の棒の色と1文字も違わない。**
  for (const [seriesIndex, item] of measured.legend.entries()) {
    const bar = measured.bars.find((candidate) => candidate.series === seriesIndex);
    expect(bar).toBeDefined();
    expect(item.swatch).toMatch(/^rgba?\(/);
    expect(item.swatch).toBe(bar?.computedFill);
  }
});

// =====================================================================================
// (E-9) **グラフに渡っている数が `API` の応答と一致する**
//
// **【重要。画面で「そう見える」で終わらせない】** **期待値は `API` の応答だけから作る** ——
// **このテストは数を1つも発明しない。**
//
// - **棒**: **`<title>`(SVG の既定の説明)に「群の見出し・系列の見出し: 値」が出る。**
//   **その文字列を `API` の群と集計値から組み立てて突き合わせる。**
// - **折れ線**: **値は `d` 属性の座標にしか出ない。** **`@nivo/line` の縦軸の既定
//   (`{type:"linear", min:0, max:"auto"}`)から、`y = 内側の高さ × (1 - 値 ÷ 最大値)` を
//   `API` の値だけで計算し、描かれた座標と突き合わせる。**
//   **【この計算は `@nivo` の既定に依っている】** —— **既定が動けばここが赤くなる。
//   それでよい。** **座標を読まずに「線が引かれた」だけを見ると、`API` の数と線が
//   1ミリも結びつかない。**
// =====================================================================================
test("棒の説明と折れ線の座標に出ている数が、同じ条件で API を叩いた応答と一致する", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());
  await seedRows(app, 6);

  /*
   * **書式の前提を、測る前に固定する**(`aggregateText` = `formatNumber` + 単位)。
   * **この題材の集計値は5桁未満で、単位を持つ項目も無い** —— したがって
   * **`String(値)` がそのまま画面の文字列である。** **前提が崩れたらここで赤くなる。**
   */
  expect(sumField.type === "number" ? sumField.unit : "型が number でない").toBeUndefined();

  const barViewId = `${table.id}-report-chart-bar-numbers`;
  await addReportView(app, request, barViewId, barReport, table.id);
  await page.goto(`/apps/${app.appId}/views/${barViewId}`);
  await expect(page.getByTestId("report-chart")).toBeVisible();

  const reported = await apiReport(app, request, barViewId);
  const headers = await aggregateHeaders(page, simpleReport.group_by.length);
  for (const group of reported.groups) {
    for (const aggregate of group.aggregates) {
      expect(Math.abs(aggregate.value)).toBeLessThan(10_000);
    }
  }

  // --- 表とグラフは同じ `API` の応答から出ている ---------------------------------
  expect(await shownRows(page)).toEqual(reported.groups.map(expectedCells));

  const barMeasured = await measureChart(page);
  const expectedTitles = reported.groups
    .flatMap((group) =>
      group.aggregates.map((aggregate, seriesIndex) => {
        const label = expectedCells(group)[0] ?? "";
        return `${label}・${headers[seriesIndex] ?? ""}: ${aggregate.value}`;
      }),
    )
    .sort();
  expect(barMeasured.bars.map((bar) => bar.title).sort()).toEqual(expectedTitles);

  // --- 折れ線: 座標を `API` の値から計算して突き合わせる -------------------------
  const lineViewId = `${table.id}-report-chart-line-numbers`;
  await addReportView(app, request, lineViewId, lineReport, table.id);
  await page.goto(`/apps/${app.appId}/views/${lineViewId}`);
  await expect(page.getByTestId("report-chart")).toBeVisible();
  const lineMeasured = await measureChart(page);

  /** グラフの内側の高さ(`ReportViewRenderer` の `CHART_HEIGHT` − 上下の余白)。 */
  const innerHeight = 320 - 8 - 56;
  const maxValue = Math.max(
    ...reported.groups.flatMap((group) => group.aggregates.map((aggregate) => aggregate.value)),
  );
  expect(maxValue).toBeGreaterThan(0);

  /**
   * **どの `path` がどの系列か**は、**凡例の色見本と線の色を突き合わせて決める** ——
   * **`@nivo/line` は系列を逆順に描くので、DOM の並びで決めると系列が入れ替わる。**
   */
  for (const [seriesIndex, legendItem] of lineMeasured.legend.entries()) {
    const path = lineMeasured.paths.find(
      (candidate) => candidate.computedStroke === legendItem.swatch,
    );
    expect(path, `系列 ${seriesIndex} の線が見つからない`).toBeDefined();
    const drawn = (path?.d ?? "")
      .split(/[ML]/)
      .filter((chunk) => chunk.length > 0)
      .map((chunk) => Number(chunk.split(",")[1]));
    const expectedY = reported.groups.map(
      (group) => innerHeight * (1 - (group.aggregates[seriesIndex]?.value ?? 0) / maxValue),
    );
    expect(drawn).toHaveLength(expectedY.length);
    for (const [index, value] of expectedY.entries()) {
      expect(drawn[index]).toBeCloseTo(value, 2);
    }
  }
});

// =====================================================================================
// (E-10) **群が0件のとき** —— グラフも凡例も1つも出ない(**表の空の知らせだけ**)
// =====================================================================================
test("群が0件のときは、グラフも凡例も1つも描かれず、空の知らせだけが出る", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());
  // **行を1件も作らない。**
  const viewId = `${table.id}-report-chart-empty`;
  await addReportView(app, request, viewId, barReport, table.id);

  await page.goto(`/apps/${app.appId}/views/${viewId}`);
  await expect(page.getByTestId("view-renderer-report_view")).toBeVisible();

  const reported = await apiReport(app, request, viewId);
  expect(reported.groups).toHaveLength(0);
  expect(reported.total_groups).toBe(0);

  // **「集計した結果が0件だった」ことは知らせとして出る**(エラーではない)。
  await expect(page.getByTestId("report-empty")).toBeVisible();
  await expect(page.getByTestId("report-error")).toHaveCount(0);
  // **グラフ・凡例・棒・表は1つも無い。**
  await expect(page.getByTestId("report-chart")).toHaveCount(0);
  await expect(page.getByTestId("report-chart-legend")).toHaveCount(0);
  await expect(page.locator('[data-testid="report-chart-bar"]')).toHaveCount(0);
  await expect(page.getByTestId("report-table")).toHaveCount(0);
});

// =====================================================================================
// (E-11) **上限に当たったときの画面**(`v8-m11.md` §5 の 2 の持ち越し)
//
// **【正直に書く。当たるのは「群の上限」ではない】**
//
// **`src/server/report-limits.ts` は上限を2本持つ** —— **群にまとめる前に読む行が
// 10,000(`MAX_REPORT_SCANNED_ROWS`)/ 作る群が 10,000(`MAX_REPORT_GROUPS`)。
// どちらも inclusive で、超えた分だけが 400 になる。**
//
// **表が1本のとき、群の数は行の数を超えない。** **したがって群の上限に当たるには
// 10,001 群 = 少なくとも 10,001 行が要り、その時点で**行の上限が先に返る**。**
// **群の上限だけを単独で当てるには、逆方向(一対多)の結合でファンアウトさせるしかない
// —— それはこのテストの射程ではない。** **【禁止】「群の上限の画面を出した」と書かない。**
//
// **当てたのは行の上限であり、どちらに当たったかは `API` の応答の文面で確かめている**
// (`errors[].message` が上限の種別ごとに違う。`src/server/errors.ts` の `reportLimitError`)。
// =====================================================================================
test("読む行の上限を超えた集計表は 400 になり、画面に知らせが出てグラフも凡例も表も出ない", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());

  /*
   * **上限(10,000 行)ちょうどは通るので、1行だけ超える 10,001 行を作る。**
   * **1回のバッチに全部を載せず 2,000 行ずつ刻む** —— **1リクエストの本文が
   * 大きくなりすぎないためであり、上限とは関係が無い。**
   */
  const total = 10_001;
  const chunk = 2_000;
  for (let start = 0; start < total; start += chunk) {
    const size = Math.min(chunk, total - start);
    const batch = await request.post(`/api/apps/${app.appId}/batch`, {
      headers: app.authHeaders,
      data: {
        ops: Array.from({ length: size }, (_unused, index) => ({
          op: "create",
          table: table.id,
          values: buildRecord(table, start + index, new Map()),
        })),
      },
    });
    expect(batch.status(), await batch.text()).toBe(200);
  }

  const viewId = `${table.id}-report-chart-over-limit`;
  await addReportView(app, request, viewId, barReport, table.id);

  // --- `API` は 400 を返し、**どの上限か**を文面で名乗る -------------------------
  const response = await request.get(`/api/apps/${app.appId}/views/${viewId}/report?limit=100`, {
    headers: app.authHeaders,
  });
  expect(response.status()).toBe(400);
  const body = (await response.json()) as ReportLimitResponse;
  const message = body.errors[0]?.message ?? "";
  // **当たったのは「読む行」の上限であって「群」の上限ではない**(上の doc)。
  expect(message).toContain("読む行の件数");
  expect(message).not.toContain("群の数が上限");

  // --- 画面 ---------------------------------------------------------------------
  await page.goto(`/apps/${app.appId}/views/${viewId}`);
  await expect(page.getByTestId("report-error")).toBeVisible();
  // **知らせの本文はサーバの文面そのものである**(画面が言い換えていない)。
  await expect(page.getByTestId("report-error")).toContainText(message);
  // **「0件」ではないと明示している**(`Q-G18`)。
  await expect(page.getByTestId("report-error-not-zero")).toBeVisible();
  // **グラフ・凡例・棒・表・空の知らせ・ページ送りが1つも無い。**
  await expect(page.getByTestId("report-chart")).toHaveCount(0);
  await expect(page.getByTestId("report-chart-legend")).toHaveCount(0);
  await expect(page.locator('[data-testid="report-chart-bar"]')).toHaveCount(0);
  await expect(page.getByTestId("report-table")).toHaveCount(0);
  await expect(page.getByTestId("report-empty")).toHaveCount(0);
  await expect(page.getByTestId("report-pager")).toHaveCount(0);
});

// =====================================================================================
// (E-12) **横軸のラベルの間引き**(メインの裁定「直す1」。**本物のブラウザでの証拠**)
//
// **単体(`web/test/report-view.test.tsx` の (M12-T06-1)〜(M12-T06-4))は本数しか見ていない**
// —— **happy-dom は文字の幅を1ミリも計算しないので、「重なっているか」は測れない。**
// **重なりを測れるのはここだけである。**
//
// **直す前の実測(chromium)**: **群100 でラベル100本・隣り合う 99 組が全部重なっていた**
// (目盛りの間隔 5.98px)。
// =====================================================================================
test("群が100あるとき、横軸のラベルは10本に間引かれて1組も重ならず、棒は1本も減らない", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());

  /*
   * **短い見出しの群を100作る** —— **日付を1日ずつずらして `granularity: "day"` で束ねる。**
   * **`_id` で束ねると見出しが生の UUID(36字)になり、10本でも重なる**(下で別に測る)。
   */
  const batch = await request.post(`/api/apps/${app.appId}/batch`, {
    headers: app.authHeaders,
    data: {
      ops: Array.from({ length: 100 }, (_unused, index) => ({
        op: "create",
        table: table.id,
        values: {
          ...buildRecord(table, index, new Map()),
          [dateField.id]: new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10),
        },
      })),
    },
  });
  expect(batch.status(), await batch.text()).toBe(200);

  const viewId = `${table.id}-report-chart-axis`;
  await addReportView(
    app,
    request,
    viewId,
    {
      group_by: [{ field: dateField.id, granularity: "day" }],
      aggregates: [{ type: "sum", field: sumField.id }],
      chart: "bar",
    },
    table.id,
  );

  await page.goto(`/apps/${app.appId}/views/${viewId}`);
  await expect(page.getByTestId("report-chart")).toBeVisible();
  const reported = await apiReport(app, request, viewId);
  expect(reported.groups).toHaveLength(100);

  const axis = await measureAxisBottom(page);
  // **ラベルは10本ちょうど**(裁定「直す1」の 2)。
  expect(axis.labels).toHaveLength(10);
  // **隣り合うラベルが1組も重なっていない**(直す前は 99/99 が重なっていた)。
  expect(axis.overlaps).toBe(0);
  // **先頭と末尾は群の先頭と末尾そのものである。**
  expect(axis.labels[0]).toBe(expectedCells(reported.groups[0] ?? { keys: [], aggregates: [] })[0]);
  expect(axis.labels.at(-1)).toBe(
    expectedCells(reported.groups.at(-1) ?? { keys: [], aggregates: [] })[0],
  );
  // **間引いたのはラベルだけである** —— **棒は群100 × 系列1 = 100本そのまま。**
  await expect(page.locator('[data-testid="report-chart-bar"]')).toHaveCount(100);
  // **表も100行そのまま出ている**(グラフの間引きが表に1ミリも波及していない)。
  await expect(page.locator('[data-testid="report-row"]')).toHaveCount(100);
});

// =====================================================================================
// (E-13) **3本目の系列の色**(`--color-text-secondary`)
//
// **`T04` は「3本目は無彩色である。その事実を検査で固定する」と書いたが、
// happy-dom では属性の文字列しか見ていない** —— **「白地に白ではないか」は測っていない。**
// **ここが実ブラウザでの唯一の確認である。**
//
// **【正直に書く】読みやすさを測っていない** —— **見ているのは「地色と同じ色ではない」
// ことだけであり、コントラスト比を1度も計算していない。**
// =====================================================================================
test("系列が3本のとき、3本目の色も解決され、3本とも地色と違う色である", async ({
  page,
  request,
}) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());
  await seedRows(app, 6);

  const viewId = `${table.id}-report-chart-three`;
  await addReportView(
    app,
    request,
    viewId,
    {
      group_by: [{ field: groupField.id }],
      // **同じ集計を2本書ける**ので、`number` が1本しかないフィクスチャでも3系列にできる。
      aggregates: [
        { type: "sum", field: sumField.id },
        { type: "count" },
        { type: "sum", field: sumField.id },
      ],
      chart: "bar",
    },
    table.id,
  );

  await page.goto(`/apps/${app.appId}/views/${viewId}`);
  await expect(page.getByTestId("report-chart")).toBeVisible();
  const measured = await measureChart(page);
  const reported = await apiReport(app, request, viewId);

  // **系列は3本**(選ぶ口が無いので `aggregates` の全部が出る)。
  expect(measured.legend).toHaveLength(3);
  expect(measured.bars).toHaveLength(reported.groups.length * 3);

  const colors = [0, 1, 2].map(
    (seriesIndex) =>
      measured.bars.find((bar) => bar.series === seriesIndex)?.computedFill ?? "(無し)",
  );
  // **3本とも解決されていて、3本とも違う色である。**
  for (const color of colors) {
    expect(color).toMatch(/^rgba?\(/);
  }
  expect(new Set(colors).size).toBe(3);

  // **どれも地色と同じ色ではない**(**白地に白の系列になっていない**)。
  const background = await page.getByTestId("report-chart").evaluate((node) => {
    const probe = document.createElement("span");
    node.appendChild(probe);
    probe.style.color = "var(--color-page-background)";
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  });
  expect(background).toMatch(/^rgba?\(/);
  for (const color of colors) {
    expect(color).not.toBe(background);
  }
});
