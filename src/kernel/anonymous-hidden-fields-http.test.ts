/**
 * **`V21-M2B-T00`(`ADR-0482` の `AN-G2`)—— 未ログインにだけ隠す項目(`hidden_fields`)。TDD の赤。**
 *
 * ## 本ファイルが固定するもの(本体の実 HTTP)
 *
 * 未ログインの役割の**表の読取規則**に `hidden_fields`(項目IDの並び)を書くと、その項目は
 * **未ログインにとって「無い項目」になる**(`ADR-0482` §2-3 / §2-6)。
 *
 * | 口 | 期待 | 題 |
 * |---|---|---|
 * | 一覧・単件・子一覧の行 | 隠した項目のキーも値も出ない | (A-1)〜(A-3) |
 * | 公開の印(`st_public`)を持つ表 | 同じく隠れる | (A-4) |
 * | 宣言の無い表 | 全項目が見える(予約規約フィールドを除く) | (A-5) |
 * | 同じ表の規則が複数 | 隠す項目は和集合(条件つきの規則でも) | (A-6) |
 * | `?sort=` / `?filter.<項目>=` / `filter=<JSON>` / `?sum=` / `?group_by=` | 存在しない項目と同じ 400。 `allowed_values` に出さない | (B-1)〜(B-6) |
 * | 子一覧の絞り(参照の項目を隠した子の表) | 同じ 400 | (B-7) |
 * | `GET /public` の画面の定義と表の定義 | 隠した項目の綴りが出ない。代表項目のキーを落とす。子一覧の絞りの項目を隠した子一覧は落とす | (C-1)〜(C-3) |
 * | 隠した `image` のファイル配信 | 404(隠していない `image` は 200) | (D-1) |
 * | ログインした人 | 宣言の有無で応答が同一。引数も今日どおり通る | (E-1)〜(E-2) |
 * | 宣言の後に足した項目 | 未ログインに見える(`H-V21-5` の固定) | (F-1) |
 *
 * **参照の名前表示(参照先の代表項目を隠したとき)は `V21-M3` の担当**(`ADR-0482` §4-2)。
 *
 * **【置き場所】`src/kernel/`** —— `anonymous-table-read-http.test.ts`(`V21-M2`)と同じ理由
 * (カーネルの値を import すると `src/server/` では層またぎの一覧が動くため)。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerApp } from "../server/app.ts";
import { PUBLIC_FIELD } from "../server/owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "../server/test-helpers.ts";
import { applyDiff } from "./apply-diff.ts";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "./index.ts";

const APP_ID = "anon-hidden";

type Any = Record<string, unknown>;

/** 隠した項目の値に入れる目印(計画 §8-3b の C26)。 */
const SECRET = "SECRET-H";

/** 隠す項目の ID はすべて `h_` で始める(綴りの走査で拾えるように)。 */
const ANON_RULES: Any[] = [
  // **1本目**: 条件なし。 `h_memo` / `h_cost` を隠す。
  { target: "table", table: "t_prod", can: ["read"], hidden_fields: ["h_memo", "h_cost"] },
  // **2本目**: 条件つき。 `h_pic` / `h_cat` を隠す(和集合は行に当たった規則に依らない。§2-4)。
  {
    target: "table",
    table: "t_prod",
    can: ["read"],
    when: { field: "status", equals: "open" },
    hidden_fields: ["h_pic", "h_cat"],
  },
  { target: "table", table: "t_rev", can: ["read"], hidden_fields: ["h_secret"] },
  { target: "table", table: "t_rev2", can: ["read"], hidden_fields: ["h_prod"] },
  { target: "table", table: "t_pub", can: ["read"], hidden_fields: ["h_memo"] },
  { target: "table", table: "t_plain", can: ["read"] },
  { target: "view", view: "v_prod_list", can: ["read"] },
  { target: "view", view: "v_prod_group", can: ["read"] },
  { target: "view", view: "v_prod_detail", can: ["read"] },
];

