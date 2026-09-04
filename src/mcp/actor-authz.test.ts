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
  expect(manifest.app.tables.map((table) => table.id).sort()).toEqual(
    [GRANTS, MEMBERS, NOTES].sort(),
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
  expect(errors[0]?.allowed_values).toEqual([MEMBERS, NOTES, GRANTS]);
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

test("(E-7b) 【塞いでいない。HTTP も同じ】条件なしで「読める」と書かれた表では、他人の行が一覧に出る", async () => {
  await seedDiary();
  // **`add_field` で後から `st_owner` を足した表には、条件なしの規則が3役割に入っている。**
  // **`D-V8-35` により、面の読取は個人スコープを越える**(`roleReadCrossesOwnerScope`)。
  // **HTTP の `GET /records` もまったく同じ3行を返す** —— **MCP だけの穴ではないので、
  // 第6波はここを塞いでいない。**
  const forBob = okData(
    await callTool("list_records", { app_id: APP_ID, table_id: DIARY }, bob.username),
  );
  expect((forBob.records as Record<string, unknown>[]).map((row) => row.title)).toEqual([
    "alice の日記",
    "bob の日記",
    "みんなの日記",
  ]);
  expect(forBob.total).toBe(3);
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
