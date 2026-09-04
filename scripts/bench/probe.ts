/**
 * SQL 発行の実測プローブ(V1-M1-T05 の測定項目4)。
 *
 * ## なぜ必要か
 *
 * `docs/plan/v1/records/v1-m1-t02.md` 争点2 は「**ドライランを挟むと DB 全体のコピーが
 * 計5回になる**」と主張している。これはコードを読んで数えた**推定**であって、実測ではない。
 * 本タスクの規律は「推定値を実測値として書かないこと」なので、**実際に発行された SQL を
 * 数えて確認する**。
 *
 * ## どう数えるか
 *
 * `bun:sqlite` の `Database.prototype.query` / `.exec` を**ベンチマークスクリプト側で**
 * 差し替えて、発行された SQL を分類・計数する。
 *
 * **`src/` を1バイトも変更しない**ことが本タスクの規律なので、カーネルにフックを
 * 足すことはしない。カーネルとベンチは同一プロセスで同じ `bun:sqlite` の
 * `Database` クラスオブジェクトを共有するため、プロトタイプの差し替えで
 * カーネル内部の発行も捕まえられる(この前提は `probe.test.ts` が検査する)。
 *
 * ## 数えるもの
 *
 * | 分類 | 判定 | 意味 |
 * |---|---|---|
 * | `vacuum_into` | `VACUUM INTO` | **DB ファイル全体の整合コピー**。`takeSnapshot` と `dryRunDiff` の複製作成 |
 * | `rebuild_table` | `CREATE TABLE "gp-rebuild-` | **テーブル1つ分の全行コピー**(層2)。DB 全体ではない |
 * | `conversion_scan` | `SELECT ... FROM` かつ呼び出し元が変換事前検証 | ADR-0010 §6b の全行事前走査 |
 *
 * **DB 全体のコピーとテーブル単位のコピーを混ぜて数えない。** 争点2 の「5回」は
 * 両者を足した数なので、分けて数えないと主張を検証できない。
 */
import { Database } from "bun:sqlite";

/** 1件の SQL 発行の記録。 */
export type SqlEvent = {
  kind: "vacuum_into" | "rebuild_create" | "rebuild_insert" | "full_scan";
  /** 発行先の DB ファイル名。`:memory:` もありうる。 */
  filename: string;
  /** 正規化した SQL(先頭 120 文字)。 */
  sql: string;
};

/** プローブが集めた結果。 */
export type SqlProbeResult = {
  events: SqlEvent[];
  /** 分類ごとの件数。 */
  counts: Record<SqlEvent["kind"], number>;
};

const VACUUM_INTO = /\bVACUUM\s+INTO\b/i;
const REBUILD_CREATE = /\bCREATE\s+TABLE\s+"gp-rebuild-/i;
const REBUILD_INSERT = /\bINSERT\s+INTO\s+"gp-rebuild-/i;
/** `checkFieldConversions` / `rebuildTable` が撃つ「WHERE の無い全行 SELECT」。 */
const FULL_SCAN = /^\s*SELECT\b(?![\s\S]*\bWHERE\b)[\s\S]*\bFROM\b/i;

function classify(sql: string): SqlEvent["kind"] | null {
  if (VACUUM_INTO.test(sql)) {
    return "vacuum_into";
  }
  if (REBUILD_CREATE.test(sql)) {
    return "rebuild_create";
  }
  if (REBUILD_INSERT.test(sql)) {
    return "rebuild_insert";
  }
  if (FULL_SCAN.test(sql)) {
    return "full_scan";
  }
  return null;
}

/**
 * `body` を実行しながら SQL 発行を計数する。
 *
 * 差し替えは `finally` で必ず戻す。戻し忘れると以降の測定が全部汚染される。
 */
export function withSqlProbe<T>(body: () => T): { value: T; probe: SqlProbeResult } {
  const events: SqlEvent[] = [];
  const originalQuery = Database.prototype.query;
  const originalExec = Database.prototype.exec;

  const record = (self: Database, sql: unknown): void => {
    if (typeof sql !== "string") {
      return;
    }
    const kind = classify(sql);
    if (kind === null) {
      return;
    }
    events.push({
      kind,
      filename: (self as unknown as { filename?: string }).filename ?? "(unknown)",
      sql: sql.replace(/\s+/g, " ").slice(0, 120),
    });
  };

  // biome-ignore lint/suspicious/noExplicitAny: プロトタイプ差し替えのため型を緩める
  (Database.prototype as any).query = function patchedQuery(this: Database, ...args: any[]) {
    record(this, args[0]);
    // biome-ignore lint/suspicious/noExplicitAny: 同上
    return (originalQuery as any).apply(this, args);
  };
  // biome-ignore lint/suspicious/noExplicitAny: 同上
  (Database.prototype as any).exec = function patchedExec(this: Database, ...args: any[]) {
    record(this, args[0]);
    // biome-ignore lint/suspicious/noExplicitAny: 同上
    return (originalExec as any).apply(this, args);
  };

  try {
    const value = body();
    return { value, probe: summarize(events) };
  } finally {
    Database.prototype.query = originalQuery;
    Database.prototype.exec = originalExec;
  }
}

function summarize(events: SqlEvent[]): SqlProbeResult {
  const counts: Record<SqlEvent["kind"], number> = {
    vacuum_into: 0,
    rebuild_create: 0,
    rebuild_insert: 0,
    full_scan: 0,
  };
  for (const event of events) {
    counts[event.kind] += 1;
  }
  return { events, counts };
}
