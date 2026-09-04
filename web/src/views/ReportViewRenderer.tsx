/**
 * **集計表を表として描く**(`V8-M11-T06`。台帳 `Q-G20` / `Q-G21a` / `Q-G12` / `Q-G21b`。
 * ユーザ決定 `D-V8-129` / `D-V8-130`。門A 本審査 = `V8-M7`)。
 *
 * ## これは何で、何ではないか
 *
 * **`V8-M8`(宣言)/ `V8-M9`(結合)/ `V8-M10`(可視性と上限)/ `V8-M11-T02`〜`T05`
 * (並べ替えとページ送り)で、集計表は `API` として完成していた。**
 * **着手前、`web/` はその `API` を1度も呼んでおらず、`ViewHost.tsx` は
 * 「この画面はまだ表示できません」という知らせを返すだけだった。**
 * **本ファイルがその差し替え先である。**
 *
 * - **集計を1バイトも行わない** —— **束ね方も、日付の丸めも、並び順も、上限も、可視性も、
 *   判定はすべてサーバ(カーネル)の側にある。** **ここがするのは「応答を表に写す」ことと
 *   「次にどう読むかをサーバへ伝えること」だけである。**
 * - **群の合計をフロントで足し直していない** —— **`totals` はサーバが母集団そのものを
 *   1度数えた値であり(`D-V8-122`)、画面に出ている群の値の和ではない。**
 *   **足し直すと、ページを切ったときに黙って別の数になる。**
 * - **並べ替えはサーバへ投げ直す**(取得済みの群をフロントで並べ替えていない)——
 *   **フロントで並べ替えると「いま見えている100群の中だけ」が並び替わり、2ページ目には
 *   効かない。** **一覧(`ListViewRenderer`)が `V4-M19-T06` で採ったのと同じ形である。**
 *
 * ## 状態を1バイトも保存しない(**決定12**。`v8-m11.md` §1-0e)
 *
 * **打たれた並び順もページ位置も、この画面の一時状態(`useState`)である** ——
 * **マニフェストにも `localStorage` にも `sessionStorage` にも URL にも Cookie にも
 * サーバにも1バイトも保存しない。** **リロードで消える。**
 * **先例は `web/src/views/ListViewRenderer.tsx` の `pickedSort` と `offset` であり、
 * 新しい種類の状態を1つも作っていない。**
 *
 * ## 4xx を「0件」として描かない(`Q-G18`)
 *
 * **上限に当たった 400・未ログインの 401・権限の 403 は、どれも「知らせ」として出す** ——
 * **部分的な表を1行も描かず、`0` という数も1つも出さない。**
 * **「合計0・件数0」と「見られない」を画面上で混同させないためである。**
 * **知らせにはサーバが返した文面をそのまま載せる**(`ADR-0003` §3。フロントで作り直さない)。
 * **画面が自分でマニフェストから表の名前を足すことはしない** —— **上限の 400 の本文には
 * 表のIDが1バイトも出ておらず**(`src/server/report-limit-boundary.test.ts` が固定している)、
 * **画面が足すとその固定が画面の側で台無しになる。**
 *
 * ## 解けていないこと(**隠さない**)
 *
 * 1. **値の書式を1つも当てていない** —— **桁区切りも単位(`ADR-0086`)も参照の代表値も、
 *    一覧(`FieldValue`)が当てているものがここには1つも当たらない。**
 *    **表に出る数は `API` の応答の値そのものである** —— **「1200 円」の列は `1200` と出る。**
 * 2. **束ねるキーが `reference` のとき、出るのは参照先の行の番号である**(代表値を引いていない)。
 * 3. **日付の丸め(`granularity`)を見出しに1文字も出していない** —— **同じ日付項目を
 *    月と日で2本束ねると、見出しが同じ文字列になる。**
 * 4. **描画の性能を1度も測っていない**(`v8-m11.md` §0-3 が埋めないと宣言している)。
 * 5. **群からの操作起点は今日も1つも無い**(`Q-G21c` = 却下)—— **群は行ではないので、
 *    開く先が無い。** **`schemas` の `report_view` 分岐が `"actions": false` で閉じている。**
 *
 * ## **【`V8-M12-T03` の追記。上の 1 を訂正する。旧文を1バイトも消していない】**
 *
 * **上の 1 は今日、2箇所が正しくない。**
 *
 * 1. **【今日の正】集計値(`aggregates` の列)には書式が当たっている** ——
 *    **一覧と同じ `formatNumber`(`web/src/fields/display.tsx`)を**再利用**しており、
 *    2本目の書式関数を書き起こしていない。** **単位(`ADR-0086` の `$defs/field.unit`)も
 *    今日から付く** —— **`aggregates[].field` が指す項目の `unit` を、この画面の側で引いて
 *    値の後ろに添える**(**一覧の `FieldValue` の `number` 分岐と同じ「値 + 半角空白 + 単位」の
 *    1通りだけである**)。**件数(`count`)には単位を付けない** —— **指す項目が無い。**
 * 2. **【旧文自身が今日は不正確である】上の「『1200 円』の列は `1200` と出る」という例は、
 *    一覧の側の前提が間違っていた** —— **桁区切りは整数5桁からしか入らないので
 *    (`display.tsx` の `GROUPING_MIN_INTEGER_DIGITS = 5`)、一覧でも `1200` は `1200` である。**
 *    **今日の集計表で `1200` が `1,200` になることは無い。** **`12345` が `12,345` になる。**
 *    (**`v8-m12.md` §1-0e の決定19 / §1-0f の枝番 甲4**。)
 *
 * **【射程外。塞いでいない】束ねるキー(`group_by`)の列の書式は1ミリも動かしていない** ——
 * **上の 2(参照は行の番号のまま)と 3(日付の丸めを見出しに出さない)は今日も真である。**
 *
 * ## **【`V8-M12-T04` の追記。グラフを足した。旧文を1バイトも消していない】**
 *
 * **上の「解けていないこと」の 4(描画の性能を1度も測っていない)は今日も真である**
 * (測るのは `T06`)。**変わったのは「グラフが1本も無い」ことのほうである。**
 *
 * - **画面の上にグラフ、下に表を出す**(ユーザ決定 `D-V8-131`。台帳 `Q-G23` = 限定採用)——
 *   **グラフを出すか出さないかは宣言の対象ではない。** **宣言(`view.report.chart`)が
 *   決めるのは種別だけで、`"line"` なら折れ線、`"bar"` または省略なら棒である。**
 * - **描くのは `groups` である。`totals` を1本も棒にしていない** —— **上の逐語のとおり
 *   `totals` は母集団そのものを1度数えた値であり、画面に出ている群の値の和ではない。**
 * - **系列は `aggregates` に宣言した集計の全部である**(最大3本。決定4)——
 *   **どれを描くかを選ぶ口を1つも作っていない。**
 * - **群が0件のとき・上限に当たったとき・権限が無いとき・ログインが切れたときは、
 *   グラフを1本も描かない**(決定22)—— **`Q-G18`(4xx を0件として描かない)を
 *   グラフ側でも薄めない。**
 *
 * ## **配色(`Q-G27`)—— 棒と折れ線で色の渡し方が割れている(隠さない)**
 *
 * **メインの裁定「決定23」**(`v8-m12.md` §1-0d の決定18 を改めたもの)。
 *
 * - **折れ線**: **`@nivo/line` の `colors` に `var(--…)` の文字列をそのまま渡す** ——
 *   **`stroke` 属性に文字列のまま残り、CSS が解決する。**
 * - **棒**: **`@nivo/bar` の `colors` には1つも渡さず、棒の `rect` をこのファイルが
 *   自分で描いて `fill` に `var(--…)` を入れる**(`layers` から `"bars"` を外している)。
 * - **なぜ割れるか**: **棒だけが `react-spring` の文字列補間を通るからである** ——
 *   **`react-spring` は `var(--x)` を `getComputedStyle(document.documentElement)` で
 *   解決してから凍らせるので、(i) 検査環境(happy-dom)では解決できず例外で描画が
 *   丸ごと落ち、(ii) 本物のブラウザでも `.app-theme` に注入したアプリ単位のテーマが
 *   届かない**(`web/src/tailwind.css` 冒頭が同じ理由で `:root` での解決を避けている)。
 *   **【禁止】「`@nivo` は `var()` を通す」と一括りに書かない。**
 * - **1本目 = `--color-danger` / 2本目 = `--focus-outline-color` / 3本目 =
 *   `--color-text-secondary`** —— **今日、有彩色のスロットは2本しか無い**(枝番 戊2)。
 *   **3本目を名指しで固定してある** —— **「25スロットのどれか」にすると、白地に白の
 *   系列が検査を通ってしまう。**
 * - **【禁止。台帳の逐語に従う】`Q-G27` の「(c) 配色は25スロットからの導出だけで決める」を
 *   守ったと書かない** —— **台帳が「系列が3つ以上になると原理的に守れない」と書いている**
 *   (枝番 戊1)。**書けるのは「3系列とも25スロットの内側から採り、色の実値を
 *   このファイルに1文字も書いていない」までである。**
 * - **`getComputedStyle` をこのファイルにも `web/src/` にも1件も入れていない。**
 * - **系列の色を Tailwind のクラス名として組み立てていない**(枝番 乙3。
 *   `ADR-0087` 限定6 = safelist 禁止)。**25スロットを1つも増やしていない。**
 *
 * ## **グラフについて、このファイルが解いていないこと(隠さない)**
 *
 * 1. **折れ線のツールチップを検査で1件も測れていない** —— **当たり判定が
 *    `getBoundingClientRect` に依り、happy-dom は全部 0 を返す。** **実測で hover を
 *    打っても1文字も出なかった。** **実証は `T06`(chromium)の担当である。**
 *    **【禁止】「ツールチップが出る」と書かない。** **棒には `<title>` を添えており、
 *    こちらは検査で固定してある。**
 * 2. **凡例を1つも出していない** —— **折れ線は、どの線がどの系列かを画面から読めない**
 *    (下の表の列見出しと色の対応が付かない)。
 * 3. **縦軸の単位は、系列の単位がそろっているときにしか出せない** —— **「合計(円)」と
 *    「件数(単位なし)」が同じ縦軸に並ぶので、割れているときは桁区切りだけを当てる。**
 * 4. **軸の目盛りの間隔もラベルの重なりも1件も測っていない** —— **群が100個あるとき、
 *    横軸のラベルは重なる。**
 * 5. **`@nivo/bar` の棒の遷移(`react-spring`)は、描かない層のぶんも作られている** ——
 *    **`layers` から外しているのは描画であって、計算ではない。**
 *
 * ## **【`V8-M12-T06` の追記。上の5項目を1バイトも消していない】**
 *
 * **`T06` が chromium で実測し、メインの裁定で2件を直した。** **上の 1 と 4 は今日は
 * 成り立たない。** **2 は `T04` の時点で既に凡例を出したので、書かれた時点から偽である。**
 *
 * ### **説明の出し方が、棒と折れ線で割れている**(**上の「配色」と同じ系列の事実**)
 *
 * | | 出し方 | 出る文面 | 何で出るか |
 * |---|---|---|---|
 * | **棒** | **SVG の `<title>`** | **`群の見出し・系列の見出し: 値`** | **ブラウザの既定の説明**(しばらく載せたままにすると出る) |
 * | **折れ線** | **`@nivo` のツールチップ** | **`x: 群の位置の番号, y: 値`** | **`mesh` 層がマウスの位置から最も近い点を選ぶ** |
 *
 * - **なぜ割れるか**: **`<title>` は `getBoundingClientRect` を1度も使わないので検査環境でも
 *   実在を確かめられるが、折れ線には棒のような「面を持つ要素」が無く、点(半径3px)に
 *   `<title>` を添えても実質どこにも当たらない。** **上の「配色」が割れているのと同じで、
 *   **2種で形をそろえること自体を目的にしていない**(そろえると片方が壊れる)。**
 * - **【正直に書く】折れ線のツールチップに群の**名前**は出ない** —— **出るのは位置の番号
 *   (`x: 1`)である。** **横軸の値に位置の番号を使っているためであり(`chartRows` の doc)、
 *   `xFormat` を1つも渡していないので番号がそのまま出る。** **裁定は「`useMesh` を `true` に
 *   する。それ以上のことはしない」であり、`xFormat` を足していない。**
 * - **`enableSlices` / `isFocusable` は1つも触っていない** —— **キーボードだけで操作する人には、
 *   折れ線の値は今日も読めない**(点に focus できない)。**表には同じ数が全部出ている。**
 *
 * ### **横軸のラベルは10本までに間引くようになった**(上の 4 への直し)
 *
 * **根拠と限界は `CHART_MAX_AXIS_LABELS` の doc に書いた。** **`_id` で束ねた集計表の
 * 横軸は、間引いた後も重なる**(実測で 9/9 組)。
 */
