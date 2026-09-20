/**
 * AI ジョブの非同期配送(V1-M5-T02〜T04 / ADR-0021 §3c)。
 *
 * `runAction` の `ai_transform` 分岐(実行層の遮断点)は capability チェック・上限判定・
 * 連鎖深度判定を同期で行い、許可されたジョブを ai_jobs に**積むだけ**である
 * (`src/kernel/workflow-runner.ts`)。実際の推論・構造化出力の検証・レコードへの書き戻しは、
 * この非同期ディスパッチャが**別実行**で行う —— 書き込み経路(`records.ts` 以下)を
 * async 化しないための分離である(`call_external` の `dispatchOutbox` と同型。§3 改訂2 の理由)。
 *
 * **記録なしに AI を呼べる経路を作らない**(ADR-0021 §8c-7)—— provider を呼ぶ経路は必ず
 * `ai_usage` に1行書く。上限 / 連鎖で止めた blocked も記録する(§4 / §5)。
 *
 * **secret の扱い(ADR-0020 §2d を継承)**:
 * - secret は ai_jobs に載っていない。capability の参照だけがある。
 * - `openai_compatible` の API キーは配送時に初めて `resolveSecret` で use-time 解決する。
 * - `claude_cli` は secret を持たない(CLI 自身の認証)。
 * - 解決値は provider のスコープを出さない。error / ログ / usage のどの列にも secret を入れない。
 *
 * **`call_external` との唯一の違いは結果をレコードへ書き戻すこと**である(§3c)。書き戻しは
 * `updateRecord`(同一アプリのテーブルへの通常の書き込み)で行い、それ自体が `on_update`
 * ワークフローを発火させうる —— それが連鎖増幅の源であり、`withAiChainDepth` で書き戻しの間の
 * 配送深度を1つ上げることで、そこで積まれる次のジョブに深度を継がせる(§5)。
 *
 * **配送は逐次(1ジョブずつ・`Promise.all` を使わない)。**`withAiChainDepth` が
 * モジュールスコープのカウンタに依存するため、並行にすると深度が混ざる(ai-limits.ts の警告)。
 */
import { Database } from "bun:sqlite";
// **`V17-M3-T03c` / `AC-G13` の「持ち主」の側。** **層をまたぐのは `src/kernel/`
// では初めてではない** —— **`src/kernel/workflow-runner.ts` が同じファイルから
// 同じ述語を既に import している**(`ADR-0009` 限定2 の前例。判定の家を2つに割らない
// ためであり、ここに個人所有の規約を1行も再実装しないための選択である)。
// **`scripts/kernel-import-drift.test.ts` は `src/kernel/` を走査対象から外して
// いるので、この向きの層またぎはその検査には現れない**(実測で緑を確かめた)。
import { judgeOwnerScopedOp } from "../server/owner-scope.ts";
import { AiCapabilityStore } from "./ai-capability-store.ts";
import { estimateCostUsd, isKnownModel } from "./ai-cost.ts";
import { AI_MAX_CHAIN_DEPTH, aiUsageDate, checkAiLimit, withAiChainDepth } from "./ai-limits.ts";
import { type AiProvider, defaultAiProvider } from "./ai-provider.ts";
import { buildStructuredPrompt, parseAiValue } from "./ai-structured.ts";
import { readCurrentManifest } from "./apply-manifest.ts";
import { systemClock } from "./clock.ts";
import { getRecord, updateRecord } from "./records.ts";
import { isApplyInProgress } from "./recovery.ts";
import { resolveTable } from "./resolve-table.ts";
import { resolveSecret } from "./secret-resolver.ts";
import { appDbPath } from "./storage-paths.ts";
import type { Field, Manifest } from "./types.ts";
import { accessJudgmentApplies, judgeAutomationWrite } from "./workflow-runner.ts";

