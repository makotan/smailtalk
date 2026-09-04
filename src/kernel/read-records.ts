/**
 * レコード読み取りのファサード(ADR-0006 §7b)。
 *
 * システムテーブルなら `kernel.sqlite` を開いて投影を副問合せとして読み、
 * そうでなければ `app.sqlite` に対して `records.ts` へ委譲する。
 * **すべての読み取り入口はここを通す。**
 *
 * ## 覆うのは4本である(**V4-M23-T02 で3本 → 4本になった。旧文を消さずに直す**)
 *
 * | 元の関数 | ここでの名前 | 覆い漏らすと何が起きるか |
 * |---|---|---|
 * | `listRecords` | `readRecordList` | 一覧が `unknownTableError` |
 * | `getRecord` | `readRecord` | 詳細画面が `unknownTableError` |
 * | `countRecords` | `readRecordCount` | **MCP `list_records` が必ず失敗する** |
 * | `countAndSumRecords` | `readRecordCountAndSum` | **システムテーブルの一覧が必ず落ちる**(`V4-M23-T02` / `ADR-0104` 限定5) |
 *
 * `countRecords` の覆い漏らしは壊れ方が分かりにくい。MCP の `list_records` は
 * `listRecords` の成功を確認した直後に `countRecords` を呼び、失敗すれば `toolError`
 * を返す。一覧の取得自体は成功しているのにツール全体は `isError` で返り、
 * `_apps` を読もうとした AI に見えるのは「テーブルが存在しません」だけになる。
 *
 * ## `app.sqlite` を開かない
 *
 * システムテーブルの投影元は `kernel.sqlite` であり、`app.sqlite` は一切要らない。
 * それでも開いてしまうと、「アプリは登録済みだが `app.sqlite` がまだ無い / 壊れている」
 * 状態のとき **`_apps` を眺めるだけで 500 になる**。管理ツールは壊れた状態を見に行く
 * ための道具でもあるので、その1件のせいで一覧全体が落ちるのは筋が悪い。
 * したがって `ReadSource.appDb` は**遅延**(thunk)で受け、システムテーブルでは呼ばない。
 *
 * ## sort / filter は `records.ts` の SQL 1本である(SQ-M3 / SQ-M4)
 *
 * **かつてはここに JS で書いた2つ目の実装があり、同じ宣言が指す表によって違う意味に
 * 解釈されていた。** 投影を `kernel.sqlite` に対する**副問合せ**として組み立てて
 * `records.ts` の FROM に差し込むことで、絞り込み・並べ替え・ページ送りの実装は1つになった。
 * **経路によって振る舞いが変わることが、ADR-0003 §7 が最も避けたかったこと**である。
 *
 * 残っている非対称は `records.ts` が両方の表に等しく課しているものだけである:
 *
 * - **sort** は `[...fieldIds(table), ...SYSTEM_COLUMN_NAMES]` を許す
 * - **filter** は fields のみを許す
 *
 * エラーメッセージと `allowed_values` は、ユーザテーブルと**同じ関数が同じ文面**で作る。
 */
import { Database } from "bun:sqlite";
import { isSystemTableId } from "../shared/system-tables.ts";
import { AiCapabilityStore } from "./ai-capability-store.ts";
import { quoteIdentifier, SYSTEM_COLUMN_NAMES, SYSTEM_COLUMNS } from "./ddl.ts";
import type { ValidationError } from "./errors.ts";
import { KernelMetaStore } from "./meta-store.ts";
import {
  countAndSumRecords,
  countRecords,
  getRecord,
  type ListRecordsOptions,
  listRecords,
  type RecordResult,
  type RecordRow,
  unknownTableError,
} from "./records.ts";
import { resolveTable } from "./resolve-table.ts";
import { kernelDbPath } from "./storage-paths.ts";
import type { FilterCondition, FilterNode, Manifest, ResourceId, Table } from "./types.ts";

