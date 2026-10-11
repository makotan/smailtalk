/**
 * **【2026-09-24。`V20-M3-T01` / `ADR-0469`】綴りを `field_groups` から `field_sections` に改めた。**
 * **この見張りの中身は綴り(入力のキー・期待する path の綴り)だけを替え、判定を1つも緩めていない。**
 * **下の表の `field_groups` は旧綴りの時点の記述である。** 統合後の形への打ち直しは `V20-M3-T04` の持ち分。
 *
 * **【2026-09-24。`V20-M3-T04` / `ADR-0469`】統合後の形を見張る形に打ち直した(旧の本文は下に残した)。**
 * 統合で `field_sections` は**入力フォーム(`form`)でも書ける**ようになったので、同じ事故(本体の
 * どこかが片方の枝・片方の画面種別だけを前提にしていて、`bun test` は1つも赤くならない)が
 * **入力フォームの3経路**(`validateReferentialIntegrity` / `generateRequirementsDoc` /
 * `FormRenderer`)でも起きうる。**下の (5)〜(7) が入力フォームの3経路を、2枝(配列 /
 * `{ id?, fields }`)の両方で押さえる。** (0) は「見張りの前提」—— 値の枝が2本・書ける分岐が
 * `form` と `detail_view` の2本であることを固定し、**3枝目や3つ目の画面種別が増えたら本ファイルが
 * 赤くなって、見張りの行列(枝 × 画面種別 × 3経路)の打ち直しを求める。** 型の検出器は
 * `NEW_SHAPE_FORM_VIEW`(`FormView` の `field_sections` に新しい形を入れる)を足した。
 * 入力フォームの描画の検査は `FormRenderer` の `.flat()` 型の取り違え(まとまりのオブジェクトが
 * そのまま「属するIDの集合」に入り、同じ項目が平坦な側とまとまりの側の両方に出る)を捕まえる。
 *
 * 項目のまとまり(`field_groups`)の**値の2つの形**を、実際に通る3経路で押さえる見張り
 * (`CM-G24`。`V10-M24-T03`。`ADR-0371` / `ADR-0374` §Decision 3)。
 *
 * ## なぜ「見張り」が要るのか(**この1文が本ファイルの存在理由である**)
 *
 * **`schemas/manifest.schema.json` が新しい形(`{ id?, fields }`)を受け付けるようになっても、
 * 本体が旧形(配列)だけを前提にしている箇所は1つも赤くならない。** 新しい形を書いた
 * アプリは**適用の時点では通り**、あとから `TypeError: memberIds.forEach is not a function`
 * で落ちる。**着手時、そういう箇所は9箇所あった** ——
 *
 * | # | 置き場 | 性質 |
 * |---|---|---|
 * | 1 | `src/kernel/types.ts`(`DetailView.field_groups`) | 型宣言 |
 * | 2 | `src/kernel/types.ts`(`ViewChanges.field_groups`) | 型宣言 |
 * | 3 | `src/kernel/referential-integrity.ts`(まとまりの束縛) | 束縛 |
 * | 4 | `src/kernel/referential-integrity.ts`(`memberIds.forEach`) | 配列演算 |
 * | 5 | `src/kernel/requirements-doc.ts`(まとまりの束縛) | 束縛 |
 * | 6 | `src/kernel/requirements-doc.ts`(`fields.forEach`) | 配列演算 |
 * | 7 | `web/src/views/DetailViewRenderer.tsx`(`Object.values(...).flat()`) | 配列演算 |
 * | 8 | `web/src/views/DetailViewRenderer.tsx`(まとまりの束縛) | 束縛 |
 * | 9 | `web/src/views/DetailViewRenderer.tsx`(`fields: memberIds` と続く `.map(`) | 束縛 |
 *
 * **検出器は2種である**(`V10-M24` 裁定9')—— **`bun test`(実行時)と `bunx tsc --noEmit`
 * (型だけの箇所)。** **型宣言の2箇所(1 / 2)は `bun test` が見ない**ので、本ファイルは
 * **新しい形の値を型の付いた変数に入れる**ことで `tsc` に見せている(下の `NEW_SHAPE_*`)。
 *
 * ## 描画は「例外を出さないこと」では足りない(裁定10')
 *
 * **7 の `.flat()` は、旧形のままでも例外を1つも出さない** —— まとまりのオブジェクトが
 * そのまま `Set` に入るだけで、**「まとまりに属する項目」の判定が静かに外れる。**
 * その結果**同じ項目が平坦な側とまとまりの側の両方に出る。** **したがって描画の検査は
 * 描画結果の中身(どの項目がどちらに出たか)を突き合わせる。**
 *
 * ## このファイルが証明しないこと(誇張しない)
 *
 * - **chromium で1度も確かめていない**(`web/e2e` に1本も足していない)。
 * - **名札の一意(同じ画面で同じ名札を2度書けないこと)を1度も測っていない** ——
 *   それを置くのは `V10-M24-T05` であり、本ファイルの時点ではその検査はまだ無い。
 * - **`src/mcp/` を1バイトも読んでいない** —— AI へ渡る説明が古いままである窓は
 *   `V10-M26-T02` が閉じる(裁定2')。
 *
 * ## 置き場について(裁定11')
 *
 * **`ADR-0374` §Decision 3 が名指しした `apps/smailtalk/src/kernel/field-group-shape.test.ts`
 * にそのまま置いた。** **`src/kernel/` から `web/` を読む import は、着手時0件だった** ——
 * 本ファイルの描画の検査がその1件目である。**`scripts/kernel-import-drift.test.ts` は
 * `src/kernel/` の**外**だけを走査するので、この import はその一覧に載らない。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import type { Role } from "../../web/src/api.ts";
import { RoleProvider } from "../../web/src/auth/authz.tsx";
import { DetailViewRenderer } from "../../web/src/views/DetailViewRenderer.tsx";
import { FormRenderer } from "../../web/src/views/FormRenderer.tsx";
import { applyDiff } from "./apply-diff.ts";
import { createApp } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { validateReferentialIntegrity } from "./referential-integrity.ts";
import { generateRequirementsDoc, type RequirementTemplateId } from "./requirements-doc.ts";
import type { Diff, FormView, Manifest, ResourceId, ViewChanges } from "./types.ts";

const APP_ID = "fg-shape";
const APP_NAME = "まとまりの形";
const VIEW_ID = "entry-detail";
const RECORD_ID = "row-0001";
const RECORDS_PATH = `/api/apps/${APP_ID}/tables/entries/records`;
const WRITER_ROLE: Role = "owner";

/**
 * **まとまりの値の2形**(`ADR-0371`)。**`src/kernel/types.ts` に `export type` を1本も
 * 足していない**(裁定6')ので、ここに検査用の別名を置く。**この別名が本体の型と食い違えば
 * `tsc` が赤くなる** —— それが型宣言の2箇所(上の表の 1 / 2)に対する検出器である。
 */
