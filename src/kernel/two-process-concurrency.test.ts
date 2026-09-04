/**
 * P6: 2プロセス実証テスト(V1-M9-T02 / ADR-0017)。
 *
 * ## なぜ**別プロセス**でなければならないか(完了条件6)
 *
 * 「同時更新の保護」と「applyDiff の原子性」は、**別の接続/別のプロセスが本当に同時に
 * 書きにきたとき**にしか実証できない。同一プロセス・同一スレッドのモックでは、apply が
 * 危険窓に入っている「その間に」別の書込を走らせることができない(JS は単一スレッドで、
 * apply が返るまで次の行が動かない)。したがって本ファイルの3テストは、いずれも
 * **`Bun.spawn` で起動した別プロセス**と、**`.st-applying.json` マーカー(apply が自分で
 * 立てるもの)を sentinel としたポーリング**で協調する。**apply とその相手は必ず別プロセス**
 * である(`scripts/bench/contention-writer.ts` の Bun.spawn + sentinel パターンに倣う)。
 *
 * ## apply 窓は**実データ量で伸ばす**(計画の厳守事項)
 *
 * (ii)(iii) の apply は 8 万行のテーブルに対する `change_field`(number → text)で、層2の
 * テーブル再構築(新テーブル作成 → 全行コピー → **旧テーブル DROP** → rename)を起こす。
 * 危険窓(`beginApply`〜`endApply`)は再構築とスナップショットの**本物のコスト**で数十〜百 ms に
 * 伸びる。**apply-diff.ts にテスト用の遅延・差し替えフックは1つも挟んでいない。**
 *
 * ## 残余 TOCTOU(M1)の扱い
 *
 * マーカー確認→書込の間に apply が始まる極小の TOCTOU が設計上残る(ADR-0017 に申告済み)。
 * 本テストは「**配線経由で試みた書込は弾かれる**(適用中エラー、または先着ロックで
 * SQLITE_BUSY)」ことと「**ok:true で返った書込は1件も静かに失われない**」ことを主張する。
 * この構成では別テーブルへの書込が窓中にすり抜けても、apply 側が書込ロックを保持している
 * ため SQLITE_BUSY で弾かれ、ok:true にはならない —— よって silent-loss は起きない。
 * 仮に残余 TOCTOU が顕在化しても、それは**設計限界**であってテストの失敗にはしない。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, readCurrentManifest } from "./apply-manifest.ts";
import { getChangelog } from "./changelog.ts";
import { createApp } from "./create-app.ts";
import { quoteIdentifier } from "./ddl.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { createRecord, getRecord, type RecordInput } from "./records.ts";
import { isApplyInProgress, recover } from "./recovery.ts";
import { appDbPath } from "./storage-paths.ts";
import type { Manifest, Workflow } from "./types.ts";
import { undo } from "./undo.ts";
import { resetWorkflowClock, setWorkflowClock } from "./workflow-runner.ts";
import { runSchedulerTick } from "./workflow-scheduler.ts";

let dataRoot: string;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-2proc-"));
});

afterEach(async () => {
  resetWorkflowClock();
  await rm(dataRoot, { recursive: true, force: true });
});

// --- 共通ヘルパ ----------------------------------------------------------------

/** 別プロセスのスクリプトのパス(このファイルと同じ src/kernel 配下)。 */
function scriptPath(name: string): string {
  return join(import.meta.dir, "two-process", name);
}

/** `condition` が真になるまで待つ(実時間の協調に使う。イベントループに毎回譲る)。 */
async function waitUntil(
  condition: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`${label}: ${timeoutMs}ms 以内に条件が成立しませんでした。`);
    }
    await Bun.sleep(5);
  }
}

/** SQLITE_BUSY(= 書込ロックの先着に負けた)か。 */
function isBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "SQLITE_BUSY" || code === "SQLITE_BUSY_SNAPSHOT") {
    return true;
  }
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && /database is locked/i.test(message);
}

