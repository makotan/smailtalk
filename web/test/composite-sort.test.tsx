/**
 * V1-M0-T03 完了条件3: **並び替えの解釈がカーネル / HTTP / レンダラで一致する。**
 *
 * 計画書が警告しているのは「3箇所で別々に配列対応すると、複合ソートの解釈が割れる」で
 * ある。割れていないことを、**同じマニフェスト・同じデータ・同じ `sort` 定義**に対して
 * 3経路の結果を突き合わせて確かめる。
 *
 * - **カーネル**: `readRecordList`(`app.sqlite` を直接開く)
 * - **HTTP**: 実サーバ(`createServerApp`)に `GET .../records?sort=..&order=..` を投げる
 * - **レンダラ**: `ListViewRenderer` が `view.sort` をそのまま `fetchRecords` に渡し、
 *   画面に描かれた行の順序を読む(クエリの組み立ては `web/src/api.ts` が行う)
 *
 * レンダラ経路を「api.ts の返り値」ではなく **DOM の行順**で見ているのは、
 * `ListViewRenderer` が受け取った順序をそのまま描くことまで込みで完了条件だからである。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  applyManifest,
  createApp,
  createRecord,
  KernelMetaStore,
  type ListView,
  type Manifest,
  type Sort,
} from "../../src/kernel/index.ts";
import { readRecordList } from "../../src/kernel/read-records.ts";
import { appDbPath } from "../../src/kernel/storage-paths.ts";
import { createServerApp } from "../../src/server/app.ts";
import { seedSession, TEST_ORIGIN } from "../../src/server/test-helpers.ts";
import { fetchRecords } from "../src/api.ts";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";
import { ADMIN_ROLES, grantRules, tableCan, viewRead } from "./role-rules.ts";

const APP_ID = "book-log";
const originalFetch = globalThis.fetch;

/** 評価が同点になる行を含む、F-8 そのままのデータ。 */
const rows = [
  { title: "a", rating: 3, finished_on: "2026-01-05" },
  { title: "b", rating: 5, finished_on: "2026-03-01" },
  { title: "c", rating: 3, finished_on: "2026-02-10" },
  { title: "d", rating: 5, finished_on: "2026-01-20" },
];

function manifestWith(sort: Sort | Sort[] | undefined): Manifest {
  const view: ListView = {
    id: "book-list",
    type: "list_view",
    table: "books",
    columns: ["title", "rating", "finished_on"],
    ...(sort === undefined ? {} : { sort }),
  };
  const manifest: Manifest = {
    app: {
      id: APP_ID,
      name: "読書記録",
      tables: [
        {
          id: "books",
          name: "本",
          fields: [
            { id: "title", name: "タイトル", type: "text", required: true },
            { id: "rating", name: "評価", type: "number" },
            { id: "finished_on", name: "読み終わり", type: "date" },
          ],
        },
      ],
      views: [view],
    },
  };
  // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`】表の既定が「閉じる」側へ倒れた。**
  //
  // **着手前の逐語(1バイトも消していない): この題材は `app.roles` を1つも持たず、
  // HTTP 経路もレンダラ経路もそのまま4行を読めていた。** **今日は読めない** —— **実測**:
  // **`GET .../records?sort=..` は 403 にならず 200 のまま `{"records":[],"total":0}` を返す**
  // (**面は一覧を拒否せず、行を1件も通さない**)。**その結果 HTTP 経路が `[]` になり、
  // レンダラ経路は行が描かれず `waitFor` が時間切れになる。**
  //
  // **足すのは表 `books` の読取だけである** —— **この検査の主題は「並び替えの解釈が
  // カーネル / HTTP / レンダラで一致すること」であって権限ではない。書込・削除・
  // 画面・ボタン・項目の規則は1本も足さない**(レコードはカーネルの `createRecord` が
  // 直に入れるので、書込の規則は要らない)。
  // **既定の3役割(owner / editor / viewer)を全部宣言し、どれも規則を1本以上持たないと
  // `applyManifest` が `valid: false` になる**(適用時検査。実測)。
  // **【`V18-M4-T02b`。ユーザ決定 `D-V18-26` / `ADR-0441`】画面の規則を1本足した。**
  //
  // **`V18-M4-T02` が「画面名を名乗らない読取」に壁を立てた** —— **その表を指す、
  // 要求の形に合う画面(一覧の口 → `list_view` / `report_view`)を**1本も読めない**相手の
  // 一覧は 0件になる。** **`D-V18-26` により、画面を宣言しているのに「誰に見せるか」を
  // 役割の規則に1行も書いていない場合も止まる。**
  //
  // **この題材は `book-list`(`list_view`)を宣言しながら、その画面の規則を1本も
  // 書いていなかった** —— **今日の正から見て設計図が不完全だった。**
  // **足すのは画面 `book-list` の読取だけである。** **この検査の主題は「並び替えの解釈が
  // カーネル / HTTP / レンダラで一致すること」であって権限ではないので、
  // 主張(`expect`)は1バイトも書き換えていない。**
  return grantRules(manifest, ADMIN_ROLES, [tableCan("books", "read"), viewRead("book-list")]);
}

