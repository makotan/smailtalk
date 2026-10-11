/**
 * **コードの招待 —— 行の招待用コードで相手の行(S)を指す招待の発行・受け取り・承諾・辞退・取消**
 * (`V23-M6-T06`。門A = `ADR-0502`(`SC-G21`)を補う `ADR-0538` §Decision 1-6。決定 `D-V23-152`・`D-V23-154`・
 * `D-V23-155`・`D-V23-163`・`D-V23-166`・`D-V23-167`・`D-V23-168`・`D-V23-171`。計画 §25-6 重5・中3・中4・中8・中9。
 * 授権 `ADR-0539`・`ADR-0540`)。
 *
 * ## この検査が測るもの / 測らないもの(**先に書く**)
 *
 * **題材**: 部隊(S。`units`。親 `networks` から引き継ぐ)と案件(R。`projects`)。 案件の付与表の `unit` 列が
 * 部隊の行を指す(`principal_row`。`via` は `unit_member`)。 案件は招待を宣言する(`grantable` は `p_worker`、
 * `by` は省いて `creator_permission` の `p_admin`)。
 * - `padmin`: 案件1・案件2 の管理者(招待する人)。 `pworker`: 案件1 の担当(`by` を持たない)。
 * - `lead`: 部隊 A1 の管理者(直接 `unit_lead`)。 `glead`: 部隊 A1 の管理者(グループ経由)。 `lead2`: 部隊 A2 の管理者。
 * - `member`: 部隊 A1 の `unit_member`(部隊経由で案件を読む専門家)。 `netadmin`: 親(連合)の管理者。 `boss`: 運営。
 *
 * **測るもの**:
 * 1. 発行: 本文の `code` は、守る表が `principal_row` を宣言しているときだけ受ける(他は今日と同じ 400・同じ 202)。
 *    存在しないコード・招待者が宛先に `via` を持つときは、同じ 202 と同じ本文で保存しない。 内部表には
 *    `invitee_key` = `row:<表>:<行ID>`、`invitee_login` と `invitee_user_id` は空文字。 同じ R・同じ S は上書き。
 * 2. 受け取り: 宛先の S に `creator_permission` を持つ人(直接とグループ。親と S 経由は数えない)にだけ届き、
 *    8つ目の値(S の代表項目)が付く。 名前の招待と `principal_row` の無いアプリの応答は1バイトも変わらない。
 * 3. 承諾: `{target: R, 相手の列: S, permission}` の1行ができ、S 経由の専門家が R を読めるようになる。 S の管理者で
 *    ない人は承諾も辞退もできない。 招待者が宛先に `via` を持てば断る。 S に `via` を持つ人全員が R の親を読めること。
 *    `unique` の拒否は 422。 期限切れ・R や S が消えた・招待者が権限を失ったら断る。 器の中で見直す。
 *    `target_roles`・`group_from` は効かない。 再発行の後も古いコードで出した招待は承諾できる。
 * 4. 辞退・取消。 適用の最中は 409。
 * 5. 【2026-10-01 追記。決定 `D-V23-176`】同じ R と同じ S を指す付与の行が既に在れば、発行は同じ 202 と同じ本文で保存せず、
 *    承諾は(器の外でも中でも)理由を付けて断る(招待は残り、付与の行は増えない)。
 *
 * **測らないもの(誇張しない)**: 画面(`T06b`)。 書き出し版(申告。`T09`)。 MCP(道具を足さない)。
 * 判定の関門ごとに壊すと赤になることは、検査の外の台本で1つずつ外して確かめる(記録 `records/v23-m6-t06.md`)。
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  appDbPath,
  applyManifest,
  createApp,
  createRecord,
  KernelMetaStore,
  type Manifest,
} from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN } from "./test-helpers.ts";

/** 読みの数え(`(M-6)`)が素通しで呼ぶ元の `query`。 */
const originalQuery = Database.prototype.query;

const APP_ID = "pr-code-inv";
const ALL = ["read", "write", "delete"];
const TABLES = [
  "members",
  "groups",
  "networks",
  "network_grants",
  "units",
  "unit_grants",
  "programs",
  "program_grants",
  "projects",
  "project_grants",
];
const UNIQUE_MESSAGE = "この部隊には、もう別の案件の権限があります。";
const MSG_PRINCIPAL_SELF =
  "招待した人が、宛先の行に属しているため承諾できません。招待した人に確かめてもらってください。";
const MSG_PRINCIPAL_PARENT =
  "宛先の行に属する人の中に、この行の元になっている行を読めない人がいるため承諾できません。先に元の行に招待してもらってください。";
const MSG_INVITER_DENIED =
  "招待した人が、この行の権限を渡せなくなったため承諾できません。招待し直してもらってください。";
const MSG_ROW_GONE = "招待された行が見つからないため承諾できません。";
const MSG_PRINCIPAL_GRANTED =
  "宛先の行には、この行の権限がもう渡されているため承諾できません。招待した人に確かめてもらってください。";
const MSG_LOGIN = "招待する相手のログイン名(login)を文字列で指定してください。";

type Variant = {
  principalRow?: boolean;
  /** 案件が `programs` から引き継ぐ(`inherit_from`)。 */
  parent?: boolean;
  /** 付与表の `unit` 列に `unique` と `unique_message`。 */
  unique?: boolean;
  /** 招待の宣言に `target_roles`(`viewer` だけ)と `group_from`(`team`)。 */
  extras?: boolean;
};

const ref = (id: string, table: string) => ({
  id,
  name: id,
  type: "reference",
  reference_table: table,
});