import { Bar, type BarCustomLayerProps, type BarDatum } from "@nivo/bar";
import { Line } from "@nivo/line";
import { useEffect, useState } from "react";
import type { Field, Manifest, ReportView } from "../../../src/kernel/types.ts";
import {
  ApiError,
  fetchReport,
  type ReportGroupKeyValue,
  type ReportGroupRow,
  type ReportPage,
  type ReportSortQuery,
  type ValidationError,
} from "../api.ts";
import { toValidationErrors } from "../async.ts";
import { ErrorList } from "../ErrorList.tsx";
import { formatNumber } from "../fields/display.tsx";
import { Button } from "../ui/button.tsx";
import { Alert, AlertDescription, AlertTitle, Skeleton } from "../ui/surfaces.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table.tsx";
import { cn } from "../ui/utils.ts";
import type { ViewRendererProps } from "./types.ts";

/**
 * 画面の器そのものに当てる体裁。**一覧(`LIST_VIEW_CLASS`)と同じ形にしてある。**
 * **座標系のプロパティを1つも使っていない**(`ADR-0087` 限定8)。
 * **色のリテラルを1バイトも書いていない**(`ADR-0094` 限定7)——
 * **当たり先は既存の意味の名前(`text-foreground` ほか)だけである。**
 */
const REPORT_VIEW_CLASS = cn("report-view", "flex flex-col gap-s3 font-sans text-foreground");

