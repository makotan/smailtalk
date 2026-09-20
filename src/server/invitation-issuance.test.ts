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
 * ## **【2026-09-18 訂正(`V19-M2-T02`。`D-V19-6` / 単位 `SV-G7a`)。上の (6) を1バイトも消していない】**
 *
 * **上の (6)「見せる先は2箇所だけ」は今日は偽である** —— **コードの提供先は
 * **発行の応答本文の1箇所ちょうど**に狭まった**(`ADR-0452` 限定⑮ が `ADR-0336` 限定12 を
 * 置き直した)。 **`GET /api/apps/:app_id/auth/users` の応答には、招待は今日どおり載るが
 * コードは1バイトも載らない**(`(h)` / `(h3)`)。
 * **`_auth_activity` に1バイトも書かないこと(限定11 の**内容欄**)は1バイトも破っていない。**
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
import { AuthStore, INVITATION_CODE_ALPHABET, INVITATION_REVOKED_PREFIX } from "../auth/store.ts";
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

/**
 * **一覧の応答に載る招待の形**(`V19-M2-T02`。`ADR-0452` 限定⑮)。
 *
 * **`code` を持たない** —— **コードの提供先は「発行の応答本文」の1箇所ちょうどである。**
 * **`state` は `V19-M2-T00` が足した別のキーである**(`usedAt` は ISO8601 のまま)。
 */
type ListedInvitationView = {
  username: string;
  role: string;
  expiresAt: string;
  issuedBy: string;
  issuedAt: string;
  usedAt: string | null;
  state: string;
};

/** **発行の応答に載る招待の形**(**ここだけがコードを持つ**)。 */
type InvitationView = ListedInvitationView & { code: string };

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

