/**
 * 入力フォームの入力欄の幅(`V20-M3-T02`)と、入力フォームの項目のまとまり(`V20-M3-T03`)の描画。
 *
 * **条文の正**: 幅は `docs/adr/0460-field-sections-and-field-width.md` の限定4〜限定7、
 * まとまりは `docs/adr/0469-field-sections-two-branches.md`。
 *
 * ## 幅の当たり先(`ADR-0469` §Decision 5-2 の答えの履行)
 *
 * **幅は入力欄を包む項目の枠(`div.field`)に、描画側の有限のクラスを当てて出す。**
 * **`web/src/styles.css` に `input` / `select` / `textarea` を的にした寸法の規則を1本も足さない**
 * (下の (c) が styles.css の規則を読んで固定する)。
 *
 * | 値 | 項目の枠に当てるクラス(40rem 以上) | 意味 |
 * |---|---|---|
 * | 書かない | `sm:max-w-md`(着手前のまま) | 今日の既定 |
 * | `short` | `sm:max-w-3xs` | 狭い(16rem) |
 * | `medium` | `sm:max-w-md` | 今日の既定と同じ幅(28rem) |
 * | `full` | `sm:max-w-none` | 入力フォームの枠いっぱい |
 *
 * **40rem 未満では3値とも枠いっぱいである**(着手前の書かない入力欄と同じ。幅の条件を
 * 足していない)。
 *
 * ## まとまりの描画順(詳細画面と同じ)
 *
 * **(1) どのまとまりにも属さない項目を、`fields` の順で先に並べる。(2) そのあとに、まとまりを
 * マニフェストの記述順で並べる。** 詳細画面(`web/src/views/DetailViewRenderer.tsx` の
 * `ungroupedFields` を描いてから `fieldGroups` を描く箇所)と同じ順序である。
 *
 * ## 着手前の DOM(`__fixtures__`)
 *
 * - `form-undeclared-width-sections-before.dom.txt` —— 幅もまとまりも書かない入力フォーム2通り
 *   (プリセット無し / `preset_field_columns: 2` と `preset_label_placement: "inline"`)の DOM を、
 *   土台 `41c7a5e9` の写しで撮ったもの(統合の前 `59da786e` の写しでも1バイト同じだった)。
 * - `detail-field-sections-before.dom.txt` —— まとまりを書いた詳細画面2通りの DOM を、同じく
 *   土台 `41c7a5e9` の写しで撮ったもの(`59da786e` の写しに旧綴りで書いて撮った DOM と1バイト同じ)。
 * - **拡張子を `.html` にしていないのは、整形器(biome)が HTML として読み、撮った DOM の属性
 *   (区切り線の `role="separator"`・入力欄の `aria-required`)に支援技術の規則の指摘を出すためである。**
 *   撮った DOM そのものは1バイトも変えていない。
 *
 * ## このファイルが証明しないこと
 *
 * - **幅が実ブラウザの計算値で違うこと**は見ない(happy-dom は CSS を計算しない)。
 *   それは `web/e2e/form-field-width.e2e.ts` が見る。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";
import { FormRenderer } from "../src/views/FormRenderer.tsx";

const WRITER_ROLE: Role = "owner";
const ROOT = dirname(dirname(import.meta.dir));
const FIXTURES = join(ROOT, "web", "test", "__fixtures__");
const APP_ID = "sample-app";
const RECORD_ID = "entry-0001";
const ENTRIES_PATH = `/api/apps/${APP_ID}/tables/entries/records`;
const ENTRY_ROW = {
  _id: RECORD_ID,
  _created_at: "2026-01-01T00:00:00Z",
  _updated_at: "2026-01-02T00:00:00Z",
  f_a: "あ",
  f_b: "い",
  f_c: 3,
  f_d: "長い文",
  f_e: "赤",
  f_f: true,
  f_g: "2026-01-03",
};

/** **着手前の DOM を撮ったときと1バイトも違わないマニフェスト**(変えると (d) の比較が無意味になる)。 */
function manifest(view: Record<string, unknown>): Manifest {
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
            { id: "f_c", name: "項目C", type: "number" },
            { id: "f_d", name: "項目D", type: "long_text" },
            { id: "f_e", name: "項目E", type: "select", options: ["赤", "青"] },
            { id: "f_f", name: "項目F", type: "boolean" },
            { id: "f_g", name: "項目G", type: "date" },
          ],
        },
      ],
      views: [view],
    },
  } as unknown as Manifest;
}

