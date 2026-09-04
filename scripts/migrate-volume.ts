/**
 * 配布先のボリュームを、この Runner のイメージの版へ移行する器(`V5-M6-T02` = `R-G4` /
 * [`ADR-0252`](../docs/adr/0252-distribution-migrator.md))。
 *
 * ## 何を解くのか
 *
 * `ADR-0251`(`V5-M5`)が「版が合わなければ起動しない」を入れた。**止めるだけでは
 * 足りない** —— `D-V5-14` の逐語「**2は実行すべき移行コマンドを出して**」が出口を
 * 要求している。**ここがその出口の実体である。** `src/server/runner-version-gate.ts` が
 * 止めるときに出すコマンドは、このファイルを指す。
 *
 * ## 置き場と組み立て方(`ADR-0252` 限定1 / 限定2)
 *
 * **`src/kernel/` に export を1本も足さず、`src/kernel/` 配下に1ファイルも新設せず、
 * 既存 export だけで組み立てる。** 使うのは
 * `readCurrentManifest` / `foldOperations` / `planMigration` / `applyMigrationPlan` /
 * `checkFieldConversions` / `takeSnapshot` / `restoreSnapshot` / `KernelMetaStore` と
 * storage-paths 一式である。
 *
 * **`checkUniqueBackfills` だけは非 export なので再実装した**(限定3)——
 * 下の `checkUniqueBackfillsForMigration`。**再実装であることをそこに明記し、
 * 本体と食い違ったら赤くなる検査を `migrate-volume.test.ts` に置いてある。**
 *
 * ## Runner に同梱しない(`ADR-0252` 限定4 / `D-V5-12` の (3))
 *
 * **このファイルは配布物のイメージに1本も入らない。** **その検査は `V5-M7` が持つ**
 * (今日イメージが存在しないので、ここでは固定できない)。
 * **MCP の口を1本も持たない**(限定7)—— **AI はこの器を1バイトも呼ばない。**
 *
 * ## 版に順序が無いことの帰結(**正直に先に書く**)
 *
 * `ADR-0251` 限定3 / 限定4 は「版は整数1本」「照合は等値だけ」と定めており、
 * **「以上」「未満」を1つも作らない。** **したがってこの器も「古い版か」を判定しない**
 * —— **印が `RUNNER_BUILD_VERSION` と違うボリュームはすべて移行対象になる。**
 * **番号の大きい版から小さい版へ「戻す」ことも同じ経路で起きる。**
 * **それを止める手段をこの器は持たない。**
 *
 * ## 印の無いボリューム(`user_version = 0`)は救済しない(`ADR-0251` 限定6)
 *
 * **1本でも `user_version = 0` の DB があれば、ボリューム全体を1バイトも触らずに拒否する。**
 * 「印が無い DB を古いものとみなして移行する」は `ADR-0251` §6 の 3 が門A 送りにしている。
 * **今日ディスクにある DB 34本はすべてこれに当たる**(`v5-m5.md` §3-1)。
 *
 * ## 失敗したら巻き戻す(`ADR-0252` 限定8)
 *
 * アプリごとに `takeSnapshot` を先に取り、**1つでも失敗したら、この実行の中で
 * 成功済みのアプリも含めて全部 `restoreSnapshot` で戻す。**
 * **【`R-G13`。解決しない】`restoreSnapshot` は `app.sqlite` をファイルごと置換するので、
 * 巻き戻すと `_auth_users` / `_auth_sessions` も一緒に戻る**(`ADR-0014` §6)。
 * **`D-V5-93` により今回それを直さない。** **退避処理を1バイトも書いていない。**
 * **「巻き戻しは安全になった」とは書けない。**
 *
 * ## `kernel.sqlite` には巻き戻しが無い(**限界**)
 *
 * `takeSnapshot` / `restoreSnapshot` はアプリ単位の仕組みであり、`kernel.sqlite` を
 * 対象にできない。**この器は `kernel.sqlite` について、`KernelMetaStore.open` の遅延
 * `ALTER`(`migrateChangelogColumns`)を1回通してから印を書き換えるだけである。**
 * **そこが失敗したときに戻す手段を持たない。** 順序として**全アプリが成功した後**に
 * 置いているが、原子性ではない。
 *
 * ## 使い方
 *
 * ```
 * mise exec -- bun run scripts/migrate-volume.ts <ボリュームのdata> <イメージのdata>
 * ```
 *
 * **イメージ側の `apps/<app_id>/manifest.json` が移行先の定義である。**
 * 破壊的な移行(テーブル・フィールドの削除、型変更、`reference_table` の変更、
 * `select` の選択肢の削除、ビューの削除)を行うには、**同じディレクトリに
 * `migration-operations.json`(`operations` の配列)を置くこと** ——
 * `planMigration` は `operations` が無いと additive しか通さない(`ADR-0252` §2 の ②)。
 * **`operations` を畳み込んだ結果が `manifest.json` と一致しなければ拒否する。**
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { foldOperations } from "../src/kernel/apply-diff.ts";
import { readCurrentManifest } from "../src/kernel/apply-manifest.ts";
import { checkFieldConversions, UNCONVERTIBLE_SAMPLE_LIMIT } from "../src/kernel/convert.ts";
import { quoteIdentifier } from "../src/kernel/ddl.ts";
import type { ValidationError } from "../src/kernel/errors.ts";
import { KernelMetaStore } from "../src/kernel/meta-store.ts";
import { applyMigrationPlan, planMigration } from "../src/kernel/migrate.ts";
import { restoreSnapshot, takeSnapshot } from "../src/kernel/snapshot.ts";
import { appDbPath, appDir, appManifestPath, kernelDbPath } from "../src/kernel/storage-paths.ts";
import type { Manifest, Operation } from "../src/kernel/types.ts";
import { RUNNER_BUILD_VERSION } from "../src/shared/runner-build-version.ts";

/** イメージ側に置く「破壊的な移行の手順」のファイル名。 */
export const MIGRATION_OPERATIONS_FILENAME = "migration-operations.json";

