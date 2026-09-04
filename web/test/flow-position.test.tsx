/**
 * **宣言された段から「いま何段目 / 全部で何段」を導き、すべての画面が通る器に描く**
 * (`V10-M5-T02`。`NV-G9` / `NV-G11` の受け先。`ADR-0359` §4b)。
 *
 * ## この検査が言えないこと(**先に書く。誇張しない**)
 *
 * 1. **`fetch` を差し替えている。本物のサーバを1度も叩いていない** —— 見ているのは
 *    「表示層が段の宣言を読んで何を描くか」だけである。**サーバがその画面を本当に
 *    配るか / 行が本当に読めるかは1件も測っていない。**
 * 2. **happy-dom であり、chromium で1度も確かめていない** —— **置かれた位置のピクセルも、
 *    文字の大きさも、色も1つも見ていない**(`text-note` / `text-muted-foreground` が
 *    本当に効いているかは、ここでは1バイトも測れない)。**本物のブラウザの実測は
 *    `web/e2e/flow-steps.e2e.ts` が持つ。**
 * 3. **【禁止】「閉じた段も必ず数に入る」と読まない** —— **経路で答えが違う。**
 *    **ログイン済み(`GET /api/apps/:app_id/manifest`)は役割でビューを1件も間引かないので
 *    開けない段も総数に入るが**(d-1)**、未ログイン(`GET /api/apps/:app_id/public`)は
 *    見せると決めた段だけを配るので、同じ流れが小さい数に見える**(d-2)。
 *    **この非対称はこのタスクで直していない。**
 * 4. **【禁止】「流れの全体像が画面に出るようになった」と読まない** —— **出るのは
 *    2つの数だけである。** **段の名前(流れID)・種類(`kind`)・アイコン・色・進捗率・
 *    残り時間を1つも描いていない**(c-2)。
 * 5. **【禁止】「そこから他の段へ飛べる」と読まない** —— **描くのは `<p>` であり、
 *    押せる要素を1つも持たない**(c-1)。
 * 6. **(d-2) は `publicManifest()`(`web/src/AppWorkspace.tsx`)に本当に通しているが、
 *    絞り込みそのものはサーバ(`src/server/app.ts` の `judgeRoleAccess` + `governed`)であり、
 *    ここでは `canUseView(ANONYMOUS, …)`(同じ判定関数を呼ぶ表示層側の入口)で
 *    再現している。** **サーバの口を1度も叩いていない。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { Manifest, Table, View } from "../../src/kernel/types.ts";
import { publicManifest } from "../src/AppWorkspace.tsx";
import type { PublicView, Role } from "../src/api.ts";
import { ANONYMOUS, canUseView, RoleProvider } from "../src/auth/authz.tsx";
// **【2026-08-26。`V10-M33-T01`。台帳 `CM-G43`】書く欄の部品は、器へ静的 `import` では
// なくコンテキストのスロット(`CommentVisibilityProvider` の `panel`)で渡すようになった
// (**配る版の成果物から書く欄のバイト列を落とすため**)。**`panel` は必須なので、この器を
// 張る検査はここでも部品を渡す** —— **渡さないと「設定が ON なら書く欄が1要素である」の
// 陽性対照が測れなくなる。** **測るものを1ミリも弱めていない**(製品では
// `web/src/AppWorkspace.tsx` が同じ `CommentPanel` を渡している)。
import { CommentPanel } from "../src/CommentPanel.tsx";
import { flowPositionOf, flowStepOf } from "../src/views/flow.ts";
import { CommentVisibilityProvider, ViewHost } from "../src/views/ViewHost.tsx";
import { grantRules, viewRead } from "./role-rules.ts";

/**
 * **書ける立場**(`web/test/flow-next-step.test.tsx` と1バイトも同じ理由)——
 * **文字列リテラルで `role="owner"` と書くと biome の a11y 規則(`useValidAriaRole`)が
 * HTML の `role` 属性と誤認するので、変数経由で渡す。**
 */
