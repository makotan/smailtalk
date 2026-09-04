/**
 * reference 型の「代表値」の**唯一の実装**。
 *
 * 参照は list_view のセル(`fields/display.tsx`)と form のピッカー
 * (`fields/input.tsx`)の両方に現れる。以前はこの2箇所が代表値の決め方を別々に
 * 持っていて、text フィールドを持たないテーブルを参照すると同じレコードが一覧では
 * 「見つかりません」、ピッカーでは別の値として見えていた。**同じレコードが2つの顔を
 * 持たない**ことを1ファイルで担保するため、両者はここから import する。
 *
 * **【V4-M10-T24 / `E-G35`(再提出) / `ADR-0080` による訂正】** **上の「v0 語彙に
 * 『表示用フィールド』を指定する語は無く」は、今日から偽である。** **`$defs/table` に
 * `representative_field`(自テーブルの `text` 型フィールドID 1本)が入った**
 * (門A の本審査 = 限定採用。`docs/adr/0080-table-representative-field.md`)。
 * **旧文を消していないのは、「マニフェストに現れない表示オプションを増やさない」という
 * 後半が今日も真だからである** —— 増えたのは**マニフェストに現れる宣言**であって、
 * 表示オプションではない。**代表値は今日もマニフェストにある情報だけから導く。**
 */
import type { RecordRow } from "../../../src/kernel/records.ts";
import type { Field, ResourceId, Table } from "../../../src/kernel/types.ts";

/**
 * 参照先テーブルID → (レコードID → 表示ラベル) の索引。
 *
 * **索引に載っている = 参照先レコードが実在する**。参照先を1件ずつ引くと行数だけ
 * リクエストが増えるので、参照先テーブルをまとめて1回だけ取得して索引にする。
 */
export type ReferenceLabelIndex = ReadonlyMap<ResourceId, ReadonlyMap<string, string>>;

/**
 * 参照先レコードの「代表値」に使うフィールドを決める。
 *
 * **ルール(`V4-M10-T24` / `ADR-0080` で1段増えた。2段になった)**:
 *
 * 1. **参照先テーブルが `representative_field` を宣言していて、それが自テーブルに実在する
 *    `text` 型フィールドを指しているなら、それ。**
 * 2. **宣言が無い / 実在しない / `text` でないなら、今日どおり最初の `text` フィールド。**
 *
 * **旧ルール(「最初の `text` フィールド。それだけ。」)は 2 として今日も生きている** ——
 * **`ADR-0080` 限定5 の逐語「既定は『変えない』。キーを書いていないテーブルの参照表示を
 * 1ミリも変えない」による。**
 *
 * **【正直に書く】1 が外れたときに黙って 2 へ倒れる**(fail-safe)。**差分は拒否されない** ——
 * 適用時に「指したフィールドが実在し `text` 型か」を検査するには
 * `src/kernel/referential-integrity.ts` に差分が要り、**`ADR-0080` 限定6(`src/kernel/` に
 * 1バイトも差分を出さない)と正面から衝突する。** **実測は
 * `web/test/table-representative-field.test.ts` の `(穴)` 検査が固定している。**
 *
 * 非 text へのフォールバックは作らない。7型のうち人間が読む短い名前が入りうるのは
 * `text` だけである(`long_text` は本文、`select` は選択肢、`number` / `boolean` /
 * `date` は名前になりえず、`reference` は再び ID)。「それらしい何か」を代表値に
 * 仕立てるより、`_id` を出すほうが正直である(憲法6)。
 *
 * 同じ型が複数ある場合、フィールドの並び順はマニフェストの著者が書いた順序であり、
 * 先頭ほどそのテーブルを代表するという以外の手掛かりは無いので、最初のものを採る。
 *
 * **`Table` 型はカーネルにある**(`ADR-0080` 限定6 が `src/kernel/` の0行差分を求めている)
 * ので、宣言は型の外側から `unknown` として読む。**これは限定6 の帰結であって手抜きではない**
 * (`ADR-0070` 限定5 / `src/server/owner-scope.ts` の `viewAudience` と同じ作法)。
 */
export function representativeField(table: Table | undefined): Field | undefined {
  const declared = (table as { representative_field?: unknown } | undefined)?.representative_field;
  if (typeof declared === "string") {
    const named = table?.fields.find((field) => field.id === declared && field.type === "text");
    if (named !== undefined) {
      return named;
    }
  }
  return table?.fields.find((field) => field.type === "text");
}