/** 巻き戻し用スナップショットの `diff_id`(リソースID規約に従う)。 */
const MIGRATION_SNAPSHOT_DIFF_ID = `migrate-to-v${RUNNER_BUILD_VERSION}`;

/** 1アプリの移行結果。 */
export type AppMigrationOutcome = {
  app_id: string;
  /** 移行前の `PRAGMA user_version`。 */
  from_version: number;
  /**
   * - `already-current` … 印が既に一致していた(**1バイトも書いていない**)
   * - `migrated` … 移行して印を書き換えた
   * - `failed` … このアプリで失敗した(**書く前に落ちたか、巻き戻した**)
   * - `rolled-back` … このアプリ自身は成功したが、**同じ実行の別のアプリが失敗したので戻した**
   */
  status: "already-current" | "migrated" | "failed" | "rolled-back";
  /** 取ったスナップショットのディレクトリ名(`<連番>-<diff_id>`)。 */
  snapshot?: string;
  /** 検証で落ちた場合の統一形式エラー。 */
  errors?: ValidationError[];
  /** 検証以外で落ちた場合の理由。 */
  failure?: string;
};

/** ボリューム全体の移行結果。 */
export type MigrateVolumeResult = {
  ok: boolean;
  target_version: number;
  volume_data_root: string;
  image_data_root: string;
  /** `user_version = 0` だった DB のラベル。**1本でもあれば全体を拒否する。** */
  unstamped: string[];
  apps: AppMigrationOutcome[];
  kernel: {
    from_version: number;
    /** `skipped` … アプリ側が失敗したので触っていない。 */
    status: "already-current" | "migrated" | "skipped";
  };
};

export type MigrateVolumeOptions = {
  /** 移行する利用者のボリューム。 */
  volumeDataRoot: string;
  /** イメージ側の `data/`(移行先の `manifest.json` を持つ)。 */
  imageDataRoot: string;
};

/** `PRAGMA user_version` を読む。読めなければ例外(黙って通さない)。 */
function readUserVersion(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  } finally {
    db.close();
  }
}

/**
 * ボリュームにある「起動に使われる DB」を集める。
 *
 * **`src/server/runner-version-gate.ts` の `collectVolumeDbVersions` と同じ集合を見る**
 * —— あちらが止めたものを、こちらが直すのだから、集合が違ってはならない。
 * **同じ関数を値 import していない**(あちらは `src/server/`、こちらは `scripts/` で、
 * どちらも `src/kernel/storage-paths.ts` を正とする)—— **こちらは
 * `kernelDbPath` / `appDir` を値 import しているので、レイアウトの正は1つである。**
 */
