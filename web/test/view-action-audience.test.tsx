/**
 * **操作起点1本ごとに「見せる相手」を宣言する**(`V5-M23-T02`。`L-G14` / [`ADR-0177`](../../docs/adr/0177-view-action-audience.md))。
 *
 * **審査記録**: [`docs/plan/v5/records/v5-m20.md`](../../docs/plan/v5/records/v5-m20.md) §2-4。
 * **実施記録**: [`docs/plan/v5/records/v5-m23.md`](../../docs/plan/v5/records/v5-m23.md)。
 *
 * ## 【`V8-M20`(2026-08-10)。台帳 `J-G29`。手続きは `ADR-0301`】**宣言の置き場が移った**
 *
 * **`view_action.audience` は廃止された。** **代わりに担うのは
 * `app.roles[].rules` の `{ target: "action", view: <画面ID>, action: <ボタンID>,
 * can: ["read"] }` である**(書込の壁の側は `{ target: "table", ..., can: ["write"] }`)。
 * **表示層の再実装(`web/src/views/action-audience.ts` の `isActionAudienceAllowed`)は
 * 削除され、判定はサーバと同じ `judgeRoleAccess` を呼ぶ `canUseAction` 1本になった。**
 *
 * **【正直に書く。置き直しても同じにならない点が2つある】**
 *
 * 1. **面はボタンを `(画面ID, ボタンID)` で名指しする** —— **`view_action.id` を書いて
 *    いない操作起点は名指しできず、壁が1本も立たない。** **旧層は `id` が無くても効いて
 *    いた。** **(g) の3本目がこの穴をそのまま固定する。**
 * 2. **「誰にも見せない」を書く形が無くなった。** **旧層では `audience: []`(空配列)が
 *    それを表していた。** **面の `can` は「できること」の列挙であり、引き算(拒否)も
 *    空配列も書けない**(`J-G2` の限定 / スキーマの `minItems: 1`)。
 *    **その1本は消した**(下の「消した検査」の注記)。
 *
 * ## 判定は AND 1つである(`ADR-0177` §Decision 3 / 限定5)
 *
 * **出す = (`L-G13` の自動判定が真) かつ (面の規則がその起点を名指ししていないか、
 * 見ている人の役割に許されている)。** **「どちらが勝つか」の規則を1つも作っていない** ——
 * **右辺に1項足しただけである。** **(c) 群がこの順序を入れ替えられないことを固定する。**
 *
 * ## この検査が言えないこと(**先に書く。誇張しない**)
 *
 * 1. **【禁止】「権限のある機能だけが出るようになった」と書かない**(`ADR-0177` §限界3 /
 *    06 §9 の 7)—— **「出さないようにした」であって「押せないようにした」ではない。**
 *    **サーバの応答は1バイトも変わらない**(限定6)。
 * 2. **`ADR-0177` §限界2 が予告した代償(「なぜ出ないか」を追いにくくなる)を1ミリも
 *    解消していない。** **本ファイルは判断が2段であることを固定するだけである。**
 * 3. **匿名(`anonymous`)を名指しした操作起点が、未ログインの相手に出るかどうかは
 *    固定できていない** —— **表示層は「未ログイン」と「provider の外」をどちらも `null` で
 *    受け取るため、区別できない。** **(e) 群が今日の挙動をそのまま記録する。**
 *    **これは限界であり、`v5-m23.md` §4-2 に書いた。**
 *    **【`V8-M20` / `J-G29`。ここも向きが変わった。旧文を1バイトも消していない】**
 *    **旧文の逐語は「**(e) 群が今日の挙動(fail-closed = 出さない)をそのまま記録する**」で
 *    ある。** **今日は fail-closed ではない** —— **面では未ログインは `anonymous` を主体と
 *    して判定される**(`J-G11`)ので、**`anonymous` を名指しした起点は `null` の相手に出る。**
 *    **`RoleProvider` が包んでいない subtree も同じ扱いになる**(表示層は両者を区別できない)。
 *    **【禁止の履行】これを「同じ挙動を保った」と書かない。**
 * 4. **ここは happy-dom である。** **本物のブラウザで1度も押していない。**
 *
 * ## 【`V8-M26`(2026-08-10)。ユーザ決定 `D-V8-45` / `D-V8-65`】**既定が「出さない」へ倒れた**
 *
 * **上の「判定は AND 1つである」の右辺、「**面の規則がその起点を名指ししていないか**、
 * 見ている人の役割に許されている」は今日から偽である**(**旧文は1バイトも消していない**)——
 * **`V8-M26-T03` が `judgeRoleAccess` の既定を閉じる側へ倒し、`target: "action"` は
 * 規則が1本も名指ししていなければ拒否される。** **役割を1つも宣言していないアプリも
 * 閉じる**(`D-V8-65`)。**未ログインにも及ぶ**(台帳 `T-G26a`)。
 *
 * **反転させた検査は4本**((b) の2本 / (e) の3本目 / (g) の2本目)。
 * **どれも旧の期待値をその場に逐語で残した。**
 *
 * **題材の側では、行き先の画面2本(`order-form` / `order-detail`)に画面 × 読取の規則を
 * 足した** —— **ボタンの規則を測る前に `canUseView` で落ちるのを避けるためであり、
 * ボタンの規則は1本も足していない**(**そこが本ファイルの主題だからである**)。
 *
 * **【禁止の履行】これを「同じ挙動を保った」と書かない。既定は反転した。**
 *
 * ## 【`V8-M20`】消した検査(1本)。**逐語で残す**
 *
 * - **`test("(g) 空配列は「誰にも見せない」である(宣言が無いことと混ぜない)")`**
 *   **本体**: `expect(isActionAudienceAllowed({ ...LINK, audience: [] }, "owner")).toBe(false);`
 *   **消した理由**: **その語彙(`audience` の空配列)が無くなり、面には「誰にも見せない」を
 *   書く形が1つも無いためである**(引き算を持たない。`J-G2`)。
 *   **【正直に書く】これは「同じことが面で書ける」の反例である。** **置き直していない。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { DetailView, ListView, Manifest, RoleDeclaration } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { canUseAction, RoleProvider } from "../src/auth/authz.tsx";
import { resolveRowActionDestination } from "../src/navigation.tsx";
import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";
import { grantRules, viewRead } from "./role-rules.ts";

const APP_ID = "shop";
const CARTS_PATH = `/api/apps/${APP_ID}/tables/carts/records`;
const ORDERS_PATH = `/api/apps/${APP_ID}/tables/orders/records`;
const CART_ID = "cart-a";

const CART_ROW = {
  _id: CART_ID,
  _created_at: "2026-01-01T00:00:00Z",
  _updated_at: "2026-01-02T00:00:00Z",
  label: "かご1",
  done: false,
};

/** 「この画面のこのボタンを、この役割たちにだけ見せる」を面の規則へ組み立てる。 */
function actionRules(
  entries: { view: string; action: string; roles: string[] }[],
): RoleDeclaration[] {
  const roleIds = [...new Set(entries.flatMap((entry) => entry.roles))];
  return roleIds.map((id) => ({
    id,
    rules: entries
      .filter((entry) => entry.roles.includes(id))
      .map((entry) => ({
        target: "action" as const,
        view: entry.view,
        action: entry.action,
        can: ["read" as const],
      })),
  }));
}

