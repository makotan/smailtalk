/**
 * **`V18-M7-T03` / `PM-G5`(`ADR-0444` 授権の表 行4 / §Decision 3)**:
 * **AI の口(`delete_record`)に、HTTP と同じ関門6段と連鎖の実行を配線したことを固定する。**
 *
 * ## 何を測るか(`ADR-0444` §Decision 3 の6段を、AI の口で6分岐とも撃つ)
 *
 * | 段 | 条件 | **AI の口の答え** |
 * |--:|---|---|
 * | **①** | **子を、可視性を1ビットも効かせずに、いちばん下の段まで数える** | —— |
 * | **②** | **子が0件** | **`isError` 無し**(**今日と1バイトも変わらない**) |
 * | **③** | **子のうち1件でも、この人が単体で消せないものがある** | **`isError: true`**(**件数も表IDも1文字も出さない**) |
 * | **④** | **全部消せる人で、件数の印が無い** | **`isError: true`**(**件数と表IDを文の中に書く**) |
 * | **⑤** | **印は在るが件数が違う** | **`isError: true`**(**1行も消さない**) |
 * | **⑥** | **印が在り件数が一致** | **`isError` 無し**(**親と子をまとめて消す**) |
 *
 * ## **【最重】2経路一致は「状態コード」では書けない**(`ADR-0444` 追記1)
 *
 * **AI の口の断りは今日すべて HTTP `200` + `isError: true` である。** **したがって
 * `(H)` 群は**断りの中身**(`path` と文面)を突き合わせる。** **【禁止】「HTTP も AI も
 * `409` を返すこと」と書かない** —— **AI の口に `409` は今日1つも無い。**
 *
 * **`path` は経路で揃っていない**(`ADR-0444` 追記1 の末尾)—— **印が無いとき HTTP は
 * `""`、AI は `"/if_match"` である。** **本段はそれを揃えない。** **AI の口の中では、
 * 3つの断り((a) 版の印が無い / (b) 版がずれた / (c) 件数の印)が**互いに異なる `path`**
 * を持つ**(`(F)` 群)。
 *
 * ## **【誇張しない。本ファイルが測っていないこと】**
 *
 *  1. **監査は揃っていない。** **AI の口の削除は今日 `writeWithAudit` を1度も通らないので、
 *     親も子も `_auth_activity` に1行も残らない**(`(B-6)` がその実測である)。 **HTTP は
 *     親1件 + 子N件を残す。** **本段はこれを揃えていない** —— **揃えるには AI の口の削除
 *     全体を監査に載せることになり、`ADR-0444` の授権の表に1行も無い。**
 *  2. **受信口 / 自動処理 / コードの島 / 決まった時刻に動く処理は、今日も素通りする**
 *     (`ADR-0444` 限定8)。 **1本も測っていない。**
 *  3. **原子性を1ミリも測っていない**(`D-V18-14`)。 **途中で落ちたときに消えた分が消えた
 *     ままであることは、本ファイルでは1度も撃っていない。**
 *  4. **数え終えてから消すまでに行が増減する窓(TOCTOU)を1バイトも測っていない。**
 *  5. **性能を1件も測っていない。**
 *  6. **実地データを1度も開いていない。**
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  appDbPath,
  applyManifest,
  createApp,
  createRecord,
  KernelMetaStore,
  type Manifest,
  type ValidationError,
} from "../../kernel/index.ts";
import { createServerApp } from "../../server/app.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "../../server/test-helpers.ts";
import { createMcpServer } from "../server.ts";

const APP_ID = "cascade-shelf-mcp";

/** 権限名3つ。**`delete` を持つのは `keeper` だけである**(HTTP 側の台と同じ形)。 */
const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる", read: true, write: true, delete: false },
  { id: "keeper", name: "消せる", read: true, write: true, delete: true },
] as const;

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
 * **形は `src/server/parent-delete-cascade-route.test.ts` と同じである** —— **同じ題材で
 * 両方の口を撃つためであり、`(H)` 群の突き合わせはこの同一性に乗っている。**
 */
