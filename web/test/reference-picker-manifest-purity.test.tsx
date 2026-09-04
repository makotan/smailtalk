/**
 * **打った文字がマニフェストに1バイトも入らない**(`K-G12`。`V6-M4-T06`)。
 *
 * **審査結果の正は `docs/plan/v6/records/v6-m0.md` §7-5 の `K-G12` の項**、
 * **完了条件の正は同 §6 の `V6-M4-T06` の行**である。
 *
 * ## この単位の性格 —— **不可侵条件である**
 *
 * **`v6-m0.md` の逐語**:
 *
 * > **`K-G12`(検索語をマニフェストに入れない)は不可侵条件であり、破ると
 * > `ADR-0064` 限定4 / `ADR-0112` 限定8 / `ADR-0042` §3a-2 を同時に引き直すことになる。**
 *
 * **`01` §5-1 は「破ったら門A へ差し戻す」と書いている。**
 * **この1本の検査が3本の条文の当て先になっている**(`v6-m0.md` §7-5 の `S3` (2))。
 *
 * **破ったときに静かに壊れる**(同 (1))—— **マニフェストに検索語が入っても画面は
 * 動くので、検査が無ければ誰も気づかない。**
 *
 * ## このファイルが固定すること
 *
 * | # | 条件 | 検査 |
 * |---|---|---|
 * | (a) | 打っても**書込のリクエストが1件も飛ばない** | GET 以外のメソッドが0件 |
 * | (b) | 打っても**マニフェストの口を1度も叩かない** | `/manifest` への往復が0件 |
 * | (c) | 打った語は**読取のクエリにしか現れない** | 語を含むリクエストが全部 GET のレコード読取である |
 * | (d) | 手元のマニフェストが**1バイトも書き換わらない** | 打つ前後で `JSON.stringify` が完全一致 |
 * | (e) | ソースに**語を書き込む経路が1本も無い** | `web/src/fields/input.tsx` に書込 API の名前が1つも無い |
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * 1. **本物のサーバを1度も起動していない。** **`fetch` を差し替えた表示層の検査である。**
 * 2. **マニフェストの保存先(`manifest.json`)を1度も読んでいない** —— **測っているのは
 *    「表示層が書きに行かないこと」だけである。**
 * 3. **`search`(別の面を開いて探す)の器を1つも測っていない**(当たり先は `V6-M5`)。
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Field, Manifest, Table } from "../../src/kernel/types.ts";
import { FieldInput, type FieldInputValue, type ReferenceChoices } from "../src/fields/input.tsx";

const APP_ID = "picker-app";
const TARGET_TABLE = "targets";
/** **打つ語。** この文字列がどこに現れるかを全部数える。 */
const TERM = "やまだ";

const INPUT_PATH = join(dirname(import.meta.dir), "src", "fields", "input.tsx");

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

function referenceField(): Field {
  return {
    id: "customer_id",
    name: "取引先",
    type: "reference",
    reference_table: TARGET_TABLE,
    reference_picker: "type_filter",
  } as Field;
}

function readyChoices(): ReferenceChoices {
  return new Map([[TARGET_TABLE, { status: "ready" as const, value: [] }]]);
}

type Call = { url: string; method: string; body: string };

let originalFetch: typeof fetch;
let calls: Call[] = [];

beforeEach(() => {
  calls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response(JSON.stringify({ records: [], total: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

async function renderAndType(manifest: Manifest): Promise<void> {
  const onChange = mock((_value: FieldInputValue) => {});
  render(
    <FieldInput
      field={referenceField()}
      inputId="input-under-test"
      value=""
      onChange={onChange}
      appId={APP_ID}
      referenceChoices={readyChoices()}
      manifest={manifest}
    />,
  );
  await waitFor(() => expect(screen.queryByTestId("reference-search-customer_id")).not.toBeNull());
  fireEvent.change(screen.getByTestId("reference-search-customer_id"), {
    target: { value: TERM },
  });
  // 間隔をあけた取り直しが実際に飛ぶまで待つ。
  await waitFor(() =>
    expect(calls.some((call) => decodeURIComponent(call.url).includes(TERM))).toBe(true),
  );
}

// ---------------------------------------------------------------------------
// (a)(b)(c) 語はリクエストのクエリにしか現れない
// ---------------------------------------------------------------------------

test("(a) 語を打っても書込のリクエストが1件も飛ばない", async () => {
  await renderAndType(manifestWith());
  expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
  // 本文を持つリクエストも1件も無い。
  expect(calls.filter((call) => call.body !== "")).toEqual([]);
});

test("(b) 語を打ってもマニフェストの口を1度も叩かない", async () => {
  await renderAndType(manifestWith());
  expect(calls.filter((call) => call.url.includes("/manifest"))).toEqual([]);
  expect(calls.filter((call) => call.url.includes("/diffs"))).toEqual([]);
});

test("(c) 語を含むリクエストは、全部レコードの読取(GET)である", async () => {
  await renderAndType(manifestWith());
  const withTerm = calls.filter((call) => decodeURIComponent(call.url).includes(TERM));
  expect(withTerm.length).toBeGreaterThan(0);
  for (const call of withTerm) {
    expect(call.method).toBe("GET");
    expect(call.url).toContain(`/tables/${TARGET_TABLE}/records`);
    // **語はクエリ文字列の中にしか無い**(パスに埋まっていない)。
    expect(new URL(call.url, "http://localhost").pathname).not.toContain(encodeURIComponent(TERM));
  }
});

// ---------------------------------------------------------------------------
// (d) 手元のマニフェストが1バイトも書き換わらない
// ---------------------------------------------------------------------------

test("(d) 打つ前後でマニフェストが1バイトも変わらない", async () => {
  const manifest = manifestWith();
  const before = JSON.stringify(manifest);
  await renderAndType(manifest);
  expect(JSON.stringify(manifest)).toBe(before);
  // **語そのものがマニフェストのどこにも現れない。**
  expect(JSON.stringify(manifest)).not.toContain(TERM);
});

// ---------------------------------------------------------------------------
// (e) ソースに語を書き込む経路が1本も無い
// ---------------------------------------------------------------------------

test("(e) 参照項目の入力欄は書込のAPI を1つも呼んでいない", () => {
  const source = readFileSync(INPUT_PATH, "utf8");
  // **`web/src/api.ts` が持つ書込の口**(名前は実在するものだけを挙げる)。
  // **`uploadFile` は image / file 型のアップロードであり、`V0` / `V5` から在る** ——
  // **マニフェストへの書込ではないので、ここには挙げない。**
  for (const name of [
    "createRecord",
    "updateRecord",
    "deleteRecord",
    "writeRecordsBatch",
    "applyDiff",
    "postDiff",
  ]) {
    expect(source.includes(name), name).toBe(false);
  }
});
