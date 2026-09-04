/**
 * テーブル再構築(層2)。ADR-0010 §5a の実装(V1-M1-T03)。
 *
 * SQLite は**列の型変更をサポートしない**。したがって `number` / `boolean` が絡む
 * 変換(層2)は `ALTER TABLE` では済まず、
 *
 *   新テーブル作成 → 変換しながら全行コピー → 旧テーブル DROP → RENAME
 *
 * という手順が要る。このモジュールはその手順**だけ**を持つ。
 *
 * ## なぜ `ddl.ts` に置かないか
 *
 * `ddl.ts` は冒頭で「DDL文字列の生成と実行以外のことはしない」層だと宣言している。
 * 再構築は**値の変換を伴う全行コピー**であり、その宣言を破る。分けたのは
 * `records/v1-m1-t01.md` §6 の変更予定ファイル宣言どおりである。
 *
 * ## 元テーブルを失わないこと(ADR-0010 §7 失敗6)
 *
 * 手順の途中で失敗すると「旧テーブルは DROP 済み、新テーブルは未完成」という、
 * **データが丸ごと消える**壊れ方をしうる。これを2段で防いでいる。
 *
 * 1. **全行の変換を先に済ませてから DDL を1文も発行しない**。変換不能値が
 *    見つかるのは `CREATE TABLE` より前であり、その時点では旧テーブルは無傷である。
 *    (`applyDiff` 経由なら `checkFieldConversions` が更に手前で弾いているので、
 *    ここに到達する変換不能値は原理的に無い。**それでも二重に防ぐ** —— この関数は
 *    カーネル内部APIとして単独でも呼べるため、事前検証を通っていることを前提にしない。)
 * 2. **全体を1トランザクションに包む**。`db.transaction()` は入れ子にすると
 *    SAVEPOINT になるので、`applyMigrationPlan` の外側トランザクションの中で
 *    呼ばれても、単独で呼ばれても、同じ「全部通るか、1文も残らないか」になる。
 *
 * ## 作業用テーブル名の衝突
 *
 * 作業用テーブルが既存テーブルと衝突したら**黙って DROP せずに例外にする**。
 * 握って進むと、ユーザのテーブルを消すことになる。
 */

import type { Database } from "bun:sqlite";
import { convertValue } from "./convert.ts";
import { columnDefinition, quoteIdentifier, SYSTEM_COLUMNS } from "./ddl.ts";
import { isValidResourceId } from "./resource-id.ts";
import type { Field, ResourceId, Table } from "./types.ts";

/** 再構築後の1列と、その値の取得元。 */
export type RebuildColumn = {
  /** 再構築後のフィールド定義(列名・列型はここから作る)。 */
  field: Field;
  /** 値の取得元となる、**再構築前の**列名。 */
  source: ResourceId;
  /**
   * 変換元のフィールド定義。指定した場合だけ `convertValue` を通す。
   * 省略した場合は値をそのまま運ぶ(列名やテーブル名だけが変わるケース)。
   */
  from?: Field;
};

/** 作業用テーブルの名前。リソースID規約を満たす(英小文字始まり)。 */
function workTableName(tableId: ResourceId): string {
  return `gp-rebuild-${tableId}`;
}

