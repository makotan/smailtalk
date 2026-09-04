/**
 * **画面の中で大事な情報が、文字の大きさや体裁で伝わる**(`V4-M19-T02`)。
 *
 * **門A の判定は「将来送り」であり、本ファイルはその送り先の履行を固定する。**
 * **`ADR` は無い**(台帳1行)—— **限定表の正になる文書が存在しないので、決めた形は
 * `web/src/views/DetailViewRenderer.tsx` の実装コメントと本ファイルの2箇所にしかない。**
 *
 * ## 固定する形(**足した語彙は0である**)
 *
 * **詳細画面の項目のうち、そのテーブルが宣言した代表項目(`table.representative_field`)
 * 1本の器(`<dd>`)にだけ、文字の太さと大きさのクラスを足す。** **材料は既に
 * マニフェストにある宣言だけである。** **`field_groups` の見出しと「書いた順」には
 * 新しい重みを1バイトも足していない**(足すと「何が大事か」の材料が3つに割れる)。
 *
 * ## この検査が言えないこと(**先に書く。誇張しない**)
 *
 * 1. **【禁止】「大事な情報を宣言できるようになった」と書かない** —— **足した語彙は0**
 *    (`src/` / `schemas/` は0行差分)。**`representative_field` は `ADR-0080` が
 *    別の目的(参照の表示ラベル)で入れた既存の宣言である。**
 * 2. **代表項目は1テーブルに1本だけで、2本目を「大事」と言えない。**
 * 3. **代表項目は参照の表示ラベル(`web/src/fields/reference-label.ts`)と共用なので
 *    意味が二重になる** —— **重みのために代表項目を変えると、そのテーブルを参照している
 *    リンクの見え方が全部変わる。**
 * 4. **画面ごとに変えられない**(宣言はテーブルに1つで、`detail_view` 側に置き場が無い)。
 * 5. **大きさか太さかをアプリが選べない**(表示層が1通りに決める)。
 * 6. **色を1バイトも扱っていない** —— **`ADR-0090` の `emphasis`(値の色)とは当たり先が
 *    違う**(`emphasis` は `<dd>` の中の `<span>`、ここは外側の器)。**(d) が固定する。**
 * 7. **ここは happy-dom であって CSS を1バイトも計算していない。** 見ているのは className の
 *    字面だけで、**「画面で重く見えるか」は1件も測っていない。**
 * 8. **chromium で1度も確かめていない**(`web/e2e` に1本も足していない)。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { DetailView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";

const ROOT = dirname(dirname(import.meta.dir));
const WRITER_ROLE: Role = "owner";
const APP_ID = "sample-app";
const RECORD_ID = "entry-0001";
const ENTRIES_PATH = `/api/apps/${APP_ID}/tables/entries/records`;

/**
 * **重みのクラス**(実測して固定する)。**太さと大きさだけで、色は1つも無い。**
 * **`leading-base` を添えているのは、Tailwind の `text-…` が行間も一緒に上書きし、
 * テーマの行間スロット(`--line-height-base`)から外れてしまうためである**
 * (`web/src/tailwind.css` の `--leading-base: var(--line-height-base)` へ戻す)。
 */
const WEIGHT_CLASSES = ["font-semibold", "text-lg", "leading-base"] as const;

const ENTRY_ROW = {
  _id: RECORD_ID,
  _created_at: "2026-01-01T00:00:00Z",
  _updated_at: "2026-01-02T00:00:00Z",
  title: "特上ちらし",
  memo: "冷蔵",
  status: "入金済み",
};

/**
 * 代表項目を宣言する / しないを差し替えられるフィクスチャ。
 * **`status` は `emphasis` を持つ `select`**((d) の対照)。
 */
function manifest(options: {
  representativeField?: string;
  emphasis?: boolean;
  fieldGroups?: Record<string, string[]>;
}): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "サンプル",
      tables: [
        {
          id: "entries",
          name: "エントリ",
          ...(options.representativeField === undefined
            ? {}
            : { representative_field: options.representativeField }),
          fields: [
            { id: "title", name: "品名", type: "text", required: true },
            { id: "memo", name: "メモ", type: "text" },
            {
              id: "status",
              name: "状態",
              type: "select",
              options: ["入金済み", "決済できず"],
              ...(options.emphasis === true
                ? { emphasis: { 入金済み: "info", 決済できず: "danger" } }
                : {}),
            },
          ],
        },
      ],
      views: [
        {
          id: "entry-detail",
          type: "detail_view",
          table: "entries",
          ...(options.fieldGroups === undefined ? {} : { field_groups: options.fieldGroups }),
        },
      ],
    },
  } as unknown as Manifest;
}