function collectAppIds(volumeDataRoot: string): string[] {
  const appsRoot = join(volumeDataRoot, "apps");
  if (!existsSync(appsRoot) || !statSync(appsRoot).isDirectory()) {
    return [];
  }
  return readdirSync(appsRoot)
    .sort()
    .filter((appId) => existsSync(appDbPath(volumeDataRoot, appId)));
}

/**
 * 後付け unique(`false → true`)にした列の既存重複を、**適用前の**アプリDBを読んで検査する。
 *
 * ## 【`ADR-0252` 限定3】これは再実装である
 *
 * **本体は `src/kernel/apply-diff.ts` の非 export な `checkUniqueBackfills`**
 * (着手時 `:1883` 逐語 `function checkUniqueBackfills(`。**`export` が付いていない**。
 * `docs/plan/v5/01-distribution-baseline.md` が書いた当時は `:1420`)。
 * **`ADR-0252` 限定1 が「`src/kernel/` に export を1本も足さない」と定めたので、
 * export に変えずにここへ写した。**
 *
 * **`ADR-0009` §3b が名指しした「検証の正が2つある」状態をこれは作る。**
 * **黙って作らないために、`migrate-volume.test.ts` に2つの網を置いてある**:
 *
 * 1. **振る舞いの比較** —— 同じ入力に対して、本体側(`applyDiff` の返り値として
 *    取り出す)と、この関数の返り値が**逐語で一致すること。**
 * 2. **本文の sha の基準値** —— **本体を1バイトでも直したら赤くなる。**
 *    振る舞いの比較は「検査が渡した入力」しか見ないので、比較していない入力で
 *    分岐が増えたら静かに素通りするためである。
 *
 * **本体を直したら、この関数も同じ内容に直してから基準値を更新すること。**
 *
 * ## 本体から写した規約2つ
 *
 * - **スコープ列名 `st_owner`**(`ADR-0078`)。本体でも非 export の定数である。
 * - **打ち切り件数** —— 本体は `UNCONVERTIBLE_SAMPLE_LIMIT`(`src/kernel/convert.ts` の
 *   export)を使っている。**ここも同じ export を値 import している**(写していない)。
 */
const OWNER_SCOPE_COLUMN = "st_owner";

