/**
 * 参照 EC の周辺計算(島の JS 本体)。V2-M7-T02 / CP-V2 受け入れゲート。
 *
 * ここには **manifest.ts の function リソースが実際に走らせる島のソース文字列**を置く。
 * カーネル(`src/kernel/`)は1バイトも触らない —— 計算は全て島の JS に閉じる(EC-G6 の
 * 一般演算はカーネルに無く、限定12 は不可侵)。manifest.ts はこのモジュールの文字列を
 * function の `code` に差すだけで、テーブル・ビュー構造は変えない。
 *
 * ## 実際に使う島の契約(src/kernel/island-runner.ts + workflow-runner.ts で確認)
 *  - **入力の届き方**は `FunctionInput.source` で決まる(`resolveFunctionInput`):
 *     - `source: "record"` … トリガー元レコード1件(`RecordRow`)がそのまま島の引数に届く。
 *       島は `(rec) => ...` として `rec.unit_price` / `rec.quantity` を読む。
 *     - `source: "table"` … そのテーブルの**全行の配列**が島の引数に届く。
 *       島は `(rows) => ...` として全 cart_line / order_line を畳み込む。
 *  - **出力の返し方**はどちらも **「行(オブジェクト)の配列」**。`validateFunctionOutput` が
 *    `output.fields` の各 `{id,type}` で1行ずつ検証し、1件でも型が合わなければ fail-closed。
 *  - **Route B(`write_back:"$record"`)**: 出力は**ちょうど1行**でなければならず、その行の各キーは
 *    トリガー元テーブルの実在フィールドに限定される。その1行が `updateRecord` でトリガー元
 *    レコード自身へ書き戻る(ADR-0037)。
 *  - **output_table 全置換**: 出力の各行が output_table へ挿入される前に、その output_table の
 *    既存行は**全削除**される(部分更新ではない。ADR-0024)。よって集計は「注文行に total 列」
 *    という行内自然形にならず、集計専用テーブル(cart_totals / order_totals)に落ちる(EC-G10 の代償)。
 *
 * ## ★ V2-M7-T02 が実挙動で突き当たった限界(**原文のまま残す**。誇張しない。憲法6)
 *  **集計島は「1テーブルの全行」しか入力に取れない**(`FunctionInput` は table / view / record の
 *  3種で、複数テーブルの join は語彙に無い)。したがって集計島は cart_line / order_line は
 *  読めても、**coupon / shipping_method / tax_rate テーブルを島から引けない。**
 *  そのため「クーポン種別・割引値・基本送料・無料閾値・税率」は**島のソースに定数として
 *  焼き込む**しかない(下の `totalsIsland(config)` が config を JSON リテラルで埋め込む)。
 *  帰結:
 *   - 送料方針・税率は「店舗共通の1組の定数」としてなら島に持てる(現実的)。
 *   - **クーポンは「注文ごとに coupon テーブルから引いて適用」ができない** —— 島に焼き込んだ
 *     1つのクーポンは事実上「店舗共通の一律割引」になる。注文ごとに違うコードを当てるには、
 *     チェックアウト時にアプリ側が単価・割引・送料・税を**行に非正規化して焼き付ける**か、
 *     カーネルに join/参照展開を足す(門A審査)しかない(EC-G6/G9 の残る壁)。
 *
 * ## ★★ V3-M11-T02 が上の限界のどこを動かし、どこを動かさなかったか(**実測**)
 *  `ADR-0062`(D-G14 / V3-M9)が `function.input` に**配列形(最大5要素)**を足したので、
 *  「島から coupon / shipping_method / tax_rate を引けない」の**前半だけ**が動いた ——
 *  集計 function の入力を **4要素**(明細表 + `shipping_method` + `tax_rate` + `coupon`)に
 *  宣言すれば、島は3表の**全行**を受け取る(`totalsInput()` / `totalsIsland()` を参照)。
 *  **動かなかったもの(1つずつ書く)**:
 *   1. **カーネルは突き合わせを1行も行わない。** `resolveFunctionInput`
 *      (`src/kernel/workflow-runner.ts:1156`〜`:1176`)は「宣言順に既存3分岐を繰り返して
 *      配列に並べる」だけである。**結合・射影・集約・参照解決・重複排除・ソートは島の JS 側。**
 *   2. **「どの行か」を発火ごとに選べない**(`ADR-0062` §限界2)。島が受け取るのは
 *      「テーブルの**全行**」であって「この注文のクーポン行」ではない。
 *   3. **注文別クーポンは今日も解けない。** 鍵(`order.coupon` の参照)は `order` テーブルに
 *      在るが、`order` は入力宣言に入っていない(要素数を4に収めるメインの裁定)。**仮に
 *      5要素目として `order` を渡してもカーネルは参照を1ホップも辿らない**(`ADR-0062`
 *      §限界1)ので、`order.coupon` の値(coupon の `_id`)と coupon 行の突き合わせは
 *      **島の JS が自分で書く**ことになる —— それは本タスクの射程外(門の外で語彙も足さない)。
 *      よって島は「**有効なクーポンがちょうど1行のときだけ店舗共通で当てる**」という
 *      店舗共通の規則しか持てない(= V2-M7-T02 が書いた「事実上の一律割引」のまま)。
 *   4. **`DEFAULT_SHIPPING` / `DEFAULT_TAX` は消えていない** —— 表が空のときに使う**既定値**
 *      として島のソースに JSON リテラルで残る(`functions.test.ts` の (4-4) が固定する)。
 *      「表が空のときの値」を宣言する場所がマニフェストの語彙に無いためである。
 */

