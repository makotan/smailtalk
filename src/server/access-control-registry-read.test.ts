/**
 * **`V18-M3-T01`(`PM-G6` / `ADR-0435` / `ADR-0439`)—— TDD の赤。**
 *
 * ## 本ファイルが固定するもの
 *
 * **今日、`enabled` な `access_control` 宣言が名指しした**名簿表・グループ表・付与表**は、
 * 権限を1件も持たない利用者に**全件返る**。** **宣言を載せている表(`projects` /
 * `milestones`)は行ごとに絞られるのに、**配りを記録する表だけが素通りする**。**
 *
 * **本ファイルは、絞ったあとに返るべき行を先に書く。** **したがって `V18-M3-T02` が
 * 配線するまで、下の (B) の検査は**赤い**。**
 *
 * ## **【禁止】本ファイルは「直った」ことを1件も示さない**
 *
 * **`V18-M3-T01` は検査だけを書く葉であり、製品コードを1バイトも触っていない。**
 * **本ファイルが緑になるのは `V18-M3-T02` / `V18-M3-T03` の後である。**
 *
 * ## 絞り方(**`docs/plan/v18/01-user-decisions.md` §12 `D-V18-21` + `05-v18-m3-plan.md` §11-1**)
 *
 * | 表の役 | **返す行** |
 * |---|---|
 * | **付与表** | **その付与行が指す親の行を、その人が読めるものだけ** |
 * | **名簿表** | **上で見える付与行が指している人の行 + 自分自身の行** |
 * | **グループ表** | **上で見える付与行が指しているグループの行 + 自分が所属しているグループの行** |
 * | **運営(`owner`)** | **今までどおり全部** |
 *
 * ## 裁定5点(**`05-v18-m3-plan.md` §11-1。1点ずつ検査で固定する**)
 *
 * | # | 裁定 | **固定する検査** |
 * |--:|---|---|
 * | **1** | **「読める」= 今日の合成の答えそのもの**(`resolveCombinedRecordAccess` の `read`。**引き継ぎ `inherit_from` を含み、上限を掛けた後**) | **(B-4)** —— `ms1` は**引き継ぎでしか読めない**(`milestone_grants` に viewer への付与は1件も無い) |
 * | **2** | **親の表が複数の宣言から名指しされているときは**和**を取る** | **(B-5)** —— `pe_d` は**`milestones` の宣言経由でしか見えない** |
 * | **3** | **グループ経由の付与(`grant.group`)も「見える付与行」に数える** | **(B-3)** / **(B-2)** —— `pg_group` は相手欄が空でグループ欄だけが埋まっている |
 * | **4** | **付与行が指す親の行が引けない(孤児)なら落とす。運営には返る** | **(B-6)** —— `pg_orphan` の親は SQL で直に消してある |
 * | **5** | **母集団の分類(`recordPopulationScope`)に枝を足し、既存の post-filter の分岐に載せる。後段で落とす形にしない** | **(A-2)**(分類が `"unfiltered"` でなくなる)+ **(B-8)**(`total` とページ送り) |
 *
 * ## 射程の外(**`records/v18-m0.md` §4-1 の逐語。`T01` 完了条件 (b) / (c)**)
 *
 * > **塞ぐのは「`enabled` な `access_control` 宣言が名指しした付与表・名簿表・グループ表への、
 * > 画面と HTTP と AI の口からの読取」だけであり、`enabled: false` の宣言が名指しした表・
 * > どの宣言からも名指しされていない表・時刻起動 / 受信口 / 自動処理 / 島 からの読取には
 * > 1ビットも届かない。**
 *
 * **本ファイルの台に、その2種がどちらも実在する**(完了条件 (c)。名指しできる):
 *
 * | 種類 | **台の表ID** |
 * |---|---|
 * | **`enabled: false` の宣言が名指しした表** | **`paused_people`(名簿)/ `paused_teams`(グループ)/ `paused_grants`(付与)** |
 * | **どの宣言からも名指しされていない表** | **`notes`** |
 *
 * **(C) の検査は、直す前も直した後も **緑** である。** **赤くなったら射程が漏れている。**
 *
 * ## 本ファイルが測らないもの(**誇張しない**)
 *
 * - **AI の口(`list_records`)は1度も叩いていない** —— **`V18-M3-T03` の担当である。**
 * - **時刻起動 / 受信口 / 自動処理 / 島 は1度も叩いていない**(`ADR-0435` 限定9)。
 * - **単票(`GET .../records/:record_id`)は測っていない** —— **一覧の母集団が主題である。**
 * - **連絡先の2項目(ログイン名・メールアドレス)は1件も隠していない**(`V18-M3-T07`)。
 *
 * ## 【2026-09-12 追記(`V18-M3-T02b`)。**上の本文を1バイトも書き換えていない**】
 *
 * **上の「単票(`GET .../records/:record_id`)は測っていない」は、今日は偽である。**
 * **`V18-M3-T02b` が末尾に (D) の6本を足した** —— **`ADR-0435` §Decision 2 の 3 の後半
 * (「**単件は 404 にする**」)が `T02` で積み残っていたためである。**
 * **(A) 〜 (C) の13本は1バイトも書き換えていない。**
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
import {
  accessControlTableRoles,
  isGrantTable,
  isGroupTable,
  isMemberTable,
  judgeRoleAccess,
  recordPopulationScope,
} from "./owner-scope.ts";
import { seedSession, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "registry-read";

const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる", read: true, write: true, delete: false },
] as const;

/**
 * **宣言を2本持つ台。** **どちらも同じ名簿表(`people`)と同じグループ表(`teams`)を
 * 名指ししている** —— **裁定2(和を取る)を撃つために要る形である。**
 *
 * **`milestones` は `inherit_from: ["project"]` を持つ** —— **裁定1(引き継ぎを含む)。**
 */