/** **代表項目を宣言していない**画面((c) の対照。`web/test/__fixtures__` と突き合わせる)。 */
function plainManifest(): Manifest {
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
      ],
      views: [{ id: "entry-detail", type: "detail_view", table: "entries" }],
    },
  } as unknown as Manifest;
}

const PLAIN_ROW = {
  _id: RECORD_ID,
  _created_at: "2026-01-01T00:00:00Z",
  _updated_at: "2026-01-02T00:00:00Z",
  f_a: "あ",
  f_b: "い",
  f_c: "う",
  f_d: "え",
};

let originalFetch: typeof fetch;
let row: Record<string, unknown> = ENTRY_ROW;

beforeEach(() => {
  row = ENTRY_ROW;
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
      return json({ record: row });
    }
    if (method === "GET" && url.startsWith(ENTRIES_PATH)) {
      return json({ records: [row] });
    }
    return json({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/entry-detail/records/${RECORD_ID}`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

async function renderDetail(source: Manifest, firstFieldId: string): Promise<HTMLElement> {
  const view = source.app.views[0] as DetailView;
  render(
    <RoleProvider role={WRITER_ROLE}>
      <DetailViewRenderer appId={APP_ID} manifest={source} view={view} recordId={RECORD_ID} />
    </RoleProvider>,
  );
  await waitFor(() => expect(screen.getByTestId(`detail-field-${firstFieldId}`)).toBeDefined());
  return screen.getByTestId("view-renderer-detail_view");
}

/** 重みのクラスが**全部**付いているか。 */
function hasWeight(node: Element): boolean {
  return WEIGHT_CLASSES.every((name) => node.className.split(/\s+/).includes(name));
}

// ---------------------------------------------------------------------------
// (a) 代表項目の器にだけ重みが付く
// ---------------------------------------------------------------------------

test("(a) 代表項目を宣言したテーブルの詳細画面で、その項目の器に重みのクラスが付く", async () => {
  await renderDetail(manifest({ representativeField: "title" }), "title");
  expect(hasWeight(screen.getByTestId("detail-field-title"))).toBe(true);
});

test("(a) 重みは色を1バイトも含まない(太さと大きさだけ)", async () => {
  await renderDetail(manifest({ representativeField: "title" }), "title");
  const className = screen.getByTestId("detail-field-title").className;
  // **色のクラスも色のリテラルも1つも無い。**
  expect(className).not.toMatch(/\btext-(foreground|muted|destructive|label|primary)/);
  expect(className).not.toMatch(/\bbg-/);
  expect(className).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  // **既存の `m-0` を落としていない**(器のクラスを置き換えていない)。
  expect(className.split(/\s+/)).toContain("m-0");
});

test("(a) まとまり(field_groups)の中の代表項目にも同じ重みが付く(器が割れない)", async () => {
  await renderDetail(
    manifest({ representativeField: "title", fieldGroups: { 主要: ["title"] } }),
    "title",
  );
  const dd = screen.getByTestId("detail-field-title");
  expect(dd.closest(".detail-field-group")).not.toBeNull();
  expect(hasWeight(dd)).toBe(true);
});

// ---------------------------------------------------------------------------
// (b) 他の項目には付かない
// ---------------------------------------------------------------------------

test("(b) 代表項目でない項目には重みのクラスが1つも付かない", async () => {
  await renderDetail(manifest({ representativeField: "title" }), "title");
  for (const id of ["memo", "status"]) {
    const dd = screen.getByTestId(`detail-field-${id}`);
    expect(hasWeight(dd), id).toBe(false);
    // **1つも付いていない**(「全部は付いていない」で誤魔化さない)。
    for (const name of WEIGHT_CLASSES) {
      expect(dd.className.split(/\s+/).includes(name), `${id}/${name}`).toBe(false);
    }
  }
});

test("(b) 項目名(dt)は1バイトも変わらない(重みが当たるのは値の器だけ)", async () => {
  await renderDetail(manifest({ representativeField: "title" }), "title");
  const dts = [...screen.getByTestId("detail-fields").querySelectorAll("dt")];
  expect(dts).toHaveLength(3);
  // どの `dt` も今日どおり同じ className である(代表項目の `dt` だけが違う、が起きない)。
  expect(new Set(dts.map((node) => node.className)).size).toBe(1);
});

// ---------------------------------------------------------------------------
// (c) 宣言していないテーブルでは何も起きない
// ---------------------------------------------------------------------------

/**
 * **代表項目を宣言していない `detail_view` の描画**(`V4-M16-T12` 着手時に、**実装を
 * 1バイトも入れる前に**取った DOM そのもの)。**`web/test/detail-field-grouping.test.tsx` の
 * (h) と同じフィクスチャを共有する** —— **同じ DOM を2つの記録に分けて持たないため。**
 *
 * **この検査が本タスクで最も効く** —— **`representativeField()`(`reference-label.ts`)は
 * 宣言が無いとき「最初の `text` フィールド」へ倒れるので、それを使うと宣言を1つも書いて
 * いない既存アプリの画面が全部変わる。** **その実装は本検査で赤になる。**
 */
const PLAIN_DETAIL_HTML = readFileSync(
  join(ROOT, "web", "test", "__fixtures__", "detail-view-plain.html"),
  "utf8",
).trim();

test("(c) 代表項目を宣言していないテーブルでは、どの項目にも重みが付かない(DOM が今日と一致)", async () => {
  row = PLAIN_ROW;
  const section = await renderDetail(plainManifest(), "f_a");
  expect(section.outerHTML).toBe(PLAIN_DETAIL_HTML);
  for (const dd of section.querySelectorAll("dd")) {
    expect(hasWeight(dd)).toBe(false);
  }
});

test("(c) 宣言が実在しないフィールドを指しているときは、どの項目にも重みが付かない(黙って倒れない)", async () => {
  // **`representativeField()` の 2 段目(最初の `text` へのフォールバック)をここへ持ち込まない。**
  await renderDetail(manifest({ representativeField: "no_such_field" }), "title");
  for (const id of ["title", "memo", "status"]) {
    expect(hasWeight(screen.getByTestId(`detail-field-${id}`)), id).toBe(false);
  }
});

test("(c) 宣言が text でないフィールドを指しているときも、どの項目にも重みが付かない", async () => {
  // `status` は `select` である。**参照ラベル側と同じ条件(text だけ)で判定する。**
  await renderDetail(manifest({ representativeField: "status" }), "title");
  for (const id of ["title", "memo", "status"]) {
    expect(hasWeight(screen.getByTestId(`detail-field-${id}`)), id).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// (d) emphasis(値の色)と当たり先が衝突しない
// ---------------------------------------------------------------------------

test("(d) emphasis を持つ select が代表項目でないとき、emphasis の描画が1バイトも変わらない", async () => {
  // 代表項目を宣言していない画面での `emphasis` の描画。
  const before = await renderDetail(manifest({ emphasis: true }), "title");
  const beforeHtml = before.querySelector('[data-testid="detail-field-status"]')?.outerHTML ?? "";
  // 比べる相手が実在すること(空文字どうしの一致で緑になる壊れ方を防ぐ)。
  expect(beforeHtml.length).toBeGreaterThan(0);
  cleanup();
  // 代表項目(`title`)を宣言した画面での `emphasis` の描画。
  await renderDetail(manifest({ representativeField: "title", emphasis: true }), "title");
  const afterDd = screen.getByTestId("detail-field-status");
  expect(afterDd.outerHTML).toBe(beforeHtml);
  // **当たり先が違う** —— 重みは `<dd>`(外側の器)、`emphasis` は `<dd>` の中の `<span>`。
  const span = afterDd.querySelector(".field-emphasis");
  expect(span?.getAttribute("data-emphasis")).toBe("info");
  expect(hasWeight(afterDd)).toBe(false);
  // 代表項目の側には重みが付いている(同じ画面で両方が並ぶ)。
  expect(hasWeight(screen.getByTestId("detail-field-title"))).toBe(true);
});

test("(d) 代表項目が emphasis を持つ select だとしても、重みは付かない(text だけが対象)", async () => {
  // **`emphasis` の色と重みが同じ器で重なる組み合わせを、そもそも作れない** ——
  // 代表項目は `text` に限られており、`emphasis` は `select` にしか書けないためである。
  await renderDetail(manifest({ representativeField: "status", emphasis: true }), "title");
  expect(hasWeight(screen.getByTestId("detail-field-status"))).toBe(false);
  expect(screen.getByTestId("detail-field-status").querySelector(".field-emphasis")).not.toBeNull();
});
