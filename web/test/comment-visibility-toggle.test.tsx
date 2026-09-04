/**
 * **アプリごとの設定で、画面のいちばん下の「この画面へのコメント」の入力欄を出し入れする**
 * (`V10-M31-T02`。台帳 `CM-G38` / `ADR-0379` 限定1 / 限定2 / 限定6。ユーザ決定 `D-V10-40`)。
 *
 * ## この検査が言えないこと(**先に書く。誇張しない**)
 *
 * 1. **`fetch` を差し替えている。本物のサーバを1度も叩いていない** —— 見ているのは
 *    「表示層が設定を受け取って何を描くか」だけである。**`GET /api/apps/:app_id/manifest`
 *    が本当にその設定を載せて返すかは、ここでは1件も測っていない**(そちらは
 *    `src/server/comment-visibility-http.test.ts` が持つ)。
 * 2. **`AppWorkspace` を1度も描いていない** —— **設定を器へ渡す配線(`web/src/AppWorkspace.tsx`)
 *    そのものは、この検査では1バイトも通っていない。** ここが測るのは器(`ViewHost`)の側だけである。
 * 3. **happy-dom であり、chromium で1度も確かめていない** —— 位置もピクセルも色も1つも見ていない。
 * 4. **【禁止】「書けなくなった」と読まない** —— **`write` は「欄を出すか」の合図であって、
 *    書込を止める壁ではない**(`D-V10-38`)。**`POST /api/apps/:app_id/comments` は今日も
 *    設定を1度も見ない。** **欄が出ていなくても、口を直に叩けば書ける。**
 * 5. **`read`(読む場所を出すか)の側は1要素も測っていない** —— **測るのは
 *    「`read` を倒しても書く欄には効かない」ことだけである**((d))。
 *
 * ## 【`V10-M32-T02`(2026-08-26)。台帳 `CM-G40`】**上の 5. の読み方が今日は割れる**
 *
 * **上の 1.〜5. は1バイトも書き換えていない。**
 *
 * - **「この1ファイルの中では」と読むなら、5. は今日も真である** —— **本ファイルは今日も
 *   `read` の側を1要素も測っておらず、測るのは書く欄((a)〜(d))だけである。**
 *   **本ファイルには `V10-M32-T02` の実装のための変更が1バイトも入っていない。**
 * - **「リポジトリ全体で」と読むなら、5. は今日は偽である** —— **`read` の側は
 *   `web/test/comment-list.test.tsx` の (k)〜(p) が測る**(OFF で0要素 / ON で1要素 /
 *   provider の外で false / `write` だけ倒しても出ない / 枝そのものが出ない /
 *   それでも読む口は閉じていない)。
 *
 * **同時に、器の側の判定式が1つから2つになった** —— **`web/src/views/ViewHost.tsx` に
 * `useCommentWriteEnabled`(非 export)と `useCommentReadEnabled`(export)の2本が在る。**
 * **【2026-08-26 訂正。`V10-M33-T01`。すぐ上の行は1バイトも消していない】**
 * **`useCommentWriteEnabled` は `useCommentPanel` に名前が変わった**(返すものが真偽から
 * 「出す部品(またはその不在)」になったため)。**非 export であることも、判定式が2本で
 * あることも1ミリも変わっていない。**
 * **`ADR-0379` 限定2 の逐語は「出し分けの判定が `web/src/` の中で1箇所ちょうど」であり、
 * 「書く欄の」とは1文字も書いていない** —— **したがって今日「限定2 を守っている」とは
 * 書けない。** **この緊張を数える検査は今日0件で、受け皿は `V10-M34-T02`
 * (`ADR-0380` の見張り)である**(実測は `useCommentReadEnabled` の doc に貼った)。
 *
 * **4. は今日も1ミリも変わらない** —— **`read` も「読む場所を出すか」の合図であって、
 * 読取を止める壁ではない**(`D-V10-38`)。**`GET /api/apps/:app_id/comments` も MCP の
 * `list_comments` も1バイトも閉じていない。**
 *
 * ## `src/kernel/` から**値**を1つも import していない
 *
 * **`scripts/kernel-import-drift.test.ts` が `src/kernel/` からの**値**の import を
 * 基準ファイル(`scripts/kernel-import-snapshot.txt`)で固定しているためである**
 * (`import type` は数えない)。**本ファイルは型しか import しないので、基準ファイルを1行も動かさない。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Manifest, View } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
// **【2026-08-26。`V10-M33-T01`。台帳 `CM-G43`】書く欄の部品は、器へ静的 `import` では
// なくコンテキストのスロット(`CommentVisibilityProvider` の `panel`)で渡すようになった
// (**配る版の成果物から書く欄のバイト列を落とすため**)。**`panel` は必須なので、この器を
// 張る検査はここでも部品を渡す** —— **渡さないと「設定が ON なら書く欄が1要素である」の
// 陽性対照が測れなくなる。** **測るものを1ミリも弱めていない**(製品では
// `web/src/AppWorkspace.tsx` が同じ `CommentPanel` を渡している)。
import { CommentPanel } from "../src/CommentPanel.tsx";
import { CommentVisibilityProvider, ViewHost } from "../src/views/ViewHost.tsx";
import { grantRules, viewRead } from "./role-rules.ts";

/**
 * **書ける立場**(`web/test/flow-position.test.tsx` と1バイトも同じ理由)——
 * **文字列リテラルで `role="owner"` と書くと biome の a11y 規則(`useValidAriaRole`)が
 * HTML の `role` 属性と誤認するので、変数経由で渡す。**
 */