function anonymousRole(rules: Any[]): Any {
  return { id: "anonymous", name: "ログインしていない人", rules };
}

/** `hidden_fields` を1本も持たない写し(ログインした人の対照に使う)。 */
function withoutHidden(rules: Any[]): Any[] {
  return rules.map((rule) => {
    const { hidden_fields: _drop, ...rest } = rule;
    return rest;
  });
}

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "未ログインに隠す項目",
      tables: [
        {
          id: "t_prod",
          name: "商品",
          representative_field: "h_memo",
          fields: [
            { id: "name", name: "名前", type: "text", required: true },
            { id: "price", name: "値段", type: "number" },
            { id: "status", name: "状態", type: "text" },
            { id: "photo", name: "写真", type: "image" },
            { id: "h_cost", name: "仕入れ値", type: "number" },
            { id: "h_memo", name: "店用メモ", type: "text" },
            { id: "h_pic", name: "店用写真", type: "image" },
            { id: "h_cat", name: "店用区分", type: "select", options: ["a", "b"] },
          ],
        },
        {
          id: "t_rev",
          name: "口コミ",
          fields: [
            { id: "prod", name: "商品", type: "reference", reference_table: "t_prod" },
            { id: "note", name: "本文", type: "text" },
            { id: "h_secret", name: "店用", type: "text" },
          ],
        },
        {
          id: "t_rev2",
          name: "問い合わせ",
          fields: [
            { id: "h_prod", name: "商品", type: "reference", reference_table: "t_prod" },
            { id: "note", name: "本文", type: "text" },
          ],
        },
        {
          id: "t_pub",
          name: "公開の印の表",
          fields: [
            { id: "name", name: "名前", type: "text", required: true },
            { id: "h_memo", name: "店用メモ", type: "text" },
            { id: PUBLIC_FIELD, name: "公開", type: "boolean" },
          ],
        },
        {
          id: "t_plain",
          name: "宣言の無い表",
          fields: [
            { id: "name", name: "名前", type: "text", required: true },
            { id: "memo", name: "メモ", type: "text" },
          ],
        },
      ],
      views: [
        {
          id: "v_prod_list",
          type: "list_view",
          table: "t_prod",
          columns: ["name", "price", "h_cost", "h_memo", "h_pic"],
          sort: [{ field: "h_cost", order: "desc" }],
          sum_field: "h_cost",
          search_fields: ["name", "h_memo"],
          preset_column_align: { h_cost: "right", price: "right" },
        },
        {
          id: "v_prod_group",
          type: "list_view",
          table: "t_prod",
          columns: ["name", "h_cat"],
          group_by: { field: "h_cat" },
          filter: { field: "h_memo", equals: SECRET },
        },
        {
          id: "v_prod_detail",
          type: "detail_view",
          table: "t_prod",
          fields: ["name", "price", "h_memo", "h_cost"],
          field_sections: { 基本: ["name", "price"], 店用: ["h_memo", "h_cost"] },
          related: [
            { table: "t_rev", via: "prod", columns: ["note", "h_secret"] },
            { table: "t_rev2", via: "h_prod", columns: ["note"] },
          ],
        },
      ],
      roles: [anonymousRole(ANON_RULES)],
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
let ownerCookie: string;
let prodIds: string[] = [];
let fileVisible = "";
let fileHidden = "";

function pngBytes(tag: number): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, tag, tag + 1, tag + 2]);
}

async function upload(tag: number): Promise<string> {
  const form = new FormData();
  form.set("file", new Blob([Uint8Array.from(pngBytes(tag))]), `f${tag}.png`);
  const res = await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/files`, {
      method: "POST",
      headers: { cookie: ownerCookie, origin: TEST_ORIGIN },
      body: form,
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { file_id: string }).file_id;
}

const R = (table: string, id?: string, query = "") =>
  `/api/apps/${APP_ID}/tables/${table}/records${id === undefined ? "" : `/${id}`}${query}`;

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

function get(path: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  return Promise.resolve(app.request(new Request(`http://localhost${path}`, { headers })));
}

