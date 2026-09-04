/**
 * **「人に付けられる値」と「登録で名乗れる値」の出所が、立場の一覧(`app.user_kinds`)から
 * 役割の一覧(`app.roles[].id`)へ広がったことの実測**
 * (`V8-M29` 第1波 / 台帳 `T-G10` / ユーザ決定 `D-V8-78` / `D-V8-79` / `D-V8-80`)。
 *
 * **本物の HTTP(`createServerApp` の `app.request`)と本物の SQLite で測る。**
 * **モックを1つも置いていない。**
 *
 * ## この波が測るもの(関門 `T01-U` の問いに1対1で対応させてある)
 *
 * | # | 本ファイルの検査 | 関門 `T01-U` の問い | **着手前の実測**(`scratchpad/m29-gate.md`) |
 * |---:|---|---|---|
 * | 1 | (1-a) / (1-b) | **(1)** 役割を宣言しただけで人に付けられるか | **400。`allowed_values` に `reception` が入らない** |
 * | 2 | (2-a) / (2-b) | **(2)** 登録経路で宣言した役割を名乗れるか | **422**(自己登録・管理登録の両方) |
 * | 3 | (3) | **(2)** が名指しした**新しい穴** | 今日は `customer`。**引き先を素直に付け替えると `owner` になる** |
 * | 4 | (4-a) / (4-b) | **(3)** `anonymous` を人に付けられてしまわないか | **400**(ただし止めていたのは値域が `user_kinds` を引いていたからにすぎない) |
 * | 5 | (5-a) / (5-b) | —— | **`roles` を持たないアプリの値域を1ミリも動かさないことの固定** |
 * | 6 | (6) | **(4)** 表示名が消えないか | **消える**(`roles[].name` は省略できる) |
 * | 7 | (7) | —— | **既定3役割は今日どおり付けられることの固定** |
 *
 * ## この波が**していない**こと(**先に書く**)
 *
 * - **`user_kinds` / `set_user_kinds` を1バイトも撤去していない。** **撤去は次の波である。**
 *   **本ファイルの (5) は、`user_kinds` を書いたアプリが今日どおり動くことを固定している。**
 * - **`app.roles[].id` を「出所として足した」のであって、`user_kinds` の出所を落としていない**
 *   —— **値域は両方の和である。** **落とすのは撤去の波の仕事である。**
 * - **画面(利用者管理のセレクト)の選択肢は1バイトも広げていない** ——
 *   **`web/src/auth/UserAdmin.tsx` の `roleOrder` は今日も `user_kinds` だけを見る。**
 *   **API が受理する値と、画面が並べる値は、今日ずれている。**
 * - **ブラウザで画面を1枚も開いていない。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
// **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`】旧(逐語)**:
//     import { assignableRoleValues, roleValuesForKinds, signupKindValues } from "./auth-routes.ts";
import { assignableRoleValues, baseRoleValues, signupKindValues } from "./auth-routes.ts";
import { declaredRoleIds, declaredRoleKinds } from "./owner-scope.ts";
// **【`V8-M38` / `F-G9`】(8-f) が「着手前から `customer` を持っている利用者」を作るために
// `seedSession` を足した**(`PATCH` はもう `customer` を受けないので、口からは作れない)。
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

/** 役割を宣言しているアプリ(**`user_kinds` を1バイトも書いていない**)。 */
const APP_ID = "atelier";
/**
 * 役割は既定3つだけで、立場の一覧(`user_kinds`)を書いている**今日までのアプリ**。
 *
 * **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】**
 * **立場の一覧が廃止されたので、この題材は `user_kinds` を書けなくなった。**
 * **題材を「役割を1つだけ宣言した今日までのアプリ」に入れ替えた** ——
 * **(5-b) の主張(宣言した非運営の1種だけが値域に入る)は、`customer` が
 * つねに値域へ入るぶんだけ弱くなった。** **旧の期待値は (5-b) に逐語で残した。**
 */
const LEGACY_APP_ID = "kouminkan";

/**
 * **`customer` を自分で宣言したアプリ**(`V8-M38` / `F-G9`。(8) 群の題材)。
 *
 * **`F-G9` が変えるのは「宣言していないのに `customer` が値域へ入る」ことだけである** ——
 * **宣言したアプリでは今日どおり `customer` を人に付けられる。**
 */
