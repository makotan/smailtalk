/**
 * **E2E の下見の口**(`V20-M13-T02c`)。`fixture-server.ts` が読み込む(検査ではない)。
 *
 * - `POST /__e2e__/apps/:app_id/preview`(本文 `{ mode, diff }`): そのアプリに持ち主を1人作り、その人を
 *   名乗った MCP の **`dry_run_diff`**(`preview` 引数つき)を `InMemoryTransport` で直に呼ぶ。
 *   **製品の MCP の道具そのもの**を通すので、URL の組み立て・写しの作り方・権限は本物と同じである。
 *   応答は道具の `structuredContent` と `isError` をそのまま返す。
 * - `POST /__e2e__/previews/:preview_app_id/expire`: その下見の置き場を消す(期限切れを作る。
 *   前段は次の要求で 410 を返す)。
 * - **【`V20-M14-T04E`】** 本文に `compare`(`{ name, tradeoff, group? }`)を添えると、`dry_run_diff` の `compare`
 *   引数へそのまま渡す(見比べの束)。 束は「同じ頼んだ人」でないと案を足せないので、本文の `requester`
 *   (前の応答の `requester.username`)を渡すと、その人を名乗って呼ぶ(持ち主を新しく作らない)。
 *
 * **置き場の根は fixture-server が自分の一時ディレクトリの隣に明示し、終わるときに消す**
 * (`<dataRoot>.previews`。`ST_PREVIEW_ROOT` の既定と同じ形を明示で渡す)。
 */
import { rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../src/mcp/server.ts";
import { parsePreviewAppId, removePreview } from "../../src/server/preview-store.ts";
import { seedSession } from "../../src/server/test-helpers.ts";

const CREATE_PATTERN = /^\/__e2e__\/apps\/([^/]+)\/preview$/;
const EXPIRE_PATTERN = /^\/__e2e__\/previews\/([^/]+)\/expire$/;

export type PreviewFixture = {
  /** 下見の口なら応答を、そうでなければ `undefined` を返す。 */
  handle(request: Request, pathname: string): Promise<Response | undefined>;
  cleanup(): void;
};

export function createPreviewFixture(options: {
  dataRoot: string;
  previewRoot: string;
  origin: string;
}): PreviewFixture {
  let requested = 0;

  async function create(appId: string, request: Request): Promise<Response> {
    const body = (await request.json()) as {
      mode?: unknown;
      diff?: unknown;
      compare?: unknown;
      requester?: { user_id?: unknown; username?: unknown };
    };
    requested += 1;
    const requester =
      typeof body.requester?.username === "string" && typeof body.requester.user_id === "string"
        ? { username: body.requester.username, userId: body.requester.user_id }
        : seedSession(options.dataRoot, appId, {
            username: `preview-requester-${requested}`,
            role: "owner",
          });
    const server = createMcpServer({
      dataRoot: options.dataRoot,
      previewBaseUrl: options.origin,
      previewRoot: options.previewRoot,
      actor: requester.username,
    });
    const client = new Client({ name: "e2e-preview", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const result = await client.callTool({
        name: "dry_run_diff",
        arguments: {
          app_id: appId,
          preview: body.mode,
          diff: body.diff,
          ...(body.compare === undefined ? {} : { compare: body.compare }),
        },
      });
      return Response.json(
        {
          is_error: result.isError === true,
          result: result.structuredContent ?? null,
          content: result.content,
          requester: { user_id: requester.userId, username: requester.username },
        },
        { status: 200 },
      );
    } finally {
      await client.close();
      await server.close();
    }
  }

  function expire(previewAppIdText: string): Response {
    const id = parsePreviewAppId(previewAppIdText);
    if (id === null) {
      return Response.json(
        { errors: [{ path: "", message: "下見のIDではありません" }] },
        { status: 400 },
      );
    }
    removePreview(options.previewRoot, id);
    return Response.json({ removed: id });
  }

  return {
    async handle(request, pathname) {
      if (request.method !== "POST") {
        return undefined;
      }
      const created = CREATE_PATTERN.exec(pathname);
      if (created !== null) {
        return await create(decodeURIComponent(created[1] ?? ""), request);
      }
      const expired = EXPIRE_PATTERN.exec(pathname);
      if (expired !== null) {
        return expire(decodeURIComponent(expired[1] ?? ""));
      }
      return undefined;
    },
    cleanup() {
      rmSync(options.previewRoot, { recursive: true, force: true });
    },
  };
}
