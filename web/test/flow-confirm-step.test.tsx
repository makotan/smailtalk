/**
 * **確認の段(`flow.kind: "confirm"`)の確定と、その後の行き先**(`V10-M4-T03`。`NV-G11` /
 * `ADR-0360` 限定1〜限定5 / `ADR-0359` §4b 限定5・限定7 / `ADR-0358` 限定2 /
 * `ADR-0102` 限定4・限定6・限定7 / `ADR-0357` 限定1・限定2)。
 *
 * ## この検査が言えないこと(**先に書く。誇張しない**)
 *
 * 1. **`fetch` を差し替えている。本物のサーバを1度も叩いていない** —— 見ているのは
 *    「表示層が 200 / 403 / 409 を受け取ったあとに何をするか」だけである。
 *    **書込が本当に成立したか / その画面をサーバが本当に配るかは1件も測っていない。**
 * 2. **happy-dom であり、ここでは chromium を1度も起こしていない。**
 *    **端から端まで実際に押す実測は `web/e2e/flow-steps.e2e.ts` の担当である**
 *    (`CP-V10` 条件2)。
 * 3. **【禁止】「確認の段が作れるようになった」と「注文が確かめられるようになった」を
 *    1つの文に書かない**(`ADR-0360` 限定7)。**【禁止】`E-G33` を「解けた」と書かない**
 *    —— **送信ボタンの文言を1ミリも解いていない**(`ADR-0102` 限定6 は今日も無傷であり、
 *    (i-2) がそれを測っている)。
 * 4. **【禁止】「確定の前に値を溜められる」と読まない** —— **溜める仕組みを1つも
 *    作っていない**(限定5。(j) が予約規約フィールドの本数で機械的に測る)。
 * 5. **限定2(`form` / `list_view` に `kind: "confirm"` を書けない)について、
 *    ここが測っているのは**スキーマの形が今日も閉じていること**だけである** ——
 *    **差分が実際に拒否される実出力は `src/kernel/view-flow.test.ts`(`V10-M4-T01`)が
 *    持つ。** **本ファイルは Ajv を1度も走らせていない。**
 * 6. **【禁止】「見えない段は遮断されている」と読まない** —— **UI が出さないことは
 *    遮断ではない。** 遮断はサーバの 401 / 403 / 404 である。
 * 7. **`run` 形の doc の逐語((d-3))は**文字列の走査**である** —— **逐語が残っている
 *    ことしか言えない。** **同じ意味を別の綴りで書いた場合も、意味が変わった場合も
 *    捕まえられない**(`verbatim-residue-fools-source-scanning-tests` の型)。
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import type { Manifest, View } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { ViewHost } from "../src/views/ViewHost.tsx";
import { grantRules, viewRead } from "./role-rules.ts";

/**
 * **書ける立場**(`web/test/detail-view-after-save.test.tsx` / `web/test/flow-next-step.test.tsx`
 * と1バイトも同じ理由)—— **文字列リテラルで `role="owner"` と書くと biome の a11y 規則
 * (`useValidAriaRole`)が HTML の `role` 属性と誤認するので、変数経由で渡す。**
 */
const WRITER_ROLE: Role = "owner";

const APP_ID = "shop";
const ORDERS_PATH = `/api/apps/${APP_ID}/tables/orders/records`;
const OTHERS_PATH = `/api/apps/${APP_ID}/tables/others/records`;
const RECORD_ID = "order-0001";
const CREATED_ID = "order-0002";

const ORDER_ROW = {
  _id: RECORD_ID,
  _created_at: "2026-01-01T00:00:00Z",
  _updated_at: "2026-01-02T00:00:00Z",
  memo: "既存",
  state: "受付",
};
const CREATED_ROW = {
  _id: CREATED_ID,
  _created_at: "2026-01-03T00:00:00Z",
  _updated_at: "2026-01-03T00:00:00Z",
  memo: "机",
  state: "受付",
};

