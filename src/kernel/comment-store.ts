/**
 * コメントの器(`V10-M10-T01` / `CM-G1` / `CM-G3` / `ADR-0366`)。
 * **宛先の形は `V10-M25-T01`(`CM-G25a` / `CM-G25b` / `ADR-0372`)が 7 → 9 に、
 * `V10-M25-T02`(`CM-G26` / `ADR-0372`)が 9 → 11 に広げた。**
 *
 * **利用者が「この画面のここが使いにくい」と書き残す先**である。書かれたものは
 * `kernel.sqlite` の1表に積むだけで、**アプリの定義(マニフェスト)には1バイトも入らない。**
 *
 * `capability-store.ts` / `inbound-store.ts` / `escape-hatch-store.ts` に続く4例目であり、
 * 形はそれらに倣う(ドライバは `bun:sqlite`、日時は ISO8601 UTC の TEXT、SQL 識別子は
 * ダブルクォート・値はプレースホルダ)。
 *
 * ## この器が持たないもの(先に書く。憲法6)
 *
 * - **書込の導線を持たない。** 今日コメントを書ける経路は**この関数を直に呼ぶ1本だけ**である
 *   —— HTTP の口も MCP の道具も1本も無い(`CM-G3` 限定6。足すのは `CM-G4` / `V10-M11-T01`)。
 *   画面にも印(`data-testid` ほか)を1つも足していないので、**11形すべてが今日は
 *   画面から書けない。** **【禁止】「画面のどこにでもコメントできる」と書かない。**
 * - **マニフェストを1度も読まない**(`CM-G1` 限定5 / 憲法1)。定義を読む3つの関数
 *   (現在のマニフェストを読むもの・画面を引くもの・画面の表を解決するもの)を
 *   **1つも呼ばない** —— **その3つの名前を、このファイルは注釈にも書かない**
 *   (ソースを走査する検査を逐語の残置で騙さないため。数え方は
 *    `LC_ALL=C /usr/bin/grep -c` で、このファイルは **0** になる)。
 *   したがって検査するのは
 *   「形の名前が登録簿に在るか」と「部品の数が形の定義と合うか」だけで、
 *   **宛先が実在するかは1度も見ない** —— 実在しない画面IDでも実在しない名札でも書ける。
 * - **画面の種別と形の取り合わせを見ない。** 集計表の画面IDに項目のまとまりを指す形を
 *   書いても止めない。
 * - **語彙を1語も足さない。** `schemas/` を1バイトも触らないので、`$defs` も
 *   `$defs/view.properties` も1キーも増えていない(`CM-G1` 限定1 / 限定2)。
 *
 * ## 宛先の持ち方(`CM-G2` 限定5 / 裁定4)
 *
 * 宛先は **「形の名前 + 汎用スロット2本」** で持つ。種類ごとの列を作らない。
 * **形を1つ足す差分は `COMMENT_ANCHOR_FORMS` に1行足すことだけ**であり、列は1本も増えず、
 * 既存行は1行も `UPDATE` されない。
 *
 * **代償(隠さない)**: **汎用スロットは2本ちょうどである。** 部品が3つ以上の形が来たら
 * 足りない。今日の11形は、部品が最も多いものでも2つである。**3つ目の部品が要る形が来たら
 * `anchor_3` を足すことになり、それは「宛先を固定の列の組にして、形という概念をやめる」
 * 線へ1歩近づく変更なので、そのときは改めて門A を通す**(`ADR-0373` §5 の線2)。
 * **【禁止】これを「いくつでも足せる」と書かない。**
 *
 * ## 置き場(`CM-G3` 限定1 / 限定2 / 限定4)
 *
 * `kernel.sqlite` に `gp_comments` を1本足す(既存10表 → 11表)。**ユーザランドに
 * `_` 始まりのテーブルを1つも作らず、`SYSTEM_TABLE_IDS` を1本も増やさない** ——
 * `isSystemTableId("gp_comments")` は `false` のままである。
 * **既存10表が接頭辞を持たないなかで `gp_` を持つのは本表が1本目である** ——
 * アプリ側の表 `comments`(`app.sqlite`。`support` が実際に持っている)との取り違えを
 * 減らすために採った。**名前の衝突そのものは今日も解消していない**(`CM-G1` 限界7)。
 *
 * **アプリを削除するとそのアプリ宛てのコメントも消える**(`delete-app.ts` の
 * `APP_SCOPED_KERNEL_TABLES` に載せた)。`undo` では巻き戻らないが `delete_app` では消える
 * —— **この性質は本工程が初めて作った。**
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { quoteIdentifier } from "./ddl.ts";
import { kernelDbPath } from "./storage-paths.ts";

/**
 * 宛先の形の登録簿。**形を1つ足す差分は、この配列に1行足すことだけである**
 * (`ADR-0366` `CM-G2` 限定5)。
 *
 * `parts` は宛先の部品の**並び**であり、`anchor_1` / `anchor_2` の順にそのまま入る。
 * **器は部品の中身を1バイトも解釈しない** —— 空白だけでないことしか見ない。
 *
 * **今日は11形ちょうどである。** 8形目 `view_field_link`(表の参照項目の**リンク**への意見)と
 * 9形目 `view_row`(一覧の**行を押したこと**への意見)は `V10-M25-T01` が足した
 * (`CM-G25a` / `CM-G25b` / `ADR-0372`)。10形目 `view_after_save`(**保存した後の行き先**への
 * 意見)と 11形目 `view_after_delete`(**削除した後の行き先**への意見)は `V10-M25-T02` が
 * 足した(`CM-G26` / `ADR-0372`)。**どちらの工程も、足した差分はこの配列の2行だけである。**
 * **一続きの流れそのものを指す形は却下されており、この配列に1行も無い**(`CM-G27` = 却下)。
 * **その綴りを、このファイルは注釈にも書かない** —— 却下の履行を測る式は
 * `LC_ALL=C /usr/bin/grep -c` でこのファイルを走査するので、逐語を注釈に残すと
 * **登録簿に1行も無いのに 0 にならない**(実測で踏んだ。綴りは検査の側にだけ在る)。
 *
 * **`view_field_link` の部品は `view_field` と同じ(`view_id` / `field_id`)であり、
 * `view_row` / `view_after_save` / `view_after_delete` の部品は `view` と同じ(`view_id`)である。**
 * **区別するのは形の名前であって部品ではない**(裁定5)。**行のIDを入れる場所は1つも無い**
 * —— したがって **`view_row` はどの行を押したかを1ミリも表せず、`view_field_link` は
 * リンク先のどの行かを1ミリも表せず、`view_after_save` / `view_after_delete` は
 * どの行を保存したか・どの行を消したかを1ミリも表せない。**
 * **【禁止】これを「データ行を指す形を作った」と読まない。**
 *
 * **`view_after_save` / `view_after_delete` の指し先は、今日1件も実在しないことがある。**
 * ディスク上の3本(`support` / `shop` / `todo`)で `after_delete` を宣言している画面は
 * **0本**であり、`after_save` も `support` 17本中7本・`todo` 4本中1本・`shop` は0本である。
 * **器は宣言の有無を1度も見ないので、宣言を持たない画面IDにも書ける**(限界)。
 */
