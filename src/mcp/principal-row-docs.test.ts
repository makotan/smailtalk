/**
 * **行を相手にした付与(`access_control.grant.principal_row`)と行の招待用コードが、AI と人の読み物に届いていること**
 * (`V23-M6-T10`。上位: `docs/adr/0538-principal-row-resolution-and-code-invitation.md` §1-8・§限界、
 * 計画 `docs/plan/v23/00-v23-plan.md` §25-3 の T11(§25-6 で T10 に読み替え)と §25-6 の中11、決定 `D-V23-148`・`D-V23-159`・
 * `D-V23-167`・`D-V23-171`・`D-V23-172`)。
 *
 * `V23-M6-T02` が書いたのは語彙の形と適用時の拒否だけで、効き方(1段だけ・中身の読み書きだけ・管理には効かない)、
 * 関係の作り方(コードの発行 → コードで招待 → 相手の行の管理者が承諾)と外し方、書けないこと、入口ごとの効き方、
 * 規模の限界、undo とコード、コードを渡された人に分かること、dry-run に載るもの、書き出したアプリに無いことは、
 * どの読み物にも無かった。
 *
 * **このファイルは新しい検査である**(既存の検査の期待値を1つも動かさない)。 見るのは決めた綴りが在るかだけで、
 * 文が正しいかは見ない。 振る舞いは `src/server/principal-row-*.test.ts`・`row-invite-codes.test.ts`・
 * `row-code-invitations.test.ts` と `web/test/principal-row-screen.test.tsx` が見る。
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

const DIFF_SECTION = "## 3d. 行を相手にした付与(`grant.principal_row`)と行の招待用コード";
const VIEW_SECTION = "## 5f. 行の招待用コードと、相手の行の名前の画面";
const APP_SECTION = "## 7d. 別の組織の人たちに、組織の行をまとめて見せたいとき";
const DIFF_CANNOT_SECTION = "## 行を相手にした付与でできないこと";
const AUTO_CANNOT_SECTION = "## 行を相手にした付与と自動処理";
const MANUAL_SECTION = "### 行を相手にした付与と行の招待用コード(2026-10-01)";

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
  /D-V\d+-|SC-G\d|ADR-\d|V\d+-M\d|門A|限定\d|ROUTES|principalRow[A-Z]|owner-scope|_row_invite_codes/;

const SCOPE_HEAD = "**行を相手にした付与の効き方と、関係の作り方(2026-10-01)**";
const CANNOT_HEAD = "**行を相手にした付与と行の招待用コードについて書きます(2026-10-01)**";

/** 語彙の全量の、効き方と関係の作り方の段(見出しの文から終わりまで)。 */
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

/** 7つの入口(要件書の非機能の「入口ごとの適用を表で明示する」)。 説明書の表の行頭。 */
const ENTRY_ROWS = [
  "| 画面",
  "| HTTP",
  "| あなた(AI の口。MCP)",
  "| 受信口",
  "| 自動処理",
  "| 関数(コードの島)",
  "| 決まった時刻の処理",
];

test("(S-1) 語彙の全量: 効くのは中身の読み書きだけで管理には効かない・上限と子の表・1段だけ", () => {
  const p = scopeParagraph();
  expect(p).not.toBe("");
  for (const phrase of [
    "効くのは行の中身の読み書きだけです",
    "管理には効きません",
    "上限(restrictive)は、相手の行を通じて届いた権限にも効きます",
    "親子(inherit_from)の子の表にも届きます",
    "相手の行の親はたどりません",
    "相手の行の表の側の principal_row もたどりません",
  ]) {
    expect(p).toContain(phrase);
  }
});

test("(S-2) 語彙の全量: 関係の作り方(コードの発行 → コードで招待 → 相手の行の管理者が承諾)と外し方", () => {
  const p = scopeParagraph();
  for (const phrase of [
    "相手の行の管理者が、その行の招待用コードを発行します",
    "そのコードで守る行に招待します",
    "受け取り画面で承諾すると",
    "関係を外すのは、守る行の側が付与の行を消すことです",
    "相手の行の側からは関係を切れません",
    "あなた(AI の口)には、コードを見る・発行する・コードで招待する道具はありません",
  ]) {
    expect(p).toContain(phrase);
  }
  // 関係の作り方は、発行 → 招待 → 承諾の順に書く。
  const issue = p.indexOf("相手の行の管理者が、その行の招待用コードを発行します");
  const invite = p.indexOf("そのコードで守る行に招待します");
  const accept = p.indexOf("受け取り画面で承諾すると");
  expect(issue).toBeLessThan(invite);
  expect(invite).toBeLessThan(accept);
});

