/**
 * V3-M7-T03 の実証スクリプト⑤(判定81件の機械可読版の生成)。**テストではない。**
 *
 * ## なぜ `web/e2e/` の外に、`*.test.ts` / `*.spec.ts` 以外の名前で置くのか
 *
 * t03-escape.ts / t03-probe.ts / t03-history.ts / t03-cards.ts と同じ理由
 * (`docs/plan/v3/records/v3-m7.md` §2 の T03 完了条件7)。
 *
 * ## 何をするか
 *
 * **判定の根拠に書く数値を、手で打たずに `t03-measurements.json` から引く。**
 * 本ファイルが持つのは「どの要求を、どの計測点の、どのプロパティで判定したか」という
 * 対応表と判定値だけであり、**値そのものは1つも書かれていない**(捏造を構造で防ぐ)。
 *
 * 分母は [`v3-m7-t02.md`](../../docs/plan/v3/records/v3-m7-t02.md) §8 の**未到達81件**である。
 * **到達9件は分母に入れない**(逃げ道を使わずに既に到達しているため)。
 *
 * 使い方: bun run scripts/cp-v3/t03-verdicts.ts <outDir>
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , outDir] = process.argv;
if (outDir === undefined) {
  throw new Error("usage: t03-verdicts.ts <outDir>");
}

type Ref = { screen: string; mode?: string; probe: string; props: string[] };
type Row = {
  id: string;
  /** T02 が付けた未到達の理由の群。 */
  group: string;
  /** 逃げ道を当てた後の判定。 */
  verdict: "到達" | "未到達";
  /** どの資産がこの要求を運んだか(未到達なら "—")。 */
  asset: string;
  /** 判定の根拠になる計測点。 */
  refs: Ref[];
  note: string;
};

