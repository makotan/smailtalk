/**
 * SQ-M1: 読取専用の経路に「解決済みの `Table`」と「FROM 句のソース」を渡せること。
 *
 * ## この検査が固定する2つのこと
 *
 * 1. **新しい引数を渡さない既存の呼び出しが生成する SQL 文字列が1バイトも変わらない。**
 *    期待値は着手前の実測値をそのまま逐語で置いてある(この検査は改修**前**に緑だった)。
 * 2. **新しい引数に別のソースを渡すと、生成 SQL の FROM がそのソースに置き換わる。**
 *    こちらは改修前は赤(引数が存在しないので置き換わらない)である。
 *
 * ## なぜ SQL 文字列そのものを見るのか
 *
 * 「結果が同じ」だけでは、`FROM` の組み立てを引数化したときに**別の形の SQL**へ
 * 化けたことに気づけない。SQ-M2 以降は投影を副問合せとして FROM に差し込むので、
 * **差し込まない呼び出しの文が1バイトも動いていないこと**が土台になる。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyManifestDdl } from "./ddl.ts";
import type { ValidationError } from "./errors.ts";
import {
  countAndSumRecords,
  countRecords,
  createRecord,
  getRecord,
  listRecords,
} from "./records.ts";
import type { Manifest, Table } from "./types.ts";

const manifest: Manifest = {
  app: {
    id: "shelf-app",
    name: "棚",
    tables: [
      {
        id: "books",
        name: "書籍",
        fields: [
          { id: "title", name: "タイトル", type: "text", required: true },
          { id: "price", name: "価格", type: "number" },
        ],
      },
    ],
    views: [],
  },
};

const booksTable = manifest.app.tables[0] as Table;

let db: Database;
/** 実際に `db.query()` へ渡された SQL 文字列(発行順)。 */
let sqls: string[];

