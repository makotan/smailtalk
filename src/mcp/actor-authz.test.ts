/**
 * **名乗った主体の権限で絞る**(`V8-M31-T04` / `T05` / `T06`。台帳 `T-G23a` / `T-G23b` / `T-G24`)。
 *
 * ## この検査が固定するもの
 *
 * 1. **(B) アプリの設定に触る8本**(`apply_diff` / `undo` / `redo` / `delete_app` /
 *    `request_connection` / `request_ai_capability` / `request_inbound_endpoint` /
 *    `request_custom_css`)に、**面(役割に束ねた権限)の `app` × `write` の判定が掛かる。**
 *    **HTTP の `changeAuthMiddleware`(`src/server/app.ts`)と同じ呼び方である。**
 * 2. **(D) 行を書く4本**(`insert_sample_data` / `update_record` / `delete_record` /
 *    `write_records`)に、**その行を書けるかの判定が掛かる。**
 *    **更新・削除は面と点を重ねた合成判定、作成は「作った人に何が渡るか」の下見である。**
 * 3. **(C) `list_records`** に、**行の判定と項目の面**が掛かる。
 * 4. **(A) 群は絞らない** —— **`get_manifest` は今日どおり全定義を返す**(`D-V8-55`)。
 *
 * ## **この検査が固定していないもの(誇張しない)**
 *
 * - **`undo` / `delete_app` は `app` × `write` だけで他人の行を全部消せる。**
 *   **「行を書く4本を絞った」ことは、行が守られたことを意味しない**(計画 §5 の限界1)。
 * - **`preview_undo` / `preview_redo` / `dry_run_diff` は影響行数を返す**(群Aは絞らない)。
 * - **認可であって認証ではない**(`D-V8-54`)。**起動する人は誰の名前でも書ける。**
 *
 * **【2026-08-25 訂正(`V10-M28` / `ADR-0376`)。直前の3行を1バイトも消していない】**
 * **直前の「`dry_run_diff` は影響行数を返す(群Aは絞らない)」は今日は偽である** ——
 * **`dry_run_diff` には `apply_diff` とまったく同じ判定((B)群と同じ `app` × `write`)が
 * 掛かり、権限の無い名乗りでは影響行数を1件も返さない。** **`preview_undo` /
 * `preview_redo` は今日も絞らない**(そちらには壁を足していない)。
 * **`get_manifest` は今日どおり定義の全量を返す**((A) の検査はそのままである)。
 * **2経路が同じ1本の判定を通ることは
 * `src/mcp/app-setting-write-guard.test.ts` が経路ごとに別々の検査で固定する。**
 *
 * ## 土台をカーネルの関数ではなく MCP のツールで作っている理由
 *
 * `scripts/kernel-import-drift.test.ts`(消費側の層またぎのスナップショット)を、この
 * 検査のためだけに太らせないためである(`actor-identity.test.ts` と同じ判断)。
 *
 * ## 題材の形(**なぜこの形でないと測れないか**)
 *
 * **`notes` は行ごとのアクセス権(点)を宣言した表で、面(役割の規則)からは1本も
 * 名指ししていない。** **面から名指しすると、面と点が `OR` で重なって全員が通り、
 * 点の判定が丸ごと無効になる**(`src/server/access-control-optin.test.ts` が
 * `armed_notes` を `skipTables` で外しているのと同じ理由)。
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ValidationError } from "../kernel/index.ts";
import { seedSession } from "../server/test-helpers.ts";
import { createMcpServer } from "./server.ts";

const APP_ID = "workshop";
const NOTES = "notes";
const MEMBERS = "note_member";
const GRANTS = "note_grant";
/**
 * **`V17-M2-T01a`(`AC-G7a` / `ADR-0411`)で足した子の表。**
 *
 * **`inherit_from: ["note"]` を宣言している** —— **この表に行を作るには、`note` が指す
 * 親の行(`notes` の1行)に書き込めなければならない。**
 * **着手前、この表は AI(MCP)からは素通りで作れた**(`docs/plan/v17/03-v17-m2-plan.md` §2-1c)。
 */
const ITEMS = "note_items";
const PREVIEW_BASE_URL = "http://127.0.0.1:3000";

/** 名乗りがあれば通る側(`create_app` は解決しない)。 */
const BOOTSTRAP_ACTOR = "bootstrap";

let dataRoot = "";
/** 持ち主(`owner`)。 */
let alice: ReturnType<typeof seedSession>;
/** 編集者(`editor`)。**メンバー表には居るが、`notes` の面の規則を1本も持たない。** */
let bob: ReturnType<typeof seedSession>;
/** 編集者(`editor`)。**メンバー表に1行も無い。** */
let carol: ReturnType<typeof seedSession>;
/**
 * **2人目の持ち主(`owner`)**(`V8-M31` 第3波で足した)。
 *
 * **なぜ要るのか** —— **付与表への書込の判定(`judgeGrantWrite`)は「自分に権限を付ける」
 * 要求を運営ロールにも許さない**(`D-V7-14`)。**alice 自身の付与は alice には作れない
 * ので、別の持ち主が作る。** **メンバー表には登録しない**(付与の相手にはならないため)。
 */
let dave: ReturnType<typeof seedSession>;

/** 行の `_id` と版(`_updated_at`)。 */
type Row = { id: string; version: string };
let aliceNote: Row;
let bobNote: Row;
/** メンバー表の行の `_id`(付与の相手として名指しする)。 */
let aliceMember = "";
let bobMember = "";

async function connectInMemory(
  actor?: string,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer(
    actor === undefined
      ? { dataRoot, previewBaseUrl: PREVIEW_BASE_URL }
      : { dataRoot, previewBaseUrl: PREVIEW_BASE_URL, actor },
  );
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function callTool(
  name: string,
  args: Record<string, unknown> = {},
  actor?: string,
): Promise<CallToolResult> {
  const { client, close } = await connectInMemory(actor);
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await close();
  }
}

function errorsOf(result: CallToolResult): ValidationError[] {
  expect(result.isError).toBe(true);
  const structured = result.structuredContent as { errors: ValidationError[] } | undefined;
  expect(structured?.errors).toBeDefined();
  return structured?.errors ?? [];
}

function messagesOf(result: CallToolResult): string {
  return errorsOf(result)
    .map((error) => error.message)
    .join(" / ");
}

function okData(result: CallToolResult): Record<string, unknown> {
  if (result.isError === true) {
    throw new Error(`ツールが失敗した: ${JSON.stringify(result.structuredContent)}`);
  }
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

/** `insert_sample_data` を呼び、**1件も落ちていないこと**を確かめて作られた行を返す。 */
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

function rowOf(record: Record<string, unknown>): Row {
  return { id: String(record._id), version: String(record._updated_at) };
}

/** 3つの権限名(`reader` は今日どの付与も使っていないが、値域として宣言しておく)。 */
const PERMISSIONS = [
  { id: "reader", name: "読める", read: true, write: false, delete: false },
  { id: "writer", name: "書ける", read: true, write: true, delete: false },
  { id: "manager", name: "消せる", read: true, write: true, delete: true },
];

/** 表を3つ足す差分(`notes` だけが点を宣言する)。 */
const setupTables = {
  diff_id: "setup-tables",
  intent: "メモ・利用者・付与の3表を用意する",
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
        id: NOTES,
        name: "メモ",
        fields: [
          { id: "title", name: "題", type: "text", required: true },
          { id: "secret", name: "内緒", type: "text" },
        ],
        access_control: {
          enabled: true,
          permissions: PERMISSIONS,
          creator_permission: "writer",
          // **【`V18-M5-T02b` / `PM-G3` / `ADR-0442`】題材に1行足した(主張は1バイトも
          // 書き換えていない)。** **根の表に「行を作れる立場」を一行も書かないときの
          // 既定が「誰も作れない」へ反転し、AI の口にも同じ関門が掛かったので**
          // (`ADR-0432` §Decision)、**前準備の `insert_sample_data`(`alice` = 持ち主)が
          // 断られて本ファイルの40本が丸ごと巻き込まれていた。**
          // **`editor` も挙げている** —— **`bob`(編集者)が作れることを測る
          // `(AC-G7a-0)` と、`carol`(編集者。名簿に居ない)が**名簿の側で**断られる
          // ことを測る `(D)` が、どちらもこの関門より先へ進む必要があるからである。**
          creatable_by_roles: ["owner", "editor"],
          grant: { table: GRANTS, target: "note", member: "member", permission: "permission" },
          members: { table: MEMBERS, account: "account" },
        },
      },
    },
    {
      op: "add_table",
      table: {
        id: GRANTS,
        name: "付与",
        fields: [
          { id: "note", name: "メモ", type: "reference", reference_table: NOTES },
          // **【`V17-M2-T01a` が足した1項目】** **子の表({@link ITEMS})の付与の宛先。**
          // **既存の3項目は1バイトも変えていない。**
          { id: "item", name: "項目", type: "reference", reference_table: ITEMS },
          { id: "member", name: "相手", type: "reference", reference_table: MEMBERS },
          {
            id: "permission",
            name: "権限",
            type: "select",
            options: ["reader", "writer", "manager"],
          },
        ],
      },
    },
    /**
     * **【`V17-M2-T01a`(`AC-G7a` / `ADR-0411`)が足した表】**
     *
     * **親(`notes`)の行に書ける人だけが作れる、と宣言した子の表である。**
     * **面(役割の規則)からは1本も名指ししない** —— **名指しすると面と点が `OR` で
     * 重なって親の関門ごと無効になる**(この検査の題材の形の理由と同じである)。
     */
    {
      op: "add_table",
      table: {
        id: ITEMS,
        name: "メモの項目",
        fields: [
          { id: "label", name: "見出し", type: "text", required: true },
          { id: "note", name: "メモ", type: "reference", reference_table: NOTES },
        ],
        access_control: {
          enabled: true,
          permissions: PERMISSIONS,
          creator_permission: "writer",
          grant: { table: GRANTS, target: "item", member: "member", permission: "permission" },
          members: { table: MEMBERS, account: "account" },
          inherit_from: ["note"],
        },
      },
    },
  ],
};

