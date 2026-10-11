/**
 * **相手の名前の見せ方 —— 付与の行ごとに、相手の行の代表項目だけを添える**
 * (`V23-M6-T04b`。門A = `ADR-0502`(`SC-G20`)を補う `ADR-0538` §Decision 1-7。
 * 決定 `D-V23-147`・`D-V23-156`・`D-V23-165`・`D-V23-173`。計画 §25-6 中5・中10。授権 `ADR-0539`)。
 *
 * ## この検査が測るもの / 測らないもの(**先に書く**)
 *
 * **題材**: 名簿1本を共有する2つの表。 部隊(S。`units`。代表項目 `title`、ほかに `secret`)と案件(R。`projects`)。
 * 案件の付与表の `unit` 列が部隊の行を指す(`principal_row`)。 案件 P1 に部隊 A1 と部隊 A2 への付与、
 * 管理者 `admin` には全案件に `p_admin`(利用者の行への付与)。 `admin` は部隊の行を1件も読めない。
 * `expert` は部隊 A1 に `unit_member` を持つだけ。
 *
 * **測るもの**:
 * 1. 付与の行を今日の規則で読める人(組織の管理者)に、HTTP の一覧(`principal_labels`。返す行と同じ順・同じ長さ)・
 *    1行(`principal_label`)・MCP の `list_records`(`principal_labels`)で、相手の行の代表項目だけが出る。
 *    相手の欄が空の行(利用者への付与)は `null`。
 * 2. 部隊のほかの項目(`secret`)は出ない。 部隊の行そのものは今日どおり読めない(404)。
 * 3. 代表項目が見る人の役割の規則で隠れていれば `null`(別の項目を繰り上げない)。 部隊の行が消えていれば `null`。
 * 4. 部隊経由の専門家には、付与の行・名簿の他人の行・他の評価機関の名前が見えない(`D-V23-165`)。
 * 5. 陰性対照: `principal_row` の無いアプリでは、一覧・1行・MCP の応答のキーが今日のまま(1バイトも足さない)。
 *
 * **測らないもの(誇張しない)**: 招待中の一覧での相手の名前(コードの招待は `T06`)。 画面(`T06b`)。
 * 書き出し版(申告。`T09`)。
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
} from "../kernel/index.ts";
import { createMcpServer } from "../mcp/server.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN } from "./test-helpers.ts";

const APP_ID = "pr-labels";
const ALL = ["read", "write", "delete"];
const TABLES = ["members", "units", "unit_grants", "projects", "project_grants"];

const ref = (id: string, table: string) => ({
  id,
  name: id,
  type: "reference",
  reference_table: table,
});

type Variant = { principalRow?: boolean; hideTitle?: boolean };

function manifest(variant: Variant = {}): Manifest {
  const principal = variant.principalRow !== false;
  const rules = (can: string[]) => TABLES.map((table) => ({ target: "table", table, can }));
  return {
    app: {
      id: APP_ID,
      name: "相手の名前の見せ方",
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
        {
          id: "units",
          name: "部隊",
          representative_field: "title",
          // 代表項目より前に別の text 項目を置く(繰り上げれば、これが出る)。
          fields: [
            { id: "secret", name: "機密", type: "text" },
            { id: "title", name: "名前", type: "text" },
          ],
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
              permission: "permission",
            },
            members: { table: "members", account: "account" },
          },
        },
        {
          id: "unit_grants",
          name: "部隊の付与",
          fields: [
            ref("unit", "units"),
            ref("member", "members"),
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
              ...(principal
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
            ...(variant.hideTitle === true
              ? [{ target: "field", table: "units", field: "title", can: ["read", "write"] }]
              : []),
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

let dataRoot = "";
let server: ReturnType<typeof createServerApp>;
let admin: Who;
let expert: Who;
type Ids = Record<
  "mAdmin" | "mExpert" | "unitA1" | "unitA2" | "p1" | "p2" | "gAdmin1" | "gA1" | "gA2",
  string
>;
let ids = {} as Ids;

function withDb<T>(run: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID));
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function put(db: Database, table: string, values: Record<string, unknown>): string {
  const created = createRecord(db, manifest(), table, values);
  if (!created.ok) {
    throw new Error(`${table} に行を置けない: ${JSON.stringify(created.errors)}`);
  }
  return created.value._id;
}

async function rig(variant: Variant = {}): Promise<void> {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-pr-labels-"));
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, "相手の名前の見せ方", { app_id: APP_ID });
  } finally {
    meta.close();
  }
  const applied = applyManifest(dataRoot, APP_ID, manifest(variant));
  if (!applied.valid) {
    throw new Error(JSON.stringify(applied.errors));
  }
  server = createServerApp({ dataRoot });
  const seed = (username: string, role: string): Who => {
    const s = seedSession(dataRoot, APP_ID, { role, username });
    return { cookie: s.cookie, userId: s.userId, username };
  };
  admin = seed("admin1", "staff");
  expert = seed("expert1", "staff");
  ids = withDb((db) => {
    const mAdmin = put(db, "members", { name: "管理者", account: admin.userId });
    const mExpert = put(db, "members", { name: "専門家", account: expert.userId });
    const unitA1 = put(db, "units", { title: "部隊A1", secret: "機密A1" });
    const unitA2 = put(db, "units", { title: "部隊A2", secret: "機密A2" });
    put(db, "unit_grants", { unit: unitA1, member: mExpert, permission: "unit_member" });
    const p1 = put(db, "projects", { title: "案件1" });
    const p2 = put(db, "projects", { title: "案件2" });
    const gAdmin1 = put(db, "project_grants", {
      project: p1,
      member: mAdmin,
      permission: "p_admin",
    });
    put(db, "project_grants", { project: p2, member: mAdmin, permission: "p_admin" });
    // 相手の行を指す付与の行は承諾でだけ作れる(`T04`)ので、DB に直に置く。
    const gA1 = put(db, "project_grants", { project: p1, unit: unitA1, permission: "p_worker" });
    const gA2 = put(db, "project_grants", { project: p1, unit: unitA2, permission: "p_worker" });
    return { mAdmin, mExpert, unitA1, unitA2, p1, p2, gAdmin1, gA1, gA2 };
  });
}

beforeEach(async () => {
  await rig();
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

type Sent = { status: number; body: Record<string, unknown>; text: string };

async function http(path: string, who: Who): Promise<Sent> {
  const res = await server.request(
    new Request(`http://localhost/api/apps/${APP_ID}${path}`, {
      method: "GET",
      headers: { cookie: who.cookie, origin: TEST_ORIGIN },
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

async function mcp(args: Record<string, unknown>, who: Who): Promise<Record<string, unknown>> {
  const mcpServer = createMcpServer({
    dataRoot,
    previewBaseUrl: "http://127.0.0.1:3000",
    actor: who.username,
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);
  try {
    const result = (await client.callTool({
      name: "list_records",
      arguments: { app_id: APP_ID, ...args },
    })) as CallToolResult;
    if (result.isError === true) {
      throw new Error(`ツールが失敗した: ${JSON.stringify(result.structuredContent)}`);
    }
    return result.structuredContent as Record<string, unknown>;
  } finally {
    await client.close();
    await mcpServer.close();
  }
}

/** 返した行の ID と、同じ位置の相手の名前を組にする(順が行と同じであることも見る)。 */
function pairs(body: Record<string, unknown>): [string, unknown][] {
  const records = (body.records ?? []) as Record<string, unknown>[];
  const labels = body.principal_labels as unknown[];
  expect(Array.isArray(labels)).toBe(true);
  expect(labels).toHaveLength(records.length);
  return records.map((row, index) => [String(row._id), labels[index]]);
}

