/**
 * ドライラン機構(V1-M1-T02)。
 *
 * 差分を**本体に適用せず**、本体の複製の上で `applyDiff` そのものを走らせ、
 * その結果を報告する。計画書 §V1-M1-T02 の「diff を本体に適用せず、スナップショット
 * 複製上で適用して結果レポートを返す機構」の実体である。
 *
 * ## `dry_run` フラグ方式を採らない(詳細化 §2-2)
 *
 * `applyDiff` に `dry_run: true` を足すのではなく、**独立した関数**にしてある。
 * `undo.ts:18-23` が `previewUndo` を独立関数にしたのと同じ判断であり、理由もそのまま
 * 当てはまる ―― フラグ方式だと**フラグを落としたときに起きるのが「確認せず実行」**に
 * なる。独立関数なら、落としたときに起きるのは「実行できない」である。
 * `vocabulary.ts` が `delete_record` に `confirm: true` を足さなかったのと同型で、
 * 「フラグを付ければ安全」という誤った学習を作らないためでもある(ADR-0010 §6a)。
 *
 * ## なぜ「予測」ではなく「複製の上での実行」なのか
 *
 * 完了条件は「**レポートが実際の適用結果と一致する**」である。適用結果を別ロジックで
 * 予測すると、一致は**テストが見張り続けるしかない性質**になり、`applyDiff` を直した
 * 日に黙ってずれる。複製の上で `applyDiff` を呼べば、一致は**構造的に成り立つ**。
 * この機構は `applyDiff` が何 op を解するかに一切依存しないので、T03 が破壊的 4 op を
 * 実装した時点で、このファイルを1バイトも変えずにそれらのドライランが動く。
 *
 * ## 作業領域(記録 §1-2)
 *
 * 複製は **OS の一時ディレクトリ**に作り、レポートを組み立て終えたら `finally` で消す。
 * `dataRoot` の**中に**置かない理由は2つあり、どちらも「消し忘れるとディスクが膨らむ」
 * より重い。
 *
 * 1. **`scripts/mcp-trial/snapshot.ts` が `dataRoot` 配下の全ファイルを採取し、
 *    judge が「観測されたファイル変化が transcript で説明できるか」を突き合わせる。**
 *    作業領域が `dataRoot` の下にあると、ドライランを1回呼ぶたびに説明のつかない
 *    ファイル変化が証跡に載る。**それは V1-M0-T06 が既に扱った「証跡が1件多く見える」
 *    問題そのものである。**
 * 2. **スナップショットの連番を消費しない。** 複製には `snapshots/` をコピーしないので、
 *    複製上の `applyDiff` が取るスナップショットは複製の中で 0001 から始まり、
 *    本体の `snapshots/` には触れない。`takeSnapshot` を本体に対して呼ぶ実装にすると、
 *    ドライランのたびに本体の連番が1つ進む。
 *
 * **消すのが早すぎてレポートの根拠が消えることはない。** レポートは値(マニフェスト・
 * スキーマ・件数)として完全に materialize されてから複製が消えるので、複製は
 * レポートの根拠ではなく**製造工程**である。ここが `apply-diff.ts` が失敗時にも
 * スナップショットを残す判断(あちらは「戻せる元の状態」という代替不能な実体)と違う。
 *
 * ## エラー方針
 *
 * `applyDiff` の返り値をそのまま通す。拒否は統一形式(`ValidationError[]`)、
 * カーネル/環境側の異常は例外。**ドライラン固有のエラー語彙を作らない** ―― 作ると
 * 「ドライランでは通ったのに apply で違う文面が出た」が起きうる。
 */

import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff } from "./apply-diff.ts";
import type { ValidationError } from "./errors.ts";
import type { MigrationPlan } from "./migrate.ts";
import { appDbPath, appDir, appManifestPath, kernelDbPath } from "./storage-paths.ts";
import type { Manifest, RoleConditionNotice } from "./types.ts";

/**
 * レポートに必ず添える注記。
 *
 * ドライランは**その時点の複製**に対する実行であり、ドライランと `applyDiff` の間に
 * データが変われば結果は変わる。`UNDO_PREVIEW_NOTE`(ADR-0004 §6)が「件数に現れない
 * 喪失がある」ことを黙って隠さないために置かれているのと同じ役目である(憲法6)。
 *
 * **「ドライランを通ったから安全」と読ませないことがこの一文の全部である。**
 */
export const DRY_RUN_NOTE =
  "このレポートは、実行時点の複製に対して実際に適用した結果です。" +
  "本体のマニフェスト・データ・履歴は1バイトも変わっていません。" +
  "ドライランの成功は apply_diff の成功を保証しません" +
  "(ドライランから apply_diff までの間にデータが変わると結果は変わります)。";

/**
 * 1テーブル分の影響。**予測ではなく、複製上で実際に起きた変化の実測である。**
 */