/**
 * 役割の規則を書き直す差分。
 *
 * **`notes` を1本も名指ししない** —— **名指しすると面と点が `OR` で重なり、
 * 点の判定(この検査の主題)が丸ごと無効になる。**
 * **`secret` は持ち主にだけ見せる**(項目の面。`projectForRoleFields` の測定に使う)。
 */
const setupRoles = {
  diff_id: "setup-roles",
  intent: "面の規則を、この検査の題材の形に書き直す",
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
            // **【第3波で `"write"` を足した】** —— **項目単位の**書込**の判定
            // (`judgeRoleFieldWrite`)が入ったので、`["read"]` だけでは持ち主も
            // `secret` を書けない。** **旧(逐語): `can: ["read"]`。**
            // **`bob` は今日も1本も持たない**(読みも書きも通らない側の測定に使う)。
            { target: "field", table: NOTES, field: "secret", can: ["read", "write"] },
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

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-mcp-authz-"));
  okData(await callTool("create_app", { name: "作業場", app_id: APP_ID }, BOOTSTRAP_ACTOR));

  alice = seedSession(dataRoot, APP_ID, { username: "alice" });
  bob = seedSession(dataRoot, APP_ID, { username: "bob", role: "editor" });
  carol = seedSession(dataRoot, APP_ID, { username: "carol", role: "editor" });
  dave = seedSession(dataRoot, APP_ID, { username: "dave" });

  okData(await callTool("apply_diff", { app_id: APP_ID, diff: setupTables }, alice.username));
  okData(await callTool("apply_diff", { app_id: APP_ID, diff: setupRoles }, alice.username));

  // メンバー表(alice と bob だけを登録する。**carol は登録しない**)。
  const members = await insert(
    MEMBERS,
    [{ account: alice.userId }, { account: bob.userId }],
    alice.username,
  );
  aliceMember = String((members[0] as Record<string, unknown>)._id);
  bobMember = String((members[1] as Record<string, unknown>)._id);

  // メモ2件(**作るのは alice。作成者への付与は MCP では入らない**ので、次の付与を明示的に書く)。
  const notes = await insert(
    NOTES,
    [
      { title: "alice のメモ", secret: "あ" },
      { title: "bob のメモ", secret: "い" },
    ],
    alice.username,
  );
  aliceNote = rowOf(notes[0] as Record<string, unknown>);
  bobNote = rowOf(notes[1] as Record<string, unknown>);

  // **付与2件。** **alice 自身への付与は alice には作れない**(`judgeGrantWrite` の `self`)
  // ので、**2人目の持ち主 `dave` が作る。** **bob への付与は alice が作る**(通る側の実測を
  // 土台に含めるため)。
  await insert(
    GRANTS,
    [{ note: aliceNote.id, member: aliceMember, permission: "manager" }],
    dave.username,
  );
  await insert(
    GRANTS,
    [{ note: bobNote.id, member: bobMember, permission: "writer" }],
    alice.username,
  );
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

// ===========================================================================
// (A) 群 —— **絞らない**(`D-V8-55`)
// ===========================================================================

test("(A) get_manifest は今日どおり全定義を返す(D-V8-55。編集者でも絞られない)", async () => {
  const data = okData(await callTool("get_manifest", { app_id: APP_ID }, bob.username));
  const manifest = data.manifest as { app: { tables: { id: string }[]; roles: { id: string }[] } };
  // **【`V17-M2-T01a` による更新(2026-09-07)。旧の期待値を逐語で残す】** ——
  // **旧: `[GRANTS, MEMBERS, NOTES].sort()`。** **`T01a` が題材に子の表({@link ITEMS})を
  // 1つ足したので、全定義の中の表が4本になった。** **この検査が測っているもの
  // (編集者を名乗っても定義が1つも絞られない)は1ミリも変わっていない。**
  expect(manifest.app.tables.map((table) => table.id).sort()).toEqual(
    [GRANTS, MEMBERS, NOTES, ITEMS].sort(),
  );
  // **点を宣言した表の定義も、面の規則の全量も、編集者にそのまま見える。**
  expect(manifest.app.roles.map((role) => role.id).sort()).toEqual(
    ["editor", "owner", "viewer"].sort(),
  );
});

// ===========================================================================
// (B) 群 —— **アプリの設定に触る8本**
// ===========================================================================

test("(B) 編集者を名乗ると apply_diff が断られ、持ち主なら通る", async () => {
  const diff = {
    diff_id: "d-add-field",
    intent: "メモに覚え書きを足したい",
    operations: [
      { op: "add_field", table: NOTES, field: { id: "memo", name: "覚え書き", type: "text" } },
    ],
  };
  const denied = await callTool("apply_diff", { app_id: APP_ID, diff }, bob.username);
  expect(messagesOf(denied)).toContain("アプリの作りを変更できるのは");

  // **持ち主は通る**(拒否側だけを測ると、全部拒否しても緑になる)。
  okData(await callTool("apply_diff", { app_id: APP_ID, diff }, alice.username));
});

test("(B) 8本すべてが、編集者の名乗りでは断られる", async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = [
    {
      name: "apply_diff",
      args: {
        app_id: APP_ID,
        diff: { diff_id: "d-x", intent: "何か変える", operations: [] },
      },
    },
    { name: "undo", args: { app_id: APP_ID } },
    { name: "redo", args: { app_id: APP_ID } },
    { name: "delete_app", args: { app_id: APP_ID } },
    {
      name: "request_connection",
      args: { app_id: APP_ID, name: "c", purpose: "p", hosts: ["api.example.com"] },
    },
    { name: "request_ai_capability", args: { app_id: APP_ID, name: "a", purpose: "p" } },
    {
      name: "request_inbound_endpoint",
      args: { app_id: APP_ID, name: "i", purpose: "p", target_table: NOTES },
    },
    { name: "request_custom_css", args: { app_id: APP_ID, name: "s", purpose: "p", views: [] } },
    // **【2026-08-25。`V10-M30-T02`。台帳 `CM-G37` / `ADR-0378`】9本目をここへ書き足した。**
    // **`denyAppSettingWrite`(`app` × `write` の壁)を通る道具が1本増えたためである。**
    // **この配列は手書きであり、書き足さなければ 8 のまま緑で通る**(`ALL_TOOL_CALLS` と
    // 同じ「黙って古くなる」型)—— **書き足したことを記録に1行で書いた。**
    // **テスト名(「8本すべてが」)は1バイトも書き換えていない**(「8本」は 2026-08-24
    // までの事実である)。
    { name: "set_comment_visibility", args: { app_id: APP_ID, comment_write: false } },
  ];
  // **【2026-08-25。`V10-M30-T02`】期待値を 8 → 9 へ書き換えた。**
  // **旧行の逐語**: `expect(calls).toHaveLength(8);`
  expect(calls).toHaveLength(9);
  const passed: string[] = [];
  for (const call of calls) {
    const result = await callTool(call.name, call.args, bob.username);
    if (result.isError !== true || !messagesOf(result).includes("アプリの作りを変更できるのは")) {
      // **通ってしまったものを名前で出す**(件数だけにしない)。
      passed.push(call.name);
    }
  }
  expect(passed).toEqual([]);

  // **アプリは1バイトも変わっていない**(`delete_app` が消せていない)。
  okData(await callTool("get_manifest", { app_id: APP_ID }, bob.username));
});