export const COMMENT_ANCHOR_FORMS = [
  { form: "app", parts: [] },
  { form: "view", parts: ["view_id"] },
  { form: "view_action", parts: ["view_id", "action_id"] },
  { form: "view_field", parts: ["view_id", "field_id"] },
  { form: "view_related", parts: ["view_id", "related_id"] },
  { form: "view_report_node", parts: ["view_id", "report_node_id"] },
  { form: "view_field_group", parts: ["view_id", "field_group_id"] },
  { form: "view_field_link", parts: ["view_id", "field_id"] },
  { form: "view_row", parts: ["view_id"] },
  { form: "view_after_save", parts: ["view_id"] },
  { form: "view_after_delete", parts: ["view_id"] },
] as const satisfies readonly { form: string; parts: readonly string[] }[];

/** 登録簿に在る形の名前。**今日は11。** */
export type CommentAnchorForm = (typeof COMMENT_ANCHOR_FORMS)[number]["form"];

/**
 * コメント1件の状態。**3値ちょうどである。4値目を作らない**(`CM-G19` 限定1)。
 *
 * **この配列が、状態の綴りを書いてよい唯一の場所である。** このファイルの他の場所
 * (注釈を含む)には、3値の綴りを1文字も書かない —— 書くと、ソースを走査して
 * 「呼び出し元が引数で渡す口ただ1本である」ことを固定する検査(`comment-store.test.ts`
 * 「状態を書き換える関数は1本ちょうど」)が、注釈の逐語を拾って空振りする
 * (`COMMENT_ANCHOR_FORMS` の登録簿が「却下された形の綴りを注釈にも書かない」と定めた
 * のと同じ理由)。
 * **説明が要るときは綴らずに書く**(例: 「対応できないという値」「3値」)。
 */
