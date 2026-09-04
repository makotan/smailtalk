/**
 * **登録をきっかけに動く処理(ワークフロー)とコードの島に、アクセス権の判定を配線した
 * ことの検査**(`V8-M21`。台帳 `J-G22a` / `J-G23` の限定採用 / ユーザ決定 `D-V8-18` /
 * メインの裁定 `R-8`)。
 *
 * ## 台帳の限定の逐語(**これが仕様である**)
 *
 * - **`J-G22a`**: 「`src/kernel/workflow-runner.ts` の書込アクション直前1箇所。判定の家は
 *   同上(`:59` で既に import 済み)。**主体は今日の1本の規則(この人として動くの宣言が
 *   あればそれ、無ければきっかけを作った人)をそのまま使う**」
 * - **`J-G23`**: 「`src/kernel/workflow-runner.ts:1614` と同じ1箇所(**島の外側**)。判定の家は
 *   同上。**島の中には判定を1バイトも出さない**。**時刻起動から起きた島は素通りのまま残る**」
 *
 * ## **素通りする経路は2本である**(**【禁止】「全部の入口に効く」と書かない**)
 *
 * - **AI(MCP)**(`D-V8-20`)—— **本ファイルは1件も測っていない。**
 * - **決まった時刻に動く処理**(`D-V8-33` / `J-G22b` = 保留 / `docs/plan/undecided.md` の `U-3`)
 *   —— **下の (S) が「素通りすること」を実測で固定する。** **塞いでいないことの記録である。**
 *
 * ## **先に認めること(隠さない。裁定 `R-8` / `04` §7-5 (F) の逐語)**
 *
 * **「判定を掛けると、今日動いているアプリの島が落ちる」。** **落ちるのは
 * 行ごとのアクセス権を宣言した表へ書く自動処理・島だけである** —— **宣言していない表への
 * 書込は1ミリも変わらない**(下の (P) が固定する)。
 *
 * ## **この検査が測っていないもの(誇張しない)**
 *
 * - **【`V8-M21` の後半で偽になった。旧文を1バイトも消していない】** 旧の逐語:
 *   > **面(役割に束ねた権限。`app.roles[].rules`)をこの3経路に1バイトも掛けていない** ——
 *   > **カーネルは実効ロール集合を解決する手段を持たない**(`_auth_users` を読む口が
 *   > `src/auth/store.ts` にしかなく、判定の家 `src/server/owner-scope.ts` は
 *   > `web/test/shell-navigation-boundary.test.ts` が1バイト単位で凍結している)。
 *   > **したがって `V8-M20` の記録 §9 の 9「面は受信口・ワークフロー・コードの島・`DELETE` を
 *   > 1つも止めない」は、面については今日も真である。** **止まるようになったのは点(行ごとの
 *   > 付与)の側だけである。**
 *
 *   **後半が `effectiveRolesOnDb`(`src/auth/store.ts` の既存の同居関数)を足し、
 *   面と点を `OR` で重ねる既存1本(`combineRoleAndCreatorGrant` /
 *   `resolveCombinedRecordAccess`)ごと掛けた。** **下の (F) 群がそれを測る。**
 *   **`DELETE` の経路には今日も1バイトも掛かっていない**(本ファイルの担当は3経路である)。
 * - **削除の自動処理は語彙に無い**(`action` の enum は5値で `delete_record` を持たない)。
 *   **実際に削除が起きるのは `run_function` の `output_table` 全置換の前段だけであり、
 *   そこは下の (O) が扱う。**
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appDbPath,
  applyManifest,
  createApp,
  createRecord,
  KernelMetaStore,
  listRecords,
  type Manifest,
} from "../kernel/index.ts";
import { ensureIslandRuntimeReady } from "../kernel/island-runner.ts";
import { runScheduledWorkflow } from "../kernel/workflow-runner.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "auto-guard";

/**
 * **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`】面の規則を足さない表の一覧。**
 *
 * **既定が「閉じる」側へ倒れたので、規則を1本も名指ししていない表は面が拒否する。**
 * **ここに挙げた表は「面を閉じたまま」測る側である** —— **足すと本ファイルの主題
 * (点 = 行ごとの付与 / 面だけの表 / 読取1本だけの表)が丸ごと測れなくなる。**
 *
 * **面が閉じても点の測定は生きている** —— **`CLOSED_ROLE_ACCESS` は `governed: true` で
 * 返るので、`combineRoleAndGrantAccess` は「両方が管轄内 = `OR`」の枝に入り、
 * 点が通せば今日どおり通る**(`(ii-b)` / `(ii-f)` / `(O-b)` が実測している)。
 *
 * **`open_notes` はここに入れない** —— **`(P)` の主題は「点(`access_control`)は
 * オプトインである」ことであり、面まで閉じるとその測定が面の 403 に隠れる。**
 */
