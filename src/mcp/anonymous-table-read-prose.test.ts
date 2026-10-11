/**
 * **未ログインの表ごとの読取・未ログインにだけ隠す項目・入口とログイン画面の場所 —— AI に配る散文の訂正の見張り**
 * (v21 の波及の段。判断の正はリポジトリの `docs/adr/0482-anonymous-table-read-hidden-fields-entry-login.md`)。
 *
 * ## 何を固定するか
 *
 * 1. **旧文を消していないこと**(このリポジトリの作法。偽になった文は消さず、隣に訂正を置く)。
 * 2. **訂正が旧文の後ろに在ること**(前に置くと「訂正の後にまた旧文」と読める)。
 *    **読取の段落の「公開指定(st_public が真の行)は未認証でも GET できます」は今日も真なので補わない** ——
 *    直後の「直前の2文が述べているのは…」の指す先がずれるため。広がった範囲は (e) の訂正に書く。
 * 3. **訂正が、できるようになったことと、限界の両方を書いていること**(片方だけだと逆向きの嘘になる)。
 * 4. **訂正に内部の記号(段・単位・穴・決定の番号)を書いていないこと**(読むのはアプリを作る人)。
 * 5. **訂正に `【…】` を使っていないこと**(`CANNOT_DO_INDEX` が見出しの数を数えているため)。
 *
 * ## しないこと
 *
 * - **散文が正しいかは、ここに挙げた綴りの有無でしか見ていない。** 言い回しは1文字も判定しない。
 * - **挙動は見ていない。** 挙動の検査は `src/server/` と `src/kernel/` の各検査が持つ。
 */

import { describe, expect, test } from "bun:test";
import { CANNOT_DO, VOCABULARY_SCOPE } from "./vocabulary.ts";

/** 表の画面の段落の (e) の旧文(逐語)。 */
const OLD_E =
  "(e)**anonymous に read を書いても、その画面に行が出るとは限りません** —— " +
  "未ログインに返る行は今日どおり st_public が true の行だけなので、" +
  "**公開でないテーブルの画面を anonymous に開くと、画面は開けても中身は空か 401 になります。**";

/** (e) の訂正の書き出し(逐語)。 */
const E_CORRECTION_HEAD =
  "**訂正します(2026-09-27。上のどの文も消していません)。上の (e) の「未ログインに返る行は今日どおり st_public が true の行だけ」は今日は偽です** —— ";

/** 画像とファイルの段落の旧文(逐語)。 */
const OLD_IMAGE = "(image は公開行が参照していれば未ログインでも見られます)。";

/** 画像とファイルの段落の補い(逐語の書き出し)。 */
const IMAGE_SUPPLEMENT_HEAD =
  "**補います(2026-09-27。直前の括弧は今日も真で、消していません)。未ログインに配信される image は公開行のものだけではありません** —— ";

/** 訂正の塊を取り出す(書き出しから、次の段落の書き出し「(**予約規約フィールドは今日4本です**」の手前まで)。 */
function correctionBlock(): string {
  const start = CANNOT_DO.indexOf(E_CORRECTION_HEAD);
  const end = CANNOT_DO.indexOf("(**予約規約フィールドは今日4本です**", start);
  return start < 0 || end < 0 ? "" : CANNOT_DO.slice(start, end);
}

/** v21 の内部記号(公開する文に書かない)。 */
const V21_SYMBOLS: readonly RegExp[] = [/AN-G[0-9]/, /H-V2[0-9]-/, /V2[0-9]-M[0-9]/, /D-V2[0-9]/];

