/**
 * **形 → 動詞の写像**(`V14-M2-T02`。台帳 `RB-G1` / `RB-G3` / `RB-G4`。`ADR-0402` §Decision 5)。
 *
 * **製品にちょうど1本である**(`ADR-0402` 越えてはならない線2)—— **一覧と詳細で別々の
 * 述語を書かない**(`ADR-0310` 限定9 / `ADR-0402` 限定13)。**この2つの関数を定義する
 * ファイルを2本目に増やさないこと。**
 *
 * ## この写像が答える問い
 *
 * | 形 | 見る対象 |
 * |---|---|
 * | `set`(値の書換) | その行の `write` |
 * | `run`(自動処理) | その行の `write`(`D-V14-3`。**`run` 専用の動詞を作らない** = 限定24) |
 * | `view`(行き先) | その行の `read` |
 * | `form`(遷移) | **作る先が「今開いている表の付与表」なら** `grant_write`。そうでなければ何も見ない |
 *
 * **複数の形のキーを同時に持つ起点(スキーマは `oneOf` で閉じているが、型は `unknown` で
 * 受ける)では `set` → `run` → `view` → `form` の順で最初に当たったものを返す。**
 * **順序は検査で固定してある**(`web/test/row-action-verb.test.ts` の `verb-11`)。
 *
 * ## **【最初に書く】ボタンを隠すことは、書込を止めることではない**
 *
 * **この写像も {@link rowAccessAllows} も、サーバの遮断を1ミリも動かさない**
 * (`ADR-0402` 限定7)。**URL を直接叩く経路は今日どおり 403 / 404 に到達する**(限定8)。
 * **【禁止】「隠したから安全である」と書かない。**
 *
 * ## **【代償を隠さない】この1本は軽くない**
 *
 * **`form` の判定に `grantTableParentId`(`../fields/input.tsx`)を呼ぶので、
 * 「純関数1本」と称しながら React・`../api.ts`・`../ui/*.tsx` を依存に引き込む。**
 * **循環はしない**(`input.tsx` が `views/` から引くのは `search-filter.ts` 1本だけ)。
 * **それでも軽くはない** —— **アクセス権管理の宣言を綴る製品ファイルを `web/src/` に
 * 3本目として増やさない**(`ADR-0402` 限定10)ことを優先した結果である。
 * **このファイル自身は、その宣言のキーを1文字も綴っていない。**
 */
import type { Manifest, ResourceId } from "../../../src/kernel/types.ts";
import type { RowAccess } from "../api.ts";
import { grantTableParentId } from "../fields/input.tsx";

/**
 * **行の判定のうち、どれを見るか。**
 *
 * **3つちょうどである**(`ADR-0402` 限定24)—— **`delete` はこの写像から返らない**
 * (4形のどれもが行の削除を起こさないため)。**`run` 専用の動詞も無い。**
 *
 * ## **【訂正の追記】`V14-M6-T01`(単位 `RB-G7`。上の旧文は1バイトも消していない)**
 *
 * - **「3つちょうど」は、今日は判定を**受け取る側**では4語である** ——
 *   **`delete` を足した {@link RowVerb} が {@link rowAccessAllows} の受け口だからである。**
 *   **この型(`RowActionVerb` = 写像が**返す**側)は今日も3つちょうどである。**
 * - **「`delete` はこの写像から返らない」は今日も真である** ——
 *   **{@link rowActionVerb} の戻り型を1バイトも広げていない**(`ADR-0402` 越えてはならない線1)。
 *   **`web/test/row-action-verb.test.ts` の `(RB-G7/verb-4)` が6通りで撃っている。**
 * - **`delete` を使うのは組み込みの削除ボタンだけであり、それは「形」を持たないので
 *   この写像を1度も通らない。** **動詞を直に書く**(`ADR-0402` 越えてはならない線2 ——
 *   **写像のファイルを2本目に増やさない**)。
 * - **`ADR-0402` 限定24 の条文は `run` についてであり、`delete` を1文字も名指ししていない。**
 *   **`docs/adr/0402-row-access-in-response-and-button-visibility.md:168` を実読した。逐語:**
 *   「**`RB-G4`** | **見る動詞は `write` ちょうど1つ。`run` 専用の動詞を新しく作らない**」。
 *   **したがって限定24 を1ミリも超えていない。**
 * - **単位は `RB-G7`(門外・限定採用。`ADR-0007` §8 台帳)。**
 */
export type RowActionVerb = "read" | "write" | "grant_write";

