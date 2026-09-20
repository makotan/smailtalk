/**
 * **`V18-M6-T02` / 審査の単位 `PM-G2` / `ADR-0443`(授権)**:
 * **AI の口(MCP)からの**更新**にも、親の関門を通す。**
 *
 * ## 何を撃つか(**道具は2本ある。`D-V18-29` により2本とも塞ぐ**)
 *
 * | # | 何を撃つか | **着手時(本葉が実際に見た赤 / 緑)** |
 * | --- | --- | --- |
 * | `(A-1)` | `update_record` —— 古い親を**消せない**人が `issues` を付け替える | **赤(通ってしまう)** |
 * | `(A-2)` | `update_record` —— 同じことを `milestones` で | **赤(通ってしまう)** |
 * | `(B-1)` | `write_records` の `update` op —— `issues` | **赤(通ってしまう)** |
 * | `(B-2)` | `write_records` の `update` op —— `milestones` | **赤(通ってしまう)** |
 * | `(C-1)` | **新しい親に書けない人**の付け替え(`update_record`。2表) | **赤(通ってしまう)** |
 * | `(C-2)` | **新しい親に書けない人**の付け替え(`write_records`。2表) | **赤(通ってしまう)** |
 * | `(D-1)` | 古い親を**消せる**人は今日どおり移せる(2道具 × 2表)【退行の担保】 | 緑 |
 * | `(E-1)` | 親の項目を**送らない**更新は今日どおり通る(2道具) | 緑 |
 * | `(E-2)` | 親の項目に**同じ値**を送る更新は今日どおり通る(2道具) | 緑 |
 * | `(E-3)` | 親を**空/null** にする更新は今日どおり(`issues` は通り、必須の `milestones` は断り) | 緑 |
 * | `(E-5)` | **作成の枝**は1ビットも変わらない(通る側・断られる側の両方) | 緑 |
 * | `(F-1)` | 古い親の断り文が **HTTP の口と1文字同じ** | **赤**(断り自体が無い) |
 * | `(F-2)` | 新しい親の断り文も **HTTP の口と1文字同じ** | **赤**(断り自体が無い) |
 * | `(F-3)` | **器の違い**(HTTP は `403` / AI は `isError: true`)を別に書く | **赤** |
 * | `(F-4)` | 断り文に内部記号が1文字も無い | **赤** |
 *
 * ## **対象の表を2本とも撃つ理由(`(d)`。片方だけにしない)**
 *
 * **実地で引き継ぎを宣言しているのは `issues`(親 `projects`)と `milestones`(親
 * `projects`)の2本である。** **題材でも親を持つ表を2本用意し、**両方**を撃つ** ——
 * **1本だけで緑にすると、表ごとに配線が割れていても気づけない。**
 * **`milestones` の参照は `required: true` である** —— **必須の側でも同じ答えになることと、
 * 空にする更新の断りが**必須の断り**のままであることを、同時に見る。**
 *
 * ## **この検査が測っていないもの(誇張しない)**
 *
 *  - **受信口 / 自動処理 / 島 / 時刻起動 の4本を1度も撃っていない** ——
 *    **本葉はその4本に1バイトも掛けない。** **どれも今日も素通りする。**
 *    **【禁止】本ファイルの緑を「更新の穴を塞いだ」と読まない。**
 *  - **参照を**空にする**更新は今日も通る**(`AC-G9` は `V16-M0` で却下。`ADR-0411` 限定10)。
 *    **`(E-3)` はその**通る**ことを固定する検査であって、塞いだ記録ではない。**
 *  - **`delete_record`(行そのものの削除)を1度も変えていない。**
 *  - **本ファイルは HTTP の口も叩くが、叩くのは `(F-1)`〜`(F-3)` の突き合わせだけである** ——
 *    **HTTP 側の振る舞いそのものは `src/server/create-parent-write.test.ts` が撃つ。**
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ValidationError } from "../kernel/index.ts";
import { createServerApp } from "../server/app.ts";
import { seedSession, TEST_ORIGIN } from "../server/test-helpers.ts";
import { createMcpServer } from "./server.ts";

const APP_ID = "reparent-gate";
const PREVIEW_BASE_URL = "http://127.0.0.1:3000";
/** 製品の根(`apps/smailtalk`)。**`src/mcp/…` から2つ上がる。** */
const PRODUCT_ROOT = dirname(dirname(import.meta.dir));

