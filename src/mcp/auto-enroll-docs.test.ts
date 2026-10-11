/**
 * **名簿への自動登録(`access_control.members.auto_enroll`)と、行の最後の管理者が、AI と人の読み物に届いていること**
 * (`V23-M1-T09`。上位: `docs/adr/0497-auto-enroll-and-last-row-admin.md`・授権 `ADR-0510` 行12・行40)。
 *
 * `V23-M1-T02`〜`T08` で次が入った。 読み物が旧いままだと、AI は「名簿に人を足すのは運営の手作業だけ」
 * 「管理者はいつでも自分の付与を外せる」「運営の一覧に並ぶのは付与が0件の行だけ」と読む。
 *   - 名簿の4つ目のキー `auto_enroll`(登録・役割の付与・宣言の適用で名簿に1行入る / 退会で消える /
 *     本人は名前の列だけ書ける / `account` の重複を断る)
 *   - 自動で入れる名簿に必須の列を足すと、登録と役割の付与が断られる(メインの裁定 `D-V23-34`)
 *   - 名簿に同じ利用者の行が既に複数あると、その名簿への追加と更新が断られ、消せば直る(`D-V23-38`)
 *   - 行の最後の管理者は自分の付与を外せない(409。運営は外せる。自動処理は主体を問わず断る)
 *   - 運営の回復の一覧に、管理者のいない行が理由付きで並ぶ(引き継ぎ元に管理者がいれば並ばない)
 *
 * **このファイルは新しい検査である**(既存の検査の期待値を1つも動かさない)。 見るのは次の字面:
 *   1. 語彙の全量(`VOCABULARY_SCOPE`)
 *   2. できないこと(`CANNOT_DO`)。 旧文(並ぶのは付与0件の行だけ)が残っていることも見る
 *   3. 説明書 diff-shape の `SKILL.md`・`reference/op-required-keys.md`・`reference/cannot-do.md`
 *   4. 説明書 app-build の `SKILL.md`(名簿の最初の1行の節)
 *   5. 足した読み物に内部記号(決定の番号・単位の記号・v23 の ADR 番号)が1つも無いこと
 *
 * **この検査がしないこと**: 文が読めるか・正しいかは見ない。 見るのは決めた綴りが在るかだけである。
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lastRowAdminError } from "../server/errors.ts";
import { CANNOT_DO, CANNOT_DO_INDEX, VOCABULARY_SCOPE } from "./vocabulary.ts";

const UNIT_ROOT = join(import.meta.dir, "..", "..");
const read = (path: string): string => readFileSync(join(UNIT_ROOT, path), "utf-8");

const DIFF_SHAPE = "plugins/smailtalk/skills/diff-shape/SKILL.md";
const OP_KEYS = "plugins/smailtalk/skills/diff-shape/reference/op-required-keys.md";
const DIFF_CANNOT = "plugins/smailtalk/skills/diff-shape/reference/cannot-do.md";
const APP_BUILD = "plugins/smailtalk/skills/app-build/SKILL.md";

/** 409 の文面(利用者に見える逐語)。 実装の1本から取る(書き写さない)。 */
const LAST_ADMIN_MESSAGE = lastRowAdminError().message;

/**
 * 足した読み物に出してはならない内部記号(v23 の決定・単位・ADR 番号)。
 * **【`V23-M1-T13` で足した】** 門A・限定N・段とタスクの記号(`V23-M1-T05` など)・入口の一覧の名(`ROUTES`)・
 * 入口の型の名(`EntryTrigger`)も拾う(独立点検の指摘)。
 */
const INTERNAL_SYMBOLS =
  /D-V23-|SC-G\d|ADR-0?(49[6-9]|5[0-9][0-9])|門A|限定\d|V23-M\d|ROUTES|EntryTrigger/;

/**
 * **v23 より前から語彙の全量に在る「限定N」の綴り**(`V9-M1-T01` の移動より前から在る。v23 が足した文ではない)。
 * (P-1) はこの逐語だけを除いてから内部記号を探す。 除く逐語の数が増えないことは (P-1c) が見る。
 */
const PRE_V23_RESIDUE = ["(限定12 不変)", "action_value(限定12)"];
const stripResidue = (body: string): string =>
  PRE_V23_RESIDUE.reduce((acc, residue) => acc.split(residue).join(""), body);

