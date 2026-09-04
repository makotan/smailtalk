/**
 * **招待の引き換え**(`V8-M3-T02`〜`T06`。台帳 `I-G19` / `I-G20` / `I-G22` / `I-G23`。
 * [`ADR-0337`](../../docs/adr/0337-invitation-redemption-path.md))。
 * **本物の SQLite と実 HTTP(`app.request()`)で測る**(モックを置かない)。
 *
 * ## この検査が固定するもの
 *
 * 1. **招待が要るかの式が1本ちょうどであること**(`ADR-0337` 限定8)。
 * 2. **本文に招待コードが無いときは招待の表を1度も触らないこと**(同 限定13)。
 * 3. **招待経路の失敗5つが1つの `403` に畳まれること**(同 限定10 / `I-G23`)。
 * 4. **招待を要求しない経路の `409` / `403` / `422` の順序が1バイトも変わらないこと**(同 限定9)。
 * 5. **消費とユーザ作成が同一トランザクションに入っていること**(同 限定11)。
 * 6. **役割が招待の行から来ること**(同 限定6 / `I-G22`)。
 *
 * ## この検査が測らないもの(**誇張しない**)
 *
 * 1. **応答時間の差を1度も測っていない**(`ADR-0337` §限界4)。
 * 2. **passkey の verify は実オーセンティケータを要するので、WebAuthn の検証そのものは
 *    1度も通していない。** **測れるのは「関門が WebAuthn 検証より前で判定を返すこと」
 *    までである。**
 * 3. **`data/apps/` の実地アプリには1バイトも書いていない。**
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthConfig, loadAuthConfig } from "../auth/config.ts";
import { AuthStore } from "../auth/store.ts";
import type { Role } from "../auth/types.ts";
import {
  appDbPath,
  applyManifest,
  createApp,
  KernelMetaStore,
  type Manifest,
} from "../kernel/index.ts";
import { createServerApp } from "./app.ts";

const source = (): string => readFileSync(join(import.meta.dir, "auth-routes.ts"), "utf8");

/** 注釈(`//` / `*`)を除いた「実際に動く行」だけを返す。 */
const liveLines = (): string[] =>
  source()
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"));

// ===========================================================================
// (T02) 招待を引く1本と、招待が要るかの1本
// ===========================================================================

describe("(T02) 招待の判定は1本に閉じる(`ADR-0337` 限定8 / 限定13)", () => {
  test("(T02-a) `invitationRequired` は1本ちょうど宣言されている", () => {
    const hits = source()
      .split("\n")
      .filter((line) => line.startsWith("function invitationRequired"));
    expect(hits).toHaveLength(1);
  });

  test("(T02-b) 招待の要否の三項式は1箇所ちょうどで、`signupAllowed` の中には無い", () => {
    const text = source();
    const marker = 'inviteScope === "reserved"';
    const occurrences = text.split(marker).length - 1;
    expect(occurrences).toBe(1);
    // **`signupAllowed` の本体は述語を**呼ぶ**だけである**(式を持たない)。
    const body = text.slice(
      text.indexOf("function signupAllowed(input: {"),
      text.indexOf("type SignupPolicy = {"),
    );
    expect(body.includes(marker)).toBe(false);
    expect(body.includes("invitationRequired(")).toBe(true);
  });

  test("(T02-c) `invitationFrom` は1本ちょうどで、`store` に触る前に早期 return を持つ", () => {
    const text = source();
    expect(text.split("\nfunction invitationFrom(").length - 1).toBe(1);
    const start = text.indexOf("\nfunction invitationFrom(");
    const body = text.slice(start, text.indexOf("\n}", start));
    const lines = body.split("\n");
    const guardAt = lines.findIndex(
      (line) => line.includes("return undefined;") && !line.trimStart().startsWith("*"),
    );
    const firstStoreAt = lines.findIndex(
      (line) => line.includes("store.") && !line.trimStart().startsWith("*"),
    );
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(firstStoreAt).toBeGreaterThanOrEqual(0);
    expect(guardAt).toBeLessThan(firstStoreAt);
  });

  test("(T02-d) 掃除の2本は招待を引く1本の中で、同じ点から2本とも呼ばれる", () => {
    const text = source();
    const start = text.indexOf("\nfunction invitationFrom(");
    const body = text.slice(start, text.indexOf("\n}", start));
    expect(body.includes("store.purgeExpiredInvitations();")).toBe(true);
    expect(body.includes("store.purgeExpired();")).toBe(true);
  });

  test("(T02-e) `signupAllowed` の呼び出しは2箇所のままである(写しを増やしていない)", () => {
    const live = liveLines();
    expect(live.filter((line) => line.includes("function signupAllowed"))).toHaveLength(1);
    expect(live.filter((line) => line.includes("signupAllowed({"))).toHaveLength(2);
  });
});

