/**
 * 認証エンドポイント(`/api/apps/inventory/auth/*`)の JSON 契約テスト(V1-M3-T01 / ADR-0014 §6)。
 *
 * WebAuthn の実 assertion はブラウザのオーセンティケータが要るため E2E(仮想
 * オーセンティケータ)に委ねる。ここでは実オーセンティケータを要しない範囲 ——
 * password の登録/ログイン/ログアウト/me の往復、options 生成、409/403/401、
 * Origin 検査(403)、セッション固定対策(登録とログインで別 ID)—— を固定する。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type AuthConfig, loadAuthConfig } from "../auth/config.ts";
import { applyManifest, createApp, KernelMetaStore } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { withDefaultRoleRules } from "./test-helpers.ts";

const ORIGIN = "http://localhost:5173";

/** 認証はアプリ単位なので、テスト対象の app を1つ用意してその配下エンドポイントを叩く。 */
const APP_ID = "inventory";

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

async function makeApp(config?: AuthConfig): Promise<void> {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-auth-routes-"));
  // auth handler は app 実在を要求する(不存在は 404)ので、台帳にアプリを1つ登録する。
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "備品管理", { app_id: APP_ID });
  } finally {
    store.close();
  }
  app = createServerApp(config === undefined ? { dataRoot } : { dataRoot, authConfig: config });
}

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function postJson(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

/** Set-Cookie 群から特定 cookie の値を取り出す。 */
function cookieValue(response: Response, name: string): string | undefined {
  for (const raw of response.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const [k, v] = (pair ?? "").split("=");
    if (k === name) {
      return v;
    }
  }
  return undefined;
}

describe("password 登録/ログイン/me/logout", () => {
  beforeEach(async () => {
    await makeApp();
  });

  test("register → 200 {user} + st_session、me が本人を返し、logout で失効する", async () => {
    const registered = await app.request(
      postJson("/api/apps/inventory/auth/password/register", {
        username: "alice",
        password: "pw-123456",
      }),
    );
    expect(registered.status).toBe(200);
    const regBody = (await registered.json()) as {
      user: { id: string; username: string; displayName: null };
    };
    expect(regBody.user.username).toBe("alice");
    expect(regBody.user.displayName).toBeNull();
    expect(typeof regBody.user.id).toBe("string");
    const session = cookieValue(registered, "st_session");
    expect(session).toBeDefined();

    // me は本人を返す。
    const me = await app.request(
      new Request("http://localhost/api/apps/inventory/auth/me", {
        headers: { cookie: `st_session=${session}` },
      }),
    );
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { username: string } }).user.username).toBe("alice");

    // logout → 200 {ok:true}。以後 me は 401。
    const loggedOut = await app.request(
      new Request("http://localhost/api/apps/inventory/auth/logout", {
        method: "POST",
        headers: { origin: ORIGIN, cookie: `st_session=${session}` },
      }),
    );
    expect(loggedOut.status).toBe(200);
    expect(await loggedOut.json()).toEqual({ ok: true });

    const meAfter = await app.request(
      new Request("http://localhost/api/apps/inventory/auth/me", {
        headers: { cookie: `st_session=${session}` },
      }),
    );
    expect(meAfter.status).toBe(401);
  });

  test("login は正しい資格情報で 200、誤りは 401(ユーザ有無を漏らさない)", async () => {
    const reg = await app.request(
      postJson("/api/apps/inventory/auth/password/register", {
        username: "bob",
        password: "correct-horse",
      }),
    );
    const registerSession = cookieValue(reg, "st_session");

    const ok = await app.request(
      postJson("/api/apps/inventory/auth/password/login", {
        username: "bob",
        password: "correct-horse",
      }),
    );
    expect(ok.status).toBe(200);
    const loginSession = cookieValue(ok, "st_session");
    // セッション固定対策(ADR-0014 §3): ログインは必ず新規 ID を発行する。
    expect(loginSession).toBeDefined();
    expect(loginSession).not.toBe(registerSession);

    const wrongPw = await app.request(
      postJson("/api/apps/inventory/auth/password/login", { username: "bob", password: "nope" }),
    );
    expect(wrongPw.status).toBe(401);

    const unknownUser = await app.request(
      postJson("/api/apps/inventory/auth/password/login", {
        username: "ghost",
        password: "whatever",
      }),
    );
    expect(unknownUser.status).toBe(401);
    // 文面はユーザの有無を漏らさない(両者同一)。
    expect(await wrongPw.json()).toEqual(await unknownUser.json());
  });

  test("既存 username の再登録は 409(乗っ取り経路を塞ぐ。ADR-0014 §9)", async () => {
    await app.request(
      postJson("/api/apps/inventory/auth/password/register", {
        username: "carol",
        password: "p1234567",
      }),
    );
    const dup = await app.request(
      postJson("/api/apps/inventory/auth/password/register", {
        username: "carol",
        password: "other-pw",
      }),
    );
    expect(dup.status).toBe(409);
  });

  test("username / password 欠落は 400", async () => {
    expect(
      (await app.request(postJson("/api/apps/inventory/auth/password/register", { password: "x" })))
        .status,
    ).toBe(400);
    expect(
      (await app.request(postJson("/api/apps/inventory/auth/password/register", { username: "x" })))
        .status,
    ).toBe(400);
  });
});