export const COMMENT_STATES = ["open", "not_applicable", "applied"] as const;

/** {@link COMMENT_STATES} に在る状態の名前。 */
export type CommentState = (typeof COMMENT_STATES)[number];

/** 値が {@link COMMENT_STATES} のいずれかであるかを判定する(実行時の値域検査)。 */
function isCommentState(value: string): value is CommentState {
  return (COMMENT_STATES as readonly string[]).includes(value);
}

/**
 * `IN ('a','b','c')` の中身を**値域の配列そのもの**から作る。綴りを SQL に2度書かない
 * ——値域を1つ増やしたら `CHECK` 制約も自動で追随する。
 *
 * `src/kernel/inbound-store.ts:55` に同名・同実装の小関数が既に在るが、`export` されて
 * いないため写せない(2箇所に割り、`export` をそちらへ足すと `Δ8` が別の場所で発火する)。
 * **層をまたいで2箇所に同じ1行の関数を持つほうが、`inbound-store.ts` に `export` を
 * 足すよりも代償が小さいと判断した**(決めた理由。`PLAN-M13.md` §5-1 の指示どおり
 * `inbound-store.ts` は1バイトも触っていない)。
 */
function sqlEnum(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(",");
}

/**
 * `V10-M13` が `gp_comments` に足す列。列名と DDL の対応をここ1箇所に持ち、新規DB
 * (`CREATE TABLE`)と既存DB(`ALTER TABLE ADD COLUMN`)の両方から参照する
 * (`meta-store.ts` の `CHANGELOG_ADDED_COLUMNS` / `addedColumnDefinition` と同じ作法。裁定C)。
 *
 * **`V10-M13-T01` が足したのは `writer` の1本だけである**(裁定A。4本目を作らない)。
 * **`V10-M13-T02` が2本目として `state` を足した**(8列 → 9列)。 **`V10-M13-T03` が
 * 3本目として `reason` を足した**(9列 → 10列。`CM-G20`)。**`V10-M15-T01` が4本目として
 * `diff_id` を足した**(10列 → 11列。`CM-G14`。コメント → 差分 の繋ぎ)。**既存行はすべて
 * 末尾に積むので、`CREATE TABLE` と `ALTER TABLE` で列の並びが1バイトも割れない**(裁定C)。
 */
const COMMENT_ADDED_COLUMNS: readonly { name: string; type: string; default: string }[] = [
  // `writer`(`V10-M13-T01` / `CM-G10`)—— 不透明な文字列1本。`NULL` 可(未認証の行)。
  // **器はこの列を1度も検査しない**(`CM-G10` 限定2)。
  { name: "writer", type: "TEXT", default: "NULL" },
  // `state`(`V10-M13-T02` / `CM-G19`)—— 3値ちょうど。`NOT NULL` で、既定は
  // `COMMENT_STATES` の1本目。**綴りはこの1行にも書かず、`sqlEnum(COMMENT_STATES)` /
  // `` `'${COMMENT_STATES[0]}'` `` から組み立てる**(裁定の実地の担保)。
  {
    name: "state",
    type: `TEXT NOT NULL CHECK("state" IN (${sqlEnum(COMMENT_STATES)}))`,
    default: `'${COMMENT_STATES[0]}'`,
  },
  // `reason`(`V10-M13-T03` / `CM-G20`)—— 対応できないという値に倒すときの理由。自由文
  // 1本、`NULL` 可。**綴りはこの1行にも書かない**(`state` と同じ作法。値域の判定は
  // `COMMENT_STATES` の索引から組み立てる)。**器は中身を1バイトも検査しない**
  // (`CM-G20` 限定3。空白だけでないことしか見ない)。
  { name: "reason", type: "TEXT", default: "NULL" },
  // `diff_id`(`V10-M15-T01` / `CM-G14`)—— **不透明な文字列1本。**`NULL` 可(まだ繋いで
  // いない行)。**器はこの値が実在するかを1ミリも確かめない**(限定4)。新しいコメントは
  // 必ず `null` で生まれる —— `addComment` はこの列を引数に取らない。書き換える経路は
  // {@link CommentStore.linkCommentToDiff} 1本だけである。
  { name: "diff_id", type: "TEXT", default: "NULL" },
];

