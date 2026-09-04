/**
 * 実行時データの配置(ADR-0002: ストレージレイアウト)。
 *
 * ```
 * <dataRoot>/
 * ├── kernel.sqlite                 … アプリ台帳 + changelog
 * └── apps/<app_id>/
 *     ├── manifest.json             … 現行マニフェスト(正準)
 *     ├── app.sqlite                … ユーザデータ
 *     ├── blobs/<sha256>            … 画像ファイル実体(content-addressed。V2-M2/ADR-0035)
 *     └── snapshots/<連番>-<diff_id>/{manifest.json, app.sqlite}
 * ```
 *
 * データルート(既定の運用では リポジトリ直下の `data/`)は**必ず引数で受け取る**。
 * 環境変数やハードコードに依存させないのは、テストが一時ディレクトリを
 * データルートにして実データを汚さずに動かせるようにするため。
 */
import { basename, dirname, join } from "node:path";

/** カーネルのメタ情報(アプリ台帳・changelog)を格納する SQLite ファイル。 */
export function kernelDbPath(dataRoot: string): string {
  return join(dataRoot, "kernel.sqlite");
}

/** すべてのアプリのディレクトリを束ねる親ディレクトリ。 */
export function appsDir(dataRoot: string): string {
  return join(dataRoot, "apps");
}

/**
 * 1アプリのディレクトリ。マニフェスト・データ・スナップショットがすべてこの下に閉じるため、
 * アプリの完全削除はこのディレクトリの削除で済む(ADR-0002)。
 */
export function appDir(dataRoot: string, appId: string): string {
  return join(appsDir(dataRoot), appId);
}

/** 現行マニフェスト(正準)。SQLite内ではなくファイルに置くことでコピー=スナップショットが成立する。 */
export function appManifestPath(dataRoot: string, appId: string): string {
  return join(appDir(dataRoot, appId), "manifest.json");
}

/** ユーザデータの SQLite ファイル(1アプリ=1ファイル)。 */
export function appDbPath(dataRoot: string, appId: string): string {
  return join(appDir(dataRoot, appId), "app.sqlite");
}

/**
 * `appDbPath` の逆算(V1-M4-T03 / ADR-0020 §3)。
 *
 * `runAction` の `call_external` 分岐は、開いている `app.sqlite` のパス(`db.filename`)
 * だけを手がかりに、その app の `dataRoot` と `appId` を復元して kernel.sqlite の
 * capability ストアを開く。**この復元が失敗するなら送信させない(fail-closed)** ——
 * `:memory:` や想定外のパスで開かれた DB は、capability の所属アプリを決められないので
 * 例外にして呼び出し側で遮断する。
 *
 * 期待する構造は `appDbPath` と厳密に対称である:
 * `<dataRoot>/apps/<appId>/app.sqlite`(末尾 `app.sqlite`・その親が `<appId>`・
 * さらに親が `apps`・さらに親が `dataRoot`)。1段でもずれれば `throw`。
 */
export function parseAppDbPath(appDbFilename: string): { dataRoot: string; appId: string } {
  if (basename(appDbFilename) !== "app.sqlite") {
    throw new Error(
      `app DB のパスが "app.sqlite" で終わっていません: ${JSON.stringify(appDbFilename)}`,
    );
  }
  const appDirPath = dirname(appDbFilename); // <dataRoot>/apps/<appId>
  const appId = basename(appDirPath);
  const appsDirPath = dirname(appDirPath); // <dataRoot>/apps
  if (basename(appsDirPath) !== "apps") {
    throw new Error(
      `app DB のパスが <dataRoot>/apps/<appId>/app.sqlite の構造になっていません: ${JSON.stringify(appDbFilename)}`,
    );
  }
  const dataRoot = dirname(appsDirPath);
  if (appId === "" || appId === "." || appId === ".." || appId === "apps") {
    throw new Error(`app DB のパスから appId を取り出せません: ${JSON.stringify(appDbFilename)}`);
  }
  return { dataRoot, appId };
}

/**
 * 画像ファイル実体(blob)の置き場(V2-M2 / ADR-0035 §1・限定3・Δ8)。
 *
 * `apps/<appId>/blobs/<sha256>` に content-addressed で保存する。ファイル名が内容の
 * sha256 hex なので、同一内容は1実体に de-dup される。**スナップショットにはコピーしない**
 * (肥大回避)一方で **backup には含める**(災害復旧の完全性)—— この非対称は ADR-0035 §4 の
 * 不変条件であり、`appDir` の下に閉じることでアプリの完全削除(ディレクトリ削除)にも追従する。
 */
export function appBlobsDir(dataRoot: string, appId: string): string {
  return join(appDir(dataRoot, appId), "blobs");
}

/**
 * 逃げ道(任意 CSS)の資産の**本体**の置き場(V3-M5-T01 / ADR-0055 限定9・Δ8)。
 *
 * `apps/<appId>/escape-hatch/<sha256>` に content-addressed で保存する。ファイル名が内容の
 * sha256 hex なので、同一内容は1実体に de-dup され、**過去の版は上書き破壊されない**
 * (`appBlobsDir` と同じ性質)。**blobs とディレクトリを分けている**のは、`_files` の孤児検出
 * (`auditAppBlobs`)が逃げ道の実体を「参照の無い画像」と誤判定しないためである ——
 * 参照集合が別(マニフェストの `_files` 対 view のキー)なので、同じ籠に入れると
 * 一方の検出がもう一方を必ず誤って挙げる。
 *
 * `appDir` の下に閉じるので、アプリの完全削除(ディレクトリ削除)に追従する。
 * **失効(owner の DELETE)ではこの実体を消さない** —— 消すと過去のスナップショットが
 * 参照する版を復元できなくなる(ADR-0055 限定10: 孤児の自動刈り取りを入れない。検出のみ)。
 */
export function appEscapeHatchDir(dataRoot: string, appId: string): string {
  return join(appDir(dataRoot, appId), "escape-hatch");
}

/** スナップショット置き場。apply 前の manifest.json + app.sqlite をここへコピーする。 */
export function appSnapshotsDir(dataRoot: string, appId: string): string {
  return join(appDir(dataRoot, appId), "snapshots");
}

/**
 * 個々のスナップショットのディレクトリ。
 * `name` は `<連番>-<diff_id>` 形式(changelog の snapshot 参照と同じ文字列)。
 */
export function snapshotDir(dataRoot: string, appId: string, name: string): string {
  return join(appSnapshotsDir(dataRoot, appId), name);
}