async function getJson(path: string, cookie?: string): Promise<{ status: number; body: Any }> {
  const res = await get(path, cookie);
  return { status: res.status, body: (await res.json()) as Any };
}

let seq = 0;
function setAnonymousRules(rules: Any[]) {
  seq += 1;
  const current = withDefaultRoleRules(manifest()) as unknown as { app: { roles: Any[] } };
  const roles = current.app.roles.map((role) =>
    role.id === "anonymous" ? anonymousRole(rules) : role,
  );
  return applyDiff(dataRoot, APP_ID, {
    diff_id: `d-anon-hidden-${seq}`,
    intent: "隠す宣言の有無を切り替える",
    operations: [{ op: "set_roles", roles }],
  });
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-anon-hidden-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "未ログインに隠す項目", { app_id: APP_ID });
  } finally {
    store.close();
  }
  const applied = applyManifest(dataRoot, APP_ID, withDefaultRoleRules(manifest()));
  expect(applied.valid, JSON.stringify(applied)).toBe(true);
  app = createServerApp({ dataRoot });
  ownerCookie = seedSession(dataRoot, APP_ID).cookie;
  fileVisible = await upload(10);
  fileHidden = await upload(20);
  prodIds = [
    await create("t_prod", {
      name: "一",
      price: 100,
      status: "open",
      photo: fileVisible,
      h_cost: 70,
      h_memo: SECRET,
      h_pic: fileHidden,
      h_cat: "a",
    }),
    await create("t_prod", {
      name: "二",
      price: 200,
      status: "closed",
      h_cost: 10,
      h_memo: `${SECRET}-2`,
      h_cat: "b",
    }),
    await create("t_prod", {
      name: "三",
      price: 300,
      status: "open",
      h_cost: 999,
      h_memo: `${SECRET}-3`,
      h_cat: "a",
    }),
  ];
  await create("t_rev", { prod: prodIds[0], note: "良い", h_secret: SECRET });
  await create("t_rev", { prod: prodIds[0], note: "普通", h_secret: SECRET });
  await create("t_rev2", { h_prod: prodIds[0], note: "問" });
  await create("t_pub", { name: "公開", h_memo: SECRET, [PUBLIC_FIELD]: true });
  await create("t_plain", { name: "素", memo: "見えてよい" });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function expectNoSecret(value: unknown): void {
  const text = JSON.stringify(value);
  expect(text).not.toContain(SECRET);
  // **隠した項目の綴り(引用符つきで数える。`search_fields` の綴りの中の「h_」を拾わないため)。**
  expect(text).not.toContain('"h_');
}

// --- (A) 行から落ちる(C25 / C26 の値)------------------------------------------------------

test("(A-1) 未ログイン: 一覧の行に隠した項目のキーも値も出ない。隠していない項目は出る", async () => {
  const { status, body } = await getJson(R("t_prod"));
  expect(status).toBe(200);
  const records = body.records as Any[];
  expect(records).toHaveLength(3);
  expectNoSecret(records);
  const first = records.find((row) => row._id === prodIds[0]) as Any;
  // **全項目に値を入れた行で比べる**(値 null の省略に崩れない。計画 §9-5 の C25)。
  expect(
    Object.keys(first)
      .filter((key) => !key.startsWith("_"))
      .sort(),
  ).toEqual(["name", "photo", "price", "status"]);
});

test("(A-2) 未ログイン: 単件にも隠した項目が出ない", async () => {
  const { status, body } = await getJson(R("t_prod", prodIds[0]));
  expect(status).toBe(200);
  const record = body.record as Any;
  expect(record.name).toBe("一");
  expectNoSecret(record);
});

