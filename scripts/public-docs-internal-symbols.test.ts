/**
 * **公開用の読み物に内部記号が漏れていないこと・語彙の一覧が正と合っていることの検査**
 * (`V9-M9`。公開用4本 + 利用条件)。
 *
 * ## なぜ要るのか
 *
 * **この5本は、リポジトリを知らない相手が最初に読むものである。**
 * ところがこのリポジトリの散文は、**内部の記号(決定の番号・計画の置き場・関門の名前・
 * 節の番号・作法の逐語)を当たり前のように書く。** **書いた側には読めるが、外から来た
 * 相手には1つも引けない** —— 番号が指す文書はこの5本と一緒には配られないからである。
 *
 * **人手の読み直しでは落ちる。** 5本で 12万バイトを超えており、追記のたびに増える。
 * **機械で数えるほかない。**
 *
 * ## 何を見るか(**2つだけ**)
 *
 * 1. **(記号)公開用の5本に、内部記号が0行であること。** 8種を正規表現で当てる。
 *    **(追記 `V10-M7`。上の「8種」は書いた時点の数である。v10 で3種を足したので
 *    今日は11種。既存の8種は1つも書き換えていない。)**
 *    **(追記 `V10-M21-T06`。今日は12種。)**
 *    **当たった行はファイル名・行番号・逐語で出す**(どこを直せばよいかが分かる形にする)。
 * 2. **(語彙)`src/kernel/types.ts` の3つの配列と、`MANUAL.md` の列挙表が両方向で
 *    一致すること。** **配りものの側が「これが全量である」と書いている一覧が、実装の
 *    語彙と食い違っていないかを見る。**
 *
 * ## `src/kernel/` から値を import していない(**意図した設計**)
 *
 * **`scripts/kernel-import-drift.test.ts` の `SEARCH_ROOTS` に `scripts` が入っており、
 * ここでカーネルの値を import すると `scripts/kernel-import-snapshot.txt` が動く。**
 * そのファイルの sha は `scripts/industry-neutral-examples.test.ts` の生きた `expect` が
 * 固定しており、**スナップショットの更新は計画が明示的に禁じている。**
 * **したがって `src/kernel/types.ts` は「テキストとして」読み、配列リテラルを
 * 正規表現で取り出す。** **これは字面の読み取りであって、値の import ではない** ——
 * **配列の書き方(1要素1行)が変われば、この検査は「取り出せなかった」として赤くなる**
 * (黙って0件にはしない)。
 *
 * ## 「列挙表の1列目」の取り方(**素朴な読み方では成り立たない。実測**)
 *
 * **節の範囲 = その `## ` の行から、次の `## ` で始まる行の直前まで。**
 * **ところがその範囲には、語彙の一覧ではない表が同居している**(実測):
 *
 * | 節 | 同居している表 | 素朴に数えると |
 * |---|---|---|
 * | `## 扱えるリソースの種類` | 読み取り専用の内部の表(`_apps` / `_changelog`) | 8 → **10** |
 * | `## フィールドの型` | 項目の設定(`required` ほか)/ 特別な項目(`st_owner` ほか) | 9 → **22** |
 * | `## 差分操作` | 差分そのものの形(`diff_id` / `intent` / `operations`) | 17 → **20** |
 *
 * **そこで「列挙表」を、見出し行の1列目がその節の列挙の名前(`種別` / `型` / `操作`)
 * である表に限る。** **この限定を入れて初めて 8 / 9 / 17 になる**(実測)。
 * **`### ` で切る読み方は採れない** —— `## 差分操作` は最初の表が `### ` の下に在り、
 * 17個のうち1個も取れなくなる(実測 0個)。
 *
 * ## この検査が**しない**こと(**先に書く。誇張しない**)
 *
 * 1. **8種が内部記号の全量であるかを、誰も審査していない。** この8種は着手時点で
 *    実際に漏れていた・漏れやすいと分かっている綴りを並べたものであって、
 *    **「内部記号」の定義ではない。** 9種目(たとえば裁定の番号・門の名前・
 *    台帳の記号・`憲法6` のような内部の呼び名)が漏れても、**この検査は黙っている。**
 *    **穴は塞いでいない。この一覧はこのファイルが持つ人間の宣言である。**
 *    **(追記 `V10-M7`。3種を足したが、これも審査を経ていない。同じ宣言のままである。)**
 *    **(追記 `V10-M21-T06`。4種目も審査を経ていない。同じ宣言のままである。)**
 * 2. **文章が読めるかを1文字も見ていない。** 見るのは字面だけである。
 *    内部記号を消しただけで意味が通らなくなった文は、緑のまま通る。
 * 3. **`plugins/` と `docs/` は対象ではない。** `plugins/` については
 *    「**動いていないこと**」だけを数として見る((記号4))。`docs/` は1本も読まない。
 * 4. **語彙の突合は3つの配列と3つの節だけである。** 画面のキー・ワークフローの
 *    きっかけ・役割の予約語など、`MANUAL.md` が「全量である」と書いている他の一覧は
 *    1つも見ていない。
 * 5. **`MANUAL.md` の説明文(2列目)が正しいかを見ていない。** 見るのは1列目の識別子だけ。
 * 6. **5本の中身の正しさ(利用条件の条文が本物か等)を1ミリも判定していない。**
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/** **公開単位の根**(`apps/smailtalk/`)。5本も `src/` も `plugins/` もここに在る。 */
const PUBLIC_ROOT = dirname(import.meta.dir);

