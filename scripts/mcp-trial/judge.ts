/**
 * 保存された証跡を**機械的に**判定する(V0-P6-T03a)。
 *
 * 人間の主観を入れないために、判定はすべて「証跡の突き合わせ」に落としてある。
 * 判定項目は4つ:
 *
 * 1. **本命** — 実行前後に観測されたファイル変化が、すべて transcript 上の MCP ツール呼び出しで
 *    説明できるか。説明できない変化が1件でもあれば検証無効。transcript は「AI が何をしたか」の
 *    記録であって「人間が何をしなかったか」の記録ではないので、ここを見ないと
 *    別ターミナルで `sqlite3` を叩かれた場合を見抜けない。
 * 2. `system/init` に**実際に現れた**ツール一覧の検証(設定した値ではなく効いた値)。
 *    MCP 以外の書き込み経路が0であること。
 * 3. 人間ターンの本文にコードブロック・JSON リテラルが無いこと(完成形を貼れば
 *    ツールを使わずに「手書き禁止」を破れてしまうため)。
 * 4. V0-P6-T04(つまずきの記録)の一次ソースになる機械抽出。
 *
 * 使い方: `mise exec -- bun run scripts/mcp-trial/judge.ts <試行ディレクトリ>`
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { explainChanges } from "./attribution.ts";
import { lintPrompt } from "./prompt-lint.ts";
import { diffSnapshots } from "./snapshot.ts";
import {
  detectErrorEpisodes,
  detectRefusals,
  detectRetries,
  mcpToolSuffix,
  parseTranscript,
  successfulCalls,
  successfulWriteCalls,
  summarizeToolUsage,
} from "./transcript.ts";
import type { Extraction, JudgeReport, Snapshot, TrialMeta, Violation } from "./types.ts";

/** MCP 以外で唯一許すツール。禁止が効いた証拠を生ログに残すために allow に入れている。 */
const ALLOWED_NON_MCP_TOOLS = ["ToolSearch"];

/**
 * 判定の振る舞いを呼び出し側から**明示的に**変える口。**既定は「何も変えない」**。
 *
 * これを足した理由(V6-M14b)は1つだけである —— **「説明書(skill)を配ると AI の躓きが減るか」を
 * 測る実験では、`Skill` ツールが実効一覧に現れるのが正常な状態である**。上の隔離条件
 * (`docs/evidence/cp-5.md` §0-(a):ソースから語彙を学習されると検証が無効になる)は
 * その実験より前に書かれており、`Skill` という仕組みがまだ無かった。
 *
 * **隔離条件そのものは1文字も引き直していない。** 既定(このオプションを渡さないとき)は
 * 今日どおり `ToolSearch` 以外の非 MCP ツールを全部違反にする。**過去の証跡の判定は1件も変わらない**
 * (`evidence-drift.test.ts` は第3引数を渡さずに呼ぶ)。
 */
export interface JudgeOptions {
  /**
   * `ALLOWED_NON_MCP_TOOLS` に**この呼び出しに限り**足すツール名。
   * 既定は空。**空のときの判定は、このオプションが無かったときと1バイトも変わらない。**
   */
  additionalAllowedNonMcpTools?: readonly string[];
}

/**
 * CLI から上のオプションを有効化するための環境変数(`ST_JUDGE_ALLOW_NON_MCP_TOOLS`)を読む純関数。
 * **未設定なら空**を返す —— つまり既定では何も許さない。
 */
export function parseAllowedNonMcpToolsEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * 「説明書(skill)を配ると AI の躓きが減るか」の比較実測で、**3本の腕すべてに同じだけ**
 * 上のオプションへ渡す語(V6-M14c。ユーザ決定 `D-V6-25`)。
 *
 * - `Skill` —— 説明書を開く道具。**説明書ありの腕では実効一覧に現れるのが正常な状態である**(V6-M14b)。
 * - `ListAgents` —— `claude` CLI の組み込み道具。**説明書を全部外した腕でも実効一覧に現れた**
 *   (`v6-m14b.md` §5-2 の実測)。**この製品とは無関係であり、`REQUIRED_DISALLOWED_TOOLS` の9本にも入っていない。**
 *
 * **これは既定値ではない。** 渡さない限り1バイトも効かない —— つまり `docs/evidence/**` の
 * 凍結された証跡の判定は1件も変わらない(`evidence-drift.test.ts` は第3引数を渡さずに呼ぶ)。
 * **腕ごとに違う語を渡さないための1本化**であって、隔離条件(`docs/evidence/cp-5.md` §0-(a))を
 * 引き直したものではない。
 */
export const SKILL_TRIAL_ALLOWED_NON_MCP_TOOLS: readonly string[] = ["Skill", "ListAgents"];
/**
 * MCP サーバ名として認める値。現行名は `smailtalk`。`growable-platform` は改称前の名で、
 * `docs/evidence/**` にバイト単位で凍結された過去証跡が永久にこの名で `system/init` を
 * 記録し続けるため、判定を壊さないようここで併記する(このモジュールの他の判定は
 * `mcpToolSuffix` でサーバ名を問わずに剥がす方式に揃えている)。
 */
const RECOGNIZED_MCP_SERVER_NAMES = new Set(["smailtalk", "growable-platform"]);
/** mtime 比較の許容幅(ミリ秒)。ファイルシステムの丸めとプロセス起動の前後ずれを吸収する。 */
const MTIME_SLACK_MS = 5_000;

