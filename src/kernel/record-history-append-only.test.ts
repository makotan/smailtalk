/**
 * **行の変更履歴は追記だけ**(計画 §27-3 の T04 と §27-6 の中7)。
 *
 * - 内部表 `_record_history` は、records の口(一覧・単件・作成・更新・削除)・`view.table`・`POST /batch`・
 *   MCP の書込4道具と `list_records`・`read_report`・集計表の定義・島の入力と `write_ops`・受信口・参照の相手の
 *   どれからも名指しできない(断りを固定する。 断られた後も内部表の行は1行も増減しない)。
 * - 元の行を消しても、その行の履歴は残る。
 * - 表の `history` を外しても、内部表の行は残る(宣言を外している間に読めるかは閲覧の段で見る)。
 *
 * 置き場は `src/kernel`(`kernel-import-drift` の写しに行を足さないため)。
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
import { createMcpServer } from "../mcp/server.ts";
import { createServerApp } from "../server/app.ts";
import {
  type SeededSession,
  seedSession,
  TEST_ORIGIN,
  withDefaultRoleRules,
} from "../server/test-helpers.ts";
import { InboundStore } from "./inbound-store.ts";
import {
  appDbPath,
  applyDiff,
  applyManifest,
  createApp,
  KernelMetaStore,
  type Manifest,
} from "./index.ts";
import { ensureIslandRuntimeReady } from "./island-runner.ts";

const APP_ID = "rh-append";
const H = "_record_history";
const SIGNING_KEY = "rh-append-key";
const KEY_ENV_VAR = "ST_TEST_RH_APPEND_KEY";

type Any = Record<string, unknown>;

function base(): Any {
  return {
    app: {
      id: APP_ID,
      name: "追記だけ",
      tables: [
        {
          id: "items",
          name: "品",
          history: true,
          fields: [
            { id: "title", name: "件名", type: "text" },
            { id: "qty", name: "数", type: "number" },
          ],
        },
        { id: "cmds", name: "指示", fields: [{ id: "title", name: "件名", type: "text" }] },
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
      functions: [
        {
          id: "poke",
          name: "内部表に書こうとする",
          code: `export default function () { return [{ op: "create", table: "${H}", values: { op: "x" } }]; }`,
          input: { source: "record" },
          output: { ops: true },
        },
      ],
      workflows: [
        {
          id: "wf_poke",
          name: "内部表に書こうとする",
          trigger: { type: "on_create", table: "cmds" },
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "poke", write_ops: true }],
        },
      ],
    },
  };
}

function manifest(): Manifest {
  return withDefaultRoleRules(base() as unknown as Manifest);
}

type Rig = { dataRoot: string; server: ReturnType<typeof createServerApp>; owner: SeededSession };

const dataRoots: string[] = [];

beforeAll(async () => {
  await ensureIslandRuntimeReady();
});

afterEach(async () => {
  delete process.env[KEY_ENV_VAR];
  for (const dir of dataRoots.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeRig(): Promise<Rig> {
  const dataRoot = await mkdtemp(join(tmpdir(), "gp-rh-append-"));
  dataRoots.push(dataRoot);
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, "追記だけ", { app_id: APP_ID });
  } finally {
    meta.close();
  }
  const applied = applyManifest(dataRoot, APP_ID, manifest());
  if (!applied.valid) {
    throw new Error(JSON.stringify(applied.errors));
  }
  return {
    dataRoot,
    server: createServerApp({ dataRoot }),
    owner: seedSession(dataRoot, APP_ID, { role: "owner", username: "boss" }),
  };
}

async function send(
  rig: Rig,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const res = await rig.server.request(
    new Request(`http://localhost/api/apps/${APP_ID}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        origin: TEST_ORIGIN,
        cookie: rig.owner.cookie,
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: res.status, text: await res.text() };
}

async function mcp(rig: Rig, name: string, args: Any): Promise<{ isError: boolean; text: string }> {
  const server = createMcpServer({
    dataRoot: rig.dataRoot,
    previewBaseUrl: "http://localhost:3000",
    actor: "boss",
  });
  const client = new Client({ name: "rh", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  try {
    const result = (await client.callTool({
      name,
      arguments: { app_id: APP_ID, ...args },
    })) as CallToolResult;
    return { isError: result.isError === true, text: JSON.stringify(result.content) };
  } finally {
    await client.close();
    await server.close();
  }
}

function withDb<T>(rig: Rig, run: (db: Database) => T): T {
  const db = new Database(appDbPath(rig.dataRoot, APP_ID));
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function historyRows(rig: Rig): Any[] {
  return withDb(rig, (db) => {
    const has = db
      .query<{ n: number }, []>(`SELECT count(*) AS n FROM sqlite_master WHERE name = '${H}'`)
      .get();
    if ((has?.n ?? 0) === 0) {
      return [];
    }
    return db.query<Any, []>(`SELECT * FROM ${H} ORDER BY seq`).all();
  });
}

/** 宣言した表に1行作り(内部表ができる)、その行の id と内部表の今の姿を返す。 */
async function seeded(rig: Rig): Promise<{ id: string; before: Any[] }> {
  const created = await send(rig, "POST", "/tables/items/records", { title: "一", qty: 1 });
  expect(created.status, created.text).toBe(201);
  const id = (JSON.parse(created.text) as { record: { _id: string } }).record._id;
  const before = historyRows(rig);
  expect(before).toHaveLength(1);
  return { id, before };
}