test("(S-1) 語彙の全量: auto_enroll の形と、書くと起きること・書かない名簿では起きないことを言う", () => {
  for (const word of ["auto_enroll", "roles", "名簿への自動登録", "退会すると", "name の列だけ"]) {
    expect(VOCABULARY_SCOPE).toContain(word);
  }
  expect(VOCABULARY_SCOPE).toContain("auto_enroll を書かない名簿では、どれも起きません");
});

test("(S-2) 語彙の全量: 必須の列を足すと登録できなくなること・重複の断りと直し方を言う", () => {
  expect(VOCABULARY_SCOPE).toContain("その役割での登録と役割の付与が断られます");
  expect(VOCABULARY_SCOPE).toContain("同じ利用者の行が複数あります");
  expect(VOCABULARY_SCOPE).toContain("余分な行を消せば直ります");
});

test("(C-1) できないこと: 最後の管理者は自分の権限を外せず、409 の文面は実装と1文字も違わない", () => {
  expect(CANNOT_DO).toContain(LAST_ADMIN_MESSAGE);
  expect(CANNOT_DO).toContain("行の最後の管理者は自分の権限を外せません");
  expect(CANNOT_DO).toContain("運営者が画面や HTTP から直接外すことはできます");
  expect(CANNOT_DO).toContain("その実行は失敗として履歴に残ります");
  expect(CANNOT_DO).toContain("引き継ぎ元のどこかの段に管理者がいれば、外せます");
});

test("(C-2) できないこと: 運営の一覧に管理者のいない行も並ぶこと(旧文は消さずに訂正する)", () => {
  // 旧文は消していない(訂正の作法)。
  expect(CANNOT_DO).toContain(
    "並ぶのは、付与が1件も無く、引き継ぎのどの段にも付与が無い行だけです",
  );
  expect(CANNOT_DO).toContain("その一覧には、管理者のいない行も並びます");
  expect(CANNOT_DO).toContain("他の人の閲覧の付与が残っていても、管理者が1人もいなければ並びます");
  expect(CANNOT_DO).toContain(
    "一覧を開けるのは今日も運営者だけで、一覧から付与を書くことはできません",
  );
});

test("(C-3) できないこと: 訂正に見出しの括弧を使っていない(接続直後に載る見出しの一覧が伸びない)", () => {
  expect(CANNOT_DO_INDEX).not.toContain("最後の管理者");
  expect(CANNOT_DO_INDEX).not.toContain("auto_enroll");
});

test("(K-1) diff-shape の SKILL.md: 名簿の自動登録で起きること・必須の列・重複・最後の管理者を言う", () => {
  const body = read(DIFF_SHAPE);
  // T02 で足した訂正(旧文は消していない)。
  expect(body).toContain("**`members` は3キー**");
  expect(body).toContain("**`members` は4キー**");
  expect(body).toContain("自動で入れる名簿に、`account` と `name` の外で必須の列");
  expect(body).toContain("同じ利用者の行が複数あります");
  expect(body).toContain(LAST_ADMIN_MESSAGE);
  expect(body).toContain("管理者のいない行");
});

test("(K-2) op-required-keys.md: auto_enroll を書く差分・断られる7つ・同じ差分で直すことを言う", () => {
  const body = read(OP_KEYS);
  expect(body).toContain("## 名簿への自動登録(`auto_enroll`)を書く・外す差分");
  for (const word of [
    "`add_table`",
    "`change_table`",
    "`set_roles`",
    "`remove_field`",
    "`change_field`",
  ]) {
    expect(body).toContain(word);
  }
  expect(body).toContain("同じ差分で `change_table` も直す");
  expect(body).toContain("重複の件数");
});

test("(K-3) diff-shape の cannot-do.md: 最後の管理者の節が CANNOT_DO の逐語を引く", () => {
  const body = read(DIFF_CANNOT);
  expect(body).toContain("## 行の最後の管理者の権限を外すこと");
  expect(body).toContain(LAST_ADMIN_MESSAGE);
});

