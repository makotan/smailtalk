/**
 * **段の並びを表示層が読み、次の段へ進む導線を描く**(`V10-M4-T02`。`NV-G9` / `NV-G11` /
 * `NV-G7a` の受け先。`ADR-0359` §4b 限定3・限定5 / `ADR-0360` 限定2 / `ADR-0357` 限定1・限定2)。
 *
 * ## この検査が言えないこと(**先に書く。誇張しない**)
 *
 * 1. **`fetch` を差し替えている。本物のサーバを1度も叩いていない** —— 見ているのは
 *    「表示層が段の宣言を読んで何を描き、押されたときにどこへ移るか」だけである。
 *    **書込が本当に成立したか / その画面をサーバが本当に配るかは1件も測っていない。**
 * 2. **happy-dom であり、chromium で1度も確かめていない**(`web/e2e/` に1本も足していない。
 *    端から端まで押す実測は `V10-M4-T03` の担当である)。
 * 3. **【禁止】「流れの進み具合が画面に出るようになった」と読まない** —— **出るのは
 *    「次へ」のボタン1本だけで、何段目かも残り何段かも1文字も描いていない。**
 *    **【2026-08-20。`V10-M5-T02` が「いま何段目 / 全部で何段」を描いた。すぐ上の2行は
 *    今日は偽である。旧文を1バイトも書き換えていない】** **何段目 / 全部で何段は今日から
 *    画面に描かれる**(器の `flow-position`)。**その実測は
 *    `web/test/flow-position.test.tsx` が持つ。****本ファイルが測っているのは
 *    「次へ」のボタンだけである**(本ファイルの検査の本体は1バイトも変えていない)。
 * 4. **【禁止】「確認の段が確定したら次へ進む」と読まない** —— **本ファイルは
 *    `kind: "confirm"` に導線が**出ない**ことしか測っていない。** 確定後の遷移は
 *    `V10-M4-T03` の担当であり、本タスクは1バイトも書いていない。
 * 5. **【禁止】「見えない段は遮断されている」と読まない** —— **UI が出さないことは
 *    遮断ではない。** 遮断はサーバの 401 / 403 / 404 であり、ここでは1件も測っていない。
 * 6. **(f-2) の匿名経路は「`RoleProvider` で包まない」ことで再現している** ——
 *    **`AnonymousWorkspace` そのものを描いてはいない**(`web/src/AppWorkspace.tsx:451` の
 *    逐語「**`RoleProvider` で包まない**(意図的である)」に依った再現である)。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Manifest, View } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { ANONYMOUS, canUseView, RoleProvider, useRole } from "../src/auth/authz.tsx";
import { ViewHost } from "../src/views/ViewHost.tsx";
import { grantRules, viewRead } from "./role-rules.ts";

/**
 * **書ける立場**(`web/test/detail-view-after-save.test.tsx` と1バイトも同じ理由)——
 * **文字列リテラルで `role="owner"` と書くと biome の a11y 規則(`useValidAriaRole`)が
 * HTML の `role` 属性と誤認するので、変数経由で渡す。**
 */
const WRITER_ROLE: Role = "owner";
const OTHER_ROLE: Role = "editor";

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
};
const CREATED_ROW = {
  _id: CREATED_ID,
  _created_at: "2026-01-03T00:00:00Z",
  _updated_at: "2026-01-03T00:00:00Z",
  memo: "机",
};

let originalFetch: typeof fetch;

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

