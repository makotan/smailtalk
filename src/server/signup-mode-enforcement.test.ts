/**
 * **登録の可否を1本の述語に集約する**(`V8-M1-T04`。台帳 `I-G5` / `I-G7` / `I-G24` /
 * `I-G26`。[`ADR-0335`](../../docs/adr/0335-signup-single-predicate-and-env-precedence.md))。
 * **本物の SQLite と実 HTTP で測る**(モックを置かない)。
 *
 * ## この検査が固定するもの(**先に書く**)
 *
 * 1. **宣言していないアプリの応答が着手前と1バイトも変わらないこと**(`I-G3` / `ADR-0335`
 *    限定4)—— **env が true でも false でも、4経路とも今日どおりである。**
 * 2. **`signup: "invite"` を宣言した役割は、そのアプリの登録者が0人のときだけ通ること**
 *    (`D-V8-106`)。**1人以上いれば 403。**
 * 3. **運営が人を足す口(`ADMIN_SIGNUP`)も同じ判定を受けること**(`I-G5`)——
 *    **見るのは予約3語(`owner` / `editor` / `viewer`)のうち1つでも `"invite"` かである**
 *    (`ADR-0334` 限定14。**「発行される役割だけを見る」形は採らない** —— **その形では
 *    読み方が `wasFirstUser` に依存し、1つの宣言に対して答えが2つできる**)。
 * 4. **env × 宣言の4通り**(`I-G26` / `V8-M1` の完了の考え方 (v))。
 * 5. **述語が1本ちょうどで、写しが無いこと**(`ADR-0335` 限定1)。
 * 6. **`wasFirstUser` はユーザを作る**前**に採ること**(同 限定2)——
 *    **`store.countUsers() === 0` を数える箇所を4箇所目にしない。**
 * 7. **`src/auth/config.ts` と `bootstrapFirstUserOwner` に1バイトも書かないこと**
 *    (同 限定6 / 限定7)。
 *
 * ## この検査が測らないもの(**誇張しない**)
 *
 * 1. **招待の仕組みは `V8-M1` の時点で1つも無い。** **したがって `D-V8-110`
 *    (`ST_AUTH_ALLOW_REGISTRATION=false` でも招待があれば通る)の枝は、今日
 *    「招待は常に不成立」として書いてあり、1度も真にならない** —— **埋めるのは `V8-M3`
 *    である。** **【禁止】これを「招待が env を越えることを実証した」と書かない。**
 * 2. **`"invite"` を宣言したアプリは、`V8-M2`〜`V8-M4` が通るまで、登録者が1人でも
 *    いれば誰も登録できない。** **【禁止】この中間状態を「一時的だから問題ない」と書かない。**
 * 3. **403 の応答本文は今日 env の 403 と1文字も同じである**(`registrationClosedError`
 *    を使い回している)。 **`hint` の文面は `ST_AUTH_ALLOW_REGISTRATION` を名指ししており、
 *    招待が要る場合には嘘である** —— **打ち直しは `ADR-0335` 限定8 により `V8-M3` /
 *    `V8-M4` の担当である。** **一方で、この使い回しのおかげで「招待制かどうか」は
 *    応答から1バイトも漏れていない。**
 *
 *    =====================================================================================
 *    **【2026-08-14。`V8-M3-T04` の訂正。上の項は今日の正ではない。旧文は1バイトも消していない】**
 *    =====================================================================================
 *
 *    **`ADR-0337` 限定10 が文面を決めた** —— **招待を要求する経路の 403 は
 *    `registrationClosedError` を使い回さず、**別の文面**を返す。**
 *    **したがって上の項の最終文(「この使い回しのおかげで『招待制かどうか』は応答から
 *    1バイトも漏れていない」)は今日 偽である。** **`ADR-0337` §限界3 が同じことを
 *    自分で書いている。** **打ち直した期待値は `(E-2)` の2本目に在り、旧の期待値は
 *    その場に逐語で残してある。**
 * 4. **応答時間の差を1度も測っていない。**
 * 5. **passkey の verify は実オーセンティケータを要するので、ここでは options までしか
 *    叩いていない。** **`data/apps/` の実地アプリには1バイトも書いていない。**
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthConfig, loadAuthConfig } from "../auth/config.ts";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession } from "./test-helpers.ts";

const APP_ID = "shop";
const ORIGIN = "http://localhost:5173";

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

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
      name: "店",
      tables: [
        {
          id: "memo",
          name: "メモ",
          fields: [{ id: "title", name: "題名", type: "text" }],
        },
      ],
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
  dataRoot = await mkdtemp(join(tmpdir(), "gp-signup-mode-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "店", { app_id: APP_ID });
  } finally {
    store.close();
  }
  const applied = applyManifest(dataRoot, APP_ID, manifest);
  if (!applied.valid) {
    throw new Error(`テスト前提のマニフェスト投入に失敗: ${JSON.stringify(applied.errors)}`);
  }
  app = createServerApp(config === undefined ? { dataRoot } : { dataRoot, authConfig: config });
}

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function postJson(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
  });
}

/** 運営が人を足す口(`ADMIN_SIGNUP`)。 */
async function adminRegister(username: string): Promise<Response> {
  return app.request(
    postJson(`/api/apps/${APP_ID}/auth/password/register`, { username, password: "pw-123456" }),
  );
}

