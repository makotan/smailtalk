/**
 * **`V18-M5-T02` / 審査の単位 `PM-G3` / `ADR-0432`(決定の本体)/ `ADR-0442`(授権)**:
 * **根の表に「行を作れる立場」が**一行も書かれていない**とき、AI の口(MCP)からも
 * 行を作れなくする。**
 *
 * ## **これは「穴を塞ぐ」ではなく「新しく掛ける」である**
 *
 * **この止めは、着手時点で AI の口に **1本も** 配線されていなかった**
 * (`ADR-0432` §Status 3 の逐語)。 **着手前の実測は
 * `scratchpad/bed-m5/before.md` §7 に在り、名簿に登録済みの一般利用者が
 * `insert_sample_data` / `write_records` のどちらからでも行を作れていた。**
 * **【禁止】これを「穴を塞いだ」と書かない。**
 *
 * ## 何を測るか
 *
 * | # | 何を撃つか | **着手時(本葉が実際に見た赤 / 緑)** |
 * | --- | --- | --- |
 * | `(A-1)` | 区分C へ、名簿に登録済みの一般利用者が `write_records` の `create` | **赤(通ってしまう)** |
 * | `(A-2)` | 同じ表へ `insert_sample_data` | **赤(通ってしまう)** |
 * | `(A-3)` | **運営(`owner`)でも断られる**(`D-V18-28`。例外を1つも置かない) | **赤(通ってしまう)** |
 * | `(A-4)` | 断り文に内部記号が1文字も無い | **赤**(断り自体が無い) |
 * | `(B-1)` | 区分D —— 挙がっている立場は通る【陰性対照】 | 緑 |
 * | `(B-2)` | 区分D —— 挙がっていない立場は断られる | **赤**(今日は誰でも通る) |
 * | `(B-3)` | 区分D の2本の断り文が使い分けられている | **赤** |
 * | `(C-1)` | **区分A**(権限管理を一行も宣言していない表)は1バイトも変わらない(`D-V18-27`) | 緑 |
 * | `(C-2)` | **`enabled: false`** の表も1バイトも変わらない | 緑 |
 * | `(C-3)` | **`inherit_from` を宣言し、9キー目を書いていない表では素通りする** | 緑(壊さないことの担保) |
 * | `(D-1)` | **更新(`update_record`)に1ミリも掛かっていない** | 緑 |
 * | `(D-2)` | **削除(`delete_record`)に1ミリも掛かっていない** | 緑 |
 * | `(E-1)` | **`rows: []` の `insert_sample_data` の応答が変わる**(区分C) | **赤**(今日は成功が返る) |
 * | `(E-2)` | **`rows: []` は区分A では今日どおり成功する** | 緑 |
 * | `(F-1)` | **断り文2本が `app.ts` の同名の関数と1文字違わない**(2経路一致) | **赤**(写しがまだ無い) |
 *
 * ## **この検査が測っていないもの(誇張しない)**
 *
 *  - **受信口 / 自動処理 / 島 / 時刻起動 の4本を1度も撃っていない** ——
 *    **本段はこの4本に1ビットも掛けない**(`D-V18-6`)。 **どれも今日も素通りする。**
 *  - **本物の HTTP の口を1度も叩いていない** —— **HTTP 側は
 *    `src/server/root-create-closed-by-default.test.ts`(`V18-M5-T01`)が撃つ。**
 *    **本ファイルの `(F-1)` が突き合わせているのは**文面**であって、応答コードではない**
 *    (AI の口に数値コードは無い)。
 *  - **付与の行(作った人への権限)が AI の口では1行も作られないこと**は、
 *    着手前から今日までの既知の食い違いであり、本葉は1ミリも直していない。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  type ValidationError,
} from "../kernel/index.ts";
import { seedSession, withDefaultRoleRules } from "../server/test-helpers.ts";
import { createMcpServer } from "./server.ts";

const APP_ID = "root-create-closed-mcp";
const PREVIEW_BASE_URL = "http://127.0.0.1:3000";
/** 製品の根(`apps/smailtalk`)。**`src/mcp/…` から2つ上がる。** */
const PRODUCT_ROOT = dirname(dirname(import.meta.dir));

