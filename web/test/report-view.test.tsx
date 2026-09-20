/**
 * **集計表を画面に描く**(`V8-M11-T06` / `T07`。台帳 `Q-G20` / `Q-G21a` / `Q-G12` / `Q-G21b`。
 * ユーザ決定 `D-V8-129` / `D-V8-130`)。
 *
 * **着手前、`web/` は集計表の `API` を1度も呼んでいなかった**(`web/src/api.ts` に `report` の
 * 綴りが0件)。**`web/src/views/ViewHost.tsx` は「この画面はまだ表示できません」という
 * `Alert` を返すだけだった。** **本ファイルはその `Alert` の差し替え先を見る。**
 *
 * ## このファイルが固定すること
 *
 * | # | 何を | どう見るか |
 * |---|---|---|
 * | (T06-1) | **表に載っている数が `API` の応答と一致する** | 見出し・行数・セルの文字列 |
 * | (T06-2) | **列の見出しを押すと3つのクエリがそろって飛ぶ** | 飛んだ URL |
 * | (T06-3) | **同じ列をもう一度押すと向きが反転する** | 続けて押して URL を読む |
 * | (T06-4) | **集計列を押すと `sort_target=aggregate` になる** | 飛んだ URL |
 * | (T06-5) | **「次へ」で `offset` が動く**(既定は先頭100群) | 飛んだ URL |
 * | (T06-6) | **画面の上の合計は、ページを切る**前**の値である** | `totals` / `total_groups` |
 * | (T06-7) | **上限の 400 を「0件」として描かない** | 表が1つも無く、知らせが出る |
 * | (T06-8) | **上限の知らせに表の名前が1バイトも出ない** | 知らせの文字列 |
 * | (T06-9) | **401 / 403 も「0件」にしない** | 表が1つも無く、知らせが出る |
 * | (T06-10) | **リロード相当で並べ替えもページ位置も消える**(決定12) | 描き直して URL を読む |
 * | (T06-11) | **画面の実装に色のリテラルが1バイトも無い**(`ADR-0094` 限定7) | ソースを読む |
 *
 * ## このファイルが証明しないこと(**先に書く。誇張しない**)
 *
 * 1. **実際に並び替わることを1件も測っていない。** **並べ替えるのはサーバ(カーネル)であり、
 *    ここが見ているのは「**その条件でサーバに投げ直した**」ことだけである**
 *    (`web/test/interactive-sort.test.tsx` が一覧について同じ限界を書いている)。
 *    **順序そのものの実測は `src/server/report-declaration-boundary.test.ts` が持つ。**
 * 2. **chromium で1度も見ていない。** **happy-dom は CSS を1バイトも計算しない。**
 * 3. **描画の性能を1件も測っていない**(`v8-m11.md` §0-3 が埋めないと宣言している)。
 * 4. **本物のサーバに1度も当たっていない** —— **`fetch` はスタブで、条件を1つも解釈しない。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Manifest, ReportView } from "../../src/kernel/types.ts";
import { ReportViewRenderer } from "../src/views/ReportViewRenderer.tsx";

const APP_ID = "rep-app";
const WEB_ROOT = dirname(import.meta.dir);

function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "売上",
      tables: [
        {
          id: "sale",
          name: "売上",
          fields: [
            { id: "region", name: "地域", type: "select", options: ["東", "西"] },
            { id: "amount", name: "金額", type: "number" },
          ],
        },
      ],
      views: [
        {
          id: "rep-region",
          type: "report_view",
          table: "sale",
          name: "地域別の売上",
          report: {
            group_by: [{ field: "region" }],
            aggregates: [{ type: "sum", field: "amount" }, { type: "count" }],
          },
        },
      ],
    },
  } as unknown as Manifest;
}

/** 3群ぶんの応答(`null` の群を1つ含む)。 */
function threeGroups(): Record<string, unknown> {
  return {
    groups: [
      {
        keys: [{ field: "region", value: "東" }],
        aggregates: [
          { type: "sum", field: "amount", value: 1200 },
          { type: "count", value: 3 },
        ],
      },
      {
        keys: [{ field: "region", value: "西" }],
        aggregates: [
          { type: "sum", field: "amount", value: 600 },
          { type: "count", value: 2 },
        ],
      },
      {
        keys: [{ field: "region", value: null }],
        aggregates: [
          { type: "sum", field: "amount", value: 0 },
          { type: "count", value: 1 },
        ],
      },
    ],
    total_groups: 3,
    totals: [
      { type: "sum", field: "amount", value: 1800 },
      { type: "count", value: 6 },
    ],
  };
}

let requests: string[];
let originalFetch: typeof fetch;
/** スタブが返す本文と状態コード。**条件は1つも解釈しない。** */
let responseBody: unknown;
let responseStatus: number;

