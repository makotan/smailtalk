/**
 * **「ログインなしでも見せる」と書いた画面が、未ログインで**実際に開ける**こと**の検査。
 *
 * ## 由来
 *
 * - **台帳 `T-G27b`** —— **`V8-M25` は「保留」と判定した**(送り先が無かったため)。
 *   **`V8-M26` が再審査して「限定採用」にした**(`docs/adr/0007-vocabulary-governance.md:1358`)。
 * - **ユーザ決定 `D-V8-57`**(`docs/plan/v8/03-user-decisions.md` §4i。選ばれた見出し =
 *   **実際に開けるようにする**)。**説明文の逐語** ——
 *   > 「未ログインで公開画面の中身が見られるようにします。公開の商品一覧のような画面が
 *   > 本当に作れますが、**未ログインの相手に画面の作り(項目の並びなど)が渡ります**。
 *   > 作業が1本増えます。」
 * - **ユーザ決定 `D-V8-64`**(同 §4k。選ばれた見出し = **表にも1行書いたぶんだけ見せる**)。
 *   **説明文の逐語** ——
 *   > 「画面を「公開」と書いただけでは、枠は開きますが中身は空です。その画面が使う表に
 *   > ついても「ログインなしでも見せる」を1行書いて初めてデータが並びます。手数は増えますが、
 *   > 画面を公開にした拍子に想定外の表が丸ごと外に出ることがありません。」
 *
 * ## **この検査が正面から当たった明文**(逐語)
 *
 * **`ADR-0314` 限定2**(`docs/adr/0314-app-definition-login-required.md:244`):
 *   > **未ログインへ渡るキーは3つちょうど** | `app` / `views` / `theme`。**4つ目を足さない。**
 *   > **`app` のキーは `id` / `name` の2つ、画面のキーも `id` / `name` の2つちょうど**
 *
 * **破ったのは後半(画面のキー)だけである。** **前半(トップレベル3キー / `app` の2キー)は
 * 今日も守られており、下の (a) が両方を同じ検査で固定する。**
 *
 * ## **この検査が測らないもの。誇張しない**
 *
 * - **ブラウザで実際に描かれること**は測らない(`web/test/anonymous-public-view.test.tsx` と
 *   `web/e2e/anonymous-public-view.e2e.ts` の担当)。**ここは応答の中身だけである。**
 * - **参照(`reference`)型の項目が指す先の表は渡していない**(`publicTablesForView` の doc)。
 *   **したがって参照の列がどう描かれるかは、ここでは1つも測っていない。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { OWNER_FIELD, PUBLIC_FIELD } from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "pub-open";

/**
 * 題材。**公開の商品一覧**(`D-V8-57` の説明文が名指しした形そのもの)。
 *
 * @param anonymousTableRule 未ログインに**表**の読取規則を書くかどうか(`D-V8-64` の分岐)。
 */
