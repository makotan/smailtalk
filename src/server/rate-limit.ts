/**
 * 最低限のレート制限(V2-M1-T05 / ADR-0034 限定4)。
 *
 * 匿名 read-only 窓(T04)とサインアップ/ログイン経路を「開く以上の最低限」として、
 * in-memory の素朴な**固定窓カウンタ**で流量を抑える。永続化も分散もしない —— ローカル
 * (`127.0.0.1` バインド。ADR-0003/0014)前提の防御である。
 *
 * **これは DoS 対策の完成ではない**(ADR-0034 §92-4 / 憲法6)。実運用のインターネット公開
 * (TLS 終端・分散レート制限・運用監視)は v2 スコープ外。ここで払うのは ADR-0014 §17 の
 * follow-up の一部(匿名経路・サインアップ試行の最低限の抑制)であって、全面的な試行制限
 * 強化(password ブルートフォース対策の完成等)ではない。
 *
 * SQL も HTTP も知らない純粋なカウンタ + キー抽出だけを置く(Hono に依存しない)。時刻は
 * 注入可能な `now` で制御でき、テストは実クロックに依存せず窓リセットを固定できる。
 */
import type { ValidationError } from "../kernel/index.ts";

export type RateLimitOptions = {
  /** 1つの窓で許す最大ヒット数(これを超えると allowed=false)。 */
  limit: number;
  /** 窓の長さ(ミリ秒)。この時間を跨ぐとカウンタは 0 に戻る。 */
  windowMs: number;
  /** 現在時刻(ミリ秒)。既定 `Date.now`。テストは注入して時間を制御する。 */
  now?: () => number;
};

export type RateLimitDecision = {
  allowed: boolean;
  /** 拒否時、窓が明けるまでの秒数(Retry-After 用)。許可時は 0。 */
  retryAfterSec: number;
};

/**
 * キー単位の固定窓レートリミッタ。`hit(key)` を呼ぶたびに 1 加算し、窓内の合計が `limit` を
 * 超えたら拒否する。`reset()` で全カウンタを消す(テスト用のカウンタリセット)。
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; windowStart: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: RateLimitOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.now = options.now ?? Date.now;
  }

  /** key を1回叩く。窓を跨いでいれば新しい窓を開き、超過していれば拒否する。 */
  hit(key: string): RateLimitDecision {
    const t = this.now();
    const bucket = this.buckets.get(key);
    if (bucket === undefined || t - bucket.windowStart >= this.windowMs) {
      // 新しい窓(初回、または前の窓を跨いだ)。
      this.buckets.set(key, { count: 1, windowStart: t });
      return { allowed: true, retryAfterSec: 0 };
    }
    bucket.count += 1;
    if (bucket.count > this.limit) {
      const remainingMs = bucket.windowStart + this.windowMs - t;
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(remainingMs / 1000)) };
    }
    return { allowed: true, retryAfterSec: 0 };
  }

  /** 全カウンタを消す(テストのカウンタリセット)。 */
  reset(): void {
    this.buckets.clear();
  }
}

/**
 * クライアント識別子を取り出す。`x-forwarded-for` の**先頭 IP**を採り、無ければローカル前提の
 * 固定キー `"local"` に落ちる。ローカルでは全リクエストが同一キーになりうるが(ADR-0034 §92-4)、
 * **機構としてキーを持つ**ことがここでの目的である(外部公開時に前段プロキシが実 IP を載せる)。
 */
export function clientKeyFromHeader(forwardedFor: string | undefined): string {
  if (forwardedFor === undefined || forwardedFor.trim() === "") {
    return "local";
  }
  const first = forwardedFor.split(",")[0]?.trim();
  return first === undefined || first === "" ? "local" : first;
}

/** レート上限超過(429)。統一 `{ errors }` 形式に載せる ValidationError。 */
export function rateLimitError(retryAfterSec: number): ValidationError {
  return {
    path: "",
    message: "リクエストが多すぎます。しばらく待ってから再度お試しください。",
    hint: `${retryAfterSec} 秒ほど待ってから同じ操作をやり直してください(匿名経路・サインアップの最低限のレート制限)。`,
  };
}
