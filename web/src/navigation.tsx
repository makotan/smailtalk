/**
 * History API ベースの最小ルータ(V0-P3-T03)。
 *
 * ルーティングライブラリを足さない。必要なのは「URL を読む」「URL を進める」
 * の2つだけで、それは History API とブラウザの `popstate` で足りるため。
 * サーバ側(ADR-0003 §4 #9)と Vite dev server の両方が SPA フォールバックを
 * 持つので、深い URL を直接開いてもリロードしても同じ画面に戻る。
 *
 * **【V3-M3-T02 の追記】レコード間の遷移の「規約」と、その規約を画面に説明する部品を
 * ここに集めた。** 遷移点が4つに増えた(一覧の行 / 一覧の参照セル / `related` の子行 /
 * 詳細の項目の参照)ので、**規約(`resolveDetailViewTarget` / `countDetailViewTargets`)も、
 * 遷移の器(`RouteLink` / `ReferenceLinkScope`)も、規約の説明(`DetailTargetNote`)も
 * 1箇所に置く** —— 同じものが複数箇所にあると、規約を変えたときに一部だけが変わる。
 *
 * **【`V10-M18-T02`(`FU-G2`)の追記。上の行を1バイトも消していない】**
 * **「規約の説明(`DetailTargetNote`)も1箇所に置く」は今日から嘘である** ——
 * **`DetailTargetNote` はこのファイルから撤去した。** **ユーザ決定 `D-V10-21` が選んだ
 * 見出しは「出すのをやめる」であり、規約の説明を画面に出す部品は、置き場所が変わったの
 * ではなく無くなった。** **代わりの説明をどこにも作っていない**(別の場所に出す・
 * `title` 属性に入れる 等を1つもしていない)。
 * **規約そのもの(`resolveDetailViewTarget` / `countDetailViewTargets`)と遷移の器
 * (`RouteLink` / `ReferenceLinkScope`)は今日も1箇所であり、1バイトも動かしていない。**
 */
import type { MouseEvent, ReactNode } from "react";
import { useMemo, useSyncExternalStore } from "react";
import type { RecordValue } from "../../src/kernel/records.ts";
import type { DetailView, ListView, Manifest, ResourceId } from "../../src/kernel/types.ts";
import { parseRoute, type Route, routePath } from "./route.ts";
import { flowStepOf } from "./views/flow.ts";

/** `history.pushState` は自前ではイベントを発火しないので、購読用に自前で流す。 */
const NAVIGATION_EVENT = "gp:navigate";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(NAVIGATION_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(NAVIGATION_EVENT, onChange);
  };
}

/**
 * 購読の対象になる「現在の URL」。
 *
 * **【V5-M24-T01 / L-G17】`location.search` を含める。** プリフィルはクエリ文字列に載る
 * 画面状態になったので(`src/shared/route.ts`)、パスだけを見ていると
 * 「同じパスでプリフィルだけが変わる遷移」を購読側が取り逃がす。
 */
