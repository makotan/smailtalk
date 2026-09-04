/**
 * **「人に役割を配れる人が0人」を、役割の規則の外側で数え直す**(`V8-M30`。台帳 `T-G29`
 * = **限定採用**。ユーザ決定 `D-V8-47`)。**実 HTTP の検査。**
 *
 * ## 固定する規則
 *
 * > **`countOwners()`(`'owner'` という綴りの役割を持つ人の数)を1バイトも変えない。**
 * > **その隣に「`role` + `write` を持つ役割を実効ロール集合に持つ人の数」を数える2本目を
 * > 立て、どちらか一方でも 0人 になる操作を拒否する**(`AND` にしない)。
 *
 * ## この検査が測らないもの(**誇張しない。先に書く**)
 *
 * 1. **`undo` を1度も呼んでいない。** **巻き戻しがこの2本を迂回できるかどうかは、
 *    本ファイルは1件も測っていない**(`D-V8-51` = 実測して記録するだけ。塞がない)。
 *    **迂回の実測は `V8-M30` の (iv) が `curl` で行う。**
 * 2. **MCP を1度も呼んでいない。** **`src/mcp/tools/write.ts` はカーネルを直接叩くので、
 *    本ファイルが測る 409 は MCP 経由では1度も掛からない。**
 * 3. **`PATCH .../auth/users/:user_id` で「配れる人が0人になる」経路を1件も作れていない** ——
 *    **その口を叩けるのは配れる人だけであり、その人は `D-V8-76` により自分自身を書き換え
 *    られないので、要求が通ったあとも配れる人が最低1人(要求者自身)残る。**
 *    **本ファイルはこの構造的な事実を、退会(`DELETE .../auth/me`)の側で測っている。**
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN } from "./test-helpers.ts";

const APP_ID = "frontdesk";

/**
 * **題材**: **配れる役割が2つある** —— **`owner`(既定。`T-G16a` により2行は抜けない)と
 * `desk`(手で宣言。定義も変えられるし、人に役割も配れる)。**
 */
function manifest(deskCanGrant: boolean): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "受付",
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
          rules: deskCanGrant
            ? [
                { target: "app", can: ["write"] },
                { target: "role", can: ["write"] },
              ]
            : [{ target: "app", can: ["write"] }],
        },
      ],
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-grant-lockout-http-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "受付", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, manifest(true)).valid).toBe(true);
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

/** `desk` から `role` + `write` を抜く差分(= 配れる役割を `owner` だけにする)。 */
function dropDeskGrant(): unknown {
  const roles = (manifest(false) as unknown as { app: { roles: unknown[] } }).app.roles;
  return {
    diff_id: "d-drop-desk-grant",
    intent: "受付から役割の配布を外す",
    operations: [{ op: "set_roles", roles }],
  };
}

// ---------------------------------------------------------------------------
// (1) **配れる人が0人になる `set_roles` が拒否される**(新しい不変条件)
// ---------------------------------------------------------------------------

test("(1) 配れる人が0人になる `set_roles` は 409 で拒否される", async () => {
  // **持ち主は0人である** —— **`owner` を持つ人が1人も居ないので、`countOwners()` は
  // 1件も止めない。****配れるのは `desk` を持つ alice だけである。**
  const alice = seedSession(dataRoot, APP_ID, { role: "desk", username: "alice" });
  seedSession(dataRoot, APP_ID, { role: "viewer", username: "bob" });

  const rejected = await req(alice.cookie, "POST", `/api/apps/${APP_ID}/diffs`, dropDeskGrant());
  expect(rejected.status).toBe(409);
  const body = (await rejected.json()) as { errors: { message: string }[] };
  expect(body.errors[0]?.message).toContain("役割を配れる人が0人");

  // **拒否されたのだから、定義は1バイトも変わっていない。**
  const manifestResponse = await req(alice.cookie, "GET", `/api/apps/${APP_ID}/manifest`);
  expect(manifestResponse.status).toBe(200);
  const current = (await manifestResponse.json()) as {
    app: { roles: { id: string; rules?: { target: string }[] }[] };
  };
  const desk = current.app.roles.find((role) => role.id === "desk");
  expect(desk?.rules?.some((rule) => rule.target === "role")).toBe(true);
});

