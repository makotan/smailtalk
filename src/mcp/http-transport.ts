/**
 * MCP の**2本目の入口**(Streamable HTTP)。`V5-M9` / `R-G15-a`〜`R-G15-d`。
 *
 * **これは stdio(`src/mcp/index.ts`)を置き換えるものではない。**
 * `ADR-0271` 限定2 のとおり `src/mcp/index.ts` は1バイトも変わっていない。
 * 増えたのは入口が1本だけである。**stdio は今日どおり動く。**
 *
 * ## 何を守り、何を守らないか(誇張しない)
 *
 * | 仕様(2025-06-18 transports の Security Warning) | この実装 |
 * |---|---|
 * | 1. すべての着信接続で `Origin` を検証しなければならない(**MUST**) | **全メソッドに掛ける**(`originDecision`)。**ヘッダが無い要求も落とす** |
 * | 2. ローカルで動かすときは localhost にだけバインドすべき(**SHOULD**) | **`MCP_HTTP_HOSTNAME` は定数であり、環境変数でも引数でも動かせない** |
 * | 3. すべての接続に適切な認証を実装すべき(**SHOULD**) | **満たさない。** ユーザ決定 `D-V5-9` により認証層を作らない。**この入口は無認証である** |
 *
 * **`Origin` の照合は認証の代わりにならない。** ブラウザ以外のクライアント
 * (`curl` / 任意のスクリプト)は好きな `Origin` を名乗れる。**止められるのは
 * 「利用者のブラウザで開かれた悪意あるページ」だけで、「ローカルに到達できる
 * 任意のプログラム」ではない。**
 *
 * ## 既存 HTTP(`src/server/app.ts`)との食い違い(**意図的。黙って作らない**)
 *
 * 既存の Origin 検査は「**ヘッダが在るときだけ照合する**」形で、`Origin` も
 * `Referer` も無い要求を**通す**。**この入口は通さない**(`ADR-0272` 限定3)。
 * また **`Referer` へのフォールバックを持たない**(同 限定4)。
 * 理由は、DNS リバインディングで同一オリジンになったページからの GET が
 * `Origin` を付けずに届きうるためである。**食い違いは
 * `src/mcp/http-transport.test.ts` の「食い違いの固定」が両側から測っている。**
 *
 * ## セッションと再開(`ADR-0274`)
 *
 * **どちらも持たない。** `sessionIdGenerator` を渡さない(= SDK のステートレス
 * モード)ので `Mcp-Session-Id` を1度も発行しない。`eventStore` を渡さないので
 * `Last-Event-ID` を1件も処理しない。**「実装した」のではなく「持たないと決めた」。**
 *
 * SDK はステートレスのトランスポートの使い回しを禁じている ——
 * `node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js:140`
 * 逐語 `throw new Error('Stateless transport cannot be reused across requests. Create a new transport per request.');`
 * したがって**要求ごとに**トランスポートと `McpServer` を作る。
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { normalizeActor } from "./actor-guard.ts";
import { createMcpServer } from "./server.ts";

/**
 * バインド先。**定数である。**
 *
 * `src/server/index.ts:23` 逐語 `const HOSTNAME = "127.0.0.1";` と同型にしてある。
 * **環境変数でも引数でも動かせない**(`ADR-0273` 限定1 / 限定3)。
 * `ADR-0003` 逐語「リッスンアドレスは既定で `127.0.0.1` に固定する。」/ `ADR-0014` §15。
 */
export const MCP_HTTP_HOSTNAME = "127.0.0.1";

/** MCP エンドポイントのパス。**1本だけである**(`ADR-0271` 限定7)。 */
export const MCP_HTTP_PATH = "/mcp";

/** 既定のポート。Web サーバ(3000)と衝突しない値を選んだ。 */
export const DEFAULT_MCP_HTTP_PORT = 3100;

