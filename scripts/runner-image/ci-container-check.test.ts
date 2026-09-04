/**
 * **「手順が終わらなくなる形」を1つも書けなくする検査**(`V5-M7d-T02`)。
 *
 * ## なぜ要るのか(**実測から来ている**)
 *
 * 2026-08-06 の実 CI(run `31087823324` / sha `1137b2b`)で、
 * `scripts/runner-image/ci-container-check.sh` の手順6 が
 * **19分08秒のあいだ1バイトも出力せずに止まり**、ジョブが 20分の timeout で
 * `cancelled` になった。止まっていたのは
 *
 * ```
 * gate_output="$(docker run --rm -v "${VOLUME_DIR}:/data" "${IMAGE_TAG}" 2>&1 || true)"
 * ```
 *
 * であり、**版のゲートが発火しないとサーバが前面で起き続け、出力は `$( )` に
 * 吸われたまま永久に待つ。** 実測は `docs/plan/v5/records/v5-m7d.md` §1 にある。
 *
 * ## この検査が見ているもの / 見ていないもの(**丸めない**)
 *
 * - **見ているのはシェルスクリプトの本文だけである。** `docker` を1回も呼ばない。
 *   **手順が実際に終わることを1秒も測っていない。** 測るのは CI の `container`
 *   ジョブと、手元で走らせる `bash scripts/runner-image/ci-container-check.sh` である。
 * - **本文の走査であるから、書き方を変えれば通り抜けられる**(たとえば
 *   `docker` をシェル関数で包むなど)。**「二度と起きない」とは書けない。**
 *   書けるのは「今日の書き方で同じ形を書くと赤くなる」までである。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTEXT_DIR_NAME, PRODUCT_ROOT } from "./prepare-context.ts";

const SCRIPT_PATH = join(import.meta.dir, "ci-container-check.sh");
const script = readFileSync(SCRIPT_PATH, "utf8");

/**
 * 検査の対象にする行だけを残す。
 *
 * - `#` で始まる行(コメント)を落とす。**説明文の中の例を検査対象にしない。**
 * - **`echo` / `printf` の行も落とす**(`V5-M7e`)。**人に見せる文字列であって、
 *   実行される命令ではない。** 後片付けが失敗したときに「手で消すにはこう打つ」と
 *   案内する文面に `docker run` の綴りが出るが、**あれは docker を1回も起こさない。**
 */
function codeLines(source: string): string[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== "" &&
        !line.startsWith("#") &&
        !line.startsWith("echo ") &&
        !line.startsWith("printf "),
    );
}

/**
 * **`V9-M3-T01`(群D)。木が `apps/smailtalk/` へ移ったあとの綴りを固定する。**
 *
 * ## なぜ要るのか(**実測から来ている**)
 *
 * `V9-M1` が製品コードを `apps/smailtalk/` へ移し、`V9-M2` が `scripts/` を
 * `apps/smailtalk/scripts/`(161本)と `tools/`(10本)へ割った。
 * **`scripts/` は今日、正本のルート直下に1本も無い。**
 * ところがこのスクリプトは `bun run scripts/runner-image/prepare-context.ts` を
 * そのまま呼んでおり、実 CI の `container` ジョブが `Module not found` で落ちていた
 * (`.github/workflows/ci.yml` は正本のルートを cwd にしてこのスクリプトを走らせる)。
 *
 * ## この検査が見ているもの / 見ていないもの(**丸めない**)
 *
 * - **見ているのはシェルスクリプトの本文と、`prepare-context.ts` が解いたパスだけである。**
 *   **`docker build` が実際に通ることを1秒も測っていない。** 測るのは CI の `container`
 *   ジョブと、手元で走らせる `bash apps/smailtalk/scripts/runner-image/ci-container-check.sh`
 *   である。
 * - **`grep -q "scripts/migrate-volume.ts"` は対象外である** ——
 *   あれは**コンテナの中が出す文言**を照合しており、ホスト側のパスではない
 *   (`Dockerfile` は `scripts/` をイメージに1本も入れず、移行器の案内文だけが出る)。
 */
