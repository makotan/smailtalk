/**
 * ベンチマーク用のアプリを決定的に組み立てる(V1-M1-T05)。
 *
 * ## 方針
 *
 * - **カーネルの本物の経路でアプリを作る**(`createApp` → `applyDiff`)。
 *   スキーマを手で書くと、実運用の DB と列型やシステム列がずれる。
 * - **行の投入だけは直接 SQL で行う。** `createRecord` は 1 行ごとに
 *   `crypto.randomUUID()` を呼ぶため**内容が再現しない**。ID を決定的に振るために
 *   `INSERT` を直接撃つ。列型・列名はカーネルが作ったものをそのまま使うので、
 *   出来上がる DB はカーネル経由で作ったものと同じ形である。
 * - 乱数は `Rng`(固定シード)。**同じシード・同じ行数なら同じ DB ができる。**
 *
 * ## テーブルの形
 *
 * 1テーブルあたり 5 フィールド:
 * `title`(text) / `memo`(long_text) / `qty`(**number** = NUMERIC) /
 * `status`(select) / `due`(date)。
 *
 * `qty` が **number** であることが重要である。層2(テーブル再構築)の測定は
 * `qty` を `number` → `text` に変える(NUMERIC → TEXT なので `conversionLayer` が 2)。
 */
import { Database } from "bun:sqlite";
import { applyDiff, createApp, KernelMetaStore } from "../../src/kernel/index.ts";
import { appDbPath } from "../../src/kernel/storage-paths.ts";
import { Rng } from "./rng.ts";

/** 生成するテーブル1つあたりのフィールド定義(マニフェスト上の形)。 */
function fieldsOf(): unknown[] {
  return [
    { id: "title", name: "表題", type: "text", required: true },
    { id: "memo", name: "覚書", type: "long_text" },
    { id: "qty", name: "数量", type: "number" },
    { id: "status", name: "状態", type: "select", options: ["未着手", "進行中", "完了"] },
    { id: "due", name: "期限", type: "date" },
  ];
}

/** ベンチ用アプリの identity。 */
export type BenchApp = {
  app_id: string;
  table_ids: string[];
  rows_per_table: number;
  db_path: string;
  db_bytes: number;
};

export type BuildAppOptions = {
  dataRoot: string;
  appId: string;
  /** 作るユーザテーブルの数。 */
  tables: number;
  /** 1テーブルあたりの行数。 */
  rowsPerTable: number;
  /** 乱数シード。**同じ値なら同じ DB ができる。** */
  seed: number;
};

const STATUSES = ["未着手", "進行中", "完了"] as const;

/**
 * アプリを1つ作り、テーブルと行を投入する。
 *
 * `dataRoot` 配下に `apps/<appId>/` ができる。呼び出し側が後始末する。
 */
export function buildApp(options: BuildAppOptions): BenchApp {
  const { dataRoot, appId, tables, rowsPerTable, seed } = options;
  if (tables < 1) {
    throw new Error("tables は1以上である必要があります");
  }

  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, `bench ${appId}`, { app_id: appId });
  } finally {
    store.close();
  }

  const tableIds = Array.from({ length: tables }, (_, i) => `t${i + 1}`);
  const operations: unknown[] = [];
  for (const tableId of tableIds) {
    operations.push({
      op: "add_table",
      table: { id: tableId, name: `テーブル${tableId}`, fields: fieldsOf() },
    });
    operations.push({
      op: "add_view",
      view: {
        id: `${tableId}-list`,
        type: "list_view",
        table: tableId,
        columns: ["title", "qty", "status"],
      },
    });
  }
  const applied = applyDiff(dataRoot, appId, {
    diff_id: "bench-setup",
    intent: "ベンチマーク用のテーブルを用意する",
    operations,
  });
  if (!applied.valid) {
    throw new Error(`ベンチ用アプリの構築に失敗しました: ${JSON.stringify(applied.errors)}`);
  }

  seedRows(dataRoot, appId, tableIds, rowsPerTable, seed);

  const dbPath = appDbPath(dataRoot, appId);
  return {
    app_id: appId,
    table_ids: tableIds,
    rows_per_table: rowsPerTable,
    db_path: dbPath,
    db_bytes: Bun.file(dbPath).size,
  };
}

