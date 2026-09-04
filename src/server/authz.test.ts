/**
 * 権限モデル(role enforcement)+ 管理エンドポイント + 監査配線のテスト
 * (V1-M3-T02 / ADR-0015 / 計画 v2 §テスト計画・P-B)。
 *
 * 役割×操作マトリクス:
 *   {viewer, editor, owner, 未認証} × {GET records, POST, PATCH, DELETE, GET users, PATCH users/:id}
 *   viewer  → GET records 200 / 書込 403 / 管理 403
 *   editor  → GET・書込 200 / 管理 403
 *   owner   → 全 200
 *   未認証  → 401
 *
 * **【`V8-M26` による訂正。上の4行は1バイトも消していない】**
 * **既定が「閉じる」側へ倒れ(`D-V8-45` / `D-V8-58` / `D-V8-65`)、その埋め合わせに
 * 既定3役割の規則が入るようになった(`D-V8-61` / `D-V8-62`)ので、この表は1マス変わった** ——
 * **`editor` の `DELETE` は 204 ではなく 403 である**(既定の編集者は「見る + 書く」だけで、
 * `delete` を持たない)。**残りのマスは1つも変わっていない。**
 *
 * 監査(`_auth_activity`): records 書込のたびにセッションユーザ付きで記録され、GET では
 * 記録されない。カーネル書込が失敗すれば監査行も残らない(同一トランザクション巻き戻り)。
 * `_auth_activity` が無いアプリ(T01 世代 DB)への書込でもスキーマが再生成され記録される。
 *
 * register 初回=owner / 2人目=viewer。login で owner=0 の DB を self-heal。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "../auth/store.ts";
import type { Role } from "../auth/types.ts";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

/**
 * app.sqlite の物理パス。`appDbPath`(カーネル値)を import すると ADR-0009 限定2 の
 * import スナップショットが増えるため、保存レイアウトをこの1箇所だけ手で綴る
 * (`src/kernel/storage-paths.ts` の appDbPath と同一)。
 */
function appSqlitePath(root: string, appId: string): string {
  return join(root, "apps", appId, "app.sqlite");
}

const APP_ID = "inventory";
const AUTH_REQUIRED_MESSAGE = "認証が必要です。ログインしてください。";

function inventoryManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "備品管理",
      tables: [
        {
          id: "items",
          name: "備品",
          fields: [{ id: "name", name: "備品名", type: "text", required: true }],
        },
      ],
      views: [{ id: "item-list", type: "list_view", table: "items", columns: ["name"] }],
    },
  };
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-authz-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "備品管理", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **【`V8-M26`】既定が「閉じる」側へ倒れたので、題材へ既定3役割の規則を足す。**
  // **旧: `expect(applyManifest(dataRoot, APP_ID, inventoryManifest()).valid).toBe(true);`**
  //
  // **この題材は `app.roles` を1つも持っていない** —— **`D-V8-65` により、役割を1つも
  // 宣言していないアプリは表・画面・ボタンが閉じる。** **本ファイルの主題は
  // 固定ロール(viewer / editor / owner / 未認証)×操作の表と監査の配線であって面ではない** ——
  // **面で全部 403 になると、その表を1マスも測れない。**
  // **`withDefaultRoleRules` は `app.roles` が無ければ既定3役割の宣言ごと足す**
  // (**`create-app.ts` が新規アプリに入れる3宣言と同じもの**)。
  expect(applyManifest(dataRoot, APP_ID, withDefaultRoleRules(inventoryManifest())).valid).toBe(
    true,
  );
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

const R = `/api/apps/${APP_ID}/tables/items/records`;
const USERS = `/api/apps/${APP_ID}/auth/users`;

/** cookie + origin を付けてリクエストする。records の PATCH/DELETE は If-Match を渡せる。 */
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

