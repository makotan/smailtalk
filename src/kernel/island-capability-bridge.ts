/**
 * 島(QuickJS 関数)→ capability ブリッジ(V1-M6-T04 / ADR-0024・ADR-0020 §8c-5・ADR-0021 §8c-5)。
 *
 * **このタスクの核は「ゲーティング」である** —— 島(`island-runner.ts` の `runIsland`)からの
 * 外部アクセス(HTTP=connection / AI=ai_capability)を、**宣言 + 付与された capability を持つ場合
 * のみ許可する**ブリッジを組み立てる。完了条件は「capability 宣言のない関数からの外部アクセスが
 * 実行層で遮断される」こと。
 *
 * ## なぜ「足し算」で遮断になるのか(構造的遮断)
 *
 * 島の外部到達手段は `runIsland({ hostFunctions })` にホストが注入した関数**だけ**である
 * (`island-runner.ts` のアンビエント権限ゼロ。`fetch` / `require` / `process` は既定で1つも無い)。
 * `buildCapabilityBridges` は**宣言 + 付与された capability の分だけホスト関数を作る**。宣言外の
 * capability にはホスト関数が存在しない = 島から到達する扉が無い。これが「宣言なし → 遮断」の実装で
 * あって、どこかに `if (!declared) reject` を書くのではなく、**扉そのものを生やさない**ことで遮断する。
 *
 * ## 既存機構の再利用(再発明しない)
 *
 * ブリッジの中で行う照合・スコープ/上限チェック・投函は、M4(`workflow-runner.ts` の
 * `runCallExternal`)/ M5(同 `runAiTransform`)と**同一の関数**を通す:
 * - 起点: `parseAppDbPath(db.filename)` で `dataRoot` / `appId` を復元(:memory: 等は throw → 全遮断)。
 * - connection: `CapabilityStore` → `findConnectionByName`(undefined→拒否)→
 *   `hostAllowed`(既定 deny・URL 失敗も deny)→ `enqueueOutbox`。
 * - ai_capability: `AiCapabilityStore` → `findCapabilityByName`(undefined→拒否)→ chain-depth →
 *   `checkAiLimit`(超過なら `recordUsage(blocked)` して拒否)→ `enqueueJob`。
 *
 * ## 拒否は throw しない(M4/M5 と同じ規律)
 *
 * ブリッジのホスト関数は島に**構造化結果**(`{ ok:false, reason }`)を返し、投函は1件もしない。
 * 予期せぬ例外も `{ ok:false }` に畳んでホスト(QuickJS 呼び出し)を殺さない。島側の失敗は
 * `runIsland` が `{ status:"failure"|"success" }` で構造化して返す。
 *
 * ## AI の既知の非対称(正直に扱う。ADR-0021 §3c との差)
 *
 * `enqueueJob` は書き戻し先(`targetTable` / `targetRecordId` / `outputField`)前提で、M5 は AI 結果を
 * **発火レコードのフィールドに書き戻す**。島が結果を**同期に受け取る**形とは非同期でミスマッチする。
 * **T04 の核はゲーティングであり**、AI 結果を島へ同期返却する完全な往復は T04 のスコープ外(T05/将来)。
 * ここでは照合 + chain-depth + 上限チェック + 拒否時 `recordUsage(blocked)` を確実に行い、通過時は
 * `enqueueJob` で投函する。**書き戻し先は島の呼び出しコンテキスト(引数)が与える** —— 島がそれを
 * 与えなければ空文字のまま積まれる(= 現状は配送側で書き戻し先が定まらない。この限界を明記しておく)。
 */

import type { Database } from "bun:sqlite";
import { AiCapabilityStore } from "./ai-capability-store.ts";
import { AI_MAX_CHAIN_DEPTH, aiUsageDate, checkAiLimit, currentAiChainDepth } from "./ai-limits.ts";
import { CapabilityStore } from "./capability-store.ts";
import { hostAllowed } from "./host-scope.ts";
import { parseAppDbPath } from "./storage-paths.ts";
import { getWorkflowClock } from "./workflow-runner.ts";