test("(K-4) app-build の SKILL.md: 「名簿に自動では1行も入らない」の旧文を残し、auto_enroll の訂正を足す", () => {
  const body = read(APP_BUILD);
  expect(body).toContain("**プラットフォームは名簿に自動では1行も入らない**");
  expect(body).toContain("名簿に `auto_enroll` を宣言した表では偽である");
  expect(body).toContain("自動で入れる名簿に、`account` と `name` の外で必須の列");
  expect(body).toContain("行の最後の管理者は自分の権限を外せない");
});

test("(P-1) 足した読み物に内部記号が1つも無い", () => {
  const sites: [string, string][] = [
    ["VOCABULARY_SCOPE", VOCABULARY_SCOPE],
    ["CANNOT_DO", CANNOT_DO],
    [DIFF_SHAPE, read(DIFF_SHAPE)],
    [OP_KEYS, read(OP_KEYS)],
    [DIFF_CANNOT, read(DIFF_CANNOT)],
    [APP_BUILD, read(APP_BUILD)],
  ];
  for (const [label, body] of sites) {
    expect(stripResidue(body).match(INTERNAL_SYMBOLS)?.[0], label).toBeUndefined();
  }
});

test("(P-1b) 陽性対照: 内部記号の式は、実在の綴りを当てる", () => {
  expect("決定 D-V23-34 による".match(INTERNAL_SYMBOLS)).not.toBeNull();
  expect("ADR-0497 の".match(INTERNAL_SYMBOLS)).not.toBeNull();
  expect("単位 SC-G1".match(INTERNAL_SYMBOLS)).not.toBeNull();
  expect("ADR-0300 の".match(INTERNAL_SYMBOLS)).toBeNull();
  // `V23-M1-T13` で足した綴り。
  expect("門A の本審査".match(INTERNAL_SYMBOLS)).not.toBeNull();
  expect("限定3 により".match(INTERNAL_SYMBOLS)).not.toBeNull();
  expect("V23-M1-T05 で".match(INTERNAL_SYMBOLS)).not.toBeNull();
  expect("ROUTES の行14".match(INTERNAL_SYMBOLS)).not.toBeNull();
  expect("EntryTrigger の6値".match(INTERNAL_SYMBOLS)).not.toBeNull();
  // 除く逐語は、除かなければ当たる(除く処理が素通りしていない)。
  expect(PRE_V23_RESIDUE[0]?.match(INTERNAL_SYMBOLS)).not.toBeNull();
  expect(stripResidue(`x${PRE_V23_RESIDUE[0]}y`)).toBe("xy");
});

test("(P-1c) v23 より前からの「限定N」の逐語は、語彙の全量に1回ずつだけ在り、他の読み物には無い", () => {
  for (const residue of PRE_V23_RESIDUE) {
    expect(VOCABULARY_SCOPE.split(residue).length - 1, residue).toBe(1);
    expect(CANNOT_DO.split(residue).length - 1, residue).toBe(0);
  }
});

// 【2026-10-02 追記。上の検査を1バイトも変えていない】名簿の埋め戻しが、対象の組が増えた差分のときだけ走ることの説明。
test("D-V23-236・D-V23-252: 語彙・できないこと・説明書に、埋め戻しは対象の組が増えた差分のときだけで、消した行は役割を配り直すまで戻らず、dry_run_diff は見せないと書いてある", () => {
  const spellings = [
    "(名簿の表と役割の組)が増えた",
    "役割を配り直すか名簿に手で足すまで戻",
    "dry_run_diff",
  ];
  // 旧文「宣言を足した差分を適用した時点で」は消さずに残す。
  expect(VOCABULARY_SCOPE).toContain("宣言を足した差分を適用した時点で");
  const tail = (text: string, from: string): string =>
    text.includes(from) ? text.slice(text.indexOf(from)) : "";
  for (const [name, text] of [
    ["VOCABULARY_SCOPE", tail(VOCABULARY_SCOPE, "上の (2) は今日この字面のとおり")],
    ["CANNOT_DO", tail(CANNOT_DO, "名簿への自動登録を書いたアプリで差分を適用したとき")],
    [DIFF_CANNOT, tail(read(DIFF_CANNOT), "名簿への自動登録を書いたアプリで差分を適用したとき")],
    [DIFF_SHAPE, tail(read(DIFF_SHAPE), "名簿へ入れ直すのは、自動登録の対象")],
    [OP_KEYS, tail(read(OP_KEYS), "名簿へ入れ直すのは、自動登録の対象")],
    [APP_BUILD, tail(read(APP_BUILD), "名簿へ入れ直すのは、自動登録の対象")],
  ] as const) {
    expect(text.length, `${name} に追記がある`).toBeGreaterThan(0);
    for (const spelling of spellings) {
      expect(text.slice(0, 600), `${name} に ${spelling}`).toContain(spelling);
    }
  }
});

