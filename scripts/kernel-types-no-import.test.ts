/**
 * `src/kernel/types.ts` が他モジュールを import しないことを固定する(ADR-0009 限定3)。
 *
 * ## なぜ要るのか
 *
 * `web/src/api.ts:17` は `normalizeSort` を**値として** `src/kernel/types.ts` から import している。
 * これはこのリポジトリで `web/src/` がカーネルの値を import している唯一の箇所であり、
 * ADR-0009 が門A で**限定採用**した1件である(限定2)。
 *
 * それが成立しているのは、**`types.ts` が現在 import を1つも持たないから**にすぎない。
 * `types.ts` に import が1行入った瞬間、`web` のバンドルがカーネル実装を推移的に引き込み、
 * `bun:sqlite` がブラウザ用バンドルに入りうる —— `web/src/table-resolution.ts:14-16` が
 * 名指しで避けた失敗そのものである。**ADR-0009 限定3 はこの前提を条文にしたもの**で、
 * 限定2(層またぎを許す)は限定3(import 非保持)に依存している。
 *
 * ## 壊れ方が悪い
 *
 * この性質が破れても `bun test` は緑のままで、`vite build` で初めて落ちる。
 * ADR-0009 §2(c) / §5 限界2 が「**守るテストが存在しない**」と申告していたのはこの穴で、
 * 本テストがその申し送り(gate-audit §5 の項目2)の履行である。
 *
 * ## 方式について —— `table-resolution.ts` と揃えなかった点
 *
 * 同じ危険(`src/kernel/*` を辿ると `vite build` が壊れる)を `web/src/table-resolution.ts:14-16`
 * も扱っているが、そちらの防護は**コメント1つだけ**で、テストは無い。したがって「方式を揃える」
 * 先が存在しない。本テストは**揃えず、機械検査を新設する**。理由は非対称性にある ――
 * `table-resolution.ts` は「import しない」を自分の中で完結して守れる(自分が import を書かなければ
 * よい)が、`types.ts` の側は**自分では守れない**。`types.ts` を編集する者にとって import を足すのは
 * 完全に自然な行為であり、遠くの `web/src/api.ts` の都合は視界に入らない。**編集者の視界の外にある
 * 制約だけが、機械検査を必要とする。**
 *
 * ## 何を赤にするか
 *
 * ADR-0009 限定3 の条文は「他モジュールを import しない」である。**`import type` も許さない。**
 * `import type` 自体は `verbatimModuleSyntax` で消えるのでビルドは壊れないが、
 * 「消える import と消えない import の区別」を毎回の編集者に正しく判定させる設計は、
 * まさに静かに壊れる種類のものである。条文どおり一律に禁じ、例外が要るなら ADR を改訂する。
 *
 * `scripts` 配下に置いたのは2つの理由による:
 * 1. `tsconfig.json` の `include` が `["src", "web", "scripts"]` であり、リポジトリ直下に
 *    新しいディレクトリを作ると typecheck の対象から外れる(`scripts/lint-ignore.test.ts` と同じ理由)。
 * 2. 本作業の検査条件が「`src/kernel/` の差分は `snapshot.ts` の1行だけ」であり、
 *    `src/kernel/` にファイルを足せない。**これは本テストの置き場としての積極的な理由ではない**ので、
 *    後日 `src/kernel/` へ移してもテストの主張は変わらない。
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** このファイルは <repo>/scripts にあるので、リポジトリルートはひとつ上。cwd に依存させない。 */
const repoRoot = join(import.meta.dir, "..");
const typesPath = join(repoRoot, "src", "kernel", "types.ts");

/**
 * コメントと文字列リテラルを取り除く。
 *
 * これを省くと、本ファイルのような**説明の中に書かれた `import`** や、
 * `types.ts` の doc コメントが偽の赤を作る。逆にコメントを剥がさずに済ませようとして
 * 正規表現を緩めると、今度は本物の import を見逃す。**剥がす方を選ぶ。**
 */
function stripCommentsAndStrings(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      // 改行を保って行構造(`^` アンカー)を壊さない。
      out += "\n";
      continue;
    }
    const char = source[i];
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      out += '""';
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

/**
 * モジュール依存を作る構文をすべて拾う。
 *
 * `import ... from` だけでは足りない: 副作用 import(`import "./x.ts"`)、動的 import、
 * `require`、そして **`export ... from`(再エクスポート)** も同じ依存を作る。
 * ADR-0009 限定3 が守っている性質は「バンドラが `types.ts` から他ファイルへ辿れないこと」なので、
 * 辿れる構文は形にかかわらず全部禁じる。
 */
const MODULE_DEPENDENCY_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "import ... from '...'", pattern: /^\s*import\b[\s\S]*?\bfrom\s*["']/m },
  { name: "副作用 import('...')", pattern: /^\s*import\s*["']/m },
  { name: "動的 import(...)", pattern: /\bimport\s*\(/ },
  { name: "require(...)", pattern: /\brequire\s*\(/ },
  { name: "export ... from '...'(再エクスポート)", pattern: /^\s*export\b[^;\n]*?\bfrom\s*["']/m },
];

describe("ADR-0009 限定3: src/kernel/types.ts は他モジュールを import しない", () => {
  const stripped = stripCommentsAndStrings(readFileSync(typesPath, "utf8"));

  for (const { name, pattern } of MODULE_DEPENDENCY_PATTERNS) {
    test(`${name} を含まない`, () => {
      const match = stripped.match(pattern);
      expect(
        match,
        `src/kernel/types.ts に \`${match?.[0].trim()}\` がある。` +
          "ADR-0009 限定3 に反する。限定2(web/src/api.ts が normalizeSort を値として " +
          "import してよい)はこの性質に依存しており、これが破れると vite build が bun:sqlite を " +
          "巻き込んで壊れる。import を足す必要があるなら、先に ADR-0009 を改訂すること。",
      ).toBeNull();
    });
  }

  test("検査対象のファイルを実際に読めている(空文字列に対して緑にならない)", () => {
    // 上の5本は「何も無い」ことを主張するので、パスを間違えて空を読んでも全部緑になる。
    // 読めていること自体を別に確かめる。
    expect(stripped).toContain("FIELD_TYPES");
    expect(stripped).toContain("normalizeSort");
  });
});
