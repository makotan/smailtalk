/**
 * パスワードハッシュ(V1-M3-T01 / 計画 §2)。
 *
 * Bun 組み込みの `Bun.password`(argon2id)を使う。パラメータは OWASP 推奨に沿った
 * `memoryCost 19456`(≒19MiB)/ `timeCost 2`。平文は一切保持せず、ハッシュのみを
 * `password_credentials.password_hash` に保存する(`store.setPassword`)。
 */

/** パスワードを argon2id でハッシュ化する。 */
export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, {
    algorithm: "argon2id",
    memoryCost: 19456,
    timeCost: 2,
  });
}

/** 平文パスワードがハッシュと一致するか検証する。 */
export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash);
}