const CUSTOMER_APP_ID = "shouten";

/**
 * **役割を宣言した題材。** **`reception` は表示名つき、`backoffice` は表示名なし**
 * (`D-V8-79` = 表示名は今日どおり任意。書かなければ識別子が生で出る)。
 *
 * **並びの1本目が `reception` である** —— **`D-V8-78` の「省略したときはその1番目に
 * なります」を実測するために、既定3役割より**前**に置いてある**
 * (`withDefaultRoleRules` は既存の宣言を先頭に残し、足りない既定を後ろへ足す)。
 */
function rolesManifest(): Manifest {
  return withDefaultRoleRules({
    app: {
      id: APP_ID,
      name: "工房",
      tables: [
        {
          id: "notes",
          name: "覚え書き",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
        },
      ],
      views: [{ id: "note-list", type: "list_view", table: "notes", columns: ["title"] }],
      roles: [{ id: "reception", name: "受付係" }, { id: "backoffice" }],
    },
  }) as unknown as Manifest;
}

/** **立場の一覧だけを書いた題材**(役割は既定3つ。**今日までのアプリの形**)。 */
function legacyManifest(): Manifest {
  return withDefaultRoleRules({
    app: {
      id: LEGACY_APP_ID,
      name: "公民館",
      // **【`V8-M29` 第2波】旧(逐語)**: `user_kinds: [{ id: "member", name: "会員" }],`
      roles: [{ id: "owner" }, { id: "editor" }, { id: "viewer" }, { id: "member", name: "会員" }],
      tables: [
        {
          id: "notes",
          name: "覚え書き",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
        },
      ],
      views: [{ id: "note-list", type: "list_view", table: "notes", columns: ["title"] }],
    },
  }) as unknown as Manifest;
}

/**
 * **`customer` を自分で宣言した題材**(`V8-M38` / `F-G9`)。
 *
 * **既定3役割に `customer` を1本足しただけである** —— **他は `rolesManifest` と同じ形。**
 */