/** 配送結果の集計(スモーク / 監視用)。 */
export interface DispatchAiResult {
  done: number;
  failed: number;
  blocked: number;
  /** 書き込み先アプリが適用中で見送ったジョブ(pending のまま次周期に再試行)。 */
  deferred: number;
}

/**
 * ai_jobs の pending をすべて配送する(V1-M5-T02〜T04)。
 *
 * @param provider テスト用の注入口(実 CLI / 実ネットワークに触れずスパイで検査する)。
 *   省略時は `defaultAiProvider`(capability.provider で claude_cli / openai_compatible を分岐)。
 */
export async function dispatchAiJobs(
  dataRoot: string,
  provider: AiProvider = defaultAiProvider,
): Promise<DispatchAiResult> {
  const store = AiCapabilityStore.openForKernel(dataRoot);
  const result: DispatchAiResult = { done: 0, failed: 0, blocked: 0, deferred: 0 };
  try {
    for (const job of store.listPendingJobs()) {
      const capability = store.getCapability(job.capabilityId);
      if (capability === undefined) {
        // 失効:capability が消えているので呼べない(secret も引けない)。
        store.markJob(job.id, "failed", { error: "AI capability が失効しています" });
        result.failed += 1;
        continue;
      }

      const usageDate = aiUsageDate(systemClock);
      const recordBlocked = (reason: string): void => {
        store.recordUsage({
          appId: job.appId,
          capabilityId: capability.id,
          workflowId: job.workflowId,
          actor: job.actor,
          model: capability.model,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          status: "blocked",
          usageDate,
          calledAt: systemClock.now().toISOString(),
        });
        store.markJob(job.id, "blocked", { error: reason });
        result.blocked += 1;
      };

      // 多層防御(1): 連鎖深度の再判定(§5。enqueue で既に弾いているが配送でも見る)。
      if (job.chainDepth >= AI_MAX_CHAIN_DEPTH) {
        recordBlocked(`AI 呼び出しの連鎖が深度上限(${AI_MAX_CHAIN_DEPTH})に達しました`);
        continue;
      }

      // 多層防御(2): 当日の上限の再判定(§5。enqueue と配送の間に上限へ達しうる)。
      const totals = store.usageTotalsForDate(capability.id, usageDate);
      const verdict = checkAiLimit(totals, capability.limit);
      if (verdict.exceeded) {
        recordBlocked(`AI 呼び出しの上限に達しました: ${verdict.reason}`);
        continue;
      }

      // 書き戻し先アプリが適用中なら、この周期は見送る(pending のまま。scheduler と同型)。
      // **provider を呼ぶ前に見送る** —— 書き戻せないのに推論コストを払わないため。
      if (isApplyInProgress(dataRoot, job.appId).inProgress) {
        result.deferred += 1;
        continue;
      }

      // マニフェストと書き戻し先フィールドを読む(消えていれば呼ばずに failed)。
      let manifest: Manifest;
      try {
        manifest = readCurrentManifest(dataRoot, job.appId);
      } catch (error) {
        store.markJob(job.id, "failed", {
          error: `マニフェストを読めませんでした: ${error instanceof Error ? error.message : String(error)}`,
        });
        result.failed += 1;
        continue;
      }
      const field = findField(manifest, job.targetTable, job.outputField);
      if (field === undefined) {
        store.markJob(job.id, "failed", {
          error: `書き戻し先フィールド "${job.outputField}"(テーブル "${job.targetTable}")が見つかりません`,
        });
        result.failed += 1;
        continue;
      }

      // 推論を呼ぶ。secret は use-time 解決(openai_compatible のみ)。
      const prompt = buildStructuredPrompt(job.prompt, job.input, field);
      let providerResult: { text: string; inputTokens: number; outputTokens: number };
      try {
        providerResult = await provider(capability, prompt, resolveSecret);
      } catch (error) {
        // **呼び出し失敗も必ず記録する**(§8c-7)。トークンは不明なので 0、status=failure。
        // failure は当日の呼び出し回数に数える(失敗の連打で上限を回避させない。§5)。
        store.recordUsage({
          appId: job.appId,
          capabilityId: capability.id,
          workflowId: job.workflowId,
          actor: job.actor,
          model: capability.model,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          status: "failure",
          usageDate,
          calledAt: systemClock.now().toISOString(),
        });
        // 呼び出しが失敗しても、フォールバックを書き戻す(§3b。憲法6: 黙って空にしない)。
        const wrote = writeBack(dataRoot, manifest, job, null);
        store.markJob(job.id, "failed", {
          error: `AI 呼び出しが失敗しました: ${error instanceof Error ? error.message : String(error)}`,
          resultValue: wrote.value ?? undefined,
        });
        result.failed += 1;
        continue;
      }

      // **呼び出しは成功した(トークンを消費した)。コストを推定して必ず記録する。**
      const costUsd = estimateCostUsd(
        capability.model,
        providerResult.inputTokens,
        providerResult.outputTokens,
      );
      store.recordUsage({
        appId: job.appId,
        capabilityId: capability.id,
        workflowId: job.workflowId,
        actor: job.actor,
        model: capability.model,
        inputTokens: providerResult.inputTokens,
        outputTokens: providerResult.outputTokens,
        // 未知モデルはコスト 0(捏造しない。ai-cost.ts)。0 が「単価表に無かった」ことは
        // isKnownModel で判別できるので、その旨をエラー列に残して見えるようにする。
        costUsd,
        status: "success",
        usageDate,
        calledAt: systemClock.now().toISOString(),
      });

      // 構造化出力を検証して書き戻す。不正ならフォールバック(§3b)。
      const parsed = parseAiValue(providerResult.text);
      const wrote = writeBack(dataRoot, manifest, job, parsed);
      if (wrote.ok) {
        const costNote = isKnownModel(capability.model)
          ? undefined
          : `(注: モデル "${capability.model}" は単価表に無く、推定コストは 0 で記録されています)`;
        store.markJob(job.id, wrote.usedFallback ? "failed" : "done", {
          error: wrote.usedFallback
            ? `AI 出力が不正だったためフォールバック値を書き戻しました${costNote ? ` ${costNote}` : ""}`
            : costNote,
          resultValue: wrote.value ?? undefined,
        });
        if (wrote.usedFallback) {
          result.failed += 1;
        } else {
          result.done += 1;
        }
      } else {
        store.markJob(job.id, "failed", {
          error: `AI 出力もフォールバックも書き戻せませんでした: ${wrote.error}`,
        });
        result.failed += 1;
      }
    }
  } finally {
    store.close();
  }
  return result;
}