function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "名簿の読取",
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
          ],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
      tables: [
        {
          // **宣言その1(親)。** **面は1本も開けない**(`skipTables`)—— **点だけで決まる。**
          id: "projects",
          name: "案件",
          fields: [{ id: "title", name: "名前", type: "text", required: true }],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "writer",
            grant: {
              table: "project_grants",
              target: "project",
              member: "member",
              group: "team",
              permission: "permission",
            },
            members: { table: "people", account: "account", group: "team" },
            groups: { table: "teams" },
          },
        },
        {
          // **宣言その2(子)。** **`projects` から引き継ぐ** —— **裁定1 の台。**
          id: "milestones",
          name: "節目",
          fields: [
            { id: "title", name: "名前", type: "text", required: true },
            { id: "project", name: "案件", type: "reference", reference_table: "projects" },
          ],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "writer",
            inherit_from: ["project"],
            grant: {
              table: "milestone_grants",
              target: "milestone",
              member: "member",
              group: "team",
              permission: "permission",
            },
            members: { table: "people", account: "account", group: "team" },
            groups: { table: "teams" },
          },
        },
        // --- 射程の中(この3役が今日どおり全件返っている)---------------------------
        {
          id: "people",
          name: "利用者",
          fields: [
            { id: "account", name: "ログイン", type: "text" },
            { id: "team", name: "班", type: "reference", reference_table: "teams" },
          ],
        },
        { id: "teams", name: "班", fields: [{ id: "title", name: "名前", type: "text" }] },
        {
          id: "project_grants",
          name: "案件の付与",
          fields: [
            { id: "project", name: "対象", type: "reference", reference_table: "projects" },
            { id: "member", name: "相手", type: "reference", reference_table: "people" },
            { id: "team", name: "班", type: "reference", reference_table: "teams" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
          ],
        },
        {
          id: "milestone_grants",
          name: "節目の付与",
          fields: [
            { id: "milestone", name: "対象", type: "reference", reference_table: "milestones" },
            { id: "member", name: "相手", type: "reference", reference_table: "people" },
            { id: "team", name: "班", type: "reference", reference_table: "teams" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
          ],
        },
        // --- 射程の外① `enabled: false` の宣言が名指しした3表 -----------------------
        {
          id: "paused",
          name: "停止中の表",
          fields: [{ id: "title", name: "名前", type: "text" }],
          access_control: {
            enabled: false,
            permissions: [...PERMISSIONS],
            creator_permission: "writer",
            grant: {
              table: "paused_grants",
              target: "paused",
              member: "member",
              group: "team",
              permission: "permission",
            },
            members: { table: "paused_people", account: "account", group: "team" },
            groups: { table: "paused_teams" },
          },
        },
        {
          id: "paused_people",
          name: "停止中の利用者",
          fields: [
            { id: "account", name: "ログイン", type: "text" },
            { id: "team", name: "班", type: "reference", reference_table: "paused_teams" },
          ],
        },
        {
          id: "paused_teams",
          name: "停止中の班",
          fields: [{ id: "title", name: "名前", type: "text" }],
        },
        {
          id: "paused_grants",
          name: "停止中の付与",
          fields: [
            { id: "paused", name: "対象", type: "reference", reference_table: "paused" },
            { id: "member", name: "相手", type: "reference", reference_table: "paused_people" },
            { id: "team", name: "班", type: "reference", reference_table: "paused_teams" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
          ],
        },
        // --- 射程の外② どの宣言からも名指しされていない表 ---------------------------
        { id: "notes", name: "メモ", fields: [{ id: "body", name: "本文", type: "text" }] },
      ],
      views: [],
      workflows: [],
    },
  } as unknown as Manifest;
}

/**
 * **面(役割の規則)を足すのは、宣言を**載せていない**表だけである。**
 *
 * **`projects` / `milestones` には1本も足さない** —— **面と点は `OR` なので、面を開けると
 * 「親を読めるか」の答えが全行 true になり、測定が丸ごと無効になる。**
 *
 * **逆に、名簿表・グループ表・付与表には既定どおり足す** —— **実アプリで `add_table` が
 * 必ず配る規則であり、**今日 200 全件が返っているのはまさにこの面が通しているからである**
 * (`05-v18-m3-plan.md` §3-1)。**
 */
function manifestWithRoles(): Manifest {
  return withDefaultRoleRules(manifest(), { skipTables: ["projects", "milestones"] });
}

let dataRoot: string;
let app: ReturnType<typeof import("./app.ts").createServerApp>;
let viewer: ReturnType<typeof seedSession>;
let admin: ReturnType<typeof seedSession>;

/**
 * **台の行の鍵の全量**(20本)。**索引シグネチャにしない** —— **`noUncheckedIndexedAccess`
 * の下では `Record<string, string>` の読み出しが `string | undefined` になり、
 * 綴りを間違えても検査が通ってしまう。**
 */
const ROW_KEYS = [
  "tm_granted",
  "tm_mine",
  "tm_stranger",
  "pe_viewer",
  "pe_direct",
  "pe_hidden",
  "pe_inherited",
  "pe_orphan",
  "pr_visible",
  "pr_hidden",
  "pr_deleted",
  "ms_visible",
  "ms_hidden",
  "pg_self",
  "pg_direct",
  "pg_hidden",
  "pg_group",
  "pg_orphan",
  "mg_inherited",
  "mg_hidden",
] as const;

/** 台の行ID(`beforeEach` が詰める)。 */
const id = {} as Record<(typeof ROW_KEYS)[number], string>;