function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "課題管理(連鎖・AIの口)",
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
          id: "ac_grant",
          name: "付与",
          fields: [
            { id: "project", name: "プロジェクト", type: "reference", reference_table: "projects" },
            { id: "issue", name: "課題", type: "reference", reference_table: "issues" },
            { id: "comment", name: "コメント", type: "reference", reference_table: "comments" },
            { id: "attachment", name: "添付", type: "reference", reference_table: "attachments" },
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

let keeper: ReturnType<typeof seedSession>;
let reader: ReturnType<typeof seedSession>;
let none: ReturnType<typeof seedSession>;

let keeperMember = "";
let readerMember = "";

/** 子が5件ぶら下がる親が2本(**片方は HTTP で、片方は AI の口で消す**)。 */
let parent = "";
let twin = "";
/** 子が1件も居ない親が2本(同じ理由で2本要る)。 */
let solo = "";
let soloTwin = "";
/** 削除保護の立った親。 */
let protectedParent = "";
/** `parent` / `twin` の下の課題(孫を足す先)。 */
let issueA = "";

function withDb<T>(run: (db: Database) => T, appId: string = APP_ID): T {
  const db = new Database(appDbPath(dataRoot, appId), { readwrite: true, create: false });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function versionOf(table: string, recordId: string, appId: string = APP_ID): string {
  return withDb((db) => {
    const row = db.query(`SELECT _updated_at FROM ${table} WHERE _id = ?`).get(recordId) as {
      _updated_at: string;
    } | null;
    if (row === null) {
      throw new Error(`行 ${recordId} が ${table} に無い`);
    }
    return row._updated_at;
  }, appId);
}

function rowCount(table: string): number {
  return withDb((db) => (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

function counts(): Record<string, number> {
  return {
    projects: rowCount("projects"),
    issues: rowCount("issues"),
    comments: rowCount("comments"),
  };
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

function makeRecord(table: string, values: Record<string, unknown>): string {
  const loaded = manifest();
  return withDb((db) => {
    const created = createRecord(db, loaded, table, values);
    expect(created.ok, `${table} に行を作れない`).toBe(true);
    return (created as unknown as { value: { _id: string } }).value._id;
  });
}

type Denial = {
  readonly failed: boolean;
  readonly path: string;
  readonly message: string;
  readonly hint: string;
};

/**
 * **AI の口を1回撃つ**(**in-process の MCP `Client` 経由**。`read.test.ts` / `write.test.ts`
 * と同じ作法)。 **名乗りはログイン名で渡す** —— **HTTP の cookie と同じ利用者になる。**
 */
async function mcpDelete(
  username: string,
  table: string,
  recordId: string,
  options: {
    readonly ifMatchChildren?: number;
    readonly ifMatch?: string;
    readonly omitIfMatch?: boolean;
    readonly appId?: string;
  } = {},
): Promise<Denial> {
  const appId = options.appId ?? APP_ID;
  const server = createMcpServer({
    dataRoot,
    previewBaseUrl: "http://localhost:3000",
    actor: username,
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = (await client.callTool({
      name: "delete_record",
      arguments: {
        app_id: appId,
        table_id: table,
        record_id: recordId,
        ...(options.omitIfMatch === true
          ? {}
          : { if_match: options.ifMatch ?? versionOf(table, recordId, appId) }),
        ...(options.ifMatchChildren === undefined
          ? {}
          : { if_match_children: options.ifMatchChildren }),
      },
    })) as CallToolResult;
    if (result.isError !== true) {
      return { failed: false, path: "", message: "", hint: "" };
    }
    const errors = (result.structuredContent as { errors?: ValidationError[] } | undefined)?.errors;
    return {
      failed: true,
      path: errors?.[0]?.path ?? "",
      message: errors?.[0]?.message ?? "",
      hint: errors?.[0]?.hint ?? "",
    };
  } finally {
    await client.close();
    await server.close();
  }
}

/** **HTTP を1回撃つ**(突き合わせの相手。`parent-delete-cascade-route.test.ts` と同じ形)。 */
async function httpDelete(
  cookie: string,
  table: string,
  recordId: string,
  options: {
    readonly ifMatchChildren?: string;
    readonly appId?: string;
    readonly ifMatch?: string;
  } = {},
): Promise<Denial & { readonly status: number }> {
  const appId = options.appId ?? APP_ID;
  const headers: Record<string, string> = {
    cookie,
    origin: TEST_ORIGIN,
    // **`ifMatch` を渡したときだけ版の印を差し替える**(`V18-M7-T07b`)——
    // **渡さなければ今日どおり「今の版」を載せる。**
    "if-match": options.ifMatch ?? versionOf(table, recordId, appId),
  };
  if (options.ifMatchChildren !== undefined) {
    headers["if-match-children"] = options.ifMatchChildren;
  }
  const response = await app.request(`/api/apps/${appId}/tables/${table}/records/${recordId}`, {
    method: "DELETE",
    headers,
  });
  if (response.status === 204) {
    return { failed: false, status: 204, path: "", message: "", hint: "" };
  }
  const body = (await response.json()) as { errors?: ValidationError[] };
  return {
    failed: true,
    status: response.status,
    path: body.errors?.[0]?.path ?? "",
    message: body.errors?.[0]?.message ?? "",
    hint: body.errors?.[0]?.hint ?? "",
  };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-pdcm-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "課題管理(連鎖・AIの口)", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, manifestWithRoles()).valid).toBe(true);
  app = createServerApp({ dataRoot });

  keeper = seedSession(dataRoot, APP_ID, { role: "editor", username: "keeper" });
  reader = seedSession(dataRoot, APP_ID, { role: "editor", username: "reader" });
  none = seedSession(dataRoot, APP_ID, { role: "editor", username: "none" });

  parent = makeRecord("projects", { title: "本命" });
  twin = makeRecord("projects", { title: "双子の本命" });
  solo = makeRecord("projects", { title: "子の居ない本命" });
  soloTwin = makeRecord("projects", { title: "子の居ない双子" });
  protectedParent = makeRecord("projects", { title: "消せない本命", st_undeletable: true });

  // **`parent` の下に課題2件、その下にコメント3件** —— **合計5件(孫を含む)。**
  issueA = makeRecord("issues", { title: "課題A", project: parent });
  const issueB = makeRecord("issues", { title: "課題B", project: parent });
  makeRecord("comments", { body: "コメント1", issue: issueA });
  makeRecord("comments", { body: "コメント2", issue: issueA });
  makeRecord("comments", { body: "コメント3", issue: issueB });

  // **双子も1バイト違わない形にする**(`(H)` 群が ⑥ / ② を両方の口で撃つため)。
  const twinIssueA = makeRecord("issues", { title: "双子の課題A", project: twin });
  const twinIssueB = makeRecord("issues", { title: "双子の課題B", project: twin });
  makeRecord("comments", { body: "双子のコメント1", issue: twinIssueA });
  makeRecord("comments", { body: "双子のコメント2", issue: twinIssueA });
  makeRecord("comments", { body: "双子のコメント3", issue: twinIssueB });

  keeperMember = makeRecord("ac_member", { account: keeper.userId });
  readerMember = makeRecord("ac_member", { account: reader.userId });
  makeRecord("ac_member", { account: none.userId });

  for (const project of [parent, twin, solo, soloTwin, protectedParent]) {
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

describe("V18-M7-T03 (A): AI の口でも、子が0件の削除は着手前と同一", () => {
  test("(A-1) 子が1件も居ない親は、件数の印を1つも渡さずに消える", async () => {
    const before = rowCount("projects");
    expect(await mcpDelete("keeper", "projects", solo)).toEqual({
      failed: false,
      path: "",
      message: "",
      hint: "",
    });
    expect(rowCount("projects")).toBe(before - 1);
  });

  test("(A-2) いちばん下の段(孫)は、それ自体を消すぶんには今日どおり消える", async () => {
    const comment = withDb(
      (db) =>
        (db.query(`SELECT _id FROM comments ORDER BY rowid LIMIT 1`).get() as { _id: string })._id,
    );
    expect((await mcpDelete("keeper", "comments", comment)).failed).toBe(false);
    expect(rowCount("comments")).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// (B) ④ / ⑤ / ⑥ —— **件数の印**
// ---------------------------------------------------------------------------

describe("V18-M7-T03 (B): AI の口でも、件数の印が無ければ断り、合えばまとめて消す", () => {
  test("(B-1) ④ 印が無ければ断られ、親も子も1行も消えない", async () => {
    const denial = await mcpDelete("keeper", "projects", parent);
    expect(denial.failed).toBe(true);
    expect(counts()).toEqual({ projects: 5, issues: 4, comments: 6 });
  });

  test("(B-2) ④ の文面に、いちばん下の段まで数えた件数(5)と、子が居る表のIDが載っている", async () => {
    const denial = await mcpDelete("keeper", "projects", parent);
    expect(denial.message).toContain("5");
    expect(denial.message).toContain("issues");
    expect(denial.message).toContain("comments");
  });

  test("(B-3) ④ は版の印(if_match)の断りと1文字も取り違えない", async () => {
    const denial = await mcpDelete("keeper", "projects", parent);
    // **版が無いときの断り(`missingIfMatchError`)の逐語を使い回していない。**
    expect(denial.message).not.toContain("if_match(期待する版)が必要です。");
    // **版がずれたときの断りを画面が掴む語を1度も書かない**(`ADR-0444` 限定10)。
    expect(`${denial.message}${denial.hint}`).not.toContain("変更されています");
    // **件数の印の名前は AI の口の言葉である**(ヘッダ名ではない。決めごと17)。
    expect(denial.hint).toContain("if_match_children");
    expect(denial.hint).not.toContain("If-Match-Children");
    expect(denial.hint).not.toContain("ヘッダ");
  });

  test("(B-4) ⑤ 件数がずれた印は断られ、1行も消えない。④ とは違う文面である", async () => {
    const wrong = await mcpDelete("keeper", "projects", parent, { ifMatchChildren: 4 });
    expect(wrong.failed).toBe(true);
    expect(counts()).toEqual({ projects: 5, issues: 4, comments: 6 });
    const missing = await mcpDelete("keeper", "projects", parent);
    expect(wrong.message).not.toBe(missing.message);
  });

  test("(B-5) ⑥ 件数の合う印を渡すと、親と子と孫がまとめて消える", async () => {
    expect((await mcpDelete("keeper", "projects", parent, { ifMatchChildren: 5 })).failed).toBe(
      false,
    );
    expect(counts()).toEqual({ projects: 4, issues: 2, comments: 3 });
  });

  test("(B-6) ⑥ でも監査は1行も残らない —— **AI の口は今日 HTTP と揃っていない**", async () => {
    // **【誇張しない】** **AI の口の削除は今日 `writeWithAudit` を1度も通らない**(親1件の
    // 削除も同じ)。 **子を足しても監査の行は増えない** —— **HTTP は親1件 + 子5件 = 6行を
    // 残す(`parent-delete-cascade-route.test.ts` の `(B-6)`)。** **本段はこれを揃えていない。**
    expect((await mcpDelete("keeper", "projects", parent, { ifMatchChildren: 5 })).failed).toBe(
      false,
    );
    expect(auditedDeletes()).toEqual([]);
  });

  test("(B-7) 他所の親の子は1行も巻き込まない", async () => {
    expect((await mcpDelete("keeper", "projects", parent, { ifMatchChildren: 5 })).failed).toBe(
      false,
    );
    // **双子の側は1行も動いていない。**
    expect(
      withDb(
        (db) =>
          (
            db.query(`SELECT COUNT(*) AS n FROM issues WHERE project = ?`).get(twin) as {
              n: number;
            }
          ).n,
      ),
    ).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// (C) ③ 消せない子が1件でも在れば断る(`D-V18-31`)
// ---------------------------------------------------------------------------

describe("V18-M7-T03 (C): AI の口でも、消せない子が1件でも在れば断る", () => {
  test("(C-1) 削除保護の立った孫が1件在るだけで断られる。印を渡しても通らない", async () => {
    // **【最重】AI の口には今日「削除保護」の関門が**親については無い**。** **子については
    // 掛ける** —— **連鎖で消える行が、単体では消せない行であってはならない**(`D-V18-31`)。
    makeRecord("comments", { body: "消せないコメント", issue: issueA, st_undeletable: true });
    expect((await mcpDelete("keeper", "projects", parent)).failed).toBe(true);
    expect((await mcpDelete("keeper", "projects", parent, { ifMatchChildren: 6 })).failed).toBe(
      true,
    );
    expect(counts()).toEqual({ projects: 5, issues: 4, comments: 7 });
  });

  test("(C-2) ③ の文面には件数も表IDも1文字も無い(見えない行の件数を漏らさない)", async () => {
    makeRecord("comments", { body: "消せないコメント", issue: issueA, st_undeletable: true });
    const denial = await mcpDelete("keeper", "projects", parent);
    expect(denial.message.length).toBeGreaterThan(0);
    for (const leak of ["6", "5", "issues", "comments", "attachments", "st_undeletable"]) {
      expect(`${denial.message}${denial.hint}`).not.toContain(leak);
    }
  });

  test("(C-3) 持ち主の違う子(所有者スコープ)が1件在るだけで断られる", async () => {
    makeRecord("attachments", { title: "他人の添付", issue: issueA, st_owner: none.userId });
    expect((await mcpDelete("keeper", "projects", parent, { ifMatchChildren: 6 })).failed).toBe(
      true,
    );
    expect(rowCount("attachments")).toBe(1);
  });

  test("(C-4) 自分が持ち主の子は消せる側である(③ が全部を止めてしまっていない裏)", async () => {
    makeRecord("attachments", { title: "自分の添付", issue: issueA, st_owner: keeper.userId });
    expect((await mcpDelete("keeper", "projects", parent, { ifMatchChildren: 6 })).failed).toBe(
      false,
    );
    expect(rowCount("attachments")).toBe(0);
  });

  test("(C-5) 親そのものの削除保護は、AI の口では今日どおり掛からない(射程を広げていない)", async () => {
    // **【隠さない。非対称である】** **HTTP は親の削除保護で 409 を返すが、AI の口には
    // その関門が今日1本も無い。** **本段は親については1バイトも足していない** —— **足すのは
    // `ADR-0444` の授権の表に1行も無い。** **子については掛ける**(`(C-1)`)。
    // **【綴りの数を書かない理由】** **着手前の `write.ts` には `undeletable` の綴りが
    // 0件だったが、本段はこの非対称を doc コメントに書いたので今日は1件ある**(判定の綴り
    // ではない)。 **「0件」と書き残すと、赤くならないまま嘘になる。**
    const http = await httpDelete(keeper.cookie, "projects", protectedParent);
    expect(http.status).toBe(409);
    expect(http.message).toContain("削除できません");
    expect((await mcpDelete("keeper", "projects", protectedParent)).failed).toBe(false);
    expect(rowCount("projects")).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// (D) 印の読み取り —— **10進の整数でない値**
// ---------------------------------------------------------------------------

describe("V18-M7-T03 (D): 件数の印が0以上の整数でなければ、印が無いのと同じ扱い", () => {
  for (const [name, value] of [
    ["小数", 5.5],
    ["負の値", -1],
  ] as const) {
    test(`(D-1 ${name}) 印 ${value} は印が無いのと同じ断りで、1行も消えない`, async () => {
      const denial = await mcpDelete("keeper", "projects", parent, { ifMatchChildren: value });
      expect(denial.failed).toBe(true);
      expect(denial.message).toBe((await mcpDelete("keeper", "projects", parent)).message);
      expect(counts()).toEqual({ projects: 5, issues: 4, comments: 6 });
    });
  }

  test("(D-2) 印 0 は「件数が違う」であって「印が無い」ではない", async () => {
    const zero = await mcpDelete("keeper", "projects", parent, { ifMatchChildren: 0 });
    expect(zero.failed).toBe(true);
    expect(zero.message).not.toBe((await mcpDelete("keeper", "projects", parent)).message);
    expect(counts()).toEqual({ projects: 5, issues: 4, comments: 6 });
  });
});

// ---------------------------------------------------------------------------
// (F) 3つの断りの `path` は互いに違う(`ADR-0444` 追記1 の3点目)
// ---------------------------------------------------------------------------

describe("V18-M7-T03 (F): AI の口の3つの断りは、`path` で互いに見分けられる", () => {
  test("(F-1) (a) 版の印が無い / (b) 版がずれた / (c) 件数の印 の3つは、互いに違う `path` を持つ", async () => {
    const missingVersion = await mcpDelete("keeper", "projects", solo, { omitIfMatch: true });
    const staleVersion = await mcpDelete("keeper", "projects", solo, {
      ifMatch: "2000-01-01T00:00:00.000Z",
    });
    const children = await mcpDelete("keeper", "projects", parent);
    expect([missingVersion.failed, staleVersion.failed, children.failed]).toEqual([
      true,
      true,
      true,
    ]);
    // **今日の実測**(`ADR-0444` 追記1): **印なし = `/if_match` / 版ずれ = `""`。**
    expect(missingVersion.path).toBe("/if_match");
    expect(staleVersion.path).toBe("");
    // **件数の印は、この2つと違う `path` を持つ。**
    expect(children.path).toBe("/if_match_children");
    expect(new Set([missingVersion.path, staleVersion.path, children.path]).size).toBe(3);
  });

  test("(F-2) ⑤(件数の不一致)も ④ と同じ `path` を持ち、文面で見分ける", async () => {
    const mismatch = await mcpDelete("keeper", "projects", parent, { ifMatchChildren: 4 });
    expect(mismatch.path).toBe("/if_match_children");
  });

  test("(F-3) ③(消せない子)は件数の印の `path` を持たない(件数の断りに化けない)", async () => {
    makeRecord("comments", { body: "消せないコメント", issue: issueA, st_undeletable: true });
    const denial = await mcpDelete("keeper", "projects", parent);
    expect(denial.failed).toBe(true);
    expect(denial.path).not.toBe("/if_match_children");
  });
});

// ---------------------------------------------------------------------------
// (G) 関門の順序 —— **新しい関門は既存の関門の後ろに在る**
// ---------------------------------------------------------------------------

describe("V18-M7-T03 (G): 子が居ても、手前の関門の答えが先に返る", () => {
  test("(G-1) 付与を1件も持たない人には、子が居ても今日どおり「存在しません」である", async () => {
    const denial = await mcpDelete("none", "projects", parent);
    expect(denial.failed).toBe(true);
    expect(denial.message).toContain("存在しません");
    // **件数も、子が居る表のIDも1文字も出さない**(行のIDは今日どおり文面に載るので、
    // 数字そのものではなく**表のID**で測る)。
    for (const leak of ["issues", "comments"]) {
      expect(`${denial.message}${denial.hint}`).not.toContain(leak);
    }
  });

  test("(G-2) 「消す」を持たない人には、子が居ても権限の断りである(件数の断りではない)", async () => {
    const denial = await mcpDelete("reader", "projects", parent);
    expect(denial.failed).toBe(true);
    expect(denial.path).not.toBe("/if_match_children");
    for (const leak of ["5", "issues", "comments"]) {
      expect(`${denial.message}${denial.hint}`).not.toContain(leak);
    }
  });
});

// ---------------------------------------------------------------------------
// (H) **2経路一致** —— **同じ題材・同じ利用者で HTTP と AI の口を両方撃つ**
//
// **【最重】状態コードでは書けない**(`ADR-0444` 追記1)。 **突き合わせるのは断りの中身である。**
// **`message` は逐語で一致する。** **`hint` は、印の渡し方の名前だけが経路の言葉に差し替わる**
// (`write.ts` の既存の作法 —— **`hint` だけを MCP の言葉にする**)。
// ---------------------------------------------------------------------------

describe("V18-M7-T03 (H): HTTP と AI の口の答えが、断りの中身で1ビットも違わない", () => {
  test("(H-1) ③ は message も hint も逐語で一致する(件数も表IDも両方に1文字も無い)", async () => {
    makeRecord("comments", { body: "消せないコメント", issue: issueA, st_undeletable: true });
    const http = await httpDelete(keeper.cookie, "projects", parent);
    const mcp = await mcpDelete("keeper", "projects", parent);
    expect(http.status).toBe(403);
    expect(mcp.failed).toBe(true);
    expect(mcp.message).toBe(http.message);
    expect(mcp.hint).toBe(http.hint);
    // **どちらの口も1行も消していない**(突き合わせが「両方成功」で成立しない担保)。
    expect(counts()).toEqual({ projects: 5, issues: 4, comments: 7 });
  });

  test("(H-2) ④ は message が逐語で一致し、hint は印の渡し方の名前だけが違う", async () => {
    const http = await httpDelete(keeper.cookie, "projects", parent);
    const mcp = await mcpDelete("keeper", "projects", parent);
    expect(http.status).toBe(409);
    expect(mcp.failed).toBe(true);
    expect(mcp.message).toBe(http.message);
    expect(http.hint).toContain("If-Match-Children");
    expect(mcp.hint).toContain("if_match_children");
    expect(mcp.hint).not.toBe(http.hint);
    expect(counts()).toEqual({ projects: 5, issues: 4, comments: 6 });
  });

  test("(H-3) ⑤ は message が逐語で一致する(印の値も同じ文の中に載る)", async () => {
    const http = await httpDelete(keeper.cookie, "projects", parent, { ifMatchChildren: "4" });
    const mcp = await mcpDelete("keeper", "projects", parent, { ifMatchChildren: 4 });
    expect(http.status).toBe(409);
    expect(mcp.failed).toBe(true);
    expect(mcp.message).toBe(http.message);
    expect(mcp.message).toContain("4");
    expect(counts()).toEqual({ projects: 5, issues: 4, comments: 6 });
  });

  test("(H-4) ⑥ はどちらの口でも、双子の親が同じ形で消える", async () => {
    const http = await httpDelete(keeper.cookie, "projects", parent, { ifMatchChildren: "5" });
    expect(http.status).toBe(204);
    expect(counts()).toEqual({ projects: 4, issues: 2, comments: 3 });
    const mcp = await mcpDelete("keeper", "projects", twin, { ifMatchChildren: 5 });
    expect(mcp.failed).toBe(false);
    expect(counts()).toEqual({ projects: 3, issues: 0, comments: 0 });
  });

  test("(H-5) ② はどちらの口でも、子が0件の親が印なしで消える", async () => {
    expect((await httpDelete(keeper.cookie, "projects", solo)).status).toBe(204);
    expect((await mcpDelete("keeper", "projects", soloTwin)).failed).toBe(false);
    expect(rowCount("projects")).toBe(3);
  });

  test("(H-6) 手前の関門(「消す」を持たない人)の答えも、両方の口で逐語一致する", async () => {
    const http = await httpDelete(reader.cookie, "projects", parent);
    const mcp = await mcpDelete("reader", "projects", parent);
    expect(http.status).toBe(403);
    expect(mcp.message).toBe(http.message);
  });
});

// ---------------------------------------------------------------------------
// (E) 上限 —— **段数の上限に当たったときの答えも、両方の口で一致する**
// ---------------------------------------------------------------------------

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
  const deep = { app: { id: appId, name: "深い連なり", tables, views: [] } } as unknown as Manifest;

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

describe("V18-M7-T03 (E): 段数の上限に当たったら、AI の口でも既存の断りに寄せる", () => {
  test("(E-1) 6段目へ降りようとする削除は断られ、1行も消えない", async () => {
    const appId = "cascade-deep-mcp";
    const seeded = seedDeepApp(appId);
    const mcp = await mcpDelete("deep", "l0", seeded.rootId, { appId });
    expect(mcp.failed).toBe(true);
    const http = await httpDelete(seeded.cookie, "l0", seeded.rootId, { appId });
    expect(http.status).toBe(400);
    // **両方の口で、断りの文面が逐語で一致する**(既存の上限の断りに寄せた)。
    expect(mcp.message).toBe(http.message);
    expect(mcp.hint).toBe(http.hint);
    withDb((db) => {
      expect((db.query(`SELECT COUNT(*) AS n FROM l0`).get() as { n: number }).n).toBe(1);
      expect((db.query(`SELECT COUNT(*) AS n FROM l5`).get() as { n: number }).n).toBe(1);
    }, appId);
  });
});

// ---------------------------------------------------------------------------
// (I) **却下された要求が行を消してしまう形 —— AI の口**(`V18-M7-T07b`)
//
// **【この段が作った退行である。AI の口の側は `V18-M7-T07b` が実地データの複製の上で撃って
// 確かめた】** —— **MCP の HTTP の口(ポート `4791`)に「正しい件数の印(5)+ 古い版の印」を
// 1回渡したところ、`milestones` が 2→1、`issues` が 4→0 になり、親だけが残って
// 版不一致の断りが返った**(実測は `ADR-0444` 追記10-2)。 **HTTP 側の実測の所在は
// `docs/plan/v18/records/v18-m7.md` の `# (e) 原子的でないこと(**撃てた**)` の節。**
//
// **【`D-V18-14` の射程外である】** —— **許されたのは「連鎖の途中で落ちたとき」であって、
// 「要求そのものが却下されたのに行が消えること」ではない。**
//
// **【誇張しない】** **この口も今日はトランザクションを1つも開かない。** **事前照合と最後の
// CAS のあいだの窓は残る。**
// ---------------------------------------------------------------------------

describe("V18-M7-T07b (I): AI の口でも、版の印が古い要求は1行も消さない", () => {
  const STALE = "2000-01-01T00:00:00.000Z";

  test("(I-1) 正しい件数の印 + 古い版の印 は断りで、親も子も孫も1行も消えない", async () => {
    const denial = await mcpDelete("keeper", "projects", parent, {
      ifMatchChildren: 5,
      ifMatch: STALE,
    });
    expect(denial.failed).toBe(true);
    expect(counts()).toEqual({ projects: 5, issues: 4, comments: 6 });
  });

  test("(I-2) 返る断りは今日の版不一致の文面そのままで、件数の印の断りに化けない", async () => {
    const denial = await mcpDelete("keeper", "projects", parent, {
      ifMatchChildren: 5,
      ifMatch: STALE,
    });
    expect(denial.message).toContain("変更されています");
    expect(denial.path).not.toBe("/if_match_children");
    expect(`${denial.message}${denial.hint}`).not.toContain("if_match_children");
  });

  test("(I-3) 件数の印が無くても、版の印が古ければ1行も消えない(④ より前に断る)", async () => {
    const denial = await mcpDelete("keeper", "projects", parent, { ifMatch: STALE });
    expect(denial.failed).toBe(true);
    expect(denial.message).toContain("変更されています");
    expect(counts()).toEqual({ projects: 5, issues: 4, comments: 6 });
  });

  test("(I-4) 版の印が今の版なら、今日どおりまとめて消える(事前照合が全部を止めていない裏)", async () => {
    const denial = await mcpDelete("keeper", "projects", parent, { ifMatchChildren: 5 });
    expect(denial.failed).toBe(false);
    expect(counts()).toEqual({ projects: 4, issues: 2, comments: 3 });
  });

  test("(I-5) HTTP と AI の口が、同じ要求に対して同じ断りの文面を返す", async () => {
    const mcp = await mcpDelete("keeper", "projects", parent, {
      ifMatchChildren: 5,
      ifMatch: STALE,
    });
    const http = await httpDelete(keeper.cookie, "projects", twin, {
      ifMatchChildren: "5",
      ifMatch: STALE,
    });
    expect(http.status).toBe(409);
    // **文面は行の `_id` だけが違うので、`_id` を伏せて突き合わせる。**
    const mask = (text: string): string => text.replaceAll(/"[0-9a-f-]{36}"/g, '"<id>"');
    expect(mask(mcp.message)).toBe(mask(http.message));
    expect(mcp.hint).toBe(http.hint);
  });
});
