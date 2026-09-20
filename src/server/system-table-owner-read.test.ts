/**
 * **`D-V8-74` —— システムが持つ表(`_apps` / `_changelog` / `_ai_usage`)を、
 * 持ち主(`owner`)にだけ見せる。**
 *
 * ## この検査が立った経緯(**丸めない**)
 *
 * **`V8-M27-T04`(台帳 `T-G5`)が「運営(予約3ロール)か否か」で表単位の可否を決めていた
 * 層(`nonAdminTableAccess` / `hasAdminWriteRole`)を撤去した。** **その直後、購入者などの
 * 一般の利用者がシステムが持つ表3本を読めるようになった**(実測。`auth-boundary.test.ts` の
 * 「`customer` もシステムテーブルを読める」がその実測である)。
 *
 * **この3本は先行のユーザ決定 `D-V8-69`(見出しの逐語「システムの表は権限の外に置く」)に
 * より**面(役割の規則)の管轄外**に置かれており、`judgeRoleAccess` は1度も判定しない。**
 * **旧い層が偶然その3本も塞いでいた。**
 *
 * **【禁止の履行】これを「実装の不具合」と書かない** —— **撤去は依頼どおりに行われ、
 * `D-V8-69` も依頼どおりに履行されている。** **2つの決定が交差したところに穴が開いた。**
 * **【禁止の履行】逆に「決定の不備」とも書かない** —— **`D-V8-69` を決めた時点で層はまだ
 * 生きており、この交差は見えていなかった。**
 *
 * ## ユーザ決定 `D-V8-74`(2026-08-11)
 *
 * - **選ばれた見出しの逐語**: **「持ち主にだけ見せる」。**
 * - **選ばれた説明文の逐語**:
 *   > **もっと狭くして、持ち主にだけ見せます。変更履歴を追えるのが持ち主1人だけになりますが、
 *   > 定義を変えられるのも今日持ち主だけなので、見る人と変える人が揃います。**
 * - **選ばれなかった見出し2つ**: **「運営の人にだけ見せる」/「今のまま(ログインして
 *   いれば誰でも)」**(**説明文の逐語は本ファイルが持たない**)。
 *
 * ## **`D-V8-69` の説明文と食い違う点。黙って合わせない**
 *
 * **`D-V8-69` の説明文の逐語は「変更履歴やアプリ一覧は**今までどおり**見えます」であった。**
 * **その「今までどおり」は**運営3ロールに見えること**を指していた**(旧い層が
 * `isReservedRole` で分けていたため)。**本決定 `D-V8-74` はそれより**狭い**(持ち主だけ)。**
 * **【禁止の履行】どちらかを「誤り」と書かない。両方を残す。**
 *
 * ## この検査が固定していないこと(**誇張しない**)
 *
 * - **アプリの表(`manifest.app.tables`)には1バイトも掛からない。** **(e) がそれを実測で
 *   固定する** —— **規則の無い表は今日も「200 + 0件」/ 単件 404 であって、403 ではない。**
 * - **書込は1バイトも変えていない** —— **今日どおりカーネルの読み取り専用エラー(400)である。**
 *   **`owner` が叩いても非 `owner` が叩いても 400 である**((d))。
 * - **未認証は1バイトも変えていない** —— **今日どおり 401**((c))。
 * - **`D-V8-69` の免除そのもの(`judgeRoleAccess` がシステムの表を判定しない)は1バイトも
 *   触っていない。** **本決定は面の**外側**に1本置いただけである。**
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Role } from "../auth/types.ts";
import {
  applyDiff,
  applyManifest,
  createApp,
  KernelMetaStore,
  type Manifest,
} from "../kernel/index.ts";
import { SYSTEM_TABLE_IDS } from "../shared/system-tables.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN } from "./test-helpers.ts";

const APP_ID = "sys-owner-read";

/**
 * 題材のマニフェスト。
 *
 * - **`ledger`** … **旧の「運営テーブル」そのもの**(`st_owner` も `st_public` も持たない)。
 *   **`customer` に読取を1本書く** —— **(e) が「アプリの表には新しい判定が1バイトも
 *   掛かっていない」ことを測る土台。**
 * - **`vault`** … **どの役割も名指ししていない。** **面が閉じている側を測る土台。**
 *
 * **システムが持つ表の綴りは1文字も書かない** —— **`SYSTEM_TABLE_IDS` から機械的に採る。**
 */
