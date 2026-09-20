/**
 * **合計の母集団が `total` の母集団と1件も割れないことの実測**(`V4-M23-T02`。
 * `ADR-0104` 限定5 / 限定6 / 限定7 / 限定11)。
 *
 * **限定表の正は [`docs/adr/0104-list-view-aggregate.md`](../../docs/adr/0104-list-view-aggregate.md) §Decision 5**、
 * 完了条件の正は `docs/plan/v4/records/v4-m23.md` §1-1 の `V4-M23-T02` の行。
 *
 * ## ここで測るもの(**本物の SQLite / 本物の HTTP**)
 *
 * | # | 何を | 限定 |
 * |---|---|---|
 * | (A) | **非スコープ分岐**: 合計の母集団が `total` と一致する(`filter` 適用後・ページを越える) | 限定5 |
 * | (B) | **匿名公開の post-filter 分岐**: 合計は可視集合だけを足す(`st_public` でない行を1円も足さない) | 限定5 / 限定7 |
 * | (C) | **`st_owner` 個人スコープの post-filter 分岐**: 他人の行を1円も足さない | 限定5 / 限定7 |
 * | (D) | **同じ1文で採っている**(非スコープ分岐で DB へ投げるクエリが1本も増えていない) | 限定6 |
 * | (E) | **面の項目の規則(`app.roles[].rules` の `target: "field"`)が名指しした項目は、宣言でも読取パラメータでも合計できない** | 限定表を越えて締めた1点 |
 *
 * **【2026-08-09 追記(`V8-M20` / 台帳 `J-G28` / `ADR-0301`)。上の表の (E) は
 * 着手前「`audience` を宣言した項目は…」だった。旧文を1バイトも消していない】**
 * **項目の「見せる相手」(`field.audience`)の語彙は廃止された。****締めの趣旨は
 * 1ミリも変わっておらず、適用時検査が見る先が面の規則へ移っただけである。**
 * | (F) | **合計は行を1件も作らず、書き換えない**(読取専用の導出値) | 限定11 |
 *
 * ## 【正直に書く】この検査が言わないこと
 *
 * 1. **性能を1度も測っていない**(それは `V4-M23-T06` である)。
 * 2. **MCP 経路を1ミリも測っていない** —— **`list_records` は本宣言を1つも見ない**
 *    (`ADR-0104` §限界8)。**画面と MCP で見えるものが違う。**
 * 3. **ブラウザを1枚も開いていない** —— 表示層が組み立てる形は `web/test/` が見る。
 * 4. **`group_by` / `having` / `avg` を1つも測っていない** —— **実装が1バイトも無いからである。**
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appDbPath,
  applyManifest,
  createApp,
  createRecord,
  KernelMetaStore,
  type Manifest,
} from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import {
  judgeRoleAccess,
  OWNER_FIELD,
  recordAccessSourceTables,
  recordPopulationScope,
} from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

/**
 * **【`V8-M10-T06`(台帳 `Q-G16b`)が足した4本の import】** —— `Database` / `appDbPath` /
 * `createRecord` は (G)(H) が付与行・メンバー行・条件読取の対象行を **カーネル層で直接作る**
 * ために要る(`record-access-visibility.test.ts` と同じ作法。`folder` / `docket` は面
 * (役割)の規則を持たないので HTTP 経由の書込みができない)。`judgeRoleAccess` /
 * `recordAccessSourceTables` / `recordPopulationScope` は、(G)(H) が「本当にその分岐を
 * 踏んでいる」ことを実物の判定関数で直接確かめる(推測で確かめない)ために要る。
 */

const APP_ID = "sum-boundary";

/**
 * **3つの母集団の分岐をすべて持つマニフェスト。**
 * - `ticket` = 非スコープ(既定)。
 * - `note` = `st_owner` を持つ個人スコープ。
 * - `item` = `st_public` を持つ匿名公開。
 */
