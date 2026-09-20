/**
 * **`V8-M17`(サーバ層)—— 役割に束ねた権限(面)を実際に効かせることの検査。**
 *
 * 台帳(`docs/adr/0007-vocabulary-governance.md` §8)の `J-G6` / `J-G7` / `J-G8` / `J-G9` /
 * `J-G10` / `J-G11` / `J-G19` と、メインの裁定 `R-4` / `R-5` / `R-6` / `R-13` が仕様である。
 *
 * ## この検査が固定すること
 *
 * 1. **4対象(表・項目・画面・ボタン)それぞれについて、規則を書いた役割の人が通り、
 *    書いていない役割の人が止まること** —— **4対象を別々の `test()` にしてある。**
 * 2. **規則を1本も書いていないアプリでは、面が1件も働かないこと**(裁定 `R-4`。
 *    `V8-M17` の完了条件 (iv) / 裁定 `N-2`)。
 * 3. **止めたのがどちらの層(面 / 点)かを判定が名指しできること**(裁定 `N-13`)。
 * 4. **差分から宣言を書き、`undo` で戻せること**(完了条件 (v))。**実 HTTP + 本物の SQLite。**
 *
 * ## この検査が固定していないこと(誇張しない)
 *
 * - **条件(`when`)は1バイトも作っていない**(`V8-M18` の担当)。
 * - **面と点の合成は `V8-M17` の時点では AND である**(裁定 `R-13-4`)。
 *   **`V8-M19` が `D-V8-23` に従って OR に変える。** **この中間の形は一時的だが、
 *   「一時的だから問題ない」とは書かない** —— **面で許した行を点が止める状態が実在する。**
 *   **【`V8-M19` による更新。上の2行は `V8-M17` が書いた予告であり、1バイトも消していない】**
 *   **今日は `OR` である** —— **変えたあとの形は (F) と
 *   `src/server/role-grant-union.test.ts` が固定している。**
 * - **MCP / 受信口 / ワークフロー / コードの島には1バイトも掛かっていない**(`V8-M21` の担当)。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { combineRoleAndGrantAccess, judgeRoleAccess } from "./owner-scope.ts";
import {
  type DefaultRoleRuleOptions,
  seedSession,
  TEST_ORIGIN,
  withDefaultRoleRules,
} from "./test-helpers.ts";

const APP_ID = "role-rules-shop";

/** 既定の役割定義3本(`V8-M17` が `create-app.ts` に入れた3本と同じ `id`)。 */
const DEFAULTS = [
  {
    id: "owner",
    name: "持ち主",
    rules: [
      // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
      { target: "app", can: ["write"] },
      { target: "role", can: ["write"] },
    ],
  },
  { id: "editor", name: "編集者" },
  { id: "viewer", name: "閲覧者" },
];

/** 面の規則を4対象ぶん書いた役割の一覧(`owner` にだけ書く)。 */
const RULED_ROLES = [
  {
    id: "owner",
    name: "持ち主",
    rules: [
      // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
      { target: "app", can: ["write"] },
      { target: "role", can: ["write"] },
      // (1) 表 —— `orders` は `owner` だけが読み・書き・消せる。
      { target: "table", table: "orders", can: ["read", "write", "delete"] },
      // (2) 項目 —— `notes.memo` は `owner` だけが読め・書ける。
      { target: "field", table: "notes", field: "memo", can: ["read", "write"] },
      // (3) 画面 —— `note-list` は `owner` だけが名乗れる。
      { target: "view", view: "note-list", can: ["read"] },
      // (4) ボタン —— `task-detail` の `mark-done` は `owner` だけに出る。
      { target: "action", view: "task-detail", action: "mark-done", can: ["read"] },
      // **【`V18-M4-T02b` / `D-V18-26`】壁を開けるための画面の読取(主題ではない)。**
      // - `order-board` … (A) の「`owner` は `orders` を今日どおり一覧できる」と
      //   (G) の和集合、(I) の `set_roles` 後の一覧に要る。
      // - `task-detail` … (D) が `owner` で単票を読んで `etag` を取るのに要る
      //   (**単票の口は `detail_view` / `form` を見る**)。**ボタンの規則は
      //   1本も増やしていない** —— **(D) の主題はそちらである。**
      { target: "view", view: "order-board", can: ["read"] },
      { target: "view", view: "task-detail", can: ["read"] },
    ],
  },
  {
    id: "editor",
    name: "編集者",
    // **【`V18-M4-T02b` / `D-V18-26`】(B) が `editor` で `notes` を一覧するのに要る1本。**
    // **表(`notes`)の規則は1本も足していない** —— **(A) の「`editor` の `notes` 一覧は
    // 空」は今日もそのまま立つ**(止めているのは表の層である)。
    rules: [{ target: "view", view: "note-board", can: ["read"] }],
  },
  { id: "viewer", name: "閲覧者" },
];