// ===========================================================================
// (T03) 失敗を1つの文面に畳む(`I-G23` / 裁定 `M3-3` / `ADR-0337` 限定10)
// ===========================================================================

describe("(T03) 畳んだ 403 の文面(`ADR-0337` 限定10)", () => {
  const declaration = (): string => {
    const text = source();
    const start = text.indexOf("const invitationRejectedError: ValidationError = {");
    expect(start).toBeGreaterThanOrEqual(0);
    return text.slice(start, text.indexOf("};", start));
  };

  test("(T03-a) `path` / `message` / `hint` の3つを持つ", () => {
    const body = declaration();
    expect(body.includes("path:")).toBe(true);
    expect(body.includes("message:")).toBe(true);
    expect(body.includes("hint:")).toBe(true);
  });

  test("(T03-b) env で閉じたときの文面とは別である", () => {
    const text = source();
    const closed = text.slice(
      text.indexOf("const registrationClosedError: ValidationError = {"),
      text.indexOf("const challengeInvalidError"),
    );
    const rejected = declaration();
    const pick = (chunk: string, key: string): string => {
      const at = chunk.indexOf(`${key}:`);
      return at < 0 ? "" : chunk.slice(at, chunk.indexOf("\n", at));
    };
    expect(pick(rejected, "message")).not.toBe(pick(closed, "message"));
    expect(pick(rejected, "hint")).not.toBe(pick(closed, "hint"));
    expect(pick(rejected, "message").length).toBeGreaterThan(0);
  });

  test("(T03-c) 3つの場合を区別できる語を1文字も含まない(`I-G23`)", () => {
    const body = declaration();
    // **漏らしてはならないのは2つである**(`ADR-0337` §3-8):
    // その相手が招待されているか / そのログイン名が実在するか。
    for (const leak of [
      "招待されていません",
      "招待がありません",
      "招待が見つかりません",
      "既に使われています",
      "使用済み",
      "期限が切れています",
      "存在しません",
      "登録済み",
    ]) {
      expect(body.includes(leak)).toBe(false);
    }
  });

  test("(T03-d) 期限があること・両方を入れること・招待制であることを hint が書く", () => {
    const body = declaration();
    const hint = body.slice(body.indexOf("hint:"));
    expect(hint.includes("期限")).toBe(true);
    expect(hint.includes("両方")).toBe(true);
    expect(hint.includes("招待")).toBe(true);
  });
});

// ===========================================================================
// 実 HTTP の土台(**本物の SQLite。モックを置かない**)
// ===========================================================================

const APP_ID = "invited-shop";
const ORIGIN = "http://localhost:5173";

let dataRoot: string;
let server: ReturnType<typeof createServerApp>;

/** `owner` の定義変更・役割配布の2本(適用時検査が要求する)。 */
const OWNER_RULES = [
  { target: "app", can: ["write"] },
  { target: "role", can: ["write"] },
];

type SignupMode = "open" | "invite";

/**
 * 題材。**`member`(アプリが自分で作った役割 = 登録で名乗れる唯一の値)を1本持つ。**
 * `signup` を渡さなければ、その役割には `signup` を1バイトも書かない(= 宣言なし)。
 */
function shopManifest(modes: { member?: SignupMode; staff?: SignupMode } = {}): Manifest {
  const withMode = (role: Record<string, unknown>, mode: SignupMode | undefined) =>
    mode === undefined ? role : { ...role, signup: mode };
  return {
    app: {
      id: APP_ID,
      name: "招かれる店",
      tables: [{ id: "memo", name: "メモ", fields: [{ id: "title", name: "題名", type: "text" }] }],
      views: [],
      roles: [
        withMode({ id: "owner", name: "持ち主", rules: OWNER_RULES }, modes.staff),
        withMode({ id: "editor", name: "編集者" }, modes.staff),
        withMode({ id: "viewer", name: "閲覧者" }, modes.staff),
        withMode({ id: "member", name: "会員" }, modes.member),
      ],
    },
  } as unknown as Manifest;
}

