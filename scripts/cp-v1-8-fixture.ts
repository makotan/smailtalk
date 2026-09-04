#!/usr/bin/env bun
/**
 * CP-V1-8 の合成試材(V1-M8-T02)。
 *
 * 要件定義書の生成と機械照合(`scripts/cp-v1-8-audit.ts`)を実地の形で回すために、
 * **カーネルの本物の経路**(`createApp` / `applyDiff` / `undo`)を呼んでアプリを育てる。
 * マニフェストを直接書き込む近道は取らない —— `applyManifest` 経由の投入は changelog に
 * 載らず(ADR-0006 Consequences の限界①)、**帰属(出典)の検査そのものが空回りする**。
 *
 * ## 何を含めるか(CP-V1-8 の照合が意味を持つための下限)
 *
 * - テーブル4件(`books` / `tags` / `wf-runs` / `monthly-counts`)
 * - ビュー4件(list_view / form / detail_view / list_view)
 * - ワークフロー2件。**アクション5種のうち4種を実地で踏む** ——
 *   `create_record` / `run_function`(`recount-on-new-book`)と
 *   `call_external` / `ai_transform`(`notify-on-new-book`)。
 *   `update_record` だけは踏んでいない(`automation.action_target_table` は
 *   `create_record` 側で踏むので、テンプレートの未踏は無い)
 * - 関数1件(コードの島。`capabilities` 付き)
 * - **フィールドの rename 1回**(`change_field` で `rating` → `score`。ADR-0025 §8-3 の別名表)
 * - **undo 1回**(最後の apply を取り消す。ADR-0025 §8-2 / §8-4)
 * - select の選択肢・reference・sort・filter(逐語引用スロットが出る経路)
 *
 * ## 決定論について(誇張しない)
 *
 * `app_id` / `created_at` / 差分の中身は固定してあり、**同じ引数で何度作っても同じになる**。
 * ただし **changelog の `applied_at` は固定できない** —— `applyDiff` / `undo` は時刻を
 * 注入する引数を持たず(`src/kernel/apply-diff.ts` / `undo.ts`)、追記時の実時刻が入る。
 * 固定できているのは `create_app` が書く第0行だけである(`createApp` の `created_at`)。
 * **したがって「生成物が2回とも完全一致する」ことはこの試材では主張しない。**
 * 生成器の決定論そのものは `src/kernel/requirements-doc.test.ts` が同一 dataRoot に対する
 * 2回生成で固定している。
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff } from "../src/kernel/apply-diff.ts";
import { createApp } from "../src/kernel/create-app.ts";
import { KernelMetaStore } from "../src/kernel/meta-store.ts";
import type { Diff } from "../src/kernel/types.ts";
import { undo } from "../src/kernel/undo.ts";

/** 試材のアプリID。監査スクリプトへ渡すため固定する。 */
export const FIXTURE_APP_ID = "cp-v1-8-demo";
/** 試材のアプリ表示名。 */
export const FIXTURE_APP_NAME = "蔵書管理";
/** 第0行の時刻。固定できるのはここだけである(上の doc コメント)。 */
export const FIXTURE_CREATED_AT = "2026-07-23T00:00:00.000Z";

/**
 * 差分の並び。**この配列がそのまま履歴になる**。
 *
 * `intent` は入口規約(`INTENT_VERBATIM` / F-22)に倣い、ユーザの発話として自然な文にしてある。
 * 2件目に ASCII のバッククォート語(`select`)を混ぜてあるのは意図的で、
 * **逐語引用を識別子照合の対象から外している**(ADR-0025 §4-2)ことを実地で踏むためである。
 */