/**
 * **1ページに読む群の数**(`D-V8-129`)。
 *
 * **サーバの既定(`REPORT_DEFAULT_GROUP_LIMIT` = 100)と同じ値である** ——
 * **それでも省略に頼らず明示して渡す。** **ページ送りの幅と読む幅が2つの数に割れると、
 * 「100群ずつ出るのに『次へ』は200群動く」ような食い違いが起きる。**
 * **【禁止】この値を大きくして「重い集計表も開ける」と読まない** —— **群の数の上限は
 * サーバ側にあり、ページ送りでは1ミリも回避できない**(`v8-m11.md` §1-0c の決定5)。
 */
const REPORT_PAGE_SIZE = 100;

/** 値が1つも入っていない群の見せ方。**空白にすると「列がずれた」と読めてしまう。** */
const EMPTY_GROUP_KEY_LABEL = "(値なし)";

/**
 * **系列の色**(`V8-M12-T04`。台帳 `Q-G27`。決定17 / メインの裁定「決定23」/ 枝番 戊2)。
 *
 * **25スロットの CSS カスタムプロパティを `var(--…)` の文字列として持つ** ——
 * **色の実値(16進)をこのファイルに1文字も書いていない。** **スロットを1つも増やしていない。**
 *
 * - **1本目・2本目は有彩色のスロット2本ちょうどである** —— **今日、25スロットに
 *   有彩色は `--color-danger` と `--focus-outline-color` の2本しか無い。**
 * - **3本目は `--color-text-secondary`(無彩色)を名指しする** —— **「25スロットのどれか」
 *   では `--color-page-background` を使った**白地に白**の系列が検査を通ってしまう。**
 * - **`aggregates` は宣言で最大3本なので、この3本で足りる**(`schemas` の `maxItems`)。
 *
 * **【禁止】(c)「配色は25スロットからの導出だけで決める」を守ったと書かない**(枝番 戊1)。
 */
const SERIES_COLORS: readonly string[] = Object.freeze([
  "var(--color-danger)",
  "var(--focus-outline-color)",
  "var(--color-text-secondary)",
]);

/**
 * **グラフの内部座標**(決定19)。
 *
 * **`ResponsiveBar` / `ResponsiveLine` を1つも使っていない** —— **どちらも
 * `getBoundingClientRect` で親の幅を測るが、検査環境(happy-dom)はそれを全部 0 で
 * 返すので、1本も描かれない。** **したがって寸法は固定の内部座標で持ち、画面幅への
 * 追随は `viewBox` と CSS で行う**(下の `fitChartToWidth`)。
 */
const CHART_WIDTH = 720;
const CHART_HEIGHT = 320;
/** 目盛りの文字が入る余白。**左が広いのは、桁区切りと単位を付けた数が入るためである。** */
const CHART_MARGIN = { top: 8, right: 16, bottom: 56, left: 104 };

/**
 * **グラフの地の色**(軸・目盛り・グリッド)。**ここも25スロットの `var()` だけである。**
 *
 * **【`text.fill` をここに書いてはならない】** —— **`@nivo/bar` はその値を
 * `react-spring` の文字列補間に通すので、`var(--…)` を渡すと例外で描画が丸ごと落ちる**
 * (実測済み。`axis.ticks.text.fill` は通る)。**折れ線では落ちないが、2つに割れた
 * 書き方を作らないよう、棒と折れ線で同じこの1つを使う。**
 */
const CHART_THEME = {
  axis: {
    ticks: {
      text: { fill: "var(--color-text-secondary)", fontFamily: "var(--font-family-base)" },
      line: { stroke: "var(--color-border)" },
    },
    domain: { line: { stroke: "var(--color-border)" } },
  },
  grid: { line: { stroke: "var(--color-border)" } },
};

/**
 * **グラフ1行**(群1つ)。**横軸の値は群の位置の番号で、見せる文字列は別に持つ。**
 *
 * **番号を横軸の値にしているのは、群のキーの文字列が2つの群で同じになりうるからである**
 * —— **束ねるキーを2本書いた集計表では、1列目だけを見ると同じ文字列の群が並びうる。**
 * **文字列をそのまま横軸の値にすると、その2群が1本に潰れて**数が消える**。**
 * **見せる文字列は `axisBottom` の `format` で番号から引き直す**(表の1列目と同じ文字列)。
 */
type ChartRow = BarDatum;

/** 横軸の値を入れる列の名前。**利用者の項目名と衝突しない位置に置く。** */
const CHART_INDEX_KEY = "group";
/** その群の見せる文字列(表の1列目と同じ)。 */
const CHART_LABEL_KEY = "label";

/** 系列1本ぶんの列の名前。**値・系列名・書式を当てた文字列を、同じ番号で束ねる。** */
function seriesValueKey(index: number): string {
  return `s${index}`;
}

