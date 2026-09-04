/**
 * 参照項目を**打った文字で絞る**(`type_filter`)の器 —— 表示層
 * (`K-G11` / `K-G13` / `K-G14` / `K-G15`。`V6-M4-T01` 〜 `V6-M4-T03`)。
 *
 * **審査結果の正は `docs/plan/v6/records/v6-m0.md` §7-5 / §7-6**(単位D / 単位E)、
 * **完了条件の正は同 §6 の `V6-M4-T01` / `V6-M4-T02` / `V6-M4-T03` の行**である。
 * **単位D / 単位E は門外(`Δ7`)であり、個別 ADR を持たない**(同 §7-5 / §7-6 の `S6`)。
 *
 * ## このファイルが固定すること
 *
 * | # | 条件 | 検査 |
 * |---|---|---|
 * | (a) | **`K-G11`** 打った文字がサーバの読取に渡り、照合は `contains` の OR 固定 | 実際に飛んだ URL の `filter` を1葉ずつ読む |
 * | (b) | **`K-G11`** `buildSearchFilter` の規則を**再実装していない** | `web/src` を走査し、`or` + `contains` を組む実装が1ファイルにしか無いことを測る |
 * | (c) | **`K-G13`** 打つたびの取り直しに間隔がある | 連続して打っても取得が1回に畳まれる |
 * | (d) | **`K-G13`** 遅い応答が新しい応答を上書きしない | 先に投げた遅い応答を後から解決させ、画面が新しい方のままであることを測る |
 * | (e) | **`K-G14`** 一度に取る候補に上限が効く | URL の `limit` が {@link REFERENCE_CANDIDATE_LIMIT} である |
 * | (f) | **`K-G15`** 上限に当たったことが画面に出る(黙って切らない) | `total` が返した件数より多いとき、件数つきの案内が出る |
 * | (g) | **`list`(既定)の画面が今日と1ピクセルも変わらない** | 取得が1件も飛ばず、DOM が書かなかった項目と完全一致する |
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * 1. **本物の SQLite で1件も測っていない。** `fetch` を差し替えた表示層の検査である
 *    —— **サーバが同じ `filter` をどう解釈するかは `src/server/list-view-search-boundary.test.ts`
 *    が既に本物で測っている**(一覧の側)。**参照候補の側で本物を通した実測は0件である。**
 * 2. **`st_owner` / `audience` の遮断を1件も測っていない**(**`K-G18` は
 *    `web/test/reference-picker-visibility.test.ts` の担当である**)。
 * 3. **選択済みの値の保持を1件も測っていない**(**`K-G17` は
 *    `web/test/reference-picker-selected-value.test.tsx` の担当である**)。
 * 4. **上限の値(50)が妥当かどうかを1度も測っていない。** **描画時間を1度も測っていない**
 *    (`v6-m0.md` §11-1 の未確認がそのまま残っている)。
 * 5. **`search`(別の面を開いて探す)を1つも測っていない** —— **今日その器は1バイトも
 *    無い**(当たり先は `V6-M5`)。
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Field, FormView, Manifest, Table } from "../../src/kernel/types.ts";
import {
  FieldInput,
  type FieldInputValue,
  REFERENCE_CANDIDATE_LIMIT,
  type ReferenceChoices,
} from "../src/fields/input.tsx";

const APP_ID = "picker-app";
const TARGET_TABLE = "targets";

const WEB_SRC = join(dirname(import.meta.dir), "src");

function targetTable(): Table {
  return {
    id: TARGET_TABLE,
    name: "取引先",
    fields: [
      { id: "name", name: "名称", type: "text" },
      { id: "kana", name: "よみ", type: "text" },
      { id: "note", name: "備考", type: "long_text" },
    ],
  };
}

function manifestWith(table: Table = targetTable()): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "選び方のサンプル",
      tables: [
        {
          id: "orders",
          name: "注文",
          fields: [
            { id: "customer_id", name: "取引先", type: "reference", reference_table: TARGET_TABLE },
          ],
        },
        table,
      ],
      views: [],
    },
  } as unknown as Manifest;
}

function referenceField(
  picker?: "list" | "type_filter" | "search",
  searchFields?: string[],
): Field {
  const field = {
    id: "customer_id",
    name: "取引先",
    type: "reference",
    reference_table: TARGET_TABLE,
  } as Extract<Field, { type: "reference" }>;
  return {
    ...field,
    ...(picker === undefined ? {} : { reference_picker: picker }),
    ...(searchFields === undefined ? {} : { reference_search_fields: searchFields }),
  } as Field;
}

function form(pickers?: FormView["reference_pickers"]): FormView {
  const view: FormView = {
    id: "order-form",
    type: "form",
    table: "orders",
    fields: ["customer_id"],
  };
  return pickers === undefined ? view : { ...view, reference_pickers: pickers };
}

function readyChoices(): ReferenceChoices {
  return new Map([
    [
      TARGET_TABLE,
      {
        status: "ready" as const,
        value: [
          { id: "rec-1", label: "代表値1" },
          { id: "rec-2", label: "代表値2" },
        ],
      },
    ],
  ]);
}

// ---------------------------------------------------------------------------
// fetch の差し替え(`list-view-search.test.tsx` と同じ作法)
// ---------------------------------------------------------------------------

type Call = { url: string; method: string };

let originalFetch: typeof fetch;
/** **飛んだリクエストの全量**(メソッドつき)。書込が1件も無いことも、ここで数える。 */
let calls: Call[] = [];
/** 応答を遅らせるための保留キュー。空なら即答する。 */
let deferred: ((rows: { _id: string; name: string }[], total?: number) => void)[] = [];
let holdNext = false;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** 応答に載せる行。既定は3件。 */
let rows: { _id: string; name: string }[] = [
  { _id: "rec-1", name: "山田商会" },
  { _id: "rec-2", name: "山本工業" },
  { _id: "rec-3", name: "田中製作所" },
];
/** 応答の `total`。`undefined` なら `rows.length`。 */
let total: number | undefined;

