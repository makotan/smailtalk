/**
 * レコードCRUD API(V0-P2-T07)。
 *
 * マニフェストを唯一の権威として、レコードの作成・取得・一覧・更新・削除を行う
 * カーネル内部API。DDL 側は制約をほとんど持たない(ddl.ts 冒頭のコメント参照)ため、
 * **required / select の選択肢 / 型 / reference 先の実在**を守る唯一の関門がこの層になる。
 *
 * ## 値の表現(ラウンドトリップ)
 *
 * | 型 | JS 側 | SQLite 側 |
 * |---|---|---|
 * | `text` / `long_text` / `select` / `date` / `reference` | `string` | TEXT |
 * | `number` | `number`(整数は整数のまま) | NUMERIC |
 * | `boolean` | `true` / `false` | 1 / 0 |
 *
 * 書いた値と同じ形で読み出せること(boolean が 0/1 で返らないこと)を保証する。
 * required でないフィールドの未設定は `null` で表す。
 *
 * ## エラー
 *
 * すべての失敗は Phase 1 の統一形式(`ValidationError`)で、**全件まとめて**返す。
 * `path` はレコード本体を根とする JSON Pointer(`/quantity`)で、一覧の指定は
 * オプション構造に対応する Pointer(`/sort/field`、`/filter/0/equals`)になる。
 * 選択肢・実在ID系の違反には必ず `allowed_values` を入れる(LLMが1往復で直せること)。
 *
 * ## SQL の作法
 *
 * 識別子は `quoteIdentifier`(検証つき)でのみ埋め込み、値は必ずプレースホルダで
 * バインドする。sort / filter の対象フィールドはマニフェストに存在することを
 * 検証してからでなければ SQL に到達しない。
 */
import type { Database } from "bun:sqlite";
import { isSystemTableId } from "../shared/system-tables.ts";
import { quoteIdentifier, SYSTEM_COLUMN_NAMES, SYSTEM_COLUMNS } from "./ddl.ts";
import { concurrentWriteBusyErrors, type ValidationError } from "./errors.ts";
import type {
  Field,
  FilterCondition,
  FilterNode,
  Manifest,
  ResourceId,
  Sort,
  Table,
} from "./types.ts";
import { normalizeSort, sortErrorPath } from "./types.ts";
// **循環 import である**(`workflow-runner.ts` は `createRecord` / `updateRecord` を呼ぶ)。
// 双方が `export function` 宣言(巻き上げられる)なので、モジュール評価順に依らず解決する。
// ワークフローの発火をカーネルに置くのは ADR-0013 §5a の決定であり、こうすることで
// HTTP 経路と MCP 経路の発火が**構造的に**一致する(ADR-0003 §7)。
import { runWorkflows } from "./workflow-runner.ts";

/** レコードのフィールド値として表現できるもの。 */
export type RecordValue = string | number | boolean | null;

/** 読み出したレコード(システム列 + フィールド値)。 */
export type RecordRow = {
  _id: string;
  _created_at: string;
  _updated_at: string;
} & { [field: string]: RecordValue };

/** 書き込み入力。値は未検証なので `unknown` で受ける。 */
export type RecordInput = Record<string, unknown>;

/**
 * 一覧の取得条件(list_view の sort / filter と同じ構造)。
 *
 * `sort` は**キー1つ**でも**キーの配列**(複合ソート)でも書ける(V1-M0-T03)。
 * 解釈は `validateSortKeys` に一本化してあり、ユーザテーブル(ここ)もシステムテーブルの
 * 投影(`read-records.ts` が組み立てた副問合せ)も同じ関数を通る。
 */
export type ListRecordsOptions = {
  sort?: Sort | Sort[];
  /**
   * 絞り込み条件。**等値AND配列(後方互換)| ブール式(`FilterNode`)** のどちらでも書ける
   * (EC-G12 / ADR-0043)。配列形 `[{field, equals}]` は暗黙 AND で、v0 のマニフェストを
   * 1バイトも壊さない。ブール式は `and`/`or`/`not` と有限の葉演算子(equals/contains/gte/lte/in)。
   */
  filter?: FilterCondition[] | FilterNode;
  /**
   * ページネーション(EC-G11 / ADR-0042)の**読取パラメータ**。ページ位置はリクエスト引数であり
   * マニフェストには保存しない(D-G11。`manifest.schema.json` は不変)。
   *
   * - `limit`: 返す最大件数(0 以上の整数)。**未指定なら全件**(既存挙動・後方互換)。
   * - `offset`: 先頭からスキップする件数(0 以上の整数)。未指定なら 0。
   *
   * 総件数(total)は本オプションに左右されず `countRecords`(filter 適用後)で数える ——
   * 「続きがある」は `offset + 返した件数 < total` で導出できるので、専用フィールドは足さない。
   */
  limit?: number;
  offset?: number;
};

/**
 * 成功なら値、失敗なら統一形式エラーの全件。
 *
 * 失敗枝の `conflict` は**楽観ロック(CAS)の版不一致**を表す discriminant(V1-M9-T02)。
 * 通常のバリデーション失敗(型・必須・不在など)では立たず、`expectedVersion` を渡した
 * 更新/削除が版不一致で弾かれたときだけ `true` になる。配線層はこれを見て HTTP 409 /
 * MCP の衝突コードへ写す。**optional なので、`conflict` を見ない既存の呼び出しは無傷**
 * (従来どおり `ok`/`errors` だけで分岐できる)。
 */
export type RecordResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: ValidationError[]; conflict?: true };

function ok<T>(value: T): RecordResult<T> {
  return { ok: true, value };
}

function fail<T>(errors: ValidationError[]): RecordResult<T> {
  return { ok: false, errors };
}

/**
 * ワークフローのアクション失敗で発火元の書込を巻き戻すための内部例外
 * (V3-M13-T02 / ADR-0066 §Decision 1)。
 *
 * **`db.transaction(fn)` は fn が投げたときにだけ巻き戻す**ので、巻き戻しを起こすには
 * 投げるしかない(`batch.ts` の `BatchOpFailure` と同型の作法)。**この例外はこのファイルの
 * 外へ1度も出ない** —— tx のすぐ外で捕まえ、既存の `RecordResult` の `ok:false` に変換する
 * (ADR-0066 限定4: 例外を呼び出し元へ伝播させない / 限定12: 新しい結果型を作らない)。
 *
 * **`export` していない。** ADR-0066 限定11(`src/kernel/` の新規公開 export は失敗を運ぶ
 * 型1本まで)に対して、本タスクは **0本**で済ませている。
 */
class WorkflowActionFailure extends Error {
  constructor(readonly failures: string[]) {
    super("ワークフローのアクションが失敗しました。");
    this.name = "WorkflowActionFailure";
  }
}

/**
 * **入れ子になった巻き戻しの器のスタック**(V3-M13-T04 / ADR-0066 限定5)。
 *
 * ワークフローのアクションがレコードを書くと `runWithWorkflows` が入れ子になる
 * (内側は SAVEPOINT)。**内側で書かれた失敗の履歴は、内側が commit しても、外側が
 * 巻き戻れば一緒に消える。** 各段が「自分が書いた失敗の履歴を書き直す thunk」を
 * ここへ積み、**抜けるときに1つ外側の段へ引き継ぐ**ことで、**どの段で書かれた失敗の
 * 記録も、一番外側の巻き戻しの後に必ず1回だけ書き直される。**
 *
 * **単純な配列で足りるのは、実行が完全に同期だからである** ——
 * `workflow-runner.ts` の `depth` / `firedRecords` と同じ前提に乗っている
 * (実行を非同期にした瞬間に、この前提もあちらと同時に壊れる)。
 * **`export` していない**(ADR-0066 限定11: 新規公開 export は0本のまま)。
 */
const workflowTxStack: (() => void)[][] = [];

/**
 * アクション失敗で書込が成立しなかったことを表す統一エラー(ADR-0066 限定12)。
 *
 * **新しいフィールドを1つも足さない** —— 既存の `ValidationError`(`path` / `message` /
 * `hint`)だけで書く。**新しい HTTP ステータスも作らない**(配線層から見れば通常の
 * 検証失敗と同じ 400 系である)。
 *
 * 文面には**失敗した全アクションの説明**を入れる。どのアクションが何で落ちたかを
 * 呼び出し元が読めないと、「書けなかった」だけが残って原因に辿り着けない(憲法6)。
 */
function workflowFailureError(table: Table, failures: string[]): ValidationError {
  return {
    path: "",
    message:
      `テーブル "${table.id}" への書き込みは、ワークフローのアクションが失敗したため成立しませんでした` +
      `(この書き込みは1バイトも残っていません)。失敗: ${failures.join(" / ")}`,
    hint:
      "ワークフローのアクションが1つでも失敗すると、そのワークフローを発火させたレコード書込は成立しません。" +
      "失敗したアクションの宛先・値・実行条件を直してから、もう一度書き込んでください。",
  };
}

/**
 * 版不一致(楽観ロックの衝突)を表す失敗を作る。
 *
 * `conflict:true` を立てることで、配線層が「誰かが先に変更した(409)」を通常の
 * バリデーション失敗と機械的に区別できる(V1-M9-T02)。
 */
function conflict<T>(errors: ValidationError[]): RecordResult<T> {
  return { ok: false, conflict: true, errors };
}

/**
 * 版不一致の統一エラー(update / delete で同一文面)。
 *
 * LLM・利用者どちらにも「自分が読んだ後に別の操作が入った」ことが伝わり、
 * 「読み直してからやり直す」で1往復で回復できる文面にする(silent-overwrite を防ぐ保護)。
 */
function versionConflictError(table: Table, id: string): ValidationError {
  return {
    path: "",
    message: `テーブル "${table.id}" のレコード "${id}" は、あなたが取得した後に別の操作で変更されています。`,
    hint: "最新の内容を取得し直してから、変更をやり直してください(先の変更を黙って上書きしないための保護です)。",
  };
}

/** SQLite が実際に返す行の生の形。 */
type RawRow = Record<string, string | number | null>;

// --- sort の解釈(V1-M0-T03。カーネルの2経路が共有する唯一の実装)-------------------

