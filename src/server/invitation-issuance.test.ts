/**
 * **招待を運営者が発行・取り消し・出し直しできる口**(`V8-M2-T04` / `V8-M2-T05`。
 * 台帳 `I-G9` / `I-G12` / `I-G13` / `I-G17` / `I-G18`。`ADR-0336`)。
 *
 * ## この検査の作り方(**TDD である**)
 *
 * **先にこのファイルを書き、赤を見てから `src/server/auth-routes.ts` に口を1本足した。**
 *
 * ## 何を測るのか
 *
 * - **(1) 発行** —— **owner が発行でき、応答にコードと登録リンクが載る**(`D-V8-8` / `I-G13`)。
 * - **(2) 関門は `requireOwner`**(`ADR-0336` 限定8。**10箇所目**)——
 *   **editor 403 / viewer 403 / 未認証 401 / アプリ不在 404。**
 *   **`requireRoleDistribution` は着手前と同じ2箇所のままである**(同 限定8 の機械的検査)。
 * - **(3) 取り消しと出し直しは、この1本の `POST` の**引数**で表す**(`ADR-0336` 限定5 / 限定18)——
 *   **同じパスに `GET` / `DELETE` / `PATCH` は1本も無い(404)。**
 * - **(4) 期限は24時間固定で、外から受け取る経路が1本も無い**(同 限定14)。
 * - **(5) 掃除**(同 限定19)—— **発行の処理の冒頭で、招待の掃除と既存の
 *   `purgeExpired()` を**同じ点で**呼ぶ。**
 * - **(6) 見せる先は2箇所だけ**(同 限定12)—— **発行の応答本文と、既存の
 *   `GET /api/apps/:app_id/auth/users` の応答。** **コードは `_auth_activity` に1バイトも
 *   書かない**(同 限定11)。
 *
 * ## **【`V8-M2` の時点では、この招待を引き換える経路がまだ無い】**
 *
 * **発行・保管・取り消し・一覧・掃除まではできるが、その招待を使って登録する道は `V8-M3` が
 * 作る。** **すなわち今日在るのは「使えない招待を出せる状態」である。**
 * **【禁止】この中間状態を「一時的だから問題ない」と書かない。**
 *
 * ## **【2026-08-14 訂正(`V8-M4-T03`。裁定 `M4-3`)。上の節を1バイトも消していない】**
 *
 * **上の節は今日は偽である。** **`V8-M3` が引き換えの経路を作った**(検査は
 * `src/server/invitation-redemption.test.ts`)。 **同型の嘘を `V8-M4` が3ファイル
 * (`src/server/auth-routes.ts` / `src/auth/invitations.ts` / `src/auth/store.ts`)で
 * 直しており、本ファイルはその4本目である。**
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAuthConfig } from "../auth/config.ts";
import { AuthStore, INVITATION_CODE_ALPHABET } from "../auth/store.ts";
import type { Manifest } from "../kernel/index.ts";
import { appDbPath, applyManifest, createApp, KernelMetaStore } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "invitation-app";
const ISSUE_PATH = `/api/apps/${APP_ID}/auth/invitations`;
const USERS_PATH = `/api/apps/${APP_ID}/auth/users`;

/** `src/`(`entry-point-inventory.test.ts` と同じ採り方)。 */
const SRC = join(import.meta.dir, "..");

function baseManifest(): Manifest {
  return withDefaultRoleRules({
    app: {
      id: APP_ID,
      name: "招待するアプリ",
      tables: [
        {
          id: "books",
          name: "本",
          fields: [{ id: "title", name: "タイトル", type: "text", required: true }],
        },
      ],
      views: [{ id: "book-list", type: "list_view", table: "books", columns: ["title"] }],
    },
  }) as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-invitation-http-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "招待するアプリ", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, baseManifest()).valid).toBe(true);
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

/** cookie + origin 付きリクエスト(`inbound-endpoint-issuance.test.ts` の `req` と同形)。 */
function req(
  cookie: string | undefined,
  method: string,
  path: string,
  body?: unknown,
  target: ReturnType<typeof createServerApp> = app,
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
  return Promise.resolve(target.request(new Request(`http://localhost${path}`, init)));
}