/** ブリッジ関数が島に返す構造化結果。**throw ではなくこれで拒否を伝える。** */
export type BridgeResult =
  | { ok: true; kind: "connection" | "ai_capability"; id: string }
  | { ok: false; reason: string };

/**
 * 島へ注入する1つのブリッジ関数。`runIsland` の `hostFunctions` の値そのもの
 * (`(arg: unknown) => unknown`)に一致する。引数は島から渡された1つのオブジェクト。
 */
export type CapabilityBridge = (arg: unknown) => BridgeResult;

/** connection ブリッジが受け取る引数(島が渡すオブジェクト)。 */
export interface ConnectionBridgeArg {
  /** 送信先 URL。`allowedHosts` と照合される(スコープ外は拒否)。 */
  destination: string;
  /** 送信ペイロード(解決済み。secret を含まない)。 */
  payload?: Record<string, unknown>;
}

/**
 * ai_capability ブリッジが受け取る引数(島が渡すオブジェクト)。
 * `outputField` / `targetTable` / `targetRecordId` は書き戻し先で、島の呼び出しコンテキストが
 * 与える(T04 の非対称。上のモジュールコメント参照)。無ければ空文字で積まれる。
 */
export interface AiBridgeArg {
  prompt: string;
  input?: Record<string, unknown>;
  outputField?: string;
  targetTable?: string;
  targetRecordId?: string;
  fallback?: string;
}

/** `buildCapabilityBridges` の入力。 */
export interface BuildCapabilityBridgesParams {
  /** 開いた app.sqlite。`parseAppDbPath(db.filename)` で `dataRoot` / `appId` を得る。 */
  db: Database;
  /** 島の `function.capabilities`(connection 名 or ai_capability 名)。宣言外は扉を生やさない。 */
  declaredCapabilities: string[];
  /** メータリング/所有者(`record.st_owner` 相当)。 */
  actor: string;
  /** メータリング帰属(呼び出し元 workflow)。無ければ島起点の既定に落ちる。 */
  workflowId?: string;
}

/** ワークフロー起点でない島呼び出しのメータリング帰属(`ai_usage` / `ai_jobs` の workflow_id)。 */
const ISLAND_WORKFLOW_ID = "island";

/**
 * 宣言 + 付与された capability の分だけ島へのブリッジ関数を組み立てる。
 *
 * 返り値は `runIsland` の `hostFunctions` にそのまま渡せる `Record<string, CapabilityBridge>`。
 * 宣言された各 capability について、それが connection なら外部送信ブリッジ、ai_capability なら AI
 * 呼び出しブリッジを1つずつ生やす。**宣言外は生やさない**(= 島から到達する扉が無い = 構造的遮断)。
 *
 * capability が「connection なのか ai_capability なのか」は**この組み立て時に1度だけ**ストアを引いて
 * 判定する(名前空間は別々なので一方にしか存在しない)。どちらのストアにも無い(= 未発行)場合でも
 * 宣言されている以上は扉を生やすが、その扉は call-time の照合で必ず拒否する(fail-closed)。
 *
 * `db.filename` が :memory: 等でアプリを特定できない場合は、全 capability を「常に拒否」する扉にする
 * (M4/M5 と同じ fail-closed。送信も AI 呼び出しも1件も行わない)。
 */
export function buildCapabilityBridges(
  params: BuildCapabilityBridgesParams,
): Record<string, CapabilityBridge> {
  const { db, declaredCapabilities, actor, workflowId } = params;
  const bridges: Record<string, CapabilityBridge> = {};

  // 起点: app.sqlite のパスから dataRoot / appId を復元する。:memory: / 想定外パスは
  // parseAppDbPath が throw する → アプリを特定できない = 全 capability を fail-closed にする。
  let located: { dataRoot: string; appId: string } | null;
  try {
    located = parseAppDbPath(db.filename);
  } catch {
    located = null;
  }

  for (const name of new Set(declaredCapabilities)) {
    if (located === null) {
      bridges[name] = () => ({
        ok: false,
        reason: `外部アクセスの所属アプリを特定できませんでした(このアクセスは行いません)。`,
      });
      continue;
    }
    const kind = detectKind(located.dataRoot, located.appId, name);
    if (kind === "ai_capability") {
      bridges[name] = makeAiBridge(located, name, actor, workflowId ?? ISLAND_WORKFLOW_ID);
    } else {
      // "connection"(発行済み)と "unknown"(未発行)の両方をここに集約する。
      // 未発行でも扉は生やすが、call-time の findConnectionByName が undefined を返して拒否する。
      bridges[name] = makeConnectionBridge(located, name);
    }
  }
  return bridges;
}

