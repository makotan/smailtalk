/**
 * **マイページの「自分の記録」の読取 `GET /api/apps/:id/tables/:t/records?my_page=1`**
 * (`V22-M3-T04`。`ADR-0488` §Decision 1 の 5 / `ADR-0490` §Decision 1 の行2 / `ADR-0492`。
 * ユーザ決定 `D-V22-16` / `D-V22-19` / `D-V22-23` / `D-V22-24`)。
 *
 * **口は足さない。** 既存の一覧の口に `?my_page=1` を足す。 見ること(計画の (a)〜(k)):
 *
 *  - (a) 一般の人には自分の行だけが返り、持ち主が空の行は返らない
 *  - (b) 運営者(`owner`)にもマイページでは自分の行だけが返る。 `?my_page` を付けなければ今日どおり
 *  - (c) 読取の規則の条件に「自分」(`equals_current_user`)がある表
 *  - (d) `include` で足した表
 *  - (e) `exclude` した表・持ち主の分からない表・マイページの無いアプリは 400
 *  - (f) 未ログインは 401(未ログインに開いている表でも)
 *  - (g) 読めない役割は0件で、読める範囲が広がらない(画面名を名乗らない読取の壁も掛けたまま)
 *  - (h) 持ち主の列がその役割から隠されていれば 400
 *  - (i) `?view=` と同時なら 400
 *  - (j) `total` は絞った後の件数、`limit` / `offset` は絞った後に切る、新しい順(`_created_at` の降順)
 *  - (k) `GET /public` は変わらない
 *  - `D-V22-23`: 持ち主の列が2つある表は、どちらか一方でも自分なら載る
 *
 * **行の持ち主は SQL で直に書く**(`st_owner` は作った人に決まり、口からは他人の名前で書けないため)。
 * `_created_at` も SQL で1件ずつずらして書き、並びを決め打ちにする(同じミリ秒に作られた行の順を当てにしない)。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import {
  type SeededSession,
  seedSession,
  TEST_ORIGIN,
  withDefaultRoleRules,
} from "./test-helpers.ts";

const APP_ID = "mp";
const PLAIN_APP_ID = "nomp";
const OWNER = "st_owner";

type Row = Record<string, unknown> & { _id: string };
type ListBody = { records: Row[]; total: number };

function baseTables(): Manifest["app"]["tables"] {
  return [
    // (i) 個人の持ち主の列
    {
      id: "notes",
      name: "メモ帳",
      fields: [
        { id: "title", name: "題", type: "text" },
        { id: OWNER, name: "持ち主", type: "text" },
      ],
    },
    // (i) + (ii) —— 持ち主の列が2つ(D-V22-23)
    {
      id: "jobs",
      name: "仕事",
      fields: [
        { id: "title", name: "題", type: "text" },
        { id: OWNER, name: "持ち主", type: "text" },
        { id: "helper", name: "手伝い", type: "text" },
      ],
    },
    // (ii) 読取の規則の条件に「自分」
    {
      id: "tickets",
      name: "受付",
      fields: [
        { id: "title", name: "題", type: "text" },
        { id: "assignee", name: "担当", type: "text" },
      ],
    },
    // (iii) include(未ログインにも開いている)
    {
      id: "errands",
      name: "用事",
      fields: [
        { id: "title", name: "題", type: "text" },
        { id: "runner", name: "係", type: "text" },
      ],
    },
    // (iii) include、持ち主の列は member に隠す
    {
      id: "tasks",
      name: "作業",
      fields: [
        { id: "title", name: "題", type: "text" },
        { id: "handler", name: "受け持ち", type: "text" },
      ],
    },
    // exclude
    {
      id: "memo",
      name: "覚え書き",
      fields: [
        { id: "title", name: "題", type: "text" },
        { id: OWNER, name: "持ち主", type: "text" },
      ],
    },
    // 持ち主の分からない表
    { id: "plain", name: "素の表", fields: [{ id: "title", name: "題", type: "text" }] },
    // member が表を読めない
    {
      id: "secret",
      name: "秘密",
      fields: [
        { id: "title", name: "題", type: "text" },
        { id: OWNER, name: "持ち主", type: "text" },
      ],
    },
    // member は表を読めるが、この表の一覧画面を1つも使えない(画面名を名乗らない読取の壁)
    {
      id: "walled",
      name: "囲い",
      fields: [
        { id: "title", name: "題", type: "text" },
        { id: OWNER, name: "持ち主", type: "text" },
      ],
    },
    // 【V22-M3-T08a 中-1】include。 持ち主の列 runner は member には status=open の行でだけ見える(条件つきの項目の規則)
    {
      id: "shifts",
      name: "当番",
      fields: [
        { id: "title", name: "題", type: "text" },
        { id: "status", name: "状態", type: "text" },
        { id: "runner", name: "係", type: "text" },
      ],
    },
    // 【V22-M3-T08a 中-1】個人の持ち主の列。 member には status=open の行でだけ見える
    {
      id: "diary",
      name: "日誌",
      fields: [
        { id: "title", name: "題", type: "text" },
        { id: "status", name: "状態", type: "text" },
        { id: OWNER, name: "持ち主", type: "text" },
      ],
    },
  ];
}

function manifest(): Manifest {
  const m = {
    app: {
      id: APP_ID,
      name: "マイページの検体",
      tables: baseTables(),
      views: [
        {
          id: "notes_list",
          name: "メモ一覧",
          type: "list_view",
          table: "notes",
          columns: ["title"],
        },
        {
          id: "walled_list",
          name: "囲い一覧",
          type: "list_view",
          table: "walled",
          columns: ["title"],
        },
      ],
      roles: [
        {
          id: "owner",
          name: "運営",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            { target: "field", table: "tasks", field: "handler", can: ["read", "write"] },
            { target: "field", table: "shifts", field: "runner", can: ["read", "write"] },
            { target: "field", table: "diary", field: OWNER, can: ["read", "write"] },
          ],
        },
        {
          id: "member",
          name: "会員",
          rules: [
            { target: "table", table: "notes", can: ["read"] },
            { target: "table", table: "jobs", can: ["read"] },
            {
              target: "table",
              table: "tickets",
              can: ["read"],
              when: { field: "assignee", equals_current_user: true },
            },
            { target: "table", table: "errands", can: ["read"] },
            { target: "table", table: "tasks", can: ["read"] },
            { target: "table", table: "memo", can: ["read"] },
            { target: "table", table: "plain", can: ["read"] },
            { target: "table", table: "walled", can: ["read"] },
            { target: "view", view: "notes_list", can: ["read"] },
            { target: "table", table: "shifts", can: ["read"] },
            { target: "table", table: "diary", can: ["read"] },
            {
              target: "field",
              table: "shifts",
              field: "runner",
              can: ["read"],
              when: { field: "status", equals: "open" },
            },
            {
              target: "field",
              table: "diary",
              field: OWNER,
              can: ["read"],
              when: { field: "status", equals: "open" },
            },
          ],
        },
        // jobs の helper を (ii) にするための規則(閲覧者は自分が手伝いの行だけを読む)。
        {
          id: "viewer",
          name: "閲覧者",
          rules: [
            {
              target: "table",
              table: "jobs",
              can: ["read"],
              when: { field: "helper", equals_current_user: true },
            },
          ],
        },
        {
          id: "anonymous",
          name: "未ログイン",
          rules: [{ target: "table", table: "errands", can: ["read"] }],
        },
      ],
      workspace: {
        my_page: {
          tables: {
            exclude: ["memo"],
            include: [
              { table: "errands", owner_field: "runner" },
              { table: "tasks", owner_field: "handler" },
              { table: "shifts", owner_field: "runner" },
            ],
          },
        },
      },
    },
  } as unknown as Manifest;
  return withDefaultRoleRules(m);
}

function plainManifest(): Manifest {
  return withDefaultRoleRules({
    app: {
      id: PLAIN_APP_ID,
      name: "マイページの無い検体",
      tables: [baseTables()[0]],
      views: [],
    },
  } as unknown as Manifest);
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
let admin: SeededSession;
let admin2: SeededSession;
let member: SeededSession;
let member2: SeededSession;
let clock = 0;

function dbPath(appId: string): string {
  return join(dataRoot, "apps", appId, "app.sqlite");
}

/** 行を1件、SQL で直に書き込む(`_created_at` は呼ぶたびに1秒ずつ進める)。 */
function put(table: string, values: Record<string, string | null>, appId = APP_ID): string {
  clock += 1;
  const id = `${table}-${clock}`;
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, clock)).toISOString();
  const columns = ["_id", "_created_at", "_updated_at", ...Object.keys(values)];
  const db = new Database(dbPath(appId), { readwrite: true, create: false });
  try {
    db.query(
      `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    ).run(id, at, at, ...Object.values(values));
  } finally {
    db.close();
  }
  return id;
}

beforeEach(async () => {
  clock = 0;
  dataRoot = await mkdtemp(join(tmpdir(), "gp-my-page-records-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "マイページの検体", { app_id: APP_ID });
    createApp(store, "マイページの無い検体", { app_id: PLAIN_APP_ID });
  } finally {
    store.close();
  }
  const applied = applyManifest(dataRoot, APP_ID, manifest());
  expect(applied.valid ? [] : applied.errors).toEqual([]);
  expect(applyManifest(dataRoot, PLAIN_APP_ID, plainManifest()).valid).toBe(true);
  admin = seedSession(dataRoot, APP_ID, { role: "owner", username: "admin" });
  admin2 = seedSession(dataRoot, APP_ID, { role: "owner", username: "admin2" });
  member = seedSession(dataRoot, APP_ID, { role: "member", username: "member" });
  member2 = seedSession(dataRoot, APP_ID, { role: "member", username: "member2" });
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

async function get(
  cookie: string | undefined,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { origin: TEST_ORIGIN };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  const res = await app.request(new Request(`http://localhost${path}`, { headers }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function list(
  who: SeededSession | undefined,
  table: string,
  query = "my_page=1",
  appId = APP_ID,
): Promise<{ status: number; body: ListBody & Record<string, unknown> }> {
  const suffix = query === "" ? "" : `?${query}`;
  const res = await get(who?.cookie, `/api/apps/${appId}/tables/${table}/records${suffix}`);
  return res as { status: number; body: ListBody & Record<string, unknown> };
}

const ids = (body: ListBody): string[] => body.records.map((row) => row._id);
const messages = (body: Record<string, unknown>): string =>
  JSON.stringify((body as { errors?: unknown }).errors ?? body);

// ---------------------------------------------------------------------------------------------
// (a)(b)(j) 個人の持ち主の列の表
// ---------------------------------------------------------------------------------------------

function seedNotes(): { mine: string[]; others: string[]; admins: string[]; empty: string } {
  const mine: string[] = [];
  const others: string[] = [];
  const admins: string[] = [];
  for (let i = 0; i < 12; i++) {
    mine.push(put("notes", { title: `m${i}`, [OWNER]: member.userId }));
    if (i < 3) {
      others.push(put("notes", { title: `o${i}`, [OWNER]: member2.userId }));
    }
    if (i < 5) {
      admins.push(put("notes", { title: `a${i}`, [OWNER]: admin.userId }));
    }
  }
  const empty = put("notes", { title: "空", [OWNER]: null });
  return { mine, others, admins, empty };
}

test("(a) 一般の人には自分の行だけが返り、他人の行と持ち主が空の行は返らない", async () => {
  const seeded = seedNotes();
  // 今日(my_page なし): member は表の読取を条件なしで持つので全行が見える(持ち主の列を越える)。
  const today = await list(member, "notes", "");
  expect(today.status).toBe(200);
  expect(today.body.total).toBe(12 + 3 + 5 + 1);

  const mine = await list(member, "notes", "my_page=1&limit=100");
  expect(mine.status).toBe(200);
  expect(mine.body.total).toBe(12);
  expect(new Set(ids(mine.body))).toEqual(new Set(seeded.mine));
  expect(ids(mine.body)).not.toContain(seeded.empty);
  for (const other of [...seeded.others, ...seeded.admins]) {
    expect(ids(mine.body)).not.toContain(other);
  }
});

test("(b) 運営者にもマイページでは自分の行だけが返る。my_page を付けなければ今日どおり全行", async () => {
  const seeded = seedNotes();
  const today = await list(admin, "notes", "limit=100");
  expect(today.status).toBe(200);
  expect(today.body.total).toBe(21);

  const mine = await list(admin, "notes", "my_page=1&limit=100");
  expect(mine.status).toBe(200);
  expect(mine.body.total).toBe(5);
  expect(new Set(ids(mine.body))).toEqual(new Set(seeded.admins));
});

test("my_page に 1 以外の値を書くと 400(黙って全行を返さない)", async () => {
  seedNotes();
  for (const value of ["0", "", "true"]) {
    const res = await list(admin, "notes", `my_page=${value}&limit=100`);
    expect(res.status).toBe(400);
    expect(res.body.records).toBeUndefined();
  }
});

test("(j) total は絞った後の件数、limit / offset は絞った後に切り、_created_at の降順に並ぶ", async () => {
  const seeded = seedNotes();
  const newestFirst = [...seeded.mine].reverse();
  const first = await list(member, "notes", "my_page=1&limit=10&sort=_created_at&order=desc");
  expect(first.status).toBe(200);
  expect(first.body.total).toBe(12);
  expect(ids(first.body)).toEqual(newestFirst.slice(0, 10));

  const rest = await list(
    member,
    "notes",
    "my_page=1&limit=10&offset=10&sort=_created_at&order=desc",
  );
  expect(rest.status).toBe(200);
  expect(rest.body.total).toBe(12);
  expect(ids(rest.body)).toEqual(newestFirst.slice(10));
});

test("(j) 運営者(今日は DB でページを切る分岐)でも、絞った後に切る", async () => {
  const seeded = seedNotes();
  const res = await list(admin, "notes", "my_page=1&limit=2&offset=1&sort=_created_at&order=desc");
  expect(res.status).toBe(200);
  expect(res.body.total).toBe(5);
  expect(ids(res.body)).toEqual([...seeded.admins].reverse().slice(1, 3));
});

// ---------------------------------------------------------------------------------------------
// (c) 条件に「自分」がある表 / D-V22-23 持ち主の列が2つ
// ---------------------------------------------------------------------------------------------

test("(c) 読取の条件に「自分」がある表: member は自分が担当の行だけ、運営者もマイページでは自分の行だけ", async () => {
  const forMember = [
    put("tickets", { title: "t1", assignee: member.userId }),
    put("tickets", { title: "t2", assignee: member.userId }),
  ];
  const forMember2 = put("tickets", { title: "t3", assignee: member2.userId });
  const forAdmin = put("tickets", { title: "t4", assignee: admin.userId });
  const unassigned = put("tickets", { title: "t5", assignee: null });

  const m = await list(member, "tickets");
  expect(m.status).toBe(200);
  expect(m.body.total).toBe(2);
  expect(new Set(ids(m.body))).toEqual(new Set(forMember));

  const todayAdmin = await list(admin, "tickets", "");
  expect(todayAdmin.body.total).toBe(5);
  const a = await list(admin, "tickets");
  expect(a.status).toBe(200);
  expect(ids(a.body)).toEqual([forAdmin]);
  expect(ids(a.body)).not.toContain(forMember2);
  expect(ids(a.body)).not.toContain(unassigned);
});

test("D-V22-23: 持ち主の列が2つある表は、どちらか一方でも自分なら載る", async () => {
  const own = put("jobs", { title: "j1", [OWNER]: admin.userId, helper: null });
  const helping = put("jobs", { title: "j2", [OWNER]: admin2.userId, helper: admin.userId });
  const neither = put("jobs", { title: "j3", [OWNER]: admin2.userId, helper: member.userId });
  const res = await list(admin, "jobs", "my_page=1&sort=_created_at&order=asc");
  expect(res.status).toBe(200);
  expect(res.body.total).toBe(2);
  expect(ids(res.body)).toEqual([own, helping]);
  expect(ids(res.body)).not.toContain(neither);
});

// ---------------------------------------------------------------------------------------------
// (d) include
// ---------------------------------------------------------------------------------------------

test("(d) include で足した表は owner_field が自分の行だけ", async () => {
  const mine = put("errands", { title: "e1", runner: member.userId });
  put("errands", { title: "e2", runner: admin.userId });
  put("errands", { title: "e3", runner: null });
  const m = await list(member, "errands");
  expect(m.status).toBe(200);
  expect(ids(m.body)).toEqual([mine]);
  expect(m.body.total).toBe(1);
  const today = await list(member, "errands", "");
  expect(today.body.total).toBe(3);
});

// ---------------------------------------------------------------------------------------------
// (e) 載らない表・マイページの無いアプリ
// ---------------------------------------------------------------------------------------------

test("(e) exclude した表は 400", async () => {
  put("memo", { title: "x", [OWNER]: member.userId });
  const res = await list(member, "memo");
  expect(res.status).toBe(400);
  expect(messages(res.body)).toContain("マイページ");
  // 今日の読取は変わらない。
  expect((await list(member, "memo", "")).status).toBe(200);
});

test("(e) 持ち主の分からない表(宣言の無い表)は 400", async () => {
  put("plain", { title: "x" });
  const res = await list(member, "plain");
  expect(res.status).toBe(400);
  expect(messages(res.body)).toContain("マイページ");
});

test("(e) マイページの無いアプリは 400(st_owner の表でも)", async () => {
  const who = seedSession(dataRoot, PLAIN_APP_ID, { role: "owner", username: "solo" });
  put("notes", { title: "x", [OWNER]: who.userId }, PLAIN_APP_ID);
  const res = await list(who, "notes", "my_page=1", PLAIN_APP_ID);
  expect(res.status).toBe(400);
  expect(messages(res.body)).toContain("マイページ");
  expect((await list(who, "notes", "", PLAIN_APP_ID)).status).toBe(200);
});

// ---------------------------------------------------------------------------------------------
// (f) 未ログイン
// ---------------------------------------------------------------------------------------------

test("(f) 未ログインは 401(未ログインに開いている表でも)", async () => {
  put("errands", { title: "e1", runner: member.userId });
  const open = await list(undefined, "errands", "");
  expect(open.status).toBe(200);
  expect(open.body.total).toBe(1);
  const res = await list(undefined, "errands");
  expect(res.status).toBe(401);
  expect(res.body.records).toBeUndefined();
});

test("(f) 未ログインは 401(持ち主の列の表)", async () => {
  put("notes", { title: "n", [OWNER]: member.userId });
  const res = await list(undefined, "notes");
  expect(res.status).toBe(401);
  expect(res.body.records).toBeUndefined();
});

// ---------------------------------------------------------------------------------------------
// (g) 読めない役割は0件・読める範囲は広がらない
// ---------------------------------------------------------------------------------------------

test("(g) 表を読めない役割は、自分の行があっても0件(読める範囲が広がらない)", async () => {
  put("secret", { title: "s", [OWNER]: member.userId });
  const today = await list(member, "secret", "");
  expect(today.status).toBe(200);
  expect(today.body.total).toBe(0);
  const res = await list(member, "secret");
  expect(res.status).toBe(200);
  expect(res.body.records).toEqual([]);
  expect(res.body.total).toBe(0);
});

test("(g) 一覧画面を1つも使えない役割は、画面名を名乗らない読取の壁で0件(D-V22-24)", async () => {
  put("walled", { title: "w", [OWNER]: member.userId });
  const res = await list(member, "walled");
  expect(res.status).toBe(200);
  expect(res.body.records).toEqual([]);
  expect(res.body.total).toBe(0);
  // 運営者は画面を使えるので、自分の行が出る。
  const mine = put("walled", { title: "w2", [OWNER]: admin.userId });
  const a = await list(admin, "walled");
  expect(ids(a.body)).toEqual([mine]);
});

test("(g) 条件に「自分」がある表で、他人が担当の行は別の会員のマイページに混ざらない", async () => {
  put("tickets", { title: "t", assignee: member.userId });
  const res = await list(member2, "tickets");
  expect(res.status).toBe(200);
  expect(res.body.total).toBe(0);
});

// ---------------------------------------------------------------------------------------------
// (h) 持ち主の列が隠れている
// ---------------------------------------------------------------------------------------------

test("(h) 持ち主の列がその役割から隠されていれば 400。見せている役割は 200", async () => {
  put("tasks", { title: "k", handler: member.userId });
  const hidden = await list(member, "tasks");
  expect(hidden.status).toBe(400);
  // 隠した列の名前を 400 の文に出さない。
  expect(messages(hidden.body)).not.toContain("handler");
  expect((await list(member, "tasks", "")).status).toBe(200);
  const visible = await list(admin, "tasks");
  expect(visible.status).toBe(200);
  expect(visible.body.total).toBe(0);
});

// ---------------------------------------------------------------------------------------------
// 【V22-M3-T08a 中-1】行ごとに伏せられる持ち主の列(条件つきの項目の規則)。 方式(b):
// その役割・その行で持ち主の列が読める(射影の後に値が残る)行だけを「自分の行」に数える。
// ---------------------------------------------------------------------------------------------

test("(h') include の表: 持ち主の列が伏せられる行(status=closed)は、値が自分でも自分の行に数えない", async () => {
  const open = put("shifts", { title: "開いた自分", status: "open", runner: member.userId });
  const closed = put("shifts", { title: "閉じた自分", status: "closed", runner: member.userId });
  put("shifts", { title: "開いた他人", status: "open", runner: member2.userId });
  // 今日(my_page なし): 閉じた行も見えるが、持ち主の列は伏せられている(この前提が崩れたら検査の意味が変わる)。
  const today = await list(member, "shifts", "");
  expect(today.status).toBe(200);
  const closedRow = today.body.records.find((row) => row._id === closed);
  expect(closedRow).toBeDefined();
  expect(closedRow !== undefined && "runner" in closedRow).toBe(false);
  // マイページ: 伏せられた行は数えない(total も)。
  const res = await list(member, "shifts");
  expect(res.status).toBe(200);
  expect(ids(res.body)).toEqual([open]);
  expect(res.body.total).toBe(1);
});

test("(h') include の表の陰性対照: 持ち主の列を条件なしで読める役割は、閉じた行も自分の行に数える", async () => {
  const open = put("shifts", { title: "開いた運営", status: "open", runner: admin.userId });
  const closed = put("shifts", { title: "閉じた運営", status: "closed", runner: admin.userId });
  put("shifts", { title: "会員の", status: "closed", runner: member.userId });
  const res = await list(admin, "shifts");
  expect(res.status).toBe(200);
  expect(ids(res.body).sort()).toEqual([open, closed].sort());
  expect(res.body.total).toBe(2);
});

test("(h') st_owner の表: 持ち主の列が伏せられる行は自分の行に数えない。運営者は数える", async () => {
  const open = put("diary", { title: "開いた", status: "open", [OWNER]: member.userId });
  put("diary", { title: "閉じた", status: "closed", [OWNER]: member.userId });
  const res = await list(member, "diary");
  expect(res.status).toBe(200);
  expect(ids(res.body)).toEqual([open]);
  expect(res.body.total).toBe(1);
  const adminOpen = put("diary", { title: "運営の開いた", status: "open", [OWNER]: admin.userId });
  const adminClosed = put("diary", {
    title: "運営の閉じた",
    status: "closed",
    [OWNER]: admin.userId,
  });
  const a = await list(admin, "diary");
  expect(ids(a.body).sort()).toEqual([adminOpen, adminClosed].sort());
});

// ---------------------------------------------------------------------------------------------
// (i) ?view= と同時
// ---------------------------------------------------------------------------------------------

test("(i) ?view= と同時に指定すると 400(画面を名乗った読取は今日どおり)", async () => {
  put("notes", { title: "n", [OWNER]: member.userId });
  const both = await list(member, "notes", "my_page=1&view=notes_list");
  expect(both.status).toBe(400);
  expect(messages(both.body)).toContain("view");
  const named = await list(member, "notes", "view=notes_list");
  expect(named.status).toBe(200);
});

// ---------------------------------------------------------------------------------------------
// (k) /public
// ---------------------------------------------------------------------------------------------

test("(k) GET /public にマイページの宣言は載らない(workspace キーも出ない)", async () => {
  const res = await get(undefined, `/api/apps/${APP_ID}/public`);
  expect(res.status).toBe(200);
  expect(Object.keys(res.body).sort()).toEqual(["app", "signup", "views"]);
  expect(JSON.stringify(res.body)).not.toContain("my_page");
});
