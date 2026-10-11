/**
 * **アプリが決めた断りの文言(`unique_message` と島の `reject`)と、作成と作成者への付与の原子化が、
 * AI と人の読み物に届いていること**(`V23-M2-T07`。上位: `docs/adr/0498-unique-message-reject-and-atomic-creator-grant.md`
 * §Decision 1・限定14、計画 `docs/plan/v23/00-v23-plan.md` §21-2 の T07 と §21-4 の「T07 に足す」)。
 *
 * `V23-M2-T02`〜`T06` で次が入った。 読み物が旧いままだと、AI は「一意違反の文面は変えられない」
 * 「島は書込を断れない」「AI の口で作った行には作成者への付与が書かれない」と読み、
 * **文言に他人の行の値を埋めてよいと読む余地が残る**(FR-6 要件6)。
 *
 * **このファイルは新しい検査である**(既存の検査の期待値を1つも動かさない)。 見るのは次の字面:
 *   1. 語彙の全量(`VOCABULARY_SCOPE`): 形・入口ごとの効き方(7本)・作成と作成者への付与
 *   2. できないこと(`CANNOT_DO`): 「文言は作者の責任」「他人の行の値を埋めると漏れる」
 *   3. 説明書の `cannot-do.md`(diff-shape と automation-shape): 同じ2文
 *   4. 説明書 diff-shape の `SKILL.md`(`unique_message` の節)と automation-shape の `SKILL.md`(`reject` の節)
 *   5. 足した節に内部記号が1つも無いこと
 *
 * **この検査がしないこと**: 文が読めるか・正しいかは見ない。 見るのは決めた綴りが在るかだけである。
 * 振る舞いそのものは `src/server/unique-message.test.ts`・`src/server/island-reject.test.ts`・
 * `src/server/atomic-creator-grant.test.ts`・`src/mcp/creator-grant.test.ts` が見る。
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CANNOT_DO, CANNOT_DO_INDEX, VOCABULARY_SCOPE } from "./vocabulary.ts";

const UNIT_ROOT = join(import.meta.dir, "..", "..");
const read = (path: string): string => readFileSync(join(UNIT_ROOT, path), "utf-8");

const DIFF_SHAPE = "plugins/smailtalk/skills/diff-shape/SKILL.md";
const DIFF_CANNOT = "plugins/smailtalk/skills/diff-shape/reference/cannot-do.md";
const AUTO_SHAPE = "plugins/smailtalk/skills/automation-shape/SKILL.md";
const AUTO_CANNOT = "plugins/smailtalk/skills/automation-shape/reference/cannot-do.md";

/** FR-6 要件6 の2文(逐語)。 語彙の全量・できないこと・説明書の3か所で同じ綴りにする。 */
const AUTHOR_RESPONSIBILITY = "文言はアプリの作者の責任で書くものです";
const LEAK = "他人の行の値を文言に埋めると、断られた人にその値が漏れます";
/** 島が権限に関係なく表の全行を読めること(漏れる理由)。 */
const ISLAND_READS_ALL = "押した人や書いた人の権限に関係なく、表の全行を読めます";

/** 足した節の見出し(説明書)。 */
const DIFF_SECTION = "## 3b. 一意違反の文言(`unique_message`)";
const AUTO_SECTION = "## 5a. 関数から書込を断る(`reject`)";
const DIFF_CANNOT_SECTION = "## アプリが決めた断りの文言";
const AUTO_CANNOT_SECTION = "## 関数(コードの島)の reject と、断りの文言";

/** 見出しから次の `## ` 見出し(または `---`)の手前までを切り出す。 見出しが無ければ空文字。 */
function sectionOf(body: string, heading: string): string {
  const start = body.indexOf(heading);
  if (start < 0) return "";
  const rest = body.slice(start + heading.length);
  const ends = [rest.indexOf("\n## "), rest.indexOf("\n---")].filter((n) => n >= 0);
  const end = ends.length > 0 ? Math.min(...ends) : rest.length;
  return heading + rest.slice(0, end);
}

/**
 * 足した読み物に出してはならない内部記号(決定の番号・単位の記号・ADR 番号・段とタスクの記号・門A・限定N)。
 * 説明書の旧い節は v23 より前の記号を持つので、**足した節だけ**に当てる。
 */
const INTERNAL_SYMBOLS = /D-V\d+-|SC-G\d|ADR-\d|V\d+-M\d|門A|限定\d|ROUTES|EntryTrigger/;

