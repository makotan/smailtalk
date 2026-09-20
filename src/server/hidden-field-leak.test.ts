/**
 * **「客に見せない」と宣言した項目に残っていた漏れ口を塞ぐ**(`V4-M35`。ユーザ決定 **`D-V4-124`**)。
 *
 * **上位の記録**: [`docs/plan/v4/records/v4-m35.md`](../../docs/plan/v4/records/v4-m35.md)。
 * **直前の同種の実装**: [`ADR-0120`](../../docs/adr/0120-hidden-field-query-restriction.md)
 * (`V4-M25` 門A 本審査 単位A = 限定採用 / 実装は `V4-M28`)。
 *
 * ## ここで測るもの(**本物の SQLite / 本物の HTTP**)
 *
 * | 漏れ口 | 何を | 今日の扱い |
 * |---|---|---|
 * | **(a)** | **画面(`list_view`)が「隠した項目で並べ替える」と宣言した場合の、行の順序からの大小関係** | **`V4-M35` は1バイトも実装していない** —— **`V4-M28` の副作用で、その画面が出す読取要求は既に 400 になる。****塞ぎ直せないので、今日の状態を検査で固定するだけである**(§(a)) |
 * | **(b)** | **作成・更新・バッチの応答に、宣言した項目の値がそのまま出る** | **塞ぐ**(§(b)) |
 * | **(c)** | **入力を間違えたときの 400 の `allowed_values` に、宣言した項目のIDが並ぶ** | **塞ぐ**(§(c)) |
 * | **(d)** | **お客様が更新で宣言した項目に書き込める** | **今日のまま。****塞がない**(§(d)。**穴として固定する**) |
 *
 * ## 【この検査が言わないこと。誇張しない】
 *
 * 1. **【禁止】「隠した項目が漏れなくなった」と書かない。** **(d) は今日も開いている** ——
 *    **原価や内部区分をお客様側から書き換えられる状態は今日も続く**(`D-V4-124` 逐語)。
 *    **§(d) がそれを実測で固定している。**
 * 2. **MCP 経路は1バイトも変えていない**(`ADR-0071` 限定9)。**`list_records` は今日も
 *    宣言を1つも見ない。**
 * 3. **`GET /manifest` は今日も未ログインで全項目・全画面の定義を返す**(`D-V4-91`)。
 *    **落ちるのは値であって定義ではない。**
 * 4. **書き忘れた項目は今日どおり全員に出るし、`allowed_values` にも今日どおり並ぶ**
 *    (`ADR-0071` 限定7/限定8 の既定)。
 *
 * ---
 *
 * ## **【`V8-M20` / 台帳 `J-G28` / `J-G30` / `ADR-0301` / ユーザ決定 `D-V8-35`】置き直した**
 *
 * **上の表と注意書きを1バイトも書き換えていない。** **この題材が使っていた宣言のうち2つが
 * 廃止され、面(`app.roles[].rules`)へ移った。**
 *
 * | 廃止したもの | 台帳 | この fixture での置き直し |
 * |---|---|---|
 * | `field.audience`(項目の「見せる相手」) | `J-G28` | `{ target: "field", table, field, can: ["read"] }` |
 * | `st_admin_readable`(運営可視の予約規約フィールド) | `J-G30` | `{ target: "table", table: "profile", can: ["read"] }` |
 *
 * **測る4つの漏れ口((a)〜(d))と、それぞれの今日の扱いは1ミリも変えていない**
 * (`ADR-0301` 限定6 の置き直し)。
 *
 * **【置き直しで変わった点。誇張しないために先に書く】**
 *
 * 1. **面の規則は対象を名指しした時点で全動詞が allow-list になる。** **`profile` を
 *    表として名指しした結果、`profile` への書込も allow-list になった** —— **fixture は
 *    実際に書いている役割(`owner` / `editor` / `customer`)に `write` を明示的に足してある。**
 *    **足さなければ、着手前に通っていた作成・更新が 403 になる。**
 * 2. **`D-V8-35` により、`profile` を「読める」と書いた役割は `st_owner`(個人スコープ)を
 *    **読取について**越える** —— **`owner` が客の行を読めるのはこの経路である**(旧
 *    `st_admin_readable` の置き換え)。**同時に、`customer` にも読取を書いてあるので、
 *    客も全員分の `profile` を読める状態になっている。** **この fixture には客が1人しか
 *    居ないので (d) の結論は変わらないが、「代償が無い」とは書かない**(`D-V8-35` の逐語)。
 * 3. **未ログイン(`anonymous`)には項目の規則を1本も書けない**(`J-G11` の非対称)——
 *    **旧 `audience` の値域が匿名を持たなかったことと、結果は同じである。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Role } from "../auth/types.ts";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { OWNER_FIELD, PUBLIC_FIELD, scrubHiddenFieldIds } from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "m35-shop";

/**
 * **面の規則**(`V8-M20` の置き直し)。
 *
 * **【置き直し前の形。1バイトも書き換えずに残す】** ——
 * `product.cost` に `audience: ["owner"]` / `product.sku` に `audience: ["owner", "editor"]` /
 * `profile.rank` と `profile.memo` に `audience: ["owner"]` /
 * `profile` に予約規約フィールド `{ id: ADMIN_READABLE_FIELD, name: "運営可視", type: "boolean" }`。
 *
 * **`write` を足してある相手は、着手前に実際に書いていた相手だけである** ——
 * `owner` / `editor` が商品を作り、`editor`(バッチ)と `customer` が `profile` を作る。
 */
const ROLES = [
  {
    id: "owner",
    name: "持ち主",
    rules: [
      // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
      { target: "app", can: ["write"] },
      { target: "role", can: ["write"] },
      { target: "field", table: "product", field: "cost", can: ["read", "write"] },
      { target: "field", table: "product", field: "sku", can: ["read", "write"] },
      { target: "field", table: "profile", field: "rank", can: ["read", "write"] },
      { target: "field", table: "profile", field: "memo", can: ["read", "write"] },
      // **旧 `st_admin_readable` の置き換え**(`J-G30` / `D-V8-35`)——
      // **これが「運営が客の行を横断して読める」を成り立たせている唯一の1本である。**
      { target: "table", table: "profile", can: ["read", "write"] },
    ],
  },
  {
    id: "editor",
    name: "編集者",
    rules: [
      // **`cost` は owner にだけ見せる** —— **editor には `write` だけを書く**
      // (着手前の `audience` は書込を1バイトも絞らなかった)。
      { target: "field", table: "product", field: "cost", can: ["write"] },
      { target: "field", table: "product", field: "sku", can: ["read", "write"] },
      { target: "field", table: "profile", field: "rank", can: ["write"] },
      { target: "field", table: "profile", field: "memo", can: ["write"] },
      { target: "table", table: "profile", can: ["write"] },
    ],
  },
  { id: "viewer", name: "閲覧者" },
  {
    id: "customer",
    name: "お客様",
    rules: [
      // **読めないが書ける**((d) が固定している「今日のまま」の穴)。
      { target: "field", table: "profile", field: "rank", can: ["write"] },
      { target: "field", table: "profile", field: "memo", can: ["write"] },
      { target: "table", table: "profile", can: ["read", "write"] },
    ],
  },
];

