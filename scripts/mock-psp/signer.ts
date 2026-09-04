/**
 * モック PSP の Webhook 署名(HMAC-SHA256)—— **カーネル外・独立実装**(V2-M5-T03 / EC-G16)。
 *
 * これは `scripts/` 側のテストハーネスであって**カーネルではない**(門外。03 §1a)。
 * カーネルの `src/kernel/inbound-verify.ts`(受信側の検証)とは**独立に実装する** ——
 * 実 PSP(Stripe / PayPal)が受信側とは別のコードベースで署名を生成するのと同じ立場を
 * 模すためである。両者が同じ HMAC-SHA256(生バイト body, 共有シークレット)の**取り決め**
 * (03 §2b/§3a)を共有しているだけで、コードは共有しない。もし両者が同じ関数を import して
 * いたら「署名が一致すること」の実証が自作自演になる —— 別実装が独立に一致することが、
 * 取り決めが正しく相互運用できることの証拠になる。
 *
 * ヘッダの形は `X-Mock-PSP-Signature: sha256=<hex(HMAC-SHA256(rawBody, secret))>`
 * (Stripe の `Stripe-Signature` を模した1形。03 §2b)。**生バイト body で計算する** ——
 * 送る body そのもののバイト列で署名しないと、受信側の再パース/再シリアライズとの間で
 * 空白・キー順・数値表現が食い違い、HMAC が一致しない。
 */
import { createHmac } from "node:crypto";

/** 署名ヘッダの名前(受信側 `INBOUND_SIGNATURE_HEADER` と同じ文字列を取り決めで共有する)。 */
export const MOCK_PSP_SIGNATURE_HEADER = "X-Mock-PSP-Signature";

/** `sha256=<hex>` のプレフィクス(取り決め。03 §2b)。 */
const SIGNATURE_PREFIX = "sha256=";

/**
 * Webhook の生 body 文字列に署名し、`sha256=<hex>` 形のヘッダ値を返す(決定論)。
 * 同じ body・同じ鍵なら同じ署名になる(乱数・実時刻に依存しない)。
 *
 * @param rawBody 送信する body そのもの(この文字列を UTF-8 バイト列にして署名する)。
 * @param sharedSecret 受信側と共有する署名検証鍵(テストでは固定値)。
 */
export function signWebhookBody(rawBody: string, sharedSecret: string): string {
  const digest = createHmac("sha256", sharedSecret)
    .update(Buffer.from(rawBody, "utf-8"))
    .digest("hex");
  return `${SIGNATURE_PREFIX}${digest}`;
}
