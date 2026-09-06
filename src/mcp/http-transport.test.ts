/**
 * MCP の**2本目の入口**(Streamable HTTP)の検査(`V5-M9` / `ADR-0271`〜`ADR-0274`)。
 *
 * ## この検査が固定するもの
 *
 * **肯定形だけでは足りない**(`docs/plan/v5/02-mcp-transport-baseline.md` §8-1 の 2)。
 * 本ファイルは**否定形**を3つのうち2つ持つ:
 *
 * 1. **`0.0.0.0` にバインドしない**(`R-G15-c`)—— 綴りが `src/mcp/` の非テストファイルに
 *    1件も無いこと、環境変数でホスト名を動かせないこと、実際に起動したサーバの
 *    `hostname` が `127.0.0.1` であることの3つで固定する。
 * 2. **stdio の入口が壊れていない**(`R-G15-a` 限定2)—— `src/mcp/index.ts` が今日も
 *    `StdioServerTransport` だけを使い、HTTP のトランスポートを1件も import しないこと。
 *
 * 3つ目(**公開ツールが23本のまま**)は `src/mcp/descriptions.test.ts` が既に持っている。
 * 本ファイルは HTTP 越しの `tools/list` でも23本であることを別に測る。
 *
 * ## Origin の扱い(`R-G15-b`。**既存 HTTP と食い違う**)
 *
 * **`src/server/app.ts` の既存の Origin 検査は「ヘッダが在るときだけ照合する」形で、
 * 無い要求を通す。** MCP の口は**通さない**(403)。**この食い違いは意図的であり、
 * 下の検査が両方の挙動を固定する**(`ADR-0272` 限定3 / 限定4)。
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  loadMcpHttpConfig,
  MCP_HTTP_HOSTNAME,
  MCP_HTTP_PATH,
  originDecision,
  startMcpHttpServer,
} from "./http-transport.ts";

const REPO_ROOT = dirname(dirname(import.meta.dir));
const PREVIEW_BASE_URL = "http://127.0.0.1:3000";

let dataRoot: string;
let server: Awaited<ReturnType<typeof startMcpHttpServer>>;
let origin: string;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "st-mcp-http-"));
  server = await startMcpHttpServer({
    dataRoot,
    previewBaseUrl: PREVIEW_BASE_URL,
    port: 0,
  });
  origin = `http://${MCP_HTTP_HOSTNAME}:${String(server.port)}`;
});

afterEach(async () => {
  await server.stop();
  await rm(dataRoot, { recursive: true, force: true });
});

function endpoint(): string {
  return `http://${MCP_HTTP_HOSTNAME}:${String(server.port)}${MCP_HTTP_PATH}`;
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "v5-m9-test", version: "0.0.0" },
  },
};

function postHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// 段1: R-G15-a(入口が立つ)/ R-G15-c(ループバックにだけバインドする)
// ---------------------------------------------------------------------------

test("段1: 起動したサーバのバインド先は 127.0.0.1 である", () => {
  expect(server.hostname).toBe("127.0.0.1");
  expect(MCP_HTTP_HOSTNAME).toBe("127.0.0.1");
});

test("段1【否定形 i-1】: src/mcp/ の非テストファイルに 0.0.0.0 の綴りが1件も無い", async () => {
  const glob = new Bun.Glob("src/mcp/**/*.ts");
  const offenders: string[] = [];
  for await (const relative of glob.scan({ cwd: REPO_ROOT })) {
    if (relative.endsWith(".test.ts")) {
      continue;
    }
    const text = readFileSync(join(REPO_ROOT, relative), "utf8");
    if (text.includes("0.0.0.0")) {
      offenders.push(relative);
    }
  }
  expect(offenders).toEqual([]);
});

test("段1【否定形 i-2】: ホスト名は環境変数で動かせない", async () => {
  // `ST_MCP_HTTP_HOSTNAME` という逃げ道を作っていないことを、実際に渡して確かめる。
  const config = loadMcpHttpConfig({
    ST_MCP_HTTP_HOSTNAME: "0.0.0.0",
    ST_MCP_HTTP_PORT: "0",
  });
  expect(Object.keys(config)).not.toContain("hostname");

  const other = await startMcpHttpServer({
    dataRoot,
    previewBaseUrl: PREVIEW_BASE_URL,
    port: 0,
    env: { ST_MCP_HTTP_HOSTNAME: "0.0.0.0" },
  });
  try {
    expect(other.hostname).toBe("127.0.0.1");
  } finally {
    await other.stop();
  }
});

