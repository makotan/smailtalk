/**
 * 自動バックアップ(V1-M3-T07 / ADR-0019 決定1)。
 *
 * undo 用の `snapshots/` とは**別物**として、全アプリ(`app.sqlite` + `manifest.json` +
 * `blobs/`)と `kernel.sqlite` の整合コピーを `data/backups/<stamp>/` に取る。`VACUUM INTO` を
 * 使うので WAL の内容も他接続の未コミット変更も SQLite が除外し、DB は**単一ファイルの整合コピー**
 * になる(`src/kernel/snapshot.ts` の `copyDatabaseConsistently` と同じ根拠)。offsite/PITR は
 * ADR-0018 の移行トリガー T3(Litestream)に委ね、ここでは扱わない。
 *
 * ## 画像 blob を**含める**(V2-M2-T04 / ADR-0035 §4「(backup)」)
 *
 * snapshot は肥大回避のため blob を**含めない**が、**backup は災害復旧の完全性のため各アプリの
 * `blobs/` を含める**。この非対称は ADR-0035 §4 の不変条件である(backup が重くなること自体は
 * 許容する。snapshot 肥大とは別問題)。blob 実体は content-addressed で不変な単なるファイルなので、
 * DB のような整合コピー(`VACUUM INTO`)は要らず `copyFileSync` で足りる。
 *
 * ## 門(門外 Δ7)
 *
 * `src/kernel/` と `schemas/` を1バイトも変えない。カーネルの**既存**エクスポート
 * (`storage-paths` のパス関数 = `appBlobsDir` を含む / `isApplyInProgress` / `systemClock`)を
 * 読むだけである。`appBlobsDir` は T02 が storage-paths(kernel)に足したもので、本モジュールは
 * それを**読むだけ**(既存の `appDbPath` / `appManifestPath` 読取と同型)。
 * `data/backups/` のパスは storage-paths に足さない(足すと kernel 変更=門外違反)ので
 * 本モジュールで組む。`VACUUM INTO` も `copyDatabaseConsistently` が非公開のため数行で自前に
 * 書く(busy_timeout を設定した接続で `VACUUM INTO` を撃つだけ。WAL の `kernel.sqlite` も
 * `VACUUM INTO` 単独で整合するので checkpoint は要らない)。
 *
 * ## mid-apply の扱い(内部不整合セットを作らない)
 *
 * バックアップの3種のファイル(`app.sqlite` / `manifest.json` / `kernel.sqlite`)は
 * セットとして原子的でない。apply 窓中(`.st-applying.json` 在)のアプリを拾うと、DDL 適用済み
 * `app.sqlite` + 新 `manifest.json` を取りつつ `kernel.sqlite` に changelog が未追記、という
 * 内部不整合セットを作りうる。したがって **apply 窓中のアプリは skip する**(`skipped[]` に記録)。
 * 日次バックアップなので前世代が残り、実害はない。**残る非原子性**(kernel コピーとアプリ
 * コピーの間で apply が開始する窓)は日次運用で許容し、ADR-0019 に正直に記す。
 */
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "../kernel/index.ts";
import {
  appBlobsDir,
  appDbPath,
  appManifestPath,
  appsDir,
  isApplyInProgress,
  kernelDbPath,
  systemClock,
} from "../kernel/index.ts";

/** `data/backups/`。undo 用の `snapshots/` とは別ディレクトリ。 */
export const BACKUP_DIR_NAME = "backups";

/** 保持する世代数(ADR-0019 決定1: 日次・7世代)。 */
export const RETENTION = 7;

/** バックアップ tick の周期(1時間)。**固定定数** —— 実行時に差し替える口を置かない。 */
export const BACKUP_TICK_INTERVAL_MS = 60 * 60 * 1000;

/** バックアップの最小間隔(24時間)。前回から this 以上経っていれば取る。 */
export const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** コピー用接続の busy_timeout(`snapshot.ts` と同じ既定)。 */
const BACKUP_BUSY_TIMEOUT_MS = 5_000;

