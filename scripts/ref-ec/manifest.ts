/**
 * 参照 EC アプリの**全マニフェスト**(V2-M7-T01 / CP-V2 受け入れゲート)。
 *
 * 01 §1 の参照機能セット(商品カタログ〔カテゴリ・画像〕/ カート / チェックアウト /
 * 注文管理 / 在庫 / 顧客アカウント / クーポン・割引 / 配送方法・送料 / 税計算 /
 * 注文確認メール / 決済モック)を、**プラットフォームの既存語彙だけ**で丸ごと宣言する。
 * 04-ec-data-model-draft §2 のテーブル素案(型「⚠」箇所は M1〜M6 で解けた)を全機能セットへ
 * 拡張したもので、M5 `scripts/mock-psp/payment-flow-e2e.ts` の部分モデル(`ecManifest()`)の
 * 上位互換にあたる。
 *
 * **カーネル語彙は1つも足していない**(M7 は実証ゲート):
 *   - リソース種7(app / table / form / list_view / detail_view / workflow / function)
 *   - フィールド型8(text / long_text / number / boolean / date / select / reference / image)
 *   - diff op 15。reference は**同一アプリ内テーブルのみ**(category.parent の自己参照を含む)。
 *
 * **【`V5-M18` / `G-G21`。2026-08-05】上の2行の数は、書かれた当時(v2)の実測である。**
 * **今日は フィールド型 **9**(`file` が9種目。`V5-M16` / `ADR-0161`)/ diff op **16** である。**
 * **本タスクは上の2行を1バイトも書き換えていない**(当時の記録として残す)——
 * **食い違っているのは数だけで、「このアプリが語彙を足していない」という主張は今日も真である。**
 * **`V5-M18` もカーネル語彙を1つも足していない**(足したのはこのアプリの宣言だけである)。
 *
 * ## §2 `V5-M18`(`G-G21` / `D-V5-86`)が足したもの
 *
 * **`D-V5-86`(ユーザ決定)= 「参照アプリに会計画面を足す」。** 着手前、このアプリには
 * **支払い(会計)を人が入力する画面が1本も無かった** —— `payment_events` は外から届く
 * Webhook の受け皿であって、人が触る入口ではない。足したのは次の3ビュー・1ワークフローである:
 *
 *  - **`cart-list`**(一覧)—— 買い物かごの行に「会計に進む」を置く(**`V5-M21` = 一覧の行の操作起点**)。
 *  - **`checkout-form`**(入力フォーム)—— **会計(支払い)の入力画面**。`order` に書く。
 *  - **`order-receipt`**(単票)—— 会計の控え。`order-list` の行から**行き先を宣言して**開く
 *    (**`V5-M22` = リンクの行き先**。規約どおりなら `order-detail` に行くところを、宣言で変える)。
 *  - **`wf-order-payment-confirm`**(**`trigger.type: "manual"`**)—— 一覧の行のボタンから起こす
 *    (**`V5-M25` = 手動起動**)。
 *
 * **`V5-M24`(URL とプリフィル)はマニフェストにキーを1本も足していない** —— 効くのは
 * `actions[].prefill` を置いた画面が生む `?prefill.<field>=<値>` の URL であり、宣言側は
 * 着手前と同じ `{ field }` の最小形のままである。
 *
 * **【使わなかったもの】`user_kinds`(`V5-M17` / 利用者の種類の宣言)は使っていない。**
 * 理由は `docs/plan/v5/records/v5-m18.md` §5 に書いた(**差分操作が実在せず、TS 型にも無い**)。
 *
 * ## §1 素案の型「⚠」がどの語彙で解けたか(名実の確認)
 *  - **EC-G1 匿名閲覧** = `st_public`(boolean 非required)規約。product / category に載せると
 *    未認証 GET が公開行だけ返す(M1 / ADR-0034)。**§1 の "is_published" はこの `st_public`
 *    規約で実現する** —— プラットフォームの公開 read ゲートは「`st_public` という名前の boolean」に
 *    ハードコードされているため、公開フラグはこの名前でなければ匿名閲覧に効かない(下の findings)。
 *  - **EC-G2 顧客スコープ** = `st_owner`(text 非required)規約。cart / order / cart_line /
 *    order_line / address / customer に載せると customer ロールが自分の行だけ見える(M1 / ADR-0033)。
 *  - **EC-G3 画像** = `image` 型(ADR-0035)。product.image に file_id を持ち、`POST /files` で
 *    アップロード・`GET /files/:id` で配信(公開行は未認証可)。
 *  - **EC-G8 一意** = `unique` フラグ(ADR-0038)。sku / slug / code / email / order_number /
 *    event_id をアプリ層で一意化。
 *  - **EC-G6 演算 / EC-G10 集計** = function(島の JS)。行内は Route B(`write_back:$record`)、
 *    合計は集計テーブル(cart_totals / order_totals)へ output_table 全置換(T02 が実装)。
 *  - **EC-G17 related / EC-G14 actions** = detail_view の子一覧埋め込みと操作起点(ADR-0044/0045)。
 *
 * ## この T01 が「できなかった」正直な findings(誇張しない。憲法6)
 *  1. **§1 "is_published" は独立フィールドとして持てない** —— 匿名閲覧を効かせる公開フラグは
 *     プラットフォーム規約で名前が `st_public` に固定されている。よって product の公開フラグは
 *     `st_public` と名付ける(別に is_published を足しても匿名 read ゲートには一切効かない)。
 *     §1 の "is_published" 概念は `st_public` に**同一視**して満たしている。
 *  2. **行内の計算列(line_total / subtotal / total)は「宣言しただけでは埋まらない」** ——
 *     number フィールドとして持てるが、値はワークフロー + function(T02)が計算して書く。
 *     カーネルに計算式フィールド(computed)は無い(EC-G6 の残る限界。ADR-0037)。
 *  3. **集計は集計専用テーブル(cart_totals / order_totals)に別置きになる** —— 「注文行に
 *     total 列」という自然形にはなるが(number 列は持てる)、Σ を自動更新する手段が無いため
 *     T02 は function 全置換で totals テーブルに書く(EC-G10 の代償。§6-3)。
 *  これらは T02/T03 が実挙動で実証・記録する。T01 はマニフェストが applyManifest valid になり、
 *  匿名閲覧 / 顧客隔離 / 画像が本物の HTTP で通ることまでを担う。
 */
import { createHash } from "node:crypto";
import type { Manifest } from "../../src/kernel/types.ts";
import { OWNER_FIELD, PUBLIC_FIELD, UNDELETABLE_FIELD } from "../../src/server/owner-scope.ts";
// T02: 周辺計算の島の本体(単価×数量の Route B / 小計・割引・送料・税・合計の集計)。
// **island のソースはここに置き、manifest は code に差すだけ**(テーブル・ビュー構造は不変)。
import {
  CART_LINE_DEDUPE_ISLAND,
  CART_TOTALS_ISLAND,
  LINE_TOTAL_ISLAND,
  ORDER_TOTALS_ISLAND,
  totalsInput,
} from "./functions.ts";

/** 参照 EC アプリの app_id。 */
export const REF_EC_APP_ID = "ref-ec";

// --- 逃げ道(任意 CSS)の見本(V4-M30 / `D-V4-113`。V4-M33 / `D-V4-116` で店からは取り消した)---
//
// **`CP-V4-UI` の §2-16 は、参照ショップの逃げ道資産の在庫を「0件」と実測している。**
// `V4-M30` は `D-V4-113`(ユーザ決定)にもとづき、持ち主向けの知らせ(`custom-css-target-unverified`)
// が本物のブラウザで出るところを見せるため、この見本を1件発行し `catalog-list` から参照させた。
//
// **その後 `D-V4-116`(ユーザ決定)は「検査の中だけに残し、店からは取り消す」と定めた** ——
// 置き続けると、参照ショップの商品一覧に**壊れていなくても持ち主向けの帯が常に出続け**、見た目の
// 再計測時も `catalog-list` の値が以前と変わるためである。**したがって下の `catalog-list` ビューは
// もう `custom_css` を参照していない(在庫は再び0件に戻る)。**
//
// **この本文・ダイジェストの定数だけは、検査の中に残すために引き続き export している** ——
// `web/e2e/escape-hatch.e2e.ts` の chromium 検査(V4-M30 が足した2本を含め1本も消していない)が、
// フィクスチャアプリへ発行する CSS が「参照ショップに置いていた見本と同じバイト列であること」を
// 確かめる比較対象として、`REF_EC_ESCAPE_HATCH_CSS` / `REF_EC_ESCAPE_HATCH_DIGEST` を直に import
// している(`docs/plan/v4/records/v4-m33.md` §1)。
//
// **【2026-08-04 / `V4-M52` / ユーザ決定 `D-V4-138`】** **かつてここに在った
// `REF_EC_ESCAPE_HATCH_ASSET`(`"catalog-emphasis"`)と `REF_EC_ESCAPE_HATCH_VIEW`
// (`"catalog-list"`)の2定数は消した。** 参照ショップのどこからも使わなくなった宣言だったためである。
// **2つの値を使っていた検査は1本も消していない** —— `scripts/ref-ec/serve.test.ts` と
// `scripts/ref-ec/manifest.test.ts` が、同じバイト列を各ファイルの中に直に書く形に書き換えてある
// (守っている内容は1つも変わっていない)。**`REF_EC_ESCAPE_HATCH_CSS` / `REF_EC_ESCAPE_HATCH_DIGEST`
// の2本は上のとおり残してある**(e2e がバイト一致の照合に使うため)。
//
// **【この見本が実演していたこと/いないこと。誇張しない】**
//   - **「壊してみせた」実演ではない。** 4つ目の状態は `web/src/views/ViewHost.tsx` が
//     「配信された CSS が空白以外を1文字でも含むか」だけで発火させており、**当たり先を
//     1件も数えていない。** したがって**この見本を置いた瞬間から**知らせは出ていた。
//   - **`CP-V4-UI` の条件16 の限定つきを解消するものではなかった**(条文は「当たり先が消えた
//     資産を全件数えて記録する」であり、数えるには CSS の解釈が要る = `ADR-0055` 限定8 /
//     憲法1 の引き直しになる)。**在庫を1件にしても0件に戻しても、この限定は動いていない。**

