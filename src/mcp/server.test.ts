/**
 * MCP サーバ骨格の統合テスト(V0-P5-T01 / ADR-0005)。
 *
 * `InMemoryTransport.createLinkedPair()` で MCP クライアントとサーバを
 * **同一プロセス内**で直結する。stdio も HTTP も使わないので、子プロセスの
 * 起動待ちもポート確保も後始末も要らない。ADR-0003 が Hono の `app.request()`
 * を「サーバを起動せずに統合テストが書ける」ことを理由に選んだのと同じ発想で、
 * MCP 側も**トランスポートを差し替えてもプロトコルの中身は同じ**という
 * SDK の性質をそのままテストの安定性に使う。
 *
 * T01 の時点でツールは0個である(登録は T02 / T03)。ここで確かめるのは
 * 「initialize が通ること」と「ツール一覧が空で返ること」だけで、
 * ツールが増えたときにこのテストが壊れないよう、件数ではなく
 * **骨格が MCP プロトコルとして成立していること**を見る形にしてある。
 */
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./server.ts";

/**
 * クライアントとサーバを直結して、接続済みのクライアントを返す。
 *
 * **両者の `connect` は必ず `Promise.all` で並行に待つ。** `InMemoryTransport` は
 * 相手側が送受信を開始していないと initialize のハンドシェイクが進まないため、
 * `await client.connect(a)` を先に単独で待つとサーバがまだ繋がっておらず
 * デッドロックする(逐次 await は動かない)。
 */
async function connectInMemory(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer({
    dataRoot: "data",
    previewBaseUrl: "http://127.0.0.1:3000",
  });
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

test("MCPクライアントから initialize が成功し、サーバ名とバージョンが返る", async () => {
  const { client, close } = await connectInMemory();
  try {
    const info = client.getServerVersion();
    expect(info).toBeDefined();
    expect(info?.name).toBe("smailtalk");
    expect(typeof info?.version).toBe("string");
    expect(info?.version).not.toBe("");
  } finally {
    await close();
  }
});

test("tools/list が呼べて、登録済みのツールが返る", async () => {
  // T01 の時点ではツール0個だったので `toEqual([])` を見ていたが、T02 で参照系6ツールが
  // 入った。ここで件数や名前を列挙すると T03 でツールが増えるたびに壊れるので、
  // **骨格が MCP プロトコルとして成立していること**(= `tools/list` が Method not found に
  // ならず、ツールが1つ以上返ること)だけを見る。個々のツールの名前と入出力は
  // `tools/read.test.ts` の担当。
  const { client, close } = await connectInMemory();
  try {
    const result = await client.listTools();
    expect(result.tools.length).toBeGreaterThan(0);
    // T01 の暫定回避策(`__bootstrap__`)は削除済み。クライアントに漏れていないこと。
    expect(result.tools.map((tool) => tool.name)).not.toContain("__bootstrap__");
  } finally {
    await close();
  }
});

test("createMcpServer は呼び出しごとに独立したサーバを返す(グローバル状態を持たない)", async () => {
  // データルートを引数で受け取る設計(`createServerApp({ dataRoot })` と同じ)であることの担保。
  // 固定パスやモジュールレベルのシングルトンを持つと、テストが実 `data/` を汚す。
  const a = createMcpServer({ dataRoot: "data-a", previewBaseUrl: "http://127.0.0.1:3000" });
  const b = createMcpServer({ dataRoot: "data-b", previewBaseUrl: "http://127.0.0.1:4000" });
  expect(a).not.toBe(b);
  await a.close();
  await b.close();
});