const DIFFS: readonly Diff[] = [
  {
    diff_id: "d-001",
    intent: "本を記録したいので、タイトルとメモを持つ台帳と一覧・入力・詳細の画面がほしいです",
    operations: [
      {
        op: "add_table",
        table: {
          id: "books",
          name: "本",
          fields: [
            { id: "title", name: "タイトル", type: "text", required: true },
            { id: "memo", name: "メモ", type: "long_text" },
          ],
        },
      },
      {
        op: "add_view",
        view: { id: "book-list", type: "list_view", table: "books", columns: ["title"] },
      },
      {
        op: "add_view",
        view: { id: "book-form", type: "form", table: "books", fields: ["title", "memo"] },
      },
      {
        op: "add_view",
        view: { id: "book-detail", type: "detail_view", table: "books", fields: ["title", "memo"] },
      },
    ],
  },
  {
    diff_id: "d-002",
    intent: "ジャンル・タグの`select` と評価を数字で持ちたいです",
    operations: [
      {
        op: "add_field",
        table: "books",
        field: { id: "genre", name: "ジャンル", type: "select", options: ["小説", "技術書"] },
      },
      { op: "add_field", table: "books", field: { id: "rating", name: "評価", type: "number" } },
      {
        op: "update_view",
        view: "book-list",
        changes: {
          name: "本の一覧",
          columns: ["title", "genre", "rating"],
          sort: [
            { field: "rating", order: "desc" },
            { field: "title", order: "asc" },
          ],
          filter: [{ field: "genre", equals: "技術書" }],
        },
      },
    ],
  },
  {
    diff_id: "d-003",
    intent: "タグを別の台帳にして、本から参照できるようにしてください",
    operations: [
      {
        op: "add_table",
        table: {
          id: "tags",
          name: "タグ",
          fields: [{ id: "label", name: "名前", type: "text", required: true }],
        },
      },
      {
        op: "add_field",
        table: "books",
        field: { id: "tag", name: "タグ", type: "reference", reference_table: "tags" },
      },
    ],
  },
  {
    // rename(ADR-0025 §8-3)。id を変えるので、帰属は別名表を辿らないと過去の diff に届かない。
    diff_id: "d-004",
    intent: "評価という名前より点数のほうが分かりやすいので score に変えてください",
    operations: [
      {
        op: "change_field",
        table: "books",
        field: "rating",
        changes: { id: "score", name: "点数" },
      },
    ],
  },
  {
    diff_id: "d-005",
    intent: "自動化の実行履歴と月次の集計結果を残す台帳と、その一覧画面を作ってください",
    operations: [
      {
        op: "add_table",
        table: {
          id: "wf-runs",
          name: "実行履歴",
          fields: [
            { id: "ran_at", name: "実行時刻", type: "date" },
            { id: "workflow", name: "ワークフロー", type: "text" },
            { id: "trigger_type", name: "きっかけ", type: "text" },
            { id: "status", name: "結果", type: "text" },
            { id: "error", name: "エラー", type: "long_text" },
          ],
        },
      },
      {
        op: "add_table",
        table: {
          id: "monthly-counts",
          name: "月次集計",
          fields: [
            { id: "month", name: "月", type: "text" },
            { id: "count", name: "件数", type: "number" },
          ],
        },
      },
      {
        op: "add_view",
        view: {
          id: "run-list",
          type: "list_view",
          table: "wf-runs",
          name: "実行履歴の一覧",
          columns: ["ran_at", "workflow", "status"],
          sort: [{ field: "ran_at", order: "desc" }],
        },
      },
    ],
  },
  {
    diff_id: "d-006",
    intent: "本が登録されたら月ごとの冊数を数え直して、結果を残してください",
    operations: [
      {
        op: "add_function",
        function: {
          id: "count-by-month",
          name: "月ごとに本を数える",
          code: "export default (rows) => rows;",
          input: { source: "table", table: "books" },
          output: {
            fields: [
              { id: "month", type: "text" },
              { id: "count", type: "number" },
            ],
          },
          capabilities: ["notify-slack"],
        },
      },
      {
        op: "add_workflow",
        workflow: {
          id: "recount-on-new-book",
          name: "本が増えたら数え直す",
          trigger: { type: "on_create", table: "books" },
          actions: [
            {
              action: "create_record",
              table: "wf-runs",
              values: { workflow: "recount-on-new-book" },
            },
            { action: "run_function", function: "count-by-month", output_table: "monthly-counts" },
          ],
          history_table: "wf-runs",
        },
      },
    ],
  },
  {
    /*
     * 外部到達アクション(`call_external`)と機能内 AI 呼び出し(`ai_transform`)。
     * ADR-0025 改訂1 が足した automation.action_connection / _destination / _payload /
     * _ai_capability / _ai_prompt / _ai_input / _ai_output_field / _ai_fallback の
     * 8テンプレートを**実地で踏む**ためのものである。
     *
     * ## capability は「定義するだけ」で apply が通る(実地で確かめた)
     *
     * `connection: "notify-slack"` も `capability: "summarize-memo"` も、**この時点では
     * 1件も発行されていない**。それでも `applyDiff` は通る —— 参照整合性検査が
     * `call_external` / `ai_transform` を**意図的に対象外にしている**からである
     * (`src/kernel/referential-integrity.ts:288-297` / `:589-596`:「capability は
     * マニフェスト外(人間専用ストア)を指す。apply 時には検査せず、実行時に fail-closed で
     * 照合する」。ADR-0020 §2e / ADR-0021 §3)。
     *
     * **したがって owner としての発行経路(`CapabilityStore` / `AiCapabilityStore`)は
     * 使っていない。**使う必要が無いからであって、迂回したのではない。**書けること
     * (マニフェストに現れること)と実行されること(実際に送信・推論が起きること)は別**
     * であり、この試材は前者だけを作る —— 要件定義書は現在のマニフェストと changelog の
     * 再構成なので、文書の検査に必要なのは定義の実在だけである。
     * **この試材から外部送信も AI 呼び出しも1件も起きない**(ワークフローが発火するのは
     * レコードが作られたときで、試材はレコードを1件も作らない。仮に発火しても capability が
     * 無いので実行層で遮断される)。
     *
     * `ai_transform` は `schedule` トリガーでは適用時に拒否される(書き戻し先が無い)ので、
     * `on_create` のワークフローに置いてある。
     */
    diff_id: "d-007",
    intent: "本が登録されたらチームに知らせて、メモをAIに短くまとめ直してほしいです",
    operations: [
      {
        op: "add_workflow",
        workflow: {
          id: "notify-on-new-book",
          name: "本が増えたら知らせて要約する",
          trigger: { type: "on_create", table: "books" },
          actions: [
            {
              action: "call_external",
              connection: "notify-slack",
              destination: "https://hooks.example.invalid/services/book-added",
              payload: { event: "book_created", title: "$record.title" },
            },
            {
              action: "ai_transform",
              capability: "summarize-memo",
              prompt: "次のメモを日本語で1文に要約してください。",
              input: { title: "$record.title", memo: "$record.memo" },
              output_field: "memo",
              fallback: "(要約できませんでした)",
            },
          ],
          history_table: "wf-runs",
        },
      },
    ],
  },
  {
    /*
     * **V4-M39-T01(ADR-0144 A10 / ADR-0145 A9)。画面の見せ方の宣言と、逃げ道への参照。**
     *
     * **監査の語彙照合(8グループ)と識別子照合(`escape_hatch_asset_name`)を実地で踏む** ——
     * 踏まないまま「監査を追随させた」とは言えない。**資産 `print-layout` は発行していない**
     * (owner 専用の資産ストアはこの試材に無い)—— **それでも生成も監査も成功する**のが
     * `ADR-0145` A7 の定めである(実在を照合しない / fail-closed しない)。
     */
    diff_id: "d-007b",
    intent: "一覧は詰めてカードで見せて、詳細は2段組にしてください。印刷用の見た目も当てたいです",
    operations: [
      {
        op: "update_view",
        view: "book-list",
        changes: {
          preset_column_align: { title: "left", score: "right" },
          preset_column_width: { title: "wide" },
          preset_pager_position: "bottom",
          preset_image_size: "thumbnail",
          preset_text_preview: "short",
          preset_list_shape: "card",
          preset_density: "compact",
          custom_css: { asset: "print-layout", digest: "b".repeat(64) },
        },
      },
      {
        op: "update_view",
        view: "book-detail",
        changes: {
          preset_label_placement: "stacked",
          preset_field_columns: 2,
          preset_image_size: "original",
          preset_text_preview: "full",
          preset_density: "comfortable",
        },
      },
      {
        op: "update_view",
        view: "book-form",
        changes: { preset_label_placement: "inline", preset_field_columns: 1 },
      },
    ],
  },
  {
    // これが undo の対象になる(最後の apply)。取り消された apply は帰属の出典にならないが、
    // 履歴からは消えない(ADR-0025 §8-4)。
    diff_id: "d-008",
    intent: "出版社も入れたいです",
    operations: [
      {
        op: "add_field",
        table: "books",
        field: { id: "publisher", name: "出版社", type: "text" },
      },
    ],
  },
];

