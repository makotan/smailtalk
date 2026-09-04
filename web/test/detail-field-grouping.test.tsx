/**
 * 詳細画面の項目のまとまり —— 表示層(`P-G17` の (C) 側。`V4-M16-T12` / `ADR-0092`)。
 *
 * **限定表の正は [`docs/adr/0092-detail-field-grouping.md`](../../docs/adr/0092-detail-field-grouping.md) §Decision 2**。
 * **門A の判定 = 限定採用**(審査記録 = `docs/plan/v4/records/v4-m14-gate-a-field-grouping.md`)。
 *
 * ## 器をタブにしなかった理由(限定6。**プラットフォームが1通りに決める**)
 *
 * **タブは支援技術の要件(役割属性・フォーカス管理・キーボード操作)を負うが、この製品に
 * 支援技術の検査は0本である**(`ADR-0092` §Context 4 の 7)。**`web/src/` に `role="tab"`
 * は 0件 / `tablist` も 0件**(`V4-M16-T12` 着手時に `grep -rn 'role="tab"' web/src/` /
 * `grep -rn tablist web/src/` で数えた実数)。**したがってタブを選ぶと、この差分で
 * 支援技術の要件を初めて負い、それを測る検査を1本も持たないまま出すことになる。**
 * **見出し付きの区切りには既存の先例がある** —— `RelatedList` の
 * `h3.related-heading` + `Separator`(`web/src/views/DetailViewRenderer.tsx`)。
 *
 * ## 当たり方の表(`ADR-0050` §4 と同じ形。**先に決めて固定する**)
 *
 * | 対象 | まとまりの器(`.detail-field-group`)に入るか | 根拠 |
 * |---|---|---|
 * | どのまとまりにも属さない項目 | **入らない**(今日どおり先頭の `dl.detail-fields` に平坦に並ぶ) | 限定4 / 限定8 |
 * | まとまりに属する項目 | **入る**(見出し + 区切り + そのまとまりの `dl.detail-fields`) | 限定6 |
 * | `related` の子一覧 | **入らない**(器の外。`section.detail-view` の直下のまま) | 限定8 |
 * | 操作起点(`actions`)/ 編集・削除 | **入らない**(器の外) | 限定8 |
 * | 軸4(`preset_label_placement`)/ 軸5(`preset_field_columns`) | **まとまりの `dl.detail-fields` にも同じ属性が出る** —— 当たり方は今日と同じ(`.detail-fields` 経由) | `ADR-0050` §4 |
 * | 軸6(`preset_image_size`)/ 軸7(`preset_text_preview`) | **器を経由しない**(軸6 は `.detail-view`、軸7 は表示関数の引数)ので、まとまりの有無で当たり方が1ミリも変わらない | `ADR-0050` §4 |
 *
 * ## 描画の順序(**この決め方を検査で固定する**)
 *
 * **(1) どのまとまりにも属さない項目を、今日どおりの順序で先に並べる。**
 * **(2) そのあとに、まとまりを「マニフェストの記述順」で並べる**(限定3 —— 並び順を
 * 指定するキーが無いので、`Object.keys` の順 = 書いた順が唯一の順序である)。
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * - **chromium で1度も確かめていない**(`web/e2e` に1本も足していない)。
 * - **支援技術で使えるかを1本も測っていない**(合格ラインを置かない = `D-V4-14`)。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { DetailView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";

const WRITER_ROLE: Role = "owner";

const ROOT = dirname(dirname(import.meta.dir));
const APP_ID = "sample-app";
const RECORD_ID = "entry-0001";
const ENTRIES_PATH = `/api/apps/${APP_ID}/tables/entries/records`;
const NOTES_PATH = `/api/apps/${APP_ID}/tables/notes/records`;

const ENTRY_ROW = {
  _id: RECORD_ID,
  _created_at: "2026-01-01T00:00:00Z",
  _updated_at: "2026-01-02T00:00:00Z",
  f_a: "あ",
  f_b: "い",
  f_c: "う",
  f_d: "え",
};

function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "サンプル",
      tables: [
        {
          id: "entries",
          name: "エントリ",
          fields: [
            { id: "f_a", name: "項目A", type: "text", required: true },
            { id: "f_b", name: "項目B", type: "text" },
            { id: "f_c", name: "項目C", type: "text" },
            { id: "f_d", name: "項目D", type: "text" },
          ],
        },
        {
          id: "notes",
          name: "メモ",
          fields: [
            { id: "body", name: "本文", type: "text", required: true },
            { id: "entry", name: "エントリ", type: "reference", reference_table: "entries" },
          ],
        },
      ],
      views: [{ id: "entry-detail", type: "detail_view", table: "entries" }],
    },
  };
}

function detailView(manifest: Manifest): DetailView {
  const view = manifest.app.views[0];
  if (view === undefined || view.type !== "detail_view") {
    throw new Error("fixture broken");
  }
  return view;
}

let originalFetch: typeof fetch;
let noteRows: Record<string, unknown>[] | undefined;

beforeEach(() => {
  noteRows = undefined;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (method === "GET" && url === `${ENTRIES_PATH}/${RECORD_ID}`) {
      return json({ record: ENTRY_ROW });
    }
    if (method === "GET" && url.startsWith(NOTES_PATH)) {
      return json({ records: noteRows ?? [] });
    }
    if (method === "GET" && url.startsWith(ENTRIES_PATH)) {
      return json({ records: [ENTRY_ROW] });
    }
    return json({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-detail/records/${RECORD_ID}`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

async function renderDetail(manifest: Manifest): Promise<HTMLElement> {
  render(
    <RoleProvider role={WRITER_ROLE}>
      <DetailViewRenderer
        appId={APP_ID}
        manifest={manifest}
        view={detailView(manifest)}
        recordId={RECORD_ID}
      />
    </RoleProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("detail-field-f_a")).toBeDefined());
  return screen.getByTestId("view-renderer-detail_view");
}

/** `dl.detail-fields` の中の項目ID(描画順)。 */
function fieldIdsOf(list: Element): string[] {
  return [...list.querySelectorAll("[data-field]")].map(
    (node) => node.getAttribute("data-field") ?? "",
  );
}

