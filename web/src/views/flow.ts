/**
 * **一続きの流れの段を読み、次の段への行き先を1本に決める**(`V10-M4-T02`。`NV-G9` /
 * `NV-G11` / `NV-G7a` の受け先。`ADR-0359` §4b 限定3・限定4・限定5 / `ADR-0360` 限定2 /
 * `ADR-0357` 限定1・限定2)。
 *
 * ## 規則は1本だけである(`ADR-0359` §4b 限定5 の逐語)
 *
 * > **段の宣言がある画面では段の並びが効き、無ければ今日どおりの規約に倒れる**
 * > (`ADR-0173` `L-G6` の「宣言があれば宣言、無ければ規約」と**同じ形**にする。
 * > **2本目の規則を作らない**)。
 *
 * **この1本を、器(`ViewHost`)と `form` の保存後(`FormRenderer` の `afterSubmitRoute`)の
 * 2箇所から呼ぶ。****判定はこのファイルの1箇所にしか住んでいない。**
 * **`after_save` の定義も既定の段2〜段4 も1バイトも書き換えていない**(`ADR-0102` 限定7)。
 *
 * ## **並びは宣言の集合から導く**(限定3)
 *
 * **同じ `flow.id` を持つ画面を `step` で並べたものが流れである。** **「次」は
 * `step + 1` を持つ画面1つである。****順番を書く場所をマニフェストに1つも作っていない。**
 * **位置の重複と欠番は `referential-integrity.ts` が apply 時に倒す**(`V10-M4-T01`)——
 * **ここは倒れたあとの姿しか見ない。** **それでも `find` が1つも当たらなければ何も返さない**
 * ので、手で置かれた古いマニフェストでも画面は壊れない。
 *
 * ## **段を URL に1文字も載せない**(`NV-G13` 限定3)
 *
 * **返すのは今日と同じ `{ kind: "view", … }` である。** **`src/shared/route.ts` と
 * `web/src/navigation.tsx` は1バイトも触っていない**(`src/shared/route.test.ts` の23本が
 * 赤くなったら、それは段を URL に載せたということである)。
 *
 * ## **次の段へ行を運ぶ規則は `ADR-0357` の**拡張**である**(点検 `B-3`)
 *
 * **運ぶ**線**(運ぶのは `_id` 1件だけ / 同じ表の `detail_view` に限る)は `ADR-0357`
 * 限定1・限定2 と同じである。** **しかし発火点が「保存が成立したとき」以外にも増える**
 * (詳細画面の「次へ」を押したときにも運ぶ)——
 * **したがってこれは「同じ規則をそのまま当てた」のではなく、規則の**拡張**である。**
 * **AI が覚える規則は1本増える**(`ADR-0007` §1a の意味。説明は `V10-M4-T04` が書く)。
 *
 * **非対称が1つ生まれる。隠さない** —— **今日 `detail_view` の `after_save` は行を
 * 1バイトも運ばない**(`DetailViewRenderer.tsx` の `handleSetAction` は
 * `navigate({ kind: "view", appId, viewId: declared.id })` だけである)。
 * **同じ詳細画面で「段は運ぶ / `after_save` は運ばない」が同居する。**
 *
 * ## 1ミリも解いていないこと
 *
 * - **段のあいだで未確定の入力を持ち回さない**(`ADR-0359` §6 の 4。`NV-G10a` / `NV-G10b`
 *   はどちらも却下)—— **運ぶのは保存済みの行の `_id` 1件だけである。**
 * - **何段目か・残り何段かを1文字も描かない**(限定2 が段の名前・進捗率を閉じている)。
 *   **【2026-08-20。`V10-M5-T02` が「いま何段目 / 全部で何段」を描いた。すぐ上の1行は
 *   今日は偽である。旧文を1バイトも書き換えていない】** **今日は位置と総数の2つの数を描く**
 *   ({@link flowPositionOf} と `ViewHost.tsx` の `flow-position`)。**分けて書く** ——
 *   **段の名前(流れID)・アイコン・色・進捗率・段の種類(`kind`)を1文字も描かせないことは
 *   今日も真である**(限定2 のその半分は無傷である)。
 * - **`kind: "confirm"` の段が確定したあとの遷移を1バイトも書いていない**
 *   (`V10-M4-T03` の担当)。
 * - **流れは1つのアプリの中に閉じる**(限定4)—— **`appId` は呼び出し側のものをそのまま
 *   使い、別アプリを指す口が1つも無い。**
 */