test("(A-3) 未ログイン: 子一覧(詳細画面の子一覧と同じ URL)にも子の表の隠した項目が出ない", async () => {
  const { status, body } = await getJson(R("t_rev", undefined, `?filter.prod=${prodIds[0]}`));
  expect(status).toBe(200);
  expect(body.total).toBe(2);
  expectNoSecret(body.records);
});

test("(A-4) 未ログイン: 公開の印の表でも隠した項目は出ない(行の集合は今日どおり)", async () => {
  const list = await getJson(R("t_pub"));
  expect(list.status).toBe(200);
  expect(list.body.total).toBe(1);
  expectNoSecret(list.body.records);
});

test("(A-5) 未ログイン: 宣言の無い表は全項目が見える(予約規約フィールドを除く)", async () => {
  const { status, body } = await getJson(R("t_plain"));
  expect(status).toBe(200);
  const row = (body.records as Any[])[0] as Any;
  expect(
    Object.keys(row)
      .filter((key) => !key.startsWith("_"))
      .sort(),
  ).toEqual(["memo", "name"]);
});

test("(A-6) 未ログイン: 条件に合わない規則の隠す項目も効く(和集合)", async () => {
  // **`prodIds[1]` は `status = closed` で、2本目(条件つき)の規則には当たらない。**
  // **それでも2本目の隠す項目(`h_cat`)は隠れる。**
  const { status, body } = await getJson(R("t_prod", prodIds[1]));
  expect(status).toBe(200);
  expectNoSecret(body.record);
  expect(Object.keys(body.record as Any)).not.toContain("h_cat");
});

// --- (B) 読取の引数(存在しない項目と同じ 400)----------------------------------------------

/** 隠した項目を名指しした 400 と、存在しない項目を名指しした 400 が綴り以外で同じ。 */
async function expectSameAsMissing(hidden: string, query: (field: string) => string) {
  const missing = "zz_missing";
  const a = await getJson(R("t_prod", undefined, query(hidden)));
  const b = await getJson(R("t_prod", undefined, query(missing)));
  expect(b.status).toBe(400);
  expect(a.status).toBe(400);
  expect(JSON.stringify(a.body).replaceAll(hidden, "@")).toBe(
    JSON.stringify(b.body).replaceAll(missing, "@"),
  );
  // **`allowed_values` に隠した項目の綴りを出さない**(`ADR-0135` と同じ作法)。
  for (const error of (a.body.errors ?? []) as Any[]) {
    for (const value of (error.allowed_values ?? []) as string[]) {
      expect(value.startsWith("h_")).toBe(false);
    }
  }
}

test("(B-1) 未ログイン: ?sort=<隠した項目> は存在しない項目と同じ 400", async () => {
  await expectSameAsMissing("h_cost", (field) => `?sort=${field}`);
});

test("(B-2) 未ログイン: ?filter.<隠した項目>= は存在しない項目と同じ 400", async () => {
  await expectSameAsMissing("h_memo", (field) => `?filter.${field}=${SECRET}`);
});

test("(B-3) 未ログイン: filter=<JSON>(検索の翻訳先)で隠した項目を指すと存在しない項目と同じ 400", async () => {
  await expectSameAsMissing(
    "h_memo",
    (field) =>
      `?filter=${encodeURIComponent(JSON.stringify({ or: [{ field, contains: "SECRET" }] }))}`,
  );
});

test("(B-4) 未ログイン: ?sum=<隠した項目> は存在しない項目と同じ 400(合計が出ない)", async () => {
  await expectSameAsMissing("h_cost", (field) => `?sum=${field}`);
});

test("(B-4b) 未ログインの合計の 400 は、カーネルが存在しない列に返す 400 と文言・path・hint が同じ", async () => {
  // **ログインした人(持ち主)は行を JS で絞らない枝を通り、カーネルの検査が 400 を返す。**
  const kernel = await getJson(R("t_prod", undefined, "?sum=zz_missing"), ownerCookie);
  const anon = await getJson(R("t_prod", undefined, "?sum=h_cost"));
  expect(kernel.status).toBe(400);
  expect(anon.status).toBe(400);
  const shape = (body: Any, name: string) =>
    ((body.errors ?? []) as Any[]).map((error) => ({
      path: error.path,
      message: String(error.message).replaceAll(name, "@"),
      hint: error.hint,
    }));
  expect(shape(anon.body, "h_cost")).toEqual(shape(kernel.body, "zz_missing"));
});