function manifest(variant: Variant = {}): Manifest {
  const principalRow = variant.principalRow ?? true;
  const rules = (can: string[]) => TABLES.map((table) => ({ target: "table", table, can }));
  const members = { table: "members", account: "account", group: "grp" };
  const plainMembers = { table: "members", account: "account" };
  return {
    app: {
      id: APP_ID,
      name: "コードの招待",
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
          id: "networks",
          name: "連合",
          fields: [{ id: "title", name: "名前", type: "text" }],
          access_control: {
            enabled: true,
            permissions: [{ id: "unit_lead", name: "長", read: true, write: true, delete: true }],
            creator_permission: "unit_lead",
            grant: {
              table: "network_grants",
              target: "network",
              member: "member",
              permission: "permission",
            },
            members: plainMembers,
          },
        },
        {
          id: "network_grants",
          name: "連合の付与",
          fields: [
            ref("network", "networks"),
            ref("member", "members"),
            { id: "permission", name: "権限", type: "select", options: ["unit_lead"] },
          ],
        },
        {
          id: "units",
          name: "部隊",
          representative_field: "title",
          fields: [{ id: "title", name: "名前", type: "text" }, ref("network", "networks")],
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
            inherit_from: ["network"],
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
          id: "programs",
          name: "計画",
          fields: [{ id: "title", name: "名前", type: "text" }],
          access_control: {
            enabled: true,
            permissions: [
              { id: "prog_admin", name: "計画の管理", read: true, write: true, delete: true },
              { id: "prog_reader", name: "計画の閲覧", read: true, write: false, delete: false },
            ],
            creator_permission: "prog_admin",
            grant: {
              table: "program_grants",
              target: "program",
              member: "member",
              permission: "permission",
            },
            members: plainMembers,
          },
        },
        {
          id: "program_grants",
          name: "計画の付与",
          fields: [
            ref("program", "programs"),
            ref("member", "members"),
            {
              id: "permission",
              name: "権限",
              type: "select",
              options: ["prog_admin", "prog_reader"],
            },
          ],
        },
        {
          id: "projects",
          name: "案件",
          representative_field: "title",
          fields: [
            { id: "title", name: "名前", type: "text" },
            ref("program", "programs"),
            ref("team", "groups"),
          ],
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
              ...(principalRow
                ? { principal_row: { column: "unit", table: "units", via: ["unit_member"] } }
                : {}),
            },
            members,
            groups: { table: "groups" },
            invitations: {
              grantable: ["p_worker"],
              ...(variant.extras ? { target_roles: ["viewer"], group_from: "team" } : {}),
            },
            ...(variant.parent ? { inherit_from: ["program"] } : {}),
          },
        },
        {
          id: "project_grants",
          name: "案件の付与",
          fields: [
            ref("project", "projects"),
            ref("member", "members"),
            variant.unique
              ? { ...ref("unit", "units"), unique: true, unique_message: UNIQUE_MESSAGE }
              : ref("unit", "units"),
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
type Name =
  | "boss"
  | "padmin"
  | "pworker"
  | "lead"
  | "glead"
  | "lead2"
  | "member"
  | "netadmin"
  | "outsider";
type Rig = {
  dataRoot: string;
  variant: Variant;
  server: ReturnType<typeof createServerApp>;
  who: Record<Name, Who>;
  memberRow: Record<Name, string>;
  unitA1: string;
  unitA2: string;
  project1: string;
  project2: string;
  program: string;
  groupH: string;
};

let dataRoot = "";

afterEach(async () => {
  if (dataRoot !== "") {
    await rm(dataRoot, { recursive: true, force: true });
    dataRoot = "";
  }
});

function openDb(): Database {
  return new Database(appDbPath(dataRoot, APP_ID));
}

function put(rig: { variant: Variant }, db: Database, table: string, values: object): string {
  const created = createRecord(db, manifest(rig.variant), table, values as Record<string, unknown>);
  if (!created.ok) {
    throw new Error(`${table} に行を置けない: ${JSON.stringify(created.errors)}`);
  }
  return created.value._id;
}

/** DB に直に1行置く(付与の行・名簿の行。HTTP の書込の関門の外で姿を作る)。 */
function putNow(rig: Rig, table: string, values: object): string {
  const db = openDb();
  try {
    return put(rig, db, table, values);
  } finally {
    db.close();
  }
}

function sqlNow(sql: string, ...args: string[]): void {
  const db = openDb();
  try {
    db.query(sql).run(...args);
  } finally {
    db.close();
  }
}

async function makeRig(variant: Variant = {}): Promise<Rig> {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-pr-code-inv-"));
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, "コードの招待", { app_id: APP_ID });
  } finally {
    meta.close();
  }
  const applied = applyManifest(dataRoot, APP_ID, manifest(variant));
  if (!applied.valid) {
    throw new Error(JSON.stringify(applied.errors));
  }
  const seed = (username: string, role: string): Who => {
    const s = seedSession(dataRoot, APP_ID, { role, username });
    return { cookie: s.cookie, userId: s.userId, username };
  };
  const who: Record<Name, Who> = {
    boss: seed("boss", "owner"),
    padmin: seed("padmin", "staff"),
    pworker: seed("pworker", "staff"),
    lead: seed("lead", "staff"),
    glead: seed("glead", "staff"),
    lead2: seed("lead2", "staff"),
    member: seed("member", "staff"),
    netadmin: seed("netadmin", "staff"),
    outsider: seed("outsider", "staff"),
  };
  const holder = { variant };
  const db = openDb();
  try {
    const groupG = put(holder, db, "groups", { title: "G" });
    const groupH = put(holder, db, "groups", { title: "H" });
    const memberRow = {} as Record<Name, string>;
    for (const name of Object.keys(who) as Name[]) {
      const w = who[name];
      memberRow[name] = put(holder, db, "members", {
        name: w.username,
        account: w.userId,
        ...(name === "glead" ? { grp: groupG } : {}),
      });
    }
    const network = put(holder, db, "networks", { title: "連合1" });
    put(holder, db, "network_grants", {
      network,
      member: memberRow.netadmin,
      permission: "unit_lead",
    });
    const unitA1 = put(holder, db, "units", { title: "部隊A1", network });
    const unitA2 = put(holder, db, "units", { title: "部隊A2", network });
    put(holder, db, "unit_grants", {
      unit: unitA1,
      member: memberRow.lead,
      permission: "unit_lead",
    });
    put(holder, db, "unit_grants", { unit: unitA1, group: groupG, permission: "unit_lead" });
    put(holder, db, "unit_grants", {
      unit: unitA1,
      member: memberRow.member,
      permission: "unit_member",
    });
    put(holder, db, "unit_grants", {
      unit: unitA2,
      member: memberRow.lead2,
      permission: "unit_lead",
    });
    const program = put(holder, db, "programs", { title: "計画P" });
    const project1 = put(holder, db, "projects", { title: "案件1", team: groupH });
    const project2 = put(holder, db, "projects", { title: "案件2", program });
    for (const project of [project1, project2]) {
      put(holder, db, "project_grants", {
        project,
        member: memberRow.padmin,
        permission: "p_admin",
      });
    }
    put(holder, db, "project_grants", {
      project: project1,
      member: memberRow.pworker,
      permission: "p_worker",
    });
    return {
      dataRoot,
      variant,
      server: createServerApp({ dataRoot }),
      who,
      memberRow,
      unitA1,
      unitA2,
      project1,
      project2,
      program,
      groupH,
    };
  } finally {
    db.close();
  }
}

