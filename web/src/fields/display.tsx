/**
 * フィールド値の表示形式(V0-P3-T04)。
 *
 * v0 語彙のフィールド型7種すべての「読み取り側の見せ方」をこの1ファイルに集約する。
 * ここに集めるのは、同じ型が list_view でも detail_view でも同じ形に見えることを
 * 型検査で担保するため(`switch` を網羅にしてあるので、型が増えたらここが
 * コンパイルエラーになる = 語彙を勝手に広げられない / 憲法2)。
 *
 * **受け取る表示オプションは1つだけである**(`preset_text_preview` の3値 enum)。
 * それ以外の書式指定はマニフェストの語彙に存在しない。
 *
 * **【V4-M16-T10 / `ADR-0090` で書き直した。旧文は今日から偽である】**
 * 旧文は「それ以外の書式指定はマニフェストの語彙に存在せず、**値ごとの見た目の指定も
 * 存在しない**(handover 3.10)。したがって各型の見せ方は、その1つの軸を除けば
 * 「その型ならこう」の1通りしかない。」だった。
 * **`select` 型については偽になった** —— `$defs/field` の `emphasis`(値ごとの強調)が
 * 門A を通って入り、**値によって描画が実際に変わる。**
 * **【禁止】これを「値ごとに見た目を指定できるようになった」と書かない。** 書けるのは
 * **意味の名前の有限 enum 4値だけ**であり、**色の実値も CSS 文字列も1バイトも受け取らない**
 * (`ADR-0090` 限定3 / 限定5)。**`select` 以外の7型については旧文は今日も真である。**
 *
 * **【V3-M2-T05 / ADR-0052 で再改訂。旧文言が2つの意味で偽になった】**
 * 旧文言は「**表示オプションは受け取らない。** 列幅・書式指定などはマニフェストの語彙に
 * 存在せず、**フィールド単位・値単位の見た目の指定も存在しない**」だった。
 *
 * - **「表示オプションは受け取らない」は偽になった。** `V3-M2-T04` が `FieldValue` /
 *   `FieldCell` に `textPreview` を1つ足した(**ADR-0050 限定10 が明示的に許した唯一の例外**)。
 *   **限定は残っている** —— 受け取れるのは3値の enum 1つだけで、**色・長さ・書体の実値は
 *   1つも受け取らない。**
 * - **「列幅はマニフェストの語彙に存在しない」も偽になった**(`preset_column_width`)。
 *   **ただし列幅はここへは来ない** —— 当たるのは器(`<col>` / `<td>` の `data-preset-…`)であって
 *   表示関数ではない。**「フィールド単位の指定」も、列ごとの寄せ・幅という形で実在する。**
 * - **【V4-M16-T10 / `ADR-0090` で偽になった】** 旧文は「**偽になっていないもの**:
 *   **値ごとの見た目の指定は今日も1つも無い**(条件付き書式)。テーマは**アプリ単位**であり、
 *   フィールドや値ごとに色を塗り分ける語彙も1つも無い(`$defs/field` にも `$defs/view` にも
 *   色のキーは無い)」だった。**前半(値ごとの見た目の指定が1つも無い)は今日から偽である**
 *   —— `$defs/field` の `emphasis` が `select` の値ごとの強調を実際に運ぶ。
 *   **後半(色のキーは無い)は今日も真である** —— **足したのは意味の名前であって、
 *   テーマのキーでも色の実値でもない**(`ADR-0090` §Context 5 の 3)。
 *   テーマの適用は今日どおりスコープ要素(`.app-theme`)への CSS カスタムプロパティ注入
 *   だけで行う —— **色を props で受けると、型ごと・値ごとの塗り分けの実装経路が開いて
 *   しまう**(ADR-0049 (iv) の理由は今日も生きている。**`emphasis` は色を1バイトも
 *   受け取らないので、この経路を1ミリも開いていない**)。
 * - **依然として無いもの**: 任意の CSS・ピクセル座標・グラフ描画・ダークモード。
 *   **条件付き書式(値によって色を変える)は、`select` の値の等値に限って、しかも
 *   意味の名前4値に限って実在する** —— **数値の閾値も日付の範囲も条件式も1つも無い**
 *   (`ADR-0090` §Decision 4 の 2 が門を立てている)。**選べる見せ方は7軸20値と、
 *   この意味の名前4値の中だけである。**
 *
 * **【V3-M5-T05 / ADR-0055 で改訂】「依然として無いもの」の1つ目(任意の CSS)は、
 * **表示関数については今日も真だが、画面全体については偽になった。** V3-M5 で逃げ道が入り、
 * **owner が発行した CSS が画面に当たる**(ピクセル座標もダークモードのメディアクエリも、
 * owner が書けば効く)。**それでもここへは1バイトも来ない** —— 逃げ道の本体は
 * `web/src/views/ViewHost.tsx` が `.app-theme` の内側に `<style>` として当てるものであり、
 * **表示関数の引数は今日も5つ・表示オプションは軸7 の1つだけである**(ADR-0055 限定12)。
 * **「無い」と書き続けてよいのはこのファイルの射程の中だけである。**
 *
 * **【V3-M3-T02 の追記】`FieldValue` / `FieldCell` の引数は1つも増えていない。**
 * 参照セルのリンク化は**器を呼び出し側が組む**形で入れた —— 引数を足すと
 * **ADR-0050 限定10(表示関数に足せる引数は軸7 の1つだけ)を破る**ためである。
 * 本ファイルが足したのは判定用の純関数 `referenceLinkTarget` 1本だけで、
 * **表示関数の受け取るものは今日も5つ・表示オプションは軸7 の1つだけである。**
 */
