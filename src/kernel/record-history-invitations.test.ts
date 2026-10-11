/**
 * **行の招待の記録**(計画 §27-6 の重2 → T03b。決定 `D-V23-218`・`D-V23-221`)。
 *
 * 招待の先の行の表が `history: true` のときだけ、その行の履歴に1件ずつ足す。 `op` は `invite`(出した)・
 * `invite_accept`(承諾)・`invite_decline`(断った)・`invite_revoke`(取り消した)。 行のコードでの承諾も
 * `invite_accept`。 `changes` は招かれた人(利用者の id。コードの招待は相手の行の鍵 `row:<表>:<行ID>`)と
 * 配る権限名。 入口は `http`。 操作者はその操作をした人。 招待の書込と同じトランザクション
 * (内部表に `RAISE(ABORT)` の TRIGGER を付けると、招待の書込も残らない)。 宣言の無い表では1件も入らない。
 *
 * 題材はコードの招待の検査(`src/server/row-code-invitations.test.ts`)と同じ形の案件(R)と部隊(S)。
 * 置き場は `src/kernel`(`kernel-import-drift` の写しに行を足さないため)。
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerApp } from "../server/app.ts";
import { seedSession, TEST_ORIGIN } from "../server/test-helpers.ts";
import {
  appDbPath,
  applyManifest,
  createApp,
  createRecord,
  KernelMetaStore,
  type Manifest,
} from "./index.ts";

const APP_ID = "rh-inv";
const ALL = ["read", "write", "delete"];
const TABLES = ["members", "groups", "units", "unit_grants", "projects", "project_grants"];

type Any = Record<string, unknown>;

const ref = (id: string, table: string): Any => ({
  id,
  name: id,
  type: "reference",
  reference_table: table,
});

function manifest(history: boolean): Manifest {
  const rules = (can: string[]) => TABLES.map((table) => ({ target: "table", table, can }));
  const members = { table: "members", account: "account", group: "grp" };
  return {
    app: {
      id: APP_ID,
      name: "招待の履歴",
      tables: [
        {
          id: "members",
          name: "名簿",
          representative_field: "name",
          fields: [
            { id: "name", name: "名前", type: "text", required: true },
            { id: "account", name: "利用者ID", type: "text", required: true },
            ref("grp", "groups"),
          ],
        },
        { id: "groups", name: "グループ", fields: [{ id: "title", name: "名前", type: "text" }] },
        {
          id: "units",
          name: "部隊",
          representative_field: "title",
          fields: [{ id: "title", name: "名前", type: "text" }],
          access_control: {
            enabled: true,
            permissions: [
              { id: "unit_lead", name: "長", read: true, write: true, delete: true },
              { id: "unit_member", name: "所属", read: true, write: false, delete: false },
            ],
            creator_permission: "unit_lead",
            grant: {
              table: "unit_grants",
              target: "unit",
              member: "member",
              group: "group",
              permission: "permission",
            },
            members,
            groups: { table: "groups" },
          },
        },
        {
          id: "unit_grants",
          name: "部隊の付与",
          fields: [
            ref("unit", "units"),
            ref("member", "members"),
            ref("group", "groups"),
            {
              id: "permission",
              name: "権限",
              type: "select",
              options: ["unit_lead", "unit_member"],
            },
          ],
        },
        {
          id: "projects",
          name: "案件",
          representative_field: "title",
          ...(history ? { history: true } : {}),
          fields: [{ id: "title", name: "名前", type: "text" }],
          access_control: {
            enabled: true,
            permissions: [
              { id: "p_admin", name: "管理", read: true, write: true, delete: true },
              { id: "p_worker", name: "担当", read: true, write: true, delete: true },
            ],
            creator_permission: "p_admin",
            grant: {
              table: "project_grants",
              target: "project",
              member: "member",
              permission: "permission",
              principal_row: { column: "unit", table: "units", via: ["unit_member"] },
            },
            members,
            groups: { table: "groups" },
            invitations: { grantable: ["p_worker"] },
          },
        },
        {
          id: "project_grants",
          name: "案件の付与",
          fields: [
            ref("project", "projects"),
            ref("member", "members"),
            ref("unit", "units"),
            { id: "permission", name: "権限", type: "select", options: ["p_admin", "p_worker"] },
          ],
        },
      ],
      views: [],
      workspace: { invitations: { label: "招待" } },
      roles: [
        {
          id: "owner",
          name: "運営",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            ...rules(ALL),
          ],
        },
        { id: "staff", name: "担当", rules: rules(ALL) },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
    },
  } as unknown as Manifest;
}

type Who = { cookie: string; userId: string; username: string };
type Rig = {
  dataRoot: string;
  server: ReturnType<typeof createServerApp>;
  padmin: Who;
  guest: Who;
  lead: Who;
  project: string;
  unit: string;
};

const dataRoots: string[] = [];

afterEach(async () => {
  for (const dir of dataRoots.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function openDb(rig: { dataRoot: string }): Database {
  return new Database(appDbPath(rig.dataRoot, APP_ID));
}

async function makeRig(history = true): Promise<Rig> {
  const dataRoot = await mkdtemp(join(tmpdir(), "gp-rh-inv-"));
  dataRoots.push(dataRoot);
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, "招待の履歴", { app_id: APP_ID });
  } finally {
    meta.close();
  }
  const m = manifest(history);
  const applied = applyManifest(dataRoot, APP_ID, m);
  if (!applied.valid) {
    throw new Error(JSON.stringify(applied.errors));
  }
  const seed = (username: string, role: string): Who => {
    const s = seedSession(dataRoot, APP_ID, { role, username });
    return { cookie: s.cookie, userId: s.userId, username };
  };
  seed("boss", "owner");
  const padmin = seed("padmin", "staff");
  const guest = seed("guest", "staff");
  const lead = seed("lead", "staff");
  const db = new Database(appDbPath(dataRoot, APP_ID));
  try {
    const put = (table: string, values: Any): string => {
      const created = createRecord(db, m, table, values);
      if (!created.ok) {
        throw new Error(`${table} に行を置けない: ${JSON.stringify(created.errors)}`);
      }
      return created.value._id;
    };
    const memberOf: Record<string, string> = {};
    for (const who of [padmin, guest, lead]) {
      memberOf[who.username] = put("members", { name: who.username, account: who.userId });
    }
    const unit = put("units", { title: "部隊1" });
    put("unit_grants", { unit, member: memberOf.lead, permission: "unit_lead" });
    const project = put("projects", { title: "案件1" });
    put("project_grants", { project, member: memberOf.padmin, permission: "p_admin" });
    return {
      dataRoot,
      server: createServerApp({ dataRoot }),
      padmin,
      guest,
      lead,
      project,
      unit,
    };
  } finally {
    db.close();
  }
}

type Sent = { status: number; body: Any; text: string };

async function call(rig: Rig, method: "GET" | "POST", path: string, who: Who, body?: unknown) {
  const headers: Record<string, string> = { origin: TEST_ORIGIN, cookie: who.cookie };
  if (method === "POST") {
    headers["content-type"] = "application/json";
  }
  const res = await rig.server.request(
    new Request(`http://localhost/api/apps/${APP_ID}${path}`, {
      method,
      headers,
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
    }),
  );
  const text = await res.text();
  let parsed: Any;
  try {
    parsed = JSON.parse(text) as Any;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed, text } satisfies Sent;
}

const invite = (rig: Rig, body: Any) =>
  call(rig, "POST", `/tables/projects/records/${rig.project}/invitations`, rig.padmin, body);

const respond = (rig: Rig, who: Who, id: string, action: string) =>
  call(rig, "POST", `/invitations/${id}`, who, { action });

function invitationIds(rig: Rig): string[] {
  const db = openDb(rig);
  try {
    const has = db
      .query<{ n: number }, []>(
        "SELECT count(*) AS n FROM sqlite_master WHERE name = '_row_invitations'",
      )
      .get();
    if ((has?.n ?? 0) === 0) {
      return [];
    }
    return db
      .query<{ id: string }, []>("SELECT id FROM _row_invitations ORDER BY created_at, id")
      .all()
      .map((row) => row.id);
  } finally {
    db.close();
  }
}

function grantRows(rig: Rig): Any[] {
  const db = openDb(rig);
  try {
    return db.query<Any, []>("SELECT * FROM project_grants ORDER BY rowid").all();
  } finally {
    db.close();
  }
}

function hasHistoryTable(rig: Rig): boolean {
  const db = openDb(rig);
  try {
    return (
      (db
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM sqlite_master WHERE name = '_record_history'",
        )
        .get()?.n ?? 0) > 0
    );
  } finally {
    db.close();
  }
}

type Row = {
  table_id: string;
  record_id: string;
  op: string;
  actor_id: string;
  actor_login: string;
  actor_role: string;
  entry: string;
  changes: Any[];
};

/** 招待の記録(`invite` で始まる操作)だけ。 */
function invitationHistory(rig: Rig): Row[] {
  if (!hasHistoryTable(rig)) {
    return [];
  }
  const db = openDb(rig);
  try {
    return db
      .query<Any, []>("SELECT * FROM _record_history WHERE op LIKE 'invite%' ORDER BY seq")
      .all()
      .map((row) => ({ ...row, changes: JSON.parse(String(row.changes)) }) as Row);
  } finally {
    db.close();
  }
}