const ROWS: Row[] = [
  {
    id: "M7-R01",
    group: "G1",
    verdict: "到達",
    asset: "共通(全18資産)",
    refs: [
      {
        screen: "catalog-list",
        probe: "app-header-h2",
        props: ["white-space", "text-overflow", "font-size", "height"],
      },
    ],
    note: "折り返しを止め、はみ出しを省略記号にした。",
  },
  {
    id: "M7-R02",
    group: "G10",
    verdict: "未到達",
    asset: "—",
    refs: [
      { screen: "catalog-list", mode: "meta", probe: "#title", props: ["#text"] },
      { screen: "app-home", mode: "meta", probe: "#title", props: ["#text"] },
    ],
    note: "ブラウザのタブの見出しは文書の外の要素であり、CSS に当てる先が1つも無い。",
  },
  {
    id: "M7-R03",
    group: "G7",
    verdict: "到達",
    asset: "共通(全18資産)",
    refs: [
      {
        screen: "catalog-list",
        probe: "app-header-h2::before",
        props: ["content", "width", "height", "background-image"],
      },
    ],
    note: "疑似要素の背景にデータURIの図像を置いた。**画像ファイルを取り込んだのではない**(外部URLは配信されない)。",
  },
  {
    id: "M7-R04",
    group: "G1",
    verdict: "到達",
    asset: "共通(全18資産)",
    refs: [
      { screen: "catalog-list", probe: "nav-ul", props: ["display"] },
      { screen: "catalog-list", mode: "hover", probe: "nav-ul", props: ["display"] },
    ],
    note: "ふだんは畳み、ポインタを乗せたときだけ開く。**開閉の状態を保持する手段は無い**(:hover / :focus-within だけ)。",
  },
  {
    id: "M7-R05",
    group: "G7",
    verdict: "到達",
    asset: "共通(全18資産)",
    refs: [
      { screen: "catalog-list", probe: "nav-li-1::before", props: ["content", "font-weight"] },
      { screen: "catalog-list", probe: "nav-li-12::before", props: ["content"] },
    ],
    note: "**並びの位置(nth-child)で区切っている。** 画面を1本足すと見出しの位置がずれる。意味で束ねてはいない。",
  },
  {
    id: "M7-R06",
    group: "G1",
    verdict: "到達",
    asset: "screen-catalog-list",
    refs: [
      {
        screen: "catalog-list",
        probe: "nav-current",
        props: ["font-weight", "background-color", "border-left-width"],
      },
    ],
    note: "**画面ごとに別の資産が要る** —— どれが「いま開いている画面」かは href で書き分けるしかない。1画面ぶんだけ実測した。",
  },
  {
    id: "M7-R07",
    group: "G1",
    verdict: "到達",
    asset: "共通(全18資産)",
    refs: [
      { screen: "catalog-list", probe: "view-list", props: ["position", "width", "rect.x"] },
      { screen: "catalog-list", probe: "list-view", props: ["rect.x", "rect.y"] },
    ],
    note: "入口を左の縦帯に固定し、本文が画面の上から始まるようにした。",
  },
  {
    id: "M7-R08",
    group: "G1",
    verdict: "到達",
    asset: "共通(全18資産)",
    refs: [
      {
        screen: "catalog-list",
        probe: "app-header-button",
        props: ["font-size", "background-color", "opacity"],
      },
    ],
    note: "6つのボタン全部に等しく当たる。**運営者向けの1つだけを選ぶ手段は class では無く data-testid しかない**(本実証は全部を控えめにした)。",
  },
  {
    id: "M7-R09",
    group: "G1",
    verdict: "到達",
    asset: "共通(全18資産)",
    refs: [{ screen: "catalog-list", probe: "link", props: ["color", "text-decoration-line"] }],
    note: "",
  },
  {
    id: "M7-R10",
    group: "G1",
    verdict: "到達",
    asset: "共通(全18資産)",
    refs: [
      { screen: "catalog-list", probe: "app-header-h2", props: ["font-size"] },
      { screen: "catalog-list", probe: "view-title", props: ["font-size"] },
      { screen: "catalog-list", probe: "td-name", props: ["font-size"] },
      { screen: "catalog-list", probe: "list-total", props: ["font-size"] },
    ],
    note: "見出し32px / 画面名22.4px / 本文16px / 注記12.8px に開いた。",
  },
  {
    id: "M7-R11",
    group: "G1",
    verdict: "到達",
    asset: "screen-catalog-list",
    refs: [{ screen: "catalog-list", probe: "shell", props: ["max-width", "width"] }],
    note: "**ADR-0055 §限界2 が予告した抜け道の実測である** —— `.shell` は `.app-theme` の外側にあり、既定の書き方では届かない。`:root:has(&)` の形で外へ出た。**限定13(逃げ道は .app-theme の内側)は、既定の書き方でしか守られていない。**",
  },
  {
    id: "M7-R15",
    group: "G1",
    verdict: "到達",
    asset: "共通(全18資産)",
    refs: [
      {
        screen: "catalog-list",
        mode: "dark",
        probe: "app-theme",
        props: ["background-color", "color"],
      },
      { screen: "catalog-list", mode: "dark", probe: "link", props: ["color"] },
    ],
    note: "`@media (prefers-color-scheme: dark)` を CSS に書いた。**マニフェストの語彙には今日も置き場が無く、AI は書けない**(ADR-0046 限定5 / ADR-0055 §限界6 の3文を1文に丸めないこと)。",
  },
  {
    id: "M7-R16",
    group: "G7",
    verdict: "未到達",
    asset: "—",
    refs: [{ screen: "catalog-list", probe: "summary-box", props: [] }],
    note: "枠そのものは疑似要素で置けるが、要求が求めているのは**未入金・発送待ちの件数**である。CSS は値を1つも読めない。",
  },
  {
    id: "M7-R17",
    group: "G7",
    verdict: "到達",
    asset: "共通(全18資産)",
    refs: [
      {
        screen: "catalog-list",
        probe: "section::after",
        props: ["content", "background-color", "border-top-width"],
      },
    ],
    note: "帯の文言は CSS の中に書いた固定の文字列である。**マニフェストにも `_changelog` にも中身は載らない。**",
  },
  {
    id: "M7-R18",
    group: "G1",
    verdict: "到達",
    asset: "一覧の15資産",
    refs: [{ screen: "catalog-list", probe: "th-0", props: ["background-color"] }],
    note: "",
  },
  {
    id: "M7-R19",
    group: "G1",
    verdict: "到達",
    asset: "一覧の15資産",
    refs: [{ screen: "catalog-list", probe: "tr-1", props: ["background-color"] }],
    note: "",
  },
  {
    id: "M7-R21",
    group: "G1",
    verdict: "到達",
    asset: "screen-catalog-list",
    refs: [
      {
        screen: "catalog-list",
        probe: "td-image-empty",
        props: ["display", "width", "height", "border-top-style"],
      },
    ],
    note: "**枠を出しただけである。** 写真そのものは1枚も入っていない(値が未設定であることは変わらない)。",
  },
  {
    id: "M7-R22",
    group: "G1",
    verdict: "到達",
    asset: "screen-catalog-cards(別の版)",
    refs: [],
    note: "**別の資産に差し替えて実測した**(`t03-cards.json`)。表の器を札の並びに組み替えられた。**ただし1画面に当てられる逃げ道は1つだけなので、札の版では M7-R18 / R19 / R25 と共通のシェル指定が全部消えた。** 同時には成り立たない。",
  },
  {
    id: "M7-R23",
    group: "G1",
    verdict: "未到達",
    asset: "—",
    refs: [{ screen: "catalog-list", probe: "tr-0-cursor", props: ["cursor"] }],
    note: "どこを押したときにどこへ遷移するかは挙動であり、CSS に当てるプロパティが1つも無い。",
  },
  {
    id: "M7-R24",
    group: "G9",
    verdict: "到達",
    asset: "一覧の15資産",
    refs: [{ screen: "catalog-list", probe: "td-image-empty", props: ["color", "font-size"] }],
    note: "**【裁定14 の対象。線10 の実例である】** 逃げ道はコントラスト検査を通らない。同じ色 `#bdb5a8` をテーマのスロットに書くと `dry_run_diff` が拒否する(`t03-history.json` の `contrast_check`。比 1.95:1 / 1.66:1)。**逃げ道は検査を迂回した。**",
  },
  {
    id: "M7-R26",
    group: "G4",
    verdict: "未到達",
    asset: "—",
    refs: [{ screen: "variant-list", probe: "td-price", props: ["#text"] }],
    note: "数の書式は描画される文字列そのものであり、CSS は文字列を書き換えられない。",
  },
  {
    id: "M7-R27",
    group: "G4",
    verdict: "到達",
    asset: "screen-variant-list",
    refs: [{ screen: "variant-list", probe: "td-price::after", props: ["content"] }],
    note: "**添えただけである。** 疑似要素の文字は選択もコピーもされにくく、値そのものは1バイトも変わっていない。",
  },
  {
    id: "M7-R28",
    group: "G5",
    verdict: "未到達",
    asset: "—",
    refs: [{ screen: "variant-list", probe: "td-stock", props: ["color", "#text"] }],
    note: "在庫が0かどうかは DOM の属性に出ていない。CSS は値を読めない。",
  },
  {
    id: "M7-R29",
    group: "G3",
    verdict: "未到達",
    asset: "—",
    refs: [{ screen: "variant-list", probe: "tr-1", props: ["#text"] }],
    note: "並び順はビュー定義(sort)であり、CSS の order で入れ替えても行の中身の対応は変わらない。「商品ごとにまとめる」ための値も読めない。",
  },
  {
    id: "M7-R30",
    group: "G4",
    verdict: "未到達",
    asset: "—",
    refs: [{ screen: "variant-list", probe: "td-status", props: ["#text"] }],
    note: "値を別の言葉に置き換えるには値を読む必要がある。",
  },
  {
    id: "M7-R31",
    group: "G3",
    verdict: "未到達",
    asset: "—",
    refs: [{ screen: "variant-list", probe: "tr-1", props: ["#text"] }],
    note: "列の集合の変更(columns)とデータの整理が要る。",
  },
  {
    id: "M7-R32",
    group: "G1",
    verdict: "到達",
    asset: "screen-admin-order-list",
    refs: [
      {
        screen: "admin-order-list",
        probe: "td-status-span",
        props: ["display", "background-color", "border-radius", "font-size"],
      },
    ],
    note: "**札の形にはできたが、色は1色である。** 状態ごとに色を変えるには値を読む必要があり、それはできていない。",
  },
  {
    id: "M7-R33",
    group: "G5",
    verdict: "未到達",
    asset: "—",
    refs: [{ screen: "admin-order-list", probe: "td-payment-0", props: ["color", "#text"] }],
    note: "M7-R28 と同じ理由。",
  },
  {
    id: "M7-R34",
    group: "G7",
    verdict: "未到達",
    asset: "—",
    refs: [{ screen: "admin-order-list", probe: "filter-box", props: [] }],
    note: "CSS は入力の口を作れない。疑似要素は文字と図形だけである。",
  },
  {
    id: "M7-R35",
    group: "G1",
    verdict: "到達",
    asset: "screen-admin-order-list",
    refs: [{ screen: "admin-order-list", probe: "td-total", props: ["font-weight", "font-size"] }],
    note: "",
  },
  {
    id: "M7-R36",
    group: "G2",
    verdict: "到達",
    asset: "screen-admin-order-list",
    refs: [
      {
        screen: "admin-order-list",
        probe: "list-total",
        props: ["position", "font-size", "rect.x", "rect.y"],
      },
      { screen: "admin-order-list", probe: "view-title", props: ["rect.y"] },
    ],
    note: "**座標で置いた。** 見出しの横に見えるのは、見出しの高さと余白が今のままである限りである。",
  },
  {
    id: "M7-R37",
    group: "G3",
    verdict: "到達",
    asset: "screen-admin-order-line-list",
    refs: [
      { screen: "admin-order-line-list", probe: "td-order-id", props: ["display"] },
      { screen: "admin-order-line-list", probe: "th-1", props: ["display", "#text"] },
    ],
    note: "**見えなくしただけである。** 値は DOM に載ったままで、選択もコピーもできる。マニフェストの `columns` は1つも変わっていない。",
  },
  {
    id: "M7-R38",
    group: "G7",
    verdict: "到達",
    asset: "screen-address-list",
    refs: [{ screen: "address-list", probe: "list-empty::after", props: ["content"] }],
    note: "1件も無いときの一文の後ろに案内を足した。**行を1行も投入していない**(T02 の判断を継承)。",
  },
  {
    id: "M7-R39",
    group: "G7",
    verdict: "到達",
    asset: "screen-address-list",
    refs: [
      {
        screen: "address-list",
        probe: "list-empty::before",
        props: ["content", "width", "height", "background-image"],
      },
    ],
    note: "データURIの図像である。",
  },
  {
    id: "M7-R40",
    group: "G2",
    verdict: "未到達",
    asset: "—",
    refs: [{ screen: "wf-run-list", probe: "field-long-text", props: ["#text"] }],
    note: "**切り詰めはサーバ側で済んでいる** —— DOM に載っているのが既に「…」付きの短い文字列であり、CSS では復元できない。",
  },
  {
    id: "M7-R41",
    group: "G4",
    verdict: "未到達",
    asset: "—",
    refs: [{ screen: "wf-run-list", probe: "td-ran-at", props: ["#text"] }],
    note: "",
  },
  {
    id: "M7-R42",
    group: "G5",
    verdict: "未到達",
    asset: "—",
    refs: [{ screen: "wf-run-list", probe: "td-status", props: ["color", "#text"] }],
    note: "",
  },
  {
    id: "M7-R43",
    group: "G4",
    verdict: "未到達",
    asset: "—",
    refs: [{ screen: "payment-event-list", probe: "td-order", props: ["#text"] }],
    note: "",
  },
  {
    id: "M7-R45",
    group: "G6",
    verdict: "到達",
    asset: "screen-admin-unpaid-order-list",
    refs: [
      { screen: "admin-unpaid-order-list", probe: "app-theme", props: ["background-color"] },
      { screen: "catalog-list", probe: "app-theme", props: ["background-color"] },
    ],
    note: "**逃げ道は画面ごとに書ける** —— テーマがアプリ単位であることの回避になっている。",
  },
  {
    id: "M7-R46",
    group: "G7",
    verdict: "到達",
    asset: "screen-cart-totals-list",
    refs: [
      {
        screen: "cart-totals-list",
        probe: "list-view::before",
        props: ["content", "background-color"],
      },
    ],
    note: "",
  },
  {
    id: "M7-R47",
    group: "G4",
    verdict: "未到達",
    asset: "—",
    refs: [
      { screen: "tax-rate-list", probe: "td-rate", props: ["#text"] },
      { screen: "tax-rate-list", probe: "td-rate::after", props: ["content"] },
    ],
    note: "「%」を添えることはできるが、要求は 0.1 を 10% にすることである。**数の変換は CSS にできない。** 添えるだけだと 0.1% になって嘘になるので、当てていない。",
  },
  {
    id: "M7-R48",
    group: "G4",
    verdict: "未到達",
    asset: "—",
    refs: [{ screen: "shipping-method-list", probe: "td-free-over", props: ["#text"] }],
    note: "複数の欄の値を1つの文にまとめるには値を読む必要がある。",
  },
  {
    id: "M7-R49",
    group: "G4",
    verdict: "未到達",
    asset: "—",
    refs: [{ screen: "coupon-list", probe: "td-discount-type", props: ["#text"] }],
    note: "",
  },
  {
    id: "M7-R50",
    group: "G5",
    verdict: "未到達",
    asset: "—",
    refs: [{ screen: "coupon-list", probe: "td-is-active", props: ["#text"] }],
    note: "期間との比較が要る。",
  },
  {
    id: "M7-R51",
    group: "G1",
    verdict: "未到達",
    asset: "—",
    refs: [{ screen: "category-list", probe: "td-parent-1", props: ["padding-left"] }],
    note: "字下げの深さは親子関係から決まる。DOM に深さが出ていないので CSS では決められない。",
  },
  {
    id: "M7-R52",
    group: "G4",
    verdict: "未到達",
    asset: "—",
    refs: [{ screen: "order-action-list", probe: "td-order", props: ["#text"] }],
    note: "",
  },
  {
    id: "M7-R55",
    group: "G2",
    verdict: "未到達",
    asset: "—",
    refs: [{ screen: "product-detail", probe: "field-long-text", props: ["#text"] }],
    note: "M7-R40 と同じ。切り詰めはサーバ側で済んでいる。",
  },
  {
    id: "M7-R56",
    group: "G1",
    verdict: "未到達",
    asset: "—",
    refs: [{ screen: "product-detail", probe: "field-image", props: [] }],
    note: "写真の要素が0件のままである。**逃げ道は要素を足せない**(疑似要素の背景で図像は置けるが、それはレコードの写真ではない)。",
  },
  {
    id: "M7-R57",
    group: "G7",
    verdict: "到達",
    asset: "screen-product-detail",
    refs: [
      { screen: "product-detail", probe: "field-name::before", props: ["content", "font-weight"] },
      { screen: "product-detail", probe: "field-status::before", props: ["content"] },
    ],
    note: "**項目の並びは変えていない。** 特定の項目の前に見出しを差し込んだだけであり、束ねてはいない。",
  },
  {
    id: "M7-R59",
    group: "G4",
    verdict: "未到達",
    asset: "—",
    refs: [{ screen: "product-detail", probe: "dd-st-public", props: ["#text"] }],
    note: "真偽の値が DOM の属性に出ていない。",
  },
  {
    id: "M7-R60",
    group: "G1",
    verdict: "到達",
    asset: "screen-product-detail",
    refs: [
      {
        screen: "product-detail",
        probe: "btn-delete",
        props: ["background-color", "color", "font-weight"],
      },
      { screen: "product-detail", probe: "btn-edit", props: ["background-color"] },
    ],
    note: "`data-testid` で1つだけを選べた。**製品側の属性に依存している** —— 属性名が変われば効かなくなる。",
  },
  {
    id: "M7-R61",
    group: "G7",
    verdict: "未到達",
    asset: "—",
    refs: [{ screen: "product-detail", probe: "detail-actions-top", props: [] }],
    note: "同じボタンを2箇所に出すには要素を複製する必要がある。CSS にはできない(`position: sticky` で常に見えるようにする回避はあるが、要求は「上にも置く」である)。",
  },
  {
    id: "M7-R62",
    group: "G3",
    verdict: "到達",
    asset: "screen-admin-order-detail",
    refs: [{ screen: "admin-order-detail", probe: "field-order-id", props: ["display"] }],
    note: "M7-R37 と同じく**見えなくしただけ**である。値は DOM に載ったままである。",
  },
  {
    id: "M7-R63",
    group: "G1",
    verdict: "到達",
    asset: "screen-admin-order-detail",
    refs: [
      { screen: "admin-order-detail", probe: "field-subtotal", props: ["background-color"] },
      {
        screen: "admin-order-detail",
        probe: "field-total",
        props: ["background-color", "border-top-width"],
      },
      {
        screen: "admin-order-detail",
        probe: "dd-total",
        props: ["font-weight", "font-size", "color"],
      },
    ],
    note: "",
  },
  {
    id: "M7-R64",
    group: "G7",
    verdict: "到達",
    asset: "screen-admin-order-detail",
    refs: [
      {
        screen: "admin-order-detail",
        probe: "field-status",
        props: ["order", "background-color", "rect.y"],
      },
      { screen: "admin-order-detail", probe: "field-payment", props: ["order", "rect.y"] },
      { screen: "admin-order-detail", probe: "field-order-number", props: ["rect.y"] },
    ],
    note: "grid の `order` で先頭へ動かした。**読み上げの順序は変わっていない**(DOM の順序はそのままである)。",
  },
  {
    id: "M7-R65",
    group: "G1",
    verdict: "到達",
    asset: "screen-admin-order-detail",
    refs: [
      { screen: "admin-order-detail", mode: "print", probe: "app-header", props: ["display"] },
      { screen: "admin-order-detail", mode: "print", probe: "detail-actions", props: ["display"] },
      {
        screen: "admin-order-detail",
        mode: "print",
        probe: "detail-view::before",
        props: ["content"],
      },
      { screen: "admin-order-detail", mode: "print", probe: "detail-fields", props: ["display"] },
    ],
    note: "`@media print` を書いた。**実際に紙に出していない** —— 測ったのは chromium の印刷媒体の計算後スタイルである。",
  },
  {
    id: "M7-R66",
    group: "G3",
    verdict: "未到達",
    asset: "—",
    refs: [
      { screen: "category-detail", probe: "related-th-0", props: ["#text"] },
      { screen: "category-detail", probe: "related-img", props: [] },
    ],
    note: "子一覧の列はビュー定義であり、CSS では列を増やせない。",
  },
  {
    id: "M7-R67",
    group: "G1",
    verdict: "到達",
    asset: "screen-variant-detail",
    refs: [
      {
        screen: "variant-detail",
        probe: "btn-cart",
        props: ["background-color", "color", "font-size", "font-weight"],
      },
      { screen: "variant-detail", probe: "btn-edit", props: ["background-color"] },
    ],
    note: "",
  },
  {
    id: "M7-R68",
    group: "G4",
    verdict: "未到達",
    asset: "—",
    refs: [{ screen: "variant-detail", probe: "dd-stock::after", props: ["content"] }],
    note: "「在庫あり」「残りわずか」は値による分岐である。",
  },
  {
    id: "M7-R69",
    group: "G1",
    verdict: "到達",
    asset: "screen-order-form",
    refs: [
      {
        screen: "order-form",
        probe: "record-form",
        props: ["display", "grid-template-columns", "height"],
      },
    ],
    note: "**入力フォームにはプリセットが1軸も書けない**(ADR-0050)。逃げ道はフォームにも当たる。縦は 1419.98px → 1075.72px に縮んだ。",
  },
  {
    id: "M7-R70",
    group: "G1",
    verdict: "到達",
    asset: "screen-order-form",
    refs: [
      { screen: "order-form", probe: "input-order-number", props: ["width"] },
      { screen: "order-form", probe: "input-currency", props: ["width"] },
      { screen: "order-form", probe: "input-placed-at", props: ["width"] },
    ],
    note: "項目ごとに幅を書き分けた。**`:has()` で項目名の `data-testid` を辿っている**(製品側の属性に依存する)。",
  },
  {
    id: "M7-R71",
    group: "G7",
    verdict: "到達",
    asset: "screen-order-form",
    refs: [
      { screen: "order-form", probe: "field-order-number::before", props: ["content"] },
      { screen: "order-form", probe: "field-ship-to::before", props: ["content"] },
    ],
    note: "M7-R57 と同じく、束ねてはいない(見出しを差し込んだだけ)。",
  },
  {
    id: "M7-R72",
    group: "G2",
    verdict: "到達",
    asset: "screen-order-form",
    refs: [
      {
        screen: "order-form",
        probe: "required-0",
        props: ["font-size", "background-color", "color", "border-radius"],
      },
    ],
    note: "",
  },
  {
    id: "M7-R73",
    group: "G4",
    verdict: "到達",
    asset: "screen-order-form",
    refs: [{ screen: "order-form", probe: "field-total::after", props: ["content"] }],
    note: "**入力欄の外に添えただけである。** 入力された値には単位が付かない。",
  },
  {
    id: "M7-R74",
    group: "G4",
    verdict: "未到達",
    asset: "—",
    refs: [{ screen: "order-form", probe: "input-placed-at", props: ["width"] }],
    note: "日付入力欄の年月日の並びは UA が決める。CSS に当てるプロパティが1つも無い(幅は変えられたが並びは変わらない)。",
  },
  {
    id: "M7-R75",
    group: "G1",
    verdict: "到達",
    asset: "screen-order-form",
    refs: [
      {
        screen: "order-form",
        probe: "submit",
        props: ["position", "font-size", "width", "background-color"],
      },
    ],
    note: "`position: sticky` で画面の下に貼り付けた。",
  },
  {
    id: "M7-R76",
    group: "G7",
    verdict: "未到達",
    asset: "—",
    refs: [{ screen: "order-form", probe: "buttons", props: [] }],
    note: "疑似要素で「やめる」という文字は置けるが、押せる導線にはならない。ボタンの数は1件のままである。",
  },
  {
    id: "M7-R77",
    group: "G4",
    verdict: "未到達",
    asset: "—",
    refs: [{ screen: "cart-line-form", probe: "select-variant", props: ["#text"] }],
    note: "選択肢の文字列はデータであり、CSS では変えられない。",
  },
  {
    id: "M7-R78",
    group: "G1",
    verdict: "到達",
    asset: "screen-cart-form",
    refs: [
      { screen: "cart-form", probe: "select-customer", props: ["width"] },
      { screen: "cart-form", probe: "field-customer::after", props: ["content"] },
    ],
    note: "**選べるものが無いことは「選択肢が1つだけ(空の option)」という DOM の形から読めた** —— 値ではなく形に依存している。中身が入ると文言は消える。",
  },
  {
    id: "M7-R79",
    group: "G7",
    verdict: "到達",
    asset: "screen-address-form",
    refs: [
      { screen: "address-form", probe: "field-postal::after", props: ["content"] },
      { screen: "address-form", probe: "field-prefecture::after", props: ["content"] },
    ],
    note: "**入力欄の中の案内文字(placeholder)ではなく、欄の外に添えた文字である。**",
  },
  {
    id: "M7-R80",
    group: "G7",
    verdict: "到達",
    asset: "screen-category-form",
    refs: [{ screen: "category-form", probe: "label-slug::after", props: ["content"] }],
    note: "",
  },
  {
    id: "M7-R81",
    group: "G2",
    verdict: "到達",
    asset: "screen-product-form",
    refs: [{ screen: "product-form", probe: "textarea", props: ["min-height", "height"] }],
    note: "",
  },
  {
    id: "M7-R82",
    group: "G4",
    verdict: "未到達",
    asset: "—",
    refs: [{ screen: "product-form", probe: "input-file", props: [] }],
    note: "写真を選ぶボタンの文字は UA の内部の要素が描く。CSS の選択子が届かない。",
  },
  {
    id: "M7-R83",
    group: "G1",
    verdict: "到達",
    asset: "screen-product-form",
    refs: [
      { screen: "product-form", probe: "checkbox", props: ["width", "height"] },
      { screen: "product-form", probe: "field-checkbox::after", props: ["content"] },
    ],
    note: "",
  },
  {
    id: "M7-R84",
    group: "G4",
    verdict: "未到達",
    asset: "—",
    refs: [{ screen: "cart-detail", probe: "errors-li", props: ["#text"] }],
    note: "案内の文はサーバが作る文字列である。",
  },
  {
    id: "M7-R85",
    group: "G6",
    verdict: "到達",
    asset: "screen-cart-detail",
    refs: [
      { screen: "cart-detail", probe: "errors-li", props: ["color"] },
      { screen: "cart-detail", probe: "errors", props: ["background-color", "border-left-width"] },
      { screen: "cart-detail", probe: "hint", props: ["color"] },
    ],
    note: "**この画面だけを落ち着かせられた** —— テーマの `--color-danger` を動かすと全画面に効くが、逃げ道は画面ごとである。",
  },
  {
    id: "M7-R86",
    group: "G8",
    verdict: "到達",
    asset: "共通(全18資産)",
    refs: [
      {
        screen: "catalog-list",
        mode: "narrow",
        probe: "list-table",
        props: ["display", "overflow-x"],
      },
      {
        screen: "catalog-list",
        mode: "narrow",
        probe: "#document",
        props: ["scrollWidth", "innerWidth"],
      },
    ],
    note: "**スコープ外(§0-2 のレスポンシブ)だが分母から外していない。** `@media (max-width: 700px)` を書いた。窓幅420で文書の横幅が窓幅と一致した(はみ出しが消えた)。",
  },
  {
    id: "M7-R87",
    group: "G8",
    verdict: "未到達",
    asset: "—",
    refs: [{ screen: "catalog-list", probe: "chart", props: [] }],
    note: "**スコープ外(F-7')だが分母から外していない。** 図の要素が0件のままである。CSS は値を読めないので、値に応じた図は描けない。",
  },
  {
    id: "M7-R88",
    group: "G8",
    verdict: "到達",
    asset: "共通(全18資産)",
    refs: [
      {
        screen: "catalog-list",
        probe: "td-name",
        props: ["transition-duration", "transition-property"],
      },
    ],
    note: "**スコープ外(アニメーション)だが分母から外していない。** 遷移の宣言が計算後スタイルに現れた。**動いているところは1コマも撮っていない。**",
  },
  {
    id: "M7-R89",
    group: "G8",
    verdict: "未到達",
    asset: "—",
    refs: [],
    note: "**スコープ外(WCAG 体系的保証)だが分母から外していない。** 個々の要素に形や言葉を足すことはできるが、「色だけに頼らない」ことの体系的な保証は個々の計算後スタイルでは測れない。**測っていない。**",
  },
  {
    id: "M7-R90",
    group: "G8",
    verdict: "未到達",
    asset: "—",
    refs: [{ screen: "catalog-list", probe: "font-size-control", props: [] }],
    note: "**スコープ外(WCAG 体系的保証)だが分母から外していない。** 文字の大きさを変える入口の要素が0件のままである。CSS は操作の口を作れない。",
  },
];

