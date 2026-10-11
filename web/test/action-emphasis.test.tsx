/**
 * **押してほしい主なボタンと、そうでないボタンを見た目で区別する**(`V4-M19-T01`)。
 *
 * **門A の判定は「将来送り」であり、本ファイルはその送り先の履行を固定する。**
 * **`ADR` は無い**(台帳1行)—— **限定表の正になる文書が存在しないので、決めた形は
 * `web/src/views/DetailViewRenderer.tsx` の実装コメントと本ファイルの2箇所にしかない。**
 *
 * ## 固定する規約(**宣言ではない**)
 *
 * **`view.actions`(マニフェストに書かれた配列)の1番目を主(`variant="default"`)、
 * それ以外を副(`variant="secondary"`)とする。** **位置は `writableActions`(ロールで
 * 絞り込んだ後の配列)ではなく、書かれた配列の位置である。**
 *
 * ## この検査が言えないこと(**先に書く。誇張しない**)
 *
 * 1. **【禁止】「主なボタンをアプリが選べるようになった」と書かない** —— **アプリが
 *    宣言で選ぶことはできない。** 選べるのは並び順を通じてだけで、**それは規約であって
 *    宣言ではない。** **語彙は1バイトも増えていない**(`src/` / `schemas/` は0行差分)。
 * 2. **規約はマニフェストにも MCP の説明文にも現れない** —— **マニフェストを読んだだけでは
 *    どれが主か分からない。** 起票時の完了条件「規約が `src/mcp/vocabulary.ts` の散文に
 *    明記される」は**満たしていない**(理由は実装コメントに書いた)。
 * 3. **1番目がロールで絞り落とされた画面では、主のボタンが1つも出ない**(2番目は繰り上がら
 *    ない)。**これは意図した挙動であり、(c) が固定する。**
 * 4. **ここは happy-dom であって CSS を1バイトも計算していない。** 見ているのは
 *    `data-variant` 属性と className の字面だけで、**「画面でどう見えるか」は1件も測っていない。**
 * 5. **chromium で1度も確かめていない**(`web/e2e` に1本も足していない)。
 * 6. **2つの見た目に見分けが付くか(コントラスト・視認性)を1件も測っていない。**
 *
 * ## 【`V20-M2-T02` / `ADR-0459`。2026-09-24 に追記。上の文は1バイトも消していない】上の規約は今日から偽である
 *
 * **上の「固定する規約」(1番目を主、それ以外を副)と、「言えないこと」1 の逐語
 * 「**アプリが宣言で選ぶことはできない。**」「**語彙は1バイトも増えていない**」は、今日から偽である。**
 * **`$defs/view_action.properties` に9キー目 `action_emphasis`(`primary` / `secondary` /
 * `danger` の3値。省略可)が足され、各ボタンの見た目はそのボタン自身の宣言だけで決まる。**
 *
 * - `primary` → `variant="default"`(**旧の「主」と同じ見た目**。塗りつぶしの `primary` variant ではない)
 * - `secondary` → `variant="secondary"`
 * - `danger` → `variant="destructive"`
 * - **書いていない → `variant="secondary"`(主を出さない)。** **並び順は見た目に1バイトも効かない。**
 *
 * **「言えないこと」3(1番目が絞り落とされると主が1つも出ない)は形を変えて今日も真である** ——
 * **繰り上げが無いのは同じだが、理由は「位置」ではなく「各ボタンが自分の宣言だけで決まる」ことに
 * なった。****(c) 群が固定する。**
 * **「言えないこと」4 / 6 は今日も真である**(ここは happy-dom で CSS を計算しない)。
 * **「言えないこと」5 は今日から偽である** —— **`web/e2e/action-emphasis.e2e.ts` を足し、
 * chromium の計算値で主と副の地色が違うことを測った。**
 *
 * **旧の検査9本の名前(逐語)と、打ち直した先は `docs/plan/v20/records/v20-m2-t02.md` に書いた。**
 * **消した検査は1本も無い**(9本とも同じ主題の新しい期待値へ打ち直した)。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { DetailView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";
import { actionRead, grantRules, viewRead } from "./role-rules.ts";

const ROOT = dirname(dirname(import.meta.dir));
const WRITER_ROLE: Role = "owner";
const CUSTOMER_ROLE: Role = "customer";
const APP_ID = "sample-app";
const RECORD_ID = "entry-0001";
const ENTRIES_PATH = `/api/apps/${APP_ID}/tables/entries/records`;
const TARGETS_PATH = `/api/apps/${APP_ID}/tables/targets/records`;

const ENTRY_ROW = {
  _id: RECORD_ID,
  _created_at: "2026-01-01T00:00:00Z",
  _updated_at: "2026-01-02T00:00:00Z",
  f_a: "あ",
  f_b: "い",
  f_c: "う",
  f_d: "え",
};

/**
 * **customer から見た2カテゴリが別々のテーブルに分かれたフィクスチャ**
 * (`web/test/detail-view.test.tsx` の `crossTableManifest` と同じ形):
 *
 * - `entries`(= 詳細の対象)… `st_public` → customer は**書けない**
 * - `targets`(= もう1つの遷移先 form の対象)… `st_owner` → customer は**書ける**
 */
