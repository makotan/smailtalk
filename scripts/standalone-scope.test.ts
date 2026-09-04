/**
 * **公開単位が単独で成立していることの見張り —— 観測点 (i)「正本のルートを計算していない」**
 * (`V9-M12-T05` / `X-G34`。**門外 `Δ7` なので個別 ADR は無い。限定表は
 * `docs/plan/v9/records/v9-m10.md` の `X-G34` `S6` に在る**)。
 *
 * ## なぜ要るのか
 *
 * `V9-M5`(配布物の試し切り)が「**`ADR-0351` 限定4 を見張る検査は1本も無い**」と申し送った。
 * 単独で成立している状態は、**一度直しても次の変更で黙って戻り、どの検査も赤くならない。**
 * `X-G34` はその見張りを3つの観測点として置く ——
 * **(i) 公開単位が正本のルートを計算していないこと** / (ii) 重複した設定が食い違っていないこと /
 * (iii) 逆向きが0件であること。 **本ファイルは (i) だけを見る。**
 * **(ii)(iii) は `tools/standalone-scope.test.ts` に在る**(公開単位の外を読む必要があるため。限定5)。
 *
 * ## なぜ**公開単位の中**に置くのか(限定1)
 *
 * **切り出した木でも走る必要がある。** `tools/` に置くと配布物には1本も入らず、
 * 受け取った人の手元では (i) を1ミリも担保しない。
 * 本ファイルは `scripts/` の直下に在り、`tools/publish/publish-unit.json` の
 * `include` の `scripts/`(末尾 `/` の前方一致)がそのまま覆う。
 * **`publish-unit.json` は1バイトも触っていない**(限定8)。
 *
 * ## なぜ**綴りの `grep`** で書かないのか(限定2。**この限定が最も破られやすい**)
 *
 * 「上へ出る式」は1つの綴りに揃っていない。引数が分割された形・入れ子の `dirname`・
 * 中間変数を経る形・`import.meta.url` を経る形があり、**さらに綴りが同じでも答えが違う** ——
 * 同じ段数でも、書かれた場所が違えば公開単位の中に着くことも外に出ることもある。
 * したがって本ファイルは**式を括弧対応で切り出して実際に解決する評価器**を使う。
 *
 * **評価器は `V9-M11-T03` が作った `./upward-path-scan.ts` である**(`X-G34` 裁定11)。
 * **本ファイルは評価器を1バイトも書き直さない。使うだけである。**
 *
 * ## 期待値は **0**、**許容一覧を持たない**(限定3)
 *
 * **本検査は許容一覧を持たない** —— **1件でも出たら赤になる。**
 *
 * 同じ評価器を使う `upward-path-scan.test.ts` の `(up7)` は、`V9-M11` の作業中に残っていた
 * ファイルを名指しで許す `KNOWN_ESCAPING_FILES` を持っていた。
 * **その配列は 2026-08-18 に空になった。** 空にしたのは**本ファイルと同じ `V9-M12-T05`
 * (`X-G34`)である** —— 7本を1本ずつ評価器に掛けて findings が 0 件であることを実測してから
 * 消している。 **【ファイル単位と作業単位を区別して書く】** 本ファイルはその一覧を
 * 1バイトも書き換えていない(触ったのは `upward-path-scan.test.ts` の側である)。
 * **しかし単位としては同じ `V9-M12-T05` が触った。** 「本検査はその一覧に触らない」は
 * ファイルの話であって、単位の話ではない。
 *
 * **【判定としては揃った。仕組みとしては揃っていない】**
 * 今日 `(up7)` と `(standalone1)` は**同じ 0 件**を主張する(同じ植え込みに対して両方赤くなる
 * ことを実測した)。 **違うのは仕組みである** —— **`(up7)` には配列という緩めるレバーが
 * 残っており、名前を1本足せばその場で緩い門に戻る**(戻ったことは赤にならない)。
 * **本検査には足す先が無い。** **したがって「揃った」は今日の値についての話であり、
 * 構造としては本検査の方が硬い。**
 *
 * ## この検査が保証しないもの(先に書く。憲法6)
 *
 * 1. **全量ではない。** 評価器は**末尾が解けずに途中で打ち切った式**を持つ
 *    (`UpwardScanResult.partialCount` / `partialsInside`)。 **打ち切った時点で公開単位の中に
 *    居た式は `findings` に出てこないので、解けなかった末尾が `..` だったなら見逃している。**
 *    **本検査はその件数を主張しない** —— 値は将来動くので、固定すると偽になるからである。
 *    件数と逐語の一覧は `upward-path-scan.test.ts` の `(up5)` が主張し、
 *    `bun apps/smailtalk/scripts/upward-path-scan.ts --partials` で目で見られる。
 * 2. **評価器が測れないものは、そのまま本検査の穴である**(動的 `import()`・環境変数から
 *    受け取る根・文字列連結・`.ts` / `.tsx` 以外・シンボリックリンク・未追跡ファイル)。
 *    全量は `upward-path-scan.ts` の冒頭に列挙されている。
 * 3. **走査するのは公開単位だけである。** 正本のルート直下の他のディレクトリについては
 *    何も言っていない。
 * 4. **ファイル一覧は木によって変わる。** `git` が使える木では `git ls-files`(未追跡は読まない)、
 *    使えない木ではディレクトリを歩く(未追跡も読む)。**だから走査数を必ず主張する。**
 */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanFiles, scanPublicUnit } from "./upward-path-scan.ts";