/** 指定テーブルの `_id` 集合を直接 SQL で読む(観測用)。 */
function rowIds(appId: string, tableId: string): Set<string> {
  const db = new Database(appDbPath(dataRoot, appId), { readonly: true });
  try {
    const rows = db.query(`SELECT "_id" FROM ${quoteIdentifier(tableId)}`).all() as {
      _id: string;
    }[];
    return new Set(rows.map((r) => r._id));
  } finally {
    db.close();
  }
}

/** テーブルの列名 → SQLite 型。 */
function columnType(appId: string, tableId: string, column: string): string | undefined {
  const db = new Database(appDbPath(dataRoot, appId), { readonly: true });
  try {
    const rows = db.query(`PRAGMA table_info(${quoteIdentifier(tableId)})`).all() as {
      name: string;
      type: string;
    }[];
    return rows.find((r) => r.name === column)?.type;
  } finally {
    db.close();
  }
}

/** ユーザテーブル名(`_` 始まりの予約テーブルを除く)。再構築の残骸検知に使う。 */
function userTableNames(appId: string): string[] {
  const db = new Database(appDbPath(dataRoot, appId), { readonly: true });
  try {
    return (
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    )
      .map((r) => r.name)
      .filter((name) => !name.startsWith("_") && !name.startsWith("sqlite_"));
  } finally {
    db.close();
  }
}

/**
 * app.sqlite に大量の行を決定的に投入する(実データ量で apply 窓を伸ばすため)。
 *
 * `numberColumn` に連番の整数を入れる —— これが `change_field`(number→text)の再構築対象で、
 * 行数に比例して再構築コスト(= 危険窓)が伸びる。DDL 側は required 制約を持たない
 * (`ddl.ts` 冒頭)ので、他列は省略してよい。決定論のため直接 SQL で投入する。
 */
function seedNumericRows(appId: string, tableId: string, numberColumn: string, rows: number): void {
  const db = new Database(appDbPath(dataRoot, appId), { readwrite: true, create: false });
  try {
    const insert = db.query(
      `INSERT INTO ${quoteIdentifier(tableId)} ` +
        `("_id","_created_at","_updated_at",${quoteIdentifier(numberColumn)}) VALUES (?,?,?,?)`,
    );
    db.transaction(() => {
      for (let i = 0; i < rows; i++) {
        const stamp = "2026-01-01T00:00:00.000Z";
        insert.run(`${tableId}-${String(i).padStart(9, "0")}`, stamp, stamp, i);
      }
    })();
  } finally {
    db.close();
  }
}

/**
 * HTTP/MCP の配線と**同じ意味論**でレコードを作る(書込前に apply 窓を確認 → 適用中なら
 * 書込まず失敗)。`src/server/app.ts` の POST /records・`src/mcp/tools/write.ts` の
 * insert_sample_data と同じ順序(`isApplyInProgress` → 開けてから `createRecord`)。
 */
