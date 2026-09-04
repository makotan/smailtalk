/**
 * ワークフロー実行エンジン(ADR-0013 §5a / V1-M2-T02)。**イベントトリガーのみ。**
 *
 * `src/kernel/records.ts` の `createRecord` / `updateRecord` が、行を書き終えて
 * **`selectRow` で確定値を読み出した後**にここを呼ぶ。INSERT / UPDATE の直後ではない ——
 * `$record.<フィールドID>` の解決には全フィールドの確定値が要り、部分更新では
 * `validateInput` の結果が「入力に含まれた列」しか持たないためである。
 *
 * ## 設計上の決定(ADR-0013 §5a。ここで発明したものは1つも無い)
 *
 * | 論点 | ここでの扱い |
 * |---|---|
 * | 同期 / 非同期 | **同期。**レコードの書き込みと同じ呼び出しの中で実行する |
 * | 複数アクションの順序 | `actions` 配列の順序どおり。**前が失敗しても後続を実行する** |
 * | 複数ワークフローの順序 | `app.workflows` 配列の順序どおり |
 * | 分離 | **アクションの例外を呼び出し元へ伝播させない。**本体 CRUD のロールバックは
 *          そもそも起こらない(`records.ts` の CRUD に `db.transaction` が1件も無い) |
 *
 * ## 履歴の粒度 —— **実行1回につき1行**(アクション1つにつき1行ではない)
 *
 * ワークフロー1本の発火が1行になる。**複数アクションのうち1つでも失敗したら
 * `status = "failure"` とし、失敗した全アクションの情報を `error` に畳む。**
 * ADR-0013 §5a が「前のアクションが失敗しても後続を実行する」を選んだ理由は
 * 「どこまで実行されたかが履歴を読まないと分からない状態を作らない」ことであり、
 * **1発火 = 1行なら、その1行を読めば発火の全体が分かる。**アクション単位に割ると、
 * 「この発火の行がこれで全部か」を件数から推測することになり、同じ問題が戻ってくる。
 *
 * ## 履歴書き込みの失敗
 *
 * **all-or-nothing である。**5列すべてを含む1行を書き、1列でも欠けていれば
 * `validateInput` が拒否して行は1つも書かれない。**best-effort(書ける列だけ書く)を
 * 採らない** —— `error` だけ黙って落ちた履歴は「成功したように見える失敗の記録」であり、
 * 憲法6 に正面から反する。
 *
 * ## 無限ループ防止(V1-M2-T03)—— **独立した2つの機構である**
 *
 * | 機構 | 何を止めるか | 定数 / 状態 |
 * |---|---|---|
 * | **深度上限** | 連鎖の暴走(A→B→A、自己参照 create)。**新しい行**が無限に増える形 | `WORKFLOW_MAX_DEPTH`(20)/ `depth` |
 * | **再発火抑止** | 自己更新(A→A)。**同じ行**が繰り返し書き換わる形 | `firedRecords` |
 *
 * **両方が要る。**create の連鎖は毎回新しい `_id` を作るので抑止では止まらず、
 * 自己更新は深度上限だけだと「同じ1行を 20 回書き換えてから止まる」。
 * **どちらの停止も、失敗として履歴に残す**(完了条件3。黙って止めない = 憲法6)。
 * 判定の順序は「抑止 → 深度」で、理由は `firedRecords` の注記にある。
 *
 * **履歴テーブルへの書き込みは、どちらの予算も消費しない**(判断2)。
 * `isHistoryTable` を参照。**この判断は「履歴テーブルをトリガーに持つワークフローは
 * 永久に発火しない」という沈黙の破壊を生む。**宣言先は
 * `src/mcp/vocabulary.ts` の `WORKFLOW_HISTORY_TABLE_TEMPLATE` である。
 */
import type { Database } from "bun:sqlite";
// **【V4-M10-T10 / D-V4-49 / ADR-0079 限定8】** **`src/auth/` からの値 import はこの1本が
// 最初である。** **層をまたぐのは既に `../server/owner-scope.ts`(すぐ下)で前例がある** ——
// 判定・記録の「家」を1つに保つために、こちらから呼ぶ形にした(`ADR-0033` §Consequences)。
// **循環にはならない**(`src/auth/store.ts` が見るのは `src/kernel/storage-paths.ts` だけ)。
// **`_auth_activity` に列を1本も足していない**(完了条件3)。
// **【`V8-M21` / 台帳 `J-G21` / `J-G22a` / `J-G23`】3本目の値 import が
// `effectiveRolesOnDb` である** —— **面(役割に束ねた権限)を自動処理・島に効かせるには、
// 書き手の**実効ロール集合**が要る。** **`src/auth/store.ts` は着手前から値 import 済みで
// あり、層またぎの**種類**を1本も増やしていない。** **新しい接続を1つも開かない**
// (同関数の doc)。
import { effectiveRolesOnDb, ensureAuthActivitySchema, recordActivity } from "../auth/store.ts";
// **【`V8-M21` / 台帳 `J-G22a` / `J-G23`】判定の家は今日も `src/server/owner-scope.ts` の
// **既存の述語**である(新しい判定式を1つも作らない)。**import の向きは新規に作っていない**
// —— **すぐ上の `judgeOwnerScopedOp` が同じファイルから既に来ている**(限定の逐語
// 「判定の家は同上(`:59` で既に import 済み)」)。
import {
  type ActorRoles,
  combineRoleAndCreatorGrant,
  creatorGrantPlan,
  judgeOwnerScopedOp,
  judgeRoleAccess,
  recordAccessSourceTables,
  resolveCombinedRecordAccess,
} from "../server/owner-scope.ts";
import { AiCapabilityStore } from "./ai-capability-store.ts";
import { AI_MAX_CHAIN_DEPTH, aiUsageDate, checkAiLimit, currentAiChainDepth } from "./ai-limits.ts";
import { type BatchOp, writeRecords } from "./batch.ts";
import { CapabilityStore } from "./capability-store.ts";
import { type Clock, systemClock } from "./clock.ts";
import type { ValidationError } from "./errors.ts";
import { hostAllowed } from "./host-scope.ts";
import { buildCapabilityBridges } from "./island-capability-bridge.ts";
import { type IslandLimits, runIslandSync } from "./island-runner.ts";
import {
  createRecord,
  deleteRecord,
  getRecord,
  type ListRecordsOptions,
  listRecords,
  type RecordInput,
  type RecordRow,
  type RecordValue,
  updateRecord,
  validateDbFreeFieldValue,
} from "./records.ts";
import { resolveTable } from "./resolve-table.ts";
import { parseAppDbPath } from "./storage-paths.ts";
import type {
  FieldType,
  FunctionDef,
  FunctionInput,
  ListView,
  Manifest,
  ResourceId,
  Workflow,
  WorkflowAction,
  WorkflowActionAiTransform,
  WorkflowActionCallExternal,
  WorkflowActionRunFunction,
} from "./types.ts";

/**
 * 実行履歴テーブルの列の規約(5列)。
 *
 * **`status` と `trigger_type` に `select` 型を採っていない。**
 * `select` は `options` と1文字でも違えば書き込みが弾かれ(実測: `records.ts:311-325`)、
 * **その失敗を書く先がまた同じ列である**という循環を最も起こしやすい —— 履歴の
 * `status` に "failure" を書こうとして `options` 不一致で弾かれたら、その失敗は
 * どこにも残らない。**`text` なら値の綴りが規約とずれても行は書かれ、後から読める。**
 * (ADR-0013 §8d 限界1 が申告したとおり、この規約を機械的に強制する手段は無い。
 * だからこそ、規約とずれたときに黙って消える型を選ばない。)
 *
 * **T08 で `trigger_type` に `"schedule"` が加わる。**列は増えない(判断2 が
 * `trigger_type` を最初から入れたのはこのためである)。
 */
export const WORKFLOW_HISTORY_COLUMNS = [
  "ran_at",
  "workflow",
  "trigger_type",
  "status",
  "error",
] as const;

/**
 * 履歴の `status` の**3値目**(V4-M4-T01 / ADR-0072 = `B-G7` の限定採用)。
 *
 * **再発火抑止(`firedRecords`)による停止だけがこの値になる。**目的は `D-V4-37`
 * (逐語)「**記録が事実と違うのを直すため** —— 正しく動いたものを『失敗』と書くのは、
 * 記録が嘘をついている」であり、形は `D-V4-52`(逐語)「**履歴行は残すが、失敗とは
 * 呼ばない**」である。**行は残る**(ADR-0072 限定5。選ばれなかった案「履歴行ごと
 * 残さない」を実装しない)。
 *
 * **射程はここだけである**(ADR-0072 限定1 / 限定4):
 * - **深度上限(`WORKFLOW_MAX_DEPTH`)による停止は今日どおり `"failure"`。1ミリも含めない。**
 * - **アクションの失敗(`runActions` の `failures`)も今日どおり `"failure"`。**
 * - **`schedule` の巻き戻らない経路(ADR-0066 限定7)にも別の値を作らない**(限定2: 4値目を足さない)。
 *
 * **`export` しない** —— ADR-0072 限定10 が「`src/kernel/` の公開 export を1つも増やさない
 * (Δ8 を空に保つ)」と定めているためである。**凍結の検査は、履歴に実際に書かれた値で
 * 押さえる**(`workflow-runner.test.ts` の「3値目の綴りは `suppressed` に凍結する」)。
 *
 * **【綴りを決めたのは実装である】ADR-0072 限定2 は「綴りを本 ADR で固定する」と要求
 * しているが、ADR 本文に綴りが1文字も書かれていない。**`V4-M4-T00` §5-1 がその穴を
 * 記録したうえで `"suppressed"` を選んだ(理由もそこにある)。
 *
 * **列は1本も増えない**(限定3。`WORKFLOW_HISTORY_COLUMNS` は5列のまま / `status` の型は
 * `text` のままで `select` にしない = 限定6)。
 */
const WORKFLOW_STATUS_SUPPRESSED = "suppressed";

/**
 * 履歴の `status` の**4値目**(`V8-M42` / `F-G15` / [`ADR-0333`](../../docs/adr/0333-schedule-empty-run-refire.md))。
 *
 * **`trigger.table` を書いた時刻起動が、対象0件で発火したときだけこの値になる。**
 * **目的は `A-7`(`v8-m33.md` §1-A の逐語)**「**台を組んでいる最中に、対象0件で発火した。
 * `firedOn` は `status` を見ないので、今日もう発火しない**」**を塞ぐことである** ——
 * **`firedOn`(`workflow-scheduler.ts`)がこの値の行を「今日の発火」として数えない。**
 *
 * **射程はここだけである**(`ADR-0333` 限定2 / 限定3):
 * - **打ち切り(`{ abort }`。行数上限・対象表の読み取り失敗)は今日どおり `"failure"` である。1ミリも含めない。**
 *   **打ち切りは同じ日に再試行されない**(`ADR-0063` §限界1 を1バイトも動かさない)。
 * - **`trigger.table` を書かない時刻起動(`targets === undefined`)は今日どおり `"success"` である** ——
 *   **対象0件ではなく、対象という概念を持たない側だからである。**
 * - **`when` で全行がスキップされた発火も今日どおり `"success"` である**(対象は在る)。
 * - **再発火抑止(`firedRecords`)は今日どおり `"suppressed"`。** **`ADR-0072` 限定1 を1バイトも動かさない。**
 *
 * **【`ADR-0072` 限定2 を破っている。隠さない】** **限定2 の逐語は「**`status` に足す値は1つだけ。
 * 綴りを本 ADR で固定する**」/「**4値目を足さない**」である。** **`ADR-0333` がその限定を
 * 引き直した**(`ADR-0072` の front matter に `amended_by: [333]` を入れてある。**本文は1バイトも
 * 書き換えていない**)。 **`ADR-0072` §3a の 1(「4値目を足す」)が課した問いには
 * `ADR-0333` §3a が答えている** —— **本値は「成否」でも「巻き戻り」でもなく「**対象が在ったか**」
 * を表す3つ目の軸であり、`ADR-0072` §3a が警戒した「成否と巻き戻りの2軸を1列で表す」組合せの
 * 爆発には入らない**(**巻き戻りの側を1バイトも触っていない**)。
 *
 * **`export` しない** —— `ADR-0072` 限定10(`src/kernel/` の公開 export を1つも増やさない = `Δ8` を
 * 空に保つ)を、本値も同じように守る。**綴りは `workflow-scheduler.ts` にも同じ文字列で置いてある**
 * (層をまたいで import しない。`records.ts` の `OWNER_FIELD` と同じ代償である)。
 * **2箇所の綴りが揃っていることは `workflow-scheduler.test.ts` の綴り凍結の検査が押さえる。**
 *
 * **列は1本も増えない**(`ADR-0333` 限定1。`WORKFLOW_HISTORY_COLUMNS` は5列のまま /
 * `status` の型は `text` のままで `select` にしない)。
 */
const WORKFLOW_STATUS_NO_TARGET = "no_target";

/**
 * **レコードの書き込みが起点になる**トリガー種別(2種)。
 *
 * `schedule` を含まないのは、**`runWorkflows` がレコードイベントの入口だから**である。
 * ここに `schedule` を混ぜると `runWorkflows(db, manifest, tableId, "schedule", …)` が
 * 型として書けてしまうが、**`schedule` トリガーは `trigger.table` を持たない**ので
 * その呼び出しは1本も合致しない —— 「発火できるが誰も呼ばない」経路そのものである。
 *
 * **V1-M2-T08 の時点でも、この型は2値のままである。**`schedule` の発火は
 * `runScheduledWorkflow`(専用の入口)を通り、履歴に書く種別だけが
 * `WorkflowTriggerType` で広がる。**入口を分けたので、型を広げる必要が無かった。**
 */
export type WorkflowEventTriggerType = "on_create" | "on_update";

/**
 * **履歴の `trigger_type` 列に書かれうる値**(3種。ADR-0013 §5 のトリガー3種と一致する)。
 *
 * `WorkflowEventTriggerType` との違いは**どちらを向いているか**である ——
 * あちらは「`runWorkflows` の引数として受け取れるもの」(入口の型)、こちらは
 * 「履歴に記録されうるもの」(出口の型)。**`schedule` は入口が別なので前者に入らず、
 * 履歴には残るので後者に入る。**
 *
 * `WORKFLOW_HISTORY_COLUMNS` の doc が予告したとおり、**列は1つも増えていない。**
 */
/*
 * **【`V5-M25-T01` / `L-G8` / `ADR-0174`】4値目 `manual` が加わった。列は増えない。**
 *
 * **`ADR-0175` §Context 3 の逐語**: 「**答え = 同じテーブルに入る。新しい列は1本も
 * 要らない。**…**「なぜ発火したか」を区別する列は、今日すでに在る** —— **`trigger_type`
 * である**」。**したがって `ADR-0013` §4a 追加関門2 は、列を1本も足さずに閉じた。**
 * **`WORKFLOW_HISTORY_COLUMNS` は今日も5列である。**
 *
 * **【ここに「誰が押したか」は入らない。隠さない】** **`L-G11b` は保留であり
 * (`ADR-0174` 限定10 / `ADR-0175` 限定5)、押した人は `_workflow_history` に1バイトも
 * 残らない。** **ユーザ決定 `D-V5-83` により、押した人は**既存の監査記録
 * (`_auth_activity`)の側**にだけ残る**(`src/server/app.ts` の手動起動の入口)——
 * **したがって履歴画面には出ない。** **【禁止】「押した人が記録に残るようになった」を
 * 変更履歴について書かない。**
 */
export type WorkflowTriggerType = WorkflowEventTriggerType | "schedule" | "manual";

/** 履歴の書き込み自体が失敗したことの通知。 */
export type WorkflowHistoryWriteFailure = {
  workflow: ResourceId;
  history_table: ResourceId;
  errors: ValidationError[];
};

export type WorkflowHistoryFailureHandler = (failure: WorkflowHistoryWriteFailure) => void;

/**
 * 履歴書き込みが失敗したときの既定の通知先。
 *
 * **`console.error` はユーザには一切届かない** —— 会話にも画面にも出ない。
 * **これは V1-M2-T02 の限界である(§2-2 判断1 で確定)。**取りこぼしをユーザに
 * 見せる経路は返り値 `RecordResult<T>` しか実在せず、それを通すには Δ8 の発火と
 * `src/server/app.ts` / `src/mcp/tools/write.ts` のレスポンス形状変更が要る。
 * 射程が釣り合わないので T02 では作らず、**M2 の申し送りとする。隠さない。**
 *
 * 規約は `src/server/index.ts:30` / `src/mcp/index.ts:7-10`(stdout へ書いてはならない。
 * ログは必ず `console.error`)。**`src/kernel/` の非テストファイルで `console.*` を
 * 使うのは本ファイルが最初である。**
 */
function defaultHistoryFailureHandler(failure: WorkflowHistoryWriteFailure): void {
  console.error(
    `[workflow] ワークフロー "${failure.workflow}" の実行履歴を "${failure.history_table}" に` +
      `書き込めませんでした(履歴は1行も残っていません): ` +
      failure.errors.map((error) => `${error.path} ${error.message}`).join(" / "),
  );
}

let historyFailureHandler: WorkflowHistoryFailureHandler = defaultHistoryFailureHandler;

/** 履歴書き込み失敗の通知先を差し替える(テストから観測するための唯一の口)。 */
export function setWorkflowHistoryFailureHandler(handler: WorkflowHistoryFailureHandler): void {
  historyFailureHandler = handler;
}

/** 通知先を既定(`console.error`)に戻す。 */
export function resetWorkflowHistoryFailureHandler(): void {
  historyFailureHandler = defaultHistoryFailureHandler;
}

/**
 * 実行履歴の `ran_at` が読む時刻源(V1-M2-T08 単位1。既定は実時刻)。
 *
 * **`schedule` の検証は「時刻を注入して進めたら発火する」でしかできない**
 * (計画 `docs/plan/v1/02-workflow.md:165`)。**注入した時刻で発火させても `ran_at` が
 * 実時刻のままなら、「注入した時刻に発火した」ことを履歴から確認できず、
 * ADR-0013 §6c の発火済み判定(「履歴を『今日発火したか』で読む」)も成立しない。**
 *
 * **モジュールスコープの set/reset 対を採った理由**(T02 の
 * `setWorkflowHistoryFailureHandler` と同じ作法):`runWorkflows` の呼び出し元は
 * `records.ts` の `createRecord` / `updateRecord` の**内側**であり、引数で時刻源を
 * 通すには `records.ts` の公開シグネチャを変える必要がある。**T08 判断2 は
 * `records.ts` を変更しないと定めている**(行番号で引用されている箇所が壊れるため)。
 */
let workflowClock: Clock = systemClock;

/**
 * 時刻源を差し替える(テストから時刻を注入するための唯一の口)。
 *
 * **これは観測/注入のための口であって、挙動を変える口ではない。**
 * 注入しない本番経路の既定は `systemClock`(実時刻)であり、
 * **本番に残るテスト専用の分岐は1つも無い**(T08 完了条件2 / T03 判断4 の規律)。
 */
export function setWorkflowClock(clock: Clock): void {
  workflowClock = clock;
}