/**
 * 読み取り元。
 *
 * `appDb` を関数で受けるのは、システムテーブルの読み取りで `app.sqlite` を
 * **開かせない**ためである(上記)。呼び出し側は「開く手続き」を渡すだけでよい。
 *
 * **`kernel.sqlite` の開閉は呼び出し側に見せない** —— システムテーブルを読むときだけ
 * `dataRoot` から開き、読み終えたら閉じる(下の `withSystemTableDb`)。
 */
export type ReadSource = {
  /** `kernel.sqlite` があるデータルート。システムテーブルの投影元。 */
  dataRoot: string;
  /** ユーザテーブルを読むための `app.sqlite`。システムテーブルでは呼ばれない。 */
  appDb: () => Database;
};

function fail<T>(errors: ValidationError[]): RecordResult<T> {
  return { ok: false, errors };
}

// --- 投影 SELECT の組み立て(SQ-M2)------------------------------------------------
//
// 投影を **`kernel.sqlite` に対する副問合せ**として組み立て、`records.ts` の読取4本の
// FROM に差し込む。これで sort / filter / ページネーションが SQL 経路と同じ実装になる。
//
// **物理テーブルもビューも作らない。** 副問合せは読み取りのたびに文として組み立てられる
// だけで、実体はどこにも残らない ―― ADR-0006 §8 の安全性の論証(実体が無いから
// `INSERT INTO "_apps"` が届かない)はそのまま保たれる。
//
// **`_id` は `CAST(... AS TEXT)` で必ず文字列にする(SQ-M5 追記)。**
//
// **【旧文を実測が覆した。経緯を残す】** ここにはかつて「`CAST` を入れない。入れると
// 既定順が 1,10,11,2… に変わるから」と書いてあった。**この理由は実測で否定された** ——
// 既定順は `_id` ではなく下の `defaultOrderBy`(`_apps` は `created_at`+`ledger_seq`、
// `_changelog` は `seq`、`_ai_usage` は `called_at`+`id`)で組み立てているので、
// **`CAST` を入れても既定順は1件も動かない**(3表とも SQ-M0 が一本化の前に採った
// 固定値と、列名・型・値・並び順まで一致する)。
//
// **`CAST` が実際に動かすのは `sort` に `_id` を明示したときの並びだけ**であり、
// そこでは `CAST` を**入れた方**が正しい:
//
// | `_changelog` に `sort: {field:"_id", order:"asc"}` | 並び |
// |---|---|
// | 一本化の前(JS のメモリ実装) | `1,10,11,2,3…9`(文字列順) |
// | `CAST` 無し | `1,2,3…10,11`(**数値順。ここだけ意味が違う**) |
// | `CAST` 有り | `1,10,11,2,3…9`(文字列順) |
// | ユーザ表(`_id` は UUID の TEXT) | 文字列順 |
//
// `_id` は語彙の上では**必ず文字列**(`toRecordRow`(`records.ts`)が `String()` で写す)
// であり、ユーザ表では UUID の TEXT なので `ORDER BY "_id"` は文字列順になる。`CAST` を
// 落とすと `_changelog` だけが INTEGER のまま数値順になり、**同じ宣言が指す表によって
// 違う意味に解釈される** —— 一本化がまさに消しに来たものが `_id` に残る。
//
// 同じ理由で `WHERE "_id" = ?` も揃う。`CAST` 無しでは SQLite の INTEGER 親和性が
// 副問合せ越しに伝わり、`"05"` / `" 5"` / `"5 "` / `"5.0"` / `"+5"` が seq=5 に
// 当たっていた(**一本化の前は当たらなかった**)。`CAST` を入れると素直な `"5"` だけが
// 当たり、**一本化の前ともユーザ表とも一致する。**
//
// `_apps._id`(= `app_id`)と `_ai_usage._id`(= `id`)は元から TEXT なので、
// `CAST` は値も並びも1バイトも変えない(3表に同じ式を書けるのはこのためである)。

