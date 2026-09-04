/**
 * 未完了適用の検出と自動巻き戻し(V1-M1-T04)。
 *
 * 憲法4「常に戻せる」を、**例外だけでなくプロセスクラッシュに対しても**成立させる。
 *
 * ## 何が足りなかったか
 *
 * `applyDiff` は失敗時に `restoreSnapshot` で巻き戻す。**しかしそれは `catch` /
 * `finally` が走ることを前提にしている。** `process.exit` / SIGKILL / 電源断では
 * どれも走らず、「マニフェストと DDL は適用済み、changelog は未追記」という
 * **履歴に現れない変更**(憲法5 が壊れる状態)がディスクに残りうる。
 * ADR-0010 §7b が「隙間は塞がずに申告する」と決めた、その隙間である。
 *
 * ## 原子性のモデルは変えない(ADR-0010 §7b)
 *
 * **本モジュールはトランザクションを新設しない。** 原子性は今までどおり
 * **スナップショット + 失敗時 `restoreSnapshot`** で担保される。本モジュールが足すのは
 * **「どこまで進んだかを外から判定できる印」**と、**その印を読んで巻き戻す起動時の手順**
 * だけである。**commit 点も変えていない** —— `appendChangelog` が成功した時点で
 * 適用は確定する、という既存の意味論をそのまま判定に使う。
 *
 * ## 進行中マーカー(`.st-applying.json`)
 *
 * `applyDiff` は、**スナップショットを取る前**に `data/apps/<app_id>/.st-applying.json`
 * を置き、**適用が確定した後**(または巻き戻しが完了した後)に消す。
 * したがってこのファイルが残っているアプリは、**適用の途中で死んだか、死んだ直後である。**
 *
 * **マーカーを commit 点にはしない。** マーカーの削除に失敗した(あるいは削除の直前で
 * 死んだ)場合、マーカーは残るが適用は確定している。**この取り違えは、成功した適用を
 * 勝手に取り消すという最悪の壊れ方になる。** そこで判定は必ず changelog を突き合わせる:
 *
 * | マーカー | changelog に当該 diff_id | 判定 |
 * |---|---|---|
 * | 無い | ―― | `clean`。**1バイトも書かない** |
 * | 有る | **有る** | `committed`。適用は生きている。**マーカーを消すだけ** |
 * | 有る | 無い + スナップショットが完全 | `rolled_back`。`restoreSnapshot` して巻き戻す |
 * | 有る | 無い + スナップショットが半端/無い | `no_changes`。**本体はまだ1バイトも変わっていない** |
 *
 * 最後の行が成立するのは、`applyDiff` が **`takeSnapshot` の完了より前に本体を
 * 1バイトも書き換えない**からである(`apply-diff.ts` の処理順序 1 → 2)。
 * スナップショットが完成していないなら、本体は適用前のままである。
 *
 * ## 正常時に副作用を持たない
 *
 * **マーカーが無ければ、このモジュールはファイルを1つも開かず、DB にも接続しない。**
 * 起動のたびに何かを書き換える設計にすると、それ自体が新しい故障点になる。
 * `kernel.sqlite` を開くのも、マーカーがあるアプリを見つけた後だけである。
 *
 * ## 半端なスナップショットを消さないこと
 *
 * `no_changes` のとき、作りかけのスナップショットディレクトリは**残す**。
 * `apply-diff.ts` の既存方針(「巻き戻し後もスナップショットディレクトリは消さない。
 * 失敗の痕跡を黙って消すより残っているほうが安全側」憲法6)をそのまま延長する。
 * **害は無い** —— undo が復元先に選ぶのは changelog の `snapshot` に載ったものだけであり、
 * 中断したスナップショットは changelog に1行も現れない。
 *
 * ## エラー方針
 *
 * ここで起きる失敗(復元できない、I/O 失敗)は差分を直せば通る種類ではないので例外。
 * `snapshot.ts` / `apply-diff.ts` と同じ方針である。
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KernelMetaStore } from "./meta-store.ts";
import { listSnapshots, restoreSnapshot } from "./snapshot.ts";
import { appDir, appManifestPath, appsDir, snapshotDir } from "./storage-paths.ts";

/** 進行中マーカーのファイル名。アプリディレクトリ直下に置く。 */
const MARKER_NAME = ".st-applying.json";

