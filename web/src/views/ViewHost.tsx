/**
 * ディスパッチ層(V0-P3-T03)。
 *
 * **これが解釈実行の中核**である。マニフェストのビュー定義を受け取り、その
 * `type` に応じて汎用コンポーネントを選んで描画する。アプリごとにコンポーネントを
 * 生成するのではなく、**同じ3つのコンポーネントに任意のマニフェストを流し込む**
 * (handover 3.7 / 憲法3)。
 *
 * ここが `switch` なのは意図的である。`Record<ViewType, Component>` の表引きだと
 * `View` 判別共用体が絞り込まれず、各コンポーネントが `ListView` / `FormView` /
 * `DetailView` を正確に受け取れない。`switch` なら網羅性を型検査が保証するので、
 * 将来ビュー種別が増えた場合(= 語彙を広げた場合)はここがコンパイルエラーになる。
 *
 * V0-P3-T04〜T06 は `./ListViewRenderer.tsx` などの中身を差し替えるだけでよく、
 * このファイルもアプリシェルも変更しなくてよい。
 */
import type * as React from "react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { View } from "../../../src/kernel/types.ts";
import { canUseView, useRole } from "../auth/authz.tsx";
// **【`V10-M11-T01` の2手目。台帳 `CM-G4`】画面へのコメントを1件書く導線。**
// **`web/src/` の書込導線1本はこれである**(`ADR-0007:1637` の歯止め1 の宣言)。
//
// **【2026-08-26 訂正。`V10-M33-T01`。台帳 `CM-G43`。すぐ上の2行は1バイトも消していない】**
// **この宣言の住所は `web/src/AppWorkspace.tsx` へ移った** —— **上の2行はそのまま
// あちらの新しい `import` の直上へ書き写してある。** **本ファイルからは静的 `import` を
// 落とした。** **旧行の逐語**:
//   `import { CommentPanel } from "../CommentPanel.tsx";`
//
// **なぜ落としたのか** —— **配る版のエントリ(`web/src/runner-app.tsx`)がこの器を
// 読み込むので、静的 `import` が在るかぎり `CommentPanel` のバイト列は配る版の成果物に
// 必ず入る。** **provider を置いていないので画面には1要素も出ないが、「描かれないだけで
// 入っている」状態だった**(着手前の実測: `web/runner/dist/assets/*.js` に `comment-panel`
// **2** / `comment-body` **1** / `comment-submit` **1** / `comment-sent` **1** /
// 前置きの文言 **1**)。
//
// **今日は書く欄の部品をコンテキストのスロット(下の `CommentPanelComponent`)で
// 受け取る。** **`React.lazy` も動的 `import()` も `import.meta.env` によるビルドモードの
// 分岐も1つも使っていない** —— **前2つは配る版に別チャンクを生み、
// `web/test/runner-entry-boundary.test.ts` の (b)(`web/runner/dist/` 配下の**全**ファイルを
// 走査する)に当たる。** **3つ目は「同じソースから別物を建てる」形であり、
// (a) の対照(既存エントリの成果物)と (b) の対象が別のコードになる。**
import { navigate } from "../navigation.tsx";
import { Button } from "../ui/button.tsx";
import { resolveUiFamily } from "../ui/family.ts";
import { OverlayDialog } from "../ui/overlay.tsx";
import { Alert, AlertDescription, AlertTitle } from "../ui/surfaces.tsx";
import { cn } from "../ui/utils.ts";
import { DetailViewRenderer } from "./DetailViewRenderer.tsx";
import { FormRenderer } from "./FormRenderer.tsx";
import { flowNextRoute, flowPositionOf, flowStepOf, nextFlowStepView } from "./flow.ts";
import { ListViewRenderer } from "./ListViewRenderer.tsx";
// **集計表を描く**(`V8-M11-T06`。台帳 `Q-G20`)—— **`V8-M8` が置いた知らせの差し替え先である。**
import { ReportViewRenderer } from "./ReportViewRenderer.tsx";
import type { ViewRendererProps } from "./types.ts";

/**
 * 画面に出す名前を決める(V1-M0-T02 / F-1)。
 *
 * **`name` が無いときは `id` へ倒す。** これが既定挙動であり、完了条件2 の中身である。
 * `name` は任意(ADR-0007 §7c 限定3)なので、v0 から存在するマニフェストのビューは
 * すべて `name` を持たない。ここで空文字を返すと、それらの画面が名無しになって
 * **表示名を足したことが既存アプリの後退になる**。IDは人間向けではないが、
 * v0 と同じものが出るだけなので後退しない。
 *
 * ビュー一覧(`AppWorkspace`)と見出し(`ViewHost`)の両方がこの1つの関数を使う。
 * 2箇所で別々にフォールバックを書くと、片方だけ直されて食い違う。
 */
export function viewDisplayName(view: View): string {
  return view.name ?? view.id;
}

/**
 * **アプリごとの「コメントの出し入れ」の設定を器へ運ぶ**(`V10-M31-T02`。台帳 `CM-G38` /
 * `ADR-0379` 限定1 / 限定2 / 限定6。利用者決定 `D-V10-40` / `D-V10-38`)。
 *
 * ## なぜ**この1ファイルの中**に全部置いたのか
 *
 * **`ADR-0379` 限定1 は「書く欄の内側(`web/src/CommentPanel.tsx`)を1バイトも触らない」、
 * 限定2 は「出すか否かを分ける箇所を器の側1箇所ちょうどにする」である。**
 * **コンテキストも provider も判定も別ファイルへ出すと、出し分けの住所が2つになる。**
 * **ここに全部置けば、限定1 と 限定2 を**ファイル単位で**満たせる。**
 *
 * **`ViewRendererProps` に props を1本も足していない**(限定6。
 * `web/test/shell-navigation-boundary.test.ts` の (b) が5メンバちょうどに凍結している)——
 * **設定はコンテキストで運ぶ**(ロールを `useRole` で運ぶのと同じ作法)。
 *
 * **【誇張しない】これは書込を止める壁ではない**(`D-V10-38`)—— **止めるのは欄を出すことだけで
 * あり、`POST /api/apps/:app_id/comments` は今日も設定を1度も見ない。**
 */
/**
 * **書く欄の部品そのもの**(`V10-M33-T01`。台帳 `CM-G43`)。
 *
 * **`web/src/CommentPanel.tsx` の `CommentPanel` の形をそのまま写した型である** ——
 * **あちらを1バイトも触っていない**(`ADR-0379` 限定1)。**受け取る材料は
 * `appId` / `view` の2つで、未ログインでは `null` を返す**(あちらの「誰に出すか」)。
 */
type CommentPanelComponent = (props: { appId: string; view: View }) => React.ReactElement | null;

/**
 * **器へ運ぶもの**(`V10-M33-T01`)。
 *
 * **`panel` を省略可にしていない。** **これは「provider が在る ⇒ 書く欄の部品が在る」を
 * 型で保証するためである** —— **省略可にすると `panel` が無いまま `write` が真という
 * 状態が型の上で作れてしまい、出る条件が「provider が在る」「`write` が真」の2つから
 * 「`panel` も在る」を足した3つに増える。** **既定の部品へ倒す `??` を置く形も採らない**
 * (**倒し先を置くと、この器が `CommentPanel` を知っていることになり、静的 `import` を
 * 落とした意味が消える**)。**到達不能な枝を1本も作っていない。**
 */
type CommentVisibility = { write: boolean; read: boolean; panel: CommentPanelComponent };

