/**
 * **人向けの読み物(`MANUAL.md`・`README.md`)に、v23 の前半の機能(名簿への自動登録と行の最後の管理者・
 * 作った人への付与・アプリが決めた断りの文言・操作した人と更新者の欄・行への招待)の節と、2026-10-02 に変わった
 * 挙動が届いていること**(`V23-M9-T10`。決定 `D-V23-248`。上位は計画 `docs/plan/v23/00-v23-plan.md` §28-3 の T10)。
 *
 * 行を相手にした付与・子の表に行を作れる権限・行の変更履歴の節は前から在り、それらが前提にしている招待と最後の
 * 管理者の説明が無かった(点検の記録 `records/v23-m9-t00-drift-a.md` の D-06、`v23-m9-t00-drift-b.md`)。
 *
 * リポジトリの根の読み物(`docs/manual.md`・`docs/mcp-quickstart.md`・根の `README.md`)は公開単位の外なので、
 * ここでは読まない(`tools/docs/human-docs-v23-features.test.ts` が見る)。
 *
 * **このファイルは新しい検査である**(既存の検査の期待値を1つも動かさない)。 見るのは決めた綴りが在るかと、
 * 足した節に内部記号と業種の語が無いことだけで、文が正しいかは見ない(振る舞いは各段の検査が見る)。
 * `src/kernel` から値を取り込まない(道具の名は `src/mcp/tools/*.ts` を文字として読む)。
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const UNIT_ROOT = join(import.meta.dir, "..", "..");
const read = (path: string): string => readFileSync(join(UNIT_ROOT, path), "utf-8");

/** 足した節に出してはならない内部記号(決定・門・台帳・穴・段の番号)。 */
const INTERNAL_SYMBOLS =
  /D-V\d+-|SC-G\d|ADR-\d|V\d+-M\d|H-V\d+-|門A|限定\d|ROUTES|(^|[^A-Za-z0-9_])M\d+(?![0-9A-Za-z])/m;
/** 足した節に出してはならない業種の語。 */
const INDUSTRY_WORDS = /在庫|注文|商品|顧客|ポイント|\border\b/;

const MANUAL = "MANUAL.md";
const M8_HEAD = "### 行の変更履歴(2026-10-02)";
const M6_HEAD = "### 行を相手にした付与と行の招待用コード(2026-10-01)";
const M7_HEAD = "### 子の表に行を作れる権限(2026-10-01)";
const NEXT_CHAPTER = "## 取り消しが効くもの・効かないもの";

const H_ENROLL = "### 名簿への自動登録と行の最後の管理者(2026-09-29)";
const H_CREATOR = "### 行の作成と作った人への付与(2026-09-29)";
const H_REJECT = "### アプリが決めた断りの文言(2026-09-29)";
const H_ACTOR = "### 操作した人・更新前の値・今の時刻と更新者の欄(2026-09-30)";
const H_INVITE = "### 行への招待(2026-09-30)";
const H_MARKER = "### ログインしていない読み手と印の2列(2026-10-02)";
const ADDED = [H_ENROLL, H_CREATOR, H_REJECT, H_ACTOR, H_INVITE, H_MARKER];

/** `### ` の見出しから、次の `### `・`## `・`---` の行の手前までを切り出す。 見出しが無ければ空文字。 */
function subsection(body: string, heading: string): string {
  const start = body.indexOf(`\n${heading}\n`);
  if (start < 0) return "";
  const rest = body.slice(start + 1 + heading.length);
  const ends = [rest.indexOf("\n### "), rest.indexOf("\n## "), rest.indexOf("\n---")].filter(
    (n) => n >= 0,
  );
  const end = ends.length > 0 ? Math.min(...ends) : rest.length;
  return heading + rest.slice(0, end);
}

/** 見出しの後ろに足した「(2026-10-02 追記。…)」の箇条から、節の終わりまで。 */
function appendedTail(section: string): string {
  const at = section.indexOf("(2026-10-02 追記。上の行を消していない)");
  return at < 0 ? "" : section.slice(at);
}

/** 道具の名を `src/mcp/tools/*.ts` の `registerTool(` の直後の文字列から拾う(値は取り込まない)。 */
function registeredToolNames(): string[] {
  const dir = join(UNIT_ROOT, "src", "mcp", "tools");
  const names = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const body = readFileSync(join(dir, file), "utf-8");
    for (const m of body.matchAll(/registerTool\(\s*"([a-z_]+)"/g)) {
      names.add(m[1] as string);
    }
  }
  return [...names].sort();
}