const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる", read: true, write: true, delete: true },
] as const;

/** 根の表の宣言(**`inherit_from` を1本も書かない**)。 */
function declaration(target: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    permissions: [...PERMISSIONS],
    creator_permission: "writer",
    grant: { table: "ac_grant", target, member: "member", permission: "permission" },
    members: { table: "ac_member", account: "account" },
    ...extra,
  };
}

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "既定を閉じる(AI の口)",
      tables: [
        {
          // **区分C** —— **権限管理は宣言しているが、9キー目を1文字も書いていない根の表。**
          id: "silent",
          name: "宣言の無い持ち場",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
          access_control: declaration("silent"),
        },
        {
          // **区分D** —— **9キー目を宣言した表**(退行の担保に使う)。
          id: "declared",
          name: "宣言した持ち場",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
          access_control: declaration("declared", { creatable_by_roles: ["editor"] }),
        },
        {
          // **`enabled: false`** —— **宣言していない表とまったく同じ扱いになるはずの形。**
          id: "disabled",
          name: "止めてある持ち場",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
          access_control: declaration("disabled", { enabled: false }),
        },
        {
          // **区分A** —— **権限管理を1バイトも宣言していない表**(`D-V18-27`)。
          id: "plain",
          name: "宣言の無い表",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
        },
        {
          // **区分E** —— **引き継ぎを宣言し、9キー目を1文字も書いていない表。**
          // **根の表ではないので、既定の反転は1ミリも掛かってはならない。**
          id: "child",
          name: "引き継ぐ表",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "parent", name: "元の行", type: "reference", reference_table: "declared" },
          ],
          access_control: declaration("child", { inherit_from: ["parent"] }),
        },
        {
          id: "ac_grant",
          name: "付与",
          fields: [
            {
              id: "silent",
              name: "宣言の無い持ち場",
              type: "reference",
              reference_table: "silent",
            },
            {
              id: "declared",
              name: "宣言した持ち場",
              type: "reference",
              reference_table: "declared",
            },
            {
              id: "disabled",
              name: "止めてある持ち場",
              type: "reference",
              reference_table: "disabled",
            },
            { id: "child", name: "引き継ぐ表", type: "reference", reference_table: "child" },
            { id: "member", name: "相手", type: "reference", reference_table: "ac_member" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
          ],
        },
        {
          id: "ac_member",
          name: "利用者",
          fields: [{ id: "account", name: "ログイン", type: "text" }],
        },
      ],
      views: [],
    },
  } as unknown as Manifest;
}

/**
 * **面の規則を足すのは `plain` と `disabled` の2本だけである** ——
 * **守られている表へ足すと `OR` で面の答えが通り、測りたい壁が測れなくなる。**
 */
function manifestWithRoles(): Manifest {
  const base = manifest();
  const open = new Set(["plain", "disabled"]);
  return withDefaultRoleRules(base, {
    skipTables: base.app.tables.map((table) => table.id).filter((id) => !open.has(id)),
    skipAllViews: true,
  });
}

let dataRoot = "";
let editorUser: ReturnType<typeof seedSession>;
let ownerUser: ReturnType<typeof seedSession>;
let silentRowId = "";
let declaredRowId = "";

