/**
 * スナップショット機構(V0-P4-T01)。
 *
 * 憲法4「常に戻せる。applyの前に必ずスナップショット」を成立させる最小の機構。
 * ADR-0002 のレイアウトどおり、apply 直前の `manifest.json` と `app.sqlite` を
 * `<dataRoot>/apps/<app_id>/snapshots/<連番>-<diff_id>/` に1組で保存し、
 * undo はその2ファイルをアプリ直下へ戻すだけで完結する。
 *
 * ## 連番
 *
 * 4桁ゼロ埋め・アプリごとに1から採番する。先頭に連番を置くことで
 * ディレクトリ名の文字列ソート順がそのまま時系列順になる(ADR-0002 §3)。
 * 次の番号は既存ディレクトリ名から求めるので、カーネル側に採番用の状態を持たない。
 *
 * ## SQLite の整合性(ADR-0002 の申し送りへの回答)
 *
 * ADR-0002 は「コピー前に `wal_checkpoint(TRUNCATE)` を強制する」か
 * 「`journal_mode = DELETE` を使う」かの選択を実装タスクに申し送っていた。
 * 実装時点のコードを確認した事実は以下:
 *
 * - `create-app.ts` は app.sqlite 作成時に `PRAGMA journal_mode = DELETE` を設定している
 * - `bun:sqlite` の既定の journal_mode も `delete` であり、WAL 以外の journal_mode は
 *   ファイルに永続化されない(接続ごとの設定)ため、app.sqlite を開き直した接続も
 *   `delete` になる。app.sqlite に WAL を設定しているコードはカーネル内に存在しない
 *   (`meta-store.ts` が WAL にしているのは kernel.sqlite であって app.sqlite ではない)
 *
 * よって**通常運用では `-wal` は存在しない**。しかしそれだけを前提に「app.sqlite を
 * ファイルコピーするだけ」にはしない。理由は2つある。
 *
 * 1. `journal_mode` は接続ごとの設定なので、将来カーネル外の接続(検証スクリプト、
 *    別プロセスのツール)が WAL に切り替えると、単純コピーは黙って直近の
 *    コミットを取りこぼす。壊れ方が「静かに古いスナップショットができる」なので危険。
 * 2. rollback journal(DELETE)モードでも、他接続が書き込みトランザクションを開いている
 *    最中は本体ファイルが書き換わり `-journal` にロールバック情報がある状態になりうる。
 *    この瞬間に本体ファイルだけをコピーすると不整合なコピーになる。
 *
 * そこで本実装は、
 *
 * - コピー前に **`PRAGMA wal_checkpoint(TRUNCATE)` を防御的に実行**する
 *   (DELETE モードでは何もしない無害な操作であることを確認済み)、かつ
 * - コピー自体を **SQLite の `VACUUM INTO`(= バックアップAPI相当の整合コピー)** で行う
 *
 * という二段構えにする。`VACUUM INTO` は読み取りトランザクションの中でコピー先を
 * 作るため、WAL の内容も、他接続の未コミット変更の除外も、SQLite 自身が保証する。
 * 計画書 V0-P4-T01 が挙げる「WALチェックポイント or バックアップAPI経由」の
 * 両方を満たす形になっている。
 *
 * ## ロック競合(V1-M0-T14)
 *
 * `VACUUM INTO` はコピー元に読み取りロックを要る。他接続が書き込み中でも、
 * rollback journal モードで RESERVED どまりなら読み取りは通る。しかし
 * **cache spill**(書き手のページキャッシュが溢れ、未コミットのページを本体ファイルへ
 * 書き出す必要が生じた状態)が起きると、書き手は RESERVED から **EXCLUSIVE へ昇格し、
 * トランザクション終了までそれを手放さない**。この間はコピーどころか `SELECT` も通らない。
 *
 * SQLite の既定の `busy_timeout` は **0**、つまり競合したら待たずに即 `SQLITE_BUSY` である。
 * スナップショットは apply の直前に取るものなので、他接続が一瞬ロックを握っていただけで
 * 落ちるのは弱すぎる。よってコピー用の接続には `busy_timeout` を明示的に設定して待たせる。
 *
 * 待っても取れなかった場合は**失敗させる**。ここで握り潰して単純コピーに退避したりは
 * しない —— 壊れたスナップショットを黙って残すことは、undo が効かないのに効くと
 * 思っている状態を作ることであり、憲法4に正面から反する。取れなければ apply を
 * させない、が正しい振る舞いである。
 *
 * ## エラー方針
 *
 * ここで起きる失敗(存在しないアプリ、存在しないスナップショット、不正な diff_id、
 * I/O 失敗)は、いずれも LLM が差分パッチを直せば解決する種類のものではない。
 * `meta-store.ts` / `apply-manifest.ts` と同じく例外で失敗させ、
 * `ValidationResult` はマニフェスト/差分パッチの検証専用に保つ。
 *
 * ## 画像 blob を**コピーしない**のは設計であって漏れではない(V2-M2-T04 / ADR-0035 §4)
 *
 * スナップショットがコピーするのは `manifest.json` と `app.sqlite` の2ファイルだけで、
 * **`apps/<app_id>/blobs/` 配下の画像 blob 実体はコピーしない。これは意図的な不変条件である。**
 *
 * - blob 実体は content-addressed(ファイル名 = 内容の sha256)で**不変・共有**なので、
 *   スナップショットが増えるたびに実体を複製する理由が無い(複製すれば undo 世代に比例して
 *   `snapshots/` が肥大する —— これがユーザ決定が避けた当のもの。ADR-0035 §4「(snapshot)」)。
 * - **file_id → sha256 の対応(`_files` メタ)は `app.sqlite` 内の物理テーブル**なので、
 *   `app.sqlite` をコピーする本機構によって**スナップショットに自然に含まれる**。したがって
 *   undo(= `app.sqlite` を過去へ書き戻す。`restoreSnapshot`)で過去の `_files` が生き、
 *   blobs/ に実体が残っている限り画像は戻る。
 * - blob 実体が「残っている」ことは orphan blob 検出(`snapshot-orphans.ts` の `auditAppBlobs`)が
 *   守る —— **現行 + 全 snapshot の `_files` が参照する blob は刈らない**ので、undo の戻り先が
 *   参照する実体は削除されない(ADR-0035 §4「(orphan)」)。
 *
 * この非対称(snapshot は blob 非コピー / backup は blob コピー。`src/server/backup.ts`)は
 * ADR-0035 §4 の生命線であり、**将来のリファクタで「揃えるために」snapshot に blob を
 * コピーし始めてはならない**(肥大回避の目的を壊す)。
 */
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isValidResourceId, RESOURCE_ID_MAX_LENGTH } from "./resource-id.ts";
import { appDbPath, appManifestPath, appSnapshotsDir, snapshotDir } from "./storage-paths.ts";

