/**
 * customer ロールの可視性(GET)+ 書込認可のサーバ層テスト
 * (V2-M1-T03 / ADR-0033 限定4・5)。
 *
 * 前半は純粋判定 `nonAdminTableAccess`(`owner-scope.ts`)の真理値表、後半は
 * `createServerApp` を使った HTTP 統合テスト。customer の認可規律を1箇所に固定する:
 *
 *   customer × {st_owner テーブル / public テーブル / 運営テーブル} × {GET, POST, PATCH, DELETE}
 *     st_owner テーブル → GET は自分の行/共有のみ・書込は自分の行のみ許可
 *     public テーブル   → GET 可・書込 403(read-only)
 *     運営テーブル      → GET 403 / 書込 403(閲覧も書込も遮断)
 *
 * さらに既存3ロール(owner/editor/viewer)の非回帰・匿名公開窓の非回帰を固定する。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Table } from "../kernel/index.ts";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import * as ownerScope from "./owner-scope.ts";
import { OWNER_FIELD, PUBLIC_FIELD, personalOwnerField, publicField } from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

// --- P1: 純粋判定 nonAdminTableAccess --------------------------------------------
//
// =====================================================================================
// **【`V8-M27-T04` / `T-G5`。この5本は判定ごと撤去された。旧のテスト名と旧の期待値を
//   逐語で残す。検査は1本も消していない ―― 下の2本に置き換えた】**
//
// **旧のテスト名と旧の期待値(逐語)**:
//
//  1. `nonAdminTableAccess: st_owner(text 非required)を持つテーブルは scoped`
//       expect(nonAdminTableAccess(table)).toBe("scoped");
//  2. `nonAdminTableAccess: st_public(boolean 非required)だけを持つテーブルは public`
//       expect(nonAdminTableAccess(table)).toBe("public");
//  3. `nonAdminTableAccess: st_owner と st_public を両方持てば scoped が優先(post-filter を掛ける)`
//       expect(nonAdminTableAccess(table)).toBe("scoped");
//  4. `nonAdminTableAccess: どちらの規約も持たない運営テーブルは denied`
//       expect(nonAdminTableAccess(table)).toBe("denied");
//  5. `nonAdminTableAccess: 規約に合致しない st_owner/st_public(型/required 違い)は denied`
//       expect(nonAdminTableAccess(table)).toBe("denied");
//
// **根拠**: **`V8-M27` / 台帳 `T-G5` / ユーザ決定 `D-V8-38`。**
// **`nonAdminTableAccess` と `NonAdminTableAccess` は `src/server/owner-scope.ts` から
// 撤去された** —— **「運営(予約3ロール)か否か」で表単位の可否を決める層そのものだった
// ためである。** **したがって期待値を反転させる余地が無い**(呼ぶ関数が存在しない)。
//
// **置き換えの2本が測るもの**:
//  (P1-a) **その名前が本当に消えていること**(消し忘れ・こっそりの復活を止める)。
//  (P1-b) **判定の材料だった予約規約の述語(`personalOwnerField` / `publicField`)は
//         1バイトも変わっていないこと** —— **上の5本が測っていた「型/required の規約」は
//         今日もこの2本が持っている。** **撤去したのは「その3値をロールの可否へ写す層」
//         だけであって、規約そのものではない。**
// =====================================================================================

function tableWith(fields: Table["fields"]): Table {
  return { id: "t", name: "T", fields };
}

test("(P1-a) `nonAdminTableAccess` / `NonAdminTableAccess` は撤去されている(V8-M27 / T-G5)", () => {
  expect(Object.hasOwn(ownerScope, "nonAdminTableAccess")).toBe(false);
  // **型は実行時に観測できないので、名前の一覧に現れないことだけを見る。**
  expect(Object.keys(ownerScope)).not.toContain("nonAdminTableAccess");
  expect(Object.keys(ownerScope)).not.toContain("NonAdminTableAccess");
});

test("(P1-b) 予約規約の述語は1バイトも変わっていない(型/required の規約は今日も同じ)", () => {
  // **旧 1 の題材**(`st_owner` text 非required)。
  expect(
    personalOwnerField(
      tableWith([
        { id: "title", name: "題", type: "text" },
        { id: OWNER_FIELD, name: "所有者", type: "text" },
      ]),
    ),
  ).toBeDefined();
  // **旧 2 の題材**(`st_public` boolean 非required)。
  expect(
    publicField(
      tableWith([
        { id: "title", name: "題", type: "text" },
        { id: PUBLIC_FIELD, name: "公開", type: "boolean" },
      ]),
    ),
  ).toBeDefined();
  // **旧 4 の題材**(どちらの規約も持たない表)。
  const plain = tableWith([{ id: "name", name: "名", type: "text", required: true }]);
  expect(personalOwnerField(plain)).toBeUndefined();
  expect(publicField(plain)).toBeUndefined();
  // **旧 5 の題材**(型 / required が規約に合致しない)。
  const malformed = tableWith([
    { id: OWNER_FIELD, name: "所有者", type: "text", required: true }, // required → 非該当
    { id: PUBLIC_FIELD, name: "公開", type: "text" }, // text → 非該当
  ]);
  expect(personalOwnerField(malformed)).toBeUndefined();
  expect(publicField(malformed)).toBeUndefined();
});

// --- P2: HTTP 統合 ---------------------------------------------------------------

const APP_ID = "shop";

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "ショップ",
      tables: [
        {
          id: "orders", // 顧客スコープ(st_owner text 非required)
          name: "注文",
          fields: [
            { id: "item", name: "品目", type: "text", required: true },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
          ],
        },
        {
          id: "products", // 公開(st_public boolean 非required)
          name: "商品",
          fields: [
            { id: "name", name: "名称", type: "text", required: true },
            { id: PUBLIC_FIELD, name: "公開", type: "boolean" },
          ],
        },
        {
          id: "admin_orders", // 運営テーブル(st_owner も st_public も無い)
          name: "全注文管理",
          fields: [{ id: "memo", name: "メモ", type: "text", required: true }],
        },
      ],
      views: [{ id: "order-list", type: "list_view", table: "orders", columns: ["item"] }],
    },
  };
}

/**
 * **【`V8-M26`】適用する題材**(`beforeEach` が `applyManifest` に渡すもの)。
 *
 * **既定が閉じた**(`V8-M26` / ユーザ決定 `D-V8-45` / `D-V8-65`)—— **規則を1本も
 * 名指ししていない表・画面・ボタンは拒否される。**
 *
 * **本ファイルの主題は面(役割に束ねた権限)ではなく、その手前に在る**予約規約
 * (`st_owner` / `st_public`)の層** —— `nonAdminTableAccess` である。**
 * **面を開けておかないと、判定が面で止まってしまい、予約規約の層が何をしているのか
 * 1件も測れなくなる。** **そこで、着手前に通っていた操作と同じだけを面に書く。**
 *
 * - `withDefaultRoleRules` が既定3役割へ入れるのは `apply-diff.ts` の自動付与と同じ規則だけ
 *   である(**項目の規則は1本も足さない**)。
 * - **`customer`** には `orders` と `products` の読取・書込・削除を足す ——
 *   **`products` に書込・削除まで足しているのは意図的である。** **「公開テーブルは
 *   read-only(403)」を止めているのが予約規約の層であることを、面で先に止めずに測るため。**
 *   **運営テーブル(`admin_orders`)には1本も足していない** —— **customer をそこで
 *   止めているのは今日も予約規約の層である**(その2本は着手前から緑のままである)。
 * - **`anonymous`** には `products` の読取1語だけ(未ログインには `read` しか書けない)。
 *
 * ## **【`orders` の規則に条件(`when`)を書いている理由。ここを素で書くと個人スコープが消える】**
 *
 * **`D-V8-35` により、面が表の**読取**を許すと、その役割は `st_owner`(個人スコープ)を
 * 読取について越える**(`roleReadCrossesOwnerScope`)。**したがって
 * `{ target: "table", table: "orders", can: ["read"] }` を素で書くと、
 * **`customer` に全員分の注文が見える。****それは本ファイルが測っている性質そのものの
 * 消滅である。**
 *
 * **そこで `when: { field: st_owner, equals_current_user: true }` を付けている**
 * (`V8-M18` / `J-G12`。`src/server/owner-scope.test.ts:916` が同じ形を使っている)——
 * **「自分の行についてだけ面が読取を許す」ので、他人の行では越えず、予約規約の層が
 * 今日どおり隠す。**
 *
 * **【正直に書く】これは既定を閉じたことの代償である** —— **着手前は `orders` に規則を
 * 1本も書かなくてよく、条件を書く必要も無かった。**
 */
