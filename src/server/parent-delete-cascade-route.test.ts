/**
 * **`V18-M7-T02` / `PM-G5`(`ADR-0444` 授権の表 行2 / §Decision 3)**:
 * **HTTP の `DELETE` に、関門1本と連鎖の実行を配線したことを固定する。**
 *
 * ## 何を測るか(`ADR-0444` §Decision 3 の6段を、6分岐とも撃つ)
 *
 * | 段 | 条件 | 応答 |
 * |--:|---|---|
 * | **①** | **子を、可視性を1ビットも効かせずに、いちばん下の段まで数える** | —— |
 * | **②** | **子が0件** | **`204`**(**今日と1バイトも変わらない**) |
 * | **③** | **子のうち1件でも、この人が直接 `DELETE` しても消せないものがある** | **`403`**(**件数も表IDも1文字も出さない**) |
 * | **④** | **全部消せる人で、件数の印が無い** | **`409`**(**件数と表IDを文の中に書く**) |
 * | **⑤** | **印は在るが件数が違う** | **`409`**(**1行も消さない**) |
 * | **⑥** | **印が在り件数が一致** | **`204`**(**親と子をまとめて消す**) |
 *
 * **あわせて、上限に当たったとき・印が10進でないとき・負のとき・空のときを固定する。**
 *
 * ## **関門の位置**(**既存6本の後ろ**)
 *
 * **(1) 所有者スコープ 404 →(2) 行ごとのアクセス権 404 / 403 →(3) 面の行ごとの規則 403
 * →(4) 削除保護 409 →(5) 付与表を対象にした削除かどうかの判定 →**(新)子の連鎖**
 * →(6) `writeWithAudit`。**
 * **(G) がその順序を実測する** —— **子が居る行でも、手前の関門に当たる人には手前の答えが
 * 返る**(件数の断りに化けない)。
 *
 * ## **【誇張しない。本ファイルが測っていないこと】**
 *
 *  1. **AI の口(MCP)に1度も当てていない**(`V18-M7-T03` の担当)。 **本ファイルが緑でも、
 *     AI の口は今日も親だけを消して子を残す。**
 *  2. **受信口 / 自動処理 / コードの島 / 決まった時刻に動く処理は、今日も素通りする**
 *     (`ADR-0444` 限定8)。 **1本も測っていない。**
 *  3. **原子性を1ミリも測っていない**(`D-V18-14`)。 **途中で落ちたときに消えた分が消えた
 *     ままであることは、本ファイルでは1度も撃っていない。**
 *  4. **数え終えてから消すまでに行が増減する窓(TOCTOU)を1バイトも測っていない。**
 *  5. **性能を1件も測っていない。** **子1件ごとに判定の配管を通す形であり、どこで遅くなるかは
 *     1度も測っていない。**
 *  6. **実地データを1度も開いていない。**
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
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "cascade-shelf";

/** 権限名3つ。**`delete` を持つのは `keeper` だけである**(既存の台と同じ形)。 */
const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる", read: true, write: true, delete: false },
  { id: "keeper", name: "消せる", read: true, write: true, delete: true },
] as const;

/** どの段も同じ形の宣言を持つ(**各段で適用する規則は同一**。`Z-G14` 限定3)。 */
function declaration(target: string, inheritFrom?: readonly string[]): Record<string, unknown> {
  return {
    enabled: true,
    permissions: PERMISSIONS.map((permission) => ({ ...permission })),
    creator_permission: "keeper",
    grant: { table: "ac_grant", target, member: "member", permission: "permission" },
    members: { table: "ac_member", account: "account" },
    ...(inheritFrom === undefined ? {} : { inherit_from: [...inheritFrom] }),
  };
}

/**
 * **3段の台**(親 `projects` → 子 `issues` → 孫 `comments`)。
 * **`attachments` は「持ち主の居る子」であり、所有者スコープが ③ に効くことを測るために置く。**
 */
