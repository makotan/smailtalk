/**
 * blob ストア(V2-M2-T02 / ADR-0035 §1・限定3・Δ8)。
 *
 * 画像ファイルの**実体**を `apps/<appId>/blobs/<sha256>` に **content-addressed**
 * (ファイル名 = 内容の sha256 hex)で保存する。メタデータ(file_id / mime / size 等)は
 * `app.sqlite` の `_files` に持つ(`src/shared/files-table.ts`)。この層は「バイト列を
 * 名前付きで置く・読む・在るか見る」だけの退屈な層で、認証・MIME 検査・サイズ上限は
 * サーバ層(アップロード API)の担当である。
 *
 * ## content-addressed の帰結
 *
 * - **de-dup**: 同一内容は sha256 が同じなので1実体に収束する。別 filename で複数回
 *   上げても実体は共有され、メタ(`_files` の行)だけが増える。
 * - **不変**: 一度置いた実体は書き換えない(名前が内容を決める)。ゆえに snapshot は
 *   これをコピーせず(共有・不変だから肥大しない。ADR-0035 §4)、backup はコピーする。
 *
 * ## 原子的書込
 *
 * 一時ファイル(`.tmp-…`)へ書いてから最終名へ `rename` する。rename は同一ファイルシステム内で
 * 原子的なので、**中途半端な内容の実体が最終名で観測されることがない**。既に最終実体が
 * あれば書かずに返す(de-dup)。
 *
 * ## Δ8(ADR-0035 §3 限定8)
 *
 * この層が `src/kernel/` に増やす公開面は `putBlob` / `getBlob` / `blobExists` の3点に
 * 限る(+ `storage-paths.ts` の `appBlobsDir`)。orphan-blob 検出は T04 の担当でここには置かない。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appBlobsDir } from "./storage-paths.ts";

/** content-addressed 名の形式(sha256 の16進64文字)。 */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** バイト列の sha256 を16進文字列で返す。 */
function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * blob 実体の最終パスを返す(検証つき)。
 *
 * `sha256` は `putBlob` が自ら計算した値、または `_files` に載った内部値しか渡ってこない
 * 想定だが、パストラバーサル(`../` 等)を構造的に排除するため **16進64文字以外は拒否**する
 * (多層防御)。不正なら `null` を返し、呼び出し側は「実在しない」として扱う。
 */
function blobPath(dataRoot: string, appId: string, sha256: string): string | null {
  if (!SHA256_HEX_RE.test(sha256)) {
    return null;
  }
  return join(appBlobsDir(dataRoot, appId), sha256);
}

/**
 * バイト列を content-addressed に保存し、その sha256 hex(= 実体名)を返す。
 * 同一内容が既にあれば書かずに返す(de-dup)。書込は tmp→rename で原子的。
 */
export function putBlob(dataRoot: string, appId: string, data: Uint8Array): string {
  const hash = sha256Hex(data);
  const dir = appBlobsDir(dataRoot, appId);
  const finalPath = join(dir, hash);
  if (existsSync(finalPath)) {
    return hash; // de-dup: 既存実体は不変なので上書きしない。
  }
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${hash}-${crypto.randomUUID()}`);
  try {
    writeFileSync(tmpPath, data);
    renameSync(tmpPath, finalPath);
  } catch (error) {
    // 失敗しても中途半端な tmp を残さない(観測されるのは最終名だけ)。
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // クリーンアップ失敗は本エラーを覆い隠さない。
    }
    throw error;
  }
  return hash;
}

/** blob 実体を読む。実在しなければ `null`(エラーではない)。不正な名前も `null`。 */
export function getBlob(dataRoot: string, appId: string, sha256: string): Uint8Array | null {
  const path = blobPath(dataRoot, appId, sha256);
  if (path === null || !existsSync(path)) {
    return null;
  }
  return readFileSync(path);
}

/** その sha256 の blob 実体が存在するか。不正な名前は `false`。 */
export function blobExists(dataRoot: string, appId: string, sha256: string): boolean {
  const path = blobPath(dataRoot, appId, sha256);
  return path !== null && existsSync(path);
}