function actionsManifest(actions: NonNullable<DetailView["actions"]>): Manifest {
  const built = {
    app: {
      id: APP_ID,
      name: "サンプル",
      tables: [
        {
          id: "entries",
          name: "エントリ",
          fields: [
            { id: "f_a", name: "項目A", type: "text", required: true },
            { id: "st_public", name: "公開", type: "boolean" },
          ],
        },
        {
          id: "targets",
          name: "参照先",
          fields: [
            { id: "label", name: "名前", type: "text", required: true },
            { id: "st_owner", name: "所有者", type: "text" },
            { id: "parent", name: "親", type: "reference", reference_table: "entries" },
          ],
        },
      ],
      views: [
        { id: "entry-detail", type: "detail_view", table: "entries", actions },
        { id: "entry-form", type: "form", table: "entries", fields: ["f_a"] },
        { id: "target-form", type: "form", table: "targets", fields: ["label", "parent"] },
      ],
    },
  } as unknown as Manifest;
  // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`】既定が「閉じる」側へ倒れたので、
  // 規則を1本も書かない題材では**遷移先の2つの form をどちらも開けない**と判定され、
  // **主副の描き分け(このファイルの主題)を測る対象のボタンが1つも出ない**
  // (`DetailViewRenderer` が行き先に対して `canUseView` を見る)。
  //
  // **足すのは、この題材に出てくる遷移先2画面 × 読取 × この題材に出てくる2ロールだけである。**
  // **`entry-form` を `customer` にも足しているのは、(c) の主題を保つためである** ——
  // **(c) が測っているのは「1番目が**ロール(書込)**で絞り落とされても2番目は繰り上がらない」
  // であり、その絞り込みは `canWriteRole`(`entries` は `st_public` なので customer は書けない)
  // でなければならない。** **面で先に落とすと (c) は主題を測らなくなる。**
  // **`viewer` には1本も足していない**(この題材に `viewer` は1度も出てこない)。
  return grantRules(
    built,
    ["owner", "customer"],
    [viewRead("entry-form"), viewRead("target-form")],
  );
}

/**
 * **3形(遷移 / 値の書換 / 自動処理の起動)を1画面に並べる題材**(`V20-M2-T03`)。
 * **`DetailViewRenderer` の3箇所の `variant` がどれも宣言を読むことを見るため。**
 * **手動で起こすワークフロー1本を足す以外は `actionsManifest` と同じである。**
 */
function threeShapeManifest(actions: NonNullable<DetailView["actions"]>): Manifest {
  const manifest = actionsManifest(actions);
  (manifest.app as { workflows?: unknown[] }).workflows = [
    {
      id: "notify",
      name: "知らせる",
      trigger: { type: "manual", table: "entries" },
      actions: [{ action: "create_record", table: "targets", values: { label: "通知" } }],
      history_table: "targets",
    },
  ];
  return manifest;
}

