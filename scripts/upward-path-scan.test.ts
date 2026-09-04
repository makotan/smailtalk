/**
 * **評価器(`upward-path-scan.ts`)そのものの検査**(`V9-M11-T03`。`V9-M10` 裁定11)。
 *
 * ## この検査が言うこと
 *
 * | # | 主張 |
 * |---|---|
 * | (up1) | **必ず解けなければならない5つの形**を、実際に解く(引数の分割・入れ子・中間変数)。 |
 * | (up2) | **綴りが同じでも位置が違えば答えが違う**ことを、実際に区別する(誤検知を出さない)。 |
 * | (up3) | 文字列の中の綴り・`args.join(" ")` のような同名関数を**式と取り違えない**。 |
 * | (up4) | **植え込んだ違反を実際に見つける**(常に緑を否定する。本物のファイルは1バイトも汚さない)。 |
 * | (up5) | 走査が空振りしていない(読んだファイル数とバイト数を主張する)。 |
 * | (up6) | **評価器自身が正本のルートを1度も算出していない**(公開単位の中に在る以上、これが要る)。 |
 * | (up7) | **今日の実体**。上へ出る式が **1本でも**在れば赤くなる(許す例外は 0 本)。 |
 *
 * ## (up7) の期待値について —— **2つの測り方を混同しない**
 *
 * - **綴りの和集合式**(`X-G29` 限定1)は**パスを解決しない**ので、
 *   `src/mcp/tools/drift-report.test.ts` が**誤検知として1本残る**。期待値は **1本**。
 * - **本評価器**は**パスを実際に解決する**ので、同ファイルを「外へ出ない」と正しく判定する。
 *   期待値は **0 件**。**今日それが実体である**(下記)。
 *
 * **2026-08-18 に 0 になった。** 直しは複数の担当に分かれていたため、本ファイルは当初
 * 「**既知のファイル以外から新しく生えていないこと**」という名前で書いてあり、
 * `KNOWN_ESCAPING_FILES` に7本を名指しで許していた。
 * **その名前も同じ日に書き直した**(許す例外が 0 本になった以上、「既知のファイル以外」は
 * 読んだ人に「まだ許している本がある」と誤読させるからである)。
 * **`V9-M12-T05`(`X-G34`)が 14単位すべての完了を確かめたうえで、その配列を空にした。**
 * **`(up7)` は今日「0 件」の門そのものである** —— 1本でも外へ出たら赤くなる。
 * **【この注記は予定ではなく実施済みの記述である】** 空にした経緯と、7本が空振りであったことの
 * 実測は `docs/plan/v9/records/v9-m12.md` に在る。
 */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  findUpwardEscapes,
  listUnitSourceFiles,
  PUBLIC_UNIT_ROOT,
  scanFiles,
  scanPublicUnit,
} from "./upward-path-scan.ts";

/** 1本の式だけを持つ仮想のファイルを評価して、解決先の一覧を返す。 */
function resolveOf(relPath: string, source: string): string[] {
  return findUpwardEscapes(PUBLIC_UNIT_ROOT, relPath, source).findings.map((f) => f.resolved);
}

// ---------------------------------------------------------------------------
// (up1) 必ず解けなければならない形
// ---------------------------------------------------------------------------

test("(up1) 引数が分割された形を解く —— join(import.meta.dir, '..' x4)", () => {
  // `apps/smailtalk/scripts/bench/` から4段上げると正本のルート。**外へ出る。**
  expect(
    resolveOf(
      "scripts/bench/run.ts",
      'export const p = join(import.meta.dir, "..", "..", "..", "..", "node_modules", ".bin", "biome");\n',
    ),
  ).toEqual(["../../node_modules/.bin/biome"]);
});

test("(up1) 入れ子の dirname を解く —— dirname x4", () => {
  expect(
    resolveOf(
      "scripts/runner-image/prepare-context.ts",
      "export const REPO_ROOT = dirname(dirname(dirname(dirname(import.meta.dir))));\n",
    ),
  ).toEqual(["../.."]);
});

test("(up1) 中間変数を追う —— join(PRODUCT_ROOT, '..', '..')", () => {
  // **これを追わないと実体を見落とす。** 式そのものには `import.meta.dir` が現れない。
  const source = [
    'const PRODUCT_ROOT = join(import.meta.dir, "..", "..");',
    'const REPO_ROOT = join(PRODUCT_ROOT, "..", "..");',
    "",
  ].join("\n");
  expect(resolveOf("src/server/web-dist-default.test.ts", source)).toEqual(["../.."]);
});