export type DryRunTableImpact = {
  /** テーブルID。 */
  table: string;
  /** 適用前の行数。適用前にテーブルが存在しない場合は `null`。 */
  rows_before: number | null;
  /** 適用後の行数。適用後にテーブルが存在しない場合は `null`。 */
  rows_after: number | null;
  /** 適用によって増えた列(システム列を含む実 SQLite 列名)。 */
  added_columns: string[];
  /** 適用によって消えた列。 */
  removed_columns: string[];
  /**
   * 影響行数 —— **列構成が変わったテーブルの適用前行数**。
   *
   * 列が1つ増えれば既存の全行がその列を持つことになるので、影響を受けるのは
   * 適用前に存在した全行である。列構成が変わらないテーブル(ビューだけを変えた場合)は 0。
   * 新規テーブルも 0 である ―― 影響を受ける既存行が存在しない。
   */
  affected_rows: number;
};

/** ドライランの結果レポート。 */
export type DryRunReport = {
  /** 適用後のマニフェスト(複製上で実際に永続化されたもの)。 */
  manifest: Manifest;
  /**
   * 適用後の**実 SQLite スキーマ**(テーブル→列名の並び)。
   *
   * マニフェストではなく `PRAGMA table_info` が返す実体である。マニフェストだけを
   * 返すと「マニフェストは通ったが DDL は落ちた」を報告できない。
   */
  schema: Record<string, string[]>;
  /** 実行された additive マイグレーションの内容。 */
  plan: MigrationPlan;
  /** テーブルごとの影響(テーブルID昇順)。 */
  impacts: DryRunTableImpact[];
  /**
   * **誰も通さない条件・全員を通す条件の知らせ**(`V8-M18` / 台帳 `J-G16`。裁定 `R-17-6`)。
   *
   * **`applyDiff` が返すのと**同じ配列**である**(複製の上で本物の `applyDiff` を走らせて
   * いるので、予測ではなく実測である)。**矛盾が無ければ空配列。欄そのものは常に在る。**
   *
   * **【なぜここに要るか】** **`J-G16` の限定は「書いた人に返る形で伝える」であり、
   * ドライランは「当てる前に確かめる」ための口である。** **ここに出さないと、書いた人が
   * 矛盾を知るのは適用してからになる** —— **`m18-vocab-report.md` §9 の 3 が申告した穴を
   * 塞いだものである。**
   *
   * **拒否ではない。** **`valid: true` のレポートに載る知らせであり、適用は通る。**
   */
  role_condition_notices: RoleConditionNotice[];
  /** 限界を隠さないための定型文(`DRY_RUN_NOTE`)。 */
  note: string;
};

/**
 * `dryRunDiff` の結果。
 *
 * 失敗形は `applyDiff` と**同一**である。ADR-0010 §7 が失敗を6種に整理し、そのうち
 * 失敗4(**変換不能値が1件以上。該当行の `_id` と実際の値を返す**)を
 * `ValidationError[]` で返すと定めているので、変換不能値の一覧はこの `errors` に乗る。
 * ドライラン固有の返し方を作らないことが、実適用との一致を構造的に保証している。
 */
export type DryRunDiffResult =
  | { valid: true; report: DryRunReport }
  | { valid: false; errors: ValidationError[] };

/** 複製上で観測したテーブルの状態。 */
type ObservedTable = { columns: string[]; rows: number };

/**
 * 差分を本体に適用せず、複製の上で適用して結果を報告する。
 *
 * **本体(`dataRoot` 配下)を1バイトも変更しない。** 複製は OS の一時ディレクトリに作り、
 * レポートを組み立て終えたら必ず消す。
 *
 * @param dataRoot データルート(`data/` 相当)。環境変数に依存させず必ず引数で受ける。
 * @param appId 対象アプリのID。
 * @param diff 差分パッチ。未検証の入力(`unknown`)を受け付ける。
 * @throws 本体のマニフェスト/DBが読めない場合、複製の作成に失敗した場合。
 */
export function dryRunDiff(dataRoot: string, appId: string, diff: unknown): DryRunDiffResult {
  const workspace = mkdtempSync(join(tmpdir(), "gp-dry-run-"));
  try {
    const shadowRoot = createShadowRoot(workspace, dataRoot, appId);

    const before = observeTables(appDbPath(shadowRoot, appId));

    // 複製に対して**本物の** applyDiff を走らせる。予測しない。
    const applied = applyDiff(shadowRoot, appId, diff);
    if (!applied.valid) {
      return { valid: false, errors: applied.errors };
    }

    const after = observeTables(appDbPath(shadowRoot, appId));

    return {
      valid: true,
      report: {
        manifest: applied.manifest,
        schema: Object.fromEntries(
          [...after.entries()]
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([id, t]) => [id, t.columns]),
        ),
        plan: applied.plan,
        impacts: buildImpacts(before, after),
        // **`V8-M18` / 台帳 `J-G16`** —— **複製の上の `applyDiff` が実際に作った知らせを
        // そのまま載せる**(ドライラン固有の計算を1バイトも書かない)。
        role_condition_notices: applied.role_condition_notices,
        note: DRY_RUN_NOTE,
      },
    };
  } finally {
    // レポートは既に値として完成している。複製は製造工程であって根拠ではない。
    rmSync(workspace, { recursive: true, force: true });
  }
}

