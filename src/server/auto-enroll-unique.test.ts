/**
 * **名簿の `account` 列の一意索引に当たった書込を、書込時検査と同じ形に翻訳する**
 * (`V23-M1-T05`。単位 `SC-G2`。上位: `docs/adr/0497-auto-enroll-and-last-row-admin.md` §Decision 1、
 * `docs/adr/0510-v23-m1-guard-authorization-and-pre-start-decisions.md` §Decision 1 の2、
 * 計画 `docs/plan/v23/00-v23-plan.md` §4 の M1-A「振る舞い」の1 と T05)。
 *
 * **2つの台を並べる。**
 * - 台「索引」: 自動登録を宣言した名簿で、`account` に `unique: true` を書かない(今日の書込時検査は
 *   掛からず、DB の一意索引に直接当たる。計画 T05 の (3)「書込時検査を外した写しの台」と同じ形)。
 * - 台「検査」: 同じ宣言に `unique: true` を足す(書込時検査が先に断る)。
 *
 * 入口ごとに、同じ利用者 ID の行を足して、(1) どれも断られる (2) 2つの台で応答(状態コード・本文)が
 * 1バイトも違わない (3) 名簿の行が増えない、を見る。 受信口は、台「検査」で今日どおり冪等に吸収し、
 * 台「索引」では同じ断りの本文が 400 で返る(`ADR-0497` §限界2: 吸収は `unique: true` の列だけ)。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { InboundStore } from "../kernel/inbound-store.ts";
import {
  appDbPath,
  applyDiff,
  applyManifest,
  createApp,
  KernelMetaStore,
  type Manifest,
} from "../kernel/index.ts";
import { ensureIslandRuntimeReady } from "../kernel/island-runner.ts";
import { createMcpServer } from "../mcp/server.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN } from "./test-helpers.ts";

const APP_ID = "scs-unique";
const DUP = "u-dup";
const KEY_ENV_VAR = "GP_TEST_AUTO_ENROLL_INBOUND_KEY";
const SIGNING_KEY = "auto-enroll-unique-signing-key";

const HISTORY_FIELDS = [
  { id: "ran_at", name: "実行時刻", type: "date" },
  { id: "workflow", name: "ワークフロー", type: "text" },
  { id: "trigger_type", name: "きっかけ", type: "text" },
  { id: "status", name: "結果", type: "text" },
  { id: "error", name: "エラー", type: "long_text" },
];

const ALL = ["read", "write", "delete"];

function orgsDeclaration(autoEnroll: boolean): Record<string, unknown> {
  return {
    enabled: true,
    permissions: [{ id: "keeper", name: "管理", read: true, write: true, delete: true }],
    creator_permission: "keeper",
    creatable_by_roles: ["owner"],
    grant: { table: "og", target: "org", member: "member", permission: "permission" },
    members: {
      table: "mem",
      account: "account",
      ...(autoEnroll ? { auto_enroll: { roles: ["editor"] } } : {}),
    },
  };
}

function baseManifest(uniqueCheck: boolean): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "一意",
      tables: [
        {
          id: "orgs",
          name: "組織",
          fields: [{ id: "title", name: "名", type: "text" }],
          access_control: orgsDeclaration(false),
        },
        {
          id: "mem",
          name: "名簿",
          fields: [
            {
              id: "account",
              name: "利用者",
              type: "text",
              ...(uniqueCheck ? { unique: true } : {}),
            },
            { id: "display", name: "表示名", type: "text" },
          ],
        },
        {
          id: "og",
          name: "付与",
          fields: [
            { id: "org", name: "組織", type: "reference", reference_table: "orgs" },
            { id: "member", name: "相手", type: "reference", reference_table: "mem" },
            { id: "permission", name: "権限", type: "select", options: ["keeper"] },
          ],
        },
        { id: "trig", name: "きっかけ", fields: [{ id: "acc", name: "利用者", type: "text" }] },
        {
          id: "trig2",
          name: "島のきっかけ",
          fields: [{ id: "acc", name: "利用者", type: "text" }],
        },
        { id: "wf-runs", name: "実行履歴", fields: HISTORY_FIELDS },
      ],
      views: [],
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            ...["orgs", "mem", "og", "trig", "trig2", "wf-runs"].map((table) => ({
              target: "table",
              table,
              can: ALL,
            })),
          ],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
      functions: [
        {
          id: "island",
          name: "島も名簿に1行作る",
          code: `export default function () { return [{ op: "create", table: "mem", values: { account: "${DUP}" } }]; }`,
          input: { source: "record" },
          output: { ops: true },
        },
      ],
      workflows: [
        {
          id: "wf-create",
          name: "きっかけから名簿に作る",
          trigger: { type: "on_create", table: "trig" },
          history_table: "wf-runs",
          actions: [{ action: "create_record", table: "mem", values: { account: "$record.acc" } }],
        },
        {
          id: "wf-island",
          name: "島から名簿に作る",
          trigger: { type: "on_create", table: "trig2" },
          history_table: "wf-runs",
          actions: [{ action: "run_function", function: "island", write_ops: true }],
        },
      ],
    },
  } as unknown as Manifest;
}

type Rig = {
  dataRoot: string;
  server: ReturnType<typeof createServerApp>;
  cookie: string;
  endpointId: string;
};

const rigs: Rig[] = [];

beforeAll(async () => {
  await ensureIslandRuntimeReady();
});

afterEach(async () => {
  delete process.env[KEY_ENV_VAR];
  for (const rig of rigs.splice(0)) {
    await rm(rig.dataRoot, { recursive: true, force: true });
  }
});

async function makeRig(uniqueCheck: boolean): Promise<Rig> {
  const dataRoot = await mkdtemp(join(tmpdir(), "gp-auto-enroll-unique-"));
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, "一意", { app_id: APP_ID });
  } finally {
    meta.close();
  }
  const applied = applyManifest(dataRoot, APP_ID, baseManifest(uniqueCheck));
  if (!applied.valid) {
    throw new Error(JSON.stringify(applied.errors));
  }
  // 宣言は差分で足す(索引を張るのは差分の適用)。
  const declared = applyDiff(dataRoot, APP_ID, {
    diff_id: "d-declare",
    intent: "名簿へ自動で入れる",
    operations: [
      { op: "change_table", table: "orgs", changes: { access_control: orgsDeclaration(true) } },
    ],
  });
  if (!declared.valid) {
    throw new Error(JSON.stringify(declared.errors));
  }
  process.env[KEY_ENV_VAR] = SIGNING_KEY;
  const inbound = InboundStore.openForKernel(dataRoot);
  let endpointId: string;
  try {
    endpointId = inbound.issueInboundEndpoint({
      appId: APP_ID,
      name: "psp",
      secretSource: { kind: "env", value: KEY_ENV_VAR },
      targetTable: "mem",
    }).id;
  } finally {
    inbound.close();
  }
  const cookie = seedSession(dataRoot, APP_ID, { role: "owner", username: "owner1" }).cookie;
  const rig: Rig = { dataRoot, server: createServerApp({ dataRoot }), cookie, endpointId };
  rigs.push(rig);
  // 先に1行(DUP)を置く。
  const first = await send(rig, "POST", `/api/apps/${APP_ID}/tables/mem/records`, {
    account: DUP,
  });
  if (first.status !== 201) {
    throw new Error(`先の1行を置けない: ${first.status} ${await first.text()}`);
  }
  return rig;
}

async function send(
  rig: Rig,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await rig.server.request(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        origin: TEST_ORIGIN,
        cookie: rig.cookie,
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

async function postInbound(rig: Rig, payload: Record<string, unknown>): Promise<Response> {
  const rawBody = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", SIGNING_KEY).update(Buffer.from(rawBody, "utf-8")).digest("hex")}`;
  return await rig.server.request(
    new Request(`http://localhost/inbound/${rig.endpointId}`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Mock-PSP-Signature": signature },
      body: rawBody,
    }),
  );
}

async function mcpWrite(rig: Rig, ops: unknown[]): Promise<CallToolResult> {
  const server = createMcpServer({
    dataRoot: rig.dataRoot,
    previewBaseUrl: "http://localhost:3000",
    actor: "owner1",
  });
  const client = new Client({ name: "t05", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  try {
    return (await client.callTool({
      name: "write_records",
      arguments: { app_id: APP_ID, ops },
    })) as CallToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

function dupCount(rig: Rig): number {
  const db = new Database(appDbPath(rig.dataRoot, APP_ID), { readonly: true });
  try {
    return (
      db
        .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM "mem" WHERE "account" = ?`)
        .get(DUP)?.n ?? -1
    );
  } finally {
    db.close();
  }
}

/** 名簿の行の ID と版を、本物の SQLite から読む。 */
function readMemRow(rig: Rig, account: string): { _id: string; _updated_at: string } {
  const db = new Database(appDbPath(rig.dataRoot, APP_ID), { readonly: true });
  try {
    const row = db
      .query<{ _id: string; _updated_at: string }, [string]>(
        `SELECT "_id", "_updated_at" FROM "mem" WHERE "account" = ?`,
      )
      .get(account);
    if (row === null) {
      throw new Error(`名簿の行が無い: ${account}`);
    }
    return row;
  } finally {
    db.close();
  }
}

