/**
 * **順番の決まった流れの段として宣言された入力画面に、「戻る」の既定の導線を1つ置く**
 * (`V10-M5-T01`)。
 *
 * ## この検査が言えないこと(**先に書く。誇張しない**)
 *
 * 1. **happy-dom であって chromium ではない。** **見た目を1ピクセルも見ていない** ——
 *    ボタンがどこに置かれ、どんな大きさで、実際に押せる位置に在るかを1つも測っていない。
 *    (chromium の実測は `web/e2e/flow-steps.e2e.ts` が2本だけ持つ。)
 * 2. **戻った先に何が在るかを1度も見ていない。** **測っているのは
 *    `window.history.back` が呼ばれたことだけである** —— **履歴に前の項目が無ければ
 *    ブラウザは何もしないが、その「何も起きない」をこのファイルは1件も再現していない。**
 * 3. **`fetch` を差し替えている。本物のサーバを1度も叩いていない** ——
 *    **その画面をサーバが本当に配るか / 書込が本当に成立するかは1件も測っていない。**
 * 4. **【禁止】「前の段へ必ず戻れる」と読まない** —— **行き先は履歴であって、
 *    段の並びではない。** **段1 の「戻る」は流れの外へ出る**((e-1) がそれを固定する)。
 * 5. **【禁止】「戻り先をアプリが決められるようになった」と読まない** ——
 *    **戻り先を宣言する口を1つも作っていない**((f-2) が、行き先を選ぶ `a` が
 *    0件であることだけを固定する)。
 * 6. **【禁止】「UI が出さない = 遮断」と読まない。** 遮断はサーバの 401 / 403 / 404 である。
 *
 * ## **【2026-08-21 追記(`V10-M18-T03` / `FU-G3`)。上の行を1バイトも消していない】**
 *
 * **「戻る」は入力画面(`form`)だけのものではなくなった** —— **段を宣言した
 * `list_view` / `detail_view` にも出る。** **実装は `web/src/views/ViewHost.tsx` の
 * 1本だけであり、`web/src/views/FormRenderer.tsx` からは撤去した。**
 * **見出しの `入力画面に` の逐語は着手時点の記述として残してある。**
 *
 * **この移送で DOM が2点変わった**(**どちらも下の (g-2) / (g-3) が固定する**):
 *
 * 1. **`flow-back` が `<section data-testid="view-renderer-form">` の**外**へ出た。**
 * 2. **入力画面が「読み込み中…」の間にも出るようになった**(移送前は出なかった)。
 *
 * **`modal: true` の画面に出さないことは移送後も変わっていない**((c-1))。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { Manifest, View } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { ViewHost } from "../src/views/ViewHost.tsx";
import { grantRules, viewRead } from "./role-rules.ts";

/**
 * **書ける立場**(`web/test/flow-next-step.test.tsx` と1バイトも同じ理由)——
 * **文字列リテラルで `role="owner"` と書くと biome の a11y 規則(`useValidAriaRole`)が
 * HTML の `role` 属性と誤認するので、変数経由で渡す。**
 */
const WRITER_ROLE: Role = "owner";

const APP_ID = "shop";
const ORDERS_PATH = `/api/apps/${APP_ID}/tables/orders/records`;
const RECORD_ID = "order-0001";
const CREATED_ID = "order-0002";

const ORDER_ROW = {
  _id: RECORD_ID,
  _created_at: "2026-01-01T00:00:00Z",
  _updated_at: "2026-01-02T00:00:00Z",
  memo: "既存",
};
const CREATED_ROW = {
  _id: CREATED_ID,
  _created_at: "2026-01-03T00:00:00Z",
  _updated_at: "2026-01-03T00:00:00Z",
  memo: "机",
};

let originalFetch: typeof fetch;
/** **この検査の中で `fetch` が呼ばれた回数**((a-3) が「保存が走らない」を数えるのに使う)。 */
let fetchCalls: string[] = [];

// ---------------------------------------------------------------------------
// 題材
// ---------------------------------------------------------------------------

/** 種別ごとの必須キーだけを補う(**`flow` は呼び出し側がそのまま書く**)。 */
function viewSpec(spec: Record<string, unknown>): Record<string, unknown> {
  const filled: Record<string, unknown> = { table: "orders", ...spec };
  if (filled.type === "list_view" && filled.columns === undefined) {
    filled.columns = ["memo"];
  }
  if (filled.type === "form" && filled.fields === undefined) {
    filled.fields = ["memo"];
  }
  if (filled.type === "report_view" && filled.report === undefined) {
    filled.report = { group_by: [{ field: "memo" }], aggregates: [{ type: "count" }] };
  }
  return filled;
}

