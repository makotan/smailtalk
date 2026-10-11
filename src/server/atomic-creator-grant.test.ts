/**
 * **行の作成と、作成者への付与を1つの書込にする**(`V23-M2-T05`。上位:
 * `docs/adr/0498-unique-message-reject-and-atomic-creator-grant.md`、
 * `docs/adr/0517-v23-m2-guard-authorization-and-conditional-rows.md` §Decision 4 の1・§Decision 7、
 * 決定 `D-V23-12`・`D-V23-48`・`D-V23-54`・`D-V23-55`、
 * 計画 `docs/plan/v23/00-v23-plan.md` §17 の例外2・§21-2 の T05・§21-4 の「T05 に足す」)。
 *
 * **見ること**:
 * - 付与表の `member` に `unique: true` と `unique_message` を書いたアプリで、既にどこかの組織に
 *   所属している人が組織を作ると、422 とその文言が返り、**組織の行も付与の行も無い**(FR-6 受け入れ2)。
 * - `unique_message` が無ければ 400 で今日の文面(付与表へ直に書いたときの断りと同じ)。行は無い。
 * - まとめ書き(バッチ)でも同じで、同じ要求の他の行も全部戻る。
 * - 付与表の `on_create` の島が `reject` したら 422 とその文言。組織の行も無い。
 * - 付与表の `on_create` が失敗したときの履歴は、巻き戻しの後も残る(`D-V23-55`)。
 * - 付与の書込が検査の外の例外で落ちたら、行ごと巻き戻して 500 と新しい文(逐語で固定)。
 * - **陽性対照(全アプリの例外2)**: 成功したときの応答・行・監査の行は今日と同じ。
 * - **陰性対照**: `access_control` を宣言しないアプリの単件 `POST` とバッチの応答・行・監査の行は
 *   今日と同じ。
 *
 * **今日(実装前)の姿**: 付与は行を書いた後の別の書込であり、付与が落ちると行が残って 500
 * (文「行は作成しましたが…」)が返る(`V23-M0-T01` の実測 (a)(b))。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
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
import { ensureIslandRuntimeReady } from "../kernel/island-runner.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN } from "./test-helpers.ts";

const APP_ID = "atomic-grant";
const PLAIN_APP_ID = "atomic-plain";

/** 付与表の `member` に書く文言(作者の固定文。行の値を含まない)。 */
const MSG_MEMBER = "あなたは既に別の組織に所属しています";
/** 付与表の `on_create` の島が断る文言。 */
const MSG_GATE = "このチームには今は加われません";

/** 検査の外の例外で付与が落ちたときの 500 の文(新しい文。`D-V23-48`)。 */
const CRASH_MESSAGE =
  "行を作成できませんでした。作成者への権限を付けるところで想定外の失敗が起きたため、行も権限も書いていません。";
const CRASH_HINT =
  "アプリの管理者に連絡してください。権限を記録する表の設定が原因の可能性があります。";

const HISTORY_FIELDS = [
  { id: "ran_at", name: "実行時刻", type: "date" },
  { id: "workflow", name: "ワークフロー", type: "text" },
  { id: "trigger_type", name: "きっかけ", type: "text" },
  { id: "status", name: "結果", type: "text" },
  { id: "error", name: "エラー", type: "long_text" },
];

const ALL = ["read", "write", "delete"];

const PERMISSIONS = [
  { id: "p_owner", name: "持ち主", read: true, write: true, delete: true },
  { id: "p_member", name: "仲間", read: true, write: false, delete: false },
];

/** 組織の形の表(`id`)と、その付与表(`${id}_members`)。 */
function scopedTable(id: string, name: string): Record<string, unknown> {
  return {
    id,
    name,
    representative_field: "name",
    fields: [{ id: "name", name: "名前", type: "text", required: true }],
    access_control: {
      enabled: true,
      permissions: PERMISSIONS,
      creator_permission: "p_owner",
      creatable_by_roles: ["owner", "staff"],
      grant: { table: `${id}_members`, target: "org", member: "member", permission: "permission" },
      members: { table: "members", account: "account" },
    },
  };
}