beforeEach(() => {
  requests = [];
  responseBody = threeGroups();
  responseStatus = 200;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    requests.push(url);
    return new Response(JSON.stringify(responseBody), {
      status: responseStatus,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/rep-region`);
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function renderReport(manifest: Manifest = baseManifest()) {
  return render(
    <ReportViewRenderer
      appId={APP_ID}
      manifest={manifest}
      view={manifest.app.views[0] as ReportView}
    />,
  );
}

function reportRequests(): string[] {
  return requests.filter((url) => url.includes("/views/rep-region/report"));
}

function lastReportRequest(): string {
  const all = reportRequests();
  return all[all.length - 1] ?? "";
}

async function findReportTable(): Promise<HTMLElement> {
  return await screen.findByTestId("report-table");
}

/** 列見出しの並べ替えボタン(束ねるキー / 集計値 と添字で指す)。 */
function sortButton(target: "group_by" | "aggregate", index: number): HTMLElement {
  const button = screen
    .getAllByTestId("report-sort")
    .find(
      (candidate) =>
        candidate.getAttribute("data-report-target") === target &&
        candidate.getAttribute("data-report-index") === String(index),
    );
  if (button === undefined) {
    throw new Error(`列 "${target}[${index}]" の並べ替えボタンがありません。`);
  }
  return button;
}

/**
 * **並べ替えボタンが現れるまで待ってから**指す(`sortButton` の非同期版)。
 *
 * **`waitForRequest` は「その条件で要求が飛んだ」ことだけを待ち、応答による描き直しの完了を
 * 1ミリも待たない。** **描き直している間、画面は `loading` の早期 return に入って骨組み
 * (`Skeleton`)だけを出しており、`report-sort` のボタンは `DOM` に1つも無い。**
 * そのため `waitForRequest` の直後に同期の `sortButton` を打つと、遅い台では空振りする
 * (実CI で時々落ちていたのはこの形である)。**待ってから指すことで、確かめている中身は
 * 1バイトも変えずに、待ち方の非対称だけを解消する。**
 */
async function findSortButton(
  target: "group_by" | "aggregate",
  index: number,
): Promise<HTMLElement> {
  return await waitFor(() => sortButton(target, index));
}

function headerTexts(): string[] {
  return screen.getAllByRole("columnheader").map((cell) => cell.textContent ?? "");
}

function rowTexts(): string[][] {
  return screen
    .getAllByTestId("report-row")
    .map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent ?? ""));
}

async function waitForRequest(fragment: string): Promise<void> {
  await waitFor(() => expect(lastReportRequest()).toContain(fragment));
}

// ---------------------------------------------------------------------------
// (T06-1) 表に載っている数が API の応答と一致する
// ---------------------------------------------------------------------------

test("(T06-1) 表に載っている群の数とセルの値が、集計 API の応答と一致する", async () => {
  renderReport();
  await findReportTable();
  // **束ねるキーの項目名と、集計列(合計 / 件数)が見出しになる。**
  expect(headerTexts()).toEqual(["地域", "金額の合計", "件数"]);
  // **応答の群は3つで、表の行も3つである**(1件も落とさず、1件も水増ししない)。
  expect(rowTexts()).toEqual([
    ["東", "1200", "3"],
    ["西", "600", "2"],
    ["(値なし)", "0", "1"],
  ]);
});

test("(T06-1) 集計表は集計 API を1本だけ叩き、レコード一覧の口を1度も叩かない", async () => {
  renderReport();
  await findReportTable();
  expect(reportRequests()).toHaveLength(1);
  expect(requests.filter((url) => url.includes("/records"))).toHaveLength(0);
  expect(lastReportRequest()).toContain(`/api/apps/${APP_ID}/views/rep-region/report`);
});

// ---------------------------------------------------------------------------
// (T06-2) / (T06-3) / (T06-4) 並べ替え(`D-V8-130`)
// ---------------------------------------------------------------------------

test("(T06-2) 列の見出しを押すと sort_target / sort_index / sort_order の3つがそろって飛ぶ", async () => {
  renderReport();
  await findReportTable();
  // **並べ替えを1度も押していないので、順序のクエリは1バイトも載っていない**
  // (宣言に `sort` が無い画面である)。
  expect(lastReportRequest()).not.toContain("sort_target=");

  const button = sortButton("group_by", 0);
  expect(button.tagName.toLowerCase()).toBe("button");
  const before = reportRequests().length;
  fireEvent.click(button);
  await waitForRequest("sort_target=group_by");
  // **サーバへ投げ直している**(取得済みの群をフロントで並べ替えていない)。
  expect(reportRequests().length).toBeGreaterThan(before);
  // **3つが**そろって**飛ぶ**(サーバは all-or-nothing で、そろわなければ 400 を返す)。
  expect(lastReportRequest()).toContain("sort_index=0");
  expect(lastReportRequest()).toContain("sort_order=asc");
});

test("(T06-3) 同じ列をもう一度押すと向きが反転する(asc → desc)", async () => {
  renderReport();
  await findReportTable();
  fireEvent.click(sortButton("group_by", 0));
  await waitForRequest("sort_order=asc");
  fireEvent.click(await findSortButton("group_by", 0));
  await waitForRequest("sort_order=desc");
  expect(lastReportRequest()).toContain("sort_target=group_by");
  expect(lastReportRequest()).toContain("sort_index=0");
});

test("(T06-4) 集計列を押すと sort_target=aggregate になり、別の列は昇順から始まる", async () => {
  renderReport();
  await findReportTable();
  fireEvent.click(sortButton("group_by", 0));
  await waitForRequest("sort_order=asc");
  fireEvent.click(await findSortButton("group_by", 0));
  await waitForRequest("sort_order=desc");

  // **別の列(集計値の1本目)を押すと、向きは昇順に戻る。**
  fireEvent.click(await findSortButton("aggregate", 0));
  await waitForRequest("sort_target=aggregate");
  expect(lastReportRequest()).toContain("sort_index=0");
  expect(lastReportRequest()).toContain("sort_order=asc");

  // **件数の列(集計値の2本目)は添字が 1 である。**
  fireEvent.click(await findSortButton("aggregate", 1));
  await waitForRequest("sort_index=1");
  expect(lastReportRequest()).toContain("sort_target=aggregate");
});

test("(T06-4) 並べ替えの向きは aria-sort に出る(押していない列は none のまま)", async () => {
  renderReport();
  await findReportTable();
  expect(screen.getAllByRole("columnheader").map((cell) => cell.getAttribute("aria-sort"))).toEqual(
    ["none", "none", "none"],
  );
  fireEvent.click(sortButton("aggregate", 0));
  await waitForRequest("sort_target=aggregate");
  await waitFor(() =>
    expect(
      screen.getAllByRole("columnheader").map((cell) => cell.getAttribute("aria-sort")),
    ).toEqual(["none", "ascending", "none"]),
  );
});

// ---------------------------------------------------------------------------
// (T06-5) ページ送り(`D-V8-129`)
// ---------------------------------------------------------------------------

test("(T06-5) 既定では先頭100群を読み、「次へ」で offset が 100 動く", async () => {
  responseBody = { ...threeGroups(), total_groups: 250 };
  renderReport();
  await findReportTable();
  // **既定の1ページは 100 群である**(サーバの既定と同じ値を明示して渡す)。
  expect(lastReportRequest()).toContain("limit=100");
  // **先頭ページでは `offset` を1バイトも載せない。**
  expect(lastReportRequest()).not.toContain("offset=");

  fireEvent.click(screen.getByTestId("report-next"));
  await waitForRequest("offset=100");
  expect(lastReportRequest()).toContain("limit=100");

  fireEvent.click(await screen.findByTestId("report-prev"));
  await waitFor(() => expect(lastReportRequest()).not.toContain("offset="));
});

test("(T06-5) 並べ替えを打ち直すと先頭ページへ戻る(2ページ目のまま別の並びを見せない)", async () => {
  responseBody = { ...threeGroups(), total_groups: 250 };
  renderReport();
  await findReportTable();
  fireEvent.click(screen.getByTestId("report-next"));
  await waitForRequest("offset=100");
  fireEvent.click(await findSortButton("group_by", 0));
  await waitForRequest("sort_target=group_by");
  expect(lastReportRequest()).not.toContain("offset=");
});

test("(T06-5) 群が総数に届いているときは「次へ」を押せない", async () => {
  renderReport();
  await findReportTable();
  expect((screen.getByTestId("report-next") as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByTestId("report-prev") as HTMLButtonElement).disabled).toBe(true);
});

// ---------------------------------------------------------------------------
// (T06-6) 画面の上の合計は、ページを切る前の値である
// ---------------------------------------------------------------------------

test("(T06-6) 画面の上の合計は、ページを切る前の全体の値である(この100群ぶんの合計ではない)", async () => {
  // **群は3つしか返らないが、`total_groups` は 250・`totals` は全体の値である。**
  responseBody = {
    ...threeGroups(),
    total_groups: 250,
    totals: [
      { type: "sum", field: "amount", value: 987654 },
      { type: "count", value: 4321 },
    ],
  };
  renderReport();
  await findReportTable();
  const totals = screen.getByTestId("report-totals").textContent ?? "";
  // **応答の `totals` の値がそのまま出る。**
  //
  // **【`V8-M12-T03` の訂正。上の1行を消していない】** **今日は「そのまま」ではない** ——
  // **全体の合計にも表の中と同じ書式が当たるので、`987654` は `987,654` と出る。**
  // **見ている性質(ページを切る前の値であること)は1ミリも変わっていない** ——
  // **変えたのは綴りの期待だけである。** **`4321` は整数4桁なので今日も桁区切りが入らない。**
  expect(totals).toContain("987,654");
  expect(totals).toContain("4321");
  // **表に出ている3群の合計(1800 / 6)ではない。**
  expect(totals).not.toContain("1800");
  // **切る前の値であることが読み手に分かる文言がある。**
  const scope = screen.getByTestId("report-total-scope").textContent ?? "";
  expect(scope).toContain("250");
  expect(scope).toContain("ページを切る前");
});

// ---------------------------------------------------------------------------
// (T06-7) / (T06-8) / (T06-9) 4xx を「0件」として描かない(`Q-G18`)
// ---------------------------------------------------------------------------

test("(T06-7) 上限に当たった 400 を「0件」として描かない(表も空の知らせも1つも出さない)", async () => {
  responseStatus = 400;
  responseBody = {
    errors: [
      {
        path: "",
        message:
          "集計の上限を超えているため計算できません(群にまとめる前に読む行の件数が上限 10000 件を超えました)。",
        hint: "絞り込み(filter)で対象を狭めるか、集計する範囲を分けてください(1つの集計表が読む行は表ごとに上限があります)。",
      },
    ],
  };
  renderReport();
  const notice = await screen.findByTestId("report-error");
  // **部分的な表を1つも描かない。**
  expect(screen.queryByTestId("report-table")).toBeNull();
  expect(screen.queryAllByTestId("report-row")).toHaveLength(0);
  // **「0件」「合計0」を1文字も出さない** —— 見られないことと0であることを混同させない。
  expect(screen.queryByTestId("report-empty")).toBeNull();
  expect(screen.queryByTestId("report-totals")).toBeNull();
  // **サーバの文面をそのまま運ぶ**(フロントで作り直さない。`ADR-0003` §3)。
  expect(notice.textContent ?? "").toContain("集計の上限を超えているため計算できません");
  // **「これは0件ではない」と画面に書いてある。**
  expect(screen.getByTestId("report-error-not-zero").textContent ?? "").toContain("0件");
});

test("(T06-8) 上限の知らせに、表の名前も表のIDも1バイトも出ない", async () => {
  responseStatus = 400;
  responseBody = {
    errors: [
      {
        path: "",
        message:
          "集計の上限を超えているため計算できません(群にまとめる前に読む行の件数が上限 10000 件を超えました)。",
      },
    ],
  };
  renderReport();
  const notice = await screen.findByTestId("report-error");
  const text = notice.textContent ?? "";
  // **応答本文に表のIDが出ていない**(`src/server/report-limit-boundary.test.ts` が固定している)
  // **ので、画面も出してはならない** —— **画面が自分でマニフェストから足すと台無しになる。**
  expect(text).not.toContain("sale");
  expect(text).not.toContain("売上");
});

test("(T06-9) 未ログインの 401 も、システム表の 403 も「0件」ではなく知らせとして出す", async () => {
  responseStatus = 401;
  responseBody = { errors: [{ path: "", message: "このアプリにログインしてください。" }] };
  renderReport();
  const unauthorized = await screen.findByTestId("report-error");
  expect(screen.queryByTestId("report-table")).toBeNull();
  expect(screen.queryByTestId("report-empty")).toBeNull();
  expect(unauthorized.textContent ?? "").toContain("ログイン");

  cleanup();
  responseStatus = 403;
  responseBody = { errors: [{ path: "", message: "この表を読む権限がありません。" }] };
  renderReport();
  const forbidden = await screen.findByTestId("report-error");
  expect(screen.queryByTestId("report-table")).toBeNull();
  expect(screen.queryByTestId("report-empty")).toBeNull();
  expect(forbidden.textContent ?? "").toContain("権限");
});

test("(T06-9) ?limit= の 400 も知らせとして出し、表を1つも描かない", async () => {
  responseStatus = 400;
  responseBody = {
    errors: [
      {
        path: "/limit",
        message: "limit は 0 以上の整数で指定してください。",
        hint: "1ページに返す最大件数を 0 以上の整数で指定してください(集計表では、省略すると先頭 100 群を返します)。",
      },
    ],
  };
  renderReport();
  const notice = await screen.findByTestId("report-error");
  expect(screen.queryByTestId("report-table")).toBeNull();
  expect(notice.textContent ?? "").toContain("limit");
});

test("(T06-9) 群が本当に0件のときだけ「0件」と描く(4xx とは別の見せ方である)", async () => {
  responseBody = {
    groups: [],
    total_groups: 0,
    totals: [
      { type: "sum", field: "amount", value: 0 },
      { type: "count", value: 0 },
    ],
  };
  renderReport();
  const empty = await screen.findByTestId("report-empty");
  expect(empty.textContent ?? "").toContain("0");
  // **知らせ(4xx)は1つも出ていない** —— 見分けが付く形になっている。
  expect(screen.queryByTestId("report-error")).toBeNull();
});

// ---------------------------------------------------------------------------
// (T06-10) 決定12: 並べ替えもページ位置も URL に持たない
// ---------------------------------------------------------------------------

test("(T06-10) 並べ替えの状態もページ位置も URL・localStorage・sessionStorage に1バイトも残らない", async () => {
  responseBody = { ...threeGroups(), total_groups: 250 };
  renderReport();
  await findReportTable();
  fireEvent.click(sortButton("aggregate", 0));
  await waitForRequest("sort_target=aggregate");
  fireEvent.click(await screen.findByTestId("report-next"));
  await waitForRequest("offset=100");

  // **ブラウザの URL は1バイトも変わっていない。**
  expect(window.location.search).toBe("");
  expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/rep-region`);
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
});

test("(T06-10) リロード相当(描き直し)で、並べ替えもページ位置も消える", async () => {
  responseBody = { ...threeGroups(), total_groups: 250 };
  renderReport();
  await findReportTable();
  fireEvent.click(sortButton("aggregate", 0));
  await waitForRequest("sort_target=aggregate");
  fireEvent.click(await screen.findByTestId("report-next"));
  await waitForRequest("offset=100");

  cleanup();
  requests = [];
  renderReport();
  await findReportTable();
  // **打った並び順もページ位置も1バイトも復元されない**(`useState` の一時状態である)。
  expect(lastReportRequest()).not.toContain("sort_target=");
  expect(lastReportRequest()).not.toContain("offset=");
});

test("(T06-10) 画面の実装に、並べ替えとページ位置を保存する経路が1本も無い", () => {
  const source = readFileSync(
    join(WEB_ROOT, "src", "views", "ReportViewRenderer.tsx"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  for (const forbidden of [
    "localStorage",
    "sessionStorage",
    "history.pushState",
    "history.replaceState",
    "document.cookie",
  ]) {
    expect(source.includes(forbidden), forbidden).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// (T06-11) 甲5: 色のリテラルを1バイトも書かない(ADR-0094 限定7)
// ---------------------------------------------------------------------------

test("(T06-11) 集計表の画面の実装に色のリテラルが1バイトも無い(ADR-0094 限定7)", () => {
  // **先例は `web/test/overlay.test.tsx` の (T01-7) である**(器の実装1本を名指しで読む)。
  // **着手前、`.tsx` を横断して色のリテラルを止める検査は1本も無かった**
  // (`web/test/style-sources.test.ts` の (集合3) は `<style>` と `insertRule` しか見ない)。
  const body = readFileSync(join(WEB_ROOT, "src", "views", "ReportViewRenderer.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  expect(/#[0-9a-fA-F]{3,8}\b/.test(body)).toBe(false);
  expect(/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\s*\(/i.test(body)).toBe(false);
});

test("(T06-11) 集計表の画面の実装が、実行時に CSS を差し込む経路を1本も持たない", () => {
  // **`web/test/style-sources.test.ts` の (集合3) が名指ししている1本は `ViewHost.tsx` だけである。**
  // **新しい画面がその集合に入らないことを、こちら側でも直接見ておく。**
  const body = readFileSync(join(WEB_ROOT, "src", "views", "ReportViewRenderer.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  expect(/<style[\s>]/.test(body)).toBe(false);
  expect(/insertRule|styleSheets\[/.test(body)).toBe(false);
});

// ---------------------------------------------------------------------------
// ディスパッチ層が、知らせではなく本物の描画を選ぶ
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// (T03) 集計値の書式(`V8-M12-T03`。`v8-m12.md` §1-0c の決定9 /
//       §1-0e の決定19 / §1-0f の枝番 甲4・戊4)
//
// **【このファイルの冒頭の表を1バイトも書き換えていない。ここに追記する】**
//
// | # | 何を | どう見るか |
// |---|---|---|
// | (T03-1) | **単位が付く**(`field.unit` を集計表の側で引く) | セルの文字列 |
// | (T03-2) | **桁区切りは整数5桁から**(`12345` は `12,345`・`1200` は `1200`) | セルの文字列 |
// | (T03-3) | **件数(`count`)には単位を付けない。桁区切りは付ける** | セルの文字列 |
// | (T03-4) | **単位を宣言していない列に、余計な空白も単位も付かない** | セルの文字列 |
// | (T03-5) | **全体の合計と表の中のセルで、同じ数が同じ文字列になる** | 両方を読む |
// | (T03-6) | **結合があるとき、単位は `aggregates[].table` の表から引く** | セルの文字列 |
// | (T03-7) | **値が無い群の見せ方が着手前と1バイトも同じ** | セルの文字列 |
//
// **【射程外。塞いでいない】束ねるキー(`group_by`)の列の書式は1ミリも動かしていない** ——
// **参照の代表値も、生の UUID も、日付の丸めも今日のままである**(`ReportViewRenderer.tsx`
// 冒頭の「解けていないこと」2 / 3 は今日も真である)。
// ---------------------------------------------------------------------------

/** 単位を書けるマニフェスト。**単位は一覧と同じ `$defs/field.unit` から引く。** */
function formatManifest(options: { unit?: string } = {}): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "売上",
      tables: [
        {
          id: "sale",
          name: "売上",
          fields: [
            { id: "region", name: "地域", type: "select", options: ["東", "西"] },
            {
              id: "amount",
              name: "金額",
              type: "number",
              ...(options.unit === undefined ? {} : { unit: options.unit }),
            },
          ],
        },
      ],
      views: [
        {
          id: "rep-region",
          type: "report_view",
          table: "sale",
          name: "地域別の売上",
          report: {
            group_by: [{ field: "region" }],
            aggregates: [{ type: "sum", field: "amount" }, { type: "count" }],
          },
        },
      ],
    },
  } as unknown as Manifest;
}

/** 群の応答を組む小道具。**`totals` は行の和ではなく、明示した値をそのまま置く。** */
function groupsOf(
  rows: { key: string | null; sum: number; count: number }[],
  totals?: { sum: number; count: number },
): Record<string, unknown> {
  const sum = totals?.sum ?? rows.reduce((carry, row) => carry + row.sum, 0);
  const count = totals?.count ?? rows.reduce((carry, row) => carry + row.count, 0);
  return {
    groups: rows.map((row) => ({
      keys: [{ field: "region", value: row.key }],
      aggregates: [
        { type: "sum", field: "amount", value: row.sum },
        { type: "count", value: row.count },
      ],
    })),
    total_groups: rows.length,
    totals: [
      { type: "sum", field: "amount", value: sum },
      { type: "count", value: count },
    ],
  };
}

test("(T03-1) 単位を宣言した項目を合計した列に、一覧と同じ形で単位が付く", async () => {
  responseBody = groupsOf([{ key: "東", sum: 1200, count: 3 }]);
  renderReport(formatManifest({ unit: "円" }));
  await findReportTable();
  // **着手前は `1200` とだけ出ていた**(`aggregateText` = `String(value)`)。
  expect(rowTexts()).toEqual([["東", "1200 円", "3"]]);
});

test("(T03-2) 桁区切りは整数5桁から入る(12345 は 12,345・1200 は 1200 のまま)", async () => {
  // **【枝番 甲4 の訂正をここに焼き込む】** **一覧でも `1200` は `1200` である** ——
  // **`web/src/fields/display.tsx:150` の `GROUPING_MIN_INTEGER_DIGITS = 5` による。**
  // **「一覧で `1,200 円` と出る列が集計表で `1200` と出る」という旧文の例は、今日は偽である。**
  responseBody = groupsOf([
    { key: "東", sum: 12345, count: 3 },
    { key: "西", sum: 1200, count: 2 },
  ]);
  renderReport(formatManifest({ unit: "円" }));
  await findReportTable();
  expect(rowTexts()).toEqual([
    ["東", "12,345 円", "3"],
    ["西", "1200 円", "2"],
  ]);
});

test("(T03-3) 件数の列には単位が1文字も付かない。桁区切りは付く", async () => {
  // **合計と件数で書式が違う** —— **件数は指す項目を持たないので、引ける単位が1つも無い。**
  responseBody = groupsOf([{ key: "東", sum: 12345, count: 12345 }]);
  renderReport(formatManifest({ unit: "円" }));
  await findReportTable();
  const [row] = rowTexts();
  expect(row?.[2]).toBe("12,345");
  expect(row?.[2]).not.toContain("円");
});

test("(T03-4) 単位を宣言していない項目の列に、余計な空白も単位も1文字も付かない", async () => {
  responseBody = groupsOf([{ key: "東", sum: 12345, count: 3 }]);
  renderReport(formatManifest());
  await findReportTable();
  const [row] = rowTexts();
  // **`toBe` で見る** —— **末尾に空白が1つ残っても落ちる形にしてある。**
  expect(row?.[1]).toBe("12,345");
});

test("(T03-5) 全体の合計と表の中のセルで、同じ数が同じ文字列になる", async () => {
  responseBody = groupsOf([{ key: "東", sum: 987654, count: 4321 }], {
    sum: 987654,
    count: 4321,
  });
  renderReport(formatManifest({ unit: "円" }));
  await findReportTable();
  const [row] = rowTexts();
  const totals = screen.getByTestId("report-totals").textContent ?? "";
  expect(row?.[1]).toBe("987,654 円");
  expect(totals).toContain("987,654 円");
  expect(row?.[2]).toBe("4321");
  expect(totals).toContain("4321");
  // **書式が2つに割れていない** —— **生の綴りは全体の合計にも1つも残っていない。**
  expect(totals).not.toContain("987654");
});

/**
 * 結合つきのマニフェスト。**起点の表にも同じIDの `amount` があり、単位が違う** ——
 * **`aggregates[].table` を無視して起点の表から引くと `点` が出る形にしてある。**
 */
function joinManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "受注",
      tables: [
        {
          id: "order",
          name: "受注",
          fields: [
            { id: "region", name: "地域", type: "select", options: ["東", "西"] },
            { id: "amount", name: "受注点数", type: "number", unit: "点" },
          ],
        },
        {
          id: "line",
          name: "明細",
          fields: [
            { id: "order", name: "受注", type: "reference", reference_table: "order" },
            { id: "amount", name: "明細額", type: "number", unit: "円" },
          ],
        },
      ],
      views: [
        {
          id: "rep-region",
          type: "report_view",
          table: "order",
          name: "地域別の明細額",
          report: {
            join: [{ table: "line", field: "order" }],
            group_by: [{ field: "region" }],
            aggregates: [{ type: "sum", table: "line", field: "amount" }],
          },
        },
      ],
    },
  } as unknown as Manifest;
}

test("(T03-6) 結合があるとき、単位は aggregates[].table が指す表の項目から引く", async () => {
  responseBody = {
    groups: [
      {
        keys: [{ field: "region", value: "東" }],
        aggregates: [{ type: "sum", field: "amount", value: 12345 }],
      },
    ],
    total_groups: 1,
    totals: [{ type: "sum", field: "amount", value: 12345 }],
  };
  renderReport(joinManifest());
  await findReportTable();
  // **列見出しも結合先の表の項目名である**(`V8-M11` が既に入れた形。ここでは変えていない)。
  expect(headerTexts()).toEqual(["地域", "明細額の合計"]);
  const [row] = rowTexts();
  expect(row?.[1]).toBe("12,345 円");
  // **起点の表の同名項目の単位(`点`)を引いていない。**
  expect(row?.[1]).not.toContain("点");
});

test("(T03-7) 集計値が返っていない列の見せ方は着手前と1バイトも同じ(「(値なし)」)", async () => {
  responseBody = {
    groups: [
      {
        keys: [{ field: "region", value: "東" }],
        // **件数の値が1つも返っていない群**(応答が短い)。
        aggregates: [{ type: "sum", field: "amount", value: 1200 }],
      },
    ],
    total_groups: 1,
    totals: [
      { type: "sum", field: "amount", value: 1200 },
      { type: "count", value: 3 },
    ],
  };
  renderReport(formatManifest({ unit: "円" }));
  await findReportTable();
  const [row] = rowTexts();
  expect(row?.[2]).toBe("(値なし)");
  // **値が無い群に単位も桁区切りも足さない。**
  expect(row?.[2]).not.toContain("円");
});

test("(T06-12) ViewHost の report_view 分岐が、集計表の描画コンポーネントを選ぶ", () => {
  const source = readFileSync(join(WEB_ROOT, "src", "views", "ViewHost.tsx"), "utf8");
  // **`:478` の逐語(「`V8-M11` はここを本物の描画に置き換えること」)は残してある** ——
  // **旧文を1バイトも消さずに、今日の正を追記で書き分ける作法である。**
  expect(source).toContain("**`V8-M11` はここを本物の描画に置き換えること**");
  // **その逐語のとおり、`Alert` は消えて本物の描画に置き換わっている。**
  expect(source).toContain("<ReportViewRenderer");
  expect(source).not.toContain("この画面はまだ表示できません");
});

// ---------------------------------------------------------------------------
// (T04) / (T05) グラフ(`V8-M12-T04` / `T05`。台帳 `Q-G23` / `Q-G27`。
//       ユーザ決定 `D-V8-131`。`v8-m12.md` §0-5 / §1-0c の決定4・5 /
//       §1-0d の決定17〜19・22 / §1-0f の枝番 乙3・戊1・戊2・庚5、
//       および **メインの裁定「決定23」**(決定18 を改めたもの))
//
// **【このファイルの冒頭の表も、上の (T03) の表も1バイトも書き換えていない。ここに追記する】**
//
// | # | 何を | どう見るか |
// |---|---|---|
// | (T04-1) | **棒 / 折れ線 / 省略(棒)の3通りが描き分けられる** | 器の `data-report-chart` と中身 |
// | (T04-2) | **群が0件のときグラフが1本も出ない** | 器が無く `report-empty` だけが出る |
// | (T04-3) | **上限 400・未ログイン 401・権限 403 でグラフも表も出ない** | 器も表も無く知らせだけ |
// | (T04-4) | **系列の色は25スロットの `var()` で、3本目は `--color-text-secondary`** | 属性を名指しで読む |
// | (T04-5) | **グラフの値が表の値と同じである**(同じ `groups` から作る) | 両方を読んで突き合わせる |
// | (T04-6) | **軸と説明の数に `T03` の書式(桁区切り・単位)が当たる** | 軸のテキストと `<title>` |
// | (T04-7) | **色のリテラル・クラス名の組み立て・`getComputedStyle` が0件** | ソースを読む |
// | (T04-8) | **生成側の入口2本に `chart` / `nivo` / 系列色の行が1行も無い** | CSS 2本を読む |
// | (T04-9) | **単位の出し方は「値 + 半角空白1つ + 単位」1通りだけ** | ソースを読む |
//
// ## **このファイルが証明しないこと(先に書く。誇張しない)**
//
// 1. **折れ線のツールチップを1件も測っていない** —— **happy-dom では出せない**
//    (nivo の当たり判定は `getBoundingClientRect` に依るが、happy-dom は全部 0 を返す)。
//    **実測で `fireEvent.mouseEnter` / `mouseMove` を打っても1文字も出なかった。**
//    **【禁止】「ツールチップが出る」と書かない。** **実証は `T06`(chromium)の担当である。**
// 2. **色が実際に何色で塗られるかを1度も測っていない** —— **happy-dom は CSS を1バイトも
//    計算しないので、見ているのは `var(--…)` という**文字列**が属性に入ったことだけである。**
// 3. **グラフの読みやすさ(重なり・目盛りの間隔・凡例の有無)を1件も測っていない。**
//
// ## **【`V8-M12-T06` の追記。上の3点を1バイトも消していない】**
//
// - **1 は今日も真である** —— **本ファイルは今日もツールチップを1件も測っていない。**
//   **ただし「実証は `T06`(chromium)の担当である」は済んだ**:
//   **`web/e2e/report-view.e2e.ts` の (E-7) が実測した。** **`useMesh` を足す前は chromium でも
//   1文字も出ず、足したあとは `x: 1, y: 5` が出る**(**群の名前ではなく位置の番号が出ることも
//   そこに書いてある**)。**本ファイルの【禁止】は本ファイルの中では今日も有効である。**
// - **3 のうち「重なり」は、下の (M12-T06-1)〜(M12-T06-4) が**本数**を見るようになった** ——
//   **文字の幅は今日も1ミリも測っていない**(happy-dom は幅を計算しない)。
//   **「重ならなくなった」ことの実測は (E-12) が chromium で行う。**
// ---------------------------------------------------------------------------

/** グラフつきのマニフェスト。**系列は `aggregates` の本数そのものである**(最大3)。 */
function chartManifest(
  options: { chart?: "bar" | "line"; series?: 1 | 2 | 3; unit?: string } = {},
): Manifest {
  const aggregates = [
    { type: "sum", field: "amount" },
    { type: "count" },
    { type: "sum", field: "qty" },
  ].slice(0, options.series ?? 2);
  return {
    app: {
      id: APP_ID,
      name: "売上",
      tables: [
        {
          id: "sale",
          name: "売上",
          fields: [
            { id: "region", name: "地域", type: "select", options: ["東", "西"] },
            {
              id: "amount",
              name: "金額",
              type: "number",
              ...(options.unit === undefined ? {} : { unit: options.unit }),
            },
            { id: "qty", name: "数量", type: "number", unit: "個" },
          ],
        },
      ],
      views: [
        {
          id: "rep-region",
          type: "report_view",
          table: "sale",
          name: "地域別の売上",
          report: {
            group_by: [{ field: "region" }],
            aggregates,
            ...(options.chart === undefined ? {} : { chart: options.chart }),
          },
        },
      ],
    },
  } as unknown as Manifest;
}

/** グラフ用の応答。**集計値の本数は系列の本数と同じである。** */
function chartGroups(rows: { key: string | null; values: number[] }[]): Record<string, unknown> {
  const shape = (values: number[]) =>
    values.map((value, index) =>
      index === 1
        ? { type: "count", value }
        : { type: "sum", field: index === 0 ? "amount" : "qty", value },
    );
  return {
    groups: rows.map((row) => ({
      keys: [{ field: "region", value: row.key }],
      aggregates: shape(row.values),
    })),
    total_groups: rows.length,
    totals: shape((rows[0]?.values ?? []).map(() => 0)),
  };
}

function chartFrame(): HTMLElement | null {
  return screen.queryByTestId("report-chart");
}

function barRects(): HTMLElement[] {
  return screen.queryAllByTestId("report-chart-bar");
}

/** 折れ線の系列の色。**`stroke` を持つ `path` から読む。** */
function lineStrokes(): string[] {
  const frame = chartFrame();
  return frame === null
    ? []
    : [...frame.querySelectorAll("path[stroke]")]
        .map((path) => path.getAttribute("stroke") ?? "")
        .filter((stroke) => stroke !== "" && stroke !== "none");
}

/** 軸の目盛りに出ている文字列(グラフの中の `<text>` の全量)。 */
function chartTexts(): string[] {
  const frame = chartFrame();
  return frame === null
    ? []
    : [...frame.querySelectorAll("text")].map((text) => text.textContent ?? "");
}

/** 棒に添えた説明(`<title>`)。**折れ線には無い** —— 折れ線は nivo のツールチップである。 */
function barTitles(): string[] {
  return barRects().map((rect) => rect.querySelector("title")?.textContent ?? "");
}

/** 25スロットのうち系列に使う3本。**`.tsx` にも本ファイルにも実値(16進)を書かない。** */
const SERIES_COLOR_SLOTS = [
  "var(--color-danger)",
  "var(--focus-outline-color)",
  "var(--color-text-secondary)",
];

// --- (T04-1) 棒 / 折れ線 / 省略 ---------------------------------------------------------

test("(T04-1) chart を1バイトも書いていない集計表には、棒グラフが出る(省略時は棒である)", async () => {
  responseBody = chartGroups([
    { key: "東", values: [12345, 3] },
    { key: "西", values: [600, 2] },
  ]);
  renderReport(chartManifest({ unit: "円" }));
  await findReportTable();
  const frame = chartFrame();
  expect(frame).not.toBeNull();
  expect(frame?.getAttribute("data-report-chart")).toBe("bar");
  // **群2 × 系列2 = 4本の棒が出る。**
  expect(barRects()).toHaveLength(4);
});

test("(T04-1) グラフは表の上に出る(D-V8-131。下に表)", async () => {
  responseBody = chartGroups([{ key: "東", values: [12345, 3] }]);
  renderReport(chartManifest({ chart: "bar", unit: "円" }));
  const table = await findReportTable();
  const frame = chartFrame();
  expect(frame).not.toBeNull();
  // **DOM の順序でグラフが表より前にある**(`Node.DOCUMENT_POSITION_FOLLOWING` = 4)。
  expect((frame?.compareDocumentPosition(table) ?? 0) & 4).toBe(4);
});

test('(T04-1) chart: "line" では折れ線が出て、棒が1本も出ない', async () => {
  responseBody = chartGroups([
    { key: "東", values: [12345, 3] },
    { key: "西", values: [600, 2] },
  ]);
  renderReport(chartManifest({ chart: "line", unit: "円" }));
  await findReportTable();
  expect(chartFrame()?.getAttribute("data-report-chart")).toBe("line");
  expect(barRects()).toHaveLength(0);
  // **系列2本ぶんの線が出る。**
  expect(lineStrokes()).toHaveLength(2);
});

test('(T04-1) chart: "bar" では棒が出て、系列の線が1本も出ない', async () => {
  responseBody = chartGroups([
    { key: "東", values: [12345, 3] },
    { key: "西", values: [600, 2] },
  ]);
  renderReport(chartManifest({ chart: "bar", unit: "円" }));
  await findReportTable();
  expect(chartFrame()?.getAttribute("data-report-chart")).toBe("bar");
  expect(barRects()).toHaveLength(4);
  expect(lineStrokes()).toHaveLength(0);
});

// --- (T04-2) 群が0件 --------------------------------------------------------------------

test("(T04-2) 群が0件のとき、グラフが1本も出ない(表の「0件」の知らせだけが出る)", async () => {
  responseBody = { groups: [], total_groups: 0, totals: [{ type: "count", value: 0 }] };
  renderReport(chartManifest({ chart: "bar", unit: "円" }));
  await screen.findByTestId("report-empty");
  // **決定22: `groups.length > 0` のときだけ描く。**
  expect(chartFrame()).toBeNull();
  expect(barRects()).toHaveLength(0);
});

// --- (T04-3) 4xx ではグラフも表も出さない ------------------------------------------------

test("(T04-3) 上限の 400・未ログインの 401・権限の 403 では、グラフも表も出さず知らせだけを出す", async () => {
  for (const [status, message] of [
    [400, "集計の上限を超えているため計算できません。"],
    [401, "このアプリにログインしてください。"],
    [403, "この表を読む権限がありません。"],
  ] as const) {
    cleanup();
    responseStatus = status;
    responseBody = { errors: [{ path: "", message }] };
    renderReport(chartManifest({ chart: "bar", unit: "円" }));
    await screen.findByTestId("report-error");
    // **グラフを1本も描かない** —— **`Q-G18` を、グラフ側でも薄めない。**
    expect(chartFrame(), String(status)).toBeNull();
    expect(barRects(), String(status)).toHaveLength(0);
    expect(screen.queryByTestId("report-table"), String(status)).toBeNull();
  }
});

// --- (T04-4) 系列の色(`Q-G27`。枝番 戊2) -----------------------------------------------

test("(T04-4) 棒の系列の色は25スロットの var() で、3本目は --color-text-secondary である", async () => {
  responseBody = chartGroups([{ key: "東", values: [12345, 3, 7] }]);
  renderReport(chartManifest({ chart: "bar", series: 3, unit: "円" }));
  await findReportTable();
  const rects = barRects();
  expect(rects).toHaveLength(3);
  // **1本目・2本目・3本目を名指しで固定する**(「25スロットのどれか」では白地に白が通る)。
  expect(rects.map((rect) => rect.getAttribute("fill"))).toEqual(SERIES_COLOR_SLOTS);
  // **16進が1つも入っていない** —— **`.tsx` は色の実値を1度も知らない。**
  for (const rect of rects) {
    expect(/#[0-9a-fA-F]{3,8}\b/.test(rect.getAttribute("fill") ?? "")).toBe(false);
  }
});

test("(T04-4) 折れ線の系列の色も同じ3スロットである(3本目は --color-text-secondary)", async () => {
  responseBody = chartGroups([
    { key: "東", values: [12345, 3, 7] },
    { key: "西", values: [600, 2, 4] },
  ]);
  renderReport(chartManifest({ chart: "line", series: 3, unit: "円" }));
  await findReportTable();
  // **【実測。DOM の並びは系列の並びの逆である】** —— 見ている性質は「3本の色が
  // 25スロットの3本ちょうどであること」と「3本目(最後の系列)が無彩色であること」。
  expect([...lineStrokes()].reverse()).toEqual(SERIES_COLOR_SLOTS);
});

test("(T04-4) 系列が2本のとき、3本目の色は1つも出ない(使うのは宣言した本数だけ)", async () => {
  responseBody = chartGroups([{ key: "東", values: [12345, 3] }]);
  renderReport(chartManifest({ chart: "bar", series: 2, unit: "円" }));
  await findReportTable();
  expect(barRects().map((rect) => rect.getAttribute("fill"))).toEqual(
    SERIES_COLOR_SLOTS.slice(0, 2),
  );
});

// --- (T04-5) グラフの値は表の値と同じである ----------------------------------------------

test("(T04-5) グラフに渡っている値は、表に出ている値と1文字も違わない(同じ groups から作る)", async () => {
  responseBody = chartGroups([
    { key: "東", values: [12345, 3] },
    { key: "西", values: [600, 2] },
  ]);
  renderReport(chartManifest({ chart: "bar", unit: "円" }));
  await findReportTable();
  // **表の側**(1列目 = 群のキー、2列目 = 金額の合計、3列目 = 件数)。
  expect(rowTexts()).toEqual([
    ["東", "12,345 円", "3"],
    ["西", "600 円", "2"],
  ]);
  // **グラフの側** —— **同じ群・同じ系列・同じ文字列である。**
  expect(barTitles()).toEqual([
    "東・金額の合計: 12,345 円",
    "西・金額の合計: 600 円",
    "東・件数: 3",
    "西・件数: 2",
  ]);
});

test("(T04-5) 全体の合計(totals)を棒にしていない(描くのは groups である)", async () => {
  // **`totals` は母集団そのものを数えた値で、画面に出ている群の和ではない**(冒頭の逐語)。
  responseBody = {
    ...chartGroups([
      { key: "東", values: [1200, 3] },
      { key: "西", values: [600, 2] },
    ]),
    totals: [
      { type: "sum", field: "amount", value: 987654 },
      { type: "count", value: 4321 },
    ],
    total_groups: 250,
  };
  renderReport(chartManifest({ chart: "bar", unit: "円" }));
  await findReportTable();
  // **群は2つ・系列は2本なので棒は4本ちょうど**(合計の棒が5本目として増えていない)。
  expect(barRects()).toHaveLength(4);
  expect(barTitles().join(" ")).not.toContain("987,654");
  expect(barTitles().join(" ")).not.toContain("4321");
});

// --- (T04-6) 軸と説明の書式(`T03` の書式を当てる) --------------------------------------

test("(T04-6) 縦軸の目盛りに、表と同じ桁区切りと単位が当たる", async () => {
  responseBody = chartGroups([
    { key: "東", values: [12345, 3] },
    { key: "西", values: [600, 2] },
  ]);
  // **系列の単位がそろっているとき**(合計 = 円 / 件数 = 単位なし)は…
  renderReport(chartManifest({ chart: "bar", series: 1, unit: "円" }));
  await findReportTable();
  const texts = chartTexts();
  // **桁区切りが入る**(整数5桁から。一覧と同じ閾値である)。
  expect(texts.some((text) => text.includes("12,000 円"))).toBe(true);
  // **生の綴りが1つも残っていない。**
  expect(texts.some((text) => /(^|[^,\d])12000/.test(text))).toBe(false);
});

test("(T04-6) 系列ごとに単位が違うときは、縦軸に単位を1文字も出さない(桁区切りだけ)", async () => {
  responseBody = chartGroups([{ key: "東", values: [12345, 3] }]);
  renderReport(chartManifest({ chart: "bar", series: 2, unit: "円" }));
  await findReportTable();
  const axis = chartTexts().filter((text) => /[0-9]/.test(text));
  // **合計(円)と件数(単位なし)が同じ縦軸に並ぶので、どちらの単位も出せない。**
  expect(axis.some((text) => text.includes("円"))).toBe(false);
  expect(axis.some((text) => text.includes("12,000"))).toBe(true);
});

test("(T04-6) 横軸のラベルは、表の1列目と同じ文字列である", async () => {
  responseBody = chartGroups([
    { key: "東", values: [12345, 3] },
    { key: null, values: [600, 2] },
  ]);
  renderReport(chartManifest({ chart: "bar", unit: "円" }));
  await findReportTable();
  const texts = chartTexts();
  expect(texts).toContain("東");
  // **値が1つも入っていない群の見せ方も、表と同じ1通りである。**
  expect(texts).toContain("(値なし)");
});

test("(T04-6) 棒に添える説明にも、表と同じ書式(桁区切り・単位)が当たる", async () => {
  responseBody = chartGroups([{ key: "東", values: [12345, 12345] }]);
  renderReport(chartManifest({ chart: "bar", unit: "円" }));
  await findReportTable();
  // **合計には単位が付き、件数には1文字も付かない**(`T03` の分担をグラフ側でも守る)。
  expect(barTitles()).toEqual(["東・金額の合計: 12,345 円", "東・件数: 12,345"]);
});

// --- (T04-7) ソース走査(`Q-G27` の限定。枝番 乙3 / 庚5) --------------------------------

test("(T04-7) グラフを足した後も、集計表の画面の実装に16進の色リテラルが1バイトも無い", () => {
  // **(T06-11) を1バイトも書き換えず、同じ射程をグラフ導入後にもう1度打つ。**
  const body = readFileSync(join(WEB_ROOT, "src", "views", "ReportViewRenderer.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  expect(/#[0-9a-fA-F]{3,8}\b/.test(body)).toBe(false);
  expect(/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\s*\(/i.test(body)).toBe(false);
  // **系列の色は25スロットの `var()` の文字列としてだけ現れる。**
  for (const slot of SERIES_COLOR_SLOTS) {
    expect(body.includes(slot), slot).toBe(true);
  }
});

test("(T04-7) 描画ライブラリを引いているのは集計表の画面1本だけで、円・散布図・熱地図・暦を1本も引かない", () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) && readFileSync(full, "utf8").includes("@nivo/")) {
        offenders.push(full.slice(WEB_ROOT.length + 1));
      }
    }
  };
  walk(join(WEB_ROOT, "src"));
  expect(offenders).toEqual(["src/views/ReportViewRenderer.tsx"]);
  const body = readFileSync(join(WEB_ROOT, "src", "views", "ReportViewRenderer.tsx"), "utf8");
  // **`ADR-0007` の台帳が名指しした4本を1本も足していない**(3本目の描画ライブラリも無い)。
  for (const forbidden of ["@nivo/pie", "@nivo/scatterplot", "@nivo/heatmap", "@nivo/calendar"]) {
    expect(body.includes(forbidden), forbidden).toBe(false);
  }
});

test("(T04-7) 系列の色を Tailwind のクラス名として組み立てておらず、getComputedStyle を1件も使わない", () => {
  const body = readFileSync(join(WEB_ROOT, "src", "views", "ReportViewRenderer.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  // **枝番 乙3: `ADR-0087` 限定6(safelist 禁止)—— 色の当たり先をクラス名で作らない。**
  expect(/\b(bg|text|fill|stroke|border|from|to|via)-\[/.test(body)).toBe(false);
  // **決定18(改めて決定23)—— 実値を読む経路を1本も作らない。**
  const walk = (dir: string): string[] => {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        found.push(...walk(full));
      } else if (/\.tsx?$/.test(entry.name)) {
        // **注記の中の言及は数えない** —— **見ているのは実行される経路である**
        // (`ReportViewRenderer.tsx` の追記節は、`react-spring` が内部で `getComputedStyle`
        // を呼ぶことを**説明**している。**呼んでいるのはこちらの実装ではない**)。
        const body = readFileSync(full, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "");
        if (body.includes("getComputedStyle")) {
          found.push(full.slice(WEB_ROOT.length + 1));
        }
      }
    }
    return found;
  };
  expect(walk(join(WEB_ROOT, "src"))).toEqual([]);
});

test("(T04-8) 生成側の入口(tailwind.css / styles.css)に chart / nivo / 系列色の行が1行も無い", () => {
  // **枝番 庚5: 「生成側の入口」の定義は `web/src/tailwind.css` と `web/src/styles.css` の2本である。**
  for (const name of ["tailwind.css", "styles.css"]) {
    const body = readFileSync(join(WEB_ROOT, "src", name), "utf8");
    for (const forbidden of ["chart", "nivo", "series"]) {
      expect(body.includes(forbidden), `${name}: ${forbidden}`).toBe(false);
    }
  }
});

test("(T04-9) 単位の出し方は「値 + 半角空白1つ + 単位」の1通りだけである", () => {
  // **一覧側の `web/test/field-value-unit.test.tsx`(限定5)と同型の走査である。**
  const body = readFileSync(join(WEB_ROOT, "src", "views", "ReportViewRenderer.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  // **単位を値に添えている箇所は1つだけである**(グラフを足しても2つ目を作っていない)。
  expect([...body.matchAll(/` \$\{unit\}`/g)]).toHaveLength(1);
  // **位置・接頭辞・桁数を選べる形になっていない。**
  for (const forbidden of ["prefix", "suffixPosition", "decimals", "rounding", "unitPosition"]) {
    expect(body.includes(forbidden), forbidden).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// (T04-10) **段0 の実測を検査として残す**(メインの裁定「決定23」の根拠そのもの)
//
// **【なぜこの検査を置くか】** **`v8-m12.md` §1-0d の決定18 は「`var(--…)` の文字列を
// そのまま `@nivo` の `colors` に渡す」と書いていた。** **`V8-M12-T04` の実測がそれを
// 覆し、メインが決定23 に改めた。** **本検査は、将来また誰かが決定18 の形に戻すのを
// 止めるために、覆した実測そのものを固定する。**
//
// **【この検査が測っていないこと】** **本物のブラウザでどうなるかを1件も測っていない。**
// **ブラウザでは `getComputedStyle(document.documentElement)` が値を返すので例外にはならず、
// 代わりに `.app-theme` に注入したアプリ単位のテーマが届かない**(こちらは未実測である)。
// ---------------------------------------------------------------------------

test("(T04-10) @nivo/bar の colors に var(--…) を渡すと描画が丸ごと落ちる(だから棒は自前で描いている)", () => {
  // **`@nivo` をこのファイルが引いているのは、この1本の検査のためだけである** ——
  // **`web/src/` の側で引いているのは今日も `ReportViewRenderer.tsx` 1本だけである**
  // (直上の (T04-7) がそれを固定している)。
  const bar = require("@nivo/bar") as typeof import("@nivo/bar");
  const line = require("@nivo/line") as typeof import("@nivo/line");
  const data = [{ g: "東", s0: 12345 }];
  // **棒**: **`react-spring` が `var(--x)` を解決できず、例外で1ピクセルも描かれない。**
  expect(() =>
    render(
      <bar.Bar
        width={640}
        height={320}
        data={data}
        keys={["s0"]}
        indexBy="g"
        colors={["var(--color-danger)"]}
      />,
    ),
  ).toThrow();
  cleanup();
  // **折れ線**: **同じ文字列を渡しても落ちない**(`stroke` 属性に文字列のまま残る)——
  // **「`@nivo` は `var()` を通す」と一括りに書けない理由がこれである。**
  expect(() =>
    render(
      <line.Line
        width={640}
        height={320}
        data={[{ id: "s0", data: [{ x: "東", y: 12345 }] }]}
        colors={["var(--color-danger)"]}
      />,
    ),
  ).not.toThrow();
  expect(
    [...document.querySelectorAll("path[stroke]")].map((path) => path.getAttribute("stroke")),
  ).toContain("var(--color-danger)");
});

// ---------------------------------------------------------------------------
// (T04-11) 凡例(**メインの裁定2**。`D-V8-1` の例 (ii)「週単位の新規タスクと
//          終わったタスク」= 1つの集計表に2つの数 / 決定4「系列は集計列の全部」)
//
// **【なぜ足したか】** **どの線がどの数か読めなければ、`D-V8-1` の例 (ii) を
// グラフで満たしたことにならない。** **これは限界の申告ではなく、要件の未達だった。**
//
// | # | 何を | どう見るか |
// |---|---|---|
// | (T04-11a) | **棒でも折れ線でも凡例が1つ出て、項目数が系列の本数と一致する** | 項目を数える |
// | (T04-11b) | **凡例の色は系列の色と同じ**(3本目は `--color-text-secondary`) | inline style |
// | (T04-11c) | **凡例の文字列は表の列見出しと1バイト違わない** | 上と下を突き合わせる |
// | (T04-11d) | **系列が1本のときも出す**(条件分岐を作らない) | 項目を数える |
// | (T04-11e) | **群0件・400・401・403 では凡例も1つも出ない** | 器ごと消える |
// | (T04-11f) | **凡例の色にも16進が1文字も無い** | ソースを読む |
// ---------------------------------------------------------------------------

function legendItems(): HTMLElement[] {
  return screen.queryAllByTestId("report-chart-legend-item");
}

function legendTexts(): string[] {
  return legendItems().map((item) => item.textContent ?? "");
}

/** 色見本に当てた inline style。**`var(--…)` の文字列がそのまま入っている。** */
function legendColors(): string[] {
  return legendItems().map(
    (item) =>
      item.querySelector("[data-testid=report-chart-legend-swatch]")?.getAttribute("style") ?? "",
  );
}

test("(T04-11a) 棒でも折れ線でも凡例が1つ出て、項目の数が系列の本数と一致する", async () => {
  for (const chart of ["bar", "line"] as const) {
    cleanup();
    responseBody = chartGroups([
      { key: "東", values: [12345, 3, 7] },
      { key: "西", values: [600, 2, 4] },
    ]);
    renderReport(chartManifest({ chart, series: 3, unit: "円" }));
    await findReportTable();
    expect(screen.queryAllByTestId("report-chart-legend"), chart).toHaveLength(1);
    // **2種で形を割らない** —— **割れているのは色の渡し方だけである。**
    expect(legendItems(), chart).toHaveLength(3);
  }
});

test("(T04-11a) 凡例はグラフの直下・表の上に出る(SVG の中に描いていない)", async () => {
  responseBody = chartGroups([{ key: "東", values: [12345, 3] }]);
  renderReport(chartManifest({ chart: "bar", unit: "円" }));
  const table = await findReportTable();
  const legend = screen.getByTestId("report-chart-legend");
  // **グラフの `svg` の中に1つも入っていない**(`@nivo` の `legends` を使っていない)。
  expect(legend.closest("svg")).toBeNull();
  // **表より前にある。**
  expect(legend.compareDocumentPosition(table) & 4).toBe(4);
});

test("(T04-11b) 凡例の色は系列の色と同じで、3本目は --color-text-secondary である", async () => {
  for (const chart of ["bar", "line"] as const) {
    cleanup();
    responseBody = chartGroups([{ key: "東", values: [12345, 3, 7] }]);
    renderReport(chartManifest({ chart, series: 3, unit: "円" }));
    await findReportTable();
    const colors = legendColors();
    for (const [index, slot] of SERIES_COLOR_SLOTS.entries()) {
      expect(colors[index], `${chart}[${index}]`).toContain(slot);
    }
    // **16進が1文字も入っていない。**
    for (const color of colors) {
      expect(/#[0-9a-fA-F]{3,8}\b/.test(color), chart).toBe(false);
    }
  }
});

test("(T04-11c) 凡例の文字列は、表の列見出しと1バイト違わない", async () => {
  responseBody = chartGroups([{ key: "東", values: [12345, 3, 7] }]);
  renderReport(chartManifest({ chart: "line", series: 3, unit: "円" }));
  await findReportTable();
  // **表の列見出しは「束ねるキー1本 + 集計列3本」である** —— 先頭を落とすと系列の見出し。
  expect(legendTexts()).toEqual(headerTexts().slice(1));
  expect(legendTexts()).toEqual(["金額の合計", "件数", "数量の合計"]);
});

test("(T04-11d) 系列が1本のときも凡例を出す(「1本なら出さない」という分岐を作らない)", async () => {
  responseBody = chartGroups([{ key: "東", values: [12345] }]);
  renderReport(chartManifest({ chart: "bar", series: 1, unit: "円" }));
  await findReportTable();
  expect(legendItems()).toHaveLength(1);
  expect(legendTexts()).toEqual(["金額の合計"]);
});

test("(T04-11e) 群が0件のとき・400・401・403 のときは、凡例も1つも出ない", async () => {
  responseBody = { groups: [], total_groups: 0, totals: [{ type: "count", value: 0 }] };
  renderReport(chartManifest({ chart: "bar", unit: "円" }));
  await screen.findByTestId("report-empty");
  expect(legendItems()).toHaveLength(0);
  for (const status of [400, 401, 403] as const) {
    cleanup();
    responseStatus = status;
    responseBody = { errors: [{ path: "", message: "出せません。" }] };
    renderReport(chartManifest({ chart: "line", unit: "円" }));
    await screen.findByTestId("report-error");
    expect(legendItems(), String(status)).toHaveLength(0);
    expect(screen.queryAllByTestId("report-chart-legend"), String(status)).toHaveLength(0);
  }
});

test("(T04-11f) 凡例の色は系列の色と同じ1つの表から引いている(2本目の色の表を作っていない)", () => {
  const body = readFileSync(join(WEB_ROOT, "src", "views", "ReportViewRenderer.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  // **色の表は1つだけである**(`SERIES_COLORS` の宣言は1本)。
  expect([...body.matchAll(/const SERIES_COLORS/g)]).toHaveLength(1);
  // **凡例の色見本も同じ表から引いている** —— **16進を書いていないことは (T04-7) が見る。**
  expect(/backgroundColor: SERIES_COLORS\[/.test(body)).toBe(true);
  // **クラス名として色を組み立てていない**(枝番 乙3)。
  expect(/\b(bg|text|fill|stroke|border)-\[/.test(body)).toBe(false);
});

// ---------------------------------------------------------------------------
// **【`V8-M12-T06` の追記。メインの裁定「直す1」】横軸のラベルの間引き**
//
// **`T06` が chromium で測った実測**: **群100 のとき、横軸のラベルは 100本すべて描かれ、
// 隣り合う 99 組が**全部**重なっていた**(`_id` で束ねた UUID でも、`date` で束ねた
// `2026-01-01`(約63px)でも同じ 99/99)。**目盛りの間隔は 5.98px しかない。**
//
// **画面の1ページは既定で100群である**(`REPORT_PAGE_SIZE`)—— **満杯のページでは
// 横軸が必ず読めない。** **「既定の使い方で読めないグラフ」を配ることになるので直す。**
//
// **直したのはラベルだけである** —— **棒も線も1本も間引いていない**((M12-T06-4))。
// ---------------------------------------------------------------------------

/** 横軸のラベル(**群のキーそのものだけを拾う**。縦軸の数と混ざらない)。 */
function axisBottomLabels(keys: string[]): string[] {
  const known = new Set(keys);
  return chartTexts().filter((text) => known.has(text));
}

/** 群を n 個作る(キーは `g0`…`g(n-1)`。**縦軸の数と1文字も衝突しない**)。 */
function manyGroups(count: number): { keys: string[]; body: Record<string, unknown> } {
  const keys = Array.from({ length: count }, (_unused, index) => `g${index}`);
  return {
    keys,
    body: chartGroups(keys.map((key, index) => ({ key, values: [index + 1, 1] }))),
  };
}

test("(M12-T06-1) 群が10以下のときは、横軸のラベルを1本も間引かない(群3ならラベル3本)", async () => {
  const { keys, body } = manyGroups(3);
  responseBody = body;
  renderReport(chartManifest({ chart: "bar" }));
  await findReportTable();
  expect(axisBottomLabels(keys)).toEqual(keys);
});

test("(M12-T06-1) 群がちょうど10のときも、横軸のラベルを1本も間引かない", async () => {
  const { keys, body } = manyGroups(10);
  responseBody = body;
  renderReport(chartManifest({ chart: "bar" }));
  await findReportTable();
  expect(axisBottomLabels(keys)).toEqual(keys);
});

test("(M12-T06-2) 群が100のとき、横軸のラベルは10本ちょうどに間引かれる(棒)", async () => {
  const { keys, body } = manyGroups(100);
  responseBody = body;
  renderReport(chartManifest({ chart: "bar" }));
  await findReportTable();
  expect(axisBottomLabels(keys)).toHaveLength(10);
});

test("(M12-T06-2) 折れ線でも同じ10本ちょうどである(2種で形を割らない)", async () => {
  const { keys, body } = manyGroups(100);
  responseBody = body;
  renderReport(chartManifest({ chart: "line" }));
  await findReportTable();
  expect(axisBottomLabels(keys)).toHaveLength(10);
});

test("(M12-T06-3) 間引いても、先頭と末尾のラベルは必ず群の先頭と末尾である", async () => {
  const { keys, body } = manyGroups(100);
  responseBody = body;
  renderReport(chartManifest({ chart: "bar" }));
  await findReportTable();
  const labels = axisBottomLabels(keys);
  expect(labels[0]).toBe(keys[0]);
  expect(labels.at(-1)).toBe(keys.at(-1));
  // **等間隔である**(先頭・末尾を含めて 100群を 10本に割る = 11群おき)。
  expect(labels).toEqual(["g0", "g11", "g22", "g33", "g44", "g55", "g66", "g77", "g88", "g99"]);
});

test("(M12-T06-4) 間引いたのはラベルだけで、棒も線も1本も間引いていない", async () => {
  const { body } = manyGroups(100);
  responseBody = body;
  renderReport(chartManifest({ chart: "bar" }));
  await findReportTable();
  // **群100 × 系列2 = 200本の棒がそのまま描かれている。**
  expect(barRects()).toHaveLength(200);
});
