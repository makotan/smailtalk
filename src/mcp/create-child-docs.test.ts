/**
 * **子の表に行を作れる権限(`access_control.permissions[].create_child`)の効き方・組み方・限界が、AI と人の読み物に届いていること**
 * (`V23-M7-T07`。上位: `docs/adr/0542-create-child-gate-a-completion.md` と `docs/adr/0503`、
 * 計画 `docs/plan/v23/00-v23-plan.md` §26-3 の T07 と §26-6 の中8・軽3・軽4・軽6、決定 `D-V23-178`〜`D-V23-199`)。
 *
 * `V23-M7-T02` が書いたのは語彙の形と適用時の拒否の1段落だけで、効き方(3つの条件・段0 だけ・`creatable_by` が重なる)、
 * 作った人への付与、付け替えに使えないこと、入口ごとの効き方(受信口は実質通らない・時刻起動は素通し・自動処理と島の更新は
 * 親の関門を通らない)、画面の出し分けとその範囲の外、組み方(親の参照を `required` に)は、どの読み物にも無かった。
 *
 * **このファイルは新しい検査である**(既存の検査の期待値を1つも動かさない)。 見るのは決めた綴りが在るかだけで、
 * 文が正しいかは見ない。 振る舞いは `src/kernel/create-child-gate.test.ts`・`create-child-vocabulary.test.ts` と
 * `web/test/create-child-screen.test.tsx` が見る。
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CANNOT_DO, CANNOT_DO_INDEX, VOCABULARY_SCOPE } from "./vocabulary.ts";

const UNIT_ROOT = join(import.meta.dir, "..", "..");
const read = (path: string): string => readFileSync(join(UNIT_ROOT, path), "utf-8");

const SKILLS = "plugins/smailtalk/skills";
const DIFF_SHAPE = `${SKILLS}/diff-shape/SKILL.md`;
const DIFF_CANNOT = `${SKILLS}/diff-shape/reference/cannot-do.md`;
const VIEW_SHAPE = `${SKILLS}/view-shape/SKILL.md`;
const APP_BUILD = `${SKILLS}/app-build/SKILL.md`;
const AUTO_CANNOT = `${SKILLS}/automation-shape/reference/cannot-do.md`;
const MANUAL = "MANUAL.md";

const VIEW_SECTION = "## 5g. 子の表に行を作れる権限と、画面の出し分け";
const APP_SECTION = "## 7e. 組織の行は直せないが、その組織に告知だけは足せるようにしたいとき";
const DIFF_CANNOT_SECTION = "## 子の表に行を作れる権限でできないこと";
const AUTO_CANNOT_SECTION = "## 子の表に行を作れる権限と自動処理";
const MANUAL_SECTION = "### 子の表に行を作れる権限(2026-10-01)";

/** 見出しから次の `## ` 見出し(または `---`)の手前までを切り出す。 見出しが無ければ空文字。 */
function sectionOf(body: string, heading: string): string {
  const start = body.indexOf(heading);
  if (start < 0) return "";
  const rest = body.slice(start + heading.length);
  const ends = [rest.indexOf("\n## "), rest.indexOf("\n---")].filter((n) => n >= 0);
  const end = ends.length > 0 ? Math.min(...ends) : rest.length;
  return heading + rest.slice(0, end);
}

/** 足した読み物に出してはならない内部記号。 旧い節は v23 より前の記号を持つので、足した節だけに当てる。 */
const INTERNAL_SYMBOLS =
  /D-V\d+-|SC-G\d|ADR-\d|V\d+-M\d|門A|限定\d|ROUTES|judgeCreateParentAccess|owner-scope|段0/;

const SCOPE_HEAD = "**子の表に行を作れる権限の効き方と、組み方(2026-10-01)**";
const CANNOT_HEAD = "**子の表に行を作れる権限(create_child)について書きます(2026-10-01)**";

/** 語彙の全量の、効き方と組み方の段(見出しの文から終わりまで)。 */
function scopeParagraph(): string {
  const start = VOCABULARY_SCOPE.indexOf(SCOPE_HEAD);
  return start < 0 ? "" : VOCABULARY_SCOPE.slice(start);
}

