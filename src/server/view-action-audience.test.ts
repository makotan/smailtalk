/**
 * **サーバのレコード経路が「見せる相手」の宣言を読むか**(`V5-M23-T05`)。
 *
 * **実施記録**: [`docs/plan/v5/records/v5-m23.md`](../../docs/plan/v5/records/v5-m23.md) §5。
 *
 * ## なぜこのファイルが要るのか
 *
 * **`V5-M22` の実施記録が自ら申告している**(`v5-m22.md:491` 逐語):
 *
 * > **`audience` をサーバが実際に落とすことを1件も測っていない。** … **`src/server/owner-scope.ts`
 * > を1度も走らせていない。**
 *
 * **本ファイルはそこを測る側である。** **測るのは3つの `audience` すべてである**:
 *
 * | 粒度 | 置き場 | サーバは読むか |
 * |---|---|---|
 * | 画面単位 | `$defs/view.audience`(`ADR-0070` / `ADR-0074`) | **(A) 群が測る** |
 * | 項目単位 | `$defs/field.audience`(`ADR-0071`) | **(B) 群が測る** |
 * | **操作起点単位** | **`$defs/view_action.audience`(`ADR-0177`)** | **(C) 群が測る** |
 *
 * ## **本ファイルが出した答えを先に書く(誇張しない)**
 *
 * 1. **画面単位はサーバが読む** —— **その画面を名乗ったレコード要求は 403 になる**(A-1)。
 *    **ただしマニフェストからは1画面も落ちない**(A-3)—— **`ADR-0070` 限定7 のとおりである。**
 * 2. **項目単位はサーバが読む** —— **応答の JSON からその項目が落ちる**(B-1)。
 * 3. **操作起点単位はサーバが1バイトも読まない** —— **宣言してもしなくても、
 *    同じ要求に同じ応答が返る**(C-1 / C-2)。**見えないだけで、叩けば通る。**
 *    **これは `ADR-0177` 限定6 が意図した形であって、不具合ではない** ——
 *    **【禁止】これを「穴が開いている」と書かない。** **【禁止】同時に
 *    「権限による出し分けができた」とも書かない** —— **操作起点の宣言は
 *    先回りガードであって防御ではない。**
 *
 * ## この検査が言えないこと
 *
 * - **MCP 経路(`list_records` など)を1件も測っていない**(`ADR-0071` 限定9 /
 *   `ADR-0070` 限定8 が「MCP 経路は守らない」と書いている)。
 * - **ブラウザを1度も開いていない。**
 *
 * ## **追記(`V5-M28-T02`。上の3を1バイトも消していない)**
 *
 * **上の「3. 操作起点単位はサーバが1バイトも読まない」は、今日は偽である。**
 * **`A-G1`(門A / 判定 = 限定採用。[`ADR-0249`](../../docs/adr/0249-view-action-audience-write-wall.md))が
 * `ADR-0177` 限定6 前段・`ADR-0241` 限定1 を引き直し、`V5-M28-T01`/`T02` が実装した。**
 * **旧文を残しているのは、それが当時の実測だったからである**(`V5-M23` の時点では真だった)。
 *
 * **今日の (C) 群が測るもの**:
 *
 * | # | 何を測るか |
 * |---|---|
 * | `(C-1)` | **宣言の外の相手の `POST` が 403 になる**(宣言なしの 201 と**違う**) |
 * | `(C-2)` | **宣言はマニフェストの応答にそのまま出る**(**1バイトも書き換えていない**) |
 * | `(C-3)` | **壁は `?view=` に依存しない**(名乗っても名乗らなくても 403) |
 * | `(C-4a)` | **宣言の有無だけで応答が違う**(**関数名を1文字も見ない**) |
 * | `(C-4b)` | **判定関数の名前が2ファイルにしか現れない**(家が1つ) |
 *
 * **【それでも「権限による出し分けができた」とは書かない】** **出す・出さないを決めるのは
 * 今日も表示層だけである**(`ADR-0249` §Decision 7 の 3 は `ADR-0177` §限界3 の**後段の
 * 禁止**を無効化していない)。**止まるのは作成と更新の2つだけで、`GET` / `DELETE` /
 * 受信口 / MCP / ワークフロー / コードの島は今日も通る**(同 限定1 / 限定13)。
 *
 * ## **追記(`V8-M20`。台帳 `J-G27` / `J-G28` / `J-G29`(3件とも判定 = 廃止)。手続きは `ADR-0301`)**
 *
 * **上の表と本文が名指ししている3つの `audience` は、今日は1つも存在しない。**
 * **旧文を1バイトも消していないのは、それが当時の実測だったからである。**
 *
 * | 粒度 | 旧(撤去済み) | 今日 |
 * |---|---|---|
 * | 画面単位 | `$defs/view.audience` | **役割 × 対象(画面)× 読取**(`{ target: "view", view, can: ["read"] }`) |
 * | 項目単位 | `$defs/field.audience` | **役割 × 対象(項目)× 読取**(`{ target: "field", table, field, can: ["read"] }`) |
 * | 操作起点単位 | `$defs/view_action.audience` | **役割 × 対象(ボタン)× 読取** から導く **表 × 書込** の壁 |
 *
 * **したがって本ファイルは1件も消していない** —— **(A) (B) (C) の3群とも、同じ問いを
 * 面(`app.roles[].rules`)の側で置き直している。** **期待値(403 / 落ちる / 403)は
 * 1バイトも変えていない。**
 *
 * **【`V8-M20` で変わった点。誇張しない】**
 *
 * - **(C) 群の題材の操作起点に識別子(`id`)を書き足した** —— **面のボタンの規則は
 *   `(view, action)` で名指しするからである。** **旧層は識別子が無くても効いていた**
 *   (`schemas/manifest.schema.json` の当該 `$comment` の逐語)。**識別子の無い操作起点は
 *   今日は壁の材料にならない**(穴。実測は `view-action-write-wall.test.ts` の `(W-12)`)。
 * - **`(C-2)`(宣言がマニフェストの応答にそのまま出る)は、見る場所が
 *   `app.views[].actions[].audience` から `app.roles[].rules` に移った。**
 * - **`(C-4b)`(家が1つ)は今日は成立しない** —— **同検査の doc に実測を書いた。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

/**
 * 移した公開単位の根(`apps/smailtalk/`)。**`import.meta.dir` から数える** ——
 * cwd 相対で解くと `bun test` を打つ場所で結果が変わる(`src/` はもうルート直下に無い)。
 */
