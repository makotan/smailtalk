/**
 * **`V8-M26-T03`(サーバ層)—— 面(役割に束ねた権限)の**既定を「閉じる」側へ倒す**ことの検査。**
 *
 * ユーザ決定 `D-V8-45` / `D-V8-58` / `D-V8-65`、台帳 `T-G1b`(= 却下)/ `T-G26a`、
 * `ADR-0305` 限定11(**一覧は応答から落とす / 単件は 404**)が仕様である。
 *
 * ## 着手前(`287c17f`)の姿 —— **旧のふるまいを逐語で残す**
 *
 * **`src/server/owner-scope.ts` の `judgeRoleAccess` は、**
 * **(1) アプリが役割を1つも宣言していないとき、(2) その対象を名指しした規則が1本も無いとき、**
 * **`UNGOVERNED_ROLE_ACCESS`(`allowed: true` / `governed: false`)を返していた** ——
 * **つまり「規則を書いていない対象は全許可」だった。**
 *
 * ## 今日の姿(`V8-M26-T03`)
 *
 * - **閉じる対象は `table` / `view` / `action` の3つちょうどである**(`D-V8-45` / `D-V8-58`)。
 * - **`field`(項目)は閉じない**(`T-G1b` = 却下 / `D-V8-58`)——
 *   **項目は今日どおり「管轄外なら通す」のままである。**
 * - **役割を1つも宣言していないアプリも閉じる**(`D-V8-65`)。**ただしそこでも `field` は
 *   閉じない。**
 * - **未ログイン(`roles: null` → 主体 `anonymous`)にも同じ向きが及ぶ**(`T-G26a`)。
 * - **閉じたときは `governed: true` を返す** —— **`combineRoleAndGrantAccess` は
 *   「両方が管轄内なら `OR`」なので、**v7 の行ごとの付与(点)は今日どおり効き続ける。**
 *   **面と点の `OR` を `AND` へ戻していない**(明文の禁止)。
 *
 * ## この検査が固定していないこと(**誇張しない**)
 *
 * - **「運営か否か」の層(`nonAdminTableAccess` / `hasAdminWriteRole`)は1バイトも触っていない。**
 *   **本ファイルはその層より内側の面の判定だけを測る。**
 * - **既定3役割への自動付与(表を作ると持ち主の規則が自動で入る)は `T04` の担当である** ——
 *   **今日は自動で入らないので、下の (a)〜(d) は「持ち主(`owner`)でも閉じる」形で出る。**
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { judgeRoleAccess } from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN } from "./test-helpers.ts";

const APP_ID = "role-default-closed";

const PERMISSIONS = [
  { id: "keeper", name: "管理", read: true, write: true, delete: true },
  { id: "reader", name: "閲覧", read: true, write: false, delete: false },
];

/**
 * **仕込みのあいだだけ使う「全部開いた」宣言**(段1)。
 *
 * **既定を閉じたので、行を1行も作れないままでは (a)〜(d) を測れない** ——
 * **そこで段1でこの宣言を当てて行を作り、段2で下の {@link CLOSED_ROLES} に差し替える。**
 */
const OPEN_ROLES = [
  {
    id: "owner",
    name: "持ち主",
    rules: [
      // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
      { target: "app", can: ["write"] },
      { target: "role", can: ["write"] },
      { target: "table", table: "orders", can: ["read", "write", "delete"] },
      { target: "table", table: "notes", can: ["read", "write", "delete"] },
      { target: "table", table: "shared", can: ["read", "write", "delete"] },
      { target: "table", table: "book_team", can: ["read", "write", "delete"] },
      { target: "table", table: "book_member", can: ["read", "write", "delete"] },
      { target: "table", table: "shared_grant", can: ["read", "write", "delete"] },
      { target: "view", view: "order-list", can: ["read"] },
      { target: "view", view: "note-list", can: ["read"] },
      { target: "action", view: "order-list", action: "ship-admin", can: ["read"] },
    ],
  },
  { id: "editor", name: "編集者" },
  { id: "viewer", name: "閲覧者" },
];

/**
 * **測るときの宣言**(段2)。**書いてある規則は2本だけである。**
 *
 * - **`notes`(表)の読み書き消し** … (e) が「項目は閉じない」を測るための土台。
 * - **`order-list`(画面)の読取** … (d) が**ボタンの層だけ**を測れるようにするための土台
 *   (画面で止まってしまうとボタンの判定に到達しない)。
 *
 * **`orders`(表)・`note-list`(画面)・`ship-admin`(ボタン)には1本も書いていない。**
 */
