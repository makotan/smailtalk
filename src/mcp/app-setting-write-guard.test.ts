/**
 * **アプリの設定に触れるかの判定を、更新系と参照系の2経路が同じ1本で通ること**
 * (`V10-M28-T01` / `V10-M28-T02`)。
 *
 * ## この検査が固定するもの
 *
 * 1. **判定そのものが、`registerWriteTools` の内側の閉包からモジュールの外へ出ている**
 *    —— **参照系(`src/mcp/tools/read.ts`)から呼べる場所に在る。**
 *    **(A) 群がその関数を直に呼び、通る側と断る側の両方を測る。**
 * 2. **(B) 更新系(`apply_diff`)は、権限の無い名乗りで断られる。**
 * 3. **(C) 参照系(`dry_run_diff`)も、権限の無い名乗りで断られる。**
 *
 * ## **(B) と (C) を別々の検査として書く理由**
 *
 * **片方が他方へ委譲していても、両方が落ちる形にするためである。** **1本の検査の中で
 * 2つの道具を回すと、共有した実装が壊れたときに落ちるのは「その1本」だけになり、
 * 「2経路とも塞がっている」ことの根拠が1本に痩せる。** **経路ごとに独立した検査を
 * 置けば、どちらの経路が開いたのかが名前で分かる。**
 *
 * ## **この検査が固定していないこと(誇張しない)**
 *
 * - **`get_manifest` は今日どおり定義の全量を返す**(`D-V8-55` / `D-V8-85`。`U-4`)。
 *   **本タスクはそこを1ミリも動かしていない。**
 * - **`preview_undo` / `preview_redo` は今日も影響行数を返す**(壁を足していない)。
 * - **認可であって認証ではない**(`D-V8-54`)—— **起動する人は誰の名前でも書ける。**
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ValidationError } from "../kernel/index.ts";
import { seedSession } from "../server/test-helpers.ts";
import { createMcpServer } from "./server.ts";
import { denyAppSettingWrite } from "./tools/write.ts";

const APP_ID = "workshop";
const TABLE_ID = "notes";
const PREVIEW_BASE_URL = "http://127.0.0.1:3000";

/** 名乗りがあれば通る側(`create_app` は主体を解決しない)。 */
const BOOTSTRAP_ACTOR = "bootstrap";

/** **断り文の逐語**(`src/server/app.ts` の `appChangeRuleRequiredError` の写し)。 */
const DENIED = "アプリの作りを変更できるのは";

let dataRoot = "";
/** 持ち主(`owner`)。**`app` × `write` を規則で持つ。** */
let alice: ReturnType<typeof seedSession>;
/** 編集者(`editor`)。**`app` の規則を1本も持たない。** */
let bob: ReturnType<typeof seedSession>;

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

/** 1テーブルを足す差分(`diff_id` を呼び出しごとに変える)。 */
function additiveDiff(diffId: string, fieldId: string): Record<string, unknown> {
  return {
    diff_id: diffId,
    intent: "メモに覚え書きの欄を足したい",
    operations: [
      { op: "add_field", table: TABLE_ID, field: { id: fieldId, name: "覚え書き", type: "text" } },
    ],
  };
}

/**
 * **そのアプリの `manifest.json` から `roles` を丸ごと落とす**(`V10-M27-T04` の写し)。
 *
 * **`create_app` は持ち主に規則を2行入れ、`set_roles` は既定3役割と持ち主の2行を必須に
 * するので、`apply_diff` をどう並べても規則ゼロには到達できない。** **到達できる形は
 * 「`roles` を1つも持たない定義」だけである**(`roles` は今日も省略可)。
 */
