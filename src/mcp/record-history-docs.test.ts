/**
 * **行の変更履歴(`table.history` と `detail_view.history`)の読み方・限界が、AI と人の読み物に届いていること**
 * (`V23-M8-T08`。上位: `docs/adr/0504-record-history-declaration.md` と `docs/adr/0544-record-history-gate-a-completion.md`、
 * 計画 `docs/plan/v23/00-v23-plan.md` §27-3 の T08 と §27-6、決定 `D-V23-212`〜`D-V23-226`)。
 *
 * `V23-M8-T02` が書いたのは語彙の形と適用時の拒否の段落だけで、誰が読めるか・読めない項目・変えた人の名前・入口・
 * 消した行・undo との交わり・表を消したとき・配る版とバックアップ・変えた人が空になる書込・AI の道具 `list_record_history` は、
 * どの読み物にも無かった。
 *
 * リポジトリの根の読み物(`docs/manual.md`・`docs/mcp-quickstart.md`・`docs/tutorial.md`)は公開単位の外なので、
 * ここでは読まない(`tools/docs/record-history-docs.test.ts` が見る。T08 の差し戻しで移した)。
 *
 * **このファイルは新しい検査である**(既存の検査の期待値を1つも動かさない)。 見るのは決めた綴りが在るかだけで、
 * 文が正しいかは見ない。 振る舞いは `src/kernel/record-history-read.test.ts`・`record-history-undo.test.ts` が見る。
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CANNOT_DO, CANNOT_DO_INDEX, VOCABULARY_SCOPE } from "./vocabulary.ts";

const UNIT_ROOT = join(import.meta.dir, "..", "..");
const read = (path: string): string => readFileSync(join(UNIT_ROOT, path), "utf-8");

const SKILLS = "plugins/smailtalk/skills";
const DIFF_CANNOT = `${SKILLS}/diff-shape/reference/cannot-do.md`;
const VIEW_SHAPE = `${SKILLS}/view-shape/SKILL.md`;
const APP_BUILD = `${SKILLS}/app-build/SKILL.md`;
const AUTO_CANNOT = `${SKILLS}/automation-shape/reference/cannot-do.md`;

const VIEW_SECTION = "## 5h. 詳細画面の変更履歴(`history`)";
const APP_SECTION = "## 7f. 行ごとに、誰がいつ何を変えたかを残して詳細画面で見せたいとき";
const DIFF_CANNOT_SECTION = "## 行の変更履歴でできないこと";
const AUTO_CANNOT_SECTION = "## 行の変更履歴と自動処理";
const MANUAL_SECTION = "### 行の変更履歴(2026-10-02)";

/** 見出しから次の `## ` 見出し(または `---`)の手前までを切り出す。 見出しが無ければ空文字。 */
function sectionOf(body: string, heading: string): string {
  const start = body.indexOf(heading);
  if (start < 0) return "";
  const rest = body.slice(start + heading.length);
  const ends = [rest.indexOf("\n## "), rest.indexOf("\n---")].filter((n) => n >= 0);
  const end = ends.length > 0 ? Math.min(...ends) : rest.length;
  return heading + rest.slice(0, end);
}

/** 足した読み物に出してはならない内部記号(内部表の名は、道具名 `list_record_history` の中に現れるものを除く)。 旧い節は v23 より前の記号を持つので、足した節だけに当てる。 */
const INTERNAL_SYMBOLS =
  /D-V\d+-|SC-G\d|ADR-\d|V\d+-M\d|H-V\d+-|門A|限定\d|ROUTES|\b_record_history|record-history\.ts|owner-scope/;

const SCOPE_HEAD = "**行の変更履歴の読み方と限界(2026-10-02)**";
const CANNOT_HEAD = "**行の変更履歴(history)について書きます(2026-10-02)**";

function scopeParagraph(): string {
  const start = VOCABULARY_SCOPE.indexOf(SCOPE_HEAD);
  return start < 0 ? "" : VOCABULARY_SCOPE.slice(start);
}

function cannotParagraph(): string {
  const start = CANNOT_DO.indexOf(CANNOT_HEAD);
  if (start < 0) return "";
  const end = CANNOT_DO.indexOf("これら(グラフ", start);
  return CANNOT_DO.slice(start, end < 0 ? undefined : end);
}

