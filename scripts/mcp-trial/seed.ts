/**
 * ブートストラップ試行(V0-P6-T03b)の**事前状態**を作るスクリプト。
 *
 * ## なぜ必要か
 *
 * 完成条件(1)は「実在する**全**アプリの一覧が見える」である。空のデータルートから
 * 始めると、一覧に出るのは管理アプリ自身1件だけになり、「一覧になっている」ことの
 * 機械照合が退化する(1件は一覧でなくても表示できる)。完成条件(2)の「各アプリの
 * diff 履歴が intent 付きで読める」も同様で、他アプリの changelog が空だと
 * 「閲覧中のアプリに閉じない」(ADR-0006 §6b)が確かめられない。
 *
 * そこで**試行を開始する前に**、既にアプリが育っているプラットフォームの状態を作る。
 * これは会話への介入ではない。judge の `change_between_turns` / `mtime_outside_run` は
 * 「ターンの前後でデータが変わったか」を見るので、最初のスナップショット採取より前に
 * 済ませてある限り検証には影響しない。**run.ts を起動したあとに実行してはならない。**
 *
 * ## 何を作るか
 *
 * v0 の語彙(5リソース種 + 7フィールド型)の範囲で意味のあるアプリを2件。
 * それぞれ `create_app` 相当のあと、**intent 付きの差分を3回ずつ**適用する。
 * 履歴画面の検証には changelog に中身が要るので、1回で作り切らず育てる形にしてある。
 *
 * ## 使い方
 *
 *   ST_DATA_ROOT=data-cp6 mise exec -- bun run scripts/mcp-trial/seed.ts
 *   mise exec -- bun run scripts/mcp-trial/seed.ts --data-root data-cp6 --force
 *
 * 既にアプリがある場合は既定で何もしない(冪等ではなく**拒否**する)。同じ diff_id を
 * 二度適用すると applyDiff が重複エラーを返すため、黙って足すと中途半端になるからである。
 */
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { applyDiff, createApp, type Diff, KernelMetaStore } from "../../src/kernel/index.ts";

/** 1アプリぶんの種。名前と、順に適用する差分の列。 */
export type SeedApp = {
  app_id: string;
  name: string;
  diffs: Diff[];
};

/**
 * 事前状態として作るアプリ。
 *
 * 「プラットフォームに既にアプリがある」ことを示すのが目的なので、題材は v0 で
 * 何度も使っている蔵書管理と、フィールド型の幅がある在庫管理にした。
 * intent は**人間が書いた要望の言い換え**として書いている(憲法5: changelog が要件定義書)。
 */
export const SEED_APPS: readonly SeedApp[] = [
  {
    app_id: "book-tracker",
    name: "蔵書管理",
    diffs: [
      {
        diff_id: "book-0001",
        intent: "読んだ本を記録しておきたい。まずはタイトルと読んだ状態だけ持てれば十分",
        operations: [
          {
            op: "add_table",
            table: {
              id: "books",
              name: "書籍",
              fields: [
                { id: "title", name: "タイトル", type: "text", required: true },
                {
                  id: "status",
                  name: "状態",
                  type: "select",
                  options: ["未読", "読書中", "読了"],
                },
              ],
            },
          },
          {
            op: "add_view",
            view: {
              id: "book-list",
              type: "list_view",
              table: "books",
              columns: ["title", "status"],
            },
          },
          {
            op: "add_view",
            view: {
              id: "book-form",
              type: "form",
              table: "books",
              fields: ["title", "status"],
            },
          },
        ],
      },
      {
        diff_id: "book-0002",
        intent:
          "いつ読み終わったかを残したい。一覧でも読了日が見えて、新しく読んだ順に並んでほしい",
        operations: [
          {
            op: "add_field",
            table: "books",
            field: { id: "finished_at", name: "読了日", type: "date" },
          },
          {
            op: "update_view",
            view: "book-list",
            changes: {
              columns: ["title", "status", "finished_at"],
              sort: { field: "finished_at", order: "desc" },
            },
          },
          {
            op: "update_view",
            view: "book-form",
            changes: { fields: ["title", "status", "finished_at"] },
          },
        ],
      },
      {
        diff_id: "book-0003",
        intent: "感想を書き留めておきたいので、1冊ずつ中身を開いて読める画面がほしい",
        operations: [
          {
            op: "add_field",
            table: "books",
            field: { id: "note", name: "感想", type: "long_text" },
          },
          {
            op: "add_view",
            view: { id: "book-detail", type: "detail_view", table: "books" },
          },
        ],
      },
    ],
  },
  {
    app_id: "stock-keeper",
    name: "在庫管理",
    diffs: [
      {
        diff_id: "stock-0001",
        intent: "備品の在庫数を把握したい。品名と数量が分かるところから始める",
        operations: [
          {
            op: "add_table",
            table: {
              id: "items",
              name: "備品",
              fields: [
                { id: "item_name", name: "品名", type: "text", required: true },
                { id: "quantity", name: "数量", type: "number", required: true },
              ],
            },
          },
          {
            op: "add_view",
            view: {
              id: "item-list",
              type: "list_view",
              table: "items",
              columns: ["item_name", "quantity"],
            },
          },
          {
            op: "add_view",
            view: {
              id: "item-form",
              type: "form",
              table: "items",
              fields: ["item_name", "quantity"],
            },
          },
        ],
      },
      {
        diff_id: "stock-0002",
        intent:
          "発注済みかどうかが分からないと二重発注してしまう。発注状況と最終棚卸日を持たせたい",
        operations: [
          {
            op: "add_field",
            table: "items",
            field: {
              id: "order_state",
              name: "発注状況",
              type: "select",
              options: ["在庫あり", "発注中", "欠品"],
            },
          },
          {
            op: "add_field",
            table: "items",
            field: { id: "counted_on", name: "最終棚卸日", type: "date" },
          },
          {
            op: "update_view",
            view: "item-list",
            changes: {
              columns: ["item_name", "quantity", "order_state", "counted_on"],
              sort: { field: "counted_on", order: "desc" },
            },
          },
        ],
      },
      {
        diff_id: "stock-0003",
        intent: "欠品しているものだけを先に見たい。一覧を欠品で絞った画面を別に用意する",
        operations: [
          {
            op: "add_view",
            view: {
              id: "shortage-list",
              type: "list_view",
              table: "items",
              columns: ["item_name", "quantity", "counted_on"],
              filter: [{ field: "order_state", equals: "欠品" }],
            },
          },
          {
            op: "add_view",
            view: { id: "item-detail", type: "detail_view", table: "items" },
          },
        ],
      },
    ],
  },
];