test("段1: HTTP 越しに initialize が通り、tools/list が23本を返す", async () => {
  const init = await fetch(endpoint(), {
    method: "POST",
    headers: postHeaders({ origin }),
    body: JSON.stringify(INITIALIZE),
  });
  expect(init.status).toBe(200);
  const initBody = (await init.json()) as {
    result?: { serverInfo?: { name?: string } };
  };
  expect(initBody.result?.serverInfo?.name).toBe("smailtalk");

  const list = await fetch(endpoint(), {
    method: "POST",
    headers: postHeaders({ origin }),
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  expect(list.status).toBe(200);
  const listBody = (await list.json()) as { result?: { tools?: unknown[] } };
  // **【2026-08-15。`V8-M13-T02`。台帳 `Q-G28` = 限定採用(門A)】期待値を 23 → 24 へ
  // 書き換えた。** **旧行の逐語**: `expect(listBody.result?.tools?.length).toBe(23);`
  // **足したのは `read_report`(集計表を1枚読む参照系)1本だけである。**
  // **テスト名は1バイトも書き換えていない**(「23本」は 2026-08-14 までの事実)。
  // **【2026-08-24。`V10-M12-T01`。台帳 `CM-G7` / `ADR-0368`】期待値を 24 → 25 へ
  // 書き換えた。** **旧行の逐語**: `expect(listBody.result?.tools?.length).toBe(24);`
  // **足したのは `list_comments`(コメントを読む参照系)1本だけである。**
  // **【2026-08-25。`V10-M30-T02`。台帳 `CM-G37` / `ADR-0378`】期待値を 25 → 26 へ
  // 書き換えた。** **旧行の逐語**: `expect(listBody.result?.tools?.length).toBe(25);`
  // **足したのは `set_comment_visibility`(コメントの出し入れを切り替える更新系)1本だけである。**
  expect(listBody.result?.tools?.length).toBe(26);
});

test("段1: MCP のパス以外は 404 を返す", async () => {
  const response = await fetch(`http://${MCP_HTTP_HOSTNAME}:${String(server.port)}/`, {
    method: "POST",
    headers: postHeaders({ origin }),
    body: JSON.stringify(INITIALIZE),
  });
  expect(response.status).toBe(404);
});

// ---------------------------------------------------------------------------
// 段2: R-G15-b(Origin の照合を全要求に掛ける)
// ---------------------------------------------------------------------------

test("段2: 期待オリジンと一致する要求は通る", async () => {
  const response = await fetch(endpoint(), {
    method: "POST",
    headers: postHeaders({ origin }),
    body: JSON.stringify(INITIALIZE),
  });
  expect(response.status).toBe(200);
});

test("段2: 期待オリジンと違う Origin は 403", async () => {
  const response = await fetch(endpoint(), {
    method: "POST",
    headers: postHeaders({ origin: "http://evil.example" }),
    body: JSON.stringify(INITIALIZE),
  });
  expect(response.status).toBe(403);
  const body = (await response.json()) as { errors?: { path?: string; message?: string }[] };
  expect(body.errors?.length).toBe(1);
  expect(body.errors?.[0]?.path).toBe("origin");
});

test("段2【この軸の決定】: Origin ヘッダが無い POST は 403 で落とす", async () => {
  const response = await fetch(endpoint(), {
    method: "POST",
    headers: postHeaders(),
    body: JSON.stringify(INITIALIZE),
  });
  expect(response.status).toBe(403);
});

test("段2: 照合は POST 以外にも掛かる(GET / DELETE / PUT)", async () => {
  for (const method of ["GET", "DELETE", "PUT"]) {
    const response = await fetch(endpoint(), {
      method,
      headers: { accept: "application/json, text/event-stream" },
    });
    expect(`${method}:${String(response.status)}`).toBe(`${method}:403`);
  }
});

test("段2: Referer だけでは通らない(既存 HTTP の refererOrigin フォールバックを持たない)", async () => {
  const response = await fetch(endpoint(), {
    method: "POST",
    headers: postHeaders({ referer: `${origin}/somewhere` }),
    body: JSON.stringify(INITIALIZE),
  });
  expect(response.status).toBe(403);
});

test("段2: originDecision は3つの結果を持ち、missing を許さない", () => {
  const allowed = "http://127.0.0.1:3100";
  const expected = [allowed];
  expect(
    originDecision(new Request(`${allowed}/mcp`, { headers: { origin: allowed } }), expected),
  ).toEqual({ allowed: true, outcome: "match", origin: allowed });
  expect(
    originDecision(new Request(`${allowed}/mcp`, { headers: { origin: "http://evil" } }), expected),
  ).toEqual({ allowed: false, outcome: "mismatch", origin: "http://evil" });
  expect(originDecision(new Request(`${allowed}/mcp`), expected)).toEqual({
    allowed: false,
    outcome: "missing",
  });
});

test("段2【食い違いの固定】: 既存 HTTP は今日も『ヘッダが在るときだけ照合する』形である", () => {
  const appTs = readFileSync(join(REPO_ROOT, "src", "server", "app.ts"), "utf8");
  const occurrences =
    appTs.split("if (origin !== undefined && !authConfig.expectedOrigins.includes(origin)) {")
      .length - 1;
  // 2026-08-06 実測で7箇所。**この軸は1箇所も変えない。**
  expect(occurrences).toBe(7);

  // MCP 側は同じ形を持たない(= ヘッダが無い要求を通さない)。
  const httpTs = readFileSync(join(REPO_ROOT, "src", "mcp", "http-transport.ts"), "utf8");
  expect(httpTs.includes("origin !== undefined &&")).toBe(false);
});

test("段2: 期待オリジンは ST_MCP_HTTP_EXPECTED_ORIGIN から読み、ST_AUTH_EXPECTED_ORIGIN を読まない", () => {
  const config = loadMcpHttpConfig({
    ST_MCP_HTTP_PORT: "3100",
    ST_MCP_HTTP_EXPECTED_ORIGIN: "http://127.0.0.1:3100, http://localhost:3100",
    ST_AUTH_EXPECTED_ORIGIN: "http://should-not-be-read.example",
  });
  expect(config.expectedOrigins).toEqual(["http://127.0.0.1:3100", "http://localhost:3100"]);

  const fallback = loadMcpHttpConfig({ ST_MCP_HTTP_PORT: "3100" });
  expect(fallback.expectedOrigins).toEqual(["http://127.0.0.1:3100"]);
});

/**
 * **`ST_PREVIEW_BASE_URL` の既定は `http://localhost:3000` である**(2026-09-06)。
 *
 * **着手前は `http://127.0.0.1:3000` だった。** `get_preview_url` はこの値を基底に
 * URL を組み立てるので、**AI が返したプレビュー URL をそのまま開くと、画面は出るのに
 * 保存だけが 403 で断られていた**(書き込みを許す origin の既定に `127.0.0.1` は
 * 1本も無く、`ST_AUTH_EXPECTED_ORIGIN` に書いて逃げることもできない ——
 * rpID の登録可能サフィックス検査がリッスン前に落とす)。
 *
 * **これは既定を検査する初めての1本である**(着手前は0件だった)。
 */
test("ST_PREVIEW_BASE_URL の既定は http://localhost:3000(渡せば上書きできる)", () => {
  expect(loadMcpHttpConfig({}).previewBaseUrl).toBe("http://localhost:3000");
  expect(loadMcpHttpConfig({ ST_PREVIEW_BASE_URL: "http://example.test" }).previewBaseUrl).toBe(
    "http://example.test",
  );
});

// ---------------------------------------------------------------------------
// 段3: R-G15-d(セッション / プロトコル版 / 再開)
// ---------------------------------------------------------------------------

test("段3: セッションを持たない —— initialize の応答に mcp-session-id が無い", async () => {
  const response = await fetch(endpoint(), {
    method: "POST",
    headers: postHeaders({ origin }),
    body: JSON.stringify(INITIALIZE),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("mcp-session-id")).toBeNull();
});

test("段3: 未対応の MCP-Protocol-Version は 400 で落ちる(SDK の実装。自分では1行も書いていない)", async () => {
  const response = await fetch(endpoint(), {
    method: "POST",
    headers: postHeaders({ origin, "mcp-protocol-version": "1999-01-01" }),
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
  });
  expect(response.status).toBe(400);
});

test("段3: サーバ発の SSE ストリームを開かない —— GET は 405(仕様が明示的に許す形)", async () => {
  const plain = await fetch(endpoint(), {
    method: "GET",
    headers: { accept: "text/event-stream", origin },
  });
  expect(plain.status).toBe(405);
  const body = (await plain.json()) as { errors?: { path?: string }[] };
  expect(body.errors?.[0]?.path).toBe("method");
});

test("段3: 再開を持たない —— Last-Event-ID を付けても応答は変わらない(どちらも 405)", async () => {
  const resumed = await fetch(endpoint(), {
    method: "GET",
    headers: { accept: "text/event-stream", origin, "last-event-id": "whatever" },
  });
  expect(resumed.status).toBe(405);
  await resumed.body?.cancel();
});

test("段3: DELETE の今日の応答を実測して固定する(セッションが無いので終了させるものが無い)", async () => {
  const response = await fetch(endpoint(), { method: "DELETE", headers: { origin } });
  // **これは SDK の挙動の固定であって、この軸の仕様ではない**(`ADR-0274` 限定4)。
  expect(response.status).toBe(200);
});

test("段3: PUT は 405 を返す(Origin が通ったあと)", async () => {
  const response = await fetch(endpoint(), {
    method: "PUT",
    headers: postHeaders({ origin }),
    body: "{}",
  });
  expect(response.status).toBe(405);
});

// ---------------------------------------------------------------------------
// 否定形 ii: stdio の入口が壊れていない
// ---------------------------------------------------------------------------

test("【否定形 ii】: src/mcp/index.ts は今日も stdio だけを繋ぎ、HTTP のトランスポートを1件も import しない", () => {
  const entry = readFileSync(join(REPO_ROOT, "src", "mcp", "index.ts"), "utf8");
  expect(
    entry.includes(
      'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
    ),
  ).toBe(true);
  expect(entry.includes("const transport = new StdioServerTransport();")).toBe(true);
  expect(entry.includes("streamableHttp")).toBe(false);
  expect(entry.includes("StreamableHTTPServerTransport")).toBe(false);
  expect(entry.includes("Bun.serve")).toBe(false);
});