/**
 * **折れ線に渡す系列の識別子**(**画面に出す見出しではない**)。
 *
 * **`@nivo/line` は系列を `id` で区別するので、同じ文字列が2本あると成立しない** ——
 * **実測(2026-08-15): 同じ `id` の系列を2本渡すと、2本目にも1本目の色が当たり、
 * React が鍵の重複を警告する。** **`aggregates` は同じ集計を2本書ける**
 * (`[{sum, amount}, {sum, amount}]`)**ので、そのときだけ番号を添えて区別する。**
 *
 * **【正直に書く。ここだけ表と割れる】** **見出しが重なった集計表では、凡例と表は
 * 同じ文字列を2つ並べる(色で見分ける)が、折れ線のツールチップだけは番号つきの
 * 文字列を出す。** **凡例と表の見出しは `reportColumns` の `label` そのものであり、
 * 2本目の見出しの作り方をこのファイルは持っていない。**
 */
function seriesLabels(series: ReportColumn[]): string[] {
  const labels = series.map((column) => column.label);
  return labels.map((label, index) =>
    labels.indexOf(label) === index ? label : `${label} (${index + 1})`,
  );
}

/**
 * **縦軸に添える単位。**
 *
 * **系列の単位がそろっているときだけ出す** —— **「金額の合計(円)」と「件数(単位なし)」は
 * 同じ縦軸に並ぶので、どちらか一方の単位を軸に出すと、もう一方の系列の目盛りが嘘になる。**
 * **割れているときは桁区切りだけを当てる**(**書式そのものは表と同じ関数である**)。
 */
function chartAxisUnit(series: ReportColumn[]): string | undefined {
  const first = series[0];
  return first !== undefined && series.every((column) => column.unit === first.unit)
    ? first.unit
    : undefined;
}

/**
 * **横軸に出すラベルの本数の上限**(`V8-M12-T06`。メインの裁定「直す1」)。
 *
 * ## **10 は測って決めた値である**(**業務要件から決めた値ではない**)
 *
 * **`T06` が chromium で実測した3つの数から出している**:
 *
 * 1. **横軸の内側の幅は 600px である**(`CHART_WIDTH 720 − CHART_MARGIN.left 104 −
 *    `.right 16`)。
 * 2. **画面の1ページは既定で100群である**(下の `REPORT_PAGE_SIZE`)—— **満杯のページでは
 *    群1つあたり 5.98px しかなく、100本すべてを描くと隣り合う 99 組が**全部**重なった**
 *    (**実測。`_id` で束ねた UUID でも、`date` で束ねた `2026-01-01` でも同じ 99/99**)。
 * 3. **10文字のラベル(`2026-01-01`)の実測幅は約 63px である** —— **600 ÷ 63 ≒ 9.5。**
 *    **切り上げずに 10 を採る**(端のラベルは中心から左右に半分ずつ出るので、
 *    9.5 本ぶんの幅に 10 本を置くと端が枠から少し出るだけで、隣とは重ならない)。
 *
 * ## **【正直に書く】長いラベルでは 10 本でも重なる**
 *
 * **`_id`(行そのもの)で束ねると、横軸に出るのは生の UUID である** —— **36文字・実測で
 * 約 230px あり、600px には 2〜3 本しか入らない。** **10 本に間引いても重なる。**
 * **切り詰めも回転も1つもしていない** —— **どちらも「読めない」を「読み違える」に
 * 変えるだけで、`ADR-0007:1467` の限定にも計画にも根拠が無い。**
 * **`_id` で束ねた集計表の横軸は、今日も読めない。**
 *
 * ## 間引くのは**ラベルだけ**である
 *
 * **棒も線も点も1本も間引いていない** —— **描くのは今日どおり全群である**
 * (`web/test/report-view.test.tsx` の (M12-T06-4) が 200本の棒で固定している)。
 */
const CHART_MAX_AXIS_LABELS = 10;

/**
 * **横軸に目盛りを出す群の位置**(**棒と折れ線で同じこの1本を使う**。2種で形を割らない)。
 *
 * **群が上限以下ならそのまま全部返す。** **超えたら等間隔に選び、
 * **先頭(0)と末尾(`count - 1`)を必ず含める**。**
 * **返すのは `chartRows` / 折れ線の `x` と同じ「群の位置の番号の文字列」である。**
 */
function chartAxisTickValues(count: number): string[] {
  if (count <= CHART_MAX_AXIS_LABELS) {
    return Array.from({ length: count }, (_unused, index) => String(index));
  }
  const step = (count - 1) / (CHART_MAX_AXIS_LABELS - 1);
  return Array.from({ length: CHART_MAX_AXIS_LABELS }, (_unused, index) =>
    String(Math.round(index * step)),
  );
}

/** グラフに渡す行。**表と同じ `groups` から作る** —— 2つ目の出どころを作らない。 */
function chartRows(groups: ReportGroupRow[], series: ReportColumn[]): ChartRow[] {
  return groups.map((group, index) => {
    const row: ChartRow = {
      [CHART_INDEX_KEY]: String(index),
      [CHART_LABEL_KEY]: groupKeyText(group.keys[0]),
    };
    for (const [seriesIndex, column] of series.entries()) {
      const value = group.aggregates[column.index]?.value;
      /*
       * **値が返っていない系列は、その群に1本も描かない** —— **0 として描くと
       * 「集計できていない」ことと「集計した結果が0だった」ことが画面で混ざる**
       * (表が `(値なし)` と書き分けているのと同じ理由である)。
       */
      if (value === undefined) {
        continue;
      }
      row[seriesValueKey(seriesIndex)] = value;
      /** **棒に添える説明の系列名は、表の列見出しそのものである**(凡例と1バイト同じ)。 */
      row[`${seriesValueKey(seriesIndex)}:name`] = column.label;
      row[`${seriesValueKey(seriesIndex)}:text`] = aggregateText(value, column.unit);
    }
    return row;
  });
}

/**
 * **棒そのものを描く層**(メインの裁定「決定23」)。
 *
 * **`@nivo/bar` の `colors` を1度も使っていない** —— **使うと `react-spring` が
 * `var(--…)` を解決しようとして落ちる**(冒頭の追記節)。**ここが受け取るのは
 * 位置と大きさ(nivo が計算した目盛り・スケール・座標)だけで、色は
 * `SERIES_COLORS` から系列の番号で引く。**
 *
 * **`<title>` を添える** —— **これは SVG が持つ既定の説明であり、`getBoundingClientRect`
 * を1度も使わないので検査環境でも実在を確かめられる**(折れ線側のツールチップは
 * 確かめられない。冒頭の追記節)。
 */