/** 種を1つ蒔く。失敗は握り潰さず例外にする(中途半端な事前状態のほうが有害)。 */
export function seedApp(dataRoot: string, seed: SeedApp): void {
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, seed.name, { app_id: seed.app_id });
  } finally {
    store.close();
  }
  for (const diff of seed.diffs) {
    const result = applyDiff(dataRoot, seed.app_id, diff);
    if (!result.valid) {
      throw new Error(
        `種 "${seed.app_id}" の差分 ${diff.diff_id} が適用できません:\n` +
          JSON.stringify(result.errors, null, 2),
      );
    }
  }
}

/** データルートに既に登録済みのアプリがあるか。 */
export function existingAppIds(dataRoot: string): string[] {
  if (!existsSync(dataRoot)) {
    return [];
  }
  const store = KernelMetaStore.open(dataRoot);
  try {
    return store.listApps().map((app) => app.app_id);
  } finally {
    store.close();
  }
}

/**
 * 種を全部蒔く。
 *
 * `data-` 始まりのデータルートしか受け付けない(README 前提条件4 と同じ理由:
 * `.gitignore` が `data-` 始まりのディレクトリを外しているので、評価データが誤ってコミットされない)。
 */
export function seedAll(dataRoot: string, options: { force?: boolean } = {}): string[] {
  const existing = existingAppIds(dataRoot);
  if (existing.length > 0) {
    if (options.force !== true) {
      throw new Error(
        `データルート "${dataRoot}" には既にアプリがあります(${existing.join(", ")})。` +
          `同じ diff_id を二度は適用できないため、追い蒔きはしません。` +
          `最初からやり直すなら --force を付けてください(データルートごと消します)。`,
      );
    }
    rmSync(dataRoot, { recursive: true, force: true });
  }
  for (const seed of SEED_APPS) {
    seedApp(dataRoot, seed);
  }
  return SEED_APPS.map((seed) => seed.app_id);
}

// --- CLI ---------------------------------------------------------------------

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };
  const dataRootArg = flag("data-root") ?? process.env.ST_DATA_ROOT ?? "data-cp6";
  if (!/^data-.+/.test(dataRootArg)) {
    throw new Error(
      `評価用データルートは "data-" で始まる名前にしてください(指定: "${dataRootArg}")。` +
        `リポジトリの data/ を汚さないためです。`,
    );
  }
  const dataRoot = resolve(process.cwd(), dataRootArg);
  const created = seedAll(dataRoot, { force: argv.includes("--force") });
  console.log(`seeded ${created.length} apps into ${dataRoot}: ${created.join(", ")}`);
  for (const id of created) {
    const seed = SEED_APPS.find((s) => s.app_id === id);
    console.log(`  ${id}: ${seed?.diffs.length ?? 0} diffs`);
  }
}
