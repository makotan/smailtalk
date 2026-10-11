/**
 * **行の招待用コード —— 見る口(GET)と発行・再発行の口(POST)**
 * (`V23-M6-T05`。門A = `ADR-0502`(`SC-G21`)を補う `ADR-0538` §Decision 1-5。
 * 決定 `D-V23-153`・`D-V23-167`・`D-V23-169`。計画 §25-6 中9。授権 `ADR-0539`)。
 *
 * ## この検査が測るもの / 測らないもの(**先に書く**)
 *
 * **題材**: 部隊(S。`units`。親 `networks` から引き継ぐ)と案件(R。`projects`)。 案件の付与表の `unit` 列が
 * 部隊の行を指す(`principal_row`)。 部隊 A1 の管理者は `lead`(直接 `unit_lead`)と `glead`(グループ経由の
 * `unit_lead`)。 `member` は部隊 A1 の `unit_member`(部隊経由で案件を読める専門家)。 `padmin` は案件の管理者。
 * `netadmin` は親(連合)に `unit_lead` と同じ名前の権限を持つ(引き継ぎで部隊を読み書きできる)。 `boss` は運営。
 *
 * **測るもの**:
 * 1. 管理者(直接・グループ経由)と運営は、コードを見て(無ければ `null`)、発行・再発行できる。 形式は32字表の8文字。
 * 2. 再発行で置き換わり、旧コードでは行を引けない。 旧コードの頃に在った付与の行は消えない。
 * 3. 管理者でない人(部隊の `unit_member` = 部隊経由の専門家・案件の管理者・親の管理者)は、存在しない行と同じ 404。
 *    未ログインは 401、他所の Origin の POST は 403。 どれもコードの表を作らず、コードを変えない。
 * 4. GET は書かない(表を作らない・コードを変えない)。
 * 5. 指されていない表(案件)・存在しない行は 404 で、表を作らない。 適用の最中は 409。
 * 6. 陰性対照: `principal_row` の無いアプリでは、2本の口は登録の無いパスと同じ 404 で、`app.sqlite` に触れない。
 *
 * **測らないもの(誇張しない)**: コードの招待(`T06`)。 画面(`T06b`)。 書き出し版(申告。`T09`)。
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { INVITATION_CODE_ALPHABET, INVITATION_CODE_LENGTH } from "../auth/store.ts";
import {
  appDbPath,
  applyManifest,
  createApp,
  createRecord,
  KernelMetaStore,
  type Manifest,
} from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { findRowByInviteCode } from "./row-invite-codes.ts";
import { seedSession, TEST_ORIGIN } from "./test-helpers.ts";

const APP_ID = "pr-codes";
const ALL = ["read", "write", "delete"];
const TABLES = [
  "members",
  "groups",
  "networks",
  "network_grants",
  "units",
  "unit_grants",
  "projects",
  "project_grants",
];
// 登録用の招待コードと同じ32字表の8文字(字表は登録用の招待の定数をそのまま読む)。
const CODE_PATTERN = new RegExp(`^[${INVITATION_CODE_ALPHABET}]{${INVITATION_CODE_LENGTH}}$`);

const ref = (id: string, table: string) => ({
  id,
  name: id,
  type: "reference",
  reference_table: table,
});

function manifest(principalRow = true): Manifest {
  const rules = (can: string[]) => TABLES.map((table) => ({ target: "table", table, can }));
  return {
    app: {
      id: APP_ID,
      name: "行の招待用コード",
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
            members: { table: "members", account: "account" },
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
            members: { table: "members", account: "account", group: "grp" },
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
          id: "projects",
          name: "案件",
          representative_field: "title",
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
              ...(principalRow
                ? { principal_row: { column: "unit", table: "units", via: ["unit_member"] } }
                : {}),
            },
            members: { table: "members", account: "account" },
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
  who: Record<"boss" | "lead" | "glead" | "member" | "padmin" | "netadmin", Who>;
  unitA1: string;
  unitA2: string;
  project: string;
  viaGrant: string;
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

function put(db: Database, table: string, values: Record<string, unknown>): string {
  const created = createRecord(db, manifest(), table, values);
  if (!created.ok) {
    throw new Error(`${table} に行を置けない: ${JSON.stringify(created.errors)}`);
  }
  return created.value._id;
}

async function makeRig(principalRow = true): Promise<Rig> {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-pr-codes-"));
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, "行の招待用コード", { app_id: APP_ID });
  } finally {
    meta.close();
  }
  const applied = applyManifest(dataRoot, APP_ID, manifest(principalRow));
  if (!applied.valid) {
    throw new Error(JSON.stringify(applied.errors));
  }
  const seed = (username: string, role: string): Who => {
    const s = seedSession(dataRoot, APP_ID, { role, username });
    return { cookie: s.cookie, userId: s.userId, username };
  };
  const who = {
    boss: seed("boss", "owner"),
    lead: seed("lead", "staff"),
    glead: seed("glead", "staff"),
    member: seed("member", "staff"),
    padmin: seed("padmin", "staff"),
    netadmin: seed("netadmin", "staff"),
  };
  const db = openDb();
  try {
    const groupG = put(db, "groups", { title: "G" });
    const m = (w: Who, grp?: string) =>
      put(db, "members", { name: w.username, account: w.userId, ...(grp ? { grp } : {}) });
    m(who.boss);
    const mLead = m(who.lead);
    m(who.glead, groupG);
    const mMember = m(who.member);
    const mPadmin = m(who.padmin);
    const mNet = m(who.netadmin);
    const network = put(db, "networks", { title: "連合1" });
    put(db, "network_grants", { network, member: mNet, permission: "unit_lead" });
    const unitA1 = put(db, "units", { title: "部隊A1", network });
    const unitA2 = put(db, "units", { title: "部隊A2", network });
    put(db, "unit_grants", { unit: unitA1, member: mLead, permission: "unit_lead" });
    put(db, "unit_grants", { unit: unitA1, group: groupG, permission: "unit_lead" });
    put(db, "unit_grants", { unit: unitA1, member: mMember, permission: "unit_member" });
    const project = put(db, "projects", { title: "案件1" });
    put(db, "project_grants", { project, member: mPadmin, permission: "p_admin" });
    // 相手の行を指す付与の行は承諾でだけ作れる(`T04`)ので、DB に直に置く。
    const viaGrant = put(db, "project_grants", { project, unit: unitA1, permission: "p_worker" });
    return {
      dataRoot,
      server: createServerApp({ dataRoot }),
      who,
      unitA1,
      unitA2,
      project,
      viaGrant,
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
  options: { who?: Who; origin?: string | null } = {},
): Promise<Sent> {
  const headers: Record<string, string> = {};
  if (options.who !== undefined) {
    headers.cookie = options.who.cookie;
  }
  const origin = options.origin === undefined ? TEST_ORIGIN : options.origin;
  if (origin !== null) {
    headers.origin = origin;
  }
  if (method === "POST") {
    headers["content-type"] = "application/json";
  }
  const res = await rig.server.request(
    new Request(`http://localhost/api/apps/${APP_ID}${path}`, {
      method,
      headers,
      ...(method === "POST" ? { body: "{}" } : {}),
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

const codePath = (table: string, record: string) =>
  `/tables/${table}/records/${record}/invite-code`;

const see = (rig: Rig, who: Who | undefined, record?: string, table = "units") =>
  call(rig, "GET", codePath(table, record ?? rig.unitA1), who === undefined ? {} : { who });
const issue = (rig: Rig, who: Who | undefined, record?: string, table = "units") =>
  call(rig, "POST", codePath(table, record ?? rig.unitA1), who === undefined ? {} : { who });

function tableNames(): string[] {
  const db = openDb();
  try {
    return db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master ORDER BY type, name")
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

function codeRows(): Record<string, unknown>[] {
  const db = openDb();
  try {
    const has = db
      .query<{ n: number }, []>(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '_row_invite_codes'",
      )
      .get();
    if ((has?.n ?? 0) === 0) {
      return [];
    }
    return db
      .query<Record<string, unknown>, []>(
        "SELECT * FROM _row_invite_codes ORDER BY table_id, record_id",
      )
      .all();
  } finally {
    db.close();
  }
}

function lookup(code: string): { table_id: string; record_id: string } | undefined {
  const db = openDb();
  try {
    return findRowByInviteCode(db, code);
  } finally {
    db.close();
  }
}

function appFileState(): unknown {
  const dir = dirname(appDbPath(dataRoot, APP_ID));
  const files = readdirSync(dir)
    .sort()
    .map((name) => {
      const stat = statSync(join(dir, name));
      return [name, stat.mtimeMs, stat.size];
    });
  return {
    dir: statSync(dir).mtimeMs,
    files,
    sqlite: ["app.sqlite", "app.sqlite-wal", "app.sqlite-shm"].map((name) =>
      existsSync(join(dir, name)),
    ),
  };
}

function beginApplyWindow(): () => void {
  const marker = join(dirname(appDbPath(dataRoot, APP_ID)), ".st-applying.json");
  writeFileSync(marker, JSON.stringify({ started_at: new Date().toISOString(), diff_id: "d" }));
  return () => rmSync(marker, { force: true });
}

/** 存在しない行と同じ 404 か(行の ID だけを置き換えて比べる)。 */
async function expectSameAsMissing(rig: Rig, sent: Sent, method: "GET" | "POST", record: string) {
  expect(sent.status).toBe(404);
  const missing = await call(rig, method, codePath("units", "no-such-record"), {
    who: rig.who.boss,
  });
  expect(missing.status).toBe(404);
  expect(sent.text).toBe(missing.text.split("no-such-record").join(record));
}

