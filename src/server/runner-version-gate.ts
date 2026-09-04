/**
 * 起動時の版の照合(`V5-M5-T03` / `V5-M5-T04` / `R-G2` / `R-G3` / `R-G7` /
 * [`ADR-0251`](../../docs/adr/0251-runner-build-version.md))。
 *
 * ## 何をするか
 *
 * データルートにある **`kernel.sqlite` と、各アプリの `app.sqlite`** の
 * `PRAGMA user_version` を読み、**`RUNNER_BUILD_VERSION` と等しくないものが1本でも
 * あれば終了コード1で止める。** 止めるときは、**何が合わなかったか**と
 * **次に打つべきコマンド**(`D-V5-14`)を標準エラーに出す。
 *
 * ## 迂回口を1つも持たない(`ADR-0251` 限定5)
 *
 * **打ち消しの引数も、無効化の環境変数も、「警告だけ出して続行」も1つも解釈しない。**
 * 引数として読むのはデータルートのパス1つだけである。
 * `runner-version-gate.test.ts` が、それらしい名前の環境変数を4本渡しても止まることと、
 * 本ファイルのコードにその種の語が1つも現れないことを固定している。
 *
 * ## `kernel.sqlite` と `app.sqlite` は同じ照合関数を通る(`ADR-0251` 限定7)
 *
 * **2つ目の仕組みを作らない**(`D-V5-17`)。`matchesRunnerBuildVersion` の呼び出しは
 * 本ファイルに**1箇所だけ**であり、両方がそこを通る(検査が呼び出し箇所の数を固定する)。
 * **`src/kernel/meta-store.ts` の `migrateChangelogColumns`(遅延 `ALTER`)には
 * 1バイトも触っていない。** 遅延 `ALTER` と版の照合は今日**同居する。**
 *
 * ## 【重要】版が合っていて中身が違うボリュームは素通りする(`ADR-0251` 限定8)
 *
 * **スキーマの照合を1バイトも行わない**(`D-V5-15`)。`docs/plan/v5/records/v5-m0.md` §1-2 が
 * 実測した4経路 —— **読み取り 200(存在しない列が全行 `null`)/ 絞り込み 200(0件)/
 * 並べ替え 200 / 書き込み 500** —— は、ここを通っても1つも直らない。
 * **「スキーマのズレを検出できる」とは書けない。**
 *
 * ## 【重要】`kernel.sqlite` は全アプリ共有である(`ADR-0251` §1 の (e))
 *
 * `kernel.sqlite` の版が1本合わないだけで、**版の合っているアプリを含めて全部が止まる。**
 * 検査 `(e) kernel.sqlite の版が1つ合わないだけで…` がそれを実測として固定している。
 *
 * ## どこから呼ばれるか(**限界を先に書く**)
 *
 * **`src/server/index.ts` が、起動プロファイルが `runner`(`V5-M3-T02`)のときにだけ呼ぶ。**
 * **`full`(既定)では呼ばない** —— 呼ぶと今日の開発環境(`user_version = 0` の DB が
 * 34本)が二度と起動しなくなるためである(`ADR-0251` §6 の 3 により、印の無い DB の
 * 救済には門A を新規に通す必要がある)。**判断と選ばなかった案5件は
 * `docs/plan/v5/records/v5-m5.md` §3 にある。**
 *
 * **【正直に書く】`ST_SERVER_PROFILE` を `full` にすればこのゲートは走らない。**
 * **ただしそのとき動いているのは編集系5ルートを登録したサーバであり、配布物ではない。**
 * **「版の不一致では必ず止まる」とは書けない。**
 *
 * ## 使い方
 *
 * ```
 * mise exec -- bun run src/server/runner-version-gate.ts <dataRoot>
 * ```
 *
 * ## `src/kernel/` を1本も import しない
 *
 * `scripts/kernel-import-drift.test.ts` の走査対象に `src/server/` が入っており、
 * `storage-paths.ts` の関数を値 import すると `kernel-import-snapshot.txt` が動く
 * (`ADR-0009` 限定2 の審査対象になる)。**したがってレイアウト(`ADR-0002`)は
 * `src/kernel/storage-paths.ts` と同一の形を手で書いている。**
 * **これは重複であり、レイアウトが変わったとき自動では追随しない**(記録 §8)。
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { matchesRunnerBuildVersion, RUNNER_BUILD_VERSION } from "../shared/runner-build-version.ts";

/** 1本の DB について読み取った版。 */
export type VolumeDbVersion = {
  /** 記録と出力に使う短い名前(`kernel.sqlite` / `apps/<app_id>/app.sqlite`)。 */
  label: string;
  /** 実ファイルのパス。 */
  path: string;
  /** `PRAGMA user_version` の値。印が無ければ 0。 */
  user_version: number;
};

/** ゲートの判定結果。 */
export type RunnerVersionGateResult = {
  /** 版が合わない DB が1本も無いか。 */
  ok: boolean;
  /** 見た DB の全量。 */
  checked: VolumeDbVersion[];
  /** 版が合わなかった DB。 */
  mismatched: VolumeDbVersion[];
};

