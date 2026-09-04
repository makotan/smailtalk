/**
 * **`V7-M3-T03`(`Z-G5`)**: **付与を作れる相手を絞る。**
 *
 * **`D-V7-14` の逐語**: **「付与を作れるのは、その行の作成者(`st_owner` 相当)とアプリの
 * 運営ロールだけである」。**
 *
 * ## **本ファイルが固定するもの**
 *
 *  1. **付与表への `POST` / `PATCH` / `DELETE` が、付与行の指す**保護対象の行**への
 *     権限で絞られること。**
 *  2. **自分に権限を付ける要求が拒否されること**(**運営ロールも例外にしない**。判断と理由は
 *     `docs/plan/v7/records/v7-m3.md` §2-3)。
 *  3. **メンバー表(またはグループ表)の行を指さない付与が拒否されること**
 *     (`ADR-0016` 却下 (iv) の逐語「他人の id を詰めて送る spoof で任意の行を他人名義に
 *     できる / 自分名義に奪える」の線を、付与の作成でも守る)。
 *
 * ## **「その行の作成者」をどう判定したか(自分で決めた。記録にも書く)**
 *
 * **採った案 = (b) `creator_permission` の付与を持っていること。**
 * **`access_control.creator_permission` は schema の `required` に入っており、宣言した表には
 * 必ず在る。** **`V7-M3-T02` が、行を作った人にその権限名の付与を1件入れる。**
 * **したがって「その行への `creator_permission` の付与を(直接またはグループ経由で)持って
 * いる人」= 作成者である。**
 *
 * **採らなかった案**:
 *  - **(a) `st_owner` の値** —— **`st_owner` を持たない表では成立しない**(アクセス権管理を
 *    宣言する表に `st_owner` がある保証は1つも無い)。**さらに `ADR-0016` 実装追記 (C) の
 *    共有化(`st_owner` を null にする)で、作成者の記録が消える。**
 *  - **(c) 保護対象行に作成者を別に記録する** —— **予約規約フィールドが6本目になる**
 *    (`ADR-0294` 限定17 =「5本のまま」)。**採れない。**
 *
 * **【この案の限界。先に書く(憲法6)】** —— **作成者は `creator_permission` を他人にも
 * 渡せる。** **渡された人はこの判定では作成者と区別が付かない。** **本ファイルの (A-9) が
 * それを実測して固定している** —— **止めていない。**
 *
 * ## **本ファイルが測っていないもの**
 *
 *  - **MCP / 受信口 / ワークフロー / 島**から付与表に書く経路(`Z-G21`〜`Z-G24`)。
 *    **今日も素通りする。** **1バイトも掛けていない。**
 *  - **メンバー表・グループ表そのものへの書込。** **誰でも自分のメンバー行を作れ、
 *    グループを付け替えられる。** **本ファイルはそれを1ミリも止めていない。**
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { judgeGrantWrite } from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "grant-authority";

const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる", read: true, write: true, delete: false },
  { id: "keeper", name: "作った人", read: true, write: true, delete: true },
] as const;

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "付与を作れる相手",
      // **宣言された役割を1つ置く**(`ADR-0158`)—— **運営3ロールでない人が
      // records API を通れるようにするためである**(`V7-M2-T03` が開いた側)。
      // **【`V8-M29` 第2波】旧(逐語)**: `user_kinds: [{ id: "guest", name: "利用者" }],`
      // **語彙 `app.user_kinds` は廃止された** —— **代わりに立つのは `app.roles`
      // (差分操作 `set_roles`)である。****宣言そのものは `manifestWithRoles()` の
      // `roles` に移した**(役割の宣言は1箇所に束ねる)。
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
          // **付与表そのものは `access_control` を1バイトも宣言していない** ——
          // **保護対象表の `grant.table` に名指しされているだけである。**
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
 * **【`V8-M26`】面(役割に束ねた権限)の既定が閉じたので、題材に規則を足したもの。**
 *
 * **足すのは補助表(付与表 `book_grant` / 利用者表 `book_member` / グループ表 `book_team`)と、
 * `access_control` を1バイトも宣言していない普通の表(`notes`)だけである。**
 *
 * **保護対象の `books` には1本も足さない**(`skipTables`)—— **面と点は
 * `combineRoleAndGrantAccess` が `OR` で重ねるので、面を開けると本ファイルが測っている
 * 点(行ごとの付与)の答えが丸ごと通り、測定が無効になる。**
 *
 * **`editor` の `book_grant` だけを手で書いている** —— **既定の自動付与
 * (`src/kernel/apply-diff.ts` の `DEFAULT_ROLE_RULE_VERBS`)は編集者に `delete` を配らず、
 * それでは (B-8) の「作成者は自分の付与を消せる」が面で止まって測れないからである。**
 * **【正直に書く】これは `V8-M26` が変えたことの1つである** —— **差分で作った実アプリでは、
 * 編集者は付与表の行を消せない。**
 */
function manifestWithRoles(): Manifest {
  const base = manifest() as unknown as { app: Record<string, unknown> };
  base.app.roles = [
    { id: "owner", name: "持ち主" },
    {
      id: "editor",
      name: "編集者",
      rules: [{ target: "table", table: "book_grant", can: ["read", "write", "delete"] }],
    },
    { id: "viewer", name: "閲覧者" },
    // **【`V8-M29` 第2波】旧(逐語)**: `user_kinds: [{ id: "guest", name: "利用者" }],`
    // **`manifest()` の `app.user_kinds` に在った1本の置き換え先である。**
    // **規則(`rules`)は1本も書かない** —— **`withDefaultRoleRules` が規則を足すのは
    // 既定3役割だけなので、`guest` の面は閉じたままであり、(B-12) の 403 は今日も出る。**
    { id: "guest", name: "利用者" },
  ];
  return withDefaultRoleRules(base as unknown as Manifest, { skipTables: ["books"] });
}