/** 追加列の列定義(例: `"writer" TEXT DEFAULT NULL`)。識別子は必ず検証して引用する。 */
function addedColumnDefinition(column: (typeof COMMENT_ADDED_COLUMNS)[number]): string {
  return `${quoteIdentifier(column.name)} ${column.type} DEFAULT ${column.default}`;
}

/**
 * コメントの表。**宛先は `anchor_form` + `anchor_1` / `anchor_2` の3列で持つ**(裁定4)。
 * 種類ごとの列を作らないので、形を足しても列は1本も増えない。
 *
 * `anchor_1` / `anchor_2` はどちらも `NULL` 可である —— 部品を持たない形(`app`)と
 * 部品が1つの形(`view` ほか)があるからで、**NULL は「その形にその部品が無い」を意味する。**
 *
 * `V10-M13-T01` が足す `writer` は既存7列の**末尾**に置く(`COMMENT_ADDED_COLUMNS` から生成。裁定C)。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS "gp_comments" (
  "id"          TEXT PRIMARY KEY,
  "app_id"      TEXT NOT NULL,
  "anchor_form" TEXT NOT NULL,
  "anchor_1"    TEXT,
  "anchor_2"    TEXT,
  "body"        TEXT NOT NULL,
  "created_at"  TEXT NOT NULL,
  ${COMMENT_ADDED_COLUMNS.map((column) => addedColumnDefinition(column)).join(",\n  ")}
);

CREATE INDEX IF NOT EXISTS "gp_comments_app_form"
  ON "gp_comments" ("app_id", "anchor_form", "anchor_1");
`;

/**
 * 既存の `gp_comments` に不足している列を足す(冪等。`migrateChangelogColumns` と同じ作法)。
 *
 * `CREATE TABLE IF NOT EXISTS` は既にテーブルがあると何もしないため、`V10-M13-T01` より前に
 * 作られた `kernel.sqlite`(7列)には `writer` が無い。`PRAGMA table_info` で実列を見てから
 * 足りない分だけ `ALTER TABLE ADD COLUMN` する。既存行は `writer = NULL` で埋まる
 * ——**未認証で書かれた行と、移行で埋まった行を区別する手段は無い**(どちらも `NULL`)。
 */
function migrateCommentColumns(db: Database): void {
  const existing = new Set(
    db
      .query<{ name: string }, []>(`PRAGMA table_info("gp_comments")`)
      .all()
      .map((row) => row.name),
  );
  for (const column of COMMENT_ADDED_COLUMNS) {
    if (!existing.has(column.name)) {
      db.exec(`ALTER TABLE "gp_comments" ADD COLUMN ${addedColumnDefinition(column)}`);
    }
  }
}

/** 積まれたコメント1行。 */
export interface Comment {
  id: string;
  appId: string;
  /** 宛先の形の名前(登録簿に在るものだけ)。 */
  anchorForm: CommentAnchorForm;
  /** 宛先の部品(その形の `parts` と同じ長さ・同じ並び)。部品を持たない形では空配列。 */
  anchorParts: string[];
  body: string;
  createdAt: string;
  /**
   * 書き手(`V10-M13-T01` / `CM-G10`)。**不透明な文字列1本。**`NULL` 可 —— 未認証で
   * 書かれた行は `null` になる。**器はこの値を1度も検査しない**(実在するかも、本人かも
   * 確かめない)。空文字 `""` は `null` に丸めない(渡していないことと区別する)。
   */
  writer: string | null;
  /**
   * 状態(`V10-M13-T02` / `CM-G19`)。**{@link COMMENT_STATES} の3値ちょうど。**
   * 新しいコメントは必ず {@link COMMENT_STATES} の1本目で生まれる —— {@link CommentStore.addComment}
   * は状態を引数に取らない。書き換える経路は {@link CommentStore.updateCommentState} 1本だけ。
   */
  state: CommentState;
  /**
   * 理由(`V10-M13-T03` / `CM-G20`)。**自由文1本。**`NULL` 可 —— 対応できないという値
   * (`COMMENT_STATES[1]`)のときだけ非 `null` になる。**器はこの値の中身を1バイトも
   * 検査しない**(空白だけでないことしか見ない)。他の2値へ倒すと `null` に戻る
   * (前の値を残さない。器は履歴を1行も持たない)。
   */
  reason: string | null;
  /**
   * 差分の識別子(`V10-M15-T01` / `CM-G14`)。**繋ぐのは コメント → 差分 の2点である**
   * (中央の「案」に識別子は無い。`CM-G8` = 却下)。**`NULL` 可** —— 新しいコメントは
   * 必ず `null` で生まれる。**不透明な文字列1本**であり、器はこの値が実在するかを
   * 1ミリも確かめない(限定4)。書き換える経路は {@link CommentStore.linkCommentToDiff}
   * 1本だけ —— **上書きすると前の値は1バイトも残らない**(器は履歴を1行も持たない)。
   */
  diffId: string | null;
}