/** 1つのシステムテーブルの投影元。**表IDごとに1つ**(既定を持たない = 書き忘れが黙って通らない)。 */
type SystemTableSourceSpec = {
  /** 投影元の物理テーブル(`kernel.sqlite`)。 */
  physical: string;
  /** `_id` に写す物理列。 */
  id: string;
  /**
   * `_created_at` と `_updated_at` の**両方**に写す物理列。
   *
   * 同じ列を流用しているのは、投影元に「更新の記録」が無いからである(追記専用)。
   * 無い情報を作らない(憲法6)ため、ダミーの値も現在時刻も入れない。
   */
  timestamp: string;
  /** 語彙のフィールドID → 投影元の物理列。 */
  fields: Readonly<Record<string, string>>;
  /**
   * `sort` 未指定のときの並び(すべて昇順)。**今日の投影元の順序と同じにする。**
   * ここに書いた列が投影の出力に無ければ、並びのためだけに副問合せへ足す。
   */
  order: readonly string[];
  /**
   * 読取の前にスキーマを揃える手続き(**DDL 副作用**)。
   *
   * 投影元のストアは**開くたびに** `CREATE TABLE IF NOT EXISTS` と、後から足した列の
   * `ALTER TABLE ... ADD COLUMN` を流している。**読み取り専用で開くだけではこれが走らず**、
   * 古い `kernel.sqlite` は `no such column`、`ai_usage` を1度も作っていないデータルートは
   * `no such table`、`kernel.sqlite` がまだ無いデータルートは `SQLITE_CANTOPEN` になる。
   * **投影元のストアを一度開いて閉じる**ことで、今日と同じ形の DB に揃えてから読む。
   *
   * **表IDごとに書く。** `_apps` / `_changelog` は `KernelMetaStore`、`_ai_usage` は
   * `AiCapabilityStore` が投影元であり(メータリングは `kernel.sqlite` の別テーブル群)、
   * どのストアを開けばよいかは表ごとに違う。
   */
  ensureSchema: (dataRoot: string) => void;
  /**
   * 行に写すときに値域を確かめるフィールド(値域は `select` の選択肢そのもの)。
   *
   * **CHECK 制約では代替できない** —— SQLite には既存列へ CHECK を足す構文が無く、
   * 新規DBだけが持ち、既にある `kernel.sqlite` には一生効かない(実測)。
   * カーネル外からDBを直接書き換えた場合にしか起きないので、黙って握り潰さず落とす。
   *
   * **書くのは、投影元のストアが同じ検査を持っていた列だけである**(`changelog.kind` =
   * `toChangelogKind` / `ai_usage.status` = `toUsageStatus`)。**`apps.status` は
   * 投影元も検査していないので、ここにも書かない**(挙動を増やさない)。
   */
  ranged?: readonly string[];
};

/**
 * `_apps` / `_changelog` の投影元(`kernel.sqlite` のメタ情報)のスキーマを揃える。
 * 開いて閉じるだけで `CREATE TABLE IF NOT EXISTS` と遅延 `ALTER` が走る。
 */
function ensureKernelMetaSchema(dataRoot: string): void {
  KernelMetaStore.open(dataRoot).close();
}

/** `_ai_usage` の投影元(メータリングのテーブル群)のスキーマを揃える。 */
function ensureAiUsageSchema(dataRoot: string): void {
  AiCapabilityStore.openForKernel(dataRoot).close();
}

/**
 * システムテーブルID → 投影元。**対応表**にしてある
 * (三項演算子にすると、4本目を足したとき else 節が黙って別表を返す)。
 */