/** 時刻源を既定(実時刻)に戻す。 */
export function resetWorkflowClock(): void {
  workflowClock = systemClock;
}

/**
 * 現在の時刻源を返す(V1-M2-T08 単位2)。
 *
 * **`workflow-scheduler.ts` が「今が何時か」を読むための唯一の口である。**
 * スケジューラに `clock` を引数で渡す形を採らなかったのは、**渡す形だと
 * 「発火時刻の判定に使う時刻源」と「履歴の `ran_at` に書かれる時刻源」が
 * 別々になりうる**からである —— ADR-0013 §6c の発火済み判定は
 * **履歴に書かれた `ran_at` を読んで「今日発火したか」を決める**ので、
 * 2つがずれた瞬間に判定が壊れる(判定は注入時刻、記録は実時刻、など)。
 * **口を1つにすれば、ずれる形が書けない。**
 */
export function getWorkflowClock(): Clock {
  return workflowClock;
}

/**
 * ワークフローの連鎖が入れ子になれる**深さの上限**(V1-M2-T03 判断1)。
 *
 * `t0 → t1 → … → t20` のように、外部 CRUD から数えて **20 回まで**発火する。
 * 21 回目の発火要求は実行されず、**失敗として履歴に残る**(完了条件3)。
 *
 * ## なぜ 20 か
 *
 * 「業務として意味のある連鎖」の実測上限ではなく、**暴走を止める安全弁**である。
 * 人が意図して組む連鎖は 2〜3 段で、20 段はその十分上にある。一方でスタックは
 * 20 段では尽きない。**「正しい使い方を妨げず、暴走は必ず止まる」幅**を採った。
 *
 * ## **差し替える口を置かない**(判断4)
 *
 * これは `const` であって setter を持たない。**テスト専用の口を本番に残さない。**
 * `setWorkflowHistoryFailureHandler` の前例に引きずられないこと —— あれは
 * **観測**の口であって**挙動を変える**口ではない。深度上限を実行時に差し替えられると、
 * 「本番で実際に何段まで走るのか」がコードを読んでも決まらなくなる。
 * **段数が要る検査は、この定数からテーブルとワークフローをループで組み立てること**
 * (`workflow-runner.test.ts` の `chainManifest()`)。
 */
export const WORKFLOW_MAX_DEPTH = 20;

/**
 * 現在の入れ子の深さ。**外部 CRUD の内側にいないときは 0 である。**
 *
 * **なぜモジュールスコープで足りるか**: 実行が**同期**だからである(ADR-0013 §5a)。
 * 単一の実行文脈しか無いので、増減と呼び出しの入れ子が完全に対応する。
 * **T08 への警告: 実行を非同期にした瞬間、この機構は壊れる** —— 2つの発火が同時に
 * 走ると、片方の `finally` がもう片方の深度を戻す。非同期化するなら、モジュール
 * スコープではなく呼び出し連鎖に沿って持ち回る引数にすること。
 */
let depth = 0;

/**
 * **この1回の外部 CRUD の間に、既に発火したレコード**の集合(判断3)。
 *
 * 鍵は `` `${tableId}:${record._id}` ``。保証を一文で言うとこうなる ——
 * **「同じレコードが1操作で2度発火することはない」。**
 *
 * ## なぜ深度上限だけでは足りないか
 *
 * 自己更新(`on_update` × `update_record` × `target: "$record._id"`)は、深度上限に
 * 任せると**同じ1行を 20 回書き換えてから**止まる。ユーザから見れば「20 回ぶんの
 * 無駄な履歴が積まれてから止まった」であり、しかも最終値がどれかは連鎖の段数に
 * 依存する。**同じレコードへの2度目の発火は、それ自体が異常である。**
 *
 * ## なぜ「深さ」ではなく「1操作の間ずっと」か
 *
 * 深さが戻ったら忘れる作りにすると、`actions` が同じ行を2回更新するだけで
 * (深度は毎回 1 に戻る)抑止が効かず、連鎖の形によっては素通りする。
 * **「1操作の間ずっと」なら、保証が一文で言える** —— 言える保証だけが守られる。
 *
 * ## 外部 CRUD の境界の判定
 *
 * `depth === 0` で `runWorkflows` に入った瞬間が「1操作の始まり」である。
 * `depth` が 0 に戻った瞬間に集合を空へ戻す(`finally` で必ず通る)。
 */
const firedRecords = new Set<string>();

/** 再発火抑止の鍵。レコード源が無い発火(`schedule`)は鍵を持たない。 */
function firingKey(tableId: ResourceId, record: RecordRow | undefined): string | undefined {
  return record === undefined ? undefined : `${tableId}:${record._id}`;
}

// --- 手動起動の在席台帳(`V5-M25-T03` / `L-G10` / `ADR-0175`)-------------------------
//
// **`ADR-0175` §6-1 の逐語**: 「`src/kernel/workflow-runner.ts` に、手動起動の重複判定を
// 1本置く。**判定は「同じアプリ × 同じワークフロー × 同じ対象行」の手動起動が**実行中**で
// あること1つだけである。**」
//
// **【`ADR-0175` §限界3 が「決めていない」と自認した置き場を、ここで決めた。隠さない】**
// **置き場は**このモジュールのプロセス内 `Set` **である。**
//  - **したがって複数プロセスで走る配布物(`V5-M0`〜`V5-M11` の軸)では1ミリも効かない。**
//    **`ADR-0175` §限界3 が予告したとおりである。** **本タスクはそれを測っていない**
//    (プロセスを2本立てて同じ `app.sqlite` を叩く試験を1度も行っていない)。
//  - **プロセスが落ちれば台帳ごと消える。** **落ちた瞬間に走っていた手動起動の在席は
//    残らないので、再起動後の1発目は必ず通る。** これは意図した性質である(限定3 の
//    「完了後の再押下は通す」と同じ側に倒してある。**「起こせなくなる」ほうが重い**)。
//
// **【在席を取るのは入口である。ここではない。隠さない】** **`runManualWorkflow` は
// この台帳を1度も触らない。** 取るのは `src/server/app.ts` の手動起動 middleware であり、
// **在席の窓は「要求が入口を通ってから応答を返すまで」である。**
//  - **理由**: カーネルの実行は**同期**である(`depth` の doc の警告と同じ前提)。
//    **`runManualWorkflow` の中で取って中で返すと、窓の内側に譲る点が1つも無く、
//    同一プロセスでは2度目が窓に入る余地が構造的に存在しない** —— **規則が在るのに
//    1度も発火しない飾りになる。** 入口の middleware は `await next()` で必ず1度譲るので、
//    **重なった要求は実際に重なる**(`src/server/manual-trigger-route.test.ts` が本物の
//    要求2本で測っている)。
//  - **代償**: **`runManualWorkflow` を台帳を通さずに呼ぶ経路ができたら、その経路は
//    1ミリも守られない。** 今日そういう非テスト呼び出しは0件である(入口は1本だけ =
//    `ADR-0176` 限定1)が、**構造で守っているのではない。**
//
// **時間窓・回数上限・利用者ごとの上限を1つも作っていない**(限定1)。
// **アプリ側に宣言を1つも作っていない**(限定2。`$defs/workflow` は今日も6キーである)。
const manualRunsInFlight = new Set<string>();

/**
 * 手動起動の在席を取る(`V5-M25-T03` / `ADR-0175` 限定1)。
 *
 * **判定に使う要素は4つで閉じる** —— アプリ / ワークフロー / 対象行 / **実行中であること**。
 *
 * @returns **在席を取れたら「解放する関数」**(冪等。2度呼んでも、あとから取られた
 *   別の在席を消さない)。**既に実行中なら `null`** —— 呼び出し側はこれを **409** に写す。
 */
export function beginManualRun(params: {
  app: string;
  workflow: string;
  record: string;
}): (() => void) | null {
  // **鍵は3つ組を曖昧さなく綴じたものである。** **`JSON.stringify` で包むのは、
  // 区切り文字が値の中に現れて別の3つ組と衝突するのを構造で防ぐためである**
  // (`a:b` + `c` と `a` + `b:c` を同じ鍵にしない)。
  const key = `${JSON.stringify(params.app)}:${JSON.stringify(params.workflow)}:${JSON.stringify(params.record)}`;
  if (manualRunsInFlight.has(key)) {
    return null;
  }
  manualRunsInFlight.add(key);
  // **自分が取った在席だけを消す。** 解放を2度呼んだあとに別の起動が同じ鍵で在席を
  // 取っていた場合、1度目の解放関数がそれを消してはならない(黙って窓を開ける)。
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    manualRunsInFlight.delete(key);
  };
}

/**
 * このテーブルが**いずれかのワークフローの履歴テーブル**かを判定する(判断2)。
 *
 * **履歴テーブルへの書き込みはワークフローを発火させない。**履歴は「実行の記録」で
 * あって業務イベントではない(限定11 と同じ位置取り)。**記録係に深度の予算を
 * 食わせない** —— 食わせると、深度 20 の連鎖が実際には 10 段しか進まなくなり、
 * 上限の意味が「連鎖の長さ」からずれて、定数を読んでも挙動が決まらなくなる。
 *
 * ## **これは沈黙の破壊である。隠さない**
 *
 * 履歴テーブルをトリガーに持つワークフローは、参照整合性を通り、適用もでき、
 * **しかし永久に発火しない。**valid なのに動かないものを黙って置くのは憲法6 に
 * 反するので、**`src/mcp/vocabulary.ts` の `WORKFLOW_HISTORY_TABLE_TEMPLATE` で
 * AI に明示的に宣言してある。**あちらを消したらこの限界は沈黙する。
 *
 * ## 判定はマニフェスト全体で行う(ワークフローごとではない)
 *
 * 1本でも `history_table` に挙げているテーブルなら、**そのテーブルへの書き込みは
 * 誰のワークフローも発火させない。**「A の履歴だが B の業務テーブルでもある」を
 * 許すと、同じ行が記録なのか事実なのかが書き手ごとに変わる。**兼務を認めない。**
 */
function isHistoryTable(manifest: Manifest, tableId: ResourceId): boolean {
  return (manifest.app.workflows ?? []).some((workflow) => workflow.history_table === tableId);
}

/**
 * レコードの書き込みイベントで、合致するワークフローをすべて実行し、
 * **失敗の説明を返す**(V3-M13-T02 / ADR-0066 §Decision 1)。
 *
 * **例外を投げない。**アクションの失敗も履歴書き込みの失敗も、呼び出し元
 * (`createRecord` / `updateRecord`)へは1つも伝播させない —— これが完了条件3 の
 * 「分離」の後段(`0013:417`)であり、ADR-0066 限定4 が1バイトも変えないと定めた部分である。
 *
 * **変えたのは戻り値だけである。** 返す配列が空でなければ「このワークフローの発火は
 * 失敗した」ことを意味し、**発火元の書込を巻き戻すのは呼び出し元(`records.ts`)である。**
 * ここは巻き戻しの器を1つも持たない(限定1: 器は `records.ts` にだけ置く)。
 *
 * 返るものは2種類ある。**どちらも「失敗」として同じ器に落ちる**(限定16):
 *
 * 1. アクションの失敗(`runActions` の `failures`。例外を値に変換したものを含む)
 * 2. 深度上限に当たったこと(`WORKFLOW_MAX_DEPTH`)
 *
 * **再発火抑止(`firedRecords`)は返さない**(ADR-0066 §改訂1 = `V3-M13-T13` の門A
 * 本審査が限定16 の適用範囲を狭めた)。**抑止は履歴に3値目(`WORKFLOW_STATUS_SUPPRESSED`)
 * として loud に残るが、発火元の書込は成立する**(ADR-0072 が限定16(改訂後)の
 * 「抑止は `status="failure"` の履歴行として残る」だけを改めた)。理由は、書き戻し(ADR-0037 の Route B)が
 * 自分自身を再発火させることが**設計どおり**であり、それを失敗として扱うと
 * `on_update` × `write_back` が**構造的に必ず失敗する**からである。
 * **深度上限は今日も「失敗」である** —— あちらは連鎖が閉じなかったことの徴候であり、
 * 設計どおりに起きるものではない。
 *
 * **スキップ(`when` 不成立)は失敗ではない**ので1つも返さない(ADR-0036 §1b)。
 * **履歴書き込みの失敗も返さない** —— それは `setWorkflowHistoryFailureHandler` の
 * 経路であり、本 ADR の射程外である(ADR-0066 限定9)。
 *
 * `record` を `RecordRow | undefined` で受けるのは、**レコード源を持たない発火
 * (`schedule`。T08)を同じ関数で扱えるようにするため**である。`undefined` のときに
 * `$record.` 参照が現れたら解決エラーになる。
 * **注**: 適用時に `schedule` × `$record.` を拒否する静的検査は
 * `referential-integrity.ts` に後続段階が入れる(§2-2 判断3)。ここは実行時の解決器だけを持つ。
 */
export function runWorkflows(
  db: Database,
  manifest: Manifest,
  tableId: ResourceId,
  triggerType: WorkflowEventTriggerType,
  record: RecordRow | undefined,
  /**
   * **書いた失敗の履歴を、巻き戻しの後に書き直すための thunk の受け皿**
   * (V3-M13-T04 / ADR-0066 限定5)。
   *
   * **省略できる。** 省略した呼び出し(巻き戻しの器を持たない経路・既存のテスト)の
   * 振る舞いは1バイトも変わらない —— **履歴は今日どおりその場で書かれている。**
   * 渡すのは `records.ts` の器だけであり、器は巻き戻した直後にこの配列を順に呼ぶ。
   * **`string[]` の戻り値(失敗の説明)は1バイトも変えていない**(新しい結果型を作らない
   * = 限定12。`src/kernel/` の公開 export を1つも増やさない = 限定11)。
   */
  failureHistoryRewrites?: (() => void)[],
): string[] {
  // 判断2。**最初に見る。**履歴の書き込みは深度も抑止も1つも消費しない。
  if (isHistoryTable(manifest, tableId)) {
    return [];
  }

  const workflows = (manifest.app.workflows ?? []).filter(
    (workflow) =>
      (workflow.trigger.type === "on_create" || workflow.trigger.type === "on_update") &&
      workflow.trigger.type === triggerType &&
      workflow.trigger.table === tableId,
  );
  if (workflows.length === 0) {
    // **合致するワークフローが1本も無いなら、そもそも発火していない。**
    // 抑止の集合に入れない —— 入れると「発火していないのに発火済み扱い」になる。
    return [];
  }

  if (depth === 0) {
    // 1回の外部 CRUD の始まり。前回の残骸が残っていれば、それは `finally` を
    // 通らなかったということなので、ここでも念のため空へ戻す。
    firedRecords.clear();
  }

  // **抑止を深度より先に見る。**両方に当たりうる状況で、より具体的な理由を残すため
  // である —— 「同じレコードが2度目」は、深度に余裕があっても常に異常である。
  // 逆順にすると、自己更新の暴走が「深度上限」と記録され、直すべき場所が読めない。
  const key = firingKey(tableId, record);
  if (key !== undefined && firedRecords.has(key)) {
    const reason =
      `同じレコード(テーブル "${tableId}" / _id ${record?._id})は、この操作で既に一度発火しています。` +
      `再発火を抑止したため、この発火は実行していません。` +
      `同じレコードが1回の操作で2度発火することはありません。`;
    stopAll(
      db,
      manifest,
      workflows,
      triggerType,
      reason,
      failureHistoryRewrites,
      // **3値目を書く**(V4-M4-T01 / ADR-0072 限定1: 射程は再発火抑止だけ)。
      WORKFLOW_STATUS_SUPPRESSED,
    );
    // **再発火抑止は「失敗」ではない**(ADR-0066 §改訂1 = `V3-M13-T13`)。
    // 【V4-M4-T01 / ADR-0072 による更新】履歴には `status="suppressed"` として残る
    // (憲法6。**行は消さない** = 限定5)。**発火元の書込は成立する**(限定7: `stopAll` の
    // 呼び出しと巻き戻しの挙動は1バイトも変わらず、変えたのは `status` に書く値だけである)。
    // 空を返すことが、それを意味する。
    return [];
  }

  if (depth >= WORKFLOW_MAX_DEPTH) {
    const reason =
      `ワークフローの連鎖が深度上限(${WORKFLOW_MAX_DEPTH})に達したため、この発火は実行していません。` +
      `ワークフローが互いを発火させ続けていないか確認してください。`;
    stopAll(db, manifest, workflows, triggerType, reason, failureHistoryRewrites);
    return [reason];
  }

  if (key !== undefined) {
    firedRecords.add(key);
  }
  depth += 1;
  const failures: string[] = [];
  try {
    for (const workflow of workflows) {
      const outcome = runActions(db, manifest, workflow, record);
      const rewrite = writeHistory(
        db,
        manifest,
        workflow,
        triggerType,
        outcome.failures,
        outcome.skips,
      );
      if (rewrite !== undefined) {
        failureHistoryRewrites?.push(rewrite);
      }
      // **合致した全ワークフローを最後まで走らせてから返す**(ADR-0013 `0013:418` を破らない
      // = ADR-0066 限定3)。1本目が失敗しても2本目を実行し、失敗はまとめて運ぶ。
      failures.push(...outcome.failures.map((text) => `ワークフロー "${workflow.id}" ${text}`));
    }
  } finally {
    // 例外が漏れても必ず戻す。戻し損ねると、以後そのプロセスでワークフローが
    // 二度と発火しなくなる(黙って止まる = 憲法6 違反)。
    depth -= 1;
    if (depth === 0) {
      firedRecords.clear();
    }
  }
  return failures;
}

