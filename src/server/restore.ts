/**
 * バックアップからのリストア(V1-M3-T07 / ADR-0019 決定1)。
 *
 * `runBackup`(`backup.ts`)が `backups/<stamp>/` に取った整合コピーを、データルートへ戻す。
 * バックアップは `VACUUM INTO` で作った**単一ファイル**(WAL sidecar 無し)なので、リストアは
 * `copyFileSync` で足りる。ただし復元先に**古い `-wal` / `-shm` / `-journal` が残っていると**、
 * 本体だけ差し替えた瞬間に次回オープンで stale WAL が本体へ適用され、復元した状態が壊れる。
 * とくに `kernel.sqlite` は WAL モード(`meta-store.ts`)なので致命的である。したがって
 * **復元の前後で sidecar を消す**(`snapshot.ts` の `restoreSnapshot` と同じ「前後2回消す」作法)。
 *
 * ## 門(門外 Δ7)
 *
 * `src/kernel/` と `schemas/` を1バイトも変えない。カーネルの既存パス関数を読むだけである。
 *
 * ## 前提: サーバ停止中に行う
 *
 * live 接続がある状態での上書き復元は未定義である(`snapshot.ts` の undo も単一アプリの
 * apply 直前という制御下でしか動かない)。運用手順として**復元はサーバ停止中に行う**。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { appBlobsDir, appDbPath, appManifestPath, kernelDbPath } from "../kernel/index.ts";

export type RestoreResult = {
  /** 復元した app_id(ソート済み)。 */
  apps: string[];
  /** `kernel.sqlite` を復元したか。 */
  kernel: boolean;
};

/** DB 本体に付随する sidecar を消す(stale WAL の巻き込みを防ぐ)。 */
function removeSidecars(dbPath: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

/**
 * backup 内の `blobs/` をデータルートへ復元する(ADR-0035 §4)。
 *
 * blob は content-addressed の不変ファイルなので `copyFileSync` で足りる(sidecar も無い)。
 * backup に `blobs/` が無い(画像未アップロードのアプリ)場合は何もしない。
 */
function restoreBlobs(sourceBlobsDir: string, destinationBlobsDir: string): void {
  if (!existsSync(sourceBlobsDir)) {
    return;
  }
  const files = readdirSync(sourceBlobsDir, { withFileTypes: true }).filter((entry) =>
    entry.isFile(),
  );
  if (files.length === 0) {
    return;
  }
  mkdirSync(destinationBlobsDir, { recursive: true });
  for (const entry of files) {
    copyFileSync(join(sourceBlobsDir, entry.name), join(destinationBlobsDir, entry.name));
  }
}

/**
 * バックアップディレクトリ(`backups/<stamp>/`)を dataRoot へ復元する。kernel.sqlite と
 * 全アプリ(app.sqlite + manifest.json)を戻す。復元は sidecar を前後で消してから copyFileSync する。
 */
export function restoreBackup(backupDir: string, dataRoot: string): RestoreResult {
  const kernelSrc = join(backupDir, "kernel.sqlite");
  if (!existsSync(kernelSrc)) {
    throw new Error(`バックアップに kernel.sqlite がありません: ${backupDir}`);
  }
  const kernelDest = kernelDbPath(dataRoot);
  mkdirSync(dirname(kernelDest), { recursive: true });
  removeSidecars(kernelDest);
  copyFileSync(kernelSrc, kernelDest);
  removeSidecars(kernelDest);

  const apps: string[] = [];
  const appsBackupDir = join(backupDir, "apps");
  if (existsSync(appsBackupDir)) {
    const appIds = readdirSync(appsBackupDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const appId of appIds) {
      const appSrc = join(appsBackupDir, appId, "app.sqlite");
      if (!existsSync(appSrc)) {
        continue;
      }
      const appDest = appDbPath(dataRoot, appId);
      mkdirSync(dirname(appDest), { recursive: true });
      removeSidecars(appDest);
      copyFileSync(appSrc, appDest);
      removeSidecars(appDest);
      const manifestSrc = join(appsBackupDir, appId, "manifest.json");
      if (existsSync(manifestSrc)) {
        copyFileSync(manifestSrc, appManifestPath(dataRoot, appId));
      }
      // 画像 blob 実体も復元する(ADR-0035 §4「(backup)」の対称)。backup が含めたので、
      // これを戻さないと復元後に image が配信できず「メタは在るが実体が無い」404 になる。
      restoreBlobs(join(appsBackupDir, appId, "blobs"), appBlobsDir(dataRoot, appId));
      apps.push(appId);
    }
  }

  return { apps, kernel: true };
}