/**
 * 題材(`D-V4-36` / `ADR-0071` の題材をそのまま引き継ぐ)。
 *
 * - `product.cost` … **owner にだけ見せる**(**editor も外**)。**(b) と (c) の主題材。**
 * - `product.sku` … **owner と editor に見せる**(**役割ごとに答えが変わることを見るため**)。
 * - `product.grade` … **select**。**(c) の誤爆よけ**(選択肢の列挙は1バイトも変えない)。
 * - `product.margin` … **宣言し忘れた項目**(既定は「出す」。1ミリも変えない)。
 * - `profile` … **`st_owner` を持つ客のテーブル**。**(b) と (d) の題材**(客が自分で書ける)。
 */
function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "見せ分けの店",
      tables: [
        {
          id: "product",
          name: "商品",
          fields: [
            { id: "name", name: "商品名", type: "text", required: true },
            { id: "price", name: "価格", type: "number" },
            { id: "cost", name: "原価", type: "number" },
            { id: "sku", name: "仕入先コード", type: "text" },
            { id: "margin", name: "粗利", type: "number" },
            {
              id: "grade",
              name: "状態",
              type: "select",
              options: ["新品", "良好", "要修理"],
            } as never,
            { id: PUBLIC_FIELD, name: "公開", type: "boolean" },
          ],
        },
        {
          id: "profile",
          name: "会員情報",
          fields: [
            { id: "nickname", name: "表示名", type: "text", required: true },
            { id: "rank", name: "内部区分", type: "text" },
            { id: "memo", name: "社内メモ", type: "text" },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
            // **【`V8-M20` / `J-G30`】ここに在った運営可視の予約規約フィールド
            // (`st_admin_readable`)は廃止した。** **owner が客の行を読めるのは、今日は
            // 上の `ROLES` に書いた `{ target: "table", table: "profile", can: ["read"] }` に
            // よる**(`D-V8-35`)。**これが無いと owner は客の行を1件も読めず、(d) が
            // 「本当に書けたか」を確かめられない。**
          ],
        },
        {
          // **面の規則を1本も書いていないテーブル**(既定を1ミリも変えていないことの当たり先)。
          id: "note",
          name: "メモ",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "body", name: "本文", type: "text" },
          ],
        },
      ],
      views: [
        // **(a) の題材** —— **画面が「隠した項目で並べ替える」と宣言している。**
        {
          id: "catalog-list",
          type: "list_view",
          table: "product",
          columns: ["name", "price"],
          sort: { field: "cost", order: "desc" },
        } as never,
        // **【`V18-M4-T02b`。ユーザ決定 `D-V18-26` / `ADR-0441`】壁を開けるためだけの一覧。**
        // **`catalog-list` と違って `sort` を持たない** —— **(a) が測っている
        // 「画面が隠した項目で並べ替えると宣言している」形は1バイトも増やしていない。**
        { id: "shop-list", type: "list_view", table: "product", columns: ["name"] },
        { id: "profile-list", type: "list_view", table: "profile", columns: ["nickname"] },
        { id: "note-list", type: "list_view", table: "note", columns: ["title"] },
      ],
      roles: ROLES,
    },
  } as unknown as Manifest;
}

/**
 * **【`V8-M26`】適用する題材**(`beforeEach` が `applyManifest` に渡すもの)。
 *
 * **既定が閉じた**(`V8-M26` / ユーザ決定 `D-V8-45` / `D-V8-65`)—— **規則を1本も
 * 名指ししていない表・画面・ボタンは拒否される。**
 *
 * **本ファイルの主題は項目(`field`)の見せ分けであり、項目の層は今日も閉じていない**
 * (台帳 `T-G1b` = 却下)。**したがって面(表と画面)を開けるだけで主題は1ミリも動かない** ——
 * **`withDefaultRoleRules` が既定3役割へ入れるのは `apply-diff.ts` の自動付与と同じ規則
 * だけであり、項目の規則は1本も足さない。**
 *
 * **`customer` は既定3役割に入らないので手で書く** —— **上の `ROLES` が既に `profile` を
 * 名指ししているので、足すのは `product` の読取1語だけである**(客が商品を読めることが
 * (a) と (c) の5経路の前提)。**書込・削除は1語も書いていない。**
 * **`anonymous` にも `product` の読取1語だけを書く**(同じ理由。`J-G11` により未ログインには
 * 動詞 `read` しか書けない)。
 */
function seededManifest(): Manifest {
  // **`manifest()` の `roles` はモジュール定数 `ROLES` そのものを指しているので、必ず複製する。**
  const m = structuredClone(manifest()) as unknown as {
    app: { roles: { id: string; name: string; rules?: unknown[] }[] };
  };
  const customer = m.app.roles.find((role) => role.id === "customer") as { rules: unknown[] };
  // **【`V18-M4-T02b`。ユーザ決定 `D-V18-26` / `ADR-0441`】画面の規則を足した。**
  //
  // **`V18-M4-T02` が「画面名を名乗らない読取」に壁を立てた** —— **その表を指す一覧系の
  // 画面(`list_view` / `report_view`)を**1本も読めない**相手の一覧は 0件になる
  // (単票の口は `detail_view` / `form` を見て 404 になる)。** **`D-V18-26` により、
  // 画面を宣言しているのに「誰に見せるか」を役割の規則に1行も書いていない場合も止まる。**
  //
  // **この題材は `product` を指す一覧(`catalog-list`)を宣言しながら、`customer` には
  // 画面の規則を1本も書いていなかった** —— **その結果
  // `GET ...?sum=no_such_field` が 400 ではなく 200 を返していた**(壁が合計の検査より
  // 手前で一覧を空にするため)。**本ファイルの主題は「宣言つき項目のIDが 400 の本文に
  // 並ばないこと」であって画面の規則ではないので、主張(`expect`)は1バイトも
  // 書き換えていない。**
  //
  // **`catalog-list` に規則を足して済ませることはできない** —— **(a) が
  // 「匿名と客は `?view=catalog-list` を名乗って 403」を測っており、そこへ客の規則を
  // 足すと 403 が 400 になって、その測定が丸ごと消えるからである**(実測で1本落ちた)。
  // **そこで、壁を開けるためだけの一覧 `shop-list` を題材に1本足し、そちらを名指しする。**
  customer.rules = [
    ...customer.rules,
    { target: "table", table: "product", can: ["read"] },
    { target: "view", view: "shop-list", can: ["read"] },
  ];
  m.app.roles.push({
    id: "anonymous",
    name: "未ログイン",
    rules: [{ target: "table", table: "product", can: ["read"] }],
  });
  return withDefaultRoleRules(m) as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
const cookies = new Map<Role, string>();

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-m35-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "見せ分けの店", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, seededManifest()).valid).toBe(true);
  app = createServerApp({ dataRoot });
  cookies.clear();
  for (const role of ["owner", "editor", "viewer", "customer"] as const) {
    cookies.set(role, seedSession(dataRoot, APP_ID, { role }).cookie);
  }
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function cookie(role: Role): string {
  return cookies.get(role) as string;
}