function currentUrl(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/** 現在の URL に対応する画面状態。 */
export function useRoute(): Route {
  const url = useSyncExternalStore(subscribe, currentUrl, currentUrl);
  /*
   * **【V5-M24-T01 / L-G17 で消した経路がある。丸めないで書く】**
   * 着手前(`64fd1a4`)はここに `readPrefillFromHistory()` があり、`history.state` に積まれた
   * `{prefill}` を検証して `Route` に載せていた。**その関数ごと消した** —— プリフィルが URL に
   * 載った今、同じ情報を2箇所に持つと、片方だけが変わったときに食い違うためである
   * (`resolveDetailViewTarget` の doc が同じ理由で「同じ `.find()` を2箇所に置かない」と書いている)。
   * **代償**: `history.state` を直接触って画面状態を作っていた外部コードがもしあれば効かなくなる。
   * **リポジトリ内にそういう呼び出しは無い**(2026-08-05 実測。`history.state` の参照は
   * この関数の中だけだった)が、**ブックマークレット等の外側は測っていない。**
   */
  return useMemo(() => parseRoute(url), [url]);
}

/**
 * 画面遷移(URL を進めて再描画を促す)。
 *
 * 比較にクエリ文字列を含めるのは、`routePath` が生成する URL がクエリを持ちうる
 * (プリフィル)ため。パスが同じでもクエリが違えば、それは別の画面状態である。
 */
export function navigate(route: Route): void {
  const path = routePath(route);
  // **プリフィル(EC-G14 / ADR-0045)は `path` の中のクエリ文字列として運ばれる**(V5-M24-T01)。
  // したがって state に積むものは無く、常に `{}` を積む。
  if (path !== currentUrl()) {
    window.history.pushState({}, "", path);
  }
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

/**
 * 「一覧の行を開いたとき」「フォームを保存したとき」の遷移先になる `detail_view` を決める
 * **唯一の実装**(V1-M0-T08 / v0 所見 F-11)。
 *
 * 規約(「同テーブル先頭 detail_view 規約」): 対象テーブルと同じ `table` を持つ
 * `detail_view` のうち、**マニフェストの `app.views` 配列の定義順で最初に現れるもの**を
 * 遷移先とする。0個なら遷移先なし(行はクリックできない)、1個ならそれ、2個以上でも
 * 定義順の先頭で決め切る。**遷移先を指す語彙(`link` 等)は増やさない** —— 規約で
 * 決まるものをマニフェストに書かせると、書き手が指定を間違える余地が増えるだけだからである。
 *
 * この関数を呼び出し側(`ListViewRenderer` / `FormRenderer` / `DetailViewRenderer` /
 * `fields/display.tsx`)に再実装しないこと。
 * 同じ `.find()` が2箇所にあると、規約を変えたときに片方だけが変わる。
 *
 * **ADR-0007 の再審査条件**: 同じテーブルに `detail_view` が2つ以上あり、規約では
 * 遷移先が決まらない状況が発生したら、そのとき初めて `link` が語彙として必要になる。
 * ADR-0007 §7a / §8 台帳に記録済み。この規約(定義順の先頭)で決まらない要求が実地で
 * 観測されたら、門A へ再提出すること。
 *
 * ## **【`V10-M18-T01` / `FU-G1a` / `ADR-0362` が第3引数を足した。旧文を1バイトも消していない】**
 *
 * **`options.skipFlowStepViews` を渡すと、`flow` を宣言している `detail_view`
 * (= 一続きの流れの段になっている画面)を候補から外してから選ぶ。**
 * **当てているのは行を押したときの3遷移点だけである** —— **一覧の行クリック
 * (`ListViewRenderer`)/ 関連行・子の一覧(`DetailViewRenderer`)/ 参照セルのリンク
 * (`fields/display.tsx`)。**
 *
 * **引数を渡さない既定の振る舞いは今日と1ビットも同じである**(`ADR-0362` 限定2)——
 * **保存が成立したあとの行き先(`views/FormRenderer.tsx:837`)は今日どおり2引数で呼び、
 * 段になった `detail_view` もそのまま選ぶ。** **`ADR-0102` 限定7 / `ADR-0357` 限定2 を
 * 1バイトも解いていない。**
 *
 * **外すのは `flow` を宣言している `detail_view` すべてである** —— **呼び出し元と同じ
 * `flow.id` の段だけを外すのではない。** **この関数は呼び出し元のビューを1つも受け取らない
 * ので、「同じ流れかどうか」を判定する材料がそもそも無い。**
 *
 * **外した結果0個になったら `undefined` を返す** —— **今日どおり「行き先なし」であり、
 * 行は押せなくなる。** **別の画面へ倒す2本目の規則を1つも作っていない**
 * (`ADR-0362` §Decision 3 / `ADR-0173` 限定5・限定6)。
 *
 * **段の述語は `views/flow.ts` の `flowStepOf` 1本である** —— **判定をここに書き写して
 * いない**(同じ判定が2箇所にあると、規約を変えたときに片方だけが変わる)。
 *
 * **下の `countDetailViewTargets` は1バイトも触っていない**(`ADR-0362` 限定1)——
 * **したがって注記(`DetailTargetNote`)が数える個数には、段になった `detail_view` も
 * 入り続ける。** **段を外したうえで注記が出る形では、注記が名指しする画面と「定義順の
 * 先頭を使う」という文面が食い違う。** **本タスクはこれを直していない。**
 *
 * **【`V10-M18-T02`(`FU-G2`)の追記。上の行を1バイトも消していない】**
 * **`countDetailViewTargets` は今日も1バイトも触っていない**(`ADR-0362` 限定1 は健在で
 * ある)。**ただし上が述べた食い違いは、今日は画面で起きない** —— **`FU-G2` が注記
 * (`DetailTargetNote`)そのものを撤去したので、その数を文にして見せる先が無いからである。**
 * **数え方を直したのではない。文を出すのをやめただけである。**
 */
export function resolveDetailViewTarget(
  manifest: Manifest,
  tableId: ResourceId,
  options?: { skipFlowStepViews?: boolean },
): DetailView | undefined {
  /*
   * **候補の集合を先に狭めるだけである。****下の探索の式は1バイトも書き換えていない**
   * (`ADR-0362` 限定1 / `ADR-0173` 限定6。**遷移先を選ぶ探索は今日も1本のままである。**
   * **2本目を書いていない。**)
   */
  const candidates =
    options?.skipFlowStepViews === true
      ? manifest.app.views.filter((candidate) => flowStepOf(candidate) === undefined)
      : manifest.app.views;
  return candidates.find(
    (candidate): candidate is DetailView =>
      candidate.type === "detail_view" && candidate.table === tableId,
  );
}

/**
 * 同じテーブルを対象とする `detail_view` の個数(遷移先の候補数)。
 *
 * `resolveDetailViewTarget` が**どれを選んだか**を決めるのに対し、こちらは
 * **迷いようがあったのか**だけを数える。**2以上のときに限り、規約でどれを選んだかを
 * 画面に書く**(黙って1つを選ぶと、書き手には「もう片方が無視された」ことが見えない。
 * 憲法6)。1以下なら注記を出さない —— 迷いようがないからである。
 *
 * **述語を呼び出し側に書かないこと。** 上の `resolveDetailViewTarget` と同じ理由で、
 * 同じ条件が複数箇所にあると規約を変えたときに片方だけが変わる。**遷移点は4つに
 * 増えた**(一覧の行 / 一覧の参照セル / `related` の子行 / 詳細の項目の参照)ので、
 * なおさらである。
 *
 * ## **【`V10-M18-T02`(`FU-G2`)の追記。上の行を1バイトも消していない】この関数を残した理由**
 *
 * **上の「2以上のときに限り、規約でどれを選んだかを画面に書く」は今日の実物ではない。**
 * **`FU-G2` が注記(`DetailTargetNote`)を撤去したので、この数を画面に書く場所は無い。**
 * **それでもこの関数は残す。理由は2つある。**
 *
 * 1. **`ADR-0362` 限定1 の式がこの関数の1行を数えている。** その式は **`web/src` の中で
 *    「`detail_view` かどうか」と「候補のテーブル」を1つの述語で同時に見ている行**を
 *    数えるもので、**2行**であることが限定である —— **`resolveDetailViewTarget` の1行と、
 *    この関数の1行**。 **この関数を消すと1行になり、`ADR-0362` 限定1 を壊す。**
 *    **`FU-G2` は門外(`Δ7`)であって、`ADR-0362` の限定を動かす射程を持たない。**
 *    **【式そのものをここへ逐語で写さない】** —— **写すとこの doc 自身が式に当たり、
 *    数が 2 から 3 に増える**(禁止語の件数は自己参照で壊れる)。**実際に一度そうなった。**
 * 2. **今日この関数を呼ぶ側は、製品コードに1つも無い。** **唯一の呼び手だった
 *    `DetailTargetNote` を撤去したためである。** **呼び手が無いことは、この関数を消す
 *    理由にはならない**(1 のとおり、消すこと自体が別の限定を壊す)。**呼び手が戻る
 *    予定も無い** —— **`D-V10-21` は「出すのをやめる」を選んでおり、「作り手にだけ
 *    見せる」は選ばれていない。**
 *
 * **【この2つは両方とも成り立っている。片方だけを理由に読まないこと。】**
 */
export function countDetailViewTargets(manifest: Manifest, tableId: ResourceId): number {
  return manifest.app.views.filter(
    (candidate) => candidate.type === "detail_view" && candidate.table === tableId,
  ).length;
}

/**
 * **一覧の行の操作起点の行き先を1本に決める**(`L-G5` / `L-G6`。`V5-M22-T03` /
 * `ADR-0173` 限定4 / 限定5 / 限定6)。
 *
 * ## **規則は1本だけである**(限定5)
 *
 * > **宣言(`view`)があれば宣言。無ければ今日どおりの形(`form` + `prefill`)。**
 *
 * **2本目の規則(条件つきで規約に戻る等)を1つも作っていない。**
 *
 * ## **上の `resolveDetailViewTarget` を1バイトも書き換えていない**(限定4)
 *
 * **【`V10-M18-T01` / `FU-G1a` / `ADR-0362` で偽になった。旧文を1バイトも消していない】**
 * **すぐ上の見出しは今日は偽である** —— **`ADR-0362` が `resolveDetailViewTarget` に
 * 第3引数を足し、`ADR-0173` 限定4 の「本体を書き換えない」も「宣言が無い画面の挙動は
 * 今日と1ピクセルも変わらない」も正面から引き直した。** **`ADR-0173` の本文は1バイトも
 * 書き換えていない**(引き直しは `ADR-0362` §Decision 5 の側に書いてある)。
 * **今日も真である部分**: **この関数(`resolveRowActionDestination`)は
 * `resolveDetailViewTarget` を1度も呼んでいない。**
 *
 * **`:83-84` の注記(逐語「**遷移先を指す語彙(`link` 等)は増やさない** —— 規約で
 * 決まるものをマニフェストに書かせると、書き手が指定を間違える余地が増えるだけだから
 * である。」)の**前段**は、`ADR-0173`(門A / 判定 = 限定採用)によって**今日から偽
 * である。** **後段の理由句は今日も真であり、代償として残る**(`ADR-0173` §限界4 は
 * 「書き手が指定を間違える余地は、本 ADR が実際に増やした」と自認している)。
 * **旧文を1バイトも消していない。**
 *
 * **`ADR-0007` §7a の F-11 の再審査条件(`:90-93` が指しているもの)は今日も不発火
 * である** —— **規約は今日も一意に決まる**(定義順の先頭)。**3形目が要る理由は
 * 「規約では決まらない」ことではなく「**規約が決める行き先とは違う画面へ行きたい**」
 * ことであり、別の理由である。** **`ADR-0007` §8 台帳の F-11 の行に1バイトも触って
 * いない。**
 *
 * ## **ここは規約の `.find()` を再実装していない**(限定6)
 *
 * **`resolveDetailViewTarget` は「テーブル + 型」で探す。** **この関数が探すのは
 * 「**宣言されたビューID**」であり、規約とは別の探し方である** —— **同じ `.find()`
 * ではない。** **行クリックの遷移先(`ListViewRenderer` が `resolveDetailViewTarget`
 * で決める)を1バイトも変えていない**(限定7)。
 *
 * **【`V10-M18-T01` / `FU-G1a` / `ADR-0362` で偽になった。旧文を1バイトも消していない】**
 * **直前の1文(「行クリックの遷移先を1バイトも変えていない」)は今日は偽である** ——
 * **`ADR-0362` が `ADR-0173` 限定7 を全部引き直し、段になった `detail_view` を行クリックの
 * 候補から外した。** **宣言を1バイトも持たない既存アプリの飛び先も変わる。**
 * **今日も真である部分**: **行そのものの行き先を宣言する口は1つも無く、決めるのは今日も
 * 規約である**(`NV-G6` は今日も却下。`ADR-0362` 限定4)。
 *
 * ## **fail-closed である**
 *
 * **【`V8-M20` / `J-G27`】旧文の `audience` は撤去された。今日落とすのは面の画面の規則である。**
 * **宣言した行き先が渡されたマニフェストに居ない**(`audience` でサーバが落とした /
 * ID が実在しない)**とき、既定の行き先へ倒さず `undefined` を返す。** **呼び出し側は
 * ボタンごと出さない。** **`after_save`(`ADR-0102`)は「既定の行き先へ倒す」を選んだ
 * が、**こちらには倒す先が無い** —— **行き先そのものが宣言の中身だからである。**
 * **`ADR-0173` §限界3 は「3形目でも同じに倒れるかは実装で確かめること」と書いていた。**
 * **確かめた結果が、この分岐である**(`web/test/list-view-link-destination.test.tsx`
 * の (e) 群が固定する)。
 *
 * **行き先が `form` の宣言もここで落とす。** **`referential-integrity.ts` が apply 時に
 * 拒否するので通常は到達しないが、表示層でも fail-closed にする**(古いマニフェストが
 * 手で置かれた場合に画面が壊れないため)。
 */
export function resolveRowActionDestination(
  manifest: Manifest,
  appId: string,
  action: NonNullable<ListView["actions"]>[number],
  recordId: string,
): Route | undefined {
  if ("view" in action) {
    const destination = manifest.app.views.find((candidate) => candidate.id === action.view);
    if (destination === undefined) {
      return undefined;
    }
    if (destination.type === "detail_view") {
      // **行き先が詳細なら、押した行の `_id` を運ぶ**(`ADR-0173` §Decision 3)。
      return { kind: "view", appId, viewId: destination.id, recordId };
    }
    if (destination.type === "list_view") {
      // **行き先が一覧なら何も運ばない**(同上)。**`prefill` を1文字も付けない。**
      return { kind: "view", appId, viewId: destination.id };
    }
    return undefined;
  }
  /*
   * **【`V5-M25-T01` / `L-G8` / `ADR-0174`】4形目(自動処理の起動 = `run`)は遷移しない。**
   * **`undefined` を返す** —— **行き先が無いからである**(押しても画面は移らない)。
   * **呼び出し側は「遷移のボタン」としては描かず、起動のボタンとして別に描く。**
   * **`undefined` の意味が2つになった。隠さない** —— (a) 宣言した行き先に届かない
   * (fail-closed。上の分岐)/ (b) そもそも遷移しない形である(この分岐)。
   * **呼び出し側は形で見分ける**(`"run" in action`)。
   */
  if ("run" in action) {
    return undefined;
  }
  /*
   * **【`V5-M25-T07` / `L-G3`】値の書換(`set`)も遷移しない。**
   * **`ADR-0171` 限定10 の順序拘束が解けたので、一覧にも `set` 形を書けるようになった** ——
   * **押しても画面は1ミリも移らない**(その行を書き換えるだけである)。
   * **呼び出し側は形で見分ける**(`"set" in action`)。
   */
  if ("set" in action) {
    return undefined;
  }
  /*
   * **宣言が無い場合は今日どおりである**(`ADR-0045` / `ADR-0171` §Decision 3)——
   * **プリフィルは参照フィールド1つ × 押した行の `_id`。** **`V5-M24-T01` が
   * `prefill` を URL のクエリ文字列に載せた経路(`src/shared/route.ts`)を
   * 1バイトも触っていない。**
   */
  return {
    kind: "view",
    appId,
    viewId: action.form,
    prefill: { field: action.prefill.field, value: recordId },
  };
}

/**
 * 画面内リンク。`href` を本物の URL にしてあるので、新規タブで開く・
 * ブックマークする・リロードするのいずれも普通に効く。
 */
export function RouteLink({ to, children }: { to: Route; children: ReactNode }) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    // 修飾キー付き(新規タブ等)はブラウザ本来の挙動に任せる。
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey) {
      return;
    }
    event.preventDefault();
    navigate(to);
  };
  return (
    <a href={routePath(to)} onClick={handleClick}>
      {children}
    </a>
  );
}

