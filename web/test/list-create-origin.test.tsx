/**
 * **一覧(`list_view`)の上部に出る「新規作成」の口**(`V10-M3-T01(a)`)。
 *
 * **宣言のキーを1つも作っていない** —— **表示層の既定挙動である。**
 * マニフェストにも MCP の説明文にも、この口を出す/出さないを書く場所は1文字も無い。
 *
 * ## この検査が言えないこと(**先に書く。誇張しない**)
 *
 * 1. **【禁止】「一覧から新規作成できるようになった」を、本物のブラウザで押す前に総括しない。**
 *    **ここは happy-dom であり、chromium で1度も確かめていない。**
 * 2. **UI に出さないことは「押せない」ことではない** —— **最終防衛線はサーバの 401 / 403 /
 *    404 であり、本ファイルは `fetch` をスタブしているので「サーバが実際に拒む」ことを
 *    1件も測っていない。**
 * 3. **【禁止】「押しても必ず失敗する導線を消した」と書かない**(実装側ヘッダと同じ理由)——
 *    **`canWriteRole` の第2引数は実物では使われていない**(`web/src/auth/authz.tsx:233` の
 *    逐語 `_table?: Table | undefined`)ので、**止まるのは viewer / 未ログイン / ロール不明の
 *    3つだけ**である。**宣言された非運営の役割は、その表への書込付与が1本も無くても
 *    この口が出る。**本ファイルの (f) はその3つのうち viewer 1つしか測っていない。
 * 4. **`st_no_direct_create` を宣言した表で「サーバが本当に create を拒む」ことは1件も
 *    測っていない**(それは `src/server/` 側の検査の担当である)。ここで測るのは
 *    **表示層がその宣言を読んで口を出さない**ことだけである。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ListView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";
import { grantRules, viewRead } from "./role-rules.ts";

const APP_ID = "shop";
const RECORDS_PATH = `/api/apps/${APP_ID}/tables/goods/records`;

/** 2行。**行の存在を待つためだけに使う**(本タスクは行ごとの口を1つも作らない)。 */
const ROWS = [
  {
    _id: "goods-a",
    _created_at: "2026-01-01T00:00:00Z",
    _updated_at: "2026-01-02T00:00:00Z",
    name: "在庫あり",
    stock: 3,
  },
  {
    _id: "goods-b",
    _created_at: "2026-01-01T00:00:00Z",
    _updated_at: "2026-01-02T00:00:00Z",
    name: "在庫なし",
    stock: 0,
  },
];

let originalFetch: typeof fetch;

type BuildOptions = {
  /** `goods` を対象にする `form` の id を**定義順に**並べたもの。 */
  goodsForms?: readonly string[];
  /** `goods` に予約規約フィールド `st_no_direct_create` を足すか。 */
  noDirectCreate?: boolean;
};

/**
 * 題材。**`goods`(一覧の対象)と `carts`(別テーブル)の2表**を持ち、
 * **`carts` の form は常に1本ある** —— 「同じテーブルの form が在るか」を測る条件が、
 * 「form がそもそも1本も無い」と同じことになってしまわないようにするためである。
 */
function build(options: BuildOptions = {}): Manifest {
  const goodsForms = options.goodsForms ?? ["goods-form"];
  const goodsFields: Record<string, unknown>[] = [
    { id: "name", name: "名前", type: "text" },
    { id: "stock", name: "在庫", type: "number" },
  ];
  if (options.noDirectCreate === true) {
    // **`required` を書かない** —— 書くと規約(`noDirectCreateField`)の条件から外れて
    // ただの boolean 項目になる(`src/server/owner-scope.ts` の3条件)。
    goodsFields.push({ id: "st_no_direct_create", name: "直接作成の遮断", type: "boolean" });
  }
  return {
    app: {
      id: APP_ID,
      name: "店",
      tables: [
        { id: "goods", name: "商品", fields: goodsFields },
        {
          id: "carts",
          name: "カート",
          fields: [{ id: "item", name: "商品", type: "reference", reference_table: "goods" }],
        },
      ],
      views: [
        { id: "goods-list", type: "list_view", table: "goods", columns: ["name", "stock"] },
        { id: "goods-detail", type: "detail_view", table: "goods" },
        ...goodsForms.map((id) => ({ id, type: "form", table: "goods", fields: ["name"] })),
        { id: "cart-form", type: "form", table: "carts", fields: ["item"] },
      ],
    },
  } as unknown as Manifest;
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
    if (method === "GET" && url.startsWith(RECORDS_PATH)) {
      return json({ records: ROWS, total: ROWS.length });
    }
    return json({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/goods-list`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

async function renderList(
  built: Manifest,
  role: Role = "owner",
  extra?: Partial<ListView>,
): Promise<void> {
  const target = { ...(built.app.views[0] as ListView), ...(extra ?? {}) } as ListView;
  render(
    <RoleProvider role={role}>
      <ListViewRenderer appId={APP_ID} manifest={built} view={target} />
    </RoleProvider>,
  );
  await waitFor(() => expect(screen.getAllByTestId("list-row").length).toBe(ROWS.length));
}

/** 「1 と同じ面」——**`goods-form` の読取を、名指しした役割に配るだけ。** */
function grantForm(built: Manifest, roles: readonly string[], formId = "goods-form"): Manifest {
  return grantRules(built, roles, [viewRead(formId)]);
}

// ---------------------------------------------------------------------------
// (a) 出る / 位置 / 文言
// ---------------------------------------------------------------------------

test("(a) 同テーブルの form が在り、面がその form の読取を許すとき「新規作成」が出る", async () => {
  await renderList(grantForm(build(), ["owner"]));
  expect(screen.getByTestId("list-create")).not.toBeNull();
  expect(screen.getByTestId("list-create-button")).not.toBeNull();
});

test("(a) 出る位置は .list-view の直下の先頭である", async () => {
  await renderList(grantForm(build(), ["owner"]));
  const listView = screen.getByTestId("view-renderer-list_view");
  expect(listView.children[0]?.getAttribute("data-testid")).toBe("list-create");
});

test("(a) 文言は「新規作成」である", async () => {
  await renderList(grantForm(build(), ["owner"]));
  expect(screen.getByTestId("list-create-button").textContent).toBe("新規作成");
});

// ---------------------------------------------------------------------------
// (b) 押した先(_id もプリフィルも1文字も載せない)
// ---------------------------------------------------------------------------

test("(b) 押すと同テーブルの form の画面へ行く", async () => {
  await renderList(grantForm(build(), ["owner"]));
  fireEvent.click(screen.getByTestId("list-create-button"));
  await waitFor(() => expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/goods-form`));
});