function req(
  auth: string | undefined,
  method: string,
  path: string,
  body?: unknown,
  ifMatch?: string,
): Promise<Response> {
  const headers: Record<string, string> = { origin: TEST_ORIGIN };
  if (auth !== undefined) {
    headers.cookie = auth;
  }
  if (ifMatch !== undefined) {
    headers["if-match"] = ifMatch;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return Promise.resolve(app.request(new Request(`http://localhost${path}`, init)));
}

const PRODUCTS = `/api/apps/${APP_ID}/tables/product/records`;
const PROFILES = `/api/apps/${APP_ID}/tables/profile/records`;
const NOTES = `/api/apps/${APP_ID}/tables/note/records`;
const BATCH = `/api/apps/${APP_ID}/batch`;

/** 400 応答の `allowed_values` を全部つなげて返す。 */
async function allowedValuesOf(res: Response): Promise<string[]> {
  const body = (await res.json()) as { errors?: { allowed_values?: string[] }[] };
  return (body.errors ?? []).flatMap((error) => error.allowed_values ?? []);
}

/** 書込応答の `record` を返す。 */
async function recordOf(res: Response): Promise<Record<string, unknown>> {
  const body = (await res.json()) as { record: Record<string, unknown> };
  return body.record;
}

// ===========================================================================
// (a) 画面が宣言した並べ替え —— **`V4-M35` は1バイトも実装していない**
// ===========================================================================
//
// **`D-V4-124` の (a) の出典**(`docs/plan/v4/records/v4-m25.md` §9-2)は、**`V4-M28` の
// 実装より前に書かれたものである。** **今日測ると、その画面が出す読取要求は誰に対しても
// 400 になり、行が1件も返らない** —— **順序から大小関係を読む機会そのものが無い。**
//
// **したがって `V4-M35` は (a) について製品コードを1バイトも変えていない。**
// **代わりに、今日の状態(何が塞がっていて、何が塞がっていないか)を検査で固定する。**

test("(a) 画面の sort に宣言つき項目を書いたマニフェストは、今日どおり適用できる(1バイトも塞いでいない)", () => {
  // **宣言の側は `ADR-0120` 限定1 が「1バイトも触らない」と決めた場所である。**
  // **`V4-M35` もそこには触っていない** —— `beforeEach` の `applyManifest` が既に valid=true。
  const again = applyManifest(dataRoot, APP_ID, manifest());
  expect(again.valid).toBe(true);
});

// **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`。旧文を1バイトも消していない】**
//
// **旧テスト名**: 「(a) その画面が出す読取要求は、匿名・客・閲覧・編集・管理の5経路すべてで
// 400 になる(V4-M28 の副作用)」。
// **旧の期待値**: **`expect(statuses).toEqual([400, 400, 400, 400, 400]);`**
//
// **既定が閉じたので、手前の層(画面の規則)が匿名と客を先に止める** ——
// **画面 `catalog-list` を名指しした規則を持つのは既定3役割(`owner` / `editor` / `viewer`)
// だけであり、実アプリで `add_view` の自動付与が入れるのもその3役割だけである**
// (`anonymous` / `customer` には1本も入らない)。**したがって匿名と客は 403 で止まる。**
//
// **【誇張しない】漏れ口が塞がったのではない** —— **止め方が「並べ替えの 400」から
// 「画面の 403」へ変わっただけで、`?view=` を外せば 400 の経路は今日も同じである**
// (下の (c) の5経路の検査がそれを測っている)。
test("(a) その画面が出す読取要求は、匿名と客は 403・閲覧/編集/管理は 400 になる(V8-M26 で手前が閉じた)", async () => {
  // **表示層は `view.sort` を `?sort=` へ翻訳して投げる**(`web/src/api.ts` の `buildListQuery`)。
  // **サーバから見て「画面が出した要求」と「住所欄に手で書いた要求」は1バイトも違わない** ——
  // **これが `ADR-0120` 限定1 の第4列後半を満たせていない理由であり、`V4-M35` も越えられない。**
  const statuses: number[] = [];
  for (const auth of [
    undefined,
    cookie("customer"),
    cookie("viewer"),
    cookie("editor"),
    cookie("owner"),
  ]) {
    const res = await req(auth, "GET", `${PRODUCTS}?view=catalog-list&sort=cost&order=desc`);
    statuses.push(res.status);
  }
  expect(statuses).toEqual([403, 403, 400, 400, 400]);
});

// **【`V8-M21` / 台帳 `J-G24a` / ユーザ決定 `D-V8-21` による更新。旧文を1バイトも消していない】**
//
// **旧テスト名**: 「(a)【塞いでいない】画面の宣言そのものは、未ログインの get manifest に
// 今日も出る」。**旧の期待値**: `expect(res.status).toBe(200);` と、未ログインの応答本文の
// `catalog-list` の `sort` が `{ field: "cost", order: "desc" }` であること。
// **旧のコメント逐語**: 「`D-V4-91` が「今のままでよい」と決めた状態である。`V4-M35` は
// 1バイトも変えていない。」
//
// **`D-V8-21` が `D-V4-91` の「今のままでよい」を覆した** —— **未ログインには 401 である。**
// **【緩めていない】** **ログインすれば宣言はそのまま出る**(= 塞いだのは「未ログインに
// 出ること」だけであり、**画面の宣言から隠した項目のIDが読めるという穴そのものは
// 1ミリも塞いでいない**)。**両方を1本の検査で測る。**
test("(a)【未ログインには塞いだ。ログインには塞いでいない】画面の宣言そのものは、ログインすれば今日も出る", async () => {
  // **(1) 未ログインは 401**(`V8-M21` / `J-G24a`)。
  expect((await req(undefined, "GET", `/api/apps/${APP_ID}/manifest`)).status).toBe(401);
  // **(2) 客(customer)としてログインすれば、宣言はそのまま読める。**
  const res = await req(cookie("customer"), "GET", `/api/apps/${APP_ID}/manifest`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { app: { views: { id: string; sort?: unknown }[] } };
  const view = body.app.views.find((candidate) => candidate.id === "catalog-list");
  expect(view?.sort).toEqual({ field: "cost", order: "desc" });
});

// ===========================================================================
// (b) 作成・更新・バッチの応答に、宣言した項目の値がそのまま出る —— **塞ぐ**
// ===========================================================================
//
// **射影は読取と同じ1本(`projectForFieldAudience`)である**(`ADR-0061` 限定4 /
// `ADR-0071` 限定5: 判定は `owner-scope.ts` に集約する)。**したがって答えは相手によって
// 変わる** —— **これは `ADR-0120` 限定2(ロールを見ない)とは形が違う。**
// **違ってよい理由**: **`ADR-0120` が禁じたのは「同じ URL が相手によって 200 と 400 に
// 割れる」ことである。** **こちらは状態が常に 201 / 200 で、変わるのは本文の項目だけであり、
// 読取の応答が `ADR-0071` 以来ずっとそうしてきた形とまったく同じである。**

test("(b) editor の作成の応答から、editor に見せない項目が落ちる(読取の応答と一致する)", async () => {
  const created = await req(cookie("editor"), "POST", PRODUCTS, {
    name: "A",
    price: 100,
    cost: 777,
    sku: "SKU-A",
    margin: 23,
    [PUBLIC_FIELD]: true,
  });
  expect(created.status).toBe(201);
  const record = await recordOf(created);
  // **`cost` は owner にだけ見せる宣言なので、editor の応答からは落ちる。**
  expect(record.cost).toBeUndefined();
  expect(Object.keys(record)).not.toContain("cost");
  // **`sku` は editor にも見せる宣言なので、今日どおり出る**(既定を反転させていない)。
  expect(record.sku).toBe("SKU-A");
  // **宣言し忘れた項目は今日どおり出る。**
  expect(record.margin).toBe(23);
  // **同じ行を GET したときと、キーの集合が1つも違わない。**
  const read = await req(cookie("editor"), "GET", `${PRODUCTS}/${record._id as string}`);
  expect(Object.keys(await recordOf(read)).sort()).toEqual(Object.keys(record).sort());
});

test("(b) editor の更新の応答からも落ちる", async () => {
  const created = await req(cookie("owner"), "POST", PRODUCTS, {
    name: "A",
    cost: 777,
    sku: "SKU-A",
    [PUBLIC_FIELD]: true,
  });
  const seed = await recordOf(created);
  const patched = await req(
    cookie("editor"),
    "PATCH",
    `${PRODUCTS}/${seed._id as string}`,
    { name: "A2" },
    seed._updated_at as string,
  );
  expect(patched.status).toBe(200);
  const record = await recordOf(patched);
  expect(Object.keys(record)).not.toContain("cost");
  expect(record.sku).toBe("SKU-A");
  // **版(`_updated_at`)は落ちない** —— 落とすと If-Match の次の1手が組めなくなる。
  expect(typeof record._updated_at).toBe("string");
});

// ---------------------------------------------------------------------------
// (b) **隠した値が応答に出ていないことを、偶然の一致に左右されない形で見る**(`V4-M54`)
// ---------------------------------------------------------------------------
//
// **直す前の逐語**(`V4-M35` が書いた形。**下のバッチ3本がこの形を持っていた**):
//
// ```ts
// expect(JSON.stringify(body).includes("999")).toBe(false);   // (b) バッチの応答からも落ちる
// expect(JSON.stringify(body).includes("内部")).toBe(false);   //   同上
// const text = JSON.stringify(body);                          // (b)【限定5】3件・2表を跨ぐ
// expect(text.includes("111")).toBe(false);                   //   同上
// expect(text.includes("222")).toBe(false);                   //   同上
// expect(text.includes("内部")).toBe(false);                   //   同上
// expect(JSON.stringify(body).includes("333")).toBe(false);   // (b)【限定5】宣言0本の表を混ぜても
// ```
//
// **なぜ直したか**(`V4-M54` の実測。全量は `docs/plan/v4/records/v4-m54.md` §2):
// **この形は、隠した値と1バイトも関係のない理由で赤くなる。** **応答には値が機械で決まる列が
// 4本入っている** —— `_id`(`crypto.randomUUID()` の16進)/ `_created_at` / `_updated_at`
// (ISO8601。**ミリ秒3桁**)/ `st_owner`(利用者ID。乱数由来の文字列)。**そこに `999` /
// `111` / `222` / `333` がたまたま3文字並ぶと赤くなる。** **`_id` を
// `99900000-…` に固定すると、射影が正しく効いていても必ず赤くなることを実測した**(§2)。
// **素の50回では4回赤**(`999` 1回 / `111` 1回 / `333` 2回)。
//
// **守ろうとしている性質は1ミリも弱めない。** **3つに分けて、全部見る**:
//
// 1. **その項目IDが、応答のどこにもキーとして無い**(**入れ子を降りて走査する**)。
// 2. **その値が、応答のどこにも値として無い**(**`String()` で突き合わせる** —— 数値 `999`
//    でも文字列 `"999"` でも捕まえる)。
// 3. **値が機械で決まる4列だけを伏せた全文にも、部分文字列として現れない** ——
//    **元の形が持っていた「別のキーの文字列の中に埋まって出る」を捕まえる強さを、そのまま残す。**
//    **伏せてよい理由**: **4列の値はサーバが採番・打刻・スタンプするものであり、アプリが
//    書いた値を1バイトも運ばない**(`src/kernel/records.ts:892` の `crypto.randomUUID()` /
//    同 `:869` の ISO8601 / `st_owner` はサーバ層のスタンプ)。
//
// **`ADR-0134` 限定5 / `ADR-0135` の限定表は、この検査に「全文の部分一致で見よ」とは
// 1文字も書いていない**(突合は `v4-m54.md` §6)。**限定5 の第4列が求めているのは
// 「2表を跨ぐバッチで表ごとに正しく落ちること」と「表の配列の長さが `results` の長さと
// 一致すること」であり、どちらも下の検査がそのまま持っている。**

/** **値が機械で決まる列。** 伏せても、隠した値を運ぶ経路にならない(上のコメントの 3)。 */
const GENERATED_COLUMNS: readonly string[] = ["_id", "_created_at", "_updated_at", OWNER_FIELD];

/** 応答の中の全部のキーを、入れ子を降りて集める。 */
function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(allKeys);
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
      key,
      ...allKeys(child),
    ]);
  }
  return [];
}