/**
 * **操作起点の行き先の画面を「開ける」ことにする相手**(`V8-M26`)。
 *
 * **本ファイルの主題はボタン(`target: "action"`)であって画面ではない。**
 * **それでも画面の規則が要るのは、`V8-M26-T03` が既定を閉じる側へ倒したためである** ——
 * **`ListViewRenderer` / `DetailViewRenderer` は3形目・1形目の起点を出す前に
 * `canUseView`(行き先の画面)を見るので、行き先を誰も名指ししていないと
 * **ボタンの規則を測る前に**落ちてしまう。**
 */
const DESTINATION_ROLES = ["owner", "editor", "viewer", "customer", "anonymous"] as const;

function manifest(entries: { view: string; action: string; roles: string[] }[] = []): Manifest {
  const built = {
    app: {
      id: APP_ID,
      name: "店",
      tables: [
        {
          id: "carts",
          name: "かご",
          fields: [
            { id: "label", name: "名前", type: "text" },
            { id: "done", name: "済", type: "boolean" },
          ],
        },
        {
          id: "orders",
          name: "注文",
          fields: [
            { id: "cart", name: "かご", type: "reference", reference_table: "carts" },
            { id: "memo", name: "メモ", type: "text" },
          ],
        },
      ],
      views: [
        { id: "cart-list", type: "list_view", table: "carts", columns: ["label"] },
        { id: "cart-detail", type: "detail_view", table: "carts" },
        { id: "order-detail", type: "detail_view", table: "orders" },
        { id: "order-form", type: "form", table: "orders", fields: ["cart", "memo"] },
      ],
      roles: entries.length === 0 ? [] : actionRules(entries),
    },
  } as unknown as Manifest;
  // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`】行き先の画面2本だけを開ける。**
  // **足すのは画面 × 読取だけであり、表・項目・ボタンの規則は1本も足していない** ——
  // **ボタンの規則は各検査が `listRule` / `detailRule` で1本ずつ足す(そこが主題である)。**
  // **`cart-list` / `cart-detail`(いま見ている画面そのもの)は名指ししていない** ——
  // **名指しすると `viewIdForRecordRequest` がレコード取得の URL に `?view=` を載せ、
  // 上の fetch のスタブ(`url === ${CARTS_PATH}/${CART_ID}` の完全一致)が外れるためである。**
  return grantRules(built, DESTINATION_ROLES, [viewRead("order-form"), viewRead("order-detail")]);
}

