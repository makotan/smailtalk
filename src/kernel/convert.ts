/**
 * 変換マトリクス(ADR-0010 §5b / §5c)の実装と、変換可否の事前判定(V1-M1-T03)。
 *
 * このモジュールは**値の意味論だけ**を持ち、DDL を1文も発行しない。テーブル再構築は
 * `rebuild-table.ts`、実行計画の導出は `migrate.ts` の担当である。
 *
 * ## 正はここではなく ADR である
 *
 * ADR-0010 Status が「実装との食い違いが出たときに正なのは実装ではなく本 ADR であり、
 * 食い違いは本 ADR の改訂として処理する」と書いている。したがって
 * `convert.test.ts` は ADR §5b の表を**書き写した定数**と付き合わせる形にしてある。
 * ここを直したら、あちらが赤くなるのが正しい向きである。
 *
 * ## 「不」は「難しい」ではなく「意味が一意に決まらない」(ADR-0010 §5b 注意2)
 *
 * `number` → `date`(エポック秒とみなす)や `reference` → `number` は、**書かれて
 * いない約束を持ち込まないと変換できない**。これは ADR-0007 の Δ4(マニフェストの
 * 意味がファイル外の知識に依存する)と同型なので、条件付きにせず語彙として認めない。
 * **したがって「不」セルは、対象テーブルが空でも(1行も変換対象が無くても)拒否する。**
 *
 * ## 変換不能値は拒否のみ(ADR-0010 §6 / 限定7)
 *
 * `null` 化・デフォルト値・切り捨ては**実装しない。op の引数でも選べるようにしない。**
 * カーネルがユーザデータを黙って書き換えたとき、ユーザがそれを知る手段が存在しない
 * ためである(`RECORD_WRITE_NOT_IN_CHANGELOG`)。`hint` は「先に `update_record` /
 * `delete_record` で該当行を直してから、改めて送る」という**一回限りの手数**だけを
 * 案内する(ADR-0010 §6a の W-B)。
 */

import type { Database } from "bun:sqlite";
import { quoteIdentifier, SYSTEM_COLUMNS, sqliteTypeForFieldType } from "./ddl.ts";
import type { ValidationError } from "./errors.ts";
import type { Field, FieldType, ResourceId } from "./types.ts";

/** 変換可否の3値(ADR-0010 §5b の凡例「可 / 条 / 不」)。 */
export type ConversionVerdict = "possible" | "conditional" | "impossible";

/**
 * 変換不能行をエラーメッセージに載せる最大件数(ADR-0010 §7 失敗4 の「最大N件」)。
 *
 * N を5にしたのは、`allowed_values` を含む既存のエラー文面がどれも一覧を数個に
 * 抑えているのと揃えたためである。**打ち切った場合も総数は必ず正確に述べる**
 * —— 「5件です」と言って実際は 200 件、が最も有害な壊れ方である(憲法6)。
 */
export const UNCONVERTIBLE_SAMPLE_LIMIT = 5;

/**
 * ADR-0010 §5b のマトリクス。**行 = 変換元、列 = 変換先。**
 *
 * 対角(同一型)は「変換しない」であり `possible` として扱う。ADR の表では `—` である。
 */
