/**
 * `B-G2` の**読取経路で項目が落ちる**ことの検査(`V4-M3-T06`)。**`ADR-0071` 限定5 の機械的固定。**
 *
 * 限定5 の逐語(`docs/adr/0071-field-audience-declaration.md:48`):
 *
 * > **サーバの読取経路が落とす** … **表示層だけの実装を認めない。** 落とすのは
 * > `src/server/owner-scope.ts` の射影(`ANON_RESERVED_FIELDS` 周辺)と
 * > `src/server/app.ts` の読取経路である
 * > … **宣言した項目が、対象ロールの GET のレスポンス本文に1件も含まれないことを、
 * > 匿名 / customer / viewer の3経路について固定するテスト**
 *
 * ## 【この検査が守らないもの。誇張しない】
 *
 * - **【禁止】「在庫は漏れなくなった」と書かない**(`ADR-0071` §限界1 / `01:416`)。
 *   **本タスクが作るのは「客に出さない項目を宣言できる」ことであって「客に出ない」ではない。**
 * - **宣言し忘れた項目は今日どおり出る**(限定7)。**落ちる向きは危険側である** ——
 *   **下の (E) がその挙動を実測で固定する**(限定8:「静かに漏れる」ことを検査で可視化する)。
 * - **MCP の `list_records` は宣言を1つも見ない**(限定9)。
 * - **`GET /manifest` は未ログインで全フィールド定義を返し続ける** ——
 *   **落とすのは値であって定義ではない**(下の (Y) が実測)。
 * - **書込は1バイトも変わらない**(限定4 の前半。下の (D) が実測)。
 *
 * ## 【2026-08-04 の改訂】検索(`filter`)・並べ替え(`sort`)についての記述は反転した
 *
 * **旧記述の逐語**(1バイトも書き換えず、ここに残す):
 *
 * > **書込・検索(`filter`)・並べ替え(`sort`)は1バイトも変わらない**(限定4。下の (D) が実測)。
 *
 * **[`ADR-0120`](../../docs/adr/0120-hidden-field-query-restriction.md)(門A 本審査 = 限定採用)が
 * `ADR-0071` 限定4 を改訂し、「**読取のリクエスト引数**としての `filter` / `sort`」については
 * 変えると決めた。** **`ADR-0120` 限定6 が「テストを削除せず反転する」ことを課しているので、
 * 下の (D) は消さずに新しい期待値へ書き換えてある**(旧期待値の逐語も同テストに残した)。
 * **マニフェストの `view.filter` / `view.sort` は今日も1バイトも変わらない**(`ADR-0120` 限定1)。
 *
 * ---
 *
 * ## **【`V8-M20` / 台帳 `J-G28` / `ADR-0301`】宣言の置き場が変わった。測る性質は変えていない**
 *
 * **上の記述を1バイトも書き換えていない。** **`field.audience`(項目の「見せる相手」)は
 * 廃止され、面(`app.roles[].rules` の `{ target: "field", table, field, can: ["read"] }`)が
 * 同じことを言うようになった。** **本ファイルが測る性質 ——「面が読めないと決めた項目が、
 * 読取の応答に1件も含まれない」—— は1ミリも変えていない**(`ADR-0301` 限定6 の置き直し)。
 *
 * **【置き直しで変わった点。誇張しないために先に書く】**
 *
 * 1. **面の規則は対象を名指しした時点で全動詞が allow-list になる** —— **`can: ["read"]`
 *    だけを書いた項目は誰も書けなくなる。** **下の fixture は、着手前に書けていた相手
 *    (`owner` が `sku` / `stock` を、`customer` が `order.memo` を書く)に `write` を
 *    明示的に足してある。** **そう書かなければ着手前の書込が 403 になる。**
 * 2. **未ログイン(`anonymous`)には項目の規則を1本も書けない**(`J-G11` の非対称)——
 *    **旧 `audience` の値域が匿名を持たなかったこと(限定3)と、結果は同じである。**
 * 3. **`GET /manifest` が未ログインに返すのは、項目の `audience` ではなく `app.roles` に
 *    なった** —— **落とすのは値であって定義ではない、という性質はそのままである**(下の (Y))。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { OWNER_FIELD, PUBLIC_FIELD } from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "field-audience-shop";

/**
 * **面の規則**(`V8-M20` の置き直し)。
 *
 * **【置き直し前の形。1バイトも書き換えずに残す】** ——
 * `sku` / `stock` に `audience: ["owner", "editor"]`、`order.memo` に `audience: ["owner"]`。
 *
 * **`write` を足してある相手は、着手前に実際に書けていた相手だけである** ——
 * `owner` が `sku` / `stock` を作り、`customer` が `order.memo` を書く(下の (A) / (D))。
 */