// 【2026-10-02 追記。上の検査を1バイトも変えていない】要件ドキュメントに出るもの・出ないもの(自動登録と最後の管理者)。
test("D-V23-238・D-V23-254・D-V23-258: できないことと説明書に、要件ドキュメントに最後の管理者と自動登録の文が出て、reject・関数の入力 actor と previous・workspace の invitations は出ないと書いてある", () => {
  const head = "要件ドキュメントには、行ごとの付与を名簿とあわせて宣言した表について";
  const spellings = [
    "行の最後の管理者の付与は外せないことが1文出ます",
    "権限名は出ません",
    "新しい宣言を書いていないアプリにも出ます",
    "利用者として登録したときと、その役割を配られたときに名簿に載るか",
    "reject",
    "actor と previous",
    "invitations",
    "要件ドキュメントに出ません",
  ];
  const tail = (text: string): string =>
    text.includes(head) ? text.slice(text.indexOf(head)) : "";
  for (const [name, text] of [
    ["CANNOT_DO", tail(CANNOT_DO)],
    [DIFF_CANNOT, tail(read(DIFF_CANNOT))],
    [DIFF_SHAPE, tail(read(DIFF_SHAPE))],
  ] as const) {
    expect(text.length, `${name} に追記がある`).toBeGreaterThan(0);
    for (const spelling of spellings) {
      expect(text.slice(0, 500), `${name} に ${spelling}`).toContain(spelling);
    }
    // ログインでは載らない(載るのは登録と役割の配布のとき)。
    expect(text.slice(0, 500), `${name} にログインと書いていない`).not.toContain("ログイン");
  }
});

// 【2026-10-02 追記】AI の書き戻しで主体が分からないときの更新者の欄。
test("D-V23-253: 語彙・できないこと・説明書に、act_as も持ち主の列も無いとき AI の書き戻しは更新者の欄を書き換えず直前の値のまま残すと書いてある", () => {
  const AUTOMATION_SHAPE = "plugins/smailtalk/skills/automation-shape/SKILL.md";
  const AUTOMATION_CANNOT = "plugins/smailtalk/skills/automation-shape/reference/cannot-do.md";
  const head = "act_as を書かず、きっかけの行に持ち主の列(st_owner)も無い";
  const spellings = ["$actor は空", "更新者の欄を書き換えず", "直前の値"];
  // 旧文は消さずに残す。
  expect(CANNOT_DO).toContain(
    "その処理が誰として動いているか(act_as の先の持ち主か、きっかけの行の持ち主)になります",
  );
  const tail = (text: string): string =>
    text.includes(head) ? text.slice(text.indexOf(head)) : "";
  for (const [name, text] of [
    ["VOCABULARY_SCOPE", tail(VOCABULARY_SCOPE)],
    ["CANNOT_DO", tail(CANNOT_DO)],
    [AUTOMATION_CANNOT, tail(read(AUTOMATION_CANNOT))],
    [AUTOMATION_SHAPE, tail(read(AUTOMATION_SHAPE))],
  ] as const) {
    expect(text.length, `${name} に訂正がある`).toBeGreaterThan(0);
    for (const spelling of spellings) {
      expect(text.slice(0, 300), `${name} に ${spelling}`).toContain(spelling);
    }
  }
});

// 【2026-10-02 追記。上の検査を1バイトも変えていない】T09(説明書と語彙の食い違いの直し)。
// 点検役2人と適用表の照合で拾った食い違いのうち、重・中の件と、決定で説明書に書くと決めた件の綴りを見る。
const T09_VIEW_SHAPE = "plugins/smailtalk/skills/view-shape/SKILL.md";
const T09_AUTOMATION_SHAPE = "plugins/smailtalk/skills/automation-shape/SKILL.md";
const T09_AUTOMATION_CANNOT = "plugins/smailtalk/skills/automation-shape/reference/cannot-do.md";
const T09_VOCABULARY_SOURCE = "src/mcp/vocabulary.ts";