describe("登録ポリシー(ADR-0014 §8)", () => {
  test("allowRegistration=false でも初回ユーザは登録でき、2人目は 403", async () => {
    await makeApp(loadAuthConfig({ ST_AUTH_ALLOW_REGISTRATION: "false" }));

    const first = await app.request(
      postJson("/api/apps/inventory/auth/password/register", {
        username: "first",
        password: "p1234567",
      }),
    );
    expect(first.status).toBe(200); // 初回は常に許可。

    const second = await app.request(
      postJson("/api/apps/inventory/auth/password/register", {
        username: "second",
        password: "p1234567",
      }),
    );
    expect(second.status).toBe(403); // 2人目は登録閉鎖。
  });
});

describe("CSRF: Origin 検査(ADR-0014 §5)", () => {
  beforeEach(async () => {
    await makeApp();
  });

  test("状態変更に別オリジンの Origin を付けると 403", async () => {
    const response = await app.request(
      postJson(
        "/api/apps/inventory/auth/password/register",
        { username: "dave", password: "p1234567" },
        { origin: "http://evil.example" },
      ),
    );
    expect(response.status).toBe(403);
  });
});

describe("Passkey options 生成", () => {
  beforeEach(async () => {
    await makeApp();
  });

  test("register/options は challenge と rp.id を返し st_pending を張る", async () => {
    const response = await app.request(
      postJson("/api/apps/inventory/auth/passkey/register/options", { username: "erin" }),
    );
    expect(response.status).toBe(200);
    const options = (await response.json()) as {
      challenge: string;
      rp: { id: string };
      user: { name: string };
    };
    expect(typeof options.challenge).toBe("string");
    expect(options.rp.id).toBe("localhost");
    expect(options.user.name).toBe("erin");
    expect(cookieValue(response, "st_pending")).toBeDefined();
  });

  test("register/options は既存 username に 409 を返す", async () => {
    await app.request(
      postJson("/api/apps/inventory/auth/password/register", {
        username: "frank",
        password: "p1234567",
      }),
    );
    const response = await app.request(
      postJson("/api/apps/inventory/auth/passkey/register/options", { username: "frank" }),
    );
    expect(response.status).toBe(409);
  });

  test("login/options は username 無しでも challenge を返す(discoverable)", async () => {
    const response = await app.request(
      postJson("/api/apps/inventory/auth/passkey/login/options", {}),
    );
    expect(response.status).toBe(200);
    const options = (await response.json()) as { challenge: string };
    expect(typeof options.challenge).toBe("string");
    expect(cookieValue(response, "st_pending")).toBeDefined();
  });
});

// --- V2-M1-T02: 顧客サインアップ経路の分離(EC-G2 / ADR-0033 §1b・限定2)------------------
//
// 顧客セルフサインアップは別経路(/auth/customer/...)で、既定ロールを常に customer に固定する。
// 昇格不可を構造で保証する: (a) 本文から role を受け取らない、(b) 初回ユーザでも owner にしない、
// (c) 顧客が viewer/editor/owner を名乗る経路が無い。管理経路(初回 owner / 以降 viewer)は不変。

type RegisterResponse = {
  user: { id: string; username: string; displayName: string | null; role: string };
};

