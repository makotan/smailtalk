/**
 * **配布物のイメージを組むための、その場で作る1アプリ**(`V5-M7-T01`)。
 *
 * ## なぜ要るのか(**丸めない**)
 *
 * **今日ディスクにある実アプリは、1つもイメージに載せられない。**
 * `ADR-0251` 限定6 が「印の無い DB(`user_version = 0`)を救済しない」と定めており、
 * **`V5-M5` より前に作られた `app.sqlite` はすべて `user_version = 0` である。**
 * 2026-08-06 に実測した:メイン作業ツリーの唯一の実アプリ `tokiwa` を
 * `scripts/build-runner-data.ts` に通した出力を版のゲートに掛けると
 * `apps/tokiwa/app.sqlite: user_version = 0` で止まる(実測は
 * `docs/plan/v5/records/v5-m7.md` §1)。
 *
 * **したがって「配れる器」を今日組むには、今日のコードで作った(= 印のある)アプリが要る。**
 * ここはそれを作るだけの器であって、**配布の題材そのものに意味は無い。**
 *
 * ## この器が作るもの
 *
 * テーブル1件(`items`)/ 一覧・入力・詳細の3画面 / レコード3件。
 * **カーネルの本物の経路(`createApp` / `applyDiff` / `createRecord`)を通る** ——
 * `applyManifest` で直接書き込む近道を取らない(changelog に載らない。`ADR-0006`)。
 *
 * ## この器が作らないもの
 *
 * - **利用者アカウントを1件も作らない。** 配った先で最初に登録した人が owner になる
 *   (`ADR-0014`)。**AI が先に作ると持ち主が管理者になれない。**
 * - **決定論を主張しない。** `_id` は `crypto.randomUUID()`、`applied_at` は実時刻である。
 *
 * ## 使い方
 *
 * ```
 * mise exec -- bun run scripts/runner-image/seed-demo-app.ts <出力先のdata> [app_id]
 * ```
 */
import { Database } from "bun:sqlite";
import { applyDiff } from "../../src/kernel/apply-diff.ts";
import { readCurrentManifest } from "../../src/kernel/apply-manifest.ts";
import { createApp } from "../../src/kernel/create-app.ts";
import { KernelMetaStore } from "../../src/kernel/meta-store.ts";
import { createRecord } from "../../src/kernel/records.ts";
import { appDbPath } from "../../src/kernel/storage-paths.ts";
import type { Diff } from "../../src/kernel/types.ts";

/** 既定のアプリID。`--app` で差し替えられる。 */
export const DEMO_APP_ID = "runner-demo";
/** 既定のアプリ表示名。 */
export const DEMO_APP_NAME = "配布物の見本";

/** 1本だけ流す差分。**画面3種を1回で入れる。** */
const DEMO_DIFF: Diff = {
  diff_id: "d-runner-demo-001",
  intent: "配る器の見本として、品物の台帳と一覧・入力・詳細の画面がほしいです",
  operations: [
    {
      op: "add_table",
      table: {
        id: "items",
        name: "品物",
        fields: [
          { id: "title", name: "名前", type: "text", required: true },
          { id: "memo", name: "メモ", type: "long_text" },
          { id: "count", name: "個数", type: "number" },
        ],
      },
    },
    {
      op: "add_view",
      view: {
        id: "item-list",
        type: "list_view",
        table: "items",
        name: "品物の一覧",
        columns: ["title", "count"],
      },
    },
    {
      op: "add_view",
      view: {
        id: "item-form",
        type: "form",
        table: "items",
        name: "品物の入力",
        fields: ["title", "memo", "count"],
      },
    },
    {
      op: "add_view",
      view: {
        id: "item-detail",
        type: "detail_view",
        table: "items",
        name: "品物の詳細",
        fields: ["title", "memo", "count"],
      },
    },
  ],
};

/** 入れるレコード。**3件だけである。** */
const DEMO_ROWS: readonly Record<string, unknown>[] = [
  { title: "ねじ", memo: "M4 の六角穴付き", count: 120 },
  { title: "座金", memo: "内径 4mm", count: 400 },
  { title: "工具箱", memo: "上段が空いている", count: 2 },
];

export type SeedDemoAppResult = {
  appId: string;
  dataRoot: string;
  /** 入れたレコード件数。 */
  rows: number;
};

/** 見本のアプリを1件作る。**出力先に同じ `app_id` が既に在れば throw する。** */
export function seedDemoApp(dataRoot: string, appId: string = DEMO_APP_ID): SeedDemoAppResult {
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, DEMO_APP_NAME, { app_id: appId });
  } finally {
    store.close();
  }

  const applied = applyDiff(dataRoot, appId, DEMO_DIFF);
  if (!applied.valid) {
    throw new Error(`見本のアプリの差分が通りませんでした: ${JSON.stringify(applied.errors)}`);
  }

  const manifest = readCurrentManifest(dataRoot, appId);
  const db = new Database(appDbPath(dataRoot, appId));
  try {
    for (const row of DEMO_ROWS) {
      const result = createRecord(db, manifest, "items", row);
      if (!result.ok) {
        throw new Error(`見本のレコードが入りませんでした: ${JSON.stringify(result.errors)}`);
      }
    }
  } finally {
    db.close();
  }

  return { appId, dataRoot, rows: DEMO_ROWS.length };
}

if (import.meta.main) {
  const [dataRoot, appId] = process.argv.slice(2);
  if (dataRoot === undefined) {
    console.error("使い方: bun run scripts/runner-image/seed-demo-app.ts <出力先のdata> [app_id]");
    process.exit(2);
  }
  console.log(JSON.stringify(seedDemoApp(dataRoot, appId ?? DEMO_APP_ID), null, 2));
}