async function makeApp(manifest: Manifest, config?: AuthConfig): Promise<void> {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-invite-redeem-"));
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, "招かれる店", { app_id: APP_ID });
  } finally {
    meta.close();
  }
  const applied = applyManifest(dataRoot, APP_ID, manifest);
  if (!applied.valid) {
    throw new Error(`テスト前提のマニフェスト投入に失敗: ${JSON.stringify(applied.errors)}`);
  }
  server = createServerApp(config === undefined ? { dataRoot } : { dataRoot, authConfig: config });
}

afterEach(async () => {
  if (dataRoot !== undefined) {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

function postJson(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
  });
}

/** 運営が人を足す口(`ADMIN_SIGNUP`)。 */
async function adminRegister(username: string, code?: string): Promise<Response> {
  return await server.request(
    postJson(`/api/apps/${APP_ID}/auth/password/register`, {
      username,
      password: "pw-123456",
      ...(code === undefined ? {} : { invitation_code: code }),
    }),
  );
}

/** セルフ登録の口(`SELF_SIGNUP`)。 */
async function selfRegister(username: string, userKind?: string, code?: string): Promise<Response> {
  return await server.request(
    postJson(`/api/apps/${APP_ID}/auth/signup/password/register`, {
      username,
      password: "pw-123456",
      ...(userKind === undefined ? {} : { user_kind: userKind }),
      ...(code === undefined ? {} : { invitation_code: code }),
    }),
  );
}

/** passkey の options(**ユーザを1人も作らない口**)。 */
async function passkeyOptions(username: string, code?: string): Promise<Response> {
  return await server.request(
    postJson(`/api/apps/${APP_ID}/auth/passkey/register/options`, {
      username,
      ...(code === undefined ? {} : { invitation_code: code }),
    }),
  );
}

/** **HTTP を通さずに**招待を1件置く(運営者を1人も作らずに済ませるため)。 */
function seedInvitation(username: string, role: Role): string {
  const store = AuthStore.openForApp(dataRoot, APP_ID);
  try {
    return store.issueInvitation({ username, role, issuedBy: "seed" }).code;
  } finally {
    store.close();
  }
}

/** 招待の行を直に読む。 */
function invitationRow(username: string): { code: string; used_at: string | null } | null {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readonly: true });
  try {
    return db
      .query<{ code: string; used_at: string | null }, [string]>(
        `SELECT "code", "used_at" FROM "_auth_invitations" WHERE "username" = ?`,
      )
      .get(username);
  } finally {
    db.close();
  }
}

/** 招待の期限を過去にずらす(24時間固定なので、外から縮める道が1本も無い)。 */
function expireInvitation(username: string): void {
  const db = new Database(appDbPath(dataRoot, APP_ID));
  try {
    db.query(`UPDATE "_auth_invitations" SET "expires_at" = ? WHERE "username" = ?`).run(
      "2000-01-01T00:00:00.000Z",
      username,
    );
  } finally {
    db.close();
  }
}

function countUsers(): number {
  const store = AuthStore.openForApp(dataRoot, APP_ID);
  try {
    return store.countUsers();
  } finally {
    store.close();
  }
}

function effectiveRoles(username: string): readonly string[] {
  const store = AuthStore.openForApp(dataRoot, APP_ID);
  try {
    const user = store.findUserByUsername(username);
    return user === undefined ? [] : store.effectiveRoles(user.id);
  } finally {
    store.close();
  }
}

const ENV_ON = (): AuthConfig => loadAuthConfig({ ST_AUTH_ALLOW_REGISTRATION: "true" });
const ENV_OFF = (): AuthConfig => loadAuthConfig({ ST_AUTH_ALLOW_REGISTRATION: "false" });

// ===========================================================================
// (T04-1)〜(T04-4) 宣言の3通り —— `CP-V8` §8 の (ii)(iii)(iv)
// ===========================================================================

