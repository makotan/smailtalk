/**
 * **リッスンアドレスの既定が今日も `127.0.0.1` であることの検査**(`V5-M7-T01`)と、
 * **`ST_BIND_HOST` が効くのは実行専用プロファイルのときだけであることの検査**
 * (`V5-M7c` / `ADR-0286` 限定3 の是正)。
 *
 * ## なぜ要るのか
 *
 * `V5-M7` が `src/server/index.ts` に環境変数 `ST_BIND_HOST` を1本足した。
 * **コンテナの中で `0.0.0.0` に束ねないと、`docker run -p` で外から到達できない**
 * ためである(理由は `src/server/index.ts` の `BIND_HOST_ENV` の doc)。
 *
 * **足したことで弱まったのは「機構として不可能」という性質である。**
 * **弱めていないのは既定値である** —— `ADR-0003` §8 逐語「リッスンアドレスは**既定で**
 * `127.0.0.1` に固定する」。**本ファイルはその既定を実プロセスで固定する。**
 *
 * **`V5-M7c` が足したのは、`ADR-0286` 限定3 の実プロセス検査である** —— 逐語
 * 「**効くのは実行専用プロファイル(`ST_SERVER_PROFILE=runner`)で起動したときだけである。**
 * **`full`(既定)では `ST_BIND_HOST` を読まず、必ず `127.0.0.1` に束ねる**」。
 *
 * ## この検査が言えないこと(**丸めない**)
 *
 * - **「外に公開されない」ことは1ミリも示していない。**
 *   **`ST_SERVER_PROFILE=runner ST_BIND_HOST=0.0.0.0` の2本を渡せば今日も LAN に開く。**
 *   **`V5-M7c` が狭めたのは「何が開くか」であって「開けられるか」ではない**
 *   (`ADR-0286` S3-2 逐語)。
 * - **LAN の別の機械から実際に到達できることを1度も測っていない。** 読んでいるのは
 *   **起動ログの綴り**だけである(`Bun.serve` が報告した `server.hostname`)。
 * - **コンテナの中身を1バイトも見ていない**(それは `scripts/runner-image/` の担当)。
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO_ROOT = dirname(dirname(import.meta.dir));
const ENTRY = join(REPO_ROOT, "src", "server", "index.ts");
/** 起動完了の行(`src/server/index.ts` の末尾の `console.log`)。 */
const LISTENING = "smailtalk server:";

type Started = { stdout: string; stderr: string };

/**
 * 起動して1行目のリッスンログを読む。`PORT=0` で OS に空きポートを選ばせる。
 *
 * **`stderr` も持ち帰る** —— `full` で `ST_BIND_HOST` を渡したときに「読まなかった」と
 * 1行書くこと(黙って無視しないこと。憲法6)を検査するため。
 */
async function listenLine(extraEnv: Record<string, string>): Promise<Started> {
  const dataRoot = mkdtempSync(join(tmpdir(), "gp-bind-host-"));
  try {
    const proc = Bun.spawn({
      cmd: ["bun", "run", ENTRY],
      cwd: REPO_ROOT,
      // **親プロセスに残っている値を必ず上書きする。** `ST_SERVER_PROFILE` を明示しないと、
      // 走らせた人の環境次第で検査対象のプロファイルが変わる(何も検査していないことになる)。
      env: {
        ...process.env,
        ST_DATA_ROOT: dataRoot,
        PORT: "0",
        ST_SERVER_PROFILE: "",
        ST_BIND_HOST: "",
        ...extraEnv,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let stdout = "";
    const deadline = Date.now() + 20_000;
    try {
      while (Date.now() < deadline && !stdout.includes(LISTENING)) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        stdout += decoder.decode(value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
    proc.kill();
    await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    return { stdout, stderr };
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

test("ST_BIND_HOST を与えない起動は 127.0.0.1 に束ねる(ADR-0003 §8 の既定)", async () => {
  // **環境から明示的に外す。** 親プロセスに残っていると何も検査していないことになる。
  const { stdout } = await listenLine({ ST_BIND_HOST: "" });
  expect(stdout).toContain(`${LISTENING} http://127.0.0.1:`);
}, 30_000);

test("(b) ST_SERVER_PROFILE=runner のとき ST_BIND_HOST がその値に束ねる(コンテナで 0.0.0.0 に開くための口)", async () => {
  const { stdout } = await listenLine({ ST_SERVER_PROFILE: "runner", ST_BIND_HOST: "0.0.0.0" });
  expect(stdout).toContain(`${LISTENING} http://0.0.0.0:`);
}, 30_000);

test("(a) ST_SERVER_PROFILE を与えない起動では ST_BIND_HOST=0.0.0.0 を渡しても 127.0.0.1 に束ねる(ADR-0286 限定3)", async () => {
  const { stdout } = await listenLine({ ST_SERVER_PROFILE: "", ST_BIND_HOST: "0.0.0.0" });
  expect(stdout).toContain(`${LISTENING} http://127.0.0.1:`);
  expect(stdout).not.toContain(`${LISTENING} http://0.0.0.0:`);
}, 30_000);

test("(a') ST_SERVER_PROFILE=full を明示しても ST_BIND_HOST=0.0.0.0 は読まれない(ADR-0286 限定3)", async () => {
  const { stdout } = await listenLine({ ST_SERVER_PROFILE: "full", ST_BIND_HOST: "0.0.0.0" });
  expect(stdout).toContain(`${LISTENING} http://127.0.0.1:`);
  expect(stdout).not.toContain(`${LISTENING} http://0.0.0.0:`);
}, 30_000);

test("full で ST_BIND_HOST を渡したら、読まなかったことを stderr に書く(黙って無視しない。憲法6)", async () => {
  const { stderr } = await listenLine({ ST_SERVER_PROFILE: "full", ST_BIND_HOST: "0.0.0.0" });
  expect(stderr).toContain("ST_BIND_HOST");
  expect(stderr).toContain("ST_SERVER_PROFILE");
  expect(stderr).toContain("127.0.0.1");
}, 30_000);

test("runner でも ST_BIND_HOST を与えなければ 127.0.0.1 に束ねる(既定はプロファイルで変わらない)", async () => {
  const { stdout } = await listenLine({ ST_SERVER_PROFILE: "runner", ST_BIND_HOST: "" });
  expect(stdout).toContain(`${LISTENING} http://127.0.0.1:`);
}, 30_000);