const ROLES = [
  {
    id: "owner",
    name: "持ち主",
    rules: [
      { target: "field", table: "product", field: "sku", can: ["read", "write"] },
      { target: "field", table: "product", field: "stock", can: ["read", "write"] },
      { target: "field", table: "order", field: "memo", can: ["read", "write"] },
    ],
  },
  {
    id: "editor",
    name: "編集者",
    rules: [
      { target: "field", table: "product", field: "sku", can: ["read"] },
      { target: "field", table: "product", field: "stock", can: ["read"] },
    ],
  },
  // **`viewer` には1本も書かない** —— allow-list なので、名指しされた項目は落ちる。
  { id: "viewer", name: "閲覧者" },
  {
    id: "customer",
    name: "お客様",
    // **読めないが書ける**(着手前の `audience` は書込を1バイトも絞らなかった)。
    rules: [{ target: "field", table: "order", field: "memo", can: ["write"] }],
  },
];

/**
 * **`D-V4-36`(ユーザ決定)の目的文をそのまま写した題材** ——
 * 「**仕入れ先コードや残在庫数は、客に見せるものではない。見えていること自体が問題である。**」
 *
 * - `sku` / `stock` … **運営だけに見せると宣言する。**
 * - `cost` … **宣言し忘れた項目**(限定7 / 限定8 の題材。**今日どおり誰にでも出る**)。
 * - `name` / `price` … 宣言しない(客に見せる項目)。
 */
function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "見せ分けの店",
      tables: [
        {
          id: "product",
          name: "商品",
          fields: [
            { id: "name", name: "商品名", type: "text", required: true },
            { id: "price", name: "価格", type: "number" },
            { id: "sku", name: "SKU", type: "text" },
            { id: "stock", name: "在庫数", type: "number" },
            // **宣言し忘れた項目**(限定8 の題材)。
            { id: "cost", name: "仕入原価", type: "number" },
            { id: PUBLIC_FIELD, name: "公開", type: "boolean" },
          ],
        },
        {
          id: "order",
          name: "注文",
          fields: [
            { id: "total", name: "合計", type: "number" },
            { id: "memo", name: "運営メモ", type: "text" },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
          ],
        },
      ],
      views: [{ id: "catalog-list", type: "list_view", table: "product", columns: ["name"] }],
      roles: ROLES,
    },
  } as unknown as Manifest;
}

/**
 * **【`V8-M26`】適用する題材**(`beforeEach` が `applyManifest` に渡すもの)。
 *
 * **既定が閉じた**(`V8-M26` / ユーザ決定 `D-V8-45` / `D-V8-65`)—— **規則を1本も
 * 名指ししていない表・画面・ボタンは拒否される。****本ファイルの主題は項目(`field`)の
 * 射影であり、項目の層は今日も閉じていない**(台帳 `T-G1b` = 却下)。**したがって表を
 * 開けても、どの項目が落ちるかは1ミリも動かない。**
 *
 * - `withDefaultRoleRules` が既定3役割へ入れるのは `apply-diff.ts` の自動付与と同じ規則だけ
 *   である(**項目の規則は1本も足さない**)。
 * - **`customer`** は表 `product` の読取と、表 `order` の読取・書込(自分の注文を作る)。
 * - **`anonymous`** は表 `product` の読取1語だけ —— **(A) の1本目が「匿名の応答から
 *   `sku` / `stock` が落ちる」ことを測る検査であり、読めなければ主題が測れない。**
 */