function ChartBars({ bars }: BarCustomLayerProps<ChartRow>) {
  return (
    <g>
      {bars.map((bar) => {
        const key = String(bar.data.id);
        const seriesIndex = Number(key.slice(1));
        return (
          <rect
            key={bar.key}
            x={bar.x}
            y={bar.y}
            width={bar.width}
            height={bar.height}
            fill={SERIES_COLORS[seriesIndex]}
            data-testid="report-chart-bar"
            data-report-series={seriesIndex}
          >
            <title>{`${bar.data.data[CHART_LABEL_KEY]}・${bar.data.data[`${key}:name`]}: ${bar.data.data[`${key}:text`]}`}</title>
          </rect>
        );
      })}
    </g>
  );
}

/**
 * **画面幅への追随**(決定19)。
 *
 * **`@nivo` は `width` / `height` の属性しか出さず、`viewBox` を1つも出さない**(実測)——
 * **`viewBox` が無い SVG は CSS で幅を変えても中身が拡大縮小せず、狭い画面で切れる。**
 * **そこで、描かれた `svg` に `viewBox` を1つだけ足す** —— **足すのは属性1つで、
 * スタイルを1バイトも差し込んでいない**(`<style>` も `insertRule` も使っていない)。
 * **`getComputedStyle` を1度も呼んでいない** —— **測っていないからである。**
 *
 * **【この形は計画に名前が無い】** **`@nivo` が `viewBox` を1つも出さないという実測
 * (2026-08-15)と、`Responsive*` を使わないという決定19 から導いた形である**
 * (メインの裁定1 で採用)。**`ADR-0087` 限定8(座標系のプロパティ)の検査は
 * 手で書く CSS だけを読むので、この形には当たらない**(実測。境界の検査8ファイルで
 * 125 pass)。**当たるようになったら、この形を先に見直すこと。**
 */
function fitChartToWidth(node: HTMLDivElement | null): void {
  node?.querySelector("svg")?.setAttribute("viewBox", `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`);
}

/**
 * 画面が持つ状態。**共通の `AsyncState` に1つ足した形である** ——
 * **状態コードを覚えておかないと、401 / 403 / それ以外を見分けて知らせの見出しを書けない。**
 * **文面そのものはサーバのものを使う**ので、覚えるのは数字1つだけである。
 */
type ReportState =
  | { status: "loading" }
  | { status: "ready"; value: ReportPage }
  | { status: "error"; httpStatus?: number; errors: ValidationError[] };

/** 表の列1本。**束ねるキーの列と集計値の列を、同じ1つの形で持つ。** */
type ReportColumn = {
  /** React の鍵と、押されたときに送る値を1つに束ねた識別子。 */
  id: string;
  label: string;
  target: "group_by" | "aggregate";
  index: number;
  /**
   * **その列に添える単位**(`V8-M12-T03`。`ADR-0086` の `$defs/field.unit`)。
   *
   * **集計値の列にだけ入る** —— **`aggregates[].field` が指す項目の `unit` である**
   * (**結合があるときは `aggregates[].table` が指す表から引く。省略時は起点の表**)。
   * **件数(`count`)は指す項目を持たないので、常に `undefined` である。**
   * **束ねるキーの列には1つも入れない**(**書式そのものが本タスクの射程外である**)。
   */
  unit?: string;
};

function fieldOf(manifest: Manifest, tableId: string, fieldId: string): Field | undefined {
  return manifest.app.tables
    .find((table) => table.id === tableId)
    ?.fields.find((field) => field.id === fieldId);
}

/**
 * **その項目に書かれた単位**(`V8-M12-T03`。`ADR-0086` の `$defs/field.unit`)。
 *
 * **`Field` は型ごとの直和であり、`unit` を持てるのは `select` / `reference` / `image` /
 * `file` を除く5型だけである** —— **`in` で当たりを見るので、持てない型に単位を作らない。**
 * **推測は1つもしない**(**項目名からの推定も、通貨の判定も1バイトも書いていない**。
 * `ADR-0086` が `Δ4` を踏まないために置いた作法をそのまま引く)。
 */
function unitOf(field: Field | undefined): string | undefined {
  return field !== undefined && "unit" in field ? field.unit : undefined;
}

/**
 * **列見出しを組み立てる。**
 *
 * - **束ねるキーの列** = **その項目の表示名**(`Field.name`)。**IDを出さない** ——
 *   利用者の言葉と食い違うためである(一覧の列見出しと同じ作法)。
 *   **`_id` で束ねた列だけは表示名が存在しない**(どの表の `fields` にも現れない)ので、
 *   **書かれたままの綴りを出す。**
 * - **集計値の列** = **`count` なら「件数」、`sum` なら「<項目名>の合計」。**
 */
function reportColumns(manifest: Manifest, view: ReportView): ReportColumn[] {
  const columns: ReportColumn[] = view.report.group_by.map((groupBy, index) => ({
    id: `group_by:${index}`,
    label: fieldOf(manifest, groupBy.table ?? view.table, groupBy.field)?.name ?? groupBy.field,
    target: "group_by",
    index,
  }));
  for (const [index, aggregate] of view.report.aggregates.entries()) {
    /*
     * **項目は1度だけ引く**(`V8-M12-T03`)—— **見出しと単位が別々に引かれると、
     * 結合したときに「明細額の合計」という見出しの隣に起点の表の単位が出る形を作れてしまう。**
     * **`aggregate.table ?? view.table` は `V8-M11` が見出しに使っていた式そのものであり、
     * 1バイトも変えていない。**
     */
    const field =
      aggregate.field === undefined
        ? undefined
        : fieldOf(manifest, aggregate.table ?? view.table, aggregate.field);
    const label = aggregate.field === undefined ? undefined : (field?.name ?? aggregate.field);
    /** **件数には単位を付けない** —— **指す項目が無い**(`v8-m12.md` §1-0e)。 */
    const unit = aggregate.type === "count" ? undefined : unitOf(field);
    columns.push({
      id: `aggregate:${index}`,
      label: aggregate.type === "count" ? "件数" : label === undefined ? "合計" : `${label}の合計`,
      target: "aggregate",
      index,
      ...(unit === undefined ? {} : { unit }),
    });
  }
  return columns;
}

/**
 * 束ねたキーの値を文字列にする。
 *
 * **書式を1つも当てていない**(冒頭の「解けていないこと」1)—— **`API` が返した値
 * そのものである。** **`null` は「値が入っていない群」であって、0件でも空文字でもない**
 * (サーバは `null` の群を昇順でも降順でも最後に置く。`v8-m11.md` の決定15)。
 */