/**
 * `sort`(単数オブジェクト / 配列)を検証し、**キーの配列**にして返す。
 *
 * 計画書 V1-M0-T03 の完了条件3 は「並び替えの解釈がカーネル / HTTP / レンダラで
 * 一致すること」を要求している。**カーネルで sort を解釈するのはこの関数だけである**
 * (システムテーブルの投影も `listRecords` を通るので、ここに来る)。したがって
 * 「どのフィールドを許すか」「何番目のキーが不正か」「空配列をどう扱うか」は
 * 定義上ずれない。表記の正規化そのものは `types.ts` の `normalizeSort` が唯一の入口。
 *
 * **【SQ-M4 追記】** かつては「カーネル側の2経路(SQL の `listRecords` とメモリの
 * `read-records.ts`)が**この関数を共有する**」と書いていた。**その2本目は消えた** ——
 * システムテーブルの読取も SQL へ一本化したので、共有する相手ではなく1本になった。
 *
 * 返り値が空配列なら「並び順の指定なし」であり、呼び出し側は既定順を使う。
 * **`sort: []` は指定なしではなく誤り**として扱う —— 黙って既定順に落とすと、
 * 指定したはずの並び順が消えたことが利用者に見えない(できたふり)。
 *
 * エラーは投げずに `errors` へ積む(この層の方針は「違反は全件まとめて返す」)。
 *
 * **【V4-M21-T05】宣言が1件以上あるときは、末尾に第2キー(`_created_at` → `_id`)を
 * 継ぎ足して返す**(`appendTiebreakKeys`)。**宣言が0件のときは1バイトも足さない** ——
 * そちらは呼び出し側の既定式(`_created_at ASC, _id ASC`)が今日どおり効くからである。
 */
export function validateSortKeys(
  sort: Sort | Sort[] | undefined,
  table: Table,
  sortableIds: ResourceId[],
  errors: ValidationError[],
): Sort[] {
  if (Array.isArray(sort) && sort.length === 0) {
    errors.push({
      path: "/sort",
      message: "並び順(sort)が空の配列です。",
      hint:
        "並べ替えないなら sort そのものを指定しないでください。" +
        'キーを指定するなら [{ "field": "<field_id>", "order": "asc" }] の形で1件以上書いてください。',
    });
    return [];
  }
  const keys = normalizeSort(sort);
  const valid: Sort[] = [];
  keys.forEach((key, index) => {
    if (!sortableIds.includes(key.field)) {
      errors.push({
        path: `${sortErrorPath(sort, index)}/field`,
        message: `並び順に指定されたフィールド "${key.field}" はテーブル "${table.id}" に存在しません。`,
        allowed_values: sortableIds,
        hint: `テーブル "${table.id}" に実在するフィールドIDを指定してください。`,
      });
      return;
    }
    valid.push(key);
  });
  return appendTiebreakKeys(valid);
}

/**
 * **同値の行の順序を決める第2キーを、宣言された `sort` の末尾へ継ぎ足す**(V4-M21-T05)。
 *
 * 上位: `docs/plan/v4/records/v4-m21.md` §1 の `V4-M21-T05` /
 * 単位C の判定 = **将来送り**(`v4-m21-gate-a-same-day-order.md`)。
 *
 * ## 何を直しているか
 *
 * `sort` を宣言した一覧は、宣言したキーが同値になったときの順序が決まっていなかった
 * (SQL は未規定・メモリ経路は投影元の順序)。実地の症状は「注文一覧が同じ日の中で
 * 古い順に並ぶ」「ポイント履歴のいちばん上の残高が現在の残高ではない」である。
 * **【SQ-M4 追記】ここでいう「メモリ経路」はシステムテーブルの投影の2つ目の実装であり、
 * 今日は存在しない**(SQL へ一本化した)。**上の記述は当時の症状の記録として残す。**
 *
 * ## 何を直していないか(**丸めない**)
 *
 * - **`sort` を1つも宣言していない一覧の並び順は1バイトも変わらない。** そちらは
 *   今日すでに `_created_at ASC, _id ASC` に固定されており、ここは呼ばれない
 *   (`keys.length === 0` なら空配列のまま返る)。
 * - **アプリは第2キーも向きも選べない。** マニフェストに書けるキーは1つも増えていない。
 * - **`_created_at` は「行が作られた時刻」であって「業務上の時刻」ではない。**
 *   過去分を後から登録した行では、望む順序にならないことがある。
 *
 * ## 向き(**決めたこと**)
 *
 * **宣言された最後のキーの向きに従う。** 門A 本審査の実測では、第2キーを `asc` に
 * 固定すると `placed_on desc` の並びが今日と1行も変わらず(症状ゼロ改善)、`desc` に
 * したときだけ同じ日の中が新しい順になった。送り元の完了条件が「**`desc` で並べたとき**に
 * 第2キーをどちらの向きにするかを決めよ」と書いており、`asc` 宣言の既定が `asc` である
 * ことを前提にしている。ここはその読みを採っている。
 *
 * 既に宣言に含まれているシステム列は**継ぎ足さない**(宣言された向きが勝つ)。
 */
function appendTiebreakKeys(keys: Sort[]): Sort[] {
  const last = keys[keys.length - 1];
  if (last === undefined) {
    return keys;
  }
  const declared = new Set(keys.map((key) => key.field));
  const appended = [...keys];
  for (const column of [SYSTEM_COLUMNS.createdAt, SYSTEM_COLUMNS.id]) {
    if (!declared.has(column)) {
      appended.push({ field: column, order: last.order });
    }
  }
  return appended;
}

// --- ページネーション引数の検証(EC-G11 / ADR-0042)-------------------------------
//
// limit / offset は 0 以上の整数だけを受ける(非整数・負数は黙って化けさせず統一形式で拒否する。
// 憲法6)。**ユーザテーブルもシステムテーブルの投影も listRecords を通るので、限度の検証は
// この1関数しか無い**(経路で振る舞いが割れない。ADR-0003 §7)。
// **【SQ-M4 追記】** かつてはシステムテーブル側に2つ目の実装(read-records.ts の
// メモリ経路)があり、この関数を import して**文面だけ**を揃えていた。**その実装は消えた。**

/** limit / offset(0 以上の整数)を検証し、違反を `errors` に積む。 */
export function validatePageParam(
  name: "limit" | "offset",
  value: number | undefined,
  errors: ValidationError[],
): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isInteger(value) || value < 0) {
    errors.push({
      path: `/${name}`,
      message: `${name} は 0 以上の整数で指定してください(受け取った値: ${JSON.stringify(value)})。`,
      hint:
        name === "limit"
          ? "1ページに返す最大件数を 0 以上の整数で指定してください(省略すると全件返します)。"
          : "先頭からスキップする件数を 0 以上の整数で指定してください(省略すると先頭から返します)。",
    });
  }
}

// --- テーブル / フィールドの解決 ---------------------------------------------

function tableIds(manifest: Manifest): ResourceId[] {
  return manifest.app.tables.map((table) => table.id);
}

function findTable(manifest: Manifest, tableId: ResourceId): Table | undefined {
  return manifest.app.tables.find((table) => table.id === tableId);
}

export function unknownTableError(manifest: Manifest, tableId: ResourceId): ValidationError {
  return {
    path: "",
    message: `テーブル "${tableId}" はこのアプリに存在しません。`,
    allowed_values: tableIds(manifest),
    hint: "実在するテーブルIDを指定するか、先に add_table でテーブルを追加してください。",
  };
}

/**
 * システムテーブルへの書き込み拒否(ADR-0006 §8 の L1)。
 *
 * 構造は `unknownTableError` に揃えるが、**言っていることは正反対**である。
 * `_apps` は存在する。ただ読み取り専用なだけであり、「存在しません」と言うのは
 * 嘘であるうえ、「では add_table で作ろう」という誤った自己修正を誘導する(憲法6)。
 * `allowed_values` には「代わりに書けるテーブル」を入れる。
 */
export function readOnlyTableError(manifest: Manifest, tableId: ResourceId): ValidationError {
  return {
    path: "",
    message: `テーブル "${tableId}" はカーネルのメタ情報を投影した読み取り専用のシステムテーブルなので、書き込めません。`,
    allowed_values: tableIds(manifest),
    hint: "システムテーブルのレコードは作成・更新・削除できません。書き込めるのは allowed_values のテーブルです。画面から見るだけなら list_view / detail_view を使ってください。",
  };
}

export function fieldIds(table: Table): ResourceId[] {
  return table.fields.map((field) => field.id);
}

// --- 値の検証 -----------------------------------------------------------------

/**
 * ISO8601 の日付(`2026-07-18`)または日時(`2026-07-18T09:30:00Z` 等)。
 *
 * v0 では「LLMが素直に書く形」を受け取れれば十分なので、書式は正規表現で
 * 押さえたうえで、日付部分だけは実在する日付か(`2026-02-30` を弾く)まで見る。
 * 時刻の閏秒などそれ以上の厳密さは追わない(語彙を増やさない方針と同じく、
 * ここで凝ってもユーザ価値が増えないため)。
 */
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?$/;

function isValidIso8601(value: string): boolean {
  const match = ISO_DATE_RE.exec(value) ?? ISO_DATE_TIME_RE.exec(value);
  if (match === null) {
    return false;
  }
  const [, year, month, day, hour, minute, second] = match;
  if (year === undefined || month === undefined || day === undefined) {
    return false;
  }
  if (!isRealCalendarDate(Number(year), Number(month), Number(day))) {
    return false;
  }
  if (hour !== undefined && Number(hour) > 23) {
    return false;
  }
  if (minute !== undefined && Number(minute) > 59) {
    return false;
  }
  if (second !== undefined && Number(second) > 59) {
    return false;
  }
  return true;
}

function isRealCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** その型が期待する JS の値の説明(エラーメッセージ用)。 */
const TYPE_EXPECTATION: Record<Field["type"], string> = {
  text: "文字列(text)",
  long_text: "文字列(long_text)",
  select: "文字列(select)",
  date: "ISO8601形式の文字列(date)。例: 2026-07-18 / 2026-07-18T09:30:00Z",
  reference: "参照先レコードの _id を表す文字列(reference)",
  image: "アップロード済みファイルの file_id を表す文字列(image)",
  file: "アップロード済みファイルの file_id を表す文字列(file)",
  number: "数値(number)",
  boolean: "真偽値(boolean)",
};

function describeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return `文字列 ${JSON.stringify(value)}`;
  }
  return `${typeof value} の ${String(value)}`;
}

/** 型が合わないことを報告する(全型で文面を共有する)。 */
function pushTypeError(
  field: Field,
  value: unknown,
  path: string,
  errors: ValidationError[],
): undefined {
  errors.push({
    path,
    message: `フィールド "${field.id}" には ${TYPE_EXPECTATION[field.type]} を指定してください。受け取った値: ${describeValue(value)}`,
    hint: `このフィールドの型は "${field.type}" です。`,
  });
  return undefined;
}

/**
 * `reference` / `image` / `file` を除く6型。`db` を必要とする検証はこの範囲の外にしかない。
 *
 * **V2-M2 / ADR-0035**: `image` 値の検証も `_files` の実在確認で SQL を発行するため、
 * `reference` と並んで `db` を要求する。したがって「db を要る2型」= `reference` + `image`、
 * 「db を要らない6型」= それ以外、という切り分けになった(以前は reference だけが db を要した)。
 *
 * **V5-M16 / ADR-0161**: `file` が9種目として加わり、**`image` とまったく同じ実在確認**を
 * 通る。したがって「db を要る型」は3つ(`reference` / `image` / `file`)になった。
 * **db を要らない型の数は6のままである**(`file` は db を要る側に入ったため)。
 */
type DbFreeField = Exclude<Field, { type: "reference" | "image" | "file" }>;

/**
 * `db` を必要としない6型の値検証(ADR-0006 §7b)。
 *
 * `reference` / `image` だけが参照先(レコード / `_files`)の実在確認で SQL を発行するため、
 * `db` を要求する。**db を要らない部分を純粋関数として切り出してある**ので、db を持たない
 * 呼び出し元(`workflow-runner.ts` の値検証など)からも同じ検証を通せる。
 *
 * **【SQ-M4 追記】** 切り出した当時の理由は「物理テーブルを持たないシステムテーブルの
 * 読み取り(`read-records.ts`)は `db` を渡せないから」だった。**その前提は今日は無い** ——
 * システムテーブルの読取も `kernel.sqlite` を開いて SQL を通る。**切り出しは今も要る**が、
 * 要る理由は上のとおり別の呼び出し元に移っている。
 *
 * ここで検証ロジックを複製すると経路によって値検証の振る舞いが分岐する ――
 * ADR-0003 §7「入口を何本生やしても振る舞いが一致する」が最も避けたいことである。
 * したがって複製ではなく抽出にしてある。`validateFieldValue` はこの関数を呼んだうえで
 * `reference` だけを自分で処理する薄いラッパである。
 */
export function validateDbFreeFieldValue(
  field: DbFreeField,
  value: unknown,
  path: string,
  errors: ValidationError[],
): string | number | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }

  switch (field.type) {
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return pushTypeError(field, value, path, errors);
      }
      return value;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        return pushTypeError(field, value, path, errors);
      }
      return value ? 1 : 0;
    }
    case "text":
    case "long_text": {
      if (typeof value !== "string") {
        return pushTypeError(field, value, path, errors);
      }
      return value;
    }
    case "date": {
      if (typeof value !== "string") {
        return pushTypeError(field, value, path, errors);
      }
      if (!isValidIso8601(value)) {
        errors.push({
          path,
          message: `フィールド "${field.id}" の値 ${JSON.stringify(value)} は ISO8601 形式の日付ではありません。`,
          hint: "YYYY-MM-DD もしくは YYYY-MM-DDThh:mm:ssZ の形式で、実在する日付を指定してください。",
        });
        return undefined;
      }
      return value;
    }
    case "select": {
      if (typeof value !== "string") {
        return pushTypeError(field, value, path, errors);
      }
      if (!field.options.includes(value)) {
        errors.push({
          path,
          message: `フィールド "${field.id}" に選択肢にない値 ${JSON.stringify(value)} が指定されました。`,
          allowed_values: [...field.options],
          hint: "選択肢にある値を指定するか、先に選択肢そのものを追加してください。",
        });
        return undefined;
      }
      return value;
    }
  }
}

/**
 * 1フィールドの値を検証し、問題なければ SQLite にバインドできる形に変換する。
 * `null` は「未設定」を意味し、required の検査は呼び出し側で別途行う。
 */
function validateFieldValue(
  db: Database,
  field: Field,
  value: unknown,
  path: string,
  errors: ValidationError[],
): string | number | null | undefined {
  if (field.type === "reference") {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value !== "string") {
      return pushTypeError(field, value, path, errors);
    }
    if (!recordExists(db, field.reference_table, value)) {
      errors.push({
        path,
        message: `フィールド "${field.id}" が参照するレコード "${value}" はテーブル "${field.reference_table}" に存在しません。`,
        hint: `先に "${field.reference_table}" にレコードを作成し、その _id を指定してください。`,
      });
      return undefined;
    }
    return value;
  }
  if (field.type === "image" || field.type === "file") {
    // image / file 値 = `_files` に実在する file_id を表す文字列(V2-M2 / ADR-0035 §1b。
    // file は V5-M16 / ADR-0161 限定3 で同型に写した)。reference の実在確認と同型で、
    // アップロード済み(= `_files` に載った)file_id しか書けない。
    // **`_files` は1本のままである**(ADR-0161 限定1: 2本目のファイルテーブルを作らない)——
    // したがって image と file はこの1つの枝を共有する。
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value !== "string") {
      return pushTypeError(field, value, path, errors);
    }
    if (!fileExists(db, value)) {
      errors.push({
        path,
        message: `フィールド "${field.id}" が参照するファイル "${value}" は "${FILES_TABLE}" に存在しません。`,
        hint: "先にファイルをアップロードし、返された file_id を指定してください(アップロードされていない file_id は書けません)。",
      });
      return undefined;
    }
    return value;
  }
  return validateDbFreeFieldValue(field, value, path, errors);
}

/** required 違反(未設定・null・空白のみの文字列)か。 */
function isMissingValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  return typeof value === "string" && value.trim() === "";
}

/**
 * `unique: true` のフィールドに書く値が、同テーブルの**他行**に既に存在するか
 * (EC-G8 / ADR-0038)。**null は照会しない**(未設定は重複対象にしない = 複数 null を許す。
 * SQL の UNIQUE と同じ)呼び出し側で担保する。`excludeId` を渡すと自分自身の行を除外する
 * (update 時。自分の値のまま更新しても重複にならない)。
 *
 * **DDL に UNIQUE を落とさない選択の代償として TOCTOU の窓が残る**(ADR-0038 §限界1)——
 * この照会(SELECT)と、呼び出し側の INSERT / UPDATE の間に別接続が同値を挿入する窓がある。
 * `records.ts` の CRUD には `db.transaction` が1件も無く(`workflow-runner.ts` のコメントが
 * 名指し)、書込は IMMEDIATE tx で直列化されていないので、その窓は正直に残る。窓を閉じるには
 * DB 層 UNIQUE か CRUD の IMMEDIATE tx 化が要るが、後者は M4 の領分であり T03 ではやらない。
 */
function hasDuplicateValue(
  db: Database,
  table: Table,
  fieldId: string,
  value: string | number,
  excludeId?: string,
  /**
   * **所有者スコープ(`unique: "owner"`)のときだけ渡す**(V4-M10-T07 / ADR-0078 限定2)。
   * 値は**共有センチネルを空文字に畳んだ持ち主の id** である(`null` と `""` は同じスコープ)。
   * `undefined` を渡すと今日どおりテーブル全体で照会する(`unique: true` の意味は不変)。
   */
  ownerScope?: string,
): boolean {
  const idCol = quoteIdentifier(SYSTEM_COLUMNS.id);
  let sql = `SELECT 1 FROM ${quoteIdentifier(table.id)} WHERE ${quoteIdentifier(fieldId)} = ?`;
  const bindings: (string | number)[] = [value];
  if (ownerScope !== undefined) {
    // **絞りは1つだけである**(ADR-0078 限定2)。**列名は引数で受け取らない** ——
    // 受け取れる形にすると「どの列の組か」を書ける構文が生まれ、ADR-0038 §3a-1 が
    // 予約した複合ユニークそのものになる。**スコープ列は `st_owner` に固定である。**
    // `COALESCE` で `null` と空文字を同じスコープに畳む(共有センチネルの読みは
    // `src/server/owner-scope.ts` の `isSharedOwner` と同じである)。
    sql += ` AND COALESCE(${quoteIdentifier(OWNER_SCOPE_COLUMN)}, '') = ?`;
    bindings.push(ownerScope);
  }
  if (excludeId !== undefined) {
    sql += ` AND ${idCol} <> ?`;
    bindings.push(excludeId);
  }
  sql += " LIMIT 1";
  return db.query(sql).get(...bindings) !== null;
}

/**
 * 所有者スコープ付き一意(`unique: "owner"`)が使うスコープ列(**規約**。V4-M10-T07 / ADR-0078)。
 *
 * **export しない**(`ADR-0078` 限定8: `src/kernel/` の公開 export を1つも増やさない)。
 * **サーバ層の `OWNER_FIELD`(`src/server/owner-scope.ts:20`)と同じ綴りだが、層をまたいで
 * import しない** —— `src/kernel/` は `src/server/` に依存しない(`ADR-0009`)。
 * **同じ綴りが2箇所にあることは代償である**(`workflow-runner.ts` が `record.st_owner` を
 * 直に読んでいるのと同じ形。隠さない)。
 */
const OWNER_SCOPE_COLUMN = "st_owner";

/**
 * `unique: "owner"` の照会に使うスコープ値を、入力と既存行から決める。
 *
 * - **表に `st_owner` が無ければ `""`(共有)に倒れる** —— スコープが1つしか無いので、
 *   結果としてテーブル全体の一意と同じ挙動になる。**`ADR-0078` の限定表はこの場合を
 *   1行も定めていないので、拒否する検査を新設していない**(限定8:「検査は
 *   `hasDuplicateValue` の中に閉じる」)。**実測は `owner-scoped-unique.test.ts` の (h)。**
 * - **部分更新で `st_owner` が入力に無ければ、既存行の値を使う。**
 * - **`null` / 空文字は同じ共有スコープ(`""`)に畳む。**
 */