test("D-V23-255: 語彙・できないこと・説明書に、役割の規則の条件に st_updated_by を書けて、最後に更新した人を条件にでき、自動処理の更新でも書き換わると書いてある", () => {
  // 旧文は消さずに残す。
  expect(CANNOT_DO).toContain("**更新者の欄は、誰が見える・書けるの判定には使えません。**");
  const fix = "st_updated_by は役割の規則の条件(when)に書けて、最後に更新した人を条件にできます";
  expect(CANNOT_DO).toContain(fix);
  expect(read(T09_AUTOMATION_CANNOT)).toContain(fix);
  expect(VOCABULARY_SCOPE).toContain(
    "役割の規則の条件(when)に st_updated_by を書くと、最後に更新した人を条件にできます",
  );
  expect(read(T09_VIEW_SHAPE)).toContain(
    "役割の規則の条件(`when`)には `st_updated_by` を書けて、最後に更新した人を条件にできる",
  );
  // 同じ行に st_updated_by・条件・規則がある行が、語彙の源に1行以上ある(門A の式と同じ数え方)。
  const lines = read(T09_VOCABULARY_SOURCE)
    .split("\n")
    .filter(
      (line) => line.includes("st_updated_by") && line.includes("条件") && line.includes("規則"),
    );
  expect(lines.length).toBeGreaterThanOrEqual(1);
});

test("D-V23-241・D-V23-245: できないこと・説明書に、関係を終えるときは付与した側が付与の行を消すことと、前のコードを使えなくしたいときはコードを再発行することが書いてある", () => {
  const end = "関係(契約)を終えるときは、守る行の側(付与した側)が付与の行を消してください";
  const reissue = "前のコードを使えなくしたいときは、相手の行の管理者がコードを再発行してください";
  for (const [name, text] of [
    ["CANNOT_DO", CANNOT_DO],
    [DIFF_CANNOT, read(DIFF_CANNOT)],
  ] as const) {
    expect(text, `${name} に関係の終え方`).toContain(end);
    expect(text, `${name} にコードの再発行`).toContain(reissue);
  }
  expect(read(DIFF_SHAPE)).toContain(
    "関係(契約)を終えるときは、付与した側(守る行の側)が付与の行を消す",
  );
  expect(read(DIFF_SHAPE)).toContain(
    "前のコードを使えなくしたいときは、相手の行の管理者がコードを再発行する",
  );
  expect(read(APP_BUILD)).toContain("契約を終えるときは、付与した側(組織の側)が付与の行を消す");
});

test("D-V23-247: できないこと・説明書に、書き出したアプリの自動処理は名乗りをきっかけの行の持ち主の列から取り、持ち主の列の無い表をきっかけにすると作成ごと断られると書いてある", () => {
  const fix =
    "書き出したアプリ(独立して動かす版)の自動処理は、名乗りをきっかけの行の持ち主の列から取ります";
  expect(CANNOT_DO).toContain(fix);
  expect(read(T09_AUTOMATION_CANNOT)).toContain(fix);
  expect(read(T09_AUTOMATION_SHAPE)).toContain(
    "書き出したアプリの自動処理は、名乗りをきっかけの行の持ち主の列から取る",
  );
});

test("D-V23-251: できないこと・語彙・説明書に、自動処理が名簿やグループを書き換えて最後の管理者を実質消せる形は断らないことと、preview_undo が行の変更履歴を数えないことが書いてある", () => {
  const admin = "付与の行は残ったまま管理者が実在しなくなる形は断りません";
  expect(CANNOT_DO).toContain(admin);
  expect(read(DIFF_CANNOT)).toContain(admin);
  expect(read(DIFF_SHAPE)).toContain("付与の行は残ったまま管理者が実在しなくなる形");
  const undo = "preview_undo の失われる行・戻る行には、行の変更履歴は数えられません";
  expect(CANNOT_DO).toContain(undo);
  expect(read(DIFF_CANNOT)).toContain(undo);
  expect(VOCABULARY_SCOPE).toContain(undo);
  expect(read(DIFF_SHAPE)).toContain(
    "`preview_undo` の失われる行・戻る行には、行の変更履歴は数えられない",
  );
});