test("(up1) 中間変数を追う —— dirname(dirname(PRODUCT_ROOT))", () => {
  const source = [
    'const PRODUCT_ROOT = resolve(import.meta.dir, "..");',
    "const REPO_ROOT = dirname(dirname(PRODUCT_ROOT));",
    "",
  ].join("\n");
  expect(resolveOf("scripts/plugin-version-match.test.ts", source)).toEqual(["../.."]);
});

test("(up1) import.meta.url 経由の形を解く", () => {
  // `resolve(dirname(new URL(import.meta.url).pathname), …)` と
  // `dirname(fileURLToPath(import.meta.url))` の2形。
  expect(
    resolveOf(
      "scripts/mcp-trial/run.ts",
      'export function f() { return resolve(dirname(new URL(import.meta.url).pathname), "..", "..", "..", ".."); }\n',
    ),
  ).toEqual(["../.."]);
  expect(
    resolveOf(
      "scripts/m6-poc/poc-worker.ts",
      [
        "const __dirname = dirname(fileURLToPath(import.meta.url));",
        'const target = join(__dirname, "..", "..", "..", "..", "z");',
        "",
      ].join("\n"),
    ),
  ).toEqual(["../../z"]);
});

test("(up1) 段数が同じでも位置が違えば答えが違う(綴りでは測れないことの実演)", () => {
  const expression = 'const R = join(import.meta.dir, "..", "..", "..");\n';
  // **まったく同じ綴り。** 置き場所だけが違う。
  expect(resolveOf("scripts/mcp-description-size.test.ts", expression)).toEqual(["../.."]);
  expect(resolveOf("src/mcp/tools/drift-report.test.ts", expression)).toEqual([]);
});

// ---------------------------------------------------------------------------
// (up2) 誤検知を出さない
// ---------------------------------------------------------------------------

test("(up2) drift-report.test.ts の REPO_ROOT は外へ出ない(本物のファイルで確かめる)", () => {
  // **綴りの grep はこれを誤検知する。それが評価器を作る理由の一つである。**
  // `apps/smailtalk/src/mcp/tools/` から3段上げると `apps/smailtalk` 自身(公開単位の根)。
  const result = scanPublicUnit();
  const offenders = result.findings.filter((f) => f.file === "src/mcp/tools/drift-report.test.ts");
  expect(offenders).toEqual([]);
  // 空振りではないこと —— そのファイルを実際に読んでいる。
  expect(result.filesScanned).toContain("src/mcp/tools/drift-report.test.ts");
});

test("(up2) 公開単位の根そのものに着く式は中と判定する", () => {
  expect(
    resolveOf("scripts/kernel-import-drift.test.ts", "const R = dirname(import.meta.dir);\n"),
  ).toEqual([]);
  expect(
    resolveOf("scripts/ref-ec/x.test.ts", "const R = dirname(dirname(import.meta.dir));\n"),
  ).toEqual([]);
});

// ---------------------------------------------------------------------------
// (up3) 式ではないものを式と取り違えない
// ---------------------------------------------------------------------------

test("(up3) 文字列・コメントの中の綴りは式ではない", () => {
  const inString = 'const s = "join(import.meta.dir, \\"..\\", \\"..\\", \\"..\\", \\"..\\")";\n';
  expect(resolveOf("scripts/x.test.ts", inString)).toEqual([]);
  const inComment = '// join(import.meta.dir, "..", "..", "..", "..")\nconst a = 1;\n';
  expect(resolveOf("scripts/x.test.ts", inComment)).toEqual([]);
  const inBlockComment = '/* join(import.meta.dir, "..", "..", "..", "..") */\nconst a = 1;\n';
  expect(resolveOf("scripts/x.test.ts", inBlockComment)).toEqual([]);
});

test("(up3) 配列の join / 引数を組み立てる join は拾わない", () => {
  expect(resolveOf("scripts/x.ts", 'const s = ["a", "b"].join(" ");\n')).toEqual([]);
  expect(resolveOf("scripts/x.ts", 'const s = args.join(" ");\n')).toEqual([]);
  // 根に届いていない相対の組み立ても対象外。
  expect(resolveOf("scripts/x.ts", 'const s = join("a", "..", "..", "..");\n')).toEqual([]);
});

test("(up3) 入れ子は外側だけを1件として数える", () => {
  const source =
    'const p = readFileSync(join(import.meta.dir, "..", "..", "..", "README.md"), "utf-8");\n';
  const findings = findUpwardEscapes(PUBLIC_UNIT_ROOT, "scripts/x.test.ts", source).findings;
  // `readFileSync(…)` は解けないので、内側の `join(…)` が1件だけ立つ。
  expect(findings.map((f) => f.resolved)).toEqual(["../../README.md"]);
});