/** 証跡(meta.json と生ログ)から判定レポートを作る純関数。 */
export function judgeTrial(
  meta: TrialMeta,
  transcriptSource: string,
  options: JudgeOptions = {},
): JudgeReport {
  // 既定は `ALLOWED_NON_MCP_TOOLS` そのもの。呼び出し側が明示的に渡したときだけ広がる。
  const allowedNonMcpTools = [
    ...ALLOWED_NON_MCP_TOOLS,
    ...(options.additionalAllowedNonMcpTools ?? []),
  ];
  const parsed = parseTranscript(transcriptSource);
  const violations: Violation[] = [];
  const warnings: string[] = [];

  // --- 証跡がそもそも揃っているか -------------------------------------------------
  if (parsed.malformedLines.length > 0) {
    violations.push({
      code: "evidence_missing",
      message: "生ログに JSON として読めない行があります。",
      detail: `行番号: ${parsed.malformedLines.join(", ")}`,
    });
  }
  if (parsed.inits.length !== meta.turns.length) {
    violations.push({
      code: "evidence_missing",
      message: "system/init の回数と人間ターン数が一致しません(生ログの取りこぼしの疑い)。",
      detail: `init=${parsed.inits.length} / turns=${meta.turns.length}`,
    });
  }
  const expectedSnapshots = meta.turns.length * 2;
  if (meta.snapshots.length !== expectedSnapshots) {
    violations.push({
      code: "evidence_missing",
      message: "ターンごとの前後スナップショットが揃っていません。",
      detail: `snapshots=${meta.snapshots.length} / 期待=${expectedSnapshots}`,
    });
  }

  // --- 人間ターンの本文 ----------------------------------------------------------
  for (const [i, turn] of meta.turns.entries()) {
    for (const found of lintPrompt(turn)) {
      violations.push({
        code: "prompt_contains_code",
        message: `ターン${i + 1}のプロンプトに ${found.kind} が含まれています(手書き禁止の回避)。`,
        detail: found.excerpt,
      });
    }
  }

  // --- 実効ツール一覧 ------------------------------------------------------------
  for (const init of parsed.inits) {
    const forbidden = init.tools.filter(
      (tool) => mcpToolSuffix(tool) === undefined && !allowedNonMcpTools.includes(tool),
    );
    if (forbidden.length > 0) {
      violations.push({
        code: "forbidden_tool_effective",
        message: `ターン${init.turn}の実効ツール一覧に MCP 以外のツールが含まれています(cp-5.md §0-(a) の隔離条件が破れています)。`,
        detail: forbidden.join(", "),
      });
    }
    const absent = meta.expectedAbsentTools.filter((tool) => init.tools.includes(tool));
    if (absent.length > 0) {
      violations.push({
        code: "expected_absent_tool_present",
        message: `ターン${init.turn}で、外したはずのツールが実効一覧に残っています。`,
        detail: absent.join(", "),
      });
    }
    const connected = init.mcpServers.some(
      (server) => RECOGNIZED_MCP_SERVER_NAMES.has(server.name) && server.status === "connected",
    );
    if (!connected) {
      violations.push({
        code: "mcp_server_not_connected",
        message: `ターン${init.turn}で smailtalk MCP サーバに接続できていません。`,
        detail: JSON.stringify(init.mcpServers),
      });
    }
  }

  // --- ターン間の改変(会話の外で人間が触っていないか) ----------------------------
  for (let turn = 1; turn < meta.turns.length; turn += 1) {
    const after = findSnapshot(meta.snapshots, "after", turn);
    const nextBefore = findSnapshot(meta.snapshots, "before", turn + 1);
    if (after === undefined || nextBefore === undefined) continue;
    const between = diffSnapshots(after, nextBefore);
    if (between.length > 0) {
      violations.push({
        code: "change_between_turns",
        message: `ターン${turn}の終了後、ターン${turn + 1}の開始前にデータが変化しました(会話の外での改変)。`,
        detail: between.map((c) => `${c.kind}:${c.path}`).join(", "),
      });
    }
  }

  // --- 本命: 変化がツール呼び出しで説明できるか ------------------------------------
  const writeCalls = successfulWriteCalls(parsed);
  const first = findSnapshot(meta.snapshots, "before", 1);
  const last = [...meta.snapshots].reverse().find((s) => s.phase === "after");
  const changeAttribution =
    first === undefined || last === undefined
      ? []
      : explainChanges(diffSnapshots(first, last), successfulCalls(parsed));

  const unexplained = changeAttribution.filter((c) => c.explainedBy.length === 0);
  if (unexplained.length > 0) {
    violations.push({
      code: "unexplained_change",
      message:
        "transcript 上のツール呼び出しでは説明できないファイル変化があります(= 会話の外で誰かが触った)。",
      detail: unexplained.map((c) => `${c.kind}:${c.path}(scope=${c.scope})`).join(", "),
    });
  }

  const startedAt = Date.parse(meta.startedAt);
  const endedAt = Date.parse(meta.endedAt);
  const outsideWindow = changeAttribution
    .map((attribution) => ({
      attribution,
      mtimeMs: mtimeOf(last, attribution.path),
    }))
    .filter(
      ({ mtimeMs }) =>
        mtimeMs !== null &&
        (mtimeMs < startedAt - MTIME_SLACK_MS || mtimeMs > endedAt + MTIME_SLACK_MS),
    );
  if (outsideWindow.length > 0) {
    violations.push({
      code: "mtime_outside_run",
      message: "変化したファイルの mtime が実行時間帯の外にあります(証跡の差し替えの疑い)。",
      detail: outsideWindow
        .map(
          ({ attribution, mtimeMs }) =>
            `${attribution.path}@${new Date(mtimeMs ?? 0).toISOString()}`,
        )
        .join(", "),
    });
  }

  // --- 警告(無効にはしないが人間が見るべきもの) ----------------------------------
  const weak = changeAttribution.filter((c) => c.weak);
  if (weak.length > 0) {
    warnings.push(
      `参照系ツールだけで説明が付いた変化が ${weak.length} 件あります(SQLite は読むだけでも動くため)。中身の変更が別経路で入っていないかは、この判定では保証できません: ${weak.map((c) => c.path).join(", ")}`,
    );
  }
  if (writeCalls.length > 0 && changeAttribution.length === 0) {
    warnings.push(
      `書き込み系ツールが ${writeCalls.length} 件成功しているのに、ファイル変化が観測されていません(データルートの指定違いの疑い)。`,
    );
  }
  for (const result of parsed.turnResults) {
    if (result.isError)
      warnings.push(`ターン${result.turn}が異常終了しています(${result.subtype})。`);
  }

  const extraction: Extraction = {
    toolUsage: summarizeToolUsage(parsed),
    errorEpisodes: detectErrorEpisodes(parsed),
    // V1-M0-T06 (a) 条件2: 「何に対する断りか」を出すには、人間が何を頼んだかが要る。
    refusals: detectRefusals(parsed, { humanTurns: meta.turns }),
    retries: detectRetries(parsed),
    humanTurns: meta.turns.map((text, i) => ({ turn: i + 1, text })),
    effectiveTools: parsed.inits.map((init) => ({ turn: init.turn, tools: init.tools })),
    changeAttribution,
  };

  return {
    trialId: meta.trialId,
    scenarioId: meta.scenarioId,
    verdict: violations.length === 0 ? "valid" : "invalid",
    violations,
    warnings,
    extraction,
  };
}

