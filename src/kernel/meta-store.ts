/**
 * カーネルメタストア(V0-P2-T02)。
 *
 * アプリ台帳と changelog を `<dataRoot>/kernel.sqlite` に永続化する(ADR-0002)。
 * ユーザデータ(`data/apps/<app_id>/app.sqlite`)とは別ファイルにしてあるため、
 * アプリのディレクトリを丸ごとコピー/削除しても台帳側は壊れない。
 *
 * 方針:
 * - SQLite ドライバは Bun 組み込みの `bun:sqlite`(外部依存を足さない)
 * - 日時は ISO8601 UTC 文字列(`2026-07-18T06:00:00.000Z`)で TEXT 保存する。
 *   文字列のまま辞書順比較で時系列順になるため、SQLite に日時型がなくても困らない
 * - SQL の識別子は常にダブルクォートで囲み、値は必ずプレースホルダでバインドする
 * - エラー方針: ここで検出するのは呼び出し側のプログラミングエラー(不正な app_id、
 *   重複登録、存在しないアプリへの追記)と I/O エラーであり、LLMが自己修正する
 *   対象ではない。したがって `ValidationResult` ではなく例外で失敗させる。
 *   `ValidationResult` はマニフェスト/差分パッチの検証(Phase 1)専用に保つ。
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { RUNNER_BUILD_VERSION } from "../shared/runner-build-version.ts";
import { quoteIdentifier } from "./ddl.ts";
import { isValidResourceId } from "./resource-id.ts";
import { kernelDbPath } from "./storage-paths.ts";
import type { Operation } from "./types.ts";

/**
 * アプリの状態。
 * v0 で実際に発行されるのは `active` のみ。アプリの完全削除はディレクトリ削除で
 * 行う(ADR-0002)ため `deleted` は持たない。`archived` は「実体は残すが一覧の
 * 主線から外す」将来の運用のために値域だけ確保してある。
 */
export const APP_STATUSES = ["active", "archived"] as const;
export type AppStatus = (typeof APP_STATUSES)[number];

/** アプリ台帳の1行。 */
export type AppRecord = {
  app_id: string;
  name: string;
  /** ISO8601 UTC 文字列。 */
  created_at: string;
  status: AppStatus;
};

/**
 * アプリごとのコメント表示設定(ADR-0377 = `CM-G36`)。
 *
 * **書く側と読む側は別々である。1つに畳まない**(`D-V10-36`)。
 * **`AppRecord` には足していない**(限定4 の隣にある約束 —— `toAppRecord` / `listApps` /
 * `getApp` / `registerApp` は1バイトも変わらない)。**`_apps` 投影にも出ない**(限定2)。
 */
export type CommentVisibility = {
  /** 利用者がこのアプリにコメントを書けるか。 */
  write: boolean;
  /** 書かれたコメントが読めるか。 */
  read: boolean;
};

/** アプリ登録の入力。`created_at` / `status` は省略時に既定値が入る。 */
export type RegisterAppInput = {
  app_id: string;
  name: string;
  created_at?: string;
  status?: AppStatus;
};

/**
 * changelog エントリの種別(ADR-0004 §3 / ADR-0032)。
 * `apply` は差分の適用、`undo` はその取り消し、`redo` は直前の undo のやり直し。
 * undo 自体は undo の対象にならず、redo 自体も undo / redo の対象にならない(ADR-0032 §3)。
 */
export const CHANGELOG_KINDS = ["apply", "undo", "redo"] as const;
export type ChangelogKind = (typeof CHANGELOG_KINDS)[number];

/** changelog の1行(handover.md 3.5 / ADR-0004 §3)。 */
export type ChangelogEntry = {
  /** 適用順を一意に定める自動採番。同一ミリ秒の追記でも順序が壊れない。 */
  seq: number;
  app_id: string;
  diff_id: string;
  /** なぜこの変更をするのか(会話の要約)。 */
  intent: string;
  operations: Operation[];
  /** ISO8601 UTC 文字列。 */
  applied_at: string;
  /** apply 前スナップショットのディレクトリ名(`<連番>-<diff_id>`)。未取得なら null。 */
  snapshot: string | null;
  /** 差分適用(`apply`)か取り消し(`undo`)か。 */
  kind: ChangelogKind;
  /**
   * `kind: "undo"` のとき取り消した apply エントリの `seq`。
   * `kind: "redo"` のときはやり直した undo エントリの `seq`(ADR-0032 §3。列を増やさず転用する)。
   * `kind: "apply"` では常に null。
   */
  undo_target_seq: number | null;
};