describe("D-V23-248: MANUAL.md に v23 の前半の機能の節を、後半の節と同じ粒度で足した", () => {
  test("D-V23-248: 6つの節が、行の変更履歴の節の後・取り消しの章の前に在り、内部記号と業種の語が無い", () => {
    const body = read(MANUAL);
    const m8 = body.indexOf(M8_HEAD);
    const next = body.indexOf(`\n${NEXT_CHAPTER}\n`);
    expect(m8).toBeGreaterThan(0);
    let last = m8;
    for (const heading of ADDED) {
      const at = body.indexOf(`\n${heading}\n`);
      expect(at, heading).toBeGreaterThan(last);
      expect(at, heading).toBeLessThan(next);
      last = at;
      const section = subsection(body, heading);
      expect(section.length, heading).toBeGreaterThan(200);
      expect(section, heading).not.toMatch(INTERNAL_SYMBOLS);
      expect(section, heading).not.toMatch(INDUSTRY_WORDS);
    }
  });

  test("D-V23-248: 名簿への自動登録と最後の管理者の節", () => {
    const s = subsection(read(MANUAL), H_ENROLL);
    for (const phrase of [
      "`auto_enroll`",
      "`roles`",
      "退会すると",
      "名簿の表への書込",
      "役割を外しても、名簿の行は自動では消えない",
      "この行の管理者があなただけになるため、あなたの権限は外せません。先に別の人に管理の権限を渡してください。",
      "運営者は外せる",
      "AI に頼む処理の書き戻し",
      "管理者がいない行も並ぶ",
      "書き出したアプリ",
    ]) {
      expect(s, phrase).toContain(phrase);
    }
  });

  test("D-V23-248: 作った人への付与・断りの文言・操作した人と更新者の欄・行への招待の節", () => {
    const body = read(MANUAL);
    const want: Array<[string, string[]]> = [
      [
        H_CREATOR,
        [
          "`creator_permission`",
          "付与が書けなければ行も残らない",
          "`insert_sample_data`",
          "名乗った本人への付与",
        ],
      ],
      [
        H_REJECT,
        [
          "`unique_message`",
          "`reject`",
          "422",
          '`kind: "app_rejected"`',
          "`failures`",
          "他人の行の値",
          "`write_ops: true`",
        ],
      ],
      [
        H_ACTOR,
        [
          "`$actor.id`",
          "`$previous.<項目>`",
          "`$now`",
          "`changed_fields`",
          "`st_updated_by`",
          "`ST_TIMEZONE`",
          "`source`",
        ],
      ],
      [
        H_INVITE,
        [
          "`invitations`",
          "`grantable`",
          "`group_from`",
          "`set_workspace`",
          "/api/apps/:app_id/tables/:table_id/records/:record_id/invitations",
          "/api/apps/:app_id/invitations/:invitation_id",
          "名簿に行が無い人は承諾できない",
          "AI の口(MCP)には招待を出す・見る・承諾する道具が無い",
        ],
      ],
    ];
    for (const [heading, phrases] of want) {
      const s = subsection(body, heading);
      for (const phrase of phrases) {
        expect(s, `${heading} ${phrase}`).toContain(phrase);
      }
    }
  });

  test("D-V23-248: 古い文は消さずに訂正を書き足した(項目の設定・名前が決まっている項目・書ける値・関数の入力・エラーの形・名簿の最初の1行・道具の一覧)", () => {
    const body = read(MANUAL);
    const after = (anchor: string, phrase: string): void => {
      const a = body.indexOf(anchor);
      expect(a, anchor).toBeGreaterThan(0);
      const p = body.indexOf(phrase, a);
      expect(p, phrase).toBeGreaterThan(a);
    };
    // 旧文が残っていること。
    for (const old of [
      "| `st_no_direct_create` | その表に直接行を作らせない |",
      "`values` と `target` に書けるのは、次のどちらか一方だけである。",
      "入力の元は `table` / `view` / `record` である。",
      '常に `{ "errors": [...] }` の配列で、1件でも配列である。',
      "最初の1行は人が足す。",
    ]) {
      expect(body, old).toContain(old);
    }
    after("### 型と一緒に書ける項目の設定", "項目の設定には今日 `unique_message` もある");
    after("### 名前が決まっている特別な項目", "名前が決まっている項目は今日5つである");
    after("### 書ける値", "`values` の値には今日、次の5つの参照も書ける");
    after("### 入力(`input`)", "入力の元は今日5つである");
    after("### エラーの形", "`422` = アプリが決めた理由の断り");
    after("最初の1行は人が足す。", "名簿への自動登録(`auto_enroll`)を書いた名簿では");
    after("### 書く道具", "上の2つの表は今日3つ足りない");
  });
});