/**
 * **宣言ボタンの器(`detail-action-origins`)の中で、`data-variant` が主に当たる値
 * (`default`)のボタンを数える。** **組込の編集ボタン(`detail-edit`)は元から
 * `default` なので、器の外にあり、ここでは数えない。**
 */
function countDeclaredPrimary(section: HTMLElement): number {
  // 【V20-M9 / ADR-0474 §1-7】主の variant を "default" → "emphasis" に打ち直した。旧(逐語): return section.querySelectorAll('[data-testid="detail-action-origins"] [data-variant="default"]')
  return section.querySelectorAll('[data-testid="detail-action-origins"] [data-variant="emphasis"]')
    .length;
}

function variantsOf(section: HTMLElement): (string | null)[] {
  return [
    ...section.querySelectorAll('[data-testid="detail-action-origins"] button[data-variant]'),
  ].map((node) => node.getAttribute("data-variant"));
}

/** 遷移先が `entries`(public)の操作起点 —— **customer では絞り落とされる。** */
const TO_PUBLIC_FORM = {
  form: "entry-form",
  prefill: { field: "f_a" },
  name: "商品を直す",
} as NonNullable<DetailView["actions"]>[number];
/** 遷移先が `targets`(scoped)の操作起点 —— **customer でも残る。** */
const TO_SCOPED_FORM = {
  form: "target-form",
  prefill: { field: "parent" },
  name: "カートに入れる",
} as NonNullable<DetailView["actions"]>[number];