/** できないことの段(見出しの文から、直後の総括「これら(グラフ」の手前まで)。 */
function cannotParagraph(): string {
  const start = CANNOT_DO.indexOf(CANNOT_HEAD);
  if (start < 0) return "";
  const end = CANNOT_DO.indexOf("これら(グラフ", start);
  return CANNOT_DO.slice(start, end < 0 ? undefined : end);
}

test("(S-1) 語彙の全量: 効き方(3つの条件・親の行そのものの権限・creatable_by が重なる)と作った人への付与", () => {
  const p = scopeParagraph();
  expect(p).not.toBe("");
  for (const phrase of [
    "親の行に書けなくても、その行を親にして子の表に行を作れます",
    "上限(restrictive)を当てた後に親の行を読めること",
    "上限が親の行への書込を止めていないこと",
    "親の行そのものに持つ権限だけを数えます",
    "行を相手にした付与で届く権限も数えます",
    "子の表に creatable_by があれば、今日どおり重なります",
    "作った人には、子の表の creator_permission が入ります",
  ]) {
    expect(p).toContain(phrase);
  }
});

test("(S-2) 語彙の全量: 組み方(親の権限・子の表の宣言・親の参照を required に)と、付け替えに使えないこと・あなたに見えないもの", () => {
  const p = scopeParagraph();
  for (const phrase of [
    "親の表の権限に create_child を書き",
    "子の表にも access_control を宣言し",
    "親の参照の項目を required にしてください",
    "付け替えには使えません",
    "あなたの list_records には、作れるかどうかは載りません",
  ]) {
    expect(p).toContain(phrase);
  }
  // 旧い段(語彙の形の1段落)は消さず、その後ろに足す。
  const old = VOCABULARY_SCOPE.indexOf("**子の表に行を作れる権限(2026-10-01)**");
  expect(old).toBeGreaterThanOrEqual(0);
  expect(VOCABULARY_SCOPE.indexOf(SCOPE_HEAD)).toBeGreaterThan(old);
});

test("(C-1) できないこと: 付け替え・親の参照が空の行・7つの入口の効き方(受信口・時刻・自動処理と島の更新)", () => {
  const p = cannotParagraph();
  expect(p).not.toBe("");
  for (const phrase of [
    "子の表に行を作れる権限は、付け替えには使えません",
    "親の参照の項目を空にして作る行は、親の関門を通りません",
    "画面・HTTP・あなた(AI の口)の insert_sample_data と write_records・自動処理の create_record・関数(コードの島)の write_ops と output_table で作るときに効きます",
    "受信口からは、書き手が名簿に居ないので実質作れません",
    "決まった時刻の処理は、親の関門を通らずに素通りします",
    "自動処理・関数(コードの島)・AI の書き戻しの更新は親の関門を通らないので、子の行の親を付け替えられます",
    "自動処理と関数(コードの島)で作った子の行には、作った人への付与が付きません",
  ]) {
    expect(p).toContain(phrase);
  }
});

test("(C-2) できないこと: 断りの文面・親を2つ持つ子・画面の出し分けの範囲の外・書き出したアプリ", () => {
  const p = cannotParagraph();
  for (const phrase of [
    "断られたときの文面は今日のまま「この表の行は、元になる行に書き込める人だけが作れます。」です",
    "親を2つ持つ子の表では、画面にボタンや選択肢が出ても、保存で断られることがあります",
    "同じ親の表を指す参照の項目を2つ以上持つ子の表では、作成フォームの親の選択肢を絞りません",
    "一覧の「新規作成」と子の一覧の導線は、作れるかどうかで出し分けません",
    "一覧画面の行ごとの「新規作成へ」のボタンも、作れるかどうかで出し分けません",
    "書き出したアプリ(独立して動かす版)は、画面の出し分けを写しません",
  ]) {
    expect(p).toContain(phrase);
  }
});

test("(C-3) できないこと: 見出しの括弧を足していない(接続直後に載る見出しの一覧が伸びない)", () => {
  expect(CANNOT_DO_INDEX).not.toContain("create_child");
  expect(CANNOT_DO_INDEX).not.toContain("子の表に行を作れる");
  expect(cannotParagraph()).not.toMatch(/【[^】]+】/);
});

test("(K-1) diff-shape の本体: 7キー目の段落(書き方と適用時の断り)が在る", () => {
  const body = read(DIFF_SHAPE);
  for (const phrase of [
    "7キー目 `create_child` が入った",
    "`create_child` は子の表のIDの配列で",
    "付け替えには使えない",
  ]) {
    expect(body).toContain(phrase);
  }
});