/** 形 (ii): 値の書換。**確定はこの形で書く**(`ADR-0360` 限定3)。 */
const SET_ACTION = { set: { field: "state", value: "完了" }, name: "確定する" };
/** 形 (iv): 自動処理の起動。**段が宣言されていても次の段へ進まない**(`V10-M4` の決8)。 */
const RUN_ACTION = { run: "ship", name: "発送する" };

let originalFetch: typeof fetch;
let patchResponse: { status: number; body: unknown };
let patchCount: number;

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
  return filled;
}

function build(specs: readonly Record<string, unknown>[]): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "店",
      tables: [
        {
          id: "orders",
          name: "注文",
          fields: [
            { id: "memo", name: "メモ", type: "text" },
            { id: "state", name: "状態", type: "select", options: ["受付", "完了"] },
          ],
        },
        { id: "others", name: "別表", fields: [{ id: "memo", name: "メモ", type: "text" }] },
      ],
      views: specs.map(viewSpec),
      workflows: [
        {
          id: "ship",
          name: "発送する",
          trigger: { type: "manual", table: "orders" },
          actions: [{ action: "create_record", table: "others", values: { memo: "発送" } }],
          history_table: "others",
        },
      ],
    },
  } as unknown as Manifest;
}

/** 全画面の読取を配る(**面の既定は閉じているので、配らないと段が1つも出ない**)。 */
function grantAll(manifest: Manifest, role: string = WRITER_ROLE): Manifest {
  return grantRules(
    manifest,
    [role],
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
  patchCount = 0;
  patchResponse = {
    status: 200,
    body: { record: { ...ORDER_ROW, state: "完了", _updated_at: "2026-01-04T00:00:00Z" } },
  };
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (method === "PATCH") {
      patchCount += 1;
      return json(patchResponse.body, patchResponse.status);
    }
    if (method === "POST" && url.startsWith(`/api/apps/${APP_ID}/views/`)) {
      return json({ workflow: "ship", record: RECORD_ID, failures: [] });
    }
    if (method === "POST" && url === ORDERS_PATH) {
      return json({ record: CREATED_ROW }, 201);
    }
    /*
     * **`?view=<画面ID>` が付く**(題材が役割の規則を持つため。`web/src/api.ts` の名乗り)——
     * **完全一致で置くと単件の枝を素通りして一覧の枝に落ち、`record` が `undefined` になる**
     * (`V10-M4-T02` の報告 §6-2)。
     */
    if (method === "GET" && url.startsWith(`${ORDERS_PATH}/${RECORD_ID}`)) {
      return json({ record: ORDER_ROW });
    }
    if (method === "GET" && (url.startsWith(ORDERS_PATH) || url.startsWith(OTHERS_PATH))) {
      return json({ records: [ORDER_ROW], total: 1 });
    }
    return json({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

/** 詳細画面(器ごと)を描く。**URL も同時にその画面へ合わせる。** */
async function renderDetail(
  manifest: Manifest,
  viewId: string,
  recordId: string = RECORD_ID,
): Promise<string> {
  const here = `/apps/${APP_ID}/views/${viewId}/records/${recordId}`;
  window.history.replaceState({}, "", here);
  render(
    <RoleProvider role={WRITER_ROLE}>
      <ViewHost
        appId={APP_ID}
        manifest={manifest}
        view={viewOf(manifest, viewId)}
        recordId={recordId}
      />
    </RoleProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("detail-field-memo")).toBeDefined());
  return here;
}

/** `form` を描いて保存し、遷移後の URL(パス)を返す。 */
async function submit(manifest: Manifest, viewId: string): Promise<string> {
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/${viewId}`);
  render(
    <RoleProvider role={WRITER_ROLE}>
      <ViewHost appId={APP_ID} manifest={manifest} view={viewOf(manifest, viewId)} />
    </RoleProvider>,
  );
  const input = await screen.findByLabelText(/メモ/);
  fireEvent.change(input, { target: { value: "机" } });
  fireEvent.submit(input.closest("form") as HTMLFormElement);
  await waitFor(() => expect(window.location.pathname).not.toContain(viewId));
  return window.location.pathname;
}

// ---------------------------------------------------------------------------
// (a) 確認の段で `set` 形の確定を押すと、書込が成立したときだけ次の段へ進む
//     (`ADR-0360` 限定3・限定4 / `ADR-0359` §4b 限定5)
// ---------------------------------------------------------------------------

test("(a-1) kind: confirm の詳細画面で set 形を押すと、次の段へ進む", async () => {
  const manifest = grantAll(
    build([
      {
        id: "confirm",
        type: "detail_view",
        flow: { id: "checkout", step: 1, kind: "confirm" },
        actions: [SET_ACTION],
      },
      { id: "thanks", type: "list_view", flow: { id: "checkout", step: 2, kind: "input" } },
    ]),
  );
  await renderDetail(manifest, "confirm");
  screen.getByTestId("action-set-state").click();
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/thanks`);
  });
  expect(patchCount).toBe(1);
});