// ---------------------------------------------------------------------------
// (up4) 植え込んだ違反を実際に見つける(常に緑を否定する)
// ---------------------------------------------------------------------------

test("(up4) 一時ディレクトリに植え込んだ違反を拾う(本物のファイルは1バイトも書かない)", () => {
  const root = mkdtempSync(join(tmpdir(), "v9m11-upward-"));
  try {
    mkdirSync(join(root, "scripts", "deep"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    // 外へ出る: `<root>/scripts/deep` から3段上げると `<root>` の親。
    writeFileSync(
      join(root, "scripts", "deep", "escapes.ts"),
      'export const OUT = join(import.meta.dir, "..", "..", "..", "outside.txt");\n',
    );
    // 外へ出る: 中間変数経由。
    writeFileSync(
      join(root, "scripts", "via-variable.ts"),
      [
        'const UNIT = join(import.meta.dir, "..");',
        'export const OUT = join(UNIT, "..", "outside.txt");',
        "",
      ].join("\n"),
    );
    // 外へ出ない: `<root>/src` から1段上げると `<root>` 自身。
    writeFileSync(join(root, "src", "stays.ts"), "export const IN = dirname(import.meta.dir);\n");
    // 外へ出ない: 文字列の中。
    writeFileSync(
      join(root, "src", "quoted.ts"),
      'export const S = \'join(import.meta.dir, "..", "..")\';\n',
    );

    const result = scanFiles(root, [
      "scripts/deep/escapes.ts",
      "scripts/via-variable.ts",
      "src/stays.ts",
      "src/quoted.ts",
    ]);
    expect(result.filesScanned.length).toBe(4);
    expect(result.findings.map((f) => `${f.file} -> ${f.resolved}`)).toEqual([
      "scripts/deep/escapes.ts -> ../outside.txt",
      "scripts/via-variable.ts -> ../outside.txt",
    ]);

    // ファイル一覧の代替経路(`git` の無い木)も、同じ2本を見つける。
    const walked = listUnitSourceFiles(root);
    expect(walked).toEqual([
      "scripts/deep/escapes.ts",
      "scripts/via-variable.ts",
      "src/quoted.ts",
      "src/stays.ts",
    ]);
    expect(scanFiles(root, walked).findings.length).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (up5) 空振りで緑になっていない
// ---------------------------------------------------------------------------

test("(up5) 公開単位を実際に読んでいる(0ファイルで緑にならない)", () => {
  const result = scanPublicUnit();
  expect(result.filesScanned.length).toBeGreaterThan(300);
  expect(result.bytesRead).toBeGreaterThan(1_000_000);
  // 実在する具体的な1本を名指しし続ける(根が空を向いたら赤になる)。
  expect(result.filesScanned).toContain("scripts/kernel-import-drift.test.ts");
  expect(result.filesScanned).toContain("src/kernel/validate.ts");
  expect(result.filesScanned).toContain("src/server/app.ts");
  // `.ts` / `.tsx` 以外を拾っていない(限界4 の裏返し)。
  expect(result.filesScanned.every((f) => f.endsWith(".ts") || f.endsWith(".tsx"))).toBe(true);
});

test("(up5) 限界7(途中で打ち切った式)を数えて手渡している", () => {
  // **「上へ出た式が 0 件」と「全量を数えた」は別である。**
  // 末尾が解けずに打ち切った式は、公開単位の中に居る限り `findings` に出てこない。
  // その死角を数と一覧で外へ出していることを、ここで主張しておく。
  const result = scanPublicUnit();
  expect(result.partialCount).toBeGreaterThan(0);
  expect(result.partialsInside.length).toBeGreaterThan(0);
  expect(result.partialsInside.length).toBeLessThanOrEqual(result.partialCount);
  // 中に居るのだから、解決先は `..` で始まらない。
  expect(result.partialsInside.every((f) => !f.resolved.startsWith(".."))).toBe(true);
  // 打ち切った式は逐語で見える(数だけでは目で確かめられない)。
  expect(result.partialsInside.every((f) => f.expression.length > 0 && f.line > 0)).toBe(true);
});

// ---------------------------------------------------------------------------
// (up6) 評価器自身が正本のルートを算出していない
// ---------------------------------------------------------------------------

test("(up6) 走査の根は公開単位そのもので、評価器はそこより上を算出していない", () => {
  // **【フォルダ名で確かめてはいけない】**
  // 切り出した木では公開単位そのものが木の根になり、**そのフォルダ名は受け取った人が付ける。**
  // `smailtalk` とは限らない(実測で `pub-t03` になった)。
  // 名前で突き合わせると**切り出した木でこそ落ちる**という本末転倒になるので、**段数(構造)で固定する。**

  // (a) 走査の根は「本ファイルが在るディレクトリの1つ上」である。
  //     本ファイルは公開単位の `scripts/` に在るので、その親が公開単位の根そのもの。
  //     **`import.meta.dir` はどこへ切り出しても自分の実在位置を指すので、名前に依らない。**
  expect(PUBLIC_UNIT_ROOT).toBe(dirname(import.meta.dir));
  // (b) 根と自分の距離はちょうど1段である(2段以上でも0段でもない)。
  expect(relative(PUBLIC_UNIT_ROOT, import.meta.dir).split(/[\\/]/)).toHaveLength(1);
  // (c) 根の**上**を1度も算出していない —— 根からの相対に `..` が現れない。
  expect(relative(PUBLIC_UNIT_ROOT, import.meta.dir).startsWith("..")).toBe(false);

  // (d) その場所が本当に公開単位の根であること —— **名前ではなく中身で同定する。**
  //     公開単位の目印(`package.json` / `schemas/` / `src/kernel/`)がその直下に実在する。
  //     **下向きにしか確かめない** —— ここで親を覗いたら、本検査自身が上を解決することになる。
  for (const marker of ["package.json", "schemas", "src/kernel", "src/mcp", "scripts"]) {
    expect(existsSync(join(PUBLIC_UNIT_ROOT, marker)), marker).toBe(true);
  }

  // (e) 走査したファイルは全部が根の内側である(根の親が一覧に1本も現れない)。
  const listed = listUnitSourceFiles();
  expect(listed.length).toBeGreaterThan(0);
  expect(listed.filter((f) => f.startsWith("..") || isAbsolute(f))).toEqual([]);

  // (f) 評価器本体と本検査自身が、上へ出る式を1本も持っていない。
  const result = scanFiles(PUBLIC_UNIT_ROOT, [
    "scripts/upward-path-scan.ts",
    "scripts/upward-path-scan.test.ts",
  ]);
  expect(result.findings).toEqual([]);
  expect(result.filesScanned.length).toBe(2);
});

// ---------------------------------------------------------------------------
// (up7) 今日の実体 —— 上へ出る式が 1本でも在れば赤くなる門
// ---------------------------------------------------------------------------

/**
 * **上へ出ることを許すファイル。今日は空である。**
 *
 * **`V9-M11` の作業中は7本を名指しで許していた**
 * (`scripts/mcp-description-size.test.ts` / `scripts/mcp-trial/run.test.ts` /
 *  `scripts/plugin-version-match.test.ts` / `scripts/report-prose-correction-drift.test.ts` /
 *  `scripts/runner-image/ci-container-check.test.ts` / `scripts/runner-image/prepare-context.ts` /
 *  `src/server/web-dist-default.test.ts`)。
 * **`V9-M12-T05`(`X-G34`)が 2026-08-18 に空にした。** 14単位(`X-G24`〜`X-G37`)が
 * すべて済み、**7本を1本ずつ評価器に掛けて findings が 0 件であることを実測してから**消している
 * (7本とも実在し、走査対象の一覧にも在り、合計 76,381 バイトを実際に読んだうえでの 0 である)。
 *
 * **【空でなくなったら、それは緩い門になったということである】** ここに名前を足すと、
 * その本数だけ「外へ出てよい」を許すことになる。**足すときは理由を書き、期限を決めること。**
 *
 * **【この配列は空のままが正である】** `X-G34` が新設した
 * `scripts/standalone-scope.test.ts` の `(standalone1)` は**許容一覧を持たない形**で
 * 同じ 0 件を主張しており、本配列が空である限り `(up7)` と厳しさが揃う。
 */
const KNOWN_ESCAPING_FILES: readonly string[] = [];

test("(up7) 公開単位のどのファイルからも、上へ出る式が1本も無い", () => {
  const result = scanPublicUnit();
  const unexpected = result.findings.filter((f) => !KNOWN_ESCAPING_FILES.includes(f.file));
  // **失敗時に「どのファイルの何行目の、どの式が、どこへ出たか」が出ることが本検査の価値である。**
  expect(unexpected.map((f) => `${f.file}:${f.line} -> ${f.resolved}  ${f.expression}`)).toEqual(
    [],
  );
});