// ---------------------------------------------------------------------------
// (h) 限定8: 書かなかった画面は今日と1ピクセルも変わらない
// ---------------------------------------------------------------------------

/**
 * **`field_groups` を持たない `detail_view` の描画**(`V4-M16-T12` 着手時に、
 * **実装を1バイトも入れる前に**取った DOM そのもの)。**1文字でも変わったら赤になる。**
 */
const PLAIN_DETAIL_HTML = readFileSync(
  join(ROOT, "web", "test", "__fixtures__", "detail-view-plain.html"),
  "utf8",
).trim();

test("(h) 限定8: field_groups を持たない detail_view の DOM が着手前と完全一致する", async () => {
  const section = await renderDetail(baseManifest());
  expect(section.outerHTML).toBe(PLAIN_DETAIL_HTML);
});

test("(h) 限定8: field_groups を持たない画面には、まとまりの器が1つも出ない", async () => {
  const section = await renderDetail(baseManifest());
  expect(section.querySelectorAll(".detail-field-group")).toHaveLength(0);
  expect(section.querySelectorAll('[data-testid="detail-field-group"]')).toHaveLength(0);
  // 項目の器は今日どおり1つで、`data-testid` も今日どおり出る。
  expect(section.querySelectorAll('[data-testid="detail-fields"]')).toHaveLength(1);
  expect(fieldIdsOf(screen.getByTestId("detail-fields"))).toEqual(["f_a", "f_b", "f_c", "f_d"]);
});

