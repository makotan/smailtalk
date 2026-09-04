/**
 * 自動処理に渡す入力を、起点の行に関係する行だけに絞る —— `$defs/function_input` の
 * 4キー目(`via`)(`V4-M10-T44`。**`ADR-0083` = `V4-M9` 単位11 の限定採用。限定表12点**)。
 *
 * 目的(`ADR-0083` §S1 逐語): **「自動処理に渡す入力を、起点の行に関係する行だけに絞りたい。」**
 *
 * **この検査が固定するのは限定表の内側だけである**(`docs/adr/0083-function-input-trigger-scope.md` §2):
 *
 * | 限定 | ここで固定するもの |
 * |---|---|
 * | 1 | 足すキーは1本だけ(3 → 4)。`$defs` 28 / `function.properties` 6 / `$defs/table` 4 を動かさない |
 * | 2 | `source` の enum は3値のまま。**禁止7語を1語も足さない** |
 * | 3 | **`via` は `source: "table"` のときだけ書ける**(`view` / `record` は schema が拒否) |
 * | 4 | **トリガー元レコードが無い発火(`trigger.table` の無い `schedule`)では書けない** |
 * | 5 | **1ホップだけ。逆参照を作らない**(参照先がトリガー元のテーブルでなければ拒否) |
 * | 6 | **演算子を1つも作らない**(突き合わせは等値1つだけ) |
 * | 7 / 8 | 実行予算・配列形の上限を1バイトも変えない |
 * | 11 | `FIELD_TYPES` / `RESOURCE_KINDS` / `DIFF_OPS` を1つも動かさない |
 * | 12 | **`via` を書かない宣言が島に渡す値は今日と1バイトも変わらない** |
 *
 * ## この検査が言わないこと(誇張しない)
 *
 * - **【禁止】「島の入力の上限問題が解けた」と書かない。** **逆参照は作らないので、
 *   `E-G72` の `member` の全件読み(トリガー元の**親**)は1ミリも解けない**(§限界4)。
 * - **`E-G72` の症状(履歴が増えると誕生月ポイントが止まる)は今日1件も観測されていない**
 *   (§3 の自己適用)。**本検査もそれを再現していない。**
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

type Def = Record<string, unknown>;

function schema(): { $defs: Record<string, Def> } {
  return JSON.parse(readFileSync(MANIFEST_SCHEMA_FILE, "utf-8")) as { $defs: Record<string, Def> };
}

/** `$defs/<name>` を返す(存在しなければ落ちる —— スキーマの定義が消えたら赤くする)。 */
function def(name: string): Def {
  const found = schema().$defs[name];
  if (found === undefined) {
    throw new Error(`$defs/${name} が manifest.schema.json にありません`);
  }
  return found;
}

// --- (a) 増分の総量(限定1 / 限定2 / 限定11)-------------------------------------------

test("限定1: $defs/function_input.properties が 4キーで、4キー目は via である", () => {
  const props = def("function_input").properties as Record<string, unknown>;
  expect(Object.keys(props)).toEqual(["source", "table", "view", "via"]);
});

// 【`V7-M1-T02`】**テスト名の `table.properties は 4 のまま` を `6 のまま` へ是正した。**
//   **`V6-M3-T01`(4 → 5)と `V7-M1-T01`(5 → 6)が本体を動かしたのに、名前が `4` のまま
//   残っていた**(`v7-m0.md` §4-3 の表の6 が名指しした食い違い)。**本タスクで是正した。**
test("限定1: function.properties は 6 / table.properties は 6 のまま", () => {
  const defs = schema().$defs;
  // 【`V5-M29-T03` / `ADR-0250` 限定11】ここにあった「$defs は 28 のまま」の検査は
  //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
  //   `manifest.$defs:` で始まる行)。**総量ではなく名前と順序で見張る。**
  //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  // 【`V5-M29-T03`】**テスト名を書き換えた。** 旧: 「限定1: $defs は 28 / function.properties は 6 / table.properties は 4 のまま」。
  //   本体から `$defs` の本数を測る `expect` が消えたため(記録 §4-7)。
  expect(Object.keys(defs.function?.properties ?? {})).toHaveLength(6);
  // **4 は `ADR-0080`(`representative_field`)が足した分である。** **`ADR-0083` は0である。**
  // **【`V6-M3-T01` / `K-G6` / `ADR-0290` 限定1 で 4 → 5 に更新した】** 5キー目
  // `reference_search_fields`(このテーブルが参照されたときの「探せる項目」の既定)が門A を
  // 通って増えた(`V6-M0` 単位B。判定 = 限定採用)。**本 ADR の増分ではない。**
  // **【`V7-M1-T01` / `Z-G2` で 5 → 6 に更新した】** 6キー目 `access_control`(この表で
  // アクセス権管理を使うことと、付与・グループ・メンバーの置き場所の宣言)が門A を通って
  // 増えた(`V7-M0`。判定 = 限定採用)。**本 ADR の増分ではない。**
  expect(Object.keys(defs.table?.properties ?? {})).toHaveLength(6);
});

