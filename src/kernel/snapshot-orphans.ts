/**
 * 孤児・死蔵スナップショットの検出と、アプリ単位のスナップショット削除プリミティブ
 * (V1-M9-T04。ADR-0030)。
 *
 * **本モジュールは「検出」と「アプリ単位の全消し」だけを持つ。** 古いスナップショットの
 * 世代刈り取り(retention)・単一スナップショットの削除・定期実行の契機は**置かない**。
 * v1 では刈り取りを行わない(= 全世代を残す)という方針であり(判定: `docs/plan/v1/
 * records/v1-m9-t04-gate.md` §7 完了条件3)、刈り取りを入れると残存アプリの「undo できる
 * 範囲」が縮み、ADR-0004:238 が課す「縮小をユーザに伝える仕組み」が同時に必要になる。
 * それは v2 の作業である(ADR-0030 §3)。
 *
 * ## 検出は「孤児」と「死蔵」を必ず別欄で数える(ゲート §5)
 *
 * - **孤児(orphans)**: ディスクに実在するが changelog から参照されないスナップショット。
 *   apply の途中失敗やクラッシュ復旧でしか生まれない(事前検証で拒否された差分は
 *   スナップショットを作らない)。**孤児が1件でもあれば、それはバグかクラッシュの痕跡である。**
 * - **死蔵(undo_snapshots)**: `<連番>-undo-<diff_id>` 命名のスナップショット。undo 実行
 *   直前の状態であり、changelog(undo エントリ)から参照されるが、**戻り先として二度と
 *   使われない**(ADR-0004:230「そこへ戻る API は提供しない」。redo は v0/v1 の非目標)。
 * - **宙吊り参照(dangling_references)**: changelog が参照するがディスクに実体が無い。
 *
 * **孤児と死蔵を1つの欄に混ぜない。** 混ぜると、v2 で刈り取りを設計するときに
 * 「消してよいもの」と「T05(redo)が入れば戻り先になりうるもの」の区別が失われる。
 * 分類は**命名を先に見る** —— `undo-` 前置のスナップショットは、たとえ changelog に
 * 参照が無く(undo の changelog 追記が失敗した痕跡など)ても、孤児ではなく死蔵に数える。
 *
 * ## 削除プリミティブ(T09 が呼ぶ唯一の削除経路)
 *
 * `deleteAppSnapshots` は「そのアプリの `snapshots/` 配下を消す」だけの冪等な操作である。
 * **単一スナップショット削除 API も世代指定の刈り取り API も置かない。** アプリ削除
 * (V1-M9-T09)がスナップショットディレクトリの削除を含むため、削除経路を2箇所に作らず
 * ここ1本に集約する(計画書 §依存構造の要約: T04 → T09)。`force` で消すので、T09 が
 * `appDir` を丸ごと `rmSync` したあとに従属操作として本関数を呼んでも二重削除で壊れない。
 * **changelog の行は消さない** —— それは T09 が kernel.sqlite 側で行う(ゲート §7 完了条件5)。
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { FILES_TABLE_ID } from "../shared/files-table.ts";
import type { ChangelogEntry } from "./meta-store.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { listSnapshots } from "./snapshot.ts";
import {
  appBlobsDir,
  appDbPath,
  appEscapeHatchDir,
  appManifestPath,
  appSnapshotsDir,
  appsDir,
  snapshotDir,
} from "./storage-paths.ts";
import { UNDO_DIFF_ID_PREFIX } from "./undo.ts";

/** スナップショットディレクトリ名 `<連番>-<diff_id>` を分解する。連番は4桁固定。 */
const SNAPSHOT_NAME_RE = /^(\d{4})-(.+)$/;

/**
 * 1アプリのスナップショット監査結果(判断ゲートの走査スクリプトと同じ欄)。
 *
 * 配列はいずれもディレクトリ名の昇順(= 連番が4桁ゼロ埋めなので時系列昇順)。
 */
