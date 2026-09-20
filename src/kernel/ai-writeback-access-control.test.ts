/**
 * **`V17-M3-T03a` / `AC-G13`(2) —— AI の書き戻しに判定が1つも無いことを、実行で撃つ。**
 *
 * ## この検査が測る1本の線
 *
 * **`src/kernel/ai-dispatcher.ts` の `writeBack` は、本命(AI 出力)とフォールバックの
 * **2つ**の書き込み口を持つ。** **起票 `V17-M3-T03` の逐語は「**両方**が同じ判定を通り、
 * **AI が失敗したときの書き戻しも止まる**こと」である。**
 * **したがって本ファイルは、同じ題材を provider の返り値だけ変えて2度撃つ**:
 *
 *  - **本命の口** … provider が選択肢どおりの値を返す(1度目の `updateRecord` が通る)。
 *  - **フォールバックの口** … provider が選択肢に無い値を返す(1度目が拒否され、
 *    2度目の `updateRecord` = フォールバックへ落ちる)。
 *
 * ## **本物の推論は1度も呼ばない**
 *
 * **`dispatchAiJobs` は provider を引数で受ける**(`ai-transform.test.ts` と同じ注入口)。
 * **本ファイルはスパイを渡すだけで、実 CLI にも実ネットワークにも1バイトも触らない。**
 * **`ai_capabilities` の行は `AiCapabilityStore` の公開 API で作る**(`kernel.sqlite` へ
 * 直に INSERT する必要は無かった —— **`docs/plan/v16/records/investigation-b1-unmeasured-writes.md`
 * の穴2 が採った形より1段素直である)。
 *
 * ## 題材(**面だけで組んだ。点も個人所有も1つも使っていない**)
 *
 * **`stranger` は `tickets` を1件も読めず1件も書けない相手である**(役割 `viewer` に
 * `tickets` の規則を1本も書いていない = `V8-M26` 以降の既定は閉じている)。
 * **その `stranger` が書き手として積んだジョブが、`member` の行を書き換えられるか**を問う。
 *
 * ## **この検査が測らないもの(誇張しない)**
 *
 * - **点(行ごとの付与)と個人所有(`st_owner`)の経路を1件も通っていない。**
 * - **時刻起動から積まれたジョブが今日どおり素通りすることは (AC-G13-6) が測るが、
 *   それは「正しい」ではなく「今日そうである」を固定しているだけである**(`U-3` は保留)。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiCapabilityStore, type AiJob } from "./ai-capability-store.ts";
import { dispatchAiJobs } from "./ai-dispatcher.ts";
import type { AiProvider } from "./ai-provider.ts";
import { applyManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { createRecord, getRecord } from "./records.ts";
import { appDbPath } from "./storage-paths.ts";
import type { Manifest } from "./types.ts";

const APP_ID = "ai-writeback-acl";
/** **`tickets` を読み書きできる相手**(役割 `owner`)。 */
const MEMBER = "member-user";
/** **`tickets` を1件も読めない相手**(役割 `viewer`。規則を1本も書いていない)。 */
const STRANGER = "stranger-user";
/** **3人目**(`V17-M3-T03c`)。**フォールバックが持ち主の欄へ書こうとする値。** */
const THIRD = "third-user";

const HISTORY_FIELDS = [
  { id: "ran_at", name: "実行時刻", type: "date" as const },
  { id: "workflow", name: "ワークフロー", type: "text" as const },
  { id: "trigger_type", name: "きっかけ", type: "text" as const },
  { id: "status", name: "結果", type: "text" as const },
  { id: "error", name: "エラー", type: "long_text" as const },
];

