/**
 * **「アプリの設定を変更できる」だけを持つ人が、今日は巻き戻しまでできることの固定**
 * (`V17-M6-T02a'` / 台帳 `AC-G23`。計画 `docs/plan/v17/07-v17-m6-plan.md` §2b の 2 / §3-2b)。
 *
 * ## **このファイルは「穴が開いたままであることを固定するもの」である**
 *
 * **【先に書く。ここを取り違えないこと】** **本ファイルの検査は、直したことを撃っていない。**
 * **`AC-G23`(巻き戻しを誰に許すか)は **利用者決定 `D2`(2026-09-08)** により
 * 「**今までどおり、アプリの設定を変更できる人なら誰でも巻き戻せる**」と決まった。**
 * **したがって実装は 0バイトであり、本ファイルが固定しているのは
 * **今日そうなっているという事実**だけである** —— **「穴が開いたままであることの固定」である。**
 *
 * **【禁止。この検査を根拠に次のことを書かない】**
 *
 * - **「これでよい」と書かない。** **「安全である」と書かない。** **「塞いだ」と書かない。**
 * - **逆に「危険である」とも書かない** —— **代償(下の「今日はこうである」の 3)を
 *   読んだうえで利用者が選んだ動きである。**
 *
 * ## 今日はこうである(**本ファイルが撃つ 5項。全部「今日は通る / 今日はこうなる」側**)
 *
 * 1. **`{ target: "app", can: ["write"] }` を**それだけ**役割の規則で持つ非運営(`customer`)が
 *    HTTP `POST /api/apps/:app_id/undo` を撃つと **200** が返る。**
 * 2. **同じ利用者を名乗った MCP の `undo` も通る。**
 * 3. **同じ利用者を名乗った MCP の `redo` も通る。**
 * 4. **`owner` は今日どおり 200 である**(締め出していない側の対照)。
 * 5. **HTTP `POST /diffs` も、その人は今日どおり 201 である**
 *    (`AC-G23` は「アプリの設定を変更できる」ことを取り上げる話ではない)。
 *
 * **さらに、その `undo` が「**自分に権限を与えた差分そのもの**」を巻き戻せることを撃つ**
 * (`entry.undo_target_seq` が、`customer` に `app` × `write` を配った差分の `seq` と一致する)。
 * **巻き戻したあとは、その人自身が二度目の `undo` を撃てなくなる**(権限が消えるため)。
 *
 * ## この検査が測っていないこと(**誇張しない**)
 *
 * - **他人の行が巻き戻しで実際に消えるところを1度も撃っていない。**
 *   **`POST /undo` が `app.sqlite` を丸ごと戻すことは `ADR-0323` 限界10 が既に書いており、
 *   本ファイルはその件数(`lost_records`)を1度も数えていない。**
 * - **誰が巻き戻したかが履歴に出るかどうかを、本ファイルは1度も測っていない**
 *   (それは記録 `docs/plan/v17/records/v17-m6.md` §2 が実測で書く)。
 * - **MCP の他の道具(`apply_diff` / `delete_app` / `request_*` ×4 /
 *   `set_comment_visibility`)は1本も触っていない** —— **それは
 *   `src/mcp/tools/write.test.ts` の `(AC-G23-6)` が撃つ。**
 * - **ブラウザを1度も開いていない。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../mcp/server.ts";
import { createServerApp } from "./app.ts";
import { authed, seedSession } from "./test-helpers.ts";

const APP_ID = "chundo";
const PREVIEW_BASE_URL = "http://127.0.0.1:3000";
/** `create_app` は利用者を解決しないので、この名乗りだけは実在しなくてよい。 */
const BOOTSTRAP_ACTOR = "bootstrap";
/** 運営(`owner`)の名乗り。 */
const ADMIN = "chundo-admin";
/** **非運営**(`customer`)の名乗り。**この人に `app` × `write` を1本だけ配る。** */
const STAFF = "chundo-staff";

/**
 * **土台は MCP の道具(`create_app` / `apply_diff`)で組む** ——
 * **`scripts/kernel-import-drift.test.ts`(層またぎのスナップショット)を、この検査のために
 * 太らせないためである**(`src/server/change-routes-auth.test.ts` と同じ判断)。
 * **本ファイルは `src/kernel/` から値を1つも import していない。**
 */