const measurements = JSON.parse(await Bun.file(join(outDir, "t03-measurements.json")).text()) as {
  baseline: Record<string, Record<string, Record<string, unknown>>>;
  hatch: Record<string, Record<string, Record<string, unknown>>>;
};

type Measured = {
  found?: boolean;
  count?: number;
  text?: string;
  rect?: Record<string, number>;
  css?: Record<string, string>;
};

function readValue(m: Measured | undefined, prop: string): string {
  if (m === undefined) return "(計測点なし)";
  if (m.found !== true) return `要素なし(count=${m.count})`;
  if (prop === "#text") return JSON.stringify((m.text ?? "").slice(0, 70));
  if (prop.startsWith("rect.")) {
    return String(Math.round((m.rect?.[prop.slice(5)] ?? 0) * 100) / 100);
  }
  return m.css?.[prop] ?? "(未計測)";
}

const rendered = ROWS.map((row) => {
  const evidence = row.refs.map((ref) => {
    const mode = ref.mode ?? "screen";
    const before = measurements.baseline[ref.screen]?.[mode]?.[ref.probe] as Measured | undefined;
    const after = measurements.hatch[ref.screen]?.[mode]?.[ref.probe] as Measured | undefined;
    const props = ref.props.length > 0 ? ref.props : ["#found"];
    const pairs = props.map((prop) => {
      if (prop === "#found") {
        return `要素の個数: ${before?.count ?? "?"}件 → ${after?.count ?? "?"}件`;
      }
      return `${prop}: ${readValue(before, prop)} → ${readValue(after, prop)}`;
    });
    return { point: `${ref.screen}/${mode}/${ref.probe}`, values: pairs };
  });
  return { ...row, evidence };
});