const MEMBERS = "ac_member";
const GRANTS = "ac_grant";
/** 親の表(根)。 */
const PROJECTS = "projects";
/** 子の表その1 —— **参照は必須ではない**(空にする更新を撃つため)。 */
const ISSUES = "issues";
/** 子の表その2 —— **参照は `required: true`**(必須の断りが今日どおりであることを見る)。 */
const MILESTONES = "milestones";

/** 名乗りがあれば通る側(`create_app` は主体を解決しない)。 */
const BOOTSTRAP_ACTOR = "bootstrap";

/**
 * 権限名3つ。**動詞の差だけを残す** ——
 * **`writer` は書けるが**消せない**。`keeper` は消せる。`reader` は読むだけ。**
 */
const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる", read: true, write: true, delete: false },
  { id: "keeper", name: "任せられる", read: true, write: true, delete: true },
];

function declaration(target: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    permissions: PERMISSIONS,
    creator_permission: "writer",
    grant: { table: GRANTS, target, member: "member", permission: "permission" },
    members: { table: MEMBERS, account: "account" },
    ...extra,
  };
}

/** 表5本を足す差分(**親1本・子2本・名簿・付与**)。 */
const setupTables = {
  diff_id: "setup-tables",
  intent: "親1つと、引き継ぎを宣言した子2つを用意する",
  operations: [
    {
      op: "add_table",
      table: {
        id: MEMBERS,
        name: "利用者",
        fields: [{ id: "account", name: "ログイン", type: "text" }],
      },
    },
    {
      op: "add_table",
      table: {
        id: PROJECTS,
        name: "案件",
        fields: [{ id: "title", name: "件名", type: "text", required: true }],
        // **根の表なので「行を作れる立場」を宣言しておく**(`ADR-0432` の既定は閉じている)。
        access_control: declaration("project", { creatable_by_roles: ["owner"] }),
      },
    },
    {
      op: "add_table",
      table: {
        id: ISSUES,
        name: "課題",
        fields: [
          { id: "title", name: "件名", type: "text", required: true },
          { id: "project", name: "案件", type: "reference", reference_table: PROJECTS },
        ],
        access_control: declaration("issue", { inherit_from: ["project"] }),
      },
    },
    {
      op: "add_table",
      table: {
        id: MILESTONES,
        name: "節目",
        fields: [
          { id: "title", name: "件名", type: "text", required: true },
          {
            id: "project",
            name: "案件",
            type: "reference",
            reference_table: PROJECTS,
            required: true,
          },
        ],
        access_control: declaration("milestone", { inherit_from: ["project"] }),
      },
    },
    {
      op: "add_table",
      table: {
        id: GRANTS,
        name: "付与",
        fields: [
          { id: "project", name: "案件", type: "reference", reference_table: PROJECTS },
          { id: "issue", name: "課題", type: "reference", reference_table: ISSUES },
          { id: "milestone", name: "節目", type: "reference", reference_table: MILESTONES },
          { id: "member", name: "相手", type: "reference", reference_table: MEMBERS },
          {
            id: "permission",
            name: "権限",
            type: "select",
            options: ["reader", "writer", "keeper"],
          },
        ],
      },
    },
  ],
};

/**
 * 面(役割の規則)。
 *
 * **点を宣言した3本(`projects` / `issues` / `milestones`)を1本も名指ししない** ——
 * **名指しすると面と点が `OR` で重なり、測りたい壁が丸ごと無効になる。**
 */