test("(S-3) 語彙の全量: 旧い段(T02 の形と拒否)は1バイトも消さず、その後ろに足す", () => {
  const old = VOCABULARY_SCOPE.indexOf("**行を相手にした付与(2026-10-01 に加わりました)**");
  const added = VOCABULARY_SCOPE.indexOf(SCOPE_HEAD);
  expect(old).toBeGreaterThanOrEqual(0);
  expect(added).toBeGreaterThan(old);
});

test("(C-1) できないこと: 相手の列は承諾の外で書けない(7つの入口)・名簿が違う表・相手の側の principal_row", () => {
  const p = cannotParagraph();
  expect(p).not.toBe("");
  for (const phrase of [
    "相手の行を指す欄は、招待の承諾の外では書けません",
    "画面・HTTP・あなた(AI の口)・受信口・自動処理・関数(コードの島)・決まった時刻の処理のどれから書いても断られます",
    "相手の行を指す欄と、利用者やグループの欄を、同じ行に書くことはできません",
    "名簿(members の table)が違う表は、相手に指せません",
    "相手の行の表の側に principal_row は書けません",
    "invitations を宣言していない表では、関係を作る手段がありません",
  ]) {
    expect(p).toContain(phrase);
  }
});

test("(C-2) できないこと: 入口ごとの効き方(読める入口と素通りする入口)", () => {
  const p = cannotParagraph();
  for (const phrase of [
    "相手の行を通じて届いた権限で行を読める・書ける・消せるのは、画面・HTTP・あなた(AI の口)からです",
    "受信口・自動処理・関数(コードの島)・決まった時刻の処理は、今日の付与と同じ扱いです",
    "コードを見る・発行する・コードで招待する・承諾するのは、画面と HTTP だけです",
  ]) {
    expect(p).toContain(phrase);
  }
});

test("(C-3) できないこと: 規模・undo とコード・コードで分かること・dry-run・書き出したアプリ", () => {
  const p = cannotParagraph();
  for (const phrase of [
    "守る表の行がおよそ100件までの規模で使ってください",
    "undo の後は、コードを再発行し直してください",
    "コードを渡された人には、相手の行の名前(代表項目)が分かります",
    "dry_run_diff の応答には、コードをしまう内部の表の列名と件数が載ります",
    "書き出したアプリ(独立して動かす版)には、行の招待用コードもコードの招待もありません",
  ]) {
    expect(p).toContain(phrase);
  }
});

test("(C-4) できないこと: 再発行の前の招待・相手の行を消したとき・承諾の後に入った人・宣言を外したとき・回数", () => {
  const p = cannotParagraph();
  for (const phrase of [
    "再発行の前に古いコードで出した未承諾の招待は、再発行の後も承諾できます",
    "相手の行を消しても付与の行は残ります",
    "承諾の後に相手の行に入った人について、親の行を読めるかは確かめ直しません",
    "宣言を外しても、コードをしまう表とコードは残ります",
    "コードで招待する回数に制限はありません",
  ]) {
    expect(p).toContain(phrase);
  }
});

test("(C-5) できないこと: 見出しの括弧を足していない(接続直後に載る見出しの一覧が伸びない)", () => {
  expect(CANNOT_DO_INDEX).not.toContain("principal_row");
  expect(CANNOT_DO_INDEX).not.toContain("招待用コード");
});

test("(K-1) diff-shape の本体: 3d の節が、例・効き方・関係の作り方と外し方・HTTP の口・7つの入口の表を持つ", () => {
  const body = read(DIFF_SHAPE);
  const section = sectionOf(body, DIFF_SECTION);
  expect(section).not.toBe("");
  // 3c(行への招待)の後ろに置く。
  expect(body.indexOf(DIFF_SECTION)).toBeGreaterThan(
    body.indexOf("## 3c. 行への招待(`access_control.invitations`)"),
  );
  for (const phrase of [
    "`principal_row`",
    "`column`",
    "`via`",
    "管理には効かない",
    "相手の行の側からは関係を切れない",
    "`/invite-code`",
    '`{ "code", "permission" }`',
    "組織およそ100",
    "コードを再発行し直す",
  ]) {
    expect(section).toContain(phrase);
  }
  expect(section).toContain(
    "| 入口 | 相手の行を通じて届く権限 | 相手の行を指す欄への書込 | コードとコードの招待 |",
  );
  for (const row of ENTRY_ROWS) {
    expect(section).toContain(row);
  }
  // 表のセルに縦棒を書いていない(どの行も縦棒は5本)。
  for (const line of section.split("\n").filter((l) => l.startsWith("| "))) {
    expect(line.split("|").length - 1).toBe(5);
  }
});