/**
 * 参照候補を探すとき、打った文字を照合する項目を決める(`K-G9`。`V6-M3-T04` /
 * `ADR-0290` 限定7)。
 *
 * **優先順位は「項目 > テーブル > 代表の1本」の1本だけである。** **画面は入らない**
 * (`D-V6-20`。`$defs/view` に置き場を作っていない)。
 *
 * 1. **項目**: 参照する項目が `reference_search_fields` を書いていれば、それ。
 * 2. **テーブル**: 書いていなければ、参照先テーブルの `reference_search_fields`。
 * 3. **代表の1本**: どちらも書いていなければ、{@link representativeField} が解決した1本。
 *
 * **3 は `representativeField` を呼ぶだけである** —— **新しい解決規則を1バイトも
 * 作っていない**(`ADR-0290` 限定7)。**「最初の `text` フィールド」という規則の写しを
 * ここに置いていない。** **`web/test/reference-search-fields.test.tsx` がソースを走査して
 * 機械で固定している。**
 *
 * **1 / 2 の側は、宣言されたIDのうち参照先テーブルに実在するものだけを返す。**
 * **実在しないIDは `src/kernel/referential-integrity.ts` が差分の時点で拒否している**
 * ので、ここに届くのは実在するものだけのはずである —— **ただし「届かないはず」に
 * 安全性を預けない**(`useReferenceChoices` が同じ理由で解決を握り潰さない作法と同じ)。
 *
 * **【`V8-M20` / `J-G28`】旧文の `audience` は撤去された。今日この穴は「面が名指しした
 * 代表項目」について同じ形で残っている** —— **塞いでいない。**
 * **代表項目に `audience` が付いていると、3 の側は今日それをそのまま返す** ——
 * **1 / 2 の側は差分の時点で拒否されるのに、3 の側には検査が1件も無い**
 * (`representative_field` は `ADR-0080` 限定6 の下で適用時検査を持たない)。
 * **その相手(ロールが列挙に含まれない閲覧者)には値が届かないので1件も当てられない。**
 * **【禁止の履行】これを「`audience` の穴を塞いだ」と書かない。塞いでいない。**
 * **実測は `web/test/reference-search-fields.test.tsx` の (c) 群である。**
 *
 * **【正直に書く】この関数の返り値を使って候補を絞る実装は、今日1バイトも無い**
 * (当たり先は `V6-M4`)。**今日この宣言を書いても、画面の候補は今日どおり全件が
 * プルダウンに出る = 「書けるが今日は効かない」。**
 *
 * **`Table` / `Field` の型はカーネルにある**(本キーはカーネルが検査するので型に現れる)。
 */
export function referenceSearchFields(
  table: Table | undefined,
  field?: Pick<Extract<Field, { type: "reference" }>, "reference_search_fields">,
): Field[] {
  if (table === undefined) {
    return [];
  }
  const declared = field?.reference_search_fields ?? table.reference_search_fields;
  if (declared !== undefined) {
    return declared
      .map((id) => table.fields.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is Field => candidate !== undefined);
  }
  const representative = representativeField(table);
  return representative === undefined ? [] : [representative];
}

/**
 * 参照候補を別の面で探すとき、その一覧に並べる列(`K-G10`。`V6-M3-T05`)。
 *
 * **既存の宣言から導くだけである** —— **そのための新しいキーを1本も足していない。**
 * **`$defs/table` にも `$defs/field` にも `$defs/view` にも「列」のキーは無い**
 * (機械的な固定は `web/test/reference-search-fields.test.tsx` の (d) 群)。
 *
 * **並ぶのは「探せる項目」そのものである** —— **`V6-M0` §7-4 の `S3` (2) が
 * 「1〜8本の宣言をそのまま列にすると、8列のポップアップになりうる」と申告した形を
 * そのまま採った。** **決め方を2箇所に住まわせない**(この関数は
 * {@link referenceSearchFields} を呼ぶだけで、解決を1バイトも再実装しない)。
 *
 * **【正直に書く。`V6-M0` §7-4 の `S3` (1) の実物】** **作る人は「探せる列」と
 * 「見える列」を別々に決められない。** **探せる項目に代表の項目を入れなかった宣言では、
 * 一覧に名前の列が並ばない。** **これは宣言から導くことの代償であり、隠さない。**
 *
 * **【正直に書く】この関数を呼ぶ描画経路は今日1つも無い** —— **候補を別の面で探す器
 * そのものが今日1つも無い**(当たり先は `V6-M5`)。**測っているのは返り値だけであり、
 * 画面で確かめた実測は1件も無い。**
 */
export function referencePopupColumns(
  table: Table | undefined,
  field?: Pick<Extract<Field, { type: "reference" }>, "reference_search_fields">,
): Field[] {
  return referenceSearchFields(table, field);
}

/**
 * **見つかっている**参照先レコード1件の表示ラベル。
 *
 * 代表値フィールドが無い、または値が空のときは `_id` を返す。ID は「見つかっている
 * レコードを指す唯一の手掛かり」であり、ここで「見つかりません」と出すのは事実に反する。
 */
export function referenceLabel(table: Table, row: RecordRow): string {
  const labelField = representativeField(table);
  if (labelField === undefined) {
    return row._id;
  }
  const value = row[labelField.id];
  if (value === null || value === undefined || value === "") {
    return row._id;
  }
  return String(value);
}

/**
 * 参照先テーブルとそのレコードから表示ラベルの索引を作る。
 *
 * 代表値が引けないレコードも `_id` を値として**必ず載せる**。載せないと参照切れ
 * (レコードが無い)と区別がつかなくなる。
 */
export function buildReferenceLabelIndex(
  sources: { table: Table; records: RecordRow[] }[],
): ReferenceLabelIndex {
  const index = new Map<ResourceId, ReadonlyMap<string, string>>();
  for (const source of sources) {
    const labels = new Map<string, string>();
    for (const record of source.records) {
      labels.set(record._id, referenceLabel(source.table, record));
    }
    index.set(source.table.id, labels);
  }
  return index;
}

/** 参照切れ(参照先レコードが存在しない)の表示。手掛かりとして ID 自体は残す。 */
export function missingReferenceLabel(id: string): string {
  return `(見つかりません: ${id})`;
}

/**
 * 参照値1件の表示の解決結果。
 *
 * `found: false` は参照切れだけを意味する。「見つかったが代表値が引けない」は
 * `found: true` + `text` が `_id` になる(3区分のうち 1 と 3 を混同しないため)。
 */
export type ResolvedReference = { found: boolean; text: string };

/** 索引から参照値1件を解決する。 */
export function resolveReference(
  index: ReferenceLabelIndex,
  tableId: ResourceId,
  id: string,
): ResolvedReference {
  const label = index.get(tableId)?.get(id);
  if (label === undefined) {
    return { found: false, text: missingReferenceLabel(id) };
  }
  return { found: true, text: label };
}