function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "システムの表を持ち主だけに見せる店",
      // **【`V8-M29` 第2波】旧(逐語)**: `user_kinds: [{ id: "customer", name: "一般利用者" }],`
      // **語彙 `app.user_kinds` は廃止された** —— **代わりに立つのは `app.roles` であり、
      // `customer` は下の `roles` に既に1本立っている**(置き換え先はそこである)。
      tables: [
        {
          id: "ledger",
          name: "台帳",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
        },
        {
          id: "vault",
          name: "金庫",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
        },
      ],
      views: [],
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(類型17 の拡張)。
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            { target: "table", table: "ledger", can: ["read", "write", "delete"] },
          ],
        },
        {
          id: "editor",
          name: "編集者",
          rules: [{ target: "table", table: "ledger", can: ["read", "write"] }],
        },
        {
          id: "viewer",
          name: "閲覧者",
          rules: [{ target: "table", table: "ledger", can: ["read"] }],
        },
        {
          id: "customer",
          name: "一般利用者",
          // **旧: `nonAdminTableAccess("ledger") === "denied"` で必ず 403 だった枠。**
          rules: [{ target: "table", table: "ledger", can: ["read", "write"] }],
        },
      ],
    },
  } as unknown as Manifest;
}

let dataRoot: string | undefined;
let app: ReturnType<typeof createServerApp>;

async function boot(): Promise<void> {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-sys-owner-read-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "システムの表を持ち主だけに見せる店", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, manifest()).valid).toBe(true);
  // **`_changelog` に `apply` の行を1件作る**(`applyManifest` 経由の投入は記録されない)。
  // **こうしないと「持ち主には見える」が空配列でも通ってしまう。**
  const applied = applyDiff(dataRoot, APP_ID, {
    diff_id: "memo-field",
    intent: "台帳に覚え書きを足す",
    operations: [
      { op: "add_field", table: "ledger", field: { id: "memo", name: "覚え書き", type: "text" } },
    ],
  });
  expect(applied.valid).toBe(true);
  app = createServerApp({ dataRoot });
}