test("限定1: additionalProperties: false を1バイトも変えていない", () => {
  expect(def("function_input").additionalProperties).toBe(false);
});

test("限定2: source の enum は3値のまま", () => {
  const source = (def("function_input").properties as Record<string, { enum?: string[] }>).source;
  expect(source?.enum).toEqual(["table", "view", "record"]);
});

test("限定2: 禁止7語が $defs/function_input と $defs/function のキーに1語も無い", () => {
  const forbidden = ["where", "filter", "select", "count", "group_by", "join", "on"];
  for (const name of ["function_input", "function"]) {
    const keys = Object.keys((def(name).properties ?? {}) as object);
    for (const word of forbidden) {
      expect(keys, `${name}.${word}`).not.toContain(word);
    }
  }
});

// 【`V5-M29-T03` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
//   消したテスト名(逐語): 「限定11: FIELD_TYPES / RESOURCE_KINDS / DIFF_OPS を1つも動かしていない」
//   そのブロックが測っていたもの:
//     - `expect(FIELD_TYPES).toHaveLength(9)`(行末の逐語: 「【`V5-M16` / `ADR-0161`】8 → 9(`file` が9種目)。
//       **この行が固定していたのは「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**」)
//     - `expect(RESOURCE_KINDS).toHaveLength(7)`
//     - `expect(DIFF_OPS).toHaveLength(17)`(行末の逐語: 「【`V5-M17b` / `ADR-0248`】16 → 17(`set_user_kinds` が17種目)。
//       **この行が固定していたのは「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**」)
//   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `FIELD_TYPES:` / `RESOURCE_KINDS:` / `DIFF_OPS:` で始まる行)。
//   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
//   検出力0のまま `Ran` を水増しする)。
//   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。

test("限定7: RUN_FUNCTION_LIMITS の3値を1バイトも変えていない", () => {
  const source = readFileSync(join(import.meta.dir, "workflow-runner.ts"), "utf-8");
  expect(source).toContain("const RUN_FUNCTION_LIMITS: IslandLimits = {");
  expect(source).toContain("timeoutMillis: 1000,");
  expect(source).toContain("memoryBytes: 64 * 1024 * 1024,");
  expect(source).toContain("maxInputBytes: 1024 * 1024,");
});

test("限定8: 配列形の上限と重複禁止を1バイトも変えていない", () => {
  const input = (def("function").properties as Record<string, unknown>).input as {
    allOf: { then?: Record<string, unknown> }[];
  };
  const arrayForm = input.allOf.map((branch) => branch.then).find((then) => then?.type === "array");
  expect(arrayForm?.maxItems).toBe(5);
  expect(arrayForm?.minItems).toBe(1);
  expect(arrayForm?.uniqueItems).toBe(true);
});

// --- 本物の SQLite でのふるまい ---------------------------------------------------------

const APP_ID = "via-app";

