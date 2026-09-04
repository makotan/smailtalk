/**
 * ベンチマークの入口(V1-M1-T05)。
 *
 * ## 使い方
 *
 * ```console
 * $ bun run scripts/bench/run.ts                       # 全シナリオ。結果を results/latest.json に書く
 * $ bun run scripts/bench/run.ts --only=copies         # 1シナリオだけ
 * $ bun run scripts/bench/run.ts --reps=5 --seed=123   # 繰り返し回数とシードを変える
 * $ bun run scripts/bench/run.ts --out=/tmp/a.json     # 出力先を変える
 * ```
 *
 * シナリオ名(カンマ区切りで複数可):
 * - M1-T05: `snapshot` / `mutation` / `copies` / `journal`
 * - M9-T03: `contention`(同一プロセス複数接続の書込中読取ブロック)/
 *   `xproc`(別プロセス書き手との本物の待ち)/ `snapshot_size`(1/10/100MB × DELETE/WAL)
 * - M3-T06: `load`(N 本の書き手プロセスによる直列化 / デッドロックの負荷試験)
 * - V8-M10-T07: `report`(集計表の読取。**本物の HTTP。**単表 / 順方向・逆方向の結合 /
 *   5表 × 10,000行 / 可視性の post-filter が掛かる分岐と掛からない分岐の差)
 *
 * ```console
 * $ bun run scripts/bench/run.ts --only=contention,xproc,snapshot_size --out=scripts/bench/results/m9-t03.json
 * $ bun run scripts/bench/run.ts --only=load --out=scripts/bench/results/m3-t06.json
 * $ bun run scripts/bench/run.ts --only=read --out=scripts/bench/results/m9-t01.json
 * $ bun run scripts/bench/run.ts --only=report --out=scripts/bench/results/v8-m10-t07.json
 * ```
 *
 * ## 再現について
 *
 * **データの中身は `--seed` で決まり、既定シードでは実行ごとに同一の DB ができる。**
 * したがって**ディスク量(バイト数)と SQL 発行回数は完全に再現する**。
 * **所要時間は再現しない** —— 同一マシンでも数 % から数十 % ばらつく。
 * よって時間の主張は「桁」と「比」で行い、`samples_ms` を全部残す。
 *
 * **別環境では数値そのものが変わる。** 出力 JSON に `environment` を必ず同梱するのは、
 * 数値を環境から切り離して引用させないためである。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { captureEnvironment } from "./env.ts";
import {
  contentionScenario,
  copyCountScenario,
  crossProcessContentionScenario,
  DEFAULT_SEED,
  journalModeScenario,
  loadWriterScenario,
  mutationScenario,
  readScenario,
  reportScenario,
  snapshotScenario,
  snapshotSizeScenario,
} from "./scenarios.ts";

const SCENARIOS = [
  "snapshot",
  "mutation",
  "copies",
  "journal",
  // --- V1-M9-T03(WAL とスナップショットの相互作用の計測)で追加 ---
  "contention",
  "xproc",
  "snapshot_size",
  // --- V1-M3-T06(負荷試験)で追加 ---
  "load",
  // --- V1-M9-T01(ページネーション判断ゲート: read パスの全件返却コスト)で追加 ---
  "read",
  // --- V8-M10-T07(集計表の性能。台帳 `Q-G34`)で追加 ---
  "report",
] as const;
type ScenarioName = (typeof SCENARIOS)[number];

/** M1-T05 由来のシナリオ。 */
const M1_T05_SCENARIOS: readonly ScenarioName[] = ["snapshot", "mutation", "copies", "journal"];
/** M9-T03 で追加したシナリオ。 */
const M9_T03_SCENARIOS: readonly ScenarioName[] = ["contention", "xproc", "snapshot_size"];
/** M3-T06 で追加したシナリオ。 */
const M3_T06_SCENARIOS: readonly ScenarioName[] = ["load"];
/** M9-T01 判断ゲートで追加したシナリオ。 */
const M9_T01_SCENARIOS: readonly ScenarioName[] = ["read"];
/** V8-M10-T07(集計表の性能)で追加したシナリオ。 */
const V8_M10_T07_SCENARIOS: readonly ScenarioName[] = ["report"];

type Args = {
  only: ScenarioName[];
  reps: number;
  seed: number;
  out: string;
};

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

  const only = get("only");
  const names =
    only === undefined
      ? [...SCENARIOS]
      : only.split(",").map((raw) => {
          const name = raw.trim();
          if (!(SCENARIOS as readonly string[]).includes(name)) {
            throw new Error(`未知のシナリオ "${name}"。使えるのは: ${SCENARIOS.join(" / ")}`);
          }
          return name as ScenarioName;
        });

  const reps = Number(get("reps") ?? 3);
  if (!Number.isInteger(reps) || reps < 1) {
    throw new Error(`--reps は1以上の整数である必要があります(受け取った値: ${get("reps")})`);
  }
  const seed = Number(get("seed") ?? DEFAULT_SEED);
  if (!Number.isInteger(seed)) {
    throw new Error(`--seed は整数である必要があります(受け取った値: ${get("seed")})`);
  }

  return {
    only: names,
    reps,
    seed,
    out: get("out") ?? join(import.meta.dir, "results", "latest.json"),
  };
}