// ===========================================================================
// (D) 群 —— **行を書く4本**
// ===========================================================================

test("(D) 他人の行は update_record できない(見えない行として断る)", async () => {
  const denied = await callTool(
    "update_record",
    {
      app_id: APP_ID,
      table_id: NOTES,
      record_id: bobNote.id,
      if_match: bobNote.version,
      changes: { title: "乗っ取り" },
    },
    alice.username,
  );
  expect(messagesOf(denied)).toContain("存在しません");
});

test("(D) 自分の行は update_record できる", async () => {
  const data = okData(
    await callTool(
      "update_record",
      {
        app_id: APP_ID,
        table_id: NOTES,
        record_id: aliceNote.id,
        if_match: aliceNote.version,
        changes: { title: "書き換えた" },
      },
      alice.username,
    ),
  );
  expect((data.record as Record<string, unknown>).title).toBe("書き換えた");
});

test("(D) 他人の行は delete_record できない", async () => {
  const denied = await callTool(
    "delete_record",
    { app_id: APP_ID, table_id: NOTES, record_id: bobNote.id, if_match: bobNote.version },
    alice.username,
  );
  expect(messagesOf(denied)).toContain("存在しません");
});

test("(D) 見えていても「消す」を持たない相手は delete_record できない", async () => {
  // **bob は自分の行を書き換えられる(`writer`)が、消す権限は持っていない。**
  const denied = await callTool(
    "delete_record",
    { app_id: APP_ID, table_id: NOTES, record_id: bobNote.id, if_match: bobNote.version },
    bob.username,
  );
  expect(messagesOf(denied)).toContain("消す権限がありません");
});

test("(D) 自分の行は delete_record できる(manager は消せる)", async () => {
  okData(
    await callTool(
      "delete_record",
      { app_id: APP_ID, table_id: NOTES, record_id: aliceNote.id, if_match: aliceNote.version },
      alice.username,
    ),
  );
});

test("(D) メンバー表に居ない人は insert_sample_data で行を作れない", async () => {
  const denied = await callTool(
    "insert_sample_data",
    { app_id: APP_ID, table_id: NOTES, rows: [{ title: "carol のメモ" }] },
    carol.username,
  );
  expect(messagesOf(denied)).toContain("メンバー表に登録されていない");

  // **1行も書かれていない**(契約1)。
  const listed = okData(
    await callTool("list_records", { app_id: APP_ID, table_id: NOTES }, alice.username),
  );
  expect(listed.total).toBe(1);
});

test("(D) write_records は1件でも拒否があればバッチ全体が落ちる(裁定 M31-5)", async () => {
  const denied = await callTool(
    "write_records",
    {
      app_id: APP_ID,
      ops: [
        {
          op: "update",
          table: NOTES,
          target: aliceNote.id,
          if_match: aliceNote.version,
          values: { title: "通るはずだった1件目" },
        },
        {
          op: "update",
          table: NOTES,
          target: bobNote.id,
          if_match: bobNote.version,
          values: { title: "他人の行" },
        },
      ],
    },
    alice.username,
  );
  expect(denied.isError).toBe(true);

  // **通るはずだった1件目も1バイトも書かれていない。**
  const listed = okData(
    await callTool("list_records", { app_id: APP_ID, table_id: NOTES }, alice.username),
  );
  const records = listed.records as Record<string, unknown>[];
  expect(records).toHaveLength(1);
  expect(records[0]?.title).toBe("alice のメモ");
});

test("(D) write_records は空の ops を今日どおり受ける(HTTP と同じ向き。関門を0回通る)", async () => {
  okData(await callTool("write_records", { app_id: APP_ID, ops: [] }, carol.username));
});

test("(D) write_records は全件通れば書ける", async () => {
  okData(
    await callTool(
      "write_records",
      {
        app_id: APP_ID,
        ops: [
          {
            op: "update",
            table: NOTES,
            target: aliceNote.id,
            if_match: aliceNote.version,
            values: { title: "まとめて書き換えた" },
          },
        ],
      },
      alice.username,
    ),
  );
});

test("(D) write_records は実在しない表を「存在しません」で断る(第5波・裁定 M31-12 の適用)", async () => {
  // **`bob`(編集者)は `nope` に対する面の規則を1本も持たない** —— **旧(第2波〜第4波)は
  // `denyRoleTableWrite` が最初の関門だったので、表IDのタイプミスに権限の断りが返り、
  // `allowed_values` が付かず、AI が自分で直せなかった。**
  // **旧の文面を逐語で残す**(第5波で実測した): **「表 "nope" に対する書き込みは、
  // あなたの役割に許されていません。」**
  //
  // **第4波は `update_record` / `delete_record` だけを揃えたので、`write_records` だけが
  // 逆を向いていた。** **第5波でこの1本も揃えた**(裁定 `M31-12`)。
  const denied = await callTool(
    "write_records",
    {
      app_id: APP_ID,
      ops: [{ op: "create", table: "nope", values: { title: "打ち間違えた表" } }],
    },
    bob.username,
  );
  const errors = errorsOf(denied);
  expect(messagesOf(denied)).toContain("存在しません");
  // **自己訂正の材料が付いている**(`ADR-0005`)—— **権限の断りには付かない。**
  // **【`V17-M2-T01a` による更新(2026-09-07)。旧の期待値を逐語で残す】** ——
  // **旧: `expect(errors[0]?.allowed_values).toEqual([MEMBERS, NOTES, GRANTS]);`。**
  // **`T01a` が題材に子の表({@link ITEMS})を1つ足したので、実在する表の一覧が4本になった。**
  // **この検査が測っているもの(実在しない表を「存在しません」で断り、自己訂正の材料を付ける)は
  // 1ミリも変わっていない。**
  expect(errors[0]?.allowed_values).toEqual([MEMBERS, NOTES, GRANTS, ITEMS]);
  // **権限の断りに落ちていない**(並びが逆なら、こちらの文面が返る)。
  expect(messagesOf(denied)).not.toContain("あなたの役割に許されていません");
  // **断りは1件だけである**(実在検査で抜けているので、権限の断りが後ろに積まれない)。
  expect(errors).toHaveLength(1);
});

// ===========================================================================
// (D-#1) **付与表への書込の判定**(`judgeGrantWrite`。第3波で入った)
// ===========================================================================
//
// **第2波はここに1バイトも判定を持っていなかった** —— **面が付与表への書込を許している
// 相手は、MCP から自分に任意の権限を付けられた**(`m31-wave2.md` §7 の差1)。
// **今日は HTTP の単件 `POST` / `PATCH` / `DELETE` / バッチと同じ判定を通る。**
//
// **【この判定が止めていないもの。誇張しない】** —— **付与表の**読取**は1ミリも絞って
// いない。** **メンバー表・グループ表への書込は「運営ロール以外を止める」だけである。**

test("(D-#1) 持ち主でも、自分に権限を付ける付与は insert_sample_data で作れない", async () => {
  const denied = await callTool(
    "insert_sample_data",
    {
      app_id: APP_ID,
      table_id: GRANTS,
      rows: [{ note: bobNote.id, member: aliceMember, permission: "manager" }],
    },
    alice.username,
  );
  expect(messagesOf(denied)).toContain("自分に権限を付けることはできません");

  // **1行も増えていない**(契約1)。**土台の2件のままである。**
  const listed = okData(
    await callTool("list_records", { app_id: APP_ID, table_id: GRANTS }, alice.username),
  );
  expect(listed.total).toBe(2);
});

test("(D-#1) 他人への付与は今日どおり作れる(通る側も測る)", async () => {
  await insert(
    GRANTS,
    [{ note: aliceNote.id, member: bobMember, permission: "reader" }],
    alice.username,
  );
  const listed = okData(
    await callTool("list_records", { app_id: APP_ID, table_id: GRANTS }, alice.username),
  );
  expect(listed.total).toBe(3);
});