function grantTable(
  id: string,
  target: string,
  member: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name: `${id} の付与`,
    fields: [
      { id: "org", name: "対象", type: "reference", reference_table: target, required: true },
      { id: "member", name: "メンバー", type: "reference", reference_table: "members", ...member },
      { id: "permission", name: "権限", type: "select", options: ["p_owner", "p_member"] },
    ],
  };
}

const TABLE_IDS = [
  "members",
  "orgs",
  "orgs_members",
  "teams",
  "teams_members",
  "clubs",
  "clubs_members",
  "memo",
  "needy",
  "wf_log",
];

/** 文言を書くか(`true`)、書かない今日のアプリか(`false`)。 */
function manifest(withMessage: boolean): Manifest {
  const rules = (can: string[]) =>
    TABLE_IDS.map((table) => ({ target: "table", table, can: table === "members" ? can : ALL }));
  return {
    app: {
      id: APP_ID,
      name: "作成と付与の原子化",
      tables: [
        {
          id: "members",
          name: "名簿",
          representative_field: "name",
          fields: [
            { id: "name", name: "名前", type: "text", required: true },
            { id: "account", name: "利用者ID", type: "text", required: true },
          ],
        },
        scopedTable("orgs", "組織"),
        grantTable("orgs_members", "orgs", {
          unique: true,
          ...(withMessage ? { unique_message: MSG_MEMBER } : {}),
        }),
        scopedTable("teams", "チーム"),
        grantTable("teams_members", "teams"),
        scopedTable("clubs", "部"),
        grantTable("clubs_members", "clubs"),
        {
          id: "memo",
          name: "メモ",
          fields: [{ id: "v", name: "値", type: "text" }],
        },
        {
          id: "needy",
          name: "必須のある表",
          fields: [{ id: "must", name: "必須", type: "text", required: true }],
        },
        { id: "wf_log", name: "実行履歴", fields: HISTORY_FIELDS },
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
        { id: "staff", name: "担当者", rules: rules(["read"]) },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
      functions: [
        {
          id: "team_gate",
          name: "チームの関門",
          code: `export default function (input, { reject }) { reject(${JSON.stringify(MSG_GATE)}); return []; }`,
          input: { source: "record" },
          output: { ops: true },
        },
      ],
      workflows: [
        {
          id: "wf_team_gate",
          name: "チームの付与を確かめる",
          trigger: { type: "on_create", table: "teams_members" },
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "team_gate", write_ops: true }],
        },
        {
          id: "wf_club_fail",
          name: "部の付与で必ず失敗する",
          trigger: { type: "on_create", table: "clubs_members" },
          history_table: "wf_log",
          // 必須の列を書かない作成(動けば必ず失敗する)。
          actions: [{ action: "create_record", table: "needy", values: {} }],
        },
      ],
    },
  } as unknown as Manifest;
}

/** `access_control` を1行も宣言しないアプリ(陰性対照)。 */
function plainManifest(): Manifest {
  return {
    app: {
      id: PLAIN_APP_ID,
      name: "宣言の無いアプリ",
      tables: [{ id: "notes", name: "覚え書き", fields: [{ id: "v", name: "値", type: "text" }] }],
      views: [],
      roles: [
        {
          id: "owner",
          name: "運営",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            { target: "table", table: "notes", can: ALL },
          ],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
    },
  } as unknown as Manifest;
}

type User = { cookie: string; userId: string; member: string };

type Rig = {
  dataRoot: string;
  appId: string;
  server: ReturnType<typeof createServerApp>;
  /** 既に組織A に所属している担当者。 */
  carol: User;
  /** どこにも所属していない担当者。 */
  dave: User;
  owner: User;
  orgA: string;
};

const dataRoots: string[] = [];

beforeAll(async () => {
  await ensureIslandRuntimeReady();
});

afterEach(async () => {
  for (const dir of dataRoots.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function freshApp(appId: string, m: Manifest): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "gp-atomic-grant-"));
  dataRoots.push(dataRoot);
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, m.app.name, { app_id: appId });
  } finally {
    meta.close();
  }
  const applied = applyManifest(dataRoot, appId, m);
  if (!applied.valid) {
    throw new Error(JSON.stringify(applied.errors));
  }
  return dataRoot;
}

