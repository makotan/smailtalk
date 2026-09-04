/**
 * **既に選ばれている値が、上限の外に在っても画面を開いた瞬間に消えない**
 * (`K-G17`。`V6-M4-T04`)。
 *
 * **審査結果の正は `docs/plan/v6/records/v6-m0.md` §7-8**(単位G)、**完了条件の正は
 * 同 §6 の `V6-M4-T04` の行**である。**単位G は門外(`Δ7`)であり、個別 ADR を持たない**
 * (同 §7-8 の `S6`)。**`CP-V6` の完了条件8 が「本単位専用の検査」を要求している** ——
 * **このファイルがその1本である。**
 *
 * ## なぜ専用の検査が要るのか(`01` §5-2 の 2 の逐語)
 *
 * > **これは新機能の副作用ではなく、既存機能の破壊である。**
 *
 * **今日まで参照候補は全件を出していたので、この壊れ方は起こらなかった。**
 * **`V6-M4-T03` が上限(50件)を入れた瞬間に起こるようになる** —— **51件目以降に在る
 * 相手を選んで保存済みのレコードを開くと、候補の中にその値が無い。**
 * **壊れ方が静かである**(`v6-m0.md` §7-8 の `S3` (2))—— **エラーも警告も出ない。**
 *
 * ## このファイルが固定すること
 *
 * | # | 条件 | 検査 |
 * |---|---|---|
 * | (a) | 選択済みの値が候補の**外**に在っても、`<select>` の値として残る | 候補に含まれない `_id` を渡し、`option` が在ることと `select.value` が一致することを測る |
 * | (b) | その値のラベルは**候補とは別に1件だけ読み直して**引く | 1件読取のリクエストが実際に飛ぶ(読取が1回増えることを隠さない) |
 * | (c) | 1件読取が**失敗した相手**にも値は消えない | 404 を返させ、`missingReferenceLabel` が出ることと、値が残ることを測る |
 * | (d) | 候補の**中**に在る値は option を二重に出さない | 同じ `_id` の option が1つだけであることを測る |
 * | (e) | **利用者が触っていないのに `onChange` が呼ばれない** | 描画しただけで `onChange` が0回であることを測る |
 * | (f) | **`list`(既定)には今日どおり1件読取が飛ばない** | 既定の描画で1件読取が0件であることを測る |
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * 1. **本物の SQLite で1件も測っていない。** `fetch` を差し替えた表示層の検査である。
 * 2. **`st_owner` / `audience` で見えない相手に何が出るかを、本物の遮断で測っていない**
 *    —— **(c) は「1件読取が失敗したとき」を模したものであって、遮断そのものではない。**
 *    **`v6-m0.md` §7-8 の `S3` (4) が申告した「見えない相手には今日も
 *    `missingReferenceLabel` が出る」は、本タスクが解いていない。**
 * 3. **保存(書込)を1件も測っていない** —— **測っているのは「開いた瞬間に消えないこと」だけである。**
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { Field, Manifest, Table } from "../../src/kernel/types.ts";
import { FieldInput, type FieldInputValue, type ReferenceChoices } from "../src/fields/input.tsx";
import { missingReferenceLabel } from "../src/fields/reference-label.ts";

const APP_ID = "picker-app";
const TARGET_TABLE = "targets";
/** **候補の外に在る値**(上限で切り落とされた側を模す)。 */
const OUTSIDE_ID = "rec-999";

function targetTable(): Table {
  return {
    id: TARGET_TABLE,
    name: "取引先",
    fields: [{ id: "name", name: "名称", type: "text" }],
  };
}

function manifestWith(): Manifest {
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
        targetTable(),
      ],
      views: [],
    },
  } as unknown as Manifest;
}

function referenceField(picker?: "list" | "type_filter" | "search"): Field {
  return {
    id: "customer_id",
    name: "取引先",
    type: "reference",
    reference_table: TARGET_TABLE,
    ...(picker === undefined ? {} : { reference_picker: picker }),
  } as Field;
}

function readyChoices(): ReferenceChoices {
  return new Map([[TARGET_TABLE, { status: "ready" as const, value: [] }]]);
}

/** 上限で切り落とされた候補(50件のうち先頭2件だけを模す)。 */
const CANDIDATE_ROWS = [
  { _id: "rec-1", name: "山田商会" },
  { _id: "rec-2", name: "山本工業" },
];

type Call = { url: string; method: string };

let originalFetch: typeof fetch;
let calls: Call[] = [];
/** 1件読取(`/records/<id>`)を 404 で返すか。 */
let singleReadFails = false;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 1件読取のリクエストだけを数える(URL の末尾がレコードID)。 */
function singleReadCalls(): Call[] {
  return calls.filter((call) =>
    call.url.includes(`/tables/${TARGET_TABLE}/records/${encodeURIComponent(OUTSIDE_ID)}`),
  );
}