/** `<連番4桁>-<diff_id>` の連番部分の長さ + ハイフン。 */
const SNAPSHOT_PREFIX_LENGTH = 5;

/**
 * 復旧の判定値。
 *
 * `no_changes` と `rolled_back` を分けているのは、**「本体が変わっていなかった」と
 * 「本体を戻した」は別の事実だから**である。まとめると、記録を読む側が
 * 「何が起きたのか」を復元できない(憲法6)。
 */
export type RecoveryStatus = "clean" | "committed" | "rolled_back" | "no_changes";

/** 1アプリぶんの復旧結果。 */
export type RecoveryOutcome = {
  app_id: string;
  status: RecoveryStatus;
  /** 未完了だった適用の diff_id(`clean` のときは無い)。 */
  diff_id?: string;
  /** 巻き戻しに使ったスナップショットのディレクトリ名(`rolled_back` のときだけ)。 */
  snapshot?: string;
};

/** マーカーのパス。 */
function markerPath(dataRoot: string, appId: string): string {
  return join(appDir(dataRoot, appId), MARKER_NAME);
}

/**
 * 適用の開始を記録する。**`takeSnapshot` より前に呼ぶこと。**
 *
 * 前に呼ぶのが要点である —— スナップショット取得の途中で死んだ場合も、
 * マーカーがあることで「未完了の適用が居た」と分かる。後に置くと、その区間が盲点になる。
 */
export function beginApply(dataRoot: string, appId: string, diffId: string): void {
  writeFileSync(
    markerPath(dataRoot, appId),
    `${JSON.stringify({ diff_id: diffId, started_at: new Date().toISOString() }, null, 2)}\n`,
    "utf-8",
  );
}

/**
 * 適用の終了(確定または巻き戻し完了)を記録する。
 *
 * **巻き戻しに失敗した場合は呼ばないこと。** 呼ばずに残しておけば、次回の `recover` が
 * 復旧を再試行する。ここで消すと「中途半端なまま、誰も未完了だと気づかない」状態になる。
 */
export function endApply(dataRoot: string, appId: string): void {
  rmSync(markerPath(dataRoot, appId), { force: true });
}

/**
 * apply 窓ガード用の状態(V1-M9-T02)。
 *
 * `inProgress` はマーカーの有無そのもの。`startedAt` は `beginApply` が書いた
 * `started_at`(配線層のエラー文面「適用中(開始 <startedAt>)。少し待って再試行」用)。
 */
export type ApplyStatus = { inProgress: boolean; startedAt?: string };

/**
 * アプリが apply の途中(危険窓)にあるかを**読み取りのみ**で判定する(V1-M9-T02)。
 *
 * `.st-applying.json` マーカーの有無を返すだけで、**`recover` は呼ばず、マーカーの
 * 書き換え・削除もしない**。マーカーはライブ apply の危険窓
 * (`takeSnapshot`〜`appendChangelog`)を過不足なく括るので、配線層(HTTP/MCP の全書込入口・
 * ワークフロースケジューラ)は書込前にこれを見て「適用中なら失敗して譲る」判断ができる。
 *
 * マーカーが壊れて JSON として読めなくても、**「apply の窓に居る」ことは確か**なので
 * `inProgress:true` を返す(`startedAt` は付けない)。ファイル不在なら `inProgress:false`。
 * `recover` と違って壊れたマーカーで例外にしないのは、これが「書込を止める安全弁」であり、
 * 判定不能を「進行中(=書込を止める)」の安全側に倒すのが正しいからである。
 */
export function isApplyInProgress(dataRoot: string, appId: string): ApplyStatus {
  const path = markerPath(dataRoot, appId);
  if (!existsSync(path)) {
    return { inProgress: false };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { started_at?: unknown };
    if (typeof parsed.started_at === "string") {
      return { inProgress: true, startedAt: parsed.started_at };
    }
  } catch {
    // 壊れていても窓に居ることは確か。startedAt なしで進行中を返す(安全側)。
  }
  return { inProgress: true };
}

/**
 * 未完了の適用を検出し、必要なら適用前状態へ巻き戻す(起動時の整合性チェック)。
 *
 * @param dataRoot データルート(`data/` 相当)。
 * @param appId 指定するとそのアプリだけを見る。省略すると全アプリを走査する。
 * @throws 巻き戻しそのものに失敗した場合。**マーカーは残るので、次回も再試行される。**
 */