function summary(row: Row | undefined): Any {
  return {
    table: row?.table_id,
    record: row?.record_id,
    op: row?.op,
    actor: row?.actor_id,
    login: row?.actor_login,
    entry: row?.entry,
    changes: row?.changes,
  };
}

function expected(rig: Rig, op: string, actor: Who, invitee: string): Any {
  return {
    table: "projects",
    record: rig.project,
    op,
    actor: actor.userId,
    login: actor.username,
    entry: "http",
    changes: [{ invitee, permission: "p_worker" }],
  };
}

/** 内部表を先に作り、指定の操作の INSERT を `RAISE(ABORT)` で断る TRIGGER を付ける(壊し方)。 */
function breakHistory(rig: Rig, op: string): void {
  const db = openDb(rig);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS _record_history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  op TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_login TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  entry TEXT NOT NULL,
  at TEXT NOT NULL,
  changes TEXT NOT NULL
)`);
    db.exec(
      `CREATE TRIGGER rh_break BEFORE INSERT ON _record_history WHEN NEW.op = '${op}' BEGIN SELECT RAISE(ABORT, 'rh-broken'); END`,
    );
  } finally {
    db.close();
  }
}

async function issueByName(rig: Rig): Promise<string> {
  const sent = await invite(rig, { login: "guest", permission: "p_worker" });
  expect(sent.status, sent.text).toBe(202);
  const ids = invitationIds(rig);
  expect(ids).toHaveLength(1);
  return ids[0] as string;
}

async function issueByCode(rig: Rig): Promise<string> {
  const code = await call(rig, "POST", `/tables/units/records/${rig.unit}/invite-code`, rig.lead);
  expect(code.status, code.text).toBe(200);
  const sent = await invite(rig, { code: code.body.code, permission: "p_worker" });
  expect(sent.status, sent.text).toBe(202);
  const ids = invitationIds(rig);
  expect(ids).toHaveLength(1);
  return ids[0] as string;
}

describe("V23-M8-T03b (I) 行の招待は、先の行の履歴に1件ずつ入る", () => {
  test("(I-1) 名前の招待を出す: invite・招かれた人の id・権限名・http・招待した人", async () => {
    const rig = await makeRig();
    await issueByName(rig);
    expect(invitationHistory(rig).map(summary)).toEqual([
      expected(rig, "invite", rig.padmin, "login:guest"),
    ]);
  });

  test("(I-2) 承諾: invite_accept・承諾した人。付与の行もできる", async () => {
    const rig = await makeRig();
    const id = await issueByName(rig);
    const sent = await respond(rig, rig.guest, id, "accept");
    expect(sent.status, sent.text).toBe(200);
    expect(grantRows(rig)).toHaveLength(2);
    expect(invitationHistory(rig).map(summary)).toEqual([
      expected(rig, "invite", rig.padmin, "login:guest"),
      expected(rig, "invite_accept", rig.guest, rig.guest.userId),
    ]);
  });

  test("(I-3) 辞退: invite_decline・断った人", async () => {
    const rig = await makeRig();
    const id = await issueByName(rig);
    const sent = await respond(rig, rig.guest, id, "decline");
    expect(sent.status, sent.text).toBe(200);
    expect(invitationHistory(rig).map(summary)).toEqual([
      expected(rig, "invite", rig.padmin, "login:guest"),
      expected(rig, "invite_decline", rig.guest, rig.guest.userId),
    ]);
  });

  test("(I-4) 取消: invite_revoke・取り消した人", async () => {
    const rig = await makeRig();
    const id = await issueByName(rig);
    const sent = await respond(rig, rig.padmin, id, "revoke");
    expect(sent.status, sent.text).toBe(200);
    expect(invitationHistory(rig).map(summary)).toEqual([
      expected(rig, "invite", rig.padmin, "login:guest"),
      expected(rig, "invite_revoke", rig.padmin, "login:guest"),
    ]);
  });

  test("(I-5) 行のコードでの招待と承諾: 招かれた相手は行の鍵。承諾も invite_accept", async () => {
    const rig = await makeRig();
    const id = await issueByCode(rig);
    const key = `row:units:${rig.unit}`;
    const sent = await respond(rig, rig.lead, id, "accept");
    expect(sent.status, sent.text).toBe(200);
    expect(grantRows(rig).filter((row) => row.unit === rig.unit)).toHaveLength(1);
    expect(invitationHistory(rig).map(summary)).toEqual([
      expected(rig, "invite", rig.padmin, key),
      expected(rig, "invite_accept", rig.lead, key),
    ]);
  });

  test("(I-6) 招待の記録は行の項目の変更を持たない(項目の記録の行は増えない)", async () => {
    const rig = await makeRig();
    await issueByName(rig);
    const db = openDb(rig);
    try {
      const ops = db
        .query<{ op: string }, []>("SELECT op FROM _record_history ORDER BY seq")
        .all()
        .map((row) => row.op);
      expect(ops).toEqual(["create", "invite"]);
    } finally {
      db.close();
    }
  });
});

describe("V23-M8-T03b (B) 招待の書込と同じトランザクション", () => {
  test("(B-1) 出す: 記録が落ちると招待も保存されない", async () => {
    const rig = await makeRig();
    breakHistory(rig, "invite");
    const sent = await invite(rig, { login: "guest", permission: "p_worker" });
    expect(sent.status).toBeGreaterThanOrEqual(400);
    expect(invitationIds(rig)).toEqual([]);
  });

  test("(B-2) 承諾: 記録が落ちると招待は残り、付与の行もできない", async () => {
    const rig = await makeRig();
    const id = await issueByName(rig);
    breakHistory(rig, "invite_accept");
    const sent = await respond(rig, rig.guest, id, "accept");
    expect(sent.status).toBeGreaterThanOrEqual(400);
    expect(invitationIds(rig)).toEqual([id]);
    expect(grantRows(rig)).toHaveLength(1);
  });

  test("(B-3) 辞退: 記録が落ちると招待は残る", async () => {
    const rig = await makeRig();
    const id = await issueByName(rig);
    breakHistory(rig, "invite_decline");
    const sent = await respond(rig, rig.guest, id, "decline");
    expect(sent.status).toBeGreaterThanOrEqual(400);
    expect(invitationIds(rig)).toEqual([id]);
  });

  test("(B-4) 取消: 記録が落ちると招待は残る", async () => {
    const rig = await makeRig();
    const id = await issueByName(rig);
    breakHistory(rig, "invite_revoke");
    const sent = await respond(rig, rig.padmin, id, "revoke");
    expect(sent.status).toBeGreaterThanOrEqual(400);
    expect(invitationIds(rig)).toEqual([id]);
  });
});

describe("V23-M8-T03b (N) 宣言の無い表では1件も入らない", () => {
  test("(N-1) 出す・承諾・辞退・取消・コードの招待をしても、内部表は作られない", async () => {
    const rig = await makeRig(false);
    const first = await issueByName(rig);
    expect((await respond(rig, rig.guest, first, "decline")).status).toBe(200);
    const second = await issueByName(rig);
    expect((await respond(rig, rig.padmin, second, "revoke")).status).toBe(200);
    const third = await issueByName(rig);
    expect((await respond(rig, rig.guest, third, "accept")).status).toBe(200);
    const fourth = await issueByCode(rig);
    expect((await respond(rig, rig.lead, fourth, "accept")).status).toBe(200);
    expect(hasHistoryTable(rig)).toBe(false);
  });
});

// =====================================================================================
// **【`V23-M9-T01`】名前の招待の発行と取消の1件は、相手が居ても居なくても打ったログイン名で記録する**
// (決定 `D-V23-234`・`D-V23-262`。`ADR-0549` §1-7・`ADR-0550` §4-2)。 承諾・辞退は今日どおり本人の利用者 ID。
// 既に利用者 ID で記録された1件の読み方は変えない(表示名のまま)。 表示名を持つ相手を足して、表示と打った名前を分ける。
// =====================================================================================

const CAROL_DISPLAY = "キャロル";

/**
 * 表示名を持つ相手(ログイン名 carol・表示名 キャロル)を足す。 `AuthStore` は動的に読む(頭の import を足すと、
 * `ADR-0550` が `ファイル:行` で名指しした上の検査の行がずれるため)。
 */
async function seedCarol(rig: Rig): Promise<Who> {
  const { AuthStore } = await import("../auth/store.ts");
  const store = AuthStore.openForApp(rig.dataRoot, APP_ID);
  try {
    const created = store.createUser({
      username: "carol",
      role: "staff" as never,
      displayName: CAROL_DISPLAY,
    });
    const session = store.createSession(created.id, 3600);
    const db = openDb(rig);
    try {
      const member = createRecord(db, manifest(true), "members", {
        name: "carol",
        account: created.id,
      });
      if (!member.ok) {
        throw new Error(`名簿に行を置けない: ${JSON.stringify(member.errors)}`);
      }
    } finally {
      db.close();
    }
    return { cookie: `st_session=${session.id}`, userId: created.id, username: "carol" };
  } finally {
    store.close();
  }
}

type ShownItem = { op: string; changes: Any[] };

/** 案件の行の履歴を、招待した人が HTTP の単件 GET(`?history=1`)で読んだ招待の1件だけ(古い順)。 */
async function shownInvitations(rig: Rig): Promise<ShownItem[]> {
  const sent = await call(
    rig,
    "GET",
    `/tables/projects/records/${rig.project}?history=1`,
    rig.padmin,
  );
  expect(sent.status, sent.text).toBe(200);
  const page = sent.body.history as { items: ShownItem[] } | undefined;
  expect(page, sent.text).toBeDefined();
  return (page?.items ?? [])
    .filter((item) => item.op.startsWith("invite"))
    .map((item) => ({ op: item.op, changes: item.changes }))
    .reverse();
}

const carolInvite = (rig: Rig) => invite(rig, { login: "carol", permission: "p_worker" });

describe("V23-M9-T01 名前の招待の発行と取消は、相手が居ても打ったログイン名で記録する(D-V23-234・D-V23-262)", () => {
  test("D-V23-234: 居る相手への名前の招待の発行は login:<打った名前> で記録し、履歴の表示も打った名前(表示名と利用者 ID を出さない)", async () => {
    const rig = await makeRig();
    const carol = await seedCarol(rig);
    const sent = await carolInvite(rig);
    expect(sent.status, sent.text).toBe(202);
    expect(invitationHistory(rig).map(summary)).toEqual([
      expected(rig, "invite", rig.padmin, "login:carol"),
    ]);
    const shown = await shownInvitations(rig);
    expect(shown).toEqual([
      { op: "invite", changes: [{ invitee: "carol", permission: "p_worker" }] },
    ]);
    expect(JSON.stringify(shown)).not.toContain(CAROL_DISPLAY);
    expect(JSON.stringify(shown)).not.toContain(carol.userId);
  });

  test("D-V23-262: 居る相手への名前の招待の取消も login:<打った名前> で記録し、表示も打った名前", async () => {
    const rig = await makeRig();
    const carol = await seedCarol(rig);
    expect((await carolInvite(rig)).status).toBe(202);
    const [id] = invitationIds(rig);
    const sent = await respond(rig, rig.padmin, id as string, "revoke");
    expect(sent.status, sent.text).toBe(200);
    expect(invitationHistory(rig).map(summary)).toEqual([
      expected(rig, "invite", rig.padmin, "login:carol"),
      expected(rig, "invite_revoke", rig.padmin, "login:carol"),
    ]);
    const shown = await shownInvitations(rig);
    expect(shown).toEqual([
      { op: "invite", changes: [{ invitee: "carol", permission: "p_worker" }] },
      { op: "invite_revoke", changes: [{ invitee: "carol", permission: "p_worker" }] },
    ]);
    expect(JSON.stringify(shown)).not.toContain(CAROL_DISPLAY);
    expect(JSON.stringify(shown)).not.toContain(carol.userId);
  });

  test("D-V23-234: 承諾・辞退は今日どおり本人の利用者 ID で記録し、表示は表示名", async () => {
    for (const action of ["accept", "decline"] as const) {
      const rig = await makeRig();
      const carol = await seedCarol(rig);
      expect((await carolInvite(rig)).status).toBe(202);
      const [id] = invitationIds(rig);
      const sent = await respond(rig, carol, id as string, action);
      expect(sent.status, sent.text).toBe(200);
      const op = action === "accept" ? "invite_accept" : "invite_decline";
      expect(invitationHistory(rig).map(summary)).toEqual([
        expected(rig, "invite", rig.padmin, "login:carol"),
        expected(rig, op, carol, carol.userId),
      ]);
      expect(await shownInvitations(rig)).toEqual([
        { op: "invite", changes: [{ invitee: "carol", permission: "p_worker" }] },
        { op, changes: [{ invitee: CAROL_DISPLAY, permission: "p_worker" }] },
      ]);
    }
  });

  test("D-V23-262: 既に利用者 ID で記録された発行・取消の1件は書き換えず、読むときも今日どおり表示名", async () => {
    const rig = await makeRig();
    const carol = await seedCarol(rig);
    const db = openDb(rig);
    try {
      for (const op of ["invite", "invite_revoke"]) {
        db.query(
          `INSERT INTO _record_history (table_id, record_id, op, actor_id, actor_login, actor_role, entry, at, changes)
           VALUES ('projects', ?, ?, ?, 'padmin', 'staff', 'http', ?, ?)`,
        ).run(
          rig.project,
          op,
          rig.padmin.userId,
          new Date().toISOString(),
          JSON.stringify([{ invitee: carol.userId, permission: "p_worker" }]),
        );
      }
    } finally {
      db.close();
    }
    expect(invitationHistory(rig).map((row) => row.changes)).toEqual([
      [{ invitee: carol.userId, permission: "p_worker" }],
      [{ invitee: carol.userId, permission: "p_worker" }],
    ]);
    expect(await shownInvitations(rig)).toEqual([
      { op: "invite", changes: [{ invitee: CAROL_DISPLAY, permission: "p_worker" }] },
      { op: "invite_revoke", changes: [{ invitee: CAROL_DISPLAY, permission: "p_worker" }] },
    ]);
  });
});