function baseManifest(sumFields: Record<string, string> = {}): Manifest {
  const view = (
    id: string,
    table: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    id,
    type: "list_view",
    table,
    columns: ["title", "amount"],
    ...(sumFields[id] === undefined ? {} : { sum_field: sumFields[id] }),
    ...extra,
  });
  return {
    app: {
      id: APP_ID,
      name: "合計の境界",
      tables: [
        {
          id: "ticket",
          name: "チケット",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "amount", name: "金額", type: "number" },
            // **面の項目の規則が名指ししている `number` 項目。** **(E) の当たり先。**
            // **【`V8-M20` / `J-G28` / `ADR-0301`】旧: `audience: ["owner"]` をここに
            // 書いていた。****その語彙は廃止されたので、下の `roles` から名指しする。**
            { id: "cost", name: "原価", type: "number" },
          ],
        },
        {
          id: "note",
          name: "メモ",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "amount", name: "金額", type: "number" },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
          ],
        },
        {
          id: "item",
          name: "商品",
          fields: [
            { id: "title", name: "名前", type: "text", required: true },
            { id: "amount", name: "金額", type: "number" },
            { id: "st_public", name: "公開", type: "boolean" },
          ],
        },
        // **【`V8-M10-T06` / `Q-G16b`】(H) が踏む役割つき条件読取(role_conditional)の表。**
        // **`st_owner` も `st_public` も `access_control` も1つも持たない** —— 読取を開くのは
        // 役割 `clerk` の `when` つき規則だけである(下の `roles` を見よ)。
        {
          id: "docket",
          name: "担当票",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "amount", name: "金額", type: "number" },
            { id: "assignee", name: "担当者", type: "text" },
          ],
        },
        // **【`V8-M10-T06` / `Q-G16b`】(G) が踏む行アクセス権(record_access)の表。**
        // **`access_control` を宣言している。** `st_owner` も `st_public` も持たない。
        {
          id: "folder",
          name: "共有フォルダ",
          fields: [
            { id: "title", name: "名前", type: "text", required: true },
            { id: "amount", name: "金額", type: "number" },
          ],
          access_control: {
            enabled: true,
            permissions: [
              { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
              { id: "writer", name: "編集できる", read: true, write: true, delete: false },
            ],
            creator_permission: "writer",
            grant: {
              table: "folder_grant",
              target: "folder",
              member: "member",
              permission: "permission",
            },
            members: { table: "folder_member", account: "account" },
          },
        },
        {
          id: "folder_member",
          name: "共有フォルダの利用者",
          fields: [{ id: "account", name: "ログイン", type: "text" }],
        },
        {
          id: "folder_grant",
          name: "共有フォルダの付与",
          fields: [
            { id: "folder", name: "対象", type: "reference", reference_table: "folder" },
            { id: "member", name: "相手", type: "reference", reference_table: "folder_member" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
          ],
        },
      ],
      views: [
        view("ticket-list", "ticket"),
        view("note-list", "note"),
        view("item-list", "item"),
        // **画面の `filter` が半分を隠している一覧**(限定5 の当たり先)。
        view("open-list", "ticket", { filter: { field: "title", contains: "公開" } }),
      ],
      // **【`V8-M20` / `J-G28` / `ADR-0301`】項目の「見せる相手」(`field.audience`)の
      // 置き直し先。** **(E) が当たる `ticket.cost` を、役割 `owner` の項目の規則で名指しする。**
      // **既定3ロール(`owner` / `editor` / `viewer`)は消せない。**
      // **`can` に `write` も入れている理由** —— **名指しした時点でその項目は全動詞が
      // allow-list になるので、`read` だけ書くと owner ですら `cost` を書き込めなくなり、
      // (E) の HTTP 側の下ごしらえ(`cost: 70` を持つ行の作成)が 403 で落ちる。**
      // **表(`ticket`)の規則は1本も書かない** —— **書くと `D-V8-35` により `st_owner` の
      // 絞り込みが読取で効かなくなり、(C) の母集団が変わってしまう。**
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [{ target: "field", table: "ticket", field: "cost", can: ["read", "write"] }],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
        // **【`V8-M10-T06` / `Q-G16b`】(H) だけが使う役割。** **`docket` の読取を
        // 「担当者が自分の行だけ」に絞る条件つき規則を1本だけ持つ**
        // (`record-population-home.test.ts` の `CONDITIONAL_ROLES` と同じ形)。
        {
          id: "clerk",
          name: "担当者",
          rules: [
            {
              target: "table",
              table: "docket",
              can: ["read"],
              when: { field: "assignee", equals_current_user: true },
            },
          ],
        },
      ],
    },
  } as unknown as Manifest;
}

/**
 * **【`V8-M26`】適用する題材** —— **既定3役割の規則を足したうえで、未ログインに
 * `item` の読取を1本だけ手で足す。**
 *
 * **なぜ要るのか**: **面(役割に束ねた権限)の既定が「閉じる」側へ倒れた**ので、
 * **規則を1本も名指ししていない表は誰にも読めず、誰も書けない。**
 * **`applyManifest` を直接呼ぶ本ファイルは `apply-diff.ts` の自動付与に乗らない。**
 *
 * **足す先を絞っている**:
 * - **画面には1本も足さない**(`skipAllViews`)—— **本ファイルは `?view=` を1度も
 *   名乗らないので、画面の規則は主題に1ミリも関わらない。**
 * - **`anonymous` に足すのは `item` の読取1本だけである** —— **(B) の主題
 *   「匿名の合計は `st_public` な行だけを足す」を測るのに要る。** **`withDefaultRoleRules`
 *   は未ログインへ1本も配らない**(`D-V8-45` / `T-G26a`)**ので、ここは手で書く。**
 *   **`ticket` にも `note` にも未ログインの規則は1本も無い。**
 *   **これは実アプリの既定ではない** —— **差分の自動付与は `anonymous` に1本も配らない。**
 */