test("(h) 限定8: related の子一覧はまとまりの器に入らない(当たり方の表の3行目)", async () => {
  noteRows = [{ _id: "note-1", _created_at: "", _updated_at: "", body: "めも", entry: RECORD_ID }];
  const manifest = baseManifest();
  detailView(manifest).related = [{ table: "notes", via: "entry", columns: ["body"] }];
  (detailView(manifest) as DetailView).field_groups = { 補足: ["f_c", "f_d"] };
  const section = await renderDetail(manifest);
  await waitFor(() => expect(screen.getByTestId("related-list")).toBeDefined());

  const related = screen.getByTestId("related-list");
  // **器の外**である —— `.detail-field-group` の子孫に1つも無い。
  expect(related.closest(".detail-field-group")).toBeNull();
  // **`section.detail-view` の直下のまま**(まとまりを足しても親が変わらない)。
  expect(related.parentElement).toBe(section);
});

// ---------------------------------------------------------------------------
// (k) 限定6: まとまりの見出しと項目が実際に描かれる
// ---------------------------------------------------------------------------

test("(k) まとまりの見出しと区切りと項目が、DOM に1件ずつ描かれる", async () => {
  const manifest = baseManifest();
  detailView(manifest).field_groups = { 連絡先: ["f_b"], 補足: ["f_c", "f_d"] };
  const section = await renderDetail(manifest);

  const groups = [...section.querySelectorAll('[data-testid="detail-field-group"]')];
  expect(groups).toHaveLength(2);
  // **見出しはまとまりの名前そのもの**(表示名であり `resource_id` ではない)。
  expect(groups.map((node) => node.querySelector("h3")?.textContent)).toEqual(["連絡先", "補足"]);
  // **区切りは既存の `Separator`**(`role="separator"` を持つ)—— タブではない。
  for (const group of groups) {
    expect(group.querySelector('[role="separator"]')).not.toBeNull();
  }
  // まとまりの中の項目(記述順)。
  expect(fieldIdsOf(groups[0] as Element)).toEqual(["f_b"]);
  expect(fieldIdsOf(groups[1] as Element)).toEqual(["f_c", "f_d"]);
  // **`data-testid` を1つも落としていない。**
  for (const id of ["f_a", "f_b", "f_c", "f_d"]) {
    expect(screen.getByTestId(`detail-field-${id}`)).toBeDefined();
  }
});

test("(k) 描画順序: まとまりに属さない項目が先で、そのあとに記述順のまとまりが並ぶ", async () => {
  const manifest = baseManifest();
  // **記述順は「補足 → 連絡先」**(名前の五十音順でもフィールド定義順でもない)。
  detailView(manifest).field_groups = { 補足: ["f_d"], 連絡先: ["f_b"] };
  const section = await renderDetail(manifest);

  const card = section.querySelector('[data-slot="card"]') as HTMLElement;
  const order = [...card.children].map((node) =>
    node.getAttribute("data-testid") === "detail-fields"
      ? "ungrouped"
      : `group:${node.querySelector("h3")?.textContent}`,
  );
  expect(order).toEqual(["ungrouped", "group:補足", "group:連絡先"]);
  // まとまりに属さない項目は**今日どおりの順序**(テーブル定義順の残り)。
  expect(fieldIdsOf(card.children[0] as Element)).toEqual(["f_a", "f_c"]);
  // 画面全体の項目の並びは「属さない項目 → 記述順のまとまり」。
  expect(fieldIdsOf(section)).toEqual(["f_a", "f_c", "f_d", "f_b"]);
});

test("(k) fields を書いた detail_view でも、まとまりに属さない項目は fields の順で先に並ぶ", async () => {
  const manifest = baseManifest();
  detailView(manifest).fields = ["f_d", "f_c", "f_b", "f_a"];
  detailView(manifest).field_groups = { 補足: ["f_c"] };
  const section = await renderDetail(manifest);
  const ungrouped = section.querySelector('[data-slot="card"]')?.children[0] as Element;
  expect(ungrouped.getAttribute("data-testid")).toBe("detail-fields");
  expect(fieldIdsOf(ungrouped)).toEqual(["f_d", "f_b", "f_a"]);
  expect(fieldIdsOf(section)).toEqual(["f_d", "f_b", "f_a", "f_c"]);
});

