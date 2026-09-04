/**
 * **`V7-M3-T05`(`Z-G32`)**: **相手が消えたあとの付与と、id の再利用。**
 *
 * ## **本ファイルが扱う2つの場合(別々に扱う。混ぜない)**
 *
 * **(a) `_auth_users` から消えたユーザの id を指す付与行**
 *  - **メンバー表の行はそのまま残る**(メンバー表は普通の表であり、ユーザ削除で1行も消えない)。
 *  - **付与行も残る。** **判定は `_auth_users` を1度も参照しない**(`Z-G32` 限定2)——
 *    **したがって「そのユーザが消えた」ことを判定は知らないし、知ろうともしない。**
 *  - **採った形 = (i) 付与は残るが、誰にもマッチしない(事実上無効)。** **理由と、採らなかった
 *    2案は `docs/plan/v7/records/v7-m3.md` §2-5 に書いた。**
 *  - **取り残し一覧(`Z-G19`)は `V7-M5-T02` の担当である。** **本ファイルは1バイトも作らない。**
 *
 * **(b) 消えたグループ行を指す付与行**
 *  - **`V7-M3-T01` は「グループ表の行を1行も読まない」設計を採り、その帰結として
 *    「消えたグループ行を指す付与は今日も効く」を限界として記録し、`V7-M3-T05` へ送った**
 *    (`v7-m3.md` §2-1-3 (c))。
 *  - **本タスクはそれを解く。** **グループ表の行を消したら、そのグループ経由の付与は
 *    1ミリも効かなくなる。**
 *  - **【したがって `V7-M3-T01` の設計判断はここで成り立たなくなった。読む表が1本増えた】** ——
 *    **`recordAccessSourceTables` は `groupTable` を返すようになり(2キー → 3キー)、
 *    読取経路は付与表・利用者表に加えてグループ表も毎回全件読む。**
 *
 * ## **id の再利用**
 *
 * **書けるのは「`src/auth/store.ts` の `randomId()` が 256bit の暗号乱数を使っており、
 * `_auth_users` の DDL に連番も `AUTOINCREMENT` も無い」までである**(`Z-G32` 限定3)。
 * **【禁止】「衝突しない」とは書かない。** **(C) がこの逐語をソースから読んで固定する。**
 *
 * ## **本ファイルが止めていないもの(先に書く。憲法6)**
 *
 *  1. **残骸を1行も消さない。** **消えた相手を指す付与行・メンバー行は溜まり続ける**
 *     (`Z-G32` 限定1 / 限定6)。**掃除の自動処理を1つも作っていない。**
 *  2. **メンバー行の `account` を別のユーザに書き換えると、その行に付いていた古い付与は
 *     そのまま新しい人に効く**((B-5) が実測して固定している)。**止めていない。**
 *  3. **`undo` で消えたグループ行・メンバー行が戻ると、付与も一緒に効き直す**(`Z-G31` =
 *     `V7-M5-T04` の担当)。**本ファイルは1度も測っていない。**
 *  4. **`src/auth/` を1バイトも変えていない**(`Z-G32` 限定4)。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "../auth/store.ts";
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
  grantsWithExistingGroups,
  judgeRecordAccess,
  recordAccessSourceTables,
} from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "stale-grant";

const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる", read: true, write: true, delete: false },
  { id: "keeper", name: "作った人", read: true, write: true, delete: true },
] as const;

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "相手が消えたあとの付与",
      tables: [
        {
          id: "books",
          name: "書籍",
          fields: [{ id: "title", name: "タイトル", type: "text", required: true }],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            grant: {
              table: "book_grant",
              target: "book",
              member: "member",
              group: "team",
              permission: "permission",
            },
            members: { table: "book_member", account: "account", group: "team" },
            groups: { table: "book_team" },
          },
        },
        {
          // **宣言していない表**(オプトインの対照)。
          id: "notes",
          name: "メモ",
          fields: [{ id: "body", name: "本文", type: "text" }],
        },
        {
          id: "book_team",
          name: "グループ",
          fields: [{ id: "title", name: "名前", type: "text" }],
        },
        {
          id: "book_member",
          name: "利用者",
          fields: [
            { id: "account", name: "ログイン", type: "text" },
            { id: "team", name: "グループ", type: "reference", reference_table: "book_team" },
          ],
        },
        {
          id: "book_grant",
          name: "本の付与",
          fields: [
            { id: "book", name: "本", type: "reference", reference_table: "books" },
            { id: "member", name: "相手", type: "reference", reference_table: "book_member" },
            { id: "team", name: "グループ", type: "reference", reference_table: "book_team" },
            {
              id: "permission",
              name: "権限",
              type: "select",
              options: ["reader", "writer", "keeper"],
            },
          ],
        },
      ],
      views: [],
      workflows: [],
    },
  } as unknown as Manifest;
}

/**
 * **【`V8-M26`】面(役割に束ねた権限)の既定が閉じたので、`applyManifest` に渡す題材へ
 * 既定3役割の規則を足したもの。**
 *
 * **足すのは補助表(付与表 `book_grant` / 利用者表 `book_member` / グループ表 `book_team`)と、
 * `access_control` を1バイトも宣言していない普通の表(`notes`)だけである。**
 *
 * **保護対象の `books` には1本も足さない**(`skipTables: ["books"]`)—— **面と点は
 * `combineRoleAndGrantAccess` が `OR` で重ねるので、面を開けると本ファイルが測っている
 * 点(消えたグループ行・消えたメンバー行を指す付与)の答えが丸ごと通り、測定が無効になる。**
 *
 * **画面は1つも無い(`views: []`)ので、画面とボタンの規則は1本も入らない。**
 * **`editor` に手書きの規則は1本も足していない** —— **本ファイルの `DELETE` は全部
 * 運営(`owner`)が出しており(`removeRow` は `admin.cookie` 固定)、既定の自動付与が
 * 持ち主へ `delete` を配るからである。**
 *
 * **述語を直に呼ぶ検査(`judge()` / (A) / (B) / (E))は今日どおり `manifest()` を使う** ——
 * **判定の入力に役割は1バイトも入らないためである。**
 */
function manifestWithRoles(): Manifest {
  return withDefaultRoleRules(manifest(), { skipTables: ["books"] });
}

const ROW = { _id: "book-1", title: "共有された本" };