type FieldGroupValue = ResourceId[] | { id?: ResourceId; fields: ResourceId[] };

/** 新形(名札つき)。**上の表の 1 を `tsc` に見せるための値である。** */
const NEW_SHAPE: Record<string, FieldGroupValue> = {
  基本: { id: "g_basic", fields: ["f_a", "f_b"] },
};

/** 旧形(配列)。**同じ3経路を通ることを確かめる(手順書 3 の4本目)。** */
const OLD_SHAPE: Record<string, FieldGroupValue> = { 基本: ["f_a", "f_b"] };

/**
 * **上の表の 2(`ViewChanges.field_groups`)を `tsc` に見せるための値。**
 * **`update_view` の経路でも新しい形が書けることを、型の上で固定する。**
 */
const NEW_SHAPE_CHANGES: ViewChanges = { field_sections: NEW_SHAPE };

function manifestWith(groups: Record<string, FieldGroupValue>): Manifest {
  return {
    app: {
      id: APP_ID,
      name: APP_NAME,
      tables: [
        {
          id: "entries",
          name: "エントリ",
          fields: [
            { id: "f_a", name: "項目A", type: "text", required: true },
            { id: "f_b", name: "項目B", type: "text" },
            { id: "f_c", name: "項目C", type: "text" },
          ],
        },
      ],
      views: [{ id: VIEW_ID, type: "detail_view", table: "entries", field_sections: groups }],
    },
  };
}