const PRODUCT_ROOT = join(import.meta.dir, "..", "..");

const APP_ID = "action-audience-shop";

/** 操作起点の識別子。**面のボタンの規則はこの綴りで名指しする。** */
const ORDER_ACTION_ID = "go-order";

/**
 * **`declareActionRule` が真のときだけ、面に「ボタンの規則」を1本足す。**
 * **他は1バイトも変えない** —— **(C) 群はこの1点だけを差し替えて応答を突き合わせる。**
 *
 * **【`V8-M20` / `J-G29`】旧の引数名は `declareActionAudience` で、真のとき操作起点に
 * `audience: ["owner"]` を書いていた。** **今日はその宣言が存在しないので、
 * 同じ「運営だけに見せる」を面の規則
 * `{ target: "action", view: "catalog-list", action: "go-order", can: ["read"] }` で書く。**
 * **操作起点そのものは常に同じである**(識別子つき)—— **差し替えるのは規則1本だけ。**
 */
function manifest(declareActionRule: boolean): Manifest {
  // **【`V8-M20`】識別子(`id`)は常に書く** —— **無いと面から名指しできない。**
  const action: Record<string, unknown> = {
    id: ORDER_ACTION_ID,
    form: "order-form",
    prefill: { field: "product" },
    name: "注文する",
  };
  // **運営だけに見せる規則。** **customer には画面から出さない。**
  const ownerActionRules = declareActionRule
    ? [{ target: "action", view: "catalog-list", action: ORDER_ACTION_ID, can: ["read"] }]
    : [];
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
            // **【`V8-M20` / `J-G28`】項目単位。** **(B) 群が測る。**
            // **旧: `audience: ["owner", "editor"]` をここに書いていた。**
            // **新: 下の `roles` で `owner` / `editor` だけが `product.cost` を読める。**
            { id: "cost", name: "原価", type: "number" },
            { id: "st_public", name: "公開", type: "boolean" },
          ],
        },
        {
          id: "order",
          name: "注文",
          fields: [
            { id: "product", name: "商品", type: "reference", reference_table: "product" },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
      ],
      views: [
        {
          id: "catalog-list",
          type: "list_view",
          table: "product",
          columns: ["name"],
          actions: [action],
        },
        // **【`V8-M20` / `J-G27`】画面単位。** **(A) 群が測る。**
        // **旧: `audience: ["owner", "editor"]` をここに書いていた。**
        // **新: 下の `roles` で `owner` / `editor` だけがこの画面を読める。**
        {
          id: "admin-product-list",
          type: "list_view",
          table: "product",
          columns: ["name", "cost"],
        },
        { id: "order-form", type: "form", table: "order", fields: ["product"] },
        { id: "order-list", type: "list_view", table: "order", columns: ["product"] },
      ],
      // **面(`app.roles[].rules`)。** **既定3本(`owner` / `editor` / `viewer`)は消せない。**
      //
      // **表(`product` / `order`)の規則は1本も書いていない** —— **書くと `D-V8-35` により
      // 個人スコープ(`st_owner`)の読取の重ね順まで変わってしまい、本ファイルが測りたい
      // 3粒度と混ざる。**
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            { target: "view", view: "admin-product-list", can: ["read"] },
            // **`write` も書いてある** —— **対象を名指しした時点で全動詞が allow-list に
            // なるため、書かないと `owner` が `cost` を入力できなくなる**(裁定 `R-4`)。
            { target: "field", table: "product", field: "cost", can: ["read", "write"] },
            ...ownerActionRules,
          ],
        },
        {
          id: "editor",
          name: "編集者",
          rules: [
            { target: "view", view: "admin-product-list", can: ["read"] },
            { target: "field", table: "product", field: "cost", can: ["read"] },
          ],
        },
        { id: "viewer", name: "閲覧者" },
        // **【`V8-M26`】`customer` の宣言を足した。**
        //
        // **直上の「表(`product` / `order`)の規則は1本も書いていない」は、今日は成立しない** ——
        // **`V8-M26` が表の既定を閉じたので、表の規則を1本も書かないと `owner` の
        // `POST /product` すら 403 になり、(A) (B) (C) の3群が1つも走らない。**
        // **既定3役割の分は `withDefaultRoleRules(..., { skipAllViews: true })` が足す。**
        // **`customer` はその外なので、ここに手で書く。**
        //
        // **配る動詞は最小である** —— **(A-2) / (B-1) が `product` の読取を、
        // (C-1) / (C-3) / (C-4a) が `order` の作成を要る。それ以外は書いていない。**
        // **画面(`view`)とボタン(`action`)の規則は `customer` に1本も書いていない** ——
        // **(A-1) の 403 と (C-1) の 403 はそこで立っているからである。**
        {
          id: "customer",
          name: "お客様",
          rules: [
            { target: "table", table: "product", can: ["read"] },
            { target: "table", table: "order", can: ["read", "write"] },
          ],
        },
      ],
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

