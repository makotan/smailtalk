/**
 * 自動処理が「誰の行として書くか」を宣言する —— `$defs/workflow` の6キー目(`act_as`)
 * (`V4-M10-T09` / `T10`。**`ADR-0079` = `V4-M7` 単位5 の限定採用。限定表11点**)。
 *
 * 目的(`ADR-0079` §S1 逐語): **「受信起点や時刻起点のように操作者が特定できない自動処理
 * からでも、その処理が扱っている行の持ち主として、個人に紐づく行を正しく書けるようにしたい。
 * 誰の代わりに書いたかは記録に残したい。」**
 *
 * **この検査が固定するのは限定表の内側だけである**(`docs/adr/0079-workflow-act-as-owner.md` §3):
 *
 * | 限定 | ここで固定するもの |
 * |---|---|
 * | 1 | 足すキーは `$defs/workflow` に1本だけ(5 → 6)。`$defs` 28 を1つも増やさない |
 * | 2 | **値域は `$record.<参照フィールドID>` の1形だけ**。任意のユーザ id も固定 actor も書けない |
 * | 3 | **辿るのは1ホップだけ**(2ホップの宣言は schema が弾く) |
 * | 4 | **辿れないときは今日どおり `no_actor` で fail-closed**(3通り) |
 * | 5 | `isAllowedOwnerUpdate` の付け替え禁止を1バイトも緩めない |
 * | 8 | **代理で書いた事実を `_auth_activity` に残す**(列を1本も足さない) |
 * | 10 | **島が actor を選べる形にしない**(島が返した `st_owner` は今日どおり無視される) |
 *
 * ## この検査が言わないこと(誇張しない)
 *
 * - **(A) 側(逆仕訳の自動処理)は1ミリも進まない**(§限界1)。
 *   **【禁止】「決済失敗でポイントが戻るようになった」と書かない。**
 * - **行選択の無い `schedule` では今日と1ミリも変わらない**(§限界2)。
 * - **受信 capability の経路が `judgeOwnerScopedOp` を1度も通らない穴は今日も開いたまま**(§限界3)。
 * - **`ActivityRecord.changes` は作成に持たないので「何を書いたか」は残らない**(§限界4)。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armManifestForAutomation,
  fixtureOwnerValues,
  seedAutomationActor,
} from "./automation-actor-fixture.test.ts";
import { applyManifest as applyManifestRaw, createApp, KernelMetaStore } from "./index.ts";
import { ensureIslandRuntimeReady } from "./island-runner.ts";
import { createRecord as createRecordRaw, listRecords } from "./records.ts";
import { appDbPath } from "./storage-paths.ts";
import type { Manifest } from "./types.ts";

/*
 * --- **【`V8-M26`(2026-08-10)で題材に「壁を開ける下ごしらえ」が入った】** -------------
 *
 * **`V8-M26-T03` が面(役割に束ねた権限)の既定を「閉じる」側へ倒したので、
 * ワークフロー・島の書込が題材ごと止まった。** **本ファイルの主題は面ではないので、
 * 題材の側で壁を開ける** —— **実装は1バイトも緩めていない。**
 * **中身は `src/kernel/automation-actor-fixture.test.ts` の doc に全部書いた。**
 */

/** マニフェストを投入する直前に壁を開け、投入した直後に書き手を1人立てる。 */
function applyManifest(
  root: string,
  appId: string,
  target: Manifest,
): ReturnType<typeof applyManifestRaw> {
  armManifestForAutomation(target);
  const applied = applyManifestRaw(root, appId, target);
  if (applied.valid) {
    const database = new Database(appDbPath(root, appId), { readwrite: true, create: false });
    try {
      seedAutomationActor(database);
    } finally {
      database.close();
    }
  }
  return applied;
}

/**
 * 行を作る(**下ごしらえが持ち主の列を足した表にだけ書き手を入れる**)。
 *
 * **題材が明示した持ち主(`row-owner` など)は、その場で `owner` として登録する** ——
 * **登録しないと面から見て未ログインと同じ主体になり、この題材のどのテーブルにも書けない。**
 */