/**
 * **対象は5本ちょうどである。** **この定数は配列の長さと突き合わせる** ——
 * 対象をこっそり減らして緑にすることを止めるために置いてある。
 */
const EXPECTED_TARGET_COUNT = 5;

/**
 * **公開用の読み物4本 + 利用条件1本。** `apps/smailtalk/` からの相対。
 *
 * **`plugins/` と `docs/` は入れない** —— 前者は AI が読む説明書であり、
 * 内部記号を今日も95行持っている((記号4)が数として見張る)。後者は配りものではない。
 */
const TARGETS: readonly string[] = [
  "README.md",
  "MANUAL.md",
  "TUTORIAL.md",
  "templates/CLAUDE.md",
  "LICENSE",
];

/**
 * **漏れを見張る内部記号(8種)。** **固定文字列の照合ではなく正規表現で当てる** ——
 * 番号は増え続けるので、綴りを1つずつ並べる形にはできない。
 *
 * **`g` フラグを付けない**(`lastIndex` が持ち越されて1行おきに取りこぼす)。
 *
 * **追記(`V10-M7`)。今日は11種である** —— v10 の記号(`V1[0-9]-M[0-9]` /
 * `NV-G[0-9]` / `CM-G[0-9]`)を下に3種足した。**上の「8種」の逐語は着手時点の数として
 * 残してある**(このリポジトリは既存の本文を書き換えない)。
 * **足した式が当たること・既存の式が当たり続けることは(記号5)(記号6)が打つ。**
 */
const INTERNAL_SYMBOLS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "ADR-[0-9]", pattern: /ADR-[0-9]/ },
  { label: "docs/plan", pattern: /docs\/plan/ },
  { label: "docs/adr", pattern: /docs\/adr/ },
  { label: "docs/evidence", pattern: /docs\/evidence/ },
  { label: "CP-V[0-9]", pattern: /CP-V[0-9]/ },
  { label: "V[0-9]-M[0-9]", pattern: /V[0-9]-M[0-9]/ },
  { label: "D-V[0-9]", pattern: /D-V[0-9]/ },
  { label: "1バイトも", pattern: /1バイトも/ },
  // **ここから下は v10 で足した3種**(`V10-M7`。上の8種は1つも書き換えていない)。
  // **`V[0-9]-M[0-9]` は `V10-M7` に当たらない** —— `V1` の次が `0` で `-` が来ないため
  // (実測。(記号6)が式そのものを打っている)。**桁が増えた分を別の式で受ける。**
  { label: "V1[0-9]-M[0-9]", pattern: /V1[0-9]-M[0-9]/ },
  // **軸ごとの単位記号。** v10 の2軸(画面遷移 = `NV-G`・コメントからの直し = `CM-G`)。
  // **どちらも実在する**(`NV-G` 16系統・`CM-G` 21系統。2026-08-21 実測)。
  { label: "NV-G[0-9]", pattern: /NV-G[0-9]/ },
  { label: "CM-G[0-9]", pattern: /CM-G[0-9]/ },
  // **追記(`V10-M21-T06`)。4種目**。v10 の3本目の軸(追いの直し)の単位記号で、
  // **`FU-G1`〜`FU-G15` が実在する。** **`FU-G` は既存11式のどれにも当たらない**
  // (実測。(記号5)が `FU-G14` / `FU-G1` の当たり先を式まで固定している)。
  // **末尾に足す** —— 途中に挿すと(記号3)の当たり行の並び順が変わるためである。
  { label: "FU-G[0-9]", pattern: /FU-G[0-9]/ },
];