type InvitationView = {
  username: string;
  role: string;
  code: string;
  expiresAt: string;
  issuedBy: string;
  issuedAt: string;
  usedAt: string | null;
};

type IssuedBody = { invitation: InvitationView; signupUrl?: string };

/** `_auth_invitations` を本物の SQLite から直に読む(HTTP を通さない)。 */
function invitationRows(): { username: string; code: string; used_at: string | null }[] {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readonly: true });
  try {
    return db
      .query<{ username: string; code: string; used_at: string | null }, []>(
        `SELECT "username", "code", "used_at" FROM "_auth_invitations" ORDER BY "username"`,
      )
      .all();
  } finally {
    db.close();
  }
}

// --- (a) 発行 --------------------------------------------------------------------

test("(a) owner なら発行できる —— 応答にコードと登録リンクが載る", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const res = await req(owner.cookie, "POST", ISSUE_PATH, { username: "bob", role: "editor" });
  expect(res.status).toBe(200);
  const body = (await res.json()) as IssuedBody;

  expect(body.invitation.username).toBe("bob");
  expect(body.invitation.role).toBe("editor");
  expect(body.invitation.usedAt).toBeNull();
  expect(body.invitation.issuedBy).toBe(owner.userId);
  // **コードは8文字・32字表ちょうど**(`ADR-0336` 限定9)。
  expect(body.invitation.code).toHaveLength(8);
  for (const char of body.invitation.code) {
    expect(INVITATION_CODE_ALPHABET.includes(char)).toBe(true);
  }
  // **期限は発行時刻 + 24時間ちょうど**(`ADR-0336` 限定14)。
  expect(Date.parse(body.invitation.expiresAt) - Date.parse(body.invitation.issuedAt)).toBe(
    24 * 3600 * 1000,
  );
  // **登録リンクは `ST_AUTH_EXPECTED_ORIGIN` の先頭から組む**(同 限定13)。
  expect(body.signupUrl).toBe(`${loadAuthConfig(process.env).expectedOrigins[0]}/apps/${APP_ID}`);

  // 本物の行が1本できている。
  expect(invitationRows()).toHaveLength(1);
  expect(invitationRows()[0]?.code).toBe(body.invitation.code);
});

test("(a-2) `ST_AUTH_EXPECTED_ORIGIN` から組み立てられないときは、リンクを省いてコードだけ返す", async () => {
  // **黙って壊れたリンクを返さない**(憲法6。`ADR-0336` 限定13)。
  const noOrigin = createServerApp({
    dataRoot,
    authConfig: { ...loadAuthConfig(process.env), expectedOrigins: [] },
  });
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const res = await Promise.resolve(
    noOrigin.request(
      new Request(`http://localhost${ISSUE_PATH}`, {
        method: "POST",
        // **`origin` ヘッダを付けない** —— 期待 origin が空なので、付けると CSRF 検査が
        // 先に 403 を返してしまう(この検査が見たいのはリンクの有無である)。
        headers: { "content-type": "application/json", cookie: owner.cookie },
        body: JSON.stringify({ username: "bob", role: "editor" }),
      }),
    ),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as IssuedBody;
  expect(body.invitation.code).toHaveLength(8);
  expect(body.signupUrl).toBeUndefined();
});

// --- (b) 関門 = requireOwner -------------------------------------------------------

test("(b) owner でなければ発行できない(editor 403 / viewer 403 / 未認証 401)", async () => {
  const editor = seedSession(dataRoot, APP_ID, { role: "editor" });
  const viewer = seedSession(dataRoot, APP_ID, { role: "viewer" });

  const denied = await req(editor.cookie, "POST", ISSUE_PATH, { username: "bob", role: "editor" });
  expect(denied.status).toBe(403);
  // **止めているのは `requireOwner` である**(文面が `owner` を名指ししたまま)。
  const deniedBody = (await denied.json()) as { errors?: { allowed_values?: string[] }[] };
  expect(deniedBody.errors?.[0]?.allowed_values).toEqual(["owner"]);

  expect(
    (await req(viewer.cookie, "POST", ISSUE_PATH, { username: "bob", role: "editor" })).status,
  ).toBe(403);
  expect(
    (await req(undefined, "POST", ISSUE_PATH, { username: "bob", role: "editor" })).status,
  ).toBe(401);
  expect(invitationRows()).toHaveLength(0);
});

test("(b-2) 実在しないアプリは 404", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const res = await req(owner.cookie, "POST", "/api/apps/no-such-app/auth/invitations", {
    username: "bob",
    role: "editor",
  });
  expect(res.status).toBe(404);
});

