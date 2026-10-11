/**
 * **MCP の作成でも、作成者に付与を書く**(`V23-M2-T06`。上位:
 * `docs/adr/0498-unique-message-reject-and-atomic-creator-grant.md`、
 * `docs/adr/0517-v23-m2-guard-authorization-and-conditional-rows.md` §Decision 7・§Decision 9 の行40〜42、
 * 決定 `D-V23-13`・`D-V23-48`・`D-V23-58`、
 * 計画 `docs/plan/v23/00-v23-plan.md` §17 の例外3・§21-2 の T06・§21-4 の「T06 に足す」)。
 *
 * **見ること**:
 * - `write_records` の作成で作成者への付与が書かれ、名乗った本人が作った行を `list_records` で読める。
 * - `insert_sample_data` も同じ。 付与が落ちた行だけが `failed` に入り、他の行は残る
 *   (`failed[].errors` の形は今日のまま = 付与表の検査の失敗そのもの)。
 * - 付与表の一意違反は、宣言した文言が返る(`write_records` は1件も書かない)。
 * - MCP の作成で、付与表の `on_create` が新しく発火する。
 * - **陽性対照と陰性対照(全アプリの例外3)**: `access_control` を宣言しない表(`creator_permission`
 *   も無い)に作っても付与は0件。 `access_control` を宣言しないアプリでは、2道具の結果が今日と同じ。
 *
 * **今日(実装前)の姿**: MCP の作成は作成者に付与を1件も書かない(`V23-M0-T01` の実測 (c))。
 * **この題材は、`access_control` を宣言した表を役割の規則から名指ししない**(名指しすると面と点が
 * `OR` で重なり、付与が無くても読めてしまう。`actor-authz.test.ts` の冒頭と同じ理由)。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
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
} from "../kernel/index.ts";
import { ensureIslandRuntimeReady } from "../kernel/island-runner.ts";
import { seedSession } from "../server/test-helpers.ts";
import { createMcpServer } from "./server.ts";

const APP_ID = "mcp-grant";
const PLAIN_APP_ID = "mcp-plain";

/** 付与表の `member` に書く文言(作者の固定文)。 */
const MSG_MEMBER = "あなたは既に別の組織に所属しています";

const ALL = ["read", "write", "delete"];

const PERMISSIONS = [
  { id: "p_owner", name: "持ち主", read: true, write: true, delete: true },
  { id: "p_member", name: "仲間", read: true, write: false, delete: false },
];

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

