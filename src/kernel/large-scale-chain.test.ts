/**
 * CP-V1-1 確認方法1 の CI 化(V1-M1 穴埋め)。
 *
 * ## なぜこのファイルが要るのか
 *
 * `docs/plan/v1/01-destructive-migration.md` §CP-V1-1 確認方法1 は
 *
 * > データ入りアプリ(**1万行以上**)で「型変更→ドライラン→レポート確認→適用→undo→完全復元」の
 * > E2E シナリオが green
 *
 * を要求している。**しかし実測の時点で、この連鎖を検証する自動テストの最大行数は 12 行だった**
 * (`apply-diff.test.ts` の `const rowCount = 1 + Math.floor(random() * 12)`)。1万行・10万行での
 * green は `cp-v1-1-measurements.md` §1-3 の**使い捨てスクリプト**の結果であり、**CI に入っていない**
 * —— 次に誰かが壊しても赤くならない。**本ファイルはその穴だけを塞ぐ。**
 *
 * ## 行数を 10,000 に固定し、環境変数で切らない理由(実測に基づく)
 *
 * 「重いから既定では走らせない」という分け方は、**「CI に入っていない」という問題をそのまま再生産する。**
 * 既定で走らないテストは確認方法1 を満たさない。よって**分けないで済むかを先に実測した**:
 *
 * ```
 * insert 10000 rows:  41.3ms
 * dryRun:             40.7ms
 * apply:              21.6ms
 * undo:                7.0ms
 * TOTAL:             110.7ms      (Apple M4 / 32GB。ADR-0011 §Context と同一環境)
 * ```
 *
 * **1連鎖あたり約 0.11 秒である。**着手前の `bun test` 全体は 11.71 秒だったので、本ファイルが
 * 数本の連鎖を足しても**全体の数%に収まる。分ける理由が無いので分けない。**
 *
 * **したがって本ファイルは「既定で走る側だけで確認方法1 を満たす」と主張する。**環境変数で有効化する
 * 大規模側は存在しない。10万行・100万行の測定は `scripts/bench/` の担当であり、**あちらは正しさを
 * 検証しない**(`cp-v1-1-measurements.md` §1-2 が実測で確認している)。**本ファイルは正しさだけを見る。**
 *
 * ## 「完全復元」を **論理的同一** の意味に採る(バイト同一は採らない)
 *
 * 確認方法1 の「完全復元」がどちらの定義を指すかを、条文は決めていない
 * (`cp-v1-1-measurements.md` §1-4)。**本ファイルは論理的同一を採る。**根拠は ADR-0004 §4 で、
 * undo は「対象 apply エントリの `snapshot` の `manifest.json` と `app.sqlite` を
 * アプリ直下へ複製し直す操作」であり、そのスナップショットは **`VACUUM INTO`** で作られる。
 * **`VACUUM INTO` はページを詰めるので、バイト差は圧縮の副産物であってデータの差ではない。**
 * バイト同一を定義に採ると、**フリーページの配置という利用者に何の意味も持たない性質を
 * 保証対象にすることになる。**
 *
 * したがって主張は **すべて正の形**(「一致する」)で書く: `manifest.json` のテキスト /
 * `PRAGMA table_info` の列名と宣言型 / **`sqlite_master` の DDL 原文** / 全テーブルの全行 /
 * `PRAGMA integrity_check`。
 *
 * **バイト長と `PRAGMA schema_version` は主張しない。**どちらも `VACUUM INTO` の副産物である
 * (実測: バイト長 −1.4%、schema_version は **元の値 +1**)。**負の形(「一致しない」)で
 * 主張すると、意味的には何も壊れていないのにテストが赤くなる。**これは推測ではなく実証済みで、
 * `takeSnapshot` を単純コピーに変えた故障注入では、データが完全に復元されるにもかかわらず
 * 旧アサーション(バイト不一致の主張)だけが赤くなった。
 *
 * ## 時間ベースのアサーションを置かない理由
 *
 * ADR-0011 §D2 は移行の引き金を **`takeSnapshot` 500ms / 層1 apply 500ms / `snapshots/` 合計 2GB**
 * と定めている。**このうち時間の2つをテストのアサーションにはしない。** 理由は2つ:
 *
 * 1. **CI の実行機は本 ADR の測定環境ではない。** ADR-0011 自身が「§5 の閾値は**その環境で測り直した
 *    数値**に対して適用するものであって、本 ADR の数値を他環境に持ち込んで判定してはならない」と
 *    書いている。**別環境の閾値を CI のアサーションに焼くのは、この ADR に正面から反する。**
 * 2. **不安定なテストを足すくらいなら足さない方がよい。** 共有ランナーの負荷変動で赤くなるテストは、
 *    「赤を無視する」習慣を育てる。それは検査が1本も無いより悪い。
 *
 * **代わりに、時間に依存しない構造的な不変量を置く** —— **ADR-0011 の費用モデルそのものを検査する。**
 * A1(`snapshots/` 合計 2GB)の根拠は「**スナップショット1個 = app.sqlite の 0.986 倍**」「1回の
 * apply が作るスナップショットは1個」である。**この2つが崩れると、A1 の距離の見積り(20MB の DB なら
 * 101 回)が静かに外れる。**個数と相対サイズは決定的に測れるので、ここだけをアサートする。
 *
 * > **本ファイルが検知できないもの(明記する)**: **絶対的な性能劣化は検知できない。**
 * > 1連鎖が 0.11 秒から 10 秒になっても本ファイルは緑のままである。**性能の回帰検知は
 * > `scripts/bench/` の担当であり、本ファイルはそれを肩代わりしない。**
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff } from "./apply-diff.ts";
import { applyManifest } from "./apply-manifest.ts";
import { conversionLayer } from "./convert.ts";
import { createApp } from "./create-app.ts";
import { dryRunDiff } from "./dry-run.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { createRecord } from "./records.ts";
import { listSnapshots } from "./snapshot.ts";
import { appDbPath, appManifestPath, snapshotDir } from "./storage-paths.ts";
import type { Manifest } from "./types.ts";
import { undo } from "./undo.ts";

/**
 * 確認方法1 の「1万行以上」をそのまま採る。**下回らせない。**
 *
 * 条文が数字を書いている以上、テストの行数は条文の数字と一致していなければ、
 * 「確認方法1 を満たした」と言えない。実測で 0.11 秒/連鎖なので下げる理由も無い。
 */