test("(e) `requireRoleDistribution` の呼び出しは着手前と同じ2箇所のまま(`ADR-0336` 限定8)", () => {
  // **`ADR-0323` 限定3 の機械的検査そのものである** ——
  // `LC_ALL=C grep -c "requireRoleDistribution(c, store, appId" src/server/auth-routes.ts` = **2**。
  const source = readFileSync(join(SRC, "server", "auth-routes.ts"), "utf-8");
  const occurrences = source
    .split("\n")
    .filter((line) => line.includes("requireRoleDistribution(c, store, appId")).length;
  expect(occurrences).toBe(2);
  // **`requireOwner` は 9箇所 → 10箇所になった**(畳む向きとは逆に1本増やしている)。
  // **コメント行(旧の1行を逐語で残してある2箇所)を数えないために、行頭の字下げまで見る** ——
  // **素の `grep -c` は 12 を返す**(実測)。
  const owners = source
    .split("\n")
    .filter((line) => /^ +const owner = requireOwner\(c, store\);$/.test(line)).length;
  expect(owners).toBe(10);
});

// --- (c) 取り消し ------------------------------------------------------------------

test("(c) 取り消せる —— 行は消えず、使用時刻が入る(`ADR-0336` 限定16)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const issued = await req(owner.cookie, "POST", ISSUE_PATH, { username: "bob", role: "editor" });
  expect(issued.status).toBe(200);

  const revoked = await req(owner.cookie, "POST", ISSUE_PATH, { username: "bob", revoke: true });
  expect(revoked.status).toBe(200);
  const body = (await revoked.json()) as IssuedBody;
  expect(body.invitation.usedAt).not.toBeNull();
  // **行は残る**(`I-G13` の一覧から消えない)。
  expect(invitationRows()).toHaveLength(1);
  expect(invitationRows()[0]?.used_at).not.toBeNull();
});

test("(c-2) 実在しない相手の取り消しは 404(1件も作らない)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const res = await req(owner.cookie, "POST", ISSUE_PATH, { username: "nobody", revoke: true });
  expect(res.status).toBe(404);
  expect(invitationRows()).toHaveLength(0);
});

// --- (d) 出し直し ------------------------------------------------------------------

test("(d) 期限切れの前に出し直せる —— 行は1本のまま、コードが変わる(`ADR-0336` 限定18)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const first = (await (
    await req(owner.cookie, "POST", ISSUE_PATH, { username: "bob", role: "editor" })
  ).json()) as IssuedBody;
  const second = (await (
    await req(owner.cookie, "POST", ISSUE_PATH, { username: "bob", role: "viewer" })
  ).json()) as IssuedBody;

  expect(second.invitation.code).not.toBe(first.invitation.code);
  expect(second.invitation.role).toBe("viewer");
  expect(second.invitation.usedAt).toBeNull();
  // **同じ相手に有効な招待が2件同時に存在しない**(主キーで構造的に保証している)。
  expect(invitationRows()).toHaveLength(1);
  expect(invitationRows()[0]?.code).toBe(second.invitation.code);
});

test("(d-2) 取り消した相手にも出し直せる(使用時刻が空に戻る)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  await req(owner.cookie, "POST", ISSUE_PATH, { username: "bob", role: "editor" });
  await req(owner.cookie, "POST", ISSUE_PATH, { username: "bob", revoke: true });
  const again = (await (
    await req(owner.cookie, "POST", ISSUE_PATH, { username: "bob", role: "editor" })
  ).json()) as IssuedBody;
  expect(again.invitation.usedAt).toBeNull();
  expect(invitationRows()).toHaveLength(1);
});

// --- 引数の検証(期限を外から受け取らない)-------------------------------------------