function seededManifest(): Manifest {
  const m = structuredClone(manifest()) as unknown as {
    app: { roles: { id: string; name: string; rules?: unknown[] }[] };
  };
  const customer = m.app.roles.find((role) => role.id === "customer") as { rules: unknown[] };
  // **`order` の規則に条件(`when`)を付けているのは、`D-V8-35` により面が表の**読取**を
  // 許すと `st_owner`(個人スコープ)を読取について越えるからである** —— **素で書くと
  // (A) の「個人スコープのテーブルでも落ちる(post-filter 経路にも掛かる)」が、
  // post-filter 経路を通らないまま緑になる。**
  customer.rules = [
    ...customer.rules,
    { target: "table", table: "product", can: ["read"] },
    {
      target: "table",
      table: "order",
      can: ["read", "write"],
      when: { field: OWNER_FIELD, equals_current_user: true },
    },
  ];
  // **【`V18-M4-T02b`。ユーザ決定 `D-V18-26` / `ADR-0441`】画面の規則を足した。**
  //
  // **`V18-M4-T02` が「画面名を名乗らない読取」に壁を立てた** —— **その表を指す一覧系の
  // 画面(`list_view` / `report_view`)を**1本も読めない**相手の一覧は 0件になる
  // (単票の口は `detail_view` / `form` を見て 404 になる)。** **`D-V18-26` により、
  // 画面を宣言しているのに「誰に見せるか」を役割の規則に1行も書いていない場合も止まる。**
  //
  // **この題材は `catalog-list`(`list_view`。表 `product`)を宣言しながら、`customer` と
  // `anonymous` にはその画面の規則を1本も書いていなかった** —— **今日の正から見て
  // 設計図が不完全だった。** **本ファイルの主題は項目(`field`)の規則が応答から値を
  // 落とすことであって画面の規則ではないので、主張(`expect`)は1バイトも
  // 書き換えていない。**
  customer.rules = [...customer.rules, { target: "view", view: "catalog-list", can: ["read"] }];
  m.app.roles.push({
    id: "anonymous",
    name: "未ログイン",
    rules: [
      { target: "table", table: "product", can: ["read"] },
      { target: "view", view: "catalog-list", can: ["read"] },
    ],
  });
  return withDefaultRoleRules(m) as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-field-proj-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "見せ分けの店", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, seededManifest()).valid).toBe(true);
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function req(
  cookie: string | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { origin: TEST_ORIGIN };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return Promise.resolve(app.request(new Request(`http://localhost${path}`, init)));
}

const PRODUCTS = `/api/apps/${APP_ID}/tables/product/records`;
const ORDERS = `/api/apps/${APP_ID}/tables/order/records`;

function session(role: "owner" | "editor" | "viewer" | "customer") {
  return seedSession(dataRoot, APP_ID, { role, username: `${role}-${Math.random()}` });
}