describe("(T04-A) 宣言の形ごとの通り方", () => {
  test("(1) 宣言なしのアプリは、運営経路も非運営経路も今日どおり誰でも登録できる", async () => {
    await makeApp(shopManifest(), ENV_ON());
    expect((await adminRegister("admin1")).status).toBe(200);
    expect((await adminRegister("admin2")).status).toBe(200);
    expect((await selfRegister("buyer1", "member")).status).toBe(200);
    expect((await selfRegister("buyer2", "member")).status).toBe(200);
  });

  test("(2) 一般は自由・スタッフは制限 —— 非運営経路は招待なしで通る", async () => {
    await makeApp(shopManifest({ staff: "invite" }), ENV_ON());
    expect((await adminRegister("first")).status).toBe(200);
    expect((await selfRegister("buyer1", "member")).status).toBe(200);
    expect((await selfRegister("buyer2", "member")).status).toBe(200);
  });

  test("(3) 一般は自由・スタッフは制限 —— 運営経路は招待なしでは通らない", async () => {
    await makeApp(shopManifest({ staff: "invite" }), ENV_ON());
    expect((await adminRegister("first")).status).toBe(200);
    const blocked = await adminRegister("second");
    expect(blocked.status).toBe(403);
    expect(countUsers()).toBe(1);
  });

  test("(4) 全員制限 —— 非運営経路も招待なしでは通らない", async () => {
    await makeApp(shopManifest({ staff: "invite", member: "invite" }), ENV_ON());
    expect((await adminRegister("first")).status).toBe(200);
    expect((await selfRegister("buyer", "member")).status).toBe(403);
    expect((await adminRegister("second")).status).toBe(403);
    expect(countUsers()).toBe(1);
  });
});

// ===========================================================================
// (T04-5)〜(T04-9) 引き換え —— `CP-V8` §8 の (v)(vi)(vii)(viii)(ix)
// ===========================================================================

describe("(T04-B) 2つが揃ったときだけ通る(`I-G20` / `D-V8-1`)", () => {
  test("(5) ログイン名 + コードが揃うと登録が成立する", async () => {
    await makeApp(shopManifest({ staff: "invite", member: "invite" }), ENV_ON());
    expect((await adminRegister("first")).status).toBe(200);
    const code = seedInvitation("bob", "editor");
    const res = await selfRegister("bob", "member", code);
    expect(res.status).toBe(200);
    expect(countUsers()).toBe(2);
  });

  test("(6) ログイン名だけでは通らない(コードを送らない)", async () => {
    await makeApp(shopManifest({ staff: "invite", member: "invite" }), ENV_ON());
    expect((await adminRegister("first")).status).toBe(200);
    seedInvitation("bob", "editor");
    expect((await selfRegister("bob", "member")).status).toBe(403);
    expect(countUsers()).toBe(1);
  });

  test("(7) コードだけでは通らない —— 別人のログイン名に正しいコードを添えても落ちる", async () => {
    await makeApp(shopManifest({ staff: "invite", member: "invite" }), ENV_ON());
    expect((await adminRegister("first")).status).toBe(200);
    const code = seedInvitation("bob", "editor");
    expect((await selfRegister("carol", "member", code)).status).toBe(403);
    expect(countUsers()).toBe(1);
  });

  test("(8) 期限を過ぎたコードでは通らない", async () => {
    await makeApp(shopManifest({ staff: "invite", member: "invite" }), ENV_ON());
    expect((await adminRegister("first")).status).toBe(200);
    const code = seedInvitation("bob", "editor");
    expireInvitation("bob");
    expect((await selfRegister("bob", "member", code)).status).toBe(403);
    expect(countUsers()).toBe(1);
  });

  test("(9) 1回使ったコードでは2回目が通らない", async () => {
    await makeApp(shopManifest({ staff: "invite", member: "invite" }), ENV_ON());
    expect((await adminRegister("first")).status).toBe(200);
    const code = seedInvitation("bob", "editor");
    expect((await selfRegister("bob", "member", code)).status).toBe(200);
    expect(invitationRow("bob")?.used_at).not.toBeNull();
    expect((await selfRegister("bob", "member", code)).status).toBe(403);
    expect(countUsers()).toBe(2);
  });

  test("(9b) 使用済みの招待は、別のログイン名からも通らない", async () => {
    await makeApp(shopManifest({ staff: "invite", member: "invite" }), ENV_ON());
    expect((await adminRegister("first")).status).toBe(200);
    const code = seedInvitation("bob", "editor");
    expect((await selfRegister("bob", "member", code)).status).toBe(200);
    expect((await selfRegister("dave", "member", code)).status).toBe(403);
    expect(countUsers()).toBe(2);
  });
});

// ===========================================================================
// (T04-10) 失敗の3通りが1バイト違わない(`I-G23` / `ADR-0337` 限定10)
// ===========================================================================