describe("2026-10-02 に変わった挙動が MANUAL.md に届いている", () => {
  test("D-V23-234・D-V23-262: 招待の発行と取消の1件は打ったログイン名で出ること、前に記録された1件の見え方", () => {
    const body = read(MANUAL);
    for (const text of [subsection(body, H_INVITE), appendedTail(subsection(body, M8_HEAD))]) {
      expect(text).toContain("招待した人が打ったログイン名");
      expect(text).toContain("この版より前に記録された発行と取消の1件");
      expect(text).not.toMatch(INTERNAL_SYMBOLS);
    }
  });

  test("D-V23-236・D-V23-252: 名簿の入れ直しは対象の組が増えた差分のときだけで、消した行は配り直すか手で足すまで戻らない", () => {
    const s = subsection(read(MANUAL), H_ENROLL);
    expect(s).toContain("自動登録の対象(名簿の表と役割の組)が増えた差分のときだけ");
    expect(s).toContain("その人に役割を配り直すか、名簿に手で足すまで戻らない");
    expect(s).toContain("ログインしただけでは入らない");
    expect(s).toContain("`dry_run_diff` の応答には、入れ直しで増える名簿の行は載らない");
  });

  test("D-V23-253: AI の書き戻しで誰として動いているかが分からないとき、更新者の欄は直前の値のまま", () => {
    const s = subsection(read(MANUAL), H_ACTOR);
    expect(s).toContain("更新者の欄を書き換えず、直前の値のまま残す");
  });

  test("D-V23-238・D-V23-254: 要件ドキュメントに自動登録と最後の管理者の文が出ること", () => {
    const s = subsection(read(MANUAL), H_ENROLL);
    expect(s).toContain("要件ドキュメントには、自動登録を書いた名簿について");
    expect(s).toContain("要件ドキュメントには、名簿をあわせて宣言した行ごとの付与の表について");
  });

  test("D-V23-239・D-V23-245・D-V23-247: 招待用コードの打ち方・コードを無効にする方法・書き出したアプリの断りの文", () => {
    const tail = appendedTail(subsection(read(MANUAL), M6_HEAD));
    expect(tail).toContain("小文字を大文字に直す");
    expect(tail).toContain("コードを無効にしたいときは再発行する");
    expect(tail).toContain("書き出したアプリでは口から書けないことを言う文");
    expect(tail).not.toMatch(INTERNAL_SYMBOLS);
  });

  test("D-V23-235・D-V23-261・D-V23-264・D-V23-265: 未ログインの印の2列の並べ替えと絞り込み", () => {
    const s = subsection(read(MANUAL), H_MARKER);
    for (const phrase of [
      "`st_undeletable`",
      "`st_no_direct_create`",
      "存在しない項目を名指ししたときと同じ 400",
      "名乗った一覧画面(`?view=`)の宣言と同じ",
      "関連一覧",
      "見出しを押して印の列で並べ替えると、断られて一覧が出ない",
      "200 で 0",
      "ログインした読み手は今日どおり",
    ]) {
      expect(s, phrase).toContain(phrase);
    }
  });

  test("D-V23-242・D-V23-251: さらに読むの読み直しと、preview_undo が履歴を数えないこと", () => {
    const tail = appendedTail(subsection(read(MANUAL), M8_HEAD));
    expect(tail).toContain("最初の50件から読み直す");
    expect(tail).toContain("`history_offset`");
    expect(tail).toContain("`preview_undo` が示す失われる行には、行の変更履歴は数えられない");
    const enroll = subsection(read(MANUAL), H_ENROLL);
    expect(enroll).toContain("管理者が実質いなくなる形も断らない");
  });

  test("D-V23-240・D-V23-247: 書き出したアプリの未ログインの更新者の並べ替えと、自動処理の名乗り", () => {
    const s = subsection(read(MANUAL), H_ACTOR);
    expect(s).toContain("存在しない画面と同じ 400 で断る");
    expect(s).toContain("名乗りが空だと行の作成と書込を一律に断り");
  });

  test("D-V23-244・D-V23-255: 役割の規則の条件に更新者の欄を書けること", () => {
    const s = subsection(read(MANUAL), H_ACTOR);
    expect(s).toContain("役割の規則の条件に `st_updated_by` を書くと効く");
  });

  test("D-V23-248: 子の表に行を作れる権限の節に、入口ごとの断りの文の違い", () => {
    const tail = appendedTail(subsection(read(MANUAL), M7_HEAD));
    expect(tail).toContain("自動処理と受信口では同じ趣旨の別の文");
  });
});

describe("D-V23-248: README.md の道具の一覧", () => {
  test("D-V23-248: 「出している道具」の節に、登録している道具の名が全部在る", () => {
    const body = read("README.md");
    const start = body.indexOf("### 出している道具");
    expect(start).toBeGreaterThan(0);
    const end = body.indexOf("\n### ", start + 1);
    const section = body.slice(start, end < 0 ? undefined : end);
    const names = registeredToolNames();
    expect(names.length).toBe(27);
    const missing = names.filter((n) => !section.includes(`\`${n}\``));
    expect(missing).toEqual([]);
    expect(section).not.toMatch(INTERNAL_SYMBOLS);
  });
});