export function recover(dataRoot: string, appId?: string): RecoveryOutcome[] {
  const targets = appId === undefined ? listAppIds(dataRoot) : [appId];
  return targets.map((id) => recoverOne(dataRoot, id));
}

/** データルート配下のアプリIDを列挙する(ディレクトリ名がそのまま app_id)。 */
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

function recoverOne(dataRoot: string, appId: string): RecoveryOutcome {
  const marker = readMarker(dataRoot, appId);
  if (marker === undefined) {
    // **正常時の経路。ここでファイルを1つも開かず、DB にも接続しない。**
    return { app_id: appId, status: "clean" };
  }
  const diffId = marker.diff_id;

  // 1. 適用は確定していたか。**changelog が唯一の commit 点である。**
  if (hasChangelogEntry(dataRoot, appId, diffId)) {
    endApply(dataRoot, appId);
    return { app_id: appId, status: "committed", diff_id: diffId };
  }

  // 2. 戻せるスナップショットがあるか。
  const snapshot = findSnapshot(dataRoot, appId, diffId);
  if (snapshot === undefined) {
    // スナップショットが完成していない = `takeSnapshot` の途中かその手前で死んだ。
    // `applyDiff` は takeSnapshot 完了まで本体を1バイトも触らないので、
    // 本体は適用前のままである。**戻すものが無い。**
    endApply(dataRoot, appId);
    return { app_id: appId, status: "no_changes", diff_id: diffId };
  }

  // 3. 巻き戻す。失敗したら endApply を呼ばずに投げる(次回も再試行される)。
  restoreSnapshot(dataRoot, appId, snapshot);
  // 中断した一時マニフェストを残さない。`applyManifest` は rename 前に
  // `manifest.json.tmp` を作るので、DDL 中に死ぬとこれが残る。
  rmSync(`${appManifestPath(dataRoot, appId)}.tmp`, { force: true });
  endApply(dataRoot, appId);
  return { app_id: appId, status: "rolled_back", diff_id: diffId, snapshot };
}

/** マーカーを読む。壊れていたら「未完了の適用が居る」ことだけは確かなので例外にする。 */
function readMarker(dataRoot: string, appId: string): { diff_id: string } | undefined {
  const path = markerPath(dataRoot, appId);
  if (!existsSync(path)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch (cause) {
    throw new Error(
      `アプリ "${appId}" の適用中マーカー ${path} が JSON として壊れています。` +
        `未完了の適用が残っている可能性があるため、自動では処理しません。` +
        `snapshots/ の内容と _changelog を確認してから手動で対処してください。`,
      { cause },
    );
  }
  const diffId = (parsed as { diff_id?: unknown }).diff_id;
  if (typeof diffId !== "string" || diffId === "") {
    throw new Error(
      `アプリ "${appId}" の適用中マーカー ${path} に diff_id がありません。` +
        `未完了の適用が残っている可能性があるため、自動では処理しません。`,
    );
  }
  return { diff_id: diffId };
}

/** changelog に当該 diff_id のエントリがあるか(= 適用が確定していたか)。 */
function hasChangelogEntry(dataRoot: string, appId: string, diffId: string): boolean {
  const store = KernelMetaStore.open(dataRoot);
  try {
    return store.listChangelog(appId).some((entry) => entry.diff_id === diffId);
  } finally {
    store.close();
  }
}

/**
 * 当該 diff_id のスナップショットのうち、**完全なもの**で最も新しいものを返す。
 *
 * 完全性を実ファイルの有無で確かめるのは、**半端なスナップショットへ復元すると
 * 壊れた状態を「復旧した」と称することになる**からである。同じ diff_id で
 * 複数回試行した場合(前回が (a) で死んだ場合など)に備えて最大連番を採る。
 */
function findSnapshot(dataRoot: string, appId: string, diffId: string): string | undefined {
  const candidates = listSnapshots(dataRoot, appId)
    .filter((name) => name.slice(SNAPSHOT_PREFIX_LENGTH) === diffId)
    .filter((name) => {
      const dir = snapshotDir(dataRoot, appId, name);
      return existsSync(join(dir, "manifest.json")) && existsSync(join(dir, "app.sqlite"));
    });
  return candidates.at(-1);
}