import type { FunctionInput } from "../../src/kernel/types.ts";

/**
 * 明細金額(単価×数量)を行内へ書き戻す島(Route B。source=record → write_back:$record)。
 *
 * トリガー元の cart_line / order_line レコードを1件受け取り、`line_total` 1フィールドだけを
 * 持つ**1行**を返す。返した1行がトリガー元レコード自身へ書き戻る(ADR-0037)。
 * null/未入力は 0 として扱う(number 型で検証を通す)。
 */
export const LINE_TOTAL_ISLAND =
  "(rec) => [{ line_total: (rec.unit_price || 0) * (rec.quantity || 0) }]";

/**
 * **同じ品が2行にならないようにする島**(`V4-M21-T01` / `E-G30` / `D-V4-72`)。
 *
 * **単位A(自動処理が行を消せるようにする)は門A で却下された。** 帰属先は**既存語彙**で
 * あり、この島は**行を1つも消さない** —— 返すのは `update` op だけである
 * (`run_function` の `write_ops` モード。`ADR-0067`)。
 *
 * ## 何をするか
 *
 * 入力は `cart_line` の**全行**(`source: "table"`)で、カーネルが `sort` 無しで読むので
 * **作成順(`_created_at ASC, _id ASC`)**で届く。`カート × 商品` で束ね、2本目以降を
 * 見つけたら:
 *
 *  - **先頭の行**に数量の合計を書く(`line_total` も合算後の数量で書き直す)。
 *  - **2本目以降**に `voided: true` を立てる(**消さない**)。
 *
 * `update` op には `if_match`(版一致 = 既存の CAS)が必須である(`ADR-0067` 限定 A7)。
 * 島が読んだ `_updated_at` をそのまま載せる。**1 op でも失敗すれば全部巻き戻る。**
 *
 * ## 【この島が解かないこと】
 *
 *  - **行は消えない。** 無効行は DB に残り続ける。
 *  - **競合したときは `if_match` が弾くだけ**である —— 弾かれた側は発火元の書込ごと
 *    成立しなくなる(`ADR-0066`)。**再試行はしない。**
 *  - **`voided` を人が戻す導線は無い**(画面の `filter` は無効行を出さないだけである)。
 *
 * ## 【`V4-M21-T01` の実測 → `V4-M34-T01` の実測。両方を残す。誇張しない】
 *
 * **`V4-M21-T01`(2026-07-31)の実測**: 重複が1つも無いときに `[]` を返すと、
 * `writeRecords` の構造検査が **「/ops バッチに操作が1件もありません。」**で落ち、
 * `ADR-0066` により**発火元の `cart_line` の作成ごと 400 になった**(1件目のカート投入が
 * そもそも通らなくなった)。**そこでこの島は、まとめるものが無いときに最後の行へ
 * `voided` を今の値のまま書き直す 1 op(値の変わらない update)を返すようにした。**
 *
 * **`V4-M34-T01`(2026-08-04)で「空配列を返せない」という制約は消えた**: **`ADR-0131`
 * (門A 本審査 = 限定採用。単位A)により、op が0件の要求は `{ ok: true, results: [] }` を
 * 返すようになった。** **カーネルに「0件を許す形」は今日在る。**
 *
 * **【それでもこの 1 op は残す。理由は当時とは別である。V4-M34-T01 が実測して見つけた】**
 *
 * **外してみたら既存の検査が11本落ちた。** 原因は「空配列を返せない」ことではなく、
 * **`voided` が NULL のままになること**だった —— 画面 `cart-line-list` の `filter` は
 * `{ not: { field: "voided", equals: true } }` であり、**SQLite の三値論理により
 * `voided` が NULL の行はこの filter に1行も入らない**(`V4-M34-T01` が本物の SQLite で
 * 実測: NULL / false / true の3行に当てて、返るのは false の1行だけ)。
 * **この 1 op は、最新の行の `voided` を NULL から false へ確定させる役目を、
 * 誰も書き残さないまま担っていた。**
 *
 * **代償は今日も同じである: 重複が無くても `_updated_at` が1つ進む。**
 * **本来の直し方(`cart_line.voided` に既定値を持たせる / filter を NULL に届く形にする)は
 * 本タスクの契約(`ADR-0131` の限定表11点)の外なので、1バイトも実装していない。**
 */