import type { RecordValue } from "../../../src/kernel/records.ts";
import type { DetailView, Field, ListView, Manifest } from "../../../src/kernel/types.ts";
import { fileDeliveryUrl } from "../api.ts";
// 遷移先の決め方(同テーブル先頭 detail_view 規約)は `navigation.tsx` が唯一の実装。
// ここに再実装しないこと(同ファイルの `resolveDetailViewTarget` の注記が名指しで禁じている)。
import { resolveDetailViewTarget } from "../navigation.tsx";
import { Badge } from "../ui/surfaces.tsx";
import { TableCell } from "../ui/table.tsx";
// 代表値の決め方は list と form で共有する唯一の実装。ここに再実装しないこと。
import { type ReferenceLabelIndex, resolveReference } from "./reference-label.ts";

/**
 * 切り詰め長のプリセット(ADR-0050 の軸7)。**ビュー定義の値そのもの**であり、
 * ここで型を作り直さない(`list_view` と `detail_view` で同じ3値 enum である)。
 */
type TextPreview = ListView["preset_text_preview"];

/**
 * long_text を切り詰める長さの既定。**プリセットを書かなかった画面はこの値のままである。**
 * 表示オプションではなく、型ごとの固定の作法として始まった定数であり、その性格は
 * 「書かなければ今日と1文字も変わらない」という形で残っている(ADR-0051 限定4)。
 */
const LONG_TEXT_PREVIEW_LENGTH = 40;

/**
 * 軸7(`preset_text_preview`)の段階値 → 切り詰める文字数(ADR-0050 限定1 / 限定10)。
 *
 * **書き手は文字数を書けない。**書けるのは3値の enum だけで、対応する文字数はこの表に
 * しか無い —— マニフェストに実値(文字数・px)が1つも入らないようにするためである。
 *
 * **段階値の比は 1 : 2 : 4** で、軸2(列の幅 = 6rem / 12rem / 24rem)と同じ規則を採った。
 * **`standard` は既定(40)と同じ値に固定する** —— 未指定と `standard` で見え方が変わると、
 * enum の名前(標準)と食い違い、「既定を明示的に宣言する」という書き方ができなくなる。
 * **この段階値が読みやすさの上で妥当かは実地で検証していない**(ADR-0050 の限界7 と同じ)。
 */