const LARGE_ROW_COUNT = 10_000;

const APP_ID = "large-scale";

let dataRoot: string;
let store: KernelMetaStore;

function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "大規模検証",
      tables: [
        {
          id: "orders",
          name: "注文",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "qty", name: "数量", type: "text" },
            { id: "memo", name: "メモ", type: "long_text" },
          ],
        },
      ],
      views: [{ id: "order-list", type: "list_view", table: "orders", columns: ["title"] }],
    },
  };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-large-scale-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "大規模検証", { app_id: APP_ID });
  const applied = applyManifest(dataRoot, APP_ID, baseManifest());
  if (!applied.valid) {
    throw new Error(`初期マニフェストの投入に失敗: ${JSON.stringify(applied.errors)}`);
  }
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

function withDb<T>(fn: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function readManifestText(): string {
  return readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8");
}

/** `app.sqlite` のバイト列そのもの(拒否経路の「状態不変」はここまで見る)。 */
function readDbBytes(): Buffer {
  return readFileSync(appDbPath(dataRoot, APP_ID));
}

/**
 * `sqlite_master` の全行(**DDL のテキストそのものを含む**)。
 *
 * 「論理的に同一のスキーマへ戻った」ことの最も強い観測点である。`table_info` は
 * 列名と宣言型しか見ないので、`PRIMARY KEY` / `NOT NULL` / インデックスの有無が
 * 変わっても気付けない。`sql` 列は CREATE 文の原文なので、そこまで含めて一致を見る。
 *
 * **実測(probe)**: undo 後、この4列は1文字も違わない。`VACUUM INTO` は
 * スキーマのテキストを保存する。
 */
function readSqliteMaster(): {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}[] {
  return withDb((db) =>
    db
      .query<{ type: string; name: string; tbl_name: string; sql: string | null }, []>(
        `SELECT "type", "name", "tbl_name", "sql" FROM "sqlite_master" ORDER BY "type", "name"`,
      )
      .all(),
  );
}

/** `PRAGMA integrity_check`。復元された DB が SQLite として健全であること。 */
function integrityCheck(): unknown {
  return withDb(
    (db) =>
      db.query<{ integrity_check: string }, []>(`PRAGMA integrity_check`).get()?.integrity_check,
  );
}

/** `PRAGMA table_info` の列名 + **宣言型**。層2 が起きたかはここに出る。 */
function readSchemaWithTypes(): Record<string, [string, string][]> {
  return withDb((db) => {
    const tables = db
      .query<{ name: string }, []>(
        `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%' ORDER BY "name"`,
      )
      .all()
      .map((row) => row.name);
    const out: Record<string, [string, string][]> = {};
    for (const table of tables) {
      out[table] = db
        .query<{ name: string; type: string }, []>(`PRAGMA table_info("${table}")`)
        .all()
        .map((row) => [row.name, row.type] as [string, string]);
    }
    return out;
  });
}

/**
 * `sqlite_master.rootpage` —— **テーブル再構築が実際に起きたかの直接の観測点。**
 *
 * 層2 は `CREATE TABLE 新 → INSERT SELECT → DROP 旧 → ALTER RENAME` を踏むので
 * B-tree の根ページが移る。層1 は DDL を1文も発行しないので動かない。**実測(probe)**:
 * `text → number` で 2 → 388、`text → date` で 2 のまま。
 */
function readRootPages(): Record<string, number> {
  return withDb((db) => {
    const rows = db
      .query<{ name: string; rootpage: number }, []>(
        `SELECT "name", "rootpage" FROM "sqlite_master" WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%' ORDER BY "name"`,
      )
      .all();
    return Object.fromEntries(rows.map((row) => [row.name, row.rootpage]));
  });
}

/** 全テーブルの全行(テーブル名昇順・`_id` 昇順)。1万行でも素直に読む。 */
function readAllRows(): Record<string, Record<string, unknown>[]> {
  return withDb((db) => {
    const tables = db
      .query<{ name: string }, []>(
        `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%' ORDER BY "name"`,
      )
      .all()
      .map((row) => row.name);
    const out: Record<string, Record<string, unknown>[]> = {};
    for (const table of tables) {
      out[table] = db
        .query<Record<string, unknown>, []>(`SELECT * FROM "${table}" ORDER BY "_id"`)
        .all();
    }
    return out;
  });
}

/** `snapshots/` 配下の合計バイト数(ADR-0011 A1 の測る量そのもの)。 */
function snapshotsTotalBytes(): number {
  let total = 0;
  for (const name of listSnapshots(dataRoot, APP_ID)) {
    const dir = snapshotDir(dataRoot, APP_ID, name);
    for (const file of ["app.sqlite", "manifest.json"]) {
      try {
        total += statSync(join(dir, file)).size;
      } catch {
        // 片方しか無い構成でも合計が壊れないようにする(存在自体は別テストの担当)。
      }
    }
  }
  return total;
}

/**
 * `orders` に決定的なデータを N 行入れる。
 *
 * **`qty` は「行番号を10進で書いた文字列」である。**値が壊れていないことを主張するとき、
 * 行番号との対応が付いていないと「何と一致すべきか」を書けない。
 */
function seedRows(count: number, unconvertibleAt: ReadonlySet<number> = new Set()): void {
  withDb((db) => {
    const manifest = JSON.parse(readManifestText()) as Manifest;
    db.exec("BEGIN");
    for (let index = 0; index < count; index += 1) {
      const qty = unconvertibleAt.has(index) ? `だいたい${index}円` : String(index);
      const result = createRecord(db, manifest, "orders", {
        title: `注文-${String(index).padStart(6, "0")}`,
        qty,
        memo: index % 3 === 0 ? "" : `メモ${index}`,
      });
      if (!result.ok) {
        throw new Error(`投入に失敗(${index}行目): ${JSON.stringify(result.errors)}`);
      }
    }
    db.exec("COMMIT");
  });
}

/** `title` をキーに `qty` を引く(行の中身が壊れていないことの主張に使う)。 */
function qtyOf(title: string): unknown {
  return withDb(
    (db) =>
      db
        .query<{ qty: unknown }, [string]>(`SELECT "qty" FROM "orders" WHERE "title" = ?`)
        .get(title)?.qty,
  );
}

function typeChangeDiff(diffId: string, to: string): unknown {
  return {
    diff_id: diffId,
    intent: "数量を数値として扱いたい",
    operations: [{ op: "change_field", table: "orders", field: "qty", changes: { type: to } }],
  };
}

describe("CP-V1-1 確認方法1: 1万行での破壊的連鎖(層2 = テーブル再構築)", () => {
  test(`${LARGE_ROW_COUNT} 行で 型変更 → ドライラン → 適用 → undo → 完全復元 が通り、全行の値が保たれる`, () => {
    seedRows(LARGE_ROW_COUNT);

    // 前提: これは本当に層2(テーブル再構築)の経路である。
    // 層1 に落ちていたら「再構築を伴う連鎖を1万行で検証した」という主張が空になる。
    expect(conversionLayer("text", "number")).toBe(2);

    const beforeManifest = readManifestText();
    const beforeSchema = readSchemaWithTypes();
    const beforeMaster = readSqliteMaster();
    const beforeRootPages = readRootPages();
    const beforeRows = readAllRows();
    const beforeDbBytes = readDbBytes();

    expect(beforeRows.orders).toHaveLength(LARGE_ROW_COUNT);

    // --- ドライラン: レポートが出て、DB は1バイトも動かない -------------------
    const dry = dryRunDiff(dataRoot, APP_ID, typeChangeDiff("d-large-1", "number"));
    expect(dry.valid).toBe(true);
    expect(readManifestText()).toBe(beforeManifest);
    expect(readDbBytes().equals(beforeDbBytes)).toBe(true);
    // ドライランは本番の `snapshots/` を1つも作らない(複製の上で走るため)。
    expect(listSnapshots(dataRoot, APP_ID)).toHaveLength(0);

    // --- 適用 ---------------------------------------------------------------
    const applied = applyDiff(dataRoot, APP_ID, typeChangeDiff("d-large-1", "number"));
    expect(applied.valid).toBe(true);

    // 層2 が実際に起きたことを、DB の側から2つの独立した観測で確かめる。
    const afterSchema = readSchemaWithTypes();
    expect(afterSchema.orders).toContainEqual(["qty", "NUMERIC"]);
    expect(readRootPages().orders).not.toBe(beforeRootPages.orders);

    // --- 全行コピーの検証: 行数だけでなく値まで見る ---------------------------
    const afterCount = withDb(
      (db) => db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "orders"`).get()?.n,
    );
    expect(afterCount).toBe(LARGE_ROW_COUNT);

    // 先頭・末尾・境界(1桁/2桁/3桁/4桁の繰り上がり)の行を名指しで照合する。
    // 「全行の集計が合う」だけだと、2行が入れ替わっても気付けない。
    const boundaries = [0, 1, 9, 10, 99, 100, 999, 1000, 9998, LARGE_ROW_COUNT - 1];
    for (const index of boundaries) {
      expect(qtyOf(`注文-${String(index).padStart(6, "0")}`)).toBe(index);
    }

    // 集計でも見る(名指しの10行の外側が消えていないことを担保する)。
    const aggregate = withDb((db) =>
      db
        .query<{ total: number; lo: number; hi: number; nulls: number }, []>(
          `SELECT SUM("qty") AS total, MIN("qty") AS lo, MAX("qty") AS hi,
                  SUM(CASE WHEN "qty" IS NULL THEN 1 ELSE 0 END) AS nulls FROM "orders"`,
        )
        .get(),
    );
    // 0 + 1 + ... + 9999 = 9999 * 10000 / 2
    expect(aggregate?.total).toBe(((LARGE_ROW_COUNT - 1) * LARGE_ROW_COUNT) / 2);
    expect(aggregate?.lo).toBe(0);
    expect(aggregate?.hi).toBe(LARGE_ROW_COUNT - 1);
    expect(aggregate?.nulls).toBe(0);

    // 空文字だった `memo` が黙って null に化けていないこと(限定7: カーネルは書き換えない)。
    const emptyMemos = withDb(
      (db) =>
        db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "orders" WHERE "memo" = ''`).get()
          ?.n,
    );
    expect(emptyMemos).toBe(Math.ceil(LARGE_ROW_COUNT / 3));

    // --- undo → 完全復元 -----------------------------------------------------
    const undone = undo(dataRoot, APP_ID);
    expect(undone.valid).toBe(true);

    // === 「完全復元」= 論理的同一 ===========================================
    //
    // 確認方法1 の「完全復元」を、本ファイルは **論理的同一** の意味に採る。
    // 根拠は ADR-0004 §4 である —— undo は「対象 apply エントリの `snapshot` が指す
    // ディレクトリの `manifest.json` と `app.sqlite` をアプリ直下へ複製し直す操作」であり、
    // そのスナップショットは `snapshot.ts` が **`VACUUM INTO`** で作る。
    // **`VACUUM INTO` はページを詰める。**したがってバイト差は「圧縮の副産物」であって
    // 「データの差」ではない。バイト同一を定義に採ると、**フリーページの配置という、
    // 利用者に何の意味も持たない性質を保証対象にすることになる。**
    //
    // 主張するのは次の4つ。すべて **正の形**(「一致する」)で書く。
    expect(readManifestText()).toBe(beforeManifest);
    expect(readSchemaWithTypes()).toEqual(beforeSchema);
    // スキーマは DDL のテキストまで見る(`PRIMARY KEY` やインデックスの消失を捉える)。
    expect(readSqliteMaster()).toEqual(beforeMaster);
    expect(readAllRows()).toEqual(beforeRows);
    // 復元された DB が SQLite として健全であること。
    expect(integrityCheck()).toBe("ok");
    // 全テーブルの行数(`readAllRows` の deep-equal に含まれるが、
    // 壊れたときに「何行ずれたか」が一目で出るように明示的に置く)。
    for (const [table, rows] of Object.entries(beforeRows)) {
      expect(readAllRows()[table]).toHaveLength(rows.length);
    }

    // --- ここから下は「主張」ではない。**測った事実の記録である。** -----------
    //
    // **バイト同一は成り立たない。理由は `VACUUM INTO` の圧縮であり、データの差ではない。**
    // 実測: 1万行で 2,101,248 → 2,072,576 バイト(−1.4%)。10万行でも同じく −1.4%。
    //
    // **これをアサーションにしてはならない。**「バイトが一致しないこと」を主張すると、
    // 偶発的な実装事実を負の形で固定することになり、**意味的には何も壊れていないのに
    // テストが赤くなる。** 実証済み(故障注入 E): `takeSnapshot` を `VACUUM INTO` から
    // 単純コピーに変えると、データは完全に復元されるのに、旧アサーションだけが赤くなった。
    //
    // 同じ理由で **`PRAGMA schema_version` も主張しない。**
    // 実測: undo 前 2 → undo 後 3。`VACUUM INTO` はコピー先の schema_version を
    // **元の値 +1 にする**(probe で単独確認: 2 → 3、もう一度重ねると 4)。
    // これはスキーマ変更の回数を数える SQLite 内部のカウンタであって、
    // **スキーマそのものではない。**バイト長と同じ「`VACUUM INTO` の副産物」の側にある。
    // 論理スキーマの一致は上の `readSqliteMaster()` が DDL 原文で保証している。
    //
    // なお、この2つを「一致しない」と負の形で主張しないのと同様に、
    // 「+1 になる」と正の形で主張することもしない —— どちらも同じ偶発的事実である。
  });

  test("ADR-0011 A1 の費用モデル(1 apply = 1 スナップショット / DB の約1倍)が1万行で崩れていない", () => {
    seedRows(LARGE_ROW_COUNT);
    const dbBytes = readDbBytes().length;

    expect(applyDiff(dataRoot, APP_ID, typeChangeDiff("d-large-2", "number")).valid).toBe(true);

    // **1回の apply が作るスナップショットはちょうど1個。**
    // ADR-0011 §D2 A1 の「20MB の DB なら 101 回の apply で 2GB」という距離の見積りは、
    // この 1:1 に乗っている。ここが 2 になれば見積りは黙って半分になる。
    expect(listSnapshots(dataRoot, APP_ID)).toHaveLength(1);

    // **スナップショット1個 ≒ app.sqlite の 0.986 倍**(ADR-0011 の実測)。
    // 時間ではなくサイズなので決定的に測れる。上下に十分な余裕を取り、
    // 「差分バックアップに変わった」「二重に取るようになった」級の変化だけを捕まえる。
    const ratio = snapshotsTotalBytes() / dbBytes;
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(1.5);

    // undo 自身も戻す前に1個取る(`undo.ts`)。合計2個。
    expect(undo(dataRoot, APP_ID).valid).toBe(true);
    expect(listSnapshots(dataRoot, APP_ID)).toHaveLength(2);
  });
});

