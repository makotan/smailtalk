import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * 差分パッチのスキーマは、**差分を初めて検証するときに1回だけ**組み立てる。
 *
 * ## なぜ見張るのか
 *
 * `validate.ts` を読み込むだけで差分のスキーマまで組み立てると、差分を1本も検証しない処理
 * (生成器の `src/cli.ts` は `smailtalk` を読み込むが、マニフェストしか検証しない)の起動が毎回その分だけ重くなる。
 * 手元の実測で生成器の1回の実行 約230ms のうち約47ms がこの組み立てだった。生成器の検査は1ファイルで
 * 生成器を12回起こすものがあり、実CI でその準備が既定の打ち切り5秒の手前(4.97秒)まで来ていた。
 *
 * ## 何を測るか(台の速さに依らない)
 *
 * 時間は測らない。**組み立てが呼ばれた回数と相手**を別プロセスで数える
 * (同じプロセスでは他の検査ファイルが先に読み込んでいて、読み込みの瞬間を捉えられない)。
 * 数えるのは ajv の `_compileSchemaEnv`(`compile` と `getSchema` の両方が通る1か所)である。
 * ajv の版が上がってこの名前が消えると、読み込み時のマニフェストの組み立ても数えられなくなり、
 * 1本目の `toContain(MANIFEST_ID)` が赤くなる(数え口が黙って空になって緑になることはない)。
 * - 読み込んだだけでは、差分のスキーマを組み立てない(マニフェストのスキーマは今までどおり読み込み時に組み立てる)。
 * - `validateDiff` を初めて呼んだときに1回組み立て、2回目以降は組み立てない。
 * - 組み立てを遅らせても、検証の答え(通る / 拒否の件数)は読み込み時に組み立てたときと同じである。
 */

const kernelDir = import.meta.dir;
const appDir = join(kernelDir, "..", "..");

const probe = `
import Ajv2020 from "ajv/dist/2020";
const compiled = [];
const original = Ajv2020.prototype._compileSchemaEnv;
Ajv2020.prototype._compileSchemaEnv = function (env) {
  compiled.push(String(env?.schema?.$id ?? "(no $id)"));
  return original.call(this, env);
};
const mod = await import(${JSON.stringify(join(kernelDir, "validate.ts"))});
const afterImport = [...compiled];
const bad = mod.validateDiff({ diff_id: "x" });
const afterFirst = [...compiled];
const good = mod.validateDiff({ diff_id: "d-1", intent: "t", operations: [{ op: "add_table", table: { id: "books", name: "本", fields: [{ id: "title", name: "題", type: "text" }] } }] });
const afterSecond = [...compiled];
console.log(JSON.stringify({ afterImport, afterFirst, afterSecond, bad: { valid: bad.valid, n: bad.valid ? 0 : bad.errors.length }, good: { valid: good.valid } }));
`;

type ProbeResult = {
  afterImport: string[];
  afterFirst: string[];
  afterSecond: string[];
  bad: { valid: boolean; n: number };
  good: { valid: boolean };
};

function runProbe(): ProbeResult {
  const result = Bun.spawnSync([process.execPath, "-e", probe], {
    cwd: appDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`探りのプロセスが失敗しました: ${result.stderr.toString()}`);
  }
  const lines = result.stdout.toString().trim().split("\n");
  return JSON.parse(lines[lines.length - 1] ?? "") as ProbeResult;
}

const MANIFEST_ID = "https://smailtalk.dev/schemas/manifest.schema.json";
const DIFF_ID = "https://smailtalk.dev/schemas/diff.schema.json";

describe("差分のスキーマは初めて差分を検証するときに組み立てる", () => {
  const observed = runProbe();

  test("読み込んだだけでは、差分のスキーマを組み立てない(マニフェストは組み立てる)", () => {
    expect(observed.afterImport).toContain(MANIFEST_ID);
    expect(observed.afterImport).not.toContain(DIFF_ID);
  });

  test("validateDiff を初めて呼ぶと1回だけ組み立て、2回目は組み立てない", () => {
    expect(observed.afterFirst.filter((id) => id === DIFF_ID)).toHaveLength(1);
    expect(observed.afterSecond.filter((id) => id === DIFF_ID)).toHaveLength(1);
  });

  test("遅らせても答えは変わらない(壊れた差分は拒否・表を1枚足す差分は通る)", () => {
    expect(observed.bad.valid).toBe(false);
    expect(observed.bad.n).toBeGreaterThan(0);
    expect(observed.good.valid).toBe(true);
  });
});