/**
 * `schedule` トリガーのワークフローを**1本**実行する(V1-M2-T08 単位2 / ADR-0013 §6)。
 *
 * 呼ぶのは `workflow-scheduler.ts` だけである。**「発火すべき時刻か」「今日すでに
 * 発火したか」の判定はこの関数の外**にあり、ここは**発火すると決まったものを、
 * `runWorkflows` と同じ機構の上で実行する**ことだけを担う。
 *
 * ## `runWorkflows` に合流させず、別の入口にした理由
 *
 * `runWorkflows` は `trigger.table === tableId` で合致を決める。**`schedule` は
 * `table` を持たない**(ADR-0013 §6b)ので、合流させると「テーブルIDを取るが
 * テーブルを見ない引数」が生まれる。**入口を分ければ、`WorkflowEventTriggerType` を
 * 2値のまま保てる。**共有すべき本体(深度・抑止・アクション実行・履歴)は
 * すべて同じ関数を通っており、**二重化しているのは合致の判定だけである。**
 *
 * ## **なぜ T03 の深度機構が壊れないか**(`depth` の doc の警告への回答)
 *
 * 警告は「**実行を非同期にした瞬間に壊れる**」である。**T08 は実行を非同期にしていない。**
 *
 * - タイマーのコールバックは非同期の**入口**だが、**コールバックの内側は完全に同期**である
 *   (`runSchedulerTick` に `await` / `Promise` / `async` が1つも無い)。
 * - **複数アプリ・複数ワークフローを `Promise.all` などで並行に処理しない。**
 *   1アプリずつ、1ワークフローずつ、`for` の同期ループで回す。
 * - JavaScript のイベントループは、同期実行の途中に別のタイマーコールバックを
 *   割り込ませない。**したがって「2つの発火が同時に走る」状態が作れない。**
 * - `records.ts` の CRUD も同期なので、**CRUD の内側にタイマーが割り込む経路も無い。**
 *   この関数に入る時点で `depth` は必ず 0 である。
 *
 * **深度上限が効くのは、この発火が始めた連鎖に対してである** —— ここで `depth` を
 * 1 に上げるので、アクションが書いた行が発火させるワークフローは 2、その先は 3 と数え、
 * `WORKFLOW_MAX_DEPTH` で `runWorkflows` が止めて**失敗として履歴に残す。**
 *
 * **再発火抑止**(`firedRecords`)も同じ理由で効く —— この発火が「1回の操作」の
 * 始まりになるので、連鎖の中で同じレコードが2度発火することはない。
 * **`schedule` の発火自体は `record === undefined` なので鍵を持たず**
 * (`firingKey` が `undefined` を返す)、抑止の集合には何も入らない。
 *
 * ## `targets` —— 行を対象にする発火(`D-G16a`。ADR-0063)
 *
 * `trigger.table` を書いた `schedule` は、対象表の行を**1件ずつトリガー元レコードとして**
 * 処理する。**行の読み取りと処理行数の上限は `workflow-scheduler.ts` の責務**であり、
 * ここは渡された行を順に `runActions` に掛けるだけである(ADR-0063 §Decision 1 の層別表)。
 *
 * - `targets === undefined` … 従来どおり(トリガー元レコード無しで1回)。
 * - `{ records }` … 各行について `runActions` を呼ぶ。**履歴は行数によらず1行**である
 *   (ADR-0063 限定4。「どの行を処理したか」を1バイトも覚えない)。失敗とスキップは
 *   どの行のものかが読めるように `_id` を前置して1つの履歴行にまとめる。
 * - `{ abort }` … アクションを1件も実行せず、**失敗として履歴に残す**(憲法6)。
 *   上限超過がこれである。**次回に回さない** —— 回すには「どこまで処理したか」を
 *   覚える必要があり、それは限定4 が禁じたものである。
 *
 * **再発火抑止と深度カウンタの意味論は1バイトも変えていない。** 行ごとの `runActions`
 * は同じ `depth` の下で走るので、行が増えても連鎖の深さは深くならない。
 *
 * ## 戻り値は `void` のままである(V3-M13-T02 / ADR-0066 限定7)
 *
 * `runWorkflows` は失敗を返すようになったが、**こちらは1バイトも変えていない。**
 * ADR-0066 §5-5 が `schedule` の原子性の単位として「**原子性を保証しない**」を名指ししたため、
 * 巻き戻す相手(発火元の書込)が構造的に存在せず、失敗を返す先も無い(呼び出し元は
 * `workflow-scheduler.ts` のタイマーであり、届く先は履歴だけである)。
 * **ただしアクションが行うレコード書込は `records.ts` を通るので、その書込に紐づく
 * `on_create` / `on_update` が失敗すれば、その1件の書込だけは成立しない。**
 * **発火全体は原子的にならない**(部分適用が残る)。
 */
export function runScheduledWorkflow(
  db: Database,
  manifest: Manifest,
  workflow: Workflow,
  targets?: { records: RecordRow[] } | { abort: string },
): void {
  if (depth === 0) {
    // 1回の「操作」の始まり。前回の残骸が残っていれば空へ戻す(`runWorkflows` と同じ)。
    firedRecords.clear();
  }
  depth += 1;
  try {
    const failures: string[] = [];
    const skips: string[] = [];
    /*
     * **【`V8-M42` / `F-G15` / `ADR-0333`】対象0件の空撃ちだったか。**
     *
     * **真になるのは「行を選ぶ時刻起動が、行を1件も得られなかった」ときだけである** ——
     * **`targets === undefined`(行を選ばない側)でも、`{ abort }`(打ち切り)でもない。**
     * **この1つの真偽が、履歴の `status` を4値目にするかどうかを決める**(下の `writeHistory`)。
     */
    const emptyTargets =
      targets !== undefined && !("abort" in targets) && targets.records.length === 0;
    if (targets !== undefined && "abort" in targets) {
      // 打ち切り。**アクションを1件も実行しない**が、黙って止まらない(憲法6)。
      failures.push(targets.abort);
    } else if (targets === undefined) {
      const outcome = runActions(db, manifest, workflow, undefined);
      failures.push(...outcome.failures);
      skips.push(...outcome.skips);
    } else {
      for (const record of targets.records) {
        const outcome = runActions(db, manifest, workflow, record);
        // **どの行のものかを名指しする。**1000 行のうちどれで落ちたかが読めないと、
        // 「失敗した」だけが残って原因に辿り着けない。
        failures.push(...outcome.failures.map((text) => `レコード "${record._id}": ${text}`));
        skips.push(...outcome.skips.map((text) => `レコード "${record._id}": ${text}`));
      }
    }
    // **書き直しの thunk は受け取らない**(V3-M13-T04)—— `schedule` の発火は巻き戻る器を
    // 1つも持たない(ADR-0066 限定7)ので、ここで書いた履歴は最初から消えない。
    //
    // 【`V8-M42` / `F-G15` / `ADR-0333`。**旧の1行を逐語で残す**】
    //
    //     writeHistory(db, manifest, workflow, "schedule", failures, skips);
    //
    // **変えたのは `status` 列に書く値だけである**(`ADR-0333` 限定1)。 **列は1本も増えず、
    // `error` 列も1文字も使わない** —— **`statusOverride` は `V4-M4-T01` / `ADR-0072` が既に
    // 置いた引数であり、本単位は新しい引数を1つも作っていない。**
    // **`failures` が空でないときは空撃ちにならない**(上の `emptyTargets` は打ち切りを除く)ので、
    // **失敗が4値目で隠れることはない。**
    writeHistory(
      db,
      manifest,
      workflow,
      "schedule",
      failures,
      skips,
      emptyTargets ? WORKFLOW_STATUS_NO_TARGET : undefined,
    );
  } finally {
    // 例外が漏れても必ず戻す。戻し損ねると、以後そのプロセスでワークフローが
    // 二度と発火しなくなる(黙って止まる = 憲法6 違反)。
    depth -= 1;
    if (depth === 0) {
      firedRecords.clear();
    }
  }
}

/**
 * **画面のボタンから名指しで起こされた1本**を実行する
 * (`V5-M25-T01` / `L-G8` / [`ADR-0174`](../../docs/adr/0174-manual-workflow-trigger.md))。
 *
 * ## `runWorkflows` に合流させず、3本目の入口にした理由
 *
 * `runWorkflows` は `trigger.table === tableId` **かつ** `trigger.type === triggerType` で
 * 合致するものを**すべて**実行する。**手動起動は「名指しした1本だけ」を実行する**ので、
 * 合流させると「テーブルで合致した全部が走る」意味とぶつかる。**`runScheduledWorkflow`
 * が同じ理由で別入口になっている**(その doc の逐語「入口を分ければ、
 * `WorkflowEventTriggerType` を2値のまま保てる」)—— **本関数もそれに倣った。**
 * **`WorkflowEventTriggerType` は今日も2値である。**
 *
 * ## **`depth = 0` の意味を1バイトも変えていない**(`ADR-0174` 限定8)
 *
 * **手動起動も「1操作の始まり」である。** `depth` を 0 から 1 に上げ、`finally` で必ず戻す
 * (`runWorkflows` / `runScheduledWorkflow` と同じ形)。**`WORKFLOW_MAX_DEPTH` を1ミリも
 * 動かしていない。**
 *
 * ## **再発火抑止(`firedRecords`)の意味を1バイトも変えていない**(`ADR-0174` 限定9)
 *
 * **押した行を抑止の集合に入れる。** 保証の一文は今日も
 * 「**同じレコードが1操作で2度発火することはない**」のままである ——
 * **入れないと、手動起動が自分の行を更新したときに `on_update` が走り、その先で同じ行が
 * もう一度発火しうる**(保証が破れる)。**入れた結果として、手動起動が押した行そのものを
 * 更新したときの `on_update` は抑止され、履歴に `suppressed` として残る。**
 * **これは「黙って走らない」ではない**(憲法6)—— **loud に残る。**
 * **【正直に書く】`ADR-0174` §限界2 が「`ADR-0072` に及ばないことを実測で示していない」と
 * 自認していた点は、本関数がこの判断を下したことで**及んだ**。** **及んだ先は
 * `docs/plan/v5/records/v5-m25.md` に実測つきで書く。**
 *
 * ## **在席台帳(`beginManualRun`)をここでは触らない**
 *
 * **取るのは入口(`src/server/app.ts` の手動起動 middleware)である。**理由と代償は
 * `manualRunsInFlight` の doc に書いた。**本関数を台帳を通さずに呼べば、重複は1ミリも
 * 防がれない。**
 *
 * @param record **押した行**(1行だけ。`ADR-0174` 限定3)。
 * @returns 失敗の説明(`runWorkflows` と同じ `string[]`。**新しい結果型を1つも作らない**)。
 */
export function runManualWorkflow(
  db: Database,
  manifest: Manifest,
  workflow: Workflow,
  record: RecordRow,
  /**
   * **押した人**(`V5-M25-T04` / `L-G11a` / `ADR-0175` 限定7)。
   *
   * **規則は1本だけである**: **`act_as` の宣言があればそれが勝ち、無ければこの人。**
   * **省略できる** —— 省略した呼び出しの実行者の決まり方は今日どおり
   * (トリガー元レコードの `st_owner`)である。
   * **【禁止】「押した人が記録に残るようになった」を、変更履歴について書かない** ——
   * **この値は `_workflow_history` に1バイトも書かれない**(列は5本のまま)。
   * **残るのは既存の監査記録(`_auth_activity`)の側だけである**(`D-V5-83`。
   * 書くのは入口 = `src/server/app.ts` であって、ここではない)。
   */
  pressedBy?: string,
): string[] {
  // **`manual` と宣言したものだけを起こす**(`ADR-0174` 限定2)。**apply 時の検査
  // (`referential-integrity.ts`)と二重化してある** —— MCP を迂回した経路や、
  // 適用後にマニフェストが差し替わった場合にここが最終防衛線になる(`resolveValue` と同型)。
  if (workflow.trigger.type !== "manual") {
    return [
      `ワークフロー "${workflow.id}" は手動で起こせません` +
        `(発火条件が "${workflow.trigger.type}" です。手動で起こせるのは manual と宣言したものだけです)。`,
    ];
  }
  const tableId = workflow.trigger.table;
  if (depth === 0) {
    // 1回の「操作」の始まり。前回の残骸が残っていれば空へ戻す(`runWorkflows` と同じ)。
    firedRecords.clear();
  }
  const key = firingKey(tableId, record);
  if (key !== undefined && firedRecords.has(key)) {
    // **抑止を深度より先に見る**(`runWorkflows` と同じ順序。理由もそこに書いてある)。
    const reason =
      `同じレコード(テーブル "${tableId}" / _id ${record._id})は、この操作で既に一度発火しています。` +
      `再発火を抑止したため、この発火は実行していません。`;
    stopAll(db, manifest, [workflow], "manual", reason, undefined, WORKFLOW_STATUS_SUPPRESSED);
    return [];
  }
  if (depth >= WORKFLOW_MAX_DEPTH) {
    const reason =
      `ワークフローの連鎖が深度上限(${WORKFLOW_MAX_DEPTH})に達したため、この発火は実行していません。` +
      `ワークフローが互いを発火させ続けていないか確認してください。`;
    stopAll(db, manifest, [workflow], "manual", reason, undefined);
    return [reason];
  }
  if (key !== undefined) {
    firedRecords.add(key);
  }
  depth += 1;
  try {
    const outcome = runActions(db, manifest, workflow, record, pressedBy);
    writeHistory(db, manifest, workflow, "manual", outcome.failures, outcome.skips);
    return outcome.failures.map((text) => `ワークフロー "${workflow.id}" ${text}`);
  } finally {
    depth -= 1;
    if (depth === 0) {
      firedRecords.clear();
    }
  }
}

/**
 * **実行せずに止めた**ことを、合致した全ワークフローの履歴に**失敗**として書く。
 *
 * 完了条件3(黙って止めない = 憲法6)の実装である。**1本ごとに1行**書くのは、
 * 履歴の粒度「1発火につき1行」を止めた側でも崩さないためである —— 3本が合致して
 * いたなら、3本ぶんの「動かなかった」が要る。1行に畳むと、どのワークフローが
 * 動かなかったかを件数から推測することになる。
 *
 * **この書き込み自体はワークフローを発火させない**(判断2 の `isHistoryTable`)ので、
 * 「止めたことを書こうとして再帰する」経路は存在しない。
 */
function stopAll(
  db: Database,
  manifest: Manifest,
  workflows: Workflow[],
  /*
   * **【`V5-M25-T01` / `ADR-0174`】`WorkflowEventTriggerType`(2値)から
   * `WorkflowTriggerType`(4値)へ広げた。** **手動起動も抑止・深度上限に当たりうるので、
   * 止めたことを `trigger_type: "manual"` として履歴に残す必要がある。**
   * **`WorkflowEventTriggerType` そのものは今日も2値のままである**(広げたのはこの引数の
   * 型だけで、`runWorkflows` の入口の型は1バイトも変えていない)。
   */
  triggerType: WorkflowTriggerType,
  reason: string,
  // 止めたことの記録も**失敗の記録**なので、巻き戻ったら書き直す(V3-M13-T04)。
  failureHistoryRewrites?: (() => void)[],
  // **履歴に書く `status`**(V4-M4-T01 / ADR-0072)。**既定は今日どおり `"failure"`** ——
  // 深度上限の呼び出し側は1文字も変えていない(限定1 / 限定4)。再発火抑止の呼び出し側
  // だけが `WORKFLOW_STATUS_SUPPRESSED` を渡す。**巻き戻しの挙動は分岐させない**
  // (限定7)—— どちらの停止でも書き直しの thunk は今日どおり作られ、今日どおり積まれる。
  historyStatus?: string,
): void {
  for (const workflow of workflows) {
    // 止めたことは条件スキップではない —— skips は空で渡す。
    const rewrite = writeHistory(db, manifest, workflow, triggerType, [reason], [], historyStatus);
    if (rewrite !== undefined) {
      failureHistoryRewrites?.push(rewrite);
    }
  }
}

/** 1本のワークフローのアクション実行の結果(失敗の説明とスキップの説明)。 */
type ActionsOutcome = {
  /** 実行して失敗したアクションの説明(空なら失敗なし)。 */
  failures: string[];
  /** `when` 不成立で実行しなかったアクションの説明(EC-G5。空ならスキップなし)。 */
  skips: string[];
};

/**
 * 1本のワークフローのアクションを順に実行し、**失敗とスキップの説明**を返す。
 *
 * `failures` が空なら失敗なし、`skips` が空なら条件スキップなし。**前が失敗しても
 * 後続を実行する**(ADR-0013 §5a)。
 *
 * ## EC-G5 条件分岐(`when`。ADR-0036)
 *
 * `action.when`(最小述語 `{field, equals}`)があるアクションは、**トリガー元レコードの
 * `when.field` の値が `when.equals` と等しいときだけ実行**し、不一致なら**スキップ**する。
 * **スキップは失敗ではない**(status を failure にしない)が、**黙って消さず `skips` に
 * 積んで履歴に loud に残す**(憲法6。ADR-0036 §1b)。`when` を解決できない場合
 * (`schedule` トリガーでレコード源が無い / `when.field` がレコードに無い)は
 * **失敗**(loud に落とす)——「valid なのに黙って全スキップ」を作らない。
 * `when.field` の実在は `referential-integrity.ts` が apply 時に検査するので、
 * 実行時にここへ来るのは MCP を迂回した経路だけである(防御の二重化。`resolveValue` と同型)。
 */