/**
 * **{@link rowAccessAllows} が受け取れる動詞の全量**(`V14-M6-T01`。台帳 `RB-G7` / `RB-G8`)。
 *
 * **写像が返す3つ({@link RowActionVerb})に、組み込みの削除ボタンが見る `delete` を足した4語。**
 *
 * **【この型が写像を広げたのではない】** **`delete` を差し込むのは、宣言由来の操作起点では
 * なく、詳細画面に元から在る組み込みの「削除」ボタンである。** **そのボタンは `set` /
 * `run` / `view` / `form` のどの「形」も持たないので、{@link rowActionVerb} を1度も通らず、
 * 動詞を直に書く。** **`ADR-0402` 越えてはならない線2(写像は製品にちょうど1本)を
 * 超えていない。**
 *
 * **【禁止】ボタンを隠すことは書込を止めることではない。** **削除を止めているのは今日どおり
 * サーバの `access.verdict.delete` による 403 である**(`ADR-0402` 限定7)。
 */
export type RowVerb = RowActionVerb | "delete";

/**
 * 操作起点1つが見るべき動詞。**当てる動詞が無い形では `undefined` を返す**
 * (= 行の判定を1つも当てない = 今日どおり面だけで決まる)。
 *
 * @param viewTableId **今開いている画面の対象テーブル**。
 *   **`form` 形の判定に要る** —— **`access` の鍵は「今開いている表の行の `_id`」なので、
 *   別の親の付与表へ向かう起点にこの行の判定を当てられない。**
 * @param action 操作起点1つ。**`unknown` で受ける** —— **`src/kernel/types.ts` の
 *   `actions` の要素型を写して2本目の型を作らない。**
 */
export function rowActionVerb(
  manifest: Manifest,
  viewTableId: ResourceId | undefined,
  action: unknown,
): RowActionVerb | undefined {
  if (typeof action !== "object" || action === null || Array.isArray(action)) {
    return undefined;
  }
  const shape = action as {
    set?: unknown;
    run?: unknown;
    view?: unknown;
    form?: unknown;
  };
  // **順序はここ1箇所にしか無い**(`set` → `run` → `view` → `form`)。
  if (shape.set !== undefined) {
    return "write";
  }
  if (shape.run !== undefined) {
    return "write";
  }
  if (shape.view !== undefined) {
    return "read";
  }
  if (shape.form === undefined) {
    return undefined;
  }
  if (viewTableId === undefined || typeof shape.form !== "string" || shape.form === "") {
    return undefined;
  }
  const formViewId = shape.form;
  const formView = manifest.app.views.find(
    (candidate) => candidate.type === "form" && candidate.id === formViewId,
  );
  if (formView === undefined) {
    return undefined;
  }
  // **`grant.table` だけを見る薄い口**(`ADR-0402` §Decision 5。計画 §0a)——
  // **`grantMemberScope` は使わない。** **`inherit_from` が空でも `grant.member` が
  // 無くてもサーバは `grant_write` を判定しているからである。**
  const parentTableId = grantTableParentId(manifest, formView.table);
  // **今開いている表の付与表のときだけ当てる。** **別の親の付与表なら、その行は親ではない。**
  return parentTableId === viewTableId ? "grant_write" : undefined;
}

/**
 * **その行でこの動詞が許されているか。既定は「出す」に倒す。**
 *
 * - `verb === undefined` … **真**(行の判定を当てない形である)。
 * - `rowAccess === undefined` … **真**(**その表は宣言していない** ——
 *   既存アプリの見え方を黙って変えない。`ADR-0402` 限定4)。
 * - それ以外 … `rowAccess[verb]` **そのもの**(和も積も取らない。限定18)。
 *
 * **【正直に書く】この既定は「行が `access` に載っていない」場合にも真を返す。**
 * **サーバは `_id` を持たない行だけを落とすので通常は起きないが、起きたときは
 * 今日どおりボタンが出る。** **これは限界であり、最終防衛線はサーバの 403 / 404 である。**
 *
 * ## **【追記】`V14-M6-T01`(`RB-G7` / `RB-G8`。上の旧文は1バイトも消していない)**
 *
 * **第2引数が {@link RowVerb} に広がり、`"delete"` も受けるようになった。**
 * **本体のロジックは1バイトも変えていない**(`rowAccess[verb]` そのもの。和も積も取らない ——
 * `ADR-0402` 限定18)。**したがって上の3つの既定はそのまま `"delete"` にも当てはまる** ——
 * **宣言していない表(`rowAccess === undefined`)では `"delete"` でも真、
 * すなわち今日どおり削除ボタンが出る**(`ADR-0402` 限定4)。
 *
 * **受け取る側が4語になっても、{@link rowActionVerb} が返す側は3語のままである。**
 * **`"delete"` を渡すのは組み込みの削除ボタン(「形」を持たない)だけである。**
 */
export function rowAccessAllows(
  rowAccess: RowAccess | undefined,
  verb: RowVerb | undefined,
): boolean {
  if (verb === undefined) {
    return true;
  }
  if (rowAccess === undefined) {
    return true;
  }
  return rowAccess[verb];
}