test("(k) 全項目がまとまりに属する画面では、属さない項目の器を DOM に置かない", async () => {
  // **当たり先の無い器を DOM に置かない**(既存の作法 —— `DetailViewRenderer` の
  // 「当たり先の無い注記を DOM に置かない」と同じ)。
  const manifest = baseManifest();
  detailView(manifest).field_groups = { 全部: ["f_a", "f_b", "f_c", "f_d"] };
  const section = await renderDetail(manifest);
  const lists = [...section.querySelectorAll('[data-testid="detail-fields"]')];
  // **`detail-fields` の `data-testid` は落ちていない** —— まとまりの器の中に在る。
  expect(lists).toHaveLength(1);
  expect((lists[0] as Element).closest(".detail-field-group")).not.toBeNull();
});

// ---------------------------------------------------------------------------
// 軸4 / 軸5 の当たり方(当たり方の表の5行目)
// ---------------------------------------------------------------------------

test("軸4 / 軸5 は、まとまりの器の中の dl.detail-fields にも今日と同じ形で当たる", async () => {
  const manifest = baseManifest();
  const view = detailView(manifest);
  view.preset_label_placement = "stacked";
  view.preset_field_columns = 2;
  view.field_groups = { 補足: ["f_c", "f_d"] };
  const section = await renderDetail(manifest);

  const lists = [...section.querySelectorAll(".detail-fields")];
  expect(lists).toHaveLength(2);
  for (const list of lists) {
    // **当たり先は今日と同じ `.detail-fields` である**(規則を1本も足していない)。
    expect(list.getAttribute("data-preset-label")).toBe("stacked");
    expect(list.getAttribute("data-preset-columns")).toBe("2");
  }
});

test("軸6 は今日どおり画面の器(.detail-view)に出る(まとまりの有無で当たり方が変わらない)", async () => {
  const manifest = baseManifest();
  detailView(manifest).preset_image_size = "medium";
  detailView(manifest).field_groups = { 補足: ["f_c"] };
  const section = await renderDetail(manifest);
  expect(section.getAttribute("data-preset-image")).toBe("medium");
  for (const list of section.querySelectorAll(".detail-fields")) {
    expect(list.getAttribute("data-preset-image")).toBeNull();
  }
});

// ---------------------------------------------------------------------------
// (g) 限定7: 座標系9プロパティを1つも書かない
// ---------------------------------------------------------------------------

test("(g) 限定7: まとまりの器の規則に座標系9プロパティが1つも無い", () => {
  const css = readFileSync(join(ROOT, "web", "src", "styles.css"), "utf8");
  const rules = css
    .split("}")
    .filter((chunk) => chunk.includes(".detail-field-group"))
    .join("\n");
  // **規則が実在すること**(空文字列に対して「1つも無い」で緑になる壊れ方を防ぐ)。
  expect(rules).toContain(".detail-field-group");
  for (const forbidden of [
    "position",
    "z-index",
    "top",
    "left",
    "right",
    "bottom",
    "inset",
    "float",
    "transform",
  ]) {
    expect(rules, forbidden).not.toContain(`${forbidden}:`);
  }
  // **モーダルもトーストも開くメニューも作らない** —— 重ねる手段の字面が1つも無い。
  for (const forbidden of ["dialog", "modal", "toast", "popover", "overlay"]) {
    expect(rules, forbidden).not.toContain(forbidden);
  }
});

test("(g) 限定7: まとまりの器の規則に色のリテラルが1バイトも無い(使うのはスロットの var() だけ)", () => {
  const css = readFileSync(join(ROOT, "web", "src", "styles.css"), "utf8");
  const rules = css
    .split("}")
    .filter((chunk) => chunk.includes(".detail-field-group"))
    .join("\n");
  expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(rules).not.toMatch(/\brgba?\(/);
  expect(rules).not.toMatch(/\bhsla?\(/);
});