const LONG_TEXT_PREVIEW_LENGTHS: Record<NonNullable<TextPreview>, number> = {
  short: LONG_TEXT_PREVIEW_LENGTH / 2,
  standard: LONG_TEXT_PREVIEW_LENGTH,
  long: LONG_TEXT_PREVIEW_LENGTH * 2,
  /**
   * **`E-G13` / `V4-M10-T36` / `ADR-0085` 限定1 が足した4値目(`full` = 切らない)。**
   *
   * **これが `ADR-0085` §Decision 2-2 が名指しした「当たり先」である** —— **この写像に
   * 1エントリ増えることが実装のすべてであり、CSS 規則は1つも足していない**(既存3値の
   * 当たり先も CSS 規則ではない。スキーマ自身がそう書いている)。
   *
   * **`Number.POSITIVE_INFINITY` を使うのは、下の `text.length > limit` の比較を
   * 1バイトも書き換えないためである** —— **分岐を1本も増やさない。** マニフェストに
   * 実値(文字数)が入らないことは、この表がここにしか無いことで今日も守られている。
   *
   * **段階値の比(1 : 2 : 4)を壊してはいない** —— `full` は比の外側にある「切らない」で
   * あって、5番目の倍数ではない。**5値目を足す提案は改めて門A を通すこと**
   * (`ADR-0085` §Decision 5)。
   */
  full: Number.POSITIVE_INFINITY,
};

/**
 * 桁区切りを入れ始める整数部の桁数。
 *
 * **4桁以下は区切らない。** 西暦(2026)・評価(1〜5)・連番・件数・順位といった
 * 通貨でない number の表示を変えないため(V1-M0-T08 完了条件5・6)。
 *
 * ## 【`V4-M10-T46` / `E-G14` / `ADR-0086` 限定12 で直した Δ5】
 *
 * **旧文は次の5行だった**(2026-08-03 まで真だった。**消さずに理由を書く**):
 *
 * > マニフェストには「この number は通貨である」と書く手段が無く(ADR-0007 §7a で
 * > `currency` 型も `format` プロパティも却下された)、通貨と非通貨を区別できない。
 * > したがって桁区切りは全 number に一律で効く。**単位(円 / $ 等)は表示しない** ——
 * > 単位を出すにはマニフェスト外の知識(フィールド名の推測)が要り、ADR-0007 の
 * > Δ4(自己完結性の喪失)に当たるため。F-9 の「単位表示」は満たしていない。
 *
 * **偽になったのは後半だけである** —— **`$defs/field.unit` という置き場ができたので、
 * 単位は表示する。** **推測は1つもしない**(マニフェストに書いてあるものだけを出す)ので
 * **Δ4 は踏まない。** **`F-9` の「単位表示」の側は今日から満たしている。**
 *
 * **前半は今日も真である** —— **`currency` 型も `format` プロパティも今日も無い**
 * (`FIELD_TYPES` は8のまま。`ADR-0086` 限定2)。**したがって桁区切りは今日も全 number に
 * 一律で効き、この定数は1バイトも動いていない**(`ADR-0086` 限定6)。
 *
 * **【誇張しない】** **単位が付いても書式の食い違いは消えない** —— **`4256 点` と
 * `24,724 円` は同じ画面に違う書式で並ぶ**(`ADR-0086` §Context 4 の6 が自ら挙げた
 * 不利な材料であり、`web/test/field-value-unit.test.tsx` が実測で固定している)。
 * **【禁止】「金額が正しく表示されるようになった」と総括しないこと。**
 */
const GROUPING_MIN_INTEGER_DIGITS = 5;

/** 3桁ごとの区切りに使う文字。 */
const GROUPING_SEPARATOR = ",";

/** 桁区切り。ロケールに依存させないため Intl を使わず、文字列として組み立てる。 */
/**
 * ## **【`V8-M12-T03` で `export` を1本足した。上の1行も関数の中身も1バイトも変えていない】**
 *
 * **集計表(`web/src/views/ReportViewRenderer.tsx`)が同じ書式を使うためである** ——
 * **2本目の書式関数を書き起こすと、一覧と集計表で同じ列が違う書式で出る**
 * (`v8-m12.md` §1-0c の決定9 / §1-0e の決定19)。
 * **`FieldValue` を集計表から呼ぶ形は採らなかった** —— **`Field` オブジェクトと9型の分岐と
 * 参照のリンク解決を連れてくるので、集計値には過剰である。**
 *
 * - **単位はこの関数の責任ではない**(下の `FieldValue` の `number` 分岐が外側で添えている)。
 *   **集計表も同じ形で、呼ぶ側が `field.unit` を添える**(`v8-m12.md` §1-0f 枝番 戊4)。
 * - **桁区切りの閾値は整数5桁のままである**(`GROUPING_MIN_INTEGER_DIGITS`)——
 *   **`export` を足したことで動いた定数は1つも無い。**
 */
