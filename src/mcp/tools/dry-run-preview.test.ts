/**
 * **`dry_run_diff` の `preview` 引数**(`V20-M13-T02a`。計画 §9-3 / §10-3 / `ADR-0476`)。
 *
 * 固定するもの:
 * - **省略したときは今日と同じ応答・同じ後始末**(`preview` 欄が無く、置き場を1つも作らない)。
 * - 指定したとき: 成功なら `preview: { url, expires_at, mode }` が足され、URL は
 *   `<get_preview_url と同じ起点>/apps/pv-<16進32桁>/`。**レポートは省略時と同じ。**
 * - 拒否なら写しを残さず URL も返さない(errors は省略時と同じ)。
 * - **権限は今日の `denyAppSettingWrite` のまま** —— 規則を持たない相手・規則を1本も書いていない
 *   アプリの持ち主は、`preview` を付けても断られ、置き場は1つも作られない。
 * - 上限で作れないときは、レポートは返し、`preview` の代わりに理由を返す(拒否にしない)。
 * - 道具は 26本のまま。`get_preview_url` の引数は2本のまま。本体は1バイトも変わらない。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ValidationError } from "../../kernel/index.ts";
import { findPreview, PREVIEW_MAX_ENTRIES, parsePreviewAppId } from "../../server/preview-store.ts";
import { listDataRootFiles, seedSession } from "../../server/test-helpers.ts";
import { createMcpServer } from "../server.ts";

const APP_ID = "workshop";
const TABLE_ID = "notes";
const PREVIEW_BASE_URL = "http://127.0.0.1:3000";
const BOOTSTRAP_ACTOR = "bootstrap";
const DENIED = "アプリの作りを変更できるのは";

let work = "";
let dataRoot = "";
let previewRoot = "";
let alice: ReturnType<typeof seedSession>;
let bob: ReturnType<typeof seedSession>;

async function callTool(
  name: string,
  args: Record<string, unknown>,
  actor?: string,
): Promise<CallToolResult> {
  const server = createMcpServer(
    actor === undefined
      ? { dataRoot, previewBaseUrl: PREVIEW_BASE_URL, previewRoot }
      : { dataRoot, previewBaseUrl: PREVIEW_BASE_URL, previewRoot, actor },
  );
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

function okData(result: CallToolResult): Record<string, unknown> {
  if (result.isError === true) {
    throw new Error(`ツールが失敗した: ${JSON.stringify(result.structuredContent)}`);
  }
  return result.structuredContent as Record<string, unknown>;
}

function errorsOf(result: CallToolResult): ValidationError[] {
  expect(result.isError).toBe(true);
  return (result.structuredContent as { errors: ValidationError[] }).errors;
}

function diff(diffId = "d-preview"): Record<string, unknown> {
  return {
    diff_id: diffId,
    intent: "メモに覚え書きの欄を足したい",
    operations: [
      { op: "add_field", table: TABLE_ID, field: { id: "memo", name: "覚え書き", type: "text" } },
    ],
  };
}

function entries(): string[] {
  return existsSync(previewRoot) ? readdirSync(previewRoot) : [];
}

/**
 * 本体の全ファイルの一覧。SQLite の付随ファイル2種(`-shm` と 0 バイトの `-wal`)だけを外す
 * (V20-M13 実 CI の赤。Linux では読むだけの接続が閉じた後に残る。外し方と陽性対照は
 * `src/server/test-helpers.ts` の `listDataRootFiles` と `src/server/preview-invariance.test.ts`)。
 */
function listAllFiles(dir: string): string[] {
  return listDataRootFiles(dir);
}

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "gp-mcp-dry-run-preview-"));
  dataRoot = join(work, "data");
  previewRoot = join(work, "previews");
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
  await rm(work, { recursive: true, force: true });
});

test("省略したときは preview 欄が無く、置き場を1つも作らない(今日と同じ)", async () => {
  const data = okData(
    await callTool("dry_run_diff", { app_id: APP_ID, diff: diff() }, alice.username),
  );
  expect(Object.keys(data).sort()).toEqual(["report"]);
  expect(existsSync(previewRoot)).toBe(false);
});