const FORM_VIEW_ID = "entry-form";

/**
 * **【`V20-M3-T04`】入力フォームの型の検出器。** `FormView` の `field_sections` に新しい形を
 * 入れる。**`FormView` から `field_sections` が消えるか、片方の枝だけの型になれば `tsc` が赤くなる。**
 */
const NEW_SHAPE_FORM_VIEW: FormView = {
  id: FORM_VIEW_ID,
  type: "form",
  table: "entries",
  fields: ["f_a", "f_b", "f_c"],
  field_sections: NEW_SHAPE,
};

/** 入力フォーム1画面だけのマニフェスト(`manifestWith` の入力フォーム版)。 */
function formManifestWith(groups: Record<string, FieldGroupValue>): Manifest {
  const base = manifestWith(groups);
  base.app.views = [{ ...NEW_SHAPE_FORM_VIEW, field_sections: groups }];
  return base;
}

// ---------------------------------------------------------------------------
// 一時アプリ(`generateRequirementsDoc` の入口は `(dataRoot, appId)` だけである)
// ---------------------------------------------------------------------------

let dataRoot: string;
let store: KernelMetaStore;
let originalFetch: typeof fetch;

const ENTRY_ROW = {
  _id: RECORD_ID,
  _created_at: "2026-01-01T00:00:00Z",
  _updated_at: "2026-01-02T00:00:00Z",
  f_a: "あ",
  f_b: "い",
  f_c: "う",
};

