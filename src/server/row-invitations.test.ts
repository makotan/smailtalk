/**
 * **行の招待: 発行・行の一覧・取消・掃除**(`V23-M5-T03`。上位:
 * `docs/adr/0532-row-invitation-accept-judgment-and-group-rewrite.md` §Decision 1-2・1-6、
 * `docs/adr/0501-row-invitations-and-inbox.md`、決定 `D-V23-119`〜`D-V23-122`・`D-V23-127`・
 * `D-V23-131`〜`D-V23-134`・`D-V23-136`、計画 `docs/plan/v23/00-v23-plan.md` §24-3 T03・§24-6 中4・中5・軽2・軽3)。
 *
 * **入口ごとに見ること(実 HTTP)**:
 * - (U) 招待を宣言していないアプリ・表・`enabled: false` の表への4本の口は、DB に触れずに
 *   今日と同じ「対応するエンドポイントはありません」の 404。 `app.sqlite` に表が増えない。
 * - (G) 認証の関門と POST の Origin の照合(未ログイン 401・他所の Origin 403)。
 * - (I) 発行 `POST …/records/:record_id/invitations`: 出せるのは `by` を持つ人(直接とグループ経由。
 *   親はたどらない)と運営者だけ / 渡せるのは `grantable` だけ / 自分宛ては 400 /
 *   存在しない名前・役割が合わない・名簿に無い・既に付与を持つ・上書きは同じ 202 と同じ本文 /
 *   利用者は必ず1回だけ引く / 同じ行・同じ相手は1行(上書きで招待者も替わる)/ 期限は `expires_days`(既定7)。
 * - (L) 行の一覧 `GET` 同じパス: 見られるのは `by` を持つ人・`creator_permission` を持つ人・運営者。
 *   応答は `grantable` と `pending` だけ。 それ以外は存在しない行と同じ 404。
 * - (R) 返答 `POST /api/apps/:app_id/invitations/:invitation_id`: `revoke` は一覧と同じ人だけ。
 *   それ以外・他人の招待・存在しない招待は同じ 404。 `accept` / `decline` は `T04` まで 404。
 * - (E) 期限切れの掃除は招待の口のリクエストの中で行う。
 * - (M) 自分宛ての一覧 `GET /api/apps/:app_id/invitations` は `T03` では口だけ(空の一覧)。
 *   【2026-09-30。`V23-M5-T05` の訂正。上の行を消していない】今日の (M) は、自分宛ての招待を1件ごとに
 *   6つの値(招待の ID・代表項目の値・招待者の表示名・権限の表示名・表の表示名・期限)だけで返すことを見る。
 *   【2026-09-30。`V23-M5-T11` の独立点検の処置(`ADR-0537`)。上の行を消していない】今日は7つ(`changes_group`
 *   を足した)。 末尾の (T11) は、承諾で書くグループを招待者自身のグループに限ること・承諾の判定の関門ごとの
 *   振る舞い・適用中の 409・発行の 404 の順・判定を器の中で見直すこと・宣言の無いアプリで app.sqlite を開かず
 *   台帳を1回だけ開くことを見る。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AuthStore } from "../auth/store.ts";
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

const APP_ID = "row-inv";
const PLAIN_APP_ID = "row-inv-plain";
const ALL = ["read", "write", "delete"];
const TABLES = [
  "members",
  "groups",
  "projects",
  "project_grants",
  "tasks",
  "task_grants",
  "teams",
  "team_grants",
  "archives",
  "archive_grants",
  "notes",
];

function refField(id: string, table: string, required = false): Record<string, unknown> {
  return {
    id,
    name: id,
    type: "reference",
    reference_table: table,
    ...(required ? { required } : {}),
  };
}

function grantFields(target: string, targetTable: string, options: string[], group = false) {
  return [
    refField(target, targetTable, true),
    refField("member", "members"),
    ...(group ? [refField("group", "groups")] : []),
    { id: "permission", name: "権限", type: "select", options, required: true },
  ];
}

function manifest(): Manifest {
  const rules = (can: string[]) => TABLES.map((table) => ({ target: "table", table, can }));
  return {
    app: {
      id: APP_ID,
      name: "行の招待",
      workspace: { invitations: { label: "招待" } },
      tables: [
        {
          id: "members",
          name: "名簿",
          representative_field: "name",
          fields: [
            { id: "name", name: "名前", type: "text", required: true },
            { id: "account", name: "利用者ID", type: "text", required: true },
            refField("grp", "groups"),
          ],
        },
        { id: "groups", name: "グループ", fields: [{ id: "title", name: "名前", type: "text" }] },
        {
          id: "projects",
          name: "案件",
          representative_field: "title",
          fields: [{ id: "title", name: "名前", type: "text" }],
          access_control: {
            enabled: true,
            permissions: [
              { id: "p_admin", name: "管理", read: true, write: true, delete: true },
              { id: "p_inviter", name: "招待係", read: true, write: false, delete: false },
              { id: "p_editor", name: "編集", read: true, write: true, delete: false },
              { id: "p_viewer", name: "閲覧", read: true, write: false, delete: false },
            ],
            creator_permission: "p_admin",
            grant: {
              table: "project_grants",
              target: "project",
              member: "member",
              group: "group",
              permission: "permission",
            },
            members: { table: "members", account: "account", group: "grp" },
            groups: { table: "groups" },
            invitations: {
              by: ["p_inviter"],
              grantable: ["p_editor", "p_viewer"],
              target_roles: ["staff"],
              expires_days: 3,
            },
          },
        },
        {
          id: "project_grants",
          name: "案件の付与",
          fields: grantFields(
            "project",
            "projects",
            ["p_admin", "p_inviter", "p_editor", "p_viewer"],
            true,
          ),
        },
        {
          id: "tasks",
          name: "作業",
          representative_field: "title",
          fields: [
            { id: "title", name: "名前", type: "text" },
            refField("project", "projects", true),
          ],
          access_control: {
            enabled: true,
            permissions: [
              { id: "k_admin", name: "管理", read: true, write: true, delete: true },
              { id: "k_viewer", name: "閲覧", read: true, write: false, delete: false },
            ],
            creator_permission: "k_admin",
            grant: {
              table: "task_grants",
              target: "task",
              member: "member",
              permission: "permission",
            },
            members: { table: "members", account: "account" },
            inherit_from: ["project"],
            creatable_by: ["k_admin"],
            invitations: { by: ["k_admin"], grantable: ["k_viewer"] },
          },
        },
        {
          id: "task_grants",
          name: "作業の付与",
          fields: grantFields("task", "tasks", ["k_admin", "k_viewer"]),
        },
        {
          id: "teams",
          name: "チーム",
          fields: [{ id: "title", name: "名前", type: "text" }],
          access_control: {
            enabled: true,
            permissions: [
              { id: "t_lead", name: "リーダー", read: true, write: true, delete: true },
              { id: "t_member", name: "メンバー", read: true, write: false, delete: false },
            ],
            creator_permission: "t_lead",
            grant: {
              table: "team_grants",
              target: "team",
              member: "member",
              permission: "permission",
            },
            members: { table: "members", account: "account" },
            invitations: { grantable: ["t_member"] },
          },
        },
        {
          id: "team_grants",
          name: "チームの付与",
          fields: grantFields("team", "teams", ["t_lead", "t_member"]),
        },
        {
          id: "archives",
          name: "保管",
          fields: [{ id: "title", name: "名前", type: "text" }],
          access_control: {
            enabled: false,
            permissions: [{ id: "a_admin", name: "管理", read: true, write: true, delete: true }],
            creator_permission: "a_admin",
            grant: {
              table: "archive_grants",
              target: "archive",
              member: "member",
              permission: "permission",
            },
            members: { table: "members", account: "account" },
            invitations: { grantable: ["a_admin"] },
          },
        },
        {
          id: "archive_grants",
          name: "保管の付与",
          fields: grantFields("archive", "archives", ["a_admin"]),
        },
        { id: "notes", name: "覚え書き", fields: [{ id: "title", name: "名前", type: "text" }] },
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
        { id: "guest", name: "来客", rules: rules(["read"]) },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
    },
  } as unknown as Manifest;
}

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

type Who = { cookie: string; userId: string; username: string };

type Rig = {
  dataRoot: string;
  server: ReturnType<typeof createServerApp>;
  owner: Who;
  /** 案件P に `p_inviter`(`by`)を直接持つ。 */
  ivan: Who;
  /** 案件P に `p_admin`(`creator_permission`)だけを持つ。 */
  alice: Who;
  /** 案件P に `p_editor` だけを持つ(`by` でも作成者でもない)。 */
  bob: Who;
  /** 名簿に在り、付与は無い。 */
  carol: Who;
  /** グループG の一員。 グループG が案件P に `p_inviter` を持つ。 */
  gina: Who;
  /** 招待の受け手(名簿に在る担当)。 */
  dave: Who;
  /** 役割が合わない受け手(来客)。 */
  gus: Who;
  /** 名簿に無い担当。 */
  nora: Who;
  /** 既に案件P に `p_viewer` を持つ担当。 */
  eve: Who;
  projectP: string;
  projectQ: string;
  taskT: string;
  teamA: string;
  archive: string;
  note: string;
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
  const dataRoot = await mkdtemp(join(tmpdir(), "gp-row-inv-"));
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

function put(db: Database, m: Manifest, table: string, values: Record<string, unknown>): string {
  const created = createRecord(db, m, table, values);
  if (!created.ok) {
    throw new Error(`${table} に行を置けない: ${JSON.stringify(created.errors)}`);
  }
  return created.value._id;
}

/** `T04` の検体の差し替え(台の行を置いた後に適用し直す。`base` は `T03` の台そのまま)。 */
type Variant = "base" | "unique" | "reject" | "actor";

const MSG_MEMBER = "この人は既に別の案件に参加しています。";
const MSG_GATE = "この案件には今は参加を受け付けていません。";

const HISTORY_FIELDS = [
  { id: "ran_at", name: "実行時刻", type: "date" },
  { id: "workflow", name: "ワークフロー", type: "text" },
  { id: "trigger_type", name: "きっかけ", type: "text" },
  { id: "status", name: "結果", type: "text" },
  { id: "error", name: "エラー", type: "long_text" },
];

/**
 * `T04` の検体: 付与表 `project_grants` に、一意の文言(`unique`)・島の `reject`(`reject`)・
 * 操作者を書く自動処理(`actor`)を足した定義。
 */
function variantManifest(variant: Variant): Manifest {
  const m = manifest() as unknown as {
    app: {
      tables: { id: string; fields: Record<string, unknown>[] }[];
      roles: { id: string; rules?: Record<string, unknown>[] }[];
      functions?: unknown[];
      workflows?: unknown[];
    };
  };
  const grants = m.app.tables.find((table) => table.id === "project_grants");
  const addTable = (id: string, fields: Record<string, unknown>[]) => {
    m.app.tables.push({ id, name: id, fields } as unknown as {
      id: string;
      fields: Record<string, unknown>[];
    });
    for (const role of m.app.roles) {
      if (role.id === "owner" || role.id === "staff") {
        role.rules?.push({ target: "table", table: id, can: ALL });
      }
    }
  };
  if (variant === "unique" && grants !== undefined) {
    grants.fields = grants.fields.map((field) =>
      field.id === "member" ? { ...field, unique: true, unique_message: MSG_MEMBER } : field,
    );
  }
  if (variant === "reject") {
    addTable("wf_log", HISTORY_FIELDS);
    m.app.functions = [
      {
        id: "grant_gate",
        name: "付与の関門",
        code: `export default function (input, { reject }) { reject(${JSON.stringify(MSG_GATE)}); return []; }`,
        input: { source: "record" },
        output: { ops: true },
      },
    ];
    m.app.workflows = [
      {
        id: "wf_grant_gate",
        name: "付与を確かめる",
        trigger: { type: "on_create", table: "project_grants" },
        history_table: "wf_log",
        actions: [{ action: "run_function", function: "grant_gate", write_ops: true }],
      },
    ];
  }
  if (variant === "actor") {
    addTable("wf_log", HISTORY_FIELDS);
    addTable("actor_log", [
      { id: "aid", name: "操作者ID", type: "text" },
      { id: "alogin", name: "操作者", type: "text" },
    ]);
    m.app.workflows = [
      {
        id: "wf_actor",
        name: "操作者を書く",
        trigger: { type: "on_create", table: "project_grants" },
        history_table: "wf_log",
        actions: [
          {
            action: "create_record",
            table: "actor_log",
            values: { aid: "$actor.id", alogin: "$actor.login" },
          },
        ],
      },
    ];
  }
  return m as unknown as Manifest;
}