describe("顧客サインアップ経路(password)", () => {
  beforeEach(async () => {
    await makeApp();
    // **【`V8-M30` 第2波(2026-08-11)。ユーザ決定 `D-V8-82`。題材だけを直した】**
    // **旧(逐語)**: この `beforeEach` は `await makeApp();` の1行だけで、各検査の
    // セルフサインアップがそのアプリの**最初の1人**だった。
    // **`D-V8-82` により最初の1人は持ち主になる** —— **この describe の主題
    // (「顧客経路は本文の role を1度も受け取らない / 昇格経路が無い」)を測るには、
    // 先に管理経路で1人置いて初回の席を埋める必要がある。**
    // **測っている中身は1ミリも変えていない。**
    expect(
      (
        await app.request(
          postJson("/api/apps/inventory/auth/password/register", {
            username: "seed-owner",
            password: "pw-123456",
          }),
        )
      ).status,
    ).toBe(200);
  });

  test("customer/password/register → 200 + role=customer + st_session", async () => {
    const res = await app.request(
      postJson("/api/apps/inventory/auth/signup/password/register", {
        username: "cust-1",
        password: "pw-123456",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as RegisterResponse;
    expect(body.user.username).toBe("cust-1");
    expect(body.user.role).toBe("customer");
    expect(cookieValue(res, "st_session")).toBeDefined();
  });

  // **【`V8-M30` 第2波(2026-08-11)。ユーザ決定 `D-V8-82`。期待値を反転させた。**
  //   **旧のテスト名と旧の本文を逐語で残す】**
  // **旧のテスト名**: `初回ユーザでも owner にせず customer にする(顧客経路は owner をブートストラップしない)`
  // **旧の本文(逐語)**:
  //     // makeApp は毎回まっさらな app を作るので、これがそのアプリ初のユーザである。
  //     const res = await app.request(
  //       postJson("/api/apps/inventory/auth/signup/password/register", {
  //         username: "first-customer",
  //         password: "pw-123456",
  //       }),
  //     );
  //     expect(res.status).toBe(200);
  //     const body = (await res.json()) as RegisterResponse;
  //     // 管理経路なら初回は owner になるが、顧客経路は初回でも customer に固定する。
  //     expect(body.user.role).toBe("customer");
  // **根拠**: **ユーザ決定 `D-V8-82`(2026-08-11)。選ばれた見出し「最初の1人は必ず持ち主」。**
  // **説明文の逐語**: 「自分で登録した場合でも、そのアプリの最初の1人は持ち主になります。
  //   名乗った役割はそれに足されます。**公開の購入サイトでは、最初に買った客が運営者に
  //   なってしまいます。**」
  // **`ADR-0033` §1b の「顧客経路は owner をブートストラップしない」は、今日**成り立たない**。**
  // **【禁止】これを「安全になった」と書かない。**
  test("(反転) 初回ユーザは顧客経路でも持ち主になる(`D-V8-82`)。名乗った種類は消えない", async () => {
    // **この describe の `beforeEach` は初回の席を埋めているので、まっさらな app を作り直す。**
    // **`makeApp` は毎回まっさらな `dataRoot` を作るので、ここには誰も居ない。**
    await makeApp();
    const res = await app.request(
      postJson("/api/apps/inventory/auth/signup/password/register", {
        username: "first-customer",
        password: "pw-123456",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as RegisterResponse & { user: { roles: string[] } };
    expect(body.user.role).toBe("owner");
    expect([...body.user.roles].sort()).toEqual(["customer", "owner"]);
  });

  test("本文の role 指定を無視して常に customer(昇格不可の構造保証)", async () => {
    for (const claimed of ["owner", "editor", "viewer", "customer", "superadmin"]) {
      const res = await app.request(
        postJson("/api/apps/inventory/auth/signup/password/register", {
          username: `claim-${claimed}`,
          password: "pw-123456",
          role: claimed,
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as RegisterResponse;
      expect(body.user.role).toBe("customer");
    }
  });

  test("username / password 欠落は 400(管理経路と同じ入力検証)", async () => {
    expect(
      (
        await app.request(
          postJson("/api/apps/inventory/auth/signup/password/register", { password: "x" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(
          postJson("/api/apps/inventory/auth/signup/password/register", { username: "x" }),
        )
      ).status,
    ).toBe(400);
  });

  test("既存 username の顧客再登録は 409", async () => {
    await app.request(
      postJson("/api/apps/inventory/auth/signup/password/register", {
        username: "dup-cust",
        password: "pw-123456",
      }),
    );
    const dup = await app.request(
      postJson("/api/apps/inventory/auth/signup/password/register", {
        username: "dup-cust",
        password: "other-pw",
      }),
    );
    expect(dup.status).toBe(409);
  });
});

describe("顧客サインアップの登録ポリシー(allowRegistration)", () => {
  // 決定: 顧客サインアップは allowRegistration(サイト全体の登録開閉スイッチ)で制御する。
  // ただし管理経路が持つ「初回ユーザは常に許可」というブートストラップ例外は付けない
  // —— その例外は初回 owner を立てるための管理経路専用であり、顧客経路は決して owner を
  // ブートストラップしないため(ADR-0033 §1b)。既定 allowRegistration=true なので、
  // owner 設営後のストアフロントは既定で開いている。
  test("allowRegistration=false のとき顧客サインアップは初回でも 403", async () => {
    await makeApp(loadAuthConfig({ ST_AUTH_ALLOW_REGISTRATION: "false" }));
    const res = await app.request(
      postJson("/api/apps/inventory/auth/signup/password/register", {
        username: "blocked-customer",
        password: "pw-123456",
      }),
    );
    // 管理経路の初回は 200(ブートストラップ例外)だが、顧客経路には例外が無いので 403。
    expect(res.status).toBe(403);
  });

  test("allowRegistration=true(既定)のとき顧客サインアップは通る", async () => {
    await makeApp(loadAuthConfig({ ST_AUTH_ALLOW_REGISTRATION: "true" }));
    const res = await app.request(
      postJson("/api/apps/inventory/auth/signup/password/register", {
        username: "open-customer",
        password: "pw-123456",
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe("顧客サインアップ経路(passkey options)", () => {
  beforeEach(async () => {
    await makeApp();
  });

  test("customer/passkey/register/options → 200 challenge + st_pending", async () => {
    const res = await app.request(
      postJson("/api/apps/inventory/auth/signup/passkey/register/options", {
        username: "cust-passkey",
      }),
    );
    expect(res.status).toBe(200);
    const options = (await res.json()) as { challenge: string; rp: { id: string } };
    expect(typeof options.challenge).toBe("string");
    expect(options.rp.id).toBe("localhost");
    expect(cookieValue(res, "st_pending")).toBeDefined();
  });

  test("customer/passkey/register/options は既存 username に 409", async () => {
    await app.request(
      postJson("/api/apps/inventory/auth/signup/password/register", {
        username: "taken-cust",
        password: "pw-123456",
      }),
    );
    const res = await app.request(
      postJson("/api/apps/inventory/auth/signup/passkey/register/options", {
        username: "taken-cust",
      }),
    );
    expect(res.status).toBe(409);
  });

  test("customer/passkey/register/verify は無効な pending を 400 に倒す(経路の結線確認)", async () => {
    // 実 WebAuthn assertion は E2E(仮想オーセンティケータ)に委ねる。ここでは経路が
    // 存在し pending 検証が働くことだけを固定する(管理経路の verify テストと同じ範囲)。
    const res = await app.request(
      postJson("/api/apps/inventory/auth/signup/passkey/register/verify", { response: {} }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { errors: unknown[] }).toHaveProperty("errors");
  });

  test("allowRegistration=false のとき customer/passkey/register/options は 403", async () => {
    await makeApp(loadAuthConfig({ ST_AUTH_ALLOW_REGISTRATION: "false" }));
    const res = await app.request(
      postJson("/api/apps/inventory/auth/signup/passkey/register/options", {
        username: "cust-blocked",
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("管理サインアップ経路の非回帰(V2-M1-T02 で変えていないこと)", () => {
  beforeEach(async () => {
    await makeApp();
  });

  test("管理 password register は初回 owner / 以降 viewer(顧客追加で変わらない)", async () => {
    const first = await app.request(
      postJson("/api/apps/inventory/auth/password/register", {
        username: "admin-first",
        password: "pw-123456",
      }),
    );
    expect(first.status).toBe(200);
    expect(((await first.json()) as RegisterResponse).user.role).toBe("owner");

    const second = await app.request(
      postJson("/api/apps/inventory/auth/password/register", {
        username: "admin-second",
        password: "pw-123456",
      }),
    );
    expect(second.status).toBe(200);
    expect(((await second.json()) as RegisterResponse).user.role).toBe("viewer");
  });

  test("管理経路も本文の role を無視する(初回 owner / 以降 viewer のまま)", async () => {
    const first = await app.request(
      postJson("/api/apps/inventory/auth/password/register", {
        username: "admin-claim-1",
        password: "pw-123456",
        role: "customer",
      }),
    );
    expect(((await first.json()) as RegisterResponse).user.role).toBe("owner");

    const second = await app.request(
      postJson("/api/apps/inventory/auth/password/register", {
        username: "admin-claim-2",
        password: "pw-123456",
        role: "owner",
      }),
    );
    expect(((await second.json()) as RegisterResponse).user.role).toBe("viewer");
  });
});

describe("後方互換のエラー整形(古い DB の3値 CHECK。ADR-0033 §4・対処(a))", () => {
  /**
   * **【`V5-M17-T03` / `ADR-0233` で反転した。旧テスト名と旧の期待を先に書く】**
   *
   * **旧テスト名**: 「古い DB では customer INSERT が CHECK で弾かれるが、統一 {errors}
   * 形式で返る(500 の生エラーにしない)」。**旧の期待**: `expect(res.status).not.toBe(200)`。
   *
   * **`_auth_users` の `CHECK` を作り替えるとき、既存 DB をテーブル再構築で移行するように
   * したので、この経路は今日は成功する**(`src/auth/store.ts` の
   * `migrateRoleCheckConstraint`)。**「顧客は発行できない」という着手前の事実は消えた。**
   *
   * **`src/server/auth-routes.ts` の `customerRoleUnsupportedError`(着手前の逐語
   * 「この DB は customer ロールを保存できません(古い CHECK 制約により弾かれました)。」)は
   * 実装に残してある** —— **`CHECK` に弾かれる経路が0になったわけではないからである**
   * (形を外れた値は今日も弾かれる)。**「もう起きない」とは書かない。**
   */
  test("古い DB は移行され、セルフサインアップが成功する(**着手前は 500 だった**)", async () => {
    await makeApp();
    // 古い M3-T02 世代の DB を再現する: role 列を3値 CHECK 付きで先に作っておくと、
    // AuthStore の CREATE TABLE IF NOT EXISTS はこの定義を尊重し、customer は弾かれる。
    // storage-paths.ts の appDbPath と同一のレイアウト(<dataRoot>/apps/<app>/app.sqlite)を
    // 手書きし、カーネルからの値 import(ADR-0009 限定2 の追跡対象)を増やさない
    // (authz.test.ts / owner-scope 系テストと同じ作法)。
    const dbPath = join(dataRoot, "apps", "inventory", "app.sqlite");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath, { create: true });
    db.exec(
      `CREATE TABLE IF NOT EXISTS "_auth_users" (
         "id" TEXT PRIMARY KEY,
         "username" TEXT UNIQUE NOT NULL,
         "display_name" TEXT,
         "role" TEXT NOT NULL DEFAULT 'viewer' CHECK("role" IN ('owner','editor','viewer')),
         "created_at" TEXT NOT NULL
       );`,
    );
    db.close();

    const res = await app.request(
      postJson("/api/apps/inventory/auth/signup/password/register", {
        username: "legacy-customer",
        password: "pw-123456",
      }),
    );
    // **移行が走るので今日は 200 である。**
    // **【`V8-M30` 第2波(2026-08-11)。ユーザ決定 `D-V8-82`。期待値を反転させた。**
    //   **旧のコメントと旧の期待値を逐語で残す】**
    // **旧(逐語)**:
    //     // **移行が走るので今日は 200 で、ロールは既定の1本目(`customer`)になる。**
    //     expect(res.status).toBe(200);
    //     const body = (await res.json()) as { user?: { role?: string } };
    //     expect(body.user?.role).toBe("customer");
    // **根拠**: **`D-V8-82`。この DB には利用者が1人も居ないので、`legacy-customer` が
    //   そのアプリの最初の1人になり、持ち主になる。** **名乗った(既定に落ちた)
    //   `customer` は消えず、付与表へ足される。**
    // **本検査の主題(古い3値 CHECK の DB が移行され、登録が 500 にならないこと)は
    //   1ミリも変えていない。**
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user?: { role?: string; roles?: string[] } };
    expect(body.user?.role).toBe("owner");
    expect([...(body.user?.roles ?? [])].sort()).toEqual(["customer", "owner"]);
  });
});

// ---------------------------------------------------------------------------
// 監査記録の読取経路(E-G59 / V4-M6)
// ---------------------------------------------------------------------------
//
// **既に取れている監査記録(`_auth_activity`)を、運営が読める経路が1本も無かった。**
// 実地では `order_action`(操作の記録)に操作者を表すフィールドが無く、`_auth_activity` には
// 残っているのに **API からは 404**(`テーブル "_auth_activity" はこのアプリに存在しません。`)
// だった —— **ファイルを直接開ける人だけが真相を知れる**状態である(02 §5-9 `E-G59`)。
//
// **`B-G6`(V4-M1)と向きが逆であることを、ここに明記する。** `B-G6` はシステムテーブル
// (`_apps` / `_changelog` / `_ai_usage`)の**未認証**読取を塞いだ。**本経路は owner だけに
// 開ける** —— 未認証は 401、owner でなければ 403 である。**`B-G6` が塞いだものを1バイトも
// 開け直していない**(`_auth_activity` は `SYSTEM_TABLE_IDS` に足していない = records 経路には
// 1件も現れない。`src/shared/system-tables.ts` を1バイトも触っていない)。

describe("監査記録の読取(owner 限定。E-G59)", () => {
  const ACTIVITY = `/api/apps/${APP_ID}/auth/activity`;

  /** owner を1人作り、その cookie を返す(最初の登録者が owner)。 */
  async function registerOwner(username: string): Promise<string> {
    const res = await app.request(
      postJson(`/api/apps/${APP_ID}/auth/password/register`, { username, password: "pw-123456" }),
    );
    expect(res.status).toBe(200);
    return `st_session=${cookieValue(res, "st_session")}`;
  }

  function get(path: string, cookie?: string): Request {
    return new Request(`http://localhost${path}`, {
      headers: cookie === undefined ? {} : { cookie },
    });
  }

  beforeEach(async () => {
    await makeApp();
  });

  test("未認証は 401(B-G6 が塞いだ向きを1バイトも開け直さない)", async () => {
    const res = await app.request(get(ACTIVITY));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { errors: { message: string }[] };
    expect(body.errors[0]?.message).toBe("認証されていません。");
  });

  test("owner でなければ 403", async () => {
    await registerOwner("alice");
    const second = await app.request(
      postJson(`/api/apps/${APP_ID}/auth/password/register`, {
        username: "bob",
        password: "pw-123456",
      }),
    );
    // 2人目は viewer(ADMIN_SIGNUP.resolveRole)。
    expect(((await second.clone().json()) as { user: { role: string } }).user.role).toBe("viewer");
    const res = await app.request(get(ACTIVITY, `st_session=${cookieValue(second, "st_session")}`));
    expect(res.status).toBe(403);
  });

  test("存在しないアプリは 404", async () => {
    const cookie = await registerOwner("alice");
    const res = await app.request(get("/api/apps/no-such-app/auth/activity", cookie));
    expect(res.status).toBe(404);
  });

  test("owner は誰が・いつ・何をしたかを読める(新しい順)", async () => {
    const cookie = await registerOwner("alice");
    // 監査行を作る。records 書込を通すため、テーブルを1つ持つマニフェストを適用する。
    // **【`V8-M26`】既定3役割の規則を足す** —— **面の既定が閉じたので、規則が無いと
    // owner でも表に書けない。** **測っているのは監査記録であって面ではない。**
    expect(
      applyManifest(
        dataRoot,
        APP_ID,
        withDefaultRoleRules({
          app: {
            id: APP_ID,
            name: "備品管理",
            tables: [
              { id: "items", name: "備品", fields: [{ id: "title", name: "題", type: "text" }] },
            ],
            views: [{ id: "item-list", type: "list_view", table: "items", columns: ["title"] }],
          },
        }),
      ).valid,
    ).toBe(true);

    for (const title of ["A", "B"]) {
      const created = await app.request(
        new Request(`http://localhost/api/apps/${APP_ID}/tables/items/records`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN, cookie },
          body: JSON.stringify({ title }),
        }),
      );
      expect(created.status).toBe(201);
    }

    const res = await app.request(get(ACTIVITY, cookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      activity: {
        username: string;
        action: string;
        tableId: string;
        recordId: string | null;
        at: string;
      }[];
      total: number;
    };
    expect(body.total).toBe(2);
    expect(body.activity).toHaveLength(2);
    // **新しい順**(運営が「直前に何が起きたか」を最初に見る)。
    expect((body.activity[0]?.at ?? "") >= (body.activity[1]?.at ?? "")).toBe(true);
    expect(body.activity.map((a) => a.username)).toEqual(["alice", "alice"]);
    expect(body.activity.map((a) => a.action)).toEqual(["create_record", "create_record"]);
    expect(body.activity.map((a) => a.tableId)).toEqual(["items", "items"]);
    expect(body.activity[0]?.recordId).toBeTruthy();
  });

  test("limit / offset で古い分も辿れる。範囲外の指定は 400", async () => {
    const cookie = await registerOwner("alice");
    // **【`V8-M26`】既定3役割の規則を足す**(すぐ上の検査と同じ理由)。
    expect(
      applyManifest(
        dataRoot,
        APP_ID,
        withDefaultRoleRules({
          app: {
            id: APP_ID,
            name: "備品管理",
            tables: [
              { id: "items", name: "備品", fields: [{ id: "title", name: "題", type: "text" }] },
            ],
            views: [{ id: "item-list", type: "list_view", table: "items", columns: ["title"] }],
          },
        }),
      ).valid,
    ).toBe(true);
    for (const title of ["A", "B", "C"]) {
      await app.request(
        new Request(`http://localhost/api/apps/${APP_ID}/tables/items/records`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN, cookie },
          body: JSON.stringify({ title }),
        }),
      );
    }
    const page = await app.request(get(`${ACTIVITY}?limit=1&offset=2`, cookie));
    expect(page.status).toBe(200);
    const body = (await page.json()) as { activity: { at: string }[]; total: number };
    expect(body.total).toBe(3);
    expect(body.activity).toHaveLength(1);

    for (const query of ["?limit=0", "?limit=abc", "?limit=1001", "?offset=-1"]) {
      const bad = await app.request(get(`${ACTIVITY}${query}`, cookie));
      expect(bad.status, query).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------
// パスワードの変更と退会(E-G68 / V4-M6)
// ---------------------------------------------------------------------------
//
// **着手前は、パスワードの変更も、忘れたときの再設定も、退会も1つもできなかった。**
// `src/server/auth-routes.ts` の認証ルート13本に `store.setPassword` を呼ぶものは登録経路
// しか無く、ユーザを消すルートも1本も無かった —— **客がパスワードを忘れたら二度とその
// アカウントに戻れず**(注文履歴・ポイントごと失う)、**個人情報の削除要求にも応えられない**
// (02 §5-10 `E-G68`)。
//
// **ここで足すのは「本人がやり直せる2本」だけである。**
//   - **忘れたときの再設定(メールによる本人確認)は足していない** —— この製品にメールを送る
//     経路が1本も無い(`capability` の宛先はアプリの宣言であって認証基盤のものではない)。
//     **「パスワードを忘れても戻れる」とは書けない。**
//   - **運営による他人のパスワード再発行も足していない** —— 他人の資格情報を書き換える権限を
//     owner に与える変更であり、`E-G53` と同じ「線の引き直し」に当たる。

describe("パスワードの変更と退会(E-G68)", () => {
  const CHANGE = `/api/apps/${APP_ID}/auth/password/change`;
  const ME = `/api/apps/${APP_ID}/auth/me`;

  async function register(username: string, password = "pw-123456"): Promise<string> {
    const res = await app.request(
      postJson(`/api/apps/${APP_ID}/auth/password/register`, { username, password }),
    );
    expect(res.status).toBe(200);
    return `st_session=${cookieValue(res, "st_session")}`;
  }

  async function login(username: string, password: string): Promise<Response> {
    return app.request(postJson(`/api/apps/${APP_ID}/auth/password/login`, { username, password }));
  }

  beforeEach(async () => {
    await makeApp();
  });

  test("本人はパスワードを変えられ、新旧の効き方が入れ替わる", async () => {
    const cookie = await register("alice");
    const changed = await app.request(
      postJson(CHANGE, { current_password: "pw-123456", new_password: "pw-abcdefg" }, { cookie }),
    );
    expect(changed.status).toBe(200);

    expect((await login("alice", "pw-abcdefg")).status).toBe(200);
    expect((await login("alice", "pw-123456")).status).toBe(401);
  });

  test("変更するとそれまでのセッションは全部失効し、応答の新しい cookie だけが効く", async () => {
    const cookie = await register("alice");
    const changed = await app.request(
      postJson(CHANGE, { current_password: "pw-123456", new_password: "pw-abcdefg" }, { cookie }),
    );
    expect(changed.status).toBe(200);
    const fresh = `st_session=${cookieValue(changed, "st_session")}`;
    expect(fresh).not.toBe(cookie);

    // 古い cookie は使えない(盗まれた session を変更で切れる)。
    expect(
      (await app.request(new Request(`http://localhost${ME}`, { headers: { cookie } }))).status,
    ).toBe(401);
    // 応答で配られた新しい cookie は使える(変更した本人はログインしたまま)。
    expect(
      (await app.request(new Request(`http://localhost${ME}`, { headers: { cookie: fresh } })))
        .status,
    ).toBe(200);
  });

  test("現在のパスワードが違えば 401。パスワードは1バイトも変わらない", async () => {
    const cookie = await register("alice");
    const res = await app.request(
      postJson(CHANGE, { current_password: "wrong-pw", new_password: "pw-abcdefg" }, { cookie }),
    );
    expect(res.status).toBe(401);
    expect((await login("alice", "pw-123456")).status).toBe(200);
    expect((await login("alice", "pw-abcdefg")).status).toBe(401);
  });

  test("未認証は 401、本文の形が違えば 400", async () => {
    await register("alice");
    expect(
      (
        await app.request(
          postJson(CHANGE, { current_password: "pw-123456", new_password: "pw-abcdefg" }),
        )
      ).status,
    ).toBe(401);
    const cookie = await register("bob");
    for (const body of [{}, { current_password: "pw-123456" }, { new_password: 1 }]) {
      expect((await app.request(postJson(CHANGE, body, { cookie }))).status).toBe(400);
    }
  });

  test("退会すると、そのアカウントではログインできなくなる", async () => {
    await register("alice"); // 最初の1人 = owner(最後の owner は退会できない)
    const cookie = await register("bob");
    const gone = await app.request(
      new Request(`http://localhost${ME}`, {
        method: "DELETE",
        headers: { origin: ORIGIN, cookie },
      }),
    );
    expect(gone.status).toBe(200);

    expect((await login("bob", "pw-123456")).status).toBe(401);
    // セッションも消えている。
    expect(
      (await app.request(new Request(`http://localhost${ME}`, { headers: { cookie } }))).status,
    ).toBe(401);
    // 同じ username を取り直せる(UNIQUE が解放されている)。
    const again = await app.request(
      postJson(`/api/apps/${APP_ID}/auth/password/register`, {
        username: "bob",
        password: "pw-zzzzzz",
      }),
    );
    expect(again.status).toBe(200);
  });

  test("最後の owner は退会できない(409)。アカウントは残る", async () => {
    const cookie = await register("alice");
    const res = await app.request(
      new Request(`http://localhost${ME}`, {
        method: "DELETE",
        headers: { origin: ORIGIN, cookie },
      }),
    );
    expect(res.status).toBe(409);
    expect((await login("alice", "pw-123456")).status).toBe(200);
  });

  test("退会は未認証では 401", async () => {
    await register("alice");
    const res = await app.request(
      new Request(`http://localhost${ME}`, { method: "DELETE", headers: { origin: ORIGIN } }),
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 監査に「どの項目を何から何に変えたか」を残す(E-G53 / D-V4-49 / V4-M6)
// ---------------------------------------------------------------------------
//
// **ユーザ決定 `D-V4-49`(04 §1-5)の逐語**: 「引き直す。**変更内容まで記録に残す**」——
// 住所の書き間違いを直せるようにし、**あとから履歴を辿れるようにする**。
//
// **着手前の穴(04 §3-7 #16 の実測)**: `ADR-0015` の `_auth_activity` は `action` に
// `update_record` を持つので「**誰がいつ**」は満たすが、**「どの項目を何から何に変えたか」を
// 1つも持たない** —— **今日の監査ログからは復元できない**。
//
// **ここで足すのはその粒度だけである。** **運営が他人の行を直せるようにする側(`ADR-0061`
// 限定1 の引き直し)には1バイトも手を付けていない** —— そちらは審査(`V4-M7`)の判定を待つ。
// **したがって今日この記録が増えるのは「今日すでに書ける書込」についてだけである。**
//
// **【全項目の差分を残す、とは書かない】** 残すのは **その更新で実際に値が変わった項目**
// だけである(送ったが値が同じだった項目は現れない)。長い値は切り詰める。

describe("監査に変更内容を残す(E-G53 / D-V4-49)", () => {
  async function registerOwner(username: string): Promise<string> {
    const res = await app.request(
      postJson(`/api/apps/${APP_ID}/auth/password/register`, { username, password: "pw-123456" }),
    );
    expect(res.status).toBe(200);
    return `st_session=${cookieValue(res, "st_session")}`;
  }

  function applyItems(): void {
    // **【`V8-M26`】既定3役割の規則を足す** —— **測っているのは監査の `changes` であって面ではない。**
    expect(
      applyManifest(
        dataRoot,
        APP_ID,
        withDefaultRoleRules({
          app: {
            id: APP_ID,
            name: "備品管理",
            tables: [
              {
                id: "items",
                name: "備品",
                fields: [
                  { id: "title", name: "題", type: "text" },
                  { id: "memo", name: "覚え書き", type: "long_text" },
                  { id: "count", name: "数", type: "number" },
                ],
              },
            ],
            views: [{ id: "item-list", type: "list_view", table: "items", columns: ["title"] }],
          },
        }),
      ).valid,
    ).toBe(true);
  }

  async function activity(cookie: string): Promise<
    {
      action: string;
      changes: { field: string; from: unknown; to: unknown }[] | null;
    }[]
  > {
    const res = await app.request(
      new Request(`http://localhost/api/apps/${APP_ID}/auth/activity`, { headers: { cookie } }),
    );
    expect(res.status).toBe(200);
    return (
      (await res.json()) as {
        activity: {
          action: string;
          changes: { field: string; from: unknown; to: unknown }[] | null;
        }[];
      }
    ).activity;
  }

  beforeEach(async () => {
    await makeApp();
  });

  test("更新は「どの項目を何から何に」を残す(変わった項目だけ)", async () => {
    const cookie = await registerOwner("alice");
    applyItems();
    const created = await app.request(
      new Request(`http://localhost/api/apps/${APP_ID}/tables/items/records`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, cookie },
        body: JSON.stringify({ title: "机", memo: "旧", count: 1 }),
      }),
    );
    expect(created.status).toBe(201);
    const record = ((await created.json()) as { record: { _id: string; _updated_at: string } })
      .record;

    const patched = await app.request(
      new Request(`http://localhost/api/apps/${APP_ID}/tables/items/records/${record._id}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          cookie,
          "if-match": record._updated_at,
        },
        // `count` は同じ値を送る —— **変わっていないので記録に現れない**。
        body: JSON.stringify({ title: "作業机", count: 1 }),
      }),
    );
    expect(patched.status).toBe(200);

    const rows = await activity(cookie);
    const update = rows.find((row) => row.action === "update_record");
    expect(update?.changes).toEqual([{ field: "title", from: "机", to: "作業机" }]);
  });

  test("作成と削除には変更内容を持たせない(null)", async () => {
    const cookie = await registerOwner("alice");
    applyItems();
    const created = await app.request(
      new Request(`http://localhost/api/apps/${APP_ID}/tables/items/records`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, cookie },
        body: JSON.stringify({ title: "椅子" }),
      }),
    );
    const record = ((await created.json()) as { record: { _id: string; _updated_at: string } })
      .record;
    const deleted = await app.request(
      new Request(`http://localhost/api/apps/${APP_ID}/tables/items/records/${record._id}`, {
        method: "DELETE",
        headers: { origin: ORIGIN, cookie, "if-match": record._updated_at },
      }),
    );
    expect(deleted.status).toBe(204);

    const rows = await activity(cookie);
    expect(rows.map((row) => row.action)).toEqual(["delete_record", "create_record"]);
    expect(rows.every((row) => row.changes === null)).toBe(true);
  });

  test("長い値は切り詰めて残す(監査行が本文の写しにならない)", async () => {
    const cookie = await registerOwner("alice");
    applyItems();
    const created = await app.request(
      new Request(`http://localhost/api/apps/${APP_ID}/tables/items/records`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, cookie },
        body: JSON.stringify({ title: "棚", memo: "あ".repeat(500) }),
      }),
    );
    const record = ((await created.json()) as { record: { _id: string; _updated_at: string } })
      .record;
    await app.request(
      new Request(`http://localhost/api/apps/${APP_ID}/tables/items/records/${record._id}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          cookie,
          "if-match": record._updated_at,
        },
        body: JSON.stringify({ memo: "い".repeat(500) }),
      }),
    );

    const rows = await activity(cookie);
    const change = rows.find((row) => row.action === "update_record")?.changes?.[0];
    expect(change?.field).toBe("memo");
    expect(String(change?.from).length).toBeLessThan(500);
    expect(String(change?.from)).toContain("…");
    expect(String(change?.to)).toContain("…");
  });
});
