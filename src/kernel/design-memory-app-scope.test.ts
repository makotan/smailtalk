/**
 * **型と選んだ記録は1つのアプリの中だけで効く**(`V20-M15-T05`。計画 `docs/plan/v20/17-v20-m15-plan.md` §3 の `T05`・
 * §9-4 の 7・§4 の条件13 / [`ADR-0479`](../../../../docs/adr/0479-design-memory-choices-patterns-and-compare-off-pattern.md) /
 * `D-V20-18`)。
 *
 * ## この検査が測るもの
 *
 * 1. **(a)** 同じ形のアプリを2本(`alpha` / `beta`)用意し、`alpha` にだけ型と選んだ記録を書く。 **`beta` の**
 *    MCP `get_manifest`・HTTP `GET /manifest`・`dry_run_diff` の報告・`off_pattern` の判定(型が無いので断られる)・
 *    要件定義書(MCP と HTTP)・置き場のファイル(`apps/beta/` の全ファイルの sha256)・変更履歴の `beta` の行が、
 *    **書く前と1バイトも違わない**。 **陽性対照**: `alpha` の側は変わる(`off_pattern: true` が通るようになり、
 *    要件定義書に型の文が出る)。
 * 2. **(b) の振る舞いの側** —— 型を共有する器が置き場に1つも無い: 書いた目印を**データの置き場の全ファイル**から
 *    探すと、`apps/alpha/` の下と `kernel.sqlite`(系)にしか無く、`kernel.sqlite` の中で目印を持つ行は全部
 *    `app_id = 'alpha'` である。 **陰性対照**: 一度も書いていない綴りは0ファイル。
 *
 * **(b) の「アプリの ID を取らずに型を返す経路が0本」の走査**(ソースの `design_memory` を読む行を1本ずつ)は
 * 記録 `docs/plan/v20/records/v20-m15-t05.md` に式と出力で書く(ソースの文字列を数える検査はここに置かない ——
 * 逐語の残りで騙せるため)。
 *
 * **データはすべて一時ディレクトリの中で作る**(リポジトリの `data/` に1バイトも触らない)。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { COMPARE_NO_PATTERN_MESSAGE } from "../mcp/preview-compare.ts";
import { createMcpServer } from "../mcp/server.ts";
import { createServerApp } from "../server/app.ts";
import { authed, seedSession } from "../server/test-helpers.ts";
import { appDir, kernelDbPath } from "./storage-paths.ts";

const ALPHA = "alpha";
const BETA = "beta";
const TABLE_ID = "notes";
const BOOTSTRAP_ACTOR = "bootstrap";
const OWNER = "alice";
const PREVIEW_BASE_URL = "http://127.0.0.1:3000";

const PATTERN = "SCOPE-PATTERN-0001 入力フォームは区切りのある1カラム";
const CHOICE = {
  name: "SCOPE-CHOICE-NAME-0002",
  tradeoff: "SCOPE-TRADEOFF-0003",
  reason: "SCOPE-REASON-0004",
};
const MARKERS = [PATTERN, CHOICE.name, CHOICE.tradeoff, CHOICE.reason];

let work = "";
let dataRoot = "";
let previewRoot = "";
const cookies: Record<string, string> = {};

async function callTool(name: string, args: Record<string, unknown>, actor = OWNER) {
  const mcp = createMcpServer({ dataRoot, previewBaseUrl: PREVIEW_BASE_URL, previewRoot, actor });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
    await mcp.close();
  }
}

function okData(result: CallToolResult): Record<string, unknown> {
  if (result.isError === true) {
    throw new Error(`ツールが失敗した: ${JSON.stringify(result.structuredContent)}`);
  }
  return result.structuredContent as Record<string, unknown>;
}

function sha(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const r = rel === "" ? name : `${rel}/${name}`;
      if (statSync(full).isDirectory()) walk(full, r);
      else out.push(r);
    }
  };
  if (existsSync(root)) walk(root, "");
  return out.sort();
}

const probeDiff = {
  diff_id: "d-probe",
  intent: "覚え書きの欄を足したい",
  operations: [
    { op: "add_field", table: TABLE_ID, field: { id: "memo", name: "覚え書き", type: "text" } },
  ],
};

/** `beta`(または `alpha`)について、型が効きうる読み物を全部取る。 */
async function observe(appId: string): Promise<Record<string, string>> {
  const server = createServerApp({ dataRoot, preview: false });
  const http = async (path: string) => {
    const response = await server.request(
      authed(cookies[appId] as string)(`http://localhost${path}`),
    );
    expect(response.status).toBe(200);
    return response.text();
  };
  const files = Object.fromEntries(
    filesUnder(appDir(dataRoot, appId)).map((f) => [
      f,
      sha(readFileSync(join(appDir(dataRoot, appId), f))),
    ]),
  );
  const db = new Database(kernelDbPath(dataRoot), { readonly: true });
  const rows = db
    .query<Record<string, unknown>, [string]>(
      "SELECT * FROM changelog WHERE app_id = ? ORDER BY seq",
    )
    .all(appId);
  db.close();
  const offPattern = await callTool("dry_run_diff", {
    app_id: appId,
    diff: probeDiff,
    preview: "real",
    compare: { name: "型と違う案", tradeoff: "型から外れる", off_pattern: true },
  });
  return {
    get_manifest: JSON.stringify(okData(await callTool("get_manifest", { app_id: appId }))),
    http_manifest: await http(`/api/apps/${appId}/manifest`),
    dry_run_report: JSON.stringify(
      okData(await callTool("dry_run_diff", { app_id: appId, diff: probeDiff })).report,
    ),
    off_pattern: JSON.stringify(
      offPattern.isError === true
        ? { refused: offPattern.structuredContent }
        : { accepted: Object.keys(okData(offPattern)).sort() },
    ),
    requirements_mcp: JSON.stringify(
      okData(await callTool("generate_requirements_doc", { app_id: appId })),
    ),
    requirements_http: await http(`/api/apps/${appId}/requirements?format=json`),
    files: JSON.stringify(files),
    changelog_rows: JSON.stringify(rows),
  };
}

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "gp-design-memory-scope-"));
  dataRoot = join(work, "data");
  previewRoot = join(work, "previews");
  for (const appId of [ALPHA, BETA]) {
    okData(await callTool("create_app", { name: `器 ${appId}`, app_id: appId }, BOOTSTRAP_ACTOR));
    cookies[appId] = seedSession(dataRoot, appId, { username: OWNER }).cookie;
    okData(
      await callTool("apply_diff", {
        app_id: appId,
        diff: {
          diff_id: "setup",
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
      }),
    );
  }
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function rememberOnAlpha(): Promise<void> {
  okData(
    await callTool("apply_diff", {
      app_id: ALPHA,
      diff: {
        diff_id: "d-remember",
        intent: "選んだ形と型を記録する",
        operations: [
          { op: "remember_design", design_memory: { choice: CHOICE, patterns: [PATTERN] } },
        ],
      },
    }),
  );
}

describe("(a) 片方のアプリに型を保存しても、もう片方は1バイトも変わらない", () => {
  test("陽性対照の前提: 読み物は2回取っても同じ(時刻などで揺れない)", async () => {
    expect(await observe(BETA)).toEqual(await observe(BETA));
  });

  test("alpha に型と選んだ記録を書いても、beta の get_manifest・GET /manifest・dry_run_diff の報告・off_pattern の判定・要件定義書・置き場のファイル・変更履歴の行が同じ", async () => {
    const before = await observe(BETA);
    // 書く前の beta は off_pattern: true を「型が無い」で断られる。
    expect(before.off_pattern).toContain(COMPARE_NO_PATTERN_MESSAGE);
    await rememberOnAlpha();
    const after = await observe(BETA);
    for (const key of Object.keys(before)) {
      expect(after[key], key).toBe(before[key] as string);
    }
    for (const value of Object.values(after)) {
      for (const marker of MARKERS) expect(value).not.toContain(marker);
    }
  });

  test("陽性対照: alpha の側は変わる(off_pattern: true が通る・要件定義書に型の文・get_manifest に記録)", async () => {
    const before = await observe(ALPHA);
    await rememberOnAlpha();
    const after = await observe(ALPHA);
    expect(before.off_pattern).toContain(COMPARE_NO_PATTERN_MESSAGE);
    expect(after.off_pattern).toBe(JSON.stringify({ accepted: ["compare", "preview", "report"] }));
    expect(after.requirements_mcp).toContain(PATTERN);
    expect(after.requirements_http).toContain(PATTERN);
    expect(after.get_manifest).toContain(CHOICE.reason);
    expect(after.get_manifest).not.toBe(before.get_manifest);
  });
});

describe("(b) 型を共有する器が置き場に1つも無い", () => {
  function filesContaining(marker: string): string[] {
    return filesUnder(dataRoot).filter((f) => readFileSync(join(dataRoot, f)).includes(marker));
  }

  test("書いた目印は apps/alpha/ の下と kernel.sqlite(系)にしか無く、kernel.sqlite で目印を持つ行は全部 alpha のもの", async () => {
    await rememberOnAlpha();
    for (const marker of MARKERS) {
      const hits = filesContaining(marker);
      expect(hits.length, marker).toBeGreaterThan(0);
      for (const hit of hits) {
        expect(hit.startsWith(`apps/${ALPHA}/`) || hit.startsWith("kernel.sqlite"), hit).toBe(true);
      }
      expect(hits).toContain(`apps/${ALPHA}/manifest.json`);
    }
    const db = new Database(kernelDbPath(dataRoot), { readonly: true });
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name);
    const owners = new Set<string>();
    let rowsWithMarker = 0;
    for (const table of tables) {
      const rows = db.query<Record<string, unknown>, []>(`SELECT * FROM "${table}"`).all();
      for (const row of rows) {
        const text = JSON.stringify(row);
        if (MARKERS.some((m) => text.includes(m))) {
          rowsWithMarker += 1;
          owners.add(`${table}:${String(row.app_id)}`);
        }
      }
    }
    db.close();
    expect(rowsWithMarker).toBeGreaterThan(0);
    expect([...owners]).toEqual([`changelog:${ALPHA}`]);
  });

  test("陰性対照: 一度も書いていない綴りは0ファイル", async () => {
    await rememberOnAlpha();
    expect(filesContaining("SCOPE-NEVER-WRITTEN-9999")).toEqual([]);
  });
});