function runActions(
  db: Database,
  manifest: Manifest,
  workflow: Workflow,
  record: RecordRow | undefined,
  /**
   * **押した人**(`V5-M25-T04` / `L-G11a` / `ADR-0175` 限定7)。
   *
   * **渡すのは手動起動の入口だけである。** **`on_create` / `on_update` / `schedule` の
   * 3種は今日どおり `undefined` を渡す**(限定4: 3種に1バイトも触らない)——
   * **その3種には「押した人」が存在しない。**
   */
  manualActor?: string,
): ActionsOutcome {
  const failures: string[] = [];
  const skips: string[] = [];
  workflow.actions.forEach((action, index) => {
    // 宛先の表示は種別で分ける。**`call_external` は connection の URL、`ai_transform` は
    // AI capability**(いずれも内部テーブルではない)ので、それぞれの参照名を出す。
    const destination =
      action.action === "call_external"
        ? `接続 "${action.connection}"`
        : action.action === "ai_transform"
          ? `AI capability "${action.capability}" → ${action.output_field}`
          : action.action === "run_function"
            ? `関数 "${action.function}" → ${
                action.write_ops === true
                  ? "島が返す更新操作(write_ops)"
                  : action.write_back !== undefined
                    ? "トリガー元レコード(write_back)"
                    : action.output_table
              }`
            : action.table;
    const label = `アクション${index + 1}(${action.action} → ${destination})`;

    // EC-G5: `when` 条件の評価(ADR-0036)。実行より**前**に見る。
    if (action.when !== undefined) {
      const decision = evaluateWhen(action.when, record);
      if (!decision.ok) {
        // 解決不能(schedule × when など)は**失敗**として loud に残す。
        failures.push(`${label}: ${decision.message}`);
        return;
      }
      if (!decision.matched) {
        // 条件不成立 → **スキップ**。黙って消さず履歴に残す(憲法6。ADR-0036 §1b)。
        skips.push(
          `${label} をスキップしました` +
            `(実行条件 when: フィールド "${action.when.field}" の値が ` +
            `${JSON.stringify(action.when.equals)} と一致しませんでした)。`,
        );
        return;
      }
      // 一致 → 通常どおり実行する(下へ落ちる)。
    }

    try {
      const failure = runAction(db, manifest, workflow, action, record, manualActor);
      if (failure !== undefined) {
        failures.push(`${label}: ${failure}`);
      }
    } catch (error) {
      // カーネルが投げる想定外の例外もここで受け止める。**呼び出し元まで伝播させない**
      // ことが完了条件3 の「分離」である。
      failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return { failures, skips };
}

/**
 * `when`(最小述語 `{field, equals}`)を評価する(EC-G5。ADR-0036)。
 *
 * - **`ok: false`** … 解決不能(loud に失敗させる)。`schedule` トリガーでレコード源が
 *   無い / `when.field` がトリガー元レコードに無い。**`$record.<field>` の解決器
 *   (`resolveValue`)と同型の fail-closed** —— 黙って全スキップ/全実行にしない。
 * - **`ok: true, matched`** … トリガー元レコードの `when.field` の値が `when.equals` と
 *   `===` で等しいか。**値は `selectRow` が列型どおりに復元済み**(boolean は真偽値、
 *   number は数値、他は文字列。`records.ts:516-526`)なので、型どおりの厳密等価で比べる
 *   —— 型が食い違えば false(不一致 = スキップ)になる。
 */
function evaluateWhen(
  when: { field: ResourceId; equals: string | number | boolean },
  record: RecordRow | undefined,
): { ok: true; matched: boolean } | { ok: false; message: string } {
  if (record === undefined) {
    return {
      ok: false,
      message:
        `実行条件 when はトリガー元のレコードを要します` +
        `(schedule トリガーでは使えません。フィールド "${when.field}" を解決できません)。`,
    };
  }
  if (!Object.hasOwn(record, when.field)) {
    return {
      ok: false,
      message: `実行条件 when が参照するフィールド "${when.field}" は、きっかけとなったレコードにありません。`,
    };
  }
  const actual = record[when.field] ?? null;
  return { ok: true, matched: actual === when.equals };
}

/** 1アクションを実行する。成功なら `undefined`、失敗なら人間可読な理由。 */
function runAction(
  db: Database,
  manifest: Manifest,
  workflow: Workflow,
  action: WorkflowAction,
  record: RecordRow | undefined,
  /**
   * **押した人**(`V5-M25-T04` / `ADR-0175` 限定7)。**手動起動の入口だけが渡す。**
   * **`on_create` / `on_update` / `schedule` は今日どおり `undefined` である**(限定4)。
   */
  manualActor?: string,
): string | undefined {
  // **call_external はここが実行層の遮断点である**(ADR-0020 §3 / §8c-5)。
  // 既存の create_record / update_record のロジックより**前**に分岐する。この関数は
  // 同期・secret に一切触れない・fetch もしない —— capability チェックのみを行い、
  // 許可されたら outbox に積むだけ。実際の配送は非同期の `dispatchOutbox` が担う。
  if (action.action === "call_external") {
    return runCallExternal(db, action, record);
  }

  // **ai_transform もここが実行層の遮断点である**(ADR-0021 §3 / §8c-5)。
  // capability チェック + 当日の上限判定 + 連鎖深度判定を**同期**で行い、許可されたら
  // ai_jobs に積むだけ。実際の推論・出力検証・書き戻しは非同期の `dispatchAiJobs` が担う。
  if (action.action === "ai_transform") {
    return runAiTransform(db, manifest, workflow, action, record);
  }

  // **run_function もここが実行層である**(ADR-0024 §Decision。V1-M6-T05 第2段)。
  // 関数(コードの島)を**同期**で走らせ、出力を output.fields で検証してから
  // output_table に全置換する。島の暴走(timeout / OOM)や出力不正では fail-closed
  // (output_table を1バイトも触らず失敗理由を返す)。
  if (action.action === "run_function") {
    return runRunFunction(db, manifest, workflow, action, record, manualActor);
  }

  const values = resolveValues(action.values, record);
  if (!values.ok) {
    return values.message;
  }

  if (action.action === "create_record") {
    // **【`V8-M21` / `J-G22a`】書込アクションの直前1箇所**(**時刻起動は素通し**)。
    if (accessJudgmentApplies(workflow)) {
      // **【`V8-M37` / 台帳 `F-G4`】主体を1度だけ解いて、判定と持ち主の押し込みで使い回す。**
      // **`automationActorId` を2度呼ぶと、`act_as` の宣言がある発火で参照先の行を
      // 2回読むことになる** —— **判定の答えは1バイトも変わらないが、読取が増える。**
      // **遅延のまま持つ**(`judgeAutomationWrite` が主体を要らないと決めたときは解かない)。
      let resolvedActor: string | null | undefined;
      const actorOnce = (): string | null => {
        if (resolvedActor === undefined) {
          resolvedActor = automationActorId(db, manifest, workflow, record, manualActor);
        }
        return resolvedActor;
      };
      const denied = judgeAutomationWrite({
        db,
        manifest,
        tableId: action.table,
        verb: "write",
        actor: actorOnce,
      });
      if (denied !== undefined) {
        return denied;
      }
      // **【`V8-M37` / 台帳 `F-G4`】島の `write_ops` と持ち主の入り方を揃える(道A)。**
      // **判定と同じ1本の主体を、同じ発火の `create_record` にも押す。**
      // **この呼び出しは `accessJudgmentApplies` の内側にある** —— **時刻起動には
      // 1バイトも掛からない**(限定2。`D-V8-99` / `U-3`)。
      stampAutomationOwner(manifest, action.table, values.value, actorOnce());
    }
    const result = createRecord(db, manifest, action.table, values.value);
    return result.ok ? undefined : formatErrors(result.errors);
  }

  // `target` は**更新対象の `_id` を与える文字列**である(ADR-0013 §7d / EC-G13 / ADR-0040)。
  // 書ける形は3つだけ:`"$record._id"`(自己更新)/ `"$record.<reference フィールド>"`
  //(参照先の別テーブル行。ADR-0040 で追加)/ リテラルの UUID(特定の行)。
  //
  // **`$record.<reference フィールド>` の解決はこうなる**: reference 型フィールドの値は
  // 参照先の行の `_id` そのものなので、`resolveValue` が返す `record[field]` が更新対象 `_id`
  // になる —— records.ts に新しい lookup 関数は要らない(§7d の「同じカーネル関数を通す」を保つ)。
  //
  // **ただし `$record.<field>` の `<field>` が reference 型でなければ loud に失敗する** ——
  // 非 reference フィールドの値(例: text)を _id と誤解して別の行を更新する黙りを防ぐ
  // (referential-integrity.ts 類型13 の適用時検査と二重化。MCP を迂回した経路への防御)。
  const targetRefError = checkTargetReferenceField(manifest, workflow, action.target);
  if (targetRefError !== undefined) {
    return `target: ${targetRefError}`;
  }
  const target = resolveValue(action.target, record);
  if (!target.ok) {
    return `target: ${target.message}`;
  }
  if (typeof target.value !== "string" || target.value === "") {
    return `target が更新対象の _id になりませんでした(解決結果: ${JSON.stringify(target.value)})。`;
  }
  // **【`V8-M21` / `J-G22a`】書込アクションの直前1箇所**(**時刻起動は素通し**)。
  // **対象行を読んでから判定する** —— **行が読めないときは判定を掛けない**
  // (「その行は無い」を `updateRecord` の既存の応答で返すためであり、
  // **見えない行の存在を権限の文面で言い当てさせない**)。
  if (accessJudgmentApplies(workflow)) {
    const existing = getRecord(db, manifest, action.table, target.value);
    const targetRow =
      existing.ok && existing.value !== null
        ? (existing.value as unknown as Record<string, unknown>)
        : undefined;
    if (targetRow !== undefined) {
      const denied = judgeAutomationWrite({
        db,
        manifest,
        tableId: action.table,
        row: targetRow,
        verb: "write",
        actor: () => automationActorId(db, manifest, workflow, record, manualActor),
      });
      if (denied !== undefined) {
        return denied;
      }
    }
  }

  // **版(expectedVersion)は渡さない = LWW を維持する**(V1-M9-T02 / ADR-0017 / R1)。
  // これは同一アプリ内の自動化であって「後発ユーザの黙殺」ではない。楽観ロック(CAS)の
  // 必須化は配線層(HTTP If-Match / MCP if_match)だけで行い、内部の自動更新には課さない。
  const result = updateRecord(db, manifest, action.table, target.value, values.value);
  return result.ok ? undefined : formatErrors(result.errors);
}

/**
 * `update_record` の `target` が `$record.<field>` 形のとき、その `<field>` が
 * **トリガー元テーブルの reference 型フィールド**であることを実行時に確認する
 * (EC-G13 / ADR-0040)。問題があれば人間可読な理由を、無ければ `undefined` を返す。
 *
 * **これは referential-integrity.ts 類型13 の適用時検査と同型の判定を実行層にも置く
 * 二重化である**(schedule の `$record.` 拒否が適用時と実行時の両方にあるのと同じ。
 * MCP を迂回してマニフェストが入る経路への防御)。reference 型フィールドの値は参照先の
 * 行の `_id` なので、`resolveValue` がそのまま更新対象 `_id` を返す —— 非 reference
 * フィールドを target に書くと、その値(text 等)を _id と誤解して**別の行を黙って更新
 * する**危険があるので、ここで loud に止める(憲法6)。
 *
 * - `$record._id`(自己更新)/ 他の `_` 始まり(`resolveValue` の領分)/ リテラル
 *   (UUID 等)/ **`trigger.table` を書かない** schedule(record 源が無く
 *   `resolveValue` が fail-closed)は対象外。
 *
 * **`trigger.table` を書いた schedule はここに入る**(`D-G16a`。ADR-0063)——
 * その表の行がトリガー元レコードなので、`on_create` / `on_update` と同じ検査が要る。
 */
function checkTargetReferenceField(
  manifest: Manifest,
  workflow: Workflow,
  target: string,
): string | undefined {
  if (!target.startsWith(RECORD_PREFIX)) {
    return undefined; // リテラル。resolveValue と別問題(実在は updateRecord が見る)。
  }
  const fieldId = target.slice(RECORD_PREFIX.length);
  if (fieldId === "_id" || fieldId.startsWith("_")) {
    return undefined; // 自己更新(_id)/ カーネル列は resolveValue が扱う。
  }
  const triggerTable = workflow.trigger.table;
  if (triggerTable === undefined) {
    // `trigger.table` を書かない schedule は record 源が無く、resolveValue が fail-closed する。
    return undefined;
  }
  const table = manifest.app.tables.find((t) => t.id === triggerTable);
  if (table === undefined) {
    return undefined; // トリガー元テーブル不在は適用時検査(参照整合性)の領分。
  }
  const field = table.fields.find((f) => f.id === fieldId);
  if (field === undefined || field.type !== "reference") {
    return (
      `"${target}" は参照先の行を特定できません。フィールド "${fieldId}" は` +
      `トリガー元テーブル "${triggerTable}" の reference 型フィールドではありません。` +
      `target に \`$record.<フィールド>\` を書けるのは、そのフィールドが reference 型` +
      `(参照先の行を狙う)のときだけです。`
    );
  }
  return undefined;
}

/**
 * `call_external` の実行層遮断(ADR-0020 §3 改訂2。V1-M4-T03)。**同期。**
 *
 * この関数は **secret に一切触れず**(`resolveSecret` を呼ばない)、**fetch もしない。**
 * capability チェック(接続の探索 + 宛先スコープ照合)だけを行い、許可されたら
 * outbox に**積むだけ**である。実際の配送は非同期の `dispatchOutbox` が use-time に
 * secret を解決して行う。**遮断が実行層(runAction)にあることが、バリデーションや
 * プロンプトを迂回した直接呼び出しでも送信を止める根拠である**(限定8c-5)。
 *
 * **すべての失敗経路で fail-closed** —— 接続が無い / 宛先がスコープ外 / DB パスが
 * 想定外(:memory: 等)なら failure 文字列を返し、**outbox に1件も積まない。**
 */
function runCallExternal(
  db: Database,
  action: WorkflowActionCallExternal,
  record: RecordRow | undefined,
): string | undefined {
  // 1. 開いている app.sqlite のパスから dataRoot / appId を復元する。
  //    :memory: や想定外パスなら復元できない → fail-closed(送信させない)。
  let located: { dataRoot: string; appId: string };
  try {
    located = parseAppDbPath(db.filename);
  } catch (error) {
    return `外部送信の所属アプリを特定できませんでした(送信は行いません): ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  const { dataRoot, appId } = located;

  // 2. capability ストア(kernel.sqlite)を開いて、名前で接続を引く。
  const store = CapabilityStore.openForKernel(dataRoot);
  try {
    const conn = store.findConnectionByName(appId, action.connection);
    if (conn === undefined) {
      // 未発行:遮断。**outbox に積まない。**
      return `接続 "${action.connection}" は発行されていません(capability が必要です)。`;
    }

    // 3. payload を解決する(値は `$record.<フィールドID>` かリテラル。限定7)。
    const payload = resolveValues(action.payload, record);
    if (!payload.ok) {
      return payload.message;
    }

    // 4. 宛先スコープの照合(既定 deny。allowedHosts が空なら常に不許可)。
    if (!hostAllowed(conn.allowedHosts, action.destination)) {
      // スコープ外:遮断。**outbox に積まない。**
      return `宛先 "${action.destination}" は接続 "${action.connection}" のスコープ外です。`;
    }

    // 5. 許可された。**送信内容(宛先 + 解決済み payload)を outbox に積むだけ。**
    //    secret はここでは触らない(dispatchOutbox が use-time に解決する)。
    store.enqueueOutbox({
      appId,
      connectionId: conn.id,
      destination: action.destination,
      payload: payload.value,
    });
    return undefined;
  } finally {
    store.close();
  }
}

// 宛先スコープ判定 `hostAllowed` は `host-scope.ts` に切り出した(単一ソース)。
// **enqueue 時のここと、配送時の `outbox-dispatcher.ts` が同じ関数を通る**ことが、
// 将来 owner が許可ホストを狭めたときに両経路で同じ規則が効く根拠である(V1-M4-T05)。

/**
 * `ai_transform` の実行層遮断(ADR-0021 §3。V1-M5-T02)。**同期。**
 *
 * この関数は **AI を呼ばず**(プロバイダに触れない)、**secret にも触れない。**
 * capability チェック(存在)+ 当日の上限判定(§5)+ 連鎖深度判定(§5)だけを行い、
 * 許可されたらジョブを ai_jobs に**積むだけ**である。実際の推論・出力検証・書き戻しは
 * 非同期の `dispatchAiJobs` が担う。**遮断が実行層(runAction)にあることが、バリデーションや
 * プロンプトを迂回した直接呼び出しでも呼び出しを止める根拠である**(ADR-0021 §8c-5)。
 *
 * **すべての失敗経路で fail-closed** —— capability が無い / 上限超過 / 連鎖深度超過 /
 * レコード源が無い / DB パスが想定外なら failure 文字列を返し、**ジョブを1件も積まない。**
 * 上限超過・連鎖超過は `ai_usage` に blocked として記録する(§4 / §5。黙って止めない)。
 */
function runAiTransform(
  db: Database,
  manifest: Manifest,
  workflow: Workflow,
  action: WorkflowActionAiTransform,
  record: RecordRow | undefined,
): string | undefined {
  // 1. ai_transform はトリガー元レコードを要する(書き戻し先がそのレコード。§3)。
  //    `schedule` トリガー(record === undefined)では fail-closed する。
  if (record === undefined) {
    return `ai_transform はトリガー元のレコードを要します(schedule トリガーでは使えません)。`;
  }
  if (workflow.trigger.type === "schedule") {
    return `ai_transform はトリガー元のレコードを要します(schedule トリガーでは使えません)。`;
  }
  const targetTable = workflow.trigger.table;

  // 2. 書き戻し先フィールドがトリガー元テーブルに実在するか(無駄な AI 呼び出しを避ける)。
  const table = manifest.app.tables.find((t) => t.id === targetTable);
  if (table === undefined || !table.fields.some((f) => f.id === action.output_field)) {
    return `書き戻し先フィールド "${action.output_field}" がテーブル "${targetTable}" にありません。`;
  }

  // 3. app.sqlite のパスから dataRoot / appId を復元(:memory: 等は fail-closed)。
  let located: { dataRoot: string; appId: string };
  try {
    located = parseAppDbPath(db.filename);
  } catch (error) {
    return `AI 呼び出しの所属アプリを特定できませんでした(呼び出しは行いません): ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  const { dataRoot, appId } = located;

  const store = AiCapabilityStore.openForKernel(dataRoot);
  try {
    // 4. capability を名前で引く。無ければ遮断(積まない)。
    const capability = store.findCapabilityByName(appId, action.capability);
    if (capability === undefined) {
      return `AI capability "${action.capability}" は発行されていません(capability が必要です)。`;
    }

    // メータリングの共通項目(呼出元 workflow / 記録先ユーザ = レコードの所有者)。
    const clock = getWorkflowClock();
    const usageDate = aiUsageDate(clock);
    // **V4-M10-T09 / ADR-0079**: 宣言があれば「誰の行として書くか」を1ホップで導く。
    // **書かなければ今日どおり**(トリガー元レコード自身の `st_owner`)。
    const derivedActor = resolveWorkflowActor(db, manifest, workflow, record);
    const actor = derivedActor === "" ? null : derivedActor;
    const recordBlocked = (reason: string): string => {
      store.recordUsage({
        appId,
        capabilityId: capability.id,
        workflowId: workflow.id,
        actor,
        model: capability.model,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        status: "blocked",
        usageDate,
        calledAt: clock.now().toISOString(),
      });
      return reason;
    };

    // 5. 連鎖深度の判定(§5)。配送を跨ぐ連鎖をここで早期に止める。
    const chainDepth = currentAiChainDepth();
    if (chainDepth >= AI_MAX_CHAIN_DEPTH) {
      return recordBlocked(
        `AI 呼び出しの連鎖が深度上限(${AI_MAX_CHAIN_DEPTH})に達したため、この呼び出しは行いません。` +
          `ワークフローが AI 呼び出しを連鎖させ続けていないか確認してください。`,
      );
    }

    // 6. 当日の上限判定(§5)。超過なら遮断し blocked として記録(積まない)。
    const totals = store.usageTotalsForDate(capability.id, usageDate);
    const verdict = checkAiLimit(totals, capability.limit);
    if (verdict.exceeded) {
      return recordBlocked(`AI 呼び出しの上限に達しました: ${verdict.reason}`);
    }

    // 7. input / fallback を解決(値は `$record.<フィールドID>` かリテラル。§8c-8)。
    //    **prompt はリテラル**(指示。用途をここで表す)—— レコード由来の文脈は input に
    //    集約し、参照の語彙を1箇所に閉じる。
    const input = resolveValues(action.input, record);
    if (!input.ok) {
      return input.message;
    }
    const fallback = resolveValue(action.fallback, record);
    if (!fallback.ok) {
      return `fallback: ${fallback.message}`;
    }

    // 8. 許可された。ジョブを積むだけ(推論・書き戻しは dispatchAiJobs が担う)。
    store.enqueueJob({
      appId,
      capabilityId: capability.id,
      workflowId: workflow.id,
      actor,
      prompt: action.prompt,
      input: input.value,
      outputField: action.output_field,
      fallback: fallback.value === null ? "" : String(fallback.value),
      targetTable,
      targetRecordId: record._id,
      chainDepth,
    });
    return undefined;
  } finally {
    store.close();
  }
}

/**
 * `run_function` の既定の実行制限(ADR-0024 §2(a) / ADR-0023 の限界を塞ぐ)。
 *
 * - `timeoutMillis = 1000`: QuickJS は同期なので interrupt の deadline 1本で CPU 時間 =
 *   実行時間を担保する(ADR-0023 B2)。**人が組む集計(月ごとに数える等)は1秒で十分に
 *   終わり、これは業務上限ではなく暴走を止める安全弁**である(`WORKFLOW_MAX_DEPTH` と同性格)。
 * - `memoryBytes = 64MiB`: QuickJS 追跡ヒープの上限(`setMemoryLimit`)。
 *   `island-runner.test.ts` の既定と同じ値。
 * - `maxInputBytes = 1MiB`: **ADR-0023 の「TypedArray バッキングは setMemoryLimit に計上されず
 *   ~2GB まで膨らむ」限界を、入力サイズの入口で塞ぐ**(ADR-0023 §2(a) / 限界1)。
 *   入力テーブルが巨大なら island_input_too_large として fail-closed する。
 */
const RUN_FUNCTION_LIMITS: IslandLimits = {
  timeoutMillis: 1000,
  memoryBytes: 64 * 1024 * 1024,
  maxInputBytes: 1024 * 1024,
};

/**
 * 島が1回の発火で返せる更新操作(op)の件数の上限(V3-M13-T10 / ADR-0067 限定 A6。
 * **必須。外せない**)。**超過は拒否する** —— 打ち切って一部だけ書くことはしない。
 *
 * ## 値の根拠(**「これ以上は要らない」ではない**)
 *
 * 1. **実測(`v3-m13-t09.md` §5-2)**: 上限が無かった `T09` の時点で、**300 op = 9ms /
 *    2000 op = 23ms**。1件あたり約 11〜30µs である。**1000 件なら約12ms。**
 * 2. **その約12ms は島自身の実行予算 1000ms(`RUN_FUNCTION_LIMITS.timeoutMillis`)の
 *    1〜2% にすぎず、`V3-M13-T03` が実測した書込ブロック窓(1段 810ms / 6段 3016ms)を
 *    実質伸ばさない。** **上限を持たない今日は、島が返した件数だけ窓が伸びる**
 *    (`ADR-0039` §限界1: `busy_timeout=0` では他の書き手が待たずに即 500)。
 * 3. **出力サイズの上限(1 MiB)の内側に必ず収まる** —— op 1件は実測で約79文字なので、
 *    1000 件でも約79KB である。**2つの上限が矛盾しない。**
 * 4. **本当の根拠は「1000 を超える件数でブロック窓を1度も測っていない」ことである。**
 *    測っていない領域へ踏み込ませない側(fail-closed)に倒す。**業務上の必要件数から
 *    決めた値ではない** —— 必要件数を1件も観測していない。
 *
 * **`RUN_FUNCTION_LIMITS` に足していない**(限定 A9 が3値を凍結しているため)。
 */
const ISLAND_MAX_WRITE_OPS = 1000;

/**
 * `run_function` の実行層(ADR-0024 §Decision。V1-M6-T05 第2段)。**同期。**
 *
 * 1. `manifest.app.functions` から `action.function` の `FunctionDef` を引く。
 * 2. `function.input` を既存語彙で解決して島への入力を作る(table = 全行 / view =
 *    list_view の filter・sort を適用した行 / record = トリガー元の1レコード)。
 *    **集計(count / group by)はここでしない —— それは島のコードの中**(ADR-0024 §7a)。
 * 3. 宣言された capability のブリッジだけを注入する(宣言外は扉を生やさない = 構造的遮断。T04)。
 * 4. `runIslandSync` で島を走らせる。timeout / memory / error / input_too_large は失敗理由を返す。
 * 5. 出力(行の配列)を `function.output.fields` の型で**必ず検証**する(限定4)。
 * 6. 検証済みの行を `output_table` に**全置換**(既存行を全削除 → 挿入。ADR-0024 §Decision)。
 *
 * **すべての失敗経路で fail-closed**: 関数が無い / 入力が解決できない / 島が失敗 /
 * 出力が output.fields に合わない ときは、**output_table を1バイトも触らず**失敗理由を返す
 * (履歴に残る)。全削除は出力検証を通った後にだけ行う。
 */
function runRunFunction(
  db: Database,
  manifest: Manifest,
  workflow: Workflow,
  action: WorkflowActionRunFunction,
  record: RecordRow | undefined,
  /**
   * **押した人**(`V5-M25-T04` / `ADR-0175` 限定7)。**手動起動の入口だけが渡す。**
   * **`on_create` / `on_update` / `schedule` は今日どおり `undefined` である**(限定4)。
   */
  manualActor?: string,
): string | undefined {
  // 1. 関数定義を引く。無ければ失敗(apply 時の参照整合性で普通は防がれるが、実行層でも守る)。
  const fn = (manifest.app.functions ?? []).find((f) => f.id === action.function);
  if (fn === undefined) {
    return `関数 "${action.function}" はこのアプリに存在しません(run_function を実行できません)。`;
  }

  // 2. 入力を既存語彙で解決する(§7a: クエリ言語をカーネルに持ち込まない)。
  const resolvedInput = resolveFunctionInput(db, manifest, fn, record);
  if (!resolvedInput.ok) {
    return resolvedInput.message;
  }

  // 3. capability ブリッジ(宣言 + 付与された分だけ扉を生やす。宣言外は到達不能 = 構造的遮断)。
  //    actor は runAiTransform に倣い、トリガー元レコードの st_owner。無ければ空文字。
  //    **V4-M10-T09 / ADR-0079**: `act_as` の宣言があれば、そこが指す参照先の行の
  //    `st_owner` を1ホップで導く。**書かなければ今日どおりである。**
  const actor = resolveWorkflowActor(db, manifest, workflow, record, manualActor);
  const hostFunctions = buildCapabilityBridges({
    db,
    declaredCapabilities: fn.capabilities ?? [],
    actor,
    workflowId: workflow.id,
  });

  // 4. 島を同期実行する。暴走(timeout / OOM)・例外・巨大入力・未ロードはここで失敗になる。
  const result = runIslandSync({
    code: fn.code,
    input: resolvedInput.value,
    limits: RUN_FUNCTION_LIMITS,
    hostFunctions,
  });
  if (result.status === "failure") {
    return `関数 "${fn.id}" の実行に失敗しました(${result.reason}): ${result.error}`;
  }

  // 5a. **第3のモード(op 配列。D-G15 / ADR-0067)。** 島の出力を「更新操作の配列」として
  //     既存のバッチ器へ流す。**行の配列としての検証(下の 5b)は通さない** —— 返るのは
  //     行ではなく op だからである(`function.output` は `{ ops: true }` を宣言している)。
  if (action.write_ops === true) {
    // **actor は上の `actor`(トリガー元レコードの `st_owner`)と同じ1つの出どころである。**
    // 空文字(= 個人所有でないテーブルからの発火 / 行選択の無い `schedule`)は「actor が
    // 特定できない」であって「共有」ではないので、`null` に倒す(限定 A5 の fail-closed)。
    return applyIslandWriteOps(
      db,
      manifest,
      fn,
      result.output,
      actor === "" ? null : actor,
      workflow.id,
      // **【`V8-M21` / `J-G23`】判定は島の外側で掛ける。** **時刻起動から起きた島は
      // 素通りのまま残る**(限定の逐語)。
      accessJudgmentApplies(workflow),
    );
  }

  // 5b. 出力を function.output.fields の型で検証する(限定4。**信頼しない**)。
  //    ここで弾かれれば output_table / トリガー元レコードは1バイトも変わらない
  //    (全削除・書き戻しは下の段でだけ行う)。
  const validated = validateFunctionOutput(fn, result.output);
  if (!validated.ok) {
    return validated.message;
  }

  // 6a. EC-G6 record 書き戻しモード(Route B。ADR-0037)。write_back があれば、島の出力
  //     (1行)をトリガー元レコード自身のフィールドへ書き戻す(output_table 全置換とは排他。
  //     schema の then 分岐が排他を担保)。検証を通った後にだけ書く。
  if (action.write_back !== undefined) {
    return writeBackToTriggerRecord(db, manifest, workflow, fn, record, validated.value);
  }

  // 6b. output_table へ全置換(再計算)。既存行を全削除 → 検証済み行を挿入(ADR-0024 §Decision)。
  //    **output_table は関数出力専用テーブルであることを設計契約とする** —— 全置換なので、
  //    人手や他アクションが書いた行も次の実行で消える。
  //    schema は write_back が無いとき output_table を必須にする(排他。ADR-0037 限定6)ので、
  //    ここで undefined になるのは MCP を迂回した経路だけ —— 実行層でも fail-closed する。
  const outputTable = action.output_table;
  if (outputTable === undefined) {
    return `関数 "${fn.id}" の run_function に output_table も write_back もありません(どちらか一方が必要です)。`;
  }
  // **【`V8-M21`】全置換の関門**(**`clearOutputTable` の手前に置く。あちらは1バイトも
  // 変えていない**)。**時刻起動は素通しである。**
  if (accessJudgmentApplies(workflow)) {
    const denied = judgeOutputTableReplace({
      db,
      manifest,
      outputTable,
      actor: () => (actor === "" ? null : actor),
    });
    if (denied !== undefined) {
      return denied;
    }
  }
  const cleared = clearOutputTable(db, manifest, outputTable);
  if (cleared !== undefined) {
    return cleared;
  }
  const writeFailures: string[] = [];
  validated.value.forEach((row, index) => {
    const created = createRecord(db, manifest, outputTable, row);
    if (!created.ok) {
      writeFailures.push(`出力${index + 1}行目: ${formatErrors(created.errors)}`);
    }
  });
  if (writeFailures.length > 0) {
    return `関数 "${fn.id}" の出力を "${outputTable}" に書き込めませんでした: ${writeFailures.join(" / ")}`;
  }
  return undefined;
}

/**
 * EC-G6 record 書き戻しモード(Route B。ADR-0037)の書き込み段。
 *
 * 島の出力(検証済みの行配列)を**トリガー元レコード自身のフィールドへ書き戻す**。
 * `ai_transform` の `output_field` 書き戻し(:757 の実在フィールド検査)と同型で、
 * **書き戻しは既存の `updateRecord`(`records.ts`)を通る**(新しい書込関数を作らない =
 * Δ8 非発火)。
 *
 * **すべての失敗経路で fail-closed**(トリガー元レコードを1バイトも触らず失敗理由を返す):
 * 1. **`schedule` トリガー(レコード源が無い)**では書き戻し先が無い(`ai_transform` :747 と同型)。
 * 2. 島の出力が **1行でない**(ADR-0037 は単数を強制。複数行の書き戻しは §3a の別審査)。
 * 3. 書き戻し先フィールドが**トリガー元テーブルに実在しない**(実在フィールド限定。限定4)——
 *    `validateFunctionOutput` は `function.output.fields` の各 id を持つ行に整えるので、
 *    ここでは各 id がトリガー元テーブルに在るかだけを見る。
 *
 * ## §4a 3問の担保(ADR-0037 §3b)
 * (1) 島の暴走は既に上の `runIslandSync`(`RUN_FUNCTION_LIMITS`)が止めており、書き戻しは
 *     予算内で終わった島の後に `updateRecord` を1回呼ぶだけ(島の実行時間を延ばさない)。
 * (2) 書き戻し先は宣言(`write_back` + `output.fields`)で決まり島の出力ではない ——
 *     島は「どのフィールドに書くか」を選べず、任意フィールド任意書き換えにならない。
 * (3) 書き戻し値は `updateRecord` で永続する普通のレコード列(都度計算しない)。undo は DB 全体復元。
 *
 * ## 自己更新の無限ループ(ADR-0037 §S3 (f))
 * 書き戻しは `updateRecord` を通るので on_update ワークフローを再発火させうるが、既存の
 * `firedRecords`(再発火抑止)/ `WORKFLOW_MAX_DEPTH`(深度上限)がそのまま効く(`ai_transform`
 * の書き戻しと同じ経路)。**新しい抑止機構を1つも足さない。**
 */
function writeBackToTriggerRecord(
  db: Database,
  manifest: Manifest,
  workflow: Workflow,
  fn: FunctionDef,
  record: RecordRow | undefined,
  rows: RecordInput[],
): string | undefined {
  // 1. トリガー元レコードを要する(書き戻し先がそのレコード。schedule では fail-closed)。
  if (record === undefined || workflow.trigger.type === "schedule") {
    return `関数 "${fn.id}" の run_function は write_back でトリガー元レコードへ書き戻すため、トリガー元のレコードを要します(schedule トリガーでは使えません)。`;
  }
  const targetTable = workflow.trigger.table;
  const table = manifest.app.tables.find((t) => t.id === targetTable);
  if (table === undefined) {
    return `関数 "${fn.id}" の write_back 先テーブル "${targetTable}" がこのアプリにありません。`;
  }

  // 2. 単数行の強制(ADR-0037 限定5。複数行の書き戻しは別審査 = §3a)。
  if (rows.length !== 1) {
    return `関数 "${fn.id}" の write_back は島の出力が1行である必要がありますが、${rows.length} 行でした(トリガー元レコード1行への書き戻しです)。`;
  }
  const row = rows[0];
  if (row === undefined) {
    return `関数 "${fn.id}" の write_back の出力行を取り出せませんでした。`;
  }

  // 3. 書き戻し先はトリガー元テーブルの実在フィールドに限定(ai_transform :757 と同型)。
  //    validateFunctionOutput が output.fields の id で行を整えるので、各 id の実在だけ見る。
  for (const fieldId of Object.keys(row)) {
    if (!table.fields.some((f) => f.id === fieldId)) {
      return `関数 "${fn.id}" の write_back 先フィールド "${fieldId}" がトリガー元テーブル "${targetTable}" にありません(書き戻し先はトリガー元レコードの実在フィールドに限定されます)。`;
    }
  }

  // 4. トリガー元レコードへ書き戻す。**既存の updateRecord を通す**(records.ts の唯一の関門)。
  //    版(expectedVersion)は渡さない = 内部の自動更新に CAS を課さない(runAction の update_record と同型)。
  const result = updateRecord(db, manifest, targetTable, record._id, row);
  return result.ok
    ? undefined
    : `関数 "${fn.id}" の出力をトリガー元レコード "${record._id}" に書き戻せませんでした: ${formatErrors(result.errors)}`;
}

/**
 * **第3の書込モード(op 配列)の適用段**(`D-G15` / `ADR-0067` §Decision 1。V3-M13-T09)。
 *
 * 島が返した**更新操作の配列**を、**既存のバッチ器 `writeRecords`(`batch.ts` / ADR-0039)に
 * そのまま流す**。**1 op でも失敗すれば全部巻き戻り1バイトも書かない**(ADR-0039 限定3)。
 *
 * ## ここに書かないもの(**限定表の外を1バイトも実装しない**。ADR-0067 §3 / §3a)
 *
 * - **op の構造検証を書き直さない**(限定 A1 / `ADR-0003` §7)—— op が create / update の
 *   2種であること・`table` / `values` / `target` が揃っていることの判定は
 *   **`writeRecords` の中の `validateBatchStructure` 1関門だけが持つ**。ここは
 *   **判定を1つも複製しない**(重複させると経路によって語彙が割れる)。
 * - **値の検証も書かない** —— 型・必須・参照・unique は `createRecord` / `updateRecord` が
 *   見る(バッチ経路・HTTP 経路・MCP 経路と同じ関門)。
 * - **演算を1つも持たない**(限定 A2)—— 「今の値 − 変化分」は島の JS が計算済みであり、
 *   カーネルが受け取るのは値だけである。
 * - **`delete` / where 句 / 反復構文を1つも足さない**(限定 A1)—— `validateBatchStructure`
 *   が create / update 以外を語彙外として拒否する(その拒否をここで再実装しない)。
 * - **システムテーブルの拒否も足さない**(限定 A8)—— `createRecord` / `updateRecord` の
 *   L1(`isSystemTableId`)がそのまま効く。
 *
 * ## ここにだけ書くもの(**この経路にしか無い制約**)
 *
 * **`if_match`(版一致)の必須化**(限定 A7)。バッチ経路の `if_match` は**任意**であり
 * (`ADR-0039` 限定4)、その意味論は1バイトも変えない —— **島の op に対してだけ必須にする**。
 * **新しい CAS 機構は作らない**(既存の `if_match` に載せるだけである)。
 * **ワークフローの `update_record` アクションには CAS を1バイトも課さない**(LWW 維持。
 * `ADR-0040` 限定5)。
 *
 * ## 安全装置(**V3-M13-T10 / 限定 A5・A6。必須。外せない**)
 *
 * 1. **op 件数の上限**({@link ISLAND_MAX_WRITE_OPS})—— 超過は**拒否**する(打ち切らない)。
 * 2. **所有者スコープの検査** —— 判定は `src/server/owner-scope.ts` の `judgeOwnerScopedOp`
 *    **1本だけ**であり、HTTP バッチ経路(`src/server/app.ts`)と**同じ関数**を通る
 *    (限定 A5 の「判定を2箇所に書かない」)。ここに書いてあるのは、その判定結果を
 *    **履歴に載る文面へ翻訳すること**だけである。
 * 3. **島の出力サイズの上限**は `island-runner.ts` の中にある(この関数へ来る前に
 *    `failure` として落ちる)。
 *
 * ## **それでも残っているもの**(**「安全装置を入れたから安全である」とは書かない**)
 *
 * - **島の実行時間は今日も上限を超えうる**(V3-M13-T10 の実測: 出力を上限の内側に収めた
 *   まま 1027ms / 1044ms で `success`。上限は 1000ms)。**本タスクは解いていない。**
 * - **島の実行が書込トランザクションの内側にある**ことで他の書き手がブロックされる窓
 *   (`V3-M13-T03` の実測: 1段 810ms / 6段 3016ms)を**1ミリも解いていない**。
 * - **島が書いた行は監査に1行も残らない**(`onWritten` を渡していない)。
 * - **所有者スコープの事前読取はトランザクションの外にある**(TOCTOU 窓は HTTP バッチ経路と
 *   同じだけ残る)。
 *
 * @returns 成功なら `undefined`、失敗なら理由(履歴に載り、`ADR-0066` により発火元の
 *          書込ごと成立しなくなる)。
 */
function applyIslandWriteOps(
  db: Database,
  manifest: Manifest,
  fn: FunctionDef,
  output: unknown,
  actorId: string | null,
  /** **代理で書いた事実を監査に残すために要る**(`V4-M10-T10` / `ADR-0079` 限定8)。 */
  workflowId: string,
  /**
   * **行ごとのアクセス権を当てるか**(`V8-M21` / `J-G23`)。
   *
   * **偽になるのは時刻起動から起きた島だけである**(限定の逐語「**時刻起動から起きた島は
   * 素通りのまま残る**」)。**既定値を置かない** —— **省略できると「書き忘れた呼び出しが
   * 黙って素通しになる」形になり、それは塞いだつもりの穴が静かに開くのと同じである。**
   * **呼び出しは製品に1本しか無い。**
   */
  judgeAccess: boolean,
): string | undefined {
  // 1. 宣言との一致(`ADR-0024` 限定4 の担保をこの経路へ持ち込む形)。
  //    `write_ops` モードの関数は `output: { ops: true }` を宣言していなければならない。
  if (fn.output.ops !== true) {
    return `関数 "${fn.id}" は run_function の write_ops(更新操作の配列)で呼ばれましたが、output に ops: true を宣言していません(output に fields を宣言した関数は output_table / write_back のモードで使ってください)。`;
  }

  // 2. 形の入口(**行の配列モードと同じ位置に置く fail-closed**)。配列でなければ1件も書かない。
  if (!Array.isArray(output)) {
    return `関数 "${fn.id}" の出力は更新操作の配列である必要がありますが、配列ではありませんでした。`;
  }

  // 2b. **op 件数の上限**(限定 A6。**必須。外せない**)。**超過は拒否である —— 打ち切らない。**
  //     黙って一部だけ書くと「N 件のうち先頭 M 件だけ書けた成功」が履歴に載り、憲法6 が禁じる
  //     「都合の悪い事実を丸めた記録」そのものになる。
  if (output.length > ISLAND_MAX_WRITE_OPS) {
    return `関数 "${fn.id}" が返した更新操作は ${output.length} 件で、上限 ${ISLAND_MAX_WRITE_OPS} 件を超えています(1バイトも書いていません)。`;
  }

  // 3. **この経路にしか無い制約 = update op の if_match 必須**(限定 A7)。
  //    構造そのものの検証は `writeRecords` に委ねるので、ここでは
  //    「update と読める op に if_match が無い」ことだけを見る(判定を複製しない)。
  const missing: number[] = [];
  output.forEach((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return;
    }
    const op = raw as Record<string, unknown>;
    if (op.op === "update" && op.if_match === undefined) {
      missing.push(index);
    }
  });
  if (missing.length > 0) {
    return `関数 "${fn.id}" の更新操作 ${missing.map((i) => i + 1).join(" / ")} 件目に if_match(更新前に読んだ _updated_at)がありません(島が返す update には版一致が必須です)。`;
  }

  // 3b. **所有者スコープの検査**(限定 A5。**必須。外せない**)。
  //     **判定は `judgeOwnerScopedOp` 1本であり、HTTP バッチ経路と同じ関数である。**
  //     ここは判定結果を履歴の文面へ翻訳するだけで、`st_owner` の規約を1つも再実装しない。
  //     **読取はこの下の `writeRecords` が開く tx の外にある**(TOCTOU 窓は HTTP バッチ経路と同じ)。
  for (const [index, rawOp] of output.entries()) {
    const rawTableId =
      typeof rawOp === "object" && rawOp !== null && !Array.isArray(rawOp)
        ? (rawOp as Record<string, unknown>).table
        : undefined;
    const verdict = judgeOwnerScopedOp({
      table: typeof rawTableId === "string" ? resolveTable(manifest, rawTableId) : undefined,
      op: rawOp,
      actorId,
      readRow: (tableId, recordId) => {
        const existing = getRecord(db, manifest, tableId, recordId);
        return existing.ok && existing.value !== null ? existing.value : undefined;
      },
    });
    if (verdict.kind === "invisible") {
      // **存在そのものを伏せる**(HTTP 経路の 404 と同じ扱い)。「他人のものだから駄目」とは書かない。
      return `関数 "${fn.id}" の更新操作 ${index + 1} 件目が指すレコード(テーブル "${verdict.tableId}" の "${verdict.target}")は見つかりません(1バイトも書いていません)。`;
    }
    if (verdict.kind === "forbidden") {
      return `関数 "${fn.id}" の更新操作 ${index + 1} 件目はレコードの所有者を付け替えようとしています(1バイトも書いていません)。`;
    }
    if (verdict.kind === "no_actor") {
      return `関数 "${fn.id}" の更新操作 ${index + 1} 件目は個人所有のテーブルへの作成ですが、この発火には所有者を決められるレコードがありません(1バイトも書いていません)。`;
    }

    // 3c. **行ごとのアクセス権の検査**(`V8-M21` / `J-G23`。**判定は島の外側であり、
    //     島の中には1バイトも出していない**)。**判定の家は同じ `owner-scope.ts` である。**
    //     **op 1件ごとに掛ける** —— **1件でも通らなければ1行も書かない**(この関数の
    //     既存の作法と同じで、部分適用を作らない)。
    if (judgeAccess && typeof rawTableId === "string") {
      const op = rawOp as Record<string, unknown>;
      const target = typeof op.target === "string" ? op.target : undefined;
      // **update op で対象行が読めないときは判定を掛けない** —— **その失敗は
      // `writeRecords` が「その行は無い」として返す**(存在を権限の文面で言い当てさせない)。
      const existing =
        op.op === "update" && target !== undefined
          ? getRecord(db, manifest, rawTableId, target)
          : undefined;
      const targetRow =
        existing !== undefined && existing.ok && existing.value !== null
          ? (existing.value as unknown as Record<string, unknown>)
          : undefined;
      if (op.op !== "update" || targetRow !== undefined) {
        const denied = judgeAutomationWrite({
          db,
          manifest,
          tableId: rawTableId,
          row: targetRow,
          verb: "write",
          actor: () => actorId,
        });
        if (denied !== undefined) {
          return `関数 "${fn.id}" の更新操作 ${index + 1} 件目: ${denied}`;
        }
      }
    }
  }

  // 4. **既存のバッチ器へそのまま流す。** 検証も適用も1トランザクションもあちらが持つ。
  //    **入れ子の tx は SAVEPOINT になる**(発火元の書込を包む `records.ts` の tx の内側)——
  //    op 配列の内側の失敗はここで巻き戻り、アクションの失敗として上へ返る(`ADR-0066`)。
  // **【V4-M10-T10 / D-V4-49 / ADR-0079 限定8】代理で書いた事実を `_auth_activity` に残す。**
  //
  // **着手前の実測(2026-08-03)**: `recordActivity` の非テストの呼び出しは
  // `src/server/app.ts` の2箇所と `src/server/inbound-route.ts` の1箇所だけで、
  // **このファイルからは1度も呼ばれていなかった** —— **ワークフロー / 島の書込は監査に
  // 1行も残っていなかった。**
  //
  // **残すのは「どの自動処理が / 誰の行として / どのテーブルの / どの行を」までである**
  // (完了条件2)。**`_auth_activity` に列を1本も足していない**(完了条件3)——
  // **`userId` に「誰の行として書いたか」、`username` に「どの自動処理が」を入れる。**
  // **`changes` は使わない** —— `ActivityRecord.changes` の doc 逐語「更新以外は `null`」に
  // 従い、島の op については「何を書いたか」を残さない(`ADR-0079` §S3 (c) の限界)。
  //
  // **actor が決まらない書込(`actorId === null`)には1行も残さない** —— そのときは
  // 個人所有テーブルへの create が上の判定で既に止まっており、「誰の代わりに」が無い。
  //
  // **書くのは `writeRecords` が開く同じトランザクションの中である**(HTTP バッチ経路の
  // `onWritten` と同じ作法)—— 後続の op が失敗して巻き戻れば監査行も一緒に巻き戻る。
  if (actorId !== null) {
    ensureAuthActivitySchema(db);
  }
  const written = writeRecords(
    db,
    manifest,
    output as readonly BatchOp[],
    actorId === null
      ? undefined
      : {
          onWritten: (op) => {
            recordActivity(db, {
              userId: actorId,
              username: `workflow:${workflowId}`,
              action: op.op.op === "create" ? "create_record" : "update_record",
              tableId: op.op.table,
              recordId: op.record._id,
            });
          },
        },
  );
  return written.ok
    ? undefined
    : `関数 "${fn.id}" の更新操作を適用できませんでした(1バイトも書いていません): ${formatErrors(written.errors)}`;
}

// --- 自動処理・島の書込に、行ごとのアクセス権を当てる(`V8-M21`)-------------------------
//
// **台帳 `J-G22a` の限定の逐語**: 「`src/kernel/workflow-runner.ts` の書込アクション直前1箇所。
// 判定の家は同上。**主体は今日の1本の規則(この人として動くの宣言があればそれ、無ければ
// きっかけを作った人)をそのまま使う**」。
// **台帳 `J-G23` の限定の逐語**: 「同じ1箇所(**島の外側**)。**島の中には判定を1バイトも
// 出さない**。**時刻起動から起きた島は素通りのまま残る**」。
//
// **【この配線が掛かる範囲。誇張しない】**
//  1. **行ごとのアクセス権(点)を宣言した表**にしか掛からない(オプトイン)。
//     **宣言していない表への自動書込は1ミリも変わらない。**
//  2. **面(役割に束ねた権限。`app.roles[].rules`)は1バイトも掛けていない** ——
//     **カーネルには実効ロール集合を解決する手段が無い**(`_auth_users` を読む口は
//     `src/auth/store.ts` にしかなく、判定の家は1バイト単位で凍結されている)。
//     **`V8-M20` の記録 §9 の 9「面は…ワークフロー・コードの島を1つも止めない」は、
//     面については今日も真である。**
//  3. **決まった時刻に動く処理には掛けない**(`D-V8-33` / `J-G22b` = 保留 /
//     `docs/plan/undecided.md` の `U-3`)。**素通りする経路は AI(MCP)と合わせて2本である。**
//     **【禁止】「全部の入口に効く」と書かない。**
//
// **【先に認めること。隠さない】** **これは fail-closed である** ——
// **`04-rbac-abac-baseline.md` §7-5 (F) の逐語「判定を掛けると、今日動いているアプリの島が
// 落ちる」は、宣言した表について今日から本当に起きる。**

/**
 * **この発火に判定を掛けるか。**
 *
 * **時刻起動(`schedule`)だけが素通しである**(`D-V8-33`)。**行選択の有無を問わない** ——
 * **`trigger.table` を書いた時刻起動も素通しである**(主体は行の持ち主に解決できるが、
 * ユーザ決定は「時刻で動く処理だけは今日どおり素通し」であって「解決できるものは掛ける」
 * ではない)。**この1行が `U-3` の実体である。**
 *
 * ## **【`V8-M26`。メインの裁定(2026-08-10)。この素通りを今日どおり残す】**
 *
 * **これが本軸(`v8` の軸4)の完了後に残る唯一の素通りである。**
 *
 * =====================================================================================
 * **【2026-08-14 訂正(`V8-M5-T05`。裁定 `M0-6`。`ADR-0338` §3-3 の 2)。**
 * **直前の1文を1バイトも書き換えていない】**
 * =====================================================================================
 *
 * **直前の1文は今日は偽である。** **素通りは今日2種である。**
 *
 * | # | どこ | 実測 |
 * |---:|---|---|
 * | 1 | 時刻起動(この直下の判断) | この段落が述べているもの |
 * | 2 | **発火元の行への書き戻し**(`writeBackToTriggerRecord`) | **その関数の本体に、判定を掛けるかを問う式が1つも無い** |
 *
 * **数え方**: **同ファイル全体で「判定を掛けるか」を問う式は 7箇所であり、その7箇所は
 * すべて書き戻しの関数の外に在る。**
 *
 * **【この訂正が言っていないこと。丸めない】**
 *
 * - **軸1 がこの2つ目を塞いだとも、塞がなかったとも書かない** —— **軸1 は書き戻しに
 *   1バイトも触っていない。** **`V8-M0` が名指しして記録し、`V8-M5` が訂正を隣に置いた。**
 * - **この訂正は実行される行を1バイトも変えていない**(`ADR-0338` 限定5)——
 *   **`src/kernel/` に入った差分は、この注釈だけである。**
 * - **`docs/plan/undecided.md` に起票していない**(裁定 `M0-6` がそう決めた)。
 *
 * **【注釈の書き方の限定】** **この訂正文に、上の1文の逐語も判定の綴りも1文字も書き
 * 写していない**(`ADR-0338` §3-3。**書くと `grep -c` の数が動き、限定表の式が自分の
 * 訂正を数え始める**)。
 *
 * **根拠を名指しで置く**:
 *
 *  - **`D-V8-33` / `docs/plan/undecided.md` の `U-3`** —— **時刻で動く処理は今日どおり素通し。**
 *  - **`docs/plan/v8/05-authz-unification-baseline.md` §8 の 6** —— **「決まった時刻に動く
 *    処理が今日も素通しすることを、実測で示すこと」を完了条件として要求している。**
 *  - **同 §9 の 1** —— **「書けるのは『時刻で動く処理を除く経路で効く』までであり、
 *    その1本を必ず併記する」。**
 *
 * **実測は `src/kernel/automation-writer-passthrough.test.ts` の (e) / (e-2) が持つ。**
 * **【禁止】「全部の入口に効く」と書かない。**
 */
function accessJudgmentApplies(workflow: Workflow): boolean {
  return workflow.trigger.type !== "schedule";
}

/**
 * **この発火の書き手**(`J-G22a` の限定「今日の1本の規則をそのまま使う」)。
 *
 * **`resolveWorkflowActor` を1バイトも変えずにそのまま呼ぶ** —— **新しい主体の決め方を
 * 1つも作っていない。** **空文字(特定できない)は `null` に倒す**(島の既存の作法と同じ)。
 */
function automationActorId(
  db: Database,
  manifest: Manifest,
  workflow: Workflow,
  record: RecordRow | undefined,
  manualActor?: string,
): string | null {
  const actor = resolveWorkflowActor(db, manifest, workflow, record, manualActor);
  return actor === "" ? null : actor;
}

// --- `create_record` にも持ち主を押す(`V8-M37` / 台帳 `F-G4` / 門A)-----------------------
//
// **審査が採った道は「道A = 島の側に揃える」である**(`docs/plan/v8/records/v8-m35.md` §5-1)。
// **島の `write_ops` は `src/server/owner-scope.ts` の `judgeOwnerScopedOp` が
// `mutableValues[OWNER_FIELD] = actorId` で押していた** —— **同じ発火の `create_record` は
// 1バイトも書いていなかった。** **その食い違いを、`create_record` の側を島に合わせて畳む。**
//
// **【`S3`(不利な材料)を隠さない。`v8-m35.md` §5-4 の逐語】**
//  1. **`src/kernel/workflow-runner.ts` が持ち主の列の綴りを知ることになる**(**3箇所目**)。
//  2. **時刻起動では主体が解けないので、揃うのは非時刻起動だけである。**
//  3. **今まで空だった行に値が入るので、既存アプリで「今まで誰にも見えなかった行」が
//     見えるようになりうる。** **既定の挙動が変わる。**

/**
 * **持ち主の列(規約)。** **`src/kernel/records.ts` の `OWNER_SCOPE_COLUMN` と同じ持ち方に
 * 倣う** —— **`export` しない**(`Δ8` を発火させない)。
 *
 * **サーバ層の `OWNER_FIELD`(`src/server/owner-scope.ts`)と同じ綴りだが、層をまたいで
 * import しない** —— **`src/kernel/` は `src/server/` に依存しない**(`ADR-0009`)。
 * **`src/kernel/records.ts:650`-`:653` の逐語「同じ綴りが2箇所にあることは代償である」は、
 * 本定数によって **3箇所** になった。** **隠さない。**
 * **同ファイルが既に `record.st_owner` を直に読んでいる**(`resolveWorkflowActor`)ので、
 * この綴りがこのファイルに現れるのは今日が初めてではない。
 */
const OWNER_STAMP_COLUMN = "st_owner";

/**
 * **その表が「持ち主の列を持つ表」か**(`src/server/owner-scope.ts` の `personalOwnerField`
 * とまったく同じ3条件: id が規約の綴り / 型が `text` / `required` でない)。
 *
 * **サーバ層の述語を import しない**(層分離)。**条件を写しているのは代償であり、
 * どちらかが動いたら片方だけ古くなる** —— **上の定数の doc と同じ性質である。**
 */
function hasOwnerStampColumn(manifest: Manifest, tableId: ResourceId): boolean {
  const table = manifest.app.tables.find((candidate) => candidate.id === tableId);
  return (
    table?.fields.some(
      (field) =>
        field.id === OWNER_STAMP_COLUMN && field.type === "text" && field.required !== true,
    ) === true
  );
}

/**
 * **作成する値に、この発火の書き手を押す**(**破壊的に上書きする**)。
 *
 * **上書きなのは島に揃えるためである** —— **`judgeOwnerScopedOp` の create 枝は
 * ワークフロー定義や島が書いた値を捨てて actor を書く。** **「定義に書けば他人名義で作れる」
 * 経路を、`create_record` の側にも作らない。**
 *
 * **押さない場合は2つ**(どちらも**今日の挙動をそのまま残す**):
 *  - **その表が持ち主の列を持たない**(限定1)。**列が無い表に書くと作成そのものが失敗する。**
 *  - **主体が解けない**(`actorId === null`)。**fail-open にしない** ——
 *    **「誰のものとも言えない行」に誰かの名前を勝手に入れない**(限定3)。
 *
 * **時刻起動をここで見ていない** —— **呼び出し側が `accessJudgmentApplies` の内側でだけ
 * 呼ぶ**(判定を掛ける条件と、持ち主を押す条件を2本に割らない)。
 */
function stampAutomationOwner(
  manifest: Manifest,
  tableId: ResourceId,
  values: RecordInput,
  actorId: string | null,
): void {
  if (actorId === null || !hasOwnerStampColumn(manifest, tableId)) {
    return;
  }
  values[OWNER_STAMP_COLUMN] = actorId;
}

/** 判定に要る行を読む。**読めなければ空配列 = fail-closed**(黙って通さない)。 */
function accessSourceRows(
  db: Database,
  manifest: Manifest,
  tableId: ResourceId,
): readonly Record<string, unknown>[] {
  const result = listRecords(db, manifest, tableId, {});
  return result.ok ? (result.value as unknown as Record<string, unknown>[]) : [];
}

/**
 * **この発火の書き手の実効ロール集合**(`V8-M21`。**面を効かせるために要る**)。
 *
 * **規則は認証層の1本(`列の1値 ∪ 付与表`)である** —— **ここで役割を組み立てていない。**
 * **書き手が特定できない発火(`null`)と、`_auth_*` を持たない接続では `null`** ——
 * **面の判定は未ログインと同じ主体(予約語の1つ)で評価される。**
 */
function automationActorRoles(db: Database, actorId: string | null): ActorRoles {
  return actorId === null ? null : effectiveRolesOnDb(db, actorId);
}

/**
 * **`actor` の thunk を1回だけ解く包み**(**同じ発火で何度も解き直さない**)。
 *
 * **`judgeOutputTableReplace` は既存行の件数ぶん {@link judgeAutomationWrite} を呼ぶので、
 * 包まないと書き手の解決(1ホップ読取)が行数ぶん走る。**
 * **答えは発火のあいだ変わらない**(`resolveWorkflowActor` が見るのはトリガー元の行だけで、
 * 出力先の行を1件も見ない)。
 */
function onceActor(actor: () => string | null): () => string | null {
  let resolved = false;
  let cached: string | null = null;
  return () => {
    if (!resolved) {
      cached = actor();
      resolved = true;
    }
    return cached;
  };
}

/**
 * **書込1件にアクセス権を当てる。** 通れば `undefined`、止めれば**履歴に載る理由**。
 *
 * ## **【`V8-M21` の後半で、面と点の合成ごと掛かるようになった。旧文をここに残す】**
 *
 * **旧の doc(逐語。前半の担当が書いたもの)**:
 * > - **作成**(`row` を渡さない)—— **その主体がメンバー表に行を持つときだけ通す。**
 * >   **判定は `creatorGrantPlan`(既存)であり、「作った本人に何が渡るか」を答える述語の
 * >   `no_member` の枝をそのまま使う** —— **新しい述語を1本も作っていない。**
 * >   **【なぜ行の判定ではないか】** **これから作る行には付与が1件も存在しないので、
 * >   行ごとの判定は誰に対しても偽になる**(= その表への自動作成が全部止まる)。
 * > - **更新・削除**(`row` を渡す)—— **`resolveRecordAccess`(既存。引き継ぎを辿ってから
 * >   各段で判定を呼ぶ側)の答えをそのまま使う。**
 *
 * **前半は点(行ごとの付与)だけを掛けていた** —— **面は1バイトも掛かっておらず、
 * `V8-M20` の記録 §9 の 9「面は…ワークフロー・コードの島を1つも止めない」が真のまま
 * 残っていた。** **後半がそれを塞いだ。**
 *
 * ## **今日の形(3行で全部である)**
 *
 *  1. **どちらの層も管轄外なら、今日どおり通す**(オプトイン。**宣言していない表への
 *     自動書込は1ミリも変わらない**)。
 *  2. **作成**: **面(`役割 × 表 × 書込`)と、点(`creatorGrantPlan`)を `OR` で重ねる**
 *     ({@link combineRoleAndCreatorGrant})。
 *  3. **更新・削除**: **{@link resolveCombinedRecordAccess}**(面と点を `OR` で重ねる側)。
 *     **その中で `resolveRecordAccess` が呼ばれ、各段で判定の家が呼ばれる。**
 *
 * **合成の規則を1つも書いていない** —— **`OR` を決めているのは `owner-scope.ts` の
 * 既存1本である。** **`V8-M19` がブラウザの経路に入れたものと同じ関数であり、
 * 入口ごとに振る舞いが割れない**(`ADR-0003` §7)。
 *
 * **【`OR` は書ける側に倒れる】** —— **面が締めても点が開いていれば書ける。**
 * **【禁止】「`OR` なので安全側に倒れる」と書かない。**
 *
 * **【判定式を1つもここに書いていない】** —— **行ごとのアクセス権の宣言の綴りも権限名も
 * 1文字も持たない**(`ADR-0061` 限定4 / `ADR-0294` 限定12 と同じ作法)。
 * **綴りそのものをこの doc にも書かない** —— **`src/server/access-control-localization.test.ts`
 * の (2) が「その綴りを持つ `src/server/` の外の非テスト製品ファイル」を全量で固定しており、
 * コメントに書くだけでその一覧に載ってしまうからである**(実測: 書いたら赤くなった)。
 *
 * ## **【`V8-M26`。素通しの条件を「規則の不在」から「書き手の不在」へ差し替えた】**
 *
 * **旧の1行(逐語)**:
 *
 * > ```ts
 * > const sources = recordAccessSourceTables(manifest, tableId);
 * > if (sources === undefined && !roleGovernsTable(manifest, tableId, verb)) {
 * >   // **面も点も管轄外の表** —— **今日どおり**(オプトイン)。
 * >   return undefined;
 * > }
 * > ```
 *
 * **`roleGovernsTable` は `judgeRoleAccess(...).governed` を見ていた。**
 * **`V8-M26-T03` が既定を閉じる側へ倒した結果、`governed` は表について**常に真**になり
 * (`src/server/owner-scope.ts` の `roleRulesNameTarget` の doc が
 * 「`governed` はもう『宣言の実在』の答えではない」と自ら書いている)、
 * **この素通しは1度も成り立たなくなった。**
 * **その結果、書き手を特定できない発火がどの表にも1行も書けなくなった** ——
 * **書き手 `null` は面から見て未ログインと同じ主体であり、そこには書込の規則を
 * 1本も書けないので、規則をいくら足しても通らない**(スキーマの `J-G11` の分岐が
 * その主体の `can` を読取1語に閉じている)。
 *
 * **今日の条件は「書き手が特定できない発火は、面の判定を掛けずに今日どおり通す」である。**
 *
 *  - **「規則が書かれていないから通す」ではない** —— **既定を閉じたので今日もう成り立たない。**
 *  - **書き手が特定できる発火は、今日どおり面の判定を受ける**(**ここは緩めていない**)。
 *  - **点(行ごとの付与)を宣言した表は、書き手が居なくても今日どおり判定を受ける** ——
 *    **緩めたのは面だけである。** **書き手が居ない相手に点が渡ることは元から無いので、
 *    答えは着手前と同じ「止まる」である。**
 *
 * **【正直に書く】これは fail-open 側の分岐である。** **「書き手が居ない」は
 * 「誰でもない人が書いてよい」ではない** —— **今日の面には「書き手が居ない発火」を
 * 表す主体が1つも無いので、判定に掛けると全部止まる、という理由で通している。**
 * **`src/server/owner-scope.ts` の `roleRulesNameTarget` は「これを見て通す・止める実装を
 * 書いてはならない」と doc に書かれているので、そちらは使っていない**
 * (そもそも `src/kernel/` は `src/server/` に依存できない)。
 *
 * **実測は `src/kernel/automation-writer-passthrough.test.ts` の (f) / (f-3) が持つ。**
 */
function judgeAutomationWrite(params: {
  db: Database;
  manifest: Manifest;
  tableId: ResourceId;
  /** **更新・削除の対象行。** **作成では渡さない。** */
  row?: Record<string, unknown> | undefined;
  verb: "write" | "delete";
  /** **書き手を解く。** **どちらの層も管轄外なら1度も呼ばれない**(無駄な1ホップ読取を作らない)。 */
  actor: () => string | null;
}): string | undefined {
  const { db, manifest, tableId, row, verb } = params;
  const sources = recordAccessSourceTables(manifest, tableId);
  const actorId = params.actor();
  if (actorId === null && sources === undefined) {
    // **書き手を特定できない発火で、点も管轄外の表** —— **今日どおり通す**(上の doc)。
    return undefined;
  }
  const roles = automationActorRoles(db, actorId);
  const who = actorId === null ? "この発火では書き手を特定できません" : `"${actorId}"`;
  if (row === undefined) {
    // **作成。** **面は「役割 × 表 × 書込」を、点は「作った本人に何が渡るか」を答える。**
    const combined = combineRoleAndCreatorGrant({
      role: judgeRoleAccess({
        manifest,
        roles,
        target: { target: "table", table: tableId },
        verb: "write",
        subject: actorId,
      }),
      plan:
        sources === undefined
          ? undefined
          : creatorGrantPlan({
              manifest,
              tableId,
              actorId,
              memberRows:
                sources.memberTable === undefined
                  ? []
                  : accessSourceRows(db, manifest, sources.memberTable),
            }),
    });
    if (combined.allowed) {
      return undefined;
    }
    return (
      `テーブル "${tableId}" はアクセス権で守られていますが、この自動処理の書き手(${who})には` +
      `作る権限がありません(止めた層: ${combined.blockedBy.join(" / ")}。1バイトも書いていません)。`
    );
  }
  const resolved = resolveCombinedRecordAccess({
    manifest,
    tableId,
    row,
    actorId,
    roles,
    sources,
    readRows: (id) => accessSourceRows(db, manifest, id),
    readRow: (id, recordId) => {
      const found = getRecord(db, manifest, id, recordId);
      return found.ok && found.value !== null
        ? (found.value as unknown as Record<string, unknown>)
        : undefined;
    },
  });
  if (resolved.kind === "limit_exceeded") {
    // **上限に当たったことを「権限が無い」に丸めない**(`Z-G17` の作法)。
    return (
      `テーブル "${tableId}" のアクセス権を解けませんでした` +
      `(引き継ぎの上限に当たりました: ${resolved.limit})。1バイトも書いていません。`
    );
  }
  if (resolved.verdict[verb]) {
    return undefined;
  }
  return (
    `テーブル "${tableId}" の行 "${String(row._id)}" はアクセス権で守られていて、` +
    `この自動処理の書き手(${who})には${verb === "delete" ? "消す" : "書き換える"}権限が` +
    `ありません(止めた層: ${resolved.blockedBy[verb].join(" / ")}。1バイトも書いていません)。`
  );
}

/**
 * **`output_table` 全置換の関門**(`V8-M21`。**明示的に決めた扱い。黙って素通しにも
 * 黙って停止にもしていない**)。
 *
 * **全置換は「既存行を全部消してから書き直す」である。** **判定を素直に当てると、
 * 出力先を宣言した表では再計算が全部止まる**(着手前実測D)。**そこで次の形を採った**:
 *
 *  1. **書く権限**(= 主体がメンバー表に行を持つか)を**1度だけ**問う。
 *  2. **既存行を1件残らず消せるか**を、**消し始める前に**全件について問う。
 *     **1行でも消せなければ、1行も消さない** —— **途中まで消えた出力先を作らない。**
 *  3. **既存行が0件なら、消す権限は1つも問わない** —— **消すものが無いからである。**
 *     **書く権限は今日も問う。**
 *
 * **【この判断が意味すること。丸めない】** **出力先に行ごとのアクセス権を宣言した
 * アプリでは、その表の行を全部消せる主体でなければ再計算が止まる。** **止まったことは
 * 履歴に理由つきで残る**(黙って古い集計が残る形にはしない)。
 *
 * **`clearOutputTable` そのものは1バイトも変えていない**(関門はその手前に置いた)。
 */
function judgeOutputTableReplace(params: {
  db: Database;
  manifest: Manifest;
  outputTable: ResourceId;
  actor: () => string | null;
}): string | undefined {
  const { db, manifest, outputTable } = params;
  // **【`V8-M26`】書き手は1回だけ解く**({@link onceActor})—— **下の繰り返しで解き直さない。**
  const actor = onceActor(params.actor);
  // **【`V8-M21` の後半】** **旧: `if (recordAccessSourceTables(manifest, outputTable) === undefined)`。**
  // **面(役割に束ねた権限)だけを宣言した出力先でも関門が立つようにした** ——
  // **点だけを見ていると、面で締めた出力先が素通りする。**
  //
  // **【`V8-M26`。素通しの条件を「規則の不在」から「書き手の不在」へ差し替えた】**
  // **旧の2行(逐語)**: `!roleGovernsTable(manifest, outputTable, "write") &&`
  // `!roleGovernsTable(manifest, outputTable, "delete")`。
  // **既定を閉じた今日、`roleGovernsTable` は表について常に真であり、この関門は
  // 1度も外れなくなっていた** —— **その結果、書き手を特定できない発火の全置換が
  // どの出力先でも止まっていた。** **理由は {@link judgeAutomationWrite} の doc に全部書いた。**
  if (recordAccessSourceTables(manifest, outputTable) === undefined && actor() === null) {
    return undefined;
  }
  const write = judgeAutomationWrite({ db, manifest, tableId: outputTable, verb: "write", actor });
  if (write !== undefined) {
    return `出力先テーブル "${outputTable}" を作り直せません: ${write}`;
  }
  const existing = accessSourceRows(db, manifest, outputTable);
  for (const row of existing) {
    const denied = judgeAutomationWrite({
      db,
      manifest,
      tableId: outputTable,
      row,
      verb: "delete",
      actor,
    });
    if (denied !== undefined) {
      return (
        `出力先テーブル "${outputTable}" を作り直せません` +
        `(既存 ${existing.length} 行のうち1行でも消せないときは1行も消しません): ${denied}`
      );
    }
  }
  return undefined;
}

// --- 自動処理が「誰の行として書くか」(`E-G41` / V4-M10-T09 / ADR-0079)------------------
//
// **`ADR-0079` §Decision 1 の逐語**: 「値は `$record.<参照フィールドID>` の1形だけである。
// **その参照が指す行の `st_owner` を、そのワークフローの書込の actor とする。**」
//
// **辿るのは1ホップだけである**(限定3)—— 参照先の行を1回読み、その `st_owner` を取る。
// **参照先の参照は辿らない。** **辿れないとき(宣言が無い / トリガー元レコードが無い /
// 参照フィールドが実在しない・reference 型でない / 参照が空 / 参照先の行が無い /
// 参照先に `st_owner` が無い)は、今日どおりの既定に倒れる**(限定4)——
// **既定はトリガー元レコード自身の `st_owner` であり、それも無ければ空文字**
// (呼び出し側が `""` を `null` に倒して fail-closed する)。
//
// **【この宣言が変えないもの。先に書く(憲法6)】**
//  1. **`isAllowedOwnerUpdate`(`src/server/owner-scope.ts:59`-`:61`)を1バイトも変えない**
//     (限定5)—— **開くのは「その所有者として書く」ことであって「所有者を書き換える」
//     ことではない。**
//  2. **HTTP 経路の無条件スタンプを1バイトも変えない**(限定6)—— **人間が HTTP から
//     他人の行を作れるようにはならない**(`E-G56` は射程外)。
//  3. **受信 capability の経路(`src/server/inbound-route.ts`)を1バイトも変えない**
//     (限定7)。**同経路が `judgeOwnerScopedOp` を1度も通らない穴は今日も開いたままである。**
//  4. **MCP 経路を1ミリも守らない / 変えない**(限定11)。
//  5. **行選択の無い `schedule` では今日と1ミリも変わらない**(トリガー元レコードが無い)。

/** `act_as` の値の接頭辞(`$defs/workflow.act_as` の `pattern` と同じ形)。 */
const ACT_AS_PREFIX = "$record.";

/**
 * このワークフローの書込の actor(= 所有者 id)を決める。**空文字は「特定できない」。**
 *
 * **宣言が無ければ今日どおり**トリガー元レコード自身の `st_owner` を返す(後方互換)。
 */
function resolveWorkflowActor(
  db: Database,
  manifest: Manifest,
  workflow: Workflow,
  record: RecordRow | undefined,
  /**
   * **押した人**(`V5-M25-T04` / `L-G11a` / `ADR-0175` §6-3 / 限定7)。
   *
   * **`ADR-0175` §6-3 の逐語**: 「**`act_as` の宣言があればそれ、無ければ渡された人**
   * —— **今日「無ければアプリの owner」だった側が「無ければ押した人」に変わるのは、
   * `trigger_type` が `manual` のときだけである。**」
   *
   * **【分岐は 2 → 2 のままである】** **本引数は「宣言が無いときの既定」を差し替えるだけで、
   * 分岐を1本も足していない。** **`trigger.type` をこの関数は1度も見ない** ——
   * **「手動のときだけ別の規則」を作っていない**(限定7 の「3つ目の規則を1つも作らない」)。
   * **渡ってくるのが手動起動のときだけである**、というのが唯一の差である。
   */
  manualActor?: string,
): string {
  const fallback =
    manualActor ??
    (record !== undefined && typeof record.st_owner === "string" ? record.st_owner : "");
  const declared = workflow.act_as;
  if (typeof declared !== "string" || !declared.startsWith(ACT_AS_PREFIX)) {
    return fallback;
  }
  if (record === undefined) {
    // **行選択の無い `schedule`** —— 辿る起点が無いので今日どおり fail-closed(限定4)。
    return "";
  }
  const fieldId = declared.slice(ACT_AS_PREFIX.length);
  const triggerTable = manifest.app.tables.find((table) =>
    table.fields.some((field) => field.id === fieldId),
  );
  const field = triggerTable?.fields.find((candidate) => candidate.id === fieldId);
  if (field === undefined || field.type !== "reference") {
    // **reference 型でなければ辿れない** —— **ここで別の意味に倒さない**(限定4)。
    return "";
  }
  const targetId = record[fieldId];
  if (typeof targetId !== "string" || targetId === "") {
    return "";
  }
  // **1ホップだけ読む。** 読んだ行の参照はもう辿らない(限定3)。
  const target = getRecord(db, manifest, field.reference_table, targetId);
  if (!target.ok || target.value === null) {
    return "";
  }
  const owner = (target.value as Record<string, unknown>).st_owner;
  return typeof owner === "string" ? owner : "";
}

/**
 * `function.input`(既存語彙への参照)を解決して島への入力を作る(ADR-0024 限定3 /
 * **ADR-0062 限定4**)。
 *
 * - **単体形**(オブジェクト1つ)… 今日と同一の値をそのまま渡す。**配列で包まない**
 *   (後方互換。ADR-0062 限定12)。
 * - **配列形**(最大5要素)… **各要素を既存3分岐でそのまま解決し、宣言順に並べた配列**を
 *   渡す。**結合・射影・集約・参照解決・重複排除・ソートを1行も実装しない**(限定4)——
 *   どの行がどの行に対応するかの突き合わせは**島の JavaScript の仕事**である。
 *   **参照展開(`$record.<ref>.<field>`)・多段・join を1つも作らない**(限定7。
 *   ADR-0040 限定2 / ADR-0044 限定3 は1バイトも破られていない)。
 * - **1要素でも解決に失敗したら全体を fail-closed する**(`output_table` を1バイトも
 *   触らずに失敗理由を返す)。
 * - **実行予算は1つも動かない**(限定6)—— 判定は `runIslandSync` の中で**直列化後の
 *   総バイト数1本**である(**和であって積ではない**。カーネルが結合しないため)。
 */
function resolveFunctionInput(
  db: Database,
  manifest: Manifest,
  fn: FunctionDef,
  record: RecordRow | undefined,
): Resolved<unknown> {
  const declared = fn.input;
  if (!Array.isArray(declared)) {
    return resolveOneFunctionInput(db, manifest, fn, declared, record);
  }
  // **宣言順に、既存3分岐をそのまま繰り返すだけである。** 突き合わせも並べ替えも重複排除も無い。
  const values: unknown[] = [];
  for (const one of declared) {
    const resolved = resolveOneFunctionInput(db, manifest, fn, one, record);
    if (!resolved.ok) {
      return resolved;
    }
    values.push(resolved.value);
  }
  return { ok: true, value: values };
}

/**
 * 入力宣言を**1つ**解決する(既存の3分岐。**意味論を1バイトも変えていない**)。
 *
 * - `source: "table"` … そのテーブルの全行(`listRecords`)を配列で渡す。
 * - `source: "view"` … その list_view の filter / sort を適用した行を渡す(「どの行か」は
 *   既存の list_view が表す。新しいクエリ文法を1つも足さない。§7a)。
 * - `source: "record"` … トリガー元の1レコード。無ければ失敗(schedule では使えない)。
 */
function resolveOneFunctionInput(
  db: Database,
  manifest: Manifest,
  fn: FunctionDef,
  input: FunctionInput,
  record: RecordRow | undefined,
): Resolved<unknown> {
  if (input.source === "record") {
    if (record === undefined) {
      return {
        ok: false,
        message: `関数 "${fn.id}" は入力に $record(トリガー元レコード)を要しますが、この発火にはきっかけとなるレコードがありません(schedule では使えません)。`,
      };
    }
    return { ok: true, value: record };
  }

  if (input.source === "table") {
    // **`E-G72` / `V4-M10-T44` / `ADR-0083`**: `via` があれば、**その子テーブル上の
    // reference フィールドがトリガー元レコードを指している行だけ**を渡す。
    //
    // **突き合わせは既存の等値 filter 1つだけである**(限定6 / 限定9)——
    // **`ADR-0044` の `related` が読取経路で今日やっているのと同一の形**であり、
    // **結合・射影・集約・重複排除・ソートを1行も実装していない。**
    // **禁止7語(`where` / `filter` / `select` / `count` / `group_by` / `join` / `on`)を
    // 1語も足していない**(限定2)—— ここで使う `filter` は `listRecords` が今日持つ
    // 既存の読取オプションであって、`$defs/function_input` の語彙ではない。
    //
    // **1ホップだけである**(限定5)。**逆参照(親を絞る)は1つも作らない** ——
    // `E-G72` の `member` の全件読みはこの形では1ミリも解けない(`ADR-0083` §限界4)。
    const options: ListRecordsOptions = {};
    if (input.via !== undefined) {
      if (record === undefined) {
        // **トリガー元レコードが無い発火**(`trigger.table` を持たない `schedule`)。
        // **適用時に拒否しているので通常はここに来ない**(限定4)。実行層でも fail-closed する。
        return {
          ok: false,
          message: `関数 "${fn.id}" の入力は via(トリガー元レコードに紐づく行だけを渡す指定)を持ちますが、この発火にはきっかけとなるレコードがありません。`,
        };
      }
      options.filter = [{ field: input.via, equals: record._id }];
    }
    const rows = listRecords(db, manifest, input.table, options);
    if (!rows.ok) {
      return {
        ok: false,
        message: `関数 "${fn.id}" の入力テーブル "${input.table}" を読めませんでした: ${formatErrors(rows.errors)}`,
      };
    }
    return { ok: true, value: rows.value };
  }

  // source === "view": list_view を引き、その filter / sort を適用した行を渡す。
  // `viewId` を先に取り出すのは、`.find` のコールバック内では `input` の絞り込みが
  // 失われる(クロージャ越しの narrowing は保証されない)ためである。
  const viewId = input.view;
  const view = manifest.app.views.find(
    (v): v is ListView => v.type === "list_view" && v.id === viewId,
  );
  if (view === undefined) {
    return {
      ok: false,
      message: `関数 "${fn.id}" の入力一覧(list_view) "${viewId}" はこのアプリに存在しません。`,
    };
  }
  // `exactOptionalPropertyTypes` 下では undefined を明示代入できないので、定義済みのキーだけ渡す。
  const options: ListRecordsOptions = {};
  if (view.sort !== undefined) {
    options.sort = view.sort;
  }
  if (view.filter !== undefined) {
    options.filter = view.filter;
  }
  const rows = listRecords(db, manifest, view.table, options);
  if (!rows.ok) {
    return {
      ok: false,
      message: `関数 "${fn.id}" の入力一覧 "${viewId}" の行を読めませんでした: ${formatErrors(rows.errors)}`,
    };
  }
  return { ok: true, value: rows.value };
}

/**
 * 島の出力(行の配列を期待)を `function.output.fields` の型で検証する(ADR-0024 限定4)。
 *
 * **既存のフィールド値検証(`validateDbFreeFieldValue`)を再利用する** —— 経路によって
 * 値検証の振る舞いが割れないため(ADR-0003 §7)。`output.fields` は `{ id, type }` だけで
 * options / reference_table を持たない(スキーマ `function_output_field`)ので、select /
 * reference は「文字列であること」だけを見る(選択肢照合・参照先実在は、下流の `createRecord`
 * が output_table のフィールド定義で担う)。
 *
 * 返すのは各行の `RecordInput`(検証済みの JS 値)。1件でも型が合わなければ fail-closed。
 */
function validateFunctionOutput(fn: FunctionDef, output: unknown): Resolved<RecordInput[]> {
  // **宣言との一致**(ADR-0067 限定 A3 の裏返し)。`output: { ops: true }` を宣言した関数は
  // 行の配列を返さないので、`output_table` / `write_back` の2モードでは fail-closed する。
  const declaredFields = fn.output.fields;
  if (declaredFields === undefined) {
    return {
      ok: false,
      message: `関数 "${fn.id}" は output に ops(更新操作の配列)を宣言しているので、output_table 全置換 / write_back 書き戻しのモードでは使えません(run_function に write_ops: true を書いてください)。`,
    };
  }
  if (!Array.isArray(output)) {
    return {
      ok: false,
      message: `関数 "${fn.id}" の出力は行の配列である必要がありますが、配列ではありませんでした。`,
    };
  }
  const errors: ValidationError[] = [];
  const rows: RecordInput[] = [];
  output.forEach((row, rowIndex) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      errors.push({
        path: `/${rowIndex}`,
        message: `関数 "${fn.id}" の出力の ${rowIndex + 1} 件目が行(オブジェクト)ではありません。`,
        hint: "出力は行(フィールド → 値のオブジェクト)の配列である必要があります。",
      });
      return;
    }
    const source = row as Record<string, unknown>;
    const validatedRow: RecordInput = {};
    for (const field of declaredFields) {
      const value = source[field.id] ?? null;
      const path = `/${rowIndex}/${field.id}`;
      if (
        field.type === "reference" ||
        field.type === "select" ||
        field.type === "image" ||
        field.type === "file"
      ) {
        // options / reference_table / _files を宣言しない出力スキーマでは「文字列であること」
        // だけを見る(image / file は file_id 文字列。V2-M2 / ADR-0035 / V5-M16 / ADR-0161。
        // 実在確認はここでは行わない —— reference がここで実在確認しないのと同型)。
        if (value !== null && typeof value !== "string") {
          errors.push({
            path,
            message: `関数 "${fn.id}" の出力フィールド "${field.id}" には文字列(${field.type})を期待しましたが、そうではありませんでした。`,
            hint: `このフィールドの型は "${field.type}" です。`,
          });
          continue;
        }
        validatedRow[field.id] = value;
        continue;
      }
      // number / boolean / text / long_text / date は既存の値検証をそのまま再利用する。
      const before = errors.length;
      validateDbFreeFieldValue(
        { id: field.id, name: field.id, type: field.type } as OutputDbFreeField,
        value,
        path,
        errors,
      );
      if (errors.length === before) {
        validatedRow[field.id] = value;
      }
    }
    rows.push(validatedRow);
  });
  if (errors.length > 0) {
    return {
      ok: false,
      message: `関数の出力がスキーマ検証に失敗しました: ${formatErrors(errors)}`,
    };
  }
  return { ok: true, value: rows };
}

/**
 * `validateDbFreeFieldValue` に渡す出力フィールドの最小形。
 *
 * `output.fields[]` は `{ id, type }` だけを持つ(スキーマ `function_output_field`)。
 * select / reference は上流で別扱いにするので、ここに来る `type` は number / boolean /
 * text / long_text / date のいずれかであり、options / reference_table を要しない。
 */
type OutputDbFreeField = {
  id: ResourceId;
  name: string;
  type: Exclude<FieldType, "select" | "reference" | "image" | "file">;
};

/**
 * `output_table` の既存行を**全削除**する(全置換の前段。ADR-0024 §Decision)。
 *
 * 成功なら `undefined`、失敗なら理由文字列。**`deleteRecord` を1行ずつ回す** —— カーネルの
 * 削除経路を通すことで、システムテーブルの拒否など既存の関門をそのまま効かせる。
 * ここに到達するのは出力検証を通った後だけなので、検証失敗で output_table を壊すことはない。
 */
function clearOutputTable(
  db: Database,
  manifest: Manifest,
  outputTable: ResourceId,
): string | undefined {
  const existing = listRecords(db, manifest, outputTable, {});
  if (!existing.ok) {
    return `出力先テーブル "${outputTable}" を読めませんでした: ${formatErrors(existing.errors)}`;
  }
  for (const row of existing.value) {
    const deleted = deleteRecord(db, manifest, outputTable, row._id);
    if (!deleted.ok) {
      return `出力先テーブル "${outputTable}" の既存行を削除できませんでした: ${formatErrors(deleted.errors)}`;
    }
  }
  return undefined;
}

type Resolved<T> = { ok: true; value: T } | { ok: false; message: string };

/** `values` の全項目を解決する。1つでも解決できなければアクションごと失敗させる。 */
function resolveValues(
  values: Record<string, string>,
  record: RecordRow | undefined,
): Resolved<RecordInput> {
  const resolved: RecordInput = {};
  for (const [key, raw] of Object.entries(values)) {
    const value = resolveValue(raw, record);
    if (!value.ok) {
      // **解決に失敗したら、空文字や null に落とさずアクションごと失敗させる。**
      // 落とすと「新しい本が登録されました(対象: )」が通知として届く —— 憲法6 に正面から反する。
      return { ok: false, message: `${key}: ${value.message}` };
    }
    resolved[key] = value.value;
  }
  return { ok: true, value: resolved };
}

const RECORD_PREFIX = "$record.";

/**
 * 1つの値を解決する(限定12)。
 *
 * - `$` で始まらない文字列は**リテラル**である。たまたまフィールドIDと同じ綴りでも触らない。
 * - `$record.<フィールドID>` と `$record._id` **だけ**を解決する。
 *   `_created_at` / `_updated_at` を含む他の `_` 始まりは解決エラーにする(規則が1つで済む)。
 * - `$` で始まるがこの形でないものも解決エラーにする —— リテラルとして黙って通すと、
 *   綴り間違いの参照が「そのままの文字列」として通知に載る(憲法6)。
 *
 * **判定は2段であり、段ごとに規則が違う。混同しないこと。**
 *
 * 1. **`$record.` という接頭辞が付いているか** —— **前方一致で見る**(`startsWith`)。
 *    限定12 により `$record.<フィールドID>` 以外の形はスキーマが既に拒否しているので、
 *    前方一致で過不足が無い。`referential-integrity.ts` の適用時検査(§2-2 判断3)も
 *    同じ接頭辞・同じ前方一致で判定しており、**2箇所で規則が食い違っていない。**
 * 2. **接頭辞を剥がした後のフィールドIDの比較** —— **完全一致で見る。前方一致にしない。**
 *    ここを前方一致にすると `$record.title_kana` が `title` で壊れる。
 *    `apply-diff.ts` の `renameRecordReference`(`:791`)が同じ判断をしており、
 *    **書き換え側と解決側が同じ規則で動くことが、限定12 が1形しか許さないことの帰結である。**
 *
 * **【この注記を足した理由。V1-M2-T02 で追記】** 元のコメントは「完全一致で判定する。
 * 前方一致にしない」とだけ書いており、**すぐ下の実装が `startsWith` を2回使っている**ので、
 * 読んだ者が「コメントと実装が矛盾している」と受け取る。**実際に並行作業者がそう報告してきた。**
 * 矛盾ではなく段が違うのだが、**それが書かれていなかった。**
 * **規則をコメントに焼き込むときは、どの段の話かを書くこと。書かないと次の者が誤って直す。**
 */
function resolveValue(value: string, record: RecordRow | undefined): Resolved<RecordValue> {
  if (!value.startsWith("$")) {
    return { ok: true, value };
  }
  if (!value.startsWith(RECORD_PREFIX)) {
    return {
      ok: false,
      message: `"${value}" は参照の形になっていません。書けるのは "$record.<フィールドID>" だけです。`,
    };
  }
  const fieldId = value.slice(RECORD_PREFIX.length);
  if (record === undefined) {
    return {
      ok: false,
      message: `"${value}" を解決できません。このワークフローの発火にはきっかけとなるレコードがありません。`,
    };
  }
  if (fieldId === "_id") {
    return { ok: true, value: record._id };
  }
  if (fieldId.startsWith("_")) {
    return {
      ok: false,
      message: `"${value}" は参照できません。カーネルが管理する列のうち参照できるのは "$record._id" だけです。`,
    };
  }
  if (!Object.hasOwn(record, fieldId)) {
    return {
      ok: false,
      message: `"${value}" を解決できません。フィールド "${fieldId}" はきっかけとなったレコードにありません。`,
    };
  }
  return { ok: true, value: record[fieldId] ?? null };
}

/**
 * 実行履歴を1行書く。**発火1回につき1行である。**
 *
 * **この書き込みがワークフローを発火させることはない** —— `runWorkflows` の入口の
 * `isHistoryTable`(判断2)が、履歴テーブルへの書き込みを常に素通りさせるからである。
 * **T02 では「`firing` フラグの内側だから」が根拠だったが、T03 で根拠が変わった。**
 * 現在は**深度に関係なく**成立する(止めたことを書く `stopAll` は `depth === 0` から
 * 呼ばれうるので、フラグ由来の根拠では足りない)。
 *
 * **履歴の書き込みに失敗したら、履歴には二度と書きに行かない。**通知(既定は
 * `console.error`)を1回出して、それ以上何もしない。**これが循環を断つ規則である** ——
 * 「失敗を履歴に書こうとして失敗したら履歴に書く」を許すと無限後退する。
 * **再帰の深さが構造的に1で止まるのは、この関数が自分自身を呼ぶ経路を1つも持たず、
 * 失敗の行き先が `historyFailureHandler`(履歴テーブルを触らない)だけだからである。**
 */
function writeHistory(
  db: Database,
  manifest: Manifest,
  workflow: Workflow,
  // **出口の型で受ける**(`schedule` を含む3値)。列は増えない。
  triggerType: WorkflowTriggerType,
  failures: string[],
  // EC-G5(ADR-0036): `when` 不成立で実行しなかったアクションの説明。**失敗ではない。**
  skips: string[],
  // **`status` 列に書く値の差し替え**(V4-M4-T01 / ADR-0072)。**渡されないときは今日どおり
  // `failures` の有無だけで `"success"` / `"failure"` を決める** —— 通常の発火経路は
  // 1文字も変わらない。
  //
  // 【`V8-M42` / `F-G15` / `ADR-0333`。**旧の1文を逐語で残す**】
  //     **渡されるのは `stopAll` の再発火抑止の枝だけである**(限定1)。
  // **今日は2箇所から渡る** —— **`stopAll` の再発火抑止(`"suppressed"`。`ADR-0072` 限定1。
  // 1バイトも変えていない)** と、**`runScheduledWorkflow` の対象0件の空撃ち(`"no_target"`。
  // `ADR-0333` 限定2)** である。**引数そのものは1バイトも変えていない** ——
  // **`ADR-0333` は新しい引数も新しい列も1つも作っていない。**
  statusOverride?: string,
  // **失敗だったときに、同じ行をもう一度書くための thunk**(V3-M13-T04。下の説明)。
): (() => void) | undefined {
  const succeeded = failures.length === 0;
  // **`status` は失敗の有無だけで決める** —— **スキップは失敗ではない**(ADR-0036 §1b。
  // 条件が偽だっただけで、ワークフローは正しく動いた)。よって skips があっても status は
  // success のままにする。
  //
  // **ただしスキップを黙って消さない**(憲法6。ADR-0036 §1b の「黙って消えないことが必須」)。
  // 実行1回=1行の粒度は崩さず、スキップした事実(どのアクションが・なぜ)を **`error` 列に
  // loud に残す** —— failures と skips を同じ列に畳む。これにより、条件で何も起きなかった
  // 発火が「成功したように見えて実は何もしていない」黙りにならない。**status の扱いは
  // 「専用列を足すか成功行の error に残すか」を審査が実装に委ねた点であり(計画 §1 T01
  // 完了条件3)、列を増やさず既存 error 列に残す最小変更を採る**(履歴の5列規約を保つ)。
  //
  // **all-or-nothing。**5列すべてを**常に**入力に含める。1列でも履歴テーブルに
  // 無ければ `validateInput` が「フィールドが存在しません」で拒否し、行は1つも書かれない。
  // **書ける列だけ書く(best-effort)を採らない** —— `error` だけ黙って落ちた履歴は
  // 「成功したように見える失敗の記録」であり、憲法6 に正面から反する。
  //
  // **失敗もスキップも無いときの `error` は `null` を明示的に書く**(従来どおり。後方互換)。
  // キーごと落とすと、`error` 列が欠けた履歴テーブルが**成功している間だけ**検出されず、
  // 最初の失敗が起きた瞬間に初めて履歴が消える —— **最も知りたい1行だけが落ちる**壊れ方になる。
  const errorParts = [...failures, ...skips];
  const input: RecordInput = {
    // **時刻源から採る**(V1-M2-T08 単位1。既定は実時刻)。形式は UTC の ISO8601 のまま
    // 変えない —— T02 が書いた既存の履歴行と形式が混ざるのを避ける。**「その TZ での今日」は
    // 読み取り側が `zonedNow` で導く**(ADR-0013 §6c)。
    ran_at: workflowClock.now().toISOString(),
    workflow: workflow.id,
    trigger_type: triggerType,
    // 【V4-M4-T01 / ADR-0072】**変えたのは `status` に書く値だけである**(限定7)。
    // `succeeded` の式そのものは1文字も変えていない —— 下の「書き直しの thunk を返すか」
    // は今日どおり `succeeded` が決めるので、**巻き戻しの挙動が分岐しない**。
    status: statusOverride ?? (succeeded ? "success" : "failure"),
    error: errorParts.length === 0 ? null : errorParts.join("\n"),
  };

  writeHistoryRow(db, manifest, workflow, input);

  // **失敗の記録は、発火元が巻き戻っても消えてはならない**(ADR-0066 限定5 = 必須項目。
  // V3-M13-T04)。**ここで書いた行は発火元と同じ tx の内側にあるので、巻き戻れば一緒に
  // 消える** —— そこで「同じ行をもう一度書く」thunk を返し、**巻き戻した側(器を持つ
  // `records.ts`)が巻き戻しの後に呼ぶ。**
  //
  // **入力(`input`)をそのまま閉じ込める**ので、書き直しても `ran_at` は元の実行の時刻の
  // ままである(書き直した時刻ではない)。**時刻源を2度読まない。**
  //
  // **返すのは失敗のときだけである。** 成功した実行の履歴を書き直すと、巻き戻って
  // 成果物が1つも無いのに「成功した」と書かれた行だけが残る(憲法6 に反する向きの嘘)。
  //
  // **ここは巻き戻しの器を1つも持たない**(ADR-0066 限定1: 器は `records.ts` にだけ置く)。
  return succeeded ? undefined : () => writeHistoryRow(db, manifest, workflow, input);
}

/**
 * 組み立て済みの履歴行を1行書き、失敗したら通知を1回出す(循環を断つ規則は `writeHistory`）。
 *
 * `writeHistory` と、その返す「書き直し」の thunk が**同じ経路**を通るように切り出してある ——
 * 書き直しだけが別の作法で書かれると、片方だけが all-or-nothing を守る状態になりうる。
 */
function writeHistoryRow(
  db: Database,
  manifest: Manifest,
  workflow: Workflow,
  input: RecordInput,
): void {
  let result: ReturnType<typeof createRecord>;
  try {
    result = createRecord(db, manifest, workflow.history_table, input);
  } catch (error) {
    historyFailureHandler({
      workflow: workflow.id,
      history_table: workflow.history_table,
      errors: [
        {
          path: "",
          message: error instanceof Error ? error.message : String(error),
          hint: `テーブル "${workflow.history_table}" が実在し、${WORKFLOW_HISTORY_COLUMNS.join(" / ")} の5列を持つことを確認してください。`,
        },
      ],
    });
    return;
  }
  if (!result.ok) {
    historyFailureHandler({
      workflow: workflow.id,
      history_table: workflow.history_table,
      errors: result.errors,
    });
  }
}

/** `ValidationError` の配列を人間可読な1つの文字列に畳む。 */
function formatErrors(errors: ValidationError[]): string {
  return errors
    .map((error) => (error.path === "" ? error.message : `${error.path} ${error.message}`))
    .join(" / ");
}
