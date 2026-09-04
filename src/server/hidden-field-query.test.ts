/**
 * **「客に見せない」と宣言した項目を、読取の要求の絞り込み・並べ替えの条件に書けなくする**
 * ことの実測(`V4-M28-T01`)。**限定表の正は
 * [`docs/adr/0120-hidden-field-query-restriction.md`](../../docs/adr/0120-hidden-field-query-restriction.md) §3'**、
 * 完了条件の正は `docs/plan/v4/06-followup-milestones.md` §1-2 の `V4-M28-T01` の行。
 *
 * ## ここで測るもの(**本物の SQLite / 本物の HTTP**)
 *
 * | # | 何を | 完了条件 / 限定 |
 * |---|---|---|
 * | (1) | `?filter=<JSON>` の葉が宣言つき項目を指したら **400**(and / or / not のどの深さでも) | (1) / 限定1 |
 * | (2) | `?filter.<field>=` の平坦形も **400** | (2) / 限定1 |
 * | (3) | `?sort=<field>` も **400**(複合ソートの2キー目でも) | (3) / 限定1 |
 * | (4) | 拒否は**全か無か** —— 条件を部分的に落として 200 を返さない | (4) / 限定3 |
 * | (5) | **匿名 / customer / viewer / editor / owner の5経路すべてで同じ 400** | (5) / 限定2 |
 * | (6) | 400 の本文に、要求された**値**が1バイトも載らない | (6) / 限定8 |
 * | (7) | 宣言していない項目での絞り込み・並べ替えは今日どおり 200 | (7) / 限定12 |
 * | (限定5) | 葉演算子5種・深度上限8 の逐語が1バイトも動いていない | 限定5 |
 * | (限定9) | `?sort=` の 400 の `allowed_values` は1バイトも変わっていない | 限定9 |
 * | (限定1) | **マニフェストの `view.filter` / `view.sort` は今日どおり適用できる** | 限定1 |
 *
 * ## 【この検査が言わないこと。誇張しない】
 *
 * 1. **【禁止】「隠した項目が漏れなくなった」と書かない。** **塞がっていない穴が今日も在る** ——
 *    **(a) `POST` / `PATCH` の応答本文には宣言した項目の値がそのまま出る**(`ADR-0120` 限定7。
 *    `field-audience-projection.test.ts` の「(D) 書込の応答には射影を掛けていない」が実測)/
 *    **(b) MCP の `list_records` は宣言を1つも見ない**(`ADR-0071` 限定9)/
 *    **(c) `?sort=` の 400 の `allowed_values` には宣言した項目のIDが今日も並ぶ**(限定9)。
 *
 *    **【2026-08-04 追記。`V4-M35` / ユーザ決定 `D-V4-124`】** **直前の (a) と (c) は
 *    今日から偽である**(**判定時点の記述としてそのまま残す**)—— **`V4-M35` が
 *    書込3経路に読取と同じ射影を掛け、`allowed_values` から宣言つき項目のIDを落とした。**
 *    **(b) は今日も真である。** **下の「(限定9)」は反転済みである。**
 *    **なお、客が更新で宣言つき項目に書けること自体は今日も塞がっていない**
 *    (`D-V4-124` が明文で「今日のまま」と決めた)。
 * 2. **書き忘れた項目は今日どおり誰にでも出るし、条件にも書ける**(限定12。下の (7) が `cost` で実測)。
 * 3. **owner の能力も減る**(限定2)。**これは受け入れた代償である**(`ADR-0120` §限界4)。
 * 4. **`view.sort` に宣言つき項目を書いた画面の描画は、今日どおりには動かない** ——
 *    **表示層は `view.sort` を `?sort=` へ翻訳して投げるので、その要求もここで 400 になる**
 *    (下の (限定1) が実測する)。**`ADR-0120` 限定1 の第4列後半(「その画面が今日どおり
 *    描けること」)は満たせていない。** **`docs/plan/v4/records/v4-m28.md` §4 / §9 に全文を書いた。**
 *
 * ---
 *
 * ## **【`V8-M20` / 台帳 `J-G28` / `ADR-0301`】「宣言つき項目」の意味だけが変わった**
 *
 * **上の表と注意書きを1バイトも書き換えていない。** **`field.audience` は廃止され、
 * 400 を出す述語は面の側(`isRoleGovernedField` = **面の項目の規則がその項目を名指しして
 * いるか**)に差し替わった。** **測る性質(「隠した項目を `?filter=` / `?sort=` に書けない」)は
 * 1ミリも変えていない**(`ADR-0301` 限定6 の置き直し)。
 *
 * **【正直に書く。3点】**
 *
 * 1. **述語はロールを1つも見ない** —— **面の規則を「誰か」が書いた時点で、その項目は
 *    **誰の要求でも** 400 になる**(`ADR-0120` 限定2 と同じ形)。**下の (5) は今日も緑である。**
 * 2. **応答の `message` / `hint` の日本語は「役割の規則(roles の rules)が名指ししている」に
 *    書き換わっている**(製品コード側。本ファイルは文面を1件も検査していないので、
 *    期待値の書き換えは1つも要らなかった)。
 * 3. **面の規則は対象を名指しした時点で全動詞が allow-list になる** —— **下の fixture は
 *    `owner` に `write` を明示的に足してある**(`seedProduct` が owner で `sku` / `stock` を
 *    書くため)。**着手前の `audience` は書込を1バイトも絞らなかった。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { PUBLIC_FIELD } from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "hidden-query-shop";
/** **宣言が1本も無いアプリ**(限定12 の当たり先)。 */
const PLAIN_APP_ID = "plain-query-shop";