function applyOrThrow(diff: Diff): void {
  const result = applyDiff(dataRoot, APP_ID, diff);
  if (!result.valid) {
    throw new Error(`検査の前提が崩れています: ${JSON.stringify(result.errors)}`);
  }
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-field-group-shape-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, APP_NAME, { app_id: APP_ID });
  applyOrThrow({
    diff_id: "d-fg-1",
    intent: "まとまりの形を見張るための土台",
    operations: [
      {
        op: "add_table",
        table: {
          id: "entries",
          name: "エントリ",
          fields: [
            { id: "f_a", name: "項目A", type: "text", required: true },
            { id: "f_b", name: "項目B", type: "text" },
            { id: "f_c", name: "項目C", type: "text" },
          ],
        },
      },
      { op: "add_view", view: { id: VIEW_ID, type: "detail_view", table: "entries" } },
    ],
  });

  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (method === "GET" && url === `${RECORDS_PATH}/${RECORD_ID}`) {
      return json({ record: ENTRY_ROW });
    }
    if (method === "GET" && url.startsWith(RECORDS_PATH)) {
      return json({ records: [ENTRY_ROW] });
    }
    return json({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/${VIEW_ID}/records/${RECORD_ID}`);
});

afterEach(async () => {
  cleanup();
  globalThis.fetch = originalFetch;
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

/** `dl.detail-fields` の中の項目ID(描画順)。 */
function fieldIdsOf(list: Element): string[] {
  return [...list.querySelectorAll("[data-field]")].map(
    (node) => node.getAttribute("data-field") ?? "",
  );
}

async function renderDetail(manifest: Manifest): Promise<HTMLElement> {
  const view = manifest.app.views[0];
  if (view === undefined || view.type !== "detail_view") {
    throw new Error("検査の前提が崩れています(detail_view が無い)");
  }
  const child = createElement(DetailViewRenderer, {
    appId: APP_ID,
    manifest,
    view,
    recordId: RECORD_ID,
  });
  // **JSX を使わないのは、本ファイルの置き場が `ADR-0374` §Decision 3 の名指した
  // `field-group-shape.test.ts`(`.tsx` ではない)だからである**(裁定11')。
  // `RoleProvider` の props は `children` を必須で持つ型なので、`createElement` の
  // 可変長引数ではなく props で渡す —— そうしないと `tsc` が `TS2769` で赤くなる。
  // biome-ignore lint/correctness/noChildrenProp: 上のとおり、tsc を通すには props で渡すしかない
  render(createElement(RoleProvider, { role: WRITER_ROLE, children: child }));
  await waitFor(() => expect(screen.getByTestId("detail-field-f_a")).toBeDefined());
  return screen.getByTestId("view-renderer-detail_view");
}

/** 「まとまりの器の外」に平坦に並んだ項目(`Card` の直下の `dl.detail-fields`)。 */
function ungroupedFieldIds(section: HTMLElement): string[] {
  const card = section.querySelector('[data-slot="card"]');
  if (card === null) {
    throw new Error("検査の前提が崩れています(Card が無い)");
  }
  const plain = [...card.children].find(
    (node) => node.getAttribute("data-testid") === "detail-fields",
  );
  return plain === undefined ? [] : fieldIdsOf(plain);
}

/** `ValidationResult` は valid のとき `errors` を持たない union である。 */
function pathsOf(result: ReturnType<typeof validateReferentialIntegrity>): string[] {
  return result.valid ? [] : result.errors.map((error) => error.path);
}

function textsOf(template: RequirementTemplateId): string[] {
  return generateRequirementsDoc(dataRoot, APP_ID)
    .statements.filter((statement) => statement.template === template)
    .map((statement) => statement.text);
}

// ---------------------------------------------------------------------------
// (1) 新形が `validateReferentialIntegrity` を通る
// ---------------------------------------------------------------------------

test("(1) 新形 { id, fields } が validateReferentialIntegrity を通る", () => {
  const result = validateReferentialIntegrity(manifestWith(NEW_SHAPE));
  expect(pathsOf(result)).toEqual([]);
  expect(result.valid).toBe(true);
});

test("(1) 新形の中身が実際に照合されている(実在しない項目IDを書くと拒否される)", () => {
  // **`validateReferentialIntegrity` は try で包まれていない** —— 形を取り違えていれば
  // `{valid:false}` ではなく例外が投げ上がる。**この検査はそれも見る。**
  const result = validateReferentialIntegrity(
    manifestWith({ 基本: { id: "g_basic", fields: ["zzqqxx"] } }),
  );
  expect(result.valid).toBe(false);
  expect(pathsOf(result)[0]).toBe(`/app/views/0/field_sections/基本/0`);
});

test("(1) 新形でも「1つの項目が属せるまとまりは1つだけ」が効く", () => {
  const result = validateReferentialIntegrity(
    manifestWith({ 基本: { fields: ["f_a"] }, 補足: { id: "g_extra", fields: ["f_a"] } }),
  );
  expect(result.valid).toBe(false);
  expect(pathsOf(result)[0]).toBe(`/app/views/0/field_sections/補足/0`);
});

// ---------------------------------------------------------------------------
// (2) 新形が `generateRequirementsDoc` を通る
// ---------------------------------------------------------------------------

test("(2) 新形を書いたアプリの要件定義書が、旧形と1文字も違わない文を出す", () => {
  applyOrThrow({
    diff_id: "d-fg-2",
    intent: "名札つきのまとまりを書く",
    operations: [{ op: "update_view", view: VIEW_ID, changes: NEW_SHAPE_CHANGES }],
  });

  expect(textsOf("screens.field_group")).toEqual([
    "画面 `entry-detail` の `1` 番目の項目のまとまりの名前は 「基本」 である。",
  ]);
  expect(textsOf("screens.field_group_item")).toEqual([
    "画面 `entry-detail` の `1` 番目の項目のまとまりは、`1` 番目の項目としてフィールド `f_a` を含む。",
    "画面 `entry-detail` の `1` 番目の項目のまとまりは、`2` 番目の項目としてフィールド `f_b` を含む。",
  ]);
});

test("(2) 【裁定3'】名札は要件定義書に1文字も出ない(3種目のテンプレートを足していない)", () => {
  applyOrThrow({
    diff_id: "d-fg-2b",
    intent: "名札つきのまとまりを書く",
    operations: [{ op: "update_view", view: VIEW_ID, changes: NEW_SHAPE_CHANGES }],
  });

  const doc = generateRequirementsDoc(dataRoot, APP_ID);
  for (const statement of doc.statements) {
    expect(statement.text).not.toContain("g_basic");
  }
  // **まとまりについて出る文は今日も2種ちょうどである。**
  const groupTemplates = doc.statements
    .map((statement) => statement.template)
    .filter((template) => template.startsWith("screens.field_group"));
  expect([...new Set(groupTemplates)].sort()).toEqual([
    "screens.field_group",
    "screens.field_group_item",
  ]);
});

// ---------------------------------------------------------------------------
// (3) 新形が `DetailViewRenderer` の描画で期待どおりの中身を出す(裁定10')
// ---------------------------------------------------------------------------

test("(3) 新形の描画: まとまりの中身と、平坦に並ぶ項目が、旧形と同じに割れる", async () => {
  const section = await renderDetail(manifestWith(NEW_SHAPE));

  const groups = [...section.querySelectorAll('[data-testid="detail-field-group"]')];
  expect(groups).toHaveLength(1);
  expect(groups[0]?.querySelector("h3")?.textContent).toBe("基本");
  expect(fieldIdsOf(groups[0] as Element)).toEqual(["f_a", "f_b"]);

  // **【これが `.flat()` を捕まえる式である】** まとまりに属する項目は**平坦な側に出ない。**
  // 旧形のままの `.flat()` では、まとまりのオブジェクトがそのまま `Set` に入るので
  // `f_a` / `f_b` の判定が外れ、ここが `["f_a","f_b","f_c"]` になる。
  expect(ungroupedFieldIds(section)).toEqual(["f_c"]);

  // **名札は画面に1文字も出ない**(限定6)。
  expect(section.textContent ?? "").not.toContain("g_basic");
});

// ---------------------------------------------------------------------------
// (4) 旧形も同じ3経路を通る
// ---------------------------------------------------------------------------

test("(4) 旧形(配列)も validateReferentialIntegrity を通る", () => {
  const result = validateReferentialIntegrity(manifestWith(OLD_SHAPE));
  expect(pathsOf(result)).toEqual([]);
  expect(result.valid).toBe(true);

  const broken = validateReferentialIntegrity(manifestWith({ 基本: ["zzqqxx"] }));
  expect(broken.valid).toBe(false);
  expect(pathsOf(broken)[0]).toBe(`/app/views/0/field_sections/基本/0`);
});

test("(4) 旧形(配列)も generateRequirementsDoc で同じ文を出す", () => {
  applyOrThrow({
    diff_id: "d-fg-3",
    intent: "名札を書かないまとまり",
    operations: [{ op: "update_view", view: VIEW_ID, changes: { field_sections: OLD_SHAPE } }],
  });

  expect(textsOf("screens.field_group")).toEqual([
    "画面 `entry-detail` の `1` 番目の項目のまとまりの名前は 「基本」 である。",
  ]);
  expect(textsOf("screens.field_group_item")).toEqual([
    "画面 `entry-detail` の `1` 番目の項目のまとまりは、`1` 番目の項目としてフィールド `f_a` を含む。",
    "画面 `entry-detail` の `1` 番目の項目のまとまりは、`2` 番目の項目としてフィールド `f_b` を含む。",
  ]);
});

test("(4) 旧形(配列)も DetailViewRenderer で同じ中身を出す", async () => {
  const section = await renderDetail(manifestWith(OLD_SHAPE));

  const groups = [...section.querySelectorAll('[data-testid="detail-field-group"]')];
  expect(groups).toHaveLength(1);
  expect(groups[0]?.querySelector("h3")?.textContent).toBe("基本");
  expect(fieldIdsOf(groups[0] as Element)).toEqual(["f_a", "f_b"]);
  expect(ungroupedFieldIds(section)).toEqual(["f_c"]);
});

// ---------------------------------------------------------------------------
// 【`V20-M3-T04`】統合後の形の見張り(入力フォームの3経路と、見張りの前提)
// ---------------------------------------------------------------------------

/** スキーマ(`$defs/view`)を読む。 */
function viewSchema(): {
  properties: Record<string, { oneOf?: unknown[]; additionalProperties?: { oneOf?: unknown[] } }>;
  allOf: {
    if?: { properties?: { type?: { const?: string } } };
    then?: { properties?: Record<string, unknown> };
  }[];
} {
  const root = dirname(dirname(import.meta.dir));
  return JSON.parse(readFileSync(join(root, "schemas", "manifest.schema.json"), "utf8")).$defs.view;
}

test("(0) 見張りの前提: 値の枝は2本(配列 / { id?, fields })、書ける分岐は form と detail_view の2本", () => {
  const view = viewSchema();
  const branches = view.properties.field_sections?.additionalProperties?.oneOf as {
    type?: string;
  }[];
  // **枝が3本目を持つか1本に畳まれたら、下の (1)〜(7) の行列を打ち直すこと。**
  expect(branches.map((branch) => branch.type)).toEqual(["array", "object"]);
  const kinds = view.allOf
    .map((entry) => entry.if?.properties?.type?.const)
    .filter((kind): kind is string => kind !== undefined);
  const writable = kinds.filter(
    (kind) =>
      view.allOf.find((entry) => entry.if?.properties?.type?.const === kind)?.then?.properties
        ?.field_sections !== false,
  );
  // **書ける画面種別が増えたら、その種別の3経路を本ファイルに足すこと。**
  expect(writable.sort()).toEqual(["detail_view", "form"]);
  expect(kinds.filter((kind) => !writable.includes(kind)).sort()).toEqual([
    "list_view",
    "report_view",
  ]);
});

test("(5) 入力フォーム: 新形・旧形のどちらも validateReferentialIntegrity を通る", () => {
  for (const groups of [NEW_SHAPE, OLD_SHAPE]) {
    const result = validateReferentialIntegrity(formManifestWith(groups));
    expect(pathsOf(result)).toEqual([]);
    expect(result.valid).toBe(true);
  }
});

test("(5) 入力フォーム: 新形・旧形のどちらでも、表示項目に無いIDは拒否される(中身が照合されている)", () => {
  const newShape = validateReferentialIntegrity(
    formManifestWith({ 基本: { id: "g_basic", fields: ["zzqqxx"] } }),
  );
  expect(newShape.valid).toBe(false);
  expect(pathsOf(newShape)[0]).toBe(`/app/views/0/field_sections/基本/0`);
  const oldShape = validateReferentialIntegrity(formManifestWith({ 基本: ["zzqqxx"] }));
  expect(oldShape.valid).toBe(false);
  expect(pathsOf(oldShape)[0]).toBe(`/app/views/0/field_sections/基本/0`);
});

test("(5) 入力フォーム: 2枝を混ぜても「1つの項目が属せるまとまりは1つだけ」が効く", () => {
  const result = validateReferentialIntegrity(
    formManifestWith({ 基本: ["f_a"], 補足: { id: "g_extra", fields: ["f_a"] } }),
  );
  expect(result.valid).toBe(false);
  expect(pathsOf(result)[0]).toBe(`/app/views/0/field_sections/補足/0`);
});

test("(6) 入力フォーム: 新形・旧形のどちらを書いても、要件定義書は同じ2種の文を出す(名札は出ない)", () => {
  applyOrThrow({
    diff_id: "d-fg-form-1",
    intent: "入力フォームを足す",
    operations: [
      {
        op: "add_view",
        view: { id: FORM_VIEW_ID, type: "form", table: "entries", fields: ["f_a", "f_b", "f_c"] },
      },
    ],
  });
  const expected = {
    group: ["画面 `entry-form` の `1` 番目の項目のまとまりの名前は 「基本」 である。"],
    items: [
      "画面 `entry-form` の `1` 番目の項目のまとまりは、`1` 番目の項目としてフィールド `f_a` を含む。",
      "画面 `entry-form` の `1` 番目の項目のまとまりは、`2` 番目の項目としてフィールド `f_b` を含む。",
    ],
  };
  const shapes: [string, Record<string, FieldGroupValue>][] = [
    ["new", NEW_SHAPE],
    ["old", OLD_SHAPE],
  ];
  for (const [label, groups] of shapes) {
    applyOrThrow({
      diff_id: `d-fg-form-${label}`,
      intent: "入力フォームにまとまりを書く",
      operations: [{ op: "update_view", view: FORM_VIEW_ID, changes: { field_sections: groups } }],
    });
    expect(textsOf("screens.field_group"), label).toEqual(expected.group);
    expect(textsOf("screens.field_group_item"), label).toEqual(expected.items);
    for (const statement of generateRequirementsDoc(dataRoot, APP_ID).statements) {
      expect(statement.text, label).not.toContain("g_basic");
    }
  }
});

async function renderForm(manifest: Manifest): Promise<HTMLElement> {
  const view = manifest.app.views[0];
  if (view === undefined || view.type !== "form") {
    throw new Error("検査の前提が崩れています(form が無い)");
  }
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/${FORM_VIEW_ID}`);
  const child = createElement(FormRenderer, { appId: APP_ID, manifest, view });
  // biome-ignore lint/correctness/noChildrenProp: renderDetail と同じ理由(tsc を通すには props で渡すしかない)
  render(createElement(RoleProvider, { role: WRITER_ROLE, children: child }));
  await waitFor(() => expect(screen.getByTestId("view-renderer-form")).toBeDefined());
  return screen.getByTestId("view-renderer-form");
}