function createRecord(
  database: Database,
  target: Manifest,
  tableId: string,
  values: Record<string, unknown>,
): ReturnType<typeof createRecordRaw> {
  const declared = values.st_owner;
  if (typeof declared === "string" && declared !== "") {
    seedAutomationActor(database, declared);
  }
  return createRecordRaw(database, target, tableId, fixtureOwnerValues(target, tableId, values));
}

const MANIFEST_SCHEMA_FILE = join(import.meta.dir, "..", "..", "schemas", "manifest.schema.json");

function schema(): { $defs: Record<string, { properties?: Record<string, unknown> }> } {
  return JSON.parse(readFileSync(MANIFEST_SCHEMA_FILE, "utf-8")) as {
    $defs: Record<string, { properties?: Record<string, unknown> }>;
  };
}

// --- (a) 増分の総量(限定1 / 限定2)----------------------------------------------------

test("限定1: $defs/workflow.properties が 6キーで、6キー目は act_as である", () => {
  const keys = Object.keys(schema().$defs.workflow?.properties ?? {});
  expect(keys).toHaveLength(6);
  expect(keys).toContain("act_as");
});

// 【`V5-M29-T04` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
//   消したテスト名(逐語): 「限定1: $defs の本数は 28 のまま(新しい $defs を1つも作らない)」
//   そのブロックが測っていたもの:
//     - 限定1: $defs の本数は 28 のまま(新しい $defs を1つも作らない)
//   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `manifest.$defs:` で始まる行)。
//   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
//   検出力0のまま `Ran` を水増しする)。
//   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。

test("限定2 / 限定3: 値域は $record.<単一フィールドID> の1形に pattern で閉じている", () => {
  const actAs = schema().$defs.workflow?.properties?.act_as as { pattern?: string };
  const re = new RegExp(actAs.pattern as string);
  // 書ける形は1つだけ。
  expect(re.test("$record.order")).toBe(true);
  // **任意のユーザ id / 固定 actor / 2ホップ / `_id` は1つも書けない。**
  expect(re.test("u-12345")).toBe(false);
  expect(re.test("system:inbound")).toBe(false);
  expect(re.test("$record.order.customer")).toBe(false);
  expect(re.test("$record._id")).toBe(false);
  expect(re.test("$user.id")).toBe(false);
  expect(re.test("")).toBe(false);
});

// --- 本物の SQLite でのふるまい ---------------------------------------------------------

const APP_ID = "act-as-app";

/**
 * `E-G41` と同じ形:`payment_event`(`st_owner` を持たない)の作成をトリガーに、
 * 島が `point_ledger`(個人所有)へ create op を返す。
 */