describe("未ログインの表ごとの読取: CANNOT_DO の (e) の訂正", () => {
  test("(A1) 旧文 (e) は消していない", () => {
    expect(CANNOT_DO).toContain(OLD_E);
  });

  test("(A2) (e) の訂正が在り、旧文より後ろに在る", () => {
    const oldAt = CANNOT_DO.indexOf(OLD_E);
    const fixAt = CANNOT_DO.indexOf(E_CORRECTION_HEAD);
    expect({ 旧文: oldAt >= 0, 訂正: fixAt >= 0, 後ろ: fixAt > oldAt }).toEqual({
      旧文: true,
      訂正: true,
      後ろ: true,
    });
  });

  test("(A3) できるようになったことを書いている(表ごとの読取・書込は断る・公開の印の表は今日のまま)", () => {
    const block = correctionBlock();
    for (const phrase of [
      "対象 table・can に read の規則を書いた表は、st_public が無くても",
      "規則に条件(when)を書いたときは条件に合う行だけ",
      "書き込み・削除は今日どおり 401",
      "集計表(report_view)も未ログインには開きません",
      "st_public を持つ表は今日のままです",
    ]) {
      expect(block).toContain(phrase);
    }
  });

  test("(A4) 読めない表(書けるが効かない)と、守りを外す差分の拒否を書いている", () => {
    const block = correctionBlock();
    for (const phrase of [
      "st_owner を持つ表",
      "access_control を宣言した表",
      "「自分」(equals_current_user)",
      "差分は通りますが、効きません",
      "守りを外す差分は",
      "適用の前に拒否されます",
    ]) {
      expect(block).toContain(phrase);
    }
  });

  test("(A5) 未ログインにだけ隠す項目(hidden_fields)の書き方と効き方を書いている", () => {
    const block = correctionBlock();
    for (const phrase of [
      '"hidden_fields"',
      "値も項目名も渡らず",
      "並べ替え・絞り込み・合計・区切りにも使えません",
      "ログインした人の見え方は1つも変わりません",
      "書けるのは anonymous の表の規則だけです",
    ]) {
      expect(block).toContain(phrase);
    }
  });

  test("(A6) 隠す書き方の限界を書いている(隠し忘れ・公開画面の絞り込み・参照の名前・file の ID)", () => {
    const block = correctionBlock();
    for (const phrase of [
      "後から足した項目も",
      "絞り込み(filter)に隠した項目を1つでも使うと",
      "隠した項目を使わないでください",
      "「見つかりません」",
      "file 型の値(ファイルのID)は、隠さなければ行に載ります",
    ]) {
      expect(block).toContain(phrase);
    }
  });

  test("(A7) 画面(参照の名前・入口・ログイン画面の場所)と、書き出したアプリと、MCP の口を書いている", () => {
    const block = correctionBlock();
    for (const phrase of [
      "参照の列は、参照先の表も未ログインで読めるときは名前で出ます",
      "/apps/<アプリID>/login",
      "並び順で最初のもの",
      "書き出したアプリ",
      "行を読む口は同じ答えを返します",
      "あなた(MCP)の口には、未ログインの経路は1本もありません",
    ]) {
      expect(block).toContain(phrase);
    }
  });

  test("(A8) 訂正に内部の記号と【】を書いていない", () => {
    const block = correctionBlock();
    expect(block.length).toBeGreaterThan(0);
    expect({
      記号: V21_SYMBOLS.filter((pattern) => pattern.test(block)).map(String),
      見出しの括弧: block.includes("【"),
    }).toEqual({ 記号: [], 見出しの括弧: false });
  });
});

