/**
 * list_view の汎用コンポーネント(V0-P3-T04)。
 *
 * マニフェストの `columns` / `sort` / `filter` を **解釈して** 一覧表を描画する。
 * アプリごとに生成された表ではなく、どのマニフェストでもこの1つの表が使われる
 * (handover 3.7 / 憲法3)。したがってこのファイルにアプリ固有の名前は現れない。
 *
 * 方針として決めていること:
 *
 * - **並べ替え・絞り込みをフロントで実装しない。** `sort` / `filter` はそのまま
 *   レコードAPI のクエリに渡し、順序はサーバ(カーネル)が決めた順序をそのまま描く。
 *   同じ条件が MCP 経由でも HTTP 経由でも同じ結果になることを1箇所で担保するため。
 *
 *   **【`V4-M22-T02` / `ADR-0112` が射程を引き直した。旧文を1バイトも消していない】**
 *   **2026-08-03 に門A の本審査(`V4-M22` 単位A。判定 = 限定採用)を通り、`search_fields` を
 *   書いた画面にだけ「利用者が打った語」を条件に足せるようになった**(`buildSearchFilter`)。
 *   **したがって上の1文は、`search_fields` を書いた画面については今日から成り立たない** ——
 *   **その画面には、マニフェストに現れない条件(打たれた語)が1つ存在する。**
 *   **代償を隠さない**: **同じ表を MCP 経由で再現することはできない**(`ADR-0112` §限界5)。
 *   **引き直したのはここまでである** —— **並べ替えの側は1ミリも引き直していない**
 *   (列ヘッダのクリックで並べ替える経路は今日も1本も無い)。**組み立てた条件は必ず
 *   `view.filter` と `and` で結ばれ、利用者は親条件を1つも外せない**(限定9)。
 *   **打たれた語はマニフェストに1バイトも保存されない**(限定8)。
 *   **`search_fields` を書いていない画面では、この段落の内容は1つも発火しない。**
 * - **列ヘッダのクリックで並べ替える等の「画面上の表示操作」を持たない。** それは
 *   マニフェストに現れない表示状態であり、v0 では作らない(handover 3.10)。
 *   並び順を変えたいならマニフェストの `sort` を変える(= 差分として記録が残る)。
 *
 *   **【`V4-M19-T06` が射程を引き直した。旧文を1バイトも消していない】**
 *   **2026-08-04 に、上の1文は今日から成り立たない** —— **列ヘッダを押すとその列で
 *   並べ替わる**(門A の判定は「将来送り」で、本タスクはその送り先の履行である。
 *   **ADR は無く、台帳の1行だけがある**)。**ユーザ決定 `D-V4-79` の逐語**:
 *   「その場で変えられるようにする。**ただし保存はしない**」。
 *   **旧文のうち「マニフェストに現れない表示状態である」は今日も真である** ——
 *   **打たれた並び順はこの画面の一時状態(`useState`)であり、**
 *   **`offset`(ページ位置。`ADR-0042`)と同じ性質である**(先例に倣った。
 *   **新しい種類の状態を1つも作っていない**)。
 *   **後半の「並び順を変えたいならマニフェストの `sort` を変える(= 差分として記録が
 *   残る)」も今日も真である** —— **記録を残したいなら今日も差分しか無い。**
 *   **(C) 側(打った並び順をマニフェストに保存する形)は今日も1ミリも解けていない。**
 * - 表示形式は7型ぶんすべて `../fields/display.tsx` にある。ここは配置だけを持つ。
 *
 * **画面ごとの見せ方(ADR-0050)**: `view` に書かれた有限 enum を、`<section>` / `<col>` /
 * `<th>` / `<td>` の `data-preset-*` 属性として出す。**値を CSS 文字列として組み立てない。**
 * 当てる規則は `web/src/styles.css` の1箇所にあり、セレクタにアプリID・画面ID・
 * フィールドIDは1つも現れない(ADR-0050 の限定5 / 限定11)。**未指定の画面では属性も
 * `<colgroup>` も1つも出ないので、DOM は今日と1バイトも変わらない**(ADR-0051 限定4)。
 *
 * **セルの `<td>` はここが描く。** 列ごとの寄せは「配置」であって値の見せ方ではないので、
 * 配置を持つこのファイルが `<td>` の属性を出す。同じ形は `DetailViewRenderer` が `<dd>` で
 * 既に採っている。**表示関数に渡すのは軸7(`preset_text_preview`)の1つだけである**
 * (ADR-0050 限定10 が許した唯一の例外。V3-M2-T04)—— 切り詰めは切り詰めた文字列しか
 * DOM に出さないので、CSS では実装できない。**色・長さ・書体の実値は1つも渡さない。**
 * `ViewRendererProps` には props を1つも足していない(値は `view` の中に入っている)。
 *
 * **部品体系での描き直し(V4-M15-T03。ADR-0087 / ADR-0089)**: 器を `web/src/ui/` の部品
 * (`TableFrame` / `Table` / `TableHeader` / `TableBody` / `TableRow` / `TableHead` /
 * `TableCell` / `Button` / `Alert` / `Skeleton`)に置き換えた。**部品のクラスは既存クラスに
 * 「足す」形でしか入れていない** —— `.list-view` / `.list-table` / `.list-row` /
 * `.list-row-interactive` / `.list-total` / `.list-pager` / `.list-csv` / `.list-csv-result` /
 * `.list-detail-target-note` は1つも消していない(画面プリセットとテーマの当たり先である)。
 * **`data-preset-*` / `data-field` / `data-field-type` は1つも増やしていないし減らしていない。**
 *
 * **幅への対応は断点2本(`sm` = 40rem / `lg` = 64rem)だけである**(ADR-0089 限定3)。
 * ここで使っているのは `sm:` だけで、`lg:` は1つも使っていない。
 *
 * ## 一覧の器の形(V4-M16-T13。`P-G24` の (C) 側 / ADR-0093)
 *
 * **`preset_list_shape`(8つ目のプリセットキー。2値 enum)で、表とカードのどちらの器に
 * するかを画面ごとに選べる。** **既定は `table` であり、書かなかった画面は今日と1ピクセルも
 * 変わらない**(限定4。DOM の完全一致は `web/test/list-view-shape.test.tsx` の (d) が
 * 着手前の DOM そのもの〔`web/test/__fixtures__/list-view-plain.html`〕で固定する)。
 *
 * **【器を作ったのは本タスクである】** ADR-0093 限定6 は「器は `V4-M15-T15` が作る」と
 * 書いているが、**`docs/plan/v4/records/v4-m15-t19.md` §T15 の 3 が「器を作っていない」と
 * 申告している。** **したがって宣言と器を同じ差分で作ったのは `V4-M16-T13` である。**
 * **【禁止】「`V4-M15` が器を作った」と書かない。**
 *
 * **マニフェストの値からクラス名を生やさない**(限定9 = ADR-0087 限定6)—— **ここは
 * 有限 enum(2値)を分岐して、ソースにリテラルとして現れるクラス名を選ぶだけである。**
 * **`data-preset-*` 属性を1つも増やしていない**(器の選択は CSS の属性セレクタではない)。
 * **safelist を1行も置いていない。**
 *
 * **`.list-view` の直下の子の並びは1つも増減しない** —— **`card` のときは `list-table` の
 * 位置に `data-testid="list-cards"` が立つ**(件数表示とページャの位置の固定を壊さない。
 * `web/test/preset-coverage.test.ts` の `sectionOrder()` と `web/e2e/preset.e2e.ts`)。
 *
 * ### 当たり方の表(`ADR-0093` 限定7)—— **先に決めて書く**(ADR-0050 §4 と同じ形)
 *
 * | 対象 | `preset_list_shape` が当たるか | 根拠 |
 * |---|---|---|
 * | `list_view` の一覧そのもの(`.list-view` の中の表 / カード) | **当たる** | 本キーは `list_view` にだけ書ける(`allOf` の他2分岐は `false`) |
 * | `detail_view` の `related` の子一覧(`.related-table`) | **当たらない** | **`related` は `detail_view` の中の定義であり、本キーを書く場所がそもそも無い。** 加えて器の分岐はこのファイルの中にしかなく、`RelatedList`(`DetailViewRenderer.tsx`)を1バイトも変えていない |
 * | `detail_view` の項目そのもの(`.detail-fields`) | **当たらない** | 同上(`detail_view` 分岐で `false`) |
 * | 入力フォーム(`.record-form`) | **当たらない** | 同上(form 分岐で `false`) |
 *
 * **代償**: **子一覧をカードで出すことはできない**(`ADR-0093` §Decision 4 の 4 の門)。
 *
 * ### 【正直に書く】`card` のとき効かない軸がある(限定8)
 *
 * **`preset_column_align` / `preset_column_width` は列の軸であり、カードには列が無い。**
 * **したがって `card` と一緒に書いても効かない。** **機械では止めていない** —— 止めるには
 * 型とプリセットの対応検査が要り、それは今日この製品に1つも無い(MCP の説明文が既に
 * その穴を認めている)。**「書けるが効かない」を黙って作らないことだけを義務にしており、
 * `src/mcp/vocabulary.ts` が明記している。**
 */
import { useEffect, useMemo, useState } from "react";
import type {
  // **`DetailView` の型 import は `V10-M18-T02`(`FU-G2`)で落とした**(唯一の読み手だった
  // `linkedReferenceColumns` を撤去したため。`biome` の `noUnusedImports` が error である)。
  Field,
  ListView,
  Manifest,
  ResourceId,
  Sort,
  // **マニフェストのテーブル定義**。部品体系の `Table`(器)と名前がぶつかるので別名にする
  // —— **どちらの意味も1バイトも変えていない**(器は `../ui/table.tsx` の `Table`)。
  Table as TableDefinition,
} from "../../../src/kernel/types.ts";
// **「誰の行か」の規約は `src/server/owner-scope.ts` 1本である**(`V4-M19-T09`)——
// **表示層に同じ規約を再実装しない**(`web/src/auth/authz.tsx` が採った案(i)と同じ形。
// 実行時依存は増えていない —— このファイルは既に `authz.tsx` 経由で同じ物を辿っている)。
import {
  // **【`V10-M3-T01(a)`】直接作成の遮断(`st_no_direct_create`)の規約は、この1本が唯一の家である**
  // —— **表示層に3条件(id / type / `required` を書かない)を書き写さない。**
  isDirectCreateSuppressed,
  OWNER_FIELD,
  personalOwnerField,
} from "../../../src/server/owner-scope.ts";
import {
  fetchRecordPage,
  fetchRecords,
  isApplyInProgress,
  isForbidden,
  isWriteConflict,
  type RecordRow,
  type Role,
  // **【`V14-M2-T01` / `RB-G1`】行1件ぶんの判定の型**(`ADR-0402` §Decision 4)。
  type RowAccess,
  // **【`V5-M25-T08` / `L-G8`】手動起動の入口を叩く1本**(`ADR-0176` 限定1: 入口は HTTP に1本)。
  runViewAction,
  // **【`V5-M25-T07` / `L-G3`】一覧の行の set 形は、既存のレコード更新経路をそのまま通る**
  // (`ADR-0171` 限定10 の順序拘束が解けた)—— **新しい書込経路を1本も作っていない。**
  updateRecord,
  type ValidationError,
  writeRecordsBatch,
} from "../api.ts";
import { type AsyncState, toValidationErrors } from "../async.ts";
import {
  canUseAction,
  canUseView,
  canWriteRole,
  // **【`V8-M27-T04` / `T-G5`】`isReservedRole` の import は撤去した**
  // (`isPlatformPortAudience` ごと消えた)。
  useActorId,
  useRole,
  viewIdForRecordRequest,
} from "../auth/authz.tsx";
import { ErrorList } from "../ErrorList.tsx";
import { FieldValue, referenceLinkTarget } from "../fields/display.tsx";
import {
  buildReferenceLabelIndex,
  type ReferenceLabelIndex,
  resolveReference,
} from "../fields/reference-label.ts";
// **`DetailTargetNote` の import は `V10-M18-T02`(`FU-G2`)で落とした** ——
// **呼び出しを撤去したので、残すと `biome` の `noUnusedImports` が error になる。**
// **`resolveDetailViewTarget` は残っている**(行の遷移先を決めるのは今日も同じ1本である)。
import {
  navigate,
  ReferenceLinkScope,
  resolveDetailViewTarget,
  resolveRowActionDestination,
} from "../navigation.tsx";
import { isSystemTableId, resolveViewTable, viewTargetIds } from "../table-resolution.ts";
import { Button } from "../ui/button.tsx";
import { Checkbox, Input, Label, Select } from "../ui/form-controls.tsx";
import { Alert, Skeleton } from "../ui/surfaces.tsx";
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
// **打った語から `filter` を組み立てる規則は、製品にただ1本しか無い**
// (`V4-M22-T02` / `ADR-0112` 限定7・限定9。`V6-M4-T01` が共有先へ切り出した)。
// **【`V14-M2-T04`】形 → 動詞の写像は製品にちょうど1本である**(`ADR-0402` 線2)——
// **一覧の側に2本目を書かない。** **詳細画面(`DetailViewRenderer.tsx`)も同じ1本を呼ぶ。**
import { rowAccessAllows, rowActionVerb } from "./row-action-verb.ts";
import { buildSearchFilter } from "./search-filter.ts";
import type { ListViewRendererProps } from "./types.ts";
import { visibleWhenMatches } from "./visible-when.ts";

/**
 * 画面の器そのものに当てる体裁。**`list-view` は消さずに足す**(プリセットの当たり先)。
 * **座標系のプロパティを1つも使っていない**(ADR-0087 限定8)。
 */
const LIST_VIEW_CLASS = cn("list-view", "flex flex-col gap-s3 font-sans text-foreground");

/**
 * 1ページに読む件数(EC-G11 / ADR-0042)。ページ位置(offset)はこの画面の一時状態であって
 * マニフェスト(list_view 定義)には保存しない —— 自己完結性を保つための D-G11 の帰結である。
 */
const PAGE_SIZE = 50;

/**
 * **この画面が1ページに読む件数を1つに解決する**(`V4-M22-T06`。`ADR-0113` 限定2 / 限定10)。
 *
 * **既定は `PAGE_SIZE`(= 50)であり、書かなかった画面は今日と1ピクセルも変わらない**
 * (限定10)。**`50` と明示しても同じ値に落ちるので、DOM は1バイトも変わらない。**
 *
 * **解決は1箇所だけである** —— **取得の `limit` / ページャを出す条件 / ページ送りの幅の
 * 4箇所が、必ずこの1つの値を使う。** **2つの数を作らない**(片方だけ 50 のままだと、
 * 「10件ずつ出るのにページャが50件を超えるまで出ない」ような食い違いが起きる)。
 *
 * **`schemas/` に `default` を書いていない** —— **既定はここが持つ**(既定を2箇所に
 * 住まわせない)。**値域(4値の enum)の判定はここでは1つも行わない** —— **それは
 * `schemas/` が閉じており、判定を2箇所に住まわせない。**
 *
 * **ページ位置(`offset`)は今日どおり画面の一時状態であり、マニフェストに1バイトも
 * 保存しない**(`ADR-0042` 限定2 / §3a-2 不可侵)。
 */
function resolvePageSize(view: ListView): number {
  return view.page_size ?? PAGE_SIZE;
}

// ---------------------------------------------------------------------------
// 一覧を見ている人が、その場で並び順を変える(`V4-M19-T06`。ユーザ決定 `D-V4-79`)
// ---------------------------------------------------------------------------

/**
 * **打たれた並び順を1つに解決する**(`V4-M19-T06`)。
 *
 * **門A の判定は「将来送り」であり、本タスクはその送り先の履行である。ADR は無い(台帳1行)。**
 * **ユーザ決定 `D-V4-79` の逐語**: 「その場で変えられるようにする。**ただし保存はしない**」。
 *
 * ## **サーバに投げ直す**(取得済みの行をフロントで並べ替えるのではない)
 *
 * **理由はページネーション(`ADR-0042`。`offset` + `limit`)との噛み合わせである** ——
 * **フロントで並べ替えると「いま見えている1ページの中だけ」が並び替わり、2ページ目には
 * 効かない。** 1ページ目に「最大の値」が居るように見えて、実は2ページ目にもっと大きい値が
 * 居る、という**嘘の表**ができる。**したがって打たれた並び順は `options.sort` に載せて
 * レコードAPI へ渡し、順序はサーバ(カーネル)が決めた順序をそのまま描く** ——
 * このファイル冒頭の「順序はサーバが決めた順序をそのまま描く」は今日も真である。
 *
 * **同じ理由で、並び順を変えたら先頭ページへ戻す** —— 既存の `viewKey` に打たれた並び順を
 * 含めるだけで、**既存の仕組みがそのまま `offset` を 0 に戻す**(新しい reset の仕組みを
 * 1つも作っていない)。
 *
 * ## 【解けないこと。先に書く】
 *
 * 1. **次に画面を開いたときには `view.sort` に戻る。** **記録に1バイトも残らない** ——
 *    マニフェストにも `localStorage` にも `sessionStorage` にも URL にも Cookie にも
 *    サーバにも保存しない(保存するコードを1行も書いていない)。
 * 2. **複合ソート(2列以上の組)は打てない** —— 打てるのは1列だけである。**宣言が複合
 *    (`Sort[]`)でも、押した瞬間にその1列だけの並びへ丸ごと置き換わり、2列目以降の
 *    キーは消える。** **印(`aria-sort`)を出すのも先頭キーの列だけである** ——
 *    2列に印を出すと、押して打てるもの(1列)と印が食い違う。
 * 3. **カードの器には並べ替えの口が無い**(`preset_list_shape: "card"` には列ヘッダが
 *    そもそも無い)。**機械では止めていない** —— カードで並び順を変えたいなら、今日も
 *    マニフェストの `sort` を書き換えるしかない。
 */