/**
 * コメント追加の入力。`id` / `createdAt` は内部生成する。
 *
 * **`anchorForm` の型は `string` である**(`CommentAnchorForm` に絞らない)。
 * 呼び出し側は HTTP・MCP・AI から来た文字列をそのまま渡すので、**受け口で型に絞ると
 * 実行時の拒否が検査できなくなる** —— 登録簿に在るかどうかは `addComment` が実行時に見る。
 */
export interface AddCommentInput {
  appId: string;
  anchorForm: string;
  anchorParts: string[];
  body: string;
  /**
   * 書き手(任意)。**渡さなければ `writer` は `null` になる。** 渡した文字列は1バイトも
   * 変えずにそのまま入る —— **器はここを1度も解決しない**(`CM-G10` 限定2。呼び出し側が
   * セッション等から取り出した値をそのまま渡す)。`""`(空文字)を渡した場合も `null` に
   * 丸めない(「空文字を渡した」と「渡さなかった」を区別する)。
   */
  writer?: string | null;
}

type CommentRow = {
  id: string;
  app_id: string;
  anchor_form: string;
  anchor_1: string | null;
  anchor_2: string | null;
  body: string;
  created_at: string;
  writer: string | null;
  state: string;
  reason: string | null;
  diff_id: string | null;
};

/** ISO8601 UTC(ミリ秒つき)の現在時刻。 */
function nowIso(): string {
  return new Date().toISOString();
}

/** 登録簿から形の定義を引く。無ければ `undefined`。 */
function findAnchorForm(form: string): (typeof COMMENT_ANCHOR_FORMS)[number] | undefined {
  return COMMENT_ANCHOR_FORMS.find((entry) => entry.form === form);
}

/** 登録簿に在る形の名前を、エラー文に並べる形で返す。 */
function knownFormList(): string {
  return COMMENT_ANCHOR_FORMS.map((entry) => entry.form).join(" / ");
}

/**
 * 宛先を検査し、`anchor_1` / `anchor_2` に入れる値の組を返す。
 *
 * **見るのは「形の名前が登録簿に在るか」と「部品の数が形の定義と合うか」だけである。**
 * **宛先が実在するかは1度も見ない**(`CM-G1` 限定5 / 裁定6)。
 *
 * @throws 登録簿に無い形の名前 / 部品の数が合わない / 部品が空白だけ
 */
function resolveAnchor(
  form: string,
  parts: string[],
): { form: CommentAnchorForm; anchor1: string | null; anchor2: string | null } {
  const entry = findAnchorForm(form);
  if (entry === undefined) {
    throw new Error(
      `コメントの宛先の形 ${JSON.stringify(form)} は受け付けません。` +
        `受け付ける宛先の形は${COMMENT_ANCHOR_FORMS.length}つです: ${knownFormList()}。`,
    );
  }
  if (parts.length !== entry.parts.length) {
    throw new Error(
      `コメントの宛先の形 "${entry.form}" の部品は${entry.parts.length}個` +
        `(${entry.parts.length === 0 ? "無し" : entry.parts.join(" / ")})ですが、` +
        `${parts.length}個渡されました。`,
    );
  }
  parts.forEach((part, index) => {
    if (part.trim() === "") {
      throw new Error(
        `コメントの宛先の形 "${entry.form}" の部品 "${entry.parts[index]}" に` +
          `空文字・空白だけの文字列は指定できません。`,
      );
    }
  });
  return {
    form: entry.form,
    anchor1: parts[0] ?? null,
    anchor2: parts[1] ?? null,
  };
}