function groupKeyText(key: ReportGroupKeyValue | undefined): string {
  const value = key?.value;
  if (value === null || value === undefined) {
    return EMPTY_GROUP_KEY_LABEL;
  }
  if (typeof value === "boolean") {
    return value ? "はい" : "いいえ";
  }
  return String(value);
}

/** 集計値を文字列にする。**丸めも桁区切りも1つも当てていない。** */
/**
 * **【`V8-M12-T03` の追記。上の1行を1バイトも消していない】**
 *
 * **上の1行のうち「桁区切りを1つも当てていない」は今日は偽である**(丸めの側は今日も真)。
 *
 * - **桁区切りは一覧と同じ `formatNumber` を再利用する**(2本目を書き起こしていない)——
 *   **したがって閾値も一覧と同じ整数5桁である**(`12345` → `12,345`。**`1200` は `1200` のまま**)。
 * - **単位は呼ぶ側(この画面)が引いて渡す** —— **`formatNumber` に単位の責任を持たせない。**
 *   **添える形は一覧(`display.tsx` の `number` 分岐)と同じ「値 + 半角空白 + 単位」1通りだけである。**
 * - **丸めは今日も1つも当てていない** —— **`formatNumber` は小数部を1桁も丸めない。**
 * - **値が無いときの見せ方は1ミリも変えていない**(`EMPTY_GROUP_KEY_LABEL`)——
 *   **単位も桁区切りも足さない。**
 */
function aggregateText(value: number | undefined, unit: string | undefined): string {
  if (value === undefined) {
    return EMPTY_GROUP_KEY_LABEL;
  }
  return `${formatNumber(value)}${unit === undefined ? "" : ` ${unit}`}`;
}

/** その列の `<th>` に出す `aria-sort`。**並べ替えの対象でない列には `none` を出す。** */
function ariaSortFor(
  sort: ReportSortQuery | undefined,
  column: ReportColumn,
): "ascending" | "descending" | "none" {
  if (sort === undefined || sort.target !== column.target || sort.index !== column.index) {
    return "none";
  }
  return sort.order === "asc" ? "ascending" : "descending";
}

/**
 * 押されたときに打つ並べ替え。**同じ列なら向きを反転し、別の列なら昇順から始まる。**
 * **宣言(`view.report.sort`)の向きを引き継がない** —— 引き継ぐと「降順で宣言された列を
 * 1回押したら昇順になる列」と「昇順から始まる列」が混ざり、押した結果が予測できなくなる
 * (一覧の `nextSort` と同じ理由・同じ形)。
 */
function nextReportSort(
  active: ReportSortQuery | undefined,
  column: ReportColumn,
): ReportSortQuery {
  const same =
    active !== undefined && active.target === column.target && active.index === column.index;
  return {
    target: column.target,
    index: column.index,
    order: same && active.order === "asc" ? "desc" : "asc",
  };
}

/** 知らせの見出し。**状態コードごとに1文だけ変える**(本文はサーバの文面である)。 */
function errorTitle(httpStatus: number | undefined): string {
  if (httpStatus === 401) {
    return "この集計表を見るにはログインが必要です";
  }
  if (httpStatus === 403) {
    return "この集計表を見る権限がありません";
  }
  return "この集計表は表示できませんでした";
}