/** 応答の中の全部の葉の値を、入れ子を降りて集める。 */
function allLeafValues(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value.flatMap(allLeafValues);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap(allLeafValues);
  }
  return [value];
}

/** 値が機械で決まる列だけを伏せた全文を返す。 */
function textWithoutGeneratedColumns(value: unknown): string {
  return JSON.stringify(value, (key, child: unknown) =>
    GENERATED_COLUMNS.includes(key) ? "<generated>" : child,
  );
}

/**
 * **隠した項目が、応答のどこにも現れていないこと。**
 *
 * **キーとして無い / 値として無い / 文字列に埋まっていない** の3つを**別々に**見る。
 */
function expectHiddenValueAbsent(body: unknown, fieldId: string, hidden: string | number): void {
  expect(allKeys(body)).not.toContain(fieldId);
  expect(allLeafValues(body).map((leaf) => String(leaf))).not.toContain(String(hidden));
  expect(textWithoutGeneratedColumns(body).includes(String(hidden))).toBe(false);
}

test("(b)【V4-M54】機械が決める列にたまたま同じ数字が並んでも、検査は赤くならない", () => {
  // **偶然の一致だけを起こした応答**(隠した値は1つも出ていない)。
  const coincidence = {
    records: [
      {
        _id: "99900000-0000-4000-8000-000000000000",
        _created_at: "2026-08-04T00:00:00.999Z",
        _updated_at: "2026-08-04T00:00:00.999Z",
        name: "Z",
        sku: "SKU-Z",
      },
      { _id: "3c7a247c-e153-47f5-abe6-7a44963b874d", nickname: "だれか", [OWNER_FIELD]: "x999y" },
    ],
  };
  // **直す前の形は、ここで赤になっていた**(`V4-M54` §2 の実測と同じ理由)。
  expect(JSON.stringify(coincidence).includes("999")).toBe(true);
  // **直した後の形は緑である。**
  expectHiddenValueAbsent(coincidence, "cost", 999);
});