test("real を指定すると URL・期限・モードが足され、レポートは省略時と同じ", async () => {
  const plain = okData(
    await callTool("dry_run_diff", { app_id: APP_ID, diff: diff() }, alice.username),
  );
  const before = Date.now();
  const data = okData(
    await callTool(
      "dry_run_diff",
      { app_id: APP_ID, diff: diff(), preview: "real" },
      alice.username,
    ),
  );
  expect(Object.keys(data).sort()).toEqual(["preview", "report"]);
  expect(data.report).toEqual(plain.report);
  const preview = data.preview as { url: string; expires_at: string; mode: string };
  expect(Object.keys(preview).sort()).toEqual(["expires_at", "mode", "url"]);
  expect(preview.mode).toBe("real");
  expect(preview.url).toMatch(/^http:\/\/127\.0\.0\.1:3000\/apps\/pv-[0-9a-f]{32}\/$/);
  const expires = Date.parse(preview.expires_at);
  expect(expires - before).toBeGreaterThanOrEqual(3600 * 1000 - 1000);
  expect(expires - Date.now()).toBeLessThanOrEqual(3600 * 1000);

  const appId = /\/apps\/(pv-[0-9a-f]{32})\/$/.exec(preview.url)?.[1] ?? "";
  const id = parsePreviewAppId(appId);
  expect(id).not.toBeNull();
  const meta = findPreview(previewRoot, id ?? "");
  expect(meta?.app_id).toBe(APP_ID);
  expect(meta?.requester_user_id).toBe(alice.userId);
  expect(meta?.mode).toBe("real");
  expect(meta?.expires_at).toBe(preview.expires_at);
  // 写しは当てた後の姿で、頼んだ人のセッションが1行だけ在る。
  const db = new Database(join(meta?.shadow_data_root ?? "", "apps", APP_ID, "app.sqlite"), {
    readonly: true,
  });
  try {
    const cols = (db.query(`PRAGMA table_info("notes")`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain("memo");
    const sessions = db.query(`SELECT "user_id" FROM "_auth_sessions"`).all() as {
      user_id: string;
    }[];
    expect(sessions).toEqual([{ user_id: alice.userId }]);
  } finally {
    db.close();
  }
});

test("sample を指定すると mode が sample で返る", async () => {
  const data = okData(
    await callTool(
      "dry_run_diff",
      { app_id: APP_ID, diff: diff(), preview: "sample" },
      alice.username,
    ),
  );
  expect((data.preview as { mode: string }).mode).toBe("sample");
});

test("preview を付けても本体(dataRoot)のファイルは1つも増減しない", async () => {
  const before = listAllFiles(dataRoot);
  const manifestBefore = readFileSync(join(dataRoot, "apps", APP_ID, "manifest.json"), "utf-8");
  okData(
    await callTool(
      "dry_run_diff",
      { app_id: APP_ID, diff: diff(), preview: "real" },
      alice.username,
    ),
  );
  expect(listAllFiles(dataRoot)).toEqual(before);
  expect(readFileSync(join(dataRoot, "apps", APP_ID, "manifest.json"), "utf-8")).toBe(
    manifestBefore,
  );
});

test("拒否される差分では写しを残さず URL も返さない(errors は省略時と同じ)", async () => {
  const bad = {
    diff_id: "d-bad",
    intent: "無い表に列を足す",
    operations: [{ op: "add_field", table: "ghosts", field: { id: "x", name: "X", type: "text" } }],
  };
  const plain = errorsOf(
    await callTool("dry_run_diff", { app_id: APP_ID, diff: bad }, alice.username),
  );
  const withPreview = await callTool(
    "dry_run_diff",
    { app_id: APP_ID, diff: bad, preview: "real" },
    alice.username,
  );
  expect(errorsOf(withPreview)).toEqual(plain);
  expect(JSON.stringify(withPreview.structuredContent)).not.toContain("pv-");
  expect(entries()).toEqual([]);
});

test("断られる側: 規則を持たない相手は preview を付けても断られ、置き場は作られない", async () => {
  const result = await callTool(
    "dry_run_diff",
    { app_id: APP_ID, diff: diff(), preview: "real" },
    bob.username,
  );
  expect(
    errorsOf(result)
      .map((e) => e.message)
      .join(" / "),
  ).toContain(DENIED);
  expect(entries()).toEqual([]);
});

test("断られる側: 役割の規則を1本も書いていないアプリでは持ち主でも断られる", async () => {
  const path = join(dataRoot, "apps", APP_ID, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf-8")) as { app: Record<string, unknown> };
  expect(Array.isArray(manifest.app.roles)).toBe(true);
  delete manifest.app.roles;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  const result = await callTool(
    "dry_run_diff",
    { app_id: APP_ID, diff: diff(), preview: "real" },
    alice.username,
  );
  expect(
    errorsOf(result)
      .map((e) => e.message)
      .join(" / "),
  ).toContain(DENIED);
  expect(entries()).toEqual([]);
});

test("名乗りが無ければ preview を付けても断られる", async () => {
  const result = await callTool("dry_run_diff", { app_id: APP_ID, diff: diff(), preview: "real" });
  expect(result.isError).toBe(true);
  expect(entries()).toEqual([]);
});

test("preview に2値以外は受けない", async () => {
  const result = await callTool(
    "dry_run_diff",
    { app_id: APP_ID, diff: diff(), preview: "later" },
    alice.username,
  );
  expect(result.isError).toBe(true);
  expect(entries()).toEqual([]);
});

test(`上限(${PREVIEW_MAX_ENTRIES}個)で作れないときは、レポートを返し preview の代わりに理由を返す`, async () => {
  for (let i = 0; i < PREVIEW_MAX_ENTRIES; i += 1) {
    okData(
      await callTool(
        "dry_run_diff",
        { app_id: APP_ID, diff: diff(), preview: "real" },
        alice.username,
      ),
    );
  }
  expect(entries()).toHaveLength(PREVIEW_MAX_ENTRIES);
  const data = okData(
    await callTool(
      "dry_run_diff",
      { app_id: APP_ID, diff: diff(), preview: "real" },
      alice.username,
    ),
  );
  expect(Object.keys(data).sort()).toEqual(["preview_refused", "report"]);
  expect((data.preview_refused as { reason: string }).reason).toContain("20");
  expect(entries()).toHaveLength(PREVIEW_MAX_ENTRIES);
});

test("道具は26本のまま・dry_run_diff の preview は2値・get_preview_url の引数は2本のまま", async () => {
  const server = createMcpServer({ dataRoot, previewBaseUrl: PREVIEW_BASE_URL, previewRoot });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const { tools } = await client.listTools();
    // **【2026-10-02。`V23-M8-T05` / 授権 `ADR-0545` 行108】期待値を 26 → 27 へ書き換えた**(`list_record_history`)。
    // **旧行の逐語**: `expect(tools).toHaveLength(26);` **テスト名は書き換えていない。**
    expect(tools).toHaveLength(27);
    const dry = tools.find((t) => t.name === "dry_run_diff");
    const props = dry?.inputSchema.properties as Record<string, { enum?: string[] }>;
    // **【`V20-M14-T01A` / `ADR-0478` §Decision 1-1】旧逐語は `["app_id", "diff", "preview"]` だった。**
    // 省略可能な `compare` を1本足した(形は `dry-run-compare.test.ts` が撃つ)。 必須は今日も2本。
    expect(Object.keys(props).sort()).toEqual(["app_id", "compare", "diff", "preview"]);
    expect(props.preview?.enum).toEqual(["real", "sample"]);
    expect(dry?.inputSchema.required).toEqual(["app_id", "diff"]);
    // 説明文: 「引数は apply_diff とまったく同じ」は偽になったので無い。preview の1〜2文が在る。
    const description = dry?.description ?? "";
    expect(description).not.toContain("引数は apply_diff とまったく同じ");
    expect(description).toContain("差分(diff)の形は apply_diff とまったく同じ");
    expect(description).toContain("下見は保存されず、1時間で消えます");
    expect(description).toContain("URL を知っている人なら誰でも");
    for (const lie of ["保存できます", "見返せます"]) {
      expect(description, lie).not.toContain(lie);
    }
    const preview = tools.find((t) => t.name === "get_preview_url");
    expect(Object.keys(preview?.inputSchema.properties ?? {}).sort()).toEqual([
      "app_id",
      "view_id",
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

// **【`V20-M13` 点検の処置 軽4】** HTTP の入口(`http-entry.ts`)は `ST_PREVIEW_ROOT` を読んでも
// `startMcpHttpServer` に渡しておらず、下見を既定の根(`<dataRoot>.previews`)に作っていた。
// **Web サーバと根が食い違うと、作った直後の下見が 410 に見える。** 入口が渡す根に作ることを撃つ。
test("HTTP の入口: startMcpHttpServer に渡した previewRoot の下に下見を作る(既定の根には作らない)", async () => {
  const { startMcpHttpServer } = await import("../http-transport.ts");
  const running = await startMcpHttpServer({
    dataRoot,
    previewBaseUrl: PREVIEW_BASE_URL,
    port: 0,
    actor: alice.username,
    previewRoot,
  });
  try {
    const response = await fetch(running.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        origin: running.expectedOrigins[0] as string,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "dry_run_diff",
          arguments: { app_id: APP_ID, diff: diff(), preview: "real" },
        },
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result?: { isError?: boolean } };
    expect(body.result?.isError, JSON.stringify(body)).not.toBe(true);
  } finally {
    await running.stop();
  }
  expect(entries()).toHaveLength(1);
  expect(existsSync(`${dataRoot}.previews`)).toBe(false);
});
