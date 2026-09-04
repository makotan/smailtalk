// 機能内 AI 呼び出しと メータリング(V1-M5。ADR-0021。**Δ8 が発火する** —— 門A 審査済み)。
// `call_external` の兄弟であり、遮断は実行層(runAiTransform / dispatchAiJobs)で行う。
// **capability 発行・上限変更の口は1つも公開しない** —— それは owner の HTTP ルートだけが
// 持ち、MCP / apply_diff には結線しない(ADR-0021 §2b / §8c-3)。ここで公開するのは
// ストア(server の owner ルートが使う)・非同期配送(scheduler が使う)・プロバイダ抽象・
// コスト推定・上限判定であって、いずれも「AI が発行に到達する経路」ではない。
export {
  type AiCapability,
  AiCapabilityStore,
  type AiJob,
  type AiLimit,
  type AiProviderKind,
  type AiRequest,
  type AiUsage,
  type AiUsageTotals,
  type CreateAiCapabilityInput,
  type CreateAiRequestInput,
  type EnqueueAiJobInput,
  type RecordAiUsageInput,
} from "./ai-capability-store.ts";
export { estimateCostUsd, isKnownModel, type ModelPrice } from "./ai-cost.ts";
export { type DispatchAiResult, dispatchAiJobs } from "./ai-dispatcher.ts";
export {
  AI_MAX_CHAIN_DEPTH,
  type AiLimitVerdict,
  aiUsageDate,
  checkAiLimit,
  currentAiChainDepth,
  resolveAiTimeZone,
  withAiChainDepth,
} from "./ai-limits.ts";
export {
  type AiProvider,
  type AiProviderResult,
  defaultAiProvider,
} from "./ai-provider.ts";
export { buildStructuredPrompt, parseAiValue } from "./ai-structured.ts";
export { toValidationErrors } from "./ajv-error-adapter.ts";
export { APP_ID_FALLBACK, generateAppId, slugifyAppName } from "./app-id.ts";
export {
  type ApplyDiffResult,
  applyDiff,
  DESTRUCTIVE_NO_CASCADE_NOTE,
  type FoldOperationsResult,
  foldOperations,
} from "./apply-diff.ts";
export {
  type ApplyManifestResult,
  applyManifest,
  readCurrentManifest,
} from "./apply-manifest.ts";
// バッチ書込 API(EC-G7 / V2-M4-T01・ADR-0039。**Δ8 が発火する** —— 門A 審査済み)。
// 明示リストの原子書込を1 IMMEDIATE tx で全成功か全失敗で書く1関門。MCP write_records /
// HTTP POST batch の両経路がこれを通る(ADR-0003 §7)。op は create/update の2種のみ・
// `action_value`(限定12)を1バイトも触らない・IMMEDIATE はこの経路のみ(ADR-0039 §3)。
export {
  type BatchCreateOp,
  type BatchOp,
  type BatchUpdateOp,
  type BatchWrittenOp,
  type WriteRecordsOptions,
  type WriteRecordsResult,
  writeRecords,
} from "./batch.ts";
// 画像 blob ストア(V2-M2-T02 / ADR-0035 §1・限定8。**Δ8 が発火する** —— 門A 審査済み)。
// content-addressed の put / get / exists の3点だけを公開する(orphan-blob 検出は T04)。
export { blobExists, getBlob, putBlob } from "./blob-store.ts";
export { getChangelog } from "./changelog.ts";
export {
  type Clock,
  DEFAULT_TIME_ZONE,
  resolveTimeZone,
  systemClock,
  type TimeZoneResolution,
  type ZonedNow,
  zonedNow,
} from "./clock.ts";
export {
  type ConversionVerdict,
  type ConvertValueResult,
  checkFieldConversions,
  conversionLayer,
  conversionVerdict,
  convertValue,
  type FieldConversion,
  UNCONVERTIBLE_SAMPLE_LIMIT,
} from "./convert.ts";
export {
  type CreateAppOptions,
  type CreateAppResult,
  createApp,
  emptyManifest,
} from "./create-app.ts";
export {
  addColumnSql,
  applyManifestDdl,
  columnDefinition,
  createTableSql,
  dropColumnSql,
  dropTableSql,
  quoteIdentifier,
  renameColumnSql,
  renameTableSql,
  SYSTEM_COLUMN_NAMES,
  SYSTEM_COLUMNS,
  sqliteTypeForFieldType,
} from "./ddl.ts";
// アプリの完全削除(V1-M9-T09。ADR-0031。**Δ8 が発火する** —— 門A 審査済み)。
// **公開するのは削除の口 `deleteApp` と、削除対象集合の単一ソース `APP_SCOPED_KERNEL_TABLES`、
// その入出力の型だけ**である。スナップショットの削除は自前で書かず T04 の `deleteAppSnapshots`
// を呼ぶ(削除経路を1本に集約する)。論理削除 / 世代刈り取り / 単一スナップショット削除は足さない。
export {
  APP_SCOPED_KERNEL_TABLES,
  type DeleteAppOptions,
  type DeleteAppResult,
  deleteApp,
} from "./delete-app.ts";
export {
  DRY_RUN_NOTE,
  type DryRunDiffResult,
  type DryRunReport,
  type DryRunTableImpact,
  dryRunDiff,
} from "./dry-run.ts";
export {
  CONCURRENT_WRITE_WAIT_PRAGMA,
  concurrentWriteBusyErrors,
  formatValidationErrors,
  invalid,
  type ValidationError,
  type ValidationResult,
  valid,
} from "./errors.ts";
// コードの島の実行機構(V1-M6。ADR-0023 / ADR-0024。**Δ8 は T03/T04 で審査済み**)。
// **ここで値として公開するのは `ensureIslandRuntimeReady` だけ**である —— `run_function`
// の発火経路は同期(`workflow-runner.ts`)で、島も同期に呼ぶ必要があり(`runIslandSync`)、
// `getQuickJSSync()` は事前に `getQuickJS()` を解決していないと throw する。したがって
// ワークフローが発火しうる async 境界(MCP / サーバの起動)で島ランタイムを1度ロードして
// おく。`runIslandSync` / `runIsland` はカーネル内部(`workflow-runner.ts`)からのみ呼ぶ。
export { ensureIslandRuntimeReady } from "./island-runner.ts";
export {
  APP_STATUSES,
  type AppendChangelogInput,
  type AppRecord,
  type AppStatus,
  CHANGELOG_KINDS,
  type ChangelogEntry,
  type ChangelogKind,
  KernelMetaStore,
  type RegisterAppInput,
} from "./meta-store.ts";
export {
  type AddFieldStep,
  applyAddField,
  applyAddTable,
  applyMigrationPlan,
  type MigrationPlan,
  type MigrationPlanResult,
  type MigrationStep,
  migrateSchema,
  planMigration,
} from "./migrate.ts";
export {
  type ReadSource,
  readRecord,
  readRecordCount,
  readRecordCountAndSum,
  readRecordList,
} from "./read-records.ts";
export {
  type RebuildColumn,
  rebuildTable,
  supportsDropColumn,
  supportsRenameColumn,
} from "./rebuild-table.ts";
export {
  countAndSumRecords,
  countRecords,
  createRecord,
  deleteRecord,
  getRecord,
  type ListRecordsOptions,
  listRecords,
  type RecordInput,
  type RecordResult,
  type RecordRow,
  type RecordValue,
  readOnlyTableError,
  unknownTableError,
  updateRecord,
} from "./records.ts";
export {
  type ApplyStatus,
  beginApply,
  endApply,
  isApplyInProgress,
  type RecoveryOutcome,
  type RecoveryStatus,
  recover,
} from "./recovery.ts";
export { validateReferentialIntegrity } from "./referential-integrity.ts";
// 集計表の計算(`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`。**`Δ8` が発火する** ——
// **`scripts/kernel-export-snapshot.txt` は赤いまま残してある**。審査より先に一覧を直さない
// = `ADR-0250` / `ADR-0301` 限定11)。
//
// **公開しているのは関数1本だけである。** 応答の型(`ReportResult` ほか)を1つも
// export していない —— **消費側(`src/server/app.ts`)は返り値をそのまま JSON にするので、
// 型に名前が要らない。** **公開面を1本でも小さく保つ**(`ADR-0025` 限定11 が
// `requirements-doc.ts` に課した規律と同じ向き。**ただしあの枠 = 14件 は
// `requirements-doc.ts` 13件 + `undo.ts` 1件 のことであり、本ファイルはその枠の外である**)。
export { computeReport } from "./report.ts";
// 要件ドキュメント生成(V1-M8。ADR-0025。**Δ8 が発火する** —— 門A 本審査済み)。
// **公開するのは生成の口3本と、その入出力の型だけ**である(ADR-0025 限定11)。
// 帰属先がカーネル層なのは、changelog の畳み込み(取り消しの解釈)と manifest の解釈の
// 結合であり、表示層・ユーザランドでは正しく計算できないためである(Δ10 非発火)。
// MCP / HTTP / Web / CLI の4入口はこれを呼んで整形するだけで、ロジックを持たない(限定9)。
//
// **`REQUIREMENT_TEMPLATES` は文面の定数表(データ)である。** 賢さをデータに閉じ、
// `renderStatementText` を `{name}` の単純置換に留める形は、ADR-0024 が
// 「賢さを島に閉じ込め、カーネルは退屈な実行器のまま」と論じたのと同型である。
// 公開しているのは、ADR-0025 §3 の不変条件3点と §4-3 の残差検査が**この表に到達できないと
// 検査そのものを書けない**ためであって、生成の口を増やすためではない。
export {
  generateRequirementsDoc,
  type IdentifierGroup,
  REQUIREMENT_TEMPLATES,
  type RequirementIdentifiers,
  type RequirementSection,
  type RequirementStatement,
  type RequirementsDoc,
  type RequirementTemplateId,
  renderRequirementsMarkdown,
  renderStatementText,
  type Slot,
  type StatementSource,
  type VocabularyGroup,
} from "./requirements-doc.ts";
export { resolveTable } from "./resolve-table.ts";
export { isValidResourceId, RESOURCE_ID_MAX_LENGTH } from "./resource-id.ts";
export {
  listSnapshots,
  restoreSnapshot,
  type SnapshotRef,
  takeSnapshot,
} from "./snapshot.ts";
// 孤児・死蔵スナップショットの検出 + アプリ単位の削除プリミティブ(V1-M9-T04。ADR-0030。
// **Δ8 が発火する** —— 門A 審査済み)。**検出**(孤児と死蔵 -undo- を別欄で数える)と
// **アプリ単位の全消し**(T09 が呼ぶ唯一の削除経路)だけを公開する。世代刈り取り・単一
// スナップショット削除・retention 定数・定期実行の契機は1つも置かない(いずれも v2)。
// V2-M2-T04(ADR-0035)で **orphan blob 検出**(auditAppBlobs = 現行 + 全 snapshot の `_files`
// から参照されない blob 実体の列挙 / BlobAudit = その返り値の型)と **アプリ単位の blob 全消し**
// (deleteAppBlobs = deleteApp が呼ぶ。単一 blob 削除も自動 retention 刈り取りも置かない)を
// 同型に追加した(門 = ADR-0035。§3 限定7/8)。
export {
  auditAllSnapshots,
  auditAppBlobs,
  auditAppSnapshots,
  type BlobAudit,
  deleteAppBlobs,
  deleteAppSnapshots,
  type SnapshotAudit,
} from "./snapshot-orphans.ts";
export {
  appBlobsDir,
  appDbPath,
  appDir,
  appManifestPath,
  appSnapshotsDir,
  appsDir,
  kernelDbPath,
  snapshotDir,
} from "./storage-paths.ts";
export {
  type AddFieldOperation,
  // ADR-0013(ADR-0007 門A 本審査。V1-M2-T01)が足したワークフロー3 op の Operation 型
  // (AddWorkflowOperation / UpdateWorkflowOperation / RemoveWorkflowOperation)。
  // **下の RemoveViewOperation に書いた規範がそのまま当てはまる** ——
  // 他の Operation 型がすべてここに出ている以上、これだけ出ていないのは不整合。
  type AddFunctionOperation,
  type AddTableOperation,
  type AddViewOperation,
  type AddWorkflowOperation,
  type App,
  type ChangeFieldOperation,
  type ChangeTableOperation,
  type DetailView,
  DIFF_OPS,
  type Diff,
  type DiffOp,
  FIELD_TYPES,
  type Field,
  type FieldChanges,
  type FieldType,
  type FilterCondition,
  type FilterLeaf,
  type FilterNode,
  type FormView,
  // ADR-0024(V1-M6。ADR-0007 門A)が足したリソース種7種目 function の型一式。
  // **判別共用体の枝(FunctionInput)も含めてすべて出す** —— Workflow / WorkflowTrigger が
  // 枝ごと出ているのと同じ扱いであり、枝だけ隠すと「型で受けたものを絞り込めない」不整合が生まれる。
  type FunctionDef,
  type FunctionInput,
  type ListView,
  type Manifest,
  type Operation,
  RESOURCE_KINDS,
  type RemoveFieldOperation,
  type RemoveFunctionOperation,
  type RemoveTableOperation,
  // ADR-0012(ADR-0007 門A 限定採用)で足した9つ目の op の Operation 型。
  // 他の Operation 型がすべてここに出ている以上、これだけ出ていないのは不整合。
  type RemoveViewOperation,
  type RemoveWorkflowOperation,
  // **【`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】画面種別の4種目 `report_view` の型。**
  // **`View` 判別共用体の枝はすべて出す** —— **すぐ下の `Workflow` の doc が書いている
  // 「枝だけ隠すと『型で受けたものを絞り込めない』不整合が生まれる」がそのまま当たる**
  // (`ListView` / `FormView` / `DetailView` は今日も3本とも出ている)。
  // **中身の3型(`ReportDeclaration` / `ReportGroupBy` / `ReportAggregate`)は
  // ここから出していない** —— **`ReportView["report"]` で辿れるので、公開面を
  // 増やす理由が無い**(`ScheduleAt` は `WorkflowTriggerSchedule` から辿れるのに
  // 出ているが、あれは `ADR-0013` §6b が cron 式を却下して採った形そのものを
  // 名指しで見せるための例外である)。
  type ReportView,
  type ResourceId,
  type ResourceKind,
  // ADR-0013 §6b が cron 式を却下して採った構造化オブジェクト(schedule トリガーの時刻)。
  type ScheduleAt,
  // ADR-0047(V3-M1-T03。ADR-0007 門A 本審査 = 限定採用)が足した16種目の op の
  // Operation 型と、その運ぶテーマの型。**他の Operation 型がすべてここに出ている以上、
  // これだけ出ていないのは不整合**(RemoveViewOperation に書かれた規範と同じ扱い)。
  // **限定10 は新規 export を「`Operation` union の新しい分岐型と `Theme` 型」に
  // 限っている** —— これ以外を export していない(スロットの値・値域・変換規則を
  // カーネルは1つも持たない = ADR-0046 限定3)。
  type SetThemeOperation,
  SORT_ORDERS,
  type Sort,
  type SortOrder,
  type Table,
  type TableChanges,
  type Theme,
  type UpdateFunctionOperation,
  type UpdateViewOperation,
  type UpdateWorkflowOperation,
  VIEW_TYPES,
  type View,
  type ViewChanges,
  type ViewType,
  // ADR-0013 が足したリソース種6種目 workflow の型一式。**判別共用体の枝も含めて
  // すべて出す** —— View / ListView / FormView / DetailView が枝ごと出ているのと同じ扱いで
  // あり、枝だけ隠すと「型で受けたものを絞り込めない」不整合が生まれる。
  type Workflow,
  type WorkflowAction,
  // ADR-0021(V1-M5-T01。ADR-0007 門A)が足した4種目のアクション型。他の枝が
  // すべて出ている以上、これだけ出ていないのは不整合(RemoveViewOperation 等と同じ扱い)。
  type WorkflowActionAiTransform,
  type WorkflowActionCallExternal,
  type WorkflowActionCreateRecord,
  type WorkflowActionUpdateRecord,
  type WorkflowTrigger,
  type WorkflowTriggerOnCreate,
  type WorkflowTriggerOnUpdate,
  type WorkflowTriggerSchedule,
} from "./types.ts";
export {
  type PreviewUndoResult,
  previewRedo,
  previewUndo,
  type RecordCounts,
  type RedoResult,
  // ADR-0032(V1-M9-T05。ADR-0007 門A。Δ8)が足した redo。ADR-0004 §1「redo は v0 では
  // 作らない」の明示的な改訂 —— M1 の破壊的 op 解禁で「同じ差分を再 apply すれば足りる」が
  // 失効したため。戻り先は直前の undo のスナップショット(データは物理的に残っている。§5)。
  redo,
  UNDO_PREVIEW_NOTE,
  type UndoPreview,
  type UndoResult,
  undo,
  // ADR-0025 §8-1 が `selectUndoTarget` から切り出した**構文的事実**の抽出。
  // 「生きている apply」という解釈はここに無く、消費者(要件ドキュメント生成)側に置く ——
  // 解釈を `undo.ts`(ADR-0004 §3 の直訳モジュール)に持ち込むと、undo の対象選択と
  // 帰属という2用途で解釈が暗黙に共有され、片方の都合で変わる。
  undoneTargetSeqs,
} from "./undo.ts";
export {
  DIFF_SCHEMA_PATH,
  diffSchema,
  type JsonSchema,
  MANIFEST_SCHEMA_PATH,
  manifestSchema,
  validateDiff,
  validateManifest,
  validateManifestFull,
} from "./validate.ts";
// ワークフロー実行エンジン(V1-M2-T02。**Δ8 が発火する** —— 7件増えた。
// **V1-M2-T03 で `WORKFLOW_MAX_DEPTH` が1件加わり、8件になった。**)。
// `runWorkflows` は `records.ts` の CRUD が内部から呼ぶが、`schedule` トリガー
// (V1-M2-T08)は CRUD の外から同じ関数を呼ぶので、公開しておく。
// 履歴書き込み失敗の通知先(既定は `console.error`)を差し替える口も公開する ——
// **`console.error` はユーザに届かない**ことが T02 の限界であり(§2-2 判断1)、
// 上位層が受け取り直せる余地をここで残しておく。
//
// **`WORKFLOW_MAX_DEPTH` は読み取り専用の定数であって、差し替える口ではない**
// (T03 判断4)。上位層が「何段まで連鎖するのか」を説明文に載せられるように
// 公開しているだけで、実行時に動かす手段は意図的に置いていない。
// **深度カウンタと再発火抑止の集合は1件も公開していない** —— モジュールスコープに
// 閉じており、外から観測も操作もできない。
//
// **`setWorkflowClock` / `resetWorkflowClock` は時刻源の注入口である**(V1-M2-T08 単位1)。
// `setWorkflowHistoryFailureHandler` と同じ作法で、**観測/注入のための口であって
// 挙動を変える口ではない** —— 注入しない本番経路の既定は実時刻(`systemClock`)である。
//
// **V1-M2-T08 単位2 で3件加わった**(`getWorkflowClock` / `runScheduledWorkflow` /
// `WorkflowTriggerType`)。いずれも `workflow-scheduler.ts` が使う ——
// **`schedule` の発火は `runWorkflows` ではなく専用の入口を通る**(`trigger.table` を
// 持たないトリガーを、テーブルIDで合致を決める関数に通せないため)。
// **`getWorkflowClock` は時刻源を*読む*口である** —— スケジューラの判定と履歴の
// `ran_at` が別々の時刻源を見ると、ADR-0013 §6c の発火済み判定が壊れる。
export {
  // **【`V5-M25-T03` / `V5-M25-T01`】手動起動の2本**(`ADR-0175` / `ADR-0174`)。
  // **`beginManualRun` は在席台帳、`runManualWorkflow` は実行そのものである。**
  // **入口(`src/server/app.ts`)が両方を値として使う** —— **在席を取るのは入口であり、
  // `runManualWorkflow` は台帳を1度も触らない**(理由は `workflow-runner.ts` の doc)。
  beginManualRun,
  getWorkflowClock,
  resetWorkflowClock,
  resetWorkflowHistoryFailureHandler,
  runManualWorkflow,
  runScheduledWorkflow,
  runWorkflows,
  setWorkflowClock,
  setWorkflowHistoryFailureHandler,
  WORKFLOW_HISTORY_COLUMNS,
  WORKFLOW_MAX_DEPTH,
  type WorkflowEventTriggerType,
  type WorkflowHistoryFailureHandler,
  type WorkflowHistoryWriteFailure,
  type WorkflowTriggerType,
} from "./workflow-runner.ts";
// `schedule` トリガーの実行基盤(V1-M2-T08 単位2。**Δ8 が発火する** —— 4件増えた)。
// **`src/server/index.ts` が値として import するのは `startWorkflowScheduler` だけ**で
// あり、`runSchedulerTick` は**テストがタイマーを待たずに1周期を回すための口**である
// (実時間を待つテストを1本も書かない、という計画の絶対条件を満たす唯一の形)。
// **`SCHEDULER_TICK_INTERVAL_MS` は読み取り専用の定数であって、差し替える口ではない**
// (`WORKFLOW_MAX_DEPTH` と同じ規律)。**発火済みの記憶はこのモジュールに1バイトも無い**
// —— ADR-0013 限定7 のとおり、判定は実行履歴テーブルから毎回導いている。
export {
  runSchedulerTick,
  SCHEDULER_TICK_INTERVAL_MS,
  startWorkflowScheduler,
  type WorkflowSchedulerHandle,
  type WorkflowSchedulerOptions,
} from "./workflow-scheduler.ts";