/**
 * **v10 で足した式の `label`(3種)。** **`PLUGIN_SYMBOL_LINES` の数え方から外すために置く** ——
 * (記号4)の 95 は6種で取った実測であり、**数え方を変えずに式だけを増やす。**
 * **足した式が `plugins/` に当たっていないことは、別に(記号7)が0行で見張る**
 * (実測 0行。2026-08-21)。
 *
 * **追記(`V10-M21-T06`)。ここに4種目(`FU-G[0-9]`)を足した。** **上の「3種」の逐語は
 * 書いた時点の数として残してある**(このリポジトリは既存の本文を書き換えない)。
 * **除外集合に入れる理由は `PLUGIN_SYMBOLS` の数え方(6種の和集合)を動かさないためである。**
 */
const V10_SYMBOL_LABELS: ReadonlySet<string> = new Set([
  "V1[0-9]-M[0-9]",
  "NV-G[0-9]",
  "CM-G[0-9]",
  "FU-G[0-9]",
]);

/**
 * **`plugins/` の内部記号の実測値**(2026-08-17)。**6種の和集合で95行。**
 *
 * **これは「対象に入れない」ことの裏返しの検査である** —— 5本を綺麗にする過程で
 * `plugins/` を一緒に書き換えていないこと(= 説明書が黙って痩せていないこと)を見る。
 * **`1バイトも` と `D-V[0-9]` は含めない**(着手前の実測がこの6種で取られている)。
 */
const PLUGIN_SYMBOL_LINES = 95;

/** (記号4)が使う6種。上の8種から `D-V[0-9]` と `1バイトも` を除いたもの。 */
const PLUGIN_SYMBOLS: readonly RegExp[] = INTERNAL_SYMBOLS.filter(
  (entry) =>
    entry.label !== "D-V[0-9]" &&
    entry.label !== "1バイトも" &&
    !V10_SYMBOL_LABELS.has(entry.label),
).map((entry) => entry.pattern);

/**
 * **`src/kernel/types.ts` の配列と `MANUAL.md` の節の対応。**
 *
 * `header` は列挙表を見分けるための見出し行の1列目(逐語)。`size` は今日の実測。
 */
const VOCABULARY_SECTIONS: readonly {
  readonly array: string;
  readonly heading: string;
  readonly header: string;
  readonly size: number;
}[] = [
  { array: "RESOURCE_KINDS", heading: "## 扱えるリソースの種類", header: "種別", size: 8 },
  { array: "FIELD_TYPES", heading: "## フィールドの型", header: "型", size: 9 },
  { array: "DIFF_OPS", heading: "## 差分操作", header: "操作", size: 17 },
];

/** 行に分ける。**末尾の改行が作る空行は落とす**(`grep` の数え方に合わせる)。 */
function toLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function readTarget(relativePath: string): string[] {
  return toLines(readFileSync(join(PUBLIC_ROOT, relativePath), "utf8"));
}

/**
 * ディレクトリを全部歩く。**隠しディレクトリも飛ばさない** ——
 * `plugins/smailtalk/.claude-plugin/plugin.json` が実在し、`grep -r` はそれを読むからである。
 */
function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full));
      continue;
    }
    files.push(full);
  }
  return files.sort();
}

/**
 * **`src/kernel/types.ts` をテキストとして読み、配列リテラルの要素を取り出す。**
 *
 * **1要素1行の行だけを拾う**(`"add_table",` のように、その行が文字列リテラルだけで
 * できている行)。**コメント行は拾わない** —— 配列の中には長い日本語のコメントが
 * 挟まっており、素朴に `"..."` を全部拾うと巻き込む。
 *
 * **取り出せなかったら投げる。黙って0件にしない。**
 */
function extractKernelArray(source: string, name: string): string[] {
  const lines = toLines(source);
  const start = lines.findIndex((line) => new RegExp(`^export const ${name} = \\[`).test(line));
  if (start < 0) {
    throw new Error(
      `src/kernel/types.ts から ${name} の配列リテラルの開始行を取り出せなかった` +
        `(期待した形: "export const ${name} = [")`,
    );
  }
  const end = lines.findIndex((line, index) => index > start && /^\] as const;/.test(line));
  if (end < 0) {
    throw new Error(`src/kernel/types.ts の ${name} に終端行("] as const;")が無い`);
  }
  const members: string[] = [];
  for (const line of lines.slice(start + 1, end)) {
    const matched = /^\s*"([A-Za-z_][A-Za-z0-9_]*)",?\s*$/.exec(line);
    const value = matched?.[1];
    if (value !== undefined) {
      members.push(value);
    }
  }
  if (members.length === 0) {
    throw new Error(`src/kernel/types.ts の ${name} から要素を1つも取り出せなかった`);
  }
  return members;
}