type Sent = { status: number; body: Record<string, unknown>; text: string };

async function call(
  rig: Rig,
  method: "GET" | "POST",
  path: string,
  options: { who?: Who; body?: unknown } = {},
): Promise<Sent> {
  const headers: Record<string, string> = { origin: TEST_ORIGIN };
  if (options.who !== undefined) {
    headers.cookie = options.who.cookie;
  }
  if (method === "POST") {
    headers["content-type"] = "application/json";
  }
  const res = await rig.server.request(
    new Request(`http://localhost/api/apps/${APP_ID}${path}`, {
      method,
      headers,
      ...(method === "POST" ? { body: JSON.stringify(options.body ?? {}) } : {}),
    }),
  );
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body, text };
}

async function issueCode(rig: Rig, who: Who = rig.who.lead, unit?: string): Promise<string> {
  const sent = await call(rig, "POST", `/tables/units/records/${unit ?? rig.unitA1}/invite-code`, {
    who,
  });
  expect(sent.status, sent.text).toBe(200);
  return sent.body.code as string;
}

const invite = (rig: Rig, who: Who, body: Record<string, unknown>, project?: string) =>
  call(rig, "POST", `/tables/projects/records/${project ?? rig.project1}/invitations`, {
    who,
    body,
  });

const inviteByCode = (
  rig: Rig,
  code: string,
  options: { who?: Who; project?: string; permission?: string } = {},
) =>
  invite(
    rig,
    options.who ?? rig.who.padmin,
    { code, permission: options.permission ?? "p_worker" },
    options.project,
  );

const inbox = (rig: Rig, who: Who) => call(rig, "GET", "/invitations", { who });

const respond = (rig: Rig, who: Who, id: string, action: string) =>
  call(rig, "POST", `/invitations/${id}`, { who, body: { action } });

const readProject = async (rig: Rig, who: Who, project?: string) =>
  (await call(rig, "GET", `/tables/projects/records/${project ?? rig.project1}`, { who })).status;

function invitationRows(): Record<string, unknown>[] {
  const db = openDb();
  try {
    const has = db
      .query<{ n: number }, []>(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '_row_invitations'",
      )
      .get();
    if ((has?.n ?? 0) === 0) {
      return [];
    }
    return db
      .query<Record<string, unknown>, []>("SELECT * FROM _row_invitations ORDER BY created_at, id")
      .all();
  } finally {
    db.close();
  }
}

function grantRows(): Record<string, unknown>[] {
  const db = openDb();
  try {
    return db
      .query<Record<string, unknown>, []>(
        'SELECT "project", "member", "unit", "permission" FROM "project_grants" ORDER BY rowid',
      )
      .all();
  } finally {
    db.close();
  }
}

function memberTableRows(): Record<string, unknown>[] {
  const db = openDb();
  try {
    return db.query<Record<string, unknown>, []>('SELECT * FROM "members" ORDER BY rowid').all();
  } finally {
    db.close();
  }
}

function onlyInvitationId(): string {
  const rows = invitationRows();
  expect(rows).toHaveLength(1);
  return rows[0]?.id as string;
}

/** 発行の応答から期限の時刻を外す(同じ本文かを比べる)。 */
function shape(sent: Sent): unknown {
  const invitation = (sent.body.invitation ?? {}) as Record<string, unknown>;
  return {
    status: sent.status,
    keys: Object.keys(sent.body),
    inner: Object.keys(invitation),
    permission: invitation.permission,
    expiresIsString: typeof invitation.expires_at === "string",
  };
}

function messageOf(sent: Sent): string | undefined {
  const errors = sent.body.errors as { message?: string }[] | undefined;
  return errors?.[0]?.message;
}

function inboxItems(sent: Sent): Record<string, unknown>[] {
  return (sent.body.invitations ?? []) as Record<string, unknown>[];
}

function beginApplyWindow(): () => void {
  const marker = join(dirname(appDbPath(dataRoot, APP_ID)), ".st-applying.json");
  writeFileSync(marker, JSON.stringify({ started_at: new Date().toISOString(), diff_id: "d" }));
  return () => rmSync(marker, { force: true });
}

const NAME_KEYS = [
  "id",
  "representative",
  "inviter_name",
  "permission_name",
  "table_name",
  "expires_at",
  "changes_group",
];
const CODE_KEYS = [...NAME_KEYS, "principal_label"];

// =====================================================================================

