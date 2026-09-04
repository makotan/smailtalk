/**
 * 公開行の未認証 read-only 閲覧 + 最低限レート制限(V2-M1-T04 + T05 / ADR-0034)。
 *
 * T04/T05 は「単独禁止」(ADR-0034 限定4)で1単位。匿名 GET 窓とレート制限を同時に検査する。
 *
 * 守るべき線(ADR-0034 §3):
 * - 限定2 read-only を構造で: 匿名 GET は通るが匿名 POST/PATCH/DELETE は 401(書込を公開に結線しない)。
 * - 限定3 最小性: 匿名 GET が返すのは st_public===true の行だけ。非公開行は 1件も出さない。
 *   予約規約フィールド(st_owner / st_public)は匿名射影で伏せる。
 * - 認証済み GET は不変(公開テーブルでも認証済みは従来どおり全行が見える)。
 * - 限定4 レート制限: 匿名 GET とサインアップ/ログインに固定窓レート制限を掛ける。
 *   認証済み records CRUD は非対象。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { OWNER_FIELD, PUBLIC_FIELD } from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "storefront";

/**
 * products = 公開テーブル(st_public boolean 非required)。
 * items    = 非公開テーブル(st_public 無し。匿名 GET は 401)。
 * carts    = 個人所有テーブル(st_owner text 非required。認証済みの回帰確認用)。
 */
function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "ストア",
      tables: [
        {
          id: "products",
          name: "商品",
          fields: [
            { id: "name", name: "商品名", type: "text", required: true },
            { id: "price", name: "価格", type: "number" },
            { id: PUBLIC_FIELD, name: "公開", type: "boolean" },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
          ],
        },
        {
          id: "items",
          name: "内部在庫",
          fields: [{ id: "sku", name: "SKU", type: "text", required: true }],
        },
      ],
      views: [],
      // **【`V8-M26` / `D-V8-45` / `T-G26a`】未ログインにも既定が閉じる向きが及ぶ。**
      //
      // **着手前の実測(この宣言を書かずに `withDefaultRoleRules` だけを足した状態)**:
      //  - 匿名 GET list … **`200` のまま。ただし `records` が `1` 件 → `0` 件になった**
      //    (`app.ts` の表の関門が「読めない表は応答から落とす」側に倒れているため)。
      //  - 匿名 GET single(公開行) … **`200` → `404`。**
      //
      // **つまり「公開行の未認証閲覧」(`ADR-0034`)は、今日は `st_public` だけでは成立せず、
      // `anonymous` に読取の規則を1本書いて初めて成立する。** **`withDefaultRoleRules` は
      // `anonymous` に1本も足さない**(既定3役割だけ)ので、ここに手で書く。
      roles: [
        {
          id: "anonymous",
          name: "未ログイン",
          rules: [{ target: "table", table: "products", can: ["read"] }],
        },
      ],
    },
  };
}

let dataRoot: string;

async function makeApp(clock?: { now: () => number }): Promise<ReturnType<typeof createServerApp>> {
  const opts = { dataRoot } as Parameters<typeof createServerApp>[0];
  if (clock !== undefined) {
    // 小さい窓 + 注入 now で窓リセットを制御する(実クロック非依存)。
    return createServerApp({
      ...opts,
      rateLimit: {
        publicGet: { limit: 2, windowMs: 1_000, now: clock.now },
        auth: { limit: 2, windowMs: 1_000, now: clock.now },
      },
    });
  }
  return createServerApp(opts);
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-public-read-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "ストア", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **【`V8-M26`】既定3役割の規則を題材へ足す**(`apply-diff.ts` の自動付与と同じ規則)。
  // **これを足さないと `products` / `items` が面の既定で閉じ、owner の `POST` すら 403 になる。**
  expect(applyManifest(dataRoot, APP_ID, withDefaultRoleRules(manifest())).valid).toBe(true);
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

const R = (table: string, id?: string) =>
  `/api/apps/${APP_ID}/tables/${table}/records${id === undefined ? "" : `/${id}`}`;

function anon(
  app: ReturnType<typeof createServerApp>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers = { ...headers, "content-type": "application/json", origin: TEST_ORIGIN };
    init.body = JSON.stringify(body);
  }
  return Promise.resolve(app.request(new Request(`http://localhost${path}`, init)));
}

