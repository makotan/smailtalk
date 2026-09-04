/**
 * **定義を変える口と、役割を配る口を、役割の規則の判定へ寄せた**(`V8-M28` 第2波。
 * 台帳 `T-G15` / `T-G18` / `T-G20`。ユーザ決定 `D-V8-40` / `D-V8-41` / `D-V8-49` /
 * `D-V8-75` / `D-V8-76` / `D-V8-77`)。**本物の SQLite と実 HTTP で測る**(モックを置かない)。
 *
 * ## 何が変わったのか(**着手前の実測は `scratchpad/m28-before.md` §D / §E / §G**)
 *
 * - **着手前**: `POST /diffs` / `POST /undo` を止めていたのは `src/server/app.ts` の
 *   `if (!user.roles.includes("owner"))` という**役割名の等値1本**であり、
 *   **どんな規則をマニフェストに書いてもこの 403 は1ミリも動かなかった。**
 * - **着手前**: `PATCH .../auth/users/:user_id` と `GET .../auth/users` を止めていたのは
 *   `requireOwner`(`store.effectiveRoles(user.id).includes("owner")`)である。
 * - **今日**: どちらも `judgeRoleAccess`(`target: "app"` / `target: "role"`・動詞は `write`)
 *   1本が決める(`ADR-0305` 限定3 = **判定の家は1本**)。
 *
 * ## この検査が固定する完了条件(`V8-M28` の (i) と (v))
 *
 * - **「アプリの設定は変えられないが人を追加できる受付係」**(`reception`)——
 *   **`POST /diffs` = 403 / `PATCH .../auth/users/:user_id` = 200。**
 * - **その逆(`builder`)** —— **`POST /diffs` = 201 / `PATCH .../auth/users/:user_id` = 403。**
 *
 * ## この検査が測らないもの(**誇張しない**)
 *
 * - **ブラウザを1度も開いていない**(`web/` の利用者管理画面の挙動は測っていない)。
 * - **MCP を1度も呼んでいない。**
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Role } from "../auth/types.ts";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN } from "./test-helpers.ts";

const APP_ID = "shop";

/**
 * 題材。**5つの役割を宣言する**:
 *  - `owner` … **`app`+`write` と `role`+`write` の2行**(既定。適用時検査が要求する)。
 *  - `editor` / `viewer` … 表の規則だけ。**定義も配布も持たない。**
 *  - `reception`(受付係) … **`role`+`write` だけ**(人は配れるが設定は変えられない)。
 *  - `builder`(設定係) … **`app`+`write` だけ**(設定は変えられるが人は配れない)。
 */
function shopManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "商店",
      // **【`V8-M29` 第2波】旧(逐語)**: `user_kinds: [{ id: "reception", name: "受付係" }, { id: "builder", name: "設定係" }],`
      // **語彙 `app.user_kinds` は廃止された** —— **代わりに立つのは `app.roles`
      // (差分操作 `set_roles`)であり、`reception` / `builder` は下の `roles` に
      // 既に1本ずつ立っている**(置き換え先はそこである)。
      tables: [
        {
          id: "memo",
          name: "メモ",
          fields: [{ id: "title", name: "題名", type: "text" }],
        },
      ],
      views: [],
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            { target: "table", table: "memo", can: ["read", "write", "delete"] },
          ],
        },
        {
          id: "editor",
          name: "編集者",
          rules: [{ target: "table", table: "memo", can: ["read", "write"] }],
        },
        {
          id: "viewer",
          name: "閲覧者",
          rules: [{ target: "table", table: "memo", can: ["read"] }],
        },
        { id: "reception", name: "受付係", rules: [{ target: "role", can: ["write"] }] },
        { id: "builder", name: "設定係", rules: [{ target: "app", can: ["write"] }] },
      ],
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-m28-wave2-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "商店", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, shopManifest()).valid).toBe(true);
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

const DIFFS = `/api/apps/${APP_ID}/diffs`;
const UNDO = `/api/apps/${APP_ID}/undo`;
const USERS = `/api/apps/${APP_ID}/auth/users`;
const ACTIVITY = `/api/apps/${APP_ID}/auth/activity`;

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