const WRITER_ROLE: Role = "owner";
const OTHER_ROLE: Role = "editor";

const APP_ID = "shop";
const ORDERS_PATH = `/api/apps/${APP_ID}/tables/orders/records`;
const RECORD_ID = "order-0001";

const ORDER_ROW = {
  _id: RECORD_ID,
  _created_at: "2026-01-01T00:00:00Z",
  _updated_at: "2026-01-02T00:00:00Z",
  memo: "既存",
};

let originalFetch: typeof fetch;

// ---------------------------------------------------------------------------
// 題材(**`web/test/flow-next-step.test.tsx` の骨格を写している**)
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

/** **役割の規則を1本も持たない題材**(面の既定は閉じているので、そのままでは画面が出ない)。 */
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

/** 名指しした役割に、名指しした画面の読取だけを配る。 */
function grantViews(manifest: Manifest, role: string, viewIds: readonly string[]): Manifest {
  return grantRules(manifest, [role], viewIds.map(viewRead));
}

/** 全画面の読取を `owner` に配る(**positive 側の既定**)。 */
function grantAll(manifest: Manifest, role: string = WRITER_ROLE): Manifest {
  return grantViews(
    manifest,
    role,
    manifest.app.views.map((view) => view.id),
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
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (method === "GET" && url.includes("/report")) {
      return json({ groups: [], totals: [], total_groups: 0 });
    }
    if (method === "GET" && url.startsWith(`${ORDERS_PATH}/${RECORD_ID}`)) {
      return json({ record: ORDER_ROW });
    }
    if (method === "GET" && url.startsWith(ORDERS_PATH)) {
      return json({ records: [ORDER_ROW], total: 1 });
    }
    return json({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/cart`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

type RenderOptions = {
  /** **`RoleProvider` で包まない**(= 匿名公開の経路の再現)。 */
  anonymous?: boolean;
  role?: Role;
  recordId?: string;
};

function renderHost(manifest: Manifest, viewId: string, options: RenderOptions = {}): HTMLElement {
  const tree = (
    <ViewHost
      appId={APP_ID}
      manifest={manifest}
      view={viewOf(manifest, viewId)}
      recordId={options.recordId}
    />
  );
  const result = render(
    options.anonymous === true ? (
      tree
    ) : (
      <RoleProvider role={options.role ?? WRITER_ROLE}>{tree}</RoleProvider>
    ),
  );
  return result.container;
}

/** 描かれた「何段目 / 全何段」の文字列。**出ていなければ `null`。** */
function positionText(): string | null {
  const node = screen.queryByTestId("flow-position");
  return node === null ? null : (node.textContent ?? "");
}

// ---------------------------------------------------------------------------
// (a) 出る —— 3種別すべて。数は段の並びから導く
// ---------------------------------------------------------------------------

test("(a-1) 段を宣言した list_view / form / detail_view の3種別すべてに flow-position が1つ出る", async () => {
  const manifest = grantAll(
    build([
      { id: "cart", type: "list_view", flow: { id: "checkout", step: 1, kind: "input" } },
      { id: "address", type: "form", flow: { id: "checkout", step: 2, kind: "input" } },
      { id: "confirm", type: "detail_view", flow: { id: "checkout", step: 3, kind: "confirm" } },
    ]),
  );
  // **裏取り: 題材の3画面がそれぞれ違う種別である**(1種別を3回測っていない)。
  expect(manifest.app.views.map((view) => view.type)).toEqual(["list_view", "form", "detail_view"]);

  renderHost(manifest, "cart");
  await waitFor(() => expect(screen.getByTestId("view-renderer-list_view")).toBeDefined());
  expect(screen.getAllByTestId("flow-position")).toHaveLength(1);
  expect(positionText()).toBe("1段目 / 全3段");
  cleanup();

  renderHost(manifest, "address");
  await screen.findByLabelText(/メモ/);
  expect(screen.getAllByTestId("flow-position")).toHaveLength(1);
  expect(positionText()).toBe("2段目 / 全3段");
  cleanup();

  window.history.replaceState({}, "", `/apps/${APP_ID}/views/confirm/records/${RECORD_ID}`);
  renderHost(manifest, "confirm", { recordId: RECORD_ID });
  await waitFor(() => expect(screen.getByTestId("view-renderer-detail_view")).toBeDefined());
  expect(screen.getAllByTestId("flow-position")).toHaveLength(1);
  expect(positionText()).toBe("3段目 / 全3段");
});

test("(a-2) 4段の流れの各段で 1段目 / 全4段 … 4段目 / 全4段 になる", async () => {
  const manifest = grantAll(
    build([
      { id: "step-1", type: "list_view", flow: { id: "checkout", step: 1, kind: "input" } },
      { id: "step-2", type: "list_view", flow: { id: "checkout", step: 2, kind: "input" } },
      { id: "step-3", type: "list_view", flow: { id: "checkout", step: 3, kind: "input" } },
      { id: "step-4", type: "list_view", flow: { id: "checkout", step: 4, kind: "input" } },
    ]),
  );
  // **裏取り: 4画面すべてが同じ流れIDを宣言している。**
  expect(manifest.app.views.map((view) => flowStepOf(view)?.id ?? "(段なし)")).toEqual([
    "checkout",
    "checkout",
    "checkout",
    "checkout",
  ]);

  for (const [index, viewId] of ["step-1", "step-2", "step-3", "step-4"].entries()) {
    renderHost(manifest, viewId);
    await waitFor(() => expect(screen.getByTestId("view-renderer-list_view")).toBeDefined());
    expect(positionText()).toBe(`${index + 1}段目 / 全4段`);
    cleanup();
  }
});

test("(a-3) 定義の並びが step 順でなくても、位置は step の昇順で決まる", async () => {
  const manifest = grantAll(
    build([
      { id: "last", type: "list_view", flow: { id: "checkout", step: 3, kind: "input" } },
      { id: "first", type: "list_view", flow: { id: "checkout", step: 1, kind: "input" } },
      { id: "middle", type: "list_view", flow: { id: "checkout", step: 2, kind: "input" } },
    ]),
  );
  // **裏取り: 定義の並びは step の昇順**ではない**。**
  expect(manifest.app.views.map((view) => flowStepOf(view)?.step)).toEqual([3, 1, 2]);
  expect(flowPositionOf(manifest, viewOf(manifest, "first"))).toEqual({ position: 1, total: 3 });
  expect(flowPositionOf(manifest, viewOf(manifest, "middle"))).toEqual({ position: 2, total: 3 });
  expect(flowPositionOf(manifest, viewOf(manifest, "last"))).toEqual({ position: 3, total: 3 });

  renderHost(manifest, "last");
  await waitFor(() => expect(screen.getByTestId("view-renderer-list_view")).toBeDefined());
  expect(positionText()).toBe("3段目 / 全3段");
});

test("(a-4) 別の流れの段は総数に1つも入らない(流れIDが違えば干渉しない)", () => {
  const manifest = grantAll(
    build([
      { id: "cart", type: "list_view", flow: { id: "checkout", step: 1, kind: "input" } },
      { id: "thanks", type: "list_view", flow: { id: "checkout", step: 2, kind: "input" } },
      { id: "signup", type: "list_view", flow: { id: "signup-flow", step: 1, kind: "input" } },
      { id: "welcome", type: "list_view", flow: { id: "signup-flow", step: 2, kind: "input" } },
      { id: "done", type: "list_view", flow: { id: "signup-flow", step: 3, kind: "input" } },
    ]),
  );
  // **裏取り: マニフェスト全体では5画面が段を宣言している**(総数はそれではない)。
  expect(manifest.app.views.filter((view) => flowStepOf(view) !== undefined)).toHaveLength(5);
  expect(flowPositionOf(manifest, viewOf(manifest, "cart"))).toEqual({ position: 1, total: 2 });
  expect(flowPositionOf(manifest, viewOf(manifest, "done"))).toEqual({ position: 3, total: 3 });
});

// ---------------------------------------------------------------------------
// (b) 出ない —— 段を宣言していない画面は今日と1バイトも変わらない
// ---------------------------------------------------------------------------

test("(b-1) 段を宣言していない画面には flow-position が1つも出ない", async () => {
  const manifest = grantAll(
    build([
      { id: "cart", type: "list_view" },
      { id: "thanks", type: "list_view", flow: { id: "checkout", step: 1, kind: "input" } },
    ]),
  );
  // **裏取り: 同じ題材の別の画面では出る**(題材そのものが描けないから0件、ではない)。
  expect(flowStepOf(viewOf(manifest, "cart"))).toBeUndefined();
  expect(flowPositionOf(manifest, viewOf(manifest, "cart"))).toBeUndefined();

  renderHost(manifest, "cart");
  await waitFor(() => expect(screen.getByTestId("view-renderer-list_view")).toBeDefined());
  expect(screen.queryByTestId("flow-position")).toBeNull();
  cleanup();

  renderHost(manifest, "thanks");
  await waitFor(() => expect(screen.getByTestId("view-renderer-list_view")).toBeDefined());
  expect(screen.getByTestId("flow-position")).toBeDefined();
});

test("(b-2) 段を宣言していない list_view では、器の子の並びが今日どおり2つのままである", async () => {
  const manifest = grantAll(build([{ id: "cart", type: "list_view" }]));
  const container = renderHost(manifest, "cart");
  await waitFor(() => expect(screen.getByTestId("view-renderer-list_view")).toBeDefined());
  // **【2026-08-24。`V10-M11-T01` の2手目。台帳 `CM-G4` = 門外(`Δ7`)/ 限定採用】**
  // **器の子が末尾に1つ増えた** —— **画面へのコメントを1件書く導線(`comment-panel`)である。**
  // **旧の期待値(逐語。1バイトも消していない)**:
  //   `expect([...container.children].map((child) => child.getAttribute("data-testid"))).toEqual([`
  //   `  "view-title",`
  //   `  "view-renderer-list_view",`
  //   `]);`
  // **既存の並びは1つも動いていない** —— **足したのは末尾の1要素だけである。**
  // **未ログイン(`anonymous: true`)の枝では出ない**(`web/src/CommentPanel.tsx` の「誰に出すか」)。
  // **【2026-08-25。`V10-M31-T02`。台帳 `CM-G38` / `ADR-0379` 限定2 / 利用者決定 `D-V10-40`】**
  // **書く欄(`comment-panel`)はアプリごとの設定で出し入れするようになり、**既定は OFF**である。**
  // **この題材は設定を1度も触っていないので、末尾の1要素が出ない。**
  // **2026-08-24 の期待値(逐語。1バイトも消していない)**:
  //   `expect([...container.children].map((child) => child.getAttribute("data-testid"))).toEqual([`
  //   `  "view-title",`
  //   `  "view-renderer-list_view",`
  //   `  "comment-panel",`
  //   `]);`
  // **この検査が測っているのは「段の導線が器のどこに入るか」であり、書く欄の出入りではない**
  // (出入りそのものの実測は `web/test/comment-visibility-toggle.test.tsx` が持つ)。
  // **落ちたのは末尾の1要素だけで、既存の並びは1つも動いていない。**
  // **あわせて注記する**: **この検査の名前は「器の子は今日どおり**2つ**」と書いているのに、
  // **2026-08-24 から配列は3要素だった** —— **名前が実態と食い違っていた。**
  // **既定 OFF にすると、名前と配列が一致する側へ戻る。** **名前そのものは1バイトも書き換えていない。**
  expect([...container.children].map((child) => child.getAttribute("data-testid"))).toEqual([
    "view-title",
    "view-renderer-list_view",
  ]);
});

/**
 * **【2026-08-21 に名前ごと書き換えた(`V10-M18-T03` / `FU-G3`)】**
 *
 * **旧の検査名を逐語で控える**:
 * `(b-3) 段を宣言した list_view では、器の子が見出しと本体のあいだに1つ増える`
 *
 * **偽になった理由**: **「戻る」(`flow-back`)が入力画面の中から器へ移り、段を宣言した
 * `list_view` にも出るようになった。** **器の子は見出しと本体のあいだで**2つ**増える。**
 * **`flow-position` の位置(見出しの直後)は1つも動いていない** —— **増えたのは
 * その後ろの1つである。**
 */
test("(b-3) 段を宣言した list_view では、器の子が見出しと本体のあいだに2つ増える", async () => {
  const manifest = grantAll(
    build([
      { id: "cart", type: "list_view", flow: { id: "checkout", step: 1, kind: "input" } },
      { id: "thanks", type: "list_view", flow: { id: "checkout", step: 2, kind: "input" } },
    ]),
  );
  const container = renderHost(manifest, "cart");
  await waitFor(() => expect(screen.getByTestId("view-renderer-list_view")).toBeDefined());
  // **位置は見出しの直後・本体の前である**(`flow-next` は本体の後ろに出る)。
  // **「戻る」は位置の直後・本体の前である。**
  // **【2026-08-24。`V10-M11-T01` の2手目。台帳 `CM-G4` = 門外(`Δ7`)/ 限定採用】**
  // **器の子が末尾に1つ増えた** —— **画面へのコメントを1件書く導線(`comment-panel`)である。**
  // **旧の期待値(逐語。1バイトも消していない)**:
  //   `expect([...container.children].map((child) => child.getAttribute("data-testid"))).toEqual([`
  //   `  "view-title",`
  //   `  "flow-position",`
  //   `  "flow-back",`
  //   `  "view-renderer-list_view",`
  //   `  "flow-next",`
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
  //   `  "view-renderer-list_view",`
  //   `  "flow-next",`
  //   `  "comment-panel",`
  //   `]);`
  // **この検査が測っているのは「段の導線が器のどこに入るか」であり、書く欄の出入りではない**
  // (出入りそのものの実測は `web/test/comment-visibility-toggle.test.tsx` が持つ)。
  // **落ちたのは末尾の1要素だけで、既存の並びは1つも動いていない。**
  expect([...container.children].map((child) => child.getAttribute("data-testid"))).toEqual([
    "view-title",
    "flow-position",
    "flow-back",
    "view-renderer-list_view",
    "flow-next",
  ]);
});

/**
 * **【2026-08-25。`V10-M31-T02`。台帳 `CM-G38` / `ADR-0379` 限定2 / 利用者決定 `D-V10-40`】**
 *
 * **上の (b-2) / (b-3) の配列から `comment-panel` が落ちた分の担保を、ここで埋める。**
 * **既定は OFF なので、書く欄が並びの**どこ**に入るかを測るには設定を ON にして描く必要がある。**
 * **4ファイルに散らさず、このファイルの2本だけに置く。**
 *
 * **【この2本が言えないこと】** **設定が本当にサーバから届くかは1件も測っていない**
 * (それは `src/server/comment-visibility-http.test.ts` と
 * `web/test/comment-visibility-toggle.test.tsx` の担当である)。 **ここが見るのは並びだけである。**
 */
function renderHostWithCommentPanel(manifest: Manifest, viewId: string): HTMLElement {
  return render(
    // **【2026-08-26。`V10-M33-T01`】旧行の逐語(1バイトも消していない)**:
    //   `<CommentVisibilityProvider value={{ write: true, read: false }}>`
    // **`panel` を1本足しただけである** —— **見るもの(器の子の並び)は1ミリも変えていない。**
    <CommentVisibilityProvider value={{ write: true, read: false }} panel={CommentPanel}>
      <RoleProvider role={WRITER_ROLE}>
        <ViewHost appId={APP_ID} manifest={manifest} view={viewOf(manifest, viewId)} />
      </RoleProvider>
    </CommentVisibilityProvider>,
  ).container;
}

test("(b-4) V10-M31-T02: 設定が ON なら、段を宣言していない list_view でも器の子の末尾に comment-panel が来る", async () => {
  const manifest = grantAll(build([{ id: "cart", type: "list_view" }]));
  const container = renderHostWithCommentPanel(manifest, "cart");
  await waitFor(() => expect(screen.getByTestId("view-renderer-list_view")).toBeDefined());
  expect([...container.children].map((child) => child.getAttribute("data-testid"))).toEqual([
    "view-title",
    "view-renderer-list_view",
    "comment-panel",
  ]);
});

test("(b-5) V10-M31-T02: 設定が ON なら、段を宣言した list_view でも comment-panel は並びの末尾である", async () => {
  const manifest = grantAll(
    build([
      { id: "cart", type: "list_view", flow: { id: "checkout", step: 1, kind: "input" } },
      { id: "thanks", type: "list_view", flow: { id: "checkout", step: 2, kind: "input" } },
    ]),
  );
  const container = renderHostWithCommentPanel(manifest, "cart");
  await waitFor(() => expect(screen.getByTestId("view-renderer-list_view")).toBeDefined());
  // **段の導線(`flow-position` / `flow-back` / `flow-next`)の位置は1つも動いていない** ——
  // **書く欄はその後ろの末尾に1つ足されるだけである。**
  expect([...container.children].map((child) => child.getAttribute("data-testid"))).toEqual([
    "view-title",
    "flow-position",
    "flow-back",
    "view-renderer-list_view",
    "flow-next",
    "comment-panel",
  ]);
});

// ---------------------------------------------------------------------------
// (c) 何を描かないか —— 押せない。2つの数だけ
// ---------------------------------------------------------------------------

test("(c-1) flow-position の内側に button / a / input が0件である(押せない表示)", async () => {
  const manifest = grantAll(
    build([
      { id: "cart", type: "list_view", flow: { id: "checkout", step: 1, kind: "input" } },
      { id: "thanks", type: "list_view", flow: { id: "checkout", step: 2, kind: "input" } },
    ]),
  );
  const container = renderHost(manifest, "cart");
  await waitFor(() => expect(screen.getByTestId("view-renderer-list_view")).toBeDefined());
  const node = screen.getByTestId("flow-position");
  expect(node.tagName).toBe("P");
  expect(node.querySelectorAll("button, a, input")).toHaveLength(0);
  // **裏取り: 同じ式を器全体に当てると1件以上当たる**(式が空回りしていない)。
  expect(container.querySelectorAll("button, a, input").length).toBeGreaterThan(0);
});

test("(c-2) 描く文字は2つの数だけ(流れID・kind・進捗率を1文字も出さない)", async () => {
  const manifest = grantAll(
    build([
      { id: "cart", type: "list_view", flow: { id: "checkout", step: 1, kind: "input" } },
      { id: "confirm", type: "detail_view", flow: { id: "checkout", step: 2, kind: "confirm" } },
    ]),
  );
  renderHost(manifest, "cart");
  await waitFor(() => expect(screen.getByTestId("view-renderer-list_view")).toBeDefined());
  const text = positionText() ?? "";
  expect(text).toBe("1段目 / 全2段");
  // **裏取り: 探している綴りが題材に本当に在る**(存在しない綴りを探して0件、ではない)。
  expect(flowStepOf(viewOf(manifest, "cart"))?.id).toBe("checkout");
  expect(flowStepOf(viewOf(manifest, "confirm"))?.kind).toBe("confirm");
  expect(text).not.toContain("checkout");
  expect(text).not.toContain("input");
  expect(text).not.toContain("confirm");
  expect(text).not.toContain("%");
});

// ---------------------------------------------------------------------------
// (d) **閉じた段が数に入るかは、経路で違う**(直していない。両方を測る)
// ---------------------------------------------------------------------------

test("(d-1) ログイン済み: その人に開けない段が途中にあっても総数が変わらない", async () => {
  const base = build([
    { id: "cart", type: "list_view", flow: { id: "checkout", step: 1, kind: "input" } },
    { id: "address", type: "list_view", flow: { id: "checkout", step: 2, kind: "input" } },
    { id: "thanks", type: "list_view", flow: { id: "checkout", step: 3, kind: "input" } },
  ]);
  const manifest = grantViews(grantViews(base, WRITER_ROLE, ["cart", "thanks"]), OTHER_ROLE, [
    "address",
  ]);
  // **裏取り: 段2 は本当にこの人に開けない**(題材が条件を満たしている)。
  expect(canUseView(WRITER_ROLE, manifest, viewOf(manifest, "address"))).toBe(false);
  expect(canUseView(WRITER_ROLE, manifest, viewOf(manifest, "cart"))).toBe(true);

  renderHost(manifest, "cart");
  await waitFor(() => expect(screen.getByTestId("view-renderer-list_view")).toBeDefined());
  // **開けない段も総数に入る** —— `GET /api/apps/:app_id/manifest` は役割でビューを
  // 1件も間引かないので、器に渡るのは全量である。
  expect(positionText()).toBe("1段目 / 全3段");
});

test("(d-2) 未ログイン: publicManifest が渡す絞られた集合では総数が小さくなる(非対称。直していない)", async () => {
  const manifest = grantViews(
    build([
      { id: "cart", type: "list_view", flow: { id: "checkout", step: 1, kind: "input" } },
      { id: "address", type: "list_view", flow: { id: "checkout", step: 2, kind: "input" } },
      { id: "thanks", type: "list_view", flow: { id: "checkout", step: 3, kind: "input" } },
    ]),
    "anonymous",
    ["cart", "thanks"],
  );
  // **サーバが未ログインへ配る集合を、同じ判定関数で再現する。**
  const visible = manifest.app.views.filter((view) => canUseView(ANONYMOUS, manifest, view));
  // **裏取り: 絞られている**(全量は3件、渡るのは2件)。
  expect(manifest.app.views).toHaveLength(3);
  expect(visible.map((view) => view.id)).toEqual(["cart", "thanks"]);

  const publicSide = publicManifest({
    app: { id: APP_ID, name: manifest.app.name },
    views: visible.map(
      (view) =>
        ({
          ...structuredClone(view),
          name: view.name ?? view.id,
          tables: manifest.app.tables.filter(
            (table) => table.id === (view as { table?: string }).table,
          ) as readonly Table[],
        }) as PublicView,
    ),
  });
  expect(publicSide.app.views).toHaveLength(2);

  renderHost(publicSide, "cart", { anonymous: true });
  await waitFor(() => expect(screen.getByTestId("view-renderer-list_view")).toBeDefined());
  // **同じ流れが小さい数に見える**(ログイン済みなら「全3段」である)。
  expect(positionText()).toBe("1段目 / 全2段");
  expect(flowPositionOf(manifest, viewOf(manifest, "cart"))).toEqual({ position: 1, total: 3 });
});

// ---------------------------------------------------------------------------
// (e) URL に1文字も載せない
// ---------------------------------------------------------------------------

test("(e-1) 描くだけでは history.pushState が1度も呼ばれない(URL に1文字も載らない)", async () => {
  const manifest = grantAll(
    build([
      { id: "cart", type: "list_view", flow: { id: "checkout", step: 1, kind: "input" } },
      { id: "thanks", type: "list_view", flow: { id: "checkout", step: 2, kind: "input" } },
    ]),
  );
  const original = window.history.pushState;
  const calls: unknown[][] = [];
  window.history.pushState = ((...args: unknown[]) => {
    calls.push(args);
    return (original as (...rest: unknown[]) => unknown).apply(window.history, args);
  }) as typeof window.history.pushState;
  try {
    renderHost(manifest, "cart");
    await waitFor(() => expect(screen.getByTestId("flow-position")).toBeDefined());
    expect(calls).toHaveLength(0);
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/cart`);
    expect(window.location.search).toBe("");
    // **裏取り: この仕掛けは本当に数えられる**(押せば1件増える)。
    screen.getByTestId("flow-next-button").click();
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
  } finally {
    window.history.pushState = original;
  }
});