/** 直接の付与1件 + グループ経由の付与1件。**どちらも同じ1行を指す。** */
function grants(): Record<string, unknown>[] {
  return [
    {
      _id: "grant-direct",
      book: "book-1",
      member: "member-direct",
      team: null,
      permission: "reader",
    },
    { _id: "grant-group", book: "book-1", member: null, team: "team-1", permission: "writer" },
  ];
}

function members(): Record<string, unknown>[] {
  return [
    { _id: "member-direct", account: "user-direct", team: null },
    { _id: "member-in-team", account: "user-in-team", team: "team-1" },
  ];
}

/** グループ表の行を渡して判定する(**呼び出し側が読む**。述語は I/O を1つも持たない)。 */
function judge(params: {
  actorId: string | null;
  grantRows?: Record<string, unknown>[];
  memberRows?: Record<string, unknown>[];
  groupRows?: Record<string, unknown>[];
  tableId?: string;
}) {
  const base = manifest();
  const tableId = params.tableId ?? "books";
  const grantRows = grantsWithExistingGroups({
    manifest: base,
    tableId,
    grantRows: params.grantRows ?? grants(),
    groupRows: params.groupRows ?? [{ _id: "team-1", title: "第1班" }],
  });
  return judgeRecordAccess({
    manifest: base,
    tableId,
    row: ROW,
    actorId: params.actorId,
    grantRows,
    memberRows: params.memberRows ?? members(),
  });
}

// ---------------------------------------------------------------------------
// (A) **消えたグループ行を指す付与**(`V7-M3-T01` が送ってきた限界を解く)
// ---------------------------------------------------------------------------