const reached = rendered.filter((r) => r.verdict === "到達");
const assets = new Set(reached.flatMap((r) => (r.asset === "—" ? [] : [r.asset])));

writeFileSync(
  join(outDir, "t03-verdicts.json"),
  `${JSON.stringify(
    {
      meta: {
        task: "V3-M7-T03",
        denominator: ROWS.length,
        denominator_source:
          "docs/plan/v3/records/v3-m7-t02.md §8 の未到達81件(到達9件は分母に入れない)",
        measurements: "docs/evidence/cp-v3/t03-measurements.json",
        not_a_threshold:
          "到達の件数・到達率・資産の数と到達数の比を、合否の閾値として使わない(docs/plan/v3/records/v3-m7.md §0-4 (6) / §2a-1 の裁定5)。",
        screenshots_reference_only:
          "docs/evidence/cp-v3/screenshots/t03/ は参考資料であり、判定に1件も使っていない(同 §0-4 (8))。",
      },
      summary: {
        reached: reached.length,
        not_reached: rendered.length - reached.length,
        by_group_reached: Object.fromEntries(
          [...new Set(ROWS.map((r) => r.group))].sort().map((g) => [
            g,
            {
              total: ROWS.filter((r) => r.group === g).length,
              reached: ROWS.filter((r) => r.group === g && r.verdict === "到達").length,
            },
          ]),
        ),
        distinct_asset_labels: [...assets].sort(),
      },
      verdicts: rendered,
    },
    null,
    2,
  )}\n`,
);
console.error(
  `[t03-verdicts] 分母 ${rendered.length} / 到達 ${reached.length} / 未到達 ${rendered.length - reached.length}`,
);
