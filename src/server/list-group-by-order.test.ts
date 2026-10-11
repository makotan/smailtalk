/**
 * **一覧の読取の並び(束ねるキー)**(`V20-M4-T01`。メインの裁定 案A / 読取の口 / 壁)。
 *
 * **読取の口は `group_by=<項目>&granularity=<粒度>`**(`sum=` の先例。表示層が画面の宣言を
 * 読取の引数へ翻訳する)。**並べ替えの語彙には数えない**(設計図のキーではなく読取の引数)。
 *
 * ## ここで測るもの(**本物の SQLite / 本物の HTTP**)
 *
 * | # | 何を |
 * |---|---|
 * | (a-1) | 群の値の昇順が第1キー、群の中で利用者の `sort`(昇順 / 降順)が効く、値が無い群は最後 |
 * | (a-2) | 日付は粒度で丸めた値で束ねる(週は月曜始まり)。群の中は利用者の `sort` |
 * | (a-3) | ページ(`limit` / `offset`)をまたいで群が連続する(ページを連結すると全件の並びに一致) |
 * | (a-4) | 群を指定しない読取は、画面に `group_by` を書いても書かなくても応答が1バイトも変わらない |
 * | (w)   | 壁: 役割の規則が名指しした項目は、`sort` と同じ述語・同じ 400 で止まる(owner も) |
 * | (v)   | 値域: 実在 / 型4種 / 粒度3値 / date に必須 / date 以外不可 / 粒度だけは不可 —— 400 |
 * | (d)   | 母集団: `st_owner` が実際に効く題材(`st_owner` + 行ごとのアクセス権、面の規則なし)で、区切る前後で見える行の集合と件数が同じ |
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
import { OWNER_FIELD } from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "list-group-by-order";

/**
 * - `ticket` = 非スコープ(SQL の LIMIT / OFFSET を使う分岐)。
 * - `ticket.secret` = 役割 `owner` の項目の規則が名指しした select(壁の当たり先)。
 */
function manifest(withViewGroupBy: boolean): Manifest {
  const base = withDefaultRoleRules({
    app: {
      id: APP_ID,
      name: "一覧の並び",
      tables: [
        {
          id: "ticket",
          name: "チケット",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "category", name: "種類", type: "select", options: ["食品", "雑貨", "書籍"] },
            { id: "due", name: "期限", type: "date" },
            { id: "done", name: "済み", type: "boolean" },
            { id: "amount", name: "金額", type: "number" },
            { id: "secret", name: "内部区分", type: "select", options: ["甲", "乙"] },
          ],
        },
      ],
      views: [
        {
          id: "ticket-list",
          type: "list_view",
          table: "ticket",
          columns: ["title", "category", "due", "done"],
          ...(withViewGroupBy ? { group_by: { field: "category" } } : {}),
        },
      ],
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [{ target: "field", table: "ticket", field: "secret", can: ["read", "write"] }],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
    },
  });
  return base as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-list-group-by-order-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "一覧の並び", { app_id: APP_ID });
  } finally {
    store.close();
  }
  const applied = applyManifest(dataRoot, APP_ID, manifest(false));
  expect(applied.valid, JSON.stringify(applied)).toBe(true);
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function req(cookie: string, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { origin: TEST_ORIGIN, cookie };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return Promise.resolve(app.request(new Request(`http://localhost${path}`, init)));
}

const recordsPath = (table: string) => `/api/apps/${APP_ID}/tables/${table}/records`;

async function create(cookie: string, table: string, body: Record<string, unknown>): Promise<void> {
  const res = await req(cookie, "POST", recordsPath(table), body);
  expect(res.status, JSON.stringify(body)).toBe(201);
}

async function get(
  cookie: string,
  table: string,
  query: string,
): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  const res = await req(cookie, "GET", `${recordsPath(table)}${query === "" ? "" : `?${query}`}`);
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as Record<string, unknown> };
}

type Row = { _id: string; title: string; category?: string | null; due?: string | null };

async function titles(cookie: string, table: string, query: string): Promise<string[]> {
  const { status, json } = await get(cookie, table, query);
  expect(status, JSON.stringify(json)).toBe(200);
  return (json.records as Row[]).map((row) => row.title);
}

function owner(name: string): string {
  return seedSession(dataRoot, APP_ID, { role: "owner", username: name }).cookie;
}