function seed(role: Role, grants: readonly Role[] = [], username?: string) {
  return seedSession(dataRoot, APP_ID, {
    role,
    grants,
    ...(username === undefined ? {} : { username }),
  });
}

/** 表を1つ足す差分(`POST /diffs` に通せる本物)。 */
function addTableDiff(id: string): unknown {
  return {
    diff_id: `d-${id}`,
    intent: "表を1つ足す",
    operations: [
      {
        op: "add_table",
        table: { id, name: "追加した表", fields: [{ id: "title", name: "題名", type: "text" }] },
      },
    ],
  };
}

/** 題材のマニフェストの、ある役割の規則を丸ごと差し替える(applyManifest で直に入れる)。 */
function replaceRules(roleId: string, rules: readonly unknown[]): void {
  const next = shopManifest() as unknown as {
    app: { roles: { id: string; name?: unknown; rules?: unknown[] }[] };
  };
  const index = next.app.roles.findIndex((role) => role.id === roleId);
  if (index < 0) {
    throw new Error(`役割 "${roleId}" が題材に無い`);
  }
  const target = next.app.roles[index] as { id: string; name?: unknown; rules?: unknown[] };
  // **規則が0本のときは `rules` というキーごと持たない宣言に差し替える**
  // (**「規則を1本も書いていない役割」を作りたい**)。
  next.app.roles[index] =
    rules.length === 0
      ? { id: target.id, name: target.name as string }
      : { id: target.id, name: target.name as string, rules: [...rules] };
  expect(applyManifest(dataRoot, APP_ID, next as unknown as Manifest).valid).toBe(true);
}

// ---------------------------------------------------------------------------
// (1) `T-G15` —— 定義を変える口(`POST /diffs` / `POST /undo`)
// ---------------------------------------------------------------------------

test("(1-1) `POST /diffs` は `owner` が通る", async () => {
  const owner = seed("owner");
  expect((await req(owner.cookie, "POST", DIFFS, addTableDiff("t1"))).status).toBe(201);
});

test("(1-2) `POST /diffs` は `app`+`write` だけを持つ非 owner の役割の人が通る", async () => {
  const builder = seed("builder");
  // **役割の綴りは `owner` ではない。** **通しているのは規則である。**
  expect(builder.roles).toEqual(["builder"]);
  expect((await req(builder.cookie, "POST", DIFFS, addTableDiff("t2"))).status).toBe(201);
});

test("(1-3) その規則を外すと `POST /diffs` は 403 になる", async () => {
  const builder = seed("builder");
  replaceRules("builder", []);
  const denied = await req(builder.cookie, "POST", DIFFS, addTableDiff("t3"));
  expect(denied.status).toBe(403);
  const body = (await denied.json()) as { errors?: { allowed_values?: unknown }[] };
  // **役割の綴りを焼き込んでいない**(誰が通るかは規則で決まる)。
  expect(body.errors?.[0]?.allowed_values).toBeUndefined();
});

test("(1-4) `editor` は `POST /diffs` が 403", async () => {
  const editor = seed("editor");
  expect((await req(editor.cookie, "POST", DIFFS, addTableDiff("t4"))).status).toBe(403);
});

test("(1-5) 未認証の `POST /diffs` は今日どおり 401", async () => {
  expect((await req(undefined, "POST", DIFFS, addTableDiff("t5"))).status).toBe(401);
});