test("(f) 期限の引数を1つも受け取らない —— 未知のキーは 400(`ADR-0336` 限定14)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  for (const body of [
    { username: "bob", role: "editor", expiresAt: "2099-01-01T00:00:00.000Z" },
    { username: "bob", role: "editor", ttlSec: 60 },
    { username: "bob", role: "editor", code: "AAAAAAAA" },
    { username: "bob", role: "editor", usedAt: null },
  ]) {
    const res = await req(owner.cookie, "POST", ISSUE_PATH, body);
    expect(res.status).toBe(400);
  }
  expect(invitationRows()).toHaveLength(0);
});

test("(f-2) 相手・役割の検証 —— 空の相手 400 / 値域外の役割 400", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  expect(
    (await req(owner.cookie, "POST", ISSUE_PATH, { username: "", role: "editor" })).status,
  ).toBe(400);
  expect((await req(owner.cookie, "POST", ISSUE_PATH, { username: "bob" })).status).toBe(400);
  const badRole = await req(owner.cookie, "POST", ISSUE_PATH, {
    username: "bob",
    role: "superuser",
  });
  expect(badRole.status).toBe(400);
  expect(
    ((await badRole.json()) as { errors: { path: string }[] }).errors.map((e) => e.path),
  ).toContain("/role");
  expect(invitationRows()).toHaveLength(0);
});

// --- 口は1本ちょうど ---------------------------------------------------------------

test("(g) 同じパスに `GET` / `DELETE` / `PATCH` は1本も無い(`ADR-0336` 限定5)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  for (const method of ["GET", "DELETE", "PATCH"]) {
    expect((await req(owner.cookie, method, ISSUE_PATH)).status).toBe(404);
  }
  // 末尾セグメントを持つ口も無い。
  expect((await req(owner.cookie, "DELETE", `${ISSUE_PATH}/bob`)).status).toBe(404);
  expect((await req(owner.cookie, "GET", `${ISSUE_PATH}/bob`)).status).toBe(404);
});

// --- 見せる先は2箇所だけ ------------------------------------------------------------

test("(h) 既存の `GET /auth/users` の応答に招待が出る(使用済みも消えない。`ADR-0336` 限定12 / 限定16)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  await req(owner.cookie, "POST", ISSUE_PATH, { username: "bob", role: "editor" });
  await req(owner.cookie, "POST", ISSUE_PATH, { username: "carol", role: "viewer" });
  await req(owner.cookie, "POST", ISSUE_PATH, { username: "carol", revoke: true });

  const res = await req(owner.cookie, "GET", USERS_PATH);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { users: unknown[]; invitations: InvitationView[] };
  expect(body.users.length).toBeGreaterThan(0);
  expect(body.invitations.map((invitation) => invitation.username).sort()).toEqual([
    "bob",
    "carol",
  ]);
  // **使用済み(= 取り消し済み)の招待も応答から消えない。**
  expect(
    body.invitations.find((invitation) => invitation.username === "carol")?.usedAt,
  ).not.toBeNull();
  // **コードは平文で返る**(`ADR-0336` §3-8。**ハッシュにしていない**)。
  expect(body.invitations.find((invitation) => invitation.username === "bob")?.code).toHaveLength(
    8,
  );
});