/** 要求に書く値。**400 の本文にこれが1バイトも出ないことを (6) が見る。** */
const SECRET_SKU = "SKU-ORACLE-9F3A";
const SECRET_STOCK = 424242;

/**
 * **面の規則**(`V8-M20` の置き直し)。
 *
 * **【置き直し前の形。1バイトも書き換えずに残す】** ——
 * `sku` / `stock` に `audience: ["owner", "editor"]`。
 */
const ROLES = [
  {
    id: "owner",
    name: "持ち主",
    rules: [
      // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
      { target: "app", can: ["write"] },
      { target: "role", can: ["write"] },
      { target: "field", table: "product", field: "sku", can: ["read", "write"] },
      { target: "field", table: "product", field: "stock", can: ["read", "write"] },
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
  { id: "viewer", name: "閲覧者" },
];

/**
 * `D-V4-36` の題材をそのまま使う(`field-audience-projection.test.ts` と同じ形)。
 *
 * - `sku` / `stock` … **運営だけに見せると宣言した項目。**
 * - `cost` … **宣言し忘れた項目**(限定12 の題材。**今日どおり条件に書ける**)。
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
            { id: "cost", name: "仕入原価", type: "number" },
            { id: PUBLIC_FIELD, name: "公開", type: "boolean" },
          ],
        },
      ],
      views: [{ id: "catalog-list", type: "list_view", table: "product", columns: ["name"] }],
      roles: ROLES,
    },
  } as unknown as Manifest;
}

/** **面の規則を1本も書いていないアプリ**(限定12)。 */
function plainManifest(): Manifest {
  return {
    app: {
      id: PLAIN_APP_ID,
      name: "宣言の無い店",
      tables: [
        {
          id: "product",
          name: "商品",
          fields: [
            { id: "name", name: "商品名", type: "text", required: true },
            { id: "stock", name: "在庫数", type: "number" },
            { id: PUBLIC_FIELD, name: "公開", type: "boolean" },
          ],
        },
      ],
      views: [{ id: "catalog-list", type: "list_view", table: "product", columns: ["name"] }],
    },
  };
}

/**
 * **【`V8-M26`】適用する題材に、表 `product` を読める役割を足す。**
 *
 * **既定が閉じた**(`V8-M26` / ユーザ決定 `D-V8-45` / `D-V8-65`)—— **規則を1本も
 * 名指ししていない表・画面・ボタンは拒否される。****本ファイルの主題は「隠した項目を
 * `?filter=` / `?sort=` に書けないこと」であり、項目の層は今日も閉じていない**
 * (台帳 `T-G1b` = 却下)。**したがって表を開けても主題は1ミリも動かない。**
 *
 * - `withDefaultRoleRules` が既定3役割へ入れるのは `apply-diff.ts` の自動付与と同じ規則だけ
 *   である(**項目の規則は1本も足さない**)。
 * - **`customer` と `anonymous` は既定3役割に入らないので手で書く** —— **足すのは表
 *   `product` の読取1語だけである。** **(5) が「匿名 / customer / viewer / editor / owner の
 *   5経路すべてで同じ 400」を測る検査なので、読めない相手が混じると主題が測れない。**
 */
function openProduct<M>(manifest: M): M {
  const m = structuredClone(manifest) as {
    app: { roles?: { id: string; name: string; rules?: unknown[] }[] };
  };
  m.app.roles = [
    ...(m.app.roles ?? []),
    {
      id: "customer",
      name: "お客様",
      rules: [{ target: "table", table: "product", can: ["read"] }],
    },
    {
      id: "anonymous",
      name: "未ログイン",
      rules: [{ target: "table", table: "product", can: ["read"] }],
    },
  ];
  return withDefaultRoleRules(m) as M;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-hidden-query-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "見せ分けの店", { app_id: APP_ID });
    createApp(store, "宣言の無い店", { app_id: PLAIN_APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, openProduct(manifest())).valid).toBe(true);
  expect(applyManifest(dataRoot, PLAIN_APP_ID, openProduct(plainManifest())).valid).toBe(true);
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function req(cookie: string | undefined, method: string, path: string, body?: unknown) {
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
const PLAIN_PRODUCTS = `/api/apps/${PLAIN_APP_ID}/tables/product/records`;

function session(role: "owner" | "editor" | "viewer" | "customer", app_id = APP_ID) {
  return seedSession(dataRoot, app_id, { role, username: `${role}-${Math.random()}` });
}

async function seedProduct(): Promise<void> {
  const o = session("owner");
  const res = await req(o.cookie, "POST", PRODUCTS, {
    name: "梅干し",
    price: 800,
    sku: SECRET_SKU,
    stock: SECRET_STOCK,
    cost: 300,
    [PUBLIC_FIELD]: true,
  });
  expect(res.status).toBe(201);
}

/** ブール式 filter を JSON1個で渡す(表示層が組み立てるのと同じ形)。 */
function filterUrl(base: string, node: unknown): string {
  return `${base}?${new URLSearchParams({ filter: JSON.stringify(node) }).toString()}`;
}

// ---------------------------------------------------------------------------
// (1) `?filter=<JSON>`(and / or / not のどの深さでも)
// ---------------------------------------------------------------------------

test("(1) 宣言つき項目を指した filter の葉は 400 —— 素の葉", async () => {
  await seedProduct();
  const c = session("customer");
  const res = await req(
    c.cookie,
    "GET",
    filterUrl(PRODUCTS, { field: "stock", equals: SECRET_STOCK }),
  );
  expect(res.status).toBe(400);
});

test("(1) and / or / not のどの深さに置いても 400", async () => {
  await seedProduct();
  const c = session("customer");
  const leaf = { field: "stock", gte: SECRET_STOCK };
  const nodes: unknown[] = [
    { and: [leaf] },
    { or: [{ field: "name", contains: "梅" }, leaf] },
    { not: leaf },
    // 深いネスト(深度上限8 の内側)。**どの深さでも見つける。**
    { and: [{ or: [{ not: { and: [{ or: [leaf] }] } }] }] },
  ];
  for (const node of nodes) {
    const res = await req(c.cookie, "GET", filterUrl(PRODUCTS, node));
    expect(res.status, JSON.stringify(node)).toBe(400);
  }
});

test("(1) 葉演算子5種のどれで書いても 400(equals / contains / gte / lte / in)", async () => {
  await seedProduct();
  const c = session("customer");
  const leaves: unknown[] = [
    { field: "sku", equals: SECRET_SKU },
    { field: "sku", contains: SECRET_SKU },
    { field: "stock", gte: SECRET_STOCK },
    { field: "stock", lte: SECRET_STOCK },
    { field: "sku", in: [SECRET_SKU] },
  ];
  for (const leaf of leaves) {
    const res = await req(c.cookie, "GET", filterUrl(PRODUCTS, leaf));
    expect(res.status, JSON.stringify(leaf)).toBe(400);
  }
});

// ---------------------------------------------------------------------------
// (2) `?filter.<field>=` の平坦形
// ---------------------------------------------------------------------------

test("(2) 平坦形 filter.<field>= も 400(v0 からの後方互換の口も塞ぐ)", async () => {
  await seedProduct();
  const c = session("customer");
  const res = await req(c.cookie, "GET", `${PRODUCTS}?filter.stock=${SECRET_STOCK}`);
  expect(res.status).toBe(400);
  const skuRes = await req(c.cookie, "GET", `${PRODUCTS}?filter.sku=${SECRET_SKU}`);
  expect(skuRes.status).toBe(400);
});

// ---------------------------------------------------------------------------
// (3) `?sort=<field>`
// ---------------------------------------------------------------------------

test("(3) 宣言つき項目での並べ替えは 400(単数キー)", async () => {
  await seedProduct();
  const c = session("customer");
  const res = await req(c.cookie, "GET", `${PRODUCTS}?sort=stock&order=asc`);
  expect(res.status).toBe(400);
});

test("(3) 複合ソートの2キー目に混ぜても 400(全体を拒否する)", async () => {
  await seedProduct();
  const c = session("customer");
  const res = await req(c.cookie, "GET", `${PRODUCTS}?sort=name&order=asc&sort=stock&order=desc`);
  expect(res.status).toBe(400);
});

// ---------------------------------------------------------------------------
// (4) 拒否は全か無か(限定3)
// ---------------------------------------------------------------------------

test("(4) 宣言つきと宣言なしを混ぜた条件は、部分的に落とさず全体を 400 にする", async () => {
  await seedProduct();
  const c = session("customer");
  const mixed = {
    and: [
      { field: "name", contains: "梅" },
      { field: "stock", equals: SECRET_STOCK },
    ],
  };
  const res = await req(c.cookie, "GET", filterUrl(PRODUCTS, mixed));
  expect(res.status).toBe(400);
  const body = (await res.json()) as { records?: unknown[]; errors?: unknown[] };
  // **行は1件も返らない**(条件を落として 200 にしていない)。
  expect(body.records).toBeUndefined();
  expect(Array.isArray(body.errors)).toBe(true);
});

test("(4) filter と sort の両方に宣言つき項目が在るときも 400 の1回で全体を拒否する", async () => {
  await seedProduct();
  const c = session("customer");
  const url = `${PRODUCTS}?filter.stock=${SECRET_STOCK}&sort=sku&order=asc`;
  const res = await req(c.cookie, "GET", url);
  expect(res.status).toBe(400);
  const body = (await res.json()) as { records?: unknown[] };
  expect(body.records).toBeUndefined();
});

// ---------------------------------------------------------------------------
// (5) 5経路すべてで同じ 400(限定2。**ロールを見ない**)
// ---------------------------------------------------------------------------

test("(5) 匿名 / customer / viewer / editor / owner の5経路すべてで同じ 400 になる(filter)", async () => {
  await seedProduct();
  const cookies: [string, string | undefined][] = [
    ["anonymous", undefined],
    ["customer", session("customer").cookie],
    ["viewer", session("viewer").cookie],
    ["editor", session("editor").cookie],
    ["owner", session("owner").cookie],
  ];
  const messages: string[] = [];
  for (const [label, cookie] of cookies) {
    const res = await req(cookie, "GET", `${PRODUCTS}?filter.stock=${SECRET_STOCK}`);
    expect(res.status, label).toBe(400);
    const body = (await res.json()) as { errors: { message: string }[] };
    messages.push(body.errors.map((error) => error.message).join("|"));
  }
  // **文面まで同じである** —— **相手によって割れない**(`ADR-0086` 限定4 の「書けるが効かない」を作らない)。
  expect(new Set(messages).size).toBe(1);
});

test("(5) 匿名 / customer / viewer / editor / owner の5経路すべてで同じ 400 になる(sort)", async () => {
  await seedProduct();
  const cookies: [string, string | undefined][] = [
    ["anonymous", undefined],
    ["customer", session("customer").cookie],
    ["viewer", session("viewer").cookie],
    ["editor", session("editor").cookie],
    ["owner", session("owner").cookie],
  ];
  const messages: string[] = [];
  for (const [label, cookie] of cookies) {
    const res = await req(cookie, "GET", `${PRODUCTS}?sort=sku&order=asc`);
    expect(res.status, label).toBe(400);
    const body = (await res.json()) as { errors: { message: string }[] };
    messages.push(body.errors.map((error) => error.message).join("|"));
  }
  expect(new Set(messages).size).toBe(1);
});

test("(5) owner が読むと値そのものは今日どおり見える —— 減ったのは URL に条件を書く能力だけ", async () => {
  await seedProduct();
  const o = session("owner");
  const res = await req(o.cookie, "GET", PRODUCTS);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { records: Record<string, unknown>[] };
  expect(body.records[0]?.sku).toBe(SECRET_SKU);
  expect(body.records[0]?.stock).toBe(SECRET_STOCK);
});

// ---------------------------------------------------------------------------
// (6) 400 の本文に、要求された値を1バイトも載せない(限定8)
// ---------------------------------------------------------------------------

test("(6) 400 の本文に、要求された値が1バイトも載らない(新しいオラクルを作らない)", async () => {
  await seedProduct();
  const c = session("customer");
  for (const url of [
    `${PRODUCTS}?filter.sku=${SECRET_SKU}`,
    `${PRODUCTS}?filter.stock=${SECRET_STOCK}`,
    filterUrl(PRODUCTS, { field: "sku", contains: SECRET_SKU }),
  ]) {
    const res = await req(c.cookie, "GET", url);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text.includes(SECRET_SKU), url).toBe(false);
    expect(text.includes(String(SECRET_STOCK)), url).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// (7) 宣言していない項目は今日どおり 200(限定12)
// ---------------------------------------------------------------------------

test("(7) 宣言していない項目での絞り込み・並べ替えは今日どおり 200 で通る", async () => {
  await seedProduct();
  const c = session("customer");
  const hit = await req(c.cookie, "GET", `${PRODUCTS}?filter.name=${encodeURIComponent("梅干し")}`);
  expect(hit.status).toBe(200);
  expect(((await hit.json()) as { records: unknown[] }).records).toHaveLength(1);

  const sorted = await req(c.cookie, "GET", `${PRODUCTS}?sort=price&order=desc`);
  expect(sorted.status).toBe(200);

  // **書き忘れた項目(`cost`)は今日どおり条件に書ける** —— **既定は「出す」である**(限定12)。
  const cost = await req(c.cookie, "GET", `${PRODUCTS}?filter.cost=300`);
  expect(cost.status).toBe(200);
  expect(((await cost.json()) as { records: unknown[] }).records).toHaveLength(1);

  const json = await req(c.cookie, "GET", filterUrl(PRODUCTS, { field: "price", gte: 100 }));
  expect(json.status).toBe(200);
});

test("(7) 宣言が1本も無いアプリは1ミリも変わらない(限定12)", async () => {
  const o = session("owner", PLAIN_APP_ID);
  const created = await req(o.cookie, "POST", PLAIN_PRODUCTS, {
    name: "塩",
    stock: 5,
    [PUBLIC_FIELD]: true,
  });
  expect(created.status).toBe(201);
  const c = session("customer", PLAIN_APP_ID);
  const filtered = await req(c.cookie, "GET", `${PLAIN_PRODUCTS}?filter.stock=5`);
  expect(filtered.status).toBe(200);
  expect(((await filtered.json()) as { records: unknown[] }).records).toHaveLength(1);
  const sorted = await req(c.cookie, "GET", `${PLAIN_PRODUCTS}?sort=stock&order=asc`);
  expect(sorted.status).toBe(200);
});

// ---------------------------------------------------------------------------
// 限定5: 葉演算子5種・深度上限8 を1バイトも変えていない(逐語)
// ---------------------------------------------------------------------------

test("(限定5) MAX_FILTER_DEPTH / LEAF_OPERATORS の逐語が1バイトも動いていない", () => {
  const recordsSource = readFileSync(
    join(dirname(import.meta.dir), "kernel", "records.ts"),
    "utf-8",
  );
  expect(recordsSource).toContain("export const MAX_FILTER_DEPTH = 8;");
  expect(recordsSource).toContain(
    'const LEAF_OPERATORS = ["equals", "contains", "gte", "lte", "in"] as const;',
  );
});

// ---------------------------------------------------------------------------
// 限定9: `?sort=` の 400 の `allowed_values` を1バイトも変えていない
// ---------------------------------------------------------------------------

/**
 * **【反転した検査。`V4-M35` / ユーザ決定 `D-V4-124` による】**
 *
 * **反転前の逐語**(2026-08-04 まで緑だったもの。**1バイトも書き換えずに残す**):
 *
 * ```
 * test("(限定9)【塞いでいない】実在しない項目での sort の 400 には、宣言つき項目のIDが今日も並ぶ", async () => {
 *   // **`v4-fix1-boundary-bypass.md` §2 (c) の 2 が「狭めても効果が0」と実測済み**
 *   // (`GET /manifest` が未ログインで全項目の定義を返すため)。**本タスクは1バイトも変えない。**
 *   const c = session("customer");
 *   const res = await req(c.cookie, "GET", `${PRODUCTS}?sort=no_such_field&order=asc`);
 *   expect(res.status).toBe(400);
 *   const body = (await res.json()) as { errors: { allowed_values?: string[] }[] };
 *   const allowed = body.errors.flatMap((error) => error.allowed_values ?? []);
 *   expect(allowed).toContain("stock");
 *   expect(allowed).toContain("sku");
 * });
 * ```
 *
 * **なぜ反転したか**: **ユーザ決定 `D-V4-124` の (c)(入力エラーの文に項目名が並ぶ)を
 * `V4-M35` が塞いだ。** **`ADR-0120` 限定9(「`allowed_values` を1バイトも変えない」)を
 * 破っている** —— **`ADR-0120` §4 の 5 は、この限定を破るには門A の新規審査が要ると
 * 書いている。** **`V4-M35` はその審査を通していない**(判定は
 * `docs/plan/v4/records/v4-m35.md` §5 / §8 に正直に書いた)。
 *
 * **【正直に書く】`ADR-0120` 限定9 が挙げた「効果が0」という理由は、今日も一部は正しい** ——
 * **`GET /manifest` は未ログインで全項目の定義を今日も返す**(`D-V4-91`)。**したがって
 * 「隠した項目の名前を知られない」ようにはなっていない。** **変わったのは「入力を1回
 * 間違えるだけで一覧が返ってくる」経路が閉じたことだけである。**
 */
test("(限定9)【反転】実在しない項目での sort の 400 に、宣言つき項目のIDはもう並ばない(V4-M35)", async () => {
  const c = session("customer");
  const res = await req(c.cookie, "GET", `${PRODUCTS}?sort=no_such_field&order=asc`);
  expect(res.status).toBe(400);
  const body = (await res.json()) as { errors: { allowed_values?: string[] }[] };
  const allowed = body.errors.flatMap((error) => error.allowed_values ?? []);
  expect(allowed).not.toContain("stock");
  expect(allowed).not.toContain("sku");
  // **宣言していない項目は今日どおり並ぶ**(既定を1ミリも変えていない)。
  expect(allowed).toContain("name");
  expect(allowed).toContain("cost");
  // **【今日も塞がっていない。ただし相手が変わった】**
  // **【`V8-M21` / `J-G24a` / `D-V8-21` による更新。旧文を1バイトも消していない】**
  // **旧のコメント逐語**: 「【今日も塞がっていない】同じ名前は `GET /manifest` から
  // 未ログインでも読める(`D-V4-91`)。「知られなくなった」とは書かない。」
  // **旧の呼び出し**: `const manifestRes = await req(undefined, "GET", …);`
  // **`D-V8-21` が `D-V4-91` の「今のままでよい」を覆したので、未ログインは 401 である。**
  // **それでも「知られなくなった」とは書かない** —— **ログインした客(customer)には
  // 今日も同じ名前が読める。** **隠した項目の名前は、その相手には今日も筒抜けである。**
  expect((await req(undefined, "GET", `/api/apps/${APP_ID}/manifest`)).status).toBe(401);
  const manifestRes = await req(c.cookie, "GET", `/api/apps/${APP_ID}/manifest`);
  expect((await manifestRes.text()).includes("stock")).toBe(true);
});

// ---------------------------------------------------------------------------
// 限定1: マニフェストの `view.filter` / `view.sort` に1バイトも触っていない
// ---------------------------------------------------------------------------

test("(限定1) view.filter / view.sort に宣言つき項目を書いたマニフェストは、今日どおり適用できる", () => {
  const declared = manifest();
  // **既存のビューは残したまま足す**(マニフェスト直渡しの経路はビューの削除を表せない)。
  declared.app.views = [
    ...(declared.app.views ?? []),
    {
      id: "admin-list",
      type: "list_view",
      table: "product",
      columns: ["name"],
      filter: [{ field: "stock", equals: SECRET_STOCK }],
      sort: { field: "sku", order: "asc" },
    } as never,
  ];
  // **本物の SQLite に入る**(宣言の側は1バイトも止めていない。限定1)。
  expect(applyManifest(dataRoot, APP_ID, declared).valid).toBe(true);
});

test("(限定1)【守れなかった】表示層がその画面のために投げる読取要求は、今日は 400 になる", async () => {
  // **`ADR-0120` 限定1 の第4列後半は「その画面が今日どおり描けること」を求めている。**
  // **満たせていない** —— **表示層(`web/src/api.ts` の `buildListQuery`)は `view.sort` を
  // `?sort=` へ、`view.filter` を `?filter.<field>=` / `?filter=<JSON>` へ翻訳して投げるので、
  // 画面から出た要求と、住所欄に手で書いた要求は、サーバから見て1バイトも違わない。**
  // **限定2(ロールを見ない)と限定1 の第4列は同時に満たせない。**
  // **この検査は「守れた」ではなく「守れなかった」を固定するためのものである**(憲法6)。
  await seedProduct();
  const o = session("owner");
  const asDisplayLayerWouldSend = `${PRODUCTS}?sort=sku&order=asc&filter.stock=${SECRET_STOCK}&view=admin-list`;
  const res = await req(o.cookie, "GET", asDisplayLayerWouldSend);
  expect(res.status).toBe(400);
});
