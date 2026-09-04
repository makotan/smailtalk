/**
 * `schedule` トリガーの実行基盤(V1-M2-T08 単位2 / ADR-0013 §6)。
 *
 * ## 一文で言うと
 *
 * **周期的に「今が何時か」を見て、アクティブなアプリのマニフェストを読み、
 * 発火すべきワークフローを実行する。それだけである。**
 *
 * ## **登録簿を持たない**(ADR-0013 限定7 / §6a)
 *
 * このファイルはテーブルもファイルも1つも作らない。モジュールスコープに
 * 「どのワークフローをいつ発火したか」を1バイトも持たない。**発火の根拠は毎回
 * `_apps.status === "active"` と `manifest.json` の読み取りだけ**であり、
 * **発火済みかどうかは実行履歴テーブル(`app.sqlite` の通常テーブル)から導く。**
 *
 * この形が得るもの(§6a の性質表そのもの):
 *
 * | 性質 | ここでの実装 |
 * |---|---|
 * | 同期ずれが起きない | 登録という中間状態が無い。毎 tick で現行マニフェストを読み直す |
 * | undo がスケジュールにも効く | 根拠が `manifest.json` と `app.sqlite` にしかない。undo はその両方を戻す |
 * | アプリの停止が発火の停止と一致する | `status !== "active"` を読み飛ばす |
 * | 発火の根拠が情報の中にある | 上記3つの帰結 |
 *
 * ## 発火済み判定(§6c)—— **新しい状態を1バイトも作らない**
 *
 * 「このワークフローが**今日**すでに発火したか」を、履歴テーブルを
 * 「`workflow` = そのID かつ `ran_at` が今日」で読んで決める。
 * **「今日」の境界はタイムゾーン(判断1。`ST_TIMEZONE`、既定 `Asia/Tokyo`)で決まる。**
 *
 * **ADR が既に申告している代償を、実装もそのまま持っている**(隠さない):
 *
 * 1. **読み取りコストが履歴の行数に比例する。** ワークフロー1本の判定ごとに、その
 *    履歴テーブルを1回スキャンする。**インデックスは張れない** —— カーネルはユーザの
 *    テーブルに DDL を足さない(限定8)ので、`workflow` 列に索引を作る手段が無い。
 *    §6c 代償1 は「インデックスが要る」と書いたが、**限定8 と両立しないので張っていない。**
 * 2. **ユーザが履歴の行を消すと二重発火する。** `delete_record` で消せる通常テーブルに
 *    判定を預けているためである。**塞いでいない。**テストで固定してある
 *    (`workflow-scheduler.test.ts` の完了条件10)。
 *
 * ## 例外を1つも投げない(完了条件5)
 *
 * `runSchedulerTick` は**全域関数である。**壊れたアプリが1つあっても、他のアプリの
 * 発火は止まらない。**`src/server/index.ts` の `recover` の `process.exit(1)` を
 * 真似ない** —— あちらは「未完了の適用が残ったまま起動する」ことがデータの誤読を
 * 生むから落とすのであって、**タイマーの1回の失敗は起動を止める理由にならない。**
 * 黙って止まりもしない(憲法6): 失敗は `console.error` に理由を出す。
 */
import { Database } from "bun:sqlite";
import { readCurrentManifest } from "./apply-manifest.ts";
import { type Clock, zonedNow } from "./clock.ts";
import { quoteIdentifier } from "./ddl.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { listRecords, type RecordRow } from "./records.ts";
import { isApplyInProgress } from "./recovery.ts";
import { appDbPath } from "./storage-paths.ts";
import type { Manifest, ScheduleAt, Workflow } from "./types.ts";
import { getWorkflowClock, runScheduledWorkflow } from "./workflow-runner.ts";

/**
 * タイマーの周期(ミリ秒)。**30 秒。**
 *
 * ## なぜ 30 秒か —— **正しさの条件ではなく、遅れの上限である**
 *
 * 発火の判定は「**その TZ の今日、発火時刻を過ぎていて、まだ今日発火していない**」
 * であって「発火時刻ちょうどを観測したか」ではない(判断2)。**したがって周期を
 * 何秒にしても発火は落ちない** —— 落ちるのは*即時性*だけである。
 *
 * `at` の粒度が「分」なので、**周期を分より短く採れば、遅れは必ず1分未満になる。**
 * 30 秒はその条件を満たす最も素直な値である。1 秒まで詰める理由は無い
 * (毎秒すべてのアプリのマニフェストと履歴を読むのは代償1 をそのぶん重くする)。
 *
 * **差し替える口を置かない**(T03 判断4 と同じ規律)。実行時に周期を動かせると、
 * 「本番で実際にどれだけ遅れるのか」がコードを読んでも決まらなくなる。
 */
