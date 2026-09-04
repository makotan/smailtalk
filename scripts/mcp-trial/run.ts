/**
 * シナリオを1本実行し、証跡を残す(V0-P6-T03a)。
 *
 * CP-5 の実地検証は一時ファイルのスクリプトで行われ、再実行できなかった
 * (docs/evidence/cp-5.md §0)。ここでは同じ手順を**仕組み**にする。
 *
 * このファイルは意図的に薄い。判定に関わるロジック(引数の組み立て・状態採取・突き合わせ)は
 * すべて純関数として別ファイルに切り出してあり、`claude` を起動しなくてもテストできる。
 * ここに残っているのはプロセスの起動とファイルの配置だけである。
 *
 * ```console
 * $ mise exec -- bun run scripts/mcp-trial/run.ts --scenario bootstrap
 * $ mise exec -- bun run scripts/mcp-trial/run.ts --scenario broken-reference --dry-run
 * ```
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { applySkillArm, buildClaudeArgs, buildMcpConfig, type SkillArm } from "./cli-args.ts";
import { formatReport, judgeTrial } from "./judge.ts";
import { resolveScenario } from "./scenario.ts";
import { assertIsolatedDataRoot, takeSnapshot } from "./snapshot.ts";
import type { Snapshot, TrialMeta } from "./types.ts";

export interface RunOptions {
  scenario: string;
  /**
   * 評価専用のデータルート。リポジトリの `data/` とは必ず分離する。
   * **未指定なら `defaultDataRoot(シナリオID)`**(V1-M0-T06 (d))。
   */
  dataRoot?: string;
  /** 試行ディレクトリを作る親ディレクトリ。 */
  out: string;
  /**
   * **公開単位の根**(`.mcp.json` が在る場所であり、`--data-root` / `--out` の相対指定を
   * 解く基準でもある)。**`V9-M3-T01` でここを明示の入力にした。**
   *
   * `V9-M1` / `V9-M2` の前は「このファイルから2つ上」が正本のルート(リポジトリの根)で、
   * そこに `.mcp.json` が在った。このファイルが `<正本のルート>/apps/smailtalk/scripts/mcp-trial/`
   * へ動いたとき、**2つ上は `apps/smailtalk/` になり、そこには `.mcp.json` が無かった** ——
   * `readFileSync` が投げて試行が1件も残らなくなっていた。そこで `V9-M3-T01` は
   * **4階層上げて正本のルートへ戻す**という直し方を採った。
   *
   * **`V9-M11`(`X-G29` / `X-G30`)でその直し方をやめた。** 公開単位(`apps/smailtalk/`)の
   * 中のコードは**自分より上の階層を1度も解決しない**、というのが今日の決めである。
   * `V9-M11-T01` が `apps/smailtalk/.mcp.json` を新設したので、**根は公開単位そのもの**
   * (このファイルから2階層上)でよくなった。
   *
   * **未指定なら `defaultRepoRoot()`**(= `apps/smailtalk/`)。
   * **偽のルートを指して走らせたいときだけ指定する。**
   */
  repoRoot?: string;
  /** 破棄した試行に付けるメモ(任意)。 */
  note?: string;
  /** `claude` を起動せず、組み立てた引数だけを表示する。 */
  dryRun: boolean;
  /**
   * MCP サーバに渡す名乗り(`ST_MCP_ACTOR`)。**未指定なら今日と同じ**(`.mcp.json` の値のまま)。
   *
   * `V8-M31` 以降、アプリを名指しする MCP ツールは「名乗った利用者がそのアプリに
   * 登録されていること」を要求する(`src/mcp/actor-guard.ts`)。`.mcp.json` の `ST_MCP_ACTOR` は
   * 空の欄なので、**共有アプリのシナリオではここを指定しないと全ツールが落ちる。**
   */
  actor?: string;
  /**
   * 説明書(skill)の腕。**未指定なら今日と同じ**(どちらのツール一覧にも触らない)。
   *
   * 既存34本のシナリオは `disallowed_tools` に `Skill` を持っているので、未指定のまま
   * 走らせれば従来どおり説明書は開けない。腕を明示するのは、**同じシナリオファイルから
   * 2腕を組み立てる**シナリオ(`shared-lending-app`)のためである。
   */
  skillArm?: SkillArm;
}

/**
 * シナリオごとの独立データルート(V1-M0-T06 (d)。F-18 の原因への対処)。
 *
 * v0 では既定が `data-cp6` 固定で、**全シナリオが同じデータルートを共有していた**。
 * その結果 005/T1 で `create_app(app_id="book-log")` が前の試行 004 の成果物と衝突し、
 * AI が確認せずに既存アプリの流用へ方針転換して**シナリオの前提が壊れた**(F-18)。
 * 001-t04-improvements が `--data-root` を明示指定して回避していたのは、
 * **既定が危ないことを人間が知っていた**からであり、仕組みが守っていたからではない。
 *
 * 既定を分けると、`bootstrap` の成果物を `out-of-vocabulary` が使う従来の運用は成立しなくなる。
 * **共有したい場合は `--data-root` で明示する**(README §データルート)。
 * 事故を既定にせず、共有を明示にする ―― という向きにした。
 */