export function formatNumber(value: RecordValue): string {
  const text = String(value);
  // 符号・整数部・小数部に分解できないもの(指数表記、数値でない文字列)はそのまま出す。
  // 表示のために値を作り替えない —— 読み手が入力した値と見比べられなくなる(憲法6)。
  const match = /^(-?)(\d+)(\.\d+)?$/.exec(text);
  if (match === null) {
    return text;
  }
  const [, sign = "", integer = "", fraction = ""] = match;
  if (integer.length < GROUPING_MIN_INTEGER_DIGITS) {
    return text;
  }
  // 小数部は**丸めずにそのまま**戻す。`Intl.NumberFormat` は既定で小数3桁に丸めるため使わない。
  const grouped = integer.replace(/\B(?=(\d{3})+$)/g, GROUPING_SEPARATOR);
  return `${sign}${grouped}${fraction}`;
}

/**
 * 未設定(null)の表示。7型で共通に「未設定」と書く。空欄にすると値が無いのか取得漏れなのか区別がつかない(憲法6)。
 *
 * ## **【`V4-M19-T08` / `ADR-0119` 限定10 で射程が縮んだ。旧文を1バイトも消していない】**
 *
 * **上の1文は、今日から「宣言しなかった項目について」だけ成り立つ。**
 * **門A の本審査(`V4-M19` 単位E-a。判定 = 限定採用)が `$defs/field` に
 * `hide_when_empty` を通し、`web/src/views/DetailViewRenderer.tsx` の `visibleFields` が
 * 宣言した項目の行を丸ごと描かなくなった。**
 *
 * - **覆るのは、アプリが `hide_when_empty: true` と宣言した項目についてだけである。**
 *   **宣言しなかった項目では、この関数が今日どおり「未設定」を描く** —— **憲法6 の
 *   根拠は1バイトも失われない**(`ADR-0119` §Context 7 の分岐規則)。
 * - **この関数そのものは1バイトも変わっていない。** **落とす判定は詳細画面の側にあり、
 *   ここまで到達しないだけである。** **「ラベルだけ残して値を空欄にする」形は作っていない**
 *   (`ADR-0119` 限定5)—— それはこの逐語が禁じた形そのものである。
 * - **覆るのは詳細画面の項目の行だけである**(限定4)—— **一覧の列でも入力フォームでも
 *   `related` の子一覧でも、この関数は今日どおり「未設定」を描く。**
 * - **空文字 `""` の扱いを1バイトも変えていない**(限定3)—— **下の `FieldValue` の
 *   「boolean の false と number の 0 は『値がある』。null / undefined だけが未設定。」は
 *   今日も真である。**
 *
 * > **【正直に書く】宣言した項目については、「値が無いのか取得漏れなのか」の区別が
 * > 画面から失われる。** **アプリが「この項目は消してよい」と主張し、カーネルも表示層も
 * > その主張を1度も検証しない**(`ADR-0119` §Decision 5 の 6)。
 */
function EmptyValue({ type }: { type: Field["type"] }) {
  return (
    <span className="field-empty" data-testid={`field-value-${type}`}>
      未設定
    </span>
  );
}