describe("(T04-C) 失敗の文面(`I-G23`)", () => {
  test("(10) 存在しないログイン名 / 違うコード / 招待されていない実在のログイン名 が同じ応答になる", async () => {
    await makeApp(shopManifest({ staff: "invite", member: "invite" }), ENV_ON());
    expect((await adminRegister("first")).status).toBe(200);
    seedInvitation("bob", "editor");

    // (a) 招待も登録も無いログイン名。
    const ghost = await selfRegister("ghost", "member", "ZZZZZZZZ");
    // (b) 招待はあるがコードが違う。
    const wrongCode = await selfRegister("bob", "member", "ZZZZZZZZ");
    // (c) 既に登録されているログイン名(招待は1件も無い)。**今日の 409 が畳まれる。**
    const taken = await selfRegister("first", "member", "ZZZZZZZZ");

    expect(ghost.status).toBe(403);
    expect(wrongCode.status).toBe(403);
    expect(taken.status).toBe(403);
    const bodies = [await ghost.json(), await wrongCode.json(), await taken.json()];
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    // **env で閉じたときの文面とは別である**(限定10)。
    expect(JSON.stringify(bodies[0])).not.toContain("ST_AUTH_ALLOW_REGISTRATION");
  });

  test("(10b) 招待を要求しない経路の 409 は1バイトも変わっていない(`I-G3` / 限定9)", async () => {
    await makeApp(shopManifest(), ENV_ON());
    expect((await selfRegister("dup", "member")).status).toBe(200);
    const again = await selfRegister("dup", "member");
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      errors: [
        {
          path: "/username",
          message: 'ユーザ名 "dup" は既に使われています。',
          hint: "別の username を選ぶか、既存アカウントでログインしてください。",
        },
      ],
    });
  });

  test("(10c) 招待を要求する経路でも、名乗りの 422 は今日どおり残る", async () => {
    await makeApp(shopManifest({ staff: "invite", member: "invite" }), ENV_ON());
    expect((await adminRegister("first")).status).toBe(200);
    const code = seedInvitation("bob", "editor");
    // **宣言していない種類名を名乗ると 422**(招待が有効でも、名乗りの検査は残る)。
    const res = await selfRegister("bob", "ghost-kind", code);
    expect(res.status).toBe(422);
  });

  test("(20) 名乗りに存在しない役割を書くと、`403` に畳まれず今日どおりの応答になる(裁定 `M3-5` の穴)", async () => {
    await makeApp(shopManifest({ staff: "invite", member: "invite" }), ENV_ON());
    expect((await adminRegister("first")).status).toBe(200);
    // **【限界。隠さない】** **名乗りが確定しないと、名乗った役割の宣言は読めない**
    // (`ADR-0334` 限定14。**読み方を3通り目にしない**)。**したがって招待の関門は
    // 掛からず、今日どおりの応答が返る。** **`I-G23` は「名乗りが妥当な本文」に
    // ついてのみ成り立つ。**
    const fresh = await selfRegister("sneak", "ghost-kind");
    expect(fresh.status).toBe(422);
    // **ログイン名が既に在れば、畳んだ 403 ではなく今日どおりの 409 が返る** ——
    // **すなわち「そのログイン名は実在する」がこの経路からは漏れる。**
    const taken = await selfRegister("first", "ghost-kind");
    expect(taken.status).toBe(409);
    // **ユーザは1人も増えていない。**
    expect(countUsers()).toBe(1);
  });
});

// ===========================================================================
// (T04-13)(T04-16) env を越える(`D-V8-110`)
// ===========================================================================

