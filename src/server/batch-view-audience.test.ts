/**
 * **まとめて取得・書込する経路(`POST /api/apps/:app_id/batch`)も、名乗られた画面
 * (`?view=<view_id>`)の判定を受けること**の検査(`V4-FIX1` 項目(1))。
 *
 * ## 【`V8-M20` / 台帳 `J-G27`(判定 = 廃止)/ `ADR-0301` / ユーザ決定 `D-V8-35`】
 *
 * **本ファイルが元々測っていた `view.audience`(`B-G1` / `ADR-0070`)は撤去された。**
 * **代わりに立つのは 役割 x 対象(画面)x 読取**(`app.roles[].rules` の
 * `{ "target": "view", "view": "<画面ID>", "can": ["read"] }`)。
 * **`views[].audience` を `app.roles[].rules` に書き換えただけで、題材も遮断の場所も変えていない。**
 *
 * ## 何を直したのか(**直す前に実 HTTP で再現してから書かれている**)
 *
 * `docs/evidence/cp-v4.md` §6-3 の #10 が、**同一セッション・同一画面ID の対照**で次を実測した:
 *
 * > owner が `?view=cust-only-order-list`(当時は `audience: ["customer"]`)を名乗ったとき ——
 * > **`GET .../records` = 403 / `POST .../batch` = 200(行が作られた)**
 *
 * **判定は `recordsAuthMiddleware` にしか入っておらず、`batchAuthMiddleware`(`ADR-0039`)
 * には1行も入っていなかった。** **宣言した境界がバッチ経路で迂回できた。**
 * **今日は両方が `rejectNamedView` という同じ1本を呼ぶ**(判定の家を2つに割らない)。
 *
 * ## 【この検査が守らないもの。誇張しない】
 *
 * - **`?view=` を渡さないバッチは今日どおり通る。** **下の (Z)。**
 * - **画面の対象テーブルと、ops が書く先のテーブルの一致は検査していない。**
 *   単件経路は URL に表が1つ在るので `namedView.table !== tableId` を見られるが、
 *   **バッチは1リクエストで複数テーブルを跨ぐので、比べる相手が1つに決まらない。**
 *   **したがって「自分に開いている画面を名乗って別の表へ書く」ことは今日もできる**(下の (Y))。
 *   **バッチは元から editor/owner 限定(`ADR-0039`)なので、これで新しく開く表は1つも無い** ——
 *   **が、「表の一致を見ている」とは書けない。**
 * - **MCP 経路は1ミリも守られない。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { OWNER_FIELD } from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "batch-audience-shop";

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "まとめ書きの店",
      tables: [
        {
          id: "product",
          name: "商品",
          fields: [{ id: "name", name: "商品名", type: "text", required: true }],
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
        // 規則を1本も書かない画面(管轄外: 今日どおり)。
        { id: "order-list", type: "list_view", table: "order", columns: ["total"] },
        // **客だけに開く画面。** owner はこの画面を名乗れない。
        { id: "cust-only-order-list", type: "list_view", table: "order", columns: ["total"] },
        // **運営に開く画面。** owner / editor / viewer が名乗れる。
        { id: "admin-order-form", type: "form", table: "order", fields: ["total"] },
      ],
      // **【`V8-M20` / `J-G27`】旧 `views[].audience` の置き直し先。**
      // **旧: `cust-only-order-list` に `audience: ["customer"]` /
      //   `admin-order-form` に `audience: ["owner","editor"]`。**
      // **`viewer` にも `admin-order-form` の読取規則を足してある** —— **旧の `audience` には
      // 無かった1行である。** **理由: 下の (D) の viewer の 403 が「画面の判定」ではなく
      // 「書込ロールではない」で止まっていることを、今日も測るためである**
      // (画面の判定を先に通さないと、既存の関門を測れない)。
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [{ target: "view", view: "admin-order-form", can: ["read"] }],
        },
        {
          id: "editor",
          name: "編集者",
          rules: [{ target: "view", view: "admin-order-form", can: ["read"] }],
        },
        {
          id: "viewer",
          name: "閲覧者",
          rules: [{ target: "view", view: "admin-order-form", can: ["read"] }],
        },
        {
          id: "customer",
          name: "お客様",
          rules: [{ target: "view", view: "cust-only-order-list", can: ["read"] }],
        },
      ],
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-batch-audience-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "まとめ書きの店", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **【`V8-M26`】表(`product` / `order`)にだけ既定3役割の規則を足す。**
  // **`skipAllViews: true` を渡すのが要点である** —— **画面の規則は題材が自分で書いており
  // (`admin-order-form` = 運営3役割 / `cust-only-order-list` = `customer` だけ)、
  // そこへ既定の規則を足すと (A) の「owner は客専用の画面を名乗れない」が測れなくなる。**
  // **`order-list`(規則を1本も書かない画面)も閉じたままにしてある。**
  expect(
    applyManifest(dataRoot, APP_ID, withDefaultRoleRules(manifest(), { skipAllViews: true })).valid,
  ).toBe(true);
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function session(role: "owner" | "editor" | "viewer" | "customer") {
  return seedSession(dataRoot, APP_ID, { role, username: `${role}-${Math.random()}` });
}

const BATCH = (view?: string) =>
  `/api/apps/${APP_ID}/batch${view === undefined ? "" : `?view=${view}`}`;
const RECORDS = (view?: string) =>
  `/api/apps/${APP_ID}/tables/order/records${view === undefined ? "" : `?view=${view}`}`;

function post(cookie: string | undefined, path: string, body: unknown): Promise<Response> {
  const headers: Record<string, string> = {
    origin: TEST_ORIGIN,
    "content-type": "application/json",
  };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  return Promise.resolve(
    app.request(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    ),
  );
}

const ONE_OP = { ops: [{ op: "create", table: "order", values: { total: 1 } }] };

// --- (A) 迂回そのもの: 同一セッション・同一画面IDで、単件経路とバッチ経路が一致する --------

test("(A) owner が客専用の画面を名乗ったバッチは 403(単件経路の 403 と一致する)", async () => {
  const o = session("owner");
  // **単件経路は今日すでに 403 である**(`cp-v4.md` §6-3 #10 の対照の片側)。
  const single = await post(o.cookie, RECORDS("cust-only-order-list"), { total: 1 });
  expect(single.status).toBe(403);
  // **バッチ経路も同じでなければならない。** ここが `V4-FIX1` の前は 200 だった。
  const batch = await post(o.cookie, BATCH("cust-only-order-list"), ONE_OP);
  expect(batch.status).toBe(403);
});

test("(A) 拒否の本文は単件経路と同じ形である(画面IDと hint が読める)", async () => {
  // **【`V8-M20` / `J-G27`】旧テスト名の逐語: 「(A) 拒否の本文は単件経路と同じ形である
  // (画面IDと allowed_values が読める)」。**
  // **旧本体には `expect(body.errors?.[0]?.allowed_values).toEqual(["customer"]);` が在った。**
  // **`forbiddenViewAudienceError` は「見せる相手」の列挙を `allowed_values` に載せていたが、
  // それを置き直した `forbiddenRoleAccessError` は載せない** —— **面は「誰に許されているか」を
  // 答えず、「あなたの役割には書かれていない」としか言わない。**
  // **応答から情報が1つ減ったことを隠さないために、`undefined` を明示的に固定する。**
  const o = session("owner");
  const res = await post(o.cookie, BATCH("cust-only-order-list"), ONE_OP);
  expect(res.status).toBe(403);
  const body = (await res.json()) as {
    errors?: { message?: string; allowed_values?: string[]; hint?: string }[];
  };
  expect(body.errors?.[0]?.message).toContain("cust-only-order-list");
  expect(body.errors?.[0]?.allowed_values).toBeUndefined();
  expect(body.errors?.[0]?.hint).toBeDefined();
});

test("(A) 拒否されたバッチは1行も書いていない(遮断であって、書いてから隠すのではない)", async () => {
  const o = session("owner");
  const before = await app.request(
    new Request(`http://localhost${RECORDS()}`, { headers: { cookie: o.cookie } }),
  );
  const beforeCount = ((await before.json()) as { records: unknown[] }).records.length;

  expect((await post(o.cookie, BATCH("cust-only-order-list"), ONE_OP)).status).toBe(403);

  const after = await app.request(
    new Request(`http://localhost${RECORDS()}`, { headers: { cookie: o.cookie } }),
  );
  expect(((await after.json()) as { records: unknown[] }).records).toHaveLength(beforeCount);
});

// --- (B) 規則を持つ立場は通る(遮断が一律ではないこと)----------------------------------

test("(B) owner が運営に開いた画面を名乗ったバッチは今日どおり通る", async () => {
  // **【`V8-M20` / `J-G27`】旧テスト名の逐語: 「(B) owner が運営用と宣言した画面を名乗った
  // バッチは今日どおり通る」。**
  const o = session("owner");
  const res = await post(o.cookie, BATCH("admin-order-form"), ONE_OP);
  expect(res.status).toBe(200);
});

test("(B) editor も規則を持っていれば通る", async () => {
  // **【`V8-M20` / `J-G27`】旧テスト名の逐語: 「(B) editor も列挙に載っていれば通る」。**
  const e = session("editor");
  const res = await post(e.cookie, BATCH("admin-order-form"), ONE_OP);
  expect(res.status).toBe(200);
});

// --- (C) 画面IDの詐称を通さない(単件経路の (D) と同じ規律)-----------------------------

test("(C) 実在しない画面IDを名乗ったバッチは 400(黙って素通りさせない)", async () => {
  const o = session("owner");
  const res = await post(o.cookie, BATCH("no-such-view"), ONE_OP);
  expect(res.status).toBe(400);
});

// --- (D) 未認証・viewer は今日どおり(判定の順序を単件経路に合わせる)--------------------

test("(D) 未認証が客専用の画面を名乗ると 403(単件経路と同じ順序 = 画面の判定が先)", async () => {
  // **`recordsAuthMiddleware` は画面の判定を 401 の**手前**に置いている。**
  // **バッチも同じ順序にする**(`ADR-0003` §7「入口を何本生やしても振る舞いが一致する」)。
  // **未ログインは `anonymous` 1語の主体として判定され、`anonymous` にはこの画面の規則が
  // 書かれていないので止まる。**
  const res = await post(undefined, BATCH("cust-only-order-list"), ONE_OP);
  expect(res.status).toBe(403);
});

test("(D) 未認証が画面を名乗らなければ今日どおり 401(認証境界を1ミリも緩めていない)", async () => {
  const res = await post(undefined, BATCH(), ONE_OP);
  expect(res.status).toBe(401);
});

test("(D) viewer は画面の規則を持っていても書込ロールではないので 403(既存の関門を消していない)", async () => {
  // **【`V8-M20` / `J-G27`】旧テスト名の逐語: 「(D) viewer は宣言に載っていても書込ロールでは
  // ないので 403(既存の関門を消していない)」。**
  // **`viewer` に `admin-order-form` の読取規則を足してあるのは、画面の判定を通したうえで
  // 「書込ロールではない」の関門に到達させるためである**(足さないと、画面の判定が先に
  // 403 を返してしまい、この検査が何も測らなくなる)。
  const v = session("viewer");
  const res = await post(v.cookie, BATCH("admin-order-form"), ONE_OP);
  expect(res.status).toBe(403);
  // **止めたのが「画面の規則」ではなく「書込ロール」であることを、文面で確かめる。**
  const body = (await res.json()) as { errors?: { message?: string }[] };
  expect(body.errors?.[0]?.message).not.toContain("admin-order-form");
});

// --- (Z) 【守らない】`?view=` を渡さないバッチは今日どおり ---------------------------------

test("(Z)【守らない】owner が ?view= を外すと、今日どおりバッチが通る", async () => {
  const o = session("owner");
  const res = await post(o.cookie, BATCH(), ONE_OP);
  expect(res.status).toBe(200);
});

// --- (Y) 【守らない】画面の表と ops の表の一致を見ていない ------------------------------

test("(Y)【守らない】自分に開いている画面を名乗って、別の表へ書ける(表の一致を見ていない)", async () => {
  // **単件経路は `namedView.table !== tableId` で 400 にするが、バッチには比べる相手が
  // 1つに決まらない**(1リクエストで複数テーブルを跨ぐ)。**この検査は穴を固定して残す。**
  // **新しく開く表は1つも無い**(バッチは元から editor/owner 限定)**が、「表の一致を
  // 見ている」とは書けない。** **`V8-M20` はこの穴を1ミリも塞いでいない。**
  const o = session("owner");
  const res = await post(o.cookie, BATCH("admin-order-form"), {
    ops: [{ op: "create", table: "product", values: { name: "別の表へ書けた" } }],
  });
  expect(res.status).toBe(200);
});