describe("(I) 発行", () => {
  test("(I-1) コードで出すと 202 と名前の招待と同じ形の本文。内部表には row:<表>:<行ID> の鍵と空のログイン名・利用者 ID", async () => {
    const rig = await makeRig();
    const code = await issueCode(rig);
    const sent = await inviteByCode(rig, code);
    expect(sent.status, sent.text).toBe(202);
    expect(shape(sent)).toEqual({
      status: 202,
      keys: ["invitation"],
      inner: ["permission", "expires_at"],
      permission: "p_worker",
      expiresIsString: true,
    });
    const rows = invitationRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      table_id: "projects",
      record_id: rig.project1,
      invitee_login: "",
      invitee_user_id: "",
      invitee_key: `row:units:${rig.unitA1}`,
      permission: "p_worker",
      inviter_id: rig.who.padmin.userId,
    });
  });

  test("(I-2) 存在しないコード・再発行で無効になった旧コードは、同じ 202 と同じ本文で保存しない", async () => {
    const rig = await makeRig();
    const good = await inviteByCode(rig, await issueCode(rig));
    sqlNow("DELETE FROM _row_invitations");
    const old = await issueCode(rig);
    await issueCode(rig); // 再発行で旧コードは無効
    for (const code of ["ZZZZZZZZ", old, "x"]) {
      const sent = await inviteByCode(rig, code);
      expect(shape(sent)).toEqual(shape(good));
    }
    expect(invitationRows()).toEqual([]);
  });

  test("(I-3) 招待者が宛先の行に via を持つなら、同じ 202 と同じ本文で保存しない(自分への付与の禁止の延長)", async () => {
    const rig = await makeRig();
    const code = await issueCode(rig);
    const good = await inviteByCode(rig, code);
    sqlNow("DELETE FROM _row_invitations");
    putNow(rig, "unit_grants", {
      unit: rig.unitA1,
      member: rig.memberRow.padmin,
      permission: "unit_member",
    });
    const sent = await inviteByCode(rig, code);
    expect(shape(sent)).toEqual(shape(good));
    expect(invitationRows()).toEqual([]);
    // 運営も同じ(運営が via を持てば保存しない)。
    putNow(rig, "unit_grants", {
      unit: rig.unitA1,
      member: rig.memberRow.boss,
      permission: "unit_member",
    });
    expect(shape(await inviteByCode(rig, code, { who: rig.who.boss }))).toEqual(shape(good));
    expect(invitationRows()).toEqual([]);
    // via を持たない宛先(部隊 A2)へは保存する。
    await inviteByCode(rig, await issueCode(rig, rig.who.lead2, rig.unitA2));
    expect(invitationRows()).toHaveLength(1);
  });

  test("(I-4) grantable の外の権限は今日どおり 400。by を持たない人は本文の検査より先に存在しない行と同じ 404", async () => {
    const rig = await makeRig();
    const code = await issueCode(rig);
    const bad = await inviteByCode(rig, code, { permission: "p_admin" });
    expect(bad.status).toBe(400);
    expect((bad.body.errors as { allowed_values?: unknown }[])[0]?.allowed_values).toEqual([
      "p_worker",
    ]);
    const missing = await invite(rig, rig.who.padmin, { code });
    expect(missing.status).toBe(400);
    expect((missing.body.errors as { path?: string }[])[0]?.path).toBe("/permission");
    for (const who of [rig.who.pworker, rig.who.lead, rig.who.member]) {
      const sent = await inviteByCode(rig, code, { who, permission: "p_admin" });
      expect(sent.status).toBe(404);
      expect(sent.text).not.toContain("p_worker");
    }
    expect(invitationRows()).toEqual([]);
  });

  test("(I-5) code が文字列でない・空・login と一緒なら 400。何も保存しない", async () => {
    const rig = await makeRig();
    const code = await issueCode(rig);
    for (const body of [
      { code: 12345678, permission: "p_worker" },
      { code: "", permission: "p_worker" },
      { code: null, permission: "p_worker" },
      { code, login: "lead", permission: "p_worker" },
    ]) {
      const sent = await invite(rig, rig.who.padmin, body);
      expect(sent.status, JSON.stringify(body)).toBe(400);
      expect((sent.body.errors as { path?: string }[])[0]?.path).toBe("/code");
    }
    expect(invitationRows()).toEqual([]);
  });

  test("(I-6) 同じ R・同じ S への再発行は1行の上書き(招待の ID は替わらない)。別の R なら別の行", async () => {
    const rig = await makeRig();
    const code = await issueCode(rig);
    await inviteByCode(rig, code);
    const first = invitationRows();
    await inviteByCode(rig, code, { who: rig.who.boss });
    const second = invitationRows();
    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe(first[0]?.id);
    expect(second[0]?.inviter_id).toBe(rig.who.boss.userId);
    await inviteByCode(rig, code, { project: rig.project2 });
    expect(invitationRows()).toHaveLength(2);
  });

  test("(I-7) 陰性対照: principal_row の無いアプリでは code を見ない(今日と同じ 400・同じ 202 と同じ内部表の行)", async () => {
    const rig = await makeRig({ principalRow: false });
    const onlyCode = await invite(rig, rig.who.padmin, {
      code: "ABCDEFGH",
      permission: "p_worker",
    });
    expect(onlyCode.status).toBe(400);
    expect(messageOf(onlyCode)).toBe(MSG_LOGIN);
    expect((onlyCode.body.errors as { path?: string }[])[0]?.path).toBe("/login");
    const withCode = await invite(rig, rig.who.padmin, {
      login: "lead",
      code: "ABCDEFGH",
      permission: "p_worker",
    });
    expect(withCode.status).toBe(202);
    const a = invitationRows();
    sqlNow("DELETE FROM _row_invitations");
    const plain = await invite(rig, rig.who.padmin, { login: "lead", permission: "p_worker" });
    expect(shape(plain)).toEqual(shape(withCode));
    const b = invitationRows();
    const strip = (rows: Record<string, unknown>[]) =>
      rows.map(({ id, created_at, expires_at, ...rest }) => rest);
    expect(strip(a)).toEqual(strip(b));
    expect(a[0]?.invitee_key).toBe(`user:${rig.who.lead.userId}`);
  });
});