function ownerScopeOf(
  columns: Map<string, string | number | null>,
  existing: Record<string, unknown> | undefined,
): string {
  const raw = columns.has(OWNER_SCOPE_COLUMN)
    ? columns.get(OWNER_SCOPE_COLUMN)
    : existing?.[OWNER_SCOPE_COLUMN];
  return typeof raw === "string" ? raw : "";
}

/**
 * 入力を検証して、列名 → バインド値のマップに変換する。
 *
 * `partial` が true(更新)のときは、入力に含まれないフィールドの required 検査を
 * 行わない(部分更新では既存値がそのまま残るため)。
 *
 * `excludeId`(EC-G8 / ADR-0038)は unique 制約の照会で**自分自身の行を除外**するための
 * レコードID。update から渡す(create では未指定)。**部分更新で入力に無い unique フィールドは
 * 照会しない** —— 値が変わらない以上、新しい重複は生じないからである。
 */
function validateInput(
  db: Database,
  table: Table,
  input: RecordInput,
  partial: boolean,
  excludeId?: string,
  /**
   * 更新前の行(update のときだけ渡す)。**`unique: "owner"` のスコープ値を、入力に
   * `st_owner` が無い部分更新でも決められるようにするためだけに使う**
   * (V4-M10-T07 / ADR-0078)。**他の検査は1つもこれを読まない。**
   */
  existing?: Record<string, unknown>,
): RecordResult<Map<string, string | number | null>> {
  const errors: ValidationError[] = [];
  const byId = new Map(table.fields.map((field) => [field.id, field]));
  const columns = new Map<string, string | number | null>();

  // マニフェストにないフィールド(システム列への直接書き込みを含む)は拒否する。
  for (const key of Object.keys(input)) {
    if (byId.has(key)) {
      continue;
    }
    errors.push({
      path: `/${key}`,
      message: SYSTEM_COLUMN_NAMES.includes(key)
        ? `"${key}" はカーネルが管理するシステム列なので書き込めません。`
        : `フィールド "${key}" はテーブル "${table.id}" に存在しません。`,
      allowed_values: fieldIds(table),
      hint: `テーブル "${table.id}" に実在するフィールドIDを指定するか、先に add_field でフィールドを追加してください。`,
    });
  }

  for (const field of table.fields) {
    const present = Object.hasOwn(input, field.id);
    if (!present && partial) {
      continue;
    }
    const value = present ? input[field.id] : null;

    if (field.required === true && isMissingValue(value)) {
      errors.push({
        path: `/${field.id}`,
        message: `フィールド "${field.id}" は必須です。値を指定してください。`,
        hint: present
          ? "null や空文字ではなく、実際の値を指定してください。"
          : `テーブル "${table.id}" の必須フィールドです。`,
      });
      continue;
    }
    if (!present) {
      // 部分更新でない新規作成では、未指定は明示的に null を書く。
      columns.set(field.id, null);
      continue;
    }

    const bound = validateFieldValue(db, field, value, `/${field.id}`, errors);
    if (bound !== undefined) {
      columns.set(field.id, bound);
    }
  }

  // --- unique 制約(EC-G8 / ADR-0038)の書込時検査 --------------------------------
  // DDL に UNIQUE インデックスを落とさない(ADR-0010 限定5/6 維持)代わりに、この関門で
  // 同値の他行を照会して拒否する。MCP / HTTP どちらの経路もこの関門を通る(ADR-0003 §7)。
  // 照会するのは検証を通った値(`columns`)だけ・**非 null のみ**(null は複数許す)。
  for (const [fieldId, value] of columns) {
    if (value === null) {
      continue;
    }
    const field = byId.get(fieldId);
    if (field?.unique !== true && field?.unique !== "owner") {
      continue;
    }
    // **V4-M10-T07 / ADR-0078**: `"owner"` のときだけスコープを1つ渡す。
    // **渡すのは値であって列名ではない**(限定2: 列名を書ける形にしない)。
    // **表に `st_owner` が無ければスコープを渡さない**(= テーブル全体の一意と同じ挙動)。
    // **これは安全側の明示である** —— 渡すと SQLite が二重引用符の未知識別子を**文字列
    // リテラル**として解釈し(レガシー互換)、照会が常に0件になって「宣言したのに1ミリも
    // 効かない」形になる(2026-08-03 実測)。**`ADR-0078` の限定表はこの場合を1行も定めて
    // いないので、拒否する検査は新設していない**(限定8)。**実測は
    // `owner-scoped-unique.test.ts` の (h) が固定する。**
    const scoped =
      field.unique === "owner" &&
      table.fields.some((candidate) => candidate.id === OWNER_SCOPE_COLUMN);
    const ownerScope = scoped ? ownerScopeOf(columns, existing) : undefined;
    if (hasDuplicateValue(db, table, fieldId, value, excludeId, ownerScope)) {
      errors.push({
        path: `/${fieldId}`,
        message: scoped
          ? `フィールド "${fieldId}" は持ち主ごとの一意(unique: "owner")制約があり、` +
            `値 ${JSON.stringify(value)} は同じ持ち主の別のレコードで既に使われています。`
          : `フィールド "${fieldId}" は一意(unique)制約があり、値 ${JSON.stringify(value)} は` +
            `テーブル "${table.id}" の別のレコードで既に使われています。`,
        hint: scoped
          ? "このフィールドは同じ持ち主(st_owner)の中で値が重複できません。" +
            "持ち主が違えば同じ値を持てます。別の値を指定するか、" +
            "その値を持つ既存のレコードを更新してください。"
          : "このフィールドは同じテーブル内で値が重複できません。別の値を指定するか、" +
            "その値を持つ既存のレコードを更新してください。",
      });
    }
  }

  return errors.length > 0 ? fail(errors) : ok(columns);
}

// --- 読み出し -----------------------------------------------------------------

/** SELECT する列(システム列 + マニフェストのフィールド)。 */
function selectColumns(table: Table): string {
  return [...SYSTEM_COLUMN_NAMES, ...fieldIds(table)].map(quoteIdentifier).join(", ");
}

/** SQLite の生の行を、フィールド型に沿った JS の値へ戻す。 */
function toRecordRow(table: Table, raw: RawRow): RecordRow {
  const row: Record<string, RecordValue> = {
    [SYSTEM_COLUMNS.id]: String(raw[SYSTEM_COLUMNS.id]),
    [SYSTEM_COLUMNS.createdAt]: String(raw[SYSTEM_COLUMNS.createdAt]),
    [SYSTEM_COLUMNS.updatedAt]: String(raw[SYSTEM_COLUMNS.updatedAt]),
  };
  for (const field of table.fields) {
    const value = raw[field.id];
    if (value === null || value === undefined) {
      row[field.id] = null;
      continue;
    }
    switch (field.type) {
      case "boolean":
        row[field.id] = Number(value) !== 0;
        break;
      case "number":
        row[field.id] = Number(value);
        break;
      default:
        row[field.id] = String(value);
        break;
    }
  }
  return row as RecordRow;
}

/** 参照先テーブルに指定 `_id` のレコードが実在するか。 */
function recordExists(db: Database, tableId: ResourceId, id: string): boolean {
  const sql = `SELECT 1 FROM ${quoteIdentifier(tableId)} WHERE ${quoteIdentifier(SYSTEM_COLUMNS.id)} = ? LIMIT 1`;
  return db.query(sql).get(id) !== null;
}

/**
 * image 値の実在確認先(V2-M2 / ADR-0035 §1b)。
 *
 * **T02 への申し送り**: `_files` は `app.sqlite` 内の物理システムテーブルで、
 * **file_id を PRIMARY KEY とする**前提で書いてある(下の `fileExists`)。T02 が
 * `_files` の DDL を作るとき、テーブル名 `_files`・PK 列名 `file_id` をこの定数に
 * 合わせること。`_files` は `_` 始まりのため `quoteIdentifier` を通せない(リソースID規約
 * 違反)ので、固定の定数リテラルとして SQL に直接埋め込む(値は必ずプレースホルダ)。
 */
const FILES_TABLE = "_files";
const FILES_PK = "file_id";

/**
 * `_files` に指定 file_id が実在するか(image 値の実在確認。V2-M2 / ADR-0035)。
 *
 * `recordExists` の image 版。`reference` が参照先テーブルの `_id` を引くのと同じく、
 * image は `_files` の file_id を引く。**T01 時点では `_files` の実体は T02 が作る**ので、
 * `_files` がまだ無い間は「テーブルが無い → 実在しない」= 検証エラーになる(枠の実装)。
 * T02 が `_files` を作れば、アップロード済み file_id だけが実在確認を通る形で結線される。
 */
function fileExists(db: Database, fileId: string): boolean {
  const tableRow = db
    .query<{ n: number }, [string]>(
      'SELECT COUNT(*) AS n FROM "sqlite_master" WHERE "type" = \'table\' AND "name" = ?',
    )
    .get(FILES_TABLE);
  if ((tableRow?.n ?? 0) === 0) {
    return false;
  }
  const sql = `SELECT 1 FROM "${FILES_TABLE}" WHERE "${FILES_PK}" = ? LIMIT 1`;
  return db.query(sql).get(fileId) !== null;
}

function selectRow(db: Database, table: Table, id: string): RecordRow | null {
  const sql = `SELECT ${selectColumns(table)} FROM ${quoteIdentifier(table.id)} WHERE ${quoteIdentifier(SYSTEM_COLUMNS.id)} = ?`;
  const raw = db.query(sql).get(id) as RawRow | null;
  return raw === null ? null : toRecordRow(table, raw);
}

// --- 公開API -------------------------------------------------------------------

/**
 * レコードを1件作成する。`_id` は `crypto.randomUUID()` で発行し、
 * `_created_at` / `_updated_at` に同じ ISO8601 UTC を入れる。
 * バリデーションに1件でも違反があれば、DBには一切書き込まずに全件のエラーを返す。
 */