describe("D-V23-248: 人向けの読み物の追いつき(T10b)。撃って確かめた挙動と、説明書だけ直っていた件", () => {
  const FRAGMENTS: string[] = [
    // 付与の一覧の相手の名前
    "付与の一覧の相手の名前は、HTTP の一覧の応答と、AI の口の `list_records` の応答の `principal_labels`(返す行と同じ順の配列)に載る",
    // $now を select へ書く
    "`$now` を `select`・`reference`・`file` の項目へ書く差分は、適用では断られないが、実行のたびに値の検査で書込が断られる",
    // 表を消して足し直す
    "同じ ID の表を足し直して `history: true` を書くと、消す前に1行ずつ消していた行の履歴は、運営者が AI の `list_record_history` で読める",
    // 受信口と create_child
    "運営者が名簿に受信の書き手(`system:inbound`)の行を足し、親の行の管理者がその行へ `create_child` を持つ権限を付与すれば、受信口からも子の行を作れる",
    // 招待の記録を AI が読める
    "履歴を取っている表では、`list_record_history` が行の招待の発行・承諾・辞退・取消の1件も返す",
    // 自己修復
    "運営者が1人も居なくなったときに最も古い利用者を運営者へ自動で上げる仕組みで運営者になった人は、`roles` に `owner` を書いていても名簿に入らない",
    // undo の章
    "`preview_undo` は行の変更履歴を数えない。 undo すると、その差分より後の行の履歴も一緒に消える(redo で戻る)",
  ];

  test("D-V23-248: MANUAL.md に7つの要の文が在り、内部記号と業種の語が無い", () => {
    const body = read(MANUAL);
    for (const f of FRAGMENTS) {
      expect(body).toContain(f);
      expect(f).not.toMatch(INTERNAL_SYMBOLS);
      expect(f).not.toMatch(INDUSTRY_WORDS);
    }
  });
});

describe("D-V23-269: 独立点検の指摘の処置(T13b)。MANUAL.md・語彙・説明書に書き足した訂正", () => {
  const MANUAL_FRAGMENTS: string[] = [
    // 点検A 中1: 最後の管理者を外せないのは運営者でない人
    "直前の段落の「`update_record` と `delete_record` で行の最後の管理者の権限は外せない」は、運営者でない人のことである。 AI の口で運営者として名乗っていれば外せる",
    // 点検A 中2: 入口で AI の書き戻しと分かるは誤り
    "直前の行の括弧書き「入口で AI の書き戻しと分かる」は誤り。 その書込の変更履歴の入口は「自動処理」と出て、AI の書き戻しを表す入口は無いので、入口と空の変えた人からは AI の書き戻しと見分けられない。",
    // 点検B 軽2: 前の版の発行と後の版の取消で出方が割れる
    "この版より前に出した名前の招待をこの版の後で取り消すと、発行の1件は前の出方(相手が居れば表示名)、取消の1件は打ったログイン名で出て、同じ招待の2件の出方が割れる。",
  ];

  test("D-V23-269: MANUAL.md に3つの訂正が在り、内部記号と業種の語が無い", () => {
    const body = read(MANUAL);
    for (const f of MANUAL_FRAGMENTS) {
      expect(body).toContain(f);
      expect(f).not.toMatch(INTERNAL_SYMBOLS);
      expect(f).not.toMatch(INDUSTRY_WORDS);
    }
  });

  test("D-V23-269: 語彙の CANNOT_DO と automation-shape の cannot-do.md に、入口で見分けられない訂正が同じ位置に在る", () => {
    const correction =
      "(入口で AI の書き戻しと分かります)。訂正します(2026-10-02)。直前の括弧書き「入口で AI の書き戻しと分かります」は誤りです。AI の書き戻しの変更の履歴の入口は自動処理(on_create/on_update)と出て、AI の書き戻しを表す入口の値はありません。入口と空の変えた人からは、AI の書き戻しと見分けられません。";
    expect(read("src/mcp/vocabulary.ts")).toContain(correction);
    expect(read("plugins/smailtalk/skills/automation-shape/reference/cannot-do.md")).toContain(
      correction,
    );
  });

  test("D-V23-269: automation-shape の cannot-do.md の入口ごとの表の AI の行に訂正が在る", () => {
    const body = read("plugins/smailtalk/skills/automation-shape/reference/cannot-do.md");
    expect(body).toContain(
      "上の表の AI に頼む処理の書き戻しの行は、`act_as` を書かず、きっかけの行に持ち主の列(`st_owner`)も無い表では誤り。",
    );
    expect(body).toContain("実行の履歴の行には何も押されず、空(null)のまま(空文字ではない)。");
  });
});
