/**
 * アプリの完全削除(V1-M9-T09。ADR-0031)。
 *
 * ADR-0002 Consequences「削除APIの必要性」への回答である。ADR-0002 は
 * 「`data/apps/<app_id>/` のディレクトリ削除」と「`kernel.sqlite` の台帳行・changelog 行の
 * 削除」を**まとめて行う専用の削除 API(カーネル内部API)を別タスクとして切り出す」と書いた
 * まま、v0/v1 のどの計画にも起票されなかった。本モジュールがそれを受ける。
 *
 * ## 削除の単位と対象(ゲート §4-1)
 *
 * 単位は**アプリ1個の完全削除**。次を1回の呼び出しでまとめて消す:
 * 1. `data/apps/<app_id>/` ディレクトリ全体(manifest.json / app.sqlite / snapshots/ /
 *    app.sqlite 内の `_auth_*` 認証状態 / `.st-applying.json`)。
 * 2. `kernel.sqlite` の `apps` 台帳行(これを消さないと `_apps` 画面に残る。ADR-0006)。
 * 3. `kernel.sqlite` の当該 app_id の `changelog` 行(FK があるので台帳より先に消す)。
 * 4. `snapshots/` は #1 に含まれるが、**削除経路は T04 の `deleteAppSnapshots` を共有する**
 *    (削除経路を2箇所に作らない。ADR-0030 / ゲート §7)。
 * 5. `kernel.sqlite` 内の**アプリ横断テーブル**(ai_* / connections / outbox /
 *    connection_requests / escape_hatch_*)の当該 app_id 行。ADR-0002 は当時の2テーブル(台帳/changelog)
 *    しか知らないが、同じ「消したつもりで残る」非対称が M4/M5 のテーブルにも及ぶ。
 *    **未送信 outbox を消すトレードオフ**は ADR-0031 に明記した。
 *
 * ## 削除対象の集合を1箇所に固定する(ゲート §4-1 #5)
 *
 * `APP_SCOPED_KERNEL_TABLES` が「`kernel.sqlite` 内で `app_id` 列を持ち、アプリに紐づく
 * 全テーブル(`apps` 自身を除く)」の**単一ソース**である。テーブルが増えるたびに削除漏れが
 * 起きないよう、`_auth_*` と同じ「単一ソース」の作法を採る。ここに1行足すだけで削除対象に入る。
 *
 * ## 原子性は取れない(ゲート §4-2)
 *
 * ファイルシステム操作(#1)と `kernel.sqlite`(#2/#3/#5)は1つのトランザクションに入らない
 * (ADR-0005:77 が applyDiff について記述した非原子性と同型の構造制約)。したがって
 * **「防ぐ」ではなく「順序で不整合を最小化し、残る窓を統一形式のエラーで報告する」**を採る:
 *
 * 1. 前段: `getApp` が undefined なら「存在しない app_id」で拒否。`.st-applying.json` が
 *    在れば「適用中」で拒否(apply 進行中の削除は競合)。**どちらも状態を1バイトも変えない。**
 * 2. `kernel.sqlite` を**1トランザクション**で: changelog(FK 子)→ 横断テーブル → `apps`。
 *    kernel 側の #2/#3/#5 はここで原子的(単一 DB・単一 tx)。
 * 3. その後に `deleteAppSnapshots`(T04)→ ディレクトリ全体を `rmSync`。
 *
 * **残る窓(窓A: 台帳消し済み・ディレクトリ残り)**は統一形式エラーで返し、hint に
 * 「台帳は削除したがディレクトリ削除に失敗。`data/apps/<app_id>/` が残っている」を明記する。
 * **台帳を先に消す順序**を選ぶのは、逆順にすると失敗時に「実体が無いのに台帳行が残る」=
 * ADR-0002 が問題視した非対称・`_apps` に幽霊が出る状態を作るからである。失敗時に残すのは
 * UI に出ない側(ディレクトリ孤児)にする。`create_app` は既にこの孤児ディレクトリを検出して
 * 同じ app_id の再作成を拒否する(`create-app.ts` の `resolveExplicitAppId`)。
 *
 * ## やらないこと(ゲート §8 末尾)
 *
 * 論理削除(`archived` 転用)・`deleted` ステータス・単一スナップショット削除・世代刈り取り
 * (T04 が v2 送り)は**足さない**。本モジュールは実体を消す全消しだけを提供する。
 */