test("(D-#1) write_records からも、自分に権限を付ける付与は作れない", async () => {
  const denied = await callTool(
    "write_records",
    {
      app_id: APP_ID,
      ops: [
        {
          op: "create",
          table: GRANTS,
          values: { note: bobNote.id, member: aliceMember, permission: "manager" },
        },
      ],
    },
    alice.username,
  );
  expect(messagesOf(denied)).toContain("自分に権限を付けることはできません");
  const listed = okData(
    await callTool("list_records", { app_id: APP_ID, table_id: GRANTS }, alice.username),
  );
  expect(listed.total).toBe(2);
});

// ===========================================================================
// (D-#2) **項目単位の書込の判定**(`judgeRoleFieldWrite`。第3波で入った)
// ===========================================================================
//
// **第2波は読取側(`projectForRoleFields`)だけを入れていた** —— **見せないと宣言した
// 項目が応答から伏せられるのに、同じ項目に書けてしまう非対称が残っていた**
// (`m31-wave2.md` §7 の差2)。**今日は書込にも同じ規則が掛かる。**
//
// **【HTTP と同じ穴を引き継ぐ】** —— **`delete_record` にはこの判定を1バイトも掛けて
// いない**(HTTP の `DELETE` も掛けていない。`src/server/access-control-delete.test.ts`
// の `(E-1)` がそれを固定している)。

test("(D-#2) 書けないと宣言した項目は update_record で断られる(自分の行でも)", async () => {
  // **bob は自分の行を書き換えられる(`writer`)が、`secret` を書く規則を1本も持たない。**
  const denied = await callTool(
    "update_record",
    {
      app_id: APP_ID,
      table_id: NOTES,
      record_id: bobNote.id,
      if_match: bobNote.version,
      changes: { secret: "書けるはずがない" },
    },
    bob.username,
  );
  expect(messagesOf(denied)).toContain('項目 "secret" に対する書き込み');

  // **1バイトも書かれていない**(持ち主から読み直して確かめる)。
  const listed = okData(
    await callTool("list_records", { app_id: APP_ID, table_id: NOTES }, alice.username),
  );
  expect((listed.records as Record<string, unknown>[])[0]?.secret).toBe("あ");
});

test("(D-#2) 書ける相手は update_record でその項目を書ける", async () => {
  const data = okData(
    await callTool(
      "update_record",
      {
        app_id: APP_ID,
        table_id: NOTES,
        record_id: aliceNote.id,
        if_match: aliceNote.version,
        changes: { secret: "う" },
      },
      alice.username,
    ),
  );
  expect((data.record as Record<string, unknown>).secret).toBe("う");
});

test("(D-#2) 書けない項目は insert_sample_data でも断られる(1行も入らない)", async () => {
  const denied = await callTool(
    "insert_sample_data",
    {
      app_id: APP_ID,
      table_id: NOTES,
      rows: [{ title: "bob の新しいメモ", secret: "え" }],
    },
    bob.username,
  );
  expect(messagesOf(denied)).toContain('項目 "secret" に対する書き込み');

  const listed = okData(
    await callTool("list_records", { app_id: APP_ID, table_id: NOTES }, bob.username),
  );
  expect(listed.total).toBe(1);
});

test("(D-#2) 書けない項目は write_records でも断られる(バッチ全体が落ちる)", async () => {
  const denied = await callTool(
    "write_records",
    {
      app_id: APP_ID,
      ops: [
        {
          op: "update",
          table: NOTES,
          target: bobNote.id,
          if_match: bobNote.version,
          values: { secret: "お" },
        },
      ],
    },
    bob.username,
  );
  expect(messagesOf(denied)).toContain('項目 "secret" に対する書き込み');
});

// ===========================================================================
// (AC-G7a) **親の行に書ける人だけが作れる、を AI(MCP)の作成2本にも掛けた**
// (`V17-M2-T01a` / `T01b`。`ADR-0411` §Decision の 2 / ユーザ決定 `D-V16-4`
//  の逐語「**全部の入口に立てる**」)
//
// ## **着手前(`T01a`)の実測 —— この4本は赤だった**
//
// **同じ人(`bob`)が、同じ子の表に、同じ親(`alice` のメモ)を指して**:
//
//  - **HTTP の単件 `POST`** … **403**(`src/server/create-parent-write.test.ts` の `(a-3)`)
//  - **AI(MCP)の `write_records` の `create` op** … **通っていた**(行が1件できた)
//  - **AI(MCP)の `insert_sample_data`** … **通っていた**(行が1件できた)
//
// **`T01b` の後、下2つは 上と同じ断りになる。**
//
// ## **この節が測っていないもの(誇張しない)**
//
//  - **更新には1バイトも掛かっていない**(`ADR-0411` 限定4)—— **`update_record` /
//    `write_records` の `update` op は、親の参照を書き入れても付け替えても今日も問われない。**
//  - **`insert_sample_data` は今日も部分成功を返す道具である** —— **親の関門で止まったときは
//    部分成功にせず、`isError` で「1行も書いていない」を返す**(契約1。下の `(AC-G7a-3)`)。
// ===========================================================================

/** 子の表({@link ITEMS})の行を、名乗った人として `write_records` の `create` op で作る。 */
function createItemViaWriteRecords(
  label: string,
  parentNoteId: string,
  actor: string,
): Promise<CallToolResult> {
  return callTool(
    "write_records",
    {
      app_id: APP_ID,
      ops: [{ op: "create", table: ITEMS, values: { label, note: parentNoteId } }],
    },
    actor,
  );
}

/** 子の表の行数を、その親に権限を持つ名乗りで数える(見えない行を0と数えないため)。 */
async function itemCountFor(actor: string): Promise<number> {
  const listed = okData(await callTool("list_records", { app_id: APP_ID, table_id: ITEMS }, actor));
  return listed.total as number;
}

test("(AC-G7a-0)【`T00` のベースライン】`inherit_from` を宣言していない表への MCP の作成は1ミリも変わらない", async () => {
  // **`notes` は `inherit_from` を1本も宣言していない**(親を持たない表である)。
  // **`ADR-0411` 限定7 の相手になる着手前の応答は、この2つである。**
  const inserted = await insert(NOTES, [{ title: "bob が入れたメモ" }], bob.username);
  expect(inserted).toHaveLength(1);

  const written = okData(
    await callTool(
      "write_records",
      {
        app_id: APP_ID,
        ops: [{ op: "create", table: NOTES, values: { title: "bob がまとめ書きしたメモ" } }],
      },
      bob.username,
    ),
  );
  expect((written.records as unknown[]).length).toBe(1);
});

test("(AC-G7a-1) 親の行に書けない人は、write_records の create op で子の行を作れない", async () => {
  // **`bob` は参加者の表に居る**(= 作成の下見は通る)。
  // **`alice` のメモへの付与は1件も持たない** —— **止めるのは親の関門だけである。**
  const denied = await createItemViaWriteRecords("横から", aliceNote.id, bob.username);
  expect(denied.isError).toBe(true);
  expect(messagesOf(denied)).toContain("元になる行");

  // **1バイトも書かれていない。** **数えるのは、その親に権限を持つ `alice` である。**
  expect(await itemCountFor(alice.username)).toBe(0);
});

test("(AC-G7a-2) 親の行に書ける人なら、同じ create op が通る(絞りすぎていない)", async () => {
  // **`bob` は自分のメモ(`bobNote`)に `writer` を持つ。**
  okData(await createItemViaWriteRecords("自分の親へ", bobNote.id, bob.username));
  expect(await itemCountFor(bob.username)).toBe(1);
});

test("(AC-G7a-3) 親の行に書けない人は insert_sample_data でも作れない(1行も入らない)", async () => {
  const denied = await callTool(
    "insert_sample_data",
    { app_id: APP_ID, table_id: ITEMS, rows: [{ label: "横から", note: aliceNote.id }] },
    bob.username,
  );
  expect(denied.isError).toBe(true);
  expect(messagesOf(denied)).toContain("元になる行");
  expect(await itemCountFor(alice.username)).toBe(0);
});