describe("V7-M3-T05 (A): 消えたグループ行を指す付与", () => {
  test("(A-1) グループ行が在るあいだは、グループ経由の付与は今日どおり効く(対照)", () => {
    expect(judge({ actorId: "user-in-team" })).toEqual({ read: true, write: true, delete: false });
  });

  test("(A-2) グループ行を消したら、そのグループ経由の付与は1ミリも効かない", () => {
    // **メンバー行の `team` は `team-1` を指したままである**(参照整合性は削除を止めない)。
    // **それでも、グループ表にその行が無いなら解決しない。**
    expect(judge({ actorId: "user-in-team", groupRows: [] })).toEqual({
      read: false,
      write: false,
      delete: false,
    });
  });

  test("(A-3) 別のグループ行が在っても、消えた id は復活しない", () => {
    expect(
      judge({ actorId: "user-in-team", groupRows: [{ _id: "team-2", title: "第2班" }] }),
    ).toEqual({ read: false, write: false, delete: false });
  });

  test("(A-4) 直接の付与は1ミリも巻き込まない(グループが消えても効き続ける)", () => {
    expect(judge({ actorId: "user-direct", groupRows: [] })).toEqual({
      read: true,
      write: false,
      delete: false,
    });
  });

  test("(A-5) 1件の付与行に相手とグループの両方が書いてあれば、グループが消えても相手側で効く", () => {
    const both = [
      {
        _id: "grant-both",
        book: "book-1",
        member: "member-in-team",
        team: "team-1",
        permission: "writer",
      },
    ];
    expect(judge({ actorId: "user-in-team", grantRows: both, groupRows: [] })).toEqual({
      read: true,
      write: true,
      delete: false,
    });
  });

  test("(A-6) `grantsWithExistingGroups` は入力の行を1バイトも書き換えない(コピーを返す)", () => {
    const rows = grants();
    const before = JSON.stringify(rows);
    grantsWithExistingGroups({
      manifest: manifest(),
      tableId: "books",
      grantRows: rows,
      groupRows: [],
    });
    expect(JSON.stringify(rows)).toBe(before);
  });

  test("(A-7) 宣言していない表・実在しない表では、付与行を1件も落とさない", () => {
    const rows = grants();
    for (const tableId of ["notes", "nope"]) {
      expect(
        grantsWithExistingGroups({ manifest: manifest(), tableId, grantRows: rows, groupRows: [] }),
      ).toEqual(rows);
    }
  });

  test("(A-8) `recordAccessSourceTables` はグループ表を返す(2キー → 3キー。読む表が1本増えた)", () => {
    // **`V7-M3-T01` の記録 §2-1-3 (c)「グループ表の行を1行も読まない」は、今日は
    // 成り立たない。** **消えたグループ行を指す付与を止めるには、行の実在を見るしかない。**
    expect(recordAccessSourceTables(manifest(), "books")).toEqual({
      grantTable: "book_grant",
      memberTable: "book_member",
      groupTable: "book_team",
    });
    expect(recordAccessSourceTables(manifest(), "notes")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (B) **消えたユーザ / 消えたメンバー行を指す付与**
// ---------------------------------------------------------------------------

describe("V7-M3-T05 (B): 消えたユーザとメンバー行", () => {
  test("(B-1) 判定は `_auth_users` を1度も見ない —— 消えたユーザの id を渡せば、今日どおり真を返す", () => {
    // **これは欠陥ではなく、採った形そのものである**(`Z-G32` 限定2)——
    // **判定は「メンバー表の `account` の値 = 今ログインしている actor の id」の一致だけで
    // 行う。** **ログインできない id は、そもそも actor になれない**((D-3) が HTTP で示す)。
    expect(judge({ actorId: "user-direct" })).toEqual({
      read: true,
      write: false,
      delete: false,
    });
  });

  test("(B-2) メンバー表の行が消えたら、その人を指す付与は1ミリも効かない", () => {
    expect(judge({ actorId: "user-direct", memberRows: [] })).toEqual({
      read: false,
      write: false,
      delete: false,
    });
  });

  test("(B-3) メンバー行が消えると、その人のグループ経由の付与も効かない", () => {
    expect(judge({ actorId: "user-in-team", memberRows: [] })).toEqual({
      read: false,
      write: false,
      delete: false,
    });
  });

  test("(B-4) メンバー行を作り直しても、古い付与は復活しない(新しい行は新しい `_id` を持つ)", () => {
    const recreated = [{ _id: "member-recreated", account: "user-direct", team: null }];
    expect(judge({ actorId: "user-direct", memberRows: recreated })).toEqual({
      read: false,
      write: false,
      delete: false,
    });
  });

  test("(B-5) 【止めていない】メンバー行の `account` を別の人に書き換えると、古い付与がその人に効く", () => {
    const rewritten = [{ _id: "member-direct", account: "user-newcomer", team: null }];
    expect(judge({ actorId: "user-newcomer", memberRows: rewritten })).toEqual({
      read: true,
      write: false,
      delete: false,
    });
  });

  test("(B-6) 判定の本体に `_auth_users` の綴りが1文字も無い(限定2 を機械で固定する)", () => {
    const source = readFileSync(new URL("./owner-scope.ts", import.meta.url).pathname, "utf8");
    const start = source.indexOf("export function judgeRecordAccess(params: {");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n}", start));
    expect(body.includes("_auth_users")).toBe(false);
    expect(body.includes("AuthStore")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (C) **id の再利用の根拠**(**逐語**。「たぶん再利用されない」で通さない)
// ---------------------------------------------------------------------------

describe("V7-M3-T05 (C): id の再利用と `deleteUser` の自認(逐語で固定する)", () => {
  const AUTH_STORE_SOURCE = readFileSync(
    new URL("../auth/store.ts", import.meta.url).pathname,
    "utf8",
  );

  test("(C-1) `randomId()` は 256bit の暗号乱数である(逐語)", () => {
    expect(AUTH_STORE_SOURCE).toContain(
      "export function randomId(): string {\n  const bytes = new Uint8Array(32);\n  crypto.getRandomValues(bytes);\n  return toBase64Url(bytes);\n}",
    );
    expect(AUTH_STORE_SOURCE).toContain("暗号乱数 32byte(256bit)を base64url にした不透明 ID。");
  });

  test("(C-2) `_auth_users` の DDL に連番も `AUTOINCREMENT` も無い", () => {
    const start = AUTH_STORE_SOURCE.indexOf('CREATE TABLE IF NOT EXISTS "_auth_users"');
    expect(start).toBeGreaterThan(-1);
    const ddl = AUTH_STORE_SOURCE.slice(start, start + 400);
    expect(ddl.includes("AUTOINCREMENT")).toBe(false);
    expect(/INTEGER\s+PRIMARY\s+KEY/i.test(ddl)).toBe(false);
  });

  test("(C-3) `deleteUser` の自認の逐語がソースに在る —— v7 の「誰にも見えない行」と同じ形である", () => {
    expect(AUTH_STORE_SOURCE).toContain(
      "**そのユーザが作った業務データ(`st_owner` にその id を持つ行)は1行も消さない。**",
    );
    expect(AUTH_STORE_SOURCE).toContain("**結果として、その行は誰にも見えなくなる**");
    // **`deleteUser` は業務データを1行も消さない** —— **付与表・メンバー表も業務データである。**
    const start = AUTH_STORE_SOURCE.indexOf("  deleteUser(userId: string): void {");
    expect(start).toBeGreaterThan(-1);
    const body = AUTH_STORE_SOURCE.slice(start, AUTH_STORE_SOURCE.indexOf("\n  }", start));
    for (const table of [
      "_auth_sessions",
      "_auth_webauthn_credentials",
      "_auth_password_credentials",
      "_auth_users",
      // **【期待値を書き換えた理由: `V8-M16` / `J-G3`(2026-08-09)】**
      // **`_auth_*` の7本目 `_auth_user_roles`(役割の付与)を足したので、退会が道連れに
      // する表が4本から5本になった。** **この検査が守っているもの(「業務データを1行も
      // 消さない」)は1ミリも緩んでいない** —— **`_auth_user_roles` は `src/auth/store.ts`
      // の定数として作られるシステム表であって、v7 の付与表(アプリが作った普通のユーザ表)
      // ではない。** **業務データの表名は今日も1つも現れない。**
      "_auth_user_roles",
    ]) {
      expect(body).toContain(`DELETE FROM "${table}"`);
    }
    // **消す表は上の5つだけである**(業務データの表名は1つも現れない)。
    expect((body.match(/DELETE FROM/g) ?? []).length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// (D) HTTP —— **実サーバ・実 SQLite。画面ではなく API から**
// ---------------------------------------------------------------------------

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
let viaGroup: ReturnType<typeof seedSession>;
let viaMember: ReturnType<typeof seedSession>;
let admin: ReturnType<typeof seedSession>;
let teamId = "";
let viaGroupMemberId = "";
let viaMemberMemberId = "";
let bookId = "";

function withDb<T>(run: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

async function get(path: string, cookie: string): Promise<Response> {
  return await app.request(path, { headers: { cookie, origin: TEST_ORIGIN } });
}

async function post(path: string, cookie: string, body: unknown): Promise<Response> {
  return await app.request(path, {
    method: "POST",
    headers: { cookie, origin: TEST_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * **運営(`owner`)が1行消す。** **`DELETE` は `If-Match` 必須(`ADR-0017`)なので、
 * 版は DB から読んで付ける。**
 */
async function removeRow(tableId: string, recordId: string): Promise<Response> {
  const version = withDb(
    (db) =>
      (
        db
          .query(`SELECT "_updated_at" AS v FROM ${JSON.stringify(tableId)} WHERE "_id" = ?`)
          .get(recordId) as { v: string }
      ).v,
  );
  return await app.request(`/api/apps/${APP_ID}/tables/${tableId}/records/${recordId}`, {
    method: "DELETE",
    headers: { cookie: admin.cookie, origin: TEST_ORIGIN, "if-match": version },
  });
}

async function listIds(path: string, cookie: string): Promise<string[]> {
  const res = await get(path, cookie);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { records: { _id: string }[] };
  return body.records.map((row) => row._id);
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-acsg-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "相手が消えたあとの付与", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, manifestWithRoles()).valid).toBe(true);
  app = createServerApp({ dataRoot });
  admin = seedSession(dataRoot, APP_ID, { role: "owner", username: "admin" });
  viaGroup = seedSession(dataRoot, APP_ID, { role: "editor", username: "via-group" });
  viaMember = seedSession(dataRoot, APP_ID, { role: "editor", username: "via-member" });

  const loaded = manifest();
  withDb((db) => {
    const created = createRecord(db, loaded, "book_team", { title: "第1班" });
    expect(created.ok).toBe(true);
    teamId = (created as { value: { _id: string } }).value._id;
    const member = (account: string, team: string | null): string => {
      const row = createRecord(db, loaded, "book_member", { account, team });
      expect(row.ok).toBe(true);
      return (row as { value: { _id: string } }).value._id;
    };
    viaGroupMemberId = member(viaGroup.userId, teamId);
    viaMemberMemberId = member(viaMember.userId, null);
    member(admin.userId, null);
  });

  // **行は運営(`owner`)が HTTP で作る** —— **作成者への付与が1件入る。**
  const created = await post(`/api/apps/${APP_ID}/tables/books/records`, admin.cookie, {
    title: "共有された本",
  });
  expect(created.status).toBe(201);
  bookId = ((await created.json()) as { record: { _id: string } }).record._id;

  // **グループへの付与1件と、直接の付与1件。**
  for (const values of [
    { book: bookId, team: teamId, permission: "writer" },
    { book: bookId, member: viaMemberMemberId, permission: "reader" },
  ]) {
    const granted = await post(
      `/api/apps/${APP_ID}/tables/book_grant/records`,
      admin.cookie,
      values,
    );
    expect(granted.status).toBe(201);
  }
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

describe("V7-M3-T05 (D): HTTP —— 相手が消えたあとの付与", () => {
  test("(D-1) グループ経由で見えていた人が、グループ行を消したあとに見えなくなる", async () => {
    // **消す前に見えていたことを先に示す。**
    expect(await listIds(`/api/apps/${APP_ID}/tables/books/records`, viaGroup.cookie)).toEqual([
      bookId,
    ]);
    expect(
      (await get(`/api/apps/${APP_ID}/tables/books/records/${bookId}`, viaGroup.cookie)).status,
    ).toBe(200);

    expect((await removeRow("book_team", teamId)).status).toBe(204);

    // **メンバー行は今日も同じグループ id を指したままである**(参照整合性は削除を止めない)。
    expect(
      withDb(
        (db) =>
          (
            db.query(`SELECT "team" FROM "book_member" WHERE "_id" = ?`).get(viaGroupMemberId) as {
              team: string | null;
            }
          ).team,
      ),
    ).toBe(teamId);

    expect(await listIds(`/api/apps/${APP_ID}/tables/books/records`, viaGroup.cookie)).toEqual([]);
    expect(
      (await get(`/api/apps/${APP_ID}/tables/books/records/${bookId}`, viaGroup.cookie)).status,
    ).toBe(404);
    // **付与行は1件も消えていない**(掃除の自動処理を作っていない)。
    expect(
      withDb((db) => db.query(`SELECT COUNT(*) AS n FROM "book_grant"`).get()) as unknown,
    ).toEqual({
      n: 3,
    });
  });

  test("(D-2) 直接の付与を持つ人は、グループ行が消えても今日どおり見える", async () => {
    expect((await removeRow("book_team", teamId)).status).toBe(204);
    expect(await listIds(`/api/apps/${APP_ID}/tables/books/records`, viaMember.cookie)).toEqual([
      bookId,
    ]);
  });

  test("(D-3) メンバー表の行を消したら見えなくなる", async () => {
    expect(await listIds(`/api/apps/${APP_ID}/tables/books/records`, viaMember.cookie)).toEqual([
      bookId,
    ]);
    expect((await removeRow("book_member", viaMemberMemberId)).status).toBe(204);
    expect(await listIds(`/api/apps/${APP_ID}/tables/books/records`, viaMember.cookie)).toEqual([]);
  });

  test("(D-4) ユーザを `_auth_users` から消しても、付与行もメンバー行も1件も消えない", async () => {
    const authStore = AuthStore.openForApp(dataRoot, APP_ID);
    try {
      authStore.deleteUser(viaMember.userId);
      expect(authStore.findUserById(viaMember.userId)).toBeUndefined();
    } finally {
      authStore.close();
    }
    expect(
      withDb((db) => db.query(`SELECT COUNT(*) AS n FROM "book_grant"`).get()) as unknown,
    ).toEqual({ n: 3 });
    expect(
      withDb((db) =>
        db.query(`SELECT COUNT(*) AS n FROM "book_member" WHERE "_id" = ?`).get(viaMemberMemberId),
      ) as unknown,
    ).toEqual({ n: 1 });
    // **セッションは消えるので、その cookie は認証を1度も通らない。**
    const res = await get(`/api/apps/${APP_ID}/tables/books/records`, viaMember.cookie);
    expect(res.status).toBe(401);
    // **他の人の見え方は1ミリも変わらない。**
    expect(await listIds(`/api/apps/${APP_ID}/tables/books/records`, viaGroup.cookie)).toEqual([
      bookId,
    ]);
  });

  test("(D-5) 【止めていない】消えた人のメンバー行の `account` を別の人に書き換えると、古い付与が復活する", async () => {
    const authStore = AuthStore.openForApp(dataRoot, APP_ID);
    try {
      authStore.deleteUser(viaMember.userId);
    } finally {
      authStore.close();
    }
    const newcomer = seedSession(dataRoot, APP_ID, { role: "editor", username: "newcomer" });
    // **新しい人には最初は1件も見えない。**
    expect(await listIds(`/api/apps/${APP_ID}/tables/books/records`, newcomer.cookie)).toEqual([]);
    // **残っていたメンバー行の `account` を書き換える。**
    const row = await get(
      `/api/apps/${APP_ID}/tables/book_member/records/${viaMemberMemberId}`,
      admin.cookie,
    );
    expect(row.status).toBe(200);
    const version = (await row.json()) as { record: { _updated_at: string } };
    const updated = await app.request(
      `/api/apps/${APP_ID}/tables/book_member/records/${viaMemberMemberId}`,
      {
        method: "PATCH",
        headers: {
          cookie: admin.cookie,
          origin: TEST_ORIGIN,
          "content-type": "application/json",
          "if-match": version.record._updated_at,
        },
        body: JSON.stringify({ account: newcomer.userId }),
      },
    );
    expect(updated.status).toBe(200);
    // **古い付与がそのまま効く。** **止めていない。**
    expect(await listIds(`/api/apps/${APP_ID}/tables/books/records`, newcomer.cookie)).toEqual([
      bookId,
    ]);
  });

  test("(D-6) 宣言していない表は、グループ行を消しても1バイトも変わらない", async () => {
    const created = await post(`/api/apps/${APP_ID}/tables/notes/records`, viaGroup.cookie, {
      body: "宣言していない表",
    });
    expect(created.status).toBe(201);
    expect((await removeRow("book_team", teamId)).status).toBe(204);
    expect(
      (await listIds(`/api/apps/${APP_ID}/tables/notes/records`, viaGroup.cookie)).length,
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (E) **守った線**(**本タスクが破っていないことを機械で固定する**)
// ---------------------------------------------------------------------------

describe("V7-M3-T05 (E): 守った線", () => {
  const APP_SOURCE = readFileSync(new URL("./app.ts", import.meta.url).pathname, "utf8");
  const OWNER_SCOPE_SOURCE = readFileSync(
    new URL("./owner-scope.ts", import.meta.url).pathname,
    "utf8",
  );

  test("(E-1) `app.ts` に `access_control` の綴りが1件も無い", () => {
    expect((APP_SOURCE.match(/access_control/g) ?? []).length).toBe(0);
  });

  test("(E-2) `judgeRecordAccess` の引数キーは6本のままである(`ADR-0294` §4 (c) の2 を破らない)", () => {
    // **グループ表の行の実在は、判定の**手前**(`grantsWithExistingGroups`)で解いた。**
    // **判定そのものの入力は (表, 行, actor, 付与行, 利用者行) に閉じたままである。**
    const signature = /export function judgeRecordAccess\(params: \{([\s\S]*?)\n\}\)/.exec(
      OWNER_SCOPE_SOURCE,
    );
    expect(signature).not.toBeNull();
    const keys = ((signature as RegExpExecArray)[1] ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => (line.split(":")[0] ?? "").trim());
    expect(keys).toEqual(["manifest", "tableId", "row", "actorId", "grantRows", "memberRows"]);
  });

  test("(E-3) `app.ts` が `judgeRecordAccess` に渡す付与行の出どころは3つだけである", () => {
    // **【この検査が守るもの】** —— **グループ行の実在の検査は判定の外に在るので、
    // 付与表の行を自分で読んで判定に渡す呼び出しを新しく書くと、検査を素通りできてしまう。**
    // **出どころを固定して、増えたら赤くする。**
    //
    // **【`V7-M4-T02`(`Z-G14`)による更新。旧文を1バイトも消していない】**
    // **旧の期待値には次の2行が入っていた**(**読取経路の配管がこの2行であった**):
    //   `"const { grantRows, memberRows } = recordAccessRows(source, manifest, tableId, sources);"`
    //   `"return (row) => judgeRecordAccess({ manifest, tableId, row, actorId, grantRows, memberRows });"`
    // **今日、読取経路の配管は `resolveRecordAccess`(`owner-scope.ts`)へ移った** ——
    // **`app.ts` はもう付与行を組み立てて判定へ渡していないので、この2行は実物に存在しない。**
    // **【緩めていない】** —— **消えた2行の行き先は下の (E-3b) が名指しで固定する。**
    const lines = APP_SOURCE.split("\n")
      .filter((line) => line.includes("grantRows"))
      .map((line) => line.trim())
      .sort();
    // **【`V7-M5-T02`(`Z-G19`)による更新。旧の期待値から1行も消していない】**
    // **旧は下の5行ちょうどであった。** **運営専用の口(`Z-G19`)が付与表の行を読むので
    // 2行増えた**(**7行**)。
    // **【増えた2行が何をしているか。名指しで書く】**
    //  - `const { grantRows } = recordAccessRows(source, manifest, tableId, accessSources);`
    //    —— **読み方は判定の配管とまったく同じ `recordAccessRows` 1本である**
    //    (**したがってこの2行も `grantsWithExistingGroups` を通った写しを受け取っている**)。
    //  - `isRecordWithoutGrants({ manifest, tableId, row, grantRows }),`
    //    —— **判定(`judgeRecordAccess`)にではなく、「その行を指す付与が0件か」を問う
    //    述語に渡している。** **突き合わせの本体は判定と共有した1本
    //    (`grantsTargetingRecord`)であり、第2の突き合わせを書いていない。**
    // **【緩めていない】** —— **出どころを固定する形も、行の綴りで突き合わせる強さも
    // 1ミリも変えていない。** **増えた2行を名指しで足しただけである。**
    expect(lines).toEqual(
      [
        // **配管の戻り値の型**(グループ表を通した写しを返すので `readonly`)。
        "readonly grantRows: readonly Record<string, unknown>[];",
        // **付与表の行が判定に届く唯一の道**(**グループ表の実在を通す**)。
        "grantRows: grantsWithExistingGroups({",
        "grantRows: rowsOf(sources.grantTable),",
        // **`POST` とバッチの `create` の下見**(**これから入れる1件の付与だけを渡す**。
        // **付与表を読んでいないので、グループの実在を通す必要が無い**)。
        "grantRows: [plan.previewGrant],",
        "grantRows: [plan.previewGrant],",
        // **【`V7-M5-T02` の差し戻し後による更新。旧の2行を消した理由をここに書く】**
        // **直前の版では、運営専用の口(`Z-G19`)が付与表を自分で読んでいたので、
        //   ここに次の2行が入っていた**:
        //   `"const { grantRows } = recordAccessRows(source, manifest, tableId, accessSources);"`
        //   `"isRecordWithoutGrants({ manifest, tableId, row, grantRows }),"`
        // **差し戻しで母集団を「引き継ぎのどの段にも付与が無い行」まで狭めた結果、
        //   口は付与表を自分で読まなくなり、`owner-scope.ts` の
        //   `resolveRecordWithoutGrants`(辿りも突き合わせも判定と同じ1本)へ渡すだけに
        //   なった。** **したがって `app.ts` に `grantRows` の行が2本減り、この一覧は
        //   `V7-M4-T04` 時点の5行へ戻った。**
        // **【緩めていない】** —— **`app.ts` が付与行を組み立てて判定へ渡す道は、今日は
        //   `POST` とバッチの下見の2件だけである。**
      ].sort(),
    );
  });

  /*
   * **【`V7-M4-T02`(`Z-G14`)が足した1本。(E-3) を緩めた埋め合わせである】**
   *
   * **読取経路の付与行は今日 `owner-scope.ts` の `resolveRecordAccess` が組み立てる。**
   * **そこでも `grantsWithExistingGroups` を通していなければ、消えたグループ行を指す付与が
   * 読取経路だけで復活する** —— **段0 でも親の段でも同じ整えを通すことを固定する。**
   */
  test("(E-3b) `resolveRecordAccess` も付与行を `grantsWithExistingGroups` に通してから判定へ渡す", () => {
    const at = OWNER_SCOPE_SOURCE.indexOf("export function resolveRecordAccess(");
    expect(at).toBeGreaterThan(0);
    const body = OWNER_SCOPE_SOURCE.slice(at, OWNER_SCOPE_SOURCE.indexOf("\n}\n", at));
    // **判定は1度だけ呼ばれ、その `grantRows` は整えを通した1本だけである。**
    expect(body.split("judgeRecordAccess(").length - 1).toBe(1);
    expect(body.split("grantsWithExistingGroups({").length - 1).toBe(1);
    const grantLines = body
      .split("\n")
      .filter((line) => line.includes("grantRows"))
      .map((line) => line.trim())
      .sort();
    // **【`V7-M4-T04`(`Z-G17`)による更新。旧文を1バイトも消していない】**
    //
    // **旧の期待値**:
    //   `["grantRows: grantsWithExistingGroups({", "grantRows: rowsOf(sources.grantTable),"]`
    //
    // **`V7-M4-T04` が「辿って読んだ行の件数」を数えるために、`rowsOf(...)` の結果を
    //   いったん `const grantRows` に受けた**(数えるには件数が要る)。**その結果、
    //   同じ1本が2行に分かれ、さらに件数を足す行が1本増えた。**
    // **【緩めていない】** —— **判定へ渡る `grantRows` が
    //   `grantsWithExistingGroups({` を通った1本だけであることは、上の2つの
    //   `expect(...).toBe(1)` と、この一覧に
    //   「`grantRows: rowsOf(sources.grantTable),`」のような**整えを迂回して判定へ渡す行**が
    //   1本も無いことで、今日も固定されている。**
    // **【`V7-M5-T02`(`Z-G19`)による更新。旧文を1バイトも消していない】**
    //
    // **旧の期待値**:
    //   `["const grantRows = rowsOf(sources.grantTable);", "grantRows,",`
    //   ` "grantRows: grantsWithExistingGroups({",`
    //   ` "traversedRows += grantRows.length + groupRows.length + memberRows.length;"]`
    //
    // **`V7-M5-T02` が**辿りそのもの**(訪問済み集合・段数・件数の上限)を
    //   `walkAccessInheritance` へ切り出した** —— **運営専用の口(`Z-G19`)が同じ辿りを
    //   通る必要が出たためである。** **その結果、行を読む2行(`rowsOf(...)` と件数を
    //   足す行)は `resolveRecordAccess` の本体から辿りの側へ移り、代わりに
    //   `const grantRows = step.grantRows;`(渡された1段ぶんを受ける行)が入った。**
    // **【緩めていない。要求を1本増やした】** —— **(1) 判定へ渡る `grantRows` が
    //   `grantsWithExistingGroups({` を通った1本だけであることは、上の2つの
    //   `expect(...).toBe(1)` と、この一覧に整えを迂回する行が1本も無いことで今日も
    //   固定されている。** **(2) 行を読む側(辿り)にも、判定へ整えずに渡す道が1本も
    //   無いことを、下で `walkAccessInheritance` の本体について別に固定する。**
    expect(grantLines).toEqual(
      [
        "const grantRows = step.grantRows;",
        "grantRows,",
        "grantRows: grantsWithExistingGroups({",
      ].sort(),
    );

    // **辿りの側**: **行を読んで件数を数えるのはここに在り、`grantsWithExistingGroups` も
    // `judgeRecordAccess` も1度も呼ばない**(= **整えを迂回して判定へ渡す道が無い**)。
    const walkAt = OWNER_SCOPE_SOURCE.indexOf("function walkAccessInheritance(");
    expect(walkAt).toBeGreaterThan(0);
    const walkBody = OWNER_SCOPE_SOURCE.slice(walkAt, OWNER_SCOPE_SOURCE.indexOf("\n}\n", walkAt));
    expect(walkBody).toContain(
      "traversedRows += stepGrantRows.length + stepGroupRows.length + stepMemberRows.length;",
    );
    expect(walkBody.split("judgeRecordAccess(").length - 1).toBe(0);
    expect(walkBody.split("grantsWithExistingGroups(").length - 1).toBe(0);
  });

  // **【`V8-M20` / 台帳 `J-G30` / `ADR-0301`】予約規約フィールドは 5本 → 4本。**
  // **`st_admin_readable` を廃止し、面の規則(役割 × 対象(表)× 読取)へ置き直した。**
  // **旧: `expect(... ).toBe(5);`(`ADMIN_READABLE_FIELD` を含んでいた)。**
  // **旧のテスト名: 「(E-4) 予約規約フィールドは5本のまま / `nonAdminTableAccess` は3値のまま」** ——
  // **名前に書いてあった「5本」は当時の実数なので、名前も直した。**
  // **`nonAdminTableAccess` が3値のままであることは今日も変わっていない。**
  // =====================================================================================
  // **【`V8-M27-T04` / `T-G5`。後半の期待値を反転させた。旧のテスト名と旧の期待値を残す】**
  //
  // **旧のテスト名**: `(E-4) 予約規約フィールドは4本(\`V8-M20\` で1本減った)/ \`nonAdminTableAccess\` は3値のまま`
  // **旧の期待値(逐語)**:
  //   expect(OWNER_SCOPE_SOURCE).toContain(
  //     'export type NonAdminTableAccess = "scoped" | "public" | "denied";',
  //   );
  // **上のコメントの1行「`nonAdminTableAccess` が3値のままであることは今日も変わっていない。」も
  // 旧である。1バイトも消していない。**
  //
  // **根拠**: **`V8-M27` / 台帳 `T-G5` / ユーザ決定 `D-V8-38`。** **型ごと撤去した。**
  //
  // **【この反転を書かないと、検査が「緑のまま嘘」になる。実測して確かめた】** ——
  // **撤去の記録として `owner-scope.ts` のコメントに旧の宣言が逐語で残っているので、
  // `toContain` は今日も真を返す。** **`grep` ではなく「コメント行を除いた実行行」で
  // 見なければ、実装から消えたことを測れない。**
  //
  // **予約規約フィールドが4本であることは1バイトも変えていない**(前半の1行)——
  // **`V8-M27` は予約規約フィールドを1本も足さず、1本も減らしていない。**
  // =====================================================================================
  test("(E-4) 予約規約フィールドは4本(`V8-M20` で1本減った)/ `nonAdminTableAccess` は実装から消えた", () => {
    expect((OWNER_SCOPE_SOURCE.match(/^export const [A-Z_]+_FIELD = /gm) ?? []).length).toBe(4);
    // **コメント行を除いた実行行で見る**(撤去の記録が逐語で残っているため)。
    expect(
      OWNER_SCOPE_SOURCE.split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .some((line) => line.includes("export type NonAdminTableAccess")),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (G) **消えたグループ行を指す付与行**(`01` §8 の15 の**2つ目**。**差し戻しの再実施**)
// ---------------------------------------------------------------------------
//
// **【なぜ足したか。逐語で書く】** —— **`CP-V7` の判定で `01` §8 の15 が不通過になった。**
// **§8 の15 は「`_auth_users` から消えたユーザの id を指す付与行、消えたグループ行を指す
// 付与行の**2つ**を、**別々に**扱う」と書いてあるが、`API`(HTTP)から測られていたのは
// 前者(上の (D-3) / (D-4) / (D-5))だけであった。**
// **上の (A) はグループ側を測っているが、**述語を直に呼ぶ単体の検査**である。**
// **(D-1) は HTTP でグループ行の削除を測っているが、**id の再利用**・**取り残しの口**・
// **消えたグループ行を指したままのメンバー行**の3つは1度も測っていない。**
// **本ブロックはグループ側を `API`(HTTP)だけで通しで測り直す。**
//
// **【重複を隠さない】** —— **(G-1) / (G-2) は (D-1) と測る対象が重なる。**
// **重なった分を (D-1) から消していない**(旧の検査を1バイトも弱めない)。
// ---------------------------------------------------------------------------

describe("V7-M8 (G): 消えたグループ行を指す付与行(`01` §8 の15 の2つ目)", () => {
  /** その行を指す付与行を DB から全部読む(**HTTP の外側での確認用**)。 */
  function grantRowsOf(recordId: string): Record<string, unknown>[] {
    return withDb((db) =>
      db.query(`SELECT * FROM "book_grant" WHERE "book" = ?`).all(recordId),
    ) as Record<string, unknown>[];
  }

  test("(G-1) グループへの付与1件で、そのグループに属する人がその行を 200 で読める", async () => {
    // **`beforeEach` が立てた付与は「`book_grant` の1行が `team` にグループ id を持つ」形
    // だけである**(`viaGroup` を名指しした付与行は1件も無い)。
    const viaTeam = grantRowsOf(bookId).filter((row) => row.team === teamId);
    expect(viaTeam.length).toBe(1);
    expect(viaTeam[0]?.member).toBeNull();
    expect(grantRowsOf(bookId).some((row) => row.member === viaGroupMemberId)).toBe(false);

    const single = await get(`/api/apps/${APP_ID}/tables/books/records/${bookId}`, viaGroup.cookie);
    expect(single.status).toBe(200);
    expect(((await single.json()) as { record: { _id: string } }).record._id).toBe(bookId);
    expect(await listIds(`/api/apps/${APP_ID}/tables/books/records`, viaGroup.cookie)).toEqual([
      bookId,
    ]);
  });

  test("(G-2) グループ行を消すと読めなくなる(404)—— **付与行は1件も消えない**", async () => {
    const before = grantRowsOf(bookId).length;
    expect(before).toBe(3);

    expect((await removeRow("book_team", teamId)).status).toBe(204);

    const single = await get(`/api/apps/${APP_ID}/tables/books/records/${bookId}`, viaGroup.cookie);
    expect(single.status).toBe(404);
    expect(await listIds(`/api/apps/${APP_ID}/tables/books/records`, viaGroup.cookie)).toEqual([]);

    // **付与行は残っている** —— **件数も、消えたグループ id を指したままの1行も、実測する。**
    const after = grantRowsOf(bookId);
    expect(after.length).toBe(before);
    expect(after.filter((row) => row.team === teamId).length).toBe(1);
    // **グループ表の側は本当に消えている。**
    expect(
      withDb((db) => db.query(`SELECT COUNT(*) AS n FROM "book_team" WHERE "_id" = ?`).get(teamId)),
    ).toEqual({ n: 0 });
  });

  test("(G-3) 同じ名前でグループ行を作り直しても権限は復活しない(`_id` は UUID で再利用されない)", async () => {
    /*
     * **【`_id` が再利用されない根拠。自分で `grep -n` して探した。パス:行番号 + 逐語】**
     *
     *  - **`src/kernel/records.ts:900`** —— 逐語: **`  const id = crypto.randomUUID();`**
     *  - **`src/kernel/records.ts:876`**(同じ関数の doc コメント)—— 逐語:
     *    **` * レコードを1件作成する。\`_id\` は \`crypto.randomUUID()\` で発行し、`**
     *
     * **`grep -n "crypto.randomUUID()" src/kernel/records.ts` が返したのはこの2行だけである。**
     * **業務データの行の `_id` を採番している箇所は、このリポジトリではここ1本である。**
     * **`crypto.randomUUID()` は乱数版(v4)の UUID を返す** —— **連番でも `AUTOINCREMENT`
     * でもないので、消した行の `_id` が次の行に割り当てられる道が無い。**
     * **【禁止。ここでも書かない】「衝突しない」とは書かない**(上の (C) と同じ線)。
     *
     * **【見つからなかったもの。正直に書く】** —— **「グループ行の `_id` に限って別の採番を
     * している」実装は探したが見つからなかった。** **グループ表(`book_team`)は普通の表で
     * あり、`createRecord` を通る。** **したがって下の実測は `createRecord` の採番そのもの
     * を測っている。**
     */
    expect((await removeRow("book_team", teamId)).status).toBe(204);

    // **同じ名前(`第1班`)で作り直す。** **HTTP から作る。**
    const recreated = await post(`/api/apps/${APP_ID}/tables/book_team/records`, admin.cookie, {
      title: "第1班",
    });
    expect(recreated.status).toBe(201);
    const newTeamId = ((await recreated.json()) as { record: { _id: string } }).record._id;
    expect(newTeamId).not.toBe(teamId);
    // **UUID の形である**(8-4-4-4-12。版は4)。
    expect(newTeamId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    // **名前が同じでも、付与行が指しているのは古い `_id` のままである。**
    expect(grantRowsOf(bookId).filter((row) => row.team === teamId).length).toBe(1);
    expect(grantRowsOf(bookId).filter((row) => row.team === newTeamId).length).toBe(0);

    // **復活しない。**
    expect(
      (await get(`/api/apps/${APP_ID}/tables/books/records/${bookId}`, viaGroup.cookie)).status,
    ).toBe(404);
    expect(await listIds(`/api/apps/${APP_ID}/tables/books/records`, viaGroup.cookie)).toEqual([]);
  });

  test("(G-4) メンバー行の `team` が消えたグループ行を指したままでも、判定は壊れず、その人には届かない", async () => {
    expect((await removeRow("book_team", teamId)).status).toBe(204);

    // **既存のメンバー行**(`viaGroup`)**は消えたグループ id を指したままである。**
    expect(
      withDb((db) =>
        db.query(`SELECT "team" AS t FROM "book_member" WHERE "_id" = ?`).get(viaGroupMemberId),
      ),
    ).toEqual({ t: teamId });

    // **【実測が想定と違った。丸めない】** —— **「消えたグループ id を指すメンバー行を
    // あとから新しく1行足す」ことは、今日はできない。** **参照の実在検査(`records.ts` の
    // `validateInput`)が 400 で拒否する。** **つまり「消えたグループを指すメンバー行」は、
    // **先に作った行のグループがあとから消えた**場合にしか生まれない。**
    const late = seedSession(dataRoot, APP_ID, { role: "editor", username: "late-comer" });
    const rejected = await post(`/api/apps/${APP_ID}/tables/book_member/records`, admin.cookie, {
      account: late.userId,
      team: teamId,
    });
    expect(rejected.status).toBe(400);
    const rejectedBody = (await rejected.json()) as { errors: { path: string; message: string }[] };
    expect(rejectedBody.errors[0]).toEqual({
      path: "/team",
      message: `フィールド "team" が参照するレコード "${teamId}" はテーブル "book_team" に存在しません。`,
      hint: '先に "book_team" にレコードを作成し、その _id を指定してください。',
    } as unknown as { path: string; message: string });
    expect(
      withDb((db) =>
        db.query(`SELECT COUNT(*) AS n FROM "book_member" WHERE "account" = ?`).get(late.userId),
      ),
    ).toEqual({ n: 0 });

    // **判定は 500 にならず 200 / 404 を返す**(= 壊れていない)。
    // **`late` は付与にも利用者表にも1件も居ないので、宣言した表が1件も見えないだけである。**
    for (const who of [viaGroup, late]) {
      const list = await get(`/api/apps/${APP_ID}/tables/books/records`, who.cookie);
      expect(list.status).toBe(200);
      expect(((await list.json()) as { records: unknown[] }).records).toEqual([]);
      expect(
        (await get(`/api/apps/${APP_ID}/tables/books/records/${bookId}`, who.cookie)).status,
      ).toBe(404);
    }

    // **直接の付与を持つ人は1ミリも巻き込まれない**(判定そのものは今日どおり動いている)。
    expect(await listIds(`/api/apps/${APP_ID}/tables/books/records`, viaMember.cookie)).toEqual([
      bookId,
    ]);
  });

  test("(G-5) 誰にも見えなくなった行は、運営専用の口に**並ばない**(付与が0件ではないため)", async () => {
    // **測定台を作る** —— **付与が「消えたグループを指す1件」だけの行。**
    const created = await post(`/api/apps/${APP_ID}/tables/books/records`, admin.cookie, {
      title: "グループだけの本",
    });
    expect(created.status).toBe(201);
    const soloId = ((await created.json()) as { record: { _id: string } }).record._id;

    // **作成者(運営)への付与が1件自動で入っているので、それを消す。**
    const creatorGrant = grantRowsOf(soloId);
    expect(creatorGrant.length).toBe(1);
    expect((await removeRow("book_grant", creatorGrant[0]?._id as string)).status).toBe(204);

    // **新しいグループを作り、そこへ付与し、そのグループに人を入れる。**
    const team2 = await post(`/api/apps/${APP_ID}/tables/book_team/records`, admin.cookie, {
      title: "第2班",
    });
    expect(team2.status).toBe(201);
    const team2Id = ((await team2.json()) as { record: { _id: string } }).record._id;
    const granted = await post(`/api/apps/${APP_ID}/tables/book_grant/records`, admin.cookie, {
      book: soloId,
      team: team2Id,
      permission: "writer",
    });
    expect(granted.status).toBe(201);
    withDb((db) => {
      const row = createRecord(db, manifest(), "book_member", {
        account: viaMember.userId,
        team: team2Id,
      });
      expect(row.ok).toBe(true);
    });
    // **消す前は見えている。**
    expect(
      (await listIds(`/api/apps/${APP_ID}/tables/books/records`, viaMember.cookie)).includes(
        soloId,
      ),
    ).toBe(true);

    // **グループ行を消す** —— **この行を指す付与は「消えたグループを指す1件」だけになる。**
    expect((await removeRow("book_team", team2Id)).status).toBe(204);

    // **誰にも見えない。** **運営(`owner`)にも見えない**(**これは想定と違った実測である。
    // 予約ロールの `owner` は、宣言した表の付与の判定を素通りしない**)。
    for (const who of [viaMember, viaGroup, admin]) {
      expect(
        (await listIds(`/api/apps/${APP_ID}/tables/books/records`, who.cookie)).includes(soloId),
      ).toBe(false);
      expect(
        (await get(`/api/apps/${APP_ID}/tables/books/records/${soloId}`, who.cookie)).status,
      ).toBe(404);
    }

    // **それでも運営専用の口には並ばない。**
    // **【なぜ並ばないか】** —— **この口の母集団は「その行を指す付与が0件の行」であり、
    // この行の付与は1件在る**(相手のグループ行が消えているだけである)。
    // **`app.ts` の doc コメントが同じことを自認している(逐語)**:
    // 「**付与は在るが相手が解決できない行(相手のメンバー行が消えた行)は、この口に
    //   1件も並ばない** —— **付与が0件ではないためである。**」
    // **本検査は、その自認が**グループ行**が消えた場合にも当てはまることを実測した。**
    const door = await get(`/api/apps/${APP_ID}/tables/books/unreachable-records`, admin.cookie);
    expect(door.status).toBe(200);
    const listed = ((await door.json()) as { records: { _id: string }[] }).records.map(
      (row) => row._id,
    );
    expect(listed).not.toContain(soloId);
    expect(grantRowsOf(soloId).length).toBe(1);

    // **対照: 付与が本当に0件の行は、同じ口に並ぶ**(口そのものは今日も働いている)。
    const control = await post(`/api/apps/${APP_ID}/tables/books/records`, admin.cookie, {
      title: "付与0件の本",
    });
    expect(control.status).toBe(201);
    const controlId = ((await control.json()) as { record: { _id: string } }).record._id;
    const controlGrant = grantRowsOf(controlId);
    expect(controlGrant.length).toBe(1);
    expect((await removeRow("book_grant", controlGrant[0]?._id as string)).status).toBe(204);
    expect(
      await listIds(`/api/apps/${APP_ID}/tables/books/unreachable-records`, admin.cookie),
    ).toEqual([controlId]);
    // **【残る限界。正直に書く】** —— **したがって「グループ行が消えたせいで誰にも
    // 見えなくなった行」を運営が見つける道は、今日は1本も無い。**
    // **`Z-G19` の口は付与0件の行しか拾わない。**
  });
});