/** **役割の規則を1本も持たない題材**(面の既定は閉じているので、そのままでは段が出ない)。 */
function build(specs: readonly Record<string, unknown>[]): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "店",
      tables: [
        { id: "orders", name: "注文", fields: [{ id: "memo", name: "メモ", type: "text" }] },
        { id: "others", name: "別表", fields: [{ id: "memo", name: "メモ", type: "text" }] },
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
    if (method === "POST" && url === ORDERS_PATH) {
      return json({ record: CREATED_ROW }, 201);
    }
    /*
     * **`?view=<画面ID>` が付く**(題材が役割の規則を持つため。`web/src/api.ts` の名乗り)——
     * **完全一致で置くと単件の枝を素通りして一覧の枝に落ち、`record` が `undefined` になる。**
     */
    if (method === "GET" && url.startsWith(`${ORDERS_PATH}/${RECORD_ID}`)) {
      return json({ record: ORDER_ROW });
    }
    if (method === "GET" && (url.startsWith(ORDERS_PATH) || url.startsWith(OTHERS_PATH))) {
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

/** `form` を描いて保存し、遷移後の URL(パス)を返す。 */
async function submit(manifest: Manifest, viewId: string): Promise<string> {
  renderHost(manifest, viewId);
  const input = await screen.findByLabelText(/メモ/);
  fireEvent.change(input, { target: { value: "机" } });
  fireEvent.submit(input.closest("form") as HTMLFormElement);
  await waitFor(() => expect(window.location.pathname).not.toContain(viewId));
  return window.location.pathname;
}

// ---------------------------------------------------------------------------
// (a) `form` —— ボタンを出さない。保存が成立したら次の段へ行く(段が `after_save` に勝つ)
// ---------------------------------------------------------------------------

test("(a-1) 段を宣言した form で保存すると次の段へ行く(after_save を書いていても段が勝つ)", async () => {
  const manifest = grantAll(
    build([
      {
        id: "address",
        type: "form",
        flow: { id: "checkout", step: 1, kind: "input" },
        after_save: "order-list",
      },
      { id: "thanks", type: "list_view", flow: { id: "checkout", step: 2, kind: "input" } },
      { id: "order-list", type: "list_view" },
    ]),
  );
  expect(await submit(manifest, "address")).toBe(`/apps/${APP_ID}/views/thanks`);
});

test("(a-2) 段を宣言した form にも「次へ」のボタンは1つも出ない", async () => {
  const manifest = grantAll(
    build([
      { id: "address", type: "form", flow: { id: "checkout", step: 1, kind: "input" } },
      { id: "thanks", type: "list_view", flow: { id: "checkout", step: 2, kind: "input" } },
    ]),
  );
  renderHost(manifest, "address");
  await screen.findByLabelText(/メモ/);
  expect(screen.queryByTestId("flow-next")).toBeNull();
  expect(screen.queryByTestId("flow-next-button")).toBeNull();
});

test("(a-3) 次の段が同じ表の detail_view なら、保存が成立した行の _id が URL に載る", async () => {
  const manifest = grantAll(
    build([
      { id: "address", type: "form", flow: { id: "checkout", step: 1, kind: "input" } },
      {
        id: "confirm",
        type: "detail_view",
        flow: { id: "checkout", step: 2, kind: "confirm" },
      },
    ]),
  );
  expect(await submit(manifest, "address")).toBe(
    `/apps/${APP_ID}/views/confirm/records/${CREATED_ID}`,
  );
});

test("(a-4) 次の段が別の表の detail_view なら _id は1文字も載らない", async () => {
  const manifest = grantAll(
    build([
      { id: "address", type: "form", flow: { id: "checkout", step: 1, kind: "input" } },
      {
        id: "confirm",
        type: "detail_view",
        table: "others",
        flow: { id: "checkout", step: 2, kind: "confirm" },
      },
    ]),
  );
  expect(await submit(manifest, "address")).toBe(`/apps/${APP_ID}/views/confirm`);
});

test("(a-5) 次の段が list_view なら _id は1文字も載らない", async () => {
  const manifest = grantAll(
    build([
      { id: "address", type: "form", flow: { id: "checkout", step: 1, kind: "input" } },
      { id: "thanks", type: "list_view", flow: { id: "checkout", step: 2, kind: "input" } },
    ]),
  );
  const path = await submit(manifest, "address");
  expect(path).toBe(`/apps/${APP_ID}/views/thanks`);
  expect(path).not.toContain("records");
});

test("(a-6) 最後の段(次が無い)では今日どおりの規約に倒れる(after_save が効く)", async () => {
  const manifest = grantAll(
    build([
      {
        id: "address",
        type: "form",
        flow: { id: "checkout", step: 2, kind: "input" },
        after_save: "order-list",
      },
      { id: "cart", type: "list_view", flow: { id: "checkout", step: 1, kind: "input" } },
      { id: "order-list", type: "list_view" },
    ]),
  );
  expect(await submit(manifest, "address")).toBe(`/apps/${APP_ID}/views/order-list`);
});

test("(a-7) 次の段がマニフェストに居なければ規約に倒れる(段2〜段4 のまま)", async () => {
  const manifest = grantAll(
    build([
      { id: "address", type: "form", flow: { id: "checkout", step: 1, kind: "input" } },
      { id: "order-list", type: "list_view" },
    ]),
  );
  // **`after_save` も書いていないので、既定の段3(同じ表の `list_view`)へ倒れる。**
  expect(await submit(manifest, "address")).toBe(`/apps/${APP_ID}/views/order-list`);
});

// ---------------------------------------------------------------------------
// (b) `list_view` / `detail_view`(`kind: "input"`)—— 「次へ」の導線が出て、押すと進む
// ---------------------------------------------------------------------------

test("(b-1) 段を宣言した list_view に導線が出て、押すと次の段へ行く", async () => {
  const manifest = grantAll(
    build([
      { id: "cart", type: "list_view", flow: { id: "checkout", step: 1, kind: "input" } },
      { id: "address", type: "form", flow: { id: "checkout", step: 2, kind: "input" } },
    ]),
  );
  renderHost(manifest, "cart");
  await waitFor(() => expect(screen.getByTestId("flow-next")).toBeDefined());
  expect(screen.getByTestId("flow-next-button").textContent).toBe("次へ");
  screen.getByTestId("flow-next-button").click();
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/address`);
  });
});

test("(b-2) list_view は行を1件も指していないので、次の段が同じ表の detail_view でも _id を運ばない", async () => {
  const manifest = grantAll(
    build([
      { id: "cart", type: "list_view", flow: { id: "checkout", step: 1, kind: "input" } },
      { id: "confirm", type: "detail_view", flow: { id: "checkout", step: 2, kind: "confirm" } },
    ]),
  );
  // **URL に行を持たせても運ばない**(一覧は行を1件も指していないからである)。
  renderHost(manifest, "cart", { recordId: RECORD_ID });
  await waitFor(() => expect(screen.getByTestId("flow-next")).toBeDefined());
  screen.getByTestId("flow-next-button").click();
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/confirm`);
  });
});