beforeEach(() => {
  calls = [];
  singleReadFails = false;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
    if (url.includes(`/tables/${TARGET_TABLE}/records/`)) {
      if (singleReadFails) {
        return jsonResponse({ errors: [{ path: "", message: "見つかりません" }] }, 404);
      }
      return jsonResponse({ record: { _id: OUTSIDE_ID, name: "遠くの取引先" } });
    }
    // 候補の取得。**上限に当たった状態**(`total` が返した件数より多い)を模す。
    return jsonResponse({ records: CANDIDATE_ROWS, total: 137 });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function renderReference(
  field: Field,
  value: FieldInputValue,
): { onChange: ReturnType<typeof mock> } {
  const onChange = mock((_value: FieldInputValue) => {});
  render(
    <FieldInput
      field={field}
      inputId="input-under-test"
      value={value}
      onChange={onChange}
      appId={APP_ID}
      referenceChoices={readyChoices()}
      manifest={manifestWith()}
    />,
  );
  return { onChange };
}

function select(): HTMLSelectElement {
  return screen.getByTestId("field-input-customer_id") as HTMLSelectElement;
}

// ---------------------------------------------------------------------------
// (a) 候補の外に在る値が消えない
// ---------------------------------------------------------------------------

test("(a) 上限の外に在る選択済みの値が、画面を開いた瞬間に消えない", async () => {
  renderReference(referenceField("type_filter"), OUTSIDE_ID);
  // 候補が返ってきたあとも、選択済みの値の option が在り続ける。
  await waitFor(() => expect(screen.queryByText("山田商会")).not.toBeNull());
  const options = [...select().querySelectorAll("option")].map((option) => option.value);
  expect(options).toContain(OUTSIDE_ID);
  expect(select().value).toBe(OUTSIDE_ID);
});

test("(a) 上限に当たっていることも同時に出ている(黙って切らない)", async () => {
  renderReference(referenceField("type_filter"), OUTSIDE_ID);
  await waitFor(() => expect(screen.queryByTestId("reference-limit-customer_id")).not.toBeNull());
});

// ---------------------------------------------------------------------------
// (b) ラベルは候補とは別に1件だけ読み直す(読取が1回増えることを隠さない)
// ---------------------------------------------------------------------------

test("(b) 選択済みの値のラベルを引くために、1件だけ読み直す", async () => {
  renderReference(referenceField("type_filter"), OUTSIDE_ID);
  await waitFor(() => expect(screen.queryByText("遠くの取引先")).not.toBeNull());
  // **読取が1回増える**(`v6-m0.md` §7-8 の `S3` (3))。**隠さない。**
  expect(singleReadCalls().length).toBe(1);
  expect(singleReadCalls()[0]?.method).toBe("GET");
});

// ---------------------------------------------------------------------------
// (c) 1件読取が失敗しても値は消えない
// ---------------------------------------------------------------------------

test("(c) 1件読取が失敗した相手にも、値そのものは消えない", async () => {
  singleReadFails = true;
  renderReference(referenceField("type_filter"), OUTSIDE_ID);
  await waitFor(() => expect(screen.queryByText(missingReferenceLabel(OUTSIDE_ID))).not.toBeNull());
  expect(select().value).toBe(OUTSIDE_ID);
});

// ---------------------------------------------------------------------------
// (d) 候補の中に在る値は二重に出さない
// ---------------------------------------------------------------------------

test("(d) 候補の中に在る値の option は1つだけである", async () => {
  renderReference(referenceField("type_filter"), "rec-1");
  await waitFor(() => expect(screen.queryByText("山田商会")).not.toBeNull());
  const same = [...select().querySelectorAll("option")].filter(
    (option) => option.value === "rec-1",
  );
  expect(same.length).toBe(1);
});

// ---------------------------------------------------------------------------
// (e) 触っていないのに値が書き換わらない
// ---------------------------------------------------------------------------

test("(e) 描画しただけでは onChange が1度も呼ばれない", async () => {
  const { onChange } = renderReference(referenceField("type_filter"), OUTSIDE_ID);
  await waitFor(() => expect(screen.queryByText("山田商会")).not.toBeNull());
  expect(onChange).toHaveBeenCalledTimes(0);
});

// ---------------------------------------------------------------------------
// (f) list(既定)は今日どおり
// ---------------------------------------------------------------------------

test("(f) list(既定)は1件読取を1件も飛ばさない(今日と同じ)", async () => {
  renderReference(referenceField(), OUTSIDE_ID);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(calls.length).toBe(0);
});