/** レコードの現在の版(_updated_at)を GET の ETag から得る(If-Match 必須の PATCH/DELETE 用)。 */
async function versionOf(cookie: string, path: string): Promise<string> {
  const res = await req(cookie, "GET", path);
  const etag = res.headers.get("etag");
  if (etag !== null) {
    return etag;
  }
  return ((await res.json()) as { record: { _updated_at: string } }).record._updated_at;
}

/** app.sqlite に owner ユーザ1人を確実に用意し、そのユーザ id を返す(監査 actor 用)。 */
function seed(role: Role, username?: string) {
  return seedSession(dataRoot, APP_ID, { role, ...(username === undefined ? {} : { username }) });
}

// --- 役割×操作マトリクス ----------------------------------------------------------

test("viewer: GET records 200 / 書込 403 / 管理 403", async () => {
  const { cookie } = seed("viewer");
  expect((await req(cookie, "GET", R)).status).toBe(200);

  const post = await req(cookie, "POST", R, { name: "机" });
  expect(post.status).toBe(403);
  const body = (await post.json()) as { errors?: { message?: string }[] };
  // 未認証(401)ではなく権限不足(403)。boundary の 401 メッセージではない。
  expect(body.errors?.[0]?.message).not.toBe(AUTH_REQUIRED_MESSAGE);

  expect((await req(cookie, "PATCH", `${R}/x`, { name: "机" })).status).toBe(403);
  expect((await req(cookie, "DELETE", `${R}/x`)).status).toBe(403);
  expect((await req(cookie, "GET", USERS)).status).toBe(403);
  expect((await req(cookie, "PATCH", `${USERS}/whoever`, { role: "editor" })).status).toBe(403);
});

test("editor: GET・書込 200 / 管理 403", async () => {
  const { cookie } = seed("editor");
  expect((await req(cookie, "GET", R)).status).toBe(200);

  const post = await req(cookie, "POST", R, { name: "机" });
  expect(post.status).toBe(201);
  const created = (await post.json()) as { record: { _id: string } };
  const id = created.record._id;

  const v1 = await versionOf(cookie, `${R}/${id}`);
  expect((await req(cookie, "PATCH", `${R}/${id}`, { name: "椅子" }, v1)).status).toBe(200);
  const v2 = await versionOf(cookie, `${R}/${id}`);
  // **【`V8-M26`。ユーザ決定 `D-V8-61`。旧の1行を逐語で残す】**
  // **旧: `expect((await req(cookie, "DELETE", `${R}/${id}`, undefined, v2)).status).toBe(204);`**
  //
  // **既定3役割へ自動で入る規則は「編集者 = 見る + 書く」であり、`delete` が入っていない**
  // (`D-V8-61` の逐語)。**固定ロールの層は今日も編集者の削除を通すが、面がその後ろで
  // 止める。** **したがって編集者は、既定のままのアプリでは行を消せなくなった** ——
  // **これは `V8-M26` が「今日できていたことのうち、できなくした」ことの1件である。**
  // **消せるようにするには、`editor` の表の規則に `delete` を足す**(面の allow-list に
  // 足すことは今日もできる)。
  expect((await req(cookie, "DELETE", `${R}/${id}`, undefined, v2)).status).toBe(403);

  expect((await req(cookie, "GET", USERS)).status).toBe(403);
  expect((await req(cookie, "PATCH", `${USERS}/whoever`, { role: "editor" })).status).toBe(403);
});

test("owner: records 全操作 + 管理が通る", async () => {
  const owner = seed("owner");
  expect((await req(owner.cookie, "GET", R)).status).toBe(200);

  const post = await req(owner.cookie, "POST", R, { name: "机" });
  expect(post.status).toBe(201);
  const id = ((await post.json()) as { record: { _id: string } }).record._id;
  const v1 = await versionOf(owner.cookie, `${R}/${id}`);
  expect((await req(owner.cookie, "PATCH", `${R}/${id}`, { name: "椅子" }, v1)).status).toBe(200);
  const v2 = await versionOf(owner.cookie, `${R}/${id}`);
  expect((await req(owner.cookie, "DELETE", `${R}/${id}`, undefined, v2)).status).toBe(204);

  const users = await req(owner.cookie, "GET", USERS);
  expect(users.status).toBe(200);
  const list = (await users.json()) as { users: { id: string; role: Role }[] };
  expect(list.users.some((u) => u.id === owner.userId && u.role === "owner")).toBe(true);
});