test("(b-3) 段を宣言した detail_view(input)に導線が出て、押すと同じ表の次の段へ行を運ぶ", async () => {
  const manifest = grantAll(
    build([
      { id: "review", type: "detail_view", flow: { id: "checkout", step: 1, kind: "input" } },
      { id: "confirm", type: "detail_view", flow: { id: "checkout", step: 2, kind: "confirm" } },
    ]),
  );
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/review/records/${RECORD_ID}`);
  renderHost(manifest, "review", { recordId: RECORD_ID });
  await waitFor(() => expect(screen.getByTestId("flow-next")).toBeDefined());
  screen.getByTestId("flow-next-button").click();
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/confirm/records/${RECORD_ID}`);
  });
});

test("(b-4) detail_view から次の段が list_view のときは _id を運ばない", async () => {
  const manifest = grantAll(
    build([
      { id: "review", type: "detail_view", flow: { id: "checkout", step: 1, kind: "input" } },
      { id: "thanks", type: "list_view", flow: { id: "checkout", step: 2, kind: "input" } },
    ]),
  );
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/review/records/${RECORD_ID}`);
  renderHost(manifest, "review", { recordId: RECORD_ID });
  await waitFor(() => expect(screen.getByTestId("flow-next")).toBeDefined());
  screen.getByTestId("flow-next-button").click();
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/thanks`);
  });
});

// ---------------------------------------------------------------------------
// (c) 出ない条件(**fail-closed**)
// ---------------------------------------------------------------------------