describe("V9: 正本のルートから走らせる綴りである", () => {
  /** `bun run <path>` の `<path>` を全部拾う(コメント行と echo 行は除く)。 */
  function bunRunTargets(): string[] {
    const targets: string[] = [];
    for (const line of codeLines(script)) {
      const matched = line.match(/\bbun run\s+(\S+)/);
      if (matched?.[1] !== undefined) {
        targets.push(matched[1]);
      }
    }
    return targets;
  }

  test("`bun run` の対象は正本のルートからの相対で綴られ、実在する", () => {
    const targets = bunRunTargets();
    // **1本も無い状態を緑にしない。** 走査対象が消えたことに気づけなくなる。
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target.startsWith("apps/smailtalk/scripts/")).toBe(true);
      // **`PRODUCT_ROOT`(公開単位の根)を起点に確かめる。** `join(PRODUCT_ROOT, "..", target)`
      // のように `..` を足して正本のルートへ出ることはしない(`X-G29`。このテスト自身も
      // `apps/smailtalk` の中のコードである)。代わりに `target` の `apps/smailtalk/` 接頭辞を
      // 剥がしてから `PRODUCT_ROOT` に足す —— モノレポでは `PRODUCT_ROOT` が
      // `apps/smailtalk` なので、剥がした残りがそのまま実在する。**切り出した木**
      // (`apps/smailtalk/` を単独の器として配ったもの)でも `PRODUCT_ROOT` は木の根そのもの
      // であり、同じ剥がし方で実在を確かめられる。
      const withinProductRoot = target.slice("apps/smailtalk/".length);
      expect(existsSync(join(PRODUCT_ROOT, withinProductRoot))).toBe(true);
    }
  });

  test("`docker build` は Dockerfile を -f で名指しし、context は公開単位の根である", () => {
    const builds = codeLines(script).filter((line) => line.includes("docker build"));
    expect(builds.length).toBe(1);
    const build = builds[0] ?? "";
    expect(build).toContain("-f apps/smailtalk/Dockerfile");
    // **`X-G33`(`V9-M12-T03`)で context が公開単位の根に移った。**
    // 末尾は `.`(正本のルート)ではなく `apps/smailtalk` である ——
    // `Dockerfile` の `COPY` のソースは全部 `apps/smailtalk/` を根とする相対になり、
    // `COPY data-runner-image/data` も `prepare-context.ts` の**既定の**書き込み先
    // (`<公開単位の根>/data-runner-image`)に当たる。
    // **`-f` の綴りだけが正本のルートからの相対のままである** —— このスクリプトを
    // 走らせる cwd は今日も正本のルートだからである(`.github/workflows/ci.yml`)。
    expect(build.trimEnd().endsWith(" apps/smailtalk")).toBe(true);
    expect(build.trimEnd().endsWith(" .")).toBe(false);
    // 上のテストと同じ理由で、`PRODUCT_ROOT` から `apps/smailtalk/` を剥がした残りで確かめる。
    expect(existsSync(join(PRODUCT_ROOT, "Dockerfile"))).toBe(true);
  });

  test("`prepare-context.ts` に `--context-root` を渡さない(既定の書き込み先を使う)", () => {
    // **`V9-M11-T03` は `--context-root data-runner-image` を渡して、書き込み先を
    // 正本のルート直下へ戻していた**(当時の context が正本のルートだったため)。
    // **`X-G33` で context が公開単位の根に移ったので、この上書きは不要になり、
    // 渡すと `Dockerfile:COPY data-runner-image/data` が見つけられなくなる。**
    //
    // **見ているのは本文の綴りだけである。** `prepare-context.ts` が実際にどこへ
    // 書くかは1バイトも測っていない(それを測るのは同ファイルの `PRODUCT_ROOT` の検査)。
    const contextRootFlags = codeLines(script).filter((line) => line.includes("--context-root"));
    expect(contextRootFlags).toEqual([]);
  });

  test("コンテナの中の文言を照合する `scripts/migrate-volume.ts` は書き換えない", () => {
    // **ホスト側のパスではない。** イメージの中の案内文であり、`apps/` を付けると
    // 「移行コマンドが出なかった」で必ず落ちる。
    expect(script).toContain('grep -q "scripts/migrate-volume.ts"');
  });
});

describe("V9: prepare-context の出力先は公開単位の根の直下である", () => {
  test("PRODUCT_ROOT は公開単位の根を指し、正本のルートへは出ない", () => {
    // **この検査はかつて逆(`REPO_ROOT が正本のルートを指す(apps/smailtalk ではない)`)
    // を求めていた。** それは本タスク(`X-G29`。公開単位の中のコードが自分より上の
    // 階層を1度も解決しないこと)が禁じる形そのものだったので、測る対象を入れ替えた。
    //
    // 公開単位の根には Dockerfile と package.json が直下に在る
    // (モノレポでも、切り出して単独の器にした木でも共通)。
    expect(existsSync(join(PRODUCT_ROOT, "Dockerfile"))).toBe(true);
    expect(existsSync(join(PRODUCT_ROOT, "package.json"))).toBe(true);
    // **正本のルートまで出ていないこと。** モノレポで正本のルートまで出ていたら、
    // そこにはもう1段下として apps/smailtalk が在るはずである
    // (旧い4段上げの `REPO_ROOT` はここが真になっていた)。
    expect(existsSync(join(PRODUCT_ROOT, "apps", "smailtalk"))).toBe(false);
  });

  test("既定の出力先は <公開単位の根>/data-runner-image である", () => {
    expect(join(PRODUCT_ROOT, CONTEXT_DIR_NAME)).toBe(
      join(import.meta.dir, "..", "..", CONTEXT_DIR_NAME),
    );
  });
});