const SYSTEM_TABLE_SOURCES: ReadonlyMap<string, SystemTableSourceSpec> = new Map([
  [
    "_apps",
    {
      ensureSchema: ensureKernelMetaSchema,
      physical: "apps",
      id: "app_id",
      timestamp: "created_at",
      fields: { app_id: "app_id", name: "name", created_at: "created_at", status: "status" },
      // `listApps()` と同じ並び。`created_at` が同値のとき登録順(`ledger_seq`)で決まる ——
      // `_id`(= app_id)の辞書順に倒すと、同日作成の2件の前後が今日と入れ替わる。
      order: ["created_at", "ledger_seq"],
    },
  ],
  [
    "_changelog",
    {
      ensureSchema: ensureKernelMetaSchema,
      physical: "changelog",
      id: "seq",
      timestamp: "applied_at",
      fields: {
        seq: "seq",
        app_id: "app_id",
        diff_id: "diff_id",
        intent: "intent",
        applied_at: "applied_at",
        kind: "kind",
        undo_target_seq: "undo_target_seq",
      },
      // `listAllChangelog()` と同じ並び。`applied_at` は同値になりうるので seq で決める。
      order: ["seq"],
      ranged: ["kind"],
    },
  ],
  [
    "_ai_usage",
    {
      ensureSchema: ensureAiUsageSchema,
      physical: "ai_usage",
      id: "id",
      timestamp: "called_at",
      fields: {
        app_id: "app_id",
        capability_id: "capability_id",
        workflow_id: "workflow_id",
        actor: "actor",
        model: "model",
        input_tokens: "input_tokens",
        output_tokens: "output_tokens",
        cost_usd: "cost_usd",
        status: "status",
        usage_date: "usage_date",
        called_at: "called_at",
      },
      // `listAllUsage()` と同じ並び。
      order: ["called_at", SYSTEM_COLUMNS.id],
      ranged: ["status"],
    },
  ],
]);

/**
 * 投影元の定義を引く。無ければ落とす(空配列も別表の中身も返さない)。
 *
 * ここに到達した時点で、そのIDは `isSystemTableId` と `resolveTable` の**両方を通っている** ——
 * つまり **`SYSTEM_TABLES` に定義として実在するテーブル**である。したがって呼び出し元が
 * ユーザ入力の誤りに対して返す `unknownTableError`(「テーブル "X" はこのアプリに存在しません」)
 * は、ここでは**嘘になる**。存在はしている。投影の実装が無いだけである。
 *
 * 空配列も返さない。**「沈黙して誤ったデータを返す」のが是正前のバグであり、
 * 「沈黙して空を返す」はその同類**だからである。どちらも画面には正常な結果として出る ——
 * 前者は他人の履歴が、後者は「0件です」が。**ユーザにもAIにも、投影が抜けていることは
 * 見えない。** 唯一違うのは間違いの見た目だけで、気づけなさは同じである。
 *
 * これはユーザ入力の誤りではなく**カーネル内部の不整合**(システムテーブルを1本足して
 * 投影を書き忘れた)なので、統一エラー形式ではなく throw で落とす。
 */
function systemTableSpec(tableId: ResourceId): SystemTableSourceSpec {
  const spec = SYSTEM_TABLE_SOURCES.get(tableId);
  if (spec === undefined) {
    throw new Error(
      `システムテーブル "${tableId}" の投影が定義されていません。` +
        `SYSTEM_TABLES に足したテーブルは read-records.ts の投影元にも登録してください。`,
    );
  }
  return spec;
}

/**
 * 読取4本(`records.ts`)へ渡す「解決済みの `Table`」と「FROM 句のソース」。
 *
 * 行の除外条件は1つも無い。副問合せは**素の全件 SELECT** である ——
 * 見せる相手の判定はサーバ層(`owner-scope.ts`)の担当であって、ここではない。
 */