test("(1-6) `POST /undo` も同じ4本(owner / 規則を持つ人 / 規則を外す / editor / 未認証)", async () => {
  const owner = seed("owner");
  expect((await req(owner.cookie, "POST", DIFFS, addTableDiff("u1"))).status).toBe(201);

  // owner は通る。
  expect((await req(owner.cookie, "POST", UNDO, {})).status).toBe(200);

  // `app`+`write` だけの人も通る。
  expect((await req(owner.cookie, "POST", DIFFS, addTableDiff("u2"))).status).toBe(201);
  const builder = seed("builder");
  expect((await req(builder.cookie, "POST", UNDO, {})).status).toBe(200);

  // `editor` は 403 / 未認証は 401。
  const editor = seed("editor");
  expect((await req(editor.cookie, "POST", UNDO, {})).status).toBe(403);
  expect((await req(undefined, "POST", UNDO, {})).status).toBe(401);

  // 規則を外すと 403。
  //
  // **【実測。隠さない】** **`POST /undo` は `app.sqlite` を丸ごと巻き戻すので、
  // スナップショットより後に作ったセッションは消える**(上の `builder` の cookie は、
  // 自分で撃った undo によって無効になった —— **同じ cookie で再度叩くと 401 である**)。
  // **したがって規則を外したあとの判定は、作り直した人で測る。**
  replaceRules("builder", []);
  const builderAgain = seed("builder", [], "builder-again");
  expect((await req(builderAgain.cookie, "POST", UNDO, {})).status).toBe(403);
});

// ---------------------------------------------------------------------------
// (2) `T-G18` + `T-G20` —— 役割を配る口(`PATCH .../auth/users/:user_id`)
// ---------------------------------------------------------------------------

test("(2-1) `role`+`write` を持つ人は他人の役割を変えられる(200)", async () => {
  const reception = seed("reception", [], "reception-1");
  const member = seed("viewer", [], "member-1");
  const res = await req(reception.cookie, "PATCH", `${USERS}/${member.userId}`, {
    roles: ["editor"],
  });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { user: { roles: Role[] } }).user.roles).toEqual(["editor"]);
});

test("(2-2) `role`+`write` を持たない人は 403", async () => {
  const builder = seed("builder", [], "builder-2");
  const member = seed("viewer", [], "member-2");
  expect(
    (await req(builder.cookie, "PATCH", `${USERS}/${member.userId}`, { roles: ["editor"] })).status,
  ).toBe(403);
});

test("(2-3) 自分自身を対象にすると 403(`D-V8-76`)", async () => {
  const reception = seed("reception", [], "reception-3");
  const res = await req(reception.cookie, "PATCH", `${USERS}/${reception.userId}`, {
    roles: ["editor"],
  });
  expect(res.status).toBe(403);
  const body = (await res.json()) as { errors?: { message?: string }[] };
  expect(body.errors?.[0]?.message).toContain("自分自身");

  // **持ち主も同じである**(着手前は自由に書き換えられた。実測は §G-4)。
  const owner = seed("owner", [], "owner-3");
  expect(
    (await req(owner.cookie, "PATCH", `${USERS}/${owner.userId}`, { roles: ["owner"] })).status,
  ).toBe(403);
});

test("(2-4) `owner` を持たない人が誰かに `owner` を配ろうとすると 403(`D-V8-75`)", async () => {
  const reception = seed("reception", [], "reception-4");
  const member = seed("viewer", [], "member-4");
  const res = await req(reception.cookie, "PATCH", `${USERS}/${member.userId}`, {
    roles: ["owner"],
  });
  expect(res.status).toBe(403);
  const body = (await res.json()) as { errors?: { message?: string }[] };
  expect(body.errors?.[0]?.message).toContain("owner");

  // `role`(列の1値)で配ろうとしても同じ。
  expect(
    (await req(reception.cookie, "PATCH", `${USERS}/${member.userId}`, { role: "owner" })).status,
  ).toBe(403);
});

test("(2-5) `owner` を持たない人が `viewer` を配るのは通る(`D-V8-75` は `owner` だけを止める)", async () => {
  const reception = seed("reception", [], "reception-5");
  const member = seed("editor", [], "member-5");
  const res = await req(reception.cookie, "PATCH", `${USERS}/${member.userId}`, {
    roles: ["viewer"],
  });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { user: { roles: Role[] } }).user.roles).toEqual(["viewer"]);

  // 独自の役割(受付係)も配れる。
  expect(
    (await req(reception.cookie, "PATCH", `${USERS}/${member.userId}`, { roles: ["reception"] }))
      .status,
  ).toBe(200);
});

test("(2-6) `owner` が他人に `owner` を配るのは通る", async () => {
  const owner = seed("owner", [], "owner-6");
  const member = seed("viewer", [], "member-6");
  const res = await req(owner.cookie, "PATCH", `${USERS}/${member.userId}`, { roles: ["owner"] });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { user: { roles: Role[] } }).user.roles).toEqual(["owner"]);
});