const CLOSED_ROLES = [
  {
    id: "owner",
    name: "持ち主",
    rules: [
      // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
      { target: "app", can: ["write"] },
      { target: "role", can: ["write"] },
      { target: "table", table: "notes", can: ["read", "write", "delete"] },
      { target: "view", view: "order-list", can: ["read"] },
    ],
  },
  { id: "editor", name: "編集者" },
  { id: "viewer", name: "閲覧者" },
];

function manifest(roles: unknown[] | undefined): Manifest {
  const app: Record<string, unknown> = {
    id: APP_ID,
    name: "既定を閉じた店",
    tables: [
      {
        id: "orders",
        name: "注文",
        fields: [
          { id: "title", name: "件名", type: "text", required: true },
          { id: "state", name: "状態", type: "text" },
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
        id: "shared",
        name: "共有物",
        fields: [{ id: "title", name: "件名", type: "text", required: true }],
        access_control: {
          enabled: true,
          permissions: PERMISSIONS,
          creator_permission: "keeper",
          grant: {
            table: "shared_grant",
            target: "item",
            member: "member",
            group: "team",
            permission: "permission",
          },
          members: { table: "book_member", account: "account", group: "team" },
          groups: { table: "book_team" },
        },
      },
      { id: "book_team", name: "班", fields: [{ id: "title", name: "名前", type: "text" }] },
      {
        id: "book_member",
        name: "参加者",
        fields: [
          { id: "account", name: "アカウント", type: "text" },
          { id: "team", name: "班", type: "reference", reference_table: "book_team" },
        ],
      },
      {
        id: "shared_grant",
        name: "付与",
        fields: [
          { id: "item", name: "共有物", type: "reference", reference_table: "shared" },
          { id: "member", name: "人", type: "reference", reference_table: "book_member" },
          { id: "team", name: "班", type: "reference", reference_table: "book_team" },
          { id: "permission", name: "権限", type: "select", options: ["keeper", "reader"] },
        ],
      },
      { id: "notice", name: "通知", fields: [{ id: "title", name: "件名", type: "text" }] },
      {
        id: "wf_runs",
        name: "実行履歴",
        fields: [
          { id: "ran_at", name: "実行時刻", type: "date" },
          { id: "workflow", name: "ワークフロー", type: "text" },
          { id: "trigger_type", name: "きっかけ", type: "text" },
          { id: "status", name: "結果", type: "text" },
          { id: "error", name: "エラー", type: "long_text" },
        ],
      },
    ],
    views: [
      {
        id: "order-list",
        type: "list_view",
        table: "orders",
        columns: ["title", "state"],
        actions: [{ id: "ship-admin", run: "ship", name: "発送する" }],
      },
      { id: "note-list", type: "list_view", table: "notes", columns: ["body"] },
    ],
    workflows: [
      {
        id: "ship",
        name: "発送する",
        trigger: { type: "manual", table: "orders" },
        actions: [{ action: "create_record", table: "notice", values: { title: "発送しました" } }],
        history_table: "wf_runs",
      },
    ],
  };
  if (roles !== undefined) {
    app.roles = roles;
  }
  return { app } as unknown as Manifest;
}

let dataRoot: string | undefined;
let app: ReturnType<typeof createServerApp>;

async function bootOpen(): Promise<void> {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-role-default-closed-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "既定を閉じた店", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, manifest(OPEN_ROLES)).valid).toBe(true);
  app = createServerApp({ dataRoot });
}

