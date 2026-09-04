/**
 * **既定の証明と、締め出しの防ぎ方**(`V8-M4-T01`〜`T04`。台帳 `I-G3` / `I-G7` / `I-G24` /
 * `I-G25`。[`ADR-0334`](../../docs/adr/0334-role-signup-mode-declaration.md) 限定1 / 限定3 /
 * [`ADR-0335`](../../docs/adr/0335-signup-single-predicate-and-env-precedence.md) 限定3 /
 * 限定8 / 限定10)。
 * **本物の SQLite と実 HTTP(`app.request()`)で測る**(モックを置かない)。
 *
 * ## この検査が固定するもの
 *
 * 1. **env で閉じたときの `403` の `hint` が、招待という道が在ることを書いていること**
 *    (`ADR-0335` 限定8。裁定 `M4-1`)。**`message` は1バイトも変わっていないこと。**
 * 2. **招待の消費とユーザ作成のトランザクションが `IMMEDIATE` であること**(裁定 `M4-2`。
 *    根拠は `ADR-0018`)。
 * 3. **今日は偽になったコード注釈に、訂正が隣へ置かれていること**(裁定 `M4-3`)。
 *    **旧文は1バイトも消していない。**
 * 4. **`ST_AUTH_ALLOW_REGISTRATION=false` の4通り**(`ADR-0335` 限定3 / §限界2)。
 * 5. **持ち主が0人になったアプリからの復帰の2通り**(`I-G25`)。
 *
 * ## この検査が測らないもの(**誇張しない**)
 *
 * 1. **本物の TCP を1本も通していない。** **`curl` の実測は
 *    `docs/plan/v8/records/v8-m4.md` §5 / §7 が別に持つ。**
 * 2. **着手前 sha(`23829f9`)を1度も走らせていない。** **既定の証明(`I-G3`)の48件は
 *    実 HTTP で別に採ってある** —— **この検査はその判定手段ではない**
 *    (`ADR-0334` 限定3 が `bun test` の緑を判定手段にすることを逐語で禁じている)。
 * 3. **`data/apps/` の実地3本(`m33` / `m34_fresh` / `support`)に1バイトも書いていない。**
 * 4. **同時実行を1度も測っていない。** **`IMMEDIATE` にしたことの効果は測っていない** ——
 *    **測ったのは「そう書いてあること」と「直列の2回で2回目が落ちること」だけである。**
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

const routesSource = (): string => readFileSync(join(import.meta.dir, "auth-routes.ts"), "utf8");
const storeSource = (): string =>
  readFileSync(join(import.meta.dir, "..", "auth", "store.ts"), "utf8");
const invitationsSource = (): string =>
  readFileSync(join(import.meta.dir, "..", "auth", "invitations.ts"), "utf8");

/** 注釈(`//` / `*`)を除いた「実際に動く行」だけを返す。 */
const liveLinesOf = (text: string): string[] =>
  text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"));

// ===========================================================================
// (T01) env で閉じたときの 403 の文面(`ADR-0335` 限定8 / 裁定 `M4-1`)
// ===========================================================================

/** `registrationClosedError` の宣言だけを切り出す(**doc コメントを含まない**)。 */
const closedDeclaration = (): string => {
  const text = routesSource();
  const start = text.indexOf("const registrationClosedError: ValidationError = {");
  expect(start).toBeGreaterThanOrEqual(0);
  return text.slice(start, text.indexOf("};", start));
};

describe("(T01) env で閉じたときの 403 の文面(`ADR-0335` 限定8)", () => {
  test("(T01-a) `message` は着手前の逐語のままである(1バイトも変えていない)", () => {
    const body = closedDeclaration();
    expect(body.includes('message: "新規登録は許可されていません。"')).toBe(true);
  });

  test("(T01-b) `hint` は、有効な招待があればこの設定でも登録できることを書く", () => {
    const hint = closedDeclaration().slice(closedDeclaration().indexOf("hint:"));
    expect(hint.includes("招待")).toBe(true);
    expect(hint.includes("登録できます")).toBe(true);
    // **旧文を1バイトも消していない**(`ADR-0335` 限定8)。
    expect(hint.includes("ST_AUTH_ALLOW_REGISTRATION")).toBe(true);
  });

  test("(T01-c) `hint` は `I-G23` が漏らすなと言った3つを1文字も述べない", () => {
    const hint = closedDeclaration().slice(closedDeclaration().indexOf("hint:"));
    // **述べてはならない**: そのアプリが招待制か / その相手が招待されているか /
    // そのログイン名が実在するか。
    for (const leak of [
      "このアプリは招待された人だけ",
      "招待されています",
      "招待されていません",
      "招待がありません",
      "既に使われています",
      "登録済み",
      "存在しません",
    ]) {
      expect(hint.includes(leak)).toBe(false);
    }
  });

  test("(T01-d) 旧の `hint` が逐語でコメントに残っている", () => {
    const text = routesSource();
    const old =
      "管理者に ST_AUTH_ALLOW_REGISTRATION を有効化してもらうか、既存アカウントでログインしてください。";
    // **旧文は今日、新しい `hint` の中と、訂正コメントの中の2箇所に在る。**
    const commentLines = text
      .split("\n")
      .filter((line) => line.trimStart().startsWith("//") || line.trimStart().startsWith("*"));
    expect(commentLines.some((line) => line.includes(old))).toBe(true);
  });

  test("(T01-e) 実 HTTP: env=false の 403 の本文に、招待という道が載る", async () => {
    await makeApp(shopManifest(), ENV_OFF());
    // **1人目は例外で通るので、先に1人作ってから2人目で 403 を採る。**
    expect((await adminRegister("first")).status).toBe(200);
    const closed = await adminRegister("second");
    expect(closed.status).toBe(403);
    const body = (await closed.json()) as { errors: { message: string; hint: string }[] };
    expect(body.errors[0]?.message).toBe("新規登録は許可されていません。");
    expect(body.errors[0]?.hint.includes("招待")).toBe(true);
    expect(body.errors[0]?.hint.includes("登録できます")).toBe(true);
  });
});