describe("(C) 見られる人は見て、発行・再発行できる", () => {
  test("(C-1) 直接の管理者: 無ければ null、発行で8文字、見ると同じコード", async () => {
    const rig = await makeRig();
    const before = await see(rig, rig.who.lead);
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ code: null });
    const issued = await issue(rig, rig.who.lead);
    expect(issued.status).toBe(200);
    const code = issued.body.code as string;
    expect(code).toMatch(CODE_PATTERN);
    expect(Object.keys(issued.body)).toEqual(["code"]);
    const after = await see(rig, rig.who.lead);
    expect(after.status).toBe(200);
    expect(after.body).toEqual({ code });
    expect(lookup(code)).toEqual({ table_id: "units", record_id: rig.unitA1 });
  });

  test("(C-2) グループ経由の管理者も見て再発行できる", async () => {
    const rig = await makeRig();
    const first = await issue(rig, rig.who.lead);
    const seen = await see(rig, rig.who.glead);
    expect(seen.status).toBe(200);
    expect(seen.body).toEqual({ code: first.body.code });
    const again = await issue(rig, rig.who.glead);
    expect(again.status).toBe(200);
    expect(again.body.code).toMatch(CODE_PATTERN);
  });

  test("(C-3) 再発行で置き換わり、旧コードでは引けない。旧コードの頃の付与の行は消えない", async () => {
    const rig = await makeRig();
    const first = (await issue(rig, rig.who.lead)).body.code as string;
    const second = (await issue(rig, rig.who.lead)).body.code as string;
    expect(second).toMatch(CODE_PATTERN);
    expect(second).not.toBe(first);
    expect(lookup(first)).toBeUndefined();
    expect(lookup(second)).toEqual({ table_id: "units", record_id: rig.unitA1 });
    expect(codeRows()).toHaveLength(1);
    expect((await see(rig, rig.who.lead)).body).toEqual({ code: second });
    const db = openDb();
    try {
      const kept = db
        .query<{ n: number }, [string]>('SELECT count(*) AS n FROM "project_grants" WHERE _id = ?')
        .get(rig.viaGrant);
      expect(kept?.n).toBe(1);
    } finally {
      db.close();
    }
  });

  test("(C-4) 運営は見て発行できる(行の管理者でなくても)", async () => {
    const rig = await makeRig();
    expect((await see(rig, rig.who.boss, rig.unitA2)).body).toEqual({ code: null });
    const issued = await issue(rig, rig.who.boss, rig.unitA2);
    expect(issued.status).toBe(200);
    expect(issued.body.code).toMatch(CODE_PATTERN);
    expect((await see(rig, rig.who.boss, rig.unitA2)).body).toEqual({ code: issued.body.code });
  });

  test("(C-5) 行ごとに別のコード(他の行の管理者には見えない)", async () => {
    const rig = await makeRig();
    await issue(rig, rig.who.lead);
    await issue(rig, rig.who.boss, rig.unitA2);
    expect(codeRows()).toHaveLength(2);
    await expectSameAsMissing(rig, await see(rig, rig.who.lead, rig.unitA2), "GET", rig.unitA2);
  });
});