async function callTool(
  name: string,
  args: Record<string, unknown>,
  actor: string,
): Promise<CallToolResult> {
  const server = createMcpServer({ dataRoot, previewBaseUrl: PREVIEW_BASE_URL, actor });
  const client = new Client({ name: "app-change-vs-undo-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

/**
 * **`isError` は**キーの有無**で判定する。`=== true` で丸めない**
 * (計画 §2-2 の (b) の追記 = 指摘 `L-3`。記録 §0-7-2 が「断られたときだけキーが入る」ことまで実測した)。
 */
function isErrorKeyPresent(result: CallToolResult): boolean {
  return "isError" in result;
}

/** 段1: 表と役割。**`customer` には規則を1本も書かない**(この時点では巻き戻せない)。 */
const SETUP_DIFF = {
  diff_id: "setup",
  intent: "メモの表を用意し、設定を変えられる相手を持ち主だけにする",
  operations: [
    {
      op: "add_table",
      table: {
        id: "memo",
        name: "メモ",
        fields: [{ id: "title", name: "見出し", type: "text", required: true }],
      },
    },
    {
      op: "set_roles",
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            { target: "table", table: "memo", can: ["read", "write", "delete"] },
          ],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
        { id: "customer", name: "一般利用者" },
      ],
    },
  ],
};

/**
 * 段2: **`customer` に `{ target: "app", can: ["write"] }` を1本だけ配る差分。**
 * **これが「自分に権限を与えた差分そのもの」である** —— 巻き戻しの対象になりうる。
 */
const GRANT_APP_WRITE_DIFF = {
  diff_id: "grant-app-write",
  intent: "一般利用者にもアプリの設定を変えられるようにする",
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
            { target: "table", table: "memo", can: ["read", "write", "delete"] },
          ],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
        // **表にも画面にも1本も書かない。** **持っているのは「アプリの設定を変更できる」だけである。**
        { id: "customer", name: "一般利用者", rules: [{ target: "app", can: ["write"] }] },
      ],
    },
  ],
};

/** 段3: 巻き戻しても権限が消えない、当たり障りの無い差分(`redo` の題材)。 */
const TRIVIAL_DIFF = {
  diff_id: "trivial",
  intent: "メモに覚え書きの欄を足したい",
  operations: [
    { op: "add_field", table: "memo", field: { id: "note", name: "覚え書き", type: "long_text" } },
  ],
};

let dataRoot = "";
let app: ReturnType<typeof createServerApp>;
let adminCookie = "";
let staffCookie = "";

/** 段1 + 段2 まで進める(`undo` 1回で「権限を与えた差分そのもの」に当たる形)。 */
async function setUpThroughGrant(): Promise<void> {
  const applied1 = await callTool("apply_diff", { app_id: APP_ID, diff: SETUP_DIFF }, ADMIN);
  expect(isErrorKeyPresent(applied1)).toBe(false);
  const applied2 = await callTool(
    "apply_diff",
    { app_id: APP_ID, diff: GRANT_APP_WRITE_DIFF },
    ADMIN,
  );
  expect(isErrorKeyPresent(applied2)).toBe(false);
}

/** 段1 + 段2 + 段3(`undo` 1回では権限が消えない形。`redo` の題材)。 */
async function setUpThroughTrivial(): Promise<void> {
  await setUpThroughGrant();
  const applied3 = await callTool("apply_diff", { app_id: APP_ID, diff: TRIVIAL_DIFF }, ADMIN);
  expect(isErrorKeyPresent(applied3)).toBe(false);
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-app-change-vs-undo-"));
  await callTool("create_app", { name: "巻き戻しの担い手", app_id: APP_ID }, BOOTSTRAP_ACTOR);
  // **名乗り(= 利用者)は、どの差分よりも先に作る。**
  // **`undo` は `app.sqlite` を丸ごと戻すので、差分より後に作ったセッションは消える**
  // (`ADR-0323` 限界10)。**題材の都合であって、本ファイルが測る性質ではない。**
  adminCookie = seedSession(dataRoot, APP_ID, { username: ADMIN, role: "owner" }).cookie;
  staffCookie = seedSession(dataRoot, APP_ID, { username: STAFF, role: "customer" }).cookie;
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

const undoPath = `/api/apps/${APP_ID}/undo`;
const diffsPath = `/api/apps/${APP_ID}/diffs`;
const changelogPath = `/api/apps/${APP_ID}/changelog`;

function postUndo(cookie: string): Promise<Response> {
  return Promise.resolve(app.request(...([authed(cookie)(undoPath, { method: "POST" })] as const)));
}

async function changelogSeqOf(diffId: string): Promise<number> {
  const res = await app.request(authed(adminCookie)(changelogPath));
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    changelog: Array<{ seq: number; diff_id: string }>;
  };
  const seq = body.changelog.find((entry) => entry.diff_id === diffId)?.seq;
  if (typeof seq !== "number") {
    throw new Error(`検査の前提: 差分 "${diffId}" が変更履歴に見つからない。`);
  }
  return seq;
}

// --- (AC-G23-1) HTTP の `POST /undo` -------------------------------------------------