/** `PRAGMA user_version` を読む。読めなければ例外(黙って通さない)。 */
function readUserVersion(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  } finally {
    db.close();
  }
}

/**
 * データルートにある「起動に使われる DB」を全部集める。
 *
 * **`apps/<app_id>/snapshots/` の中の `app.sqlite` は数えない** —— あれは過去の姿の
 * 控えであって、起動して読み書きするファイルではない。
 */
export function collectVolumeDbVersions(dataRoot: string): VolumeDbVersion[] {
  const found: VolumeDbVersion[] = [];

  const kernelPath = join(dataRoot, "kernel.sqlite");
  if (existsSync(kernelPath)) {
    found.push({
      label: "kernel.sqlite",
      path: kernelPath,
      user_version: readUserVersion(kernelPath),
    });
  }

  const appsRoot = join(dataRoot, "apps");
  if (existsSync(appsRoot) && statSync(appsRoot).isDirectory()) {
    for (const appId of readdirSync(appsRoot).sort()) {
      const appDbPath = join(appsRoot, appId, "app.sqlite");
      if (existsSync(appDbPath)) {
        found.push({
          label: `apps/${appId}/app.sqlite`,
          path: appDbPath,
          user_version: readUserVersion(appDbPath),
        });
      }
    }
  }

  return found;
}

/**
 * データルートの版を照合する。
 *
 * **`kernel.sqlite` も `app.sqlite` も、下の1行だけを通る**(`ADR-0251` 限定7)。
 */
export function checkRunnerVersionGate(dataRoot: string): RunnerVersionGateResult {
  const checked = collectVolumeDbVersions(dataRoot);
  const mismatched = checked.filter((db) => !matchesRunnerBuildVersion(db.user_version));
  return { ok: mismatched.length === 0, checked, mismatched };
}

/**
 * 止めた理由と、次に打つべきコマンドを組み立てる(`D-V5-14`)。
 *
 * **【`V5-M6` が実体を作ったので暫定ではなくなった】** **`V5-M5` の時点では移行器が
 * 1バイトも存在せず、この文面は「暫定 —— 今日この経路は存在しない」と断っていた**
 * (`docs/plan/v5/records/v5-m5.md` §1-6 / §7 の 2 が `V5-M6` へ申し送った)。
 * **`V5-M6` が `scripts/migrate-volume.ts` を作り、`ADR-0252` の限定の下で
 * ここが指す先を実体に合わせた。** **引数は2つである**(ボリュームとイメージの `data/`)——
 * **移行先の定義はイメージ側の `apps/<app_id>/manifest.json` である。**
 *
 * **`user_version = 0` のボリュームは、移行器が出来た今日も救済されない**
 * (`ADR-0251` 限定6 / §6 の 3 —— 救済するには門A を新規に通す必要がある)。
 * **`scripts/migrate-volume.ts` は印の無いボリュームを1バイトも触らずに拒否する。**
 * **その事実を文面に書く。** 黙って「移行してください」とだけ言うと、
 * 打っても直らないコマンドを打たせることになる(憲法6)。
 */
export function formatGateFailure(result: RunnerVersionGateResult): string {
  const lines: string[] = [];
  lines.push("[smailtalk runner] 版が合わないため起動を中止します。");
  lines.push(`  Runner のイメージの版: ${RUNNER_BUILD_VERSION}`);
  lines.push("  版が合わなかったボリューム:");
  for (const db of result.mismatched) {
    lines.push(`    - ${db.label}: user_version = ${db.user_version}  (${db.path})`);
  }
  const unstamped = result.mismatched.filter((db) => db.user_version === 0);
  lines.push("  次に打つべきコマンド(移行器の実体は V5-M6 / ADR-0252 が作った):");
  lines.push("    mise exec -- bun run scripts/migrate-volume.ts <dataRoot> <イメージのdata>");
  if (unstamped.length > 0) {
    lines.push(
      `  なお user_version = 0 の ${unstamped.length} 本は「印の無いボリューム」であり、` +
        "移行器はこれを1バイトも触らずに拒否する(ADR-0251 限定6 / §6 の 3)。" +
        "上のコマンドを打っても直らない。",
    );
  }
  lines.push(
    "  ここで照合したのは版だけである。版が合っていて中身が違うボリュームは素通りする(ADR-0251 限定8)。",
  );
  return lines.join("\n");
}

if (import.meta.main) {
  const dataRoot = process.argv[2] ?? "data";
  const result = checkRunnerVersionGate(dataRoot);
  if (!result.ok) {
    console.error(formatGateFailure(result));
    process.exit(1);
  }
  console.log(
    `[smailtalk runner] 版の照合を通過しました(版=${RUNNER_BUILD_VERSION} / ` +
      `照合した DB=${result.checked.length}本 / dataRoot=${dataRoot})。`,
  );
}