import type { Manifest, View } from "../../../src/kernel/types.ts";
import type { Route } from "../route.ts";

/** `flow` の値(`$defs/view/properties/flow`)。**`src/kernel/types.ts` の非 export の型と同じ形。** */
type FlowStep = { id: string; step: number; kind: "input" | "confirm" };

/**
 * その画面が宣言している段(**宣言が無ければ `undefined`**)。
 *
 * **`report_view` には `flow` を書けない**(`schemas/manifest.schema.json` の `allOf` の
 * `report_view` 分岐が `false` で閉じている。`V10-M4` の決1)—— **型の上でも
 * `ReportView` は `flow` を持たないので、ここで種別を落としてから読む。**
 */
export function flowStepOf(view: View): FlowStep | undefined {
  return view.type === "report_view" ? undefined : view.flow;
}

/**
 * 同じ流れの**次の位置**(`step + 1`)を宣言している画面。**無ければ `undefined`。**
 *
 * **`find` は定義順の先頭を返す** —— **位置の重複は apply 時に倒れているので、
 * 通常は1つしか当たらない。**
 */
export function nextFlowStepView(manifest: Manifest, view: View): View | undefined {
  const here = flowStepOf(view);
  if (here === undefined) {
    return undefined;
  }
  return manifest.app.views.find((candidate) => {
    const there = flowStepOf(candidate);
    return there !== undefined && there.id === here.id && there.step === here.step + 1;
  });
}

/**
 * 次の段への行き先。**段が解けなければ `undefined` を返す。**
 *
 * **`undefined` の使い分けは、押す前に解決できるか否かで決めてある**(`V10-M4` の決7):
 *
 * - **ボタン(`list_view` / `kind: "input"` の `detail_view`)は fail-closed** ——
 *   **押す前に解決できるので、解けないならボタンごと出さない**(`navigation.tsx:171` の
 *   `resolveRowActionDestination` と同じ作法)。
 * - **`form` の保存の後は逆で、今日どおりの規約に倒れる** —— **既に押されており、
 *   保存は成立しているからである。** **行き先が解けないことは保存の失敗ではない**
 *   (`ADR-0102` 限定8 と同じ向き)。
 *
 * `recordId` は**手元にある行の `_id`** である。**`list_view` は行を1件も指していないので
 * 呼び出し側が `undefined` を渡す。**
 */
export function flowNextRoute(
  appId: string,
  manifest: Manifest,
  view: View,
  recordId: string | undefined,
): Route | undefined {
  const next = nextFlowStepView(manifest, view);
  if (next === undefined) {
    return undefined;
  }
  // **同じ表の `detail_view` のときだけ、手元の行を運ぶ**(`ADR-0357` 限定1・限定2 の線)。
  if (next.type === "detail_view" && next.table === view.table && recordId !== undefined) {
    return { kind: "view", appId, viewId: next.id, recordId };
  }
  return { kind: "view", appId, viewId: next.id };
}

