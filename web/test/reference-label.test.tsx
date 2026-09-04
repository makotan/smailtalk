/**
 * reference の「代表値」の決め方が list と form で一致していることのテスト。
 *
 * 以前は list_view(display.tsx)と form(input.tsx)が代表値の決め方を別々に
 * 実装しており、text フィールドを持たないテーブルを参照すると **同じレコードが
 * 一覧では「見つかりません」、フォームでは別の値** として見えていた。
 * 唯一の実装(`web/src/fields/reference-label.ts`)に統合したうえで、将来また
 * 分岐したらここが落ちるようにする。
 *
 * 仕様(3区分):
 *   1. 参照先レコードが見つからない          → `(見つかりません: <id>)`
 *   2. 見つかり、代表値があり、値が空でない  → その値
 *   3. 見つかったが代表値が無い / 値が空     → `_id` をそのまま出す
 *
 * フィクスチャの ID はこのファイル内にしか存在しない(CP-3 確認方法4)。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { FormView, ListView, Manifest, Table } from "../../src/kernel/types.ts";
import {
  buildReferenceLabelIndex,
  referenceLabel,
  representativeField,
} from "../src/fields/reference-label.ts";
import { FormRenderer } from "../src/views/FormRenderer.tsx";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";

const APP_ID = "sample-app";

/**
 * `named` は代表値になる text を持つテーブル、`plain` は text を **1つも持たない**
 * テーブル(これが食い違いを生んでいたケース)。
 */
function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "サンプル",
      tables: [
        {
          id: "named",
          name: "名前あり",
          fields: [
            { id: "code", name: "コード", type: "number" },
            { id: "title", name: "名前", type: "text" },
          ],
        },
        {
          id: "plain",
          name: "テキストなし",
          fields: [
            { id: "count", name: "件数", type: "number" },
            { id: "flag", name: "旗", type: "boolean" },
          ],
        },
        {
          id: "entries",
          name: "エントリ",
          fields: [
            {
              id: "to_named",
              name: "名前ありへの参照",
              type: "reference",
              reference_table: "named",
            },
            {
              id: "to_plain",
              name: "テキストなしへの参照",
              type: "reference",
              reference_table: "plain",
            },
          ],
        },
      ],
      views: [
        {
          id: "entry-list",
          type: "list_view",
          table: "entries",
          columns: ["to_named", "to_plain"],
        },
        { id: "entry-form", type: "form", table: "entries", fields: ["to_named", "to_plain"] },
      ],
    },
  };
}

/** 代表値あり / 代表値が空 の2件。 */
const NAMED_ROWS = [
  { _id: "named-1", _created_at: "", _updated_at: "", code: 7, title: "読める名前" },
  { _id: "named-empty", _created_at: "", _updated_at: "", code: 8, title: "" },
];

/** 代表値になる text フィールドがそもそも無いテーブルのレコード。 */
const PLAIN_ROWS = [{ _id: "plain-1", _created_at: "", _updated_at: "", count: 3, flag: true }];

const ENTRY_ROWS = [
  { _id: "e-1", _created_at: "", _updated_at: "", to_named: "named-1", to_plain: "plain-1" },
  { _id: "e-2", _created_at: "", _updated_at: "", to_named: "named-empty", to_plain: null },
  // 参照切れ(参照先レコードが存在しない)。
  { _id: "e-3", _created_at: "", _updated_at: "", to_named: "named-gone", to_plain: null },
];