export function defaultDataRoot(scenarioId: string): string {
  // `assertIsolatedDataRoot` が `data-` 接頭辞を要求するので、それに合わせる。
  return `data-${scenarioId}`;
}

/** 明示指定があればそれを、無ければシナリオごとの既定を使う。 */
export function resolveDataRoot(options: RunOptions, scenarioId: string): string {
  const explicit = options.dataRoot;
  return explicit === undefined || explicit === "" ? defaultDataRoot(scenarioId) : explicit;
}

/**
 * **根の既定値 —— 公開単位(`apps/smailtalk/`)そのもの。**
 * このファイルは `<公開単位>/scripts/mcp-trial/` に在るので**2階層**上げる。
 *
 * **ここより上を1度も解決しない**(`X-G29`)。かつては4階層上げて正本のルート
 * (リポジトリの根)へ出ていたが、それだと公開単位だけを切り出した木で
 * `<根>/.mcp.json` が見つからず、`run.test.ts` が4件落ちていた。
 * 読み先は `V9-M11-T01` が新設した `apps/smailtalk/.mcp.json` である。
 *
 * **`process.cwd()` は使っていない**(`V9-M3-T01` 裁定2)。
 * **git に問い合わせて根を探すこともしない**(`X-G29` 限定2)。
 */
export function defaultRepoRoot(): string {
  return resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
}

/** 明示指定があればそれを、無ければ既定を使う(`resolveDataRoot` と同じ形)。 */
export function resolveRepoRoot(options: RunOptions): string {
  const explicit = options.repoRoot;
  return explicit === undefined || explicit === "" ? defaultRepoRoot() : resolve(explicit);
}

/**
 * 次の試行ID。**破棄した試行も番号を消費する**ので、
 * 「何回試して何回捨てたか」がディレクトリ一覧だけで分かる。
 */
export function nextTrialId(existing: string[], scenarioId: string): string {
  const max = existing.reduce((acc, name) => {
    const seq = /^(\d{3})-/.exec(name)?.[1];
    return seq === undefined ? acc : Math.max(acc, Number.parseInt(seq, 10));
  }, 0);
  return `${String(max + 1).padStart(3, "0")}-${scenarioId}`;
}

/** コマンドライン引数のパース(純関数)。 */
export function parseRunOptions(argv: string[]): RunOptions {
  const options: RunOptions = {
    scenario: "",
    out: "docs/evidence/cp-6/transcripts",
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--scenario":
        options.scenario = value ?? "";
        i += 1;
        break;
      case "--data-root":
        options.dataRoot = value ?? "";
        i += 1;
        break;
      case "--out":
        options.out = value ?? "";
        i += 1;
        break;
      case "--repo-root":
        options.repoRoot = value ?? "";
        i += 1;
        break;
      case "--note":
        options.note = value ?? "";
        i += 1;
        break;
      case "--actor":
        options.actor = value ?? "";
        i += 1;
        break;
      case "--skill":
        // 値域を here で閉じる。打ち間違い(`--skill on` など)を黙って
        // 「腕を付けなかった試行」にしてしまうと、2腕の比較が静かに壊れる。
        if (value !== "allow" && value !== "deny") {
          throw new Error(
            `--skill は allow か deny を指定してください(指定: ${value ?? "なし"})。`,
          );
        }
        options.skillArm = value;
        i += 1;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        throw new Error(`知らないフラグです: ${flag}`);
    }
  }
  if (options.scenario === "") throw new Error("--scenario は必須です。");
  return options;
}