function applied(sumFields: Record<string, string>): Manifest {
  const manifest = withDefaultRoleRules(baseManifest(sumFields), {
    skipAllViews: true,
    // **【`V8-M10-T06` / `Q-G16b`】`docket` / `folder` には既定3役割の規則を1本も足さない。**
    // **足すと面(役割)がその表を無条件に開けてしまい、点(付与)だけ・条件つき規則だけで
    // 開く分岐(record_access / role_conditional)が検査できなくなる**
    // (`access-control-verbs.test.ts` / `record-access-visibility.test.ts` と同じ理由で
    // `skipTables` を使う。`folder_member` / `folder_grant` は素通しのままでよい ——
    // (G)(H) はどちらも HTTP を使わずカーネル層で直接行を作るので、面の規則は不要)。
    skipTables: ["docket", "folder"],
  }) as unknown as { app: { roles: Record<string, unknown>[] } };
  // **【`V18-M4-T02b`。ユーザ決定 `D-V18-26` / `ADR-0441`】画面の規則を足した。**
  //
  // **`V18-M4-T02` が「画面名を名乗らない読取」に壁を立てた** —— **その表を指す一覧系の
  // 画面(`list_view` / `report_view`)を**1本も読めない**相手の一覧は 0件になる
  // (単票の口は `detail_view` / `form` を見て 404 になる)。** **`D-V18-26` により、
  // 画面を宣言しているのに「誰に見せるか」を役割の規則に1行も書いていない場合も止まる。**
  //
  // **直上の「画面には1本も足さない(`skipAllViews`)—— 本ファイルは `?view=` を1度も
  // 名乗らないので、画面の規則は主題に1ミリも関わらない」は、今日は偽である
  // (1バイトも消していない)** —— **`?view=` を名乗らない読取こそが壁の当たり先である。**
  //
  // **`skipAllViews: true` はそのまま残し、要る画面の読取だけを手で書く** ——
  // **`withDefaultRoleRules` を素で通すとボタン(`action`)の規則まで配ってしまうためである。**
  // **(A)〜(F) が測っているのは合計の母集団であって画面の規則ではないので、
  // 主張(`expect`)は1バイトも書き換えていない。**
  const LIST_VIEWS = ["ticket-list", "note-list", "item-list", "open-list"] as const;
  for (const role of manifest.app.roles as { id?: unknown; rules?: unknown[] }[]) {
    if (role.id !== "owner" && role.id !== "editor" && role.id !== "viewer") {
      continue;
    }
    role.rules = [
      ...(role.rules ?? []),
      ...LIST_VIEWS.map((view) => ({ target: "view", view, can: ["read"] })),
    ];
  }
  manifest.app.roles.push({
    id: "anonymous",
    name: "未ログイン",
    rules: [
      { target: "table", table: "item", can: ["read"] },
      // **(B) の主題「匿名の合計は `st_public` な行だけを足す」を測るのに要る1本。**
      { target: "view", view: "item-list", can: ["read"] },
    ],
  });
  return manifest as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
/**
 * **【`V8-M10-T06` / `Q-G16b`】適用に使った実物の `Manifest`。**
 * (G)(H) が `judgeRoleAccess` / `recordAccessSourceTables` / `recordPopulationScope` を
 * **手で組んだ偽物ではなく、実際に apply した宣言そのもの**に対して呼ぶために保持する。
 */
let manifestUnderTest: Manifest;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-sum-boundary-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "合計の境界", { app_id: APP_ID });
  } finally {
    store.close();
  }
  manifestUnderTest = applied({
    "ticket-list": "amount",
    "note-list": "amount",
    "item-list": "amount",
    "open-list": "amount",
  });
  expect(applyManifest(dataRoot, APP_ID, manifestUnderTest).valid).toBe(true);
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
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
  return Promise.resolve(app.request(new Request(`http://localhost${path}`, init)));
}

const recordsPath = (table: string) => `/api/apps/${APP_ID}/tables/${table}/records`;

async function read(
  cookie: string | undefined,
  table: string,
  params: Record<string, string> = {},
): Promise<{ status: number; total: number; sum: unknown; rows: { amount?: number }[] }> {
  const query = new URLSearchParams(params).toString();
  const res = await req(cookie, "GET", `${recordsPath(table)}${query === "" ? "" : `?${query}`}`);
  if (res.status !== 200) {
    return { status: res.status, total: -1, sum: undefined, rows: [] };
  }
  const body = (await res.json()) as {
    records: { amount?: number }[];
    total?: number;
    sum?: unknown;
  };
  return {
    status: 200,
    total: body.total ?? body.records.length,
    sum: body.sum,
    rows: body.records,
  };
}