/** `| a | b |` の各セル。先頭の `|` を落としてから割る。 */
function tableCells(line: string): string[] {
  return line
    .slice(1)
    .split("|")
    .map((cell) => cell.trim());
}

/**
 * **`MANUAL.md` の節から、列挙表の1列目の識別子を取り出す。**
 *
 * - 節の範囲 = その `## ` の行から、次の `## ` で始まる行の直前まで。
 * - 列挙表 = 節の中の表のうち、**見出し行の1列目が `header` である**もの
 *   (doc コメント「列挙表の1列目の取り方」を見よ)。
 * - 1列目 = `|` で始まり、1つ目のセルがバッククォート囲みの識別子だけである行の、その識別子。
 *
 * **節が見つからない・列挙表が1つも無いときは投げる。黙って0件にしない。**
 */
function extractManualColumn(manual: string[], heading: string, header: string): string[] {
  const start = manual.indexOf(heading);
  if (start < 0) {
    throw new Error(`MANUAL.md に節の見出し「${heading}」が無い`);
  }
  let end = manual.length;
  for (let index = start + 1; index < manual.length; index++) {
    if ((manual[index] ?? "").startsWith("## ")) {
      end = index;
      break;
    }
  }
  const body = manual.slice(start + 1, end);
  const identifiers: string[] = [];
  let tables = 0;
  let index = 0;
  while (index < body.length) {
    if (!(body[index] ?? "").startsWith("|")) {
      index++;
      continue;
    }
    let last = index;
    while (last < body.length && (body[last] ?? "").startsWith("|")) {
      last++;
    }
    const table = body.slice(index, last);
    if (tableCells(table[0] ?? "")[0] === header) {
      tables++;
      for (const row of table.slice(1)) {
        const matched = /^`([A-Za-z_][A-Za-z0-9_]*)`$/.exec(tableCells(row)[0] ?? "");
        const value = matched?.[1];
        if (value !== undefined) {
          identifiers.push(value);
        }
      }
    }
    index = last;
  }
  if (tables === 0) {
    throw new Error(`MANUAL.md の「${heading}」に、1列目が「${header}」の表が1つも無い`);
  }
  if (identifiers.length === 0) {
    throw new Error(`MANUAL.md の「${heading}」の列挙表から識別子を1つも取り出せなかった`);
  }
  return identifiers;
}

/** ある綴りに当たる `INTERNAL_SYMBOLS` の `label` を全部返す(対照の実出力に使う)。 */
function labelsMatching(sample: string): string[] {
  return INTERNAL_SYMBOLS.filter(({ pattern }) => pattern.test(sample)).map(({ label }) => label);
}

/**
 * **陽性対照の綴り(v10)。** **どの式が当たるかまで固定する** ——
 * 「何かに当たった」では、既存の式にたまたま当たっただけの場合を素通りさせる。
 */
const V10_POSITIVE_CASES: readonly { readonly 綴り: string; readonly 式: string }[] = [
  { 綴り: "V10-M7", 式: "V1[0-9]-M[0-9]" },
  { 綴り: "V10-M0", 式: "V1[0-9]-M[0-9]" },
  { 綴り: "NV-G14", 式: "NV-G[0-9]" },
  { 綴り: "NV-G3", 式: "NV-G[0-9]" },
  { 綴り: "CM-G1", 式: "CM-G[0-9]" },
  { 綴り: "FU-G14", 式: "FU-G[0-9]" },
  { 綴り: "FU-G1", 式: "FU-G[0-9]" },
];