/** 書き戻しの結果。`usedFallback` は AI 出力が不正でフォールバックを書いたことを表す。 */
interface WriteBackResult {
  ok: boolean;
  usedFallback: boolean;
  value: string | null;
  error?: string;
}

/**
 * AI の出力(`value`。不正なら `null`)を `output_field` へ書き戻す。検証は
 * `updateRecord`(フィールド制約 = 型 / select 選択肢)が行う —— **新しい検証器を発明しない**
 * (ADR-0021 §3b)。`value` が `null` / 検証に通らないときは `fallback` を書く。それも通らなければ
 * `{ ok: false }`(書かずに failed)。
 *
 * **書き戻しの間だけ配送深度を1つ上げる**(`withAiChainDepth`)—— この書き込みが誘発する
 * `on_update` の `ai_transform` は、深度を継いだジョブとして積まれる(§5)。書き戻しは同期。
 */
function writeBack(
  dataRoot: string,
  manifest: Manifest,
  job: {
    appId: string;
    /** **この発火の書き手**(`V17-M3-T03b` / `AC-G13`)。**値は `AiJob` に元から在った。** */
    actor: string | null;
    /** **どのワークフローから積まれたジョブか**(同上。**時刻起動の素通りを保つ唯一の手がかり**)。 */
    workflowId: string;
    targetTable: string;
    targetRecordId: string;
    outputField: string;
    fallback: string;
    chainDepth: number;
  },
  value: string | null,
): WriteBackResult {
  const db = new Database(appDbPath(dataRoot, job.appId), { readwrite: true, create: false });
  try {
    return withAiChainDepth(job.chainDepth + 1, () => {
      // **【`V17-M3-T03b` / `AC-G13`(2)】書き込む前に、この発火の書き手にその行を
      // 書き換える権限があるかを1度だけ問う**(`ADR-0007` の台帳 `AC-G13`)。
      //
      // **置き場所がここである理由** —— **この下には `updateRecord` が2つある**
      // (本命 = AI 出力 / フォールバック)。**片方の直前に置くと、本命が
      // フィールド制約に落ちたときフォールバックが素通りする。**
      // **`withAiChainDepth` の中の先頭に**1本だけ**置き、断られたら
      // `{ ok: false, … }` を返して**どちらにも到達させない**。**
      // **判定は2度呼ばない。**
      //
      // **【訂正。`V17-M3-T03c`(2026-09-07)。上の1行を1バイトも消していない】** ——
      // **「判定は2度呼ばない」は、今日は**面と点の判定についてだけ**真である。**
      // **下に足した個人所有(`st_owner`)の判定は、書こうとしている値ごとに解くので
      // 最大2度呼ぶ。** **理由はその場に書いた。**
      //
      // **判定の式を1行も写していない** —— **呼ぶのは `workflow-runner.ts` の既存の
      // 述語2本だけであり、ここにあるのは「答えを、この経路が今日持っている
      // 断りの形(`WriteBackResult.error` の文字列)へ翻訳する」ことだけである。**
      //
      // **【この関門は2つの判定の**両方**を包む。実測で分かった】** ——
      // **配送器は `runAction` の外側(別プロセスの周期タイマー)で走るので、
      // 時刻起動が構造的にここへ**到達する**。** **下の個人所有の判定を関門の外に
      // 置いたら、時刻起動から積まれたジョブが止まった**(`(AC-G13-7)` /
      // `(AC-G13-8)` が赤くなった)—— **それは保留である `AC-G11` を実装したことになる。**
      const applies = writeBackJudgmentApplies(manifest, job);
      if (applies) {
        const denied = judgeWriteBack(db, manifest, job);
        if (denied !== undefined) {
          return { ok: false, usedFallback: false, value: null, error: denied };
        }
      }
      // **【`V17-M3-T03c` / `AC-G13` の「持ち主」の側】個人所有(`st_owner`)の判定。**
      //
      // **すぐ上の面と点は `st_owner` を1つも問わない** —— **書き戻し先の持ち主の列は
      // `table.fields` に在る普通の項目なので、`output_field` に `st_owner` を指すと
      // AI の答えがそのまま行の持ち主になる**(`docs/plan/v16/records/
      // investigation-b1-unmeasured-writes.md` の穴2 が実測した形である)。
      //
      // **【なぜこの判定だけ2度解くのか。上の判定は1度で足りるのに】** ——
      // **上の判定(面と点)は「この発火が、この表のこの行を書き換えてよいか」を問う。
      // 答えは**書こうとしている値に依らない**ので、1度解けば両方の口で使える。**
      // **こちらは「その値を書いたら行の持ち主がどう動くか」を問う** ——
      // **本命の値(AI の答え)とフォールバックの値は**別物**であり、片方が据え置きで
      // もう片方が付け替えということが起こりうる。****1つの値の答えをもう片方に
      // 流用すると、通してはいけない値を通すか、通してよい値を止めるかの
      // どちらかを必ずやる。** **だから口ごとに、これから書く値で解く。**
      // **【誇張しない】これは「2度呼ぶほうが速い」ではなく「1度では答えが出ない」である。**
      const judgeOwner = (candidate: string): string | undefined =>
        applies ? judgeWriteBackOwner(db, manifest, job, candidate) : undefined;

      // まず AI 出力を試す(null = 抽出失敗なので最初からフォールバックへ)。
      // **断られたときは書かずにフォールバックへ落とす** —— **`updateRecord` が
      // フィールド制約で拒否したときと同じ扱いであり、断りの理由は下で組み直す。**
      let primaryDenial: string | undefined;
      if (value !== null) {
        primaryDenial = judgeOwner(value);
        if (primaryDenial === undefined) {
          const result = updateRecord(db, manifest, job.targetTable, job.targetRecordId, {
            [job.outputField]: value,
          });
          if (result.ok) {
            return { ok: true, usedFallback: false, value };
          }
        }
      }
      // フォールバック(§3b)。**ここにも同じ判定を、フォールバックの値で当てる。**
      const fallbackDenial = judgeOwner(job.fallback);
      if (fallbackDenial !== undefined) {
        return {
          ok: false,
          usedFallback: true,
          value: null,
          error:
            primaryDenial === undefined
              ? fallbackDenial
              : `${primaryDenial} / フォールバックも同じ理由で書けません: ${fallbackDenial}`,
        };
      }
      // これも通らなければ書かない。
      const fallbackResult = updateRecord(db, manifest, job.targetTable, job.targetRecordId, {
        [job.outputField]: job.fallback,
      });
      if (fallbackResult.ok) {
        return { ok: true, usedFallback: true, value: job.fallback };
      }
      return {
        ok: false,
        usedFallback: true,
        value: null,
        error: fallbackResult.errors.map((e) => e.message).join(" / "),
      };
    });
  } finally {
    db.close();
  }
}