test("(b) 押した後のクエリ文字列は空である(プリフィルを1文字も載せない)", async () => {
  await renderList(grantForm(build(), ["owner"]));
  fireEvent.click(screen.getByTestId("list-create-button"));
  await waitFor(() => expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/goods-form`));
  expect(window.location.search).toBe("");
});

test("(b) 行き先の pathname に /records/ は現れない(どの行でもない)", async () => {
  await renderList(grantForm(build(), ["owner"]));
  fireEvent.click(screen.getByTestId("list-create-button"));
  await waitFor(() => expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/goods-form`));
  expect(window.location.pathname).not.toContain("/records/");
});

// ---------------------------------------------------------------------------
// (c) 同テーブルの form の実在と、定義順の先頭
// ---------------------------------------------------------------------------

test("(c) 同テーブルの form が1本も無い一覧には出ない", async () => {
  // `cart-form` は残っている(form が1本も無いのではなく、**同じテーブルの** form が無い)。
  const built = grantRules(build({ goodsForms: [] }), ["owner"], [viewRead("cart-form")]);
  await renderList(built);
  expect(screen.queryByTestId("list-create")).toBeNull();
});

test("(c) 同テーブルの form が2本あるときは定義順の先頭へ行く", async () => {
  const built = grantRules(
    build({ goodsForms: ["goods-form-first", "goods-form-second"] }),
    ["owner"],
    [viewRead("goods-form-first"), viewRead("goods-form-second")],
  );
  await renderList(built);
  fireEvent.click(screen.getByTestId("list-create-button"));
  await waitFor(() =>
    expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/goods-form-first`),
  );
});

// ---------------------------------------------------------------------------
// (d) その form がその人に見えるか(面)
// ---------------------------------------------------------------------------

test("(d) 面が form を1つも名指ししていないアプリでは owner にも出ない", async () => {
  const built = grantRules(build(), ["owner"], [viewRead("goods-list")]);
  await renderList(built);
  expect(screen.queryByTestId("list-create")).toBeNull();
});

test("(d) 面が別の画面だけを名指ししている相手には出ない(他人に配っても出ない)", async () => {
  const built = grantRules(build(), ["editor"], [viewRead("goods-form")]);
  grantRules(built, ["owner"], [viewRead("goods-detail")]);
  await renderList(built, "owner");
  expect(screen.queryByTestId("list-create")).toBeNull();
});

// ---------------------------------------------------------------------------
// (e) st_no_direct_create
// ---------------------------------------------------------------------------

test("(e) その表が st_no_direct_create を宣言していると出ない(面は (a) と同じ)", async () => {
  await renderList(grantForm(build({ noDirectCreate: true }), ["owner"]));
  expect(screen.queryByTestId("list-create")).toBeNull();
});

// ---------------------------------------------------------------------------
// (f) 書ける相手か(`canWriteRole`)
// ---------------------------------------------------------------------------

test("(f) viewer には出ない(form の読取を viewer にも配ったうえで測る)", async () => {
  // **配らないと `canUseView` の側で先に落ちて `canWriteRole` を1ミリも測らない**
  // ——(d) と同じことを2度測るだけになる。**ここは面を通したうえで書込判定だけで落とす。**
  const built = grantForm(build(), ["owner", "viewer"]);
  await renderList(built, "viewer");
  expect(screen.queryByTestId("list-create")).toBeNull();
  // **面は通っている**ことを同じ題材で確かめる(owner なら出る)。
  cleanup();
  await renderList(built, "owner");
  expect(screen.getByTestId("list-create")).not.toBeNull();
});

// ---------------------------------------------------------------------------
// (g) 行ごとの操作起点(`actions`)とは別の口である
// ---------------------------------------------------------------------------

test("(g) actions を1つも書いていない一覧でも出る", async () => {
  await renderList(grantForm(build(), ["owner"]));
  expect(screen.getByTestId("list-create")).not.toBeNull();
  // 行ごとの操作起点は1つも出ていない。
  expect(screen.queryByTestId("list-action-cell")).toBeNull();
});

test("(g) 押しても行クリックの遷移(詳細画面)は起きない", async () => {
  await renderList(grantForm(build(), ["owner"]));
  fireEvent.click(screen.getByTestId("list-create-button"));
  await waitFor(() => expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/goods-form`));
  expect(window.location.pathname).not.toContain("goods-detail");
});