// **【2026-08-26。`V10-M33-T01`。台帳 `CM-G43`】旧の3行の逐語(1バイトも消していない)**:
//   `const CommentVisibilityContext = createContext<{ write: boolean; read: boolean } | undefined>(`
//   `  undefined,`
//   `);`
// **足したのは `panel` 1本だけである** —— **`write` / `read` の意味も既定の
// `undefined`(= provider の外)も1ミリも変えていない。**
const CommentVisibilityContext = createContext<CommentVisibility | undefined>(undefined);

/**
 * **設定を配る**(置き場所は `web/src/AppWorkspace.tsx` のログイン済みの枝1箇所である)。
 *
 * **未ログインの枝(`AnonymousWorkspace`)は包まない** —— **未ログインには書く欄を1要素も
 * 出さない今日の向きと揃う。** **配る版(`web/src/runner-app.tsx`)にも置いていない**
 * (利用者決定 `D-V10-39`)。
 */
// **【2026-08-26。`V10-M33-T01`。台帳 `CM-G43`】旧の姿の逐語(1バイトも消していない)**:
//   `export function CommentVisibilityProvider({`
//   `  value,`
//   `  children,`
//   `}: {`
//   `  value?: { write: boolean; read: boolean } | undefined;`
//   `  children: React.ReactNode;`
//   `}) {`
//   `  return (`
//   `    <CommentVisibilityContext.Provider value={value}>{children}</CommentVisibilityContext.Provider>`
//   `  );`
//   `}`
//
// **足したのは `panel`(必須)1本と、それを `value` へ束ねる1行だけである。**
// **`value` が `undefined`(= 設定がマニフェストに載っていない経路)のときは、今日どおり
// コンテキストへ `undefined` を流す** —— **`panel` が在っても設定が無ければ器は
// fail-closed のままである。** **「`panel` を渡したから出る」という3つ目の条件を
// 作っていない。**
export function CommentVisibilityProvider({
  value,
  panel,
  children,
}: {
  value?: { write: boolean; read: boolean } | undefined;
  /**
   * **書く欄の部品を、器の外から差し込む**(`V10-M33-T01`)。
   *
   * **必須である** —— **省略可にすると、`web/src/` の中に「部品が届いていないので出せない」
   * という3つ目の判定が生まれる。** **`web/src/AppWorkspace.tsx`(= 育成用の版の
   * ログイン済みの枝)だけがこれを渡す。** **配る版(`web/src/runner-app.tsx`)は
   * provider を1本も置かないので、`CommentPanel` を1度も名指ししない**
   * (利用者決定 `D-V10-39`。**これが配る版の成果物から書く欄が落ちる理由である**)。
   */
  panel: CommentPanelComponent;
  children: React.ReactNode;
}) {
  return (
    <CommentVisibilityContext.Provider
      value={value === undefined ? undefined : { ...value, panel }}
    >
      {children}
    </CommentVisibilityContext.Provider>
  );
}

/**
 * **書く欄を出すか**。**provider の外・`undefined`・`write` が真でない、のすべてで
 * `false` を返す(fail-closed)。**
 *
 * ## **なぜ fail-closed なのか**(向きの理由)
 *
 * 1. **利用者決定 `D-V10-40` が「既定は OFF」である** —— **材料が届いていないことは
 *    「まだ何も決めていない」であって「出してよい」ではない。**
 * 2. **届いていないときに出す形にすると、器を provider の外で描いた瞬間に書く欄が
 *    黙って復活する** —— **要望(出し入れできるようにする)と逆向きの壊れ方である。**
 * 3. **`web/src/auth/authz.tsx` の `RoleContext` は provider 外を「判定材料が無い」として
 *    据え置く(fail-open)。** **本件は向きが逆である** —— **あちらは人の役割の話であり、
 *    こちらはアプリ単位の設定の話である。** **`ADR-0053` を1バイトも引き直していない。**
 *
 * **export していない** —— **器の外から呼ばれないようにするためである**(限定2)。
 */
// **【2026-08-26。`V10-M33-T01`。台帳 `CM-G43`】旧の3行の逐語(1バイトも消していない)**:
//   `function useCommentWriteEnabled(): boolean {`
//   `  return useContext(CommentVisibilityContext)?.write === true;`
//   `}`
//
// **返すものを「出してよいか(真偽)」から「出す部品(またはその不在)」へ変えた。**
// **向きは1ミリも変わっていない** —— **provider の外・`undefined`・`write` が真でない、
// のすべてで `undefined` を返す(fail-closed)。** **上の doc の3点(`D-V10-40` の既定 OFF /
// provider 外で黙って復活しない / `RoleContext` とは向きが逆)はそのまま当てはまる。**
// **判定式の住所は今日も2箇所である**(この関数と下の `useCommentReadEnabled`)——
// **3つ目を作っていない。** **`export` していないのも今日どおりである**(限定2)。
function useCommentPanel(): CommentPanelComponent | undefined {
  const visibility = useContext(CommentVisibilityContext);
  return visibility?.write === true ? visibility.panel : undefined;
}