/** **操作起点を1つも持たない画面**((d) の対照。`web/test/__fixtures__` と突き合わせる)。 */
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
    if (method === "GET" && url.startsWith(TARGETS_PATH)) {
      return json({ records: [] });
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

function detailView(manifest: Manifest): DetailView {
  const view = manifest.app.views[0];
  if (view === undefined || view.type !== "detail_view") {
    throw new Error("fixture broken");
  }
  return view;
}

async function renderDetail(manifest: Manifest, role: Role = WRITER_ROLE): Promise<HTMLElement> {
  render(
    <RoleProvider role={role}>
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

// ---------------------------------------------------------------------------
// (a) 宣言の無いボタンは主にならない(`V20-M2-T02` (a))
// ---------------------------------------------------------------------------

/**
 * **`data-variant` を見る**(className ではなく)。**`web/src/ui/button.tsx` が
 * `data-variant` を必ず出しており**(`web/test/__fixtures__/detail-view-plain.html` の
 * 削除ボタンに `data-variant="destructive"` が実在する = 着手前に取った DOM で実測済み)、
 * **className は `cva` が組む長い字面なので、そちらを主の根拠にしない。**
 * **className も一応見る**((a) の2本目)—— 属性だけが合っていて見た目が変わらない、
 * という壊れ方を素通りさせないため。
 *
 * **【`V20-M2-T02`。旧テスト名(逐語)】**
 * 「(a) 操作起点が1件のとき、そのボタンは主(data-variant=default)である」。
 * **旧は「1件なら主」を固定していた。今日は宣言が無ければ1件でも副である。**
 */
test("(a) 操作起点が1件で宣言が無いとき、そのボタンは主にならない(data-variant=secondary)", async () => {
  const section = await renderDetail(actionsManifest([TO_SCOPED_FORM]));
  const button = screen.getByTestId("action-origin-target-form");
  expect(button.getAttribute("data-variant")).toBe("secondary");
  expect(countDeclaredPrimary(section)).toBe(0);
});

/**
 * **【`V20-M2-T02`。旧テスト名(逐語)】**
 * 「(a) 主のボタンの className は副のそれと実際に違う(属性だけの差にしない)」。
 * **旧は「1件のとき(主)と2件の2番目(副)」を比べていた。今日は宣言で主と副を作って比べる。**
 * **地色のクラスの期待(`bg-background` / `bg-secondary`)は1文字も変えていない。**
 */
test("(a) 宣言した主のボタンの className は、宣言した副のそれと実際に違う(属性だけの差にしない)", async () => {
  const solo = await renderDetail(
    actionsManifest([{ ...TO_SCOPED_FORM, action_emphasis: "primary" }] as NonNullable<
      DetailView["actions"]
    >),
  );
  const primaryClass = solo.querySelector('[data-testid="action-origin-target-form"]')?.className;
  cleanup();
  const pair = await renderDetail(
    actionsManifest([{ ...TO_SCOPED_FORM, action_emphasis: "secondary" }] as NonNullable<
      DetailView["actions"]
    >),
  );
  const secondaryClass = pair.querySelector('[data-testid="action-origin-target-form"]')?.className;
  expect(primaryClass).not.toBe(secondaryClass);
  // **`web/src/ui/button.tsx` の既存5値のうち3つを選んでいるだけである**(新しい variant を
  // 1つも作っていない)。**地色のクラスがそれぞれの variant のものになっている。**
  // 【V20-M9 / ADR-0474 §1-7】主は `button.tsx` に足した variant `emphasis` で描く(上の「新しい variant を
  // 1つも作っていない」は引き直しの前の逐語)。旧(逐語): `expect(primaryClass).toContain("bg-background");`
  expect(primaryClass).toContain("bg-primary-fill");
  expect(primaryClass).toContain("text-on-primary");
  expect(secondaryClass).toContain("bg-secondary");
});

// ---------------------------------------------------------------------------
// (b) 並び順は見た目に効かない
// ---------------------------------------------------------------------------

/**
 * **【`V20-M2-T02`。旧テスト名(逐語)】**
 * 「(b) 操作起点が2件のとき、1番目だけが主で2番目は副である」。
 * **旧は1番目を主と固定していた。今日は宣言が無ければ2件とも副である。**
 */
test("(b) 操作起点が2件で宣言が無いとき、2件とも副で、主は1つも出ない", async () => {
  const section = await renderDetail(actionsManifest([TO_PUBLIC_FORM, TO_SCOPED_FORM]));
  expect(screen.getByTestId("action-origin-entry-form").getAttribute("data-variant")).toBe(
    "secondary",
  );
  expect(screen.getByTestId("action-origin-target-form").getAttribute("data-variant")).toBe(
    "secondary",
  );
  expect(countDeclaredPrimary(section)).toBe(0);
});

/**
 * **【`V20-M2-T02`。旧テスト名(逐語)】**
 * 「(b) 主は「書いた順の1番目」であって表示名でもフォームIDでもない(並べ替えると入れ替わる)」。
 * **旧は「並べ替えると主が入れ替わる」を固定していた。今日は並べ替えても主は入れ替わらない。**
 */
test("(b) 主は宣言したボタンであって並び順ではない(並べ替えても入れ替わらない)", async () => {
  const declared = { ...TO_SCOPED_FORM, action_emphasis: "primary" } as NonNullable<
    DetailView["actions"]
  >[number];
  await renderDetail(actionsManifest([declared, TO_PUBLIC_FORM]));
  expect(screen.getByTestId("action-origin-target-form").getAttribute("data-variant")).toBe(
    // 【V20-M9 / ADR-0474 §1-7】主の variant を "default" → "emphasis" に打ち直した。旧(逐語): "default",
    "emphasis",
  );
  expect(screen.getByTestId("action-origin-entry-form").getAttribute("data-variant")).toBe(
    "secondary",
  );
  cleanup();
  await renderDetail(actionsManifest([TO_PUBLIC_FORM, declared]));
  expect(screen.getByTestId("action-origin-target-form").getAttribute("data-variant")).toBe(
    // 【V20-M9 / ADR-0474 §1-7】主の variant を "default" → "emphasis" に打ち直した。旧(逐語): "default",
    "emphasis",
  );
  expect(screen.getByTestId("action-origin-entry-form").getAttribute("data-variant")).toBe(
    "secondary",
  );
});

/**
 * **【`V20-M2-T03` (a)。完了条件2】** **旧テスト名(逐語)**:
 * 「(b) 3件以上でも主は1番目の1つだけである(2つ目を主にする手段は無い)」。
 * **旧は「2つ目を主にする手段は無い」を固定していた。今日は並び順を変えずに2番目を主にできる。**
 */
test("(b) 並び順を変えずに、3件のうち2番目だけを主にできる", async () => {
  await renderDetail(
    actionsManifest([
      TO_SCOPED_FORM,
      { ...TO_PUBLIC_FORM, action_emphasis: "primary" },
      { form: "target-form", prefill: { field: "parent" }, name: "もう一度" },
    ] as NonNullable<DetailView["actions"]>),
  );
  const buttons = screen.getAllByTestId(/^action-origin-/);
  expect(buttons).toHaveLength(3);
  // **並びは書いた順のまま**(1番目 target-form / 2番目 entry-form / 3番目 target-form)。
  expect(buttons.map((node) => node.getAttribute("data-testid"))).toEqual([
    "action-origin-target-form",
    "action-origin-entry-form",
    "action-origin-target-form",
  ]);
  expect(buttons.map((node) => node.getAttribute("data-variant"))).toEqual([
    "secondary",
    // 【V20-M9 / ADR-0474 §1-7】主の variant を "default" → "emphasis" に打ち直した。旧(逐語): "default",
    "emphasis",
    "secondary",
  ]);
});

// ---------------------------------------------------------------------------
// (T03-a) 主・副・危険の3通りが別の data-variant になる。3形すべてで宣言を読む
// ---------------------------------------------------------------------------

test("(T03-a) 主・副・危険・宣言なしが、default / secondary / destructive / secondary に描き分けられる", async () => {
  const section = await renderDetail(
    actionsManifest([
      { ...TO_PUBLIC_FORM, action_emphasis: "primary" },
      { ...TO_SCOPED_FORM, action_emphasis: "secondary" },
      {
        form: "target-form",
        prefill: { field: "parent" },
        name: "捨てる",
        action_emphasis: "danger",
      },
      { form: "target-form", prefill: { field: "parent" }, name: "書かない" },
    ] as NonNullable<DetailView["actions"]>),
  );
  // 【V20-M9 / ADR-0474 §1-7】主の variant を "default" → "emphasis" に打ち直した。旧(逐語): expect(variantsOf(section)).toEqual(["default", "secondary", "destructive", "secondary"]);
  expect(variantsOf(section)).toEqual(["emphasis", "secondary", "destructive", "secondary"]);
  expect(new Set(variantsOf(section).slice(0, 3)).size).toBe(3);
});

test("(T03-a) 値の書換(set)と自動処理の起動(run)の形も、同じ対応で宣言を読む", async () => {
  const section = await renderDetail(
    threeShapeManifest([
      { set: { field: "st_public", value: true }, name: "公開する", action_emphasis: "primary" },
      { run: "notify", name: "知らせる", action_emphasis: "danger" },
      { set: { field: "st_public", value: false }, name: "非公開にする" },
      { run: "notify", name: "もう一度知らせる", action_emphasis: "secondary" },
    ] as NonNullable<DetailView["actions"]>),
  );
  // 【V20-M9 / ADR-0474 §1-7】主の variant を "default" → "emphasis" に打ち直した。旧(逐語): expect(variantsOf(section)).toEqual(["default", "destructive", "secondary", "secondary"]);
  expect(variantsOf(section)).toEqual(["emphasis", "destructive", "secondary", "secondary"]);
});

// ---------------------------------------------------------------------------
// (c) 1番目が絞り落とされたとき、2番目は繰り上がらない(`V20-M2-T02` (d))
// ---------------------------------------------------------------------------

// =====================================================================================
// **【`V8-M27-T04` / `T-G5`。2本とも期待値を反転させた。旧のテスト名と旧の期待値を
//   逐語で残す。検査は1本も消していない】**
//
// **旧のテスト名と旧の期待値**:
//   `(c) 1番目がロールで絞り落とされた画面では、残った2番目は主にならない`
//       // customer から見ると `entry-form`(public テーブル)は書けないので落ちる(`B-G3`)。
//       expect(buttons).toHaveLength(1);
//       expect(buttons[0]?.getAttribute("data-testid")).toBe("action-origin-target-form");
//       expect(buttons[0]?.getAttribute("data-variant")).toBe("secondary");
//       expect(... data-variant === "default" ...).toHaveLength(0);
//   `(c) 1番目が残る画面では、絞り込みの後でもその1番目が主である`
//       expect(buttons).toHaveLength(1);
//       expect(buttons[0]?.getAttribute("data-variant")).toBe("default");
//
// **根拠**: **`V8-M27` / 台帳 `T-G5` / ユーザ決定 `D-V8-38`。**
// **`B-G3`(操作起点の書込権限を遷移先フォームの表で判定する)そのものは1バイトも
// 触っていない** —— **判定に使う `canWriteRole` から**表単位の枝**を撤去したので、
// **`customer` が公開テーブルの form へ書けないという前提が消えた。**
// **したがって「1番目が絞り落とされる」という状況を、この題材ではもう作れない。**
//
// **(c) 群の主題(「絞り落とされても2番目は繰り上がらない」)を測る材料は
// この題材から消えた** —— **代わりに、絞り込みが1件も起きないこと(2件とも出て、
// 1番目だけが主であること)を測る。** **繰り上げの規則そのものは (a) / (b) 群が測っている。**
//
// **【`V20-M2-T02`。2026-09-24 に追記。上の文は1バイトも消していない】**
// **上の「1番目だけが主」は今日から偽である** —— **宣言が無ければ2件とも副である。**
// **「この題材ではもう作れない」は今日も真だが、ボタンの識別子(`id`)と役割の規則
// (`target: "action"`)を使えば、1番目を役割で絞り落とす状況を作れる**(下の (c-d) の2本)。
// =====================================================================================

/**
 * **【`V20-M2-T02`。旧テスト名(逐語)】**
 * 「(c の反転) customer でも公開テーブルの操作起点は落ちない(2件とも出て、1番目だけが主)」。
 */
test("(c の反転) customer でも公開テーブルの操作起点は落ちない(2件とも出て、宣言が無いので2件とも副)", async () => {
  await renderDetail(actionsManifest([TO_PUBLIC_FORM, TO_SCOPED_FORM]), CUSTOMER_ROLE);
  const buttons = screen.getAllByTestId(/^action-origin-/);
  expect(buttons).toHaveLength(2);
  expect(buttons.map((node) => node.getAttribute("data-variant"))).toEqual([
    "secondary",
    "secondary",
  ]);
});

/**
 * **【`V20-M2-T02`。旧テスト名(逐語)】**
 * 「(c の反転) 並びを入れ替えても、主になるのは1番目だけである」。
 */
test("(c の反転) customer でも、主になるのは宣言したボタンだけである(並びに依らない)", async () => {
  await renderDetail(
    actionsManifest([
      TO_SCOPED_FORM,
      { ...TO_PUBLIC_FORM, action_emphasis: "primary" },
    ] as NonNullable<DetailView["actions"]>),
    CUSTOMER_ROLE,
  );
  const buttons = screen.getAllByTestId(/^action-origin-/);
  expect(buttons).toHaveLength(2);
  expect(buttons[0]?.getAttribute("data-variant")).toBe("secondary");
  // 【V20-M9 / ADR-0474 §1-7】主の variant を "default" → "emphasis" に打ち直した。旧(逐語): expect(buttons[1]?.getAttribute("data-variant")).toBe("default");
  expect(buttons[1]?.getAttribute("data-variant")).toBe("emphasis");
});

/**
 * **1番目を役割で絞り落とす題材**: 2つのボタンに識別子を付け、owner には2つとも、
 * customer には2番目だけを見せる規則(`target: "action"` × `read`)を足す。
 */
function roleDroppedManifest(first: object, second: object): Manifest {
  return grantRules(
    grantRules(
      actionsManifest([
        { ...TO_PUBLIC_FORM, id: "first", ...first },
        { ...TO_SCOPED_FORM, id: "second", ...second },
      ] as NonNullable<DetailView["actions"]>),
      ["owner"],
      [actionRead("entry-detail", "first"), actionRead("entry-detail", "second")],
    ),
    ["customer"],
    [actionRead("entry-detail", "second")],
  );
}

test("(c-d) 主と宣言した1番目が役割で絞り落とされても、宣言の無い2番目は主に繰り上がらない", async () => {
  const section = await renderDetail(
    roleDroppedManifest({ action_emphasis: "primary" }, {}),
    CUSTOMER_ROLE,
  );
  const buttons = screen.getAllByTestId(/^action-origin-/);
  expect(buttons.map((node) => node.getAttribute("data-testid"))).toEqual([
    "action-origin-target-form",
  ]);
  expect(buttons[0]?.getAttribute("data-variant")).toBe("secondary");
  expect(countDeclaredPrimary(section)).toBe(0);
  cleanup();
  // **対照**: owner には2つとも出て、宣言した1番目だけが主である。
  const ownerSection = await renderDetail(roleDroppedManifest({ action_emphasis: "primary" }, {}));
  // 【V20-M9 / ADR-0474 §1-7】主の variant を "default" → "emphasis" に打ち直した。旧(逐語): expect(variantsOf(ownerSection)).toEqual(["default", "secondary"]);
  expect(variantsOf(ownerSection)).toEqual(["emphasis", "secondary"]);
});

test("(c-d) 1番目が絞り落とされても、主と宣言した2番目は主のまま描かれる(各ボタンは自分の宣言だけで決まる)", async () => {
  const section = await renderDetail(
    roleDroppedManifest({}, { action_emphasis: "primary" }),
    CUSTOMER_ROLE,
  );
  // 【V20-M9 / ADR-0474 §1-7】主の variant を "default" → "emphasis" に打ち直した。旧(逐語): expect(variantsOf(section)).toEqual(["default"]);
  expect(variantsOf(section)).toEqual(["emphasis"]);
});

// ---------------------------------------------------------------------------
// (d) actions を持たない画面の DOM が1バイトも変わらない / 宣言の無い画面は主が消えるぶんだけ変わる
// ---------------------------------------------------------------------------

/**
 * **`actions` を持たない `detail_view` の描画**(`V4-M16-T12` 着手時に、**実装を1バイトも
 * 入れる前に**取った DOM そのもの)。**`web/test/detail-field-grouping.test.tsx` の (h) と
 * 同じフィクスチャを共有する** —— **同じ DOM を2つの記録に分けて持たないため**であり、
 * **本タスクがそのファイルを書き換えていないことの証明も兼ねる。**
 */
const PLAIN_DETAIL_HTML = readFileSync(
  join(ROOT, "web", "test", "__fixtures__", "detail-view-plain.html"),
  "utf8",
).trim();

/**
 * **宣言の無いボタン2つを持つ詳細画面の描画を、`DetailViewRenderer.tsx` を書き換える
 * 前に取った DOM**(`V20-M2-T03` (d)。題材は `actionsManifest([TO_PUBLIC_FORM, TO_SCOPED_FORM])`、
 * 役割は owner)。**着手前は1番目が `default`(主)、2番目が `secondary`(副)である。**
 */
const UNDECLARED_BEFORE_HTML = readFileSync(
  join(ROOT, "web", "test", "__fixtures__", "detail-view-actions-undeclared-before.html"),
  "utf8",
).trim();

test("(d) actions を持たない detail_view の DOM が着手前と完全一致する", async () => {
  const section = await renderDetail(plainManifest());
  expect(section.outerHTML).toBe(PLAIN_DETAIL_HTML);
  // 器そのものが出ない(当たり先の無い器を DOM に置かない = 既存の作法)。
  expect(screen.queryByTestId("detail-action-origins")).toBeNull();
});

test("(d) 宣言の無い画面の DOM は、1番目のボタンの data-variant と class の2属性だけが着手前と違う", async () => {
  const section = await renderDetail(actionsManifest([TO_PUBLIC_FORM, TO_SCOPED_FORM]));
  const after = section.outerHTML;
  expect(after).not.toBe(UNDECLARED_BEFORE_HTML);
  // **着手前の DOM から、1番目のボタンの2属性だけを取り出す。**
  const holder = document.createElement("div");
  holder.innerHTML = UNDECLARED_BEFORE_HTML;
  const beforeFirst = holder.querySelector('[data-testid="action-origin-entry-form"]');
  expect(beforeFirst?.getAttribute("data-variant")).toBe("default");
  // **今日の DOM の1番目のボタンに、その2属性だけを戻すと、着手前と1バイトも違わない。**
  const first = section.querySelector('[data-testid="action-origin-entry-form"]');
  expect(first?.getAttribute("data-variant")).toBe("secondary");
  first?.setAttribute("data-variant", beforeFirst?.getAttribute("data-variant") ?? "");
  first?.setAttribute("class", beforeFirst?.getAttribute("class") ?? "");
  expect(section.outerHTML).toBe(UNDECLARED_BEFORE_HTML);
});

// 【V20-M9 / ADR-0474 §Decision 1-7】主を新しい variant `emphasis`(地色 primary_fill・文字色 on_primary)で描くように
// なったので、DOM は「1番目のボタンの data-variant と class の2属性」だけが着手前と違う。**平常時の計算後の見た目は
// 既定値(#fff / #000)のまま今日と同じ**である(chromium の実測は `web/e2e/action-emphasis.e2e.ts` の (iii))。
// hover / active の見た目は変わる(地色は白のまま枠線が本文の文字色になる。ADR-0474 §6 の 5)。テスト名は引き直しの前の逐語。
// 旧(逐語): `expect(section.outerHTML).toBe(UNDECLARED_BEFORE_HTML);`
test("(d) 1番目に primary と書けば、着手前の見た目(DOM)に1バイト違わず戻せる", async () => {
  // **持ち主は `action_emphasis` を書くことで、反転前と同じ見た目に戻せる**(`ADR-0459` 限定5)。
  const section = await renderDetail(
    actionsManifest([
      { ...TO_PUBLIC_FORM, action_emphasis: "primary" },
      TO_SCOPED_FORM,
    ] as NonNullable<DetailView["actions"]>),
  );
  const holder = document.createElement("div");
  holder.innerHTML = UNDECLARED_BEFORE_HTML;
  const beforeFirst = holder.querySelector('[data-testid="action-origin-entry-form"]');
  const first = section.querySelector('[data-testid="action-origin-entry-form"]');
  expect(first?.getAttribute("data-variant")).toBe("emphasis");
  expect(first?.getAttribute("class")).toContain("bg-primary-fill");
  expect(first?.getAttribute("class")).toContain("text-on-primary");
  first?.setAttribute("data-variant", beforeFirst?.getAttribute("data-variant") ?? "");
  first?.setAttribute("class", beforeFirst?.getAttribute("class") ?? "");
  expect(section.outerHTML).toBe(UNDECLARED_BEFORE_HTML);
});

test("(d) 編集/削除のボタンの variant を1バイトも変えていない", async () => {
  // **編集ボタンは今日も `variant` 未指定(= `default`)、削除は `destructive`** である。
  // **主副の描き分けは操作起点(`actions`)にしか当たっていない。**
  // **【`V20-M2-T02`】宣言(主・危険)を書いても、組込のボタンには当たらない。**
  const manifest = actionsManifest([
    { ...TO_SCOPED_FORM, action_emphasis: "danger" },
    { ...TO_PUBLIC_FORM, action_emphasis: "primary" },
  ] as NonNullable<DetailView["actions"]>);
  await renderDetail(manifest);
  expect(screen.getByTestId("detail-edit").getAttribute("data-variant")).toBe("default");
  expect(screen.getByTestId("detail-delete").getAttribute("data-variant")).toBe("destructive");
});