function manifest(actAs?: string): Manifest {
  const workflow: Record<string, unknown> = {
    id: "grant-points",
    name: "決済イベントからポイントを積む",
    trigger: { type: "on_create", table: "payment_event" },
    history_table: "wf_history",
    actions: [
      {
        action: "run_function",
        function: "grant",
        write_ops: true,
      },
    ],
  };
  if (actAs !== undefined) {
    workflow.act_as = actAs;
  }
  return {
    app: {
      id: APP_ID,
      name: "代理書込",
      tables: [
        {
          id: "orders",
          name: "注文",
          fields: [
            { id: "item", name: "品目", type: "text" },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
        {
          id: "shared_orders",
          name: "共有注文",
          fields: [{ id: "item", name: "品目", type: "text" }],
        },
        {
          id: "payment_event",
          name: "決済イベント",
          fields: [
            { id: "amount", name: "金額", type: "number" },
            { id: "order", name: "注文", type: "reference", reference_table: "orders" },
            { id: "shared", name: "共有注文", type: "reference", reference_table: "shared_orders" },
            { id: "note", name: "メモ", type: "text" },
          ],
        },
        {
          id: "point_ledger",
          name: "ポイント台帳",
          fields: [
            { id: "points", name: "点数", type: "number" },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
        {
          id: "wf_history",
          name: "実行履歴",
          fields: [
            { id: "ran_at", name: "実行時刻", type: "date" },
            { id: "workflow", name: "ワークフロー", type: "text" },
            { id: "trigger_type", name: "起点", type: "text" },
            { id: "status", name: "結果", type: "text" },
            { id: "error", name: "詳細", type: "long_text" },
          ],
        },
      ],
      views: [{ id: "ledger-list", type: "list_view", table: "point_ledger", columns: ["points"] }],
      functions: [
        {
          id: "grant",
          name: "ポイントを積む",
          // **島は actor を1文字も選べない**(限定10)—— ここで `st_owner` を書いても
          // 呼び出し側の判定が上書きする(`judgeOwnerScopedOp` の create 枝)。
          code: 'export default function () { return [{ op: "create", table: "point_ledger", values: { points: 10, st_owner: "someone-else" } }]; }',
          input: { source: "record" },
          output: { ops: true },
        },
      ],
      workflows: [workflow as never],
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let db: Database;

beforeEach(async () => {
  await ensureIslandRuntimeReady();
  dataRoot = await mkdtemp(join(tmpdir(), "gp-actas-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "代理書込", { app_id: APP_ID });
  } finally {
    store.close();
  }
});

afterEach(async () => {
  db?.close();
  await rm(dataRoot, { recursive: true, force: true });
});

function setup(actAs?: string): Manifest {
  const m = manifest(actAs);
  expect(applyManifest(dataRoot, APP_ID, m).valid).toBe(true);
  db = new Database(join(dataRoot, "apps", APP_ID, "app.sqlite"));
  return m;
}

function ledgerRows(m: Manifest): Record<string, unknown>[] {
  const result = listRecords(db, m, "point_ledger", {});
  expect(result.ok).toBe(true);
  return result.ok ? (result.value as unknown as Record<string, unknown>[]) : [];
}

function historyDetail(m: Manifest): string {
  const result = listRecords(db, m, "wf_history", {});
  expect(result.ok).toBe(true);
  const rows = result.ok ? (result.value as unknown as Record<string, unknown>[]) : [];
  return rows.map((row) => `${String(row.status)}:${String(row.error)}`).join(" | ");
}

// --- (b) 宣言が無いときは今日どおり(後方互換 + `E-G41` の再現)---------------------------

test("宣言が無ければ今日どおり fail-closed —— st_owner を持たない表からの発火では書けない", () => {
  const m = setup();
  const order = createRecord(db, m, "orders", { item: "本", st_owner: "u1" });
  expect(order.ok).toBe(true);
  if (!order.ok) return;
  // **【`V8-M26`(2026-08-10)】持ち主を空文字で明示する。**
  // **この題材は下ごしらえが `payment_event` に持ち主の列を足すので、何も書かないと
  //   下ごしらえが書き手を入れてしまい、「持ち主を持たない表からの発火」という前提が消える。**
  createRecord(db, m, "payment_event", {
    amount: 100,
    order: order.value._id as string,
    st_owner: "",
  });
  // **1行も書かれていない**(`E-G41` の症状そのもの)。
  expect(ledgerRows(m)).toHaveLength(0);
  expect(historyDetail(m)).toContain("所有者を決められるレコードがありません");
});

// --- (c) 宣言があれば1ホップで導ける(**これが目的である**)-----------------------------

test("act_as: $record.<参照> —— 参照先の行の持ち主として書ける", () => {
  const m = setup("$record.order");
  const order = createRecord(db, m, "orders", { item: "本", st_owner: "u1" });
  expect(order.ok).toBe(true);
  if (!order.ok) return;
  createRecord(db, m, "payment_event", { amount: 100, order: order.value._id as string });
  const rows = ledgerRows(m);
  expect(rows).toHaveLength(1);
  // **島が返した `st_owner: "someone-else"` は無視され、導いた持ち主で上書きされる**(限定10)。
  expect(rows[0]?.st_owner).toBe("u1");
});

// --- (d) 限定4: 辿れないときは今日どおり fail-closed(3通り)-----------------------------

test("限定4: 参照が空なら書けない", () => {
  const m = setup("$record.order");
  createRecord(db, m, "payment_event", { amount: 100 });
  expect(ledgerRows(m)).toHaveLength(0);
});

test("限定4: 参照先の行が無ければ書けない", () => {
  const m = setup("$record.order");
  createRecord(db, m, "payment_event", {
    amount: 100,
    order: "00000000-0000-4000-8000-000000000000",
  });
  expect(ledgerRows(m)).toHaveLength(0);
});

test("限定4: 参照先に st_owner が無ければ書けない", () => {
  const m = setup("$record.shared");
  // **【`V8-M26`】参照先に持ち主が無いことが前提なので、空文字で明示する**(上と同じ理由)。
  const shared = createRecord(db, m, "shared_orders", { item: "共有", st_owner: "" });
  expect(shared.ok).toBe(true);
  if (!shared.ok) return;
  createRecord(db, m, "payment_event", {
    amount: 100,
    shared: shared.value._id as string,
    st_owner: "",
  });
  expect(ledgerRows(m)).toHaveLength(0);
});

test("限定4: 参照先の行の st_owner が空(共有行)なら書けない", () => {
  const m = setup("$record.order");
  const order = createRecord(db, m, "orders", { item: "共有の本" });
  expect(order.ok).toBe(true);
  if (!order.ok) return;
  createRecord(db, m, "payment_event", { amount: 100, order: order.value._id as string });
  expect(ledgerRows(m)).toHaveLength(0);
});

test("限定3 / 限定4: reference でないフィールドを指した宣言は効かない(fail-closed)", () => {
  // **schema の pattern は形しか見ない** —— 「reference 型か」は実行層が見る。
  // **別の意味に倒さない**(限定4)。
  const m = setup("$record.note");
  const order = createRecord(db, m, "orders", { item: "本", st_owner: "u1" });
  expect(order.ok).toBe(true);
  createRecord(db, m, "payment_event", { amount: 100, note: "u1" });
  expect(ledgerRows(m)).toHaveLength(0);
});

// --- (e) 限定8 / `V4-M10-T10`: 代理で書いた事実が `_auth_activity` に残る -----------------

test("限定8: 代理で書いた事実が _auth_activity に残る(列を1本も足していない)", () => {
  const m = setup("$record.order");
  const order = createRecord(db, m, "orders", { item: "本", st_owner: "u1" });
  expect(order.ok).toBe(true);
  if (!order.ok) return;
  createRecord(db, m, "payment_event", { amount: 100, order: order.value._id as string });

  const rows = db
    .query<
      {
        user_id: string;
        username: string;
        action: string;
        table_id: string;
        record_id: string | null;
        changes: string | null;
      },
      []
    >("SELECT user_id, username, action, table_id, record_id, changes FROM _auth_activity")
    .all();
  expect(rows).toHaveLength(1);
  // **誰の行として** —— 導いた持ち主。
  expect(rows[0]?.user_id).toBe("u1");
  // **どの自動処理が** —— ワークフローID(既存の列を使う。新しい列を足さない)。
  expect(rows[0]?.username).toBe("workflow:grant-points");
  // **どのテーブルの / どの行を。**
  expect(rows[0]?.action).toBe("create_record");
  expect(rows[0]?.table_id).toBe("point_ledger");
  expect(rows[0]?.record_id).toBe(ledgerRows(m)[0]?._id as string);
  // **`changes` は使わない**(`ActivityRecord.changes` の doc「更新以外は null」)。
  expect(rows[0]?.changes).toBeNull();
});

test("限定8: 書けなかったときは監査行を1行も残さない", () => {
  const m = setup("$record.order");
  // 参照が空 → 導けない → 1バイトも書かない。
  createRecord(db, m, "payment_event", { amount: 100 });
  // **`_auth_activity` はそもそも作られない** —— 監査の器を用意するのは、代理で書く
  // ことが決まったとき(`actorId !== null`)だけである。
  const exists = db
    .query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '_auth_activity'",
    )
    .get();
  expect(exists?.n).toBe(0);
});

test("限定8: _auth_activity に列を1本も足していない", () => {
  const m = setup("$record.order");
  const order = createRecord(db, m, "orders", { item: "本", st_owner: "u1" });
  expect(order.ok).toBe(true);
  if (!order.ok) return;
  createRecord(db, m, "payment_event", { amount: 100, order: order.value._id as string });
  const columns = db
    .query<{ name: string }, []>("PRAGMA table_info(_auth_activity)")
    .all()
    .map((row) => row.name)
    .sort();
  expect(columns).toEqual(
    ["id", "user_id", "username", "action", "table_id", "record_id", "at", "changes"].sort(),
  );
});