export type SnapshotAudit = {
  /** 対象アプリのID。 */
  app_id: string;
  /** ディスクに実在する全スナップショットディレクトリ名。 */
  on_disk: string[];
  /** changelog が参照する(非 null の `snapshot` 値)スナップショット名(重複排除)。 */
  referenced: string[];
  /** ディスクにあるが changelog 未参照の孤児(**`-undo-` 命名は含めない**)。 */
  orphans: string[];
  /** changelog が参照するがディスクに実体が無い宙吊り参照。 */
  dangling_references: string[];
  /** `<連番>-undo-<diff_id>` 命名の死蔵スナップショット(戻り先として二度と使われない)。 */
  undo_snapshots: string[];
  /** `snapshots/` 配下の全ファイルの合計バイト数(重複排除なしの実消費)。 */
  bytes: number;
};

/** ディレクトリ名から diff_id 部分を取り出す(`<4桁>-<diff_id>`)。合致しなければ undefined。 */
function diffIdOf(snapshotName: string): string | undefined {
  return SNAPSHOT_NAME_RE.exec(snapshotName)?.[2];
}

/** `<連番>-undo-<...>` 命名か(= undo 実行直前の死蔵スナップショットか)。 */
function isUndoSnapshot(snapshotName: string): boolean {
  return diffIdOf(snapshotName)?.startsWith(UNDO_DIFF_ID_PREFIX) ?? false;
}

/** `snapshots/` 配下の全ファイルのバイト数を再帰的に合計する。 */
function snapshotsBytes(dataRoot: string, appId: string): number {
  const root = appSnapshotsDir(dataRoot, appId);
  if (!existsSync(root)) {
    return 0;
  }
  let total = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        total += statSync(path).size;
      }
    }
  };
  walk(root);
  return total;
}

/**
 * 与えられた changelog を基準に、1アプリのスナップショットを監査する(ディスク側の走査のみ)。
 *
 * changelog の取得を引数に外に出しているのは、`auditAllSnapshots` が
 * `KernelMetaStore` を1度だけ開いて複数アプリを回すためである。
 */
function auditWith(dataRoot: string, appId: string, changelog: ChangelogEntry[]): SnapshotAudit {
  const onDisk = listSnapshots(dataRoot, appId);
  const referencedSet = new Set(
    changelog.flatMap((entry) => (entry.snapshot === null ? [] : [entry.snapshot])),
  );
  const referenced = [...referencedSet].sort();

  const orphans: string[] = [];
  const undoSnapshots: string[] = [];
  for (const name of onDisk) {
    if (isUndoSnapshot(name)) {
      // 死蔵は**命名で**先に分類する。changelog 参照の有無に関わらず孤児には混ぜない。
      undoSnapshots.push(name);
    } else if (!referencedSet.has(name)) {
      orphans.push(name);
    }
    // それ以外は「参照されている通常の apply スナップショット」で、専用の欄は持たない。
  }

  const onDiskSet = new Set(onDisk);
  const danglingReferences = referenced.filter((name) => !onDiskSet.has(name));

  return {
    app_id: appId,
    on_disk: onDisk,
    referenced,
    orphans,
    dangling_references: danglingReferences,
    undo_snapshots: undoSnapshots,
    bytes: snapshotsBytes(dataRoot, appId),
  };
}

/**
 * 1アプリの孤児・死蔵・宙吊り参照を検出する(読み取り主体。状態は変えない)。
 *
 * @param dataRoot データルート(`data/` 相当)。環境変数に依存させず必ず引数で受ける。
 * @param appId 対象アプリのID。
 */
export function auditAppSnapshots(dataRoot: string, appId: string): SnapshotAudit {
  const store = KernelMetaStore.open(dataRoot);
  try {
    return auditWith(dataRoot, appId, store.listChangelog(appId));
  } finally {
    store.close();
  }
}

/**
 * データルート配下の全アプリを横断して監査する。
 *
 * 対象は `apps/` 配下に実在するアプリディレクトリである(台帳ではなくディスクを母数に
 * するのは、孤児は「ディスクに実在するのに参照が無い」ものなので、ディスク側を起点に
 * 数えるのが素直だからである)。`apps/` が無ければ空配列。
 *
 * @param dataRoot データルート(`data/` 相当)。
 */
export function auditAllSnapshots(dataRoot: string): SnapshotAudit[] {
  const root = appsDir(dataRoot);
  if (!existsSync(root)) {
    return [];
  }
  const appIds = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (appIds.length === 0) {
    return [];
  }

  const store = KernelMetaStore.open(dataRoot);
  try {
    return appIds.map((appId) => auditWith(dataRoot, appId, store.listChangelog(appId)));
  } finally {
    store.close();
  }
}