/**
 * 参照セルを「参照先レコードへのリンク」で包む器(V3-M3-T02)。
 *
 * **`target` が `undefined` なら何も包まない** —— 値の表示は今日と1バイトも同じである。
 * **リンクにしてよいかの判定は `referenceLinkTarget`(`fields/display.tsx`)1本**にあり、
 * ここでは判定しない(遷移先の決め方は上の規約1本である)。
 *
 * **器を表示関数(`FieldValue` / `FieldCell`)の中に置かない理由**: 引数を足すと
 * **ADR-0050 限定10(表示関数に足せる引数は軸7 の1つだけ)**を破る。値の描画は表示関数、
 * 導線はこのファイル、と当て先を分けてある。**呼び出し側(一覧・詳細・子一覧)は
 * この器を使うだけで、`<a>` を自前で書かない。**
 */
export function ReferenceLinkScope({
  target,
  appId,
  recordId,
  children,
}: {
  target: DetailView | undefined;
  appId: string;
  /** 参照値(= 参照先レコードの `_id`)。`target` があるときは必ず文字列に落ちる。 */
  recordId: RecordValue | undefined;
  children: ReactNode;
}) {
  if (target === undefined) {
    return children;
  }
  return (
    <RouteLink to={{ kind: "view", appId, viewId: target.id, recordId: String(recordId) }}>
      {children}
    </RouteLink>
  );
}