test("(B-5) 未ログイン: ?group_by=<隠した項目> は存在しない項目と同じ 400(group_keys が出ない)", async () => {
  await expectSameAsMissing("h_cat", (field) => `?group_by=${field}`);
});

test("(B-6) 未ログイン: 隠していない項目の引数は今日どおり通る(並べ替え・合計)", async () => {
  const sorted = await getJson(R("t_prod", undefined, "?sort=price&order=desc&sum=price"));
  expect(sorted.status).toBe(200);
  expect(sorted.body.sum).toBe(600);
  expect((sorted.body.records as Any[]).map((row) => row.name)).toEqual(["三", "二", "一"]);
  expectNoSecret(sorted.body);
});

test("(B-7) 未ログイン: 子の表の参照の項目を隠していれば、子一覧の絞りは存在しない項目と同じ 400", async () => {
  const hidden = await getJson(R("t_rev2", undefined, `?filter.h_prod=${prodIds[0]}`));
  const missing = await getJson(R("t_rev2", undefined, `?filter.zz_missing=${prodIds[0]}`));
  expect(missing.status).toBe(400);
  expect(hidden.status).toBe(400);
  expect(JSON.stringify(hidden.body).replaceAll("h_prod", "@")).toBe(
    JSON.stringify(missing.body).replaceAll("zz_missing", "@"),
  );
});

// --- (C) GET /public(画面の定義と表の定義)----------------------------------------------------

test("(C-1) 未ログイン: /public の画面の定義と表の定義に隠した項目の綴りが出ない", async () => {
  const { status, body } = await getJson(`/api/apps/${APP_ID}/public`);
  expect(status).toBe(200);
  const views = body.views as Any[];
  expect(views.map((view) => view.id).sort()).toEqual([
    "v_prod_detail",
    "v_prod_group",
    "v_prod_list",
  ]);
  expectNoSecret(views);
});

test("(C-2) 未ログイン: /public の画面の定義は隠していない項目を残す(列・合計以外の並び)", async () => {
  const { body } = await getJson(`/api/apps/${APP_ID}/public`);
  const byId = new Map((body.views as Any[]).map((view) => [view.id, view]));
  const list = byId.get("v_prod_list") as Any;
  expect(list.columns).toEqual(["name", "price"]);
  expect(list.sort).toBeUndefined();
  expect(list.sum_field).toBeUndefined();
  expect(list.search_fields).toEqual(["name"]);
  expect(list.preset_column_align).toEqual({ price: "right" });
  const group = byId.get("v_prod_group") as Any;
  expect(group.group_by).toBeUndefined();
  expect(group.filter).toBeUndefined();
  const detail = byId.get("v_prod_detail") as Any;
  expect(detail.fields).toEqual(["name", "price"]);
  expect(detail.field_sections).toEqual({ 基本: ["name", "price"] });
  // **子一覧の絞りの項目(`via`)を隠した子一覧は落とす**(読むと 400 になるため)。
  expect((detail.related as Any[]).map((related) => related.table)).toEqual(["t_rev"]);
  expect((detail.related as Any[])[0]?.columns).toEqual(["note"]);
});

test("(C-3) 未ログイン: /public の表の定義から隠した項目を落とし、代表項目が隠れていればそのキーを落とす", async () => {
  const { body } = await getJson(`/api/apps/${APP_ID}/public`);
  const detail = (body.views as Any[]).find((view) => view.id === "v_prod_detail") as Any;
  const tables = detail.tables as Any[];
  const prod = tables.find((table) => table.id === "t_prod") as Any;
  expect((prod.fields as Any[]).map((field) => field.id)).toEqual([
    "name",
    "price",
    "status",
    "photo",
  ]);
  expect("representative_field" in prod).toBe(false);
  const rev = tables.find((table) => table.id === "t_rev") as Any;
  expect((rev.fields as Any[]).map((field) => field.id)).toEqual(["prod", "note"]);
});