/** 本文から、実行ごとに変わる値(行の ID・時刻)を落とす。 */
function stable(text: string): string {
  return text.replace(/"_id":"[^"]+"/g, '"_id":"*"').replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g, "*");
}

type Outcome = { status: number; body: string; count: number };

async function shootBoth(shoot: (rig: Rig) => Promise<{ status: number; body: string }>): Promise<{
  index: Outcome;
  check: Outcome;
}> {
  const index = await makeRig(false);
  const check = await makeRig(true);
  const a = await shoot(index);
  const b = await shoot(check);
  return {
    index: { ...a, body: stable(a.body), count: dupCount(index) },
    check: { ...b, body: stable(b.body), count: dupCount(check) },
  };
}

async function httpOutcome(response: Response): Promise<{ status: number; body: string }> {
  return { status: response.status, body: await response.text() };
}

function expectSameRefusal(result: { index: Outcome; check: Outcome }): void {
  expect(result.index.status, result.index.body).toBe(result.check.status);
  expect(result.index.status).not.toBe(500);
  expect(result.index.body).toBe(result.check.body);
  expect(result.index.body).toContain("/account");
  expect(result.index.count).toBe(1);
  expect(result.check.count).toBe(1);
}

describe("V23-M1-T05 一意索引に当たった書込の翻訳", () => {
  test("(http-post) HTTP の POST: 同じ断り(状態コード・本文)が返り、行は増えない", async () => {
    const result = await shootBoth(async (rig) =>
      httpOutcome(
        await send(rig, "POST", `/api/apps/${APP_ID}/tables/mem/records`, { account: DUP }),
      ),
    );
    expect(result.index.status).toBe(400);
    expectSameRefusal(result);
  });

  test("(http-patch) HTTP の PATCH: 別の行の account を同じ値に書き換えると、同じ断りが返る", async () => {
    const result = await shootBoth(async (rig) => {
      const other = await send(rig, "POST", `/api/apps/${APP_ID}/tables/mem/records`, {
        account: "u-other",
      });
      expect(other.status).toBe(201);
      const row = readMemRow(rig, "u-other");
      return httpOutcome(
        await send(
          rig,
          "PATCH",
          `/api/apps/${APP_ID}/tables/mem/records/${row._id}`,
          { account: DUP },
          { "if-match": row._updated_at },
        ),
      );
    });
    expect(result.index.status).toBe(400);
    expectSameRefusal(result);
  });

  test("(http-batch) HTTP のまとめ書き: 同じ断りが返る", async () => {
    const result = await shootBoth(async (rig) =>
      httpOutcome(
        await send(rig, "POST", `/api/apps/${APP_ID}/batch`, {
          ops: [{ op: "create", table: "mem", values: { account: DUP } }],
        }),
      ),
    );
    expectSameRefusal(result);
  });

  test("(mcp) MCP の write_records: 同じ断りが返る", async () => {
    const result = await shootBoth(async (rig) => {
      const called = await mcpWrite(rig, [
        { op: "create", table: "mem", values: { account: DUP } },
      ]);
      return {
        status: called.isError === true ? 1 : 0,
        body: JSON.stringify(called.structuredContent ?? called.content),
      };
    });
    expect(result.index.status).toBe(1);
    expectSameRefusal(result);
  });

  test("(workflow) 自動処理の create_record: 発火元ごと同じ断りが返り、名簿の行は増えない", async () => {
    const result = await shootBoth(async (rig) =>
      httpOutcome(await send(rig, "POST", `/api/apps/${APP_ID}/tables/trig/records`, { acc: DUP })),
    );
    expectSameRefusal(result);
  });

  test("(island) 島の write_ops: 発火元ごと同じ断りが返り、名簿の行は増えない", async () => {
    const result = await shootBoth(async (rig) =>
      httpOutcome(
        await send(rig, "POST", `/api/apps/${APP_ID}/tables/trig2/records`, { acc: "x" }),
      ),
    );
    expectSameRefusal(result);
  });

  test("(inbound) 受信口: unique: true の台は今日どおり冪等に吸収し、索引だけの台は同じ断りを 400 で返す", async () => {
    const index = await makeRig(false);
    const check = await makeRig(true);
    const a = await postInbound(index, { account: DUP });
    const b = await postInbound(check, { account: DUP });
    expect(b.status).toBe(200);
    const absorbed = (await b.json()) as { idempotent?: boolean; errors: unknown[] };
    expect(absorbed.idempotent).toBe(true);
    expect(a.status).toBe(400);
    const refused = (await a.json()) as { errors: unknown[] };
    expect(refused.errors).toEqual(absorbed.errors);
    expect(dupCount(index)).toBe(1);
    expect(dupCount(check)).toBe(1);
  });
});