test("(h2) 役割を配れるだけで持ち主でない人には、同じ応答に招待が1件も載らない(メインの裁定 `M2-1`)", async () => {
  // **`D-V8-10` でユーザが選んだ選択肢の説明文の逐語**:
  // 「**招待リストが他の利用者に見えてしまう事故が構造的に起きない**」。
  // **この口(`GET /auth/users`)は `requireRoleDistribution` で開いており、
  // 役割を配れる人は運営者とは限らない** —— **すなわち「他の利用者」でありうる。**
  // **そこで招待は `owner` を実効ロール集合に持つ人にだけ載せる。**
  // **口の可否そのものは `requireRoleDistribution` のままである**(`ADR-0323` 限定3 を破らない)。
  const distributorManifest = structuredClone(baseManifest()) as unknown as {
    app: { roles: { id: string; name?: string; rules?: unknown[] }[] };
  };
  distributorManifest.app.roles.push({
    id: "distributor",
    name: "役割を配る係",
    rules: [{ target: "role", can: ["write"] }],
  });
  expect(applyManifest(dataRoot, APP_ID, distributorManifest as unknown as Manifest).valid).toBe(
    true,
  );

  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  await req(owner.cookie, "POST", ISSUE_PATH, { username: "bob", role: "editor" });
  const code = invitationRows()[0]?.code ?? "";
  expect(code).toHaveLength(8);

  const distributor = seedSession(dataRoot, APP_ID, { role: "distributor" });
  const res = await req(distributor.cookie, "GET", USERS_PATH);
  // **口そのものは今日どおり通る**(403 にしていない)。
  expect(res.status).toBe(200);
  const text = await res.text();
  const body = JSON.parse(text) as { users: unknown[]; invitations?: unknown[] };
  expect(body.users.length).toBeGreaterThan(0);
  // **招待のフィールドが1つも無い。コードの文字列も応答本文に1バイトも現れない。**
  expect(body.invitations).toBeUndefined();
  expect(text.includes(code)).toBe(false);

  // **陽性対照**: 同じ口を持ち主で叩けば載る(載らないのが人違いではないことを示す)。
  const ownerBody = (await (await req(owner.cookie, "GET", USERS_PATH)).json()) as {
    invitations?: { code: string }[];
  };
  expect(ownerBody.invitations?.some((invitation) => invitation.code === code)).toBe(true);
});

test("(i) 招待を1件も見られない人には、一覧そのものが 403 である", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  await req(owner.cookie, "POST", ISSUE_PATH, { username: "bob", role: "editor" });
  const viewer = seedSession(dataRoot, APP_ID, { role: "viewer" });
  const res = await req(viewer.cookie, "GET", USERS_PATH);
  expect(res.status).toBe(403);
  expect(await res.text()).not.toContain(invitationRows()[0]?.code ?? "");
});

test("(j) コードは監査記録(`_auth_activity`)に1バイトも現れない(`ADR-0336` 限定11)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const issued = (await (
    await req(owner.cookie, "POST", ISSUE_PATH, { username: "bob", role: "editor" })
  ).json()) as IssuedBody;

  const db = new Database(appDbPath(dataRoot, APP_ID), { readonly: true });
  try {
    const rows = db.query<Record<string, unknown>, []>(`SELECT * FROM "_auth_activity"`).all();
    expect(JSON.stringify(rows).includes(issued.invitation.code)).toBe(false);
  } finally {
    db.close();
  }
});

// --- 掃除(`I-G17`)-----------------------------------------------------------------

test("(k) 発行のときに、期限切れの招待と既存の期限切れ(session / challenge)を同じ点で掃除する", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });

  // 期限切れの招待を1件、期限切れのセッションと challenge を1件ずつ作る。
  await req(owner.cookie, "POST", ISSUE_PATH, { username: "stale", role: "editor" });
  const store = AuthStore.openForApp(dataRoot, APP_ID);
  try {
    store.createSession(owner.userId, -1);
    store.savePendingChallenge({ challenge: "old", purpose: "authentication", ttlSec: -1 });
  } finally {
    store.close();
  }
  const expired = new Date(Date.now() - 1000).toISOString();
  const write = new Database(appDbPath(dataRoot, APP_ID));
  try {
    write
      .query(`UPDATE "_auth_invitations" SET "expires_at" = ? WHERE "username" = ?`)
      .run(expired, "stale");
  } finally {
    write.close();
  }

  // **新しい発行が、その掃除の呼び出し点である。**
  expect(
    (await req(owner.cookie, "POST", ISSUE_PATH, { username: "bob", role: "editor" })).status,
  ).toBe(200);

  expect(invitationRows().map((row) => row.username)).toEqual(["bob"]);
  const read = new Database(appDbPath(dataRoot, APP_ID), { readonly: true });
  try {
    const pending =
      read.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "_auth_pending_challenges"`).get()
        ?.n ?? -1;
    expect(pending).toBe(0);
    // **owner のセッションは生きている**(消えたのは期限切れの1本だけ)。
    const sessions =
      read.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "_auth_sessions"`).get()?.n ?? -1;
    expect(sessions).toBe(1);
  } finally {
    read.close();
  }
});