// ---------------------------------------------------------------------------
// (f) 順位で採ったこと —— 欠番でも `position <= total` が保たれる
// ---------------------------------------------------------------------------

test("(f-1) 欠番のある(手で置かれた古い)定義でも position <= total が保たれる", async () => {
  const manifest = grantAll(
    build([
      { id: "a", type: "list_view", flow: { id: "checkout", step: 1, kind: "input" } },
      { id: "b", type: "list_view", flow: { id: "checkout", step: 3, kind: "input" } },
      { id: "c", type: "list_view", flow: { id: "checkout", step: 5, kind: "input" } },
    ]),
  );
  // **裏取り: 題材は本当に欠番を持つ**(1・3・5)。
  expect(manifest.app.views.map((view) => flowStepOf(view)?.step)).toEqual([1, 3, 5]);

  for (const viewId of ["a", "b", "c"]) {
    const derived = flowPositionOf(manifest, viewOf(manifest, viewId));
    expect(derived).toBeDefined();
    expect((derived as { position: number }).position).toBeLessThanOrEqual(
      (derived as { total: number }).total,
    );
  }
  // **位置は `step` の値そのものではない**(順位である)。
  expect(flowPositionOf(manifest, viewOf(manifest, "c"))).toEqual({ position: 3, total: 3 });
  expect(flowStepOf(viewOf(manifest, "c"))?.step).toBe(5);

  renderHost(manifest, "c");
  await waitFor(() => expect(screen.getByTestId("view-renderer-list_view")).toBeDefined());
  // **「5段中5段目」でも「3段中5段目」でもない。**
  expect(positionText()).toBe("3段目 / 全3段");
});