const WRITER_ROLE: Role = "owner";

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
// 題材(**`web/test/flow-position.test.tsx` の骨格を写している**)
// ---------------------------------------------------------------------------

/**
 * **測る5通り** —— **画面の種別4つに、重ねて出す入力画面(`modal`)を足したものである。**
 * **`modal` を別枠にしているのは、器(`ViewShell`)がポータルへ差すので DOM 上の
 * 置き場所が他の4つと違うからである** —— **出し分けが器の分岐に依らないことを見る。**
 */
type Kind = "list_view" | "detail_view" | "report_view" | "form" | "form_modal";

const KINDS = ["list_view", "detail_view", "report_view", "form", "form_modal"] as const;

const SPECS: Record<Kind, Record<string, unknown>> = {
  list_view: { id: "cart", type: "list_view", table: "orders", columns: ["memo"] },
  detail_view: { id: "confirm", type: "detail_view", table: "orders" },
  report_view: {
    id: "sales",
    type: "report_view",
    table: "orders",
    report: { group_by: [{ field: "memo" }], aggregates: [{ type: "count" }] },
  },
  form: { id: "address", type: "form", table: "orders", fields: ["memo"] },
  form_modal: { id: "address-modal", type: "form", table: "orders", fields: ["memo"], modal: true },
};

/** その種別の本体が描かれたことを見る印。 */
const BODY_TESTID: Record<Kind, string> = {
  list_view: "view-renderer-list_view",
  detail_view: "view-renderer-detail_view",
  report_view: "view-renderer-report_view",
  form: "view-renderer-form",
  form_modal: "view-renderer-form",
};

/** **役割の規則を1本も持たない題材**(面の既定は閉じているので、そのままでは画面が出ない)。 */
function build(specs: readonly Record<string, unknown>[]): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "店",
      tables: [
        { id: "orders", name: "注文", fields: [{ id: "memo", name: "メモ", type: "text" }] },
      ],
      views: specs,
    },
  } as unknown as Manifest;
}

/** 全画面の読取を `owner` に配る(**positive 側の既定**)。 */
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

/** 器の**直接の子**の `data-testid` を並び順のまま取り出す。 */
function childTestIds(container: HTMLElement): (string | null)[] {
  return [...container.children].map((child) => child.getAttribute("data-testid"));
}

/**
 * **アプリごとの設定**。**`"no-provider"` は「器を provider の外で描く」場合である**
 * —— **材料が1つも届いていない状態の実測であり、(c) が見るのはこれである。**
 */
type Visibility = { write: boolean; read: boolean } | "no-provider";

function wrap(tree: ReactNode, visibility: Visibility): ReactNode {
  return visibility === "no-provider" ? (
    tree
  ) : (
    // **【2026-08-26。`V10-M33-T01`】旧行の逐語(1バイトも消していない)**:
    //   `<CommentVisibilityProvider value={visibility}>{tree}</CommentVisibilityProvider>`
    // **`panel` を足しただけで、`"no-provider"` の枝(provider の外)は1バイトも変えていない**
    // —— **(c) が見る「材料が1つも届いていない状態」はそのままである。**
    <CommentVisibilityProvider value={visibility} panel={CommentPanel}>
      {tree}
    </CommentVisibilityProvider>
  );
}