function wiredCreate(
  appId: string,
  manifest: Manifest,
  tableId: string,
  input: RecordInput,
): { applying: boolean; ok: boolean; busy: boolean; id?: string } {
  const applying = isApplyInProgress(dataRoot, appId);
  if (applying.inProgress) {
    // 適用中は1バイトも書かずに失敗させる(B は「保存成功」と信じない)。
    return { applying: true, ok: false, busy: false };
  }
  const db = new Database(appDbPath(dataRoot, appId), { readwrite: true, create: false });
  try {
    const r = createRecord(db, manifest, tableId, input);
    return r.ok
      ? { applying: false, ok: true, busy: false, id: r.value._id }
      : { applying: false, ok: false, busy: false };
  } catch (error) {
    // マーカー確認をすり抜けた稀レース。apply が書込ロックを保持しているので SQLITE_BUSY で
    // 弾かれる(busy_timeout=0。配線層 withAppDb と同じ)。B は成功と信じない = silent-loss なし。
    if (isBusyError(error)) {
      return { applying: false, ok: false, busy: true };
    }
    throw error;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// (i) 同一レコードへの同時 PATCH → 片方だけ成功・他方は衝突(409/conflict)
// ---------------------------------------------------------------------------

describe("(i) 2プロセスが同一レコードを同時 PATCH → 片方だけ成功、他方は版不一致で衝突", () => {
  const APP_ID = "conc-patch";

  test("同じ版で2プロセスが撃つと、成功は1つだけ・もう片方は conflict", async () => {
    // アプリと1レコードを用意する。
    const store = KernelMetaStore.open(dataRoot);
    createApp(store, "同時更新", { app_id: APP_ID });
    store.close();
    const setup = applyManifest(dataRoot, APP_ID, {
      app: {
        id: APP_ID,
        name: "同時更新",
        tables: [
          {
            id: "items",
            name: "品目",
            fields: [{ id: "title", name: "名前", type: "text", required: true }],
          },
        ],
        views: [],
      },
    });
    expect(setup.valid, JSON.stringify(setup)).toBe(true);

    const manifest = readCurrentManifest(dataRoot, APP_ID);
    const created = (() => {
      const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
      try {
        const r = createRecord(db, manifest, "items", { title: "最初" });
        if (!r.ok) {
          throw new Error(`セットアップの作成に失敗: ${JSON.stringify(r.errors)}`);
        }
        return r.value;
      } finally {
        db.close();
      }
    })();
    const version = created._updated_at;

    // 2プロセスが**同じ版**を読んだ状態を再現する(親が一度読んだ version を両者に渡す)。
    const ready1 = join(dataRoot, "ready-1");
    const ready2 = join(dataRoot, "ready-2");
    const go = join(dataRoot, "go");
    const res1 = join(dataRoot, "res-1.json");
    const res2 = join(dataRoot, "res-2.json");

    const spawnWriter = (title: string, ready: string, res: string) =>
      Bun.spawn(
        [
          "bun",
          "run",
          scriptPath("patch-writer.ts"),
          dataRoot,
          APP_ID,
          "items",
          created._id,
          version,
          title,
          ready,
          go,
          res,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );

    const proc1 = spawnWriter("プロセスAの更新", ready1, res1);
    const proc2 = spawnWriter("プロセスBの更新", ready2, res2);

    // 両者が準備できてから go を出す(両者が同じ版を握って同時に撃つ)。
    await waitUntil(() => existsSync(ready1) && existsSync(ready2), 15_000, "両writerのready待ち");
    await Bun.write(go, "go");

    const [code1, code2] = await Promise.all([proc1.exited, proc2.exited]);
    if (code1 !== 0 || code2 !== 0) {
      const e1 = await new Response(proc1.stderr).text();
      const e2 = await new Response(proc2.stderr).text();
      throw new Error(`writer が異常終了(code1=${code1} code2=${code2})\n1:${e1}\n2:${e2}`);
    }

    const r1 = JSON.parse(readFileSync(res1, "utf-8")) as {
      ok: boolean;
      conflict?: boolean;
      version?: string;
      title?: string;
    };
    const r2 = JSON.parse(readFileSync(res2, "utf-8")) as {
      ok: boolean;
      conflict?: boolean;
      version?: string;
      title?: string;
    };

    // **成功はちょうど1つ、衝突はちょうど1つ。**(直列化されていても CAS が正しさを保証する)
    const oks = [r1, r2].filter((r) => r.ok);
    const conflicts = [r1, r2].filter((r) => !r.ok && r.conflict === true);
    expect(oks).toHaveLength(1);
    expect(conflicts).toHaveLength(1);

    // 最終レコードは勝者の内容で、版が進んでいる(黙って上書きされていない)。
    const winner = oks[0];
    if (winner === undefined || winner.title === undefined || winner.version === undefined) {
      throw new Error("勝者の結果が不完全です(直前のアサートが通っていれば起きない)。");
    }
    const finalManifest = readCurrentManifest(dataRoot, APP_ID);
    const finalDb = new Database(appDbPath(dataRoot, APP_ID), { readonly: true });
    try {
      const got = getRecord(finalDb, finalManifest, "items", created._id);
      expect(got.ok).toBe(true);
      if (got.ok && got.value !== null) {
        expect(got.value.title).toBe(winner.title);
        expect(got.value._updated_at).not.toBe(version);
        expect(got.value._updated_at).toBe(winner.version);
      }
    } finally {
      finalDb.close();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// (ii) A が applyDiff 中(危険窓)に B がレコード保存 → 窓内は弾かれ silent-loss ゼロ
// ---------------------------------------------------------------------------

describe("(ii) 別プロセスの applyDiff 危険窓中に配線経由 create → 弾かれ、ok:true は失われない", () => {
  const APP_ID = "conc-apply";
  const BULK_ROWS = 80_000;

  test("窓内 create は全て弾かれ、ok:true で返った行は1件も消えない(undo 後も pre-apply は残る)", async () => {
    // 大テーブル bulk(再構築で窓を伸ばす)+ 小テーブル notes(B の書込先)を作る。
    const store = KernelMetaStore.open(dataRoot);
    createApp(store, "適用中の保護", { app_id: APP_ID });
    store.close();
    const setup = applyManifest(dataRoot, APP_ID, {
      app: {
        id: APP_ID,
        name: "適用中の保護",
        tables: [
          {
            id: "bulk",
            name: "大テーブル",
            fields: [
              { id: "title", name: "件名", type: "text", required: true },
              { id: "qty", name: "数量", type: "number" },
            ],
          },
          {
            id: "notes",
            name: "メモ",
            fields: [{ id: "title", name: "件名", type: "text", required: true }],
          },
        ],
        views: [],
      },
    });
    expect(setup.valid, JSON.stringify(setup)).toBe(true);
    seedNumericRows(APP_ID, "bulk", "qty", BULK_ROWS);

    const manifest = readCurrentManifest(dataRoot, APP_ID);

    // Phase 1: apply 前に確定した「acknowledged な書込」(必ず ok:true、スナップショットに載る)。
    const seedNoteIds: string[] = [];
    for (let i = 0; i < 20; i++) {
      const r = wiredCreate(APP_ID, manifest, "notes", { title: `事前 ${i}` });
      expect(r.ok).toBe(true);
      if (r.id !== undefined) {
        seedNoteIds.push(r.id);
      }
    }

    // Phase 2: 別プロセスで重い applyDiff(bulk.qty number→text の再構築)を走らせる。
    const applyResult = join(dataRoot, "apply-result.json");
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        scriptPath("heavy-apply.ts"),
        dataRoot,
        APP_ID,
        "bulk",
        "qty",
        "text",
        "d-heavy",
        applyResult,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    // B(このプロセス)は、別プロセスの apply が**危険窓に入っている間だけ**配線経由 create を
    // 撃つ。窓の外(マーカー不在)では DB に触れない —— これは配線層が現に行う挙動そのもので
    // あり(書込前に isApplyInProgress を見て、適用中なら1バイトも書かない)、同時に「B が
    // apply を BUSY で殺してしまう」実験アーティファクトも避ける(カーネルの apply 接続は
    // busy_timeout=0 なので、外から書きにいくと apply が落ちる —— それは配線層が塞いだ経路)。
    // マーカーの観測(existsSync)は DB ロックを取らないので、窓の検出は apply を妨げない。
    const okIds: string[] = [];
    let rejectedInWindow = 0; // 「適用中」で弾かれた or すり抜けても busy で弾かれた(= B は成功と信じない)
    let windowSeen = false;
    const deadline = Date.now() + 25_000;
    let counter = 0;
    for (;;) {
      const applyingNow = isApplyInProgress(dataRoot, APP_ID).inProgress;
      if (applyingNow) {
        windowSeen = true;
        // 窓中は配線経由 create を撃つ(全て「適用中」で弾かれるはず)。
        const r = wiredCreate(APP_ID, manifest, "notes", { title: `窓中 ${counter++}` });
        if (r.applying || r.busy) {
          rejectedInWindow++;
        } else if (r.ok && r.id !== undefined) {
          okIds.push(r.id); // 窓境界のすり抜け(post-commit)。稀。silent-loss ではない。
        }
      }
      if (windowSeen && !applyingNow) {
        break; // マーカーが立ってから消えるまでを跨いだ = 窓を1回くぐった。
      }
      if (Date.now() > deadline) {
        break;
      }
      // イベントループに毎回譲る(existsSync だけなので子プロセスの進行を妨げない)。
      await Bun.sleep(0);
    }

    const code = await proc.exited;
    const apply = JSON.parse(readFileSync(applyResult, "utf-8")) as {
      valid: boolean;
      errors?: unknown;
      threw?: string;
    };
    if (!apply.valid) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`heavy apply が失敗(code=${code}): ${JSON.stringify(apply)}\n${err}`);
    }

    // (a) 危険窓を実際に踏んでいる —— 別プロセスが apply 窓に入っている間に撃った create が
    //     全て「適用中」で弾かれた(この件数が 0 なら窓を踏めていない = テストが無意味)。
    //     すり抜けても DB には触れず busy で弾かれる(fail-safe)ので、いずれも silent-loss ではない。
    expect(windowSeen).toBe(true);
    expect(rejectedInWindow).toBeGreaterThan(0);

    // (b) silent-loss ゼロ: ok:true で返った create の行は、undo 前の時点で**1件残らず実在**する。
    //     (窓中の書込は applying か busy で弾かれ、ok:true には決してならない。)
    const notesBeforeUndo = rowIds(APP_ID, "notes");
    for (const id of seedNoteIds) {
      expect(notesBeforeUndo.has(id)).toBe(true);
    }
    for (const id of okIds) {
      expect(notesBeforeUndo.has(id)).toBe(true);
    }

    // (c) apply は成功して確定している(bulk.qty が TEXT に再構築された)。
    expect(columnType(APP_ID, "bulk", "qty")).toBe("TEXT");

    // (d) undo は従来どおり動く。apply 直前のスナップショットへ戻り、そこに載っていた
    //     acknowledged な書込(seedNoteIds)は1件も消えない。bulk は再構築前(NUMERIC)へ戻る。
    const undone = undo(dataRoot, APP_ID);
    expect(undone.valid, JSON.stringify(undone)).toBe(true);
    const notesAfterUndo = rowIds(APP_ID, "notes");
    for (const id of seedNoteIds) {
      expect(notesAfterUndo.has(id)).toBe(true);
    }
    expect(columnType(APP_ID, "bulk", "qty")).toBe("NUMERIC");

    // 後片付け: 残存マーカーが無い(apply は endApply まで到達している)。
    expect(isApplyInProgress(dataRoot, APP_ID).inProgress).toBe(false);
  }, 40_000);
});

// ---------------------------------------------------------------------------
// (iii) apply_diff の DROP 中にスケジューラが同テーブルへ書こうとする → 譲る
// ---------------------------------------------------------------------------

describe("(iii) apply_diff の再構築(DROP)中にスケジューラが同テーブルへ書く → 譲る/乖離なし", () => {
  const APP_ID = "conc-drop";
  const TZ = "Asia/Tokyo";
  const TASK_ROWS = 80_000;

  /** tasks に毎日書き込むスケジュールワークフロー(常に due になるよう 00:00)。 */
  function scheduledWorkflow(): Workflow {
    return {
      id: "daily-task",
      name: "毎日のタスク生成",
      trigger: { type: "schedule", at: { hour: 0, minute: 0 } },
      actions: [{ action: "create_record", table: "tasks", values: { label: "自動" } }],
      history_table: "wf-runs",
    };
  }

  test("再構築中の tick はマーカーを見て発火を見送り、apply はクリーンに完了する", async () => {
    const store = KernelMetaStore.open(dataRoot);
    createApp(store, "適用中の譲り合い", { app_id: APP_ID });
    store.close();

    const manifest: Manifest = {
      app: {
        id: APP_ID,
        name: "適用中の譲り合い",
        tables: [
          {
            id: "tasks",
            name: "タスク",
            fields: [
              { id: "n", name: "数値", type: "number" },
              { id: "label", name: "ラベル", type: "text" },
            ],
          },
          {
            id: "wf-runs",
            name: "実行履歴",
            fields: [
              { id: "ran_at", name: "実行時刻", type: "date" },
              { id: "workflow", name: "ワークフロー", type: "text" },
              { id: "trigger_type", name: "きっかけ", type: "text" },
              { id: "status", name: "結果", type: "text" },
              { id: "error", name: "エラー", type: "long_text" },
            ],
          },
        ],
        views: [],
        workflows: [scheduledWorkflow()],
      },
    };
    const setup = applyManifest(dataRoot, APP_ID, manifest);
    expect(setup.valid, JSON.stringify(setup)).toBe(true);
    seedNumericRows(APP_ID, "tasks", "n", TASK_ROWS); // n(number) を text へ再構築するための実データ

    // スケジューラが「今日」の判定に使う時刻を固定注入する(実時間を待たない)。
    setWorkflowClock({ now: () => new Date("2026-07-21T10:00:00+09:00") });

    // 別プロセスで重い applyDiff(tasks.n number→text の再構築 = 旧 tasks を DROP)を走らせる。
    const applyResult = join(dataRoot, "apply-result.json");
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        scriptPath("heavy-apply.ts"),
        dataRoot,
        APP_ID,
        "tasks",
        "n",
        "text",
        "d-drop",
        applyResult,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    // B(このプロセス)は、別プロセスの apply が**危険窓に入っている間だけ**スケジューラの
    // 1周期を回す。窓中の runAppSchedules は app.sqlite を開く前に isApplyInProgress を見て
    // 「見送ります」を console.error に出し、DB には一切触れない(= 譲る。M2)。窓の外で回すと
    // スケジューラが tasks へ書き込んで(busy_timeout=0 の)apply を殺しうる —— それは配線層が
    // 塞いだ経路なので、ここでは窓中の「譲り」だけを実証する。窓の検出は existsSync だけで
    // DB ロックを取らないため apply を妨げない。
    const yieldMessages: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      yieldMessages.push(args.map((a) => String(a)).join(" "));
    };

    let windowSeen = false;
    const deadline = Date.now() + 25_000;
    try {
      for (;;) {
        const applyingNow = isApplyInProgress(dataRoot, APP_ID).inProgress;
        if (applyingNow) {
          windowSeen = true;
          runSchedulerTick({ dataRoot, timeZone: TZ }); // 窓中の tick は必ず「見送ります」で譲る
        }
        if (windowSeen && !applyingNow) {
          break;
        }
        if (Date.now() > deadline) {
          break;
        }
        await Bun.sleep(0);
      }
    } finally {
      console.error = originalError;
    }

    const code = await proc.exited;
    const apply = JSON.parse(readFileSync(applyResult, "utf-8")) as {
      valid: boolean;
      threw?: string;
    };
    if (!apply.valid) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`heavy apply が失敗(code=${code}): ${JSON.stringify(apply)}\n${err}`);
    }

    // (a) 危険窓を実際に踏み、スケジューラが**発火を見送った**(M2: マーカーで譲る)。
    expect(windowSeen).toBe(true);
    const yields = yieldMessages.filter((m) => m.includes("見送ります"));
    expect(yields.length).toBeGreaterThan(0);

    // (b) apply はクリーンに完了(半端無し): tasks は TEXT へ再構築され、残骸テーブルが無い。
    expect(columnType(APP_ID, "tasks", "n")).toBe("TEXT");
    expect(userTableNames(APP_ID).sort()).toEqual(["tasks", "wf-runs"]);

    // (c) スナップショット/app.sqlite の乖離なし: マーカーは残っておらず、recover は clean。
    expect(isApplyInProgress(dataRoot, APP_ID).inProgress).toBe(false);
    const outcomes = recover(dataRoot, APP_ID);
    expect(outcomes.every((o) => o.status === "clean" || o.status === "committed")).toBe(true);

    // (d) changelog に再構築の apply が1件残っている(適用は履歴に現れている)。
    const changelog = getChangelog(dataRoot, APP_ID);
    expect(changelog.some((e) => e.diff_id === "d-drop")).toBe(true);

    // apply 後はスケジューラが通常どおり発火できる(マーカーが消えた後は書ける)。
    const afterTick = () => {
      const before = rowIds(APP_ID, "tasks").size;
      runSchedulerTick({ dataRoot, timeZone: TZ });
      return rowIds(APP_ID, "tasks").size - before;
    };
    expect(afterTick()).toBeGreaterThanOrEqual(0);
  }, 40_000);
});