/**
 * **読む場所(積まれたコメントを読み返す導線とパネル)を出すか**(`V10-M32-T02`。台帳 `CM-G40`。
 * 利用者決定 `D-V10-38` / `D-V10-36`)。
 *
 * **`provider の外`・`undefined`・`read` が真でない、のすべてで `false` を返す(fail-closed)。**
 * **向きは上の {@link useCommentWriteEnabled} と1ミリも同じである** —— 理由もそちらの
 * 3点(`D-V10-40` の既定 OFF / provider 外で黙って復活しない / `RoleContext` とは向きが逆)
 * がそのまま当てはまる。**上の doc を1バイトも書き換えていない。**
 *
 * ## **なぜ `export` するのか**(**書く側との非対称を隠さない**)
 *
 * **使う場所が別ファイル(`web/src/AppWorkspace.tsx`)だからである。** **読む場所の導線
 * (`data-testid="open-comment-list"`)と三項連鎖の枝は、どちらもこの器(`ViewHost`)の
 * 外側、つまりアプリの器の側に在る。** **書く側(`useCommentWriteEnabled`)は同じファイルの
 * 中(`ViewHost` の本体)で使うので、今日どおり非 export のままである。**
 * **この非対称は隠さない** —— **「両方 export していない」とも「両方 export した」とも
 * 書けない状態である。**
 *
 * ## **`ADR-0379` 限定2 との緊張**(**丸めない**)
 *
 * **限定2 の逐語は「出し分けの判定が `web/src/` の中で1箇所ちょうど」であり、
 * 「書く欄の」とは1文字も書いていない。** **したがって read 側を足した今日、
 * `web/src/` の中の判定式は1箇所から2箇所になった**(`useCommentWriteEnabled` と
 * `useCommentReadEnabled`)。**「限定2 を守っている」とは書けない。**
 *
 * **【実測。2026-08-26。`V10-M32-T02` の着手前と着手後の両方を貼る】**
 * **この緊張を数える検査は、着手前も着手後も0件である。**
 *
 * 打った式(`apps/smailtalk` の中):
 * `LC_ALL=C /usr/bin/grep -rF '<綴り>' web/test/ src/ scripts/ | wc -l`
 *
 * | 綴り | 着手前 | 着手後 |
 * | --- | --- | --- |
 * | `CommentVisibilityContext` | **0** | **0** |
 * | `useContext(CommentVisibility` | **0** | **0** |
 * | `useCommentWriteEnabled` | **0** | **1** |
 * | `ViewRendererProps`(陽性対照) | **18** | **18** |
 * | `CommentPanel`(陽性対照) | **13** | **13** |
 * | `CommentVisibilityProvider`(陽性対照) | **8** | **11** |
 *
 * **【自己参照で数が動いた2行を隠さない】** **`useCommentWriteEnabled` の 0 → 1 は、
 * 本タスクが `web/test/comment-visibility-toggle.test.tsx` の doc にその綴りを1度書いた
 * ためであり、数える検査が1本増えたのではない。** **`CommentVisibilityProvider` の
 * 8 → 11 も、`web/test/comment-list.test.tsx` が (m-1) の陽性対照でこの器を使ったための
 * 増分である。** **判定の住所そのものを名指しする綴り(`CommentVisibilityContext`)は、
 * 着手前も着手後も0である** —— **これが「数える検査が1本も無い」の根拠である。**
 *
 * **リポジトリ全体(`--include='*.ts' --include='*.tsx'`、`node_modules` 除外)でも
 * `CommentVisibilityContext` の出現は本ファイルの3行だけであった**(着手前の実測)——
 * **今日は `useCommentReadEnabled` の1行が増えて、コードは本ファイルの4行である。**
 * **同じ式を今日打つと7行返るが、増えた3行はこの doc 自身が綴りを引用した行である**
 * (**貼った瞬間に数が動く型なので、コードの行数と分けて書く**)。
 *
 * **受け皿は `V10-M34-T02`(`ADR-0380` の見張り)である** —— **本タスクでは数える検査を
 * 1本も足していない**(足すと、その本数の焼き込みが本タスクの射程を超える)。
 *
 * ## **【誇張しない】これは書込も読取も止める壁ではない**(`D-V10-38`)
 *
 * **`GET /api/apps/:app_id/comments` も MCP の `list_comments` も1バイトも閉じていない。**
 * **止まるのは画面に出すことだけである** —— **設定が OFF のアプリでも、口を直に叩けば
 * 今日どおり応答が返る**(`web/test/comment-list.test.tsx` の (p) がそれを実測する)。
 * **本タスクは `src/` を1バイトも触っていないので、「読めなくした」とは書けない。**
 *
 * ## **【2026-08-26 訂正。`V10-M33-T01`。台帳 `CM-G43`。上の doc を1バイトも書き換えていない】**
 *
 * **上の doc が名指ししている `useCommentWriteEnabled` という綴りは、今日はもう無い。**
 * **同じ場所・同じ向きの関数が `useCommentPanel` という名前になっている**(返すものが
 * 真偽から「出す部品(またはその不在)」へ変わったため)。**「上の {@link} が指す先が
 * 消えた」ことだけが変わったのであって、参照している性質(fail-closed である・
 * `export` していない・判定の住所が2箇所である)は1つも変わっていない。**
 *
 * **したがって、上の表の `useCommentWriteEnabled` の行(着手前 0 / 着手後 1)は、
 * 今日打つと 0 に戻る** —— **その1件は `web/test/comment-visibility-toggle.test.tsx` の
 * doc がこの綴りを引用していた行であり、本タスクがそちらにも訂正を書いたためである。**
 * **数える検査が1本増えたのでも減ったのでもない。**
 */
export function useCommentReadEnabled(): boolean {
  return useContext(CommentVisibilityContext)?.read === true;
}

