/**
 * 一覧を見ている人が、その場で並び順を変えられる(`V4-M19-T06`)。
 *
 * **門A の判定は「将来送り」であり、本タスクはその送り先の履行である。ADR は無い(台帳1行)。**
 * **ユーザ決定 `D-V4-79` の逐語**: 「その場で変えられるようにする。**ただし保存はしない**」。
 *
 * ## このファイルが固定すること
 *
 * | # | 何を | どう見るか |
 * |---|---|---|
 * | (a) | **列ヘッダがボタンで、押すとサーバへ投げ直す** | 飛んだ URL に `sort=` が載る |
 * | (b) | 同じ列は昇順 ⇄ 降順、別の列は昇順から | 続けて押して URL を読む |
 * | (c) | **`aria-sort` が出る**(`ascending` / `descending` / `none`) | `<th>` の属性 |
 * | (d) | **2ページ目で並び順を変えると先頭ページへ戻る** | `offset=` が URL から消える |
 * | (e) | **記録に1バイトも残らない** | `localStorage` / `sessionStorage` / URL / ソース |
 * | (f) | **次に開いたときには `view.sort` に戻る** | 描き直して URL を読む |
 * | (g) | **カードの器には並べ替えの口が無い** | `preset_list_shape: "card"` で0件 |
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * 1. **実際に並び替わることを1件も測っていない。** 並べ替えるのはサーバ(カーネル)であり、
 *    ここが見ているのは「**その条件でサーバに投げ直した**」ことだけである。3経路の一致は
 *    `web/test/composite-sort.test.tsx` が持つ。
 * 2. **chromium で1度も見ていない。** 矢印が読めるか・押しやすいかは1件も測っていない。
 * 3. **支援技術で使えるかを1本も測っていない**(`aria-sort` の属性値を読んだだけである)。
 * 4. **【禁止】「並べ替えの記録が残せるようになった」と書かない** —— 残らない。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ListView, Manifest } from "../../src/kernel/types.ts";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";

const APP_ID = "sort-app";
const RENDERER_PATH = join(import.meta.dir, "..", "src", "views", "ListViewRenderer.tsx");

function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "並べ替えのサンプル",
      tables: [
        {
          id: "items",
          name: "備品",
          fields: [
            { id: "name", name: "備品名", type: "text" },
            { id: "quantity", name: "数量", type: "number" },
          ],
        },
      ],
      views: [
        { id: "item-list", type: "list_view", table: "items", columns: ["name", "quantity"] },
      ],
    },
  } as unknown as Manifest;
}

function listWith(overrides: Partial<ListView>): Manifest {
  const manifest = baseManifest();
  Object.assign(manifest.app.views[0] as ListView, overrides);
  return manifest;
}

/** 1ページぶん(既定 50 件)の行。ページャを出すために総件数はこれより多くする。 */
function pageRows(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_value, index) => ({
    _id: `rec-${index}`,
    _created_at: "",
    _updated_at: "",
    name: `備品${index}`,
    quantity: index,
  }));
}

let requests: string[];
let originalFetch: typeof fetch;
let recordCount = 2;
let totalCount = 2;