function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "課題管理(連鎖)",
      tables: [
        {
          id: "projects",
          name: "プロジェクト",
          fields: [
            { id: "title", name: "名前", type: "text", required: true },
            { id: "st_undeletable", name: "消せない", type: "boolean" },
          ],
          access_control: declaration("project"),
        },
        {
          id: "issues",
          name: "課題",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "project", name: "プロジェクト", type: "reference", reference_table: "projects" },
            { id: "st_undeletable", name: "消せない", type: "boolean" },
          ],
          access_control: declaration("issue", ["project"]),
        },
        {
          id: "comments",
          name: "コメント",
          fields: [
            { id: "body", name: "本文", type: "text", required: true },
            { id: "issue", name: "課題", type: "reference", reference_table: "issues" },
            { id: "st_undeletable", name: "消せない", type: "boolean" },
          ],
          access_control: declaration("comment", ["issue"]),
        },
        {
          // **持ち主の居る子** —— **`st_owner` を宣言した表**(所有者スコープが掛かる)。
          id: "attachments",
          name: "添付",
          fields: [
            { id: "title", name: "名前", type: "text", required: true },
            { id: "issue", name: "課題", type: "reference", reference_table: "issues" },
            { id: "st_owner", name: "持ち主", type: "text" },
          ],
          access_control: declaration("attachment", ["issue"]),
        },
        {
          id: "ac_member",
          name: "利用者",
          fields: [{ id: "account", name: "ログイン", type: "text" }],
        },
        {
          // **付与表は1本である** —— **各段が同じ表を名指しし、対象の列だけが違う。**
          id: "ac_grant",
          name: "付与",
          fields: [
            { id: "project", name: "プロジェクト", type: "reference", reference_table: "projects" },
            { id: "issue", name: "課題", type: "reference", reference_table: "issues" },
            { id: "comment", name: "コメント", type: "reference", reference_table: "comments" },
            {
              id: "attachment",
              name: "添付",
              type: "reference",
              reference_table: "attachments",
            },
            { id: "member", name: "相手", type: "reference", reference_table: "ac_member" },
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
    },
  } as unknown as Manifest;
}

/**
 * **面(役割に束ねた権限)の既定を埋めた題材**(適用に渡すのはこちら)。
 *
 * **宣言した4表は `skipTables` で外す** —— **面の規則を1本でも足すと、合成の `OR` で
 * 全員が通ってしまい、本ファイルの主題(**行ごとの付与だけで可否が決まること**)が
 * 丸ごと測れなくなる**(既存の台 `access-control-delete.test.ts` と同じ理由)。
 */
function manifestWithRoles(): Manifest {
  const base = manifest() as unknown as { app: Record<string, unknown> };
  base.app.roles = [
    { id: "owner", name: "持ち主" },
    { id: "editor", name: "編集者" },
    { id: "viewer", name: "閲覧者" },
  ];
  return withDefaultRoleRules(base as unknown as Manifest, {
    skipTables: ["projects", "issues", "comments", "attachments"],
  });
}

let dataRoot = "";
let app: ReturnType<typeof createServerApp>;

/** 消せる人 / 読めるだけの人 / 付与を1件も持たない人。 */
let keeper: ReturnType<typeof seedSession>;
let reader: ReturnType<typeof seedSession>;
let none: ReturnType<typeof seedSession>;

/** メンバー行の id(付与を足すために覚えておく)。 */
let keeperMember = "";
let readerMember = "";

/** 子が5件ぶら下がる親 / 子が1件も居ない親 / 削除保護の立った親。 */
let parent = "";
let solo = "";
let protectedParent = "";
/** `parent` の下の課題2件(孫を足す先)。 */
let issueA = "";
let issueB = "";