function renderKind(kind: Kind, visibility: Visibility): HTMLElement {
  const manifest = grantAll(build(KINDS.map((each) => SPECS[each])));
  const view = viewOf(manifest, SPECS[kind].id as string);
  const recordId = kind === "detail_view" ? RECORD_ID : undefined;
  window.history.replaceState(
    {},
    "",
    recordId === undefined
      ? `/apps/${APP_ID}/views/${view.id}`
      : `/apps/${APP_ID}/views/${view.id}/records/${recordId}`,
  );
  const tree = (
    <RoleProvider role={WRITER_ROLE}>
      <ViewHost appId={APP_ID} manifest={manifest} view={view} recordId={recordId} />
    </RoleProvider>
  );
  return render(wrap(tree, visibility)).container;
}

async function settle(kind: Kind): Promise<void> {
  await waitFor(() => {
    expect(screen.getAllByTestId(BODY_TESTID[kind]).length).toBeGreaterThan(0);
  });
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

// ---------------------------------------------------------------------------
// (a) / (b) 5通りすべてで、設定のとおりに出入りする
// ---------------------------------------------------------------------------

for (const kind of KINDS) {
  test(`(a) V10-M31-T02: ${kind}: 設定が OFF なら comment-panel が0要素である`, async () => {
    renderKind(kind, { write: false, read: false });
    await settle(kind);
    expect(screen.queryAllByTestId("comment-panel")).toHaveLength(0);
  });

  test(`(b) V10-M31-T02: ${kind}: 設定が ON なら comment-panel が1要素である(陽性対照)`, async () => {
    renderKind(kind, { write: true, read: false });
    await settle(kind);
    expect(screen.queryAllByTestId("comment-panel")).toHaveLength(1);
  });
}

// ---------------------------------------------------------------------------
// (c) 材料が1つも届いていないとき —— **fail-closed**
// ---------------------------------------------------------------------------

test("(c) V10-M31-T02: 器を provider の外で描くと、5通りすべてで comment-panel が0要素である", async () => {
  for (const kind of KINDS) {
    renderKind(kind, "no-provider");
    await settle(kind);
    expect(screen.queryAllByTestId("comment-panel")).toHaveLength(0);
    cleanup();
  }
  // **裏取り(陽性対照)**: **同じ経路に設定を届ければ出る** —— **題材が描けないから0件、ではない。**
  renderKind("list_view", { write: true, read: false });
  await settle("list_view");
  expect(screen.queryAllByTestId("comment-panel")).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// (d) 2つが1つに畳まれていない
// ---------------------------------------------------------------------------

test("(d) V10-M31-T02: read だけ倒しても書く欄には1要素も出ない(write と read は別である)", async () => {
  for (const kind of KINDS) {
    renderKind(kind, { write: false, read: true });
    await settle(kind);
    expect(screen.queryAllByTestId("comment-panel")).toHaveLength(0);
    cleanup();
  }
  // **裏取り(陽性対照)**: **`write` を倒せば出る。**
  renderKind("list_view", { write: true, read: false });
  await settle("list_view");
  expect(screen.queryAllByTestId("comment-panel")).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// (e) OFF で落ちるのは1要素だけである
// ---------------------------------------------------------------------------

test("(e) V10-M31-T02: OFF で落ちるのは comment-panel の1要素だけで、器の子はほかに1つも減らない", async () => {
  const manifest = grantAll(
    build([
      {
        id: "cart",
        type: "list_view",
        table: "orders",
        columns: ["memo"],
        flow: { id: "checkout", step: 1, kind: "input" },
      },
      {
        id: "thanks",
        type: "list_view",
        table: "orders",
        columns: ["memo"],
        flow: { id: "checkout", step: 2, kind: "input" },
      },
    ]),
  );
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/cart`);
  const tree = (
    <RoleProvider role={WRITER_ROLE}>
      <ViewHost appId={APP_ID} manifest={manifest} view={viewOf(manifest, "cart")} />
    </RoleProvider>
  );

  const onContainer = render(wrap(tree, { write: true, read: false })).container;
  await waitFor(() => expect(screen.getByTestId("view-renderer-list_view")).toBeDefined());
  const on = childTestIds(onContainer);
  expect(on).toEqual([
    "view-title",
    "flow-position",
    "flow-back",
    "view-renderer-list_view",
    "flow-next",
    "comment-panel",
  ]);
  cleanup();

  const offContainer = render(wrap(tree, { write: false, read: false })).container;
  await waitFor(() => expect(screen.getByTestId("view-renderer-list_view")).toBeDefined());
  const off = childTestIds(offContainer);
  expect(off).toEqual([
    "view-title",
    "flow-position",
    "flow-back",
    "view-renderer-list_view",
    "flow-next",
  ]);
  // **落ちたのは1要素ちょうどである**(並びの残りが1つも動いていない)。
  expect(off).toEqual(on.filter((id) => id !== "comment-panel"));
  expect(on.length - off.length).toBe(1);
});