const FACE_CLOSED_TABLES = [
  // 点(行ごとの付与)を宣言した表 —— (ii) / (iii) / (O) の主題。
  "notes",
  "sums",
  // 面だけを宣言した表 —— (F-1) / (F-2) / (F-3) の主題(規則は題材が自分で書いている)。
  "role_notes",
  // 面と点の両方を宣言した表 —— (F-4) の主題。
  "both_notes",
  // 読取だけを1本書いた表 —— (F-7) の主題。
  "readonly_notes",
] as const;

const PERMISSIONS = [
  { id: "keeper", name: "作った人", read: true, write: true, delete: true },
] as const;

/** きっかけの表(すべて個人所有 = `st_owner` を持つ)。 */
function triggerTable(id: string, extra: Record<string, unknown>[] = []) {
  return {
    id,
    name: id,
    fields: [
      { id: "title", name: "件名", type: "text" },
      { id: "st_owner", name: "所有者", type: "text" },
      ...extra,
    ],
  };
}

const NOTE_REF = { id: "note", name: "メモ", type: "reference", reference_table: "notes" };
const AGENT_REF = { id: "agent", name: "代理", type: "reference", reference_table: "agents" };

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "自動処理の門",
      tables: [
        // --- 書込先(行ごとのアクセス権を宣言した表)-------------------------------
        {
          id: "notes",
          name: "メモ",
          fields: [{ id: "body", name: "本文", type: "text" }],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            grant: {
              table: "note_grant",
              target: "note",
              member: "member",
              permission: "permission",
            },
            members: { table: "note_member", account: "account" },
          },
        },
        {
          id: "note_grant",
          name: "メモの付与",
          fields: [
            { id: "note", name: "行", type: "reference", reference_table: "notes" },
            { id: "member", name: "相手", type: "reference", reference_table: "note_member" },
            { id: "permission", name: "権限", type: "select", options: ["keeper"] },
          ],
        },
        {
          id: "note_member",
          name: "参加者",
          fields: [{ id: "account", name: "ログイン", type: "text" }],
        },
        // --- 宣言していない書込先(オプトインの対照)-------------------------------
        {
          id: "open_notes",
          name: "素のメモ",
          fields: [{ id: "body", name: "本文", type: "text" }],
        },
        // --- **面だけ**を宣言した書込先(`V8-M21` の後半。行ごとの付与は1つも無い)------
        // **`app.roles` に「役割 `editor` × 表 `role_notes` × 書込」を書く**(下の `roles`)。
        // **点(行ごとのアクセス権)は宣言していない** —— **面だけで止まる/通ることを測る。**
        {
          id: "role_notes",
          name: "役割で守るメモ",
          fields: [{ id: "body", name: "本文", type: "text" }],
        },
        // --- **読取だけ**を宣言した書込先(`V8-M21` の後半。**代償を測るための台**)-------
        // **`app.roles` に「役割 `owner` × 表 `readonly_notes` × **読取**」を1本書くだけの表。**
        // **書込の規則は誰にも1本も書いていない。**
        {
          id: "readonly_notes",
          name: "読むとだけ書いたメモ",
          fields: [{ id: "body", name: "本文", type: "text" }],
        },
        // --- **面と点の両方**を宣言した書込先(`OR` を測る)---------------------------
        {
          id: "both_notes",
          name: "両方で守るメモ",
          fields: [{ id: "body", name: "本文", type: "text" }],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            grant: {
              table: "both_grant",
              target: "note",
              member: "member",
              permission: "permission",
            },
            members: { table: "note_member", account: "account" },
          },
        },
        {
          id: "both_grant",
          name: "両方で守るメモの付与",
          fields: [
            { id: "note", name: "行", type: "reference", reference_table: "both_notes" },
            { id: "member", name: "相手", type: "reference", reference_table: "note_member" },
            { id: "permission", name: "権限", type: "select", options: ["keeper"] },
          ],
        },
        // --- `output_table` 全置換の出力先(宣言した表)-----------------------------
        {
          id: "sums",
          name: "集計",
          fields: [{ id: "value", name: "値", type: "number" }],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            grant: {
              table: "sum_grant",
              target: "sum",
              member: "member",
              permission: "permission",
            },
            members: { table: "note_member", account: "account" },
          },
        },
        {
          id: "sum_grant",
          name: "集計の付与",
          fields: [
            { id: "sum", name: "行", type: "reference", reference_table: "sums" },
            { id: "member", name: "相手", type: "reference", reference_table: "note_member" },
            { id: "permission", name: "権限", type: "select", options: ["keeper"] },
          ],
        },
        // --- 代理(`act_as` の1ホップ先)-------------------------------------------
        {
          id: "agents",
          name: "代理",
          fields: [
            { id: "label", name: "名前", type: "text" },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
        // --- きっかけの表 -----------------------------------------------------------
        triggerTable("orders"),
        triggerTable("actas_orders", [AGENT_REF]),
        triggerTable("open_orders"),
        triggerTable("edits", [NOTE_REF]),
        triggerTable("actas_edits", [NOTE_REF, AGENT_REF]),
        triggerTable("isl"),
        triggerTable("actas_isl", [AGENT_REF]),
        triggerTable("sum_src"),
        triggerTable("sched_src"),
        // --- 面の検査で使うきっかけの表(`V8-M21` の後半)-----------------------------
        triggerTable("role_src"),
        triggerTable("role_isl"),
        triggerTable("both_src"),
        triggerTable("ro_src"),
        triggerTable("ro_isl"),
        {
          id: "wf_log",
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
      views: [{ id: "note-list", type: "list_view", table: "notes", columns: ["body"] }],
      // --- **面(役割に束ねた権限)の宣言**(`V8-M21` の後半)--------------------------
      // **既定3ロール(`owner` / `editor` / `viewer`)は消せない。**
      // **規則を書いたのは `editor` だけである** —— **規則が対象を名指しした時点で
      // その対象は allow-list になるので、`owner` はこの2表に書けなくなる。**
      roles: [
        {
          id: "owner",
          name: "持ち主",
          // **【`V8-M21` の後半】読取だけを書いた規則1本**(下の (F-7) の台)。
          rules: [{ target: "table", table: "readonly_notes", can: ["read"] }],
        },
        {
          id: "editor",
          name: "編集者",
          rules: [
            { target: "table", table: "role_notes", can: ["write"] },
            { target: "table", table: "both_notes", can: ["write"] },
          ],
        },
        { id: "viewer", name: "閲覧者" },
      ],
      functions: [
        {
          id: "island_write",
          name: "島が書く",
          code: 'export default function () { return [{ op: "create", table: "notes", values: { body: "島から" } }]; }',
          input: { source: "record" },
          output: { ops: true },
        },
        {
          id: "island_open_write",
          name: "島が宣言していない表へ書く",
          code: 'export default function () { return [{ op: "create", table: "open_notes", values: { body: "島から" } }]; }',
          input: { source: "record" },
          output: { ops: true },
        },
        {
          id: "island_role_write",
          name: "島が面だけの表へ書く",
          code: 'export default function () { return [{ op: "create", table: "role_notes", values: { body: "島から" } }]; }',
          input: { source: "record" },
          output: { ops: true },
        },
        {
          id: "island_readonly_write",
          name: "島が読取だけ宣言した表へ書く",
          code: 'export default function () { return [{ op: "create", table: "readonly_notes", values: { body: "島から" } }]; }',
          input: { source: "record" },
          output: { ops: true },
        },
        {
          id: "sum_rows",
          name: "集計を作る",
          code: "export default function () { return [{ value: 42 }]; }",
          input: { source: "record" },
          output: { fields: [{ id: "value", type: "number" }] },
        },
      ],
      workflows: [
        {
          id: "wf_create",
          name: "登録で作る",
          trigger: { type: "on_create", table: "orders" },
          history_table: "wf_log",
          actions: [{ action: "create_record", table: "notes", values: { body: "$record.title" } }],
        },
        {
          id: "wf_create_actas",
          name: "登録で作る(代理)",
          trigger: { type: "on_create", table: "actas_orders" },
          act_as: "$record.agent",
          history_table: "wf_log",
          actions: [{ action: "create_record", table: "notes", values: { body: "$record.title" } }],
        },
        {
          id: "wf_create_open",
          name: "宣言していない表へ作る",
          trigger: { type: "on_create", table: "open_orders" },
          history_table: "wf_log",
          actions: [
            { action: "create_record", table: "open_notes", values: { body: "$record.title" } },
          ],
        },
        {
          id: "wf_update",
          name: "更新で書き換える",
          trigger: { type: "on_update", table: "edits" },
          history_table: "wf_log",
          actions: [
            {
              action: "update_record",
              table: "notes",
              target: "$record.note",
              values: { body: "自動処理が書き換えた" },
            },
          ],
        },
        {
          id: "wf_update_actas",
          name: "更新で書き換える(代理)",
          trigger: { type: "on_update", table: "actas_edits" },
          act_as: "$record.agent",
          history_table: "wf_log",
          actions: [
            {
              action: "update_record",
              table: "notes",
              target: "$record.note",
              values: { body: "代理が書き換えた" },
            },
          ],
        },
        {
          id: "wf_island",
          name: "島が書く",
          trigger: { type: "on_create", table: "isl" },
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "island_write", write_ops: true }],
        },
        {
          id: "wf_island_actas",
          name: "島が書く(代理)",
          trigger: { type: "on_create", table: "actas_isl" },
          act_as: "$record.agent",
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "island_write", write_ops: true }],
        },
        {
          id: "wf_output",
          name: "集計を作り直す",
          trigger: { type: "on_create", table: "sum_src" },
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "sum_rows", output_table: "sums" }],
        },
        // --- 面の検査で使うワークフロー(`V8-M21` の後半)-----------------------------
        {
          id: "wf_role_create",
          name: "面だけの表へ作る",
          trigger: { type: "on_create", table: "role_src" },
          history_table: "wf_log",
          actions: [
            { action: "create_record", table: "role_notes", values: { body: "$record.title" } },
          ],
        },
        {
          id: "wf_role_island",
          name: "島が面だけの表へ書く",
          trigger: { type: "on_create", table: "role_isl" },
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "island_role_write", write_ops: true }],
        },
        {
          id: "wf_both_create",
          name: "面と点の両方を宣言した表へ作る",
          trigger: { type: "on_create", table: "both_src" },
          history_table: "wf_log",
          actions: [
            { action: "create_record", table: "both_notes", values: { body: "$record.title" } },
          ],
        },
        {
          id: "wf_ro_create",
          name: "読取だけ宣言した表へ作る",
          trigger: { type: "on_create", table: "ro_src" },
          history_table: "wf_log",
          actions: [
            { action: "create_record", table: "readonly_notes", values: { body: "$record.title" } },
          ],
        },
        {
          id: "wf_ro_island",
          name: "島が読取だけ宣言した表へ書く",
          trigger: { type: "on_create", table: "ro_isl" },
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "island_readonly_write", write_ops: true }],
        },
        {
          id: "wf_sched",
          name: "時刻で作る",
          trigger: { type: "schedule", at: { hour: 3, minute: 0 }, table: "sched_src" },
          history_table: "wf_log",
          actions: [{ action: "create_record", table: "notes", values: { body: "時刻起動から" } }],
        },
      ],
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
/** メンバー表に行を持たない相手。 */
let stranger: ReturnType<typeof seedSession>;
/** メンバー表に行を持つ相手。 */
let member: ReturnType<typeof seedSession>;
/** `member` のメンバー行 `_id`(付与の相手として使う)。 */
let memberRowId: string;
/**
 * **面(役割の規則)の側だけで通る相手**(`V8-M21` の後半)。
 * **役割は `editor`。メンバー表に行を1つも持たない** —— **点の側は何も持たない。**
 */