function activeSortKey(sort: Sort | Sort[] | undefined): Sort | undefined {
  if (sort === undefined) {
    return undefined;
  }
  // **正規化の唯一の入口(`normalizeSort`)と同じ読み方をする** —— 配列の先頭が第1キーで
  // ある(`src/kernel/types.ts` の `Sort` の定義)。**ここに2本目の解釈を作らない。**
  return Array.isArray(sort) ? sort[0] : sort;
}

/** その列の `<th>` に出す `aria-sort`。**並べ替えの対象でない列には `none` を出す。** */
function ariaSortFor(
  active: Sort | undefined,
  fieldId: string,
): "ascending" | "descending" | "none" {
  if (active === undefined || active.field !== fieldId) {
    return "none";
  }
  return active.order === "asc" ? "ascending" : "descending";
}

/**
 * 押されたときに打つ並び順。**同じ列なら向きを反転し、別の列なら昇順から始める。**
 *
 * **宣言(`view.sort`)の向きを引き継がない** —— 引き継ぐと「降順で宣言された列を1回
 * 押したら昇順になる列」と「昇順から始まる列」が混ざり、押した結果が予測できなくなる。
 */
function nextSort(active: Sort | undefined, fieldId: ResourceId): Sort {
  if (active !== undefined && active.field === fieldId && active.order === "asc") {
    return { field: fieldId, order: "desc" };
  }
  return { field: fieldId, order: "asc" };
}

// ---------------------------------------------------------------------------
// プラットフォームが常設する口を誰に出すか(`V4-M19-T10`)
// ---------------------------------------------------------------------------

/**
 * **その相手に、プラットフォームの管理ツールの口を出すか**(`V4-M19-T10`)。
 *
 * **門A の判定は「将来送り」であり、本タスクはその送り先の履行である。ADR は無い(台帳1行)。**
 *
 * **これは `owner` 限定ではない** —— **owner / editor / viewer には今日どおり出る。**
 * **`ADR-0025` §10-2 の判断(無認証の API を owner パネルに置くと UI が嘘をつく)を1ミリも
 * 覆していない**(その逐語は `web/src/AppWorkspace.tsx` の「**owner 限定にしない。**」2箇所に
 * 残っている)。**足したのは「買い物客(`customer`)と未ログインには出さない」分岐だけである。**
 *
 * **先例はこのリポジトリの中にある** —— `DetailViewRenderer` の「閲覧のみ(書き込み権限が
 * ありません)」の注記が、`E-G20` / `V4-M6` で「**編集できる想定の人が編集できないときだけ
 * 出す**」に絞られた(判定は `web/src/auth/authz.tsx` の `isWriteAudienceRole`)。理由は
 * 「**そもそも編集する立場に無い相手に管理ツールの文言を出すと、店の画面ではなく管理ツールの
 * 画面に見えた**」である。**CSV の書き出しは、まさに管理ツールの口である。**
 *
 * **`null`(`RoleProvider` の外 = 未ログインで開いた画面 / 単体で描いたレンダラ)も出さない**
 * —— `ADR-0074` 限定6 が `canWriteRole(null, table)` を `false` に反転させたのと同じ向きで
 * ある(**匿名に画面を開ける経路が実在するので、`null` を「分からない」のまま素通りさせると
 * 買い物客の画面に管理ツールの口が出る**)。
 *
 * **判定の式は `web/src/AppWorkspace.tsx` の `platformPortAudience` と同じ形である** ——
 * **共有関数を作っていない**(`web/src/auth/authz.tsx` は本タスクの担当ファイルではなく、
 * そこに述語を足すのは新しい規約を1つ作ることになる)。**片方を変えたらもう片方も変えること。**
 * **`AppWorkspace.tsx` の側には `null` の枝が無い** —— あちらは認証済みの subtree にしか
 * 現れず、未ログインは `AnonymousWorkspace` が3つの口を1つも描かないためである。
 *
 * ## 【正直に書く】これは遮断ではない
 *
 * **`customer` が UI を迂回して API を直接叩けば、今日どおり読める** —— CSV は**画面が
 * 既に持っている行**を文字列にしているだけであり、その行はレコードAPI が返したものである。
 * **UI が見せるものは API が許すものより狭い、という状態が残る。UI は担保ではない。**
 *
 * ## 【解けないこと】この口を出す / 出さないをアプリは選べない
 *
 * **マニフェストには1バイトも書けない。** **理由は `ADR-0007` §1b の Δ4 である** ——
 * 「CSV の書き出しを出す」ようなキーを語彙に足すと、**マニフェストの語彙がプラットフォームの
 * 内部機能の名前に依存し、自己完結性を失う。** **【禁止】「アプリが常設の口を選べるように
 * なった」と書かない。**
 */
// --- 【`V8-M27-T04` / `T-G5`】**判定の中身を撤去した。上の doc も旧の本体も1バイトも消していない** ---
//
// **旧の本体(逐語)**:
//
//     function isPlatformPortAudience(role: Role | null): boolean {
//       // **【`V5-M17-T05` / `G-G7` / `ADR-0158` 限定2】`role !== "customer"` の等値比較を
//       // `isReservedRole` に置き換えた。****宣言された種類にも常設の口を出さない** ——
//       // **宣言された種類の扱いは `customer` と同一である。**
//       return isReservedRole(role);
//     }
//
// **今日は常に `true` である。** **`null`(`RoleProvider` の外 = 未ログインで開いた画面 /
// 単体で描いたレンダラ)も含めて、CSV の書き出し口を出す。**
//
// **【正直に書く。これは広がりであって、狭まりではない】** **買い物客(非運営の役割)にも
// 未ログインにも CSV の書き出し口が出るようになった。** **`E-G20` / `V4-M6` の系譜が
// 「そもそも編集する立場に無い相手に管理ツールの文言を出さない」として消した導線が、
// 1つ戻ったことになる。**
//
// **なぜ戻したか**: **本タスクの射程は「運営(予約3ロール)か否かで可否を決める層の撤去」で
// あり、この判定はその層の最後の1本だった。** **役割の綴りを使わずに同じ出し分けを書く
// 手だては、今日の面(`app.roles[].rules`)の語彙には無い** —— **面が名指しできるのは
// 表・画面・ボタン・項目の4つで、「プラットフォームの常設の口」はそのどれでもない。**
// **【禁止の履行】これを「同じ挙動を保った」と書かない。**
//
// **【これは遮断ではない。旧 doc の該当節は今日も真である】** **CSV は画面が既に持っている
// 行を文字列にしているだけであり、その行はレコードAPI が返したものである** ——
// **面が読取を許していない表の行は、そもそも画面に1行も届かない。**
function isPlatformPortAudience(_role: Role | null): boolean {
  return true;
}

// ---------------------------------------------------------------------------
// 画面で選んでまとめて操作する(`V4-M20-T03`。単位C の**将来送りの送り先**)
// ---------------------------------------------------------------------------

/**
 * **これは何で、何ではないか**(`docs/plan/v4/records/v4-m20.md` §4-3 / §2-1 の `T03`)。
 *
 * **門A の判定は「将来送り」であり、本タスクはその送り先の履行である。個別 ADR は無い**
 * (`ADR-0007` §6 の閾値により台帳1行)。**限定表の正になる文書が存在しないので、決めた形は
 * 本ファイルの実装コメントと `web/test/list-bulk-update.test.tsx` の2箇所にしかない。**
 *
 * ## 決めた形(**宣言ではない**)
 *
 * - **アプリは1つも選べない。** **マニフェストに1バイトも書けない**(`schemas/` の差分は
 *   0行である)。**全アプリの全一覧が同じ挙動になる。**
 * - **業務の言葉のボタンにならない** —— 出るのは「まとめて操作」という一律の文言である。
 * - **選べるのは、いま画面に出ているページの行だけである。** **「絞り込んだ結果の全件を
 *   選ぶ」は1ミリも解けない**(`resolvePageSize` が返す件数ぶんしか画面に無い)。
 * - **書けるのは1つのフィールドを1つの値にすることだけである** —— 複数フィールドを同時に
 *   書き換えることも、行ごとに違う値を入れることもできない。
 * - **削除はできない。** **足したのは更新の1形だけである。**
 *
 * ## 越えていない線(**発注が名指しした線**)
 *
 * - **「絞り込んだ結果の全件を外に書き出す」を1バイトも実装していない** —— **`E-G62`
 *   (CSV 全件書き出し)について門A は判定を1つも下しておらず**(`v4-m20.md` §6-2 3)、
 *   **`docs/plan/v4/01-boundary-baseline.md` のスコープ外の表と正面から当たる。**
 *   **新しい取得ループを1本も開いていない**(完了条件5)。
 * - **`src/kernel/` にも `schemas/` にも1バイトの差分が無い**(完了条件1 / 2)。
 *
 * ## 【正直に書く】これは遮断ではない
 *
 * **書けるのは editor / owner だけである** —— それを決めているのは**サーバの
 * `batchAuthMiddleware`** であって、この表示層のガードではない。**表示層が選べたことは
 * 書けることではない**(完了条件7)。**`writable_by`(`ADR-0076`)で書けない項目も、
 * 他人の個人行(`st_owner`)も、この画面は選ばせるが、サーバが拒む。**
 */
function canBulkUpdateRole(role: Role | null): boolean {
  // **サーバの `batchAuthMiddleware` の逐語**「書込は editor/owner のみ(viewer / customer は
  // 403)。バッチに公開/匿名窓は開けない。」**先回りガードであり、判定の家はサーバである。**
  return role === "editor" || role === "owner";
}

/**
 * **まとめて書き換えの対象にできるフィールド**(`V4-M20-T03`)。
 *
 * **`reference` と `image` と `file` は外す** —— どれも値が id(`_id` / `file_id`)であり、
 * **人が打つ値ではない。** **`select` は選択肢から、`boolean` は2値から選ばせる。**
 * **`writable_by` で絞っていない** —— **絞ると同じ判定が表示層とサーバの2箇所に住む**
 * (`web/src/auth/authz.tsx` のヘッダが禁じた形)。**書けるかどうかはサーバが決める。**
 *
 * **【`V5-M16-T05`】`file` を外した。** **`file` の値は `_files.file_id` であり、
 * アップロードして初めて生まれる** —— **打てる値ではない。**
 * **`export` にしたのは検査(`web/test/file-field.test.tsx`)から直に呼ぶためである。**
 */
export function bulkEditableFields(table: TableDefinition | undefined): Field[] {
  if (table === undefined) {
    return [];
  }
  return table.fields.filter(
    (field) => field.type !== "reference" && field.type !== "image" && field.type !== "file",
  );
}

/**
 * 打たれた文字列を、そのフィールドの型の値に変える(**新しい構文を1つも作らない**)。
 *
 * **変換できないものは `undefined` を返し、画面はそれを送らない** —— **黙って別の値を
 * 送らない**(`number` に打った「abc」を 0 にする、のような変換をしない)。
 * **空文字は `null`(未設定)である** —— レコードAPI の既存の意味論そのままである。
 */