export function createRecord(
  db: Database,
  manifest: Manifest,
  tableId: ResourceId,
  input: RecordInput,
): RecordResult<RecordRow> {
  // L1(最終防衛線)。判定はテーブル解決より**前**に置く(ADR-0006 §8)。
  if (isSystemTableId(tableId)) {
    return fail([readOnlyTableError(manifest, tableId)]);
  }
  const table = findTable(manifest, tableId);
  if (table === undefined) {
    return fail([unknownTableError(manifest, tableId)]);
  }

  const validated = validateInput(db, table, input, false);
  if (!validated.ok) {
    return fail(validated.errors);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const columns = [
    SYSTEM_COLUMNS.id,
    SYSTEM_COLUMNS.createdAt,
    SYSTEM_COLUMNS.updatedAt,
    ...validated.value.keys(),
  ];
  const values: (string | number | null)[] = [id, now, now, ...validated.value.values()];
  const sql =
    `INSERT INTO ${quoteIdentifier(table.id)} (${columns.map(quoteIdentifier).join(", ")}) ` +
    `VALUES (${columns.map(() => "?").join(", ")})`;

  // [行の書込 + ワークフローの発火] を1つの deferred tx で包む(ADR-0066 §Decision 1)。
  return runWithWorkflows(db, table, (rewrites) => {
    db.query(sql).run(...values);

    const row = selectRow(db, table, id);
    if (row === null) {
      throw new Error(`レコード "${id}" の作成直後の読み出しに失敗しました。`);
    }
    // ワークフローの発火(ADR-0013 §5a / V1-M2-T02)。**`selectRow` の後**に置く ——
    // `$record.<フィールドID>` の解決には全フィールドの確定値が要るため、
    // INSERT 直後ではなく確定値を読み出した後でなければならない。
    // `runWorkflows` は例外を投げない(`0013:417` の後段は1バイトも変えていない)が、
    // **失敗の説明を返す**ようになった(V3-M13-T02)。
    return { row, failures: runWorkflows(db, manifest, table.id, "on_create", row, rewrites) };
  });
}

/**
 * **[行の書込 + `runWorkflows`] を1つの `db.transaction`(deferred)で包む器**
 * (V3-M13-T02 / ADR-0066 §Decision 1。**この器はこのファイルにしか無い**)。
 *
 * ## なぜ入口層ではなくカーネルのここに置くのか(ADR-0066 限定1)
 *
 * ADR-0013 §5a が**フックを置く場所**を `records.ts` に決めたのと同じ理由である ——
 * `ADR-0003` §7(入口を何本生やしても振る舞いが一致する)が**構造的に**保証される。
 * 呼び出し元(`src/server/app.ts` / `src/mcp/tools/write.ts` / `src/server/inbound-route.ts`)に
 * 別々に書く設計は、**書き忘れた経路が静かにずれる。**
 * **したがって入口層にも `batch.ts` にも1バイトも足していない。**
 *
 * ## 入れ子(ADR-0066 限定2)
 *
 * **deferred のみ。IMMEDIATE へ昇格させる呼び出しを1つも持たない**
 * (ADR-0039 §3a-4 / ADR-0018 の射程を1バイトも侵さない)。
 * **この doc はその呼び出しの綴りを1度も書かない** —— ADR-0066 限定2 の機械的検査は
 * 綴りを grep で数えるので、コメントに書くと実呼び出しが0件でも1件と数えられてしまう。
 * HTTP / 受信 capability の deferred tx やバッチの IMMEDIATE tx の内側で開くと SAVEPOINT に
 * なり、**内側の失敗は内側だけを巻き戻す。**
 *
 * ## 巻き戻らないもの(**「全部巻き戻る」と書かない**)
 *
 * - **`schedule` の発火**(ADR-0066 限定7。器を1つも作っていない)
 * - **外部送信キュー(`outbox`)/ AI 呼び出しキュー(`ai_jobs`)** —— `kernel.sqlite` に
 *   **別接続**で積まれるので、`app.sqlite` のこの tx では原理的に届かない(ADR-0066 §2d / 限定6)。
 *   **存在しない行についての外部通知が飛びうる状態は1バイトも解消していない。**
 * ## 失敗の記録だけは巻き戻さない(ADR-0066 限定5 = **必須。外せない**。V3-M13-T04)
 *
 * 履歴行はこの tx の内側で書かれるので、**巻き戻すと `status="failure"` の行も一緒に
 * 消える。**「致命にする」と「loud に残す」が同じ tx の中では両立しない(憲法6 との衝突)。
 * ADR-0066 §2c が限定した3つの解き方((A) 別接続 / (B) 巻き戻し後に改めて書く /
 * (C) 責務を入口へ移す)のうち、**本実装は (B) を採る** ——
 * **巻き戻した直後に、同じ履歴行をもう一度書く。**
 *
 * - **(A) を採らない理由は実測である** —— 発火元の tx が書込ロックを握っている間、
 *   同じ `app.sqlite` を開いた別接続からの INSERT は `database is locked` で落ちる
 *   (`busy_timeout` は 0)。**書ける時刻が存在しない。**
 * - **書き直すのは失敗の記録だけである。** 成功した実行の履歴を書き直すと、
 *   成果物が1つも無いのに「成功した」と書かれた行だけが残る。
 * - **`ran_at` は元の実行の時刻のまま**である(`writeHistory` が入力ごと閉じ込める)。
 *
 * **【残らない経路を隠さない】** **書き直しは、外側にもう1枚 tx がある経路では
 * その外側の巻き戻しに巻き込まれる。** HTTP / 受信 capability は失敗しても
 * `ok:false` を **return する**(throw しない)ので外側は commit し、記録は残る。
 * **バッチ(`batch.ts`)は `throw new BatchOpFailure` でバッチ全体を巻き戻すので、
 * 書き直した履歴も一緒に消える**(ADR-0039 限定3。`batch.ts` には1バイトも足さない
 * = ADR-0066 限定8)。**「全部残るようになった」とは書けない。**
 */
function runWithWorkflows(
  db: Database,
  table: Table,
  write: (rewrites: (() => void)[]) => { row: RecordRow; failures: string[] },
): RecordResult<RecordRow> {
  // 巻き戻した後に呼ぶ「失敗の履歴を書き直す」thunk の受け皿。**tx の外の変数**なので、
  // 巻き戻っても中身は残る(巻き戻るのは DB であって JS の値ではない)。
  const rewrites: (() => void)[] = [];
  const parent = workflowTxStack[workflowTxStack.length - 1];
  workflowTxStack.push(rewrites);
  const tx = db.transaction((): RecordRow => {
    const { row, failures } = write(rewrites);
    if (failures.length > 0) {
      // **全アクションを最後まで実行したうえで**巻き戻す(途中で止めない = 限定3)。
      throw new WorkflowActionFailure(failures);
    }
    return row;
  });
  try {
    const row = tx();
    // commit した。**自分の tx では消えない**が、**外側の器がまだ開いていれば、そこが
    // 巻き戻ったときに一緒に消える**(再発火抑止の記録がこの形になる —— 抑止は失敗として
    // 扱われないので内側は commit するが、外側が別の理由で失敗しうる)。**外側へ引き継ぐ。**
    parent?.push(...rewrites);
    return ok(row);
  } catch (error) {
    if (error instanceof WorkflowActionFailure) {
      // ここに来た時点で tx は巻き戻っている(部分適用ゼロ)。
      // **巻き戻しの外で、失敗の記録だけを書き直す**(ADR-0066 限定5)。
      for (const rewrite of rewrites) {
        rewrite();
      }
      // 書き直した先は**外側の器の内側**でもありうる。外側も巻き戻るなら、そこでもう一度
      // 書き直す必要がある(二重には書かれない —— 外側が巻き戻せば今書いた行は消える)。
      parent?.push(...rewrites);
      return fail([workflowFailureError(table, error.failures)]);
    }
    // **順番待ちの上限を過ぎた書込だけは、業務の言葉に翻訳して返す**
    // (V3-M13-T15 / ADR-0069 §Decision 3。限定12: 文面の出所は `errors.ts` の1関数だけ)。
    // ここに来た時点で tx は巻き戻っている(1バイトも書かれていない)。
    // **`conflict:true` は立てない**(限定9。「版が古い」と「今は書けない」は別の事実)。
    const busy = concurrentWriteBusyErrors(error);
    if (busy !== null) {
      return fail(busy);
    }
    // 想定外の例外は握り潰さない —— 静かな部分適用にせず、呼び出し元へ伝播させる
    // (`batch.ts` と同じ作法)。**アクションが投げた例外はここへ来ない** ——
    // `runActions` の `try/catch` が値に変換済みである(限定4)。
    throw error;
  } finally {
    workflowTxStack.pop();
  }
}

// --- 読取専用の差し替え(SQ-M1)---------------------------------------------------
//
// **読み取りの4本だけ**が、「解決済みの `Table`」と「FROM 句のソース」を受け取れる。
// システムテーブル(ADR-0006)は `manifest.app.tables` に現れないので `findTable` では
// 解決できず、FROM だけを差し替えても手前の `unknownTableError` で落ちる。**解決とソースの
// 両方を渡せなければ、読取を SQL 経路へ一本化できない。**
//
// **書き込みの3本(作成・更新・削除)には渡せない。** 3本は `findTable`(マニフェスト限定)と
// 共有の1件読み出しを今日のまま使い続ける —— ADR-0006 §8 の「書き込み経路では
// 『解決しないこと』が安全性を担保する」を1バイトも動かさないためである。
// **この引数を足したことで書込に届く経路は1本も増えていない。**
//
// **この注釈は書込3本と共有の1件読み出しの綴りを1度も書かない** —— 差分に綴りが残ると、
// 「書込経路に差分が無いこと」を grep で数える判定が、注釈だけで1件と数えてしまう。

/**
 * 読取専用の差し替え。**この型は export しない**(ADR-0007 Δ8 を発火させない)。
 * 呼び出し側はオブジェクトリテラルを渡すだけでよい(構造的型付け)。
 */
type ReadOverride = {
  /** 解決済みのテーブル定義。渡されたら `findTable` は引かない。 */
  table: Table;
  /** FROM 句にそのまま置く SQL 片(引用済みの識別子、または副問合せ)。 */
  from: string;
  /** `sort` 未指定のときの ORDER BY。省略時は今日どおり `_created_at ASC, _id ASC`。 */
  defaultOrderBy?: string;
};

/** 読取対象のテーブル定義(差し替えがあればそれを、無ければマニフェストから)。 */
function readTable(
  manifest: Manifest,
  tableId: ResourceId,
  override: ReadOverride | undefined,
): Table | undefined {
  return override === undefined ? findTable(manifest, tableId) : override.table;
}

/** FROM 句のソース(差し替えが無ければ今日どおり物理テーブル名)。 */
function readFrom(table: Table, override: ReadOverride | undefined): string {
  return override === undefined ? quoteIdentifier(table.id) : override.from;
}

/**
 * 差し替えたソースから1件読む(`getRecord` 専用)。
 *
 * **共有の1件読み出し(上の方にある方)を呼ばない。** あちらは書込3本との共有であり、
 * ADR-0006 §8 の論証が「書込では解決しない」ことに乗っている。読取専用の口をここに
 * 分けておけば、差し替えの引数が書込側へ届く経路が構造的に存在しない。
 */
function selectOneFrom(db: Database, table: Table, from: string, id: string): RecordRow | null {
  const sql = `SELECT ${selectColumns(table)} FROM ${from} WHERE ${quoteIdentifier(SYSTEM_COLUMNS.id)} = ?`;
  const raw = db.query(sql).get(id) as RawRow | null;
  return raw === null ? null : toRecordRow(table, raw);
}

/** レコードを1件取得する。存在しなければ `null`(エラーではない)。 */
export function getRecord(
  db: Database,
  manifest: Manifest,
  tableId: ResourceId,
  id: string,
  override?: ReadOverride,
): RecordResult<RecordRow | null> {
  const table = readTable(manifest, tableId, override);
  if (table === undefined) {
    return fail([unknownTableError(manifest, tableId)]);
  }
  if (override !== undefined) {
    return ok(selectOneFrom(db, table, override.from, id));
  }
  return ok(selectRow(db, table, id));
}

// --- ブール式フィルタの WHERE 再帰コンパイル(EC-G12 / ADR-0043)---------------------
//
// `FilterNode`(and/or/not + 有限の葉演算子)を WHERE 句へ再帰コンパイルする。
// **値は必ずプレースホルダ(?)で束ね、文字列連結でクエリを組まない(インジェクション不可)。**
// 識別子は `quoteIdentifier`(検証つき)でのみ埋める。**絞り込みをコンパイルするのは
// この1本だけである** —— システムテーブルの投影もここを通る(SQ-M4 で一本化した)。
// 深度上限(`MAX_FILTER_DEPTH`)は、役割の条件や要件ドキュメントの生成器が import して共有する。

/** ブール式フィルタのネスト深度上限(ADR-0043 §3 限定3。DoS/停止性の歯止め)。 */
export const MAX_FILTER_DEPTH = 8;

/** 有限の葉演算子(ちょうど5種。ADR-0043 §3 限定1。これを増やすには門A)。 */
const LEAF_OPERATORS = ["equals", "contains", "gte", "lte", "in"] as const;

type CompiledWhere = { sql: string; bindings: (string | number | null)[] };

/** 常に偽(1件も返さない)。値が不正で SQL に到達させないときの安全なプレースホルダ。 */
const ALWAYS_FALSE: CompiledWhere = { sql: "0", bindings: [] };

/** filter がブール式ノードではなく後方互換の等値AND配列かどうか。 */
function isFilterArray(filter: FilterCondition[] | FilterNode): filter is FilterCondition[] {
  return Array.isArray(filter);
}

/** 葉述語を WHERE 断片へコンパイルする(演算子は5種・1葉1演算子)。 */
function compileLeaf(
  db: Database,
  byId: Map<ResourceId, Field>,
  table: Table,
  leaf: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
): CompiledWhere {
  const fieldId = leaf.field;
  if (typeof fieldId !== "string" || !byId.has(fieldId)) {
    errors.push({
      path: `${path}/field`,
      message: `絞り込みに指定されたフィールド "${String(fieldId)}" はテーブル "${table.id}" に存在しません。`,
      allowed_values: fieldIds(table),
      hint: `テーブル "${table.id}" に実在するフィールドIDを指定してください。`,
    });
    return ALWAYS_FALSE;
  }
  const field = byId.get(fieldId) as Field;
  const present = LEAF_OPERATORS.filter((op) => op in leaf);
  if (present.length !== 1) {
    errors.push({
      path,
      message: `絞り込みの葉には演算子(${LEAF_OPERATORS.join(" / ")})をちょうど1つ指定してください(${present.length} 個指定されています)。`,
      hint: "1つの葉には演算子1つだけを書き、複数条件は and/or/not で結合してください。",
    });
    return ALWAYS_FALSE;
  }
  const op = present[0] as (typeof LEAF_OPERATORS)[number];
  const col = quoteIdentifier(field.id);

  if (op === "contains") {
    if (field.type === "number" || field.type === "boolean") {
      errors.push({
        path: `${path}/contains`,
        message: `contains は文字列フィールドにのみ使えます(フィールド "${field.id}" の型は "${field.type}" です)。`,
        hint: "部分一致は text / long_text / select / date / reference のような文字列フィールドで指定してください。",
      });
      return ALWAYS_FALSE;
    }
    const raw = leaf.contains;
    if (typeof raw !== "string") {
      errors.push({
        path: `${path}/contains`,
        message: `contains の値 ${JSON.stringify(raw)} は文字列ではありません。`,
        hint: "部分一致で探す文字列を指定してください。",
      });
      return ALWAYS_FALSE;
    }
    // **`instr` を使う(LIKE ではない)。**instr は値をリテラルの部分文字列として扱うので
    // `%` / `_` はワイルドカードにならず、大文字小文字も区別する。これは JS の
    // `String.includes` と同じ意味論である(ADR-0043 §3 限定6。かつて read-records.ts が
    // 持っていた2つ目の実装と割れないための選択で、その実装は SQ-M4 で消えた)。
    // 値はプレースホルダで束ねる。
    return { sql: `instr(${col}, ?) > 0`, bindings: [raw] };
  }

  if (op === "in") {
    const arr = leaf.in;
    if (!Array.isArray(arr)) {
      errors.push({
        path: `${path}/in`,
        message: `in の値 ${JSON.stringify(arr)} は配列ではありません。`,
        hint: "いずれかに一致させたい値の配列を指定してください。",
      });
      return ALWAYS_FALSE;
    }
    if (arr.length === 0) {
      // 空の in は「候補が1つも無い」= 常に偽。
      return ALWAYS_FALSE;
    }
    const bindings: (string | number | null)[] = [];
    arr.forEach((element, i) => {
      const bound = validateFieldValue(db, field, element, `${path}/in/${i}`, errors);
      if (bound !== undefined) {
        bindings.push(bound);
      }
    });
    if (bindings.length !== arr.length) {
      return ALWAYS_FALSE;
    }
    return { sql: `${col} IN (${arr.map(() => "?").join(", ")})`, bindings };
  }

  // equals / gte / lte —— 値は既存の型検証を通し、比較演算子を SQL に写す。
  const bound = validateFieldValue(db, field, leaf[op], `${path}/${op}`, errors);
  if (bound === undefined) {
    return ALWAYS_FALSE;
  }
  const comparator = op === "gte" ? ">=" : op === "lte" ? "<=" : "=";
  return { sql: `${col} ${comparator} ?`, bindings: [bound] };
}

/** ブールノード(and/or/not)または葉を WHERE 断片へ再帰コンパイルする。 */
function compileNode(
  db: Database,
  byId: Map<ResourceId, Field>,
  table: Table,
  node: unknown,
  path: string,
  depth: number,
  errors: ValidationError[],
): CompiledWhere {
  if (depth > MAX_FILTER_DEPTH) {
    errors.push({
      path,
      message: `絞り込み条件のネストが深すぎます(深度上限 ${MAX_FILTER_DEPTH} 段)。`,
      hint: "and / or / not のネストを浅くしてください(無限ネストは受け付けません)。",
    });
    return ALWAYS_FALSE;
  }
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    errors.push({
      path,
      message: `絞り込み条件はオブジェクトである必要があります(${JSON.stringify(node)})。`,
      hint: "葉 {field, <演算子>} か、and / or / not のブールノードを指定してください。",
    });
    return ALWAYS_FALSE;
  }
  const obj = node as Record<string, unknown>;

  if ("and" in obj || "or" in obj) {
    const kind = "and" in obj ? "and" : "or";
    const items = obj[kind];
    if (!Array.isArray(items)) {
      errors.push({
        path: `${path}/${kind}`,
        message: `${kind} の値は配列である必要があります。`,
        hint: `${kind} で結合する条件の配列を指定してください。`,
      });
      return ALWAYS_FALSE;
    }
    if (items.length === 0) {
      // 空の and は真(全件)・空の or は偽(0件)。
      return kind === "and" ? { sql: "1", bindings: [] } : ALWAYS_FALSE;
    }
    const parts = items.map((item, i) =>
      compileNode(db, byId, table, item, `${path}/${kind}/${i}`, depth + 1, errors),
    );
    const joiner = kind === "and" ? " AND " : " OR ";
    return {
      sql: `(${parts.map((p) => p.sql).join(joiner)})`,
      bindings: parts.flatMap((p) => p.bindings),
    };
  }

  if ("not" in obj) {
    const inner = compileNode(db, byId, table, obj.not, `${path}/not`, depth + 1, errors);
    return { sql: `(NOT (${inner.sql}))`, bindings: inner.bindings };
  }

  // ブール結合キーが無ければ葉として扱う。
  return compileLeaf(db, byId, table, obj, path, errors);
}