beforeEach(() => {
  calls = [];
  deferred = [];
  holdNext = false;
  total = undefined;
  rows = [
    { _id: "rec-1", name: "山田商会" },
    { _id: "rec-2", name: "山本工業" },
    { _id: "rec-3", name: "田中製作所" },
  ];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
    if (holdNext) {
      holdNext = false;
      return await new Promise<Response>((resolve) => {
        deferred.push((held, heldTotal) =>
          resolve(jsonResponse({ records: held, total: heldTotal ?? held.length })),
        );
      });
    }
    return jsonResponse({ records: rows, total: total ?? rows.length });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function renderReference(
  field: Field,
  options: { value?: FieldInputValue; view?: FormView; manifest?: Manifest } = {},
): string {
  const onChange = mock((_value: FieldInputValue) => {});
  const { container } = render(
    <FieldInput
      field={field}
      inputId="input-under-test"
      value={options.value ?? ""}
      onChange={onChange}
      appId={APP_ID}
      referenceChoices={readyChoices()}
      {...(options.view === undefined ? {} : { view: options.view })}
      {...(options.manifest === undefined ? {} : { manifest: options.manifest })}
    />,
  );
  return container.innerHTML;
}

/** 参照候補の取得のうち**最後のもの**のクエリを読む。 */
function lastCandidateQuery(): URLSearchParams {
  const last = calls.filter((call) => call.url.includes(`/tables/${TARGET_TABLE}/records`)).at(-1);
  if (last === undefined) {
    throw new Error("参照候補の取得が1件も無い");
  }
  return new URL(last.url, "http://localhost").searchParams;
}

function candidateCalls(): Call[] {
  return calls.filter((call) => call.url.includes(`/tables/${TARGET_TABLE}/records`));
}

async function typeTerm(word: string): Promise<void> {
  const input = screen.getByTestId("reference-search-customer_id") as HTMLInputElement;
  fireEvent.change(input, { target: { value: word } });
}

/** `web/src` 配下の `.ts` / `.tsx` を全部集める。 */
function webSourceFiles(directory: string = WEB_SRC): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      return webSourceFiles(full);
    }
    return entry.endsWith(".ts") || entry.endsWith(".tsx") ? [full] : [];
  });
}

