/**
 * URL ↔ 画面状態の再エクスポート。
 *
 * 実装は `src/shared/route.ts` に移した。MCP サーバ(`src/mcp`)がプレビュー用の
 * URL を組み立てるのに `routePath()` を必要とするが、この依存の向きは web → src の
 * 一方向と決めてあるので、src 側から web を参照させるわけにはいかない。
 * そこで実装だけを src/shared に置き、web からの既存の import は
 * ここを経由して従来どおり動くようにしてある。
 */

export type { Route, RoutePrefill } from "../../src/shared/route.ts";
export { parseRoute, routePath } from "../../src/shared/route.ts";
