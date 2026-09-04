/**
 * `bun test` でコンポーネントテストを動かすための DOM 準備(V0-P3-T03)。
 *
 * `bunfig.toml` の `[test] preload` から読まれる。`bun test` は全テストファイルを
 * 同一プロセスで動かすため、ここでの登録はカーネル/サーバのテストにも影響する。
 * そこで **DOM だけを足し、ネットワーク系のグローバルは Bun 標準のまま残す**:
 * happy-dom の `fetch` / `Request` / `Response` が Hono に渡ると
 * `src/server/app.test.ts` が壊れるため、登録後に元の実装へ戻している。
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/** happy-dom に上書きさせないグローバル(Bun 標準の Web 標準実装を使い続ける)。 */
const NETWORK_GLOBALS = [
  "fetch",
  "Request",
  "Response",
  "Headers",
  "FormData",
  "Blob",
  "File",
  "AbortController",
  "AbortSignal",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "URL",
  "URLSearchParams",
  "TextEncoder",
  "TextDecoder",
] as const;

if (typeof (globalThis as { document?: unknown }).document === "undefined") {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const name of NETWORK_GLOBALS) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }

  GlobalRegistrator.register({ url: "http://localhost/" });

  for (const [name, descriptor] of originals) {
    if (descriptor !== undefined) {
      Object.defineProperty(globalThis, name, descriptor);
    }
  }
}