function openDb(dataRoot: string, appId: string): Database {
  return new Database(appDbPath(dataRoot, appId));
}

function mustKernelCreate(
  db: Database,
  m: Manifest,
  table: string,
  values: Record<string, unknown>,
): string {
  const created = createRecord(db, m, table, values);
  if (!created.ok) {
    throw new Error(`${table} に行を置けない: ${JSON.stringify(created.errors)}`);
  }
  return created.value._id;
}

async function makeRig(withMessage: boolean): Promise<Rig> {
  const m = manifest(withMessage);
  const dataRoot = await freshApp(APP_ID, m);
  const owner = seedSession(dataRoot, APP_ID, { role: "owner", username: "owner1" });
  const carol = seedSession(dataRoot, APP_ID, { role: "staff", username: "carol" });
  const dave = seedSession(dataRoot, APP_ID, { role: "staff", username: "dave" });
  const db = openDb(dataRoot, APP_ID);
  let seeded: { owner: string; carol: string; dave: string; orgA: string };
  try {
    const ownerMember = mustKernelCreate(db, m, "members", {
      name: "運営",
      account: owner.userId,
    });
    const carolMember = mustKernelCreate(db, m, "members", {
      name: "かろる",
      account: carol.userId,
    });
    const daveMember = mustKernelCreate(db, m, "members", { name: "でいぶ", account: dave.userId });
    const orgA = mustKernelCreate(db, m, "orgs", { name: "組織A" });
    mustKernelCreate(db, m, "orgs_members", {
      org: orgA,
      member: carolMember,
      permission: "p_member",
    });
    seeded = { owner: ownerMember, carol: carolMember, dave: daveMember, orgA };
  } finally {
    db.close();
  }
  return {
    dataRoot,
    appId: APP_ID,
    server: createServerApp({ dataRoot }),
    owner: { cookie: owner.cookie, userId: owner.userId, member: seeded.owner },
    carol: { cookie: carol.cookie, userId: carol.userId, member: seeded.carol },
    dave: { cookie: dave.cookie, userId: dave.userId, member: seeded.dave },
    orgA: seeded.orgA,
  };
}