async function seedTickets(cookie: string): Promise<void> {
  // 作成順と件名の順と群の順が全部食い違うように置く。
  await create(cookie, "ticket", { title: "c-雑貨", category: "雑貨", due: "2026-09-22" });
  await create(cookie, "ticket", { title: "a-食品", category: "食品", due: "2026-09-27" });
  await create(cookie, "ticket", { title: "e-なし", due: "2026-09-14" });
  await create(cookie, "ticket", { title: "b-雑貨", category: "雑貨", due: "2026-09-15" });
  await create(cookie, "ticket", { title: "d-食品", category: "食品" });
  await create(cookie, "ticket", { title: "f-書籍", category: "書籍", due: "2026-09-21" });
}

// ---------------------------------------------------------------------------
// (a) 並べ替え
// ---------------------------------------------------------------------------

test("(a-1) 群の昇順が第1キー、群の中で利用者の sort(昇順 / 降順)が効き、値が無い群は最後", async () => {
  const cookie = owner("a1");
  await seedTickets(cookie);
  // 群の値の昇順: "書籍"(U+66F8)< "雑貨"(U+96D1)< "食品"(U+98DF)< 値なし。
  expect(await titles(cookie, "ticket", "group_by=category&sort=title&order=asc")).toEqual([
    "f-書籍",
    "b-雑貨",
    "c-雑貨",
    "a-食品",
    "d-食品",
    "e-なし",
  ]);
  expect(await titles(cookie, "ticket", "group_by=category&sort=title&order=desc")).toEqual([
    "f-書籍",
    "c-雑貨",
    "b-雑貨",
    "d-食品",
    "a-食品",
    "e-なし",
  ]);
  // 対照: 群を指定しなければ利用者の sort だけで並ぶ(今日どおり)。
  expect(await titles(cookie, "ticket", "sort=title&order=asc")).toEqual([
    "a-食品",
    "b-雑貨",
    "c-雑貨",
    "d-食品",
    "e-なし",
    "f-書籍",
  ]);
});

test("(a-2) 日付は粒度で丸めた値で束ね(週は月曜始まり)、群の中は利用者の sort", async () => {
  const cookie = owner("a2");
  await seedTickets(cookie);
  // 週: 09-14(e 09-14, b 09-15)/ 09-21(f 09-21, c 09-22, a 09-27 日曜)/ 値なし(d)。
  expect(
    await titles(cookie, "ticket", "group_by=due&granularity=week&sort=title&order=desc"),
  ).toEqual(["e-なし", "b-雑貨", "f-書籍", "c-雑貨", "a-食品", "d-食品"]);
  // 月: 全部 2026-09 の1群 + 値なし → 群の中は title 昇順。
  expect(
    await titles(cookie, "ticket", "group_by=due&granularity=month&sort=title&order=asc"),
  ).toEqual(["a-食品", "b-雑貨", "c-雑貨", "e-なし", "f-書籍", "d-食品"]);
});

test("(a-3) ページ(limit / offset)をまたいで群が連続する(ページを連結すると全件の並びと一致し、total は同じ)", async () => {
  const cookie = owner("a3");
  await seedTickets(cookie);
  const query = "group_by=category&sort=title&order=asc";
  const all = await titles(cookie, "ticket", query);
  expect(all).toEqual(["f-書籍", "b-雑貨", "c-雑貨", "a-食品", "d-食品", "e-なし"]);
  const pages: string[] = [];
  for (const offset of [0, 2, 4]) {
    const { json } = await get(cookie, "ticket", `${query}&limit=2&offset=${offset}`);
    expect(json.total).toBe(6);
    pages.push(...(json.records as Row[]).map((row) => row.title));
  }
  expect(pages).toEqual(all);
  // 1ページ目の末尾と2ページ目の先頭が同じ群(雑貨)にまたがっている(またぎが実際に起きている)。
  expect(all.slice(1, 3)).toEqual(["b-雑貨", "c-雑貨"]);
});

test("(a-4) 群を指定しない読取は、画面に group_by を書く前と後で応答が1バイトも変わらない", async () => {
  const cookie = owner("a4");
  await seedTickets(cookie);
  const queries = ["", "sort=title&order=desc", "limit=2&offset=1", "filter.category=食品"];
  const before: string[] = [];
  for (const q of queries) {
    before.push((await get(cookie, "ticket", q)).text);
  }
  expect(applyManifest(dataRoot, APP_ID, manifest(true)).valid).toBe(true);
  const after: string[] = [];
  for (const q of queries) {
    after.push((await get(cookie, "ticket", q)).text);
  }
  expect(after).toEqual(before);
  // 応答の形は着手前と同じ(records / total だけ)。
  expect(Object.keys(JSON.parse(before[0] as string)).sort()).toEqual(["records", "total"]);
});

// ---------------------------------------------------------------------------
// (w) 壁: sort と同じ
// ---------------------------------------------------------------------------