const MATRIX: Record<FieldType, Record<FieldType, ConversionVerdict>> = {
  text: {
    text: "possible",
    long_text: "possible",
    number: "conditional",
    boolean: "conditional",
    date: "conditional",
    select: "conditional",
    reference: "conditional",
    image: "impossible",
    file: "impossible",
  },
  long_text: {
    text: "possible",
    long_text: "possible",
    number: "conditional",
    boolean: "conditional",
    date: "conditional",
    select: "conditional",
    reference: "conditional",
    image: "impossible",
    file: "impossible",
  },
  number: {
    text: "possible",
    long_text: "possible",
    number: "possible",
    boolean: "conditional",
    date: "impossible",
    select: "conditional",
    reference: "impossible",
    image: "impossible",
    file: "impossible",
  },
  boolean: {
    text: "possible",
    long_text: "possible",
    number: "possible",
    boolean: "possible",
    date: "impossible",
    select: "conditional",
    reference: "impossible",
    image: "impossible",
    file: "impossible",
  },
  date: {
    text: "possible",
    long_text: "possible",
    number: "impossible",
    boolean: "impossible",
    date: "possible",
    select: "conditional",
    reference: "impossible",
    image: "impossible",
    file: "impossible",
  },
  select: {
    text: "possible",
    long_text: "possible",
    number: "conditional",
    boolean: "conditional",
    date: "conditional",
    select: "possible",
    reference: "conditional",
    image: "impossible",
    file: "impossible",
  },
  reference: {
    text: "possible",
    long_text: "possible",
    number: "impossible",
    boolean: "impossible",
    date: "impossible",
    select: "conditional",
    reference: "possible",
    image: "impossible",
    file: "impossible",
  },
  /**
   * **image は他型と相互変換できない**(V2-M2 / ADR-0035 §3 限定2)。
   * 他型を image にすると `_files` に無い file_id(ゴミ)ができ、image を他型にすると
   * file_id 文字列が漏れる。したがって image が絡む非対角セルはすべて `impossible`。
   * 対角(image → image)だけは「型を変えない = 変換しない」no-op なので、他の全対角と
   * 同じく `possible`(列型 TEXT が変わらず、file_id をそのまま運ぶ)。
   */
  image: {
    text: "impossible",
    long_text: "impossible",
    number: "impossible",
    boolean: "impossible",
    date: "impossible",
    select: "impossible",
    reference: "impossible",
    image: "possible",
    file: "impossible",
  },
  /**
   * **file も他型と相互変換できない**(`V5-M16` / `ADR-0161` 限定3 が `image` の線をそのまま
   * 写した)。**`image` ⇄ `file` も `impossible` である** —— 列の型は同じ TEXT だが、
   * **受け入れる種別・大きさの上限・配信の形が違う**ので、型を入れ替えると「画像として
   * 上げた実体を種別無制限の側の規則で配信する」「一般のファイルとして上げた実体を
   * 画像の配信経路に載せる」という取り違えが起きる。**同じ TEXT だからという理由で
   * 通さない。** 対角(file → file)だけは no-op なので `possible`。
   */
  file: {
    text: "impossible",
    long_text: "impossible",
    number: "impossible",
    boolean: "impossible",
    date: "impossible",
    select: "impossible",
    reference: "impossible",
    image: "impossible",
    file: "possible",
  },
};

/** 型変換の可否(ADR-0010 §5b)。 */
export function conversionVerdict(from: FieldType, to: FieldType): ConversionVerdict {
  return MATRIX[from][to];
}

/**
 * 変換の層(ADR-0010 §5a)。`1` = DDL 無操作 / `2` = テーブル再構築。
 *
 * **表を二重に持たない。** 層は「SQLite 列型が変わるか」そのものであり、
 * `ddl.ts` の `FIELD_TYPE_TO_SQLITE` から導出できる。層の表を別に書くと、
 * `ddl.ts` のマッピングを変えた日に静かにずれる。
 */
export function conversionLayer(from: FieldType, to: FieldType): 1 | 2 {
  return sqliteTypeForFieldType(from) === sqliteTypeForFieldType(to) ? 1 : 2;
}

/** 変換に成功した値、または失敗の理由。 */
export type ConvertValueResult =
  | { ok: true; value: string | number | null }
  | { ok: false; reason: string };

/** 1件のフィールド変換(型・制約の両方を含む)。事前検証と再構築の両方が入力に使う。 */
export type FieldConversion = {
  /** 走査対象テーブルの、**適用前の**ID。 */
  table: ResourceId;
  /** 走査対象列の、**適用前の**ID。 */
  field: ResourceId;
  /**
   * 走査対象列が**適用前のDBにまだ存在しない**場合に `true`。
   *
   * 同じ差分の中で `add_field` してから `change_field` した場合に起きる。
   * その列の値は全行 `null` なので、**行数だけを見て `required` の格上げを判定する**。
   * (テーブルごと新しい場合は `tableExists` が false になるので、こちらは使わない。)
   */
  source_missing?: boolean;
  /** 変換元のフィールド定義。 */
  from: Field;
  /** 変換先のフィールド定義。 */
  to: Field;
  /** エラーの JSON Pointer(`/operations/<i>/changes`)。 */
  path: string;
};

/** `required` 違反(未設定・null・空白のみの文字列)か。`records.ts:360` と同じ判定。 */
function isMissingValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  return typeof value === "string" && value.trim() === "";
}