test("(a-2) after_save も書いてある確認の段では、段が勝つ", async () => {
  const manifest = grantAll(
    build([
      {
        id: "confirm",
        type: "detail_view",
        flow: { id: "checkout", step: 1, kind: "confirm" },
        after_save: "order-list",
        actions: [SET_ACTION],
      },
      { id: "thanks", type: "list_view", flow: { id: "checkout", step: 2, kind: "input" } },
      { id: "order-list", type: "list_view" },
    ]),
  );
  await renderDetail(manifest, "confirm");
  screen.getByTestId("action-set-state").click();
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/thanks`);
  });
  // **`after_save` の画面へは1度も行っていない。**
  expect(window.location.pathname).not.toContain("order-list");
});

test("(a-3) 次の段が同じ表の detail_view なら、開いていた行の _id を運ぶ", async () => {
  const manifest = grantAll(
    build([
      {
        id: "confirm",
        type: "detail_view",
        flow: { id: "checkout", step: 1, kind: "confirm" },
        actions: [SET_ACTION],
      },
      { id: "receipt", type: "detail_view", flow: { id: "checkout", step: 2, kind: "input" } },
    ]),
  );
  await renderDetail(manifest, "confirm");
  screen.getByTestId("action-set-state").click();
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/receipt/records/${RECORD_ID}`);
  });
});

test("(a-4) 次の段が別の表の detail_view なら _id は1文字も載らない", async () => {
  const manifest = grantAll(
    build([
      {
        id: "confirm",
        type: "detail_view",
        flow: { id: "checkout", step: 1, kind: "confirm" },
        actions: [SET_ACTION],
      },
      {
        id: "receipt",
        type: "detail_view",
        table: "others",
        flow: { id: "checkout", step: 2, kind: "input" },
      },
    ]),
  );
  await renderDetail(manifest, "confirm");
  screen.getByTestId("action-set-state").click();
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/receipt`);
  });
  expect(window.location.pathname).not.toContain("records");
});

test("(a-5) 段は URL に1文字も載らない(流れIDも位置も出ない)", async () => {
  const manifest = grantAll(
    build([
      {
        id: "confirm",
        type: "detail_view",
        flow: { id: "checkout", step: 1, kind: "confirm" },
        actions: [SET_ACTION],
      },
      { id: "thanks", type: "list_view", flow: { id: "checkout", step: 2, kind: "input" } },
    ]),
  );
  await renderDetail(manifest, "confirm");
  screen.getByTestId("action-set-state").click();
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/thanks`);
  });
  const url = new URL(window.location.href);
  expect(url.search).toBe("");
  expect(url.href).not.toContain("checkout");
  expect(url.href).not.toContain("step");
});