let originalFetch: typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/tables/entries/records")) {
      return jsonResponse({ records: ENTRY_ROWS });
    }
    if (url.includes("/tables/named/records")) {
      return jsonResponse({ records: NAMED_ROWS });
    }
    if (url.includes("/tables/plain/records")) {
      return jsonResponse({ records: PLAIN_ROWS });
    }
    return jsonResponse({ errors: [{ path: "", message: `no stub for ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-list`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function listViewOf(source: Manifest): ListView {
  const view = source.app.views.find((candidate) => candidate.id === "entry-list");
  if (view === undefined || view.type !== "list_view") {
    throw new Error("fixture broken: list_view がない");
  }
  return view;
}

function formViewOf(source: Manifest): FormView {
  const view = source.app.views.find((candidate) => candidate.id === "entry-form");
  if (view === undefined || view.type !== "form") {
    throw new Error("fixture broken: form がない");
  }
  return view;
}

/** 一覧を描き、`fieldId` 列のセル本文を行順に返す。 */
async function listCellTexts(fieldId: string): Promise<string[]> {
  const source = manifest();
  const { container, unmount } = render(
    <ListViewRenderer appId={APP_ID} manifest={source} view={listViewOf(source)} />,
  );
  await waitFor(() => {
    expect(screen.getByTestId("list-table")).toBeDefined();
  });
  const texts = [...container.querySelectorAll(`td[data-field="${fieldId}"]`)].map(
    (cell) => cell.textContent ?? "",
  );
  unmount();
  return texts;
}

/** フォームを描き、`fieldId` のピッカーの (値 → ラベル) を返す(未選択の空 option は除く)。 */
async function pickerLabels(fieldId: string): Promise<Map<string, string>> {
  const source = manifest();
  const { unmount } = render(
    <FormRenderer appId={APP_ID} manifest={source} view={formViewOf(source)} />,
  );
  const select = await waitFor(() => {
    const node = screen.getByTestId(`field-input-${fieldId}`) as HTMLSelectElement;
    // 参照先の取得が終わって選択肢が入るまで待つ。
    expect(node.options.length).toBeGreaterThan(1);
    return node;
  });
  const labels = new Map<string, string>();
  for (const option of [...select.options]) {
    if (option.value !== "") {
      labels.set(option.value, option.textContent ?? "");
    }
  }
  unmount();
  return labels;
}

describe("list と form で代表値の決め方が一致する", () => {
  test("text を持つテーブルへの参照は、一覧のセルとピッカーのラベルが一致する", async () => {
    const cells = await listCellTexts("to_named");
    const labels = await pickerLabels("to_named");
    // 参照先が実在する行だけを比べる(参照切れはピッカーに現れないため)。
    expect(cells[0]).toBe(labels.get("named-1") as string);
    expect(cells[1]).toBe(labels.get("named-empty") as string);
  });

  test("text を1つも持たないテーブルへの参照でも、一覧とピッカーが一致する", async () => {
    const cells = await listCellTexts("to_plain");
    const labels = await pickerLabels("to_plain");
    expect(cells[0]).toBe(labels.get("plain-1") as string);
  });
});

describe("参照値1件の表示は3区分に分かれる", () => {
  test("1. 参照先が見つからなければ、見つからないことと ID を出す", async () => {
    const cells = await listCellTexts("to_named");
    expect(cells[2]).toContain("見つかりません");
    expect(cells[2]).toContain("named-gone");
  });

  test("2. 代表値があり値が空でなければ、その値を出す", async () => {
    const cells = await listCellTexts("to_named");
    expect(cells[0]).toBe("読める名前");
    const labels = await pickerLabels("to_named");
    expect(labels.get("named-1")).toBe("読める名前");
  });

  test("3. 代表値の値が空なら _id を出す(見つかっているので嘘をつかない)", async () => {
    const cells = await listCellTexts("to_named");
    expect(cells[1]).toBe("named-empty");
    expect(cells[1]).not.toContain("見つかりません");
    const labels = await pickerLabels("to_named");
    expect(labels.get("named-empty")).toBe("named-empty");
  });

  test("3. 代表値フィールドが無いテーブルでも _id を出す(他の型で代用しない)", async () => {
    const cells = await listCellTexts("to_plain");
    expect(cells[0]).toBe("plain-1");
    expect(cells[0]).not.toContain("見つかりません");
    // count の 3 や flag の true を「それらしい名前」として使わないこと。
    expect(cells[0]).not.toContain("3");
    const labels = await pickerLabels("to_plain");
    expect(labels.get("plain-1")).toBe("plain-1");
  });
});

describe("代表値フィールドの決定ルール", () => {
  const named = manifest().app.tables[0] as Table;
  const plain = manifest().app.tables[1] as Table;

  test("最初の text フィールドが代表値になる", () => {
    expect(representativeField(named)?.id).toBe("title");
  });

  test("text が無ければ代表値は決まらない(非 text で代用しない)", () => {
    expect(representativeField(plain)).toBeUndefined();
  });

  test("referenceLabel は代表値が使えなければ _id を返す", () => {
    expect(referenceLabel(named, NAMED_ROWS[0] as never)).toBe("読める名前");
    expect(referenceLabel(named, NAMED_ROWS[1] as never)).toBe("named-empty");
    expect(referenceLabel(plain, PLAIN_ROWS[0] as never)).toBe("plain-1");
  });

  test("索引は見つかったレコードを必ず含む(代表値が引けなくても _id で入る)", () => {
    const index = buildReferenceLabelIndex([
      { table: plain, records: PLAIN_ROWS as never },
      { table: named, records: NAMED_ROWS as never },
    ]);
    expect(index.get("plain")?.get("plain-1")).toBe("plain-1");
    expect(index.get("named")?.get("named-empty")).toBe("named-empty");
    expect(index.get("named")?.get("named-gone")).toBeUndefined();
  });
});