export function ViewHost({ appId, manifest, view, recordId, prefill }: ViewRendererProps) {
  /**
   * 逃げ道の配信状態を**ここで持つ**(V4-M15-T12)。
   *
   * **なぜ `EscapeHatchStyle` の中から引き上げたか** —— 4つ目の状態(下記)は `<style>` の
   * 兄弟として知らせを出す必要があるが、`EscapeHatchStyle` の最後の1行(`.app-theme` の包み)は
   * **ADR-0088 限定7 が「1バイトも変えない」と定めた行**である。包みを断片(`<>…</>`)で
   * 囲み直すとその行が動き、包みを2箇所に書き写すと**包み方が2箇所に住んで食い違う**。
   * **状態を親に置けば、包みの行に1バイトも触れずに兄弟を足せる。**
   */
  const [escapeHatch, setEscapeHatch] = useState<EscapeHatchState>({ status: "idle" });
  /*
   * **一続きの流れの「次へ」**(`V10-M4-T02`。`NV-G9` / `NV-G11` / `NV-G7a` の受け先。
   * `ADR-0359` §4b 限定5 / `ADR-0360` 限定2)。
   *
   * ## **なぜ器(`ViewHost`)に置いたのか**
   *
   * **段は `list_view` / `form` / `detail_view` の3種別すべてに書ける**(`report_view`
   * だけがスキーマで閉じている)。**器に1本置けば実装が1箇所で済み、`ADR-0359` §4b
   * 限定5 の「2本目の規則を作らない」をそのまま守れる。**
   * **`ViewRendererProps` に props を1本も足していない**(`web/test/shell-navigation-boundary.test.ts`
   * の (b) が5メンバちょうどに凍結している)—— **要る材料(`appId` / `manifest` /
   * `view` / `recordId`)はこの器が既に受けており、ロールはコンテキスト(`useRole`)で
   * 運ぶ(`ADR-0053` 限定3)。**
   *
   * ## 出す条件(**AND。全部満たしたときだけ出す**)
   *
   * 1. **この画面が段を宣言している**(`flowStepOf`)。
   * 2. **この画面が `form` でない** —— **`form` にはボタンを出さない。**
   *    **`form` は「保存が成立したら次の段へ行く」であり、その分岐は
   *    `FormRenderer.tsx` の `afterSubmitRoute` の先頭に1本だけ在る**
   *    (**送信ボタンの文言 `保存` を1バイトも触っていない**)。
   * 3. **`kind` が `"confirm"` でない** —— **確認の段は「確定」で進む画面であり、
   *    その遷移は `V10-M4-T03` の担当である。****本タスクは「出さない」ことだけを実装した。**
   * 4. **同じ流れの `step + 1` の画面がこのマニフェストに実在する**(最後の段では出ない)。
   * 5. **その画面がその人に見える**(`canUseView` 1本。**判定を再実装していない**)。
   *
   * **どれか1つでも欠ければボタンごと出さない**(fail-closed。`navigation.tsx:171` の
   * `resolveRowActionDestination` と同じ作法)。**`form` の保存の後だけは逆で、
   * 段が解けなければ今日どおりの規約に倒れる** —— **押す前に解決できるか否かで
   * 使い分けている**(ボタンは押される前に解ける。保存の後は既に押されている)。
   *
   * ## **【誇張しない】ここで出さないことは遮断ではない**
   *
   * **遮断はサーバの 401 / 403 / 404 である。** **ここで消しているのは
   * 「その人には開けない画面へ進む導線」だけである。**
   *
   * ## **匿名(未ログイン)の経路の実測**(点検 `B-6`)
   *
   * **`AnonymousWorkspace` は `RoleProvider` で包まない**(`web/src/AppWorkspace.tsx` の
   * 逐語)ので、**ここで `useRole()` は `null` を返す。**
   * **`canUseView(null, …)` は `canUseView(ANONYMOUS, …)` と同じ答えを返す**
   * (`web/src/auth/authz.tsx` の `canReadTableRole` が今日は常に `true` を返し、
   * 判定は `judgeRoleAccess` 1本に落ちる。`roles: null` は `anonymous` として判定される)。
   * **したがって匿名の公開画面でも、面が `anonymous` に次の段の読取を配っていれば
   * 導線は出る。****「匿名では常に出ない」ではない**(実測は
   * `web/test/flow-next-step.test.tsx` の (f-2) 群)。
   */
  const role = useRole();
  const here = flowStepOf(view);
  const nextStep = nextFlowStepView(manifest, view);
  const flowNextBlock =
    here !== undefined &&
    here.kind !== "confirm" &&
    view.type !== "form" &&
    nextStep !== undefined &&
    canUseView(role, manifest, nextStep) ? (
      <div className={cn("flow-next", "flex")} data-testid="flow-next">
        <Button
          type="button"
          data-testid="flow-next-button"
          onClick={() => {
            /*
             * **手元に行の `_id` があるのは詳細画面だけである** —— **一覧は行を1件も
             * 指していないので、URL に行が載っていても運ばない**(`V10-M4` の決6)。
             * **運ぶ先は「同じ表の `detail_view`」に限る**(`flowNextRoute` の中)。
             */
            const route = flowNextRoute(
              appId,
              manifest,
              view,
              view.type === "detail_view" ? recordId : undefined,
            );
            if (route !== undefined) {
              navigate(route);
            }
          }}
        >
          {/*
           * **文言はリテラル1つである**(`ADR-0102` 限定6 が今日も宣言を禁じている)——
           * **マニフェストから1文字も取っていない。**
           */}
          次へ
        </Button>
      </div>
    ) : null;
  /*
   * **いま何段目 / 全部で何段**(`V10-M5-T02`。`NV-G9` / `NV-G11` / `ADR-0359` §4b)。
   *
   * ## **出すのは2つの数だけである**(限定を先に書く)
   *
   * - **段の名前(流れID)・段の種類(`kind`)・アイコン・色・進捗率・残り時間を
   *   1つも出さない**(文言は `3段目 / 全5段` の1形に固定してある)。
   *   **位置を先・全体を後に置く形は `ListViewRenderer.tsx` の `list-total`
   *   (`1–32 件 / 全 32 件`)と同じである。**
   * - **押せない表示である** —— **`<p>` で描き、`button` も `a` も1つも作っていない。**
   *   **他の段へ飛べる導線を1本も足していない**(`navigate()` の呼び出しを1本も
   *   足していない。既存の遷移条件も1つも変えていない)。
   * - **段を宣言していない画面では `null` である** —— **要素が1つも出ず、DOM は
   *   今日と1バイトも変わらない**(`flowNextBlock` と同じ作法)。
   * - **URL に1文字も載せない**(`NV-G13` 限定3)—— **`history` にも画面の状態にも
   *   総数を1つも持たない。** **呼ばれるたびに宣言の集合から導く。**
   * - **クラス名は付けるが CSS 規則を1本も書いていない**(`flow-next` / `list-create` と
   *   同じ。`web/src/styles.css` にも `web/src/tailwind.css` にも1バイト足していない)。
   *
   * ## **「閉じた段」がこの総数に入るかは、経路で違う**(**直していない。実測した**)
   *
   * **【禁止】「閉じた段も必ず数に入る」と書かない。**
   *
   * 1. **ログイン済み** —— **`GET /api/apps/:app_id/manifest` は役割でビューを1件も
   *    間引かない。****この器に渡る `manifest.app.views` は全量であり、その人に
   *    開けない段も総数に入る。**
   * 2. **未ログイン** —— **`GET /api/apps/:app_id/public` は `judgeRoleAccess` で
   *    ビューを絞ってから返し、`publicManifest()`(`web/src/AppWorkspace.tsx`)が
   *    その絞られた集合をそのまま渡す。****見せると決めた段だけが総数に入り、
   *    同じ流れが小さい数に見える。**
   *
   * **実測は `web/test/flow-position.test.tsx` の (d-1) / (d-2) である。**
   * **可視性の判定(`canUseView`)をこの導出に1文字も混ぜていない** ——
   * **混ぜると総数が人ごとに変わり、上の非対称が2つに増えるだけである。**
   */
  const flowPosition = flowPositionOf(manifest, view);
  const flowPositionBlock =
    flowPosition === undefined ? null : (
      <p
        className={cn("flow-position", "text-note text-muted-foreground")}
        data-testid="flow-position"
      >
        {`${flowPosition.position}段目 / 全${flowPosition.total}段`}
      </p>
    );
  /*
   * **段として宣言された画面に置く「戻る」の既定の導線**
   * (`V10-M5-T01` が入力画面の中に置き、`V10-M18-T03`(`FU-G3`)が**この器へ1本だけ移した**)。
   *
   * ## **なぜ器へ移したのか**
   *
   * **段は `list_view` / `form` / `detail_view` の3種別すべてに書ける**(`report_view`
   * だけがスキーマで閉じている)。**入力画面の中に置いていたあいだ、「戻る」は
   * `form` の段にしか出なかった** —— **一覧の段でも確認の段でも、前へ戻る既定の導線が
   * 1つも無かった。** **器に1本置けば、実装を2本にせずに3種別すべてへ届く。**
   *
   * ## 出す条件は2つの AND だけである(**移送前と同じ2つ。3本目を作っていない**)
   *
   * 1. **この画面が段を宣言している**(`flowStepOf`)。
   * 2. **重ねて出す画面(`modal`)ではない** —— **器そのものが `Escape` / 背面クリックで
   *    履歴を1つ戻すので、同じことをする2本目のボタンを中に置かない。**
   *    **`modal` は入力画面にしか書けない**(一覧と詳細の分岐はスキーマが `false` で
   *    閉じている)ので、条件は「入力画面でないか、または重ねる宣言が真でないか」の形になる。
   *    **重ねる宣言を否定する綴りは、この木の中で下の1行だけである**
   *    (**この doc に同じ綴りを書き写さない** —— **書き写すと、その本数を数える式が
   *    doc の分だけ増える。** **実測でそうなった**)。
   *
   * **3本目の条件を作っていない。** **段の位置(`step`)で分岐していない。**
   * **画面の種別でも段の種類(`kind`)でも分岐していない** —— **`flowNextBlock` が
   * 種別と `kind` を見るのとは違う。**
   *
   * ## **移送で DOM が変わった点は2つある**(**隠さない**)
   *
   * 1. **入力画面では、`flow-back` が `<section data-testid="view-renderer-form">` の
   *    **外**へ出た。** **上下の並び(見出し → 位置 → 戻る → 本体)は1つも動いていないが、
   *    入れ子は1段浅くなった。** 実測は `web/test/flow-back-step.test.tsx` の (g-2)。
   * 2. **入力画面が「読み込み中…」のあいだにも出るようになった。** **移送前は出なかった**
   *    —— `FormRenderer.tsx` の `state.status === "loading"` の分岐に「戻る」が1つも
   *    無かったからである。**器は本体の外なので、本体がまだ読み込み中でも出る。**
   *    実測は同ファイルの (g-3)。
   *
   * > **【この実装の限界。隠さない】** **URL を直接開いた場合、履歴に前の項目が無い。**
   * > **そのとき `history.back()` はブラウザ内で何も起こさない**(この製品の外の挙動である)。
   * > **「必ず前の段に戻れる」とは書けない。**
   * > **さらに、`navigate()` は `path !== currentUrl()` のときだけ履歴を積む**
   * > (`navigation.tsx:70`-`:72`)—— **URL が1文字も変わらない画面の入れ替えは
   * > 履歴を1つも積まないので、そこから押しても前の段には戻らない。**
   * > **出す画面が3種別に広がった分だけ、「押しても何も起きない」場面も増える。**
   *
   * ## ほかに、この導線がしていないこと(**誇張しない**)
   *
   * - **戻り先を宣言する口を1つも作っていない** —— **行き先は履歴だけであり、
   *   マニフェストから1文字も読まない**(文言も `戻る` のリテラル1つである)。
   * - **段1 でも出す。****段1 の「戻る」は流れの外へ出る。** これは欠陥ではなく、
   *   **戻り先が履歴であることの帰結である。**
   * - **段を宣言していない画面には1ピクセルも出ない**(実測は
   *   `web/test/flow-back-step.test.tsx` の (b) 群と (d-5))。
   *   **【2026-08-21 訂正】** **移送前のこの行は「段を宣言していない**入力画面**には」
   *   だった** —— **今日は3種別すべてについて言える。**
   * - **`flow.ts` に「前の段」を導く関数を1本も作っていない**(`step - 1` を探す実装を
   *   書かない。字面の走査は同ファイルの (g-1))。 **`flow.ts` は1バイトも触っていない。**
   *
   * **クラス名(`flow-back`)は付けるが、`web/src/styles.css` に規則を1本も書いていない**
   * (`flow-next` / `list-create` と同じ作法)。
   */
  const flowBackBlock =
    flowStepOf(view) !== undefined && (view.type !== "form" || view.modal !== true) ? (
      <div className={cn("flow-back", "flex")} data-testid="flow-back">
        <Button
          type="button"
          data-testid="flow-back-button"
          onClick={() => {
            window.history.back();
          }}
        >
          戻る
        </Button>
      </div>
    ) : null;
  /*
   * **アプリごとの設定で、書く欄を出すか否かを決める**(`V10-M31-T02`。台帳 `CM-G38` /
   * `ADR-0379` 限定2。利用者決定 `D-V10-40`)。
   *
   * **判定を呼ぶのはこの1行だけであり、分岐は下の1箇所だけである** —— **2箇所に住むと、
   * 片方だけ直されて食い違う。** **`web/src/CommentPanel.tsx` の内側には1バイトも
   * 判定を置いていない**(限定1)。
   */
  // **【2026-08-26。`V10-M33-T01`】旧行の逐語(1バイトも消していない)**:
  //   `const commentWriteEnabled = useCommentWriteEnabled();`
  // **受け取るものが真偽から部品へ変わっただけで、呼ぶのは今日もこの1行だけである。**
  const CommentSlot = useCommentPanel();
  return (
    <>
      {/*
       * 逃げ道(任意 CSS)の配信(V3-M5-T02 / D-G5。ADR-0055 限定6・7・12・13)。
       * **参照を持つ画面でだけ何かが起きる。**持たない画面では HTTP を1本も叩かず、
       * DOM にも1要素も出ない(既存の全画面は今日と1バイトも変わらない)。
       */}
      <EscapeHatchStyle appId={appId} view={view} state={escapeHatch} onState={setEscapeHatch} />
      {/*
       * 4つ目の状態の知らせ(V4-M15-T12 / P-G48 / D-V4-15。ADR-0087 限定9)。
       * **配信は1バイトも止めない** —— 上の `<style>` は今までどおり出たうえで、
       * 「当たり先が変わりうる」ことだけを持ち主に足して知らせる。
       */}
      {escapeHatch.status === "target_unverified" ? <EscapeHatchTargetNotice /> : null}
      <ViewShell view={view}>
        {/*
         * **画面ごとの詰まり具合**(`V4-M19-T04` / `P-G32` の (C) 側。`ADR-0118` 限定6〜限定8・限定10)。
         * **宣言を書いた画面にだけ作用域が立つ** —— 書かなかった画面では要素が1つも出ず、
         * DOM は今日と1バイトも変わらない。**器の内側に置いてある**(`ViewShell` の子)ので、
         * 重ねて出す画面(`modal`)でもポータルの中で当たる。
         */}
        <ViewDensityScope view={view}>
          {/*
           * 見出し。`name` を足しても表示先が無ければ要求は満たされない(計画書 完了条件1)ので、
           * ディスパッチ層が種別によらず必ず1つ出す。描画の中身は従来どおり各レンダラに任せる。
           */}
          <h3 data-testid="view-title">{viewDisplayName(view)}</h3>
          {/*
           * **いま何段目 / 全部で何段**(`V10-M5-T02`)。**見出しの直後・本体の前である。**
           * **段を宣言していない画面では `null` であり、DOM は今日と1バイトも変わらない。**
           */}
          {flowPositionBlock}
          {/*
           * **「戻る」**(`V10-M18-T03` / `FU-G3`。**`V10-M5-T01` の実装をここへ移した**)。
           * **位置の直後・本体の前である** —— **入力画面の上下の並びが1つも動かない置き方で
           * ある**(移送前の並びも 見出し → 位置 → 戻る → 本体 だった)。
           * **段を宣言していない画面では `null` であり、DOM は今日と1バイトも変わらない。**
           */}
          {flowBackBlock}
          <ViewBody
            appId={appId}
            manifest={manifest}
            view={view}
            recordId={recordId}
            prefill={prefill}
          />
          {/*
           * **段を宣言していない画面では `null` である** —— **要素が1つも出ず、DOM は
           * 今日と1バイトも変わらない**(`ViewDensityScope` / `ViewShell` と同じ作法)。
           */}
          {flowNextBlock}
          {/*
           * **この画面へのコメントを1件書く導線**(`V10-M11-T01` の2手目。台帳 `CM-G4`)。
           * **本体のいちばん下・段の「次へ」の後である** —— **既存の並びを1つも動かさない
           * 置き方である**(足したのは末尾の1要素だけ)。
           * **未ログインでは `null` を返すので、匿名の画面の DOM は今日と1バイトも変わらない**
           * (`web/src/CommentPanel.tsx` の「誰に出すか」)。
           * **`ViewRendererProps` に props を1本も足していない** —— **要る材料
           * (`appId` / `view`)はこの器が既に受けている**(`web/test/shell-navigation-boundary.test.ts`
           * の (b) が5メンバちょうどに凍結している)。
           */}
          {/*
           * **【2026-08-25。`V10-M31-T02`。台帳 `CM-G38` / `ADR-0379` 限定2 /
           * 利用者決定 `D-V10-40`】旧行の逐語(1バイトも消していない)**:
           *   `<CommentPanel appId={appId} view={view} />`
           * **今日は、アプリごとの設定が真のときだけ出す。** **既定は OFF なので、
           * 設定を1度も触っていないアプリでは1要素も出ない**(`web/test/flow-position.test.tsx`
           * などの器の子の並びは、その姿へ戻る)。 **出たときの中身も置き場所も1バイトも
           * 変えていない** —— **落ちるのはこの1要素だけである。**
           */}
          {/*
           * **【2026-08-26。`V10-M33-T01`。台帳 `CM-G43`】旧行の逐語(1バイトも消していない)**:
           *   `{commentWriteEnabled ? <CommentPanel appId={appId} view={view} /> : null}`
           * **分岐は今日も1箇所・1本である。** **描く部品が静的 `import` から
           * コンテキストのスロットへ変わっただけで、渡す材料(`appId` / `view`)も
           * 置き場所(本体のいちばん下)も1バイトも変えていない。**
           */}
          {CommentSlot ? <CommentSlot appId={appId} view={view} /> : null}
        </ViewDensityScope>
      </ViewShell>
    </>
  );
}