let dataRoot: string;
let server: ReturnType<typeof createServerApp>;
/** 認証境界(ADR-0014)を通すためのセッション cookie。 */
let cookie: string;

/** cookie/Origin を付けて実サーバへ GET する(認証境界の手前を通す)。 */
function serverGet(url: string): Response | Promise<Response> {
  return server.request(new Request(url, { headers: { cookie, origin: TEST_ORIGIN } }));
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-3way-sort-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "読書記録", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, manifestWith(undefined)).valid).toBe(true);

  const db = new Database(appDbPath(dataRoot, APP_ID));
  try {
    for (const row of rows) {
      const created = createRecord(db, manifestWith(undefined), "books", row);
      expect(created.ok).toBe(true);
    }
  } finally {
    db.close();
  }

  server = createServerApp({ dataRoot });
  cookie = seedSession(dataRoot, APP_ID).cookie;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("cookie", cookie);
    if (!headers.has("origin")) {
      headers.set("origin", TEST_ORIGIN);
    }
    return server.request(new URL(String(input), "http://localhost").toString(), {
      ...init,
      headers,
    });
  }) as typeof fetch;
});

afterEach(async () => {
  cleanup();
  globalThis.fetch = originalFetch;
  await rm(dataRoot, { recursive: true, force: true });
});

/** カーネル経路。`app.sqlite` を開いて `readRecordList` を直接呼ぶ。 */
function kernelTitles(sort: Sort | Sort[]): string[] {
  const db = new Database(appDbPath(dataRoot, APP_ID));
  try {
    const result = readRecordList({ dataRoot, appDb: () => db }, manifestWith(sort), "books", {
      sort,
    });
    if (!result.ok) {
      throw new Error(`カーネル経路が失敗しました: ${JSON.stringify(result.errors)}`);
    }
    return result.value.map((row) => String(row.title));
  } finally {
    db.close();
  }
}