describe("(T04-D) 有効な招待は env の閉じを越える(`D-V8-110`)", () => {
  test("(13) ST_AUTH_ALLOW_REGISTRATION=false でも、有効な招待があれば登録できる", async () => {
    await makeApp(shopManifest({ staff: "invite", member: "invite" }), ENV_OFF());
    expect((await adminRegister("first")).status).toBe(200); // ブートストラップ例外
    expect((await selfRegister("nope", "member")).status).toBe(403);
    const code = seedInvitation("bob", "editor");
    expect((await selfRegister("bob", "member", code)).status).toBe(200);
    expect(countUsers()).toBe(2);
  });

  test("(16) passkey の options —— env=false でも、有効な招待を添えれば通る(逃がし)", async () => {
    await makeApp(shopManifest({ staff: "invite", member: "invite" }), ENV_OFF());
    expect((await adminRegister("first")).status).toBe(200);
    expect((await passkeyOptions("bob")).status).toBe(403);
    const code = seedInvitation("bob", "editor");
    expect((await passkeyOptions("bob", code)).status).toBe(200);
  });

  test("(16b) passkey の options —— 有効な招待があればログイン名の 409 も飛ばす", async () => {
    await makeApp(shopManifest({ staff: "invite", member: "invite" }), ENV_ON());
    expect((await adminRegister("first")).status).toBe(200);
    expect((await passkeyOptions("first")).status).toBe(409);
    const code = seedInvitation("first", "editor");
    expect((await passkeyOptions("first", code)).status).toBe(200);
  });

  test("(16c) passkey の options —— 招待を持たない相手には今日どおり 409 / 403 を返し分ける(`I-G23` は成り立たない)", async () => {
    await makeApp(shopManifest({ staff: "invite", member: "invite" }), ENV_ON());
    expect((await adminRegister("first")).status).toBe(200);
    // **【限界。`ADR-0337` §限界2】** **`409` が返る時点で「そのログイン名は実在する」が
    // 漏れている。** **塞ぐには options に `user_kind` を足す必要があり、それは
    // `ADR-0334` 限定14 の読み方を3通り目にするので、門A への差し戻しになる。**
    expect((await passkeyOptions("first")).status).toBe(409);
    expect((await passkeyOptions("stranger")).status).toBe(200);
  });
});

// ===========================================================================
// (T04-14)(T04-15) 宣言していないアプリは着手前と1バイトも変わらない(`I-G3` / 限定13)
// ===========================================================================

describe("(T04-E) 宣言していないアプリ(`I-G3` / `ADR-0337` 限定13)", () => {
  test("(14) `invitation_code` を送っても、着手前どおり 200 でユーザが作られる", async () => {
    await makeApp(shopManifest(), ENV_ON());
    const res = await selfRegister("buyer", "member", "ZZZZZZZZ");
    expect(res.status).toBe(200);
    expect(countUsers()).toBe(1);
    // 運営経路も同じ(422 にしない)。
    expect((await adminRegister("staff", "ZZZZZZZZ")).status).toBe(200);
    expect(countUsers()).toBe(2);
  });

  test("(15) 招待コードを本文に載せなければ、招待の表を1度も触らない —— 期限切れの行が残る", async () => {
    await makeApp(shopManifest(), ENV_ON());
    seedInvitation("stale", "editor");
    expireInvitation("stale");
    // **コードを1つも送らない登録。** **掃除も検索も1度も走らない**(`ADR-0337` 限定13)。
    expect((await selfRegister("buyer", "member")).status).toBe(200);
    expect((await adminRegister("staff")).status).toBe(200);
    expect((await passkeyOptions("pk")).status).toBe(200);
    // **掃除が走っていれば消えている行である。**
    expect(invitationRow("stale")).not.toBeNull();
  });

  test("(15c) 【裁定 `M3-4`】コードを載せれば、宣言していないアプリでも掃除が走る", async () => {
    await makeApp(shopManifest(), ENV_ON());
    seedInvitation("stale", "editor");
    expireInvitation("stale");
    // **旧の設計(`declaresInvite` の関門)ではここで行が残っていた。**
    // **裁定 `M3-4` で落としたので、今日は宣言が無くても掃除が走る。**
    expect((await selfRegister("buyer", "member", "ZZZZZZZZ")).status).toBe(200);
    expect(invitationRow("stale")).toBeNull();
  });

  test("(15b) 宣言したアプリでは、招待コードを添えた登録が掃除を走らせる(限定12)", async () => {
    await makeApp(shopManifest({ staff: "invite", member: "invite" }), ENV_ON());
    expect((await adminRegister("first")).status).toBe(200);
    seedInvitation("stale", "editor");
    expireInvitation("stale");
    expect((await selfRegister("bob", "member", "ZZZZZZZZ")).status).toBe(403);
    expect(invitationRow("stale")).toBeNull();
  });
});

// ===========================================================================
// (T05) 消費とユーザ作成を同一トランザクションに(`ADR-0336` 限定17 / `ADR-0337` 限定11)
// ===========================================================================