/** **役割の規則を1本も持たない題材**(面の既定は閉じているので、そのままでは画面が開かない)。 */
function build(specs: readonly Record<string, unknown>[]): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "店",
      tables: [
        { id: "orders", name: "注文", fields: [{ id: "memo", name: "メモ", type: "text" }] },
      ],
      views: specs.map(viewSpec),
    },
  } as unknown as Manifest;
}

/** 全画面の読取を `owner` に配る(**これが無いと画面が1つも描かれない**)。 */
function grantAll(manifest: Manifest): Manifest {
  return grantRules(
    manifest,
    [WRITER_ROLE],
    manifest.app.views.map((view) => viewRead(view.id)),
  );
}

function viewOf(manifest: Manifest, viewId: string): View {
  const view = manifest.app.views.find((candidate) => candidate.id === viewId);
  if (view === undefined) {
    throw new Error("fixture broken");
  }
  return view;
}

beforeEach(() => {
  fetchCalls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    fetchCalls.push(`${method} ${url}`);
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (method === "POST" && url === ORDERS_PATH) {
      return json({ record: CREATED_ROW }, 201);
    }
    if (url.includes("/report")) {
      return json({ groups: [], total_groups: 0, totals: [{ type: "count", value: 0 }] });
    }
    if (method === "GET" && url.startsWith(`${ORDERS_PATH}/${RECORD_ID}`)) {
      return json({ record: ORDER_ROW });
    }
    if (method === "GET" && url.startsWith(ORDERS_PATH)) {
      return json({ records: [ORDER_ROW], total: 1 });
    }
    return json({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/address`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function renderHost(manifest: Manifest, viewId: string, recordId?: string): HTMLElement {
  const result = render(
    <RoleProvider role={WRITER_ROLE}>
      <ViewHost
        appId={APP_ID}
        manifest={manifest}
        view={viewOf(manifest, viewId)}
        recordId={recordId}
      />
    </RoleProvider>,
  );
  return result.container;
}

/** `window.history.back` を数える器(**押した回数だけを見る**)。 */
async function countingBack(body: () => Promise<void> | void): Promise<number> {
  const calls: number[] = [];
  const original = window.history.back;
  (window.history as { back: () => void }).back = () => {
    calls.push(1);
  };
  try {
    await body();
  } finally {
    (window.history as { back: () => void }).back = original;
  }
  return calls.length;
}

// ---------------------------------------------------------------------------
// (a) 段を宣言した `form` に、既定で「戻る」が1つ出る
// ---------------------------------------------------------------------------

test("(a-1) 段を宣言した form に flow-back と flow-back-button がちょうど1つずつ出る", async () => {
  const manifest = grantAll(
    build([
      { id: "cart", type: "list_view", flow: { id: "checkout", step: 1, kind: "input" } },
      { id: "address", type: "form", flow: { id: "checkout", step: 2, kind: "input" } },
    ]),
  );
  renderHost(manifest, "address");
  await screen.findByLabelText(/メモ/);
  expect(screen.getAllByTestId("flow-back")).toHaveLength(1);
  expect(screen.getAllByTestId("flow-back-button")).toHaveLength(1);
  // **文言はリテラル1つである**(マニフェストから1文字も取っていない)。
  expect(screen.getByTestId("flow-back-button").textContent).toBe("戻る");
});

test("(a-2) 押すと window.history.back がちょうど1回呼ばれる", async () => {
  const manifest = grantAll(
    build([{ id: "address", type: "form", flow: { id: "checkout", step: 2, kind: "input" } }]),
  );
  renderHost(manifest, "address");
  await screen.findByLabelText(/メモ/);
  const calls = await countingBack(() => {
    screen.getByTestId("flow-back-button").click();
  });
  expect(calls).toBe(1);
});

test("(a-3) 戻るは type=button であり、押しても fetch が1度も呼ばれない(保存が走らない)", async () => {
  const manifest = grantAll(
    build([{ id: "address", type: "form", flow: { id: "checkout", step: 2, kind: "input" } }]),
  );
  renderHost(manifest, "address");
  await screen.findByLabelText(/メモ/);
  const button = screen.getByTestId("flow-back-button") as HTMLButtonElement;
  expect(button.getAttribute("type")).toBe("button");
  const before = fetchCalls.length;
  await countingBack(() => {
    button.click();
  });
  // **待ってから数える**(送信が非同期に飛んでいないことを見るため)。
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(fetchCalls.slice(before)).toEqual([]);
});

// ---------------------------------------------------------------------------
// (b) 段を宣言していない `form` は今日と1バイトも変わらない
// ---------------------------------------------------------------------------

test("(b-1) 段を宣言していない form には flow-back が1つも出ない", async () => {
  const manifest = grantAll(build([{ id: "address", type: "form" }]));
  renderHost(manifest, "address");
  await screen.findByLabelText(/メモ/);
  expect(screen.queryByTestId("flow-back")).toBeNull();
  expect(screen.queryByTestId("flow-back-button")).toBeNull();
});

test("(b-2) 段の宣言だけを外した form の DOM は、はじめから段を持たない form と1バイトも変わらない", async () => {
  const withFlow: Record<string, unknown> = {
    id: "address",
    type: "form",
    flow: { id: "checkout", step: 2, kind: "input" },
  };
  // **同じ題材から段の宣言だけを外す**(他のキーを1つも動かさない)。
  const stripped: Record<string, unknown> = { ...withFlow };
  delete stripped.flow;

  /**
   * **【2026-08-21 変更(`V10-M18-T03`)】** **器そのものの HTML を比べる。**
   * **移送前は `<section data-testid="view-renderer-form">` の中だけを比べていたが、
   * 「戻る」がその外へ出たので、中だけを見ると段を宣言した版と素の版が同じに見える** ——
   * **裏取りの `not.toBe` が空回りする**(そう書いて実際に緑のまま通った)。
   */
  async function formHtml(spec: Record<string, unknown>): Promise<string> {
    const container = renderHost(grantAll(build([spec])), "address");
    await screen.findByLabelText(/メモ/);
    if (container.querySelector('[data-testid="view-renderer-form"]') === null) {
      throw new Error("form が描かれていない");
    }
    const html = container.innerHTML;
    cleanup();
    return html;
  }

  const strippedHtml = await formHtml(stripped);
  const plainHtml = await formHtml({ id: "address", type: "form" });
  expect(strippedHtml).toBe(plainHtml);
  // **比較が空回りしていないことの裏取り** —— 段を宣言した版は、この2つと違う。
  const flowHtml = await formHtml(withFlow);
  expect(flowHtml).not.toBe(plainHtml);
});

// ---------------------------------------------------------------------------
// (c) 重ねて出す画面には出さない
// ---------------------------------------------------------------------------

test("(c-1) modal: true の form には、段を宣言していても出ない", async () => {
  const manifest = grantAll(
    build([
      {
        id: "address",
        type: "form",
        modal: true,
        menu_listed: false,
        flow: { id: "checkout", step: 2, kind: "input" },
      },
    ]),
  );
  renderHost(manifest, "address");
  await screen.findByLabelText(/メモ/);
  expect(screen.queryByTestId("flow-back")).toBeNull();
});

// ---------------------------------------------------------------------------
// (d) どの種別に出て、どの種別に出ないか
//
// **【2026-08-21 に split した(`V10-M18-T03` / `FU-G3`)】**
// **旧の1本の名前を逐語で控える**:
//   `(d-1) list_view / detail_view / report_view には、段を宣言していても出ない`
// **その3つのうち `report_view` の部分だけが今日も真である** —— 下の (d-1) がそれを
// 引き継ぎ、`list_view` / `detail_view` は (d-2) / (d-3) / (d-4) で**出ること**を固定する。
// ---------------------------------------------------------------------------

test("(d-1) report_view には、段を宣言していても出ない", async () => {
  // **`report_view` に `flow` は書けない**(`schemas/` が `false` で閉じている)——
  // **それでも表示層が段を読めない種別で何も出さないことを直接見る。**
  const report = grantAll(
    build([{ id: "rep", type: "report_view", flow: { id: "checkout", step: 1, kind: "input" } }]),
  );
  renderHost(report, "rep");
  await waitFor(() => expect(screen.getByTestId("view-renderer-report_view")).toBeDefined());
  expect(screen.queryByTestId("flow-back")).toBeNull();
});

test("(d-2) 段を宣言した list_view に flow-back がちょうど1つ出る", async () => {
  const manifest = grantAll(
    build([{ id: "cart", type: "list_view", flow: { id: "checkout", step: 1, kind: "input" } }]),
  );
  renderHost(manifest, "cart");
  await waitFor(() => expect(screen.getByTestId("view-renderer-list_view")).toBeDefined());
  expect(screen.getAllByTestId("flow-back")).toHaveLength(1);
  expect(screen.getByTestId("flow-back-button").textContent).toBe("戻る");
});

test("(d-3) 段を宣言した detail_view(kind: input)に flow-back がちょうど1つ出る", async () => {
  const manifest = grantAll(
    build([
      { id: "review", type: "detail_view", flow: { id: "checkout", step: 1, kind: "input" } },
    ]),
  );
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/review/records/${RECORD_ID}`);
  renderHost(manifest, "review", RECORD_ID);
  await waitFor(() => expect(screen.getByTestId("view-renderer-detail_view")).toBeDefined());
  expect(screen.getAllByTestId("flow-back")).toHaveLength(1);
});

test("(d-4) 段を宣言した detail_view(kind: confirm)にも flow-back が1つ出る(kind で分岐していない)", async () => {
  const manifest = grantAll(
    build([
      { id: "review", type: "detail_view", flow: { id: "checkout", step: 1, kind: "confirm" } },
    ]),
  );
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/review/records/${RECORD_ID}`);
  renderHost(manifest, "review", RECORD_ID);
  await waitFor(() => expect(screen.getByTestId("view-renderer-detail_view")).toBeDefined());
  expect(screen.getAllByTestId("flow-back")).toHaveLength(1);
});

test("(d-5) 段を宣言していない list_view / detail_view には出ない(既定を反転させていない)", async () => {
  const list = grantAll(build([{ id: "cart", type: "list_view" }]));
  renderHost(list, "cart");
  await waitFor(() => expect(screen.getByTestId("view-renderer-list_view")).toBeDefined());
  expect(screen.queryByTestId("flow-back")).toBeNull();
  cleanup();

  const detail = grantAll(build([{ id: "review", type: "detail_view" }]));
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/review/records/${RECORD_ID}`);
  renderHost(detail, "review", RECORD_ID);
  await waitFor(() => expect(screen.getByTestId("view-renderer-detail_view")).toBeDefined());
  expect(screen.queryByTestId("flow-back")).toBeNull();
});