async function makeRig(variant: Variant = "base"): Promise<Rig> {
  const m = manifest();
  const dataRoot = await freshApp(APP_ID, m);
  const seed = (username: string, role: string): Who => {
    const s = seedSession(dataRoot, APP_ID, { role, username });
    return { cookie: s.cookie, userId: s.userId, username };
  };
  const owner = seed("owner1", "owner");
  const ivan = seed("ivan", "staff");
  const alice = seed("alice", "staff");
  const bob = seed("bob", "staff");
  const carol = seed("carol", "staff");
  const gina = seed("gina", "staff");
  const dave = seed("dave", "staff");
  const gus = seed("gus", "guest");
  const nora = seed("nora", "staff");
  const eve = seed("eve", "staff");
  const db = openDb(dataRoot, APP_ID);
  try {
    const groupG = put(db, m, "groups", { title: "G" });
    const member = (who: Who, name: string, grp?: string) =>
      put(db, m, "members", { name, account: who.userId, ...(grp ? { grp } : {}) });
    member(owner, "運営");
    const ivanM = member(ivan, "いばん");
    const aliceM = member(alice, "ありす");
    const bobM = member(bob, "ぼぶ");
    member(carol, "きゃろる");
    member(gina, "じーな", groupG);
    member(dave, "でいぶ");
    member(gus, "がす");
    const eveM = member(eve, "いぶ");
    const projectP = put(db, m, "projects", { title: "案件P" });
    const projectQ = put(db, m, "projects", { title: "案件Q" });
    const grant = (values: Record<string, unknown>) => put(db, m, "project_grants", values);
    grant({ project: projectP, member: ivanM, permission: "p_inviter" });
    grant({ project: projectP, member: aliceM, permission: "p_admin" });
    grant({ project: projectP, member: bobM, permission: "p_editor" });
    grant({ project: projectP, group: groupG, permission: "p_inviter" });
    grant({ project: projectP, member: eveM, permission: "p_viewer" });
    const taskT = put(db, m, "tasks", { title: "作業T", project: projectP });
    const teamA = put(db, m, "teams", { title: "チームA" });
    put(db, m, "team_grants", { team: teamA, member: aliceM, permission: "t_lead" });
    const archive = put(db, m, "archives", { title: "保管1" });
    const note = put(db, m, "notes", { title: "覚え書き1" });
    if (variant !== "base") {
      const applied = applyManifest(dataRoot, APP_ID, variantManifest(variant));
      if (!applied.valid) {
        throw new Error(JSON.stringify(applied.errors));
      }
    }
    return {
      dataRoot,
      server: createServerApp({ dataRoot }),
      owner,
      ivan,
      alice,
      bob,
      carol,
      gina,
      dave,
      gus,
      nora,
      eve,
      projectP,
      projectQ,
      taskT,
      teamA,
      archive,
      note,
    };
  } finally {
    db.close();
  }
}

type Sent = { status: number; body: Record<string, unknown> };