test("(w) 役割の規則が名指しした項目は、sort と同じ 400 で止まる(owner でも。ロールを見ない)", async () => {
  const cookie = owner("w1");
  await seedTickets(cookie);
  const bySort = await get(cookie, "ticket", "sort=secret");
  const byGroup = await get(cookie, "ticket", "group_by=secret");
  expect(bySort.status).toBe(400);
  expect(byGroup.status).toBe(400);
  const sortErrors = bySort.json.errors as { path: string; message: string; hint?: string }[];
  const groupErrors = byGroup.json.errors as { path: string; message: string; hint?: string }[];
  expect(sortErrors).toHaveLength(1);
  expect(groupErrors).toHaveLength(1);
  expect(sortErrors[0]?.path).toBe("/sort/field");
  expect(groupErrors[0]?.path).toBe("/group_by");
  // 同じ形: 文面の型(「役割の規則が名指ししています」)とヒントが同じ。allowed_values を持たない点も同じ。
  expect(sortErrors[0]?.message).toContain("役割の規則が名指ししています");
  expect(groupErrors[0]?.message).toContain("役割の規則が名指ししています");
  expect(groupErrors[0]?.hint).toBe(sortErrors[0]?.hint);
  expect(Object.keys(groupErrors[0] ?? {}).sort()).toEqual(Object.keys(sortErrors[0] ?? {}).sort());
  // 対照: 名指ししていない select は通る。
  expect((await get(cookie, "ticket", "group_by=category")).status).toBe(200);
});

// ---------------------------------------------------------------------------
// (v) 値域
// ---------------------------------------------------------------------------

test("(v) 読取の引数の値域はサーバでも検査する(実在 / 型4種 / 粒度3値 / date に必須 / date 以外不可 / 粒度だけ不可)", async () => {
  const cookie = owner("v1");
  const cases: [string, string][] = [
    ["group_by=nothing", "/group_by"],
    ["group_by=title", "/group_by"],
    ["group_by=amount", "/group_by"],
    ["group_by=_id", "/group_by"],
    ["group_by=due", "/granularity"],
    ["group_by=due&granularity=year", "/granularity"],
    ["group_by=category&granularity=week", "/granularity"],
    ["granularity=week", "/granularity"],
  ];
  for (const [query, path] of cases) {
    const { status, json } = await get(cookie, "ticket", query);
    expect(status, query).toBe(400);
    const errors = json.errors as { path: string; allowed_values?: string[] }[];
    expect(errors[0]?.path, query).toBe(path);
    // 書ける項目の一覧に、名指しされた項目(secret)を出さない(sort の 400 と同じ伏せ方)。
    for (const error of errors) {
      expect(error.allowed_values ?? [], query).not.toContain("secret");
    }
  }
  // 通る形。
  for (const query of ["group_by=category", "group_by=done", "group_by=due&granularity=day"]) {
    expect((await get(cookie, "ticket", query)).status, query).toBe(200);
  }
});

// ---------------------------------------------------------------------------
// (d) 母集団: st_owner が実際に効く題材
// ---------------------------------------------------------------------------

/**
 * **`st_owner` が実際に効く題材**(`D-V8-35` を避ける)。
 *
 * **面の規則が表の読取を許すと、その役割は `st_owner` を越えて全員分を読む**(`D-V8-35`)。
 * **面の規則を書かない表は閉じる**(`V8-M26`)。**条件つきの読取規則は、行ごとに越えるか閉じるかを
 * 決めるだけで `st_owner` は効かない**(越える行 = 読める行。`owner-scope.ts` の `owner_scoped` 枝の
 * `(isOwnerVisible || roleReadCrossesOwnerScope) && roleRowReadable`)。
 * **今日 `st_owner` が行を落とすのは、`st_owner` と行ごとのアクセス権(`access_control`)を併せ持ち、
 * 面の規則を1本も書かない表だけである** —— 付与が在っても、他人の持ち物の行は `st_owner` で落ちる。
 * (担い手が一時ファイルで実測した: A に付与した B の行は A に出ない。)
 */
const OWNED_APP = "list-group-by-owned";
const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる", read: true, write: true, delete: false },
];