const GRANT_TABLES = ["orgs_members", "teams_members", "clubs_members"];

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "MCP の作成者への付与",
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
        grantTable("orgs_members", "orgs", { unique: true, unique_message: MSG_MEMBER }),
        scopedTable("teams", "チーム"),
        grantTable("teams_members", "teams"),
        scopedTable("clubs", "部"),
        grantTable("clubs_members", "clubs"),
        {
          id: "needy",
          name: "必須のある表",
          fields: [{ id: "must", name: "必須", type: "text", required: true }],
        },
        { id: "grant_log", name: "付与の記録", fields: [{ id: "v", name: "値", type: "text" }] },
        {
          id: "wf_log",
          name: "実行履歴",
          fields: [
            { id: "ran_at", name: "実行時刻", type: "date" },
            { id: "workflow", name: "ワークフロー", type: "text" },
            { id: "trigger_type", name: "きっかけ", type: "text" },
            { id: "status", name: "結果", type: "text" },
            { id: "error", name: "エラー", type: "long_text" },
          ],
        },
        // **`access_control` を宣言しない表**(`creator_permission` も無い)。
        { id: "notes", name: "覚え書き", fields: [{ id: "v", name: "値", type: "text" }] },
        // 【`V23-M2-T11` / `D-V23-75`】一意の列を持つ表(書込の前に一意の照会の読みが走る)。
        {
          id: "codes",
          name: "番号",
          fields: [{ id: "code", name: "番号", type: "text", unique: true }],
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
            { target: "table", table: "notes", can: ALL },
            { target: "table", table: "codes", can: ALL },
          ],
        },
        {
          id: "staff",
          name: "担当者",
          rules: [{ target: "table", table: "notes", can: ALL }],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
      workflows: [
        {
          id: "wf_team_log",
          name: "チームの付与を記録する",
          trigger: { type: "on_create", table: "teams_members" },
          history_table: "wf_log",
          actions: [{ action: "create_record", table: "grant_log", values: { v: "fired" } }],
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

type Rig = {
  dataRoot: string;
  /** 名簿の行の `_id`。 */
  member: { carol: string; dave: string };
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
  const dataRoot = await mkdtemp(join(tmpdir(), "gp-mcp-creator-grant-"));
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

/** carol は組織A に所属済み、dave はどこにも所属していない(どちらも `staff`)。 */
async function makeRig(): Promise<Rig> {
  const m = manifest();
  const dataRoot = await freshApp(APP_ID, m);
  seedSession(dataRoot, APP_ID, { role: "owner", username: "owner1" });
  const carol = seedSession(dataRoot, APP_ID, { role: "staff", username: "carol" });
  const dave = seedSession(dataRoot, APP_ID, { role: "staff", username: "dave" });
  const db = openDb(dataRoot, APP_ID);
  try {
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
    return { dataRoot, member: { carol: carolMember, dave: daveMember } };
  } finally {
    db.close();
  }
}

async function call(
  dataRoot: string,
  actor: string,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const server = createMcpServer({ dataRoot, previewBaseUrl: "http://localhost:3000", actor });
  const client = new Client({ name: "t06", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  try {
    // **線の上の形で比べる**(実際の接続は JSON で運ぶ。 同じプロセスの中の接続は物を
    // そのまま渡すので、直列化されない印まで見えてしまう)。
    return JSON.parse(
      JSON.stringify(await client.callTool({ name, arguments: args })),
    ) as CallToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

function okData(result: CallToolResult): Record<string, unknown> {
  if (result.isError === true) {
    throw new Error(`道具が失敗した: ${JSON.stringify(result.structuredContent)}`);
  }
  return result.structuredContent as Record<string, unknown>;
}

function rowsOf(dataRoot: string, appId: string, table: string): Record<string, unknown>[] {
  const db = openDb(dataRoot, appId);
  try {
    return db.query<Record<string, unknown>, []>(`SELECT * FROM "${table}" ORDER BY rowid`).all();
  } finally {
    db.close();
  }
}

function grantsFor(rig: Rig, table: string, target: string): Record<string, unknown>[] {
  return rowsOf(rig.dataRoot, APP_ID, table)
    .filter((row) => row.org === target)
    .map((row) => ({ member: row.member, permission: row.permission }));
}

async function listedIds(dataRoot: string, actor: string, table: string): Promise<string[]> {
  const data = okData(
    await call(dataRoot, actor, "list_records", { app_id: APP_ID, table_id: table }),
  );
  return ((data.records ?? []) as Record<string, unknown>[]).map((row) => String(row._id));
}

describe("V23-M2-T06 write_records の作成で作成者に付与する", () => {
  test("(w-grant) 付与が1件書かれ、名乗った本人が作った行を list_records で読める", async () => {
    const rig = await makeRig();
    const data = okData(
      await call(rig.dataRoot, "dave", "write_records", {
        app_id: APP_ID,
        ops: [{ op: "create", table: "orgs", values: { name: "組織D" } }],
      }),
    );
    const id = String((data.records as Record<string, unknown>[])[0]?._id);
    expect(grantsFor(rig, "orgs_members", id)).toEqual([
      { member: rig.member.dave, permission: "p_owner" },
    ]);
    expect(await listedIds(rig.dataRoot, "dave", "orgs")).toEqual([id]);
  });

  test("(w-unique) 付与表の一意違反は宣言した文言が返り、1件も書かない", async () => {
    const rig = await makeRig();
    const result = await call(rig.dataRoot, "carol", "write_records", {
      app_id: APP_ID,
      ops: [
        { op: "create", table: "notes", values: { v: "先に書く行" } },
        { op: "create", table: "orgs", values: { name: "組織B" } },
      ],
    });
    expect(result.isError).toBe(true);
    expect(
      (result.structuredContent as { errors: { path: string; message: string }[] }).errors,
    ).toEqual([{ path: "/member", message: MSG_MEMBER }]);
    expect(rowsOf(rig.dataRoot, APP_ID, "notes")).toHaveLength(0);
    expect(rowsOf(rig.dataRoot, APP_ID, "orgs").map((row) => row.name)).toEqual(["組織A"]);
    expect(rowsOf(rig.dataRoot, APP_ID, "orgs_members")).toHaveLength(1);
  });

  test("(w-fire) MCP の作成で、付与表の on_create が新しく発火する", async () => {
    const rig = await makeRig();
    okData(
      await call(rig.dataRoot, "dave", "write_records", {
        app_id: APP_ID,
        ops: [{ op: "create", table: "teams", values: { name: "チーム1" } }],
      }),
    );
    expect(rowsOf(rig.dataRoot, APP_ID, "grant_log").map((row) => row.v)).toEqual(["fired"]);
  });
});

describe("V23-M2-T06 insert_sample_data の作成で作成者に付与する", () => {
  test("(s-grant) 付与が1件書かれ、名乗った本人が作った行を list_records で読める", async () => {
    const rig = await makeRig();
    const data = okData(
      await call(rig.dataRoot, "dave", "insert_sample_data", {
        app_id: APP_ID,
        table_id: "teams",
        rows: [{ name: "チーム1" }, { name: "チーム2" }],
      }),
    );
    expect(data.failed).toEqual([]);
    const ids = (data.inserted as Record<string, unknown>[]).map((row) => String(row._id));
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      expect(grantsFor(rig, "teams_members", id)).toEqual([
        { member: rig.member.dave, permission: "p_owner" },
      ]);
    }
    expect((await listedIds(rig.dataRoot, "dave", "teams")).sort()).toEqual([...ids].sort());
  });

  test("(s-partial) 付与が落ちた行だけ failed に入り(errors は付与表の失敗そのもの)、他の行は残る", async () => {
    const rig = await makeRig();
    const data = okData(
      await call(rig.dataRoot, "dave", "insert_sample_data", {
        app_id: APP_ID,
        table_id: "orgs",
        rows: [{ name: "組織S1" }, { name: "組織S2" }],
      }),
    );
    expect(data.failed).toEqual([{ index: 1, errors: [{ path: "/member", message: MSG_MEMBER }] }]);
    const inserted = data.inserted as Record<string, unknown>[];
    expect(inserted.map((row) => row.name)).toEqual(["組織S1"]);
    expect(rowsOf(rig.dataRoot, APP_ID, "orgs").map((row) => row.name)).toEqual([
      "組織A",
      "組織S1",
    ]);
    expect(grantsFor(rig, "orgs_members", String(inserted[0]?._id))).toEqual([
      { member: rig.member.dave, permission: "p_owner" },
    ]);
  });

  test("(s-unique) 所属済みの人: 文言が failed に入り、行は無い", async () => {
    const rig = await makeRig();
    const data = okData(
      await call(rig.dataRoot, "carol", "insert_sample_data", {
        app_id: APP_ID,
        table_id: "orgs",
        rows: [{ name: "組織B" }],
      }),
    );
    expect(data.inserted).toEqual([]);
    expect(data.failed).toEqual([{ index: 0, errors: [{ path: "/member", message: MSG_MEMBER }] }]);
    expect(rowsOf(rig.dataRoot, APP_ID, "orgs").map((row) => row.name)).toEqual(["組織A"]);
  });

  test("(s-fire) insert_sample_data でも、付与表の on_create が新しく発火する", async () => {
    const rig = await makeRig();
    okData(
      await call(rig.dataRoot, "dave", "insert_sample_data", {
        app_id: APP_ID,
        table_id: "teams",
        rows: [{ name: "チーム1" }],
      }),
    );
    expect(rowsOf(rig.dataRoot, APP_ID, "grant_log").map((row) => row.v)).toEqual(["fired"]);
  });
});

describe("V23-M2-T06 付与表の on_create の失敗の履歴(D-V23-55)", () => {
  function clubHistory(rig: Rig): Record<string, unknown>[] {
    return rowsOf(rig.dataRoot, APP_ID, "wf_log").filter((row) => row.workflow === "wf_club_fail");
  }

  test("(h-write) write_records: isError・行は無い・失敗の履歴は巻き戻しの後も残る", async () => {
    const rig = await makeRig();
    const result = await call(rig.dataRoot, "dave", "write_records", {
      app_id: APP_ID,
      ops: [{ op: "create", table: "clubs", values: { name: "部1" } }],
    });
    expect(result.isError).toBe(true);
    expect(rowsOf(rig.dataRoot, APP_ID, "clubs")).toHaveLength(0);
    expect(rowsOf(rig.dataRoot, APP_ID, "clubs_members")).toHaveLength(0);
    const history = clubHistory(rig);
    expect(history).toHaveLength(1);
    expect(history[0]?.status).toBe("failure");
  });

  test("(h-sample) insert_sample_data: その行だけ failed・失敗の履歴は巻き戻しの後も残る", async () => {
    const rig = await makeRig();
    const data = okData(
      await call(rig.dataRoot, "dave", "insert_sample_data", {
        app_id: APP_ID,
        table_id: "clubs",
        rows: [{ name: "部1" }],
      }),
    );
    expect(data.inserted).toEqual([]);
    expect((data.failed as { index: number }[]).map((entry) => entry.index)).toEqual([0]);
    expect(rowsOf(rig.dataRoot, APP_ID, "clubs")).toHaveLength(0);
    const history = clubHistory(rig);
    expect(history).toHaveLength(1);
    expect(history[0]?.status).toBe("failure");
  });
});

describe("V23-M2-T06 access_control を宣言しない表とアプリ(全アプリの例外3 の陽性対照と陰性対照)", () => {
  test("(n-table) creator_permission の無い表に作っても付与は0件(2道具とも)", async () => {
    const rig = await makeRig();
    const before = GRANT_TABLES.map((table) => rowsOf(rig.dataRoot, APP_ID, table).length);
    okData(
      await call(rig.dataRoot, "dave", "write_records", {
        app_id: APP_ID,
        ops: [{ op: "create", table: "notes", values: { v: "一" } }],
      }),
    );
    okData(
      await call(rig.dataRoot, "dave", "insert_sample_data", {
        app_id: APP_ID,
        table_id: "notes",
        rows: [{ v: "二" }],
      }),
    );
    expect(rowsOf(rig.dataRoot, APP_ID, "notes").map((row) => row.v)).toEqual(["一", "二"]);
    expect(GRANT_TABLES.map((table) => rowsOf(rig.dataRoot, APP_ID, table).length)).toEqual(before);
  });

  test("(n-app) access_control を宣言しないアプリ: write_records と insert_sample_data の結果が今日と同じ", async () => {
    const dataRoot = await freshApp(PLAIN_APP_ID, plainManifest());
    seedSession(dataRoot, PLAIN_APP_ID, { role: "owner", username: "owner1" });
    const written = await call(dataRoot, "owner1", "write_records", {
      app_id: PLAIN_APP_ID,
      ops: [
        { op: "create", table: "notes", values: { v: "一" } },
        { op: "create", table: "notes", values: { v: "二" } },
      ],
    });
    const writtenData = okData(written);
    expect(Object.keys(writtenData)).toEqual(["records"]);
    const records = writtenData.records as Record<string, unknown>[];
    expect(records.map((row) => row.v)).toEqual(["一", "二"]);
    expect(Object.keys(records[0] ?? {}).sort()).toEqual([
      "_created_at",
      "_id",
      "_updated_at",
      "v",
    ]);
    const sample = okData(
      await call(dataRoot, "owner1", "insert_sample_data", {
        app_id: PLAIN_APP_ID,
        table_id: "notes",
        rows: [{ v: "三" }, { nope: "無い列" }],
      }),
    );
    expect(Object.keys(sample)).toEqual(["inserted", "failed"]);
    expect((sample.inserted as Record<string, unknown>[]).map((row) => row.v)).toEqual(["三"]);
    const failed = sample.failed as { index: number; errors: { path: string }[] }[];
    expect(failed.map((entry) => entry.index)).toEqual([1]);
    expect(failed[0]?.errors.map((error) => error.path)).toEqual(["/nope"]);
    expect(rowsOf(dataRoot, PLAIN_APP_ID, "notes").map((row) => row.v)).toEqual(["一", "二", "三"]);
    const refused = await call(dataRoot, "owner1", "write_records", {
      app_id: PLAIN_APP_ID,
      ops: [
        { op: "create", table: "notes", values: { v: "四" } },
        { op: "create", table: "notes", values: { nope: "無い列" } },
      ],
    });
    expect(refused.isError).toBe(true);
    expect(rowsOf(dataRoot, PLAIN_APP_ID, "notes")).toHaveLength(3);
  });
});

// =============================================================================================
// 【`V23-M2-T11` / `D-V23-75`】insert_sample_data の行ごとの器は IMMEDIATE。 別の接続が書込中なら、
// 器の始まりで待つ(M2 前と同じ)。 待ちの上限を過ぎたら、その行が M2 前と同じ形(`path` が空の
// 順番待ちの断り)で `failed` に入る。 deferred の器では、一意の照会の読みの後の昇格が待たずに断られた。
// =============================================================================================
describe("V23-M2-T11 insert_sample_data は書込中の別の接続を待つ(D-V23-75)", () => {
  const BUSY_MESSAGE =
    "いま同じアプリへ別の書き込みが進行中のため、この操作は成立しませんでした(1バイトも書き込まれていません)。";

  test("(b-wait) 一意の列の表: 書込中は待ちの上限まで待ってから、M2 前と同じ形の断りが failed に入る", async () => {
    const rig = await makeRig();
    const holder = openDb(rig.dataRoot, APP_ID);
    holder.exec("BEGIN IMMEDIATE");
    let data: Record<string, unknown>;
    const started = performance.now();
    try {
      data = okData(
        await call(rig.dataRoot, "owner1", "insert_sample_data", {
          app_id: APP_ID,
          table_id: "codes",
          rows: [{ code: "A-1" }],
        }),
      );
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    const elapsed = performance.now() - started;
    // deferred の器では 数ms で断られた(待たない)。 IMMEDIATE は待ちの上限まで待つ。
    expect(elapsed).toBeGreaterThanOrEqual(1000);
    expect(data.inserted).toEqual([]);
    const failed = data.failed as { index: number; errors: { path: string; message: string }[] }[];
    expect(failed.map((entry) => entry.index)).toEqual([0]);
    expect(failed[0]?.errors.map((error) => [error.path, error.message])).toEqual([
      ["", BUSY_MESSAGE],
    ]);
    expect(rowsOf(rig.dataRoot, APP_ID, "codes")).toHaveLength(0);
  }, 30000);

  test("(b-free) 陰性対照: 書込中でなければ待たずに書け、重複は今日の形(path は項目)で failed に入る", async () => {
    const rig = await makeRig();
    const data = okData(
      await call(rig.dataRoot, "owner1", "insert_sample_data", {
        app_id: APP_ID,
        table_id: "codes",
        rows: [{ code: "A-1" }, { code: "A-1" }],
      }),
    );
    expect((data.inserted as Record<string, unknown>[]).map((row) => row.code)).toEqual(["A-1"]);
    const failed = data.failed as { index: number; errors: { path: string }[] }[];
    expect(failed.map((entry) => entry.index)).toEqual([1]);
    expect(failed[0]?.errors.map((error) => error.path)).toEqual(["/code"]);
  });
});

// --- 【V23-M10-T01d】独立点検の指摘(中3)の処置 ---------------------------------------------
//
// 作成者への付与を作成の自動処理より先に書く並び(D-V23-300)を、MCP の2入口でも検査で押さえる。
// 題材は src/server/automation-access-control.test.ts の「作成の自動処理が付与の表を読むと、
// 作った人の付与が1件見える」と同じ(teams を作ると、作成の自動処理の関数が付与の表から
// その行の付与を数えて seen_log に書く)。

const SEEN_APP_ID = "mcp-seen";

function seenManifest(): Manifest {
  return {
    app: {
      id: SEEN_APP_ID,
      name: "作成の自動処理が付与を数える",
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
        scopedTable("teams", "チーム"),
        grantTable("teams_members", "teams"),
        { id: "seen_log", name: "見えた件数", fields: [{ id: "n", name: "件数", type: "text" }] },
        {
          id: "wf_log",
          name: "実行履歴",
          fields: [
            { id: "ran_at", name: "実行時刻", type: "date" },
            { id: "workflow", name: "ワークフロー", type: "text" },
            { id: "trigger_type", name: "きっかけ", type: "text" },
            { id: "status", name: "結果", type: "text" },
            { id: "error", name: "エラー", type: "long_text" },
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
          ],
        },
        {
          id: "staff",
          name: "担当者",
          rules: [{ target: "table", table: "seen_log", can: ALL }],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
      functions: [
        {
          id: "seen_grants",
          name: "作成の自動処理が見た付与の件数",
          code: 'export default function (input) { const rows = Array.isArray(input) ? input : []; return [{ op: "create", table: "seen_log", values: { n: String(rows.length) } }]; }',
          input: { source: "table", table: "teams_members", via: "org" },
          output: { ops: true },
        },
      ],
      workflows: [
        {
          id: "wf_seen",
          name: "作成の自動処理が付与を数える",
          trigger: { type: "on_create", table: "teams" },
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "seen_grants", write_ops: true }],
        },
      ],
    },
  } as unknown as Manifest;
}

async function makeSeenRig(): Promise<string> {
  const m = seenManifest();
  const dataRoot = await freshApp(SEEN_APP_ID, m);
  seedSession(dataRoot, SEEN_APP_ID, { role: "owner", username: "owner1" });
  const dave = seedSession(dataRoot, SEEN_APP_ID, { role: "staff", username: "dave" });
  const db = openDb(dataRoot, SEEN_APP_ID);
  try {
    mustKernelCreate(db, m, "members", { name: "でいぶ", account: dave.userId });
  } finally {
    db.close();
  }
  return dataRoot;
}

describe("V23-M10-T01d 作成の自動処理から作った人の付与が見える(MCP の2入口)", () => {
  test("D-V23-300・D-V23-308: write_records の作成で、作成の自動処理が付与の表を読むと作った人の付与が1件見える", async () => {
    const dataRoot = await makeSeenRig();
    okData(
      await call(dataRoot, "dave", "write_records", {
        app_id: SEEN_APP_ID,
        ops: [{ op: "create", table: "teams", values: { name: "チームW" } }],
      }),
    );
    expect(rowsOf(dataRoot, SEEN_APP_ID, "seen_log").map((row) => row.n)).toEqual(["1"]);
  });

  test("D-V23-300・D-V23-308: insert_sample_data の作成で、作成の自動処理が付与の表を読むと作った人の付与が1件見える", async () => {
    const dataRoot = await makeSeenRig();
    const data = okData(
      await call(dataRoot, "dave", "insert_sample_data", {
        app_id: SEEN_APP_ID,
        table_id: "teams",
        rows: [{ name: "チームS" }],
      }),
    );
    expect(data.failed).toEqual([]);
    expect(rowsOf(dataRoot, SEEN_APP_ID, "seen_log").map((row) => row.n)).toEqual(["1"]);
  });
});