function withDb<T>(run: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

async function listIds(table: string, cookie: string, query = ""): Promise<string[]> {
  const response = await app.request(`/api/apps/${APP_ID}/tables/${table}/records${query}`, {
    headers: { cookie },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { records: { _id: string }[] };
  return body.records.map((row) => row._id);
}

async function listPage(
  table: string,
  cookie: string,
  query = "",
): Promise<{ ids: string[]; total: number }> {
  const response = await app.request(`/api/apps/${APP_ID}/tables/${table}/records${query}`, {
    headers: { cookie },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { records: { _id: string }[]; total: number };
  return { ids: body.records.map((row) => row._id), total: body.total };
}

/** 行IDの集合を、並び順に依存せず比べる。 */
function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-v18m3-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "名簿の読取", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, manifestWithRoles()).valid).toBe(true);
  const { createServerApp } = await import("./app.ts");
  app = createServerApp({ dataRoot });

  viewer = seedSession(dataRoot, APP_ID, { role: "viewer", username: "u-viewer" });
  admin = seedSession(dataRoot, APP_ID, { role: "owner", username: "u-owner" });

  const loaded = manifest();
  withDb((db) => {
    const row = (table: string, values: Record<string, unknown>): string => {
      const created = createRecord(db, loaded, table, values);
      expect({ table, ok: created.ok }).toEqual({ table, ok: true });
      return (created as { value: { _id: string } }).value._id;
    };

    // --- 班(グループ表)3行 -------------------------------------------------
    id.tm_granted = row("teams", { title: "見える班" });
    id.tm_mine = row("teams", { title: "自分の班" });
    id.tm_stranger = row("teams", { title: "無関係の班" });

    // --- 利用者(名簿表)5行 -------------------------------------------------
    // **`account` に入るのは利用者IDである**(`owner-scope.ts:1157` の `members.account`)。
    id.pe_viewer = row("people", { account: viewer.userId, team: id.tm_mine });
    id.pe_direct = row("people", { account: "other-direct", team: id.tm_granted });
    id.pe_hidden = row("people", { account: "other-hidden" });
    id.pe_inherited = row("people", { account: "other-inherited" });
    id.pe_orphan = row("people", { account: "other-orphan" });

    // --- 案件(宣言その1)3行。3本目は孤児を作るために後で消す ----------------
    id.pr_visible = row("projects", { title: "見える案件" });
    id.pr_hidden = row("projects", { title: "見えない案件" });
    id.pr_deleted = row("projects", { title: "あとで消す案件" });

    // --- 節目(宣言その2)2行 -----------------------------------------------
    id.ms_visible = row("milestones", { title: "見える節目", project: id.pr_visible });
    id.ms_hidden = row("milestones", { title: "見えない節目", project: id.pr_hidden });

    // --- 案件の付与5行 -------------------------------------------------------
    // **viewer 自身への直接の付与** —— **これだけが `pr_visible` を読めるようにする。**
    id.pg_self = row("project_grants", {
      project: id.pr_visible,
      member: id.pe_viewer,
      permission: "reader",
    });
    // **見える親(`pr_visible`)を指す、他人への付与** —— **見える。**
    id.pg_direct = row("project_grants", {
      project: id.pr_visible,
      member: id.pe_direct,
      permission: "reader",
    });
    // **見えない親(`pr_hidden`)を指す付与** —— **見えない。**
    id.pg_hidden = row("project_grants", {
      project: id.pr_hidden,
      member: id.pe_hidden,
      permission: "reader",
    });
    // **グループ経由の付与(相手欄は空)** —— **裁定3。見える。**
    id.pg_group = row("project_grants", {
      project: id.pr_visible,
      team: id.tm_granted,
      permission: "reader",
    });
    // **親を後で消す付与** —— **裁定4(孤児)。**
    id.pg_orphan = row("project_grants", {
      project: id.pr_deleted,
      member: id.pe_orphan,
      permission: "reader",
    });

    // --- 節目の付与2行 -------------------------------------------------------
    // **`ms_visible` は引き継ぎでしか読めない** —— **裁定1。**
    // **この行が見えることで `pe_inherited` が名簿に出る** —— **裁定2(宣言をまたぐ和)。**
    id.mg_inherited = row("milestone_grants", {
      milestone: id.ms_visible,
      member: id.pe_inherited,
      permission: "reader",
    });
    id.mg_hidden = row("milestone_grants", {
      milestone: id.ms_hidden,
      member: id.pe_hidden,
      permission: "reader",
    });

    // --- 孤児を作る -----------------------------------------------------------
    // **参照の実在検査(`records.ts:570`)を通るように、行を作ってから SQL で直に消す。**
    // **実アプリでも、参照元を残したまま親の行が消える道は在る**(`ADR-0410` の `AC-G1`)。
    db.run(`DELETE FROM "projects" WHERE _id = ?`, [id.pr_deleted]);
  });

  // --- 台の自己点検(**赤の原因を取り違えないために、先に形を固定する**)---------
  // **20本の鍵が1つ残らず埋まっていること**(取りこぼした鍵は `undefined` のまま残り、
  // 下の検査が「見えない」ではなく「鍵が無い」で赤くなってしまう)。
  expect(ROW_KEYS.filter((key) => typeof id[key] !== "string" || id[key] === "")).toEqual([]);
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

// ===========================================================================
// (A) 述語と母集団の分類 —— **`T01` 完了条件 (c) / (d)**
// ===========================================================================

test("(A-1) 述語3本が、台の表をそれぞれの役で認識する(射程の外は1つも認識しない)", () => {
  const loaded = manifest();
  expect({
    // **射程の中**(`enabled` な宣言が名指ししている)。
    grant_projects: isGrantTable(loaded, "project_grants"),
    grant_milestones: isGrantTable(loaded, "milestone_grants"),
    member_people: isMemberTable(loaded, "people"),
    group_teams: isGroupTable(loaded, "teams"),
    // **射程の外①**(`enabled: false` の宣言が名指ししている)。
    grant_paused: isGrantTable(loaded, "paused_grants"),
    member_paused: isMemberTable(loaded, "paused_people"),
    group_paused: isGroupTable(loaded, "paused_teams"),
    // **射程の外②**(どの宣言からも名指しされていない)。
    roles_notes: accessControlTableRoles(loaded, "notes").length,
    grant_notes: isGrantTable(loaded, "notes"),
    member_notes: isMemberTable(loaded, "notes"),
    group_notes: isGroupTable(loaded, "notes"),
  }).toEqual({
    grant_projects: true,
    grant_milestones: true,
    member_people: true,
    group_teams: true,
    grant_paused: false,
    member_paused: false,
    group_paused: false,
    roles_notes: 0,
    grant_notes: false,
    member_notes: false,
    group_notes: false,
  });
});

test('(A-2) 【裁定5】名簿・グループ・付与の表の母集団の分類が `"unfiltered"` でなくなる', () => {
  // **`app.ts:5504` の `postFiltered` は「分類が `\"unfiltered\"` でないこと」と1バイトも
  // 同じである** —— **`\"unfiltered\"` のままだと DB の `LIMIT`/`OFFSET` がそのまま効き、
  // 後段で行を落としても `total` が絞る前のままになり、ページが穴あきになる。**
  //
  // **本検査は枝の**名前**を1文字も要求していない** —— **要求しているのは
  // 「絞りが要る側に分類されること」だけである。**
  const loaded = manifest();
  const scopeOf = (tableId: string): string => {
    const table = loaded.app.tables.find((candidate) => candidate.id === tableId);
    if (table === undefined) {
      throw new Error(`表 "${tableId}" が台に無い`);
    }
    return recordPopulationScope({
      manifest: loaded,
      table,
      anonymousPublic: false,
      accessSources: undefined,
      tableRead: judgeRoleAccess({
        manifest: loaded,
        roles: ["viewer"] as unknown as never,
        target: { target: "table", table: tableId },
        verb: "read",
      }),
    });
  };
  // **射程の中: 絞りが要る。**
  for (const tableId of ["people", "teams", "project_grants", "milestone_grants"]) {
    expect({ tableId, unfiltered: scopeOf(tableId) === "unfiltered" }).toEqual({
      tableId,
      unfiltered: false,
    });
  }
  // **射程の外: 今日どおり絞りが要らない**(ここが赤くなったら射程が漏れている)。
  for (const tableId of ["paused_people", "paused_teams", "paused_grants", "notes"]) {
    expect({ tableId, scope: scopeOf(tableId) }).toEqual({ tableId, scope: "unfiltered" });
  }
});

// ===========================================================================
// (B) 射程の中 —— **絞ったあとに返る行。`T01` 完了条件 (a)**
// ===========================================================================

test("(B-0) 【台の確かめ】宣言を載せている2表そのものは、今日どおり行ごとに絞られている", async () => {
  // **裁定1 が言う「読める」の中身を、先に実測で固定する** ——
  // **`pr_visible` だけが読め、`ms_visible` は**引き継ぎでしか**読めない。**
  expect(await listIds("projects", viewer.cookie)).toEqual([id.pr_visible]);
  expect(await listIds("milestones", viewer.cookie)).toEqual([id.ms_visible]);
});

test("(B-1) 名簿表は「見える付与行が指す人 + 自分自身」だけを返す", async () => {
  expect(sorted(await listIds("people", viewer.cookie))).toEqual(
    sorted([id.pe_viewer, id.pe_direct, id.pe_inherited]),
  );
});

test("(B-2) グループ表は「見える付与行が指す班 + 自分が所属する班」だけを返す", async () => {
  expect(sorted(await listIds("teams", viewer.cookie))).toEqual(
    sorted([id.tm_granted, id.tm_mine]),
  );
});

test("(B-3) 【裁定3】付与表は親が読める行だけを返す(グループ経由の付与も数える)", async () => {
  expect(sorted(await listIds("project_grants", viewer.cookie))).toEqual(
    sorted([id.pg_self, id.pg_direct, id.pg_group]),
  );
});

test("(B-4) 【裁定1】引き継ぎでしか読めない親を指す付与行も、付与表に返る", async () => {
  // **`milestone_grants` に viewer への付与は1件も無い。** **`ms_visible` が読めるのは
  // `inherit_from: [\"project\"]` が `pr_visible` の付与を引き継いでいるからである。**
  expect(await listIds("milestone_grants", viewer.cookie)).toEqual([id.mg_inherited]);
});

test("(B-5) 【裁定2】親の表が複数の宣言から名指しされているときは和を取る", async () => {
  // **`pe_inherited` を指す付与行は `milestone_grants` にしか無い。**
  // **積(どの宣言からも見えること)を採ると、この行は名簿から消える** ——
  // **和でなければならない側を `inherited_visible` が押さえる。**
  //
  // **`pe_hidden` は `project_grants` と `milestone_grants` の両方から指されているが、
  // どちらの親も読めない。** **和を取っても見えてはならない側を `hidden_visible` が
  // 押さえる** —— **今日はここが `true` であり、本検査はそれで赤い。**
  const people = await listIds("people", viewer.cookie);
  expect({
    inherited_visible: people.includes(id.pe_inherited),
    direct_visible: people.includes(id.pe_direct),
    hidden_visible: people.includes(id.pe_hidden),
  }).toEqual({ inherited_visible: true, direct_visible: true, hidden_visible: false });
});

test("(B-6) 【裁定4】親の行が引けない付与行(孤児)は落とす。運営には返る", async () => {
  const forViewer = await listIds("project_grants", viewer.cookie);
  const peopleForViewer = await listIds("people", viewer.cookie);
  expect({
    orphan_grant_to_viewer: forViewer.includes(id.pg_orphan),
    orphan_member_to_viewer: peopleForViewer.includes(id.pe_orphan),
    orphan_grant_to_owner: (await listIds("project_grants", admin.cookie)).includes(id.pg_orphan),
  }).toEqual({
    orphan_grant_to_viewer: false,
    orphan_member_to_viewer: false,
    orphan_grant_to_owner: true,
  });
});

test("(B-7) 運営(`owner`)には今までどおり全部返る(`D-V18-18` と同じ向き)", async () => {
  expect({
    people: sorted(await listIds("people", admin.cookie)),
    teams: sorted(await listIds("teams", admin.cookie)),
    project_grants: sorted(await listIds("project_grants", admin.cookie)),
    milestone_grants: sorted(await listIds("milestone_grants", admin.cookie)),
  }).toEqual({
    people: sorted([id.pe_viewer, id.pe_direct, id.pe_hidden, id.pe_inherited, id.pe_orphan]),
    teams: sorted([id.tm_granted, id.tm_mine, id.tm_stranger]),
    project_grants: sorted([id.pg_self, id.pg_direct, id.pg_hidden, id.pg_group, id.pg_orphan]),
    milestone_grants: sorted([id.mg_inherited, id.mg_hidden]),
  });
});

test("(B-8) 【裁定5 / 追加条件A】`total` が可視行数と一致し、`limit=1` でページが穴あきにならない", async () => {
  // **台の行が少なくても露見するように `limit=1` で撃つ**(`05-v18-m3-plan.md` §11-4 A)。
  const all = await listPage("people", viewer.cookie);
  expect({ total: all.total, count: all.ids.length }).toEqual({ total: 3, count: 3 });

  const walked: string[] = [];
  for (let offset = 0; offset < all.total; offset += 1) {
    const page = await listPage("people", viewer.cookie, `?limit=1&offset=${offset}`);
    expect({ offset, count: page.ids.length, total: page.total }).toEqual({
      offset,
      count: 1,
      total: all.total,
    });
    walked.push(...page.ids);
  }
  // **1件ずつ歩いた集合が、1回で取った可視集合と一致する**(重複も取りこぼしも無い)。
  expect(sorted(walked)).toEqual(sorted(all.ids));
  // **`total` ちょうどの `offset` で初めて空になる。**
  expect((await listPage("people", viewer.cookie, `?limit=1&offset=${all.total}`)).ids).toEqual([]);
});

// ===========================================================================
// (C) 射程の外 —— **直す前も直した後も緑。`T01` 完了条件 (b) / (c)**
// ===========================================================================

test("(C-1) `enabled: false` の宣言が名指しした3表は、今日どおり全件返る", async () => {
  // **この検査が赤くなったら、射程(`records/v18-m0.md` §4-1)を越えている。**
  const loaded = manifest();
  withDb((db) => {
    const team = createRecord(db, loaded, "paused_teams", { title: "停止中の班" });
    expect(team.ok).toBe(true);
    const teamId = (team as { value: { _id: string } }).value._id;
    for (const account of ["p-a", "p-b", "p-c"]) {
      const person = createRecord(db, loaded, "paused_people", { account, team: teamId });
      expect(person.ok).toBe(true);
    }
    const target = createRecord(db, loaded, "paused", { title: "停止中の行" });
    expect(target.ok).toBe(true);
    const grant = createRecord(db, loaded, "paused_grants", {
      paused: (target as { value: { _id: string } }).value._id,
      team: teamId,
      permission: "reader",
    });
    expect(grant.ok).toBe(true);
  });
  expect({
    paused_people: (await listPage("paused_people", viewer.cookie)).total,
    paused_teams: (await listPage("paused_teams", viewer.cookie)).total,
    paused_grants: (await listPage("paused_grants", viewer.cookie)).total,
  }).toEqual({ paused_people: 3, paused_teams: 1, paused_grants: 1 });
});

test("(C-2) どの宣言からも名指しされていない表(`notes`)は、今日どおり全件返る", async () => {
  const loaded = manifest();
  withDb((db) => {
    for (const body of ["一", "二", "三", "四"]) {
      const created = createRecord(db, loaded, "notes", { body });
      expect(created.ok).toBe(true);
    }
  });
  const page = await listPage("notes", viewer.cookie);
  expect({ total: page.total, count: page.ids.length }).toEqual({ total: 4, count: 4 });
});

// ===========================================================================
// (D) **単票の口**(`GET .../records/:record_id`)—— **`V18-M3-T02b`**
//
// **【本節を足した理由。頭の doc の「単票は測っていない」を1バイトも消していない】**
// **`T01` は一覧の母集団だけを主題にし、`T02` もそこだけを直した。**
// **`ADR-0435` §Decision 2 の 3 は「**一覧は応答から落とし(0件)、単件は 404 にする**
// (`ADR-0305` 限定11 を越えない)。**「403 で全部返す」形にしない**」と定めており、
// **後半(単件)が積み残っていた。** **本節はそれを固定する。**
//
// **答えの形は 404 である**(403 ではない)—— **403 を返すと「その行が在る」ことが
// 権限の外へ漏れる。** **`app.ts` の単票 `GET` が既に持つ他の壁(個人スコープ /
// 行ごとの付与 / 面の条件)と1バイトも同じ向きである。**
// ===========================================================================

/** 単票の口を叩いて、HTTP ステータスだけを返す。 */
async function readOneStatus(table: string, recordId: string, cookie: string): Promise<number> {
  const response = await app.request(`/api/apps/${APP_ID}/tables/${table}/records/${recordId}`, {
    headers: { cookie },
  });
  return response.status;
}

/** 単票の口を叩いて、ステータスと本文(の要旨)を返す。 */
async function readOne(
  table: string,
  recordId: string,
  cookie: string,
): Promise<{ status: number; body: unknown }> {
  const response = await app.request(`/api/apps/${APP_ID}/tables/${table}/records/${recordId}`, {
    headers: { cookie },
  });
  return { status: response.status, body: await response.json() };
}

test("(D-1) 絞りで一覧から落ちた行は、単票の口で 404 になる(403 にしない)", async () => {
  // **一覧で落ちた行を、一覧の実測から採る**(手で書いた表と食い違わないようにする)。
  const hidden = {
    people: [id.pe_hidden, id.pe_orphan],
    teams: [id.tm_stranger],
    project_grants: [id.pg_hidden, id.pg_orphan],
    milestone_grants: [id.mg_hidden],
  } as const;
  // **陽性対照: その6行が、確かに一覧から落ちている**(落ちていなければ本検査は無意味)。
  for (const [table, rows] of Object.entries(hidden)) {
    const listed = await listIds(table, viewer.cookie);
    expect({ table, leaked: rows.filter((row) => listed.includes(row)) }).toEqual({
      table,
      leaked: [],
    });
  }
  const statuses: Record<string, number> = {};
  for (const [table, rows] of Object.entries(hidden)) {
    for (const row of rows) {
      statuses[`${table}/${row}`] = await readOneStatus(table, row, viewer.cookie);
    }
  }
  // **6行とも 404 ちょうどである。** **200 も 403 も1件も無い。**
  expect(Object.values(statuses).filter((status) => status !== 404)).toEqual([]);
  expect(Object.values(statuses).filter((status) => status === 403)).toEqual([]);
  expect(Object.values(statuses).length).toBe(6);
});

test("(D-2) 見える行は今までどおり単票の口で 200 が返る", async () => {
  const visible = {
    people: [id.pe_viewer, id.pe_direct, id.pe_inherited],
    teams: [id.tm_granted, id.tm_mine],
    project_grants: [id.pg_self, id.pg_direct, id.pg_group],
    milestone_grants: [id.mg_inherited],
  } as const;
  const statuses: Record<string, number> = {};
  for (const [table, rows] of Object.entries(visible)) {
    for (const row of rows) {
      statuses[`${table}/${row}`] = await readOneStatus(table, row, viewer.cookie);
    }
  }
  expect(Object.values(statuses).filter((status) => status !== 200)).toEqual([]);
  expect(Object.values(statuses).length).toBe(9);
});

test("(D-3) 運営(`owner`)には単票の口でも今までどおり全部 200 が返る", async () => {
  const all = {
    people: [id.pe_viewer, id.pe_direct, id.pe_hidden, id.pe_inherited, id.pe_orphan],
    teams: [id.tm_granted, id.tm_mine, id.tm_stranger],
    project_grants: [id.pg_self, id.pg_direct, id.pg_hidden, id.pg_group, id.pg_orphan],
    milestone_grants: [id.mg_inherited, id.mg_hidden],
  } as const;
  const statuses: Record<string, number> = {};
  for (const [table, rows] of Object.entries(all)) {
    for (const row of rows) {
      statuses[`${table}/${row}`] = await readOneStatus(table, row, admin.cookie);
    }
  }
  expect(Object.values(statuses).filter((status) => status !== 200)).toEqual([]);
  expect(Object.values(statuses).length).toBe(15);
});

test("(D-4) 見えない行の 404 は、そもそも存在しない行の 404 と同じ本文である(存在を伏せる)", async () => {
  const hiddenRow = await readOne("people", id.pe_hidden, viewer.cookie);
  const absent = await readOne("people", "00000000-0000-4000-8000-000000000000", viewer.cookie);
  expect(hiddenRow.status).toBe(404);
  expect(absent.status).toBe(404);
  // **行IDだけが違い、形(`errors[].message` の雛形)は1バイトも同じである。**
  const shape = (body: unknown): unknown =>
    JSON.parse(
      JSON.stringify(body)
        .replaceAll(id.pe_hidden, "<id>")
        .replaceAll("00000000-0000-4000-8000-000000000000", "<id>"),
    );
  expect(shape(hiddenRow.body)).toEqual(shape(absent.body));
});

// --- 射程の外 —— **直す前も直した後も緑**(`T01` 完了条件 (b) / (c) の単票版)---------

test("(D-5) `enabled: false` の宣言が名指しした3表は、単票の口でも今日どおり 200 を返す", async () => {
  const loaded = manifest();
  const made: { table: string; id: string }[] = [];
  withDb((db) => {
    const row = (table: string, values: Record<string, unknown>): string => {
      const created = createRecord(db, loaded, table, values);
      expect({ table, ok: created.ok }).toEqual({ table, ok: true });
      const rowId = (created as { value: { _id: string } }).value._id;
      made.push({ table, id: rowId });
      return rowId;
    };
    const teamId = row("paused_teams", { title: "停止中の班" });
    row("paused_people", { account: "p-a", team: teamId });
    const targetId = row("paused", { title: "停止中の行" });
    row("paused_grants", { paused: targetId, team: teamId, permission: "reader" });
  });
  const statuses: Record<string, number> = {};
  for (const entry of made) {
    if (entry.table === "paused") {
      // **宣言を載せている表そのもの**(射程の外ではない)。**ここでは撃たない。**
      continue;
    }
    statuses[`${entry.table}/${entry.id}`] = await readOneStatus(
      entry.table,
      entry.id,
      viewer.cookie,
    );
  }
  expect(Object.values(statuses).filter((status) => status !== 200)).toEqual([]);
  expect(Object.values(statuses).length).toBe(3);
});

test("(D-6) どの宣言からも名指しされていない表(`notes`)は、単票の口でも今日どおり 200 を返す", async () => {
  const loaded = manifest();
  let noteId = "";
  withDb((db) => {
    const created = createRecord(db, loaded, "notes", { body: "一" });
    expect(created.ok).toBe(true);
    noteId = (created as { value: { _id: string } }).value._id;
  });
  expect(await readOneStatus("notes", noteId, viewer.cookie)).toBe(200);
});

// ===========================================================================
// (E) **AI の口**(`list_records`)—— **`V18-M3-T03`**
//
// **【本節を足した理由。頭の doc の「AI の口は1度も叩いていない」を1バイトも
// 消していない】** **`ADR-0435` §Status 3 / §Decision 2 の 1 は、`PM-G6` の射程に
// **AI の口**を含めている**(逐語: 「**画面と HTTP と AI の口からの読取**」)。
// **`list_records`(`src/mcp/tools/read.ts`)は母集団の分類
// (`recordPopulationScope` / `judgeRecordPopulation`)を1度も通らず、
// 同じ絞りを `read.ts` の中に手で書いていた** —— **したがって `T02` / `T02b` の
// 直しは AI の口に自動では届かない。**
//
// **本節は「片側だけを撃つ検査」にしない**(既知の罠:「『2経路一致』の検査が
// 片側だけだった」)—— **同じ台・同じ利用者・同じ表について、画面の口(HTTP)と
// AI の口(MCP)の両方を実際に叩き、返る行の `_id` の集合と件数を突き合わせる。**
//
// **【禁止】本節は単票の口を1度も撃っていない** —— **AI の口に単票の口は無い**
// (`list_records` だけが行を返す)。**無いことの実測は記録の側に置く。**
// ===========================================================================

/** **AI の口に実在する、名簿 / グループ / 付与の4表**(台の全量。手で並べていない側は (E-0) が数える)。 */
const REGISTRY_TABLES = ["people", "teams", "project_grants", "milestone_grants"] as const;

/** **射程の外の表**(`enabled: false` の宣言が名指しした3表 + どの宣言からも名指しされていない1表)。 */
const OUT_OF_SCOPE_TABLES = ["paused_people", "paused_teams", "paused_grants", "notes"] as const;

/**
 * **AI の口を1本起こして `list_records` を叩く。**
 *
 * **毎回起こし直している** —— **名乗り(`actor`)はサーバを組むときに決まるので、
 * 人を変えるには起こし直すしかない**(実地でも同じ。記録の §「起こし直し」を見よ)。
 */
async function mcpList(
  table: string,
  actorId: string,
  args: Record<string, unknown> = {},
): Promise<{ ids: string[]; total: number }> {
  const { createMcpServer } = await import("../mcp/server.ts");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createMcpServer({
    dataRoot,
    previewBaseUrl: "http://127.0.0.1:3000",
    actor: actorId,
  });
  const client = new Client({ name: "v18-m3-t03", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = (await client.callTool({
      name: "list_records",
      arguments: { app_id: APP_ID, table_id: table, ...args },
    })) as { isError?: boolean; structuredContent?: unknown };
    expect({ table, isError: result.isError === true }).toEqual({ table, isError: false });
    const data = result.structuredContent as { records: { _id: string }[]; total: number };
    return { ids: data.records.map((row) => row._id), total: data.total };
  } finally {
    await client.close();
    await server.close();
  }
}

test("(E-0) 【台の確かめ】AI の口が行を返す道具は `list_records` 1本だけである(単票の口が無い)", async () => {
  const { createMcpServer } = await import("../mcp/server.ts");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createMcpServer({
    dataRoot,
    previewBaseUrl: "http://127.0.0.1:3000",
    actor: viewer.userId,
  });
  const client = new Client({ name: "v18-m3-t03", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    // **行を1件でも返す道具の全量**(道具名に `record` を含むもの。**陽性対照**として
    // 母集団そのものも並べる)。**単票を読む道具(`read_record` / `get_record`)は
    // 1本も無い** —— **`ADR-0435` 限定7 の「単件は 404」は、AI の口には当て先が無い。**
    expect({
      list_records: names.includes("list_records"),
      read_record: names.includes("read_record"),
      get_record: names.includes("get_record"),
      record_tools: names.filter((name) => name.includes("record")),
    }).toEqual({
      list_records: true,
      read_record: false,
      get_record: false,
      record_tools: ["delete_record", "list_records", "update_record", "write_records"],
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("(E-1) 権限を1件も持たない名乗りでは、AI の口も名簿・グループ・付与の表を全件返さない", async () => {
  // **今日の壊れ方**: **4表とも運営と同じ件数(5 / 3 / 5 / 2)が返る。**
  // **直したあと**: **画面の口とまったく同じ件数になる。**
  const actual: Record<string, number> = {};
  for (const table of REGISTRY_TABLES) {
    actual[table] = (await mcpList(table, viewer.userId)).total;
  }
  expect(actual).toEqual({
    people: 3,
    teams: 2,
    project_grants: 3,
    milestone_grants: 1,
  });
});

test("(E-2) 【2経路一致】画面の口と AI の口が、同じ人・同じ表について同じ行を返す", async () => {
  // **片側だけを撃たない** —— **両方を実際に叩き、`_id` の集合と件数を突き合わせる。**
  for (const table of REGISTRY_TABLES) {
    const http = await listPage(table, viewer.cookie);
    const mcp = await mcpList(table, viewer.userId);
    expect({ table, ids: sorted(mcp.ids), total: mcp.total }).toEqual({
      table,
      ids: sorted(http.ids),
      total: http.total,
    });
  }
});

test("(E-3) 【射程の外】AI の口でも、射程の外の4表は今日と同じ答えのままである", async () => {
  // **この検査が赤くなったら、射程(`records/v18-m0.md` §4-1)を越えている。**
  // **直す前も直した後も緑である。**
  const loaded = manifest();
  withDb((db) => {
    const team = createRecord(db, loaded, "paused_teams", { title: "停止中の班" });
    expect(team.ok).toBe(true);
    const teamId = (team as { value: { _id: string } }).value._id;
    for (const account of ["p-a", "p-b", "p-c"]) {
      expect(createRecord(db, loaded, "paused_people", { account, team: teamId }).ok).toBe(true);
    }
    const target = createRecord(db, loaded, "paused", { title: "停止中の行" });
    expect(target.ok).toBe(true);
    expect(
      createRecord(db, loaded, "paused_grants", {
        paused: (target as { value: { _id: string } }).value._id,
        team: teamId,
        permission: "reader",
      }).ok,
    ).toBe(true);
    for (const body of ["一", "二", "三", "四"]) {
      expect(createRecord(db, loaded, "notes", { body }).ok).toBe(true);
    }
  });
  const totals: Record<string, number> = {};
  for (const table of OUT_OF_SCOPE_TABLES) {
    const mcp = await mcpList(table, viewer.userId);
    totals[table] = mcp.total;
    // **画面の口とも一致していること**(片側だけを撃たない)。
    expect({ table, ids: sorted(mcp.ids) }).toEqual({
      table,
      ids: sorted((await listPage(table, viewer.cookie)).ids),
    });
  }
  expect(totals).toEqual({
    paused_people: 3,
    paused_teams: 1,
    paused_grants: 1,
    notes: 4,
  });
});

test("(E-4) 運営(`owner`)の名乗りでは、AI の口も今までどおり全部返る", async () => {
  // **すり抜けが1本残る** —— **運営は「誰に何を配ったか」も「誰が利用者か」も全件読める。**
  const totals: Record<string, number> = {};
  for (const table of REGISTRY_TABLES) {
    const mcp = await mcpList(table, admin.userId);
    totals[table] = mcp.total;
    expect({ table, ids: sorted(mcp.ids) }).toEqual({
      table,
      ids: sorted((await listPage(table, admin.cookie)).ids),
    });
  }
  expect(totals).toEqual({
    people: 5,
    teams: 3,
    project_grants: 5,
    milestone_grants: 2,
  });
});

test("(E-5) 【裁定5 / 追加条件A】AI の口でも `total` が可視行数と一致し、`limit=1` でページが穴あきにならない", async () => {
  const all = await mcpList("people", viewer.userId);
  expect({ total: all.total, count: all.ids.length }).toEqual({ total: 3, count: 3 });
  const walked: string[] = [];
  for (let offset = 0; offset < all.total; offset += 1) {
    const page = await mcpList("people", viewer.userId, { limit: 1, offset });
    expect({ offset, count: page.ids.length, total: page.total }).toEqual({
      offset,
      count: 1,
      total: all.total,
    });
    walked.push(...page.ids);
  }
  expect(sorted(walked)).toEqual(sorted(all.ids));
  expect((await mcpList("people", viewer.userId, { limit: 1, offset: all.total })).ids).toEqual([]);
});

// ===========================================================================
// (F) **「誰に配られているか」を返す口**
// (`GET .../records/:record_id/access-sources`)—— **`V18-M3-T02c`**
//
// **【本節を足した理由。上の (D) の doc も頭の doc も1バイトも書き換えていない】**
// **`V18-M3-T03` が台B で実測した**: **一覧から落ち、単票の口が 404 を返す行**に対して、
// **この口は 200 を返し、その人から見た判定4値(`read` / `write` / `delete` /
// `grant_write`)まで返していた。** **そもそも実在しない行では 404 が返るので、
// **「見えない行」と「無い行」が応答の上で区別できていた**(= 存在が漏れる)。
//
// **`ADR-0435` §Decision 2 の 3 は「単件は 404 にする」であり、この口も単件である。**
// **`app.ts` のこの口の doc は、着手前から
// 「**404 の規律。2つとも単票 `GET` にそろえる**」と宣言している** ——
// **名簿 / グループ / 付与の表の母集団だけが、そこにそろっていなかった。**
//
// **答えの形は 404 である**(403 ではない)—— **`T02b` が単票の口で採った形と
// 1ビットも同じにする**(本文も、行のIDのほかは1バイトも同じ)。
//
// **【禁止】本節は「この口が安全になった」ことを1件も示さない** ——
// **運営(`owner`)は今日どおり全部 200 であり**(F-3)**、
// **射程の外の表は今日どおり 200 である**(F-5)/(F-6)。
// ===========================================================================

/** 「誰に配られているか」の口を叩いて、HTTP ステータスだけを返す。 */
async function readSourcesStatus(table: string, recordId: string, cookie: string): Promise<number> {
  const response = await app.request(
    `/api/apps/${APP_ID}/tables/${table}/records/${recordId}/access-sources`,
    { headers: { cookie } },
  );
  return response.status;
}

/** 「誰に配られているか」の口を叩いて、ステータスと本文を返す。 */
async function readSources(
  table: string,
  recordId: string,
  cookie: string,
): Promise<{ status: number; body: unknown }> {
  const response = await app.request(
    `/api/apps/${APP_ID}/tables/${table}/records/${recordId}/access-sources`,
    { headers: { cookie } },
  );
  return { status: response.status, body: await response.json() };
}

test("(F-1) 絞りで一覧から落ちた行は、「誰に配られているか」の口でも 404 になる(403 にしない)", async () => {
  // **撃つ6行は (D-1) とまったく同じ集合である**(単票の口と1ビットも同じ答えにする)。
  const hidden = {
    people: [id.pe_hidden, id.pe_orphan],
    teams: [id.tm_stranger],
    project_grants: [id.pg_hidden, id.pg_orphan],
    milestone_grants: [id.mg_hidden],
  } as const;
  // **陽性対照(2本)**: **その6行が確かに一覧から落ちており**、**かつ単票の口が
  // 既に 404 を返していること**(落ちていなければ、あるいは単票が 200 のままなら、
  // 本検査は「そろえた」ことを1ミリも示さない)。
  for (const [table, rows] of Object.entries(hidden)) {
    const listed = await listIds(table, viewer.cookie);
    expect({ table, leaked: rows.filter((row) => listed.includes(row)) }).toEqual({
      table,
      leaked: [],
    });
    for (const row of rows) {
      expect({ table, row, single: await readOneStatus(table, row, viewer.cookie) }).toEqual({
        table,
        row,
        single: 404,
      });
    }
  }
  const statuses: Record<string, number> = {};
  for (const [table, rows] of Object.entries(hidden)) {
    for (const row of rows) {
      statuses[`${table}/${row}`] = await readSourcesStatus(table, row, viewer.cookie);
    }
  }
  // **6行とも 404 ちょうどである。** **200 も 403 も1件も無い。**
  expect(Object.values(statuses).filter((status) => status !== 404)).toEqual([]);
  expect(Object.values(statuses).filter((status) => status === 403)).toEqual([]);
  expect(Object.values(statuses).length).toBe(6);
});

test("(F-2) 見える行は今までどおり「誰に配られているか」の口で 200 が返る", async () => {
  const visible = {
    people: [id.pe_viewer, id.pe_direct, id.pe_inherited],
    teams: [id.tm_granted, id.tm_mine],
    project_grants: [id.pg_self, id.pg_direct, id.pg_group],
    milestone_grants: [id.mg_inherited],
  } as const;
  const statuses: Record<string, number> = {};
  for (const [table, rows] of Object.entries(visible)) {
    for (const row of rows) {
      statuses[`${table}/${row}`] = await readSourcesStatus(table, row, viewer.cookie);
    }
  }
  expect(Object.values(statuses).filter((status) => status !== 200)).toEqual([]);
  expect(Object.values(statuses).length).toBe(9);
  // **答えの形は着手前と1バイトも変わっていない**(キー3本がそろって返る)。
  const one = await readSources("people", id.pe_viewer, viewer.cookie);
  expect(Object.keys(one.body as Record<string, unknown>).sort()).toEqual([
    "access",
    "sources",
    "subject",
  ]);
});

test("(F-3) 運営(`owner`)には「誰に配られているか」の口でも今までどおり全部 200 が返る", async () => {
  const all = {
    people: [id.pe_viewer, id.pe_direct, id.pe_hidden, id.pe_inherited, id.pe_orphan],
    teams: [id.tm_granted, id.tm_mine, id.tm_stranger],
    project_grants: [id.pg_self, id.pg_direct, id.pg_hidden, id.pg_group, id.pg_orphan],
    milestone_grants: [id.mg_inherited, id.mg_hidden],
  } as const;
  const statuses: Record<string, number> = {};
  for (const [table, rows] of Object.entries(all)) {
    for (const row of rows) {
      statuses[`${table}/${row}`] = await readSourcesStatus(table, row, admin.cookie);
    }
  }
  expect(Object.values(statuses).filter((status) => status !== 200)).toEqual([]);
  expect(Object.values(statuses).length).toBe(15);
});

test("(F-4) 見えない行の 404 は、そもそも存在しない行の 404 と同じ本文である(存在を伏せる)", async () => {
  const hiddenRow = await readSources("people", id.pe_hidden, viewer.cookie);
  const absent = await readSources("people", "00000000-0000-4000-8000-000000000000", viewer.cookie);
  expect(hiddenRow.status).toBe(404);
  expect(absent.status).toBe(404);
  // **行IDだけが違い、形(`errors[].message` の雛形)は1バイトも同じである。**
  const shape = (body: unknown): unknown =>
    JSON.parse(
      JSON.stringify(body)
        .replaceAll(id.pe_hidden, "<id>")
        .replaceAll("00000000-0000-4000-8000-000000000000", "<id>"),
    );
  expect(shape(hiddenRow.body)).toEqual(shape(absent.body));
  // **単票の口が返す 404 の本文とも、1バイトも同じである**(`T02b` の形にそろえた)。
  const single = await readOne("people", id.pe_hidden, viewer.cookie);
  expect(shape(single.body)).toEqual(shape(hiddenRow.body));
});

// --- 射程の外 —— **直す前も直した後も緑**(`T01` 完了条件 (b) / (c) のこの口の版)-------

test("(F-5) `enabled: false` の宣言が名指しした3表は、この口でも今日どおり 200 を返す", async () => {
  const loaded = manifest();
  const made: { table: string; id: string }[] = [];
  withDb((db) => {
    const row = (table: string, values: Record<string, unknown>): string => {
      const created = createRecord(db, loaded, table, values);
      expect({ table, ok: created.ok }).toEqual({ table, ok: true });
      const rowId = (created as { value: { _id: string } }).value._id;
      made.push({ table, id: rowId });
      return rowId;
    };
    const teamId = row("paused_teams", { title: "停止中の班" });
    row("paused_people", { account: "p-a", team: teamId });
    const targetId = row("paused", { title: "停止中の行" });
    row("paused_grants", { paused: targetId, team: teamId, permission: "reader" });
  });
  const statuses: Record<string, number> = {};
  for (const entry of made) {
    if (entry.table === "paused") {
      // **宣言を載せている表そのもの**(射程の外ではない)。**ここでは撃たない。**
      continue;
    }
    statuses[`${entry.table}/${entry.id}`] = await readSourcesStatus(
      entry.table,
      entry.id,
      viewer.cookie,
    );
  }
  expect(Object.values(statuses).filter((status) => status !== 200)).toEqual([]);
  expect(Object.values(statuses).length).toBe(3);
});

test("(F-6) どの宣言からも名指しされていない表(`notes`)は、この口でも今日どおり 200 を返す", async () => {
  const loaded = manifest();
  let noteId = "";
  withDb((db) => {
    const created = createRecord(db, loaded, "notes", { body: "一" });
    expect(created.ok).toBe(true);
    noteId = (created as { value: { _id: string } }).value._id;
  });
  expect(await readSourcesStatus("notes", noteId, viewer.cookie)).toBe(200);
});

test("(F-7) 宣言を載せている表(`projects` / `milestones`)の答えは1ビットも動いていない", async () => {
  // **母集団の枝は名簿 / グループ / 付与の3役だけに当たる** —— **親の表には当たらない。**
  // **見える親は 200、見えない親は着手前から 404 である**(要求者自身が読めないため)。
  expect(await readSourcesStatus("projects", id.pr_visible, viewer.cookie)).toBe(200);
  expect(await readSourcesStatus("projects", id.pr_hidden, viewer.cookie)).toBe(404);
  expect(await readSourcesStatus("milestones", id.ms_visible, viewer.cookie)).toBe(200);
  expect(await readSourcesStatus("milestones", id.ms_hidden, viewer.cookie)).toBe(404);
});