test("(c-1) 段を宣言していない画面には導線ブロックが1つも出ない(器の子は今日どおり2つ)", async () => {
  const manifest = grantAll(build([{ id: "cart", type: "list_view" }]));
  const container = renderHost(manifest, "cart");
  await waitFor(() => expect(screen.getByTestId("view-renderer-list_view")).toBeDefined());
  expect(screen.queryByTestId("flow-next")).toBeNull();
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

test("(c-2) kind: confirm の detail_view には導線が出ない(確定後の遷移は本タスクの担当ではない)", async () => {
  const manifest = grantAll(
    build([
      { id: "confirm", type: "detail_view", flow: { id: "checkout", step: 1, kind: "confirm" } },
      { id: "thanks", type: "list_view", flow: { id: "checkout", step: 2, kind: "input" } },
    ]),
  );
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/confirm/records/${RECORD_ID}`);
  renderHost(manifest, "confirm", { recordId: RECORD_ID });
  await waitFor(() => expect(screen.getByTestId("view-renderer-detail_view")).toBeDefined());
  expect(screen.queryByTestId("flow-next")).toBeNull();
});

test("(c-3) 最後の段(次が無い)では導線が出ない", async () => {
  const manifest = grantAll(
    build([
      { id: "cart", type: "list_view", flow: { id: "checkout", step: 1, kind: "input" } },
      { id: "thanks", type: "list_view", flow: { id: "checkout", step: 2, kind: "input" } },
    ]),
  );
  renderHost(manifest, "thanks");
  await waitFor(() => expect(screen.getByTestId("view-renderer-list_view")).toBeDefined());
  expect(screen.queryByTestId("flow-next")).toBeNull();
});

test("(c-4) 次の位置を持つ画面がマニフェストに居なければ導線が出ない(欠番は apply 時に倒れるが、表示層も出さない)", async () => {
  const manifest = grantAll(
    build([{ id: "cart", type: "list_view", flow: { id: "checkout", step: 1, kind: "input" } }]),
  );
  renderHost(manifest, "cart");
  await waitFor(() => expect(screen.getByTestId("view-renderer-list_view")).toBeDefined());
  expect(screen.queryByTestId("flow-next")).toBeNull();
});

test("(c-5) 別の流れの同じ位置は次の段にならない(流れIDが違えば干渉しない)", async () => {
  const manifest = grantAll(
    build([
      { id: "cart", type: "list_view", flow: { id: "checkout", step: 1, kind: "input" } },
      { id: "signup", type: "form", flow: { id: "signup-flow", step: 2, kind: "input" } },
    ]),
  );
  renderHost(manifest, "cart");
  await waitFor(() => expect(screen.getByTestId("view-renderer-list_view")).toBeDefined());
  expect(screen.queryByTestId("flow-next")).toBeNull();
});

// ---------------------------------------------------------------------------
// (f) **次の段が見えない人には導線が出ない**(2経路を別々に測る)
// ---------------------------------------------------------------------------

test("(f-1) ログイン済みでも、次の段の読取が自分の役割に届いていなければ導線が出ない", async () => {
  const base = build([
    { id: "cart", type: "list_view", flow: { id: "checkout", step: 1, kind: "input" } },
    { id: "address", type: "form", flow: { id: "checkout", step: 2, kind: "input" } },
  ]);
  // **今の画面は自分に配り、次の段は別の役割にだけ配る。**
  const manifest = grantViews(grantViews(base, WRITER_ROLE, ["cart"]), OTHER_ROLE, ["address"]);
  renderHost(manifest, "cart");
  await waitFor(() => expect(screen.getByTestId("view-renderer-list_view")).toBeDefined());
  expect(screen.queryByTestId("flow-next")).toBeNull();
  // **同じ題材を、次の段が配られている役割で描けば出る**(条件が「見える人か」であることの裏取り)。
  cleanup();
  renderHost(manifest, "cart", { role: OTHER_ROLE });
  await waitFor(() => expect(screen.getByTestId("flow-next")).toBeDefined());
});

test("(f-2) 匿名(RoleProvider で包まない)で、anonymous に次の段が配られていなければ導線が出ない", async () => {
  const manifest = grantViews(
    build([
      { id: "cart", type: "list_view", flow: { id: "checkout", step: 1, kind: "input" } },
      { id: "address", type: "form", flow: { id: "checkout", step: 2, kind: "input" } },
    ]),
    WRITER_ROLE,
    ["cart", "address"],
  );
  renderHost(manifest, "cart", { anonymous: true });
  await waitFor(() => expect(screen.getByTestId("view-renderer-list_view")).toBeDefined());
  expect(screen.queryByTestId("flow-next")).toBeNull();
});

test("(f-2) 匿名でも anonymous に次の段の読取が配られていれば導線は出る(fail-closed ではない。実測)", async () => {
  const manifest = grantViews(
    build([
      { id: "cart", type: "list_view", flow: { id: "checkout", step: 1, kind: "input" } },
      { id: "address", type: "form", flow: { id: "checkout", step: 2, kind: "input" } },
    ]),
    "anonymous",
    ["cart", "address"],
  );
  renderHost(manifest, "cart", { anonymous: true });
  await waitFor(() => expect(screen.getByTestId("flow-next")).toBeDefined());
});

test("(f-2) 匿名経路の実測: RoleProvider の外で useRole() は null を返し、canUseView(null) は canUseView(ANONYMOUS) と一致する", () => {
  const seen: (Role | null)[] = [];
  function Probe() {
    seen.push(useRole());
    return null;
  }
  render(<Probe />);
  expect(seen).toEqual([null]);

  const manifest = grantViews(
    build([{ id: "address", type: "form", flow: { id: "checkout", step: 2, kind: "input" } }]),
    "anonymous",
    ["address"],
  );
  const address = viewOf(manifest, "address");
  expect(canUseView(null, manifest, address)).toBe(true);
  expect(canUseView(null, manifest, address)).toBe(canUseView(ANONYMOUS, manifest, address));

  const closed = grantViews(
    build([{ id: "address", type: "form", flow: { id: "checkout", step: 2, kind: "input" } }]),
    WRITER_ROLE,
    ["address"],
  );
  const closedAddress = viewOf(closed, "address");
  expect(canUseView(null, closed, closedAddress)).toBe(false);
  expect(canUseView(null, closed, closedAddress)).toBe(
    canUseView(ANONYMOUS, closed, closedAddress),
  );
});