/**
 * 見本の本文(**owner が手で書いた体の任意 CSS**)。
 *
 * 名指ししているクラスは4つとも `web/src/views/ListViewRenderer.tsx` の冒頭が
 * 「部品体系での描き直しでも1つも消していない」と宣言しているもの
 * (`.list-view` / `.list-table` / `.list-total` / `.list-row-interactive`)である。
 * **どれが今日の DOM に実在するかは、この製品は1件も判定しない**(数えるのは人である)。
 */
export const REF_EC_ESCAPE_HATCH_CSS = [
  "/* 参照ショップの見本(V4-M30 / D-V4-113)。商品一覧だけに当てる。 */",
  ".list-view { padding-block-end: 4px; }",
  ".list-table td { border-bottom: 1px solid #d4c5b0; }",
  ".list-total { font-weight: 700; }",
  ".list-row-interactive:hover { background-color: #fdf6ec; }",
  "",
].join("\n");

/**
 * 見本の内容ダイジェスト(sha256 hex)。**本文から計算する** ので、本文を1バイト直せば
 * マニフェストの参照も自動で追随する(手で書き写した値が腐ることがない)。
 */
export const REF_EC_ESCAPE_HATCH_DIGEST = createHash("sha256")
  .update(REF_EC_ESCAPE_HATCH_CSS)
  .digest("hex");

/**
 * 参照 EC の全マニフェストを返す(§1 フル機能セット)。
 *
 * `applyManifest(dataRoot, REF_EC_APP_ID, referenceEcManifest())` が **valid** を返す。
 * 全テーブル・ビュー・ワークフロー・function は既存語彙だけで書かれている。
 */