async function call(
  server: Rig["server"],
  appId: string,
  method: "GET" | "POST",
  path: string,
  options: { who?: { cookie: string }; body?: unknown; origin?: string | null } = {},
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
  const res = await server.request(
    new Request(`http://localhost/api/apps/${appId}${path}`, {
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
  return { status: res.status, body };
}

const rowPath = (table: string, record: string) => `/tables/${table}/records/${record}/invitations`;

async function issue(rig: Rig, who: Who, login: string, permission = "p_viewer", record?: string) {
  return await call(rig.server, APP_ID, "POST", rowPath("projects", record ?? rig.projectP), {
    who,
    body: { login, permission },
  });
}

async function listRow(rig: Rig, who: Who, table = "projects", record?: string) {
  return await call(rig.server, APP_ID, "GET", rowPath(table, record ?? rig.projectP), { who });
}

async function respond(rig: Rig, who: Who, id: string, action: string) {
  return await call(rig.server, APP_ID, "POST", `/invitations/${id}`, { who, body: { action } });
}

function tableNames(dataRoot: string, appId: string): string[] {
  const db = openDb(dataRoot, appId);
  try {
    return db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master ORDER BY type, name")
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

function invitationRows(dataRoot: string): Record<string, unknown>[] {
  const db = openDb(dataRoot, APP_ID);
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

/**
 * **アプリの置き場のファイルの有無と更新時刻**(`V23-M5-T11` の処置 軽7)。 `app.sqlite` とその `-wal`・`-shm`、
 * 置き場のディレクトリそのものの更新時刻(ファイルが作られて消えても動く)を並べる。
 */
function appFileState(dataRoot: string, appId: string): unknown {
  const dir = dirname(appDbPath(dataRoot, appId));
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

/**
 * **app.sqlite(と `-wal`・`-shm`)を置き場の中で別の名前へ退かす**(`V23-M5-T11` の処置 軽7)。 退かしている間に
 * 誰かが app.sqlite を開けば、SQLite が新しい空のファイルを作る(有無が変わる)か、開けずに 404 以外になる。
 * 読むだけの接続でも見分けられる。 戻す関数を返す。
 */
function hideAppDb(dataRoot: string, appId: string): () => void {
  const dir = dirname(appDbPath(dataRoot, appId));
  const moved: [string, string][] = [];
  for (const name of ["app.sqlite", "app.sqlite-wal", "app.sqlite-shm"]) {
    const from = join(dir, name);
    if (existsSync(from)) {
      const to = join(dir, `${name}.t11-hidden`);
      renameSync(from, to);
      moved.push([to, from]);
    }
  }
  return () => {
    for (const [from, to] of moved) {
      renameSync(from, to);
    }
  };
}

/** 揮発する値(期限の時刻)を除いた本文。 */
function stable(body: Record<string, unknown>): unknown {
  const invitation = body.invitation as Record<string, unknown> | undefined;
  if (invitation === undefined) {
    return body;
  }
  const { expires_at: _expires, ...rest } = invitation;
  return { ...body, invitation: rest };
}

type Pending = {
  id: string;
  login: string;
  permission: string;
  inviter_name: string;
  expires_at: string;
};

function pendingOf(sent: Sent): Pending[] {
  return (sent.body.pending ?? []) as Pending[];
}

describe("(U) 招待を宣言していないアプリ・表への4本の口は、DB に触れずに今日と同じ 404", () => {
  test("(U-1) 宣言の無いアプリ: 4本とも今日の「対応するエンドポイントはありません」の 404。app.sqlite の表は1つも増えない", async () => {
    const dataRoot = await freshApp(PLAIN_APP_ID, plainManifest());
    const owner = seedSession(dataRoot, PLAIN_APP_ID, { role: "owner", username: "owner1" });
    const server = createServerApp({ dataRoot });
    const before = tableNames(dataRoot, PLAIN_APP_ID);
    // 【2026-09-30。`V23-M5-T11` の処置 軽7・`D-V23-141`】app.sqlite のファイルの有無と更新時刻(置き場の
    // ディレクトリの更新時刻を含む)が動かないこと、台帳(kernel.sqlite)を1要求につき1回だけ開くことも見る。
    // 読むだけの接続も見分けるため、要求の間は app.sqlite を別の名前へ退かしておく({@link hideAppDb})。
    const restore = hideAppDb(dataRoot, PLAIN_APP_ID);
    const filesBefore = appFileState(dataRoot, PLAIN_APP_ID);
    const who = { cookie: owner.cookie };
    const cases: ["GET" | "POST", string, unknown][] = [
      ["POST", "/tables/notes/records/x1/invitations", { login: "someone", permission: "p" }],
      ["GET", "/tables/notes/records/x1/invitations", undefined],
      ["GET", "/invitations", undefined],
      ["POST", "/invitations/abc", { action: "revoke" }],
    ];
    for (const [method, path, body] of cases) {
      for (const as of [who, undefined]) {
        const opens = spyOn(KernelMetaStore, "open");
        let sent: Sent;
        try {
          sent = await call(server, PLAIN_APP_ID, method, path, {
            ...(as === undefined ? {} : { who: as }),
            body,
          });
          expect(opens, `${method} ${path} の台帳を開いた回数`).toHaveBeenCalledTimes(1);
        } finally {
          opens.mockRestore();
        }
        expect(sent.status, `${method} ${path}`).toBe(404);
        expect(sent.body).toEqual({
          errors: [
            {
              path: "",
              message: `${method} /api/apps/${PLAIN_APP_ID}${path} に対応するエンドポイントはありません。`,
              hint: "エンドポイント一覧は MANUAL.md の「HTTP の口」の節を参照してください。",
            },
          ],
        });
      }
    }
    const filesAfter = appFileState(dataRoot, PLAIN_APP_ID);
    restore();
    expect(filesAfter).toEqual(filesBefore);
    expect(tableNames(dataRoot, PLAIN_APP_ID)).toEqual(before);
    expect(before).not.toContain("_row_invitations");
  });

  test("(U-2) 宣言のあるアプリでも、招待を宣言しない表・enabled: false の表への口は同じ 404 で、内部表を作らない", async () => {
    const rig = await makeRig();
    const before = tableNames(rig.dataRoot, APP_ID);
    // 【2026-09-30。`V23-M5-T11` の処置 軽7】app.sqlite のファイルの有無と更新時刻も動かないこと
    // (要求の間は app.sqlite を別の名前へ退かしておく。{@link hideAppDb})。
    const restore = hideAppDb(rig.dataRoot, APP_ID);
    const filesBefore = appFileState(rig.dataRoot, APP_ID);
    for (const [table, record] of [
      ["notes", rig.note],
      ["archives", rig.archive],
      ["no_such_table", "x"],
    ] as const) {
      for (const method of ["GET", "POST"] as const) {
        const path = rowPath(table, record);
        const sent = await call(rig.server, APP_ID, method, path, {
          who: rig.owner,
          body: { login: "dave", permission: "a_admin" },
        });
        expect(sent.status, `${method} ${path}`).toBe(404);
        expect((sent.body.errors as { message: string }[])[0]?.message).toBe(
          `${method} /api/apps/${APP_ID}${path} に対応するエンドポイントはありません。`,
        );
      }
    }
    const filesAfter = appFileState(rig.dataRoot, APP_ID);
    restore();
    expect(filesAfter).toEqual(filesBefore);
    expect(tableNames(rig.dataRoot, APP_ID)).toEqual(before);
    expect(before).not.toContain("_row_invitations");
  });

  test("(U-3) 宣言のあるアプリでは、内部表は招待の口を通ったときに初めて作られる", async () => {
    const rig = await makeRig();
    expect(tableNames(rig.dataRoot, APP_ID)).not.toContain("_row_invitations");
    const sent = await listRow(rig, rig.owner);
    expect(sent.status).toBe(200);
    expect(tableNames(rig.dataRoot, APP_ID)).toContain("_row_invitations");
  });
});

describe("(G) 認証の関門と Origin の照合(レコードの書込の口と同じ)", () => {
  test("(G-1) 未ログインは 4本とも 401", async () => {
    const rig = await makeRig();
    const cases: ["GET" | "POST", string, unknown][] = [
      ["POST", rowPath("projects", rig.projectP), { login: "dave", permission: "p_viewer" }],
      ["GET", rowPath("projects", rig.projectP), undefined],
      ["GET", "/invitations", undefined],
      ["POST", "/invitations/abc", { action: "revoke" }],
    ];
    for (const [method, path, body] of cases) {
      const sent = await call(rig.server, APP_ID, method, path, { body });
      expect(sent.status, `${method} ${path}`).toBe(401);
      expect((sent.body.errors as { message: string }[])[0]?.message).toBe(
        "認証が必要です。ログインしてください。",
      );
    }
    expect(invitationRows(rig.dataRoot)).toEqual([]);
  });

  test("(G-2) 他所の Origin からの POST は 403 で、招待は作られず取り消されない", async () => {
    const rig = await makeRig();
    const bad = await call(rig.server, APP_ID, "POST", rowPath("projects", rig.projectP), {
      who: rig.ivan,
      body: { login: "dave", permission: "p_viewer" },
      origin: "http://evil.example",
    });
    expect(bad.status).toBe(403);
    expect((bad.body.errors as { message: string }[])[0]?.message).toBe(
      'リクエスト元 "http://evil.example" は許可されていません。',
    );
    expect(invitationRows(rig.dataRoot)).toEqual([]);

    expect((await issue(rig, rig.ivan, "dave")).status).toBe(202);
    const id = pendingOf(await listRow(rig, rig.ivan))[0]?.id as string;
    const revoke = await call(rig.server, APP_ID, "POST", `/invitations/${id}`, {
      who: rig.ivan,
      body: { action: "revoke" },
      origin: "http://evil.example",
    });
    expect(revoke.status).toBe(403);
    expect(invitationRows(rig.dataRoot)).toHaveLength(1);
  });
});

describe("(I) 発行", () => {
  test("(I-1) by を直接持つ人・グループ経由で持つ人・運営者は出せる。by を省いた表は creator_permission の人が出せる", async () => {
    const rig = await makeRig();
    expect((await issue(rig, rig.ivan, "dave")).status).toBe(202);
    expect((await issue(rig, rig.gina, "carol")).status).toBe(202);
    expect((await issue(rig, rig.owner, "nora", "p_editor", rig.projectQ)).status).toBe(202);
    const team = await call(rig.server, APP_ID, "POST", rowPath("teams", rig.teamA), {
      who: rig.alice,
      body: { login: "dave", permission: "t_member" },
    });
    expect(team.status).toBe(202);
    expect(invitationRows(rig.dataRoot)).toHaveLength(4);
  });

  test("(I-2) by を持たない人(作成者の権限だけ・別の権限・付与なし)は、存在しない行と同じ 404。親の行の権限はたどらない", async () => {
    const rig = await makeRig();
    const missing = await issue(rig, rig.ivan, "dave", "p_viewer", "no-such-record");
    expect(missing.status).toBe(404);
    for (const who of [rig.alice, rig.bob, rig.carol, rig.gus]) {
      const sent = await issue(rig, who, "dave");
      expect(sent.status, who.username).toBe(404);
      expect(sent.body.errors).toEqual([
        {
          path: "",
          message: `テーブル "projects" にレコード "${rig.projectP}" は存在しません。`,
          hint: "一覧(GET .../records)で実在する _id を確認してください。",
        },
      ]);
    }
    // 案件P の管理者(alice)も、招待係(ivan)も、作業T そのものには権限を持たない(親はたどらない)。
    for (const who of [rig.alice, rig.ivan]) {
      const task = await call(rig.server, APP_ID, "POST", rowPath("tasks", rig.taskT), {
        who,
        body: { login: "dave", permission: "k_viewer" },
      });
      expect(task.status, who.username).toBe(404);
    }
    expect(invitationRows(rig.dataRoot)).toEqual([]);
  });

  test("(I-3) grantable の外の権限・宣言に無い権限・欠けた本文は 400。自分のログイン名は 400", async () => {
    const rig = await makeRig();
    for (const body of [
      { login: "dave", permission: "p_admin" },
      { login: "dave", permission: "p_inviter" },
      { login: "dave", permission: "nope" },
      { login: "dave" },
      { permission: "p_viewer" },
      { login: "", permission: "p_viewer" },
      { login: 3, permission: "p_viewer" },
    ]) {
      const sent = await call(rig.server, APP_ID, "POST", rowPath("projects", rig.projectP), {
        who: rig.ivan,
        body,
      });
      expect(sent.status, JSON.stringify(body)).toBe(400);
    }
    const grantable = await issue(rig, rig.ivan, "dave", "p_admin");
    expect(grantable.body.errors).toEqual([
      expect.objectContaining({ path: "/permission", allowed_values: ["p_editor", "p_viewer"] }),
    ]);
    const self = await issue(rig, rig.ivan, "ivan");
    expect(self.status).toBe(400);
    expect((self.body.errors as { path: string }[])[0]?.path).toBe("/login");
    expect(invitationRows(rig.dataRoot)).toEqual([]);
  });

  test("(I-4) 存在しない名前・役割が合わない・名簿に無い・既に付与を持つ・上書きは、同じ 202 と同じ本文(期限の時刻を除く)", async () => {
    const rig = await makeRig();
    const base = await issue(rig, rig.ivan, "dave");
    expect(base.status).toBe(202);
    const others = [
      await issue(rig, rig.ivan, "zz-nobody"),
      await issue(rig, rig.ivan, "gus"),
      await issue(rig, rig.ivan, "nora"),
      await issue(rig, rig.ivan, "eve"),
      await issue(rig, rig.ivan, "dave"),
    ];
    for (const [index, sent] of others.entries()) {
      expect(sent.status, String(index)).toBe(202);
      expect(stable(sent.body), String(index)).toEqual(stable(base.body));
    }
    expect(Object.keys(base.body)).toEqual(["invitation"]);
    expect(Object.keys(base.body.invitation as object).sort()).toEqual([
      "expires_at",
      "permission",
    ]);
    expect(stable(base.body)).toEqual({ invitation: { permission: "p_viewer" } });
  });

  test("(I-5) 発行では必ず1回だけ利用者を引き、在れば利用者の ID を、無ければ空を持つ", async () => {
    const rig = await makeRig();
    const spy = spyOn(AuthStore.prototype, "findUserByUsername");
    try {
      for (const login of ["dave", "zz-nobody"]) {
        spy.mockClear();
        expect((await issue(rig, rig.ivan, login)).status).toBe(202);
        expect(
          spy.mock.calls.map((args) => args[0]),
          login,
        ).toEqual([login]);
      }
    } finally {
      spy.mockRestore();
    }
    const rows = invitationRows(rig.dataRoot);
    const byLogin = new Map(rows.map((row) => [row.invitee_login, row]));
    expect(byLogin.get("dave")?.invitee_user_id).toBe(rig.dave.userId);
    expect(byLogin.get("zz-nobody")?.invitee_user_id).toBe("");
    expect(byLogin.get("dave")?.inviter_id).toBe(rig.ivan.userId);
    expect(byLogin.get("dave")?.table_id).toBe("projects");
    expect(byLogin.get("dave")?.record_id).toBe(rig.projectP);
    expect(byLogin.get("dave")?.permission).toBe("p_viewer");
  });

  test("(I-6) 同じ行・同じ相手には1行。発行し直すと権限と招待者が替わる。別の行なら別の行", async () => {
    const rig = await makeRig();
    expect((await issue(rig, rig.ivan, "dave", "p_viewer")).status).toBe(202);
    expect((await issue(rig, rig.gina, "dave", "p_editor")).status).toBe(202);
    expect((await issue(rig, rig.owner, "zz-nobody")).status).toBe(202);
    expect((await issue(rig, rig.ivan, "zz-nobody")).status).toBe(202);
    const rows = invitationRows(rig.dataRoot);
    expect(rows).toHaveLength(2);
    const dave = rows.find((row) => row.invitee_login === "dave");
    expect(dave?.permission).toBe("p_editor");
    expect(dave?.inviter_id).toBe(rig.gina.userId);
    expect(rows.find((row) => row.invitee_login === "zz-nobody")?.inviter_id).toBe(rig.ivan.userId);
    expect((await issue(rig, rig.owner, "dave", "p_viewer", rig.projectQ)).status).toBe(202);
    expect(invitationRows(rig.dataRoot)).toHaveLength(3);
  });

  test("(I-7) 期限は expires_days 日後(省けば7日後)", async () => {
    const rig = await makeRig();
    const started = Date.now();
    const project = await issue(rig, rig.ivan, "dave");
    const team = await call(rig.server, APP_ID, "POST", rowPath("teams", rig.teamA), {
      who: rig.alice,
      body: { login: "dave", permission: "t_member" },
    });
    const ended = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const within = (sent: Sent, days: number) => {
      const at = Date.parse((sent.body.invitation as { expires_at: string }).expires_at);
      expect(at).toBeGreaterThanOrEqual(started + days * day);
      expect(at).toBeLessThanOrEqual(ended + days * day);
    };
    within(project, 3);
    within(team, 7);
  });
});

describe("(L) 行の一覧", () => {
  test("(L-1) by を持つ人・creator_permission を持つ人・運営者は見られる。応答は grantable と pending だけ", async () => {
    const rig = await makeRig();
    await issue(rig, rig.ivan, "dave", "p_editor");
    await issue(rig, rig.ivan, "zz-nobody");
    for (const who of [rig.ivan, rig.gina, rig.alice, rig.owner]) {
      const sent = await listRow(rig, who);
      expect(sent.status, who.username).toBe(200);
      expect(Object.keys(sent.body).sort()).toEqual(["grantable", "pending"]);
      expect(sent.body.grantable).toEqual([
        { id: "p_editor", name: "編集" },
        { id: "p_viewer", name: "閲覧" },
      ]);
      const pending = pendingOf(sent);
      expect(pending).toHaveLength(2);
      for (const item of pending) {
        expect(Object.keys(item).sort()).toEqual([
          "expires_at",
          "id",
          "inviter_name",
          "login",
          "permission",
        ]);
        expect(item.inviter_name).toBe("ivan");
      }
      expect(pending.map((item) => [item.login, item.permission]).sort()).toEqual([
        ["dave", "p_editor"],
        ["zz-nobody", "p_viewer"],
      ]);
    }
  });

  test("(L-2) それ以外(別の権限・付与なし・来客)は、存在しない行と同じ 404", async () => {
    const rig = await makeRig();
    await issue(rig, rig.ivan, "dave");
    const missing = await listRow(rig, rig.owner, "projects", "no-such-record");
    expect(missing.status).toBe(404);
    for (const who of [rig.bob, rig.carol, rig.gus, rig.dave, rig.eve]) {
      const sent = await listRow(rig, who);
      expect(sent.status, who.username).toBe(404);
      expect(sent.body).toEqual({
        errors: [
          {
            path: "",
            message: `テーブル "projects" にレコード "${rig.projectP}" は存在しません。`,
            hint: "一覧(GET .../records)で実在する _id を確認してください。",
          },
        ],
      });
    }
  });

  test("(L-3) 他の行の招待は混ざらない", async () => {
    const rig = await makeRig();
    await issue(rig, rig.ivan, "dave");
    await issue(rig, rig.owner, "carol", "p_viewer", rig.projectQ);
    expect(pendingOf(await listRow(rig, rig.owner)).map((item) => item.login)).toEqual(["dave"]);
    expect(
      pendingOf(await listRow(rig, rig.owner, "projects", rig.projectQ)).map((item) => item.login),
    ).toEqual(["carol"]);
  });
});

describe("(R) 返答の口(取消。承諾と辞退は T04)", () => {
  test("(R-1) 一覧を見られる人は取り消せる。取り消すと行が消える", async () => {
    const rig = await makeRig();
    for (const who of [rig.ivan, rig.gina, rig.alice, rig.owner]) {
      expect((await issue(rig, rig.ivan, "dave")).status).toBe(202);
      const id = pendingOf(await listRow(rig, rig.ivan))[0]?.id as string;
      const sent = await respond(rig, who, id, "revoke");
      expect(sent.status, who.username).toBe(200);
      expect(sent.body).toEqual({ status: "revoked" });
      expect(invitationRows(rig.dataRoot)).toEqual([]);
    }
  });

  test("(R-2) 取り消せない人・存在しない招待・宛先本人の取消は、同じ 404 で、行は残る", async () => {
    const rig = await makeRig();
    await issue(rig, rig.ivan, "dave");
    const id = pendingOf(await listRow(rig, rig.ivan))[0]?.id as string;
    const missing = await respond(rig, rig.owner, "no-such-invitation", "revoke");
    expect(missing.status).toBe(404);
    for (const who of [rig.bob, rig.carol, rig.gus, rig.dave]) {
      const sent = await respond(rig, who, id, "revoke");
      expect(sent.status, who.username).toBe(404);
      expect(sent.body).toEqual(missing.body);
    }
    expect(invitationRows(rig.dataRoot)).toHaveLength(1);
  });

  test("(R-3) 他人宛て・存在しない招待への accept / decline は、取消の 404 と同じ 404", async () => {
    const rig = await makeRig();
    await issue(rig, rig.ivan, "dave");
    const id = pendingOf(await listRow(rig, rig.ivan))[0]?.id as string;
    const missing = await respond(rig, rig.owner, "no-such-invitation", "revoke");
    for (const action of ["accept", "decline"]) {
      for (const [who, target] of [
        [rig.carol, id],
        [rig.ivan, id],
        [rig.dave, "no-such-invitation"],
      ] as const) {
        const sent = await respond(rig, who, target, action);
        expect(sent.status, `${action} ${who.username}`).toBe(404);
        expect(sent.body).toEqual(missing.body);
      }
    }
    expect(invitationRows(rig.dataRoot)).toHaveLength(1);
  });

  // **【2026-09-30。`V23-M5-T04` で置き換えた。旧の題と期待(逐語)】**
  //   題: `(R-4 T03 の間だけ) 宛先本人の accept / decline も 404 で、招待は残る(承諾と辞退は T04 で入る)`
  //   期待: `for (const action of ["accept", "decline"]) { expect((await respond(rig, rig.dave, id, action)).status).toBe(404); }`
  //         `expect(invitationRows(rig.dataRoot)).toHaveLength(1);`
  // 承諾と辞退が入ったので、宛先本人の返答は下の (A)・(D) が見る。 ここでは「宛先本人だけが返答できる」ことを見る。
  test("(R-4) 宛先本人の accept / decline は 404 にならない(承諾と辞退は (A)・(D))", async () => {
    const rig = await makeRig();
    await issue(rig, rig.ivan, "dave");
    const id = pendingOf(await listRow(rig, rig.ivan))[0]?.id as string;
    const declined = await respond(rig, rig.dave, id, "decline");
    expect(declined.status).toBe(200);
    expect(invitationRows(rig.dataRoot)).toHaveLength(0);
    await issue(rig, rig.ivan, "dave");
    const again = pendingOf(await listRow(rig, rig.ivan))[0]?.id as string;
    expect((await respond(rig, rig.dave, again, "accept")).status).toBe(200);
  });

  test("(R-5) action が3値の外・無いときは 400", async () => {
    const rig = await makeRig();
    for (const body of [{ action: "delete" }, {}, { action: 1 }]) {
      const sent = await call(rig.server, APP_ID, "POST", "/invitations/x", {
        who: rig.owner,
        body,
      });
      expect(sent.status, JSON.stringify(body)).toBe(400);
      expect((sent.body.errors as { path: string }[])[0]?.path).toBe("/action");
    }
  });
});

// =====================================================================================
// **承諾と辞退**(`V23-M5-T04`。`ADR-0532` §Decision 1-3・1-4、決定 `D-V23-115`・`D-V23-123`・
// `D-V23-124`・`D-V23-131`・`D-V23-133` 重1・重2・中3・軽3・軽4)
// =====================================================================================

function rowsOf(dataRoot: string, table: string): Record<string, unknown>[] {
  const db = openDb(dataRoot, APP_ID);
  try {
    return db.query<Record<string, unknown>, []>(`SELECT * FROM "${table}"`).all();
  } finally {
    db.close();
  }
}

function memberIdOf(rig: Rig, who: Who): string {
  const found = rowsOf(rig.dataRoot, "members").filter((row) => row.account === who.userId);
  return found[0]?._id as string;
}

function grantsOf(rig: Rig, who: Who, table = "project_grants"): Record<string, unknown>[] {
  const member = memberIdOf(rig, who);
  return rowsOf(rig.dataRoot, table).filter((row) => row.member === member);
}

/** 招待を出して、その ID を返す(出す人の一覧から引く)。 */
async function invite(
  rig: Rig,
  inviter: Who,
  login: string,
  options: { permission?: string; table?: string; record?: string } = {},
): Promise<string> {
  const table = options.table ?? "projects";
  const record = options.record ?? rig.projectP;
  const sent = await call(rig.server, APP_ID, "POST", rowPath(table, record), {
    who: inviter,
    body: { login, permission: options.permission ?? "p_viewer" },
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  const listed = await call(rig.server, APP_ID, "GET", rowPath(table, record), { who: rig.owner });
  const found = pendingOf(listed).find((item) => item.login === login);
  expect(found, login).toBeDefined();
  return (found as Pending).id;
}

function withAuth<T>(rig: Rig, run: (store: AuthStore) => T): T {
  const store = AuthStore.openForApp(rig.dataRoot, APP_ID);
  try {
    return run(store);
  } finally {
    store.close();
  }
}

function messageOf(sent: Sent): string {
  return ((sent.body.errors as { message: string }[] | undefined) ?? [])[0]?.message ?? "";
}

describe("(A) 承諾", () => {
  test("(A-1) 受け手が承諾すると、受け手の名簿の行を相手に付与が1行でき、招待が消え、行が読めるようになる", async () => {
    const rig = await makeRig();
    const before = await call(
      rig.server,
      APP_ID,
      "GET",
      `/tables/projects/records/${rig.projectP}`,
      {
        who: rig.dave,
      },
    );
    expect(before.status).toBe(404);
    const id = await invite(rig, rig.ivan, "dave", { permission: "p_editor" });
    const sent = await respond(rig, rig.dave, id, "accept");
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body).toEqual({
      status: "accepted",
      table_id: "projects",
      record_id: rig.projectP,
    });
    expect(invitationRows(rig.dataRoot)).toEqual([]);
    const grants = grantsOf(rig, rig.dave);
    expect(grants.map((row) => [row.project, row.permission, row.group ?? null])).toEqual([
      [rig.projectP, "p_editor", null],
    ]);
    const after = await call(
      rig.server,
      APP_ID,
      "GET",
      `/tables/projects/records/${rig.projectP}`,
      {
        who: rig.dave,
      },
    );
    expect(after.status).toBe(200);
  });

  test("(A-2) グループ経由で by を持つ人・運営者・by を省いた表の作成者の招待も承諾できる", async () => {
    const rig = await makeRig();
    const viaGroup = await invite(rig, rig.gina, "dave");
    expect((await respond(rig, rig.dave, viaGroup, "accept")).status).toBe(200);
    const byOwner = await invite(rig, rig.owner, "carol", { record: rig.projectQ });
    expect((await respond(rig, rig.carol, byOwner, "accept")).status).toBe(200);
    const team = await invite(rig, rig.alice, "dave", {
      table: "teams",
      record: rig.teamA,
      permission: "t_member",
    });
    expect((await respond(rig, rig.dave, team, "accept")).status).toBe(200);
    expect(grantsOf(rig, rig.dave).map((row) => row.permission)).toEqual(["p_viewer"]);
    expect(grantsOf(rig, rig.carol).map((row) => [row.project, row.permission])).toEqual([
      [rig.projectQ, "p_viewer"],
    ]);
    expect(grantsOf(rig, rig.dave, "team_grants").map((row) => row.permission)).toEqual([
      "t_member",
    ]);
  });

  test("(A-3) 招待者が by を失っていたら、理由を付けて断り、招待は残り、付与はできない", async () => {
    const rig = await makeRig();
    const id = await invite(rig, rig.ivan, "dave");
    const db = openDb(rig.dataRoot, APP_ID);
    try {
      db.query("DELETE FROM project_grants WHERE member = ?").run(memberIdOf(rig, rig.ivan));
    } finally {
      db.close();
    }
    const sent = await respond(rig, rig.dave, id, "accept");
    expect(sent.status).toBe(403);
    expect(messageOf(sent)).toBe(
      "招待した人が、この行の権限を渡せなくなったため承諾できません。招待し直してもらってください。",
    );
    expect(invitationRows(rig.dataRoot)).toHaveLength(1);
    expect(grantsOf(rig, rig.dave)).toEqual([]);
  });

  test("(A-4) 運営者かどうかは承諾の時点で見る。運営者でなくなった招待者の招待は断る", async () => {
    const rig = await makeRig();
    seedSession(rig.dataRoot, APP_ID, { role: "owner", username: "owner2" });
    const id = await invite(rig, rig.owner, "dave", { record: rig.projectQ });
    withAuth(rig, (store) => store.setUserRole(rig.owner.userId, "staff"));
    const sent = await respond(rig, rig.dave, id, "accept");
    expect(sent.status).toBe(403);
    expect(messageOf(sent)).toBe(
      "招待した人が、この行の権限を渡せなくなったため承諾できません。招待し直してもらってください。",
    );
    expect(invitationRows(rig.dataRoot)).toHaveLength(1);
    expect(grantsOf(rig, rig.dave)).toEqual([]);
  });

  test("(A-5) 招待者の利用者が消えていたら断る", async () => {
    const rig = await makeRig();
    const id = await invite(rig, rig.ivan, "dave");
    withAuth(rig, (store) => store.deleteUser(rig.ivan.userId));
    const sent = await respond(rig, rig.dave, id, "accept");
    expect(sent.status).toBe(403);
    expect(messageOf(sent)).toBe(
      "招待した人がもういないため承諾できません。招待し直してもらってください。",
    );
    expect(invitationRows(rig.dataRoot)).toHaveLength(1);
    expect(grantsOf(rig, rig.dave)).toEqual([]);
  });

  test("(A-6) 受け手の役割が target_roles に合わなければ断る", async () => {
    const rig = await makeRig();
    const id = await invite(rig, rig.ivan, "gus");
    const sent = await respond(rig, rig.gus, id, "accept");
    expect(sent.status).toBe(403);
    expect(messageOf(sent)).toBe("この招待は、あなたの役割では承諾できません。");
    expect(invitationRows(rig.dataRoot)).toHaveLength(1);
    expect(grantsOf(rig, rig.gus)).toEqual([]);
  });

  test("(A-7) 受け手の名簿の行が0行なら、名簿に登録されていない理由で断り、招待は残る", async () => {
    const rig = await makeRig();
    const id = await invite(rig, rig.ivan, "nora");
    const sent = await respond(rig, rig.nora, id, "accept");
    expect(sent.status).toBe(403);
    expect(messageOf(sent)).toBe(
      "名簿に登録されていないため承諾できません。運営者に登録を頼んでください。",
    );
    expect(invitationRows(rig.dataRoot)).toHaveLength(1);
    expect(rowsOf(rig.dataRoot, "project_grants")).toHaveLength(5);
  });

  test("(A-8) 受け手の名簿の行が2行以上なら、理由を付けて断る", async () => {
    const rig = await makeRig();
    const db = openDb(rig.dataRoot, APP_ID);
    try {
      put(db, manifest(), "members", { name: "でいぶ2", account: rig.dave.userId });
    } finally {
      db.close();
    }
    const id = await invite(rig, rig.ivan, "dave");
    const sent = await respond(rig, rig.dave, id, "accept");
    expect(sent.status).toBe(403);
    expect(messageOf(sent)).toBe(
      "名簿にあなたの行が2つ以上あるため承諾できません。運営者に名簿の整理を頼んでください。",
    );
    expect(invitationRows(rig.dataRoot)).toHaveLength(1);
    expect(rowsOf(rig.dataRoot, "project_grants")).toHaveLength(5);
  });

  test("(A-9) 期限を過ぎた招待は、承諾しようとすると存在しない招待と同じ 404 で、付与はできない", async () => {
    const rig = await makeRig();
    const id = await invite(rig, rig.ivan, "dave");
    const missing = await respond(rig, rig.dave, "no-such-invitation", "accept");
    const db = openDb(rig.dataRoot, APP_ID);
    try {
      db.run("UPDATE _row_invitations SET expires_at = '2000-01-01T00:00:00.000Z'");
    } finally {
      db.close();
    }
    const sent = await respond(rig, rig.dave, id, "accept");
    expect(sent.status).toBe(404);
    expect(sent.body).toEqual(missing.body);
    expect(grantsOf(rig, rig.dave)).toEqual([]);
  });

  test("(A-10) 2回目の承諾は存在しない招待と同じ 404。付与は1行のまま", async () => {
    const rig = await makeRig();
    const id = await invite(rig, rig.ivan, "dave");
    expect((await respond(rig, rig.dave, id, "accept")).status).toBe(200);
    const missing = await respond(rig, rig.dave, "no-such-invitation", "accept");
    const second = await respond(rig, rig.dave, id, "accept");
    expect(second.status).toBe(404);
    expect(second.body).toEqual(missing.body);
    expect(grantsOf(rig, rig.dave)).toHaveLength(1);
  });

  test("(A-11) 同時に2本承諾しても、付与は1行だけ", async () => {
    const rig = await makeRig();
    const id = await invite(rig, rig.ivan, "dave");
    const sent = await Promise.all([
      respond(rig, rig.dave, id, "accept"),
      respond(rig, rig.dave, id, "accept"),
    ]);
    expect(sent.map((one) => one.status).sort()).toEqual([200, 404]);
    expect(grantsOf(rig, rig.dave)).toHaveLength(1);
    expect(invitationRows(rig.dataRoot)).toEqual([]);
  });

  test("(A-12) 招待された行が消えていたら断り、招待は残る", async () => {
    const rig = await makeRig();
    const id = await invite(rig, rig.ivan, "dave");
    const db = openDb(rig.dataRoot, APP_ID);
    try {
      db.query('DELETE FROM "projects" WHERE _id = ?').run(rig.projectP);
    } finally {
      db.close();
    }
    const sent = await respond(rig, rig.dave, id, "accept");
    expect(sent.status).toBe(403);
    expect(messageOf(sent)).toBe("招待された行が見つからないため承諾できません。");
    expect(invitationRows(rig.dataRoot)).toHaveLength(1);
    expect(grantsOf(rig, rig.dave)).toEqual([]);
  });

  test("(A-13) 渡す権限が今の grantable に無ければ断る", async () => {
    const rig = await makeRig();
    const id = await invite(rig, rig.ivan, "dave", { permission: "p_viewer" });
    const m = manifest() as unknown as {
      app: { tables: { id: string; access_control?: { invitations?: { grantable: string[] } } }[] };
    };
    const projects = m.app.tables.find((table) => table.id === "projects");
    (projects?.access_control?.invitations as { grantable: string[] }).grantable = ["p_editor"];
    const applied = applyManifest(rig.dataRoot, APP_ID, m as unknown as Manifest);
    expect(applied.valid, JSON.stringify(applied)).toBe(true);
    const sent = await respond(rig, rig.dave, id, "accept");
    expect(sent.status).toBe(403);
    expect(messageOf(sent)).toBe("この招待の権限は、今は渡せないため承諾できません。");
    expect(invitationRows(rig.dataRoot)).toHaveLength(1);
    expect(grantsOf(rig, rig.dave)).toEqual([]);
  });

  test("(A-14) 役割の規則(面): 招待者の役割が付与表に書けなくなっていたら断る(付与表への作成と同じ関門)", async () => {
    const rig = await makeRig();
    const id = await invite(rig, rig.ivan, "dave");
    withAuth(rig, (store) => store.setUserRole(rig.ivan.userId, "guest"));
    const direct = await call(rig.server, APP_ID, "POST", "/tables/project_grants/records", {
      who: rig.ivan,
      body: { project: rig.projectP, member: memberIdOf(rig, rig.dave), permission: "p_viewer" },
    });
    expect(direct.status).toBe(403);
    const sent = await respond(rig, rig.dave, id, "accept");
    expect(sent.status).toBe(403);
    expect(messageOf(sent)).toBe(
      "招待した人が、この行の権限を渡せなくなったため承諾できません。招待し直してもらってください。",
    );
    expect(invitationRows(rig.dataRoot)).toHaveLength(1);
    expect(grantsOf(rig, rig.dave)).toEqual([]);
  });

  test("(A-15) 相手が親の行を読めなければ断る(付与表への作成と同じ関門)。読める相手は承諾できる", async () => {
    const rig = await makeRig();
    const toDave = await invite(rig, rig.owner, "dave", {
      table: "tasks",
      record: rig.taskT,
      permission: "k_viewer",
    });
    const sent = await respond(rig, rig.dave, toDave, "accept");
    expect(sent.status).toBe(403);
    expect(messageOf(sent)).toBe(
      "あなたは、この行の元になっている行を読めないため承諾できません。先に元の行に招待してもらってください。",
    );
    expect(grantsOf(rig, rig.dave, "task_grants")).toEqual([]);
    const toEve = await invite(rig, rig.owner, "eve", {
      table: "tasks",
      record: rig.taskT,
      permission: "k_viewer",
    });
    expect((await respond(rig, rig.eve, toEve, "accept")).status).toBe(200);
    expect(grantsOf(rig, rig.eve, "task_grants").map((row) => row.permission)).toEqual([
      "k_viewer",
    ]);
    expect(invitationRows(rig.dataRoot).map((row) => row.invitee_login)).toEqual(["dave"]);
  });

  test("(A-16) 付与表の unique と unique_message に当たったら 422 と文言。招待も付与も変わらない(FR-6)", async () => {
    const rig = await makeRig("unique");
    const id = await invite(rig, rig.owner, "eve", { record: rig.projectQ });
    const before = rowsOf(rig.dataRoot, "project_grants");
    const sent = await respond(rig, rig.eve, id, "accept");
    expect(sent.status, JSON.stringify(sent.body)).toBe(422);
    expect(sent.body).toEqual({
      kind: "app_rejected",
      errors: [{ path: "/member", message: MSG_MEMBER }],
    });
    expect(invitationRows(rig.dataRoot)).toHaveLength(1);
    expect(rowsOf(rig.dataRoot, "project_grants")).toEqual(before);
  });

  test("(A-17) 付与表の on_create の島が reject したら 422 と文言。全部が巻き戻り、実行履歴に文言が残る(FR-6)", async () => {
    const rig = await makeRig("reject");
    const id = await invite(rig, rig.ivan, "dave");
    const sent = await respond(rig, rig.dave, id, "accept");
    expect(sent.status, JSON.stringify(sent.body)).toBe(422);
    expect(sent.body).toEqual({ kind: "app_rejected", errors: [{ path: "", message: MSG_GATE }] });
    expect(invitationRows(rig.dataRoot)).toHaveLength(1);
    expect(grantsOf(rig, rig.dave)).toEqual([]);
    const history = rowsOf(rig.dataRoot, "wf_log").filter(
      (row) => row.workflow === "wf_grant_gate",
    );
    expect(history).toHaveLength(1);
    expect(history[0]?.status).toBe("failure");
    expect(String(history[0]?.error)).toContain(MSG_GATE);
  });

  test("(A-18) 付与の自動処理の $actor は承諾した人。監査の行が承諾した人で残る", async () => {
    const rig = await makeRig("actor");
    const id = await invite(rig, rig.ivan, "dave");
    expect((await respond(rig, rig.dave, id, "accept")).status).toBe(200);
    const logged = rowsOf(rig.dataRoot, "actor_log");
    expect(logged.map((row) => [row.aid, row.alogin])).toEqual([[rig.dave.userId, "dave"]]);
    const grant = grantsOf(rig, rig.dave)[0];
    const audit = rowsOf(rig.dataRoot, "_auth_activity").filter(
      (row) => row.record_id === grant?._id,
    );
    expect(audit.map((row) => [row.user_id, row.action, row.table_id])).toEqual([
      [rig.dave.userId, "create_record", "project_grants"],
    ]);
  });
});

describe("(D) 辞退", () => {
  test("(D-1) 受け手が辞退すると招待が消えるだけで、付与はできない", async () => {
    const rig = await makeRig();
    const id = await invite(rig, rig.ivan, "dave");
    const before = rowsOf(rig.dataRoot, "project_grants");
    const sent = await respond(rig, rig.dave, id, "decline");
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ status: "declined" });
    expect(invitationRows(rig.dataRoot)).toEqual([]);
    expect(rowsOf(rig.dataRoot, "project_grants")).toEqual(before);
    expect((await respond(rig, rig.dave, id, "accept")).status).toBe(404);
  });

  test("(D-2) 宣言の無いアプリへの accept / decline は今日の 404 で、表は増えない", async () => {
    const dataRoot = await freshApp(PLAIN_APP_ID, plainManifest());
    const owner = seedSession(dataRoot, PLAIN_APP_ID, { role: "owner", username: "owner1" });
    const server = createServerApp({ dataRoot });
    const before = tableNames(dataRoot, PLAIN_APP_ID);
    for (const action of ["accept", "decline"]) {
      const sent = await call(server, PLAIN_APP_ID, "POST", "/invitations/abc", {
        who: { cookie: owner.cookie },
        body: { action },
      });
      expect(sent.status).toBe(404);
      expect(messageOf(sent)).toBe(
        `POST /api/apps/${PLAIN_APP_ID}/invitations/abc に対応するエンドポイントはありません。`,
      );
    }
    expect(tableNames(dataRoot, PLAIN_APP_ID)).toEqual(before);
  });
});

describe("(E) 期限切れの掃除", () => {
  test("(E-1) 期限を過ぎた招待は、招待の口のどれを通っても消え、一覧に出ない", async () => {
    const rig = await makeRig();
    for (const touch of [
      () => listRow(rig, rig.ivan),
      () => issue(rig, rig.ivan, "carol"),
      () => respond(rig, rig.owner, "no-such-invitation", "revoke"),
      () => call(rig.server, APP_ID, "GET", "/invitations", { who: rig.dave }),
    ]) {
      await issue(rig, rig.ivan, "dave");
      const db = openDb(rig.dataRoot, APP_ID);
      try {
        db.run(
          "UPDATE _row_invitations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE invitee_login = 'dave'",
        );
      } finally {
        db.close();
      }
      await touch();
      expect(invitationRows(rig.dataRoot).filter((row) => row.invitee_login === "dave")).toEqual(
        [],
      );
      expect(pendingOf(await listRow(rig, rig.ivan)).map((item) => item.login)).not.toContain(
        "dave",
      );
    }
  });
});

// =====================================================================================
// **自分宛ての一覧と、承諾前に見せるもの**(`V23-M5-T05`。`ADR-0532` §Decision 1-7・限定4、
// `ADR-0501` 限定4、決定 `D-V23-126`・`D-V23-132`、計画 §24-6 軽1)
//
// 【2026-09-30。`V23-M5-T05` の置き換え】`T03` の間だけの検査を置き換えた。 旧の describe の題は
// 「(M) 自分宛ての一覧(T03 では口だけ)」、旧の検査の題は「(M-1) 宣言のあるアプリでログインしていれば
// 200 と空の一覧」、旧の期待は逐語で `expect(sent.status).toBe(200);` と
// `expect(sent.body).toEqual({ invitations: [] });`(dave 宛てに1通出した後)。
//
// - 返すのは、ログイン中の人宛て(発行時に結びつけた利用者の ID が自分)・期限内・未承諾で、
//   受け手の実効ロールが `target_roles` のどれかに合う招待だけ。
// - 1件ごとに6つだけ: 招待の ID・行の代表項目の値1つ・招待者の表示名・権限の表示名・表の表示名・期限。
//   【2026-09-30。`V23-M5-T11` の処置(`ADR-0537` §2)。上の行を消していない】今日は7つ(承諾で所属グループが
//   替わるかどうかの真偽 `changes_group` を足した)。 グループの名前・ID は返さない。
// - 代表項目は `representative_field`、無ければ最初の text 項目。 受け手の役割の規則で隠れていれば null
//   (別の項目を繰り上げない)。
// - 行が消えた招待・権限が今の `grantable` に無い招待は返さない(承諾で断られる招待)。
// =====================================================================================

// 【2026-09-30。`V23-M5-T11` の独立点検の処置(`ADR-0537` §2)。旧の期待を注記に残す】
// 旧: 6つ `["expires_at", "id", "inviter_name", "permission_name", "representative", "table_name"]`。
// 今日は、承諾で所属グループが替わるかどうかの真偽 `changes_group` を足した7つ。
const INBOX_KEYS = [
  "changes_group",
  "expires_at",
  "id",
  "inviter_name",
  "permission_name",
  "representative",
  "table_name",
];

type InboxItem = {
  id: string;
  representative: string | null;
  inviter_name: string;
  permission_name: string;
  table_name: string;
  expires_at: string;
  changes_group: boolean;
};

async function inbox(rig: Rig, who: Who): Promise<Sent> {
  return await call(rig.server, APP_ID, "GET", "/invitations", { who });
}

function inboxOf(sent: Sent): InboxItem[] {
  return (sent.body.invitations ?? []) as InboxItem[];
}

function setDisplayName(rig: Rig, who: Who, name: string | null): void {
  const db = openDb(rig.dataRoot, APP_ID);
  try {
    db.query('UPDATE "_auth_users" SET "display_name" = ? WHERE "id" = ?').run(name, who.userId);
  } finally {
    db.close();
  }
}

function applyVariant(rig: Rig, edit: (m: Record<string, unknown>) => void): void {
  const m = manifest() as unknown as Record<string, unknown>;
  edit(m);
  const applied = applyManifest(rig.dataRoot, APP_ID, m as unknown as Manifest);
  expect(applied.valid, JSON.stringify(applied)).toBe(true);
}

type LooseApp = {
  app: {
    tables: {
      id: string;
      fields: Record<string, unknown>[];
      representative_field?: string;
      access_control?: { invitations?: { grantable: string[] } };
    }[];
    roles: { id: string; rules?: Record<string, unknown>[] }[];
  };
};

describe("(M) 自分宛ての一覧と、承諾前に見せるもの(T05)", () => {
  // 【2026-09-30。`V23-M5-T11` の処置(`ADR-0537` §2)。旧の題を注記に残す】旧の題:
  // 「(M-1) 自分宛ての招待を1件ごとに6つの値だけで返す。キーの集合は6つちょうどで、応答の外側は invitations だけ」。
  test("(M-1) 自分宛ての招待を1件ごとに7つの値だけで返す。キーの集合は7つちょうど(6つ + changes_group)で、応答の外側は invitations だけ", async () => {
    const rig = await makeRig();
    setDisplayName(rig, rig.ivan, "いばんさん");
    const projectInv = await invite(rig, rig.ivan, "dave", { permission: "p_viewer" });
    const teamInv = await invite(rig, rig.alice, "dave", {
      permission: "t_member",
      table: "teams",
      record: rig.teamA,
    });
    const sent = await inbox(rig, rig.dave);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(Object.keys(sent.body)).toEqual(["invitations"]);
    const items = inboxOf(sent);
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(INBOX_KEYS);
    }
    const expires = new Map(
      invitationRows(rig.dataRoot).map((row) => [row.id as string, row.expires_at as string]),
    );
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(byId.get(projectInv)).toEqual({
      id: projectInv,
      representative: "案件P",
      inviter_name: "いばんさん",
      permission_name: "閲覧",
      table_name: "案件",
      expires_at: expires.get(projectInv) as string,
      changes_group: false,
    });
    // 代表項目の宣言が無い表は最初の text 項目。 表示名の無い招待者はログイン名。
    expect(byId.get(teamInv)).toEqual({
      id: teamInv,
      representative: "チームA",
      inviter_name: "alice",
      permission_name: "メンバー",
      table_name: "チーム",
      expires_at: expires.get(teamInv) as string,
      changes_group: false,
    });
  });

  test("(M-2) 行のほかの項目・行の ID・付与表の中身・招待者の ID・ほかの受け手は返さない", async () => {
    const rig = await makeRig();
    applyVariant(rig, (raw) => {
      const m = raw as unknown as LooseApp;
      const projects = m.app.tables.find((table) => table.id === "projects");
      projects?.fields.push({ id: "code", name: "番号", type: "text" });
    });
    const db = openDb(rig.dataRoot, APP_ID);
    try {
      db.query('UPDATE "projects" SET "code" = ? WHERE _id = ?').run("P-SECRET-01", rig.projectP);
    } finally {
      db.close();
    }
    await invite(rig, rig.ivan, "dave");
    await invite(rig, rig.ivan, "carol", { permission: "p_editor" });
    const text = JSON.stringify((await inbox(rig, rig.dave)).body);
    for (const leak of [
      "P-SECRET-01",
      rig.projectP,
      rig.ivan.userId,
      rig.dave.userId,
      "carol",
      "きゃろる",
      "project_grants",
      "p_viewer",
      "p_inviter",
      "record_id",
      "table_id",
    ]) {
      expect(text, leak).not.toContain(leak);
    }
    expect(inboxOf(await inbox(rig, rig.dave))).toHaveLength(1);
  });

  test("(M-3) 他人宛て・役割が target_roles に合わない・期限切れ・承諾済み・辞退済み・取り消し済みの招待は返さない", async () => {
    const rig = await makeRig();
    await invite(rig, rig.ivan, "carol");
    const gusInv = await invite(rig, rig.ivan, "gus");
    expect(inboxOf(await inbox(rig, rig.dave))).toEqual([]);
    expect(inboxOf(await inbox(rig, rig.carol))).toHaveLength(1);
    // gus(来客)は target_roles(担当)に合わない。 招待は内部表に残っている。
    expect(invitationRows(rig.dataRoot).map((row) => row.id)).toContain(gusInv);
    expect(inboxOf(await inbox(rig, rig.gus))).toEqual([]);
    // 期限切れ
    const daveInv = await invite(rig, rig.ivan, "dave");
    expect(inboxOf(await inbox(rig, rig.dave)).map((item) => item.id)).toEqual([daveInv]);
    const db = openDb(rig.dataRoot, APP_ID);
    try {
      db.run(
        "UPDATE _row_invitations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE invitee_login = 'dave'",
      );
    } finally {
      db.close();
    }
    expect(inboxOf(await inbox(rig, rig.dave))).toEqual([]);
    // 承諾済み・辞退済み・取り消し済み
    const accepted = await invite(rig, rig.ivan, "dave");
    expect((await respond(rig, rig.dave, accepted, "accept")).status).toBe(200);
    expect(inboxOf(await inbox(rig, rig.dave))).toEqual([]);
    const declined = await invite(rig, rig.alice, "dave", {
      permission: "t_member",
      table: "teams",
      record: rig.teamA,
    });
    expect((await respond(rig, rig.dave, declined, "decline")).status).toBe(200);
    expect(inboxOf(await inbox(rig, rig.dave))).toEqual([]);
    const revoked = await invite(rig, rig.alice, "dave", {
      permission: "t_member",
      table: "teams",
      record: rig.teamA,
    });
    expect((await respond(rig, rig.owner, revoked, "revoke")).status).toBe(200);
    expect(inboxOf(await inbox(rig, rig.dave))).toEqual([]);
  });

  test("(M-4) 発行の時点にいなかった名前の招待は、後からその名前で登録した人にも出ない", async () => {
    const rig = await makeRig();
    const sent = await issue(rig, rig.ivan, "newcomer");
    expect(sent.status).toBe(202);
    const late = seedSession(rig.dataRoot, APP_ID, { role: "staff", username: "newcomer" });
    const who: Who = { cookie: late.cookie, userId: late.userId, username: "newcomer" };
    const listed = await inbox(rig, who);
    expect(listed.status).toBe(200);
    expect(inboxOf(listed)).toEqual([]);
  });

  test("(M-5) 代表項目が受け手の役割の規則で隠れていれば値を出さない(null)。別の項目を繰り上げない", async () => {
    const rig = await makeRig();
    applyVariant(rig, (raw) => {
      const m = raw as unknown as LooseApp;
      const projects = m.app.tables.find((table) => table.id === "projects");
      // 代表項目より前に別の text 項目を置く(繰り上げれば、これが出る)。
      projects?.fields.unshift({ id: "code", name: "番号", type: "text" });
      const owner = m.app.roles.find((role) => role.id === "owner");
      owner?.rules?.push({
        target: "field",
        table: "projects",
        field: "title",
        can: ["read", "write"],
      });
    });
    const db = openDb(rig.dataRoot, APP_ID);
    try {
      db.query('UPDATE "projects" SET "code" = ? WHERE _id = ?').run("P-CODE-01", rig.projectP);
    } finally {
      db.close();
    }
    const id = await invite(rig, rig.ivan, "dave");
    const sent = await inbox(rig, rig.dave);
    expect(sent.status).toBe(200);
    const items = inboxOf(sent);
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0] as InboxItem).sort()).toEqual(INBOX_KEYS);
    expect(items[0]?.id).toBe(id);
    expect(items[0]?.representative).toBeNull();
    const text = JSON.stringify(sent.body);
    expect(text).not.toContain("P-CODE-01");
    expect(text).not.toContain("案件P");
    expect(items[0]?.permission_name).toBe("閲覧");
    expect(items[0]?.table_name).toBe("案件");
  });

  test("(M-6) 招待された行が消えた招待・権限が今の grantable に無い招待は返さない", async () => {
    const rig = await makeRig();
    await invite(rig, rig.owner, "dave", { record: rig.projectQ, permission: "p_editor" });
    const teamInv = await invite(rig, rig.alice, "dave", {
      permission: "t_member",
      table: "teams",
      record: rig.teamA,
    });
    expect(inboxOf(await inbox(rig, rig.dave))).toHaveLength(2);
    const db = openDb(rig.dataRoot, APP_ID);
    try {
      db.query('DELETE FROM "teams" WHERE _id = ?').run(rig.teamA);
    } finally {
      db.close();
    }
    expect(inboxOf(await inbox(rig, rig.dave))).toHaveLength(1);
    expect(inboxOf(await inbox(rig, rig.dave)).map((item) => item.id)).not.toContain(teamInv);
    applyVariant(rig, (raw) => {
      const m = raw as unknown as LooseApp;
      const projects = m.app.tables.find((table) => table.id === "projects");
      (projects?.access_control?.invitations as { grantable: string[] }).grantable = ["p_viewer"];
    });
    expect(inboxOf(await inbox(rig, rig.dave))).toEqual([]);
    // 内部表の行は残っている(一覧が隠すだけ)。
    expect(invitationRows(rig.dataRoot)).toHaveLength(2);
  });

  test("(M-7) 招待が無ければ空の一覧。未ログインは 401", async () => {
    const rig = await makeRig();
    const sent = await inbox(rig, rig.dave);
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ invitations: [] });
    const anonymous = await call(rig.server, APP_ID, "GET", "/invitations");
    expect(anonymous.status).toBe(401);
  });
});