/** セルフ登録の口(`SELF_SIGNUP`)。 */
async function selfRegister(username: string, userKind?: string): Promise<Response> {
  return app.request(
    postJson(`/api/apps/${APP_ID}/auth/signup/password/register`, {
      username,
      password: "pw-123456",
      ...(userKind === undefined ? {} : { user_kind: userKind }),
    }),
  );
}

const ENV_OFF = (): AuthConfig => loadAuthConfig({ ST_AUTH_ALLOW_REGISTRATION: "false" });
const ENV_ON = (): AuthConfig => loadAuthConfig({ ST_AUTH_ALLOW_REGISTRATION: "true" });

// ===========================================================================
// (E-1) 宣言していないアプリは、着手前と1バイトも変わらない(`I-G3` / 限定4)
// ===========================================================================

describe("(E-1) `signup` を1つも書いていないアプリ", () => {
  test("env=true: 管理経路もセルフ経路も、1人目も2人目も 200(今日どおり)", async () => {
    await makeApp(shopManifest(), ENV_ON());
    expect((await adminRegister("admin1")).status).toBe(200);
    expect((await adminRegister("admin2")).status).toBe(200);
    expect((await selfRegister("member1", "member")).status).toBe(200);
    expect((await selfRegister("member2")).status).toBe(200);
  });

  test("env=false: 管理経路は1人目 200 / 2人目 403、セルフ経路は初回でも 403(今日どおり)", async () => {
    await makeApp(shopManifest(), ENV_OFF());
    // **`D-V8-106` の「誰も居ない間だけ扉を開ける」は、env=false のときセルフ経路では
    // 成立しない**(`ADR-0335` 限定3。**この1本は管理経路に全面的に依存している**)。
    expect((await selfRegister("blocked", "member")).status).toBe(403);
    expect((await adminRegister("first")).status).toBe(200);
    expect((await adminRegister("second")).status).toBe(403);
  });

  test("env=true: passkey の options も今日どおり 200 を返す", async () => {
    await makeApp(shopManifest(), ENV_ON());
    const res = await app.request(
      postJson(`/api/apps/${APP_ID}/auth/passkey/register/options`, { username: "pk1" }),
    );
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// (E-2) セルフ登録の口 —— 名乗った役割の `signup` を見る(`ADR-0334` 限定14)
// ===========================================================================

describe('(E-2) `member` に `signup: "invite"` を書いたアプリ', () => {
  test("登録者が0人なら通る(`D-V8-106`)", async () => {
    await makeApp(shopManifest({ member: "invite" }), ENV_ON());
    expect((await selfRegister("first", "member")).status).toBe(200);
  });

  test("登録者が1人以上なら 403(招待が要る。`V8-M1` の時点では招待の仕組みが無い)", async () => {
    await makeApp(shopManifest({ member: "invite" }), ENV_ON());
    expect((await selfRegister("first", "member")).status).toBe(200);
    const second = await selfRegister("second", "member");
    expect(second.status).toBe(403);
    // =====================================================================================
    // **【2026-08-14。`V8-M3-T04`。`ADR-0337` 限定10。旧の期待値を1バイトも消していない】**
    // =====================================================================================
    //
    // **旧(逐語)**:
    //
    //     // **応答本文は env の 403 と1文字も同じである**(招待制かどうかが漏れない)。
    //     expect(await second.json()).toEqual({
    //       errors: [
    //         {
    //           path: "",
    //           message: "新規登録は許可されていません。",
    //           hint: "管理者に ST_AUTH_ALLOW_REGISTRATION を有効化してもらうか、既存アカウントでログインしてください。",
    //         },
    //       ],
    //     });
    //
    // **打ち直した理由**: **この期待値の打ち直しは、本ファイルの冒頭(§測らないもの の 3)が
    // 自ら「`ADR-0335` 限定8 により `V8-M3` / `V8-M4` の担当である」と名指ししたものである。**
    // **`ADR-0335` 限定8 の逐語は「**本 ADR は文面の最終形を1文字も確定させていない**」であり、
    // 文面を決めたのは `ADR-0337` 限定10(**env の `registrationClosedError` とは別の文面に
    // する**)である。**
    //
    // **【失ったものを書く】** **旧の期待値が固定していた性質 ——「403 の本文からは
    // 招待制かどうかが1バイトも漏れない」—— は今日 成り立たない。**
    // **`ADR-0337` §限界3 がそれを自分で書いている** —— **漏れないと決めたのは
    // 「その相手が招待されているか」と「そのログイン名が実在するか」の2つだけである。**
    expect(await second.json()).toEqual({
      errors: [
        {
          path: "",
          message: "ユーザIDかコードが違います。",
          hint: "このアプリは招待された人だけが登録できます。運営者から伝えられたログイン名と招待コードを両方そのまま入れてください。コードには期限があります(発行から24時間)。",
        },
      ],
    });
  });

  test('`signup: "open"` を明示した役割は今日どおり通る', async () => {
    await makeApp(shopManifest({ member: "open" }), ENV_ON());
    expect((await selfRegister("first", "member")).status).toBe(200);
    expect((await selfRegister("second", "member")).status).toBe(200);
  });
});

// ===========================================================================
// (E-3) 運営が人を足す口も同じ判定を受ける(`I-G5`)
// ===========================================================================

describe('(E-3) 予約3語に `signup: "invite"` を書いたアプリ', () => {
  test("管理経路は1人目だけ通り、2人目は 403", async () => {
    await makeApp(shopManifest({ staff: "invite" }), ENV_ON());
    expect((await adminRegister("first")).status).toBe(200);
    expect((await adminRegister("second")).status).toBe(403);
  });

  test("passkey の options も同じ判定を受ける(ユーザを作る前に止まる)", async () => {
    await makeApp(shopManifest({ staff: "invite" }), ENV_ON());
    expect((await adminRegister("first")).status).toBe(200);
    const res = await app.request(
      postJson(`/api/apps/${APP_ID}/auth/passkey/register/options`, { username: "second" }),
    );
    // **`ADR-0335` §3-2 (b) により、`options` には招待の判定を入れていない** ——
    // **ユーザを作らない口だからである。****今日どおり 200 が返る。**
    expect(res.status).toBe(200);
  });

  test('予約3語だけが `"invite"` なら、セルフ登録(`member`)は今日どおり通る(パターン2)', async () => {
    await makeApp(shopManifest({ staff: "invite" }), ENV_ON());
    expect((await adminRegister("first")).status).toBe(200);
    expect((await selfRegister("buyer1", "member")).status).toBe(200);
    expect((await selfRegister("buyer2", "member")).status).toBe(200);
  });

  test('全役割が `"invite"` なら、どちらの口も1人目だけ通る(パターン3)', async () => {
    await makeApp(shopManifest({ staff: "invite", member: "invite" }), ENV_ON());
    expect((await adminRegister("first")).status).toBe(200);
    expect((await adminRegister("second")).status).toBe(403);
    expect((await selfRegister("buyer", "member")).status).toBe(403);
  });

  test('`editor` だけが `"invite"` でも管理経路は招待を要求する(限定14 の読み方)', async () => {
    // **`ADMIN_SIGNUP.resolveRole` は `owner` と `viewer` の2語しか発行せず、`editor` は
    // この口から1度も出ない。****それでも予約3語のうち1つでも `"invite"` なら要求する** ——
    // **「発行される役割だけを見る」形は `ADR-0334` 限定14 が名指しで却下している**
    // (その形では読み方が `wasFirstUser` に依存し、1つの宣言に対して答えが2つできる)。
    const manifest = shopManifest();
    const roles = ((manifest.app as unknown as Record<string, unknown>).roles ?? []) as Record<
      string,
      unknown
    >[];
    const editor = roles.find((role) => role.id === "editor");
    if (editor !== undefined) {
      editor.signup = "invite";
    }
    await makeApp(manifest, ENV_ON());
    expect((await adminRegister("first")).status).toBe(200);
    expect((await adminRegister("second")).status).toBe(403);
  });
});

// ===========================================================================
// (E-4) env × 宣言の4通り(`I-G26`。**丸めない**)
// ===========================================================================

describe("(E-4) env × 宣言の4通り(セルフ経路。登録者1人以上の状態で測る)", () => {
  /** 先に1人入れてから、2人目のセルフ登録を測る(0人の例外を踏まないため)。 */
  async function secondSelfRegistration(
    mode: SignupMode | undefined,
    config: AuthConfig,
  ): Promise<number> {
    await makeApp(shopManifest(mode === undefined ? {} : { member: mode }), config);
    const seeded = await selfRegister("seed", "member");
    if (seeded.status !== 200) {
      // env=false のときは1人も入れられないので、ユーザ0人のまま測る。
      return (await selfRegister("probe", "member")).status;
    }
    return (await selfRegister("probe", "member")).status;
  }

  test("env=true × 宣言なし → 200(今日どおり)", async () => {
    expect(await secondSelfRegistration(undefined, ENV_ON())).toBe(200);
  });

  test('env=true × `"invite"` → 403(招待が要る)', async () => {
    expect(await secondSelfRegistration("invite", ENV_ON())).toBe(403);
  });

  test("env=false × 宣言なし → 403(今日どおり。env が勝つ)", async () => {
    expect(await secondSelfRegistration(undefined, ENV_OFF())).toBe(403);
  });

  test('env=false × `"invite"` → 403(招待が今日1件も無いので、負けたのは招待制の側ではない)', async () => {
    expect(await secondSelfRegistration("invite", ENV_OFF())).toBe(403);
  });
});

// ===========================================================================
// (E-5) 述語は1本ちょうどで、写しが無い(`ADR-0335` 限定1 / 限定2 / 限定6 / 限定7)
// ===========================================================================

describe("(E-5) 判定の実体は1本である", () => {
  const source = (): string => readFileSync(join(import.meta.dir, "auth-routes.ts"), "utf8");

  test("`config.allowRegistration` を読む行は、旧文のコメントを除いて1箇所ちょうどである", () => {
    const hits = source()
      .split("\n")
      .filter((line) => line.includes("config.allowRegistration"))
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"));
    expect(hits).toHaveLength(1);
  });

  test("`SignupPolicy` のリテラルの中に判定のラムダが1つも無い", () => {
    const text = source();
    // **旧(逐語)**: `isAllowed: (_store, config) => config.allowRegistration,`
    // **`isAllowed` というフィールドそのものを撤去し、経路差は宣言的なフィールドで持つ。**
    const live = text
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"));
    expect(live.filter((line) => line.includes("isAllowed"))).toHaveLength(0);
  });

  test("招待の関門を判定する述語は1本ちょうどで、呼び出しは2箇所である", () => {
    const live = source()
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"));
    expect(live.filter((line) => line.includes("function signupAllowed"))).toHaveLength(1);
    expect(live.filter((line) => line.includes("signupAllowed({"))).toHaveLength(2);
  });

  test("`store.countUsers() === 0` を数える箇所は製品コードで3箇所(行では4行)ちょうどである", () => {
    const live = source()
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"));
    // `registrationAllowed` / `ADMIN_SIGNUP.resolveRole` / `wasFirstUser`(2ハンドラで同一の式)。
    expect(live.filter((line) => line.includes("countUsers() === 0"))).toHaveLength(4);
  });

  test("`wasFirstUser` は `createUserSafely` より前で採られている", () => {
    const lines = source().split("\n");
    const firstUserAt = lines.flatMap((line, index) =>
      line.includes("const wasFirstUser = store.countUsers() === 0;") ? [index] : [],
    );
    const createdAt = lines.flatMap((line, index) =>
      line.includes("const created = createUserSafely(") ? [index] : [],
    );
    expect(firstUserAt).toHaveLength(2);
    expect(createdAt).toHaveLength(2);
    expect(firstUserAt[0]).toBeLessThan(createdAt[0] as number);
    expect(firstUserAt[1]).toBeLessThan(createdAt[1] as number);
  });

  test("`bootstrapFirstUserOwner` の本体に1バイトも書いていない(`ADR-0326` 限定7 を守る)", () => {
    const text = source();
    const body = text.slice(
      text.indexOf("function bootstrapFirstUserOwner("),
      text.indexOf("function resolveRequestedUserKind("),
    );
    expect(body.includes("signup")).toBe(false);
  });

  test("`src/auth/config.ts` に `signup` の綴りが1件も無い(限定6)", () => {
    const config = readFileSync(join(import.meta.dir, "..", "auth", "config.ts"), "utf8");
    expect(config.includes("signup")).toBe(false);
  });
});

// ===========================================================================
// (E-6) **宣言されていない組み込みの立場(`customer`)の招待の要否**
//       (`V8-M5-T07`。**ユーザ決定 `D-V8-116`**)
// ===========================================================================
//
// **【この穴を見つけたのは審査ではない。実測である】** **`V8-M0` の門A本審査33単位も、
// `ADR-0334` / `ADR-0335` / `ADR-0337` の限定表も、この穴を1文字も書いていない。**
// **見つけたのは `V8-M5` の実測(配布用の器の中で「全員制限」を宣言しても セルフ登録の
// 口が閉じなかった)であり、メインが母艦でも同じであることを裏取りした。**
// **【禁止】これを「器固有の問題」と書かない** —— **母艦でも同じである。**
//
// **【穴の中身】** **`signupKindValues` は、アプリが独自の役割を1つも宣言していなくても
// 組み込みの既定(`customer`)を必ず返す。** **`customer` は `app.roles` に無いので、
// `signup` を書き込む場所が1つも無い。** **したがって着手前は、予約3語をすべて
// `"invite"` にした「全員制限」のアプリでも、`user_kind: "customer"` と名乗るだけで
// 招待なしに登録できた。**
//
// **【`D-V8-116` の説明文の逐語】** ——
// > 運営側の3つ(持ち主・編集者・閲覧者)がすべて招待制になっているときだけ、アプリが
// > 名前を付けていない「一般利用者」も招待を要求します。「全員制限」が字義どおりになります。
// > 「一般は自由・スタッフは制限」のアプリの動きは1つも変わりません。

/** 独自の役割を1つも持たないアプリ(**名乗れる値は組み込みの `customer` 1つだけ**)。 */
function bareManifest(mode?: SignupMode, only?: "editor"): Manifest {
  const withMode = (role: Record<string, unknown>, applied: boolean) =>
    mode === undefined || !applied ? role : { ...role, signup: mode };
  return {
    app: {
      id: APP_ID,
      name: "店(独自の役割なし)",
      tables: [{ id: "memo", name: "メモ", fields: [{ id: "title", name: "題名", type: "text" }] }],
      views: [],
      roles: [
        withMode({ id: "owner", name: "持ち主", rules: OWNER_RULES }, only !== "editor"),
        withMode({ id: "editor", name: "編集者" }, true),
        withMode({ id: "viewer", name: "閲覧者" }, only !== "editor"),
      ],
    },
  } as unknown as Manifest;
}

describe("(E-6) 宣言されていない `customer` の招待の要否(`D-V8-116`)", () => {
  test("予約3語すべてが invite: `user_kind` を省略したセルフ登録は 403", async () => {
    await makeApp(bareManifest("invite"), ENV_ON());
    // **1人目は `D-V8-106` により招待の関門を通らない。****先に1人作る。**
    expect((await adminRegister("first")).status).toBe(200);
    expect((await selfRegister("shopper")).status).toBe(403);
  });

  test('予約3語すべてが invite: `user_kind: "customer"` を明示しても 403', async () => {
    await makeApp(bareManifest("invite"), ENV_ON());
    expect((await adminRegister("first")).status).toBe(200);
    expect((await selfRegister("shopper", "customer")).status).toBe(403);
  });

  test("予約3語すべてが invite: 有効な招待を添えれば 200", async () => {
    await makeApp(bareManifest("invite"), ENV_ON());
    const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
    const issued = await app.request(
      new Request(`http://localhost/api/apps/${APP_ID}/auth/invitations`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, cookie: owner.cookie },
        body: JSON.stringify({ username: "shopper", role: "viewer" }),
      }),
    );
    expect(issued.status).toBe(200);
    const code = ((await issued.json()) as { invitation: { code: string } }).invitation.code;
    const res = await app.request(
      postJson(`/api/apps/${APP_ID}/auth/signup/password/register`, {
        username: "shopper",
        password: "pw-123456",
        user_kind: "customer",
        invitation_code: code,
      }),
    );
    expect(res.status).toBe(200);
  });

  test("予約3語のうち1つでも宣言が無ければ、`customer` は今日どおり 200(パターン2は不変)", async () => {
    // **`editor` だけが `"invite"`。****`owner` / `viewer` は宣言なし。**
    await makeApp(bareManifest("invite", "editor"), ENV_ON());
    expect((await adminRegister("first")).status).toBe(200);
    expect((await selfRegister("shopper", "customer")).status).toBe(200);
  });

  test("宣言が1つも無いアプリの `customer` は今日どおり 200(`I-G3` を1ミリも動かさない)", async () => {
    await makeApp(bareManifest(), ENV_ON());
    expect((await adminRegister("first")).status).toBe(200);
    expect((await selfRegister("shopper", "customer")).status).toBe(200);
    expect((await selfRegister("shopper2")).status).toBe(200);
  });

  test("`member: open` + 予約3語すべて invite: `member` は開いたまま `customer` だけ閉じる(限界)", async () => {
    // **【限界。丸めない】** **この組み合わせは奇妙に見える** —— **アプリが「自由」と
    // 宣言した `member` は開いたままで、アプリが1文字も書いていない `customer` だけが
    // 閉じる。****`D-V8-116` が選んだ形の代償である。**
    await makeApp(shopManifest({ staff: "invite", member: "open" }), ENV_ON());
    expect((await adminRegister("first")).status).toBe(200);
    expect((await selfRegister("buyer", "member")).status).toBe(200);
    expect((await selfRegister("shopper", "customer")).status).toBe(403);
  });
});