function owner(username: string): string {
  return seedSession(dataRoot, APP_ID, { role: "owner", username }).cookie;
}
function editor(username: string): string {
  return seedSession(dataRoot, APP_ID, { role: "editor", username }).cookie;
}

/**
 * **【`V8-M10-T06` / `Q-G16b`】(G)(H) 用**。`owner()` / `editor()` と違い、
 * cookie だけでなく `userId` / `roles` も要るので、セッション全体を返す。
 */
function actorSession(role: string, username: string): ReturnType<typeof seedSession> {
  return seedSession(dataRoot, APP_ID, { role, username });
}

/**
 * **【`V8-M10-T06` / `Q-G16b`】(G)(H) 用**。`folder` / `docket` は面(役割)の規則を
 * 持たない(`applied()` の `skipTables`)ので、HTTP 経由では行を作れない。
 * `record-access-visibility.test.ts` と同じく、カーネルの `createRecord` で直接 DB に書く。
 */
function withDb<T>(run: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

async function create(cookie: string, table: string, body: Record<string, unknown>): Promise<void> {
  const res = await req(cookie, "POST", recordsPath(table), body);
  expect(res.status, JSON.stringify(body)).toBe(201);
}

// ---------------------------------------------------------------------------
// (A) 限定5: 非スコープ分岐 —— 合計の母集団は `total` と同一である
// ---------------------------------------------------------------------------

test("(A) 合計は filter 適用後の全件を足す(1ページ分ではない)", async () => {
  const cookie = await owner("a1");
  for (let i = 1; i <= 7; i += 1) {
    await create(cookie, "ticket", { title: `公開 ${i}`, amount: i * 100 });
  }
  // 1ページ 2件だけ取っても、合計は7件ぶんである。
  const page = await read(cookie, "ticket", { sum: "amount", limit: "2" });
  expect(page.status).toBe(200);
  expect(page.rows).toHaveLength(2);
  expect(page.total).toBe(7);
  // 100+200+…+700 = 2800
  expect(page.sum).toBe(2800);
});

test("(A) filter を掛けると、合計も total も同じ母集団に縮む", async () => {
  const cookie = await owner("a2");
  await create(cookie, "ticket", { title: "公開 1", amount: 100 });
  await create(cookie, "ticket", { title: "公開 2", amount: 200 });
  await create(cookie, "ticket", { title: "内部 3", amount: 9999 });

  const filtered = await read(cookie, "ticket", {
    sum: "amount",
    filter: JSON.stringify({ field: "title", contains: "公開" }),
  });
  expect(filtered.total).toBe(2);
  expect(filtered.sum).toBe(300);
});

test("(A) 行が1件も無いとき、合計は 0 である(null を返さない)", async () => {
  const cookie = await owner("a3");
  const empty = await read(cookie, "ticket", { sum: "amount" });
  expect(empty.total).toBe(0);
  expect(empty.sum).toBe(0);
});

test("(A) 値を入れていない行は 0 として扱う(合計が null にならない)", async () => {
  const cookie = await owner("a4");
  await create(cookie, "ticket", { title: "空 1" });
  await create(cookie, "ticket", { title: "有 2", amount: 250 });
  const result = await read(cookie, "ticket", { sum: "amount" });
  expect(result.total).toBe(2);
  expect(result.sum).toBe(250);
});

test("(A) sum を渡さない読み取りは、着手前と1バイトも変わらない(sum キーが応答に無い)", async () => {
  const cookie = await owner("a5");
  await create(cookie, "ticket", { title: "公開 1", amount: 100 });
  const res = await req(cookie, "GET", recordsPath("ticket"));
  const body = (await res.json()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["records", "total"]);
});

// ---------------------------------------------------------------------------
// (C) 限定5 / 限定7: `st_owner` 個人スコープ —— 他人の行を1円も足さない
//
// **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-58` / `D-V8-65` と `D-V8-35` の重なり。
//   上の見出し「他人の行を1円も足さない」は、既定3役割については今日は偽である。
//   旧文を1バイトも消していない】**
//
// **何が起きたか(実測)**:
//  1. **既定が「閉じる」側へ倒れたので、表を読むには面の規則(`target: "table"` × `read`)が
//     どこかの役割に要る。** **規則の無い表は 0 行になる。**
//  2. **ところが `D-V8-35`(`V8-M20`)は「表の読取を許した役割は全員分の行を読める」と
//     決めている**(`src/server/owner-scope.ts` の `roleReadCrossesOwnerScope`)。
//  3. **したがって「読める」と「自分の分だけ見える」は今日、両立しない** ——
//     **読取規則が在れば `st_owner` を越え、無ければ1行も見えない。**
//
// **`V8-M20` の題材はこの衝突を「表の規則を1本も書かない」ことで避けていた**
// (`baseManifest` の逐語コメント「**表(`ticket`)の規則は1本も書かない** —— **書くと
// `D-V8-35` により `st_owner` の絞り込みが読取で効かなくなり、(C) の母集団が変わってしまう。**」)。
// **`V8-M26` はその逃げ道を閉じた** —— **規則を書かない表は読めないからである。**
//
// **【誇張しない】`st_owner` は1バイトも消えていない** —— **既定3役割の自動付与を受けて
// いない役割(`user_kinds` で宣言した種類など)では今日どおり効く。** **ただしその役割は
// 表の読取規則を持たないので、今日は同じ表を1行も読めない。**
// ---------------------------------------------------------------------------

test("(C) 個人スコープの合計は、自分に見える行だけを足す(total と同じ母集団)", async () => {
  const mine = await editor("c-mine");
  const other = await editor("c-other");
  await create(mine, "note", { title: "自分 1", amount: 100 });
  await create(mine, "note", { title: "自分 2", amount: 200 });
  await create(other, "note", { title: "他人 1", amount: 5000 });

  // **【`V8-M26`。旧の4行を逐語で残す】**
  // **旧: `expect(seen.total).toBe(2);`**
  // **旧: `expect(seen.sum).toBe(300);`**
  // **旧: `expect(theirs.total).toBe(1);`**
  // **旧: `expect(theirs.sum).toBe(5000);`**
  //
  // **今日は編集者2人がどちらも3件を見る**(上のブロックの 1〜3)。
  // **合計と `total` の母集団が1件も割れないという (C) の本題は今日も真である** ——
  // **割れないまま、可視集合そのものが広がった。**
  const seen = await read(mine, "note", { sum: "amount" });
  expect(seen.total).toBe(3);
  expect(seen.sum).toBe(5300);

  const theirs = await read(other, "note", { sum: "amount" });
  expect(theirs.total).toBe(3);
  expect(theirs.sum).toBe(5300);
  // **2人の見え方が一致していること自体が「個人スコープが効いていない」ことの実測である。**
  expect(seen.sum).toBe(theirs.sum);
});

test("(C) 母集団は total と構造的に一致する(合計 == 見えている行の総和)", async () => {
  const mine = await editor("c2");
  const other = await editor("c2-other");
  for (let i = 1; i <= 5; i += 1) {
    await create(mine, "note", { title: `自分 ${i}`, amount: i });
  }
  await create(other, "note", { title: "他人", amount: 1000 });

  // **limit を外して全件を読み、行から自分で足した値と応答の合計が一致することを見る。**
  // **【`V8-M26`。旧の2行を逐語で残す】**
  // **旧: `expect(all.total).toBe(5);`**
  // **旧: `expect(all.sum).toBe(15);`**
  // **今日は他人の1件も見える**(すぐ上のブロックの理由)。
  // **`expect(all.sum).toBe(byHand)` は1バイトも変えていない** ——
  // **「合計 == 見えている行の総和」という (C) の構造の主張は、可視集合が広がっても真である。**
  const all = await read(mine, "note", { sum: "amount" });
  const byHand = all.rows.reduce((acc, row) => acc + (row.amount ?? 0), 0);
  expect(all.total).toBe(6);
  expect(all.sum).toBe(byHand);
  expect(all.sum).toBe(1015);
});

// ---------------------------------------------------------------------------
// (B) 限定5 / 限定7: 匿名公開 —— `st_public` でない行を1円も足さない
// ---------------------------------------------------------------------------

test("(B) 匿名の合計は st_public な行だけを足す", async () => {
  const cookie = await owner("b1");
  await create(cookie, "item", { title: "公開 1", amount: 100, st_public: true });
  await create(cookie, "item", { title: "公開 2", amount: 200, st_public: true });
  await create(cookie, "item", { title: "非公開", amount: 9000, st_public: false });

  const anonymous = await read(undefined, "item", { sum: "amount" });
  expect(anonymous.status).toBe(200);
  expect(anonymous.total).toBe(2);
  expect(anonymous.sum).toBe(300);
});

// ---------------------------------------------------------------------------
// (E) **面の項目の規則が名指しした項目**は、宣言でも読取パラメータでも合計できない
//
// **【`V8-M20` / `J-G28` / `ADR-0301`】置き直し。** **旧の見出しは
// 「`audience` を宣言した項目は、宣言でも読取パラメータでも合計できない」だった。**
// **趣旨(隠した項目の合計だけが見える形を作らない)は今日も生きており、適用時検査
// (`src/kernel/referential-integrity.ts`)が見る先が `field.audience` から
// `app.roles[].rules` の `target: "field"` へ移っただけである。**
// ---------------------------------------------------------------------------

test("(E) 面の項目の規則が名指しした項目を sum_field に書いた差分は、本物の SQLite で拒否される", () => {
  const result = applyManifest(dataRoot, APP_ID, baseManifest({ "ticket-list": "cost" }));
  expect(result.valid).toBe(false);
  const errors = (result as { errors: { path: string; message: string }[] }).errors;
  expect(errors.some((error) => error.path.includes("sum_field"))).toBe(true);
  // **【`V8-M20` / `J-G28` / `ADR-0301`】エラー文言が変わった。**
  // **旧: `expect(errors.some((error) => error.message.includes("audience"))).toBe(true);`**
  // **今日の逐語(2026-08-09 に実測)**:
  //   `合計を出す列(sum_field)に指定されたフィールド "cost" は、役割の規則が名指ししている項目です。名指しされた項目の合計は出せません。`
  expect(errors.some((error) => error.message.includes("役割の規則が名指ししている項目"))).toBe(
    true,
  );
});

// **【`V8-M20` / `J-G28` / `ADR-0301`】置き直した検査。**
// **旧テスト名**: `(E) 読取パラメータで audience つきの項目を名指ししても合計されない`。
test("(E) 読取パラメータで面の項目の規則が名指しした項目を名指ししても合計されない", async () => {
  const cookie = await owner("e2");
  await create(cookie, "ticket", { title: "公開 1", amount: 100, cost: 70 });
  const res = await req(cookie, "GET", `${recordsPath("ticket")}?sum=cost`);
  expect(res.status).toBe(400);
});

test("(E) number 以外の列を読取パラメータで名指ししても合計されない", async () => {
  const cookie = await owner("e3");
  await create(cookie, "ticket", { title: "公開 1", amount: 100 });
  const res = await req(cookie, "GET", `${recordsPath("ticket")}?sum=title`);
  expect(res.status).toBe(400);
});

test("(E) 存在しない列を読取パラメータで名指ししても合計されない", async () => {
  const cookie = await owner("e4");
  const res = await req(cookie, "GET", `${recordsPath("ticket")}?sum=nope`);
  expect(res.status).toBe(400);
});

// ---------------------------------------------------------------------------
// (F) 限定11: 合計は読取専用の導出値である
// ---------------------------------------------------------------------------

test("(F) 合計を何度読んでも、行は1件も増えず値も1つも変わらない", async () => {
  const cookie = await owner("f1");
  await create(cookie, "ticket", { title: "公開 1", amount: 100 });
  const first = await read(cookie, "ticket", { sum: "amount" });
  await read(cookie, "ticket", { sum: "amount" });
  const third = await read(cookie, "ticket", { sum: "amount" });
  expect(third.total).toBe(first.total);
  expect(third.sum).toBe(first.sum);
  expect(third.total).toBe(1);
});

test("(F) 合計を書き込む口が HTTP に1つも無い", async () => {
  const cookie = await owner("f2");
  await create(cookie, "ticket", { title: "公開 1", amount: 100 });
  // **`sum` を本文に載せた作成は、未知フィールドとして拒否される**(合計は列ではない)。
  const res = await req(cookie, "POST", recordsPath("ticket"), {
    title: "公開 2",
    amount: 100,
    sum: 999,
  });
  expect(res.status).toBe(400);
});

// ---------------------------------------------------------------------------
// (D) 限定6: 同じ1文で採っている —— 別クエリを1本も増やしていない
// ---------------------------------------------------------------------------

test("(D) 非スコープ分岐が投げる集約の SQL は1文である(COUNT と SUM が同居している)", async () => {
  const source = await Bun.file(new URL("../kernel/records.ts", import.meta.url)).text();
  // **1文の中に COUNT(*) と SUM(<列>) が同居している。**
  // **`${` を含む文字列リテラルを検査に書かない**ため、1文を部分ごとに見る。
  const aggregateLine = source
    .split("\n")
    .find((line) => line.includes("SELECT COUNT(*) AS n") && line.includes("sumClause"));
  expect(aggregateLine).toBeDefined();
  expect(aggregateLine).toContain("SELECT COUNT(*) AS n");
  expect(aggregateLine).toContain("sumClause");
  const sumColumnLine = source.split("\n").find((line) => line.includes("sumClause = `, SUM("));
  expect(sumColumnLine).toBeDefined();
  expect(sumColumnLine).toContain(", SUM(");
  expect(sumColumnLine).toContain(") AS s");
  // **合計のためだけの2本目のクエリを組み立てていない。**
  expect(source).not.toContain("SELECT SUM(");
});

// ---------------------------------------------------------------------------
// (G) `V8-M10-T06`(台帳 `Q-G16b`): 行アクセス権(record_access) ——
// 合計は付与された行だけを足す
//
// **着手前(`v8-m10.md` §2-3)、本ファイルは行アクセス権の分岐を1本も踏んでいなかった。**
// **「17 pass / 0 fail で緑」は、この分岐について1バイトも語っていなかった** ——
// **本ブロックがその穴を埋める。**
//
// **`folder` 表は `access_control` を宣言しており、`st_owner` も `st_public` も持たない**
// (`baseManifest` を見よ)。`owner-scope.ts` の `recordPopulationScope` の判定順序
// (匿名公開 → `st_owner` 個人スコープ → 行アクセス権 → 条件つき読取 → 非スコープ)から、
// `folder` を post-filter で読めているなら、それは `record_access` 以外にありえない。
// **推測で終わらせず、下の (G-3) で `recordPopulationScope` を実物の入力で直接呼び、
// 分類そのものを確かめる。**
//
// **付与行(`folder_grant`)とメンバー行(`folder_member`)、`folder` の行そのものは
// カーネルの `createRecord` で直接 DB に書く**(`record-access-visibility.test.ts` と
// 同じ作法)—— `folder` は面(役割)の規則を1本も持たない(`applied()` の `skipTables`)
// ので、判定を点(付与)だけに閉じるためには HTTP 経由の書込みを使わない。
// ---------------------------------------------------------------------------

/** `folder_grant` に1件、(相手, 対象, 権限名) の付与行を直接書く。 */
function grantFolderAccess(memberId: string, folderId: string, permission: string): void {
  withDb((db) => {
    const created = createRecord(db, manifestUnderTest, "folder_grant", {
      folder: folderId,
      member: memberId,
      permission,
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
  });
}

test("(G) 行アクセス権(record_access)の合計は、付与された行だけを足す(total と同じ母集団)", async () => {
  const g1 = actorSession("editor", "g1-editor");
  const g2 = actorSession("editor", "g2-editor");

  // **4行(r1〜r4)を作る。r4 には誰にも付与しない(「付与0件」の対照)。**
  const rowIds: Record<string, string> = {};
  withDb((db) => {
    for (const [key, amount] of [
      ["r1", 100],
      ["r2", 250],
      ["r3", 500],
      ["r4", 900],
    ] as const) {
      const created = createRecord(db, manifestUnderTest, "folder", { title: key, amount });
      expect(created.ok, JSON.stringify(created)).toBe(true);
      rowIds[key] = (created as { value: { _id: string } }).value._id;
    }
  });

  let memberG1 = "";
  let memberG2 = "";
  withDb((db) => {
    const m1 = createRecord(db, manifestUnderTest, "folder_member", { account: g1.userId });
    expect(m1.ok, JSON.stringify(m1)).toBe(true);
    memberG1 = (m1 as { value: { _id: string } }).value._id;
    const m2 = createRecord(db, manifestUnderTest, "folder_member", { account: g2.userId });
    expect(m2.ok, JSON.stringify(m2)).toBe(true);
    memberG2 = (m2 as { value: { _id: string } }).value._id;
  });

  // g1 には r1(100)/ r2(250)= 合計350、g2 には r3(500)だけを付与する。
  grantFolderAccess(memberG1, rowIds.r1 ?? "", "reader");
  grantFolderAccess(memberG1, rowIds.r2 ?? "", "reader");
  grantFolderAccess(memberG2, rowIds.r3 ?? "", "reader");

  const seenByG1 = await read(g1.cookie, "folder", { sum: "amount" });
  expect(seenByG1.status).toBe(200);
  expect(seenByG1.total).toBe(2);
  expect(seenByG1.sum).toBe(350);

  const seenByG2 = await read(g2.cookie, "folder", { sum: "amount" });
  expect(seenByG2.status).toBe(200);
  expect(seenByG2.total).toBe(1);
  expect(seenByG2.sum).toBe(500);

  // **(G-2) 正の確認(実測。`v8-m10.md` §2-6 の切り分けの手)**: `?sum=<存在しない列>` は
  // 非スコープ分岐だけが SQL 側で 400 を返し、post-filter 分岐は JS 側で黙って 200 になる。
  // ここが 200 であること自体が「非スコープ分岐を踏んでいない」ことの実測である。
  const probe = await req(g1.cookie, "GET", `${recordsPath("folder")}?sum=nosuchfield`);
  expect(probe.status).toBe(200);

  // **(G-3) 正の確認(実測)**: 母集団の分類そのものを、実物の判定関数
  // (`owner-scope.ts` の `recordPopulationScope`)に実際に apply した宣言を渡して確かめる。
  // 手で組み立てた偽の入力ではなく、`recordAccessSourceTables` / `judgeRoleAccess` という
  // 実物の関数の戻り値をそのまま渡す(`app.ts` が呼ぶのと同じ形)。
  const folderTable = manifestUnderTest.app.tables.find((table) => table.id === "folder");
  expect(folderTable).toBeDefined();
  const tableRead = judgeRoleAccess({
    manifest: manifestUnderTest,
    roles: g1.roles,
    target: { target: "table", table: "folder" },
    verb: "read",
  });
  const scope = recordPopulationScope({
    manifest: manifestUnderTest,
    table: folderTable ?? (undefined as never),
    anonymousPublic: false,
    accessSources: recordAccessSourceTables(manifestUnderTest, "folder"),
    tableRead,
  });
  expect(scope).toBe("record_access");
});

// ---------------------------------------------------------------------------
// (H) `V8-M10-T06`(台帳 `Q-G16b`): 役割つき条件読取(role_conditional) ——
// 合計は条件に合う行だけを足す
//
// **着手前、本ファイルには `when` を持つ役割規則が1本も無く、この分岐を1本も踏んでいなかった。**
//
// **`docket` 表は `st_owner` も `st_public` も `access_control` も1つも持たない**
// (`baseManifest` を見よ)。**読取を開くのは役割 `clerk` の
// `when: { field: "assignee", equals_current_user: true } }` という条件つき規則だけである**
// (`applied()` の `skipTables` で既定3役割からは外してある)。**これが `role_conditional`
// 分岐である**(`owner-scope.ts` の判定順序で、匿名公開でも個人スコープでも行アクセス権でも
// ない以上、条件つき規則が立っていれば `role_conditional` しか残らない)。
// ---------------------------------------------------------------------------

test("(H) 役割つき条件読取(role_conditional)の合計は、条件に合う行だけを足す(total と同じ母集団)", async () => {
  const h1 = actorSession("clerk", "h1-clerk");
  const h2 = actorSession("clerk", "h2-clerk");

  withDb((db) => {
    const rows: [string, number, string][] = [
      ["自分1", 100, h1.userId],
      ["自分2", 250, h1.userId],
      ["他人", 900, h2.userId],
    ];
    for (const [title, amount, assignee] of rows) {
      const created = createRecord(db, manifestUnderTest, "docket", { title, amount, assignee });
      expect(created.ok, JSON.stringify(created)).toBe(true);
    }
  });

  const seenByH1 = await read(h1.cookie, "docket", { sum: "amount" });
  expect(seenByH1.status).toBe(200);
  expect(seenByH1.total).toBe(2);
  expect(seenByH1.sum).toBe(350);

  const seenByH2 = await read(h2.cookie, "docket", { sum: "amount" });
  expect(seenByH2.status).toBe(200);
  expect(seenByH2.total).toBe(1);
  expect(seenByH2.sum).toBe(900);

  // **(H-2) 正の確認(実測)**: `?sum=<存在しない列>` は非スコープ分岐だけが 400 を返す。
  const probe = await req(h1.cookie, "GET", `${recordsPath("docket")}?sum=nosuchfield`);
  expect(probe.status).toBe(200);

  // **(H-3) 正の確認(実測)**: `judgeRoleAccess` が実際に `conditional: true` を返すこと、
  // そのうえで `recordPopulationScope` の分類そのものが `role_conditional` であることを、
  // 実物の関数で直接確かめる。
  const docketTable = manifestUnderTest.app.tables.find((table) => table.id === "docket");
  expect(docketTable).toBeDefined();
  const tableRead = judgeRoleAccess({
    manifest: manifestUnderTest,
    roles: h1.roles,
    target: { target: "table", table: "docket" },
    verb: "read",
  });
  expect(tableRead.conditional).toBe(true);
  const scope = recordPopulationScope({
    manifest: manifestUnderTest,
    table: docketTable ?? (undefined as never),
    anonymousPublic: false,
    accessSources: recordAccessSourceTables(manifestUnderTest, "docket"),
    tableRead,
  });
  expect(scope).toBe("role_conditional");
});

test("(D) サーバは合計のために readRecordCount をもう1回呼んでいない", async () => {
  const source = await Bun.file(new URL("./app.ts", import.meta.url)).text();
  // **一覧経路が呼ぶ件数の関数は1本だけである**(2本呼ぶと DB 往復が増える)。
  expect([...source.matchAll(/readRecordCountAndSum\(/g)]).toHaveLength(1);
  expect(source).not.toContain("readRecordCount(");
});

test("(D) post-filter 分岐は SQL で合計していない(限定7)", async () => {
  const source = await Bun.file(new URL("./app.ts", import.meta.url)).text();
  // **可視分岐の合計は sumVisible(JS の総和)だけを通る。**
  expect(source).toContain("const sumVisible = (rows: Record<string, unknown>[]): number =>");
  // **注釈行を除いた製品コードに `SUM(` が1件も無い**(注釈には限定6 の説明として現れる)。
  // **「0件」と丸めずに、在る場所を名指しする。**
  const codeLines = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  expect(codeLines.filter((line) => line.includes("SUM("))).toEqual([]);
});