/**
 * **画面ごとの詰まり具合の作用域**(`V4-M19-T04`。`P-G32` の (C) 側 / `ADR-0118`
 * 限定6 / 限定7 / 限定8 / 限定10)。
 *
 * ## これは何で、何ではないか
 *
 * **`ADR-0086` 限定4(「書けるが効かない」を1つも作らない)の履行がここである** ——
 * **`V4-M19-T03` が通した宣言(`preset_density`)に、`V4-M15-T18` が作った器の系統
 * (`comfortable` / `compact`)を当てる。**
 *
 * - **宣言を書いた画面にだけ要素が1つ出る**(限定8)—— **書かなかった画面では `null` を
 *   返して素の子を並べるので、DOM は今日と1バイトも変わらない。** **既定を反転させていない。**
 * - **判定は `resolveUiFamily()` の1箇所に保つ**(限定7)—— **ここは結果を DOM に置くだけで、
 *   `??` も既定値も1つも書いていない。** **知らない値が来ても落ちない**(関数が既定に倒す)。
 * - **マニフェストの値からクラス名を1つも生やしていない**(限定10 = `ADR-0087` 限定6)——
 *   **`data-ui-family` の属性値に `enum` の1要素が入るだけである。** **アプリID・画面IDを
 *   指す属性を1つも新設していない**(その2つの属性名を本ファイルに書かないのは、
 *   `web/test/preset-boundary.test.ts` の (iv) が製品コードから字面で0件を数えているためである)。
 *   **safelist を1行も置いていない。**
 * - **`display: contents` の器である**(`contents` クラス)—— **箱を作らないので、
 *   宣言を書いた画面でも器そのものが余白や並びを1ピクセルも動かさない。** 動くのは
 *   **中の部品**(ボタン・入力欄・表のセル・カード)の側だけである。
 * - **`web/src/styles.css` にも `web/src/tailwind.css` にも1バイトも書いていない** ——
 *   当たり先は `V4-M15-T18` が既に置いた `group-data-[ui-family=compact]/ui:` 変種である。
 *
 * ## 解けていないこと(**隠さない**)
 *
 * 1. **重ねて出す画面(`modal`)の器そのもの(`OverlayDialog` の枠・内側余白・角丸)は、
 *    この作用域の外にある。** **枠はアプリ単位の系統で描かれる。**
 * 2. **アプリ全体が `compact`(ビルド時の `VITE_ST_UI_FAMILY`)のとき、画面に
 *    `comfortable` と書いても戻らない** —— **当たり先は「祖先のどれかが `compact`」で
 *    当たるためである。** **既定(`comfortable`)では起きないが、起きうることは隠さない**
 *    (実測は `web/test/view-density.test.tsx` の (T04-6))。
 * 3. **「画面ごとに当てられることを確かめた」と、CSS の計算値については書けない** ——
 *    **happy-dom は CSS を1バイトも計算しない。** **chromium の実測は別に採る。**
 */