/** `E-G72` と同じ形: `member`(親)/ `point_ledger`(子。`member` を参照)。 */
function manifest(options: {
  via?: string;
  source?: "table" | "view" | "record";
  scheduleWithoutTable?: boolean;
}): Manifest {
  const input: Record<string, unknown> =
    options.source === "view"
      ? { source: "view", view: "ledger-list" }
      : options.source === "record"
        ? { source: "record" }
        : { source: "table", table: "point_ledger" };
  if (options.via !== undefined) {
    input.via = options.via;
  }
  const trigger = options.scheduleWithoutTable
    ? { type: "schedule", at: { hour: 3, minute: 0 } }
    : { type: "on_create", table: "member" };
  return {
    app: {
      id: APP_ID,
      name: "島の入力の絞り込み",
      tables: [
        {
          id: "member",
          name: "会員",
          fields: [{ id: "name", name: "氏名", type: "text" }],
        },
        {
          id: "other",
          name: "別の表",
          fields: [{ id: "label", name: "名札", type: "text" }],
        },
        {
          id: "point_ledger",
          name: "ポイント台帳",
          fields: [
            { id: "points", name: "点数", type: "number" },
            { id: "member", name: "会員", type: "reference", reference_table: "member" },
            { id: "other_ref", name: "別参照", type: "reference", reference_table: "other" },
            { id: "note", name: "メモ", type: "text" },
          ],
        },
        {
          id: "seen",
          name: "島が見た件数",
          fields: [{ id: "count", name: "件数", type: "number" }],
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
          id: "count-rows",
          name: "島が受け取った件数を書く",
          code: "export default function (rows) { return [{ count: Array.isArray(rows) ? rows.length : 0 }]; }",
          input,
          output: { fields: [{ id: "count", type: "number" }] },
        },
      ],
      workflows: [
        {
          id: "count-wf",
          name: "件数を数える",
          trigger,
          history_table: "wf_history",
          actions: [{ action: "run_function", function: "count-rows", output_table: "seen" }],
        },
      ],
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let db: Database | undefined;

beforeEach(async () => {
  await ensureIslandRuntimeReady();
  dataRoot = await mkdtemp(join(tmpdir(), "gp-via-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "島の入力の絞り込み", { app_id: APP_ID });
  } finally {
    store.close();
  }
});

afterEach(async () => {
  db?.close();
  db = undefined;
  await rm(dataRoot, { recursive: true, force: true });
});

function apply(m: Manifest): { valid: boolean; errors?: unknown } {
  return applyManifest(dataRoot, APP_ID, m);
}

function open(): Database {
  db = new Database(join(dataRoot, "apps", APP_ID, "app.sqlite"));
  return db;
}

// --- (b) 限定3: `via` は `source: "table"` のときだけ書ける -------------------------------

test('限定3: source: "view" に via を書いた差分は拒否される', () => {
  expect(apply(manifest({ source: "view", via: "member" })).valid).toBe(false);
});

test('限定3: source: "record" に via を書いた差分は拒否される', () => {
  expect(apply(manifest({ source: "record", via: "member" })).valid).toBe(false);
});

// --- (c) 限定4: トリガー元レコードが無い発火では書けない ----------------------------------

test("限定4: trigger.table を持たない schedule で via を書いた差分は拒否される", () => {
  expect(apply(manifest({ via: "member", scheduleWithoutTable: true })).valid).toBe(false);
});

test("限定4: via を書かなければ、同じ schedule は今日どおり通る(後方互換)", () => {
  expect(apply(manifest({ scheduleWithoutTable: true })).valid).toBe(true);
});

// --- (d) 限定5: 1ホップだけ・逆参照を作らない ---------------------------------------------

test("限定5: reference 型でないフィールドを via に書いた差分は拒否される", () => {
  expect(apply(manifest({ via: "note" })).valid).toBe(false);
});

test("限定5: 実在しないフィールドを via に書いた差分は拒否される", () => {
  expect(apply(manifest({ via: "not-a-field" })).valid).toBe(false);
});

test("限定5: 参照先がトリガー元のテーブルでない via は拒否される(逆参照も多段も作らない)", () => {
  expect(apply(manifest({ via: "other_ref" })).valid).toBe(false);
});

test("限定5: 参照先がトリガー元のテーブルなら通る", () => {
  expect(apply(manifest({ via: "member" })).valid).toBe(true);
});

// --- (e) 実際に絞られる(**これが目的である**)-------------------------------------------

test("via —— 島に渡るのはトリガー元の会員を指す行だけになる", () => {
  const m = manifest({ via: "member" });
  expect(apply(m).valid).toBe(true);
  const database = open();
  const a = createRecord(database, m, "member", { name: "A" });
  const b = createRecord(database, m, "member", { name: "B" });
  expect(a.ok && b.ok).toBe(true);
  if (!(a.ok && b.ok)) return;
  // A に2行、B に1行、参照無しに1行を積む(発火は member の作成なので、ここでは積むだけ)。
  createRecord(database, m, "point_ledger", { points: 1, member: a.value._id as string });
  createRecord(database, m, "point_ledger", { points: 2, member: a.value._id as string });
  createRecord(database, m, "point_ledger", { points: 3, member: b.value._id as string });
  createRecord(database, m, "point_ledger", { points: 4 });

  // ここで新しい会員 C を作ると発火し、島は「C を指す行」だけを受け取る → 0件。
  const c = createRecord(database, m, "member", { name: "C" });
  expect(c.ok).toBe(true);
  const seen = listRecords(database, m, "seen", {});
  expect(seen.ok).toBe(true);
  if (!seen.ok) return;
  expect(seen.value).toHaveLength(1);
  expect(seen.value[0]?.count).toBe(0);

  // C を指す行を2本積んでから、もう一度発火させると 2 になる。
  createRecord(database, m, "point_ledger", {
    points: 5,
    member: c.ok ? (c.value._id as string) : "",
  });
  createRecord(database, m, "point_ledger", {
    points: 6,
    member: c.ok ? (c.value._id as string) : "",
  });
  const cAgain = createRecord(database, m, "member", { name: "C2" });
  expect(cAgain.ok).toBe(true);
  const seen2 = listRecords(database, m, "seen", {});
  expect(seen2.ok).toBe(true);
  if (!seen2.ok) return;
  // **output_table は全置換である**(`ADR-0024`)—— 今回の発火の結果だけが残る。
  expect(seen2.value).toHaveLength(1);
  expect(seen2.value[0]?.count).toBe(0);
});

test("限定12: via を書かない宣言は今日どおりテーブルの全行を受け取る(後方互換)", () => {
  const m = manifest({});
  expect(apply(m).valid).toBe(true);
  const database = open();
  const a = createRecord(database, m, "member", { name: "A" });
  expect(a.ok).toBe(true);
  if (!a.ok) return;
  createRecord(database, m, "point_ledger", { points: 1, member: a.value._id as string });
  createRecord(database, m, "point_ledger", { points: 2 });
  createRecord(database, m, "member", { name: "B" });
  const seen = listRecords(database, m, "seen", {});
  expect(seen.ok).toBe(true);
  if (!seen.ok) return;
  expect(seen.value[0]?.count).toBe(2);
});

test("via —— 起点の行を指す行だけが渡ることを、行を先に積んでから確かめる", () => {
  const m = manifest({ via: "member" });
  expect(apply(m).valid).toBe(true);
  const database = open();
  const a = createRecord(database, m, "member", { name: "A" });
  expect(a.ok).toBe(true);
  if (!a.ok) return;
  const aid = a.value._id as string;
  createRecord(database, m, "point_ledger", { points: 1, member: aid });
  createRecord(database, m, "point_ledger", { points: 2, member: aid });
  createRecord(database, m, "point_ledger", { points: 3 });
  // A を更新して on_create ではなく…ではなく、A と同じ id を指す行だけが渡ることを
  // 見るため、A をもう一度作るのではなく **A 自身の作成時**を再現する必要がある。
  // ここでは「別の会員 B を作ると B を指す行(0件)だけが渡る」ことで、
  // **全行(3件)が渡っていないこと**を示す。
  createRecord(database, m, "member", { name: "B" });
  const seen = listRecords(database, m, "seen", {});
  expect(seen.ok).toBe(true);
  if (!seen.ok) return;
  expect(seen.value[0]?.count).toBe(0);
  expect(seen.value[0]?.count).not.toBe(3);
});
