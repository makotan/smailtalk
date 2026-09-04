/**
 * 参照項目を**別の面を開いて探す**(`search`)の器 —— 表示層
 * (`K-G19` / `K-G20` / `K-G16`。`V6-M5-T01` 〜 `V6-M5-T04`)。
 *
 * **審査結果の正は `docs/plan/v6/records/v6-m0.md` §7-7(単位F = `K-G16`)と
 * §7-10(単位I = `K-G19` / `K-G20`)**、**完了条件の正は同 §6 の
 * `V6-M5-T01` 〜 `V6-M5-T04` の行**である。
 * **3単位とも門外(`Δ7`)であり、個別 ADR を持たない**(同 §7-7 / §7-10 の `S6` の逐語
 * 「**個別 ADR は書かない。**」)。
 *
 * ## このファイルが固定すること
 *
 * | # | 条件 | 検査 |
 * |---|---|---|
 * | (a) | **`K-G19`** 検索ボタンで**既存の**「重ねて出す小窓」が開く | `[data-slot="overlay-dialog"]` が出る |
 * | (b) | **`K-G19`** **4つ目の器を作っていない** | `OVERLAY_CONTAINERS` が3つのまま / 入力欄が使う器の名前は `OverlayDialog` 1つだけ |
 * | (c) | **完了条件 (v)** 器が**テーマのスコープの中**に出る | `.app-theme` の子孫に差さる(`ViewHost` と同じ作法) |
 * | (d) | **完了条件 (ii)** 選ぶと閉じて値が入り、**閉じただけでは値が変わらない** | `onChange` の呼ばれ方を数える |
 * | (e) | **`K-G20`** キーボードだけで開く・探す・選ぶ・閉じる | 開く口が `<button>` である / 焦点が中へ移る / `Escape` で閉じて元へ戻る / 中の口が全部キーボードで届く |
 * | (f) | **`K-G16`** 続きをページ送りで見られる | `offset` / `limit` / `total` だけで動き、**ページ位置がマニフェストに1バイトも入らない** |
 * | (g) | **`V6-M5-T04`** `modal` を1バイトも引き直していない / **`preset_*` が効かないことを明記している** | 字面の走査 |
 *
 * ## このファイルが証明しないこと(**先に書く。誇張しない**)
 *
 * 1. **ここは happy-dom であって、`Tab` キーの巡回を1度も実行していない。**
 *    **キーボードだけで通しで操作できることの実測は `web/e2e/reference-search-popup.e2e.ts`
 *    (chromium)にしか根拠が無い。** 本ファイルが測るのは「口が `<button>` / `<input>` で
 *    あり、`tabindex="-1"` で外されていないこと」と「焦点が器の中に入り、閉じたら戻ること」までである。
 * 2. **読み上げソフトを1度も動かしていない**(`ADR-0094` §Decision 3 の 5 の禁止をそのまま引き継ぐ)。
 * 3. **CSS を1バイトも計算していない。** **「重なって見える」ことを1件も測っていない。**
 * 4. **本物の SQLite で1件も測っていない。** `fetch` を差し替えた表示層の検査である。
 * 5. **`st_owner` / `audience` の遮断を1件も測っていない**(`K-G18` は
 *    `web/test/reference-picker-visibility.test.ts` の担当であり、`search` も
 *    `type_filter` と同じ1本の読取経路を通る)。
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Field, Manifest, Table } from "../../src/kernel/types.ts";
import {
  FieldInput,
  type FieldInputValue,
  REFERENCE_CANDIDATE_LIMIT,
  type ReferenceChoices,
} from "../src/fields/input.tsx";
import { OVERLAY_CONTAINERS } from "../src/ui/overlay.tsx";

const APP_ID = "picker-app";
const TARGET_TABLE = "targets";
const WEB_SRC = join(dirname(import.meta.dir), "src");
const INPUT_PATH = join(WEB_SRC, "fields", "input.tsx");

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

function referenceField(searchFields?: string[]): Field {
  const field = {
    id: "customer_id",
    name: "取引先",
    type: "reference",
    reference_table: TARGET_TABLE,
    reference_picker: "search",
  } as Extract<Field, { type: "reference" }>;
  return (
    searchFields === undefined ? field : { ...field, reference_search_fields: searchFields }
  ) as Field;
}

function readyChoices(): ReferenceChoices {
  return new Map([
    [TARGET_TABLE, { status: "ready" as const, value: [{ id: "rec-1", label: "代表値1" }] }],
  ]);
}

// ---------------------------------------------------------------------------
// fetch の差し替え(`reference-type-filter.test.tsx` と同じ作法)
// ---------------------------------------------------------------------------

type Call = { url: string; method: string; body: string };

let originalFetch: typeof fetch;
let calls: Call[] = [];
/** 応答に載せる行。 */
let rows: { _id: string; name: string; kana: string }[] = [];
/** 応答の `total`。`undefined` なら `rows.length`。 */
let total: number | undefined;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  calls = [];
  total = undefined;
  rows = [
    { _id: "rec-1", name: "山田商会", kana: "やまだ" },
    { _id: "rec-2", name: "山本工業", kana: "やまもと" },
    { _id: "rec-3", name: "田中製作所", kana: "たなか" },
  ];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      body: typeof init?.body === "string" ? init.body : "",
    });
    // 1件読取(選択済みの値のラベル)は行を1件だけ返す。
    if (/\/records\/[^?]+$/.test(new URL(url, "http://localhost").pathname)) {
      return jsonResponse({ record: rows[0] });
    }
    return jsonResponse({ records: rows, total: total ?? rows.length });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