test("(S-1) 語彙の全量: unique_message の形(13個目・1〜200文字・unique を書いた項目だけ)を言う", () => {
  expect(VOCABULARY_SCOPE).toContain("項目(field)に13個目のキー unique_message を書けます");
  expect(VOCABULARY_SCOPE).toContain('unique(true または "owner")を書いた項目にだけ書けます');
  expect(VOCABULARY_SCOPE).toContain("unique を外して unique_message だけを残す差分");
});

test("(S-2) 語彙の全量: reject の渡し方(綴りのある島だけ・第2引数・別名では渡らない)と止まり方を言う", () => {
  expect(VOCABULARY_SCOPE).toContain("export default function (input, { reject })");
  expect(VOCABULARY_SCOPE).toContain("本文に reject という語を書いたときだけ");
  expect(VOCABULARY_SCOPE).toContain("別の名前で受けて");
  expect(VOCABULARY_SCOPE).toContain("reject 以外の例外の本文は今日どおり捨てられ");
  expect(VOCABULARY_SCOPE).toContain("2回呼んだときは1回目の文言です");
});

test("(S-3) 語彙の全量: 起動のされ方ごとの違い(きっかけの書込ごと戻る / 手動は済んだ書込が残る / 時刻は汎用の失敗)", () => {
  expect(VOCABULARY_SCOPE).toContain("きっかけの書込ごと、同じ器の中の書込が全部戻り");
  expect(VOCABULARY_SCOPE).toContain("断るより前に済んだ書込は残り");
  expect(VOCABULARY_SCOPE).toContain("reject は汎用の失敗になり、文言は残らず");
});

test("(S-4) 語彙の全量: 入口ごとの返り方を7本(画面・HTTP・AI・受信口・自動処理・島・時刻起動)言う", () => {
  for (const phrase of [
    "画面では、入力フォームの上に文言が出ます",
    'HTTP では 422 で、本文の最上位に kind: "app_rejected" が付き',
    "今日の検査の失敗が1件でも混ざれば今日の 400",
    "あなた(AI の口)では、write_records・update_record は文言をエラーとして返し",
    "受信口では、unique: true の項目の重複は今日どおり吸収して 200 を返し",
    "自動処理と島の書込(create_record・update_record・write_ops・write_back)",
    "決まった時刻に動く処理では、文言つきの一意違反は",
  ]) {
    expect(VOCABULARY_SCOPE).toContain(phrase);
  }
});

test("(S-5) 語彙の全量: 作成と作成者への付与(一緒に成立か一緒に戻る / AI でも書く / 受信口と自動処理は書かない)", () => {
  expect(VOCABULARY_SCOPE).toContain("一緒に成立するか一緒に戻ります");
  expect(VOCABULARY_SCOPE).toContain(
    "あなた(AI の口)が作った行にも、今日は作った人(名乗った本人)への付与が書かれます",
  );
  expect(VOCABULARY_SCOPE).toContain(
    "受信口と自動処理(島を含む)が作った行には、今日も作った人への付与は書かれません",
  );
});

test("(S-6) 語彙の全量にも、文言は作者の責任で、他人の行の値を埋めると漏れることを書く", () => {
  expect(VOCABULARY_SCOPE).toContain(AUTHOR_RESPONSIBILITY);
  expect(VOCABULARY_SCOPE).toContain(LEAK);
  expect(VOCABULARY_SCOPE).toContain(ISLAND_READS_ALL);
});

test("(C-1) できないこと: 文言は作者の責任で、島は全行を読めるので、他人の行の値を埋めると漏れる(FR-6 要件6)", () => {
  expect(CANNOT_DO).toContain(AUTHOR_RESPONSIBILITY);
  expect(CANNOT_DO).toContain(LEAK);
  expect(CANNOT_DO).toContain(ISLAND_READS_ALL);
});

test("(C-2) できないこと: 時刻起動では戻せない・手動は済んだ書込が戻らない・受信口と自動処理の作成は付与しない", () => {
  expect(CANNOT_DO).toContain("決まった時刻に動く処理(schedule)では reject で書込を戻せません");
  expect(CANNOT_DO).toContain("断るより前に済んだ書込は戻りません");
  expect(CANNOT_DO).toContain(
    "受信口と自動処理(島を含む)が作った行には、作った人への付与を書けません",
  );
});

