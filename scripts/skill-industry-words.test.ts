/**
 * `V6-M10-T04`(`H-G20`): **配布物(plugin 同梱の skill)の本文が、`G-G11` が狭めた側を
 * 広く読める形に書き戻していないこと**の検査。
 *
 * 上位: `docs/plan/v6/records/v6-m8.md` §5-20(`H-G20` の本審査。判定 = 限定採用。門外)/
 *       同 §7-3 の (iv)(**`G-G11` を打ち消しうる4経路のうち、機械で止まっていなかった1本**)/
 *       同 §8-2 の `V6-M10-T04` 完了条件 (iii) /
 *       `docs/plan/v6/records/v6-m10.md`(本タスクの実施記録)。
 *
 * ## なぜこの検査が要るのか(`v6-m8.md` §7-3 の (iv) の逐語)
 *
 * > **skill の側に、狭める前の広い言い方(「決済 Webhook を受けられます」)を書く** …
 * > **`H-G19` の突き合わせ検査は語彙の名前しか見張らないので、この経路は機械では止まらない。**
 *
 * `src/mcp/vocabulary.test.ts` の3本(`:4576` / `:4588` / `:4608`)は
 * `VOCABULARY_SCOPE` / `CANNOT_DO` / `OUT_OF_SCOPE_BEHAVIOR` / `src/mcp/tools/write.ts` を
 * 見張っているが、**`plugins/` の下は1バイトも見ていない。** ここがその穴を塞ぐ。
 *
 * ## この検査が測っているもの・測っていないもの(**先に書く。誇張しない**)
 *
 * - **測っているのは「あらかじめ決めた語が skill の本文に現れないこと」だけである。**
 *   語の一覧は `scripts/industry-words.ts` の `FACE5_INDUSTRY_WORDS` をそのまま使う
 *   (**1語も足していない・1語も減らしていない**)。
 * - **「skill が業種に依存していない」ことの証明ではない。** 字面を避けて書かれた業種前提は
 *   1件も拾えない(`scripts/industry-words.ts` の doc コメントが同じ限界を先に書いている)。
 * - **skill の記述が語彙の正と一致しているかを1バイトも見ていない。** それは
 *   `V6-M13-T01`(`H-G5` / `H-G19` の突き合わせ検査。**本検査とは別の1本**)の担当である。
 * - **`description` が実際に発火するかを1度も測っていない。** 測るのは `V6-M14` である。
 * - **意図して残した語は `KEEPS` に書く。** **黙って除外しない** —— 残した語と理由がここに現れる。
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { FACE5_INDUSTRY_WORDS, findIndustryWords } from "./industry-words.ts";

const REPO_ROOT = dirname(import.meta.dir);
const SKILLS_ROOT = join(REPO_ROOT, "plugins", "smailtalk", "skills");

/**
 * **意図して残す語と、その理由。** キーはリポジトリルートからの相対パス。
 *
 * **並び順は `FACE5_INDUSTRY_WORDS` の並び順である**(`findIndustryWords` の戻り値の順)。
 * ここに書かれていないファイルは「1語も残さない」を要求される。
 */
const KEEPS: Record<string, { words: string[]; reason: string }> = {
  "plugins/smailtalk/skills/view-shape/SKILL.md": {
    words: ["order"],
    reason:
      "「order」は `schemas/manifest.schema.json` の `$defs/sort_key` の required キー名である" +
      "(値は asc / desc の2つ)。キー名を伏せると、この skill が目的を果たせない。",
  },
  "plugins/smailtalk/skills/view-shape/reference/view-keys.md": {
    words: ["顧客", "order"],
    reason:
      "「顧客」は audience の値域に含まれる非運営の既定の種類 customer の日本語表記であり、" +
      "業種語ではなくカーネル語彙の識別子である(`schemas/manifest.schema.json` の " +
      "`$defs/view/properties/audience` の $comment が値域として名指ししている)。" +
      "「order」は同スキーマの `$defs/sort_key` の required キー名である。",
  },
  "plugins/smailtalk/skills/view-shape/reference/cannot-do.md": {
    words: ["顧客"],
    reason:
      "`CANNOT_DO` の正から引いた逐語に含まれる。**引用は1バイトも書き換えない**" +
      "(`H-G20` 限定1)。「顧客」は audience の予約値の日本語表記である。",
  },
};

function collectMarkdown(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...collectMarkdown(full));
    else if (entry.endsWith(".md")) found.push(full);
  }
  return found.sort();
}

const skillFiles = (() => {
  try {
    return collectMarkdown(SKILLS_ROOT);
  } catch {
    return [];
  }
})();

test("配布物の skill 本文が1本以上見つかる(0本なら本検査は何も測っていない)", () => {
  expect(skillFiles.length, `${SKILLS_ROOT} の下に .md が1本も無い`).toBeGreaterThan(0);
});

test("代理検査に歯がある(業種依存語を含む文字列は実際に拾われる)", () => {
  // **歯の実測。** この一行が緑でなければ、下の検査が全部緑でも何も意味しない。
  const bait = "この一覧に商品を並べ、注文の明細を出します。";
  expect(findIndustryWords(bait, FACE5_INDUSTRY_WORDS)).toEqual(["注文", "明細", "商品"]);
});

for (const file of skillFiles) {
  const rel = relative(REPO_ROOT, file);
  test(`${rel}: 業種依存語が KEEPS の宣言どおりである(残すものは理由つきで書く)`, () => {
    const keep = KEEPS[rel]?.words ?? [];
    expect(findIndustryWords(readFileSync(file, "utf8"), FACE5_INDUSTRY_WORDS)).toEqual(keep);
  });
}

test("`KEEPS` を書いた行には必ず理由が付いている(黙って除外しない)", () => {
  for (const [path, entry] of Object.entries(KEEPS)) {
    expect(entry.reason.length, path).toBeGreaterThan(0);
    expect(entry.words.length, path).toBeGreaterThan(0);
  }
});

test("`KEEPS` に、実在しない skill ファイルの行が残っていない", () => {
  const known = new Set(skillFiles.map((f) => relative(REPO_ROOT, f)));
  expect(Object.keys(KEEPS).filter((p) => !known.has(p))).toEqual([]);
});