export const CART_LINE_DEDUPE_ISLAND = `(rows) => {
  const ops = [];
  const keep = {};
  const order = [];
  for (const r of (rows || [])) {
    if (r.voided === true) { continue; }
    if (r.cart == null || r.product == null) { continue; }
    const key = String(r.cart) + "\\u0000" + String(r.product);
    if (!(key in keep)) {
      keep[key] = { row: r, qty: (r.quantity || 0), merged: false };
      order.push(key);
      continue;
    }
    const g = keep[key];
    g.qty += (r.quantity || 0);
    g.merged = true;
    ops.push({
      op: "update",
      table: "cart_line",
      target: r._id,
      if_match: r._updated_at,
      values: { voided: true },
    });
  }
  for (const key of order) {
    const g = keep[key];
    if (!g.merged) { continue; }
    ops.push({
      op: "update",
      table: "cart_line",
      target: g.row._id,
      if_match: g.row._updated_at,
      values: { quantity: g.qty, line_total: g.qty * (g.row.unit_price || 0) },
    });
  }
  if (ops.length === 0 && (rows || []).length > 0) {
    // **この1 op は今日も要る**(理由は ADR-0131 より前とは別である。上のコメント参照)——
    // 最新の行の \`voided\` を NULL から false へ確定させ、画面の filter の母集団に入れる。
    const last = rows[rows.length - 1];
    ops.push({
      op: "update",
      table: "cart_line",
      target: last._id,
      if_match: last._updated_at,
      values: { voided: last.voided === true },
    });
  }
  return ops;
}`;

/**
 * 集計島に焼き込む価格設定。
 *
 * **V3-M11-T02 で意味が変わった** —— これは「唯一の値」ではなく、**表から決まらなかったときに
 * 使う既定値**である(表が空 / 有効クーポンが1行に定まらない ときに使う)。表に行が在れば
 * そちらが勝つ(`functions.test.ts` の (4-2) / (4-3) / (4-4) が両方向を固定する)。
 *  - `group_field` … 何で束ねるか。cart_line なら "cart"、order_line なら "order"。
 *  - `coupon` … null なら割引なし。`percent` は subtotal×value/100 を Math.floor、
 *    `fixed` は value をそのまま。いずれも subtotal を超えないようにクランプする。
 *  - `shipping` … null なら送料 0。subtotal が `free_over` 以上なら 0、未満なら `base_fee`。
 *  - `tax` … null なら 0。`Math.floor(subtotal × rate)`(JPY 整数。EC-G9 通貨精度は語彙外なので
 *    Math.floor で決定論的に丸める)。**税は小計基準**(割引後ではない。素案 §2-6 の "subtotal×rate")。
 */
