/**
 * **アプリの最初の1人は、自分で登録した場合も必ず持ち主になる**(`V8-M30` の第2波。
 * ユーザ決定 **`D-V8-82`**)。**実 HTTP の検査。**
 *
 * ## 固定する規則
 *
 * > **自己登録の経路(`healOwner: false`)でも、そのアプリの最初の1人は持ち主になる。**
 * > **名乗った役割は消さず、持ち主に**足す**。** **2人目以降は今日どおり(名乗った役割だけ)。**
 *
 * **`D-V8-82` の選ばれた説明文の逐語**:
 *
 * > 「自分で登録した場合でも、そのアプリの最初の1人は持ち主になります。名乗った役割は
 * >  それに足されます。**公開の購入サイトでは、最初に買った客が運営者になってしまいます。**」
 *
 * ## この検査が主張しないもの(**誇張しない。先に書く**)
 *
 * 1. **「安全になった」とは1文字も主張しない。** **塞いだのは「持ち主0人」であって、
 *    「持ち主でない人が持ち主になる」ことではない** —— **後者は本決定が**新しく作る**。**
 *    **本ファイルの (5) は、まさにその新しい帰結を検査で固定している。**
 * 2. **役割を1つも宣言していないアプリの締め出しは、今日も残る**(`D-V8-81` = そのままにする)。
 *    **本ファイルはそれを1件も直していない。**
 * 3. **`undo` の迂回を1ミリも塞いでいない**(`D-V8-51`)。**本ファイルは `undo` を1度も呼ばない。**
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "../auth/store.ts";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { TEST_ORIGIN } from "./test-helpers.ts";

const APP_ID = "storefront";

/** **`desk`(配れる)と `builder`(配れない)の2つの独自役割を宣言した題材。** */
function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "売り場",
      tables: [],
      views: [],
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
          ],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
        {
          id: "desk",
          name: "受付",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
          ],
        },
        { id: "builder", name: "組み立て係", rules: [{ target: "app", can: ["write"] }] },
      ],
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-first-user-owner-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "売り場", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, manifest()).valid).toBe(true);
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function post(path: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { origin: TEST_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );
}

type UserBody = { user: { id: string; role: string; roles: string[] } };

/** **そのアプリの `countOwners()`**(判定を1つも注入しない素の接続で数える)。 */
function countOwners(): number {
  const store = AuthStore.openForApp(dataRoot, APP_ID);
  try {
    return store.countOwners();
  } finally {
    store.close();
  }
}

const SELF = `/api/apps/${APP_ID}/auth/signup/password/register`;
const ADMIN = `/api/apps/${APP_ID}/auth/password/register`;

// ---------------------------------------------------------------------------
// (1) 自己登録の最初の1人は、独自の役割を名乗っても持ち主になる
// ---------------------------------------------------------------------------