/**
 * ISO8601 の日付文字列を日付として読める形にする。
 *
 * カーネルは `date` を `YYYY-MM-DD` または `YYYY-MM-DDThh:mm:ssZ` で受け付ける
 * (records.ts の TYPE_EXPECTATION)。
 * ロケール依存の書式にはしない —— 表示ロケールという設定を持ち込まないためと、
 * 入力した文字列と見比べられる形のままにするため。
 *
 * ## 【E-G44 / V4-M6】**保持している日時を表示で落とさない**
 *
 * **着手前はここが `/^(\d{4}-\d{2}-\d{2})/` で切っており、時刻を持つ値でも日付しか
 * 出なかった。** その結果、決済結果の受信日時も自動処理の実行時刻も同日内の順序が画面から
 * 読めず(実測: 受信日時10件中5件が `2026-08-02` としか出ない / 実行履歴は先頭50行すべてが
 * `2026-08-02`)、突き合わせにも障害調査にも使えなかった(02 §5-6 `E-G44`)。
 *
 * **直したのは表示だけである。** 値は着手前から時刻を持っており(`date` 型は日時を保持
 * できる)、**カーネルにもスキーマにも1バイトも触っていない。** **表示の選択肢((C) 側の
 * 語彙追加)には倒していない** —— **どちらの形にするかは 04 §3-7 #5 が「未決」と書いた
 * 論点であり、(B) の表示側で直したのは計画側の判断である**(ユーザ決定でも審査の判定でも
 * ない。記録は `docs/plan/v4/records/v4-m6.md` §2-1)。
 *
 * **変換は区切り記号の1文字だけである** —— `T` を空白にする。**時刻・ミリ秒・時差の表記
 * (`Z` / `+09:00`)は1文字も落とさない**(落とすと「入力した文字列と見比べられる形」で
 * なくなる)。**時差を現地時刻へ読み替えることもしない** —— それは表示ロケールという設定を
 * 持ち込むことであり、このファイルの既定の方針(上の段落)に反する。
 *
 * **日付として読めない値はそのまま返す**(着手前は先頭の日付らしき部分だけを切り出して
 * いたが、**表示のために値を作り替えない**方に倒した。カーネルが書込時に形式を検証するので、
 * ここへ来る値は `YYYY-MM-DD` か `YYYY-MM-DDThh:mm:ss…` のいずれかである)。
 */
function formatDate(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})(?:T(.+))?$/.exec(value);
  if (match === null) {
    return value;
  }
  const [, date = "", time] = match;
  return time === undefined ? date : `${date} ${time}`;
}

/**
 * 参照セルが**リンクになる**条件の唯一の実装(V3-M3-T02)。
 *
 * 返り値が `undefined` ならリンクにしない。3つの連言である:
 *
 * 1. **`manifest` が渡されている。** 渡さない呼び出し元の DOM は1バイトも変わらない。
 * 2. **値があり、参照先レコードが実在する**(`resolveReference` の `found === true`)。
 *    **「参照切れ」と「代表値が引けない」を混同しない** —— 後者は `found === true` で
 *    表示が `_id` になるだけであり、**レコードは実在するのでリンクにする。**
 *    参照切れをリンクにすると、押した先が必ず 404 になる導線を作ることになる。
 * 3. **参照先テーブルに `detail_view` がある**(`resolveDetailViewTarget`)。無ければ
 *    開ける先が無いので、一覧の行と同じく「クリックできないまま」にする。
 *
 * 遷移先の決め方(定義順の先頭)は `navigation.tsx` の規約そのものであり、ここには書かない。
 *
 * **リンクの器(`<a>`)はここでは組まない。** `FieldValue` / `FieldCell` に引数を足すと
 * **ADR-0050 限定10** を破るので、器は呼び出し側(`DetailViewRenderer`)が組み、
 * 本関数は「リンクにしてよいか」と「どこへ」だけを返す。
 */
export function referenceLinkTarget(
  manifest: Manifest | undefined,
  field: Field,
  value: RecordValue | undefined,
  referenceLabels: ReferenceLabelIndex,
): DetailView | undefined {
  if (manifest === undefined || field.type !== "reference") {
    return undefined;
  }
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!resolveReference(referenceLabels, field.reference_table, String(value)).found) {
    return undefined;
  }
  /*
   * **【`V10-M18-T01` / `FU-G1a` / `ADR-0362` §Decision 1 の遷移点3】一続きの流れの段に
   * なっている `detail_view` を候補から外す。** **この関数の引数は1本も増えていない**
   * (`ADR-0050` 限定10 に1バイトも触っていない)—— **除外はここで決まっており、
   * 呼び出し側は今日と同じ4引数で呼ぶ。** **外した結果0個なら今日どおり `undefined` を
   * 返し、セルはリンクにならない**(別の画面へ倒さない。`ADR-0362` §Decision 3)。
   */
  return resolveDetailViewTarget(manifest, field.reference_table, { skipFlowStepViews: true });
}

/**
 * 1つのフィールド値の表示。
 *
 * `switch` は9型を網羅する(`default` を置かない)。フィールド型が増えたら
 * ここがコンパイルエラーになる。
 */