/** `YYYYMMDDTHHMMSSsssZ`(区切り安全・固定幅・辞書順=時系列)の正規表現。 */
const STAMP_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/;

export type BackupResult = {
  /** 作成した `backups/<stamp>/` の絶対パス。 */
  dir: string;
  /** ディレクトリ名に使ったタイムスタンプ。 */
  stamp: string;
  /** バックアップした app_id(ソート済み)。 */
  apps: string[];
  /** apply 窓中で skip した app_id。 */
  skipped: string[];
  /** `kernel.sqlite` をコピーしたか。 */
  kernel: boolean;
  /** retention で削除した世代の stamp。 */
  pruned: string[];
};

/** `Date` を区切り安全な固定幅 stamp に変換する。 */
export function formatBackupStamp(date: Date): string {
  // "2026-07-21T10:00:00.123Z" -> "20260721T100000123Z"
  return date.toISOString().replace(/[-:.]/g, "");
}

/** stamp を epoch ミリ秒に戻す。形式外なら null。 */
export function parseBackupStamp(stamp: string): number | null {
  const m = STAMP_RE.exec(stamp);
  if (m === null) {
    return null;
  }
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** データルート配下のアプリIDを列挙する(recovery.ts と同じ on-disk 走査)。 */
function listAppIds(dataRoot: string): string[] {
  const dir = appsDir(dataRoot);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * アプリの `blobs/`(content-addressed の画像実体)を backup 世代へコピーする(ADR-0035 §4)。
 *
 * blob は内容の sha256 を名前に持つ**不変・共有**のファイルなので、DB のような整合コピーは要らず
 * `copyFileSync` で足りる。`blobs/` が無い(画像未アップロード)アプリは何もしない。書込中の
 * `.tmp-…`(`blob-store.ts` の原子的書込の一時ファイル)は最終実体ではないのでコピー対象外。
 */
function copyBlobs(sourceBlobsDir: string, destinationBlobsDir: string): void {
  if (!existsSync(sourceBlobsDir)) {
    return;
  }
  const entries = readdirSync(sourceBlobsDir, { withFileTypes: true }).filter(
    (entry) => entry.isFile() && !entry.name.startsWith(".tmp-"),
  );
  if (entries.length === 0) {
    return;
  }
  mkdirSync(destinationBlobsDir, { recursive: true });
  for (const entry of entries) {
    copyFileSync(join(sourceBlobsDir, entry.name), join(destinationBlobsDir, entry.name));
  }
}

/** busy_timeout を設定した接続で `VACUUM INTO` を撃つ(単一ファイルの整合コピー)。 */
function vacuumInto(sourcePath: string, destinationPath: string): void {
  const db = new Database(sourcePath, { readwrite: true, create: false });
  try {
    db.exec(`PRAGMA busy_timeout = ${BACKUP_BUSY_TIMEOUT_MS};`);
    db.query("VACUUM INTO ?").run(destinationPath);
  } finally {
    db.close();
  }
}

/** 世代を RETENTION 個に刈る。削除した stamp を返す。 */
function pruneOldBackups(backupRoot: string, keep: number): string[] {
  if (!existsSync(backupRoot)) {
    return [];
  }
  const stamps = readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && STAMP_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort(); // 固定幅 stamp なので辞書順=時系列。
  const excess = stamps.slice(0, Math.max(0, stamps.length - keep));
  for (const stamp of excess) {
    rmSync(join(backupRoot, stamp), { recursive: true, force: true });
  }
  return excess;
}

/**
 * 1回ぶんのバックアップを取る。全アプリ + kernel.sqlite を `backups/<stamp>/` に整合コピーし、
 * 世代を RETENTION に刈る。apply 窓中のアプリは skip する。同一 stamp の二重実行は throw する
 * (黙って上書きしない)。
 */
export function runBackup(dataRoot: string, clock: Clock = systemClock): BackupResult {
  const stamp = formatBackupStamp(clock.now());
  const backupRoot = join(dataRoot, BACKUP_DIR_NAME);
  const dir = join(backupRoot, stamp);
  if (existsSync(dir)) {
    throw new Error(`バックアップ先が既に存在します: ${dir}(同一タイムスタンプの二重実行)`);
  }
  mkdirSync(dir, { recursive: true });

  // kernel.sqlite(WAL)。VACUUM INTO 単独で WAL 内容も整合する。
  vacuumInto(kernelDbPath(dataRoot), join(dir, "kernel.sqlite"));

  const apps: string[] = [];
  const skipped: string[] = [];
  for (const appId of listAppIds(dataRoot)) {
    if (isApplyInProgress(dataRoot, appId).inProgress) {
      skipped.push(appId);
      continue;
    }
    const appBackupDir = join(dir, "apps", appId);
    mkdirSync(appBackupDir, { recursive: true });
    vacuumInto(appDbPath(dataRoot, appId), join(appBackupDir, "app.sqlite"));
    const manifestPath = appManifestPath(dataRoot, appId);
    if (existsSync(manifestPath)) {
      copyFileSync(manifestPath, join(appBackupDir, "manifest.json"));
    }
    // 画像 blob 実体も含める(災害復旧の完全性。ADR-0035 §4「(backup)」)。
    copyBlobs(appBlobsDir(dataRoot, appId), join(appBackupDir, "blobs"));
    apps.push(appId);
  }

  const pruned = pruneOldBackups(backupRoot, RETENTION);
  return { dir, stamp, apps, skipped, kernel: true, pruned };
}

/** `data/backups/` の最新世代の時刻(epoch ミリ秒)。世代が無ければ null。 */
export function latestBackupTime(dataRoot: string): number | null {
  const backupRoot = join(dataRoot, BACKUP_DIR_NAME);
  if (!existsSync(backupRoot)) {
    return null;
  }
  const stamps = readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && STAMP_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const latest = stamps[stamps.length - 1];
  return latest === undefined ? null : parseBackupStamp(latest);
}

/**
 * スケジューラの1 tick。最新世代から BACKUP_INTERVAL_MS 以上経っていれば runBackup し、
 * まだなら null を返す。**登録簿を持たず、前回時刻は `backups/` の最新ディレクトリ名から導く**
 * (workflow-scheduler.ts と同じ状態レス設計)。
 */
export function runBackupTick(dataRoot: string, clock: Clock = systemClock): BackupResult | null {
  const last = latestBackupTime(dataRoot);
  const now = clock.now().getTime();
  if (last !== null && now - last < BACKUP_INTERVAL_MS) {
    return null;
  }
  return runBackup(dataRoot, clock);
}

export type BackupSchedulerOptions = {
  dataRoot: string;
  clock?: Clock;
};

export type BackupSchedulerHandle = {
  stop(): void;
};

/**
 * バックアップの常駐スケジューラを起動する。周期は **固定定数** BACKUP_TICK_INTERVAL_MS(1時間)で、
 * 各 tick は「最新世代から24時間以上経っていれば取る」。24時間周期の setInterval にしないのは、
 * 24時間ごとに再起動される運用で第1 tick が毎回先送りされ**一度も取られない**穴を避けるため
 * (workflow-scheduler.ts が30秒周期で遅れ上限を担保しているのと同じ思想)。全域で例外を投げない。
 */
export function startBackupScheduler(options: BackupSchedulerOptions): BackupSchedulerHandle {
  const clock = options.clock ?? systemClock;
  const timer = setInterval(() => {
    try {
      runBackupTick(options.dataRoot, clock);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[smailtalk backup] 自動バックアップに失敗しました: ${detail}\n`);
    }
  }, BACKUP_TICK_INTERVAL_MS);
  // タイマーがイベントループを握ってプロセス終了を妨げないようにする。
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  return {
    stop: () => clearInterval(timer),
  };
}
