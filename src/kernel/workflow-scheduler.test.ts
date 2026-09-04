import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYSTEM_TABLES } from "../shared/system-tables.ts";
import { applyDiff } from "./apply-diff.ts";
import { applyManifest as applyManifestRaw } from "./apply-manifest.ts";
import {
  armOwnerColumns,
  FIXTURE_ACTOR_ID,
  grantOwnerAllTables,
  isFixtureOwnerTable,
  OWNER_FIELD,
  seedAutomationActor,
} from "./automation-actor-fixture.test.ts";
import type { Clock } from "./clock.ts";
import { createApp, emptyManifest } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import {
  createRecord as createRecordRaw,
  deleteRecord,
  listRecords,
  type RecordRow,
} from "./records.ts";
import { beginApply, endApply } from "./recovery.ts";
import { appDbPath, appDir, appManifestPath, appSnapshotsDir } from "./storage-paths.ts";
import type { Manifest, Workflow } from "./types.ts";
import { undo } from "./undo.ts";
import { resetWorkflowClock, setWorkflowClock, WORKFLOW_MAX_DEPTH } from "./workflow-runner.ts";
import { runSchedulerTick, startWorkflowScheduler } from "./workflow-scheduler.ts";

/**
 * `schedule` トリガーの実行基盤(V1-M2-T08 単位2 / ADR-0013 §6)の検査。
 *
 * ## **実時間を1ミリ秒も待たない**
 *
 * 計画 `docs/plan/v1/02-workflow.md:165` の絶対条件である。時刻は
 * `setWorkflowClock` で注入し、**テストが `now` を書き換えることで進める。**
 * `setTimeout` / `setInterval` の発火を待つテストは1本も無い —— タイマーは
 * 「`runSchedulerTick` を周期的に呼ぶ」だけの薄い層であり、**中身の検査は
 * `runSchedulerTick` を直接呼んで行う。**
 *
 * ## モックを置かない
 *
 * 実ディスクの `kernel.sqlite` / `app.sqlite` / `manifest.json` を使う。
 * 差し替えるのは時刻源だけで、これは `workflow-runner.test.ts` と同じ作法である。
 */

const APP_ID = "book-tracker";
/** 判断1 の既定。**「今日」の境界もこの TZ で決まる**(ADR-0013 §6c)。 */
const TZ = "Asia/Tokyo";
/**
 * 上限(1000 行)に触るテストだけに与える明示のタイムアウト(V3-M12-T01)。
 *
 * **bun:test の既定は 5000ms である。** `docs/evidence/cp-v3-ec.md` §9-1a の実 CI
 * ログは、このファイルの同型テスト2本が既定 5000ms を超えて **7124.06ms** /
 * **11886.83ms** で失敗したことを記録している(コード差分は0で、ランナーが遅い
 * 日に実際に落ちた)。**値は最大実測値の約10倍**(11886.83ms × 10 ≈
 * 118868.3ms)を安全側の余白として切り上げたものである。**時間を検査している
 * わけではない** —— 閾値をアサーションに書くと実行環境で揺れるので、書いたのは
 * 「落ちないための上限」だけである。先例(名前付き定数 + 由来のコメントの形)は
 * `scripts/ref-ec/manifest.test.ts` の `HEAVY_ROW_TEST_TIMEOUT_MS`。
 */
const HEAVY_ROW_TEST_TIMEOUT_MS = 120000;

function historyFields() {
  return [
    { id: "ran_at", name: "実行時刻", type: "date" as const },
    { id: "workflow", name: "ワークフロー", type: "text" as const },
    { id: "trigger_type", name: "きっかけ", type: "text" as const },
    { id: "status", name: "結果", type: "text" as const },
    { id: "error", name: "エラー", type: "long_text" as const },
  ];
}

/** 毎日 09:00 に通知を1件作るワークフロー。 */
function dailyNotify(hour = 9, minute = 0, id = "daily-summary"): Workflow {
  return {
    id,
    name: "毎日のまとめ",
    trigger: { type: "schedule", at: { hour, minute } },
    actions: [
      {
        action: "create_record",
        table: "notifications",
        values: { title: "本日のまとめ", source: "daily" },
      },
    ],
    history_table: "wf-runs",
  };
}

function manifestWith(workflows: Workflow[], appId = APP_ID): Manifest {
  return {
    app: {
      id: appId,
      name: "蔵書管理",
      tables: [
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
          // `must` が required なので、値を与えない書き込みは**必ず失敗する**。
          fields: [
            { id: "must", name: "必須", type: "text", required: true },
            { id: "note", name: "メモ", type: "text" },
          ],
        },
        { id: "wf-runs", name: "実行履歴", fields: historyFields() },
        {
          id: "broken-runs",
          name: "壊れた実行履歴",
          /*
           * **V1-M2-T05a D1 で、ここは規約どおりの5列に直した。**
           * それまでは `workflow` 列を落とした形をそのまま `applyManifest` に通していたが、
           * **D1 の列構成検査が入ったので、この形はもうマニフェストとして受理されない。**
           * 壊れた状態は当該テストが `breakHistoryTable()` でディスク上に直接作る ——
           * **実行時の防御を消したのではなく、適用時の入口を1つ塞いだだけである。**
           * MCP 経由以外でマニフェストが入る余地がある以上、防御は二重に置く
           * (`referential-integrity.ts` 類型7 と同じ方針)。
           */
          fields: historyFields(),
        },
      ],
      views: [],
      workflows,
    },
  };
}

let dataRoot: string;
let store: KernelMetaStore;
/** 注入した「現在の瞬間」。テストはこれを書き換えて時間を進める。 */
let instant: Date;
const clock: Clock = { now: () => new Date(instant) };

/** JST の壁時計で時刻を置く。**テストの意図が読めるように必ず +09:00 で書く。** */
function setNow(jst: string): void {
  instant = new Date(jst);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`テストの時刻指定が不正です: ${jst}`);
  }
}

function install(workflows: Workflow[], appId = APP_ID): void {
  const applied = applyManifest(dataRoot, appId, manifestWith(workflows, appId));
  if (!applied.valid) {
    throw new Error(
      `テスト前提のマニフェスト投入に失敗しました: ${JSON.stringify(applied.errors)}`,
    );
  }
}

/**
 * `archived` なアプリを作る。
 *
 * **`createApp` を使えない** —— `createApp` は必ず `status: "active"` で台帳に登録し、
 * **本番に `archived` へ遷移させる経路は1つも存在しない**(`RegisterAppInput.status?` が
 * 唯一の入口。`meta-store.ts:44-49`)。そこで台帳へ直接 `archived` で登録し、
 * ディスク側の実体は `createApp` と同じ形を手で組む。
 * **到達しない状態に対する防御であることは、記録に限界として明記してある。**
 */
function installArchived(appId: string, workflows: Workflow[]): void {
  store.registerApp({ app_id: appId, name: "凍結アプリ", status: "archived" });
  mkdirSync(appSnapshotsDir(dataRoot, appId), { recursive: true });
  new Database(appDbPath(dataRoot, appId), { create: true }).close();
  writeFileSync(
    appManifestPath(dataRoot, appId),
    JSON.stringify(emptyManifest(appId, "凍結アプリ")),
    "utf-8",
  );
  install(workflows, appId);
}

/**
 * ディスク上のマニフェストから、履歴テーブルの列を1つ抜き取る(V1-M2-T05a D1)。
 *
 * **`applyManifest` を通さない**のが要点である。D1 の列構成検査は適用時に働くので、
 * 壊れた履歴テーブルはもう `apply_diff` / `applyManifest` からは作れない。
 * それでも**実行時に壊れた状態へ出くわす経路は残る** —— 手で編集されたマニフェスト、
 * 古いデータ、将来の別経路。ここはその状況を再現して、実行エンジンが
 * **投げず・黙らず・副作用も積まない**ことを見るためのものである。
 *
 * 直接書き込みの作法はこのファイルの既存テスト(壊れた JSON を書く / マニフェストを
 * 差し替える)に揃えてある。
 */