test("未認証: records も管理も 401", async () => {
  expect((await req(undefined, "GET", R)).status).toBe(401);
  expect((await req(undefined, "POST", R, { name: "机" })).status).toBe(401);
  expect((await req(undefined, "GET", USERS)).status).toBe(401);
  expect((await req(undefined, "PATCH", `${USERS}/x`, { role: "editor" })).status).toBe(401);
});

// --- 管理(owner 限定)------------------------------------------------------------

test("owner が viewer を editor に昇格できる", async () => {
  const owner = seed("owner");
  const target = seed("viewer");
  const res = await req(owner.cookie, "PATCH", `${USERS}/${target.userId}`, { role: "editor" });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { user: { id: string; role: Role } };
  expect(body.user).toMatchObject({ id: target.userId, role: "editor" });

  const store = AuthStore.openForApp(dataRoot, APP_ID);
  try {
    expect(store.findUserById(target.userId)?.role).toBe("editor");
  } finally {
    store.close();
  }
});

// **【`V8-M28` 第2波(2026-08-11)。期待値を反転させた。旧を逐語で残す】**
//
// **旧のテスト名**: `最後の owner を降格しようとすると 409`
// **旧の本文(逐語)**:
//
//     test("最後の owner を降格しようとすると 409", async () => {
//       const owner = seed("owner");
//       const res = await req(owner.cookie, "PATCH", `${USERS}/${owner.userId}`, { role: "viewer" });
//       expect(res.status).toBe(409);
//     });
//
// **根拠**: **ユーザ決定 `D-V8-76`(選ばれた見出し「**自分自身は変えられない**」)/ 台帳 `T-G20`。**
// **この要求は「自分自身の役割の書き換え」であり、今日は最後の持ち主かどうかを見る前に
// 403 で止まる。** **`LastOwnerError` の 409 は1バイトも触っていない** ——
// **止める順番が変わっただけである。**
//
// **【409 が消えたわけではない】** —— **「最後の持ち主を**他人が**降ろせない」ことは
// `src/server/role-definition-distribution-http.test.ts` の (2-7) と、
// `src/server/multi-role-http.test.ts` の (T06-6) / (T06-7) が実 HTTP で固定している。**
test("最後の owner が自分を降格しようとすると 403(`D-V8-76`。旧: 409)", async () => {
  const owner = seed("owner");
  const res = await req(owner.cookie, "PATCH", `${USERS}/${owner.userId}`, { role: "viewer" });
  expect(res.status).toBe(403);
  const body = (await res.json()) as { errors?: { message?: string }[] };
  expect(body.errors?.[0]?.message).toContain("自分自身");
});

test("不正な role は 400", async () => {
  const owner = seed("owner");
  const target = seed("viewer");
  const res = await req(owner.cookie, "PATCH", `${USERS}/${target.userId}`, { role: "superadmin" });
  expect(res.status).toBe(400);
});

test("存在しないユーザへの PATCH は 404", async () => {
  const owner = seed("owner");
  const res = await req(owner.cookie, "PATCH", `${USERS}/nonexistent`, { role: "editor" });
  expect(res.status).toBe(404);
});

// --- 監査(_auth_activity)---------------------------------------------------------