test("(S-1) 語彙の全量: 誰が読めるか・読む口・表の宣言だけを見る・読めない項目・変えた人・入口", () => {
  const p = scopeParagraph();
  expect(p).not.toBe("");
  for (const phrase of [
    "履歴を読めるのは、その行を読める、ログインした人だけです",
    "?history=1",
    "あなたは list_record_history で読めます",
    "?history=1 と list_record_history は、表の history だけを見ます",
    "その人に読めない項目は、変更前と変更後の両方を落とします。",
    "条件つきの項目の規則は、今の行の状態で当たります",
    "読めない項目だけが変わった保存は、その人の履歴に1件も出ません",
    "変えた人は、更新者の欄と同じ名前で出ます",
    "AI の書き戻しと、自動処理の履歴の表への書込は、変えた人が空のことがあります。",
    "消した行の履歴は、運営者だけが list_record_history で読めます",
  ]) {
    expect(p).toContain(phrase);
  }
});

test("(S-2) 語彙の全量: undo・history を外す/戻す・表を消す・配る版とバックアップ", () => {
  const p = scopeParagraph();
  for (const phrase of [
    "undo すると、その差分より後の履歴も消え、redo で戻ります。",
    "表の history を外すと読めなくなり、戻すと前の履歴がまた読めます。",
    "表を消す(remove_table)と、その表の前の履歴は誰にも読めなくなります。",
    "配る版と日次のバックアップには、履歴の行も入ります。",
  ]) {
    expect(p).toContain(phrase);
  }
  // 旧い段(語彙の形の1段落)は消さず、その後ろに足す。
  const old = VOCABULARY_SCOPE.indexOf("**変更履歴** —— 表に history: true を書くと");
  expect(old).toBeGreaterThanOrEqual(0);
  expect(VOCABULARY_SCOPE.indexOf(SCOPE_HEAD)).toBeGreaterThan(old);
});

test("(C-1) できないこと: 書き換えられない・過去の規則・未ログイン・消した行・undo・表を消す・差分の適用・空の操作者・親を消すと子ごと", () => {
  const p = cannotParagraph();
  expect(p).not.toBe("");
  for (const phrase of [
    "行の変更履歴は、書き換えることも消すこともできません",
    "過去に読めた項目を、その時点の規則で見せることはできません",
    "ログインしていない人には、履歴を見せられません",
    "消した行の履歴は、画面と HTTP では見られません",
    "undo すると、その差分より後の履歴も一緒に消えます",
    "表を消す(remove_table)と、その表の前の履歴は誰にも読めなくなります。",
    "差分の適用で消えた・変わった値(項目を消す・表を消す・型の変換)は、行の履歴に残りません",
    "AI の書き戻しと、自動処理の履歴の表への書込は、変えた人が空のことがあります。",
    "途中で断られると、それまでに消えた子の行は消えたままです",
  ]) {
    expect(p).toContain(phrase);
  }
});

test("(C-2) できないこと: 見出しの括弧を足していない(接続直後に載る見出しの一覧が伸びない)", () => {
  expect(CANNOT_DO_INDEX).not.toContain("変更履歴");
  expect(cannotParagraph()).not.toMatch(/【[^】]+】/);
});

test("(K-1) diff-shape の cannot-do.md: できないことの段を逐語で引き、外す/戻す・表の宣言だけ・配る版を書く", () => {
  const section = sectionOf(read(DIFF_CANNOT), DIFF_CANNOT_SECTION);
  expect(section).not.toBe("");
  for (const phrase of [
    "行の変更履歴は、書き換えることも消すこともできません",
    "undo すると、その差分より後の履歴も一緒に消えます",
    "途中で断られると、それまでに消えた子の行は消えたままです",
    "戻すと前の履歴がまた読める",
    "表の `history` だけを見る",
    "配る版と日次のバックアップには、履歴の行も入る",
  ]) {
    expect(section).toContain(phrase);
  }
});

test("(K-2) view-shape の本体: 5h の節(50件ずつ・さらに読む・入口の見え方・見える人・読めない項目・書かない画面は変わらない)", () => {
  const section = sectionOf(read(VIEW_SHAPE), VIEW_SECTION);
  expect(section).not.toBe("");
  for (const phrase of [
    "新しい順に50件ずつ",
    "「さらに読む」",
    "画面・API / 手動起動 / 受信口 / 自動処理 / 時刻起動 / AI",
    "ログインした人だけ",
    "変更前と変更後の両方を落とす",
    "`?history=1`",
    "`history` を書いていない画面は、今日と1バイトも変わらない",
  ]) {
    expect(section).toContain(phrase);
  }
});

test("(K-3) app-build の本体: 7f の節(表に history・詳細画面に history・外すときは逆の順)", () => {
  const section = sectionOf(read(APP_BUILD), APP_SECTION);
  expect(section).not.toBe("");
  for (const phrase of [
    "`change_table`",
    "`update_view`",
    "外すときは逆の順にする",
    "`list_record_history`",
    "undo すると、その差分より後の履歴も消える",
  ]) {
    expect(section).toContain(phrase);
  }
});