const setupRoles = {
  diff_id: "setup-roles",
  intent: "名簿と付与だけを面で開ける",
  operations: [
    {
      op: "set_roles",
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            { target: "table", table: MEMBERS, can: ["read", "write", "delete"] },
            { target: "table", table: GRANTS, can: ["read", "write", "delete"] },
          ],
        },
        {
          id: "editor",
          name: "編集者",
          rules: [
            { target: "table", table: MEMBERS, can: ["read"] },
            { target: "table", table: GRANTS, can: ["read"] },
          ],
        },
        { id: "viewer", name: "閲覧者" },
      ],
    },
  ],
};

let dataRoot = "";
let app: ReturnType<typeof createServerApp>;

/** 表を作り、名簿と付与を配る持ち主。**自分への付与は1件も作らない。** */
let admin: ReturnType<typeof seedSession>;
/** **古い親に `writer` だけを持つ人**(書けるが**消せない**)。新しい親には書ける。 */
let mover: ReturnType<typeof seedSession>;
/** **古い親に `keeper` を持つ人**(消せる)。新しい親にも書ける。 */
let keeper: ReturnType<typeof seedSession>;
/** **古い親は消せるが、新しい親に付与を1件も持たない人。** */
let stuck: ReturnType<typeof seedSession>;

let oldProject = "";
let newProject = "";

async function callTool(
  name: string,
  args: Record<string, unknown>,
  actor: string,
): Promise<CallToolResult> {
  const server = createMcpServer({ dataRoot, previewBaseUrl: PREVIEW_BASE_URL, actor });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

function okData(result: CallToolResult): Record<string, unknown> {
  if (result.isError === true) {
    throw new Error(`ツールが失敗した: ${JSON.stringify(result.structuredContent)}`);
  }
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

/** **断られたか / 通ったか** と **断りの文面**。 */
type Outcome = { denied: boolean; errors: ValidationError[] };

function outcomeOf(result: CallToolResult): Outcome {
  if (result.isError !== true) {
    return { denied: false, errors: [] };
  }
  const structured = result.structuredContent as { errors?: ValidationError[] } | undefined;
  return { denied: true, errors: structured?.errors ?? [] };
}

async function insert(
  table: string,
  rows: Record<string, unknown>[],
  actor: string,
): Promise<Record<string, unknown>[]> {
  const data = okData(
    await callTool("insert_sample_data", { app_id: APP_ID, table_id: table, rows }, actor),
  );
  expect(data.failed).toEqual([]);
  return data.inserted as Record<string, unknown>[];
}

/** 行の `_id` と版(`_updated_at`)。 */
type Row = { id: string; version: string };

function rowOf(record: Record<string, unknown>): Row {
  return { id: String(record._id), version: String(record._updated_at) };
}

/** **古い親の下に子の行を1件作る**(作るのは `keeper` —— 古い親に書けるため)。 */
async function childUnderOldParent(table: string, title: string): Promise<Row> {
  const [created] = await insert(table, [{ title, project: oldProject }], keeper.username);
  return rowOf(created as Record<string, unknown>);
}

/**
 * **ディスクの上で親が何になっているか**(応答だけを見て済ませない)。
 *
 * **読むのは `keeper`** —— **古い親も新しい親も読める唯一の人である**(移った先でも読める)。
 */
async function seenByKeeper(
  table: string,
  recordId: string,
): Promise<Record<string, unknown> | undefined> {
  const data = okData(
    await callTool("list_records", { app_id: APP_ID, table_id: table }, keeper.username),
  );
  return (data.records as Record<string, unknown>[]).find(
    (record) => String(record._id) === recordId,
  );
}

async function storedParent(table: string, recordId: string): Promise<string | null> {
  const found = await seenByKeeper(table, recordId);
  expect(found).toBeDefined();
  const parent = found?.project;
  return parent === undefined || parent === null ? null : String(parent);
}

/** **最新の版を引く**(`if_match` は必須である)。 */
async function versionOf(table: string, recordId: string): Promise<string> {
  const data = okData(
    await callTool("list_records", { app_id: APP_ID, table_id: table }, keeper.username),
  );
  const found = (data.records as Record<string, unknown>[]).find(
    (record) => String(record._id) === recordId,
  );
  return String(found?._updated_at ?? "");
}

/** **道具1: `update_record`**(1件ずつ)。 */
async function updateViaRecord(
  table: string,
  row: Row,
  actor: string,
  changes: Record<string, unknown>,
): Promise<Outcome> {
  return outcomeOf(
    await callTool(
      "update_record",
      {
        app_id: APP_ID,
        table_id: table,
        record_id: row.id,
        if_match: await versionOf(table, row.id),
        changes,
      },
      actor,
    ),
  );
}

/** **道具2: `write_records` の `op: "update"`**(まとめ書き)。 */
async function updateViaWriteRecords(
  table: string,
  row: Row,
  actor: string,
  values: Record<string, unknown>,
): Promise<Outcome> {
  return outcomeOf(
    await callTool(
      "write_records",
      {
        app_id: APP_ID,
        ops: [
          {
            op: "update",
            table,
            target: row.id,
            if_match: await versionOf(table, row.id),
            values,
          },
        ],
      },
      actor,
    ),
  );
}

/**
 * **`app.ts` の断り文の関数は**非 export**なので呼べない。** **源から文字列だけを取り出して
 * 突き合わせる**(`src/mcp/root-create-closed-by-default-mcp.test.ts` の `(F-1)` と同じ作法)。
 */
function literalsFrom(source: string, fnName: string): { message: string; hint: string } {
  const at = source.indexOf(`function ${fnName}(): ValidationError {`);
  expect({ fnName, found: at >= 0 }).toEqual({ fnName, found: true });
  const body = source.slice(at, source.indexOf("\n}", at));
  const message = /message:\s*\n?\s*"((?:[^"\\]|\\.)*)"/.exec(body);
  const hint = /hint:\s*\n?\s*"((?:[^"\\]|\\.)*)"/.exec(body);
  return { message: message?.[1] ?? "", hint: hint?.[1] ?? "" };
}