export const SCHEDULER_TICK_INTERVAL_MS = 30_000;

/**
 * **1回の発火で処理する行数の上限**(`D-G16a` / ADR-0063 限定5)。
 *
 * ## これは「非退行」ではなく**新規追加**である
 *
 * 着手時点で、1回の発火の実行時間にも行数にも上限は**1つも無かった**
 * (このファイルに `setTimeout` / `AbortSignal` / `deadline` / `performance.now` /
 * `Date.now` は0件)。上限があるのは島だけで、`RUN_FUNCTION_LIMITS`
 * (`workflow-runner.ts`)は**1アクション1回あたり**である。
 * `trigger.table` で行を対象にすると実行時間が行数に比例し、
 * **`runSchedulerTick` は server プロセス内で同期実行される**(`src/server/index.ts`)ので、
 * 本体の HTTP を止めうる。そこでここに上限を新設した。
 *
 * ## なぜ「時間」ではなく「行数」で切ったか(ADR-0063 §6-3)
 *
 * 1. **行数は決定的で、時間は非決定的である。** 決定性は undo と再現性の前提である
 *    (ADR-0024 限定8)。
 * 2. **時間で切るとこのファイルに経過時間の計測(= 開始時刻という新しい状態)が入る。**
 *    今日そのファイルにその種のものは0件である(限定4 が禁じた「状態」に近づく)。
 * 3. **1アクションあたりの時間は島側で既に抑えられている**(`RUN_FUNCTION_LIMITS`)。
 *
 * ## 超えたときの振る舞い —— **打ち切る。次回に回さない。**
 *
 * 対象行が上限を超えたら、その発火は**アクションを1件も実行せず**、履歴に
 * **失敗として loud に残す**(憲法6)。**「先頭 1000 行だけ処理して残りを次回に回す」を
 * 採らない** —— 回すには「どこまで処理したか」を覚える必要があり、それは
 * ADR-0063 限定4(カーネルは登録簿を持たない)が禁じたものである。
 *
 * ## 値 `1000` の根拠は**実測ではなく設計上の上界**である(隠さない)
 *
 * 「1000 行なら server の HTTP が止まらない」ことは測っていない(ADR-0063 §限界3)。
 *
 * **差し替える口を置かない**(`SCHEDULER_TICK_INTERVAL_MS` と同じ規律)。
 * **export しない**(Δ8 を発火させない。限定5)。
 */
const SCHEDULE_ROW_LIMIT = 1000;

/** スケジューラの動作条件。**状態は1つも持たない。** */
export type WorkflowSchedulerOptions = {
  /** `kernel.sqlite` と `apps/` があるデータルート。 */
  dataRoot: string;
  /**
   * 「今日」と「今何時か」を決めるタイムゾーン(判断1)。
   *
   * **`resolveTimeZone` を通した値であること。**未検証の値を渡すと `Intl` が
   * `RangeError` を投げる —— それは設定の誤りであって、握りつぶす対象ではない
   * (`src/server/index.ts` が起動時に検証して落とす)。
   */
  timeZone: string;
};

/** 動いているスケジューラの取っ手。**止める以外にできることは無い。** */
export type WorkflowSchedulerHandle = {
  /** タイマーを止める。**何度呼んでも安全である。** */
  stop(): void;
};

/**
 * 診断の出力先は `console.error`(`src/server/index.ts:30` の規約。stdout に書かない)。
 *
 * **これはユーザには届かない。**`workflow-runner.ts` の
 * `defaultHistoryFailureHandler` と全く同じ限界であり(§2-2 判断1)、
 * **M2 の申し送りも同じ1件に合流する。**別の通知経路をここで発明しない。
 */