describe("(D) 見られない人は断られる", () => {
  test("(D-1) 管理者でない人(部隊経由の専門家・案件の管理者・親の管理者)は存在しない行と同じ 404 で、何も書かない", async () => {
    const rig = await makeRig();
    const names = tableNames();
    // 部隊経由の専門家は案件を読める(`T03`)が、部隊のコードは見られない。
    expect(
      (await call(rig, "GET", `/tables/projects/records/${rig.project}`, { who: rig.who.member }))
        .status,
    ).toBe(200);
    // 親の管理者は引き継ぎで部隊の行を読める(親は辿らないので、コードは見られない)。
    expect(
      (await call(rig, "GET", `/tables/units/records/${rig.unitA1}`, { who: rig.who.netadmin }))
        .status,
    ).toBe(200);
    for (const who of [rig.who.member, rig.who.padmin, rig.who.netadmin]) {
      await expectSameAsMissing(rig, await see(rig, who), "GET", rig.unitA1);
      await expectSameAsMissing(rig, await issue(rig, who), "POST", rig.unitA1);
    }
    expect(tableNames()).toEqual(names);
    expect(codeRows()).toEqual([]);
    // 発行の後でも同じ(コードを返さず、変えない)。
    const code = (await issue(rig, rig.who.lead)).body.code as string;
    for (const who of [rig.who.member, rig.who.padmin, rig.who.netadmin]) {
      const seen = await see(rig, who);
      expect(seen.status).toBe(404);
      expect(seen.text).not.toContain(code);
      expect((await issue(rig, who)).status).toBe(404);
    }
    expect((await see(rig, rig.who.lead)).body).toEqual({ code });
  });

  test("(D-2) 未ログインは 401、他所の Origin の POST は 403。コードは作られず変わらない", async () => {
    const rig = await makeRig();
    expect((await see(rig, undefined)).status).toBe(401);
    expect((await issue(rig, undefined)).status).toBe(401);
    const evil = await call(rig, "POST", codePath("units", rig.unitA1), {
      who: rig.who.lead,
      origin: "http://evil.example",
    });
    expect(evil.status).toBe(403);
    expect(codeRows()).toEqual([]);
    const code = (await issue(rig, rig.who.lead)).body.code as string;
    const evil2 = await call(rig, "POST", codePath("units", rig.unitA1), {
      who: rig.who.lead,
      origin: "http://evil.example",
    });
    expect(evil2.status).toBe(403);
    expect((await see(rig, rig.who.lead)).body).toEqual({ code });
  });
});