/**
 * 状態の値域を検査する。**見るのは {@link COMMENT_STATES} に在るかだけである** ——
 * 誰が倒したか・元の状態が何だったかは1度も見ない(`CM-G19` 限定4)。
 *
 * @throws {@link COMMENT_STATES} に無い値
 */
function resolveCommentState(state: string): CommentState {
  if (!isCommentState(state)) {
    throw new Error(
      `コメントの状態 ${JSON.stringify(state)} は受け付けません。` +
        `受け付ける状態は${COMMENT_STATES.length}つです: ${COMMENT_STATES.join(" / ")}。`,
    );
  }
  return state;
}

/**
 * 理由の値域を検査する(`V10-M13-T03` / `CM-G20` 限定2 / 限定3)。**器は理由の中身を
 * 1バイトも検査しない** —— 空白だけでないことしか見ない。
 *
 * - **対応できないという値(`COMMENT_STATES[1]`)に倒すとき**、理由が未指定 / 空 /
 *   空白だけ → 拒否。
 * - **それ以外の値に倒すとき**、理由が渡された(空文字を含む非 `undefined`)→ 拒否。
 * - **それ以外の値へ倒したら、理由は `null` になる**(前の値を残さない。器は履歴を
 *   1行も持たない)。
 *
 * @throws 上の2条件のいずれか
 */
function resolveReason(state: CommentState, reason: string | undefined): string | null {
  if (state === COMMENT_STATES[1]) {
    if (reason === undefined || reason.trim() === "") {
      throw new Error(
        `対応できないという値(${COMMENT_STATES[1]})に倒すには理由が必要です。` +
          `未指定・空文字・空白だけの理由は受け付けません。`,
      );
    }
    return reason;
  }
  if (reason !== undefined) {
    throw new Error(
      `${JSON.stringify(state)} に倒すときは理由を渡せません。` +
        `理由を渡せるのは対応できないという値(${COMMENT_STATES[1]})だけです。`,
    );
  }
  return null;
}

/** DB 行 → Comment。`NULL` のスロットは部品の並びから落とす。 */
function toComment(row: CommentRow): Comment {
  const anchorParts = [row.anchor_1, row.anchor_2].filter(
    (value): value is string => value !== null,
  );
  return {
    id: row.id,
    appId: row.app_id,
    anchorForm: row.anchor_form as CommentAnchorForm,
    anchorParts,
    body: row.body,
    createdAt: row.created_at,
    writer: row.writer,
    state: row.state as CommentState,
    reason: row.reason,
    diffId: row.diff_id,
  };
}

/**
 * コメントの器。開く DB(`kernel.sqlite`)は必ず `dataRoot` 引数で受け取る
 * (環境変数・ハードコードに依存しない)。テストは一時ディレクトリを渡して
 * リポジトリの `data/` を汚さずに動かせる。
 */
export class CommentStore {
  private readonly db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  /**
   * `<dataRoot>/kernel.sqlite` を開き(なければ作る)、コメントの表を用意する。
   * meta-store.ts / escape-hatch-store.ts と同じ WAL DB を別ハンドルで開くため PRAGMA を倣う。
   * `CREATE TABLE IF NOT EXISTS` なので既存10表には1バイトも触れない。
   */
  static openForKernel(dataRoot: string): CommentStore {
    mkdirSync(dataRoot, { recursive: true });
    const db = new Database(kernelDbPath(dataRoot), { create: true });
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
    migrateCommentColumns(db);
    return new CommentStore(db);
  }

  /** DB を閉じる。以後の操作はエラーになる。 */
  close(): void {
    this.db.close();
  }

