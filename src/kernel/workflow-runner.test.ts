import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armOwnerColumns,
  FIXTURE_ACTOR_ID,
  grantOwnerAllTables,
  isFixtureOwnerTable,
  OWNER_FIELD,
  seedAutomationActor,
} from "./automation-actor-fixture.test.ts";
import { writeRecords as writeRecordsRaw } from "./batch.ts";
import type { Clock } from "./clock.ts";
import { applyManifestDdl as applyManifestDdlRaw } from "./ddl.ts";
import type { ValidationError } from "./errors.ts";
import {
  createRecord as createRecordRaw,
  deleteRecord,
  listRecords,
  type RecordRow,
  updateRecord as updateRecordRaw,
} from "./records.ts";
import type { Manifest, Workflow } from "./types.ts";
import {
  resetWorkflowClock,
  resetWorkflowHistoryFailureHandler,
  runScheduledWorkflow,
  runWorkflows,
  setWorkflowClock,
  setWorkflowHistoryFailureHandler,
  WORKFLOW_HISTORY_COLUMNS,
  WORKFLOW_MAX_DEPTH,
  type WorkflowHistoryWriteFailure,
} from "./workflow-runner.ts";

/**
 * ワークフロー実行エンジン(ADR-0013 §5a / V1-M2-T02)の検査。
 *
 * 作法は `records.test.ts` / `workflow-fold.test.ts` に揃えてある —— 実ディスクの
 * SQLite と実マニフェストだけを使い、モックを1つも置かない。**唯一差し替えるのは
 * 「履歴書き込みが失敗したことの通知先」だけ**で、これは既定が `console.error` で
 * ありテストから観測する手段が他に無いためである(§2-2 判断1)。
 *
 * ## T02 の申し送り(判断4)と、T03 での決着
 *
 * T02 は「『行数が正確に N』で書いている検査は、深度を1から N に緩めた時点で期待値が
 * 変わる。該当するのは describe『暫定の歯止め(深度1固定)』の**2件**」と書き残したが、
 * **実体は4件だった**(自己参照の行数 / 履歴テーブルのトリガー / 上限到達を履歴に
 * 書かないこと / 歯止めが1回の CRUD で閉じること)。**数え落としである。**
 * V1-M2-T03 が4件すべてを書き換え、この件数の誤りもここで訂正した。
 * **「N 件」と書き残すときは、書いた本人が数え直すこと。**
 *
 * ## T03 以降の書き方(判断4)
 *
 * **深度に依存する期待値は `WORKFLOW_MAX_DEPTH` から機械的に導くこと。**
 * 20 や 21 という数字をテストに直書きしない —— 直書きすると、定数を動かしたときに
 * 「どのテストが定数の帰結でどれが独立の事実か」が読み取れなくなる。
 * **`WORKFLOW_MAX_DEPTH` を差し替える setter は本番に存在しない**(判断4)ので、
 * 連鎖の段数が要る検査は**テーブルとワークフローをループで組み立てる。**
 *
 * ## **【`V8-M26`(2026-08-10)で題材に「壁を開ける下ごしらえ」が入った】**
 *
 * **`V8-M26-T03` が面(役割に束ねた権限)の既定を「閉じる」側へ倒したので、
 * ワークフローの書込が題材ごと全部止まった**(50件が赤になった)。
 * **本ファイルの主題はワークフロー実行エンジンのふるまいであって、面ではない。**
 * **そこで題材の側で壁を開ける** —— **実装は1バイトも緩めていない。**
 *
 * **開け方は3つちょうどである**(`src/kernel/automation-actor-fixture.test.ts`):
 *
 *  1. **書き手を1人立てる** —— `_auth_users` に `owner` の役割を持つ利用者を1人入れる。
 *     **これが無いと書き手は `anonymous` になり、`anonymous` には書込の規則を
 *     1本も書けない**(スキーマの `J-G11` の分岐)。
 *  2. **持ち主の列(`st_owner`)を題材のテーブルに足し、行を作るときに書き手を入れる** ——
 *     **`resolveWorkflowActor` の既定はトリガー元の行の `st_owner` 1本だからである。**
 *     **履歴テーブル(`ran_at` を持つ表)には足さない** —— **「規約5列」を測る検査
 *     (`'成功時に status="success" の行が1つだけ書かれ、5列が規約どおり埋まる'` /
 *     「履歴テーブルの規約は5列である」)を壊さないため。**
 *  3. **既定3役割にこの題材の全テーブルの規則を配る。**
 *
 * **これは「面が閉じたこと」を測る配り方ではない**(全部に配っている)——
 * **面の既定を測るのは `src/kernel/role-rules.test.ts` /
 * `src/kernel/role-default-grant.test.ts` / `src/server/role-default-closed.test.ts` である。**
 */

/** 履歴テーブルの5列(規約どおりの形)。 */
function historyFields() {
  return [
    { id: "ran_at", name: "実行時刻", type: "date" as const },
    { id: "workflow", name: "ワークフロー", type: "text" as const },
    { id: "trigger_type", name: "きっかけ", type: "text" as const },
    { id: "status", name: "結果", type: "text" as const },
    { id: "error", name: "エラー", type: "long_text" as const },
  ];
}

/**
 * 蔵書管理アプリ。`workflows` は各テストが差し込む。
 *
 * - `books` … トリガー元
 * - `notifications` … アクションの出力先(成功する側)
 * - `strict` … `must` が required なので、値を与えない書き込みは必ず失敗する
 * - `wf-runs` … 規約どおり5列の履歴テーブル
 * - `broken-runs` … `error` 列が無い履歴テーブル(完了条件5 の注入用)
 */
function baseManifest(): Manifest {
  return {
    app: {
      id: "book-tracker",
      name: "蔵書管理",
      tables: [
        {
          id: "books",
          name: "本",
          fields: [
            { id: "title", name: "タイトル", type: "text", required: true },
            { id: "title_kana", name: "タイトルかな", type: "text" },
            { id: "memo", name: "メモ", type: "long_text" },
            // EC-G5(ADR-0036)の `when` を型ごとに検査するための列(任意)。
            { id: "status", name: "状態", type: "text" },
            { id: "pages", name: "ページ数", type: "number" },
            { id: "archived", name: "書庫入り", type: "boolean" },
          ],
        },
        {
          id: "notifications",
          name: "通知",
          fields: [
            { id: "title", name: "件名", type: "text" },
            { id: "source", name: "対象", type: "text" },
          ],
        },
        {
          id: "strict",
          name: "必須つきテーブル",
          fields: [{ id: "must", name: "必須", type: "text", required: true }],
        },
        { id: "wf-runs", name: "実行履歴", fields: historyFields() },
        {
          id: "broken-runs",
          name: "壊れた実行履歴",
          // **`error` 列が無い。**規約5列のうち1列を欠いた形である。
          fields: historyFields().filter((field) => field.id !== "error"),
        },
      ],
      views: [],
    },
  };
}

let dir: string;
let db: Database;
let manifest: Manifest;

/**
 * **面の規則を配り直し、連鎖の書き手が消えないようにする。**
 * **テーブルもワークフローも後から足せるので、書込のたびに呼ぶ。**
 *
 * **2つ目が要る理由(実測)**: **ワークフローが作った行に `st_owner` が入らないと、
 * その行が起こす次の発火の書き手が `null` になり、連鎖が2段目で止まる** ——
 * **`A → B → A` の相互発火や深度上限の題材は、連鎖が続くことが主題なので、
 * ここで途切れると測れない。**
 */
function armRoles(target: Manifest): void {
  grantOwnerAllTables(target);
  for (const workflow of target.app.workflows ?? []) {
    for (const action of (workflow.actions ?? []) as Record<string, unknown>[]) {
      if (action.action !== "create_record" || typeof action.table !== "string") {
        continue;
      }
      if (!isFixtureOwnerTable(target, action.table)) {
        continue;
      }
      const values = (action.values ?? {}) as Record<string, unknown>;
      if (values[OWNER_FIELD.id] === undefined) {
        action.values = { ...values, [OWNER_FIELD.id]: FIXTURE_ACTOR_ID };
      }
    }
  }
}

/** DDL を当てる直前に列を足し、当てた直後に書き手を1人立てる。 */
function applyManifestDdl(database: Database, target: Manifest): void {
  armOwnerColumns(target);
  armRoles(target);
  applyManifestDdlRaw(database, target);
  seedAutomationActor(database);
}

/**
 * **行を作る。** **持ち主の列を持つテーブルには、書き手を既定で入れる**
 * (呼ぶ側が `st_owner` を明示していれば1バイトも上書きしない)。
 */
function createRecord(
  database: Database,
  target: Manifest,
  tableId: string,
  values: Record<string, unknown>,
): ReturnType<typeof createRecordRaw> {
  armRoles(target);
  const declared = values[OWNER_FIELD.id];
  if (typeof declared === "string" && declared !== "") {
    seedAutomationActor(database, declared);
  }
  const filled =
    isFixtureOwnerTable(target, tableId) && declared === undefined
      ? { ...values, [OWNER_FIELD.id]: FIXTURE_ACTOR_ID }
      : values;
  return createRecordRaw(database, target, tableId, filled);
}

/** **行を更新する。** **`st_owner` は1バイトも触らない**(行が既に持っている)。 */
function updateRecord(
  database: Database,
  target: Manifest,
  tableId: string,
  recordId: string,
  values: Record<string, unknown>,
  updatedAt?: string,
): ReturnType<typeof updateRecordRaw> {
  armRoles(target);
  return updateRecordRaw(
    database,
    target,
    tableId,
    recordId,
    values,
    updatedAt as unknown as string,
  );
}

/** **バッチ書込。** **作成の要素にだけ持ち主を入れる。** */
function writeRecords(
  database: Database,
  target: Manifest,
  operations: Parameters<typeof writeRecordsRaw>[2],
): ReturnType<typeof writeRecordsRaw> {
  armRoles(target);
  const filled = (operations as readonly unknown[]).map((one) => {
    const operation = one as Record<string, unknown>;
    if (operation.op !== "create") {
      return operation;
    }
    const values = (operation.values ?? {}) as Record<string, unknown>;
    if (
      typeof operation.table !== "string" ||
      !isFixtureOwnerTable(target, operation.table) ||
      values[OWNER_FIELD.id] !== undefined
    ) {
      return operation;
    }
    return { ...operation, values: { ...values, [OWNER_FIELD.id]: FIXTURE_ACTOR_ID } };
  });
  return writeRecordsRaw(
    database,
    target,
    filled as unknown as Parameters<typeof writeRecordsRaw>[2],
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gp-workflow-runner-"));
  db = new Database(join(dir, "app.sqlite"));
  manifest = baseManifest();
  applyManifestDdl(db, manifest);
});

