/**
 * **行への招待(`access_control.invitations` と `workspace.invitations`)が、AI と人の読み物に届いていること**
 * (`V23-M5-T08`。上位: `docs/adr/0532-row-invitation-accept-judgment-and-group-rewrite.md` §限界1・2 と
 * 不利な材料3〜5、計画 `docs/plan/v23/00-v23-plan.md` §24-3 の T08 と §24-6 の中6・軽7・軽13)。
 *
 * `V23-M5-T02`〜`T06` で招待を出す・受ける口と画面が入った。 読み物が旧いままだと、AI は
 * 「宣言を書けても手段は無い」「set_workspace のキーは2つ」と読み、限界(列挙の防ぎは発行の口の中だけ・
 * undo と招待の交わり・承諾できない場合)を知らずにアプリを組む。
 *
 * **このファイルは新しい検査である**(既存の検査の期待値を1つも動かさない)。 見るのは次の字面:
 *   1. 語彙の全量(`VOCABULARY_SCOPE`): 5キー・`group_from`・最後の管理者・置き忘れ・set_workspace の3つ目・AI に道具が無い
 *   2. できないこと(`CANNOT_DO`): 入口・列挙・undo・dry-run・承諾できない場合・履歴・書き出したアプリ
 *   3. `apply_diff` の道具説明: 「キーは navigation と my_page」の後ろに3つ目の訂正
 *   4. 説明書: diff-shape(本体と参照2本)・view-shape・app-build・automation-shape の参照
 *   5. 足した節に内部記号が1つも無いこと
 *
 * **この検査がしないこと**: 文が正しいかは見ない。 見るのは決めた綴りが在るかだけである。
 * 振る舞いは `src/server/row-invitations.test.ts` と `web/test/row-invitations-screen.test.tsx` が見る。
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./server.ts";
import { CANNOT_DO, CANNOT_DO_INDEX, VOCABULARY_SCOPE } from "./vocabulary.ts";

const UNIT_ROOT = join(import.meta.dir, "..", "..");
const read = (path: string): string => readFileSync(join(UNIT_ROOT, path), "utf-8");

const SKILLS = "plugins/smailtalk/skills";
const DIFF_SHAPE = `${SKILLS}/diff-shape/SKILL.md`;
const DIFF_KEYS = `${SKILLS}/diff-shape/reference/op-required-keys.md`;
const DIFF_CANNOT = `${SKILLS}/diff-shape/reference/cannot-do.md`;
const VIEW_SHAPE = `${SKILLS}/view-shape/SKILL.md`;
const APP_BUILD = `${SKILLS}/app-build/SKILL.md`;
const AUTO_CANNOT = `${SKILLS}/automation-shape/reference/cannot-do.md`;

const DIFF_SECTION = "## 3c. 行への招待(`access_control.invitations`)";
const VIEW_SECTION = "## 5e. 行への招待の画面(`workspace.invitations`)";
const APP_SECTION = "## 7c. 行ごとに人を招待したいとき";
const DIFF_CANNOT_SECTION = "## 行への招待でできないこと";
const AUTO_CANNOT_SECTION = "## 行への招待と自動処理";

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
  /D-V\d+-|SC-G\d|ADR-\d|V\d+-M\d|門A|限定\d|ROUTES|judgeRowInvitationAccept/;

/** 語彙の全量の招待の段(見出しの文から終わりまで)。 */
function scopeParagraph(): string {
  const start = VOCABULARY_SCOPE.indexOf("**行への招待(2026-09-30 に加わりました)**");
  return start < 0 ? "" : VOCABULARY_SCOPE.slice(start);
}

/** できないことの招待の段(見出しの文から、直後の総括「これら(グラフ」の手前まで)。 */
function cannotParagraph(): string {
  const start = CANNOT_DO.indexOf("**行への招待について書きます(2026-09-30)**");
  if (start < 0) return "";
  const end = CANNOT_DO.indexOf("これら(グラフ", start);
  return CANNOT_DO.slice(start, end < 0 ? undefined : end);
}