test("(1 の対照) 配れる人が残る `set_roles` は今日どおり 201 で通る", async () => {
  const alice = seedSession(dataRoot, APP_ID, { role: "desk", username: "alice" });
  // **持ち主を1人置く** —— **`owner` は `role` + `write` を持つので、`desk` から抜いても
  // 配れる人は0人にならない。**
  seedSession(dataRoot, APP_ID, { role: "owner", username: "carol" });

  const applied = await req(alice.cookie, "POST", `/api/apps/${APP_ID}/diffs`, dropDeskGrant());
  expect(applied.status).toBe(201);
});

// ---------------------------------------------------------------------------
// (2) **持ち主が0人になる操作は今日どおり拒否される**(既存の `LastOwnerError` の 409)
// ---------------------------------------------------------------------------

test("(2) 最後の持ち主の降格は今日どおり 409(`LastOwnerError`。1バイトも変えていない)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner", username: "alice" });
  const desk = seedSession(dataRoot, APP_ID, { role: "desk", username: "carol" });

  // **配る口を叩けるのは `desk` も同じである**(`role` + `write` を持つ)。
  const response = await req(
    desk.cookie,
    "PATCH",
    `/api/apps/${APP_ID}/auth/users/${owner.userId}`,
    { roles: ["viewer"] },
  );
  expect(response.status).toBe(409);
  const body = (await response.json()) as { errors: { message: string }[] };
  expect(body.errors[0]?.message).toBe("最後の owner は降格できません。");
});

// ---------------------------------------------------------------------------
// (3) **2本は `AND` ではない** —— 片方だけ0になる操作も拒否される。2方向とも固定する
// ---------------------------------------------------------------------------

test("(3-a) 方向1: 持ち主が0人になるが配れる人は残る —— それでも 409", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner", username: "alice" });
  const desk = seedSession(dataRoot, APP_ID, { role: "desk", username: "carol" });

  // **alice を降ろしても、`desk` の carol が配れる人として残る**(配れる人は1人)。
  // **`AND`(両方が0のときだけ拒否)なら通ってしまう。**
  const response = await req(
    desk.cookie,
    "PATCH",
    `/api/apps/${APP_ID}/auth/users/${owner.userId}`,
    { roles: ["viewer"] },
  );
  expect(response.status).toBe(409);
});

test("(3-b) 方向2: 配れる人が0人になるが持ち主の数は変わらない —— それでも 409", async () => {
  // **持ち主は0人のままである**(この操作は `countOwners()` を1ミリも動かさない)。
  const alice = seedSession(dataRoot, APP_ID, { role: "desk", username: "alice" });
  seedSession(dataRoot, APP_ID, { role: "viewer", username: "bob" });

  // **退会** —— **配れる人が alice しか居ないので、抜けると0人になる。**
  const response = await req(alice.cookie, "DELETE", `/api/apps/${APP_ID}/auth/me`);
  expect(response.status).toBe(409);
  const body = (await response.json()) as { errors: { message: string }[] };
  expect(body.errors[0]?.message).toContain("役割を配れる人が0人");

  // **拒否されたのだから、alice はまだ居る。**
  const me = await req(alice.cookie, "GET", `/api/apps/${APP_ID}/auth/me`);
  expect(me.status).toBe(200);
});

// ---------------------------------------------------------------------------
// (4) **回復経路を塞がない** —— 既に0人の状態では、2本目は1件も止めない
// ---------------------------------------------------------------------------

test("(4) 配れる人が既に0人のアプリでは、2本目は1件も止めない", async () => {
  // **`desk` から配布を外した定義を最初から当てる** —— **`owner` を持つ人も居ない。**
  expect(applyManifest(dataRoot, APP_ID, manifest(false)).valid).toBe(true);
  const alice = seedSession(dataRoot, APP_ID, { role: "desk", username: "alice" });

  // **配れる人は0人である。** **それでも定義は変えられる**(`desk` は `app` + `write` を持つ)。
  const applied = await req(alice.cookie, "POST", `/api/apps/${APP_ID}/diffs`, {
    diff_id: "d-noop-roles",
    intent: "役割の宣言をそのまま書き直す",
    operations: [
      {
        op: "set_roles",
        roles: (manifest(false) as unknown as { app: { roles: unknown[] } }).app.roles,
      },
    ],
  });
  expect(applied.status).toBe(201);

  // **退会も止められない** —— **0人 → 0人 は「0人にする操作」ではない。**
  const withdrawn = await req(alice.cookie, "DELETE", `/api/apps/${APP_ID}/auth/me`);
  expect(withdrawn.status).toBe(200);
});