/** スナップショットディレクトリ名の連番の桁数(4桁ゼロ埋め)。 */
const SEQUENCE_DIGITS = 4;

/** `<連番>-<diff_id>` を分解する。連番は4桁固定。 */
const SNAPSHOT_NAME_RE = /^(\d{4})-(.+)$/;

/** 取得したスナップショットの参照。 */
export type SnapshotRef = {
  /**
   * スナップショットのディレクトリ名(`<連番>-<diff_id>`)。
   * これがそのまま `ChangelogEntry.snapshot` に入る値になる。
   */
  name: string;
  /** 1から始まるアプリ内の連番。 */
  sequence: number;
  /** 元になった差分のID。 */
  diff_id: string;
  /** スナップショットディレクトリの絶対パス。 */
  dir: string;
};

/** スナップショット内のファイル名(アプリ直下と同じ名前で1組を保つ)。 */
const SNAPSHOT_MANIFEST = "manifest.json";
const SNAPSHOT_DB = "app.sqlite";

/**
 * コピー元 DB のロック待ち時間の既定値(ミリ秒)。
 *
 * SQLite の既定は 0(待たない)なので、明示的に上書きする。5秒にしたのは、
 * 「他接続の短い書き込みが終わるのを待つ」には十分で、かつ本当にロックが
 * 塞がっている場合に呼び出し側を長く止めすぎない範囲だからである。
 * これを超えて取れないのは、他接続が長いトランザクションを開きっぱなしという
 * 運用側の問題であり、待ち時間を延ばして隠すべきものではない。
 */
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/**
 * `takeSnapshot` の任意設定。
 *
 * **意図的に export していない。**V1-M0-T14 は当初これを `src/kernel/index.ts` から
 * 再エクスポートし、Δ8(`src/kernel/` の公開エクスポートが増える)= 門A として
 * 取り下げた。しかし取り下げたのは `index.ts` 側だけで、ここの `export` は残っていた。
 * ADR-0007 改訂2 が Δ8 の判定範囲を `index.ts` ではなく **`src/kernel/` 全体**と
 * 確定させたため、門A の審査にかけた結果 **却下**。参照は本ファイル内だけなので、
 * 公開面に出す理由が無い(`docs/plan/v1/records/v1-m0-gate-followup.md`)。
 */
