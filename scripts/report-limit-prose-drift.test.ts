/**
 * **集計の主張を書いている場所に、上限の実数が併記されていることの検査**
 * (`V8-M10-T05b`。台帳 `Q-G17` / `Q-G18` / `Q-G19`。裁定 `M7-1` + ユーザ決定 `D-V8-124`)。
 *
 * ## なぜ要るのか
 *
 * **`docs/plan/v8/02-report-aggregation-baseline.md` §9 の22 の逐語**:
 * 「**【禁止】上限の実数を書かずに集計の主張を書かない。**
 * 『宣言した上限の内側で』という限定は、実数を併記して初めて意味を持つ」。
 *
 * **`V8-M10-T05b` はその実数を9箇所に配った。** **配った先は散文であり、実数は
 * 逐語の数字として書かれている** —— **`src/server/report-limits.ts` の定数を書き換えても、
 * 散文は1文字も追随しない。** **ここがその検出である。**
 *
 * ## 何を見るか(**2つだけ**)
 *
 * 1. **読取時の2つ**(`MAX_REPORT_SCANNED_ROWS` / `MAX_REPORT_GROUPS`)—— **正の側から
 *    `.length` ではなく値そのものを取り、3桁区切りの表記に直して、各ファイルに在るかを見る。**
 *    **数字を1つも書いていない**(`ADR-0250` §Decision 3 の 3 と同じ作法)。
 * 2. **apply 時の2つ**(結合できる表・参照の鎖の段数)—— **こちらは
 *    `src/kernel/referential-integrity.ts` の関数の中のローカル定数であり export されていない。**
 *    **したがって正を import できない** —— **同ファイルの逐語
 *    (`const MAX_JOINED_TABLES = 5;` / `const MAX_JOIN_DEPTH = 3;`)から読み取る。**
 *    **【正直に書く】これは字面の読み取りであって、値の import ではない。**
 *    **変数名を変えられたら、この検査は「読めなかった」として赤くなる**(黙って素通りしない)。
 *
 * ## この検査が**しない**こと(**先に書く。誇張しない**)
 *
 * - **散文が正しいかを1文字も見ていない。** 見るのは「その数字がそのファイルに在るか」だけである。
 * - **配り先の一覧が全量であるかを判定しない** —— **一覧はこのファイルが持つ人間の宣言であり、
 *   新しい主張の場所が増えても赤くならない**(`scripts/skill-vocabulary-drift.test.ts` の
 *   doc コメントが先に申告したのと同じ穴。**本検査が新しく作る穴ではないが、塞いでもいない**)。
 * - **`docs/` の記録・ADR・実施記録を1本も見ていない** —— **見るのは「製品が配るもの」
 *   (MCP の説明・スキーマ・説明書・利用者向けの手引き)だけである。**
 * - **上限そのものが妥当かを1ミリも判定しない。** **機械化したのは検出であって審査ではない。**
 *
 * ## `docs/manual.md` の分を切り出した(`X-G28` / `V9-M11-T02` / `D-V9-21`)
 *
 * **公開単位(`apps/smailtalk/`)の中の検査は `docs/` を読んではいけない。**
 * **移送先: `tools/docs/report-limit-prose-drift.test.ts`(3 test)。**
 *
 * | 出した test | 出した理由 |
 * |---|---|
 * | `docs/manual.md: 読取時の上限2つの実数が併記されている` | `docs/manual.md` を読む |
 * | `docs/manual.md: apply 時の上限2つの実数が併記されている` | 同上 |
 * | `歯: 上限から作った別の値は、どの散文にも書かれていない` | `PROSE_FILES` 全8本を舐めるので `docs/manual.md` を含む。**「`docs/` の分だけ」に割ると test が1本増える**(18 → 19)ので丸ごと出した |
 *
 * **こちらに残るのは15本で、`docs/` を1バイトも読まない。**
 * **歯は移送先が8本すべてについて続けている**(覆う範囲は減っていない)。
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MAX_REPORT_GROUPS, MAX_REPORT_SCANNED_ROWS } from "../src/server/report-limits.ts";

/** **公開単位の根**(`apps/smailtalk/`)。`src/` `schemas/` `plugins/` はここに在る。 */
const REPO_ROOT = dirname(import.meta.dir);

/**
 * **上限の実数を配った先**(`V8-M10-T05b` が実際に書いた場所)。
 *
 * **`src/mcp/vocabulary.ts` は接続直後のペイロードに入るので、5箇所すべてを1本の
 * ファイルとして数える**(ファイル単位で見る検査なので、箇所の数はここでは問わない)。
 *
 * **`docs/manual.md` はここに無い** —— `X-G28` により
 * `tools/docs/report-limit-prose-drift.test.ts` が持っている(上の doc コメント)。
 * **したがってこの配列の全要素は公開単位の中に在り、根は `REPO_ROOT` の1つだけである。**
 */
const PROSE_FILES: readonly string[] = [
  "src/mcp/vocabulary.ts",
  "schemas/manifest.schema.json",
  "schemas/diff.schema.json",
  "plugins/smailtalk/skills/view-shape/SKILL.md",
  "plugins/smailtalk/skills/view-shape/reference/view-keys.md",
  "plugins/smailtalk/skills/diff-shape/SKILL.md",
  "plugins/smailtalk/skills/automation-shape/reference/cannot-do.md",
];

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf-8");
}

/** 3桁区切りの表記(散文はこちらで書いている)。**数字リテラルを1つも書かない。** */
function grouped(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * **`src/kernel/referential-integrity.ts` の逐語から apply 時の上限を読む。**
 * **読めなかったら投げる**(黙って素通りさせない)。
 */
function applyTimeLimit(name: string): string {
  const source = read("src/kernel/referential-integrity.ts");
  const [, value] = new RegExp(`const ${name} = (\\d+);`).exec(source) ?? [];
  if (value === undefined) {
    throw new Error(`${name} を src/kernel/referential-integrity.ts から読めなかった`);
  }
  return value;
}

test("apply 時の2つの上限を、正のファイルから逐語で読めている", () => {
  expect(applyTimeLimit("MAX_JOINED_TABLES")).not.toBe("");
  expect(applyTimeLimit("MAX_JOIN_DEPTH")).not.toBe("");
});

for (const path of PROSE_FILES) {
  test(`${path}: 読取時の上限2つの実数が併記されている`, () => {
    const text = read(path);
    expect(text).toContain(grouped(MAX_REPORT_SCANNED_ROWS));
    expect(text).toContain(grouped(MAX_REPORT_GROUPS));
  });

  test(`${path}: apply 時の上限2つの実数が併記されている`, () => {
    const text = read(path);
    // 「起点を含めて5表まで」「3段まで」のように、数字の直後に単位が来る形で書いてある。
    expect(text).toContain(`${applyTimeLimit("MAX_JOINED_TABLES")}表`);
    expect(text).toContain(`${applyTimeLimit("MAX_JOIN_DEPTH")}段`);
  });
}

// **歯(`歯: 上限から作った別の値は、どの散文にも書かれていない`)はここに無い。**
// `X-G28` により `tools/docs/report-limit-prose-drift.test.ts` へ出した
// (`docs/manual.md` を含む8本すべてを、あちらが今も見ている)。