test("(AC-G7a-4) insert_sample_data は1行でも断られたら1行も書かない(契約1。部分成功に混ぜない)", async () => {
  // **1件目は通る親、2件目は通らない親である** —— **行ループの外で1度だけ問う形のままでは
  // 測れない**(親の関門は行の中身を見る)。
  const denied = await callTool(
    "insert_sample_data",
    {
      app_id: APP_ID,
      table_id: ITEMS,
      rows: [
        { label: "自分の親へ", note: bobNote.id },
        { label: "横から", note: aliceNote.id },
      ],
    },
    bob.username,
  );
  expect(denied.isError).toBe(true);
  // **通るはずだった1件目も書かれていない。**
  expect(await itemCountFor(bob.username)).toBe(0);
  expect(await itemCountFor(alice.username)).toBe(0);
});

// **【`V17-M2-T08a`。`ADR-0411` 限定4 の【実装時に置く】検査の、AI(MCP)の側】**
//
// **限定4 の逐語**: **「更新側の射程を1ミリも広げない。本単位が触るのは『作る』だけである」。**
// **条文は【実装時に置く】の欄に「**源を走査する検査**」と書いているが、`write.ts` の側は
// 源を読んでも測れない** —— **関門は `denyRecordCreate`(作成専用のヘルパ)の中に在り、
// その中身を読んで「更新では呼ばれない」と言うには、呼び出し元(2箇所)まで辿った上で
// 「この2箇所は作成の op だけを通る」を源で示す必要がある。** **同じ理由で
// `src/server/automation-access-control.test.ts` の `(AC-G7a-11)` / `(AC-G7a-12)` も
// 走査ではなく**実行**で撃っている。** **本検査もそれに揃える。**
//
// **【この検査は「塞いだ」ではなく「塞いでいない」の記録である】** —— **緑であることを
// 「安全になった」と読まないこと。** **AI から親を付け替える道は今日も開いている。**
//
// =====================================================================================
// **【`V18-M6-T02b`(2026-09-13)の訂正。上の段落を1バイトも消していない】**
//
// **直前の2行(「AI から親を付け替える道は今日も開いている」)は今日は偽である。**
// **`V18-M6-T02` が `write_records` の `update` op にも親の関門を配線し、
// `V18-M6-T01` が**移す前の親**に要求する動詞を `write` から `delete` へ上げたので、
// この経路は今日は断られる。** **根拠は `ADR-0443`(`ADR-0433` 限定4 を引き直した)と
// ユーザ決定 `D-V18-29`。**
//
// **したがって、テスト名の断り「【塞いでいない。限定4 のとおり】」も今日は偽である** ——
// **本単位が改名した。** **旧のテスト名を逐語でここに残す(1バイトも消していない)**:
//   `test("(AC-G7a-4b)【塞いでいない。限定4 のとおり】write_records の update op は親を別の親へ付け替えられる", async () => {`
// **旧の式も逐語で残す**:
//   `expect(moved.isError).toBeFalsy();`
//   `// **`alice` の壁の内側に、`alice` の同意なしで行が1件入った。**`
//   `expect(await itemCountFor(alice.username)).toBe(1);`
//
// **【実物を撃って確かめた。推測で書いていない】** —— **断られたときの応答本文は
// 逐語で下の式に置いてある**(`structuredContent.errors[0]`):
//   message: 「この行を別の元の行へ移すには、移す前の元の行にも書き込める必要があります。
//             あなたには、移す前の元の行を書き換える権限がありません。」
//   hint:    「移す前の元の行の権限を持っている人に、あなたへその行の書き込みの権限を
//             渡してもらってください(移した先の元の行に書き込めるだけでは移せません。
//             役割を変えても移せるようにはなりません)。」
// **【`V18-M6-T03b`(2026-09-13)の訂正。上の6行を1バイトも消していない】** ——
// **上に逐語で写した `message` / `hint` は今日は出ない** —— **`V18-M6-T03b` が、
// 「書き込める必要があります」と述べる旧文を、今日の実装(消せる権限)に合わせて
// 差し替えたためである。** **今日の文面の源は `src/server/app.ts` の
// `forbiddenPreviousParentAccessError` で、下の式が撃つ逐語がその一部である。**
// **断り文の**種類**は1本も増えていない** —— **既存の1本が差し替わっただけである。**
//
// **【止めたのがどちらの腕かを、隠さずに書く】** —— **止めたのは**移す前の親**の腕である。**
// **`bob` は `bobNote` に `writer` を持つが、`V18-M6-T01` が古い親に要求する動詞を
// `delete` へ上げたので、`writer` では足りない。** **新しい親(`aliceNote`)の腕まで
// 到達していない** —— **仮に古い親の腕が通っても、そこで断られる**(`(AC-G7a-1)` と同じ
// `元になる行` の文面)が、**この検査はそこを撃っていない。**
//
// **【誇張しない】** **塞がったのは AI の口の更新2本だけである** ——
// **受信口 / 自動処理 / 島 / 時刻起動 は今日も素通りする**(`D-V18-6`)。
// **参照を**空にする**更新も今日どおり通る**(`AC-G9` は却下。`ADR-0411` 限定10)。
// **`delete_record` にも1バイトも掛かっていない。** **【禁止】「安全になった」と書かない。**
//
// **【この葉が授権の表の外に出ていることを、隠さずここに書く】**
// **`ADR-0443` 授権の表 行9 は「`(AC-G7a-4b)`(実行で撃つ側)を**1バイトも触らない**」と
// 書いている。** **その行は「`(AC-G7a-4b)` は赤くならない」という見込みの上に書かれており、
// その見込みが外れた**(実測: `expect(received).toBeFalsy()` / `Received: true`)。
// **本単位はメインの裁定で反転を実施した** —— **すなわち、授権の表の1行が**実装より後に**
// 直されたということである。** **`ADR-0443` の本文は1バイトも書き換えていない**
// (訂正は `V18-M6-T04` が末尾に足す)。
// **`test(` を1本も削っていない。`.skip` にしていない。条件を1ミリも緩めていない。**
// =====================================================================================
test("(AC-G7a-4b)【`V18-M6-T02` が塞いだ】write_records の update op は、移す前の親に delete を持たない人の付け替えを断る", async () => {
  // **`bob` は自分のメモ(`bobNote`)には書ける** —— **ここは関門を通る。**
  const [created] = await insert(ITEMS, [{ label: "あとで移す", note: bobNote.id }], bob.username);
  const item = rowOf(created as Record<string, unknown>);
  expect(await itemCountFor(bob.username)).toBe(1);

  // **`bob` は `alice` のメモに1件の付与も持たない** —— **同じ親を指して**作る**ことは
  // `(AC-G7a-1)` / `(AC-G7a-3)` のとおり今日は断られる。**
  // **それでも、既に在る行の参照を**そこへ付け替える**ことは今日も通る。**
  // **【`V18-M6-T02b` の訂正。直前の1行を1バイトも消していない】** ——
  // **直前の「今日も通る」は今日は偽である**(`ADR-0443` / `D-V18-29`)。
  const moved = await callTool(
    "write_records",
    {
      app_id: APP_ID,
      ops: [
        {
          op: "update",
          table: ITEMS,
          target: item.id,
          if_match: item.version,
          values: { note: aliceNote.id },
        },
      ],
    },
    bob.username,
  );
  // **【`V18-M6-T02b` が反転した。旧の式を逐語で残す。1バイトも消していない】**
  // **旧**: `expect(moved.isError).toBeFalsy();`
  expect(moved.isError).toBe(true);
  // **断られたときの文面を逐語で撃つ**(写しではなく、実際に撃って得た本文である)。
  // **【`V18-M6-T03b` が打ち直した。旧の式を逐語で残す。1バイトも消していない】**
  // **旧**: `expect(messagesOf(moved)).toContain("移す前の元の行を書き換える権限がありません");`
  expect(messagesOf(moved)).toContain("移す前の元の行を消す権限がありません");

  // **`alice` の壁の内側に、`alice` の同意なしで行が1件入った。**
  // **【`V18-M6-T02b` が反転した。直前の1行と旧の式を逐語で残す。1バイトも消していない】**
  // **旧**: `expect(await itemCountFor(alice.username)).toBe(1);`
  // **直前の「行が1件入った」は今日は偽である** —— **`alice` の壁の内側は今日 0 件のままである。**
  expect(await itemCountFor(alice.username)).toBe(0);
  // **元の親の側も1ミリも動いていない** —— **付け替えは丸ごと起きていない。**
  expect(await itemCountFor(bob.username)).toBe(1);
});