async function seedProduct(): Promise<string> {
  const o = session("owner");
  const res = await req(o.cookie, "POST", PRODUCTS, {
    name: "梅干し",
    price: 800,
    sku: "UME-1",
    stock: 12,
    cost: 300,
    [PUBLIC_FIELD]: true,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { record: { _id: string } }).record._id;
}

async function listKeys(cookie: string | undefined): Promise<string[]> {
  const res = await req(cookie, "GET", PRODUCTS);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { records: Record<string, unknown>[] };
  expect(body.records).toHaveLength(1);
  return Object.keys(body.records[0] as Record<string, unknown>);
}

async function oneKeys(cookie: string | undefined, id: string): Promise<string[]> {
  const res = await req(cookie, "GET", `${PRODUCTS}/${id}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { record: Record<string, unknown> };
  return Object.keys(body.record);
}

// --- (A) 限定5 の第4列そのもの: 匿名 / customer / viewer の3経路 ------------------------

test("(A) 宣言した項目が匿名の一覧・単件の応答に1件も含まれない(ADR-0071 限定3)", async () => {
  // **匿名は customer より狭い** —— **値域に `anonymous` が無くても、宣言のある項目は常に落ちる。**
  // **【`V8-M20` / `J-G11`】面でも同じ結論になる** —— **未ログインの役割(`anonymous`)には
  // 項目の規則を1本も書けないので、面が名指しした項目は未ログインから必ず落ちる。**
  const id = await seedProduct();
  for (const keys of [await listKeys(undefined), await oneKeys(undefined, id)]) {
    expect(keys).not.toContain("sku");
    expect(keys).not.toContain("stock");
    expect(keys).toContain("name");
    expect(keys).toContain("price");
  }
});

test("(A) 宣言した項目が customer の一覧・単件の応答に1件も含まれない", async () => {
  const id = await seedProduct();
  const c = session("customer");
  for (const keys of [await listKeys(c.cookie), await oneKeys(c.cookie, id)]) {
    expect(keys).not.toContain("sku");
    expect(keys).not.toContain("stock");
    expect(keys).toContain("name");
  }
});

test("(A) 宣言した項目が viewer の一覧・単件の応答に1件も含まれない(customer 限定ではない)", async () => {
  const id = await seedProduct();
  const v = session("viewer");
  for (const keys of [await listKeys(v.cookie), await oneKeys(v.cookie, id)]) {
    expect(keys).not.toContain("sku");
    expect(keys).not.toContain("stock");
  }
});

test("(A) 列挙に載っているロール(owner / editor)には今日どおり出る", async () => {
  const id = await seedProduct();
  for (const role of ["owner", "editor"] as const) {
    const s = session(role);
    for (const keys of [await listKeys(s.cookie), await oneKeys(s.cookie, id)]) {
      expect(keys, role).toContain("sku");
      expect(keys, role).toContain("stock");
    }
  }
});

test("(A) 個人スコープ(st_owner)のテーブルでも落ちる(post-filter 経路にも掛かる)", async () => {
  const c = session("customer");
  const created = await req(c.cookie, "POST", ORDERS, { total: 100, memo: "内部メモ" });
  expect(created.status).toBe(201);
  const list = await req(c.cookie, "GET", ORDERS);
  const body = (await list.json()) as { records: Record<string, unknown>[] };
  expect(body.records).toHaveLength(1);
  expect(Object.keys(body.records[0] as Record<string, unknown>)).not.toContain("memo");
  expect(Object.keys(body.records[0] as Record<string, unknown>)).toContain("total");
});

// --- (B) 版(ETag / 楽観ロック)を壊していない ------------------------------------------

test("(B) 射影は _id / _updated_at を1つも触らない(ETag と CAS が今日どおり)", async () => {
  const id = await seedProduct();
  const c = session("customer");
  const res = await req(c.cookie, "GET", `${PRODUCTS}/${id}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { record: Record<string, unknown> };
  expect(body.record._id).toBe(id);
  expect(typeof body.record._updated_at).toBe("string");
  expect(res.headers.get("etag")).toBe(body.record._updated_at as string);
});

// --- (D) 限定4: 落とすのは読取だけ。書込は1バイトも変わらない ----------------------------

/**
 * **【反転した検査。`ADR-0120` による】**
 *
 * **反転前の逐語**(2026-08-04 まで緑だったもの。**1バイトも書き換えずに残す**):
 *
 * ```
 * test("(D) 客に見せない項目で絞り込むことは今日どおりできる(限定4)", async () => {
 *   await seedProduct();
 *   const c = session("customer");
 *   // **`stock` は customer の応答に出ないが、`filter` の条件としては今日どおり効く。**
 *   const hit = await req(c.cookie, "GET", `${PRODUCTS}?filter.stock=12`);
 *   expect(hit.status).toBe(200);
 *   expect(((await hit.json()) as { records: unknown[] }).records).toHaveLength(1);
 *   const miss = await req(c.cookie, "GET", `${PRODUCTS}?filter.stock=99`);
 *   expect(((await miss.json()) as { records: unknown[] }).records).toHaveLength(0);
 * });
 * ```
 *
 * **なぜ反転したか**: **[`ADR-0120`](../../docs/adr/0120-hidden-field-query-restriction.md)**
 * (`V4-M25` 門A 本審査 単位A = **限定採用**)が、**`ADR-0071` 限定4 の第4列後半
 * (「既存の filter / sort テストが緑のまま」)を赤にすると決定の中で明示した**(同 §5)。
 * **当たり `total=1` / 外れ `total=0` が値そのもののオラクルになっていたからである。**
 * **`ADR-0120` 限定6 が「削除せず反転し、本 ADR を名指しするコメントを付ける」ことを課している。**
 *
 * **【この反転が言わないこと】** **`ADR-0120` は既知の穴を2つしか塞いでいない。**
 * **書込の応答**(下の (D) 2本目)**・MCP 経路・アプリが `view.sort` に宣言つき項目を書いた画面**
 * は今日も守られない。
 *
 * **【2026-08-04 追記。`V4-M35` / ユーザ決定 `D-V4-124`】** **直前の1文のうち「書込の応答」は
 * 今日から偽である**(**判定時点の記述としてそのまま残す**)—— **`V4-M35` が書込3経路に
 * 読取と同じ射影を掛けた**(下の (D) 2本目は反転済み)。**MCP 経路と `view.sort` の画面に
 * ついては今日も真である。**
 */
test("(D)【反転】客に見せない項目で絞り込む読取の要求は 400 で拒否される(ADR-0120 限定1)", async () => {
  await seedProduct();
  const c = session("customer");
  // **`stock` は customer の応答に出ず、読取の要求の条件にも書けない。**
  const hit = await req(c.cookie, "GET", `${PRODUCTS}?filter.stock=12`);
  expect(hit.status).toBe(400);
  const miss = await req(c.cookie, "GET", `${PRODUCTS}?filter.stock=99`);
  expect(miss.status).toBe(400);
  // **当たりと外れの区別が付かない** —— **これが穴の塞ぎ方である**(応答の本文も同じ)。
  expect(await hit.text()).toBe(await miss.text());
  // **並べ替えも同じ**(`ADR-0120` は `filter` と `sort` を同じ判定にした。同 §2)。
  const sorted = await req(c.cookie, "GET", `${PRODUCTS}?sort=stock&order=asc`);
  expect(sorted.status).toBe(400);
  // **宣言していない項目は1ミリも変わらない**(限定12)。
  const plain = await req(c.cookie, "GET", `${PRODUCTS}?filter.cost=300`);
  expect(plain.status).toBe(200);
});

/**
 * **【反転した検査。`V4-M35` / ユーザ決定 `D-V4-124` による】**
 *
 * **反転前の逐語**(2026-08-04 まで緑だったもの。**1バイトも書き換えずに残す**):
 *
 * ```
 * test("(D) 書込の応答には射影を掛けていない(限定4 の帰結。正直に固定する)", async () => {
 *   // **これは「守っていない経路」である。** **`ADR-0071` 限定4 が「落とすのは読取の応答だけ」と
 *   // 定めたので、`POST` / `PATCH` が返す `record` には掛けていない。**
 *   // **customer が書けるのは自分の行だけなので実害は小さいが、「掛かっている」と読ませない。**
 *   const c = session("customer");
 *   const created = await req(c.cookie, "POST", ORDERS, { total: 100, memo: "内部メモ" });
 *   expect(created.status).toBe(201);
 *   const record = ((await created.json()) as { record: Record<string, unknown> }).record;
 *   expect(Object.keys(record)).toContain("memo");
 * });
 * ```
 *
 * **なぜ反転したか**: **ユーザ決定 `D-V4-124`**(`docs/plan/v4/records/v4-open-questions.md`
 * §5d)が、**隠した項目に残る4つの漏れ口のうち3つを塞ぐと決めた** —— その (b) が
 * 「**作成・更新の応答に値がそのまま出る**」である。**`V4-M35` が
 * `src/server/app.ts` の書込3経路(`POST` / `PATCH` / `/batch`)に、読取とまったく同じ射影
 * (`projectForFieldAudience`)を掛けた。**
 *
 * **【この反転が言わないこと。誇張しない】** **`ADR-0071` 限定4 / `ADR-0120` 限定7 が
 * 「書込の応答を1バイトも変えない」と書いた場所を破っている。** **`ADR-0071` §3a の 3 が
 * この単位に門A を要求しており、`V4-M35` はその審査を通していない**(判定は
 * `docs/plan/v4/records/v4-m35.md` §5 / §8 に正直に書いた)。
 * **また、塞いだのは「応答に出ること」だけである** —— **客が更新で書き込めること
 * ((d))は今日も塞がっていない**(`D-V4-124` が明文で「今日のまま」と決めた)。
 */
test("(D)【反転】書込の応答にも読取と同じ射影が掛かる(V4-M35 / D-V4-124 の (b))", async () => {
  const c = session("customer");
  const created = await req(c.cookie, "POST", ORDERS, { total: 100, memo: "内部メモ" });
  expect(created.status).toBe(201);
  const record = ((await created.json()) as { record: Record<string, unknown> }).record;
  expect(Object.keys(record)).not.toContain("memo");
  // **【今日も塞がっていない】値そのものは書けている。** **落ちたのは応答だけである。**
  expect(created.status).toBe(201);
});

// --- (E) 限定8: 「静かに漏れる」ことを検査で可視化する -----------------------------------

test("(E)【静かに漏れる】宣言し忘れた項目は今日どおり全員に出る。カーネルは何も言わない", async () => {
  // **`ADR-0071` 限定7 / 限定8。** `cost`(仕入原価)は **`audience` を書き忘れている。**
  // **落ちる向きは危険側である** —— **`st_admin_readable` の書き忘れは「見えない」(安全側)に
  // 落ちたが、こちらの書き忘れは「見える」(危険側)に落ちる**(`V3-M11` が実証した穴の裏返し)。
  // **この検査は防いでいない。見えるようにしているだけである。**
  const id = await seedProduct();
  const c = session("customer");
  expect(await listKeys(c.cookie)).toContain("cost");
  expect(await oneKeys(c.cookie, id)).toContain("cost");
  // **匿名にも出る。**
  expect(await listKeys(undefined)).toContain("cost");
  // **警告もエラーも1件も出ていない**(応答は 200 で、`errors` が無い)。
  const res = await req(c.cookie, "GET", PRODUCTS);
  expect(res.status).toBe(200);
  expect((await res.json()) as { errors?: unknown }).not.toHaveProperty("errors");
});

// --- (Y) 【守らない経路】マニフェストは未ログインで全フィールド定義を返す ------------------

// **【`V8-M21` / 台帳 `J-G24a` / ユーザ決定 `D-V8-21` による更新。旧文を1バイトも消していない】**
//
// **旧テスト名**: 「(Y)【守らない】GET /manifest は未ログインで、隠した項目の定義も面の規則も
// そのまま返す」。**旧の期待値**: `expect(res.status).toBe(200);` + 未ログインの応答本文に
// `stock` の定義と `owner` の項目の規則が在ること。
//
// **`D-V8-21`(選ばれた見出し = 塞ぐ(ログインを要求))を `V8-M21` が実装したので、
// 未ログインの応答は **401** になった。** **検査は消していない** —— **同じ主題
// (「定義は誰に渡るか」)を、閉じた側と、閉じていない側の両方で測る形に書き換えた。**
//
// **【緩めていない。要求を1本増やした】** —— **(1) 未ログインは 401 である /
// (2) ログインすれば今日も定義は丸ごと読める**(= `ADR-0071` §限界4 の「落とすのは値で
// あって定義ではない」は、**ログインした人については1ミリも解けていない**)。
test("(Y)【半分だけ塞いだ】GET /manifest は未ログインで 401。ログインすれば隠した項目の定義も面の規則もそのまま返る", async () => {
  // **落とすのは値であって定義ではない**(`ADR-0071` §限界4)。
  //
  // **【`V8-M20` / `J-G28` による置き直し。旧の逐語をここに残す】**
  // **旧テスト名**: 「(Y)【守らない】GET /manifest は未ログインで audience つきの全フィールド定義を返す」
  // **旧の期待値**:
  // ```
  // expect(product?.fields.find((field) => field.id === "stock")?.audience).toEqual([
  //   "owner",
  //   "editor",
  // ]);
  // ```
  // **`field.audience` は廃止されたので、未ログインが読めるのは `app.roles` の規則である** ——
  // **「隠した項目の名前が未ログインに知られる」という限界は1ミリも変わっていない。**
  // **むしろ、誰に見せる項目なのかまで規則の形で読める。**
  // **(1) 未ログインは 401**(`V8-M21` / `J-G24a`)。
  expect((await req(undefined, "GET", `/api/apps/${APP_ID}/manifest`)).status).toBe(401);
  // **(2) ログインすれば今日も定義は丸ごと読める** —— **買い物客(customer)でも読める。**
  // **`J-G24a` が要求したのは「ログインを要求する」ことであって、役割で削ることではない。**
  const res = await req(session("customer").cookie, "GET", `/api/apps/${APP_ID}/manifest`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    app: {
      tables: { id: string; fields: { id: string }[] }[];
      roles?: { id: string; rules?: { target: string; table?: string; field?: string }[] }[];
    };
  };
  const product = body.app.tables.find((table) => table.id === "product");
  expect(product?.fields.map((field) => field.id)).toContain("stock");
  // **面の規則も、そのまま未ログインに出る。**
  const ownerRules = body.app.roles?.find((role) => role.id === "owner")?.rules ?? [];
  expect(
    ownerRules.some(
      (rule) => rule.target === "field" && rule.table === "product" && rule.field === "stock",
    ),
  ).toBe(true);
});