beforeEach(() => {
  requests = [];
  recordCount = 2;
  totalCount = 2;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    requests.push(url);
    // **並べ替えはサーバの仕事である。** スタブは条件を1つも解釈しない ——
    // ここが見るのは「どんな条件で投げ直したか」だけである。
    return new Response(JSON.stringify({ records: pageRows(recordCount), total: totalCount }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/item-list`);
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function renderList(manifest: Manifest = baseManifest()) {
  return render(
    <ListViewRenderer
      appId={APP_ID}
      manifest={manifest}
      view={manifest.app.views[0] as ListView}
    />,
  );
}

/** レコード取得の URL だけを見る(参照ラベルの取得は本ファイルの関心ではない)。 */
function recordRequests(): string[] {
  return requests.filter((url) => url.includes("/tables/items/records"));
}

function lastRecordRequest(): string {
  const all = recordRequests();
  return all[all.length - 1] ?? "";
}

async function findTable(): Promise<HTMLElement> {
  return await screen.findByTestId("list-table");
}

/** 列見出しの並べ替えボタン(列 id 指定)。 */
function sortButton(fieldId: string): HTMLElement {
  const button = screen
    .getAllByTestId("list-sort")
    .find((candidate) => candidate.getAttribute("data-field") === fieldId);
  if (button === undefined) {
    throw new Error(`列 "${fieldId}" の並べ替えボタンがありません。`);
  }
  return button;
}

function ariaSorts(): (string | null)[] {
  return screen.getAllByRole("columnheader").map((cell) => cell.getAttribute("aria-sort"));
}

/** URL が変わってレコードを取り直すまで待つ。 */
async function waitForRequest(fragment: string): Promise<void> {
  await waitFor(() => expect(lastRecordRequest()).toContain(fragment));
}

// ---------------------------------------------------------------------------
// (a) 列ヘッダはボタンで、押すとサーバへ投げ直す
// ---------------------------------------------------------------------------

test("(a) 列ヘッダはボタンであり、押すとその列でサーバに投げ直す", async () => {
  renderList();
  await findTable();
  // 何も打っていないので、最初の取得には並び順が1つも載っていない。
  expect(lastRecordRequest()).not.toContain("sort=");

  const button = sortButton("quantity");
  expect(button.tagName.toLowerCase()).toBe("button");
  expect((button as HTMLButtonElement).type).toBe("button");

  const before = recordRequests().length;
  fireEvent.click(button);
  await waitForRequest("sort=quantity");
  // **フロントで並べ替えていない** —— 取得が1回増えている(投げ直している)。
  expect(recordRequests().length).toBeGreaterThan(before);
  expect(lastRecordRequest()).toContain("order=asc");
});

test("(a) 列ヘッダのボタンは列の表示名をそのまま出す(列見出しの文字を変えない)", async () => {
  renderList();
  await findTable();
  expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
    "備品名",
    "数量",
  ]);
});

// ---------------------------------------------------------------------------
// (b) 同じ列は昇順 ⇄ 降順、別の列は昇順から
// ---------------------------------------------------------------------------

test("(b) 同じ列をもう一度押すと降順になり、別の列を押すと昇順から始まる", async () => {
  renderList();
  await findTable();

  fireEvent.click(sortButton("quantity"));
  await waitForRequest("order=asc");
  expect(lastRecordRequest()).toContain("sort=quantity");

  fireEvent.click(sortButton("quantity"));
  await waitForRequest("order=desc");
  expect(lastRecordRequest()).toContain("sort=quantity");

  fireEvent.click(sortButton("name"));
  await waitForRequest("sort=name");
  expect(lastRecordRequest()).toContain("order=asc");
});

test("(b) 宣言された並び順の列を押すと、そこから昇順で始まる(宣言を読み取って続けない)", async () => {
  // **宣言が降順でも、押した1回目は昇順である** —— 「押したら向きが変わる」ではなく
  // 「押した列で並べ替える(既定は昇順)」であることを固定する。
  renderList(listWith({ sort: { field: "quantity", order: "desc" } }));
  await findTable();
  expect(lastRecordRequest()).toContain("order=desc");
  fireEvent.click(sortButton("quantity"));
  await waitForRequest("order=asc");
});

// ---------------------------------------------------------------------------
// (c) aria-sort
// ---------------------------------------------------------------------------

test("(c) 並び順を1つも宣言していない画面では、全列の aria-sort が none である", async () => {
  renderList();
  await findTable();
  expect(ariaSorts()).toEqual(["none", "none"]);
});

test("(c) 宣言された並び順の列にだけ ascending / descending が出る", async () => {
  renderList(listWith({ sort: { field: "quantity", order: "desc" } }));
  await findTable();
  expect(ariaSorts()).toEqual(["none", "descending"]);
  cleanup();
  renderList(listWith({ sort: { field: "name", order: "asc" } }));
  await findTable();
  expect(ariaSorts()).toEqual(["ascending", "none"]);
});

test("(c) 打った並び順が aria-sort に出る(打った列だけ。他は none のまま)", async () => {
  renderList();
  await findTable();
  fireEvent.click(sortButton("name"));
  await waitForRequest("sort=name");
  await waitFor(() => expect(ariaSorts()).toEqual(["ascending", "none"]));
  fireEvent.click(sortButton("name"));
  await waitForRequest("order=desc");
  await waitFor(() => expect(ariaSorts()).toEqual(["descending", "none"]));
});

test("(c) 複合ソート(2キー)を宣言した画面では、先頭キーの列にだけ印が出る", async () => {
  // **【正直に書く】打てるのは1列だけである。** 宣言が2キーでも印は先頭キーにしか
  // 出さない —— 2列に印を出すと、押して打てるもの(1列)と印が食い違う。
  renderList(
    listWith({
      sort: [
        { field: "quantity", order: "desc" },
        { field: "name", order: "asc" },
      ],
    }),
  );
  await findTable();
  expect(ariaSorts()).toEqual(["none", "descending"]);
});

test("(c) 打つと宣言された複合の並びは丸ごと1列に置き換わる(2列目以降は消える)", async () => {
  renderList(
    listWith({
      sort: [
        { field: "quantity", order: "desc" },
        { field: "name", order: "asc" },
      ],
    }),
  );
  await findTable();
  expect(lastRecordRequest()).toContain("sort=quantity");
  expect(lastRecordRequest()).toContain("sort=name");

  fireEvent.click(sortButton("name"));
  await waitForRequest("sort=name");
  // **1キーだけになる**(`sort=` が1つ)。**これは代償であり、隠さない。**
  expect(lastRecordRequest().match(/sort=/g)).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// (d) 2ページ目で並び順を変えると先頭ページへ戻る(`ADR-0042` との噛み合わせ)
// ---------------------------------------------------------------------------

test("(d) 2ページ目を開いてから並び順を変えると、先頭ページへ戻る", async () => {
  recordCount = 50;
  totalCount = 120;
  renderList();
  await findTable();
  expect(lastRecordRequest()).not.toContain("offset=");

  fireEvent.click(screen.getByTestId("list-next"));
  await waitForRequest("offset=50");

  fireEvent.click(sortButton("quantity"));
  await waitForRequest("sort=quantity");
  // **新しい reset の仕組みを作っていない** —— 既存の `viewKey` に並び順が入っただけである。
  expect(lastRecordRequest()).not.toContain("offset=");
});

// ---------------------------------------------------------------------------
// (e) 記録に1バイトも残らない
// ---------------------------------------------------------------------------

test("(e) 打った並び順はブラウザの保存領域にも URL にも1バイトも残らない", async () => {
  renderList();
  await findTable();
  const url = window.location.href;
  fireEvent.click(sortButton("quantity"));
  await waitForRequest("sort=quantity");
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
  expect(document.cookie).toBe("");
  expect(window.location.href).toBe(url);
});

test("(e) 保存する経路がソースに1本も無い(localStorage / sessionStorage / cookie / 書込API)", () => {
  // **見るのは「使っている形」である** —— コメントの中の字面(「`localStorage` にも
  // 保存しない」)を保存経路と読み違えないため、`.setItem(` まで含めて見る。
  const source = readFileSync(RENDERER_PATH, "utf-8");
  for (const forbidden of [
    "localStorage.setItem",
    "sessionStorage.setItem",
    "document.cookie",
    "history.replace",
  ]) {
    expect(source.includes(forbidden), forbidden).toBe(false);
  }
  // マニフェストへ書き戻す経路(差分の適用)も1本も無い。
  expect(source).not.toContain("update_view");
  expect(source).not.toContain("/diffs");
});

test("(e) 打っても書込のリクエストが1件も飛ばない(GET だけである)", async () => {
  renderList();
  await findTable();
  fireEvent.click(sortButton("quantity"));
  await waitForRequest("sort=quantity");
  // スタブは URL しか受け取っていないので、ここでは「取得先が records だけである」ことを見る。
  for (const url of requests) {
    expect(url).toContain("/records");
  }
});

// ---------------------------------------------------------------------------
// (f) 次に開いたときには `view.sort` に戻る
// ---------------------------------------------------------------------------

test("(f) 描き直すと宣言された並び順に戻る(打った並び順は残らない)", async () => {
  const manifest = listWith({ sort: { field: "quantity", order: "desc" } });
  renderList(manifest);
  await findTable();
  fireEvent.click(sortButton("name"));
  await waitForRequest("sort=name");

  cleanup();
  requests = [];
  renderList(manifest);
  await findTable();
  expect(lastRecordRequest()).toContain("sort=quantity");
  expect(lastRecordRequest()).toContain("order=desc");
  expect(lastRecordRequest()).not.toContain("sort=name");
});

// ---------------------------------------------------------------------------
// (g) カードの器には並べ替えの口が無い
// ---------------------------------------------------------------------------

test("(g) card の一覧には列ヘッダが無いので、並べ替えの口が1つも出ない", async () => {
  renderList(listWith({ preset_list_shape: "card" }));
  await screen.findByTestId("list-cards");
  expect(screen.queryAllByTestId("list-sort")).toHaveLength(0);
  expect(screen.queryAllByRole("columnheader")).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// 実装の判断がコメントに書いてあること(このリポジトリの作法)
// ---------------------------------------------------------------------------

test("サーバに投げ直す理由と、解けないことがレンダラーのコメントに書いてある", () => {
  const source = readFileSync(RENDERER_PATH, "utf-8");
  for (const marker of [
    // 投げ直す理由(ページネーションとの噛み合わせ)
    "いま見えている1ページの中だけ",
    // 先例(ページ位置と同じ性質の一時状態である)
    "`offset`(ページ位置。`ADR-0042`)と同じ性質",
    // 解けないこと3点
    "次に画面を開いたときには `view.sort` に戻る",
    "複合ソート(2列以上の組)は打てない",
    "カードの器には並べ替えの口が無い",
  ]) {
    expect(source.includes(marker), marker).toBe(true);
  }
});