/** 出力の形。**数値は必ずこの形で保存し、記録文書はここから引く。** */
export type BenchOutput = {
  /**
   * どのタスクの計測か。実行したシナリオが属するグループ(M1-T05 / M9-T03 / M3-T06 /
   * M9-T01)を "+" で連結して決める。単独なら "V1-M1-T05" など、混在(既定の全実行など)
   * なら "V1-M1-T05+V1-M9-T03+V1-M3-T06+V1-M9-T01" のように並ぶ。グループが増えるたびに
   * 組合せが増えるので、型は連結後の文字列(グループ名の "+" 連結)とする。
   */
  task: string;
  generated_at: string;
  seed: number;
  reps: number;
  environment: ReturnType<typeof captureEnvironment>;
  /** 実行したシナリオ名。 */
  scenarios: ScenarioName[];
  results: Record<string, unknown>;
  /** 数値の性質についての但し書き(引用時に落とさないため出力にも入れる)。 */
  caveats: string[];
};

const CAVEATS = [
  "すべて実測値である。推定値はこの JSON に入っていない(推定は記録文書 / ADR の側で「推定」と明示して書く)。",
  "ディスク量(バイト)と SQL 発行回数は同一シードで完全に再現する。所要時間は再現しない(同一マシンでもばらつく)。",
  "同時アクセス(複数接続・クロスプロセス)は V1-M9-T03 で contention / xproc シナリオとして測定した(M1-T05 時点の『未測定』は解消済み)。ただし真の並行性は xproc(別プロセスの書き手)でのみ現れる。同一プロセス同一スレッドの contention では書き手がロックを保持したまま解放できないため、busy_timeout を設定しても『その分だけ待って結局 SQLITE_BUSY』になる —— この非対称は記録に明示する。",
  "OS のページキャッシュを制御していない。コールドスタートは遅い方向に外れる。",
  "負荷試験(load)はストレージ層(cross-process の複数書き手)を測る。HTTP/認証オーバーヘッドは加算で天井を変えないため対象外。writer は実サーバの deferred tx + read-then-CAS-update の形状をミラーするが `_auth_activity` の第2書込を省くので観測 BUSY はロックの下限。時間は再現しない・質的判定(busy の有無・会計一致)は決定的。",
  "read シナリオ(V1-M9-T01 判断ゲート)は kernel の read パス(readRecordList / listRecords)+ 結果配列の JSON シリアライズを測る。DOM 描画は web/test/list-render-bench.test.tsx が happy-dom 上で別途計測する。payload_bytes と record_count は同一シードで決定的、時間は桁と比のみ。HTTP はさらに owner-scope の O(N) post-filter を通るため実 HTTP はこれ以上に遅い(list_ms は下限)。",
  "report シナリオ(V8-M10-T07)は集計表を**本物の HTTP**(createServerApp + GET /api/apps/:app_id/views/:view_id/report)で測る。可視性の post-filter は src/kernel/report.ts に1バイトも無く app.ts が注入しているので、カーネルを直に呼ぶと T03/T04 の post-filter を通らないためである。payload_bytes と total_groups は同一行数で決定的(行IDを UUID と同じ36文字で決定的に振っている)、時間は桁と比のみ。DOM 描画は1ミリも測っていない —— ADR-0019:86-:88 の帯の律速はフロント描画であり、集計表の画面は web/ にまだ無い。メモリも同時アクセスも MCP 経路も測っていない。",
  "environment と切り離して数値を引用しないこと。別環境で再現しない可能性がある。",
];

/**
 * 書き出した JSON をリポジトリの biome で整形する。
 *
 * **これが無いと `bun run lint` が赤になる。** `JSON.stringify(_, null, 2)` は配列を
 * 常に展開するが、biome は 100 桁に収まる配列を1行に畳む。結果ファイルはリポジトリに
 * 置く証跡なので、**ベンチを再実行しただけで lint が赤くなる状態を作らない。**
 *
 * biome が見つからない環境でも**ベンチ自体は成功させる**(整形は本質ではない)。
 */