function bulkValueFor(field: Field, raw: string): string | number | boolean | null | undefined {
  if (raw === "") {
    return null;
  }
  if (field.type === "number") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (field.type === "boolean") {
    return raw === "true" ? true : raw === "false" ? false : undefined;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// 一覧の中で自分の行が分かる(`V4-M19-T09`)
// ---------------------------------------------------------------------------

/**
 * **その行が「見ている本人の行」か**(`V4-M19-T09`)。
 *
 * **門A の判定は「将来送り」であり、本タスクはその送り先の履行である。ADR は無い(台帳1行)。**
 *
 * **規約を再実装していない** —— 個人所有テーブルの判定は `personalOwnerField`、所有者の
 * 置き場は `OWNER_FIELD`(`src/server/owner-scope.ts`)である。
 *
 * **共有の行(`st_owner` が null / 空)は本人の行ではない** —— 誰のものでもない行に
 * 「あなたの行です」と印を付けない(`isOwnerVisible` は共有行にも真を返すので、**あの述語は
 * ここでは使えない** —— あちらの問いは「見えるか」であって「誰のものか」ではない)。
 *
 * ## 【解けないこと。先に書く】
 *
 * 1. **`st_owner` を持たないテーブルでは効かない** —— **DOM は今日と1バイトも変わらない。**
 * 2. **強調の見た目をアプリが選べない** —— **プラットフォームが1通りに決める**
 *    (`web/src/styles.css` / `web/src/tailwind.css` に1バイトも書いていない。当てるのは
 *    既存の Tailwind ユーティリティだけである)。**理由は `ADR-0007` §1b の Δ4 と同じで
 *    ある** —— 「自分の行の色」をマニフェストに書けるようにすると、語彙がプラットフォームの
 *    内部機能の名前に依存する。
 * 3. **`actorId` が渡っていない(未ログイン / `RoleProvider` の外)ときは何も起きない。**
 * 4. **印は地色と字の太さだけである** —— **読み上げには1バイトも出ない**(`data-own-row` は
 *    支援技術に読まれる属性ではない)。**色だけに頼っている代償は残る。**
 * 5. **地色は hover と同じスロット(`--color-surface-highlight` = `bg-accent`)である** ——
 *    **マウスを乗せた行と自分の行は同じ色に見える。** 新しい色のスロットを1つも足さない
 *    (`$defs/theme` は今日も 25 / 25)ための代償であり、隠さない。
 */
function isOwnRow(ownerFieldPresent: boolean, record: RecordRow, actorId: string | null): boolean {
  if (!ownerFieldPresent || actorId === null) {
    return false;
  }
  return record[OWNER_FIELD] === actorId;
}

/**
 * 自分の行に当てる体裁。**ソースにリテラルとして現れるクラス名だけである**
 * (`ADR-0087` 限定6 —— マニフェストの値からクラス名を生やさない)。
 *
 * **`ADR-0090` の `emphasis`(値の色)と当たり先が衝突しない** —— **`emphasis` はセルの中の
 * `<span class="field-emphasis">` に色を当てる**(`web/src/fields/display.tsx`)のに対し、
 * **ここが触るのは行(`<tr>`)とカード(`<div>`)の側だけである。** 同じ要素に2つの色が
 * 当たることは無く、`emphasis` の付いたセルは自分の行の中でも今日と同じ色で出る。
 */
const OWN_ROW_CLASS = "bg-accent font-medium";

// ---------------------------------------------------------------------------
// 検索の口(V4-M22-T02。`E-G7` の (C) 側 / ADR-0112)
// ---------------------------------------------------------------------------

// **【`V6-M4-T01` / `K-G11`】`buildSearchFilter` の本体はここから
// `./search-filter.ts` へ移した(**中身は1バイトも変えていない。移しただけである**)。**
// **参照項目の絞り込み(`web/src/fields/input.tsx`)も同じ1本を呼ぶ** ——
// **規則を2箇所に住まわせない。** 移した理由と、承知して受ける代償
// (`v6-m0.md` §7-5 の `S3` 1)は移動先の doc コメントに書いた。

// ---------------------------------------------------------------------------
// CSV の書き出し(V3-M12-T09)
// ---------------------------------------------------------------------------

/**
 * **書き出せるのは「いま画面に出ているページ」だけである**(V3-M12-T00 の裁定 (i))。
 *
 * レンダラは常に**その画面に解決した件数**(`resolvePageSize`。既定は `PAGE_SIZE` = 50。
 * `V4-M22-T06` / `ADR-0113`)しか取得していないので、書き出しは**取得済みの行を
 * 文字列にするだけ**であり、**サーバへ問い合わせ直さない**。これは性能の都合ではなく
 * **可視性の都合**である —— `st_owner` の可視性は post-filter(`src/server/owner-scope.ts`。
 * サーバが全行を読んでから除外し、`app.ts` が `slicePage(visible, limit, offset)` で
 * ページを切り出す)なので、**画面が持っている行は既に post-filter を通った行だけ**である。
 * 書き出しが新しい取得経路を開かない限り、**他人の行を書き出す経路は存在しない**。
 * **全件を書き出すには追加の取得ループが要り、post-filter と offset の相互作用を
 * 測り直すことになる。本タスクはそこへ踏み込まない**(50件だけを書き出す)。
 *
 * **形は「コピー」であってダウンロードではない。** `web/src/` に `createObjectURL` /
 * `download=` / `new Blob(` は各0件であり(実測)、持ち出しの先例は
 * `RequirementsDocPanel` と `ThemeExportPanel` の2本のコピーボタンである。
 * **ファイルは1つも作られない。**
 */
const CSV_NEWLINE = "\r\n";

/** RFC4180: 区切り・引用符・改行を含む値だけを二重引用符で囲み、内側の `"` を2つにする。 */
function csvField(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * 1セルぶんの値。**画面の整形ではなく、保存されている値そのものを書く。**
 *
 * 画面(`fields/display.tsx`)は人間向けに整形する —— `number` は桁区切り、`date` は
 * 日付部分だけ、`long_text` は切り詰め、`boolean` は記号、`null` は「未設定」。
 * **CSV でそれをやると値が壊れる**(桁区切りの `,` は CSV の区切りと衝突し、切り詰めた
 * 本文は元に戻せない)。**したがって整形は1つも掛けない。** `null` は空欄にする。
 *
 * **例外は `reference` だけである** —— `_id` を書いても読み手には何も分からないので、
 * 画面と同じ代表値を出す。**代表値の決め方は `reference-label.ts` の唯一の実装を使う**
 * (2本目を作らない。同じレコードが2つの顔を持たないための既存の約束である)。
 */
function csvValue(field: Field, value: unknown, referenceLabels: ReferenceLabelIndex): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (field.type === "reference") {
    return resolveReference(referenceLabels, field.reference_table, String(value)).text;
  }
  return String(value);
}

/** 見出し行(列の表示名)+ 現在ページの行。**列も順序も画面と同じものを使う。** */
function buildCsv(
  columns: Field[],
  records: RecordRow[],
  referenceLabels: ReferenceLabelIndex,
): string {
  const lines = [columns.map((field) => csvField(field.name)).join(",")];
  for (const record of records) {
    lines.push(
      columns
        .map((field) => csvField(csvValue(field, record[field.id], referenceLabels)))
        .join(","),
    );
  }
  return `${lines.join(CSV_NEWLINE)}${CSV_NEWLINE}`;
}

/**
 * 書き出しの口。**`<table>` の `<caption>` に置く。**
 *
 * `.list-view` の**直下の子**の並びは `web/test/preset-coverage.test.ts` と
 * `web/e2e/preset.e2e.ts` が `toEqual` で固定している(件数表示とページャの位置。
 * ADR-0050 の軸3)。直下に要素を1つ足すとその固定が壊れるので、**表の口は表の中に置く。**
 * `<caption>` は `<table>` の最初の子でなければならないので `<colgroup>` より前に出す。
 *
 * **0件のときは表そのものが描かれないので、この口も出ない**(書き出す行が無い)。
 * **スタイルは1つも足していない**(`web/src/styles.css` に差分0 = ADR-0049 と衝突しない)。
 */
function CsvCopyCaption({
  columns,
  records,
  referenceLabels,
}: {
  columns: Field[];
  records: RecordRow[];
  referenceLabels: ReferenceLabelIndex;
}) {
  return (
    // **`caption-side` は既定(上)のまま**にする —— 部品体系の `Table` は shadcn 既定の
    // `caption-bottom` を持つので、`Table` の側で `caption-top` に戻してある。
    // **`<caption>` に `display` を1つも与えない**(表の caption でなくなるため)。
    <caption className={cn("list-csv", "py-s1 text-left")}>
      <CsvCopyControls columns={columns} records={records} referenceLabels={referenceLabels} />
    </caption>
  );
}

/**
 * **カードのときの書き出しの口**(V4-M16-T13。`ADR-0093`)。
 *
 * **`<caption>` は表の中にしか置けないので、器だけを差し替える。** 置き場は
 * **カードの器(`.list-cards`)の中**である —— `.list-view` の**直下の子**の並びは
 * `web/test/preset-coverage.test.ts` と `web/e2e/preset.e2e.ts` が `toEqual` で固定して
 * いるので、直下に要素を1つ足すとその固定が壊れる。**表のときと同じ理屈で、口は器の中に置く。**
 *
 * **`data-testid` は1つも落としていない**(`list-csv-copy` / `list-csv-result` は同じ)。
 * **中身(`CsvCopyControls`)は表のときと1バイトも同じものを使う** —— 2本目の実装を作らない。
 */
function CsvCopyBlock({
  columns,
  records,
  referenceLabels,
}: {
  columns: Field[];
  records: RecordRow[];
  referenceLabels: ReferenceLabelIndex;
}) {
  return (
    <div className={cn("list-csv", "py-s1 text-left")}>
      <CsvCopyControls columns={columns} records={records} referenceLabels={referenceLabels} />
    </div>
  );
}

/**
 * 書き出しの口の**中身**。器(`<caption>` か `<div>` か)だけが呼び出し側で変わる。
 *
 * **着手前はこの中身が `CsvCopyCaption` の本体に直接書かれていた。** 器を2つ持つために
 * 中身を切り出しただけで、**DOM も文言も testid も1バイトも変えていない**
 * (表のときの完全一致は `web/test/list-view-shape.test.tsx` の (d) が固定する)。
 */
function CsvCopyControls({
  columns,
  records,
  referenceLabels,
}: {
  columns: Field[];
  records: RecordRow[];
  referenceLabels: ReferenceLabelIndex;
}) {
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        data-testid="list-csv-copy"
        onClick={() => {
          // クリップボードは環境によって使えない(非セキュアコンテキストなど)。
          // 使えなかったことを黙って隠さず、失敗として出す(憲法6)。形は
          // `ThemeExportPanel` の `CopyThemeCssButton` と同一である。
          const clipboard = navigator.clipboard as Clipboard | undefined;
          if (clipboard === undefined) {
            setCopied(false);
            return;
          }
          void clipboard.writeText(buildCsv(columns, records, referenceLabels)).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
      >
        このページを CSV でコピー
      </Button>
      {copied !== null && (
        <span
          className={cn("list-csv-result", "ml-s2 text-note text-muted-foreground")}
          data-testid="list-csv-result"
        >
          {copied
            ? "コピーしました(いま表示しているページの行だけです)。"
            : "コピーできませんでした。"}
        </span>
      )}
    </>
  );
}

/** 一覧の描画に必要な、取得済みのデータ一式。 */
type ListData = {
  records: RecordRow[];
  /** filter 適用後の総件数(ページャの位置表示・続きの有無に使う)。 */
  total: number;
  /**
   * **`total` とまったく同じ母集団についての合計**(`V4-M23-T03` / `ADR-0104` 限定5)。
   *
   * **今見えている1ページの合計ではない。** **サーバが返さなかったときは `undefined`** ——
   * **`0` に倒さない**(倒すと「合計は0だった」という嘘になる)。**`undefined` のとき
   * 画面は合計を1つも描かない。**
   */
  sum?: number;
  /**
   * **行ごとの判定**(`V14-M2-T01`。鍵は行の `_id`。`ADR-0402` §Decision 4)。
   * **サーバが返したときだけ持つ** —— **宣言していない表ではキーごと存在しない**(限定4)。
   * **【正直に書く】`V14-M2-T01` の時点では、ここへ値を入れる行がまだ1本も無い。**
   * **入れるのは `V14-M2-T04` である。**
   *
   * **【`V14-M2-T04` の訂正。上の2行を1バイトも消していない】**
   * **旧文「ここへ値を入れる行がまだ1本も無い」は今日から偽である** ——
   * **`V14-M2-T04` が取得の `setState`(下の `Promise.all` の `then`)で
   * `page.access` を載せた。** **載せ方は `sum` と1バイトも同じ条件スプレッドであり、
   * **サーバが返さなければキーごと持たない**(`{}` に倒さない —— 倒すと
   * 「誰も何もできない」という嘘になる)。
   */
  access?: Record<string, RowAccess>;
  referenceLabels: ReferenceLabelIndex;
};

export function ListViewRenderer({ appId, manifest, view }: ListViewRendererProps) {
  // 対象テーブルの解決はシステムテーブルも見る(ADR-0006 §7 の #9)。ここを
  // マニフェスト限定に戻すと、`_apps` の一覧が API を叩かずにエラーで終わる。
  const table = resolveViewTable(manifest, view.table);

  /**
   * **いま見ている相手**(`V4-M19-T10`)。**判定は `isPlatformPortAudience` 1本**であり、
   * ここには可否の知識を1つも置かない。**新しい props を1つも足していない**
   * (`ADR-0053` 限定3 =「導線とロールは props に流さない。コンテキストで運ぶ」)。
   */
  const role = useRole();
  const showPlatformPorts = isPlatformPortAudience(role);
  /**
   * **いま見ている本人の id**(`V4-M19-T09`)。**既存の口(`useActorId`)をそのまま読む** ——
   * **新しい API も props も1つも足していない。** 渡っていなければ `null` で、そのときは
   * 印が1つも出ない。
   */
  const actorId = useActorId();
  /**
   * **描いてよい操作起点**(`L-G1` / `L-G2`。`V5-M21-T01` / `ADR-0171`)。
   *
   * **判定先は遷移先 form のテーブルである** —— **`DetailViewRenderer` の `writableActions`
   * と1バイトも同じ規約である**(`B-G3` / `V4-M1`)。押して実際に書き込む先は遷移先 form の
   * テーブルであって、いま見ている一覧のテーブルではない。**可否は `canWriteRole` 1本**で、
   * ここに規約を置かない(`web/src/auth/authz.tsx` のヘッダが禁じた「同じ判定が2箇所」を
   * 作らない)。**遷移先 form が実在しない / 対象テーブルを解決できないときは fail-closed。**
   *
   * **これは先回りガードであって防御ではない**(`ADR-0171` 限定9)—— **一覧に出さないことを
   * 「押せない」と書かない。****最終防衛線はサーバの 403 / 404 である。**
   *
   * **`DetailViewRenderer` と違い、`set` 形の分岐が1つも無い** —— **一覧に `set` 形は書けない**
   * (`ADR-0171` 限定10 の順序拘束。`schemas/manifest.schema.json` の `list_view` 分岐が
   * `items.properties.set: false` で閉じており、型もそれに合わせてある)。
   *
   * **主副の描き分けを一覧では1つもしていない** —— `DetailViewRenderer` は書かれた配列の
   * 1番目を主(`variant="default"`)にするが、**一覧では行が何行も並ぶので、主のボタンが
   * 行数ぶん並ぶことになる。****今日は全部 `secondary` で描く。****これは規約であって
   * 宣言ではなく、マニフェストにも MCP の説明文にも1文字も現れない**(`V4-M19-T01` が
   * 詳細画面について書いた自己完結性の後退と同型である。隠さずここに書く)。
   *
   * ## **【`V5-M22-T03` / `L-G5` / `ADR-0173`】3形目(行き先の宣言)には書込判定を当てない**
   *
   * **3形目は書込を1件も起こさない**(遷移だけである)ので、**`canWriteRole` を当てる先が
   * 無い。****当てると「読むだけの人が読める画面へ行くリンク」を消してしまう。**
   * **代わりに当てるのは「行き先がこの人のマニフェストに居るか」だけである** ——
   * **判定は `resolveRowActionDestination`(`web/src/navigation.tsx`)1本**であり、
   * **ここに規約を書き写さない。** **`audience` で見えない画面はサーバがマニフェストから
   * 落として返すので、その1本が `undefined` を返し、ボタンごと出ない**(`ADR-0173`
   * §限界3 が「確かめること」と書いた点の実装上の答えである)。
   * **【禁止】これを「権限で出し分けている」と書かない** —— **権限の出し分けは
   * `L-G13` / `L-G14`(`V5-M23`)の担当であり、本マイルストーンは1バイトも触っていない。**
   *
   * ## **【`V5-M23-T01` / `L-G13`(門 = 外)で足した1点。上の1文は今日から偽である】**
   *
   * **旧文(1バイトも消していない)**: 「**`audience` で見えない画面はサーバがマニフェスト
   * から落として返すので、その1本が `undefined` を返し、ボタンごと出ない**」。
   *
   * **`V5-M23-T05` が本物の HTTP 要求で実測したところ、これは**偽**である** ——
   * **`GET /api/apps/:app_id/manifest`(`src/server/app.ts:1866-1872`)は
   * `loadManifest` の結果をそのまま返しており、`audience` で1画面も落としていない。**
   * **`ADR-0070` 限定7 の逐語(「`GET /api/apps/:app_id/manifest` は未ログインで全ビュー定義を
   * 返し続ける」)がそう定めている** —— **落とすのはレコード経路の 403 であって、
   * マニフェストではない。** **したがって `resolveRowActionDestination` は
   * `audience` で見えない行き先に対しても `undefined` を返さない。**
   *
   * **そこで判定に `canUseView`(`web/src/auth/authz.tsx`)を1本足した** ——
   * **新しい述語を作っていない。** **これは着手前から在る関数で、左ナビ
   * (`visibleViewsForRole`)と匿名の経路(`AppWorkspace.tsx`)が既に使っている。**
   * **判定は AND である**: **行き先が解ける かつ その行き先を使える**。
   *
   * **【禁止】これを「押せなくなった」と書かない**(`ADR-0177` 限定6 / `L-G16`)——
   * **出さないだけである。** **最終防衛線は今日もサーバの 403 / 404 である。**
   *
   * ## **【`V5-M23-T02` / `L-G14` / `ADR-0177`】宣言による2段目**
   *
   * **判定は AND 1つである**(`ADR-0177` §Decision 3 / 限定5): **上の自動判定が真** かつ
   * **(`audience` の宣言が無い または 見ている人のロールが列挙に含まれる)**。
   * **判定は `isActionAudienceAllowed`(`web/src/views/action-audience.ts`)1本**であり、
   * **一覧と詳細で同じ実装を見る。**
   *
   * **【`V8-M20` / `J-G29`。旧文を1バイトも消していない】** **`view_action.audience` は撤去され、
   * `web/src/views/action-audience.ts` はファイルごと消えた**(台帳 `J-G29`。手続きは `ADR-0301`)。
   * **今日の判定は `canUseAction`(`web/src/auth/authz.tsx`)1本であり、サーバと**同じ**
   * `judgeRoleAccess` を呼ぶ** —— **表示層に判定の再実装はもう1本も無い。**
   * **「一覧と詳細で同じ実装を見る」は今日も真である**(どちらも同じ `canUseAction` を呼ぶ)。
   *
   * **【`D-V5-77` が予告した代償は消えていない】** **説明文の逐語**:「**出るか出ないかの
   * 判断が2段になり、アプリを作る側が「なぜ出ないか」を追いにくくなります。**」——
   * **`ADR-0177` §限界2 のとおり、追う手段を1バイトも作っていない。**
   */
  const writableActions = useMemo(
    () =>
      (view.actions ?? []).filter((action) => {
        /*
         * **【`V5-M23-T02` / `L-G14` / `ADR-0177` 限定5】宣言による2段目。**
         * **判定は AND 1つである**: **この宣言が真** かつ **下の自動判定が真**。
         * **「どちらが勝つか」の規則を1つも作っていない** —— 1項足しただけである。
         * **【`V8-M20` / `J-G29`。旧文を1バイトも消していない】** 旧文は 「**判定は `isActionAudienceAllowed` 1本**であり、**詳細画面と同じ実装を見る**」だった。 **その再実装(`web/src/views/action-audience.ts`)は撤去された。** **今日の判定は `canUseAction` 1本であり、サーバと**同じ** `judgeRoleAccess` を呼ぶ** —— **表示層に判定の再実装はもう1本も無い。**
         */
        if (!canUseAction(manifest, view.id, action, role)) {
          return false;
        }
        /*
         * **【`V5-M25-T08` / `L-G8` / `ADR-0174`】4形目(自動処理の起動)。**
         *
         * **判定は2つの AND である**(新しい述語を1本も作っていない):
         *  - **その自動処理が実在し、`manual` と宣言されているか**(fail-closed。
         *    宣言が消えた/古いマニフェストが置かれた場合にボタンを出さない)。
         *  - **この人が対象テーブルへ書ける相手か**(`canWriteRole` 1本)——
         *    **自動処理はその人の操作としてレコードを書くからである。**
         *
         * **`canUseView` を当てる先が無い**(遷移先の画面が存在しない)—— **`set` 形と
         * 同じ限界であり、`v5-m23.md` §4-1 が書いたものと同型である。**
         * **【禁止】これを「押せなくなった」と読まない** —— **出さないだけである。**
         * **最終防衛線は入口(`ADR-0176` 限定5)である。**
         */
        /*
         * **【`V5-M25-T07` / `L-G3` / `ADR-0171` 限定10 の順序拘束が解けた】値の書換(`set`)。**
         *
         * **判定は詳細画面と1バイトも同じである**(`canWriteRole` 1本)——
         * **書込先は「その行」そのものであって、別の画面ではない。**
         * **`canUseView` を当てる先が無い**(`v5-m23.md` §4-1 と同じ限界)。
         */
        if ("set" in action) {
          return canWriteRole(role, resolveViewTable(manifest, view.table));
        }
        if ("run" in action) {
          const workflow = (manifest.app.workflows ?? []).find(
            (candidate) => candidate.id === action.run,
          );
          if (workflow === undefined || workflow.trigger.type !== "manual") {
            return false;
          }
          return canWriteRole(role, resolveViewTable(manifest, view.table));
        }
        if ("view" in action) {
          /*
           * **行き先が解けるかどうかだけを見る。** **`_id` は行ごとに違うが、行き先が
           * 解けるかどうかは行に依らない**ので、ここでは空文字を渡して**存在だけ**を問う。
           * **実際に運ぶ値は押した瞬間に `RowActionOrigins` が同じ関数へ渡す。**
           */
          if (resolveRowActionDestination(manifest, appId, action, "") === undefined) {
            return false;
          }
          /*
           * **【`V5-M23-T01`】行き先の画面をこの人が使えるか。** **判定は `canUseView` 1本。**
           * **行き先は `list_view` / `detail_view` に限られている**(`ADR-0173` 限定3)ので、
           * **IDで引き当てられなければ上の1本が既に落としている。**
           */
          const destination = manifest.app.views.find((candidate) => candidate.id === action.view);
          return destination !== undefined && canUseView(role, manifest, destination);
        }
        const form = manifest.app.views.find(
          (candidate) => candidate.type === "form" && candidate.id === action.form,
        );
        return (
          canWriteRole(
            role,
            form === undefined ? undefined : resolveViewTable(manifest, form.table),
          ) &&
          form !== undefined &&
          canUseView(role, manifest, form)
        );
      }),
    [view.id, manifest, appId, view.actions, view.table, role],
  );
  /**
   * **このテーブルが個人所有テーブルか**(`st_owner` を持つか)。**規約の判定は
   * `personalOwnerField` 1本**であり、ここに `st_owner` の条件を書き写さない。
   * **持たないテーブルでは `false` に落ち、DOM は今日と1バイトも変わらない。**
   */
  const ownerFieldPresent = table !== undefined && personalOwnerField(table) !== undefined;

  /** `columns` をフィールド定義に解決する。解決できない列は隠さずに報告する(憲法6)。 */
  const resolved = useMemo(() => {
    if (table === undefined) {
      return {
        columns: [] as Field[],
        errors: [
          {
            path: "",
            message: `ビュー "${view.id}" の対象テーブル "${view.table}" がありません。`,
            allowed_values: viewTargetIds(manifest),
          },
        ],
      };
    }
    const columns: Field[] = [];
    const errors = [];
    for (const columnId of view.columns) {
      const field = table.fields.find((candidate) => candidate.id === columnId);
      if (field === undefined) {
        errors.push({
          path: "",
          message: `ビュー "${view.id}" の列 "${columnId}" はテーブル "${table.id}" にありません。`,
          allowed_values: table.fields.map((candidate) => candidate.id),
        });
        continue;
      }
      columns.push(field);
    }
    return { columns, errors };
  }, [manifest, table, view]);

  /**
   * 列に出てくる reference の参照先テーブル(重複なし)。
   * 代表値を引くためにこのテーブルのレコードもまとめて取得する。
   */
  const referencedTables = useMemo(() => {
    const ids = new Set<ResourceId>();
    for (const field of resolved.columns) {
      if (field.type === "reference") {
        ids.add(field.reference_table);
      }
    }
    return [...ids]
      .map((id) => resolveViewTable(manifest, id))
      .filter((candidate): candidate is TableDefinition => candidate !== undefined);
  }, [manifest, resolved.columns]);

  const [state, setState] = useState<AsyncState<ListData>>({ status: "loading" });

  /**
   * ページ位置(先頭からスキップする件数)。**画面の一時状態**であってマニフェストには
   * 保存しない(D-G11。ADR-0042)。
   *
   * ビュー(table / sort / filter)が変わったら先頭ページへ戻す。React 推奨の「レンダー中に
   * 前回値と比べて state を調整する」形にする(effect で reset すると、その effect の本体は
   * どの反応値も使わないため exhaustive-deps と噛み合わない)。
   */
  /**
   * 打たれた検索の語(`V4-M22-T02`。`ADR-0112` 限定8)。
   *
   * **画面の一時状態であって、マニフェストには1バイトも保存しない** —— **保存する経路を
   * 作ることは `ADR-0042` 限定2 / §3a-2 の正面であり、`ADR-0112` §Decision 4 の 5 が
   * 名指しで門にしている。** **`search_fields` を書いていない画面ではこの値は常に空文字で、
   * 取得の URL は今日と1バイトも変わらない。**
   */
  /**
   * この画面が1ページに読む件数(`V4-M22-T06`。`ADR-0113`)。**解決は1箇所だけである。**
   * **書かなかった画面では 50 に落ちる**(限定10)。
   */
  const pageSize = resolvePageSize(view);

  /**
   * **選択の状態**(`V4-M20-T03`)。**この画面の一時状態(`useState`)であって、
   * マニフェストにも `localStorage` にも `sessionStorage` にも URL にもサーバにも
   * 1バイトも保存しない**(既存の `offset` / `pickedSort` と同じ性質)。
   *
   * **`selecting` が偽のあいだ、DOM は着手前と1バイトも変わらない**(チェックボックスの列も
   * 操作の器も1つも出ない)—— **入口のボタン1つだけが増える。**
   * **入口のボタンは editor / owner にしか出さない。**
   */
  const [selecting, setSelecting] = useState(false);
  /** **選ばれた行の `_id`**。**いま画面に出ているページの行しか入らない。** */
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  /** まとめて書き換える先の1フィールド。 */
  const [bulkFieldId, setBulkFieldId] = useState("");
  /** まとめて書き込む1つの値(打たれた文字列)。 */
  const [bulkRaw, setBulkRaw] = useState("");
  /** 書込中か。**押している間だけ止める**(冪等性の担保ではない)。 */
  const [bulkBusy, setBulkBusy] = useState(false);
  /** 書込が返したエラー。**要約せずにそのまま出す**(`ADR-0003` §3)。 */
  const [bulkErrors, setBulkErrors] = useState<ValidationError[]>([]);
  /** 直前の書込で何件書けたか。**書けた件数を丸めない。** */
  const [bulkWritten, setBulkWritten] = useState<number | null>(null);

  const [searchTerm, setSearchTerm] = useState("");
  const searchFields = view.search_fields ?? [];

  /**
   * **打たれた並び順**(`V4-M19-T06`。ユーザ決定 `D-V4-79` =「**保存はしない**」)。
   *
   * **この画面の一時状態(`useState`)であって、マニフェストにも `localStorage` にも
   * `sessionStorage` にも URL にも Cookie にもサーバにも1バイトも保存しない。**
   * **先例は既存の `offset`(ページ位置。`ADR-0042` 限定2 / §3a-2 不可侵)である** ——
   * **同じ性質の状態を同じ形で持つ**(新しい種類の状態を作っていない)。
   *
   * **`undefined` = まだ何も打っていない** = 宣言された `view.sort` がそのまま効く。
   * **打っていない画面では、取得の URL は今日と1バイトも変わらない。**
   */
  const [pickedSort, setPickedSort] = useState<Sort | undefined>(undefined);
  /** 実際にサーバへ渡す並び順。**打たれた並び順があればそれ、無ければ `view.sort`。** */
  const effectiveSort = pickedSort ?? view.sort;
  /** 印(`aria-sort`)と次の向きを決める1キー。**複合のときは先頭キーだけである。** */
  const activeSort = activeSortKey(effectiveSort);
  /**
   * 列ヘッダが押されたときに打つ並び順。**打つだけで、どこにも保存しない。**
   * **次に画面を開いたときには `view.sort` に戻る**(`pickedSort` は再マウントで消える)。
   */
  const pickSort = (fieldId: ResourceId) => setPickedSort(nextSort(activeSort, fieldId));
  /**
   * 実際に読取API へ渡す `filter`。**画面の `filter` と検索の条件を `and` で結んだもの**
   * (`ADR-0112` 限定9)。**語が空なら画面の `filter` そのものである。**
   */
  const effectiveFilter = useMemo(
    () => buildSearchFilter(view.filter, view.search_fields ?? [], searchTerm),
    [view.filter, view.search_fields, searchTerm],
  );

  const viewKey = JSON.stringify([
    appId,
    view.table,
    // **打たれた並び順を含めるので、並び順を変えたら先頭ページへ戻る**(`V4-M19-T06`)——
    // **新しい reset の仕組みを1つも作っていない。** 2ページ目で並び順を変えたときに
    // 「2ページ目のまま別の並び」を見せない(1ページ目に何が来たかを見られないため)。
    // **打っていない画面では `effectiveSort` は `view.sort` そのものなので、この鍵は
    // 着手前と同じ値になる。**
    effectiveSort ?? null,
    // **検索の語を含めるので、語を変えたら先頭ページへ戻る** —— 3ページ目で語を変えて
    // 「0件」に見えることを起こさない。**`search_fields` を書いていない画面では
    // `effectiveFilter` は `view.filter` そのものなので、この鍵は着手前と同じ値になる。**
    effectiveFilter ?? null,
    // **件数が変わったら先頭ページへ戻す**(V4-M22-T06)—— 100件表示の3ページ目のまま
    // 10件表示に変えると、`offset` が総件数を越えて空の画面になりうる。
    // **`page_size` を書いていない画面ではこの要素は常に 50 なので、着手前と同じ鍵になる。**
    pageSize,
  ]);
  const [offset, setOffset] = useState(0);
  /**
   * **読み直しの鍵**(`V4-M20-T03`)。**まとめて書き換えたあとに、同じ条件でもう一度読む
   * ためだけの一時状態である** —— **新しい取得経路を1本も開いていない**(既存の effect の
   * 依存に1つ足しただけである)。**値そのものに意味は無い**(増えたら読み直す)。
   */
  const [refreshToken, setRefreshToken] = useState(0);
  const [prevViewKey, setPrevViewKey] = useState(viewKey);
  if (viewKey !== prevViewKey) {
    setPrevViewKey(viewKey);
    setOffset(0);
  }

  // **`audience` を書いた画面だけサーバに名乗る**(V4-M3-T04 / ADR-0070 限定3・限定4)。
  // **【`V8-M20` / `J-G27`】旧文の `audience` は撤去された。今日名乗る条件は「面の規則がその画面を名指ししているか」である。**
  // **effect の外で解決する** —— effect の依存はマニフェスト由来の粒度のままにする。
  const namedViewId = viewIdForRecordRequest(manifest, view);

  useEffect(() => {
    if (resolved.errors.length > 0) {
      setState({ status: "error", errors: resolved.errors });
      return;
    }
    let cancelled = false;
    // **【V4-M20-T03】読み直しの鍵を「使う」** —— まとめて書き換えたあと、同じ条件で
    // もう一度読むためだけの依存である。**値そのものには意味が無い**(増えたら読み直す)。
    void refreshToken;
    setState({ status: "loading" });

    // `sort` / `filter` はマニフェストの定義をそのまま渡す。ここで内容を判定しない。
    // `limit` / `offset` はページUIの一時状態(EC-G11 / ADR-0042)で、マニフェストには無い。
    const options = {
      // **【`V4-M19-T06`】渡すのは「打たれた並び順があればそれ、無ければ `view.sort`」である。**
      // **サーバに投げ直す形であり、取得済みの行をフロントで並べ替えていない** ——
      // **フロントで並べ替えると「いま見えている1ページの中だけ」が並び替わり、2ページ目には
      // 効かない**(`ADR-0042` の `offset` + `limit` との噛み合わせ。理由の全文は
      // `activeSortKey` の注記にある)。**打っていない画面では `view.sort` そのものが渡り、
      // URL は着手前と1バイトも変わらない。**
      ...(effectiveSort !== undefined ? { sort: effectiveSort } : {}),
      // **【V4-M22-T02 / ADR-0112 限定9】渡すのは「画面の `filter` と検索の条件を `and` で
      // 結んだもの」である。** **`view.filter` を1バイトも書き換えていない** ——
      // `buildSearchFilter` は新しいオブジェクトを組み立てて返すだけである。
      // **語が空なら `view.filter` そのものが渡り、URL は着手前と1バイトも変わらない。**
      ...(effectiveFilter !== undefined ? { filter: effectiveFilter } : {}),
      // **【V4-M22-T06 / ADR-0113 限定2】1ページの件数は `resolvePageSize` の1箇所が決める。**
      // **書かなかった画面では 50 に落ちるので、URL は着手前と1バイトも変わらない。**
      limit: pageSize,
      ...(offset > 0 ? { offset } : {}),
      // **どの画面から読んでいるかをサーバに渡す**(V4-M3-T03 / `B-G1` / ADR-0070 限定3)。
      // **【`V8-M20` / `J-G27`】旧文「渡すのは `audience` を書いた画面だけである」の
      // `audience` は撤去された。今日の条件は面の規則がその画面を名指ししているかである。**
      // **渡すのは `audience` を書いた画面だけである**(限定4。判定は
      // `viewIdForRecordRequest` 1本)—— 宣言の無い画面の URL は今日と1バイトも変わらない。
      // **参照ラベルの取得(下の `fetchRecords`)には渡さない** —— そちらは別テーブルなので、
      // 渡すと画面の `table` と食い違ってサーバが 400 を返す。
      ...(namedViewId !== undefined ? { view: namedViewId } : {}),
      // **【V4-M23-T03 / `D-V4-89` / `E-G31` / ADR-0104 限定3】どの列の合計を求めるか。**
      // **書かなかった画面では `sum` が URL に1バイトも載らず、着手前と1バイトも変わらない。**
      // **参照ラベルの取得(下の `fetchRecords`)には渡さない** —— そちらは別テーブルである。
      ...(view.sum_field === undefined ? {} : { sumField: view.sum_field }),
    };

    Promise.all([
      fetchRecordPage(appId, view.table, options),
      Promise.all(
        referencedTables.map(async (target) => ({
          table: target,
          records: await fetchRecords(appId, target.id),
        })),
      ),
    ]).then(
      ([page, referenceSources]) => {
        if (!cancelled) {
          setState({
            status: "ready",
            value: {
              records: page.records,
              total: page.total,
              // **サーバが返したときだけ持つ**(返さなければキーごと持たない)。
              ...(page.sum === undefined ? {} : { sum: page.sum }),
              // **【`V14-M2-T04`】行ごとの判定も `sum` と1バイトも同じ形で載せる**
              // (`ADR-0402` §Decision 4)—— **サーバが返さなければキーごと持たない。**
              // **`{}` に倒さない** —— **`{}` は「どの行にも何もできない」という嘘になる。**
              // **追加の問い合わせを1本も作っていない** —— **この `access` は一覧APIの
              // 同じ応答に載って来たものである**(`ADR-0402` 限定12)。
              ...(page.access === undefined ? {} : { access: page.access }),
              referenceLabels: buildReferenceLabelIndex(referenceSources),
            },
          });
        }
      },
      (reason: unknown) => {
        if (!cancelled) {
          setState({ status: "error", errors: toValidationErrors(reason) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
    // 依存はマニフェスト由来の値 + ページ位置(offset)。`resolved` / `referencedTables` は
    // useMemo されているので、再描画のたびに取り直すことはない。
  }, [
    appId,
    view.table,
    // **`view.sort` から `effectiveSort` に差し替えた**(`V4-M19-T06`)—— **列ヘッダを
    // 押したときに取り直すためである。** **打っていない画面では `view.sort` そのもの**
    // (`pickedSort ?? view.sort` は同じ参照を返す)なので、取得回数は1回も変わらない。
    effectiveSort,
    // **`view.filter` から `effectiveFilter` に差し替えた**(V4-M22-T02)——
    // **語を打ったときに取り直すためである。** `effectiveFilter` は `useMemo` されており、
    // **語が空なら `view.filter` そのもの**なので、書いていない画面の取得回数は変わらない。
    effectiveFilter,
    // **件数を変えたら取り直す**(V4-M22-T06)。
    pageSize,
    namedViewId,
    referencedTables,
    resolved.errors,
    offset,
    // **【V4-M20-T03】まとめて書き換えたあとに、同じ条件でもう一度読む。**
    // **新しい取得経路を1本も開いていない** —— 依存が1つ増えただけである。
    // **まとめて操作を1度も使わない画面では値が 0 のままなので、取得回数は1回も変わらない。**
    refreshToken,
    // **【V4-M23-T03】合計を出す列が変わったら取り直す。** **書いていない画面では
    // `undefined` のままなので、取得回数は1回も変わらない。**
    view.sum_field,
  ]);

  /**
   * 行クリックの遷移先。規約(定義順の先頭)は `navigation.tsx` の
   * `resolveDetailViewTarget` が唯一の実装であり、ここには書かない。
   * 無い場合(マニフェストが detail_view を持たない)は行をクリックできなくする。
   *
   * **【`V10-M18-T01` / `FU-G1a` / `ADR-0362` §Decision 1 の遷移点1】一続きの流れの段に
   * なっている `detail_view` を候補から外す。** **述語はここに書かない** ——
   * **外すかどうかを選ぶ引数を渡すだけで、判定は `views/flow.ts` の `flowStepOf` 1本である。**
   * **外した結果0個になれば、今日どおり行が押せなくなる**(下の `openRecord` が
   * `undefined` を返す)—— **別の画面へ倒さない**(`ADR-0362` §Decision 3)。
   * **段を1つも宣言していないアプリの行き先は1バイトも変わらない。**
   */
  const detailView = resolveDetailViewTarget(manifest, view.table, { skipFlowStepViews: true });

  /**
   * **一覧の上部に出す「新規作成」の口**(`V10-M3-T01(a)`)。
   *
   * **宣言のキーを1つも作っていない** —— **表示層の既定挙動である。**
   * **マニフェストにも MCP の説明文にも、この口を出す/出さないを書く場所は1文字も無い**
   * (`V5-M21` が「新規作成へ」について書いた自己完結性の後退と同型である。隠さずここに書く)。
   *
   * ## 5条件の AND であり、1つでも欠けたら `null`(何も描かない)
   *
   * 1. **対象がシステムテーブルでない**(`isSystemTableId`)—— システムテーブルに `form` は
   *    作れない(カーネルの L2)ので本来は 2 が先に落ちるが、**「到達しないはず」に
   *    安全性を預けない**(`ADR-0006` §7 の #11 / #12。`DetailViewRenderer` の `readOnly` と
   *    同じ理屈)。
   * 2. **同じテーブルの `form` が実在する**(**定義順の先頭**)—— **述語は
   *    `DetailViewRenderer.tsx` の `formView` と1バイトも同じである**(`type === "form"` かつ
   *    `table === view.table`)。**2本目以降には行けない。**
   * 3. **その `form` がその人に見える**(`canUseView` 1本)—— **面の読み方をここに書き写さない。**
   * 4. **書ける相手である**(`canWriteRole` 1本)。
   * 5. **そのテーブルが `st_no_direct_create` を宣言していない**(`isDirectCreateSuppressed`
   *    1本)—— **規約を再実装しない**(判定の唯一の家は `src/server/owner-scope.ts`)。
   *
   * ## **条件4 は審査の限定が挙げた3条件に無い**(正直に書く)
   *
   * **限定が挙げたのは 2 / 3 / 5 の3つであり、`canWriteRole` は本タスクが足した4つ目である。**
   *
   * ## **条件4 が止める相手は3つだけである**(誇張しない)
   *
   * **`canWriteRole` の第2引数は実物では使われていない** —— **`web/src/auth/authz.tsx:233` の
   * 逐語は `export function canWriteRole(role: ViewAudienceActor | null, _table?: Table | undefined)`
   * であり、`_table` は本体で1度も読まれない。** **したがって止まるのは viewer /
   * 未ログイン(`ANONYMOUS`)/ ロール不明(`null`)の3つだけ**であり、**宣言された非運営の
   * 役割は、その表への書込付与が1本も無くてもこの条件で真になる。**
   * **【禁止】これを「押しても必ず失敗する導線を消した」と書かない。** **消せていない。**
   * **最終防衛線はサーバの 401 / 403 である**(UI に出さないことは「押せない」ことではない)。
   *
   * ## 文言
   *
   * **「新規作成」は、行ごとの操作起点の既定「新規作成へ」とは別の文字列である**
   * (このファイルの `{action.name ?? (isLink ? "画面を開く" : "新規作成へ")}`)。
   * **どちらもマニフェストから1文字も取っていない。**
   *
   * ## 押した先
   *
   * **`{ kind: "view", appId, viewId: createForm.id }` だけである** —— **`recordId` を
   * 渡さない**(どの行でもない)。**`prefill` を渡さない**(運ぶ値が1つも無い)。
   * **`web/src/navigation.tsx` に関数を1本も足していない。**
   *
   * **`ready` の枝にだけ置く** —— **`loading` / `error` には置かない**(取得の成否が
   * 分からない時点で書込の口を出さない)。
   *
   * ## **`menu_listed: false` の `form` にも、ここから到達できる**(正直に書く)
   *
   * **判定は `canUseView` 1本であり、左ナビの掲載可否(`isViewMenuListed`)を見ていない。**
   * **`web/src/auth/authz.tsx:663` の逐語は「`canUseView` は `menu_listed: false` の画面にも
   * 今日どおり `true` を返し、**行クリック / URL 直叩きからは到達できる**(限定5)」である。**
   * **本タスクはその到達経路を1本増やした** —— **左ナビから意図的に外した入力画面へ、
   * 一覧から行けるようになった。** **【禁止】これを「掲載可否は今日も効く」と書かない。**
   */
  const createForm = manifest.app.views.find(
    (candidate) => candidate.type === "form" && candidate.table === view.table,
  );
  const createAllowedHere =
    !isSystemTableId(view.table) && table !== undefined && !isDirectCreateSuppressed(table);
  const createBlock =
    createAllowedHere &&
    createForm !== undefined &&
    canUseView(role, manifest, createForm) &&
    canWriteRole(role, table) ? (
      <div className={cn("list-create", "flex")} data-testid="list-create">
        <Button
          type="button"
          data-testid="list-create-button"
          onClick={() => navigate({ kind: "view", appId, viewId: createForm.id })}
        >
          新規作成
        </Button>
      </div>
    ) : null;
  /**
   * 検索の入力欄(`V4-M22-T02`。`ADR-0112` 限定10 / 限定12)。
   *
   * **`search_fields` を書いた画面にだけ出す** —— **書いていない画面では `null` になり、
   * DOM は着手前と1バイトも変わらない**(限定12。完全一致は
   * `web/test/list-view-search.test.tsx` の (a) が着手前のフィクスチャで固定する)。
   *
   * **3つの状態(loading / error / ready)すべてに置く** —— 語を打つと取得が走って
   * `loading` に落ちるので、`ready` にだけ置くと入力欄が消えて焦点が外れる。
   *
   * **`data-preset-*` を1つも増やしていない。** **マニフェストの値からクラス名を生やさない**
   * (`ADR-0087` 限定6)—— 出るのはソースにリテラルで書いたクラス名だけである。
   * **部品は既存の `Input` / `Label`(`ui/form-controls.tsx`)を使い、新しい器を1つも作らない。**
   */
  const searchInputId = `list-search-${view.id}`;
  const searchBlock =
    searchFields.length === 0 ? null : (
      <div className={cn("list-search", "flex flex-col gap-s1")} data-testid="list-search">
        <Label htmlFor={searchInputId}>絞り込み</Label>
        <Input
          id={searchInputId}
          type="search"
          data-testid="list-search-input"
          className="sm:max-w-80"
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
        />
      </div>
    );

  // どの状態でも `data-testid` は同じ。ディスパッチ層がこのビューを選んだことは
  // 取得の成否とは無関係だからである(app-shell のテストがこれに依存している)。
  if (state.status === "loading") {
    return (
      <section className={LIST_VIEW_CLASS} data-testid="view-renderer-list_view">
        {searchBlock}
        {/*
          **文言も testid も1バイトも変えていない**(V4-M15-T14)。足したのは、これから
          表が出る場所を示す `Skeleton` の3本だけである(`aria-hidden` なので読み上げには
          出ない)。**件数も列数も分からない時点なので、行数を装って多く出さない。**
        */}
        <p className="text-note text-muted-foreground">読み込み中…</p>
        {["head", "row-1", "row-2"].map((slot) => (
          <Skeleton key={slot} className="h-8 w-full" />
        ))}
      </section>
    );
  }
  if (state.status === "error") {
    return (
      <section className={LIST_VIEW_CLASS} data-testid="view-renderer-list_view">
        {searchBlock}
        {/*
          **中身は `ErrorList` のままである** —— カーネルが返した `path` / `message` /
          `allowed_values` / `hint` を1つも要約しない(ADR-0003 §3)。器だけを
          `Alert variant="destructive"` にした。**文言を1文字も足していない**(見出しも足さない)。
        */}
        <Alert variant="destructive">
          <ErrorList errors={state.errors} />
        </Alert>
      </section>
    );
  }

  // **【`V14-M2-T04`】`access` は「行ごとの判定」であり、器(表 / カード)を素通りして
  // `RowActionOrigins` まで運ぶ** —— **運ぶ先で引くのは「その行1件ぶん」だけである。**
  const { records, total, sum, access, referenceLabels } = state.value;

  /*
   * --- 画面で選んでまとめて操作する(`V4-M20-T03`)--------------------------------
   *
   * **`records` が揃ってからでないと組み立てられない**(選べるのは画面に出ている行だけ)。
   */
  /** **入口を出す相手か。** **判定は `canBulkUpdateRole` 1本である**(先回りガード)。 */
  const bulkAllowed = canBulkUpdateRole(role) && bulkEditableFields(table).length > 0;
  const bulkFields = bulkEditableFields(table);
  const bulkField = bulkFields.find((field) => field.id === bulkFieldId);
  /**
   * **いま画面に出ている行のうち、選ばれているもの。**
   *
   * **ページをめくると選択は消える** —— `records` に無い `_id` はここで落ちる。
   * **「絞り込んだ結果の全件を選ぶ」は1ミリも解けない**(実装コメントの全文は
   * `canBulkUpdateRole` の上にある)。
   */
  const selectedOnPage = records.filter((record) => selectedIds.includes(record._id));
  const toggleRow = (recordId: string): void => {
    setBulkWritten(null);
    setSelectedIds((previous) =>
      previous.includes(recordId)
        ? previous.filter((id) => id !== recordId)
        : [...previous, recordId],
    );
  };
  const toggleAllOnPage = (): void => {
    setBulkWritten(null);
    setSelectedIds(
      selectedOnPage.length === records.length ? [] : records.map((record) => record._id),
    );
  };
  const selection = selecting
    ? {
        selectedIds: selectedOnPage.map((record) => record._id),
        allSelected: records.length > 0 && selectedOnPage.length === records.length,
        toggleRow,
        toggleAllOnPage,
      }
    : undefined;

  /**
   * **選んだ行をまとめて1フィールド更新する**(`V4-M20-T03` 完了条件6)。
   *
   * **書込は `POST /api/apps/:app_id/batch` の1本である** —— **1つの IMMEDIATE
   * トランザクションで全成功か全失敗**(`ADR-0039` の部分適用ゼロ)。
   * **`if_match` に読み込んだ行の `_updated_at` を必ず載せる**(CAS を外さない)——
   * **選んだあとに誰かが1行でも先に更新していたら、1件も書かずに 409 で止まる。**
   *
   * **新しい取得経路を1本も開いていない**(完了条件5)—— 送るのは画面が既に持っている行の
   * `_id` と `_updated_at` だけである。**`st_owner` の post-filter を通った行しか画面に無い。**
   */
  const runBulkUpdate = async (): Promise<void> => {
    if (bulkField === undefined || selectedOnPage.length === 0) {
      return;
    }
    const value = bulkValueFor(bulkField, bulkRaw);
    if (value === undefined) {
      setBulkErrors([
        {
          path: `/${bulkField.id}`,
          message: `フィールド "${bulkField.id}" に指定できない値です。`,
          hint: `${bulkField.type} 型に合う値を入力してください。`,
        },
      ]);
      return;
    }
    setBulkBusy(true);
    setBulkErrors([]);
    setBulkWritten(null);
    try {
      const written = await writeRecordsBatch(
        appId,
        selectedOnPage.map((record) => ({
          op: "update" as const,
          table: view.table,
          target: record._id,
          values: { [bulkField.id]: value },
          if_match: record._updated_at,
        })),
      );
      setBulkWritten(written.length);
      setSelectedIds([]);
      // **書けたら読み直す** —— **新しい取得経路を1本も開いていない**(既存の effect を
      // もう一度走らせるだけである)。**書けた行だけを画面で差し替えると、`filter` に
      // よっては画面から外れるべき行が残る。**
      setRefreshToken((previous) => previous + 1);
    } catch (reason: unknown) {
      // **1件も書けていない**(部分適用ゼロ)。理由をそのまま出してその場に留まる。
      if (isForbidden(reason)) {
        setBulkErrors([
          {
            path: "",
            message: "この操作を行う権限がありません(1件も書き込んでいません)。",
            hint: "運営(owner / editor)としてログインしてください。",
          },
        ]);
      } else if (isWriteConflict(reason)) {
        setBulkErrors([
          {
            path: "",
            message:
              "選んだ行のいずれかが、読み込んだあとに別の操作で変更されています(1件も書き込んでいません)。",
            hint: "画面を読み直してから、もう一度選び直してください。",
          },
        ]);
      } else if (isApplyInProgress(reason)) {
        setBulkErrors([
          {
            path: "",
            message: "いまアプリの変更を適用中です(1件も書き込んでいません)。",
            hint: "少し待ってからもう一度試してください。",
          },
        ]);
      } else {
        setBulkErrors(toValidationErrors(reason));
      }
    } finally {
      setBulkBusy(false);
    }
  };

  /**
   * **まとめて操作の器**(`V4-M20-T03`)。
   *
   * **editor / owner 以外には1バイトも出ない** —— viewer / customer / 未ログインの DOM は
   * 着手前と完全に同じである。**入口を押していないあいだも、増えるのはボタン1つだけである。**
   */
  const bulkBlock = !bulkAllowed ? null : (
    <div className={cn("list-bulk", "flex flex-col gap-s2")} data-testid="list-bulk">
      <Button
        variant="secondary"
        size="sm"
        className="w-full sm:w-auto"
        data-testid="list-bulk-toggle"
        onClick={() => {
          setSelecting((previous) => !previous);
          setSelectedIds([]);
          setBulkErrors([]);
          setBulkWritten(null);
        }}
      >
        {selecting ? "選択をやめる" : "まとめて操作"}
      </Button>
      {selecting ? (
        <div
          className={cn("list-bulk-panel", "flex flex-col gap-s2 sm:flex-row sm:items-end")}
          data-testid="list-bulk-panel"
        >
          <div className="flex flex-col gap-s1">
            <Label htmlFor={`list-bulk-field-${view.id}`}>まとめて変える項目</Label>
            <Select
              id={`list-bulk-field-${view.id}`}
              data-testid="list-bulk-field"
              value={bulkFieldId}
              onChange={(event) => {
                setBulkFieldId(event.target.value);
                setBulkRaw("");
                setBulkErrors([]);
              }}
            >
              <option value="">(選んでください)</option>
              {bulkFields.map((field) => (
                <option key={field.id} value={field.id}>
                  {field.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-s1">
            <Label htmlFor={`list-bulk-value-${view.id}`}>入れる値</Label>
            {bulkField?.type === "select" ? (
              <Select
                id={`list-bulk-value-${view.id}`}
                data-testid="list-bulk-value"
                value={bulkRaw}
                onChange={(event) => setBulkRaw(event.target.value)}
              >
                <option value="">(未設定にする)</option>
                {bulkField.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            ) : bulkField?.type === "boolean" ? (
              <Select
                id={`list-bulk-value-${view.id}`}
                data-testid="list-bulk-value"
                value={bulkRaw}
                onChange={(event) => setBulkRaw(event.target.value)}
              >
                <option value="">(未設定にする)</option>
                <option value="true">はい</option>
                <option value="false">いいえ</option>
              </Select>
            ) : (
              <Input
                id={`list-bulk-value-${view.id}`}
                data-testid="list-bulk-value"
                /*
                  **`number` でも `type="text"` のままにする**(`inputMode` だけを数値にする)
                  —— **`type="number"` にすると、ブラウザが打てない文字を黙って捨てるので、
                  「型に合わない値は送らない」という上の判定が画面から到達不能になる。**
                  **到達不能な守りを置かない**(そこが壊れても誰も気づけない)。
                */
                type="text"
                {...(bulkField?.type === "number" ? { inputMode: "numeric" as const } : {})}
                value={bulkRaw}
                disabled={bulkField === undefined}
                onChange={(event) => setBulkRaw(event.target.value)}
              />
            )}
          </div>
          <Button
            size="sm"
            className="w-full sm:w-auto"
            data-testid="list-bulk-apply"
            disabled={bulkBusy || bulkField === undefined || selectedOnPage.length === 0}
            onClick={() => {
              void runBulkUpdate();
            }}
          >
            {`選んだ ${selectedOnPage.length} 件を変える`}
          </Button>
        </div>
      ) : null}
      {/*
        **選べるのは、いま画面に出ているページの行だけである。**
        **「絞り込んだ結果の全件を選ぶ」は1ミリも解けない** —— **総件数がページに収まらない
        ときだけ、その事実をその場に書く**(黙って「全部選べた」ように見せない)。
      */}
      {selecting && total > records.length ? (
        <p className="text-note text-muted-foreground" data-testid="list-bulk-page-note">
          {`選べるのはこのページの ${records.length} 件だけです(全 ${total} 件)。`}
        </p>
      ) : null}
      {bulkWritten !== null ? (
        <p className="text-note text-muted-foreground" data-testid="list-bulk-result">
          {`${bulkWritten} 件を書き換えました。`}
        </p>
      ) : null}
      {bulkErrors.length > 0 ? (
        <Alert variant="destructive" data-testid="list-bulk-errors">
          <ErrorList errors={bulkErrors} />
        </Alert>
      ) : null}
    </div>
  );

  /**
   * 列のうち、実際に参照先レコードへのリンクになるものとその遷移先(V3-M3-T02)。
   *
   * **リンクになるかどうかの判定は `referenceLinkTarget`(`fields/display.tsx`)1本**で
   * あり、ここには条件を書かない —— セルの側とここで判定が割れると、**リンクが無いのに
   * 注記だけが出る**(あるいはその逆)ことになる。**1行でもリンクになる列だけ**を注記の
   * 対象にする(当たり先の無い注記を DOM に置かない)。
   *
   * **【`V10-M18-T02`(`FU-G2`)の追記。上の説明を1バイトも消していない】**
   * **この `linkedReferenceColumns` は撤去した。** **唯一の読み手が、上で消した列の参照の
   * 注記だったからである** —— **残すと `biome` の `noUnusedVariables` が赤くなる。**
   * **`referenceLinkTarget` そのものは1バイトも触っていない**(セルをリンクにするかどうかの
   * 判定は今日も `fields/display.tsx` の1本であり、この画面のリンクは着手前と同じである)。
   * **その import も残っている** —— **セルを描く側(`FieldCell`)が今日も呼んでいる。**
   * **型 `DetailView` の import だけが、この変数と一緒に落ちた**(このファイルの他の場所で
   * 使っていない)。
   */
  // ページャは total がページサイズを超えるときだけ出す(1ページに収まるなら操作は不要)。
  // total 表示自体は件数に関わらず出す(EC-G11 / ADR-0042)。位置は 1 始まりで人間に見せる。
  // **取得の `limit` と同じ1つの解決値を使う**(V4-M22-T06)—— **2つの数を作らない。**
  const showPager = total > pageSize;
  const rangeStart = records.length === 0 ? 0 : offset + 1;
  const rangeEnd = offset + records.length;
  const hasPrev = offset > 0;
  const hasNext = rangeEnd < total;

  /**
   * 件数表示とページャの位置(ADR-0050 の軸3)。
   *
   * **未指定は今日の並びのままである** —— 件数表示が表の前、ページャが表の後(D-M2-3 /
   * ADR-0051 限定4)。**この既定の並びは enum の3値のどれとも一致しない**ので、
   * 一度書いたら「書く前の並び」へは戻せない(実施記録に限界として書く)。
   */
  const pagerPosition = view.preset_pager_position;
  // 未指定(`undefined`)は「件数表示は上・ページャは下」に落ちる。
  const totalAtTop = pagerPosition !== "bottom";
  /**
   * **件数表示は必ず1回だけである**(`E-G19` / V4-M6)。
   *
   * **着手前はここが `pagerPosition === "bottom" || pagerPosition === "both"` で、`both` の
   * ときに件数表示が表の上と下の2箇所に出ていた。** 実地の実測(02 §5-3 `E-G19`)では
   * `product-all` に同じ「1–32 件 / 全 32 件」が2つ出ており、**書き手は「ページャを上下に
   * 置いた」つもりで `both` を書いていた。** 件数は1つの事実なので2回出す意味が無く、
   * 下に出た方は何のことか分からない。
   *
   * **直したのは表示側の解釈だけである** —— **宣言値(`top` / `bottom` / `both` の3値)を
   * 1つも増やしていない**(増やすと `ADR-0050` 限定1 で門A になる)。**`both` は今日から
   * 「ページャを上下に置く」だけを意味する。**
   *
   * **既定の並び(件数は表の上・ページャは表の下)は、この変更の後も3値のどれとも一致
   * しない**(`top` = 件数上+ページャ上 / `bottom` = 件数下+ページャ下 / `both` = 件数上+
   * ページャ上下)。**したがって `ADR-0051` 限定4 と MCP 説明文の「書く前の並びへ前進では
   * 戻せない」は今日も真である。**
   */
  const totalAtBottom = !totalAtTop;
  const pagerAtTop = pagerPosition === "top" || pagerPosition === "both";
  const pagerAtBottom = pagerPosition !== "top";

  const countBlock = (
    <p className={cn("list-total", "text-note text-muted-foreground")} data-testid="list-total">
      {total === 0 ? "0 件" : `${rangeStart}–${rangeEnd} 件 / 全 ${total} 件`}
    </p>
  );

  /**
   * **一覧が表す集合の合計**(`V4-M23-T03`。`D-V4-89` / `E-G31` / `ADR-0104` 限定4・限定5)。
   *
   * **件数表示の隣に置く**(`V4-M23-T03` 完了条件 (1))。**母集団を文言で示す** ——
   * **「全 N 件」と同じ集合の合計であることを画面に書く**(完了条件 (3))。
   * **「今見えているページの合計」と読み違えられる文言にしない**(憲法6。
   * 再審査① S3-4 が「ページ分の合計を『合計』と呼ぶと黙って間違う」と実測した点である)。
   *
   * **`sum_field` を書いていない画面では `null` になり、DOM は着手前と1バイトも変わらない**
   * —— **器ごと出さない**(下の `totalBlock` が包む器も、宣言があるときにだけ生える)。
   *
   * **サーバが `sum` を返さなかったときも `null` である** —— **`0` と書かない。**
   * **「合計は0だった」という嘘をつくより、何も言わないほうがよい。**
   *
   * **値の書き方は列の値とまったく同じ `FieldValue` に任せる** —— 桁区切りも単位
   * (`ADR-0086`)も、列に出るのと1文字も違わない。**書式のための分岐をここに作らない。**
   */
  const sumField =
    view.sum_field === undefined
      ? undefined
      : table?.fields.find((field) => field.id === view.sum_field);
  const sumBlock =
    sumField === undefined || sum === undefined ? null : (
      <p className={cn("list-sum", "text-note text-muted-foreground")} data-testid="list-sum">
        {`全 ${total} 件 の${sumField.name} の合計: `}
        <FieldValue field={sumField} value={sum} referenceLabels={referenceLabels} appId={appId} />
      </p>
    );

  /**
   * **書かなかった画面の DOM を1バイトも変えないための分岐である。**
   * **合計を出さない画面では、着手前とまったく同じ `<p class="list-total">` 1枚が出る**
   * (器で包まない)。**出す画面でだけ、件数と合計を同じ親に入れる。**
   */
  const totalBlock =
    sumBlock === null ? (
      countBlock
    ) : (
      <div
        className={cn("list-total-group", "flex flex-col gap-s1")}
        data-testid="list-total-group"
      >
        {countBlock}
        {sumBlock}
      </div>
    );
  // **ページャを出す条件は1文字も変えていない** —— 行が1件も無いときは出さない
  // (総件数だけが大きい状態でボタンだけが出る形を作らない)。
  const pagerBlock =
    showPager && records.length > 0 ? (
      <nav
        // **幅への対応(`D-V4-44`)**: 狭い画面では2つのボタンを縦に積んで幅いっぱいにし、
        // `sm`(40rem)から横並びにする。**使う断点は `sm` と `lg` の2本だけ**で、
        // ここでは `sm` 1本しか使っていない(ADR-0089 限定3)。
        className={cn("list-pager", "flex flex-col gap-s2 sm:flex-row sm:items-center")}
        data-testid="list-pager"
        aria-label="ページ送り"
      >
        <Button
          variant="secondary"
          size="sm"
          className="w-full sm:w-auto"
          data-testid="list-prev"
          disabled={!hasPrev}
          onClick={() => setOffset(Math.max(0, offset - pageSize))}
        >
          前へ
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="w-full sm:w-auto"
          data-testid="list-next"
          disabled={!hasNext}
          onClick={() => setOffset(offset + pageSize)}
        >
          次へ
        </Button>
      </nav>
    ) : null;

  /**
   * 一覧の器の形(V4-M16-T13。`P-G24` の (C) 側 / ADR-0093)。
   *
   * **有限 enum(2値)をここで分岐する** —— **マニフェストの値からクラス名を生やさない**
   * (限定9 = ADR-0087 限定6)。**未指定は `table` に落ちる**ので、書かなかった画面の DOM は
   * 今日と1バイトも変わらない(限定4)。
   */
  const shape = view.preset_list_shape ?? "table";

  /**
   * 行(またはカード)をクリックしたときの遷移。**表とカードで同じ1つの実装を使う** ——
   * 2本目を作ると「行を押したときとカードを押したときで開くものが違う」ことが起こりうる。
   */
  const openRecord = (record: RecordRow): (() => void) | undefined =>
    detailView === undefined
      ? undefined
      : () => {
          // どのレコードを開いたかを URL に載せる。詳細画面はここからしか
          // 対象を知りようがなく、載せておけばリロードでも同じ画面に戻る。
          navigate({ kind: "view", appId, viewId: detailView.id, recordId: record._id });
        };

  return (
    <section
      className={LIST_VIEW_CLASS}
      data-testid="view-renderer-list_view"
      {...(pagerPosition !== undefined ? { "data-preset-pager": pagerPosition } : {})}
      {...(view.preset_image_size !== undefined
        ? // 軸6(image の表示サイズ。V3-M2-T03)。**一覧と詳細は別の器なので別サイズを持てる**
          // —— 規則は `.list-view` から始まるので、詳細画面の子一覧には当たらない
          // (ADR-0050 §4)。当てる規則は `web/src/styles.css` の1箇所にある。
          { "data-preset-image": view.preset_image_size }
        : {})}
    >
      {/*
        **検索の入力欄は件数表示より前に置く**(V4-M22-T02)—— 件数は「いまの条件で
        何件か」であり、条件の入口はその前に在るべきである。
        **書いていない画面では `null` なので、`.list-view` の直下の子の並びは1つも増減しない**
        (件数表示とページャの位置の固定を壊さない。`web/test/preset-coverage.test.ts` の
        `sectionOrder()` と `web/e2e/preset.e2e.ts`)。
      */}
      {/*
        **【`V10-M3-T01(a)`】一覧の上部の「新規作成」の口。** **`.list-view` の直下の
        先頭に置く**(検索の入力欄より前)—— 「いまの条件で何件か」より前に、
        **この表に1件足す入口**を置く。
        **5条件のどれかが欠ければ `null` なので、そのときは `.list-view` の直下の子の
        並びが着手前と1つも増減しない。** **【正直に書く】5条件が揃った画面では
        実際に1つ増える** —— **`web/e2e/preset.e2e.ts` の `sectionOrder` の期待値6箇所を
        同じ差分で書き換えた。** **既存アプリの一覧画面が、差分を1バイトも入れないまま
        黙って変わる**(`ADR-0102` 限定7 と同型の危険。門A の審査が自ら挙げた不利な材料の
        2番目そのものである)。 **`web/test/preset-coverage.test.ts` の `sectionOrder()` が
        緑のままなのは、その題材が面の規則を1本も持たず `canUseView` が閉じるからであって、
        並びが変わらないからではない。** **件数表示とページャの前後関係だけは1つも
        変えていない。**
        **判定の由来と、条件4 が止める相手が3つだけであることは `createBlock` の
        定義のところに全部書いてある。**
      */}
      {createBlock}
      {searchBlock}
      {/*
        **まとめて操作の器**(`V4-M20-T03`)。**検索の入力欄の次・件数表示の前に置く** ——
        「いまの条件で何件か」の前に、条件と操作の入口を並べる(検索と同じ理屈)。
        **editor / owner 以外では `null` なので、`.list-view` の直下の子の並びは1つも増減
        しない**(件数表示とページャの位置の固定を壊さない)。
      */}
      {bulkBlock}
      {totalAtTop ? totalBlock : null}
      {pagerAtTop ? pagerBlock : null}
      {records.length === 0 ? (
        // **文言も testid も1バイトも変えていない**(V4-M15-T14)。控えめな字色にしただけである。
        <p data-testid="list-empty" className="text-muted-foreground">
          表示できるレコードがありません。
        </p>
      ) : (
        <>
          {shape === "card" ? (
            /*
              **カードの器**(V4-M16-T13。`P-G24` の (C) 側 / ADR-0093 限定6)。

              **`data-testid="list-cards"` は `list-table` と同じ位置に立つ** ——
              `.list-view` の直下の子の並びを1つも増減させないためである
              (件数表示とページャの位置の固定。`web/test/preset-coverage.test.ts` の
              `sectionOrder()` と `web/e2e/preset.e2e.ts`)。
              **クラス名はソースにリテラルとして現れるものだけである**(限定9)——
              マニフェストの値からは1文字も組み立てない。
              **当たり先の規則は `web/src/styles.css` の4つ**(`.list-cards` /
              `.list-card` / `.list-card-field` / `.list-card-label`)にあり、
              **座標系9プロパティを1つも使っていない**(限定5)。
            */
            <div className={cn("list-cards", "flex flex-col gap-s2")} data-testid="list-cards">
              {/*
                CSV の書き出し口。**器の中に置く** —— `.list-view` の直下の子を増やさない
                (表のときに `<caption>` へ置いたのと同じ理屈)。**testid は同じである。**

                **【`V4-M19-T10`】買い物客と未ログインには出さない** —— 判定は
                `isPlatformPortAudience` 1本で、**表のときと同じ1つの式である**
                (器の形で挙動が割れない)。**owner / editor / viewer には今日どおり出る。**
              */}
              {showPlatformPorts ? (
                <CsvCopyBlock
                  columns={resolved.columns}
                  records={records}
                  referenceLabels={referenceLabels}
                />
              ) : null}
              {records.map((record) => (
                <ListCard
                  key={record._id}
                  selection={selection}
                  appId={appId}
                  manifest={manifest}
                  columns={resolved.columns}
                  textPreview={view.preset_text_preview}
                  record={record}
                  referenceLabels={referenceLabels}
                  onOpen={openRecord(record)}
                  own={isOwnRow(ownerFieldPresent, record, actorId)}
                  actions={writableActions}
                  {...(access === undefined ? {} : { access })}
                  viewId={view.id}
                  tableId={view.table}
                />
              ))}
            </div>
          ) : (
            <TableShape
              appId={appId}
              manifest={manifest}
              view={view}
              columns={resolved.columns}
              records={records}
              referenceLabels={referenceLabels}
              openRecord={openRecord}
              activeSort={activeSort}
              onPickSort={pickSort}
              showCsvPort={showPlatformPorts}
              ownerFieldPresent={ownerFieldPresent}
              actorId={actorId}
              selection={selection}
              actions={writableActions}
              {...(access === undefined ? {} : { access })}
            />
          )}
          {/*
            遷移先が一意に決まらない(候補が2つ以上ある)ときだけ、規約でどれを選んだかを
            画面に書く。黙って1つを選ぶと、書き手には「もう片方が無視された」ことが
            見えない(憲法6)。候補が1つ以下なら迷いようがないので出さない。
            ビューに表示名は無いので、書き手が照合できる `id` を出す。

            **判定と文面は `DetailTargetNote`(`navigation.tsx`)1本に集約した** ——
            遷移点が4つに増えたので、同じ文を4箇所に持たない。**class と testid は
            V1-M0-T08 のものをそのまま渡す**ので、この注記の DOM は1バイトも変わらない。

            **【`V10-M18-T02`(`FU-G2`)の追記。上の行を1バイトも消していない】**
            **この2つの注記(行の注記・列の参照の注記)を出すのをやめた。**
            **ユーザ決定 `D-V10-21` が選んだ見出しは「出すのをやめる」である** ——
            「お客に分かる言葉へ書き換える」でも「作り手にだけ見せる」でもない。
            **代わりの手だて(別の場所に同じ説明を出す・`title` 属性に入れる 等)を
            1つも作っていない。** **役割・利用者・見せる相手を見る式も1本も足していない**
            (`FU-G2` 限定1)——**出し分けではなく、消したのである。**

            **遷移の振る舞いには1バイトも触っていない。** 行が押せるかどうかも、
            どの `detail_view` へ移るかも、着手前と同じである。
          */}
        </>
      )}
      {totalAtBottom ? totalBlock : null}
      {pagerAtBottom ? pagerBlock : null}
    </section>
  );
}

/**
 * **行の操作起点**(`L-G1` / `L-G2`。`V5-M21-T01` / `ADR-0171`)。
 *
 * **型は `ListView["actions"]` の要素そのものである** —— **新しい型を1つも作っていない。**
 * **一覧に書けるのは遷移の形だけである**(`set` 形は `ADR-0171` 限定10 の順序拘束により
 * `schemas/manifest.schema.json` の `list_view` 分岐が閉じている)。
 */
type RowAction = NonNullable<ListView["actions"]>[number];

/**
 * **1行ぶんの操作起点のボタン**(`V5-M21-T01`)。
 *
 * **表(`ListRow`)とカード(`ListCard`)で同じ1つの実装を使う** —— 2本目を作ると
 * 「行を押したときとカードを押したときで運ぶ値が違う」ことが起こりうる。
 *
 * ## 決めた3点(**いずれも規約であって宣言ではない**)
 *
 * 1. **運ぶのは「この行の `_id`」1つだけである**(`ADR-0171` 限定2)—— **複数行を
 *    まとめて対象にする形を1つも作っていない。**
 * 2. **`stopPropagation` を書く** —— 行そのものが「押すと詳細へ行く」器なので、
 *    書かないとボタンを押した瞬間に**別の画面**(詳細)へ飛ぶ。**行の側の判定
 *    (`closest("a")`)を1バイトも変えていない** —— あちらはリンクのためのものである。
 * 3. **`variant` は全部 `secondary` である** —— 詳細画面の主副の規約(`V4-M19-T01`)を
 *    一覧へ持ち込むと、主のボタンが行数ぶん並ぶ。**この判断はマニフェストにも MCP の
 *    説明文にも1文字も現れない**(自己完結性の後退。隠さずここに書く)。
 */
function RowActionOrigins({
  appId,
  viewId,
  tableId,
  manifest,
  actions,
  record,
  rowAccess,
}: {
  appId: string;
  /**
   * **【`V5-M25-T08`】入口が「どの画面から押されたか」を要る**(`ADR-0176`)——
   * **入口はその画面が宣言した操作起点だけを受ける**(`ADR-0174` 限定2 の実行時の側)。
   */
  viewId: string;
  /**
   * **【`V5-M25-T07` / `L-G3`】値の書換の書込先テーブル。** **一覧の対象テーブルであり、
   * 詳細画面が「今開いているレコードのテーブル」を使うのと同じ意味である。**
   */
  tableId: string;
  /**
   * **【`V5-M22-T03`】3形目の行き先を解くために要る。** **行き先の宣言(`view`)は
   * ビューIDなので、それを画面の定義に当てないと型も `_id` の要否も決まらない。**
   */
  manifest: Manifest;
  actions: readonly RowAction[];
  record: RecordRow;
  /**
   * **【`V14-M2-T04`】この行1件ぶんの判定**(`ADR-0402` §Decision 4 / §Decision 6)。
   *
   * **受け取るのは行1件ぶんである** —— **`access` 全体を渡さない**(行のことは行が知る)。
   * **`undefined` のとき、ボタンの出方は着手前と1バイトも変わらない**(限定4)——
   * **その表がアクセス権管理を宣言していないか、サーバが判定を載せなかったときである。**
   *
   * **【禁止】これを「押せなくなった」と読まない**(`ADR-0402` 限定7 / 限定8)——
   * **出さないだけである。** **最終防衛線は今日どおりサーバの 403 / 404 である。**
   */
  rowAccess?: RowAccess;
}) {
  /*
   * **表示条件は行ごとに1回ずつ評価する**(`ADR-0171` §Decision 4)。
   * **評価は `visibleWhenMatches` 1本**(`web/src/views/visible-when.ts`)であり、
   * **詳細画面と同じ実装である** —— ここに2本目を書かない。
   * **条件を書かなかった起点は今日どおり必ず出る**(既定を反転させていない)。
   */
  /*
   * **【`V14-M2-T04` / `ADR-0402` §Decision 6】2項目の `AND` を足した。**
   *
   * **面(ボタンの規則)は呼び出し側の `writableActions` が1回だけ済ませてある** ——
   * **ここで足すのは「行の判定」だけである。** **これは面と点の `OR` の再実装ではなく、
   * 2つの別の問いの積である**(`ADR-0402` §Decision 8 の線4)。
   * **形 → 動詞の写像は `row-action-verb.ts` の1本を呼ぶ**(線2)——
   * **ここに写像を書き写さない。**
   * **`rowAccess` が `undefined` の行では `rowAccessAllows` が真を返すので、
   * 着手前と1バイトも同じ結果になる。**
   */
  const visible = actions.filter(
    (action) =>
      (action.visible_when === undefined || visibleWhenMatches(action.visible_when, record)) &&
      rowAccessAllows(rowAccess, rowActionVerb(manifest, tableId, action)),
  );
  /**
   * **起動中の自動処理のID**(`V5-M25-T08`)。**押している間だけそのボタンを止める。**
   *
   * **これは冪等性の担保ではない**(`ADR-0175` §限界2)—— **規則を持つのは入口である。**
   * **【禁止】「二重押しが防げる」と読まない** —— **1本目が終われば同じボタンをまた押せ、
   * 押した回数だけ走る。**
   */
  const [runningWorkflow, setRunningWorkflow] = useState<string | null>(null);
  /** **起動が断られた / アクションが失敗した理由**(黙って捨てない = 憲法6)。 */
  const [runError, setRunError] = useState<string | null>(null);
  /**
   * **値の書換が進行中かどうか**(`V5-M25-T07` / `L-G3`)。**押している間だけ止める。**
   *
   * **これは冪等性の担保ではない**(`ADR-0100` §限界1)—— **書込が終われば同じボタンを
   * また押せ、押した回数だけ書込が起き、`on_update` もそのたびに発火する。**
   */
  const [settingField, setSettingField] = useState<string | null>(null);

  const handleSet = async (set: {
    field: string;
    value: string | number | boolean;
  }): Promise<void> => {
    setSettingField(set.field);
    setRunError(null);
    try {
      // **既存のレコード更新経路をそのまま通る**(`ADR-0171` 限定8 / `ADR-0100` 限定6)——
      // **`writable_by` / ロール判定 / `If-Match` の CAS を1つも迂回していない。**
      // **版は「一覧が読んだその行の `_updated_at`」である** —— **詳細画面が開いている
      // レコードの版を使うのと同じ形であり、新しい CAS 機構を1つも作っていない。**
      await updateRecord(
        appId,
        tableId,
        record._id,
        { [set.field]: set.value },
        String(record._updated_at),
      );
    } catch (reason: unknown) {
      const errors = toValidationErrors(reason);
      setRunError(
        errors.length > 0
          ? errors.map((error) => error.message).join(" / ")
          : "この値に書き換えられませんでした。",
      );
    } finally {
      setSettingField(null);
    }
  };

  const handleRun = async (workflowId: string): Promise<void> => {
    setRunningWorkflow(workflowId);
    setRunError(null);
    try {
      const result = await runViewAction(appId, viewId, workflowId, record._id);
      if (result.failures.length > 0) {
        // **200 でも黙らない** —— **起動は受理されたがアクションが失敗した、を区別して出す。**
        setRunError(result.failures.join(" / "));
      }
    } catch (reason: unknown) {
      const errors = toValidationErrors(reason);
      setRunError(
        errors.length > 0
          ? errors.map((error) => error.message).join(" / ")
          : "自動処理を起こせませんでした。",
      );
    } finally {
      setRunningWorkflow(null);
    }
  };

  if (visible.length === 0) {
    return null;
  }
  return (
    <div className={cn("list-action-origins", "flex flex-wrap items-center gap-s1")}>
      {visible.map((action, index) => {
        /*
         * **【`V5-M25-T08` / `L-G8` / `ADR-0174`】4形目(自動処理の起動)は遷移しない。**
         * **`resolveRowActionDestination` は `undefined` を返す**(行き先が無いため)ので、
         * **下の遷移の分岐へ落とさず、ここで別に描く。**
         */
        if ("run" in action) {
          return (
            <Button
              // biome-ignore lint/suspicious/noArrayIndexKey: actions は安定IDを持たず、定義位置が同一性である
              key={`run:${action.run}:${index}`}
              variant="secondary"
              type="button"
              data-testid={`list-action-run-${action.run}`}
              disabled={runningWorkflow !== null}
              onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
                event.stopPropagation();
                void handleRun(action.run);
              }}
              onKeyDown={(event: React.KeyboardEvent<HTMLButtonElement>) => event.stopPropagation()}
            >
              {/*
                **既定の文言はマニフェストから1文字も取っていない** —— **`V5-M21` /
                `V5-M22` が申告した自己完結性の後退を、本マイルストーンはもう1つ増やした。**
              */}
              {action.name ?? "実行する"}
            </Button>
          );
        }
        /*
         * **【`V5-M25-T07` / `L-G3`】値の書換は遷移しない。** **`resolveRowActionDestination`
         * は `undefined` を返す**(行き先が無いため)ので、**ここで別に描く。**
         */
        if ("set" in action) {
          return (
            <Button
              // biome-ignore lint/suspicious/noArrayIndexKey: actions は安定IDを持たず、定義位置が同一性である
              key={`set:${action.set.field}:${index}`}
              variant="secondary"
              type="button"
              data-testid={`list-action-set-${action.set.field}`}
              disabled={settingField !== null}
              onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
                event.stopPropagation();
                void handleSet(action.set);
              }}
              onKeyDown={(event: React.KeyboardEvent<HTMLButtonElement>) => event.stopPropagation()}
            >
              {/* **既定の文言は詳細画面と1文字も同じである。** */}
              {action.name ?? "この値にする"}
            </Button>
          );
        }
        /*
         * **【`V5-M22-T03` / `L-G5` / `L-G6` / `ADR-0173` 限定5】行き先を決めるのは
         * `resolveRowActionDestination` 1本である**(`web/src/navigation.tsx`)——
         * **規則(宣言があれば宣言、無ければ今日どおり)をここに書き写さない。**
         * **`undefined` が返るのは、宣言した行き先がこの人のマニフェストに居ないとき
         * である**(`audience` でサーバが落とした / `form` を指している)——
         * **そのときはボタンを1つも描かない(fail-closed)。**
         * **既定の行き先へ倒さない** —— **倒す先が無い**(`ADR-0173` §限界3 に対する
         * 実装上の答え。`navigation.tsx` の同関数の doc に書いた)。
         */
        const destination = resolveRowActionDestination(manifest, appId, action, record._id);
        if (destination === undefined) {
          return null;
        }
        const isLink = "view" in action;
        return (
          <Button
            // 同じ行き先を複数並べられる(位置が同一性)ので定義位置を鍵に含める。
            // biome-ignore lint/suspicious/noArrayIndexKey: actions は安定IDを持たず、定義位置が同一性である
            key={`${isLink ? action.view : `${action.form}:${action.prefill.field}`}:${index}`}
            variant="secondary"
            type="button"
            data-testid={
              isLink ? `list-action-link-${action.view}` : `list-action-origin-${action.form}`
            }
            onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
              event.stopPropagation();
              navigate(destination);
            }}
            onKeyDown={(event: React.KeyboardEvent<HTMLButtonElement>) => event.stopPropagation()}
          >
            {/*
              **既定の文言は形ごとに違う。****どちらもマニフェストから1文字も取っていない**
              —— **`V5-M21` が「新規作成へ」について書いた自己完結性の後退**(規約が
              マニフェストにも MCP の説明文にも現れない)**を、本マイルストーンは1つ増やした。**
            */}
            {action.name ?? (isLink ? "画面を開く" : "新規作成へ")}
          </Button>
        );
      })}
      {runError === null ? null : (
        // **黙って捨てない**(憲法6)。**行の中にその場で出す** —— **どの行で失敗したかが
        // 読めないと、一覧では原因に辿り着けない。**
        <span
          className={cn("list-action-run-error", "text-destructive text-sm")}
          data-testid="list-action-run-error"
          role="alert"
        >
          {runError}
        </span>
      )}
    </div>
  );
}

/**
 * **選択の器**(`V4-M20-T03`)。**`undefined` = 選択していない**(DOM は着手前と同じ)。
 *
 * **`ViewRendererProps` には props を1つも足していない**(`ADR-0050` 限定10 / `ADR-0052`
 * 限定3')—— これは `ListViewRenderer` の中だけで閉じた内部の型である。
 */
type BulkSelection = {
  /** いま画面に出ている行のうち、選ばれているものの `_id`。 */
  selectedIds: string[];
  /** このページの行がすべて選ばれているか。 */
  allSelected: boolean;
  toggleRow: (recordId: string) => void;
  toggleAllOnPage: () => void;
};

/**
 * 表の器(**着手前からある器。DOM を1バイトも変えていない**)。
 *
 * **`V4-M16-T13` が器を2つにしたので、表の側をそのまま関数へ切り出した** ——
 * **JSX も属性も testid も1文字も変えていない**(完全一致は
 * `web/test/list-view-shape.test.tsx` の (d) が着手前の DOM そのもので固定する)。
 */
function TableShape({
  appId,
  manifest,
  view,
  columns,
  records,
  referenceLabels,
  openRecord,
  activeSort,
  onPickSort,
  showCsvPort,
  ownerFieldPresent,
  actorId,
  selection,
  actions,
  access,
}: {
  appId: string;
  manifest: Manifest;
  view: ListView;
  columns: Field[];
  records: RecordRow[];
  referenceLabels: ReferenceLabelIndex;
  openRecord: (record: RecordRow) => (() => void) | undefined;
  /** いま効いている並び順の第1キー(`V4-M19-T06`)。**印を出すためだけに使う。** */
  activeSort: Sort | undefined;
  /** 列ヘッダが押されたときに呼ぶ(`V4-M19-T06`)。**状態は呼び出し側が持つ。** */
  onPickSort: (fieldId: ResourceId) => void;
  /** CSV の書き出し口を出すか(`V4-M19-T10`)。**判定は呼び出し側の1本である。** */
  showCsvPort: boolean;
  /** 対象テーブルが `st_owner` を持つか(`V4-M19-T09`)。 */
  ownerFieldPresent: boolean;
  /** いま見ている本人の id(`V4-M19-T09`)。渡っていなければ `null`。 */
  actorId: string | null;
  /**
   * **選択の器**(`V4-M20-T03`)。**`undefined` のあいだ、表の DOM は着手前と1バイトも
   * 変わらない** —— 列も `<th>` も1つも増えない。
   */
  selection: BulkSelection | undefined;
  /**
   * **描いてよい操作起点**(`V5-M21-T01`)。**空のあいだ、表の DOM は着手前と1バイトも
   * 変わらない** —— 列も `<th>` も `<col>` も1つも増えない。**判定は呼び出し側の1本
   * (`writableActions`)であり、ここに規約を置かない。**
   */
  actions: readonly RowAction[];
  /**
   * **【`V14-M2-T04`】行ごとの判定**(鍵は行の `_id`。`ADR-0402` §Decision 4)。
   * **この器は中身を1度も読まない** —— **`ListRow` へそのまま渡すだけである。**
   * **`undefined` のあいだ、表の DOM もボタンの出方も着手前と1バイトも変わらない。**
   * **列数を1つも動かさない** —— **セル / 列の有無を決めているのは今日どおり
   * `actions.length === 0` だけであり、行ごとの絞りは `RowActionOrigins` の中で起きる。**
   */
  access?: Record<string, RowAccess>;
}) {
  return (
    <>
      {/*
            **表は横に溢れうるので、狭い画面で読めるように包む**(`D-V4-44`。
            `TableFrame` = `overflow-x-auto`)。**`overflow` は `ADR-0087` 限定8 が禁じる
            9プロパティに入っていない。**

            **`data-testid="list-table"` は包みの側に置いてある。** `.list-view` の直下の子の
            並びは `web/test/preset-coverage.test.ts` と `web/e2e/preset.e2e.ts` が
            `data-testid` の列で `toEqual` 固定している(ADR-0050 の軸3)ので、包みが testid を
            持たないとその固定が「div」に化けて壊れる。**testid は1つも消えていない**(移した)。
            **`class="list-table"` は `<table>` の側に残してある** —— プリセット
            (`.list-table col[data-preset-width=…]` ほか)とテーマ(`box-shadow`)の当たり先は
            `<table>` でなければならない。
          */}
      <TableFrame data-testid="list-table">
        {/*
         **`caption-top`**: 部品体系の `Table` は shadcn 既定の `caption-bottom` を持つが、
         **CSV の口の位置を今日から動かさない**ために上に戻す(`caption-side` の既定)。
         */}
        <Table className={cn("list-table", "caption-top")}>
          {/*
              CSV の書き出し口(V3-M12-T09)。**`<caption>` は `<table>` の最初の子である
              必要があるので `<colgroup>` より前に置く。** `.list-view` の直下の子は
              1つも増やしていない(件数表示とページャの位置の固定を壊さないため)。
            */}
          {/*
              **【`V4-M19-T10`】買い物客と未ログインには出さない。** **出さないときは
              `<caption>` そのものを描かない** —— 空の器を置くと、読み上げに中身の無い
              表題が1つ増える。**判定はカードのときと同じ1つの式である。**
            */}
          {showCsvPort ? (
            <CsvCopyCaption columns={columns} records={records} referenceLabels={referenceLabels} />
          ) : null}
          {/*
              列の幅(軸2)。**`preset_column_width` を書いた画面にだけ `<colgroup>` を出す**
              (ADR-0050 限定6)—— 書かなければ `table-layout` は `auto` のままで、
              既存アプリの列幅配分は1ピクセルも変わらない。段階値は `<col>` の属性に出し、
              実際の幅は `web/src/styles.css` の3規則が決める。
            */}
          {view.preset_column_width !== undefined ? (
            <colgroup>
              {/*
                **【V4-M20-T03】選択中は先頭に1列増えるので、`<col>` も1本足す** ——
                足さないと列の幅の指定が1列ぶんずれる。**選択していないあいだは
                1本も出ない**(着手前と完全に同じ `<colgroup>` である)。
              */}
              {selection === undefined ? null : <col data-field="__select__" />}
              {columns.map((field) => {
                const width = view.preset_column_width?.[field.id];
                return (
                  <col
                    key={field.id}
                    data-field={field.id}
                    {...(width !== undefined ? { "data-preset-width": width } : {})}
                  />
                );
              })}
              {/*
                **【V5-M21-T01】操作起点の列にも `<col>` を1本足す** —— 足さないと
                列の幅の指定が1列ぶんずれる(選択の列と同じ理屈)。**操作起点が1つも
                描けないあいだは1本も出ない**(着手前と完全に同じ `<colgroup>` である)。
              */}
              {actions.length === 0 ? null : <col data-field="__actions__" />}
            </colgroup>
          ) : null}
          <TableHeader>
            <TableRow>
              {/*
               **【V4-M20-T03】選択の列。****選択していないあいだは1つも出ない。**
               **この1つで「このページの行を全部選ぶ / 全部外す」だけができる** ——
               **「絞り込んだ結果の全件を選ぶ」は1ミリも解けない。**
               */}
              {selection === undefined ? null : (
                <TableHead scope="col">
                  <Checkbox
                    data-testid="list-select-all"
                    aria-label="このページの行をすべて選ぶ"
                    checked={selection.allSelected}
                    onChange={() => selection.toggleAllOnPage()}
                  />
                </TableHead>
              )}
              {columns.map((field) => {
                // 列見出しはマニフェストの Field.name。ID を出すと利用者の言葉と食い違う。
                const align = view.preset_column_align?.[field.id];
                const sorted = ariaSortFor(activeSort, field.id);
                return (
                  <TableHead
                    key={field.id}
                    scope="col"
                    // **【`V4-M19-T06`】並べ替えの対象になっている列にだけ向きを出し、
                    // 他の列には `none` を出す。** **`none` を省かない** —— 省くと
                    // 「並べ替えられる列」と「並べ替えの無い表」が区別できない。
                    aria-sort={sorted}
                    {...(align !== undefined ? { "data-preset-align": align } : {})}
                  >
                    {/*
                      **列ヘッダはボタンにする**(キーボードでも押せるように)——
                      **`web/src/ui/table.tsx` を1バイトも編集していない**(`TableHead` の
                      中に既存の `Button` を置いただけである)。**新しい部品を1つも作って
                      いない。** 地色は `bg-transparent` で消してある —— `thead` の地色
                      (`bg-secondary`)の上にボタンの地色を重ねない(`cn` は後勝ちである)。
                      **文字は `field.name` そのものである**(列見出しの文字を変えていない)。
                      **向きの矢印は `aria-hidden` の `<span>` で出す** —— 読み上げには
                      `aria-sort` が既に出ており、同じことを二度言わせない。
                    */}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="bg-transparent px-0 font-medium"
                      data-testid="list-sort"
                      data-field={field.id}
                      onClick={() => onPickSort(field.id)}
                    >
                      {field.name}
                      {sorted === "none" ? null : (
                        <span aria-hidden="true">{sorted === "ascending" ? "▲" : "▼"}</span>
                      )}
                    </Button>
                  </TableHead>
                );
              })}
              {/*
               **【V5-M21-T01】操作起点の列**(`L-G1`)。**描ける操作起点が1つも無い
               あいだは1つも出ない** —— 空の `<th>` を置くと、読み上げに中身の無い列が
               1つ増える。**見出しの文字はマニフェストから1文字も取っていない**(操作起点の
               `name` は行ごとのボタンの文言であって列の名前ではない)。
               */}
              {actions.length === 0 ? null : <TableHead scope="col">操作</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {records.map((record) => (
              <ListRow
                key={record._id}
                appId={appId}
                manifest={manifest}
                columns={columns}
                columnAlign={view.preset_column_align}
                textPreview={view.preset_text_preview}
                record={record}
                referenceLabels={referenceLabels}
                onOpen={openRecord(record)}
                own={isOwnRow(ownerFieldPresent, record, actorId)}
                selection={selection}
                actions={actions}
                {...(access === undefined ? {} : { access })}
                viewId={view.id}
                tableId={view.table}
              />
            ))}
          </TableBody>
        </Table>
      </TableFrame>
    </>
  );
}

/**
 * 一覧の1行。`onOpen` が無いとき(遷移先が無いとき)はただの行として振る舞う。
 *
 * ## 行クリックとセル内リンクが二重発火しないこと(V3-M3-T02)
 *
 * `reference` のセルは参照先レコードへのリンクになる。**リンクを押したときに行の遷移も
 * 起きると、利用者が押した先とは別のレコードが開く。** そこで行の側で「リンクの中から来た
 * イベントか」を見て降りる —— リンクの側に `stopPropagation` を書くのではなく行の側で
 * 見るのは、**リンクの実装(`RouteLink`)をこの事情で変えると、クリック可能な行の中に
 * 無い他の全リンクの挙動まで変わる**ためである(`related` の子行と同じ考え方)。
 */
function ListRow({
  appId,
  manifest,
  columns,
  columnAlign,
  textPreview,
  record,
  referenceLabels,
  onOpen,
  own,
  selection,
  actions,
  access,
  viewId,
  tableId,
}: {
  /** 所属アプリのID(image 型セルの配信 URL 用。`FieldValue` へ渡すだけ)。 */
  appId: string;
  /** 参照セルの遷移先を規約で解くための入力。**判定も遷移先の決定もここには書かない。** */
  manifest: Manifest;
  columns: Field[];
  /**
   * **選択の器**(`V4-M20-T03`)。**`undefined` のあいだ、行の DOM は着手前と1バイトも
   * 変わらない。**
   */
  selection: BulkSelection | undefined;
  /**
   * **この行が「見ている本人の行」か**(`V4-M19-T09`)。**判定はここに書かない**
   * (`isOwnRow` 1本)—— 表とカードで同じ1つの述語を使う。
   */
  own: boolean;
  /**
   * 列ごとの寄せ(ADR-0050 の軸1)。**ビュー定義の値をそのまま持つ**(3値 enum)。
   * `undefined` の列には属性を出さないので、未指定の画面の DOM は今日と同じである。
   */
  columnAlign: Record<string, "left" | "center" | "right"> | undefined;
  /**
   * `long_text` の切り詰め長(ADR-0050 の軸7)。**ビュー定義の値をそのまま `FieldValue` へ
   * 渡すだけ**で、文字数はここに現れない(対応表は `web/src/fields/display.tsx` にある)。
   */
  textPreview: ListView["preset_text_preview"];
  record: RecordRow;
  referenceLabels: ReferenceLabelIndex;
  onOpen: (() => void) | undefined;
  /**
   * **描いてよい操作起点**(`V5-M21-T01`)。**空のあいだ、行の DOM は着手前と1バイトも
   * 変わらない** —— セルが1つも増えない。
   */
  actions: readonly RowAction[];
  /**
   * **【`V14-M2-T04`】行ごとの判定**(鍵は行の `_id`)。**この行のぶんだけを取り出して
   * `RowActionOrigins` へ渡す** —— **中で全体を引かせない**(行のことは行が知る)。
   * **`undefined` のあいだ、行の DOM もボタンの出方も着手前と1バイトも変わらない。**
   */
  access?: Record<string, RowAccess>;
  /**
   * **【`V5-M25-T08`】この行が乗っている画面のID。** **手動起動の入口が「どの画面から
   * 押されたか」を要る**(`ADR-0176`)—— **入口はその画面が宣言した操作起点だけを受ける。**
   */
  viewId: string;
  /**
   * **【`V5-M25-T07` / `L-G3`】この一覧の対象テーブルID。** **値の書換の書込先である。**
   */
  tableId: string;
}) {
  const interactive = onOpen !== undefined;
  return (
    // **既存の class 名(`list-row` / `list-row-interactive`)は1つも消していない** ——
    // `cursor: pointer` と hover/focus の地色は `web/src/styles.css` の1規則が持つ。
    <TableRow
      // **【`V4-M19-T09`】自分の行にだけ体裁を足す** —— **既存の class を1つも消していない。**
      // **`st_owner` を持たないテーブルと、`actorId` が渡っていないときは `own` が常に
      // `false` なので、DOM は今日と1バイトも変わらない。**
      className={cn(
        interactive ? "list-row list-row-interactive" : "list-row",
        own && OWN_ROW_CLASS,
      )}
      data-testid="list-row"
      {...(own ? { "data-own-row": "true" } : {})}
      {...(interactive
        ? {
            tabIndex: 0,
            onClick: (event: React.MouseEvent<HTMLTableRowElement>) => {
              // セル内のリンクが自分で遷移したので、行はもう何もしない(二重発火の防止)。
              if ((event.target as HTMLElement).closest("a") !== null) {
                return;
              }
              onOpen();
            },
            onKeyDown: (event: React.KeyboardEvent<HTMLTableRowElement>) => {
              // 行そのものにフォーカスがあるときだけ。セル内のリンク上での Enter は
              // リンク自身の既定動作であって、行を開く操作ではない。
              if (event.target !== event.currentTarget) {
                return;
              }
              // マウスが使えない場合でも行を開けるようにする。
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen();
              }
            },
          }
        : {})}
    >
      {/*
        **【V4-M20-T03】選択のセル。****選択していないあいだは1つも出ない。**
        **`stopPropagation` を書く** —— 行そのものが「押すと詳細へ行く」器なので、
        書かないとチェックを付けた瞬間に画面が遷移する。**行の側の判定
        (`closest("a")`)を1バイトも変えていない** —— あちらはリンクのためのものである。
      */}
      {selection === undefined ? null : (
        <TableCell className="list-select-cell">
          <Checkbox
            data-testid="list-select-row"
            data-record-id={record._id}
            aria-label="この行を選ぶ"
            checked={selection.selectedIds.includes(record._id)}
            onChange={() => selection.toggleRow(record._id)}
            onClick={(event: React.MouseEvent<HTMLInputElement>) => event.stopPropagation()}
            onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => event.stopPropagation()}
          />
        </TableCell>
      )}
      {/*
        セルの器はここが描く(列と型の対応を DOM 上でも追えるよう `data-field` /
        `data-field-type` を出すのは従来どおり)。**表示関数に渡す引数は軸7 の1つだけである**
        (ADR-0050 限定10)—— 寄せは器の属性で当て、切り詰め長だけを値の側へ渡す。
      */}
      {columns.map((field) => {
        const align = columnAlign?.[field.id];
        return (
          <TableCell
            key={field.id}
            data-field={field.id}
            data-field-type={field.type}
            {...(align !== undefined ? { "data-preset-align": align } : {})}
          >
            {/*
              参照先レコードへ辿れるセルはリンクで包む(V3-M3-T02)。**包まないときの
              DOM は1バイトも同じ**であり、表示関数の引数も1つも増えていない。
            */}
            <ReferenceLinkScope
              target={referenceLinkTarget(manifest, field, record[field.id], referenceLabels)}
              appId={appId}
              recordId={record[field.id]}
            >
              <FieldValue
                field={field}
                value={record[field.id]}
                referenceLabels={referenceLabels}
                appId={appId}
                textPreview={textPreview}
              />
            </ReferenceLinkScope>
          </TableCell>
        );
      })}
      {/*
        **【V5-M21-T01】操作起点のセル**(`L-G1`)。**描ける操作起点が1つも無いあいだは
        1つも出ない**(着手前と完全に同じ行である)。**列見出しの側と同じ条件で出す** ——
        片方だけ出ると列数がずれる。**`RowActionOrigins` が条件(`visible_when`)を
        行ごとに評価するので、セルは在るがボタンが1つも無い行はありうる。**
      */}
      {actions.length === 0 ? null : (
        <TableCell className="list-action-cell" data-testid="list-action-cell">
          <RowActionOrigins
            appId={appId}
            viewId={viewId}
            tableId={tableId}
            manifest={manifest}
            actions={actions}
            record={record}
            {...(access?.[record._id] === undefined ? {} : { rowAccess: access[record._id] })}
          />
        </TableCell>
      )}
    </TableRow>
  );
}

/**
 * 一覧の1枚のカード(V4-M16-T13。`P-G24` の (C) 側 / ADR-0093)。
 *
 * **`ListRow`(表の1行)に1対1で対応する。** `data-testid` は `list-row` ではなく
 * `list-card` にしてある —— **同じ testid にすると、表の行を数えている既存の検査が
 * カードでも通ってしまい、器が入れ替わったことが見えなくなる。**
 *
 * **振る舞いは `ListRow` と同じである**(2本目の判定を作らない):
 *
 * 1. **行クリックの遷移**: `onOpen` を受け取り、`tabIndex` / `onClick` / `onKeyDown` を
 *    表と同じ条件で付ける。**遷移先の決定は `resolveDetailViewTarget` 1本のままである。**
 * 2. **参照リンクの二重発火回避**: 押した先が `<a>` の中なら降りる(`closest("a")`)。
 * 3. **`ReferenceLinkScope` と `FieldValue` の呼び方**: **表と1バイトも同じである** ——
 *    **表示関数の引数を1本も増やしていない**(渡すのは軸7 の `textPreview` だけ。
 *    ADR-0050 限定10)。
 *
 * ## 【正直に書く】表と違う点は2つある
 *
 * - **列の寄せ(`preset_column_align`)を1つも当てていない** —— **カードには列が無い**
 *   (ADR-0093 限定8)。**`columnAlign` を props で受け取ってもいない** ——
 *   受け取って捨てると「渡しているのに効かない」形になる。
 * - **列の幅(`preset_column_width`)の `<colgroup>` も出ない** —— 同じ理由である。
 *
 * **どちらも機械では止めていない**(限定8 の第4列)—— **`card` と一緒に書いても差分は
 * 受理される。** **効かないことは `src/mcp/vocabulary.ts` が明記している。**
 *
 * **既存クラス名(`list-row` / `list-row-interactive`)は消さずに足す** ——
 * `cursor: pointer` と hover/focus の地色は `web/src/styles.css` の既存規則が持っており、
 * **カードのために色の宣言を1つも新設していない。**
 */
function ListCard({
  appId,
  manifest,
  columns,
  textPreview,
  record,
  referenceLabels,
  onOpen,
  own,
  selection,
  actions,
  access,
  viewId,
  tableId,
}: {
  /** 所属アプリのID(image 型セルの配信 URL 用。`FieldValue` へ渡すだけ)。 */
  appId: string;
  /** 参照セルの遷移先を規約で解くための入力。**判定も遷移先の決定もここには書かない。** */
  manifest: Manifest;
  columns: Field[];
  /**
   * **選択の器**(`V4-M20-T03`)。**`undefined` のあいだ、カードの DOM は着手前と
   * 1バイトも変わらない。**
   */
  selection: BulkSelection | undefined;
  /**
   * **このカードが「見ている本人の行」か**(`V4-M19-T09`)。**表(`ListRow`)と同じ
   * 述語(`isOwnRow`)の結果をそのまま受け取る** —— 2本目の判定を作らない。
   */
  own: boolean;
  /** `long_text` の切り詰め長(ADR-0050 の軸7)。**表のときと同じものをそのまま渡す。** */
  textPreview: ListView["preset_text_preview"];
  record: RecordRow;
  referenceLabels: ReferenceLabelIndex;
  onOpen: (() => void) | undefined;
  /**
   * **描いてよい操作起点**(`V5-M21-T01`)。**表(`ListRow`)と同じものをそのまま
   * 受け取る** —— 2本目の判定を作らない。**空のあいだ、カードの DOM は着手前と
   * 1バイトも変わらない。**
   */
  actions: readonly RowAction[];
  /**
   * **【`V14-M2-T04`】行ごとの判定**(鍵は行の `_id`)。**表(`ListRow`)と同じものを
   * そのまま受け取る** —— **2本目の判定を作らない。** **カード形式と表形式のどちらか
   * 片方だけに当てない**(`ADR-0402` 限定15)。
   * **`undefined` のあいだ、カードの DOM もボタンの出方も着手前と1バイトも変わらない。**
   */
  access?: Record<string, RowAccess>;
  /**
   * **【`V5-M25-T08`】この行が乗っている画面のID。** **手動起動の入口が「どの画面から
   * 押されたか」を要る**(`ADR-0176`)—— **入口はその画面が宣言した操作起点だけを受ける。**
   */
  viewId: string;
  /**
   * **【`V5-M25-T07` / `L-G3`】この一覧の対象テーブルID。** **値の書換の書込先である。**
   */
  tableId: string;
}) {
  const interactive = onOpen !== undefined;
  return (
    <div
      className={cn(
        "list-card",
        interactive ? "list-row list-row-interactive" : "list-row",
        "flex flex-col gap-s1",
        // **【`V4-M19-T09`】表の行と同じ体裁を当てる**(器の形で見え方を割らない)。
        own && OWN_ROW_CLASS,
      )}
      data-testid="list-card"
      {...(own ? { "data-own-row": "true" } : {})}
      {...(interactive
        ? {
            tabIndex: 0,
            onClick: (event: React.MouseEvent<HTMLDivElement>) => {
              // セル内のリンクが自分で遷移したので、カードはもう何もしない(二重発火の防止)。
              if ((event.target as HTMLElement).closest("a") !== null) {
                return;
              }
              onOpen();
            },
            onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
              // カードそのものにフォーカスがあるときだけ。中のリンク上での Enter は
              // リンク自身の既定動作であって、カードを開く操作ではない。
              if (event.target !== event.currentTarget) {
                return;
              }
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen();
              }
            },
          }
        : {})}
    >
      {/*
       **【V4-M20-T03】カードにも同じ選択の器を出す**(器の形で操作が割れない)。
       **選択していないあいだは1つも出ない。**
       */}
      {selection === undefined ? null : (
        <div className="list-card-select">
          <Checkbox
            data-testid="list-select-row"
            data-record-id={record._id}
            aria-label="この行を選ぶ"
            checked={selection.selectedIds.includes(record._id)}
            onChange={() => selection.toggleRow(record._id)}
            /*
              **止めるのはチェックボックス自身である**(器ではない)—— カードそのものが
              「押すと詳細へ行く」器なので、書かないとチェックを付けた瞬間に画面が遷移する。
              **器に handler を置かない** —— それは支援技術から見て「押せる器」に見える。
            */
            onClick={(event: React.MouseEvent<HTMLInputElement>) => event.stopPropagation()}
            onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => event.stopPropagation()}
          />
        </div>
      )}
      {columns.map((field) => (
        // **列見出し(`Field.name`)はカードの中に出る** —— 表では `<th>` が1回だけ出るが、
        // カードには見出し行が無いので、1枚ごとに項目名を添えないと値が何か分からない。
        // **`data-field` / `data-field-type` は表のときと同じものを出す**(1つも落とさない)。
        <div
          className="list-card-field"
          key={field.id}
          data-field={field.id}
          data-field-type={field.type}
        >
          <span className="list-card-label">{field.name}</span>
          <ReferenceLinkScope
            target={referenceLinkTarget(manifest, field, record[field.id], referenceLabels)}
            appId={appId}
            recordId={record[field.id]}
          >
            <FieldValue
              field={field}
              value={record[field.id]}
              referenceLabels={referenceLabels}
              appId={appId}
              textPreview={textPreview}
            />
          </ReferenceLinkScope>
        </div>
      ))}
      {/*
        **【V5-M21-T01】カードにも同じ操作起点を出す**(器の形で操作が割れない)。
        **描ける操作起点が1つも無いあいだは1つも出ない。****カードには列が無いので
        セルではなく器の最後に置く** —— **表とカードで DOM の形は違うが、押したときに
        運ぶ値(押した行の `_id`)は1バイトも同じである**(`RowActionOrigins` 1本)。
      */}
      {actions.length === 0 ? null : (
        <RowActionOrigins
          appId={appId}
          viewId={viewId}
          tableId={tableId}
          manifest={manifest}
          actions={actions}
          record={record}
          {...(access?.[record._id] === undefined ? {} : { rowAccess: access[record._id] })}
        />
      )}
    </div>
  );
}
