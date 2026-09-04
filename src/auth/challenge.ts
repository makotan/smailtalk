/**
 * パスキー儀式のチャレンジ管理(V1-M3-T01 / 計画 §3)。
 *
 * options 発行時にチャレンジを `pending_challenges` に保存し、短命 cookie(次フェーズ)
 * で pending ID を往復させる。verify 時に `consumeChallenge` で取得即削除する
 * (使い捨て=リプレイ防止)。用途(registration/authentication)が一致しない、
 * または期限切れのチャレンジは null を返す。
 *
 * 注: SimpleWebAuthn の `generate*Options` は自前でチャレンジを生成するため、
 * サーバ統合では options 生成時に `challenge` を注入して両者を一致させられる。
 * ここではチャレンジ文字列の生成と保存/消費の一次責務を担う。
 */
import { type AuthStore, randomId } from "./store.ts";
import type { ChallengePurpose } from "./types.ts";

/**
 * ISO8601 UTC 文字列の期限を現在時刻と比較し、切れているか判定する。
 *
 * **【2026-08-14。`V8-M2-T05` / `ADR-0336` 限定15。旧文を1バイトも消していない】**
 * **旧(逐語)**: `function isExpired(expiresAtIso: string): boolean {`(`export` が無かった)。
 *
 * **`export` を1語足しただけである。** **中身は1バイトも変えていない。**
 * **招待の期限もこの1本で判定する** —— **`ADR-0336` 限定15 の逐語「**綴りが2箇所に割れると
 * 片方だけが直る**」に従い、2本目の判定関数を書かない。**
 *
 * **【この実装が何をしているか、丸めずに書く】** **ISO8601 の文字列を辞書順で比べている。**
 * **生成側(`store.ts` の `expiresAtIso`)が必ず `toISOString()` を通すので今日は正しく
 * 動くが、手で書き換えた値や別形式の値が1つでも入ると黙って壊れる**(型は `string` である)。
 * **招待の期限を外から受け取る経路を1本も作らないのは、この性質が理由である。**
 */
export function isExpired(expiresAtIso: string): boolean {
  return expiresAtIso <= new Date().toISOString();
}

/**
 * 新規チャレンジを生成して保存する。
 * @returns 保存した pending の ID と、生成したチャレンジ文字列(options に載せる)
 */
export function createChallenge(
  store: AuthStore,
  purpose: ChallengePurpose,
  username: string | null,
  ttlSec: number,
): { pendingId: string; challenge: string } {
  const challenge = randomId();
  const pending = store.savePendingChallenge({ challenge, purpose, username, ttlSec });
  return { pendingId: pending.id, challenge };
}

/**
 * チャレンジを取得即削除して返す(使い捨て)。
 * - 見つからない → null(2回目の消費もここに落ちる)
 * - purpose 不一致 → null
 * - 期限切れ → null
 */
export function consumeChallenge(
  store: AuthStore,
  pendingId: string,
  purpose: ChallengePurpose,
): string | null {
  const pending = store.takePendingChallenge(pendingId);
  if (pending === undefined) {
    return null;
  }
  if (pending.purpose !== purpose) {
    return null;
  }
  if (isExpired(pending.expiresAt)) {
    return null;
  }
  return pending.challenge;
}