/**
 * filter(等値AND配列 | ブール式ノード)を WHERE 断片へコンパイルする(EC-G12 / ADR-0043)。
 * 後方互換の配列形は暗黙 AND とし、エラーの path も従来どおり `/filter/<index>/...` を保つ。
 */
function compileFilter(
  db: Database,
  byId: Map<ResourceId, Field>,
  table: Table,
  filter: FilterCondition[] | FilterNode,
  errors: ValidationError[],
): CompiledWhere {
  if (isFilterArray(filter)) {
    if (filter.length === 0) {
      return { sql: "1", bindings: [] };
    }
    const parts = filter.map((condition, index) =>
      compileLeaf(
        db,
        byId,
        table,
        condition as Record<string, unknown>,
        `/filter/${index}`,
        errors,
      ),
    );
    return {
      sql: parts.map((p) => p.sql).join(" AND "),
      bindings: parts.flatMap((p) => p.bindings),
    };
  }
  return compileNode(db, byId, table, filter, "/filter", 0, errors);
}

/**
 * レコードを一覧する(list_view 相当の sort / filter をサポート)。
 *
 * sort は `{field, order}`。filter は **等値AND配列(後方互換)| ブール式(and/or/not +
 * 有限の葉演算子 equals/contains/gte/lte/in。EC-G12 / ADR-0043)**。
 * 対象フィールドがマニフェストに存在することを検証してからでなければ
 * SQL には到達しない。sort 未指定時は作成順(`_created_at`, `_id`)で安定に返す。
 */