test("records 書込は actor 付きで _auth_activity に記録され、GET は記録しない", async () => {
  const owner = seed("owner", "alice");

  await req(owner.cookie, "GET", R); // 読み取りは記録されない

  const post = await req(owner.cookie, "POST", R, { name: "机" });
  const id = ((await post.json()) as { record: { _id: string } }).record._id;
  const v1 = await versionOf(owner.cookie, `${R}/${id}`);
  await req(owner.cookie, "PATCH", `${R}/${id}`, { name: "椅子" }, v1);
  const v2 = await versionOf(owner.cookie, `${R}/${id}`);
  await req(owner.cookie, "DELETE", `${R}/${id}`, undefined, v2);

  const store = AuthStore.openForApp(dataRoot, APP_ID);
  try {
    const activity = store.listActivity();
    expect(activity.map((a) => a.action)).toEqual([
      "create_record",
      "update_record",
      "delete_record",
    ]);
    for (const a of activity) {
      expect(a.userId).toBe(owner.userId);
      expect(a.username).toBe("alice");
      expect(a.tableId).toBe("items");
    }
    // create の record_id は生成後の _id。
    expect(activity[0]?.recordId).toBe(id);
  } finally {
    store.close();
  }
});

test("カーネル書込が失敗すると監査行も残らない(トランザクション巻き戻り)", async () => {
  const owner = seed("owner");
  // name は required。空ボディはバリデーション失敗 → 400。
  const res = await req(owner.cookie, "POST", R, {});
  expect(res.status).toBe(400);

  const store = AuthStore.openForApp(dataRoot, APP_ID);
  try {
    expect(store.listActivity()).toHaveLength(0);
  } finally {
    store.close();
  }
});

test("_auth_activity が無い(T01 世代)DB への書込でもスキーマが再生成され記録される", async () => {
  const owner = seed("owner");
  // openForApp が作った _auth_activity を消して、旧世代 DB を模す。
  const raw = new Database(appSqlitePath(dataRoot, APP_ID), { readwrite: true });
  try {
    raw.exec(`DROP TABLE "_auth_activity"`);
  } finally {
    raw.close();
  }

  const post = await req(owner.cookie, "POST", R, { name: "机" });
  expect(post.status).toBe(201);

  const store = AuthStore.openForApp(dataRoot, APP_ID);
  try {
    expect(store.listActivity()).toHaveLength(1);
  } finally {
    store.close();
  }
});

// --- register / login のロール判定 ------------------------------------------------

async function register(username: string): Promise<Response> {
  return app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/auth/password/register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: TEST_ORIGIN },
      body: JSON.stringify({ username, password: "pw123456" }),
    }),
  );
}

test("register: 初回ユーザは owner、2人目以降は viewer", async () => {
  const first = await register("alice");
  expect(first.status).toBe(200);
  expect(((await first.json()) as { user: { role: Role } }).user.role).toBe("owner");

  const second = await register("bob");
  expect(second.status).toBe(200);
  expect(((await second.json()) as { user: { role: Role } }).user.role).toBe("viewer");
});

test("login: owner=0 の DB を self-heal(最古を owner に復活)", async () => {
  await register("alice"); // owner
  await register("bob"); // viewer

  // 手で全員 viewer に落とす(owner=0 の壊れた状態を作る)。
  const raw = new Database(appSqlitePath(dataRoot, APP_ID), { readwrite: true });
  try {
    raw.exec(`UPDATE "_auth_users" SET "role" = 'viewer'`);
  } finally {
    raw.close();
  }

  const login = await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/auth/password/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: TEST_ORIGIN },
      body: JSON.stringify({ username: "alice", password: "pw123456" }),
    }),
  );
  expect(login.status).toBe(200);

  const store = AuthStore.openForApp(dataRoot, APP_ID);
  try {
    // 最古(alice)が owner に復活している。
    const alice = store.findUserByUsername("alice");
    expect(alice?.role).toBe("owner");
    expect(store.countOwners()).toBe(1);
  } finally {
    store.close();
  }
});

test("GET /auth/me は role を含む", async () => {
  const owner = seed("owner");
  const me = await req(owner.cookie, "GET", `/api/apps/${APP_ID}/auth/me`);
  expect(me.status).toBe(200);
  const body = (await me.json()) as { user: { id: string; role: Role } };
  expect(body.user).toMatchObject({ id: owner.userId, role: "owner" });
});