test("(C-3) できないこと: 見出しの括弧を足していない(接続直後に載る見出しの一覧が伸びない)", () => {
  expect(CANNOT_DO_INDEX).not.toContain("reject");
  expect(CANNOT_DO_INDEX).not.toContain("unique_message");
  expect(CANNOT_DO_INDEX).not.toContain("断りの文言");
});

test("(K-1) diff-shape の cannot-do.md: 作者の責任と、他人の行の値を埋めると漏れることを引く", () => {
  const section = sectionOf(read(DIFF_CANNOT), DIFF_CANNOT_SECTION);
  expect(section).not.toBe("");
  expect(section).toContain(AUTHOR_RESPONSIBILITY);
  expect(section).toContain(LEAK);
});

test("(K-2) automation-shape の cannot-do.md: 作者の責任と、他人の行の値を埋めると漏れることを引く", () => {
  const section = sectionOf(read(AUTO_CANNOT), AUTO_CANNOT_SECTION);
  expect(section).not.toBe("");
  expect(section).toContain(AUTHOR_RESPONSIBILITY);
  expect(section).toContain(LEAK);
  expect(section).toContain("断るより前に済んだ書込は戻りません");
});

test("(K-3) diff-shape の SKILL.md: unique_message の節が、書ける項目・入口ごとの返り方・作者の責任を言う", () => {
  const section = sectionOf(read(DIFF_SHAPE), DIFF_SECTION);
  expect(section).not.toBe("");
  for (const word of [
    "`unique_message`",
    "1〜200文字",
    "`422`",
    '`kind: "app_rejected"`',
    "受信口",
    "`insert_sample_data`",
    "作った人への付与",
    AUTHOR_RESPONSIBILITY,
    LEAK,
  ]) {
    expect(section).toContain(word);
  }
});

test("(K-4) automation-shape の SKILL.md: reject の節が、書き方・別名で渡らないこと・起動ごとの違い・作者の責任を言う", () => {
  const section = sectionOf(read(AUTO_SHAPE), AUTO_SECTION);
  expect(section).not.toBe("");
  for (const word of [
    "export default function (input, { reject })",
    "別の名前で受けて",
    "`on_create` / `on_update`",
    "断るより前に済んだ書込は残る",
    "`schedule`",
    "本文は今日どおり捨てられる",
    "1〜200文字",
    AUTHOR_RESPONSIBILITY,
    LEAK,
  ]) {
    expect(section).toContain(word);
  }
});

test("(P-1) 足した節に内部記号が1つも無い", () => {
  const sites: [string, string][] = [
    [DIFF_SHAPE, sectionOf(read(DIFF_SHAPE), DIFF_SECTION)],
    [DIFF_CANNOT, sectionOf(read(DIFF_CANNOT), DIFF_CANNOT_SECTION)],
    [AUTO_SHAPE, sectionOf(read(AUTO_SHAPE), AUTO_SECTION)],
    [AUTO_CANNOT, sectionOf(read(AUTO_CANNOT), AUTO_CANNOT_SECTION)],
  ];
  for (const [label, body] of sites) {
    expect(body, label).not.toBe("");
    expect(body.match(INTERNAL_SYMBOLS)?.[0], label).toBeUndefined();
  }
});

test("(P-1b) 陽性対照: 内部記号の式と節の切り出しは、実在の綴りを当てる", () => {
  expect("決定 D-V23-45 による".match(INTERNAL_SYMBOLS)).not.toBeNull();
  expect("ADR-0498 の".match(INTERNAL_SYMBOLS)).not.toBeNull();
  expect("単位 SC-G7".match(INTERNAL_SYMBOLS)).not.toBeNull();
  expect("V23-M2-T07 で".match(INTERNAL_SYMBOLS)).not.toBeNull();
  expect("門A の本審査".match(INTERNAL_SYMBOLS)).not.toBeNull();
  expect("限定14 により".match(INTERNAL_SYMBOLS)).not.toBeNull();
  expect("一意違反の文言は 422 で返る".match(INTERNAL_SYMBOLS)).toBeNull();
  expect(sectionOf("# a\n## x\nbody\n## y\nnext", "## x")).toBe("## x\nbody");
  expect(sectionOf("# a\n## x\nbody\n---\nnext", "## x")).toBe("## x\nbody");
  expect(sectionOf("# a", "## x")).toBe("");
});