describe("ci-container-check.sh は前面実行の docker run を1つも持たない", () => {
  test("`docker run` はすべて `-d`(切り離し)である", () => {
    const runs = codeLines(script).filter((line) => line.includes("docker run"));
    // **1本も無い状態を緑にしない。** 走査対象が消えたことに気づけなくなる。
    expect(runs.length).toBeGreaterThan(0);
    for (const line of runs) {
      expect(line).toContain("docker run -d");
    }
  });

  test("`$( docker run ... )` で前面実行の出力を吸い込む形が1つも無い", () => {
    // これが 19分の無出力を作った形である。**待っている間、1バイトも出ない。**
    //
    // **`$(docker run -d ...)` は別である** —— `-d` は「起こした」と言って
    // すぐ帰り、コンテナIDを1行返すだけで、待ちを1秒も持たない。
    // 締切を見張るのは `run_with_deadline` の仕事である。
    for (const line of codeLines(script)) {
      const captured = line.match(/\$\(\s*docker run\s+(\S+)/);
      if (captured !== null) {
        expect(captured[1]).toBe("-d");
      }
    }
  });

  test("`docker run` の失敗を `|| true` で握り潰す形が1つも無い", () => {
    for (const line of codeLines(script)) {
      if (line.includes("docker run")) {
        expect(line).not.toContain("|| true");
      }
    }
  });

  test("締切を見張る器が在り、超えたらコンテナのログを出して落ちる", () => {
    expect(script).toContain("run_with_deadline()");
    expect(script).toContain("秒たっても終わらなかった");
    expect(script).toContain("docker logs");
    // 締切を超えたときに**コンテナごと**始末する(CLI を殺すだけでは走り続ける)。
    expect(script).toContain("docker rm -f");
  });
});

describe("印の書き換えは、効いたことを読み戻してから先へ進む", () => {
  test("4242 を期待して読み戻し、違えば止まる", () => {
    expect(script).toContain('!= "4242"');
    expect(script).toContain("stamped");
    expect(script).toContain("印の書き換えが効いていない");
  });

  test("読み戻しは書いたのとは別のコンテナで行う(同じ接続で読まない)", () => {
    const readBack = script.indexOf("書き換えた印を読み戻す");
    const stamp = script.indexOf("ボリュームの印を 4242 に書き換える");
    expect(stamp).toBeGreaterThan(0);
    expect(readBack).toBeGreaterThan(stamp);
  });

  test("印を書くのはコンテナの中であって、ホスト側の bun ではない", () => {
    // **Linux ではボリュームの中身はコンテナの root 所有になり、
    // CI の実行ユーザは書けない**(V5-M7d §1)。ホスト側の `bun -e` で書かない。
    const hostBunStamp = codeLines(script).filter(
      (line) => line.startsWith("bun -e") || line.startsWith("mise exec -- bun -e"),
    );
    expect(hostBunStamp).toEqual([]);
  });
});

/**
 * **後片付けの形を固定する**(`V5-M7e`)。
 *
 * 実 CI(run `31092586131` / sha `f69c03c`)で、**検査が全部通ったあとに
 * `cleanup` の `rm -rf` だけが `Permission denied` で落ち、ジョブが赤くなった。**
 * **ホストの実行ユーザは、コンテナの root が作ったファイルを消せない。**
 *
 * **`set -e` の下では `trap` の中の失敗がそのまま終了コード 1 になる**(手元で実測)。
 * **本体の結果が後片付けの都合で上書きされないことを、ここで固定する。**
 */
describe("後片付けは、本体の結果を書き換えない", () => {
  /** `cleanup()` の本文を取り出す。 */
  function cleanupBody(): string {
    const start = script.indexOf("cleanup() {");
    expect(start).toBeGreaterThan(0);
    const end = script.indexOf("\ntrap cleanup EXIT", start);
    expect(end).toBeGreaterThan(start);
    return script.slice(start, end);
  }

  test("本体の終了コードを冒頭で捕まえ、最後にその値で終わる", () => {
    const body = cleanupBody();
    // **`local status=$?` より前に、終了コードを壊す命令を置かない。**
    const lines = body.split("\n").map((line) => line.trim());
    const firstReal = lines.findIndex(
      (line) => line !== "" && !line.startsWith("#") && line !== "cleanup() {",
    );
    expect(lines[firstReal]).toBe("local status=$?");
    expect(body).toMatch(/exit "\$\{status\}"/);
  });

  test("後片付けの中に、set -e を発火させる裸の失敗しうる命令が無い", () => {
    // `rm -rf "${VOLUME_DIR}"` を裸で置くと、**Linux では必ず 1 で終わる。**
    const bare = cleanupBody()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("rm -rf") || line.startsWith("docker rm -f "));
    expect(bare).toEqual([]);
  });

  test("ボリュームの中身は、コンテナの中(root)から消す", () => {
    const body = cleanupBody();
    expect(body).toContain("--entrypoint /bin/sh");
    expect(body).toContain("rm -rf /data/");
  });

  test("消せなかったら、後片付けの失敗だと分かる形で報告する(黙って緑にしない)", () => {
    const body = cleanupBody();
    expect(body).toContain("[後片付け] 一時ディレクトリを消せなかった");
    expect(body).toContain("検査の結果ではない");
  });
});