function report(message: string, error?: unknown): void {
  console.error(`[workflow-scheduler] ${message}`);
  if (error !== undefined) {
    console.error(error);
  }
}

/**
 * タイマーを起動する。**返るまでにファイルもDBも1つも開かない。**
 *
 * **起動時に1回発火させない。**そうすると `src/server/index.ts` の起動が
 * 「1バイトも書き換えない」ではなくなり(`src/server/index.test.ts` の
 * 「正常時の無副作用」がまさにそれを固定している)、**起動そのものが新しい
 * 故障点になる。**最初の tick は `SCHEDULER_TICK_INTERVAL_MS` 後である。
 * 遅れは判断2 のとおり同日内なら回収されるので、失われるものは無い。
 */
export function startWorkflowScheduler(options: WorkflowSchedulerOptions): WorkflowSchedulerHandle {
  const timer = setInterval(() => {
    // `runSchedulerTick` は全域関数だが、**将来それが崩れてもプロセスを道連れに
    // しない**ように二重に受ける。タイマーのコールバックから例外が漏れると
    // Node/Bun は uncaught exception としてプロセスを落とす。
    try {
      runSchedulerTick(options);
    } catch (error) {
      report("スケジューラの周期処理が失敗しました(次の周期で再試行します)。", error);
    }
  }, SCHEDULER_TICK_INTERVAL_MS);

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}

/**
 * 1周期ぶんの処理。**例外を投げない(完了条件5)。**
 *
 * **同期関数である。**`await` も `Promise` も1つも使わない —— これが
 * `workflow-runner.ts` の `depth` を壊さない条件そのものである
 * (`runScheduledWorkflow` の doc に理由を書いた)。
 *
 * 公開しているのは**テストがタイマーを待たずに周期処理そのものを呼べるようにする**
 * ためである。実時間を待つテストを1つも書かない、という計画の絶対条件
 * (`docs/plan/v1/02-workflow.md:165`)を満たす唯一の形である。
 */
export function runSchedulerTick(options: WorkflowSchedulerOptions): void {
  const clock = getWorkflowClock();
  let apps: { app_id: string; status: string }[];
  let now: { date: string; hour: number; minute: number };
  try {
    // **壁時計を先に1回だけ読む。**1周期の中で日付や時刻がずれないようにするため
    // であり、アプリごとに読み直すと、境界(23:59:59)を跨いだときに片方のアプリだけ
    // 翌日として扱われる。
    now = zonedNow(clock, options.timeZone);
    apps = listActiveApps(options.dataRoot);
  } catch (error) {
    report(`アプリ台帳を読めませんでした(dataRoot=${options.dataRoot})。`, error);
    return;
  }

  // **1アプリずつ、同期のループで回す。**`Promise.all` で並行にしてはならない ——
  // `workflow-runner.ts` の深度カウンタはモジュールスコープにあり、2つの発火が
  // 同時に走ると片方の `finally` がもう片方の深度を戻す(`depth` の doc の警告)。
  // 順序は `listApps()` の順、すなわち **created_at 昇順(同時刻なら登録順)**である。
  for (const app of apps) {
    try {
      runAppSchedules(options, app.app_id, now);
    } catch (error) {
      // **1つのアプリの故障で、他のアプリの発火を止めない。**
      report(`アプリ "${app.app_id}" のスケジュール処理に失敗しました。`, error);
    }
  }
}

/** アクティブなアプリだけを、台帳の順序で返す(完了条件8)。 */
function listActiveApps(dataRoot: string): { app_id: string; status: string }[] {
  const store = KernelMetaStore.open(dataRoot);
  try {
    // **`archived` を読み飛ばす。**ADR-0013 §6a 性質3 —— アプリの停止が発火の停止と
    // 一致することを、新しい概念を1つも足さずに得ている。
    return store.listApps().filter((app) => app.status === "active");
  } finally {
    store.close();
  }
}