test("(1) 自己登録の最初の1人は `builder` を名乗っても持ち主になる(`countOwners()` = 1)", async () => {
  expect(countOwners()).toBe(0);

  const response = await post(SELF, {
    username: "grace",
    password: "correct-horse-battery-7",
    user_kind: "builder",
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as UserBody;

  // **【`V8-M30` 第2波 / `D-V8-82`。旧の挙動を逐語で残す】**
  // **旧**: `{"user":{"username":"grace","role":"builder","roles":["builder"]}}` /
  //         `countOwners() = 0`(**セルフ登録の経路は `healOwner: false` で、
  //         `ensureOwnerExists` を1度も呼ばなかった**)。
  expect(countOwners()).toBe(1);
  expect(body.user.role).toBe("owner");
});

// ---------------------------------------------------------------------------
// (2) 名乗った役割が消えていない(実効ロール集合に両方が入る)
// ---------------------------------------------------------------------------

test("(2) 名乗った役割は消えず、持ち主に**足される**(実効ロール集合に両方)", async () => {
  const response = await post(SELF, {
    username: "grace",
    password: "correct-horse-battery-7",
    user_kind: "builder",
  });
  const body = (await response.json()) as UserBody;

  expect([...body.user.roles].sort()).toEqual(["builder", "owner"]);
  // **列に据えたのは `owner` である**(決めた向き。理由は実装の doc に書いた)。
  expect(body.user.role).toBe("owner");

  // **付与表の側に `builder` が在る**(列と表の両方を見て初めて2つになる)。
  const store = AuthStore.openForApp(dataRoot, APP_ID);
  try {
    expect(store.roleGrants(body.user.id)).toEqual(["builder"]);
    expect([...store.effectiveRoles(body.user.id)].sort()).toEqual(["builder", "owner"]);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// (3) 2人目以降は持ち主にならない(今日どおり)
// ---------------------------------------------------------------------------

test("(3) 自己登録の2人目は名乗った役割だけで、持ち主にならない", async () => {
  await post(SELF, {
    username: "grace",
    password: "correct-horse-battery-7",
    user_kind: "builder",
  });
  expect(countOwners()).toBe(1);

  const second = await post(SELF, {
    username: "mallory",
    password: "correct-horse-battery-11",
    user_kind: "builder",
  });
  expect(second.status).toBe(200);
  const body = (await second.json()) as UserBody;

  expect(body.user.role).toBe("builder");
  expect(body.user.roles).toEqual(["builder"]);
  // **持ち主は増えていない。**
  expect(countOwners()).toBe(1);
});

test("(3-b) 管理経路で1人目が作られたあとは、自己登録の1人目も持ち主にならない", async () => {
  const first = await post(ADMIN, { username: "alice", password: "correct-horse-battery-1" });
  expect(((await first.json()) as UserBody).user.role).toBe("owner");

  const self = await post(SELF, {
    username: "grace",
    password: "correct-horse-battery-7",
    user_kind: "builder",
  });
  const body = (await self.json()) as UserBody;
  expect(body.user.role).toBe("builder");
  expect(body.user.roles).toEqual(["builder"]);
  expect(countOwners()).toBe(1);
});

// ---------------------------------------------------------------------------
// (4) 管理経路(`healOwner: true`)の今日の挙動は1バイトも変わっていない
// ---------------------------------------------------------------------------

test("(4) 管理経路は今日どおり(1人目 `owner` / 2人目 `viewer`。付与は0件)", async () => {
  const first = await post(ADMIN, { username: "alice", password: "correct-horse-battery-1" });
  expect(first.status).toBe(200);
  const firstBody = (await first.json()) as UserBody;
  expect(firstBody.user.role).toBe("owner");
  expect(firstBody.user.roles).toEqual(["owner"]);

  const second = await post(ADMIN, { username: "bob", password: "correct-horse-battery-2" });
  expect(second.status).toBe(200);
  const secondBody = (await second.json()) as UserBody;
  expect(secondBody.user.role).toBe("viewer");
  expect(secondBody.user.roles).toEqual(["viewer"]);

  // **管理経路は付与表へ1行も書かない**(`D-V8-82` は自己登録の経路にだけ効く)。
  const store = AuthStore.openForApp(dataRoot, APP_ID);
  try {
    expect(store.roleGrants(firstBody.user.id)).toEqual([]);
    expect(store.roleGrants(secondBody.user.id)).toEqual([]);
  } finally {
    store.close();
  }
  expect(countOwners()).toBe(1);
});

// ---------------------------------------------------------------------------
// (5) `m30-api.md` §C-3 の「持ち主0人・配れる人0人」が作れなくなった
//     —— **同時に、`D-V8-82` が新しく作る帰結もここで固定する**
// ---------------------------------------------------------------------------

test("(5) `curl` 3本で作れていた「持ち主0人・配れる人0人」が、今日は作れない", async () => {
  // **`m30-api.md` §C-3 と同じ経路**(セルフ登録で `builder` を名乗る)。
  const response = await post(SELF, {
    username: "grace",
    password: "correct-horse-battery-7",
    user_kind: "builder",
  });
  expect(response.status).toBe(200);

  // **旧(`m30-api.md` §C-3 の実測。逐語)**:
  //   `{"user":{ … "role":"builder","roles":["builder"]}}` / `countOwners = 0` /
  //   `GET .../auth/users` → **403**(「利用者の一覧を見られるのは、人に役割を配れる人だけです。」)
  expect(countOwners()).toBe(1);

  const cookie = response.headers.get("set-cookie") ?? "";
  const users = await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/auth/users`, {
      headers: { origin: TEST_ORIGIN, cookie },
    }),
  );
  // **配れる人が1人(この人自身)居るので、一覧が見える。**
  expect(users.status).toBe(200);

  // =====================================================================================
  // **【`D-V8-82` が新しく作る帰結を、ここで固定する。丸めない】**
  // **選ばれた説明文の逐語**: 「**公開の購入サイトでは、最初に買った客が運営者に
  // なってしまいます。**」
  // **買い物客のつもりで登録した最初の1人が、アプリの設定を変えられ、人に役割を配れる。**
  // =====================================================================================
  const diffWithCookie = await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/diffs`, {
      method: "POST",
      headers: { origin: TEST_ORIGIN, "content-type": "application/json", cookie },
      body: JSON.stringify({
        diff_id: "d-by-first-customer",
        intent: "最初に登録した人がアプリの定義を変える",
        operations: [
          {
            op: "add_table",
            table: {
              id: "memos",
              name: "メモ",
              fields: [{ id: "body", name: "本文", type: "text" }],
            },
          },
        ],
      }),
    }),
  );
  // **通る。** **「安全になった」とは書けない。**
  expect(diffWithCookie.status).toBe(201);
});