function withDb<T>(run: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

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

/** **断られたか / 作られたか** と **断りの文面** —— **突き合わせる粒度はこの2つである。** */
type Outcome = { denied: boolean; errors: ValidationError[] };

function outcomeOf(result: CallToolResult): Outcome {
  if (result.isError !== true) {
    return { denied: false, errors: [] };
  }
  const structured = result.structuredContent as { errors?: ValidationError[] } | undefined;
  return { denied: true, errors: structured?.errors ?? [] };
}

async function createViaWriteRecords(
  table: string,
  actor: string,
  values: Record<string, unknown>,
): Promise<Outcome> {
  return outcomeOf(
    await callTool(
      "write_records",
      { app_id: APP_ID, ops: [{ op: "create", table, values }] },
      actor,
    ),
  );
}

async function createViaInsertSample(
  table: string,
  actor: string,
  rows: Record<string, unknown>[],
): Promise<Outcome> {
  return outcomeOf(
    await callTool("insert_sample_data", { app_id: APP_ID, table_id: table, rows }, actor),
  );
}

/** 行数を数える(**副作用を撃つ前後で比べる**)。 */
function countRows(table: string): number {
  return withDb((db) => {
    const row = db.query(`select count(*) as n from "${table}"`).get() as { n: number };
    return row.n;
  });
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-rccd-mcp-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "既定を閉じる(AI の口)", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, manifestWithRoles()).valid).toBe(true);

  editorUser = seedSession(dataRoot, APP_ID, { role: "editor", username: "editor-user" });
  ownerUser = seedSession(dataRoot, APP_ID, { role: "owner", username: "owner-user" });

  const loaded = manifest();
  withDb((db) => {
    const id = (result: unknown): string => (result as { value: { _id: string } }).value._id;
    const member = (account: string): string =>
      id(createRecord(db, loaded, "ac_member", { account }));
    // **2人とも名簿に載せる** —— **「登録されていない」の断りと混ぜないため。**
    const editorMember = member(editorUser.userId);
    member(ownerUser.userId);

    // **更新 / 削除の材料**(作成の壁とは別の枝であることを見る)。
    silentRowId = id(createRecord(db, loaded, "silent", { title: "既に在る行" }));
    expect(
      createRecord(db, loaded, "ac_grant", {
        silent: silentRowId,
        member: editorMember,
        permission: "writer",
      }).ok,
    ).toBe(true);

    // **区分E の「元になる行」**(引き継ぎ先が実在しないと親の関門で落ちるため)。
    declaredRowId = id(createRecord(db, loaded, "declared", { title: "元になる行" }));
    expect(
      createRecord(db, loaded, "ac_grant", {
        declared: declaredRowId,
        member: editorMember,
        permission: "writer",
      }).ok,
    ).toBe(true);
  });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (A) 区分C —— 一行も書かれていない根の表では、AI の口からも誰も作れない
// ---------------------------------------------------------------------------

describe("V18-M5-T02 (A): 立場が一行も書かれていない根の表では AI の口からも作れない", () => {
  test("(A-1) 名簿に登録済みの一般利用者の `write_records` が断られる", async () => {
    const before = countRows("silent");
    const out = await createViaWriteRecords("silent", editorUser.username, { title: "作る" });
    expect(out.denied).toBe(true);
    expect(countRows("silent")).toBe(before);
  });

  test("(A-2) 同じ表への `insert_sample_data` が断られる", async () => {
    const before = countRows("silent");
    const out = await createViaInsertSample("silent", editorUser.username, [{ title: "作る" }]);
    expect(out.denied).toBe(true);
    expect(countRows("silent")).toBe(before);
  });

  test("(A-3) 運営(owner)でも断られる【`D-V18-28`。例外を1つも置かない】", async () => {
    const before = countRows("silent");
    const byWrite = await createViaWriteRecords("silent", ownerUser.username, { title: "作る" });
    const bySample = await createViaInsertSample("silent", ownerUser.username, [{ title: "作る" }]);
    expect({ byWrite: byWrite.denied, bySample: bySample.denied }).toEqual({
      byWrite: true,
      bySample: true,
    });
    expect(countRows("silent")).toBe(before);
  });

  test("(A-4) 断り文に内部記号が1文字も無い", async () => {
    const out = await createViaWriteRecords("silent", ownerUser.username, { title: "作る" });
    expect(out.denied).toBe(true);
    const text = JSON.stringify(out.errors);
    for (const symbol of [
      "access_control",
      "creatable_by",
      "creatable_by_roles",
      "inherit_from",
      "creator_permission",
      "silent",
      "owner",
      "editor",
      "viewer",
      "judgeRootCreatableRoles",
      "write_records",
      "insert_sample_data",
      "PM-G",
      "AC-G",
      "ADR-",
      "D-V18",
    ]) {
      expect({ symbol, leaked: text.includes(symbol) }).toEqual({ symbol, leaked: false });
    }
  });
});