import { rmSync } from "node:fs";
import type { ValidationError } from "./errors.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { isApplyInProgress } from "./recovery.ts";
import { deleteAppBlobs, deleteAppSnapshots } from "./snapshot-orphans.ts";
import { appDir } from "./storage-paths.ts";

/**
 * `kernel.sqlite` 内で `app_id` 列を持ち、アプリに紐づくテーブルの**単一ソース**。
 * `apps` 自身はここに含めない(主キーが app_id で、FK の親なので**最後に**消す)。
 * 並びは「FK 子(changelog)を先頭に」しているが、`deleteApp` は `apps` を必ず最後に
 * 消すので、この配列内の順序は FK 制約に対して無関係である(全要素が `apps` より先)。
 *
 * **新しいアプリ横断テーブルを足したら、ここに1行足すこと。** 足さないと、アプリを削除
 * しても新テーブルの行だけが残る「消したつもりで残る」非対称が再来する(ゲート §4-1 #5)。
 */
export const APP_SCOPED_KERNEL_TABLES = [
  "changelog",
  "ai_capabilities",
  "ai_jobs",
  "ai_usage",
  "ai_requests",
  "connections",
  "outbox",
  "connection_requests",
  // V3-M5-T01(ADR-0055 限定4)。逃げ道(任意 CSS)の資産と申請。**3件目の孤児を作らない**
  // ため、テーブルを足すのと同じコミットでここに載せる(T01 完了条件7)。本体(CSS の
  // バイト列)は `apps/<app_id>/escape-hatch/` に在り、`deleteApp` のディレクトリ削除が
  // 追従するので、ここに要るのは kernel.sqlite 側の2テーブルだけである。
  "escape_hatch_assets",
  "escape_hatch_asset_requests",
  // V5-M2-T01(R-G14。門A本審査 `docs/plan/v5/records/v5-m0.md` §2-14 = 門外)。**この2本は
  // ADR-0041(V2-M5)がテーブルを足したときに、ここへ足されなかった。** 未解決審査単位
  // `V3-M12-G1` と同じものであり、`src/kernel/delete-app.test.ts` が `test.skip` で「是正後に
  // あるべき姿」を書き残していた。**足したのは今後の `deleteApp` にしか効かない** ——
  // 既に取り残されている行は、この2要素では消えない。
  "inbound_endpoints",
  "inbound_endpoint_requests",
  // V10-M10-T01(ADR-0366 CM-G3。門A本審査 `docs/plan/v10/records/v10-m9.md` = 限定採用)。
  // コメントの器(`gp_comments`)。**テーブルを足すのと同じコミットでここに載せる** ——
  // 載せ忘れると「消したつもりで残る」非対称が4件目として増える。
  // **帰結を隠さない**: **アプリを削除すると、そのアプリ宛てに利用者が書き残した意見は
  // 1件も残らずに失われる。** `undo` では巻き戻らないが、`delete_app` では消える。
  "gp_comments",
] as const;

/**
 * `deleteApp` の結果。失敗形は `ValidationResult` と同一の統一形式(`ValidationError[]`)。
 * `valid: false` でも**部分的に状態が変わっている場合がある**(窓A: 台帳は消えたが
 * ディレクトリ削除に失敗)。その旨は `errors[0].hint` に明記される。
 */
export type DeleteAppResult =
  | { valid: true; app_id: string; name: string }
  | { valid: false; errors: ValidationError[] };

/** ディレクトリ削除の差し替え口(部分失敗の注入テスト用)。既定は `rmSync` の再帰削除。 */
export type DeleteAppOptions = {
  /**
   * `appDir(dataRoot, appId)` を消す関数。既定は `rmSync(dir, { recursive, force })`。
   * テストが「ディレクトリ削除だけが失敗する」構造的な窓A を注入するための seam。
   */
  removeDir?: (dir: string) => void;
};

/** 既定のディレクトリ削除(冪等: `force` で不在でも例外にしない)。 */
function defaultRemoveDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** 「存在しない app_id」の統一形式エラー。allowed_values に実在する app_id を添える。 */
function appNotFoundError(appId: string, existing: string[]): ValidationError {
  return {
    path: "/app_id",
    message: `アプリ "${appId}" は存在しません。`,
    allowed_values: existing,
    hint: "list_apps で実在するアプリの一覧を取得できます(既に削除済みの可能性もあります)。",
  };
}