test("(f-2) flow.ts に覚え書き(キャッシュ)が1つも無い(字面の走査)", async () => {
  const source = await Bun.file(new URL("../src/views/flow.ts", import.meta.url)).text();
  // **doc と `//` の注記を落としてから見る**(説明文の綴りを実装と数えない)。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  // **裏取り: 落としたあとにも実装が残っている**(空文字を走査して0件、ではない)。
  expect(code).toContain("export function flowPositionOf");
  expect(code).toContain("export function nextFlowStepView");
  for (const spelling of ["useMemo", "useState", "useRef", "new Map(", "new Set(", "cache"]) {
    expect(code).not.toContain(spelling);
  }
  // **モジュールの持ち物に書き換えられる変数が1つも無い。**
  expect(code.match(/^(let|var)\s/gm)).toBeNull();
  // **可視性の判定を1文字も呼んでいない**(導出は宣言の集合だけから行う)。
  expect(code).not.toContain("canUseView");
});

// ---------------------------------------------------------------------------
// (g) 集計表 —— 段を書けないので出ない
// ---------------------------------------------------------------------------

test("(g-1) report_view には段を書けないので flow-position が出ない", async () => {
  const manifest = grantAll(
    build([
      {
        id: "sales",
        type: "report_view",
        // **スキーマは `report_view` の `flow` を `false` で閉じている** ——
        // **ここでは型を外して無理に書き、それでも読まれないことを測る。**
        flow: { id: "checkout", step: 1, kind: "input" },
      },
      { id: "thanks", type: "list_view", flow: { id: "checkout", step: 2, kind: "input" } },
    ]),
  );
  const sales = viewOf(manifest, "sales");
  // **裏取り: 題材の側には `flow` が本当に書かれている**(書き忘れて0件、ではない)。
  expect((sales as unknown as { flow?: unknown }).flow).toBeDefined();
  expect(flowStepOf(sales)).toBeUndefined();
  expect(flowPositionOf(manifest, sales)).toBeUndefined();

  renderHost(manifest, "sales");
  await waitFor(() => expect(screen.getByTestId("view-title")).toBeDefined());
  expect(screen.queryByTestId("flow-position")).toBeNull();
});