// ---------------------------------------------------------------------------
// (B) 区分D —— 宣言した表は、挙がっている立場だけが通る
// ---------------------------------------------------------------------------

describe("V18-M5-T02 (B): 宣言した表では、挙がっている立場だけが通る", () => {
  test("(B-1) 挙がっている立場は作れる【陰性対照】", async () => {
    const before = countRows("declared");
    const out = await createViaWriteRecords("declared", editorUser.username, { title: "作る" });
    expect(out.denied).toBe(false);
    expect(countRows("declared")).toBe(before + 1);
  });

  test("(B-2) 挙がっていない立場は断られる", async () => {
    const before = countRows("declared");
    const out = await createViaWriteRecords("declared", ownerUser.username, { title: "作る" });
    expect(out.denied).toBe(true);
    expect(countRows("declared")).toBe(before);
  });

  test("(B-3) 2つの断り文が使い分けられている(挙がっていない / 一行も書いていない)", async () => {
    const notListed = await createViaWriteRecords("declared", ownerUser.username, {
      title: "作る",
    });
    const undeclared = await createViaWriteRecords("silent", ownerUser.username, { title: "作る" });
    expect({ notListed: notListed.denied, undeclared: undeclared.denied }).toEqual({
      notListed: true,
      undeclared: true,
    });
    expect(JSON.stringify(undeclared.errors)).not.toBe(JSON.stringify(notListed.errors));
    // **一行も書かれていない側の文面は「決められており」で始まってはならない。**
    expect(JSON.stringify(undeclared.errors).includes("決められており")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (C) 掛からないところは1バイトも変わらない
// ---------------------------------------------------------------------------

describe("V18-M5-T02 (C): 掛からないところは1バイトも変わらない", () => {
  test("(C-1) 権限管理を一行も宣言していない表は今日どおり作れる【`D-V18-27`】", async () => {
    const before = countRows("plain");
    const out = await createViaWriteRecords("plain", ownerUser.username, { title: "作る" });
    expect(out.denied).toBe(false);
    expect(countRows("plain")).toBe(before + 1);
  });

  test("(C-2) `enabled: false` の表も今日どおり作れる", async () => {
    const before = countRows("disabled");
    const out = await createViaWriteRecords("disabled", ownerUser.username, { title: "作る" });
    expect(out.denied).toBe(false);
    expect(countRows("disabled")).toBe(before + 1);
  });

  test("(C-3) `inherit_from` を宣言し、9キー目を書いていない表では素通りする", async () => {
    const before = countRows("child");
    const out = await createViaWriteRecords("child", editorUser.username, {
      title: "作る",
      parent: declaredRowId,
    });
    expect(out.denied).toBe(false);
    expect(countRows("child")).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------
// (D) 更新と削除には1ミリも掛かっていない
// ---------------------------------------------------------------------------

describe("V18-M5-T02 (D): 更新と削除には1ミリも掛かっていない", () => {
  test("(D-1) `update_record` は通る【陰性対照】", async () => {
    const listed = await callTool(
      "list_records",
      { app_id: APP_ID, table_id: "silent" },
      editorUser.username,
    );
    const rows = (listed.structuredContent as { records: Record<string, unknown>[] }).records;
    const target = rows.find((row) => String(row._id) === silentRowId);
    expect(target).toBeDefined();
    const out = outcomeOf(
      await callTool(
        "update_record",
        {
          app_id: APP_ID,
          table_id: "silent",
          record_id: silentRowId,
          changes: { title: "書き換えた" },
          if_match: String(target?._updated_at),
        },
        editorUser.username,
      ),
    );
    expect(out.denied).toBe(false);
  });

  test("(D-2) `delete_record` は通る【陰性対照】", async () => {
    const listed = await callTool(
      "list_records",
      { app_id: APP_ID, table_id: "silent" },
      editorUser.username,
    );
    const rows = (listed.structuredContent as { records: Record<string, unknown>[] }).records;
    const target = rows.find((row) => String(row._id) === silentRowId);
    expect(target).toBeDefined();
    const before = countRows("silent");
    const out = outcomeOf(
      await callTool(
        "delete_record",
        {
          app_id: APP_ID,
          table_id: "silent",
          record_id: silentRowId,
          if_match: String(target?._updated_at),
        },
        editorUser.username,
      ),
    );
    expect(out.denied).toBe(false);
    expect(countRows("silent")).toBe(before - 1);
  });
});

// ---------------------------------------------------------------------------
// (E) `rows: []` の応答 —— **本葉で変わる。変わることを撃つ**
// ---------------------------------------------------------------------------

describe("V18-M5-T02 (E): 行が0件でも1度は関門を通る", () => {
  test("(E-1) 区分C への `rows: []` は断られる(着手前は成功が返っていた)", async () => {
    const out = await createViaInsertSample("silent", ownerUser.username, []);
    expect(out.denied).toBe(true);
  });

  test("(E-2) 区分A への `rows: []` は今日どおり成功する", async () => {
    const result = await callTool(
      "insert_sample_data",
      { app_id: APP_ID, table_id: "plain", rows: [] },
      ownerUser.username,
    );
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { inserted: unknown[] }).inserted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (F) 2経路一致 —— **断り文が HTTP の口と1文字違わない**
// ---------------------------------------------------------------------------

/**
 * **`app.ts` の断り文の関数は**非 export**なので呼べない。** **源から文字列だけを取り出して
 * 突き合わせる**(同ファイルの写しの作法と同じ理由である)。
 */
function literalsFrom(source: string, fnName: string): { message: string; hint: string } {
  const at = source.indexOf(`function ${fnName}(): ValidationError {`);
  expect({ fnName, found: at >= 0 }).toEqual({ fnName, found: true });
  const body = source.slice(at, source.indexOf("\n}", at));
  const message = /message:\s*\n?\s*"((?:[^"\\]|\\.)*)"/.exec(body);
  const hint = /hint:\s*\n?\s*"((?:[^"\\]|\\.)*)"/.exec(body);
  return { message: message?.[1] ?? "", hint: hint?.[1] ?? "" };
}

describe("V18-M5-T02 (F): AI の口の断り文が HTTP の口と1文字違わない", () => {
  test("(F-1) 2本とも `app.ts` の同名の関数と逐語で一致する", async () => {
    const httpSource = await Bun.file(join(PRODUCT_ROOT, "src", "server", "app.ts")).text();
    const undeclaredHttp = literalsFrom(httpSource, "forbiddenUndeclaredRootCreateError");
    const notListedHttp = literalsFrom(httpSource, "forbiddenRootCreatableRoleError");
    expect(undeclaredHttp.message.length).toBeGreaterThan(0);
    expect(notListedHttp.message.length).toBeGreaterThan(0);

    const undeclared = await createViaWriteRecords("silent", ownerUser.username, { title: "作る" });
    const notListed = await createViaWriteRecords("declared", ownerUser.username, {
      title: "作る",
    });
    expect(undeclared.errors).toEqual([
      { path: "", message: undeclaredHttp.message, hint: undeclaredHttp.hint },
    ]);
    expect(notListed.errors).toEqual([
      { path: "", message: notListedHttp.message, hint: notListedHttp.hint },
    ]);
  });

  test("(F-2) `insert_sample_data` も同じ文面で断る(道具ごとに文面を割らない)", async () => {
    const byWrite = await createViaWriteRecords("silent", ownerUser.username, { title: "作る" });
    const bySample = await createViaInsertSample("silent", ownerUser.username, [{ title: "作る" }]);
    expect(bySample.errors).toEqual(byWrite.errors);
  });
});