/**
 * **いま何段目 / 全部で何段**(`V10-M5-T02`。`NV-G9` / `NV-G11` の受け先。`ADR-0359` §4b)。
 *
 * **段の宣言が無ければ `undefined`** —— **描く側はそこで1ピクセルも出さない。**
 *
 * ## **位置は `step` の値そのものではない。順位である**(**この選択を隠さない**)
 *
 * **同じ `flow.id` を持つ画面を `manifest.app.views` から集め、`step` の昇順に並べ、
 * その中での順位(1始まり)を `position`、件数を `total` とする。**
 *
 * **なぜ順位で採るのか** —— **順位なら `position <= total` が構造的に保証され、
 * 「7段中5段目」のような数を描く道が閉じるからである。**
 * **`step` をそのまま位置にすると、欠番のある定義で総数を超える数が出うる。**
 *
 * **欠番と重複は差分の適用時に倒れる**(`src/kernel/referential-integrity.ts` の担当。
 * `V10-M4-T01`)—— **したがって通常は `position === step` である。**
 * **手で置かれた古い定義ではこの2つがずれる**(実測は
 * `web/test/flow-position.test.tsx` の (f-1):`step` が 1・3・5 の定義で、
 * 最後の画面は「3段中3段目」と描かれる)。
 *
 * ## **このファイルの中に、並びの導き方が2つ同居している**(**丸めない**)
 *
 * **{@link nextFlowStepView} は `step + 1` を持つ画面を探し、{@link flowPositionOf} は
 * 順位で数える。****欠番のある古い定義では、「3段中2段目なのに『次へ』が出ない」が
 * 起きうる**(位置は順位で詰まるが、次の段は `step + 1` の実在で決まるためである)。
 * **これを1本に畳んでいない。**
 *
 * ## **「閉じた段」がこの数に入るかは、経路で違う**(**直していない。実測した**)
 *
 * **【禁止】「閉じた段も必ず数に入る」と書かない。**
 *
 * 1. **ログイン済み** —— **`GET /api/apps/:app_id/manifest` は役割でビューを1件も
 *    間引かない。** **したがって器に渡る `manifest.app.views` は全量であり、
 *    その人に開けない段も総数に入る。**
 * 2. **未ログイン** —— **`GET /api/apps/:app_id/public`(`src/server/app.ts`)は
 *    `judgeRoleAccess` でビューを絞ってから返し、`publicManifest()`
 *    (`web/src/AppWorkspace.tsx`)がその絞られた集合をそのまま `manifest.app.views` に
 *    して器へ渡す。** **したがって未ログインでは、見せると決めた段だけが総数に入り、
 *    同じ流れが小さい数に見える。**
 *
 * **この非対称は `V10-M5-T02` で直していない**(実測は
 * `web/test/flow-position.test.tsx` の (d-1) / (d-2))。
 *
 * ## **可視性を1文字も見ていない**
 *
 * **導出は宣言の集合だけから行う** —— **`canUseView` を1度も呼んでいない**
 * (呼ぶのは `ViewHost` の「次へ」の側だけである)。
 * **覚え書き(キャッシュ)を1つも持たない** —— **呼ばれるたびにその場で導く**
 * (字面の走査は `web/test/flow-position.test.tsx` の (f-2))。
 */
export function flowPositionOf(
  manifest: Manifest,
  view: View,
): { position: number; total: number } | undefined {
  const here = flowStepOf(view);
  if (here === undefined) {
    return undefined;
  }
  // **同じ流れの画面だけを集める**(`filter` は新しい配列を返すので、宣言の並びを
  // 1バイトも書き換えない)。
  const siblings = manifest.app.views.filter((candidate) => {
    const there = flowStepOf(candidate);
    return there !== undefined && there.id === here.id;
  });
  siblings.sort((left, right) => stepValueOf(left) - stepValueOf(right));
  /*
   * **まず同一性で探す** —— **`step` の重複がある古い定義でも、いま描いている画面の
   * 順位をそのまま採れる。** **参照が一致しないとき(呼び出し側が写しを渡したとき)は
   * `step` の値で探す。**
   */
  const byIdentity = siblings.indexOf(view);
  const index =
    byIdentity >= 0
      ? byIdentity
      : siblings.findIndex((candidate) => stepValueOf(candidate) === here.step);
  if (index < 0) {
    // **その画面がマニフェストの集合に居ない** —— **数を発明しない。**
    return undefined;
  }
  return { position: index + 1, total: siblings.length };
}

/** 段を宣言していると分かっている画面の `step`(**宣言が無ければ番兵を返す**)。 */
function stepValueOf(view: View): number {
  return flowStepOf(view)?.step ?? Number.MAX_SAFE_INTEGER;
}