async function send(
  rig: { server: Rig["server"]; appId: string },
  user: { cookie: string },
  path: string,
  body: unknown,
): Promise<Response> {
  return await rig.server.request(
    new Request(`http://localhost/api/apps/${rig.appId}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: TEST_ORIGIN, cookie: user.cookie },
      body: JSON.stringify(body),
    }),
  );
}

function rowsOf(dataRoot: string, appId: string, table: string): Record<string, unknown>[] {
  const db = openDb(dataRoot, appId);
  try {
    return db.query<Record<string, unknown>, []>(`SELECT * FROM "${table}"`).all();
  } finally {
    db.close();
  }
}

function auditOf(dataRoot: string, appId: string): Record<string, unknown>[] {
  const db = openDb(dataRoot, appId);
  try {
    const exists = db
      .query<{ n: number }, []>(
        `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '_auth_activity'`,
      )
      .get();
    if ((exists?.n ?? 0) === 0) {
      return [];
    }
    return db
      .query<Record<string, unknown>, []>(
        `SELECT user_id, username, action, table_id, record_id, changes FROM "_auth_activity" ORDER BY rowid`,
      )
      .all();
  } finally {
    db.close();
  }
}

type ErrorItem = { path: string; message: string; hint?: string };
type Body = { kind?: string; errors: ErrorItem[] };

/**
 * **今日の文面を別の測り方で得る**: 付与表へ直に、所属済みの人を2つ目の組織に入れる付与を
 * 書いたときの断り(`V23-M0-T01` の (d) と同じ撃ち方)。 運営が組織B を作ってから撃つ。
 */
async function todaysGrantRefusal(rig: Rig): Promise<{ status: number; body: Body }> {
  const created = await send(rig, rig.owner, "/tables/orgs/records", { name: "直に撃つ組織" });
  if (created.status !== 201) {
    throw new Error(`組織を作れない: ${created.status} ${await created.text()}`);
  }
  const orgB = ((await created.json()) as { record: { _id: string } }).record._id;
  const res = await send(rig, rig.owner, "/tables/orgs_members/records", {
    org: orgB,
    member: rig.carol.member,
    permission: "p_member",
  });
  return { status: res.status, body: (await res.json()) as Body };
}

describe("V23-M2-T05 付与表の一意違反で、組織の行も付与の行も残らない(FR-6 受け入れ2)", () => {
  test("(u-422) unique_message を書いた付与表: 所属済みの人が組織を作ると 422 と文言。組織の行も付与の行も無い", async () => {
    const rig = await makeRig(true);
    const res = await send(rig, rig.carol, "/tables/orgs/records", { name: "組織B" });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body).toEqual({
      kind: "app_rejected",
      errors: [{ path: "/member", message: MSG_MEMBER }],
    });
    expect(rowsOf(rig.dataRoot, APP_ID, "orgs").map((row) => row.name)).toEqual(["組織A"]);
    expect(rowsOf(rig.dataRoot, APP_ID, "orgs_members")).toHaveLength(1);
    expect(auditOf(rig.dataRoot, APP_ID)).toEqual([]);
  });

  test("(u-400) unique_message が無ければ 400 で今日の文面(付与表へ直に書いた断りと同じ)。行は無い", async () => {
    const rig = await makeRig(false);
    const res = await send(rig, rig.carol, "/tables/orgs/records", { name: "組織B" });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(rowsOf(rig.dataRoot, APP_ID, "orgs").map((row) => row.name)).toEqual(["組織A"]);
    expect(rowsOf(rig.dataRoot, APP_ID, "orgs_members")).toHaveLength(1);
    expect(auditOf(rig.dataRoot, APP_ID)).toEqual([]);
    const today = await todaysGrantRefusal(rig);
    expect(today.status).toBe(400);
    expect(body.kind).toBeUndefined();
    expect(body).toEqual(today.body);
  });

  test("(b-422) バッチ: 422 と文言。同じ要求の他の行も全部戻る", async () => {
    const rig = await makeRig(true);
    const res = await send(rig, rig.carol, "/batch", {
      ops: [
        { op: "create", table: "memo", values: { v: "先に書く行" } },
        { op: "create", table: "orgs", values: { name: "組織B" } },
      ],
    });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body).toEqual({
      kind: "app_rejected",
      errors: [{ path: "/member", message: MSG_MEMBER }],
    });
    expect(rowsOf(rig.dataRoot, APP_ID, "memo")).toHaveLength(0);
    expect(rowsOf(rig.dataRoot, APP_ID, "orgs").map((row) => row.name)).toEqual(["組織A"]);
    expect(rowsOf(rig.dataRoot, APP_ID, "orgs_members")).toHaveLength(1);
    expect(auditOf(rig.dataRoot, APP_ID)).toEqual([]);
  });

  test("(b-400) バッチ: unique_message が無ければ 400 で今日の文面。行は無い", async () => {
    const rig = await makeRig(false);
    const res = await send(rig, rig.carol, "/batch", {
      ops: [
        { op: "create", table: "memo", values: { v: "先に書く行" } },
        { op: "create", table: "orgs", values: { name: "組織B" } },
      ],
    });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(rowsOf(rig.dataRoot, APP_ID, "memo")).toHaveLength(0);
    expect(rowsOf(rig.dataRoot, APP_ID, "orgs").map((row) => row.name)).toEqual(["組織A"]);
    expect(rowsOf(rig.dataRoot, APP_ID, "orgs_members")).toHaveLength(1);
    const today = await todaysGrantRefusal(rig);
    expect(today.status).toBe(400);
    expect(body).toEqual(today.body);
  });
});

describe("V23-M2-T05 付与表の自動処理", () => {
  test("(r-reject) 付与表の on_create の島が reject → 422 と文言。組織の行も付与の行も無い", async () => {
    const rig = await makeRig(true);
    const res = await send(rig, rig.dave, "/tables/teams/records", { name: "チーム1" });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body).toEqual({ kind: "app_rejected", errors: [{ path: "", message: MSG_GATE }] });
    expect(rowsOf(rig.dataRoot, APP_ID, "teams")).toHaveLength(0);
    expect(rowsOf(rig.dataRoot, APP_ID, "teams_members")).toHaveLength(0);
  });

  test("(r-reject-batch) バッチでも 422 と文言。全体が戻る", async () => {
    const rig = await makeRig(true);
    const res = await send(rig, rig.dave, "/batch", {
      ops: [
        { op: "create", table: "memo", values: { v: "先に書く行" } },
        { op: "create", table: "teams", values: { name: "チーム1" } },
      ],
    });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body).toEqual({ kind: "app_rejected", errors: [{ path: "", message: MSG_GATE }] });
    expect(rowsOf(rig.dataRoot, APP_ID, "memo")).toHaveLength(0);
    expect(rowsOf(rig.dataRoot, APP_ID, "teams")).toHaveLength(0);
  });

  test("(r-history) 付与表の on_create が失敗: 400・行は無い・失敗の履歴は巻き戻しの後も残る(D-V23-55)", async () => {
    const rig = await makeRig(true);
    const res = await send(rig, rig.dave, "/tables/clubs/records", { name: "部1" });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.kind).toBeUndefined();
    expect(rowsOf(rig.dataRoot, APP_ID, "clubs")).toHaveLength(0);
    expect(rowsOf(rig.dataRoot, APP_ID, "clubs_members")).toHaveLength(0);
    expect(rowsOf(rig.dataRoot, APP_ID, "needy")).toHaveLength(0);
    const history = rowsOf(rig.dataRoot, APP_ID, "wf_log").filter(
      (row) => row.workflow === "wf_club_fail",
    );
    expect(history).toHaveLength(1);
    expect(history[0]?.status).toBe("failure");
    expect(history[0]?.trigger_type).toBe("on_create");
  });

  test("(r-history-batch) バッチでも、付与表の on_create の失敗の履歴は巻き戻しの後も残る", async () => {
    const rig = await makeRig(true);
    const res = await send(rig, rig.dave, "/batch", {
      ops: [
        { op: "create", table: "memo", values: { v: "先に書く行" } },
        { op: "create", table: "clubs", values: { name: "部1" } },
      ],
    });
    expect(res.status, await res.clone().text()).toBe(400);
    expect(rowsOf(rig.dataRoot, APP_ID, "memo")).toHaveLength(0);
    expect(rowsOf(rig.dataRoot, APP_ID, "clubs")).toHaveLength(0);
    const history = rowsOf(rig.dataRoot, APP_ID, "wf_log").filter(
      (row) => row.workflow === "wf_club_fail",
    );
    expect(history).toHaveLength(1);
    expect(history[0]?.status).toBe("failure");
  });
});

describe("V23-M2-T05 検査の外の例外", () => {
  /** 付与の書込を一時的に差し替える: 付与表への INSERT を SQLite の段で落とす。 */
  function breakGrantInsert(rig: Rig): void {
    const db = openDb(rig.dataRoot, APP_ID);
    try {
      db.exec(
        `CREATE TRIGGER t05_break_grant BEFORE INSERT ON "orgs_members" BEGIN SELECT RAISE(ABORT, 't05 grant broken'); END`,
      );
    } finally {
      db.close();
    }
  }

  test("(x-500) 単件 POST: 行ごと巻き戻して 500 と新しい文(逐語)。行は無い", async () => {
    const rig = await makeRig(true);
    breakGrantInsert(rig);
    const res = await send(rig, rig.dave, "/tables/orgs/records", { name: "組織D" });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(500);
    expect(body).toEqual({ errors: [{ path: "", message: CRASH_MESSAGE, hint: CRASH_HINT }] });
    expect(rowsOf(rig.dataRoot, APP_ID, "orgs").map((row) => row.name)).toEqual(["組織A"]);
    expect(rowsOf(rig.dataRoot, APP_ID, "orgs_members")).toHaveLength(1);
    expect(auditOf(rig.dataRoot, APP_ID)).toEqual([]);
  });

  test("(x-500-batch) バッチ: 全体を巻き戻して 500 と新しい文(逐語)", async () => {
    const rig = await makeRig(true);
    breakGrantInsert(rig);
    const res = await send(rig, rig.dave, "/batch", {
      ops: [
        { op: "create", table: "memo", values: { v: "先に書く行" } },
        { op: "create", table: "orgs", values: { name: "組織D" } },
      ],
    });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(500);
    expect(body).toEqual({ errors: [{ path: "", message: CRASH_MESSAGE, hint: CRASH_HINT }] });
    expect(rowsOf(rig.dataRoot, APP_ID, "memo")).toHaveLength(0);
    expect(rowsOf(rig.dataRoot, APP_ID, "orgs").map((row) => row.name)).toEqual(["組織A"]);
    expect(auditOf(rig.dataRoot, APP_ID)).toEqual([]);
  });
});

describe("V23-M2-T05 陽性対照(全アプリの例外2): 成功したときは今日と同じ", () => {
  test("(ok) 単件 POST: 201・応答・組織の行・作成者への付与1件・監査の行1件", async () => {
    const rig = await makeRig(true);
    const res = await send(rig, rig.dave, "/tables/orgs/records", { name: "組織D" });
    const body = (await res.json()) as { record: Record<string, unknown> };
    expect(res.status, JSON.stringify(body)).toBe(201);
    expect(Object.keys(body)).toEqual(["record"]);
    const id = String(body.record._id);
    expect(body.record.name).toBe("組織D");
    const orgRow = rowsOf(rig.dataRoot, APP_ID, "orgs").find((row) => row._id === id);
    expect(orgRow?.name).toBe("組織D");
    expect(
      rowsOf(rig.dataRoot, APP_ID, "orgs_members")
        .filter((row) => row.org === id)
        .map((row) => ({ member: row.member, permission: row.permission })),
    ).toEqual([{ member: rig.dave.member, permission: "p_owner" }]);
    expect(auditOf(rig.dataRoot, APP_ID)).toEqual([
      {
        user_id: rig.dave.userId,
        username: "dave",
        action: "create_record",
        table_id: "orgs",
        record_id: id,
        changes: null,
      },
    ]);
  });

  test("(ok-batch) バッチ: 200・応答・行・op ごとの付与・監査の行は op ごとに1件", async () => {
    const rig = await makeRig(true);
    const res = await send(rig, rig.dave, "/batch", {
      ops: [
        { op: "create", table: "memo", values: { v: "一緒に書く行" } },
        { op: "create", table: "orgs", values: { name: "組織D" } },
      ],
    });
    const body = (await res.json()) as { records: Record<string, unknown>[] };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(Object.keys(body)).toEqual(["records"]);
    expect(body.records.map((row) => row.v ?? row.name)).toEqual(["一緒に書く行", "組織D"]);
    const memoId = String(body.records[0]?._id);
    const orgId = String(body.records[1]?._id);
    expect(
      rowsOf(rig.dataRoot, APP_ID, "orgs_members")
        .filter((row) => row.org === orgId)
        .map((row) => ({ member: row.member, permission: row.permission })),
    ).toEqual([{ member: rig.dave.member, permission: "p_owner" }]);
    expect(
      auditOf(rig.dataRoot, APP_ID).map((row) => [row.action, row.table_id, row.record_id]),
    ).toEqual([
      ["create_record", "memo", memoId],
      ["create_record", "orgs", orgId],
    ]);
  });
});

describe("V23-M2-T05 陰性対照: access_control を宣言しないアプリは今日と同じ", () => {
  async function plainRig() {
    const m = plainManifest();
    const dataRoot = await freshApp(PLAIN_APP_ID, m);
    const owner = seedSession(dataRoot, PLAIN_APP_ID, { role: "owner", username: "owner1" });
    return {
      dataRoot,
      appId: PLAIN_APP_ID,
      server: createServerApp({ dataRoot }),
      owner: { cookie: owner.cookie, userId: owner.userId },
    };
  }

  test("(neg) 単件 POST: 201・応答・行・監査の行", async () => {
    const rig = await plainRig();
    const res = await send(rig, rig.owner, "/tables/notes/records", { v: "一行" });
    const body = (await res.json()) as { record: Record<string, unknown> };
    expect(res.status, JSON.stringify(body)).toBe(201);
    expect(Object.keys(body)).toEqual(["record"]);
    expect(Object.keys(body.record).sort()).toEqual(["_created_at", "_id", "_updated_at", "v"]);
    expect(body.record.v).toBe("一行");
    expect(rowsOf(rig.dataRoot, PLAIN_APP_ID, "notes").map((row) => row.v)).toEqual(["一行"]);
    expect(auditOf(rig.dataRoot, PLAIN_APP_ID)).toEqual([
      {
        user_id: rig.owner.userId,
        username: "owner1",
        action: "create_record",
        table_id: "notes",
        record_id: body.record._id,
        changes: null,
      },
    ]);
  });

  test("(neg-batch) バッチ: 200・応答・行・監査の行", async () => {
    const rig = await plainRig();
    const res = await send(rig, rig.owner, "/batch", {
      ops: [
        { op: "create", table: "notes", values: { v: "一" } },
        { op: "create", table: "notes", values: { v: "二" } },
      ],
    });
    const body = (await res.json()) as { records: Record<string, unknown>[] };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(Object.keys(body)).toEqual(["records"]);
    expect(body.records.map((row) => row.v)).toEqual(["一", "二"]);
    expect(
      rowsOf(rig.dataRoot, PLAIN_APP_ID, "notes")
        .map((row) => row.v)
        .sort(),
    ).toEqual(["一", "二"]);
    expect(
      auditOf(rig.dataRoot, PLAIN_APP_ID).map((row) => [row.action, row.table_id, row.record_id]),
    ).toEqual(body.records.map((row) => ["create_record", "notes", row._id]));
  });

  test("(neg-refused) バッチの検査の失敗は今日の 400 で、1件も書かない", async () => {
    const rig = await plainRig();
    const res = await send(rig, rig.owner, "/batch", {
      ops: [
        { op: "create", table: "notes", values: { v: "一" } },
        { op: "create", table: "notes", values: { nope: "無い列" } },
      ],
    });
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.kind).toBeUndefined();
    expect(body.errors[0]?.path.startsWith("/ops/1")).toBe(true);
    expect(rowsOf(rig.dataRoot, PLAIN_APP_ID, "notes")).toHaveLength(0);
    expect(auditOf(rig.dataRoot, PLAIN_APP_ID)).toEqual([]);
  });
});