/**
 * 行を決定的に投入する。
 *
 * **`qty` には必ず整数を入れる。** ここに小数や非数を混ぜると `number` → `text` の
 * 変換で「変換不能」が出て、測っているものが「再構築の時間」から
 * 「拒否までの時間」に変わってしまう(測定対象がすり替わる)。
 */
function seedRows(
  dataRoot: string,
  appId: string,
  tableIds: readonly string[],
  rows: number,
  seed: number,
): void {
  if (rows <= 0) {
    return;
  }
  const db = new Database(appDbPath(dataRoot, appId), { readwrite: true, create: false });
  try {
    for (const [tableIndex, tableId] of tableIds.entries()) {
      const rng = new Rng(seed + tableIndex * 7919);
      const insert = db.query(
        `INSERT INTO "${tableId}" ` +
          `("_id", "_created_at", "_updated_at", "title", "memo", "qty", "status", "due") ` +
          `VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      db.transaction(() => {
        for (let i = 0; i < rows; i++) {
          const stamp = `2026-01-01T00:00:00.000Z`;
          insert.run(
            `${tableId}-${String(i).padStart(9, "0")}`,
            stamp,
            stamp,
            `件名 ${rng.int(1_000_000)}`,
            `本文 ${"あ".repeat(rng.int(40))} ${rng.int(1_000_000)}`,
            rng.int(100_000),
            rng.pick(STATUSES),
            `2026-${String(1 + rng.int(12)).padStart(2, "0")}-${String(1 + rng.int(28)).padStart(2, "0")}`,
          );
        }
      })();
    }
  } finally {
    db.close();
  }
}

/** 層2(NUMERIC → TEXT)を起こす差分。`qty` を number → text に変える。 */
export function layer2Diff(diffId: string, tableId: string): unknown {
  return {
    diff_id: diffId,
    intent: "数量を自由記述にしたいという要望",
    operations: [{ op: "change_field", table: tableId, field: "qty", changes: { type: "text" } }],
  };
}

/** 層1(列型が変わらない)を起こす差分。比較対照として使う。 */
export function layer1Diff(diffId: string, tableId: string): unknown {
  return {
    diff_id: diffId,
    intent: "覚書の表示名を変えたいという要望",
    operations: [{ op: "change_field", table: tableId, field: "memo", changes: { name: "メモ" } }],
  };
}

// ---------------------------------------------------------------------------
// 集計表(report_view)の台(V8-M10-T07。台帳 `Q-G34`)
// ---------------------------------------------------------------------------

/**
 * **集計表の性能を測るための台**(`V8-M10-T07`。`v8-m10.md` §1-0c の決定9 =
 * 「測定は `scripts/bench/` のシナリオとして書く」)。
 *
 * ## 何を作るか(**表10本 / 画面7枚 / 役割2つ**)
 *
 * | 表 | 行数 | 何のための表か |
 * |---|---:|---|
 * | `plain` | N | **単表・結合なし。** **`st_owner` を持たない** = 無条件の役割から見ると母集団は `unfiltered` |
 * | `owned` | N | **`st_owner` を持つ** = 母集団は `owner_scoped`(行ごとの post-filter が必ず走る) |
 * | `parent` | N | 結合の相手(親側) |
 * | `child` | N | 結合の相手(子側。`parent` への `reference` を持つ) |
 * | `r1`〜`r4` | N × 4 | **5表結合の相手**(`hub` から順方向に4本) |
 * | `hub` | N | **5表結合の起点**(`r1`〜`r4` への `reference` を4本持つ) |
 * | `over` | **N + 1** | **読む行の上限(10,000)を1行だけ超える台**(N = 10,000 のとき) |
 *
 * **全表に `tag`(select `A` / `B`)を置き、投入する行はすべて `tag = "A"` である。**
 * **これは「条件つき読取(`when: {field: "tag", equals: "A"}`)でも1行も落ちない」を
 * 作るためである** —— **母集団の**中身**を同じに保ったまま、`unfiltered` と
 * `role_conditional` の**経路だけ**を差し替えて比べられる。**
 * **`amount` はすべて `1`** —— **`T05` が測った応答(1,580,121 バイト)と同じ形にするため。**
 *
 * ## 行IDを決定的にしている(**応答のバイト数を再現させるため**)
 *
 * `createRecord` は1行ごとに `crypto.randomUUID()` を呼ぶので**内容が再現しない**。
 * ここは `fixture.ts` の既存の作法どおり `INSERT` を直接撃ち、**UUID とちょうど同じ36文字**の
 * 行IDを決定的に振る({@link benchRowId})。**長さが同じなので、`group_by: _id` の応答の
 * バイト数は `createRecord` で作った台と1バイトも変わらない。**
 *
 * ## 【この関数が測っていないもの】
 *
 * - **行アクセス権(点の付与。分岐3)の台を1つも作っていない。** `T05` の
 *   `report-limit-boundary.test.ts` が持っており、**あちらの台と二重に持たない。**
 * - **匿名公開(分岐1)の台も無い** —— **集計表の口は未ログインを 401 で閉じている**
 *   (`D-V8-127`)ので、原理的に測れない。
 */
export type ReportBenchApp = {
  app_id: string;
  /** 1表あたりの行数(`over` だけ +1)。 */
  rows_per_table: number;
  /** 作った表のID(宣言順)。 */
  table_ids: string[];
  /** 作った画面のID(宣言順)。 */
  view_ids: string[];
  db_path: string;
  db_bytes: number;
};

export type BuildReportAppOptions = {
  dataRoot: string;
  appId: string;
  /** 1表あたりの行数。`over` はこれに +1 した行数になる。 */
  rowsPerTable: number;
  /**
   * **`createApp` の直後・スキーマ適用の前**に呼ばれる。
   *
   * **`seedSession` は `app.sqlite` が既に在ることを前提にする**ので、ここで済ませる。
   * **返した識別子が `owned.st_owner` に入る**(= その人から見て全行が持ち主一致になる)。
   */
  afterCreate: () => string;
};

/** 5表結合の相手(`hub` から順方向に辿る4本)。 */
const REPORT_JOIN_TABLES = ["r1", "r2", "r3", "r4"] as const;

/** 集計表の台に共通のフィールド。**`tag` はどの表にも必ず在る**(条件つき読取の的)。 */
function reportFieldsOf(extra: readonly unknown[] = []): unknown[] {
  return [
    { id: "title", name: "表題", type: "text", required: true },
    { id: "amount", name: "数量", type: "number" },
    { id: "tag", name: "区分", type: "select", options: ["A", "B"] },
    ...extra,
  ];
}

/** 集計表の台の表(宣言順。参照先が先に来る)。 */
function reportTables(): unknown[] {
  return [
    { id: "plain", name: "単表", fields: reportFieldsOf() },
    {
      id: "owned",
      name: "持ち主つきの表",
      fields: reportFieldsOf([{ id: "st_owner", name: "持ち主", type: "text" }]),
    },
    { id: "parent", name: "親", fields: reportFieldsOf() },
    {
      id: "child",
      name: "子",
      fields: reportFieldsOf([
        { id: "parent", name: "親", type: "reference", reference_table: "parent" },
      ]),
    },
    ...REPORT_JOIN_TABLES.map((id, index) => ({
      id,
      name: `結合先${index + 1}`,
      fields: reportFieldsOf(),
    })),
    {
      id: "hub",
      name: "5表結合の起点",
      fields: reportFieldsOf(
        REPORT_JOIN_TABLES.map((table, index) => ({
          id: `ref${index + 1}`,
          name: `参照${index + 1}`,
          type: "reference",
          reference_table: table,
        })),
      ),
    },
    { id: "over", name: "上限を1行だけ超える表", fields: reportFieldsOf() },
  ];
}

/** 集計表の台の画面(宣言順)。 */
function reportViews(): unknown[] {
  const aggregates = [{ type: "sum", field: "amount" }, { type: "count" }];
  return [
    {
      id: "v_plain_tag",
      type: "report_view",
      table: "plain",
      name: "単表(区分ごと)",
      report: { group_by: [{ field: "tag" }], aggregates },
    },
    {
      id: "v_plain_ids",
      type: "report_view",
      table: "plain",
      name: "単表(行ごと = 群が行数と同じ)",
      report: { group_by: [{ field: "_id" }], aggregates },
    },
    {
      id: "v_owned_tag",
      type: "report_view",
      table: "owned",
      name: "持ち主つき(区分ごと)",
      report: { group_by: [{ field: "tag" }], aggregates },
    },
    {
      id: "v_fwd",
      type: "report_view",
      table: "child",
      name: "順方向の結合(子 → 親)",
      report: {
        join: [{ table: "child", via: "parent" }],
        group_by: [{ field: "tag" }],
        aggregates: [
          { type: "sum", field: "amount" },
          { type: "sum", table: "parent", field: "amount" },
          { type: "count" },
        ],
      },
    },
    {
      id: "v_rev",
      type: "report_view",
      table: "parent",
      name: "逆方向の結合(親 → 子)",
      report: {
        join: [{ table: "child", via: "parent" }],
        group_by: [{ field: "tag" }],
        aggregates: [
          { type: "sum", field: "amount" },
          { type: "sum", table: "child", field: "amount" },
          { type: "count" },
        ],
      },
    },
    {
      id: "v_five",
      type: "report_view",
      table: "hub",
      name: "5表(順方向4本)",
      report: {
        join: REPORT_JOIN_TABLES.map((_, index) => ({ table: "hub", via: `ref${index + 1}` })),
        group_by: [{ field: "tag" }],
        aggregates: [
          { type: "sum", field: "amount" },
          { type: "sum", table: "r1", field: "amount" },
          { type: "count" },
        ],
      },
    },
    {
      id: "v_over",
      type: "report_view",
      table: "over",
      name: "上限を1行だけ超える表",
      report: { group_by: [{ field: "tag" }], aggregates },
    },
  ];
}

/**
 * 集計表の台の役割。
 *
 * - **`owner`**: **条件を1つも持たない**表の読取 —— **母集団は `unfiltered`**
 *   (`st_owner` を持つ `owned` だけは `owner_scoped` に落ちる)。
 * - **`editor`**: **すべての表に `when: {field: "tag", equals: "A"}` を掛けた読取**
 *   —— **母集団は `role_conditional`**(行ごとに `judgeRoleAccess` が走る)。
 *   **投入した行はすべて `tag = "A"` なので、見える行は `owner` と同じ全行である。**
 */
function reportRoles(): unknown[] {
  const viewRules = reportViews().map((view) => ({
    target: "view",
    view: (view as { id: string }).id,
    can: ["read"],
  }));
  const tableIds = reportTables().map((table) => (table as { id: string }).id);
  return [
    {
      id: "owner",
      name: "持ち主",
      rules: [
        { target: "app", can: ["write"] },
        { target: "role", can: ["write"] },
        ...tableIds.map((table) => ({ target: "table", table, can: ["read", "write", "delete"] })),
        ...viewRules,
      ],
    },
    {
      id: "editor",
      name: "係",
      rules: [
        ...tableIds.map((table) => ({
          target: "table",
          table,
          can: ["read"],
          when: { field: "tag", equals: "A" },
        })),
        ...viewRules,
      ],
    },
    // **既定の3役割は消せない**(`set_roles` は宣言を丸ごと差し替えるため)。
    // **`viewer` はこのベンチでは1度も使わない** —— 表の読取規則を1本も持たない。
    { id: "viewer", name: "閲覧", rules: viewRules },
  ];
}

/** 投入する行の時刻(固定)。 */
const REPORT_STAMP = "2026-01-01T00:00:00.000Z";

/**
 * **UUID とちょうど同じ36文字**の決定的な行ID。
 *
 * **長さを合わせているのは応答のバイト数を再現させるためである** ——
 * `group_by: [{field: "_id"}]` の応答は行IDを群のキーとして載せるので、
 * **1文字でも長さが違うと `T05` が測った 1,580,121 バイトと突き合わせられない。**
 */
export function benchRowId(table: string, index: number): string {
  const head = `${table}00000000`.slice(0, 8);
  return `${head}-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

/** 1表ぶんの行を直接 SQL で投入する。 */
function insertReportRows(
  db: Database,
  table: string,
  count: number,
  columns: readonly string[],
  valuesOf: (index: number) => (string | number)[],
): void {
  const placeholders = columns.map(() => "?").join(", ");
  const names = columns.map((column) => `"${column}"`).join(", ");
  const insert = db.query(
    `INSERT INTO "${table}" ("_id", "_created_at", "_updated_at", ${names}) ` +
      `VALUES (?, ?, ?, ${placeholders})`,
  );
  for (let index = 0; index < count; index++) {
    insert.run(benchRowId(table, index), REPORT_STAMP, REPORT_STAMP, ...valuesOf(index));
  }
}

/** 集計表の台に行を投入する。**1回のトランザクションで入れる。** */
function seedReportRows(dataRoot: string, appId: string, rows: number, ownerId: string): void {
  const db = new Database(appDbPath(dataRoot, appId), { readwrite: true, create: false });
  try {
    db.exec("BEGIN");
    const base = ["title", "amount", "tag"] as const;
    insertReportRows(db, "plain", rows, base, (i) => [`行${i}`, 1, "A"]);
    insertReportRows(db, "owned", rows, [...base, "st_owner"], (i) => [`行${i}`, 1, "A", ownerId]);
    insertReportRows(db, "parent", rows, base, (i) => [`親${i}`, 1, "A"]);
    insertReportRows(db, "child", rows, [...base, "parent"], (i) => [
      `子${i}`,
      1,
      "A",
      benchRowId("parent", i),
    ]);
    for (const table of REPORT_JOIN_TABLES) {
      insertReportRows(db, table, rows, base, (i) => [`結${i}`, 1, "A"]);
    }
    insertReportRows(db, "hub", rows, [...base, "ref1", "ref2", "ref3", "ref4"], (i) => [
      `元${i}`,
      1,
      "A",
      ...REPORT_JOIN_TABLES.map((table) => benchRowId(table, i)),
    ]);
    // **1行だけ多い** —— **N = 10,000 のとき、読む行の上限をちょうど1行超える。**
    insertReportRows(db, "over", rows + 1, base, (i) => [`超${i}`, 1, "A"]);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

/** 集計表の台を1つ作る。**呼び出し側が `dataRoot` を後始末する。** */
export function buildReportApp(options: BuildReportAppOptions): ReportBenchApp {
  const { dataRoot, appId, rowsPerTable, afterCreate } = options;

  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, `集計表ベンチ ${appId}`, { app_id: appId });
  } finally {
    store.close();
  }

  const ownerId = afterCreate();

  const tables = reportTables();
  const views = reportViews();
  const operations: unknown[] = [
    ...tables.map((table) => ({ op: "add_table", table })),
    ...views.map((view) => ({ op: "add_view", view })),
    { op: "set_roles", roles: reportRoles() },
  ];
  const applied = applyDiff(dataRoot, appId, {
    diff_id: "report-bench-setup",
    intent: "集計表の性能を測るための表と画面を用意する",
    operations,
  });
  if (!applied.valid) {
    throw new Error(`集計表ベンチの台の構築に失敗しました: ${JSON.stringify(applied.errors)}`);
  }

  seedReportRows(dataRoot, appId, rowsPerTable, ownerId);

  const dbPath = appDbPath(dataRoot, appId);
  return {
    app_id: appId,
    rows_per_table: rowsPerTable,
    table_ids: tables.map((table) => (table as { id: string }).id),
    view_ids: views.map((view) => (view as { id: string }).id),
    db_path: dbPath,
    db_bytes: Bun.file(dbPath).size,
  };
}