function manifest(anonymousTableRule: boolean): Manifest {
  const anonymousRules: Record<string, unknown>[] = [
    { target: "view", view: "public-catalog", can: ["read"] },
  ];
  if (anonymousTableRule) {
    anonymousRules.push({ target: "table", table: "product", can: ["read"] });
  }
  return {
    app: {
      id: APP_ID,
      name: "みどり商店",
      tables: [
        {
          id: "product",
          name: "商品",
          fields: [
            { id: "name", name: "商品名", type: "text", required: true },
            { id: "price", name: "価格", type: "number" },
            // **運営メモ** —— **公開画面に載せた項目は今日1本も隠せない**(下の (e))。
            { id: "secret_memo", name: "運営メモ", type: "text" },
            { id: PUBLIC_FIELD, name: "公開", type: "boolean" },
          ],
        },
        {
          id: "order",
          name: "注文",
          fields: [
            { id: "total", name: "合計", type: "number" },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
          ],
        },
      ],
      views: [
        // **未ログインに開く画面**(`anonymous` の規則が名指しする)。
        {
          id: "public-catalog",
          name: "商品一覧",
          type: "list_view",
          table: "product",
          columns: ["name", "price", "secret_memo"],
        },
        // **運営だけに開く画面**(同じ表に載っている。表単位では割れない)。
        {
          id: "admin-product-list",
          name: "商品(運営)",
          type: "list_view",
          table: "product",
          columns: ["name", "price", "secret_memo"],
        },
        // **規則を1本も書かない画面**(別の表に載っている)。
        {
          id: "unruled-order-list",
          name: "注文一覧",
          type: "list_view",
          table: "order",
          columns: ["total"],
        },
      ],
      roles: [{ id: "anonymous", name: "未ログイン", rules: anonymousRules }],
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

async function setup(anonymousTableRule: boolean): Promise<void> {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-public-open-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "みどり商店", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **既定3役割には表の規則だけを足す**(`skipAllViews: true`)——
  // **画面の規則を足すと「未ログインに開いた画面だけが載る」が測れなくなる。**
  expect(
    applyManifest(
      dataRoot,
      APP_ID,
      withDefaultRoleRules(manifest(anonymousTableRule), { skipAllViews: true }),
    ).valid,
  ).toBe(true);
  app = createServerApp({ dataRoot });
}

beforeEach(() => {
  dataRoot = "";
});

afterEach(async () => {
  if (dataRoot !== "") {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

function req(cookie: string | undefined, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { origin: TEST_ORIGIN };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return app.request(new Request(`http://localhost${path}`, init));
}

type PublicBody = {
  app: { id: string; name: string };
  views: (Record<string, unknown> & {
    id: string;
    name: string;
    tables: { id: string; fields: { id: string }[] }[];
  })[];
  theme?: unknown;
  /** **【`V8-M5-T03`】登録に要る事実**(`ADR-0338` §3-1。`D-V8-114`)。 */
  signup: {
    kinds: { id: string; name: string; invite: boolean }[];
    adminInvite: boolean;
  };
};

async function publicBody(): Promise<PublicBody> {
  const res = await req(undefined, "GET", `/api/apps/${APP_ID}/public`);
  expect(res.status).toBe(200);
  return (await res.json()) as PublicBody;
}

/** 行を2件仕込む(公開1件 / 非公開1件)。**運営メモの値も入れる。** */
async function seedProducts(): Promise<void> {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const path = `/api/apps/${APP_ID}/tables/product/records`;
  for (const row of [
    { name: "藻塩", price: 800, secret_memo: "仕入れ値 300", [PUBLIC_FIELD]: true },
    { name: "試作品", price: 0, secret_memo: "未発売", [PUBLIC_FIELD]: false },
  ]) {
    const res = await req(owner.cookie, "POST", path, row);
    expect(res.status).toBe(201);
  }
}

// --- (a) 未ログインで公開画面の定義が返る ---------------------------------------------------

test("(a) 未ログインの GET /public に、公開画面の定義が返る(応答のキーの全量を固定する)", async () => {
  await setup(true);
  const body = await publicBody();

  // **【`ADR-0314` 限定2 の前半。今日は破っている】**
  //
  // **旧の期待値の逐語(1バイトも消していない)**:
  // ```
  //   // **【`ADR-0314` 限定2 の前半。今日も守られている】**
  //   // **トップレベルのキーは `app` / `views` / `theme` の3つちょうどであり、4つ目は無い。**
  //   // **本題材は `app.theme` を書いていないので、実測は2つである**(`#26` と同じ形)。
  //   expect(Object.keys(body).sort()).toEqual(["app", "views"]);
  // ```
  //
  // **なぜ変わったか**: **ユーザ決定 `D-V8-115`**(`docs/plan/v8/03-user-decisions.md` §4aa。
  // 選ばれた見出し = **変更として記録して進める (推奨)**)が、
  // **`ADR-0319` 限定1(応答のトップレベルのキーを4つ目にしない)を引き直す側に倒した。**
  // **足したのは登録に要る事実の1キーである**(`ADR-0338` §3-1)。
  // **`D-V8-114`(選ばれた見出し = **立場の一覧を返して出し分ける (推奨)**)が中身を決めた。**
  //
  // **【失った性質を明記する】** **「未ログインへ渡るキーは3つちょうど」は今日から偽である。**
  // **`toEqual` の完全一致は緩めていない**(4つ目が増えただけで、5つ目が出れば赤くなる)。
  expect(Object.keys(body).sort()).toEqual(["app", "signup", "views"]);
  // **`app` のキーは `id` / `name` の2つちょうど**(1バイトも動かしていない)。
  expect(Object.keys(body.app).sort()).toEqual(["id", "name"]);
  expect(body.app).toEqual({ id: APP_ID, name: "みどり商店" });

  // **【`ADR-0314` 限定2 の後半。今日は破っている】**
  // **旧の期待値の逐語**: `expect(Object.keys(view).sort()).toEqual(["id", "name"]);`
  // **根拠 = `D-V8-57`(実際に開けるようにする)/ 台帳 `T-G27b` の再審査(限定採用)/
  //   `V8-M26`。** **名前だけでは画面を描けないので、定義そのものを渡す。**
  expect(body.views.length).toBe(1);
  const view = body.views[0] as PublicBody["views"][number];
  expect(Object.keys(view).sort()).toEqual(["columns", "id", "name", "table", "tables", "type"]);
  expect(view.id).toBe("public-catalog");
  expect(view.name).toBe("商品一覧");
  expect(view.type).toBe("list_view");
  expect(view.table).toBe("product");
  expect(view.columns).toEqual(["name", "price", "secret_memo"]);

  // **その画面が描くのに要る表の定義が、画面の中に1つだけ入っている。**
  expect(view.tables.map((table) => table.id)).toEqual(["product"]);
  expect(view.tables[0]?.fields.map((field) => field.id)).toEqual([
    "name",
    "price",
    "secret_memo",
    PUBLIC_FIELD,
  ]);
  // **表の定義に行(データ)は1行も入っていない**(`D-V8-64` の線)。
  expect(Object.keys(view.tables[0] as object)).not.toContain("records");
});

// --- (b) 開いていない画面・使わない表は1バイトも渡らない -------------------------------------

test("(b) anonymous の規則を書いていない画面の定義は1バイトも返らない", async () => {
  await setup(true);
  const res = await req(undefined, "GET", `/api/apps/${APP_ID}/public`);
  const text = await res.text();
  const body = JSON.parse(text) as PublicBody;

  // **運営専用の画面も、規則を1本も書いていない画面も載らない。**
  expect(body.views.map((view) => view.id)).toEqual(["public-catalog"]);
  // **本文そのものに綴りが1度も現れない**(「ID だけ落として定義が残る」を防ぐ)。
  for (const forbidden of ["admin-product-list", "unruled-order-list", "商品(運営)", "注文一覧"]) {
    expect(text, forbidden).not.toContain(forbidden);
  }
  // **その画面が使わない表(`order`)の定義も、項目も、1バイトも渡らない。**
  for (const forbidden of ["order", "total", OWNER_FIELD, "合計", "所有者"]) {
    expect(text, forbidden).not.toContain(forbidden);
  }
  // **権限の宣言そのもの(`app.roles`)と自動処理も渡らない**(旧からの継続。緩めていない)。
  for (const forbidden of ["roles", "workflows", "functions", "user_kinds", "anonymous"]) {
    expect(text, forbidden).not.toContain(forbidden);
  }
});

// --- (c) 表に規則を書かなければ、画面は開けても行は0件(D-V8-64)-----------------------------

test("(c) 画面だけを公開にしても、表に規則が無ければ行は0件である(D-V8-64)", async () => {
  await setup(false);
  await seedProducts();

  // **画面の定義は返る**(枠は開く)。
  const body = await publicBody();
  expect(body.views.map((view) => view.id)).toEqual(["public-catalog"]);

  // **中身は空である。**
  const res = await req(
    undefined,
    "GET",
    `/api/apps/${APP_ID}/tables/product/records?view=public-catalog`,
  );
  expect(res.status).toBe(200);
  const records = ((await res.json()) as { records: unknown[] }).records;
  // **【正直に書く】止まり方は 403 ではなく「200 かつ 0件」である** ——
  // **呼び出し側から「権限が無い」と「データが無い」が区別できない**(`ADR-0319` §7 の 3)。
  expect(records.length).toBe(0);
});

// --- (d) 表にも書けば行が並ぶ ---------------------------------------------------------------

test("(d) 表にも anonymous の読取規則を1本書けば、公開行が並ぶ", async () => {
  await setup(true);
  await seedProducts();

  const res = await req(
    undefined,
    "GET",
    `/api/apps/${APP_ID}/tables/product/records?view=public-catalog`,
  );
  expect(res.status).toBe(200);
  const records = (await res.json()).records as Record<string, unknown>[];
  // **並ぶのは `st_public` が真の行だけである** —— **面の規則は `ADR-0034` の窓を
  // 1ミリも開けない**(`ADR-0319` 限定7)。
  expect(records.length).toBe(1);
  expect(records[0]?.name).toBe("藻塩");
});

// --- (e) 公開画面で項目は1本も隠せない ------------------------------------------------------

test("(e) 未ログインに項目の規則は1本も書けない(隠す手段が語彙に無い。拒否メッセージごと固定)", async () => {
  await setup(true);
  // **`anonymous` に `target: "field"` を1本書いた宣言を適用すると、拒否される。**
  const hidden = manifest(true) as unknown as {
    app: { roles: { id: string; rules: Record<string, unknown>[] }[] };
  };
  hidden.app.roles[0]?.rules.push({
    target: "field",
    table: "product",
    field: "secret_memo",
    can: ["read"],
  });
  const applied = applyManifest(
    dataRoot,
    APP_ID,
    withDefaultRoleRules(hidden, { skipAllViews: true }) as unknown as Manifest,
  );
  expect(applied.valid).toBe(false);
  const errors = (applied as { errors: { message: string; allowed_values?: string[] }[] }).errors;
  // **実測の拒否メッセージ(2件ちょうど。2026-08-11)。**
  expect(errors.map((error) => error.message)).toEqual([
    'target の値 "field" は語彙にありません。',
    'プロパティ "field" は、この種別では指定できません。',
  ]);
  expect(errors[0]?.allowed_values).toEqual(["table", "view", "action"]);

  // **したがって公開画面に載せた運営メモは、未ログインに値ごと渡る。**
  await seedProducts();
  const res = await req(
    undefined,
    "GET",
    `/api/apps/${APP_ID}/tables/product/records?view=public-catalog`,
  );
  const records = (await res.json()).records as Record<string, unknown>[];
  expect(records[0]?.secret_memo).toBe("仕入れ値 300");
  // **画面の定義の側でも隠れていない**(列にも項目の定義にも残っている)。
  const body = await publicBody();
  expect(body.views[0]?.columns).toContain("secret_memo");
  expect(body.views[0]?.tables[0]?.fields.map((field) => field.id)).toContain("secret_memo");
});

// =============================================================================================
// **【`V8-M5-T03`。台帳 `I-G27`(却下だが `D-V8-112` により実施)/ `I-G8`(却下)】**
// **登録に要る事実(`signup`)を `GET /public` の4つ目のキーとして返す**(`ADR-0338` §3-1)
// =============================================================================================
//
// **判定手段はここである** —— **`GET /api/apps/:app_id/public` の JSON の差分**(裁定 `M0-4`)。
// **`curl` の HTML 差分では判定しない**(SPA なので3本とも同一の394バイトになる)。
// **【禁止】「画面を開いて目で見た」を判定手段にしない。**

const SIGNUP_APP_ID = "pub-signup";

/**
 * 題材2。**招待制を宣言したアプリ。**
 *
 * - `member` …… **セルフ登録で名乗れる。招待は要らない。**
 * - `staff` …… **セルフ登録で名乗れる。招待が要る**(`signup: "invite"`)。
 * - `viewer`(予約語)…… **`signup: "invite"`。運営が人を足す口が招待を要求する側になる。**
 * - `anonymous` …… **人には付けられない**(`D-V8-80`)。**値域に出てはならない。**
 */
function signupManifest(): Manifest {
  return {
    app: {
      id: SIGNUP_APP_ID,
      name: "みどり商店(招待制)",
      tables: [
        {
          id: "product",
          name: "商品",
          fields: [{ id: "name", name: "商品名", type: "text", required: true }],
        },
      ],
      views: [
        {
          id: "public-catalog",
          name: "商品一覧",
          type: "list_view",
          table: "product",
          columns: ["name"],
        },
      ],
      roles: [
        {
          id: "anonymous",
          name: "未ログイン",
          rules: [{ target: "view", view: "public-catalog", can: ["read"] }],
        },
        {
          id: "member",
          name: "会員",
          rules: [{ target: "table", table: "product", can: ["read"] }],
        },
        {
          id: "staff",
          name: "スタッフ",
          signup: "invite",
          rules: [{ target: "table", table: "product", can: ["read"] }],
        },
        // **予約語の1つに `signup: "invite"` を書く** —— **運営が人を足す口が招待を要求する側になる。**
        {
          id: "viewer",
          name: "閲覧者",
          signup: "invite",
          rules: [{ target: "table", table: "product", can: ["read"] }],
        },
      ],
    },
  } as unknown as Manifest;
}

async function setupSignupApp(): Promise<void> {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-public-signup-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "みどり商店(招待制)", { app_id: SIGNUP_APP_ID });
  } finally {
    store.close();
  }
  expect(
    applyManifest(
      dataRoot,
      SIGNUP_APP_ID,
      withDefaultRoleRules(signupManifest(), { skipAllViews: true }),
    ).valid,
  ).toBe(true);
  app = createServerApp({ dataRoot });
}

async function signupPublicBody(): Promise<PublicBody> {
  const res = await req(undefined, "GET", `/api/apps/${SIGNUP_APP_ID}/public`);
  expect(res.status).toBe(200);
  return (await res.json()) as PublicBody;
}

// --- (f) 名乗れる値の全体と、その招待の要否が返る ---------------------------------------------

test("(f) 未ログインの GET /public に、セルフ登録で名乗れる立場と招待の要否が返る", async () => {
  await setupSignupApp();
  const body = await signupPublicBody();

  // **`signup` の下は `kinds` と `adminInvite` の2キーちょうど**(`ADR-0338` 限定3)。
  expect(Object.keys(body.signup).sort()).toEqual(["adminInvite", "kinds"]);
  // **`kinds[]` は `id` / `name` / `invite` の3キーちょうど**(同 限定3 / 限定13)。
  for (const kind of body.signup.kinds) {
    expect(Object.keys(kind).sort()).toEqual(["id", "invite", "name"]);
  }
  // **サーバが受理する値そのものである** —— **`anonymous` も予約3語も入らない。**
  expect(body.signup.kinds.map((kind) => kind.id)).toEqual(["member", "staff", "customer"]);
  // **表示名は宣言があればそれ、無ければ識別子**(`D-V8-79` により `name` は任意)。
  expect(body.signup.kinds.map((kind) => kind.name)).toEqual(["会員", "スタッフ", "customer"]);
  // **`invite` は「その立場で名乗ったとき招待が要るか」。**
  expect(body.signup.kinds.map((kind) => kind.invite)).toEqual([false, true, false]);
  // **`adminInvite` は「運営が人を足す口が招待を要求するか」**(予約3語のどれかが `"invite"`)。
  expect(body.signup.adminInvite).toBe(true);
});

// --- (g) 値域はサーバの1本と1対1である(2箇所目を作らない)-------------------------------------

test("(g) kinds は登録の口が受理する値と1対1である(値域を2箇所に書いていない)", async () => {
  await setupSignupApp();
  const body = await signupPublicBody();
  const openKind = body.signup.kinds.find((kind) => !kind.invite);
  expect(openKind?.id).toBe("member");

  // **`/public` が返した値のうち、招待の要らないものは実際に登録できる。**
  const selfPath = `/api/apps/${SIGNUP_APP_ID}/auth/signup/password/register`;
  const ok = await req(undefined, "POST", selfPath, {
    username: "midori-1",
    password: "pw123456",
    user_kind: openKind?.id,
  });
  expect(ok.status).toBe(200);

  // **`/public` が返していない値(予約語 / `anonymous`)は 422 で却けられる** ——
  // **画面の値域とサーバの値域が同じ1本から出ていることの実測である。**
  for (const rejected of ["owner", "editor", "viewer", "anonymous"]) {
    const res = await req(undefined, "POST", selfPath, {
      username: `midori-${rejected}`,
      password: "pw123456",
      user_kind: rejected,
    });
    expect(res.status, rejected).toBe(422);
  }
});

// --- (h) 渡してはならないものが1つも入っていない ---------------------------------------------

test("(h) signup に規則も人数も利用者の一覧も招待コードも1文字も入らない(限定13)", async () => {
  await setupSignupApp();
  const res = await req(undefined, "GET", `/api/apps/${SIGNUP_APP_ID}/public`);
  const text = await res.text();
  const body = JSON.parse(text) as PublicBody;
  expect(body.signup.kinds.length).toBeGreaterThan(0);

  // **役割の規則(`rules`)も条件(`when`)も人数も利用者も、1件も現れない。**
  for (const forbidden of ["rules", "when", "count", "users", "invitation", "code"]) {
    expect(text, forbidden).not.toContain(forbidden);
  }
  // **行(データ)を1行も渡さない**(`D-V8-64` / `ADR-0319` 限定3)。
  expect(text).not.toContain("records");
  // **トップレベルは4つで閉じる**(5つ目を足さない)。
  expect(Object.keys(body).sort()).toEqual(["app", "signup", "views"]);
});

// --- (i) 招待を1つも宣言していないアプリでも signup キーは出る(丸めない)---------------------

test("(i) 招待を1つも宣言していないアプリでも signup キーは出る(応答は全アプリで変わる)", async () => {
  await setup(true);
  const body = await publicBody();

  // **【禁止】「既存アプリの応答は1バイトも変わらない」と書かない**(裁定 `M5-1`)——
  // **宣言が1つも無いアプリでも、キーは増える。**
  expect(Object.keys(body)).toContain("signup");
  // **宣言が無ければ名乗れるのは既定の1つだけであり、招待は1つも要らない。**
  expect(body.signup.kinds).toEqual([{ id: "customer", name: "customer", invite: false }]);
  expect(body.signup.adminInvite).toBe(false);
});