describe("(M) 受け取り(自分宛ての一覧)", () => {
  test("(M-1) 宛先の部隊の管理者(直接・グループ経由)に届き、8つ目の値(部隊の代表項目)が付く", async () => {
    const rig = await makeRig();
    await inviteByCode(rig, await issueCode(rig));
    const id = onlyInvitationId();
    const expires = invitationRows()[0]?.expires_at;
    for (const who of [rig.who.lead, rig.who.glead]) {
      const sent = await inbox(rig, who);
      expect(sent.status).toBe(200);
      expect(Object.keys(sent.body)).toEqual(["invitations"]);
      const items = inboxItems(sent);
      expect(items).toHaveLength(1);
      expect(Object.keys(items[0] as object)).toEqual(CODE_KEYS);
      expect(items[0]).toEqual({
        id,
        representative: "案件1",
        inviter_name: "padmin",
        permission_name: "担当",
        table_name: "案件",
        expires_at: expires,
        changes_group: false,
        principal_label: "部隊A1",
      });
    }
  });

  test("(M-2) 部隊経由の専門家・親の管理者・招待者・運営・別の部隊の管理者・無関係の人には届かない", async () => {
    const rig = await makeRig();
    await inviteByCode(rig, await issueCode(rig));
    for (const name of ["member", "netadmin", "padmin", "boss", "lead2", "outsider"] as const) {
      const sent = await inbox(rig, rig.who[name]);
      expect(sent.status).toBe(200);
      expect(inboxItems(sent), name).toEqual([]);
    }
  });

  test("(M-3) 名前の招待にはキーを出さない(7つのまま)。同じ人の一覧にコードの招待と並ぶ", async () => {
    const rig = await makeRig();
    await inviteByCode(rig, await issueCode(rig));
    const named = await invite(
      rig,
      rig.who.padmin,
      { login: "lead", permission: "p_worker" },
      rig.project2,
    );
    expect(named.status).toBe(202);
    const rows = invitationRows();
    const items = inboxItems(await inbox(rig, rig.who.lead));
    expect(items.map((item) => item.id)).toEqual(rows.map((row) => row.id));
    const byId = new Map(items.map((item) => [item.id, item]));
    const nameRow = rows.find((row) => row.invitee_key !== `row:units:${rig.unitA1}`);
    const codeRow = rows.find((row) => row.invitee_key === `row:units:${rig.unitA1}`);
    expect(Object.keys(byId.get(nameRow?.id) as object)).toEqual(NAME_KEYS);
    expect(Object.keys(byId.get(codeRow?.id) as object)).toEqual(CODE_KEYS);
  });

  test("(M-4) 陰性対照: 名前の招待だけの応答は、着手前と1バイトも同じ(principal_row の無いアプリでも、あるアプリでも)", async () => {
    for (const principalRow of [false, true]) {
      const rig = await makeRig({ principalRow });
      await invite(rig, rig.who.padmin, { login: "lead", permission: "p_worker" });
      const row = invitationRows()[0] as Record<string, unknown>;
      const sent = await inbox(rig, rig.who.lead);
      const expected = JSON.stringify({
        invitations: [
          {
            id: row.id,
            representative: "案件1",
            inviter_name: "padmin",
            permission_name: "担当",
            table_name: "案件",
            expires_at: row.expires_at,
            changes_group: false,
          },
        ],
      });
      expect(sent.text).toBe(expected);
      await rm(dataRoot, { recursive: true, force: true });
      dataRoot = "";
    }
  });

  test("(M-6) 【独立点検の処置】principal_row の無いアプリでは、自分宛ての一覧でコードの招待を探す読みを出さない(あるアプリでは出す)", async () => {
    for (const principalRow of [false, true]) {
      const rig = await makeRig({ principalRow });
      await invite(rig, rig.who.padmin, { login: "lead", permission: "p_worker" });
      const seen: string[] = [];
      const spy = spyOn(Database.prototype, "query");
      spy.mockImplementation(function (this: Database, sql: string) {
        seen.push(sql);
        return originalQuery.call(this, sql);
      } as never);
      let sent: Awaited<ReturnType<typeof inbox>>;
      try {
        sent = await inbox(rig, rig.who.lead);
      } finally {
        spy.mockRestore();
      }
      expect(sent.status).toBe(200);
      const codeReads = seen.filter((sql) => sql.includes("substr(invitee_key"));
      expect(codeReads).toHaveLength(principalRow ? 1 : 0);
      await rm(dataRoot, { recursive: true, force: true });
      dataRoot = "";
    }
  });

  test("(M-5) target_roles は効かない(役割の合わない部隊の管理者にも届く)。部隊・案件の行が消えた招待は出ない", async () => {
    const rig = await makeRig({ extras: true });
    await inviteByCode(rig, await issueCode(rig));
    await inviteByCode(rig, await issueCode(rig, rig.who.lead2, rig.unitA2), {
      project: rig.project2,
    });
    expect(inboxItems(await inbox(rig, rig.who.lead))).toHaveLength(1);
    expect(inboxItems(await inbox(rig, rig.who.lead2))).toHaveLength(1);
    sqlNow('DELETE FROM "units" WHERE _id = ?', rig.unitA1);
    sqlNow('DELETE FROM "projects" WHERE _id = ?', rig.project2);
    expect(inboxItems(await inbox(rig, rig.who.lead))).toEqual([]);
    expect(inboxItems(await inbox(rig, rig.who.lead2))).toEqual([]);
    expect(invitationRows()).toHaveLength(2);
  });
});