/**
 * アプリのスナップショットディレクトリ(`snapshots/` 配下)を丸ごと消す削除プリミティブ。
 *
 * **これが T09(アプリ削除)が呼ぶ唯一のスナップショット削除経路である。** 単一
 * スナップショットの削除も世代指定の刈り取りも提供しない(v1 で undo 範囲を縮めないため)。
 * `force` 付きの再帰削除なので**冪等**であり、`snapshots/` が存在しなくても、T09 が
 * `appDir` を丸ごと消したあとでも、二重に呼んでも例外にならない。**changelog の行は
 * 触らない**(kernel.sqlite 側の後始末は T09 の責務)。
 *
 * @param dataRoot データルート(`data/` 相当)。
 * @param appId 対象アプリのID。
 */
export function deleteAppSnapshots(dataRoot: string, appId: string): void {
  rmSync(appSnapshotsDir(dataRoot, appId), { recursive: true, force: true });
}

// --- orphan blob 検出(V2-M2-T04。ADR-0035 §3 限定7・限定8 / §4 不変条件)-----------------
//
// **snapshot-orphans と同型の「検出」と「アプリ単位の全消し」だけを持つ。** blob の世代刈り取り
// (自動 retention)・単一 blob の削除・定期実行の契機は**置かない**。V1-M9-T04 が snapshot 刈り取りを
// v1 で行わない方針を採ったのと**同じ理由**(ADR-0030 §3。刈り取りは undo/redo の戻り先を縮めるので
// v2 の別判断に委ねる)であり、ADR-0035 §3a #3 が「blob の自動 retention 刈り取り」を本 ADR を
// 根拠にできない別審査事項として明示している。
//
// ## orphan の定義(ADR-0035 §4「(orphan)」)
//
// 「**現行 app.sqlite + 全 snapshot の app.sqlite のどの `_files` からも参照されない blobs/ 実体**」
// だけが orphan である。undo は過去の `_files`(= 過去の file_id→sha256 対応)を復元しうるので、
// **現行だけを見て刈ると undo で画像が戻らなくなる。全 snapshot の `_files` を参照集合に含めることが
// undo の正しさを守る**(§4「全 snapshot 参照を見ることが undo の正しさを守る」)。blob 実体は
// content-addressed で不変・共有なので、参照集合に入る間は1バイトも消してはならない。

/** blob 実体名(= sha256 の16進64文字)。`.tmp-…`(書込中)や非 blob を弾く。 */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** スナップショット内の app.sqlite ファイル名(`snapshot.ts` と同じ)。 */
const SNAPSHOT_DB = "app.sqlite";

/**
 * 1アプリの blob 監査結果(`SnapshotAudit` と同型の欄立て)。
 *
 * 配列はいずれも sha256 の昇順。
 */
export type BlobAudit = {
  /** 対象アプリのID。 */
  app_id: string;
  /** `blobs/` に実在する全 blob 実体名(sha256)。 */
  on_disk: string[];
  /** 現行 + 全 snapshot の `_files` が参照する sha256(重複排除)。 */
  referenced: string[];
  /** ディスクにあるが現行 + 全 snapshot のどの `_files` からも参照されない孤児 blob。 */
  orphans: string[];
  /** `blobs/` 配下の全 blob 実体の合計バイト数。 */
  bytes: number;
};

/**
 * 与えられた `app.sqlite` の `_files.sha256` 集合を読む(読み取り専用)。
 *
 * `_files` は**遅延生成**(画像を一度もアップロードしていないアプリ/スナップショットには
 * 存在しない)なので、テーブルが無ければ空集合を返す。DB ファイル自体が無い場合も空集合。
 */
function referencedSha256Of(dbPath: string): Set<string> {
  if (!existsSync(dbPath)) {
    return new Set();
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const table = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(FILES_TABLE_ID);
    if (table === null) {
      return new Set();
    }
    const rows = db
      .query<{ sha256: string }, []>(`SELECT "sha256" AS sha256 FROM "${FILES_TABLE_ID}"`)
      .all();
    return new Set(rows.map((row) => row.sha256));
  } finally {
    db.close();
  }
}

