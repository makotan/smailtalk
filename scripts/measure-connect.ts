/**
 * `V17-M0-T01a`: **MCP サーバに接続した瞬間にクライアントへ渡る説明文の量を実測して印字する台。**
 *
 * 上位: `docs/plan/v17/01-v17-m0-plan.md` §6 の `V17-M0-T01a` 行 /
 *       `ADR-0412` §95(接続直後の余白が **1文字**であることの実測)/
 *       `ADR-0410:106`(「`measureAtConnect()` を複製して打った」)。
 *
 * ## なぜ**台をファイルとして置く**のか
 *
 * `ADR-0410` と `ADR-0412` の実測は、**その場で複製した使い捨てのスクリプト**
 * (scratchpad の `v16-m0/measure-connect.ts`)で取られている。**その台は今日ディスク上に無い。**
 * 同じ数を次に測る人は、また複製から始めることになる ——
 * **複製された式は、元の式が変わっても追随しない。** だから**正本の中に1本置く。**
 *
 * 使い方(**公開単位 `apps/smailtalk/` の中で打つ**):
 *
 * ```
 * cd apps/smailtalk && bun run scripts/measure-connect.ts
 * ```
 *
 * ## 上限の定数を**どちらに寄せたか**(`ADR-0250` §Decision 3 の 3。**2箇所に焼き込まない**)
 *
 * **`CONNECT_TOTAL_MAX` はこのファイルが持ち、`scripts/mcp-description-size.test.ts` が
 * ここから `import` する。** **逆向き(検査ファイル側の定数を `export` してこの台が読む)は
 * 採れない** —— `mcp-description-size.test.ts` は `bun:test` を読み込んでおり、
 * **`bun run` から `import` すると `Cannot use test outside of the test runner.` で落ちる**
 * (実測した。`bun run` は test runner ではないので `test()` の呼び出しがその場で例外になる)。
 * **値 `152000` は1バイトも動かしていない。** 動かした経緯は
 * `mcp-description-size.test.ts` の doc コメント(「上限値をどう決めたか」)にあり、
 * **本ファイルはその根拠を複写していない**(根拠は1箇所のままにする)。
 *
 * ## 測っているもの(**6つ。すべて実測。焼き込みは1つも無い**)
 *
 * | # | 測るもの | 取り方 |
 * |---|---|---|
 * | 1 | `instructions` の文字数 | `client.getInstructions()` |
 * | 2 | `tools/list` の JSON の文字数 | `JSON.stringify({ tools })` |
 * | 3 | 合計と、上限までの余白 | 1 + 2 / `CONNECT_TOTAL_MAX − 合計` |
 * | 4 | 道具の本数と道具ごとの内訳 | 1本ずつ `JSON.stringify` して**長い順**に並べる |
 * | 5 | `resources/list` の JSON の文字数と件数 | `client.listResources()` |
 * | 6 | `describeTool("")` が全道具に貼る共通部の長さ | 実際に関数を呼ぶ(字面で数えない) |
 *
 * ## この台がしないこと(先に書く)
 *
 * - **トークン数を1つも測っていない。** 数えるのは文字数だけである。
 * - **「厚くしたのが正しいか」を判定しない。** 数を出すだけで、赤くもならない
 *   (上限を超えたことを**赤にする**のは `mcp-description-size.test.ts` の側である)。
 * - **`resources/list` を合計に足していない。** 上限 `CONNECT_TOTAL_MAX` は
 *   `instructions + tools/list` に対して置かれた値であり、**定義を変えると過去の実測と
 *   比べられなくなる。** resources は**別の行**として印字する
 *   (足した合計を撃つ検査は `V17-M0-T01f` が別に置く)。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.ts";
import { describeTool } from "../src/mcp/vocabulary.ts";

/**
 * 1. 接続直後に渡る合計文字数の上限。127,057(2026-08-07 実測)+ 24,943(`VOCABULARY_SCOPE` 全文1本分)。
 *
 * **この定数の定義はリポジトリ全体でこの1行だけである**(`scripts/measure-connect.test.ts`
 * の `(mc5)` がそれを撃つ)。根拠は `scripts/mcp-description-size.test.ts` の doc コメント。
 */
export const CONNECT_TOTAL_MAX = 152000;

/** 道具1本ぶんの内訳。 */
export type ToolBreakdown = {
  name: string;
  /** その道具1本を `JSON.stringify` した長さ。 */
  jsonLength: number;
  /** `description` の文字数(JSON 化する前の素の長さ)。 */
  descriptionLength: number;
  /** `inputSchema` を `JSON.stringify` した長さ。 */
  inputSchemaJsonLength: number;
};

