/**
 * 最低限レート制限の単体テスト(V2-M1-T05 / ADR-0034 限定4)。
 *
 * これは **DoS 対策の完成ではない**。匿名経路とサインアップ/ログインを開く以上の
 * 「最低限」であり、in-memory の素朴な固定窓カウンタにすぎない(永続化・分散なし・
 * ローカル前提)。実運用の DoS 対策・分散レート制限は v2 スコープ外(ADR-0034 §92-4)。
 *
 * 時刻は注入可能な `now` で制御し、窓のリセットを実クロックに依存せず固定する。
 */
import { describe, expect, test } from "bun:test";
import { clientKeyFromHeader, RateLimiter, rateLimitError } from "./rate-limit.ts";

describe("RateLimiter(固定窓)", () => {
  test("上限までは通り、上限超過で allowed=false を返す", () => {
    const t = 1_000;
    const limiter = new RateLimiter({ limit: 3, windowMs: 1_000, now: () => t });
    expect(limiter.hit("k").allowed).toBe(true); // 1
    expect(limiter.hit("k").allowed).toBe(true); // 2
    expect(limiter.hit("k").allowed).toBe(true); // 3
    const denied = limiter.hit("k"); // 4 → 超過
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  test("窓が経過すると再び通る(時間経過でリセット)", () => {
    let t = 1_000;
    const limiter = new RateLimiter({ limit: 2, windowMs: 1_000, now: () => t });
    expect(limiter.hit("k").allowed).toBe(true);
    expect(limiter.hit("k").allowed).toBe(true);
    expect(limiter.hit("k").allowed).toBe(false); // 超過
    t += 1_000; // 窓を跨ぐ
    expect(limiter.hit("k").allowed).toBe(true); // 新しい窓で復活
  });

  test("キーごとに独立してカウントする", () => {
    const t = 0;
    const limiter = new RateLimiter({ limit: 1, windowMs: 1_000, now: () => t });
    expect(limiter.hit("a").allowed).toBe(true);
    expect(limiter.hit("a").allowed).toBe(false); // a は超過
    expect(limiter.hit("b").allowed).toBe(true); // b は独立
  });

  test("reset() で全カウンタが消える(カウンタリセットで再び通る)", () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 });
    expect(limiter.hit("k").allowed).toBe(true);
    expect(limiter.hit("k").allowed).toBe(false);
    limiter.reset();
    expect(limiter.hit("k").allowed).toBe(true);
  });
});

describe("clientKeyFromHeader", () => {
  test("x-forwarded-for の先頭 IP を採る", () => {
    expect(clientKeyFromHeader("203.0.113.1, 10.0.0.1")).toBe("203.0.113.1");
    expect(clientKeyFromHeader("203.0.113.9")).toBe("203.0.113.9");
  });

  test("ヘッダが無ければローカル前提の固定キーへ落ちる(同一になりうるが機構として持つ)", () => {
    expect(clientKeyFromHeader(undefined)).toBe("local");
    expect(clientKeyFromHeader("")).toBe("local");
  });
});

describe("rateLimitError", () => {
  test("統一 { errors } 形式に載る ValidationError を返す", () => {
    const err = rateLimitError(5);
    expect(err.path).toBe("");
    expect(typeof err.message).toBe("string");
    expect(err.message.length).toBeGreaterThan(0);
  });
});