// **【`V18-M6-T02`(2026-09-13)/ `PM-G2` / `ADR-0443` 授権の表 行9 が改名した。
//    旧のテスト名を逐語でここに残す。1バイトも消していない】**
// **旧**: `test("(AC-G7a-4c) 関門は作成専用のヘルパの中にしか無い(`AC-G8` の古い親の判定も1件も無い)", ...)`
// **旧の名前は今日は偽である** —— **`V18-M6-T02` が、この道具の**更新**2本
// (`update_record` と `write_records` の `update` op)にも同じ関門を配線したので、
// 綴りは 1 件から **3** 件になり、`previous:` も渡されるようになった。**
// **測っている中身は1ミリも緩めていない** —— **「作成の1件が作成専用のヘルパの本体の
// 中に在る」ことは今日も同じ式で撃っており、そこは1バイトも書き換えていない。**
test("(AC-G7a-4c) 関門の綴りは3件で、作成の1件は作成専用のヘルパの中に在る(更新2本にも渡っている)", async () => {
  // **限定4 の「源を走査する」側を、測れる範囲だけで撃つ。**
  // **測れるのは「関門を呼ぶヘルパが作成専用である」ことまでであり、
  // 「更新の枝で呼ばれない」ことそのものではない**(上の `(AC-G7a-4b)` が実行で撃つ)。
  const source = await Bun.file(join(import.meta.dir, "tools", "write.ts")).text();
  const gateCall = `${["judge", "Create", "Parent", "Access"].join("")}(`;
  // **綴りは1件ちょうど**(`ADR-0411` 限定12 の内訳。`write.ts` は 1)。
  // **【`V18-M6-T02` が 1 から 3 へ上げた。旧の式を逐語で残す】**
  // **旧**: `expect(source.split(gateCall).length - 1).toBe(1);`
  // **内訳は 作成1 + 更新2**(`ADR-0443` 授権の表 行2。**3本目の関門を足していない**)。
  expect(source.split(gateCall).length - 1).toBe(3);
  // **その1件は、作成専用のヘルパ(`denyRecordCreate`)の本体の中に在る。**
  const helperAt = source.indexOf("const denyRecordCreate = (");
  const nextHelperAt = source.indexOf("\n  const denyFieldWrite", helperAt);
  expect(helperAt).toBeGreaterThan(0);
  expect(nextHelperAt).toBeGreaterThan(helperAt);
  expect(source.slice(helperAt, nextHelperAt).includes(gateCall)).toBe(true);
  // **`AC-G8`(古い親にも問う)は HTTP の更新2経路だけである** ——
  // **この道具は `previous` を1度も渡していない**(渡していれば更新の射程に入る)。
  // **【`V18-M6-T02` による訂正。上の2行を1バイトも消していない】** ——
  // **上の2行は今日は偽である。** **`AC-G8` の古い親の判定は、`ADR-0443` により
  // AI の口の更新2本にも掛かっており、この道具は `previous` を渡している。**
  // **旧の式**: `expect(source.includes("previous:")).toBe(false);`
  expect(source.includes("previous:")).toBe(true);
});

// ===========================================================================
// (C) `list_records` —— **行の判定と項目の面**
// ===========================================================================

test("(C) 他人の行は list_records に返らない(total も絞ったあとの件数である)", async () => {
  const forAlice = okData(
    await callTool("list_records", { app_id: APP_ID, table_id: NOTES }, alice.username),
  );
  const aliceRecords = forAlice.records as Record<string, unknown>[];
  expect(aliceRecords.map((row) => row.title)).toEqual(["alice のメモ"]);
  // **母集団を割らない** —— **`total` は絞ったあとの可視集合から採る**(HTTP と同じ向き)。
  expect(forAlice.total).toBe(1);

  const forBob = okData(
    await callTool("list_records", { app_id: APP_ID, table_id: NOTES }, bob.username),
  );
  const bobRecords = forBob.records as Record<string, unknown>[];
  expect(bobRecords.map((row) => row.title)).toEqual(["bob のメモ"]);
  expect(forBob.total).toBe(1);

  // **メンバー表にも付与にも居ない人には1行も返らない。**
  const forCarol = okData(
    await callTool("list_records", { app_id: APP_ID, table_id: NOTES }, carol.username),
  );
  expect(forCarol.records).toEqual([]);
  expect(forCarol.total).toBe(0);
});

test("(C) 見せないと宣言した項目は list_records の応答から伏せられる", async () => {
  const forAlice = okData(
    await callTool("list_records", { app_id: APP_ID, table_id: NOTES }, alice.username),
  );
  expect((forAlice.records as Record<string, unknown>[])[0]).toHaveProperty("secret");

  const forBob = okData(
    await callTool("list_records", { app_id: APP_ID, table_id: NOTES }, bob.username),
  );
  const bobRow = (forBob.records as Record<string, unknown>[])[0] as Record<string, unknown>;
  expect(bobRow.title).toBe("bob のメモ");
  // **項目の面は行の判定と独立に効く** —— **見えている自分の行でも、伏せる項目は落ちる。**
  expect(Object.hasOwn(bobRow, "secret")).toBe(false);
});

test("(C) 点も面も宣言していない表は、今日どおり全件返る(オプトイン)", async () => {
  const data = okData(
    await callTool("list_records", { app_id: APP_ID, table_id: MEMBERS }, alice.username),
  );
  expect((data.records as Record<string, unknown>[]).length).toBe(2);
  expect(data.total).toBe(2);
});

// ===========================================================================
// (E) **個人スコープ(`st_owner`)**(**`V8-M31` 第6波・裁定 `M31-13`**)
// ===========================================================================
//
// **測るもの**: **`st_owner` を持つ表で、MCP が HTTP と同じ向きに絞るか。**
// **着手前の実測(`m31-after.md` §5-1)では、`update_record` / `delete_record` /
// `insert_sample_data` の3本が他人の行を書けた**(**HTTP は同じ行に 404 を返す**)。
//
// ## **題材の形(なぜ表を足すだけでは測れないか。2つ手を掛けている)**
//
// **(1) `add_table` で `st_owner` ごと足すと、カーネルが3役割に「自分の行、または
// 持ち主が空の行」という**条件つき**の規則を自動で足す**(`src/kernel/apply-diff.ts` の
// `defaultTableGrantPlan`)。**その条件が立っていると、`list_records` は個人スコープの
// 配線が1バイトも無くても絞れてしまう**(着手前の実測 §5-1 (a) がまさにそれである)。
// **そこで `add_table`(`st_owner` なし)→ `add_field`(`st_owner`)の順に足す** ——
// **自動付与は `add_table` の時点の姿しか見ないので、条件は付かない**
// (`defaultTableGrantPlan` の doc「**`add_field` で後から `st_owner` を足した表**には
// 条件が付かない」の逐語)。
//
// **【2026-09-08 追記(`V17-M5-T05` / 台帳 `AC-G33`(`:1862`)/ `ADR-0423`)。
// 直前の4行は1バイトも消していない】** **「条件は付かない」は今日は偽である。**
// **補完の呼び出しが `foldOperations` の出口へ移り、すべての op を畳み終えた後に
// 1度だけ走るようになったので、この2手の題材にも条件が付く。**
// **したがって上の (1) の逃げ道は今日は成立しない** —— **差分の経路から
// 「`st_owner` を持つ表を条件なしで読める規則」を作る手だては1つも無い。**
// **この段落が支えていた検査は (E-7b) 1本であり、その期待値は反転させた**
// (**旧の本文は同ファイルの (E-7b) の直上に逐語で残してある**)。
// **(2) の書込・削除の測り方は今日も成り立つ** —— **書込は面の条件を1度も越えないので、
// 条件が付いても答えは同じである**(実測: (E-8) は緑のままである)。
//
// **(2) 書込・削除はこれで測れる**(**書込は面の条件を1度も越えない** —— `D-V8-35` が
// 開いたのは読取だけである)。**しかし読取は、これだけでは測れない** ——
// **条件なしで「この表を読める」と書かれた役割は、`D-V8-35` により個人スコープを越えて
// 全員分を読む**(`roleReadCrossesOwnerScope`)。**これは HTTP の一覧でも同じであり、
// MCP だけの穴ではない。**
//
// **【実測して分かったこと。ここに書き残す】** **HTTP の一覧の式
// `(自分の行 or 共有行 or 面が読取を許す) and 面が読取を許す` は、面が管轄内の表では
// **個人スコープの項が効かない**(`A or B` と `B` の `and` は `B` に畳まれる)。
// **面が管轄外なら `V8-M26`(既定を閉じた)が手前で一覧を空にする。**
// **したがって読取は、今日どちらの形でも個人スコープの項が答えを1件も変えない** ——
// **これは HTTP でも同じである。** **実測は (E-7b) と (E-7c) が持つ。**
//
// **そこで一覧は、実際に絞りが効く形((E-7):`add_table` で `st_owner` ごと足した表。
// カーネルが条件つきの規則を自動で足す)で固定する。** **絞っているのは条件つきの規則で
// あって個人スコープの配線ではない** —— **その正直な内訳が (E-7b) / (E-7c) である。**