/** HTTP 経路。クエリ文字列を手で組んで実サーバへ投げる。 */
async function httpTitles(sort: Sort[]): Promise<string[]> {
  const query = sort
    .map((key) => `sort=${encodeURIComponent(key.field)}&order=${encodeURIComponent(key.order)}`)
    .join("&");
  const response = await serverGet(
    `http://localhost/api/apps/${APP_ID}/tables/books/records?${query}`,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { records: { title: string }[] };
  return body.records.map((record) => record.title);
}

/** レンダラ経路。`view.sort` をそのまま渡して描き、行の順序を DOM から読む。 */
async function rendererTitles(sort: Sort | Sort[]): Promise<string[]> {
  const source = manifestWith(sort);
  const view = source.app.views[0] as ListView;
  render(<ListViewRenderer appId={APP_ID} manifest={source} view={view} />);
  await waitFor(() => {
    expect(screen.getAllByRole("row").length).toBeGreaterThan(1);
  });
  const bodyRows = screen.getAllByRole("row").slice(1);
  return bodyRows.map((row) => row.querySelectorAll("td")[0]?.textContent ?? "");
}

describe("3経路一致(完了条件3)", () => {
  const cases: { name: string; sort: Sort[] }[] = [
    { name: "1キー(desc)", sort: [{ field: "rating", order: "desc" }] },
    {
      name: "2キー: 評価順、同点なら読み終わりが新しい順(F-8)",
      sort: [
        { field: "rating", order: "desc" },
        { field: "finished_on", order: "desc" },
      ],
    },
    {
      name: "2キー: asc / desc 混在",
      sort: [
        { field: "rating", order: "asc" },
        { field: "finished_on", order: "desc" },
      ],
    },
  ];

  for (const { name, sort } of cases) {
    test(name, async () => {
      const kernel = kernelTitles(sort);
      const http = await httpTitles(sort);
      const renderer = await rendererTitles(sort);
      expect(http).toEqual(kernel);
      expect(renderer).toEqual(kernel);
    });
  }

  test("単数オブジェクト表記でも3経路が一致する(後方互換)", async () => {
    const single: Sort = { field: "rating", order: "desc" };
    const kernel = kernelTitles(single);
    const http = await httpTitles([single]);
    const renderer = await rendererTitles(single);
    expect(http).toEqual(kernel);
    expect(renderer).toEqual(kernel);
  });

  test("F-8 の期待順そのもの(同点のタイブレークが効いている)", async () => {
    const sort: Sort[] = [
      { field: "rating", order: "desc" },
      { field: "finished_on", order: "desc" },
    ];
    expect(await rendererTitles(sort)).toEqual(["b", "d", "c", "a"]);
  });
});

describe("api.ts のクエリ組み立て", () => {
  test("配列の sort は sort= / order= の組を順番どおりに並べる", async () => {
    const calls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      calls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ records: [] }), {
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;
    await fetchRecords(APP_ID, "books", {
      sort: [
        { field: "rating", order: "desc" },
        { field: "finished_on", order: "asc" },
      ],
    });
    expect(calls[0]).toBe(
      `/api/apps/${APP_ID}/tables/books/records?sort=rating&order=desc&sort=finished_on&order=asc`,
    );
  });

  test("単数オブジェクトのクエリは従来と1バイトも変わらない", async () => {
    const calls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      calls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ records: [] }), {
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;
    await fetchRecords(APP_ID, "books", { sort: { field: "rating", order: "desc" } });
    expect(calls[0]).toBe(`/api/apps/${APP_ID}/tables/books/records?sort=rating&order=desc`);
  });
});

describe("HTTP のクエリ解釈(異常系)", () => {
  test("sort の数と order の数が食い違えば統一形式エラーで断る", async () => {
    const response = await serverGet(
      `http://localhost/api/apps/${APP_ID}/tables/books/records?sort=rating&sort=finished_on&order=desc`,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { errors: { path: string; hint?: string }[] };
    expect(body.errors[0]?.path).toBe("/sort/order");
    expect(body.errors[0]?.hint).toBeDefined();
  });

  test("order を省いた複数キーはすべて asc として解釈する", async () => {
    const response = await serverGet(
      `http://localhost/api/apps/${APP_ID}/tables/books/records?sort=rating&sort=finished_on`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { records: { title: string }[] };
    expect(body.records.map((record) => record.title)).toEqual(
      kernelTitles([
        { field: "rating", order: "asc" },
        { field: "finished_on", order: "asc" },
      ]),
    );
  });

  test("2つ目のキーの field が実在しなければ /sort/1/field を指す", async () => {
    const response = await serverGet(
      `http://localhost/api/apps/${APP_ID}/tables/books/records?sort=rating&order=desc&sort=ghost&order=asc`,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { errors: { path: string }[] };
    expect(body.errors[0]?.path).toBe("/sort/1/field");
  });
});