function manifestSource(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "AI 書き戻しの判定",
      tables: [
        {
          id: "tickets",
          name: "問い合わせ",
          fields: [
            { id: "text", name: "本文", type: "text", required: true },
            {
              id: "category",
              name: "分類",
              type: "select",
              options: ["bug", "feature", "question"],
            },
            { id: "st_owner", name: "持ち主", type: "text" },
          ],
        },
        {
          // **`V17-M3-T03c` の題材。** **AI の書き戻し先が**持ち主の欄そのもの**である。**
          id: "docs",
          name: "文書",
          fields: [
            { id: "body", name: "本文", type: "text" },
            { id: "st_owner", name: "持ち主", type: "text" },
          ],
        },
        { id: "wf-runs", name: "実行履歴", fields: HISTORY_FIELDS },
      ],
      views: [],
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            { target: "table", table: "tickets", can: ["read", "write", "delete"] },
            { target: "table", table: "docs", can: ["read", "write", "delete"] },
            { target: "table", table: "wf-runs", can: ["read", "write", "delete"] },
          ],
        },
        // **既定3役割は消せない**(適用時検査。実測で赤くなった)。
        { id: "editor", name: "編集者" },
        {
          // **`tickets` の規則を1本も持たない** —— **既定は閉じているので、
          // この役割の相手は `tickets` を読むことも書くこともできない。**
          id: "viewer",
          name: "閲覧者",
          rules: [{ target: "table", table: "wf-runs", can: ["read"] }],
        },
      ],
      workflows: [
        {
          id: "auto-classify",
          name: "入力文を自動分類",
          trigger: { type: "on_create", table: "tickets" },
          actions: [
            {
              action: "ai_transform",
              capability: "classifier",
              prompt: "この問い合わせ文を分類してください。",
              input: { text: "$record.text" },
              output_field: "category",
              fallback: "question",
            },
          ],
          history_table: "wf-runs",
        },
        {
          // **`V17-M3-T03c`。** **`output_field` が `st_owner` である** ——
          // **`docs/plan/v16/records/investigation-b1-unmeasured-writes.md` の穴2 が
          // 実測した形とまったく同じである**(逐語: `output_field "st_owner" /
          // fallback "<user2 の利用者ID>"`)。
          id: "owner-writer",
          name: "持ち主の欄に書き戻す",
          trigger: { type: "on_create", table: "docs" },
          actions: [
            {
              action: "ai_transform",
              capability: "classifier",
              prompt: "この文書の担当者を決めてください。",
              input: { body: "$record.body" },
              output_field: "st_owner",
              fallback: THIRD,
            },
          ],
          history_table: "wf-runs",
        },
        {
          // **時刻起動**(本ファイルでは1度も走らせない。ジョブの `workflow_id` の宛先として
          // だけ使う)。 **`accessJudgmentApplies` が素通りに倒す側の題材である。**
          id: "nightly",
          name: "毎晩の作り置き",
          trigger: { type: "schedule", at: { hour: 3, minute: 0 } },
          actions: [{ action: "create_record", table: "tickets", values: { text: "夜間" } }],
          history_table: "wf-runs",
        },
      ],
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let db: Database;
let manifest: Manifest;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-ai-writeback-acl-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "AI 書き戻しの判定", { app_id: APP_ID });
  } finally {
    store.close();
  }
  const applied = applyManifest(dataRoot, APP_ID, manifestSource());
  if (!applied.valid) {
    throw new Error(`前提のマニフェスト投入に失敗: ${JSON.stringify(applied.errors)}`);
  }
  manifest = applied.manifest;
  db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  // **書き手を2人立てる**(`effectiveRolesOnDb` が読む2表。`automation-actor-fixture` と同形)。
  db.run(`CREATE TABLE IF NOT EXISTS "_auth_users" ("id" TEXT PRIMARY KEY, "role" TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS "_auth_user_roles" ("user_id" TEXT, "role" TEXT)`);
  db.run(`INSERT OR REPLACE INTO "_auth_users" ("id", "role") VALUES (?, ?)`, [MEMBER, "owner"]);
  db.run(`INSERT OR REPLACE INTO "_auth_users" ("id", "role") VALUES (?, ?)`, [STRANGER, "viewer"]);
  db.run(`INSERT OR REPLACE INTO "_auth_users" ("id", "role") VALUES (?, ?)`, [THIRD, "viewer"]);
  // capability を1本発行する(**secret を持たない `claude_cli`。呼ぶのはスパイである**)。
  withStore((s) =>
    s.createCapability({
      appId: APP_ID,
      name: "classifier",
      provider: "claude_cli",
      model: "claude-opus-4-8",
      limit: { maxCallsPerDay: 100, maxCostUsdPerDay: 10 },
    }),
  );
});

afterEach(async () => {
  db.close();
  await rm(dataRoot, { recursive: true, force: true });
});