function systemTableRead(table: Table): {
  table: Table;
  from: string;
  defaultOrderBy: string;
} {
  const spec = systemTableSpec(table.id);
  const selected = [
    // `_id` は語彙の上では必ず文字列。`CAST` を落とすと `_changelog` だけが INTEGER の
    // まま並び・突き合わせの意味がユーザ表と割れる(上の表を参照)。
    `CAST(${quoteIdentifier(spec.id)} AS TEXT) AS ${quoteIdentifier(SYSTEM_COLUMNS.id)}`,
    `${quoteIdentifier(spec.timestamp)} AS ${quoteIdentifier(SYSTEM_COLUMNS.createdAt)}`,
    `${quoteIdentifier(spec.timestamp)} AS ${quoteIdentifier(SYSTEM_COLUMNS.updatedAt)}`,
  ];
  const produced = new Set<string>(SYSTEM_COLUMN_NAMES);
  for (const field of table.fields) {
    const column = spec.fields[field.id];
    if (column === undefined) {
      throw new Error(
        `システムテーブル "${table.id}" のフィールド "${field.id}" に投影元の列がありません。` +
          `SYSTEM_TABLES に足したフィールドは read-records.ts の投影元にも登録してください。`,
      );
    }
    selected.push(`${quoteIdentifier(column)} AS ${quoteIdentifier(field.id)}`);
    produced.add(field.id);
  }
  // 並びのためだけに要る列(`_apps` の `ledger_seq`)を副問合せへ足す。
  // 外側の SELECT は列を名指しで並べるので、ここに足しても返り値の列は1つも増えない。
  for (const column of spec.order) {
    if (!produced.has(column)) {
      selected.push(quoteIdentifier(column));
      produced.add(column);
    }
  }
  return {
    table,
    from: `(SELECT ${selected.join(", ")} FROM ${quoteIdentifier(spec.physical)})`,
    defaultOrderBy: spec.order.map((column) => `${quoteIdentifier(column)} ASC`).join(", "),
  };
}

/**
 * SQL の結果を行に写した後の値域検査(投影元のストアの `toChangelogKind` /
 * `toUsageStatus` 相当)。
 *
 * **投影を SQL に一本化しても、この検査だけは JS 側に残す。** 値域外は
 * カーネル外からDBを書き換えた場合にしか起きないが、そのとき黙って未知の値を
 * ユーザランドの `select` フィールドとして出すと、画面には正常な行として並ぶ。
 *
 * 許される値は**システムテーブル定義の `select` の選択肢そのもの**を使う ——
 * 値の一覧をここに書き写すと、写しが2つになって割れる。
 */
function assertRangedValues(table: Table, rows: readonly RecordRow[]): void {
  const spec = systemTableSpec(table.id);
  if (spec.ranged === undefined) {
    return;
  }
  for (const fieldId of spec.ranged) {
    const field = table.fields.find((candidate) => candidate.id === fieldId);
    const allowed = field !== undefined && field.type === "select" ? field.options : undefined;
    if (allowed === undefined) {
      throw new Error(
        `システムテーブル "${table.id}" のフィールド "${fieldId}" に選択肢がありません。` +
          `値域を確かめるフィールドは select として定義してください。`,
      );
    }
    for (const row of rows) {
      const value = (row as unknown as Record<string, unknown>)[fieldId];
      if (typeof value === "string" && !allowed.includes(value)) {
        throw new Error(
          `${spec.physical}.${fieldId} に未知の値 "${value}" が入っています。` +
            `許可される値: ${allowed.join(" / ")}。`,
        );
      }
    }
  }
}

/**
 * システムテーブルを読むあいだだけ `kernel.sqlite` を開く。
 *
 * **読み取り専用で開く** —— この経路から `kernel.sqlite` へ1バイトも書けない。
 */
