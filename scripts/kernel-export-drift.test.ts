/**
 * Δ8 の機械検査(V1-M1-T02。判断は `docs/plan/v1/records/v1-m1-t01.md` §3-1)。
 *
 * ADR-0007 §1b の Δ8 は「**`src/kernel/` の公開エクスポート(関数・型)が増える**」を
 * 門A の発火条件にしている。改訂2 が判定範囲を確定させた:
 *
 * > **`src/kernel/` 配下のファイル(`*.test.ts` を除く)に `export` が1つ増えたら
 * > Δ8 が発火する。** `index.ts` から re-export しているかどうかは問わない。
 *
 * **しかしこの発火を検出する仕組みは無かった。** Δ8 の混入は `bun test` にも `tsc` にも
 * 出ず(`records/v1-m0-gate-followup.md` §5-1)、M0 では実際に見逃されている
 * (V1-M0-T03 が3本足して門B で通した)。ここがその機械化である。
 *
 * ## 基準を「件数」にしない(T01 §3-1 の判断)
 *
 * 記録に残る export 総数は **129 と 127 で食い違っており、原因は特定できていない**。
 * 件数を基準にすると、**基準そのものが検証不能な数値**になる。加えて件数は
 * 「1本消して1本足す」を素通りさせる。
 *
 * **【2026-07-20 追記】原因は特定された。上の一文は判断時点の記述として残す ――
 * 根拠が後から解明されても、判断そのものは変わらないからである。** ずれ2件の内訳は
 * (1) `fd99bc5` が `snapshot.ts` の `TakeSnapshotOptions` を実際に削除した(記録は
 * 誤っていたのではなく**古くなっていた**) (2) `ajv-error-adapter.ts` に生の NUL バイトが
 * 1個あり、`grep` がこのファイルを丸ごと飛ばして `toValidationErrors` を数え落として
 * いた(**計数の道具が壊れていた**)。真値は記録時点129 / HEAD 128。
 *
 * **判明したことは、この設計判断を覆すのではなく裏書きする。** ずれの一方は陳腐化、
 * 他方は道具の欠陥だが、**件数を基準にする方式ではどちらも「数が合わない」としか
 * 出ず、区別できない。** 識別子集合なら両方とも名指しで出る。
 * 経緯は `docs/plan/v1/records/v1-m1-cleanup.md` §2 / `v1-m1-t01.md` §3-1 の追記。
 *
 * そこで基準は **識別子の一覧**(`kernel-export-snapshot.txt`)とし、検査は
 * 実際の export 集合とスナップショットを照合して、**増えた識別子と減った識別子を
 * 名指しで**赤にする。スナップショットは検査自身が生成するので、
 * 「基準が検証不能な数値である」という状態が構造的に消える。
 *
 * ## 赤くなったら何をするか
 *
 * **スナップショットを更新する前に、増えた識別子が ADR-0007 の門A を通ったかを審査する。**
 * この検査が機械化したのは**検出**であって**審査ではない**。
 *
 * ## この検査の限界(先に書く。憲法6)
 *
 * 1. **スナップショットの更新は人間が行う。** 「赤くなったので更新した」だけで通せる。
 *    これは `write-tools-drift.test.ts` にも既にある穴であり、本検査が新しく作る穴ではない。
 *    塞ぐ手段は無い(ADR-0007 §限界9 —— 実施主体が定まっていない)。
 * 2. **値の export は `Bun.Transpiler.scan()` が返す集合をそのまま使う**(`export { x }` の
 *    形も拾う。T01 §3-1 が「`grep` に依存すると `export { x }` を1行足した日に静かに
 *    素通りする」と名指しした穴を、ここで塞いでいる)。**一方 `export type` /
 *    `export interface` は transpiler が型を消すので scan では拾えず、宣言形の走査で
 *    補っている。** したがって型側は宣言形に依存しており、値側と同じ強度ではない。
 * 3. **検出するのは「増えたこと」だけで、「門A を通ったか」は判定しない。**
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const KERNEL_DIR = join(dirname(import.meta.dir), "src", "kernel");
const SNAPSHOT_PATH = join(import.meta.dir, "kernel-export-snapshot.txt");

/**
 * 検査対象のファイル。
 *
 * `*.test.ts` は ADR-0007 §1b の判定手順が明示的に除いている。
 * **`index.ts` も除く** —— あそこにあるのは他ファイルの re-export だけであり、
 * 数えると同じ識別子を二重に数えることになる。Δ8 は「`src/kernel/` に export が
 * 増えたか」を見るものであって、「`index.ts` から見えるか」ではない(改訂2)。
 */
function targetFiles(): string[] {
  return readdirSync(KERNEL_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "index.ts")
    .sort();
}

/** `export type X` / `export interface X` / `export type { A, B }` を拾う。 */
const TYPE_EXPORT_RE = /^export\s+(?:type|interface)\s+(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))/gm;

/**
 * 1ファイルの公開エクスポート識別子を集める。
 *
 * 値は `Bun.Transpiler.scan()`(構文解析)で、型は宣言形の走査で拾う。
 * scan は `export { x }` も `export default` も拾うので、**宣言の書き方に依存しない**。
 */
function exportsOf(source: string): string[] {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const names = new Set<string>(transpiler.scan(source).exports);

  TYPE_EXPORT_RE.lastIndex = 0;
  for (const match of source.matchAll(TYPE_EXPORT_RE)) {
    const braced = match[1];
    const single = match[2];
    if (single !== undefined) {
      names.add(single);
    } else if (braced !== undefined) {
      for (const part of braced.split(",")) {
        // `A as B` は外から見える名前(B)を採る。
        const name = part
          .trim()
          .split(/\s+as\s+/)
          .at(-1)
          ?.trim();
        if (name !== undefined && name !== "") {
          names.add(name);
        }
      }
    }
  }
  return [...names];
}

/** `<ファイル名>:<識別子>` の一覧(ソート済み)。どのファイルで増えたかまで見えるようにする。 */
function collectExports(): string[] {
  const entries: string[] = [];
  for (const file of targetFiles()) {
    const source = readFileSync(join(KERNEL_DIR, file), "utf-8");
    for (const name of exportsOf(source)) {
      entries.push(`${file}:${name}`);
    }
  }
  return entries.sort();
}

function readSnapshot(): string[] {
  return readFileSync(SNAPSHOT_PATH, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

test("Δ8: src/kernel/ の公開エクスポートがスナップショットと一致する", () => {
  const actual = collectExports();
  const expected = readSnapshot();

  const added = actual.filter((name) => !expected.includes(name));
  const removed = expected.filter((name) => !actual.includes(name));

  // 増減を**名指しで**出す。差分を目で探す作業を残さないのがこの検査の要点である。
  // 赤くなったら、まず `added` が ADR-0007 の門A を通ったかを審査すること。
  // スナップショットの更新はその審査の**後**である。
  expect({ added, removed }).toEqual({ added: [], removed: [] });
});

test("空の集合に対して緑にならない(検査が実際に読めていることの確認)", () => {
  // `kernel-types-no-import.test.ts` が採っている手口と同じ。対象を読めていないのに
  // 「差が無い」で緑になる壊れ方を防ぐ。
  const actual = collectExports();
  expect(actual.length).toBeGreaterThan(100);
  expect(actual).toContain("types.ts:DIFF_OPS");
  expect(actual).toContain("dry-run.ts:dryRunDiff");
});
