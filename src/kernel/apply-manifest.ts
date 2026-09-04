/**
 * 初期マニフェスト投入・差し替えAPI `apply_manifest`(V0-P2-T06)。
 *
 * 完全なマニフェストをアプリに投入するカーネル内部API。空アプリへの**初期投入**と、
 * 稼働中アプリへの **additive な差し替え**の両方をこの1本で扱う。
 * Phase 4 の `apply_diff`(差分パッチ+intent+changelog+スナップショット)とは別の、
 * 開発・検証用の投入経路である(計画書 V0-P2-T06)。CP-2/CP-3 のシナリオと
 * V0-P3-T07 の「マニフェスト差し替え」はこの API を使う。
 *
 * ## 処理順序(計画書の明示要求)
 *
 * 1. **バリデーション**(`validateManifestFull`: JSON Schema 構造 → 参照整合性)
 * 2. **app.id が対象アプリと一致するかの検証**
 * 3. **現行マニフェストとの差が additive であることの検証**(`planMigration`)
 * 4. **DDL 適用**(`applyMigrationPlan`)
 * 5. 新しいマニフェストを `data/apps/<app_id>/manifest.json` に永続化
 *
 * ## 「拒否時は状態を一切変えない」の担保
 *
 * 1〜3 はすべて純粋な検査であり、DBもファイルも触らない。DDL の実行(4)は
 * 検査が全部通ってから初めて開始されるので、拒否された呼び出しでは
 * `CREATE TABLE` / `ADD COLUMN` が1文も発行されず、`manifest.json` も書き換わらない。
 * 追加と破壊的変更が混在する差し替えでも、`planMigration` が計画の導出時点で
 * 失敗するため「追加分だけ適用されてしまう」状態にはならない。
 *
 * ## 4 と 5 のあいだの中断について
 *
 * DDL 適用(SQLite)とマニフェスト書き込み(ファイルシステム)は同一トランザクションに
 * 入れられない。そこで書き込みは「一時ファイルへ書く → DDL 適用 → rename」の順にし、
 * 権限不足やディスク不足のような書き込み失敗を DDL の**前**に起こるようにしている。
 * rename はほぼ原子的なので、実質的な危険域は rename 呼び出しの一瞬だけになる。
 * これ以上の保証(スナップショットからの復旧)は apply_diff 側の責務(憲法4)。
 *
 * ## エラー方針
 *
 * マニフェストの不正・非additive な差し替えは、LLM がマニフェストを直せば解決する
 * 種類の失敗なので統一形式(`ValidationError[]`)で返す。一方、現行 `manifest.json` の
 * 欠損・破損や I/O 失敗はカーネル/環境側の異常なので例外にする。
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { ValidationError } from "./errors.ts";
import { applyMigrationPlan, type MigrationPlan, planMigration } from "./migrate.ts";
import { appDbPath, appManifestPath } from "./storage-paths.ts";
import type { Manifest, Operation } from "./types.ts";
import { validateManifestFull } from "./validate.ts";

/**
 * `applyManifest` の結果。
 *
 * 失敗形は `ValidationResult` と同一(`{ valid: false; errors }`)であり、
 * 成功時にのみ呼び出し側が必要とする情報を足している。
 * `ValidationResult` を期待するコードにそのまま渡せる(構造的部分型)。
 */
export type ApplyManifestResult =
  | {
      valid: true;
      /** 適用され、`manifest.json` に永続化されたマニフェスト。 */
      manifest: Manifest;
      /**
       * 実際に適用した additive マイグレーションの内容。
       * 初期投入では全テーブルが `add_tables` に載る。差分が無い再投入では両方空になる。
       */
      plan: MigrationPlan;
    }
  | { valid: false; errors: ValidationError[] };

/**
 * アプリの現行マニフェスト(`data/apps/<app_id>/manifest.json`)を読んで返す。
 *
 * **検証の目的は `"stored"` である**(V1-M2-T05e)。ここが読むのは**既にディスクに
 * 書かれているもの**であって、これから受理する入力ではない。**書かれた当時は検証を
 * 通っていたマニフェストを、後から足した制約で読めなくしない。**
 * (undo でそういう状態が live に戻りうる。`undo.ts` の `readSnapshotManifest` と対。)
 * **緩むのは読み取りだけである** —— 下の `applyManifest` は既定の `"incoming"` で
 * 検証するので、**この経路から不正なマニフェストが新たに書き込まれることはない。**
 * 何を外すかは `validate.ts` の `INPUT_ONLY_SCHEMA_PATHS` が一覧で持つ。
 *
 * @throws ファイルが存在しない / JSON として壊れている / マニフェストの形をしていない場合。
 *         いずれも「LLMがマニフェストを直せば解決する」種類の失敗ではないため例外にする。
 */