test("(b)【V4-M54】本物の漏れは、直した後の形でも1件残らず赤になる(弱めていないことの実測)", () => {
  // (1) **そのキーのまま出た**(元の形が捕まえていたもの)。
  expect(() => expectHiddenValueAbsent({ records: [{ cost: 999 }] }, "cost", 999)).toThrow();
  // (2) **別のキーに値だけ出た**(型が変わっても捕まえる)。
  expect(() => expectHiddenValueAbsent({ records: [{ copied: "999" }] }, "cost", 999)).toThrow();
  // (3) **別のキーの文字列の中に埋まって出た**(元の形が持っていた強さを残していること)。
  expect(() =>
    expectHiddenValueAbsent({ records: [{ note: "原価は999円" }] }, "cost", 999),
  ).toThrow();
  // (4) **入れ子の奥にキーとして出た。**
  expect(() =>
    expectHiddenValueAbsent({ records: [{ nested: { deep: [{ cost: 1 }] } }] }, "cost", 999),
  ).toThrow();
  // (5) **文字列の値でも同じ**(`内部` の当たり先)。
  expect(() => expectHiddenValueAbsent({ records: [{ memo: "内部" }] }, "memo", "内部")).toThrow();
});

test("(b) バッチの応答からも落ちる(1リクエストで複数テーブルを跨いでも表ごとに判定する)", async () => {
  const res = await req(cookie("editor"), "POST", BATCH, {
    ops: [
      { op: "create", table: "product", values: { name: "Z", cost: 999, sku: "SKU-Z" } },
      { op: "create", table: "profile", values: { nickname: "だれか", rank: "VIP", memo: "内部" } },
    ],
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { records: Record<string, unknown>[] };
  expect(body.records).toHaveLength(2);
  // 1件目 = product。**`cost` は落ち、`sku` は残る。**
  expect(Object.keys(body.records[0] as object)).not.toContain("cost");
  expect((body.records[0] as Record<string, unknown>).sku).toBe("SKU-Z");
  // 2件目 = profile。**`rank` / `memo` はどちらも owner だけなので落ちる。**
  expect(Object.keys(body.records[1] as object)).not.toContain("rank");
  expect(Object.keys(body.records[1] as object)).not.toContain("memo");
  // **応答のどこにも値が現れない**(キーとしても・値としても・文字列に埋まっても)。
  // **直す前の逐語**: `expect(JSON.stringify(body).includes("999")).toBe(false);` /
  // `expect(JSON.stringify(body).includes("内部")).toBe(false);`(`V4-M54` が書き換えた。理由は上)。
  expectHiddenValueAbsent(body, "cost", 999);
  expectHiddenValueAbsent(body, "memo", "内部");
});

// ---------------------------------------------------------------------------
// (b) **バッチの表決めを fail-open にしない**(`ADR-0134` 限定5)
// ---------------------------------------------------------------------------
//
// **`ADR-0134` 限定5 の逐語**: 「**バッチは行ごとに表を決める。表が決まらなかった行を
// fail-open にしない** —— **`projectForFieldAudience(undefined, …)` は行をそのまま返す** ——
// **表の解決に失敗した行が黙って素通りしてはならない**」。**機械的検査(第4列)**: 「**2表を
// 跨ぐバッチで表ごとに正しく落ちること**、かつ **表の配列の長さが `results` の長さと一致する
// ことの検査**(**一致しなければ赤にする**)」。
//
// **審査記録 §5-4 の #1 が名指しした箇所である** —— `0d05b1b` は `writtenTables[index]` が
// `undefined` のとき行をそのまま返していた(fail-open)。**長さの一致も表の割り当ての順序も、
// 機械で1つも固定されていなかった。**
//
// **下の2本は、ズレたときに必ず赤になる形で書いてある** —— **表の配列が短ければ末尾の行が
// 素通りして隠した値が現れ、割り当てがズレれば別の表の宣言が当たって現れる。**

test("(b)【限定5】3件・2表を跨ぐバッチで、行ごとに正しい表の宣言が当たる(順序がズレたら赤)", async () => {
  const res = await req(cookie("editor"), "POST", BATCH, {
    ops: [
      { op: "create", table: "product", values: { name: "P1", cost: 111, sku: "SKU-1" } },
      { op: "create", table: "profile", values: { nickname: "だれか", rank: "VIP", memo: "内部" } },
      { op: "create", table: "product", values: { name: "P2", cost: 222, sku: "SKU-2" } },
    ],
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { records: Record<string, unknown>[] };
  // **表の配列の長さが `results` の長さと一致していなければ、末尾の行が素通りして
  // `cost: 222` が現れる** —— 下の全文検査がそれを赤にする。
  expect(body.records).toHaveLength(3);
  // **【`V17-M3` / `AC-G16` による反転。旧の1行を1バイトも消していない】**
  //
  // **旧(逐語)**:
  //
  //     expect(body.records.map((row) => row.name ?? row.nickname)).toEqual(["P1", "だれか", "P2"]);
  //
  // **`editor` の面は `profile` に `write` しか書いていない**(この fixture の `ROLES`)——
  // **したがって `editor` はこの表の行を1件も読めない。** **すぐ下で実測する。**
  // **`AC-G16` は「書けるが読めない」相手の書込の応答から業務の列を全部落とすので、
  // `nickname` はもう現れない。**
  //
  // **並びの検出は1ミリも弱まっていない** —— **表の割り当てがズレて中央の行に `product` の
  // 宣言が当たっていたら、その行は「読める」と判定されて `nickname` が残り、
  // 予約規約フィールドだけの比較が赤になる。**
  expect(body.records.map((row) => row.name)).toEqual(["P1", undefined, "P2"]);
  expect(Object.keys(body.records[1] as object).sort()).toEqual([
    "_created_at",
    "_id",
    "_updated_at",
  ]);
  // **実測(反転の前提)** —— **`editor` はこの表を1行も読めない。**
  const editorProfiles = await req(cookie("editor"), "GET", PROFILES);
  expect(editorProfiles.status).toBe(200);
  expect(((await editorProfiles.json()) as { records: unknown[] }).records).toHaveLength(0);
  // 0件目・2件目 = product。**`cost` は落ち、`sku`(editor に見せる)は残る。**
  for (const index of [0, 2]) {
    const row = body.records[index] as Record<string, unknown>;
    expect(Object.keys(row)).not.toContain("cost");
    expect(typeof row.sku).toBe("string");
  }
  // 1件目 = profile。**`rank` / `memo` は owner だけなので落ちる。**
  // **もし product の宣言が当たっていたら `rank` / `memo` は落ちない**(product は
  // その2つを1つも宣言していない)—— **割り当てがズレたら赤になる。**
  const middle = body.records[1] as Record<string, unknown>;
  expect(Object.keys(middle)).not.toContain("rank");
  expect(Object.keys(middle)).not.toContain("memo");
  // **応答のどこにも、落とした値が現れない**(**素通りの検出**。表の配列が短ければ末尾の
  // `P2` の `cost: 222` がここで捕まる)。
  // **直す前の逐語**: `const text = JSON.stringify(body);` /
  // `expect(text.includes("111")).toBe(false);` / `expect(text.includes("222")).toBe(false);` /
  // `expect(text.includes("内部")).toBe(false);`(`V4-M54` が書き換えた。理由は上)。
  expectHiddenValueAbsent(body, "cost", 111);
  expectHiddenValueAbsent(body, "cost", 222);
  expectHiddenValueAbsent(body, "memo", "内部");
});

test("(b)【限定5】宣言0本の表を混ぜても、応答の本数と並びが ops と1件ずつ対応する", async () => {
  const res = await req(cookie("editor"), "POST", BATCH, {
    ops: [
      { op: "create", table: "note", values: { title: "N1", body: "本文1" } },
      { op: "create", table: "product", values: { name: "P3", cost: 333 } },
      { op: "create", table: "note", values: { title: "N2", body: "本文2" } },
    ],
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { records: Record<string, unknown>[] };
  expect(body.records).toHaveLength(3);
  expect(body.records.map((row) => row.title ?? row.name)).toEqual(["N1", "P3", "N2"]);
  // **宣言0本の表は1ミリも変わらない**(`ADR-0134` 限定9)。
  expect((body.records[0] as Record<string, unknown>).body).toBe("本文1");
  expect((body.records[2] as Record<string, unknown>).body).toBe("本文2");
  // **宣言のある表だけが落ちる。**
  expect(Object.keys(body.records[1] as object)).not.toContain("cost");
  // **直す前の逐語**: `expect(JSON.stringify(body).includes("333")).toBe(false);`
  // (`V4-M54` が書き換えた。理由は上)。
  expectHiddenValueAbsent(body, "cost", 333);
});

test("(b) owner の応答は1ミリも変わらない —— 見せる相手に入っている項目は今日どおり出る", async () => {
  const created = await req(cookie("owner"), "POST", PRODUCTS, {
    name: "A",
    cost: 777,
    sku: "SKU-A",
    [PUBLIC_FIELD]: true,
  });
  expect(created.status).toBe(201);
  const record = await recordOf(created);
  expect(record.cost).toBe(777);
  expect(record.sku).toBe("SKU-A");
});

test("(b) 客が自分の行を作る・直すときの応答からも落ちる", async () => {
  const created = await req(cookie("customer"), "POST", PROFILES, {
    nickname: "きゃく",
    rank: "VIP",
    memo: "内部メモ",
    // **【`V8-M20` / `J-G30`】旧: `[ADMIN_READABLE_FIELD]: true,`(運営可視の宣言)。**
    // **予約規約フィールドが廃止されたので、行ごとに立てる値は1つも要らない** ——
    // **運営が読めるかは面の規則(表 × 読取)だけで決まる。**
  });
  expect(created.status).toBe(201);
  const record = await recordOf(created);
  expect(Object.keys(record)).not.toContain("rank");
  expect(Object.keys(record)).not.toContain("memo");
  const patched = await req(
    cookie("customer"),
    "PATCH",
    `${PROFILES}/${record._id as string}`,
    { nickname: "きゃく2" },
    record._updated_at as string,
  );
  expect(patched.status).toBe(200);
  expect(Object.keys(await recordOf(patched))).not.toContain("rank");
});

// ===========================================================================
// (c) 400 の `allowed_values` に、宣言した項目のIDが並ぶ —— **塞ぐ**
// ===========================================================================
//
// **こちらは `ADR-0120` 限定2 と同じ形が取れる** —— **`allowed_values` は今日も相手に
// よらず同じ内容を返しているので、落とす側も一律にできる。** **owner でも並ばない。**

test("(c) 実在しない項目での並べ替えの 400 に、宣言つき項目のIDが1つも並ばない(5経路すべて)", async () => {
  for (const auth of [
    undefined,
    cookie("customer"),
    cookie("viewer"),
    cookie("editor"),
    cookie("owner"),
  ]) {
    const res = await req(auth, "GET", `${PRODUCTS}?sort=no_such_field&order=asc`);
    expect(res.status).toBe(400);
    const allowed = await allowedValuesOf(res);
    expect(allowed).not.toContain("cost");
    expect(allowed).not.toContain("sku");
    // **宣言していない項目とシステム列は今日どおり並ぶ**(既定を1ミリも変えない)。
    expect(allowed).toContain("name");
    expect(allowed).toContain("margin");
    expect(allowed).toContain("_created_at");
  }
});

test("(c) 実在しない項目での絞り込みの 400 にも並ばない", async () => {
  const res = await req(cookie("customer"), "GET", `${PRODUCTS}?filter.no_such_field=1`);
  expect(res.status).toBe(400);
  const allowed = await allowedValuesOf(res);
  expect(allowed).not.toContain("cost");
  expect(allowed).not.toContain("sku");
  expect(allowed).toContain("name");
});

test("(c) 実在しない列の合計を求めた 400 にも並ばない", async () => {
  const res = await req(cookie("customer"), "GET", `${PRODUCTS}?sum=no_such_field`);
  expect(res.status).toBe(400);
  const allowed = await allowedValuesOf(res);
  // **`cost` は number なので、塞ぐ前はここに並んでいた。**
  expect(allowed).not.toContain("cost");
  expect(allowed).toContain("price");
  expect(allowed).toContain("margin");
});

/**
 * **【反転した検査。`ADR-0135` 限定1 による】**
 *
 * **反転前の逐語**(`0d05b1b` で緑だったもの。**1バイトも書き換えずに残す**):
 *
 * ```
 * test("(c) 実在しない項目に書き込もうとした 400 にも並ばない", async () => {
 *   const res = await req(cookie("editor"), "POST", PRODUCTS, { name: "A", no_such_field: 1 });
 *   expect(res.status).toBe(400);
 *   const allowed = await allowedValuesOf(res);
 *   expect(allowed).not.toContain("cost");
 *   expect(allowed).not.toContain("sku");
 *   expect(allowed).toContain("name");
 * });
 * ```
 *
 * **なぜ反転したか**: **`V4-M35` 門A 本審査 単位B(= `ADR-0135`。判定 = 限定採用)が、
 * 落としてよい経路を「読取の要求のデコードで出た 400」だけに狭めた。** **`ADR-0135` 限定1
 * の逐語**: 「**書込(`POST` / `PATCH` / `POST /batch`)の 400 / 409 には1バイトも掛けない。**
 * **理由 = その項目は今日も書けるので、落とすと一覧が事実と食い違う**(憲法6 /
 * `ADR-0086` 限定4 の原理)」。**`0d05b1b` はこの経路にも落としており、限定表の外だった**
 * (審査記録 `v4-m35-gate-a.md` §5-4 の #3 / #6)。
 */
test("(c)【反転】実在しない項目に書き込もうとした 400 には、宣言つき項目のIDが今日どおり並ぶ", async () => {
  const res = await req(cookie("editor"), "POST", PRODUCTS, { name: "A", no_such_field: 1 });
  expect(res.status).toBe(400);
  const allowed = await allowedValuesOf(res);
  // **その項目は今日も書ける**(単位C は保留)。**書けるものを「使える項目」の一覧から
  // 消すと、一覧が嘘になる**(`ADR-0135` §2 の表)。
  expect(allowed).toContain("cost");
  expect(allowed).toContain("sku");
  expect(allowed).toContain("name");
});

/**
 * **【反転した検査。`ADR-0135` 限定1 による】**
 *
 * **反転前の逐語**(`0d05b1b` で緑だったもの。**1バイトも書き換えずに残す**):
 *
 * ```
 * test("(c) バッチの 400 にも並ばない", async () => {
 *   const res = await req(cookie("editor"), "POST", BATCH, {
 *     ops: [{ op: "create", table: "product", values: { name: "A", no_such_field: 1 } }],
 *   });
 *   expect(res.status).toBe(400);
 *   const allowed = await allowedValuesOf(res);
 *   expect(allowed).not.toContain("cost");
 *   expect(allowed).not.toContain("sku");
 * });
 * ```
 *
 * **なぜ反転したか**: 上と同じ(`ADR-0135` 限定1)。**審査記録 §5-4 の #5 / #7。**
 * **あわせて、バッチの 400 で表を引き直していた13行のインラインの式も取り消した。**
 */
test("(c)【反転】バッチの 400 にも今日どおり並ぶ", async () => {
  const res = await req(cookie("editor"), "POST", BATCH, {
    ops: [{ op: "create", table: "product", values: { name: "A", no_such_field: 1 } }],
  });
  expect(res.status).toBe(400);
  const allowed = await allowedValuesOf(res);
  expect(allowed).toContain("cost");
  expect(allowed).toContain("sku");
});

test("(c)【限定1】更新(PATCH)の 400 の allowed_values にも今日どおり並ぶ", async () => {
  const created = await req(cookie("editor"), "POST", PRODUCTS, { name: "A" });
  expect(created.status).toBe(201);
  const record = await recordOf(created);
  const res = await req(
    cookie("editor"),
    "PATCH",
    `${PRODUCTS}/${record._id as string}`,
    { no_such_field: 1 },
    record._updated_at as string,
  );
  expect(res.status).toBe(400);
  const allowed = await allowedValuesOf(res);
  expect(allowed).toContain("cost");
  expect(allowed).toContain("sku");
});

test("(c) 選択肢(select)の 400 は1バイトも変わらない —— フィールドIDの列挙にだけ当てる", async () => {
  // **`allowed_values` はフィールドIDの列挙にだけ使われているわけではない。**
  // **選択肢の列挙・ロールの列挙・true/false の列挙に誤爆させない**(黙って結果を変えない。憲法6)。
  const res = await req(cookie("editor"), "POST", PRODUCTS, { name: "A", grade: "こわれた" });
  expect(res.status).toBe(400);
  expect(await allowedValuesOf(res)).toEqual(["新品", "良好", "要修理"]);
});

// ---------------------------------------------------------------------------
// (c) **誤爆を塞いでいないことを、見えるようにする**(`ADR-0135` 限定4 (ii))
// ---------------------------------------------------------------------------
//
// **`ADR-0135` 限定4 (ii) の逐語**: 「**選択肢が全部フィールドIDと一致する `select` を持つ
// 表で、誤爆が起きることを固定する検査**(**塞いでいないことを可視化する**。`ADR-0071`
// 限定8 と同じ作法)」。
//
// **`scrubHiddenFieldIds` は「要素の全部がそのテーブルのフィールドIDか `_` 始まり」である
// ときだけ当てる。** **したがって、選択肢の綴りが全部フィールドIDと一致する `select` には
// 誤爆する** —— **塞いでいない。** **塞ぐには `SYSTEM_COLUMN_NAMES` を値 import するか、
// エラーの種別を渡す必要があり、どちらも別の門を伴う**(`ADR-0135` §6 / §8 の 5)。
//
// **【この2本が述語を直接呼ぶ理由。正直に書く】** **`ADR-0135` 限定1 が書込の 400 から
// 落とすのをやめさせたので、今日の HTTP で `select` の選択肢が `allowed_values` に載る
// 400(= 書込の 400)には、そもそも述語が1度も当たらない。** **読取の要求のデコードで出る
// 400 で `select` の選択肢が `allowed_values` に載る経路を1本も見つけられなかった。**
// **したがって「今日の HTTP で誤爆が起きる」とは書けない** —— **述語に誤爆が残っている
// ことだけを、`ADR-0135` §6 と同じ方法(述語を直接呼ぶ)で固定する。**

test("(c)【塞いでいない】選択肢の綴りが全部フィールドIDと一致する select には、述語が誤爆する", () => {
  // **【`V8-M20` / `T02`】`scrubHiddenFieldIds` は引数が2本から3本になった** ——
  // **隠す側の宣言が項目(`field.audience`)から面(マニフェスト全体の `app.roles`)へ
  // 移ったので、マニフェストを渡さないと「名指しされているか」を判定できない。**
  const product = manifest().app.tables[0] as unknown as Parameters<typeof scrubHiddenFieldIds>[1];
  const scrubbed = scrubHiddenFieldIds(manifest(), product, [
    {
      path: "/values/grade",
      message: "選べる値ではありません",
      allowed_values: ["name", "price", "cost"],
    },
  ]);
  // **`cost` は `select` の選択肢であって項目IDではないのに消える**(`ADR-0135` §6 の 1)。
  expect(scrubbed[0]?.allowed_values).toEqual(["name", "price"]);
});

test("(c) 綴りが1つでもフィールドIDから外れると、述語は1バイトも触らない(誤爆の境目)", () => {
  // **【`V8-M20` / `T02`】`scrubHiddenFieldIds` は引数が2本から3本になった** ——
  // **隠す側の宣言が項目(`field.audience`)から面(マニフェスト全体の `app.roles`)へ
  // 移ったので、マニフェストを渡さないと「名指しされているか」を判定できない。**
  const product = manifest().app.tables[0] as unknown as Parameters<typeof scrubHiddenFieldIds>[1];
  const scrubbed = scrubHiddenFieldIds(manifest(), product, [
    {
      path: "/values/grade",
      message: "選べる値ではありません",
      allowed_values: ["新品", "price", "cost"],
    },
  ]);
  // **守る側の実測**(`ADR-0135` §6 の 2)。
  expect(scrubbed[0]?.allowed_values).toEqual(["新品", "price", "cost"]);
});

// **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`。旧文を1バイトも消していない】**
//
// **旧テスト名**: 「(c) 役割の 400(閲覧のみ)の allowed_values も1バイトも変わらない」。
// **旧の期待値**: **`expect(await allowedValuesOf(res)).toEqual(["editor", "owner"]);`**
//
// **既定が閉じた結果、表 `product` にも面の規則が要るようになった** —— **規則が1本でも
// 立った表では、面(`judgeRoleAccess`)が固定ロールの層(`forbiddenWriteError`)より
// **手前**で止める。** **面の 403(`forbiddenRoleAccessError`)は `allowed_values` を
// 1本も持たない**ので、着手前に並んでいた `["editor", "owner"]` は空になる。
//
// **【この検査の主題は変わっていない】** —— **測っているのは「403 の本文に、隠した項目の
// IDが1つも並ばないこと」**であり、**空配列はそれを今日も満たしている。**
test("(c) 役割の 403(閲覧のみ)の allowed_values は空になった(面が固定ロールより手前で止める)", async () => {
  const res = await req(cookie("viewer"), "POST", PRODUCTS, { name: "A" });
  expect(res.status).toBe(403);
  expect(await allowedValuesOf(res)).toEqual([]);
});

test("(c) 別のテーブルでも同じ判定になる(profile の rank / memo も落ちる)", async () => {
  const res = await req(cookie("owner"), "GET", `${PROFILES}?sort=no_such_field&order=asc`);
  expect(res.status).toBe(400);
  const allowed = await allowedValuesOf(res);
  expect(allowed).toContain("nickname");
  expect(allowed).toContain(OWNER_FIELD);
  expect(allowed).not.toContain("rank");
  expect(allowed).not.toContain("memo");
});

test("(c)【既定は1ミリも変わらない】宣言を1本も書いていないテーブルの 400 は着手前と同じである", async () => {
  const res = await req(cookie("owner"), "GET", `${NOTES}?sort=no_such_field&order=asc`);
  expect(res.status).toBe(400);
  expect(await allowedValuesOf(res)).toEqual([
    "title",
    "body",
    "_id",
    "_created_at",
    "_updated_at",
  ]);
});

test("(c) 400 の本文に、宣言つき項目のIDが1バイトも現れない(message / hint も含めて)", async () => {
  const res = await req(cookie("customer"), "GET", `${PRODUCTS}?sort=no_such_field&order=asc`);
  expect(res.status).toBe(400);
  const text = await res.text();
  expect(text.includes("cost")).toBe(false);
  expect(text.includes("sku")).toBe(false);
});

// ===========================================================================
// (d) お客様が更新で宣言した項目に書き込める —— **今日のまま。穴として固定する**
// ===========================================================================
//
// **`D-V4-124` 逐語**: 「**(d)お客様が更新で書き込める、は今日のまま。**」
// 「**(d) が残るので、原価や内部区分をお客様側から書き換えられる状態は今日も続く。**」
//
// **この検査は防いでいない。** **開いていることを見えるようにしているだけである** ——
// **塞いだら赤くなる**(そのときは `ADR-0071` §3a の 3 が要求する門A を通してから反転すること)。

test("(d)【今日のまま】客は、自分に見えない項目に更新で書き込める", async () => {
  const created = await req(cookie("customer"), "POST", PROFILES, {
    nickname: "きゃく",
    // **【`V8-M20` / `J-G30`】旧: `[ADMIN_READABLE_FIELD]: true,`。**
  });
  expect(created.status).toBe(201);
  const record = await recordOf(created);
  const id = record._id as string;

  // **客は `rank` / `memo` を1バイトも読めない**((b) の実装後は書込の応答からも落ちる)。
  const readBack = await req(cookie("customer"), "GET", `${PROFILES}/${id}`);
  expect(Object.keys(await recordOf(readBack))).not.toContain("rank");

  // **それでも書ける。****403 にならない。**
  const patched = await req(
    cookie("customer"),
    "PATCH",
    `${PROFILES}/${id}`,
    { rank: "PLATINUM", memo: "客が書き換えた" },
    record._updated_at as string,
  );
  expect(patched.status).toBe(200);

  // **本当に入っている** —— 応答から落ちているだけで、書込は成立している。
  // **見えるのは owner だけである。**
  const ownerView = await req(cookie("owner"), "GET", `${PROFILES}?sort=_created_at&order=asc`);
  expect(ownerView.status).toBe(200);
  const rows = ((await ownerView.json()) as { records: Record<string, unknown>[] }).records;
  const row = rows.find((candidate) => candidate._id === id);
  expect(row?.rank).toBe("PLATINUM");
  expect(row?.memo).toBe("客が書き換えた");
});

test("(d)【今日のまま】客は、作成のときにも宣言つき項目へ値を入れられる", async () => {
  const created = await req(cookie("customer"), "POST", PROFILES, {
    nickname: "きゃく2",
    rank: "GOLD",
    // **【`V8-M20` / `J-G30`】旧: `[ADMIN_READABLE_FIELD]: true,`。**
  });
  expect(created.status).toBe(201);
  const id = (await recordOf(created))._id as string;
  const ownerView = await req(cookie("owner"), "GET", `${PROFILES}?sort=_created_at&order=asc`);
  const rows = ((await ownerView.json()) as { records: Record<string, unknown>[] }).records;
  expect(rows.find((candidate) => candidate._id === id)?.rank).toBe("GOLD");
});