// ---------------------------------------------------------------------------
// (a) `K-G11` 打った文字がサーバの読取に渡り、照合は contains の OR 固定
// ---------------------------------------------------------------------------

test("(a) type_filter を書いた項目には検索の口が出る", async () => {
  renderReference(referenceField("type_filter"), { manifest: manifestWith() });
  await waitFor(() => expect(screen.queryByTestId("reference-search-customer_id")).not.toBeNull());
});

test("(a) 打った文字が読取API の filter に contains の OR で渡る", async () => {
  renderReference(referenceField("type_filter", ["name", "kana"]), { manifest: manifestWith() });
  await waitFor(() => expect(candidateCalls().length).toBeGreaterThan(0));
  await typeTerm("やま");
  await waitFor(() => expect(lastCandidateQuery().get("filter")).not.toBeNull());
  const filter = JSON.parse(lastCandidateQuery().get("filter") as string);
  expect(filter).toEqual({
    or: [
      { field: "name", contains: "やま" },
      { field: "kana", contains: "やま" },
    ],
  });
});

test("(a) 何も打っていないときは filter を1バイトも載せない", async () => {
  renderReference(referenceField("type_filter", ["name"]), { manifest: manifestWith() });
  await waitFor(() => expect(candidateCalls().length).toBeGreaterThan(0));
  expect(lastCandidateQuery().get("filter")).toBeNull();
});

test("(a) 探せる項目を書かなければ、代表の項目1本で当たる(解決を再実装していない)", async () => {
  renderReference(referenceField("type_filter"), { manifest: manifestWith() });
  await waitFor(() => expect(candidateCalls().length).toBeGreaterThan(0));
  await typeTerm("やま");
  await waitFor(() => expect(lastCandidateQuery().get("filter")).not.toBeNull());
  expect(JSON.parse(lastCandidateQuery().get("filter") as string)).toEqual({
    or: [{ field: "name", contains: "やま" }],
  });
});

test("(a) 入力画面側で type_filter に上書きした項目でも打って絞れる", async () => {
  renderReference(referenceField(), {
    manifest: manifestWith(),
    view: form({ customer_id: "type_filter" }),
  });
  await waitFor(() => expect(screen.queryByTestId("reference-search-customer_id")).not.toBeNull());
});

test("(a) 探せる項目が0本のときは検索の口を出さず、そう出す(黙って全件にしない)", async () => {
  const table: Table = { id: TARGET_TABLE, name: "取引先", fields: [] };
  renderReference(referenceField("type_filter"), { manifest: manifestWith(table) });
  await waitFor(() =>
    expect(screen.queryByTestId("reference-search-unavailable-customer_id")).not.toBeNull(),
  );
  expect(screen.queryByTestId("reference-search-customer_id")).toBeNull();
});

// ---------------------------------------------------------------------------
// (b) `K-G11` `buildSearchFilter` の規則を再実装していない
// ---------------------------------------------------------------------------

test("(b) contains の OR を組む実装は web/src に1ファイルしか無い", () => {
  const files = webSourceFiles().filter((file) => {
    const source = readFileSync(file, "utf8");
    return source.includes("or: ") && source.includes("contains: ");
  });
  expect(files.map((file) => file.slice(WEB_SRC.length + 1))).toEqual(["views/search-filter.ts"]);
});

test("(b) 参照項目の入力は共有モジュールの buildSearchFilter を呼んでいる", () => {
  const source = readFileSync(join(WEB_SRC, "fields", "input.tsx"), "utf8");
  expect(source).toContain("buildSearchFilter");
  expect(source).toContain('from "../views/search-filter.ts"');
  // **一覧の側も同じ1本を呼んでいる**(2箇所目の実装を作っていない)。
  const list = readFileSync(join(WEB_SRC, "views", "ListViewRenderer.tsx"), "utf8");
  expect(list).toContain("buildSearchFilter");
  expect(list).toContain('from "./search-filter.ts"');
  expect(list).not.toContain("function buildSearchFilter(");
});