function manifest(roles: unknown[]): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "面の店",
      tables: [
        {
          id: "orders",
          name: "注文",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "amount", name: "金額", type: "number" },
            { id: "photo", name: "写真", type: "image" },
          ],
        },
        {
          id: "notes",
          name: "覚え書き",
          fields: [
            { id: "body", name: "本文", type: "text", required: true },
            { id: "memo", name: "運営メモ", type: "text" },
          ],
        },
        {
          id: "tasks",
          name: "作業",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "status", name: "状態", type: "text" },
          ],
        },
      ],
      views: [
        { id: "note-list", type: "list_view", table: "notes", columns: ["body"] },
        { id: "order-list", type: "list_view", table: "orders", columns: ["title"] },
        // **【`V18-M4-T02b`。ユーザ決定 `D-V18-26` / `ADR-0441`】一覧の口を開ける画面を
        // 2本足した。**
        //
        // **`V18-M4-T02` が「画面名を名乗らない読取」に壁を立てた** —— **その表を指す
        // 一覧系の画面(`list_view` / `report_view`)を**1本も読めない**相手の一覧は
        // 0件になる。** **`D-V18-26` により、画面を宣言しているのに「誰に見せるか」を
        // 役割の規則に1行も書いていない場合も止まる。**
        //
        // **既存の `order-list` / `note-list` に規則を足して済ませることはできない** ——
        // **(C) が「`order-list` は誰の規則にも名指しされていないので `owner` でも
        // `editor` でも 403」「`note-list` は `owner` だけが名乗れる」を測っており、
        // そこへ規則を足すとその測定が丸ごと消えるからである。**
        // **そこで、壁を開けるためだけの画面を別に2本置く。**
        { id: "order-board", type: "list_view", table: "orders", columns: ["title"] },
        { id: "note-board", type: "list_view", table: "notes", columns: ["body"] },
        {
          id: "task-detail",
          type: "detail_view",
          table: "tasks",
          fields: ["title"],
          actions: [{ id: "mark-done", name: "完了にする", set: { field: "status", value: "済" } }],
        },
      ],
      roles,
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

/**
 * **【`V8-M26`】第2引数を足した** —— **渡したときだけ、題材へ既定3役割の規則を足す**
 * (`apply-diff.ts` の自動付与と同じ規則。`withDefaultRoleRules` の doc を参照)。
 *
 * **渡さない呼び方は着手前と1バイトも変わらない** —— **`manifest(roles)` をそのまま適用する。**
 * **本ファイルの主題は「面そのもの」なので、既定を閉じたことを測る検査には渡さない。**
 */
async function boot(roles: unknown[], defaults?: DefaultRoleRuleOptions): Promise<void> {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-role-rules-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "面の店", { app_id: APP_ID });
  } finally {
    store.close();
  }
  const base = manifest(roles);
  const applied = applyManifest(
    dataRoot,
    APP_ID,
    defaults === undefined ? base : withDefaultRoleRules(base, defaults),
  );
  expect(applied.valid).toBe(true);
  app = createServerApp({ dataRoot });
}