test("(a-6) 段の宣言は kind に関わらず1本の規則である(入力の段の詳細でも set で進む)", async () => {
  // **【正直に書く】これは `ADR-0360` が要求した挙動ではない** —— **`ADR-0359` §4b 限定5
  // の「宣言があれば段、無ければ規約」を1本の規則として実装した結果である**
  // (`kind` で2本目の規則を作っていない)。**実測をそのまま残す。**
  const manifest = grantAll(
    build([
      {
        id: "review",
        type: "detail_view",
        flow: { id: "checkout", step: 1, kind: "input" },
        actions: [SET_ACTION],
      },
      { id: "thanks", type: "list_view", flow: { id: "checkout", step: 2, kind: "input" } },
    ]),
  );
  await renderDetail(manifest, "review");
  screen.getByTestId("action-set-state").click();
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/thanks`);
  });
});

// ---------------------------------------------------------------------------
// (b) 書込が失敗したら、画面は1ミリも動かない(403 / 409 の両方)
// ---------------------------------------------------------------------------

test("(b-1) 403 で断られたら次の段へ進まない(理由を出してその場に留まる)", async () => {
  patchResponse = { status: 403, body: { errors: [{ path: "", message: "権限がありません" }] } };
  const manifest = grantAll(
    build([
      {
        id: "confirm",
        type: "detail_view",
        flow: { id: "checkout", step: 1, kind: "confirm" },
        actions: [SET_ACTION],
      },
      { id: "thanks", type: "list_view", flow: { id: "checkout", step: 2, kind: "input" } },
    ]),
  );
  const here = await renderDetail(manifest, "confirm");
  screen.getByTestId("action-set-state").click();
  await waitFor(() => expect(screen.getByTestId("write-forbidden")).toBeDefined());
  expect(window.location.pathname).toBe(here);
});

test("(b-2) 409(版の不一致)で断られたら次の段へ進まない", async () => {
  patchResponse = {
    status: 409,
    body: {
      errors: [
        {
          path: "",
          message: "他の人によって変更されています。最新を取り込んでやり直してください。",
        },
      ],
    },
  };
  const manifest = grantAll(
    build([
      {
        id: "confirm",
        type: "detail_view",
        flow: { id: "checkout", step: 1, kind: "confirm" },
        actions: [SET_ACTION],
      },
      { id: "thanks", type: "list_view", flow: { id: "checkout", step: 2, kind: "input" } },
    ]),
  );
  const here = await renderDetail(manifest, "confirm");
  screen.getByTestId("action-set-state").click();
  await waitFor(() => expect(screen.getByTestId("write-conflict")).toBeDefined());
  expect(window.location.pathname).toBe(here);
});

// ---------------------------------------------------------------------------
// (c) 段が解けなければ今日どおり(**既定の行き先を1つも作っていない**)
// ---------------------------------------------------------------------------

test("(c-1) 段を宣言していない詳細画面は今日どおり after_save へ行く", async () => {
  const manifest = grantAll(
    build([
      { id: "confirm", type: "detail_view", after_save: "order-list", actions: [SET_ACTION] },
      { id: "order-list", type: "list_view" },
    ]),
  );
  await renderDetail(manifest, "confirm");
  screen.getByTestId("action-set-state").click();
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/order-list`);
  });
});