async function main(): Promise<never> {
  const options = parseRunOptions(process.argv.slice(2));
  const scenario = resolveScenario(options.scenario);
  const root = resolveRepoRoot(options);
  const dataRoot = assertIsolatedDataRoot(resolve(root, resolveDataRoot(options, scenario.id)));
  const outDir = resolve(root, options.out);

  // 説明書(skill)の腕。**`--skill` を付けなかったときはシナリオの値をそのまま使う**ので、
  // 既存34本の走らせ方は1バイトも変わらない。
  const tools =
    options.skillArm === undefined
      ? { allowedTools: scenario.allowedTools, disallowedTools: scenario.disallowedTools }
      : applySkillArm(scenario.allowedTools, scenario.disallowedTools, options.skillArm);

  // --- V1-M0-T06 (c): dry-run は何も作らない ---------------------------------------
  // v0 のハーネスは dry-run でも試行ディレクトリを作り、連番を1つ消費していた
  // (`docs/v0-bootstrap-log.md` §4-4。cp-6 の 001-bootstrap がそれである)。
  // **証跡が1件多く見えることは検証記録の信頼性に直接効く**ので、
  // dry-run は mkdir も採番もせず、組み立てた引数だけを出して終わる。
  if (options.dryRun) {
    console.error(`[mcp-trial] (dry-run) ${scenario.title}`);
    console.error(`[mcp-trial] (dry-run) ST_DATA_ROOT=${dataRoot}`);
    console.error("[mcp-trial] (dry-run) 試行ディレクトリは作らず、連番も消費しません。");
    // 腕と名乗りも dry-run で見えるようにする。**dry-run で確認できない条件を作らない。**
    console.error(`[mcp-trial] (dry-run) skill=${options.skillArm ?? "(シナリオのまま)"}`);
    console.error(`[mcp-trial] (dry-run) ST_MCP_ACTOR=${options.actor ?? "(.mcp.json のまま)"}`);
    const claudeBin = process.env.ST_TRIAL_CLAUDE_BIN ?? "claude";
    // まだ試行ディレクトリが無いので、mcp.json の置き場所は「置かれる予定の場所」を示す。
    const plannedMcpConfigPath = join(outDir, `<連番>-${scenario.id}`, "mcp.json");
    const sessionId = "<実行時に採番>";
    for (const [i, prompt] of scenario.turns.entries()) {
      const args = buildClaudeArgs({
        prompt,
        mcpConfigPath: plannedMcpConfigPath,
        allowedTools: tools.allowedTools,
        disallowedTools: tools.disallowedTools,
        sessionId,
        turn: i + 1,
      });
      console.error(`[mcp-trial] (dry-run) turn ${i + 1}: ${claudeBin} ${args.join(" ")}`);
    }
    process.exit(0);
  }

  mkdirSync(outDir, { recursive: true });

  const trialId = nextTrialId(readdirSync(outDir), scenario.id);
  const trialDir = join(outDir, trialId);
  mkdirSync(trialDir, { recursive: true });

  // 評価専用の .mcp.json。リポジトリにコミットされている .mcp.json は触らない。
  const mcpConfigPath = join(trialDir, "mcp.json");
  const mcpConfig = buildMcpConfig(
    readFileSync(join(root, ".mcp.json"), "utf-8"),
    dataRoot,
    options.actor,
  );
  writeFileSync(mcpConfigPath, `${JSON.stringify(mcpConfig, null, 2)}\n`);

  const sessionId = crypto.randomUUID();
  const streamPath = join(trialDir, "stream.jsonl");
  const snapshots: Snapshot[] = [];
  const argvLog: string[][] = [];
  const startedAt = new Date().toISOString();
  const claudeBin = process.env.ST_TRIAL_CLAUDE_BIN ?? "claude";

  console.error(`[mcp-trial] ${trialId} / ${scenario.title}`);
  console.error(`[mcp-trial] ST_DATA_ROOT=${dataRoot}`);
  console.error(`[mcp-trial] session=${sessionId}`);

  writeFileSync(streamPath, "");

  for (const [i, prompt] of scenario.turns.entries()) {
    const turn = i + 1;
    const args = buildClaudeArgs({
      prompt,
      mcpConfigPath,
      allowedTools: tools.allowedTools,
      disallowedTools: tools.disallowedTools,
      sessionId,
      turn,
    });
    argvLog.push([claudeBin, ...args]);

    snapshots.push(takeSnapshot(dataRoot, "before", turn));
    console.error(`[mcp-trial] turn ${turn}/${scenario.turns.length} 実行中…`);

    const proc = Bun.spawn([claudeBin, ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "inherit",
      env: { ...process.env, ST_DATA_ROOT: dataRoot },
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    appendStream(streamPath, stdout);
    snapshots.push(takeSnapshot(dataRoot, "after", turn));

    if (exitCode !== 0) {
      console.error(`[mcp-trial] claude が終了コード ${exitCode} で終わりました(証跡は保存済み)。`);
      break;
    }
  }

  const meta: TrialMeta = {
    trialId,
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    sessionId,
    dataRoot,
    startedAt,
    endedAt: new Date().toISOString(),
    // **効かせた値**を残す(シナリオの値ではない)。腕を付けた試行では、ここに Skill が入る。
    allowedTools: tools.allowedTools,
    disallowedTools: tools.disallowedTools,
    expectedAbsentTools: scenario.expectedAbsentTools,
    turns: scenario.turns,
    argv: argvLog,
    snapshots,
    ...(options.note === undefined ? {} : { note: options.note }),
    // 腕と名乗りは**付けたときだけ**入れる。欄が無いこと自体が「付けていない試行」を意味する。
    ...(options.skillArm === undefined ? {} : { skillArm: options.skillArm }),
    ...(options.actor === undefined ? {} : { actor: options.actor }),
  };
  writeFileSync(join(trialDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);

  const report = judgeTrial(meta, readFileSync(streamPath, "utf-8"));
  writeFileSync(join(trialDir, "judge.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(formatReport(report));
  console.error(`[mcp-trial] 証跡: ${trialDir}`);
  process.exit(report.verdict === "valid" ? 0 : 1);
}

/** stream-json の出力を1本の JSONL に追記する(ターンをまたいで1会話として繋ぐ)。 */
function appendStream(path: string, chunk: string): void {
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const normalized = chunk.endsWith("\n") || chunk === "" ? chunk : `${chunk}\n`;
  writeFileSync(path, existing + normalized);
}

if (import.meta.main) {
  await main();
}