export function listRecords(
  db: Database,
  manifest: Manifest,
  tableId: ResourceId,
  options: ListRecordsOptions = {},
  override?: ReadOverride,
): RecordResult<RecordRow[]> {
  const table = readTable(manifest, tableId, override);
  if (table === undefined) {
    return fail([unknownTableError(manifest, tableId)]);
  }

  const errors: ValidationError[] = [];
  const byId = new Map(table.fields.map((field) => [field.id, field]));
  // sort / filter ではシステム列も指定できる(作成順の一覧などに使う)。
  const sortableIds = [...fieldIds(table), ...SYSTEM_COLUMN_NAMES];

  const bindings: (string | number | null)[] = [];
  let whereClause = "";
  if (options.filter !== undefined) {
    const compiled = compileFilter(db, byId, table, options.filter, errors);
    whereClause = ` WHERE ${compiled.sql}`;
    bindings.push(...compiled.bindings);
  }

  let orderBy =
    override?.defaultOrderBy ??
    `${quoteIdentifier(SYSTEM_COLUMNS.createdAt)} ASC, ${quoteIdentifier(SYSTEM_COLUMNS.id)} ASC`;
  const sortKeys = validateSortKeys(options.sort, table, sortableIds, errors);
  if (sortKeys.length > 0) {
    // order は "asc" | "desc" の語彙に閉じているので、そのまま SQL に写して安全。
    // 複合ソートは `ORDER BY a DESC, b ASC` にそのまま写る(V1-M0-T03 / F-8)。
    orderBy = sortKeys
      .map((key) => `${quoteIdentifier(key.field)} ${key.order === "desc" ? "DESC" : "ASC"}`)
      .join(", ");
  }

  // ページネーション(EC-G11 / ADR-0042)。値が不正なら SQL に到達させない。
  validatePageParam("limit", options.limit, errors);
  validatePageParam("offset", options.offset, errors);

  if (errors.length > 0) {
    return fail(errors);
  }

  // LIMIT / OFFSET を SQL に足す(ORDER BY の後段)。limit 未指定なら全件(既存挙動)。
  // offset だけ指定されたときは SQLite の作法どおり `LIMIT -1 OFFSET ?`(= 上限なしでスキップ)。
  let pageClause = "";
  if (options.limit !== undefined) {
    pageClause += " LIMIT ?";
    bindings.push(options.limit);
  }
  if (options.offset !== undefined) {
    if (options.limit === undefined) {
      pageClause += " LIMIT -1";
    }
    pageClause += " OFFSET ?";
    bindings.push(options.offset);
  }

  const sql = `SELECT ${selectColumns(table)} FROM ${readFrom(table, override)}${whereClause} ORDER BY ${orderBy}${pageClause}`;
  const raws = db.query(sql).all(...bindings) as RawRow[];
  return ok(raws.map((raw) => toRecordRow(table, raw)));
}

/**
 * レコード件数を返す(テスト・一覧のページング判断用)。
 *
 * `options.filter` を渡すと **filter 適用後の件数**を数える(EC-G12 / ADR-0043。
 * EC-G11 ページネーションの total 整合の前提。T02)。filter は `listRecords` と
 * まったく同じ意味論・同じ再帰コンパイラ(`compileFilter`)を通るので、
 * 「一覧に出る件数」と「total」が割れない。省略時は全件数(従来どおり)。
 */
export function countRecords(
  db: Database,
  manifest: Manifest,
  tableId: ResourceId,
  options: { filter?: FilterCondition[] | FilterNode } = {},
  override?: ReadOverride,
): RecordResult<number> {
  const table = readTable(manifest, tableId, override);
  if (table === undefined) {
    return fail([unknownTableError(manifest, tableId)]);
  }

  const errors: ValidationError[] = [];
  const bindings: (string | number | null)[] = [];
  let whereClause = "";
  if (options.filter !== undefined) {
    const byId = new Map(table.fields.map((field) => [field.id, field]));
    const compiled = compileFilter(db, byId, table, options.filter, errors);
    whereClause = ` WHERE ${compiled.sql}`;
    bindings.push(...compiled.bindings);
  }
  if (errors.length > 0) {
    return fail(errors);
  }

  const row = db
    .query(`SELECT COUNT(*) AS n FROM ${readFrom(table, override)}${whereClause}`)
    .get(...bindings) as {
    n: number;
  };
  return ok(row.n);
}

/**
 * **件数と、宣言された `number` 列の合計を、同じ1文で返す**(`V4-M23-T02`。
 * `D-V4-89` / `E-G31` / `ADR-0104` 限定2・限定3・限定5・限定6・限定11)。
 *
 * ## なぜ `countRecords` を書き換えず、隣に置いたのか(**正直に書く**)
 *
 * **`ADR-0104` 限定6 の逐語は「`countRecords` の `SELECT COUNT(*) …` に集約列を足す」である。**
 * **その字面どおりにはしていない。** 理由は **`ADR-0113` 限定6**(2026-08-04 時点で有効)が
 * 逐語で「**`total` は今日どおり集約カウントのままで、`countRecords` を1バイトも触っていない**」
 * と書いており、**`src/kernel/view-page-size.test.ts` がそれを検査で固定しているためである。**
 * **2つの限定表が正面から食い違っている。** **本実装は「`countRecords` を1バイトも触らない」
 * 側を採り、同じ形の SQL を隣の関数に置いた。**
 *
 * **限定6 が実際に要求している中身(「別クエリを1本も増やさない」)は満たしている** ——
 * **この関数は件数と合計を `SELECT COUNT(*) AS n, SUM(<列>) AS s …` の1文で採り、
 * 呼び出し側は `countRecords` の代わりにこれを1回呼ぶ。** **DB への往復は増えない。**
 * **食い違いの記録は `docs/plan/v4/records/v4-m23-impl.md` §2-2 が持つ。**
 *
 * ## 何を検査し、何を検査しないか
 *
 * - **`sumField` が対象テーブルに実在し、`number` 型であることを検査する**(限定3)。
 *   **違反は `ValidationError` で返し、SQL を1文も投げない。**
 * - **見せる相手はここで検査しない** —— **カーネルは「見せる相手」の射影を持たない**
 *   (それはサーバ層 `owner-scope.ts` の担当である)。**宣言の側は
 *   `referential-integrity.ts` が apply 時に止め、読取パラメータの側は `src/server/app.ts`
 *   が止める。** **判定の家を取り違えない。**
 *   **【2026-08-10 追記(`V8-M20`。台帳 `J-G27` / `J-G28`。手続きは `ADR-0301`)。
 *   旧文を1バイトも消していない】** **着手前の逐語は「**`audience` はここで検査しない**」
 *   だった。****そのキーは `V8-M20` が廃止したので、今日は存在しない** —— **見せる相手を
 *   決めるのは `app.roles[].rules` の「役割 × 対象 × できること」である。**
 *   **`referential-integrity.ts` が apply 時に止めるのは、今日は「役割の規則が名指しして
 *   いる項目を `sum_field` に指していないか」である。****判定の家は変わっていない。**
 * - **`group_by` / `having` / 2つ目の演算を1つも持たない**(限定2 / 限定8 / 限定9)——
 *   **束ねるキーも、集計値で絞る口も、この関数の引数に無い。**
 *
 * ## 合計の意味論(**JS 側の写しと必ず一致させること**)
 *
 * **`SUM()` は NULL を無視し、行が1件も無ければ NULL を返す。** **それを `0` に倒す** ——
 * **`src/server/app.ts` の post-filter 分岐(限定7)が JS で足すときも、値が数でない行を
 * 飛ばして `0` から始める。** **2つの分岐が同じ数を返すことを
 * `src/server/list-view-sum-boundary.test.ts` が本物の SQLite と本物の HTTP で固定する。**
 *
 * **合計は読取専用の導出値である**(限定11)—— **この関数は行を1件も作らず、1件も
 * 書き換えず、システムテーブルを1本も増やさない。**
 */
export function countAndSumRecords(
  db: Database,
  manifest: Manifest,
  tableId: ResourceId,
  options: { filter?: FilterCondition[] | FilterNode; sumField?: ResourceId } = {},
  override?: ReadOverride,
): RecordResult<{ count: number; sum: number | null }> {
  const table = readTable(manifest, tableId, override);
  if (table === undefined) {
    return fail([unknownTableError(manifest, tableId)]);
  }

  const errors: ValidationError[] = [];
  const bindings: (string | number | null)[] = [];
  let whereClause = "";
  if (options.filter !== undefined) {
    const byId = new Map(table.fields.map((field) => [field.id, field]));
    const compiled = compileFilter(db, byId, table, options.filter, errors);
    whereClause = ` WHERE ${compiled.sql}`;
    bindings.push(...compiled.bindings);
  }

  // **集約列は「宣言された1列」だけである**(限定2)—— 列名は識別子として引用し、
  // **値をそのまま SQL へ差し込まない。** 実在と型はここで止める(限定3)。
  let sumClause = "";
  if (options.sumField !== undefined) {
    const field = table.fields.find((candidate) => candidate.id === options.sumField);
    if (field === undefined) {
      errors.push({
        path: "/sum",
        message: `合計を出す列 "${options.sumField}" はテーブル "${table.id}" にありません。`,
        allowed_values: table.fields
          .filter((candidate) => candidate.type === "number")
          .map((candidate) => candidate.id),
        hint: "そのテーブルに実在する number のフィールドを指定してください。",
      });
    } else if (field.type !== "number") {
      errors.push({
        path: "/sum",
        message: `合計を出す列 "${options.sumField}" は ${field.type} 型です。合計を出せるのは number だけです。`,
        allowed_values: table.fields
          .filter((candidate) => candidate.type === "number")
          .map((candidate) => candidate.id),
        hint: "number のフィールドを指定してください(足し算の意味が定まるのは number だけです)。",
      });
    } else {
      sumClause = `, SUM(${quoteIdentifier(field.id)}) AS s`;
    }
  }

  if (errors.length > 0) {
    return fail(errors);
  }

  // **同じ1文である**(限定6)—— 件数と合計で DB を2度叩かない。
  const row = db
    .query(`SELECT COUNT(*) AS n${sumClause} FROM ${readFrom(table, override)}${whereClause}`)
    .get(...bindings) as { n: number; s?: number | null };
  return ok({
    count: row.n,
    // **合計を求めていない呼び出しには `null` を返す**(`0` を返すと「0円だった」と
    // 読めてしまう)。**求めた場合は、行が0件でも NULL でも `0` に倒す。**
    sum: sumClause === "" ? null : (row.s ?? 0),
  });
}