/** 1アプリぶんの処理。**マニフェストを毎回読み直す**(完了条件7)。 */
function runAppSchedules(
  options: WorkflowSchedulerOptions,
  appId: string,
  now: { date: string; hour: number; minute: number },
): void {
  // **ここが「登録簿を持たない」の実体である。**前回何を読んだかを覚えていないので、
  // マニフェストが変われば次の tick から新しい内容で判定する。登録解除の手続きは無い。
  const manifest = readCurrentManifest(options.dataRoot, appId);
  const due = (manifest.app.workflows ?? []).filter(
    (workflow) => workflow.trigger.type === "schedule" && isDue(workflow.trigger.at, now),
  );
  if (due.length === 0) {
    // **合致が無いなら `app.sqlite` を開かない。**発火しないアプリに対して
    // ファイルを1つも開かないのは `recovery.ts` と同じ姿勢である。
    return;
  }

  // **適用中(apply 窓)ならこの tick はこのアプリをスキップして譲る**(V1-M9-T02 / ADR-0017 / M2)。
  // `app.sqlite` を開いて履歴を書く直前に確かめる。スキップしても `isDue` は「今日過ぎたか」
  // だけを見るので、次の周期で同じワークフローが再び due になり、**何も失われない**。
  // すり抜けた稀レース(このチェック通過後に apply 開始)はロック先着で SQLITE_BUSY になり、
  // スケジューラが負ければ次周期で再試行される(fail-safe)。
  const applying = isApplyInProgress(options.dataRoot, appId);
  if (applying.inProgress) {
    report(
      `アプリ "${appId}" は変更を適用中(開始 ${applying.startedAt ?? "不明"})のため、` +
        `この周期のスケジュール発火を見送ります(次の周期で再判定します)。`,
    );
    return;
  }

  const db = new Database(appDbPath(options.dataRoot, appId), { readwrite: true, create: false });
  try {
    // **1ワークフローずつ、同期のループ。**(並行にしない理由は `runSchedulerTick` に同じ。)
    for (const workflow of due) {
      try {
        if (firedOn(db, workflow, now.date, options.timeZone)) {
          continue;
        }
        runScheduledWorkflow(
          db,
          manifest,
          workflow,
          selectTargets(db, manifest, workflow, now.date, options.timeZone),
        );
      } catch (error) {
        // **1本の故障で、同じアプリの他のワークフローを止めない。**
        report(`アプリ "${appId}" のワークフロー "${workflow.id}" を発火できませんでした。`, error);
      }
    }
  } finally {
    db.close();
  }
}

/**
 * **どの行を対象にするか**を決める(`D-G16a` / ADR-0063 §Decision 1)。
 *
 * - `trigger.table` が無い `schedule` … `undefined` を返す。**今日と1バイトも変わらない**
 *   (トリガー元レコード無しで1回だけ実行する)。
 * - `trigger.table` が在る `schedule` … 対象表の行を読んで返す。順序は `listRecords` の
 *   既定(`_created_at` 昇順・同時刻なら `_id` 昇順)であり、**発火のたびに同じ順序である。**
 * - 行数が `SCHEDULE_ROW_LIMIT` を超える … 打ち切りの理由を返す(限定5)。
 *   **上限 + 1 件だけ読んで判定する** —— 全件読んでから数えると、上限を置いた意味が薄れる。
 *
 * **状態を1バイトも持たない。**「どの行を処理したか」はどこにも残さない(限定4)。
 * 読み取りに失敗したら**打ち切りとして履歴に失敗を残す** —— 例外を投げて呼び出し元に
 * 握らせると履歴が1行も残らず、`firedOn` が「まだ発火していない」と読んで
 * **毎周期同じ失敗を繰り返す**(`firedOn` の doc が同じ理由を書いている)。
 *
 * ## `trigger.older_than` —— 「一定時間経った行」だけに絞る(`D-G16b` / ADR-0064)
 *
 * **上限の判定より**後**に効く。**読み取りは今日どおり `SCHEDULE_ROW_LIMIT + 1` 件で、
 * 上限を超えていれば述語を1件も評価せずに打ち切る —— **ADR-0064 は上限を1バイトも
 * 変えない**(限定3 / §2 の (e))。したがって「述語で絞れば上限を越えられる」ことは無い。
 *
 * **発火の可否には1ミリも影響しない。**ここは「発火したとき、どの行を対象にするか」
 * だけを決める。`isDue` は1バイトも変えていない(限定3)。
 */
