/**
 * リソースID の構文規約(handover.md 3.4 の第一歩)。
 *
 * - 使用可能文字: 英小文字 (a-z)、数字 (0-9)、ハイフン (-)、アンダースコア (_)
 * - 先頭は英小文字であること(数字・ハイフン・アンダースコア始まりは不可)
 * - 長さは 1〜64 文字
 *
 * URL パス片・ファイル名・環境変数由来の識別子として安全に扱えることを狙う。
 * 大文字を許さないのは、大文字小文字を区別しないファイルシステム上で
 * 別IDが衝突するのを避けるため。
 *
 * kebab-case (`my-field`) と snake_case (`my_field`) の**両方**を許可する
 * (handover.md 3.4 のサンプルが `finished_at` を使っているため)。
 * 両者は正規化されず、別々のIDとして扱われる。
 *
 * この規約は `schemas/manifest.schema.json` の `$defs/resource_id` の
 * `pattern` / `maxLength` と一致していなければならない
 * (`schemas/diff.schema.json` はその定義を $ref するため自動的に追従する)。
 */
export const RESOURCE_ID_MAX_LENGTH = 64;

/**
 * 先頭・末尾のアンカーに `^`/`$` ではなく `\A`相当の挙動を得るため、
 * `$` が行末にもマッチする問題を避けて明示的に長さと全体一致で検証する。
 */
const RESOURCE_ID_PATTERN = /^[a-z][a-z0-9_-]*$/;

/**
 * 与えられた文字列がリソースIDとして妥当かを判定する純粋関数。
 */
export function isValidResourceId(id: string): boolean {
  if (id.length === 0 || id.length > RESOURCE_ID_MAX_LENGTH) {
    return false;
  }
  // `$` は最終行末にもマッチするため、改行を含むものは明示的に弾く。
  if (id.includes("\n") || id.includes("\r")) {
    return false;
  }
  return RESOURCE_ID_PATTERN.test(id);
}