/**
 * 宣言された名前が connection なのか ai_capability なのかを判定する(組み立て時に1度だけ)。
 * 名前空間は別々なので、通常はどちらか一方にしか存在しない。connection を先に見る。
 * どちらにも無ければ "unknown"(未発行)。**ストアは開いたら必ず閉じる。**
 */
function detectKind(
  dataRoot: string,
  appId: string,
  name: string,
): "connection" | "ai_capability" | "unknown" {
  const capStore = CapabilityStore.openForKernel(dataRoot);
  try {
    if (capStore.findConnectionByName(appId, name) !== undefined) {
      return "connection";
    }
  } finally {
    capStore.close();
  }
  const aiStore = AiCapabilityStore.openForKernel(dataRoot);
  try {
    if (aiStore.findCapabilityByName(appId, name) !== undefined) {
      return "ai_capability";
    }
  } finally {
    aiStore.close();
  }
  return "unknown";
}

/**
 * connection ブリッジ。**M4 `runCallExternal` と同一の照合・スコープ・投函**を行う。
 * 呼ぶたびに call-time で接続を引き直す(組み立て後に発行/削除されても正しく効く)。
 */
function makeConnectionBridge(
  located: { dataRoot: string; appId: string },
  name: string,
): CapabilityBridge {
  return (arg) => {
    // 予期せぬ例外も {ok:false} に畳んでホストを殺さない(拒否は throw しない)。
    try {
      const { destination, payload } = coerceConnectionArg(arg);
      if (destination === null) {
        return { ok: false, reason: `destination(送信先 URL の文字列)が必要です。` };
      }
      const store = CapabilityStore.openForKernel(located.dataRoot);
      try {
        // 1. 名前で接続を引く。未発行なら遮断(積まない)。
        const conn = store.findConnectionByName(located.appId, name);
        if (conn === undefined) {
          return {
            ok: false,
            reason: `接続 "${name}" は発行されていません(capability が必要です)。`,
          };
        }
        // 2. 宛先スコープの照合(単一ソース host-scope.ts。既定 deny・URL 失敗も deny)。
        if (!hostAllowed(conn.allowedHosts, destination)) {
          return {
            ok: false,
            reason: `宛先 "${destination}" は接続 "${name}" のスコープ外です。`,
          };
        }
        // 3. 許可された。**送信内容を outbox に積むだけ**(secret は触らない。配送側が use-time 解決)。
        const item = store.enqueueOutbox({
          appId: located.appId,
          connectionId: conn.id,
          destination,
          payload,
        });
        return { ok: true, kind: "connection", id: item.id };
      } finally {
        store.close();
      }
    } catch (error) {
      return { ok: false, reason: `外部送信を実行できませんでした: ${message(error)}` };
    }
  };
}

/**
 * ai_capability ブリッジ。**M5 `runAiTransform` と同一の照合・chain-depth・上限・記録・投函**を行う。
 * 上限超過・連鎖超過は黙って止めず `ai_usage` に blocked として記録する(監査証跡)。
 */