test("(K-4) automation-shape の cannot-do.md: 入口ごとの値と、変えた人が空になる書込・巻き戻り", () => {
  const section = sectionOf(read(AUTO_CANNOT), AUTO_CANNOT_SECTION);
  expect(section).not.toBe("");
  for (const phrase of [
    "AI の書き戻しと、自動処理の履歴の表への書込は、変えた人が空のことがあります。",
    "`on_create/on_update`",
    "`manual`",
    "`schedule`",
    "`inbound`",
    "その書込の履歴も残らない",
  ]) {
    expect(section).toContain(phrase);
  }
});

test("(K-5) MANUAL.md: 行の変更履歴の節と箇条(根の docs の3本は tools/docs/record-history-docs.test.ts が見る)", () => {
  const manual = read("MANUAL.md");
  const start = manual.indexOf(MANUAL_SECTION);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = manual.slice(start + MANUAL_SECTION.length);
  const end = rest.indexOf("\n## ");
  const manualSection = rest.slice(0, end < 0 ? undefined : end);
  for (const phrase of [
    "`history: true`",
    "`list_record_history`",
    "undo",
    "配る版と日次のバックアップ",
  ]) {
    expect(manualSection).toContain(phrase);
  }
  expect(manualSection).not.toMatch(INTERNAL_SYMBOLS);
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

// ---------------------------------------------------------------------------------------
// (D) ID の付け替え・同じ ID で足し直した項目・大きさ(`V23-M8-T13` の独立点検の処置。決定 `D-V23-232`・`D-V23-233`)
// ---------------------------------------------------------------------------------------

/** 人の読み物(である調)の綴り。 */
const DOC_RENAME = "表と項目の ID を変える差分(`change_table` と `change_field` の `id`)は断られる";
const DOC_RENAME_AFTER =
  "外してから ID を変えると、それより前の履歴は `history` を戻しても読めない";
const DOC_READD = "項目を消して同じ ID で足し直すと、前の項目の過去の値が、新しい項目の変更として";
const DOC_SIZE =
  "履歴は消えずに増え続けるので、undo のための控えと配る版と日次のバックアップは、その分だけ大きくなる";

test("(D-1) できないこと: ID の付け替えは断られる・同じ ID で足し直した項目・大きさ", () => {
  const p = cannotParagraph();
  for (const phrase of [
    "**履歴を取っている表(history: true)では、表の ID と項目の ID を変えられません**",
    "外してから ID を変えると、それより前の履歴は history を戻しても読めません",
    "**項目を消して同じ ID で足し直すと、前の項目の過去の値が、新しい項目の変更として履歴に出ます**",
    "**履歴は消えずに増え続けるので、undo のための控えと配る版と日次のバックアップは、その分だけ大きくなります。**",
  ]) {
    expect(p).toContain(phrase);
  }
  expect(p).not.toMatch(INTERNAL_SYMBOLS);
});

test("(D-2) diff-shape の本体と cannot-do.md・view-shape の 5h・MANUAL.md に、ID の付け替えの一文", () => {
  const diffSkill = read(`${SKILLS}/diff-shape/SKILL.md`);
  const tail = diffSkill.slice(diffSkill.lastIndexOf("**【訂正。上の文は消していない】**"));
  expect(tail).toContain(DOC_RENAME);
  expect(tail).toContain(DOC_RENAME_AFTER);
  expect(tail).not.toMatch(INTERNAL_SYMBOLS);

  const cannot = sectionOf(read(DIFF_CANNOT), DIFF_CANNOT_SECTION);
  for (const phrase of [DOC_RENAME, DOC_RENAME_AFTER, DOC_READD, DOC_SIZE]) {
    expect(cannot).toContain(phrase);
  }

  const view = sectionOf(read(VIEW_SHAPE), VIEW_SECTION);
  for (const phrase of [DOC_RENAME, DOC_READD]) {
    expect(view).toContain(phrase);
  }

  const manual = read("MANUAL.md");
  const start = manual.indexOf(MANUAL_SECTION);
  const rest = manual.slice(start + MANUAL_SECTION.length);
  const end = rest.indexOf("\n## ");
  const manualSection = rest.slice(0, end < 0 ? undefined : end);
  for (const phrase of [DOC_RENAME, DOC_RENAME_AFTER, DOC_READD, DOC_SIZE]) {
    expect(manualSection).toContain(phrase);
  }
  for (const text of [cannot, view, manualSection]) {
    expect(text).not.toMatch(INTERNAL_SYMBOLS);
  }
});