describe("公開用の5本に内部記号が漏れていない", () => {
  test("(記号1)対象は5本ちょうどである", () => {
    expect(TARGETS.length).toBe(EXPECTED_TARGET_COUNT);
    expect(new Set(TARGETS).size).toBe(EXPECTED_TARGET_COUNT);
  });

  test("(記号2)5本すべてが実在する", () => {
    const missing = TARGETS.filter((relativePath) => {
      try {
        return !statSync(join(PUBLIC_ROOT, relativePath)).isFile();
      } catch {
        return true;
      }
    });
    expect({ 見つからない: missing }).toEqual({ 見つからない: [] });
  });

  for (const target of TARGETS) {
    test(`(記号3)${target} に内部記号が0行である`, () => {
      const lines = readTarget(target);
      const hits: string[] = [];
      lines.forEach((line, offset) => {
        for (const { label, pattern } of INTERNAL_SYMBOLS) {
          if (pattern.test(line)) {
            hits.push(`${target}:${offset + 1}: [${label}] ${line.trim()}`);
          }
        }
      });
      expect({ 対象: target, 当たった行: hits }).toEqual({ 対象: target, 当たった行: [] });
    });
  }

  test("(記号4)plugins/ の内部記号は動いていない(6種の和集合で95行)", () => {
    const root = join(PUBLIC_ROOT, "plugins");
    const perFile: Record<string, number> = {};
    let total = 0;
    for (const file of walk(root)) {
      let count = 0;
      for (const line of toLines(readFileSync(file, "utf8"))) {
        if (PLUGIN_SYMBOLS.some((pattern) => pattern.test(line))) {
          count++;
        }
      }
      if (count > 0) {
        perFile[relative(PUBLIC_ROOT, file)] = count;
      }
      total += count;
    }
    expect({
      合計: total,
      増減: total - PLUGIN_SYMBOL_LINES,
      内訳: total === PLUGIN_SYMBOL_LINES ? {} : perFile,
    }).toEqual({ 合計: PLUGIN_SYMBOL_LINES, 増減: 0, 内訳: {} });
  });

  test("(記号5)陽性対照: v10 の記号が INTERNAL_SYMBOLS に当たる", () => {
    const actual = V10_POSITIVE_CASES.map((sample) => ({
      綴り: sample.綴り,
      当たった式: labelsMatching(sample.綴り),
    }));
    expect(actual).toEqual(
      V10_POSITIVE_CASES.map((sample) => ({ 綴り: sample.綴り, 当たった式: [sample.式] })),
    );
  });

  test("(記号6)陰性対照: 既存の式が今までどおり当たり続ける", () => {
    // **v9 までのマイルストーン記号は `V[0-9]-M[0-9]` が捕まえていた。**
    // **足した式がこれを奪っていない**(当たる式が入れ替わっていない)ことを見る。
    expect(labelsMatching("V9-M7")).toEqual(["V[0-9]-M[0-9]"]);
    expect(labelsMatching("V3-M11")).toEqual(["V[0-9]-M[0-9]"]);
    // **これが足した理由である** —— 既存の式は `V10-M7` に当たらない
    // (`V1` の次が `0` で、`-` が来ないため)。**実測**。
    expect(/V[0-9]-M[0-9]/.test("V10-M7")).toBe(false);
  });

  test("(記号7)plugins/ に v10 の記号は0行である", () => {
    const hits: string[] = [];
    for (const file of walk(join(PUBLIC_ROOT, "plugins"))) {
      toLines(readFileSync(file, "utf8")).forEach((line, offset) => {
        for (const { label, pattern } of INTERNAL_SYMBOLS) {
          if (V10_SYMBOL_LABELS.has(label) && pattern.test(line)) {
            hits.push(`${relative(PUBLIC_ROOT, file)}:${offset + 1}: [${label}] ${line.trim()}`);
          }
        }
      });
    }
    expect({ 当たった行: hits }).toEqual({ 当たった行: [] });
  });
});

describe("MANUAL.md の語彙の一覧がカーネルの正と一致する", () => {
  const typesSource = readFileSync(join(PUBLIC_ROOT, "src", "kernel", "types.ts"), "utf8");
  const manual = readTarget("MANUAL.md");

  for (const { array, heading, header, size } of VOCABULARY_SECTIONS) {
    test(`(語彙1)${array} を types.ts から取り出せる(${size}個)`, () => {
      const members = extractKernelArray(typesSource, array);
      // **要素数まで見る理由**: 正規表現がコメントの手前で切れても、素朴な
      // 「0件でなければよい」では素通りする(17個のうち4個だけ取れても緑になる)。
      // **語彙が動いたらここも直す** —— そのとき MANUAL.md も直る。
      expect({ 配列: array, 個数: members.length }).toEqual({ 配列: array, 個数: size });
    });

    test(`(語彙2)${array} にあって MANUAL.md「${heading}」に無いものが0件`, () => {
      const members = extractKernelArray(typesSource, array);
      const listed = new Set(extractManualColumn(manual, heading, header));
      const missing = members.filter((member) => !listed.has(member));
      expect({ 配列: array, 表に無い: missing }).toEqual({ 配列: array, 表に無い: [] });
    });

    test(`(語彙3)MANUAL.md「${heading}」にあって ${array} に無いものが0件`, () => {
      const declared = new Set(extractKernelArray(typesSource, array));
      const listed = extractManualColumn(manual, heading, header);
      const extra = listed.filter((identifier) => !declared.has(identifier));
      expect({ 配列: array, 配列に無い: extra }).toEqual({ 配列: array, 配列に無い: [] });
    });
  }
});