beforeEach(async () => {
  await boot(RULED_ROLES);
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function req(
  cookie: string | undefined,
  method: string,
  path: string,
  body?: unknown,
  extra?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = { origin: TEST_ORIGIN, ...(extra ?? {}) };
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

function session(role: "owner" | "editor" | "viewer") {
  return seedSession(dataRoot, APP_ID, { role, username: `${role}-${Math.random()}` });
}

const ORDERS = `/api/apps/${APP_ID}/tables/orders/records`;
const NOTES = `/api/apps/${APP_ID}/tables/notes/records`;
const TASKS = `/api/apps/${APP_ID}/tables/tasks/records`;

async function created(cookie: string, path: string, values: unknown): Promise<string> {
  const res = await req(cookie, "POST", path, values);
  expect(res.status).toBe(201);
  return ((await res.json()) as { record: { _id: string } }).record._id;
}

async function listIds(cookie: string, path: string): Promise<string[]> {
  const res = await req(cookie, "GET", path);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { records: { _id: string }[] };
  return body.records.map((row) => row._id);
}

// --- (A) 対象 = 表(`J-G6`)------------------------------------------------------------

test("(A) 表: 規則を書いた役割は読み書き消せ、書いていない役割は1行も見えず書けない", async () => {
  const owner = session("owner");
  const editor = session("editor");

  // **規則を書いた側**(`owner`): 作成・一覧・単件・更新・削除がすべて通る。
  const id = await created(owner.cookie, ORDERS, { title: "梅干し", amount: 800 });
  expect(await listIds(owner.cookie, ORDERS)).toEqual([id]);
  const one = await req(owner.cookie, "GET", `${ORDERS}/${id}`);
  expect(one.status).toBe(200);

  // **書いていない側**(`editor`): 一覧は**空**、単件は 404、作成・更新・削除は 403。
  // **`editor` は運営ロールであり、面が無ければ今日どおり全部通る側である。**
  expect(await listIds(editor.cookie, ORDERS)).toEqual([]);
  expect((await req(editor.cookie, "GET", `${ORDERS}/${id}`)).status).toBe(404);
  expect((await req(editor.cookie, "POST", ORDERS, { title: "×" })).status).toBe(403);
  expect(
    (await req(editor.cookie, "PATCH", `${ORDERS}/${id}`, { title: "×" }, { "if-match": "x" }))
      .status,
  ).toBe(403);
  expect((await req(editor.cookie, "DELETE", `${ORDERS}/${id}`)).status).toBe(403);

  // **規則を1本も書いていない表(`notes`)は面の管轄外である**(裁定 `R-4`)——
  // **`editor` は今日どおり書けて読める。**
  //
  // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-58`。上の2行と下の旧2行は1バイトも消していない】**
  // **旧: `const noteId = await created(editor.cookie, NOTES, { body: "自由" });`**
  // **旧: `expect(await listIds(editor.cookie, NOTES)).toEqual([noteId]);`**
  //
  // **既定が「閉じる」側へ倒れた** —— **規則を1本も名指ししていない表は、今日は
  // どの役割にも開かない。** **`editor` も `owner` も作成は 403、一覧は空である。**
  // **【誇張しない】これは `notes` に限った話ではない** —— **差分(`add_table`)を通した
  // 実アプリには `apply-diff.ts` の自動付与で既定3役割の規則が入るので、この形になるのは
  // 「差分を1度も通していない題材」だけである。**
  expect((await req(editor.cookie, "POST", NOTES, { body: "自由" })).status).toBe(403);
  expect((await req(owner.cookie, "POST", NOTES, { body: "自由" })).status).toBe(403);
  expect(await listIds(editor.cookie, NOTES)).toEqual([]);
});

// --- (B) 対象 = 項目(`J-G7`)----------------------------------------------------------

test("(B) 項目: 規則を書いた役割にだけ値が返り、書いていない役割は値を書けない", async () => {
  // **【`V8-M26`】この検査の主題は「項目の規則」である** —— **表の層で止まってしまうと
  // 項目の層を1バイトも測れない。** **そこで `notes` にだけ既定3役割の表の規則を足す**
  // (`orders` / `tasks` と画面・ボタンには1本も足さない = 面を閉じたまま残す)。
  // **項目(`field`)の規則は1本も足していない** —— **足すと主題が消える。**
  await rm(dataRoot, { recursive: true, force: true });
  await boot(RULED_ROLES, { skipTables: ["orders", "tasks"], skipAllViews: true });
  const owner = session("owner");
  const editor = session("editor");

  const noteId = await created(owner.cookie, NOTES, { body: "本文", memo: "運営だけ" });

  // **読取** —— `owner` には `memo` が返り、`editor` の応答からはキーごと落ちる。
  const ownerOne = (await (await req(owner.cookie, "GET", `${NOTES}/${noteId}`)).json()) as {
    record: Record<string, unknown>;
  };
  expect(Object.keys(ownerOne.record)).toContain("memo");
  const editorOne = (await (await req(editor.cookie, "GET", `${NOTES}/${noteId}`)).json()) as {
    record: Record<string, unknown>;
  };
  expect(Object.keys(editorOne.record)).not.toContain("memo");
  // **規則の無い項目(`body`)は誰からも落ちない。**
  expect(Object.keys(editorOne.record)).toContain("body");

  // **一覧の応答でも同じように落ちる**(経路が割れていない)。
  const editorList = (await (await req(editor.cookie, "GET", NOTES)).json()) as {
    records: Record<string, unknown>[];
  };
  expect(Object.keys(editorList.records[0] as Record<string, unknown>)).not.toContain("memo");

  // **書込** —— `editor` が `memo` を書くと 403、`body` だけなら今日どおり通る。
  expect((await req(editor.cookie, "POST", NOTES, { body: "b", memo: "×" })).status).toBe(403);
  expect((await req(editor.cookie, "POST", NOTES, { body: "b" })).status).toBe(201);
});

// --- (C) 対象 = 画面(`J-G8`)----------------------------------------------------------

test("(C) 画面: 規則を書いた役割だけが `?view=` を名乗れる", async () => {
  const owner = session("owner");
  const editor = session("editor");

  expect((await req(owner.cookie, "GET", `${NOTES}?view=note-list`)).status).toBe(200);
  expect((await req(editor.cookie, "GET", `${NOTES}?view=note-list`)).status).toBe(403);

  // **規則を1本も書いていない画面(`order-list`)は面の管轄外である。**
  // **ただし `orders` は表の規則で閉じているので `editor` の一覧は空になる**
  // (画面の層で止まったのではない)。
  //
  // **【`V8-M26`。ユーザ決定 `D-V8-45`。上の3行と下の旧1行は1バイトも消していない】**
  // **旧: `expect((await req(editor.cookie, "GET", `${ORDERS}?view=order-list`)).status).toBe(200);`**
  //
  // **今日は画面も既定で閉じる** —— **`order-list` は誰の規則にも名指しされていないので、
  // 名乗った時点で 403 になる。** **止めているのは画面の層である**(表の層ではない)。
  expect((await req(editor.cookie, "GET", `${ORDERS}?view=order-list`)).status).toBe(403);
  // **`owner` も同じである** —— **「運営だから通る」分岐は1本も無い。**
  expect((await req(owner.cookie, "GET", `${ORDERS}?view=order-list`)).status).toBe(403);
});

// --- (D) 対象 = ボタン(`J-G9`)--------------------------------------------------------

test("(D) ボタン: 規則を書いた役割だけが、そのボタンが書く表を更新できる", async () => {
  // **【`V8-M26`】この検査の主題は「ボタンの規則」である** —— **表の層で止まると
  // ボタンの層を1バイトも測れない。** **`tasks` にだけ既定3役割の表の規則を足す。**
  // **画面とボタンには1本も足さない**(`skipAllViews`)—— **足すと `editor` にも
  // `mark-done` の規則が入ってしまい、主題が消える。**
  await rm(dataRoot, { recursive: true, force: true });
  await boot(RULED_ROLES, { skipTables: ["orders", "notes"], skipAllViews: true });
  const owner = session("owner");
  const editor = session("editor");

  // `tasks` は表の規則を1本も持たない —— **止めるのはボタンの規則だけである。**
  // **【`V8-M26` による訂正。上の1行は1バイトも消していない】** **今日の `tasks` は
  // 既定3役割の表の規則を持つ**(上で足した)——**`editor` は表の層を通り、
  // ボタンの層だけで止まる。** **測っているものは着手前と同じである。**
  const taskId = await created(editor.cookie, TASKS, { title: "掃除" });

  // **更新の壁**: `mark-done` は `set` 形なので、`task-detail` の表(`tasks`)の**更新**に壁が立つ。
  const editorPatch = await req(
    editor.cookie,
    "PATCH",
    `${TASKS}/${taskId}`,
    { status: "済" },
    { "if-match": "x" },
  );
  expect(editorPatch.status).toBe(403);

  // **`owner` は同じ更新が通る**(版が合わないので 409/412 系にはなるが 403 にはならない)。
  const ownerRead = await req(owner.cookie, "GET", `${TASKS}/${taskId}`);
  const etag = ownerRead.headers.get("etag") as string;
  const ownerPatch = await req(
    owner.cookie,
    "PATCH",
    `${TASKS}/${taskId}`,
    { status: "済" },
    { "if-match": etag },
  );
  expect(ownerPatch.status).toBe(200);
});

// --- (E) 完了条件 (iv) / 裁定 `N-2`: 宣言0件のアプリは着手前と同じ ----------------------
//
// **【`V8-M26`。ユーザ決定 `D-V8-65`。旧の題も旧の期待値も1バイトも消していない】**
//
// **旧の題(逐語)**: 「(E) 規則を1件も書いていないアプリでは、owner が API から読める行の
// 集合が全件と一致する」。
// **旧の前提(裁定 `R-4` / `N-2`)**: 「**宣言0件のアプリでは面が1バイトも掛からない**」。
//
// **`D-V8-65` がその前提を覆した** —— **役割を1つも宣言していないアプリ(既定3役割が
// 規則を1本も持たない状態を含む)は、表・画面・ボタンが閉じる。**
// **項目(`field`)だけは今日どおり開いている**(台帳 `T-G1b` = 却下 / `D-V8-58`)。
// **したがってこの `test()` は「着手前と同じであること」ではなく「どう変わったか」を固定する。**

test("(E) 規則を1件も書いていないアプリでは、表・画面・ボタンが閉じ、項目だけが開いたまま", async () => {
  // **「既定の役割定義だけがある状態」を「宣言0件」と呼ぶ**(発注書の逐語)。
  await rm(dataRoot, { recursive: true, force: true });
  await boot(DEFAULTS);
  const owner = session("owner");
  const editor = session("editor");

  // **旧: `const ids = [await created(owner.cookie, ORDERS, { title: "A" }), … 3件];`**
  // **今日: `owner` でも作成が 403 である** —— **面が表を閉じている。**
  // **「運営だから通る」分岐は1本も無い**(`editor` も同じ)。
  expect((await req(owner.cookie, "POST", ORDERS, { title: "A" })).status).toBe(403);
  expect((await req(editor.cookie, "POST", ORDERS, { title: "A" })).status).toBe(403);

  // **着手前(`ce14c8b`)の `owner` が読めたのは「その表の全行」である** ——
  // **面が1バイトも掛からないので、今日も同じ集合が返る。**
  // **旧: `expect((await listIds(owner.cookie, ORDERS)).sort()).toEqual([...ids].sort());`**
  // **旧: `expect((await listIds(editor.cookie, ORDERS)).sort()).toEqual([...ids].sort());`**
  // **今日: 一覧は 200 のまま空である** —— **403 にはしない**(`ADR-0305` 限定11。
  // **一覧は応答から落とす**)。
  expect(await listIds(owner.cookie, ORDERS)).toEqual([]);
  expect(await listIds(editor.cookie, ORDERS)).toEqual([]);

  // **項目も1つも落ちない。画面も名乗れる。** **`editor` も着手前どおりである。**
  // **旧: `const one = (await (await req(owner.cookie, "GET", `${ORDERS}/${ids[0]}`)).json()) …`**
  // **旧: `expect(Object.keys(one.record)).toContain("title");`**
  // **旧: `expect((await req(owner.cookie, "GET", `${ORDERS}?view=order-list`)).status).toBe(200);`**
  // **今日: 行を1件も作れないので「単件が 404 になること」はここでは測れない**
  // (**単件の 404 は (A) が持っている**)。**画面は名乗った時点で 403 である。**
  expect((await req(owner.cookie, "GET", `${ORDERS}?view=order-list`)).status).toBe(403);

  // **判定そのものも「管轄外」を返す**(4対象すべて)。
  // **旧: 4対象すべてについて `governed === false` / `allowed === true` / `blockedBy === null`。**
  // **今日: 表・画面・ボタンの3対象が閉じる。** **4対象のうち3対象である**(全部ではない)。
  const m = manifest(DEFAULTS);
  for (const target of [
    { target: "table", table: "orders" },
    { target: "view", view: "note-list" },
    { target: "action", view: "task-detail", action: "mark-done" },
  ] as const) {
    const decision = judgeRoleAccess({ manifest: m, roles: ["owner"], target, verb: "read" });
    expect(decision).toEqual({
      allowed: false,
      governed: true,
      blockedBy: "role",
      conditional: false,
    });
  }
  // **項目(`field`)だけは旧の期待値のままである** —— **1バイトも変えていない。**
  const field = judgeRoleAccess({
    manifest: m,
    roles: ["owner"],
    target: { target: "field", table: "notes", field: "memo" },
    verb: "read",
  });
  expect(field.governed).toBe(false);
  expect(field.allowed).toBe(true);
  expect(field.blockedBy).toBeNull();
});

// --- (F) 裁定 `N-13`: 止めたのがどちらの層かを名指しできる -------------------------------

test("(F) 判定は「止めたのはどちらの層か」を名指しする(面 / 点)", () => {
  const m = manifest(RULED_ROLES);
  const target = { target: "table", table: "orders" } as const;

  // **面が止めたとき** —— `blockedBy` は `"role"`。
  const blocked = judgeRoleAccess({ manifest: m, roles: ["editor"], target, verb: "read" });
  expect(blocked.allowed).toBe(false);
  expect(blocked.blockedBy).toBe("role");
  expect(blocked.governed).toBe(true);

  // **面が通したとき** —— `blockedBy` は `null`。
  const passed = judgeRoleAccess({ manifest: m, roles: ["owner"], target, verb: "read" });
  expect(passed.allowed).toBe(true);
  expect(passed.blockedBy).toBeNull();

  // --- 面と点の合成 -----------------------------------------------------------------------
  //
  // **【`V8-M19`(`D-V8-23` / `J-G18` / 裁定 `R-15-2`)による更新。旧文を1バイトも消していない】**
  //
  // **旧のコメント(逐語)**: 「**面と点の合成**(`V8-M17` の時点では **AND**。
  // `V8-M19` が OR に変える)。」
  // **旧の期待値(逐語)**:
  //   `combineRoleAndGrantAccess({ role: passed, grant: undefined, verb: "read" })`
  //     → `{ allowed: true,  blockedBy: [] }`
  //   `combineRoleAndGrantAccess({ role: passed, grant: {read:false,…}, verb: "read" })`
  //     → `{ allowed: false, blockedBy: ["grant"] }`
  //   `combineRoleAndGrantAccess({ role: blocked, grant: {read:true,…},  verb: "read" })`
  //     → `{ allowed: false, blockedBy: ["role"] }`
  //   `combineRoleAndGrantAccess({ role: blocked, grant: {read:false,…}, verb: "read" })`
  //     → `{ allowed: false, blockedBy: ["role", "grant"] }`(**この1本だけは今日も同じ**)
  //
  // **今日は `OR` である** —— **どちらかが通せば通る**(`D-V8-23` のユーザ決定)。
  // **`blockedBy` の意味も広がった**: **「その層だけを見れば通さなかった層」であり、
  // `allowed` が真でも空でないことがある。** **これが「止めた層を名指しできる」ことを
  // `OR` のもとでも保つ形である**(裁定 `N-13` / `R-5`)。
  // **【禁止の履行】「`OR` なので安全側に倒れる」とは1文字も書いていない** ——
  // **`OR` は見える側に倒れる。**
  expect(combineRoleAndGrantAccess({ role: passed, grant: undefined, verb: "read" })).toEqual({
    allowed: true,
    blockedBy: [],
  });
  // =====================================================================================
  // **【2026-09-11 追記(`V18-M2-T04`。`PM-G8` / `ADR-0437` / ユーザ決定 `D-V18-18`)。
  // 直下の1本の期待値を打ち直した。旧文を1バイトも消していない】**
  //
  //     旧: ).toEqual({ allowed: true, blockedBy: ["grant"] });
  //     新: ).toEqual({ allowed: false, blockedBy: ["grant"] });
  //
  // **なぜ期待値の側が今日の正でなくなったか** —— **`passed` は「条件(`when`)を1つも
  // 持たない規則だけが通した面」(`conditional: false`)であり、**読取**については
  // 点が管轄内のときに `OR` へ入らなくなったからである。**
  // **この検査の主題(止めた層を名指しできる)は1ミリも動いていない** ——
  // **`blockedBy` は `["grant"]` のままである**(**面だけを見れば通していた**の意味を保つ)。
  // **`V8-M19` が `AND` から `OR` へ変える前の値と同じ値に戻った**(上の「旧の期待値」の
  // 2本目の逐語と同じ)。 **戻したのは**読取の1動詞だけ**であり、`AND` へ戻したのではない**
  // —— **書込・削除は今日も `OR` である**(`D-V18-17`)。
  //
  // **【`D-V18-18` はこの呼び方では効かない。隠さない】** **`passed` は `roles: ["owner"]`
  // から作った面だが、`RoleAccessDecision` は「誰が要求したか」を1バイトも持っていない。**
  // **運営者の例外は、合成に `roles` を渡したときだけ効く**(製品の読取経路では
  // `resolveCombinedRecordAccess` が渡している)。 **その形を直後の1本で撃つ。**
  expect(
    combineRoleAndGrantAccess({
      role: passed,
      grant: { read: false, write: false, delete: false },
      verb: "read",
    }),
  ).toEqual({ allowed: false, blockedBy: ["grant"] });
  // **【`V18-M2-T04` が足した1本】** **同じ入力に `roles: ["owner"]` を添えると、運営者は
  // 今日どおり通る**(`D-V18-18`)。 **`blockedBy` は1ビットも変わらない。**
  expect(
    combineRoleAndGrantAccess({
      role: passed,
      grant: { read: false, write: false, delete: false },
      verb: "read",
      roles: ["owner"],
    }),
  ).toEqual({ allowed: true, blockedBy: ["grant"] });
  expect(
    combineRoleAndGrantAccess({
      role: blocked,
      grant: { read: true, write: true, delete: true },
      verb: "read",
    }),
  ).toEqual({ allowed: true, blockedBy: ["role"] });
  expect(
    combineRoleAndGrantAccess({
      role: blocked,
      grant: { read: false, write: false, delete: false },
      verb: "read",
    }),
  ).toEqual({ allowed: false, blockedBy: ["role", "grant"] });
});

// --- (G) 多重ロール(`J-G3` の和集合)---------------------------------------------------

test("(G) 2本目の役割で規則が届く(実効ロール集合の和集合1本)", async () => {
  const both = seedSession(dataRoot, APP_ID, {
    role: "editor",
    username: `both-${Math.random()}`,
    grants: ["owner"],
  });
  const owner = session("owner");
  const id = await created(owner.cookie, ORDERS, { title: "梅干し" });
  // **`editor` 単独では見えない行が、`owner` を1本足すと見える。**
  expect(await listIds(both.cookie, ORDERS)).toEqual([id]);
});

// --- (H) 未ログイン(`J-G11`)-----------------------------------------------------------

test("(H) 未ログインは `anonymous` として判定される", () => {
  const m = manifest([
    ...DEFAULTS,
    { id: "anonymous", rules: [{ target: "view", view: "note-list", can: ["read"] }] },
  ]);
  expect(
    judgeRoleAccess({
      manifest: m,
      roles: null,
      target: { target: "view", view: "note-list" },
      verb: "read",
    }).allowed,
  ).toBe(true);
  // **規則を書いた対象なので、`anonymous` に書かれていない役割は止まる。**
  expect(
    judgeRoleAccess({
      manifest: m,
      roles: ["editor"],
      target: { target: "view", view: "note-list" },
      verb: "read",
    }).allowed,
  ).toBe(false);
});

// --- (I) 完了条件 (v): 差分から宣言を書き、`undo` で戻せる -------------------------------

test("(I) 差分で規則を書くと即座に効き、undo で戻すと元どおり読める(実 HTTP + 本物の SQLite)", async () => {
  await rm(dataRoot, { recursive: true, force: true });
  // **【`V8-M26`】この検査の主題は「差分で規則を書くと即座に効き、`undo` で戻る」ことである。**
  // **既定が閉じたので、着手直後の状態を実アプリと同じにするために既定3役割の規則を足す**
  // (**`add_table` / `add_view` を通したアプリには `apply-diff.ts` の自動付与で必ず入る**)。
  // **旧: `await boot(DEFAULTS);`**(= **規則0本のまま**)。
  await boot(DEFAULTS, {});
  const owner = session("owner");
  const editor = session("editor");
  const id = await created(owner.cookie, ORDERS, { title: "梅干し" });

  // **着手直後**: 規則が1本も無いので `editor` にも見える。
  // **【`V8-M26` による訂正。上の1行は1バイトも消していない】** **今日の「着手直後」は
  // 「既定3役割の規則が入っている」状態である** —— **見える理由が「規則が無い」から
  // 「既定の規則が在る」に変わった。** **見えること自体は着手前と同じである。**
  expect(await listIds(editor.cookie, ORDERS)).toEqual([id]);

  // **差分で規則を書く**(`set_roles` は全体差し替え)。
  const applied = await req(owner.cookie, "POST", `/api/apps/${APP_ID}/diffs`, {
    diff_id: "d-role-rules-1",
    intent: "注文表を持ち主だけに閉じる",
    operations: [{ op: "set_roles", roles: RULED_ROLES }],
  });
  expect(applied.status).toBe(201);

  // **即座に効く** —— `editor` の一覧が空になり、`owner` は今日どおり読める。
  expect(await listIds(editor.cookie, ORDERS)).toEqual([]);
  expect(await listIds(owner.cookie, ORDERS)).toEqual([id]);

  // **`undo` で戻る。**
  const undone = await req(owner.cookie, "POST", `/api/apps/${APP_ID}/undo`);
  expect(undone.status).toBe(200);

  // **【戻したときに何が起こるか】** **規則が消えるので面は管轄外に戻り、
  // `editor` の一覧に行がまた並ぶ。** **行そのものは1件も消えず、1件も増えていない** ——
  // **`undo` が戻したのは宣言であって、行ではない。**
  // **【`V8-M26` による訂正。上の3行は1バイトも消していない】** **戻る先は「管轄外」では
  // なく「既定3役割の規則が入った状態」である** —— **`editor` の一覧に行がまた並ぶことは
  // 着手前と同じだが、並ぶ理由は既定の規則である。**
  expect(await listIds(editor.cookie, ORDERS)).toEqual([id]);
  expect(await listIds(owner.cookie, ORDERS)).toEqual([id]);
});

// --- (J) ファイル配信(`GET /files/:file_id`)-------------------------------------------

test("(J) 表の規則で閉じた表の行が参照する画像は、書いていない役割には配信されない", async () => {
  const owner = session("owner");
  const editor = session("editor");

  // 画像を1枚上げて、`orders`(面が閉じている表)の行から参照させる。
  const form = new FormData();
  form.set(
    "file",
    new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])]),
    "photo.png",
  );
  const uploaded = await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/files`, {
      method: "POST",
      headers: { cookie: owner.cookie, origin: TEST_ORIGIN },
      body: form,
    }),
  );
  expect(uploaded.status).toBe(201);
  const fileId = ((await uploaded.json()) as { file_id: string }).file_id;
  await created(owner.cookie, ORDERS, { title: "梅干し", photo: fileId });

  const deliver = async (cookie: string): Promise<number> =>
    (
      await app.request(
        new Request(`http://localhost/api/apps/${APP_ID}/files/${fileId}`, { headers: { cookie } }),
      )
    ).status;

  // **規則を書いた側には今日どおり配信される。書いていない側には 404。**
  // **【この 404 は存在秘匿である】** —— **403 にすると「その画像が在る」ことが漏れる。**
  expect(await deliver(owner.cookie)).toBe(200);
  expect(await deliver(editor.cookie)).toBe(404);
});
