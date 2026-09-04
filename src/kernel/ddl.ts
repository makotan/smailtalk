/**
 * マニフェスト → SQLite DDL マッピング(V0-P2-T04)。
 *
 * `table` 定義を `CREATE TABLE` に、`field` 定義を列定義に変換する。
 * ここは「退屈に作る」層(憲法1)であり、DDL文字列の生成と実行以外のことはしない。
 *
 * ## システム列
 *
 * すべてのテーブルに以下の3列を持たせる。ユーザ定義フィールドIDは
 * `^[a-z][a-z0-9_-]*$`(resource-id.ts)で必ず英小文字始まりなので、
 * `_` 始まりの名前を使う限りユーザ定義フィールドと**原理的に衝突しない**。
 *
 * | 列 | 型 | 内容 |
 * |---|---|---|
 * | `_id` | TEXT PRIMARY KEY | レコードID(`crypto.randomUUID()` で発行) |
 * | `_created_at` | TEXT NOT NULL | 作成日時(ISO8601 UTC) |
 * | `_updated_at` | TEXT NOT NULL | 更新日時(ISO8601 UTC) |
 *
 * ## フィールド型9種 → SQLite 列型
 *
 * | 語彙の型 | SQLite 列型 | 備考 |
 * |---|---|---|
 * | `text` | TEXT | |
 * | `long_text` | TEXT | |
 * | `select` | TEXT | 選択肢の検査はアプリ層(V0-P2-T07)。CHECK制約にはしない |
 * | `date` | TEXT | ISO8601 |
 * | `reference` | TEXT | 参照先レコードの `_id` |
 * | `image` | TEXT | `_files` に実在する file_id(V2-M2 / ADR-0035)。reference と同じく実在確認はアプリ層 |
 * | `file` | TEXT | `_files` に実在する file_id(V5-M16 / ADR-0161 限定3)。`image` とまったく同型 |
 * | `number` | NUMERIC | 整数は整数、小数は小数のまま保持される |
 * | `boolean` | INTEGER | 0 / 1 |
 *
 * ## 制約を DDL に落とさない理由(重要)
 *
 * - **`required` を NOT NULL 制約にしない**。既存データがある状態で
 *   `add_field` により NOT NULL 列を追加することは SQLite ではできず
 *   (デフォルト値なしの NOT NULL 列追加はエラー)、additive マイグレーション
 *   (handover.md 3.6 / V0-P2-T05)が成立しなくなるため。required の強制は
 *   アプリ層(V0-P2-T07)の書き込み時バリデーションで行う。
 * - **`select` の選択肢を CHECK 制約にしない**。CHECK にすると選択肢の追加が
 *   テーブル再構築を伴う破壊的変更になってしまい、v0 の additive-only 方針
 *   (選択肢追加は additive)と矛盾するため。検査はアプリ層で行う。
 * - **`reference` を外部キー制約にしない**。参照先レコードの存在チェックは
 *   アプリ層(V0-P2-T07)で行う。DDL に落とすと、参照先テーブルの作成順序や
 *   スナップショット復元時の一時的な不整合が扱いづらくなるため。
 *
 * ## SQL 組み立ての方針
 *
 * 識別子(テーブル名・列名)はフィールドIDにハイフンを含みうるため**常に
 * ダブルクォートで囲む**。加えて埋め込み前に必ず `isValidResourceId` で検証する
 * (SQLインジェクション対策の多層防御)。値は必ずプレースホルダでバインドする。
 */
import type { Database } from "bun:sqlite";
import { isValidResourceId, RESOURCE_ID_MAX_LENGTH } from "./resource-id.ts";
import type { Field, FieldType, Manifest, Table } from "./types.ts";

/** すべてのテーブルが持つシステム列の名前。 */
export const SYSTEM_COLUMNS = {
  /** レコードID(主キー)。 */
  id: "_id",
  /** 作成日時(ISO8601 UTC)。 */
  createdAt: "_created_at",
  /** 更新日時(ISO8601 UTC)。 */
  updatedAt: "_updated_at",
} as const;

/** システム列名の一覧(スキーマ検査やレコード層の列選択で使う)。 */
export const SYSTEM_COLUMN_NAMES: readonly string[] = [
  SYSTEM_COLUMNS.id,
  SYSTEM_COLUMNS.createdAt,
  SYSTEM_COLUMNS.updatedAt,
];

/** フィールド型 → SQLite 列型のマッピング表(上のドキュメントコメントと対応)。 */
const FIELD_TYPE_TO_SQLITE: Record<FieldType, string> = {
  text: "TEXT",
  long_text: "TEXT",
  select: "TEXT",
  date: "TEXT",
  reference: "TEXT",
  // image 値は `_files` に実在する file_id を表す文字列(V2-M2 / ADR-0035 §1b)。
  // reference が参照先 `_id` を TEXT で持つのと同型で、実在確認はアプリ層(records.ts)が行う。
  image: "TEXT",
  // file 値も `_files` に実在する file_id を表す文字列(V5-M16 / ADR-0161 限定3)。
  // **image とまったく同型である** —— 違うのは受け入れる種別・上限・配信の形だけで、
  // 列の型も実在確認の相手も1バイトも変わらない。
  file: "TEXT",
  number: "NUMERIC",
  boolean: "INTEGER",
};

/** フィールド型に対応する SQLite の列型を返す。 */
export function sqliteTypeForFieldType(type: FieldType): string {
  return FIELD_TYPE_TO_SQLITE[type];
}