// ===========================================================================
// (T02) トランザクションは IMMEDIATE(裁定 `M4-2`。根拠 `ADR-0018`)
// ===========================================================================

describe("(T02) 招待の消費とユーザ作成は `IMMEDIATE` トランザクションである", () => {
  test("(T02-a) `src/auth/store.ts` の `.immediate` は1件ちょうどである", () => {
    const hits = liveLinesOf(storeSource()).filter((line) => line.includes(".immediate"));
    expect(hits).toHaveLength(1);
  });

  test("(T02-b) その1件は `consumeInvitationAndCreateUser` の中に在る", () => {
    const text = storeSource();
    const start = text.indexOf("  consumeInvitationAndCreateUser(");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = text.slice(start, text.indexOf("\n  }", start));
    expect(liveLinesOf(body).some((line) => line.includes(".immediate"))).toBe(true);
  });

  test("(T02-c) 実 API: 同じコードで2回叩くと2回目が落ち、ユーザは1人しか増えない", async () => {
    await makeApp(shopManifest({ member: "invite" }), ENV_ON());
    expect((await adminRegister("owner1")).status).toBe(200);
    const code = seedInvitation("bob", "member");
    expect((await selfRegister("bob", "member", code)).status).toBe(200);
    const again = await selfRegister("bob2", "member", code);
    expect(again.status).toBe(403);
    expect(countUsers()).toBe(2);
  });
});

// ===========================================================================
// (T03) 今日は偽になったコード注釈(裁定 `M4-3`)
// ===========================================================================

describe("(T03) 今日は偽になったコード注釈に、訂正が隣に置かれている", () => {
  const STALE = "使えない招待を出せる状態";
  const MARKER = "V8-M4-T03";

  test("(T03-a) 旧文を1バイトも消していない(3ファイルとも残っている)", () => {
    expect(routesSource().includes(STALE)).toBe(true);
    expect(invitationsSource().includes(STALE)).toBe(true);
    expect(storeSource().includes(STALE)).toBe(true);
  });

  /** その行の前後 `span` 行以内に訂正の印が在るか。 */
  const correctedNear = (text: string, needle: string, span = 14): boolean[] => {
    const lines = text.split("\n");
    const at = lines.flatMap((line, i) => (line.includes(needle) ? [i] : []));
    expect(at.length).toBeGreaterThan(0);
    return at.map((i) =>
      lines
        .slice(Math.max(0, i - span), i + span)
        .join("\n")
        .includes(MARKER),
    );
  };

  test("(T03-b) `src/server/auth-routes.ts` の嘘3箇所の隣に訂正が在る", () => {
    const text = routesSource();
    // **今日 偽である文はこの3つである**(自分で `grep` して数え直した)。
    // 1. `signupAllowed` の doc の「したがって `invited` は常に `false`」
    // 2. `invited` 引数の doc の「`V8-M3` がここに本物の検証を差し込む」
    // 3. 発行の口の「すなわち今日在るのは『使えない招待を出せる状態』である」
    for (const needle of [
      "常に `false` であり、(b) の枝は1度も真にならない",
      "**`V8-M3` がここに本物の検証を差し込む。**",
      "すなわち今日在るのは「使えない招待を出せる状態」である",
    ]) {
      expect(correctedNear(text, needle).every(Boolean)).toBe(true);
    }
  });

  test("(T03-c) `src/auth/invitations.ts` と `src/auth/store.ts` にも訂正が在る", () => {
    expect(correctedNear(invitationsSource(), STALE).every(Boolean)).toBe(true);
    expect(correctedNear(storeSource(), STALE).every(Boolean)).toBe(true);
  });

  test("(T03-d) 反実仮想の1件には訂正を足していない(嘘ではないため)", () => {
    // **`invitationFrom` の doc に在る「`V8-M2` が自ら欠陥と呼んだ…を別の形で残す」は、
    // 採らなかった設計の帰結を述べた文であり、今日の状態についての主張ではない。**
    // **したがって訂正の対象にしていない。** **この判断を検査として固定する。**
    const text = routesSource();
    const line = text.split("\n").find((l) => l.includes("自ら欠陥と呼んだ"));
    expect(line).toBeDefined();
    expect(line?.includes(STALE)).toBe(true);
  });
});