// **【2026-09-18 テスト名の打ち直し(`V19-M2-T02`。計画 `§3` の `T02` 詳細4)】**
// **旧のテスト名(逐語)**: 「(c) 取り消せる —— 行は消えず、使用時刻が入る(`ADR-0336` 限定16)」。
// **偽になったのは「使用時刻が入る」である** —— **`V19-M2-T00` 以降、取り消しが**表**に書くのは
// **素の時刻ではない値**であり、素の使用時刻ではない**(応答の側は今日も素の ISO8601 で返る)。
// **検査の中身は1つも変えていない**(名前だけの打ち直しである)。
test("(c) 取り消せる —— 行は消えず、使用時刻の列に印が入る(`ADR-0336` 限定16)", async () => {
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
// **【2026-09-18 訂正(`V19-M2-T02`)。上の1行を1バイトも消していない】**
// **上の見出しは今日は偽である** —— **コードの提供先は「発行の応答本文」の**1箇所ちょうど**
// である**(`ADR-0452` 限定⑮)。 **一覧の応答には招待は載るが、コードは載らない。**

test("(h) 既存の `GET /auth/users` の応答に招待が出る —— ただしコードは載らない(使用済みも消えない。`ADR-0336` 限定16 / `ADR-0452` 限定⑮)", async () => {
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
  // **【2026-09-18 訂正(`V19-M2-T02`。`D-V19-6` / 単位 `SV-G7a`)。上の1行を1バイトも
  //   消していない】**
  // **上の1行は**この応答については**今日は偽である** —— **一覧の応答はコードを
  // 1バイトも載せない**(`ADR-0452` 限定⑮)。 **平文で返るのは**発行の応答**だけであり、
  // そちらは今日どおりである**(`(a)` / `(h3)` が固定している)。
  // **保管の形は1バイトも変えていない**(ハッシュにしていない。表の中は平文のまま)。
  const bob = body.invitations.find((invitation) => invitation.username === "bob");
  expect(bob === undefined).toBe(false);
  expect(bob !== undefined && "code" in bob).toBe(false);
  // **陽性対照**: **同じ1件に他のキーは載っている** ——
  // **「コードが無い」が「招待そのものが載っていない」ことによる 0件 ではない。**
  expect(bob?.role).toBe("editor");
  expect(bob?.state).toBe("unused");
  expect(typeof bob?.expiresAt).toBe("string");
  // **表の中のコードは今日どおり在る**(落としたのは応答だけである)。
  expect(invitationRows().find((row) => row.username === "bob")?.code).toHaveLength(8);
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
  // **【2026-09-18 差し替え(`V19-M2-T02`。`D-V19-6` / 単位 `SV-G7a`)。上の1行を1バイトも
  //   消していない】**
  // **旧の陽性対照は「持ち主で叩けば**コードが**載る」だった** —— **本葉が一覧の応答から
  // コードを落としたので、持ち主で叩いてもコードは1バイトも載らず、旧の形はもう
  // 陽性対照にならない**(常に偽になる)。
  // **新しい陽性対照(1文)**: **持ち主なら招待そのもの(`invitations` のキーと、その1件の
  // 中身)は今日どおり載る —— 落ちているのは**コードだけ**である。**
  // **これで「役割を配れるだけの人に載らないのは、人違いや叩き損ねではない」ことが示せる。**
  const ownerBody = (await (await req(owner.cookie, "GET", USERS_PATH)).json()) as {
    invitations?: ListedInvitationView[];
  };
  expect(ownerBody.invitations?.map((invitation) => invitation.username)).toEqual(["bob"]);
  expect(ownerBody.invitations?.[0]?.role).toBe("editor");
  expect(ownerBody.invitations?.[0]?.state).toBe("unused");
  // **落ちているのはコードだけである。**
  const ownerFirst = ownerBody.invitations?.[0];
  expect(ownerFirst !== undefined && "code" in ownerFirst).toBe(false);
  // **その招待の本物のコードは、持ち主の応答本文にも1バイトも現れない。**
  expect(JSON.stringify(ownerBody).includes(code)).toBe(false);
});

test("(h3) コードの提供先は発行の応答の1箇所ちょうど —— 一覧の応答にも監査記録にも1バイトも出ない(`ADR-0452` 限定⑮ / `ADR-0336` 限定11 の検査欄の置き直し)", async () => {
  // **【この検査が `ADR-0336` 限定11 の検査欄の後半を置き直したものである】**
  // **旧: 「発行の応答**と `GET /auth/users` の応答**以外にコードが出ないことの検査」(= 2箇所)。**
  // **新: 「**発行の応答**以外にコードが出ないことの検査」(= 1箇所)。**
  // **内容欄(平文で保管する / 監査に2つ目の写しを作らない)は1バイトも破っていない。**
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const issuedText = await (
    await req(owner.cookie, "POST", ISSUE_PATH, { username: "bob", role: "editor" })
  ).text();
  const issued = JSON.parse(issuedText) as IssuedBody;

  // **1箇所目(唯一の提供先)= 発行の応答本文。** **今日どおり載る。**
  expect(issued.invitation.code).toHaveLength(8);
  expect(issuedText.includes(issued.invitation.code)).toBe(true);

  // **2箇所目だった一覧の応答には、キーとしても文字列としても出ない。**
  const listText = await (await req(owner.cookie, "GET", USERS_PATH)).text();
  const listBody = JSON.parse(listText) as {
    users: unknown[];
    invitations: ListedInvitationView[];
  };
  expect(listBody.invitations.filter((invitation) => "code" in invitation)).toHaveLength(0);
  expect(listText.includes(issued.invitation.code)).toBe(false);
  // **陽性対照**: **同じ応答に招待そのものは載っている** ——
  // **「0件」が「一覧を叩けていない」ことによる 0件 ではないことを、同じ応答の他のキーで示す。**
  expect(listBody.invitations.map((invitation) => invitation.username)).toEqual(["bob"]);
  expect(listBody.invitations[0]?.role).toBe("editor");
  expect(listBody.invitations[0]?.state).toBe("unused");
  expect(listBody.users.length).toBeGreaterThan(0);

  // **表の中のコードは1バイトも落としていない**(保管の形を変えていない)。
  expect(invitationRows()[0]?.code).toBe(issued.invitation.code);

  // **監査記録にも出ない**(`(j)` と同じ内容欄。ここでは1箇所の形として同じ点で確かめる)。
  const db = new Database(appDbPath(dataRoot, APP_ID), { readonly: true });
  try {
    const rows = db.query<Record<string, unknown>, []>(`SELECT * FROM "_auth_activity"`).all();
    expect(JSON.stringify(rows).includes(issued.invitation.code)).toBe(false);
    // **【本葉(`V19-M2-T02`)が陽性対照を置こうとして見つけた。隠さない】**
    // **この時点の `_auth_activity` は **0行** である** —— **発行も取り消しも監査記録に
    // 1行も書かないからである**(`unfixed-holes.md` `§3` の 3)。
    // **したがって上の1行と `(j)` の「コードが現れない」は、**陽性対照の無い 0件** である**
    // ——**「書いていない」と「そもそも表が空」を、この検査は区別できない。**
    // **本葉はこれを直さない**(監査の粒度は本段の射程外)。 **0行であることを固定して、
    // 次に誰かが監査を書き始めたらここが赤くなるようにしておく。**
    expect(rows).toHaveLength(0);
  } finally {
    db.close();
  }
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

// --- (c-3) 印の在る招待への取り消し(`V19-M2-T07`。独立点検の指摘2)----------------------
//
// **独立点検は実装を読んで示しただけで、HTTP を1度も撃っていない。** **本葉が撃った。**
// **【これは「決めた形」ではなく、今日の**壊れ方**を写した検査である】**
// **塞いでいない穴として `docs/plan/v19/unfixed-holes.md` `§1` に `H-V19-5` が在る。**
// **【禁止の履行】これを「直した」と書かない** —— **製品コードを1バイトも変えていない。**

test("(c-3) 印の在る招待に取り消しを掛けると、行は1バイトも書き換わらないまま 200 が返る(`V19-M2-T07` / `H-V19-5`)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  await req(owner.cookie, "POST", ISSUE_PATH, { username: "bob", role: "editor" });
  // **登録に使われた状態を作る。** **登録の口は本ファイルの射程外なので、表に直接印を立てる**
  // (`invitation-redemption.test.ts` が登録の側を持つ)。
  {
    const store = AuthStore.openForApp(dataRoot, APP_ID);
    try {
      expect(store.markInvitationUsed("bob")).toBe(true);
    } finally {
      store.close();
    }
  }
  const before = invitationRows();
  expect(before[0]?.used_at ?? "").not.toContain(INVITATION_REVOKED_PREFIX);

  const res = await req(owner.cookie, "POST", ISSUE_PATH, { username: "bob", revoke: true });

  // **今日の帰結(1)**: **成功の形で返る** —— **書けなかったことは status からは読めない。**
  expect(res.status).toBe(200);
  const body = (await res.json()) as IssuedBody;

  // **今日の帰結(2)**: **行は1バイトも書き換わっていない。**
  expect(invitationRows()).toEqual(before);

  // **今日の帰結(3)**: **応答の状態の欄は、実際の状態をそのまま返す**
  // (`V19-M2-T00` が足した欄)。 **この欄が無かった着手前は、運営者が応答から
  // 食い違いを読む手段が1つも無かった** —— **すなわち本段がこの経路を見えるようにした。**
  expect(body.invitation.state).toBe("used");
  expect(body.invitation.usedAt).toBe(before[0]?.used_at ?? null);

  // **今日の帰結(4)**: **コードは今日も載る**(`H-V19-2`)—— **ただしここで載るのは
  // 「今取り消したばかりの招待」のコードではなく、**既に登録に使われた**招待のコードである。**
  expect(body.invitation.code).toHaveLength(8);
  const beforeFirst = before[0];
  if (beforeFirst === undefined) throw new Error("fixture broken");
  expect(body.invitation.code).toBe(beforeFirst.code);

  // **陽性対照**: **印の無い招待に同じ操作を掛けると、行は実際に書き換わる** ——
  // **すなわち上の4点は「取り消しの口そのものが壊れている」のではない。**
  await req(owner.cookie, "POST", ISSUE_PATH, { username: "carol", role: "editor" });
  expect(invitationRows().find((r) => r.username === "carol")?.used_at).toBeNull();
  const ok = await req(owner.cookie, "POST", ISSUE_PATH, { username: "carol", revoke: true });
  expect(ok.status).toBe(200);
  const okBody = (await ok.json()) as IssuedBody;
  expect(okBody.invitation.state).not.toBe("used");
  const afterFirst = invitationRows().find((r) => r.username === "carol")?.used_at ?? "";
  expect(afterFirst).toContain(INVITATION_REVOKED_PREFIX);

  // **2度目の取り消しも 200 で、印の時刻は1度目のままである**(今の時刻に進まない)。
  // **間を空けないと、書き換わった場合でもミリ秒が衝突して偽の緑になる。**
  Bun.sleepSync(5);
  const again = await req(owner.cookie, "POST", ISSUE_PATH, { username: "carol", revoke: true });
  expect(again.status).toBe(200);
  expect(invitationRows().find((r) => r.username === "carol")?.used_at ?? "").toBe(afterFirst);
});
