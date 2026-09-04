/**
 * 拒否された差分に副作用が無いこと(V0-P4-T03 / V1-M1-T03 で改訂)。
 *
 * 憲法2「語彙は狭く」/ 憲法4「常に戻せる」を **apply_diff の入口で**保証している
 * ことのテスト。個々の検証(スキーマ・畳み込み・参照整合性・変換可否)がどこに
 * 置かれていようと、**「拒否された差分は1バイトも状態を変えない」**という外形的
 * 性質はこの層で固定する。
 *
 * ## V1-M1(ADR-0010)で何が変わり、何が変わらなかったか
 *
 * **ファイル名は変えていない。** 破壊的 op が語彙に入っても、**拒否される破壊的
 * 差分は依然として存在する**(存在しないテーブルを対象にした remove_field、
 * システムテーブルを対象にした op、参照整合性違反、変換不能値)。
 *
 * **主張は1つだけ書き換えた。** 旧: 「破壊的**意図**を持つ差分は1バイトも状態を
 * 変えずに拒否される」→ 新: 「**拒否された**差分は1バイトも状態を変えない」。
 * **「どの差分が拒否されるか」が M1 で変わっただけで、「拒否の副作用が無い」という
 * 性質は M1 の中心的な保証そのものである**(ADR-0010 §8)。
 *
 * ## このテストが守る不変条件(ADR-0010 §8 の書き分け)
 *
 * 拒否ケースはすべて次の4点を同時に満たすこと。
 *
 * 1. **保たれる。** 統一形式 `ValidationError[]`(path / message を持つ)で返る
 * 2. **数が 4 → 8 に変わった。性質は保たれる。** 語彙外 op の場合は
 *    `allowed_values` に**差分 op の全種**が入る。**期待値は `DIFF_OPS` から
 *    組み立てて照合する** —— 数を手書きすると次の改訂で嘘になる。あわせて
 *    **語彙外 op の例を差し替えた** —— `remove_field` は M1 後は語彙内なので、
 *    `remove_app` / `patch_manifest` のように **今も語彙外であるもの**を使う。
 *    **`remove_view` は ADR-0012 で門A を通って語彙内になったため、題材から外した。**
 * 3. **拒否ケースでは保たれる。** マニフェスト(バイト列)・SQLite の実スキーマ・
 *    データ・changelog がすべて不変。
 *    **このテストの主張はもともと「*拒否されたら* 不変」であり、成功ケースを
 *    縛っていない**(ADR-0010 §8 がこの限定を明示せよと指定した)。M1 後は
 *    `remove_field` が**成功して**列とデータを実際に消す —— それはこのファイルの
 *    主張と矛盾しない。成功系の固定は `apply-diff.test.ts` の完了条件A〜D にある
 * 4. **保たれる。これが M1 の設計要求になった。** スナップショットディレクトリが
 *    1つも作られていない。ADR-0010 §6b が変換可否の判定をスナップショット取得より
 *    **前**に置いたため、**変換不能値による中止でも**4 が成立する
 *    (`describe("破壊的 op の拒否でも副作用が無い")` で固定した)
 *
 * ## 破壊的でないもの
 *
 * `update_view` の `columns` から既存フィールドを外す差し替えは **正当**である
 * (テスト内で理由をコメントしている)。ここを拒否に倒すと、唯一の「画面を
 * 調整する」手段が失われる。実挙動を確認したうえで「通ること」を固定している。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff, foldOperations } from "./apply-diff.ts";
import { applyManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import type { ValidationError } from "./errors.ts";
import { type ChangelogEntry, KernelMetaStore } from "./meta-store.ts";
import { createRecord, listRecords, type RecordRow } from "./records.ts";
import { appDbPath, appManifestPath, appSnapshotsDir, snapshotDir } from "./storage-paths.ts";
import { DIFF_OPS, type Manifest, type Operation } from "./types.ts";

const APP_ID = "book-tracker";

/**
 * 語彙外 op のエラーが返さなければならない許可値。
 *
 * **`DIFF_OPS` から組み立てる**(ADR-0010 §8 の変更方針(a))。v0 では additive 4種を
 * 手書きしていたが、**数を手書きすると次の改訂で嘘になる**。`vocabulary.ts` が
 * 既に採っている手口をここでも使う。
 */