export type McpHttpConfig = {
  /** データルート。**Web サーバと同じ値でなければならない**(`ADR-0005:175`)。 */
  dataRoot: string;
  /** `get_preview_url` が返す URL の基底。Web サーバのリッスン先と揃える。 */
  previewBaseUrl: string;
  /** リッスンポート。**ホスト名はここに無い**(定数である)。 */
  port: number;
  /** 期待するオリジンの一覧。**ワイルドカードを1つも許さない**(`ADR-0272` 限定6)。 */
  expectedOrigins: string[];
  /**
   * `expectedOrigins` が環境変数から来たか(`true`)、ポートから組み立てた既定か(`false`)。
   *
   * **ポートに `0`(= 空いている口を割り当てる)を渡した場合、既定の期待オリジンは
   * `http://127.0.0.1:0` という使えない値になる。** 呼び出し側はこの旗を見て、
   * 既定のときは `startMcpHttpServer` に渡さず、**バインド後の実ポート**で
   * 組み立て直させる。**旗を持たないと、この違いが黙って 403 になる**
   * (実際に `V5-M9` の実装中に1度なった)。
   */
  expectedOriginsFromEnv: boolean;
  /**
   * **この入口が、どの利用者として動くか**(`V8-M31-T02`。ログイン名または利用者ID)。
   * **未設定・空文字・空白だけなら `undefined`**(= 名乗り無し。**23本すべてが失敗する**)。
   * **【2026-08-16 訂正(`V8-M13-T04`)。直前の本数を1バイトも消していない】この「23本」は今日は24本である**(`V8-M13-T02` が `read_report` を足した)。
   * **【2026-08-24 訂正(`V10-M12-T01`。`ADR-0368`)。直前の1行を1バイトも消していない】直前の「24本」は今日は25本である**(`V10-M12-T01` が `list_comments` を足した)。
   * **【2026-08-26 訂正(`V10-M34-T01`。台帳 `CM-G45` / `ADR-0379`)。直前の1行を1バイトも消していない】直前の「25本」は今日は26本である**(`V10-M30-T02` が `set_comment_visibility` を足した)。
   *
   * **`T-G21b` の帰結を正直に書く**: **この口を立ち上げた人が、以後そのポートに繋ぐ
   * 全員の主体を決める。** `ADR-0271` のとおりこの入口には認証が無い(`D-V5-9`)ので、
   * **名乗った主体の権限が、ループバックに到達できる誰にでも渡る。**
   */
  actor: string | undefined;
};

/** `Origin` の照合結果。**3値であり、`missing` は許さない。** */
export type OriginDecision =
  | { allowed: true; outcome: "match"; origin: string }
  | { allowed: false; outcome: "mismatch"; origin: string }
  | { allowed: false; outcome: "missing" };