describe("(A) 承諾", () => {
  test("(A-1) 部隊の管理者が承諾すると、相手の列だけの付与が1行でき、招待が消え、部隊経由の専門家が案件を読める", async () => {
    const rig = await makeRig();
    await inviteByCode(rig, await issueCode(rig));
    const id = onlyInvitationId();
    expect(await readProject(rig, rig.who.member)).toBe(404);
    const before = grantRows();
    const sent = await respond(rig, rig.who.lead, id, "accept");
    expect(sent.status, sent.text).toBe(200);
    expect(sent.body).toEqual({
      status: "accepted",
      table_id: "projects",
      record_id: rig.project1,
    });
    expect(grantRows()).toEqual([
      ...before,
      { project: rig.project1, member: null, unit: rig.unitA1, permission: "p_worker" },
    ]);
    expect(invitationRows()).toEqual([]);
    expect(await readProject(rig, rig.who.member)).toBe(200);
    // 管理には効かない: 部隊経由の専門家は案件の招待を出せない(by を持たない)。
    const tried = await invite(rig, rig.who.member, { login: "outsider", permission: "p_worker" });
    expect(tried.status).toBe(404);
  });

  test("(A-2) グループ経由の部隊の管理者も承諾できる", async () => {
    const rig = await makeRig();
    await inviteByCode(rig, await issueCode(rig));
    const sent = await respond(rig, rig.who.glead, onlyInvitationId(), "accept");
    expect(sent.status, sent.text).toBe(200);
    expect(await readProject(rig, rig.who.member)).toBe(200);
  });

  test("(A-3) 部隊経由の専門家・親の管理者・招待者・運営・別の部隊の管理者は、承諾も辞退も存在しない招待と同じ 404", async () => {
    const rig = await makeRig();
    await inviteByCode(rig, await issueCode(rig));
    const id = onlyInvitationId();
    const missing = await respond(rig, rig.who.lead, "no-such-invitation", "accept");
    expect(missing.status).toBe(404);
    for (const name of ["member", "netadmin", "padmin", "boss", "lead2", "outsider"] as const) {
      for (const action of ["accept", "decline"]) {
        const sent = await respond(rig, rig.who[name], id, action);
        expect(sent.status, `${name} ${action}`).toBe(404);
        expect(sent.text).toBe(missing.text);
      }
    }
    expect(invitationRows()).toHaveLength(1);
    expect(grantRows().filter((row) => row.unit !== null)).toEqual([]);
  });

  test("(A-4) 承諾の時に招待者が宛先の行に via を持つなら断る。招待は残り、付与はできない", async () => {
    const rig = await makeRig();
    await inviteByCode(rig, await issueCode(rig));
    const id = onlyInvitationId();
    putNow(rig, "unit_grants", {
      unit: rig.unitA1,
      member: rig.memberRow.padmin,
      permission: "unit_member",
    });
    const sent = await respond(rig, rig.who.lead, id, "accept");
    expect(sent.status, sent.text).toBe(403);
    expect(messageOf(sent)).toBe(MSG_PRINCIPAL_SELF);
    expect(invitationRows()).toHaveLength(1);
    expect(grantRows().filter((row) => row.unit !== null)).toEqual([]);
  });

  test("(A-5) 案件が親から引き継ぐなら、部隊に via を持つ人全員が親を読めること。読めなければ断り、読めれば承諾できる", async () => {
    const rig = await makeRig({ parent: true });
    await inviteByCode(rig, await issueCode(rig), { project: rig.project2 });
    const id = onlyInvitationId();
    const denied = await respond(rig, rig.who.lead, id, "accept");
    expect(denied.status, denied.text).toBe(403);
    expect(messageOf(denied)).toBe(MSG_PRINCIPAL_PARENT);
    expect(invitationRows()).toHaveLength(1);
    putNow(rig, "program_grants", {
      program: rig.program,
      member: rig.memberRow.member,
      permission: "prog_reader",
    });
    const ok = await respond(rig, rig.who.lead, id, "accept");
    expect(ok.status, ok.text).toBe(200);
    expect(await readProject(rig, rig.who.member, rig.project2)).toBe(200);
  });

  test("(A-6) 案件が親を指さない(最上位の行)なら、親の検査は素通し", async () => {
    const rig = await makeRig({ parent: true });
    await inviteByCode(rig, await issueCode(rig));
    const ok = await respond(rig, rig.who.lead, onlyInvitationId(), "accept");
    expect(ok.status, ok.text).toBe(200);
  });

  test("(A-7) 付与表の unique に当たったら 422 と文言。招待も付与も変わらない", async () => {
    const rig = await makeRig({ unique: true });
    // 部隊 A1 は案件2 に既に付いている(DB に直に置く)。
    putNow(rig, "project_grants", {
      project: rig.project2,
      unit: rig.unitA1,
      permission: "p_worker",
    });
    await inviteByCode(rig, await issueCode(rig));
    const id = onlyInvitationId();
    const before = grantRows();
    const sent = await respond(rig, rig.who.lead, id, "accept");
    expect(sent.status, sent.text).toBe(422);
    expect(sent.body.kind).toBe("app_rejected");
    expect(sent.text).toContain(UNIQUE_MESSAGE);
    expect(grantRows()).toEqual(before);
    expect(invitationRows()).toHaveLength(1);
  });

  test("(A-8) 期限切れは 404。案件の行が消えたら理由を付けて断る。部隊の行が消えたら 404。招待者が by を失ったら断る", async () => {
    const rig = await makeRig();
    const code = await issueCode(rig);
    await inviteByCode(rig, code);
    const id = onlyInvitationId();
    sqlNow(
      "UPDATE _row_invitations SET expires_at = ? WHERE id = ?",
      "2000-01-01T00:00:00.000Z",
      id,
    );
    expect((await respond(rig, rig.who.lead, id, "accept")).status).toBe(404);
    expect(invitationRows()).toEqual([]);

    await inviteByCode(rig, code);
    const id2 = onlyInvitationId();
    sqlNow(
      'DELETE FROM "project_grants" WHERE "member" = ? AND "permission" = ?',
      rig.memberRow.padmin,
      "p_admin",
    );
    const lost = await respond(rig, rig.who.lead, id2, "accept");
    expect(lost.status, lost.text).toBe(403);
    expect(messageOf(lost)).toBe(MSG_INVITER_DENIED);

    sqlNow('DELETE FROM "projects" WHERE _id = ?', rig.project1);
    const gone = await respond(rig, rig.who.lead, id2, "accept");
    expect(gone.status, gone.text).toBe(403);
    expect(messageOf(gone)).toBe(MSG_ROW_GONE);

    sqlNow('DELETE FROM "units" WHERE _id = ?', rig.unitA1);
    expect((await respond(rig, rig.who.lead, id2, "accept")).status).toBe(404);
    expect(grantRows().filter((row) => row.unit !== null)).toEqual([]);
  });

  test("(A-9) 再発行の前に古いコードで出した未承諾の招待は、再発行の後も承諾できる", async () => {
    const rig = await makeRig();
    await inviteByCode(rig, await issueCode(rig));
    await issueCode(rig);
    const sent = await respond(rig, rig.who.lead, onlyInvitationId(), "accept");
    expect(sent.status, sent.text).toBe(200);
  });

  test("(A-10) target_roles と group_from は効かない(役割の合わない管理者も承諾でき、名簿のグループ欄は変わらない)", async () => {
    const rig = await makeRig({ extras: true });
    await inviteByCode(rig, await issueCode(rig));
    const members = memberTableRows();
    const sent = await respond(rig, rig.who.lead, onlyInvitationId(), "accept");
    expect(sent.status, sent.text).toBe(200);
    expect(memberTableRows()).toEqual(members);
    expect(grantRows().filter((row) => row.unit !== null)).toHaveLength(1);
  });

  test("(A-11) 承諾は器の中で見直す: 器を開く直前に招待者が by を失ったら・承諾する人が管理者でなくなったら、付与を作らずに断る", async () => {
    for (const lose of ["inviter", "invitee"] as const) {
      const rig = await makeRig();
      await inviteByCode(rig, await issueCode(rig));
      const id = onlyInvitationId();
      const original = Database.prototype.transaction;
      const spy = spyOn(Database.prototype, "transaction").mockImplementation(function (
        this: Database,
        fn: (...args: unknown[]) => unknown,
      ) {
        if (lose === "inviter") {
          this.query('DELETE FROM "project_grants" WHERE "member" = ?').run(rig.memberRow.padmin);
        } else {
          this.query('DELETE FROM "unit_grants" WHERE "member" = ?').run(rig.memberRow.lead);
        }
        return original.call(this, fn as never) as never;
      } as never);
      let sent: Sent;
      try {
        sent = await respond(rig, rig.who.lead, id, "accept");
      } finally {
        spy.mockRestore();
      }
      expect(sent.status, `${lose} ${sent.text}`).toBe(lose === "inviter" ? 403 : 404);
      expect(grantRows().filter((row) => row.unit !== null)).toEqual([]);
      expect(invitationRows()).toHaveLength(1);
      await rm(dataRoot, { recursive: true, force: true });
      dataRoot = "";
    }
  });
});