/** テーブルが実在するか。 */
function tableExists(db: Database, tableId: string): boolean {
  const row = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM "sqlite_master" WHERE "type" = 'table' AND "name" = ?`,
    )
    .get(tableId);
  return (row?.n ?? 0) > 0;
}

/**
 * `ALTER TABLE ... DROP COLUMN` が使えるか、**実際に試して**判定する。
 *
 * ADR-0010 §5a: 「利用可能性は実行環境の SQLite 版に依存する。実行時に版を確認し、
 * 使えない場合は再構築経路へ落ちること。**『使えるはずだ』を前提に実装しない。**」
 *
 * 版番号の文字列比較ではなく実行して確かめるのは、版番号から可用性を推論すると
 * ビルドオプションで無効化された環境を取り違えるためである。**判定は対象DBに
 * 痕跡を残さない** —— 使い捨てのテーブルに対して試し、トランザクションごと巻き戻す。
 */
export function supportsDropColumn(db: Database): boolean {
  return probe(db, (probeName) => {
    db.exec(`ALTER TABLE ${quoteIdentifier(probeName)} DROP COLUMN "b"`);
  });
}

/** `ALTER TABLE ... RENAME COLUMN` が使えるか、実際に試して判定する。 */
export function supportsRenameColumn(db: Database): boolean {
  return probe(db, (probeName) => {
    db.exec(`ALTER TABLE ${quoteIdentifier(probeName)} RENAME COLUMN "b" TO "c"`);
  });
}

/**
 * 使い捨てのテーブルに対して DDL を試し、可否だけを返す。
 *
 * 成否にかかわらず**必ず巻き戻す**ので、対象DBには1バイトも残らない。
 * `db.transaction()` は入れ子で SAVEPOINT になるため、呼び出し側が既に
 * トランザクションの中でも安全に使える。
 */
function probe(db: Database, attempt: (probeName: string) => void): boolean {
  const probeName = `gp-probe-${Math.random().toString(36).slice(2, 10)}`;
  if (!isValidResourceId(probeName) || tableExists(db, probeName)) {
    // 名前が作れない/衝突するなら、能力があると仮定せず再構築経路へ落とす。
    return false;
  }
  let supported = false;
  try {
    db.transaction(() => {
      db.exec(`CREATE TABLE ${quoteIdentifier(probeName)} ("a" TEXT, "b" TEXT)`);
      try {
        attempt(probeName);
        supported = true;
      } catch {
        supported = false;
      }
      // 成否を問わず、この試行そのものを巻き戻す。
      throw new ProbeRollback();
    })();
  } catch (error) {
    if (!(error instanceof ProbeRollback)) {
      throw error;
    }
  }
  return supported;
}

/** `probe` の中でだけ使う、巻き戻し専用の内部例外。 */
class ProbeRollback extends Error {}

/**
 * テーブルを再構築する(層2 の唯一の実行経路)。
 *
 * @param db          対象のアプリDB。
 * @param sourceTableId 再構築前の物理テーブル名。
 * @param target      再構築後のテーブル定義。`target.id` が再構築後の物理テーブル名になる
 *                    (`sourceTableId` と違えば、テーブル名の変更を同時に行うことになる)。
 * @param columns     再構築後の各列と、その値の取得元。ここに現れない列は**消える**。
 * @throws 変換不能値があった場合、作業用テーブル名が衝突した場合、DDL が失敗した場合。
 *         いずれの場合も元テーブルは1バイトも変わらない。
 */
export function rebuildTable(
  db: Database,
  sourceTableId: ResourceId,
  target: Table,
  columns: readonly RebuildColumn[],
): void {
  const workName = workTableName(target.id);
  if (tableExists(db, workName)) {
    throw new Error(
      `テーブル "${sourceTableId}" の再構築に使う作業用テーブル "${workName}" が既に存在します。` +
        `中断された再構築の残骸か、同名のテーブルがユーザ定義されています。` +
        `内容を確認してから手動で削除してください(カーネルは黙って上書きしません)。`,
    );
  }

  // --- 1. 全行を読み、**DDL を1文も発行する前に**変換を済ませる ---
  const sourceColumns = [
    SYSTEM_COLUMNS.id,
    SYSTEM_COLUMNS.createdAt,
    SYSTEM_COLUMNS.updatedAt,
    ...columns.map((column) => column.source),
  ];
  const selectList = sourceColumns.map((name, index) => `${quoteIdentifier(name)} AS "c${index}"`);
  const sourceRows = db
    .query<Record<string, string | number | null>, []>(
      `SELECT ${selectList.join(", ")} FROM ${quoteIdentifier(sourceTableId)} ` +
        `ORDER BY ${quoteIdentifier(SYSTEM_COLUMNS.id)}`,
    )
    .all();

  // reference への変換がある場合に備えて、参照先の実在IDを先に読む。
  const referenceIds = new Map<ResourceId, Set<string>>();
  for (const column of columns) {
    if (column.from === undefined || column.field.type !== "reference") {
      continue;
    }
    const referenced = column.field.reference_table;
    if (referenceIds.has(referenced)) {
      continue;
    }
    referenceIds.set(referenced, readExistingIds(db, referenced));
  }

  const converted: (string | number | null)[][] = [];
  for (const row of sourceRows) {
    const values: (string | number | null)[] = [
      row.c0 as string,
      row.c1 as string,
      row.c2 as string,
    ];
    for (const [index, column] of columns.entries()) {
      const raw = row[`c${index + 3}`] ?? null;
      if (column.from === undefined) {
        values.push(raw);
        continue;
      }
      const existing =
        column.field.type === "reference"
          ? referenceIds.get(column.field.reference_table)
          : undefined;
      const result = convertValue(raw, column.from, column.field, existing);
      if (!result.ok) {
        // ここに来るのは事前検証を経ていない直接呼び出しのときだけである。
        // 元テーブルはまだ1バイトも変わっていない。
        throw new Error(
          `テーブル "${sourceTableId}" の列 "${column.source}" を再構築できません: ` +
            `_id "${row.c0}" の値 ${JSON.stringify(raw)} が変換できません(${result.reason})。`,
        );
      }
      values.push(result.value);
    }
    converted.push(values);
  }

  // --- 2. ここから DDL。全体を1トランザクション(入れ子なら SAVEPOINT)に包む ---
  const workTable: Table = { ...target, id: workName };
  const insertColumns = [
    SYSTEM_COLUMNS.id,
    SYSTEM_COLUMNS.createdAt,
    SYSTEM_COLUMNS.updatedAt,
    ...columns.map((column) => column.field.id),
  ];

  db.transaction(() => {
    db.exec(createWorkTableSql(workTable));

    if (converted.length > 0) {
      const placeholders = insertColumns.map(() => "?").join(", ");
      const insert = db.query(
        `INSERT INTO ${quoteIdentifier(workName)} ` +
          `(${insertColumns.map(quoteIdentifier).join(", ")}) VALUES (${placeholders})`,
      );
      for (const values of converted) {
        insert.run(...values);
      }
    }

    db.exec(`DROP TABLE ${quoteIdentifier(sourceTableId)}`);
    db.exec(`ALTER TABLE ${quoteIdentifier(workName)} RENAME TO ${quoteIdentifier(target.id)}`);
  })();
}

/**
 * 作業用テーブルの `CREATE TABLE` を作る。
 *
 * `ddl.ts` の `createTableSql` をそのまま使わないのは、作業用テーブル名
 * (`gp-rebuild-<id>`)がリソースID規約は満たすものの、**マニフェスト上のIDではない**
 * ためである。列定義は `columnDefinition` を共有しており、**再構築後の列型が
 * `add_table` で作った場合と1バイトも違わない**ことが保証される。
 */
function createWorkTableSql(workTable: Table): string {
  const columns = [
    `${quoteIdentifier(SYSTEM_COLUMNS.id)} TEXT PRIMARY KEY`,
    `${quoteIdentifier(SYSTEM_COLUMNS.createdAt)} TEXT NOT NULL`,
    `${quoteIdentifier(SYSTEM_COLUMNS.updatedAt)} TEXT NOT NULL`,
    ...workTable.fields.map(columnDefinition),
  ];
  return `CREATE TABLE ${quoteIdentifier(workTable.id)} (\n  ${columns.join(",\n  ")}\n)`;
}

/** 参照先テーブルに実在する `_id` の集合を読む。 */
function readExistingIds(db: Database, tableId: ResourceId): Set<string> {
  if (!tableExists(db, tableId)) {
    return new Set();
  }
  const rows = db
    .query<{ id: string }, []>(
      `SELECT ${quoteIdentifier(SYSTEM_COLUMNS.id)} AS "id" FROM ${quoteIdentifier(tableId)}`,
    )
    .all();
  return new Set(rows.map((row) => row.id));
}