/** 入力フォームの項目の枠(`.field`)の中のラベルから、項目IDを描画順に引く。 */
function formFieldIdsOf(scope: Element): string[] {
  return [...scope.querySelectorAll(".field label")].map(
    (label) => label.getAttribute("for")?.replace(`${FORM_VIEW_ID}-`, "") ?? "",
  );
}

/** `<form>` の直下に平坦に並んだ項目(まとまりの器の外)。 */
function formUngroupedFieldIds(section: HTMLElement): string[] {
  const form = section.querySelector("form");
  if (form === null) {
    throw new Error("検査の前提が崩れています(form 要素が無い)");
  }
  return [...form.children]
    .filter((child) => child.classList.contains("field"))
    .map(
      (child) =>
        child.querySelector("label")?.getAttribute("for")?.replace(`${FORM_VIEW_ID}-`, "") ?? "",
    );
}

for (const [label, groups] of [
  ["新形", NEW_SHAPE],
  ["旧形", OLD_SHAPE],
] as const) {
  test(`(7) 入力フォームの描画(${label}): まとまりの中身と、平坦に並ぶ項目が詳細画面と同じに割れる`, async () => {
    const section = await renderForm(formManifestWith(groups));
    const sections = [...section.querySelectorAll('[data-testid="form-field-section"]')];
    expect(sections).toHaveLength(1);
    expect(sections[0]?.querySelector("h3")?.textContent).toBe("基本");
    expect(formFieldIdsOf(sections[0] as Element)).toEqual(["f_a", "f_b"]);
    // **`.flat()` 型の取り違えを捕まえる式**: まとまりに属する項目は平坦な側に出ない。
    expect(formUngroupedFieldIds(section)).toEqual(["f_c"]);
    // 項目は画面全体でちょうど1度ずつ出る(同じ項目が2か所に出ない)。
    expect(formFieldIdsOf(section).sort()).toEqual(["f_a", "f_b", "f_c"]);
    // 名札は画面に1文字も出ない。
    expect(section.textContent ?? "").not.toContain("g_basic");
  });
}