// ===========================================================================
// 実 HTTP の土台(**本物の SQLite。モックを置かない**)
// ===========================================================================

const APP_ID = "lockout-shop";
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
 * **`staff` に `"invite"` を渡すと予約3語にも書かれ、4本すべてが招待制になる**(= 全員制限)。
 */
function shopManifest(modes: { member?: SignupMode; staff?: SignupMode } = {}): Manifest {
  const withMode = (role: Record<string, unknown>, mode: SignupMode | undefined) =>
    mode === undefined ? role : { ...role, signup: mode };
  return {
    app: {
      id: APP_ID,
      name: "締め出しの店",
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

/** **全員制限**(予約3語 + 独自の役割のすべてに `signup: "invite"`)。 */
const lockedManifest = (): Manifest => shopManifest({ member: "invite", staff: "invite" });

async function makeApp(manifest: Manifest, config?: AuthConfig): Promise<void> {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-lockout-"));
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, "締め出しの店", { app_id: APP_ID });
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

const PASSWORD = "pw-123456";

/** 運営が人を足す口(`ADMIN_SIGNUP`)。 */
async function adminRegister(username: string, code?: string): Promise<Response> {
  return await server.request(
    postJson(`/api/apps/${APP_ID}/auth/password/register`, {
      username,
      password: PASSWORD,
      ...(code === undefined ? {} : { invitation_code: code }),
    }),
  );
}

/** セルフ登録の口(`SELF_SIGNUP`)。 */
async function selfRegister(username: string, userKind?: string, code?: string): Promise<Response> {
  return await server.request(
    postJson(`/api/apps/${APP_ID}/auth/signup/password/register`, {
      username,
      password: PASSWORD,
      ...(userKind === undefined ? {} : { user_kind: userKind }),
      ...(code === undefined ? {} : { invitation_code: code }),
    }),
  );
}

async function login(username: string): Promise<Response> {
  return await server.request(
    postJson(`/api/apps/${APP_ID}/auth/password/login`, { username, password: PASSWORD }),
  );
}

/** **HTTP を通さずに**招待を1件置く(発行の口を通らずに済ませるため)。 */
function seedInvitation(username: string, role: Role): string {
  const store = AuthStore.openForApp(dataRoot, APP_ID);
  try {
    return store.issueInvitation({ username, role, issuedBy: "seed" }).code;
  } finally {
    store.close();
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

function countOwners(): number {
  const store = AuthStore.openForApp(dataRoot, APP_ID);
  try {
    return store.countOwners();
  } finally {
    store.close();
  }
}

function roleColumnOf(username: string): string | undefined {
  const store = AuthStore.openForApp(dataRoot, APP_ID);
  try {
    return store.findUserByUsername(username)?.role;
  } finally {
    store.close();
  }
}

/**
 * **持ち主を0人にする**(`I-G25` の (2) を作るため)。
 * **`countOwners` は `_auth_users.role` と `_auth_user_roles` の両方を見るので、
 * 片方だけを落としても0人にならない**(実測)。
 */
function stripOwners(): void {
  const db = new Database(appDbPath(dataRoot, APP_ID));
  try {
    db.query(`UPDATE "_auth_users" SET "role" = 'viewer'`).run();
    db.query(`DELETE FROM "_auth_user_roles" WHERE "role" = 'owner'`).run();
  } finally {
    db.close();
  }
}

const ENV_ON = (): AuthConfig => loadAuthConfig({ ST_AUTH_ALLOW_REGISTRATION: "true" });
const ENV_OFF = (): AuthConfig => loadAuthConfig({ ST_AUTH_ALLOW_REGISTRATION: "false" });

// ===========================================================================
// (C) `ST_AUTH_ALLOW_REGISTRATION=false` の4通り(`ADR-0335` 限定3 / §限界2)
// ===========================================================================

describe("(C) `ST_AUTH_ALLOW_REGISTRATION=false` の下での登録", () => {
  test("(C-1a) env=false × ユーザ0人 × 管理経路 × 宣言なし = 200(`owner`)", async () => {
    await makeApp(shopManifest(), ENV_OFF());
    const res = await adminRegister("c1_first");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { role: string } }).user.role).toBe("owner");
  });

  test("(C-1b) env=false × ユーザ0人 × 管理経路 × 全員制限 = 200(`owner`)", async () => {
    await makeApp(lockedManifest(), ENV_OFF());
    const res = await adminRegister("c1d_first");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { role: string } }).user.role).toBe("owner");
  });

  test("(C-2a) env=false × ユーザ0人 × セルフ経路 × 宣言なし = 403(限定3)", async () => {
    await makeApp(shopManifest(), ENV_OFF());
    expect((await selfRegister("c2_first", "member")).status).toBe(403);
    expect(countUsers()).toBe(0);
  });

  test("(C-2b) env=false × ユーザ0人 × セルフ経路 × 全員制限 = 403(限定3)", async () => {
    await makeApp(lockedManifest(), ENV_OFF());
    expect((await selfRegister("c2d_first", "member")).status).toBe(403);
    expect(countUsers()).toBe(0);
  });

  test("(C-3) env=false × ユーザ1人以上 × 有効な招待 × セルフ経路 = 200(`member`)", async () => {
    await makeApp(lockedManifest(), ENV_OFF());
    expect((await adminRegister("c3_owner")).status).toBe(200);
    // **招待なしのセルフ経路は畳んだ 403 のままである**(比較の土台)。
    expect((await selfRegister("c3_nobody", "member")).status).toBe(403);
    const code = seedInvitation("c3_invitee", "member");
    const res = await selfRegister("c3_invitee", "member", code);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { role: string } }).user.role).toBe("member");
  });

  test("(C-4a) env=false × 宣言なし × ユーザ1人以上 × 招待なし = 403(比較の土台)", async () => {
    await makeApp(shopManifest(), ENV_OFF());
    expect((await adminRegister("c4_owner")).status).toBe(200);
    expect((await adminRegister("c4_nobody")).status).toBe(403);
  });

  test("(C-4b) env=false × 宣言なし × 有効な招待 × 管理経路 = 200", async () => {
    await makeApp(shopManifest(), ENV_OFF());
    expect((await adminRegister("c4_owner")).status).toBe(200);
    const code = seedInvitation("c4_invitee", "member");
    expect((await adminRegister("c4_invitee", code)).status).toBe(200);
  });

  test("(C-4c) env=false × 宣言なし × 有効な招待 × セルフ経路 = 200", async () => {
    await makeApp(shopManifest(), ENV_OFF());
    expect((await adminRegister("c4_owner")).status).toBe(200);
    const code = seedInvitation("c4_invitee2", "member");
    const res = await selfRegister("c4_invitee2", "member", code);
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// (D) 持ち主が0人になったアプリからの復帰(`I-G25`)
// ===========================================================================

describe("(D) 持ち主0人からの復帰", () => {
  test("(D-1) ユーザ0人: 1人目が持ち主になる(env=false でも)", async () => {
    await makeApp(lockedManifest(), ENV_OFF());
    expect(countUsers()).toBe(0);
    expect(countOwners()).toBe(0);
    expect((await adminRegister("d1_first")).status).toBe(200);
    expect(countOwners()).toBe(1);
    expect(roleColumnOf("d1_first")).toBe("owner");
  });

  test("(D-2) ユーザ2人・持ち主0人: 持ち主でない人のログインだけで最古が持ち主に戻る", async () => {
    await makeApp(lockedManifest(), ENV_OFF());
    expect((await adminRegister("d2_owner")).status).toBe(200);
    const code = seedInvitation("d2_invitee", "member");
    expect((await selfRegister("d2_invitee", "member", code)).status).toBe(200);

    stripOwners();
    expect(countOwners()).toBe(0);

    // **持ち主でない2人目がログインするだけでよい。**
    // **招待制を宣言していても env=false でも、ログインの口には招待の判定が1つも掛からない。**
    expect((await login("d2_invitee")).status).toBe(200);
    expect(countOwners()).toBe(1);
    expect(roleColumnOf("d2_owner")).toBe("owner");
  });

  test("(D-3) パスワード再設定の口は今日1本も無い(復帰路の限界)", () => {
    const routeFiles = ["app.ts", "auth-routes.ts", "change-routes.ts", "inbound-route.ts"];
    const all = routeFiles
      .map((name) => readFileSync(join(import.meta.dir, name), "utf8"))
      .join("\n");
    const routes = all.match(/app\.(get|post|patch|delete|put)\("[^"]+"/g) ?? [];
    expect(routes.length).toBeGreaterThan(0);
    const reset = routes.filter((r) => /reset|forgot|recover/i.test(r));
    expect(reset).toEqual([]);
    // **`password` を含む口は4本ちょうど**(register 2 / login / change)。
    expect(routes.filter((r) => r.includes("password"))).toHaveLength(4);
  });
});
