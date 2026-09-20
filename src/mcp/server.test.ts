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
import { CANNOT_DO, OUT_OF_SCOPE_BEHAVIOR, VOCABULARY_SCOPE } from "./vocabulary.ts";

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

// =====================================================================================
// **`V17-M0-T01b`**: 語彙境界の全文3定数を、MCP の **resource** として公開する
// (`docs/plan/v17/01-v17-m0-plan.md` §4-1 の 1 / §6 の `V17-M0-T01b`)
// =====================================================================================
//
// **2026-09-07 まで、3定数の全文(61,244文字)は `apply_diff` 1本の `description` に
// 貼られており、接続直後(`instructions` + `tools/list`)の余白は **1文字**だった。**
// **`tools/list` から外して `resources/read` に置く。**
//
// **【これは移動であって二重化ではない】** —— **`tools/list` の側からは無くなる。**
// **`ADR-0005` §7 が resources を公開しない理由に挙げた「入口の二重化」には当たらない。**
//
// **【失うもの。丸めない】** **今日まで「接続しただけで必ず届いた」ものが、
// 明日からは「`resources/read` を呼べば届く」に降格する。**
// **`resources/read` を1度も呼ばない MCP クライアントには、語彙境界の全文は届かない。**

/** 公開する resource の URI と、それが返す定数の対応(**この表が検査の分母である**)。 */
const VOCABULARY_RESOURCES = [
  ["vocabulary://scope", VOCABULARY_SCOPE],
  ["vocabulary://cannot-do", CANNOT_DO],
  ["vocabulary://out-of-scope", OUT_OF_SCOPE_BEHAVIOR],
] as const;

/**
 * **`resources/list` の JSON 全体の上限。**
 *
 * **接続直後にこれも取りに行くクライアントが在る**(`instructions` + `tools/list` +
 * `resources/list`)。**`tools/list` から外した量が、こちらで戻ってきては意味が無い。**
 * **中身は URI と短い説明だけに保つ** —— 全文はここではなく `resources/read` が返す。
 */
const RESOURCES_LIST_JSON_MAX = 600;

/** resource 1本ぶんの `description` の上限(**一覧に載るのは案内であって本文ではない**)。 */
const RESOURCE_DESCRIPTION_MAX = 80;

test("V17-M0-T01b: resources/list が語彙境界の3本ちょうどを返す", async () => {
  const { client, close } = await connectInMemory();
  try {
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri).sort()).toEqual(
      VOCABULARY_RESOURCES.map(([uri]) => uri)
        .slice()
        .sort(),
    );
    // **0本 = 全文がどこにも無い。4本以上 = 語彙の外の何かを露出させた。**
    expect(resources).toHaveLength(VOCABULARY_RESOURCES.length);
  } finally {
    await close();
  }
});

test("V17-M0-T01b: resources/read が3定数の全文を逐語で返す(=== で照合する)", async () => {
  const { client, close } = await connectInMemory();
  try {
    for (const [uri, constant] of VOCABULARY_RESOURCES) {
      const read = await client.readResource({ uri });
      expect(read.contents, uri).toHaveLength(1);
      const [first] = read.contents;
      expect(first?.uri, uri).toBe(uri);
      // **`contents` は「文字の資源(`text`)」か「バイト列の資源(`blob`)」かの和である。**
      // **文字の側で返っていることも同時に見る**(`blob` で返した日に黙って通さない)。
      expect(first !== undefined && "text" in first, uri).toBe(true);
      // **`toContain` ではなく `===` である** —— 1文字でも欠けたら赤くなる。
      expect(first !== undefined && "text" in first ? String(first.text) : "", uri).toBe(constant);
    }
  } finally {
    await close();
  }
});

test("V17-M0-T01b: resources/list は案内だけで、全文を1文字も含まない", async () => {
  const { client, close } = await connectInMemory();
  try {
    const { resources } = await client.listResources();
    const json = JSON.stringify({ resources });
    expect(
      json.length,
      `resources/list の JSON ${json.length}文字が上限 ${RESOURCES_LIST_JSON_MAX} を超えた: ${json}`,
    ).toBeLessThanOrEqual(RESOURCES_LIST_JSON_MAX);
    for (const resource of resources) {
      const description = resource.description ?? "";
      expect(description.length, resource.uri).toBeLessThanOrEqual(RESOURCE_DESCRIPTION_MAX);
      // **一覧に本文を混ぜない**(混ぜたら `tools/list` から外した意味が消える)。
      expect(description.length, resource.uri).toBeGreaterThan(0);
    }
    for (const [, constant] of VOCABULARY_RESOURCES) {
      expect(json).not.toContain(constant);
    }
  } finally {
    await close();
  }
});

test("V17-M0-T01b: prompts は1つも公開していない(prompts/list は -32601 で断られる)", async () => {
  // **`ADR-0271` 限定4 / `ADR-0346` の「prompts を1つも公開しない」は今日も真である。**
  // **本段が引き直したのは resources の側だけである。**
  const { client, close } = await connectInMemory();
  try {
    let message = "";
    try {
      await client.listPrompts();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("-32601");
    expect(message).toContain("Method not found");
  } finally {
    await close();
  }
});
