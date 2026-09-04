/**
 * **公開ツールの本数を、実サーバの `tools/list` から数える**(字面で数えていない)。
 *
 * ## なぜここに在るか(`V9-M12-T02` / `ADR-0354` D4 / `X-G31` 限定5)
 *
 * `ADR-0354` が正本のルートの束ねを外したので、**正本のルートの `node_modules` は
 * 器のための2本(`typescript` / `@biomejs/biome`)しか持たない。**
 * ところが `tools/docs/report-prose-correction-drift.test.ts` は
 * `@modelcontextprotocol/sdk` を**裸の綴りで**引いていた(`V9-M11-T02` が
 * `apps/smailtalk/scripts/` から切り出したときに、その綴りごと持って出た)。
 * **束ねが無くなると、その裸の綴りはルートの `node_modules` を見に行き、そこに無いので落ちる**
 * —— 実測(`V9-M12-T02` の記録):
 *
 * ```
 * error: Cannot find module '@modelcontextprotocol/sdk/client/index.js' from '…/tools/docs/report-prose-correction-drift.test.ts'
 * ```
 *
 * **ルートの `devDependencies` に3本目を足すのは採らない** —— `X-G31` 限定5(2本まで)を破り、
 * `ADR-0354` の再審査条件「ルートの `devDependencies` が3本以上になったとき」にそのまま当たる。
 * **代わりに、裸の綴りを公開単位の中へ寄せた。** ここから引けば解決は
 * `apps/smailtalk/node_modules` から行われる。
 *
 * **同時に重複が1つ減った。** 着手前、まったく同じ `publishedToolCount()` が2箇所に在った:
 *
 * ```
 * apps/smailtalk/scripts/report-prose-correction-drift.test.ts:269
 * tools/docs/report-prose-correction-drift.test.ts:171
 * ```
 *
 * ## この関数がしないこと
 *
 * - **本数の正しさを判定しない。** 数えて返すだけである。何本であるべきかは呼び出し側が言う。
 * - **`data` を1バイトも読まない**(`dataRoot: "data"` は `createMcpServer` の必須引数を
 *   埋めるためだけに渡している。`tools/list` は保管場所へ触れない)。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.ts";

/** **実サーバの `tools/list` から数える。字面で数えていない。** */
export async function publishedToolCount(): Promise<number> {
  const server = createMcpServer({
    dataRoot: "data",
    previewBaseUrl: "http://127.0.0.1:3000",
  });
  const client = new Client({ name: "prose-correction-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools.length;
  } finally {
    await client.close();
    await server.close();
  }
}