function seededManifest(): Manifest {
  const m = manifest() as Manifest & {
    app: { roles?: { id: string; name: string; rules?: unknown[] }[] };
  };
  m.app.roles = [
    {
      id: "customer",
      name: "お客様",
      rules: [
        {
          target: "table",
          table: "orders",
          can: ["read", "write", "delete"],
          when: { field: OWNER_FIELD, equals_current_user: true },
        },
        { target: "table", table: "products", can: ["read", "write", "delete"] },
        // **【`V18-M4-T02b`。ユーザ決定 `D-V18-26` / `ADR-0441`】画面の規則を1本足した。**
        //
        // **`V18-M4-T02` が「画面名を名乗らない読取」に壁を立てた** —— **その表を指す
        // 一覧系の画面(`list_view` / `report_view`)を**1本も読めない**相手の一覧は 0件に
        // なる(単票は 404)。** **`D-V18-26` により、画面を宣言しているのに「誰に見せるか」を
        // 役割の規則に1行も書いていない場合も止まる。**
        //
        // **この題材は `order-list`(`list_view`。表 `orders`)を宣言しながら、その画面の
        // 規則を1本も書いていなかった** —— **今日の正から見て設計図が不完全だった。**
        // **本ファイルの主題は予約規約(`st_owner` / `st_public`)の層であって画面の規則では
        // ないので、主張(`expect`)は1バイトも書き換えていない。**
        // **足すのは `orders` の一覧を客に見せる1本だけである**(`products` と
        // `admin_orders` を指す画面は題材に1本も無いので、壁はそもそも立たない)。
        { target: "view", view: "order-list", can: ["read"] },
      ],
    },
    {
      id: "anonymous",
      name: "未ログイン",
      rules: [{ target: "table", table: "products", can: ["read"] }],
    },
  ];
  return withDefaultRoleRules(m);
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-cust-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "ショップ", { app_id: APP_ID });
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
  ifMatch?: string,
): Promise<Response> {
  const headers: Record<string, string> = { origin: TEST_ORIGIN };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  if (ifMatch !== undefined) {
    headers["if-match"] = ifMatch;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return Promise.resolve(app.request(new Request(`http://localhost${path}`, init)));
}

const R = (table: string, id?: string) =>
  `/api/apps/${APP_ID}/tables/${table}/records${id === undefined ? "" : `/${id}`}`;

async function versionOf(cookie: string, table: string, id: string): Promise<string> {
  const res = await req(cookie, "GET", R(table, id));
  const etag = res.headers.get("etag");
  if (etag !== null) {
    return etag;
  }
  return ((await res.json()) as { record: { _updated_at: string } }).record._updated_at;
}

async function create(
  cookie: string,
  table: string,
  body: Record<string, unknown>,
): Promise<{ status: number; id?: string; owner?: unknown }> {
  const res = await req(cookie, "POST", R(table), body);
  if (res.status !== 201) {
    return { status: res.status };
  }
  const rec = ((await res.json()) as { record: Record<string, unknown> }).record;
  return { status: 201, id: rec._id as string, owner: rec[OWNER_FIELD] };
}

async function listIds(cookie: string | undefined, table: string): Promise<string[]> {
  const res = await req(cookie, "GET", R(table));
  const body = (await res.json()) as { records: { _id: string }[] };
  return body.records.map((r) => r._id);
}

function customer(username: string) {
  return seedSession(dataRoot, APP_ID, { role: "customer", username });
}
function owner(username: string) {
  return seedSession(dataRoot, APP_ID, { role: "owner", username });
}

// --- customer GET(限定5)-------------------------------------------------------

// **【`V8-M27-T04` / `T-G5`。期待値を反転させた。旧のテスト名と旧の期待値を逐語で残す】**
// **旧: `test("customer GET 運営テーブル(list)→ 403(閲覧遮断)")` / `expect(res.status).toBe(403);`**
// **根拠**: **`V8-M27` / `T-G5` / `D-V8-38`。** **`nonAdminTableAccess` の層を撤去した。**
// **今日その表を隠しているのは面(`app.roles[].rules`)であり、`customer` には
// `admin_orders` の規則が1本も書かれていない** —— **`ADR-0305` 限定11 により、
// 一覧は「200 + 0件」で返る(403 にすると「その表が在る」ことが役割の外へ漏れる)。**
test("customer GET 運営テーブル(list)→ 200 + 0件(規則が無い表は伏せる。ADR-0305 限定11)", async () => {
  const o = owner("admin");
  await create(o.cookie, "admin_orders", { memo: "全注文" });
  const c = customer("c1");
  const res = await req(c.cookie, "GET", R("admin_orders"));
  expect(res.status).toBe(200);
  expect(await listIds(c.cookie, "admin_orders")).toEqual([]);
});

// **【同上。期待値を反転させた】**
// **旧: `test("customer GET 運営テーブル(single)→ 403(存在も値も出さない)")` /
//       `expect(res.status).toBe(403);`**
// **「存在も値も出さない」という主題は today も同じで、返し方だけが 403 から 404 に移った。**
test("customer GET 運営テーブル(single)→ 404(存在も値も出さない。ADR-0305 限定11)", async () => {
  const c = customer("c1");
  const res = await req(c.cookie, "GET", R("admin_orders", "anything"));
  expect(res.status).toBe(404);
});

test("customer GET 公開テーブル → 200(閲覧可)", async () => {
  const o = owner("admin");
  await create(o.cookie, "products", { name: "りんご", [PUBLIC_FIELD]: true });
  const c = customer("c1");
  const res = await req(c.cookie, "GET", R("products"));
  expect(res.status).toBe(200);
  expect((await listIds(c.cookie, "products")).length).toBe(1);
});

test("customer GET st_owner テーブル: 自分の行のみ見える(他人の行は不可視)", async () => {
  const c1 = customer("c1");
  const c2 = customer("c2");
  const mine = await create(c1.cookie, "orders", { item: "本" });
  await create(c2.cookie, "orders", { item: "鉛筆" });
  const ids = await listIds(c1.cookie, "orders");
  expect(ids).toEqual([mine.id as string]);
});

test("customer GET st_owner テーブル single: 他人の行 → 404(存在を伏せる)", async () => {
  const c1 = customer("c1");
  const c2 = customer("c2");
  const theirs = await create(c2.cookie, "orders", { item: "鉛筆" });
  const res = await req(c1.cookie, "GET", R("orders", theirs.id as string));
  expect(res.status).toBe(404);
});

// --- customer 書込(限定4)-------------------------------------------------------

test("customer POST st_owner テーブル → 201・st_owner を customer id にスタンプ", async () => {
  const c = customer("c1");
  const created = await create(c.cookie, "orders", { item: "本" });
  expect(created.status).toBe(201);
  expect(created.owner).toBe(c.userId);
});

// --- 【`V8-M37` / 台帳 `F-G3` / ユーザ決定 `D-V8-96`。期待値を反転させた。旧を逐語で残す】 ---
//
// **旧のテスト名(逐語)**: `test("customer POST st_owner に他人 id を送っても actor.id に矯正される", ...)`
// **旧の期待(逐語)**:
//   ```
//   expect(created.status).toBe(201);
//   expect(created.owner).toBe(c.userId);
//   ```
//
// **根拠**: **`V8-M37` / 台帳 `F-G3` / ユーザ決定 `D-V8-96`(= 「断る」)。**
// **自分以外の値を持ち主として送った作成は 403 になる。** **相手が実在するかは1度も見ない**
// (`"someone-else"` は `_auth_users` に居ないが、それでも断る)。
// **書かない / 空文字 / `null` は今日どおり 201 のままである**(閉じすぎない)。
test("customer POST st_owner に他人 id を送ると 403(旧: actor.id に矯正される)", async () => {
  const c = customer("c1");
  const created = await create(c.cookie, "orders", { item: "本", [OWNER_FIELD]: "someone-else" });
  expect(created.status).toBe(403);
});

test("customer POST st_owner を書かなければ今日どおり 201(F-G3 が閉じすぎていない)", async () => {
  const c = customer("c1");
  const created = await create(c.cookie, "orders", { item: "本" });
  expect(created.status).toBe(201);
  expect(created.owner).toBe(c.userId);
});

test("customer POST 運営テーブル → 403(運営データを書けない)", async () => {
  const c = customer("c1");
  const res = await req(c.cookie, "POST", R("admin_orders"), { memo: "x" });
  expect(res.status).toBe(403);
});

// **【`V8-M27-T04` / `T-G5`。期待値を反転させた。旧のテスト名と旧の期待値を逐語で残す】**
// **旧: `test("customer POST 公開テーブル → 403(公開テーブルは read-only)")` /
//       `expect(res.status).toBe(403);`**
// **根拠**: **`V8-M27` / `T-G5` / `D-V8-38`。** **「公開テーブル(`st_public`)は
// 非運営から read-only」を止めていたのは `nonAdminTableAccess(table) !== "scoped"` の
// 1行であり、それを撤去した。** **今日の可否は面が決める** —— **この題材の `customer`
// には `products` の `write` が書いてある**(上の {@link seededManifest} の逐語)ので通る。
// **【正直に書く】これは広がりである。** **`st_public` だけでは書込を止められなくなった** ——
// **止めたいアプリは、その表の `write` を役割に書かなければよい。**
test("customer POST 公開テーブル → 201(面が write を許していれば書ける。旧: 必ず 403)", async () => {
  const c = customer("c1");
  const res = await req(c.cookie, "POST", R("products"), { name: "みかん" });
  expect(res.status).toBe(201);
});

test("customer PATCH 自分の st_owner 行 → 200", async () => {
  const c = customer("c1");
  const mine = await create(c.cookie, "orders", { item: "本" });
  const v = await versionOf(c.cookie, "orders", mine.id as string);
  const res = await req(c.cookie, "PATCH", R("orders", mine.id as string), { item: "雑誌" }, v);
  expect(res.status).toBe(200);
});

test("customer PATCH 他人の st_owner 行 → 404(不可視)", async () => {
  const c1 = customer("c1");
  const c2 = customer("c2");
  const theirs = await create(c2.cookie, "orders", { item: "鉛筆" });
  const v = await versionOf(c2.cookie, "orders", theirs.id as string);
  const res = await req(c1.cookie, "PATCH", R("orders", theirs.id as string), { item: "x" }, v);
  expect(res.status).toBe(404);
});

test("customer PATCH 自分の行を他人 id に付け替え → 403(spoof 拒否)", async () => {
  const c = customer("c1");
  const mine = await create(c.cookie, "orders", { item: "本" });
  const v = await versionOf(c.cookie, "orders", mine.id as string);
  const res = await req(
    c.cookie,
    "PATCH",
    R("orders", mine.id as string),
    { [OWNER_FIELD]: "someone-else" },
    v,
  );
  expect(res.status).toBe(403);
});

test("customer PATCH 運営テーブル → 403", async () => {
  const c = customer("c1");
  const res = await req(c.cookie, "PATCH", R("admin_orders", "x"), { memo: "y" }, "v0");
  expect(res.status).toBe(403);
});

test("customer DELETE 自分の st_owner 行 → 204", async () => {
  const c = customer("c1");
  const mine = await create(c.cookie, "orders", { item: "本" });
  const v = await versionOf(c.cookie, "orders", mine.id as string);
  const res = await req(c.cookie, "DELETE", R("orders", mine.id as string), undefined, v);
  expect(res.status).toBe(204);
});

test("customer DELETE 他人の st_owner 行 → 404", async () => {
  const c1 = customer("c1");
  const c2 = customer("c2");
  const theirs = await create(c2.cookie, "orders", { item: "鉛筆" });
  const v = await versionOf(c2.cookie, "orders", theirs.id as string);
  const res = await req(c1.cookie, "DELETE", R("orders", theirs.id as string), undefined, v);
  expect(res.status).toBe(404);
});

test("customer DELETE 運営テーブル → 403", async () => {
  const c = customer("c1");
  const res = await req(c.cookie, "DELETE", R("admin_orders", "x"), undefined, "v0");
  expect(res.status).toBe(403);
});

// **【`V8-M27-T04` / `T-G5`。期待値を反転させた。旧のテスト名と旧の期待値を逐語で残す】**
// **旧: `test("customer DELETE 公開テーブル → 403(read-only)")` / `expect(res.status).toBe(403);`**
// **根拠は1つ上の `POST` と同じである**(`nonAdminTableAccess` の撤去)。
// **今日は面が `delete` を許しているので層で止まらず、実在しない行の 404 に落ちる** ——
// **「読取専用だから断る」ではなく「その行が無い」に変わった。**
test("customer DELETE 公開テーブル → 404(面が delete を許すので、層ではなく行の不在で落ちる)", async () => {
  const c = customer("c1");
  const res = await req(c.cookie, "DELETE", R("products", "x"), undefined, "v0");
  expect(res.status).toBe(404);
});

// --- 既存3ロールの非回帰(限定6)-------------------------------------------------

test("非回帰 viewer: 運営テーブル GET 200(customer と違い運営テーブルも閲覧できる)", async () => {
  const o = owner("admin");
  await create(o.cookie, "admin_orders", { memo: "全注文" });
  const v = seedSession(dataRoot, APP_ID, { role: "viewer", username: "v1" });
  const res = await req(v.cookie, "GET", R("admin_orders"));
  expect(res.status).toBe(200);
  expect((await listIds(v.cookie, "admin_orders")).length).toBe(1);
});

test("非回帰 viewer: 運営テーブル書込は 403", async () => {
  const v = seedSession(dataRoot, APP_ID, { role: "viewer", username: "v1" });
  const res = await req(v.cookie, "POST", R("admin_orders"), { memo: "x" });
  expect(res.status).toBe(403);
});

test("非回帰 editor: 運営テーブル書込は 201(customer と違い運営データを書ける)", async () => {
  const e = seedSession(dataRoot, APP_ID, { role: "editor", username: "e1" });
  const res = await req(e.cookie, "POST", R("admin_orders"), { memo: "x" });
  expect(res.status).toBe(201);
});

test("非回帰 owner: 運営テーブル GET・書込とも通る", async () => {
  const o = owner("admin");
  expect((await req(o.cookie, "GET", R("admin_orders"))).status).toBe(200);
  expect((await create(o.cookie, "admin_orders", { memo: "x" })).status).toBe(201);
});

// --- 匿名公開窓の非回帰(T04)---------------------------------------------------

test("非回帰 匿名: 公開テーブルの未認証 GET は st_public===true の行だけ 200", async () => {
  const o = owner("admin");
  await create(o.cookie, "products", { name: "公開品", [PUBLIC_FIELD]: true });
  await create(o.cookie, "products", { name: "非公開品", [PUBLIC_FIELD]: false });
  const res = await req(undefined, "GET", R("products"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { records: Record<string, unknown>[] };
  expect(body.records.length).toBe(1);
  expect(body.records[0]?.name).toBe("公開品");
  // 予約規約フィールドは匿名に出さない
  expect(body.records[0]?.[PUBLIC_FIELD]).toBeUndefined();
});

test("非回帰 匿名: 運営テーブルの未認証 GET は 401(公開窓を開けない)", async () => {
  const res = await req(undefined, "GET", R("admin_orders"));
  expect(res.status).toBe(401);
});

test("非回帰 匿名: 公開テーブルへの未認証 POST は 401(書込は塞ぐ)", async () => {
  const res = await req(undefined, "POST", R("products"), { name: "x" });
  expect(res.status).toBe(401);
});