/**
 * レコードを部分更新する。入力に含まれるフィールドだけを更新し、
 * `_updated_at` を必ず進める。`_id` / `_created_at` は変更しない。
 *
 * ## 楽観ロック(CAS。V1-M9-T02)
 *
 * `expectedVersion`(= 更新前に読んだ `_updated_at` トークン)を渡すと、
 * `UPDATE ... WHERE _id=? AND _updated_at=?` の **compare-and-swap** になる。
 * 誰かが先に更新して版が進んでいれば `changes===0` になり、`conflict:true` の失敗を返す
 * (本体は1バイトも変わらない)。**`expectedVersion` を省略すると CAS せず現行の
 * LWW(last-writer-wins)のまま**であり、既存の呼び出し・ワークフローランナ
 * (`workflow-runner.ts` の自動化)は無傷である。必須化は配線層(HTTP `If-Match` /
 * MCP `if_match`)でのみ行う(ADR-0017)。
 *
 * 版トークンに新しい列は足さない。`nextTimestamp` が単調増加する固定幅の
 * `toISOString()` を書くので、辞書順=時系列順で文字列等価 CAS が成立する。
 *
 * L2(安全側の既知挙動): 存在確認(下の `selectRow`)から UPDATE までの間に別接続が
 * この行を delete した場合も `changes===0` になり「衝突」を返す。実体は不在だが、
 * 単一ライタ直列化下では稀であり、**silent-overwrite を起こさない安全側**なので許容する。
 */
export function updateRecord(
  db: Database,
  manifest: Manifest,
  tableId: ResourceId,
  id: string,
  input: RecordInput,
  expectedVersion?: string,
): RecordResult<RecordRow> {
  // レコードの存在確認より先に拒否する。存在しないレコードIDへの更新が
  // 「レコードがありません」で返ると、「レコードさえあれば書ける」という
  // 誤った推論を許す(ADR-0006 §7 の判定順序)。
  if (isSystemTableId(tableId)) {
    return fail([readOnlyTableError(manifest, tableId)]);
  }
  const table = findTable(manifest, tableId);
  if (table === undefined) {
    return fail([unknownTableError(manifest, tableId)]);
  }
  const existingRow = selectRow(db, table, id);
  if (existingRow === null) {
    return fail([
      {
        path: "",
        message: `テーブル "${table.id}" にレコード "${id}" は存在しません。`,
        hint: "一覧(listRecords)で実在する _id を確認してください。",
      },
    ]);
  }

  // `id` を渡して自分自身の行を unique 照会から除外する(EC-G8 / ADR-0038)——
  // 自分の値のまま(あるいは自分の値へ)更新しても「重複」にはならない。
  // **更新前の行も渡す**(V4-M10-T07 / ADR-0078)—— `unique: "owner"` のスコープ値は、
  // 入力に `st_owner` が無い部分更新では既存行から取るしかない。**新しい読取は増やして
  // いない**(この行は元から `selectRow` で読んでいた存在確認の結果である)。
  const validated = validateInput(db, table, input, true, id, existingRow);
  if (!validated.ok) {
    return fail(validated.errors);
  }

  const assignments = [...validated.value.keys()].map((key) => `${quoteIdentifier(key)} = ?`);
  assignments.push(`${quoteIdentifier(SYSTEM_COLUMNS.updatedAt)} = ?`);
  const values: (string | number | null)[] = [
    ...validated.value.values(),
    nextTimestamp(db, table, id),
  ];
  // CAS 本体は WHERE 句のみ。`expectedVersion` があれば版一致を条件に足す(V1-M9-T02)。
  let sql =
    `UPDATE ${quoteIdentifier(table.id)} SET ${assignments.join(", ")} ` +
    `WHERE ${quoteIdentifier(SYSTEM_COLUMNS.id)} = ?`;
  const whereBindings: (string | number | null)[] = [id];
  if (expectedVersion !== undefined) {
    sql += ` AND ${quoteIdentifier(SYSTEM_COLUMNS.updatedAt)} = ?`;
    whereBindings.push(expectedVersion);
  }
  // 版不一致(衝突)は**巻き戻す対象ではない** —— UPDATE が1行も書いていないので、
  // 器の外で判定して従来どおり `conflict:true` を返す(ADR-0066 限定13: CAS の意味論を
  // 1バイトも変えない)。
  let versionConflict = false;

  // [行の書込 + ワークフローの発火] を1つの deferred tx で包む(ADR-0066 §Decision 1)。
  const written = runWithWorkflows(db, table, (rewrites) => {
    const result = db.query(sql).run(...values, ...whereBindings);
    // 存在確認は上で済んでいる。版指定ありで changes===0 = 版不一致(または L2 の削除競合)= 衝突。
    if (expectedVersion !== undefined && result.changes === 0) {
      versionConflict = true;
      throw new WorkflowActionFailure([]);
    }

    const row = selectRow(db, table, id);
    if (row === null) {
      throw new Error(`レコード "${id}" の更新直後の読み出しに失敗しました。`);
    }
    // ワークフローの発火(ADR-0013 §5a / V1-M2-T02)。**`selectRow` の後**に置く ——
    // 部分更新では `validated.value` が入力に含まれた列しか持たないので、
    // UPDATE 直後の値では `$record.<フィールドID>` を解決できない。
    // `runWorkflows` は例外を投げない(`0013:417` の後段は1バイトも変えていない)が、
    // **失敗の説明を返す**ようになった(V3-M13-T02)。
    return { row, failures: runWorkflows(db, manifest, table.id, "on_update", row, rewrites) };
  });
  if (versionConflict) {
    return conflict([versionConflictError(table, id)]);
  }
  return written;
}

/**
 * `_updated_at` に入れる時刻を返す。
 *
 * ミリ秒解像度の時計では「作成直後の更新」で同じ値になりうるが、
 * 更新したのに `_updated_at` が進まないのは呼び出し側から見て嘘になるため、
 * 現在時刻が既存値以下なら 1ms 進めて必ず単調増加させる。
 */
function nextTimestamp(db: Database, table: Table, id: string): string {
  const sql = `SELECT ${quoteIdentifier(SYSTEM_COLUMNS.updatedAt)} AS updated FROM ${quoteIdentifier(table.id)} WHERE ${quoteIdentifier(SYSTEM_COLUMNS.id)} = ?`;
  const current = db.query(sql).get(id) as { updated: string } | null;
  const now = new Date();
  if (current !== null && now.toISOString() <= current.updated) {
    return new Date(new Date(current.updated).getTime() + 1).toISOString();
  }
  return now.toISOString();
}

/**
 * レコードを物理削除する。
 *
 * 返り値で **削除成功 / 不在 / 版不一致(衝突)** を区別する(V1-M9-T02):
 * - `ok:true`(値 `true`) …… 削除できた。
 * - `ok:true`(値 `false`) …… 対象が存在しなかった(不在)。**版の有無に依らず bool で返す**。
 * - `conflict:true` の失敗 …… `expectedVersion` を渡し、版が一致しなかった(衝突)。
 *
 * ## 楽観ロック(CAS)と後方互換
 *
 * `expectedVersion`(= 削除前に読んだ `_updated_at`)を渡すと
 * `DELETE ... WHERE _id=? AND _updated_at=?` の compare-and-swap になる。**省略すると
 * CAS せず、従来どおり「削除成功=true / 不在=false」の bool 挙動を保つ**(既存の呼び出し
 * `src/server/app.ts` / `src/mcp/tools/write.ts` は版を渡さないので無傷)。
 *
 * v0 の `deleteRecord` は存在確認を持たなかったが、update と挙動を揃えて**存在確認 → CAS**
 * の2段にした(M4)。不在は `ok:false`、衝突は `conflict:true` として明確に分かれる。
 * L2(安全側): 存在確認から DELETE の間に別接続が消した場合、版指定時は「衝突」を返す
 * (実体は不在だが silent-overwrite は起きない安全側)。版を渡さない従来経路では
 * その稀ケースを「不在(false)」として返し、bool 契約を崩さない。
 */
export function deleteRecord(
  db: Database,
  manifest: Manifest,
  tableId: ResourceId,
  id: string,
  expectedVersion?: string,
): RecordResult<boolean> {
  // L1(最終防衛線)。判定はテーブル解決より**前**に置く(ADR-0006 §8)。
  if (isSystemTableId(tableId)) {
    return fail([readOnlyTableError(manifest, tableId)]);
  }
  const table = findTable(manifest, tableId);
  if (table === undefined) {
    return fail([unknownTableError(manifest, tableId)]);
  }
  // 存在確認(M4)。不在は版の有無に依らず bool の false で返す(衝突とは区別)。
  if (selectRow(db, table, id) === null) {
    return ok(false);
  }
  let sql = `DELETE FROM ${quoteIdentifier(table.id)} WHERE ${quoteIdentifier(SYSTEM_COLUMNS.id)} = ?`;
  const bindings: (string | number | null)[] = [id];
  if (expectedVersion !== undefined) {
    sql += ` AND ${quoteIdentifier(SYSTEM_COLUMNS.updatedAt)} = ?`;
    bindings.push(expectedVersion);
  }
  const result = db.query(sql).run(...bindings);
  if (result.changes > 0) {
    return ok(true);
  }
  // 存在確認は通ったのに消えなかった。版指定あり = 版不一致(または L2 の削除競合)= 衝突。
  // 版を渡さない従来経路では bool 契約を保つため「不在(false)」に落とす(単一ライタ下で稀)。
  return expectedVersion !== undefined ? conflict([versionConflictError(table, id)]) : ok(false);
}