/**
 * 1アプリの orphan blob を検出する(読み取り主体。状態は変えない)。
 *
 * 参照集合 = 現行 `app.sqlite` の `_files.sha256` ∪ 全 snapshot の `app.sqlite` の `_files.sha256`。
 * ディスクの `blobs/` 実体のうち参照集合に無いものが orphan。**列挙するだけで消さない**
 * (自動刈り取りは置かない。ADR-0035 §3 限定7)。
 *
 * 計算量は「1(現行)+ snapshot 数」個の app.sqlite を開いて `_files` を全読みするだけで、
 * 各 DB につき `_files` の行数に比例する。snapshot は apply のたびに1つ増えるので参照集合の
 * 構築は snapshot 数に線形だが、**blob 自体は content-addressed で重複しない**ため参照集合の
 * サイズは実ファイル種類数で頭打ちになる。検出は明示的な保守操作(定期実行しない)なので
 * この素朴な走査で十分である。
 *
 * @param dataRoot データルート(`data/` 相当)。環境変数に依存させず必ず引数で受ける。
 * @param appId 対象アプリのID。
 */
export function auditAppBlobs(dataRoot: string, appId: string): BlobAudit {
  const blobsRoot = appBlobsDir(dataRoot, appId);
  const onDisk = existsSync(blobsRoot)
    ? readdirSync(blobsRoot, { withFileTypes: true })
        .filter((entry) => entry.isFile() && SHA256_HEX_RE.test(entry.name))
        .map((entry) => entry.name)
        .sort()
    : [];

  const referencedSet = referencedSha256Of(appDbPath(dataRoot, appId));
  for (const name of listSnapshots(dataRoot, appId)) {
    for (const sha of referencedSha256Of(join(snapshotDir(dataRoot, appId, name), SNAPSHOT_DB))) {
      referencedSet.add(sha);
    }
  }

  const orphans = onDisk.filter((sha) => !referencedSet.has(sha));
  const bytes = onDisk.reduce((total, sha) => total + statSync(join(blobsRoot, sha)).size, 0);

  return {
    app_id: appId,
    on_disk: onDisk,
    referenced: [...referencedSet].sort(),
    orphans,
    bytes,
  };
}

/**
 * アプリの blob ディレクトリ(`blobs/` 配下)を丸ごと消す削除プリミティブ。
 *
 * **`deleteAppSnapshots` と同型。** アプリ削除(`deleteApp`)が呼ぶ全消し経路であり、
 * **単一 blob 削除も世代指定の刈り取りも提供しない**(参照集合を縮めて undo/redo を壊さない
 * ため。ADR-0035 §3 限定7)。`force` 付きの再帰削除なので**冪等**であり、`blobs/` が存在しなくても、
 * `deleteApp` が `appDir` を丸ごと消したあとでも、二重に呼んでも例外にならない。
 *
 * @param dataRoot データルート(`data/` 相当)。
 * @param appId 対象アプリのID。
 */
export function deleteAppBlobs(dataRoot: string, appId: string): void {
  rmSync(appBlobsDir(dataRoot, appId), { recursive: true, force: true });
}

// --- 逃げ道(任意 CSS)の孤児資産の検出(V3-M5-T02。ADR-0055 限定10)------------------
//
// **`auditAppBlobs` を流用できない。** V3-M5-T01 が本体の籠を `blobs/` と分けた
// (`apps/<app_id>/escape-hatch/`)—— 同じ籠に入れると `_files` の参照集合しか見ない
// `auditAppBlobs` が逃げ道の実体を「参照の無い画像」と**必ず誤って挙げる**からである
// (記録: `docs/plan/v3/records/v3-m5-t01.md` §3-1 の3 / 申し送り2)。
// **形は同型で、読む先だけが違う** —— `_files.sha256` ではなく **view の逃げ道の参照
// (`custom_css.digest`)**を読む。
//
// ## orphan の定義(ADR-0055 限定10。`auditAppBlobs` の :210〜:216 と同じ理由で同じ形)
//
// 「**現行 manifest.json + 全 snapshot の manifest.json のどの view の `custom_css` からも
// 参照されない `escape-hatch/` 実体**」だけが orphan である。undo は過去のマニフェスト
// (= 過去の参照)を書き戻しうるので、**現行だけを見て刈ると undo で見た目が戻らなくなる。**
// 全 snapshot の manifest.json を参照集合に含めることが undo の正しさを守る。
//
// **自動では刈らない(検出のみ)。** ADR-0035 が「最も重い恒久債務」と自認したものと同じ
// ものを背負う —— **「解決した」と書いてはならない**(ADR-0055 §4 限界5)。
//
// **資産の失効(`deleteEscapeHatchAsset`)は実体を消さない**ので、失効した資産の実体は
// 参照が残っている限り orphan にもならない。**「登録が無い」と「実体が無い」は別である**
// —— 前者を検出するのは配信層の fail-closed(限定6)であって、本監査ではない。