/**
 * 1形目(遷移)。
 * **【`V8-M20` / `J-G29`】`id` を書いた** —— **面はボタンを `(画面ID, ボタンID)` で
 * 名指しするので、識別子が無いと名指しできない**(旧層は `id` が無くても効いていた)。
 */
const NAVIGATE = {
  id: "go-order-form",
  form: "order-form",
  prefill: { field: "cart" },
  name: "注文を作る",
};
/** 3形目(行き先の宣言)。 */
const LINK = { id: "go-order-detail", view: "order-detail", name: "会計へ進む" };
/** 2形目(値の書換)。**詳細画面にだけ書ける。** */
const SET = { id: "mark-done", set: { field: "done", value: true }, name: "済にする" };

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
    if (method === "GET" && url === `${CARTS_PATH}/${CART_ID}`) {
      return json({ record: CART_ROW });
    }
    if (method === "GET" && url.startsWith(CARTS_PATH)) {
      return json({ records: [CART_ROW], total: 1 });
    }
    if (method === "GET" && url.startsWith(ORDERS_PATH)) {
      return json({ records: [], total: 0 });
    }
    return json({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/cart-list`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

/** `role` に `null` を渡すと **`RoleProvider` で包まない**(= provider の外 / 未ログイン)。 */
async function renderList(
  actions: unknown[],
  role: Role | null,
  built: Manifest = manifest(),
): Promise<void> {
  const target = { ...(built.app.views[0] as ListView), actions } as ListView;
  const tree = <ListViewRenderer appId={APP_ID} manifest={built} view={target} />;
  render(role === null ? tree : <RoleProvider role={role}>{tree}</RoleProvider>);
  await waitFor(() => expect(screen.getAllByTestId("list-row").length).toBe(1));
}

async function renderDetail(
  actions: unknown[],
  role: Role,
  built: Manifest = manifest(),
): Promise<void> {
  const target = { ...(built.app.views[1] as DetailView), actions } as DetailView;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/cart-detail/records/${CART_ID}`);
  render(
    <RoleProvider role={role}>
      <DetailViewRenderer appId={APP_ID} manifest={built} view={target} recordId={CART_ID} />
    </RoleProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("detail-field-label")).toBeDefined());
}

/** 一覧(`cart-list`)のボタン1本を、その役割たちにだけ見せる規則。 */
function listRule(action: string, roles: string[]): Manifest {
  return manifest([{ view: "cart-list", action, roles }]);
}

/** 詳細(`cart-detail`)のボタン1本を、その役割たちにだけ見せる規則。 */
function detailRule(action: string, roles: string[]): Manifest {
  return manifest([{ view: "cart-detail", action, roles }]);
}

// ---------------------------------------------------------------------------
// (a) 一覧 —— 名指しした相手にだけ出る
// ---------------------------------------------------------------------------

test("(a) 遷移の形を面が名指しすると、規則の外の相手には出ない(書ける相手であっても)", async () => {
  // **【`V8-M20` / `J-G29`】旧テスト名(逐語)**: 「(a) 遷移の形に audience を書くと、
  // 列挙から外れた相手には出ない(書ける相手であっても)」。
  await renderList([NAVIGATE], "editor", listRule("go-order-form", ["owner"]));
  expect(screen.queryByTestId("list-action-origin-order-form")).toBeNull();
});