test("D-V23-248: 点検役2人と適用表の照合で拾った重・中の食い違いに、旧文を消さずに訂正が書き足してある", () => {
  // 最後の管理者: 運営者は AI の口からも外せる。 409 は画面と HTTP だけ。
  expect(CANNOT_DO).toContain(
    "運営者は、画面と HTTP に加えて、あなた(AI の口)からも、運営者として名乗っていれば直接外せます",
  );
  expect(CANNOT_DO).toContain("**運営者が画面や HTTP から直接外すことはできます。**");
  // 名簿の name の書換には書込の規則が要る・受信口の吸収・書込が断られる理由。
  expect(VOCABULARY_SCOPE).toContain("その人の役割に名簿の表への書込(write)の規則が要ります");
  expect(read(DIFF_SHAPE)).toContain("その人の役割に名簿の表への書込(`write`)の規則が要る");
  expect(VOCABULARY_SCOPE).toContain("受信口は今日どおり重複を吸収して 200 を返します");
  expect(VOCABULARY_SCOPE).toContain("名簿への書込が断られる理由は必須の列だけではありません");
  // 子の表に行を作れる権限の、適用時に断られる5つの形。
  expect(VOCABULARY_SCOPE).toContain("create_child を書いた差分が適用時に断られる形は5つです");
  expect(read(DIFF_SHAPE)).toContain("`create_child` を書いた差分が適用時に断られる形は5つ");
  // 案内先の名指し(「§3a の最後の訂正」が別の段落に着く)。
  expect(read(T09_VIEW_SHAPE)).toContain(
    "「2026-10-01 訂正。7キー目 `create_child` が入った」の段落",
  );
  // 画面の history は詳細画面だけ・道具は27本。
  expect(read(T09_VIEW_SHAPE)).toContain("`history` は `detail_view` にだけ書ける");
  expect(read(T09_VIEW_SHAPE)).toContain("今日は27本であり");
  expect(read(OP_KEYS)).toContain("今日は27本であり");
  expect(read(T09_VOCABULARY_SOURCE).split("(直前の「26本」は今日は27本です)。").length - 1).toBe(
    4,
  );
  // 関数の例: 検査だけの島の呼び方と、§5 の最初の例が動かないこと。
  expect(read(T09_AUTOMATION_SHAPE)).toContain(
    "`output_table` で呼ぶと、返した行で出力先の表が全置換される",
  );
  expect(read(T09_AUTOMATION_SHAPE)).toContain(
    "上の `add_function` の例の `code` は、そのままでは動かない",
  );
  // 時刻の処理の連鎖の先の reject・ボタンと時刻の処理で作った行の付与。
  expect(CANNOT_DO).toContain("時刻の処理から直接呼んだ関数の reject は、今日どおり汎用の失敗で");
  expect(CANNOT_DO).toContain(
    "画面のボタンから動かす手動の処理と、決まった時刻の処理のアクションも入ります",
  );
  // 招待の HTTP の口の状態コード・AI が履歴から招待を読めること。
  expect(read(DIFF_SHAPE)).toContain("承諾を判定で断るときは `403` と理由の文");
  expect(CANNOT_DO).toContain(
    "あなたは list_record_history で、その行に出た招待・承諾・辞退・取消の記録を読めます",
  );
  // 撃って確かめた訂正: 表を足し直したときの履歴・受信口と子の表・$now を select へ書く。
  expect(CANNOT_DO).toContain("同じ ID の表を足し直して history: true を書くと偽です");
  expect(CANNOT_DO).toContain("受信口からもその親の下に子の行を作れます");
  expect(VOCABULARY_SCOPE).toContain(
    "$now を select・reference・file の項目へ書く差分は、適用時には断られませんが",
  );
  // 語彙の全量の読む順。
  expect(VOCABULARY_SCOPE).toContain(
    "その後の付与の一覧・principal_labels・コードの道具の3文は、行を相手にした付与についての文です",
  );
});
