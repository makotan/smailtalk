/**
 * システムテーブル(ADR-0006)。
 *
 * カーネルが自分の状態(アプリ台帳・changelog)を、**既存の語彙のまま**ユーザランドへ
 * 投影(projection)するための定義である。新しいリソース種でも新しいフィールド型でもなく、
 * 既存の `Table` 型の**値**にすぎない(ADR-0006 §1 の限定2)。
 *
 * ## なぜ `src/kernel/` ではなく `src/shared/` なのか
 *
 * フロントエンドがこの定数を**値として import する**ため。`src/kernel/*` を辿ると
 * `bun:sqlite` を推移的に読み込み、`vite build` が壊れる。したがってこのファイルの
 * 依存は `src/kernel/types.ts` の**型のみ**に限る(`src/shared/route.ts` と同じ扱い)。
 * ここに実行時 import を1つ足すとフロントのビルドが落ちるので注意すること。
 *
 * ## 衝突しないことは規約ではなく構造で保証される
 *
 * ユーザ定義のリソースIDは `^[a-z][a-z0-9_-]*$`(`src/kernel/resource-id.ts` と
 * JSON Schema の二重の壁)であり、`_` 始まりのIDは**定義したくてもできない**。
 * `SYSTEM_COLUMN_NAMES`(`src/kernel/ddl.ts`)が `_id` 等をユーザ定義フィールドと
 * 衝突させずに済ませているのとまったく同じ手口である。
 *
 * ## 増やさない
 *
 * v0 のシステムテーブルは `_apps` と `_changelog` の2つで打ち止めである
 * (ADR-0006 §4 / §3「越えてはならない線」)。スナップショット一覧やビュー定義も
 * `Table` 定数をもう1つ書けば投影できるが、**書けることは書く理由にならない**。
 * 投影を1つ増やすたびに「カーネルの内部構造 = ユーザランドの語彙」への距離が縮まる。
 */
import type { Table } from "../kernel/types.ts";

/**
 * プラットフォーム上の全アプリの台帳。`KernelMetaStore.listApps()` の投影。
 *
 * 列は `AppRecord`(`src/kernel/meta-store.ts`)の一部をそのまま写したもので、
 * 7型の範囲に収まっている。`status` の選択肢は `APP_STATUSES` と同じ値だが、
 * `meta-store.ts` は `bun:sqlite` を引くのでここからは import できない。
 * 一致は `src/kernel/system-tables-guarantees.test.ts` が固定している。
 */
const APPS_TABLE: Table = {
  id: "_apps",
  name: "アプリ一覧",
  fields: [
    { id: "app_id", name: "アプリID", type: "text", required: true },
    { id: "name", name: "アプリ名", type: "text", required: true },
    { id: "created_at", name: "作成日時", type: "date", required: true },
    { id: "status", name: "状態", type: "select", required: true, options: ["active", "archived"] },
  ],
};

/**
 * 全アプリの変更履歴(intent 付き)。閲覧中のアプリに閉じない(ADR-0006 §6b)。
 *
 * 名前に断りを入れているのは、**この画面が「起きたことの全部」ではない**からである。
 * changelog に載るのは `createApp` が書く第0行(V1-M0-T05)と `applyDiff` 経由の変更だけで、
 * `applyManifest` 経由の投入は記録されない(CP-4 既知の限界①)。書かれていない変更が
 * あることは画面からは分からないので、テーブル名の時点で言っておく(憲法6)。
 *
 * `snapshot`(内部のディレクトリ名)と `operations`(生の `Operation[]` JSON)は
 * 意図的に出していない。前者は実装詳細の露出、後者は7型に素直に写らない。
 * op の中身が要るなら MCP の `get_changelog` が既に返している。
 *
 * `app_id` を `reference` にしないのも意図的である。reference にすると参照可能な
 * テーブルの集合にシステムテーブルを入れる必要が生じ、そこを開けた瞬間に
 * **ユーザテーブルからシステムテーブルへの reference も通ってしまう**(ADR-0006 §9 の裏口)。
 */
