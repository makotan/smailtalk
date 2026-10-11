/**
 * **未ログインの公開画面で、参照を代表項目の名前で出すための `GET /public` の定義**
 * (`V21-M3`。`ADR-0482` の `AN-G4` §4-1 / §4-2 と §1-5 の対照 (a)(b)(c))。
 *
 * ## 何を固定するか
 *
 * | 参照先の表 | 未ログインで読めるか | `views[].tables` に入るか | 根拠 |
 * |---|---|---|---|
 * | `category`(表の読取規則。未ログインに開いていない一覧画面を持つ。代表でない項目を隠す) | 読める | 入る(隠した項目は落とす) | §4-1 / §1-5 |
 * | `line`(代表項目 `title` を宣言。先頭の text `line_code` を隠す) | 読める | 入る | §4-2 の対照(代表は隠れていない) |
 * | `condcat`(条件つきの表の読取規則) | 読める | 入る | §4-1 |
 * | `pubtab`(公開の印 + 表の読取規則) | 読める | 入る | §4-1 |
 * | `reviewer`(子一覧の表 `review` の参照先) | 読める | 入る(詳細画面) | §4-1「related の子の表の reference」 |
 * | `maker`(規則が無い) | 読めない | 入らない | §4-1「読めない参照先の表の定義は1バイトも渡さない」 |
 * | `brand`(宣言した代表項目 `brand_label` を隠す) | 読める | 入らない | §4-2 |
 * | `series`(代表の宣言なし。先頭の text `series_code` を隠す) | 読める | 入らない | §4-2(別の項目へ代わりに落とさない) |
 * | `owned`(所有者で絞る表) | 読めない | 入らない | §1-1 (iii) |
 * | `pubnorule`(公開の印だけ。未ログインの表の規則なし) | 読めない | 入らない | §4-1 |
 * | `secretcat`(隠した参照の項目 `h_secret_ref` だけが指す) | 読める | 入らない | 隠した項目は「無い項目」 |
 *
 * **置き場が `src/kernel/` である理由**: 本体を組むのにカーネルの値(`applyManifest` ほか)を使う。
 * `src/kernel/` の外から値として import すると `scripts/kernel-import-drift.test.ts` のスナップショットが
 * 動く(`V21-M2` / `V21-M2B` の HTTP の検査と同じ置き方)。
 *
 * ## この検査が測らないもの(誇張しない)
 *
 * - **画面に名前が描かれること**は測らない(`web/test/anonymous-reference-label.test.tsx` と
 *   `web/e2e/anonymous-reference-label.e2e.ts` の担当)。 ここは応答の中身と、画面が名前を引く
 *   読取(`?view=` を付けない一覧)の答えだけである。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerApp } from "../server/app.ts";
import { OWNER_FIELD, PUBLIC_FIELD } from "../server/owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "../server/test-helpers.ts";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "./index.ts";

const APP_ID = "anon-ref-label";

type Any = Record<string, unknown>;

/** 読めない参照先の表の定義にだけ置く綴り(応答の本文に1つも現れてはならない)。 */
const UNREADABLE_MARKERS = [
  "MAKER-DEF",
  "mk_name",
  "BRAND-DEF",
  "brand_code",
  "brand_label",
  "SERIES-DEF",
  "series_code",
  "series_title",
  "OWNED-DEF",
  "ow_name",
  "PUBNORULE-DEF",
  "pn_name",
  "SECRETCAT-DEF",
  "sc_name",
  "h_secret_ref",
  "cost_memo",
];