// ---------------------------------------------------------------------------
// (A) 述語 `judgeGrantWrite` —— **I/O を持たない。行は呼び出し側が渡す**
// ---------------------------------------------------------------------------

/** 述語に渡す行の器(表ID → 行の配列)。**HTTP と同じ形の行を手で組む。** */
type Rows = Record<string, Record<string, unknown>[]> & {
  books: Record<string, unknown>[];
  book_team: Record<string, unknown>[];
  book_member: Record<string, unknown>[];
  book_grant: Record<string, unknown>[];
};

const ACTOR = "user-creator";
const OTHER = "user-other";

function fixture(): {
  rows: Rows;
  readRows: (tableId: string) => readonly Record<string, unknown>[];
  readRow: (tableId: string, recordId: string) => Record<string, unknown> | undefined;
} {
  const rows: Rows = {
    books: [{ _id: "book-1", title: "作成者のいる本" }],
    book_team: [{ _id: "team-1", title: "第1班" }],
    book_member: [
      { _id: "member-creator", account: ACTOR, team: null },
      { _id: "member-other", account: OTHER, team: "team-1" },
    ],
    book_grant: [
      {
        _id: "grant-1",
        book: "book-1",
        member: "member-creator",
        team: null,
        permission: "keeper",
      },
    ],
  };
  return {
    rows,
    readRows: (tableId) => rows[tableId] ?? [],
    readRow: (tableId, recordId) => (rows[tableId] ?? []).find((row) => row._id === recordId),
  };
}

function judge(params: {
  rows?: Rows;
  op?: "create" | "update" | "delete";
  values: Record<string, unknown>;
  actorId?: string | null;
  role?: string | null;
  tableId?: string;
}) {
  const base = fixture();
  const rows = params.rows ?? base.rows;
  return judgeGrantWrite({
    manifest: manifest(),
    tableId: params.tableId ?? "book_grant",
    op: params.op ?? "create",
    values: params.values,
    actorId: params.actorId === undefined ? ACTOR : params.actorId,
    role: (params.role === undefined ? "editor" : params.role) as never,
    readRows: (tableId) => rows[tableId] ?? [],
    readRow: (tableId, recordId) => (rows[tableId] ?? []).find((row) => row._id === recordId),
  });
}