/** owner cookie で products に1件作る(st_public を指定して公開/非公開を作り分ける)。 */
async function seedProduct(
  app: ReturnType<typeof createServerApp>,
  cookie: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await app.request(
    new Request(`http://localhost${R("products")}`, {
      method: "POST",
      headers: { cookie, origin: TEST_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { record: { _id: string } }).record._id;
}

// --- T04: 匿名公開読み取り -------------------------------------------------------

test("匿名 GET list: 公開テーブルの st_public===true の行だけ 200 で返る(非公開行は出ない)", async () => {
  const app = await makeApp();
  const { cookie } = seedSession(dataRoot, APP_ID); // owner
  const pubId = await seedProduct(app, cookie, {
    name: "公開商品",
    price: 100,
    [PUBLIC_FIELD]: true,
  });
  await seedProduct(app, cookie, { name: "非公開商品", price: 999, [PUBLIC_FIELD]: false });
  await seedProduct(app, cookie, { name: "既定非公開", price: 1 }); // st_public 欠落=非公開

  const res = await anon(app, "GET", R("products"));
  expect(res.status).toBe(200);
  const { records } = (await res.json()) as { records: Record<string, unknown>[] };
  // 公開行のみ 1件。
  expect(records).toHaveLength(1);
  expect(records[0]?._id).toBe(pubId);
  expect(records[0]?.name).toBe("公開商品");
  // 予約規約フィールドは匿名に漏れない(限定3)。
  expect(records[0]).not.toHaveProperty(OWNER_FIELD);
  expect(records[0]).not.toHaveProperty(PUBLIC_FIELD);
});

test("匿名 GET single: 公開行は 200(射影)、非公開行は 404(存在も値も出さない)", async () => {
  const app = await makeApp();
  const { cookie } = seedSession(dataRoot, APP_ID);
  const pubId = await seedProduct(app, cookie, { name: "公開", price: 10, [PUBLIC_FIELD]: true });
  const privId = await seedProduct(app, cookie, { name: "秘密", price: 20, [PUBLIC_FIELD]: false });

  const pub = await anon(app, "GET", R("products", pubId));
  expect(pub.status).toBe(200);
  const pubBody = (await pub.json()) as { record: Record<string, unknown> };
  expect(pubBody.record.name).toBe("公開");
  expect(pubBody.record).not.toHaveProperty(OWNER_FIELD);
  expect(pubBody.record).not.toHaveProperty(PUBLIC_FIELD);

  const priv = await anon(app, "GET", R("products", privId));
  expect(priv.status).toBe(404); // 非公開行は存在も値も伏せる
  const privBody = (await priv.json()) as { errors?: unknown[] };
  expect(Array.isArray(privBody.errors)).toBe(true);
});

test("匿名は非公開テーブル(st_public 無し)を GET できない(401)", async () => {
  const app = await makeApp();
  expect((await anon(app, "GET", R("items"))).status).toBe(401);
  expect((await anon(app, "GET", R("items", "x"))).status).toBe(401);
});

test("公開テーブルでも匿名の書込(POST/PATCH/DELETE)は 401(read-only を構造で守る)", async () => {
  const app = await makeApp();
  expect((await anon(app, "POST", R("products"), { name: "x", [PUBLIC_FIELD]: true })).status).toBe(
    401,
  );
  expect((await anon(app, "PATCH", R("products", "x"), { name: "y" })).status).toBe(401);
  expect((await anon(app, "DELETE", R("products", "x"))).status).toBe(401);
});

test("認証済み GET は不変: owner は公開テーブルの全行(非公開含む)を予約フィールド込みで見る", async () => {
  const app = await makeApp();
  const { cookie } = seedSession(dataRoot, APP_ID);
  await seedProduct(app, cookie, { name: "公開", price: 10, [PUBLIC_FIELD]: true });
  await seedProduct(app, cookie, { name: "非公開", price: 20, [PUBLIC_FIELD]: false });

  const res = await app.request(
    new Request(`http://localhost${R("products")}`, { headers: { cookie, origin: TEST_ORIGIN } }),
  );
  expect(res.status).toBe(200);
  const { records } = (await res.json()) as { records: Record<string, unknown>[] };
  // 認証済みは全行(非公開含む)。
  expect(records).toHaveLength(2);
  // 予約規約フィールドは認証済みには従来どおり載る(射影は匿名だけ)。
  expect(records.some((r) => Object.hasOwn(r, PUBLIC_FIELD))).toBe(true);
});

// --- T05: 最低限レート制限 -------------------------------------------------------

test("匿名 GET は上限超過で 429(統一 { errors } 形式)、窓リセットで再び通る", async () => {
  const clock = { value: 1_000, now: () => clock.value };
  const app = await makeApp(clock);
  const { cookie } = seedSession(dataRoot, APP_ID);
  await seedProduct(app, cookie, { name: "公開", price: 10, [PUBLIC_FIELD]: true });

  // limit=2: 2回は通り、3回目で 429。
  expect((await anon(app, "GET", R("products"))).status).toBe(200);
  expect((await anon(app, "GET", R("products"))).status).toBe(200);
  const limited = await anon(app, "GET", R("products"));
  expect(limited.status).toBe(429);
  const body = (await limited.json()) as { errors?: unknown[] };
  expect(Array.isArray(body.errors)).toBe(true);
  expect(limited.headers.get("retry-after")).not.toBeNull();

  // 窓を跨ぐと復活。
  clock.value += 1_000;
  expect((await anon(app, "GET", R("products"))).status).toBe(200);
});

test("サインアップ/ログイン経路は上限超過で 429(匿名経路と同様に固定窓)", async () => {
  const clock = { value: 0, now: () => clock.value };
  const app = await makeApp(clock);
  const login = () =>
    app.request(
      new Request(`http://localhost/api/apps/${APP_ID}/auth/password/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: TEST_ORIGIN },
        body: JSON.stringify({ username: "nobody", password: "nope" }),
      }),
    );
  // limit=2。
  expect((await login()).status).toBe(401); // 資格情報は不正だが認証境界は通る
  expect((await login()).status).toBe(401);
  const third = await login();
  expect(third.status).toBe(429);

  // 窓リセットで再び通る(401 に戻る)。
  clock.value += 1_000;
  expect((await login()).status).toBe(401);
});

test("顧客サインアップ経路(/auth/signup/*)もレート制限の対象", async () => {
  const clock = { value: 0, now: () => clock.value };
  const app = await makeApp(clock);
  const register = (i: number) =>
    app.request(
      new Request(`http://localhost/api/apps/${APP_ID}/auth/signup/password/register`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: TEST_ORIGIN },
        body: JSON.stringify({ username: `c-${i}-${Math.random()}`, password: "pw123456" }),
      }),
    );
  expect((await register(1)).status).toBe(200);
  expect((await register(2)).status).toBe(200);
  expect((await register(3)).status).toBe(429);
});

test("認証済み records CRUD はレート制限の非対象(限定4は匿名経路とサインアップに限る)", async () => {
  const clock = { value: 0, now: () => clock.value };
  const app = await makeApp(clock);
  const { cookie } = seedSession(dataRoot, APP_ID); // owner
  // publicGet.limit=2 だが、認証済み GET は匿名窓を通らないので何度でも 200。
  for (let i = 0; i < 5; i++) {
    const res = await app.request(
      new Request(`http://localhost${R("products")}`, { headers: { cookie, origin: TEST_ORIGIN } }),
    );
    expect(res.status, `auth GET #${i}`).toBe(200);
  }
  // 認証済み POST も非対象。
  for (let i = 0; i < 3; i++) {
    const res = await app.request(
      new Request(`http://localhost${R("products")}`, {
        method: "POST",
        headers: { cookie, origin: TEST_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ name: `p${i}` }),
      }),
    );
    expect(res.status, `auth POST #${i}`).toBe(201);
  }
});