function unwrap<T>(result: { ok: true; value: T } | { ok: false; errors: ValidationError[] }): T {
  if (!result.ok) {
    throw new Error(`期待に反して失敗しました: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

/**
 * `db.query()` に渡された SQL を記録しつつ本物へ委譲する。
 *
 * **本物の SQLite をそのまま使う**(偽物に差し替えない)ので、記録した文字列は
 * 「実際に実行された文」である。テスト用のフックは製品コードに1バイトも入れていない。
 */
function recordingDatabase(target: Database, sink: string[]): Database {
  return new Proxy(target, {
    get(_ignored, prop) {
      if (prop === "query") {
        return (sql: string) => {
          sink.push(sql);
          return target.query(sql);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as Database;
}

/** 直前に発行された SELECT(記録の最後の1本)。 */
function lastSql(): string {
  const sql = sqls[sqls.length - 1];
  if (sql === undefined) {
    throw new Error("SQL が1本も記録されていません(記録の仕掛けが効いていない)。");
  }
  return sql;
}

beforeEach(() => {
  db = new Database(":memory:");
  applyManifestDdl(db, manifest);
  // 差し替え先のソース。`books` と同じ列を持つ**別の物理テーブル**。
  db.exec(
    'CREATE TABLE "shelf" ("_id" TEXT PRIMARY KEY, "_created_at" TEXT NOT NULL, "_updated_at" TEXT NOT NULL, "title" TEXT NOT NULL, "price" INTEGER)',
  );
  db.exec(
    `INSERT INTO "shelf" ("_id", "_created_at", "_updated_at", "title", "price") VALUES ('s1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '棚の本', 300)`,
  );
  sqls = [];
});

afterEach(() => {
  db.close();
});

describe("SQ-M1 完了条件1: 新しい引数を渡さない呼び出しの SQL は1バイトも変わらない", () => {
  test("listRecords(既定): 逐語一致", () => {
    const recording = recordingDatabase(db, sqls);
    unwrap(listRecords(recording, manifest, "books"));
    expect(lastSql()).toBe(
      'SELECT "_id", "_created_at", "_updated_at", "title", "price" FROM "books" ORDER BY "_created_at" ASC, "_id" ASC',
    );
  });

  test("listRecords(filter / sort / limit / offset): 逐語一致", () => {
    const recording = recordingDatabase(db, sqls);
    unwrap(
      listRecords(recording, manifest, "books", {
        filter: [{ field: "title", equals: "赤" }],
        sort: [
          { field: "price", order: "desc" },
          { field: "title", order: "asc" },
        ],
        limit: 2,
        offset: 1,
      }),
    );
    expect(lastSql()).toBe(
      'SELECT "_id", "_created_at", "_updated_at", "title", "price" FROM "books" WHERE "title" = ? ORDER BY "price" DESC, "title" ASC, "_created_at" ASC, "_id" ASC LIMIT ? OFFSET ?',
    );
  });

  test("countRecords(既定 / filter つき): 逐語一致", () => {
    const recording = recordingDatabase(db, sqls);
    unwrap(countRecords(recording, manifest, "books"));
    expect(lastSql()).toBe('SELECT COUNT(*) AS n FROM "books"');
    unwrap(
      countRecords(recording, manifest, "books", { filter: [{ field: "title", equals: "赤" }] }),
    );
    expect(lastSql()).toBe('SELECT COUNT(*) AS n FROM "books" WHERE "title" = ?');
  });

  test("countAndSumRecords(sumField つき): 逐語一致", () => {
    const recording = recordingDatabase(db, sqls);
    unwrap(countAndSumRecords(recording, manifest, "books", { sumField: "price" }));
    expect(lastSql()).toBe('SELECT COUNT(*) AS n, SUM("price") AS s FROM "books"');
  });

  test("getRecord(既定): 逐語一致", () => {
    const recording = recordingDatabase(db, sqls);
    unwrap(getRecord(recording, manifest, "books", "no-such-id"));
    expect(lastSql()).toBe(
      'SELECT "_id", "_created_at", "_updated_at", "title", "price" FROM "books" WHERE "_id" = ?',
    );
  });
});

describe("SQ-M1 完了条件2: 別のソースを渡すと FROM がそのソースに置き換わる", () => {
  test("listRecords: FROM が差し替わり、行もそのソースから返る", () => {
    const recording = recordingDatabase(db, sqls);
    const rows = unwrap(
      listRecords(recording, manifest, "books", {}, { table: booksTable, from: '"shelf"' }),
    );
    expect(lastSql()).toBe(
      'SELECT "_id", "_created_at", "_updated_at", "title", "price" FROM "shelf" ORDER BY "_created_at" ASC, "_id" ASC',
    );
    expect(rows.map((row) => row.title)).toEqual(["棚の本"]);
  });

  test("listRecords: 副問合せもソースとして渡せる(SQ-M2 の投影がこの形になる)", () => {
    const recording = recordingDatabase(db, sqls);
    const from =
      '(SELECT "_id" AS "_id", "_created_at" AS "_created_at", "_updated_at" AS "_updated_at", "title" AS "title", "price" AS "price" FROM "shelf")';
    const rows = unwrap(listRecords(recording, manifest, "books", {}, { table: booksTable, from }));
    expect(lastSql()).toContain(`FROM ${from}`);
    expect(rows).toEqual([
      {
        _id: "s1",
        _created_at: "2026-01-01T00:00:00.000Z",
        _updated_at: "2026-01-01T00:00:00.000Z",
        title: "棚の本",
        price: 300,
      },
    ]);
  });

  test("countRecords / countAndSumRecords も FROM が差し替わる", () => {
    const recording = recordingDatabase(db, sqls);
    expect(
      unwrap(
        countRecords(recording, manifest, "books", {}, { table: booksTable, from: '"shelf"' }),
      ),
    ).toBe(1);
    expect(lastSql()).toBe('SELECT COUNT(*) AS n FROM "shelf"');
    expect(
      unwrap(
        countAndSumRecords(
          recording,
          manifest,
          "books",
          { sumField: "price" },
          { table: booksTable, from: '"shelf"' },
        ),
      ),
    ).toEqual({ count: 1, sum: 300 });
    expect(lastSql()).toBe('SELECT COUNT(*) AS n, SUM("price") AS s FROM "shelf"');
  });

  test("getRecord も FROM が差し替わる(selectRow は通らない)", () => {
    const recording = recordingDatabase(db, sqls);
    const row = unwrap(
      getRecord(recording, manifest, "books", "s1", { table: booksTable, from: '"shelf"' }),
    );
    expect(lastSql()).toBe(
      'SELECT "_id", "_created_at", "_updated_at", "title", "price" FROM "shelf" WHERE "_id" = ?',
    );
    expect(row?.title).toBe("棚の本");
  });

  test("マニフェストに無いテーブルIDでも、解決済み Table を渡せば読める(findTable を迂回する)", () => {
    const recording = recordingDatabase(db, sqls);
    // `_apps` はマニフェストに載らない。引数を渡さなければ unknownTableError になる。
    expect(listRecords(recording, manifest, "_apps").ok).toBe(false);
    const rows = unwrap(
      listRecords(recording, manifest, "_apps", {}, { table: booksTable, from: '"shelf"' }),
    );
    expect(rows.map((row) => row.title)).toEqual(["棚の本"]);
  });

  test("既定の並びも差し替えられる(SQ-M2 が今日の既定順を保つために使う)", () => {
    const recording = recordingDatabase(db, sqls);
    unwrap(
      listRecords(
        recording,
        manifest,
        "books",
        {},
        { table: booksTable, from: '"shelf"', defaultOrderBy: '"title" DESC' },
      ),
    );
    expect(lastSql()).toBe(
      'SELECT "_id", "_created_at", "_updated_at", "title", "price" FROM "shelf" ORDER BY "title" DESC',
    );
  });

  test("sort を明示したら、差し替えた既定の並びより sort が優先される", () => {
    const recording = recordingDatabase(db, sqls);
    unwrap(
      listRecords(
        recording,
        manifest,
        "books",
        { sort: { field: "price", order: "asc" } },
        { table: booksTable, from: '"shelf"', defaultOrderBy: '"title" DESC' },
      ),
    );
    expect(lastSql()).toBe(
      'SELECT "_id", "_created_at", "_updated_at", "title", "price" FROM "shelf" ORDER BY "price" ASC, "_created_at" ASC, "_id" ASC',
    );
  });
});

describe("SQ-M1: 書き込み経路は「解決しないこと」のまま(ADR-0006 §8)", () => {
  test("createRecord はシステムテーブルIDを解決前に拒否する", () => {
    const recording = recordingDatabase(db, sqls);
    const result = createRecord(recording, manifest, "_apps", { title: "x" });
    expect(result.ok).toBe(false);
  });
});