test("(c-2) 確認の段でも、次の段が居なければ after_save に倒れる", async () => {
  const manifest = grantAll(
    build([
      {
        id: "confirm",
        type: "detail_view",
        flow: { id: "checkout", step: 1, kind: "confirm" },
        after_save: "order-list",
        actions: [SET_ACTION],
      },
      { id: "order-list", type: "list_view" },
    ]),
  );
  await renderDetail(manifest, "confirm");
  screen.getByTestId("action-set-state").click();
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/order-list`);
  });
});

test("(c-3) 確認の段で、次の段も after_save も無ければその場に留まる(既定の行き先が1つも無い)", async () => {
  const manifest = grantAll(
    build([
      {
        id: "confirm",
        type: "detail_view",
        flow: { id: "checkout", step: 1, kind: "confirm" },
        actions: [SET_ACTION],
      },
      { id: "order-list", type: "list_view" },
    ]),
  );
  const here = await renderDetail(manifest, "confirm");
  screen.getByTestId("action-set-state").click();
  await waitFor(() => expect(patchCount).toBe(1));
  expect(window.location.pathname).toBe(here);
});

test("(c-4) 別の流れの同じ位置は次の段にならない(流れIDが違えば干渉しない)", async () => {
  const manifest = grantAll(
    build([
      {
        id: "confirm",
        type: "detail_view",
        flow: { id: "checkout", step: 1, kind: "confirm" },
        actions: [SET_ACTION],
      },
      { id: "signup", type: "list_view", flow: { id: "signup-flow", step: 2, kind: "input" } },
    ]),
  );
  const here = await renderDetail(manifest, "confirm");
  screen.getByTestId("action-set-state").click();
  await waitFor(() => expect(patchCount).toBe(1));
  expect(window.location.pathname).toBe(here);
});

// ---------------------------------------------------------------------------
// (d) `run` 形では進まない(`V10-M4` の決8 / `ADR-0358` の越えてはならない線 2)
// ---------------------------------------------------------------------------

test("(d-1) 確認の段で run 形を押しても、段が宣言されていても次の段へ進まない", async () => {
  const manifest = grantAll(
    build([
      {
        id: "confirm",
        type: "detail_view",
        flow: { id: "checkout", step: 1, kind: "confirm" },
        actions: [RUN_ACTION],
      },
      { id: "thanks", type: "list_view", flow: { id: "checkout", step: 2, kind: "input" } },
    ]),
  );
  const here = await renderDetail(manifest, "confirm");
  screen.getByTestId("action-run-ship").click();
  await waitFor(() => expect(screen.getByTestId("action-run-ship")).toBeDefined());
  expect(window.location.pathname).toBe(here);
});

test("(d-2) 同じ確認の段に run と set が並んでいても、進むのは set のときだけである", async () => {
  const manifest = grantAll(
    build([
      {
        id: "confirm",
        type: "detail_view",
        flow: { id: "checkout", step: 1, kind: "confirm" },
        actions: [RUN_ACTION, SET_ACTION],
      },
      { id: "thanks", type: "list_view", flow: { id: "checkout", step: 2, kind: "input" } },
    ]),
  );
  const here = await renderDetail(manifest, "confirm");
  screen.getByTestId("action-run-ship").click();
  await waitFor(() => expect(screen.getByTestId("action-set-state")).toBeDefined());
  expect(window.location.pathname).toBe(here);
  screen.getByTestId("action-set-state").click();
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/thanks`);
  });
});

test("(d-3) run 形が進まないことは、実装の doc に逐語で書いてある(黙って効かない状態にしない)", () => {
  const source = readFileSync(
    join(dirname(import.meta.dir), "src", "views", "DetailViewRenderer.tsx"),
    "utf-8",
  );
  const sentence = "段が宣言されていても、`run` 形の確定では次の段へ進まない";
  expect(source).toContain(sentence);
  // **`handleRunAction` の doc に在る**(`handleSetAction` の側ではない)。
  const setAt = source.indexOf("const handleSetAction");
  const runAt = source.indexOf("const handleRunAction");
  const sentenceAt = source.indexOf(sentence);
  expect(setAt).toBeGreaterThan(0);
  expect(sentenceAt).toBeGreaterThan(setAt);
  expect(sentenceAt).toBeLessThan(runAt);
});

// ---------------------------------------------------------------------------
// (e) 確認の段に「次へ」の導線を出さない(`V10-M4-T02` を壊していない)
// ---------------------------------------------------------------------------

test("(e-1) kind: confirm の画面には「次へ」の導線が1つも出ない", async () => {
  const manifest = grantAll(
    build([
      {
        id: "confirm",
        type: "detail_view",
        flow: { id: "checkout", step: 1, kind: "confirm" },
        actions: [SET_ACTION],
      },
      { id: "thanks", type: "list_view", flow: { id: "checkout", step: 2, kind: "input" } },
    ]),
  );
  await renderDetail(manifest, "confirm");
  expect(screen.queryByTestId("flow-next")).toBeNull();
  expect(screen.queryByTestId("flow-next-button")).toBeNull();
  // **確定のボタンは出ている**(「出ないのは導線だけ」であることの裏取り)。
  expect(screen.getByTestId("action-set-state")).toBeDefined();
});