test("(S-1) 語彙の全量: 10個目のキー invitations と中の5キー・必須は grantable だけ・値域", () => {
  const p = scopeParagraph();
  expect(p).not.toBe("");
  expect(p).toContain("表の設定 access_control に10個目のキー invitations を書くと");
  expect(p).toContain(
    "中は by / grantable / target_roles / expires_days / group_from の5つで、必須は grantable だけです",
  );
  expect(p).toContain("省くと creator_permission と同じ");
  expect(p).toContain("運営者は by によらず招待できます");
  expect(p).toContain("anonymous は書けません");
  expect(p).toContain("1〜30、省くと7");
});

test("(S-2) 語彙の全量: group_from の条件と、最後の管理者が消える承諾の断り", () => {
  const p = scopeParagraph();
  expect(p).toContain("group_from は、この表の reference 項目の ID です");
  expect(p).toContain("members.group を宣言していないと適用時に断られます");
  expect(p).toContain(
    "前のグループを通じてだけ管理者だった行の管理者が0人になるときは、承諾を断ります",
  );
  expect(p).toContain("運営者が名簿を直接書き換える操作は今日どおり断りません");
});

test("(S-3) 語彙の全量: 置き忘れの拒否と、set_workspace の3つ目のキー(「2つ」への訂正)", () => {
  const p = scopeParagraph();
  expect(p).toContain("同じ差分で set_workspace の3つ目のキー invitations");
  expect(p).toContain("置き忘れると差分全体が拒否されます");
  const old = VOCABULARY_SCOPE.indexOf("(キーは navigation と my_page の2つ)");
  const fix = VOCABULARY_SCOPE.indexOf(
    "set_workspace の直下のキーは navigation / my_page / invitations の3つです",
  );
  expect(old).toBeGreaterThanOrEqual(0);
  expect(fix).toBeGreaterThan(old);
});

test("(S-4) 語彙の全量: 招待は画面と HTTP だけで、AI(MCP)と4つの入口には無い・承諾が起こす自動処理", () => {
  const p = scopeParagraph();
  expect(p).toContain("招待は画面と HTTP だけで出し・受けます");
  expect(p).toContain("あなた(AI の口)には招待を出す・見る・承諾する道具はありません");
  expect(p).toContain(
    "受信口・自動処理・関数(コードの島)・決まった時刻の処理にも招待の操作はありません",
  );
  expect(p).toContain("どちらも $actor は承諾した人です");
});

test("(C-1) できないこと: 入口(MCP に道具が無い)と、列挙の防ぎが発行の口の中だけであること", () => {
  const p = cannotParagraph();
  expect(p).not.toBe("");
  expect(p).toContain("MCP に招待の道具はありません");
  expect(p).toContain("招待を扱えるのは画面と HTTP だけです");
  expect(p).toContain("この防ぎは発行の口の中だけで");
  expect(p).toContain("会員登録の口(同じ名前は 409)とログインの応答時間から");
});

test("(C-2) できないこと: 承諾できない場合・届かない場合・見えない場合", () => {
  const p = cannotParagraph();
  for (const phrase of [
    "発行したときに存在しなかったログイン名には",
    "名簿に行が無い人は承諾できません",
    "名簿への自動登録を宣言すれば避けられます",
    "付与を記録する表への書込の規則が無いと",
    "承諾して付与の行ができても行は見えません",
    "by の人は自分より強い権限を配れます",
    "同じ付与が2行になることがあります",
  ]) {
    expect(p).toContain(phrase);
  }
});