/**
 * 遷移先が一意に決まらないときの注記(V3-M3-T02。ユーザ決定 D-M3-6)。
 *
 * **4つの遷移点すべてがこの1つを使う** —— 判定(遷移先が実在し、かつ同じテーブルの
 * `detail_view` が2つ以上)も文面も1箇所にしかない。**V1-M0-T08 が一覧に置いた注記の
 * 文言をそのまま持ち上げたもので、文は1文字も変えていない**(`lead` から後ろが共通部分)。
 * 個数の数え方は上の `countDetailViewTargets` 1本で、ここには述語を書かない。
 *
 * **1つ以下なら何も出さない。** 迷いようがないところに注記を置くと、注記そのものが
 * 意味を失う(既存マニフェストの表示を変えないことにもなる)。**当たり先(実際に押せる
 * 遷移点)が無いときも呼び出し側が呼ばない。**
 *
 * **代償を正直に書く**: 遷移点が増えたぶん、同じ画面に注記が複数並びうる(一覧なら
 * 行の注記と列ごとの参照の注記、詳細なら項目の参照・子一覧の行・子一覧の列の参照)。
 * **うるささは誰も測っていない。**
 *
 * ## **【`V10-M18-T02`(`FU-G2`)。上の doc を1バイトも消していない】この部品は撤去した**
 *
 * **ユーザ決定 `D-V10-21` が選んだ見出しは「出すのをやめる」である** —— **「お客に分かる
 * 言葉へ書き換える」でも「作り手にだけ見せる」でもない。** したがって、
 *
 * - **本体(`export function DetailTargetNote`)を撤去した。** **呼び出し5件も同時に
 *   撤去した**(`ListViewRenderer` 2件 / `DetailViewRenderer` 3件)。
 * - **代わりの手だてを1つも作っていない** —— **別の場所に同じ説明を出していないし、
 *   `title` 属性にも入れていないし、開発時だけ出す口も作っていない。**
 * - **役割・利用者・見せる相手を見る式を1本も足していない**(`FU-G2` 限定1)。
 *   **出し分けたのではなく、消したのである。**
 *
 * **残したもの**: **`countDetailViewTargets`**(理由は上のその doc に2つ書いた)と、
 * **CSS の規則 `.list-detail-target-note, .detail-target-note`**(撤去すると
 * `--font-size-note` スロットが1箇所からも参照されなくなり、スロット総数を動かす話に
 * なる —— それは `ADR-0046` の限定であって `FU-G2` の門外判定(`Δ7`)の射程を越える)。
 * **当たり先を1つも持たない CSS 規則1本が残る。** **これは消し忘れではない。**
 *
 * **【この doc は撤去された部品の説明である。上の本文を今日の実物と読まないこと。】**
 */