test("(e-2) 同じ題材の kind を input にすると導線は出る(消しているのは confirm だけである)", async () => {
  const manifest = grantAll(
    build([
      {
        id: "confirm",
        type: "detail_view",
        flow: { id: "checkout", step: 1, kind: "input" },
        actions: [SET_ACTION],
      },
      { id: "thanks", type: "list_view", flow: { id: "checkout", step: 2, kind: "input" } },
    ]),
  );
  await renderDetail(manifest, "confirm");
  await waitFor(() => expect(screen.getByTestId("flow-next")).toBeDefined());
});

// ---------------------------------------------------------------------------
// (f) `ADR-0360` 限定1 —— 新しいキーを1本も足していない
// ---------------------------------------------------------------------------

type AnyObject = Record<string, unknown>;

function defs(): Record<string, AnyObject> {
  return (manifestSchema as unknown as { $defs: Record<string, AnyObject> }).$defs;
}

function viewSchema(): AnyObject {
  return defs().view as AnyObject;
}

function branchOf(type: string): { if: AnyObject; then?: AnyObject } | undefined {
  return (viewSchema().allOf as { if: AnyObject; then?: AnyObject }[]).find(
    (branch) => ((branch.if.properties as AnyObject)?.type as AnyObject)?.const === type,
  );
}

test("(f-1) 限定1: $defs/view.properties は 31 / $defs/view_type は 4 / $defs/view_action.properties は 8", () => {
  expect(Object.keys(viewSchema().properties as AnyObject)).toHaveLength(31);
  expect((defs().view_type as { enum: string[] }).enum).toHaveLength(4);
  expect(Object.keys((defs().view_action as AnyObject).properties as AnyObject)).toHaveLength(8);
});

test("(f-2) 限定1: flow の値の形は3つのままで、4つ目のサブキーが無い(kind は2値)", () => {
  const flow = (viewSchema().properties as AnyObject).flow as AnyObject;
  expect(Object.keys(flow.properties as AnyObject).sort()).toEqual(["id", "kind", "step"]);
  expect(flow.additionalProperties).toBe(false);
  expect((flow.required as string[]).slice().sort()).toEqual(["id", "kind", "step"]);
  expect(((flow.properties as AnyObject).kind as { enum: string[] }).enum).toEqual([
    "input",
    "confirm",
  ]);
});

// ---------------------------------------------------------------------------
// (g) `ADR-0360` 限定2 —— 確認の段を置けるのは `detail_view` だけである
// ---------------------------------------------------------------------------

test("(g-1) 限定2: form / list_view の分岐は flow.kind を input に固定したままである", () => {
  for (const type of ["form", "list_view"]) {
    const flow = ((branchOf(type)?.then?.properties as AnyObject)?.flow ?? {}) as AnyObject;
    expect(((flow.properties as AnyObject)?.kind as AnyObject)?.const).toBe("input");
  }
});

test("(g-2) 限定2: detail_view の分岐は flow を1バイトも狭めていない / report_view は false のまま", () => {
  expect((branchOf("detail_view")?.then?.properties as AnyObject)?.flow).toBeUndefined();
  expect((branchOf("report_view")?.then?.properties as AnyObject)?.flow).toBe(false);
});

// ---------------------------------------------------------------------------
// (h) `ADR-0360` 限定3 —— 確定は既存の形で書く。5形目を1つも作っていない
// ---------------------------------------------------------------------------

test("(h-1) 限定3: $defs/view_action の oneOf は4形のままで、5形目が無い", () => {
  const oneOf = (defs().view_action as { oneOf: { required?: string[] }[] }).oneOf;
  expect(oneOf).toHaveLength(4);
  expect(oneOf.map((branch) => (branch.required ?? []).join("+"))).toEqual([
    "form+prefill",
    "set",
    "view",
    "run",
  ]);
});