function makeAiBridge(
  located: { dataRoot: string; appId: string },
  name: string,
  actor: string,
  workflowId: string,
): CapabilityBridge {
  return (arg) => {
    try {
      const parsed = coerceAiArg(arg);
      if (parsed.prompt === null) {
        return { ok: false, reason: `prompt(指示文の文字列)が必要です。` };
      }
      const store = AiCapabilityStore.openForKernel(located.dataRoot);
      try {
        // 1. capability を名前で引く。無ければ遮断(積まない。attributing 先が無いので記録もしない)。
        const capability = store.findCapabilityByName(located.appId, name);
        if (capability === undefined) {
          return {
            ok: false,
            reason: `AI capability "${name}" は発行されていません(capability が必要です)。`,
          };
        }

        const clock = getWorkflowClock();
        const usageDate = aiUsageDate(clock);
        const recordBlocked = (reason: string): BridgeResult => {
          store.recordUsage({
            appId: located.appId,
            capabilityId: capability.id,
            workflowId,
            actor,
            model: capability.model,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            status: "blocked",
            usageDate,
            calledAt: clock.now().toISOString(),
          });
          return { ok: false, reason };
        };

        // 2. 連鎖深度(配送を跨ぐ連鎖を早期に止める。§5)。超過なら blocked 記録して拒否。
        const chainDepth = currentAiChainDepth();
        if (chainDepth >= AI_MAX_CHAIN_DEPTH) {
          return recordBlocked(
            `AI 呼び出しの連鎖が深度上限(${AI_MAX_CHAIN_DEPTH})に達したため、この呼び出しは行いません。`,
          );
        }

        // 3. 当日の上限判定(単一ソース ai-limits.ts。§5)。超過なら blocked 記録して拒否。
        const totals = store.usageTotalsForDate(capability.id, usageDate);
        const verdict = checkAiLimit(totals, capability.limit);
        if (verdict.exceeded) {
          return recordBlocked(`AI 呼び出しの上限に達しました: ${verdict.reason}`);
        }

        // 4. 許可された。ジョブを積むだけ(推論・書き戻しは非同期の dispatchAiJobs が担う)。
        //    書き戻し先(outputField/targetTable/targetRecordId)は島の引数が与える(T04 の非対称)。
        const job = store.enqueueJob({
          appId: located.appId,
          capabilityId: capability.id,
          workflowId,
          actor,
          prompt: parsed.prompt,
          input: parsed.input,
          outputField: parsed.outputField,
          fallback: parsed.fallback,
          targetTable: parsed.targetTable,
          targetRecordId: parsed.targetRecordId,
          chainDepth,
        });
        return { ok: true, kind: "ai_capability", id: job.id };
      } finally {
        store.close();
      }
    } catch (error) {
      return { ok: false, reason: `AI 呼び出しを実行できませんでした: ${message(error)}` };
    }
  };
}

/**
 * 島から渡された引数を connection ブリッジの入力へ正規化する。
 * `destination` が文字列でなければ `null`(= 拒否)。`payload` はプレーンなオブジェクトのみ採り、
 * それ以外(配列・非オブジェクト・欠落)は空オブジェクトに落とす(送信内容を型で締める)。
 */
function coerceConnectionArg(arg: unknown): {
  destination: string | null;
  payload: Record<string, unknown>;
} {
  if (!isPlainObject(arg)) {
    return { destination: null, payload: {} };
  }
  const destination = typeof arg.destination === "string" ? arg.destination : null;
  const payload = isPlainObject(arg.payload) ? arg.payload : {};
  return { destination, payload };
}

/**
 * 島から渡された引数を ai_capability ブリッジの入力へ正規化する。
 * `prompt` が文字列でなければ `null`(= 拒否)。書き戻し先の各文字列は欠落なら空文字。
 */
function coerceAiArg(arg: unknown): {
  prompt: string | null;
  input: Record<string, unknown>;
  outputField: string;
  targetTable: string;
  targetRecordId: string;
  fallback: string;
} {
  if (!isPlainObject(arg)) {
    return {
      prompt: null,
      input: {},
      outputField: "",
      targetTable: "",
      targetRecordId: "",
      fallback: "",
    };
  }
  return {
    prompt: typeof arg.prompt === "string" ? arg.prompt : null,
    input: isPlainObject(arg.input) ? arg.input : {},
    outputField: typeof arg.outputField === "string" ? arg.outputField : "",
    targetTable: typeof arg.targetTable === "string" ? arg.targetTable : "",
    targetRecordId: typeof arg.targetRecordId === "string" ? arg.targetRecordId : "",
    fallback: typeof arg.fallback === "string" ? arg.fallback : "",
  };
}

/** プレーンなオブジェクト(配列・null を除く)か。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