describe("(T05) 消費とユーザ作成は1つのトランザクションである", () => {
  test("(T05-a) 同じコードで2回叩くと、2回目が失敗し、ユーザは1人しか増えない(実 API)", async () => {
    await makeApp(shopManifest({ staff: "invite", member: "invite" }), ENV_ON());
    expect((await adminRegister("first")).status).toBe(200);
    const before = countUsers();
    const code = seedInvitation("bob", "editor");
    const one = await selfRegister("bob", "member", code);
    const two = await selfRegister("bob", "member", code);
    expect(one.status).toBe(200);
    expect(two.status).toBe(403);
    expect(countUsers()).toBe(before + 1);
  });

  test("(T05-b) ユーザ作成が失敗したら、招待の印も残らない(巻き戻る)", async () => {
    await makeApp(shopManifest({ staff: "invite", member: "invite" }), ENV_ON());
    const store = AuthStore.openForApp(dataRoot, APP_ID);
    try {
      store.createUser({ username: "clash", role: "viewer" });
      store.issueInvitation({ username: "clash", role: "editor", issuedBy: "seed" });
      const before = store.countUsers();
      // **ログイン名が既に在るので `createUser` が UNIQUE で落ちる。**
      // **同一トランザクションに入っていれば、印(`used_at`)も一緒に巻き戻る。**
      expect(() =>
        store.consumeInvitationAndCreateUser("clash", { username: "clash", role: "member" }),
      ).toThrow();
      expect(store.countUsers()).toBe(before);
      expect(store.findInvitation("clash")?.usedAt).toBeNull();
    } finally {
      store.close();
    }
  });

  test("(T05-c) 同じ招待をカーネル層から2回消費すると、2回目が投げる", async () => {
    await makeApp(shopManifest({ staff: "invite", member: "invite" }), ENV_ON());
    const store = AuthStore.openForApp(dataRoot, APP_ID);
    try {
      store.issueInvitation({ username: "bob", role: "editor", issuedBy: "seed" });
      store.consumeInvitationAndCreateUser("bob", { username: "bob", role: "member" });
      expect(store.countUsers()).toBe(1);
      expect(() =>
        store.consumeInvitationAndCreateUser("bob", { username: "bob2", role: "member" }),
      ).toThrow();
      expect(store.countUsers()).toBe(1);
    } finally {
      store.close();
    }
  });

  test("(T05-d) `AuthStore` に足したメソッドは1本だけである(`ADR-0337` 限定11)", () => {
    const text = readFileSync(join(import.meta.dir, "..", "auth", "store.ts"), "utf8");
    const live = text
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"));
    expect(live.filter((line) => line.includes("consumeInvitationAndCreateUser("))).toHaveLength(1);
    // **`createUserSafely` の 409 の扱いは今日のままである**(限定11)。
    expect(source().includes("usernameTakenError(input.username)")).toBe(true);
  });
});

// ===========================================================================
// (T06) 招待に書かれた役割を付与する(`I-G22` / 裁定 `M0-2` / `ADR-0337` §3-6)
// ===========================================================================

describe("(T06) 立場は招待の行から来る(`I-G22`)", () => {
  test("(11) 招待で登録した人は、招待に書かれた役割を付与表に持つ", async () => {
    await makeApp(shopManifest({ staff: "invite", member: "invite" }), ENV_ON());
    expect((await adminRegister("first")).status).toBe(200);
    const code = seedInvitation("bob", "editor");
    expect((await selfRegister("bob", "member", code)).status).toBe(200);
    expect(effectiveRoles("bob")).toContain("editor");
  });

  test("(11b) 本文に `role` を書いても1度も読まれない(`ADR-0337` 限定6)", async () => {
    await makeApp(shopManifest({ staff: "invite", member: "invite" }), ENV_ON());
    expect((await adminRegister("first")).status).toBe(200);
    const code = seedInvitation("bob", "viewer");
    const res = await server.request(
      postJson(`/api/apps/${APP_ID}/auth/signup/password/register`, {
        username: "bob",
        password: "pw-123456",
        user_kind: "member",
        invitation_code: code,
        // **昇格を狙った自己申告。** **登録の4経路は本文の `role` を1つも参照しない。**
        role: "owner",
      }),
    );
    expect(res.status).toBe(200);
    const roles = effectiveRoles("bob");
    expect(roles).not.toContain("owner");
    expect(roles).toContain("viewer");
  });

  test("(11c) 招待で登録した人の応答本文の `roles` にも招待の役割が載る", async () => {
    await makeApp(shopManifest({ staff: "invite", member: "invite" }), ENV_ON());
    expect((await adminRegister("first")).status).toBe(200);
    const code = seedInvitation("bob", "editor");
    const res = await selfRegister("bob", "member", code);
    const body = (await res.json()) as { user: { role: string; roles: string[] } };
    expect(body.user.roles).toContain("editor");
  });

  test("(12) 最初の1人は持ち主になり、招待の役割はそれに足される(裁定 `M0-2` / `D-V8-82`)", async () => {
    await makeApp(shopManifest({ staff: "invite", member: "invite" }), ENV_ON());
    // **運営者を1人も作らずに招待を置く**(この人が最初の1人になる)。
    const code = seedInvitation("solo", "editor");
    expect(countUsers()).toBe(0);
    const res = await selfRegister("solo", "member", code);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { role: string; roles: string[] } };
    // **列は `owner` に据わる**(`bootstrapFirstUserOwner` を1バイトも変えていない)。
    expect(body.user.role).toBe("owner");
    // **名乗った役割も招待の役割も、どちらも付与表へ足される。**
    expect(body.user.roles).toContain("owner");
    expect(body.user.roles).toContain("member");
    expect(body.user.roles).toContain("editor");
    // **【限界。`ADR-0337` §限界1】「招待に書かれたとおりの立場になる」は、
    // 最初の1人については成り立たない** —— **列は招待の役割ではなく `owner` である。**
  });

  test("(T06-a) `bootstrapFirstUserOwner` の本体を1バイトも変えていない(`ADR-0337` 限定7)", () => {
    const text = source();
    const start = text.indexOf("\nfunction bootstrapFirstUserOwner(");
    const body = text.slice(start + 1, text.indexOf("\n}\n", start) + 2);
    expect(body.includes("invitation")).toBe(false);
    expect(body.includes("grantRole(user.id, claimed)")).toBe(true);
  });

  test("(T06-b) 役割の付与は招待の行からだけ来る(呼び出しは2経路に1箇所ずつ)", () => {
    const live = liveLines();
    expect(
      live.filter((line) => line.includes("store.grantRole(user.id, invitation.role)")),
    ).toHaveLength(2);
  });
});