function selectTargets(
  db: Database,
  manifest: Manifest,
  workflow: Workflow,
  today: string,
  timeZone: string,
): { records: RecordRow[] } | { abort: string } | undefined {
  const trigger = workflow.trigger;
  if (trigger.type !== "schedule" || trigger.table === undefined) {
    return undefined;
  }

  // **上限 + 1 件読む。**ちょうど上限なら通り、1件でも超えれば打ち切る。
  const result = listRecords(db, manifest, trigger.table, { limit: SCHEDULE_ROW_LIMIT + 1 });
  if (!result.ok) {
    return {
      abort:
        `対象テーブル "${trigger.table}" の行を読めませんでした` +
        `(この発火は行を1件も処理していません): ` +
        result.errors.map((error) => error.message).join(" / "),
    };
  }
  if (result.value.length > SCHEDULE_ROW_LIMIT) {
    return {
      abort:
        `対象テーブル "${trigger.table}" の行数が1回の発火の上限(${SCHEDULE_ROW_LIMIT} 行)を超えたため、` +
        `この発火を打ち切りました(行を1件も処理していません)。` +
        `処理されなかった行は次回に持ち越されません —— ` +
        `「どこまで処理したか」をカーネルは1バイトも覚えないためです(ADR-0063 限定4 / 限定5)。` +
        `対象の行数を減らすか、ワークフローを分けてください。`,
    };
  }

  const olderThan = trigger.older_than;
  if (olderThan === undefined) {
    return { records: result.value };
  }
  // **境界は `>=`(「ちょうど N 日」を含む)。**`cutoff` は「その日以前なら対象」の日付。
  const cutoff = shiftDays(today, -olderThan.days);
  return {
    records: result.value.filter((record) => {
      const day = toZonedDate(record[olderThan.field], timeZone);
      // **判定できない行(値が無い / 日付として読めない)は対象にしない。**
      // 「経ったかどうか分からない行」を打ち切るのは、憲法6 の逆を行くことになる。
      return day !== undefined && day <= cutoff;
    }),
  };
}

/**
 * `YYYY-MM-DD` を暦日で `delta` 日ずらす(`D-G16b` / ADR-0064)。
 *
 * **UTC の暦で計算する。**`today` は既に `zonedNow`(= `ST_TIMEZONE`)が作った
 * その TZ の暦日であり、ここでやるのは**暦日どうしの引き算**だけである ——
 * 瞬間を跨がないので夏時間の影響を受けない。`Date.UTC` は月・年の繰り下がりを
 * そのまま扱う(7/02 の3日前は 6/29)。
 *
 * **「経過時間」の計算をここ以外に置かない** —— 置くと `ST_TIMEZONE` の効き方が
 * 場所ごとに分かれる。
 */
function shiftDays(date: string, delta: number): string {
  const [year, month, day] = date.split("-").map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    /*
     * `zonedNow` が作る形(`YYYY-MM-DD`)以外は来ない。**それでも fail-closed に倒す**
     * —— どの実在の日付よりも小さい文字列を返すので、`day <= cutoff` は1行も真に
     * ならない。「基準日が分からないまま行を打ち切る」ことだけは起こさない
     * (throw もしない —— 投げると履歴が1行も残らず毎周期リトライになる)。
     */
    return "0000-00-00";
  }
  return new Date(Date.UTC(year, month - 1, day + delta)).toISOString().slice(0, 10);
}

/**
 * 発火時刻に**到達したか**(判断2)。
 *
 * **「ちょうど一致したか」ではなく「過ぎたか」で見る。**サーバが止まっていて
 * 09:00 を1度も観測しなかった日でも、**同じ日のうちに起きれば遅れて発火する。**
 * 逆に**日をまたいだ分は失われる** —— 「今日発火したか」しか判定しない設計
 * (§6c)の直接の帰結であり、昨日ぶんを取り戻す手段は、昨日の予定を覚えておく
 * 台帳(= 限定7 が禁じたもの)を要求する。**取り戻さないことを選んだ。**
 */
function isDue(at: ScheduleAt, now: { hour: number; minute: number }): boolean {
  return now.hour * 60 + now.minute >= at.hour * 60 + at.minute;
}