/**
 * 整形器(biome)の在り処。**公開単位(`apps/smailtalk/`)の中だけで解く**(`X-G29`)。
 *
 * `import.meta.dir` は `apps/smailtalk/scripts/bench` である。**2つ上げる**
 * (`bench` → `scripts` → `apps/smailtalk`)。公開単位の外(正本のルート)へは
 * 1度も出ない —— `apps/smailtalk` は `V9-M11-T01` で自分の `package.json` /
 * `bun.lock` を持つ実行口になったので、公開単位を単独で切り出して
 * `bun install` すれば `apps/smailtalk/node_modules/.bin/biome` が実在する。
 *
 * **この開発ツリー(growable_platform 直下)では話が違う**: ルートの
 * `bunfig.toml` が `linker = "hoisted"` を敷いているため、`apps/smailtalk` は
 * workspace member としてビルドされるとき依存が正本のルートの `node_modules`
 * に巻き上がり、`apps/smailtalk/node_modules` 自体が作られない。**したがって
 * この開発ツリーでは今日も整形は動かない。** 直すには公開単位の外(正本のルート)
 * を見に行く経路が要るが、それは `X-G29` が禁じる —— この結合(ルート
 * `bunfig.toml` の `linker` 設定)を切り離すのは `X-G31`(`V9-M12-T01`)の
 * 射程であり、ここでは直さない。**下の `formatWithBiome` は見つからなくても
 * 黙って帰らない** —— stderr に理由を書いてから整形を飛ばす(観測できる形で
 * 止める。「整形は動く」という誤読を残さないため)。
 *
 * **`process.cwd()` を使わない**(裁定2)。どこから走らせても同じ場所を指す。
 */
export function biomeBinPath(): string {
  return join(import.meta.dir, "..", "..", "node_modules", ".bin", "biome");
}

/**
 * `path` を biome で整形する。**在り処が見つからないとき、黙っては帰らない** ——
 * stderr に「見つからなかった/なぜ見つからないか/整形されずに書かれていること」を
 * 書いてから飛ばす。呼び出し元(`main`)はこれでも成功として扱う(整形は本質ではない)。
 * `bench.test.ts` がこの stderr メッセージを実測して固定する(担当外ファイルではなく
 * `X-G29` 対象なので、ここで一緒に直す)。
 */
export function formatWithBiome(path: string): void {
  const biome = biomeBinPath();
  if (!existsSync(biome)) {
    process.stderr.write(
      `[bench] 整形をスキップしました: ${biome} が見つかりません。` +
        "結果 JSON は未整形のまま書かれています(公開単位の外を見に行くのは X-G29 が禁じるため、" +
        "ここでは正本のルートの biome を探しに行けません)。\n",
    );
    return;
  }
  spawnSync(biome, ["format", "--write", path], { stdio: "ignore" });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const results: Record<string, unknown> = {};

  for (const name of args.only) {
    const started = Bun.nanoseconds();
    process.stderr.write(`[bench] ${name} …\n`);
    switch (name) {
      case "snapshot":
        results.snapshot = snapshotScenario(args.reps, args.seed);
        break;
      case "mutation":
        results.mutation = mutationScenario(args.reps, args.seed);
        break;
      case "copies":
        // コピー**回数**は行数に依存しない想定だが、依存しないことを言うために
        // 小さい行数で測る。回数が行数で変わるなら、それ自体が発見である。
        results.copies = {
          rows: 10_000,
          rows_small: 100,
          table: copyCountScenario(10_000, args.seed),
          table_small: copyCountScenario(100, args.seed),
        };
        break;
      case "journal":
        results.journal = journalModeScenario(2_000, args.reps, args.seed);
        break;
      case "contention":
        results.contention = contentionScenario(args.reps, args.seed);
        break;
      case "xproc":
        results.xproc = crossProcessContentionScenario(args.reps, args.seed);
        break;
      case "snapshot_size":
        results.snapshot_size = snapshotSizeScenario(args.reps, args.seed);
        break;
      case "load":
        results.load = await loadWriterScenario(args.reps, args.seed);
        break;
      case "read":
        results.read = readScenario(args.reps, args.seed);
        break;
      case "report":
        // **`--seed` を1つも読まない** —— **この台は乱数を1つも引かない**(行IDまで
        // 決定的に振ってあるので、同じ行数なら応答のバイト数まで再現する)。
        results.report = await reportScenario(args.reps);
        break;
    }
    process.stderr.write(
      `[bench] ${name} 完了 (${((Bun.nanoseconds() - started) / 1e9).toFixed(1)}s)\n`,
    );
  }

  const groups: string[] = [];
  if (args.only.some((s) => M1_T05_SCENARIOS.includes(s))) {
    groups.push("V1-M1-T05");
  }
  if (args.only.some((s) => M9_T03_SCENARIOS.includes(s))) {
    groups.push("V1-M9-T03");
  }
  if (args.only.some((s) => M3_T06_SCENARIOS.includes(s))) {
    groups.push("V1-M3-T06");
  }
  if (args.only.some((s) => M9_T01_SCENARIOS.includes(s))) {
    groups.push("V1-M9-T01");
  }
  if (args.only.some((s) => V8_M10_T07_SCENARIOS.includes(s))) {
    groups.push("V8-M10-T07");
  }
  const task: BenchOutput["task"] = groups.join("+");

  const output: BenchOutput = {
    task,
    generated_at: new Date().toISOString(),
    seed: args.seed,
    reps: args.reps,
    environment: captureEnvironment(import.meta.dir),
    scenarios: args.only,
    results,
    caveats: CAVEATS,
  };

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(output, null, 2)}\n`, "utf-8");
  formatWithBiome(args.out);
  process.stderr.write(`[bench] 結果を ${args.out} に書きました\n`);
}

if (import.meta.main) {
  void main();
}

export { parseArgs };