let editorOnly: ReturnType<typeof seedSession>;

beforeEach(async () => {
  await ensureIslandRuntimeReady();
  dataRoot = await mkdtemp(join(tmpdir(), "gp-auto-guard-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "自動処理の門", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **【`V8-M26`】きっかけの表・付与表・メンバー表・履歴表にだけ既定の規則を足す。**
  // **測る対象の表(`FACE_CLOSED_TABLES`)には1本も足さない。**
  expect(
    applyManifest(
      dataRoot,
      APP_ID,
      withDefaultRoleRules(manifest(), { skipTables: FACE_CLOSED_TABLES }),
    ).valid,
  ).toBe(true);
  app = createServerApp({ dataRoot });
  stranger = seedSession(dataRoot, APP_ID, { role: "owner", username: "stranger" });
  member = seedSession(dataRoot, APP_ID, { role: "owner", username: "member" });
  memberRowId = String(kernelCreate("note_member", { account: member.userId })._id);
  editorOnly = seedSession(dataRoot, APP_ID, { role: "editor", username: "editor-only" });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

/** カーネルを直接呼んで1行作る(判定の外側で台を組むため)。 */
function kernelCreate(tableId: string, values: Record<string, unknown>): Record<string, unknown> {
  const db = new Database(appDbPath(dataRoot, APP_ID));
  try {
    const created = createRecord(db, manifest(), tableId, values);
    expect(created.ok, `${tableId} の作成に失敗した`).toBe(true);
    return created.ok ? (created.value as unknown as Record<string, unknown>) : {};
  } finally {
    db.close();
  }
}

function rows(tableId: string): Record<string, unknown>[] {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readonly: true });
  try {
    const result = listRecords(db, manifest(), tableId, {});
    return result.ok ? (result.value as unknown as Record<string, unknown>[]) : [];
  } finally {
    db.close();
  }
}

/** 実行履歴の `status:error` を1本の文字列に畳む(どこで止まったかを文面で測る)。 */
function historyDetail(): string {
  return rows("wf_log")
    .map((row) => `${String(row.status)}:${String(row.error)}`)
    .join(" | ");
}

function post(
  session: ReturnType<typeof seedSession>,
  tableId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return Promise.resolve(
    app.request(
      new Request(`http://localhost/api/apps/${APP_ID}/tables/${tableId}/records`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: session.cookie,
          origin: TEST_ORIGIN,
        },
        body: JSON.stringify(body),
      }),
    ),
  );
}