export function FieldValue({
  field,
  value,
  referenceLabels,
  appId,
  textPreview,
}: {
  field: Field;
  value: RecordValue | undefined;
  referenceLabels: ReferenceLabelIndex;
  /** 所属アプリのID。**image / file 型でだけ使う**(配信 URL `/api/apps/<appId>/files/<file_id>`)。 */
  appId: string;
  /**
   * `long_text` の切り詰め長のプリセット(ADR-0050 の軸7。**long_text 型でだけ使う**)。
   *
   * **これが表示関数の受け取る唯一の表示オプションであり、ADR-0050 限定10 が許した唯一の
   * 例外である**(冒頭の「表示オプションは受け取らない」の宣言はここで破れた。**宣言は
   * `V3-M2-T05` が改訂済みで、旧文言と理由は ADR-0052 が持つ**)。**受け取るのは4値の enum だけで、色・長さ・書体の実値は
   * 1つも受け取らない** —— 実値を受けると、型ごと・値ごとの塗り分けの実装経路が開いてしまう
   * (ADR-0049 (iv) の理由がそのまま当たる)。
   *
   * **【V4-M10-T36 / `E-G13` / ADR-0085 限定1。旧文は「3値の enum」だった】**
   * **値域が 3 → 4 になった**(4値目 `full` = 切らない)。**`ADR-0050` 限定10 の趣旨
   * (表示関数が受け取れる表示オプションは軸7 の1つだけ)は無傷であり、破れたのは
   * 「3値」という字面だけである**(`ADR-0085` 限定4 が明記している)。
   *
   * 軸1〜6 と違って CSS では実装できない。`{text.slice(0, N)}` で**切り詰めた文字列しか
   * DOM に出さない**ので、CSS からは全文を復元できないためである(`line-clamp` /
   * `text-overflow` で代替すると「文字数」ではなく「行数 / 幅」になり、enum の意味が変わる)。
   *
   * `undefined`(未指定)は既定(`LONG_TEXT_PREVIEW_LENGTH`)。
   */
  textPreview?: TextPreview;
}) {
  // boolean の false と number の 0 は「値がある」。null / undefined だけが未設定。
  if (value === null || value === undefined) {
    return <EmptyValue type={field.type} />;
  }

  switch (field.type) {
    case "text":
      // 短い文字列。手を加える理由が無いのでそのまま出す。
      // **【V4-M16-T10 / `ADR-0090` で `select` と分けた】** **`text` の描画は1文字も
      // 変わっていない** —— 分けたのは `select` にだけ強調が当たるからである(限定4)。
      return <span data-testid="field-value-text">{String(value)}</span>;

    case "select": {
      // **`P-G28` + `P-G22` / `V4-M16-T10` / `ADR-0090` 限定6 / 限定8**:
      // **宣言された値だけを強調する。**
      //
      // **既定は「強調しない」(限定8)** —— `emphasis` を持たないフィールドと、
      // 対応表に載っていない値は **今日と1文字も変わらない DOM を返す**(下の素の
      // `<span>`)。**既定を反転させない。**
      //
      // **限定1 の帰結**: **表示関数の引数を1本も増やしていない** —— 強調は
      // `field`(既に引数である)の中に入って届く(`ADR-0050` 限定10 の趣旨は無傷)。
      //
      // **部品体系の `Badge` を使わない** —— `Badge` の変種を増やすと `ADR-0087` の
      // 射程に入る。**素の `<span>` + クラス名1つだけである**(当たり先の CSS は
      // `web/src/styles.css` の `.field-emphasis` と、意味の名前ごとの属性セレクタ4本)。
      //
      // **【正直に書く】どの値が注意かをプラットフォームは判定していない** ——
      // アプリが宣言した主張をそのまま属性に写しているだけである
      // (`ADR-0090` §Context 4 の 4)。
      const emphasis = field.emphasis?.[String(value)];
      if (emphasis === undefined) {
        return <span data-testid="field-value-select">{String(value)}</span>;
      }
      return (
        <span className="field-emphasis" data-emphasis={emphasis} data-testid="field-value-select">
          {String(value)}
        </span>
      );
    }

    case "long_text": {
      const text = String(value);
      // 未指定は既定のまま(`standard` を書いた場合と同じ値である)。書いてない画面が
      // 1文字も変わらないことは `web/test/field-display.test.tsx` が固定している。
      const limit =
        textPreview === undefined
          ? LONG_TEXT_PREVIEW_LENGTH
          : LONG_TEXT_PREVIEW_LENGTHS[textPreview];
      const truncated = text.length > limit;
      return (
        <span
          className="field-long-text"
          data-testid="field-value-long_text"
          // 一覧では行の高さを揃えたいので切り詰めるが、全文を捨てはしない。
          // **切り詰めが起きないときは title を出さない**(段階値を変えても同じ)。
          title={truncated ? text : undefined}
        >
          {truncated ? `${text.slice(0, limit)}…` : text}
        </span>
      );
    }

    case "number":
      // 大きい数だけ桁区切りを入れる(閾値の根拠は GROUPING_MIN_INTEGER_DIGITS の注記)。
      //
      // **`E-G14` / `V4-M10-T46` / `ADR-0086` 限定5**: **単位は値の後ろに置く1通りだけ。**
      // **記号の位置・小数桁・負数の表し方・端数処理・接頭辞を1つも作らない** ——
      // **アプリが位置を選べない。**
      //
      // **限定10**: **単位は `field`(既に引数である)の中に入って届く** ——
      // **表示関数の引数を1本も増やしていない**(`ADR-0050` 限定10 の趣旨は無傷)。
      //
      // **限定6**: **`formatNumber` に1バイトも触っていない** —— **桁区切りは単位を
      // 書いても書かなくても今日と1文字も変わらない。**
      //
      // **限定11**: **`className` を1つも増やしていない** —— 単位は同じ `<span>` の
      // 中の文字であり、`web/src/styles.css` に1バイトも足していない。
      return (
        <span className="field-number" data-testid="field-value-number">
          {formatNumber(value)}
          {field.unit === undefined ? "" : ` ${field.unit}`}
        </span>
      );

    case "boolean":
      // 入力欄(チェックボックス)にはしない。一覧は読むための画面なので記号で示す。
      //
      // **【V4-M15-T05 / `ADR-0087`】器を部品体系の `Badge` に載せ替えた。**
      // **`field-boolean` のクラス名も `role="img"` も `aria-label` も1つも落としていない。**
      // **色を新しく作っていない** —— 使う変種は `default`(`bg-secondary`)と `muted` の
      // 2つだけで、**真と偽に別の配色の意味を作らない**(「はい = 緑」を表すスロットは
      // 25の中に無く、作れば `ADR-0046` の7軸を増やすことになる)。**変えたのは
      // 「文字が地の上に置かれるか、印の中に置かれるか」だけである。**
      return value === true ? (
        <Badge
          className="field-boolean"
          data-testid="field-value-boolean"
          role="img"
          aria-label="はい"
        >
          ✓
        </Badge>
      ) : (
        <Badge
          variant="muted"
          className="field-boolean"
          data-testid="field-value-boolean"
          role="img"
          aria-label="いいえ"
        >
          ✕
        </Badge>
      );

    case "date":
      return (
        <span className="field-date" data-testid="field-value-date">
          {formatDate(String(value))}
        </span>
      );

    case "reference": {
      // 「参照先が無い(参照切れ)」と「見つかったが代表値が引けない」を混同しない。
      // 後者は _id を出す —— 見つかっているのに「見つかりません」と書くのは事実に
      // 反するし、ID は そのレコードを指す唯一の手掛かりである(憲法6)。
      // **ここは値の見せ方だけを決める。** 参照先レコードへのリンク(V3-M3-T02)は
      // 呼び出し側がこの `<span>` を `<a>` で包む形で入れる(`referenceLinkTarget` 参照)
      // —— 表示関数の引数を増やさないため(ADR-0050 限定10)。
      const resolved = resolveReference(referenceLabels, field.reference_table, String(value));
      return (
        <span
          className={resolved.found ? undefined : "field-unresolved"}
          data-testid="field-value-reference"
        >
          {resolved.text}
        </span>
      );
    }

    case "image":
      // 値 = `_files.file_id`。配信 URL を `<img src>` にする(V2-M2-T04 / ADR-0035)。
      // file_id を読み手に文字列で見せず、画像として出す。alt はフィールド名(マニフェスト
      // 由来。表示オプションを増やさない)。存在秘匿・可視範囲はサーバの配信 API が守る。
      return (
        <img
          className="field-image"
          data-testid="field-value-image"
          src={fileDeliveryUrl(appId, String(value))}
          alt={field.name}
        />
      );

    case "file":
      // 値 = `_files.file_id`(image と同じ)。**ただし `<img>` にしない**
      // (`V5-M16-T05` / `ADR-0161`)—— **配信は実体が4種の画像と判定できない限り必ず
      // ダウンロードで返る**(`Content-Disposition: attachment`)ので、`<img>` に入れても
      // 何も映らない。**ダウンロードのリンクにする。**
      //
      // **リンクの文字はフィールド名である**(`image` の `alt` と同じ扱い)——
      // **file_id を素の文字列で読み手に見せない。** **元のファイル名も出さない** ——
      // 出すにはレコードとは別に `_files` を引く必要があり、表示関数の引数が増える
      // (`ADR-0050` 限定10)。**出していないことを、出していないと書く。**
      //
      // **`download` 属性を付ける** —— サーバも `attachment` で返すので二重だが、
      // **画面の側でも「これは開く物ではなく落とす物だ」と表明しておく。**
      return (
        <a
          className="field-file"
          data-testid="field-value-file"
          href={fileDeliveryUrl(appId, String(value))}
          download
        >
          {field.name}
        </a>
      );
  }
}