/** ISO8601 として解釈できるか(`date` 型の受け入れ判定)。 */
function isIso8601(value: string): boolean {
  // 日付のみ / 日時のどちらも受ける。`Date.parse` は "19/07/2026" のような
  // 非 ISO 表記も環境によっては通すので、先に形を絞ってから値の妥当性を見る。
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

/** 変換元の値を「文字列としての見え方」に揃える(TEXT 系への変換と options 照合に使う)。 */
function asText(value: string | number, from: Field): string {
  if (from.type === "boolean") {
    return value === 1 || value === "1" ? "true" : "false";
  }
  return String(value);
}

/**
 * 1つの値を変換する。**変換できない場合は理由を返し、値を作らない**(限定7)。
 *
 * @param existingIds 変換先が `reference` のとき、参照先テーブルに実在する `_id` の集合。
 *                    渡されない場合、`reference` への変換は必ず失敗する(黙って通さない)。
 */
export function convertValue(
  value: unknown,
  from: Field,
  to: Field,
  existingIds?: ReadonlySet<string>,
): ConvertValueResult {
  // 型そのものが「不」なら、値を見るまでもない(ADR-0010 §5b 注意2)。
  if (conversionVerdict(from.type, to.type) === "impossible") {
    return {
      ok: false,
      reason: `"${from.type}" から "${to.type}" への変換は語彙として認められていません`,
    };
  }

  // null(未設定)はどのセルでも変換不能値にならない。null は null のまま運ばれる
  // (ADR-0010 §5b 注意1)。例外は変換先が `required: true` である場合だけで、
  // それは §5c の制約行が扱う。
  if (value === null || value === undefined) {
    if (to.required === true) {
      return { ok: false, reason: "値が未設定ですが、必須に変更されます" };
    }
    return { ok: true, value: null };
  }

  // **空文字・空白のみは `null` ではない。**「空白のみを黙って null に落とす」のは
  // カーネルがユーザデータを書き換えることであり、限定7(拒否のみ)に反する。
  // したがってここでは素通しし、型変換の側で「数値としてパースできない」等として
  // 拒否させる。`required` の格上げに対してだけ、`records.ts:360` の
  // `isMissingValue` と同じ判定で違反を見る(ADR-0010 §5c)。
  if (to.required === true && isMissingValue(value)) {
    return { ok: false, reason: "値が空白のみですが、必須に変更されます" };
  }

  const raw = value as string | number;

  switch (to.type) {
    case "text":
    case "long_text":
      return { ok: true, value: asText(raw, from) };

    case "number": {
      if (from.type === "number") {
        return { ok: true, value: Number(raw) };
      }
      if (from.type === "boolean") {
        return { ok: true, value: raw === 1 || raw === "1" ? 1 : 0 };
      }
      const text = String(raw).trim();
      const parsed = Number(text);
      if (text === "" || !Number.isFinite(parsed)) {
        return { ok: false, reason: "数値としてパースできません" };
      }
      return { ok: true, value: parsed };
    }

    case "boolean": {
      if (from.type === "boolean") {
        return { ok: true, value: raw === 1 || raw === "1" ? 1 : 0 };
      }
      if (from.type === "number") {
        if (raw === 0 || raw === 1) {
          return { ok: true, value: Number(raw) };
        }
        return { ok: false, reason: "boolean に変換できるのは 0 / 1 だけです" };
      }
      // ADR-0010 §5b 注意3: "1"/"0"/"yes"/"はい" は受けない。2段変換と1段変換で
      // 結果が変わりうるため、狭く始める(憲法2)。広げるなら ADR を改訂すること。
      const text = String(raw);
      if (text === "true") {
        return { ok: true, value: 1 };
      }
      if (text === "false") {
        return { ok: true, value: 0 };
      }
      return { ok: false, reason: 'boolean に変換できるのは "true" / "false" だけです' };
    }

    case "date": {
      const text = String(raw);
      if (!isIso8601(text)) {
        return { ok: false, reason: "ISO8601 の日付として解釈できません" };
      }
      return { ok: true, value: text };
    }

    case "select": {
      const text = asText(raw, from);
      if (!to.options.includes(text)) {
        return {
          ok: false,
          reason: `選択肢(${to.options.map((o) => `"${o}"`).join(" / ")})に含まれていません`,
        };
      }
      return { ok: true, value: text };
    }

    case "reference": {
      const text = asText(raw, from);
      if (existingIds === undefined || !existingIds.has(text)) {
        return {
          ok: false,
          reason: `参照先テーブル "${to.reference_table}" に存在しないレコードIDです`,
        };
      }
      return { ok: true, value: text };
    }

    case "image":
    case "file": {
      // ここに到達するのは image → image / file → file(対角。同型なので `possible`)だけ
      // である。他型 → image / file は MATRIX で `impossible` なので、この関数の冒頭で
      // 早期に弾かれる(V2-M2 / ADR-0035 §3 限定2 / V5-M16 / ADR-0161 限定3)。
      // **image ⇄ file も `impossible` である**(MATRIX の file 行のコメント)。
      // 同型は file_id 文字列をそのまま運ぶ(TEXT のまま)。
      return { ok: true, value: asText(raw, from) };
    }
  }
}

/** テーブルが実在するか(同じ差分の中で作られる予定のテーブルは、まだ無い)。 */
function tableExists(db: Database, tableId: ResourceId): boolean {
  const row = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM "sqlite_master" WHERE "type" = 'table' AND "name" = ?`,
    )
    .get(tableId);
  return (row?.n ?? 0) > 0;
}

/** 参照先テーブルに実在する `_id` の集合を読む。テーブルが無ければ空集合。 */
function readExistingIds(db: Database, tableId: ResourceId): Set<string> {
  if (!tableExists(db, tableId)) {
    return new Set();
  }
  const rows = db
    .query<{ id: string }, []>(
      `SELECT ${quoteIdentifier(SYSTEM_COLUMNS.id)} AS "id" FROM ${quoteIdentifier(tableId)}`,
    )
    .all();
  return new Set(rows.map((row) => row.id));
}

/**
 * 変換可否を**全行走査で**判定する(ADR-0010 §6b)。
 *
 * **この関数はスナップショット取得より前に呼ばれる。** そのために DB を読むだけで
 * 1バイトも書かない。これにより `destructive-rejection.test.ts` の不変条件4
 * (スナップショットディレクトリが1つも作られない)が、変換不能値による中止でも
 * そのまま成立する。
 *
 * **代償**: 対象列の全行走査が apply のたびに1回増える。大きなテーブルでは
 * 事前検証だけで時間がかかる(ADR-0010 §6b。V1-M1-T05 の測定対象)。
 */
export function checkFieldConversions(
  db: Database,
  conversions: readonly FieldConversion[],
): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const conversion of conversions) {
    const { table, field, from, to, path } = conversion;

    // 型そのものが「不」なら、行が0件でも拒否する。1行も無いことは
    // 「意味が一意に決まる」ことの理由にならない(ADR-0010 §5b 注意2)。
    if (conversionVerdict(from.type, to.type) === "impossible") {
      errors.push({
        path,
        message:
          `フィールド "${table}.${field}" の型を "${from.type}" から "${to.type}" へ変換することはできません。` +
          `この組み合わせは、書かれていない約束(例: 数値を日時とみなす)を持ち込まないと意味が決まらないため、語彙として認めていません。`,
        hint:
          `いったん "text" に変換してから目的の型へ変換するか、` +
          `別IDの新しいフィールドを add_field で追加して、値を移してください。`,
      });
      continue;
    }

    // 同じ差分の中で作られる予定のテーブルは、まだ物理的に存在しない。
    // 行が1つも無いので走査する対象が無い(変換不能値も原理的に存在しない)。
    if (!tableExists(db, table)) {
      continue;
    }

    const existingIds =
      to.type === "reference" ? readExistingIds(db, to.reference_table) : undefined;

    // 同じ差分の中で追加されたばかりの列は、まだ物理的に存在しない。
    // その列の値は全行 `null` なので、`null` を並べたものとして走査する。
    const rows = conversion.source_missing
      ? db
          .query<{ id: string }, []>(
            `SELECT ${quoteIdentifier(SYSTEM_COLUMNS.id)} AS "id" FROM ${quoteIdentifier(table)} ` +
              `ORDER BY ${quoteIdentifier(SYSTEM_COLUMNS.id)}`,
          )
          .all()
          .map((row) => ({ id: row.id, value: null as string | number | null }))
      : db
          .query<{ id: string; value: string | number | null }, []>(
            `SELECT ${quoteIdentifier(SYSTEM_COLUMNS.id)} AS "id", ${quoteIdentifier(field)} AS "value" ` +
              `FROM ${quoteIdentifier(table)} ORDER BY ${quoteIdentifier(SYSTEM_COLUMNS.id)}`,
          )
          .all();

    const failures: { id: string; value: unknown; reason: string }[] = [];
    for (const row of rows) {
      const result = convertValue(row.value, from, to, existingIds);
      if (!result.ok) {
        failures.push({ id: row.id, value: row.value, reason: result.reason });
      }
    }

    if (failures.length === 0) {
      continue;
    }

    const shown = failures.slice(0, UNCONVERTIBLE_SAMPLE_LIMIT);
    const samples = shown
      .map((f) => `_id "${f.id}" の値 ${JSON.stringify(f.value)}(${f.reason})`)
      .join(" / ");
    const omitted = failures.length - shown.length;
    const tail = omitted > 0 ? ` ほか ${omitted} 件` : "";

    errors.push({
      path,
      message:
        `フィールド "${table}.${field}" の変更によって、既存の ${failures.length} 件のレコードが変換できなくなります: ` +
        `${samples}${tail}。` +
        `カーネルは変換できない値を勝手に null や既定値へ書き換えません(何が失われたかを後から知る手段が無いため)。`,
      hint:
        `先に update_record / delete_record で該当レコードの値を直してから、改めて同じ差分を送ってください。` +
        `どの行が該当するかは上の _id で分かります。`,
    });
  }

  return errors;
}