function manifest(): Manifest {
  const text = (id: string, name: string) => ({ id, name, type: "text" });
  const ref = (id: string, table: string) => ({
    id,
    name: id,
    type: "reference",
    reference_table: table,
  });
  return {
    app: {
      id: APP_ID,
      name: "参照の名前表示",
      tables: [
        {
          id: "product",
          name: "商品",
          fields: [
            { id: "name", name: "商品名", type: "text", required: true },
            ref("cat", "category"),
            ref("maker", "maker"),
            ref("brand", "brand"),
            ref("series", "series"),
            ref("line", "line"),
            ref("owned", "owned"),
            ref("pubref", "pubtab"),
            ref("pubnorule", "pubnorule"),
            ref("cond", "condcat"),
            ref("h_secret_ref", "secretcat"),
          ],
        },
        {
          id: "category",
          name: "カテゴリ",
          fields: [text("name", "名前"), text("cost_memo", "店用メモ")],
        },
        { id: "maker", name: "MAKER-DEF", fields: [text("mk_name", "名前")] },
        {
          id: "brand",
          name: "BRAND-DEF",
          representative_field: "brand_label",
          fields: [text("brand_code", "記号"), text("brand_label", "名前")],
        },
        {
          id: "series",
          name: "SERIES-DEF",
          fields: [text("series_code", "記号"), text("series_title", "名前")],
        },
        {
          id: "line",
          name: "系列",
          representative_field: "title",
          fields: [text("line_code", "記号"), text("title", "名前")],
        },
        {
          id: "owned",
          name: "OWNED-DEF",
          fields: [text("ow_name", "名前"), { id: OWNER_FIELD, name: "所有者", type: "text" }],
        },
        {
          id: "pubtab",
          name: "公開の表",
          fields: [text("name", "名前"), { id: PUBLIC_FIELD, name: "公開", type: "boolean" }],
        },
        {
          id: "pubnorule",
          name: "PUBNORULE-DEF",
          fields: [text("pn_name", "名前"), { id: PUBLIC_FIELD, name: "公開", type: "boolean" }],
        },
        {
          id: "condcat",
          name: "条件つきの区分",
          fields: [text("name", "名前"), text("status", "状態")],
        },
        { id: "secretcat", name: "SECRETCAT-DEF", fields: [text("sc_name", "名前")] },
        {
          id: "review",
          name: "口コミ",
          fields: [ref("product", "product"), ref("author", "reviewer"), text("note", "本文")],
        },
        { id: "reviewer", name: "投稿者", fields: [text("name", "名前")] },
      ],
      views: [
        {
          id: "v_list",
          name: "商品一覧",
          type: "list_view",
          table: "product",
          columns: ["name", "cat", "maker", "brand", "series", "line", "owned", "pubref"],
        },
        {
          id: "v_detail",
          name: "商品詳細",
          type: "detail_view",
          table: "product",
          fields: ["name", "cat"],
          related: [{ table: "review", via: "product", columns: ["note", "author"] }],
        },
        // **店用の一覧画面**(未ログインに開いていない)。 名乗らない読取の壁が今日なら閉じる形。
        { id: "v_category_admin", type: "list_view", table: "category", columns: ["name"] },
        { id: "v_category_detail_admin", type: "detail_view", table: "category", fields: ["name"] },
        { id: "v_pub_admin", type: "list_view", table: "pubtab", columns: ["name"] },
        { id: "v_pub_detail_admin", type: "detail_view", table: "pubtab", fields: ["name"] },
      ],
      roles: [
        {
          // **ログインした人の壁の対照**: カテゴリの表は読めるが、画面は1枚も読めない役割。
          id: "partner",
          name: "協力会社",
          rules: [
            { target: "table", table: "category", can: ["read"] },
            { target: "table", table: "pubtab", can: ["read"] },
          ],
        },
        {
          id: "anonymous",
          name: "未ログイン",
          rules: [
            { target: "view", view: "v_list", can: ["read"] },
            { target: "view", view: "v_detail", can: ["read"] },
            { target: "table", table: "product", can: ["read"], hidden_fields: ["h_secret_ref"] },
            { target: "table", table: "category", can: ["read"], hidden_fields: ["cost_memo"] },
            { target: "table", table: "brand", can: ["read"], hidden_fields: ["brand_label"] },
            { target: "table", table: "series", can: ["read"], hidden_fields: ["series_code"] },
            { target: "table", table: "line", can: ["read"], hidden_fields: ["line_code"] },
            { target: "table", table: "owned", can: ["read"] },
            { target: "table", table: "pubtab", can: ["read"] },
            {
              target: "table",
              table: "condcat",
              can: ["read"],
              when: { field: "status", equals: "open" },
            },
            { target: "table", table: "secretcat", can: ["read"] },
            { target: "table", table: "review", can: ["read"] },
            { target: "table", table: "reviewer", can: ["read"] },
          ],
        },
      ],
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
let ownerCookie: string;
let categoryId = "";
let pubOpenId = "";

const R = (table: string, id?: string, query = "") =>
  `/api/apps/${APP_ID}/tables/${table}/records${id === undefined ? "" : `/${id}`}${query}`;

function get(path: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  return Promise.resolve(app.request(new Request(`http://localhost${path}`, { headers })));
}

async function create(table: string, body: Any): Promise<string> {
  const res = await app.request(
    new Request(`http://localhost${R(table)}`, {
      method: "POST",
      headers: { cookie: ownerCookie, origin: TEST_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  expect(res.status, `create ${table} -> ${await res.clone().text()}`).toBe(201);
  return ((await res.json()) as { record: { _id: string } }).record._id;
}

async function publicBody(): Promise<{ text: string; body: Any }> {
  const res = await get(`/api/apps/${APP_ID}/public`);
  expect(res.status).toBe(200);
  const text = await res.text();
  return { text, body: JSON.parse(text) as Any };
}

function tablesOf(body: Any, viewId: string): Any[] {
  const view = (body.views as Any[]).find((candidate) => candidate.id === viewId);
  expect(view, viewId).toBeDefined();
  return (view as Any).tables as Any[];
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-anon-ref-label-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "参照の名前表示", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **既定3役割には表の規則だけを足す**(画面の規則を足すと未ログインに開いた画面だけが載る形が崩れる)。
  const applied = applyManifest(
    dataRoot,
    APP_ID,
    withDefaultRoleRules(manifest(), { skipAllViews: true }),
  );
  expect(applied.valid, JSON.stringify(applied)).toBe(true);
  app = createServerApp({ dataRoot });
  ownerCookie = seedSession(dataRoot, APP_ID).cookie;
  categoryId = await create("category", { name: "カテゴリ-塩", cost_memo: "SECRET-H" });
  pubOpenId = await create("pubtab", { name: "公開-一", [PUBLIC_FIELD]: true });
  await create("pubtab", { name: "非公開-二", [PUBLIC_FIELD]: false });
  await create("product", { name: "藻塩", cat: categoryId, pubref: pubOpenId });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

// --- (P) GET /public の views[].tables ------------------------------------------------------

test("(P-1) 未ログイン: 一覧画面の tables に、読める参照先の表が3種目として加わる(画面の表の後ろ・項目の順)", async () => {
  const { body } = await publicBody();
  expect(tablesOf(body, "v_list").map((table) => table.id)).toEqual([
    "product",
    "category",
    "line",
    "pubtab",
    "condcat",
  ]);
});

test("(P-2) 未ログイン: 詳細画面の tables に、子一覧の表の参照先(読める表)も加わる", async () => {
  const { body } = await publicBody();
  expect(tablesOf(body, "v_detail").map((table) => table.id)).toEqual([
    "product",
    "review",
    "category",
    "line",
    "pubtab",
    "condcat",
    "reviewer",
  ]);
});

test("(P-3) 未ログイン: 読めない参照先の表・代表項目を隠した表・隠した参照だけが指す表の定義は1バイトも渡らない", async () => {
  const { text } = await publicBody();
  for (const marker of UNREADABLE_MARKERS) {
    expect(text.includes(marker), marker).toBe(false);
  }
});

test("(P-4) 未ログイン: 渡す参照先の表の定義から隠した項目を落とす(代表項目は残す)", async () => {
  const { body } = await publicBody();
  const tables = tablesOf(body, "v_list");
  const category = tables.find((table) => table.id === "category") as Any;
  expect((category.fields as Any[]).map((field) => field.id)).toEqual(["name"]);
  const line = tables.find((table) => table.id === "line") as Any;
  expect((line.fields as Any[]).map((field) => field.id)).toEqual(["title"]);
  expect(line.representative_field).toBe("title");
});

test("(P-5) 未ログイン: トップレベルのキーは増えず、行(データ)は1行も渡らない", async () => {
  const { text, body } = await publicBody();
  expect(Object.keys(body).sort()).toEqual(["app", "signup", "views"]);
  expect(text.includes("カテゴリ-塩")).toBe(false);
  expect(text.includes("公開-一")).toBe(false);
  expect(text.includes(categoryId)).toBe(false);
});

// --- (W) 名乗らない読取の壁の対照(`ADR-0482` §1-5 の (a)(b)(c))--------------------------------

test("(W-a) 未ログイン: 店用の一覧画面を持つ参照先の表でも、画面を名乗らない読取で名前が引ける", async () => {
  const res = await get(R("category"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { records: Any[]; total: number };
  expect(body.total).toBe(1);
  expect(body.records[0]?.name).toBe("カテゴリ-塩");
  expect((await get(R("category", categoryId))).status).toBe(200);
  // **隠した項目は載らない**(`V21-M2B`)。
  expect(JSON.stringify(body).includes("SECRET-H")).toBe(false);
});

test("(W-b) ログイン済み: 画面を1枚も読めない役割の名乗らない読取は、今日どおり壁で 0件・単件 404", async () => {
  const partner = seedSession(dataRoot, APP_ID, { role: "partner" });
  const res = await get(R("category"), partner.cookie);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { records: Any[]; total: number };
  expect(body.total).toBe(0);
  expect((await get(R("category", categoryId), partner.cookie)).status).toBe(404);
});

test("(W-c) 未ログイン: 公開の印の表の名乗らない一覧は、今日どおり壁で 0件", async () => {
  const res = await get(R("pubtab"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { records: Any[]; total: number };
  expect(body.total).toBe(0);
  // **単件は今日も壁の外である**(`V21-M3` の着手 sha で 200 を実測した。本段で変えていない)。
  expect((await get(R("pubtab", pubOpenId))).status).toBe(200);
});

test("(W-d) 未ログイン: 読めない参照先の表は今日どおり 401", async () => {
  expect((await get(R("maker"))).status).toBe(401);
  expect((await get(R("owned"))).status).toBe(401);
});