/**
 * **このワークフローが、その TZ の「今日」すでに発火したか**(§6c)。
 *
 * 履歴テーブルを `workflow` 列で絞り、`ran_at` を壁時計の日付に直して比べる。
 *
 * 【`V8-M42` / `F-G15` / [`ADR-0333`](../../docs/adr/0333-schedule-empty-run-refire.md)。
 * **旧の4行を逐語で残す。1バイトも書き換えていない**】
 *
 * > **`status` を見ない** —— 失敗した発火も「発火した」である。成功だけを数えると、
 * > 失敗するワークフローが**その日じゅう毎周期リトライされ**、部分的に成功した
 * > 副作用(1つ目のアクションだけ通る、など)が積み上がる。
 * > **止めたことの記録(`stopAll`)も同じ扱いだが、`schedule` の発火は常に `depth === 0`
 * > から始まるので、そこで上限に当たることはない。**
 *
 * **今日は `status` を見る。ただし見るのは4値目 `"no_target"` の1値だけである。**
 * **上の4行が守っていた「失敗した発火も『発火した』である」は1バイトも変わっていない** ——
 * **`"failure"` の行も `"suppressed"` の行も、今日どおり「今日発火した」として数える。**
 * **除くのは「対象0件で1件も処理しなかった発火」の行だけである**(`ADR-0333` 限定2) ——
 * **`v8-m33.md` §1-A の `A-7`(逐語)「台を組んでいる最中に、対象0件で発火した。`firedOn` は
 * `status` を見ないので、今日もう発火しない」がその実測である。**
 * **上の段落が警戒した「その日じゅう毎周期リトライされる」は、対象が永遠に0件のワークフローについては
 * 今日**実際に起きる** —— **回数の上限は作っていない**(`ADR-0333` 限定4。`v8-m35.md` §5-4 の
 * `S3` の2点目が自認したとおりである)。 **【禁止】これを「起きない」と書かない。**
 * **副作用が積み上がらないのは、空撃ちがアクションを1件も実行していないからである。**
 *
 * `ran_at` が日付として読めない行は**「今日ではない」として扱う。**
 * 読めない値は `ran_at` の規約(ISO8601)から外れており、それを「今日」と
 * みなすと**発火が静かに落ちる。**落とすより二重に発火する方が、まだ見える。
 *
 * @throws 履歴テーブルが実在しない / `workflow` 列や `ran_at` 列が無い場合。
 *   **握りつぶさない** —— 呼び出し元が捕まえて `console.error` に出し、
 *   **その発火は見送る。**判定できないまま発火すると、書き込みも同じ理由で失敗し、
 *   履歴が残らず、**毎周期アクションだけが実行され続ける。**
 */
function firedOn(db: Database, workflow: Workflow, today: string, timeZone: string): boolean {
  // 履歴テーブル名は参照整合性が「実在すること」だけを保証している(形は保証しない)。
  // 識別子は必ず検証して引用する(`ddl.ts` と同じ作法)。
  const table = quoteIdentifier(workflow.history_table);

  // **列の実在を先に確かめる。SQL に判定させない。**
  // SQLite は「二重引用符で囲まれた名前が列として解決できないとき、文字列リテラルとして
  // 解釈する」という互換仕様を持つ(実測: bun 1.3.14 の bun:sqlite)。したがって
  // `WHERE "workflow" = ?` は、`workflow` 列が無いと**エラーにならず、常に偽になる。**
  // **そのまま通すと「まだ発火していない」と読めてしまい、毎周期発火し続ける** ——
  // しかも履歴は同じ理由で1行も書けないので、**副作用だけが積み上がり、記録が残らない。**
  // 憲法6 に正面から反するので、**判定できないことを判定できないと言う。**
  const columns = new Set(
    db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name),
  );
  for (const required of ["workflow", "ran_at"]) {
    if (!columns.has(required)) {
      throw new Error(
        `ワークフロー "${workflow.id}" の履歴テーブル "${workflow.history_table}" に ` +
          `"${required}" 列がありません。schedule トリガーは「今日すでに発火したか」を` +
          `この列から判定するため、列が揃うまでこのワークフローは発火しません。` +
          `履歴テーブルの5列(ran_at / workflow / trigger_type / status / error)を確認してください。`,
      );
    }
  }

  /*
   * 【`V8-M42` / `F-G15` / `ADR-0333`。**旧の4行を逐語で残す**】
   *
   *     const rows = db
   *       .query<{ ran_at: unknown }, [string]>(`SELECT "ran_at" FROM ${table} WHERE "workflow" = ?`)
   *       .all(workflow.id);
   *     return rows.some((row) => toZonedDate(row.ran_at, timeZone) === today);
   *
   * **足したのは `status` 1列の読み取りと、4値目の行を除く1つの述語だけである。**
   * **`status` 列を持たない履歴テーブルでは、照会も述語も着手前と1バイトも変わらない** ——
   * **必須列は今日も `workflow` / `ran_at` の2列だけである**(上の `for` を1バイトも変えていない)。
   * **`status` を必須にすると、5列規約を満たさない既存アプリがその日から発火しなくなる**
   * (`v8-m35.md` §5-4 の `S3` の1点目)。**そのぶん判定は緩い** —— **`status` 列が無ければ
   * 空撃ちは今日どおり「発火済み」になる。塞いでいない。**
   */
  const rows = columns.has("status")
    ? db
        .query<{ ran_at: unknown; status: unknown }, [string]>(
          `SELECT "ran_at", "status" FROM ${table} WHERE "workflow" = ?`,
        )
        .all(workflow.id)
    : db
        .query<{ ran_at: unknown }, [string]>(`SELECT "ran_at" FROM ${table} WHERE "workflow" = ?`)
        .all(workflow.id)
        .map((row) => ({ ran_at: row.ran_at, status: undefined as unknown }));
  return rows.some(
    (row) => toZonedDate(row.ran_at, timeZone) === today && !isEmptyRunStatus(row.status),
  );
}