// --- (D) 画像の配信 ----------------------------------------------------------------------------

test("(D-1) 未ログイン: 隠した image のファイルは 404、隠していない image は 200", async () => {
  expect((await get(`/api/apps/${APP_ID}/files/${fileVisible}`)).status).toBe(200);
  expect((await get(`/api/apps/${APP_ID}/files/${fileHidden}`)).status).toBe(404);
  // **ログインした人には今日どおり配る。**
  expect((await get(`/api/apps/${APP_ID}/files/${fileHidden}`, ownerCookie)).status).toBe(200);
});

// --- (E) ログインした人の見え方は変わらない(C27)--------------------------------------------

test("(E-1) ログインした人: 隠す宣言の有無で一覧・単件・子一覧の応答が同一", async () => {
  const paths = [
    R("t_prod"),
    R("t_prod", prodIds[0]),
    R("t_rev", undefined, `?filter.prod=${prodIds[0]}`),
    R("t_pub"),
    R("t_prod", undefined, "?sort=h_cost&order=desc&sum=h_cost"),
    R("t_prod", undefined, "?group_by=h_cat"),
  ];
  const withDeclaration: string[] = [];
  for (const path of paths) {
    const res = await get(path, ownerCookie);
    expect(res.status, path).toBe(200);
    withDeclaration.push(await res.text());
  }
  const removed = setAnonymousRules(withoutHidden(ANON_RULES));
  expect(removed.valid, JSON.stringify(removed)).toBe(true);
  const withoutDeclaration: string[] = [];
  for (const path of paths) {
    const res = await get(path, ownerCookie);
    withoutDeclaration.push(await res.text());
  }
  expect(withDeclaration).toEqual(withoutDeclaration);
  // **ログインした人には隠した項目の値が見えている**(対照)。
  expect(withDeclaration[0]).toContain(SECRET);
});

test("(E-2) 未ログイン: 宣言を外すと隠していた項目が見える(宣言が効いていたことの対照)", async () => {
  const removed = setAnonymousRules(withoutHidden(ANON_RULES));
  expect(removed.valid, JSON.stringify(removed)).toBe(true);
  const { body } = await getJson(R("t_prod", prodIds[0]));
  expect(JSON.stringify(body)).toContain(SECRET);
});

// --- (F) 宣言の後に足した項目は見える(`H-V21-5` の固定)--------------------------------------

test("(F-1) 未ログイン: 隠す宣言の後に足した項目は見える(H-V21-5)", async () => {
  seq += 1;
  const added = applyDiff(dataRoot, APP_ID, {
    diff_id: `d-anon-hidden-add-${seq}`,
    intent: "宣言の後に項目を足す",
    operations: [
      { op: "add_field", table: "t_prod", field: { id: "late", name: "後から", type: "text" } },
    ],
  });
  expect(added.valid, JSON.stringify(added)).toBe(true);
  const current = await get(R("t_prod", prodIds[0]), ownerCookie);
  const etag = current.headers.get("etag") ?? "";
  const res = await app.request(
    new Request(`http://localhost${R("t_prod", prodIds[0])}`, {
      method: "PATCH",
      headers: {
        cookie: ownerCookie,
        origin: TEST_ORIGIN,
        "content-type": "application/json",
        "if-match": etag,
      },
      body: JSON.stringify({ late: "後から足した値" }),
    }),
  );
  expect(res.status, await res.clone().text()).toBe(200);
  const { body } = await getJson(R("t_prod", prodIds[0]));
  expect((body.record as Any).late).toBe("後から足した値");
});