/** 段2 —— **宣言だけを差し替える。行は1行も消さない。** */
function reapply(roles: unknown[] | undefined): void {
  expect(applyManifest(dataRoot as string, APP_ID, manifest(roles)).valid).toBe(true);
  app = createServerApp({ dataRoot: dataRoot as string });
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

const records = (table: string) => `/api/apps/${APP_ID}/tables/${table}/records`;

function session(role: "owner" | "editor" | "viewer") {
  return seedSession(dataRoot as string, APP_ID, {
    role,
    username: `${role}-${Math.random().toString(36).slice(2, 10)}`,
  });
}

async function create(
  cookie: string,
  table: string,
  values: unknown,
): Promise<Record<string, unknown>> {
  const res = await req(cookie, "POST", records(table), values);
  expect(res.status).toBe(201);
  return ((await res.json()) as { record: Record<string, unknown> }).record;
}

async function listIds(cookie: string, table: string): Promise<string[]> {
  const res = await req(cookie, "GET", records(table));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { records: { _id: string }[] };
  return body.records.map((row) => row._id);
}

/** 段1で行を作り、段2の宣言へ差し替える。 */
async function seeded(closedRoles: unknown[] | undefined) {
  await bootOpen();
  const owner = session("owner");
  const editor = session("editor");
  const order = await create(owner.cookie, "orders", { title: "梅干し" });
  const note = await create(owner.cookie, "notes", { body: "本文", memo: "運営メモ" });
  const teamE = await create(owner.cookie, "book_team", { title: "編集班" });
  const teamO = await create(owner.cookie, "book_team", { title: "運営班" });
  await create(owner.cookie, "book_member", { account: owner.userId, team: teamO._id });
  await create(owner.cookie, "book_member", { account: editor.userId, team: teamE._id });
  const item = await create(owner.cookie, "shared", { title: "配った物" });
  await create(owner.cookie, "shared_grant", {
    item: item._id,
    team: teamE._id,
    permission: "reader",
  });
  reapply(closedRoles);
  return { owner, editor, order, note, item };
}

// --- (a) 規則を1本も書いていない**表**の一覧は、空一覧で返る ----------------------------

test("(a) 規則を1本も書いていない表の一覧は、空一覧で返る(403 にしない。ADR-0305 限定11)", async () => {
  const s = await seeded(CLOSED_ROLES);
  // **`orders` には規則が1本も無い** —— **持ち主(`owner`)でも1行も見えない。**
  // **【誇張しない】これは「運営だから見える」分岐が面に無いことの帰結であり、
  // `T04`(既定3役割への自動付与)が入るまでこの向きである。**
  expect(await listIds(s.owner.cookie, "orders")).toEqual([]);
  expect(await listIds(s.editor.cookie, "orders")).toEqual([]);
  // **判定そのものも「管轄内で通さない」を返す。**
  expect(
    judgeRoleAccess({
      manifest: manifest(CLOSED_ROLES),
      roles: ["owner"],
      target: { target: "table", table: "orders" },
      verb: "read",
    }),
  ).toEqual({ allowed: false, governed: true, blockedBy: "role", conditional: false });
  // **未ログイン(`roles: null` → 主体 `anonymous`)にも同じ向きが及ぶ**(`T-G26a`)。
  expect(
    judgeRoleAccess({
      manifest: manifest(CLOSED_ROLES),
      roles: null,
      target: { target: "table", table: "orders" },
      verb: "read",
    }).allowed,
  ).toBe(false);
});

// --- (b) 同じ表の**単件**は 404 -------------------------------------------------------

test("(b) 規則を1本も書いていない表の単件は 404(403 にしない。ADR-0305 限定11)", async () => {
  const s = await seeded(CLOSED_ROLES);
  const path = `${records("orders")}/${s.order._id as string}`;
  expect((await req(s.owner.cookie, "GET", path)).status).toBe(404);
  expect((await req(s.editor.cookie, "GET", path)).status).toBe(404);
});

// --- (c) 規則を1本も書いていない**画面**は 403 -----------------------------------------

test("(c) 規則を1本も書いていない画面は 403", async () => {
  const s = await seeded(CLOSED_ROLES);
  // **表(`notes`)は読める** —— **止めているのは画面の層だけである。**
  expect((await req(s.owner.cookie, "GET", records("notes"))).status).toBe(200);
  expect((await req(s.owner.cookie, "GET", `${records("notes")}?view=note-list`)).status).toBe(403);
  // **手動起動の入口も同じ向きで止まる。**
  const manual = await req(
    s.owner.cookie,
    "POST",
    `/api/apps/${APP_ID}/views/note-list/actions/run?workflow=ship&record=${s.note._id as string}`,
  );
  expect(manual.status).toBe(403);
});

// --- (d) 規則を1本も書いていない**ボタン**は 403 ---------------------------------------

test("(d) 規則を1本も書いていないボタンは 403(画面は開ける = ボタンの層だけで止まる)", async () => {
  const s = await seeded(CLOSED_ROLES);
  // **画面(`order-list`)には読取の規則を書いてある** —— **画面の層では止まらない。**
  expect(
    judgeRoleAccess({
      manifest: manifest(CLOSED_ROLES),
      roles: ["owner"],
      target: { target: "view", view: "order-list" },
      verb: "read",
    }).allowed,
  ).toBe(true);
  // **ボタン(`ship-admin`)には1本も書いていない** —— **403。**
  const res = await req(
    s.owner.cookie,
    "POST",
    `/api/apps/${APP_ID}/views/order-list/actions/run?workflow=ship&record=${s.order._id as string}`,
  );
  expect(res.status).toBe(403);
  expect(
    judgeRoleAccess({
      manifest: manifest(CLOSED_ROLES),
      roles: ["owner"],
      target: { target: "action", view: "order-list", action: "ship-admin" },
      verb: "read",
    }),
  ).toEqual({ allowed: false, governed: true, blockedBy: "role", conditional: false });
});

// --- (e) **項目は閉じない**(`T-G1b` = 却下 / `D-V8-58`)---------------------------------

test("(e) 項目は閉じない —— 表に読取の規則を1本書けば、項目の規則が1本も無くても項目が読める", async () => {
  const s = await seeded(CLOSED_ROLES);
  const res = await req(s.owner.cookie, "GET", `${records("notes")}/${s.note._id as string}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { record: Record<string, unknown> };
  // **`memo` には項目の規則が1本も無い** —— **それでも値が返る。**
  expect(Object.keys(body.record)).toContain("memo");
  expect(body.record.memo).toBe("運営メモ");
  // **判定そのものも「管轄外(全許可)」のままである。**
  expect(
    judgeRoleAccess({
      manifest: manifest(CLOSED_ROLES),
      roles: ["owner"],
      target: { target: "field", table: "notes", field: "memo" },
      verb: "read",
    }),
  ).toEqual({ allowed: true, governed: false, blockedBy: null, conditional: false });
  // **項目の書込も同じ** —— **規則が1本も無い項目は書ける。**
  expect(
    judgeRoleAccess({
      manifest: manifest(CLOSED_ROLES),
      roles: ["owner"],
      target: { target: "field", table: "notes", field: "memo" },
      verb: "write",
    }).allowed,
  ).toBe(true);
  // **役割を1つも宣言していないアプリでも、項目は閉じない**(`D-V8-65` の適用範囲の限界)。
  expect(
    judgeRoleAccess({
      manifest: manifest(undefined),
      roles: ["owner"],
      target: { target: "field", table: "notes", field: "memo" },
      verb: "read",
    }),
  ).toEqual({ allowed: true, governed: false, blockedBy: null, conditional: false });
});

// --- (f) **役割を1つも宣言していないアプリ**でも同じ向き(`D-V8-65`)---------------------

test("(f) 役割を1つも宣言していないアプリでも、表・画面・ボタンは閉じる", async () => {
  const s = await seeded(undefined);
  // **表** —— 一覧は空、単件は 404。
  expect(await listIds(s.owner.cookie, "orders")).toEqual([]);
  expect(await listIds(s.owner.cookie, "notes")).toEqual([]);
  expect(
    (await req(s.owner.cookie, "GET", `${records("orders")}/${s.order._id as string}`)).status,
  ).toBe(404);
  // **画面** —— 403。
  expect((await req(s.owner.cookie, "GET", `${records("notes")}?view=note-list`)).status).toBe(403);
  // **ボタン** —— **判定は閉じている。** **HTTP の入口は画面の層で先に 403 になるので、
  // ボタンの層まで到達しない**(**誇張しない。到達しない層を「測った」とは書かない**)。
  const m = manifest(undefined);
  for (const target of [
    { target: "table", table: "orders" },
    { target: "view", view: "note-list" },
    { target: "action", view: "order-list", action: "ship-admin" },
  ] as const) {
    expect(judgeRoleAccess({ manifest: m, roles: ["owner"], target, verb: "read" })).toEqual({
      allowed: false,
      governed: true,
      blockedBy: "role",
      conditional: false,
    });
    // **未ログインにも同じ向きが及ぶ**(`T-G26a`)。
    expect(judgeRoleAccess({ manifest: m, roles: null, target, verb: "read" }).allowed).toBe(false);
  }
  expect((await req(s.owner.cookie, "GET", `${records("orders")}?view=order-list`)).status).toBe(
    403,
  );
});

// --- (g) **点(行ごとの付与)が開いていれば通る** —— `OR` が保たれている ------------------

test("(g) 面が閉じても、点(行ごとの付与)が開いていれば通る(OR を AND へ戻していない)", async () => {
  const s = await seeded(CLOSED_ROLES);
  // **`shared` には面の規則が1本も無い** —— **面は閉じている。**
  expect(
    judgeRoleAccess({
      manifest: manifest(CLOSED_ROLES),
      roles: ["editor"],
      target: { target: "table", table: "shared" },
      verb: "read",
    }),
  ).toEqual({ allowed: false, governed: true, blockedBy: "role", conditional: false });
  // **それでも、班に読取を配った行は `editor` に見える** —— **点が通しているからである。**
  expect(await listIds(s.editor.cookie, "shared")).toEqual([s.item._id as string]);
  const one = await req(s.editor.cookie, "GET", `${records("shared")}/${s.item._id as string}`);
  expect(one.status).toBe(200);
  // **点が1件も配られていない相手(`viewer`)には見えない。**
  const viewer = session("viewer");
  expect(await listIds(viewer.cookie, "shared")).toEqual([]);
});