function ViewDensityScope({ view, children }: { view: View; children: React.ReactNode }) {
  // **書かなかった画面は器を1つも通らない** —— 今日と1バイトも変わらない(限定8)。
  // **【`V8-M8` による追記。旧文を1バイトも書き換えていない】** **集計表(`report_view`)には
  // `preset_density` を書けない**(`schemas/manifest.schema.json` の `allOf` の
  // `report_view` 分岐が `false` で閉じている)ので、**器を1つも通らない側へ倒す。**
  if (view.type === "report_view" || view.preset_density === undefined) {
    return <>{children}</>;
  }
  return (
    <div
      className="contents group/ui"
      data-ui-family={resolveUiFamily(view.preset_density)}
      data-testid="view-density-scope"
    >
      {children}
    </div>
  );
}

/**
 * **宣言を器に当てる**(`V4-M18-T04`。`P-G14` の (C) 側 / `ADR-0095` 限定3 / 限定8 / 限定9)。
 *
 * ## これは何で、何ではないか
 *
 * **`ADR-0095` が通した宣言(`modal`)に、`ADR-0094` が通した器(`OverlayDialog`)を当てる。**
 * **`ADR-0086` 限定4(「書けるが効かない組み合わせ」を1つも作らない)の履行がここである** ——
 * **宣言だけ通して器を当てないと、AI が書けるのに何も起きないキーができる。**
 *
 * - **書かなかった画面は今日と1ピクセルも変わらない**(限定3)—— **`false` と明示した画面も同じ。**
 *   **既定を反転させていない。**
 * - **`type` が `form` の画面でだけ器に入る。** **一覧と詳細は `schemas/` 側が宣言そのものを
 *   拒否する**(限定4)ので、ここに到達しない —— **それでも種別で分岐しているのは、
 *   表示層が「form 以外でも重ねる」実装にならないようにするためである。**
 * - **マニフェストの値からクラス名を1つも生やしていない**(限定8 / `ADR-0087` 限定6)——
 *   **真偽値を分岐して、リテラルの器を選ぶだけである。** safelist を1行も置いていない。
 *
 * ## 閉じたときに何が起きるか(**正直に書く**)
 *
 * **履歴を1つ戻る。** **`menu_listed` が偽の画面なので、ここへ来る経路は行クリック /
 * 操作起点(`actions`)/ URL の直接入力の3つであり、前の2つは履歴を1つ積んでいる。**
 *
 * > **【この実装の限界。隠さない】** **URL を直接開いた場合、履歴に前の項目が無い。**
 * > **そのとき `history.back()` はブラウザ内で何も起こさない**(この製品の外の挙動である)。
 * > **「閉じれば必ず元の画面に戻る」とは書けない。** **`ADR-0095` はこの点に1条も触れていない。**
 *
 * **閉じ方(`Escape` / 背面クリック)をアプリが選ぶ口を1つも作っていない**(限定2)。
 *
 * ## **器をアプリ単位テーマの内側に差す**(`V4-M18-T04` が chromium で実測して直した)
 *
 * **`Dialog.Portal` は既定で `document.body` の直下へ差す。** **そこは
 * `AppThemeScope`(`.app-theme`)の外であり、25スロットは inline `style` でその要素に
 * 立っているので、外へ出した器には**アプリのテーマが1つも届かない**(`:root` の既定値で
 * 描かれる)。**逃げ道(任意 CSS)も `.app-theme { … }` の入れ子で配られるので届かない。**
 *
 * **そこで、自分の DOM 上の位置から `.app-theme` の祖先を引いて差し込み先に渡す。**
 * **`document.querySelector(".app-theme")` を使わない** —— **テーマ候補のプレビュー
 * (`ThemePreviewPanel`)が同じクラス名の器を同時に描く**ので、文書の先頭から探すと
 * 別のアプリの配色を引きうる。**祖先をたどれば必ず自分の器に当たる。**
 *
 * **差し込み先が決まるまでの1描画では器を出さない** —— 途中で差し込み先を差し替えると、
 * ポータルの中身が作り直され、焦点の初期位置がやり直しになるためである。
 *
 * **祖先に `.app-theme` が無ければ `document.body` へ倒す**(fail-open)——
 * **黙って器を出さない方が危険である。** 出さなければ「宣言は書けるのに画面が
 * 1ピクセルも変わらない」= **`ADR-0086` 限定4 が禁じた「書けるが効かない」そのものになる。**
 * **倒れた先ではアプリのテーマが届かない**(既定の配色で描かれる)。**それは隠さない。**
 */