const NOT_FOUND = `テーブル "${H}" はこのアプリに存在しません。`;

/** 【`V23-M12-T05`。`D-V23-407`】内部表への書込の断り(確定の文)。 */
const INTERNAL_TABLE_REFUSAL =
  "この表はアプリの中の記録のために製品が使う表なので、書き換えられません。";

/** 断りの本文の最初の文面。 */
function firstMessage(text: string): string {
  const parsed = JSON.parse(text) as { errors?: { message?: string }[] };
  return String(parsed.errors?.[0]?.message ?? "");
}

describe("V23-M8-T04 (A) 内部表はどの口からも名指しできない", () => {
  test("(A-1) records の口: 一覧・単件は 404、作成・更新・削除は役割の層の 403。内部表は1行も動かない", async () => {
    const rig = await makeRig();
    const { before } = await seeded(rig);
    const list = await send(rig, "GET", `/tables/${H}/records`);
    expect(list.status, list.text).toBe(404);
    expect(firstMessage(list.text)).toBe(NOT_FOUND);
    const one = await send(rig, "GET", `/tables/${H}/records/1`);
    expect(one.status, one.text).toBe(404);
    expect(firstMessage(one.text)).toBe(NOT_FOUND);
    const writes = [
      await send(rig, "POST", `/tables/${H}/records`, { op: "x" }),
      await send(rig, "PATCH", `/tables/${H}/records/1`, { op: "z" }, { "if-match": "x" }),
      await send(rig, "DELETE", `/tables/${H}/records/1`, undefined, { "if-match": "x" }),
    ];
    for (const sent of writes) {
      expect(sent.status, sent.text).toBe(403);
      // **【`V23-M12-T05`。`D-V23-360` (6)・`D-V23-407`・授権 `ADR-0572` §2-1 の3 で打ち直した。旧の期待を逐語で残す】**
      //       expect(firstMessage(sent.text)).toContain(`表 "${H}" に対する`);
      // 今日の正: 内部表への書込は確定の文(表の ID を出さない)。 403 と「内部表は1行も動かない」は残す。
      expect(firstMessage(sent.text)).toBe(INTERNAL_TABLE_REFUSAL);
    }
    expect(historyRows(rig)).toEqual(before);
  });

  test("P3 D-V23-360 (6)・D-V23-407: 内部表(記録・利用者)への役割の門の書込の断りは確定の文で、表の ID も添える文(set_roles の案内)も出さない", async () => {
    const rig = await makeRig();
    const { before } = await seeded(rig);
    const writes = [
      await send(rig, "POST", `/tables/${H}/records`, { op: "x" }),
      await send(rig, "PATCH", `/tables/${H}/records/1`, { op: "z" }, { "if-match": "x" }),
      await send(rig, "DELETE", `/tables/${H}/records/1`, undefined, { "if-match": "x" }),
      await send(rig, "POST", "/tables/_auth_users/records", { username: "x" }),
    ];
    const shown = writes.map((sent) => {
      const parsed = JSON.parse(sent.text) as { errors: Record<string, unknown>[] };
      return {
        status: sent.status,
        errors: parsed.errors,
        leaks: ["_record_history", "_auth_users", "_changelog", "set_roles", "止めた層"].filter(
          (word) => sent.text.includes(word),
        ),
      };
    });
    expect(shown).toEqual(
      writes.map(() => ({
        status: 403,
        errors: [{ path: "", message: INTERNAL_TABLE_REFUSAL }],
        leaks: [],
      })),
    );
    expect(historyRows(rig)).toEqual(before);
  });

  test("N D-V23-360 (6): 読み取り専用のシステムテーブル(_changelog)への作成は、役割の門より前の今日の 400 の文のまま", async () => {
    const rig = await makeRig();
    const sent = await send(rig, "POST", "/tables/_changelog/records", { note: "x" });
    expect(sent.status, sent.text).toBe(400);
    expect(firstMessage(sent.text)).toBe(
      'テーブル "_changelog" はカーネルのメタ情報を投影した読み取り専用のシステムテーブルなので、書き込めません。',
    );
  });

  test("N D-V23-360 (6): 内部表でない表への役割の層の断りは今日の文と添える文のまま", async () => {
    const rig = await makeRig();
    const viewer = seedSession(rig.dataRoot, APP_ID, { role: "viewer", username: "watcher" });
    const sent = await send(
      rig,
      "POST",
      "/tables/items/records",
      { title: "x", qty: 1 },
      { cookie: viewer.cookie },
    );
    expect(sent.status, sent.text).toBe(403);
    expect(firstMessage(sent.text)).toContain("あなたの役割に許されていません(止めた層: role)。");
    expect(sent.text).toContain("set_roles");
  });

  test("(A-2) POST /batch: 作成・更新は 400(存在しない表)", async () => {
    const rig = await makeRig();
    const { before } = await seeded(rig);
    for (const op of [
      { op: "create", table: H, values: { op: "x" } },
      { op: "update", table: H, target: "1", values: { op: "z" } },
    ]) {
      const sent = await send(rig, "POST", "/batch", { ops: [op] });
      expect(sent.status, sent.text).toBe(400);
      expect(firstMessage(sent.text)).toBe(NOT_FOUND);
    }
    expect(historyRows(rig)).toEqual(before);
  });

  test("(A-3) MCP の書込4道具と read_report は断る。list_records は読めない表と同じ空の一覧で、内部表の行を1行も返さない", async () => {
    const rig = await makeRig();
    const { before } = await seeded(rig);
    const calls: [string, Any][] = [
      ["insert_sample_data", { table_id: H, rows: [{ op: "x" }] }],
      ["update_record", { table_id: H, record_id: "1", if_match: "x", changes: { op: "z" } }],
      ["delete_record", { table_id: H, record_id: "1", if_match: "x" }],
      ["write_records", { ops: [{ op: "create", table: H, values: { op: "x" } }] }],
      ["read_report", { view_id: H }],
    ];
    for (const [name, args] of calls) {
      const result = await mcp(rig, name, args);
      expect(result.isError, `${name} ${result.text}`).toBe(true);
      expect(result.text).toContain(H);
    }
    // 今日の list_records は、役割で読めない表(在らない表も)を断らず、空の一覧で返す(表が在ることを漏らさない側)。
    // 内部表に行が在っても、その行は返らない。
    const listed = await mcp(rig, "list_records", { table_id: H });
    expect(listed.isError, listed.text).toBe(false);
    expect(JSON.parse(JSON.parse(listed.text)[0].text)).toEqual({ records: [], total: 0 });
    expect(historyRows(rig)).toEqual(before);
  });

  test("(A-4) 定義で名指しできない: 画面の表・集計表の表・参照の相手・島の入力・自動処理の書込先", async () => {
    const rig = await makeRig();
    await seeded(rig);
    const variants: [string, (m: Any) => void][] = [
      [
        "list_view.table",
        (m) => {
          (m.app as Any).views = [{ id: "hv", type: "list_view", table: H, columns: ["op"] }];
        },
      ],
      [
        "detail_view.table",
        (m) => {
          (m.app as Any).views = [{ id: "hd", type: "detail_view", table: H, fields: ["op"] }];
        },
      ],
      [
        "report_view.table",
        (m) => {
          (m.app as Any).views = [
            {
              id: "hr",
              type: "report_view",
              table: H,
              report: { group_by: [{ field: "op" }], aggregates: [{ type: "count" }] },
            },
          ];
        },
      ],
      [
        "reference_table",
        (m) => {
          const tables = (m.app as Any).tables as Any[];
          ((tables[0] as Any).fields as Any[]).push({
            id: "h",
            name: "履歴",
            type: "reference",
            reference_table: H,
          });
        },
      ],
      [
        "function.input.table",
        (m) => {
          const fns = (m.app as Any).functions as Any[];
          fns.push({
            id: "peek",
            name: "履歴を読む",
            code: "export default function () { return []; }",
            input: { source: "table", table: H },
            output: { ops: true },
          });
        },
      ],
      [
        "create_record.table",
        (m) => {
          const wfs = (m.app as Any).workflows as Any[];
          wfs.push({
            id: "wf_direct",
            name: "内部表に作る",
            trigger: { type: "on_create", table: "cmds" },
            history_table: "wf_log",
            actions: [{ action: "create_record", table: H, values: { op: "x" } }],
          });
        },
      ],
    ];
    for (const [name, mutate] of variants) {
      const m = base();
      mutate(m);
      const applied = applyManifest(rig.dataRoot, APP_ID, withDefaultRoleRules(m as never));
      expect(applied.valid, name).toBe(false);
    }
  });

  test("(A-5) 島の write_ops で名指しすると断られ、きっかけの行ごと巻き戻る", async () => {
    const rig = await makeRig();
    const { before } = await seeded(rig);
    const sent = await send(rig, "POST", "/tables/cmds/records", { title: "つつく" });
    expect(sent.status, sent.text).toBe(400);
    // 島が返した更新操作の表は、宣言した表の外なので断られる(許される値に内部表は無い)。
    expect(firstMessage(sent.text)).toContain("/ops/0(許可される値: items / cmds / wf_log)");
    expect(withDb(rig, (db) => db.query("SELECT count(*) AS n FROM cmds").get())).toEqual({ n: 0 });
    expect(historyRows(rig)).toEqual(before);
  });

  test("(A-6) 受信口: 内部表を書込先にした受け口に送っても、内部表は1行も増えない", async () => {
    const rig = await makeRig();
    const { before } = await seeded(rig);
    process.env[KEY_ENV_VAR] = SIGNING_KEY;
    const inbound = InboundStore.openForKernel(rig.dataRoot);
    let endpoint = "";
    let refused = "";
    try {
      endpoint = inbound.issueInboundEndpoint({
        appId: APP_ID,
        name: "history",
        secretSource: { kind: "env", value: KEY_ENV_VAR },
        targetTable: H,
      }).id;
    } catch (error) {
      refused = (error as Error).message;
    } finally {
      inbound.close();
    }
    // 受け口の発行は書込先の表を確かめない(今日の形)。 送ると、役割の層が受信の主体の書込を断る(403)。
    expect(refused).toBe("");
    const rawBody = JSON.stringify({ op: "x" });
    const signature = `sha256=${createHmac("sha256", SIGNING_KEY).update(Buffer.from(rawBody, "utf-8")).digest("hex")}`;
    const res = await rig.server.request(
      new Request(`http://localhost/inbound/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Mock-PSP-Signature": signature },
        body: rawBody,
      }),
    );
    const text = await res.text();
    expect(res.status, text).toBe(403);
    expect(firstMessage(text)).toContain("受信を遮断しました(1バイトも書き込んでいません)");
    expect(historyRows(rig)).toEqual(before);
  });
});

describe("V23-M8-T04 (R) 履歴は残る", () => {
  test("(R-1) 元の行を消しても、その行の作成・更新・削除の履歴は残る", async () => {
    const rig = await makeRig();
    const { id } = await seeded(rig);
    const version = () =>
      String(
        withDb(rig, (db) =>
          db
            .query<{ v: string }, [string]>("SELECT _updated_at AS v FROM items WHERE _id = ?")
            .get(id),
        )?.v,
      );
    const updated = await send(
      rig,
      "PATCH",
      `/tables/items/records/${id}`,
      { qty: 2 },
      {
        "if-match": version(),
      },
    );
    expect(updated.status, updated.text).toBe(200);
    const deleted = await send(rig, "DELETE", `/tables/items/records/${id}`, undefined, {
      "if-match": version(),
    });
    expect(deleted.status, deleted.text).toBe(204);
    const rows = historyRows(rig).filter((row) => row.record_id === id);
    expect(rows.map((row) => row.op)).toEqual(["create", "update", "delete"]);
  });

  test("(R-2) 表の history を外しても、内部表の行は残る(外した後の書込は記録しない)", async () => {
    const rig = await makeRig();
    const { id, before } = await seeded(rig);
    const applied = applyDiff(rig.dataRoot, APP_ID, {
      diff_id: "rh-off",
      intent: "変更履歴をやめる",
      operations: [{ op: "change_table", table: "items", changes: { history: false } }],
    });
    expect((applied as { valid?: boolean }).valid, JSON.stringify(applied)).toBe(true);
    expect(historyRows(rig)).toEqual(before);
    const version = String(
      withDb(rig, (db) =>
        db
          .query<{ v: string }, [string]>("SELECT _updated_at AS v FROM items WHERE _id = ?")
          .get(id),
      )?.v,
    );
    const updated = await send(
      rig,
      "PATCH",
      `/tables/items/records/${id}`,
      { qty: 9 },
      {
        "if-match": version,
      },
    );
    expect(updated.status, updated.text).toBe(200);
    expect(historyRows(rig)).toEqual(before);
  });
});