/**
 * changelog 追記の入力。`applied_at` / `snapshot` / `kind` / `undo_target_seq` は省略可。
 * 省略時は `kind: "apply"` / `undo_target_seq: null` になる(既存の呼び出し側を壊さないため)。
 */
export type AppendChangelogInput = {
  app_id: string;
  diff_id: string;
  intent: string;
  operations: Operation[];
  applied_at?: string;
  snapshot?: string | null;
  kind?: ChangelogKind;
  undo_target_seq?: number | null;
};

type AppRow = { app_id: string; name: string; created_at: string; status: string };
/** `apps` の設定2列だけを引いた行。SQLite に真偽型が無いので 0/1 で返る。 */
type CommentVisibilityRow = { comment_write_enabled: number; comment_read_enabled: number };
type ChangelogRow = {
  seq: number;
  app_id: string;
  diff_id: string;
  intent: string;
  operations: string;
  applied_at: string;
  snapshot: string | null;
  kind: string;
  undo_target_seq: number | null;
};

/**
 * 後から足した列の1本分。`CREATE TABLE` と `ALTER TABLE ADD COLUMN` の両方が同じ
 * 綴りを引くための最小の形である(表ごとに1つずつ配列を持つ)。
 */
type AddedColumn = { name: string; type: string; default: string };

/**
 * ADR-0004 で `changelog` に足した列。列名と DDL の対応をここ1箇所に持ち、
 * 新規DB(`CREATE TABLE`)と既存DB(`ALTER TABLE ADD COLUMN`)の両方から参照する。
 * 汎用のマイグレーションフレームワークは作らない(憲法1「カーネルは退屈なコードで」)。
 */
const CHANGELOG_ADDED_COLUMNS: readonly AddedColumn[] = [
  // 既存行は「差分の適用」として読めればよいので DEFAULT 'apply' で埋まる。
  { name: "kind", type: "TEXT NOT NULL", default: "'apply'" },
  { name: "undo_target_seq", type: "INTEGER", default: "NULL" },
];

/**
 * ADR-0377(`CM-G36`)で `apps` に足した列。**2本ちょうどである**(限定1)。
 *
 * **1本の列に畳んでいない** —— `D-V10-36` が「切り替えは書く側と読む側の2つであり、
 * 1つに畳まない」と述べているためである。SQLite に真偽型は無いので INTEGER の 0/1 に
 * 写す(`kernel.sqlite` の他の列と同じ扱い)。
 *
 * **既定は 0 = OFF**(`D-V10-40` / 限定7)。既に在るアプリは `ALTER TABLE` の DEFAULT で
 * 0 に埋まるので、**列を足した直後は全アプリが OFF から始まる。**
 * **帰結を隠さない**: 既定 OFF により、既存アプリから書く欄が一度消える。
 *
 * **`_apps` 投影には出さない**(限定2。`src/shared/system-tables.ts` は1バイトも触っていない)。
 * したがってこの2列はアプリの側からは1バイトも見えず、`changelog` にも1行も残らない
 * —— `undo` / `redo` で戻らないのは `apps` 表の列を選んだことの代償である(ADR-0377 §限界2)。
 */
const APPS_ADDED_COLUMNS: readonly AddedColumn[] = [
  { name: "comment_write_enabled", type: "INTEGER NOT NULL", default: "0" },
  { name: "comment_read_enabled", type: "INTEGER NOT NULL", default: "0" },
];