test("(K-2) diff-shape の cannot-do.md: できないことの段を逐語で引く", () => {
  const section = sectionOf(read(DIFF_CANNOT), DIFF_CANNOT_SECTION);
  expect(section).not.toBe("");
  for (const phrase of [
    "子の表に行を作れる権限は、付け替えには使えません",
    "親の参照の項目を空にして作る行は、親の関門を通りません",
    "受信口からは、書き手が名簿に居ないので実質作れません",
    "決まった時刻の処理は、親の関門を通らずに素通りします",
    "親を2つ持つ子の表では、画面にボタンや選択肢が出ても、保存で断られることがあります",
    "一覧画面の行ごとの「新規作成へ」のボタンも、作れるかどうかで出し分けません",
  ]) {
    expect(section).toContain(phrase);
  }
});

test("(K-3) view-shape の本体: 5g の節(新規作成へのボタン・親の選択肢・編集は絞らない・範囲の外)", () => {
  const section = sectionOf(read(VIEW_SHAPE), VIEW_SECTION);
  expect(section).not.toBe("");
  for (const phrase of [
    "「新規作成へ」",
    "親の選択肢",
    "編集のフォームでは絞らない",
    "一覧の「新規作成」と子の一覧の導線は出し分けない",
    "一覧画面の行ごとの「新規作成へ」のボタン",
    "同じ親の表を指す参照の項目を2つ以上",
    "宣言していないアプリ",
  ]) {
    expect(section).toContain(phrase);
  }
});

test("(K-4) app-build の本体: 7e の節(親の権限に create_child・子の creator_permission・親の参照を required・移せない・評価機関経由)", () => {
  const section = sectionOf(read(APP_BUILD), APP_SECTION);
  expect(section).not.toBe("");
  for (const phrase of [
    "`create_child`",
    "`creator_permission`",
    "`inherit_from`",
    "`required`",
    "`principal_row`",
    "移せない",
  ]) {
    expect(section).toContain(phrase);
  }
});

test("(K-5) automation-shape の cannot-do.md: 自動処理と島で作った子の行・更新は親の関門を通らない・時刻と受信口", () => {
  const section = sectionOf(read(AUTO_CANNOT), AUTO_CANNOT_SECTION);
  expect(section).not.toBe("");
  for (const phrase of [
    "自動処理と関数(コードの島)で作った子の行には、作った人への付与が付きません",
    "自動処理・関数(コードの島)・AI の書き戻しの更新は親の関門を通らないので、子の行の親を付け替えられます",
    "決まった時刻の処理は、親の関門を通らずに素通りします",
    "受信口からは、書き手が名簿に居ないので実質作れません",
  ]) {
    expect(section).toContain(phrase);
  }
});

test("(K-6) MANUAL.md: 子の表に行を作れる権限の節(効き方・組み方・付け替え・自動処理)", () => {
  const body = read(MANUAL);
  const start = body.indexOf(MANUAL_SECTION);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = body.slice(start + MANUAL_SECTION.length);
  const end = rest.indexOf("\n## ");
  const section = rest.slice(0, end < 0 ? undefined : end);
  for (const phrase of [
    "`create_child`",
    "`required`",
    "付け替え",
    "自動処理",
    "決まった時刻",
    "グループを通じた付与と、行を相手にした付与で届く権限は数える",
    "一覧画面の行ごとの「新規作成へ」のボタンも出し分けない",
  ]) {
    expect(section).toContain(phrase);
  }
  expect(section).not.toMatch(INTERNAL_SYMBOLS);
});

test("(N-1) 足した節と段に内部記号が1つも無い", () => {
  const texts = [
    scopeParagraph(),
    cannotParagraph(),
    sectionOf(read(DIFF_CANNOT), DIFF_CANNOT_SECTION),
    sectionOf(read(VIEW_SHAPE), VIEW_SECTION),
    sectionOf(read(APP_BUILD), APP_SECTION),
    sectionOf(read(AUTO_CANNOT), AUTO_CANNOT_SECTION),
  ];
  for (const text of texts) {
    expect(text).not.toBe("");
    expect(text).not.toMatch(INTERNAL_SYMBOLS);
  }
});