/**
 * `<td>` の器つきの1セル。列と型の対応を DOM 上でも追えるよう `data-field` を出す。
 *
 * **【V3-M2-T05 で直した】旧コメントは「一覧の1セル」だった。** `V3-M2-T02` が軸1(列の寄せ)を
 * 当てるために `<td>` の器を `ListViewRenderer` 側へ移した結果、**一覧はこの関数を使っていない** ——
 * **現在の唯一の呼び出し元は `DetailViewRenderer` の `related` の子一覧である。**
 *
 * **【V3-M3-T02 の追記】そのうち参照先レコードへリンクになるセルだけは、呼び出し側が
 * 同じ形の `<td>` を自分で組む**(`<a>` で包む必要があるため。器を包む引数をここへ足すと
 * ADR-0050 限定10 を破る)。**`<td>` の属性(`data-field` / `data-field-type`)は
 * 両方の経路で同じである** —— 食い違ったら `web/test/record-navigation.test.tsx` が落ちる。
 *
 * **【V4-M15-T05 / `ADR-0087`】器を部品体系の `TableCell` に載せ替えた。**
 * **クラス名は2経路で同じでなければならない**(片方だけ変えると同じ表の中で列が
 * 揃わない)ので、`RELATED_CELL_CLASS` を**この1箇所にだけ置いて**両経路が読む。
 */