test("(2-7) 最後の owner の 409 は1バイトも動いていない", async () => {
  const owner = seed("owner", [], "owner-7");
  const second = seed("owner", [], "owner-7b");
  // 2人目の owner を降格する(自分ではないので通る)。**残り1人になる。**
  expect(
    (await req(owner.cookie, "PATCH", `${USERS}/${second.userId}`, { roles: ["viewer"] })).status,
  ).toBe(200);
  // その後、最後の owner(自分)は `D-V8-76` で 403(自己書換の側が先に止める)。
  expect(
    (await req(owner.cookie, "PATCH", `${USERS}/${owner.userId}`, { roles: ["viewer"] })).status,
  ).toBe(403);
  // **別の owner から降ろすと 409**(`LastOwnerError`。ここは今日どおり)。
  const reception = seed("reception", [], "reception-7");
  expect(
    (await req(reception.cookie, "PATCH", `${USERS}/${owner.userId}`, { roles: ["viewer"] }))
      .status,
  ).toBe(409);
});

// ---------------------------------------------------------------------------
// (3) `D-V8-77` —— 人と役割の一覧(`GET .../auth/users`)
// ---------------------------------------------------------------------------

test("(3-1) `role`+`write` を持つ人は一覧を読める(200)", async () => {
  const reception = seed("reception", [], "reception-8");
  const res = await req(reception.cookie, "GET", USERS);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { users: unknown[] }).users.length).toBeGreaterThan(0);
});

test("(3-2) `role`+`write` を持たない人は一覧が 403", async () => {
  const builder = seed("builder", [], "builder-9");
  expect((await req(builder.cookie, "GET", USERS)).status).toBe(403);
  const editor = seed("editor", [], "editor-9");
  expect((await req(editor.cookie, "GET", USERS)).status).toBe(403);
  expect((await req(undefined, "GET", USERS)).status).toBe(401);
});

// ---------------------------------------------------------------------------
// (4) 完了条件 (i)(v) —— 2つを別々に書けること
// ---------------------------------------------------------------------------

test("(4-1) 設定は変えられないが人を追加できる受付係(`POST /diffs` = 403 / `PATCH` = 200)", async () => {
  const reception = seed("reception", [], "reception-10");
  const member = seed("viewer", [], "member-10");
  expect((await req(reception.cookie, "POST", DIFFS, addTableDiff("r10"))).status).toBe(403);
  expect(
    (await req(reception.cookie, "PATCH", `${USERS}/${member.userId}`, { roles: ["editor"] }))
      .status,
  ).toBe(200);
});

test("(4-2) その逆(`app`+`write` だけの役割は `POST /diffs` = 201 / `PATCH` = 403)", async () => {
  const builder = seed("builder", [], "builder-11");
  const member = seed("viewer", [], "member-11");
  expect((await req(builder.cookie, "POST", DIFFS, addTableDiff("b11"))).status).toBe(201);
  expect(
    (await req(builder.cookie, "PATCH", `${USERS}/${member.userId}`, { roles: ["editor"] })).status,
  ).toBe(403);
});

// ---------------------------------------------------------------------------
// (5) 触らなかった8箇所の `requireOwner` は今日どおり `owner` を要求し続ける
// ---------------------------------------------------------------------------

test("(5-1) `GET .../auth/activity` は `role`+`write` を持つだけの人に 403 を返し続ける", async () => {
  const reception = seed("reception", [], "reception-12");
  const res = await req(reception.cookie, "GET", ACTIVITY);
  expect(res.status).toBe(403);
  // **止めているのは `requireOwner` である**(文面が `owner` を名指ししたままであることで見る)。
  const body = (await res.json()) as { errors?: { allowed_values?: string[] }[] };
  expect(body.errors?.[0]?.allowed_values).toEqual(["owner"]);

  // 持ち主は今日どおり読める。
  const owner = seed("owner", [], "owner-12");
  expect((await req(owner.cookie, "GET", ACTIVITY)).status).toBe(200);
});