/**
 * SQL 識別子をダブルクォートで囲む。
 *
 * 埋め込み前に `isValidResourceId` で検証し、違反すれば例外を投げる。
 * 検証済みIDのみが到達する想定だが、DDL文字列に識別子を埋め込む唯一の関数を
 * 検証の関門にしておくことで、バリデーションを迂回した経路が生まれても
 * SQL インジェクションにならないようにする(多層防御)。
 *
 * 例外はシステム列名(`_` 始まりのためリソースID規約を満たさない)で、
 * これはカーネル内の固定の定数集合なので許可リストとして通す。
 */
export function quoteIdentifier(id: string): string {
  if (SYSTEM_COLUMN_NAMES.includes(id)) {
    return `"${id}"`;
  }
  if (!isValidResourceId(id)) {
    throw new Error(
      `SQL識別子 "${id}" はリソースID規約に違反しています。` +
        `規約: 英小文字で始まり、使用可能文字は [a-z0-9_-]、長さは1〜${RESOURCE_ID_MAX_LENGTH}文字。`,
    );
  }
  return `"${id}"`;
}

/** 1フィールドの列定義(`"quantity" NUMERIC`)を作る。 */
export function columnDefinition(field: Field): string {
  // required は意図的に NOT NULL にしない(モジュール冒頭のコメント参照)。
  return `${quoteIdentifier(field.id)} ${sqliteTypeForFieldType(field.type)}`;
}

/** テーブル定義から `CREATE TABLE` 文を生成する。 */
export function createTableSql(table: Table): string {
  const columns = [
    `${quoteIdentifier(SYSTEM_COLUMNS.id)} TEXT PRIMARY KEY`,
    `${quoteIdentifier(SYSTEM_COLUMNS.createdAt)} TEXT NOT NULL`,
    `${quoteIdentifier(SYSTEM_COLUMNS.updatedAt)} TEXT NOT NULL`,
    ...table.fields.map(columnDefinition),
  ];
  return `CREATE TABLE ${quoteIdentifier(table.id)} (\n  ${columns.join(",\n  ")}\n)`;
}

/** フィールド定義から `ALTER TABLE ... ADD COLUMN` 文を生成する。 */
export function addColumnSql(tableId: string, field: Field): string {
  return `ALTER TABLE ${quoteIdentifier(tableId)} ADD COLUMN ${columnDefinition(field)}`;
}

/*
 * ここから下は V1-M1-T03(ADR-0010)が足した破壊的 DDL である。
 *
 * **v0 はこの層に破壊的変更の呼び口を置かないことで禁止していた**(`migrate.ts:11-14`)。
 * ADR-0010 が門A を通したので実装するが、**限定5 は維持する** ―― `NOT NULL` /
 * `CHECK` / 外部キーは今も DDL に落とさない。したがってここに増えるのは
 * 「消す」「名前を変える」の2種だけであり、制約を表現する DDL は1つも増えていない。
 *
 * 列の**型変更**に対応する DDL は SQLite に存在しないため、ここには無い。
 * それはテーブル再構築であり `rebuild-table.ts` の担当である(ADR-0010 §5a 層2)。
 */

/**
 * `ALTER TABLE ... DROP COLUMN` 文を生成する(SQLite 3.35 以降)。
 *
 * **可用性は実行環境に依存する。** 使えるかどうかは `supportsDropColumn` で
 * **実行時に確かめる**こと(ADR-0010 §5a:「使えるはずだ」を前提に実装しない)。
 */
export function dropColumnSql(tableId: string, fieldId: string): string {
  return `ALTER TABLE ${quoteIdentifier(tableId)} DROP COLUMN ${quoteIdentifier(fieldId)}`;
}

/** `ALTER TABLE ... RENAME COLUMN` 文を生成する。 */
export function renameColumnSql(tableId: string, from: string, to: string): string {
  return `ALTER TABLE ${quoteIdentifier(tableId)} RENAME COLUMN ${quoteIdentifier(from)} TO ${quoteIdentifier(to)}`;
}

/** `ALTER TABLE ... RENAME TO` 文を生成する。 */
export function renameTableSql(from: string, to: string): string {
  return `ALTER TABLE ${quoteIdentifier(from)} RENAME TO ${quoteIdentifier(to)}`;
}

/**
 * `DROP TABLE` 文を生成する。
 *
 * **`IF EXISTS` を付けない。** 存在しないテーブルを消そうとしたことは、
 * 畳み込みの段階で既に拒否されているはずの状態である。ここで黙って成功させると、
 * カーネルのバグが「何も起きなかった」として隠れる(憲法6)。
 */
export function dropTableSql(tableId: string): string {
  return `DROP TABLE ${quoteIdentifier(tableId)}`;
}

/**
 * マニフェストの全テーブルを DB に作る(空の app.sqlite への初期投入用)。
 *
 * すべての `CREATE TABLE` を1トランザクションで実行するため、
 * 途中で失敗しても中途半端なスキーマは残らない。
 * 既存テーブルと同名のテーブルがあれば例外になる(黙って握りつぶさない)。
 */
export function applyManifestDdl(db: Database, manifest: Manifest): void {
  const statements = manifest.app.tables.map(createTableSql);
  db.transaction(() => {
    for (const sql of statements) {
      db.exec(sql);
    }
  })();
}