describe("(G) GET は書かない・表は要るときだけ", () => {
  test("(G-1) 発行の前の GET は表を作らない。発行の後の GET はコードを変えない", async () => {
    const rig = await makeRig();
    const names = tableNames();
    expect((await see(rig, rig.who.lead)).body).toEqual({ code: null });
    expect((await see(rig, rig.who.boss)).body).toEqual({ code: null });
    expect(tableNames()).toEqual(names);
    expect(names).not.toContain("_row_invite_codes");
    await issue(rig, rig.who.lead);
    const rows = codeRows();
    for (let i = 0; i < 3; i += 1) {
      await see(rig, rig.who.lead);
    }
    expect(codeRows()).toEqual(rows);
  });

  test("(G-2) 指されていない表(案件)と存在しない行は 404 で、表を作らない", async () => {
    const rig = await makeRig();
    const names = tableNames();
    for (const sent of [
      await see(rig, rig.who.boss, rig.project, "projects"),
      await issue(rig, rig.who.boss, rig.project, "projects"),
      await see(rig, rig.who.padmin, rig.project, "projects"),
      await issue(rig, rig.who.padmin, rig.project, "projects"),
      await see(rig, rig.who.boss, "no-such-record"),
      await issue(rig, rig.who.boss, "no-such-record"),
    ]) {
      expect(sent.status).toBe(404);
    }
    expect(tableNames()).toEqual(names);
  });

  test("(G-3) 適用の最中は GET も POST も 409 で、コードは変わらない。窓が閉じれば今日どおり", async () => {
    const rig = await makeRig();
    const code = (await issue(rig, rig.who.lead)).body.code as string;
    const rows = codeRows();
    const end = beginApplyWindow();
    try {
      expect((await see(rig, rig.who.lead)).status).toBe(409);
      expect((await issue(rig, rig.who.lead)).status).toBe(409);
      expect(codeRows()).toEqual(rows);
    } finally {
      end();
    }
    expect((await see(rig, rig.who.lead)).body).toEqual({ code });
  });
});

describe("(N) 陰性対照: principal_row の無いアプリ", () => {
  test("(N-1) 2本の口は登録の無いパスと同じ 404 で、app.sqlite に触れない", async () => {
    const rig = await makeRig(false);
    // 登録の無いパスの 404(本文はメソッドとパスを含むので、パスの末尾だけを置き換えて比べる)。
    const unknownText: Record<string, string> = {};
    for (const method of ["GET", "POST"] as const) {
      const unknown = await call(
        rig,
        method,
        `/tables/units/records/${rig.unitA1}/no-such-endpoint`,
        {
          who: rig.who.boss,
        },
      );
      expect(unknown.status).toBe(404);
      unknownText[method] = unknown.text.split("no-such-endpoint").join("invite-code");
    }
    const names = tableNames();
    await Bun.sleep(20);
    const before = appFileState();
    for (const who of [rig.who.boss, rig.who.lead, undefined]) {
      const seen = await see(rig, who);
      expect(seen.status).toBe(404);
      expect(seen.text).toBe(unknownText.GET as string);
      const issued = await issue(rig, who);
      expect(issued.status).toBe(404);
      expect(issued.text).toBe(unknownText.POST as string);
    }
    expect(appFileState()).toEqual(before);
    expect(tableNames()).toEqual(names);
    expect(names).not.toContain("_row_invite_codes");
  });
});