afterEach(async () => {
  if (dataRoot !== undefined) {
    await rm(dataRoot, { recursive: true, force: true });
    dataRoot = undefined;
  }
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

const records = (table: string) => `/api/apps/${APP_ID}/tables/${table}/records`;

/**
 * **役割の綴りは `Role`(`ReservedRole | (string & {})`)なので、宣言された種類
 * (`customer`)もそのまま渡せる**(キャストを1つも書かない)。
 * **`grants` は付与表(`_auth_user_roles`)へ入る2本目以降**(`V8-M16` / `J-G3`)。
 */
function session(role: Role, grants?: readonly Role[]) {
  const username = `${role}-${Math.random().toString(36).slice(2, 10)}`;
  // **`exactOptionalPropertyTypes` が効いているので、`grants` は在るときだけ載せる**
  // (`undefined` を明示的に渡すと型が合わない)。
  return grants === undefined
    ? seedSession(dataRoot as string, APP_ID, { role, username })
    : seedSession(dataRoot as string, APP_ID, { role, username, grants });
}

/** **綴りを書き写さないための歯止め。** システムの表が4本目になった日にここが赤くなる。 */
test("題材はシステムの表の綴りを1文字も書き写していない(SYSTEM_TABLE_IDS から機械的に採る)", () => {
  expect(SYSTEM_TABLE_IDS.length).toBeGreaterThan(0);
  for (const id of SYSTEM_TABLE_IDS) {
    expect(id.startsWith("_")).toBe(true);
  }
});

// =====================================================================================
// (a) `owner` はシステムの表を読める(**中身が空でないことまで測る**)
// =====================================================================================

test("(a) owner はシステムが持つ表を読める(一覧・単件とも 200)", async () => {
  await boot();
  const owner = session("owner");
  for (const id of SYSTEM_TABLE_IDS) {
    const list = await req(owner.cookie, "GET", records(id));
    expect(list.status, `list ${id}`).toBe(200);
    expect(Array.isArray(((await list.json()) as { records: unknown[] }).records), id).toBe(true);
  }
  // **中身が本当に返ること**(空配列でも 200 になってしまうので、行のある2本で確かめる)。
  const apps = (await (await req(owner.cookie, "GET", records("_apps"))).json()) as {
    records: { app_id?: string; _id?: string }[];
  };
  expect(apps.records.map((row) => row.app_id)).toContain(APP_ID);
  const changelog = (await (await req(owner.cookie, "GET", records("_changelog"))).json()) as {
    records: { intent?: string; _id?: string }[];
  };
  expect(changelog.records.map((row) => row.intent)).toContain("台帳に覚え書きを足す");
  // **単件も 200 で引ける**(`_apps` の `_id` は `app_id`)。
  expect((await req(owner.cookie, "GET", `${records("_apps")}/${APP_ID}`)).status).toBe(200);
});

test("(a-2) 付与表(_auth_user_roles)で owner を足した相手も読める(実効ロール集合)", async () => {
  await boot();
  // **列の1値は `customer`。付与表に `owner` を1本足す** —— **和集合1本で判定する(`J-G3`)。**
  const granted = session("customer", ["owner"]);
  for (const id of SYSTEM_TABLE_IDS) {
    expect((await req(granted.cookie, "GET", records(id))).status, id).toBe(200);
  }
});

// =====================================================================================
// (b) `editor` / `viewer` / 宣言された種類の利用者は読めない(**403**)
// =====================================================================================

/**
 * **なぜ 403 で、`ADR-0305` 限定11 の作法(一覧は応答から落とし単件は 404)ではないのか。**
 *
 * **限定11 が伏せているのは「その表が在ること」である** —— **アプリの表の識別子は
 * アプリの作者が付けた名前であり、それ自体が伏せたい情報になりうる**(`admin_payouts`
 * のような名前は、在ることを知られるだけで内部の作りを教えてしまう)。
 *
 * **システムが持つ表は違う。** **`_apps` / `_changelog` / `_ai_usage` はプラットフォームの
 * 定数であり、在ることが製品の仕様として公開されている** —— **`src/shared/system-tables.ts`
 * はフロントエンドが**値として import** しており(`web/src/table-resolution.ts` の再 export)、
 * 画面の実装(`DetailViewRenderer` の `isSystemTableId`)も MCP の語彙も名前を知っている。**
 * **したがって隠しても何も守れず、「なぜ見えないのか」を告げる文面だけが失われる。**
 *
 * **そこで 403 を返し、理由(持ち主だけが読める)を文面で告げる。**
 */
test("(b) editor / viewer / 宣言された種類の利用者は、システムが持つ表を読めない(403)", async () => {
  await boot();
  for (const role of ["editor", "viewer", "customer"]) {
    const who = session(role);
    for (const id of SYSTEM_TABLE_IDS) {
      const list = await req(who.cookie, "GET", records(id));
      expect(list.status, `list ${role} ${id}`).toBe(403);
      const body = (await list.json()) as { errors: { message?: string; hint?: string }[] };
      // **統一形式(`ADR-0003` §3)である。**
      expect(Array.isArray(body.errors), `${role} ${id}`).toBe(true);
      // **「その表が在ること」は隠していない** —— **表のIDを文面に出す。**
      expect(body.errors[0]?.message, `${role} ${id}`).toContain(id);
      // **直し方を告げる**(役割の規則では開かないことまで書く)。
      expect(body.errors[0]?.hint, `${role} ${id}`).toBeTruthy();
      // **単件も同じ 403 である**(404 で伏せない。上の doc)。
      const single = await req(who.cookie, "GET", `${records(id)}/${APP_ID}`);
      expect(single.status, `single ${role} ${id}`).toBe(403);
    }
  }
});

// =====================================================================================
// (c) 未ログインは今日どおり 401(**1バイトも変えていない**)
// =====================================================================================

test("(c) 未ログインは今日どおり 401(403 に化けない)", async () => {
  await boot();
  for (const id of SYSTEM_TABLE_IDS) {
    expect((await req(undefined, "GET", records(id))).status, `list ${id}`).toBe(401);
    expect((await req(undefined, "GET", `${records(id)}/${APP_ID}`)).status, `single ${id}`).toBe(
      401,
    );
  }
});

// =====================================================================================
// (d) 書込は今日どおり 400「読み取り専用」(**403 にしない**)
// =====================================================================================

test("(d) 書込は今日どおり 400(読み取り専用)。owner でも非 owner でも 400 である", async () => {
  await boot();
  for (const role of ["owner", "editor", "viewer", "customer"]) {
    const who = session(role);
    for (const id of SYSTEM_TABLE_IDS) {
      const post = await req(who.cookie, "POST", records(id), { app_id: "x" });
      expect(post.status, `POST ${role} ${id}`).toBe(400);
      const body = (await post.json()) as { errors: { message?: string }[] };
      expect(body.errors[0]?.message, `POST ${role} ${id}`).toContain("読み取り専用");
    }
  }
});

// =====================================================================================
// (e) **「運営か否か」の層を復活させていない** —— アプリの表には1バイトも掛からない
// =====================================================================================

/**
 * **これが `D-V8-74` の実装が越えてはならない線である。**
 *
 * **新しい判定は `isSystemTableId(tableId)` が真のときにしか評価されない。**
 * **したがってアプリの表の可否は、撤去した直後(`8c380ab`)と1バイトも変わらない**:
 *
 *  1. **旧「運営テーブル」(`st_owner` も `st_public` も持たない `ledger`)は、
 *     非運営の役割に読取の規則を1本書けば読める** —— **旧い層なら必ず 403 だった。**
 *  2. **規則を1本も書いていない表(`vault`)は 403 ではなく「200 + 0件」/ 単件 404** ——
 *     **`ADR-0305` 限定11 の作法のままである。** **`owner` にも同じく見えない。**
 */
test("(e) アプリの表には新しい判定が1バイトも掛かっていない(層を復活させていない)", async () => {
  await boot();
  const owner = session("owner");
  const created = await req(owner.cookie, "POST", records("ledger"), { title: "台帳1" });
  expect(created.status).toBe(201);
  const ledgerId = ((await created.json()) as { record: { _id: string } }).record._id;

  // (e-1) **旧「運営テーブル」を非運営の役割が読める**(旧い層なら 403)。
  const customer = session("customer");
  const list = await req(customer.cookie, "GET", records("ledger"));
  expect(list.status).toBe(200);
  expect(((await list.json()) as { records: { _id: string }[] }).records.map((r) => r._id)).toEqual(
    [ledgerId],
  );
  expect((await req(customer.cookie, "GET", `${records("ledger")}/${ledgerId}`)).status).toBe(200);

  // (e-2) **規則の無いアプリの表は 403 ではない**(`owner` を含む全員に「200 + 0件」)。
  for (const who of [owner, customer, session("viewer"), session("editor")]) {
    const vault = await req(who.cookie, "GET", records("vault"));
    expect(vault.status).toBe(200);
    expect(((await vault.json()) as { records: unknown[] }).records).toEqual([]);
    expect((await req(who.cookie, "GET", `${records("vault")}/nope`)).status).toBe(404);
  }
});

// =====================================================================================
// (f) 判定は表の**識別子**だけで分かれる —— アプリの表に `_` 始まりのIDは作れない
// =====================================================================================

test("(f) システムの表と同じ綴りのアプリの表は作れない(判定が取り違えようがない)", () => {
  // **`^[a-z][a-z0-9_-]*$`(`resource_id`)に `_` 始まりは合わない** ——
  // **したがって `isSystemTableId(tableId)` が真になるのは、本当にシステムの表のときだけ。**
  for (const id of SYSTEM_TABLE_IDS) {
    expect(/^[a-z][a-z0-9_-]*$/.test(id), id).toBe(false);
  }
});

// =====================================================================================
// (g) **集計表の経路にも同じ1本が掛かる**(`V8-M10-T02` / 台帳 `Q-G16a` の条件5)
// =====================================================================================

/**
 * **`V8-M8` は集計表の経路で `D-V8-74` を素通りさせていた。**
 * **`app.ts` の `app.use(… /views/:view_id/report …)` の doc に逐語で残っている**:
 * **「`D-V8-74`(システムが持つ表の読取は持ち主だけ)の分岐は `isSystemTableId(undefined)`
 * が偽になるので、1度も評価されない」。**
 *
 * ## **【発火しない分岐を足したのではない。実測で到達を示してから足した】**
 *
 * **`v8-m10.md` §1 `T02` の 5' は「集計表の宣言にシステムの表を名指しできないなら
 * 『到達しない』と書け。1つでも通ったらそのときだけ足せ」と定めた。** **通った。**
 *  - **画面の対象表の値域は `$defs/view_table_id`(`^(_apps|_changelog|[a-z][a-z0-9_-]*)$`)で
 *    あり、`resource_id`(`^[a-z][a-z0-9_-]*$`)ではない** —— **`_apps` / `_changelog` を通す。**
 *  - **`HTTP POST /diffs` で `{ type: "report_view", table: "_apps" }` が 201 で通り、
 *    `GET …/report` が 200 を返した**(実測。**別アプリを1つ作ると `count` が 1 → 2 に
 *    増え、アプリの外の行を数えていた**)。
 *  - **`join[].table` / `group_by[].table` / `aggregates[].table` / `reference_table` は
 *    `resource_id` なので 400 で拒まれる。** **`_ai_usage` は `view.table` でも 400。**
 *
 * **本検査はその2本(`_apps` / `_changelog`)を実 HTTP で当てる。**
 */
/**
 * **【`V17-M4-T01` / 台帳 `AC-G19`】(g) が足す集計表3枚の「画面の読取」。**
 *
 * **本段の判定は画面しか見ない** —— **表の規則も、システムの表かどうかも1文字も見ない。**
 */
const REPORT_VIEW_READS = ["rep_apps", "rep_chg", "rep_ledger"].map((view) => ({
  target: "view",
  view,
  can: ["read"],
}));

test("(g) システムの表を対象にした集計表は持ち主だけが読める(非 owner は 403)", async () => {
  await boot();
  const applied = applyDiff(dataRoot as string, APP_ID, {
    diff_id: "system-report",
    intent: "システムの表とアプリの表を対象にした集計表を3枚足す",
    operations: [
      {
        op: "add_view",
        view: {
          id: "rep_apps",
          type: "report_view",
          table: "_apps",
          name: "アプリ台帳の集計",
          report: { group_by: [{ field: "status" }], aggregates: [{ type: "count" }] },
        },
      },
      {
        op: "add_view",
        view: {
          id: "rep_chg",
          type: "report_view",
          table: "_changelog",
          name: "変更履歴の集計",
          report: { group_by: [{ field: "kind" }], aggregates: [{ type: "count" }] },
        },
      },
      {
        op: "add_field",
        table: "ledger",
        field: { id: "kind", name: "種別", type: "select", options: ["A", "B"] },
      },
      {
        op: "add_view",
        view: {
          id: "rep_ledger",
          type: "report_view",
          table: "ledger",
          name: "台帳の集計",
          report: { group_by: [{ field: "kind" }], aggregates: [{ type: "count" }] },
        },
      },
      /*
       * **【`V17-M4-T01` / 台帳 `AC-G19` による追記。上の宣言も下の期待値も1バイトも変えていない】**
       *
       * **本段が集計表の口に「その画面を閲覧してよいか」の判定を1本置いた。**
       * **`add_view` の畳み込みは既定3役割(`owner` / `editor` / `viewer`)にしか
       * 画面の規則を生やさないので、`customer` だけが画面の関門で 403 になり、
       * `(g-3)`(アプリの表の集計は今日どおり 200)を測れなくなる。**
       *
       * **そこで4役割**全部**に、同じ3枚の画面の読取を明示的に配る** ——
       * **表の規則は1行も変えていない**(上の `roles` と同じ内容をそのまま書き戻している)。
       * **`(g-2)` が測るのは「システムの表の集計は持ち主だけ」であって
       * 「画面を開けない人が 403 になる」ことではない** —— **画面の関門を全員に通した上で、
       * 非 owner が **持ち主** の文面で 403 になることを見る形にした。**
       * **既存アプリの役割は `set_roles` に今の全部を書き戻さないと直らない**
       * (この作法は `V8-M35` の `F-G10` が実測している)。
       */
      {
        op: "set_roles",
        roles: [
          {
            id: "owner",
            name: "持ち主",
            rules: [
              { target: "app", can: ["write"] },
              { target: "role", can: ["write"] },
              { target: "table", table: "ledger", can: ["read", "write", "delete"] },
              ...REPORT_VIEW_READS,
            ],
          },
          {
            id: "editor",
            name: "編集者",
            rules: [
              { target: "table", table: "ledger", can: ["read", "write"] },
              ...REPORT_VIEW_READS,
            ],
          },
          {
            id: "viewer",
            name: "閲覧者",
            rules: [{ target: "table", table: "ledger", can: ["read"] }, ...REPORT_VIEW_READS],
          },
          {
            id: "customer",
            name: "一般利用者",
            rules: [
              { target: "table", table: "ledger", can: ["read", "write"] },
              ...REPORT_VIEW_READS,
            ],
          },
        ],
      },
    ],
  });
  expect({ valid: applied.valid, errors: (applied as { errors?: unknown }).errors }).toEqual({
    valid: true,
    errors: undefined,
  });
  const report = (viewId: string) => `/api/apps/${APP_ID}/views/${viewId}/report`;

  // **(g-1) 持ち主は今日どおり読める**(1バイトも狭めていない)。
  const owner = session("owner");
  for (const viewId of ["rep_apps", "rep_chg", "rep_ledger"]) {
    expect((await req(owner.cookie, "GET", report(viewId))).status, viewId).toBe(200);
  }

  // **(g-2) 持ち主以外はシステムの表の集計を読めない**(旧: 200)。
  for (const role of ["editor", "viewer", "customer"]) {
    const who = session(role);
    for (const viewId of ["rep_apps", "rep_chg"]) {
      const response = await req(who.cookie, "GET", report(viewId));
      expect(response.status, `${role} ${viewId}`).toBe(403);
      const body = (await response.json()) as { errors: { message?: string }[] };
      // **レコード一覧の経路とまったく同じ1本の文である**(2本目の判定を作っていない)。
      expect(body.errors[0]?.message, `${role} ${viewId}`).toContain("持ち主");
    }
    // **(g-3) アプリの表を対象にした集計表には1バイトも掛かっていない。**
    expect((await req(who.cookie, "GET", report("rep_ledger"))).status, role).toBe(200);
  }

  // **(g-4) 未認証は今日どおり 401 である**(403 に化けていない)。
  expect((await req(undefined, "GET", report("rep_apps"))).status).toBe(401);
});