function withSystemTableDb<T>(
  source: ReadSource,
  tableId: ResourceId,
  run: (db: Database) => T,
): T {
  // 投影の定義が無いIDは、DBを開く前に落とす(開いた分を閉じ忘れない)。
  const spec = systemTableSpec(tableId);
  // 読み取り専用で開く前に、投影元のスキーマを今日の形へ揃える(DDL 副作用)。
  spec.ensureSchema(source.dataRoot);
  const db = new Database(kernelDbPath(source.dataRoot), { readonly: true });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

// --- 公開API -------------------------------------------------------------------

/** `listRecords`(`records.ts`)をシステムテーブルまで広げたもの。 */
export function readRecordList(
  source: ReadSource,
  manifest: Manifest,
  tableId: ResourceId,
  options: ListRecordsOptions = {},
): RecordResult<RecordRow[]> {
  if (!isSystemTableId(tableId)) {
    return listRecords(source.appDb(), manifest, tableId, options);
  }
  const table = resolveTable(manifest, tableId);
  if (table === undefined) {
    return fail([unknownTableError(manifest, tableId)]);
  }
  return withSystemTableDb(source, tableId, (db) => {
    const result = listRecords(db, manifest, tableId, options, systemTableRead(table));
    if (result.ok) {
      assertRangedValues(table, result.value);
    }
    return result;
  });
}

/** `getRecord`(`records.ts`)をシステムテーブルまで広げたもの。存在しなければ `null`。 */
export function readRecord(
  source: ReadSource,
  manifest: Manifest,
  tableId: ResourceId,
  id: string,
): RecordResult<RecordRow | null> {
  if (!isSystemTableId(tableId)) {
    return getRecord(source.appDb(), manifest, tableId, id);
  }
  const table = resolveTable(manifest, tableId);
  if (table === undefined) {
    return fail([unknownTableError(manifest, tableId)]);
  }
  return withSystemTableDb(source, tableId, (db) => {
    const result = getRecord(db, manifest, tableId, id, systemTableRead(table));
    if (result.ok && result.value !== null) {
      assertRangedValues(table, [result.value]);
    }
    return result;
  });
}

/**
 * `countRecords`(`records.ts`)をシステムテーブルまで広げたもの。
 *
 * `options.filter` を渡すと **filter 適用後の件数**を返す(EC-G11 / ADR-0042 限定3。
 * ページネーションの total 整合の前提)。filter は `readRecordList` と同じ意味論・
 * 同じコンパイラを通るので、「一覧に出る件数」と「total」が割れない。省略時は全件数。
 */
export function readRecordCount(
  source: ReadSource,
  manifest: Manifest,
  tableId: ResourceId,
  options: { filter?: FilterCondition[] | FilterNode } = {},
): RecordResult<number> {
  if (!isSystemTableId(tableId)) {
    return countRecords(source.appDb(), manifest, tableId, options);
  }
  const table = resolveTable(manifest, tableId);
  if (table === undefined) {
    return fail([unknownTableError(manifest, tableId)]);
  }
  return withSystemTableDb(source, tableId, (db) =>
    countRecords(db, manifest, tableId, options, systemTableRead(table)),
  );
}

/**
 * `countAndSumRecords`(`records.ts`)をシステムテーブルまで広げたもの
 * (`V4-M23-T02`。`ADR-0104` 限定5 / 限定6)。
 *
 * **読み取りは3本ではなく4本すべてをファサード経由にする** —— **`readRecordCount` を
 * 覆い漏らすと MCP `list_records` が必ず失敗した**(`read-records.test.ts` の逐語)のと
 * 同じ理由で、**合計だけ `records.ts` を直に呼ぶとシステムテーブルで必ず落ちる。**
 *
 * **母集団は `readRecordCount` とまったく同じである**(限定5)—— 同じ `filter` を
 * 同じ投影に流す。**分岐を1つも増やしていない。**
 */
export function readRecordCountAndSum(
  source: ReadSource,
  manifest: Manifest,
  tableId: ResourceId,
  options: { filter?: FilterCondition[] | FilterNode; sumField?: ResourceId } = {},
): RecordResult<{ count: number; sum: number | null }> {
  if (!isSystemTableId(tableId)) {
    return countAndSumRecords(source.appDb(), manifest, tableId, options);
  }
  const table = resolveTable(manifest, tableId);
  if (table === undefined) {
    return fail([unknownTableError(manifest, tableId)]);
  }
  return withSystemTableDb(source, tableId, (db) =>
    countAndSumRecords(db, manifest, tableId, options, systemTableRead(table)),
  );
}