/**
 * 1アプリの逃げ道資産の監査結果(`BlobAudit` と同型の欄立て)。
 *
 * 配列はいずれも sha256 の昇順。
 */
export type EscapeHatchAudit = {
  /** 対象アプリのID。 */
  app_id: string;
  /** `escape-hatch/` に実在する全実体名(sha256)。 */
  on_disk: string[];
  /** 現行 + 全 snapshot の manifest.json が参照する sha256(重複排除)。 */
  referenced: string[];
  /** ディスクにあるが現行 + 全 snapshot のどのマニフェストからも参照されない孤児。 */
  orphans: string[];
  /** `escape-hatch/` 配下の全実体の合計バイト数。 */
  bytes: number;
};

/** スナップショット内のマニフェストのファイル名(`snapshot.ts` と同じ)。 */
const SNAPSHOT_MANIFEST = "manifest.json";

/**
 * 与えられた `manifest.json` が参照する逃げ道のダイジェスト集合を読む(読み取り専用)。
 *
 * **検証しない。** ここは「参照されているか」だけを数える監査であり、スキーマ適合は
 * 書き込みの関門(`validate.ts`)が持つ。**壊れた JSON / 存在しないファイルは空集合**として
 * 数える —— 監査が例外で落ちると、**壊れた1本のせいで他の実体が全部「参照ゼロ」に見える**
 * (= 刈ってはいけないものを孤児として提示する)という、いちばん危険な壊れ方をする。
 */
function referencedDigestsOf(manifestPath: string): Set<string> {
  if (!existsSync(manifestPath)) {
    return new Set();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return new Set();
  }
  const views = (parsed as { app?: { views?: unknown } } | null)?.app?.views;
  if (!Array.isArray(views)) {
    return new Set();
  }
  const digests = new Set<string>();
  for (const view of views) {
    const digest = (view as { custom_css?: { digest?: unknown } } | null)?.custom_css?.digest;
    if (typeof digest === "string" && SHA256_HEX_RE.test(digest)) {
      digests.add(digest);
    }
  }
  return digests;
}

/**
 * 1アプリの孤児となった逃げ道資産を検出する(読み取り主体。状態は変えない)。
 *
 * 参照集合 = 現行 `manifest.json` の `custom_css.digest` ∪ 全 snapshot の同じ集合。
 * ディスクの `escape-hatch/` 実体のうち参照集合に無いものが orphan。**列挙するだけで
 * 消さない**(自動刈り取りは置かない。ADR-0055 限定10)。
 *
 * @param dataRoot データルート(`data/` 相当)。環境変数に依存させず必ず引数で受ける。
 * @param appId 対象アプリのID。
 */
export function auditAppEscapeHatch(dataRoot: string, appId: string): EscapeHatchAudit {
  const root = appEscapeHatchDir(dataRoot, appId);
  const onDisk = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isFile() && SHA256_HEX_RE.test(entry.name))
        .map((entry) => entry.name)
        .sort()
    : [];

  const referencedSet = referencedDigestsOf(appManifestPath(dataRoot, appId));
  for (const name of listSnapshots(dataRoot, appId)) {
    for (const digest of referencedDigestsOf(
      join(snapshotDir(dataRoot, appId, name), SNAPSHOT_MANIFEST),
    )) {
      referencedSet.add(digest);
    }
  }

  const orphans = onDisk.filter((digest) => !referencedSet.has(digest));
  const bytes = onDisk.reduce((total, digest) => total + statSync(join(root, digest)).size, 0);

  return {
    app_id: appId,
    on_disk: onDisk,
    referenced: [...referencedSet].sort(),
    orphans,
    bytes,
  };
}