export type ConnectMeasurement = {
  instructionsLength: number;
  toolsListJsonLength: number;
  total: number;
  limit: number;
  margin: number;
  toolCount: number;
  /** **JSON 長の長い順**に並んだ内訳。 */
  tools: ToolBreakdown[];
  resourcesListJsonLength: number;
  resourceCount: number;
  /**
   * `resources/list` を呼んだときにサーバが断った理由(公開していなければここに入る)。
   * 断られた場合の件数は **0**、JSON は空配列を包んだ長さとして数える。
   */
  resourcesError: string | null;
  /** `describeTool("")` が全道具に貼る共通部の長さ。 */
  sharedPreambleLength: number;
};

/**
 * クライアントとサーバを直結して測る。
 *
 * **両 `connect` は必ず `Promise.all` で並べる** —— 逐次に書くとデッドロックする
 * (`InMemoryTransport` は相手が繋がるまで返らない)。
 */
export async function measureConnect(): Promise<ConnectMeasurement> {
  const server = createMcpServer({
    dataRoot: "data",
    previewBaseUrl: "http://127.0.0.1:3000",
  });
  const client = new Client({ name: "measure-connect", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const instructions = client.getInstructions() ?? "";
    const { tools } = await client.listTools();
    const toolsListJsonLength = JSON.stringify({ tools }).length;

    const breakdown: ToolBreakdown[] = tools
      .map((tool) => ({
        name: tool.name,
        jsonLength: JSON.stringify(tool).length,
        descriptionLength: (tool.description ?? "").length,
        inputSchemaJsonLength: JSON.stringify(tool.inputSchema ?? {}).length,
      }))
      .sort((a, b) => b.jsonLength - a.jsonLength);

    // **今日は resources を1本も公開していない**(`src/mcp/server.ts` の
    // `capabilities` に `resources` が無い)ので、SDK のクライアントはここで断る。
    // **断られたことも実測として印字する**(0件であることを黙って作らない)。
    let resources: unknown[] = [];
    let resourcesError: string | null = null;
    try {
      const listed = await client.listResources();
      resources = listed.resources;
    } catch (error) {
      resourcesError = error instanceof Error ? error.message : String(error);
    }

    const total = instructions.length + toolsListJsonLength;
    return {
      instructionsLength: instructions.length,
      toolsListJsonLength,
      total,
      limit: CONNECT_TOTAL_MAX,
      margin: CONNECT_TOTAL_MAX - total,
      toolCount: tools.length,
      tools: breakdown,
      resourcesListJsonLength: JSON.stringify({ resources }).length,
      resourceCount: resources.length,
      resourcesError,
      sharedPreambleLength: describeTool("").length,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

const numberFormat = new Intl.NumberFormat("en-US");
const n = (value: number): string => numberFormat.format(value);

/** 実測を印字用の文字列に組み立てる(**印字と検査で同じ1本を通す**)。 */
export function formatReport(m: ConnectMeasurement): string {
  const lines: string[] = [];
  lines.push("=== 接続直後にクライアントへ渡る説明文の量(実測)===");
  lines.push("");
  lines.push(`1. instructions            = ${n(m.instructionsLength)} 文字`);
  lines.push(`2. tools/list の JSON      = ${n(m.toolsListJsonLength)} 文字`);
  lines.push(
    `3. total (1+2)             = ${n(m.total)} 文字 / 上限 CONNECT_TOTAL_MAX = ${n(m.limit)} / margin = ${n(m.margin)}`,
  );
  lines.push(`4. 道具の本数              = ${n(m.toolCount)} 本(内訳は JSON 長の長い順)`);
  lines.push("");
  const nameWidth = Math.max(...m.tools.map((tool) => tool.name.length), 4);
  lines.push(
    `   ${"name".padEnd(nameWidth)}  ${"json".padStart(8)}  ${"description".padStart(11)}  ${"inputSchema".padStart(11)}`,
  );
  for (const tool of m.tools) {
    lines.push(
      `   ${tool.name.padEnd(nameWidth)}  ${n(tool.jsonLength).padStart(8)}  ${n(tool.descriptionLength).padStart(11)}  ${n(tool.inputSchemaJsonLength).padStart(11)}`,
    );
  }
  lines.push("");
  lines.push(
    `5. resources/list の JSON  = ${n(m.resourcesListJsonLength)} 文字 / ${n(m.resourceCount)} 件` +
      (m.resourcesError === null ? "" : `(サーバの断り: ${m.resourcesError})`),
  );
  lines.push(`6. describeTool("") 共通部 = ${n(m.sharedPreambleLength)} 文字(全道具に貼られる)`);
  return lines.join("\n");
}

if (import.meta.main) {
  console.log(formatReport(await measureConnect()));
}