function withDb<T>(run: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function versionOf(table: string, recordId: string): string {
  return withDb((db) => {
    const row = db.query(`SELECT _updated_at FROM ${table} WHERE _id = ?`).get(recordId) as {
      _updated_at: string;
    } | null;
    if (row === null) {
      throw new Error(`行 ${recordId} が ${table} に無い`);
    }
    return row._updated_at;
  });
}

function rowCount(table: string): number {
  return withDb((db) => (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

/** 監査(`_auth_activity`)に残っている削除の行数。 */
function auditedDeletes(): { readonly table: string; readonly recordId: string }[] {
  return withDb((db) => {
    const rows = db
      .query(
        `SELECT table_id, record_id FROM _auth_activity WHERE action = 'delete_record' ORDER BY rowid`,
      )
      .all() as { table_id: string; record_id: string }[];
    return rows.map((row) => ({ table: row.table_id, recordId: row.record_id }));
  });
}

/**
 * **`DELETE` を1回撃つ。** **`ifMatchChildren` を渡したときだけ件数の印を載せる。**
 * **本体は今日どおり1バイトも送らない**(`ADR-0444` §Decision 4)。
 */
async function del(
  table: string,
  recordId: string,
  cookie: string,
  options: { readonly ifMatchChildren?: string; readonly ifMatch?: string } = {},
): Promise<{ status: number; message: string; hint: string }> {
  const headers: Record<string, string> = {
    cookie,
    origin: TEST_ORIGIN,
    // **`ifMatch` を渡したときだけ版の印を差し替える**(`V18-M7-T07b`)——
    // **渡さなければ今日どおり「今の版」を載せるので、既存の呼び出しは1つも挙動が変わらない。**
    "if-match": options.ifMatch ?? versionOf(table, recordId),
  };
  if (options.ifMatchChildren !== undefined) {
    headers["if-match-children"] = options.ifMatchChildren;
  }
  const response = await app.request(`/api/apps/${APP_ID}/tables/${table}/records/${recordId}`, {
    method: "DELETE",
    headers,
  });
  if (response.status === 204) {
    return { status: 204, message: "", hint: "" };
  }
  const body = (await response.json()) as { errors?: { message: string; hint?: string }[] };
  return {
    status: response.status,
    message: body.errors?.[0]?.message ?? "",
    hint: body.errors?.[0]?.hint ?? "",
  };
}

function makeRecord(table: string, values: Record<string, unknown>): string {
  const loaded = manifest();
  return withDb((db) => {
    const created = createRecord(db, loaded, table, values);
    expect(created.ok, `${table} に行を作れない`).toBe(true);
    return (created as unknown as { value: { _id: string } }).value._id;
  });
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-pdcr-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "課題管理(連鎖)", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, manifestWithRoles()).valid).toBe(true);
  app = createServerApp({ dataRoot });

  keeper = seedSession(dataRoot, APP_ID, { role: "editor", username: "keeper" });
  reader = seedSession(dataRoot, APP_ID, { role: "editor", username: "reader" });
  none = seedSession(dataRoot, APP_ID, { role: "editor", username: "none" });

  parent = makeRecord("projects", { title: "本命" });
  solo = makeRecord("projects", { title: "子の居ない本命" });
  protectedParent = makeRecord("projects", { title: "消せない本命", st_undeletable: true });

  // **`parent` の下に課題2件、その下にコメント3件** —— **合計5件(孫を含む)。**
  issueA = makeRecord("issues", { title: "課題A", project: parent });
  issueB = makeRecord("issues", { title: "課題B", project: parent });
  makeRecord("comments", { body: "コメント1", issue: issueA });
  makeRecord("comments", { body: "コメント2", issue: issueA });
  makeRecord("comments", { body: "コメント3", issue: issueB });

  keeperMember = makeRecord("ac_member", { account: keeper.userId });
  readerMember = makeRecord("ac_member", { account: reader.userId });
  makeRecord("ac_member", { account: none.userId });

  for (const project of [parent, solo, protectedParent]) {
    makeRecord("ac_grant", { project, member: keeperMember, permission: "keeper" });
    makeRecord("ac_grant", { project, member: readerMember, permission: "reader" });
  }
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (A) ② 子が0件 —— **今日と1バイトも変わらない**(退行の担保)
// ---------------------------------------------------------------------------

describe("V18-M7-T02 (A): 子が0件の削除は着手前と同一", () => {
  test("(A-1) 子が1件も居ない親は、印を1つも付けずに 204(今日と同じ)", async () => {
    const before = rowCount("projects");
    const response = await del("projects", solo, keeper.cookie);
    expect(response.status).toBe(204);
    expect(rowCount("projects")).toBe(before - 1);
  });

  test("(A-2) 子が0件のときは、監査に残るのは今日どおり親1件だけである", async () => {
    expect((await del("projects", solo, keeper.cookie)).status).toBe(204);
    expect(auditedDeletes()).toEqual([{ table: "projects", recordId: solo }]);
  });

  test("(A-3) いちばん下の段(孫)は、それ自体を消すぶんには今日どおり 204", async () => {
    const comment = withDb(
      (db) =>
        (db.query(`SELECT _id FROM comments ORDER BY rowid LIMIT 1`).get() as { _id: string })._id,
    );
    const response = await del("comments", comment, keeper.cookie);
    expect(response.status).toBe(204);
    expect(rowCount("comments")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// (B) ④ / ⑤ / ⑥ —— **件数の印**
// ---------------------------------------------------------------------------

describe("V18-M7-T02 (B): 件数の印が無ければ断り、合えばまとめて消す", () => {
  test("(B-1) ④ 印が無ければ 409 で、親も子も1行も消えない", async () => {
    const response = await del("projects", parent, keeper.cookie);
    expect(response.status).toBe(409);
    expect({
      projects: rowCount("projects"),
      issues: rowCount("issues"),
      comments: rowCount("comments"),
    }).toEqual({ projects: 3, issues: 2, comments: 3 });
  });

  test("(B-2) ④ の文面に、いちばん下の段まで数えた件数(5)と、子が居る表のIDが載っている", async () => {
    const response = await del("projects", parent, keeper.cookie);
    expect(response.status).toBe(409);
    expect(response.message).toContain("5");
    expect(response.message).toContain("issues");
    expect(response.message).toContain("comments");
  });

  test("(B-3) ④ の文面は、版の印(If-Match)の断りと1文字も取り違えない", async () => {
    const response = await del("projects", parent, keeper.cookie);
    // **版が無いときの断り(`missingIfMatchError`)の逐語を使い回していない。**
    expect(response.message).not.toContain("If-Match(期待する版)が必要です。");
    // **版がずれたときの断りを画面が掴む語を1度も書かない**(`ADR-0444` 限定10)。
    expect(response.message).not.toContain("変更されています");
    expect(response.hint).not.toContain("変更されています");
    // **件数の印の名前は文の中に在る**(利用者が次に何を送るかが分かる)。
    expect(`${response.message}${response.hint}`).toContain("If-Match-Children");
  });

  test("(B-4) ⑤ 件数がずれた印は 409 で、1行も消えない。④ とは違う文面である", async () => {
    const wrong = await del("projects", parent, keeper.cookie, { ifMatchChildren: "4" });
    expect(wrong.status).toBe(409);
    expect({
      projects: rowCount("projects"),
      issues: rowCount("issues"),
      comments: rowCount("comments"),
    }).toEqual({ projects: 3, issues: 2, comments: 3 });
    const missing = await del("projects", parent, keeper.cookie);
    expect(wrong.message).not.toBe(missing.message);
  });

  test("(B-5) ⑥ 件数の合う印を付けると、親と子と孫がまとめて消えて 204", async () => {
    const response = await del("projects", parent, keeper.cookie, { ifMatchChildren: "5" });
    expect(response.status).toBe(204);
    expect({
      projects: rowCount("projects"),
      issues: rowCount("issues"),
      comments: rowCount("comments"),
    }).toEqual({ projects: 2, issues: 0, comments: 0 });
  });

  test("(B-6) ⑥ の監査は、親1件 + 子5件 = 6行であり、孫が先に載る", async () => {
    expect((await del("projects", parent, keeper.cookie, { ifMatchChildren: "5" })).status).toBe(
      204,
    );
    const audited = auditedDeletes();
    expect(audited.length).toBe(6);
    // **深い段から消す** —— **孫(`comments`)が先、子(`issues`)が次、親は最後である。**
    expect(audited.map((row) => row.table)).toEqual([
      "comments",
      "comments",
      "comments",
      "issues",
      "issues",
      "projects",
    ]);
    expect(audited[5]).toEqual({ table: "projects", recordId: parent });
  });

  test("(B-7) 他所の親の子は1行も巻き込まない", async () => {
    const otherIssue = makeRecord("issues", { title: "他所の課題", project: solo });
    expect((await del("projects", parent, keeper.cookie, { ifMatchChildren: "5" })).status).toBe(
      204,
    );
    expect(rowCount("issues")).toBe(1);
    expect(
      withDb(
        (db) =>
          (
            db.query(`SELECT COUNT(*) AS n FROM issues WHERE _id = ?`).get(otherIssue) as {
              n: number;
            }
          ).n,
      ),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (C) ③ 消せない子が1件でも在れば断る(`D-V18-31`)
// ---------------------------------------------------------------------------

describe("V18-M7-T02 (C): 消せない子が1件でも在れば 403", () => {
  test("(C-1) 削除保護の立った孫が1件在るだけで 403。印を付けても通らない", async () => {
    const guarded = makeRecord("comments", {
      body: "消せないコメント",
      issue: issueA,
      st_undeletable: true,
    });
    expect(guarded.length).toBeGreaterThan(0);
    const bare = await del("projects", parent, keeper.cookie);
    expect(bare.status).toBe(403);
    const sealed = await del("projects", parent, keeper.cookie, { ifMatchChildren: "6" });
    expect(sealed.status).toBe(403);
    expect({
      projects: rowCount("projects"),
      issues: rowCount("issues"),
      comments: rowCount("comments"),
    }).toEqual({ projects: 3, issues: 2, comments: 4 });
  });

  test("(C-2) ③ の文面には件数も表IDも1文字も無い(見えない行の件数を漏らさない)", async () => {
    makeRecord("comments", { body: "消せないコメント", issue: issueA, st_undeletable: true });
    const response = await del("projects", parent, keeper.cookie);
    expect(response.status).toBe(403);
    expect(response.message.length).toBeGreaterThan(0);
    for (const leak of ["6", "5", "issues", "comments", "attachments", "st_undeletable"]) {
      expect(`${response.message}${response.hint}`).not.toContain(leak);
    }
  });

  test("(C-3) 持ち主の違う子(所有者スコープ)が1件在るだけで 403", async () => {
    // **その子を直接 `DELETE` しても 404 になる** —— **連鎖でだけ消えるなら権限が増えている。**
    makeRecord("attachments", { title: "他人の添付", issue: issueA, st_owner: none.userId });
    const response = await del("projects", parent, keeper.cookie, { ifMatchChildren: "6" });
    expect(response.status).toBe(403);
    expect(rowCount("attachments")).toBe(1);
  });

  test("(C-4) 自分が持ち主の子は消せる側である(③ が全部を止めてしまっていない裏)", async () => {
    makeRecord("attachments", { title: "自分の添付", issue: issueA, st_owner: keeper.userId });
    const response = await del("projects", parent, keeper.cookie, { ifMatchChildren: "6" });
    expect(response.status).toBe(204);
    expect(rowCount("attachments")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (D) 印の読み取り —— **10進でない値 / 負の値 / 空**
// ---------------------------------------------------------------------------

describe("V18-M7-T02 (D): 件数の印が10進の整数でなければ、印が無いのと同じ扱い", () => {
  for (const [name, value] of [
    ["10進でない", "five"],
    ["負の値", "-1"],
    ["空", ""],
    ["小数", "5.0"],
    ["符号つき", "+5"],
  ] as const) {
    test(`(D-1 ${name}) 印 "${value}" は 409 で、1行も消えない`, async () => {
      const response = await del("projects", parent, keeper.cookie, { ifMatchChildren: value });
      expect(response.status).toBe(409);
      expect({
        projects: rowCount("projects"),
        issues: rowCount("issues"),
        comments: rowCount("comments"),
      }).toEqual({ projects: 3, issues: 2, comments: 3 });
    });
  }

  test("(D-2) 先頭に0の付いた10進(005)は5として読む", async () => {
    const response = await del("projects", parent, keeper.cookie, { ifMatchChildren: "005" });
    expect(response.status).toBe(204);
    expect(rowCount("issues")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (E) 上限 —— **段数の上限に当たったときの答え**
// ---------------------------------------------------------------------------

/**
 * **6段の連なりを別のアプリとして作る**(段0 〜 段6 の表7本)。
 *
 * **段5 の行から段6 へ降りようとした時点で上限に当たる**
 * (`MAX_RECORD_ACCESS_INHERIT_DEPTH` は 5。述語の doc の逐語)。
 * **サーバはアプリを要求のたびに読むので、検査の中で2本目のアプリを作ってよい。**
 */
function seedDeepApp(appId: string): { readonly cookie: string; readonly rootId: string } {
  const levels = [0, 1, 2, 3, 4, 5, 6];
  const tables: Record<string, unknown>[] = levels.map((level) => ({
    id: `l${level}`,
    name: `段${level}`,
    fields: [
      { id: "title", name: "名前", type: "text", required: true },
      ...(level === 0
        ? []
        : [{ id: "up", name: "親", type: "reference", reference_table: `l${level - 1}` }]),
    ],
    access_control: {
      enabled: true,
      permissions: PERMISSIONS.map((permission) => ({ ...permission })),
      creator_permission: "keeper",
      grant: {
        table: "deep_grant",
        target: `l${level}`,
        member: "member",
        permission: "permission",
      },
      members: { table: "deep_member", account: "account" },
      ...(level === 0 ? {} : { inherit_from: ["up"] }),
    },
  }));
  tables.push({
    id: "deep_member",
    name: "利用者",
    fields: [{ id: "account", name: "ログイン", type: "text" }],
  });
  tables.push({
    id: "deep_grant",
    name: "付与",
    fields: [
      ...levels.map((level) => ({
        id: `l${level}`,
        name: `段${level}`,
        type: "reference",
        reference_table: `l${level}`,
      })),
      { id: "member", name: "相手", type: "reference", reference_table: "deep_member" },
      {
        id: "permission",
        name: "権限",
        type: "select",
        options: ["reader", "writer", "keeper"],
      },
    ],
  });
  const deep = {
    app: { id: appId, name: "深い連なり", tables, views: [] },
  } as unknown as Manifest;

  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "深い連なり", { app_id: appId });
  } finally {
    store.close();
  }
  expect(
    applyManifest(
      dataRoot,
      appId,
      withDefaultRoleRules(deep, { skipTables: levels.map((level) => `l${level}`) }),
    ).valid,
  ).toBe(true);
  const session = seedSession(dataRoot, appId, { role: "editor", username: "deep" });

  const db = new Database(appDbPath(dataRoot, appId), { readwrite: true, create: false });
  try {
    const make = (table: string, values: Record<string, unknown>): string => {
      const created = createRecord(db, deep, table, values);
      expect(created.ok, `${table} に行を作れない`).toBe(true);
      return (created as unknown as { value: { _id: string } }).value._id;
    };
    let previous = make("l0", { title: "段0" });
    const rootId = previous;
    // **段1 〜 段5 まで1本ずつ繋ぐ** —— **段5 の下に段6 の表が宣言されているので、
    // そこから降りようとした時点で上限に当たる。**
    for (const level of [1, 2, 3, 4, 5]) {
      previous = make(`l${level}`, { title: `段${level}`, up: previous });
    }
    const member = make("deep_member", { account: session.userId });
    make("deep_grant", { l0: rootId, member, permission: "keeper" });
    return { cookie: session.cookie, rootId };
  } finally {
    db.close();
  }
}

describe("V18-M7-T02 (E): 段数の上限に当たったら、既存の断りに寄せる", () => {
  test("(E-1) 6段目へ降りようとする削除は 400 で、1行も消えない", async () => {
    const appId = "cascade-deep";
    const seeded = seedDeepApp(appId);
    const version = (() => {
      const db = new Database(appDbPath(dataRoot, appId), { readwrite: true, create: false });
      try {
        return (
          db.query(`SELECT _updated_at FROM l0 WHERE _id = ?`).get(seeded.rootId) as {
            _updated_at: string;
          }
        )._updated_at;
      } finally {
        db.close();
      }
    })();
    const response = await app.request(`/api/apps/${appId}/tables/l0/records/${seeded.rootId}`, {
      method: "DELETE",
      headers: { cookie: seeded.cookie, origin: TEST_ORIGIN, "if-match": version },
    });
    expect(response.status).toBe(400);
    const db = new Database(appDbPath(dataRoot, appId), { readwrite: true, create: false });
    try {
      expect((db.query(`SELECT COUNT(*) AS n FROM l0`).get() as { n: number }).n).toBe(1);
      expect((db.query(`SELECT COUNT(*) AS n FROM l5`).get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (G) 関門の順序 —— **新しい関門は既存6本の後ろに在る**
//
// **手前の関門に当たる人には、手前の答えがそのまま返る** —— **件数の断りに化けない。**
// **これが `ADR-0434` §Decision 6 の 5(見えない行の件数を漏らす)を越えていない実体である。**
// ---------------------------------------------------------------------------

describe("V18-M7-T02 (G): 子が居ても、手前の関門の答えが先に返る", () => {
  test("(G-1) 付与を1件も持たない人には、子が居ても今日どおり 404", async () => {
    const response = await del("projects", parent, none.cookie);
    expect(response.status).toBe(404);
  });

  test("(G-2) 「消す」を持たない人には、子が居ても 403(件数の 409 ではない)", async () => {
    const response = await del("projects", parent, reader.cookie);
    expect(response.status).toBe(403);
    for (const leak of ["5", "issues", "comments"]) {
      expect(`${response.message}${response.hint}`).not.toContain(leak);
    }
  });

  test("(G-3) 削除保護の立った親は、子を足しても今日どおり削除保護の 409 である", async () => {
    makeRecord("issues", { title: "守られた親の課題", project: protectedParent });
    const response = await del("projects", protectedParent, keeper.cookie);
    expect(response.status).toBe(409);
    // **削除保護の断り(`deleteProtectedRecordError`)の逐語が返っている。**
    expect(response.message).toContain("削除できません");
    expect(response.message).not.toContain("If-Match-Children");
  });
});

// ---------------------------------------------------------------------------
// (H) **却下された要求が行を消してしまう形**(`V18-M7-T07b`)
//
// **【この段が作った退行である。実測台が見つけた】** —— **実測の所在は
// `docs/plan/v18/records/v18-m7.md` の `# (e) 原子的でないこと(**撃てた**)` の節
// (複製 `51` / ポート `4584`)。** **件数の印が正しく、版の印(`If-Match`)だけが古い要求は、
// 着手前(`a594d2ac`)は **1行も消さずに** `409` を返していた。** **⑥(連鎖の実行)が親の版照合
// (`deleteRecord` の CAS)より **前** に走るので、子が全部消えてから親で断られる形になっていた。**
//
// **【`D-V18-14` の射程外である】** —— **`D-V18-14` が許したのは「連鎖の**途中で落ちたとき**、
// そこまでに消えた行は消えたままでよい」ことであって、「**要求そのものが却下されたのに行が
// 消えること**」ではない。**
//
// **【誇張しない。原子性は1ミリも取れていない】** —— **この経路は今日もトランザクションを
// 1つも開かない。** **事前照合と最後の CAS の**あいだ**に別の書込が入れば、事前照合が通った
// あとで最後の CAS が落ち、子だけが消える形は**今日も起こりうる**。** **本節が固定するのは
// 「却下が決まっている要求で1行も消えないこと」までである。**
// ---------------------------------------------------------------------------

describe("V18-M7-T07b (H): 件数の印は正しいが版の印が古い要求は、1行も消さない", () => {
  const STALE = "2000-01-01T00:00:00.000Z";

  test("(H-1) 正しい件数の印 + 古い版の印 は 409 で、親も子も孫も1行も消えない", async () => {
    const response = await del("projects", parent, keeper.cookie, {
      ifMatchChildren: "5",
      ifMatch: STALE,
    });
    expect(response.status).toBe(409);
    expect({
      projects: rowCount("projects"),
      issues: rowCount("issues"),
      comments: rowCount("comments"),
    }).toEqual({ projects: 3, issues: 2, comments: 3 });
  });

  test("(H-2) そのとき監査にも1行も残らない(消えた行が無いのだから痕跡も無い)", async () => {
    await del("projects", parent, keeper.cookie, { ifMatchChildren: "5", ifMatch: STALE });
    expect(auditedDeletes()).toEqual([]);
  });

  test("(H-3) 返る断りは、今日の版不一致の文面そのままである(3本目の文面を作っていない)", async () => {
    const response = await del("projects", parent, keeper.cookie, {
      ifMatchChildren: "5",
      ifMatch: STALE,
    });
    // **画面はこの語を含む 409 だけを「版が合いません」として扱う**(`web/src/api.ts` の
    // `VERSION_CONFLICT_MARKER`)。 **断りの文面を1バイトも変えていないので、今日どおり掴まれる。**
    expect(response.message).toContain("変更されています");
    // **件数の印の断り(④ / ⑤)に化けていない。**
    expect(`${response.message}${response.hint}`).not.toContain("If-Match-Children");
  });

  test("(H-4) 版の印が古ければ、件数の印が無くても1行も消えない(④ より前に断る)", async () => {
    const response = await del("projects", parent, keeper.cookie, { ifMatch: STALE });
    expect(response.status).toBe(409);
    expect({
      projects: rowCount("projects"),
      issues: rowCount("issues"),
      comments: rowCount("comments"),
    }).toEqual({ projects: 3, issues: 2, comments: 3 });
    expect(response.message).toContain("変更されています");
  });

  test("(H-5) 版の印が今の版なら、今日どおりまとめて消える(事前照合が全部を止めていない裏)", async () => {
    const response = await del("projects", parent, keeper.cookie, { ifMatchChildren: "5" });
    expect(response.status).toBe(204);
    expect({
      projects: rowCount("projects"),
      issues: rowCount("issues"),
      comments: rowCount("comments"),
    }).toEqual({ projects: 2, issues: 0, comments: 0 });
  });
});
