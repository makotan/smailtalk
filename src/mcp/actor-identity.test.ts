/**
 * **名乗りの器と、主体の解決**(`V8-M31-T02` / `V8-M31-T03`。台帳 `T-G21a` / `T-G21b` / `T-G22`)。
 *
 * ## この検査が固定するもの(**この波で入れたのはここまでである**)
 *
 * 1. **起動時に一度だけ決める名乗り**(環境変数 `ST_MCP_ACTOR`)が無いと、**23本すべてが
 *    `isError` を返す。** ユーザ決定 `D-V8-46` の逐語「**指定を忘れると何もできない状態で
 *    立ち上がります**」—— **立ち上がりはする。** `tools/list` は今日どおり23本を返す。
 * 2. **名乗った文字列を、そのアプリの利用者へ解決する**(`findUserById` → `findUserByUsername`。
 *    **IDを優先する**。ユーザ決定 `D-V8-83` の逐語「名乗りは**ログイン名でもIDでも受ける**。
 *    両方一致ならID優先」)。**解決できなければ、アプリを名指しする操作を全部断る。**
 * 3. **`list_apps` は `app_id` を取らないので解決しない**(`D-V8-85`: **アプリの一覧も絞らない**)。
 *    **`create_app` は名乗りが要るが解決しない**(`D-V8-53` の逐語「AI は**空のアプリの器だけ**を
 *    作る。**名乗らずにできることが1つも残りません**」—— **アプリがまだ無いので解決先が無い**)。
 *
 * ## **この検査が固定していないもの(誇張しない)**
 *
 * - **判定(役割の面・行ごとの付与)は1つも入っていない。** 解決できた主体は、この波では
 *   **今までどおり全部通る。** 絞るのは次の波(`T04` / `T05` / `T06`)である。
 * - **したがって「AI 経由を塞いだ」とは、この検査だけでは書けない。**
 * - **認可であって認証ではない**(`D-V8-54`: 名乗りに**証明を求めない**)。**起動する人は
 *   誰の名前でも書ける。**
 *
 * ## 土台をカーネルの関数ではなく MCP のツールで作っている理由
 *
 * `scripts/kernel-import-drift.test.ts`(消費側の層またぎのスナップショット)を、この
 * 検査のためだけに太らせないためである。**`createApp` / `applyDiff` を値として import せず、
 * `create_app` / `apply_diff` を名乗り付きで呼んで土台を作る。**
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ValidationError } from "../kernel/index.ts";
import { seedSession } from "../server/test-helpers.ts";
import { missingActorError, resolveActor, unknownActorError } from "./actor-guard.ts";
import { loadMcpHttpConfig } from "./http-transport.ts";
import { createMcpServer } from "./server.ts";

const MCP_DIR = import.meta.dir;
const APP_ID = "inventory";
const TABLE_ID = "items";
const PREVIEW_BASE_URL = "http://127.0.0.1:3000";

let dataRoot = "";
/** そのアプリに実在する利用者(既定の `owner`)。 */
let alice: ReturnType<typeof seedSession>;