test("(a) 同じ宣言で、列挙に載っている相手には出る", async () => {
  await renderList([NAVIGATE], "owner", listRule("go-order-form", ["owner"]));
  expect(screen.getAllByTestId("list-action-origin-order-form")).toHaveLength(1);
});

test("(a) 行き先の宣言(3形目)にも同じ1本が当たる", async () => {
  await renderList([LINK], "viewer", listRule("go-order-detail", ["owner"]));
  expect(screen.queryByTestId("list-action-link-order-detail")).toBeNull();
});

test("(a) 行き先の宣言で、列挙に載っている相手には出る", async () => {
  await renderList([LINK], "viewer", listRule("go-order-detail", ["viewer", "owner"]));
  expect(screen.getAllByTestId("list-action-link-order-detail")).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// (b) 既定は「出す」(`ADR-0177` 限定4)—— **反転させていない**
//
// **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`。上の見出しは今日から偽である。
//   1バイトも消していない】** **`V8-M26-T03` が `judgeRoleAccess` の既定を閉じる側へ
//   倒したので、`target: "action"` の既定は「出す」ではなく「出さない」になった。**
//   **`ADR-0177` 限定4 は画面の側の宣言に対する限定だったが、今日その位置に在るのは
//   面の1本であり、面の既定が閉じた以上こちらも閉じている。**
// ---------------------------------------------------------------------------

test("(b) 面が名指ししていない操作起点は、今日から出ない(V8-M26 で既定が反転した)", async () => {
  // **【`V8-M20` / `J-G29`】旧テスト名(逐語)**: 「(b) audience を1つも書かない操作起点は、
  // 着手前どおり出る」。**面の既定も「規則の無い対象は管轄外(全許可)」であり、
  // ここは向きが一致している。**
  //
  // **【`V8-M26` で期待値を反転させた。上の逐語も含めて1バイトも消していない】**
  // **`V8-M20` のテスト名**: 「(b) 面が名指ししていない操作起点は、着手前どおり出る」。
  // **`V8-M20` の期待値(逐語)**:
  //   `expect(screen.getAllByTestId("list-action-origin-order-form")).toHaveLength(1);`
  //   `expect(screen.getAllByTestId("list-action-link-order-detail")).toHaveLength(1);`
  // **今日**: **役割を1つも宣言していないアプリのボタンも閉じる**(`D-V8-65`)。
  // **【禁止の履行】これを「同じ挙動を保った」と書かない。既定は反転した。**
  await renderList([NAVIGATE, LINK], "owner");
  expect(screen.queryByTestId("list-action-origin-order-form")).toBeNull();
  expect(screen.queryByTestId("list-action-link-order-detail")).toBeNull();
});

test("(b) 同じ画面に、宣言のある起点と無い起点を並べられる(V8-M26 以後は無い方も出ない)", async () => {
  // **【`V8-M26` で期待値を反転させた。旧の逐語を1バイトも消していない】**
  // **旧テスト名**: 「(b) 同じ画面に、宣言のある起点と無い起点を並べられる
  // (無い方は今日どおり出る)」。
  // **旧の期待値(逐語)**:
  //   `expect(screen.getAllByTestId("list-action-link-order-detail")).toHaveLength(1);`
  // **今日**: **名指しされていないボタンは閉じる側に倒れるので、「宣言のある起点と
  // 無い起点の差」は画面の上では見えなくなった** —— **どちらも出ない。**
  // **【正直に書く】この検査が旧に持っていた区別する力は、今日ここでは失われている。**
  await renderList([NAVIGATE, LINK], "viewer", listRule("go-order-form", ["owner"]));
  expect(screen.queryByTestId("list-action-origin-order-form")).toBeNull();
  expect(screen.queryByTestId("list-action-link-order-detail")).toBeNull();
});

// ---------------------------------------------------------------------------
// (c) 判定は AND 1つ(`ADR-0177` 限定5)—— **順序を入れ替えられない**
// ---------------------------------------------------------------------------

test("(c) 自動判定が偽なら、宣言に自分が載っていても出ない(宣言は自動判定を上書きしない)", async () => {
  // **`viewer` は `orders` に書けない**(`canWriteRole` が偽)。**宣言では覆せない。**
  await renderList([NAVIGATE], "viewer", listRule("go-order-form", ["viewer"]));
  expect(screen.queryByTestId("list-action-origin-order-form")).toBeNull();
});

test("(c) 宣言が偽なら、自動判定が真でも出ない(自動判定は宣言を上書きしない)", async () => {
  await renderList([NAVIGATE], "owner", listRule("go-order-form", ["viewer"]));
  expect(screen.queryByTestId("list-action-origin-order-form")).toBeNull();
});

// ---------------------------------------------------------------------------
// (d) 詳細画面でも同じ1本が当たる(**実装を2箇所に割っていない**)
// ---------------------------------------------------------------------------

test("(d) 詳細画面の遷移の形にも当たる", async () => {
  await renderDetail([NAVIGATE], "editor", detailRule("go-order-form", ["owner"]));
  expect(screen.queryByTestId("action-origin-order-form")).toBeNull();
});

test("(d) 詳細画面の値の書換(set)の形にも当たる", async () => {
  await renderDetail([SET], "editor", detailRule("mark-done", ["owner"]));
  expect(screen.queryByTestId("action-set-done")).toBeNull();
});

test("(d) 詳細画面で宣言に載っていれば set 形も出る", async () => {
  await renderDetail([SET], "editor", detailRule("mark-done", ["owner", "editor"]));
  expect(screen.getAllByTestId("action-set-done")).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// (e) 未ログイン / provider の外(**今日の挙動をそのまま記録する。誇張しない**)
// ---------------------------------------------------------------------------

test("(e) ロールが分からない相手には、自分を名指ししていない起点を出さない", async () => {
  // **【`V8-M20` / `J-G29`】旧テスト名(逐語)**: 「(e) ロールが分からない相手には、
  // 宣言のある起点を出さない(fail-closed)」。
  // **旧の題材**: `audience: ["anonymous"]` を書いた起点を `null` の相手に見せると
  // **出なかった**(表示層が `null` を列挙と突き合わせて必ず外していた)。
  // **今日**: **面では未ログインは `anonymous` を主体として判定される**(`J-G11`)ので、
  // **`anonymous` を名指しした起点は出る**(下の1本がその向きを固定する)。
  // **したがってここで測るのは「自分を名指ししていない規則の外では出ない」ことに絞った。**
  await renderList([LINK], null, listRule("go-order-detail", ["owner"]));
  expect(screen.queryByTestId("list-action-link-order-detail")).toBeNull();
});

test("【向きが変わった】(e) anonymous を名指しした起点は、ロールが分からない相手に出る", async () => {
  // **【`V8-M20` / `J-G29` で期待値を反転させた。旧の逐語は上のテストのコメントに残した】**
  // **旧**: `expect(screen.queryByTestId("list-action-link-order-detail")).toBeNull();`
  //         (= 出さない。表示層が `null` を必ず外していたための fail-closed)。
  // **今日**: **面は `null` を `anonymous` として判定するので出る。**
  // **【誇張しない】表示層は「未ログイン」と「provider の外」を区別できないので、
  // `RoleProvider` が包んでいない subtree にも同じ起点が出る。** **これは置き直しで
  // 開いた側の変化であり、隠さずに固定しておく。**
  // **【UI が出すことは許可ではない】遮断はサーバである**(`ADR-0177` 限定6)。
  await renderList([LINK], null, listRule("go-order-detail", ["anonymous"]));
  expect(screen.getAllByTestId("list-action-link-order-detail")).toHaveLength(1);
});

test("(e) ロールが分からない相手には、宣言の無い起点も今日から出ない(V8-M26 で既定が反転した)", async () => {
  // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65` で期待値を反転させた。
  //   旧の逐語を1バイトも消していない】**
  // **旧テスト名**: 「(e) ロールが分からない相手でも、宣言の無い起点は今日どおり出る
  // (既定を反転させていない)」。
  // **旧の期待値(逐語)**:
  //   `expect(screen.getAllByTestId("list-action-link-order-detail")).toHaveLength(1);`
  // **今日**: **未ログイン(`anonymous`)にも閉じる既定が及ぶ**(台帳 `T-G26a`)。
  // **【禁止の履行】これを「同じ挙動を保った」と書かない。既定は反転した。**
  await renderList([LINK], null);
  expect(screen.queryByTestId("list-action-link-order-detail")).toBeNull();
});

// ---------------------------------------------------------------------------
// (f) `visible_when` と併用しても両方が効く(**2つ目の「隠す」規則を作っていない**)
// ---------------------------------------------------------------------------

test("(f) 面の判定が真でも visible_when が偽なら出ない", async () => {
  await renderList(
    [{ ...LINK, visible_when: { field: "label", equals: "別のかご" } }],
    "owner",
    listRule("go-order-detail", ["owner"]),
  );
  expect(screen.queryByTestId("list-action-link-order-detail")).toBeNull();
});

test("(f) 面の判定が真で visible_when も真なら出る", async () => {
  await renderList(
    [{ ...LINK, visible_when: { field: "label", equals: "かご1" } }],
    "owner",
    listRule("go-order-detail", ["owner"]),
  );
  expect(screen.getAllByTestId("list-action-link-order-detail")).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// (g) **これは先回りガードであって防御ではない**(`V5-M23-T03`。`L-G16` / `ADR-0177` 限定6)
// ---------------------------------------------------------------------------

/**
 * **出さないことと、行けないことを混ぜない。**
 *
 * **`canUseAction` が偽を返しても、行き先を決める関数
 * (`resolveRowActionDestination`)は1バイトも変わらない** —— **同じ行き先を返し続ける。**
 * **したがって URL を直に開けば今日どおりその画面に着く。**
 * **止めるのはサーバである。**
 */
test("(g) 宣言で隠した操作起点でも、行き先を決める関数は同じ行き先を返し続ける(出さない ≠ 行けない)", () => {
  // **【`V8-M20` / `J-G29`】旧の判定は
  // `isActionAudienceAllowed(hidden, "viewer")`(`web/src/views/action-audience.ts`)だった。**
  // **その表示層の再実装は削除され、今日はサーバと同じ `judgeRoleAccess` を呼ぶ
  // `canUseAction` 1本である。**
  const built = listRule("go-order-detail", ["owner"]);
  expect(canUseAction(built, "cart-list", LINK, "viewer")).toBe(false);
  // **同じ規則のまま、行き先は今日どおり解ける。**
  expect(resolveRowActionDestination(built, APP_ID, LINK as never, CART_ID)).toEqual({
    kind: "view",
    appId: APP_ID,
    viewId: "order-detail",
    recordId: CART_ID,
  });
});

test("(g) 面が名指ししていない操作起点の判定は、今日から偽である(V8-M26 で既定が反転した)", () => {
  // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65` で期待値を反転させた。
  //   旧の逐語を1バイトも消していない】**
  // **旧テスト名**: 「(g) 面が名指ししていない操作起点の判定は真である
  // (既定を反転させていない)」。
  // **旧の期待値(逐語)**:
  //   `expect(canUseAction(built, "cart-list", LINK, "viewer")).toBe(true);`
  //   `expect(canUseAction(built, "cart-list", NAVIGATE, "customer")).toBe(true);`
  // **今日**: **`canUseAction` はサーバと同じ `judgeRoleAccess` を呼ぶので、
  // `V8-M26-T03` が倒した既定がそのままここに出る。**
  // **【誇張しない】識別子(`id`)を書いていない起点は今日も真である**(次の1本)——
  // **閉じたのは「名指しできるのに名指しされていない」ボタンだけである。**
  const built = manifest();
  expect(canUseAction(built, "cart-list", LINK, "viewer")).toBe(false);
  expect(canUseAction(built, "cart-list", NAVIGATE, "customer")).toBe(false);
});

test("(g) 識別子(id)を書いていない操作起点は、面から名指しできないので今日も出る", () => {
  // **【`V8-M20` / `J-G29` が足した1本。誇張しない】**
  // **旧層(`view_action.audience`)は `id` が無くても効いていた。** **面は
  // `(画面ID, ボタンID)` で名指しするので、`id` を書いていない起点には壁が1本も立たない。**
  // **これは置き直しで開いた穴であり、隠さずに固定しておく。**
  const withoutId = { view: "order-detail", name: "会計へ進む" };
  const built = listRule("go-order-detail", ["owner"]);
  expect(canUseAction(built, "cart-list", withoutId, "viewer")).toBe(true);
});