// =====================================================================================
// **承諾で名簿のグループ欄を書き換える**(`V23-M5-T04b`。`ADR-0532` §Decision 1-5・1-4・限定5・限定18、
// 決定 `D-V23-117`・`D-V23-118`・`D-V23-125`・`D-V23-135` (1))
//
// - `group_from` を宣言した表の招待を承諾すると、同じ器の中で、受け手の名簿の行のグループ欄に、
//   招待した行の `group_from` の項目の値を書く。 値が空なら書かない(付与だけ)。
// - 受け手は書く値を選べない(本文に値を受けない)。
// - 書き換えで、前のグループ経由でだけ管理者だった行が管理者0人になるなら、受け手の役割によらず断る。
// - 付与・招待の削除・グループ欄は全部成立か全部不成立。 名簿の `on_update` は器の中で走り、
//   起点(`$actor`・`st_updated_by`)は承諾した人。
// - 運営者の名簿の直接の書込は今日どおり断らない。 受け手が HTTP で名簿のグループ欄を書くのは今日どおり断る。
// - `group_from` を書かないアプリの名簿は1バイトも変わらない。
// =====================================================================================

type GroupVariant = "base" | "log" | "reject";

const MSG_ROSTER_GATE = "今は所属を変えられません。";

/** グループ欄の検体: 組織(`orgs`)の行が所属チーム(`team`)を持ち、承諾でその値を名簿の `grp` に書く。 */
function groupManifest(variant: GroupVariant): Manifest {
  const tables = [
    "members",
    "teams",
    "orgs",
    "org_grants",
    ...(variant === "base" ? [] : ["wf_log"]),
    ...(variant === "log" ? ["member_log"] : []),
  ];
  const rules = (can: string[]) => tables.map((table) => ({ target: "table", table, can }));
  return {
    app: {
      id: APP_ID,
      name: "所属の書き換え",
      workspace: { invitations: { label: "招待" } },
      tables: [
        {
          id: "members",
          name: "名簿",
          representative_field: "name",
          fields: [
            { id: "name", name: "名前", type: "text", required: true },
            { id: "account", name: "利用者ID", type: "text", required: true },
            refField("grp", "teams"),
            { id: "st_updated_by", name: "更新者", type: "text" },
          ],
        },
        { id: "teams", name: "チーム", fields: [{ id: "title", name: "名前", type: "text" }] },
        {
          id: "orgs",
          name: "組織",
          representative_field: "title",
          fields: [{ id: "title", name: "名前", type: "text" }, refField("team", "teams")],
          access_control: {
            enabled: true,
            permissions: [
              { id: "o_admin", name: "管理", read: true, write: true, delete: true },
              { id: "o_member", name: "所属", read: true, write: false, delete: false },
            ],
            creator_permission: "o_admin",
            grant: {
              table: "org_grants",
              target: "org",
              member: "member",
              group: "group",
              permission: "permission",
            },
            members: { table: "members", account: "account", group: "grp" },
            groups: { table: "teams" },
            invitations: { grantable: ["o_member"], group_from: "team" },
          },
        },
        {
          id: "org_grants",
          name: "組織の付与",
          fields: [
            refField("org", "orgs", true),
            refField("member", "members"),
            refField("group", "teams"),
            {
              id: "permission",
              name: "権限",
              type: "select",
              options: ["o_admin", "o_member"],
              required: true,
            },
          ],
        },
        ...(variant === "base" ? [] : [{ id: "wf_log", name: "実行履歴", fields: HISTORY_FIELDS }]),
        ...(variant === "log"
          ? [
              {
                id: "member_log",
                name: "所属の記録",
                fields: [
                  { id: "aid", name: "操作者ID", type: "text" },
                  { id: "item", name: "名簿の行", type: "text" },
                ],
              },
            ]
          : []),
      ],
      views: [],
      ...(variant === "reject"
        ? {
            functions: [
              {
                id: "roster_gate",
                name: "所属の関門",
                code: `export default function (input, { reject }) { reject(${JSON.stringify(MSG_ROSTER_GATE)}); return []; }`,
                input: { source: "record" },
                output: { ops: true },
              },
            ],
            workflows: [
              {
                id: "wf_roster_gate",
                name: "所属を確かめる",
                trigger: { type: "on_update", table: "members" },
                history_table: "wf_log",
                actions: [{ action: "run_function", function: "roster_gate", write_ops: true }],
              },
            ],
          }
        : {}),
      ...(variant === "log"
        ? {
            workflows: [
              {
                id: "wf_roster_log",
                name: "所属の変化を書く",
                trigger: { type: "on_update", table: "members", changed_fields: ["grp"] },
                history_table: "wf_log",
                actions: [
                  {
                    action: "create_record",
                    table: "member_log",
                    values: { aid: "$actor.id", item: "$record._id" },
                  },
                ],
              },
            ],
          }
        : {}),
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

type GroupRig = {
  dataRoot: string;
  server: ReturnType<typeof createServerApp>;
  owner: Who;
  /** 組織A・組織E・組織Y の管理者(直接)。 招待を出す人。 チーム2 の一員(`V23-M5-T11` の処置で足した)。 */
  ivan: Who;
  /** チーム1 の一員。 組織X の管理はチーム1 宛の1行だけなので、alice は組織X の唯一の管理者。 */
  alice: Who;
  /** チーム3 の一員(組織X には関わらない)。 */
  bob: Who;
  /** 名簿に在り、所属チームは無い。 */
  dave: Who;
  /** 運営者の役割で名簿に在り、チーム4 の一員。 組織Y の管理はチーム4 宛の1行だけ。 */
  olga: Who;
  team1: string;
  team2: string;
  team3: string;
  team4: string;
  /** 所属チーム = チーム2。 */
  orgA: string;
  /** 所属チームが空。 */
  orgE: string;
  /** チーム1 宛の管理の付与だけを持つ。 */
  orgX: string;
  /** チーム4 宛の管理の付与だけを持つ。 */
  orgY: string;
};

async function makeGroupRig(variant: GroupVariant = "base"): Promise<GroupRig> {
  const m = groupManifest("base");
  const dataRoot = await freshApp(APP_ID, m);
  const seed = (username: string, role: string): Who => {
    const s = seedSession(dataRoot, APP_ID, { role, username });
    return { cookie: s.cookie, userId: s.userId, username };
  };
  const owner = seed("owner1", "owner");
  const ivan = seed("ivan", "staff");
  const alice = seed("alice", "staff");
  const bob = seed("bob", "staff");
  const dave = seed("dave", "staff");
  const olga = seed("olga", "owner");
  const db = openDb(dataRoot, APP_ID);
  try {
    const team = (title: string) => put(db, m, "teams", { title });
    const team1 = team("チーム1");
    const team2 = team("チーム2");
    const team3 = team("チーム3");
    const team4 = team("チーム4");
    const member = (who: Who, name: string, grp?: string) =>
      put(db, m, "members", { name, account: who.userId, ...(grp ? { grp } : {}) });
    member(owner, "運営");
    // 【2026-09-30。`V23-M5-T11` の独立点検の処置(`ADR-0537` §1)。旧の行を注記に残す】
    // 旧: `const ivanM = member(ivan, "いばん");`(所属チームなし)。 承諾で書くグループ欄の値は、今日は招待者自身の
    // 名簿のグループと同じときだけ通るので、組織A(所属チーム = チーム2)へ招待する ivan をチーム2 の一員にした
    // (チーム2 宛ての付与は1行も無いので、ivan の権限は変わらない)。
    const ivanM = member(ivan, "いばん", team2);
    member(alice, "ありす", team1);
    member(bob, "ぼぶ", team3);
    member(dave, "でいぶ");
    member(olga, "おるが", team4);
    const orgA = put(db, m, "orgs", { title: "組織A", team: team2 });
    const orgE = put(db, m, "orgs", { title: "組織E" });
    const orgX = put(db, m, "orgs", { title: "組織X" });
    const orgY = put(db, m, "orgs", { title: "組織Y" });
    const grant = (values: Record<string, unknown>) => put(db, m, "org_grants", values);
    grant({ org: orgA, member: ivanM, permission: "o_admin" });
    grant({ org: orgE, member: ivanM, permission: "o_admin" });
    grant({ org: orgY, member: ivanM, permission: "o_member" });
    grant({ org: orgX, group: team1, permission: "o_admin" });
    grant({ org: orgY, group: team4, permission: "o_admin" });
    if (variant !== "base") {
      const applied = applyManifest(dataRoot, APP_ID, groupManifest(variant));
      if (!applied.valid) {
        throw new Error(JSON.stringify(applied.errors));
      }
    }
    return {
      dataRoot,
      server: createServerApp({ dataRoot }),
      owner,
      ivan,
      alice,
      bob,
      dave,
      olga,
      team1,
      team2,
      team3,
      team4,
      orgA,
      orgE,
      orgX,
      orgY,
    };
  } finally {
    db.close();
  }
}

function memberRowOf(rig: { dataRoot: string }, who: Who): Record<string, unknown> {
  const found = rowsOf(rig.dataRoot, "members").filter((row) => row.account === who.userId);
  expect(found).toHaveLength(1);
  return found[0] as Record<string, unknown>;
}

function orgGrantsOf(rig: GroupRig, who: Who): Record<string, unknown>[] {
  const member = memberRowOf(rig, who)._id;
  return rowsOf(rig.dataRoot, "org_grants").filter((row) => row.member === member);
}

/** 組織の行へ招待を出して、その ID を返す(出す人は ivan。一覧は運営者が引く)。 */
async function inviteToOrg(rig: GroupRig, login: string, org: string): Promise<string> {
  const sent = await call(rig.server, APP_ID, "POST", rowPath("orgs", org), {
    who: rig.ivan,
    body: { login, permission: "o_member" },
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  const listed = await call(rig.server, APP_ID, "GET", rowPath("orgs", org), { who: rig.owner });
  const found = pendingOf(listed).find((item) => item.login === login);
  expect(found, login).toBeDefined();
  return (found as Pending).id;
}

async function acceptAs(rig: GroupRig, who: Who, id: string, extra: Record<string, unknown> = {}) {
  return await call(rig.server, APP_ID, "POST", `/invitations/${id}`, {
    who,
    body: { action: "accept", ...extra },
  });
}

/** 名簿の行を HTTP の `PATCH` で書く(`If-Match` は今の版)。 */
async function patchMember(rig: GroupRig, who: Who, target: Who, values: Record<string, unknown>) {
  const row = memberRowOf(rig, target);
  const res = await rig.server.request(
    new Request(`http://localhost/api/apps/${APP_ID}/tables/members/records/${row._id}`, {
      method: "PATCH",
      headers: {
        cookie: who.cookie,
        origin: TEST_ORIGIN,
        "content-type": "application/json",
        "if-match": String(row._updated_at),
      },
      body: JSON.stringify(values),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
}

const MSG_GROUP_LAST_ADMIN_PART = "管理者";

describe("(GR) 承諾で名簿のグループ欄を書き換える(T04b)", () => {
  test("(GR-1) 承諾すると、付与が1行でき、受け手の名簿のグループ欄が招待した行の値になり、更新者は承諾した人", async () => {
    const rig = await makeGroupRig();
    const id = await inviteToOrg(rig, "dave", rig.orgA);
    const sent = await acceptAs(rig, rig.dave, id);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(invitationRows(rig.dataRoot)).toEqual([]);
    expect(orgGrantsOf(rig, rig.dave).map((row) => [row.org, row.permission])).toEqual([
      [rig.orgA, "o_member"],
    ]);
    const after = memberRowOf(rig, rig.dave);
    expect(after.grp).toBe(rig.team2);
    expect(after.st_updated_by).toBe(rig.dave.userId);
    const audit = rowsOf(rig.dataRoot, "_auth_activity").filter(
      (row) => row.record_id === after._id,
    );
    expect(audit.map((row) => [row.user_id, row.action, row.table_id])).toEqual([
      [rig.dave.userId, "update_record", "members"],
    ]);
  });

  test("(GR-2) 招待した行の値が空なら書かない(付与だけ)。名簿の行は1バイトも変わらない", async () => {
    const rig = await makeGroupRig();
    const before = memberRowOf(rig, rig.alice);
    const id = await inviteToOrg(rig, "alice", rig.orgE);
    const sent = await acceptAs(rig, rig.alice, id);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(orgGrantsOf(rig, rig.alice).map((row) => row.org)).toEqual([rig.orgE]);
    expect(memberRowOf(rig, rig.alice)).toEqual(before);
  });

  test("(GR-3) 書き換えで前のグループ経由でだけ管理者だった行が管理者0人になるなら、理由を付けて断る。付与・招待・名簿は全部そのまま", async () => {
    const rig = await makeGroupRig();
    const id = await inviteToOrg(rig, "alice", rig.orgA);
    const grantsBefore = rowsOf(rig.dataRoot, "org_grants");
    const memberBefore = memberRowOf(rig, rig.alice);
    const sent = await acceptAs(rig, rig.alice, id);
    expect(sent.status, JSON.stringify(sent.body)).toBe(403);
    expect(messageOf(sent)).toContain(MSG_GROUP_LAST_ADMIN_PART);
    expect(invitationRows(rig.dataRoot)).toHaveLength(1);
    expect(rowsOf(rig.dataRoot, "org_grants")).toEqual(grantsBefore);
    expect(memberRowOf(rig, rig.alice)).toEqual(memberBefore);
  });

  test("(GR-4) 前のグループに他の管理者が残るなら断らない", async () => {
    const rig = await makeGroupRig();
    expect((await patchMember(rig, rig.owner, rig.bob, { grp: rig.team1 })).status).toBe(200);
    const id = await inviteToOrg(rig, "alice", rig.orgA);
    const sent = await acceptAs(rig, rig.alice, id);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(memberRowOf(rig, rig.alice).grp).toBe(rig.team2);
  });

  test("(GR-5) 受け手が運営者でも、承諾の経路では断る(受け手の役割によらない)", async () => {
    const rig = await makeGroupRig();
    const id = await inviteToOrg(rig, "olga", rig.orgA);
    const memberBefore = memberRowOf(rig, rig.olga);
    const sent = await acceptAs(rig, rig.olga, id);
    expect(sent.status, JSON.stringify(sent.body)).toBe(403);
    expect(messageOf(sent)).toContain(MSG_GROUP_LAST_ADMIN_PART);
    expect(invitationRows(rig.dataRoot)).toHaveLength(1);
    expect(orgGrantsOf(rig, rig.olga)).toEqual([]);
    expect(memberRowOf(rig, rig.olga)).toEqual(memberBefore);
  });

  test("(GR-6) 運営者が名簿を直接書く経路は今日どおり断らない(前のグループの最後の管理者が消えても通る)", async () => {
    const rig = await makeGroupRig();
    const sent = await patchMember(rig, rig.owner, rig.alice, { grp: rig.team2 });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(memberRowOf(rig, rig.alice).grp).toBe(rig.team2);
  });

  test("(GR-7) 受け手は書く値を選べない。本文に値を足しても、書くのは招待した行の値", async () => {
    const rig = await makeGroupRig();
    const id = await inviteToOrg(rig, "dave", rig.orgA);
    const sent = await acceptAs(rig, rig.dave, id, {
      grp: rig.team3,
      group: rig.team3,
      value: rig.team3,
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(memberRowOf(rig, rig.dave).grp).toBe(rig.team2);
  });

  test("(GR-8) 受け手が HTTP で名簿のグループ欄を書くのは、承諾の前も後も今日どおり断る", async () => {
    const rig = await makeGroupRig();
    const before = await patchMember(rig, rig.dave, rig.dave, { grp: rig.team3 });
    expect(before.status, JSON.stringify(before.body)).toBe(403);
    const id = await inviteToOrg(rig, "dave", rig.orgA);
    expect((await acceptAs(rig, rig.dave, id)).status).toBe(200);
    const after = await patchMember(rig, rig.dave, rig.dave, { grp: rig.team3 });
    expect(after.status, JSON.stringify(after.body)).toBe(403);
    expect(after.body).toEqual(before.body);
    expect(memberRowOf(rig, rig.dave).grp).toBe(rig.team2);
  });

  test("(GR-9) 名簿の on_update の島が reject したら 422 と文言。付与・招待・名簿は全部巻き戻り、実行履歴に文言が残る", async () => {
    const rig = await makeGroupRig("reject");
    const id = await inviteToOrg(rig, "dave", rig.orgA);
    const grantsBefore = rowsOf(rig.dataRoot, "org_grants");
    const memberBefore = memberRowOf(rig, rig.dave);
    const sent = await acceptAs(rig, rig.dave, id);
    expect(sent.status, JSON.stringify(sent.body)).toBe(422);
    expect(sent.body).toEqual({
      kind: "app_rejected",
      errors: [{ path: "", message: MSG_ROSTER_GATE }],
    });
    expect(invitationRows(rig.dataRoot)).toHaveLength(1);
    expect(rowsOf(rig.dataRoot, "org_grants")).toEqual(grantsBefore);
    expect(memberRowOf(rig, rig.dave)).toEqual(memberBefore);
    const history = rowsOf(rig.dataRoot, "wf_log").filter(
      (row) => row.workflow === "wf_roster_gate",
    );
    expect(history).toHaveLength(1);
    expect(history[0]?.status).toBe("failure");
    expect(String(history[0]?.error)).toContain(MSG_ROSTER_GATE);
  });

  test("(GR-10) 名簿の on_update(changed_fields: グループ欄)は器の中で1回走り、$actor は承諾した人。値が空なら走らない", async () => {
    const rig = await makeGroupRig("log");
    const id = await inviteToOrg(rig, "dave", rig.orgA);
    expect((await acceptAs(rig, rig.dave, id)).status).toBe(200);
    const daveMember = memberRowOf(rig, rig.dave)._id;
    expect(rowsOf(rig.dataRoot, "member_log").map((row) => [row.aid, row.item])).toEqual([
      [rig.dave.userId, daveMember],
    ]);
    const empty = await inviteToOrg(rig, "bob", rig.orgE);
    expect((await acceptAs(rig, rig.bob, empty)).status).toBe(200);
    expect(rowsOf(rig.dataRoot, "member_log")).toHaveLength(1);
  });

  test("(GR-11) group_from を書かない表の承諾では、名簿の表は1バイトも変わらない", async () => {
    const rig = await makeRig();
    const before = rowsOf(rig.dataRoot, "members");
    const id = await invite(rig, rig.ivan, "dave", { permission: "p_editor" });
    expect((await respond(rig, rig.dave, id, "accept")).status).toBe(200);
    expect(grantsOf(rig, rig.dave)).toHaveLength(1);
    expect(rowsOf(rig.dataRoot, "members")).toEqual(before);
  });
});

// =====================================================================================
// **独立点検の処置**(`V23-M5-T11`。`ADR-0537`、決定 `D-V23-141`〜`D-V23-143`、点検の記録
// `docs/plan/v23/records/v23-m5-t11-audit.md`)
//
// - (T11-G) 承諾でグループ欄に書くのは、書く値が承諾の時点の招待者自身の名簿のグループと同じときだけ
//   (招待者が運営者なら問わない)。 違う・招待者の名簿の行が0行か2行以上なら、理由を付けて断り、
//   招待は残し、付与も作らない(重1。点検の再現 T11-P1 をそのまま検査にした)。
// - (T11-C) 自分宛ての一覧の `changes_group`(中2)。
// - (T11-K) 承諾の判定の関門ごとに、その関門だけで断られる振る舞い(中1)。
// - (T11-W) 承諾の判定を書込の器の中で見直す(軽4)。
// - (T11-A) 適用の最中は招待の口の書込(発行・辞退・取消・掃除)を全部 409(軽1)。
// - (T11-N) 招待できない人の発行は、権限の値の検査より先に 404(軽3)。
// =====================================================================================

const MSG_GROUP_NOT_INVITERS =
  "この招待は、招待した人の所属グループとは別のグループへ入れるものなので承諾できません。招待した人に確かめてもらってください。";
const MSG_INVITER_DENIED =
  "招待した人が、この行の権限を渡せなくなったため承諾できません。招待し直してもらってください。";

/** 組織の行を HTTP の `PATCH` で書く(`If-Match` は今の版)。 */
async function patchOrg(rig: GroupRig, who: Who, org: string, values: Record<string, unknown>) {
  const row = rowsOf(rig.dataRoot, "orgs").find((item) => item._id === org) as Record<
    string,
    unknown
  >;
  const res = await rig.server.request(
    new Request(`http://localhost/api/apps/${APP_ID}/tables/orgs/records/${org}`, {
      method: "PATCH",
      headers: {
        cookie: who.cookie,
        origin: TEST_ORIGIN,
        "content-type": "application/json",
        "if-match": String(row._updated_at),
      },
      body: JSON.stringify(values),
    }),
  );
  return res.status;
}

async function getOrg(rig: GroupRig, who: Who, org: string): Promise<number> {
  const res = await rig.server.request(
    new Request(`http://localhost/api/apps/${APP_ID}/tables/orgs/records/${org}`, {
      headers: { cookie: who.cookie },
    }),
  );
  await res.text();
  return res.status;
}

describe("(T11-G) 承諾で書くグループは招待者自身のグループに限る(ADR-0537 §1)", () => {
  test("(T11-G1) 点検の再現 T11-P1: 行の管理者が行のグループの項目を自分の入っていないグループに書き換えて招待しても、承諾は理由を付けて断られ、受け手はそのグループに入らない", async () => {
    const rig = await makeGroupRig();
    expect(await getOrg(rig, rig.dave, rig.orgX)).toBe(404);
    expect(await patchOrg(rig, rig.ivan, rig.orgA, { team: rig.team1 })).toBe(200);
    const id = await inviteToOrg(rig, "dave", rig.orgA);
    const grantsBefore = rowsOf(rig.dataRoot, "org_grants");
    const memberBefore = memberRowOf(rig, rig.dave);
    const sent = await acceptAs(rig, rig.dave, id);
    expect(sent.status, JSON.stringify(sent.body)).toBe(403);
    expect(messageOf(sent)).toBe(MSG_GROUP_NOT_INVITERS);
    expect(invitationRows(rig.dataRoot)).toHaveLength(1);
    expect(rowsOf(rig.dataRoot, "org_grants")).toEqual(grantsBefore);
    expect(memberRowOf(rig, rig.dave)).toEqual(memberBefore);
    expect(await getOrg(rig, rig.dave, rig.orgX)).toBe(404);
    expect(await getOrg(rig, rig.ivan, rig.orgX)).toBe(404);
  });

  test("(T11-G2) 招待者自身のグループと同じ値なら書く(組織A = チーム2 = ivan のチーム)", async () => {
    const rig = await makeGroupRig();
    const id = await inviteToOrg(rig, "dave", rig.orgA);
    const sent = await acceptAs(rig, rig.dave, id);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(memberRowOf(rig, rig.dave).grp).toBe(rig.team2);
  });

  test("(T11-G3) 運営者の招待は、招待者のグループを問わない", async () => {
    const rig = await makeGroupRig();
    expect(await patchOrg(rig, rig.owner, rig.orgA, { team: rig.team3 })).toBe(200);
    const sent0 = await call(rig.server, APP_ID, "POST", rowPath("orgs", rig.orgA), {
      who: rig.owner,
      body: { login: "dave", permission: "o_member" },
    });
    expect(sent0.status).toBe(202);
    const id = pendingOf(
      await call(rig.server, APP_ID, "GET", rowPath("orgs", rig.orgA), { who: rig.owner }),
    ).find((item) => item.login === "dave")?.id as string;
    const sent = await acceptAs(rig, rig.dave, id);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(memberRowOf(rig, rig.dave).grp).toBe(rig.team3);
  });

  test("(T11-G4) 招待者が承諾の時点で別のグループへ移っていたら断る(発行の時点ではなく承諾の時点で見る)", async () => {
    const rig = await makeGroupRig();
    const id = await inviteToOrg(rig, "dave", rig.orgA);
    expect((await patchMember(rig, rig.owner, rig.ivan, { grp: rig.team3 })).status).toBe(200);
    const sent = await acceptAs(rig, rig.dave, id);
    expect(sent.status, JSON.stringify(sent.body)).toBe(403);
    expect(messageOf(sent)).toBe(MSG_GROUP_NOT_INVITERS);
    expect(invitationRows(rig.dataRoot)).toHaveLength(1);
    expect(orgGrantsOf(rig, rig.dave)).toEqual([]);
  });

  test("(T11-G5) 招待者の名簿の行が2行あれば断る", async () => {
    const rig = await makeGroupRig();
    const id = await inviteToOrg(rig, "dave", rig.orgA);
    const db = openDb(rig.dataRoot, APP_ID);
    try {
      put(db, groupManifest("base"), "members", {
        name: "いばん2",
        account: rig.ivan.userId,
        grp: rig.team2,
      });
    } finally {
      db.close();
    }
    const sent = await acceptAs(rig, rig.dave, id);
    expect(sent.status, JSON.stringify(sent.body)).toBe(403);
    expect(messageOf(sent)).toBe(MSG_GROUP_NOT_INVITERS);
    expect(invitationRows(rig.dataRoot)).toHaveLength(1);
    expect(orgGrantsOf(rig, rig.dave)).toEqual([]);
  });

  test("(T11-G6) 値が空・受け手の今のグループと同じ(書かない)招待は、招待者のグループを見ない", async () => {
    const rig = await makeGroupRig();
    // 組織E は所属チームが空。 ivan をチーム3 へ移しても付与だけで通る。
    expect((await patchMember(rig, rig.owner, rig.ivan, { grp: rig.team3 })).status).toBe(200);
    const empty = await inviteToOrg(rig, "dave", rig.orgE);
    expect((await acceptAs(rig, rig.dave, empty)).status).toBe(200);
    // bob をチーム2 へ入れておくと、組織A(チーム2)への招待は書かない(今と同じ)ので通る。
    expect((await patchMember(rig, rig.owner, rig.bob, { grp: rig.team2 })).status).toBe(200);
    const same = await inviteToOrg(rig, "bob", rig.orgA);
    expect((await acceptAs(rig, rig.bob, same)).status).toBe(200);
    expect(memberRowOf(rig, rig.bob).grp).toBe(rig.team2);
  });
});

describe("(T11-C) 自分宛ての一覧の changes_group(ADR-0537 §2)", () => {
  test("(T11-C1) group_from の値が空でなく受け手の今のグループと違えば真、空・同じなら偽。承諾で断られる招待も同じ式", async () => {
    const rig = await makeGroupRig();
    expect((await patchMember(rig, rig.owner, rig.bob, { grp: rig.team2 })).status).toBe(200);
    const toDave = await inviteToOrg(rig, "dave", rig.orgA);
    const toDaveEmpty = await inviteToOrg(rig, "dave", rig.orgE);
    const toBob = await inviteToOrg(rig, "bob", rig.orgA);
    const flags = async (who: Who) => {
      const sent = await call(rig.server, APP_ID, "GET", "/invitations", { who });
      expect(sent.status).toBe(200);
      const items = (sent.body.invitations ?? []) as InboxItem[];
      for (const item of items) {
        expect(Object.keys(item).sort()).toEqual(INBOX_KEYS);
      }
      return new Map(items.map((item) => [item.id, item.changes_group]));
    };
    const dave = await flags(rig.dave);
    expect(dave.get(toDave)).toBe(true);
    expect(dave.get(toDaveEmpty)).toBe(false);
    expect((await flags(rig.bob)).get(toBob)).toBe(false);
    // 招待者が行の値を自分のグループの外へ書き換えた後も(承諾は断られる)、同じ式で真。
    expect(await patchOrg(rig, rig.ivan, rig.orgA, { team: rig.team1 })).toBe(200);
    expect((await flags(rig.dave)).get(toDave)).toBe(true);
    // グループの名前・ID は本文に無い。
    const text = JSON.stringify(
      (await call(rig.server, APP_ID, "GET", "/invitations", { who: rig.dave })).body,
    );
    for (const hidden of [rig.team1, rig.team2, "チーム1", "チーム2"]) {
      expect(text).not.toContain(hidden);
    }
  });
});

/** 基本の台で ivan が dave を案件P へ招待し、定義を差し替えた後に dave が承諾する。 */
async function acceptAfterVariant(
  edit: (m: LooseApp & { app: Record<string, unknown> }) => void,
  inviter: "ivan" | "owner" = "ivan",
  prepare: (rig: Rig) => void = () => {},
): Promise<{ rig: Rig; sent: Sent }> {
  const rig = await makeRig();
  prepare(rig);
  const id = await invite(rig, rig[inviter], "dave");
  applyVariant(rig, (raw) => edit(raw as unknown as LooseApp & { app: Record<string, unknown> }));
  const sent = await respond(rig, rig.dave, id, "accept");
  return { rig, sent };
}

function tableOf(m: LooseApp, id: string) {
  return m.app.tables.find((table) => table.id === id) as LooseApp["app"]["tables"][number] & {
    access_control?: Record<string, unknown>;
  };
}

function roleOf(m: LooseApp, id: string) {
  return m.app.roles.find((role) => role.id === id) as {
    id: string;
    rules: Record<string, unknown>[];
  };
}

/** 付与表 `project_grants` に `access_control` を宣言する(`pg_grants` を付与表にする)。 */
function governGrantTable(m: LooseApp, extra: Record<string, unknown>): void {
  tableOf(m, "project_grants").access_control = {
    enabled: true,
    permissions: [{ id: "g_admin", name: "管理", read: true, write: true, delete: true }],
    creator_permission: "g_admin",
    grant: { table: "pg_grants", target: "pg", member: "member", permission: "permission" },
    members: { table: "members", account: "account" },
    ...extra,
  };
  m.app.tables.push({
    id: "pg_grants",
    name: "付与の付与",
    fields: grantFields("pg", "project_grants", ["g_admin"]),
  } as unknown as LooseApp["app"]["tables"][number]);
  for (const role of ["owner", "staff"]) {
    roleOf(m, role).rules.push({ target: "table", table: "pg_grants", can: ALL });
  }
}

function expectInviterDenied(rig: Rig, sent: Sent): void {
  expect(sent.status, JSON.stringify(sent.body)).toBe(403);
  expect(messageOf(sent)).toBe(MSG_INVITER_DENIED);
  expect(invitationRows(rig.dataRoot)).toHaveLength(1);
  expect(grantsOf(rig, rig.dave)).toEqual([]);
}

describe("(T11-K) 承諾の判定の関門ごとに、その関門だけで断られる(点検 中1)", () => {
  test("(T11-K0) 陰性対照: 差し替えない定義では承諾できる", async () => {
    const { sent } = await acceptAfterVariant(() => {});
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  });

  test("(T11-K1) 直接作成の遮断: 付与表が st_no_direct_create を持てば断る", async () => {
    const { rig, sent } = await acceptAfterVariant((m) => {
      tableOf(m, "project_grants").fields.push({
        id: "st_no_direct_create",
        name: "直接作らない",
        type: "boolean",
      });
    });
    expectInviterDenied(rig, sent);
  });

  test("(T11-K2) ボタンの規則: 付与表を作るボタンを招待者の役割が読めなければ断る(読める運営者の招待は通る)", async () => {
    const edit = (m: LooseApp & { app: Record<string, unknown> }) => {
      m.app.views = [
        {
          id: "pg_form",
          type: "form",
          table: "project_grants",
          fields: ["project", "member", "permission"],
        },
        {
          id: "pg_list",
          type: "list_view",
          table: "projects",
          columns: ["title"],
          actions: [{ id: "add", form: "pg_form", prefill: { field: "project" }, name: "追加" }],
        },
      ];
      roleOf(m, "owner").rules.push(
        { target: "view", view: "pg_list", can: ["read"] },
        { target: "view", view: "pg_form", can: ["read"] },
        { target: "action", view: "pg_list", action: "add", can: ["read"] },
      );
    };
    const { rig, sent } = await acceptAfterVariant(edit);
    expectInviterDenied(rig, sent);
    const control = await acceptAfterVariant(edit, "owner");
    expect(control.sent.status, JSON.stringify(control.sent.body)).toBe(200);
  });

  test("(T11-K3) 項目の規則: 招待者の役割が付与表の権限の項目を書けなければ断る(運営者の招待は通る)", async () => {
    const edit = (m: LooseApp) => {
      roleOf(m, "staff").rules.push({
        target: "field",
        table: "project_grants",
        field: "permission",
        can: ["read"],
      });
      roleOf(m, "owner").rules.push({
        target: "field",
        table: "project_grants",
        field: "permission",
        can: ["read", "write"],
      });
    };
    const { rig, sent } = await acceptAfterVariant(edit);
    expectInviterDenied(rig, sent);
    const control = await acceptAfterVariant(edit, "owner");
    expect(control.sent.status, JSON.stringify(control.sent.body)).toBe(200);
  });

  test("(T11-K4) 行ごとの規則: 招待者の役割の付与表の書込が行の条件で閉じていれば断る(条件に合う権限の招待は通る)", async () => {
    const edit = (m: LooseApp) => {
      const staff = roleOf(m, "staff");
      staff.rules = staff.rules.filter((rule) => rule.table !== "project_grants");
      staff.rules.push(
        { target: "table", table: "project_grants", can: ["read", "delete"] },
        {
          target: "table",
          table: "project_grants",
          can: ["write"],
          when: { field: "permission", equals: "p_editor" },
        },
      );
    };
    const { rig, sent } = await acceptAfterVariant(edit);
    expectInviterDenied(rig, sent);
    const rig2 = await makeRig();
    const id = await invite(rig2, rig2.ivan, "dave", { permission: "p_editor" });
    applyVariant(rig2, (raw) => edit(raw as unknown as LooseApp));
    const passed = await respond(rig2, rig2.dave, id, "accept");
    expect(passed.status, JSON.stringify(passed.body)).toBe(200);
  });

  test("(T11-K5) 根の表の作成の関門: 付与表が access_control を宣言し creatable_by_roles に招待者の役割が無ければ断る(運営者の招待は通る)", async () => {
    const edit = (m: LooseApp) => governGrantTable(m, { creatable_by_roles: ["owner"] });
    const { rig, sent } = await acceptAfterVariant(edit);
    expectInviterDenied(rig, sent);
    const control = await acceptAfterVariant(edit, "owner");
    expect(control.sent.status, JSON.stringify(control.sent.body)).toBe(200);
  });

  test("(T11-K6) 親の行への書込の関門: 付与表が案件から引き継ぐなら、案件に書けない招待者の招待は断る(案件を書ける招待者の招待は通る)", async () => {
    const edit = (m: LooseApp) => governGrantTable(m, { inherit_from: ["project"] });
    const { rig, sent } = await acceptAfterVariant(edit);
    expectInviterDenied(rig, sent);
    // 陰性対照: ivan に案件P の編集(書ける権限)も直接渡しておけば通る。
    const control = await acceptAfterVariant(edit, "ivan", (rig2) => {
      const db = openDb(rig2.dataRoot, APP_ID);
      try {
        put(db, manifest(), "project_grants", {
          project: rig2.projectP,
          member: memberIdOf(rig2, rig2.ivan),
          permission: "p_editor",
        });
      } finally {
        db.close();
      }
    });
    expect(control.sent.status, JSON.stringify(control.sent.body)).toBe(200);
  });

  test("(T11-K7) 消えたグループ宛ての付与は数えない: グループの行が消えたら、そのグループ経由で by を持っていた人は出せない", async () => {
    const rig = await makeRig();
    const db = openDb(rig.dataRoot, APP_ID);
    try {
      db.query('DELETE FROM "groups"').run();
    } finally {
      db.close();
    }
    const sent = await issue(rig, rig.gina, "dave");
    expect(sent.status, JSON.stringify(sent.body)).toBe(404);
    expect((await listRow(rig, rig.gina)).status).toBe(404);
    expect(invitationRows(rig.dataRoot)).toEqual([]);
  });
});

describe("(T11-W) 承諾の判定は書込の器の中で見直す(点検 軽4)", () => {
  test("(T11-W1) 器を開く直前に招待者が by を失ったら、付与を作らずに断る", async () => {
    const rig = await makeRig();
    const id = await invite(rig, rig.ivan, "dave");
    const ivanMember = memberIdOf(rig, rig.ivan);
    const original = Database.prototype.transaction;
    const spy = spyOn(Database.prototype, "transaction").mockImplementation(function (
      this: Database,
      fn: (...args: unknown[]) => unknown,
    ) {
      // 同じ接続で消す(器が開く直前 = 外の判定の後に、招待者が by を失ったのと同じ姿)。
      this.query('DELETE FROM "project_grants" WHERE "member" = ?').run(ivanMember);
      return original.call(this, fn as never) as never;
    } as never);
    let sent: Sent;
    try {
      sent = await respond(rig, rig.dave, id, "accept");
    } finally {
      spy.mockRestore();
    }
    expect(sent.status, JSON.stringify(sent.body)).toBe(403);
    expect(messageOf(sent)).toBe(MSG_INVITER_DENIED);
    expect(grantsOf(rig, rig.dave)).toEqual([]);
    expect(invitationRows(rig.dataRoot)).toHaveLength(1);
  });
});

function beginApplyWindow(rig: Rig): () => void {
  const marker = join(dirname(appDbPath(rig.dataRoot, APP_ID)), ".st-applying.json");
  writeFileSync(marker, JSON.stringify({ started_at: new Date().toISOString(), diff_id: "d" }));
  return () => rmSync(marker, { force: true });
}

describe("(T11-A) 適用の最中は招待の口の書込を全部 409(点検 軽1)", () => {
  test("(T11-A1) 発行・一覧(掃除)・自分宛ての一覧(掃除)・辞退・取消・承諾は 409 で、内部表は1バイトも変わらない。窓が閉じれば今日どおり", async () => {
    const rig = await makeRig();
    const id = await invite(rig, rig.ivan, "dave");
    const expired = await invite(rig, rig.ivan, "carol");
    const db = openDb(rig.dataRoot, APP_ID);
    try {
      db.query('UPDATE "_row_invitations" SET "expires_at" = ? WHERE "id" = ?').run(
        "2000-01-01T00:00:00.000Z",
        expired,
      );
    } finally {
      db.close();
    }
    const before = invitationRows(rig.dataRoot);
    const end = beginApplyWindow(rig);
    try {
      const sent = [
        await issue(rig, rig.ivan, "eve"),
        await listRow(rig, rig.ivan),
        await inbox(rig, rig.dave),
        await respond(rig, rig.dave, id, "decline"),
        await respond(rig, rig.ivan, id, "revoke"),
        await respond(rig, rig.dave, id, "accept"),
      ];
      expect(sent.map((item) => item.status)).toEqual([409, 409, 409, 409, 409, 409]);
      expect(invitationRows(rig.dataRoot)).toEqual(before);
    } finally {
      end();
    }
    expect((await respond(rig, rig.dave, id, "decline")).status).toBe(200);
    expect(invitationRows(rig.dataRoot)).toEqual([]);
  });
});

describe("(T11-N) 招待できない人の発行は、本文の検査より先に 404(点検 軽3)", () => {
  test("(T11-N1) by を持たない人が不正な権限・欠けた本文・自分の名前を送っても、存在しない行と同じ 404 で grantable を返さない", async () => {
    const rig = await makeRig();
    const missing = await issue(rig, rig.bob, "dave", "p_viewer", "no-such-record");
    expect(missing.status).toBe(404);
    for (const body of [
      { login: "dave", permission: "zzz" },
      { login: "dave" },
      {},
      { login: "bob", permission: "p_viewer" },
    ]) {
      for (const record of [rig.projectP, "no-such-record"]) {
        const sent = await call(rig.server, APP_ID, "POST", rowPath("projects", record), {
          who: rig.bob,
          body,
        });
        expect(sent.status, JSON.stringify(body)).toBe(404);
        expect(JSON.stringify(sent.body)).not.toContain("p_editor");
        expect(sent.body.errors).toEqual(
          (missing.body.errors as { message: string }[]).map((error) => ({
            ...error,
            message: error.message.replace("no-such-record", record),
          })),
        );
      }
    }
    expect(invitationRows(rig.dataRoot)).toEqual([]);
  });

  test("(T11-N2) 出せる人の不正な権限は今日どおり 400 と grantable", async () => {
    const rig = await makeRig();
    const sent = await issue(rig, rig.ivan, "dave", "zzz");
    expect(sent.status).toBe(400);
    expect(JSON.stringify(sent.body)).toContain("p_editor");
  });
});