const DIARY = "diary";

/** `st_owner` を持つ表を1つ足す差分(**点は宣言しない** —— 個人スコープだけを測る)。 */
const setupDiary = {
  diff_id: "setup-diary",
  intent: "持ち主ごとの日記の表を用意する",
  operations: [
    {
      op: "add_table",
      table: {
        id: DIARY,
        name: "日記",
        fields: [{ id: "title", name: "題", type: "text", required: true }],
      },
    },
    {
      op: "add_field",
      table: DIARY,
      field: { id: "st_owner", name: "持ち主", type: "text" },
    },
  ],
};

/** 日記の表を足す(上の (1))。**自動で入る規則は条件なしである。** */
async function addDiaryTable(): Promise<void> {
  okData(await callTool("apply_diff", { app_id: APP_ID, diff: setupDiary }, alice.username));
}

/**
 * **日記の表を名指しする面の規則を、1本も無い状態に落とす**(上の (2))。
 *
 * **`setupRoles` と同じ規則をそのまま撃ち直す** —— **`set_roles` は全置換なので、
 * 日記の表を名指しする規則(`add_table` が自動で足した3本)は1本も残らない。**
 */
async function dropDiaryRules(): Promise<void> {
  okData(
    await callTool(
      "apply_diff",
      { app_id: APP_ID, diff: { ...setupRoles, diff_id: "reset-roles" } },
      alice.username,
    ),
  );
}

/** 日記の表を作り、alice の行・bob の行・共有の行を1件ずつ用意する。 */
async function seedDiary(): Promise<{ aliceDiary: Row; bobDiary: Row; shared: Row }> {
  await addDiaryTable();
  const [aliceRaw] = await insert(DIARY, [{ title: "alice の日記" }], alice.username);
  const [bobRaw] = await insert(DIARY, [{ title: "bob の日記" }], bob.username);
  const [sharedRaw] = await insert(DIARY, [{ title: "みんなの日記" }], alice.username);
  // **共有の行は「自分の行を共有化する」道でしか作れない**(作成は必ず名乗った人で
  // スタンプされるため)。**`isAllowedOwnerUpdate` が許す唯一の書き換えである。**
  const shared = okData(
    await callTool(
      "update_record",
      {
        app_id: APP_ID,
        table_id: DIARY,
        record_id: String((sharedRaw as Record<string, unknown>)._id),
        if_match: String((sharedRaw as Record<string, unknown>)._updated_at),
        changes: { st_owner: null },
      },
      alice.username,
    ),
  ).record as Record<string, unknown>;
  return {
    aliceDiary: rowOf(aliceRaw as Record<string, unknown>),
    bobDiary: rowOf(bobRaw as Record<string, unknown>),
    shared: rowOf(shared),
  };
}

test("(E-1) insert_sample_data は作った行に名乗った人を書く(他人の名前を送っても上書きする)", async () => {
  await addDiaryTable();
  // **HTTP の `POST /records` は `body.value[OWNER_FIELD] = actor.id` を無条件に当てる** ——
  // **送られた値は読まずに捨てる**(`ADR-0016` §却下(iv)「クライアント送信を信用する経路は
  // 最初から作らない」)。**MCP も同じ向きにする。**
  const [spoofed] = await insert(
    DIARY,
    [{ title: "他人の名前で作ろうとした", st_owner: bob.userId }],
    alice.username,
  );
  expect((spoofed as Record<string, unknown>).st_owner).toBe(alice.userId);
  // **何も送らなかった行にも入る**(HTTP と同じ)。
  const [plain] = await insert(DIARY, [{ title: "何も送らない" }], bob.username);
  expect((plain as Record<string, unknown>).st_owner).toBe(bob.userId);
});

test("(E-2) 他人の行は update_record できない(HTTP の 404 と同じく「存在しません」で伏せる)", async () => {
  const { bobDiary } = await seedDiary();
  const denied = await callTool(
    "update_record",
    {
      app_id: APP_ID,
      table_id: DIARY,
      record_id: bobDiary.id,
      if_match: bobDiary.version,
      changes: { title: "乗っ取り" },
    },
    alice.username,
  );
  expect(messagesOf(denied)).toContain("存在しません");
  // **「権限がありません」に落ちていない** —— **403 を返すとその行が在ることが漏れる。**
  expect(messagesOf(denied)).not.toContain("許可されていません");
});

test("(E-3) 自分の行は update_record できる(絞りすぎていないことを測る)", async () => {
  const { aliceDiary } = await seedDiary();
  const data = okData(
    await callTool(
      "update_record",
      {
        app_id: APP_ID,
        table_id: DIARY,
        record_id: aliceDiary.id,
        if_match: aliceDiary.version,
        changes: { title: "書き換えた" },
      },
      alice.username,
    ),
  );
  expect((data.record as Record<string, unknown>).title).toBe("書き換えた");
});

test("(E-4) st_owner の付け替えは断られる(自分の行でも他人へは渡せない)", async () => {
  const { aliceDiary } = await seedDiary();
  const denied = await callTool(
    "update_record",
    {
      app_id: APP_ID,
      table_id: DIARY,
      record_id: aliceDiary.id,
      if_match: aliceDiary.version,
      changes: { st_owner: bob.userId },
    },
    alice.username,
  );
  expect(messagesOf(denied)).toContain("この所有者(st_owner)への変更は許可されていません。");
});

test("(E-5) 共有の行(st_owner が空)は誰からも見え、書ける。私物化だけが断られる", async () => {
  const { shared } = await seedDiary();
  // **共有の行は作った人以外にも見える**(`isSharedOwner`)。
  const data = okData(
    await callTool(
      "update_record",
      {
        app_id: APP_ID,
        table_id: DIARY,
        record_id: shared.id,
        if_match: shared.version,
        changes: { title: "bob が書き換えた" },
      },
      bob.username,
    ),
  );
  expect((data.record as Record<string, unknown>).title).toBe("bob が書き換えた");
  // **共有の行を自分のものにする(私物化)ことはできない。**
  const denied = await callTool(
    "update_record",
    {
      app_id: APP_ID,
      table_id: DIARY,
      record_id: shared.id,
      if_match: String((data.record as Record<string, unknown>)._updated_at),
      changes: { st_owner: bob.userId },
    },
    bob.username,
  );
  expect(messagesOf(denied)).toContain("この所有者(st_owner)への変更は許可されていません。");
});

test("(E-6) 他人の行は delete_record できない / 自分の行は消せる", async () => {
  const { aliceDiary, bobDiary } = await seedDiary();
  const denied = await callTool(
    "delete_record",
    { app_id: APP_ID, table_id: DIARY, record_id: bobDiary.id, if_match: bobDiary.version },
    alice.username,
  );
  expect(messagesOf(denied)).toContain("存在しません");
  okData(
    await callTool(
      "delete_record",
      { app_id: APP_ID, table_id: DIARY, record_id: aliceDiary.id, if_match: aliceDiary.version },
      alice.username,
    ),
  );
});

/** `st_owner` ごと `add_table` する表(**カーネルが条件つきの規則を自動で足す側**)。 */
const NOTEBOOK = "notebook";
const setupNotebook = {
  diff_id: "setup-notebook",
  intent: "持ち主ごとの帳面の表を用意する",
  operations: [
    {
      op: "add_table",
      table: {
        id: NOTEBOOK,
        name: "帳面",
        fields: [
          { id: "title", name: "題", type: "text", required: true },
          { id: "st_owner", name: "持ち主", type: "text" },
        ],
      },
    },
  ],
};