describe("(D) 辞退・取消", () => {
  test("(D-1) 部隊の管理者が辞退すると招待が消えるだけで、付与はできない", async () => {
    const rig = await makeRig();
    await inviteByCode(rig, await issueCode(rig));
    const sent = await respond(rig, rig.who.glead, onlyInvitationId(), "decline");
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ status: "declined" });
    expect(invitationRows()).toEqual([]);
    expect(grantRows().filter((row) => row.unit !== null)).toEqual([]);
  });

  test("(D-2) 取消は案件の側(一覧を見られる人)。部隊の管理者は取り消せない(404)", async () => {
    const rig = await makeRig();
    await inviteByCode(rig, await issueCode(rig));
    const id = onlyInvitationId();
    expect((await respond(rig, rig.who.lead, id, "revoke")).status).toBe(404);
    const pending = await call(rig, "GET", `/tables/projects/records/${rig.project1}/invitations`, {
      who: rig.who.padmin,
    });
    expect(pending.status).toBe(200);
    expect((pending.body.pending as unknown[]).length).toBe(1);
    const sent = await respond(rig, rig.who.padmin, id, "revoke");
    expect(sent.status).toBe(200);
    expect(invitationRows()).toEqual([]);
  });
});

describe("(W) 適用の最中", () => {
  test("(W-1) コードの発行・自分宛ての一覧・承諾・辞退は 409 で、内部表は変わらない", async () => {
    const rig = await makeRig();
    const code = await issueCode(rig);
    await inviteByCode(rig, code);
    const id = onlyInvitationId();
    const before = invitationRows();
    const end = beginApplyWindow();
    try {
      const sent = [
        await inviteByCode(rig, code, { project: rig.project2 }),
        await inbox(rig, rig.who.lead),
        await respond(rig, rig.who.lead, id, "accept"),
        await respond(rig, rig.who.lead, id, "decline"),
      ];
      expect(sent.map((item) => item.status)).toEqual([409, 409, 409, 409]);
      expect(invitationRows()).toEqual(before);
    } finally {
      end();
    }
    expect((await respond(rig, rig.who.lead, id, "accept")).status).toBe(200);
  });
});

// =====================================================================================
// 【2026-10-01 追記。決定 `D-V23-176`】既に同じ R と同じ S を指す付与の行が在るとき

