/**
 * **名乗られた画面(`?view=<view_id>`)を、サーバのレコード経路が実際に遮断すること**の検査。
 *
 * ## 【`V8-M20` / 台帳 `J-G27`(判定 = 廃止)/ `ADR-0301` / ユーザ決定 `D-V8-35`】
 *
 * **本ファイルが元々測っていた `view.audience`(`B-G1` / `ADR-0070` 限定3)は撤去された。**
 * **代わりに立つのは 役割 x 対象(画面)x 読取** ——
 * `app.roles[].rules` の `{ "target": "view", "view": "<画面ID>", "can": ["read"] }` である。
 *
 * **遮断の場所・形・応答コードは1ミリも動いていない** —— `src/server/app.ts` の
 * `rejectNamedView` が、実在(400)/ URL の表との一致(400)を見たあと、
 * `judgeRoleAccess({target:{target:"view",…}, verb:"read"})` で 403 を返す。
 * **したがって本ファイルの題材(客用と運営用の画面が同じ表に載っている店)はそのまま使える。**
 * **`views[].audience` を `app.roles[].rules` に書き換えただけである。**
 *
 * ## 【この検査が遮断しないもの。誇張しない】
 *
 * - **`?view=` を渡さない要求は今日どおり通る。** **下の (Z) が実測で固定する。**
 *   **したがってこれは「画面を名乗った要求を拒否する」遮断であって、「表を閉じる」遮断ではない。**
 * - **規則を1本も書いていない画面は誰にでも開く**(裁定 `R-4` の管轄外)。
 *   **旧層が持っていた「未ログインには宣言した画面だけ」という閉じる向きの既定は、面に無い**
 *   (下の (C) が実測で固定する)。
 * - **`GET /api/apps/:app_id/manifest` は未ログインで全ビュー定義を返し続ける。**
 *   **さらに `app.roles` の規則もそのまま返る** —— **「誰にどの画面が開いているか」まで
 *   未ログインで読める。** **下の (Y) がその事実を実測で固定する。**
 * - **MCP 経路は1ミリも守られない**(`ADR-0003` §7 との緊張は今日も残っている)。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { OWNER_FIELD, PUBLIC_FIELD } from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "audience-shop";

/**
 * **`B-G1` の症状をそのまま写した題材である**(`docs/plan/v4/01-boundary-baseline.md:129`)。
 *
 * `product` は `st_public` を持つ = **買い物客が読めなければ店が成立しないテーブル**であり、
 * その上に**客用の一覧(`catalog-list`)と運営用の一覧・フォーム(`admin-product-list` /
 * `admin-product-form`)が同時に載っている。** **テーブル単位の印では割れない**
 * (`ADR-0070` §4 `:94`)。**`V8-M20` で見せ分けの置き場は面に移ったが、題材は変えていない。**
 *
 * **【`V8-M20`】画面の側の `audience` を全部消し、`app.roles[].rules` に置き直した。**
 * **`viewer` にはどの画面の規則も書かない** —— **1本でも書かれた画面は allow-list なので、
 * 書かないことで締まる。**
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
            { id: "sku", name: "SKU", type: "text" },
            { id: "stock", name: "在庫数", type: "number" },
            { id: PUBLIC_FIELD, name: "公開", type: "boolean" },
          ],
        },
        {
          id: "order",
          name: "注文",
          fields: [
            { id: "total", name: "合計", type: "number" },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
          ],
        },
      ],
      views: [
        // 規則を1本も書かない画面(管轄外: 今日どおり動く)。
        { id: "catalog-list", type: "list_view", table: "product", columns: ["name"] },
        // 運営だけに開く画面(一覧 / 詳細 / フォームの3種)。
        {
          id: "admin-product-list",
          type: "list_view",
          table: "product",
          columns: ["name", "sku", "stock"],
        },
        {
          id: "admin-product-detail",
          type: "detail_view",
          table: "product",
          fields: ["name", "sku", "stock"],
        },
        {
          id: "admin-product-form",
          type: "form",
          table: "product",
          fields: ["name", "sku", "stock"],
        },
        // **未ログインに開く画面**(旧 `audience: ["anonymous"]` = `ADR-0074` の置き直し先)。
        { id: "public-catalog", type: "list_view", table: "product", columns: ["name"] },
        // 自分の注文(customer に開く)。
        { id: "my-order-list", type: "list_view", table: "order", columns: ["total"] },
        // **運営だけの注文フォーム。** `order` は `st_owner` を持つので **customer は今日
        // POST できる**(`nonAdminTableAccess` = scoped)—— **書込の遮断が「今日どおり」に
        // 紛れないための題材である。**
        { id: "admin-order-form", type: "form", table: "order", fields: ["total"] },
      ],
      // **【`V8-M20` / `J-G27`】旧 `views[].audience` の置き直し先。**
      // **旧: `admin-product-list` に `audience: ["owner","editor"]` /
      //   `admin-product-detail` と `admin-product-form` と `admin-order-form` に
      //   `audience: ["owner"]` / `my-order-list` に `audience: ["customer","owner"]`。**
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            { target: "view", view: "admin-product-list", can: ["read"] },
            { target: "view", view: "admin-product-detail", can: ["read"] },
            { target: "view", view: "admin-product-form", can: ["read"] },
            { target: "view", view: "admin-order-form", can: ["read"] },
            { target: "view", view: "my-order-list", can: ["read"] },
          ],
        },
        {
          id: "editor",
          name: "編集者",
          rules: [{ target: "view", view: "admin-product-list", can: ["read"] }],
        },
        // **`viewer` には1本も書かない**(旧 `audience` の列挙に載っていなかったのと同じ)。
        { id: "viewer", name: "閲覧者" },
        {
          id: "customer",
          name: "お客様",
          rules: [
            { target: "view", view: "my-order-list", can: ["read"] },
            // **【`V8-M26`】表の規則を2本足した。** **`withDefaultRoleRules` は既定3役割にしか
            // 足さないので、`customer` の分はここに手で書く。**
            // **足さないと (B) の【対照】(`?view=` 無しの `POST` が今日どおり通る)が
            // `201` → `403` になり、対照そのものが成立しない。**
            { target: "table", table: "order", can: ["read", "write"] },
            { target: "table", table: "product", can: ["read"] },
          ],
        },
        {
          id: "anonymous",
          name: "未ログイン",
          rules: [
            { target: "view", view: "public-catalog", can: ["read"] },
            // **【`V8-M26` / `T-G26a`】未ログインにも既定が閉じる向きが及ぶので、
            // 匿名公開 GET(`st_public`)を成立させるには表の読取を1本書く必要がある。**
            // **書かないと (Z) の2本目が `200` かつ `records` 0件になる。**
            { target: "table", table: "product", can: ["read"] },
          ],
        },
      ],
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-view-audience-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "見せ分けの店", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **【`V8-M26`】表(`product` / `order`)にだけ既定3役割の規則を足す。**
  // **`skipAllViews: true`** —— **画面の規則は題材が自分で書いており、そこへ既定の規則を
  // 足すと (A) の「viewer / customer は運営専用の画面を名乗れない」が測れなくなる。**
  expect(
    applyManifest(dataRoot, APP_ID, withDefaultRoleRules(manifest(), { skipAllViews: true })).valid,
  ).toBe(true);
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

const LIST = (view?: string) =>
  `/api/apps/${APP_ID}/tables/product/records${view === undefined ? "" : `?view=${view}`}`;
const ONE = (recordId: string, view?: string) =>
  `/api/apps/${APP_ID}/tables/product/records/${recordId}${view === undefined ? "" : `?view=${view}`}`;

function session(role: "owner" | "editor" | "viewer" | "customer") {
  return seedSession(dataRoot, APP_ID, { role, username: `${role}-${Math.random()}` });
}

async function seedProduct(): Promise<string> {
  const o = session("owner");
  const res = await req(o.cookie, "POST", LIST(), {
    name: "梅干し",
    sku: "UME-1",
    stock: 12,
    [PUBLIC_FIELD]: true,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { record: { _id: string } }).record._id;
}

// --- (A) 目的そのもの: 客が運営用の画面を名乗ると拒否される -----------------------------

test("(A) customer が運営だけの画面を名乗って一覧を取ると 403(URL 直打ち)", async () => {
  const c = session("customer");
  const res = await req(c.cookie, "GET", LIST("admin-product-list"));
  expect(res.status).toBe(403);
});

test("(A) customer が運営だけの画面を名乗って単件を取ると 403(一覧と単件の両方)", async () => {
  const id = await seedProduct();
  const c = session("customer");
  const res = await req(c.cookie, "GET", ONE(id, "admin-product-detail"));
  expect(res.status).toBe(403);
});

test("(A) 拒否は認証境界の 401 ではなく、役割の規則による 403 である(理由が読める)", async () => {
  // **【`V8-M20` / `J-G27`】テスト名の「画面の宣言による 403」を「役割の規則による 403」に
  // 変えた**(旧テスト名の逐語: 「(A) 拒否は認証境界の 401 ではなく、画面の宣言による 403 で
  // ある(理由が読める)」)。**測っていることは同じである。**
  const c = session("customer");
  const res = await req(c.cookie, "GET", LIST("admin-product-list"));
  expect(res.status).toBe(403);
  const body = (await res.json()) as {
    errors?: { message?: string; hint?: string; allowed_values?: string[] }[];
  };
  expect(body.errors?.[0]?.message).toContain("admin-product-list");
  expect(body.errors?.[0]?.hint).toBeDefined();
  // **【`V8-M20`。応答から減ったものを隠さない】** **旧 `forbiddenViewAudienceError` は
  // `allowed_values` に「見せる相手」の列挙を載せていた。** **`forbiddenRoleAccessError` は
  // 載せない** —— **面は「誰に許されているか」を答えず、「あなたの役割には書かれていない」
  // としか言わない。** **直し方(`set_roles` で規則を足す)は `hint` に書かれている。**
  expect(body.errors?.[0]?.allowed_values).toBeUndefined();
});

test("(A) 画面の規則を持つ役割は通る(owner / editor)", async () => {
  // **【`V8-M20` / `J-G27`】旧テスト名の逐語: 「(A) 列挙に載っているロールは通る(owner / editor)」。**
  for (const role of ["owner", "editor"] as const) {
    const s = session(role);
    const res = await req(s.cookie, "GET", LIST("admin-product-list"));
    expect(res.status, role).toBe(200);
  }
});

test("(A) 規則を持たない viewer も拒否される(customer 専用の遮断ではない)", async () => {
  // **【`V8-M20` / `J-G27`】旧テスト名の逐語: 「(A) 列挙に載っていない viewer も拒否される
  // (customer 専用の遮断ではない)」。**
  // **`ADR-0053:40` 逐語「**画面が減るのは customer のときだけである。** owner / editor /
  // viewer では**1画面も減らない**」は、規則を書いた画面については今日も偽である。**
  const v = session("viewer");
  const res = await req(v.cookie, "GET", LIST("admin-product-list"));
  expect(res.status).toBe(403);
});

test("(A) customer に開いた画面は customer が通る", async () => {
  // **【`V8-M20` / `J-G27`】旧テスト名の逐語: 「(A) customer に見せると宣言した画面は
  // customer が通る」。**
  const c = session("customer");
  const res = await req(
    c.cookie,
    "GET",
    `/api/apps/${APP_ID}/tables/order/records?view=my-order-list`,
  );
  expect(res.status).toBe(200);
});

// --- (B) 書込も同じ判定を受ける ---------------------------------------------------------

const ORDERS = (view?: string) =>
  `/api/apps/${APP_ID}/tables/order/records${view === undefined ? "" : `?view=${view}`}`;

test("(B) 運営だけのフォームを名乗った POST は拒否される(判定は4メソッドすべてに掛かる)", async () => {
  const c = session("customer");
  const res = await req(c.cookie, "POST", ORDERS("admin-order-form"), { total: 1 });
  expect(res.status).toBe(403);
});

test("(B)【対照】同じ POST を ?view= 無しで送ると今日どおり成功する", async () => {
  // **上の 403 が「今日どおりの customer 遮断」に紛れていないことを、この対照が示す。**
  // `order` は `st_owner` を持つので customer は自分の行を作れる。
  const c = session("customer");
  const res = await req(c.cookie, "POST", ORDERS(), { total: 1 });
  expect(res.status).toBe(201);
});

// --- (C) 未ログイン(匿名公開 GET の窓)--------------------------------------------------

test("(C) 未認証が運営だけの画面を名乗ると 403(anonymous に規則が書かれていない)", async () => {
  // **【`V8-M20` / `J-G27`】旧テスト名の逐語: 「(C) 未認証が運営だけの画面を名乗ると 403
  // (値域に anonymous が無いので通らない)」。**
  // **理由が変わった** —— **旧は「`audience` の値域に `anonymous` が無いから」だった。**
  // **今日は「その画面に規則が1本でも在り(= allow-list)、`anonymous` にその規則が
  // 書かれていないから」である。** **未ログインは `anonymous` 1語の主体として判定される。**
  const res = await req(undefined, "GET", LIST("admin-product-list"));
  expect(res.status).toBe(403);
});

test("(C) 未認証でも規則の無い画面(catalog-list)は今日どおり公開窓を通る", async () => {
  await seedProduct();
  const res = await req(undefined, "GET", LIST("catalog-list"));
  // **【`V8-M26` / ユーザ決定 `D-V8-45` / `T-G26a`。期待値を反転させた。旧文を1バイトも
  // 消していない】**
  // **旧(逐語)**: `expect(res.status).toBe(200);`
  // **今日は `403` である** —— **規則を1本も書いていない画面が閉じたので、
  // `catalog-list` を名乗った要求は未ログインでも通らない。**
  // **本ファイル冒頭の「規則を1本も書いていない画面は誰にでも開く(裁定 `R-4` の管轄外)」
  // という1行は、今日は偽である**(旧文は消していない)。
  // **【誇張しない】表そのものは今日も閉じていない** —— **`?view=` を外した匿名公開 GET は
  // 下の (Z) の2本目で今日も `200` であり、そこは `anonymous` に表の読取を1本書いて
  // 成立させている。**
  expect(res.status).toBe(403);
});

test("(C) anonymous に規則を書いた画面は、未ログインが名乗って通る(V8-M20 / J-G27)", async () => {
  // **【`V8-M20` / `J-G27`。置き直しの実証】** **旧 `audience: ["anonymous"]`(`ADR-0074`)は
  // 面の側でそのまま置き直せた** —— **`{"id":"anonymous", rules:[{target:"view",
  // view:"public-catalog", can:["read"]}]}`。**
  // **`rejectNamedView` は 401 の**手前**で呼ばれ、未ログインには `roles: null` が渡り、
  // `judgeRoleAccess` の中で `anonymous` に写される。** **したがって未ログインの経路にも
  // 面の判定は掛かっている**(掛かっていなければ、この画面と `admin-product-list` の
  // 応答が同じになるはずである —— 上の (C) の1本目が 403 で、ここが 200 である)。
  await seedProduct();
  const res = await req(undefined, "GET", LIST("public-catalog"));
  expect(res.status).toBe(200);
});

test("(C) anonymous だけに開いた画面は、ログイン済みの customer には開かない", async () => {
  // **`anonymous` は5番目のロールではなく「役割を持たない者」の1語である。**
  // **ログイン済みの誰かが `anonymous` の規則で通ることはない。**
  const c = session("customer");
  const res = await req(c.cookie, "GET", LIST("public-catalog"));
  expect(res.status).toBe(403);
});

// --- (D) 画面IDの詐称を通さない ----------------------------------------------------------

test("(D) 実在しない画面IDを名乗ると 400(黙って素通りさせない)", async () => {
  const c = session("customer");
  const res = await req(c.cookie, "GET", LIST("no-such-view"));
  expect(res.status).toBe(400);
});

test("(D) 画面の対象テーブルと URL のテーブルが食い違うと 400(無害な画面を名乗って別表を読ませない)", async () => {
  // **この検査が無いと遮断そのものが無意味になる** —— `order` の画面を名乗って
  // `product` を読めるなら、`?view=` は名前を書くだけの飾りになる。
  const c = session("customer");
  const res = await req(c.cookie, "GET", LIST("my-order-list"));
  expect(res.status).toBe(400);
});

// --- (Z) 【遮断しないもの】`?view=` を渡さなければ今日どおり ------------------------------

test("(Z)【遮断しない】customer が ?view= を外すと、今日どおり公開テーブルの行が返る", async () => {
  // **これは遮断の穴ではなく、明示的に選ばれた既定である** ——
  // `product` は `st_public` を持つ(= 店が成立するために客が読める必要がある)。
  // **【禁止】「URL を直接叩いても拒否されるようになった」とだけ書かない**
  // (`v4-m3.md` §6 の2)。**拒否できるのは画面を名乗った要求だけである。**
  await seedProduct();
  const c = session("customer");
  const res = await req(c.cookie, "GET", LIST());
  expect(res.status).toBe(200);
  const body = (await res.json()) as { records: Record<string, unknown>[] };
  expect(body.records).toHaveLength(1);
  // **在庫も SKU も今日どおり返る** —— **項目を落とすのは 役割 x 対象(項目)x 読取 の
  // 規則であり、この題材は項目の規則を1本も書いていない。**
  expect(body.records[0]?.stock).toBe(12);
  expect(body.records[0]?.sku).toBe("UME-1");
});

test("(Z)【遮断しない】未認証が ?view= を外すと、今日どおり匿名公開 GET が通り stock / sku が返る", async () => {
  await seedProduct();
  const res = await req(undefined, "GET", LIST());
  expect(res.status).toBe(200);
  const body = (await res.json()) as { records: Record<string, unknown>[] };
  expect(body.records[0]?.stock).toBe(12);
  expect(body.records[0]?.sku).toBe("UME-1");
});

// --- (Y) 【守らない経路】マニフェストは未ログインで全ビュー定義と全規則を返す ---------------

// **【`V8-M21` / 台帳 `J-G24a` / `J-G24b` / ユーザ決定 `D-V8-21` / `D-V8-34` による更新。
//   旧文を1バイトも消していない】**
//
// **旧テスト名**: 「(Y)【守らない】GET /manifest は未ログインで全ビュー定義と app.roles の
// 規則を返す」。**旧の期待値**: `expect(res.status).toBe(200);` と、未ログインの応答本文に
// `admin-product-list` と `owner` の画面の規則が在ること。
// **旧のコメント逐語**: 「`audience` は消えたが、穴は消えていない —— 今日は `app.roles` が
// そのまま返るので、「どの役割にどの画面が開いているか」まで未ログインで読める。穴は
// 広がっている。」
//
// **`V8-M21` がその穴を塞いだ** —— **未ログインは 401 であり、`app.roles` は1バイトも
// 渡らない。** **代わりに `GET /public` が「アプリ名と、未ログインでも見せると決めた画面の
// 名前」だけを返す**(`D-V8-34`)。**運営専用の画面(`admin-product-list`)はそこに載らない。**
test("(Y)【塞いだ】GET /manifest は未ログインで 401。GET /public にも運営専用の画面は載らない", async () => {
  // **【`V8-M20` / `J-G27`】旧テスト名の逐語: 「(Y)【守らない】GET /manifest は未ログインで
  // audience つきの全ビュー定義を返す(限定7)」。**
  // **旧本体**: `body.app.views.find(v => v.id === "admin-product-list")?.audience` が
  //   `["owner","editor"]` であることを測っていた(**宣言そのものが未ログインで読める**)。
  // **`audience` は消えたが、穴は消えていない** —— **今日は `app.roles` がそのまま返るので、
  // 「どの役割にどの画面が開いているか」まで未ログインで読める。** **穴は広がっている。**
  // **(1) 未ログインの定義の取得は 401 である。**
  const res = await req(undefined, "GET", `/api/apps/${APP_ID}/manifest`);
  expect(res.status).toBe(401);
  // **(2) 未ログインに渡るのは `GET /public` の2つだけである** ——
  // **アプリ名と、未ログインでも見せると決めた画面の名前。**
  const open = await req(undefined, "GET", `/api/apps/${APP_ID}/public`);
  expect(open.status).toBe(200);
  const body = (await open.json()) as {
    app: { id: string; name: string };
    views: { id: string; name: string }[];
  };
  // **応答のキーは、テーマを宣言していないこのアプリでは2つちょうどである**
  // (`app` と `views`)—— **`roles` も `tables` も無い。**
  // **【`theme` は宣言したアプリでだけ3つ目のキーとして出る】**(メインの判断。
  // `D-V8-34` の逐語「ログイン画面も公開ページも今どおり出る」を根拠に足した)。
  // **本題材は `app.theme` を書いていないので、キーごと出ない。**
  //
  // **【2026-08-14。`V8-M5-T03`。ユーザ決定 `D-V8-114` / `D-V8-115`。`ADR-0338` §3-1】**
  // **旧の期待値の逐語(1バイトも消していない)**:
  // ```
  //   expect(Object.keys(body).sort()).toEqual(["app", "views"]);
  // ```
  // **なぜ変わったか**: **`ADR-0319` 限定1(トップレベルのキーを4つ目にしない)を
  // `D-V8-115` が引き直す側に倒し、登録に要る事実(`signup`)が4つ目のキーとして足された。**
  // **【失った性質】** **「未ログインへ渡るキーは3つちょうど」は今日から偽である。**
  // **緩めてはいない**(`toEqual` の完全一致のまま。5つ目が出れば赤くなる)。
  // **この検査の本題(運営専用の画面が載らないこと)は1バイトも動いていない。**
  expect(Object.keys(body).sort()).toEqual(["app", "signup", "views"]);
  // **運営専用の画面は載らない。**
  expect(body.views.map((view) => view.id)).not.toContain("admin-product-list");
  // **【この検査が言わないこと】** **ログインすれば `app.roles` は今日も丸ごと読める** ——
  // **塞いだのは未ログインだけである。**
});