test("(E-7) list_records に他人の行が返らない(total も絞ったあとの件数である)", async () => {
  okData(await callTool("apply_diff", { app_id: APP_ID, diff: setupNotebook }, alice.username));
  const [aliceRaw] = await insert(NOTEBOOK, [{ title: "alice の帳面" }], alice.username);
  await insert(NOTEBOOK, [{ title: "bob の帳面" }], bob.username);
  const [sharedRaw] = await insert(NOTEBOOK, [{ title: "みんなの帳面" }], alice.username);
  okData(
    await callTool(
      "update_record",
      {
        app_id: APP_ID,
        table_id: NOTEBOOK,
        record_id: String((sharedRaw as Record<string, unknown>)._id),
        if_match: String((sharedRaw as Record<string, unknown>)._updated_at),
        changes: { st_owner: null },
      },
      alice.username,
    ),
  );
  // **作った行に名乗った人が入っている**(スタンプは表の作り方に依らない)。
  expect((aliceRaw as Record<string, unknown>).st_owner).toBe(alice.userId);

  const forAlice = okData(
    await callTool("list_records", { app_id: APP_ID, table_id: NOTEBOOK }, alice.username),
  );
  expect((forAlice.records as Record<string, unknown>[]).map((row) => row.title)).toEqual([
    "alice の帳面",
    "みんなの帳面",
  ]);
  // **母集団を割らない** —— **`total` は絞ったあとの可視集合から採る**(HTTP と同じ向き)。
  expect(forAlice.total).toBe(2);

  const forBob = okData(
    await callTool("list_records", { app_id: APP_ID, table_id: NOTEBOOK }, bob.username),
  );
  expect((forBob.records as Record<string, unknown>[]).map((row) => row.title)).toEqual([
    "bob の帳面",
    "みんなの帳面",
  ]);
  expect(forBob.total).toBe(2);
});

// --- 【`V17-M5-T05` / 台帳 `AC-G33`(`:1862`)/ `ADR-0423`。期待値を反転させた。旧を逐語で残す】 ---
//
// **旧のテスト名(逐語)**:
//   `(E-7b) 【塞いでいない。HTTP も同じ】条件なしで「読める」と書かれた表では、他人の行が一覧に出る`
// **旧の本体(逐語)**:
//   ```
//   await seedDiary();
//   // **`add_field` で後から `st_owner` を足した表には、条件なしの規則が3役割に入っている。**
//   // **`D-V8-35` により、面の読取は個人スコープを越える**(`roleReadCrossesOwnerScope`)。
//   // **HTTP の `GET /records` もまったく同じ3行を返す** —— **MCP だけの穴ではないので、
//   // 第6波はここを塞いでいない。**
//   const forBob = okData(
//     await callTool("list_records", { app_id: APP_ID, table_id: DIARY }, bob.username),
//   );
//   expect((forBob.records as Record<string, unknown>[]).map((row) => row.title)).toEqual([
//     "alice の日記",
//     "bob の日記",
//     "みんなの日記",
//   ]);
//   expect(forBob.total).toBe(3);
//   ```
//
// **根拠**: **この題材の前提そのものが、差分の経路では今日成り立たない。**
// **`setupDiary`(`add_table`〔`st_owner` なし〕→ `add_field`〔`st_owner`〕)は、
// 台帳 `AC-G33` が穴として名指ししていた形そのものであり、`V17-M5-T05` は
// **差分の経路に限って**これを作れなくした** ——
//
// **【`V17-M5` 独立点検の指摘 中3 による訂正(2026-09-08)。射程を限った】**
// **旧のコメント(本段が新しく書いたもの。逐語)**:
//   `台帳 \`AC-G33\` が穴として名指ししていた形そのものであり、\`V17-M5-T05\` が塞いだ** ——`
// **旧のテスト名(本段が新しく書いたもの。逐語)**:
//   `(E-7b) 【\`AC-G33\` が塞いだ】条件なしの規則は差分から作れず、他人の行は一覧に出ない(旧: 出る)`
// **無条件の「塞いだ」は言い過ぎである** —— **`applyManifest` の経路(差分を通さない適用)では、
//   補完も知らせも1度も走らない**(記録 §9 の 21)。 **その形は今日も作れる。**
// **検査名とコメントの両方から無条件の「塞いだ」を外し、射程(差分の経路)を書いた。**
//
// **補完は畳み込みの出口で1度走るので、この差分を通した時点で3役割の規則に
// `{ or: [ st_owner が自分, st_owner が空 ] }` が入る。**
// **したがって「条件なしで読めると書かれた表」を差分の経路から作る手だては今日1つも無い。**
//
// **【この反転が意味しないこと。誇張しない】**
// - **旧のテスト名が述べている命題(**条件なし**で「読める」と書かれた表では他人の行が
//   一覧に出る)は、今日も真である** —— **`D-V8-35` も `roleReadCrossesOwnerScope` も
//   1バイトも変わっていない。** **変わったのは、その形を差分から作れなくなったことだけである。**
//   (`applyManifest` を直に呼ぶ経路では今日も作れる。**補完は差分の畳み込みにしか無い。**)
// - **`src/mcp/tools/read.ts` の個人スコープの絞り込み1本は、今日もこの経路で答えを
//   1件も変えていない** —— **絞っているのは補われた**条件つきの規則**の側である。**
//   **その内訳は下の実測が持つ。**
test("(E-7b) 【`AC-G33`。差分の経路では作れない】条件なしの規則は差分から作れず、他人の行は一覧に出ない(旧: 出る)", async () => {
  await seedDiary();
  // **`add_field` で後から `st_owner` を足した表にも、今日は条件が補われる**
  // (`V17-M5-T05`)。 **補ったことは `apply_diff` の応答の `role_condition_notices`
  // (4種目 `owner_scope_supplied`)で書いた人に返っている。**
  const forBob = okData(
    await callTool("list_records", { app_id: APP_ID, table_id: DIARY }, bob.username),
  );
  // **`みんなの日記`(`st_owner` が空 = 共有行)は補った条件の2本目に当たるので今日も出る。**
  expect((forBob.records as Record<string, unknown>[]).map((row) => row.title)).toEqual([
    "bob の日記",
    "みんなの日記",
  ]);
  expect(forBob.total).toBe(2);
});

test("(E-7c) 【`V8-M26` の既定が先に立つ】面が1本も名指ししていない表は、個人スコープに届く前に空になる", async () => {
  await seedDiary();
  // **`set_roles` の撃ち直し(全置換)で、日記の表を名指しする規則を1本も無い状態にする。**
  await dropDiaryRules();
  // **管轄外の表は `V8-M26`(既定を閉じた)により読取そのものが閉じる** ——
  // **自分の行も共有の行も1件も返らない。** **HTTP の一覧も同じである。**
  //
  // **【この実測が意味すること。第6波の報告に書く】** —— **`list_records` に足した
  // 個人スコープの絞り込みは、今日どの形でも答えを1件も変えない** ——
  // **面が管轄内なら `roleReadCrossesOwnerScope` が真になって個人スコープの項が畳まれ、
  // 面が管轄外ならこの検査のとおり手前で閉じるからである。**
  // **HTTP の一覧の同じ式も、今日は同じ理由で答えを変えていない。**
  const forAlice = okData(
    await callTool("list_records", { app_id: APP_ID, table_id: DIARY }, alice.username),
  );
  expect(forAlice.records).toEqual([]);
  expect(forAlice.total).toBe(0);
});

test("(E-8) write_records も個人スコープを受ける(create はスタンプ / 他人の行の update は断る)", async () => {
  const { bobDiary } = await seedDiary();
  // **create op は名乗った人でスタンプされる**(送った `st_owner` は捨てられる)。
  const created = okData(
    await callTool(
      "write_records",
      {
        app_id: APP_ID,
        ops: [
          { op: "create", table: DIARY, values: { title: "まとめて作った", st_owner: bob.userId } },
        ],
      },
      alice.username,
    ),
  );
  expect(
    ((created.records as Record<string, unknown>[])[0] as Record<string, unknown>).st_owner,
  ).toBe(alice.userId);
  // **他人の行への update op は、バッチ全体を落とす。**
  const denied = await callTool(
    "write_records",
    {
      app_id: APP_ID,
      ops: [
        {
          op: "update",
          table: DIARY,
          target: bobDiary.id,
          if_match: bobDiary.version,
          values: { title: "乗っ取り" },
        },
      ],
    },
    alice.username,
  );
  expect(messagesOf(denied)).toContain("存在しません");
});