const ALL_OPS: string[] = [...DIFF_OPS];

let dataRoot: string;
let store: KernelMetaStore;

/** 蔵書管理アプリの初期マニフェスト(テーブル1・ビュー2)。 */
function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "蔵書管理",
      tables: [
        {
          id: "books",
          name: "本",
          fields: [
            { id: "title", name: "タイトル", type: "text", required: true },
            { id: "memo", name: "メモ", type: "long_text" },
            { id: "status", name: "状態", type: "select", options: ["未読", "読了"] },
          ],
        },
      ],
      views: [
        {
          id: "book-list",
          type: "list_view",
          table: "books",
          columns: ["title", "memo", "status"],
        },
        { id: "book-form", type: "form", table: "books", fields: ["title", "memo", "status"] },
      ],
    },
  };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-destructive-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "蔵書管理", { app_id: APP_ID });
  const applied = applyManifest(dataRoot, APP_ID, baseManifest());
  if (!applied.valid) {
    throw new Error("テスト前提の初期マニフェスト投入に失敗しました。");
  }
  // 「拒否してもデータが無傷」を意味のあるアサートにするため、実データを入れておく。
  seedBook({ title: "銀河ヒッチハイク・ガイド", memo: "42", status: "読了" });
  seedBook({ title: "存在の耐えられない軽さ", memo: "", status: "未読" });
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