function ownedManifest(withViewGroupBy: boolean): Manifest {
  return withDefaultRoleRules(
    {
      app: {
        id: OWNED_APP,
        name: "個人所有の区切り",
        tables: [
          {
            id: "note",
            name: "メモ",
            fields: [
              { id: "title", name: "件名", type: "text", required: true },
              { id: "category", name: "種類", type: "select", options: ["食品", "雑貨"] },
              { id: OWNER_FIELD, name: "所有者", type: "text" },
            ],
            access_control: {
              enabled: true,
              permissions: PERMISSIONS,
              creator_permission: "writer",
              grant: {
                table: "note_grant",
                target: "note",
                member: "member",
                permission: "permission",
              },
              members: { table: "member", account: "account" },
            },
          },
          {
            id: "note_grant",
            name: "付与",
            fields: [
              { id: "note", name: "メモ", type: "reference", reference_table: "note" },
              { id: "member", name: "相手", type: "reference", reference_table: "member" },
              { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
            ],
          },
          {
            id: "member",
            name: "利用者",
            fields: [{ id: "account", name: "ログイン", type: "text" }],
          },
        ],
        views: [
          {
            id: "note-list",
            type: "list_view",
            table: "note",
            columns: ["title", "category"],
            ...(withViewGroupBy ? { group_by: { field: "category" } } : {}),
          },
        ],
      },
    },
    // **面の規則を `note` に1本も足さない**(足すと `D-V8-35` で `st_owner` を越える)。
    { skipTables: ["note"] },
  ) as unknown as Manifest;
}

test("(d) st_owner が実際に効く表で、区切る前後で同じ人に見える行の集合が同じ", async () => {
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "個人所有の区切り", { app_id: OWNED_APP });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, OWNED_APP, ownedManifest(false)).valid).toBe(true);
  const a = seedSession(dataRoot, OWNED_APP, { role: "editor", username: "d-a" });
  const b = seedSession(dataRoot, OWNED_APP, { role: "editor", username: "d-b" });
  const loaded = ownedManifest(false);
  const db = new Database(appDbPath(dataRoot, OWNED_APP), { readwrite: true, create: false });
  try {
    const insert = (table: string, values: Record<string, unknown>): string => {
      const created = createRecord(db, loaded, table, values);
      expect(created.ok).toBe(true);
      return (created as { value: { _id: string } }).value._id;
    };
    const memberA = insert("member", { account: a.userId });
    const memberB = insert("member", { account: b.userId });
    const aFood = insert("note", {
      title: "A所有-食品",
      category: "食品",
      [OWNER_FIELD]: a.userId,
    });
    const aNone = insert("note", { title: "A所有-なし", [OWNER_FIELD]: a.userId });
    const bMisc = insert("note", {
      title: "B所有-雑貨",
      category: "雑貨",
      [OWNER_FIELD]: b.userId,
    });
    const shared = insert("note", { title: "共有-雑貨", category: "雑貨", [OWNER_FIELD]: null });
    const bFood = insert("note", {
      title: "B所有-食品",
      category: "食品",
      [OWNER_FIELD]: b.userId,
    });
    // A には5行すべてに付与する(B の持ち物にも)。B には自分の2行と共有にだけ付与する。
    for (const row of [aFood, aNone, bMisc, shared, bFood]) {
      insert("note_grant", { note: row, member: memberA, permission: "reader" });
    }
    for (const row of [bMisc, bFood, shared]) {
      insert("note_grant", { note: row, member: memberB, permission: "reader" });
    }
  } finally {
    db.close();
  }

  const path = `/api/apps/${OWNED_APP}/tables/note/records`;
  const read = async (cookie: string, query: string) => {
    const res = await app.request(
      new Request(`http://localhost${path}${query === "" ? "" : `?${query}`}`, {
        headers: { cookie, origin: TEST_ORIGIN },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { records: Row[]; total: number };
    return { total: json.total, titles: json.records.map((row) => row.title).sort() };
  };
  // **`st_owner` が効いている実測**: A は B の持ち物2行に付与を持つのに、その2行は出ない。
  const expected = {
    a: ["A所有-なし", "A所有-食品", "共有-雑貨"],
    b: ["B所有-雑貨", "B所有-食品", "共有-雑貨"],
  };
  for (const [who, session] of [
    ["a", a],
    ["b", b],
  ] as const) {
    const plain = await read(session.cookie, "");
    expect(plain.titles, who).toEqual(expected[who]);
    expect(plain.total, who).toBe(expected[who].length);
    for (const query of [
      "group_by=category",
      "group_by=category&limit=1&offset=0",
      "group_by=category&sort=title&order=desc",
    ]) {
      const grouped = await read(session.cookie, query);
      expect(grouped.total, `${who} ${query}`).toBe(plain.total);
      if (!query.includes("limit")) {
        expect(grouped.titles, `${who} ${query}`).toEqual(plain.titles);
      }
    }
  }
  // 画面に group_by を書いても同じ。
  expect(applyManifest(dataRoot, OWNED_APP, ownedManifest(true)).valid).toBe(true);
  expect(await read(a.cookie, "group_by=category")).toEqual(await read(a.cookie, ""));
});