describe("(R) 既に関係のある行へのコードの招待", () => {
  test("(R-1) 同じ R と同じ S の付与の行が在れば、発行は同じ 202 と同じ本文で保存しない。別の R・別の S なら保存する", async () => {
    const rig = await makeRig();
    const code = await issueCode(rig);
    const fresh = await inviteByCode(rig, code);
    await respond(rig, rig.who.lead, onlyInvitationId(), "accept");
    expect(invitationRows()).toEqual([]);
    const grantsBefore = grantRows();
    const again = await inviteByCode(rig, code);
    expect(again.status, again.text).toBe(202);
    expect(shape(again)).toEqual(shape(fresh));
    expect(invitationRows()).toEqual([]);
    expect(grantRows()).toEqual(grantsBefore);
    // 陰性対照: 別の R(案件2)へは保存する。 別の S(部隊A2)へも保存する。
    await inviteByCode(rig, code, { project: rig.project2 });
    expect(invitationRows()).toHaveLength(1);
    await inviteByCode(rig, await issueCode(rig, rig.who.lead2, rig.unitA2));
    expect(invitationRows()).toHaveLength(2);
  });

  test("(R-2) 招待の後に同じ R と同じ S の付与の行ができていたら、承諾は 403 と理由で断る。招待は残り、付与の行は増えない", async () => {
    const rig = await makeRig();
    await inviteByCode(rig, await issueCode(rig));
    const id = onlyInvitationId();
    putNow(rig, "project_grants", {
      project: rig.project1,
      unit: rig.unitA1,
      permission: "p_worker",
    });
    const before = grantRows();
    const sent = await respond(rig, rig.who.lead, id, "accept");
    expect(sent.status, sent.text).toBe(403);
    expect(messageOf(sent)).toBe(MSG_PRINCIPAL_GRANTED);
    expect(invitationRows()).toHaveLength(1);
    expect(grantRows()).toEqual(before);
  });

  test("(R-3) 承諾は器の中で見直す: 器を開く直前に同じ付与の行ができたら、付与を作らずに断る", async () => {
    const rig = await makeRig();
    await inviteByCode(rig, await issueCode(rig));
    const id = onlyInvitationId();
    const original = Database.prototype.transaction;
    let inserted = false;
    const spy = spyOn(Database.prototype, "transaction").mockImplementation(function (
      this: Database,
      fn: (...args: unknown[]) => unknown,
    ) {
      if (!inserted) {
        inserted = true;
        put(rig, this, "project_grants", {
          project: rig.project1,
          unit: rig.unitA1,
          permission: "p_worker",
        });
      }
      return original.call(this, fn as never) as never;
    } as never);
    let sent: Sent;
    try {
      sent = await respond(rig, rig.who.lead, id, "accept");
    } finally {
      spy.mockRestore();
    }
    expect(sent.status, sent.text).toBe(403);
    expect(messageOf(sent)).toBe(MSG_PRINCIPAL_GRANTED);
    expect(grantRows().filter((row) => row.unit !== null)).toHaveLength(1);
    expect(invitationRows()).toHaveLength(1);
  });
});

// =====================================================================================
// 【2026-10-01 追記。`V23-M6-T06b`(画面)】招待した行の側の「承諾を待っている招待」の一覧

describe("(P) 招待した行の側の一覧", () => {
  test("(P-1) コードの招待の1件にだけ principal_label(宛先の行の代表項目)を付ける。名前の招待はキーを出さない(5つのまま)", async () => {
    const rig = await makeRig();
    await invite(rig, rig.who.padmin, { login: "outsider", permission: "p_worker" });
    await inviteByCode(rig, await issueCode(rig));
    const sent = await call(rig, "GET", `/tables/projects/records/${rig.project1}/invitations`, {
      who: rig.who.padmin,
    });
    expect(sent.status, sent.text).toBe(200);
    const pending = sent.body.pending as Record<string, unknown>[];
    expect(pending).toHaveLength(2);
    const byName = pending.find((row) => row.login === "outsider");
    const byCode = pending.find((row) => row.login === "");
    expect(Object.keys(byName ?? {})).toEqual([
      "id",
      "login",
      "permission",
      "inviter_name",
      "expires_at",
    ]);
    expect(Object.keys(byCode ?? {})).toEqual([
      "id",
      "login",
      "permission",
      "inviter_name",
      "expires_at",
      "principal_label",
    ]);
    expect(byCode?.principal_label).toBe("部隊A1");
    // 部隊のほかの項目・行の ID は出さない。
    expect(sent.text).not.toContain(rig.unitA1);
  });

  test("(P-2) 宛先の行が消えたら principal_label は null", async () => {
    const rig = await makeRig();
    await inviteByCode(rig, await issueCode(rig));
    sqlNow('DELETE FROM "units" WHERE "_id" = ?', rig.unitA1);
    const sent = await call(rig, "GET", `/tables/projects/records/${rig.project1}/invitations`, {
      who: rig.who.padmin,
    });
    const pending = sent.body.pending as Record<string, unknown>[];
    expect(pending).toHaveLength(1);
    expect(pending[0]?.principal_label).toBeNull();
  });
});

// =====================================================================================
// **【`V23-M9-T06`】コードの照合の前に、前後の空白を落とし小文字を大文字に直す**(決定 `D-V23-239`。`ADR-0549` §1-6)。
// 画面は同じ HTTP の口を通る(本文 `{code, permission}`)。 直しても合わないコードは今日どおり同じ 202 と同じ本文で保存しない。
// =====================================================================================

describe("V23-M9-T06 コードの打ち方(D-V23-239)", () => {
  test("D-V23-239: 小文字・前後の空白つきで打ったコードも、大文字に直して照合し、宛先の行への招待を保存する", async () => {
    for (const typed of [
      (code: string) => code.toLowerCase(),
      (code: string) => `  ${code}\t`,
      (code: string) => ` ${code.slice(0, 4).toLowerCase()}${code.slice(4)} \n`,
    ]) {
      const rig = await makeRig();
      const code = await issueCode(rig);
      expect(code).toBe(code.trim().toUpperCase());
      const sent = await inviteByCode(rig, typed(code));
      expect(sent.status, sent.text).toBe(202);
      const rows = invitationRows();
      expect(rows, JSON.stringify(typed(code))).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        table_id: "projects",
        record_id: rig.project1,
        invitee_key: `row:units:${rig.unitA1}`,
        permission: "p_worker",
      });
    }
  });

  test("D-V23-239: 直しても合わないコード(空白だけ・存在しない・再発行で無効の旧コード)は、今日どおり同じ 202 と同じ本文で保存しない", async () => {
    const rig = await makeRig();
    const good = await inviteByCode(rig, await issueCode(rig));
    sqlNow("DELETE FROM _row_invitations");
    const old = await issueCode(rig);
    await issueCode(rig); // 再発行で旧コードは無効
    for (const code of ["   ", " zzzzzzzz ", ` ${old.toLowerCase()} `]) {
      const sent = await inviteByCode(rig, code);
      expect(shape(sent), JSON.stringify(code)).toEqual(shape(good));
    }
    expect(invitationRows()).toEqual([]);
  });
});
