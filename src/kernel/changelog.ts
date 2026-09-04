/**
 * changelog 取得API(V0-P4-T05)。
 *
 * changelog は「意図のログ = 要件履歴」(handover.md 3.8、憲法5「差分に意図を残す。
 * changelog が要件定義書」)である。このモジュールは、その履歴を **生のまま** 取り出す
 * カーネル内部APIを1本だけ提供する。Phase 5 の MCP ツール `get_changelog` の実体になる。
 *
 * ## 何をしないか(ADR-0004 の申し送り)
 *
 * `kind` と `undo_target_seq` を **そのまま返し、畳み込み計算は持たない。**
 * 「今どの状態にいるか」「どの apply が生きているか」を計算して付け足すことはしない。
 * その判定は undo の対象選択(`undo.ts` の `selectUndoTarget`)が ADR-0004 §3 の定義
 * ただ1箇所で行っており、同じ意味論を2箇所に書けば必ず食い違う。履歴の読み手にとっても、
 * 「実際に何が起きたか」の生ログと「今どうなっているか」の解釈は別物である。
 *
 * ## なぜ `KernelMetaStore#listChangelog` をそのまま使わず薄い関数を1つ挟むか
 *
 * 中身の取得は `listChangelog` が既に完全に満たしているので、そこは一切作り直さない
 * (憲法1「カーネルは退屈に作る」)。この層が足すのは次の2点だけである。
 *
 * 1. **呼び出し規約を他のカーネルAPIに揃える。** `applyDiff` / `undo` / `previewUndo` /
 *    `takeSnapshot` はすべて `(dataRoot, appId)` を受け、DBの開閉を内側で完結させる。
 *    取得系だけが呼び出し側に `KernelMetaStore` の open/close を強いると、閉じ忘れが
 *    そのまま漏れになる。
 * 2. **存在しないアプリを空配列で誤魔化さない。** `listChangelog` は未登録の app_id に
 *    対しても `[]` を返すため、「履歴がまだ無いアプリ」と区別がつかない。呼び出し側には
 *    「そんなアプリは無い」と「まだ何も変更していない」が同じに見えてしまう。憲法6
 *    (できないことは正直に言う)に照らして、前者は例外にする。
 *
 * ## エラー方針
 *
 * 存在しないアプリの指定は呼び出し側のプログラミングエラーであり、LLM が差分を直せば
 * 済む種類の失敗ではない。したがって `ValidationResult` ではなく例外にする
 * (`meta-store.ts` / `apply-manifest.ts#readCurrentManifest` と同じ方針)。
 */
import { type ChangelogEntry, KernelMetaStore } from "./meta-store.ts";

/**
 * 指定アプリの変更履歴を適用順(`seq` 昇順)で返す。
 *
 * apply と undo の両方が、記録された順にそのまま並ぶ。取り消された apply も履歴からは
 * 消えない(消してしまうと履歴が「実際に何が起きたか」を語れなくなる)。undo エントリの
 * `undo_target_seq` が、取り消した apply エントリの `seq` を指す。
 *
 * 状態を一切変更しない参照系API。
 *
 * @param dataRoot データルート(`data/` 相当)。環境変数に依存させず必ず引数で受ける。
 * @param appId 対象アプリのID。
 * @throws `appId` が台帳に登録されていない場合
 */
export function getChangelog(dataRoot: string, appId: string): ChangelogEntry[] {
  const store = KernelMetaStore.open(dataRoot);
  try {
    if (!store.hasApp(appId)) {
      throw new Error(
        `app_id "${appId}" は台帳に登録されていません。変更履歴を取得できません。` +
          `list_apps でアプリ一覧を確認してください。`,
      );
    }
    return store.listChangelog(appId);
  } finally {
    store.close();
  }
}
