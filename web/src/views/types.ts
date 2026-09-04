/**
 * 汎用ビューコンポーネントの共通インターフェース(V0-P3-T03)。
 *
 * ビュー種別は v0 語彙の3種(`list_view` / `form` / `detail_view`)で固定であり、
 * ここを増やすことは語彙を増やすこと(憲法2)にあたる。したがって
 * `src/kernel/types.ts` の `View` 判別共用体をそのまま使い、フロント側で
 * 型を作り直さない。
 *
 * **【2026-08-14 追記(`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`)。上の「3種で固定」は
 * 今日は偽である。旧文を1バイトも書き換えていない】** **4種目に集計表(`report_view`)が
 * 加わった。** **後段「ここを増やすことは語彙を増やすことにあたる」は今日も真であり、
 * まさにそのとおりの手続き(`ADR-0007` の門A の本審査)を踏んで増えている。**
 * **`src/kernel/types.ts` の `View` をそのまま使うという作法は1バイトも変わっていない** ——
 * **このファイルの export は今日も4本ちょうどである**
 * (`web/test/shell-navigation-boundary.test.ts` が凍結している)。
 * **集計表を描く実装は今日1バイトも無い**(描くのは `V8-M11`)。
 *
 * **【2026-08-15 追記(`V8-M11-T06`)。直前の1文は今日は偽である。旧文を1バイトも書き換えていない】**
 * **集計表を描く実装は `web/src/views/ReportViewRenderer.tsx` に在る**(`ViewHost` の `report_view`
 * 分岐が選ぶ)。**このファイルの export は今日も4本ちょうどで、`Props` の形も1バイトも変わっていない** ——
 * **集計表の描画は `src/kernel/types.ts` の `View` をそのまま受ける作法の内側に収まっている。**
 * **【この1件は `v8-m11.md` §2-5 の一覧に入っていなかった】** —— **`T06` の実装担当が実装中に見つけ、
 * メインが直した。** **10箇所と数えていたものは、実測で 13箇所である。**
 *
 * **【2026-08-16 追記(`V8-M13-T04`。台帳 `Q-G30`)。上の逐語を1バイトも書き換えていない】**
 * **集計表はブラウザに描かれる** —— **上の訂正と同じ内容を、他の散文と同じ字面で書いておく**
 * (`scripts/report-prose-correction-drift.test.ts` が「偽になった将来形を載せたファイルに
 * 今日の事実が同居しているか」を機械的に走査しており、**字面が揃っていないとその走査から
 * 漏れる**)。**`V8-M12` が画面の上にグラフを足したあとも、このファイルの export は4本ちょうどである。**
 */
import type { DetailView, FormView, ListView, Manifest, View } from "../../../src/kernel/types.ts";
import type { RoutePrefill } from "../route.ts";

/**
 * すべての汎用ビューコンポーネントが受け取る props。
 *
 * - `view`: マニフェスト中のビュー定義そのもの。**描画に必要な情報はここにしかない**。
 *   マニフェストに現れない表示オプション(表示密度・ソート状態の保存・スクロール位置など)を
 *   props に足さないこと(3.10)。**あわせて、マニフェストに現れる `app.theme` と
 *   ビューの `preset_…` も props に足さないこと**(下記の改訂を読むこと)。
 *
 *   **【V3-M5-T05 / ADR-0055 で改訂】「描画に必要な情報はここにしかない」は、逃げ道に
 *   ついてだけは今日から偽である。** V3-M5 で `view.custom_css`(逃げ道の**参照** =
 *   資産名 + 内容ダイジェスト)が入り、**CSS の本文はマニフェストの外**(owner 専用の
 *   content-addressed ストア)にある。**したがって画面に当たる見た目の一部は `view` を
 *   読んでも分からない** —— 分かるのは「どの資産のどの版が当たるはずか」までである。
 *   **それでも props は1つも増えていない**(今日も5つ)—— **本文を取りに行くのは
 *   `web/src/views/ViewHost.tsx` であって、レンダラーは1バイトも受け取らない**
 *   (ADR-0055 限定12。`V3-M5-T02` が `git diff -- web/src/views/types.ts` = 0行 で担保した)。
 *   **ここに `customCss` のような props を足すことは、その分離をやめることである。**
 *
 *   **【V3-M2-T05 / ADR-0052 で再改訂】例から「列幅」を外した。** V3-M2 で
 *   `preset_column_width`(列ごとの幅の段階値)がマニフェストに入ったので、
 *   **列幅はもう「マニフェストに現れない表示オプション」の例ではない**(ADR-0050 限定1)。
 *   **それでも props には1つも足していない** —— 軸1〜6 は `view` の中にあり、器の
 *   `data-preset-…` 属性として出すだけで足りる。軸7(`preset_text_preview`)だけは
 *   表示関数へ渡すが、**それも `view` から読むので `ViewRendererProps` は1つも増えていない**
 *   (`V3-M2-T04` が `git diff -- web/src/views/types.ts` = 0行で担保した。ADR-0050 限定10)。
 *   **ここに props を1つ足すことは、マニフェストに現れない表示状態を持つ経路を開くことである。**
 *
 *   **【V3-M1-T06 / ADR-0049 で改訂】旧文言は「表示オプション(テーマ・列幅など)」だった。**
 *   テーマは V3-M1-T03 でマニフェストに入った(`app.theme` の有限スロット。ADR-0047)ので、
 *   **もう「マニフェストに現れない表示オプション」の例ではない。** それでも
 *   **ここに足してはならないことは変わらない** —— テーマは**アプリ単位**であって
 *   ビュー単位ではなく(ADR-0047 限定1 / §3a 3。`$defs/view` にテーマのキーは1つも無い)、
 *   適用はスコープ要素(`web/src/AppWorkspace.tsx` の `.app-theme`)への
 *   カスタムプロパティ注入だけで行う。**テーマの値をレンダラーの props に流すと、
 *   ビュー単位テーマの実装経路が「props を1つ足すだけ」で開いてしまう**
 *   (V3-M1-T04 の完了条件4 が、この禁止を `git diff` の空で担保した)。
 * - `manifest`: 参照解決(`view.table` から `Table` を引く等)のために全体を渡す。
 * - `appId`: レコード API(`/api/apps/:app_id/...`)を呼ぶために必要。
 * - `recordId`: URL が指す対象レコード(`route.ts` の `Route`)。**表示オプションでは
 *   なく画面状態**であり、これが無いと detail_view はどのレコードを出すか決められず、
 *   form は既存レコードを編集できない。コンポーネントの内部状態にせず URL から
 *   受け取ることで、リロードしても同じレコードの画面に戻る。
 */
export type ViewRendererProps<V extends View = View> = {
  appId: string;
  manifest: Manifest;
  view: V;
  recordId?: string | undefined;
  /**
   * 操作起点のプリフィル(EC-G14 / ADR-0045)。**URL には無い一時状態**で、`recordId` と同じく
   * 画面状態として上位から降ってくる。使うのは新規作成フォーム(`FormRenderer`)だけで、
   * 他のビューは無視する。参照フィールド1つに開いているレコードの `_id` を初期値として入れる。
   */
  prefill?: RoutePrefill | undefined;
};

export type ListViewRendererProps = ViewRendererProps<ListView>;
export type FormRendererProps = ViewRendererProps<FormView>;
export type DetailViewRendererProps = ViewRendererProps<DetailView>;
