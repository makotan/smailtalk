import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyManifestDdl } from "./ddl.ts";
import type { ValidationError } from "./errors.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { type ReadSource, readRecord, readRecordCount, readRecordList } from "./read-records.ts";
import { createRecord, listRecords } from "./records.ts";
import type { Manifest } from "./types.ts";

/**
 * 読み取りファサード(ADR-0006 §7b)のテスト。
 *
 * 重点は3つ:
 * 1. `listRecords` / `getRecord` / `countRecords` の**3本すべて**が覆われていること
 *    (`countRecords` を落とすと MCP `list_records` が必ず失敗する)
 * 2. `_changelog` が**全アプリ横断**で intent 付きに返り、`app_id` で絞り込めること
 * 3. sort / filter のエラー文面・`allowed_values` が既存の `records.ts` 経路と一致すること
 *
 * ## 既定順について(SQ-M5。**このファイルは既定順の担保ではない**)
 *
 * 下の検査のうち**7本**は、`sort` を渡さずに読んだ結果の**並びに依存している**:
 *
 *   1. `実在するアプリを台帳の順で返す`
 *   2. `システム列は app_id / created_at から埋まる(ADR-0006 §6)`(先頭の行を見る)
 *   3. `全アプリ横断で intent 付きに返る(ADR-0006 §6b)`
 *   4. `kind / undo_target_seq がそのまま投影される`(0番目と2番目の行を見る)
 *   5. `システム列は seq / applied_at から埋まる(ADR-0006 §6)`(先頭の行を見る)
 *   6. `app_id で絞り込める(DoD-4 のアプリ別履歴はこれが唯一の手段)`
 *   7. `3本目を足しても既存2本の投影は取り違えられない`
 *
 * **しかし題材が 2件 / 3件と小さいので、既定順の規則が変わっても偶然そのまま緑になる** ——
 * 例えば `_changelog` の `_id` を文字列として並べても、3件では 1,2,3 のままである。
 * **したがってこの7本を「既定順が守られている証拠」として読んではならない。**
 * **既定順の担保は `system-table-behavior-fixation.test.ts` #5 / #9 にある** ——
 * そちらは**11件**の題材を使い、`applied_at` に同値を含め、しかも時刻を単調増加させて
 * いないので、`seq` 以外の規則で並べた瞬間に赤くなる。
 */

const manifest: Manifest = {
  app: {
    id: "book-tracker",
    name: "蔵書管理",
    tables: [
      {
        id: "books",
        name: "書籍",
        fields: [
          { id: "title", name: "タイトル", type: "text", required: true },
          { id: "status", name: "状態", type: "select", options: ["未読", "読了"] },
        ],
      },
    ],
    views: [],
  },
};

let dataRoot: string;
let store: KernelMetaStore;
let db: Database;
let source: ReadSource;
/** `appDb` が実際に呼ばれた回数(システムテーブルでは 0 でなければならない)。 */
let appDbCalls: number;