export function referenceEcManifest(): Manifest {
  return {
    app: {
      id: REF_EC_APP_ID,
      name: "参照EC",
      tables: [
        // --- 商品カタログ(カテゴリ・画像。EC-G1/G3)------------------------------
        {
          id: "category",
          name: "カテゴリ",
          fields: [
            { id: "name", name: "カテゴリ名", type: "text", required: true },
            // EC-G8: slug をアプリ層で一意化(unique フラグ。ADR-0038)。
            { id: "slug", name: "スラッグ", type: "text", unique: true },
            // 自己参照(階層カテゴリ)。reference は同一アプリ内テーブルのみ = category → category。
            { id: "parent", name: "親カテゴリ", type: "reference", reference_table: "category" },
            { id: "sort_order", name: "表示順", type: "number" },
            // EC-G1: 匿名閲覧の公開フラグ(st_public 規約。ADR-0034)。
            { id: PUBLIC_FIELD, name: "公開", type: "boolean" },
          ],
        },
        {
          id: "product",
          name: "商品",
          fields: [
            { id: "name", name: "商品名", type: "text", required: true },
            { id: "description", name: "説明", type: "long_text" },
            // EC-G8: SKU を一意に(ADR-0038)。
            { id: "sku", name: "SKU", type: "text", unique: true },
            { id: "price", name: "価格", type: "number", required: true },
            { id: "category", name: "カテゴリ", type: "reference", reference_table: "category" },
            // EC-G3: 商品画像(image 型。file_id を持つ。ADR-0035)。
            { id: "image", name: "商品画像", type: "image" },
            { id: "stock", name: "在庫数", type: "number", required: true },
            { id: "status", name: "状態", type: "select", options: ["active", "archived"] },
            // EC-G1: §1 の "is_published" は st_public 規約で実現する(findings 1)。
            { id: PUBLIC_FIELD, name: "公開", type: "boolean" },
          ],
        },
        // --- 顧客アカウント(EC-G2。st_owner で顧客スコープ)------------------------
        {
          id: "customer",
          name: "顧客",
          fields: [
            { id: "name", name: "氏名", type: "text", required: true },
            // EC-G8: メールを一意に(ADR-0038。形式検査は語彙外)。
            { id: "email", name: "メール", type: "text", unique: true },
            { id: "display_name", name: "表示名", type: "text" },
            { id: "joined_at", name: "登録日", type: "date" },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
          ],
        },
        {
          id: "address",
          name: "配送先住所",
          fields: [
            { id: "customer", name: "顧客", type: "reference", reference_table: "customer" },
            { id: "postal_code", name: "郵便番号", type: "text" },
            { id: "prefecture", name: "都道府県", type: "text" },
            { id: "city", name: "市区町村", type: "text" },
            { id: "line", name: "番地・建物", type: "long_text" },
            { id: "is_default", name: "既定", type: "boolean" },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
          ],
        },
        // --- カート(EC-G2 スコープ / EC-G14 操作起点)-----------------------------
        {
          id: "cart",
          name: "カート",
          fields: [
            { id: "customer", name: "顧客", type: "reference", reference_table: "customer" },
            {
              id: "status",
              name: "状態",
              type: "select",
              options: ["open", "converted", "abandoned"],
            },
            { id: "created_at", name: "作成日", type: "date" },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
          ],
        },
        {
          id: "cart_line",
          name: "カート明細",
          fields: [
            { id: "cart", name: "カート", type: "reference", reference_table: "cart" },
            { id: "product", name: "商品", type: "reference", reference_table: "product" },
            { id: "quantity", name: "数量", type: "number", required: true },
            // EC-G6: 単価は注文時に焼き付ける(値は T02 の function / WF が入れる)。
            { id: "unit_price", name: "単価", type: "number" },
            // EC-G6: 行内計算列。宣言はできるが値は Route B(write_back)の island が計算して書く。
            { id: "line_total", name: "小計", type: "number" },
            /**
             * **V4-M21-T01(`E-G30` / `D-V4-72`。単位A = 却下。帰属先 = 既存語彙)。**
             *
             * 同じ品をもう一度カートに入れたときに、**行を消さずに無効にする**ための真偽値
             * 1本である。**立てるのは島(`fn-cart-line-dedupe`)の `update` op** で、
             * **落とすのは一覧の `filter` の `not` / `equals`** である。**語彙を1バイトも
             * 増やしていない** —— `boolean` は `FIELD_TYPES` の9種(当時8種)のうち1つである。
             *
             * **【解けないことを書く】行は消えない。** DB に残り続け、データ量に比例して
             * 増える。**`filter` を書き忘れた画面には無効行が出る** —— `cart-detail` の
             * 関連一覧がまさにそれで、**`related` には `filter` を書けない**(`ADR-0044`
             * 限定2)。**「カートの重複が直った」とは書かない。**
             */
            { id: "voided", name: "無効", type: "boolean" },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
          ],
        },
        // --- 注文管理(EC-G5 状態遷移 / EC-G13 target / EC-G6 金額)------------------
        {
          id: "order",
          name: "注文",
          fields: [
            // EC-G8: 注文番号を一意に(ADR-0038。連番採番は語彙外 = アプリが値を入れる)。
            { id: "order_number", name: "注文番号", type: "text", unique: true },
            { id: "customer", name: "顧客", type: "reference", reference_table: "customer" },
            {
              id: "status",
              name: "状態",
              type: "select",
              options: ["pending_payment", "paid", "failed", "shipped", "delivered", "cancelled"],
            },
            {
              id: "shipping_method",
              name: "配送方法",
              type: "reference",
              reference_table: "shipping_method",
            },
            { id: "coupon", name: "適用クーポン", type: "reference", reference_table: "coupon" },
            // EC-G6/G10: 金額の行内列(値は T02 の集計 function / WF が入れる。計算式型は無い)。
            { id: "subtotal", name: "小計", type: "number" },
            { id: "discount", name: "割引額", type: "number" },
            { id: "shipping_fee", name: "送料", type: "number" },
            { id: "tax", name: "消費税", type: "number" },
            { id: "total", name: "合計", type: "number" },
            {
              id: "payment_status",
              name: "決済状態",
              type: "select",
              options: ["unpaid", "paid", "failed", "refunded"],
            },
            { id: "currency", name: "通貨", type: "text" },
            /**
             * **【`V5-M18` / `G-G21` / `D-V5-86`】会計(支払い)の入力画面が受け取る3列。**
             *
             * - **`cart`** —— **`cart-list` の行の操作起点が `_id` をプリフィルする先である**
             *   (`ADR-0045` 限定2: プリフィル先は「遷移先 form の対象テーブル上の reference 型で、
             *   参照先がその画面の対象テーブル」でなければならない)。**この列が無いと
             *   「買い物かごの行から会計へ進む」は宣言できない** —— 着手前は無かった。
             * - **`payment_method`** —— 支払い方法。**`select` の有限4値**であり、
             *   自由入力にしていない(値域を宣言できるのは `select` だけである)。
             * - **`payment_slip`** —— **`file` 型**(`V5-M16` / `ADR-0161`。フィールド型の9種目)。
             *   **参照 EC が `file` 型を使う最初の1本である**(着手前は `product.image` の
             *   `image` 型が1本あるだけだった)。**種類の制限は0件**(`D-V5-84`)で、配信は必ず
             *   ダウンロードになる。**運営がこれを見て入金を確かめる、という筋書きの受け皿である。**
             *
             * **【解けないこと】この3列を足しても、金額が自動で埋まるようにはならない。**
             * 会計画面で人が入れるのは支払い方法と控えだけで、`subtotal` / `total` は
             * 着手前と同じくアプリが焼き付けるか集計島が別テーブルへ書くかである。
             */
            {
              id: "cart",
              name: "もとになった買い物かご",
              type: "reference",
              reference_table: "cart",
            },
            {
              id: "payment_method",
              name: "支払い方法",
              type: "select",
              options: ["credit_card", "bank_transfer", "cash_on_delivery", "convenience_store"],
            },
            { id: "payment_slip", name: "支払いの控え", type: "file" },
            // EC-G15/AI: ai_transform の書き戻し先(注文補足文。任意)。
            { id: "note", name: "補足", type: "long_text" },
            { id: "placed_at", name: "注文日時", type: "date" },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
            // D-G13 / ADR-0061(V3-M8)の受け皿を**参照 EC に初めて当てる**(V3-M11-T01)。
            // **【`V8-M20` / `J-G30` / ユーザ決定 `D-V8-35`】`st_admin_readable`(運営可視)の
            // 宣言フィールドは撤去した。** **代わりに立つのは `app.roles` の
            // 「役割 x 対象(表)x 読取」である**(このファイルの末尾の `roles` を見よ)——
            // **運営(owner)は今日も購入者の注文を読める。**
            // `B-G8` / ADR-0073(V4-M4)の受け皿を**参照 EC に初めて当てる**(V4-M4-T07)。
            // **宣言は行の値で効く** —— `st_admin_readable`(テーブル単位)と違い、
            // **この列が true の行だけ**が `DELETE` を止められる(ADR-0073 限定1 / 限定4)。
            // 値を立てるのは `wf-payment-received`(入金時)であり、**購入者ではない**。
            // **止まるのは `DELETE` だけで、`PATCH` は今日どおり通る**(限定3)——
            // だから運営は状態を動かせる(`D-V4-2`「行は残り、運営が状態を動かす」)。
            // **MCP の `delete_record` はこの規約に1ミリも守られない**(限定6)。
            { id: UNDELETABLE_FIELD, name: "削除不可", type: "boolean" },
          ],
        },
        {
          id: "order_line",
          name: "注文明細",
          fields: [
            { id: "order", name: "注文", type: "reference", reference_table: "order" },
            { id: "product", name: "商品", type: "reference", reference_table: "product" },
            { id: "quantity", name: "数量", type: "number", required: true },
            { id: "unit_price", name: "単価", type: "number" },
            { id: "line_total", name: "明細金額", type: "number" },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
          ],
        },
        // --- クーポン・割引 / 配送方法・送料 / 税(EC-G6 の周辺計算の入力。T02)--------
        {
          id: "coupon",
          name: "クーポン",
          fields: [
            { id: "code", name: "コード", type: "text", unique: true },
            {
              id: "discount_type",
              name: "割引種別",
              type: "select",
              options: ["percent", "fixed"],
            },
            { id: "discount_value", name: "割引値", type: "number" },
            { id: "valid_from", name: "有効開始", type: "date" },
            { id: "valid_to", name: "有効終了", type: "date" },
            { id: "is_active", name: "有効", type: "boolean" },
          ],
        },
        {
          id: "shipping_method",
          name: "配送方法",
          fields: [
            { id: "name", name: "名称", type: "text", required: true },
            { id: "base_fee", name: "基本送料", type: "number" },
            { id: "free_over", name: "無料になる金額", type: "number" },
          ],
        },
        {
          id: "tax_rate",
          name: "税率",
          fields: [
            { id: "name", name: "名称", type: "text", required: true },
            { id: "rate", name: "税率", type: "number" },
          ],
        },
        // --- 決済(EC-G4 受信 / EC-G16 モック)-------------------------------------
        {
          id: "payment_events",
          name: "決済イベント(受信)",
          fields: [
            // EC-G8: event_id 一意で Webhook 重複を冪等吸収(M5 Path D)。
            { id: "event_id", name: "イベントID", type: "text", required: true, unique: true },
            { id: "event_type", name: "種類", type: "text", required: true },
            { id: "order", name: "対象注文", type: "reference", reference_table: "order" },
            { id: "amount", name: "金額", type: "number" },
            { id: "currency", name: "通貨", type: "text" },
            { id: "status", name: "状態", type: "text" },
            // V4-M4-T07(`B-G8` / ADR-0073)。**この列は「値の運び役」である。**
            // **ワークフローのアクションは boolean のリテラルを1つも書けない**
            // (`values` に書けるのは文字列か `"$record.<フィールドID>"` だけ。実測 = 適用時に
            // 拒否された)。したがって `order.st_undeletable` に true を入れるには、
            // **トリガー元レコードの boolean 列を経由するしかない。**
            // **ADR-0073 の審査記録 §4-3 (α) が「値はワークフローの update_record で動かせる
            // (入金時に立てる)」と書いたのは、この制約を測っていなかった。**
            { id: "protect_order", name: "注文を削除不可にする", type: "boolean" },
          ],
        },
        // --- 集計テーブル(EC-G10。T02 が function 全置換で書く。行内でなく別テーブル)------
        {
          id: "cart_totals",
          name: "カート合計",
          fields: [
            { id: "cart", name: "カート", type: "reference", reference_table: "cart" },
            { id: "subtotal", name: "小計", type: "number" },
            { id: "discount", name: "割引", type: "number" },
            { id: "shipping_fee", name: "送料", type: "number" },
            { id: "tax", name: "税", type: "number" },
            { id: "total", name: "合計", type: "number" },
          ],
        },
        {
          id: "order_totals",
          name: "注文合計",
          fields: [
            { id: "order", name: "注文", type: "reference", reference_table: "order" },
            { id: "subtotal", name: "小計", type: "number" },
            { id: "discount", name: "割引", type: "number" },
            { id: "shipping_fee", name: "送料", type: "number" },
            { id: "tax", name: "税", type: "number" },
            { id: "total", name: "合計", type: "number" },
          ],
        },
        // --- 監査 / 履歴(ワークフローの create_record 出力先・history_table)----------
        {
          id: "order_events",
          name: "注文イベント",
          fields: [
            { id: "order", name: "注文", type: "reference", reference_table: "order" },
            { id: "event", name: "イベント", type: "text" },
            { id: "at", name: "時刻", type: "date" },
          ],
        },
        // --- 注文の取り消し申し込み(D-V4-23 / V4-M4-T07)-----------------------------
        //
        // **`D-V4-2` の形をそのまま置いたものである**: 購入者ができるのは**申し込みまで**で、
        // `order` の状態は1ミリも動かさない。**運営が `order` を `PATCH` して動かす。**
        // **これは A(参照 EC)に足した前提であって、B(実地インスタンス)の観測ではない**
        // (`01:361` / `ADR-0073` §限界8)。**件数を B と合算してはならない。**
        //
        // `st_owner` を持つので顧客スコープである(購入者は自分の申し込みだけを読み書きできる)。
        // **`st_undeletable` はここには置かない** —— 申し込み自体は消せてよい。守るのは注文である。
        {
          id: "order_action",
          name: "注文の操作申し込み",
          fields: [
            { id: "order", name: "対象注文", type: "reference", reference_table: "order" },
            {
              id: "action_type",
              name: "申し込みの種類",
              type: "select",
              options: ["cancel_request"],
            },
            { id: "reason", name: "理由", type: "long_text" },
            // **状態を動かすのは運営である。** 購入者が作る行は既定で "requested" のまま。
            {
              id: "status",
              name: "受付状態",
              type: "select",
              options: ["requested", "accepted", "rejected"],
            },
            { id: "requested_at", name: "申込日時", type: "date" },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
          ],
        },
        {
          id: "wf_runs",
          name: "実行履歴",
          fields: [
            { id: "ran_at", name: "実行時刻", type: "date" },
            { id: "workflow", name: "ワークフロー", type: "text" },
            { id: "trigger_type", name: "きっかけ", type: "text" },
            { id: "status", name: "結果", type: "text" },
            { id: "error", name: "エラー", type: "long_text" },
          ],
        },
      ],
      // --- 役割に束ねた権限(面)—— **`V8-M20` の撤去で立つ代わり**(`J-G27`〜`J-G30`)------
      //
      // **`V8-M20` より前、この参照アプリは3つの宣言で権限を書いていた**:
      //   1. `order` 表の `st_admin_readable`(運営が購入者の注文を読める)
      //   2. 操作起点の `audience: ["customer"]` / `["owner"]`(ボタンを誰に出すか)
      //   3. 画面・項目の `audience`(1本も書いていなかった)
      // **1 と 2 は撤去された。** **ここに書く規則がその代わりである。**
      //
      // **【`D-V8-35` の代償が、この参照アプリで実際に見える】**
      // **`order` に「読める」と書いた役割は、書き方を間違えると全員分が見える。**
      // **購入者(`customer`)には条件(`when`)を付けて「持ち主が自分の行だけ」に絞ってある** ——
      // **条件を外すと、購入者が他人の注文を全部読めるようになる。**
      // **これは `st_admin_readable` の時代には起こりえなかった**(あちらは `owner` に固定
      // されていた)。**【禁止の履行】これを「同じ安全性を保った」と書かない。**
      //
      // **【`scripts/` の後始末で足した4本の「ボタンの規則」】**
      // **上の叩き台には「表 x 読取」しか無く、撤去した `view_action.audience` が立てていた
      // **書込の壁**が1本も立っていなかった** —— **`checkout-journey.test.ts` の (E) 群が
      // `walled` を `[]` として実測した(壁の立つ表が2つから0つになっていた)。**
      // **面のボタンの規則(`target: "action"`)を4本足して、同じ壁を立て直した。**
      // **壁の立て方は `isRoleActionWriteAllowed`(`src/server/owner-scope.ts`)である** ——
      // 「その表を書き先とする操作起点のうち、面が名指ししたものが1本以上あるとき、その表への
      // 当該種類の書込は、その起点を `read` できる役割にだけ許す」。
      // **名指しには操作起点の `id` が要るので、下の `views` の4本の操作起点に `id` を足した**
      // (`$defs/view_action.properties.id`。`V8-M17` / `J-G9` が足した9キー目)。
      //
      // **【正直に書く】旧層と同じ範囲ではない** —— **旧層(`audience`)は `id` が無くても
      // 効いていた。** **`product-detail` の「カートに入れる」と `order-detail` の
      // 「取り消しを申し込む」には `id` を書いていないので、面からは1本も名指しできない。**
      // **それでも `cart_line` への作成が運営に対して止まるのは、壁が(表 x 書込の種類)の
      // 単位で立ち、要求がどのボタンから来たかを1バイトも見ないからである**(`ADR-0249` 限定7
      // と同じ形)。**`order_action` には壁が1本も立っていない。**
      //
      // ===================================================================================
      // **【2026-08-10 追記(`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-58` / `D-V8-65`)。
      // 上の段落は「規則を書いていない対象は全許可」を前提に書かれている。その前提は今日から
      // 偽である。旧文は1バイトも消していない】**
      //
      // **既定が「閉じる」側へ倒れた** —— **`table` / `view` / `action` の3対象は、規則を
      // 1本も書いていないと**誰も**触れない(`judgeRoleAccess` の `CLOSED_ROLE_ACCESS`)。
      // **`field`(項目)だけが今日どおり全許可である**(台帳 `T-G1b` = 却下)。
      //
      // **したがって、この参照 EC は「壁を立てたい所にだけ規則を書く」形では成立しなくなった** ——
      // **店として成り立つために必要な許可を、役割ごとに全部書き下す必要がある。**
      // **以下がその全量である。** **「検査を通す最小限」ではなく「本物の EC として正しい
      // 権限」を書いた**(買う人は自分の注文だけ / 運営は商品を管理できる / 未ログインには
      // 商品一覧が見える)。
      //
      // **【未ログイン(`anonymous`)を初めて宣言した】** —— **予約4語の4本目である。**
      // **`anonymous` に書けるのは `read` だけで、項目(`field`)の規則は書けない**
      // (スキーマの `$defs/app/properties/roles/items` の `allOf` 分岐。`J-G11`)。
      // **公開カタログ(商品・カテゴリ)の表と、その4画面だけを開けてある** ——
      // **行の絞り込みは今日どおり `st_public` が行う**(面は「表が開いているか」しか言わない)。
      //
      // **【正直に書く。この規則表には、本物の EC として歪んでいる所が3つある】**
      //  1. **購入者に `order_events`(監査)への書込を許している。** **ワークフロー
      //     `wf-order-audit` / `wf-order-cancel-request` の書き手は購入者本人だからである**
      //     (`resolveWorkflowActor` = `act_as` が無ければトリガー元の行の `st_owner`)。
      //     **監査行を書けるようにするには、購入者が同じ表へ直接 POST できる状態を許すしかない。**
      //     **読取は与えていないので他人の監査行は見えないが、「書けてしまう」ことは塞げていない。**
      //  2. **購入者に `cart_totals` / `order_totals` の書込・削除を許している。** **集計の島は
      //     出力先を全置換する**(既存行を全部消してから書き直す)ので、**書込だけでなく削除も要る。**
      //     **この2表には `st_owner` が無いので `when` で自分の行に絞れない** ——
      //     **購入者は他人の合計行も消せる。塞げていない。**
      //  3. **運営(`owner`)は `cart` / `cart_line` に規則を1本も持たない** —— **本物の EC の
      //     運営は他人の買い物かごを触らないからである。** **その結果、`cart_line` への作成は
      //     「ボタンの壁」に届く前に「表の規則」が止めるようになった**(層が入れ替わった)。
      //     **実測は `checkout-journey.test.ts` の (E-1) / (E-2) / (E-7)。**
      // ===================================================================================
      roles: [
        {
          id: "owner",
          name: "運営",
          rules: [
            // --- **アプリの設定と人の役割**(`V8-M28`。ユーザ決定 `D-V8-59`)-------------
            // **持ち主にはこの2行が必ず要る** —— **適用時検査(`referential-integrity.ts` の
            // 類型17 の拡張)が両方の実在を要求し、片方でも欠けた宣言は拒否される。**
            // **【正直に書く】この2行は今日この参照アプリのふるまいを1ミリも変えない** ——
            // **`POST /diffs` の関門も役割を配る口も、まだこの判定を読んでいない。**
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            // --- 表(運営が管理するもの)-------------------------------------------------
            // **商品カタログとマスタは運営のもの。** 作る・直す・消すを許す。
            { target: "table", table: "category", can: ["read", "write", "delete"] },
            { target: "table", table: "product", can: ["read", "write", "delete"] },
            { target: "table", table: "coupon", can: ["read", "write", "delete"] },
            { target: "table", table: "shipping_method", can: ["read", "write", "delete"] },
            { target: "table", table: "tax_rate", can: ["read", "write", "delete"] },
            // **運営は購入者の注文を読める**(`st_admin_readable` が開いていたのと同じ範囲)。
            // **書込・削除も書いてある** —— **対象を名指しした時点で全動詞が allow-list に
            // なるため、書かないと運営が自分で作った注文すら直せなくなる。**
            { target: "table", table: "order", can: ["read", "write", "delete"] },
            // **注文の周辺は読むだけ。** 合計・受信・履歴は運営が書き換える筋書きが無い。
            { target: "table", table: "order_totals", can: ["read"] },
            { target: "table", table: "wf_runs", can: ["read"] },
            // **決済イベントは読取と書込の両方を書く。** **書込が要るのは、銀行振込のように
            // 決済サービスを通らない入金を運営が手で記録するためである**(参照 EC では
            // `manifest.test.ts` の (j) 群が、この経路で Webhook 相当の1行を入れている)。
            { target: "table", table: "payment_events", can: ["read", "write"] },
            // **監査(`order_events`)は読取と書込の両方を書く。**
            // **書込が要るのは運営自身のためではない** —— **運営が取り消しの申し込みを
            // 代理で作ると `wf-order-cancel-request` が監査行を作り、その書き手は運営だからである。**
            // **書けなければ申し込みの作成そのものが 400 になる**(実測: `E-G56`)。
            { target: "table", table: "order_events", can: ["read", "write"] },
            // **取り消しの申し込みは運営が受け付ける**(`status` を動かすのは運営である)。
            // **【この1本で運営の可視範囲が2表目に広がった。隠さない】** ——
            // **`order_action` は `st_owner` を持つ個人所有の表なので、読取を許した時点で
            // 運営には全員分が見える**(`D-V8-35` の代償)。**着手前は0行だった。**
            { target: "table", table: "order_action", can: ["read", "write"] },
            // **`cart` / `cart_line` / `cart_totals` / `address` / `customer` / `order_line` には
            // 規則を1本も書かない** —— **本物の EC の運営は他人の買い物かごと住所を触らない。**
            // **【正直に書く】`order_line`(注文明細)と `customer`(顧客名簿)が運営から
            // 見えないのは、本物の EC としては壊れている** —— **が、それは着手前からの限界で
            // あり(`eg-reproduction.test.ts` の `E-G55` が固定している)、`V8-M26` が
            // 作ったものではない。** **本タスクはそこを広げていない。**
            //
            // --- 画面 -------------------------------------------------------------------
            { target: "view", view: "catalog-list", can: ["read"] },
            { target: "view", view: "category-list", can: ["read"] },
            { target: "view", view: "product-detail", can: ["read"] },
            { target: "view", view: "category-detail", can: ["read"] },
            { target: "view", view: "product-form", can: ["read"] },
            { target: "view", view: "order-list", can: ["read"] },
            { target: "view", view: "order-detail", can: ["read"] },
            { target: "view", view: "order-receipt", can: ["read"] },
            { target: "view", view: "order-action-list", can: ["read"] },
            { target: "view", view: "order-totals-list", can: ["read"] },
            // --- ボタン -----------------------------------------------------------------
            // **旧 `audience: ["owner"]`(`catalog-list` の「取り扱いをやめる」)の置き直し。**
            // **`run` 形なので書込の壁は1本も立たない**(書き先を持たない。`ADR-0249`
            // §Decision 1 の形 (iv))—— **効くのは手動起動の入口の 403 だけである。**
            { target: "action", view: "catalog-list", action: "archive-product", can: ["read"] },
          ],
        },
        {
          id: "editor",
          name: "編集者",
          // **運営とほぼ同じだが「消せない」。** **`delete` を1本も書いていない。**
          rules: [
            { target: "table", table: "category", can: ["read", "write"] },
            { target: "table", table: "product", can: ["read", "write"] },
            { target: "table", table: "coupon", can: ["read", "write"] },
            { target: "table", table: "shipping_method", can: ["read", "write"] },
            { target: "table", table: "tax_rate", can: ["read", "write"] },
            { target: "table", table: "order", can: ["read", "write"] },
            { target: "table", table: "order_totals", can: ["read"] },
            { target: "table", table: "order_events", can: ["read", "write"] },
            { target: "table", table: "payment_events", can: ["read"] },
            { target: "table", table: "wf_runs", can: ["read"] },
            { target: "table", table: "order_action", can: ["read", "write"] },
            { target: "view", view: "catalog-list", can: ["read"] },
            { target: "view", view: "category-list", can: ["read"] },
            { target: "view", view: "product-detail", can: ["read"] },
            { target: "view", view: "category-detail", can: ["read"] },
            { target: "view", view: "product-form", can: ["read"] },
            { target: "view", view: "order-list", can: ["read"] },
            { target: "view", view: "order-detail", can: ["read"] },
            { target: "view", view: "order-receipt", can: ["read"] },
            { target: "view", view: "order-action-list", can: ["read"] },
            { target: "view", view: "order-totals-list", can: ["read"] },
            // **`catalog-list` の「取り扱いをやめる」は書いていない** —— **棚から商品を
            // 落とすのは運営の判断であり、編集者には出さない。** **編集者は商品の項目を
            // 直せるが、取り扱いを終わらせることはできない。**
          ],
        },
        {
          id: "viewer",
          name: "閲覧者",
          // **読むだけ。** **`write` も `delete` も1本も書いていない。**
          rules: [
            { target: "table", table: "category", can: ["read"] },
            { target: "table", table: "product", can: ["read"] },
            { target: "table", table: "coupon", can: ["read"] },
            { target: "table", table: "shipping_method", can: ["read"] },
            { target: "table", table: "tax_rate", can: ["read"] },
            { target: "table", table: "order", can: ["read"] },
            { target: "table", table: "order_totals", can: ["read"] },
            { target: "table", table: "order_events", can: ["read"] },
            { target: "table", table: "payment_events", can: ["read"] },
            { target: "table", table: "wf_runs", can: ["read"] },
            { target: "table", table: "order_action", can: ["read"] },
            { target: "view", view: "catalog-list", can: ["read"] },
            { target: "view", view: "category-list", can: ["read"] },
            { target: "view", view: "product-detail", can: ["read"] },
            { target: "view", view: "category-detail", can: ["read"] },
            { target: "view", view: "order-list", can: ["read"] },
            { target: "view", view: "order-detail", can: ["read"] },
            { target: "view", view: "order-receipt", can: ["read"] },
            { target: "view", view: "order-action-list", can: ["read"] },
            { target: "view", view: "order-totals-list", can: ["read"] },
          ],
        },
        {
          id: "customer",
          name: "購入者",
          rules: [
            // --- 公開カタログ(買う人は読むだけ)-----------------------------------------
            { target: "table", table: "category", can: ["read"] },
            { target: "table", table: "product", can: ["read"] },
            { target: "table", table: "coupon", can: ["read"] },
            { target: "table", table: "shipping_method", can: ["read"] },
            { target: "table", table: "tax_rate", can: ["read"] },
            // --- 自分のもの(`when` で持ち主に絞る)----------------------------------------
            {
              target: "table",
              table: "customer",
              can: ["read", "write", "delete"],
              when: { field: "st_owner", equals_current_user: true },
            },
            {
              target: "table",
              table: "address",
              can: ["read", "write", "delete"],
              when: { field: "st_owner", equals_current_user: true },
            },
            {
              target: "table",
              table: "cart",
              can: ["read", "write", "delete"],
              when: { field: "st_owner", equals_current_user: true },
            },
            {
              target: "table",
              table: "cart_line",
              can: ["read", "write", "delete"],
              when: { field: "st_owner", equals_current_user: true },
            },
            // **持ち主が自分の行だけ。** **`when` を外すと全員分が見える**(上の代償)。
            //
            // **【`delete` を足した。理由を実測で書く】** **叩き台は `["read", "write"]`
            // だった** —— **その形だと購入者が自分の注文を1件も消せなくなる**
            // (`eg-reproduction.test.ts` の `E-G50/E-G51` と `E-G50 の連鎖` が 403 で落ちた)。
            // **原因は「対象を名指しした時点で、書いていない動詞も含めて allow-list になる」
            // ことである** —— **`owner` の規則が `order` を名指しした時点で `order` の削除は
            // 面の管轄内になり、`delete` を書いていない `customer` は止まる。**
            // **着手前(`st_admin_readable` の時代)は購入者が自分の注文を消せていた**
            // (`E-G52` / `E-G50` が実測として固定している既存の穴である)。
            // **【禁止の履行】これを「安全になった」と書かない** —— **本タスクは挙動を
            // 元に戻しただけであり、消せる穴は今日も開いている。**
            {
              target: "table",
              table: "order",
              can: ["read", "write", "delete"],
              when: { field: "st_owner", equals_current_user: true },
            },
            {
              target: "table",
              table: "order_line",
              can: ["read", "write", "delete"],
              when: { field: "st_owner", equals_current_user: true },
            },
            {
              target: "table",
              table: "order_action",
              can: ["read", "write", "delete"],
              when: { field: "st_owner", equals_current_user: true },
            },
            // --- 自動処理が「購入者として」書く先(**歪んでいる。上の3を見よ**)-------------
            //
            // **`cart_totals` / `order_totals` は集計の島の出力先である。** **全置換なので
            // `write` と `delete` の両方が要る。** **`st_owner` を持たない表なので `when` で
            // 絞れない** —— **購入者は他人の合計行も消せる。塞げていない。**
            { target: "table", table: "cart_totals", can: ["read", "write", "delete"] },
            { target: "table", table: "order_totals", can: ["read", "write", "delete"] },
            // **`order_events` は監査である。** **`wf-order-audit` の書き手は購入者本人なので、
            // 書込を許さないと注文が1件も作れない。** **読取は与えていない**(他人の監査行は
            // 見えない)—— **が、書けてしまうことは塞げていない。**
            { target: "table", table: "order_events", can: ["write"] },
            // --- 画面(買う人の導線)-------------------------------------------------------
            { target: "view", view: "catalog-list", can: ["read"] },
            { target: "view", view: "category-list", can: ["read"] },
            { target: "view", view: "product-detail", can: ["read"] },
            { target: "view", view: "category-detail", can: ["read"] },
            { target: "view", view: "cart-list", can: ["read"] },
            { target: "view", view: "cart-detail", can: ["read"] },
            { target: "view", view: "cart-line-list", can: ["read"] },
            { target: "view", view: "cart-line-form", can: ["read"] },
            { target: "view", view: "checkout-form", can: ["read"] },
            // **`order-list` は購入者の「注文履歴」でもある** —— **`order` を出す一覧は
            // このアプリに1本しか無く、購入者に開けないと自分の注文の一覧が1画面も無い。**
            // **行は `st_owner` が今日どおり絞るので、購入者に見えるのは自分の注文だけである。**
            { target: "view", view: "order-list", can: ["read"] },
            { target: "view", view: "order-detail", can: ["read"] },
            { target: "view", view: "order-receipt", can: ["read"] },
            { target: "view", view: "order-action-form", can: ["read"] },
            // --- ボタン ---------------------------------------------------------------
            // **旧 `audience: ["customer"]` 3本の置き直し。**
            // **`add-to-cart` は `cart_line` への作成の壁**、**`checkout` は `order` への
            // 作成の壁**になる(どちらも遷移の形 = `form` + `prefill` なので書き先を持つ)。
            // **`close-cart` は `run` 形なので壁を立てない**(手動起動の入口だけに効く)。
            { target: "action", view: "catalog-list", action: "add-to-cart", can: ["read"] },
            { target: "action", view: "cart-list", action: "checkout", can: ["read"] },
            { target: "action", view: "cart-list", action: "close-cart", can: ["read"] },
          ],
        },
        {
          id: "anonymous",
          name: "未ログイン",
          // **公開カタログだけ。** **`read` しか書けない**(スキーマが閉じている)。
          // **行の絞り込みは `st_public` が今日どおり行う** —— **面は「表が開いているか」しか
          // 言わないので、非公開の商品はここを通っても1行も出ない。**
          rules: [
            { target: "table", table: "category", can: ["read"] },
            { target: "table", table: "product", can: ["read"] },
            { target: "view", view: "catalog-list", can: ["read"] },
            { target: "view", view: "category-list", can: ["read"] },
            { target: "view", view: "product-detail", can: ["read"] },
            { target: "view", view: "category-detail", can: ["read"] },
          ],
        },
      ],
      views: [
        // --- 公開カタログ(EC-G1 匿名閲覧)----------------------------------------
        {
          id: "catalog-list",
          type: "list_view",
          name: "商品一覧",
          table: "product",
          columns: ["name", "price", "image"],
          // V4-M30 / D-V4-113 はここに逃げ道(任意 CSS)の見本への参照(`custom_css`)を
          // 書いていたが、V4-M33 / D-V4-116(「検査の中だけに残し、店からは取り消す」)で
          // 外した。**この画面はもう custom_css を持たない**(在庫は再び0件に戻る)。
          /**
           * **【`V5-M18` / `L-G1` / `ADR-0171`】一覧の行の操作起点。参照 EC の初例である。**
           *
           * **着手前、このアプリの `actions` は2本とも `detail_view` に在った**
           * (`product-detail` と `order-detail`)—— **一覧の行には1本も無かった。**
           * `ADR-0171` が `list_view` 分岐の `"actions": false,` を解いたので、
           * **「一覧の行から直接カートに入れる」が今日は宣言できる。**
           *
           * **`product-detail` の同じ操作起点を1バイトも消していない** —— 詳細から入れる道は
           * 今日も在る。**足しただけである。**
           *
           * **`audience` は `V5-M23` / `ADR-0177` の見せる相手である。** 運営(owner / editor /
           * viewer)にはこのボタンを出さない。**【禁止】これを権限と読まない** —— 隠れるだけで、
           * 運営が同じ URL を直接叩けば `cart_line` は今日も作れる(`D-V5-88` = 次回に回す)。
           *
           * **【2026-08-10 追記(`V8-M20` / `J-G29` / `ADR-0301`)。直前の段落は今日は二重に
           * 偽である。1バイトも消していない】**
           *  1. **`audience` というキーは今日存在しない。** 出し分けているのは
           *     `app.roles` の `{ target: "action", view: "catalog-list", action: "add-to-cart" }` である。
           *  2. **「隠れるだけ」も今日は偽である** —— **`D-V5-88` は `V5-M28` /`ADR-0249` が
           *     解いており(書込の壁)、その壁は面のボタンの規則として今日も立っている。**
           *     **運営が同じ URL を直接叩くと `cart_line` の作成は 403 になる**
           *     (実測は `checkout-journey.test.ts` の (E-1) / (E-2))。
           */
          actions: [
            {
              // **【`V8-M20` の後始末】面のボタンの規則から名指しするための識別子である。**
              // **旧: `audience: ["customer"]`(この起点が `cart_line` への作成の壁だった)。**
              // **新: `app.roles` の `customer` に
              // `{ target: "action", view: "catalog-list", action: "add-to-cart", can: ["read"] }`。**
              id: "add-to-cart",
              form: "cart-line-form",
              prefill: { field: "product" },
              name: "買い物かごに入れる",
            },
            /**
             * **`V5-M25`(手動起動)を運営の側で使う唯一の当て先である。**
             *
             * **なぜ `order` ではなく `product` なのか** —— **手動起動の入口は
             * 個人所有(`st_owner`)の行を、その行の持ち主以外に対して 404 で伏せる**
             * (`src/server/app.ts:2014` 付近 = `isOwnerVisible(..., actor.id)`。
             * **`st_admin_readable` を1件も見ていない**)。**したがって購入者が作った注文に
             * 対して運営が手動起動を押す導線は、今日は宣言できない**(押せば必ず 404 になる)。
             * **`product` には `st_owner` が無いので、運営が押せる。**
             * **これは本タスクが実測で踏んだものである**(記録 `v5-m18.md` §6-2)。
             */
            {
              // **旧: `audience: ["owner"]`。新: `app.roles` の `owner` に
              // `{ target: "action", view: "catalog-list", action: "archive-product", can: ["read"] }`。**
              id: "archive-product",
              run: "wf-product-archive",
              name: "取り扱いをやめる",
              visible_when: { field: "status", equals: "active" },
            },
          ],
        },
        {
          id: "category-list",
          type: "list_view",
          name: "カテゴリ一覧",
          table: "category",
          columns: ["name", "sort_order"],
        },
        // --- 商品詳細 + 操作起点(EC-G14 カートに入れる)---------------------------
        {
          id: "product-detail",
          type: "detail_view",
          name: "商品詳細",
          table: "product",
          fields: ["name", "description", "price", "image", "stock", "status"],
          // EC-G14(ADR-0045): 「カートに入れる」= cart_line の form へ product を _id プリフィルして遷移。
          actions: [
            { form: "cart-line-form", prefill: { field: "product" }, name: "カートに入れる" },
          ],
        },
        {
          id: "cart-line-form",
          type: "form",
          name: "カートに追加",
          table: "cart_line",
          fields: ["cart", "product", "quantity"],
        },
        /**
         * **V4-M21-T01(`E-G30` / `D-V4-72`): 無効にした明細を出さない一覧。**
         *
         * **`filter` の `not` / `equals`(`ADR-0043`)だけで書いている。** 語彙を1バイトも
         * 増やしていない。**`voided` が `true` でない行だけを出す。**
         *
         * **【なぜ `cart-detail` の関連一覧に書かないのか】** —— **`related` には `filter` を
         * 書けない**(`ADR-0044` 限定2 の逐語「**子一覧に filter キー … を持たせない**」)。
         * **したがって `cart-detail` の「カート明細」には今日も無効行が出る。**
         * **これは本タスクが解いていないことである。隠さない。**
         */
        {
          id: "cart-line-list",
          type: "list_view",
          name: "カートの中身",
          table: "cart_line",
          columns: ["product", "quantity", "unit_price", "line_total"],
          filter: { not: { field: "voided", equals: true } },
        },
        /**
         * **【`V5-M18` / `D-V5-86`】買い物かごの一覧。会計への入口である。**
         *
         * **着手前、`cart` テーブルを出す一覧は1本も無かった**(単票 `cart-detail` だけが在り、
         * そこへ辿り着く導線が宣言に無かった)。**会計を「一覧の行の操作」で起こすには、
         * 行が並ぶ画面が要る。**
         *
         * **`st_owner` が効くので、運営(owner)がこの一覧を開いても0行である**
         * (`ADR-0033`)—— **`order` と違って `cart` には `st_admin_readable` を宣言していない。**
         * **【2026-08-10 追記(`V8-M20` / `J-G30`)。直前の1文の書き方は今日は通じない。
         * 1バイトも消していない】** **`st_admin_readable` は廃止された。** **今日の言い方は
         * 「`order` と違って `cart` には、運営に読取を許す面の規則を1本も書いていない」である。**
         * **結論(運営には0行)は1ミリも変わっていない。**
         * **したがってこの画面は購入者のための画面である。**
         */
        {
          id: "cart-list",
          type: "list_view",
          name: "買い物かご一覧",
          table: "cart",
          columns: ["customer", "status", "created_at"],
          /**
           * **`V5-M21`(一覧の行の操作起点)+ `V5-M24`(URL とプリフィル)の当て先。**
           *
           * 押すと `checkout-form` へ遷移し、**押した行の `_id`** が `order.cart` に入る。
           * 表示層が組む URL は **`?prefill.cart=<cartの_id>`** の1本である
           * (`V5-M24` / `ADR-0178`。`history.state` 経由の運搬は今日1本も無い)。
           *
           * **`visible_when` は行ごとに1回ずつ評価される**(`ADR-0171`)—— 締めた買い物かご
           * (`converted` / `abandoned`)の行にはボタンを出さない。**【禁止】これを
           * 「締めた買い物かごから会計できなくなった」と読まない** —— 隠れるだけである。
           */
          actions: [
            {
              // **旧: `audience: ["customer"]`(この起点が `order` への作成の壁だった)。**
              // **新: `app.roles` の `customer` に
              // `{ target: "action", view: "cart-list", action: "checkout", can: ["read"] }`。**
              id: "checkout",
              form: "checkout-form",
              prefill: { field: "cart" },
              name: "会計に進む",
              visible_when: { field: "status", equals: "open" },
            },
            /**
             * **`V5-M25`(手動起動)を購入者の側で使う当て先。**
             *
             * **`cart` は個人所有(`st_owner`)なので、押せるのはその行を作った本人だけである**
             * —— **表示層が隠す相手と、サーバが 404 で伏せる相手が、ここでは一致する。**
             * **【`V8-M20` / `J-G29`】旧の逐語は「表示層が `audience` で隠す相手と」である** ——
             * **今日隠しているのは面のボタンの規則(`cart-list/close-cart` を `read` できる
             * のは `customer` だけ)であり、サーバの手動起動の入口も同じ規則で 403 を返す。**
             *
             * **【禁止】「二重押しが防げる」と読まない。** 1本目が終わってから押せば2回目も走る
             * (`ADR-0175`)。**2回目を実際に落としているのは、下のワークフローの `when` である。**
             */
            {
              // **旧: `audience: ["customer"]`。新: `app.roles` の `customer` に
              // `{ target: "action", view: "cart-list", action: "close-cart", can: ["read"] }`。**
              id: "close-cart",
              run: "wf-cart-close",
              name: "この買い物かごを締める",
              visible_when: { field: "status", equals: "open" },
            },
          ],
        },
        /**
         * **【`V5-M18` / `D-V5-86`】会計(支払い)の入力画面。本タスクの中心である。**
         *
         * **着手前、このアプリには支払いを人が入力する画面が1本も無かった** ——
         * `payment_events` は外から届く Webhook の受け皿であって、人の入口ではない。
         *
         * **【正直に書く】状態列(`status` / `payment_status`)を人に選ばせている。**
         * カーネルに**既定値を宣言する語彙が無い**ためである(`$defs/field` に `default` は
         * 1本も無い)。**書かなければ空のまま作られ、`order-list` の `filter`
         * (`status` が `pending_payment` か `paid`)に1行も掛からない。** 本物の店なら
         * 「注文は必ず未払いで始まる」と決めたいが、**今日の語彙ではその宣言ができない。**
         * **【禁止】これを「会計画面ができた」で済ませない。**
         *
         * **入力フォームには操作起点(`actions`)を1本も置けない**(`ADR-0171` 限定3。
         * `form` 分岐の `"actions": false,` は今日も1バイトも解かれていない)。
         */
        {
          id: "checkout-form",
          type: "form",
          name: "会計(支払いの入力)",
          table: "order",
          fields: [
            "cart",
            "customer",
            "order_number",
            "shipping_method",
            "payment_method",
            "payment_slip",
            "currency",
            "status",
            "payment_status",
          ],
        },
        // --- カート詳細 + 明細子一覧(EC-G17 related)------------------------------
        {
          id: "cart-detail",
          type: "detail_view",
          name: "カート",
          table: "cart",
          fields: ["customer", "status", "created_at"],
          related: [
            {
              table: "cart_line",
              via: "cart",
              columns: ["product", "quantity", "line_total"],
              name: "カート明細",
            },
          ],
        },
        // --- 注文詳細 + 明細子一覧(EC-G17 related)--------------------------------
        {
          id: "order-detail",
          type: "detail_view",
          name: "注文詳細",
          table: "order",
          fields: ["order_number", "status", "total", "payment_status"],
          related: [
            {
              table: "order_line",
              via: "order",
              columns: ["product", "quantity", "line_total"],
              name: "注文明細",
            },
            // 申し込みの結果が注文の画面で読めること(EC-G17 related。1ホップ)。
            {
              table: "order_action",
              via: "order",
              columns: ["action_type", "status", "requested_at"],
              name: "取り消しの申し込み",
            },
          ],
          // D-V4-23 / V4-M4-T07: **購入者ができるのはここまでである。**
          // 「注文を消す」導線は1本も置かない —— 置いても `DELETE` はサーバが 409 で止める。
          actions: [
            { form: "order-action-form", prefill: { field: "order" }, name: "取り消しを申し込む" },
          ],
        },
        /**
         * **【`V5-M18` / `L-G5` / `ADR-0173`】会計の控え。`order` の2本目の単票である。**
         *
         * **この画面が在ることに意味があるのは、`order-list` の行の「行き先の宣言」の
         * 当て先だからである。** 規約(`resolveDetailViewTarget` = 同テーブルの先頭 `detail_view`)
         * のままなら、`order-list` の行から行くのは**上で先に宣言している `order-detail`** である。
         * **宣言を書くと、その規約とは違う画面へ行ける** —— それが `ADR-0173` の中身である。
         * **宣言の順序に依存する** —— `order-detail` をこの下に移すと規約の行き先が変わる。
         *
         * **`actions` を1本も置いていない。** `detail_view` には**行き先の宣言(形 (iii))を
         * 書けない**(`L-G7` = 却下。`ADR-0173` が残した非対称)。
         */
        {
          id: "order-receipt",
          type: "detail_view",
          name: "会計の控え",
          table: "order",
          fields: [
            "order_number",
            "payment_method",
            "subtotal",
            "discount",
            "shipping_fee",
            "tax",
            "total",
            "payment_status",
            "payment_slip",
          ],
        },
        // --- 注文の取り消し申し込み(D-V4-23 / V4-M4-T07)-----------------------------
        // EC-G14(ADR-0045)と同じ形: 注文詳細から `order` を _id プリフィルして遷移する。
        {
          id: "order-action-form",
          type: "form",
          name: "注文の取り消しを申し込む",
          table: "order_action",
          fields: ["order", "action_type", "reason"],
        },
        {
          id: "order-action-list",
          type: "list_view",
          name: "取り消し申し込み一覧",
          table: "order_action",
          columns: ["order", "action_type", "status", "requested_at"],
        },
        // --- カテゴリ詳細 + 同カテゴリ商品(EC-G17 related。1ホップ)-----------------
        {
          id: "category-detail",
          type: "detail_view",
          name: "カテゴリ詳細",
          table: "category",
          fields: ["name", "slug", "sort_order"],
          related: [
            {
              table: "product",
              via: "category",
              columns: ["name", "price"],
              name: "このカテゴリの商品",
            },
          ],
        },
        // --- 運営一覧(EC-G11 ページネーション / EC-G12 filter の器)-----------------
        {
          id: "order-list",
          type: "list_view",
          name: "注文一覧",
          table: "order",
          columns: ["order_number", "status", "total"],
          // EC-G12(ADR-0043): ブール式 filter。未処理注文を絞る例。
          filter: {
            or: [
              { field: "status", equals: "pending_payment" },
              { field: "status", equals: "paid" },
            ],
          },
          /**
           * **【`V5-M18` / `L-G5` / `ADR-0173`】行き先の宣言(形 (iii))。**
           *
           * 規約(`resolveDetailViewTarget` = 同テーブルの先頭 `detail_view`)なら
           * `order-detail` へ行くところを、宣言で `order-receipt`(会計の控え)へ変える。
           * **押した行の `_id` を運ぶ。**
           *
           * **`audience` を書いていない** —— 会計の控えは、その注文を見られる相手なら
           * 誰でも見てよい。**書かなかった操作起点は今日どおり全員に出る**(`ADR-0177` 限定4)。
           * **【`V8-M20` / `J-G29`】今日の言い方は「識別子(`id`)を書いていないので、面の
           * 規則から名指しできず、今日どおり全員に出る」である**(`canUseAction` の逐語:
           * 「**識別子(`id`)を持たない操作起点は面から名指しできないので、今日どおり出る**」)。
           *
           * **【ここに手動起動を置けなかったことを書く】** **「入金を確認する」を運営が
           * 一覧の行から押す形は、今日は宣言できない。** 手動起動の入口は個人所有
           * (`st_owner`)の行を**持ち主以外に 404 で伏せる**(`src/server/app.ts` の
           * `isOwnerVisible(existing.value[OWNER_FIELD], actor.id)`。**第3引数の
           * `adminReadable` を渡していない**)。**`order` は `st_admin_readable` の宣言に
           * より運営が読めるが、手動起動の経路はその宣言を1件も見ない** ——
           * **【`V8-M20` / `J-G30` / `D-V8-35`】今日の言い方は「`order` は面の規則
           * (`owner` x 表 x 読取)により運営が読めるが、手動起動の経路は
           * `roleReadCrossesOwnerScope` を1度も呼ばない」である。結論は1ミリも変わらない** ——
           * **書けば「必ず 404 になるボタン」になるので置いていない**(`ADR-0086` 限定4)。
           * **実測は `scripts/ref-ec/checkout-journey.test.ts` の (D-2) が持つ。**
           */
          actions: [{ view: "order-receipt", name: "会計の控えを見る" }],
        },
        // --- 運営フォーム --------------------------------------------------------
        {
          id: "product-form",
          type: "form",
          name: "商品登録",
          table: "product",
          fields: [
            "name",
            "description",
            "sku",
            "price",
            "category",
            "image",
            "stock",
            "status",
            PUBLIC_FIELD,
          ],
        },
        // --- 集計の閲覧(EC-G10 集計テーブルは行内でなく別テーブルという findings 3 の可視化)---
        {
          id: "order-totals-list",
          type: "list_view",
          name: "注文合計一覧",
          table: "order_totals",
          columns: ["order", "subtotal", "discount", "shipping_fee", "tax", "total"],
        },
      ],
      functions: [
        // EC-G6 Route B: 行内 line_total(単価×数量)を island で計算し $record へ書き戻す(T02 が中身)。
        {
          id: "fn-line-total",
          name: "明細金額の計算",
          // T02: Route B。単価×数量を1行返し、トリガー元 cart_line/order_line へ write_back する。
          code: LINE_TOTAL_ISLAND,
          input: { source: "record" },
          output: { fields: [{ id: "line_total", type: "number" }] },
        },
        // EC-G10 集計: order_line 全行から注文合計を計算し order_totals へ全置換(T02 が中身)。
        {
          id: "fn-order-totals",
          name: "注文合計の集計",
          // T02: order_line 全行を order で束ね、小計/割引/送料/税/合計を計算し order_totals へ全置換。
          // **V3-M11-T02: 送料・税率・クーポンを島への焼き込みから表の現在値へ移した**
          // (ADR-0062 の配列形。要素4 = order_line + shipping_method + tax_rate + coupon)。
          // ★それでも**注文別クーポンは解けない** —— 鍵(order.coupon)は order テーブルに在り
          //   入力に入っていないうえ、カーネルは参照を1ホップも辿らない(ADR-0062 §限界1/2)。
          //   島が当てられるのは「有効クーポンがちょうど1行のときの店舗共通の一律割引」だけである。
          code: ORDER_TOTALS_ISLAND,
          input: totalsInput("order_line"),
          output: {
            fields: [
              { id: "order", type: "text" },
              { id: "subtotal", type: "number" },
              { id: "discount", type: "number" },
              { id: "shipping_fee", type: "number" },
              { id: "tax", type: "number" },
              { id: "total", type: "number" },
            ],
          },
        },
        // EC-G10 集計: cart_line 全行からカート合計を計算し cart_totals へ全置換(T02 が中身)。
        {
          id: "fn-cart-totals",
          name: "カート合計の集計",
          // T02: cart_line 全行を cart で束ね、小計/割引/送料/税/合計を計算し cart_totals へ全置換。
          // V3-M11-T02: 同上。cart には coupon 参照フィールドが1本も無いので、カート段階では
          // 「この買い物かごのクーポン」という鍵がそもそも存在しない。
          code: CART_TOTALS_ISLAND,
          input: totalsInput("cart_line"),
          output: {
            fields: [
              { id: "cart", type: "text" },
              { id: "subtotal", type: "number" },
              { id: "discount", type: "number" },
              { id: "shipping_fee", type: "number" },
              { id: "tax", type: "number" },
              { id: "total", type: "number" },
            ],
          },
        },
        /**
         * **V4-M21-T01(`E-G30` / `D-V4-72`): 同じ品を2行にしない島。**
         *
         * **`write_ops` モード**(`ADR-0067`)—— 返すのは `update` op だけであり、
         * **行を1つも消さない**(`create` / `update` の2種しか返せない。
         * `src/kernel/batch.ts` を1バイトも触っていない)。
         */
        {
          id: "fn-cart-line-dedupe",
          name: "カート明細の重複をまとめる",
          code: CART_LINE_DEDUPE_ISLAND,
          input: { source: "table", table: "cart_line" },
          output: { ops: true },
        },
      ],
      workflows: [
        // (run_function + write_back / on_create): 行内 line_total を Route B で書く。
        {
          id: "wf-cart-line-total",
          name: "カート明細の金額を計算",
          trigger: { type: "on_create", table: "cart_line" },
          actions: [{ action: "run_function", function: "fn-line-total", write_back: "$record" }],
          history_table: "wf_runs",
        },
        /**
         * **V4-M21-T01(`E-G30` / `D-V4-72`): 同じ品が2行にならないようにする。**
         *
         * **`wf-cart-line-total` の後に置く** —— 先に行内金額(`line_total`)が書かれてから
         * 束ねたいためである(この島は合算後の数量で `line_total` を書き直す)。
         *
         * **【解けないこと】この配線は行を1つも消さない。** 2本目以降には `voided` が
         * 立つだけで、行は DB に残る。**`filter` を書いた一覧からしか消えない。**
         */
        {
          id: "wf-cart-line-dedupe",
          name: "カート明細の重複をまとめる",
          trigger: { type: "on_create", table: "cart_line" },
          actions: [{ action: "run_function", function: "fn-cart-line-dedupe", write_ops: true }],
          history_table: "wf_runs",
        },
        // (call_external + run_function output_table / on_create): 決済要求送信 + 注文合計集計。
        {
          id: "wf-order-checkout",
          name: "注文確定で決済要求を送り合計を集計",
          trigger: { type: "on_create", table: "order" },
          actions: [
            {
              action: "call_external",
              connection: "mock-psp",
              destination: "http://127.0.0.1/mock-psp/charges",
              payload: {
                order_id: "$record._id",
                amount: "$record.total",
                currency: "$record.currency",
              },
            },
            { action: "run_function", function: "fn-order-totals", output_table: "order_totals" },
          ],
          history_table: "wf_runs",
        },
        // (update_record + call_external / on_create): 受信で注文更新 + 確認メール(EC-G5 when / G13 target / G15)。
        {
          id: "wf-payment-received",
          name: "決済イベント受信で注文を確定/失敗にする",
          trigger: { type: "on_create", table: "payment_events" },
          // **【`V8-M21` の後半(台帳 `J-G22a`)で足した1行。理由を実測で書く】**
          //
          // **`V8-M21` が「登録をきっかけに動く処理」に面(役割に束ねた権限)を効かせた。**
          // **`order` は `app.roles` の規則が名指ししている表なので、面の管轄内である** ——
          // **したがってこのワークフローの書き手が「誰でもない」ままだと、決済の受信で
          // 注文を確定できなくなる**(実測: `Path A` / `Path B` / `Path D` と
          // `eg-reproduction` の (j) 群が 400 で落ちた。文面は
          // 「この発火では書き手を特定できません … 止めた層: role」)。
          //
          // **書き手が「誰でもない」になる理由**: **このワークフローのきっかけは受信口が
          // 作る `payment_events` の行であり、その表は `st_owner` を持たない。**
          // **持ち主が無い行がきっかけだと、今日の1本の規則(`act_as` が無ければきっかけを
          // 作った人)は誰にも解決できない。**
          //
          // **直し方は語彙の中に在った** —— **`act_as` に「この人として動く」を書く。**
          // **`$record.order` は決済イベントが指す注文であり、その `st_owner` は購入者である。**
          // **購入者の規則(`order` × 読み書き削除 × 条件「自分の行」)が通すので、
          // 決済の受信は今日どおり注文を確定できる。**
          //
          // **【誇張しない】** **これは「安全になった」ではない** —— **壁が1本立ったので、
          // 誰として書くのかをアプリが宣言する必要が生じただけである。**
          // **宣言を書き忘れたアプリは、今日から静かにではなく **400 で** 止まる。**
          act_as: "$record.order",
          actions: [
            {
              action: "update_record",
              table: "order",
              target: "$record.order",
              // V4-M4-T07: **入金の成立と同時に削除不可を立てる**(ADR-0073)。
              // 値を立てるのは運営が定義したこのワークフローであり、購入者ではない。
              // **boolean のリテラルは書けない**ので、受信レコードの boolean 列を参照する
              // (`payment_events.protect_order`)。**送り手が立てていなければ守られない** ——
              // それが今日の語彙の限界であり、`V4-M4-T07` はそれを隠さずに置いた。
              values: {
                status: "paid",
                payment_status: "paid",
                [UNDELETABLE_FIELD]: "$record.protect_order",
              },
              when: { field: "status", equals: "paid" },
            },
            {
              action: "call_external",
              connection: "mail-gateway",
              destination: "http://127.0.0.1/mail/send",
              payload: { order: "$record.order", amount: "$record.amount" },
              when: { field: "status", equals: "paid" },
            },
            {
              action: "update_record",
              table: "order",
              target: "$record.order",
              values: { status: "failed", payment_status: "failed" },
              when: { field: "status", equals: "failed" },
            },
          ],
          history_table: "wf_runs",
        },
        // (create_record / on_create): 注文監査行を作る。
        {
          id: "wf-order-audit",
          name: "注文作成を監査に残す",
          trigger: { type: "on_create", table: "order" },
          actions: [
            {
              action: "create_record",
              table: "order_events",
              values: { order: "$record._id", event: "created" },
            },
          ],
          history_table: "wf_runs",
        },
        // (create_record / on_create): 取り消しの申し込みを監査に残す(D-V4-23 / V4-M4-T07)。
        // **`order` を1ミリも更新しない。** `D-V4-2` の「購入者ができるのは申し込みまで」を
        // ワークフローの形でも守る —— ここで `order.status = "cancelled"` を書けば、
        // 購入者が実質的に注文の状態を動かせることになり、`ADR-0073` 限定9 を越える。
        {
          id: "wf-order-cancel-request",
          name: "取り消しの申し込みを監査に残す",
          trigger: { type: "on_create", table: "order_action" },
          actions: [
            {
              action: "create_record",
              table: "order_events",
              values: { order: "$record.order", event: "cancel_requested" },
            },
          ],
          history_table: "wf_runs",
        },
        /**
         * **【`V5-M18` / `L-G8` / `ADR-0174`】手動起動のワークフロー(1本目)。参照 EC の初例である。**
         *
         * **`trigger.type: "manual"` は `V5-M25` が足した4値目である**(着手前は
         * `on_create` / `on_update` / `schedule` の3値)。**`trigger.table` は必須で、
         * 意味は「押した行が乗っている表」である。** **`cart-list` の `table` と一致していないと
         * 適用時に落ちる。**
         *
         * **外部への送信を1つも含まない** —— 含めると適用時に落ちる(`ADR-0174` 限定5)。
         * したがって **`wf-order-checkout` の `call_external` も `wf-order-enrich` の
         * `ai_transform` も、`manual` のワークフローには1つも入れられない。**
         * **「締めたら決済サービスに知らせる」は今日の語彙では書けない。**
         *
         * **`when`(`status` が `open`)がサーバ側の歯止めである** —— 一覧の `visible_when` は
         * ボタンを隠すだけで、押せる相手が入口を直接叩けば走る。**2回目を実際に落として
         * いるのはこの `when` である。**
         */
        {
          id: "wf-cart-close",
          name: "買い物かごを締める",
          trigger: { type: "manual", table: "cart" },
          actions: [
            {
              action: "update_record",
              table: "cart",
              // ADR-0040 の正規形 (i): 押した行そのものを更新する。
              target: "$record._id",
              values: { status: "converted" },
              when: { field: "status", equals: "open" },
            },
          ],
          history_table: "wf_runs",
        },
        /**
         * **手動起動のワークフロー(2本目)。運営が押せる唯一の当て先である。**
         *
         * **`product` には `st_owner` が無い** —— だから運営が押せる。**個人所有の表
         * (`order` / `cart` / `cart_line` / `order_action`)の行に対して、持ち主でない
         * 運営が手動起動を押す導線は今日は宣言できない**(押せば必ず 404。
         * `catalog-list` の操作起点のコメントに実測の根拠を書いた)。
         *
         * **状態を `archived` にするだけで、行を1件も消さない。** カーネルの
         * `update_record` は削除の手段を1つも持たない。
         */
        {
          id: "wf-product-archive",
          name: "取り扱いをやめる",
          trigger: { type: "manual", table: "product" },
          actions: [
            {
              action: "update_record",
              table: "product",
              target: "$record._id",
              values: { status: "archived" },
              when: { field: "status", equals: "active" },
            },
          ],
          history_table: "wf_runs",
        },
        // (ai_transform / on_update): 注文補足文を機能内 AI で書き戻す(capability は実行時照合)。
        {
          id: "wf-order-enrich",
          name: "注文の補足文を生成",
          trigger: { type: "on_update", table: "order" },
          actions: [
            {
              action: "ai_transform",
              capability: "ai-copywriter",
              prompt: "注文の状態から丁寧な補足文を1文で書いてください",
              input: { status: "$record.status" },
              output_field: "note",
              fallback: "ご注文ありがとうございます",
            },
          ],
          history_table: "wf_runs",
        },
        // (schedule / run_function output_table): 定時にカート合計を再集計する。
        {
          id: "wf-totals-sweep",
          name: "カート合計の定時再集計",
          trigger: { type: "schedule", at: { hour: 3, minute: 0 } },
          actions: [
            { action: "run_function", function: "fn-cart-totals", output_table: "cart_totals" },
          ],
          history_table: "wf_runs",
        },
        // (schedule + trigger.table + trigger.older_than / update_record): 滞留注文の打ち切り。
        // D-G16a(ADR-0063 = 時刻起点の行選択)と D-G16b(ADR-0064 = 経過時間の述語)を
        // **参照 EC に初めて当てる**(V3-M11-T03)。V3-M10 は D-M10-3 により scripts/ref-ec/ を
        // 1バイトも使わなかったので、ここが実地の初例である。
        //
        // **上の wf-totals-sweep を1バイトも書き換えていない** —— 行を1件も列挙しない
        // schedule(トリガー元レコード無しで1回だけ実行する形)は今日どおり在り、
        // 本ワークフローはその隣に**足した**ものである。
        //
        // **測るのは `placed_at` からの経過であって、状態が変わってからの経過ではない。**
        // したがってこれは「3日間 pending_payment の**まま**の注文を打ち切る」ではなく、
        // 「**注文されてから**3日経った注文のうち、発火した時点で pending_payment のものを
        // 打ち切る」である(ADR-0064 §限界1。「まま」は今日の語彙では表現できない)。
        //
        // AND は述語の結合ではなく**2層の合成**で得ている(ADR-0064 限定2):
        //   (P1) 注文日時から3日以上経った行  … trigger.older_than が**行**を絞る
        //   (P2) 状態が pending_payment である … action.when の等値1形が**アクション**を絞る
        // この2層は非対称である —— (P2) で落ちた行は履歴にスキップとして残るが、
        // (P1) で落ちた行は履歴に1文字も現れない(ADR-0063 限定4 が避けた
        // 「行数に比例する履歴」に戻らないための代償。V3-M10-T02 §7-1)。
        //
        // **在庫は1も戻らない。**このワークフローが書くのは order.status の1列だけであり、
        // 打ち切った注文の明細が押さえた在庫を戻す手段は今日のカーネル語彙に無い
        // (D-G15 は保留3回目で実装0バイト。ADR-0065)。
        //
        // **走るのは毎日1回である**($defs/schedule_at は hour / minute の2キーのまま。
        // 「滞留してから即座に」ではなく「翌朝の 04:00 に」である)。
        {
          id: "wf-stale-order-sweep",
          name: "滞留した注文を毎朝打ち切る",
          trigger: {
            type: "schedule",
            at: { hour: 4, minute: 0 },
            // D-G16a: 発火時に order の行を1件ずつトリガー元レコードとして処理する。
            table: "order",
            // D-G16b: そのうち placed_at が3日以上前の行だけに絞る。
            // **_created_at / _updated_at を指さない** —— 指すと ADR-0064 再審査条件 (e)
            // が発火し、門A が要る(V3-M11-T00 §3-4)。placed_at は order に実在する
            // `date` 型のユーザ定義フィールドである(manifest.ts の order 定義)。
            older_than: { field: "placed_at", days: 3 },
          },
          // **アクションは1本だけ。**複数にすると ADR-0063 再審査条件 (f)(アクションごとに
          // 違う行集合)の射程に近づく(V3-M11-T00 §3-3 の推奨)。
          actions: [
            {
              action: "update_record",
              table: "order",
              // ADR-0040 の正規形 (i): $record._id(トリガー元の行そのものを更新する)。
              target: "$record._id",
              values: { status: "cancelled" },
              when: { field: "status", equals: "pending_payment" },
            },
          ],
          history_table: "wf_runs",
        },
      ],
    },
  };
}