async function patch(
  session: ReturnType<typeof seedSession>,
  tableId: string,
  recordId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const current = await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/tables/${tableId}/records/${recordId}`, {
      headers: { cookie: session.cookie },
    }),
  );
  const etag = current.headers.get("etag") ?? "";
  return await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/tables/${tableId}/records/${recordId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: session.cookie,
        origin: TEST_ORIGIN,
        "if-match": etag,
      },
      body: JSON.stringify(body),
    }),
  );
}

// =====================================================================================
// (ii) 登録をきっかけに動く処理 —— `create_record` / `update_record`
// =====================================================================================

test("(ii-a) 権限が無い相手の登録で動いた create_record は落ち、1行も書かれない", async () => {
  const res = await post(stranger, "orders", { title: "外の人" });
  // **発火元の書込ごと成立しない**(`ADR-0066`)—— きっかけの行も残らない。
  expect(res.status).toBe(400);
  expect(rows("notes")).toHaveLength(0);
  expect(rows("orders")).toHaveLength(0);
  expect(historyDetail()).toContain("アクセス権");
});

test("(ii-b) 権限が在る相手の登録なら、同じ create_record が通る", async () => {
  const res = await post(member, "orders", { title: "中の人" });
  expect(res.status).toBe(201);
  expect(rows("notes").map((row) => row.body)).toEqual(["中の人"]);
});

test("(ii-c) act_as を宣言すると、判定の相手は代理先の持ち主になる(権限が在れば通る)", async () => {
  const agent = kernelCreate("agents", { label: "代理", st_owner: member.userId });
  // **押したのは権限の無い相手である。** それでも代理先が権限を持つので通る。
  const res = await post(stranger, "actas_orders", { title: "代理で", agent: String(agent._id) });
  expect(res.status).toBe(201);
  expect(rows("notes").map((row) => row.body)).toEqual(["代理で"]);
});

test("(ii-d) act_as の代理先に権限が無ければ落ちる(宣言しても素通りしない)", async () => {
  const agent = kernelCreate("agents", { label: "外の代理", st_owner: stranger.userId });
  const res = await post(member, "actas_orders", { title: "代理で", agent: String(agent._id) });
  expect(res.status).toBe(400);
  expect(rows("notes")).toHaveLength(0);
  expect(historyDetail()).toContain("アクセス権");
});

test("(ii-e) update_record は、その行を書ける相手でなければ落ちる", async () => {
  const note = kernelCreate("notes", { body: "元の本文" });
  const edit = await post(stranger, "edits", { title: "編集", note: String(note._id) });
  expect(edit.status).toBe(201);
  const editId = String(((await edit.json()) as { record: { _id: string } }).record._id);
  const res = await patch(stranger, "edits", editId, { title: "編集2" });
  expect(res.status).toBe(400);
  expect(rows("notes").map((row) => row.body)).toEqual(["元の本文"]);
  expect(historyDetail()).toContain("アクセス権");
});

test("(ii-f) update_record は、その行への付与を持つ相手なら通る", async () => {
  const note = kernelCreate("notes", { body: "元の本文" });
  kernelCreate("note_grant", {
    note: String(note._id),
    member: memberRowId,
    permission: "keeper",
  });
  const edit = await post(member, "edits", { title: "編集", note: String(note._id) });
  const editId = String(((await edit.json()) as { record: { _id: string } }).record._id);
  const res = await patch(member, "edits", editId, { title: "編集2" });
  expect(res.status).toBe(200);
  expect(rows("notes").map((row) => row.body)).toEqual(["自動処理が書き換えた"]);
});

test("(ii-g) update_record の act_as —— 代理先が付与を持てば通る", async () => {
  const note = kernelCreate("notes", { body: "元の本文" });
  kernelCreate("note_grant", {
    note: String(note._id),
    member: memberRowId,
    permission: "keeper",
  });
  const agent = kernelCreate("agents", { label: "代理", st_owner: member.userId });
  const edit = await post(stranger, "actas_edits", {
    title: "編集",
    note: String(note._id),
    agent: String(agent._id),
  });
  const editId = String(((await edit.json()) as { record: { _id: string } }).record._id);
  const res = await patch(stranger, "actas_edits", editId, { title: "編集2" });
  expect(res.status).toBe(200);
  expect(rows("notes").map((row) => row.body)).toEqual(["代理が書き換えた"]);
});

// =====================================================================================
// (iii) コードの島(`write_ops`)—— **判定は島の外側**
// =====================================================================================

test("(iii-a) 権限が無い相手の発火で動いた島の書込は落ち、1行も書かれない", async () => {
  const res = await post(stranger, "isl", { title: "島" });
  expect(res.status).toBe(400);
  expect(rows("notes")).toHaveLength(0);
  expect(historyDetail()).toContain("アクセス権");
});

test("(iii-b) 権限が在る相手の発火なら、同じ島の書込が通る", async () => {
  const res = await post(member, "isl", { title: "島" });
  expect(res.status).toBe(201);
  expect(rows("notes").map((row) => row.body)).toEqual(["島から"]);
});

test("(iii-c) 島でも act_as が効く —— 代理先が権限を持てば通る", async () => {
  const agent = kernelCreate("agents", { label: "代理", st_owner: member.userId });
  const res = await post(stranger, "actas_isl", { title: "島", agent: String(agent._id) });
  expect(res.status).toBe(201);
  expect(rows("notes").map((row) => row.body)).toEqual(["島から"]);
});

test("(iii-d) 島の act_as の代理先に権限が無ければ落ちる", async () => {
  const agent = kernelCreate("agents", { label: "外の代理", st_owner: stranger.userId });
  const res = await post(member, "actas_isl", { title: "島", agent: String(agent._id) });
  expect(res.status).toBe(400);
  expect(rows("notes")).toHaveLength(0);
});

test("(iii-e) 島の中に判定を1バイトも出していない(判定の綴りが関数の宣言に無い)", () => {
  const declared = (manifest().app.functions ?? []).map((fn) => fn.code).join("\n");
  for (const spelling of [
    "resolveRecordAccess",
    "creatorGrantPlan",
    "access_control",
    "st_owner",
  ]) {
    expect(declared.includes(spelling), spelling).toBe(false);
  }
});

// =====================================================================================
// (F) **面(役割に束ねた権限)が3経路に効く**(`V8-M21` の後半。台帳 `J-G21` / `J-G22a` /
//     `J-G23` の「判定の家は `src/server/owner-scope.ts` の既存1本」/ ユーザ決定 `D-V8-23`)
//
// **`V8-M21` の前半は点(行ごとの付与)だけを掛けていた。** **後半が面を足し、
// 面と点の合成(`OR`)ごと掛けた。**
//
// **【何を測るか】**
//  - **(F-1) / (F-2)**: **点を1つも宣言していない表**(`role_notes`)で、**面だけが止める /
//    通す**ことを、自動処理とコードの島の2経路で測る。**受信口は
//    `src/server/inbound-access-control.test.ts` の (F-3) が測る**(3経路目)。
//  - **(F-4)**: **面と点の両方を宣言した表**(`both_notes`)で、**どちらか一方が通せば
//    通る**(`OR`)ことを測る。
//
// **【禁止】「`OR` なので安全側に倒れる」と書かない** —— **`OR` は書ける側に倒れる。**
// =====================================================================================

test("(F-1) 面だけを宣言した表 —— 規則に載っていない役割の登録で動いた create_record は落ちる", async () => {
  // **`stranger` の役割は `owner`。`role_notes` に `owner` の規則は1本も無い。**
  // **点(行ごとの付与)はこの表に1つも宣言されていない** —— **止めているのは面だけである。**
  const res = await post(stranger, "role_src", { title: "外の役割" });
  expect(res.status).toBe(400);
  expect(rows("role_notes")).toHaveLength(0);
  expect(historyDetail()).toContain("アクセス権");
  // **止めた層が面であることを、文面で名指ししている。**
  expect(historyDetail()).toContain("role");
});

test("(F-2) 面だけを宣言した表 —— 規則に載っている役割の登録なら、同じ create_record が通る", async () => {
  // **`editorOnly` はメンバー表に行を1つも持たない** —— **点は何も渡していない。**
  // **通しているのは面だけである。**
  const res = await post(editorOnly, "role_src", { title: "中の役割" });
  expect(res.status).toBe(201);
  expect(rows("role_notes").map((row) => row.body)).toEqual(["中の役割"]);
});

test("(F-3) 面はコードの島の書込にも効く(規則に載っていない役割は落ち、載っていれば通る)", async () => {
  expect((await post(stranger, "role_isl", { title: "島" })).status).toBe(400);
  expect(rows("role_notes")).toHaveLength(0);
  expect((await post(editorOnly, "role_isl", { title: "島" })).status).toBe(201);
  expect(rows("role_notes").map((row) => row.body)).toEqual(["島から"]);
});

test("(F-4) 面と点は OR で重なる —— どちらか一方が通せば自動処理は書ける", async () => {
  // **(i) 面だけが通す**: `editorOnly` は規則に載っているが、メンバー表に行が無い。
  expect((await post(editorOnly, "both_src", { title: "面で" })).status).toBe(201);
  // **(ii) 点だけが通す**: `member` はメンバー表に行を持つが、役割 `owner` の規則は無い。
  expect((await post(member, "both_src", { title: "点で" })).status).toBe(201);
  expect(rows("both_notes").map((row) => row.body)).toEqual(["面で", "点で"]);
  // **(iii) どちらも通さない**: `stranger` は役割の規則にも載らず、メンバー表にも行が無い。
  expect((await post(stranger, "both_src", { title: "どちらも" })).status).toBe(400);
  expect(rows("both_notes")).toHaveLength(2);
  // **止めた層を2つとも名指ししている。**
  expect(historyDetail()).toContain("role");
  expect(historyDetail()).toContain("grant");
});

test("(F-7)【正直に書く】「読める」と1行書いただけで、その表への自動書込・島の書込が全員分止まる", async () => {
  // **【この検査は代償の記録である。緑であることを「安全になった」と読まないこと。】**
  //
  // **`readonly_notes` に書いてある規則は「役割 `owner` × 表 `readonly_notes` × **読取**」の
  // 1本だけである。** **書込の規則は誰にも1本も書いていない。**
  // **それでも、面の管轄は**対象(表)**の単位で決まり、動詞を跨ぐ**(裁定 `R-4` / 台帳 `J-G19`)
  // —— **対象が名指しされた時点で、その表は書込についても allow-list になる。**
  //
  // **メインの判断(2026-08-10)**: **この形を維持する。**
  // **(対象, 動詞)を単位にすると、読取だけ宣言した表への書込が誰にでも開いたままになり、
  // それは黙った穴になる。** **このリポジトリは「黙って全員を弾く」も「黙って全員に開く」も
  // 避け、**うるさく落ちる**側を採る**(`ADR-0036` 限定3 / `J-G16`)。
  //
  // **【実際に壊れた例。手順ごと残す】** **参照EC(`scripts/ref-ec/`)がこれで壊れた** ——
  // **`order` に「運営は読める」を含む規則が在るため、決済の受信で注文を `paid` にする
  // 自動処理(`wf-payment-received`)が 400 で落ちた**(書き手が「誰でもない」に解決される。
  // きっかけの `payment_events` は `st_owner` を持たない)。
  // **直し方は語彙の中に在った** —— **そのワークフローに `act_as: "$record.order"` を1行足す**
  // (= 注文の持ち主として動く)。**購入者の規則が通す。**
  //
  // **【この直し方が使えない場合。丸めない】** **`act_as` が解決した `st_owner` が
  // `_auth_users` に**実在するアカウント**でないと、実効ロール集合が引けず「誰でもない」に
  // 倒れる** —— **カーネル / MCP / 移行スクリプトが作った行を持ち主にしている場合は、
  // `act_as` を書いても通らない**(実測: `scripts/ref-ec/manifest.test.ts` の (i-5) は、
  // 台にセッションを1つ置くまで直らなかった)。

  // **(1) 読める側の役割(`owner`)でも書けない。**
  expect((await post(member, "ro_src", { title: "読める人" })).status).toBe(400);
  expect(rows("readonly_notes")).toHaveLength(0);
  expect(historyDetail()).toContain("role");

  // **(2) 規則に1度も名指しされていない役割(`editor`)でも書けない。**
  expect((await post(editorOnly, "ro_src", { title: "他の役割" })).status).toBe(400);
  expect(rows("readonly_notes")).toHaveLength(0);

  // **(3) 島の書込も同じく止まる**(経路が違っても答えは同じ)。
  expect((await post(member, "ro_isl", { title: "島" })).status).toBe(400);
  expect(rows("readonly_notes")).toHaveLength(0);

  // **(4) 受信口も同じ形で止まる** —— **実測は
  //   `src/server/inbound-access-control.test.ts` の (F-5) が持つ**(あちらの表も
  //   規則1本だけで、受信の主体は役割を1つも持たないので面の側からは通らない)。
});

// =====================================================================================
// (P) オプトイン —— 宣言していない表への自動書込は今日どおり
// =====================================================================================

test("(P) アクセス権を宣言していない表へは、権限の無い相手の自動処理も今日どおり書ける", async () => {
  expect((await post(stranger, "open_orders", { title: "素の表へ" })).status).toBe(201);
  expect(rows("open_notes").map((row) => row.body)).toEqual(["素の表へ"]);
});

// =====================================================================================
// (O) `output_table` 全置換の前段(`clearOutputTable`)—— **明示的に決めた扱い**
// =====================================================================================

test("(O-a) 出力先が宣言した表のとき、消す権限が無ければ1行も消さずに落ちる", async () => {
  const kept = kernelCreate("sums", { value: 1 });
  const res = await post(stranger, "sum_src", { title: "集計" });
  expect(res.status).toBe(400);
  // **部分的に消えていない**(全置換の途中で止まらない)。
  expect(rows("sums").map((row) => row._id)).toEqual([kept._id]);
  expect(historyDetail()).toContain("アクセス権");
});

test("(O-b) 出力先の既存行を消せる相手なら、全置換は今日どおり通る", async () => {
  const kept = kernelCreate("sums", { value: 1 });
  kernelCreate("sum_grant", {
    sum: String(kept._id),
    member: memberRowId,
    permission: "keeper",
  });
  const res = await post(member, "sum_src", { title: "集計" });
  expect(res.status).toBe(201);
  const after = rows("sums");
  expect(after.map((row) => row.value)).toEqual([42]);
  expect(after[0]?._id).not.toBe(kept._id);
});

test("(O-c) 出力先が空なら、消す権限を1つも要求しない(再計算は止まらない)", async () => {
  expect(rows("sums")).toHaveLength(0);
  const res = await post(stranger, "sum_src", { title: "集計" });
  // **消す行が1件も無いので、消す権限は問わない。** **書く権限は問う** ——
  // `stranger` はメンバー表に行を持たないので、出力の書込で落ちる。
  expect(res.status).toBe(400);
  expect(historyDetail()).toContain("アクセス権");
});

// =====================================================================================
// (S) 【正直に書く】決まった時刻に動く処理は今日も素通りする
// =====================================================================================

test("【正直に書く】(S) 時刻起動は判定を1バイトも受けず、権限の無い相手の行としてでも書ける", () => {
  // **同じ相手・同じ書込先である** —— (ii-a) では落ちたものが、ここでは通る。
  const src = kernelCreate("sched_src", { title: "夜間", st_owner: stranger.userId });
  const db = new Database(appDbPath(dataRoot, APP_ID));
  try {
    const m = manifest();
    const workflow = (m.app.workflows ?? []).find((candidate) => candidate.id === "wf_sched");
    expect(workflow).toBeDefined();
    runScheduledWorkflow(db, m, workflow as never, {
      records: [src as never],
    });
  } finally {
    db.close();
  }
  // **1行書けている。** **これは塞いでいないことの記録である**
  // (`D-V8-33` / `J-G22b` = 保留 / `docs/plan/undecided.md` の `U-3`)。
  expect(rows("notes").map((row) => row.body)).toEqual(["時刻起動から"]);
});

test("【正直に書く】(S-2) 行選択の無い時刻起動も素通りする(主体が空でも止めない)", () => {
  const db = new Database(appDbPath(dataRoot, APP_ID));
  try {
    const m = manifest();
    const workflow = (m.app.workflows ?? []).find((candidate) => candidate.id === "wf_sched");
    runScheduledWorkflow(db, m, workflow as never, undefined);
  } finally {
    db.close();
  }
  expect(rows("notes")).toHaveLength(1);
});