/** 実テーブルにその列が在るか(`PRAGMA table_info`)。**再実装**(本体の `tableHasColumn`)。 */
function tableHasColumn(db: Database, tableId: string, column: string): boolean {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${quoteIdentifier(tableId)})`)
    .all()
    .some((row) => row.name === column);
}

export function checkUniqueBackfillsForMigration(
  dataRoot: string,
  appId: string,
  checks: readonly { table: string; field: string; path: string; scope?: "owner" }[],
): ValidationError[] {
  const path = appDbPath(dataRoot, appId);
  if (!existsSync(path)) {
    // create_app を通っていないアプリ。走査対象が存在しない。
    return [];
  }
  const db = new Database(path, { readonly: true });
  try {
    const errors: ValidationError[] = [];
    for (const check of checks) {
      const tableExists =
        (db
          .query<{ n: number }, [string]>(
            'SELECT COUNT(*) AS n FROM "sqlite_master" WHERE "type" = \'table\' AND "name" = ?',
          )
          .get(check.table)?.n ?? 0) > 0;
      if (!tableExists) {
        // 適用前のDBにまだ無いテーブル(同じ差分で新設)。行が無いので重複も無い。
        continue;
      }
      const col = quoteIdentifier(check.field);
      const scopedByOwner =
        check.scope === "owner" && tableHasColumn(db, check.table, OWNER_SCOPE_COLUMN);
      const ownerExpr = `COALESCE(${quoteIdentifier(OWNER_SCOPE_COLUMN)}, '')`;
      const groupBy = scopedByOwner ? `${col}, ${ownerExpr}` : col;
      const dupes = db
        .query<{ value: string | number; n: number }, []>(
          `SELECT ${col} AS "value", COUNT(*) AS "n" FROM ${quoteIdentifier(check.table)} ` +
            `WHERE ${col} IS NOT NULL GROUP BY ${groupBy} HAVING COUNT(*) > 1 ORDER BY ${col}`,
        )
        .all();
      if (dupes.length === 0) {
        continue;
      }
      const shown = dupes.slice(0, UNCONVERTIBLE_SAMPLE_LIMIT);
      const samples = shown.map((d) => `${JSON.stringify(d.value)}(${d.n} 件)`).join(" / ");
      const omitted = dupes.length - shown.length;
      const tail = omitted > 0 ? ` ほか ${omitted} 種` : "";
      errors.push({
        path: check.path,
        message:
          `フィールド "${check.table}.${check.field}" を一意(unique)にできません。` +
          `既に同じ値を持つレコードが複数あります: ${samples}${tail}。` +
          `カーネルは重複を黙って1件に潰したりはしません(どの行が失われたかを後から知る手段が無いため)。`,
        hint:
          `先に update_record / delete_record で重複を解消してから、改めて同じ差分を送ってください。` +
          `一意制約を後から付けるには、既存データが既に一意でなければなりません。`,
      });
    }
    return errors;
  } finally {
    db.close();
  }
}

/** イメージ側の移行先の定義を読む。 */
function readImageTarget(
  imageDataRoot: string,
  appId: string,
): { manifest: Manifest; operations?: Operation[] } | { failure: string } {
  const manifestPath = appManifestPath(imageDataRoot, appId);
  if (!existsSync(manifestPath)) {
    return {
      failure:
        `イメージ側に移行先の manifest.json がありません: ${manifestPath}。` +
        `このボリュームに在るアプリ "${appId}" を、このイメージは配っていない可能性があります。`,
    };
  }
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;
  } catch (cause) {
    return { failure: `イメージ側の manifest.json を読めません: ${manifestPath}(${cause})` };
  }
  const operationsPath = join(appDir(imageDataRoot, appId), MIGRATION_OPERATIONS_FILENAME);
  if (!existsSync(operationsPath)) {
    return { manifest };
  }
  try {
    const operations = JSON.parse(readFileSync(operationsPath, "utf-8")) as Operation[];
    if (!Array.isArray(operations)) {
      return { failure: `${operationsPath} は operations の配列である必要があります。` };
    }
    return { manifest, operations };
  } catch (cause) {
    return { failure: `${operationsPath} を読めません(${cause})` };
  }
}

/**
 * 1アプリを移行する。**失敗したら「まだ1バイトも書いていない」か「巻き戻した」の
 * どちらかであることを、呼び出し側が status で判別できる形で返す。**
 */
function migrateOneApp(
  volumeDataRoot: string,
  imageDataRoot: string,
  appId: string,
  fromVersion: number,
): AppMigrationOutcome {
  const target = readImageTarget(imageDataRoot, appId);
  if ("failure" in target) {
    return { app_id: appId, from_version: fromVersion, status: "failed", failure: target.failure };
  }

  const current = readCurrentManifest(volumeDataRoot, appId);
  let next: Manifest;
  if (target.operations !== undefined) {
    const folded = foldOperations(current, target.operations);
    if (!folded.valid) {
      return {
        app_id: appId,
        from_version: fromVersion,
        status: "failed",
        errors: folded.errors,
        failure: `${MIGRATION_OPERATIONS_FILENAME} を今のマニフェストに当てられません。`,
      };
    }
    next = folded.manifest;
    // **畳み込んだ結果がイメージの宣言と一致しなければ拒否する。**
    // 一致しないまま進むと、実スキーマとイメージの画面定義が静かに食い違う。
    if (JSON.stringify(next) !== JSON.stringify(target.manifest)) {
      return {
        app_id: appId,
        from_version: fromVersion,
        status: "failed",
        failure:
          `${MIGRATION_OPERATIONS_FILENAME} を畳み込んだ結果が、イメージの manifest.json と一致しません。` +
          `どちらかが古いか、手順が足りません。`,
      };
    }
  } else {
    next = target.manifest;
  }

  const planned = planMigration(current, next, target.operations);
  if (!planned.valid) {
    return {
      app_id: appId,
      from_version: fromVersion,
      status: "failed",
      errors: planned.errors,
      failure:
        target.operations === undefined
          ? `破壊的な移行は operations が要ります(${MIGRATION_OPERATIONS_FILENAME} を置いてください)。`
          : "移行の実行計画を作れません。",
    };
  }

  // --- 事前検証(DBは読むだけ。1バイトも書かない)------------------------------
  // **`applyDiff` と同じ順序・同じ判定を通す** —— 変換可否 → 後付け unique。
  const dbPath = appDbPath(volumeDataRoot, appId);
  if (planned.conversions !== undefined && planned.conversions.length > 0) {
    const readonlyDb = new Database(dbPath, { readonly: true });
    let conversionErrors: ValidationError[];
    try {
      conversionErrors = checkFieldConversions(readonlyDb, planned.conversions);
    } finally {
      readonlyDb.close();
    }
    if (conversionErrors.length > 0) {
      return {
        app_id: appId,
        from_version: fromVersion,
        status: "failed",
        errors: conversionErrors,
        failure: "既存データを新しい型に変換できません。",
      };
    }
  }
  if (planned.uniqueChecks !== undefined && planned.uniqueChecks.length > 0) {
    const uniqueErrors = checkUniqueBackfillsForMigration(
      volumeDataRoot,
      appId,
      planned.uniqueChecks,
    );
    if (uniqueErrors.length > 0) {
      return {
        app_id: appId,
        from_version: fromVersion,
        status: "failed",
        errors: uniqueErrors,
        failure: "後付けの一意制約に既存の重複が当たります。",
      };
    }
  }

  // --- ここから書く。先にスナップショットを取る -------------------------------
  const snapshot = takeSnapshot(volumeDataRoot, appId, MIGRATION_SNAPSHOT_DIFF_ID);
  try {
    const db = new Database(dbPath, { readwrite: true, create: false });
    try {
      // **DDL と印を1つのトランザクションに入れる。** `PRAGMA user_version` は
      // トランザクション内で立てて ROLLBACK で戻ることを `V5-M5` が実測している
      // (`v5-m5.md` §2-3 の w4)。**印だけが進む状態を作らない。**
      db.transaction(() => {
        applyMigrationPlan(db, planned.plan);
        db.exec(`PRAGMA user_version = ${RUNNER_BUILD_VERSION};`);
      })();
    } finally {
      db.close();
    }
    // **マニフェスト(ファイル)はこのトランザクションの外にある**(`applyMigrationPlan`
    // の doc コメントと同じ構造)。ここで落ちたら下の catch が巻き戻す。
    writeFileSync(
      appManifestPath(volumeDataRoot, appId),
      `${JSON.stringify(next, null, 2)}\n`,
      "utf-8",
    );
  } catch (cause) {
    restoreSnapshot(volumeDataRoot, appId, snapshot.name);
    return {
      app_id: appId,
      from_version: fromVersion,
      status: "failed",
      snapshot: snapshot.name,
      failure: `移行の適用に失敗したので巻き戻しました: ${cause}`,
    };
  }

  return {
    app_id: appId,
    from_version: fromVersion,
    status: "migrated",
    snapshot: snapshot.name,
  };
}

/**
 * ボリュームを移行する。
 *
 * **1アプリでも失敗したら、この実行で成功したアプリも全部巻き戻し、`kernel.sqlite` に
 * 1バイトも触らない。**
 */
export function migrateVolume(options: MigrateVolumeOptions): MigrateVolumeResult {
  const { volumeDataRoot, imageDataRoot } = options;
  const kernelPath = kernelDbPath(volumeDataRoot);
  const appIds = collectAppIds(volumeDataRoot);

  const base = {
    target_version: RUNNER_BUILD_VERSION,
    volume_data_root: volumeDataRoot,
    image_data_root: imageDataRoot,
  };

  if (!existsSync(kernelPath)) {
    return {
      ...base,
      ok: false,
      unstamped: [],
      apps: [],
      kernel: { from_version: 0, status: "skipped" },
    };
  }

  // --- 印の無い DB を1本でも含むなら、1バイトも触らずに拒否する(`ADR-0251` 限定6)---
  const kernelVersion = readUserVersion(kernelPath);
  const appVersions = new Map(
    appIds.map((appId) => [appId, readUserVersion(appDbPath(volumeDataRoot, appId))]),
  );
  const unstamped: string[] = [];
  if (kernelVersion === 0) {
    unstamped.push("kernel.sqlite");
  }
  for (const [appId, version] of appVersions) {
    if (version === 0) {
      unstamped.push(`apps/${appId}/app.sqlite`);
    }
  }
  if (unstamped.length > 0) {
    return {
      ...base,
      ok: false,
      unstamped,
      apps: [],
      kernel: { from_version: kernelVersion, status: "skipped" },
    };
  }

  // --- アプリを1本ずつ移行する ------------------------------------------------
  const outcomes: AppMigrationOutcome[] = [];
  let failed = false;
  for (const appId of appIds) {
    const fromVersion = appVersions.get(appId) ?? 0;
    if (fromVersion === RUNNER_BUILD_VERSION) {
      outcomes.push({ app_id: appId, from_version: fromVersion, status: "already-current" });
      continue;
    }
    const outcome = migrateOneApp(volumeDataRoot, imageDataRoot, appId, fromVersion);
    outcomes.push(outcome);
    if (outcome.status === "failed") {
      failed = true;
      break;
    }
  }

  if (failed) {
    // **この実行で移行し終えたアプリも戻す。** commit 済みなので、内側の
    // トランザクションでは戻らない —— **`restoreSnapshot` がここで効く。**
    for (const outcome of outcomes) {
      if (outcome.status === "migrated" && outcome.snapshot !== undefined) {
        restoreSnapshot(volumeDataRoot, outcome.app_id, outcome.snapshot);
        outcome.status = "rolled-back";
      }
    }
    return {
      ...base,
      ok: false,
      unstamped: [],
      apps: outcomes,
      kernel: { from_version: kernelVersion, status: "skipped" },
    };
  }

  // --- `kernel.sqlite`(**巻き戻す手段が無い**。冒頭の「限界」を参照)-----------
  let kernelStatus: "already-current" | "migrated" = "already-current";
  if (kernelVersion !== RUNNER_BUILD_VERSION) {
    // `KernelMetaStore.open` が遅延 `ALTER`(`migrateChangelogColumns`)を1回通す。
    // **既に在る DB を開くだけでは印を刻まない**(`ADR-0251` 限定6。`meta-store.ts` の
    // `isNewDatabase` 分岐)ので、印はこちらで書く。
    KernelMetaStore.open(volumeDataRoot).close();
    const db = new Database(kernelPath, { readwrite: true, create: false });
    try {
      db.exec(`PRAGMA user_version = ${RUNNER_BUILD_VERSION};`);
    } finally {
      db.close();
    }
    kernelStatus = "migrated";
  }

  return {
    ...base,
    ok: true,
    unstamped: [],
    apps: outcomes,
    kernel: { from_version: kernelVersion, status: kernelStatus },
  };
}

/** 人が読む報告文を組み立てる。 */
export function formatMigrationReport(result: MigrateVolumeResult): string {
  const lines: string[] = [];
  lines.push(
    result.ok
      ? `[smailtalk migrate] 移行しました(版=${result.target_version} / ボリューム=${result.volume_data_root})。`
      : `[smailtalk migrate] 移行できませんでした(版=${result.target_version} / ボリューム=${result.volume_data_root})。`,
  );
  if (result.unstamped.length > 0) {
    lines.push(
      `  印の無い DB が ${result.unstamped.length} 本あります。**この器は印の無いボリュームを救済しません**` +
        "(ADR-0251 限定6 / §6 の 3。救済するには門A を新規に通す必要があります):",
    );
    for (const label of result.unstamped) {
      lines.push(`    - ${label}: user_version = 0`);
    }
    lines.push("  ボリュームには1バイトも書いていません。");
  }
  for (const app of result.apps) {
    lines.push(`  - ${app.app_id}: ${app.status}(移行前の版 = ${app.from_version})`);
    if (app.failure !== undefined) {
      lines.push(`      ${app.failure}`);
    }
    for (const error of app.errors ?? []) {
      lines.push(`      ${error.path}: ${error.message}`);
    }
  }
  lines.push(
    `  kernel.sqlite: ${result.kernel.status}(移行前の版 = ${result.kernel.from_version})`,
  );
  if (result.ok) {
    lines.push(
      "  ここで合わせたのは版と定義だけである。版が合っていて中身が違うボリュームは素通りする(ADR-0251 限定8)。",
    );
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const [volumeDataRoot, imageDataRoot] = process.argv.slice(2);
  if (volumeDataRoot === undefined || imageDataRoot === undefined) {
    console.error(
      "使い方: bun run scripts/migrate-volume.ts <ボリュームのdata> <イメージのdata>\n" +
        "  イメージ側の apps/<app_id>/manifest.json が移行先の定義です。\n" +
        `  破壊的な移行には、同じディレクトリに ${MIGRATION_OPERATIONS_FILENAME} を置いてください。`,
    );
    process.exit(2);
  }
  const result = migrateVolume({ volumeDataRoot, imageDataRoot });
  const report = formatMigrationReport(result);
  if (!result.ok) {
    console.error(report);
    process.exit(1);
  }
  console.log(report);
}