export function readCurrentManifest(dataRoot: string, appId: string): Manifest {
  const path = appManifestPath(dataRoot, appId);

  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (cause) {
    throw new Error(
      `アプリ "${appId}" の manifest.json を読めませんでした: ${path}。` +
        `アプリが存在しないか、ファイルが削除されている可能性があります。`,
      { cause },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Error(
      `アプリ "${appId}" の manifest.json が JSON として壊れています: ${path}。` +
        `スナップショットからの復元を検討してください。`,
      { cause },
    );
  }

  const result = validateManifestFull(parsed, "stored");
  if (!result.valid) {
    throw new Error(
      `アプリ "${appId}" の manifest.json がマニフェストとして不正です: ${path}。\n` +
        formatErrorsForThrow(result.errors),
    );
  }
  return parsed as Manifest;
}

/**
 * 完全なマニフェストをアプリに投入する(初期投入 / additive な差し替え)。
 *
 * 拒否された場合、`app.sqlite` のスキーマも `manifest.json` も変化しない。
 *
 * @param dataRoot データルート(`data/` 相当)。環境変数に依存させず必ず引数で受ける。
 * @param appId 対象アプリのID。`next.app.id` がこれと一致しなければ拒否する。
 * @param next 投入するマニフェスト。未検証の入力(`unknown`)を受け付ける。
 * @throws 現行 manifest.json が読めない/壊れている場合、DDL 実行や書き込みに失敗した場合
 */
export function applyManifest(
  dataRoot: string,
  appId: string,
  next: unknown,
  /**
   * この差し替えを生んだ operations(V1-M1-T03)。
   *
   * **省略した場合の挙動は v0 から1バイトも変わらない** —— 差分が additive でなければ
   * 拒否される。渡した場合だけ、破壊的 op(ADR-0010 の4種)に対応する DDL と
   * データ変換が実行計画に載る。`apply_manifest` を素で破壊的にすることは審査を
   * 受けていないので(ADR-0010 限定1)、**既定は今までどおり additive のみ**である。
   */
  operations?: readonly Operation[],
): ApplyManifestResult {
  // 1. 構造 + 参照整合性。
  const validated = validateManifestFull(next);
  if (!validated.valid) {
    return { valid: false, errors: validated.errors };
  }
  const nextManifest = next as Manifest;

  // 2. 対象アプリとの同一性。ディレクトリ名(app_id)が正であり、
  //    マニフェスト側の app.id を書き換えて別アプリに化けさせることは許さない。
  if (nextManifest.app.id !== appId) {
    return {
      valid: false,
      errors: [
        {
          path: "/app/id",
          message:
            `マニフェストの app.id が "${nextManifest.app.id}" ですが、投入先のアプリは "${appId}" です。` +
            `app.id はアプリの同一性そのものなので、別アプリのマニフェストを投入することはできません。`,
          hint: `app.id を "${appId}" にしてください。`,
        },
      ],
    };
  }

  const current = readCurrentManifest(dataRoot, appId);

  // 3. 差分が additive か。ここで失敗しても DDL は1文も発行されていない。
  const planned = planMigration(current, nextManifest, operations);
  if (!planned.valid) {
    return { valid: false, errors: planned.errors };
  }

  // 4-5. 書き込み先の一時ファイルを先に用意(I/O失敗を DDL より前に出す)→ DDL → rename。
  const manifestPath = appManifestPath(dataRoot, appId);
  const tempPath = `${manifestPath}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(nextManifest, null, 2)}\n`, "utf-8");
  try {
    // create: false … app.sqlite が無ければ黙って新規作成せずエラーにする
    // (create_app を通っていないアプリに投入しようとしている、ということなので)。
    const db = new Database(appDbPath(dataRoot, appId), { readwrite: true, create: false });
    try {
      applyMigrationPlan(db, planned.plan);
    } finally {
      db.close();
    }
  } catch (error) {
    // DDL が失敗したら一時ファイルを残さない(applyMigrationPlan は
    // 1トランザクションなのでスキーマは適用前のまま)。
    if (existsSync(tempPath)) {
      unlinkSync(tempPath);
    }
    throw error;
  }
  renameSync(tempPath, manifestPath);

  return { valid: true, manifest: nextManifest, plan: planned.plan };
}

/** 例外メッセージに埋め込むためのエラー整形(1件1行)。 */
function formatErrorsForThrow(errors: ValidationError[]): string {
  return errors.map((e) => `  ${e.path === "" ? "/" : e.path}: ${e.message}`).join("\n");
}