function breakHistoryTable(tableId: string, fieldId: string): void {
  const manifest = JSON.parse(readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8")) as Manifest;
  const table = manifest.app.tables.find((candidate) => candidate.id === tableId);
  if (table === undefined) {
    throw new Error(`テスト前提: テーブル ${tableId} が見つかりません`);
  }
  table.fields = table.fields.filter((field) => field.id !== fieldId);
  writeFileSync(appManifestPath(dataRoot, APP_ID), JSON.stringify(manifest), "utf-8");
}

function tick(): void {
  runSchedulerTick({ dataRoot, timeZone: TZ });
}

/*
 * --- **【`V8-M26`(2026-08-10)で題材に「壁を開ける下ごしらえ」が入った】** -------------
 *
 * **`V8-M26-T03` が面(役割に束ねた権限)の既定を「閉じる」側へ倒した。**
 * **時刻起動そのものは今日も面を通らない**(素通り)—— **止まったのは、時刻起動が
 * **始めた連鎖**(`on_create` / `on_update` の側)である。**
 * **連鎖が続くことが主題の検査(深度上限 / 再発火抑止)が5件それで赤くなったので、
 * 題材の側で壁を開ける** —— **実装は1バイトも緩めていない。**
 *
 * **中身は `src/kernel/automation-actor-fixture.test.ts` の doc に全部書いた。**
 */

/** マニフェストに持ち主の列・規則・アクションの書き手を入れる。 */
function armSchedulerAccess(target: Manifest): void {
  armOwnerColumns(target);
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

/** マニフェストを投入する直前に壁を開け、投入した直後に書き手を1人立てる。 */
function applyManifest(
  root: string,
  appId: string,
  target: Manifest,
): ReturnType<typeof applyManifestRaw> {
  armSchedulerAccess(target);
  const applied = applyManifestRaw(root, appId, target);
  if (applied.valid) {
    const db = new Database(appDbPath(root, appId), { readwrite: true, create: false });
    try {
      seedAutomationActor(db);
    } finally {
      db.close();
    }
  }
  return applied;
}

/**
 * 行を作る。**この下ごしらえが持ち主の列を足したテーブルにだけ、書き手を既定で入れる。**
 * **これが無いと、その行が起こす連鎖の書き手が `null` になって連鎖が1段目で止まる。**
 */
function createRecord(
  database: Database,
  target: Manifest,
  tableId: string,
  values: Record<string, unknown>,
): ReturnType<typeof createRecordRaw> {
  const filled =
    isFixtureOwnerTable(target, tableId) && values[OWNER_FIELD.id] === undefined
      ? { ...values, [OWNER_FIELD.id]: FIXTURE_ACTOR_ID }
      : values;
  return createRecordRaw(database, target, tableId, filled);
}

function withDb<T>(run: (db: Database) => T, appId = APP_ID): T {
  const db = new Database(appDbPath(dataRoot, appId), { readwrite: true, create: false });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function rowsOf(tableId: string, appId = APP_ID): RecordRow[] {
  return withDb((db) => {
    const result = listRecords(db, currentManifest(appId), tableId);
    if (!result.ok) {
      throw new Error(`読み出しに失敗しました: ${JSON.stringify(result.errors)}`);
    }
    return result.value;
  }, appId);
}

/** ディスク上の現行マニフェスト(読み出しの列解決に使う)。 */
function currentManifest(appId = APP_ID): Manifest {
  return JSON.parse(readFileSync(appManifestPath(dataRoot, appId), "utf-8")) as Manifest;
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-workflow-scheduler-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "蔵書管理", { app_id: APP_ID });
  setNow("2026-07-20T00:00:00+09:00");
  setWorkflowClock(clock);
});

afterEach(async () => {
  resetWorkflowClock();
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 完了条件3: 時刻到来で発火し、履歴に残る
// ---------------------------------------------------------------------------

describe("完了条件3: schedule トリガーが時刻到来で発火し、履歴に残る", () => {
  test("発火時刻の前は1行も書かれない", () => {
    install([dailyNotify(9, 0)]);
    setNow("2026-07-20T08:59:00+09:00");
    tick();

    expect(rowsOf("notifications")).toHaveLength(0);
    expect(rowsOf("wf-runs")).toHaveLength(0);
  });

  test("発火時刻に到達するとアクションが実行され、履歴に1行残る", () => {
    install([dailyNotify(9, 0)]);
    setNow("2026-07-20T09:00:00+09:00");
    tick();

    const notifications = rowsOf("notifications");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.title).toBe("本日のまとめ");

    const history = rowsOf("wf-runs");
    expect(history).toHaveLength(1);
    expect(history[0]?.workflow).toBe("daily-summary");
    // **`trigger_type` に "schedule" が入る。列は増えていない。**
    expect(history[0]?.trigger_type).toBe("schedule");
    expect(history[0]?.status).toBe("success");
    expect(history[0]?.error).toBeNull();
    // **`ran_at` は注入した時刻から来ている**(単位1 の時刻源を通っている証拠)。
    expect(history[0]?.ran_at).toBe(instant.toISOString());
  });

  test("同じ日に何度 tick しても、発火は1回きりである", () => {
    install([dailyNotify(9, 0)]);
    setNow("2026-07-20T09:00:00+09:00");
    tick();
    setNow("2026-07-20T09:00:30+09:00");
    tick();
    setNow("2026-07-20T18:00:00+09:00");
    tick();
    setNow("2026-07-20T23:59:00+09:00");
    tick();

    expect(rowsOf("notifications")).toHaveLength(1);
    expect(rowsOf("wf-runs")).toHaveLength(1);
  });

  test("日が変われば再び発火する(毎日1回)", () => {
    install([dailyNotify(9, 0)]);
    setNow("2026-07-20T09:00:00+09:00");
    tick();
    setNow("2026-07-21T09:00:00+09:00");
    tick();
    setNow("2026-07-22T09:00:00+09:00");
    tick();

    expect(rowsOf("notifications")).toHaveLength(3);
    expect(rowsOf("wf-runs")).toHaveLength(3);
  });

  test("複数のワークフローは、それぞれの時刻で独立に発火する", () => {
    install([dailyNotify(9, 0, "morning"), dailyNotify(18, 0, "evening")]);
    setNow("2026-07-20T09:30:00+09:00");
    tick();
    expect(rowsOf("wf-runs").map((row) => row.workflow)).toEqual(["morning"]);

    setNow("2026-07-20T18:00:00+09:00");
    tick();
    expect(
      rowsOf("wf-runs")
        .map((row) => row.workflow)
        .sort(),
    ).toEqual(["evening", "morning"]);
  });

  test("失敗した発火も履歴に残り、その日は再実行されない", () => {
    // **必須フィールドを与えないアクション。**参照整合性は通る(テーブルもフィールドも
    // 実在する)が、実行時に `validateInput` が拒否するので、発火は必ず失敗する。
    install([
      {
        ...dailyNotify(9, 0),
        actions: [{ action: "create_record", table: "strict", values: { note: "毎日" } }],
      },
    ]);

    setNow("2026-07-20T09:00:00+09:00");
    tick();
    setNow("2026-07-20T09:01:00+09:00");
    tick();

    const history = rowsOf("wf-runs");
    expect(history).toHaveLength(1);
    expect(history[0]?.status).toBe("failure");
    // **失敗も「発火済み」である。**同じ日に何度も副作用を積み直さない。
    expect(rowsOf("notifications")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 完了条件4: T03 の深度制限・再発火抑止の対象である
// ---------------------------------------------------------------------------

describe("完了条件4: スケジュール発火も深度制限の対象である", () => {
  test("schedule が始めた連鎖も WORKFLOW_MAX_DEPTH で止まり、失敗として履歴に残る", () => {
    // `chain` テーブルへの create が自分自身への create を呼ぶ(無限連鎖)。
    const manifest = manifestWith([]);
    manifest.app.tables.push({
      id: "chain",
      name: "連鎖",
      fields: [{ id: "note", name: "メモ", type: "text" }],
    });
    manifest.app.workflows = [
      {
        id: "kickoff",
        name: "スケジュールで連鎖を始める",
        trigger: { type: "schedule", at: { hour: 9, minute: 0 } },
        actions: [{ action: "create_record", table: "chain", values: { note: "seed" } }],
        history_table: "wf-runs",
      },
      {
        id: "self-chain",
        name: "自分自身を作り続ける",
        trigger: { type: "on_create", table: "chain" },
        actions: [{ action: "create_record", table: "chain", values: { note: "again" } }],
        history_table: "wf-runs",
      },
    ];
    const applied = applyManifest(dataRoot, APP_ID, manifest);
    expect(applied.valid).toBe(true);

    setNow("2026-07-20T09:00:00+09:00");
    tick();

    // **暴走せずに止まっている。**行数は深度上限から機械的に導く(定数を直書きしない)。
    // 【V3-M13-T02 / ADR-0066 による期待値の更新】上限到達は「失敗」になったので(限定16)、
    // **連鎖が書いた行は1行も残らない**(以前は 1..MAX 行が残っていた)。
    // 上限で止まったこと自体は履歴の failure で読める(`schedule` の履歴は巻き戻らない)。
    const chain = rowsOf("chain");
    expect(chain.length).toBeLessThanOrEqual(WORKFLOW_MAX_DEPTH);
    expect(chain).toHaveLength(0);

    // **黙って止まっていない。**上限到達が failure として履歴に残っている。
    const history = rowsOf("wf-runs");
    const stopped = history.filter((row) => row.status === "failure");
    expect(stopped.length).toBeGreaterThan(0);
    expect(String(stopped[0]?.error)).toContain(String(WORKFLOW_MAX_DEPTH));

    // schedule の発火そのものも履歴に残っている(限定7: `schedule` は巻き戻らない)。
    expect(history.some((row) => row.trigger_type === "schedule")).toBe(true);
  });

  test("深度カウンタは発火のたびに戻る(2日目も同じだけ走る)", () => {
    const manifest = manifestWith([]);
    manifest.app.tables.push({
      id: "chain",
      name: "連鎖",
      fields: [{ id: "note", name: "メモ", type: "text" }],
    });
    manifest.app.workflows = [
      {
        id: "kickoff",
        name: "スケジュールで連鎖を始める",
        trigger: { type: "schedule", at: { hour: 9, minute: 0 } },
        actions: [{ action: "create_record", table: "chain", values: { note: "seed" } }],
        history_table: "wf-runs",
      },
      {
        id: "self-chain",
        name: "自分自身を作り続ける",
        trigger: { type: "on_create", table: "chain" },
        actions: [{ action: "create_record", table: "chain", values: { note: "again" } }],
        history_table: "wf-runs",
      },
    ];
    applyManifest(dataRoot, APP_ID, manifest);

    setNow("2026-07-20T09:00:00+09:00");
    tick();
    const firstDay = rowsOf("chain").length;

    setNow("2026-07-21T09:00:00+09:00");
    tick();
    const secondDay = rowsOf("chain").length - firstDay;

    // **深度が戻っていなければ2日目は1行も進まない。**同じだけ進むことが復帰の証拠。
    expect(secondDay).toBe(firstDay);
  });
});

// ---------------------------------------------------------------------------
// 完了条件5: タイマーの失敗でサーバが止まらない
// ---------------------------------------------------------------------------

describe("完了条件5: tick は何があっても例外を投げない", () => {
  test("データルートが存在しなくても投げない", () => {
    expect(() => {
      runSchedulerTick({ dataRoot: join(dataRoot, "no", "such", "root"), timeZone: TZ });
    }).not.toThrow();
  });

  test("台帳にあるアプリの manifest.json が消えていても投げない(他のアプリは発火する)", () => {
    install([dailyNotify(9, 0)]);
    const broken = "broken-app";
    createApp(store, "壊れたアプリ", { app_id: broken });
    install([dailyNotify(9, 0)], broken);
    rmSync(appManifestPath(dataRoot, broken));

    setNow("2026-07-20T09:00:00+09:00");
    expect(() => {
      tick();
    }).not.toThrow();

    // **1つ壊れていても、他のアプリの発火は止まらない。**
    expect(rowsOf("wf-runs")).toHaveLength(1);
  });

  test("app.sqlite が消えていても投げない", () => {
    install([dailyNotify(9, 0)]);
    rmSync(appDbPath(dataRoot, APP_ID));

    setNow("2026-07-20T09:00:00+09:00");
    expect(() => {
      tick();
    }).not.toThrow();
  });

  test("manifest.json が壊れた JSON でも投げない", () => {
    install([dailyNotify(9, 0)]);
    writeFileSync(appManifestPath(dataRoot, APP_ID), "{ 壊れた JSON", "utf-8");

    setNow("2026-07-20T09:00:00+09:00");
    expect(() => {
      tick();
    }).not.toThrow();
  });

  test("履歴テーブルに workflow 列が無くても投げず、発火もしない(黙らない)", () => {
    install([{ ...dailyNotify(9, 0), history_table: "broken-runs" }]);
    // **適用時の検査(V1-M2-T05a D1)を通した後で、ディスク上のマニフェストを壊す。**
    // 適用時に拒否できるようになっても、実行時の防御は残っていなければならない。
    breakHistoryTable("broken-runs", "workflow");
    setNow("2026-07-20T09:00:00+09:00");

    const messages: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      messages.push(args.map(String).join(" "));
    };
    try {
      expect(() => {
        tick();
      }).not.toThrow();
    } finally {
      console.error = original;
    }

    // **発火済みか判定できないなら発火しない。**毎 tick 実行して副作用を積むより落ち着く方。
    expect(rowsOf("notifications")).toHaveLength(0);
    // **黙って止まらない**(憲法6)。理由が診断に出る。
    expect(messages.join("\n")).toContain("daily-summary");
  });

  test("startWorkflowScheduler は壊れたデータルートでも投げず、stop() できる", () => {
    const handle = startWorkflowScheduler({
      dataRoot: join(dataRoot, "no", "such", "root"),
      timeZone: TZ,
    });
    expect(() => {
      handle.stop();
    }).not.toThrow();
    // 二重停止も投げない(サーバ側が finally で呼んでも壊れない)。
    expect(() => {
      handle.stop();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 完了条件6 / 10: 登録簿を持たない / 発火済み状態の置き場
// ---------------------------------------------------------------------------

describe("完了条件6: カーネルがスケジュールの登録簿を持たない", () => {
  test("何度発火しても kernel.sqlite のテーブルは apps / changelog のままである", () => {
    install([dailyNotify(9, 0)]);
    const before = kernelTables();

    setNow("2026-07-20T09:00:00+09:00");
    tick();
    setNow("2026-07-21T09:00:00+09:00");
    tick();

    expect(kernelTables()).toEqual(before);
    expect(before).toContain("apps");
    expect(before).toContain("changelog");
    // **発火済み台帳らしきものが1つも無い。**
    expect(before.some((name) => /schedul|fire|workflow/i.test(name))).toBe(false);
  });

  test("発火してもアプリのディレクトリに新しいファイルが増えない", () => {
    install([dailyNotify(9, 0)]);
    const before = readdirSync(appDir(dataRoot, APP_ID)).sort();

    setNow("2026-07-20T09:00:00+09:00");
    tick();

    expect(readdirSync(appDir(dataRoot, APP_ID)).sort()).toEqual(before);
  });

  test("マニフェストからワークフローを消すと、登録解除なしに発火が止まる", () => {
    install([dailyNotify(9, 0)]);
    setNow("2026-07-20T09:00:00+09:00");
    tick();
    expect(rowsOf("wf-runs")).toHaveLength(1);

    // **カーネルには何も伝えない。**マニフェストを差し替えるだけ。
    writeFileSync(appManifestPath(dataRoot, APP_ID), JSON.stringify(manifestWith([])), "utf-8");
    setNow("2026-07-21T09:00:00+09:00");
    tick();

    expect(rowsOf("wf-runs")).toHaveLength(1);
  });
});

describe("完了条件10: 発火済み状態は実行履歴テーブルにしかない", () => {
  test("履歴の行を消すと同じ日に再び発火する(ADR-0013 §6c 代償2 そのもの)", () => {
    install([dailyNotify(9, 0)]);
    setNow("2026-07-20T09:00:00+09:00");
    tick();
    const history = rowsOf("wf-runs");
    expect(history).toHaveLength(1);

    // ユーザは履歴を `delete_record` で消せる。消すと「未発火」に戻る。
    withDb((db) => {
      const result = deleteRecord(
        db,
        manifestWith([dailyNotify(9, 0)]),
        "wf-runs",
        history[0]?._id as string,
      );
      expect(result.ok).toBe(true);
    });

    setNow("2026-07-20T09:05:00+09:00");
    tick();

    // **二重発火する。**これは隠さず申告した代償であり、テストで固定しておく。
    expect(rowsOf("notifications")).toHaveLength(2);
  });

  test("プロセスを跨いでも発火済み判定は履歴だけから導かれる", () => {
    install([dailyNotify(9, 0)]);
    setNow("2026-07-20T09:00:00+09:00");
    tick();

    // **プロセス内の状態を1つも引き継がない**別の tick 呼び出しでも、二重に発火しない。
    // (`runSchedulerTick` はモジュールスコープに発火済みの記憶を持たない。)
    setNow("2026-07-20T09:10:00+09:00");
    runSchedulerTick({ dataRoot, timeZone: TZ });
    expect(rowsOf("notifications")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 完了条件7: スケジュール情報の変更が、再登録なしに次の発火から反映される
// ---------------------------------------------------------------------------

describe("完了条件7: スケジュール情報の変更が再登録なしに反映される", () => {
  test("発火時刻を早めると、同じ tick 呼び出し列の中で反映される", () => {
    install([dailyNotify(9, 0)]);
    setNow("2026-07-20T07:00:00+09:00");
    tick();
    expect(rowsOf("wf-runs")).toHaveLength(0);

    // **スケジューラを止めも再起動もしない。**マニフェストを差し替えるだけ。
    writeFileSync(
      appManifestPath(dataRoot, APP_ID),
      JSON.stringify(manifestWith([dailyNotify(6, 30)])),
      "utf-8",
    );
    tick();

    expect(rowsOf("wf-runs")).toHaveLength(1);
    expect(rowsOf("notifications")).toHaveLength(1);
  });

  test("発火時刻を遅らせると、その日はもう発火しない", () => {
    install([dailyNotify(9, 0)]);
    setNow("2026-07-20T08:00:00+09:00");
    tick();
    writeFileSync(
      appManifestPath(dataRoot, APP_ID),
      JSON.stringify(manifestWith([dailyNotify(23, 0)])),
      "utf-8",
    );
    setNow("2026-07-20T09:30:00+09:00");
    tick();

    expect(rowsOf("wf-runs")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 完了条件8: archived なアプリは発火しない
// ---------------------------------------------------------------------------

describe("完了条件8: archived なアプリのワークフローは発火しない", () => {
  test("status = archived で登録したアプリは、時刻が来ても発火しない", () => {
    // **本番に archived へ遷移させる経路は1つも無い**(`RegisterAppInput.status` だけ)。
    // 到達しない状態に対する防御であることを、記録に限界として明記してある。
    const archived = "archived-app";
    installArchived(archived, [dailyNotify(9, 0)]);

    setNow("2026-07-20T09:00:00+09:00");
    tick();

    expect(rowsOf("wf-runs", archived)).toHaveLength(0);
    expect(rowsOf("notifications", archived)).toHaveLength(0);
  });

  test("active なアプリと archived なアプリが並んでいても、active だけが発火する", () => {
    install([dailyNotify(9, 0)]);
    const archived = "archived-app";
    installArchived(archived, [dailyNotify(9, 0)]);

    setNow("2026-07-20T09:00:00+09:00");
    tick();

    expect(rowsOf("wf-runs")).toHaveLength(1);
    expect(rowsOf("wf-runs", archived)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 完了条件9: undo でスケジュール情報が戻ったら発火も戻る
// ---------------------------------------------------------------------------

describe("完了条件9: undo でスケジュール情報が戻れば発火も戻る", () => {
  test("発火時刻を変える差分を undo すると、元の時刻で発火する", () => {
    install([dailyNotify(9, 0)]);

    const applied = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-move-schedule",
      intent: "まとめの時刻を 22 時に移す",
      operations: [
        {
          op: "update_workflow",
          workflow: {
            ...dailyNotify(22, 0),
          },
        },
      ],
    });
    expect(applied.valid).toBe(true);

    // 変更後の時刻では、9時台に発火しない。
    setNow("2026-07-20T09:30:00+09:00");
    tick();
    expect(rowsOf("wf-runs")).toHaveLength(0);

    // **undo する。**`manifest.json` が戻るので、発火の根拠も戻る。
    const undone = undo(dataRoot, APP_ID);
    expect(undone.valid).toBe(true);

    setNow("2026-07-20T09:31:00+09:00");
    tick();
    expect(rowsOf("wf-runs")).toHaveLength(1);
    expect(rowsOf("notifications")).toHaveLength(1);
  });

  test("undo は履歴も戻すので、発火済み判定も一緒に戻る", () => {
    install([dailyNotify(9, 0)]);

    // **差分を先に当てる。**この時点でスナップショットが取られる(まだ未発火)。
    const applied = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-add-field",
      intent: "通知に本文を足す",
      operations: [
        {
          op: "add_field",
          table: "notifications",
          field: { id: "body", name: "本文", type: "long_text" },
        },
      ],
    });
    expect(applied.valid).toBe(true);

    setNow("2026-07-20T09:00:00+09:00");
    tick();
    expect(rowsOf("wf-runs")).toHaveLength(1);
    expect(rowsOf("notifications")).toHaveLength(1);

    // **undo は `app.sqlite` をスナップショットへ戻す。**発火より前の状態なので、
    // 履歴行も通知行も消える —— **発火済み判定は履歴にしか無い**ので、一緒に戻る。
    const undone = undo(dataRoot, APP_ID);
    expect(undone.valid).toBe(true);
    expect(rowsOf("wf-runs")).toHaveLength(0);
    expect(rowsOf("notifications")).toHaveLength(0);

    // 未発火に戻ったので、同じ日でも再び発火する。
    setNow("2026-07-20T09:20:00+09:00");
    tick();
    expect(rowsOf("wf-runs")).toHaveLength(1);
    expect(rowsOf("notifications")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 完了条件11: サーバ停止中に到来した発火時刻の扱い
// ---------------------------------------------------------------------------

describe("完了条件11: 停止中に到来した発火時刻(判断2)", () => {
  test("同じ日のうちなら、時刻を跨いで観測しなくても遅れて発火する", () => {
    install([dailyNotify(9, 0)]);
    // **09:00 を1度も観測しない。**08:00 の次が 14:00(その間サーバは止まっていた)。
    setNow("2026-07-20T08:00:00+09:00");
    tick();
    expect(rowsOf("wf-runs")).toHaveLength(0);

    setNow("2026-07-20T14:00:00+09:00");
    tick();
    expect(rowsOf("wf-runs")).toHaveLength(1);
    expect(rowsOf("notifications")).toHaveLength(1);
  });

  test("日をまたいだ分は失われる(取り戻しはしない)", () => {
    install([dailyNotify(9, 0)]);
    // 7/20 09:00 と 7/21 09:00 の2回が到来したが、起きているのは 7/22 の 10:00 だけ。
    setNow("2026-07-22T10:00:00+09:00");
    tick();

    // **2回ぶんまとめて発火しない。1回だけである。**
    expect(rowsOf("wf-runs")).toHaveLength(1);
    expect(rowsOf("notifications")).toHaveLength(1);
  });

  test("その日の発火時刻より前に起きたなら、時刻が来るまで発火しない", () => {
    install([dailyNotify(9, 0)]);
    setNow("2026-07-22T00:00:00+09:00");
    tick();
    expect(rowsOf("wf-runs")).toHaveLength(0);
  });

  test("日付の境界は ST_TIMEZONE で決まる(UTC ではない)", () => {
    install([dailyNotify(0, 30)]);
    // JST 7/21 00:30 は UTC ではまだ 7/20 15:30 である。
    setNow("2026-07-21T00:30:00+09:00");
    tick();
    expect(rowsOf("wf-runs")).toHaveLength(1);

    // JST で日が変わるまでは再発火しない(UTC 基準なら 7/21 09:00 JST で日が変わってしまう)。
    setNow("2026-07-21T10:00:00+09:00");
    tick();
    expect(rowsOf("wf-runs")).toHaveLength(1);

    // JST で翌日になったら発火する。
    setNow("2026-07-22T00:30:00+09:00");
    tick();
    expect(rowsOf("wf-runs")).toHaveLength(2);
  });
});

/** `kernel.sqlite` のユーザテーブル名(SQLite 内部テーブルを除く)。 */
function kernelTables(): string[] {
  const db = new Database(join(dataRoot, "kernel.sqlite"), { readwrite: true, create: false });
  try {
    return db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

/** `existsSync` を使う検査が1本も無くならないように(将来の削除の歯止め)。 */
test("テスト前提: アプリの実体が実ディスクにある", () => {
  install([dailyNotify(9, 0)]);
  expect(existsSync(appDbPath(dataRoot, APP_ID))).toBe(true);
  expect(existsSync(appManifestPath(dataRoot, APP_ID))).toBe(true);
});

// --- V1-M9-T02: apply 窓ガード(ADR-0017 / M2)----------------------------------

describe("完了条件9-11: apply 適用中はスケジューラがそのアプリを譲る", () => {
  test("マーカーが在る間は発火せず、消えれば同じ日のうちに遅れて発火する", () => {
    install([dailyNotify(9, 0)]);
    setNow("2026-07-20T09:30:00+09:00"); // 09:00 は過ぎている(isDue)。

    // apply 窓を開く(危険窓のマーカー)。この tick は譲る。
    beginApply(dataRoot, APP_ID, "d-during-schedule");
    tick();
    expect(rowsOf("wf-runs")).toHaveLength(0);
    expect(rowsOf("notifications")).toHaveLength(0);

    // 窓が閉じれば、同じ日のうちに次の tick で遅れて発火する(何も失われない)。
    endApply(dataRoot, APP_ID);
    tick();
    const history = rowsOf("wf-runs");
    expect(history).toHaveLength(1);
    expect(history[0]?.workflow).toBe("daily-summary");
    expect(rowsOf("notifications")).toHaveLength(1);
  });

  test("適用中のアプリを譲っても、他のアプリの発火は止まらない", () => {
    install([dailyNotify(9, 0)]); // APP_ID
    const other = "other-app";
    createApp(store, "別アプリ", { app_id: other });
    install([dailyNotify(9, 0)], other);
    setNow("2026-07-20T09:30:00+09:00");

    // APP_ID だけ適用中にする。
    beginApply(dataRoot, APP_ID, "d-guard");
    tick();
    try {
      expect(rowsOf("wf-runs", APP_ID)).toHaveLength(0); // 譲った
      expect(rowsOf("wf-runs", other)).toHaveLength(1); // 止まっていない
    } finally {
      endApply(dataRoot, APP_ID);
    }
  });
});

// ---------------------------------------------------------------------------
// V3-M10-T01(`D-G16a`。ADR-0063): `schedule` の発火が表の行を対象にできる
//
// **実証はテスト用マニフェストで組む**(`v3-m10.md` §2 T01 完了条件2 / `D-M10-3`。
// `scripts/ref-ec/` は1バイトも使わない)。
//
// ここで固定するのは ADR-0063 §3 の限定表のうち、**限定4(発火済み状態の粒度を
// 動かさない)と限定5(1回の発火の処理行数の上限)**である。
// ---------------------------------------------------------------------------

/** 行選択の対象表 `orders` を足したマニフェスト(テスト用。ref-ec は使わない)。 */
function manifestWithOrders(workflows: Workflow[]): Manifest {
  const manifest = manifestWith(workflows);
  manifest.app.tables.push({
    id: "orders",
    name: "注文",
    fields: [
      { id: "code", name: "注文番号", type: "text" },
      { id: "status", name: "状態", type: "text" },
      /*
       * **V3-M10-T02(`D-G16b` / ADR-0064)が足した `date` 型の列。**
       * `older_than.field` が指せるのは `date` 型だけなので、経過時間の検査には
       * この1列が要る。**T01 の検査は `placed_on` を1つも書かない**ので、
       * 足しても T01 の期待値は1つも動かない(既定値は null)。
       */
      { id: "placed_on", name: "注文日", type: "date" },
    ],
  });
  return manifest;
}

/** `orders` の各行について `notifications` を1件作る schedule ワークフロー。 */
function sweepOrders(when?: { field: string; equals: string }): Workflow {
  return {
    id: "order-sweep",
    name: "毎朝9時に注文を1件ずつ処理する",
    trigger: { type: "schedule", at: { hour: 9, minute: 0 }, table: "orders" },
    actions: [
      {
        action: "create_record",
        table: "notifications",
        values: { title: "$record.code", source: "sweep" },
        ...(when === undefined ? {} : { when }),
      },
    ],
    history_table: "wf-runs",
  };
}

/** `orders` に n 行入れる(`code` は連番、`status` は既定 `pending`)。 */
function seedOrders(n: number, status = "pending"): void {
  const manifest = currentManifest();
  withDb((db) => {
    db.exec("BEGIN");
    for (let i = 0; i < n; i += 1) {
      const created = createRecord(db, manifest, "orders", {
        code: `o-${String(i).padStart(4, "0")}`,
        status,
      });
      if (!created.ok) {
        db.exec("ROLLBACK");
        throw new Error(`テスト前提の行投入に失敗しました: ${JSON.stringify(created.errors)}`);
      }
    }
    db.exec("COMMIT");
  });
}

function installOrders(workflows: Workflow[]): void {
  const applied = applyManifest(dataRoot, APP_ID, manifestWithOrders(workflows));
  if (!applied.valid) {
    throw new Error(
      `テスト前提のマニフェスト投入に失敗しました: ${JSON.stringify(applied.errors)}`,
    );
  }
}

describe("V3-M10-T01 完了条件1: schedule の発火が表の行を対象にできる", () => {
  test("対象表の行ごとにアクションが実行される(3行 → 3件)", () => {
    installOrders([sweepOrders()]);
    seedOrders(3);

    setNow("2026-07-20T09:00:00+09:00");
    tick();

    const notifications = rowsOf("notifications");
    expect(notifications).toHaveLength(3);
    // **`$record.<フィールド>` が行ごとの値に解決している**(トリガー元レコードが在る)。
    expect(notifications.map((row) => row.title).sort()).toEqual(["o-0000", "o-0001", "o-0002"]);
  });

  test("trigger.table を書かない schedule は今日どおり1回だけ発火する(非退行)", () => {
    install([dailyNotify(9, 0)]);
    setNow("2026-07-20T09:00:00+09:00");
    tick();

    expect(rowsOf("notifications")).toHaveLength(1);
    expect(rowsOf("wf-runs")).toHaveLength(1);
  });

  test("対象表が0行なら1件も作られないが、発火したことは履歴に残る", () => {
    installOrders([sweepOrders()]);

    setNow("2026-07-20T09:00:00+09:00");
    tick();

    expect(rowsOf("notifications")).toHaveLength(0);
    // **履歴を書かないと `firedOn` が「まだ発火していない」と読み、毎周期走り続ける。**
    const history = rowsOf("wf-runs");
    expect(history).toHaveLength(1);
    /*
     * 【`V8-M42` / `F-G15` / `ADR-0333`。**旧の期待値を逐語で残す**】
     *
     *     expect(history[0]?.status).toBe("success");
     *
     * **行が1行残ること(この検査の主題)は1バイトも変わっていない。**
     * **変わったのは `status` 欄の値だけである** —— **対象0件の空撃ちは、今日は
     * `"success"` ではなく4値目 `"no_target"` として残る**(`ADR-0333` 限定2)。
     * **`"success"` と書いていたことが `A-7` の直接の原因であった** ——
     * **成功として残るので `firedOn` が「今日もう発火した」と読んだ。**
     */
    expect(history[0]?.status).toBe("no_target");
  });

  test("when が行ごとに評価され、一致した行だけが実行される(スキップは履歴に loud に残る)", () => {
    installOrders([sweepOrders({ field: "status", equals: "pending" })]);
    seedOrders(2, "pending");
    seedOrders(1, "paid");

    setNow("2026-07-20T09:00:00+09:00");
    tick();

    expect(rowsOf("notifications")).toHaveLength(2);
    const history = rowsOf("wf-runs");
    expect(history).toHaveLength(1);
    // スキップは失敗ではない(status は success のまま)が、黙って消えない。
    expect(history[0]?.status).toBe("success");
    expect(String(history[0]?.error)).toContain("スキップ");
  });

  test("同じ日に何度 tick しても、行選択の発火も1回きりである(firedOn がそのまま効く)", () => {
    installOrders([sweepOrders()]);
    seedOrders(3);

    setNow("2026-07-20T09:00:00+09:00");
    tick();
    setNow("2026-07-20T09:00:30+09:00");
    tick();
    setNow("2026-07-20T18:00:00+09:00");
    tick();

    expect(rowsOf("notifications")).toHaveLength(3);
    expect(rowsOf("wf-runs")).toHaveLength(1);
  });
});

describe("V3-M10-T01 完了条件4 / ADR-0063 限定4: 履歴の粒度は「1発火につき1行」のまま", () => {
  test("N 行を処理した1回の発火が、履歴に1行だけ書く(行数に比例して増えない)", () => {
    installOrders([sweepOrders()]);
    seedOrders(25);

    setNow("2026-07-20T09:00:00+09:00");
    tick();

    expect(rowsOf("notifications")).toHaveLength(25);
    // **ここが「カーネルは登録簿を持たない」の実体である**(ADR-0013 限定7 / ADR-0063 限定4)。
    // 行単位の発火済みを持たないので、履歴は行数に比例しない。
    expect(rowsOf("wf-runs")).toHaveLength(1);
  });

  test("行の処理が失敗しても履歴は1行で、失敗の説明が行ごとに載る", () => {
    // `strict.must` は required なので、値を与えない create は必ず失敗する。
    const workflow: Workflow = {
      id: "order-sweep",
      name: "必ず失敗する行処理",
      trigger: { type: "schedule", at: { hour: 9, minute: 0 }, table: "orders" },
      actions: [{ action: "create_record", table: "strict", values: { note: "$record.code" } }],
      history_table: "wf-runs",
    };
    installOrders([workflow]);
    seedOrders(2);

    setNow("2026-07-20T09:00:00+09:00");
    tick();

    const history = rowsOf("wf-runs");
    expect(history).toHaveLength(1);
    expect(history[0]?.status).toBe("failure");
    // **どの行で失敗したかが読める**(行を名指ししないと 1000 行のうちどれか分からない)。
    expect(String(history[0]?.error)).toContain("レコード");
  });
});

describe("V3-M10-T01 完了条件6 / ADR-0063 限定5: 1回の発火で処理する行数の上限(新設)", () => {
  test(
    "上限ちょうど(1000 行)は打ち切られず、全行が処理される",
    () => {
      installOrders([sweepOrders()]);
      seedOrders(1000);

      setNow("2026-07-20T09:00:00+09:00");
      tick();

      expect(rowsOf("notifications")).toHaveLength(1000);
      const history = rowsOf("wf-runs");
      expect(history).toHaveLength(1);
      expect(history[0]?.status).toBe("success");
    },
    HEAVY_ROW_TEST_TIMEOUT_MS,
  );

  test(
    "上限を1行でも超える(1001 行)と、その発火は打ち切られ、履歴に失敗として残る",
    () => {
      installOrders([sweepOrders()]);
      seedOrders(1001);

      setNow("2026-07-20T09:00:00+09:00");
      tick();

      // **打ち切りである。**「先頭 1000 行だけ処理する」ではない ——
      // 途中まで処理すると「どこまで処理したか」を覚える必要が生じ、限定4 を破る。
      expect(rowsOf("notifications")).toHaveLength(0);
      const history = rowsOf("wf-runs");
      expect(history).toHaveLength(1);
      expect(history[0]?.status).toBe("failure");
      expect(String(history[0]?.error)).toContain("1000");
    },
    HEAVY_ROW_TEST_TIMEOUT_MS,
  );

  /*
   * 【`V8-M42` / `F-G15` / `ADR-0333`。**旧のテスト名を逐語で残す**】
   *
   * **旧のテスト名(1バイトも変えずに引く)**:
   *     "打ち切られた発火は同じ日に再試行されない(firedOn は status を見ない)"
   *
   * **旧の名前が括弧の中で述べていた根拠(`firedOn は status を見ない`)は、今日は偽である** ——
   * **`F-G15` が `firedOn` に `status` を読ませた**(`workflow-scheduler.ts` の `firedOn`)。
   * **期待値は1つも変えていない** —— **打ち切りは今日も `"failure"` で残り、`firedOn` が
   * 除くのは4値目 `"no_target"` の行だけだからである**(`ADR-0333` 限定2)。
   * **名前だけを、今日の根拠に合わせて書き直した。**
   */
  test(
    "打ち切られた発火は同じ日に再試行されない(firedOn が除くのは空撃ちの行だけで、打ち切りの failure は除かない)",
    () => {
      installOrders([sweepOrders()]);
      seedOrders(1001);

      setNow("2026-07-20T09:00:00+09:00");
      tick();
      setNow("2026-07-20T09:00:30+09:00");
      tick();

      // **塞いでいない限界である**(ADR-0063 §限界1)。履歴は1行のまま増えない。
      expect(rowsOf("wf-runs")).toHaveLength(1);
      expect(rowsOf("notifications")).toHaveLength(0);
    },
    HEAVY_ROW_TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// **`V8-M42` / `F-G15`(`ADR-0333`)—— 対象0件の空撃ちで「今日発火済み」にしない**
//
// **塞ぐもの**(`v8-m35.md` §5-1 の逐語): 「**対象0件の空撃ちで「今日発火済み」に
// ならないようにする**」。**対応する問題 = `v8-m33.md` §1-A の `A-7`。**
//
// **限定**(同 §5-1 の逐語): 「**履歴の5列規約を動かさない**(**`statusOverride` を使う**)。
// **打ち切りまで再試行しない。**」
// ---------------------------------------------------------------------------

describe("V8-M42 / F-G15 / ADR-0333: 対象0件の空撃ちは「今日発火済み」にしない", () => {
  test("(a) 対象0件の発火は、履歴に1行だけ `no_target` として残る(列は1本も増えない)", () => {
    installOrders([sweepOrders()]);

    setNow("2026-07-20T09:00:00+09:00");
    tick();

    const history = rowsOf("wf-runs");
    // **履歴は今日どおり必ず書かれる**(書かないと `writeHistory` の all-or-nothing を破る)。
    expect(history).toHaveLength(1);
    expect(history[0]?.status).toBe("no_target");
    // **`error` 列は使わない**(判定に使うと列の意味が1つ増える。道 (ii) の後半を採らなかった)。
    expect(history[0]?.error).toBeNull();
    expect(history[0]?.trigger_type).toBe("schedule");
    // **5列規約のまま。6列目は1本も無い。**
    expect(Object.keys(history[0] ?? {}).sort()).toEqual(
      [
        "_created_at",
        "_id",
        "_updated_at",
        "error",
        "ran_at",
        "status",
        "trigger_type",
        "workflow",
      ].sort(),
    );
  });

  test("(b) 同じ日に対象が1件用意されたら、次の tick で発火する(空撃ちは発火済みにしない)", () => {
    installOrders([sweepOrders()]);

    // 1度目 —— 対象0件の空撃ち。
    setNow("2026-07-20T09:00:00+09:00");
    tick();
    expect(rowsOf("notifications")).toHaveLength(0);

    // **同じ日のうちに**対象を1件用意する(**時計を進めない**)。
    seedOrders(1);

    setNow("2026-07-20T09:00:30+09:00");
    tick();

    // **着手前はここが 0 件のままだった**(空撃ちが「今日発火済み」を立ててしまうため)。
    expect(rowsOf("notifications")).toHaveLength(1);
    const history = rowsOf("wf-runs");
    expect(history).toHaveLength(2);
    expect(history.map((row) => row.status)).toEqual(["no_target", "success"]);
  });

  test("対象を処理した発火は今日どおり `success` で、同じ日に再発火しない(非退行)", () => {
    installOrders([sweepOrders()]);
    seedOrders(2);

    setNow("2026-07-20T09:00:00+09:00");
    tick();
    setNow("2026-07-20T09:00:30+09:00");
    tick();

    expect(rowsOf("notifications")).toHaveLength(2);
    const history = rowsOf("wf-runs");
    expect(history).toHaveLength(1);
    expect(history[0]?.status).toBe("success");
  });

  test("行を選ばない schedule(`trigger.table` 無し)は空撃ちではない —— 今日どおり `success` で1回きり", () => {
    // **`targets === undefined` は「対象0件」ではない** —— 対象という概念を持たない側である。
    install([dailyNotify(9, 0)]);

    setNow("2026-07-20T09:00:00+09:00");
    tick();
    setNow("2026-07-20T09:00:30+09:00");
    tick();

    expect(rowsOf("notifications")).toHaveLength(1);
    const history = rowsOf("wf-runs");
    expect(history).toHaveLength(1);
    expect(history[0]?.status).toBe("success");
  });

  test("`when` で全行がスキップされた発火は空撃ちではない(対象は在る)—— 今日どおり `success` で1回きり", () => {
    installOrders([sweepOrders({ field: "status", equals: "paid" })]);
    seedOrders(2, "pending");

    setNow("2026-07-20T09:00:00+09:00");
    tick();
    setNow("2026-07-20T09:00:30+09:00");
    tick();

    expect(rowsOf("notifications")).toHaveLength(0);
    const history = rowsOf("wf-runs");
    expect(history).toHaveLength(1);
    expect(history[0]?.status).toBe("success");
    expect(String(history[0]?.error)).toContain("スキップ");
  });

  test("【ADR-0333 限定5】4値目の綴りは `no_target` に凍結し、2ファイルで揃っている", () => {
    // **綴りは書く側(`workflow-runner.ts`)と読む側(`workflow-scheduler.ts`)の2箇所にある**
    // (層をまたいで import しない = `Δ8` を空に保つ)。**片方だけ変わると空撃ちが黙って
    // 「発火済み」に戻る**ので、値の逐語と、2箇所が揃っていることをここで押さえる。
    const runner = readFileSync(
      join(import.meta.dir, "..", "..", "src/kernel/workflow-runner.ts"),
      "utf-8",
    );
    const scheduler = readFileSync(
      join(import.meta.dir, "..", "..", "src/kernel/workflow-scheduler.ts"),
      "utf-8",
    );
    expect(runner).toContain('const WORKFLOW_STATUS_NO_TARGET = "no_target";');
    expect(scheduler).toContain('const SCHEDULE_STATUS_NO_TARGET = "no_target";');
    // **非 export のままであること**(`ADR-0072` 限定10 と同じ理由)。
    expect(runner).not.toContain("export const WORKFLOW_STATUS_NO_TARGET");
    expect(scheduler).not.toContain("export const SCHEDULE_STATUS_NO_TARGET");
  });

  test("`status` 列を持たない履歴テーブルでも `firedOn` は例外を投げない(既存アプリを止めない)", () => {
    // **`firedOn` の必須列検査は今日も2列(`workflow` / `ran_at`)だけである** ——
    // **`status` を必須にすると、5列規約を満たさない既存アプリがその日から発火しなくなる**
    // (`S3` の1点目)。**物理列を落として、それでも判定が通ることを実行で確かめる。**
    installOrders([sweepOrders()]);
    seedOrders(1);
    withDb((db) => {
      db.exec(`ALTER TABLE "wf-runs" DROP COLUMN "status"`);
    });

    setNow("2026-07-20T09:00:00+09:00");
    // **`runSchedulerTick` は全域関数なので、判定が投げても外へは出ない** ——
    // **投げていないことは「発火が起きたこと」で示す**(投げれば `continue` せずに見送られる)。
    tick();

    expect(rowsOf("notifications")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ADR-0063 限定5 の「同型の検査」——
// `src/kernel/reference-read-boundary.test.ts:601`〜`:630`(`RUN_FUNCTION_LIMITS`)と
// 同じ形で、**値の逐語一致**・**非 export のまま**・**export スナップショットに
// 現れない**の3点を固定する。
//
// **この形の限界を隠さない**(あちらと同じ): テキスト照合は「その文字列がソースに
// 在る」ことしか言えない。**上限が実際に効いていること**は上の 1001 行のテストが
// 実行で確かめており、ここが言うのは「値と公開性が変わっていない」ことだけである。
// ---------------------------------------------------------------------------

describe("V3-M10-T01 / ADR-0063 限定5: 上限定数の値と公開性", () => {
  function sourceText(relative: string): string {
    return readFileSync(join(import.meta.dir, "..", "..", relative), "utf-8");
  }

  test("上限は 1000 行であり、ADR-0063 限定表の値と逐語で一致する", () => {
    const scheduler = sourceText("src/kernel/workflow-scheduler.ts");
    expect(scheduler).toContain("const SCHEDULE_ROW_LIMIT = 1000;");
  });

  test("`SCHEDULE_ROW_LIMIT` は非 export のままである(Δ8 を発火させない)", () => {
    const scheduler = sourceText("src/kernel/workflow-scheduler.ts");
    expect(scheduler).not.toContain("export const SCHEDULE_ROW_LIMIT");
    expect(sourceText("scripts/kernel-export-snapshot.txt")).not.toContain("SCHEDULE_ROW_LIMIT");
  });

  test("実装位置は `src/kernel/workflow-scheduler.ts` である(他ファイルに複製していない)", () => {
    expect(sourceText("src/kernel/workflow-runner.ts")).not.toContain("SCHEDULE_ROW_LIMIT");
  });
});

describe("V3-M10-T01 完了条件4 / ADR-0063 限定4: 新しい状態を1バイトも作っていない", () => {
  function schedulerSource(): string {
    return readFileSync(
      join(import.meta.dir, "..", "..", "src", "kernel", "workflow-scheduler.ts"),
      "utf-8",
    );
  }

  test("workflow-scheduler.ts にモジュールスコープの可変状態が無い(let / var が0件)", () => {
    // 関数の内側の `let` は状態ではないので、**モジュールスコープ(行頭)**だけを見る。
    const moduleScopeMutable = schedulerSource()
      .split("\n")
      .filter((line) => /^(let|var) /.test(line));
    expect(moduleScopeMutable).toEqual([]);
  });

  test("SYSTEM_TABLES は3のまま(新しいシステムテーブルを作っていない)", () => {
    expect(SYSTEM_TABLES).toHaveLength(3);
  });

  test("行単位の発火済みを覚える永続先を作っていない(新しいファイル書き出しが0件)", () => {
    const source = schedulerSource();
    for (const forbidden of ["writeFileSync", "mkdirSync", "CREATE TABLE", "INSERT INTO"]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

// ===========================================================================
// V3-M10-T02(`D-G16b`。ADR-0064): `schedule` が「一定時間経った行」だけを対象にできる
//
// **実証はテスト用マニフェストで組む**(`v3-m10.md` §2 T02 完了条件2 / `D-M10-3`。
// `scripts/ref-ec/` は1バイトも使わない)。
//
// ここで固定するのは `ADR-0064` §3 の限定表のうち **限定3(発火の時刻と頻度を1ミリも
// 変えない・境界は `>=`・日付境界は `ST_TIMEZONE`)** と、**完了条件4a の統合実証**である。
// ---------------------------------------------------------------------------

/** `older_than` を持つ滞留掃除ワークフロー(`when` を重ねると2層の AND になる)。 */
function staleSweep(
  days = 3,
  when?: { field: string; equals: string },
  at = { hour: 9, minute: 0 },
): Workflow {
  return {
    id: "stale-sweep",
    name: "毎朝9時に滞留した注文を打ち切る",
    trigger: {
      type: "schedule",
      at,
      table: "orders",
      older_than: { field: "placed_on", days },
    },
    actions: [
      {
        action: "create_record",
        table: "notifications",
        values: { title: "$record.code", source: "stale" },
        ...(when === undefined ? {} : { when }),
      },
    ],
    history_table: "wf-runs",
  };
}

/** `orders` に1行入れる(`placed_on` を省くと null になる)。 */
function seedOrder(code: string, status: string, placedOn?: string): void {
  const manifest = currentManifest();
  withDb((db) => {
    const created = createRecord(db, manifest, "orders", {
      code,
      status,
      ...(placedOn === undefined ? {} : { placed_on: placedOn }),
    });
    if (!created.ok) {
      throw new Error(`テスト前提の行投入に失敗しました: ${JSON.stringify(created.errors)}`);
    }
  });
}

/** 通知の `title`(= `$record.code`)を並べて返す。 */
function sweptCodes(): string[] {
  return rowsOf("notifications")
    .map((row) => String(row.title))
    .sort();
}

describe("V3-M10-T02 完了条件1 / 3: 経過日数で行を絞り、境界は `>=`(ちょうど N 日を含む)", () => {
  test("ちょうど3日前の行は含まれ、2日前の行は含まれない(境界は >=)", () => {
    installOrders([staleSweep(3)]);
    seedOrder("o-4days", "pending_payment", "2026-07-16"); // 4日前
    seedOrder("o-3days", "pending_payment", "2026-07-17"); // **ちょうど3日前**
    seedOrder("o-2days", "pending_payment", "2026-07-18"); // 2日前
    seedOrder("o-today", "pending_payment", "2026-07-20"); // 当日(0日)

    setNow("2026-07-20T09:00:00+09:00");
    tick();

    expect(sweptCodes()).toEqual(["o-3days", "o-4days"]);
  });

  test("日付に時刻が付いていても同じ境界で判定される(ISO8601 の2形とも受ける)", () => {
    installOrders([staleSweep(3)]);
    seedOrder("o-instant-in", "pending_payment", "2026-07-17T23:59:59+09:00"); // 3日前
    seedOrder("o-instant-out", "pending_payment", "2026-07-18T00:00:00+09:00"); // 2日前

    setNow("2026-07-20T09:00:00+09:00");
    tick();

    expect(sweptCodes()).toEqual(["o-instant-in"]);
  });

  test("日付の値が無い行・読めない行は対象にならない(fail-closed)", () => {
    installOrders([staleSweep(3)]);
    seedOrder("o-null", "pending_payment"); // `placed_on` が null
    seedOrder("o-old", "pending_payment", "2026-07-01");

    setNow("2026-07-20T09:00:00+09:00");
    tick();

    // **「経ったかどうかが判定できない行」を打ち切らない。**
    expect(sweptCodes()).toEqual(["o-old"]);
  });

  test("days = 1 は「前日以前」を意味する(最小値の意味を固定する)", () => {
    installOrders([staleSweep(1)]);
    seedOrder("o-yesterday", "pending_payment", "2026-07-19");
    seedOrder("o-today", "pending_payment", "2026-07-20");

    setNow("2026-07-20T09:00:00+09:00");
    tick();

    expect(sweptCodes()).toEqual(["o-yesterday"]);
  });

  test("月をまたぐ引き算が正しい(7/02 に 3日 → 6/29 以前)", () => {
    installOrders([staleSweep(3)]);
    seedOrder("o-0629", "pending_payment", "2026-06-29"); // ちょうど3日前
    seedOrder("o-0630", "pending_payment", "2026-06-30"); // 2日前

    setNow("2026-07-02T09:00:00+09:00");
    tick();

    expect(sweptCodes()).toEqual(["o-0629"]);
  });
});

describe("V3-M10-T02 完了条件2: 時刻の基準は「発火した日」であり、行の作成時刻ではない", () => {
  test("同じ行が、発火した日が進むと対象になる(基準は tick が読んだ壁時計の日付)", () => {
    installOrders([staleSweep(3)]);
    seedOrder("o-0718", "pending_payment", "2026-07-18");

    // 7/20 の発火では2日前なので対象外。
    setNow("2026-07-20T09:00:00+09:00");
    tick();
    expect(sweptCodes()).toEqual([]);
    expect(rowsOf("wf-runs")).toHaveLength(1);

    // 7/21 の発火では3日前なので対象になる。**行は1バイトも変えていない。**
    setNow("2026-07-21T09:00:00+09:00");
    tick();
    expect(sweptCodes()).toEqual(["o-0718"]);
    expect(rowsOf("wf-runs")).toHaveLength(2);
  });

  /*
   * **`at` を 00:00 に置く。**JST と UTC で「今日」が割れる瞬間
   * (UTC の 15:00 以降)では、JST の時刻は必ず 09:00 より前になるので、
   * `at` が 09:00 のままだと片方が `isDue` で落ちてしまい、**日付境界ではなく
   * 発火判定の違いを測ってしまう。**測りたいのは前者だけである。
   */
  const midnight = { hour: 0, minute: 0 };

  test("日付境界は ST_TIMEZONE で決まる(Asia/Tokyo では対象になる)", () => {
    // 2026-07-20T15:30:00Z = JST の 2026-07-21 00:30。**同じ瞬間で「今日」が1日ずれる。**
    installOrders([staleSweep(3, undefined, midnight)]);
    seedOrder("o-0718", "pending_payment", "2026-07-18");
    setNow("2026-07-20T15:30:00Z");

    // JST: 今日 = 7/21 → 3日前は 7/18 → **含まれる**。
    runSchedulerTick({ dataRoot, timeZone: "Asia/Tokyo" });
    expect(sweptCodes()).toEqual(["o-0718"]);
  });

  test("同じ瞬間・同じ行でも UTC では対象外である(ST_TIMEZONE がずれれば結果がずれる)", () => {
    installOrders([staleSweep(3, undefined, midnight)]);
    seedOrder("o-0718", "pending_payment", "2026-07-18");
    setNow("2026-07-20T15:30:00Z");

    // UTC: 今日 = 7/20 → 3日前は 7/17 → 7/18 は**含まれない**。
    runSchedulerTick({ dataRoot, timeZone: "UTC" });
    expect(sweptCodes()).toEqual([]);
    // **発火そのものは起きている**(履歴は1行ある)—— 述語は「どの行か」だけを決める。
    expect(rowsOf("wf-runs")).toHaveLength(1);
  });
});

describe("V3-M10-T02 / ADR-0064 限定3: older_than は発火の可否に1ミリも影響しない", () => {
  test("発火時刻より前の tick では、対象行があっても発火しない", () => {
    installOrders([staleSweep(3)]);
    seedOrder("o-old", "pending_payment", "2026-07-01");

    setNow("2026-07-20T08:59:00+09:00");
    tick();

    expect(rowsOf("wf-runs")).toHaveLength(0);
    expect(sweptCodes()).toEqual([]);
  });

  test("days を変えても発火時刻は変わらない(1 でも 3650 でも 09:00 に1回)", () => {
    for (const days of [1, 3650]) {
      installOrders([staleSweep(days)]);
      setNow("2026-07-20T08:59:00+09:00");
      tick();
      expect(rowsOf("wf-runs")).toHaveLength(0);

      setNow("2026-07-20T09:00:00+09:00");
      tick();
      expect(rowsOf("wf-runs")).toHaveLength(1);

      // 次の days のために履歴を消して入れ直す(同じ dataRoot を使い回す)。
      withDb((db) => {
        db.exec('DELETE FROM "wf-runs"');
      });
    }
  });

  test("対象行が0件でも発火は起きて履歴に1行残る(黙って止まらない。憲法6)", () => {
    installOrders([staleSweep(3)]);
    seedOrder("o-today", "pending_payment", "2026-07-20");

    setNow("2026-07-20T09:00:00+09:00");
    tick();

    expect(sweptCodes()).toEqual([]);
    const history = rowsOf("wf-runs");
    expect(history).toHaveLength(1);
    /*
     * 【`V8-M42` / `F-G15` / `ADR-0333`。**旧の期待値を逐語で残す**】
     *
     *     expect(history[0]?.status).toBe("success");
     *
     * **この検査の主題(発火は起きて履歴に1行残る = 黙って止まらない)は1バイトも
     * 変わっていない。** **変わったのは `status` 欄の値だけである。**
     *
     * **【`ADR-0064` 限定3 との緊張。丸めない】** **限定3 の逐語は「**`older_than` は
     * 発火の可否に1ミリも影響しない** —— 影響するのは「発火したとき、どの行を対象にするか」
     * だけである」である。** **`older_than` が全行を落とした発火は、今日 `"no_target"` に
     * なり、同じ日の次の tick で**もう一度判定される**。** **すなわち `older_than` は
     * 今日、**同じ日の再発火**に影響する。** **`isDue`(発火時刻の判定)は1バイトも
     * 変えていない**(下の逐語検査がそれを押さえる)**が、「1ミリも影響しない」は
     * もう書けない。** **`ADR-0333` がこの点で `ADR-0064` を引き直した**
     * (`ADR-0064` の front matter に `amended_by: [333]` を入れてある)。
     * **【正直に】これは副作用ではなく、`F-G15` が狙って広げた範囲である** ——
     * **「3日経った行」が昼になって初めて現れる日に、朝の空撃ちでその日を潰さない。**
     */
    expect(history[0]?.status).toBe("no_target");
  });

  test("`isDue` の判定式が1バイトも変わっていない(逐語)", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "..", "src", "kernel", "workflow-scheduler.ts"),
      "utf-8",
    );
    expect(source).toContain("return now.hour * 60 + now.minute >= at.hour * 60 + at.minute;");
    // `isDue` の引数に日付も `older_than` も入っていない(発火判定は時分だけを見る)。
    expect(source).toContain(
      "function isDue(at: ScheduleAt, now: { hour: number; minute: number })",
    );
  });

  test("サーバが止まっていた日の分は落ちない(>= の向きなので翌日に拾われる)", () => {
    // 7/20 に「ちょうど3日」を迎えるが、その日は tick が1度も走らなかった。
    installOrders([staleSweep(3)]);
    seedOrder("o-0717", "pending_payment", "2026-07-17");

    setNow("2026-07-21T09:00:00+09:00");
    tick();

    // **4日経った行として拾われる。落ちてはいない。**遅れは解消していない(§限界3)。
    expect(sweptCodes()).toEqual(["o-0717"]);
  });

  test(
    "上限(1000 行)の判定は older_than の前に当たる(ADR-0063 限定5 を1バイトも変えていない)",
    () => {
      installOrders([staleSweep(3)]);
      seedOrders(1001, "pending_payment"); // `placed_on` は全行 null(=対象0件になるはず)

      setNow("2026-07-20T09:00:00+09:00");
      tick();

      // **述語で0件に絞られるとしても、読み取った行数が上限を超えたら打ち切る。**
      const history = rowsOf("wf-runs");
      expect(history).toHaveLength(1);
      expect(history[0]?.status).toBe("failure");
      expect(String(history[0]?.error)).toContain("1000");
      expect(sweptCodes()).toEqual([]);
    },
    HEAVY_ROW_TEST_TIMEOUT_MS,
  );

  test("非退行: older_than を書かない schedule + table は今日どおり全行を対象にする", () => {
    installOrders([sweepOrders()]);
    seedOrders(3);

    setNow("2026-07-20T09:00:00+09:00");
    tick();

    expect(rowsOf("notifications")).toHaveLength(3);
  });
});

describe("V3-M10-T02 完了条件4a: D-G16a + D-G16b の統合実証(2層の合成で AND を得る)", () => {
  /*
   * **`v3-m10.md` §0-4 (1) が要求した実証はこれである。**
   *
   * - **(P1) 状態が `pending_payment` である** … 既存の `when`(等値1形)が見る。
   * - **(P2) 3日以上経過している** … `trigger.older_than` が見る。
   *
   * **述語を1つも結合していない。**AND は「トリガーが行を絞る」×「`when` が
   * アクションを絞る」の**2層の合成**で得ている(ADR-0064 §Context / 限定2)。
   */
  test("3日以上 pending_payment のままの行だけが打ち切られる", () => {
    installOrders([staleSweep(3, { field: "status", equals: "pending_payment" })]);
    seedOrder("old-pending", "pending_payment", "2026-07-16"); // 古い × 未払い → **打ち切る**
    seedOrder("new-pending", "pending_payment", "2026-07-19"); // 新しい × 未払い → 打ち切らない
    seedOrder("old-paid", "paid", "2026-07-16"); // 古い × 支払済 → 打ち切らない
    seedOrder("new-paid", "paid", "2026-07-19"); // 新しい × 支払済 → 打ち切らない

    setNow("2026-07-20T09:00:00+09:00");
    tick();

    expect(sweptCodes()).toEqual(["old-pending"]);

    const history = rowsOf("wf-runs");
    expect(history).toHaveLength(1);
    expect(history[0]?.status).toBe("success");

    /*
     * **2層の非対称を隠さない**(この検査が言いたいことの半分はこれである):
     * `when` で落ちた行(`old-paid`)は**履歴にスキップとして loud に残る**が、
     * `older_than` で落ちた行(`new-pending` / `new-paid`)は**そもそも対象にならない**
     * ので履歴に1文字も現れない。
     */
    const error = String(history[0]?.error ?? "");
    expect(error).toContain("スキップ");
    // 履歴は行を **`_id`** で名指しするので、`_id` を引いてから突き合わせる。
    const idOf = (code: string): string =>
      String(rowsOf("orders").find((row) => row.code === code)?._id);
    expect(error).toContain(idOf("old-paid"));
    // **`older_than` で落ちた行は履歴に1文字も現れない**(対象にすらならない)。
    expect(error).not.toContain(idOf("new-pending"));
    expect(error).not.toContain(idOf("new-paid"));
    // スキップとして残るのは1行だけである(古い×支払済の1件)。
    expect(error.split("スキップしました").length - 1).toBe(1);
  });

  test("境界(ちょうど3日)の扱いは統合経路でも同じである", () => {
    installOrders([staleSweep(3, { field: "status", equals: "pending_payment" })]);
    seedOrder("exactly-3", "pending_payment", "2026-07-17");
    seedOrder("only-2", "pending_payment", "2026-07-18");

    setNow("2026-07-20T09:00:00+09:00");
    tick();

    expect(sweptCodes()).toEqual(["exactly-3"]);
  });

  test("同じ日に何度 tick しても打ち切りは1回きりである(firedOn がそのまま効く)", () => {
    installOrders([staleSweep(3, { field: "status", equals: "pending_payment" })]);
    seedOrder("old-pending", "pending_payment", "2026-07-16");

    setNow("2026-07-20T09:00:00+09:00");
    tick();
    setNow("2026-07-20T09:00:30+09:00");
    tick();
    setNow("2026-07-20T23:59:00+09:00");
    tick();

    expect(sweptCodes()).toEqual(["old-pending"]);
    expect(rowsOf("wf-runs")).toHaveLength(1);
  });
});

// ===========================================================================
// V3-M10-T04: 越えない線の非退行検査 + 新設した上限の検査
//
// **本節は製品コードを1バイトも変更しない**(`v3-m10.md` §2 T04 / §2a-5)。
//
// **T01 / T02 が既に当てた角度をここに複製しない。** 重複を避けるため、着手前に
// 実測した既存の当たり先は次のとおりである(この位置は 2026-07-31 の実測):
//
// - `SYSTEM_TABLES` が3 / `workflow-scheduler.ts` にモジュールスコープの可変状態が
//   無い / 新しいファイル書き出しが0件 …… **T01 が `:1104`〜`:1130` で当てている。**
// - 上限 1000 行の値・非 export・実装位置・境界(1000 / 1001)…… **T01 が
//   `:1027`〜`:1102` で当てている。**
// - `$defs/schedule_at` の2キー …… **T01(`workflow-schema.test.ts`「限定2」)と
//   T02(同「ADR-0064 限定3」)の2本が当てている。**
// - `$defs/action_value` …… **`src/kernel/reference-read-boundary.test.ts:639` の
//   describe が当てている。本タスクは1本も新設しない。**
//
// ここに足すのは**それらが当てていない角度だけ**である。
// ---------------------------------------------------------------------------

/** ソースを読む(逐語の走査用)。 */
function kernelSource(relative: string): string {
  return readFileSync(join(import.meta.dir, "..", "..", relative), "utf-8");
}

/**
 * コメントを取り除いたコード本文だけを返す。
 *
 * **これが無いと走査が偽陽性になる** —— `workflow-scheduler.ts` の doc コメントは
 * 「このファイルに `setTimeout` / `AbortSignal` / `deadline` / `performance.now` /
 * `Date.now` は0件」と**その語を並べて宣言している**ので、素朴な `not.toContain` は
 * 必ず赤くなる。**宣言文そのものを消して緑にするのではなく、走査の側を正す。**
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

describe("V3-M10-T04 完了条件1: 発火済み状態を持たないことの非退行(行ごとの発火でも)", () => {
  test("翌日は同じ3行がもう一度処理される(行単位の発火済みをどこにも覚えていない)", () => {
    installOrders([sweepOrders()]);
    seedOrders(3);

    setNow("2026-07-20T09:00:00+09:00");
    tick();
    expect(rowsOf("notifications")).toHaveLength(3);

    setNow("2026-07-21T09:00:00+09:00");
    tick();

    // **「この行は昨日処理済み」を覚えていたら、2日目は0件か一部だけになる。**
    // 全件もう一度処理されることが、行単位の台帳がどこにも無いことの実行での証拠である。
    expect(rowsOf("notifications")).toHaveLength(6);
    expect(rowsOf("wf-runs")).toHaveLength(2);
  });

  test("履歴の行を消すと、行選択の発火も同じ日にもう一度走る(発火済みの唯一の源は history_table である)", () => {
    installOrders([sweepOrders()]);
    seedOrders(3);

    setNow("2026-07-20T09:00:00+09:00");
    tick();
    const history = rowsOf("wf-runs");
    expect(history).toHaveLength(1);

    withDb((db) => {
      const result = deleteRecord(db, currentManifest(), "wf-runs", history[0]?._id as string);
      expect(result.ok).toBe(true);
    });

    setNow("2026-07-20T09:05:00+09:00");
    tick();

    // **二重発火する。**行選択でも代償は同じ形で現れる(ADR-0013 §6c 代償2 /
    // ADR-0063 §限界1)。**塞いでいない限界であり、固定しておく。**
    expect(rowsOf("notifications")).toHaveLength(6);
  });

  test("行選択の発火でも、アプリのディレクトリと kernel.sqlite に新しい入れ物が1つも増えない", () => {
    installOrders([sweepOrders()]);
    seedOrders(3);
    const filesBefore = readdirSync(appDir(dataRoot, APP_ID)).sort();
    const tablesBefore = kernelTables();

    setNow("2026-07-20T09:00:00+09:00");
    tick();
    setNow("2026-07-21T09:00:00+09:00");
    tick();

    expect(readdirSync(appDir(dataRoot, APP_ID)).sort()).toEqual(filesBefore);
    expect(kernelTables()).toEqual(tablesBefore);
  });

  test("`workflow-runner.ts` のモジュールスコープの可変状態は今日も4つのままである(行選択のために1つも足していない)", () => {
    // **T01 は `workflow-scheduler.ts` だけを走査した。**行ごとの発火を実際に回すのは
    // `runScheduledWorkflow`(= `workflow-runner.ts`)なので、こちらも固定する。
    const runner = codeOnly(kernelSource("src/kernel/workflow-runner.ts"));
    const lets = runner
      .split("\n")
      .filter((line) => /^(let|var) /.test(line))
      .map((line) => (line.match(/^(?:let|var) (\w+)/) as RegExpMatchArray)[1]);
    expect(lets).toEqual(["historyFailureHandler", "workflowClock", "depth"]);

    // 可変のコレクションはひとつだけ(再発火抑止の集合)。
    const collections = runner
      .split("\n")
      .filter((line) => /^const \w+ = new (Set|Map|Array)/.test(line))
      .map((line) => (line.match(/^const (\w+)/) as RegExpMatchArray)[1]);
    /*
     * **【`V5-M25-T03` / `L-G10` / `ADR-0175` による追随。旧を隠さない】**
     * **旧**: `expect(collections).toEqual(["firedRecords"]);`
     * **2つ目のコレクション `manualRunsInFlight` は `ADR-0175` の「実行中の重複を拒む規則」の
     * 在席台帳である**(`V5-M25-T03`)。**`ADR-0063`(行選択)は今日も1つも足していない** ——
     * **本 test が固定しているのは「行ごとの発火のために可変状態を足していないこと」であり、
     * その主張は1ミリも弱まっていない。**
     * **【正直に書く】この形の検査は「誰が足したか」を区別できない** —— **2つ目が増えた
     * 事実だけを見る。** **区別は本コメントが担っている。**
     */
    expect(collections).toEqual(["firedRecords", "manualRunsInFlight"]);
  });
});

describe("V3-M10-T04 完了条件2: 新設した上限の射程 —— 1回の発火には効き、それ以外には効かない", () => {
  test(
    "上限は「1回の発火あたり」である(同じ tick で2本発火すれば合計は上限を越えて走る)",
    () => {
      // **600 行 × 2本 = 1200 件。**上限(1000)は1本ごとに当たるので、どちらも
      // 打ち切られない —— **1 tick 全体の行数には上限が1つも無い。**
      installOrders([sweepOrders(), { ...sweepOrders(), id: "order-sweep-2" }]);
      seedOrders(600);

      setNow("2026-07-20T09:00:00+09:00");
      tick();

      expect(rowsOf("notifications")).toHaveLength(1200);
      const history = rowsOf("wf-runs");
      expect(history).toHaveLength(2);
      expect(history.every((row) => row.status === "success")).toBe(true);
    },
    HEAVY_ROW_TEST_TIMEOUT_MS,
  );

  test(
    "1本が上限で打ち切られても、同じ tick の別のワークフローは通常どおり発火する",
    () => {
      installOrders([sweepOrders(), dailyNotify(9, 0, "daily-summary")]);
      seedOrders(1001);

      setNow("2026-07-20T09:00:00+09:00");
      tick();

      // 打ち切られた側は1件も作らず、巻き添えも作らない。
      const notifications = rowsOf("notifications");
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.source).toBe("daily");

      const history = rowsOf("wf-runs");
      expect(history).toHaveLength(2);
      expect(history.filter((row) => row.status === "failure")).toHaveLength(1);
      expect(history.filter((row) => row.status === "success")).toHaveLength(1);
    },
    HEAVY_ROW_TEST_TIMEOUT_MS,
  );

  test("1回の発火の実行**時間**には今日も上限が1つも無い(新設したのは行数の上限だけである)", () => {
    // **`v3-m10.md` T04 完了条件2 の「新設しなかった場合は『上限が無い』ことを
    // 検査で固定する」側である。** ADR-0063 限定5 が新設したのは**行数**の上限であって、
    // 経過時間の上限ではない。**1000 行 × `RUN_FUNCTION_LIMITS.timeoutMillis`(1秒)
    // = 最悪 1000 秒**という上界は、今日どこにも塞がれていない(ADR-0063 §限界3)。
    const scheduler = codeOnly(kernelSource("src/kernel/workflow-scheduler.ts"));
    for (const absent of [
      "setTimeout",
      "AbortSignal",
      "AbortController",
      "deadline",
      "performance.now",
      "Date.now",
      "timeoutMillis",
      "elapsed",
    ]) {
      expect(scheduler).not.toContain(absent);
    }
    // タイマーは「周期的に `runSchedulerTick` を呼ぶ」だけの層であって、上限ではない。
    expect(scheduler).toContain("setInterval(");
    // このファイルにある上限は1つだけ(行数)。
    const limits = [...scheduler.matchAll(/const (\w*(?:LIMIT|MAX|TIMEOUT)\w*) =/g)].map(
      (match) => match[1],
    );
    expect(limits).toEqual(["SCHEDULE_ROW_LIMIT"]);
  });
});

describe("V3-M10-T04 完了条件6: 連鎖上限(WORKFLOW_MAX_DEPTH / firedRecords)の意味論が行ごとの発火で壊れていない", () => {
  /**
   * `orders` の各行が `chain` に1行作り、`chain` への create が自分自身を作り続ける。
   * **`note` は行の `code` を引き継ぐ**ので、どの行が始めた連鎖かが数えられる。
   */
  function installRowChain(): void {
    const manifest = manifestWithOrders([]);
    manifest.app.tables.push({
      id: "chain",
      name: "連鎖",
      fields: [{ id: "note", name: "メモ", type: "text" }],
    });
    manifest.app.workflows = [
      {
        id: "order-kickoff",
        name: "行ごとに連鎖を始める",
        trigger: { type: "schedule", at: { hour: 9, minute: 0 }, table: "orders" },
        actions: [{ action: "create_record", table: "chain", values: { note: "$record.code" } }],
        history_table: "wf-runs",
      },
      {
        id: "self-chain",
        name: "自分自身を作り続ける(note を引き継ぐ)",
        trigger: { type: "on_create", table: "chain" },
        actions: [{ action: "create_record", table: "chain", values: { note: "$record.note" } }],
        history_table: "wf-runs",
      },
    ];
    const applied = applyManifest(dataRoot, APP_ID, manifest);
    expect(applied.valid).toBe(true);
  }

  test("行ごとの連鎖は同じ深度の予算を持つ(3行とも同じ段数まで進み、後の行が浅くならない)", () => {
    installRowChain();
    seedOrders(3);

    setNow("2026-07-20T09:00:00+09:00");
    tick();

    // 【V3-M13-T02 / ADR-0066 による期待値の更新】上限到達が「失敗」になり(限定16)、
    // **行ごとの連鎖が書いた行は1行も残らない。**したがって
    // 「後の行ほど浅くなっていないか」を**行数では観測できなくなった。**
    // 観測できるのは「3行とも同じ止まり方をしたこと」だけである(履歴の失敗の文面)。
    const perRow = ["o-0000", "o-0001", "o-0002"].map(
      (code) => rowsOf("chain").filter((row) => row.note === code).length,
    );
    expect(perRow).toEqual([0, 0, 0]);

    // **黙って止まっていない。**行ごとに上限到達が失敗として履歴に残る
    // (`schedule` の履歴は巻き戻らない = 限定7)。1回の発火につき履歴は1行なので、
    // **3行ぶんの失敗が1行の中に畳まれている**(ADR-0063 限定4)。
    // 【V3-M13-T04 による期待値の更新】連鎖の各段の失敗も書き直されて残るようになったので
    // (ADR-0066 限定5)、**`schedule` の発火そのものの1行**を `trigger_type` で選ぶ。
    const stopped = rowsOf("wf-runs").filter(
      (row) =>
        row.trigger_type === "schedule" &&
        row.status === "failure" &&
        String(row.error).includes(String(WORKFLOW_MAX_DEPTH)),
    );
    expect(stopped).toHaveLength(1);
    // 3行ぶんの失敗が「レコード "<_id>": …」の形で並び、**どれも深度上限で止まっている。**
    const segments = String(stopped[0]?.error)
      .split(/\n(?=レコード ")/)
      .filter((part) => part.startsWith('レコード "'));
    expect(segments).toHaveLength(3);
    for (const segment of segments) {
      expect(segment).toContain(String(WORKFLOW_MAX_DEPTH));
    }
  });

  test("深度は発火のたびに戻る(翌日の発火も同じだけ進む)", () => {
    installRowChain();
    seedOrders(2);

    setNow("2026-07-20T09:00:00+09:00");
    tick();
    const firstDay = rowsOf("chain").length;

    setNow("2026-07-21T09:00:00+09:00");
    tick();

    expect(rowsOf("chain").length - firstDay).toBe(firstDay);
  });
});

describe("V3-M10-T04 完了条件6: `firedRecords` の意味論 —— 「1回の操作」は1回の発火の全行である", () => {
  /**
   * `orders` の各行が **同じ `products` の行** を参照し、行ごとに `update_record` で
   * その1行を更新する。**在庫の引き当て / 戻しが採るはずだった形と同じ**である
   * (`D-G15` は保留3回目で実装0バイトなので、ここで測るのは既存機構の意味論だけである)。
   */
  function installSharedTarget(orderCount: number, sharedProduct: boolean): string[] {
    const manifest = manifestWithOrders([]);
    manifest.app.tables.push({
      id: "products",
      name: "商品",
      fields: [{ id: "label", name: "名前", type: "text" }],
    });
    const orders = manifest.app.tables.find((table) => table.id === "orders");
    (orders as { fields: unknown[] }).fields.push({
      id: "product",
      name: "商品",
      type: "reference",
      reference_table: "products",
    });
    manifest.app.workflows = [
      {
        id: "order-sweep",
        name: "行ごとに参照先の商品を更新する",
        trigger: { type: "schedule", at: { hour: 9, minute: 0 }, table: "orders" },
        actions: [
          {
            action: "update_record",
            table: "products",
            target: "$record.product",
            values: { label: "touched" },
          },
        ],
        history_table: "wf-runs",
      },
      {
        id: "product-watch",
        name: "商品が更新されたら通知する",
        trigger: { type: "on_update", table: "products" },
        actions: [
          {
            action: "create_record",
            table: "notifications",
            values: { title: "$record.label", source: "watch" },
          },
        ],
        history_table: "wf-runs",
      },
    ];
    const applied = applyManifest(dataRoot, APP_ID, manifest);
    expect(applied.valid).toBe(true);

    const current = currentManifest();
    const productIds: string[] = [];
    withDb((db) => {
      for (let i = 0; i < (sharedProduct ? 1 : orderCount); i += 1) {
        const created = createRecord(db, current, "products", { label: `p-${i}` });
        if (!created.ok) {
          throw new Error(`テスト前提の商品投入に失敗しました: ${JSON.stringify(created.errors)}`);
        }
        productIds.push(String(created.value._id));
      }
      for (let i = 0; i < orderCount; i += 1) {
        const created = createRecord(db, current, "orders", {
          code: `o-${String(i).padStart(4, "0")}`,
          status: "pending",
          product: sharedProduct ? productIds[0] : productIds[i],
        });
        if (!created.ok) {
          throw new Error(`テスト前提の注文投入に失敗しました: ${JSON.stringify(created.errors)}`);
        }
      }
    });
    return productIds;
  }

  test("別々の行を更新する連鎖は互いを抑止しない(3行 → 3件の on_update が発火する)", () => {
    installSharedTarget(3, false);

    setNow("2026-07-20T09:00:00+09:00");
    tick();

    expect(rowsOf("notifications")).toHaveLength(3);
    // schedule 1行 + on_update 3行。抑止による失敗は1件も無い。
    const history = rowsOf("wf-runs");
    expect(history.filter((row) => row.status === "failure")).toHaveLength(0);
  });

  test("2行が**同じ行**を更新すると、2件目の連鎖は再発火抑止で止まり、履歴に loud に残る", () => {
    const [productId] = installSharedTarget(2, true);

    setNow("2026-07-20T09:00:00+09:00");
    tick();

    // **更新そのものは2回とも通る**(抑止が止めるのは連鎖の発火である)。
    // **on_update の発火は1回だけ**である —— `firedRecords` は行を鍵に持ち、
    // その集合は「1回の操作」= **この発火の全行**にわたって共有されるためである。
    expect(rowsOf("notifications")).toHaveLength(1);

    // 【V4-M4-T02 / ADR-0072 による期待値の更新】抑止の履歴行の `status` が3値目になった。
    // **`:1853` の `toHaveLength(0)`(抑止による失敗が0件)は3値目にしても0件のまま緑で
    // 静かに素通りするので、ADR-0072 §限界5 の指示どおり本検査も対象に取っている。**
    const suppressed = rowsOf("wf-runs").filter(
      (row) => row.status === "suppressed" && String(row.error).includes("再発火を抑止"),
    );
    expect(suppressed).toHaveLength(1);
    expect(String(suppressed[0]?.error)).toContain(String(productId));

    /*
     * **これは V3-M10 が作った限界ではなく、既存の意味論が行ごとの発火に及んだ結果である。**
     * 隠さずに書く: 行ごとに同じ1行を更新する形(在庫の引き当て / 戻しがまさにこの形)
     * では、**2件目以降の下流ワークフローは発火しない。** 黙って消えはしない
     * (履歴に失敗として残る)が、**塞いでもいない。**
     */
  });

  test("`firedRecords` は発火の終わりに空へ戻る(翌日の発火は抑止されない)", () => {
    installSharedTarget(2, true);

    setNow("2026-07-20T09:00:00+09:00");
    tick();
    expect(rowsOf("notifications")).toHaveLength(1);

    setNow("2026-07-21T09:00:00+09:00");
    tick();

    // 戻っていなければ2日目の on_update は1件も発火しない。
    expect(rowsOf("notifications")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// V3-M13-T03: `schedule` は原子性を保証しない(ADR-0066 限定7)
//
// **`src/kernel/workflow-scheduler.ts` に1バイトも足していない。**
// `ADR-0066` 限定7 の逐語: 「**`schedule` の原子性の単位は「原子性を保証しない」** |
// `src/kernel/workflow-scheduler.ts` に1バイトも足さない。tick / アプリ / ワークフロー /
// 行のどの単位にも tx を張らない | 同ファイルの `git diff --numstat` が空 /
// **`schedule` の途中失敗で部分適用が残ることを固定するテスト**」。
//
// **本節は「一致しない経路が残る」ことを固定する検査である。** `ADR-0003` §7(入口を
// 何本生やしても振る舞いが一致する)は、`schedule` については本 ADR の後も成り立たない
// (`ADR-0066` §限界1 の逐語「**「一様になった」と書いてはならない。**」)。
//
// `workflow-runner.test.ts` の同名の検査は `runScheduledWorkflow` を直接呼ぶ。
// **こちらは `runSchedulerTick`(= `schedule` の本物の入口)から測る。**
// ---------------------------------------------------------------------------

describe("V3-M13-T03: `schedule` は入口から見ても巻き戻らない(ADR-0066 限定7)", () => {
  test("途中失敗しても、先に成功したアクションの書込が残る(部分適用)", () => {
    install([
      {
        ...dailyNotify(9, 0),
        actions: [
          // 1本目は成功する。2本目は `must`(required)を与えないので必ず失敗する。
          {
            action: "create_record",
            table: "notifications",
            values: { title: "先に成功する", source: "daily" },
          },
          { action: "create_record", table: "strict", values: { note: "後で失敗する" } },
        ],
      },
    ]);

    setNow("2026-07-20T09:00:00+09:00");
    tick();

    // **成功した側の書込が残る**(発火全体は原子的にならない)。
    expect(rowsOf("notifications").map((row) => row.title)).toEqual(["先に成功する"]);
    expect(rowsOf("strict")).toHaveLength(0);
    // 失敗は履歴に残る(`schedule` の履歴は巻き戻らないので消えない)。
    const history = rowsOf("wf-runs");
    expect(history).toHaveLength(1);
    expect(history[0]?.status).toBe("failure");
  });

  test("但し書き: アクションが行うレコード書込1件だけは、その行の on_create が失敗すれば巻き戻る", () => {
    // `schedule` → notifications に1件書く。その `on_create` が必ず失敗する。
    install([
      {
        ...dailyNotify(9, 0),
        actions: [
          {
            action: "create_record",
            table: "notifications",
            values: { title: "書けない", source: "daily" },
          },
        ],
      },
      {
        id: "notification-fails",
        name: "通知の on_create が失敗する",
        trigger: { type: "on_create", table: "notifications" },
        actions: [{ action: "create_record", table: "strict", values: { note: "x" } }],
        history_table: "wf-runs",
      },
    ]);

    setNow("2026-07-20T09:00:00+09:00");
    tick();

    // **その1件の書込だけが成立しない**(`records.ts` の器が効いている)。
    expect(rowsOf("notifications")).toHaveLength(0);
    // **`schedule` の発火自体は巻き戻らない** —— 失敗が履歴に残っていることがその証拠である。
    const failures = rowsOf("wf-runs").filter((row) => row.status === "failure");
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.some((row) => row.trigger_type === "schedule")).toBe(true);
  });

  test("`schedule` は失敗しても発火済みとして扱われ、その日は再実行されない(部分適用が残ったまま)", () => {
    install([
      {
        ...dailyNotify(9, 0),
        actions: [
          {
            action: "create_record",
            table: "notifications",
            values: { title: "1回だけ残る", source: "daily" },
          },
          { action: "create_record", table: "strict", values: { note: "毎回失敗する" } },
        ],
      },
    ]);

    setNow("2026-07-20T09:00:00+09:00");
    tick();
    setNow("2026-07-20T09:05:00+09:00");
    tick();
    setNow("2026-07-20T23:00:00+09:00");
    tick();

    // **部分適用は1回ぶん残り、しかも再実行では直らない**(発火済み判定は失敗でも立つ)。
    expect(rowsOf("notifications")).toHaveLength(1);
    expect(rowsOf("wf-runs")).toHaveLength(1);
  });
});