describe("CP-V1-1 確認方法2: 1万行に変換不能値が混じるときの中止と状態不変", () => {
  for (const badCount of [1, 200]) {
    test(`${LARGE_ROW_COUNT} 行中 ${badCount} 行が変換不能なら、適用は中止され app.sqlite は1バイトも変わらない`, () => {
      const bad = new Set<number>();
      for (let index = 0; index < badCount; index += 1) {
        // 先頭・末尾・中間に散らす(先頭で早期に落ちるだけの経路を緑にしないため)。
        bad.add(Math.floor((index * (LARGE_ROW_COUNT - 1)) / Math.max(badCount - 1, 1)));
      }
      seedRows(LARGE_ROW_COUNT, bad);

      const beforeManifest = readManifestText();
      const beforeSchema = readSchemaWithTypes();
      const beforeRootPages = readRootPages();
      const beforeDbBytes = readDbBytes();

      const dry = dryRunDiff(dataRoot, APP_ID, typeChangeDiff("d-large-bad", "number"));
      expect(dry.valid).toBe(false);

      const applied = applyDiff(dataRoot, APP_ID, typeChangeDiff("d-large-bad", "number"));
      expect(applied.valid).toBe(false);
      if (applied.valid || dry.valid) {
        return;
      }

      // ドライランと実適用が同じことを言う(片方だけ通る経路を作らない)。
      expect(applied.errors).toEqual(dry.errors);

      // **総数は打ち切っても正確に述べる**(convert.ts の UNCONVERTIBLE_SAMPLE_LIMIT = 5)。
      const message = applied.errors[0]?.message ?? "";
      expect(message).toContain(`既存の ${bad.size} 件のレコードが変換できなくなります`);
      if (bad.size > 5) {
        expect(message).toContain(`ほか ${bad.size - 5} 件`);
      }

      // 状態不変。**拒否経路はスナップショットを作らないので、バイト列まで一致する。**
      expect(readManifestText()).toBe(beforeManifest);
      expect(readSchemaWithTypes()).toEqual(beforeSchema);
      expect(readRootPages()).toEqual(beforeRootPages);
      expect(readDbBytes().equals(beforeDbBytes)).toBe(true);
      expect(listSnapshots(dataRoot, APP_ID)).toHaveLength(0);
    });
  }
});