function ViewShell({ view, children }: { view: View; children: React.ReactNode }) {
  // **真偽値の分岐だけである。** `view.modal` は `form` にしか存在しない(`FormView`)。
  const overlaid = view.type === "form" && view.modal === true;
  const anchorRef = useRef<HTMLDivElement>(null);
  const [scope, setScope] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!overlaid) {
      return;
    }
    setScope(anchorRef.current?.closest<HTMLElement>(".app-theme") ?? document.body);
  }, [overlaid]);

  if (!overlaid) {
    // **書かなかった画面 / `false` の画面は、器を1つも通らない** —— 今日と1バイトも変わらない。
    return <>{children}</>;
  }
  return (
    <>
      {/* 自分の DOM 上の位置を知るための目印。**見た目を1ピクセルも持たない。** */}
      <div ref={anchorRef} hidden data-testid="overlay-scope-anchor" />
      {scope === null ? null : (
        <OverlayDialog
          title={viewDisplayName(view)}
          open={true}
          container={scope}
          onOpenChange={(next) => {
            if (!next) {
              window.history.back();
            }
          }}
        >
          {children}
        </OverlayDialog>
      )}
    </>
  );
}

/**
 * 逃げ道(任意 CSS)の配信状態。**「まだ」「出せた」「遮断された」の3つに割る** ——
 * 「出せなかった」を「まだ」と同じ扱いにすると、黙って効かない状態が作れてしまう(憲法6)。
 *
 * ## 4つ目(`target_unverified`)を足した(V4-M15-T12 / `P-G48` / `D-V4-15`)
 *
 * **3状態は「配れたか」しか見ておらず、「配れたものが当たったか」を1つも持たない。**
 * 画面の実装を部品体系へ置き換えると、発行済みの資産が名指ししていた要素やクラス名が
 * DOM から消えることがあり、そのとき**資産の本文もダイジェストも変わらないまま、
 * 規則だけが当たらなくなる**(`03:1330` の `P-G48`)。**黙って効かなくなるのは憲法6 違反である。**
 *
 * **`D-V4-15`(ユーザ決定)は「壊れることを受け入れ、壊れたことを知らせる仕組みを作る」である。**
 * **受け入れたのは壊れることであり、直すことではない。**
 *
 * ## **なぜ「何件が当たり先を失ったか」を数えないのか**(判断を先に書く)
 *
 * **数えるには、配信された CSS の本文からセレクタを取り出す必要がある。**
 * **これは `ADR-0055` 限定8 / 憲法1(この製品は CSS を1バイトも解釈しない)に当たると判断した。**
 * 理由は3つで、**1つ目は逐語では当たらないことを先に書く**(誇張しない):
 *
 * 1. **限定8 の逐語は「CSS プロパティの許可リストも拒否リストも作らない」であり、その理由は
 *    「リストを課すと**カーネルまたはサーバ層に** CSS パーサが要る」である。** **表示層で
 *    セレクタを読むことは、この逐語にはそのままでは当たらない。** 隠さない。
 * 2. **しかし本ファイルの `EscapeHatchStyle` は自ら「**CSS を1バイトも解釈していない**(限定8 /
 *    憲法1)。パーサも許可リストも拒否リストも持たない」と宣言している。** セレクタを取り出せば
 *    **この宣言が偽になる。** **`ADR-0088` 限定7 は「`ADR-0055` の限定を1つも動かさない」と
 *    定めており、表示層の宣言を偽にすることはこれを動かすことに当たる。**
 * 3. **数えても正しい数が出ない。** 逃げ道の資産は複数画面を作用域に取れるので、
 *    「今この画面の DOM に1つも当たらない」は「当たり先が消えた」ではなく
 *    「**別の画面の規則である**」でも起こる。**区別できない数を「当たり先を失った本数」として
 *    出すのは誇張である**(`03:2209` は数えていないなら「数えていない」と書けと定めている)。
 *
 * **したがって、当たり先は1件も数えない。** **知らせるのは「当たり先が変わりうる」ことだけである。**
 *
 * ## 3つ目と4つ目の分かれ目(**ここでも CSS を解釈しない**)
 *
 * **見るのは「空白を除いて1文字でもあるか」だけである。** 規則もセレクタもプロパティも
 * 1つも取り出さない。**空白しか無い資産は規則を1つも持たないので、失う当たり先も持たない。**
 * (**今日のサーバは空文字の発行を拒む** —— `src/server/auth-routes.ts:3928` は `css === ""`
 * を 400 にする。**空白1文字の資産は発行できる**ので、3つ目の状態は今日も到達しうる。)
 *
 * ## 今日の分母(**転記である。本 worktree では実測できない**)
 *
 * **発行済みの逃げ道 CSS 資産は 0件**(`data/` 0 / `data-demo/` 0 / マニフェスト15本中
 * `custom_css` 参照 0本。`docs/plan/v4/04-pre-execution-checks.md` §3-16 #6 の検算)。
 * **`data/` は `.gitignore:3` により worktree に複製されないので、この数は転記であって
 * ここで測り直したものではない。** **v3 が数えた38件はディスク上に残っていない。**
 */
type EscapeHatchState =
  | { status: "idle" }
  | { status: "ready"; css: string }
  | { status: "target_unverified"; css: string }
  | { status: "blocked"; message: string; hint?: string | undefined };

/**
 * 逃げ道の本体を取りに行き、`.app-theme` スコープの内側に閉じて当てる
 * (V3-M5-T02 / D-G5。ADR-0055 限定6・7・12・13)。
 *
 * ## 何をしていないか(先に書く)
 *
 * - **`ViewRendererProps` に props を1つも足していない**(限定12)。この要素が受け取るのは
 *   `ViewHost` が既に持っている `appId` と `view`、および配信状態の入れ物(`state` / `onState`。
 *   **V4-M15-T12 で親へ引き上げた**)だけで、**レンダラー3種には1バイトも渡らない。**
 * - **`web/src/styles.css` に規則を1つも足していない**(限定12)。遮断の知らせは素の
 *   段落であり、器の見た目を持たない。**「足さずに配信できないなら足さない側を採る」**
 *   という指示に対して、**足さずに配信できた。**
 * - **CSS を1バイトも解釈していない**(限定8 / 憲法1)。パーサも許可リストも拒否リストも
 *   持たない —— 受け取ったバイト列に**前後1行を足すだけ**である。
 *
 * ## 作用域は表示層が決めない(限定7)
 *
 * 「この画面に当ててよいか」を判定するのは**配信層(サーバ)**である。ここは 200 以外を
 * 一律「遮断された」として扱うだけで、**参照が書かれているかどうかの知識しか持たない。**
 * UI 側で判定を写すと、判定が2箇所に住んで食い違う。
 *
 * ## `.app-theme` の入れ子に包む(限定13)
 *
 * **DOM のどこに `<style>` を置いても CSS は閉じない。** 置き場所ではなく**書き方**で
 * 閉じるしかないので、受け取ったバイト列を `.app-theme { … }` の入れ子(CSS nesting)に
 * そのまま包む。**包むのは文字列連結であって解釈ではない。**
 *
 * **これは「閉じ込めた」ことの保証ではない**(ADR-0055 §4 限界2)—— 決意した書き手は
 * `:root:has(&)` のような形で外へ出られるし、**限定8 がある以上その検査は書けない。**
 * 保証できるのは「**既定では外枠(シェル)に漏れない**」ことまでである。
 */