/** **本物の HTTP の口で同じ付け替えを1回叩く**(`(F)` の突き合わせに使う)。 */
async function patchOverHttp(
  table: string,
  row: Row,
  cookie: string,
  values: Record<string, unknown>,
): Promise<{ status: number; errors: ValidationError[] }> {
  const version = await versionOf(table, row.id);
  const response = await app.request(`/api/apps/${APP_ID}/tables/${table}/records/${row.id}`, {
    method: "PATCH",
    headers: {
      cookie,
      origin: TEST_ORIGIN,
      "content-type": "application/json",
      "if-match": version,
    },
    body: JSON.stringify(values),
  });
  const text = await response.text();
  const parsed = JSON.parse(text) as { errors?: ValidationError[] };
  return { status: response.status, errors: parsed.errors ?? [] };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-reparent-mcp-"));
  okData(await callTool("create_app", { name: "付け替えの関門", app_id: APP_ID }, BOOTSTRAP_ACTOR));

  admin = seedSession(dataRoot, APP_ID, { username: "admin" });
  mover = seedSession(dataRoot, APP_ID, { username: "mover", role: "editor" });
  keeper = seedSession(dataRoot, APP_ID, { username: "keeper", role: "editor" });
  stuck = seedSession(dataRoot, APP_ID, { username: "stuck", role: "editor" });
  app = createServerApp({ dataRoot });

  okData(await callTool("apply_diff", { app_id: APP_ID, diff: setupTables }, admin.username));
  okData(await callTool("apply_diff", { app_id: APP_ID, diff: setupRoles }, admin.username));

  // **名簿(4人とも載せる)** —— **「付与が無い」と「名簿に行が無い」を混ぜないため。**
  const members = await insert(
    MEMBERS,
    [
      { account: admin.userId },
      { account: mover.userId },
      { account: keeper.userId },
      { account: stuck.userId },
    ],
    admin.username,
  );
  const memberIds = members.map((member) => String((member as Record<string, unknown>)._id));
  // **4人ぶん揃っていることを先に見る**(揃っていなければ題材が成立しない)。
  expect(memberIds.length).toBe(4);
  const moverMember = memberIds[1];
  const keeperMember = memberIds[2];
  const stuckMember = memberIds[3];

  const projects = await insert(
    PROJECTS,
    [{ title: "移す前の案件" }, { title: "移す先の案件" }],
    admin.username,
  );
  oldProject = String((projects[0] as Record<string, unknown>)._id);
  newProject = String((projects[1] as Record<string, unknown>)._id);

  // **付与は `admin` が配る**(自分への付与は作らない。`judgeGrantWrite` の `self`)。
  await insert(
    GRANTS,
    [
      // **古い親** —— **`mover` は書けるが消せない。`keeper` と `stuck` は消せる。**
      { project: oldProject, member: moverMember, permission: "writer" },
      { project: oldProject, member: keeperMember, permission: "keeper" },
      { project: oldProject, member: stuckMember, permission: "keeper" },
      // **新しい親** —— **`stuck` にだけ1件も配らない**(止まる理由を割るため)。
      { project: newProject, member: moverMember, permission: "writer" },
      { project: newProject, member: keeperMember, permission: "writer" },
    ],
    admin.username,
  );
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (A) `update_record` —— **古い親を消せない人は、行を別の親へ移せない**
// ---------------------------------------------------------------------------

describe("V18-M6-T02 (A): AI の口の `update_record` にも親の関門が掛かる", () => {
  test("(A-1) 古い親を消せない人は `issues` を別の親へ移せない", async () => {
    const row = await childUnderOldParent(ISSUES, "移そうとする課題");
    const out = await updateViaRecord(ISSUES, row, mover.username, { project: newProject });
    expect(out.denied).toBe(true);
    // **ディスクの上でも1文字も動いていない。**
    expect(await storedParent(ISSUES, row.id)).toBe(oldProject);
  });

  test("(A-2) 古い親を消せない人は `milestones` も別の親へ移せない(2本目の表)", async () => {
    const row = await childUnderOldParent(MILESTONES, "移そうとする節目");
    const out = await updateViaRecord(MILESTONES, row, mover.username, { project: newProject });
    expect(out.denied).toBe(true);
    expect(await storedParent(MILESTONES, row.id)).toBe(oldProject);
  });
});

// ---------------------------------------------------------------------------
// (B) `write_records` の `update` op —— **まとめ書きでも同じ壁**
// ---------------------------------------------------------------------------

describe("V18-M6-T02 (B): まとめ書きの `update` op にも同じ関門が掛かる", () => {
  test("(B-1) 古い親を消せない人は `issues` をまとめ書きでも移せない", async () => {
    const row = await childUnderOldParent(ISSUES, "まとめ書きで移そうとする課題");
    const out = await updateViaWriteRecords(ISSUES, row, mover.username, { project: newProject });
    expect(out.denied).toBe(true);
    expect(await storedParent(ISSUES, row.id)).toBe(oldProject);
  });

  test("(B-2) 古い親を消せない人は `milestones` もまとめ書きで移せない(2本目の表)", async () => {
    const row = await childUnderOldParent(MILESTONES, "まとめ書きで移そうとする節目");
    const out = await updateViaWriteRecords(MILESTONES, row, mover.username, {
      project: newProject,
    });
    expect(out.denied).toBe(true);
    expect(await storedParent(MILESTONES, row.id)).toBe(oldProject);
  });
});

// ---------------------------------------------------------------------------
// (C) **新しい親に書けない人** —— **今日 HTTP だけが 403 で、AI が素通りしていた形**
// ---------------------------------------------------------------------------

describe("V18-M6-T02 (C): 新しい親に書けない人も、AI の口から付け替えられない", () => {
  test("(C-1) `update_record` —— 2表とも断られる", async () => {
    const issue = await childUnderOldParent(ISSUES, "行き先に書けない課題");
    const milestone = await childUnderOldParent(MILESTONES, "行き先に書けない節目");
    const onIssue = await updateViaRecord(ISSUES, issue, stuck.username, { project: newProject });
    const onMilestone = await updateViaRecord(MILESTONES, milestone, stuck.username, {
      project: newProject,
    });
    expect({ issue: onIssue.denied, milestone: onMilestone.denied }).toEqual({
      issue: true,
      milestone: true,
    });
    expect(await storedParent(ISSUES, issue.id)).toBe(oldProject);
    expect(await storedParent(MILESTONES, milestone.id)).toBe(oldProject);
  });

  test("(C-2) `write_records` の `update` op —— 2表とも断られる", async () => {
    const issue = await childUnderOldParent(ISSUES, "まとめ書きで行き先に書けない課題");
    const milestone = await childUnderOldParent(MILESTONES, "まとめ書きで行き先に書けない節目");
    const onIssue = await updateViaWriteRecords(ISSUES, issue, stuck.username, {
      project: newProject,
    });
    const onMilestone = await updateViaWriteRecords(MILESTONES, milestone, stuck.username, {
      project: newProject,
    });
    expect({ issue: onIssue.denied, milestone: onMilestone.denied }).toEqual({
      issue: true,
      milestone: true,
    });
    expect(await storedParent(ISSUES, issue.id)).toBe(oldProject);
    expect(await storedParent(MILESTONES, milestone.id)).toBe(oldProject);
  });
});

// ---------------------------------------------------------------------------
// (D) **退行の担保** —— **古い親を消せる人は今日どおり移せる**
// ---------------------------------------------------------------------------

describe("V18-M6-T02 (D): 古い親を消せる人は、2道具 × 2表のどれでも今日どおり移せる", () => {
  test("(D-1) `update_record` / `write_records` の両方で、2表とも移せる", async () => {
    const issueA = await childUnderOldParent(ISSUES, "消せる人が移す課題");
    const issueB = await childUnderOldParent(ISSUES, "消せる人がまとめ書きで移す課題");
    const milestoneA = await childUnderOldParent(MILESTONES, "消せる人が移す節目");
    const milestoneB = await childUnderOldParent(MILESTONES, "消せる人がまとめ書きで移す節目");

    const results = {
      issueSingle: (await updateViaRecord(ISSUES, issueA, keeper.username, { project: newProject }))
        .denied,
      issueBatch: (
        await updateViaWriteRecords(ISSUES, issueB, keeper.username, { project: newProject })
      ).denied,
      milestoneSingle: (
        await updateViaRecord(MILESTONES, milestoneA, keeper.username, { project: newProject })
      ).denied,
      milestoneBatch: (
        await updateViaWriteRecords(MILESTONES, milestoneB, keeper.username, {
          project: newProject,
        })
      ).denied,
    };
    expect(results).toEqual({
      issueSingle: false,
      issueBatch: false,
      milestoneSingle: false,
      milestoneBatch: false,
    });
    // **ディスクの上で4件とも移っている。**
    expect(await storedParent(ISSUES, issueA.id)).toBe(newProject);
    expect(await storedParent(ISSUES, issueB.id)).toBe(newProject);
    expect(await storedParent(MILESTONES, milestoneA.id)).toBe(newProject);
    expect(await storedParent(MILESTONES, milestoneB.id)).toBe(newProject);
  });
});

// ---------------------------------------------------------------------------
// (E) **壊してはいけないもの**(`T00b` の実測。1件も動かさない)
// ---------------------------------------------------------------------------

describe("V18-M6-T02 (E): 壊してはいけない5件が1件も動いていない", () => {
  test("(E-1) 親の項目を**送らない**更新は、2道具とも今日どおり通る", async () => {
    const issue = await childUnderOldParent(ISSUES, "件名だけ直す課題");
    const milestone = await childUnderOldParent(MILESTONES, "件名だけ直す節目");
    const single = await updateViaRecord(ISSUES, issue, mover.username, { title: "直した件名" });
    const batch = await updateViaWriteRecords(MILESTONES, milestone, mover.username, {
      title: "直した件名",
    });
    expect({ single: single.denied, batch: batch.denied }).toEqual({
      single: false,
      batch: false,
    });
    expect(await storedParent(ISSUES, issue.id)).toBe(oldProject);
    expect(await storedParent(MILESTONES, milestone.id)).toBe(oldProject);
  });

  test("(E-2) 親の項目に**同じ値**を送る更新は、2道具とも今日どおり通る【最もきわどい形】", async () => {
    // **撃っている `mover` は古い親に `write` しか持たず `delete` を持たない。**
    // **「送られた親に `delete` を要求する」実装にすると、この2本が断りに落ちる。**
    // **画面は行を読んでそのまま書き戻すので、落とすと行が誰にも更新できなくなる。**
    const issue = await childUnderOldParent(ISSUES, "同じ親を送り直す課題");
    const milestone = await childUnderOldParent(MILESTONES, "同じ親を送り直す節目");
    const single = await updateViaRecord(ISSUES, issue, mover.username, {
      title: "送り直し",
      project: oldProject,
    });
    const batch = await updateViaWriteRecords(MILESTONES, milestone, mover.username, {
      title: "送り直し",
      project: oldProject,
    });
    expect({ single: single.denied, batch: batch.denied }).toEqual({
      single: false,
      batch: false,
    });
    expect(await storedParent(ISSUES, issue.id)).toBe(oldProject);
    expect(await storedParent(MILESTONES, milestone.id)).toBe(oldProject);
  });

  test("(E-3) 親を**空/null** にする更新は今日どおり(`issues` は通り、必須の `milestones` は必須の断り)", async () => {
    const issue = await childUnderOldParent(ISSUES, "親を外す課題");
    const milestone = await childUnderOldParent(MILESTONES, "親を外せない節目");
    const emptied = await updateViaRecord(ISSUES, issue, mover.username, { project: null });
    const refused = await updateViaRecord(MILESTONES, milestone, mover.username, { project: null });
    expect({ emptied: emptied.denied, refused: refused.denied }).toEqual({
      emptied: false,
      refused: true,
    });
    // **断りは**必須**の断りのままである**(親の関門の断りに化けていない)。
    expect(refused.errors.map((error) => error.message).join("\n")).toContain(
      'フィールド "project" は必須です。値を指定してください。',
    );
    // **【禁止】この緑を「持ち出しを塞いだ」と読まない** —— **`AC-G9` は却下されている。**
    // **【正直に。空にした行はどうなるか】** —— **親を外した行は、引き継ぐ先が1つも無く
    // なるので、古い親を消せる人(`keeper`)の一覧にも1件も返らなくなる。**
    // **壁の内側から抜き出す道が今日も開いていることは、これで変わらない**
    // (**行は残っており、消えてもいない**)。
    expect(await seenByKeeper(ISSUES, issue.id)).toBeUndefined();
    expect(await storedParent(MILESTONES, milestone.id)).toBe(oldProject);
  });

  test("(E-5) **作成の枝**が1ビットも変わっていない(通る側と断られる側の両方)", async () => {
    // **通る側** —— **親に書ける人は今日どおり2表とも作れる。**
    const madeIssue = outcomeOf(
      await callTool(
        "write_records",
        {
          app_id: APP_ID,
          ops: [
            { op: "create", table: ISSUES, values: { title: "作れる課題", project: oldProject } },
          ],
        },
        mover.username,
      ),
    );
    const madeMilestone = outcomeOf(
      await callTool(
        "insert_sample_data",
        {
          app_id: APP_ID,
          table_id: MILESTONES,
          rows: [{ title: "作れる節目", project: oldProject }],
        },
        mover.username,
      ),
    );
    // **断られる側** —— **親に付与を1件も持たない人は今日どおり作れない。**
    const blocked = outcomeOf(
      await callTool(
        "write_records",
        {
          app_id: APP_ID,
          ops: [
            { op: "create", table: ISSUES, values: { title: "作れない課題", project: newProject } },
          ],
        },
        stuck.username,
      ),
    );
    expect({
      issue: madeIssue.denied,
      milestone: madeMilestone.denied,
      blocked: blocked.denied,
    }).toEqual({ issue: false, milestone: false, blocked: true });
  });
});

// ---------------------------------------------------------------------------
// (F) **2つの口の断り文** —— **HTTP と AI で1文字も違わない。器だけが違う**
// ---------------------------------------------------------------------------

describe("V18-M6-T02 (F): HTTP の口と AI の口で、断りの文面が1文字も同じである", () => {
  test("(F-1) 古い親で止まった文面が、HTTP の口と1文字も同じ", async () => {
    const httpSource = await Bun.file(join(PRODUCT_ROOT, "src", "server", "app.ts")).text();
    const expected = literalsFrom(httpSource, "forbiddenPreviousParentAccessError");
    expect(expected.message.length).toBeGreaterThan(0);
    expect(expected.hint.length).toBeGreaterThan(0);

    const issue = await childUnderOldParent(ISSUES, "文面を測る課題");
    const single = await updateViaRecord(ISSUES, issue, mover.username, { project: newProject });
    const milestone = await childUnderOldParent(MILESTONES, "文面を測る節目");
    const batch = await updateViaWriteRecords(MILESTONES, milestone, mover.username, {
      project: newProject,
    });
    expect(single.errors).toEqual([{ path: "", message: expected.message, hint: expected.hint }]);
    // **道具ごとに文面を割らない。**
    expect(batch.errors).toEqual(single.errors);

    // **本物の HTTP の口でも同じ文面である**(源の写しだけで済ませない)。
    const overHttp = await patchOverHttp(ISSUES, issue, mover.cookie, { project: newProject });
    expect(overHttp.errors).toEqual(single.errors);
  });

  test("(F-2) 新しい親で止まった文面も、HTTP の口と1文字も同じ", async () => {
    const httpSource = await Bun.file(join(PRODUCT_ROOT, "src", "server", "app.ts")).text();
    const expected = literalsFrom(httpSource, "forbiddenCreateParentAccessError");
    expect(expected.message.length).toBeGreaterThan(0);

    const issue = await childUnderOldParent(ISSUES, "行き先の文面を測る課題");
    const single = await updateViaRecord(ISSUES, issue, stuck.username, { project: newProject });
    expect(single.errors).toEqual([{ path: "", message: expected.message, hint: expected.hint }]);
    const overHttp = await patchOverHttp(ISSUES, issue, stuck.cookie, { project: newProject });
    expect(overHttp.errors).toEqual(single.errors);
  });

  test("(F-3) 器は違う —— HTTP は `403` を返し、AI の口は `isError: true` を返す", async () => {
    // **【禁止】「1ビットも違わない」と書かない** —— **同じなのは**文面**だけである。**
    // **AI の口に数値の応答コードは無く、HTTP の応答に `isError` は無い。**
    const issue = await childUnderOldParent(ISSUES, "器の違いを測る課題");
    const overHttp = await patchOverHttp(ISSUES, issue, mover.cookie, { project: newProject });
    expect(overHttp.status).toBe(403);

    const raw = await callTool(
      "update_record",
      {
        app_id: APP_ID,
        table_id: ISSUES,
        record_id: issue.id,
        if_match: await versionOf(ISSUES, issue.id),
        changes: { project: newProject },
      },
      mover.username,
    );
    expect(raw.isError).toBe(true);
    expect(JSON.stringify(raw.structuredContent)).not.toContain("403");
  });

  test("(F-4) 断り文に内部記号が1文字も漏れていない", async () => {
    const issue = await childUnderOldParent(ISSUES, "記号を測る課題");
    const out = await updateViaRecord(ISSUES, issue, mover.username, { project: newProject });
    expect(out.denied).toBe(true);
    const text = JSON.stringify(out.errors);
    for (const symbol of [
      "access_control",
      "inherit_from",
      "creatable_by",
      "judgeCreateParentAccess",
      "denied_previous_parent",
      ISSUES,
      PROJECTS,
    ]) {
      expect({ symbol, leaked: text.includes(symbol) }).toEqual({ symbol, leaked: false });
    }
  });
});