test("(C-3) できないこと: undo と招待・dry-run の応答・履歴・書き出したアプリ", () => {
  const p = cannotParagraph();
  for (const phrase of [
    "undo で戻すと招待の表も戻ります",
    "招待の表ができる前まで戻すと未承諾の招待は全部消え",
    "取り消した招待が戻ることがあり",
    "redo では undo と redo の間に出した招待が消えます",
    "dry_run_diff の応答には、招待をしまう内部の表の列名と件数が載ります",
    "今日の版では、承諾・辞退・取消は変更の履歴に残りません",
    "書き出したアプリ(独立して動かす版)には、行の招待も受け取り画面もありません",
  ]) {
    expect(p).toContain(phrase);
  }
});

test("(C-4) できないこと: 見出しの括弧を足していない(接続直後に載る見出しの一覧が伸びない)", () => {
  expect(CANNOT_DO_INDEX).not.toContain("招待");
  expect(CANNOT_DO_INDEX).not.toContain("invitations");
});

/** 接続して `apply_diff` の道具説明を読む(`set-workspace-my-page-docs.test.ts` と同じ読み方)。 */
async function applyDiffDescription(): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "gp-mcp-row-invitations-docs-"));
  const server = createMcpServer({ dataRoot, previewBaseUrl: "http://localhost:5173", actor: "a" });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const listed = await client.listTools();
    return listed.tools.find((one) => one.name === "apply_diff")?.description ?? "";
  } finally {
    await client.close();
    await server.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test("(T-1) apply_diff の道具説明: 「キーは navigation と my_page」の後ろに3つ目の訂正がある", async () => {
  const description = await applyDiffDescription();
  const old = description.indexOf("(キーは navigation と my_page)");
  const fix = description.indexOf("訂正します。キーは今日3つで、3つ目の invitations は");
  expect(old).toBeGreaterThanOrEqual(0);
  expect(fix).toBeGreaterThan(old);
  expect(description.slice(fix)).toContain("あなたには招待を出す道具はありません");
});

test("(K-1) diff-shape の本体: 3c の節が、手段はまだ無いの訂正・5キー・group_from・入口ごとの表を持つ", () => {
  const body = read(DIFF_SHAPE);
  const oldAt = body.indexOf("今日の版では、宣言を書けても招待を出す・受ける手段はまだ無い");
  const section = sectionOf(body, DIFF_SECTION);
  expect(oldAt).toBeGreaterThanOrEqual(0);
  expect(section).not.toBe("");
  expect(body.indexOf(DIFF_SECTION)).toBeGreaterThan(oldAt);
  expect(section).toContain(
    "「今日の版では、宣言を書けても招待を出す・受ける手段はまだ無い」は今日は偽である",
  );
  for (const key of ["`by`", "`grantable`", "`target_roles`", "`expires_days`", "`group_from`"]) {
    expect(section).toContain(key);
  }
  expect(section).toContain("| 入口 | 招待の操作 |");
  for (const row of [
    "| 画面",
    "| HTTP",
    "| あなた(AI の口。MCP)",
    "| 受信口",
    "| 自動処理",
    "| 関数(コードの島)",
    "| 決まった時刻の処理",
  ]) {
    expect(section).toContain(row);
  }
  expect(section).toContain("最後の管理者");
  // 表のセルに縦棒を書いていない(どの行も縦棒は3本)。
  for (const line of section.split("\n").filter((l) => l.startsWith("| "))) {
    expect(line.split("|").length - 1).toBe(3);
  }
});

test("(K-2) diff-shape の本体と参照: set_workspace のキーが3つになった訂正が、旧い「2つ」の後ろにある", () => {
  for (const path of [DIFF_SHAPE, DIFF_KEYS]) {
    const body = read(path);
    const old = body.indexOf("(キーは `navigation` とマイページの `my_page` の2つ)");
    const fix = body.indexOf("キーは `navigation` / `my_page` / `invitations` の3つである");
    expect(old).toBeGreaterThanOrEqual(0);
    expect(fix).toBeGreaterThan(old);
  }
});

test("(K-3) diff-shape の cannot-do.md: 招待の限界の節が、できないことの逐語を引く", () => {
  const section = sectionOf(read(DIFF_CANNOT), DIFF_CANNOT_SECTION);
  expect(section).not.toBe("");
  expect(section).toContain("MCP に招待の道具はありません");
  expect(section).toContain("この防ぎは発行の口の中だけで");
  expect(section).toContain("undo で戻すと招待の表も戻ります");
});

test("(K-4) view-shape の本体: 5e の節(受け取り画面・行の詳細の招待・見せるもの)と、5b の「2つ」の訂正", () => {
  const body = read(VIEW_SHAPE);
  const section = sectionOf(body, VIEW_SECTION);
  expect(section).not.toBe("");
  expect(section).toContain("`label`");
  expect(section).toContain("「招待する」");
  expect(section).toContain("代表項目");
  const old = body.indexOf("(キーは `navigation` と、下の 5c の `my_page` の2つ)");
  const fix = body.indexOf("キーは `navigation` / `my_page` / `invitations` の3つである");
  expect(old).toBeGreaterThanOrEqual(0);
  expect(fix).toBeGreaterThan(old);
});

test("(K-5) app-build の本体: 7c の節(承諾できるように組む順序)", () => {
  const section = sectionOf(read(APP_BUILD), APP_SECTION);
  expect(section).not.toBe("");
  expect(section).toContain("`invitations`");
  expect(section).toContain("`auto_enroll`");
  expect(section).toContain("`unique`");
  expect(section).toContain("書込の規則");
});

test("(K-6) automation-shape の cannot-do.md: 自動処理・島・時刻・受信口に招待の操作が無いこと", () => {
  const section = sectionOf(read(AUTO_CANNOT), AUTO_CANNOT_SECTION);
  expect(section).not.toBe("");
  expect(section).toContain(
    "受信口・自動処理・関数(コードの島)・決まった時刻の処理にも招待の操作はありません",
  );
  expect(section).toContain("承諾した人");
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

// 【2026-09-30。`V23-M5-T11` の独立点検の処置で足した】承諾で入れるグループは招待者自身のグループに限ること・
// 受け取り画面が承諾で所属グループが替わるかを見せること(上位 `ADR-0537` §1・§2)が、読み物に1文ずつ届いていること。
const GROUP_LIMIT = "招待した人自身の名簿のグループと同じ値のときだけ";
const GROUP_NOTE = "承諾すると所属グループが替わり、今のグループを通した権限は無くなります";

test("(S-5) 語彙の全量: グループ欄に書くのは招待した人自身のグループと同じときだけ・受け取り画面の1文", () => {
  const p = scopeParagraph();
  expect(p).toContain(GROUP_LIMIT);
  expect(p).toContain("招待した人が運営者なら問いません");
  expect(p).toContain(GROUP_NOTE);
});

test("(C-5) できないこと: 招待した人の入っていないグループへは入れられない・グループの名前は出ない", () => {
  const p = cannotParagraph();
  expect(p).toContain("招待した人の入っていないグループへ受け手を入れることはできません");
  expect(p).toContain(GROUP_LIMIT);
  expect(p).toContain("受け取り画面にはグループの名前は出ません");
  expect(p).not.toMatch(INTERNAL_SYMBOLS);
});

test("(K-7) 説明書: diff-shape の 3c と cannot-do.md・view-shape の 5e に1文ずつ", () => {
  const diff = sectionOf(read(DIFF_SHAPE), DIFF_SECTION);
  expect(diff).toContain(GROUP_LIMIT);
  const cannot = sectionOf(read(DIFF_CANNOT), DIFF_CANNOT_SECTION);
  expect(cannot).toContain("招待した人の入っていないグループへ受け手を入れることはできません");
  expect(cannot).toContain("受け取り画面にはグループの名前は出ません");
  const view = sectionOf(read(VIEW_SHAPE), VIEW_SECTION);
  expect(view).toContain(GROUP_NOTE);
  for (const section of [diff, cannot, view]) {
    expect(section).not.toMatch(INTERNAL_SYMBOLS);
  }
});