/** ディスク上の manifest.json をパースして読む。 */
function readManifestFile(): Manifest {
  return JSON.parse(readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8")) as Manifest;
}

/** manifest.json のバイト列(不変アサート用。整形の揺れも含めて比較する)。 */
function readManifestText(): string {
  return readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8");
}

/** app.sqlite の実スキーマ(テーブル→列名の並び)を PRAGMA で読む。 */
function readSchema(): Record<string, string[]> {
  return withDb((db) => {
    const tables = db
      .query<{ name: string }, []>(
        `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%' ORDER BY "name"`,
      )
      .all()
      .map((row) => row.name);
    const schema: Record<string, string[]> = {};
    for (const table of tables) {
      schema[table] = db
        .query<{ name: string }, []>(`PRAGMA table_info("${table}")`)
        .all()
        .map((row) => row.name);
    }
    return schema;
  });
}

/** アプリDBを開いて処理する(呼び出しごとに閉じる)。 */
function withDb<T>(fn: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** books テーブルへレコードを1件入れる。 */
function seedBook(input: Record<string, unknown>): RecordRow {
  return withDb((db) => {
    const result = createRecord(db, readManifestFile(), "books", input);
    if (!result.ok) {
      throw new Error(`テスト前提のレコード投入に失敗しました: ${JSON.stringify(result.errors)}`);
    }
    return result.value;
  });
}

/** books テーブルの全件を _id 昇順で読む。 */
function allBooks(): RecordRow[] {
  return withDb((db) => {
    const result = listRecords(db, readManifestFile(), "books");
    if (!result.ok) {
      throw new Error(`レコード一覧に失敗しました: ${JSON.stringify(result.errors)}`);
    }
    return [...result.value].sort((a, b) => a._id.localeCompare(b._id));
  });
}

/** changelog の現在の内容(別接続で読む。applyDiff は自前で store を開くため)。 */
function readChangelog(): ChangelogEntry[] {
  const reader = KernelMetaStore.open(dataRoot);
  try {
    return reader.listChangelog(APP_ID);
  } finally {
    reader.close();
  }
}

/** スナップショットディレクトリ名の一覧(未作成なら空配列)。 */
function listSnapshotDirs(): string[] {
  const dir = appSnapshotsDir(dataRoot, APP_ID);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** 不変性を比較するために、観測可能な状態をまとめて1つの値にする。 */
type ObservedState = {
  manifestText: string;
  schema: Record<string, string[]>;
  records: RecordRow[];
  changelog: ChangelogEntry[];
  snapshots: string[];
};

function observe(): ObservedState {
  return {
    manifestText: readManifestText(),
    schema: readSchema(),
    records: allBooks(),
    changelog: readChangelog(),
    snapshots: listSnapshotDirs(),
  };
}

/**
 * 破壊的意図を持つ差分を適用しようとして、**確実に拒否され状態が不変である**ことを
 * まとめてアサートするヘルパ。返り値は拒否理由(個別ケースでさらに中身を見る用)。
 *
 * `diff` は `unknown` として渡す。applyDiff の入口が `unknown` を受けるため、
 * 語彙外 op(`remove_field` 等)を書くのに型を外す(`as`)必要はない。
 * v0 の `Operation` 型に存在しない op を型レベルで作れないこと自体が
 * 「語彙として存在しない」ことの証明でもある。
 */
function expectRejected(diff: unknown): ValidationError[] {
  const before = observe();
  // 前提: この時点でスナップショットは1つも無い(拒否テストの土台)。
  expect(before.snapshots).toEqual([]);

  const result = applyDiff(dataRoot, APP_ID, diff);

  expect(result.valid).toBe(false);
  if (result.valid) {
    throw new Error("破壊的な差分が適用されてしまいました。");
  }

  // 1. 統一形式で返る(必ず1件以上。path / message を持つ)。
  expect(result.errors.length).toBeGreaterThan(0);
  for (const error of result.errors) {
    expect(typeof error.path).toBe("string");
    expect(typeof error.message).toBe("string");
    expect(error.message.length).toBeGreaterThan(0);
  }

  // 3. マニフェスト・スキーマ・データ・changelog が不変。
  const after = observe();
  expect(after.manifestText).toBe(before.manifestText);
  expect(after.schema).toEqual(before.schema);
  expect(after.records).toEqual(before.records);
  expect(after.changelog).toEqual(before.changelog);

  // 4. スナップショットが1つも作られていない(拒否は取得より前に起きる)。
  expect(after.snapshots).toEqual([]);
  expect(existsSync(snapshotDir(dataRoot, APP_ID, "0001-d-destructive"))).toBe(false);

  return result.errors;
}

/** 語彙外 op のエラー(op の位置に出る)を取り出す。 */
function vocabularyError(errors: ValidationError[], operationIndex: number): ValidationError {
  const error = errors.find((e) => e.path === `/operations/${operationIndex}/op`);
  if (error === undefined) {
    throw new Error(`語彙外 op として拒否されていません。実際のエラー: ${JSON.stringify(errors)}`);
  }
  return error;
}

/** 破壊的意図の差分を作る(diff_id / intent は常に有効な値にして、op だけを問題にする)。 */
function destructiveDiff(operations: unknown[]): unknown {
  return {
    diff_id: "d-destructive",
    intent: "既存の項目を消したいという要望(v0 では表現できないはず)",
    operations,
  };
}

describe("語彙として存在しない op は拒否される(憲法2)", () => {
  // **ここで使う op は「今も語彙外であるもの」でなければならない**(ADR-0010 §8 (b))。
  // remove_field / remove_table / change_table / change_field は M1 で語彙内になり、
  // **`remove_view` は ADR-0012 で門A を通って語彙内になった**ので、いずれも
  // このブロックの題材にはできない。それらの拒否は下の
  // describe("破壊的 op の拒否でも副作用が無い") が扱う。

  test("ケース1: remove_app は語彙にない(ADR-0012 限定1: アプリの削除は審査を受けていない)", () => {
    const errors = expectRejected(destructiveDiff([{ op: "remove_app", table: "books" }]));
    const vocabulary = vocabularyError(errors, 0);
    expect(vocabulary.message).toContain("remove_app");
    // 計画書の要求: 「許可される op: ...」を必ずエラーに含める。
    expect(vocabulary.allowed_values).toEqual(ALL_OPS);
  });

  test("ケース2: patch_manifest(マニフェスト全体の差し替え)は語彙にない", () => {
    // ADR-0010 §3a が憲法5 違反として却下した案。**推論はデータ移行の指定を運べない。**
    const errors = expectRejected(destructiveDiff([{ op: "patch_manifest" }]));
    const vocabulary = vocabularyError(errors, 0);
    expect(vocabulary.message).toContain("patch_manifest");
    expect(vocabulary.allowed_values).toEqual(ALL_OPS);
  });

  test("ケース3: change_type は語彙にない(型変更は change_field の changes.type で表す)", () => {
    // **能力が無いからではなく、綴りが違うから通らない。** この区別を hint が言う。
    const errors = expectRejected(
      destructiveDiff([{ op: "change_type", table: "books", field: "title", type: "number" }]),
    );
    const vocabulary = vocabularyError(errors, 0);
    expect(vocabulary.message).toContain("change_type");
    expect(vocabulary.allowed_values).toEqual(ALL_OPS);
    expect(vocabulary.hint).toContain("change_field");
  });

  test("ケース4: rename_field / rename_table は語彙にない(changes.id で表す)", () => {
    const fieldErrors = expectRejected(
      destructiveDiff([{ op: "rename_field", table: "books", field: "title", to: "book_title" }]),
    );
    expect(vocabularyError(fieldErrors, 0).allowed_values).toEqual(ALL_OPS);

    const tableErrors = expectRejected(
      destructiveDiff([{ op: "rename_table", table: "books", to: "volumes" }]),
    );
    expect(vocabularyError(tableErrors, 0).allowed_values).toEqual(ALL_OPS);
  });

  test("ケース5: set_required / update_field も語彙にない(changes.required で表す)", () => {
    const dedicated = expectRejected(
      destructiveDiff([{ op: "set_required", table: "books", field: "memo", required: true }]),
    );
    expect(vocabularyError(dedicated, 0).allowed_values).toEqual(ALL_OPS);

    const updateField = expectRejected(
      destructiveDiff([
        {
          op: "update_field",
          table: "books",
          field: { id: "memo", name: "メモ", type: "long_text", required: true },
        },
      ]),
    );
    expect(vocabularyError(updateField, 0).allowed_values).toEqual(ALL_OPS);
  });

  test("正当な op に混ぜても、語彙外 op が1つあれば差分全体が拒否される", () => {
    // 部分適用を許さない = 「add_field は通ったが remove_app で落ちた」を作らない。
    const errors = expectRejected(
      destructiveDiff([
        { op: "add_field", table: "books", field: { id: "isbn", name: "ISBN", type: "text" } },
        { op: "remove_app", table: "books" },
      ]),
    );
    expect(vocabularyError(errors, 1).allowed_values).toEqual(ALL_OPS);
    // add_field 側は正当なので、その位置のエラーは出ていない。
    expect(errors.some((e) => e.path.startsWith("/operations/0/"))).toBe(false);
  });

  test("op 語彙は16種で閉じている(型・スキーマ・エラーの三者が一致)", () => {
    // 語彙の正準は schemas/diff.schema.json。types.ts の DIFF_OPS はその写しであり、
    // 語彙外エラーの allowed_values もここから外れてはならない。
    // **V3-M1-T03(ADR-0047)が16種目 set_theme を足した**(§10 の規則1)。
    // **【`V8-M16` / `J-G1b` / `D-V8-31`】期待値を 17 → 18 に書き換えた —— 18種目 `set_roles` を足したため。検査は消していない。**
    // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】**
    // **旧(逐語)**: `expect(DIFF_OPS).toHaveLength(18);`
    // **`set_user_kinds` を撤去したので 18 → 17。**型・スキーマ・エラーの三者が一致していることは
    // 下の `toEqual(ALL_OPS)` が今日も測る(三者一致の主張は1ミリも弱めていない)。
    expect(DIFF_OPS).toHaveLength(17); // 【`V5-M17b` / `ADR-0248`】16 → 17(`set_user_kinds` が17種目)/【`V8-M16`】17 → 18(`set_roles` が18種目)。**この行が固定していたのは「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**
    expect([...DIFF_OPS] as string[]).toEqual(ALL_OPS);
    // ADR-0012 限定1 / ADR-0013 限定2 / ADR-0024 限定9 が名指しで止めているものが、
    // 実際に入っていないこと。
    // **`remove_view` はここから外した** —— ADR-0012 で門A を通ったためであり、
    // 「止めていたものが黙って入った」のではない。
    // **`run_workflow` / `pause_workflow` / `enable_workflow` を足した** —— ADR-0013 が
    // ワークフローを語彙に入れたことで「では動かす op もあるはずだ」という類推の筋が
    // 新しくできた。**`run_function` / `pause_function` / `enable_function` も同じ理由で
    // 足した** —— ADR-0024 が関数を語彙に入れた(ADR-0024 限定9)。
    // **止めているものは、止めた時点で見張りを置く。**
    for (const forbidden of [
      "remove_app",
      "patch_manifest",
      "copy_field",
      "run_workflow",
      "pause_workflow",
      "enable_workflow",
      "run_function",
      "pause_function",
      "enable_function",
    ]) {
      expect(ALL_OPS as string[]).not.toContain(forbidden);
    }
    // 門A を通した7件は、確かに入っている(ADR-0012 の1件・ADR-0013 の3件・ADR-0024 の3件)。
    for (const passed of [
      "remove_view",
      "add_workflow",
      "update_workflow",
      "remove_workflow",
      "add_function",
      "update_function",
      "remove_function",
    ]) {
      expect(ALL_OPS as string[]).toContain(passed);
    }
  });
});

describe("update_view を装った破壊的変更は拒否される", () => {
  test("ケース5: columns を存在しないフィールドへ差し替えると参照切れとして拒否される", () => {
    // 「memo を消す」を "columns を別のIDに差し替える" で偽装したケース。
    // 差し替え先が実在しないので、適用後マニフェストの参照整合性検証で落ちる。
    const errors = expectRejected(
      destructiveDiff([
        { op: "update_view", view: "book-list", changes: { columns: ["title", "ghost"] } },
      ]),
    );
    const error = errors[0];
    expect(error?.path).toBe("/app/views/0/columns/1");
    expect(error?.message).toContain("ghost");
    // 参照切れも「実在する候補」を返して自己修正できるようにする。
    expect(error?.allowed_values).toEqual(["title", "memo", "status"]);
  });

  test("ケース10: sort / filter に存在しないフィールドを指定すると拒否される", () => {
    const sortErrors = expectRejected(
      destructiveDiff([
        {
          op: "update_view",
          view: "book-list",
          changes: { sort: { field: "ghost", order: "desc" } },
        },
      ]),
    );
    expect(sortErrors[0]?.path).toBe("/app/views/0/sort/field");
    expect(sortErrors[0]?.allowed_values).toEqual(["title", "memo", "status"]);

    const filterErrors = expectRejected(
      destructiveDiff([
        {
          op: "update_view",
          view: "book-list",
          changes: { filter: [{ field: "ghost", equals: "読了" }] },
        },
      ]),
    );
    expect(filterErrors[0]?.path).toBe("/app/views/0/filter/0/field");
    expect(filterErrors[0]?.allowed_values).toEqual(["title", "memo", "status"]);
  });

  test("form の fields を存在しないフィールドへ差し替えても拒否される", () => {
    const errors = expectRejected(
      destructiveDiff([
        { op: "update_view", view: "book-form", changes: { fields: ["title", "ghost"] } },
      ]),
    );
    expect(errors[0]?.path).toBe("/app/views/1/fields/1");
    expect(errors[0]?.allowed_values).toEqual(["title", "memo", "status"]);
  });

  test("ケース6: columns から既存フィールドを外す差し替えは【正当】であり、適用される", () => {
    // これは破壊的ではない。理由:
    // - columns は「一覧画面にどの列を出すか」という**表示の指定**でしかない
    // - フィールド定義(books.memo)もSQLiteの列(memo)も既存データも一切変わらない
    // - 戻したければ update_view で columns に memo を書き戻すだけで完全に戻る(憲法4)
    // ここを「削除に見えるから拒否」に倒すと、v0 唯一の画面調整手段が失われる。
    // 破壊的なのは「データが消える/読めなくなる」ことであって「見えなくなる」ことではない。
    const before = observe();

    const result = applyDiff(
      dataRoot,
      APP_ID,
      destructiveDiff([{ op: "update_view", view: "book-list", changes: { columns: ["title"] } }]),
    );

    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }

    // 表示だけが変わる。
    const listView = result.manifest.app.views[0];
    expect(listView?.type === "list_view" ? listView.columns : undefined).toEqual(["title"]);

    // フィールド定義・SQLiteの列・データはすべて無傷。
    expect(result.manifest.app.tables[0]?.fields.map((f) => f.id)).toEqual([
      "title",
      "memo",
      "status",
    ]);
    const after = observe();
    expect(after.schema).toEqual(before.schema);
    expect(after.records).toEqual(before.records);

    // 正当な適用なので、こちらは逆にスナップショットが1つ取られている(いつでも戻せる)。
    expect(after.snapshots).toEqual(["0001-d-destructive"]);
  });
});

describe("additive な op を使った破壊の偽装は拒否される", () => {
  test("ケース7: 既存フィールドと同じIDを別の型で add_field するのは型変更の偽装", () => {
    const errors = expectRejected(
      destructiveDiff([
        // title は text。これを number として「追加」しようとする = 実質的な型変更。
        {
          op: "add_field",
          table: "books",
          field: { id: "title", name: "タイトル", type: "number" },
        },
      ]),
    );
    const error = errors[0];
    expect(error?.path).toBe("/operations/0/field/id");
    expect(error?.message).toContain("既にフィールド");
    // 「v0 にはフィールドの再定義(型変更・リネーム)を表す op が存在しない」ことを言う。
    expect(error?.message).toContain("型変更");
    expect(error?.allowed_values).toEqual(["title", "memo", "status"]);
  });

  test("ケース8: 既存テーブルと同じIDを別定義で add_table するのは定義の上書き", () => {
    const errors = expectRejected(
      destructiveDiff([
        {
          op: "add_table",
          table: {
            id: "books",
            name: "本(作り直し)",
            fields: [{ id: "isbn", name: "ISBN", type: "text" }],
          },
        },
      ]),
    );
    const error = errors[0];
    expect(error?.path).toBe("/operations/0/table/id");
    expect(error?.message).toContain("既に存在する");
    // 上書き = 既存の title / memo / status とそこに入ったデータの喪失。明示的に断る。
    expect(error?.message).toContain("上書き");
  });

  test("既存ビューと同じIDを別定義で add_view するのも差し替え(=画面定義の破壊)として拒否", () => {
    const errors = expectRejected(
      destructiveDiff([
        {
          op: "add_view",
          view: { id: "book-list", type: "list_view", table: "books", columns: ["title"] },
        },
      ]),
    );
    expect(errors[0]?.path).toBe("/operations/0/view/id");
    expect(errors[0]?.message).toContain("既に存在する");
  });

  test("ケース9: required の格上げを『専用 op』『add_field の上書き』で表そうとする道は閉じたまま", () => {
    // **M1 で required の格上げ自体はできるようになった** —— change_field の
    // changes.required である(ADR-0010 §5c)。既存行に空値があれば変換不能値として
    // 拒否される。その成功系と拒否系は apply-diff.test.ts の完了条件D が固定している。
    //
    // **ここが固定するのは「別の綴りで同じことをしようとする道」が閉じたままである
    // ことである。** 語彙が広がったときに一緒に緩みやすいのがこの2経路であり、
    // 緩むと「同じ操作に2つの入口がある」状態になる(ADR-0010 限定2 が防いでいるもの)。

    // (a) 専用 op を作る道 …… そんな op は語彙に無い。
    const dedicatedOp = expectRejected(
      destructiveDiff([{ op: "set_required", table: "books", field: "memo", required: true }]),
    );
    expect(vocabularyError(dedicatedOp, 0).allowed_values).toEqual(ALL_OPS);

    const updateFieldOp = expectRejected(
      destructiveDiff([
        {
          op: "update_field",
          table: "books",
          field: { id: "memo", name: "メモ", type: "long_text", required: true },
        },
      ]),
    );
    expect(vocabularyError(updateFieldOp, 0).allowed_values).toEqual(ALL_OPS);

    // (b) add_field で同じIDを required 付きで「上書き」する道 …… ID 重複で落ちる。
    const overwrite = expectRejected(
      destructiveDiff([
        {
          op: "add_field",
          table: "books",
          field: { id: "memo", name: "メモ", type: "long_text", required: true },
        },
      ]),
    );
    expect(overwrite[0]?.path).toBe("/operations/0/field/id");
    expect(overwrite[0]?.message).toContain("既にフィールド");

    // 結果として、これら3経路のどれからも required は動かない
    // (**動かせるのは change_field の changes.required だけである**)。
    expect(readManifestFile().app.tables[0]?.fields[1]).toEqual({
      id: "memo",
      name: "メモ",
      type: "long_text",
    });
  });

  test("select の選択肢を減らす(既存データを不正にする)変更も表現できない", () => {
    // status には "読了" が入ったレコードが実在する。選択肢からこれを外すのは
    // 「保存済みの値が語彙外になる」破壊。フィールド定義を触る op が無いので届かない。
    const errors = expectRejected(
      destructiveDiff([
        {
          op: "add_field",
          table: "books",
          field: { id: "status", name: "状態", type: "select", options: ["未読"] },
        },
      ]),
    );
    expect(errors[0]?.path).toBe("/operations/0/field/id");

    const records = allBooks();
    expect(records.map((r) => r.status).sort()).toEqual(["未読", "読了"]);
  });
});

/**
 * **V1-M1-T03 が新設したブロック(ADR-0010 §8 の変更方針4)。**
 *
 * 不変条件4(スナップショットが1つも作られない)の**対象を広げる**。ADR-0010 §7 は
 * 失敗を6種に整理し、そのうち**失敗1〜5 ではスナップショットが作られない**と定めた。
 * とりわけ **失敗4(変換不能値)** は M1 で新しく生まれた失敗であり、**§6b が
 * 「拒否は事前検証で行う。スナップショットより前である」と設計要求にした**のは
 * まさにこの不変条件を延命させるためである。
 *
 * ここが赤くなったら、`applyDiff` の中で変換可否の判定が `takeSnapshot` より
 * 後ろへ移動したということである。
 */
describe("破壊的 op の拒否でも副作用が無い(ADR-0010 §7 失敗1〜5 / §8 不変条件4)", () => {
  test("失敗2: 存在しないテーブル・フィールドを対象にした破壊的 op", () => {
    expectRejected(destructiveDiff([{ op: "remove_table", table: "ghost" }]));
    expectRejected(destructiveDiff([{ op: "remove_field", table: "books", field: "ghost" }]));
    expectRejected(
      destructiveDiff([{ op: "change_field", table: "ghost", field: "x", changes: { name: "y" } }]),
    );
  });

  test("失敗2: rename 先のIDが既存と衝突する", () => {
    expectRejected(
      destructiveDiff([
        { op: "change_field", table: "books", field: "memo", changes: { id: "title" } },
      ]),
    );
  });

  test("失敗3: 参照整合性違反(削除するフィールドがビューから参照されている)", () => {
    // **カスケード削除は採らない**(ADR-0010 §7a)。拒否したうえで手順を hint に書く。
    const errors = expectRejected(
      destructiveDiff([{ op: "remove_field", table: "books", field: "memo" }]),
    );
    expect(errors.some((e) => (e.hint ?? "").includes("update_view"))).toBe(true);
  });

  test("失敗4: 変換不能値 —— **スナップショットが1つも作られない**(§6b)", () => {
    // status には "読了" が入ったレコードが実在する。選択肢から外すのは変換不能値。
    expectRejected(
      destructiveDiff([
        { op: "change_field", table: "books", field: "status", changes: { options: ["未読"] } },
      ]),
    );
    // title は required。空にはできないが、memo は空文字の行があるので格上げは拒否。
    expectRejected(
      destructiveDiff([
        { op: "change_field", table: "books", field: "memo", changes: { required: true } },
      ]),
    );
    // 不能セル(語彙として認めない組み合わせ)。
    expectRejected(
      destructiveDiff([
        { op: "change_field", table: "books", field: "title", changes: { type: "reference" } },
      ]),
    );
  });

  /**
   * **実測して分かったこと: システムテーブルは2重に閉じている。**
   *
   * 破壊的 4 op の `table` は `$defs/resource_id`(`^[a-z][a-z0-9_-]*$`)を指すので、
   * `_apps` / `_changelog` は **JSON Schema の段階で**弾かれる —— `_` 始まりが
   * 規約に合わないためである。`foldOperations` の限定8 ガードまで到達しない。
   *
   * **したがって限定8 のガードは「唯一の関門」ではなく多層防御である。** それでも
   * 置いてあるのは、`foldOperations` がカーネル内部APIとして単独で呼べるからであり、
   * `foldAddField` が同じ理由で同じガードを既に持っているのと揃えたものである。
   * 下の2ケースで**両方の層**を実測する。
   */
  test("失敗5: システムテーブルを対象にした破壊的 op(限定8)—— 層1: スキーマ", () => {
    for (const operation of [
      { op: "remove_table", table: "_apps" },
      { op: "remove_field", table: "_changelog", field: "intent" },
      { op: "change_table", table: "_apps", changes: { name: "x" } },
      { op: "change_field", table: "_changelog", field: "intent", changes: { name: "x" } },
    ]) {
      const errors = expectRejected(destructiveDiff([operation]));
      expect(errors[0]?.path).toBe("/operations/0/table");
      expect(errors[0]?.message).toContain(String(operation.table));
    }
  });

  test("失敗5: システムテーブルを対象にした破壊的 op(限定8)—— 層2: 畳み込みのガード", () => {
    // スキーマを迂回して `foldOperations` を直接呼ぶ。**判定は resolveTable の前**
    // (ADR-0006 §7 の順序規約の延長)なので、「存在しません」ではなく
    // 「読み取り専用です」と言う。「存在しません」で返すと、hint が
    // 「先に add_table しろ」と、必ず弾かれる操作へ AI を誘導する。
    const manifest = readManifestFile();
    for (const operation of [
      { op: "remove_table", table: "_apps" },
      { op: "remove_field", table: "_changelog", field: "intent" },
      { op: "change_table", table: "_apps", changes: { name: "x" } },
      { op: "change_field", table: "_changelog", field: "intent", changes: { name: "x" } },
    ] as unknown as Operation[]) {
      const folded = foldOperations(manifest, [operation]);
      expect(folded.valid).toBe(false);
      if (folded.valid) {
        continue;
      }
      expect(folded.errors[0]?.path).toBe("/operations/0/table");
      expect(folded.errors[0]?.message).toContain("読み取り専用");
      // 候補にシステムテーブルを載せない(裏口を宣伝しない。ADR-0006 §9)。
      expect(folded.errors[0]?.allowed_values).toEqual(["books"]);
    }
  });
});

describe("拒否の副作用が無いことの総括", () => {
  /**
   * **主張を書き換えた(ADR-0010 §8)。消したのではない。**
   *
   * 旧: 「破壊的**意図**を持つ差分は1バイトも状態を変えずに拒否される」—— M1 後は偽。
   * 新: 「**拒否された**差分は1バイトも状態を変えない」。
   *
   * 「どの差分が拒否されるか」が M1 で変わっただけで、**「拒否の副作用が無い」という
   * 性質は M1 の中心的な保証そのものである。**
   */
  test("拒否される差分を連続で投げても、スナップショットも changelog も1件も増えない", () => {
    const before = observe();

    const rejected: unknown[] = [
      // 語彙外 op(失敗1)。**今も語彙外であるもの**を使う(remove_view は ADR-0012 で語彙内)。
      destructiveDiff([{ op: "remove_app", table: "books" }]),
      destructiveDiff([{ op: "rename_table", table: "books", to: "volumes" }]),
      // 畳み込み不能(失敗2)。
      destructiveDiff([{ op: "remove_table", table: "ghost" }]),
      destructiveDiff([{ op: "remove_view", view: "ghost" }]),
      // 参照整合性違反(失敗3)。**語彙内の op が、内容ゆえに拒否される。**
      destructiveDiff([{ op: "remove_field", table: "books", field: "memo" }]),
      destructiveDiff([{ op: "update_view", view: "book-list", changes: { columns: ["ghost"] } }]),
      // 変換不能値(失敗4)。**M1 で新しく生まれた拒否である。**
      destructiveDiff([
        { op: "change_field", table: "books", field: "status", changes: { options: ["未読"] } },
      ]),
      // システムテーブル(失敗5)。
      destructiveDiff([{ op: "remove_table", table: "_apps" }]),
      // additive な op による破壊の偽装。
      destructiveDiff([
        { op: "add_field", table: "books", field: { id: "title", name: "題", type: "number" } },
      ]),
    ];
    for (const diff of rejected) {
      expect(applyDiff(dataRoot, APP_ID, diff).valid).toBe(false);
    }

    const after = observe();
    expect(after).toEqual(before);
    expect(after.snapshots).toEqual([]);
    // V1-M0-T05: create_app が書いた第0行(_create-app)は before の時点で既に存在する。
    // 「1件も増えない」ことは before/after の比較で見る(0 に固定しない)。
    expect(after.changelog).toEqual(before.changelog);
    expect(after.changelog).toHaveLength(1);
    expect(after.changelog[0]?.diff_id).toBe("_create-app");
  });
});