// ---------------------------------------------------------------------------
// 植え込み用の綴り(**リポジトリの中には1バイトも書かない。一時ディレクトリにだけ書く**)
// ---------------------------------------------------------------------------

/** 本物の「上へ出る式」。`<tmp>/scripts/` から2段上がるので、根の外へ出る。 */
const PLANTED_ESCAPING_SOURCE = [
  'import { join } from "node:path";',
  'export const outside = join(import.meta.dir, "..", "..");',
  "",
].join("\n");

/** 上へ**出ない**式。`<tmp>/scripts/` から1段だけ上がるので、根そのものに着く(= 中)。 */
const PLANTED_INSIDE_SOURCE = [
  'import { join } from "node:path";',
  'export const inside = join(import.meta.dir, "..");',
  "",
].join("\n");

/**
 * **綴りだけが在って、式が1本も無いファイル。**
 * **綴りの `grep` で書いたなら、ここで必ず捕まってしまう** —— 限定2 が禁じた測り方の実演である。
 */
const PLANTED_SPELLING_ONLY_SOURCE = [
  '// join(import.meta.dir, "..", "..", "..", "..") と書いてあるが、これはコメントである。',
  'export const text = "dirname(dirname(dirname(dirname(import.meta.dir))))";',
  "",
].join("\n");

// ---------------------------------------------------------------------------
// (standalone1) 公開単位の外へ出る式が1本も無い(限定3。**許容一覧を持たない**)
// ---------------------------------------------------------------------------

test("(standalone1) 公開単位の .ts / .tsx から、公開単位の外へ出る式が1本も無い", () => {
  const result = scanPublicUnit();
  // **失敗時に「どのファイルの何行目の、どの式が、どこへ出たか」が出ることが本検査の価値である。**
  expect(
    result.findings.map((f) => `${f.file}:${f.line} -> ${f.resolved}  ${f.expression}`),
  ).toEqual([]);
  // 期待値は 0。**許容一覧は無い。**
  expect(result.findings.length).toBe(0);
});

// ---------------------------------------------------------------------------
// (standalone2) 空振りで緑になっていない(限定7)
// ---------------------------------------------------------------------------

test("(standalone2) 走査したファイル数とバイト数を主張する(1本も読まずに緑にならない)", () => {
  const result = scanPublicUnit();

  // **「0件だったから緑」と「1ファイルも読まずに緑」を区別する。**
  expect(result.filesScanned.length).toBeGreaterThan(0);
  expect(result.bytesRead).toBeGreaterThan(0);

  // 空振りと区別が付く水準まで踏み込む(今日の実測はこの数十倍である)。
  expect(result.filesScanned.length).toBeGreaterThan(300);
  expect(result.bytesRead).toBeGreaterThan(1_000_000);

  // **切り出した木にも必ず入る具体的な2本を名指しし続ける**
  // (どちらも `publish-unit.json` の `include` が覆う。根が空を向いたら赤になる)。
  expect(result.filesScanned).toContain("scripts/upward-path-scan.ts");
  expect(result.filesScanned).toContain("src/kernel/index.ts");

  // 一覧はすべて根の内側の相対パスである(`..` で外を指していない)。
  expect(result.filesScanned.filter((f) => f.startsWith(".."))).toEqual([]);
});

// ---------------------------------------------------------------------------
// (standalone3) 検出器そのものが動く(限定2 / 限定7。常に緑を否定する)
// ---------------------------------------------------------------------------

test("(standalone3) 検出器は植え込んだ違反を実際に見つける(綴りでは測っていない)", () => {
  // **リポジトリの中に1バイトも書かない** —— 一時ディレクトリを「公開単位の根」に見立てる。
  const tmp = mkdtempSync(join(tmpdir(), "v9m12-standalone-"));
  try {
    mkdirSync(join(tmp, "scripts"), { recursive: true });
    writeFileSync(join(tmp, "scripts", "escaping.ts"), PLANTED_ESCAPING_SOURCE);
    writeFileSync(join(tmp, "scripts", "inside.ts"), PLANTED_INSIDE_SOURCE);
    writeFileSync(join(tmp, "scripts", "spelling-only.ts"), PLANTED_SPELLING_ONLY_SOURCE);

    const result = scanFiles(tmp, [
      "scripts/escaping.ts",
      "scripts/inside.ts",
      "scripts/spelling-only.ts",
    ]);

    // 3本とも実際に読んでいる(植え込みの検査自体が空振りしていない)。
    expect(result.filesScanned).toEqual([
      "scripts/escaping.ts",
      "scripts/inside.ts",
      "scripts/spelling-only.ts",
    ]);
    expect(result.bytesRead).toBeGreaterThan(0);

    // (a) **本物の「上へ出る式」は捕まる。**
    expect(result.findings.map((f) => f.file)).toEqual(["scripts/escaping.ts"]);
    expect(result.findings[0]?.resolved.startsWith("..")).toBe(true);
    expect(result.findings[0]?.line).toBe(2);

    // (b) **根そのものに着く式は捕まらない**(過検出していない)。
    // (c) **綴りだけのファイルは捕まらない** —— 綴りの `grep` ならここで捕まる(限定2)。
    //     (a) が1件だけであることが、(b) と (c) の両方を同時に主張している。
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