export type PricingConfig = {
  group_field: string;
  coupon: { type: "percent" | "fixed"; value: number } | null;
  shipping: { base_fee: number; free_over: number } | null;
  tax: { rate: number } | null;
};

/**
 * 集計島が読む**マスタ表の宣言順**(V3-M11-T02。`ADR-0062` の配列形)。
 *
 * **この並びは島のソースの添字と1対1で対応している** —— `inputs[1]` が配送方法、`inputs[2]`
 * が税率、`inputs[3]` がクーポンである。だから宣言と島を**同じファイル**に置く(別ファイルに
 * 分けると、並べ替えたときに黙って別の表を読む)。
 */
export const TOTALS_MASTER_TABLES = ["shipping_method", "tax_rate", "coupon"] as const;

/**
 * 集計 function の入力宣言(**配列形。要素4**)を作る。
 *
 * `[明細表, shipping_method, tax_rate, coupon]`。`ADR-0062` 限定3 の `maxItems: 5` の内側で、
 * **新しい表を1本も作らない**(メインの裁定。既存3表を使う)。`source` は3種のうち `table`
 * だけを使い、`view` を1つも使わない —— `list_view` の `filter` に `$record.<フィールドID>`
 * を書くと apply では拒否されず実行時に0行になる(`ADR-0062` 改訂2)ため、その形へ寄らない。
 */
export function totalsInput(lineTable: string): FunctionInput[] {
  return [
    { source: "table", table: lineTable },
    ...TOTALS_MASTER_TABLES.map((table) => ({ source: "table" as const, table })),
  ];
}

/**
 * 集計島のソースを生成する(明細表の全行 → output_table 全置換)。
 *
 * **入力の2形を両方受ける**(V3-M11-T02):
 *  - **単体形** `input: { source: "table", table: "cart_line" }` … 引数は明細行の配列。
 *    マスタ表は届かないので、価格設定は焼き込んだ `config` がそのまま使われる(V2-M7 の形)。
 *  - **配列形** `input: totalsInput("cart_line")` … 引数は
 *    `[明細行[], shipping_method 行[], tax_rate 行[], coupon 行[]]`。
 *    **表に行が在ればそちらが勝ち、無ければ焼き込んだ `config` が既定値として使われる。**
 *    見分けは「先頭要素が配列かどうか」で行う(明細行はオブジェクトなので配列にならない)。
 *
 * 全行を `group_field` で束ね、グループごとに:
 *   subtotal = Σ line_total(line_total が無ければ unit_price×quantity で代替)
 *   discount = クーポン(percent は floor(subtotal×value/100)/ fixed は value。subtotal で上限クランプ)
 *   shipping_fee = subtotal ≥ free_over なら 0、未満なら base_fee
 *   tax = floor(subtotal × rate)
 *   total = subtotal − discount + shipping_fee + tax
 * を計算し、`{ [group_field], subtotal, discount, shipping_fee, tax, total }` の行配列を返す。
 * **集計(sum / group by)も表の突き合わせもカーネルでなく島の中**(ADR-0024 §7a / ADR-0062
 * 限定4。限定12 不可侵)。
 *
 * **マスタ表からどの行を採るか**(**発火ごとに選べないので店舗共通の規則しか書けない**):
 *  - 配送方法 / 税率 … **先頭行**。`order.shipping_method` の参照は島に届かない(§★★ の 3)。
 *  - クーポン … **有効(`is_active` かつ割引種別が percent / fixed)な行がちょうど1つのとき
 *    だけ**それを店舗共通で当てる。0行なら既定値、**2行以上なら「どれがこの注文のものか」を
 *    選ぶ鍵が無いので既定値に落ちる**(= 参照 EC の既定では割引なし)。
 */