function customerManifest(): Manifest {
  return withDefaultRoleRules({
    app: {
      id: CUSTOMER_APP_ID,
      name: "商店",
      tables: [
        {
          id: "notes",
          name: "覚え書き",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
        },
      ],
      views: [{ id: "note-list", type: "list_view", table: "notes", columns: ["title"] }],
      roles: [{ id: "customer", name: "購入者" }],
    },
  }) as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-role-domain-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "工房", { app_id: APP_ID });
    createApp(store, "公民館", { app_id: LEGACY_APP_ID });
    createApp(store, "商店", { app_id: CUSTOMER_APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, rolesManifest()).valid).toBe(true);
  expect(applyManifest(dataRoot, LEGACY_APP_ID, legacyManifest()).valid).toBe(true);
  expect(applyManifest(dataRoot, CUSTOMER_APP_ID, customerManifest()).valid).toBe(true);
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function request(method: string, path: string, body?: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { origin: TEST_ORIGIN };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  return Promise.resolve(
    app.request(
      new Request(`http://localhost${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    ),
  );
}

/** 管理側の登録の口。**1人目は `owner`、2人目以降は `viewer` になる**(着手前と同じ)。 */
async function adminRegister(
  appId: string,
  username: string,
  userKind?: string,
): Promise<{ status: number; cookie: string; id?: string; role?: string }> {
  const body: Record<string, unknown> = { username, password: "pw-123456" };
  if (userKind !== undefined) {
    body.user_kind = userKind;
  }
  const res = await request("POST", `/api/apps/${appId}/auth/password/register`, body);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  if (res.status !== 200) {
    return { status: res.status, cookie: "" };
  }
  const parsed = (await res.json()) as { user: { id: string; role: string } };
  return { status: res.status, cookie, id: parsed.user.id, role: parsed.user.role };
}

/** 自己登録の口。 */
async function selfSignup(
  appId: string,
  username: string,
  userKind?: string,
): Promise<{ status: number; role?: string; body?: unknown }> {
  const body: Record<string, unknown> = { username, password: "pw-123456" };
  if (userKind !== undefined) {
    body.user_kind = userKind;
  }
  const res = await request("POST", `/api/apps/${appId}/auth/signup/password/register`, body);
  if (res.status !== 200) {
    return { status: res.status, body: await res.json() };
  }
  const parsed = (await res.json()) as { user: { role: string } };
  return { status: res.status, role: parsed.user.role };
}

/** owner 1人と、役割を付け替える相手1人を用意する。 */
async function seedOwnerAndTarget(
  appId: string,
): Promise<{ ownerCookie: string; targetId: string }> {
  const owner = await adminRegister(appId, "alice");
  expect(owner.status).toBe(200);
  expect(owner.role).toBe("owner");
  const target = await adminRegister(appId, "bob");
  expect(target.status).toBe(200);
  expect(target.role).toBe("viewer");
  return { ownerCookie: owner.cookie, targetId: target.id as string };
}

// =====================================================================================
// (1) 役割を宣言しただけで、その役割を人に付けられる(関門 `T01-U` の (1))
// =====================================================================================

test("(1-a) 宣言した役割 `reception` を `PATCH .../auth/users/:id` で人に付けられる", async () => {
  // **着手前の実測(`m29-gate.md` §1 の (1))**:
  // > `HTTP/1.1 400` `{"errors":[{"path":"/role","message":"role の値が不正です。",
  // >   "allowed_values":["owner","editor","viewer","customer"], …}]}`
  const { ownerCookie, targetId } = await seedOwnerAndTarget(APP_ID);
  const res = await request(
    "PATCH",
    `/api/apps/${APP_ID}/auth/users/${targetId}`,
    { role: "reception" },
    ownerCookie,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { user: { role: string; roles: string[] } };
  expect(body.user.role).toBe("reception");
  expect(body.user.roles).toContain("reception");
});

test("(1-b) `roles`(複数)にも宣言した役割を書ける", async () => {
  const { ownerCookie, targetId } = await seedOwnerAndTarget(APP_ID);
  const res = await request(
    "PATCH",
    `/api/apps/${APP_ID}/auth/users/${targetId}`,
    { roles: ["reception", "backoffice"] },
    ownerCookie,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { user: { roles: string[] } };
  expect(body.user.roles.sort()).toEqual(["backoffice", "reception"]);
});

// =====================================================================================
// (2) 登録の口で、宣言した役割を名乗れる(関門 `T01-U` の (2) / `D-V8-78`)
// =====================================================================================

test("(2-a) 自己登録で `reception` を名乗れる", async () => {
  // **着手前の実測(`m29-gate.md` §1 の (2a))**: `422`(`allowed_values` は `["customer"]`)。
  // **【`V8-M30` 第2波(2026-08-11)。ユーザ決定 `D-V8-82`。題材だけを直した】**
  // **旧(逐語)**: この直前の1行(`adminRegister`)は無く、`carol` がこのアプリの
  // **最初の1人**だった。**`D-V8-82` により最初の1人は持ち主になるので、
  // 「名乗った役割がそのまま列に入る」を測るには先に誰か1人が要る。**
  // **測っている中身(値域に独自の役割が入ること)は1ミリも変えていない。**
  expect((await adminRegister(APP_ID, "seed-owner")).status).toBe(200);
  const signed = await selfSignup(APP_ID, "carol", "reception");
  expect(signed.status).toBe(200);
  expect(signed.role).toBe("reception");
});

test("(2-b) 既定3役割と `anonymous` は登録で名乗れない(422。`D-V8-78`)", async () => {
  // **`D-V8-78` の説明文の逐語**: 「**持ち主・編集者・閲覧者は登録のときに名乗れず、
  // アプリが自分で作った役割(購入者、受付係など)だけを名乗れます。**」
  // **`anonymous` は `D-V8-80` により、人に結び付く値から必ず外れる。**
  for (const reserved of ["owner", "editor", "viewer", "anonymous"]) {
    const signed = await selfSignup(APP_ID, `x-${reserved}`, reserved);
    expect(signed.status, reserved).toBe(422);
    const body = signed.body as { errors: { allowed_values?: string[] }[] };
    expect(body.errors[0]?.allowed_values, reserved).not.toContain(reserved);
    expect(body.errors[0]?.allowed_values, reserved).toContain("reception");
  }
});

test("(2-c) 管理側の登録の口でも、宣言した役割の名前が拒否されない", async () => {
  // **着手前の実測(`m29-gate.md` §1 の (2b))**: `422`。
  // **【誇張しない】この口は種類を受け取っても**使わない** —— **列に据わるのは
  // 今日どおり「1人目は `owner`、以降は `viewer`」である**(`ADMIN_SIGNUP.resolveRole`)。
  // **本検査が固定するのは「値域が同じ一覧を引いていること」だけである。**
  const created = await adminRegister(APP_ID, "dave", "reception");
  expect(created.status).toBe(200);
  expect(created.role).toBe("owner"); // 1人目なので owner(種類は使われない)
});

// =====================================================================================
// (3) 【この波で最も危ない穴】種類を省略した登録が `owner` にならない
// =====================================================================================

test("(3) 種類を省略した自己登録は `owner` にならず、宣言した独自の役割の1本目になる", async () => {
  // **関門 `T01-U` の (2) の逐語**: 「**`user_kind` 省略時の既定が `allowed[0]` =
  // `"owner"` になったら、それは「立った」ではなく新しい穴である**」。
  // **`app.roles` の1本目は実アプリでは `owner` である**(`create-app` が生む並び)——
  // **したがって「出所を素直に差し替える」実装はこの検査で赤くなる。**
  // **【`V8-M30` 第2波(2026-08-11)。ユーザ決定 `D-V8-82`。題材だけを直した】**
  // **旧(逐語)**: この直前の1行(`adminRegister`)は無く、`erin` がこのアプリの
  // **最初の1人**だった。**`D-V8-82` により最初の1人は持ち主になる** ——
  // **本検査が見張っているのは「`user_kind` 省略時の**既定の値域**が `owner` に
  // なっていないか」であって、「最初の1人が持ち主になるか」ではない。**
  // **したがって最初の1人の席を埋めてから測る。** **見張りは1ミリも緩めていない。**
  // **最初の1人が持ち主になること自体は `src/server/first-user-owner.test.ts` が測る。**
  expect((await adminRegister(APP_ID, "seed-owner")).status).toBe(200);
  const signed = await selfSignup(APP_ID, "erin");
  expect(signed.status).toBe(200);
  expect(signed.role).not.toBe("owner");
  expect(signed.role).toBe("reception");
});

test("(3-b) 登録で名乗れる値の一覧に、予約4語が1つも入らない(関数の値域)", () => {
  // **実アプリの並び(`owner` が1本目)をそのまま渡して測る。**
  // **【`V8-M29` 第2波】旧(逐語)**: 第2引数 `[]`(= 立場の一覧)が在った。
  const values = signupKindValues(["owner", "editor", "viewer", "anonymous", "reception"]);
  expect(values[0]).toBe("reception");
  for (const reserved of ["owner", "editor", "viewer", "anonymous"]) {
    expect(values, reserved).not.toContain(reserved);
  }
});

// =====================================================================================
// (4) `anonymous` は人に付けられない(関門 `T01-U` の (3) / `D-V8-80`)
// =====================================================================================

test("(4-a) `anonymous` を人に付けようとすると 400(値域に入らない)", async () => {
  const { ownerCookie, targetId } = await seedOwnerAndTarget(APP_ID);
  for (const body of [{ role: "anonymous" }, { roles: ["anonymous"] }]) {
    const res = await request(
      "PATCH",
      `/api/apps/${APP_ID}/auth/users/${targetId}`,
      body,
      ownerCookie,
    );
    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { errors: { allowed_values?: string[] }[] };
    expect(parsed.errors[0]?.allowed_values).not.toContain("anonymous");
    // **宣言した役割は値域に入っている**(=「`anonymous` だけを除いた」ことの裏取り)。
    expect(parsed.errors[0]?.allowed_values).toContain("reception");
  }
});

test("(4-b) 役割の宣言としては `anonymous` を書ける(`D-V8-80`。宣言の側は塞がない)", () => {
  // **`D-V8-80` の説明文の逐語**: 「**役割の名前としては今日どおり書けます
  // (「未ログインにも見せる」規則を書くために必要です)が、「未ログイン」を実在の人に
  // 付けることはできなくします。**」
  const withAnonymous = withDefaultRoleRules({
    app: {
      id: APP_ID,
      name: "工房",
      tables: [
        {
          id: "notes",
          name: "覚え書き",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
        },
      ],
      views: [{ id: "note-list", type: "list_view", table: "notes", columns: ["title"] }],
      roles: [{ id: "anonymous", name: "未ログイン" }],
    },
  }) as unknown as Manifest;
  expect(applyManifest(dataRoot, APP_ID, withAnonymous).valid).toBe(true);
  // **宣言できても、人に付けられる値には入らない。**
  expect(declaredRoleIds(withAnonymous)).toContain("anonymous");
  // **【`V8-M29` 第2波】旧(逐語)**: `assignableRoleValues(declaredRoleIds(withAnonymous), [])`
  expect(assignableRoleValues(declaredRoleIds(withAnonymous))).not.toContain("anonymous");
});

// =====================================================================================
// (5) 役割を宣言していないアプリは、今日と同じ値域に倒れる
// =====================================================================================

test("(5-a) 独自の役割が1つも無ければ、値域は着手前と1文字も変わらない", () => {
  // **着手前の実物(`src/server/auth-routes.ts:201`-`:203`)**:
  //     return [...RESERVED_ROLES, ...(kinds.length === 0 ? [DEFAULT_USER_KIND] : kinds)];
  //
  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】旧の本体(逐語)**:
  //
  //     expect(assignableRoleValues([], [])).toEqual(roleValuesForKinds([]));
  //     expect(assignableRoleValues([], ["member"])).toEqual(roleValuesForKinds(["member"]));
  //     // **既定3役割しか宣言していないアプリも同じである**(独自の役割が0本だから)。
  //     expect(assignableRoleValues(["owner", "editor", "viewer"], ["member"])).toEqual(
  //       roleValuesForKinds(["member"]),
  //     );
  //     expect(signupKindValues(["owner", "editor", "viewer"], ["member"])).toEqual(["member"]);
  //     expect(signupKindValues([], [])).toEqual(["customer"]);
  //
  // **第2引数(立場の一覧)が廃止され、`roleValuesForKinds(kinds)` は引数を持たない
  // `baseRoleValues()` になった。** **戻りは着手前に `kinds` が空だったときと同じ4値である。**
  expect(assignableRoleValues([])).toEqual(baseRoleValues());
  // **既定3役割しか宣言していないアプリも同じである**(独自の役割が0本だから)。
  expect(assignableRoleValues(["owner", "editor", "viewer"])).toEqual(baseRoleValues());
  // **`anonymous` を足しても同じである**(人に付けられない値だから)。
  expect(assignableRoleValues(["owner", "editor", "viewer", "anonymous"])).toEqual(
    baseRoleValues(),
  );
  expect(signupKindValues(["owner", "editor", "viewer"])).toEqual(["customer"]);
  expect(signupKindValues([])).toEqual(["customer"]);
});

test("(5-b) 役割を1つだけ宣言したアプリは、HTTP でも今日どおり動く", async () => {
  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`】旧テスト名の逐語**:
  // 「(5-b) 立場の一覧だけを書いた今日までのアプリは、HTTP でも今日どおり動く」。
  // **題材が `user_kinds: [{id:"member"}]` から `roles: [… , {id:"member"}]` に移った。**
  const { ownerCookie, targetId } = await seedOwnerAndTarget(LEGACY_APP_ID);
  const ok = await request(
    "PATCH",
    `/api/apps/${LEGACY_APP_ID}/auth/users/${targetId}`,
    { role: "member" },
    ownerCookie,
  );
  expect(ok.status).toBe(200);
  expect(((await ok.json()) as { user: { role: string } }).user.role).toBe("member");
  const ng = await request(
    "PATCH",
    `/api/apps/${LEGACY_APP_ID}/auth/users/${targetId}`,
    { role: "reception" },
    ownerCookie,
  );
  expect(ng.status).toBe(400);
  const body = (await ng.json()) as { errors: { allowed_values?: string[] }[] };
  // **【2026-08-11。`V8-M29` 第2波】旧の期待値(逐語)**:
  //     expect(body.errors[0]?.allowed_values).toEqual(["owner", "editor", "viewer", "member"]);
  //
  // **【値域の変化。丸めない。これが本波の唯一の値域の変化である】**
  // **着手前は `user_kinds: [{id:"member"}]` を宣言すると `customer` が値域から**外れた**。**
  // **今日は外れない** —— **`customer` は常に入る。**
  // **【根拠を名指しで書く(メインの裁定3)】**
  // **値域を狭めていたのは `app.user_kinds` の宣言そのものである** ——
  // **`src/server/auth-routes.ts` の旧 `roleValuesForKinds` の逐語**:
  //     return [...RESERVED_ROLES, ...(kinds.length === 0 ? [DEFAULT_USER_KIND] : kinds)];
  // **`kinds` が空でないとき(= 立場を宣言したとき)、`DEFAULT_USER_KIND`(= `customer`)は
  // 戻りに1度も入らなかった。** **その `kinds` の唯一の出所は
  // `src/server/owner-scope.ts` の `effectiveUserKindIds`(= `app.user_kinds` を読む)であり、
  // `V8-M29` 第2波が `app.user_kinds` ごと廃止した。**
  // **代わりに立った `app.roles` は「既定に足す」ことしかできず、既定から引き算する
  // 書き方を1つも持たない**(台帳 `J-G2` の限定「アプリの作者は既定に足すことしか
  // できず、引き算(拒否)を1つも書けない」)。
  // **したがって、宣言の側から値域を狭める手段は今日1つも無い。担い手は無い**
  // (`ADR-0301` 限定6 の ④)。
  // **【禁止の履行】これを「影響は無い」と書かない** —— **実挙動が1つ変わった。**

  // ---------------------------------------------------------------------------------
  // **【2026-08-13。`V8-M38`。台帳 `F-G9`。判定値 = 限定採用】期待値を入れ替えた。**
  //
  // **旧(逐語)**:
  //
  //     expect(body.errors[0]?.allowed_values).toEqual([
  //       "owner",
  //       "editor",
  //       "viewer",
  //       "customer",
  //       "member",
  //     ]);
  //
  // **`baseRoleValues()` が `customer` を無条件に足すのをやめたので、`customer` を
  // 1度も宣言していないこのアプリの値域から `customer` が消えた。**
  // **上の (5-b) の doc の「`customer` は常に入る」「宣言の側から値域を狭める手段は
  // 今日1つも無い」の2文は、今日から偽である** —— **旧文を1バイトも消していない。**
  // **狭めたのは宣言の側ではなく、既定の側である。**
  // **`member`(宣言した役割)は今日どおり入っている** —— **落としたのは `customer` の1語だけ。**
  // ---------------------------------------------------------------------------------
  expect(body.errors[0]?.allowed_values).toEqual(["owner", "editor", "viewer", "member"]);
  // **登録で名乗れるのは今日も `member` 1つである**(予約4語を先に落としたあとの1本目)。
  expect((await selfSignup(LEGACY_APP_ID, "frank")).role).toBe("member");
});

// =====================================================================================
// (6) 表示名(`D-V8-79`)
// =====================================================================================

test("(6) 表示名を書いた役割だけが表示名を持ち、書かない役割は識別子が生で出る", () => {
  // **`D-V8-79` の説明文の逐語**: 「**表示名を書かなければ、利用者管理の画面に英字の
  // 識別子(reception など)がそのまま出ます。**」
  const kinds = declaredRoleKinds(rolesManifest());
  expect(kinds.find((kind) => kind.id === "reception")?.name).toBe("受付係");
  // **`backoffice` は `name` を持たないので、表示名の対応表に1度も載らない**
  // —— **載らない = 画面は識別子をそのまま出す**(`roleLabel` の `?? role`)。
  expect(kinds.map((kind) => kind.id)).not.toContain("backoffice");
});

// =====================================================================================
// (7) 既定3役割は今日どおり付けられる
// =====================================================================================

// =====================================================================================
// (8) **人に付けられる役割の一覧を、アプリの宣言と一致させる**
//     (`V8-M38` / `F-G9`。本審査 `docs/plan/v8/records/v8-m35.md` §5-1 = **側α**)
// =====================================================================================
//
// **着手前の実物(`src/server/auth-routes.ts:226`-`:228` の逐語)**:
//
//     export function baseRoleValues(): readonly Role[] {
//       return [...RESERVED_ROLES, DEFAULT_USER_KIND];
//     }
//
// **`DEFAULT_USER_KIND` は `"customer"`。** **アプリが `customer` を1度も宣言していなくても、
// 人に付けられる役割の一覧に入っていた。**
//
// **採った側(審査が決めた)**: **側α = `customer` を無条件に足すのをやめる。**
// **採らなかった側**: **側β(`customer` を既定の役割として `app.roles` に入れる)** ——
// **`src/kernel/types.ts` の `DEFAULT_ROLE_IDS`(3語)が動き、`Δ7` が壊れて門A に落ちる。**
//
// **【射程は `customer` の1語だけである】** **`RESERVED_ROLES`(`owner` / `editor` /
// `viewer`)の側を1バイトも触っていない**((7) が今日どおり緑であることが裏取りである)。

test("(8-a) `customer` を宣言していないアプリでは、人に付けられる値に `customer` が入らない", () => {
  // **着手前**: `baseRoleValues()` は `["owner","editor","viewer","customer"]` を返し、
  // **`assignableRoleValues([])` も同じ4値だった。**
  expect(baseRoleValues() as readonly string[]).not.toContain("customer");
  expect(assignableRoleValues(declaredRoleIds(rolesManifest())) as readonly string[]).not.toContain(
    "customer",
  );
  // **宣言した独自の役割は今日どおり入る**(落としたのは `customer` の1語だけである)。
  expect(assignableRoleValues(declaredRoleIds(rolesManifest())) as readonly string[]).toContain(
    "reception",
  );
});

test("(8-b) `customer` を宣言していないアプリでは、`PATCH` で `customer` を付けられない(400)", async () => {
  // **着手前の実測**: `200`(宣言が1度も無くても付けられた)。
  const { ownerCookie, targetId } = await seedOwnerAndTarget(APP_ID);
  const res = await request(
    "PATCH",
    `/api/apps/${APP_ID}/auth/users/${targetId}`,
    { role: "customer" },
    ownerCookie,
  );
  expect(res.status).toBe(400);
  const body = (await res.json()) as { errors: { allowed_values?: string[] }[] };
  expect(body.errors[0]?.allowed_values).not.toContain("customer");
  expect(body.errors[0]?.allowed_values).toContain("reception");
});

test("(8-c) `customer` を宣言したアプリでは、今日どおり付けられる(200)", async () => {
  const { ownerCookie, targetId } = await seedOwnerAndTarget(CUSTOMER_APP_ID);
  expect(assignableRoleValues(declaredRoleIds(customerManifest())) as readonly string[]).toContain(
    "customer",
  );
  const res = await request(
    "PATCH",
    `/api/apps/${CUSTOMER_APP_ID}/auth/users/${targetId}`,
    { role: "customer" },
    ownerCookie,
  );
  expect(res.status).toBe(200);
  expect(((await res.json()) as { user: { role: string } }).user.role).toBe("customer");
});

test("(8-d) `anonymous` は着手後も人に付けられない(`D-V8-80`。1バイトも触っていない)", async () => {
  // **`NON_ASSIGNABLE_ROLE_ID = "anonymous"`(`src/server/auth-routes.ts`)は
  // `D-V8-80`(2026-08-11)の決定であって欠陥ではない。** **`F-G9` はここを触らない。**
  expect(baseRoleValues() as readonly string[]).not.toContain("anonymous");
  const withAnonymous = withDefaultRoleRules({
    app: {
      id: APP_ID,
      name: "工房",
      tables: [
        {
          id: "notes",
          name: "覚え書き",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
        },
      ],
      views: [{ id: "note-list", type: "list_view", table: "notes", columns: ["title"] }],
      roles: [
        { id: "anonymous", name: "未ログイン" },
        { id: "reception", name: "受付係" },
      ],
    },
  }) as unknown as Manifest;
  expect(declaredRoleIds(withAnonymous)).toContain("anonymous");
  expect(assignableRoleValues(declaredRoleIds(withAnonymous)) as readonly string[]).not.toContain(
    "anonymous",
  );
  // **HTTP でも 400 のままである。**
  const { ownerCookie, targetId } = await seedOwnerAndTarget(APP_ID);
  const res = await request(
    "PATCH",
    `/api/apps/${APP_ID}/auth/users/${targetId}`,
    { role: "anonymous" },
    ownerCookie,
  );
  expect(res.status).toBe(400);
  expect(
    ((await res.json()) as { errors: { allowed_values?: string[] }[] }).errors[0]?.allowed_values,
  ).not.toContain("anonymous");
});

test("(8-e) 登録のときに名乗れる値は0本にならない(`signupKindValues` は `baseRoleValues` を呼ばない)", async () => {
  // **【実測で分かっていた制約】** **`signupKindValues` は `DEFAULT_USER_KIND` を自前で
  // 持っており、`baseRoleValues` を1度も呼ばない**(`v8-m35-c-vocab-feasibility.md`)。
  // **見込みで済ませず、ここで固定する。**
  expect(signupKindValues([])).toEqual(["customer"]);
  expect(signupKindValues(["owner", "editor", "viewer"])).toEqual(["customer"]);
  expect(signupKindValues(["owner", "editor", "viewer", "reception"])).toEqual([
    "reception",
    "customer",
  ]);
  // **HTTP でも、役割を1つも宣言していないアプリの自己登録は今日どおり通る。**
  expect((await adminRegister(LEGACY_APP_ID, "seed-owner-8e")).status).toBe(200);
  const signed = await selfSignup(LEGACY_APP_ID, "grace");
  expect(signed.status).toBe(200);
  expect(signed.role).toBe("member");
});

test("(8-f) すでに `customer` を持っている利用者は値を失わないが、付け直せなくなる(実測)", async () => {
  // **`customer` を宣言していないアプリに、すでに `customer` の利用者が居る場合。**
  // **着手前に作られた行を模して、認証ストアへ直接1人置く**(`PATCH` はもう通らない)。
  const { ownerCookie } = await seedOwnerAndTarget(APP_ID);
  const legacyUser = seedSession(dataRoot, APP_ID, { role: "customer", username: "old-customer" });
  expect(legacyUser.roles).toContain("customer");

  // **(1) 値は残る** —— **一覧に今日どおり `customer` として出る。**
  const list = await request("GET", `/api/apps/${APP_ID}/auth/users`, undefined, ownerCookie);
  expect(list.status).toBe(200);
  const users = ((await list.json()) as { users: { id: string; role: string }[] }).users;
  expect(users.find((user) => user.id === legacyUser.userId)?.role).toBe("customer");

  // **(2) セッションは今日どおり生きている** —— **ログイン済みのまま追い出されない。**
  const me = await request("GET", `/api/apps/${APP_ID}/auth/me`, undefined, legacyUser.cookie);
  expect(me.status).toBe(200);
  expect(((await me.json()) as { user: { role: string } }).user.role).toBe("customer");

  // **(3) いったん別の役割へ変えると、`customer` へ戻せない**(400)。
  const away = await request(
    "PATCH",
    `/api/apps/${APP_ID}/auth/users/${legacyUser.userId}`,
    { role: "viewer" },
    ownerCookie,
  );
  expect(away.status).toBe(200);
  const back = await request(
    "PATCH",
    `/api/apps/${APP_ID}/auth/users/${legacyUser.userId}`,
    { role: "customer" },
    ownerCookie,
  );
  expect(back.status).toBe(400);
  // **戻す手立ては1つある** —— **アプリが `customer` を宣言することである**((8-c))。
});

test("(7) 既定3役割(owner / editor / viewer)は `PATCH` で今日どおり付けられる", async () => {
  const { ownerCookie, targetId } = await seedOwnerAndTarget(APP_ID);
  for (const role of ["editor", "viewer", "owner"]) {
    const res = await request(
      "PATCH",
      `/api/apps/${APP_ID}/auth/users/${targetId}`,
      { role },
      ownerCookie,
    );
    expect(res.status, role).toBe(200);
    expect(((await res.json()) as { user: { role: string } }).user.role, role).toBe(role);
  }
});