test("(AC-G23-1) 今日は、`app` の書込だけを持つ非運営の HTTP POST /undo が 200 で通る", async () => {
  await setUpThroughTrivial();
  const res = await postUndo(staffCookie);
  // **【この 200 は「直した結果」ではない。今日の仕様である】**
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    undo: { entry: { kind: string; undo_target_seq: number; diff_id: string } };
  };
  expect(body.undo.entry.kind).toBe("undo");
  // **巻き戻したのは直前の差分(段3)である。**
  expect(body.undo.entry.undo_target_seq).toBe(await changelogSeqOf(TRIVIAL_DIFF.diff_id));
});

test("(AC-G23-1b) その undo は「自分に権限を与えた差分そのもの」を巻き戻せる", async () => {
  // **計画 §3-2b の (3) の 3 が名指しで求めた実測を、検査の形で固定する。**
  await setUpThroughGrant();
  const grantSeq = await changelogSeqOf(GRANT_APP_WRITE_DIFF.diff_id);

  const res = await postUndo(staffCookie);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { undo: { entry: { undo_target_seq: number } } };
  // **巻き戻した相手は、まさに自分へ `app` × `write` を配った差分である。**
  expect(body.undo.entry.undo_target_seq).toBe(grantSeq);

  // **その結果、この人自身は二度目の巻き戻しを撃てなくなる**(権限ごと戻したため)。
  // **【これは「歯止め」ではない】** —— **1回目は通っている。**
  const second = await postUndo(staffCookie);
  expect(second.status).toBe(403);
  const denied = (await second.json()) as { errors: Array<{ message: string }> };
  expect(denied.errors[0]?.message).toContain("アプリの作りを変更できるのは");
});

// --- (AC-G23-2) / (AC-G23-3) MCP の `undo` / `redo` ----------------------------------

test("(AC-G23-2) 今日は、同じ利用者を名乗った MCP の undo も通る", async () => {
  await setUpThroughTrivial();
  const result = await callTool("undo", { app_id: APP_ID }, STAFF);
  // **`isError` は**キーの有無**で判定する** —— **通ったときはキーそのものが返らない。**
  expect(isErrorKeyPresent(result)).toBe(false);
  const structured = result.structuredContent as { entry?: { kind?: string } };
  expect(structured.entry?.kind).toBe("undo");
});

test("(AC-G23-3) 今日は、同じ利用者を名乗った MCP の redo も通る", async () => {
  await setUpThroughTrivial();
  const undone = await callTool("undo", { app_id: APP_ID }, STAFF);
  expect(isErrorKeyPresent(undone)).toBe(false);
  const result = await callTool("redo", { app_id: APP_ID }, STAFF);
  expect(isErrorKeyPresent(result)).toBe(false);
  const structured = result.structuredContent as { entry?: { kind?: string } };
  expect(structured.entry?.kind).toBe("redo");
});

test("(AC-G23-2b) 陰性対照: `app` の書込を1本も持たない相手は、今日も MCP の undo / redo を断られる", async () => {
  // **拒否側を1本も測らないと、「全部通る」実装でもこのファイルは緑になる。**
  // **段2(権限を配る差分)を当てずに撃つ。**
  const applied = await callTool("apply_diff", { app_id: APP_ID, diff: SETUP_DIFF }, ADMIN);
  expect(isErrorKeyPresent(applied)).toBe(false);
  for (const tool of ["undo", "redo"]) {
    const result = await callTool(tool, { app_id: APP_ID }, STAFF);
    // **断られたときは `isError` キーが**入る**(記録 §0-7-2 の実測)。**
    expect(isErrorKeyPresent(result)).toBe(true);
    expect(result.isError).toBe(true);
    const structured = result.structuredContent as { errors?: Array<{ message?: string }> };
    expect(structured.errors?.[0]?.message).toContain("アプリの作りを変更できるのは");
  }
});

// --- (AC-G23-4) 運営を締め出していない --------------------------------------------

test("(AC-G23-4) owner の HTTP POST /undo は今日どおり 200 である", async () => {
  await setUpThroughTrivial();
  const res = await postUndo(adminCookie);
  expect(res.status).toBe(200);
});

// --- (AC-G23-5) 設定を変える口そのものは取り上げていない --------------------------

test("(AC-G23-5) `app` の書込だけを持つ非運営の HTTP POST /diffs は今日どおり 201 である", async () => {
  await setUpThroughGrant();
  const res = await app.request(
    authed(staffCookie)(diffsPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(TRIVIAL_DIFF),
    }),
  );
  // **`AC-G23` は「アプリの設定を変更できる」ことを取り上げる話ではない**(台帳 `:1849` の逐語)。
  expect(res.status).toBe(201);
});