/** 追加列の列定義(`"kind" TEXT NOT NULL DEFAULT 'apply'`)。識別子は必ず検証して引用する。 */
function addedColumnDefinition(column: AddedColumn): string {
  return `${quoteIdentifier(column.name)} ${column.type} DEFAULT ${column.default}`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS "apps" (
  "app_id"     TEXT PRIMARY KEY,
  "name"       TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "status"     TEXT NOT NULL,
  "ledger_seq" INTEGER NOT NULL${APPS_ADDED_COLUMNS.map((c) => `,\n  ${addedColumnDefinition(c)}`).join("")}
);

CREATE TABLE IF NOT EXISTS "changelog" (
  "seq"        INTEGER PRIMARY KEY AUTOINCREMENT,
  "app_id"     TEXT NOT NULL REFERENCES "apps"("app_id"),
  "diff_id"    TEXT NOT NULL,
  "intent"     TEXT NOT NULL,
  "operations" TEXT NOT NULL,
  "applied_at" TEXT NOT NULL,
  "snapshot"   TEXT,
  ${CHANGELOG_ADDED_COLUMNS.map((c) => `${addedColumnDefinition(c)},`).join("\n  ")}
  UNIQUE ("app_id", "diff_id")
);

CREATE INDEX IF NOT EXISTS "changelog_app_id_seq" ON "changelog" ("app_id", "seq");
`;

/**
 * 既存の `changelog` テーブルに不足している列を足す(冪等)。
 *
 * `CREATE TABLE IF NOT EXISTS` は既にテーブルがあると何もしないため、
 * ADR-0004 以前に作られた `kernel.sqlite` には `kind` / `undo_target_seq` が無い。
 * `PRAGMA table_info` で実際の列を見てから足りない分だけ `ALTER TABLE ADD COLUMN` する。
 * 何回開いても結果が変わらない(2回目以降は列が揃っているので1文も発行しない)。
 * 既存行は列定義の DEFAULT(`kind = 'apply'` / `undo_target_seq = NULL`)で埋まる。
 */
function migrateChangelogColumns(db: Database): void {
  const existing = new Set(
    db
      .query<{ name: string }, []>(`PRAGMA table_info("changelog")`)
      .all()
      .map((row) => row.name),
  );
  for (const column of CHANGELOG_ADDED_COLUMNS) {
    if (!existing.has(column.name)) {
      db.exec(`ALTER TABLE "changelog" ADD COLUMN ${addedColumnDefinition(column)}`);
    }
  }
}

/**
 * 既存の `apps` テーブルに不足している列を足す(冪等。ADR-0377 限定3)。
 *
 * `migrateChangelogColumns` と**同じ形**である —— `CREATE TABLE IF NOT EXISTS` は既に
 * テーブルがあると何もしないので、ADR-0377 以前に作られた `kernel.sqlite` には
 * `comment_write_enabled` / `comment_read_enabled` が無い。`PRAGMA table_info` で
 * 実際の列を見てから足りない分だけ `ALTER TABLE ADD COLUMN` する。
 * 何回開いても結果が変わらない(2回目以降は列が揃っているので1文も発行しない)。
 *
 * **表を作り直していない**ので、既存行は1件も落ちない。既存行の値は列定義の
 * DEFAULT(= `0` = OFF)で埋まる(`D-V10-40`)。
 *
 * **足す向きしか持たない**(ADR-0377 §限界4) —— 列を外す口はここに無い。
 */
function migrateAppsColumns(db: Database): void {
  const existing = new Set(
    db
      .query<{ name: string }, []>(`PRAGMA table_info("apps")`)
      .all()
      .map((row) => row.name),
  );
  for (const column of APPS_ADDED_COLUMNS) {
    if (!existing.has(column.name)) {
      db.exec(`ALTER TABLE "apps" ADD COLUMN ${addedColumnDefinition(column)}`);
    }
  }
}

/** ISO8601 UTC(ミリ秒つき)の現在時刻。 */
function nowIso(): string {
  return new Date().toISOString();
}

function toAppRecord(row: AppRow): AppRecord {
  return {
    app_id: row.app_id,
    name: row.name,
    created_at: row.created_at,
    status: row.status as AppStatus,
  };
}

/** 0/1 の実列を真偽に写す。**0 以外を true とする**(手でDBを書き換えた値も素直に読む)。 */
function toCommentVisibility(row: CommentVisibilityRow): CommentVisibility {
  return {
    write: row.comment_write_enabled !== 0,
    read: row.comment_read_enabled !== 0,
  };
}

function toChangelogEntry(row: ChangelogRow): ChangelogEntry {
  return {
    seq: row.seq,
    app_id: row.app_id,
    diff_id: row.diff_id,
    intent: row.intent,
    operations: JSON.parse(row.operations) as Operation[],
    applied_at: row.applied_at,
    snapshot: row.snapshot,
    kind: toChangelogKind(row.kind),
    undo_target_seq: row.undo_target_seq,
  };
}

/**
 * DB に入っている `kind` 文字列を語彙に写す。
 * 値域外はカーネル外からDBを書き換えた場合にしか起きないので、黙って握り潰さず例外にする。
 */
function toChangelogKind(value: string): ChangelogKind {
  const kind = CHANGELOG_KINDS.find((candidate) => candidate === value);
  if (kind === undefined) {
    throw new Error(
      `changelog.kind に未知の値 "${value}" が入っています。許可される値: ${CHANGELOG_KINDS.join(" / ")}。`,
    );
  }
  return kind;
}

/**
 * カーネルのメタ情報ストア。
 *
 * データルートは必ず `open()` の引数で受け取る(環境変数・ハードコードに依存しない)。
 * テストは一時ディレクトリを渡すことでリポジトリの `data/` を汚さずに動かせる。
 */
export class KernelMetaStore {
  /** このストアが読み書きするデータルート。`create_app` 等がファイル配置に使う。 */
  readonly dataRoot: string;
  private readonly db: Database;

  private constructor(dataRoot: string, db: Database) {
    this.dataRoot = dataRoot;
    this.db = db;
  }

  /**
   * データルート配下の `kernel.sqlite` を開く(なければ作る)。
   * テーブルは毎回 `CREATE TABLE IF NOT EXISTS` で用意するため、既存DBに対しても安全。
   * ただし `IF NOT EXISTS` は既存テーブルへの列追加をしないので、後から足した列
   * (ADR-0004 の `kind` / `undo_target_seq`)は `migrateChangelogColumns` で補う。
   */
  static open(dataRoot: string): KernelMetaStore {
    mkdirSync(dataRoot, { recursive: true });
    const db = new Database(kernelDbPath(dataRoot), { create: true });
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    // **この呼び出しが `kernel.sqlite` を新しく作ったのか**を、SCHEMA を張る前に見る
    // (V5-M5-T04 / ADR-0251 限定7)。`CREATE TABLE IF NOT EXISTS` を通した後では
    // 新旧を区別できなくなる。
    const isNewDatabase =
      db
        .query<{ name: string }, []>(
          `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" = 'apps'`,
        )
        .get() === null;
    db.exec(SCHEMA);
    migrateChangelogColumns(db);
    // **`apps` 側の遅延 `ALTER` も同じ位置で打つ**(ADR-0377 限定3)。`isNewDatabase` の
    // 判定は既に上で終わっているので、**この呼び出しは新旧の区別に1バイトも影響しない。**
    migrateAppsColumns(db);
    // **新しく作ったときにだけ Runner のビルド単位の版を刻む**(ADR-0251 限定7 =
    // `app.sqlite` と同じ形を1つだけ)。**既に在る印の無い `kernel.sqlite` を開いても
    // 刻み直さない** —— 刻み直すと「印が無い DB を新しいものとみなす」ことになり、
    // **限定6 に正面から反する**(`runner-version-stamp.test.ts` が両側を固定)。
    //
    // **`migrateChangelogColumns`(遅延 `ALTER`)には1バイトも触っていない**(限定7)。
    // 遅延 `ALTER` と版の照合は今日**同居する。**
    if (isNewDatabase) {
      db.exec(`PRAGMA user_version = ${RUNNER_BUILD_VERSION};`);
    }
    return new KernelMetaStore(dataRoot, db);
  }

  /** DBを閉じる。以後の操作はエラーになる。 */
  close(): void {
    this.db.close();
  }

  /**
   * アプリを台帳に登録する。
   * @throws app_id が規約違反、または既に登録済みの場合
   */
  registerApp(input: RegisterAppInput): AppRecord {
    if (!isValidResourceId(input.app_id)) {
      throw new Error(
        `app_id "${input.app_id}" はリソースID規約(^[a-z][a-z0-9_-]*$、1〜64文字)に違反しています。`,
      );
    }
    if (input.name === "") {
      throw new Error("アプリ名が空です。1文字以上の名前を指定してください。");
    }
    if (this.hasApp(input.app_id)) {
      throw new Error(`app_id "${input.app_id}" は既に台帳に登録されています。`);
    }

    const record: AppRecord = {
      app_id: input.app_id,
      name: input.name,
      created_at: input.created_at ?? nowIso(),
      status: input.status ?? "active",
    };
    // ledger_seq は created_at が同一でも一覧の順序を安定させるための登録順。
    this.db
      .query(
        `INSERT INTO "apps" ("app_id", "name", "created_at", "status", "ledger_seq")
         VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX("ledger_seq"), 0) + 1 FROM "apps"))`,
      )
      .run(record.app_id, record.name, record.created_at, record.status);
    return record;
  }

  /** 台帳に登録済みかを判定する。 */
  hasApp(appId: string): boolean {
    return this.getApp(appId) !== undefined;
  }

  /** app_id でアプリを取得する。未登録なら undefined。 */
  getApp(appId: string): AppRecord | undefined {
    const row = this.db
      .query<AppRow, [string]>(
        `SELECT "app_id", "name", "created_at", "status" FROM "apps" WHERE "app_id" = ?`,
      )
      .get(appId);
    return row === null ? undefined : toAppRecord(row);
  }

  /** 全アプリを作成日時(同時刻なら登録順)の昇順で返す。 */
  listApps(): AppRecord[] {
    return this.db
      .query<AppRow, []>(
        `SELECT "app_id", "name", "created_at", "status" FROM "apps"
         ORDER BY "created_at" ASC, "ledger_seq" ASC`,
      )
      .all()
      .map(toAppRecord);
  }

  /**
   * アプリのコメント表示設定を読む(ADR-0377 = `CM-G36`)。未登録なら undefined。
   *
   * **`getApp` とは別の口である** —— `AppRecord` に足すと `_apps` 投影と型が連動し、
   * 限定2(`src/shared/system-tables.ts` を1バイトも触らない)を守れなくなる。
   */
  getCommentVisibility(appId: string): CommentVisibility | undefined {
    const row = this.db
      .query<CommentVisibilityRow, [string]>(
        `SELECT "comment_write_enabled", "comment_read_enabled" FROM "apps" WHERE "app_id" = ?`,
      )
      .get(appId);
    return row === null ? undefined : toCommentVisibility(row);
  }

  /**
   * アプリのコメント表示設定を倒す(ADR-0377 = `CM-G36`)。倒した後の値を返す。
   *
   * **片側だけを渡せる** —— `D-V10-36` が2つの切り替えを1つに畳むことを禁じているので、
   * 省いた側は今の値をそのまま残す(読んでから書く)。同じ `open()` の中で何度でも
   * 倒し直せる(`UPDATE` するだけで、列も表も動かない)。
   *
   * **`changelog` に1行も残らない。** `undo` / `redo` では戻らず、`dry_run_diff` にも
   * 1行も出ない(ADR-0377 §限界2)。`_auth_activity` にも1行も残らない(同 §限界3)。
   *
   * **【`V10-M30` の独立点検 B-5(2026-08-25)。上の行は1バイトも消していない】**
   * **返す値は `UPDATE` の後に DB から読み直したものである。** 直す前は `patch` から
   * 計算した値(`next`)をそのまま返しており、**実DBと割れても誰も気づけなかった。**
   * `ADR-0378` が**読む道具を2本目に足さないと決めた**ので、**この返り値が「今どうなって
   * いるか」を AI が知る唯一の手立てである** —— 計算値ではなく実物を返す。
   *
   * @throws 台帳に無い app_id を渡した場合(呼び出し側のプログラミングエラー)
   */
  setCommentVisibility(
    appId: string,
    patch: { write?: boolean; read?: boolean },
  ): CommentVisibility {
    const current = this.getCommentVisibility(appId);
    if (current === undefined) {
      throw new Error(`app_id "${appId}" は台帳に登録されていません。`);
    }
    const next: CommentVisibility = {
      write: patch.write ?? current.write,
      read: patch.read ?? current.read,
    };
    this.db
      .query<null, [number, number, string]>(
        `UPDATE "apps" SET "comment_write_enabled" = ?, "comment_read_enabled" = ?
         WHERE "app_id" = ?`,
      )
      .run(next.write ? 1 : 0, next.read ? 1 : 0, appId);
    // **書いた値ではなく、書いた後の実物を読み直して返す**(点検 B-5)。
    const stored = this.getCommentVisibility(appId);
    if (stored === undefined) {
      throw new Error(`app_id "${appId}" は台帳に登録されていません。`);
    }
    return stored;
  }

  /**
   * アプリを完全削除する(V1-M9-T09 / ADR-0031)。`kernel.sqlite` 側の後始末を**単一
   * トランザクション**でまとめて行う —— 当該 app_id の横断テーブル行(`scopedTables`)を
   * 消し、最後に `apps` 台帳行を消す。
   *
   * **順序**: `apps` を最後に消すのは、`changelog` が `apps("app_id")` を FK 参照して
   * いるためである(`SCHEMA` の `changelog.app_id REFERENCES apps.app_id`)。`foreign_keys`
   * は `open()` で ON にしてあるので、`apps` を先に消すと FK 制約に触れる。`scopedTables` の
   * 全要素は `apps` より先に消えるので、配列内の順序は FK に対して無関係である。
   *
   * **存在しないテーブルは飛ばす。** `scopedTables` には M4/M5 の横断テーブル
   * (ai_* / connections / …)が含まれるが、それらを一度も使っていないデータルートでは
   * `CREATE TABLE` がまだ走っておらず、`DELETE FROM` が "no such table" になる。`apps` /
   * `changelog` は本ストアが必ず用意する(`SCHEMA`)ので常に存在する。`sqlite_master` を
   * 見て実在するものだけを消す。
   *
   * **識別子は必ず検証済みのテーブル名だけを埋め込む。** `scopedTables` は呼び出し側
   * (`delete-app.ts` の `APP_SCOPED_KERNEL_TABLES` 定数)が持つ固定の集合であり、外部
   * 入力ではない。それでも SQL に文字列連結する以上、`quoteIdentifier` で引用する。
   *
   * @param appId 削除対象のアプリID。
   * @param scopedTables `apps` 以外で当該 app_id 行を消すテーブル名の集合(単一ソース)。
   */
  deleteApp(appId: string, scopedTables: readonly string[]): void {
    const existing = new Set(
      this.db
        .query<{ name: string }, []>(`SELECT "name" FROM "sqlite_master" WHERE "type" = 'table'`)
        .all()
        .map((row) => row.name),
    );
    const purge = this.db.transaction(() => {
      for (const table of scopedTables) {
        if (!existing.has(table)) {
          continue;
        }
        this.db.query(`DELETE FROM ${quoteIdentifier(table)} WHERE "app_id" = ?`).run(appId);
      }
      this.db.query(`DELETE FROM "apps" WHERE "app_id" = ?`).run(appId);
    });
    purge();
  }

  /**
   * changelog にエントリを追記する。
   * @throws app_id が台帳にない、または同一アプリ内で diff_id が重複する場合
   */
  appendChangelog(input: AppendChangelogInput): ChangelogEntry {
    if (!this.hasApp(input.app_id)) {
      throw new Error(`app_id "${input.app_id}" は台帳に登録されていません。`);
    }
    const appliedAt = input.applied_at ?? nowIso();
    const snapshot = input.snapshot ?? null;
    const kind = input.kind ?? "apply";
    const undoTargetSeq = input.undo_target_seq ?? null;
    const row = this.db
      .query<
        { seq: number },
        [string, string, string, string, string, string | null, string, number | null]
      >(
        `INSERT INTO "changelog"
           ("app_id", "diff_id", "intent", "operations", "applied_at", "snapshot",
            "kind", "undo_target_seq")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING "seq"`,
      )
      .get(
        input.app_id,
        input.diff_id,
        input.intent,
        JSON.stringify(input.operations),
        appliedAt,
        snapshot,
        kind,
        undoTargetSeq,
      );
    if (row === null) {
      throw new Error(`changelog への追記に失敗しました(diff_id: ${input.diff_id})。`);
    }
    return {
      seq: row.seq,
      app_id: input.app_id,
      diff_id: input.diff_id,
      intent: input.intent,
      operations: input.operations,
      applied_at: appliedAt,
      snapshot,
      kind,
      undo_target_seq: undoTargetSeq,
    };
  }

  /**
   * 指定アプリの changelog を適用順(seq 昇順)で返す。
   * seq は AUTOINCREMENT のため、同一ミリ秒に追記されたエントリでも順序が一意に定まる。
   */
  listChangelog(appId: string): ChangelogEntry[] {
    return this.db
      .query<ChangelogRow, [string]>(
        `SELECT "seq", "app_id", "diff_id", "intent", "operations", "applied_at", "snapshot",
                "kind", "undo_target_seq"
         FROM "changelog" WHERE "app_id" = ? ORDER BY "seq" ASC`,
      )
      .all(appId)
      .map(toChangelogEntry);
  }

  /**
   * 全アプリの changelog を適用順(seq 昇順)で返す(ADR-0006 §6b)。
   *
   * システムテーブル `_changelog` は閲覧中のアプリに閉じない。ブートストラップアプリの
   * 完成条件は「**各アプリの** diff 履歴が intent 付きで読める」であり、単一アプリの
   * 履歴に閉じては満たせないためである。アプリごとの絞り込みは `list_view` の
   * `filter`(`app_id`)が行う。
   *
   * seq は全アプリ共通の AUTOINCREMENT なので、これがそのまま横断の適用順になる。
   */
  listAllChangelog(): ChangelogEntry[] {
    return this.db
      .query<ChangelogRow, []>(
        `SELECT "seq", "app_id", "diff_id", "intent", "operations", "applied_at", "snapshot",
                "kind", "undo_target_seq"
         FROM "changelog" ORDER BY "seq" ASC`,
      )
      .all()
      .map(toChangelogEntry);
  }
}