export function ReportViewRenderer({ appId, manifest, view }: ViewRendererProps<ReportView>) {
  /**
   * **打たれた並べ替え**(`D-V8-130`)。**この画面の一時状態であって、どこにも保存しない。**
   * **`undefined` = まだ何も打っていない** = 宣言された `view.report.sort` がそのまま効く。
   */
  const [pickedSort, setPickedSort] = useState<ReportSortQuery | undefined>(undefined);
  const effectiveSort = pickedSort ?? view.report.sort;
  /** **ページ位置。** **これも一時状態である**(`ADR-0042` が一覧について定めたのと同じ性質)。 */
  const [offset, setOffset] = useState(0);
  const [state, setState] = useState<ReportState>({ status: "loading" });

  /**
   * **並べ替えを打ち直したら先頭ページへ戻す。** **新しい reset の仕組みを1つも作っていない**
   * —— 一覧が `viewKey` で行っているのとまったく同じ形である(レンダー中に前回値と比べる)。
   * **2ページ目のまま別の並びを見せない** —— 1ページ目に何が来たかを見られないためである。
   */
  const viewKey = JSON.stringify([appId, view.id, effectiveSort ?? null]);
  const [prevViewKey, setPrevViewKey] = useState(viewKey);
  if (viewKey !== prevViewKey) {
    setPrevViewKey(viewKey);
    setOffset(0);
  }

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fetchReport(appId, view.id, {
      // **ページの幅は1箇所が決める**(読む幅とページ送りの幅を2つの数に割らない)。
      limit: REPORT_PAGE_SIZE,
      // **先頭ページでは `offset` を1バイトも載せない**(一覧と同じ作法)。
      ...(offset > 0 ? { offset } : {}),
      // **打っていない画面では、宣言に `sort` が無ければ順序のクエリは1つも載らない。**
      ...(effectiveSort === undefined ? {} : { sort: effectiveSort }),
    }).then(
      (page) => {
        if (!cancelled) {
          setState({ status: "ready", value: page });
        }
      },
      (reason: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            // **覚えるのは数字だけである** —— **文面はサーバのものをそのまま運ぶ**(`ADR-0003` §3)。
            ...(reason instanceof ApiError ? { httpStatus: reason.status } : {}),
            errors: toValidationErrors(reason),
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [appId, view.id, effectiveSort, offset]);

  if (state.status === "loading") {
    return (
      <section className={REPORT_VIEW_CLASS} data-testid="view-renderer-report_view">
        <p className="text-note text-muted-foreground">読み込み中…</p>
        {["head", "row-1", "row-2"].map((slot) => (
          <Skeleton key={slot} className="h-8 w-full" />
        ))}
      </section>
    );
  }

  if (state.status === "error") {
    /*
     * **【`Q-G18`】4xx を「0件」として描かない。**
     *
     * **表を1行も描かず、「0件」「合計0」という数を1つも出さない** —— **上限に当たって
     * 計算できなかったことと、集計した結果が本当に0だったことはまったく違う事実であり、
     * 画面上で混同させてはならない。**
     * **表の名前も表のIDも1バイトも足していない**(応答本文にも出ていない)。
     */
    return (
      <section className={REPORT_VIEW_CLASS} data-testid="view-renderer-report_view">
        <Alert variant="destructive" data-testid="report-error">
          <AlertTitle>{errorTitle(state.httpStatus)}</AlertTitle>
          <AlertDescription data-testid="report-error-not-zero">
            これは「0件」ではありません。集計した結果が0だったのではなく、集計そのものを出せていません。
          </AlertDescription>
          <ErrorList errors={state.errors} />
        </Alert>
      </section>
    );
  }

  const { groups, total_groups: totalGroups, totals } = state.value;
  const columns = reportColumns(manifest, view);
  const rangeStart = groups.length === 0 ? 0 : offset + 1;
  const rangeEnd = offset + groups.length;
  const hasPrev = offset > 0;
  const hasNext = rangeEnd < totalGroups;

  /**
   * **全体の合計は、ページを切る**前**の値である**(`D-V8-129` / `D-V8-122`)。
   *
   * **`D-V8-129` の説明文の逐語**:「画面の上に出る全体の合計は、100件分ではなく
   * 全部を数えた値を出します」。**それが読み手に分かる文言をここに書く** ——
   * **数字だけを置くと「いま見えている群の合計」と読まれる**(`V4-M23-T03` の
   * 再審査① S3-4 が一覧について同じ取り違えを実測している)。
   */
  const totalBlock = (
    <div
      className={cn("report-total-group", "flex flex-col gap-s1")}
      data-testid="report-total-group"
    >
      <p className="text-note text-muted-foreground" data-testid="report-total-scope">
        {groups.length === 0
          ? `この表に出ている群は0件です。下の合計は、ページを切る前の全 ${totalGroups} 群を数えた値です。`
          : `この表に出ているのは ${rangeStart}–${rangeEnd} 群目です。下の合計は、ページを切る前の全 ${totalGroups} 群を数えた値であり、いま表に出ている ${groups.length} 群ぶんの合計ではありません。`}
      </p>
      <p className="text-note text-muted-foreground" data-testid="report-totals">
        {totals
          .map((total, index) => {
            const column = columns.find(
              (candidate) => candidate.target === "aggregate" && candidate.index === index,
            );
            /*
             * **表の中と同じ関数を通す**(`V8-M12-T03`)—— **`String(total.value)` を
             * ここに残すと、同じ数が表の中では `987,654 円`・全体の合計では `987654` と
             * 出て、書式が画面の中で2つに割れる。**
             */
            return `${column?.label ?? (total.type === "count" ? "件数" : "合計")}: ${aggregateText(
              total.value,
              column?.unit,
            )}`;
          })
          .join(" / ")}
      </p>
    </div>
  );

  /**
   * **グラフ**(`V8-M12-T04`。台帳 `Q-G23` / `Q-G27`。ユーザ決定 `D-V8-131`)。
   *
   * - **`ready` の中、かつ群が1つ以上あるときだけ描く**(決定22)——
   *   **`loading` と `error` の早期 return の内側には1本も置いていない。**
   * - **種別は宣言そのままである** —— **`"line"` なら折れ線、`"bar"` または
   *   **省略**なら棒。**画面の側で既定を持つ**(スキーマに `default` を書いていない)。
   * - **系列は集計列の全部である** —— **選ぶ口を1つも作っていない**(決定4)。
   * - **軸の数もツールチップの数も、表と同じ `aggregateText` を通す** ——
   *   **同じ数が表とグラフで違う文字列で出ないためである。**
   */
  const chartSeries = columns.filter((column) => column.target === "aggregate");
  const chartKind = view.report.chart ?? "bar";
  const chartLabels = groups.map((group) => groupKeyText(group.keys[0]));
  const chartUnit = chartAxisUnit(chartSeries);
  /**
   * **軸の目盛りとツールチップの数に当てる書式。**
   *
   * **表の中と同じ `aggregateText` を通す** —— **同じ数が、表では `987,654 円`・
   * グラフでは `987654` と出る形を作らない。**
   * **`null` は折れ線の「値が返っていない群」である**(点を1つも置いていない)——
   * **表と同じ見せ方をここでも使う。**
   */
  const chartValueText = (value: number | string | null): string =>
    aggregateText(value === null ? undefined : Number(value), chartUnit);
  /**
   * **横軸**(`V8-M12-T06`。メインの裁定「直す1」)。
   *
   * **棒と折れ線で同じこの1つを渡す** —— **2種で形を割らない**(割れているのは
   * 色の渡し方と説明の出し方の2つだけであり、そこにもう1つ足さない)。
   * **`tickValues` は「ラベルを出す群の位置」だけを絞る** —— **棒も線も点も1本も
   * 減らない**(`chartAxisTickValues` の doc)。
   */
  const chartAxisBottom = {
    tickValues: chartAxisTickValues(groups.length),
    format: (value: number | string) => chartLabels[Number(value)] ?? "",
  };
  const chartBlock =
    groups.length === 0 || chartSeries.length === 0 ? null : (
      <div
        /*
         * **画面幅への追随は `viewBox` と CSS で行う**(決定19)——
         * **クラス名はここにリテラルとして現れるものだけであり、マニフェストの値から
         * 1文字も生やしていない**(`ADR-0087` 限定6)。**色のクラスは1つも無い。**
         */
        className={cn("report-chart", "w-full [&>svg]:h-auto [&>svg]:w-full")}
        data-testid="report-chart"
        data-report-chart={chartKind}
        ref={fitChartToWidth}
      >
        {chartKind === "line" ? (
          <Line
            width={CHART_WIDTH}
            height={CHART_HEIGHT}
            margin={CHART_MARGIN}
            theme={CHART_THEME}
            // **折れ線は `var(--…)` の文字列をそのまま渡せる**(冒頭の追記節)。
            colors={SERIES_COLORS.slice(0, chartSeries.length)}
            data={chartSeries.map((column, seriesIndex) => ({
              id: seriesLabels(chartSeries)[seriesIndex] ?? "",
              data: groups.map((group, index) => ({
                x: String(index),
                // **値が返っていない群は点を1つも置かない**(0 として描かない)。
                y: group.aggregates[column.index]?.value ?? null,
              })),
            }))}
            xScale={{ type: "point" }}
            axisBottom={chartAxisBottom}
            axisLeft={{ format: chartValueText }}
            yFormat={chartValueText}
            /*
             * **当たり判定**(`V8-M12-T06`。メインの裁定「直す2」)。
             *
             * **`@nivo/line@0.99.0` の svg 既定は `useMesh: false` である**
             * (`svgDefaultProps`)—— **既定のままだと `mesh` 層が1つも描かれず、
             * 点を指してもツールチップを出す口が DOM に存在しない**(`T06` が chromium で
             * 実測。全6点の中心にマウスを移動しても `innerHTML` が1バイトも変わらなかった)。
             * **`enableSlices` と `isFocusable` は1つも触っていない** ——
             * **足したのはこの1つだけである。**
             */
            useMesh={true}
            ariaLabel="この集計表のグラフ(下の表と同じ数を描いています)"
          />
        ) : (
          <Bar
            width={CHART_WIDTH}
            height={CHART_HEIGHT}
            margin={CHART_MARGIN}
            theme={CHART_THEME}
            data={chartRows(groups, chartSeries)}
            keys={chartSeries.map((_, seriesIndex) => seriesValueKey(seriesIndex))}
            indexBy={CHART_INDEX_KEY}
            groupMode="grouped"
            /*
             * **`"bars"` を層から外し、`ChartBars` が棒を描く**(メインの裁定「決定23」)。
             * **`colors` を1つも渡していない** —— **渡すと `react-spring` が落ちる。**
             */
            layers={["grid", "axes", ChartBars]}
            axisBottom={chartAxisBottom}
            axisLeft={{ format: chartValueText }}
            ariaLabel="この集計表のグラフ(下の表と同じ数を描いています)"
          />
        )}
        {/*
          **凡例**(メインの裁定2)。**`D-V8-1` の例 (ii)「週単位の新規タスクと
          終わったタスク」は1つの集計表に2つの数を求めており、決定4 が「系列は集計列の
          全部」と決めた** —— **どの線がどの数か読めなければ、その例をグラフで
          満たしたことにならない。**

          - **HTML で出す** —— **`@nivo` の `legends` を1つも使っていない**
            (SVG の中に描くと、文字の折り返しも読み上げも器の作法から外れる)。
          - **棒でも折れ線でも、出るのはこの1つである** —— **2種で形を割らない。**
            **割れているのは色の渡し方だけである。**
          - **色は系列と同じ `SERIES_COLORS` を inline style で当てる** ——
            **2本目の色の表を作っていない。** **16進を1文字も書いていない。**
          - **系列名は表の列見出し(`reportColumns` の `label`)そのものである** ——
            **2本目の見出しの作り方を書き起こしていない。**
          - **系列が1本のときも出す** —— **「1本なら出さない」という分岐を作らない**
            (後から条件を足す口になる)。
        */}
        <ul
          className={cn("report-chart-legend", "flex flex-wrap gap-s3")}
          data-testid="report-chart-legend"
        >
          {chartSeries.map((column, seriesIndex) => (
            <li
              key={column.id}
              className="flex items-center gap-s1 text-note text-muted-foreground"
              data-testid="report-chart-legend-item"
              data-report-series={seriesIndex}
            >
              {/* **色見本は読み上げの対象にしない** —— **隣に系列名が文字で出ている。** */}
              <span
                aria-hidden="true"
                className="inline-block size-3 shrink-0"
                style={{ backgroundColor: SERIES_COLORS[seriesIndex] }}
                data-testid="report-chart-legend-swatch"
              />
              {column.label}
            </li>
          ))}
        </ul>
      </div>
    );

  /**
   * **ページ送り**(`D-V8-129`)。**群が1つも無いときは出さない** —— 一覧のページャと
   * 同じ条件である(総数だけが大きい状態でボタンだけが出る形を作らない)。
   * **幅への対応は既存の断点2本のうち `sm` 1本だけを使う**(`ADR-0089` 限定3)。
   */
  const pagerBlock =
    groups.length === 0 ? null : (
      <nav
        className={cn("report-pager", "flex flex-col gap-s2 sm:flex-row sm:items-center")}
        data-testid="report-pager"
        aria-label="ページ送り"
      >
        <Button
          variant="secondary"
          size="sm"
          className="w-full sm:w-auto"
          data-testid="report-prev"
          disabled={!hasPrev}
          onClick={() => setOffset(Math.max(0, offset - REPORT_PAGE_SIZE))}
        >
          前へ
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="w-full sm:w-auto"
          data-testid="report-next"
          disabled={!hasNext}
          onClick={() => setOffset(offset + REPORT_PAGE_SIZE)}
        >
          次へ
        </Button>
      </nav>
    );

  return (
    <section className={REPORT_VIEW_CLASS} data-testid="view-renderer-report_view">
      {totalBlock}
      {/* **上にグラフ・下に表**(`D-V8-131`)。**群が0件のときは `null` である。** */}
      {chartBlock}
      {groups.length === 0 ? (
        <p className="text-muted-foreground" data-testid="report-empty">
          束ねられた群は0件です。集計した結果そのものが0件でした。
        </p>
      ) : (
        <TableFrame data-testid="report-table">
          <Table className="report-table">
            <TableHeader>
              <TableRow>
                {columns.map((column) => {
                  const sorted = ariaSortFor(effectiveSort, column);
                  return (
                    <TableHead key={column.id} scope="col" aria-sort={sorted}>
                      {/*
                        **列ヘッダはボタンにする**(キーボードでも押せるように)——
                        **`web/src/ui/table.tsx` を1バイトも編集していない**(既存の `Button` を
                        `TableHead` の中に置いただけである)。**新しい部品を1つも作っていない。**
                        **向きの矢印は `aria-hidden` の `<span>` で出す** —— 読み上げには
                        `aria-sort` が既に出ており、同じことを二度言わせない。
                      */}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="bg-transparent px-0 font-medium"
                        data-testid="report-sort"
                        data-report-target={column.target}
                        data-report-index={column.index}
                        onClick={() => setPickedSort(nextReportSort(effectiveSort, column))}
                      >
                        {column.label}
                        {sorted === "none" ? null : (
                          <span aria-hidden="true">{sorted === "ascending" ? "▲" : "▼"}</span>
                        )}
                      </Button>
                    </TableHead>
                  );
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => (
                // **群は `_id` を持たない** —— **束ねたキーの組そのものが群の同一性である**
                // (同じキーの組を持つ群は2つ出ない)。
                <TableRow key={JSON.stringify(group.keys)} data-testid="report-row">
                  {columns.map((column) => (
                    <TableCell key={column.id}>
                      {column.target === "group_by"
                        ? groupKeyText(group.keys[column.index])
                        : aggregateText(group.aggregates[column.index]?.value, column.unit)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableFrame>
      )}
      {pagerBlock}
    </section>
  );
}