function splitOrigins(raw: string): string[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/**
 * 環境変数から設定を読む。**`process.env` を直接読まず、引数で受ける**
 * (`src/auth/config.ts:70` の `loadAuthConfig` と同じ作法)。
 *
 * **読む環境変数は2本だけである**(`ADR-0275` 限定3):
 *
 * | 変数 | 既定 | 意味 |
 * |---|---|---|
 * | `ST_MCP_HTTP_PORT` | `3100` | リッスンポート |
 * | `ST_MCP_HTTP_EXPECTED_ORIGIN` | `http://127.0.0.1:<port>` | 期待オリジン(カンマ区切り) |
 *
 * **【`V8-M31-T02` で3本目が増えた】** —— **`ST_MCP_ACTOR`(既定なし)。**
 * **上の「2本だけである」は、この入口に固有の設定についての話として今日も真である**
 * (`ST_DATA_ROOT` / `ST_PREVIEW_BASE_URL` は元から両入口で共有していた)。
 * **名乗りもその共有の側であり、`src/mcp/index.ts`(stdio)と同じ鍵を同じ意味で読む** ——
 * **入口ごとに違う鍵を作らない。**
 *
 * **`ST_AUTH_EXPECTED_ORIGIN`(Web の口の設定)を1バイトも読まない**
 * (`ADR-0272` 限定5)—— 2つの口の期待値を混ぜない。
 * **ホスト名を読む変数は存在しない。**
 */
export function loadMcpHttpConfig(env: Record<string, string | undefined>): McpHttpConfig {
  const portRaw = env.ST_MCP_HTTP_PORT;
  const parsed = portRaw === undefined ? Number.NaN : Number.parseInt(portRaw, 10);
  const port = Number.isNaN(parsed) ? DEFAULT_MCP_HTTP_PORT : parsed;
  const declared = splitOrigins(env.ST_MCP_HTTP_EXPECTED_ORIGIN ?? "");
  const fromEnv = declared.length > 0;
  const expectedOrigins = fromEnv ? declared : [`http://${MCP_HTTP_HOSTNAME}:${String(port)}`];

  return {
    dataRoot: env.ST_DATA_ROOT ?? "data",
    // **既定は `localhost` である**(2026-09-06。着手前は `http://127.0.0.1:3000` だった)。
    // `get_preview_url` が返す URL をそのまま開いたときに、**保存だけが 403 になる**のを避ける
    // (書き込みを許す origin の既定に `127.0.0.1` は1本も無い。`src/auth/config.ts` 参照)。
    previewBaseUrl: env.ST_PREVIEW_BASE_URL ?? "http://localhost:3000",
    port,
    expectedOrigins,
    expectedOriginsFromEnv: fromEnv,
    // **名乗りを読むのは、HTTP ではこの1行だけである**(裁定 `M31-1`)。
    // **既定値を持たない**(既定の主体を置くと、それが事実上の全権になる)。
    actor: normalizeActor(env.ST_MCP_ACTOR),
  };
}

/**
 * `Origin` を照合する。**要求のメソッドを1つも見ない** —— 仕様の MUST は
 * 「all incoming connections」であり、メソッドによる免除を作らない
 * (`ADR-0272` 限定2)。
 *
 * **`Referer` を見ない。** 既存 HTTP(`src/server/app.ts`)は
 * `origin ?? refererOrigin(referer)` の形だが、この入口は採らない
 * (`ADR-0272` 限定4)。MCP クライアントは `Referer` を送らない。
 */
export function originDecision(request: Request, expectedOrigins: string[]): OriginDecision {
  const header = request.headers.get("origin");
  if (header === null) {
    return { allowed: false, outcome: "missing" };
  }
  if (expectedOrigins.includes(header)) {
    return { allowed: true, outcome: "match", origin: header };
  }
  return { allowed: false, outcome: "mismatch", origin: header };
}

/** 既存の入口と同じ `{ errors: [{ path, message, hint }] }` の形で返す(新しい形式を発明しない)。 */
function errorResponse(status: number, path: string, message: string, hint?: string): Response {
  const error: { path: string; message: string; hint?: string } = { path, message };
  if (hint !== undefined) {
    error.hint = hint;
  }
  return new Response(JSON.stringify({ errors: [error] }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function originRejected(decision: OriginDecision, expectedOrigins: string[]): Response {
  if (decision.outcome === "missing") {
    return errorResponse(
      403,
      "origin",
      "Origin ヘッダがありません。この入口は Origin の無い要求を受け付けません。",
      `期待している Origin: ${expectedOrigins.join(", ")}(MCP クライアント側の設定で Origin ヘッダを付けてください)`,
    );
  }
  return errorResponse(
    403,
    "origin",
    `Origin "${decision.outcome === "mismatch" ? decision.origin : ""}" は許可されていません。`,
    `期待している Origin: ${expectedOrigins.join(", ")}`,
  );
}

/**
 * 1つの HTTP 要求を処理する。
 *
 * **順番が意味を持つ**: `Origin` の照合 → パスの照合 → MCP の処理。
 * 照合を先に置くのは、仕様の MUST が「すべての着信接続」に掛かるためである
 * (パスが違う要求も照合の対象にする)。
 */
export async function handleMcpHttpRequest(
  request: Request,
  config: McpHttpConfig,
): Promise<Response> {
  const decision = originDecision(request, config.expectedOrigins);
  if (!decision.allowed) {
    return originRejected(decision, config.expectedOrigins);
  }

  const url = new URL(request.url);
  if (url.pathname !== MCP_HTTP_PATH) {
    return errorResponse(
      404,
      "path",
      `"${url.pathname}" は MCP のエンドポイントではありません。`,
      `MCP のエンドポイントは ${MCP_HTTP_PATH} の1本だけです。`,
    );
  }

  // GET(サーバ発のメッセージを受けるための SSE ストリーム)は開かない。
  //
  // **仕様が明示的に許している** —— 2025-06-18 transports の
  // 「Listening for Messages from the Server」の 3 逐語:
  // 「The server **MUST** either return `Content-Type: text/event-stream` in response to
  //  this HTTP GET, or else return HTTP 405 Method Not Allowed, indicating that the server
  //  does not offer an SSE stream at this endpoint.」
  //
  // **開かない理由は実測である**: この入口はステートレスで、要求ごとに `McpServer` を
  // 作って閉じる(`ADR-0274` 限定3)。したがって GET で開いたストリームには
  // **何も流れてこない**。SDK の既定の実装は 200 + `text/event-stream` を返して
  // ストリームを開いたままにするので、そのままだと接続を握ったまま何も起きない。
  if (request.method === "GET") {
    return errorResponse(
      405,
      "method",
      "この入口はサーバ発の SSE ストリームを提供しません。",
      "MCP のメッセージは POST で送ってください(仕様は 405 を明示的に許しています)。",
    );
  }

  // ステートレスなので、要求ごとに新しいトランスポートと新しいサーバを作る
  // (SDK が使い回しを禁じている。モジュール冒頭の逐語)。
  //
  // **`sessionIdGenerator` を「渡さない」ことがステートレスの指定である**
  // (SDK 逐語「If not provided, session management is disabled (stateless mode).」)。
  // `sessionIdGenerator: undefined` と明示的に書く形は `exactOptionalPropertyTypes`
  // で型エラーになるので、キーごと置かない。
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  const server = createMcpServer({
    dataRoot: config.dataRoot,
    previewBaseUrl: config.previewBaseUrl,
    // **要求ごとに作り直すサーバにも、起動時に決めた名乗りをそのまま渡す**
    // (`V8-M31-T02`)。**要求ごとに名乗りが変わる余地を作らない** ——
    // ヘッダや本文から主体を読む形にすると、繋いだ側が主体を選べてしまう。
    actor: config.actor,
  });
  await server.connect(transport);

  const response = await transport.handleRequest(request);

  // GET を上で落としてあるので、ここに来る応答の本文は必ず確定している
  // (`enableJsonResponse: true` の POST は JSON 文字列、202 と DELETE は本文なし)。
  // したがって閉じてよい。閉じないと要求ごとに `McpServer` が積み上がる。
  await server.close();
  return response;
}

export type StartMcpHttpServerOptions = {
  dataRoot: string;
  previewBaseUrl: string;
  /** `0` を渡すと空いているポートが割り当てられる(検査で使う)。 */
  port: number;
  /** 明示する場合。省略時は `env` か、自分自身のループバック生成元1本。 */
  expectedOrigins?: string[] | undefined;
  /**
   * 期待オリジンの読み出し元。**ホスト名はここから読まない** ——
   * `ST_MCP_HTTP_HOSTNAME` のような鍵を渡しても1バイトも効かない。
   */
  env?: Record<string, string | undefined>;
  /**
   * 名乗り(`V8-M31-T02`)。省略時は `env` の `ST_MCP_ACTOR`、それも無ければ名乗り無し。
   * **明示した側が勝つ**(`expectedOrigins` と同じ扱い)。
   */
  actor?: string | undefined;
};

export type RunningMcpHttpServer = {
  hostname: string;
  port: number;
  url: string;
  /** 実際に照合に使っている期待オリジン(ポート `0` のときはバインド後の実ポートで組み立てたもの)。 */
  expectedOrigins: string[];
  stop: () => Promise<void>;
};

/**
 * HTTP の入口を1本立てる。**バインド先は `MCP_HTTP_HOSTNAME` の定数だけである。**
 */
export async function startMcpHttpServer(
  options: StartMcpHttpServerOptions,
): Promise<RunningMcpHttpServer> {
  const envConfig = options.env === undefined ? undefined : loadMcpHttpConfig(options.env);
  const fromEnv =
    envConfig?.expectedOriginsFromEnv === true ? envConfig.expectedOrigins : undefined;

  const config: McpHttpConfig = {
    dataRoot: options.dataRoot,
    previewBaseUrl: options.previewBaseUrl,
    port: options.port,
    // ポート 0 のときは、バインドの後に実ポートで埋め直す(下)。
    expectedOrigins: options.expectedOrigins ?? fromEnv ?? [],
    expectedOriginsFromEnv: options.expectedOrigins !== undefined || fromEnv !== undefined,
    actor: normalizeActor(options.actor) ?? envConfig?.actor,
  };

  const server = Bun.serve({
    hostname: MCP_HTTP_HOSTNAME,
    port: options.port,
    fetch: (request) => handleMcpHttpRequest(request, config),
  });
  // **`Bun.serve` が実際に報告した値をそのまま返す**(定数を返し直さない)。
  // ここで定数に置き換えると、検査は「定数が定数と等しい」ことしか測らなくなる。
  // Bun が `undefined` を返したら、既定値で誤魔化さず空文字を返して検査を赤くする。
  const boundHostname = server.hostname ?? "";
  const port = server.port ?? 0;

  if (config.expectedOrigins.length === 0) {
    config.expectedOrigins = [`http://${MCP_HTTP_HOSTNAME}:${String(port)}`];
  }

  return {
    hostname: boundHostname,
    port,
    url: `http://${MCP_HTTP_HOSTNAME}:${String(port)}${MCP_HTTP_PATH}`,
    expectedOrigins: config.expectedOrigins,
    stop: async () => {
      await server.stop(true);
    },
  };
}