// ---------------------------------------------------------------------------
// (c)(d) `K-G13` 取り直しの間隔と、前後入れ替わりの防止
// ---------------------------------------------------------------------------

test("(c) 続けて打っても取得は1回に畳まれる", async () => {
  renderReference(referenceField("type_filter", ["name"]), { manifest: manifestWith() });
  await waitFor(() => expect(candidateCalls().length).toBe(1));
  await typeTerm("や");
  await typeTerm("やま");
  await typeTerm("やまだ");
  await waitFor(() => expect(candidateCalls().length).toBe(2));
  // 最後に打った語だけが飛ぶ。
  expect(JSON.parse(lastCandidateQuery().get("filter") as string)).toEqual({
    or: [{ field: "name", contains: "やまだ" }],
  });
  // 間隔のあいだに追加の取得が起きていないことを、少し待って確かめる。
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(candidateCalls().length).toBe(2);
});

test("(d) 遅い応答が新しい応答を上書きしない", async () => {
  renderReference(referenceField("type_filter", ["name"]), { manifest: manifestWith() });
  await waitFor(() => expect(candidateCalls().length).toBe(1));

  // 1回目(遅い方)を保留させる。
  holdNext = true;
  await typeTerm("や");
  await waitFor(() => expect(deferred.length).toBe(1));

  // 2回目(速い方)は即答する。
  rows = [{ _id: "rec-9", name: "新しい方" }];
  await typeTerm("やまだ");
  await waitFor(() => expect(screen.queryByText("新しい方")).not.toBeNull());

  // ここで遅い方を解決させる。**画面は新しい方のままでなければならない。**
  const release = deferred.shift();
  if (release === undefined) {
    throw new Error("保留した応答が無い");
  }
  release([{ _id: "rec-8", name: "古い方" }]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByText("古い方")).toBeNull();
  expect(screen.queryByText("新しい方")).not.toBeNull();
});

// ---------------------------------------------------------------------------
// (e)(f) `K-G14` / `K-G15` 上限と、上限に当たったことの表示
// ---------------------------------------------------------------------------

test("(e) 一度に取る候補に上限が効く", async () => {
  renderReference(referenceField("type_filter", ["name"]), { manifest: manifestWith() });
  await waitFor(() => expect(candidateCalls().length).toBe(1));
  expect(lastCandidateQuery().get("limit")).toBe(String(REFERENCE_CANDIDATE_LIMIT));
  expect(REFERENCE_CANDIDATE_LIMIT).toBe(50);
});

test("(f) 上限に当たったら、件数つきで画面にそう出る(黙って切らない)", async () => {
  total = 137;
  renderReference(referenceField("type_filter", ["name"]), { manifest: manifestWith() });
  await waitFor(() => expect(screen.queryByTestId("reference-limit-customer_id")).not.toBeNull());
  const note = screen.getByTestId("reference-limit-customer_id");
  expect(note.textContent).toContain("137");
  expect(note.textContent).toContain("3");
});

test("(f) 上限に当たっていなければ、その案内は1つも出ない", async () => {
  renderReference(referenceField("type_filter", ["name"]), { manifest: manifestWith() });
  await waitFor(() => expect(candidateCalls().length).toBe(1));
  await waitFor(() => expect(screen.queryByTestId("field-input-customer_id")).not.toBeNull());
  expect(screen.queryByTestId("reference-limit-customer_id")).toBeNull();
});

// ---------------------------------------------------------------------------
// (g) list(既定)の画面が今日と1ピクセルも変わらない
// ---------------------------------------------------------------------------

test("(g) list(既定)の項目は取得を1件も飛ばさず、DOM も書かなかった項目と完全一致する", async () => {
  const baseline = renderReference(referenceField(), { manifest: manifestWith(), value: "rec-1" });
  cleanup();
  const written = renderReference(referenceField("list"), {
    manifest: manifestWith(),
    value: "rec-1",
  });
  cleanup();
  expect(written).toBe(baseline);
  expect(baseline).toContain("<select");
  // **`list` の描画は候補を1件も取りに行かない**(取得は `useReferenceChoices` の担当)。
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(candidateCalls().length).toBe(0);
});