/**
 * **この書き戻しに判定を掛けるか**(`V17-M3-T03b` / `T03c`)。
 * **面と点の判定にも、個人所有の判定にも、**同じ1つの答え**を使う。**
 *
 * ## **時刻起動を今日どおり素通しさせる手当て**
 *
 * **配送器は `runAction` の外側で、別プロセスの周期タイマーから走る** ——
 * **`accessJudgmentApplies` の内側に構造的に居ない。** **そこで `job.workflowId` で
 * マニフェストからワークフロー定義を引き直し、同じ述語に渡す**(`D-V8-33` / `U-3`)。
 *
 * ## **【塞げていない穴。名指しで残す】ワークフロー定義を引けなかったジョブは通す**
 *
 * **ジョブが積まれた後にワークフローが消えていた場合、その発火が時刻起動だったかを
 * 知る手が1つも無い。** **止めると時刻起動から積まれたジョブが止まりうる**
 * (= **保留である `AC-G11` を実装したことになる**)。**したがって今日どおり通す。**
 * **【禁止】これを「塞いだ」と書かない** —— **「ワークフローを消してから AI の
 * 書き戻しを待つ」は、本段の後も残る迂回である。**
 * **実測は `src/kernel/ai-writeback-access-control.test.ts` の `(AC-G13-7)` /
 * `(AC-G13-8)` が持つ。**
 */