type TakeSnapshotOptions = {
  /**
   * コピー元 DB のロックが空くのを待つ上限(ミリ秒)。既定は5秒。
   * 主にテストが待ち時間を明示的に縮めるためにある。
   */
  busyTimeoutMs?: number;
};

/**
 * アプリのスナップショットを時系列昇順で列挙する。
 *
 * 連番が4桁ゼロ埋めなので、名前の文字列ソートがそのまま時系列順になる。
 * `snapshots/` が無い(= まだ1度も取っていない)場合は空配列。
 */
export function listSnapshots(dataRoot: string, appId: string): string[] {
  const dir = appSnapshotsDir(dataRoot, appId);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SNAPSHOT_NAME_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** 既存のスナップショット名から次の連番を求める(アプリごとに1から)。 */
function nextSequence(dataRoot: string, appId: string): number {
  let max = 0;
  for (const name of listSnapshots(dataRoot, appId)) {
    const match = SNAPSHOT_NAME_RE.exec(name);
    const digits = match?.[1];
    if (digits === undefined) {
      continue;
    }
    max = Math.max(max, Number(digits));
  }
  return max + 1;
}

/**
 * apply 直前の状態(`manifest.json` + `app.sqlite`)をスナップショットとして保存する。
 *
 * 途中で失敗した場合は作りかけのスナップショットディレクトリを消してから投げ直す。
 * 半端なスナップショットが残ると「戻せるつもりで戻せない」状態になるため。
 *
 * @param dataRoot データルート(`data/` 相当)。環境変数に依存させず必ず引数で受ける。
 * @param appId 対象アプリのID。
 * @param diffId このスナップショットに対応する差分のID(リソースID規約に従うこと)。
 * @param options ロック待ち時間などの任意設定。
 * @throws diff_id が規約違反の場合、アプリの実体が無い場合、I/O に失敗した場合、
 *         他接続がロックを保持していて待っても整合コピーが取れなかった場合
 */
export function takeSnapshot(
  dataRoot: string,
  appId: string,
  diffId: string,
  options: TakeSnapshotOptions = {},
): SnapshotRef {
  if (!isValidResourceId(diffId)) {
    // ディレクトリ名の一部になるので、規約違反はここで必ず止める
    // (`../` のようなパス要素をディレクトリ名に混ぜさせない)。
    throw new Error(
      `diff_id "${diffId}" はリソースID規約に違反しています。` +
        `規約: 英小文字で始まり、使用可能文字は [a-z0-9_-]、長さは1〜${RESOURCE_ID_MAX_LENGTH}文字` +
        `(正規表現: ^[a-z][a-z0-9_-]*$)。`,
    );
  }

  const manifestPath = appManifestPath(dataRoot, appId);
  const dbPath = appDbPath(dataRoot, appId);
  if (!existsSync(manifestPath) || !existsSync(dbPath)) {
    throw new Error(
      `アプリ "${appId}" のスナップショットを取得できません。` +
        `${manifestPath} と ${dbPath} の両方が必要ですが、揃っていません。` +
        `アプリが存在しないか、ファイルが削除されている可能性があります。`,
    );
  }

  const sequence = nextSequence(dataRoot, appId);
  const name = `${String(sequence).padStart(SEQUENCE_DIGITS, "0")}-${diffId}`;
  const dir = snapshotDir(dataRoot, appId, name);
  if (existsSync(dir)) {
    // 連番は既存ディレクトリから採るので通常あり得ない(=カーネルのバグか外部からの介入)。
    throw new Error(`スナップショットディレクトリ ${dir} が既に存在します。`);
  }

  mkdirSync(dir, { recursive: true });
  try {
    copyFileSync(manifestPath, join(dir, SNAPSHOT_MANIFEST));
    copyDatabaseConsistently(dbPath, join(dir, SNAPSHOT_DB), busyTimeoutOf(options));
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }

  return { name, sequence, diff_id: diffId, dir };
}

/** オプションのロック待ち時間を検証して確定する。 */
function busyTimeoutOf(options: TakeSnapshotOptions): number {
  const value = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `busyTimeoutMs は0以上の有限な数値である必要があります(受け取った値: ${value})。`,
    );
  }
  return Math.trunc(value);
}

/**
 * SQLite ファイルを整合性を保ったままコピーする。
 *
 * ファイルの単純コピーではなく `VACUUM INTO` を使うのは、WAL の内容も、
 * 他接続の未コミット変更の除外も SQLite 自身に保証させるため(ファイル先頭コメント参照)。
 */
