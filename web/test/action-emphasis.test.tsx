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
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { DetailView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";
import { grantRules, viewRead } from "./role-rules.ts";

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
// (a) 1件のとき、そのボタンは主(default)である
// ---------------------------------------------------------------------------

/**
 * **`data-variant` を見る**(className ではなく)。**`web/src/ui/button.tsx` が
 * `data-variant` を必ず出しており**(`web/test/__fixtures__/detail-view-plain.html` の
 * 削除ボタンに `data-variant="destructive"` が実在する = 着手前に取った DOM で実測済み)、
 * **className は `cva` が組む長い字面なので、そちらを主の根拠にしない。**
 * **className も一応見る**((a) の2本目)—— 属性だけが合っていて見た目が変わらない、
 * という壊れ方を素通りさせないため。
 */
test("(a) 操作起点が1件のとき、そのボタンは主(data-variant=default)である", async () => {
  await renderDetail(actionsManifest([TO_SCOPED_FORM]));
  const button = screen.getByTestId("action-origin-target-form");
  expect(button.getAttribute("data-variant")).toBe("default");
});

test("(a) 主のボタンの className は副のそれと実際に違う(属性だけの差にしない)", async () => {
  const solo = await renderDetail(actionsManifest([TO_SCOPED_FORM]));
  const primaryClass = solo.querySelector('[data-testid="action-origin-target-form"]')?.className;
  cleanup();
  const pair = await renderDetail(actionsManifest([TO_PUBLIC_FORM, TO_SCOPED_FORM]));
  const secondaryClass = pair.querySelector('[data-testid="action-origin-target-form"]')?.className;
  expect(primaryClass).not.toBe(secondaryClass);
  // **`web/src/ui/button.tsx` の既存5値のうち2つを選んでいるだけである**(新しい variant を
  // 1つも作っていない)。**地色のクラスがそれぞれの variant のものになっている。**
  expect(primaryClass).toContain("bg-background");
  expect(secondaryClass).toContain("bg-secondary");
});

// ---------------------------------------------------------------------------
// (b) 2件のとき、1番目だけが主
// ---------------------------------------------------------------------------

test("(b) 操作起点が2件のとき、1番目だけが主で2番目は副である", async () => {
  await renderDetail(actionsManifest([TO_PUBLIC_FORM, TO_SCOPED_FORM]));
  expect(screen.getByTestId("action-origin-entry-form").getAttribute("data-variant")).toBe(
    "default",
  );
  expect(screen.getByTestId("action-origin-target-form").getAttribute("data-variant")).toBe(
    "secondary",
  );
});

test("(b) 主は「書いた順の1番目」であって表示名でもフォームIDでもない(並べ替えると入れ替わる)", async () => {
  await renderDetail(actionsManifest([TO_SCOPED_FORM, TO_PUBLIC_FORM]));
  expect(screen.getByTestId("action-origin-target-form").getAttribute("data-variant")).toBe(
    "default",
  );
  expect(screen.getByTestId("action-origin-entry-form").getAttribute("data-variant")).toBe(
    "secondary",
  );
});

test("(b) 3件以上でも主は1番目の1つだけである(2つ目を主にする手段は無い)", async () => {
  await renderDetail(
    actionsManifest([
      TO_SCOPED_FORM,
      TO_PUBLIC_FORM,
      { form: "target-form", prefill: { field: "parent" }, name: "もう一度" },
    ] as NonNullable<DetailView["actions"]>),
  );
  const buttons = screen.getAllByTestId(/^action-origin-/);
  expect(buttons).toHaveLength(3);
  expect(buttons.map((node) => node.getAttribute("data-variant"))).toEqual([
    "default",
    "secondary",
    "secondary",
  ]);
});

// ---------------------------------------------------------------------------
// (c) 1番目が絞り落とされたとき、2番目は繰り上がらない(**意図した挙動**)
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
// =====================================================================================
test("(c の反転) customer でも公開テーブルの操作起点は落ちない(2件とも出て、1番目だけが主)", async () => {
  await renderDetail(actionsManifest([TO_PUBLIC_FORM, TO_SCOPED_FORM]), CUSTOMER_ROLE);
  const buttons = screen.getAllByTestId(/^action-origin-/);
  expect(buttons).toHaveLength(2);
  expect(buttons.map((node) => node.getAttribute("data-variant"))).toEqual([
    "default",
    "secondary",
  ]);
});

test("(c の反転) 並びを入れ替えても、主になるのは1番目だけである", async () => {
  await renderDetail(actionsManifest([TO_SCOPED_FORM, TO_PUBLIC_FORM]), CUSTOMER_ROLE);
  const buttons = screen.getAllByTestId(/^action-origin-/);
  expect(buttons).toHaveLength(2);
  expect(buttons[0]?.getAttribute("data-variant")).toBe("default");
  expect(buttons[1]?.getAttribute("data-variant")).toBe("secondary");
});

// ---------------------------------------------------------------------------
// (d) actions を持たない画面の DOM が1バイトも変わらない
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

test("(d) actions を持たない detail_view の DOM が着手前と完全一致する", async () => {
  const section = await renderDetail(plainManifest());
  expect(section.outerHTML).toBe(PLAIN_DETAIL_HTML);
  // 器そのものが出ない(当たり先の無い器を DOM に置かない = 既存の作法)。
  expect(screen.queryByTestId("detail-action-origins")).toBeNull();
});

test("(d) 編集/削除のボタンの variant を1バイトも変えていない", async () => {
  // **編集ボタンは今日も `variant` 未指定(= `default`)、削除は `destructive`** である。
  // **主副の描き分けは操作起点(`actions`)にしか当たっていない。**
  const manifest = actionsManifest([TO_SCOPED_FORM]);
  await renderDetail(manifest);
  expect(screen.getByTestId("detail-edit").getAttribute("data-variant")).toBe("default");
  expect(screen.getByTestId("detail-delete").getAttribute("data-variant")).toBe("destructive");
});