function writeBackJudgmentApplies(manifest: Manifest, job: { workflowId: string }): boolean {
  const workflow = manifest.app.workflows?.find((one) => one.id === job.workflowId);
  return workflow !== undefined && accessJudgmentApplies(workflow);
}

/**
 * **AI が書こうとしている値1つに、個人所有(`st_owner`)の判定を当てる**
 * (`V17-M3-T03c` / `AC-G13` の「持ち主」の側)。
 *
 * **判定は `src/server/owner-scope.ts` の `judgeOwnerScopedOp` **1本**であり、
 * HTTP のバッチ経路・島の `write_ops`・島の書き戻し(`writeBackToTriggerRecord`)と
 * **同じ関数**である。** **ここは答えをこの経路の断りの文面へ翻訳するだけで、
 * `st_owner` の規約を1つも再実装しない。**
 *
 * **`op.op` は `"update"` で固定する** —— **`create` 枝は `values` の持ち主を
 * 破壊的に上書きする**(`mutableValues[OWNER_FIELD] = actorId`)。
 * **書き戻しは常に既存行の更新であり、作成は1度も通らない。**
 *
 * **翻訳の向きは `writeBackToTriggerRecord`(島の書き戻し)にそろえた** ——
 * `invisible` は**存在を伏せる** / `forbidden` は**所有者の付け替え** /
 * `no_actor` は**所有者を決められない**。
 */