test("(K-2) diff-shape の cannot-do.md: できないことの段を逐語で引く", () => {
  const section = sectionOf(read(DIFF_CANNOT), DIFF_CANNOT_SECTION);
  expect(section).not.toBe("");
  for (const phrase of [
    "相手の行を指す欄は、招待の承諾の外では書けません",
    "名簿(members の table)が違う表は、相手に指せません",
    "undo の後は、コードを再発行し直してください",
    "相手の行の側からは関係を切れません",
  ]) {
    expect(section).toContain(phrase);
  }
});

test("(K-3) view-shape の本体: 5f の節(コードの欄・招待するの切り替え・受け取り画面・付与表の名前・読むだけの欄)", () => {
  const section = sectionOf(read(VIEW_SHAPE), VIEW_SECTION);
  expect(section).not.toBe("");
  for (const phrase of [
    "「この行の招待用コード」",
    "「再発行」",
    "「相手の行のコードで招待する」",
    "「受ける行」",
    "代表項目",
    "この欄は招待の承諾でだけ入ります",
  ]) {
    expect(section).toContain(phrase);
  }
});

test("(K-4) app-build の本体: 7d の節(相手の表を先に組み、コードを渡して承諾してもらう順序)", () => {
  const section = sectionOf(read(APP_BUILD), APP_SECTION);
  expect(section).not.toBe("");
  for (const phrase of ["`principal_row`", "`invitations`", "コードを", "承諾", "約100"]) {
    expect(section).toContain(phrase);
  }
});

test("(K-5) automation-shape の cannot-do.md: 自動処理・島・時刻・受信口は相手の列を書けず、コードの操作も無い", () => {
  const section = sectionOf(read(AUTO_CANNOT), AUTO_CANNOT_SECTION);
  expect(section).not.toBe("");
  expect(section).toContain("相手の行を指す欄は、招待の承諾の外では書けません");
  expect(section).toContain(
    "コードを見る・発行する・コードで招待する・承諾するのは、画面と HTTP だけです",
  );
});

test("(K-6) MANUAL.md: 行を相手にした付与の節(効き方・関係の作り方と外し方・規模・undo)", () => {
  const body = read(MANUAL);
  const start = body.indexOf(MANUAL_SECTION);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = body.slice(start + MANUAL_SECTION.length);
  const end = rest.indexOf("\n## ");
  const section = rest.slice(0, end < 0 ? undefined : end);
  for (const phrase of [
    "`principal_row`",
    "管理には効かない",
    "承諾",
    "相手の行の側からは",
    "100",
    "undo",
  ]) {
    expect(section).toContain(phrase);
  }
  expect(section).not.toMatch(INTERNAL_SYMBOLS);
});

test("(N-1) 足した節と段に内部記号が1つも無い", () => {
  const texts = [
    scopeParagraph(),
    cannotParagraph(),
    sectionOf(read(DIFF_SHAPE), DIFF_SECTION),
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

test("(F-1) 【独立点検の処置】宣言を戻せる条件と、付け替えの断りの訂正が、旧の文を残したまま全部の読み物に在る", () => {
  const redeclare = "宣言を戻せるのは、相手の列に値の残る付与の行が1件も無いときだけです";
  const relink = "相手の列に値のある付与の行は、守る行・利用者・グループの欄も付け替えられません";
  // 語彙の段と diff-shape の cannot-do.md: 旧の文の後ろに訂正(逐語の引きは同じ並び)。 見出しの括弧は足さない。
  for (const text of [cannotParagraph(), sectionOf(read(DIFF_CANNOT), DIFF_CANNOT_SECTION)]) {
    const old = text.indexOf("宣言を戻すと、前のコードがまた使えます");
    expect(old).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(redeclare)).toBeGreaterThan(old);
    expect(text).toContain(relink);
  }
  expect(CANNOT_DO.match(/【[^】]+】/g) ?? []).toHaveLength(2);
  expect(scopeParagraph()).toContain("相手の列を別の行に付け替えることはできません");
  expect(scopeParagraph()).toContain(relink);
  // diff-shape の本体と MANUAL(docs の手引き2本は公開単位の外なので、この検査では読まない。記録で確かめる)。
  const plain = [
    sectionOf(read(DIFF_SHAPE), DIFF_SECTION),
    read(MANUAL).slice(read(MANUAL).indexOf(MANUAL_SECTION)),
  ];
  for (const text of plain) {
    expect(text).toContain("宣言を外して戻せるのは、相手の列に値の残る付与の行が1件も無いときだけ");
    expect(text).toContain(
      "相手の列に値のある付与の行は、守る行・利用者・グループの欄も付け替えられ",
    );
    expect(text.slice(text.lastIndexOf("相手の列に値のある付与の行は"))).not.toMatch(
      INTERNAL_SYMBOLS,
    );
  }
});