describe("V7-M3-T03 (A): 誰が付与を作れるか", () => {
  test("(A-1) 付与表として名指しされていない表は undefined(今日どおり = 何も掛からない)", () => {
    expect(judge({ tableId: "notes", values: { body: "ふつうの行" } })).toBeUndefined();
    expect(judge({ tableId: "books", values: { title: "ふつうの行" } })).toBeUndefined();
  });

  test("(A-2) その行の作成者(creator_permission を持つ人)は、他人への付与を作れる", () => {
    expect(
      judge({ values: { book: "book-1", member: "member-other", permission: "reader" } }),
    ).toEqual({ kind: "allowed" });
  });

  test("(A-3) 付与を1件も持たない第三者は、対象の行が見えないので拒否される(存在を伏せる)", () => {
    expect(
      judge({
        actorId: OTHER,
        role: "guest",
        values: { book: "book-1", member: "member-creator", permission: "reader" },
      }),
    ).toEqual({ kind: "invisible_target", tableId: "books", recordId: "book-1" });
  });

  test("(A-4) 読むだけの付与を持つ人は、対象が見えるが作成者ではないので拒否される", () => {
    const base = fixture();
    base.rows.book_grant.push({
      _id: "grant-2",
      book: "book-1",
      member: "member-other",
      team: null,
      permission: "reader",
    });
    expect(
      judge({
        rows: base.rows,
        actorId: OTHER,
        role: "guest",
        values: { book: "book-1", member: "member-creator", permission: "writer" },
      }),
    ).toEqual({ kind: "not_creator" });
  });

  test("(A-5) 書ける付与(writer)を持つ人も、作成者ではないので付与は作れない", () => {
    const base = fixture();
    base.rows.book_grant.push({
      _id: "grant-2",
      book: "book-1",
      member: "member-other",
      team: null,
      permission: "writer",
    });
    expect(
      judge({
        rows: base.rows,
        actorId: OTHER,
        role: "guest",
        values: { book: "book-1", member: "member-creator", permission: "writer" },
      }),
    ).toEqual({ kind: "not_creator" });
  });

  test("(A-6) 運営ロール(owner)は、付与を1件も持たなくても作れる", () => {
    expect(
      judge({
        actorId: OTHER,
        role: "owner",
        values: { book: "book-1", member: "member-creator", permission: "reader" },
      }),
    ).toEqual({ kind: "allowed" });
  });

  test("(A-7) editor / viewer は無条件には通らない —— 作成者かどうかで決まる", () => {
    // **`v7-m0.md` §6-2b の1 の裁定(運営ロール = editor / owner)より狭い側に倒している。**
    // **理由は `owner-scope.ts` の `GRANT_WRITE_ADMIN_ROLES` の doc**(逐語: 付与表は
    // `nonAdminTableAccess` が `"denied"` を返す普通の表なので、判定に届くのは
    // `editor` と `owner` だけ。`editor` も無条件に通すと本判定は誰1人拒否しない)。
    const measured = ["editor", "viewer"].map((role) => ({
      role,
      verdict: judge({
        actorId: OTHER,
        role,
        values: { book: "book-1", member: "member-creator", permission: "reader" },
      }),
    }));
    expect(measured).toEqual([
      {
        role: "editor",
        verdict: { kind: "invisible_target", tableId: "books", recordId: "book-1" },
      },
      {
        role: "viewer",
        verdict: { kind: "invisible_target", tableId: "books", recordId: "book-1" },
      },
    ]);
  });

  test("(A-8) 自分に権限を付ける要求は、作成者でも運営ロールでも拒否される", () => {
    const measured = [
      { who: "作成者", verdict: judge({ values: { book: "book-1", member: "member-creator" } }) },
      {
        who: "運営(owner)",
        verdict: judge({
          actorId: OTHER,
          role: "owner",
          values: { book: "book-1", member: "member-other", permission: "keeper" },
        }),
      },
    ];
    expect(measured).toEqual([
      { who: "作成者", verdict: { kind: "self" } },
      { who: "運営(owner)", verdict: { kind: "self" } },
    ]);
  });

  test("(A-9) 【限界】creator_permission を渡された人は、作成者と区別が付かない(止めていない)", () => {
    const base = fixture();
    base.rows.book_grant.push({
      _id: "grant-2",
      book: "book-1",
      member: "member-other",
      team: null,
      permission: "keeper",
    });
    expect(
      judge({
        rows: base.rows,
        actorId: OTHER,
        role: "guest",
        values: { book: "book-1", member: "member-creator", permission: "writer" },
      }),
    ).toEqual({ kind: "allowed" });
  });

  test("(A-10) メンバー表に無い相手を指した付与は拒否される", () => {
    expect(
      judge({ values: { book: "book-1", member: "member-does-not-exist", permission: "reader" } }),
    ).toEqual({ kind: "unknown_holder" });
  });

  test("(A-11) 相手もグループも書いていない付与は拒否される", () => {
    expect(judge({ values: { book: "book-1", permission: "reader" } })).toEqual({
      kind: "unknown_holder",
    });
  });

  test("(A-12) グループ表に無いグループを指した付与は拒否される / 実在するグループは通る", () => {
    expect(
      judge({ values: { book: "book-1", team: "team-does-not-exist", permission: "reader" } }),
    ).toEqual({ kind: "unknown_holder" });
    expect(judge({ values: { book: "book-1", team: "team-1", permission: "reader" } })).toEqual({
      kind: "allowed",
    });
  });

  test("(A-13) 【限界】自分の属するグループへの付与は止めていない(自分に効く付与が作れる)", () => {
    const base = fixture();
    base.rows.book_member[0] = { _id: "member-creator", account: ACTOR, team: "team-1" };
    expect(
      judge({ rows: base.rows, values: { book: "book-1", team: "team-1", permission: "writer" } }),
    ).toEqual({ kind: "allowed" });
  });

  test("(A-14) 対象の行を指していない付与は拒否される(どの行への権限か決まらない)", () => {
    expect(judge({ values: { member: "member-other", permission: "reader" } })).toEqual({
      kind: "no_target",
    });
    expect(judge({ values: { book: "book-does-not-exist", member: "member-other" } })).toEqual({
      kind: "no_target",
    });
  });

  test("(A-15) actor が特定できない実行は拒否される(fail-closed)", () => {
    expect(
      judge({
        actorId: null,
        role: null,
        values: { book: "book-1", member: "member-other", permission: "reader" },
      }),
      // **匿名は「見えない」に倒れる** —— **`judgeRecordAccess` が `actorId === null` を
      // 3つとも false にするためである**(`ADR-0294` §限界10)。**403 ではなく 404 側になる。**
    ).toEqual({ kind: "invisible_target", tableId: "books", recordId: "book-1" });
  });

  test("(A-16) DELETE は「自分を指す付与」を止めない(自分の権限を手放せる)", () => {
    expect(
      judge({
        op: "delete",
        values: { _id: "grant-1", book: "book-1", member: "member-creator", permission: "keeper" },
      }),
    ).toEqual({ kind: "allowed" });
  });

  test("(A-17) 第三者は他人の付与を消せない(存在を伏せる)", () => {
    expect(
      judge({
        op: "delete",
        actorId: OTHER,
        role: "guest",
        values: { _id: "grant-1", book: "book-1", member: "member-creator", permission: "keeper" },
      }),
    ).toEqual({ kind: "invisible_target", tableId: "books", recordId: "book-1" });
  });
});

// ---------------------------------------------------------------------------
// (B) HTTP —— **実サーバ・実 SQLite。画面ではなく API から**
// ---------------------------------------------------------------------------

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
/**
 * 行を作る人 / 何も持たない第三者 / 読むだけの人 / 運営(`owner`)。
 *
 * **第三者と読むだけの人も `editor` である** —— **付与表は `nonAdminTableAccess` が
 * `"denied"` を返す普通の表なので、宣言された利用者の種類(`guest`)や `viewer` は
 * 中継層の 403 で止まり、本タスクの判定に1度も届かないためである**(実測は (B-12))。
 */
let creator: ReturnType<typeof seedSession>;
let stranger: ReturnType<typeof seedSession>;
let reader: ReturnType<typeof seedSession>;
let admin: ReturnType<typeof seedSession>;
let creatorMemberId = "";
let strangerMemberId = "";
let readerMemberId = "";
let adminMemberId = "";
let bookId = "";