/** クライアントとサーバを直結する(両 `connect` は `Promise.all`。逐次だとデッドロックする)。 */
async function connectInMemory(
  actor?: string,
): Promise<{ client: Client; close: () => Promise<void> }> {
  // **名乗りは `CreateMcpServerOptions` の3本目のキーで運ぶ**(裁定 `M31-1`)——
  // **ツールが `process.env` を読む形にすると、この検査が複数の主体を書けない。**
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

function okData(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

/** 名乗りがあれば通る側のツール(土台作りに使う)。**解決先が無いので誰でもよい。** */
const BOOTSTRAP_ACTOR = "bootstrap";

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-mcp-actor-"));
  // アプリの器を2つ作る(`list_apps` の件数を見るため)。**`create_app` は解決しない**ので、
  // まだ1人も居ないこの時点でも、名乗りさえあれば通る(`D-V8-53`)。
  okData(await callTool("create_app", { name: "在庫管理", app_id: APP_ID }, BOOTSTRAP_ACTOR));
  okData(await callTool("create_app", { name: "経費申請", app_id: "expense" }, BOOTSTRAP_ACTOR));

  // **利用者はここで初めて生える。****新しいヘルパを作らず、既存の `seedSession` を使う**
  // (裁定 `M31-7`。`src/server/test-helpers.ts:53`)。
  alice = seedSession(dataRoot, APP_ID, { username: "alice" });

  const applied = await callTool(
    "apply_diff",
    {
      app_id: APP_ID,
      diff: {
        diff_id: "setup",
        intent: "備品テーブルと一覧画面を用意する",
        operations: [
          {
            op: "add_table",
            table: {
              id: TABLE_ID,
              name: "備品",
              fields: [
                { id: "title", name: "品名", type: "text", required: true },
                { id: "qty", name: "数量", type: "number" },
              ],
            },
          },
          {
            op: "add_view",
            view: {
              id: "items-list",
              type: "list_view",
              table: TABLE_ID,
              columns: ["title", "qty"],
            },
          },
        ],
      },
    },
    alice.username,
  );
  okData(applied);
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// `T02` 名乗りの器
// ---------------------------------------------------------------------------

test("T02: 名乗りが無くても起動する —— tools/list は今日どおり23本を返す", async () => {
  // `D-V8-46` の逐語「**指定を忘れると何もできない状態で立ち上がります**」。
  // **立ち上がらないのではない。** 本数を固定した番人(`http-transport.test.ts:147` /
  // `http-entry.test.ts:150` / `descriptions.test.ts:181`)を赤くしない(裁定 `M31-2`)。
  const { client, close } = await connectInMemory();
  try {
    const listed = await client.listTools();
    // **【2026-08-15。`V8-M13-T02`。台帳 `Q-G28` = 限定採用(門A)】期待値を 23 → 24 へ
    // 書き換えた。** **旧行の逐語**: `expect(listed.tools.length).toBe(23);`
    // **足したのは `read_report`(集計表を1枚読む参照系)1本だけである。**
    // **テスト名は1バイトも書き換えていない**(「23本」は 2026-08-14 までの事実)。
    // **【2026-08-24。`V10-M12-T01`。台帳 `CM-G7` / `ADR-0368`】期待値を 24 → 25 へ
    // 書き換えた。** **旧行の逐語**: `expect(listed.tools.length).toBe(24);`
    // **足したのは `list_comments`(コメントを読む参照系)1本だけである。**
    // **【2026-08-25。`V10-M30-T02`。台帳 `CM-G37` / `ADR-0378`】期待値を 25 → 26 へ
    // 書き換えた。** **旧行の逐語**: `expect(listed.tools.length).toBe(25);`
    // **足したのは `set_comment_visibility`(コメントの出し入れを切り替える更新系)1本
    // だけである。**
    expect(listed.tools.length).toBe(26);
  } finally {
    await close();
  }
});

/**
 * **23本すべての呼び出し**(引数は SDK の zod を通る形にしてある —— **zod で弾かれると
 * ハンドラに入らず、名乗りの検査を通ったことにならない**)。
 */
const ALL_TOOL_CALLS: readonly { name: string; args: Record<string, unknown> }[] = [
  { name: "list_apps", args: {} },
  { name: "get_manifest", args: { app_id: APP_ID } },
  { name: "get_changelog", args: { app_id: APP_ID } },
  { name: "get_preview_url", args: { app_id: APP_ID } },
  { name: "list_records", args: { app_id: APP_ID, table_id: TABLE_ID } },
  { name: "preview_undo", args: { app_id: APP_ID } },
  { name: "preview_redo", args: { app_id: APP_ID } },
  {
    // **【2026-08-25。`V10-M28-T02`】** **この道具には `app` × `write` の壁が入った。**
    // **この検査は今日も1バイトも変わらずに通る** —— **名乗りの検査(`requireActorAndApp`)は
    // 壁より**手前**に在り、名乗りが無ければ壁に届く前に「名乗っていない」で返るからである。**
    // **順序は `apply_diff` と同じである**(名乗り → `app` × `write` → `intent`)。
    name: "dry_run_diff",
    args: { app_id: APP_ID, diff: { diff_id: "d-x", intent: "確かめる", operations: [] } },
  },
  { name: "generate_requirements_doc", args: { app_id: APP_ID } },
  { name: "report_drift", args: { app_id: APP_ID } },
  // **【2026-08-15。`V8-M13-T02`。台帳 `Q-G28`】24本目。**
  // **`view_id` は実在しなくてよい** —— **名乗りの検査はハンドラの冒頭に在り、
  //   画面の実在を見るより先に返るからである**(他の道具と同じ形)。
  { name: "read_report", args: { app_id: APP_ID, view_id: "rep-x" } },
  { name: "create_app", args: { name: "名乗り無しで作れてはいけないアプリ", app_id: "must-not" } },
  {
    name: "apply_diff",
    args: { app_id: APP_ID, diff: { diff_id: "d-y", intent: "変える", operations: [] } },
  },
  { name: "undo", args: { app_id: APP_ID } },
  { name: "redo", args: { app_id: APP_ID } },
  { name: "insert_sample_data", args: { app_id: APP_ID, table_id: TABLE_ID, rows: [] } },
  {
    name: "update_record",
    args: {
      app_id: APP_ID,
      table_id: TABLE_ID,
      record_id: "r-1",
      if_match: "2026-01-01T00:00:00.000Z",
      changes: { title: "x" },
    },
  },
  {
    name: "delete_record",
    args: {
      app_id: APP_ID,
      table_id: TABLE_ID,
      record_id: "r-1",
      if_match: "2026-01-01T00:00:00.000Z",
    },
  },
  { name: "write_records", args: { app_id: APP_ID, ops: [] } },
  { name: "delete_app", args: { app_id: APP_ID } },
  {
    name: "request_connection",
    args: { app_id: APP_ID, name: "c", purpose: "p", hosts: ["api.example.com"] },
  },
  { name: "request_ai_capability", args: { app_id: APP_ID, name: "a", purpose: "p" } },
  {
    name: "request_inbound_endpoint",
    args: { app_id: APP_ID, name: "i", purpose: "p", target_table: TABLE_ID },
  },
  { name: "request_custom_css", args: { app_id: APP_ID, name: "s", purpose: "p", views: [] } },
  // **【2026-08-24。`V10-M12-T01`。台帳 `CM-G7` / `ADR-0368`】25本目をここへ書き足した。**
  // **下の検査が自認しているとおり、書き足さなければ 24 のまま緑で通り、新しい道具は
  // 1度も呼ばれないままになる。** **書き足したことを記録に1行で書いた。**
  { name: "list_comments", args: { app_id: APP_ID } },
  // **【2026-08-25。`V10-M30-T02`。台帳 `CM-G37` / `ADR-0378`】26本目をここへ書き足した。**
  // **下の検査が自認しているとおり、書き足さなければ 25 のまま緑で通り、新しい道具は
  // 1度も呼ばれないままになる。** **書き足したことを記録に1行で書いた。**
  // **`comment_write` は片方だけ渡している** —— **両方省略すると zod ではなくハンドラが
  // 断るため、名乗りの検査を通ったかどうかが見えなくなるからである。**
  { name: "set_comment_visibility", args: { app_id: APP_ID, comment_write: false } },
];

test("T02: 名乗りが無いと23本すべてが isError を返す(裁定 M31-2)", async () => {
  // **本数そのものを固定する** —— 数え漏らしたツールがあると、ここが 23 に届かない。
  // **【2026-08-15。`V8-M13-T02`。台帳 `Q-G28`】期待値を 23 → 24 へ書き換えた。**
  // **旧行の逐語**: `expect(ALL_TOOL_CALLS.length).toBe(23);`
  // **【構造上、この検査は「足し忘れ」を赤くしない】** —— **`ALL_TOOL_CALLS` に
  //   書き足さなければ 23 のまま緑で通り、新しい道具は1度も呼ばれない。**
  //   **本数を固定しているのは `descriptions.test.ts` / `entry-point-inventory.test.ts` の
  //   側であり、そちらが赤くなってからここへ運ぶ形になっている。**
  // **【2026-08-24。`V10-M12-T01`。台帳 `CM-G7` / `ADR-0368`】期待値を 24 → 25 へ
  // 書き換え、`ALL_TOOL_CALLS` にも 25本目(`list_comments`)を書き足した。**
  // **旧行の逐語**: `expect(ALL_TOOL_CALLS.length).toBe(24);`
  // **【2026-08-25。`V10-M30-T02`。台帳 `CM-G37` / `ADR-0378`】期待値を 25 → 26 へ
  // 書き換え、`ALL_TOOL_CALLS` にも 26本目(`set_comment_visibility`)を書き足した。**
  // **旧行の逐語**: `expect(ALL_TOOL_CALLS.length).toBe(25);`
  expect(ALL_TOOL_CALLS.length).toBe(26);

  const passed: string[] = [];
  for (const call of ALL_TOOL_CALLS) {
    const result = await callTool(call.name, call.args);
    if (result.isError !== true) {
      passed.push(call.name);
      continue;
    }
    const errors = errorsOf(result);
    expect({ tool: call.name, message: errors[0]?.message }).toEqual({
      tool: call.name,
      message: missingActorError().message,
    });
  }
  // **通ってしまったツールを名前で出す**(件数だけだと、どれが漏れたか分からない)。
  expect(passed).toEqual([]);
});

test("T02: 名乗りが無い呼び出しは1バイトも書いていない(delete_app も create_app も効いていない)", async () => {
  for (const call of ALL_TOOL_CALLS) {
    await callTool(call.name, call.args);
  }
  // `list_apps` は名乗りさえあれば通る(解決しない)。**土台の2つのままであること** ——
  // 名乗り無しの `create_app` が作れておらず、名乗り無しの `delete_app` が消せていない。
  const data = okData(await callTool("list_apps", {}, BOOTSTRAP_ACTOR));
  const ids = (data.apps as { app_id: string }[]).map((app) => app.app_id).sort();
  expect(ids).toEqual([APP_ID, "expense"].sort());
});

test("T02: 空文字・空白だけの名乗りは「名乗り無し」として扱う", async () => {
  for (const blank of ["", "   ", "\t\n"]) {
    const result = await callTool("get_manifest", { app_id: APP_ID }, blank);
    expect({ blank, message: errorsOf(result)[0]?.message }).toEqual({
      blank,
      message: missingActorError().message,
    });
  }
});

test("T02: 断り文は既存の形(path / message / hint)で、起動設定の直し方を名指しする", () => {
  const missing = missingActorError();
  expect(typeof missing.path).toBe("string");
  expect(missing.message.length).toBeGreaterThan(0);
  // **`allowed_values` に嘘の一覧を書かない** —— 名乗りの候補はサーバ側に無い。
  expect(missing.allowed_values).toBeUndefined();
  // **何を直せばよいかを1往復で分かる形にする**(環境変数の名前と、書く値の種類)。
  expect(missing.hint).toContain("ST_MCP_ACTOR");
  expect(missing.hint).toContain("ログイン名");
  expect(missing.hint).toContain("利用者ID");

  const unknown = unknownActorError();
  expect(unknown.allowed_values).toBeUndefined();
  expect(unknown.hint).toContain("ST_MCP_ACTOR");
});

test("T02: 環境変数 ST_MCP_ACTOR を読むのは stdio の入口と loadMcpHttpConfig の2箇所だけ", async () => {
  // 裁定 `M31-1`。**ツールの実装から `process.env` を読まない**(読むと、この検査が
  // 複数の主体を書けなくなる)。**読んでいるファイルを機械で数え直す。**
  const readers: string[] = [];
  for (const entry of await Array.fromAsync(new Bun.Glob("**/*.ts").scan({ cwd: MCP_DIR }))) {
    if (entry.endsWith(".test.ts")) {
      continue;
    }
    const text = readFileSync(join(MCP_DIR, entry), "utf-8");
    if (/(?:process\.)?env\.ST_MCP_ACTOR/.test(text)) {
      readers.push(entry);
    }
  }
  expect(readers.sort()).toEqual(["http-transport.ts", "index.ts"]);

  // 陽性対照: `src/mcp/index.ts` は `ST_DATA_ROOT` も読んでいる(0件が「測れていない」ではない)。
  const stdioEntry = readFileSync(join(MCP_DIR, "index.ts"), "utf-8");
  expect(stdioEntry.includes("process.env.ST_DATA_ROOT")).toBe(true);
  // **起動ログに名乗りの有無を出す**(`D-V8-46`。忘れたことに起動時に気付ける形)。
  expect(stdioEntry.includes("ST_MCP_ACTOR=")).toBe(true);
  const httpEntry = readFileSync(join(dirname(MCP_DIR), "mcp", "http-entry.ts"), "utf-8");
  expect(httpEntry.includes("ST_MCP_ACTOR=")).toBe(true);
});

test("T02: loadMcpHttpConfig が ST_MCP_ACTOR を読む(空白だけは名乗り無し)", () => {
  expect(loadMcpHttpConfig({ ST_MCP_ACTOR: "alice" }).actor).toBe("alice");
  expect(loadMcpHttpConfig({ ST_MCP_ACTOR: "  alice  " }).actor).toBe("alice");
  expect(loadMcpHttpConfig({ ST_MCP_ACTOR: "   " }).actor).toBeUndefined();
  expect(loadMcpHttpConfig({}).actor).toBeUndefined();
});

// ---------------------------------------------------------------------------
// `T03` 主体の解決
// ---------------------------------------------------------------------------

test("T03: そのアプリに居ない人を名乗ると、アプリを名指しする操作が断られる", async () => {
  const stranger = "carol-who-is-not-registered";
  for (const call of [
    { name: "get_manifest", args: { app_id: APP_ID } },
    { name: "list_records", args: { app_id: APP_ID, table_id: TABLE_ID } },
    {
      name: "apply_diff",
      args: { app_id: APP_ID, diff: { diff_id: "d-z", intent: "変える", operations: [] } },
    },
    { name: "delete_app", args: { app_id: APP_ID } },
  ]) {
    const result = await callTool(call.name, call.args, stranger);
    const errors = errorsOf(result);
    expect({ tool: call.name, message: errors[0]?.message }).toEqual({
      tool: call.name,
      message: unknownActorError().message,
    });
    // **名乗った文字列をそのまま返さない** —— 断り文が「存在の有無」以上を漏らさないこと。
    expect(JSON.stringify(result)).not.toContain(stranger);
  }
});

test("T03: 居ないアプリを名指しした呼び出しでは、主体を解決する前にアプリ不在で断る", async () => {
  // 裁定 `M31-4` の順序(`requireApp` が通った**あと**に `AuthStore` を開く)。
  // **順序を誤ると、タイプミスした app_id でファイルが生える**(`openForApp` は `CREATE TABLE`
  // を走らせる。`src/auth/store.ts:671`-`:677`)。
  const result = await callTool("get_manifest", { app_id: "typo-app" }, alice.username);
  const errors = errorsOf(result);
  expect(errors[0]?.path).toBe("/app_id");
  expect(Bun.file(join(dataRoot, "apps", "typo-app", "app.sqlite")).size).toBe(0);
});

test("T03: 居るログイン名を名乗ると通る", async () => {
  okData(await callTool("get_manifest", { app_id: APP_ID }, alice.username));
  okData(await callTool("list_records", { app_id: APP_ID, table_id: TABLE_ID }, alice.username));
});

test("T03: 同じ人を利用者IDで名乗っても通る(D-V8-83)", async () => {
  okData(await callTool("get_manifest", { app_id: APP_ID }, alice.userId));
  okData(await callTool("list_records", { app_id: APP_ID, table_id: TABLE_ID }, alice.userId));
});

test("T03: 利用者IDと別人のログイン名が衝突したらIDが勝つ(D-V8-83)", () => {
  // **ログイン名は自由な文字列なので、他人の利用者IDと同じ名前の人を実際に作れる。**
  // **この波では解決結果がツールの応答に出ない**(判定をまだ入れていない)ので、
  // **解決そのものを直に呼んで確かめる。**
  const impostor = seedSession(dataRoot, APP_ID, { username: alice.userId, role: "viewer" });
  expect(impostor.username).toBe(alice.userId);
  expect(impostor.userId).not.toBe(alice.userId);

  const resolved = resolveActor(dataRoot, APP_ID, alice.userId);
  expect(resolved.ok).toBe(true);
  expect(resolved.ok ? resolved.value.id : "").toBe(alice.userId);
  expect(resolved.ok ? resolved.value.username : "").toBe(alice.username);

  // 逆向き(ログイン名でしか引けない人)も引ける。
  const byName = resolveActor(dataRoot, APP_ID, alice.username);
  expect(byName.ok ? byName.value.id : "").toBe(alice.userId);
});

test("T03: 解決した主体は実効ロール集合を持つ(列の1値 ∪ 付与表)", () => {
  const editor = seedSession(dataRoot, APP_ID, {
    username: "eve",
    role: "editor",
    grants: ["viewer"],
  });
  const resolved = resolveActor(dataRoot, APP_ID, "eve");
  expect(resolved.ok ? resolved.value.roles : []).toEqual(editor.roles);
});

test("T03: list_apps は app_id を取らないので解決しない(D-V8-85)", async () => {
  // **アプリの一覧は絞らない。** 名乗りさえあれば、そのアプリに居ない人でも通る。
  const data = okData(await callTool("list_apps", {}, "carol-who-is-not-registered"));
  expect((data.apps as unknown[]).length).toBe(2);
});

test("T03: create_app は名乗りが要るが解決しない(D-V8-53)", async () => {
  // `D-V8-53` の逐語「AI は**空のアプリの器だけ**を作る。
  // 「**名乗らずにできることが1つも残りません**」」——
  // **アプリがまだ無いのだから、そのアプリの利用者に解決しようがない。**
  const denied = await callTool("create_app", { name: "名乗り無し", app_id: "no-actor" });
  expect(errorsOf(denied)[0]?.message).toBe(missingActorError().message);

  const created = okData(
    await callTool("create_app", { name: "新しいアプリ", app_id: "brand-new" }, "nobody-yet"),
  );
  expect((created.app as { app_id: string }).app_id).toBe("brand-new");
});