/**
 * 本体の複製(影のデータルート)を作る。
 *
 * コピーするのは `kernel.sqlite` / `apps/<appId>/manifest.json` / `apps/<appId>/app.sqlite` の
 * 3点だけである。
 *
 * - **`kernel.sqlite` をコピーする理由**: `applyDiff` はアプリ台帳と changelog をここから
 *   読む。省くと `diff_id` の重複検査(`apply-diff.ts` の履歴照合)が**ドライランでだけ
 *   通ってしまい**、実適用で初めて拒否される。それはレポートと実適用の不一致である。
 * - **`snapshots/` をコピーしない理由**: 複製上の `applyDiff` が取るスナップショットを
 *   複製の中の 0001 から始めるため。本体の連番には触れない。
 *   スナップショットの中身はドライランの結果に影響しない(`applyDiff` は読まない)。
 *
 * SQLite のコピーは `VACUUM INTO` で行う。単純なファイルコピーだと、他接続が
 * 書き込みトランザクションを開いている最中に不整合なコピーを作りうる
 * (`snapshot.ts` 冒頭が同じ理由で `VACUUM INTO` を採っている)。
 * **`takeSnapshot` を呼ばないのは、あれが本体の `snapshots/` に連番を1つ消費するからである。**
 */
function createShadowRoot(workspace: string, dataRoot: string, appId: string): string {
  const shadowRoot = join(workspace, "data");
  const shadowAppDir = appDir(shadowRoot, appId);
  mkdirSync(shadowAppDir, { recursive: true });

  const manifestPath = appManifestPath(dataRoot, appId);
  const dbPath = appDbPath(dataRoot, appId);
  if (!existsSync(manifestPath) || !existsSync(dbPath)) {
    throw new Error(
      `アプリ "${appId}" のドライランを実行できません。` +
        `${manifestPath} と ${dbPath} の両方が必要ですが、揃っていません。` +
        `アプリが存在しないか、ファイルが削除されている可能性があります。`,
    );
  }

  copyFileSync(manifestPath, appManifestPath(shadowRoot, appId));
  copyDatabaseConsistently(dbPath, appDbPath(shadowRoot, appId));

  const kernelPath = kernelDbPath(dataRoot);
  if (existsSync(kernelPath)) {
    copyDatabaseConsistently(kernelPath, kernelDbPath(shadowRoot));
  }

  return shadowRoot;
}

/** SQLite ファイルを整合性を保ったままコピーする(`snapshot.ts` と同じ手口)。 */
function copyDatabaseConsistently(sourcePath: string, destinationPath: string): void {
  const db = new Database(sourcePath, { readonly: true });
  try {
    // ファイル名は値なのでプレースホルダでバインドする(文字列連結で埋めない)。
    db.query("VACUUM INTO ?").run(destinationPath);
  } finally {
    db.close();
  }
}

/** DB 内の全ユーザテーブルについて、列名の並びと行数を読む。 */
function observeTables(dbPath: string): Map<string, ObservedTable> {
  const observed = new Map<string, ObservedTable>();
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = db
      .query<{ name: string }, []>(
        `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%' ORDER BY "name"`,
      )
      .all()
      .map((row) => row.name);

    for (const table of tables) {
      // テーブル名は sqlite_master から読んだ実在の識別子である(外部入力ではない)。
      const columns = db
        .query<{ name: string }, []>(`PRAGMA table_info("${table}")`)
        .all()
        .map((row) => row.name);
      const count = db.query<{ n: number }, []>(`SELECT COUNT(*) AS "n" FROM "${table}"`).get();
      observed.set(table, { columns, rows: count?.n ?? 0 });
    }
  } finally {
    db.close();
  }
  return observed;
}

/** 適用前後の観測から、テーブルごとの影響を組み立てる。 */
function buildImpacts(
  before: Map<string, ObservedTable>,
  after: Map<string, ObservedTable>,
): DryRunTableImpact[] {
  const tableIds = [...new Set([...before.keys(), ...after.keys()])].sort();

  return tableIds.map((table) => {
    const b = before.get(table);
    const a = after.get(table);
    const beforeColumns = new Set(b?.columns ?? []);
    const afterColumns = new Set(a?.columns ?? []);

    const added = (a?.columns ?? []).filter((c) => !beforeColumns.has(c));
    const removed = (b?.columns ?? []).filter((c) => !afterColumns.has(c));

    // 列構成が変わったテーブルだけが、既存行に影響を受ける。
    // 新規テーブル(b === undefined)は影響を受ける既存行を持たないので 0 である。
    const structureChanged = added.length > 0 || removed.length > 0;
    const affected = structureChanged && b !== undefined ? b.rows : 0;

    return {
      table,
      rows_before: b?.rows ?? null,
      rows_after: a?.rows ?? null,
      added_columns: added,
      removed_columns: removed,
      affected_rows: affected,
    };
  });
}
