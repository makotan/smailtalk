/**
 * `WRITE_TOOLS` と MCP サーバの実体との乖離検出(V1-M0-T01 再実地)。
 *
 * `scripts/mcp-trial/transcript.ts` の `WRITE_TOOLS` は辞書ヒューリスティックではなく
 * 「どのツールがファイルを変えるか」という**事実の列挙**である。事実の列挙を手で写している
 * 以上、`src/mcp/` にツールが増えたときに写し忘れる。実際 V1-M0-T01 が `update_record` /
 * `delete_record` を足したとき、この定数は V0-P6-T03a 当時の4つのまま取り残された。
 *
 * ここでは**真実の側を直接読む**。判定に使うのは「書き込み系として登録されたか」という
 * 構造的事実 ―― `registerWriteTools()` だけを繋いだサーバの `tools/list` ―― であって、
 * ツール名の綴りや description の語ではない。ツールが1つ増えれば、`WRITE_TOOLS` を
 * 直すまでこのテストが落ちる。
 *
 * `registerReadTools()` 側も併せて見る。参照系が誤って `WRITE_TOOLS` に混ざると、
 * 「読んだだけなのに書いたことになる」という逆向きの誤判定になり、`action_withheld` が
 * 拾えるはずのものを黙って落とすようになるため。
 */
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_SERVER_NAME } from "../../src/mcp/server.ts";
import { registerReadTools } from "../../src/mcp/tools/read.ts";
import { registerWriteTools } from "../../src/mcp/tools/write.ts";
import { WRITE_TOOLS } from "./transcript.ts";

/**
 * 指定した登録関数だけを繋いだサーバに `tools/list` を投げ、
 * Claude Code の証跡に現れるのと同じ形(`mcp__<サーバ名>__<ツール名>`)で名前を返す。
 */
async function registeredToolNames(
  register: (server: McpServer, options: { dataRoot: string; previewBaseUrl: string }) => void,
): Promise<string[]> {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  register(server, { dataRoot: "data", previewBaseUrl: "http://127.0.0.1:3000" });

  const client = new Client({ name: "drift-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // 逐次 await はハンドシェイクでデッドロックする(`src/mcp/server.test.ts` と同じ理由)。
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools.map((tool) => `mcp__${MCP_SERVER_NAME}__${tool.name}`).sort();
  } finally {
    await client.close();
    await server.close();
  }
}

test("WRITE_TOOLS が MCP サーバの書き込み系ツールの実体と一致する", async () => {
  // `WRITE_TOOLS` は `as const` なのでリテラル型が付く。狭いほうに合わせると
  // 「サーバ側に増えたツール名」が型で弾かれて**実行時比較まで届かない**ので、
  // こちらを `string[]` に広げて突き合わせる。
  const ours: string[] = [...WRITE_TOOLS].sort();
  expect(ours).toEqual(await registeredToolNames(registerWriteTools));
});

test("WRITE_TOOLS に参照系ツールが混ざっていない", async () => {
  const readTools = new Set(await registeredToolNames(registerReadTools));
  expect(WRITE_TOOLS.filter((name) => readTools.has(name))).toEqual([]);
});