test("(d-6) 段を宣言した list_view の「戻る」を押しても、window.history.back が1回だけである", async () => {
  const manifest = grantAll(
    build([{ id: "cart", type: "list_view", flow: { id: "checkout", step: 1, kind: "input" } }]),
  );
  renderHost(manifest, "cart");
  await waitFor(() => expect(screen.getByTestId("view-renderer-list_view")).toBeDefined());
  const calls = await countingBack(() => {
    screen.getByTestId("flow-back-button").click();
  });
  expect(calls).toBe(1);
});

// ---------------------------------------------------------------------------
// (e) 段1 でも出る(**段の位置で分岐していない**)
// ---------------------------------------------------------------------------

test("(e-1) 段1(step: 1)の form にも出る(段1 の「戻る」は流れの外へ出る)", async () => {
  const manifest = grantAll(
    build([{ id: "address", type: "form", flow: { id: "checkout", step: 1, kind: "input" } }]),
  );
  renderHost(manifest, "address");
  await screen.findByLabelText(/メモ/);
  expect(screen.getAllByTestId("flow-back")).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// (f) 語彙を1つも増やしていない
// ---------------------------------------------------------------------------

test("(f-1) 送信ボタンは今日も「保存」の1つで type=submit である(文言を宣言する口が増えていない)", async () => {
  const manifest = grantAll(
    build([{ id: "address", type: "form", flow: { id: "checkout", step: 1, kind: "input" } }]),
  );
  const container = renderHost(manifest, "address");
  await screen.findByLabelText(/メモ/);
  const form = container.querySelector("form") as HTMLFormElement;
  const submits = [...form.querySelectorAll("button")].filter(
    (button) => button.getAttribute("type") === "submit",
  );
  expect(submits).toHaveLength(1);
  expect(submits[0]?.textContent).toBe("保存");
});

test("(f-2) flow-back の内側に a 要素が0件である(行き先を選ぶ口を作っていない)", async () => {
  const manifest = grantAll(
    build([{ id: "address", type: "form", flow: { id: "checkout", step: 1, kind: "input" } }]),
  );
  renderHost(manifest, "address");
  await screen.findByLabelText(/メモ/);
  expect(screen.getByTestId("flow-back").querySelectorAll("a")).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// (g) 「前の段」を導く実装を1本も作っていない(**字面の走査**)
// ---------------------------------------------------------------------------

test("(g-1) web/src/views/flow.ts に step - 1 を探す実装が1つも無い", () => {
  const source = readFileSync(
    join(import.meta.dir, "..", "src", "views", "flow.ts"),
    "utf8",
  ) as string;
  expect(source.includes("step - 1")).toBe(false);
  expect(source.includes("step-1")).toBe(false);
  // **走査が空回りしていないことの裏取り** —— 「次の段」を導く実装は今日も在る。
  expect(source.includes("step + 1")).toBe(true);
});

// ---------------------------------------------------------------------------
// **移送で DOM が変わった2点**(`V10-M18-T03` / `FU-G3`。**隠さずに固定する**)
// ---------------------------------------------------------------------------

test("(g-2) form の flow-back は view-renderer-form の外に出る(並びは見出し → 位置 → 戻る → 本体)", async () => {
  const manifest = grantAll(
    build([{ id: "address", type: "form", flow: { id: "checkout", step: 1, kind: "input" } }]),
  );
  const container = renderHost(manifest, "address");
  await screen.findByLabelText(/メモ/);
  const section = container.querySelector('[data-testid="view-renderer-form"]');
  if (section === null) {
    throw new Error("form が描かれていない");
  }
  // **本体の中には1つも無い**(移送前はここに在った)。
  expect(section.querySelectorAll('[data-testid="flow-back"]')).toHaveLength(0);
  // **器の直接の子として、本体の1つ前に在る。**
  // **【2026-08-24。`V10-M11-T01` の2手目。台帳 `CM-G4` = 門外(`Δ7`)/ 限定採用】**
  // **器の子が末尾に1つ増えた** —— **画面へのコメントを1件書く導線(`comment-panel`)である。**
  // **旧の期待値(逐語。1バイトも消していない)**:
  //   `expect([...container.children].map((child) => child.getAttribute("data-testid"))).toEqual([`
  //   `  "view-title",`
  //   `  "flow-position",`
  //   `  "flow-back",`
  //   `  "view-renderer-form",`
  //   `]);`
  // **既存の並びは1つも動いていない** —— **足したのは末尾の1要素だけである。**
  // **未ログイン(`anonymous: true`)の枝では出ない**(`web/src/CommentPanel.tsx` の「誰に出すか」)。
  // **【2026-08-25。`V10-M31-T02`。台帳 `CM-G38` / `ADR-0379` 限定2 / 利用者決定 `D-V10-40`】**
  // **書く欄(`comment-panel`)はアプリごとの設定で出し入れするようになり、**既定は OFF**である。**
  // **この題材は設定を1度も触っていないので、末尾の1要素が出ない。**
  // **2026-08-24 の期待値(逐語。1バイトも消していない)**:
  //   `expect([...container.children].map((child) => child.getAttribute("data-testid"))).toEqual([`
  //   `  "view-title",`
  //   `  "flow-position",`
  //   `  "flow-back",`
  //   `  "view-renderer-form",`
  //   `  "comment-panel",`
  //   `]);`
  // **この検査が測っているのは「段の導線が器のどこに入るか」であり、書く欄の出入りではない**
  // (出入りそのものの実測は `web/test/comment-visibility-toggle.test.tsx` が持つ)。
  // **落ちたのは末尾の1要素だけで、既存の並びは1つも動いていない。**
  expect([...container.children].map((child) => child.getAttribute("data-testid"))).toEqual([
    "view-title",
    "flow-position",
    "flow-back",
    "view-renderer-form",
  ]);
});

test("(g-3) form が「読み込み中…」の間にも flow-back が出る(移送前は出なかった)", async () => {
  // **応答を返さない `fetch`** —— 既存の行を読みに行ったまま `loading` に留める。
  const held = globalThis.fetch;
  globalThis.fetch = (async () => await new Promise<Response>(() => {})) as unknown as typeof fetch;
  try {
    const manifest = grantAll(
      build([{ id: "address", type: "form", flow: { id: "checkout", step: 1, kind: "input" } }]),
    );
    window.history.replaceState({}, "", `/apps/${APP_ID}/views/address/records/${RECORD_ID}`);
    const container = renderHost(manifest, "address", RECORD_ID);
    const section = await waitFor(() => {
      const found = container.querySelector('[data-testid="view-renderer-form"]');
      if (found === null) {
        throw new Error("まだ描かれていない");
      }
      return found;
    });
    // **本体は「読み込み中…」のままである**(入力欄が1つも無い)。
    expect(section.textContent).toBe("読み込み中…");
    expect(container.querySelectorAll('[data-testid="flow-back"]')).toHaveLength(1);
  } finally {
    globalThis.fetch = held;
  }
});