function stripRolesFromManifest(appId: string): void {
  const path = join(dataRoot, "apps", appId, "manifest.json");
  expect(existsSync(path)).toBe(true);
  const manifest = JSON.parse(readFileSync(path, "utf-8")) as { app: Record<string, unknown> };
  // **陽性対照** —— 落とす前は規則が在る(落とすものが無い空振りではない)。
  expect(Array.isArray(manifest.app.roles)).toBe(true);
  delete manifest.app.roles;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-mcp-app-setting-"));
  okData(await callTool("create_app", { name: "作業場", app_id: APP_ID }, BOOTSTRAP_ACTOR));

  alice = seedSession(dataRoot, APP_ID, { username: "alice" });
  bob = seedSession(dataRoot, APP_ID, { username: "bob", role: "editor" });

  okData(
    await callTool(
      "apply_diff",
      {
        app_id: APP_ID,
        diff: {
          diff_id: "setup-table",
          intent: "メモの表を用意する",
          operations: [
            {
              op: "add_table",
              table: {
                id: TABLE_ID,
                name: "メモ",
                fields: [{ id: "title", name: "題", type: "text", required: true }],
              },
            },
          ],
        },
      },
      alice.username,
    ),
  );
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

// ===========================================================================
// (A) 判定そのもの —— **参照系からも呼べる場所に在る**
// ===========================================================================

test("(A-1) 判定は閉包の外に在り、直に呼べる —— 規則を持つ相手には null が返る", () => {
  expect(denyAppSettingWrite(dataRoot, APP_ID, ["owner"])).toBeNull();
});

test("(A-2) 規則を持たない相手には断り1件が返る(通す側だけを測らない)", () => {
  const denied = denyAppSettingWrite(dataRoot, APP_ID, ["editor"]);
  expect(denied).not.toBeNull();
  expect(denied ?? []).toHaveLength(1);
  expect((denied ?? [])[0]?.message).toContain(DENIED);
});

test("(A-3) 定義が読めないアプリは閉じる側に倒れる(HTTP と同じ向き)", () => {
  const denied = denyAppSettingWrite(dataRoot, "no-such-app", ["owner"]);
  expect(denied).not.toBeNull();
  expect((denied ?? [])[0]?.message).toContain(DENIED);
});

// ===========================================================================
// (B) **更新系の経路**(`apply_diff`)—— **(C) とは別の検査である**
// ===========================================================================

test("(B-1) 更新系: 権限の無い名乗りでは apply_diff が断られる", async () => {
  const denied = await callTool(
    "apply_diff",
    { app_id: APP_ID, diff: additiveDiff("d-b1", "memo_b1") },
    bob.username,
  );
  expect(messagesOf(denied)).toContain(DENIED);
});

test("(B-2) 更新系: 権限を持つ名乗りでは apply_diff が通る(全部拒否では緑にならない)", async () => {
  okData(
    await callTool(
      "apply_diff",
      { app_id: APP_ID, diff: additiveDiff("d-b2", "memo_b2") },
      alice.username,
    ),
  );
});

// ===========================================================================
// (C) **参照系の経路**(`dry_run_diff`)—— **(B) とは別の検査である**
// ===========================================================================

test("(C-1) 参照系: 権限の無い名乗りでは dry_run_diff が断られる", async () => {
  const denied = await callTool(
    "dry_run_diff",
    { app_id: APP_ID, diff: additiveDiff("d-c1", "memo_c1") },
    bob.username,
  );
  expect(messagesOf(denied)).toContain(DENIED);
});

test("(C-2) 参照系: 権限を持つ名乗りでは dry_run_diff が今日どおり通る", async () => {
  const data = okData(
    await callTool(
      "dry_run_diff",
      { app_id: APP_ID, diff: additiveDiff("d-c2", "memo_c2") },
      alice.username,
    ),
  );
  const report = data.report as { schema: Record<string, string[]> };
  expect(report.schema[TABLE_ID]).toContain("memo_c2");
});

test("(C-3) 壁の位置は apply_diff と同じ順序 —— intent が空でも権限の理由が返る", async () => {
  const denied = await callTool(
    "dry_run_diff",
    { app_id: APP_ID, diff: { diff_id: "d-c3", intent: "   ", operations: [] } },
    bob.username,
  );
  expect(messagesOf(denied)).toContain(DENIED);
  // **`intent` の位置(`/diff/intent`)は1件も返らない** —— 権限の判定が先に立つ。
  expect(errorsOf(denied).map((error) => error.path)).not.toContain("/diff/intent");

  // **陽性対照** —— 権限を持つ相手には、今日どおり `intent` の位置が返る。
  const byOwner = await callTool(
    "dry_run_diff",
    { app_id: APP_ID, diff: { diff_id: "d-c3b", intent: "   ", operations: [] } },
    alice.username,
  );
  expect(errorsOf(byOwner)[0]?.path).toBe("/diff/intent");
});

// ===========================================================================
// (D) **新しい不便を隠さない** —— `V10-M27` が開くアプリと同じ集合が閉じる
// ===========================================================================

test("(D-1) 規則を1本も書いていないアプリでは、持ち主にも dry_run_diff が断られる", async () => {
  // **落とす前** —— 持ち主は通る(空振りではない)。
  okData(
    await callTool(
      "dry_run_diff",
      { app_id: APP_ID, diff: additiveDiff("d-d1", "memo_d1") },
      alice.username,
    ),
  );

  stripRolesFromManifest(APP_ID);

  const denied = await callTool(
    "dry_run_diff",
    { app_id: APP_ID, diff: additiveDiff("d-d1b", "memo_d1b") },
    alice.username,
  );
  expect(messagesOf(denied)).toContain(DENIED);
});

test("(D-2) 同じアプリで apply_diff も断られる(着手前からそうである。閉じたのは片方だけではない)", async () => {
  stripRolesFromManifest(APP_ID);
  const denied = await callTool(
    "apply_diff",
    { app_id: APP_ID, diff: additiveDiff("d-d2", "memo_d2") },
    alice.username,
  );
  expect(messagesOf(denied)).toContain(DENIED);
});