const CHANGELOG_TABLE: Table = {
  id: "_changelog",
  name: "変更履歴(アプリ作成と apply_diff 経由の変更のみ)",
  fields: [
    { id: "seq", name: "連番", type: "number", required: true },
    { id: "app_id", name: "アプリID", type: "text", required: true },
    { id: "diff_id", name: "差分ID", type: "text", required: true },
    { id: "intent", name: "意図", type: "long_text", required: true },
    { id: "applied_at", name: "適用日時", type: "date", required: true },
    // ADR-0032(V1-M9-T05)が redo を足したので3値。CHANGELOG_KINDS(meta-store.ts)と
    // 一致することを system-tables-guarantees.test.ts が固定する(値域の単一ソースはあちら)。
    {
      id: "kind",
      name: "種別",
      type: "select",
      required: true,
      options: ["apply", "undo", "redo"],
    },
    { id: "undo_target_seq", name: "取り消し対象の連番", type: "number" },
  ],
};

/**
 * AI 呼び出しのメータリング(V1-M5-T03 / ADR-0021 §4)。**`AiUsage`(`ai-capability-store.ts`)の
 * 投影。**7型に収まる列に写す。`_changelog` と同じく全アプリ横断で(ADR-0006 §6b)、画面では
 * `app_id` / `actor` / `model` 列で絞ってアプリ別・ユーザ別・期間別に集計する。
 *
 * **なぜ v0 の「2つで打ち止め」を破って3本目を足すか**: ADR-0021 §4。`05-ai-metering.md` が
 * 「AI 呼び出しごとに使用量を記録し、システムテーブルとして集計可能にする」ことを完了条件に
 * 要求している。これはセキュリティ状態(capability 定義)ではなく使用量の記録であり、
 * `_changelog` が「起きたことの記録」を read-only で見せているのと同じ範疇である。**capability
 * 定義そのもの(`ai_capabilities`)は依然として投影しない**(ADR-0020 §8c-8 の芯を保つ)。
 *
 * `capability_id` は出すが、`workflow_id` は呼出元の資源IDで意味がある(呼び出しがどの
 * ワークフロー由来かを追える)ので出す。`app_id` を `reference` にしないのは `_changelog` と
 * 同じ理由(ADR-0006 §9 の裏口を開けない)。
 */
const AI_USAGE_TABLE: Table = {
  id: "_ai_usage",
  name: "AI 呼び出しの使用量(全アプリ横断・読み取り専用)",
  fields: [
    { id: "app_id", name: "アプリID", type: "text", required: true },
    { id: "capability_id", name: "capability ID", type: "text", required: true },
    { id: "workflow_id", name: "呼出元ワークフロー", type: "text", required: true },
    { id: "actor", name: "ユーザ", type: "text" },
    { id: "model", name: "モデル", type: "text", required: true },
    { id: "input_tokens", name: "入力トークン", type: "number", required: true },
    { id: "output_tokens", name: "出力トークン", type: "number", required: true },
    { id: "cost_usd", name: "推定コスト(USD)", type: "number", required: true },
    {
      id: "status",
      name: "状態",
      type: "select",
      required: true,
      options: ["success", "failure", "blocked"],
    },
    { id: "usage_date", name: "使用日(集計境界)", type: "text", required: true },
    { id: "called_at", name: "呼び出し日時", type: "date", required: true },
  ],
};

/** システムテーブル(V1-M5-T03 で `_ai_usage` を足し、この3つになった)。 */
export const SYSTEM_TABLES: readonly Table[] = [APPS_TABLE, CHANGELOG_TABLE, AI_USAGE_TABLE];

/** システムテーブルのID一覧。 */
export const SYSTEM_TABLE_IDS: readonly string[] = SYSTEM_TABLES.map((table) => table.id);

/** そのIDがシステムテーブルを指すか。 */
export function isSystemTableId(id: string): boolean {
  return SYSTEM_TABLE_IDS.includes(id);
}

/** システムテーブルの定義を引く。システムテーブルでなければ undefined。 */
export function findSystemTable(id: string): Table | undefined {
  return SYSTEM_TABLES.find((table) => table.id === id);
}