type RenderResult = { onChange: ReturnType<typeof mock>; html: string };

function renderReference(
  field: Field,
  options: { value?: FieldInputValue; manifest?: Manifest; themed?: boolean } = {},
): RenderResult {
  const onChange = mock((_value: FieldInputValue) => {});
  const node = (
    <FieldInput
      field={field}
      inputId="input-under-test"
      value={options.value ?? ""}
      onChange={onChange}
      appId={APP_ID}
      referenceChoices={readyChoices()}
      {...(options.manifest === undefined ? {} : { manifest: options.manifest })}
    />
  );
  const { container } = render(
    options.themed === true ? <div className="app-theme">{node}</div> : node,
  );
  return { onChange, html: container.innerHTML };
}

/** 器が描かれる/畳まれるのを待つ(Base UI はポータルへ非同期に差す)。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

function popup(): Element | null {
  return document.querySelector('[data-slot="overlay-dialog"]');
}

function trigger(): HTMLButtonElement {
  return screen.getByTestId("field-input-customer_id") as HTMLButtonElement;
}

async function openPopup(): Promise<void> {
  fireEvent.click(trigger());
  await waitFor(() => expect(popup()).not.toBeNull());
}

function candidateCalls(): Call[] {
  return calls.filter((call) =>
    new URL(call.url, "http://localhost").pathname.endsWith(`/tables/${TARGET_TABLE}/records`),
  );
}

function lastCandidateQuery(): URLSearchParams {
  const last = candidateCalls().at(-1);
  if (last === undefined) {
    throw new Error("参照候補の取得が1件も無い");
  }
  return new URL(last.url, "http://localhost").searchParams;
}

// ---------------------------------------------------------------------------
// (a)(b) `K-G19` 既存の器が開く / 4つ目を作っていない
// ---------------------------------------------------------------------------

test("(a) search を書いた項目には検索ボタンが出て、プルダウンが1つも無い", () => {
  const { html } = renderReference(referenceField(), { manifest: manifestWith() });
  expect(html).not.toContain("<select");
  expect(trigger().tagName).toBe("BUTTON");
});

test("(a) 開くまでは器が1つも出ていない", () => {
  renderReference(referenceField(), { manifest: manifestWith() });
  expect(popup()).toBeNull();
});

test("(a) 検索ボタンを押すと、既存の『重ねて出す小窓』が開く", async () => {
  renderReference(referenceField(), { manifest: manifestWith() });
  await openPopup();
  expect(popup()?.getAttribute("role")).toBe("dialog");
  expect(popup()?.getAttribute("aria-modal")).toBe("true");
});

test("(b) 器は今日も3つで、4つ目が無い", () => {
  expect([...OVERLAY_CONTAINERS]).toEqual(["OverlayDialog", "OverlayMenu", "OverlayNotice"]);
});

test("(b) 参照項目の入力欄が使う器は OverlayDialog の1つだけである", () => {
  const source = readFileSync(INPUT_PATH, "utf8");
  const match = source.match(/import \{([^}]*)\} from "\.\.\/ui\/overlay\.tsx";/);
  expect(match).not.toBeNull();
  const imported = (match?.[1] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  expect(imported).toEqual(["OverlayDialog"]);
  // **器そのものを新しく定義していない**(`OVERLAY_CONTAINERS` の凍結を破らない)。
  expect(source).not.toContain("Dialog.Root");
  expect(source).not.toContain("@base-ui-components");
});

// ---------------------------------------------------------------------------
// (c) 完了条件 (v) テーマのスコープの中に出る
// ---------------------------------------------------------------------------

test("(c) 器はアプリ単位テーマのスコープ(.app-theme)の中に差さる", async () => {
  renderReference(referenceField(), { manifest: manifestWith(), themed: true });
  await openPopup();
  const scope = document.querySelector(".app-theme");
  expect(scope).not.toBeNull();
  expect(scope?.contains(popup())).toBe(true);
});

test("(c) 祖先に .app-theme が無ければ document.body へ倒れる(黙って器を出さない側に倒さない)", async () => {
  renderReference(referenceField(), { manifest: manifestWith() });
  await openPopup();
  expect(popup()).not.toBeNull();
});

// ---------------------------------------------------------------------------
// (d) 完了条件 (ii) 選ぶと閉じて値が入り、閉じただけでは値が変わらない
// ---------------------------------------------------------------------------

test("(d) 候補を選ぶと値が入り、器が閉じる", async () => {
  const { onChange } = renderReference(referenceField(["name"]), { manifest: manifestWith() });
  await openPopup();
  await waitFor(() => expect(screen.queryByTestId("reference-popup-choose-rec-2")).not.toBeNull());
  fireEvent.click(screen.getByTestId("reference-popup-choose-rec-2"));
  await settle();
  expect(onChange.mock.calls).toEqual([["rec-2"]]);
  expect(popup()).toBeNull();
});

test("(d) Escape で閉じただけでは値が1バイトも変わらない", async () => {
  const { onChange } = renderReference(referenceField(["name"]), { manifest: manifestWith() });
  await openPopup();
  await waitFor(() => expect(screen.queryByTestId("reference-popup-choose-rec-2")).not.toBeNull());
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await settle();
  expect(popup()).toBeNull();
  expect(onChange.mock.calls).toEqual([]);
});

test("(d) 選んだ値は、閉じたあとの検索ボタンに出る(選択済みが消えない)", async () => {
  renderReference(referenceField(["name"]), { manifest: manifestWith(), value: "rec-1" });
  await waitFor(() => expect(trigger().textContent).toContain("山田商会"));
  expect(trigger().getAttribute("data-value")).toBe("rec-1");
});

test("(d) 何も選んでいない検索ボタンは、値を1バイトも持たない", () => {
  renderReference(referenceField(["name"]), { manifest: manifestWith() });
  expect(trigger().getAttribute("data-value")).toBe("");
});

// ---------------------------------------------------------------------------
// (e) `K-G20` キーボードだけで開く・探す・選ぶ・閉じる
// ---------------------------------------------------------------------------

test("(e) 開く口はキーボードで押せる <button> である(tabindex で外されていない)", () => {
  renderReference(referenceField(["name"]), { manifest: manifestWith() });
  expect(trigger().tagName).toBe("BUTTON");
  expect(trigger().getAttribute("type")).toBe("button");
  expect(trigger().hasAttribute("disabled")).toBe(false);
  expect(trigger().getAttribute("tabindex")).toBeNull();
});

test("(e) 開くと焦点が器の中へ移り、外側は隠れる", async () => {
  renderReference(referenceField(["name"]), { manifest: manifestWith() });
  await openPopup();
  expect(popup()?.contains(document.activeElement)).toBe(true);
  expect(document.querySelectorAll("[data-base-ui-focus-guard]").length).toBeGreaterThan(0);
  expect(document.querySelector('[data-base-ui-inert][aria-hidden="true"]')).not.toBeNull();
});

test("(e) Escape で閉じ、焦点が開いた元の検索ボタンへ戻る", async () => {
  renderReference(referenceField(["name"]), { manifest: manifestWith() });
  await openPopup();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await settle();
  expect(popup()).toBeNull();
  expect(document.activeElement).toBe(trigger());
});

test("(e) 器の中の口(探す・選ぶ・ページ送り・閉じる)は全部キーボードで届く", async () => {
  total = 137;
  renderReference(referenceField(["name"]), { manifest: manifestWith() });
  await openPopup();
  await waitFor(() => expect(screen.queryByTestId("reference-popup-choose-rec-1")).not.toBeNull());
  const focusable = [...(popup()?.querySelectorAll("button, input") ?? [])];
  expect(focusable.length).toBeGreaterThan(0);
  for (const element of focusable) {
    expect(element.getAttribute("tabindex"), element.outerHTML).not.toBe("-1");
  }
  // 探す口・選ぶ口・次へ の3つが実在する。
  expect(screen.queryByTestId("reference-popup-search-customer_id")).not.toBeNull();
  expect(screen.queryByTestId("reference-popup-next-customer_id")).not.toBeNull();
});

test("(e) 探せる項目が0本のときは器の中に探す口を出さず、そう出す", async () => {
  const table: Table = { id: TARGET_TABLE, name: "取引先", fields: [] };
  renderReference(referenceField(), { manifest: manifestWith(table) });
  await openPopup();
  expect(screen.queryByTestId("reference-popup-search-customer_id")).toBeNull();
  expect(screen.queryByTestId("reference-popup-search-unavailable-customer_id")).not.toBeNull();
});

// ---------------------------------------------------------------------------
// (f) `K-G16` ページ送り —— 既存の offset / limit / total だけで動く
// ---------------------------------------------------------------------------

test("(f) 器を開くまで候補の取得が1件も飛ばない", async () => {
  renderReference(referenceField(["name"]), { manifest: manifestWith() });
  await settle();
  expect(candidateCalls()).toEqual([]);
});

test("(f) 1ページ目は limit だけで取り、offset を載せない", async () => {
  renderReference(referenceField(["name"]), { manifest: manifestWith() });
  await openPopup();
  await waitFor(() => expect(candidateCalls().length).toBe(1));
  expect(lastCandidateQuery().get("limit")).toBe(String(REFERENCE_CANDIDATE_LIMIT));
  expect(lastCandidateQuery().get("offset")).toBeNull();
});

test("(f) 次へで offset が1ページぶん進み、前へで戻る", async () => {
  total = 137;
  renderReference(referenceField(["name"]), { manifest: manifestWith() });
  await openPopup();
  await waitFor(() => expect(candidateCalls().length).toBe(1));
  fireEvent.click(screen.getByTestId("reference-popup-next-customer_id"));
  await waitFor(() => expect(candidateCalls().length).toBe(2));
  expect(lastCandidateQuery().get("offset")).toBe(String(REFERENCE_CANDIDATE_LIMIT));
  fireEvent.click(screen.getByTestId("reference-popup-prev-customer_id"));
  await waitFor(() => expect(candidateCalls().length).toBe(3));
  expect(lastCandidateQuery().get("offset")).toBeNull();
});

test("(f) 1ページ目では前へが押せず、最後のページでは次へが押せない", async () => {
  total = 3;
  renderReference(referenceField(["name"]), { manifest: manifestWith() });
  await openPopup();
  await waitFor(() => expect(candidateCalls().length).toBe(1));
  const prev = screen.getByTestId("reference-popup-prev-customer_id") as HTMLButtonElement;
  const next = screen.getByTestId("reference-popup-next-customer_id") as HTMLButtonElement;
  expect(prev.disabled).toBe(true);
  expect(next.disabled).toBe(true);
});

test("(f) 何件のうち何件目を出しているかを、件数つきで画面に出す(黙って切らない)", async () => {
  total = 137;
  renderReference(referenceField(["name"]), { manifest: manifestWith() });
  await openPopup();
  await waitFor(() => expect(screen.queryByTestId("reference-limit-customer_id")).not.toBeNull());
  const note = screen.getByTestId("reference-limit-customer_id");
  expect(note.textContent).toContain("137");
  expect(note.textContent).toContain("1");
});

test("(f) 打ち直したらページ位置が1ページ目へ戻る", async () => {
  total = 137;
  renderReference(referenceField(["name"]), { manifest: manifestWith() });
  await openPopup();
  await waitFor(() => expect(candidateCalls().length).toBe(1));
  fireEvent.click(screen.getByTestId("reference-popup-next-customer_id"));
  await waitFor(() => expect(lastCandidateQuery().get("offset")).not.toBeNull());
  fireEvent.change(screen.getByTestId("reference-popup-search-customer_id"), {
    target: { value: "やま" },
  });
  await waitFor(() => expect(lastCandidateQuery().get("filter")).not.toBeNull());
  expect(lastCandidateQuery().get("offset")).toBeNull();
});

test("(f) ページ位置も打った語も、マニフェストに1バイトも入らない", async () => {
  total = 137;
  const manifest = manifestWith();
  const before = JSON.stringify(manifest);
  renderReference(referenceField(["name"]), { manifest });
  await openPopup();
  await waitFor(() => expect(candidateCalls().length).toBe(1));
  fireEvent.click(screen.getByTestId("reference-popup-next-customer_id"));
  await waitFor(() => expect(candidateCalls().length).toBe(2));
  fireEvent.change(screen.getByTestId("reference-popup-search-customer_id"), {
    target: { value: "やま" },
  });
  await waitFor(() => expect(lastCandidateQuery().get("filter")).not.toBeNull());
  // 書込のリクエストが1件も飛ばない / 本文を持つリクエストが1件も無い。
  expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
  expect(calls.filter((call) => call.body !== "")).toEqual([]);
  expect(calls.filter((call) => call.url.includes("/manifest"))).toEqual([]);
  expect(calls.filter((call) => call.url.includes("/diffs"))).toEqual([]);
  expect(JSON.stringify(manifest)).toBe(before);
  expect(JSON.stringify(manifest)).not.toContain("offset");
});

// ---------------------------------------------------------------------------
// (g) 一覧の列は宣言から導く / actions を1つも出さない
// ---------------------------------------------------------------------------

test("(g) 器の中の一覧の列は、探せる項目の宣言から導く", async () => {
  renderReference(referenceField(["name", "kana"]), { manifest: manifestWith() });
  await openPopup();
  await waitFor(() => expect(screen.queryByTestId("reference-popup-choose-rec-1")).not.toBeNull());
  const headers = [...(popup()?.querySelectorAll("th") ?? [])].map((th) => th.textContent);
  expect(headers).toContain("名称");
  expect(headers).toContain("よみ");
  expect(popup()?.textContent).toContain("やまだ");
});

test("(g) 器の中の一覧に操作起点(actions)を1つも出していない", async () => {
  renderReference(referenceField(["name"]), { manifest: manifestWith() });
  await openPopup();
  await waitFor(() => expect(screen.queryByTestId("reference-popup-choose-rec-1")).not.toBeNull());
  expect(popup()?.querySelectorAll('[data-testid^="view-action-"]').length).toBe(0);
  const source = readFileSync(INPUT_PATH, "utf8");
  expect(source.includes("actions")).toBe(false);
  expect(source.includes("ListViewRenderer")).toBe(false);
});

test("(g) 器の中から新しい相手を作る導線を1本も出していない(`D-V6-19`)", async () => {
  renderReference(referenceField(["name"]), { manifest: manifestWith() });
  await openPopup();
  await waitFor(() => expect(screen.queryByTestId("reference-popup-choose-rec-1")).not.toBeNull());
  expect(popup()?.textContent).not.toContain("新しく作る");
  expect(popup()?.textContent).not.toContain("新規");
});

// ---------------------------------------------------------------------------
// (h) `V6-M5-T04` modal を引き直していない / preset_* が効かないことを明記している
// ---------------------------------------------------------------------------

test("(h) 参照項目の入力欄は modal(form 専用の宣言)を1バイトも読んでいない", () => {
  const source = readFileSync(INPUT_PATH, "utf8");
  const code = source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
    })
    .join("\n");
  expect(code.includes("modal")).toBe(false);
});

test("(h) preset_* は器の中の一覧に1つも効かない —— コードに0件・断りは実在する", () => {
  const source = readFileSync(INPUT_PATH, "utf8");
  const lines = source.split("\n").filter((line) => line.includes("preset_"));
  const code = lines.filter((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
  });
  // **コードの行に1件も無い**(= `preset_*` を読む分岐が1つも無い)。
  expect(code).toEqual([]);
  // **断りは実在する**(「書けるが効かない」を黙って作らない)。
  expect(lines.length).toBeGreaterThan(0);
});