/** 「適用中(apply 窓)なので削除できない」の統一形式エラー。 */
function applyInProgressDeleteError(startedAt: string | undefined): ValidationError {
  const suffix = startedAt !== undefined ? `(開始 ${startedAt})` : "";
  return {
    path: "",
    message: `このアプリは現在変更を適用中です${suffix}。適用中のアプリは削除できません。`,
    hint: "変更の適用(apply_diff)が完了するまで待ってから、もう一度削除してください。適用中に削除すると、適用処理が書き込もうとしている先を消す競合になります。",
  };
}

/**
 * 部分失敗(窓A: 台帳は消したがディレクトリ削除に失敗)の統一形式エラー。
 * **黙って半端にしない**(憲法6)—— どこまで消え、何が残っているかを hint に明記する。
 */
function directoryRemovalFailedError(appId: string, cause: unknown): ValidationError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return {
    path: "",
    message: `アプリ "${appId}" の台帳・履歴は削除しましたが、ファイルの削除に失敗しました(${detail})。`,
    hint:
      `台帳(kernel.sqlite の apps / changelog / 横断テーブルの行)は削除済みですが、` +
      `実体ディレクトリ data/apps/${appId}/ が残っています。手動でこのディレクトリを削除してください。` +
      `台帳からは消えているので _apps 一覧には現れません(残っているのはディスク上の孤児ディレクトリで、` +
      `同じ app_id で create_app するとこの孤児を検出して拒否されます)。`,
  };
}

/**
 * アプリを完全削除する(ADR-0031)。
 *
 * @param dataRoot データルート(`data/` 相当)。環境変数に依存させず必ず引数で受ける。
 * @param appId 削除対象のアプリID。
 * @param options ディレクトリ削除の差し替え口(部分失敗の注入テスト用)。
 * @returns 統一形式の結果。失敗は `ValidationError[]` で返す(例外にしない)。
 */
export function deleteApp(
  dataRoot: string,
  appId: string,
  options: DeleteAppOptions = {},
): DeleteAppResult {
  const removeDir = options.removeDir ?? defaultRemoveDir;

  // --- 1. 前段の実在確認と apply 窓ガード(状態を1バイトも変えない) ---
  const store = KernelMetaStore.open(dataRoot);
  let name: string;
  try {
    const app = store.getApp(appId);
    if (app === undefined) {
      return {
        valid: false,
        errors: [
          appNotFoundError(
            appId,
            store.listApps().map((a) => a.app_id),
          ),
        ],
      };
    }
    name = app.name;

    // apply 進行中の削除は、apply がスナップショット復元 / changelog 追記を試みる先を
    // 消す競合になる(V1-M9-T02 / ADR-0017 が置いた窓ガードを流用)。
    const applying = isApplyInProgress(dataRoot, appId);
    if (applying.inProgress) {
      return { valid: false, errors: [applyInProgressDeleteError(applying.startedAt)] };
    }

    // --- 2. kernel.sqlite を1トランザクションで消す(#2/#3/#5) ---
    // changelog(FK 子)→ 横断テーブル → apps(FK 親・最後)。単一 DB・単一 tx なので
    // kernel 側は原子的。ここまでで失敗しても FS はまだ触っていない。
    store.deleteApp(appId, APP_SCOPED_KERNEL_TABLES);
  } finally {
    store.close();
  }

  // --- 3. スナップショット・blob(T04 のプリミティブ)→ ディレクトリ全体 ---
  // `deleteAppSnapshots` / `deleteAppBlobs` は冪等(`force`)なので、この後の `removeDir` が
  // snapshots / blobs ごと消しても二重削除で壊れない(削除経路を1本に集約する。ゲート §7 /
  // ADR-0035 §3 限定7 の全消しプリミティブ)。
  deleteAppSnapshots(dataRoot, appId);
  deleteAppBlobs(dataRoot, appId);
  try {
    removeDir(appDir(dataRoot, appId));
  } catch (cause) {
    // 窓A。台帳は既に消えている(順序の選択理由は本ファイル冒頭)。統一形式で報告する。
    return { valid: false, errors: [directoryRemovalFailedError(appId, cause)] };
  }

  return { valid: true, app_id: appId, name };
}