function withDb<T>(run: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

async function post(path: string, cookie: string, body: unknown): Promise<Response> {
  return await app.request(path, {
    method: "POST",
    headers: { cookie, origin: TEST_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function patch(
  path: string,
  cookie: string,
  ifMatch: string,
  body: unknown,
): Promise<Response> {
  return await app.request(path, {
    method: "PATCH",
    headers: {
      cookie,
      origin: TEST_ORIGIN,
      "content-type": "application/json",
      "if-match": ifMatch,
    },
    body: JSON.stringify(body),
  });
}

async function remove(path: string, cookie: string, ifMatch: string): Promise<Response> {
  return await app.request(path, {
    method: "DELETE",
    headers: { cookie, origin: TEST_ORIGIN, "if-match": ifMatch },
  });
}

function grantRows(): { _id: string; member: string | null; permission: string }[] {
  return withDb(
    (db) =>
      db.query("SELECT _id, member, permission FROM book_grant ORDER BY rowid").all() as {
        _id: string;
        member: string | null;
        permission: string;
      }[],
  );
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-acgw-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "付与を作れる相手", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, manifestWithRoles()).valid).toBe(true);
  app = createServerApp({ dataRoot });
  creator = seedSession(dataRoot, APP_ID, { role: "editor", username: "creator" });
  stranger = seedSession(dataRoot, APP_ID, { role: "editor", username: "stranger" });
  reader = seedSession(dataRoot, APP_ID, { role: "editor", username: "reader" });
  admin = seedSession(dataRoot, APP_ID, { role: "owner", username: "admin" });

  const loaded = manifest();
  withDb((db) => {
    const member = (account: string): string => {
      const created = createRecord(db, loaded, "book_member", { account });
      expect(created.ok).toBe(true);
      return (created as { value: { _id: string } }).value._id;
    };
    creatorMemberId = member(creator.userId);
    strangerMemberId = member(stranger.userId);
    readerMemberId = member(reader.userId);
    adminMemberId = member(admin.userId);
  });
  // **行は HTTP の `POST` で作る** —— **作成者への付与(`creator_permission`)が
  // `V7-M3-T02` の経路で1件入ることを、この後の判定の前提にするためである。**
  const created = await post(`/api/apps/${APP_ID}/tables/books/records`, creator.cookie, {
    title: "作成者のいる本",
  });
  expect(created.status).toBe(201);
  bookId = ((await created.json()) as { record: { _id: string } }).record._id;
  // 読むだけの人に `reader` の付与を1件入れる(作成者が作る = 通る形)。
  const granted = await post(`/api/apps/${APP_ID}/tables/book_grant/records`, creator.cookie, {
    book: bookId,
    member: readerMemberId,
    permission: "reader",
  });
  expect(granted.status).toBe(201);
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

describe("V7-M3-T03 (B): 付与表への書込を API から測る", () => {
  test("(B-1) 行の作成者は、他人への付与を作れる(201)", async () => {
    const response = await post(`/api/apps/${APP_ID}/tables/book_grant/records`, creator.cookie, {
      book: bookId,
      member: strangerMemberId,
      permission: "writer",
    });
    expect(response.status).toBe(201);
    expect(grantRows().map((row) => ({ member: row.member, permission: row.permission }))).toEqual([
      { member: creatorMemberId, permission: "keeper" },
      { member: readerMemberId, permission: "reader" },
      { member: strangerMemberId, permission: "writer" },
    ]);
  });

  test("(B-2) 付与も何も持たない第三者の付与作成は 404(存在を伏せる)で、1行も増えない", async () => {
    const before = grantRows().length;
    const response = await post(`/api/apps/${APP_ID}/tables/book_grant/records`, stranger.cookie, {
      book: bookId,
      member: strangerMemberId,
      permission: "keeper",
    });
    expect(response.status).toBe(404);
    expect(grantRows().length).toBe(before);
  });

  test("(B-3) 読むだけの付与を持つ人の付与作成は 403 で、文言に内部記号が1文字も無い", async () => {
    const response = await post(`/api/apps/${APP_ID}/tables/book_grant/records`, reader.cookie, {
      book: bookId,
      member: strangerMemberId,
      permission: "keeper",
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { errors: { message: string; hint?: string }[] };
    expect(body.errors[0]?.message).toBe(
      "この行の権限を他の人に渡せるのは、この行を作った人と運営者だけです。",
    );
    const text = JSON.stringify(body);
    for (const symbol of [
      "access_control",
      "Z-G",
      "judgeRecordAccess",
      "judgeGrantWrite",
      "book_grant",
      "creator_permission",
    ]) {
      expect({ symbol, leaked: text.includes(symbol) }).toEqual({ symbol, leaked: false });
    }
  });

  test("(B-4) 自分に権限を付ける要求は 403(運営ロールでも同じ)", async () => {
    const measured: { who: string; status: number }[] = [];
    const asCreator = await post(`/api/apps/${APP_ID}/tables/book_grant/records`, creator.cookie, {
      book: bookId,
      member: creatorMemberId,
      permission: "keeper",
    });
    measured.push({ who: "作成者", status: asCreator.status });
    const asAdmin = await post(`/api/apps/${APP_ID}/tables/book_grant/records`, admin.cookie, {
      book: bookId,
      member: adminMemberId,
      permission: "keeper",
    });
    measured.push({ who: "運営(owner)", status: asAdmin.status });
    expect(measured).toEqual([
      { who: "作成者", status: 403 },
      { who: "運営(owner)", status: 403 },
    ]);
    const body = (await asAdmin.json()) as { errors: { message: string }[] };
    expect(body.errors[0]?.message).toBe("自分に権限を付けることはできません。");
  });

  test("(B-5) メンバー表の行を指さない付与は拒否される(相手が空 / 実在しない id)", async () => {
    const empty = await post(`/api/apps/${APP_ID}/tables/book_grant/records`, creator.cookie, {
      book: bookId,
      permission: "writer",
    });
    const bogus = await post(`/api/apps/${APP_ID}/tables/book_grant/records`, creator.cookie, {
      book: bookId,
      member: "00000000-0000-4000-8000-000000000000",
      permission: "writer",
    });
    expect({ empty: empty.status, bogus: bogus.status }).toEqual({ empty: 400, bogus: 400 });
    const body = (await empty.json()) as { errors: { message: string }[] };
    expect(body.errors[0]?.message).toBe(
      "権限を渡す相手が、このアプリの利用者として登録されていません。",
    );
  });

  test("(B-6) 運営ロールは、付与を1件も持たない行にも他人への付与を作れる(201)", async () => {
    const response = await post(`/api/apps/${APP_ID}/tables/book_grant/records`, admin.cookie, {
      book: bookId,
      member: strangerMemberId,
      permission: "reader",
    });
    expect(response.status).toBe(201);
  });

  test("(B-7) PATCH —— 第三者は 404 / 作成者は通る / 自分に付け替える PATCH は 403", async () => {
    const target = grantRows().find((row) => row.member === readerMemberId) as { _id: string };
    const etag = withDb(
      (db) =>
        (
          db.query("SELECT _updated_at AS v FROM book_grant WHERE _id = ?").get(target._id) as {
            v: string;
          }
        ).v,
    );
    const byStranger = await patch(
      `/api/apps/${APP_ID}/tables/book_grant/records/${target._id}`,
      stranger.cookie,
      etag,
      { permission: "keeper" },
    );
    const byCreator = await patch(
      `/api/apps/${APP_ID}/tables/book_grant/records/${target._id}`,
      creator.cookie,
      etag,
      { permission: "writer" },
    );
    const nextEtag = withDb(
      (db) =>
        (
          db.query("SELECT _updated_at AS v FROM book_grant WHERE _id = ?").get(target._id) as {
            v: string;
          }
        ).v,
    );
    const toSelf = await patch(
      `/api/apps/${APP_ID}/tables/book_grant/records/${target._id}`,
      creator.cookie,
      nextEtag,
      { member: creatorMemberId },
    );
    expect({
      byStranger: byStranger.status,
      byCreator: byCreator.status,
      toSelf: toSelf.status,
    }).toEqual({ byStranger: 404, byCreator: 200, toSelf: 403 });
  });

  test("(B-8) DELETE —— 第三者は 404 / 作成者は 204", async () => {
    const target = grantRows().find((row) => row.member === readerMemberId) as { _id: string };
    const etag = withDb(
      (db) =>
        (
          db.query("SELECT _updated_at AS v FROM book_grant WHERE _id = ?").get(target._id) as {
            v: string;
          }
        ).v,
    );
    const byStranger = await remove(
      `/api/apps/${APP_ID}/tables/book_grant/records/${target._id}`,
      stranger.cookie,
      etag,
    );
    const byCreator = await remove(
      `/api/apps/${APP_ID}/tables/book_grant/records/${target._id}`,
      creator.cookie,
      etag,
    );
    expect({ byStranger: byStranger.status, byCreator: byCreator.status }).toEqual({
      byStranger: 404,
      byCreator: 204,
    });
    expect(grantRows().some((row) => row._id === target._id)).toBe(false);
  });

  test("(B-9) バッチ経路でも同じ判定を受ける(create op / update op)", async () => {
    const target = grantRows().find((row) => row.member === readerMemberId) as { _id: string };
    const create = await post(`/api/apps/${APP_ID}/batch`, creator.cookie, {
      ops: [
        {
          op: "create",
          table: "book_grant",
          values: { book: bookId, member: creatorMemberId, permission: "keeper" },
        },
      ],
    });
    const update = await post(`/api/apps/${APP_ID}/batch`, creator.cookie, {
      ops: [
        {
          op: "update",
          table: "book_grant",
          target: target._id,
          values: { member: creatorMemberId },
        },
      ],
    });
    expect({ create: create.status, update: update.status }).toEqual({ create: 403, update: 403 });
  });

  test("(B-10) 宣言していない表への書込は今日と1バイトも変わらない(201)", async () => {
    const response = await post(`/api/apps/${APP_ID}/tables/notes/records`, stranger.cookie, {
      body: "宣言していない表",
    });
    expect(response.status).toBe(201);
  });

  test("(B-12) 【正直に測る】宣言された利用者の種類と viewer は、本タスクの判定に1度も届かない", async () => {
    // **付与表は `st_owner` も `access_control` も持たない普通の表である** ——
    // **`nonAdminTableAccess` が `"denied"` を返すので、中継層(`recordsAuthMiddleware`)が
    // 先に 403 を返す。** **本タスクの文言は1文字も出ない。**
    const guest = seedSession(dataRoot, APP_ID, { role: "guest" as never, username: "guest1" });
    const viewer = seedSession(dataRoot, APP_ID, { role: "viewer", username: "viewer1" });
    const measured: { who: string; status: number; message: string }[] = [];
    for (const [who, session] of [
      ["宣言された種類", guest],
      ["viewer", viewer],
    ] as const) {
      const response = await post(`/api/apps/${APP_ID}/tables/book_grant/records`, session.cookie, {
        book: bookId,
        member: strangerMemberId,
        permission: "keeper",
      });
      const body = (await response.json()) as { errors: { message: string }[] };
      measured.push({ who, status: response.status, message: body.errors[0]?.message ?? "" });
    }
    // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`】止めた層が中継層から面へ移った。**
    // **旧: `{ who: "宣言された種類", status: 403, message: "この操作を行う権限がありません(閲覧のみ)。" },`**
    // **旧: `{ who: "viewer", status: 403, message: "この操作を行う権限がありません(閲覧のみ)。" },`**
    // **本検査の主題(この2人は本タスクの判定に1度も届かない)は今日も真である** ——
    // **届かないまま止まる場所が、`nonAdminTableAccess` の中継層から面(役割の規則)に
    // 変わっただけである**(付与表に `write` を持つ役割は編集者だけになった)。
    //
    // **【`V8-M39`。台帳 `F-G8`(限定採用・門外 `Δ7`)。旧の期待値を1バイトも消していない】**
    // **旧: `message: '表 "book_grant" に対する書き込みは、あなたの役割に許されていません。',`**
    //      (**2件とも同じ逐語である**)。
    // **文末に `(止めた層: role)` が入った** —— **`403` の応答から「どの層が止めたか」を
    // 読めるようにしたためである。** **`ValidationError` に5キー目は足していない**(文面だけ)。
    // **本検査の主題(この2人は本タスクの判定に1度も届かない)は今日も真であり、
    // `status` も `who` も1バイトも動いていない。**
    expect(measured).toEqual([
      {
        who: "宣言された種類",
        status: 403,
        message:
          '表 "book_grant" に対する書き込みは、あなたの役割に許されていません(止めた層: role)。',
      },
      {
        who: "viewer",
        status: 403,
        message:
          '表 "book_grant" に対する書き込みは、あなたの役割に許されていません(止めた層: role)。',
      },
    ]);
  });

  test("(B-11) 付与表そのものは access_control を宣言していない(前提の実測)", () => {
    const table = (manifest() as unknown as { app: { tables: { id: string }[] } }).app.tables.find(
      (candidate) => candidate.id === "book_grant",
    ) as Record<string, unknown>;
    expect(Object.hasOwn(table, "access_control")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (C)(D) **`V7-M3-T04`(`Z-G33`)**: 付与の相手が親の行に権限を持つことをサーバが検査する
// ---------------------------------------------------------------------------
//
// **依頼文 `L6` の逐語**: **「issue はプロジェクトへのアクセス権限がある人しかアサイン
// できない」。** **これを画面の候補絞り込み(`Z-G27` = `V7-M6`)ではなく、サーバの書込判定で
// 担保する。**
//
// ## **段数の扱い(自分で決めた。記録にも書く)**
//
// **1段目(`inherit_from` が直接指す親)だけを見る。** **多段は `V7-M4` の担当であり、
// 本タスクは祖父母以上を1度も辿らない**((C-8) がその限界を実測して固定している)。
// **暫定にはしていない** —— **`V7-M4` が多段を実装したら、本節の検査は「1段目は今日も
// 見ている」ことを固定したまま緑である。**
//
// ## **`inherit_from` が空(0件)の表では、この検査は何も止めない**
//
// **上の (A)(B) の実証アプリ(`books`)は `inherit_from` を1本も持たない** ——
// **したがって (A)(B) の判定は本節の追加で1ミリも変わらない**((C-1) が固定する)。

const PARENT_APP_ID = "grant-parent";

function parentManifest(): Manifest {
  return {
    app: {
      id: PARENT_APP_ID,
      name: "親子のある職場",
      tables: [
        {
          id: "projects",
          name: "プロジェクト",
          fields: [{ id: "title", name: "名前", type: "text", required: true }],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            grant: {
              table: "project_grant",
              target: "project",
              member: "member",
              group: "team",
              permission: "permission",
            },
            members: { table: "app_member", account: "account", group: "team" },
            groups: { table: "app_team" },
          },
        },
        {
          id: "issues",
          name: "課題",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "project", name: "プロジェクト", type: "reference", reference_table: "projects" },
          ],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            // **これが `L6` の「親」である。**
            inherit_from: ["project"],
            grant: {
              table: "issue_grant",
              target: "issue",
              member: "member",
              group: "team",
              permission: "permission",
            },
            members: { table: "app_member", account: "account", group: "team" },
            groups: { table: "app_team" },
          },
        },
        { id: "app_team", name: "班", fields: [{ id: "title", name: "名前", type: "text" }] },
        {
          id: "app_member",
          name: "利用者",
          fields: [
            { id: "account", name: "ログイン", type: "text" },
            { id: "team", name: "班", type: "reference", reference_table: "app_team" },
          ],
        },
        {
          id: "project_grant",
          name: "プロジェクトの付与",
          fields: [
            { id: "project", name: "対象", type: "reference", reference_table: "projects" },
            { id: "member", name: "相手", type: "reference", reference_table: "app_member" },
            { id: "team", name: "班", type: "reference", reference_table: "app_team" },
            {
              id: "permission",
              name: "権限",
              type: "select",
              options: ["reader", "writer", "keeper"],
            },
          ],
        },
        {
          id: "issue_grant",
          name: "課題の付与",
          fields: [
            { id: "issue", name: "対象", type: "reference", reference_table: "issues" },
            { id: "member", name: "相手", type: "reference", reference_table: "app_member" },
            { id: "team", name: "班", type: "reference", reference_table: "app_team" },
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

/** (C) 群の行の器。**親(projects)と子(issues)の2階層を手で組む。** */
type ParentRows = Record<string, Record<string, unknown>[]>;

function parentFixture(): ParentRows {
  return {
    projects: [{ _id: "project-1", title: "第1案件" }],
    issues: [{ _id: "issue-1", title: "課題A", project: "project-1" }],
    app_team: [{ _id: "team-1", title: "第1班" }],
    app_member: [
      { _id: "m-creator", account: ACTOR, team: null },
      { _id: "m-outsider", account: OTHER, team: "team-1" },
      { _id: "m-insider", account: "user-insider", team: "team-1" },
    ],
    // **`creator` は親にも子にも `keeper` を持つ**(作った人)。
    project_grant: [
      { _id: "pg-1", project: "project-1", member: "m-creator", team: null, permission: "keeper" },
    ],
    issue_grant: [
      { _id: "ig-1", issue: "issue-1", member: "m-creator", team: null, permission: "keeper" },
    ],
  };
}

function judgeParent(params: {
  rows: ParentRows;
  values: Record<string, unknown>;
  tableId?: string;
  actorId?: string | null;
  role?: string | null;
  op?: "create" | "update" | "delete";
}) {
  const rows = params.rows;
  return judgeGrantWrite({
    manifest: parentManifest(),
    tableId: params.tableId ?? "issue_grant",
    op: params.op ?? "create",
    values: params.values,
    actorId: params.actorId === undefined ? ACTOR : params.actorId,
    role: (params.role === undefined ? "editor" : params.role) as never,
    readRows: (tableId) => rows[tableId] ?? [],
    readRow: (tableId, recordId) => (rows[tableId] ?? []).find((row) => row._id === recordId),
  });
}

describe("V7-M3-T04 (C): 付与の相手が親の行に権限を持つことをサーバが検査する", () => {
  test("(C-1) inherit_from が空(0件)の表では、この検査は何も止めない", () => {
    // **(A) の `books` は `inherit_from` を1本も持たない** —— **(A-2) と同じ要求が同じ結果で通る。**
    expect(
      judge({ values: { book: "book-1", member: "member-other", permission: "reader" } }),
    ).toEqual({ kind: "allowed" });
  });

  test("(C-2) 親の行に権限が無い相手を指した付与は拒否される(`L6` の逐語)", () => {
    expect(
      judgeParent({
        rows: parentFixture(),
        values: { issue: "issue-1", member: "m-outsider", permission: "writer" },
      }),
    ).toEqual({ kind: "parent_denied", tableId: "projects", recordId: "project-1" });
  });

  test("(C-3) 親の行に read を持つ相手なら通る(拒否側だけを示さない)", () => {
    const rows = parentFixture();
    rows.project_grant?.push({
      _id: "pg-2",
      project: "project-1",
      member: "m-outsider",
      team: null,
      permission: "reader",
    });
    expect(
      judgeParent({
        rows,
        values: { issue: "issue-1", member: "m-outsider", permission: "writer" },
      }),
    ).toEqual({ kind: "allowed" });
  });

  test("(C-4) 運営ロール(owner)が作る付与も、相手が親に権限を持たなければ止まる", () => {
    expect(
      judgeParent({
        rows: parentFixture(),
        actorId: "user-admin",
        role: "owner",
        values: { issue: "issue-1", member: "m-outsider", permission: "writer" },
      }),
    ).toEqual({ kind: "parent_denied", tableId: "projects", recordId: "project-1" });
  });

  test("(C-5) 親を指していない行(参照が空)への付与は、この検査で止まらない", () => {
    const rows = parentFixture();
    rows.issues = [{ _id: "issue-2", title: "親の無い課題", project: null }];
    rows.issue_grant = [
      { _id: "ig-2", issue: "issue-2", member: "m-creator", team: null, permission: "keeper" },
    ];
    expect(
      judgeParent({
        rows,
        values: { issue: "issue-2", member: "m-outsider", permission: "writer" },
      }),
    ).toEqual({ kind: "allowed" });
  });

  test("(C-6) グループへの付与は、そのグループの全員が親に権限を持つときだけ通る", () => {
    const rows = parentFixture();
    // `team-1` には `m-outsider`(親に権限なし)と `m-insider` が居る。
    rows.project_grant?.push({
      _id: "pg-2",
      project: "project-1",
      member: "m-insider",
      team: null,
      permission: "reader",
    });
    const denied = judgeParent({
      rows,
      values: { issue: "issue-1", team: "team-1", permission: "writer" },
    });
    rows.project_grant?.push({
      _id: "pg-3",
      project: "project-1",
      member: "m-outsider",
      team: null,
      permission: "reader",
    });
    const allowed = judgeParent({
      rows,
      values: { issue: "issue-1", team: "team-1", permission: "writer" },
    });
    expect({ denied, allowed }).toEqual({
      denied: { kind: "parent_denied", tableId: "projects", recordId: "project-1" },
      allowed: { kind: "allowed" },
    });
  });

  test("(C-7) 親の側が access_control を宣言していないなら、この検査は何も止めない", () => {
    // **`project_grant` への付与を測る** —— **`projects` の親は宣言されていない
    // (`projects.access_control.inherit_from` が無い)ので、検査対象が1つも無い。**
    const rows = parentFixture();
    expect(
      judgeParent({
        rows,
        tableId: "project_grant",
        values: { project: "project-1", member: "m-outsider", permission: "writer" },
      }),
    ).toEqual({ kind: "allowed" });
  });

  test("(C-8) 【限界】辿るのは1段目だけである(祖父母は1度も見ない)", () => {
    // **`issues` の `inherit_from` は `project` の1本だけである。**
    // **`projects` にさらに親が在っても、本タスクはそれを1度も辿らない**(`V7-M4`)。
    const declared = (
      parentManifest() as unknown as {
        app: { tables: { id: string; access_control?: { inherit_from?: string[] } }[] };
      }
    ).app.tables;
    expect(declared.find((table) => table.id === "issues")?.access_control?.inherit_from).toEqual([
      "project",
    ]);
    expect(
      declared.find((table) => table.id === "projects")?.access_control?.inherit_from,
    ).toBeUndefined();
  });

  test("(C-9) DELETE は親の検査を受けない(権限を手放すことは止めない)", () => {
    expect(
      judgeParent({
        rows: parentFixture(),
        op: "delete",
        values: { _id: "ig-1", issue: "issue-1", member: "m-creator", permission: "keeper" },
      }),
    ).toEqual({ kind: "allowed" });
  });
});

// --- (D) HTTP ---------------------------------------------------------------

describe("V7-M3-T04 (D): 親の行への権限を API から測る", () => {
  let boss: ReturnType<typeof seedSession>;
  let assignee: ReturnType<typeof seedSession>;
  let admin2: ReturnType<typeof seedSession>;
  let bossMember = "";
  let assigneeMember = "";
  let projectId = "";
  let issueId = "";

  beforeEach(async () => {
    const store = KernelMetaStore.open(dataRoot);
    try {
      createApp(store, "親子のある職場", { app_id: PARENT_APP_ID });
    } finally {
      store.close();
    }
    // **【`V8-M26`】(B) 群と同じ理由。** **保護対象の `projects` / `issues` には1本も
    // 足さない**(面を開けると点の測定が無効になる)。
    expect(
      applyManifest(
        dataRoot,
        PARENT_APP_ID,
        withDefaultRoleRules(parentManifest(), { skipTables: ["projects", "issues"] }),
      ).valid,
    ).toBe(true);
    boss = seedSession(dataRoot, PARENT_APP_ID, { role: "editor", username: "boss" });
    assignee = seedSession(dataRoot, PARENT_APP_ID, { role: "editor", username: "assignee" });
    admin2 = seedSession(dataRoot, PARENT_APP_ID, { role: "owner", username: "admin2" });

    const loaded = parentManifest();
    const db = new Database(appDbPath(dataRoot, PARENT_APP_ID), { readwrite: true, create: false });
    try {
      const member = (account: string): string => {
        const created = createRecord(db, loaded, "app_member", { account });
        expect(created.ok).toBe(true);
        return (created as { value: { _id: string } }).value._id;
      };
      bossMember = member(boss.userId);
      assigneeMember = member(assignee.userId);
      member(admin2.userId);
    } finally {
      db.close();
    }
    const project = await post(`/api/apps/${PARENT_APP_ID}/tables/projects/records`, boss.cookie, {
      title: "第1案件",
    });
    expect(project.status).toBe(201);
    projectId = ((await project.json()) as { record: { _id: string } }).record._id;
    const issue = await post(`/api/apps/${PARENT_APP_ID}/tables/issues/records`, boss.cookie, {
      title: "課題A",
      project: projectId,
    });
    expect(issue.status).toBe(201);
    issueId = ((await issue.json()) as { record: { _id: string } }).record._id;
  });

  test("(D-1) 親に権限が無い人を指した付与は 403 で、1行も増えない", async () => {
    const response = await post(
      `/api/apps/${PARENT_APP_ID}/tables/issue_grant/records`,
      boss.cookie,
      { issue: issueId, member: assigneeMember, permission: "writer" },
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { errors: { message: string }[] };
    expect(body.errors[0]?.message).toBe(
      "この相手は、元になっている行を見る権限を持っていないため、ここには追加できません。",
    );
    const db = new Database(appDbPath(dataRoot, PARENT_APP_ID), { readwrite: true, create: false });
    try {
      const rows = db.query("SELECT member FROM issue_grant ORDER BY rowid").all() as {
        member: string;
      }[];
      // **作成者への自動付与1件だけである**(拒否された分は1行も入っていない)。
      expect(rows).toEqual([{ member: bossMember }]);
    } finally {
      db.close();
    }
  });

  test("(D-2) 親に権限を渡してから同じ付与を出すと通る(拒否側だけを示さない)", async () => {
    const onParent = await post(
      `/api/apps/${PARENT_APP_ID}/tables/project_grant/records`,
      boss.cookie,
      { project: projectId, member: assigneeMember, permission: "reader" },
    );
    expect(onParent.status).toBe(201);
    const onChild = await post(
      `/api/apps/${PARENT_APP_ID}/tables/issue_grant/records`,
      boss.cookie,
      { issue: issueId, member: assigneeMember, permission: "writer" },
    );
    expect(onChild.status).toBe(201);
  });

  test("(D-3) 運営(owner)が出しても、相手が親に権限を持たなければ止まる", async () => {
    const response = await post(
      `/api/apps/${PARENT_APP_ID}/tables/issue_grant/records`,
      admin2.cookie,
      { issue: issueId, member: assigneeMember, permission: "writer" },
    );
    expect(response.status).toBe(403);
  });

  test("(D-4) 親の付与(project_grant)そのものは、この検査で止まらない", async () => {
    const response = await post(
      `/api/apps/${PARENT_APP_ID}/tables/project_grant/records`,
      boss.cookie,
      { project: projectId, member: assigneeMember, permission: "reader" },
    );
    expect(response.status).toBe(201);
  });
});