function copyDatabaseConsistently(
  sourcePath: string,
  destinationPath: string,
  busyTimeoutMs: number,
): void {
  // readwrite で開くのは、WAL だった場合にチェックポイントを打てるようにするため。
  const db = new Database(sourcePath, { readwrite: true, create: false });
  try {
    // ロックを取りにいく前に設定する。PRAGMA はプレースホルダを受け付けないので
    // 文字列に埋めるが、値は busyTimeoutOf で数値であることを検証済みである。
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
    checkpointIfWal(db);
    // ファイル名は値なのでプレースホルダでバインドする(文字列連結で埋めない)。
    db.query("VACUUM INTO ?").run(destinationPath);
  } catch (error) {
    throw describeCopyFailure(error, sourcePath, busyTimeoutMs);
  } finally {
    db.close();
  }
}

/**
 * コピー失敗を、呼び出し側が次に何をすべきか分かる形に言い換える。
 *
 * `SQLITE_BUSY` の素のメッセージは "database is locked" だけで、
 * 「誰が」「なぜ」握っているのかも、「どうすれば直るのか」も分からない。
 * スナップショットが取れないことは apply を止める理由になるので、
 * ここは丁寧に説明する価値がある。
 */
function describeCopyFailure(error: unknown, sourcePath: string, busyTimeoutMs: number): Error {
  const code = (error as { code?: unknown } | null)?.code;
  if (code !== "SQLITE_BUSY" && code !== "SQLITE_BUSY_SNAPSHOT") {
    return error instanceof Error ? error : new Error(String(error));
  }
  return new Error(
    `${sourcePath} のスナップショットを取得できません。` +
      `他の接続が書き込みロックを保持しており、${busyTimeoutMs}ms 待っても解放されませんでした。` +
      `別の接続が長い書き込みトランザクションを開いたままになっていないか確認してください。` +
      `整合性を保証できないコピーを残すことはしないため、スナップショットは作成されていません。`,
    { cause: error },
  );
}

/**
 * WAL モードだったときだけチェックポイントを強制する防御。
 *
 * 通常運用(journal_mode = DELETE)では何もしない。チェックポイントは
 * 他接続が書き込み中だと busy を返して打てないことがあるが、その場合でも
 * `VACUUM INTO` 側が整合コピーを保証するので、失敗はスナップショット取得を
 * 止める理由にならない(握り潰さずログにも出さないのは、v0 ではログ基盤が
 * まだ無く、ここで例外に変換するとかえって取得が失敗するため)。
 */
function checkpointIfWal(db: Database): void {
  const row = db.query("PRAGMA journal_mode").get() as { journal_mode: string } | null;
  if (row === null || row.journal_mode.toLowerCase() !== "wal") {
    return;
  }
  try {
    db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
  } catch {
    // busy 等で打てなくても VACUUM INTO の整合性は損なわれない。
  }
}

/**
 * スナップショットの2ファイルをアプリ直下へ復元する(undo の実体)。
 *
 * @param dataRoot データルート(`data/` 相当)。
 * @param appId 対象アプリのID。
 * @param snapshotName `takeSnapshot` が返したディレクトリ名(`<連番>-<diff_id>`)。
 * @throws 指定のスナップショットが無い/壊れている場合、I/O に失敗した場合
 */
export function restoreSnapshot(dataRoot: string, appId: string, snapshotName: string): void {
  const dir = snapshotDir(dataRoot, appId, snapshotName);
  const sourceManifest = join(dir, SNAPSHOT_MANIFEST);
  const sourceDb = join(dir, SNAPSHOT_DB);
  if (!existsSync(sourceManifest) || !existsSync(sourceDb)) {
    const available = listSnapshots(dataRoot, appId);
    throw new Error(
      `アプリ "${appId}" にスナップショット "${snapshotName}" が見つかりません(${dir})。` +
        (available.length === 0
          ? "このアプリにはスナップショットがまだ1つもありません。"
          : `利用可能なスナップショット: ${available.join(" / ")}`),
    );
  }

  const dbPath = appDbPath(dataRoot, appId);

  // 復元の前後で sidecar(-wal / -shm / -journal)を消す。
  // これらは復元前の app.sqlite に属する状態であり、残したまま本体だけ差し替えると
  // 次に開いた接続がそれらを本体に適用して、復元したはずの状態を壊す。
  // 「前」だけでは、削除〜コピーの隙に生きた接続が作り直す可能性があるので後にも消す。
  removeSidecars(dbPath);
  copyFileSync(sourceDb, dbPath);
  copyFileSync(sourceManifest, appManifestPath(dataRoot, appId));
  removeSidecars(dbPath);
}

/** SQLite が本体ファイルの隣に置く一時ファイルを消す。 */
function removeSidecars(dbPath: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
}