// ===========================================================================
// (17)〜(19) メインの設計追補1 が足させた検査
// ===========================================================================

describe("(T04-F) 追補1 が足させた3本", () => {
  test("(17) 招待で登録した人は、そのとき決めたパスワードで実際にログインできる", async () => {
    await makeApp(shopManifest({ staff: "invite", member: "invite" }), ENV_ON());
    expect((await adminRegister("first")).status).toBe(200);
    const code = seedInvitation("bob", "editor");
    expect((await selfRegister("bob", "member", code)).status).toBe(200);
    // **`I-G21`(その場でパスワードを決める)は却下だが、却下は「実証しなくてよい」ではない** ——
    // **既存の password 登録経路がそのまま担っていることを、ログインまで通して示す。**
    const login = await server.request(
      postJson(`/api/apps/${APP_ID}/auth/password/login`, {
        username: "bob",
        password: "pw-123456",
      }),
    );
    expect(login.status).toBe(200);
    const body = (await login.json()) as { user: { username: string; roles: string[] } };
    expect(body.user.username).toBe("bob");
    expect(body.user.roles).toContain("editor");
  });

  test("(18) 招待の検証を101回叩くと 429 になる(既存5行のレート制限が掛かる)", async () => {
    await makeApp(shopManifest({ staff: "invite", member: "invite" }), ENV_ON());
    // **新しい口を1本も作っていないので、`src/server/app.ts` の5行がそのまま掛かる**
    // (`ADR-0336` 限定20 / `ADR-0337` 限定2。**6行目を足していない**)。
    // 固定窓60秒・上限100。
    let last = 0;
    for (let i = 0; i < 101; i += 1) {
      const res = await server.request(
        postJson(`/api/apps/${APP_ID}/auth/password/register`, {
          username: `probe-${i}`,
          password: "pw-123456",
          invitation_code: "ZZZZZZZZ",
        }),
      );
      last = res.status;
    }
    expect(last).toBe(429);
  }, 30_000);

  test("(19) env=false × 宣言なし × 有効な招待 → 200(着手前は 403。裁定 `M3-4`)", async () => {
    await makeApp(shopManifest(), ENV_OFF());
    expect((await adminRegister("first")).status).toBe(200); // ブートストラップ例外
    // **着手前(`23829f9` / `5db56b7`)はここが 403 だった。**
    // **これが、宣言していないアプリで着手前と応答が変わる**唯一の1通り**である。**
    expect((await selfRegister("bob", "member")).status).toBe(403);
    const code = seedInvitation("bob", "editor");
    expect((await selfRegister("bob", "member", code)).status).toBe(200);
    expect(effectiveRoles("bob")).toContain("editor");
  });
});