function fmtSec(ms: number | undefined): string {
  return ms === undefined ? "?" : `${(ms / 1000).toFixed(1)}s`;
}

function findSnapshot(
  snapshots: Snapshot[],
  phase: "before" | "after",
  turn: number,
): Snapshot | undefined {
  return snapshots.find((s) => s.phase === phase && s.turn === turn);
}

function mtimeOf(snapshot: Snapshot | undefined, path: string): number | null {
  return snapshot?.files.find((f) => f.path === path)?.mtimeMs ?? null;
}

/** 人間が読む要約。judge.json とは別に標準出力へ出す。 */
export function formatReport(report: JudgeReport): string {
  const lines: string[] = [];
  lines.push(`# 判定: ${report.verdict === "valid" ? "有効" : "検証無効"} (${report.trialId})`);
  lines.push("");
  if (report.violations.length > 0) {
    lines.push("## 違反");
    for (const v of report.violations) {
      lines.push(
        `- [${v.code}] ${v.message}${v.detail === undefined ? "" : `\n      ${v.detail}`}`,
      );
    }
    lines.push("");
  }
  if (report.warnings.length > 0) {
    lines.push("## 警告");
    for (const w of report.warnings) lines.push(`- ${w}`);
    lines.push("");
  }
  const e = report.extraction;
  lines.push("## 呼ばれたツール");
  for (const usage of e.toolUsage) {
    lines.push(`- ${usage.name}: ${usage.count}回(エラー ${usage.errorCount}回)`);
  }
  lines.push("");
  lines.push(`## エラーと自己修正 (${e.errorEpisodes.length}件)`);
  // 段階別の内訳(V1-M0-T13)。`input-parse` は MCP に到達せず落ちたもので、
  // サーバ側の検証エラーと混ぜてしまうと「F-17 が再発したか」を機械的に問えなくなる。
  const parseStage = e.errorEpisodes.filter((ep) => ep.stage === "input-parse");
  lines.push(
    `内訳: server ${e.errorEpisodes.length - parseStage.length}件 / input-parse ${parseStage.length}件`,
  );
  if (parseStage.length > 0) {
    lines.push(
      "      → F-17 / F-24 に該当。**MCP サーバ・カーネルのどちらでも防げない層**(ツール入力のパース)で落ちている。",
    );
  }
  for (const episode of e.errorEpisodes) {
    const state = episode.selfCorrected
      ? `自己修正 成立(${episode.correctedBy ?? ""}${episode.humanInputBetween ? " / ただし人間の入力を挟む" : ""})`
      : "自己修正 なし";
    const stage =
      episode.stage === "input-parse" ? "[MCP 未到達(入力パース層)]" : "[server(MCP 到達)]";
    lines.push(`- ターン${episode.turn} ${episode.tool} #${episode.toolUseId} ${stage}: ${state}`);
    lines.push(`      ${episode.errorText.replace(/\n/g, " ")}`);
    if (episode.unparsedInput !== undefined) {
      lines.push(
        `      未パースの生入力(${episode.unparsedInput.len}バイト): ${episode.unparsedInput.raw.replace(/\n/g, " ")}`,
      );
    }
  }
  lines.push("");
  lines.push(`## やり直し (${e.retries.length}件)`);
  for (const retry of e.retries) {
    const cost =
      retry.meanRedoMs === undefined
        ? " / 所要時間 **算出不能**(証跡に時刻が無い)"
        : ` / 全体 ${fmtSec(retry.durationMs)} = やり直し ${retry.redoCount}回、1回あたり平均 ${fmtSec(retry.meanRedoMs)}(内訳 ${(retry.redoMs ?? []).map(fmtSec).join(" + ")} / うちツール実行 ${fmtSec(retry.toolExecMs)})`;
    lines.push(
      `- ターン${retry.turn} ${retry.tool}: ${retry.attempts}回試行 / ${retry.succeeded ? "最終的に成功" : "成功せず"}${cost}`,
    );
  }
  lines.push("");
  lines.push(`## 断りの候補 (${e.refusals.length}件)`);
  for (const refusal of e.refusals) {
    lines.push(`- ターン${refusal.turn} [${refusal.kinds.join(" + ")}]`);
    lines.push(`      何に対して: ${refusal.requested.replace(/\n/g, " ") || "(人間ターン不明)"}`);
    const ev = refusal.evidence;
    lines.push(
      `      証跡: ツール呼び出し${ev.toolCallCount}件 / 書き込み成功${ev.successfulWriteCallCount}件 / エラー${ev.errorCount}件 / 問いで終わる=${ev.askedBack}`,
    );
    for (const s of refusal.statements) {
      lines.push(`      「${s.sentence.replace(/\n/g, " ")}」(${s.rationale})`);
    }
    if (refusal.statements.length === 0) {
      lines.push("      本文に限界の言明は無い(証跡だけで拾った断りである)");
    }
  }
  lines.push("");
  lines.push(`## 人間ターン (${e.humanTurns.length}件)`);
  for (const turn of e.humanTurns) lines.push(`- ${turn.turn}: ${turn.text.replace(/\n/g, " ")}`);
  lines.push("");
  lines.push("## 観測されたファイル変化と説明");
  for (const change of e.changeAttribution) {
    const by = change.explainedBy.length === 0 ? "**説明不能**" : change.explainedBy.join(" / ");
    lines.push(`- ${change.kind} ${change.path} [${change.scope}] ← ${by}`);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const trialDir = process.argv[2];
  if (trialDir === undefined) {
    console.error("usage: judge.ts <試行ディレクトリ>");
    process.exit(2);
  }
  const metaPath = join(trialDir, "meta.json");
  const streamPath = join(trialDir, "stream.jsonl");
  if (!existsSync(metaPath) || !existsSync(streamPath)) {
    console.error(`meta.json / stream.jsonl が見つかりません: ${trialDir}`);
    process.exit(2);
  }
  const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as TrialMeta;
  // 既定では未設定 = 空。設定したときだけ、その分だけ非 MCP ツールを違反にしない。
  const additionalAllowedNonMcpTools = parseAllowedNonMcpToolsEnv(
    process.env.ST_JUDGE_ALLOW_NON_MCP_TOOLS,
  );
  if (additionalAllowedNonMcpTools.length > 0) {
    console.error(
      `[judge] ST_JUDGE_ALLOW_NON_MCP_TOOLS により、次の非 MCP ツールを違反にしません: ${additionalAllowedNonMcpTools.join(", ")}`,
    );
  }
  const report = judgeTrial(meta, readFileSync(streamPath, "utf-8"), {
    additionalAllowedNonMcpTools,
  });
  writeFileSync(join(trialDir, "judge.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(formatReport(report));
  process.exit(report.verdict === "valid" ? 0 : 1);
}