function judgeWriteBackOwner(
  db: Database,
  manifest: Manifest,
  job: { actor: string | null; targetTable: string; targetRecordId: string; outputField: string },
  candidate: string,
): string | undefined {
  const verdict = judgeOwnerScopedOp({
    table: resolveTable(manifest, job.targetTable),
    op: {
      op: "update",
      table: job.targetTable,
      target: job.targetRecordId,
      values: { [job.outputField]: candidate },
    },
    actorId: job.actor,
    readRow: (tableId, recordId) => {
      const found = getRecord(db, manifest, tableId, recordId);
      return found.ok && found.value !== null
        ? (found.value as unknown as Record<string, unknown>)
        : undefined;
    },
  });
  if (verdict.kind === "invisible") {
    // **存在そのものを伏せる**(単件 `GET` の 404 と同じ向き)。
    return `AI の書き戻し先のレコード(テーブル "${verdict.tableId}" の "${verdict.target}")は見つかりません(1バイトも書いていません)。`;
  }
  if (verdict.kind === "forbidden") {
    return `AI の書き戻しはレコードの所有者を付け替えようとしています(1バイトも書いていません)。`;
  }
  if (verdict.kind === "no_actor") {
    return `AI の書き戻しは個人所有のテーブルが相手ですが、この発火には所有者を決められるレコードがありません(1バイトも書いていません)。`;
  }
  return undefined;
}

/**
 * **AI の書き戻し1件に、面(役割に束ねた権限)と点(行ごとの付与)を当てる**
 * (`V17-M3-T03b` / `AC-G13`(2))。 **通れば `undefined`、止めれば断りの理由。**
 *
 * **【`V17-M3-T03c` による移動。隠さない】** **本 doc に在った「時刻起動を今日どおり
 * 素通しさせる手当て」と「ワークフロー定義を引けなかったジョブは通す」の2節は、
 * {@link writeBackJudgmentApplies} へ移した** —— **同じ関門を個人所有の判定も
 * 通るようになり、この関数だけの性質ではなくなったからである。**
 * **条文を2箇所に置くと片方だけが古くなるので、写さずに移した。**
 *
 * ## **対象行が読めないときは判定を掛けない**
 *
 * **`workflow-runner.ts` の `update_record` の枝とまったく同じ作法である** ——
 * **「その行は無い」を `updateRecord` の既存の応答で返し、見えない行の存在を
 * 権限の文面で言い当てさせない。**
 */
function judgeWriteBack(
  db: Database,
  manifest: Manifest,
  job: { actor: string | null; targetTable: string; targetRecordId: string },
): string | undefined {
  const existing = getRecord(db, manifest, job.targetTable, job.targetRecordId);
  const row =
    existing.ok && existing.value !== null
      ? (existing.value as unknown as Record<string, unknown>)
      : undefined;
  if (row === undefined) {
    return undefined;
  }
  return judgeAutomationWrite({
    db,
    manifest,
    tableId: job.targetTable,
    row,
    verb: "write",
    actor: () => job.actor,
  });
}

function findField(manifest: Manifest, tableId: string, fieldId: string): Field | undefined {
  return manifest.app.tables
    .find((table) => table.id === tableId)
    ?.fields.find((field) => field.id === fieldId);
}