  /**
   * コメントを1件積む。`id`(uuid)と `createdAt`(ISO8601)は内部生成する。
   *
   * **拒否するのは4つだけである**: 登録簿に無い形の名前 / 部品の数が形の定義と合わない /
   * 部品が空白だけ / 本文が空。
   * **拒否しないものが2つある**(限界。記録に書く): **宛先が実在しないこと** と
   * **画面の種別に合わない形**。どちらも器がマニフェストを読まないことの帰結である ——
   * **`list_view` 以外の画面に `view_row` を書くことも、器は1度も止めない。**
   *
   * @throws 上の4つ、および `appId` が空のとき
   *
   * **`state` を引数に取らない**(`V10-M13-T02`)。**新しいコメントは必ず
   * {@link COMMENT_STATES} の1本目で生まれる** —— 生まれた時点で最後の値には
   * できない。状態を書き換える経路は {@link updateCommentState} 1本だけである。
   */
  addComment(input: AddCommentInput): Comment {
    if (input.appId.trim() === "") {
      throw new Error("コメントには宛先のアプリID が必要です。空にはできません。");
    }
    if (input.body.trim() === "") {
      throw new Error("コメントの本文は空にできません。");
    }
    const anchor = resolveAnchor(input.anchorForm, input.anchorParts);
    // **書き手は1度も解決しない**(`CM-G10` 限定2)。渡さなかった(`undefined`)ときだけ
    // `null` にし、`""`(空文字)を渡した場合は1バイトも変えずにそのまま入れる
    // ——**丸めると「空文字を渡した」と「渡さなかった」が区別できなくなる。**
    const writer = input.writer === undefined ? null : input.writer;
    const comment: Comment = {
      id: crypto.randomUUID(),
      appId: input.appId,
      anchorForm: anchor.form,
      anchorParts: [...input.anchorParts],
      body: input.body,
      createdAt: nowIso(),
      writer,
      state: COMMENT_STATES[0],
      // **新しいコメントの理由は必ず `null` である**(`V10-M13-T03`)。`addComment` は
      // 理由を引数に取らない —— 理由は対応できないという値に倒したときだけ生まれる。
      reason: null,
      // **新しいコメントの diff_id は必ず `null` である**(`V10-M15-T01`)。`addComment` は
      // 差分の識別子を引数に取らない —— 繋ぎを書く経路は {@link linkCommentToDiff} 1本だけ。
      diffId: null,
    };
    this.db
      .query(
        `INSERT INTO "gp_comments"
           ("id", "app_id", "anchor_form", "anchor_1", "anchor_2", "body", "created_at", "writer", "state")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        comment.id,
        comment.appId,
        comment.anchorForm,
        anchor.anchor1,
        anchor.anchor2,
        comment.body,
        comment.createdAt,
        comment.writer,
        comment.state,
      );
    return comment;
  }

  /** id でコメントを取得する。未登録なら undefined。 */
  getComment(id: string): Comment | undefined {
    const row = this.db
      .query<CommentRow, [string]>(
        `SELECT "id", "app_id", "anchor_form", "anchor_1", "anchor_2", "body", "created_at", "writer", "state", "reason", "diff_id"
         FROM "gp_comments" WHERE "id" = ?`,
      )
      .get(id);
    return row === null ? undefined : toComment(row);
  }

  /** 指定アプリのコメントを created_at 昇順(同時刻は id 昇順)で返す。 */
  listComments(appId: string): Comment[] {
    return this.db
      .query<CommentRow, [string]>(
        `SELECT "id", "app_id", "anchor_form", "anchor_1", "anchor_2", "body", "created_at", "writer", "state", "reason", "diff_id"
         FROM "gp_comments" WHERE "app_id" = ?
         ORDER BY "created_at" ASC, "id" ASC`,
      )
      .all(appId)
      .map(toComment);
  }

  /**
   * 指定アプリのコメントのうち、渡した状態の行だけを created_at 昇順(同時刻は id 昇順)で
   * 返す(`V10-M15-T05` / `CM-G21`)。**{@link listComments} は1バイトも変えない** ——
   * 呼び出し元が `src/mcp/tools/read.ts` に居るためである。
   *
   * `state` の値域は {@link resolveCommentState} が見る(**2本目の値域検査を作らない**)。
   *
   * @throws {@link COMMENT_STATES} に無い値
   */
  listCommentsByState(appId: string, state: string): Comment[] {
    const resolved = resolveCommentState(state);
    return this.db
      .query<CommentRow, [string, string]>(
        `SELECT "id", "app_id", "anchor_form", "anchor_1", "anchor_2", "body", "created_at", "writer", "state", "reason", "diff_id"
         FROM "gp_comments" WHERE "app_id" = ? AND "state" = ?
         ORDER BY "created_at" ASC, "id" ASC`,
      )
      .all(appId, resolved)
      .map(toComment);
  }

  /**
   * コメントの状態を書き換える(`V10-M13-T02` / `V10-M13-T03` / `CM-G19` / `CM-G20`)。
   * **状態を書き換える関数はこの1本ちょうどである**(`T03` も2本目を作らず、この関数の
   * 第3引数として理由を受ける)。 宛先・書き手・作成時刻・本文は1バイトも触らない ——
   * `UPDATE` するのは状態と理由の2列だけである(`CM-G19` 限定2)。
   *
   * **器は状態も理由も1度も自分で導かない**(`CM-G19` 限定3 / 限定4。`CM-G20` 限定3)。
   * 渡された文字列を値域とだけ突き合わせ、そのまま書く。
   *
   * **理由の値域**は {@link resolveReason} が見る —— 対応できないという値
   * (`COMMENT_STATES[1]`)に倒すときは理由が必須(未指定 / 空 / 空白だけを拒否)、
   * それ以外の値に倒すときは理由を渡せない(空文字を含む非 `undefined` を拒否)。
   * **それ以外の値へ倒すと理由は `null` になる**(前の値を残さない)。
   *
   * @throws {@link COMMENT_STATES} に無い値、理由の値域違反(上記)、または `id` が
   *   未登録のとき(このときは `UPDATE` が0行にしか当たらないので、行は1行も作られず・
   *   1行も壊れない)
   */
  updateCommentState(id: string, state: string, reason?: string): Comment {
    const resolved = resolveCommentState(state);
    const resolvedReason = resolveReason(resolved, reason);
    const result = this.db
      .query(`UPDATE "gp_comments" SET "state" = ?, "reason" = ? WHERE "id" = ?`)
      .run(resolved, resolvedReason, id);
    if (result.changes === 0) {
      throw new Error(`id ${JSON.stringify(id)} のコメントは見つかりません。`);
    }
    // **`result.changes` が1以上だったので、直後の読み出しは必ず1行を返す。**
    const updated = this.getComment(id);
    if (updated === undefined) {
      throw new Error(`id ${JSON.stringify(id)} のコメントは見つかりません。`);
    }
    return updated;
  }

  /**
   * コメントの行から差分を指す列(`diff_id`)を書く(`V10-M15-T01` / `CM-G14` / `ADR-0370`)。
   * **繋ぐのは コメント → 差分 の2点である。中央の「案」は無い**(`CM-G8` = 却下)。
   *
   * 引数 `diffId` は**不透明な文字列**である。**この値が実在するかは1ミリも確かめない**
   * (限定4。憲法1の回避設計の帰結として、差分を取り消しても繋ぎは追随せず残る)。
   *
   * `UPDATE` するのは `diff_id` の1列だけであり、宛先・書き手・作成時刻・本文・状態・
   * 理由は1バイトも触らない。**繋ぎは1方向・1本ちょうどで、逆向きの列も2本目の繋ぎも
   * 作らない**(限定5)。**既に繋がっている行に別の識別子を上書きでき、前の値は1バイトも
   * 残らない**(器は履歴を1行も持たない。{@link updateCommentState} と同じ)。
   *
   * @throws `diffId` が空文字・空白だけ、または `id` が未登録のとき(このときは `UPDATE`
   *   が0行にしか当たらないので、行は1行も作られず・1行も壊れない)
   */
  linkCommentToDiff(id: string, diffId: string): Comment {
    if (diffId.trim() === "") {
      throw new Error("差分の識別子は空にできません。空文字・空白だけは指定できません。");
    }
    const result = this.db
      .query(`UPDATE "gp_comments" SET "diff_id" = ? WHERE "id" = ?`)
      .run(diffId, id);
    if (result.changes === 0) {
      throw new Error(`id ${JSON.stringify(id)} のコメントは見つかりません。`);
    }
    // **`result.changes` が1以上だったので、直後の読み出しは必ず1行を返す。**
    const updated = this.getComment(id);
    if (updated === undefined) {
      throw new Error(`id ${JSON.stringify(id)} のコメントは見つかりません。`);
    }
    return updated;
  }
}