const expectedPairs = (): [string, unknown][] =>
  [
    [ids.gAdmin1, null],
    [ids.gA1, "部隊A1"],
    [ids.gA2, "部隊A2"],
  ] as [string, unknown][];

describe("(L) 付与の行を読める人に、相手の行の代表項目だけ", () => {
  test("(L-1) HTTP の一覧: 組織の管理者に、付与の行ごとに相手の名前が出る(利用者への付与は null)", async () => {
    // 管理者は部隊の行を読めない(今日の規則のまま)。
    expect((await http(`/tables/units/records/${ids.unitA1}`, admin)).status).toBe(404);
    const sent = await http("/tables/project_grants/records", admin);
    expect(sent.status).toBe(200);
    const got = pairs(sent.body).filter(([id]) => [ids.gAdmin1, ids.gA1, ids.gA2].includes(id));
    expect(got.sort()).toEqual(expectedPairs().sort());
    expect(pairs(sent.body)).toHaveLength(4);
  });

  test("(L-2) HTTP の1行: 相手の行を指す付与には名前、利用者への付与には null", async () => {
    const a1 = await http(`/tables/project_grants/records/${ids.gA1}`, admin);
    expect(a1.status).toBe(200);
    expect(a1.body.principal_label).toBe("部隊A1");
    const own = await http(`/tables/project_grants/records/${ids.gAdmin1}`, admin);
    expect(own.status).toBe(200);
    expect(Object.hasOwn(own.body, "principal_label")).toBe(true);
    expect(own.body.principal_label).toBeNull();
  });

  test("(L-3) MCP の list_records: HTTP の一覧と同じ値", async () => {
    const listed = await mcp({ table_id: "project_grants" }, admin);
    const got = pairs(listed).filter(([id]) => [ids.gAdmin1, ids.gA1, ids.gA2].includes(id));
    expect(got.sort()).toEqual(expectedPairs().sort());
  });

  test("(L-4) 部隊のほかの項目は出ない(一覧・1行・MCP)", async () => {
    const texts = [
      (await http("/tables/project_grants/records", admin)).text,
      (await http(`/tables/project_grants/records/${ids.gA1}`, admin)).text,
      JSON.stringify(await mcp({ table_id: "project_grants" }, admin)),
    ];
    for (const text of texts) {
      expect(text).not.toContain("機密A1");
      expect(text).not.toContain("機密A2");
      expect(text).not.toContain('"secret"');
    }
  });

  test("(L-5) 代表項目が見る人の役割の規則で隠れていれば null(別の項目を繰り上げない)", async () => {
    await rm(dataRoot, { recursive: true, force: true });
    await rig({ hideTitle: true });
    const sent = await http("/tables/project_grants/records", admin);
    expect(sent.status).toBe(200);
    for (const [, label] of pairs(sent.body)) {
      expect(label).toBeNull();
    }
    expect(
      (await http(`/tables/project_grants/records/${ids.gA1}`, admin)).body.principal_label,
    ).toBeNull();
    for (const [, label] of pairs(await mcp({ table_id: "project_grants" }, admin))) {
      expect(label).toBeNull();
    }
    expect(sent.text).not.toContain("部隊A1");
    expect(sent.text).not.toContain("機密A1");
  });

  test("(L-6) 部隊の行が消えていれば null", async () => {
    withDb((db) => db.query('DELETE FROM "units" WHERE _id = ?').run(ids.unitA2));
    const sent = await http("/tables/project_grants/records", admin);
    const got = new Map(pairs(sent.body));
    expect(got.get(ids.gA1)).toBe("部隊A1");
    expect(got.get(ids.gA2)).toBeNull();
    expect(
      (await http(`/tables/project_grants/records/${ids.gA2}`, admin)).body.principal_label,
    ).toBeNull();
  });
});

