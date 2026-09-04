/**
 * セッションの発行/検証/失効(V1-M3-T01 / 計画 §3)。
 *
 * ロジックは薄く、状態は `AuthStore` が持つ。ここで守る不変条件は次の2つ:
 * - `issueSession` は**必ず新規 ID を発行する**(ログイン成功のたびに再発行し、
 *   未認証時のセッション ID を認証後に引き継がせない = セッション固定対策・重大1)
 * - `resolveSession` は期限切れを null 扱いにする(store 側でも掃除される)
 */
import type { AuthStore } from "./store.ts";
import type { Session } from "./types.ts";

/** 新規セッションを発行する(毎回新しい ID)。 */
export function issueSession(store: AuthStore, userId: string, ttlSec: number): Session {
  return store.createSession(userId, ttlSec);
}

/** セッション ID を解決する。存在しない・期限切れなら null。 */
export function resolveSession(store: AuthStore, sessionId: string): Session | null {
  return store.findSession(sessionId) ?? null;
}

/** セッションを失効させる(ログアウト。冪等)。 */
export function revokeSession(store: AuthStore, sessionId: string): void {
  store.deleteSession(sessionId);
}