/** 育てた試材の情報。 */
export type FixtureResult = { dataRoot: string; appId: string; diffCount: number };

/**
 * 試材を育てる。`dataRoot` を省略すると一時ディレクトリを作る。
 *
 * 途中で1件でも失敗したら即座に throw する —— 半端に育った試材で監査を回すと、
 * 「検査したが何も見つからなかった」のか「そもそも材料が無かった」のかが区別できなくなる。
 */
export async function buildFixture(dataRoot?: string): Promise<FixtureResult> {
  const root = dataRoot ?? (await mkdtemp(join(tmpdir(), "cp-v1-8-")));
  const store = KernelMetaStore.open(root);
  try {
    createApp(store, FIXTURE_APP_NAME, {
      app_id: FIXTURE_APP_ID,
      created_at: FIXTURE_CREATED_AT,
    });
  } finally {
    store.close();
  }

  for (const diff of DIFFS) {
    const result = applyDiff(root, FIXTURE_APP_ID, diff);
    if (!result.valid) {
      throw new Error(
        `試材の差分適用に失敗しました(${diff.diff_id}): ${JSON.stringify(result.errors)}`,
      );
    }
  }

  const undone = undo(root, FIXTURE_APP_ID);
  if (!undone.valid) {
    throw new Error(`試材の undo に失敗しました: ${JSON.stringify(undone.errors)}`);
  }

  return { dataRoot: root, appId: FIXTURE_APP_ID, diffCount: DIFFS.length };
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  const index = argv.indexOf("--data-root");
  const dataRoot = index === -1 ? undefined : argv[index + 1];
  if (index !== -1 && (dataRoot === undefined || dataRoot.startsWith("--"))) {
    console.log("使い方: bun run scripts/cp-v1-8-fixture.ts [--data-root <path>]");
    process.exit(2);
  }
  const result = await buildFixture(dataRoot);
  console.log(
    [
      `data-root: ${result.dataRoot}`,
      `app: ${result.appId}`,
      `適用した差分: ${result.diffCount} 件(うち最後の1件は undo で取り消し済み)`,
    ].join("\n"),
  );
}