describe("(E) 【独立点検の処置(軽1)】相手の名前の空文字は null にそろえる", () => {
  test("(E-1) 部隊の代表項目が空文字なら、一覧・1行・MCP とも null(招待の一覧と同じ扱い)", async () => {
    withDb((db) => db.query(`UPDATE "units" SET "title" = '' WHERE _id = ?`).run(ids.unitA2));
    const sent = await http("/tables/project_grants/records", admin);
    expect(sent.status).toBe(200);
    expect(new Map(pairs(sent.body)).get(ids.gA2)).toBeNull();
    expect(new Map(pairs(sent.body)).get(ids.gA1)).toBe("部隊A1");
    expect(
      (await http(`/tables/project_grants/records/${ids.gA2}`, admin)).body.principal_label,
    ).toBeNull();
    expect(
      new Map(pairs(await mcp({ table_id: "project_grants" }, admin))).get(ids.gA2),
    ).toBeNull();
  });
});

describe("(V) 部隊経由の専門家には見えない(`D-V23-165`)", () => {
  test("(V-1) 付与の行・名簿の他人の行・他の評価機関の名前が見えない(HTTP と MCP)", async () => {
    // 案件 P1 は部隊経由で読める(`T03`)。
    expect((await http(`/tables/projects/records/${ids.p1}`, expert)).status).toBe(200);
    const grants = await http("/tables/project_grants/records", expert);
    expect(grants.status).toBe(200);
    expect(grants.body.records).toEqual([]);
    expect(grants.text).not.toContain("部隊A2");
    expect(grants.text).not.toContain("部隊A1");
    for (const id of [ids.gA1, ids.gA2, ids.gAdmin1]) {
      const one = await http(`/tables/project_grants/records/${id}`, expert);
      expect(one.status).toBe(404);
      expect(one.text).not.toContain("部隊A");
    }
    const members = await http("/tables/members/records", expert);
    expect(
      ((members.body.records ?? []) as Record<string, unknown>[]).map((row) => row._id),
    ).toEqual([ids.mExpert]);
    expect((await http(`/tables/units/records/${ids.unitA2}`, expert)).status).toBe(404);
    const listed = await mcp({ table_id: "project_grants" }, expert);
    expect(listed.total).toBe(0);
    expect(JSON.stringify(listed)).not.toContain("部隊A");
  });
});

describe("(N) 陰性対照: principal_row の無いアプリの応答は今日のまま", () => {
  test("(N-1) 一覧・1行・MCP の応答に新しいキーが1つも無い", async () => {
    await rm(dataRoot, { recursive: true, force: true });
    await rig({ principalRow: false });
    const list = await http("/tables/project_grants/records", admin);
    expect(list.status).toBe(200);
    expect(Object.keys(list.body).sort()).toEqual(["records", "total"]);
    const one = await http(`/tables/project_grants/records/${ids.gAdmin1}`, admin);
    expect(one.status).toBe(200);
    expect(Object.keys(one.body).sort()).toEqual(["record"]);
    const listed = await mcp({ table_id: "project_grants" }, admin);
    expect(Object.keys(listed).sort()).toEqual(["records", "total"]);
    for (const text of [list.text, one.text, JSON.stringify(listed)]) {
      expect(text).not.toContain("principal_label");
      expect(text).not.toContain("部隊A");
    }
    // 守る表でない表(案件そのもの)の一覧も今日のまま。
    const projects = await http("/tables/projects/records", admin);
    expect(projects.text).not.toContain("principal_label");
  });
});
