/**
 * app_id の採番規則(V0-P2-T03)。
 *
 * app_id はリソースID規約 `^[a-z][a-z0-9_-]*$`(1〜64文字)に従う。
 * app_id はディレクトリ名(`data/apps/<app_id>/`)としてもそのまま使われるため、
 * この規約から外れた値を発行してはならない。最終的に `isValidResourceId` で検査する。
 *
 * 規則:
 * 1. アプリ名を NFKC 正規化して小文字化する(全角英数を半角に寄せるため)
 * 2. `[a-z0-9_]` 以外の文字をハイフンに置き換える(日本語・記号・空白はここで落ちる)
 * 3. 連続する区切り文字(`-` / `_`)を1つにまとめ、先頭・末尾の区切り文字を削る
 * 4. 空になった場合、または先頭が英小文字でない場合は `app` を前置/フォールバックにする
 *    (日本語名は 2 で全滅するため必ずここに来る。日本語名を必ず通すための要)
 * 5. 64文字に収まるよう切り詰める
 * 6. 既に使われているIDなら `-2`, `-3`, ... と連番を足す(連番込みで64文字に収める)
 */
import { isValidResourceId, RESOURCE_ID_MAX_LENGTH } from "./resource-id.ts";

/**
 * slug 化して何も残らなかった場合のフォールバックID。
 * v0 の第一号アプリ名「蔵書管理」のような非ラテン文字の名前はすべてここに落ちる。
 */
export const APP_ID_FALLBACK = "app";

/**
 * アプリ名を slug 化する。結果が有効なリソースIDである保証はない
 * (空文字や数字始まりになりうる)。整形は `generateAppId` が行う。
 */
export function slugifyAppName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/[-_]{2,}/g, (run) => (run.includes("-") ? "-" : "_"))
    .replace(/^[-_]+/, "")
    .replace(/[-_]+$/, "");
}

function truncate(id: string, maxLength: number): string {
  // 切り詰めで末尾が区切り文字になると読みづらいので落とす。
  return id.slice(0, maxLength).replace(/[-_]+$/, "");
}

/**
 * アプリ名から衝突しない app_id を発行する。
 *
 * @param name アプリ名(空白のみは不可)
 * @param isTaken 既に使われているIDかを判定する述語。台帳とディスク上の
 *   ディレクトリの両方を見ることを想定している(呼び出し側の責務)。
 * @throws 名前が空の場合、または規約を満たすIDを発行できなかった場合
 */
export function generateAppId(name: string, isTaken: (id: string) => boolean): string {
  if (name.trim() === "") {
    throw new Error("アプリ名が空です。1文字以上の名前を指定してください。");
  }

  const slug = slugifyAppName(name);
  // 先頭が英小文字でない(空・数字始まり・記号始まり)なら fallback を前置する。
  const base = truncate(
    /^[a-z]/.test(slug) ? slug : slug === "" ? APP_ID_FALLBACK : `${APP_ID_FALLBACK}-${slug}`,
    RESOURCE_ID_MAX_LENGTH,
  );

  if (!isTaken(base)) {
    return assertValid(base, name);
  }

  // 衝突回避: base, base-2, base-3, ...
  for (let n = 2; n < 10_000; n++) {
    const suffix = `-${n}`;
    const candidate = `${truncate(base, RESOURCE_ID_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!isTaken(candidate)) {
      return assertValid(candidate, name);
    }
  }

  throw new Error(`アプリ名「${name}」から衝突しない app_id を発行できませんでした。`);
}

function assertValid(id: string, name: string): string {
  if (!isValidResourceId(id)) {
    throw new Error(
      `アプリ名「${name}」から有効な app_id を生成できませんでした(生成結果: "${id}")。`,
    );
  }
  return id;
}