const ALL = ["f_a", "f_b", "f_c", "f_d", "f_e", "f_f", "f_g"];
const FORM = { id: "entry-form", type: "form", table: "entries", fields: ALL };
const FORM_PRESETS = { preset_field_columns: 2, preset_label_placement: "inline" };
const SECTIONS = { 基本: ["f_b", "f_c"], 詳細: { id: "sec-detail", fields: ["f_e", "f_g"] } };

let originalFetch: typeof fetch;
beforeEach(() => {
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
    if (method === "GET" && url.startsWith(ENTRIES_PATH)) {
      return json({ records: [ENTRY_ROW] });
    }
    return json({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

async function renderForm(view: Record<string, unknown>): Promise<HTMLElement> {
  const m = manifest(view);
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/${String(view.id)}`);
  render(
    <RoleProvider role={WRITER_ROLE}>
      <FormRenderer appId={APP_ID} manifest={m} view={m.app.views[0] as never} />
    </RoleProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("view-renderer-form")).toBeDefined());
  return screen.getByTestId("view-renderer-form");
}

async function renderDetail(view: Record<string, unknown>): Promise<HTMLElement> {
  const m = manifest(view);
  window.history.replaceState(
    {},
    "",
    `/apps/${APP_ID}/views/${String(view.id)}/records/${RECORD_ID}`,
  );
  render(
    <RoleProvider role={WRITER_ROLE}>
      <DetailViewRenderer
        appId={APP_ID}
        manifest={m}
        view={m.app.views[0] as never}
        recordId={RECORD_ID}
      />
    </RoleProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("detail-field-f_a")).toBeDefined());
  return screen.getByTestId("view-renderer-detail_view");
}

function beforeLines(name: string): string[] {
  return readFileSync(join(FIXTURES, name), "utf8").trimEnd().split("\n");
}

/** 項目の枠(`div.field`)を、入力欄の `data-testid` から引く。 */
function wrapperOf(section: Element, fieldId: string): HTMLElement {
  const input = section.querySelector(`[for="entry-form-${fieldId}"]`);
  const wrapper = input?.closest(".field");
  if (!(wrapper instanceof HTMLElement)) {
    throw new Error(`${fieldId} の項目の枠が無い`);
  }
  return wrapper;
}

// ---------------------------------------------------------------------------
// T02 (a) 3値が項目の枠に有限のクラスとして当たる
// ---------------------------------------------------------------------------

test("T02 (a) short / medium / full を書いた項目の枠に、値ごとの有限のクラスと属性が出る", async () => {
  const section = await renderForm({
    ...FORM,
    field_width: { f_a: "short", f_b: "medium", f_d: "full" },
  });
  const short = wrapperOf(section, "f_a");
  const medium = wrapperOf(section, "f_b");
  const full = wrapperOf(section, "f_d");
  expect(short.getAttribute("data-field-width")).toBe("short");
  expect(medium.getAttribute("data-field-width")).toBe("medium");
  expect(full.getAttribute("data-field-width")).toBe("full");
  expect(short.className).toBe("field flex flex-col gap-s1 sm:max-w-3xs");
  expect(medium.className).toBe("field flex flex-col gap-s1 sm:max-w-md");
  expect(full.className).toBe("field flex flex-col gap-s1 sm:max-w-none");
  // 入力欄そのもの(input / textarea)のクラスは1文字も変わらない(幅は枠が持つ)。
  const before = new DOMParser().parseFromString(
    beforeLines("form-undeclared-width-sections-before.dom.txt")[0] as string,
    "text/html",
  );
  for (const fieldId of ["f_a", "f_b", "f_d"]) {
    const control = wrapperOf(section, fieldId).querySelector("input, textarea, select");
    const beforeControl = wrapperOf(before.body, fieldId).querySelector("input, textarea, select");
    expect(control?.outerHTML, fieldId).toBe(beforeControl?.outerHTML);
  }
});

test("T02 (a) 幅を書いた入力フォームでも、書いていない項目の枠は着手前の DOM と完全一致する", async () => {
  const section = await renderForm({ ...FORM, field_width: { f_a: "short", f_d: "full" } });
  const before = new DOMParser().parseFromString(
    beforeLines("form-undeclared-width-sections-before.dom.txt")[0] as string,
    "text/html",
  );
  for (const fieldId of ["f_b", "f_c", "f_e", "f_f", "f_g"]) {
    expect(wrapperOf(section, fieldId).outerHTML, fieldId).toBe(
      wrapperOf(before.body, fieldId).outerHTML,
    );
  }
});

// ---------------------------------------------------------------------------
// T02 (c) styles.css に input / select / textarea を的にする寸法の規則を足していない
// ---------------------------------------------------------------------------

test("T02 (c) styles.css で input / select / textarea を的にする規則は着手前の1本だけで、寸法の宣言を持たない", () => {
  const css = readFileSync(join(ROOT, "web", "src", "styles.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const rules: { selector: string; properties: string[] }[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (match[1] ?? "").trim();
    if (!/(^|[\s,>+~(])(input|select|textarea)\b/.test(selector)) {
      continue;
    }
    const properties = (match[2] ?? "")
      .split(";")
      .map((declaration) => declaration.split(":")[0]?.trim() ?? "")
      .filter((property) => property !== "");
    rules.push({ selector: selector.replace(/\s+/g, " "), properties });
  }
  expect(rules).toEqual([
    {
      selector: "button, input, select, textarea",
      properties: ["border-radius", "font-family", "line-height"],
    },
  ]);
  // 幅の3値の綴りも、項目の枠の属性も、styles.css に1バイトも現れない(当たり先は描画側のクラスだけ)。
  expect(css).not.toContain("data-field-width");
  expect(css).not.toContain("field_width");
});

// ---------------------------------------------------------------------------
// T03 (a) 入力フォームのまとまり
// ---------------------------------------------------------------------------

test("T03 (a) まとまりに属さない項目が fields の順で先に並び、次にまとまりが記述順に見出し付きで並ぶ", async () => {
  const section = await renderForm({ ...FORM, field_sections: SECTIONS });
  const form = section.querySelector("form") as HTMLElement;
  // <form> 直下の並び: 属さない項目(f_a, f_d, f_f)→ まとまり「基本」→ まとまり「詳細」→ 保存ボタン。
  const order = [...form.children].map((child) =>
    child.classList.contains("field")
      ? `field:${child.querySelector("label")?.getAttribute("for")?.replace("entry-form-", "")}`
      : child.getAttribute("data-testid") === "form-field-section"
        ? `section:${child.getAttribute("data-field-section")}`
        : child.tagName.toLowerCase(),
  );
  expect(order).toEqual([
    "field:f_a",
    "field:f_d",
    "field:f_f",
    "section:基本",
    "section:詳細",
    "button",
  ]);
  const sections = [...section.querySelectorAll('[data-testid="form-field-section"]')];
  expect(sections.map((node) => node.tagName.toLowerCase())).toEqual(["section", "section"]);
  // 見出しは h3(詳細画面のまとまりと同じ階層)、次に区切り、次に項目。
  expect(sections.map((node) => node.querySelector("h3")?.textContent)).toEqual(["基本", "詳細"]);
  for (const node of sections) {
    expect(node.children[0]?.tagName.toLowerCase()).toBe("h3");
    expect(node.children[1]?.getAttribute("data-slot")).toBe("separator");
  }
  const memberIds = sections.map((node) =>
    [...node.querySelectorAll(".field label")].map((label) =>
      label.getAttribute("for")?.replace("entry-form-", ""),
    ),
  );
  expect(memberIds).toEqual([
    ["f_b", "f_c"],
    ["f_e", "f_g"],
  ]);
});

test("T03 (a) 見出しと器のクラスは詳細画面のまとまりと同じ部品体系のクラスを使う(styles.css に規則を足さない)", async () => {
  const section = await renderForm({ ...FORM, field_sections: SECTIONS });
  const node = section.querySelector('[data-testid="form-field-section"]') as HTMLElement;
  expect(node.className).toBe("form-field-section flex flex-col gap-s2");
  expect(node.querySelector("h3")?.className).toBe(
    "form-field-section-heading m-0 font-semibold text-foreground",
  );
  const css = readFileSync(join(ROOT, "web", "src", "styles.css"), "utf8");
  expect(css).not.toContain("form-field-section");
});

test("T03 (a) 段組数を書いた入力フォームでは、属さない項目の並びとまとまりごとの並びに、それぞれ段の器が1つずつ出る", async () => {
  const section = await renderForm({ ...FORM, ...FORM_PRESETS, field_sections: SECTIONS });
  const form = section.querySelector("form") as HTMLElement;
  const containers = [...form.querySelectorAll(".form-fields")];
  expect(containers.length).toBe(3);
  // 1つ目は <form> 直下(属さない項目)、2つ目と3つ目はまとまりの中。
  // (happy-dom では親要素の同一性 `===` が偽を返すことがあるので、タグ名で見る。)
  expect(containers[0]?.parentElement?.tagName).toBe("FORM");
  expect(
    containers.slice(1).map((c) => c.parentElement?.getAttribute("data-field-section")),
  ).toEqual(["基本", "詳細"]);
  // 段の器は項目だけを包む(見出し・区切り・ボタンを段に入れない)。
  for (const container of containers) {
    expect([...container.children].every((child) => child.classList.contains("field"))).toBe(true);
  }
});

test("T03 (a) 全項目がまとまりに属する入力フォームでは、属さない項目の器を DOM に置かない", async () => {
  const section = await renderForm({
    ...FORM,
    ...FORM_PRESETS,
    field_sections: { 前: ["f_a", "f_b", "f_c"], 後: ["f_d", "f_e", "f_f", "f_g"] },
  });
  const form = section.querySelector("form") as HTMLElement;
  // **DOM の要素そのものを toEqual に渡さない**(赤のとき差分の印字が要素の木を辿って止まる)。
  expect([...form.children].filter((child) => child.classList.contains("form-fields")).length).toBe(
    0,
  );
  expect(form.querySelectorAll(".form-fields").length).toBe(2);
});

test("T03 (a) まとまりと幅は同じ入力フォームに書ける(まとまりの中の項目にも幅が当たる)", async () => {
  const section = await renderForm({
    ...FORM,
    field_sections: SECTIONS,
    field_width: { f_b: "short", f_a: "full" },
  });
  expect(wrapperOf(section, "f_b").getAttribute("data-field-width")).toBe("short");
  expect(wrapperOf(section, "f_b").parentElement?.getAttribute("data-field-section")).toBe("基本");
  expect(wrapperOf(section, "f_a").getAttribute("data-field-width")).toBe("full");
});

// ---------------------------------------------------------------------------
// T03 (b) 詳細画面の描画は統合の前と完全一致する(まとまりを書いた画面)
// ---------------------------------------------------------------------------

test("T03 (b) まとまりを書いた詳細画面の DOM が、統合の前と完全一致する(2通り)", async () => {
  const before = beforeLines("detail-field-sections-before.dom.txt");
  expect(before).toHaveLength(2);
  const views = [
    { id: "entry-detail", type: "detail_view", table: "entries", fields: ALL },
    {
      id: "entry-detail",
      type: "detail_view",
      table: "entries",
      fields: ALL,
      preset_field_columns: 2,
      preset_label_placement: "stacked",
    },
  ];
  for (const [index, view] of views.entries()) {
    const section = await renderDetail({ ...view, field_sections: SECTIONS });
    expect(section.outerHTML, String(index)).toBe(before[index] as string);
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// T03 (d) 幅もまとまりも書いていない入力フォームは着手前と完全一致する
// ---------------------------------------------------------------------------

test("T03 (d) 幅もまとまりも書いていない入力フォームの DOM が、着手前と完全一致する(2通り)", async () => {
  const before = beforeLines("form-undeclared-width-sections-before.dom.txt");
  expect(before).toHaveLength(2);
  for (const [index, view] of [FORM, { ...FORM, ...FORM_PRESETS }].entries()) {
    const section = await renderForm(view);
    expect(section.outerHTML, String(index)).toBe(before[index] as string);
    cleanup();
  }
});