describe("未ログインの表ごとの読取: 画像の段落の補い", () => {
  test("(B2) 画像の段落: 旧文を消さず、直後に補いが在る(VOCABULARY_SCOPE)", () => {
    const oldAt = VOCABULARY_SCOPE.indexOf(OLD_IMAGE);
    expect(oldAt).toBeGreaterThanOrEqual(0);
    expect(VOCABULARY_SCOPE.indexOf(IMAGE_SUPPLEMENT_HEAD)).toBe(oldAt + OLD_IMAGE.length);
  });

  test("(B3) 補いに内部の記号と【】を書いていない", () => {
    for (const [text, head] of [[VOCABULARY_SCOPE, IMAGE_SUPPLEMENT_HEAD]] as const) {
      const at = text.indexOf(head);
      const slice = at < 0 ? "" : text.slice(at, at + 600);
      expect(slice.length).toBeGreaterThan(0);
      expect(V21_SYMBOLS.filter((pattern) => pattern.test(slice)).map(String)).toEqual([]);
      expect(slice.includes("【")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 入口の選び方の訂正(2026-09-28)。 未ログインの入口は、メニューに載せる公開の一覧画面の先頭になった。
// 旧文(「画面の並び順で最初のものが出ます」)は消さず、直後に訂正を足す。
// ---------------------------------------------------------------------------

/** 入口の段落の旧文の末尾(逐語。消していないこと)。 */
const OLD_ENTRY_TAIL =
  "(未ログインに開いた一覧画面が1つも無いアプリは、今日どおり入口でログイン画面が出ます)。";

/** 入口の訂正の書き出し(逐語)。 */
const ENTRY_CORRECTION_HEAD =
  "訂正します(2026-09-28。直前の文は消していません)。入口に選ばれるのは、";

describe("未ログインの入口: CANNOT_DO のメニューに載せない画面の訂正", () => {
  test("(C1) 旧文を消さず、その直後に訂正が在る", () => {
    const oldAt = CANNOT_DO.indexOf(OLD_ENTRY_TAIL);
    expect(oldAt).toBeGreaterThanOrEqual(0);
    expect(CANNOT_DO.indexOf(ENTRY_CORRECTION_HEAD)).toBe(oldAt + OLD_ENTRY_TAIL.length);
  });

  test("(C2) 訂正は、載せない画面が入口に選ばれないこと・1つも無いときの選び方・メニューとリンクから外れること・URL で開けることを書いている", () => {
    const at = CANNOT_DO.indexOf(ENTRY_CORRECTION_HEAD);
    const slice = at < 0 ? "" : CANNOT_DO.slice(at, at + 400);
    for (const phrase of [
      "メニューに載せるもの(menu_listed を false にしていないもの)",
      "メニューに載せる一覧画面が1つも無いときだけ",
      "未ログインのメニューとログイン画面の画面の一覧にも、メニューに載せない画面は出ません",
      "URL を直に開けば今日どおり開けます",
    ]) {
      expect(slice).toContain(phrase);
    }
  });

  test("(C3) 訂正は (e) の訂正の塊の中に在り、内部の記号と【】を書いていない", () => {
    const block = correctionBlock();
    expect(block).toContain(ENTRY_CORRECTION_HEAD);
    const at = block.indexOf(ENTRY_CORRECTION_HEAD);
    const slice = at < 0 ? "" : block.slice(at, at + 400);
    expect({
      記号: [...V21_SYMBOLS, /EN-G[0-9]/, /V22-/, /D-V22/]
        .filter((pattern) => pattern.test(slice))
        .map(String),
      見出しの括弧: slice.includes("【"),
    }).toEqual({ 記号: [], 見出しの括弧: false });
  });
});

// ---------------------------------------------------------------------------
// 未ログインが送る印の2列の並べ替え・絞り込み(2026-10-02)。 旧文は消さず、MCP の口の1文の直後に追記する。
// ---------------------------------------------------------------------------

/** 未ログインの塊の最後の1文(逐語。消していないこと)。 */
const OLD_MCP_TAIL =
  "**あなた(MCP)の口には、未ログインの経路は1本もありません**(名乗りが要ることは今日どおりです)。";

/** 印の2列の追記の書き出し(逐語)。 */
const MARKER_NOTE_HEAD =
  "追記します(2026-10-02)。ログインしていない人は、消せない印(st_undeletable)と直接作れない印(st_no_direct_create)の列を、";

describe("D-V23-261 / D-V23-264: CANNOT_DO に未ログインの印の2列の追記がある", () => {
  test("D-V23-261: 旧文を消さず、その直後に追記が在る", () => {
    const oldAt = CANNOT_DO.indexOf(OLD_MCP_TAIL);
    expect(oldAt).toBeGreaterThanOrEqual(0);
    expect(CANNOT_DO.indexOf(MARKER_NOTE_HEAD)).toBe(oldAt + OLD_MCP_TAIL.length);
  });

  test("D-V23-264: 追記は宣言と同じものだけ通ること・子一覧・見出しの並べ替えが断られること・ログインした人は今日どおりを書き、記号と【】を書かない", () => {
    const at = CANNOT_DO.indexOf(MARKER_NOTE_HEAD);
    const slice = at < 0 ? "" : CANNOT_DO.slice(at, at + 420);
    for (const phrase of [
      "開いた一覧画面の宣言",
      "子一覧(related)の宣言と同じ並べ替え",
      "存在しない項目を名指ししたときと同じ答え",
      "見出しを押して印の列で並べ替えると断られ",
      "ログインした人は今日どおり",
    ]) {
      expect([phrase, slice.includes(phrase)]).toEqual([phrase, true]);
    }
    expect(V21_SYMBOLS.filter((pattern) => pattern.test(slice)).map(String)).toEqual([]);
    expect(slice.includes("【")).toBe(false);
  });
});