/**
 * 履歴の `status` の**4値目**の綴り
 * (`V8-M42` / `F-G15` / [`ADR-0333`](../../docs/adr/0333-schedule-empty-run-refire.md))。
 *
 * **`workflow-runner.ts` の `WORKFLOW_STATUS_NO_TARGET` と同じ文字列である。**
 * **層をまたいで import しない** —— **`records.ts:650`-`:653` が `OWNER_FIELD` について
 * 書いた「同じ綴りが2箇所にあることは代償である」と、まったく同じ代償を引き受けている。**
 * **書く側(`workflow-runner.ts`)と読む側(ここ)が別のファイルにあり、片方だけ綴りが変わると
 * 空撃ちが黙って「発火済み」に戻る** —— **2箇所が揃っていることは
 * `workflow-scheduler.test.ts` の綴り凍結の検査が押さえる。**
 *
 * **`export` しない**(`ADR-0072` 限定10 と同じ理由。`Δ8` を空に保つ)。
 */
const SCHEDULE_STATUS_NO_TARGET = "no_target";

/**
 * **その履歴行が「対象0件の空撃ち」か**(`ADR-0333` 限定2)。
 *
 * **`status` を読めなかった行(列が無い / 文字列でない)は「空撃ちではない」= 発火済みに倒す。**
 * **`ran_at` が読めない行を「今日ではない」に倒したのとは**逆向き**であり、理由も逆である**:
 * あちらは**発火が静かに落ちる**のを避けて二重発火の側へ倒した。**こちらは、読めない値を空撃ちと
 * みなすと、成功した発火まで「まだ発火していない」と読まれて**その日じゅう回り続ける**
 * (`v8-m35.md` §5-4 の `S3` の2点目)。 **どちらも「静かに壊れない側」へ倒している。**
 */
function isEmptyRunStatus(status: unknown): boolean {
  return status === SCHEDULE_STATUS_NO_TARGET;
}

/**
 * 履歴に書かれた `ran_at` を、その TZ の `YYYY-MM-DD` に直す。読めなければ `undefined`。
 *
 * **`zonedNow` をそのまま使う** —— 「今日」を作った変換と、「その行の日」を作る変換が
 * 同じ1つの関数であることが、境界がずれないことの根拠である。**その場限りの `Clock` を
 * 作って渡すのは、`zonedNow` が時刻源の形でしか瞬間を受け取らないためである。**
 */
function toZonedDate(ranAt: unknown, timeZone: string): string | undefined {
  if (typeof ranAt !== "string") {
    return undefined;
  }
  const instant = new Date(ranAt);
  if (Number.isNaN(instant.getTime())) {
    return undefined;
  }
  const fixed: Clock = { now: () => instant };
  return zonedNow(fixed, timeZone).date;
}