function withStore<T>(fn: (store: AiCapabilityStore) => T): T {
  const store = AiCapabilityStore.openForKernel(dataRoot);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/** **返り値を1つ返すスパイ**(実 CLI に触れない)。 */
function spyProvider(value: string): AiProvider {
  return async () => ({ text: `{"value":"${value}"}`, inputTokens: 10, outputTokens: 2 });
}

/**
 * **`member` の行を1つ作り、`stranger` を書き手にしたジョブを1件積む。**
 *
 * **行は `member` のものである**(`st_owner` が `member`)。**ジョブの書き手だけを
 * `stranger` に差し替える** —— **`on_create` が積んだジョブは書き手が行の持ち主に
 * なるので、それを1件だけ書き換えて「他人の行を書きに来た発火」を作る。**
 */
function seedJobBy(actor: string, workflowId = "auto-classify"): { recordId: string } {
  const created = createRecord(db, manifest, "tickets", {
    text: "ボタンが反応しない",
    st_owner: MEMBER,
  });
  if (!created.ok) {
    throw new Error(`前提の行の作成に失敗: ${JSON.stringify(created)}`);
  }
  const jobs = pendingJobs();
  if (jobs.length !== 1) {
    throw new Error(`前提: ジョブがちょうど1件積まれるはず(実際は ${jobs.length} 件)`);
  }
  // **積まれたジョブの書き手とワークフローだけを差し替える**(推論は1度も呼んでいない)。
  const kernelDb = new Database(join(dataRoot, "kernel.sqlite"), {
    readwrite: true,
    create: false,
  });
  try {
    kernelDb.run(`UPDATE "ai_jobs" SET "actor" = ?, "workflow_id" = ? WHERE "id" = ?`, [
      actor,
      workflowId,
      jobs[0]?.id ?? "",
    ]);
  } finally {
    kernelDb.close();
  }
  return { recordId: created.value._id };
}

function pendingJobs(): AiJob[] {
  return withStore((s) => s.listPendingJobs());
}

/**
 * **ジョブの現状を `kernel.sqlite` から直に読む**(公開 API に一覧が無い)。
 * **読むだけである。**
 */
function jobRows(): { status: string; error: string | null }[] {
  const kernelDb = new Database(join(dataRoot, "kernel.sqlite"), { readonly: true });
  try {
    return kernelDb
      .query<{ status: string; error: string | null }, [string]>(
        `SELECT "status", "error" FROM "ai_jobs" WHERE "app_id" = ? ORDER BY "rowid" ASC`,
      )
      .all(APP_ID);
  } finally {
    kernelDb.close();
  }
}

function readCategory(recordId: string): unknown {
  const result = getRecord(db, manifest, "tickets", recordId);
  if (!result.ok || result.value === null) {
    throw new Error(`レコードを読めません: ${recordId}`);
  }
  return result.value.category;
}

// ---------------------------------------------------------------------------
// (AC-G13-4) **本命の口**(`ai-dispatcher.ts` の1度目の `updateRecord`)
// ---------------------------------------------------------------------------

test("(AC-G13-4) 他人の行を1件も読めない相手の発火は、AI の答えをその行へ書き戻せない", async () => {
  const { recordId } = seedJobBy(STRANGER);
  // 前提: `stranger` はこの行を1件も読めない(面の既定が閉じている)。
  expect(readCategory(recordId)).toBe(null);

  // "bug" は選択肢に在る → **本命の口が通る値である**。
  const result = await dispatchAiJobs(dataRoot, spyProvider("bug"));

  expect(readCategory(recordId)).toBe(null);
  expect(result.done).toBe(0);
  expect(result.failed).toBe(1);
  const job = jobRows()[0];
  expect(job?.status).toBe("failed");
  // **黙って止めない** —— 断りの理由が残る。
  expect(String(job?.error)).toContain("アクセス権");
});

// ---------------------------------------------------------------------------
// (AC-G13-5) **フォールバックの口**(2度目の `updateRecord`)
// ---------------------------------------------------------------------------

test("(AC-G13-5) AI の答えが検証に落ちても、フォールバックの書き戻しも同じ判定で止まる", async () => {
  const { recordId } = seedJobBy(STRANGER);
  expect(readCategory(recordId)).toBe(null);

  // "urgent" は選択肢に無い → 1度目の `updateRecord` が拒否 → **フォールバックの口へ落ちる**。
  // **フォールバック値 "question" は選択肢に在るので、判定が無ければ必ず書けてしまう。**
  const result = await dispatchAiJobs(dataRoot, spyProvider("urgent"));

  expect(readCategory(recordId)).toBe(null);
  expect(result.failed).toBe(1);
  const job = jobRows()[0];
  expect(job?.status).toBe("failed");
  expect(String(job?.error)).toContain("アクセス権");
});

// ---------------------------------------------------------------------------
// (AC-G13-6) **陰性対照2本** —— 広げすぎていないこと
// ---------------------------------------------------------------------------

test("(AC-G13-6) 自分の行への書き戻しは今日どおり通る(判定を広げすぎていない)", async () => {
  const { recordId } = seedJobBy(MEMBER);
  const result = await dispatchAiJobs(dataRoot, spyProvider("bug"));
  expect(readCategory(recordId)).toBe("bug");
  expect(result.done).toBe(1);
});

test("(AC-G13-7)【今日そうである。正しいとは書かない】時刻起動から積まれたジョブは素通りする", async () => {
  // **`U-3` は保留である**(`docs/plan/undecided.md`)。**本段は時刻起動に1バイトも触らない。**
  const { recordId } = seedJobBy(STRANGER, "nightly");
  await dispatchAiJobs(dataRoot, spyProvider("bug"));
  expect(readCategory(recordId)).toBe("bug");
});

test("(AC-G13-8)【塞げていない穴。名指しで固定する】ワークフロー定義が引けないジョブは素通りする", async () => {
  // **ジョブが積まれた後にワークフローが消えると、その発火が時刻起動だったかを知る手が
  // 1つも無い。** **止めると時刻起動から積まれたジョブが止まりうる**(= `AC-G11` の実装)。
  // **したがって今日どおり通す。** **これは迂回である。**
  const { recordId } = seedJobBy(STRANGER, "workflow-that-no-longer-exists");
  await dispatchAiJobs(dataRoot, spyProvider("bug"));
  expect(readCategory(recordId)).toBe("bug");
});

/**
 * **`V17-M3-T03c` の題材。** **`member` の行を `docs` に1つ作り、その行を書き戻し先に
 * するジョブを1件積む**(**書き手は `member` 自身。面と点は通る**)。
 *
 * **止まりうるのは個人所有(`st_owner`)の判定だけである** —— **この形にしないと、
 * 面が先に止めてしまって「持ち主の欄が書き換わる」穴が観測できない**(前任が `T01a` /
 * `T02a` で踏んだ壁3 と同じ)。
 */
function seedOwnerJob(): { recordId: string } {
  const created = createRecord(db, manifest, "docs", { body: "見積書", st_owner: MEMBER });
  if (!created.ok) {
    throw new Error(`前提の行の作成に失敗: ${JSON.stringify(created)}`);
  }
  const jobs = pendingJobs();
  if (jobs.length !== 1) {
    throw new Error(`前提: ジョブがちょうど1件積まれるはず(実際は ${jobs.length} 件)`);
  }
  return { recordId: created.value._id };
}

function readOwner(recordId: string): unknown {
  const result = getRecord(db, manifest, "docs", recordId);
  if (!result.ok || result.value === null) {
    throw new Error(`レコードを読めません: ${recordId}`);
  }
  return (result.value as unknown as Record<string, unknown>).st_owner;
}

/** **解釈できない散文を返すスパイ** —— `parseAiValue` が `null` に倒し、フォールバックへ落ちる。 */
const junkProvider: AiProvider = async () => ({
  text: "たぶん担当は誰かだと思います(JSON ではない散文)",
  inputTokens: 10,
  outputTokens: 2,
});

// ---------------------------------------------------------------------------
// (AC-G13-9) / (AC-G13-10) **持ち主の欄そのものへの書き戻し**(`V17-M3-T03c`)
//
// **台帳 `docs/adr/0007-vocabulary-governance.md:1839`(`AC-G13` の行)の逐語は
// 「他人の行の**中身と持ち主**を書き換えられるのを塞ぎたい」である** ——
// **「持ち主」が名指しで単位に入っている。**
// **面と点の判定(`judgeAutomationWrite`)は `st_owner` を1度も見ないので、
// ここは判定を1本足すまで通ってしまう。**
// ---------------------------------------------------------------------------

test("(AC-G13-9) AI の答えは、行の持ち主を他人へ付け替えられない(本命の口)", async () => {
  const { recordId } = seedOwnerJob();
  expect(readOwner(recordId)).toBe(MEMBER);

  // **AI が「担当は stranger」と答える。** **`st_owner` は text なので値の検証は通る** ——
  // **止められるとしたら個人所有の判定だけである。**
  const result = await dispatchAiJobs(dataRoot, spyProvider(STRANGER));

  expect(readOwner(recordId)).toBe(MEMBER);
  expect(result.done).toBe(0);
  const job = jobRows()[0];
  expect(job?.status).toBe("failed");
  expect(String(job?.error)).toContain("所有者");
});

test("(AC-G13-10) AI が失敗したときのフォールバックも、持ち主を付け替えられない(フォールバックの口)", async () => {
  const { recordId } = seedOwnerJob();
  expect(readOwner(recordId)).toBe(MEMBER);

  // **AI の出力が解釈不能 → `parseAiValue` が `null` → 本命を1度も試さずフォールバックへ。**
  // **フォールバックの値は宣言に焼かれた `third-user` である**(`investigation-b1` の穴2 と同型)。
  const result = await dispatchAiJobs(dataRoot, junkProvider);

  expect(readOwner(recordId)).toBe(MEMBER);
  expect(result.done).toBe(0);
  const job = jobRows()[0];
  expect(job?.status).toBe("failed");
  expect(String(job?.error)).toContain("所有者");
});

test("(AC-G13-11) 持ち主を据え置く書き戻しは今日どおり通る(判定を広げすぎていない)", async () => {
  const { recordId } = seedOwnerJob();
  // **同じ値を書き戻すのは `isAllowedOwnerUpdate` が許す形である**(据え置き)。
  const result = await dispatchAiJobs(dataRoot, spyProvider(MEMBER));
  expect(readOwner(recordId)).toBe(MEMBER);
  expect(result.done).toBe(1);
});