async function boot(declareActionRule: boolean): Promise<void> {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-action-audience-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "見せ分けの店", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **【`V8-M26`】表(`product` / `order`)にだけ既定3役割の規則を足す**(`skipAllViews: true`)。
  // **画面の規則は題材が自分で書いており、既定を足すと (A-1) の 403 が測れなくなる。**
  expect(
    applyManifest(
      dataRoot,
      APP_ID,
      withDefaultRoleRules(manifest(declareActionRule), { skipAllViews: true }),
    ).valid,
  ).toBe(true);
  app = createServerApp({ dataRoot });
}

beforeEach(async () => {
  await boot(false);
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

function session(role: "owner" | "editor" | "viewer" | "customer") {
  return seedSession(dataRoot, APP_ID, { role, username: `${role}-${Math.random()}` });
}

const PRODUCTS = `/api/apps/${APP_ID}/tables/product/records`;
const ORDERS = `/api/apps/${APP_ID}/tables/order/records`;

async function seedProduct(): Promise<string> {
  const o = session("owner");
  const res = await req(o.cookie, "POST", PRODUCTS, {
    name: "梅干し",
    cost: 300,
    st_public: true,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { record: { _id: string } }).record._id;
}

// ---------------------------------------------------------------------------
// (A) 画面単位 —— **サーバは読む**
//
// **【`V8-M20` / `J-G27`】旧: `view.audience`。今日: 面の画面の規則。**
// **サーバが読むこと・403 になることは1バイトも変わっていない。**
// ---------------------------------------------------------------------------

// **旧テスト名: `(A-1) 画面単位の宣言をサーバが読む: 列挙に無い相手がその画面を名乗ると 403`。**
test("(A-1) 画面単位の面の規則をサーバが読む: 規則で読めない相手がその画面を名乗ると 403", async () => {
  const c = session("customer");
  const res = await req(c.cookie, "GET", `${PRODUCTS}?view=admin-product-list`);
  expect(res.status).toBe(403);
});

test("(A-2) 画面を名乗らなければ今日どおり通る(遮断しているのは要求であってテーブルではない)", async () => {
  await seedProduct();
  const c = session("customer");
  const res = await req(c.cookie, "GET", PRODUCTS);
  expect(res.status).toBe(200);
});

test("(A-3) ただしマニフェストからは1画面も落ちない(ADR-0070 限定7。規則で閉じた画面の定義もそのまま返る)", async () => {
  const c = session("customer");
  const res = await req(c.cookie, "GET", `/api/apps/${APP_ID}/manifest`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { app: { views: { id: string }[] } };
  expect(body.app.views.map((view) => view.id).sort()).toEqual([
    "admin-product-list",
    "catalog-list",
    "order-form",
    "order-list",
  ]);
});

// ---------------------------------------------------------------------------
// (B) 項目単位 —— **サーバは読む(値を落とす)**
//
// **【`V8-M20` / `J-G28`】旧: `field.audience`(`projectForFieldAudience`)。**
// **今日: 面の項目の規則(`projectForRoleFields`)。** **落ちることは変わっていない。**
// ---------------------------------------------------------------------------

// **旧テスト名: `(B-1) 項目単位の宣言をサーバが読む: 列挙に無い相手の応答からその項目が落ちる`。**
test("(B-1) 項目単位の面の規則をサーバが読む: 規則で読めない相手の応答からその項目が落ちる", async () => {
  await seedProduct();
  const c = session("customer");
  const res = await req(c.cookie, "GET", PRODUCTS);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { records: Record<string, unknown>[] };
  expect(body.records).toHaveLength(1);
  expect(Object.keys(body.records[0] as Record<string, unknown>)).not.toContain("cost");
  expect(Object.keys(body.records[0] as Record<string, unknown>)).toContain("name");
});

test("(B-2) 規則で読める相手には落ちない", async () => {
  await seedProduct();
  const e = session("editor");
  const res = await req(e.cookie, "GET", PRODUCTS);
  const body = (await res.json()) as { records: Record<string, unknown>[] };
  expect(Object.keys(body.records[0] as Record<string, unknown>)).toContain("cost");
});

// ---------------------------------------------------------------------------
// (C) 操作起点単位 —— **サーバは1バイトも読まない**
// ---------------------------------------------------------------------------

/**
 * **これが本タスクの核心である。**
 *
 * **同じ要求を、宣言の**有る**マニフェストと**無い**マニフェストの両方に投げ、
 * **応答が1バイトも違わないことを測る。**
 */
test("(C-1) 操作起点の面の規則をサーバが読む: 隠した相手が同じ書込をすると 403 で断られる", async () => {
  // **規則**無し**の状態で1回。**
  const productId = await seedProduct();
  const c1 = session("customer");
  const before = await req(c1.cookie, "POST", ORDERS, { product: productId });
  // **【`V8-M26` / ユーザ決定 `D-V8-45`。期待値を反転させた。旧文を1バイトも消していない】**
  // **旧(逐語)**: `expect(before.status).toBe(201);`
  // **今日は `403` である。** **理由は `isRoleActionWriteAllowed` の中の
  // `if (!decision.governed) continue;` にある** —— **既定が閉じたことで、
  // 識別子(`id`)を持つボタンは規則を1本も書かなくても `governed: true` を返すように
  // なった。** **つまり `id` つきのボタンは常に壁を立てる。**
  // **【これは今日できなくなったことである】** **「ボタンに規則を書かなければ、その
  // ボタンが指す form 画面の表へ誰でも `POST` できる」は成り立たなくなった。**
  expect(before.status).toBe(403);

  // **同じ題材を、規則**有り**で作り直して1回。**
  await rm(dataRoot, { recursive: true, force: true });
  await boot(true);
  const productId2 = await seedProduct();
  const c2 = session("customer");
  const after = await req(c2.cookie, "POST", ORDERS, { product: productId2 });

  // **【実測。`V5-M28-T02` で書き換え、`V8-M20` で置き直した】応答の状態コードが**違う**。**
  // **旧: `audience: ["owner"]` と書いた操作起点が壁を立てていた。**
  // **新: `owner` だけがそのボタンを `read` できる規則が壁を立てる。**
  // **どちらも書き先は `order-form`(表 = `order`)なので、`order` の**作成**の壁が
  // `{owner}` になり、customer の `POST` が 403 で止まる**
  // (`ADR-0249` §Decision 1 の形を、面の側で `isRoleActionWriteAllowed` が保っている)。
  //
  // **【誇張しない】止まったのはこの1本の経路だけである。**
  // **受信口 / MCP / ワークフロー / コードの島 / `DELETE` は今日も同じ表に届く**
  // (`ADR-0249` 限定13)。**「この表は守られている」とは書かない。**
  expect(after.status).toBe(403);
  // **【`V8-M26`。期待値を反転させた。旧文を1バイトも消していない】**
  // **旧(逐語)**: `expect(after.status).not.toBe(before.status);`
  // **今日は `customer` から見て、規則の有無で応答が1バイトも変わらない** ——
  // **どちらも `403` である。** **上の doc の「応答の状態コードが**違う**」は今日は偽。**
  expect(after.status).toBe(before.status);
  // **【差が消えたことを「壁が無くなった」と読まないために、差が残っている側を1件測る】**
  // **規則を書いた `owner` は、規則**有り**でだけ通る**(下の (C-4a) が同じ対照を本体にしている)。
  const o = session("owner");
  expect((await req(o.cookie, "POST", ORDERS, { product: productId2 })).status).toBe(201);
});

// **【`V8-M20` / `J-G29`】置き直した検査。**
// **旧テスト名: `(C-2) 操作起点の宣言はマニフェストの応答にそのまま出る(サーバは落とさない)`。**
// **旧の見る場所: `app.views[].actions[].audience`。新の見る場所: `app.roles[].rules`。**
// **問い(「誰に見せないか」は未ログインでも読める)は1ミリも変えていない。**
test("(C-2) 面の規則はマニフェストの応答にそのまま出る(サーバは落とさない)", async () => {
  await rm(dataRoot, { recursive: true, force: true });
  await boot(true);
  const c = session("customer");
  const res = await req(c.cookie, "GET", `/api/apps/${APP_ID}/manifest`);
  const body = (await res.json()) as {
    app: { roles?: { id: string; rules?: Record<string, unknown>[] }[] };
  };
  const owner = body.app.roles?.find((role) => role.id === "owner");
  // **規則はそのまま配られる。** **「誰に見せないか」は他人の画面からも読める。**
  expect(owner?.rules).toContainEqual({
    target: "action",
    view: "catalog-list",
    action: ORDER_ACTION_ID,
    can: ["read"],
  });
});

test("(C-3) 壁は名乗りに依存しない: その操作起点が指す form 画面を名乗っても、名乗らなくても同じに 403", async () => {
  await rm(dataRoot, { recursive: true, force: true });
  await boot(true);
  const productId = await seedProduct();
  const c = session("customer");
  // **`order-form` を名指しした面の規則は1本も無い** —— **操作起点の規則は
  // 行き先の画面の規則ではない。** **したがって `rejectNamedView`(画面単位の 403)は
  // 1度も発火していない**(規則の無い画面は管轄外 = 全許可)。
  // **止めているのは操作起点から導いた壁のほうである。**
  const named = await req(c.cookie, "POST", `${ORDERS}?view=order-form`, { product: productId });
  expect(named.status).toBe(403);
  // **名乗らない要求も同じである**(`ADR-0249` 限定7。**壁は `?view=` を1ミリも見ない**)。
  const bare = await req(c.cookie, "POST", ORDERS, { product: productId });
  expect(bare.status).toBe(403);
  expect(bare.status).toBe(named.status);
});

/**
 * **旧 `(C-4)` を `V5-M28-T02` が2本に割った**(`v5-m28.md` §6-1 (D))。**旧文の逐語**:
 *
 * ```
 * test("(C-4) サーバ側に操作起点の audience を読む述語が1本も存在しない", async () => {
 *   const source = await Bun.file(join(import.meta.dir, "owner-scope.ts")).text();
 *   expect(source).not.toContain("actionAudience");
 *   expect(source).not.toContain("view_action");
 *   const appSource = await Bun.file(join(import.meta.dir, "app.ts")).text();
 *   expect(appSource).not.toContain("actionAudience");
 * });
 * ```
 *
 * **【割った理由。これは実測である】** **`V5-M28-T01` が `owner-scope.ts` に壁を導く述語を
 * 実際に置いた後も、上の旧 `(C-4)` は**緑のままだった**** —— **述語の doc が
 * `actionAudience` とも `view_action` とも1度も書かなかったからである**(`grep -c` = **0**)。
 * **名前ベースの検査は、名前を避けた実装を1件も捕まえない。**
 * **【禁止】これを「名前で守られていた」と書かない** —— **守られていなかった。**
 */
test("(C-4a) 挙動: 規則の有無だけを差し替えると、同じ POST の応答が違う(関数名を1文字も見ない)", async () => {
  // **本ファイルを1バイトも読まない。** **`Bun.file` も `import.meta.dir` も使わない。**
  // **測るのは応答だけである。**
  // **【`V8-M26`。題材の側を変えた。旧文を1バイトも消していない】**
  // **旧(逐語)**: `await req(session("customer").cookie, "POST", ORDERS, {...})` を2回。
  // **今日、`customer` では差が出ない** —— **識別子つきのボタンは規則を1本も書かなくても
  // 壁を立てるので、規則の有無にかかわらず `403` である**(上の (C-1) の実測)。
  // **差が残っているのは、規則を**書いた側**の役割である** —— **`owner` に差し替えた。**
  // **測っている性質(「規則の有無だけを差し替えると応答が違う」「関数名を1文字も見ない」)は
  // 1ミリも変えていない。** **向きだけが「書かれた側が通る」に反転している。**
  const productId = await seedProduct();
  const withoutDeclaration = await req(session("owner").cookie, "POST", ORDERS, {
    product: productId,
  });

  await rm(dataRoot, { recursive: true, force: true });
  await boot(true);
  const productId2 = await seedProduct();
  const withDeclaration = await req(session("owner").cookie, "POST", ORDERS, {
    product: productId2,
  });

  // **「違う」ことだけを測る** —— **どちらの値も書かない。**
  // **実装が関数名を変えても、この検査は1ミリも動かない。**
  expect(withDeclaration.status).not.toBe(withoutDeclaration.status);
});

/**
 * **判定の家が1つであることを、名前の出現場所で固定する**(`ADR-0249` 限定6。
 * `ADR-0077` 限定6 が `st_no_direct_create` について置いた
 * `owner-scope.test.ts (V3-M8-T01 j)` と同型の走査である)。
 *
 * **【発注書の字句と食い違う点を隠さない】** **`v5-m28.md` §6-1 (D) と `ADR-0249` 限定6 は
 * 「判定関数の名前が `owner-scope.ts` 以外の非テスト製品コードに**現れない**」と書いている。**
 * **そのままの形は成立しない** —— **同じ発注書の `T02` が「`app.ts` は
 * `isViewActionWriteAllowed` を**呼ぶだけ**」と定めており、呼べば `app.ts` に名前が現れる。**
 * **`ADR-0077` の先例で「現れない」が成立しているのは、走査の対象が**宣言フィールドの id**
 * (`st_no_direct_create`)であって関数名ではないからである**(`isDirectCreateSuppressed` は
 * 今日も `app.ts` に2回現れる)。
 *
 * **したがってここは「現れない」ではなく「**この2ファイルにしか現れない**」を固定する。**
 * **§6-1 (D) が (C-4b) に求めた2つの性質は、この形でも両方満たす**:
 *   - **肯定の検査である**(`toEqual` で集合そのものを突き合わせる)。
 *   - **関数名を変えると赤くなる**(改名すると集合が空になり `toEqual` が落ちる)。
 * **加えて、3本目のファイルが判定を呼び始めても赤くなる**(= 家が2つになったら止まる)。
 *
 * ## **【`V8-M20` の実測。上の「2ファイル」は今日は偽である。旧文を1バイトも消していない】**
 *
 * **述語の名前が `isViewActionWriteAllowed` から `isRoleActionWriteAllowed` へ移った結果、
 * 同じ走査の結果は4ファイルになった**(2026-08-10 実測):
 *
 * | ファイル | 何が在るか |
 * |---|---|
 * | `src/server/owner-scope.ts` | **述語の本体**(判定の家) |
 * | `src/server/app.ts` | **呼び出し**(import 1行 + 3箇所) |
 * | `src/mcp/vocabulary.ts` | **散文だけ**(コメントで doc を引用している。呼び出しは0件) |
 * | `web/src/auth/authz.tsx` | **散文だけ**(コメント1行。呼び出しは0件) |
 *
 * **したがって本検査はもう「家が1つ」を示していない** —— **示しているのは
 * 「この4ファイル以外にこの綴りが現れない」だけである。**
 * **【禁止】この検査の緑を「判定が1箇所に閉じている証拠」と読まない** ——
 * **名前の出現場所しか測れないことは、上の旧文が既に自認している。**
 * **後ろの2ファイルは製品コードであり、本タスクでは1バイトも触っていない。**
 */
test("(C-4b) 壁の判定関数の名前は4ファイルにしか現れない(うち2つは散文だけ。家が1つとは言えない)", async () => {
  const NAME = "isRoleActionWriteAllowed";
  const roots = ["src", "web/src"];
  const hits: string[] = [];
  for (const root of roots) {
    // **走査は絶対パスで行い、集める側は公開単位の根からの相対に戻す** ——
    // 期待値(`join("src", "server", "app.ts")` など)は相対のままである。
    const entries = await readdir(join(PRODUCT_ROOT, root), {
      recursive: true,
      withFileTypes: true,
    });
    for (const entry of entries) {
      // **テストと文書は対象外**(判定をしていないため。`(V3-M8-T01 j)` と同じ線)。
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
        continue;
      }
      const path = join(entry.parentPath, entry.name);
      if ((await readFile(path, "utf-8")).includes(NAME)) {
        hits.push(relative(PRODUCT_ROOT, path));
      }
    }
  }
  // **【`V8-M20` の実測で書き換えた】**
  // **旧値: `[join("src","server","app.ts"), join("src","server","owner-scope.ts")]`
  // (述語名が `isViewActionWriteAllowed` だった当時の2ファイル)。**
  // **新値: 4ファイル。** **後ろの2つはコメントで名前に言及しているだけで、
  // 呼び出しは1件も無い**(製品コード。本タスクでは1バイトも触っていない)。
  expect(hits.sort()).toEqual([
    join("src", "mcp", "vocabulary.ts"),
    join("src", "server", "app.ts"),
    join("src", "server", "owner-scope.ts"),
    join("web", "src", "auth", "authz.tsx"),
  ]);
});