/**
 * `related` の子一覧の1セルに足す見た目のクラス(`V4-M15-T05`)。
 *
 * **`FieldCell`(リンクにならないセル)と `DetailViewRenderer`(リンクになるセル)の
 * 両方がこれを読む。** 2箇所に書くと同じ表の中で余白が割れる。
 */
export const RELATED_CELL_CLASS = "px-s2 py-s1";

export function FieldCell({
  field,
  value,
  referenceLabels,
  appId,
  textPreview,
}: {
  field: Field;
  value: RecordValue | undefined;
  referenceLabels: ReferenceLabelIndex;
  /** 所属アプリのID(image 型の配信 URL 用。`FieldValue` へ渡すだけ)。 */
  appId: string;
  /**
   * `long_text` の切り詰め長のプリセット(ADR-0050 の軸7)。**`FieldValue` へ渡すだけ**で、
   * ここでは解釈しない。現在の呼び出し元は `related` の子一覧だけなので、渡ってくるのは
   * 親の detail_view に書かれた値である(ADR-0050 §4: 軸7 は子一覧にも当たる)。
   */
  textPreview?: TextPreview;
}) {
  return (
    <TableCell data-field={field.id} data-field-type={field.type} className={RELATED_CELL_CLASS}>
      <FieldValue
        field={field}
        value={value}
        referenceLabels={referenceLabels}
        appId={appId}
        textPreview={textPreview}
      />
    </TableCell>
  );
}