export function totalsIsland(config: PricingConfig): string {
  // 価格設定を JSON リテラルとして島のソースに埋め込む(**表が空のときの既定値**)。
  return `(input) => {
  const CFG = ${JSON.stringify(config)};
  const g = CFG.group_field;
  // ADR-0062 配列形: [明細行[], shipping_method 行[], tax_rate 行[], coupon 行[]]。
  // 単体形(明細行[] だけ)との見分けは「先頭要素が配列か」で行う(明細行はオブジェクト)。
  const multi = Array.isArray(input) && Array.isArray(input[0]);
  const rows = (multi ? input[0] : input) || [];
  const shipRows = (multi ? input[1] : []) || [];
  const taxRows = (multi ? input[2] : []) || [];
  const couponRows = (multi ? input[3] : []) || [];
  // 表の先頭行を店舗共通の1組として使う(発火ごとに「どの行か」を選ぶ鍵はカーネルから来ない)。
  const shipping = (shipRows.length > 0)
    ? { base_fee: (shipRows[0].base_fee == null) ? 0 : shipRows[0].base_fee,
        free_over: (shipRows[0].free_over == null) ? Infinity : shipRows[0].free_over }
    : CFG.shipping;
  const tax_cfg = (taxRows.length > 0)
    ? { rate: (taxRows[0].rate == null) ? 0 : taxRows[0].rate }
    : CFG.tax;
  const usable = couponRows.filter((c) =>
    c.is_active === true && (c.discount_type === "percent" || c.discount_type === "fixed"));
  // ちょうど1つのときだけ当てる。2つ以上は「この注文のもの」を選べないので当てない。
  const coupon = (usable.length === 1)
    ? { type: usable[0].discount_type, value: (usable[0].discount_value == null) ? 0 : usable[0].discount_value }
    : CFG.coupon;
  const sub = {};
  const order = [];
  for (const r of rows) {
    // V4-M21-T01: 無効にした明細(cart_line.voided)は集計に入れない。
    // **order_line には voided 列が無いので、そちらでは1行も落ちない**(undefined は真にならない)。
    if (r.voided === true) { continue; }
    const key = (r[g] == null) ? "" : String(r[g]);
    if (!(key in sub)) { sub[key] = 0; order.push(key); }
    const lt = (r.line_total == null) ? ((r.unit_price || 0) * (r.quantity || 0)) : r.line_total;
    sub[key] += lt;
  }
  return order.map((key) => {
    const subtotal = sub[key];
    let discount = 0;
    if (coupon) {
      discount = (coupon.type === "percent")
        ? Math.floor(subtotal * coupon.value / 100)
        : coupon.value;
      if (discount > subtotal) { discount = subtotal; }
    }
    let shipping_fee = 0;
    if (shipping) {
      shipping_fee = (subtotal >= shipping.free_over) ? 0 : shipping.base_fee;
    }
    const tax = tax_cfg ? Math.floor(subtotal * tax_cfg.rate) : 0;
    const total = subtotal - discount + shipping_fee + tax;
    const row = { subtotal: subtotal, discount: discount, shipping_fee: shipping_fee, tax: tax, total: total };
    row[g] = key;
    return row;
  });
}`;
}

/**
 * 参照 EC の店舗共通の既定価格設定。
 *
 * **V3-M11-T02 の実測: これは「1バイトも要らなくなった」ものではない。** 集計 function は
 * `shipping_method` / `tax_rate` を入力に取るようになったが、**その表が空のときに使う値**を
 * 宣言する場所がマニフェストの語彙に無いので、既定値としてここに残る(`functions.test.ts`
 * (4-4) が「表が空なら 500 / 5000 / 0.1 が使われる」ことを実挙動で固定している)。
 * ★限界のとおりクーポンは注文ごとに引けないので既定は null(送料・税だけ店舗共通で持つ)。
 *   - 送料: 基本 500 円 / 5000 円以上で無料
 *   - 税: 10%(JPY 整数へ Math.floor)
 */
export const DEFAULT_SHIPPING = { base_fee: 500, free_over: 5000 } as const;
export const DEFAULT_TAX = { rate: 0.1 } as const;

/** cart_line 集計(group by cart)の既定島。manifest.ts の fn-cart-totals が使う。 */
export const CART_TOTALS_ISLAND = totalsIsland({
  group_field: "cart",
  coupon: null,
  shipping: { ...DEFAULT_SHIPPING },
  tax: { ...DEFAULT_TAX },
});

/** order_line 集計(group by order)の既定島。manifest.ts の fn-order-totals が使う。 */
export const ORDER_TOTALS_ISLAND = totalsIsland({
  group_field: "order",
  coupon: null,
  shipping: { ...DEFAULT_SHIPPING },
  tax: { ...DEFAULT_TAX },
});