afterEach(async () => {
  resetWorkflowHistoryFailureHandler();
  resetWorkflowClock();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

/** マニフェストにワークフローを載せる(以降の CRUD がこれを見る)。 */
function withWorkflows(...workflows: Workflow[]): void {
  manifest.app.workflows = workflows;
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; errors: ValidationError[] }): T {
  if (!result.ok) {
    throw new Error(`期待に反して失敗しました: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

/** テーブルの全行を、実際に DB から読んで返す。 */
function rowsOf(tableId: string): RecordRow[] {
  return unwrap(listRecords(db, manifest, tableId));
}

/** 履歴の全行(既定の履歴テーブル)。 */
function historyRows(): RecordRow[] {
  return rowsOf("wf-runs");
}

/**
 * 1列の値を**書き込まれた順**(SQLite の rowid 順)で返す。
 *
 * `listRecords` の既定順は `_created_at ASC, _id ASC` だが、**ワークフローの実行は
 * 同期で、同じミリ秒の中に複数行が書かれる。**その場合の同着はランダムな UUID で
 * 割れるため、既定順では実行順序を観測できない(実際に不安定になった)。
 * **実行順序を問う検査だけがこれを使う。**内容の検査は `listRecords` を通す。
 */
function insertionOrder(tableId: string, column: string): unknown[] {
  const rows = db
    .query(`SELECT ${JSON.stringify(column)} AS v FROM ${JSON.stringify(tableId)} ORDER BY rowid`)
    .all() as { v: unknown }[];
  return rows.map((row) => row.v);
}

/** 本を1件作る。 */
function addBook(title = "吾輩は猫である", extra: Record<string, unknown> = {}): RecordRow {
  return unwrap(createRecord(db, manifest, "books", { title, ...extra }));
}

/**
 * **ワークフローを1本も載せずに**行を1件作り、その後でワークフローを載せて返す。
 *
 * V3-M13-T02(ADR-0066)以降、`createRecord` / `updateRecord` は
 * [行の書込 + 発火] を1つの tx で包み、**アクションが1つでも失敗すれば発火元ごと
 * 巻き戻す。**したがって「失敗したときの履歴・抑止・深度」を観測する検査は、
 * 器(tx)の内側で発火させると**観測対象ごと消える。**
 *
 * そこで**器の外から `runWorkflows` を直接呼ぶ** —— 巻き戻しの器は `records.ts` にしか
 * 無い(ADR-0066 限定1)ので、直接呼べば実行機構だけを素で観測できる。
 * **器の側の振る舞いは describe「V3-M13-T02」が別に固定している。**
 */
function seedWithoutFiring(
  tableId: string,
  values: Record<string, unknown>,
  ...workflows: Workflow[]
): RecordRow {
  const saved = manifest.app.workflows ?? [];
  manifest.app.workflows = [];
  const row = unwrap(createRecord(db, manifest, tableId, values));
  manifest.app.workflows = workflows.length > 0 ? workflows : saved;
  return row;
}

/** 器(`records.ts` の tx)を通さずにワークフローだけを発火させる。 */
function fire(
  record: RecordRow,
  triggerType: "on_create" | "on_update" = "on_create",
  tableId = "books",
): string[] {
  armRoles(manifest);
  return runWorkflows(db, manifest, tableId, triggerType, record);
}

// ---------------------------------------------------------------------------
// 完了条件1: on_create / on_update でアクションが実行される
// ---------------------------------------------------------------------------

describe("完了条件1: トリガー×アクションの4組合せ", () => {
  test("on_create × create_record —— 出力先テーブルに行が実際に書かれる", () => {
    withWorkflows({
      id: "notify-on-new-book",
      name: "新しい本を通知",
      trigger: { type: "on_create", table: "books" },
      actions: [
        {
          action: "create_record",
          table: "notifications",
          values: { title: "新しい本が登録されました", source: "$record.title" },
        },
      ],
      history_table: "wf-runs",
    });

    const book = addBook("坊っちゃん");

    const notifications = rowsOf("notifications");
    expect(notifications).toHaveLength(1);
    // **「例外が飛ばなかった」ではなく、行の中身を読んで確認する。**
    expect(notifications[0]?.title).toBe("新しい本が登録されました");
    expect(notifications[0]?.source).toBe("坊っちゃん");
    expect(book.title).toBe("坊っちゃん");
  });

  test("on_create × update_record —— トリガーになった行自身が更新される", () => {
    withWorkflows({
      id: "stamp-on-create",
      name: "作成時にメモを入れる",
      trigger: { type: "on_create", table: "books" },
      actions: [
        {
          action: "update_record",
          table: "books",
          target: "$record._id",
          values: { memo: "自動登録" },
        },
      ],
      history_table: "wf-runs",
    });

    const book = addBook("こころ");

    const stored = rowsOf("books").find((row) => row._id === book._id);
    expect(stored?.memo).toBe("自動登録");
  });

  test("on_update × create_record —— 更新でだけ発火する", () => {
    withWorkflows({
      id: "notify-on-update",
      name: "更新を通知",
      trigger: { type: "on_update", table: "books" },
      actions: [
        {
          action: "create_record",
          table: "notifications",
          values: { title: "本が更新されました", source: "$record._id" },
        },
      ],
      history_table: "wf-runs",
    });

    const book = addBook("三四郎");
    // 作成では on_update は発火しない。
    expect(rowsOf("notifications")).toHaveLength(0);

    unwrap(updateRecord(db, manifest, "books", book._id, { memo: "読了" }));

    const notifications = rowsOf("notifications");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.source).toBe(book._id);
  });

  test("on_update × update_record —— 別テーブルの行を更新できる", () => {
    const target = unwrap(createRecord(db, manifest, "notifications", { title: "初期" }));
    withWorkflows({
      id: "rewrite-notification",
      name: "通知を書き換える",
      trigger: { type: "on_update", table: "books" },
      actions: [
        {
          action: "update_record",
          table: "notifications",
          // **リテラルの UUID**(書ける2形のうちの片方)。
          target: target._id,
          values: { title: "書き換えられました", source: "$record.title" },
        },
      ],
      history_table: "wf-runs",
    });

    const book = addBook("それから");
    unwrap(updateRecord(db, manifest, "books", book._id, { memo: "x" }));

    const stored = rowsOf("notifications").find((row) => row._id === target._id);
    expect(stored?.title).toBe("書き換えられました");
    expect(stored?.source).toBe("それから");
  });

  test("同じトリガーを持つワークフロー2本が app.workflows の配列順で実行される", () => {
    withWorkflows(
      {
        id: "first",
        name: "1番目",
        trigger: { type: "on_create", table: "books" },
        actions: [
          { action: "create_record", table: "notifications", values: { title: "A", source: "1" } },
        ],
        history_table: "wf-runs",
      },
      {
        id: "second",
        name: "2番目",
        trigger: { type: "on_create", table: "books" },
        actions: [
          { action: "create_record", table: "notifications", values: { title: "B", source: "2" } },
        ],
        history_table: "wf-runs",
      },
    );

    addBook();

    expect(insertionOrder("notifications", "title")).toEqual(["A", "B"]);
    // 履歴も同じ順序で並ぶ。
    expect(insertionOrder("wf-runs", "workflow")).toEqual(["first", "second"]);
  });

  test("1本の actions 配列内で、前が失敗しても後続が実行される(ADR-0013 §5a)", () => {
    withWorkflows({
      id: "partial-failure",
      name: "途中で失敗する",
      trigger: { type: "on_create", table: "books" },
      actions: [
        // `must` が required なので必ず失敗する。
        { action: "create_record", table: "strict", values: {} },
        { action: "create_record", table: "notifications", values: { title: "後続", source: "x" } },
      ],
      history_table: "wf-runs",
    });

    // 【V3-M13-T02 / ADR-0066 による期待値の更新】以前は `addBook()` で発火させ、
    // 後続の書込が**残っている**ことを読んでいた。決定が変わり、器の内側で発火させると
    // 失敗のたびに全部巻き戻るので、**器の外から発火させて**同じことを観測する。
    // **`0013:418`(前が失敗しても後続を実行する)は1バイトも変わっていない**(限定3)。
    const failures = fire(seedWithoutFiring("books", { title: "後続の証明" }));

    expect(rowsOf("strict")).toHaveLength(0);
    // **後続が実行されている**ことを、出力先を読んで確認する。
    expect(rowsOf("notifications").map((row) => row.title)).toEqual(["後続"]);
    // 失敗は1件だけ(後続は成功した)。
    expect(failures).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 完了条件2: 全実行が履歴に残る(成功も失敗も)
// ---------------------------------------------------------------------------

describe("完了条件2: 履歴に成功も失敗も残る", () => {
  test('成功時に status="success" の行が1つだけ書かれ、5列が規約どおり埋まる', () => {
    withWorkflows({
      id: "notify-on-new-book",
      name: "新しい本を通知",
      trigger: { type: "on_create", table: "books" },
      actions: [
        { action: "create_record", table: "notifications", values: { title: "T", source: "S" } },
      ],
      history_table: "wf-runs",
    });

    addBook();

    const rows = historyRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.status).toBe("success");
    expect(row?.workflow).toBe("notify-on-new-book");
    expect(row?.trigger_type).toBe("on_create");
    // 成功時は `error` を書かない(列は存在するが null のまま)。
    expect(row?.error).toBeNull();
    // `ran_at` が ISO8601 として `date` 型の検証を通っていること。書けている時点で
    // `validateInput` を通過しているが、値そのものも往復できることを確かめる。
    expect(typeof row?.ran_at).toBe("string");
    expect(new Date(String(row?.ran_at)).toISOString()).toBe(String(row?.ran_at));
  });

  test('失敗時に status="failure" の行が1つ書かれ、error に実際の失敗内容が入る', () => {
    withWorkflows({
      id: "always-fails",
      name: "必ず失敗する",
      trigger: { type: "on_create", table: "books" },
      actions: [{ action: "create_record", table: "strict", values: {} }],
      history_table: "wf-runs",
    });

    // 【期待値の更新】器の内側で発火させると履歴ごと巻き戻る(V3-M13-T02。解くのは T04)。
    // ここで観測したいのは**履歴の中身**なので、器の外から発火させる。
    fire(seedWithoutFiring("books", { title: "履歴の中身" }));

    const rows = historyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failure");
    // **実際の失敗内容**が読めること。「失敗しました」だけの定型文にしない(憲法6)。
    expect(String(rows[0]?.error)).toContain("must");
    expect(String(rows[0]?.error)).toContain("必須");
  });

  test("複数アクションのうち1つでも失敗すれば failure。error は失敗した全件を畳む", () => {
    withWorkflows({
      id: "two-failures",
      name: "2つ失敗して1つ成功する",
      trigger: { type: "on_create", table: "books" },
      actions: [
        { action: "create_record", table: "strict", values: {} },
        { action: "create_record", table: "notifications", values: { title: "ok", source: "s" } },
        { action: "update_record", table: "books", target: "$record.title", values: { memo: "x" } },
      ],
      history_table: "wf-runs",
    });

    // 【期待値の更新】同上 —— 器の外から発火させて履歴の中身を観測する。
    fire(seedWithoutFiring("books", { title: "畳まれ方" }));

    // **実行1回につき履歴1行**である(アクション1つにつき1行ではない)。
    const rows = historyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failure");
    const error = String(rows[0]?.error);
    // 失敗した2件が両方畳まれている。
    expect(error).toContain("strict");
    expect(error).toContain("books");
    // 成功した1件は出力先に実在する。
    expect(rowsOf("notifications")).toHaveLength(1);
  });

  test("trigger_type は on_create / on_update を別々に正しく取る", () => {
    withWorkflows(
      {
        id: "on-create-wf",
        name: "作成時",
        trigger: { type: "on_create", table: "books" },
        actions: [{ action: "create_record", table: "notifications", values: { title: "c" } }],
        history_table: "wf-runs",
      },
      {
        id: "on-update-wf",
        name: "更新時",
        trigger: { type: "on_update", table: "books" },
        actions: [{ action: "create_record", table: "notifications", values: { title: "u" } }],
        history_table: "wf-runs",
      },
    );

    const book = addBook();
    expect(insertionOrder("wf-runs", "workflow")).toEqual(["on-create-wf"]);
    expect(insertionOrder("wf-runs", "trigger_type")).toEqual(["on_create"]);

    unwrap(updateRecord(db, manifest, "books", book._id, { memo: "m" }));
    expect(insertionOrder("wf-runs", "workflow")).toEqual(["on-create-wf", "on-update-wf"]);
    // **2値とも別々に観測している。**`trigger_type` が定数で埋まっていないことの証明。
    expect(insertionOrder("wf-runs", "trigger_type")).toEqual(["on_create", "on_update"]);
  });

  test("トリガーに合致するワークフローが1本も無ければ履歴は書かれない", () => {
    withWorkflows({
      id: "other-table",
      name: "別テーブル",
      trigger: { type: "on_create", table: "notifications" },
      actions: [{ action: "create_record", table: "notifications", values: { title: "x" } }],
      history_table: "wf-runs",
    });

    addBook();
    expect(historyRows()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 完了条件3: 分離(**V3-M13-T02 / ADR-0066 で片方だけが変わった**)
//
// 【期待値の更新であって、バグの修正ではない】
// `ADR-0013` §5a(`0013:417`)の「分離」は2つのことを言っていた:
//   (前段)本体 CRUD をロールバックしない —— **ADR-0066 が正面から破った決定である**
//   (後段)アクションの例外を呼び出し元へ伝播させてレスポンスを 500 にしない —— **無傷**
// 本 describe はもともと前段を固定していたので、**期待値を新しい決定に合わせて更新した。**
// 後段(例外が飛ばないこと・失敗が値として返ること)は1バイトも変わっていない。
// ---------------------------------------------------------------------------

describe("完了条件3: 分離(後段は無傷 / 前段は ADR-0066 が破った)", () => {
  test("失敗するワークフローがあると createRecord は ok:false になり、本体行が残らない", () => {
    withWorkflows({
      id: "always-fails",
      name: "必ず失敗する",
      trigger: { type: "on_create", table: "books" },
      actions: [{ action: "create_record", table: "strict", values: {} }],
      history_table: "wf-runs",
    });

    const result = createRecord(db, manifest, "books", { title: "分離の証明" });
    // **例外は飛ばない**(後段は無傷)。失敗は値として返る。
    expect(result.ok).toBe(false);

    // **「ok:false が返った」ことを巻き戻しの証明にしない。**DB を読んで不在を確かめる。
    expect(rowsOf("books")).toHaveLength(0);
  });

  test("失敗するワークフローがあると updateRecord は ok:false になり、更新が残らない", () => {
    const book = addBook("元のタイトル");
    withWorkflows({
      id: "always-fails-on-update",
      name: "更新時に必ず失敗する",
      trigger: { type: "on_update", table: "books" },
      actions: [{ action: "create_record", table: "strict", values: {} }],
      history_table: "wf-runs",
    });

    const result = updateRecord(db, manifest, "books", book._id, { memo: "更新した" });
    expect(result.ok).toBe(false);
    // 行そのものは消えない。巻き戻るのは更新だけである。
    expect(rowsOf("books")[0]?.memo).toBeNull();
  });

  test("存在しない出力先テーブルを指すと本体 CRUD も成立しないが、例外にはならない", () => {
    withWorkflows({
      id: "ghost-table",
      name: "存在しないテーブルへ書く",
      trigger: { type: "on_create", table: "books" },
      actions: [{ action: "create_record", table: "ghosts", values: { title: "x" } }],
      history_table: "wf-runs",
    });

    const result = createRecord(db, manifest, "books", { title: "t" });
    expect(result.ok).toBe(false);
    expect(rowsOf("books")).toHaveLength(0);
    // 失敗の中身は呼び出し元まで読める(後段の分離 = 500 にしない)。
    if (result.ok) {
      throw new Error("失敗するはずの書込が成功しました。");
    }
    expect(String(result.errors[0]?.message)).toContain("ghosts");
  });
});

// ---------------------------------------------------------------------------
// 完了条件5: 履歴書き込みの失敗
// ---------------------------------------------------------------------------

describe("完了条件5: 履歴書き込みの失敗(all-or-nothing と循環の遮断)", () => {
  test("履歴テーブルに5列のうち1列が無いと、履歴行が1行も書かれない(all-or-nothing)", () => {
    const failures: WorkflowHistoryWriteFailure[] = [];
    setWorkflowHistoryFailureHandler((failure) => failures.push(failure));

    withWorkflows({
      id: "broken-history",
      name: "履歴テーブルが壊れている",
      trigger: { type: "on_create", table: "books" },
      actions: [
        {
          action: "create_record",
          table: "notifications",
          values: { title: "書けた", source: "s" },
        },
      ],
      history_table: "broken-runs",
    });

    expect(createRecord(db, manifest, "books", { title: "本体" }).ok).toBe(true);

    // **書ける列だけ書く(best-effort)を採っていない。**1行も書かれない。
    expect(rowsOf("broken-runs")).toHaveLength(0);
    // それでも本体行は実在し、
    expect(rowsOf("books")).toHaveLength(1);
    // アクションの書き込みも成功している。
    expect(rowsOf("notifications").map((row) => row.title)).toEqual(["書けた"]);

    // **通知は1回だけ。**これが「履歴の失敗を履歴に書きに行かない」= 循環を切ったことの証明である。
    expect(failures).toHaveLength(1);
    expect(failures[0]?.workflow).toBe("broken-history");
    expect(failures[0]?.history_table).toBe("broken-runs");
    expect(failures[0]?.errors.length).toBeGreaterThan(0);
  });

  test("存在しない履歴テーブルでも通知は1回だけで、本体もアクションも生き残る", () => {
    const failures: WorkflowHistoryWriteFailure[] = [];
    setWorkflowHistoryFailureHandler((failure) => failures.push(failure));

    withWorkflows({
      id: "missing-history",
      name: "履歴テーブルが無い",
      trigger: { type: "on_create", table: "books" },
      actions: [{ action: "create_record", table: "notifications", values: { title: "書けた" } }],
      history_table: "no-such-table",
    });

    expect(createRecord(db, manifest, "books", { title: "本体" }).ok).toBe(true);
    expect(rowsOf("books")).toHaveLength(1);
    expect(rowsOf("notifications")).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });

  test("履歴テーブルが壊れていても、後続のワークフローは実行される", () => {
    const failures: WorkflowHistoryWriteFailure[] = [];
    setWorkflowHistoryFailureHandler((failure) => failures.push(failure));

    withWorkflows(
      {
        id: "broken-history",
        name: "履歴が壊れている",
        trigger: { type: "on_create", table: "books" },
        actions: [{ action: "create_record", table: "notifications", values: { title: "A" } }],
        history_table: "broken-runs",
      },
      {
        id: "healthy",
        name: "正常",
        trigger: { type: "on_create", table: "books" },
        actions: [{ action: "create_record", table: "notifications", values: { title: "B" } }],
        history_table: "wf-runs",
      },
    );

    addBook();

    expect(insertionOrder("notifications", "title")).toEqual(["A", "B"]);
    expect(historyRows()).toHaveLength(1);
    expect(historyRows()[0]?.workflow).toBe("healthy");
    expect(failures).toHaveLength(1);
  });

  test("履歴テーブルの規約は5列である", () => {
    expect([...WORKFLOW_HISTORY_COLUMNS]).toEqual([
      "ran_at",
      "workflow",
      "trigger_type",
      "status",
      "error",
    ]);
  });
});

// ---------------------------------------------------------------------------
// V1-M2-T03: 無限ループ防止(深度上限 + 再発火抑止)
// ---------------------------------------------------------------------------

/**
 * 深度上限ちょうどを跨ぐ**直線の連鎖**を組み立てる。
 *
 * `t0 → t1 → … → t{MAX+1}` の `MAX + 2` 個のテーブルと、`wi: on_create t{i} →
 * create_record t{i+1}` の `MAX + 1` 本のワークフローを**ループで生成する。**
 * **21 という数字をどこにも書かない** —— 判断4 が「テスト専用の setter を本番に
 * 残さない」と決めた以上、段数は `WORKFLOW_MAX_DEPTH` から導くしかない。
 *
 * これで「上限が実際にいくつか」を、行が書かれたテーブルの並びとして直接読める。
 */
function chainManifest(): Manifest {
  const tables = Array.from({ length: WORKFLOW_MAX_DEPTH + 2 }, (_unused, index) => ({
    id: `t${index}`,
    name: `連鎖${index}`,
    fields: [{ id: "title", name: "タイトル", type: "text" as const }],
  }));
  const workflows: Workflow[] = Array.from(
    { length: WORKFLOW_MAX_DEPTH + 1 },
    (_unused, index) => ({
      id: `w${index}`,
      name: `連鎖${index}`,
      trigger: { type: "on_create" as const, table: `t${index}` },
      actions: [
        {
          action: "create_record" as const,
          table: `t${index + 1}`,
          values: { title: `段${index + 1}` },
        },
      ],
      history_table: "wf-runs",
    }),
  );
  return {
    app: {
      id: "chain",
      name: "連鎖",
      tables: [...tables, { id: "wf-runs", name: "実行履歴", fields: historyFields() }],
      views: [],
      workflows,
    },
  };
}

/** `chainManifest()` を実ディスクの別 SQLite に載せ直す。 */
function useChainDatabase(): void {
  db.close();
  db = new Database(join(dir, "chain.sqlite"));
  manifest = chainManifest();
  applyManifestDdl(db, manifest);
}

describe("完了条件1: 相互発火する2つのワークフロー(A→B→A)が停止する", () => {
  /** `books → notifications → books → …` と往復し続ける2本。 */
  function withMutualWorkflows(): void {
    withWorkflows(
      {
        id: "a-books-to-notifications",
        name: "A: 本ができたら通知を作る",
        trigger: { type: "on_create", table: "books" },
        actions: [{ action: "create_record", table: "notifications", values: { title: "A" } }],
        history_table: "wf-runs",
      },
      {
        id: "b-notifications-to-books",
        name: "B: 通知ができたら本を作る",
        trigger: { type: "on_create", table: "notifications" },
        actions: [{ action: "create_record", table: "books", values: { title: "B" } }],
        history_table: "wf-runs",
      },
    );
  }

  test("停止する —— 連鎖は有限で終わり、深度上限に当たったことが失敗として読める", () => {
    // 【V3-M13-T02 / ADR-0066 による期待値の更新】
    // **以前は「書かれた行数」で上限を読んでいた。** 決定が変わり、深度上限への到達は
    // 「失敗」になったので(限定16)、**連鎖の途中で書かれた行は1行残らず巻き戻る。**
    // 行数で上限を読む検査は成立しなくなったので、**上限に当たった事実は失敗の文面で読む。**
    // 上限値そのものの検査は describe「判断1 / 判断4」が別に固定している。
    const root = seedWithoutFiring("books", { title: "最初の1件" });
    withMutualWorkflows();

    const failures = fire(root);

    // 連鎖は有限で止まる(無限ループしない)。
    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toContain("深度上限");
    expect(String(failures[0])).toContain(String(WORKFLOW_MAX_DEPTH));
    // **連鎖が書いた行は1行も残らない**(起点の1件だけが残る)。
    expect(rowsOf("notifications")).toHaveLength(0);
    expect(rowsOf("books")).toHaveLength(1);
  });

  test("停止理由が「失敗」として履歴に残る(完了条件3。黙って止めない = 憲法6)", () => {
    // 【V3-M13-T04 / ADR-0066 限定5 による期待値の更新】
    // **`T02` の時点では、連鎖の内側で書かれた履歴行は発火元ごと巻き戻り、器の外から
    // 発火させた一番外側の1行だけが残っていた。** `T04` が「失敗の記録は消えない」を
    // 実装したので、**巻き戻った段の記録も書き直されて残る。**
    const root = seedWithoutFiring("books", { title: "最初の1件" });
    withMutualWorkflows();

    fire(root);

    const history = historyRows();
    // 段ごとに1行(0 段目から上限に当たった段まで)。**数は上限から機械的に導く。**
    expect(history).toHaveLength(WORKFLOW_MAX_DEPTH + 1);
    const failures = history.filter((row) => row.status === "failure");
    expect(failures).toHaveLength(WORKFLOW_MAX_DEPTH + 1);
    // **「止まった」だけでなく「なぜ止まったか」が読める文言であること。**
    expect(failures.some((row) => String(row.error).includes("深度上限"))).toBe(true);
    expect(failures.some((row) => String(row.error).includes(String(WORKFLOW_MAX_DEPTH)))).toBe(
      true,
    );
    // 一番外側の履歴は、連鎖の失敗を畳んで持つ(**順序は問わない** —— 同じミリ秒の
    // 同着が UUID で割れるため。この検査の作法は `insertionOrder` の doc にある)。
    const outermost = failures.find((row) => row.workflow === "a-books-to-notifications");
    expect(outermost).toBeDefined();
    expect(outermost?.trigger_type).toBe("on_create");
  });

  test("直線の連鎖でも、上限に当たれば連鎖が書いた行は1行も残らない", () => {
    // 【期待値の更新】以前は「t1..t{MAX} に1行ずつ書かれる」ことで上限を読んでいた。
    // ADR-0066 限定16 により上限到達は失敗になり、**連鎖全体が巻き戻る。**
    useChainDatabase();
    const root = seedWithoutFiring("t0", { title: "段0" });

    const failures = fire(root, "on_create", "t0");

    for (let index = 1; index <= WORKFLOW_MAX_DEPTH + 1; index += 1) {
      expect(rowsOf(`t${index}`)).toHaveLength(0);
    }
    expect(failures).toHaveLength(1);
    // 上限に当たったのは、最後に発火**できなかった** w{MAX} である。
    expect(String(failures[0])).toContain("深度上限");

    const history = historyRows();
    // 【V3-M13-T04 による期待値の更新】内側の履歴も巻き戻るが、**書き直されて残る**
    // (ADR-0066 限定5)。**行そのものは1行も残らないままである**(上の for が固定)。
    expect(history).toHaveLength(WORKFLOW_MAX_DEPTH + 1);
    expect(history.every((row) => row.status === "failure")).toBe(true);
    expect(history.some((row) => row.workflow === "w0")).toBe(true);
  });
});

describe("完了条件2: 自己更新するワークフロー(A→A)が再発火抑止で停止する", () => {
  /** 自分自身を更新し続ける1本(`target: "$record._id"`)。 */
  function withSelfUpdatingWorkflow(): void {
    withWorkflows({
      id: "self-updating",
      name: "自分自身を更新し続ける",
      trigger: { type: "on_update", table: "books" },
      actions: [
        {
          action: "update_record",
          table: "books",
          target: "$record._id",
          values: { memo: "自動更新" },
        },
      ],
      history_table: "wf-runs",
    });
  }

  test("停止する —— 深度上限を待たずに、2度目の発火が抑止される", () => {
    // 【V3-M13-T13 / ADR-0066 §改訂1 による期待値の更新】
    // **再発火抑止は「失敗」ではなくなった**(限定16 の適用範囲の縮小)。
    // `V3-M13-T02` の時点では抑止も失敗だったので自己更新の書込ごと巻き戻っていた。
    // **今日は自己更新が1回だけ効き、2度目の発火が抑止される**(20回書き換えない)。
    const book = addBook("こころ");
    withSelfUpdatingWorkflow();

    const failures = fire(book, "on_update");

    expect(rowsOf("books").find((row) => row._id === book._id)?.memo).toBe("自動更新");
    // **抑止は失敗として返らない** —— 発火元の書込を巻き戻さない。
    expect(failures).toHaveLength(0);
    // **深度上限(MAX)まで行かず、1段で止まる。**
    // 履歴は「外側の発火の成功1行」+「抑止された発火の失敗1行」の2行。
    expect(historyRows()).toHaveLength(2);
    expect(historyRows().length).toBeLessThan(WORKFLOW_MAX_DEPTH);
  });

  test("停止理由が履歴に残る(完了条件3)—— 3値目として。**行は消えない**", () => {
    const book = addBook("こころ");
    withSelfUpdatingWorkflow();

    fire(book, "on_update");

    // 【V4-M4-T02 / ADR-0072 による期待値の更新】**これは「実装の誤り」ではなく
    // 「期待値の更新」である** —— ADR-0072 が限定16(改訂後)の第4列「抑止が
    // `status="failure"` の履歴行として1行残るテスト」を、3値目の意味で書き直すことを
    // 求めている(ADR-0072 §5)。**行が1行残ることは1バイトも緩めていない**(限定5)。
    const suppressed = historyRows().filter((row) => row.status === "suppressed");
    expect(suppressed).toHaveLength(1);
    // 深度ではなく**再発火抑止**が理由であることが読めること。
    expect(String(suppressed[0]?.error)).toContain("再発火");
    expect(String(suppressed[0]?.error)).toContain(book._id);
    expect(suppressed[0]?.workflow).toBe("self-updating");
    expect(suppressed[0]?.trigger_type).toBe("on_update");
    // 【期待値の更新】以前はこの1行が「抑止された内側の発火」の履歴だった。
    // 内側は巻き戻るので、今は**外側の発火**の履歴に抑止の理由が畳まれている。
  });

  test("抑止は深度上限より先に効く(同じレコードなら深度に余裕があっても止まる)", () => {
    const book = addBook("こころ");
    withSelfUpdatingWorkflow();

    fire(book, "on_update");

    // 深度が理由なら error に「深度上限」が入る。入っていないことを直接見る。
    // 【V4-M4-T02】判定の順序(抑止 → 深度)は1つも変えていない(ADR-0072 限定7)。
    const suppressed = historyRows().filter((row) => row.status === "suppressed");
    expect(String(suppressed[0]?.error)).not.toContain("深度上限");
  });
});

describe("完了条件3 / 判断3: 再発火抑止のスコープは「1回の外部 CRUD の間ずっと」", () => {
  test("鍵は (テーブルID, レコードID) だけ —— トリガー種別を含まない", () => {
    // **これは判断3 が確定させた鍵の形をそのまま固定する検査である。**
    // A の発火で `books:<id>` が印される。その後 A のアクションが同じ本を更新すると、
    // 種別が on_create → on_update と変わっていても**同じ鍵**なので抑止される。
    //
    // **鍵に種別を含めない理由**: 含めると保証が「同じレコードが同じ種別で2度発火
    // することはない」に弱まり、一文で言えなくなる。**言える保証だけが守られる。**
    withWorkflows(
      {
        id: "a-on-create",
        name: "A: 本の作成で、その本自身を更新する",
        trigger: { type: "on_create", table: "books" },
        actions: [
          { action: "update_record", table: "books", target: "$record._id", values: { memo: "A" } },
        ],
        history_table: "wf-runs",
      },
      {
        id: "b-on-update",
        name: "B: 本の更新で通知を作る(抑止されて発火しない)",
        trigger: { type: "on_update", table: "books" },
        actions: [{ action: "create_record", table: "notifications", values: { title: "B" } }],
        history_table: "wf-runs",
      },
    );

    const root = seedWithoutFiring(
      "books",
      { title: "最初の1件" },
      ...(manifest.app.workflows ?? []),
    );
    const failures = fire(root);

    // B は1度も発火していない。
    expect(rowsOf("notifications")).toHaveLength(0);
    // 【V3-M13-T13 / ADR-0066 §改訂1 による期待値の更新】抑止が失敗でなくなったので、
    // **更新そのものは通る**(`V3-M13-T02` の時点では通らなかった)。
    expect(rowsOf("books")[0]?.memo).toBe("A");
    // 抑止は失敗として返らない。鍵の形(種別を含まない)は、B が1度も発火していない
    // ことと、抑止の履歴行が同じレコードを名指ししていることで読める。
    // 【V4-M4-T02 / ADR-0072 による期待値の更新】**鍵の形は1バイトも変わっていない**
    // (限定7)。変わったのは履歴の `status` 欄が `"failure"` から3値目になったことだけ。
    expect(failures).toHaveLength(0);
    const suppressed = historyRows().filter((row) => row.status === "suppressed");
    expect(suppressed).toHaveLength(1);
    expect(String(suppressed[0]?.error)).toContain("再発火");
    expect(String(suppressed[0]?.error)).toContain(root._id);
  });

  test("抑止は、印した発火の枠を抜けた後も残る(深度スコープではない)", () => {
    // A の action1 が別テーブルへ書いて深度 2 まで潜り、**深度 1 に戻ってから**
    // action2 が同じ本を触る。深度スコープの抑止ならここで印は消えているが、
    // **判断3 は「1回の外部 CRUD の間ずっと」なので消えない。**
    withWorkflows(
      {
        id: "a-on-create-books",
        name: "A: 通知を作ってから、本自身を更新する",
        trigger: { type: "on_create", table: "books" },
        actions: [
          { action: "create_record", table: "notifications", values: { title: "n" } },
          { action: "update_record", table: "books", target: "$record._id", values: { memo: "A" } },
        ],
        history_table: "wf-runs",
      },
      {
        id: "b-on-create-notifications",
        name: "B: 通知の作成で厳格テーブルへ書く(深度を1段潜らせるため)",
        trigger: { type: "on_create", table: "notifications" },
        actions: [{ action: "create_record", table: "strict", values: { must: "x" } }],
        history_table: "wf-runs",
      },
      {
        id: "c-on-update-books",
        name: "C: 本の更新で通知を作る(抑止されて発火しない)",
        trigger: { type: "on_update", table: "books" },
        actions: [{ action: "create_record", table: "notifications", values: { title: "c" } }],
        history_table: "wf-runs",
      },
    );

    const root = seedWithoutFiring(
      "books",
      { title: "最初の1件" },
      ...(manifest.app.workflows ?? []),
    );
    const failures = fire(root);

    // B は実際に発火して深度 2 まで潜った(= 深度は 1 へ戻っている)。
    expect(rowsOf("strict")).toHaveLength(1);
    // それでも C は抑止された。通知は action1 の1行だけ。
    expect(rowsOf("notifications").map((row) => row.title)).toEqual(["n"]);
    // 【V3-M13-T13 / ADR-0066 §改訂1 による期待値の更新】抑止は失敗として返らない
    // (`V3-M13-T02` の時点では `failures` に1件載っていた)。抑止が効いたことは
    // **履歴の行**で読む —— 届き先が呼び出し元から履歴へ移った。
    // 【V4-M4-T02 / ADR-0072】その行の `status` が3値目になった。**届き先は今日も履歴だけ
    // である**(ADR-0066 §改訂1 の限界2 は1文字も動いていない)。
    expect(failures).toHaveLength(0);
    const suppressed = historyRows().filter((row) => row.status === "suppressed");
    expect(suppressed).toHaveLength(1);
    expect(String(suppressed[0]?.error)).toContain("再発火");
    expect(String(suppressed[0]?.error)).toContain(root._id);
  });

  test("抑止は1回の CRUD で閉じる —— 次の外部 CRUD では同じレコードでも発火する", () => {
    withWorkflows({
      id: "on-update-books",
      name: "更新で通知を作る",
      trigger: { type: "on_update", table: "books" },
      actions: [{ action: "create_record", table: "notifications", values: { title: "n" } }],
      history_table: "wf-runs",
    });
    const book = addBook("こころ");

    unwrap(updateRecord(db, manifest, "books", book._id, { memo: "1回目" }));
    unwrap(updateRecord(db, manifest, "books", book._id, { memo: "2回目" }));

    // **同じレコードでも、外部 CRUD が別なら両方発火する。**
    expect(rowsOf("notifications")).toHaveLength(2);
    expect(historyRows()).toHaveLength(2);
    expect(historyRows().every((row) => row.status === "success")).toBe(true);
  });

  test("別のレコードは抑止されない —— 抑止の鍵は (テーブルID, レコードID) である", () => {
    withWorkflows({
      id: "on-create-books",
      name: "作成で通知を作る",
      trigger: { type: "on_create", table: "books" },
      actions: [{ action: "create_record", table: "notifications", values: { title: "n" } }],
      history_table: "wf-runs",
    });

    addBook("1件目");
    addBook("2件目");

    expect(rowsOf("notifications")).toHaveLength(2);
    expect(historyRows().filter((row) => row.status === "failure")).toHaveLength(0);
  });

  test("自己参照の create は抑止では止まらない —— 毎回別のレコードなので深度が止める", () => {
    // **抑止と深度が別々の機構であることの証拠。**create は毎回新しい _id を作るので
    // (テーブルID, レコードID) が一致せず、抑止は一度も効かない。
    withWorkflows({
      id: "self-referencing",
      name: "自分自身を作り続ける",
      trigger: { type: "on_create", table: "books" },
      actions: [{ action: "create_record", table: "books", values: { title: "自動生成" } }],
      history_table: "wf-runs",
    });

    const root = seedWithoutFiring(
      "books",
      { title: "最初の1件" },
      ...(manifest.app.workflows ?? []),
    );
    const failures = fire(root);

    // 【期待値の更新】以前は「MAX 段ぶんの行が残る」ことで深度が止めたことを見ていた。
    // 深度上限が失敗になり連鎖ごと巻き戻るので、**残るのは起点の1行だけ**である。
    // **止めたのが抑止ではなく深度であること**は失敗の文面で読める(ここが本題)。
    expect(rowsOf("books")).toHaveLength(1);
    expect(insertionOrder("books", "title")[0]).toBe("最初の1件");
    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toContain("深度上限");
    expect(String(failures[0])).not.toContain("再発火");
  });
});

describe("完了条件4: 停止後もシステムが健全である", () => {
  test("上限で止まった直後の通常 CRUD が、抑止も上限も持ち越さずに動く", () => {
    withWorkflows({
      id: "self-referencing",
      name: "自分自身を作り続ける",
      trigger: { type: "on_create", table: "books" },
      actions: [{ action: "create_record", table: "books", values: { title: "自動生成" } }],
      history_table: "wf-runs",
    });

    // 【期待値の更新】以前は「2回とも同じ数の行が書かれる」ことで健全さを見ていた。
    // 深度上限が失敗になり(限定16)連鎖ごと巻き戻るので、**行数では測れない。**
    // 測れるのは「2回目も1回目と**同じ結果**になる(持ち越しが無い)」ことである。
    const first = createRecord(db, manifest, "books", { title: "1件目" });
    const second = createRecord(db, manifest, "books", { title: "2件目" });

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    // 深度カウンタが 0 に戻り、抑止集合が空に戻っていなければ、2回目は
    // 「深度上限」ではなく別の理由(または即時)で落ちる。
    if (first.ok || second.ok) {
      throw new Error("失敗するはずの書込が成功しました。");
    }
    expect(String(first.errors[0]?.message)).toContain("深度上限");
    expect(String(second.errors[0]?.message)).toContain("深度上限");
    expect(rowsOf("books")).toHaveLength(0);
  });

  test("ワークフローを外した後の CRUD(読み書き・更新)が通常どおり通る", () => {
    withWorkflows({
      id: "self-referencing",
      name: "自分自身を作り続ける",
      trigger: { type: "on_create", table: "books" },
      actions: [{ action: "create_record", table: "books", values: { title: "自動生成" } }],
      history_table: "wf-runs",
    });
    // 【期待値の更新】暴走させる書込は、深度上限に当たって**成立しなくなった**(限定16)。
    expect(createRecord(db, manifest, "books", { title: "暴走させる" }).ok).toBe(false);

    manifest.app.workflows = [];
    const book = unwrap(createRecord(db, manifest, "books", { title: "静かな1件" }));
    unwrap(updateRecord(db, manifest, "books", book._id, { memo: "読了" }));

    const stored = rowsOf("books").find((row) => row._id === book._id);
    expect(stored?.title).toBe("静かな1件");
    expect(stored?.memo).toBe("読了");
  });

  test("アクションが例外を投げても、深度と抑止は必ず戻る", () => {
    withWorkflows({
      id: "explodes",
      name: "存在しないテーブルへ書く",
      trigger: { type: "on_create", table: "books" },
      // `strict` は `must` が required なので必ず失敗する(例外ではなく errors)。
      actions: [{ action: "create_record", table: "strict", values: {} }],
      history_table: "wf-runs",
    });

    // 【期待値の更新】器の内側で発火させると履歴ごと巻き戻る(T04 が解く)。
    // 深度と抑止が必ず戻ることを見たいので、器の外から2回発火させる。
    fire(seedWithoutFiring("books", { title: "1件目" }, ...(manifest.app.workflows ?? [])));
    fire(seedWithoutFiring("books", { title: "2件目" }, ...(manifest.app.workflows ?? [])));

    // 2回とも同じ失敗が記録される。1回目で抑止が閉じっぱなしになっていたら1行しかない。
    expect(historyRows()).toHaveLength(2);
    expect(historyRows().every((row) => row.status === "failure")).toBe(true);
  });
});

describe("判断1 / 判断4: WORKFLOW_MAX_DEPTH は読み取り専用の定数である", () => {
  test("値は 20 である", () => {
    expect(WORKFLOW_MAX_DEPTH).toBe(20);
  });

  test("差し替える口が公開されていない(テスト専用の口を本番に残さない)", async () => {
    const module = await import("./workflow-runner.ts");
    const setters = Object.keys(module).filter(
      (key) => /max.?depth/i.test(key) && key !== "WORKFLOW_MAX_DEPTH",
    );
    expect(setters).toEqual([]);
  });
});

describe("判断2: 履歴テーブルへの書き込みはワークフローを発火させない", () => {
  test("history_table を on_create トリガーに持つワークフローは valid だが発火しない", () => {
    // **これは T02 の暫定ではなく、T03 が確定させた恒久の仕様である。**
    // 履歴は「実行の記録」であって業務イベントではない(限定11 と同じ位置取り)。
    // 履歴の書き込みに深度の予算を食わせると、深度 MAX の連鎖が実際には MAX/2 段しか
    // 進まなくなり、上限の意味が「連鎖の長さ」からずれる。
    //
    // **代償(沈黙の破壊)**: 履歴テーブルをトリガーに持つワークフローは、参照整合性を
    // 通り、適用もでき、しかし**永久に発火しない。**この限界は
    // `src/mcp/vocabulary.ts` の `WORKFLOW_HISTORY_TABLE_TEMPLATE` で AI に宣言してある。
    withWorkflows(
      {
        id: "on-books",
        name: "本の作成で発火",
        trigger: { type: "on_create", table: "books" },
        actions: [{ action: "create_record", table: "notifications", values: { title: "n" } }],
        history_table: "wf-runs",
      },
      {
        id: "on-history",
        name: "履歴の作成で発火する(永久に発火しない)",
        trigger: { type: "on_create", table: "wf-runs" },
        actions: [{ action: "create_record", table: "notifications", values: { title: "x" } }],
        history_table: "wf-runs",
      },
    );

    addBook();

    expect(historyRows()).toHaveLength(1);
    expect(historyRows()[0]?.workflow).toBe("on-books");
    expect(rowsOf("notifications").map((row) => row.title)).toEqual(["n"]);
  });

  test("履歴の書き込みは深度の予算を1段も食わない", () => {
    // 履歴が深度を食っていれば、直線の連鎖は MAX 段ではなく MAX/2 段で止まる。
    // 【期待値の更新】連鎖の到達段数は行では読めなくなった(上限到達で全部巻き戻る)ので、
    // **`w{MAX}` まで発火が届いたこと**を、上限に当たったワークフローの id で読む。
    useChainDatabase();
    const root = seedWithoutFiring("t0", { title: "段0" });

    fire(root, "on_create", "t0");

    // 履歴が深度を食っていれば、上限に当たるのは w{MAX} ではなく w{MAX/2} になる。
    // 【V3-M13-T04 による期待値の更新】巻き戻った段の記録も書き直されて残るので、
    // 行数は1ではなく段数ぶんになる(ADR-0066 限定5)。**読む対象は一番外側の1行**で、
    // そこには連鎖の失敗が畳まれている。
    const failed = rowsOf("wf-runs").filter((row) => row.status === "failure");
    expect(failed).toHaveLength(WORKFLOW_MAX_DEPTH + 1);
    const outermost = failed.find((row) => row.workflow === "w0");
    expect(String(outermost?.error)).toContain(
      `アクション1(create_record → t${WORKFLOW_MAX_DEPTH}`,
    );
  });
});

// ---------------------------------------------------------------------------
// `$record.` の解決(限定12)
// ---------------------------------------------------------------------------

describe("$record. の解決", () => {
  /** 1アクションのワークフローを載せて `books` に1件作り、履歴の1行を返す。 */
  function runWith(values: Record<string, string>): RecordRow {
    withWorkflows({
      id: "resolve",
      name: "解決の検査",
      trigger: { type: "on_create", table: "books" },
      actions: [{ action: "create_record", table: "notifications", values }],
      history_table: "wf-runs",
    });
    // 【期待値の更新】解決エラーはアクションの失敗なので、器の内側で発火させると
    // 履歴ごと巻き戻る(T04 が解く)。**履歴の中身**を見たいので器の外から発火させる。
    const workflows = manifest.app.workflows ?? [];
    fire(
      seedWithoutFiring(
        "books",
        { title: "吾輩は猫である", title_kana: "わがはいはねこである" },
        ...workflows,
      ),
    );
    const rows = historyRows();
    if (rows[0] === undefined) {
      throw new Error("履歴が書かれていません");
    }
    return rows[0];
  }

  test("完全一致で解決する —— $record.title_kana が title で壊れない", () => {
    const history = runWith({ title: "$record.title_kana", source: "$record.title" });
    expect(history.status).toBe("success");
    const notification = rowsOf("notifications")[0];
    // 前方一致で判定していると、ここが "わがはいはねこである" ではなく
    // "吾輩は猫である_kana" のような壊れ方をする。
    expect(notification?.title).toBe("わがはいはねこである");
    expect(notification?.source).toBe("吾輩は猫である");
  });

  test("$record._id が解決できる", () => {
    const history = runWith({ source: "$record._id" });
    expect(history.status).toBe("success");
    const book = rowsOf("books")[0];
    expect(rowsOf("notifications")[0]?.source).toBe(book?._id);
  });

  test("$record._created_at は解決エラーになる(_id 以外の _ 始まりは許さない)", () => {
    const history = runWith({ source: "$record._created_at" });
    expect(history.status).toBe("failure");
    expect(String(history.error)).toContain("$record._created_at");
    // 解決できなかったアクションは実行しない。空文字を書かない(憲法6)。
    expect(rowsOf("notifications")).toHaveLength(0);
  });

  test("$record._updated_at も解決エラーになる", () => {
    const history = runWith({ source: "$record._updated_at" });
    expect(history.status).toBe("failure");
    expect(rowsOf("notifications")).toHaveLength(0);
  });

  test("存在しないフィールドを指すと解決エラーになる", () => {
    const history = runWith({ source: "$record.no_such_field" });
    expect(history.status).toBe("failure");
    expect(String(history.error)).toContain("no_such_field");
    expect(rowsOf("notifications")).toHaveLength(0);
  });

  test("リテラル文字列は、たまたまフィールドIDと同じでも触られない", () => {
    const history = runWith({ title: "title", source: "$record.title" });
    expect(history.status).toBe("success");
    expect(rowsOf("notifications")[0]?.title).toBe("title");
    expect(rowsOf("notifications")[0]?.source).toBe("吾輩は猫である");
  });

  test("トリガーレコードが undefined(schedule 相当)だと $record. が解決エラーになる", () => {
    // **【V1-M2-T08 単位2 による訂正。元の記述は嘘になった】**
    // 元は「T02 の時点で schedule は発火しない(T08 の担当)ので、この経路は
    // 単体テストでしか通らない」だった。**T08 が `runScheduledWorkflow` を配線し、
    // `workflow-scheduler.ts` が実際に `record === undefined` で発火させている。**
    //
    // **ただし「`$record.` を書いた schedule ワークフロー」は実行まで届かない** ——
    // `referential-integrity.ts` が適用時に拒否する(§2-2 判断3。実測: T08 単位2 の
    // テストが実際にこの拒否に当たった)。**それでも解決器側の防御を残すのは、
    // 静的検査を通らずに実行へ届く経路**(手で書き換えられた `manifest.json` など)
    // **で、解決できない参照が空文字に化けて通知に載るのを防ぐためである。**
    // **2段構えであることを、次の者が片方を消さないように書いておく。**
    withWorkflows({
      id: "no-record",
      name: "レコード源が無い",
      trigger: { type: "on_create", table: "books" },
      actions: [
        { action: "create_record", table: "notifications", values: { source: "$record.title" } },
      ],
      history_table: "wf-runs",
    });

    runWorkflows(db, manifest, "books", "on_create", undefined);

    expect(historyRows()).toHaveLength(1);
    expect(historyRows()[0]?.status).toBe("failure");
    expect(rowsOf("notifications")).toHaveLength(0);
  });

  /**
   * **【期待値を2度反転させた。どちらも黙って書き換えていない。2026-08-10】**
   *
   * ## **1度目の反転(同日の前段。`V8-M26-T03` / `T04` の直後)**
   *
   * **旧の test 名の逐語**: 「トリガーレコードが undefined でも、$record. を使わない
   * アクションは実行できる」。
   * **旧の期待値の逐語**:
   *   `expect(historyRows()[0]?.status).toBe("success");`
   *   `expect(rowsOf("notifications").map((row) => row.title)).toEqual(["定時通知"]);`
   *
   * **反転の根拠(当時)**: **`V8-M26`(`D-V8-45` / `D-V8-65`)が面の既定を「閉じる」側へ
   * 倒した。** **トリガーレコードが `undefined` の発火では書き手を1人も特定できず**
   * (`resolveWorkflowActor` の既定はトリガー元の行の `st_owner` 1本)、
   * **書き手が `null` の主体は面から見て `anonymous` である。**
   * **`anonymous` には書込の規則を1本も書けない**(`schemas/manifest.schema.json` の
   * `J-G11` の分岐が `can` を `read` 1語に閉じている)——
   * **したがって、規則をどう配ってもこの発火は今日どこにも書けない。**
   *
   * **1度目の反転後の test 名の逐語**: 「トリガーレコードが undefined の発火は、
   * $record. を使わなくても書けない(`V8-M26` で反転)」。
   * **1度目の反転後の期待値の逐語**(**これも消さずに残す**):
   *   `expect(historyRows()[0]?.status).toBe("failure");`
   *   `expect(String(historyRows()[0]?.error)).toContain("書き手を特定できません");`
   *   `expect(rowsOf("notifications")).toHaveLength(0);`
   *
   * ## **2度目の反転(同日の後段。**元に戻した**)**
   *
   * **反転の根拠**: **メインの裁定** —— **`judgeAutomationWrite` の素通しの条件を
   * 「規則が書かれていないから通す」から「書き手が特定できないから通す」へ差し替えた。**
   * **1度目の反転が記録したふるまい(書き手の居ない発火がどこにも書けない)は、
   * 既定を閉じたことの意図された帰結ではなく、素通しの条件が既定の反転で死んだ副作用で
   * あった**(旧の条件は `judgeRoleAccess(...).governed` を見ており、既定を閉じた後は
   * 常に真になる)。
   * **`docs/plan/v8/05-authz-unification-baseline.md` §8 の 6 は「決まった時刻に動く処理が
   * 今日も素通しすることを、実測で示すこと」を完了条件として要求し、§9 の 1 は
   * 「書けるのは『時刻で動く処理を除く経路で効く』までであり、その1本を必ず併記する」と
   * 定めている。**
   *
   * **したがって期待値は1度目の反転**より前**の形に戻る。**
   * **【正直に書く】戻したのは「書き手が特定できない発火が書けること」だけである** ——
   * **書き手が特定できる発火は今日も面に止められる**(実測は
   * `src/kernel/automation-writer-passthrough.test.ts` の (f))。
   */
  test("トリガーレコードが undefined でも、$record. を使わないアクションは実行できる", () => {
    withWorkflows({
      id: "no-record-literal",
      name: "リテラルだけ",
      trigger: { type: "on_create", table: "books" },
      actions: [{ action: "create_record", table: "notifications", values: { title: "定時通知" } }],
      history_table: "wf-runs",
    });

    runWorkflows(db, manifest, "books", "on_create", undefined);

    expect(historyRows()[0]?.status).toBe("success");
    expect(rowsOf("notifications").map((row) => row.title)).toEqual(["定時通知"]);
  });

  test("update_record の target が解決できないと、そのアクションだけが失敗する", () => {
    withWorkflows({
      id: "bad-target",
      name: "target が壊れている",
      trigger: { type: "on_create", table: "books" },
      actions: [
        {
          action: "update_record",
          table: "books",
          target: "$record._created_at",
          values: { memo: "x" },
        },
        { action: "create_record", table: "notifications", values: { title: "後続" } },
      ],
      history_table: "wf-runs",
    });

    // 【期待値の更新】器の外から発火させる(器の内側では履歴も後続の書込も巻き戻る)。
    const workflows = manifest.app.workflows ?? [];
    fire(seedWithoutFiring("books", { title: "吾輩は猫である" }, ...workflows));

    expect(historyRows()[0]?.status).toBe("failure");
    expect(rowsOf("books")[0]?.memo).toBeNull();
    expect(rowsOf("notifications").map((row) => row.title)).toEqual(["後続"]);
  });
});

// ---------------------------------------------------------------------------
// V1-M2-T08 単位1 完了条件3: 履歴の `ran_at` が時刻源から来る
// ---------------------------------------------------------------------------

describe("V1-M2-T08 完了条件3: 実行履歴の ran_at が時刻源から来る", () => {
  const wf: Workflow = {
    id: "stamped",
    name: "時刻の出どころを見る",
    trigger: { type: "on_create", table: "books" },
    actions: [{ action: "create_record", table: "notifications", values: { title: "通知" } }],
    history_table: "wf-runs",
  };

  test("注入した時刻源の時刻が ran_at にそのまま書かれる", () => {
    withWorkflows(wf);
    setWorkflowClock({ now: () => new Date("2026-03-01T04:05:06.000Z") });

    addBook();

    // **これが成り立たないと、時刻を注入して発火させても「注入した時刻に発火した」
    // ことを履歴から確認できない**(計画 §2-8 の訂正2)。
    expect(historyRows()[0]?.ran_at).toBe("2026-03-01T04:05:06.000Z");
  });

  test("時刻を進めると、次の実行の ran_at も進む", () => {
    withWorkflows(wf);
    let current = new Date("2026-03-01T00:00:00.000Z");
    const clock: Clock = { now: () => current };
    setWorkflowClock(clock);

    addBook("1冊目");
    current = new Date("2026-03-02T09:30:00.000Z");
    addBook("2冊目");

    expect(insertionOrder("wf-runs", "ran_at")).toEqual([
      "2026-03-01T00:00:00.000Z",
      "2026-03-02T09:30:00.000Z",
    ]);
  });

  test("失敗した実行の履歴でも ran_at は時刻源から来る", () => {
    withWorkflows({
      ...wf,
      // `strict` は `must` が required なので、値を与えない書き込みは必ず失敗する。
      actions: [{ action: "create_record", table: "strict", values: {} }],
    });
    setWorkflowClock({ now: () => new Date("2026-03-03T12:00:00.000Z") });

    // 【期待値の更新】器の外から発火させる(器の内側では失敗の履歴が巻き戻る。T04 が解く)。
    fire(
      seedWithoutFiring("books", { title: "吾輩は猫である" }, ...(manifest.app.workflows ?? [])),
    );

    const row = historyRows()[0];
    expect(row?.status).toBe("failure");
    expect(row?.ran_at).toBe("2026-03-03T12:00:00.000Z");
  });

  test("完了条件2: 注入していない既定は実時刻である(reset で戻る)", () => {
    withWorkflows(wf);
    setWorkflowClock({ now: () => new Date("1999-01-01T00:00:00.000Z") });
    resetWorkflowClock();

    const before = Date.now();
    addBook();
    const after = Date.now();

    const ranAt = Date.parse(String(historyRows()[0]?.ran_at));
    expect(ranAt).toBeGreaterThanOrEqual(before);
    expect(ranAt).toBeLessThanOrEqual(after);
  });

  test("一度も注入していない経路の ran_at も実時刻である", () => {
    // **本タスクで最も重要な検査**: 差し替えの口は「観測/注入のための口」であって、
    // 本番の既定挙動を変える口ではない(判断3 / T03 判断4 の規律)。
    withWorkflows(wf);

    const before = Date.now();
    addBook();
    const after = Date.now();

    const ranAt = Date.parse(String(historyRows()[0]?.ran_at));
    expect(Number.isNaN(ranAt)).toBe(false);
    expect(ranAt).toBeGreaterThanOrEqual(before);
    expect(ranAt).toBeLessThanOrEqual(after);
  });

  test("ran_at は UTC の ISO8601(末尾 Z)のままである —— TZ 付きに変えない", () => {
    // **判断**: 時刻源を入れても `ran_at` の形式は1バイトも変えない。
    // 変えると T02 が書いた既存の履歴行と新しい行で形式が混ざる。
    // 「その TZ での今日」は読み取り側(`zonedNow`)が導く(ADR-0013 §6c)。
    withWorkflows(wf);
    setWorkflowClock({ now: () => new Date("2026-03-04T15:30:00.000Z") });

    addBook();

    const ranAt = String(historyRows()[0]?.ran_at);
    expect(ranAt.endsWith("Z")).toBe(true);
    expect(new Date(ranAt).toISOString()).toBe(ranAt);
  });
});

// ---------------------------------------------------------------------------
// V2-M3-T01: EC-G5 条件分岐(最小述語 `when`。ADR-0036)
// ---------------------------------------------------------------------------

describe("V2-M3-T01: EC-G5 条件分岐(when)", () => {
  test("when 一致 —— アクションが実行される", () => {
    withWorkflows({
      id: "notify-when-match",
      name: "状態が done のときだけ通知",
      trigger: { type: "on_create", table: "books" },
      actions: [
        {
          action: "create_record",
          table: "notifications",
          values: { title: "完了しました", source: "$record.title" },
          when: { field: "status", equals: "done" },
        },
      ],
      history_table: "wf-runs",
    });

    addBook("坊っちゃん", { status: "done" });

    const notifications = rowsOf("notifications");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.source).toBe("坊っちゃん");
    // 実行されたので status=success、error は null(スキップも失敗も無い)。
    const rows = historyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("success");
    expect(rows[0]?.error).toBeNull();
  });

  test("when 不一致 —— アクションがスキップされ、出力先に1行も書かれない", () => {
    withWorkflows({
      id: "notify-when-skip",
      name: "状態が done のときだけ通知",
      trigger: { type: "on_create", table: "books" },
      actions: [
        {
          action: "create_record",
          table: "notifications",
          values: { title: "完了しました", source: "$record.title" },
          when: { field: "status", equals: "done" },
        },
      ],
      history_table: "wf-runs",
    });

    addBook("坊っちゃん", { status: "draft" });

    // 条件不成立 —— 出力先に何も書かれない。
    expect(rowsOf("notifications")).toHaveLength(0);
  });

  test("完了条件3(最重要): スキップは失敗ではないが履歴に loud に残る", () => {
    withWorkflows({
      id: "notify-when-skip-loud",
      name: "状態が done のときだけ通知",
      trigger: { type: "on_create", table: "books" },
      actions: [
        {
          action: "create_record",
          table: "notifications",
          values: { title: "完了しました", source: "$record.title" },
          when: { field: "status", equals: "done" },
        },
      ],
      history_table: "wf-runs",
    });

    addBook("坊っちゃん", { status: "draft" });

    const rows = historyRows();
    // 実行1回=1行の粒度は維持。
    expect(rows).toHaveLength(1);
    // **スキップは失敗ではない** —— status は success のまま。
    expect(rows[0]?.status).toBe("success");
    // **黙って消えない** —— スキップした事実(どのアクションが・なぜ)が error に残る。
    const error = String(rows[0]?.error);
    expect(error).toContain("スキップ");
    expect(error).toContain("status");
    expect(error).toContain("done");
  });

  test("when 無しのアクションは1バイトも挙動が変わらない(後方互換)", () => {
    withWorkflows({
      id: "notify-no-when",
      name: "無条件通知",
      trigger: { type: "on_create", table: "books" },
      actions: [
        {
          action: "create_record",
          table: "notifications",
          values: { title: "登録", source: "$record.title" },
          // when 無し
        },
      ],
      history_table: "wf-runs",
    });

    addBook("こころ");

    expect(rowsOf("notifications")).toHaveLength(1);
    const rows = historyRows();
    expect(rows[0]?.status).toBe("success");
    // 従来どおり成功行の error は null。
    expect(rows[0]?.error).toBeNull();
  });

  test("when は number 列で型どおりに比較する(一致で実行)", () => {
    withWorkflows({
      id: "notify-number",
      name: "ページ数が0のときだけ通知",
      trigger: { type: "on_create", table: "books" },
      actions: [
        {
          action: "create_record",
          table: "notifications",
          values: { title: "空の本", source: "$record.title" },
          when: { field: "pages", equals: 0 },
        },
      ],
      history_table: "wf-runs",
    });

    addBook("零", { pages: 0 });
    expect(rowsOf("notifications")).toHaveLength(1);
  });

  test("when は number 列で不一致ならスキップ", () => {
    withWorkflows({
      id: "notify-number-skip",
      name: "ページ数が0のときだけ通知",
      trigger: { type: "on_create", table: "books" },
      actions: [
        {
          action: "create_record",
          table: "notifications",
          values: { title: "空の本", source: "$record.title" },
          when: { field: "pages", equals: 0 },
        },
      ],
      history_table: "wf-runs",
    });

    addBook("厚い本", { pages: 300 });
    expect(rowsOf("notifications")).toHaveLength(0);
  });

  test("when は boolean 列で型どおりに比較する(SQLite の 0/1 に惑わされない)", () => {
    withWorkflows({
      id: "notify-boolean",
      name: "書庫入りのときだけ通知",
      trigger: { type: "on_create", table: "books" },
      actions: [
        {
          action: "create_record",
          table: "notifications",
          values: { title: "書庫入り", source: "$record.title" },
          when: { field: "archived", equals: true },
        },
      ],
      history_table: "wf-runs",
    });

    addBook("古書", { archived: true });
    expect(rowsOf("notifications")).toHaveLength(1);

    addBook("新刊", { archived: false });
    // false のほうはスキップ(1件のまま)。
    expect(rowsOf("notifications")).toHaveLength(1);
  });

  test("失敗とスキップが同居 —— status は failure、error に両方が loud に残る", () => {
    withWorkflows({
      id: "fail-and-skip",
      name: "1つ失敗・1つスキップ",
      trigger: { type: "on_create", table: "books" },
      actions: [
        // must が required なので必ず失敗する。
        { action: "create_record", table: "strict", values: {} },
        // 条件不成立でスキップ。
        {
          action: "create_record",
          table: "notifications",
          values: { title: "スキップされる", source: "x" },
          when: { field: "status", equals: "done" },
        },
      ],
      history_table: "wf-runs",
    });

    // 【期待値の更新】器の外から発火させる(器の内側では失敗の履歴が巻き戻る。T04 が解く)。
    fire(
      seedWithoutFiring(
        "books",
        { title: "本", status: "draft" },
        ...(manifest.app.workflows ?? []),
      ),
    );

    const rows = historyRows();
    expect(rows).toHaveLength(1);
    // 失敗があるので status=failure。
    expect(rows[0]?.status).toBe("failure");
    const error = String(rows[0]?.error);
    // 失敗もスキップも両方 error に畳まれている(どちらも黙って消えない)。
    expect(error).toContain("must");
    expect(error).toContain("スキップ");
  });

  test("when 一致で update_record も実行され、不一致ではトリガー行が更新されない", () => {
    withWorkflows({
      id: "stamp-when",
      name: "状態が done のときだけメモを付ける",
      trigger: { type: "on_create", table: "books" },
      actions: [
        {
          action: "update_record",
          table: "books",
          target: "$record._id",
          values: { memo: "完了スタンプ" },
          when: { field: "status", equals: "done" },
        },
      ],
      history_table: "wf-runs",
    });

    const done = addBook("完了本", { status: "done" });
    const draft = addBook("下書き本", { status: "draft" });

    const stampedDone = rowsOf("books").find((row) => row._id === done._id);
    const stampedDraft = rowsOf("books").find((row) => row._id === draft._id);
    expect(stampedDone?.memo).toBe("完了スタンプ");
    // 不一致の行は更新されない(memo は null のまま)。
    expect(stampedDraft?.memo).toBeNull();
  });

  test("同一発火で片方 when 一致・片方 when 不一致 —— 一致のみ実行し、スキップは残る", () => {
    withWorkflows({
      id: "mixed-when",
      name: "2アクションで別々の条件",
      trigger: { type: "on_create", table: "books" },
      actions: [
        {
          action: "create_record",
          table: "notifications",
          values: { title: "A", source: "$record.title" },
          when: { field: "status", equals: "done" },
        },
        {
          action: "create_record",
          table: "notifications",
          values: { title: "B", source: "$record.title" },
          when: { field: "status", equals: "archived" },
        },
      ],
      history_table: "wf-runs",
    });

    addBook("本", { status: "done" });

    // 一致した A だけ書かれる。
    expect(rowsOf("notifications").map((row) => row.title)).toEqual(["A"]);
    // 不一致の B はスキップとして履歴に残る(status は success)。
    const rows = historyRows();
    expect(rows[0]?.status).toBe("success");
    expect(String(rows[0]?.error)).toContain("スキップ");
  });
});

// ---------------------------------------------------------------------------
// V3-M13-T02: アクションの失敗を発火元の書込ごと致命にする(ADR-0066)
//
// **限定表(ADR-0066 §3)の範囲だけを固定する。**
// - 限定1: 器はカーネルの `records.ts` にだけ置く(入口層に1バイトも足さない)
// - 限定2: deferred のみ。入れ子は内側だけを巻き戻す
// - 限定3: 前が失敗しても後続を実行する(ADR-0013 `0013:418`)
// - 限定4: 例外を呼び出し元へ伝播させない(値に変換して運ぶ)
// - 限定7: `schedule` は原子性を保証しない(巻き戻らない)
// - 限定8: バッチは既存の `throw BatchOpFailure` を引き金にする
// - 限定12: 失敗は既存の `RecordResult` の `ok:false` と `ValidationError` 形式で返す
// - 限定16: 連鎖の停止(深度上限・再発火抑止)も失敗として発火元を巻き戻す
// ---------------------------------------------------------------------------

describe("V3-M13-T02: アクション失敗が発火元の書込を巻き戻す(ADR-0066)", () => {
  /** 必ず失敗するアクション(required 列に値を与えない)を1本だけ持つワークフロー。 */
  function withFailingWorkflow(triggerType: "on_create" | "on_update" = "on_create"): void {
    withWorkflows({
      id: "always-fails",
      name: "必ず失敗する",
      trigger: { type: triggerType, table: "books" },
      actions: [{ action: "create_record", table: "strict", values: {} }],
      history_table: "wf-runs",
    });
  }

  test("器を持たない経路(MCP 単件相当)—— createRecord が ok:false になり、本体行が1行も残らない", () => {
    withFailingWorkflow();

    const result = createRecord(db, manifest, "books", { title: "巻き戻る" });

    expect(result.ok).toBe(false);
    // **「例外が飛ばなかった」ではなく、DB を読んで不在を確かめる。**
    expect(rowsOf("books")).toHaveLength(0);
  });

  test("限定12: 失敗は既存の ValidationError 形式で返り、conflict ではない", () => {
    withFailingWorkflow();

    const result = createRecord(db, manifest, "books", { title: "形式" });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("失敗するはずの書込が成功しました。");
    }
    expect(result.conflict).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    const error = result.errors[0];
    expect(typeof error?.path).toBe("string");
    expect(typeof error?.message).toBe("string");
    // 失敗の中身(どのアクションが何で落ちたか)が読める文面であること(憲法6)。
    expect(String(error?.message)).toContain("アクション1");
    expect(String(error?.message)).toContain("strict");
  });

  test("updateRecord —— 更新が巻き戻り、更新前の値がそのまま残る", () => {
    const book = addBook("元のタイトル");
    withFailingWorkflow("on_update");

    const result = updateRecord(db, manifest, "books", book._id, { memo: "更新した" });

    expect(result.ok).toBe(false);
    const stored = rowsOf("books");
    // **行そのものは消えない。**巻き戻るのは更新だけである。
    expect(stored).toHaveLength(1);
    expect(stored[0]?.memo).toBeNull();
    expect(stored[0]?._updated_at).toBe(book._updated_at);
  });

  test("限定2: 器(deferred tx)の内側で失敗しても、内側だけが巻き戻る(入れ子の観測)", () => {
    withFailingWorkflow();

    // `src/server/app.ts:804` / `src/server/inbound-route.ts:124` と同じ形の deferred tx。
    const tx = db.transaction(() => {
      const outer = createRecord(db, manifest, "notifications", { title: "外側" });
      expect(outer.ok).toBe(true);
      return createRecord(db, manifest, "books", { title: "内側" });
    });
    const inner = tx();

    expect(inner.ok).toBe(false);
    // 内側(books)は巻き戻り、外側(notifications)は commit される = SAVEPOINT の振る舞い。
    expect(rowsOf("books")).toHaveLength(0);
    expect(rowsOf("notifications").map((row) => row.title)).toEqual(["外側"]);
  });

  test("限定8: バッチは 1 op のアクション失敗でバッチ全体が巻き戻る(batch.ts に1バイトも足さない)", () => {
    withFailingWorkflow();

    const result = writeRecords(db, manifest, [
      { op: "create", table: "notifications", values: { title: "巻き添え" } },
      { op: "create", table: "books", values: { title: "失敗する側" } },
    ]);

    expect(result.ok).toBe(false);
    // **無関係な他の op まで巻き戻る**(ADR-0066 §限界4)。
    expect(rowsOf("notifications")).toHaveLength(0);
    expect(rowsOf("books")).toHaveLength(0);
  });

  test("限定3: 前のアクションが失敗しても後続を実行する(途中で止めない)", () => {
    withWorkflows({
      id: "two-failures",
      name: "2つとも失敗する",
      trigger: { type: "on_create", table: "books" },
      actions: [
        { action: "create_record", table: "strict", values: {} },
        { action: "create_record", table: "ghosts", values: { title: "x" } },
      ],
      history_table: "wf-runs",
    });

    const result = createRecord(db, manifest, "books", { title: "両方走る" });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("失敗するはずの書込が成功しました。");
    }
    const message = String(result.errors[0]?.message);
    // **2本目まで実行された証拠**を、失敗の文面の中に見る(行は巻き戻るので読めない)。
    expect(message).toContain("アクション1");
    expect(message).toContain("アクション2");
    expect(message).toContain("ghosts");
  });

  test("限定4: アクションが例外を投げても呼び出し元へ伝播せず、値として運ばれる", () => {
    // マニフェストにだけ在って DDL を当てていないテーブル = 実行時に SQLite が投げる。
    manifest.app.tables.push({
      id: "not-migrated",
      name: "DDL を当てていない",
      fields: [{ id: "title", name: "件名", type: "text" }],
    });
    withWorkflows({
      id: "throws",
      name: "カーネルが投げる",
      trigger: { type: "on_create", table: "books" },
      actions: [{ action: "create_record", table: "not-migrated", values: { title: "x" } }],
      history_table: "wf-runs",
    });

    // **例外が呼び出し元まで来ないこと**(来れば HTTP が 500 になる = `0013:417` 後段違反)。
    const result = createRecord(db, manifest, "books", { title: "例外" });

    expect(result.ok).toBe(false);
    expect(rowsOf("books")).toHaveLength(0);
  });

  test("限定16: 深度上限に当たった連鎖では、一番外側の書込が巻き戻る", () => {
    useChainDatabase();

    const result = createRecord(db, manifest, "t0", { title: "段0" });

    expect(result.ok).toBe(false);
    // 連鎖の途中で書かれた行も、一番外側の行も、1行も残らない。
    expect(rowsOf("t0")).toHaveLength(0);
    expect(rowsOf(`t${WORKFLOW_MAX_DEPTH}`)).toHaveLength(0);
  });

  test("限定16: 再発火抑止で止まった連鎖でも、一番外側の書込が巻き戻る", () => {
    withWorkflows({
      id: "self-update",
      name: "自分自身を更新する",
      trigger: { type: "on_create", table: "books" },
      actions: [
        {
          action: "update_record",
          target: "$record",
          table: "books",
          values: { memo: "自己更新" },
        },
      ],
      history_table: "wf-runs",
    });

    const result = createRecord(db, manifest, "books", { title: "自己更新の起点" });

    expect(result.ok).toBe(false);
    expect(rowsOf("books")).toHaveLength(0);
  });

  test("【T04 が反転させた】巻き戻しても失敗の履歴行は残る", () => {
    withFailingWorkflow();

    expect(createRecord(db, manifest, "books", { title: "履歴は残る" }).ok).toBe(false);

    // **`T02` の時点ではここが0行だった**(憲法6 と衝突していた)。**`V3-M13-T04` が
    // ADR-0066 限定5 を (B)「巻き戻し後に改めて書く」で実装し、反転した。**
    // 詳しい固定は describe「V3-M13-T04」にある。
    expect(historyRows().map((row) => row.status)).toEqual(["failure"]);
  });

  test("限定7: `schedule` は巻き戻らない —— 途中失敗でも部分適用が残る", () => {
    const workflow: Workflow = {
      id: "scheduled-partial",
      name: "毎日の後追い処理",
      trigger: { type: "schedule", at: { hour: 3, minute: 0 } },
      actions: [
        { action: "create_record", table: "notifications", values: { title: "先に成功する" } },
        { action: "create_record", table: "strict", values: {} },
      ],
      history_table: "wf-runs",
    };
    withWorkflows(workflow);

    runScheduledWorkflow(db, manifest, workflow);

    // **成功した側の書込が残る**(発火全体は原子的にならない)。
    expect(rowsOf("notifications").map((row) => row.title)).toEqual(["先に成功する"]);
    // 失敗は履歴に残る(`schedule` の履歴は巻き戻らないので消えない)。
    expect(historyRows()[0]?.status).toBe("failure");
  });

  test("限定7 の但し書き: `schedule` のアクションが行う書込1件だけは巻き戻る", () => {
    const scheduled: Workflow = {
      id: "scheduled-writes-books",
      name: "毎日 books に書く",
      trigger: { type: "schedule", at: { hour: 3, minute: 0 } },
      actions: [{ action: "create_record", table: "books", values: { title: "書けない" } }],
      history_table: "wf-runs",
    };
    withWorkflows(scheduled, {
      id: "books-fails",
      name: "books の on_create が失敗する",
      trigger: { type: "on_create", table: "books" },
      actions: [{ action: "create_record", table: "strict", values: {} }],
      history_table: "wf-runs",
    });

    runScheduledWorkflow(db, manifest, scheduled);

    // その1件の書込だけが成立しない。`schedule` の発火自体は巻き戻らない(履歴が残る)。
    expect(rowsOf("books")).toHaveLength(0);
    expect(historyRows().some((row) => row.status === "failure")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// V3-M13-T13: 再発火抑止は「失敗」ではない(ADR-0066 §改訂1 = 限定16 の適用範囲の縮小)
//
// `V3-M13-T01` の限定16 は「連鎖の停止(深度上限 / 再発火抑止)も失敗として発火元を
// 巻き戻す」だった。`V3-M13-T02` がそれを字義どおり実装した結果、**書き戻し
// (ADR-0037 の Route B)を `on_update` で使うと、書き戻しの `updateRecord` が必ず
// 再発火抑止に当たり、外側の更新ごと成立しなくなった。**
//
// `V3-M13-T13` の門A本審査(`V3-M9-G1` の2回目。判定 = 限定採用)が限定16 の適用範囲を
// **再発火抑止を除いた形**へ狭めた。**深度上限は今日も「失敗」のままである。**
// ---------------------------------------------------------------------------

describe("V3-M13-T13: 再発火抑止は失敗ではない(ADR-0066 §改訂1)", () => {
  /** 自分自身を更新する1本(`target: "$record._id"`)。書き戻しと同じ形の自己更新。 */
  function withSelfUpdatingWorkflow(): void {
    withWorkflows({
      id: "self-updating",
      name: "自分自身を更新する",
      trigger: { type: "on_update", table: "books" },
      actions: [
        {
          action: "update_record",
          table: "books",
          target: "$record._id",
          values: { memo: "自動更新" },
        },
      ],
      history_table: "wf-runs",
    });
  }

  test("器の内側 —— 自己更新が抑止に当たっても、発火元の更新は成立する", () => {
    const book = addBook("こころ");
    withSelfUpdatingWorkflow();

    const result = updateRecord(db, manifest, "books", book._id, { title: "こころ(改)" });

    // **外側の更新が成立する**(ADR-0066 §改訂1 の前は `ok:false` だった)。
    expect(result.ok).toBe(true);
    const stored = rowsOf("books");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.title).toBe("こころ(改)");
    // **自己更新も1回だけ効く**(2度目は抑止される = 20回書き換えない)。
    expect(stored[0]?.memo).toBe("自動更新");
  });

  test('抑止の理由は履歴行として**残る**(巻き戻らない)—— ただし `status` は "failure" ではない', () => {
    const book = addBook("こころ");
    withSelfUpdatingWorkflow();

    expect(updateRecord(db, manifest, "books", book._id, { title: "改" }).ok).toBe(true);

    // 【V4-M4-T01 / ADR-0072 による期待値の更新】ADR-0066 §改訂1 の前は、外側が巻き戻るので
    // 履歴行も一緒に消えていた(0行)。**`V3-M13-T13` で行は残るようになったが `status` は
    // `"failure"` だった。** ADR-0072(限定表10点)が「抑止を失敗と呼ばない」と定め、
    // **`status` が3値目になった。行は今日も残る**(ADR-0072 限定5)。
    const suppressed = historyRows().filter((row) => row.status === "suppressed");
    expect(suppressed).toHaveLength(1);
    expect(String(suppressed[0]?.error)).toContain("再発火");
    expect(String(suppressed[0]?.error)).toContain(book._id);
    expect(String(suppressed[0]?.error)).not.toContain("深度上限");
    // **抑止は「失敗」として数えられない**(ADR-0072 の目的 = D-V4-37「記録が事実と違うのを
    // 直すため」)。この経路で `failure` の行は1つも書かれない。
    expect(historyRows().filter((row) => row.status === "failure")).toHaveLength(0);
  });

  test("【ADR-0072 限定2】3値目の綴りは `suppressed` に凍結する(値で押さえる)", () => {
    const book = addBook("こころ");
    withSelfUpdatingWorkflow();
    expect(updateRecord(db, manifest, "books", book._id, { title: "改" }).ok).toBe(true);

    // **定数は `src/kernel/` から export しない**(ADR-0072 限定10 = Δ8 を空に保つ)ので、
    // 凍結は「履歴に実際に書かれた値」で押さえる。**綴りが1文字でも変われば赤になる。**
    const statuses = historyRows().map((row) => row.status);
    expect(statuses).toContain("suppressed");
    // 4値目を足していないこと(限定2)—— この経路に現れる `status` は2種類だけである。
    expect([...new Set(statuses)].sort()).toEqual(["success", "suppressed"]);
  });

  test("【ADR-0072 限定1 / 限定4】深度上限の履歴は今日も `failure` である(本物の失敗を巻き込まない)", () => {
    // 深度上限で止まる連鎖を作る(下のテストと同じ2本)。
    withWorkflows(
      {
        id: "books-to-notifications",
        name: "books → notifications",
        trigger: { type: "on_create", table: "books" },
        actions: [{ action: "create_record", table: "notifications", values: { title: "n" } }],
        history_table: "wf-runs",
      },
      {
        id: "notifications-to-books",
        name: "notifications → books",
        trigger: { type: "on_create", table: "notifications" },
        actions: [{ action: "create_record", table: "books", values: { title: "b" } }],
        history_table: "wf-runs",
      },
    );

    expect(createRecord(db, manifest, "books", { title: "起点" }).ok).toBe(false);

    // **深度上限の停止は1行も `suppressed` にならない**(ADR-0072 限定1: 射程は再発火抑止だけ)。
    const rows = historyRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((row) => row.status === "suppressed")).toHaveLength(0);
    const depthFailures = rows.filter(
      (row) => row.status === "failure" && String(row.error).includes("深度上限"),
    );
    expect(depthFailures.length).toBeGreaterThan(0);
  });

  test("【ADR-0072 限定4】アクションの失敗は今日も `failure` である(抑止と混ぜない)", () => {
    // `strict` は必須列を持つので、値を与えない create_record は必ず失敗する。
    withWorkflows({
      id: "always-fails",
      name: "必ず失敗する",
      trigger: { type: "on_create", table: "books" },
      actions: [{ action: "create_record", table: "strict", values: {} }],
      history_table: "wf-runs",
    });

    expect(createRecord(db, manifest, "books", { title: "起点" }).ok).toBe(false);

    const rows = historyRows();
    expect(rows.filter((row) => row.status === "suppressed")).toHaveLength(0);
    expect(rows.filter((row) => row.status === "failure").length).toBeGreaterThan(0);
  });

  test("深度上限は今日も「失敗」である —— 一番外側の書込が巻き戻る", () => {
    // books → notifications → books … と互いを発火させ続ける2本。
    // 同じレコードは1度しか発火しないので、抑止ではなく**深度上限**で止まる。
    withWorkflows(
      {
        id: "books-to-notifications",
        name: "books → notifications",
        trigger: { type: "on_create", table: "books" },
        actions: [{ action: "create_record", table: "notifications", values: { title: "n" } }],
        history_table: "wf-runs",
      },
      {
        id: "notifications-to-books",
        name: "notifications → books",
        trigger: { type: "on_create", table: "notifications" },
        actions: [{ action: "create_record", table: "books", values: { title: "b" } }],
        history_table: "wf-runs",
      },
    );

    const result = createRecord(db, manifest, "books", { title: "起点" });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("失敗するはずの書込が成功しました。");
    }
    expect(String(result.errors[0]?.message)).toContain("深度上限");
    // 一番外側の書込ごと巻き戻る(限定16 のうち深度上限の側は1バイトも変わっていない)。
    expect(rowsOf("books")).toHaveLength(0);
    expect(rowsOf("notifications")).toHaveLength(0);
  });

  test("上限値を1つも変えていない(WORKFLOW_MAX_DEPTH = 20 の凍結)", () => {
    expect(WORKFLOW_MAX_DEPTH).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// V3-M13-T04: 巻き戻しても失敗の記録が消えない(ADR-0066 限定5。解き方は (B))
//
// `V3-M13-T02` が発火元ごと巻き戻す器を入れた結果、**`status="failure"` の履歴行も
// 一緒に消えた**(§7 の実測)。ADR-0066 限定5 は「失敗の記録は消えない」を**必須項目**
// (外せない)と定め、解き方を (A) 別接続 / (B) 巻き戻し後に改めて書く / (C) 責務を入口へ移す
// の3つに限定した。**本タスクは (B) を採る。**
//
// **残らない経路も同じ describe で固定する** —— 「全部残るようになった」と書かないため。
// ---------------------------------------------------------------------------

describe("V3-M13-T04: 巻き戻しても失敗の記録が残る(ADR-0066 限定5)", () => {
  /** 必ず失敗する1本(`strict.must` が required なので値なしの create は必ず落ちる)。 */
  function withFailingWorkflow(trigger: "on_create" | "on_update" = "on_create"): void {
    withWorkflows({
      id: "always-fails",
      name: "必ず失敗する",
      trigger: { type: trigger, table: "books" },
      actions: [{ action: "create_record", table: "strict", values: {} }],
      history_table: "wf-runs",
    });
  }

  test("器を持たない経路(MCP 単件相当)—— 書込が巻き戻っても失敗の履歴が1行残る", () => {
    withFailingWorkflow();

    const result = createRecord(db, manifest, "books", { title: "履歴は残る" });

    expect(result.ok).toBe(false);
    // 発火元の書込は1バイトも残らない(限定1 は1ミリも緩めていない)。
    expect(rowsOf("books")).toHaveLength(0);
    // **失敗の記録は残る**(憲法6)。**二重に書かれない**ので、ちょうど1行である。
    const rows = historyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failure");
    expect(rows[0]?.workflow).toBe("always-fails");
    expect(rows[0]?.trigger_type).toBe("on_create");
    // 何が失敗したかが読める(「失敗した」だけでは原因に辿り着けない)。
    expect(String(rows[0]?.error)).toContain("アクション1");
    expect(String(rows[0]?.error)).toContain("strict");
  });

  test("updateRecord —— 更新が巻き戻っても失敗の履歴が1行残る", () => {
    const book = addBook("元のタイトル");
    withFailingWorkflow("on_update");

    const result = updateRecord(db, manifest, "books", book._id, { memo: "更新した" });

    expect(result.ok).toBe(false);
    expect(rowsOf("books")[0]?.memo).toBeNull();
    const rows = historyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failure");
    expect(rows[0]?.trigger_type).toBe("on_update");
  });

  test("外側の deferred tx(HTTP / 受信 capability と同じ形)の内側でも失敗の履歴が残る", () => {
    withFailingWorkflow();

    // `src/server/app.ts:804` / `src/server/inbound-route.ts:124` と同じ形 ——
    // **どちらも `ok:false` を return する**(throw しない)ので、外側の tx は commit する。
    const tx = db.transaction(() => createRecord(db, manifest, "books", { title: "内側" }));
    const result = tx();

    expect(result.ok).toBe(false);
    expect(rowsOf("books")).toHaveLength(0);
    // 外側の tx が commit した後も、失敗の記録は残っている。
    expect(historyRows().map((row) => row.status)).toEqual(["failure"]);
  });

  test("深度上限で止まった連鎖でも、失敗の記録が残る(理由が読める)", () => {
    useChainDatabase();

    const result = createRecord(db, manifest, "t0", { title: "段0" });

    expect(result.ok).toBe(false);
    expect(rowsOf("t0")).toHaveLength(0);
    const rows = historyRows();
    // **1行以上残る。**書かれた行数は連鎖の形で決まるので「ちょうど N」では固定しない。
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.status === "failure")).toBe(true);
    expect(rows.some((row) => String(row.error).includes("深度上限"))).toBe(true);
  });

  test("再発火抑止の記録も、外側が別の理由で巻き戻ったときに残る", () => {
    const book = addBook("こころ");
    withWorkflows({
      id: "self-then-fails",
      name: "自己更新したうえで失敗する",
      trigger: { type: "on_update", table: "books" },
      actions: [
        {
          action: "update_record",
          table: "books",
          target: "$record._id",
          values: { memo: "自動更新" },
        },
        { action: "create_record", table: "strict", values: {} },
      ],
      history_table: "wf-runs",
    });

    const result = updateRecord(db, manifest, "books", book._id, { title: "改" });

    expect(result.ok).toBe(false);
    const rows = historyRows();
    // 【V4-M4-T02 / ADR-0072 による期待値の更新】**巻き戻っても消えないことは1バイトも
    // 緩めていない**(ADR-0066 限定5 = 必須。外せない)。変わったのは、残る行のうち
    // 抑止の1行の `status` が3値目になったことだけである。**行数も内訳も減っていない。**
    expect(rows.every((row) => row.status === "failure" || row.status === "suppressed")).toBe(true);
    // 抑止の記録(内側)と、アクション失敗の記録(外側)の両方が読める。
    expect(rows.some((row) => String(row.error).includes("再発火"))).toBe(true);
    expect(rows.some((row) => String(row.error).includes("strict"))).toBe(true);
    // **どちらがどちらかが `status` で読める**(これが ADR-0072 の目的 = D-V4-37)。
    expect(
      rows.filter((row) => row.status === "suppressed" && String(row.error).includes("再発火")),
    ).toHaveLength(1);
    expect(
      rows.filter((row) => row.status === "failure" && String(row.error).includes("strict")),
    ).toHaveLength(1);
  });

  test("成功した実行の履歴は書き直さない —— 巻き戻った成功は残らない", () => {
    withWorkflows(
      {
        id: "book-writes-notification-then-fails",
        name: "通知を書いたあとに失敗する",
        trigger: { type: "on_create", table: "books" },
        actions: [
          { action: "create_record", table: "notifications", values: { title: "内側は成功" } },
          { action: "create_record", table: "strict", values: {} },
        ],
        history_table: "wf-runs",
      },
      {
        id: "notification-succeeds",
        name: "通知の on_create は成功する",
        trigger: { type: "on_create", table: "notifications" },
        actions: [{ action: "create_record", table: "notifications", values: { title: "孫" } }],
        history_table: "wf-runs",
      },
    );

    expect(createRecord(db, manifest, "books", { title: "起点" }).ok).toBe(false);

    // 巻き戻ったので notifications の行は1つも無い。
    expect(rowsOf("notifications")).toHaveLength(0);
    // **書き直すのは失敗の記録だけである** —— 成功した実行の履歴を復活させると、
    // 「成功した」と書かれた行だけが残って、その成果物がどこにも無い状態になる。
    const rows = historyRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.status === "failure")).toBe(true);
  });

  test("書き直した履歴の ran_at は、元の実行の時刻のままである(書き直した時刻ではない)", () => {
    let tick = 0;
    const clock: Clock = {
      now: () => {
        tick += 1;
        return new Date(`2026-08-01T00:00:0${tick}.000Z`);
      },
    };
    setWorkflowClock(clock);
    withFailingWorkflow();

    expect(createRecord(db, manifest, "books", { title: "時刻" }).ok).toBe(false);

    // 時刻源は1回しか読まれていない(書き直しは同じ行をそのまま書く)。
    expect(historyRows().map((row) => row.ran_at)).toEqual(["2026-08-01T00:00:01.000Z"]);
    expect(tick).toBe(1);
  });

  test("完了条件5: 書き直した履歴行も通常テーブルの行であり、delete_record で消せる", () => {
    withFailingWorkflow();
    expect(createRecord(db, manifest, "books", { title: "消せる" }).ok).toBe(false);
    const row = historyRows()[0];
    if (row === undefined) {
      throw new Error("履歴が残っていません。");
    }

    expect(deleteRecord(db, manifest, "wf-runs", row._id, row._updated_at).ok).toBe(true);

    // **`app.sqlite` のユーザランド通常テーブルのままである**(ADR-0013 の前提を1バイトも
    // 変えていない)。したがって消せることも1バイトも変わっていない。
    expect(historyRows()).toHaveLength(0);
  });

  test("【残らない経路】バッチは、バッチ全体の巻き戻しで失敗の履歴も消える", () => {
    withFailingWorkflow();

    const result = writeRecords(db, manifest, [
      { op: "create", table: "books", values: { title: "失敗する側" } },
    ]);

    expect(result.ok).toBe(false);
    // **書き直しはバッチの tx の内側で起きるので、バッチ全体の巻き戻しで一緒に消える。**
    // 解くには履歴を別接続で書くしかないが、それは実測で成立しない(記録 §3-2)。
    // **「全部残るようになった」とは書けない。**
    expect(historyRows()).toHaveLength(0);
  });
});