function unwrap<T>(result: { ok: true; value: T } | { ok: false; errors: ValidationError[] }): T {
  if (!result.ok) {
    throw new Error(`期待に反して失敗しました: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

function expectErrors(
  result: { ok: true; value: unknown } | { ok: false; errors: ValidationError[] },
): ValidationError[] {
  if (result.ok) {
    throw new Error(`失敗を期待しましたが成功しました: ${JSON.stringify(result.value)}`);
  }
  return result.errors;
}

function only(errors: ValidationError[]): ValidationError {
  expect(errors).toHaveLength(1);
  const error = errors[0];
  if (error === undefined) {
    throw new Error("unreachable");
  }
  return error;
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-read-records-"));
  store = KernelMetaStore.open(dataRoot);
  db = new Database(":memory:");
  applyManifestDdl(db, manifest);
  appDbCalls = 0;
  source = {
    dataRoot,
    appDb: () => {
      appDbCalls += 1;
      return db;
    },
  };

  store.registerApp({
    app_id: "book-tracker",
    name: "蔵書管理",
    created_at: "2026-07-01T00:00:00.000Z",
  });
  store.registerApp({ app_id: "expenses", name: "経費", created_at: "2026-07-02T00:00:00.000Z" });
  store.appendChangelog({
    app_id: "book-tracker",
    diff_id: "d-001",
    intent: "読了日で並べ替えたいので sort を足す",
    operations: [],
    applied_at: "2026-07-03T00:00:00.000Z",
  });
  store.appendChangelog({
    app_id: "expenses",
    diff_id: "d-002",
    intent: "経費の一覧画面がほしい",
    operations: [],
    applied_at: "2026-07-04T00:00:00.000Z",
  });
  store.appendChangelog({
    app_id: "book-tracker",
    diff_id: "d-003",
    intent: "やっぱり戻す",
    operations: [],
    applied_at: "2026-07-05T00:00:00.000Z",
    kind: "undo",
    undo_target_seq: 1,
  });
});

afterEach(async () => {
  store.close();
  db.close();
  await rm(dataRoot, { recursive: true, force: true });
});

describe("ユーザテーブルへの委譲", () => {
  test("一覧・単体・件数が records.ts と同じ結果を返す", () => {
    const created = unwrap(createRecord(db, manifest, "books", { title: "銀河鉄道の夜" }));

    expect(unwrap(readRecordList(source, manifest, "books"))).toEqual(
      unwrap(listRecords(db, manifest, "books")),
    );
    expect(unwrap(readRecord(source, manifest, "books", created._id))?.title).toBe("銀河鉄道の夜");
    expect(unwrap(readRecordCount(source, manifest, "books"))).toBe(1);
  });

  test("存在しないテーブルは既存と同じ「存在しません」で落ちる", () => {
    const error = only(expectErrors(readRecordList(source, manifest, "bookz")));
    expect(error.message).toBe('テーブル "bookz" はこのアプリに存在しません。');
    expect(error.allowed_values).toEqual(["books"]);
  });
});

describe("_apps", () => {
  test("実在するアプリを台帳の順で返す", () => {
    const rows = unwrap(readRecordList(source, manifest, "_apps"));
    expect(rows.map((row) => row.app_id)).toEqual(["book-tracker", "expenses"]);
    expect(rows[0]).toMatchObject({
      app_id: "book-tracker",
      name: "蔵書管理",
      created_at: "2026-07-01T00:00:00.000Z",
      status: "active",
    });
  });

  test("システム列は app_id / created_at から埋まる(ADR-0006 §6)", () => {
    const row = unwrap(readRecordList(source, manifest, "_apps"))[0];
    expect(row?._id).toBe("book-tracker");
    expect(row?._created_at).toBe("2026-07-01T00:00:00.000Z");
    // 追記専用の記録なので _updated_at は _created_at と同じ。仕様である。
    expect(row?._updated_at).toBe(row?._created_at);
  });

  test("_id(= app_id)で単体取得できる", () => {
    expect(unwrap(readRecord(source, manifest, "_apps", "expenses"))?.name).toBe("経費");
  });

  test("存在しない _id は null(エラーではない)", () => {
    expect(unwrap(readRecord(source, manifest, "_apps", "ghost"))).toBeNull();
  });

  test("件数を返す(countRecords を覆っていないと MCP list_records が必ず失敗する)", () => {
    expect(unwrap(readRecordCount(source, manifest, "_apps"))).toBe(2);
  });

  test("読み取りで app.sqlite を開かない(ADR-0006 §7b)", () => {
    unwrap(readRecordList(source, manifest, "_apps"));
    unwrap(readRecord(source, manifest, "_apps", "expenses"));
    unwrap(readRecordCount(source, manifest, "_apps"));
    expect(appDbCalls).toBe(0);
  });

  test("アプリが1つも無くても定義は変わらず、空一覧を返す", async () => {
    const emptyRoot = await mkdtemp(join(tmpdir(), "gp-read-records-empty-"));
    try {
      const emptySource: ReadSource = { dataRoot: emptyRoot, appDb: source.appDb };
      expect(unwrap(readRecordList(emptySource, manifest, "_apps"))).toEqual([]);
      expect(unwrap(readRecordCount(emptySource, manifest, "_apps"))).toBe(0);
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });
});

describe("_changelog", () => {
  test("全アプリ横断で intent 付きに返る(ADR-0006 §6b)", () => {
    const rows = unwrap(readRecordList(source, manifest, "_changelog"));
    expect(rows.map((row) => row.app_id)).toEqual(["book-tracker", "expenses", "book-tracker"]);
    expect(rows.map((row) => row.intent)).toEqual([
      "読了日で並べ替えたいので sort を足す",
      "経費の一覧画面がほしい",
      "やっぱり戻す",
    ]);
  });

  test("閲覧中のアプリによって内容が変わらない(v0 の非目標)", () => {
    const other: Manifest = { app: { id: "expenses", name: "経費", tables: [], views: [] } };
    expect(unwrap(readRecordList(source, manifest, "_changelog"))).toEqual(
      unwrap(readRecordList(source, other, "_changelog")),
    );
  });

  test("kind / undo_target_seq がそのまま投影される", () => {
    const rows = unwrap(readRecordList(source, manifest, "_changelog"));
    expect(rows[0]).toMatchObject({ kind: "apply", undo_target_seq: null, seq: 1 });
    expect(rows[2]).toMatchObject({ kind: "undo", undo_target_seq: 1 });
  });

  test("システム列は seq / applied_at から埋まる(ADR-0006 §6)", () => {
    const row = unwrap(readRecordList(source, manifest, "_changelog"))[0];
    expect(row?._id).toBe("1");
    expect(row?._created_at).toBe("2026-07-03T00:00:00.000Z");
    expect(row?._updated_at).toBe(row?._created_at);
  });

  test("_id(= seq の文字列)で単体取得できる", () => {
    expect(unwrap(readRecord(source, manifest, "_changelog", "2"))?.diff_id).toBe("d-002");
  });

  test("app_id で絞り込める(DoD-4 のアプリ別履歴はこれが唯一の手段)", () => {
    const rows = unwrap(
      readRecordList(source, manifest, "_changelog", {
        filter: [{ field: "app_id", equals: "book-tracker" }],
      }),
    );
    expect(rows.map((row) => row.diff_id)).toEqual(["d-001", "d-003"]);
  });

  test("複数条件の filter は AND になる", () => {
    const rows = unwrap(
      readRecordList(source, manifest, "_changelog", {
        filter: [
          { field: "app_id", equals: "book-tracker" },
          { field: "kind", equals: "apply" },
        ],
      }),
    );
    expect(rows.map((row) => row.diff_id)).toEqual(["d-001"]);
  });

  test("数値フィールドでも絞り込める", () => {
    const rows = unwrap(
      readRecordList(source, manifest, "_changelog", { filter: [{ field: "seq", equals: 3 }] }),
    );
    expect(rows.map((row) => row.diff_id)).toEqual(["d-003"]);
  });

  test("filter の結果は countRecords には影響しない(既存 records.ts と同じ)", () => {
    expect(unwrap(readRecordCount(source, manifest, "_changelog"))).toBe(3);
  });
});

describe("sort(投影の SQL)", () => {
  test("フィールドの降順で並べ替えられる", () => {
    const rows = unwrap(
      readRecordList(source, manifest, "_changelog", { sort: { field: "seq", order: "desc" } }),
    );
    expect(rows.map((row) => row.seq)).toEqual([3, 2, 1]);
  });

  test("システム列でも並べ替えられる(ADR-0006 §7b: 既存の非対称をそのまま写す)", () => {
    const rows = unwrap(
      readRecordList(source, manifest, "_apps", { sort: { field: "_id", order: "desc" } }),
    );
    expect(rows.map((row) => row._id)).toEqual(["expenses", "book-tracker"]);
  });

  test("_updated_at でのソートは _created_at と同じ順になる(仕様)", () => {
    const byUpdated = unwrap(
      readRecordList(source, manifest, "_changelog", {
        sort: { field: "_updated_at", order: "desc" },
      }),
    );
    const byCreated = unwrap(
      readRecordList(source, manifest, "_changelog", {
        sort: { field: "_created_at", order: "desc" },
      }),
    );
    expect(byUpdated).toEqual(byCreated);
  });

  test("存在しないフィールドは既存経路と同じ文面・allowed_values で拒否される", () => {
    const error = only(
      expectErrors(
        readRecordList(source, manifest, "_apps", { sort: { field: "ghost", order: "asc" } }),
      ),
    );
    expect(error.path).toBe("/sort/field");
    expect(error.message).toBe(
      '並び順に指定されたフィールド "ghost" はテーブル "_apps" に存在しません。',
    );
    expect(error.allowed_values).toEqual([
      "app_id",
      "name",
      "created_at",
      "status",
      "_id",
      "_created_at",
      "_updated_at",
    ]);
    expect(error.hint).toBe('テーブル "_apps" に実在するフィールドIDを指定してください。');
  });

  test("文面と allowed_values の組み立て方が records.ts 経路と一致する", () => {
    const viaFacade = only(
      expectErrors(
        readRecordList(source, manifest, "books", { sort: { field: "ghost", order: "asc" } }),
      ),
    );
    const viaRecords = only(
      expectErrors(listRecords(db, manifest, "books", { sort: { field: "ghost", order: "asc" } })),
    );
    expect(viaFacade).toEqual(viaRecords);
  });
});

describe("filter(投影の SQL)", () => {
  test("システム列は filter に使えない(既存の非対称をそのまま写す)", () => {
    const error = only(
      expectErrors(
        readRecordList(source, manifest, "_apps", { filter: [{ field: "_id", equals: "x" }] }),
      ),
    );
    expect(error.path).toBe("/filter/0/field");
    expect(error.message).toBe(
      '絞り込みに指定されたフィールド "_id" はテーブル "_apps" に存在しません。',
    );
    expect(error.allowed_values).toEqual(["app_id", "name", "created_at", "status"]);
    expect(error.hint).toBe('テーブル "_apps" に実在するフィールドIDを指定してください。');
  });

  test("select の選択肢外は値検証で拒否され、選択肢が allowed_values に載る", () => {
    const error = only(
      expectErrors(
        readRecordList(source, manifest, "_changelog", {
          filter: [{ field: "kind", equals: "rollback" }],
        }),
      ),
    );
    expect(error.path).toBe("/filter/0/equals");
    expect(error.message).toBe('フィールド "kind" に選択肢にない値 "rollback" が指定されました。');
    // ADR-0032(V1-M9-T05)で redo を足したので3値。
    expect(error.allowed_values).toEqual(["apply", "undo", "redo"]);
  });

  test("型違いは既存と同じ文面で拒否される", () => {
    const error = only(
      expectErrors(
        readRecordList(source, manifest, "_changelog", {
          filter: [{ field: "seq", equals: "1" }],
        }),
      ),
    );
    expect(error.path).toBe("/filter/0/equals");
    expect(error.message).toContain("数値(number)");
    expect(error.hint).toBe('このフィールドの型は "number" です。');
  });

  test("値検証の文面が records.ts 経路と一致する", () => {
    const viaFacade = only(
      expectErrors(
        readRecordList(source, manifest, "books", {
          filter: [{ field: "status", equals: "積読" }],
        }),
      ),
    );
    const viaRecords = only(
      expectErrors(
        listRecords(db, manifest, "books", { filter: [{ field: "status", equals: "積読" }] }),
      ),
    );
    expect(viaFacade).toEqual(viaRecords);
  });

  test("sort と filter の違反は全件まとめて返る", () => {
    const errors = expectErrors(
      readRecordList(source, manifest, "_apps", {
        sort: { field: "ghost", order: "asc" },
        filter: [{ field: "nope", equals: "x" }],
      }),
    );
    expect(errors.map((error) => error.path).sort()).toEqual(["/filter/0/field", "/sort/field"]);
  });
});

describe("ブール式フィルタ(投影の SQL。EC-G12 / ADR-0043)", () => {
  const diffIds = (rows: Record<string, unknown>[]): string[] =>
    rows.map((r) => r.diff_id as string).sort();

  test("and で AND 結合できる", () => {
    const rows = unwrap(
      readRecordList(source, manifest, "_changelog", {
        filter: {
          and: [
            { field: "app_id", equals: "book-tracker" },
            { field: "kind", equals: "undo" },
          ],
        },
      }),
    );
    expect(diffIds(rows)).toEqual(["d-003"]);
  });

  test("or で OR 結合できる", () => {
    const rows = unwrap(
      readRecordList(source, manifest, "_changelog", {
        filter: {
          or: [
            { field: "kind", equals: "undo" },
            { field: "app_id", equals: "expenses" },
          ],
        },
      }),
    );
    expect(diffIds(rows)).toEqual(["d-002", "d-003"]);
  });

  test("not で否定できる", () => {
    const rows = unwrap(
      readRecordList(source, manifest, "_changelog", {
        filter: { not: { field: "app_id", equals: "book-tracker" } },
      }),
    );
    expect(diffIds(rows)).toEqual(["d-002"]);
  });

  test("gte / lte で比較できる", () => {
    const gte = unwrap(
      readRecordList(source, manifest, "_changelog", { filter: { field: "seq", gte: 2 } }),
    );
    expect(diffIds(gte)).toEqual(["d-002", "d-003"]);
    const lte = unwrap(
      readRecordList(source, manifest, "_changelog", { filter: { field: "seq", lte: 1 } }),
    );
    expect(diffIds(lte)).toEqual(["d-001"]);
  });

  test("in で複数値のいずれかに一致する", () => {
    const rows = unwrap(
      readRecordList(source, manifest, "_changelog", {
        filter: { field: "app_id", in: ["expenses"] },
      }),
    );
    expect(diffIds(rows)).toEqual(["d-002"]);
  });

  test("contains で部分一致できる", () => {
    const rows = unwrap(
      readRecordList(source, manifest, "_changelog", {
        filter: { field: "intent", contains: "戻す" },
      }),
    );
    expect(diffIds(rows)).toEqual(["d-003"]);
  });

  test("ネストしたブール式を評価できる", () => {
    const rows = unwrap(
      readRecordList(source, manifest, "_changelog", {
        filter: {
          and: [
            { field: "app_id", equals: "book-tracker" },
            { not: { field: "kind", equals: "undo" } },
          ],
        },
      }),
    );
    expect(diffIds(rows)).toEqual(["d-001"]);
  });

  test("ネスト深度上限を超える filter は拒否される", () => {
    let node: unknown = { field: "seq", equals: 1 };
    for (let i = 0; i < 20; i += 1) {
      node = { not: node };
    }
    const errors = expectErrors(
      readRecordList(source, manifest, "_changelog", {
        filter: node as never,
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  // **【SQ-M4 で名前を直した。これが今回の一本化の発端である】**
  // 旧名は「SQL 経路とメモリ経路が同一入力で同一結果を返す(books)」だった。**嘘である** ——
  // `books` はユーザテーブルなので、`readRecordList` も `listRecords` も**同じ SQL 経路**を
  // 通る。**2つの実装を突き合わせた検査は1本も無かった。** ファサードが素通しであることは
  // 確かめているので、検査は残して名前だけを実際に測っているものへ直す。
  test("ファサードはユーザテーブルの filter を listRecords へ素通しする(books)", () => {
    unwrap(createRecord(db, manifest, "books", { title: "赤", status: "未読" }));
    unwrap(createRecord(db, manifest, "books", { title: "青", status: "読了" }));
    unwrap(createRecord(db, manifest, "books", { title: "緑", status: "未読" }));
    const filter = {
      or: [
        { field: "status", equals: "読了" },
        { field: "title", contains: "赤" },
      ],
    };
    // books はユーザテーブルなので readRecordList は listRecords(SQL 経路)へ委譲する。
    const viaFacade = unwrap(readRecordList(source, manifest, "books", { filter }));
    const viaRecords = unwrap(listRecords(db, manifest, "books", { filter }));
    expect(viaFacade).toEqual(viaRecords);
    expect(viaFacade.map((r) => r.title as string).sort()).toEqual(["赤", "青"].sort());
  });
});

describe("解決できないテーブル", () => {
  test("システムテーブル風の未定義IDは「存在しません」で落ちる", () => {
    const error = only(expectErrors(readRecordList(source, manifest, "_snapshots")));
    expect(error.message).toBe('テーブル "_snapshots" はこのアプリに存在しません。');
  });
});

// --- V1-M2-T06: 投影解決の是正 -------------------------------------------------

/**
 * **3つ目のシステムテーブルが在る世界を、実際に作って読む。**
 *
 * 是正前の投影の解決は `tableId === "_apps" ? apps : changelog` という三項演算子で、
 * **else 節が `_changelog` を暗黙に受けていた。**システムテーブルが2本の間は正しく動くが、
 * 3本目を足した瞬間、**`_apps` 以外のすべてが changelog として投影される** ——
 * しかもエラーにならず、黙って別テーブルの中身が返る。
 *
 * `SYSTEM_TABLES.length === 2` を assert するテストではこの壊れ方は捕まらない
 * (同語反復であり、2本のうちは常に緑になる)。**3本目を本当に注入して読む**必要がある。
 *
 * ## なぜ子プロセスなのか
 *
 * `src/shared/system-tables.ts` は変更禁止(ADR-0013 限定9。`SYSTEM_TABLES` は
 * `_apps` / `_changelog` の2本のままでなければならない)なので、注入は実行時に行うしかない。
 * `mock.module` は**モジュール登録簿を差し替え、既存の import 束縛にも及ぶ**ため、
 * 同一プロセス内の他のテストファイルにまで「3本目がある世界」が漏れる。
 * `recovery.test.ts` が確立した手口(注入は子プロセスの中だけで行う)をそのまま踏襲する。
 * **製品コードにテスト用のフックは1バイトも入れていない**ので、
 * 「テスト専用の口があるから通った」という抜け道が生まれない。
 *
 * 投影の解決は export されていない(ADR-0007 Δ8 は発火しない)。
 * 検査は公開API 3本(`readRecordList` / `readRecord` / `readRecordCount`)越しに行う ——
 * **3本とも同じ解決を通るので、1箇所の是正に3本とも追随することが同時に示せる。**
 */
const KERNEL_DIR = import.meta.dir;
const SHARED_DIR = resolve(import.meta.dir, "../shared");

type Attempt = { returned?: unknown; threw?: string };
type ProbeResult = {
  systemTableIds: string[];
  list: Attempt;
  record: Attempt;
  count: Attempt;
};

/**
 * 子プロセス用スクリプトを書き出す。
 * リポジトリにファイルを増やさないため、テスト用の一時ディレクトリへ生成して使い捨てる。
 */
function writeThirdTableHarness(): string {
  const path = join(dataRoot, "third-system-table.ts");
  writeFileSync(
    path,
    `
import { mock } from "bun:test";

const SHARED = ${JSON.stringify(SHARED_DIR)};
const KERNEL = ${JSON.stringify(KERNEL_DIR)};

// mock を張る**前に**実体を退避する(張った後に読むと差し替え後が返る)。
const real = await import(SHARED + "/system-tables.ts");

/** 3つ目のシステムテーブル。既存2本のどちらとも列が重ならない形にしてある。 */
const PROBE_TABLE = {
  id: "_probe",
  name: "3つ目のシステムテーブル(テスト注入)",
  fields: [{ id: "probe_id", name: "ID", type: "text", required: true }],
};

const tables = [...real.SYSTEM_TABLES, PROBE_TABLE];
const ids = tables.map((table) => table.id);

// read-records.ts は isSystemTableId を、resolve-table.ts は findSystemTable を
// このモジュールから引く。両方まとめて差し替えるので、"_probe" は
// **本物のシステムテーブルとして**両方の関門を通り、投影の解決に到達する。
mock.module(SHARED + "/system-tables.ts", () => ({
  SYSTEM_TABLES: tables,
  SYSTEM_TABLE_IDS: ids,
  isSystemTableId: (id) => ids.includes(id),
  findSystemTable: (id) => tables.find((table) => table.id === id),
}));

const readRecords = await import(KERNEL + "/read-records.ts");

const [root] = process.argv.slice(2);
const manifest = { app: { id: "probe-app", name: "probe", tables: [], views: [] } };
const source = {
  dataRoot: root,
  appDb: () => {
    throw new Error("システムテーブルの読み取りで app.sqlite を開いてはならない");
  },
};

function attempt(run) {
  try {
    return { returned: run() };
  } catch (error) {
    return { threw: error instanceof Error ? error.message : String(error) };
  }
}

console.log(
  "PROBE_RESULT " +
    JSON.stringify({
      systemTableIds: ids,
      list: attempt(() => readRecords.readRecordList(source, manifest, "_probe")),
      record: attempt(() => readRecords.readRecord(source, manifest, "_probe", "2")),
      count: attempt(() => readRecords.readRecordCount(source, manifest, "_probe")),
    }),
);
`,
    "utf-8",
  );
  return path;
}

/** 3本目を注入した子プロセスを走らせ、公開API 3本の結果を回収する。 */
function readThirdSystemTable(): ProbeResult {
  const proc = Bun.spawnSync({
    cmd: ["bun", "run", writeThirdTableHarness(), dataRoot],
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  const line = stdout.split("\n").find((candidate) => candidate.startsWith("PROBE_RESULT "));
  if (line === undefined) {
    throw new Error(
      `子プロセスが結果を返しませんでした(exit=${String(proc.exitCode)})。\n` +
        `stdout: ${stdout}\nstderr: ${proc.stderr.toString()}`,
    );
  }
  return JSON.parse(line.slice("PROBE_RESULT ".length)) as ProbeResult;
}

describe("V1-M2-T06: システムテーブルが3つ以上になっても投影が正しく解決される", () => {
  test("注入が効いており、子プロセスの中では本当にシステムテーブルが3本ある", () => {
    expect(readThirdSystemTable().systemTableIds).toEqual([
      "_apps",
      "_changelog",
      "_ai_usage",
      "_probe",
    ]);
  });

  test("3つ目を読んでも changelog は返らない(暗黙の else 節が無い)", () => {
    const probe = readThirdSystemTable();
    // 是正前はここに changelog の3行がそのまま返っていた。
    const listed = JSON.stringify(probe.list.returned ?? null);
    expect(listed).not.toContain("読了日で並べ替えたいので sort を足す");
    expect(listed).not.toContain("d-001");
    expect(probe.list.returned).toBeUndefined();
  });

  test("未知のシステムテーブルIDは沈黙せずに落ちる(空も返さない)", () => {
    const probe = readThirdSystemTable();
    expect(probe.list.threw).toContain("_probe");
    expect(probe.list.threw).toContain("投影");
  });

  test("readRecordList / readRecord / readRecordCount の3本とも追随する", () => {
    const probe = readThirdSystemTable();
    // 3本は同じ投影の解決を通る。1本でも別経路になっていればここで割れる。
    expect(probe.record.threw).toBe(probe.list.threw);
    expect(probe.count.threw).toBe(probe.list.threw);
    // どれも「黙って何かを返す」ことをしない。
    expect(probe.record.returned).toBeUndefined();
    expect(probe.count.returned).toBeUndefined();
  });

  test("3本目を足しても既存2本の投影は取り違えられない", () => {
    // 「未知は落とす」だけを入れて `_apps` / `_changelog` の解決を壊していないことの確認。
    expect(unwrap(readRecordList(source, manifest, "_apps")).map((row) => row.app_id)).toEqual([
      "book-tracker",
      "expenses",
    ]);
    expect(
      unwrap(readRecordList(source, manifest, "_changelog")).map((row) => row.diff_id),
    ).toEqual(["d-001", "d-002", "d-003"]);
  });
});

describe("ページネーション(投影の SQL。EC-G11 / ADR-0042)", () => {
  test("limit で先頭 N 件に絞る(_changelog を seq 昇順で)", () => {
    const rows = unwrap(
      readRecordList(source, manifest, "_changelog", {
        sort: { field: "seq", order: "asc" },
        limit: 2,
      }),
    );
    expect(rows.map((r) => r.diff_id)).toEqual(["d-001", "d-002"]);
  });

  test("offset で先頭をスキップする", () => {
    const rows = unwrap(
      readRecordList(source, manifest, "_changelog", {
        sort: { field: "seq", order: "asc" },
        offset: 1,
      }),
    );
    expect(rows.map((r) => r.diff_id)).toEqual(["d-002", "d-003"]);
  });

  test("limit + offset で任意のページを取れる", () => {
    const rows = unwrap(
      readRecordList(source, manifest, "_changelog", {
        sort: { field: "seq", order: "asc" },
        limit: 1,
        offset: 1,
      }),
    );
    expect(rows.map((r) => r.diff_id)).toEqual(["d-002"]);
  });

  test("limit=0 は0件(境界)", () => {
    expect(unwrap(readRecordList(source, manifest, "_apps", { limit: 0 }))).toEqual([]);
  });

  test("offset が総件数を超えると空配列", () => {
    expect(unwrap(readRecordList(source, manifest, "_apps", { offset: 99 }))).toEqual([]);
  });

  test("非整数の limit を統一形式エラーで拒否する(/limit)", () => {
    const error = only(expectErrors(readRecordList(source, manifest, "_apps", { limit: 1.5 })));
    expect(error.path).toBe("/limit");
  });

  test("負の offset を拒否する(/offset)", () => {
    const error = only(expectErrors(readRecordList(source, manifest, "_apps", { offset: -1 })));
    expect(error.path).toBe("/offset");
  });

  test("readRecordCount は filter 適用後の件数を返す(total 整合・システムテーブル)", () => {
    // _changelog は3件。seq>=2 は2件。
    expect(
      unwrap(readRecordCount(source, manifest, "_changelog", { filter: { field: "seq", gte: 2 } })),
    ).toBe(2);
    // filter 無しは全件。
    expect(unwrap(readRecordCount(source, manifest, "_changelog"))).toBe(3);
  });

  test("readRecordCount は filter を受けて絞り込み後の件数を返す(ユーザテーブル委譲)", () => {
    unwrap(createRecord(db, manifest, "books", { title: "A", status: "未読" }));
    unwrap(createRecord(db, manifest, "books", { title: "B", status: "読了" }));
    expect(
      unwrap(
        readRecordCount(source, manifest, "books", {
          filter: [{ field: "status", equals: "読了" }],
        }),
      ),
    ).toBe(1);
  });
});