function EscapeHatchStyle({
  appId,
  view,
  state,
  onState,
}: {
  appId: string;
  view: View;
  state: EscapeHatchState;
  onState: (next: EscapeHatchState) => void;
}) {
  const reference = view.custom_css;

  useEffect(() => {
    if (reference === undefined) {
      // **参照が無い画面では HTTP を1本も叩かない。**逃げ道を使っていないだけであり、
      // 遮断ではない(サーバ側も同じ理由でここを loud にしていない)。
      onState({ status: "idle" });
      return;
    }
    let cancelled = false;
    onState({ status: "idle" });
    fetch(`/api/apps/${encodeURIComponent(appId)}/views/${encodeURIComponent(view.id)}/custom.css`)
      .then(async (response) => {
        if (response.ok) {
          return { ok: true as const, css: await response.text() };
        }
        // 遮断の理由はサーバの文面をそのまま運ぶ(フロントで作り直さない = 文面を1本に保つ)。
        const body = (await response.json().catch(() => ({}))) as {
          errors?: { message?: string; hint?: string }[];
        };
        const first = body.errors?.[0];
        return {
          ok: false as const,
          message: first?.message ?? "逃げ道(任意 CSS)は当たりませんでした。",
          hint: first?.hint,
        };
      })
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          onState({ status: "blocked", message: result.message, hint: result.hint });
          return;
        }
        // **3つ目と4つ目の分かれ目。**見るのは「空白を除いて1文字でもあるか」だけで、
        // **規則もセレクタもプロパティも1つも取り出していない**(限定8 / 憲法1)。
        onState(
          result.css.trim() === ""
            ? { status: "ready", css: result.css }
            : { status: "target_unverified", css: result.css },
        );
      })
      .catch(() => {
        if (!cancelled) {
          // 取りに行けなかった場合も**黙って消えない**(憲法6)。
          onState({
            status: "blocked",
            message: "逃げ道(任意 CSS)を取得できませんでした。",
            hint: "サーバに接続できているか確認してください。画面はこの逃げ道が無い状態で表示されています。",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [appId, view.id, reference, onState]);

  if (reference === undefined || state.status === "idle") {
    return null;
  }
  if (state.status === "blocked") {
    return (
      <p data-testid="custom-css-blocked" role="status">
        {state.message}
        {state.hint !== undefined && ` ${state.hint}`}
      </p>
    );
  }
  // **前後に1行足すだけ。**中身は1バイトも書き換えない。
  return <style data-testid="custom-css">{`.app-theme {\n${state.css}\n}`}</style>;
}

/**
 * 4つ目の状態の知らせ(V4-M15-T12 / `P-G48` / `D-V4-15`。`ADR-0087` 限定9)。
 *
 * ## 何を知らせ、何を知らせないか
 *
 * - **知らせるのは「当たり先が変わりうる」ことだけである。** **何件が当たり先を失ったかは
 *   1件も数えていない** —— 数えるには CSS の解釈が要るからである(理由は `EscapeHatchState`)。
 * - **「壊れなかった」とは書かない**(`03:2209` の【禁止】)。**`D-V4-15` は壊れることを
 *   受け入れた決定である。**
 * - **`ADR-0087` 限定9(持ち主が事前に知れるようにする)に接地する** —— **何が戻せて何が
 *   戻せないか**を同じ文面で言う。**undo の射程は1ミリも広げていない**(`ADR-0004`)。
 *
 * ## 持ち主にだけ出す
 *
 * 逃げ道の資産を発行できるのは owner だけである(`src/server/auth-routes.ts:1374`)。
 * **配信そのものは役割で変わらない**(viewer の画面にも CSS は当たる)。変えるのは
 * 知らせの宛先だけで、**owner 以外には1要素も出さない。**
 *
 * ## 器を1つも足していない
 *
 * **`web/src/styles.css` にも `web/src/tailwind.css` にも1バイトも書いていない** ——
 * 出しているのは `web/src/ui/` の `Alert` だけである。**座標系のクラスを1つも書いていない。**
 */
function EscapeHatchTargetNotice() {
  const role = useRole();
  if (role !== "owner") {
    return null;
  }
  return (
    // 画面を開くたびに読み上げを割り込ませる知らせではないので `status` に倒す
    // (遮断の知らせ `custom-css-blocked` と同じ扱い)。
    <Alert data-testid="custom-css-target-unverified" role="status">
      <AlertTitle>この画面の逃げ道 CSS は、当たり先が変わっているかもしれません。</AlertTitle>
      <AlertDescription>
        画面の実装を部品体系へ置き換えたため、発行済みの逃げ道 CSS
        が名指ししていた要素やクラス名が、この版では出ていないことがあります。この仕組みは CSS
        を1バイトも解釈しないので、当たり先を失った規則が何件あるかは数えていません。資産の本文とダイジェストは変わっておらず、配信も遮断されていません。テーマとプリセット(マニフェスト)の変更は
        undo で戻せますが、逃げ道 CSS の資産と画面の実装そのものは undo の対象外です。
      </AlertDescription>
    </Alert>
  );
}

function ViewBody({ appId, manifest, view, recordId, prefill }: ViewRendererProps) {
  switch (view.type) {
    case "list_view":
      // 一覧は URL の対象レコードを使わない(1件を指す画面ではないため)。
      return <ListViewRenderer appId={appId} manifest={manifest} view={view} />;
    case "form":
      // form の新規作成では prefill(EC-G14 / ADR-0045)を初期値に反映する(recordId と同型の画面状態)。
      return (
        <FormRenderer
          appId={appId}
          manifest={manifest}
          view={view}
          recordId={recordId}
          prefill={prefill}
        />
      );
    case "detail_view":
      return (
        <DetailViewRenderer appId={appId} manifest={manifest} view={view} recordId={recordId} />
      );
    case "report_view":
      /*
       * **集計表**(`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`)。
       *
       * **`V8-M8` はこの画面を1ピクセルも描かない。** **描くのは `V8-M11` である。**
       * **それでも分岐を1本置いてあるのは、置かないと画面が黙って白紙になるからである**
       * (憲法6。**「できないことは正直に言う」**)。
       * **知らせは出すが、集計の値を1つも取りに行っていない** —— **この分岐は
       * `GET /api/apps/<app_id>/views/<view_id>/report` を1度も叩かない。**
       * **`V8-M11` はここを本物の描画に置き換えること**(この `Alert` ごと差し替える)。
       *
       * **【2026-08-15。`V8-M11-T06`。台帳 `Q-G20`。上の逐語を1バイトも書き換えていない。
       *   ただし上の3行は今日は偽である】** **指示のとおり、`Alert` ごと本物の描画に
       * 置き換えた。** **`V8-M8` が「描くのは `V8-M11` である」と書いたその `V8-M11` が
       * ここである。** **今日この分岐は
       * `GET /api/apps/<app_id>/views/<view_id>/report` を実際に叩く**(叩くのは
       * `ReportViewRenderer` であり、`web/src/api.ts` の `fetchReport` 1本だけを通る)。
       * **分岐そのものは今日も1本のままで、`switch` の網羅性は1ミリも変わっていない。**
       *
       * **【2026-08-16 追記(`V8-M13-T04`。台帳 `Q-G30`)。上の逐語を1バイトも書き換えていない】**
       * **集計表はブラウザに描かれる** —— **上の訂正と同じ内容を、他の散文と同じ字面で
       * 書いておく**(`scripts/report-prose-correction-drift.test.ts` が「偽になった将来形を
       * 載せたファイルに今日の事実が同居しているか」を機械的に走査しており、**字面が
       * 揃っていないとその走査から漏れる**)。**`V8-M12` が画面の上にグラフを足したので、
       * 今日この分岐が描くのはグラフ(棒か折れ線)と群の表の2つである。**
       */
      return <ReportViewRenderer appId={appId} manifest={manifest} view={view} />;
  }
}