// ---------------------------------------------------------------------------
// (i) `ADR-0360` 限定4 —— `after_save` を1バイトも触らず、
//     `ADR-0102` 限定4 / 限定6 / 限定7 が今日どおりであること
// ---------------------------------------------------------------------------

test("(i-1) ADR-0102 限定4: after_save は1つの画面IDを指す1本のままで、成功 / 失敗の分岐が無い", () => {
  const afterSave = (viewSchema().properties as AnyObject).after_save as AnyObject;
  expect(afterSave.$ref).toBe("#/$defs/resource_id");
  // **オブジェクトでも配列でもない** —— **条件・分岐を書く場所が1つも無い。**
  expect(afterSave.properties).toBeUndefined();
  expect(afterSave.oneOf).toBeUndefined();
  expect(JSON.stringify(afterSave.$ref)).not.toContain("success");
  // **書ける種別も今日どおり**(`list_view` / `report_view` では `false`)。
  expect((branchOf("list_view")?.then?.properties as AnyObject)?.after_save).toBe(false);
  expect((branchOf("report_view")?.then?.properties as AnyObject)?.after_save).toBe(false);
});

test("(i-2) ADR-0102 限定6: 送信ボタンの文言は「保存」の1つで、宣言する口が1本も無い", async () => {
  const manifest = grantAll(build([{ id: "address", type: "form" }]));
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/address`);
  render(
    <RoleProvider role={WRITER_ROLE}>
      <ViewHost appId={APP_ID} manifest={manifest} view={viewOf(manifest, "address")} />
    </RoleProvider>,
  );
  await screen.findByLabelText(/メモ/);
  const form = screen.getByTestId("view-renderer-form");
  const submitButton = form.querySelector("button[type='submit']");
  expect(submitButton?.textContent).toBe("保存");
  // **文言を宣言するキーが `$defs/view` に1本も無い。**
  const keys = Object.keys(viewSchema().properties as AnyObject);
  for (const forbidden of ["submit_label", "button_label", "confirm_label", "label"]) {
    expect(keys).not.toContain(forbidden);
  }
});

test("(i-3) ADR-0102 限定7: 宣言が1つも無い form の挙動は今日と1文字も変わらない", async () => {
  // **`flow` も `after_save` も書いていない** —— **既定の段3(同じ表の `list_view`)へ倒れる。**
  const manifest = grantAll(
    build([
      { id: "address", type: "form" },
      { id: "order-list", type: "list_view" },
    ]),
  );
  expect(await submit(manifest, "address")).toBe(`/apps/${APP_ID}/views/order-list`);
});

// ---------------------------------------------------------------------------
// (j) `ADR-0360` 限定5 —— 確定前の値を溜める仕組みを1つも作っていない
// ---------------------------------------------------------------------------

test("(j-1) 限定5: 予約規約フィールドは着手前(f09cc0d)と同じ4本のままである", () => {
  const source = readFileSync(
    join(dirname(dirname(import.meta.dir)), "src", "server", "owner-scope.ts"),
    "utf-8",
  );
  const names = [...source.matchAll(/^export const [A-Z_0-9]+ = "(st_[a-z_]+)";$/gm)].map(
    (match) => match[1],
  );
  expect(names).toEqual(["st_owner", "st_public", "st_undeletable", "st_no_direct_create"]);
  expect(names).toHaveLength(4);
});

test("(j-2) 限定5: flow の値にも view のキーにも「未確定の下書き」を置く場所が1つも無い", () => {
  const flow = (viewSchema().properties as AnyObject).flow as AnyObject;
  expect(Object.keys(flow.properties as AnyObject)).not.toContain("draft");
  const keys = Object.keys(viewSchema().properties as AnyObject);
  for (const forbidden of ["draft", "pending", "staging", "buffer"]) {
    expect(keys).not.toContain(forbidden);
  }
});
