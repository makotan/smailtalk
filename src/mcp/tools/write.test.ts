/**
 * 更新系ツールの統合テスト(V0-P5-T03 の4つ + V1-M0-T01 の2つ。ADR-0005)。
 *
 * 参照系(`read.test.ts`)と同じく **in-process の MCP `Client` 経由**でのみ叩く。
 * 更新系はとくに「LLM から見てどう見えるか」が安全性に直結する
 * (`isError` の意味・エラーの `path`・部分成功の扱い)ので、関数を直接呼ぶ
 * テストでは目的を果たせない。
 *
 * 更新系で追加で確かめるのは次の3点である。
 *
 * 1. **`isError: true` は「何も変わっていない」を意味する**という規約が守られること。
 *    失敗の直後に状態を読み直し、動いていないことをアサートする。
 * 2. **`create_app` が例外を投げないこと。** カーネルの `createApp` は空名・規約違反・
 *    ID衝突で素の `Error` を投げる(`src/kernel/create-app.ts`)。MCP の入口では
 *    それが `path` 付きの統一形式にならなければ、LLM は何を直せばよいか分からない。
 * 3. **`insert_sample_data` の部分成功が `isError: false` であること**と、
 *    そこからの**再試行が重複を生まない**こと(計画 R7)。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { EscapeHatchStore } from "../../kernel/escape-hatch-store.ts";
import { InboundStore } from "../../kernel/inbound-store.ts";
import {
  appDbPath,
  applyDiff,
  beginApply,
  type ChangelogEntry,
  createApp,
  createRecord,
  type Diff,
  endApply,
  KernelMetaStore,
  type ListView,
  type Manifest,
  type RecordRow,
  readCurrentManifest,
  readOnlyTableError,
  type UndoPreview,
  type ValidationError,
} from "../../kernel/index.ts";
import {
  createServerApp,
  applyInProgressError as serverApplyInProgressError,
} from "../../server/app.ts";
import { seedSession, TEST_ORIGIN } from "../../server/test-helpers.ts";
import { createMcpServer } from "../server.ts";
import { APPLY_DIFF_OP_EXAMPLES, WORKFLOW_HISTORY_TABLE_TEMPLATE } from "../vocabulary.ts";
import { denyAppSettingWrite, applyInProgressError as mcpApplyInProgressError } from "./write.ts";

const APP_ID = "inventory";
const TABLE_ID = "items";
const LIST_VIEW_ID = "items-list";

/**
 * **【`V8-M31` 第3波】この MCP サーバが名乗る利用者のログイン名。**
 *
 * `V8-M31` で MCP に名乗り(`createMcpServer({ actor })`)が入り、**名乗りが無いと23本の
 * ツールがすべて `isError` になる。** さらに名乗った主体の権限で (B) 設定8本 / (D) 行の書込4本 /
 * (C) `list_records` が絞られる。**したがってこのファイルが触るアプリすべてに、この名前の
 * 利用者が1人ずつ要る**(`seedSession` の既定ロールは `owner`)。
 */
const ACTOR = "mcp-actor";

/** そのアプリに `ACTOR` を1人作る(`createApp` の**後**に呼ぶ。`app.sqlite` が在る前提)。 */
function seedActor(appId: string): void {
  seedSession(dataRoot, appId, { username: ACTOR });
}

/** テーブル1つ・list_view 1つを足す差分(参照系テストと同じ土台)。 */
const setupDiff: Diff = {
  diff_id: "setup",
  intent: "備品テーブルと一覧画面を用意する",
  operations: [
    {
      op: "add_table",
      table: {
        id: TABLE_ID,
        name: "備品",
        fields: [
          { id: "title", name: "品名", type: "text", required: true },
          { id: "qty", name: "数量", type: "number" },
        ],
      },
    },
    {
      op: "add_view",
      view: { id: LIST_VIEW_ID, type: "list_view", table: TABLE_ID, columns: ["title", "qty"] },
    },
  ],
};

/** テストの中で apply する追加差分(`undo` の対象にもなる)。 */
const ratingDiff: Diff = {
  diff_id: "d-rating",
  intent: "備品に評価を付けたい",
  operations: [
    { op: "add_field", table: TABLE_ID, field: { id: "rating", name: "評価", type: "number" } },
  ],
};

let dataRoot = "";
const previewBaseUrl = "http://127.0.0.1:3000";

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-mcp-write-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "在庫管理", { app_id: APP_ID });
    createApp(store, "経費申請", { app_id: "expense" });
  } finally {
    store.close();
  }

  const applied = applyDiff(dataRoot, APP_ID, setupDiff);
  if (!applied.valid) {
    throw new Error(`テスト前提の差分適用に失敗しました: ${JSON.stringify(applied.errors)}`);
  }

  // **【`V8-M31` 第3波】名乗る相手を、beforeEach が作る2つのアプリ両方に用意する。**
  seedActor(APP_ID);
  seedActor("expense");
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

/** クライアントとサーバを直結する(両 `connect` は `Promise.all`。逐次だとデッドロックする)。 */
async function connectInMemory(): Promise<{ client: Client; close: () => Promise<void> }> {
  // **【`V8-M31` 第3波】名乗りを渡す。** 渡さないと23本すべてが `isError` になる。
  const server = createMcpServer({ dataRoot, previewBaseUrl, actor: ACTOR });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  const { client, close } = await connectInMemory();
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await close();
  }
}

function okData(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

function errorsOf(result: CallToolResult): ValidationError[] {
  expect(result.isError).toBe(true);
  const structured = result.structuredContent as { errors: ValidationError[] } | undefined;
  expect(structured?.errors).toBeDefined();
  return structured?.errors ?? [];
}

function expectUnknownAppError(result: CallToolResult): void {
  const errors = errorsOf(result);
  expect(errors).toHaveLength(1);
  expect(errors[0]?.path).toBe("/app_id");
  expect(errors[0]?.allowed_values).toEqual([APP_ID, "expense"]);
}

/** テーブルの全レコードを MCP 経由で読む(状態不変の確認に使う)。 */
async function listRecordsVia(tableId: string = TABLE_ID): Promise<RecordRow[]> {
  const data = okData(await callTool("list_records", { app_id: APP_ID, table_id: tableId }));
  return data.records as RecordRow[];
}

/** レコードの現在の版(_updated_at)を得る(if_match 必須の update/delete 用。V1-M9-T02)。 */
async function versionVia(recordId: string, tableId: string = TABLE_ID): Promise<string> {
  const records = await listRecordsVia(tableId);
  const version = records.find((record) => record._id === recordId)?._updated_at;
  if (typeof version !== "string") {
    throw new Error(`テスト前提: レコード "${recordId}" の版を取得できません。`);
  }
  return version;
}

// --- tools/list -----------------------------------------------------------------

// **表題の件数はサーバ全体の公開ツール数である**(更新系だけの数ではない)。
// 正は `src/mcp/descriptions.test.ts` の `EXPECTED_TOOL_NAMES` であり、
// ここはその同じ集合を別の入口から見ている。
test("更新系を含む23ツールが tools/list に出る", async () => {
  const { client, close } = await connectInMemory();
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        "apply_diff",
        "create_app",
        "get_changelog",
        "get_manifest",
        "get_preview_url",
        "insert_sample_data",
        "list_apps",
        "list_records",
        "preview_undo",
        // V1-M9-T05(ADR-0032)。redo の事前確認。**参照系**であり `registerReadTools` が登録する。
        "preview_redo",
        "undo",
        // V1-M9-T05(ADR-0032)。直前の undo をやり直す更新系ツール(ADR-0004 §1 の明示的な改訂)。
        "redo",
        // V1-M0-T01(F-13)。カーネルの updateRecord / deleteRecord への入口を開けた。
        "update_record",
        "delete_record",
        // V2-M4-T01(ADR-0039)。複数レコードの原子書込(バッチ)。カーネル関門 writeRecords への入口。
        "write_records",
        // V1-M9-T09(ADR-0031)。アプリ単位の完全削除。カーネルの deleteApp への入口。
        "delete_app",
        // V1-M1-T02。**参照系**であり `registerReadTools` が登録する。ここに現れるのは
        // このテストがサーバ全体(参照系 + 更新系)の tools/list を見ているためで、
        // 更新系が1つ増えたのではない。`registerWriteTools` 単独の一覧は
        // `scripts/mcp-trial/write-tools-drift.test.ts` が見張っており、そちらは変わらない。
        // **【2026-08-25 追記(`V10-M28-T02`)。上の行を1バイトも消していない】**
        // **`dry_run_diff` に `apply_diff` と同じ `app` × `write` の判定が入ったが、
        // 登録先も `WRITE_TOOLS` も1バイトも動かしていない** ——
        // **判定が掛かることと、更新系であることは別の話である。**
        "dry_run_diff",
        // V1-M4-T04(ADR-0020 §2b)。接続(capability)の**申請**ツール(更新系)。
        // AI が到達できるのは申請まで。発行は owner の HTTP 操作だけ(§8c-3)。
        "request_connection",
        // V1-M5-T04(ADR-0021 §2b)。AI capability の**申請**ツール(更新系)。
        // request_connection と同型 —— AI は申請まで、発行・上限変更は owner の HTTP だけ(§8c-3)。
        "request_ai_capability",
        // V2-M5-T01(ADR-0041 限定1)。受信口(inbound capability)の**申請**ツール(更新系)。
        // request_connection の鏡写し —— AI は申請まで、発行は owner の HTTP だけ(発行経路を結線しない)。
        "request_inbound_endpoint",
        // V3-M5-T01(ADR-0055 限定5)。逃げ道(任意 CSS)の**申請**ツール(更新系)。
        // request_connection の3例目 —— AI は申請まで、**CSS の本文を書けるのは owner の
        // HTTP だけ**(発行経路を MCP / apply_diff に1本も結線しない)。
        "request_custom_css",
        // V1-M8-T02(ADR-0025 §10)。**参照系**であり `registerReadTools` が登録する
        // (`dry_run_diff` と同じ理由でここに現れる。更新系は1つも増えていない)。
        "generate_requirements_doc",
        // V3-M5-T04(ADR-0056 / `D-G10a`)。逸脱の蓄積の集計と昇格の提案。**参照系**であり
        // `registerReadTools` が登録する。**提案するだけで1バイトも書き込まない**ので、
        // ここに現れても更新系は1つも増えていない(昇格の書き込みは既存の apply_diff)。
        "report_drift",
        // V8-M13-T02(台帳 `Q-G28` = 限定採用(門A))。集計表を1枚読む。**参照系**であり
        // `registerReadTools` が登録する。**ここに現れるのは、このテストがサーバ全体
        // (参照系 + 更新系)の tools/list を見ているためで、更新系は1つも増えていない**
        // (`registerWriteTools` 単独の一覧は `scripts/mcp-trial/write-tools-drift.test.ts` が
        // 見張っており、そちらは今日も変わっていない)。
        // **テスト名(「23ツール」)は1バイトも書き換えていない** —— 今日は24ツールである。
        "read_report",
        // V10-M12-T01(台帳 `CM-G7` = 限定採用(門A)。`ADR-0368`)。積まれたコメントを読む。
        // **参照系**であり `registerReadTools` が登録する。**ここに現れるのは、このテストが
        // サーバ全体(参照系 + 更新系)の tools/list を見ているためで、更新系は1つも
        // 増えていない**(`registerWriteTools` 単独の一覧は
        // `scripts/mcp-trial/write-tools-drift.test.ts` が見張っており、そちらは今日も
        // 変わっていない)。
        // **テスト名(「23ツール」)は1バイトも書き換えていない** —— 今日は25ツールである。
        "list_comments",
        // V10-M30-T02(台帳 `CM-G37` = 限定採用(門A)。`ADR-0378`)。アプリごとのコメントの
        // 出し入れを切り替える**更新系**ツール。**ここは更新系が1本増えている** ——
        // `registerWriteTools` が登録するので `scripts/mcp-trial/write-tools-drift.test.ts`
        // が見張る `WRITE_TOOLS` にも同じ1本を書き足した。
        // **テスト名(「23ツール」)は1バイトも書き換えていない** —— 今日は26ツールである。
        "set_comment_visibility",
      ].sort(),
    );
    for (const tool of listed.tools) {
      expect(tool.description ?? "").not.toBe("");
    }
  } finally {
    await close();
  }
});

test("undo は confirm 引数を取らない(計画 R9)", async () => {
  // 意味の定義されていない引数はLLMに誤用される。入力スキーマの時点で存在しないこと。
  const { client, close } = await connectInMemory();
  try {
    const listed = await client.listTools();
    const undoTool = listed.tools.find((tool) => tool.name === "undo");
    expect(Object.keys(undoTool?.inputSchema.properties ?? {})).toEqual(["app_id"]);
  } finally {
    await close();
  }
});

// --- create_app -----------------------------------------------------------------

test("create_app はアプリを作り、空マニフェストとプレビューURLを返す", async () => {
  const data = okData(await callTool("create_app", { name: "蔵書管理", app_id: "book-tracker" }));
  const app = data.app as { app_id: string; name: string; status: string };
  expect(app.app_id).toBe("book-tracker");
  expect(app.name).toBe("蔵書管理");
  const manifest = data.manifest as Manifest;
  expect(manifest.app.tables).toEqual([]);
  expect(manifest.app.views).toEqual([]);
  // 作った直後に人間へ見せられるURLを渡す(会話の中で確認までが1往復で終わる)。
  expect(data.preview_url).toBe(`${previewBaseUrl}/apps/book-tracker`);

  // 台帳から実際に引けること(= list_apps に出ること)を MCP 経由で確かめる。
  const apps = okData(await callTool("list_apps")).apps as { app_id: string }[];
  expect(apps.map((entry) => entry.app_id)).toContain("book-tracker");
});

test("create_app は app_id 省略時に日本語名からIDを自動採番する", async () => {
  const data = okData(await callTool("create_app", { name: "蔵書管理" }));
  const app = data.app as { app_id: string };
  // 日本語は slug 化で全滅するので `app` 系のフォールバックIDになる(`generateAppId`)。
  expect(app.app_id).toMatch(/^[a-z][a-z0-9_-]*$/);
});

test("create_app は空のアプリ名を /name の統一形式エラーで返す(例外を投げない)", async () => {
  const errors = errorsOf(await callTool("create_app", { name: "   " }));
  expect(errors[0]?.path).toBe("/name");
  expect(errors[0]?.message).not.toBe("");
  // 何も作られていない。
  const apps = okData(await callTool("list_apps")).apps as { app_id: string }[];
  expect(apps).toHaveLength(2);
});

test("create_app は規約違反の app_id を /app_id の統一形式エラーで返す", async () => {
  const errors = errorsOf(
    await callTool("create_app", { name: "蔵書管理", app_id: "Book Tracker" }),
  );
  expect(errors[0]?.path).toBe("/app_id");
  expect(errors[0]?.message).toContain("Book Tracker");
  // 規約そのものを添える(LLM が次の1回で正しいIDを作れる形にする)。
  expect(errors[0]?.hint ?? "").not.toBe("");
});

test("create_app は既に使われている app_id を /app_id の統一形式エラーで返す", async () => {
  const errors = errorsOf(await callTool("create_app", { name: "別の在庫", app_id: APP_ID }));
  expect(errors[0]?.path).toBe("/app_id");
  expect(errors[0]?.message).toContain(APP_ID);
  // 衝突相手が分かる形で返す(既存 app_id の一覧、または衝突を名指しするヒント)。
  const clue = `${errors[0]?.hint ?? ""}${(errors[0]?.allowed_values ?? []).join(",")}`;
  expect(clue).toContain(APP_ID);
  // 既存アプリは上書きされていない。
  const manifest = okData(await callTool("get_manifest", { app_id: APP_ID })).manifest as Manifest;
  expect(manifest.app.name).toBe("在庫管理");
  expect(manifest.app.tables).toHaveLength(1);
});

test("F-25: app_id 衝突の hint は、既存アプリの流用を人間に確認せよと指示する", async () => {
  // V0-P7-T04 / docs/v0-findings.md F-25。005/T1 で AI はこのエラーを受けたあと、
  // **人間に確認せずに「では既存アプリを使う」と方針転換した**(結果として後続の
  // シナリオを汚染した)。文面自体は良質(使用済み app_id の全列挙 + 自動採番の
  // 逃げ道)だが、AI が実際に取った第3の道 ——「既存を流用する」—— について
  // 何も言っていなかった。沈黙している選択肢は禁止にも許可にもならない。
  //
  // 「新しいアプリを作って」に対して既存アプリへ書き足すのは前提の変更であり、
  // apply_diff は additive で取り消しには undo(DB全体の巻き戻し)しか無い。
  // したがって自律ではなく確認が要る、と判断した。根拠は docs/v0-t04-record.md。
  const errors = errorsOf(await callTool("create_app", { name: "別の在庫", app_id: APP_ID }));
  const hint = errors[0]?.hint ?? "";
  expect(hint).toContain("確認");
  // 既存の逃げ道2つ(別ID / 自動採番)を消していないこと。追記であって置換ではない。
  expect(hint).toContain("自動採番");
});

// --- F-23: 説明文に載せた JSON 例が、本当に通る形かを実行して確かめる -------------------
//
// **このテストが T04 でいちばん効いている。** 例を書き下ろした最初の版は4つとも
// 間違っていた —— `add_table` の fields を空配列にし、ビュー定義に `name` を付け、
// `kind` と書き(正しくは `type`)、`sort` を配列にしていた。
// つまり **F-1 / F-4 としてAIが実地で外したのと同じ間違いを、例そのものが踏んでいた。**
//
// **V1-M0-T03 で、そのうち2つは「間違い」ではなくなった。** ビュー定義の `name` は
// T02(F-1)で受理側に移り、`sort` の配列は T03(F-2)でスキーマ側が受け入れた。
// **AI が4試行4回書いた形と、例を書いたときに手が滑った形と、いまの正しい形が一致した。**
// このテストは形が変わっても落ちない —— 落ちるのは**例と実装が食い違ったとき**だけである。
//
// 間違った例を載せるのは、例を載せないことより悪い。エラーから自己修正できていた
// LLM(F-14)に、わざわざ誤った形を教え込むことになるからである。
// 目視レビューではこの4件は見つからなかった。**実行して初めて分かった。**
//
// したがって定数の中の JSON を**実際に取り出して apply_diff に流す**。
// スキーマが将来変わったとき、説明文だけが古いまま残ることも同時に防げる。

/**
 * `APPLY_DIFF_OP_EXAMPLES` から、行頭がインデント付き `{` の行を JSON として取り出す。
 *
 * **V1-M2-T02: `"op"` を含むことを条件に加えた。** 同定数の末尾に
 * `WORKFLOW_HISTORY_TABLE_TEMPLATE` を連結したことで、**op ではない1行 JSON**
 * (ひな形の `fields` の各要素 `{ "id": "ran_at", ... }`)が定数の中に現れる。
 * 条件を足さないと、それらが差分 op として拾われて下の並び順テストが壊れる
 * (**壊れ方が「例が1つ増えた」に見えるので原因が分かりにくい**)。
 * op 例の側は必ず `"op"` キーを持つので、これで過不足なく分かれる。
 */
function exampleOperations(): Record<string, unknown>[] {
  return APPLY_DIFF_OP_EXAMPLES.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}") && line.includes('"op"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * `WORKFLOW_HISTORY_TABLE_TEMPLATE` の中の複数行 JSON を、**実際の差分 op として**取り出す。
 *
 * **これが「手書きの複製」に対する本命の歯止めである。**ひな形は
 * `src/kernel/workflow-runner.ts` の `WORKFLOW_HISTORY_COLUMNS` を手で写したもので、
 * 値として import していない(ADR-0009 限定2 の import スナップショットを増やさないため)。
 * **列IDか型が実装からずれたら、この op で作ったテーブルにワークフローが履歴を
 * 書けなくなる** —— 下の完了条件4 のテストがそこで赤くなる。
 * 文字列の目視ではなく、**ひな形どおりに作ったテーブルが実際に動くこと**で固定する。
 *
 * 抽出は波括弧の対応で行う(行数や字下げに依存しない)。
 */
function historyTableTemplateOperation(): Record<string, unknown> {
  const lines = WORKFLOW_HISTORY_TABLE_TEMPLATE.split("\n");
  const start = lines.findIndex((line) => line.trim() === "{");
  expect(start).toBeGreaterThanOrEqual(0);
  const collected: string[] = [];
  let depth = 0;
  for (const line of lines.slice(start)) {
    collected.push(line);
    for (const character of line) {
      if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
      }
    }
    if (depth === 0) {
      break;
    }
  }
  expect(depth).toBe(0);
  return JSON.parse(collected.join("\n")) as Record<string, unknown>;
}

/**
 * `APPLY_DIFF_OP_EXAMPLES` の中の **run_function を使うワークフロー例**(複数行 JSON)を取り出す。
 *
 * **V1-M6-T05: この例は単一行ではないので `exampleOperations` は拾わない**
 * (拾わせると2つ目の add_workflow として畳み込み手順に混ざり、monthly-signups 関数と
 * monthly_counts テーブルが存在しない位置で参照整合性に落ちる)。そこで独立に抜き出し、
 * **このテストが説明文の例をそのまま apply_diff へ流して腐っていないことを固定する。**
 * 抽出は波括弧の対応で行う(行数や字下げに依存しない)。定数内には複数行 JSON が
 * 2つある(run_function の add_workflow と、末尾テンプレートの add_table workflow-runs)ので、
 * `run_function` を含むブロックを選ぶ。
 */
function runFunctionWorkflowExample(): Record<string, unknown> {
  const lines = APPLY_DIFF_OP_EXAMPLES.split("\n");
  for (let start = 0; start < lines.length; start += 1) {
    if (lines[start]?.trim() !== "{") {
      continue;
    }
    const collected: string[] = [];
    let depth = 0;
    for (const line of lines.slice(start)) {
      collected.push(line);
      for (const character of line) {
        if (character === "{") {
          depth += 1;
        } else if (character === "}") {
          depth -= 1;
        }
      }
      if (depth === 0) {
        break;
      }
    }
    const text = collected.join("\n");
    if (text.includes('"run_function"')) {
      return JSON.parse(text) as Record<string, unknown>;
    }
  }
  throw new Error("run_function を含むワークフロー例が APPLY_DIFF_OP_EXAMPLES に見つかりません");
}

// **【`V5-M17b` / `ADR-0248`】旧テスト名の逐語は「F-23: 説明文の JSON 例は16あり、16の op を1つずつ網羅している」。**
// **【`V8-M16-T03` / `J-G1b` / `D-V8-31`】旧テスト名の逐語は「F-23: 説明文の JSON 例は17あり、17の op を1つずつ網羅している」である。**
// **18種目 `set_roles` を足したので、テスト名と期待値を同時に実体へ合わせた。検査は消していない。**
test("F-23: 説明文の JSON 例は18あり、18の op を1つずつ網羅している", () => {
  const operations = exampleOperations();
  // **`DIFF_OPS` を真とみなす照合は `vocabulary.test.ts` に置いてある**
  // (ADR-0009 限定2 の import スナップショットを増やさないため)。
  // ここは並び順を見る。
  //
  // **V1-M1(ADR-0012): 並び順はもう `DIFF_OPS` と同じではない。** `DIFF_OPS` は
  // `remove_view` を末尾に置いているが、例の側では `remove_table` の**前**に無ければ
  // ならない —— 例は前から順に畳み込まれる1本の手順であり、`drafts` に載っている
  // `draft-list` を先に消さなければ `remove_table` が拒否されるからである
  // (説明文の注意(7)(8) そのもの)。**`DIFF_OPS` の宣言順に揃えると例が動かなくなる。**
  // ここで固定するのは「宣言順との一致」ではなく「**手順として成立する順序**」である。
  expect(operations.map((operation) => operation.op)).toEqual([
    "add_table",
    "add_field",
    "add_view",
    "update_view",
    "remove_field",
    "remove_view",
    "remove_table",
    "change_table",
    "change_field",
    // **V1-M2-T07(ADR-0013): ワークフロー3種は末尾に置いた。** ここも並び順の理由が
    // ある —— `add_workflow` の `trigger.table` は直前の `change_table` が books を
    // library にリネームしたあとの **library** を指している。リネームは
    // `app.workflows` へはカスケードしない(`apply-diff.ts` は workflows を書き換え
    // ない)ので、**ワークフローの例を `change_table` より前に置くと、
    // 参照整合性が「存在しないテーブル books を指している」として差分全体を拒否する。**
    // つまりこの位置は好みではなく、手順として成立する唯一に近い置き場である。
    // 3つの並び(add → update → remove)自体も手順である —— 同じIDに対して
    // 足す・丸ごと置き換える・消すを順に行っている。
    "add_workflow",
    "update_workflow",
    "remove_workflow",
    // **V1-M6-T05(ADR-0024): 関数3種も末尾に置いた。** ここも並び順の理由がある ——
    // add_function / update_function の `input.table` は `members` を指しており、この例は
    // add_function → update_function → remove_function を同じIDに対して順に行う手順である
    // (add → 丸ごと置き換え → 消す)。`members` はテスト側の下ごしらえで先に用意する。
    // **run_function を使うワークフロー例は複数行 JSON なので `exampleOperations` は拾わない**
    // (専用テスト "V1-M6-T05: run_function ..." が別に検証する)。
    "add_function",
    "update_function",
    "remove_function",
    // **V3-M1-T03(ADR-0047): 16種目 set_theme も末尾に置いた。**ここも並び順に理由がある
    // —— テーマはテーブル・ビュー・ワークフロー・関数を1つも参照しないので、
    // **手順のどこに置いても成立する唯一の op である。**末尾に置いたのは、
    // 追加された順序を保つためだけである(手順上の制約ではない)。
    // **例は25スロット全部を書いている** —— `$defs/theme` の `required` が全スロットで
    // あり(ADR-0047 2026-07-25 追記(2))、これが「最小の書き方」だからである。
    // 下の「例はそのまま apply_diff に通せる本物の差分である」が実際に適用して確かめる
    // (**コントラスト検査も通る配色になっていることを含めて**。ADR-0047 限定8)。
    "set_theme",
    // **V5-M17b(ADR-0248): 17種目 set_user_kinds も末尾に置いた。**ここも並び順に理由がある
    // —— 利用者の種類の宣言はテーブル・ビュー・ワークフロー・関数・テーマを1つも
    // 参照しないので、**手順のどこに置いても成立する2つ目の op である。**末尾に置いたのは
    // 追加された順序を保つためだけである(手順上の制約ではない)。
    // **例は2件だけ書いている** —— `minItems` が 1 なので1件でも通るが、**「複数の非運営の
    // 種類を持てる」ことが本決定の目的そのものである**(`ADR-0158` §2 問2③)。
    //
    // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】**
    // **旧(逐語)**: この位置に `"set_user_kinds",` が在った。
    // **上の段落は `V5-M17b` 制定時の事実であり、1バイトも消していない。**
    // **`src/mcp/vocabulary.ts` の `APPLY_DIFF_OP_EXAMPLES` から
    // `{ "op": "set_user_kinds", … }` の例を取り除いた**(旧の1行はそちらに逐語で残した)——
    // **`DIFF_OPS` から op が消え、その例をそのまま `apply_diff` に流すと拒否されるためである。**
    // **V8-M16-T03(台帳 `J-G1b` / `D-V8-31`): 18種目 set_roles も末尾に置いた。**ここも
    // 並び順に理由がある —— 役割の宣言はテーブル・ビュー・ワークフロー・関数・テーマ・
    // 利用者の種類の宣言を1つも参照しないので、**手順のどこに置いても成立する3つ目の op
    // である。**末尾に置いたのは追加された順序を保つためだけである(手順上の制約ではない)。
    // **例は2件だけ書いている** —— `minItems` が 1 なので1件でも通るが、**予約4語も
    // 宣言分の識別子も主体として書けることが本決定の目的そのものである**(裁定 `R-2`)。
    "set_roles",
  ]);
});

test("F-2 / F-23: 説明文が『sort は配列ではない』と言っていないこと(V1-M0-T03)", () => {
  // T04 は当時のスキーマに合わせて「sort はオブジェクト1つであって配列ではない」と
  // 書いた。T03 でスキーマが配列を受理するようになったので、この一文が残っていると
  // **説明文が嘘になる**(計画書 V1-M0-T03 の完了条件4 / ADR-0007 歯止め3 の Δ5)。
  // 文言そのものを禁止しておかないと、将来の編集で静かに戻ってくる。
  expect(APPLY_DIFF_OP_EXAMPLES).not.toContain("配列ではない");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("sort は**配列**である");
});

test("F-23: 説明文の JSON 例は、そのまま apply_diff に通せる本物の差分である", async () => {
  const operations = exampleOperations();
  // 例は books テーブルを新規に作るところから始まるので、素のアプリに対して流す。
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "例の検証", { app_id: "examples" });
  } finally {
    store.close();
  }
  seedActor("examples");

  // **V1-M1-T06: 2つの差分に分けて流す。** 例どうしは前から順に積み上がる関係にあるが、
  // **`remove_table` の例だけは同じ差分に入れられない** —— 破壊的4 op が対象にできる
  // のは「その時点のマニフェストに実在するもの」であり、`remove_table` の例が消す
  // `drafts` は additive 4例のどれも作らないからである。
  //
  // **`drafts` を別テーブルにしたのは、例を通すための都合ではない。**
  // `books` には `book-list` が載っており、**画面から参照されているテーブルは、
  // その画面を消してからでないと remove_table できない**(ビューの `table` は
  // `update_view` で変えられない。ADR-0010 §7a: カスケード削除は採らない)。
  //
  // **V1-M1(ADR-0012)で例の形が変わった。** `remove_view` が語彙に入ったので、
  // 例は「`draft-list` を消してから `drafts` を消す」という**正しい手順そのもの**に
  // なっている(旧: どの画面からも参照されていないテーブルを選んで回避していた)。
  // したがって下ごしらえも、テーブルだけでなく**その画面まで**用意する必要がある ——
  // 用意しなければ `remove_view` が「対象ビューが存在しません」で落ち、
  // **例が手順として成立していないことがここで赤くなる。**
  const additive = operations.slice(0, 4);
  const destructive = operations.slice(4);

  const added = await callTool("apply_diff", {
    app_id: "examples",
    diff: {
      diff_id: "d-examples-add",
      intent: "説明文の例(足すだけの4つ)がそのまま通ることを確かめる",
      operations: additive,
    },
  });
  // 落ちたときに「例のどこが間違っているか」がそのまま読めるように errors を出す。
  expect({ isError: added.isError, errors: added.isError ? errorsOf(added) : [] }).toEqual({
    isError: undefined,
    errors: [],
  });

  const manifest = okData(added).manifest as Manifest;
  expect(manifest.app.tables.map((table) => table.id)).toContain("books");
  // `View` は type ごとに持てる属性が違う union なので、list_view に絞ってから読む
  // (`columns` / `sort` は FormView には存在しない)。例が list_view であること自体も
  // ここで確かめていることになる。
  const view = manifest.app.views.find(
    (candidate): candidate is ListView =>
      candidate.id === "book-list" && candidate.type === "list_view",
  );
  expect(view).toBeDefined();
  // update_view の例が効いていること(columns が絞られ、sort が入っている)。
  expect(view?.columns).toEqual(["title"]);
  // V1-M0-T03: 例は**配列**になった。単数オブジェクトのままなら説明文が嘘になる
  // (計画書 V1-M0-T03 完了条件4)。
  expect(view?.sort).toEqual([{ field: "title", order: "asc" }]);

  // `remove_table` の例が消す対象を用意する。**テスト側の下ごしらえであって、
  // 説明文の例ではない**(例の側に混ぜると、AI に「drafts を作れ」と教えることになる)。
  const seeded = await callTool("apply_diff", {
    app_id: "examples",
    diff: {
      diff_id: "d-examples-seed",
      intent:
        "remove_view / remove_table の例が消す対象と、ワークフロー・関数の例が指す先を用意する",
      operations: [
        // **V1-M6-T05: add_function / update_function の例の input.table が指す `members`。**
        // `drafts` / `notifications` と同じ理由で例の側には混ぜない(混ぜると「関数を足すには
        // 毎回 members を作れ」と AI に教えることになる)。カーネルは自動生成しないので、
        // 存在しないテーブルを input.table に指す add_function は差分全体が拒否される(ADR-0024 §8)。
        {
          op: "add_table",
          table: {
            id: "members",
            name: "会員",
            fields: [{ id: "joined_at", name: "入会日", type: "date" }],
          },
        },
        {
          op: "add_table",
          table: {
            id: "drafts",
            name: "下書き",
            fields: [{ id: "memo", name: "メモ", type: "text" }],
          },
        },
        {
          op: "add_view",
          view: {
            id: "draft-list",
            name: "下書き一覧",
            type: "list_view",
            table: "drafts",
            columns: ["memo"],
          },
        },
        // **V1-M2-T07: ワークフローの例が指す2テーブルも下ごしらえで用意する。**
        // 例の側に `add_table` を混ぜないのは `drafts` と同じ理由である —— 混ぜると
        // 「ワークフローを足すには毎回テーブルを2本作れ」と AI に教えることになる。
        // **ただしカーネルがこれらを自動生成しないことは本当である**(ADR-0013 限定8)。
        // `history_table` を自分で作らなければならないことは注意(11)が文章で述べている。
        {
          op: "add_table",
          table: {
            id: "notifications",
            name: "通知",
            fields: [
              { id: "title", name: "件名", type: "text" },
              { id: "source", name: "対象", type: "text" },
            ],
          },
        },
        // **V1-M2-T02: ひな形(`WORKFLOW_HISTORY_TABLE_TEMPLATE`)そのものを流す。**
        // 以前はここだけ `result` 1列の便宜的な形だったが、**説明文が5列の規約を
        // 述べるようになった以上、テストの下ごしらえがそれと違う形を使っていると、
        // 「規約と違う形でも通る」ことをテスト自身が実演してしまう。**
        // ひな形を実際に apply_diff へ流して通ることの確認も、ここで同時に済む。
        historyTableTemplateOperation(),
      ],
    },
  });
  expect(seeded.isError).toBeUndefined();

  const removed = await callTool("apply_diff", {
    app_id: "examples",
    diff: {
      diff_id: "d-examples-destructive",
      intent: "説明文の例(破壊的な4つ)がそのまま通ることを確かめる",
      operations: destructive,
    },
  });
  expect({ isError: removed.isError, errors: removed.isError ? errorsOf(removed) : [] }).toEqual({
    isError: undefined,
    errors: [],
  });

  const after = okData(removed).manifest as Manifest;
  // remove_view の例が効いた(画面だけが消えた)。
  expect(after.app.views.map((candidate) => candidate.id)).not.toContain("draft-list");
  // remove_table の例が効いた。**順序が意味を持つ** —— remove_view が先に効いて
  // いなければ、この remove_table は「画面から参照されている」として拒否される。
  expect(after.app.tables.map((table) => table.id)).not.toContain("drafts");
  // change_table の例が効いた(id のリネームと表示名の変更)。
  expect(after.app.tables.map((table) => table.id)).toContain("library");
  expect(after.app.tables.find((table) => table.id === "library")?.name).toBe("蔵書");
  // remove_field の例が効いた(author が消え、title だけが残る)。
  const fields = after.app.tables.find((table) => table.id === "library")?.fields ?? [];
  expect(fields.map((field) => field.id)).toEqual(["title"]);
  // change_field の例が効いた(型が変わった)。
  expect(fields[0]?.type).toBe("long_text");
  // **V1-M2-T07: ワークフロー3例が手順として成立した。**
  // `app.workflows` が `undefined` ではなく `[]` であることが、
  // **add_workflow が実際に走り(未定義のキーを空配列に初期化し)、
  // そのあと remove_workflow が最後の1本を取り除いた**ことの機械的な証拠である。
  // 3つのどれかが落ちていれば差分全体が拒否され、ここまで来ない。
  expect(after.app.workflows).toEqual([]);
  // **V1-M6-T05: 関数3例(add → update → remove)が手順として成立した。**
  // `app.functions` が `undefined` ではなく `[]` であることが、add_function が実際に走り
  // (未定義のキーを空配列に初期化し)、そのあと remove_function が最後の1本を取り除いた
  // ことの機械的な証拠である。add_function / update_function は `members` を input.table に
  // 指しているので、下ごしらえで members を用意していなければ参照整合性で拒否され、ここまで来ない。
  expect(after.app.functions).toEqual([]);
  // **注意(7)の実測**: リネームにビューの table が自動追随している(ADR-0010 §5d)。
  const followed = after.app.views.find(
    (candidate): candidate is ListView =>
      candidate.id === "book-list" && candidate.type === "list_view",
  );
  expect(followed?.table).toBe("library");
});

test("V1-M6-T05: 説明文の run_function ワークフロー例は、そのまま apply_diff に通せる本物の差分である", async () => {
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "run_function の例の検証", { app_id: "rf-example" });
  } finally {
    store.close();
  }
  seedActor("rf-example");

  // 下ごしらえ: run_function の例が指す関数(monthly-signups)・入力テーブル(members)・
  // 出力先(monthly_counts)・実行履歴テーブルを用意する。**存在しないIDを指す run_function は
  // 差分全体が拒否される**(ADR-0024 §8)ので、ここが揃っていなければ本命の適用は落ちる。
  // 関数本体は説明文の add_function 例そのものを流用する(例が腐らない担保)。
  const addFunction = exampleOperations().find((operation) => operation.op === "add_function");
  expect(addFunction).toBeDefined();
  const seeded = await callTool("apply_diff", {
    app_id: "rf-example",
    diff: {
      diff_id: "d-rf-seed",
      intent: "run_function の例が指す関数・入出力テーブル・履歴テーブルを用意する",
      operations: [
        {
          op: "add_table",
          table: {
            id: "members",
            name: "会員",
            fields: [{ id: "joined_at", name: "入会日", type: "date" }],
          },
        },
        {
          op: "add_table",
          table: {
            id: "monthly_counts",
            name: "月別件数",
            fields: [
              { id: "month", name: "月", type: "text" },
              { id: "count", name: "件数", type: "number" },
            ],
          },
        },
        historyTableTemplateOperation(),
        addFunction as Record<string, unknown>,
      ],
    },
  });
  expect({ isError: seeded.isError, errors: seeded.isError ? errorsOf(seeded) : [] }).toEqual({
    isError: undefined,
    errors: [],
  });

  // 本命: 説明文の run_function ワークフロー例(複数行 JSON)をそのまま適用する。
  const applied = await callTool("apply_diff", {
    app_id: "rf-example",
    diff: {
      diff_id: "d-rf-apply",
      intent: "説明文の run_function ワークフロー例がそのまま通ることを確かめる",
      operations: [runFunctionWorkflowExample()],
    },
  });
  expect({ isError: applied.isError, errors: applied.isError ? errorsOf(applied) : [] }).toEqual({
    isError: undefined,
    errors: [],
  });

  const manifest = okData(applied).manifest as Manifest;
  const workflow = manifest.app.workflows?.find(
    (candidate) => candidate.id === "recalc-monthly-signups",
  );
  expect(workflow).toBeDefined();
  // run_function アクションが function / output_table を正しく持って通っていること。
  expect(workflow?.actions[0]).toMatchObject({
    action: "run_function",
    function: "monthly-signups",
    output_table: "monthly_counts",
  });
});

// --- apply_diff -----------------------------------------------------------------

test("apply_diff は差分を適用して manifest / plan / snapshot / entry を返す", async () => {
  const data = okData(await callTool("apply_diff", { app_id: APP_ID, diff: ratingDiff }));
  const manifest = data.manifest as Manifest;
  expect(manifest.app.tables[0]?.fields.map((field) => field.id)).toEqual([
    "title",
    "qty",
    "rating",
  ]);
  const plan = data.plan as { add_fields: { table: string; field: { id: string } }[] };
  expect(plan.add_fields.map((step) => `${step.table}.${step.field.id}`)).toEqual([
    `${TABLE_ID}.rating`,
  ]);
  expect(data.snapshot).toBe("0002-d-rating");
  const entry = data.entry as ChangelogEntry;
  expect(entry.kind).toBe("apply");
  expect(entry.intent).toBe(ratingDiff.intent);
});

// --- `V8-M18`: 誰も通さない条件・全員を通す条件の知らせ(台帳 `J-G16`)---------------
//
// **限定の逐語は「**書いた人に返る形で伝える**」である。** **書いた人に返る道は
// `apply_diff` の応答であり、ここがその実測点である。**
// **拒否ではない** —— **`isError` にせず、差分は適用される。**

/** 既定3本(`owner` / `editor` / `viewer`)は消せない(`V8-M17` の適用時検査)。 */
// **【`V8-M28` / 台帳 `T-G16a`(2026-08-11)。旧の逐語を残す。1バイトも消していない】**
// **旧: `const DEFAULT_ROLES = [{ id: "owner" }, { id: "editor" }, { id: "viewer" }];`**
// **今日は持ち主(`owner`)に `{"target":"app","can":["write"]}` と
// `{"target":"role","can":["write"]}` の2本が要る** —— **適用時検査(類型17 の拡張)が
// 両方の実在を要求し、片方でも欠けた `set_roles` は拒否される。**
// **`editor` / `viewer` には1本も入れない**(ユーザ決定 `D-V8-59` は持ち主だけを名指ししている)。
const DEFAULT_ROLES = [
  {
    id: "owner",
    rules: [
      { target: "app", can: ["write"] },
      { target: "role", can: ["write"] },
    ],
  },
  { id: "editor" },
  { id: "viewer" },
];

type RoleConditionNoticeShape = { kind: string; role: string; path: string; message: string };

async function applyRoleCondition(
  diffId: string,
  when: unknown,
  roleId = "member",
): Promise<CallToolResult> {
  return callTool("apply_diff", {
    app_id: APP_ID,
    diff: {
      diff_id: diffId,
      intent: "役割の規則に条件を付ける",
      operations: [
        {
          op: "set_roles",
          roles: [
            ...DEFAULT_ROLES,
            {
              id: roleId,
              name: "会員",
              rules: [{ target: "table", table: TABLE_ID, can: ["read"], when }],
            },
          ],
        },
      ],
    },
  });
}

test("apply_diff は誰も通さない条件を、拒否せずに知らせとして返す(`J-G16`)", async () => {
  const result = await applyRoleCondition("d-never", {
    and: [
      { field: "title", equals: "A" },
      { field: "title", equals: "B" },
    ],
  });
  // **適用は通っている。****`isError` にしない。**
  expect(result.isError).toBeFalsy();
  const notices = okData(result).role_condition_notices as RoleConditionNoticeShape[];
  expect(notices).toHaveLength(1);
  expect(notices[0]?.kind).toBe("never_matches");
  expect(notices[0]?.role).toBe("member");
  expect(notices[0]?.path).toBe("/app/roles/3/rules/0/when");
  expect(notices[0]?.message).toContain("誰も通さない");
});

test("apply_diff は全員を通す条件を、拒否せずに知らせとして返す(`J-G16`)", async () => {
  const result = await applyRoleCondition("d-always", {
    or: [{ field: "title", equals: "A" }, { not: { field: "title", equals: "A" } }],
  });
  expect(result.isError).toBeFalsy();
  const notices = okData(result).role_condition_notices as RoleConditionNoticeShape[];
  expect(notices.map((notice) => notice.kind)).toEqual(["always_matches"]);
  expect(notices[0]?.message).toContain("全員を通す");
});

test("apply_diff の知らせの欄は常に在る(「黙って何もしない」を作らない。`J-G16`)", async () => {
  // **条件を1本も書いていない差分でも、欄は空配列で返る** —— **欄が無い応答と
  // 「矛盾が無い」応答を、書いた人が区別できるようにするためである。**
  const data = okData(await callTool("apply_diff", { app_id: APP_ID, diff: ratingDiff }));
  expect(data.role_condition_notices).toEqual([]);
});

test("apply_diff は intent が空文字の差分を受け付けない", async () => {
  // intent は changelog の本体(憲法5: changelog が要件定義書)。空文字を通すと
  // 「なぜこの変更を入れたか」が永久に失われるので、入力スキーマの時点で拒む。
  const result = await callTool("apply_diff", {
    app_id: APP_ID,
    diff: { diff_id: "d-empty", intent: "", operations: [] },
  });
  expect(result.isError).toBe(true);
  // 適用されていない(changelog は createApp の第0行 + setup の2件のまま)。
  const changelog = okData(await callTool("get_changelog", { app_id: APP_ID }))
    .changelog as ChangelogEntry[];
  expect(changelog).toHaveLength(2);
});

test("apply_diff は語彙外の破壊的操作をカーネルの統一形式エラーで拒否し、状態を変えない", async () => {
  const before = await listRecordsVia();
  const errors = errorsOf(
    await callTool("apply_diff", {
      app_id: APP_ID,
      diff: {
        diff_id: "d-remove",
        intent: "数量フィールドを消したい",
        operations: [{ op: "remove_field", table: TABLE_ID, field: "qty" }],
      },
    }),
  );
  expect(errors.length).toBeGreaterThan(0);
  for (const error of errors) {
    expect(typeof error.path).toBe("string");
    expect(error.message.length).toBeGreaterThan(0);
  }
  // isError: true は「何も変わっていない」を意味する、という規約の実証。
  const manifest = okData(await callTool("get_manifest", { app_id: APP_ID })).manifest as Manifest;
  expect(manifest.app.tables[0]?.fields.map((field) => field.id)).toEqual(["title", "qty"]);
  expect(await listRecordsVia()).toEqual(before);
});

test("apply_diff は実在しない app_id に統一形式エラーを返す", async () => {
  expectUnknownAppError(await callTool("apply_diff", { app_id: "nope", diff: ratingDiff }));
});

// --- undo -----------------------------------------------------------------------

test("undo は直前の apply を取り消し、事前に取った preview を一緒に返す", async () => {
  okData(await callTool("apply_diff", { app_id: APP_ID, diff: ratingDiff }));

  const data = okData(await callTool("undo", { app_id: APP_ID }));
  // R2: preview は undo の**前に**取られていなければならない。undo 後に呼ぶと
  // 現DBとスナップショットが一致するので、対象の情報が出てこない。
  const preview = data.preview as UndoPreview;
  expect(preview.diff_id).toBe(ratingDiff.diff_id);
  expect(preview.intent).toBe(ratingDiff.intent);
  expect(preview.operations).toEqual(ratingDiff.operations);

  const entry = data.entry as ChangelogEntry;
  expect(entry.kind).toBe("undo");
  expect(entry.undo_target_seq).toBe(preview.target_seq);
  expect(data.restored_from).toBe("0002-d-rating");
  expect(typeof data.snapshot).toBe("string");

  // rating フィールドが消えている。
  const manifest = data.manifest as Manifest;
  expect(manifest.app.tables[0]?.fields.map((field) => field.id)).toEqual(["title", "qty"]);
});

test("undo は取り消せる変更が無いアプリに統一形式エラーを返す", async () => {
  const errors = errorsOf(await callTool("undo", { app_id: "expense" }));
  expect(errors[0]?.message).not.toBe("");
});

test("undo は実在しない app_id に統一形式エラーを返す", async () => {
  expectUnknownAppError(await callTool("undo", { app_id: "nope" }));
});

// --- insert_sample_data ---------------------------------------------------------

test("insert_sample_data は全行を投入して inserted に作られたレコードを返す", async () => {
  const data = okData(
    await callTool("insert_sample_data", {
      app_id: APP_ID,
      table_id: TABLE_ID,
      rows: [
        { title: "椅子", qty: 3 },
        { title: "机", qty: 1 },
      ],
    }),
  );
  const inserted = data.inserted as RecordRow[];
  expect(inserted).toHaveLength(2);
  expect(data.failed).toEqual([]);
  // `_id` が返るので、参照フィールドを埋める次の投入でそのまま使える。
  for (const row of inserted) {
    expect(row._id).toMatch(/^[0-9a-f-]{36}$/);
  }
  expect(await listRecordsVia()).toHaveLength(2);
});

test("insert_sample_data の部分成功は isError:false で、failed に行番号とエラーが入る", async () => {
  // R7: 他ツールの `isError: true` は「何も変わっていない」を意味する。部分成功で
  // それを立てると意味が二重化し、LLM が rows 全体を再送して成功行を重複させる。
  const result = await callTool("insert_sample_data", {
    app_id: APP_ID,
    table_id: TABLE_ID,
    rows: [{ title: "椅子", qty: 3 }, { qty: 1 }, { title: "棚", qty: 2 }],
  });
  expect(result.isError).toBeFalsy();
  const data = result.structuredContent as {
    inserted: RecordRow[];
    failed: { index: number; errors: ValidationError[] }[];
  };
  expect(data.inserted).toHaveLength(2);
  expect(data.failed).toHaveLength(1);
  expect(data.failed[0]?.index).toBe(1);
  expect(data.failed[0]?.errors[0]?.message).not.toBe("");
  // 成功した2件は残っている(= 部分成功であって、巻き戻しではない)。
  expect(await listRecordsVia()).toHaveLength(2);
});

test("insert_sample_data は失敗した index の行だけ再送すれば重複せず全件そろう(R7 の再試行パス)", async () => {
  const first = (
    await callTool("insert_sample_data", {
      app_id: APP_ID,
      table_id: TABLE_ID,
      rows: [{ title: "椅子", qty: 3 }, { qty: 1 }, { title: "棚", qty: 2 }],
    })
  ).structuredContent as { failed: { index: number }[] };
  expect(first.failed.map((failure) => failure.index)).toEqual([1]);

  // description が指示するとおり、失敗した index の行だけを直して再送する。
  const retry = okData(
    await callTool("insert_sample_data", {
      app_id: APP_ID,
      table_id: TABLE_ID,
      rows: [{ title: "机", qty: 1 }],
    }),
  );
  expect(retry.failed).toEqual([]);

  const records = await listRecordsVia();
  expect(records).toHaveLength(3);
  // 重複が無いこと(タイトルが3種そろい、同じものが2回入っていない)。
  expect(records.map((record) => record.title).sort()).toEqual(["机", "棚", "椅子"].sort());
});

test("insert_sample_data は実在しないテーブルを統一形式エラーで拒否し、1行も入れない", async () => {
  const errors = errorsOf(
    await callTool("insert_sample_data", {
      app_id: APP_ID,
      table_id: "nope",
      rows: [{ title: "椅子" }],
    }),
  );
  expect(errors[0]?.allowed_values).toEqual([TABLE_ID]);
  expect(await listRecordsVia()).toHaveLength(0);
});

test("insert_sample_data は実在しない app_id に統一形式エラーを返す", async () => {
  expectUnknownAppError(
    await callTool("insert_sample_data", { app_id: "nope", table_id: TABLE_ID, rows: [] }),
  );
});

// --- システムテーブルへの投入(ADR-0006 §7)-----------------------------------------

test("insert_sample_data はシステムテーブルを読み取り専用エラーで拒む(存在しないとは言わない)", async () => {
  const result = await callTool("insert_sample_data", {
    app_id: APP_ID,
    table_id: "_apps",
    rows: [{ app_id: "x", name: "x" }],
  });

  const errors = errorsOf(result);
  expect(errors).toHaveLength(1);
  expect(errors[0]?.path).toBe("");
  expect(errors[0]?.message).toContain("読み取り専用");
  // `_apps` は存在する。「存在しません」は嘘であり、add_table への誤誘導を生む。
  expect(errors[0]?.message).not.toContain("存在しません");
  expect(errors[0]?.allowed_values).toEqual([TABLE_ID]);
  expect(errors[0]?.hint ?? "").not.toContain("add_table");
});

// --- update_record / delete_record(V1-M0-T01 / F-13 / F-37)------------------------
//
// **v0 で最も深刻な穴**(CP-6 の N1)を塞ぐツールである —— v0 の書き込みは
// `insert_sample_data` だけで、**AI が自分で投入して壊したデータを AI が直せなかった**。
//
// カーネルの `updateRecord` / `deleteRecord` は v0 から存在し、HTTP 側
// (`src/server/app.ts` の PATCH / DELETE)が既に同じ関数を開けている。
// したがってここで確かめるのは「能力があるか」ではなく、**入口の開け方**である:
//
// 1. 委譲だけであること(MCP 層が独自の判定順序・独自のエラー本文を作っていない)
// 2. ADR-0006 §7 の判定順序 —— **読み取り専用の拒否がレコードの存在確認より前** ——
//    がそのまま流れていること(完了条件2)
// 3. 異常系が Phase 1 の統一形式(path / message / hint)で返ること(完了条件3)
// 4. `confirm` のようなフラグ引数が無いこと(完了条件4 / F-38)

/** `title` と `qty` を持つ備品を1件入れて `_id` を返す。 */
async function insertOne(title: string, qty: number): Promise<string> {
  const data = okData(
    await callTool("insert_sample_data", {
      app_id: APP_ID,
      table_id: TABLE_ID,
      rows: [{ title, qty }],
    }),
  );
  const inserted = data.inserted as RecordRow[];
  const id = inserted[0]?._id;
  if (typeof id !== "string") {
    throw new Error(`テスト前提のレコード投入に失敗しました: ${JSON.stringify(data)}`);
  }
  return id;
}

/** `select` と `reference` の検証(完了条件3)を試すための追加差分を当てる。 */
async function applyValidationFixtures(): Promise<void> {
  const result = await callTool("apply_diff", {
    app_id: APP_ID,
    diff: {
      diff_id: "d-validation",
      intent: "備品の状態と持ち主を記録したい",
      operations: [
        {
          op: "add_table",
          table: {
            id: "owners",
            name: "持ち主",
            fields: [{ id: "name", name: "氏名", type: "text", required: true }],
          },
        },
        {
          op: "add_field",
          table: TABLE_ID,
          field: { id: "status", name: "状態", type: "select", options: ["在庫", "貸出中"] },
        },
        {
          op: "add_field",
          table: TABLE_ID,
          field: {
            id: "owner",
            name: "持ち主",
            type: "reference",
            reference_table: "owners",
          },
        },
      ],
    },
  });
  if (result.isError === true) {
    throw new Error(
      `テスト前提の差分適用に失敗しました: ${JSON.stringify(result.structuredContent)}`,
    );
  }
}

// --- 完了条件1: 正常系 ---------------------------------------------------------------

test("完了条件1: update_record は1件を部分更新し、渡していないフィールドは消えない", async () => {
  const id = await insertOne("椅子", 3);

  const data = okData(
    await callTool("update_record", {
      app_id: APP_ID,
      table_id: TABLE_ID,
      record_id: id,
      changes: { qty: 10 },
      if_match: await versionVia(id),
    }),
  );

  const record = data.record as RecordRow;
  expect(record._id).toBe(id);
  expect(record.qty).toBe(10);
  // **部分更新であることが要点。** `changes` に入れなかった `title` が null に
  // 潰れるようだと、AI が1項目を直すたびに他の項目を失う。
  expect(record.title).toBe("椅子");

  // list_records から見ても変わっている(F-13 の「訂正できる」はここまでで成立する)。
  const records = await listRecordsVia();
  expect(records).toHaveLength(1);
  expect(records[0]?.qty).toBe(10);
  expect(records[0]?.title).toBe("椅子");
  // `_id` / `_created_at` は変わらず、`_updated_at` は進む(カーネルの保証をそのまま流す)。
  expect(records[0]?._created_at).toBe(record._created_at);
  expect(String(record._updated_at) >= String(record._created_at)).toBe(true);
});

test("完了条件1: delete_record は1件を削除し、list_records から消える", async () => {
  const keep = await insertOne("椅子", 3);
  const drop = await insertOne("机", 1);

  const data = okData(
    await callTool("delete_record", {
      app_id: APP_ID,
      table_id: TABLE_ID,
      record_id: drop,
      if_match: await versionVia(drop),
    }),
  );
  expect(data.deleted).toBe(true);

  const records = await listRecordsVia();
  expect(records.map((record) => record._id)).toEqual([keep]);
});

test("update_record は文字化けした値の訂正に使える(007/T3 の状況。F-13 / F-37)", async () => {
  // CP-6 007/T3 の実物。AI が投入したサンプルデータの1件が
  // `"宦治治とセロ弾き"`(「セロ弾きのゴーシュ」のつもり)で登録され、
  // **AI は自ら気づいて申告したが、直す手段が無かった**。ここが塞がったことを、
  // 当時の文字列そのもので固定する。
  const broken = await insertOne("宦治治とセロ弾き", 1);

  const data = okData(
    await callTool("update_record", {
      app_id: APP_ID,
      table_id: TABLE_ID,
      record_id: broken,
      changes: { title: "セロ弾きのゴーシュ" },
      if_match: await versionVia(broken),
    }),
  );
  expect((data.record as RecordRow).title).toBe("セロ弾きのゴーシュ");

  const records = await listRecordsVia();
  // **壊れた行が残らない**ことが要点。v0 の代替案は「正しい1冊を追加する
  // (壊れた行は残るので非推奨)」だった。
  expect(records).toHaveLength(1);
  expect(records[0]?.title).toBe("セロ弾きのゴーシュ");
});

// --- 完了条件2: システムテーブルの判定順序(ADR-0006 §7)------------------------------
//
// **これが完了条件2 の中心である。** カーネルは読み取り専用の拒否を
// **レコードの存在確認より前**に置いている。MCP 層が「まず存在確認」を挟み直すと
// 順序が反転し、存在しない `record_id` に対して「レコードがありません」が返る。
// それは「レコードさえあれば書ける」という誤った推論を LLM に許す。
//
// 順序が保たれていることは、**実在する行と実在しない行で同一のエラーが返る**
// ことで確かめられる(順序が反転していれば、実在しない行だけ別のエラーになる)。

/** `_changelog` に実在する行の `_id` を1つ取る(setupDiff の適用で必ず1行以上ある)。 */
async function anyChangelogRecordId(): Promise<string> {
  const records = await listRecordsVia("_changelog");
  const id = records[0]?._id;
  if (typeof id !== "string") {
    throw new Error("テスト前提: _changelog に行が1つも無い");
  }
  return id;
}

test("完了条件2: update_record は _apps に対し、実在しない record_id でも読み取り専用エラーを返す", async () => {
  const errors = errorsOf(
    await callTool("update_record", {
      app_id: APP_ID,
      table_id: "_apps",
      record_id: "存在しないID",
      changes: { name: "書き換え" },
      if_match: "v-any",
    }),
  );

  expect(errors).toHaveLength(1);
  expect(errors[0]?.path).toBe("");
  expect(errors[0]?.message).toContain("読み取り専用");
  // 「存在しません」と言ってはいけない。`_apps` は存在する。**書けないだけである。**
  expect(errors[0]?.message).not.toContain("存在しません");
  expect(errors[0]?.allowed_values).toEqual([TABLE_ID]);
});

test("完了条件2: update_record は _changelog の実在する行と実在しない行で同一のエラーを返す", async () => {
  const realId = await anyChangelogRecordId();

  const withReal = errorsOf(
    await callTool("update_record", {
      app_id: APP_ID,
      table_id: "_changelog",
      record_id: realId,
      changes: { intent: "履歴を書き換える" },
      if_match: "v-any",
    }),
  );
  const withMissing = errorsOf(
    await callTool("update_record", {
      app_id: APP_ID,
      table_id: "_changelog",
      record_id: "存在しないID",
      changes: { intent: "履歴を書き換える" },
      if_match: "v-any",
    }),
  );

  // **完全一致**を見る。`_id` の実在がエラーに一切影響しないことが、
  // 「読み取り専用の拒否が存在確認より前にある」ことの証拠である。
  expect(withMissing).toEqual(withReal);
  expect(withReal[0]?.message).toContain("読み取り専用");
});

test("完了条件2: delete_record も同じ順序である(実在する行と実在しない行で同一のエラー)", async () => {
  const realId = await anyChangelogRecordId();

  const withReal = errorsOf(
    await callTool("delete_record", {
      app_id: APP_ID,
      table_id: "_changelog",
      record_id: realId,
      if_match: "v-any",
    }),
  );
  const withMissing = errorsOf(
    await callTool("delete_record", {
      app_id: APP_ID,
      table_id: "_changelog",
      record_id: "存在しないID",
      if_match: "v-any",
    }),
  );

  expect(withMissing).toEqual(withReal);
  expect(withReal[0]?.message).toContain("読み取り専用");
  expect(withReal[0]?.message).not.toContain("存在しません");

  // 履歴の行は実際に残っている(拒否が本物であることの確認。憲法5)。
  expect((await listRecordsVia("_changelog")).map((record) => record._id)).toContain(realId);
});

test("完了条件2: HTTP 経由(PATCH / DELETE)と同じ文面である —— 経路で表現が割れない", async () => {
  // ADR-0003 §7。エラー文面はカーネルにしか置かない。MCP 層が独自の本文を作っていれば
  // ここが割れる。カーネルの `readOnlyTableError` そのものと突き合わせる。
  const manifest = readCurrentManifest(dataRoot, APP_ID);
  const expected = readOnlyTableError(manifest, "_apps");

  const update = errorsOf(
    await callTool("update_record", {
      app_id: APP_ID,
      table_id: "_apps",
      record_id: "x",
      changes: { name: "y" },
      if_match: "v-any",
    }),
  );
  const remove = errorsOf(
    await callTool("delete_record", {
      app_id: APP_ID,
      table_id: "_apps",
      record_id: "x",
      if_match: "v-any",
    }),
  );

  expect(update).toEqual([expected]);
  expect(remove).toEqual([expected]);
});

// --- 完了条件3: 異常系が統一形式(path / message / hint)で返る -------------------------

/** 統一形式の3点(path / message / hint)がそろっていることを見る。 */
function expectUnifiedShape(error: ValidationError | undefined): void {
  expect(error).toBeDefined();
  expect(typeof error?.path).toBe("string");
  expect(error?.message ?? "").not.toBe("");
  expect(error?.hint ?? "").not.toBe("");
}

test("完了条件3: update_record / delete_record は実在しない app_id を /app_id で返す", async () => {
  expectUnknownAppError(
    await callTool("update_record", {
      app_id: "nope",
      table_id: TABLE_ID,
      record_id: "x",
      changes: {},
    }),
  );
  expectUnknownAppError(
    await callTool("delete_record", { app_id: "nope", table_id: TABLE_ID, record_id: "x" }),
  );
});

test("完了条件3: 実在しない table_id は allowed_values 付きの統一形式で返る", async () => {
  for (const tool of ["update_record", "delete_record"]) {
    const errors = errorsOf(
      await callTool(tool, {
        app_id: APP_ID,
        table_id: "nope",
        record_id: "x",
        changes: { qty: 1 },
        if_match: "v-any",
      }),
    );
    expectUnifiedShape(errors[0]);
    expect(errors[0]?.allowed_values).toEqual([TABLE_ID]);
  }
});

test("完了条件3: 実在しない record_id は統一形式で返り、update と delete で文面がそろう", async () => {
  await insertOne("椅子", 3);

  const update = errorsOf(
    await callTool("update_record", {
      app_id: APP_ID,
      table_id: TABLE_ID,
      record_id: "存在しないID",
      changes: { qty: 1 },
      if_match: "v-any",
    }),
  );
  const remove = errorsOf(
    await callTool("delete_record", {
      app_id: APP_ID,
      table_id: TABLE_ID,
      record_id: "存在しないID",
      if_match: "v-any",
    }),
  );

  for (const errors of [update, remove]) {
    expectUnifiedShape(errors[0]);
    expect(errors[0]?.message).toContain("存在しません");
    expect(errors[0]?.message).toContain("存在しないID");
    // 次の1手が hint から決まること(list_records で実在する _id を引く)。
    expect(errors[0]?.hint ?? "").toContain("_id");
  }
  // 同じ事象は同じ文面で返す(HTTP 側も PATCH / DELETE で同一の文面を使っている)。
  expect(remove[0]?.message).toBe(update[0]?.message);

  // 契約1: `isError: true` は「何も変わっていない」。行は消えていない。
  expect(await listRecordsVia()).toHaveLength(1);
});

test("完了条件3: 型不一致は /フィールドID を指す統一形式で返り、レコードは変わらない", async () => {
  const id = await insertOne("椅子", 3);

  const errors = errorsOf(
    await callTool("update_record", {
      app_id: APP_ID,
      table_id: TABLE_ID,
      record_id: id,
      changes: { qty: "たくさん" },
      if_match: "v-any",
    }),
  );
  expectUnifiedShape(errors[0]);
  expect(errors[0]?.path).toBe("/qty");

  // 契約1: 何も変わっていない。
  expect((await listRecordsVia())[0]?.qty).toBe(3);
});

test("完了条件3: select の選択肢外は allowed_values 付きで返る", async () => {
  await applyValidationFixtures();
  const id = await insertOne("椅子", 3);

  const errors = errorsOf(
    await callTool("update_record", {
      app_id: APP_ID,
      table_id: TABLE_ID,
      record_id: id,
      changes: { status: "修理中" },
      if_match: "v-any",
    }),
  );
  expectUnifiedShape(errors[0]);
  expect(errors[0]?.path).toBe("/status");
  expect(errors[0]?.allowed_values).toEqual(["在庫", "貸出中"]);
});

test("完了条件3: reference 切れは参照先テーブルを名指しした統一形式で返る", async () => {
  await applyValidationFixtures();
  const id = await insertOne("椅子", 3);

  const errors = errorsOf(
    await callTool("update_record", {
      app_id: APP_ID,
      table_id: TABLE_ID,
      record_id: id,
      changes: { owner: "存在しない持ち主ID" },
      if_match: "v-any",
    }),
  );
  expectUnifiedShape(errors[0]);
  expect(errors[0]?.path).toBe("/owner");
  expect(errors[0]?.message).toContain("owners");
});

test("完了条件3: システム列への直接書き込みは拒否される(_id を書き換えられない)", async () => {
  const id = await insertOne("椅子", 3);

  const errors = errorsOf(
    await callTool("update_record", {
      app_id: APP_ID,
      table_id: TABLE_ID,
      record_id: id,
      changes: { _id: "書き換えたID" },
      if_match: "v-any",
    }),
  );
  expectUnifiedShape(errors[0]);
  expect(errors[0]?.path).toBe("/_id");
  expect((await listRecordsVia())[0]?._id).toBe(id);
});

// --- V1-M9-T02: 楽観ロック(if_match)と適用中ガード(ADR-0017)----------------------

test("if_match が無い update_record はエラー(版の指定は必須。ADR-0017)", async () => {
  const id = await insertOne("椅子", 3);
  const errors = errorsOf(
    await callTool("update_record", {
      app_id: APP_ID,
      table_id: TABLE_ID,
      record_id: id,
      changes: { qty: 10 },
    }),
  );
  expect(errors[0]?.path).toBe("/if_match");
  expect(errors[0]?.message).toContain("if_match");
  // 契約1: 何も変わっていない。
  expect((await listRecordsVia())[0]?.qty).toBe(3);
});

test("if_match が無い delete_record はエラー", async () => {
  const id = await insertOne("椅子", 3);
  const errors = errorsOf(
    await callTool("delete_record", { app_id: APP_ID, table_id: TABLE_ID, record_id: id }),
  );
  expect(errors[0]?.path).toBe("/if_match");
  expect(await listRecordsVia()).toHaveLength(1);
});

test("版不一致の update_record は衝突エラー(HTTP 409 と同一の message/hint)", async () => {
  const id = await insertOne("椅子", 3);
  const stale = await versionVia(id);
  // 先に別更新で版を進める。
  okData(
    await callTool("update_record", {
      app_id: APP_ID,
      table_id: TABLE_ID,
      record_id: id,
      changes: { qty: 5 },
      if_match: stale,
    }),
  );
  // 古い版で再更新 → 衝突。
  const errors = errorsOf(
    await callTool("update_record", {
      app_id: APP_ID,
      table_id: TABLE_ID,
      record_id: id,
      changes: { qty: 9 },
      if_match: stale,
    }),
  );
  expect(errors[0]?.message).toContain("変更されています");
  // 契約1: 衝突時は何も変わっていない(先の qty=5 のまま)。
  expect((await listRecordsVia())[0]?.qty).toBe(5);
});

test("版不一致の delete_record は衝突エラー", async () => {
  const id = await insertOne("椅子", 3);
  const stale = await versionVia(id);
  okData(
    await callTool("update_record", {
      app_id: APP_ID,
      table_id: TABLE_ID,
      record_id: id,
      changes: { qty: 5 },
      if_match: stale,
    }),
  );
  const errors = errorsOf(
    await callTool("delete_record", {
      app_id: APP_ID,
      table_id: TABLE_ID,
      record_id: id,
      if_match: stale,
    }),
  );
  expect(errors[0]?.message).toContain("変更されています");
  expect(await listRecordsVia()).toHaveLength(1);
});

test("適用中(apply 窓)は update_record / delete_record / insert_sample_data が失敗する", async () => {
  const id = await insertOne("椅子", 3);
  const version = await versionVia(id);
  // apply 窓を開く(マーカーを立てる)。危険窓を実データで再現する代わりにマーカーを直接置く。
  beginApply(dataRoot, APP_ID, "d-guard-test");
  try {
    const update = errorsOf(
      await callTool("update_record", {
        app_id: APP_ID,
        table_id: TABLE_ID,
        record_id: id,
        changes: { qty: 99 },
        if_match: version,
      }),
    );
    expect(update[0]?.message).toContain("適用中");

    const remove = errorsOf(
      await callTool("delete_record", {
        app_id: APP_ID,
        table_id: TABLE_ID,
        record_id: id,
        if_match: version,
      }),
    );
    expect(remove[0]?.message).toContain("適用中");

    const insert = errorsOf(
      await callTool("insert_sample_data", {
        app_id: APP_ID,
        table_id: TABLE_ID,
        rows: [{ title: "机", qty: 1 }],
      }),
    );
    expect(insert[0]?.message).toContain("適用中");
  } finally {
    endApply(dataRoot, APP_ID);
  }

  // 契約1: 適用中に拒否された書込は1バイトも反映されていない。
  const records = await listRecordsVia();
  expect(records).toHaveLength(1);
  expect(records[0]?.qty).toBe(3);
});

test("適用中エラーの message/hint は HTTP と MCP で完全一致する(ADR-0003 §7)", () => {
  // 共有モジュールを置かず同一文字列で担保している(server↔mcp の依存辺を作らないため)。
  // このテストがドリフトの見張りである。
  for (const status of [
    { inProgress: true },
    { inProgress: true, startedAt: "2026-07-21T00:00:00.000Z" },
  ]) {
    expect(mcpApplyInProgressError(status)).toEqual(serverApplyInProgressError(status));
  }
});

// --- 完了条件4: フラグ引数を足さない(F-38 / §7-4 の退行チェックリスト)----------------

test("完了条件4: update_record / delete_record は confirm 等のフラグ引数を取らない", async () => {
  // **同意は `list_records` で対象を人間に見せることで取る**(F-38 の設計)。
  // 引数のフラグにすると「confirm: true を付ければ安全」という誤った学習を生む。
  // `undo` に `confirm` を置かなかったのと同じ判断をここでも守る。
  const { client, close } = await connectInMemory();
  try {
    const listed = await client.listTools();
    const update = listed.tools.find((tool) => tool.name === "update_record");
    const remove = listed.tools.find((tool) => tool.name === "delete_record");

    // V1-M9-T02: if_match(期待する版)を足した。confirm 等のフラグ引数ではない。
    expect(Object.keys(update?.inputSchema.properties ?? {}).sort()).toEqual(
      ["app_id", "table_id", "record_id", "changes", "if_match"].sort(),
    );
    expect(Object.keys(remove?.inputSchema.properties ?? {}).sort()).toEqual(
      ["app_id", "table_id", "record_id", "if_match"].sort(),
    );

    // 名前を問わず「同意フラグ」に読める boolean 引数が無いこと。
    for (const tool of [update, remove]) {
      const properties = (tool?.inputSchema.properties ?? {}) as Record<string, { type?: string }>;
      for (const [key, schema] of Object.entries(properties)) {
        expect(`${key}:${schema.type ?? ""}`).not.toBe(`${key}:boolean`);
      }
    }
  } finally {
    await close();
  }
});

test("V1-M9-T09 完了条件4: delete_app は app_id だけを取り、boolean 型の引数を1つも持たない", async () => {
  // 同意は「消える中身を人間に見せる」ことで取る(F-38)。`confirm` 相当を置くと
  // 「フラグを付ければ安全」という誤った学習を生む。undo / delete_record と同じ判断。
  const { client, close } = await connectInMemory();
  try {
    const listed = await client.listTools();
    const del = listed.tools.find((tool) => tool.name === "delete_app");
    expect(Object.keys(del?.inputSchema.properties ?? {})).toEqual(["app_id"]);

    // 名前を問わず boolean 型の引数が0個であること(機械検査)。
    const properties = (del?.inputSchema.properties ?? {}) as Record<string, { type?: string }>;
    for (const [key, schema] of Object.entries(properties)) {
      expect(`${key}:${schema.type ?? ""}`).not.toBe(`${key}:boolean`);
    }
  } finally {
    await close();
  }
});

test("V1-M9-T09: delete_app でアプリが台帳から消え、list_apps に現れなくなる", async () => {
  const { client, close } = await connectInMemory();
  try {
    // 消す対象のアプリと、巻き添えにならないアプリを作る。
    const store = KernelMetaStore.open(dataRoot);
    try {
      createApp(store, "消す予定のアプリ", { app_id: "throwaway" });
      createApp(store, "残すアプリ", { app_id: "keeper" });
    } finally {
      store.close();
    }
    seedActor("throwaway");
    seedActor("keeper");

    const result = await client.callTool({
      name: "delete_app",
      arguments: { app_id: "throwaway" },
    });
    expect(result.isError ?? false).toBe(false);
    const data = (result.structuredContent ?? {}) as { deleted?: boolean; app_id?: string };
    expect(data.deleted).toBe(true);
    expect(data.app_id).toBe("throwaway");

    // list_apps に throwaway は現れず、keeper は残る。
    const listed = await client.callTool({ name: "list_apps", arguments: {} });
    const apps = ((listed.structuredContent ?? {}) as { apps?: { app_id: string }[] }).apps ?? [];
    const ids = apps.map((app) => app.app_id);
    expect(ids).toContain("keeper");
    expect(ids).not.toContain("throwaway");
  } finally {
    await close();
  }
});

test("V1-M9-T09: 存在しない app_id の delete_app は統一形式エラー(isError: 何も変わらない)", async () => {
  const { client, close } = await connectInMemory();
  try {
    const result = await client.callTool({
      name: "delete_app",
      arguments: { app_id: "no-such-app" },
    });
    expect(result.isError).toBe(true);
    const errors =
      ((result.structuredContent ?? {}) as { errors?: ValidationError[] }).errors ?? [];
    expect(errors[0]?.path).toBe("/app_id");
  } finally {
    await close();
  }
});

// --- V1-M2-T02 完了条件4: HTTP 経路と MCP 経路で発火が一致する -------------------------
//
// **フックはカーネル(`src/kernel/records.ts`)に置いてあるので、一致は構造的に
// 保証されている。**それでもテストを書くのは、詳細化 §2-2 の完了条件4 が
// 「**テストは『保証が実際に効いていること』の確認になる**」と定めているからである。
// 保証を信じて省略すると、**保証が外れた日に誰も気づかない**(ADR-0003 §7 が
// 「入口を何本生やしても振る舞いが一致する」を設計目標に挙げているのは、
// ずれが静かに起きるからである)。
//
// **ここで使う履歴テーブルは `WORKFLOW_HISTORY_TABLE_TEMPLATE` から取り出した本物の
// ひな形である**(`historyTableTemplateOperation()`)。説明文の規約と実装がずれたら、
// この節が「履歴が1行も書かれない」という形で赤くなる。

const WF_APP_ID = "wf-app";

/** ワークフロー2本(on_create / on_update)と、ひな形どおりの履歴テーブルを持つアプリ。 */
function workflowSetupDiff(): Diff {
  return {
    diff_id: "d-workflow-setup",
    intent: "本の登録と更新を通知に書き出すワークフローを用意する",
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
        op: "add_table",
        table: {
          id: "notifications",
          name: "通知",
          fields: [
            { id: "title", name: "件名", type: "text" },
            { id: "source", name: "対象", type: "text" },
          ],
        },
      },
      // **説明文のひな形そのもの。**ここを手書きの5列に置き換えないこと ——
      // 置き換えると、説明文と実装のずれをこのテストが検出できなくなる。
      historyTableTemplateOperation() as Diff["operations"][number],
      {
        op: "add_workflow",
        workflow: {
          id: "notify-on-create",
          name: "登録を通知する",
          trigger: { type: "on_create", table: "books" },
          actions: [
            {
              action: "create_record",
              table: "notifications",
              values: { title: "登録されました", source: "$record.title" },
            },
          ],
          history_table: "workflow-runs",
        },
      },
      {
        op: "add_workflow",
        workflow: {
          id: "notify-on-update",
          name: "更新を通知する",
          trigger: { type: "on_update", table: "books" },
          actions: [
            {
              action: "create_record",
              table: "notifications",
              values: { title: "更新されました", source: "$record.title" },
            },
          ],
          history_table: "workflow-runs",
        },
      },
    ],
  };
}

/** ワークフロー入りのアプリを作る。 */
async function setUpWorkflowApp(): Promise<void> {
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "ワークフロー検証", { app_id: WF_APP_ID });
  } finally {
    store.close();
  }
  seedActor(WF_APP_ID);
  const applied = await callTool("apply_diff", { app_id: WF_APP_ID, diff: workflowSetupDiff() });
  expect({ isError: applied.isError, errors: applied.isError ? errorsOf(applied) : [] }).toEqual({
    isError: undefined,
    errors: [],
  });
}

/** MCP 経由でテーブルの全行を読む(**DB から読んだ実物**であって、戻り値の使い回しではない)。 */
async function rowsOfVia(tableId: string): Promise<RecordRow[]> {
  const data = okData(await callTool("list_records", { app_id: WF_APP_ID, table_id: tableId }));
  return data.records as RecordRow[];
}

/**
 * 1列の値を**書き込まれた順**(SQLite の rowid 順)で返す(`workflow-runner.test.ts` の
 * `insertionOrder` と同趣旨)。
 *
 * `rowsOfVia`(= `list_records`)の既定順は `_created_at ASC, _id ASC` だが、ここで検査する
 * `insert_sample_data` → `update_record` の2回の呼び出しの間には実時間待機が無く、
 * 同じミリ秒の中に2行書かれ得る。その場合の同着はランダムな UUID(`_id`)で割れるため、
 * 既定順では書き込み順序を観測できない(実際に不安定になった)。
 * **書き込み順序を問う検査だけがこれを使う。**内容の検査は `rowsOfVia` を通す。
 */
function insertionOrderVia(tableId: string, column: string): unknown[] {
  const db = new Database(appDbPath(dataRoot, WF_APP_ID), { readwrite: true, create: false });
  try {
    const rows = db
      .query(`SELECT ${JSON.stringify(column)} AS v FROM ${JSON.stringify(tableId)} ORDER BY rowid`)
      .all() as { v: unknown }[];
    return rows.map((row) => row.v);
  } finally {
    db.close();
  }
}

test("insertionOrderVia: _created_at が同着でも rowid 順(= 書き込み順)を返す", async () => {
  await setUpWorkflowApp();

  const inserted = okData(
    await callTool("insert_sample_data", {
      app_id: WF_APP_ID,
      table_id: "books",
      rows: [{ title: "1冊目" }, { title: "2冊目" }],
    }),
  );
  const books = inserted.inserted as RecordRow[];
  expect(books).toHaveLength(2);

  // **同着を人工的に作る**: 2件の `_created_at` を同じ値に揃える。
  // これで `list_records` の既定順(`_created_at ASC, _id ASC`)は `_id`(ランダムな
  // UUID)頼みになり、書き込み順を保証しなくなる —— まさに不安定の原因を再現している。
  const db = new Database(appDbPath(dataRoot, WF_APP_ID), { readwrite: true, create: false });
  try {
    db.run(`UPDATE "books" SET "_created_at" = ? WHERE "_id" IN (?, ?)`, [
      "2026-01-01T00:00:00.000Z",
      books[0]?._id as string,
      books[1]?._id as string,
    ]);
  } finally {
    db.close();
  }

  // それでも rowid 順(= 実際に書き込まれた順)は揺るがない。
  expect(insertionOrderVia("books", "title")).toEqual(["1冊目", "2冊目"]);
});

test("完了条件4(MCP): insert_sample_data で on_create が発火し、履歴が1行増える", async () => {
  await setUpWorkflowApp();

  const inserted = okData(
    await callTool("insert_sample_data", {
      app_id: WF_APP_ID,
      table_id: "books",
      rows: [{ title: "吾輩は猫である" }],
    }),
  );
  expect(inserted.inserted).toHaveLength(1);

  // 出力先テーブルに行が増えている(「例外が飛ばなかった」ではなく、中身を読む)。
  const notifications = await rowsOfVia("notifications");
  expect(notifications).toHaveLength(1);
  expect(notifications[0]?.title).toBe("登録されました");
  expect(notifications[0]?.source).toBe("吾輩は猫である");

  // 履歴が1行(実行1回につき1行)。
  const history = await rowsOfVia("workflow-runs");
  expect(history).toHaveLength(1);
  expect(history[0]?.workflow).toBe("notify-on-create");
  expect(history[0]?.trigger_type).toBe("on_create");
  expect(history[0]?.status).toBe("success");
  expect(history[0]?.error).toBeNull();
});

test("完了条件4(MCP): update_record で on_update が発火する", async () => {
  await setUpWorkflowApp();
  const inserted = okData(
    await callTool("insert_sample_data", {
      app_id: WF_APP_ID,
      table_id: "books",
      rows: [{ title: "坊っちゃん" }],
    }),
  );
  const insertedBook = (inserted.inserted as RecordRow[])[0];
  const bookId = insertedBook?._id as string;

  okData(
    await callTool("update_record", {
      app_id: WF_APP_ID,
      table_id: "books",
      record_id: bookId,
      changes: { memo: "読了" },
      if_match: insertedBook?._updated_at as string,
    }),
  );

  const history = await rowsOfVia("workflow-runs");
  expect(history).toHaveLength(2);
  expect(history.every((row) => row.status === "success")).toBe(true);

  // on_create で1行、on_update で1行 —— **順序**を主張する検査なので、同着を
  // 割ってしまう `list_records` 経由ではなく `insertionOrderVia` で読む。
  expect(insertionOrderVia("workflow-runs", "trigger_type")).toEqual(["on_create", "on_update"]);
  expect(insertionOrderVia("workflow-runs", "workflow")).toEqual([
    "notify-on-create",
    "notify-on-update",
  ]);
});

test("完了条件4: HTTP 経路と MCP 経路で、履歴の行が同じ形になる", async () => {
  await setUpWorkflowApp();

  // (1) MCP 経路で1件作る。
  okData(
    await callTool("insert_sample_data", {
      app_id: WF_APP_ID,
      table_id: "books",
      rows: [{ title: "MCP から" }],
    }),
  );

  // (2) **同じ dataRoot に対して HTTP サーバを立て**、同じことをする。
  // アプリもテーブルもワークフローも共有しているので、**違うのは入口だけ**である。
  const httpApp = createServerApp({ dataRoot });
  // 認証境界(ADR-0014)を通すため、同じ dataRoot にセッションを1件仕込んで cookie を付ける。
  const { cookie } = seedSession(dataRoot, WF_APP_ID);
  const created = await httpApp.request(
    new Request(`http://localhost/api/apps/${WF_APP_ID}/tables/books/records`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: TEST_ORIGIN },
      body: JSON.stringify({ title: "HTTP から" }),
    }),
  );
  expect(created.status).toBe(201);

  const history = await rowsOfVia("workflow-runs");
  expect(history).toHaveLength(2);

  // **これが「発火が一致する」の実質である。**
  // カーネルが管理する列(`_id` / `_created_at` / `_updated_at`)と実行時刻を除いた
  // **履歴の中身が、入口によらず1バイトも変わらない。**
  const shapeOf = (row: RecordRow | undefined) => ({
    workflow: row?.workflow,
    trigger_type: row?.trigger_type,
    status: row?.status,
    error: row?.error,
  });
  expect(shapeOf(history[0])).toEqual(shapeOf(history[1]));
  expect(shapeOf(history[0])).toEqual({
    workflow: "notify-on-create",
    trigger_type: "on_create",
    status: "success",
    error: null,
  });

  // 出力先テーブルの側も両経路で1行ずつ増えている(履歴だけが一致しても意味が無い)。
  const notifications = await rowsOfVia("notifications");
  expect(notifications.map((row) => row.source).sort()).toEqual(["HTTP から", "MCP から"]);
});

// --- V1-M9-T12: 履歴書き込み失敗を成功レスポンスの明示項目に載せる ------------------
//
// 「レコード書き込み由来(on_create / on_update)」の履歴書き込み失敗は、いままで
// `console.error` に消えて会話に届かなかった(`defaultHistoryFailureHandler`)。
// この節は、その失敗が `insert_sample_data` / `update_record` の戻り値の明示項目
// (`workflow_history_failures`)に載ることと、失敗が無いときは項目が出ないことを固定する。

/**
 * 履歴テーブル("workflow-runs")を**物理的に落として**、以後の発火で履歴書き込みが
 * 必ず失敗する状態にする。マニフェストは列を持つと言い続けるので、`createRecord` は
 * 検証を通ったあと INSERT で例外になり、`historyFailureHandler` に渡る(壊れた履歴を
 * 適用時に作ることはできないので、実運用の「壊れ方」を再現する唯一の道である)。
 */
function breakWorkflowHistoryTable(): void {
  const db = new Database(appDbPath(dataRoot, WF_APP_ID), { readwrite: true, create: false });
  try {
    db.run(`DROP TABLE "workflow-runs"`);
  } finally {
    db.close();
  }
}

test("V1-M9-T12(MCP): insert_sample_data は on_create の履歴書き込み失敗を workflow_history_failures に載せる", async () => {
  await setUpWorkflowApp();
  breakWorkflowHistoryTable();

  const data = okData(
    await callTool("insert_sample_data", {
      app_id: WF_APP_ID,
      table_id: "books",
      rows: [{ title: "吾輩は猫である" }],
    }),
  );

  // 書き込みそのものは成功している(レコードもアクションの出力も残る)。
  expect(data.inserted).toHaveLength(1);
  expect(await rowsOfVia("notifications")).toHaveLength(1);

  // 履歴失敗が明示項目に載る(カーネルが構築した失敗オブジェクトの中継)。
  const failures = data.workflow_history_failures as
    | { workflow: string; history_table: string; errors: unknown[] }[]
    | undefined;
  expect(failures).toBeDefined();
  expect(failures).toHaveLength(1);
  expect(failures?.[0]?.workflow).toBe("notify-on-create");
  expect(failures?.[0]?.history_table).toBe("workflow-runs");
  expect((failures?.[0]?.errors.length ?? 0) > 0).toBe(true);
});

test("V1-M9-T12(MCP): update_record は on_update の履歴書き込み失敗を workflow_history_failures に載せる", async () => {
  await setUpWorkflowApp();

  // 先に1件作る(この on_create の履歴はまだ壊していないので成功する)。
  const inserted = okData(
    await callTool("insert_sample_data", {
      app_id: WF_APP_ID,
      table_id: "books",
      rows: [{ title: "坊っちゃん" }],
    }),
  );
  const book = (inserted.inserted as RecordRow[])[0];
  breakWorkflowHistoryTable();

  const data = okData(
    await callTool("update_record", {
      app_id: WF_APP_ID,
      table_id: "books",
      record_id: book?._id as string,
      changes: { memo: "読了" },
      if_match: book?._updated_at as string,
    }),
  );

  // 更新は成功している。
  expect((data.record as RecordRow).memo).toBe("読了");

  const failures = data.workflow_history_failures as { workflow: string }[] | undefined;
  expect(failures).toBeDefined();
  expect(failures).toHaveLength(1);
  expect(failures?.[0]?.workflow).toBe("notify-on-update");
});

test("V1-M9-T12(MCP): 履歴が健全なら workflow_history_failures 項目は出ない(余計な項目を足さない)", async () => {
  await setUpWorkflowApp();

  // 履歴は壊さない。on_create は発火し、履歴は正常に書ける。
  const data = okData(
    await callTool("insert_sample_data", {
      app_id: WF_APP_ID,
      table_id: "books",
      rows: [{ title: "三四郎" }],
    }),
  );
  expect(data.inserted).toHaveLength(1);
  expect(await rowsOfVia("workflow-runs")).toHaveLength(1);

  // 成功時は項目そのものを付けない(空配列でもなく、キーが無い)。
  expect(data.workflow_history_failures).toBeUndefined();
  expect("workflow_history_failures" in data).toBe(false);
});

test("V1-M9-T12(MCP): update_record は履歴が健全なら余計な項目を足さない", async () => {
  await setUpWorkflowApp();
  const inserted = okData(
    await callTool("insert_sample_data", {
      app_id: WF_APP_ID,
      table_id: "books",
      rows: [{ title: "こころ" }],
    }),
  );
  const book = (inserted.inserted as RecordRow[])[0];

  const data = okData(
    await callTool("update_record", {
      app_id: WF_APP_ID,
      table_id: "books",
      record_id: book?._id as string,
      changes: { memo: "再読" },
      if_match: book?._updated_at as string,
    }),
  );
  expect((data.record as RecordRow).memo).toBe("再読");
  expect("workflow_history_failures" in data).toBe(false);
});

// --- request_inbound_endpoint(V2-M5-T01 / ADR-0041 限定1)-----------------------------
//
// **request_connection の鏡写し**(送信 ADR-0020 §2b/§8c-3 の対称)。AI がこのツールで
// 到達できる上限は「pending な申請の作成」までで、**発行(inbound_endpoints への書き込み)は
// owner の HTTP 操作だけが行う**(発行経路を MCP / apply_diff に1本も結線しない)。
// ここで固定するのは「申請だけが積まれ、発行済みの受信口は1件もできない」こと ——
// 説明文ではなく**経路の不在**が担保である(F-41)。

/** kernel.sqlite の pending な受信口申請を読む。 */
function pendingInboundRequests(appId: string = APP_ID) {
  const store = InboundStore.openForKernel(dataRoot);
  try {
    return store.listPendingInboundEndpointRequests(appId);
  } finally {
    store.close();
  }
}

/** 発行済みの受信口(inbound_endpoints)を読む。 */
function issuedInboundEndpoints(appId: string = APP_ID) {
  const store = InboundStore.openForKernel(dataRoot);
  try {
    return store.listInboundEndpoints(appId);
  } finally {
    store.close();
  }
}

test("request_inbound_endpoint は受信口の申請を1件積み、requestId を返す", async () => {
  const data = okData(
    await callTool("request_inbound_endpoint", {
      app_id: APP_ID,
      name: "psp-webhook",
      purpose: "決済 PSP からの Webhook を受けたい",
      target_table: "payments",
    }),
  );
  expect(typeof data.requestId).toBe("string");

  // 申請が1件 pending で積まれている(内容が届いている)。
  const pending = pendingInboundRequests();
  expect(pending).toHaveLength(1);
  expect(pending[0]?.id).toBe(data.requestId as string);
  expect(pending[0]?.requestedName).toBe("psp-webhook");
  expect(pending[0]?.suggestedTargetTable).toBe("payments");
  expect(pending[0]?.status).toBe("pending");
});

test("request_inbound_endpoint は申請だけで、発行済みの受信口(inbound_endpoints)を1件も作らない", async () => {
  // 申請を2件出しても……
  await callTool("request_inbound_endpoint", {
    app_id: APP_ID,
    name: "psp-webhook",
    purpose: "決済 Webhook",
    target_table: "payments",
  });
  await callTool("request_inbound_endpoint", {
    app_id: APP_ID,
    name: "psp-webhook-2",
    purpose: "別の決済 Webhook",
    target_table: "payments",
  });

  // 申請は2件でも、**発行(inbound_endpoints)は0件**。発行は owner の HTTP 操作だけが行う。
  expect(pendingInboundRequests()).toHaveLength(2);
  expect(issuedInboundEndpoints()).toHaveLength(0);
});

test("request_inbound_endpoint は存在しない app_id を /app_id の統一形式エラーで返し、何も積まない", async () => {
  expectUnknownAppError(
    await callTool("request_inbound_endpoint", {
      app_id: "ghost",
      name: "psp-webhook",
      purpose: "決済 Webhook",
      target_table: "payments",
    }),
  );
  // 申請も発行も1件もできていない。
  expect(pendingInboundRequests()).toHaveLength(0);
  expect(issuedInboundEndpoints()).toHaveLength(0);
});

// --- request_custom_css(V3-M5-T01 / ADR-0055 限定5・限定7)-----------------------------
//
// **request_connection / request_inbound_endpoint の3例目。** AI がこのツールで到達できる
// 上限は「pending な申請の作成」までで、**発行(`escape_hatch_assets` への書き込みと CSS の
// バイト列の配置)は owner の HTTP 操作だけが行う**(発行経路を MCP / apply_diff に1本も
// 結線しない)。ここで固定するのは「申請だけが積まれ、発行済み資産も CSS の実体も1つも
// できない」こと —— 説明文ではなく**経路の不在**が担保である(F-41)。
// 経路の不在そのもの(ソース上の呼び出し元の集合)は
// `src/server/escape-hatch-issuance.test.ts` が固定する。

/** kernel.sqlite の pending な逃げ道の申請を読む。 */
function pendingCustomCssRequests(appId: string = APP_ID) {
  const store = EscapeHatchStore.openForKernel(dataRoot);
  try {
    return store.listPendingEscapeHatchAssetRequests(appId);
  } finally {
    store.close();
  }
}

/** 発行済みの逃げ道の資産(escape_hatch_assets)を読む。 */
function issuedCustomCssAssets(appId: string = APP_ID) {
  const store = EscapeHatchStore.openForKernel(dataRoot);
  try {
    return store.listEscapeHatchAssets(appId);
  } finally {
    store.close();
  }
}

test("request_custom_css は逃げ道の申請を1件積み、requestId を返す", async () => {
  const data = okData(
    await callTool("request_custom_css", {
      app_id: APP_ID,
      name: "compact-rows",
      purpose: "一覧の行間を詰めたい(preset の選択肢に無い)",
      views: ["books-list"],
    }),
  );
  expect(typeof data.requestId).toBe("string");

  const pending = pendingCustomCssRequests();
  expect(pending).toHaveLength(1);
  expect(pending[0]?.id).toBe(data.requestId as string);
  expect(pending[0]?.requestedName).toBe("compact-rows");
  expect(pending[0]?.suggestedScopeViews).toEqual(["books-list"]);
  expect(pending[0]?.status).toBe("pending");
});

test("request_custom_css は申請だけで、発行済み資産(escape_hatch_assets)を1件も作らない", async () => {
  await callTool("request_custom_css", {
    app_id: APP_ID,
    name: "compact-rows",
    purpose: "行間",
    views: ["books-list"],
  });
  await callTool("request_custom_css", {
    app_id: APP_ID,
    name: "wide-detail",
    purpose: "詳細を広く",
    views: [],
  });

  // 申請は2件でも、**発行(escape_hatch_assets)は0件**。発行は owner の HTTP だけが行う。
  expect(pendingCustomCssRequests()).toHaveLength(2);
  expect(issuedCustomCssAssets()).toHaveLength(0);
});

test("request_custom_css は CSS の本文を受ける引数を持たない(余計なキーを渡しても保存されない)", async () => {
  // 引数に本文を置かないのが設計判断である(置けば「AI が書いた CSS が pending に載る」=
  // 本体を書く経路が MCP 側に半分できる)。余計なキーを送っても申請の内容は3項目のままで、
  // どこにも CSS は残らない。
  const data = okData(
    await callTool("request_custom_css", {
      app_id: APP_ID,
      name: "compact-rows",
      purpose: "行間",
      views: ["books-list"],
      css: ".gp-view { display: none; }",
    }),
  );
  const pending = pendingCustomCssRequests();
  expect(pending).toHaveLength(1);
  expect(pending[0]?.id).toBe(data.requestId as string);
  expect(JSON.stringify(pending[0])).not.toContain("display: none");
  expect(issuedCustomCssAssets()).toHaveLength(0);
});

test("request_custom_css は存在しない app_id を /app_id の統一形式エラーで返し、何も積まない", async () => {
  expectUnknownAppError(
    await callTool("request_custom_css", {
      app_id: "ghost",
      name: "compact-rows",
      purpose: "行間",
      views: ["books-list"],
    }),
  );
  expect(pendingCustomCssRequests()).toHaveLength(0);
  expect(issuedCustomCssAssets()).toHaveLength(0);
});

// --- V3-M13-T03: アクションの失敗が入口によらず同じ結果になる(ADR-0066 / ADR-0003 §7)-----
//
// **本節は製品コードを1バイトも足さずに書ける。** `ADR-0066` の限定1 が原子性の器を
// カーネルの `src/kernel/records.ts` にだけ置くと定めたので、MCP の入口(`src/mcp/tools/
// write.ts`)には `db.transaction` が1つも無いまま(実測: `grep -c "db.transaction("` = 0)
// **アクション失敗による巻き戻しが効く。**
//
// それでも検査を置くのは、`ADR-0003` §7(入口を何本生やしても振る舞いが一致する)の
// 保証が**外れた日に誰も気づかない**からである(同じ理由が上の「完了条件4」の節にも
// 書いてある)。ここで固定するのは次の3点:
//
//   1. MCP 単件書込(`insert_sample_data` / `update_record`)が巻き戻ること
//   2. **HTTP 単件書込と MCP 単件書込が、返すエラーまで1バイト違わないこと**
//   3. バッチ(`write_records`)が 1 op のアクション失敗でバッチ全体を巻き戻すこと
//
// **`schedule` はここに現れない。** `ADR-0066` 限定7 が「原子性を保証しない」と名指しで
// 選んでおり、一致しない経路として残る(`src/kernel/workflow-scheduler.test.ts` が固定する)。

const FAIL_APP_ID = "wf-fail-app";

/** 必ず失敗するアクション(`must` が required な `strict` に `must` を与えない)を持つアプリ。 */
function failingWorkflowSetupDiff(): Diff {
  return {
    diff_id: "d-failing-workflow",
    intent: "アクションが必ず失敗するワークフローを用意する",
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
        op: "add_table",
        table: {
          id: "logs",
          name: "記録",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
        },
      },
      {
        op: "add_table",
        table: {
          id: "strict",
          name: "必須つきテーブル",
          fields: [
            { id: "must", name: "必須", type: "text", required: true },
            { id: "note", name: "メモ", type: "text" },
          ],
        },
      },
      historyTableTemplateOperation() as Diff["operations"][number],
      {
        // `logs` の作成で必ず失敗する(create 経路の検査に使う)。
        op: "add_workflow",
        workflow: {
          id: "fails-on-create",
          name: "作成で必ず失敗する",
          trigger: { type: "on_create", table: "logs" },
          actions: [{ action: "create_record", table: "strict", values: { note: "x" } }],
          history_table: "workflow-runs",
        },
      },
      {
        // `books` の更新で必ず失敗する(update 経路の検査に使う。作成は通る)。
        op: "add_workflow",
        workflow: {
          id: "fails-on-update",
          name: "更新で必ず失敗する",
          trigger: { type: "on_update", table: "books" },
          actions: [{ action: "create_record", table: "strict", values: { note: "x" } }],
          history_table: "workflow-runs",
        },
      },
    ],
  };
}

async function setUpFailingWorkflowApp(): Promise<void> {
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "失敗するワークフロー", { app_id: FAIL_APP_ID });
  } finally {
    store.close();
  }
  seedActor(FAIL_APP_ID);
  const applied = await callTool("apply_diff", {
    app_id: FAIL_APP_ID,
    diff: failingWorkflowSetupDiff(),
  });
  expect({ isError: applied.isError, errors: applied.isError ? errorsOf(applied) : [] }).toEqual({
    isError: undefined,
    errors: [],
  });
}

/** 失敗検証用アプリのテーブルを **DB から直接**数える(戻り値の使い回しではない)。 */
function failAppRowCount(tableId: string): number {
  const db = new Database(appDbPath(dataRoot, FAIL_APP_ID), { readwrite: true, create: false });
  try {
    const row = db
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${JSON.stringify(tableId)}`)
      .get();
    return row?.n ?? 0;
  } finally {
    db.close();
  }
}

test("V3-M13-T03(入口6): MCP の insert_sample_data はアクション失敗で1行も書かない", async () => {
  await setUpFailingWorkflowApp();

  const data = okData(
    await callTool("insert_sample_data", {
      app_id: FAIL_APP_ID,
      table_id: "logs",
      rows: [{ title: "書けないはず" }],
    }),
  );

  // 行ごとの失敗として返る(`insert_sample_data` の契約3: 部分成功でも isError は立てない)。
  expect(data.inserted).toHaveLength(0);
  const failed = data.failed as { index: number; errors: ValidationError[] }[];
  expect(failed).toHaveLength(1);
  expect(failed[0]?.errors).toHaveLength(1);
  expect(failed[0]?.errors[0]?.path).toBe("");
  expect(String(failed[0]?.errors[0]?.message)).toContain("ワークフローのアクションが失敗した");

  // **DB を読んで不在を確かめる**(「例外が飛ばなかった」ではない)。
  expect(failAppRowCount("logs")).toBe(0);
  // アクションが書こうとした先には1行も残っていない。
  expect(failAppRowCount("strict")).toBe(0);
  // 【V3-M13-T04 による期待値の更新】**失敗の履歴は残る**(ADR-0066 限定5)。
  expect(failAppRowCount("workflow-runs")).toBe(1);
});

test("V3-M13-T03(入口6): MCP の update_record はアクション失敗で更新を巻き戻す", async () => {
  await setUpFailingWorkflowApp();
  const created = okData(
    await callTool("insert_sample_data", {
      app_id: FAIL_APP_ID,
      table_id: "books",
      rows: [{ title: "元のタイトル" }],
    }),
  );
  const book = (created.inserted as RecordRow[])[0];
  expect(book).toBeDefined();

  const result = await callTool("update_record", {
    app_id: FAIL_APP_ID,
    table_id: "books",
    record_id: book?._id as string,
    changes: { memo: "更新した" },
    if_match: book?._updated_at as string,
  });

  const errors = errorsOf(result);
  expect(errors).toHaveLength(1);
  expect(errors[0]?.path).toBe("");
  expect(String(errors[0]?.message)).toContain("ワークフローのアクションが失敗した");

  // 行は消えず、更新だけが巻き戻る(版も動いていない)。
  const rows = okData(await callTool("list_records", { app_id: FAIL_APP_ID, table_id: "books" }))
    .records as RecordRow[];
  expect(rows).toHaveLength(1);
  expect(rows[0]?.memo).toBeNull();
  expect(rows[0]?._updated_at).toBe(book?._updated_at);
});

test("V3-M13-T03(入口1 と入口6): HTTP 単件 POST と MCP 単件書込が同じエラーを返す", async () => {
  await setUpFailingWorkflowApp();

  // (1) MCP 経路。
  const viaMcp = okData(
    await callTool("insert_sample_data", {
      app_id: FAIL_APP_ID,
      table_id: "logs",
      rows: [{ title: "MCP から" }],
    }),
  );
  const mcpErrors = (viaMcp.failed as { errors: ValidationError[] }[])[0]?.errors;

  // (2) **同じ dataRoot に HTTP サーバを立て**、同じことをする(違うのは入口だけ)。
  const httpApp = createServerApp({ dataRoot });
  const { cookie } = seedSession(dataRoot, FAIL_APP_ID);
  const response = await httpApp.request(
    new Request(`http://localhost/api/apps/${FAIL_APP_ID}/tables/logs/records`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: TEST_ORIGIN },
      body: JSON.stringify({ title: "HTTP から" }),
    }),
  );

  // **500 ではない**(ADR-0066 限定4: 例外を呼び出し元へ伝播させない)。
  expect(response.status).toBe(400);
  const httpErrors = ((await response.json()) as { errors: ValidationError[] }).errors;

  // **これが「入口を何本生やしても振る舞いが一致する」の実質である。**
  // 文面には行の中身(「MCP から」/「HTTP から」)が入らないので、2経路のエラーは
  // **1バイトも違わない**。
  expect(httpErrors).toEqual(mcpErrors as ValidationError[]);

  // 両経路とも1行も書いていない。
  expect(failAppRowCount("logs")).toBe(0);
});

test("V3-M13-T03(入口2 と入口6): HTTP 単件 PATCH と MCP の update_record が同じエラーを返す", async () => {
  await setUpFailingWorkflowApp();
  const created = okData(
    await callTool("insert_sample_data", {
      app_id: FAIL_APP_ID,
      table_id: "books",
      rows: [{ title: "更新の対象" }],
    }),
  );
  const book = (created.inserted as RecordRow[])[0];
  const bookId = book?._id as string;
  const version = book?._updated_at as string;

  // (1) MCP 経路。
  const mcpErrors = errorsOf(
    await callTool("update_record", {
      app_id: FAIL_APP_ID,
      table_id: "books",
      record_id: bookId,
      changes: { memo: "MCP から" },
      if_match: version,
    }),
  );

  // (2) HTTP 経路(**同じ行・同じ版**へ。更新は巻き戻ったので版は動いていない)。
  const httpApp = createServerApp({ dataRoot });
  const { cookie } = seedSession(dataRoot, FAIL_APP_ID);
  const response = await httpApp.request(
    new Request(`http://localhost/api/apps/${FAIL_APP_ID}/tables/books/records/${bookId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: TEST_ORIGIN,
        "if-match": version,
      },
      body: JSON.stringify({ memo: "HTTP から" }),
    }),
  );

  // **409 でも 500 でもない** —— アクション失敗は CAS 衝突ではない(ADR-0066 限定13)。
  expect(response.status).toBe(400);
  const httpErrors = ((await response.json()) as { errors: ValidationError[] }).errors;
  expect(httpErrors).toEqual(mcpErrors);

  // 2経路とも更新が巻き戻り、版も動いていない。
  const rows = okData(await callTool("list_records", { app_id: FAIL_APP_ID, table_id: "books" }))
    .records as RecordRow[];
  expect(rows).toHaveLength(1);
  expect(rows[0]?.memo).toBeNull();
  expect(rows[0]?._updated_at).toBe(version);
});

test("V3-M13-T03(入口4): MCP の write_records は 1 op のアクション失敗でバッチ全体を巻き戻す", async () => {
  await setUpFailingWorkflowApp();

  const result = await callTool("write_records", {
    app_id: FAIL_APP_ID,
    ops: [
      { op: "create", table: "books", values: { title: "巻き添え" } },
      { op: "create", table: "logs", values: { title: "失敗する側" } },
    ],
  });

  const errors = errorsOf(result);
  expect(errors.length).toBeGreaterThan(0);
  // **無関係な他の op まで巻き戻る**(ADR-0066 §限界4。利用者から見れば理由が読めない)。
  expect(failAppRowCount("books")).toBe(0);
  expect(failAppRowCount("logs")).toBe(0);
});

// ---------------------------------------------------------------------------
// (G-M) 群 —— **MCP の口は壁を越える**(`V5-M28-T06`。`ADR-0249` §4-5 の穴2 / 限定13)
//
// **`ADR-0249` は操作起点の `audience` から書込の壁を立てたが、止めるのは
// ブラウザからログインして使う人が通る HTTP の2つの入口だけである。**
//
// **【`V8-M20` / `J-G29`。旧文を1バイトも消していない】** **その `view_action.audience` は
// 撤去された**(台帳 `J-G29` の判定 = 廃止。手続きは `ADR-0301`)。**壁を立てているのは
// 今日、役割の規則(`app.roles[].rules` の 対象(表) x 書込)である。**
// **本群が固定している事実 —— 「MCP はその壁を越える」 —— は1ミリも変わっていない。**
// **壁の出どころだけが変わったので、下の `wallSetupDiff` を `set_roles` へ書き直した。**
// **MCP はアプリを育てる側の口なので、同じ表へ今日どおり書ける。**
// **本群は穴が空いていることを固定する側であり、壁が効いた証拠ではない。**
//
// **【測っていないもの】** **`scripts/mcp-trial/` を1度も使っていない**(in-process の
// `Client` で叩いており、別プロセスの MCP サーバも実 LLM も1つも起こしていない)。
// ---------------------------------------------------------------------------

const WALL_APP_ID = "wall-mcp-app";

/** `wall_order` に**作成の壁**(`["editor"]`)を立てる差分。 */
function wallSetupDiff(): Diff {
  return {
    diff_id: "d-wall-setup",
    intent: "役割の規則から書込の壁を立てる",
    operations: [
      {
        op: "add_table",
        table: {
          id: "goods",
          name: "商品",
          fields: [{ id: "title", name: "品名", type: "text", required: true }],
        },
      },
      {
        op: "add_table",
        table: {
          id: "wall_order",
          name: "注文",
          fields: [
            { id: "goods", name: "商品", type: "reference", reference_table: "goods" },
            { id: "note", name: "備考", type: "text" },
          ],
        },
      },
      {
        op: "add_view",
        view: {
          id: "wall-order-form",
          type: "form",
          table: "wall_order",
          fields: ["goods", "note"],
        },
      },
      {
        op: "add_view",
        view: {
          id: "goods-list",
          type: "list_view",
          table: "goods",
          columns: ["title"],
          actions: [
            {
              id: "order-action",
              form: "wall-order-form",
              prefill: { field: "goods" },
              name: "注文する",
            },
          ],
        },
      },
      // **更新の壁**(書き先 = 乗っているビューの表 = `wall_order`)。
      {
        op: "add_view",
        view: {
          id: "wall-order-detail",
          type: "detail_view",
          table: "wall_order",
          fields: ["goods", "note"],
          actions: [{ id: "done-action", set: { field: "note", value: "済" }, name: "済にする" }],
        },
      },
      // **【`V8-M20` / `J-G29`】壁はここから立つ。**
      // **`editor` にだけ `wall_order` への書込を許す** —— **`owner` には書いていないので、
      // `owner` は allow-list から外れて 403 になる**(面は「規則が1本でも書かれた対象は
      // allow-list」であり、誰の規則であるかを問わない)。
      // **旧はこれを `view_action.audience: ["editor"]` で書いていた。**
      {
        op: "set_roles",
        roles: [
          {
            id: "owner",
            name: "持ち主",
            rules: [
              // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
              { target: "app", can: ["write"] },
              { target: "role", can: ["write"] },
            ],
          },
          {
            id: "editor",
            name: "編集者",
            rules: [{ target: "table", table: "wall_order", can: ["read", "write"] }],
          },
          { id: "viewer", name: "閲覧者" },
        ],
      },
    ],
  } as unknown as Diff;
}

/** 壁の立ったアプリを作り、壁が本当に立っていることを HTTP の 403 で確かめてから返す。 */
async function setUpWallApp(): Promise<void> {
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "壁の店(MCP)", { app_id: WALL_APP_ID });
  } finally {
    store.close();
  }
  seedActor(WALL_APP_ID);
  const applied = await callTool("apply_diff", { app_id: WALL_APP_ID, diff: wallSetupDiff() });
  expect(applied.isError).toBeFalsy();
}

/** `wall_order` の行数を**本物の SQLite を直接開いて**数える。 */
function wallRowCount(tableId: string): number {
  const db = new Database(appDbPath(dataRoot, WALL_APP_ID), { readonly: true });
  try {
    return (
      db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${JSON.stringify(tableId)}`).get()
        ?.n ?? 0
    );
  } finally {
    db.close();
  }
}

test("(G-M0) 壁は本当に立っている —— HTTP からは壁の外の相手が 403 で断られる", async () => {
  await setUpWallApp();
  const server = createServerApp({ dataRoot });
  const owner = seedSession(dataRoot, WALL_APP_ID, { role: "owner", username: "wall-owner" });
  const res = await server.request(
    new Request(`http://localhost/api/apps/${WALL_APP_ID}/tables/wall_order/records`, {
      method: "POST",
      headers: {
        origin: TEST_ORIGIN,
        cookie: owner.cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ note: "運営が作る" }),
    }),
  );
  expect(res.status).toBe(403);
  expect(wallRowCount("wall_order")).toBe(0);
});

/** `wall_order` の1行の `note` を**本物の SQLite を直接開いて**読む(`V8-M31` 第3波)。 */
function wallNote(recordId: string): string | undefined {
  const db = new Database(appDbPath(dataRoot, WALL_APP_ID), { readonly: true });
  try {
    return (
      db
        .query<{ note: string | null }, [string]>(`SELECT note FROM "wall_order" WHERE _id = ?`)
        .get(recordId)?.note ?? undefined
    );
  } finally {
    db.close();
  }
}

// **【`V8-M31` 第3波。期待値を反転させた。旧を逐語で残す】**
// **旧のテスト名**: `(G-M1) MCP の write_records は、壁の立った表へ今日どおり書ける(穴2)`
// **旧の期待値(逐語)**:
//   `expect(result.isError).toBeFalsy();`
//   `expect(wallRowCount("wall_order")).toBe(1);`
// **反転の理由**: **`V8-M31` が MCP に名乗りを入れ、名乗った主体の権限で (D) 行を書く4本を
// 絞るようになった**(`write_records` は `denyRoleTableWrite` を通る)。**この題材の壁は
// `wall_order` への書込を `editor` にしか許しておらず、名乗っている `ACTOR` は `owner` である。**
// **したがって穴2 は塞がった** —— **HTTP の 403((G-M0))と MCP が同じ判定になった。**
test("(G-M1) MCP の write_records も、壁の立った表へは書けない(穴2 は塞がった)", async () => {
  await setUpWallApp();
  expect(wallRowCount("wall_order")).toBe(0);

  const result = await callTool("write_records", {
    app_id: WALL_APP_ID,
    ops: [{ op: "create", table: "wall_order", values: { note: "MCP が作る" } }],
  });

  expect(result.isError).toBe(true);
  expect(wallRowCount("wall_order")).toBe(0);
});

// **【`V8-M31` 第3波。期待値を反転させた。旧を逐語で残す】**
// **旧のテスト名**: `(G-M2) MCP の update_record も、壁の立った表の行を今日どおり直せる(穴2)`
// **旧の期待値(逐語)**:
//   `expect(updated.isError).toBeFalsy();`
//   `const rows = okData(`
//   `  await callTool("list_records", { app_id: WALL_APP_ID, table_id: "wall_order" }),`
//   `).records as RecordRow[];`
//   `expect(rows[0]?.note).toBe("MCP が直す");`
// **反転の理由**: (G-M1) と同じ —— **名乗った主体(`owner`)の権限で `update_record` を
// 絞るようになった**(`denyRoleTableWrite(..., "write")`)。**壁が通すのは `editor` だけである。**
test("(G-M2) MCP の update_record も、壁の立った表の行を直せない(穴2 は塞がった)", async () => {
  await setUpWallApp();

  // **【`V8-M31` 第3波】下ごしらえの入口だけを差し替えた(測る主題は1ミリも変えていない)。**
  // **旧はこの行を MCP の `write_records` で作っていた。旧を逐語で残す**:
  //   `const created = okData(`
  //   `  await callTool("write_records", {`
  //   `    app_id: WALL_APP_ID,`
  //   `    ops: [{ op: "create", table: "wall_order", values: { note: "初回" } }],`
  //   `  }),`
  //   `);`
  //   `const records = created.records as RecordRow[];`
  //   `expect(records).toHaveLength(1);`
  //   `const id = records[0]?._id as string;`
  //   `const version = records[0]?._updated_at as string;`
  // **その道は (G-M1) のとおり塞がった。** **HTTP も使えない** —— **実測: `editor` の
  // `POST /records` も 403 である**(`表 "wall_order" に対する作成は、あなたの役割に
  // 許されていません。`)。**`goods-list` の `order-action` が `wall_order` への作成の
  // 壁を立てており、その操作起点を許す規則をどの役割も持っていないためで、
  // `editor` の表への `write` では越えられない。**
  // **そこで下ごしらえだけカーネルで直に作る**(`beforeEach` が `applyDiff` を直に呼ぶのと
  // 同じ立場である)—— **この検査の主題は「MCP の口が壁を越えるか」であって、
  // 「行がどの口から生まれたか」ではない。**
  const seededRow = (() => {
    const manifest = readCurrentManifest(dataRoot, WALL_APP_ID);
    const db = new Database(appDbPath(dataRoot, WALL_APP_ID), { readwrite: true, create: false });
    try {
      const created = createRecord(db, manifest, "wall_order", { note: "初回" });
      if (!created.ok) {
        throw new Error(`テスト前提の行を作れません: ${JSON.stringify(created.errors)}`);
      }
      return created.value;
    } finally {
      db.close();
    }
  })();
  const id = seededRow._id as string;
  const version = seededRow._updated_at as string;
  expect(wallRowCount("wall_order")).toBe(1);

  // **【対照】同じ行を HTTP から壁の外の相手が直そうとすると 403 である**
  // **【`V8-M20` / `J-G29`】旧文は「`wall-order-detail` の `set` 形が更新の壁を立てている」
  // と書いていた。** **今日その壁を立てているのは役割の規則(対象(表) x 書込)である。**
  const server = createServerApp({ dataRoot });
  const owner = seedSession(dataRoot, WALL_APP_ID, { role: "owner", username: "wall-upd-owner" });
  const http = await server.request(
    new Request(`http://localhost/api/apps/${WALL_APP_ID}/tables/wall_order/records/${id}`, {
      method: "PATCH",
      headers: {
        origin: TEST_ORIGIN,
        cookie: owner.cookie,
        "content-type": "application/json",
        "if-match": version,
      },
      body: JSON.stringify({ note: "運営が直す" }),
    }),
  );
  expect(http.status).toBe(403);

  const updated = await callTool("update_record", {
    app_id: WALL_APP_ID,
    table_id: "wall_order",
    record_id: id,
    changes: { note: "MCP が直す" },
    if_match: version,
  });
  expect(updated.isError).toBe(true);

  // **読み直しは `list_records` ではなく本物の SQLite から行う。**
  // **理由**: **`V8-M31` は (C) `list_records` も名乗った主体の権限で絞るようにした** ——
  // **`owner` はこの表への `read` を1本も持っていないので、旧の `okData(list_records)` は
  // 「行が変わっていない」ではなく「読めない」を測ることになる。** **DB を直接読めば、
  // 断られたあとに1バイトも書かれていないことを、判定と独立に測れる。**
  expect(wallNote(id)).toBe("初回");
});

test("(G-M3) 誰も通さない壁を書いた差分を MCP の apply_diff が今日どおり受け入れる(警告0件)", async () => {
  await setUpWallApp();

  const result = await callTool("apply_diff", {
    app_id: WALL_APP_ID,
    diff: {
      diff_id: "d-nobody-wall",
      intent: "ログイン済みの誰も通らない壁を書く",
      operations: [
        // **【`V8-M20` / `J-G29`】旧はこれを `audience: ["anonymous"]` で書いていた**
        // (未ログインだけに見せる = ログイン済みの誰も通らない)。
        // **今日は「未ログイン(`anonymous`)にだけ書込を許す規則」で同じ形になる** ——
        // **ログイン済みの役割は1つも書かれていないので、誰も通らない。**
        // **役割の主体に書けるのは 予約4語 ∪ `user_kinds` の識別子だけなので、先に宣言する。**
        // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a` / `T-G11`。判定値 = 廃止】**
        // **題材から `set_user_kinds` の1行を外した** —— **`app.user_kinds` の器と
        // `set_user_kinds` が撤去され、この差分は `/operations/0/op` で拒否されるようになったため。**
        // **旧(逐語)**: `{ op: "set_user_kinds", user_kinds: [{ id: "ghost", name: "幽霊" }] },`
        // **`ghost` を先に宣言する必要は今日1つも無い** —— **`roles[].id` が `user_kinds` に
        // 実在するかを見る検査は元から1件も無く**(`src/kernel/referential-integrity.ts` の
        // 類型16 の doc が逐語で「1件も見ていない」と書いている)、**器が消えた今日も同じである。**
        // **この検査が測る主題(誰も通さない壁を MCP が警告0件で受け入れること)は1ミリも変えていない。**
        {
          op: "set_roles",
          roles: [
            {
              id: "owner",
              name: "持ち主",
              rules: [
                // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
                { target: "app", can: ["write"] },
                { target: "role", can: ["write"] },
              ],
            },
            { id: "editor", name: "編集者" },
            { id: "viewer", name: "閲覧者" },
            {
              // **未ログイン(`anonymous`)には `read` しか書けない**(`J-G11` の非対称。
              // 実測: `can` に `write` を書くと適用時に `allowed_values: ["read"]` で拒否される)。
              // **そこで「誰も名乗れない役割」に書込を許して、同じ『誰も通らない壁』を作る。**
              id: "ghost",
              name: "幽霊",
              rules: [{ target: "table", table: "wall_order", can: ["write"] }],
            },
          ],
        },
      ],
    },
  });

  // **拒否されない。**
  expect(result.isError).toBeFalsy();
  // **応答の本文に「警告」の枠が1つも無い**(MCP の結果に warnings キーは存在しない)。
  const structured = result.structuredContent as Record<string, unknown>;
  expect(Object.keys(structured)).not.toContain("warnings");
  expect(JSON.stringify(structured)).not.toContain("警告");

  // **その後、ログイン済みの `owner` は HTTP からその表に1行も作れない。**
  const server = createServerApp({ dataRoot });
  const owner = seedSession(dataRoot, WALL_APP_ID, {
    role: "owner",
    username: "nobody-wall-owner",
  });
  const res = await server.request(
    new Request(`http://localhost/api/apps/${WALL_APP_ID}/tables/wall_order/records`, {
      method: "POST",
      headers: {
        origin: TEST_ORIGIN,
        cookie: owner.cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ note: "誰も通らない" }),
    }),
  );
  expect(res.status).toBe(403);
  // **【`V8-M31` 第3波。期待値を反転させた。旧を逐語で残す】**
  // **旧のコメント(逐語)**: `// **MCP からは同じ表に書ける。**`
  // **旧の期待値(逐語)**:
  //   `expect(viaMcp.isError).toBeFalsy();`
  //   `expect(wallRowCount("wall_order")).toBe(1);`
  // **反転の理由**: (G-M1) と同じ —— **名乗った主体(`owner`)の権限で `write_records` を
  // 絞るようになった。** **`ghost` にしか書込を許していない壁は、MCP からも通らない。**
  // **この検査の主題(誰も通さない壁を MCP の `apply_diff` が警告0件で受け入れること)は
  // 1ミリも変えていない** —— **上の `expect(result.isError).toBeFalsy()` は今日も緑である。**
  const viaMcp = await callTool("write_records", {
    app_id: WALL_APP_ID,
    ops: [{ op: "create", table: "wall_order", values: { note: "MCP なら通る" } }],
  });
  expect(viaMcp.isError).toBe(true);
  expect(wallRowCount("wall_order")).toBe(0);
});

// ---------------------------------------------------------------------------
// (CV) 群 —— **コメントの出し入れを切り替える道具**
// (`V10-M30-T02`。台帳 `CM-G37` / `ADR-0378`。器は `V10-M30-T01` / `ADR-0377`)
//
// **道具は1本ちょうど(25 → 26)である。**読む道具を2本目に足していないので、
// **倒した後の値を確かめる手立ては「この道具の返り値」と「器を別に開いて読むこと」の
// 2つだけである。**(CV-2) がその2つを突き合わせる。
//
// **この群が固定していないもの(誇張しない)**:
//
// - **OFF にしても口は閉じない**(`D-V10-38` / `ADR-0378` 限界3)。**止まるのは画面の
//   表示だけで、外から直接送れば今日どおり書ける。** 本群はその「口が開いたままである」
//   ことを1度も測っていない(測るのは画面側の単位である)。
// - **切り替えは `_auth_activity` に1行も残らない**(`ADR-0378` 限界1)。
//   (CV-10) が測るのは**変更履歴(changelog)**であって、監査の記録ではない。
// ---------------------------------------------------------------------------

/** 切り替えの題材にするアプリ(`app` × `write` の規則を実際に宣言する)。 */
const CV_APP_ID = "cv-app";
/** `app` × `write` を**持たない**名乗り(`editor`)。 */
const CV_EDITOR = "cv-editor";

/** 名乗りを差し替えて1回だけ呼ぶ(このファイルの `callTool` は常に `ACTOR` で名乗る)。 */
async function callToolAs(
  name: string,
  args: Record<string, unknown>,
  actor: string,
): Promise<CallToolResult> {
  const server = createMcpServer({ dataRoot, previewBaseUrl, actor });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

/**
 * `app` × `write` の規則を持つアプリを1つ用意する。
 *
 * **持ち主(`owner`)にだけ `app` × `write` を書く** —— **`editor` には1本も書かない。**
 * 面は「その対象を名指しした規則が1本でも在れば allow-list」なので、これで
 * `editor` は `app` の設定に触れなくなる(`wallSetupDiff` と同じ形)。
 */
async function setUpCommentVisibilityApp(): Promise<void> {
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "コメントの出し入れ", { app_id: CV_APP_ID });
  } finally {
    store.close();
  }
  seedActor(CV_APP_ID);
  seedSession(dataRoot, CV_APP_ID, { role: "editor", username: CV_EDITOR });
  const applied = await callTool("apply_diff", {
    app_id: CV_APP_ID,
    diff: {
      diff_id: "d-cv-setup",
      intent: "アプリの設定に触れる相手を持ち主だけにする",
      operations: [
        {
          op: "add_table",
          table: {
            id: "cv_notes",
            name: "メモ",
            fields: [{ id: "title", name: "題名", type: "text", required: true }],
          },
        },
        {
          op: "set_roles",
          roles: [
            {
              id: "owner",
              name: "持ち主",
              rules: [
                { target: "app", can: ["write"] },
                { target: "role", can: ["write"] },
                { target: "table", table: "cv_notes", can: ["read", "write"] },
              ],
            },
            {
              id: "editor",
              name: "編集者",
              rules: [{ target: "table", table: "cv_notes", can: ["read", "write"] }],
            },
            { id: "viewer", name: "閲覧者" },
          ],
        },
      ],
    },
  });
  expect(applied.isError).toBeFalsy();
}

/** **器を別に開いて**今の設定を読む(道具の返り値とは独立の経路)。 */
function visibilityVia(appId: string): { write: boolean; read: boolean } | undefined {
  const store = KernelMetaStore.open(dataRoot);
  try {
    return store.getCommentVisibility(appId);
  } finally {
    store.close();
  }
}

/** `kernel.sqlite` の全テーブルの中身を丸ごと写す(`exclude` に挙げた表だけ除く)。 */
function kernelDump(exclude: readonly string[]): Record<string, unknown[]> {
  const db = new Database(join(dataRoot, "kernel.sqlite"), { readonly: true });
  try {
    const names = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
      )
      .all()
      .map((row) => row.name)
      .filter((name) => !name.startsWith("sqlite_") && !exclude.includes(name));
    const dump: Record<string, unknown[]> = {};
    for (const name of names) {
      dump[name] = db
        .query<Record<string, unknown>, []>(`SELECT * FROM ${JSON.stringify(name)}`)
        .all();
    }
    return dump;
  } finally {
    db.close();
  }
}

test("(CV-2) 権限のある名乗りは「書くだけ」を倒せ、返り値と器の読み口が一致する", async () => {
  await setUpCommentVisibilityApp();
  // **既定は両方 OFF である**(`ADR-0377` / `D-V10-40`。列を足した直後は全アプリが OFF)。
  expect(visibilityVia(CV_APP_ID)).toEqual({ write: false, read: false });

  const data = okData(
    await callTool("set_comment_visibility", { app_id: CV_APP_ID, comment_write: true }),
  );
  // **倒した後の値をそのまま返す**(読む道具を2本目に足していないので、これが唯一の返答である)。
  expect(data).toEqual({
    app_id: CV_APP_ID,
    comment_visibility: { write: true, read: false },
  });
  // **別に開いた器の読み口でも同じ値が読める**(返り値だけを見て緑になる壊れ方をしない)。
  expect(visibilityVia(CV_APP_ID)).toEqual({ write: true, read: false });
});

test("(CV-3) 「読むだけ」も別に倒せる(2つが1つに畳まれていない。D-V10-36)", async () => {
  await setUpCommentVisibilityApp();
  const data = okData(
    await callTool("set_comment_visibility", { app_id: CV_APP_ID, comment_read: true }),
  );
  // **書く側は今の値のまま残る** —— 片側だけを渡せることが `D-V10-36` の要求である。
  expect(data.comment_visibility).toEqual({ write: false, read: true });
  expect(visibilityVia(CV_APP_ID)).toEqual({ write: false, read: true });
});

test("(CV-4) 両方省略すると断られ、設定は1ミリも動かない", async () => {
  await setUpCommentVisibilityApp();
  const before = visibilityVia(CV_APP_ID);
  const errors = errorsOf(await callTool("set_comment_visibility", { app_id: CV_APP_ID }));
  expect(errors).toHaveLength(1);
  expect(errors[0]?.path).toBe("");
  expect(errors[0]?.message).toContain("comment_write");
  // **`isError: true` は「何も変わっていない」を意味する**(このファイル冒頭の契約1)。
  expect(visibilityVia(CV_APP_ID)).toEqual(before);
});

test("(CV-5) 実在しないアプリは断られる", async () => {
  expectUnknownAppError(
    await callTool("set_comment_visibility", { app_id: "no-such-app", comment_write: true }),
  );
});

test("(CV-6) 名乗りが無いと isError(requireActorAndApp を通っている)", async () => {
  await setUpCommentVisibilityApp();
  const before = visibilityVia(CV_APP_ID);
  // **名乗りを渡さないサーバを立てる**(`ST_MCP_ACTOR` が空のときと同じ状態)。
  const server = createMcpServer({ dataRoot, previewBaseUrl });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = (await client.callTool({
      name: "set_comment_visibility",
      arguments: { app_id: CV_APP_ID, comment_write: true },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
  } finally {
    await client.close();
    await server.close();
  }
  expect(visibilityVia(CV_APP_ID)).toEqual(before);
});

test("(CV-7a) app × write を許していない役割は断られる(陽性対照: 持ち主は通る)", async () => {
  await setUpCommentVisibilityApp();
  const denied = await callToolAs(
    "set_comment_visibility",
    { app_id: CV_APP_ID, comment_write: true },
    CV_EDITOR,
  );
  expect(denied.isError).toBe(true);
  expect(errorsOf(denied)[0]?.message).toContain("アプリの作りを変更できるのは");
  // **断られた側は1ミリも倒せていない**(既定の OFF のままである)。
  expect(visibilityVia(CV_APP_ID)).toEqual({ write: false, read: false });

  // **陽性対照**: 同じ引数を、許している役割(持ち主)で送ると通る
  // (拒否側だけを測ると、全部拒否しても緑になる)。
  const allowed = okData(
    await callTool("set_comment_visibility", { app_id: CV_APP_ID, comment_write: true }),
  );
  expect(allowed.comment_visibility).toEqual({ write: true, read: false });
});

test("(CV-7b) 壁の呼び出しを外すと、権限の無い名乗りでも切り替えは通ってしまう", async () => {
  // **`ADR-0378` 限定4 が求める陽性対照である。** **製品コードを1バイトも書き換えずに示す。**
  //
  // **示し方**: 道具のハンドラは「(i) 名乗りとアプリの解決 → (ii) 壁 → (iii) 器を倒す」の
  // 3段でできている。**(ii) だけを外した経路をこの検査の中で組み立て、同じ名乗り・同じ
  // 引数で (iii) まで進めると、切り替えが実際に通ってしまうことを実出力で示す。**
  // **したがって、権限の無い名乗りを止めているのは (ii) の1行だけである** ——
  // (iii) の器にも、その手前の (i) にも、可否を見る条件式は1つも無い。
  await setUpCommentVisibilityApp();

  // (ii) は、この名乗りに対して**確かに「断れ」と言っている**(壁が効いている側の実測)。
  const editorRoles = seedSession(dataRoot, CV_APP_ID, {
    role: "editor",
    username: "cv-editor-probe",
  }).roles;
  const verdict = denyAppSettingWrite(dataRoot, CV_APP_ID, editorRoles);
  expect(verdict).not.toBeNull();
  expect(verdict?.[0]?.message).toContain("アプリの作りを変更できるのは");

  // **(ii) を通さない経路**: (i) の解決までは同じで、(iii) の器だけを呼ぶ。
  const store = KernelMetaStore.open(dataRoot);
  try {
    // **通ってしまう。** 器は誰が呼んだかを1度も見ない(`ADR-0377` 限定6 の裏返し)。
    expect(store.setCommentVisibility(CV_APP_ID, { write: true })).toEqual({
      write: true,
      read: false,
    });
  } finally {
    store.close();
  }
  expect(visibilityVia(CV_APP_ID)).toEqual({ write: true, read: false });
});

test("(CV-8) 引数のキーに名乗りを渡す7語が1つも無い(ADR-0378 限定3)", async () => {
  const { client, close } = await connectInMemory();
  try {
    const listed = await client.listTools();
    const tool = listed.tools.find((each) => each.name === "set_comment_visibility");
    const keys = Object.keys(tool?.inputSchema.properties ?? {});
    expect(keys.sort()).toEqual(["app_id", "comment_read", "comment_write"]);
    const actorWords = ["actor", "as", "act_as", "user", "user_id", "role", "roles"];
    const hasActorWord = (names: string[]): string[] =>
      actorWords.filter((word) => names.includes(word));
    expect(hasActorWord(keys)).toEqual([]);
    // **陰性対照**: 同じ判定式に偽物のキー並びを渡すと、7語すべてで真を返す。
    expect(hasActorWord([...actorWords])).toEqual(actorWords);
  } finally {
    await close();
  }
});

test("(CV-9) 書く先は apps 表だけで、kernel.sqlite の他の表は1行も動かない", async () => {
  await setUpCommentVisibilityApp();
  const before = kernelDump(["apps"]);
  okData(await callTool("set_comment_visibility", { app_id: CV_APP_ID, comment_read: true }));
  expect(kernelDump(["apps"])).toEqual(before);
  // **陽性対照**: `apps` を除かずに写すと、切り替えの前後で中身が変わっている
  // (= この写しの取り方が本当に列の値を見ている)。
  const withApps = kernelDump([]);
  okData(await callTool("set_comment_visibility", { app_id: CV_APP_ID, comment_read: false }));
  expect(kernelDump([])).not.toEqual(withApps);
});

test("(CV-10) 切り替えは変更履歴に1行も残らない(ADR-0377 限界2 の陰性対照)", async () => {
  await setUpCommentVisibilityApp();
  const before = okData(await callTool("get_changelog", { app_id: CV_APP_ID }))
    .changelog as ChangelogEntry[];
  okData(await callTool("set_comment_visibility", { app_id: CV_APP_ID, comment_write: true }));
  const after = okData(await callTool("get_changelog", { app_id: CV_APP_ID }))
    .changelog as ChangelogEntry[];
  expect(after).toEqual(before);
  // **陽性対照**: 変更履歴に載る操作(`apply_diff`)を1回通すと、確かに1行増える。
  okData(
    await callTool("apply_diff", {
      app_id: CV_APP_ID,
      diff: {
        diff_id: "d-cv-memo",
        intent: "メモに覚え書きを足したい",
        operations: [
          {
            op: "add_field",
            table: "cv_notes",
            field: { id: "memo", name: "覚え書き", type: "text" },
          },
        ],
      },
    }),
  );
  const grown = okData(await callTool("get_changelog", { app_id: CV_APP_ID }))
    .changelog as ChangelogEntry[];
  expect(grown.length).toBe(before.length + 1);
});

test("(CV-11) 器が投げたときも統一形式(structuredContent + path + hint)で返る", async () => {
  // **【`V10-M30` の独立点検 B-1(2026-08-25)】**
  // 直す前、このハンドラは `try { … } finally { store.close() }` で `catch` を持たず、
  // **器(`KernelMetaStore`)が投げた素の `Error` がそのまま AI に返っていた。**
  // 点検の実測(直す前の返り値、逐語):
  //
  //     { "content": [{ "type": "text", "text": "database is locked" }], "isError": true }
  //
  // **`structuredContent` も `path` も `hint` も1つも無い。** ここがその見張りである。
  await setUpCommentVisibilityApp();
  // **別接続が `BEGIN IMMEDIATE` を保持している最中に倒しにいく。**
  // `busy_timeout` は0なので待たずに `SQLITE_BUSY` になる(`M9-T03` の実測と同じ形)。
  const holder = new Database(join(dataRoot, "kernel.sqlite"), { readwrite: true });
  try {
    holder.exec("PRAGMA journal_mode = WAL;");
    holder.exec("BEGIN IMMEDIATE");
    holder.exec(`UPDATE "apps" SET "name" = "name"`);
    const errors = errorsOf(
      await callTool("set_comment_visibility", { app_id: CV_APP_ID, comment_read: true }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("");
    // **文面の出所は `src/kernel/errors.ts` の `concurrentWriteBusyErrors` である**
    // (`write_records` とまったく同じ型)。**ここで値として import していない** ——
    // `scripts/kernel-import-drift.test.ts` の層またぎスナップショットを1行も増やさない
    // ため(更新は人間が行う検査である)。**代わりに出所の文面の一部で当てる。**
    expect(errors[0]?.message).toContain("別の書き込みが進行中");
    expect(errors[0]?.hint).toContain("しばらく間を置いてから");
    // **器の素の文面が素通りしていないこと**(これが B-1 の核心である)。
    expect(errors[0]?.message).not.toContain("database is locked");
    holder.exec("ROLLBACK");
  } finally {
    holder.close();
  }
  // **陽性対照**: 保持を解いた後は同じ呼び出しが通り、設定が実際に倒れる。
  expect(
    okData(await callTool("set_comment_visibility", { app_id: CV_APP_ID, comment_read: true })),
  ).toEqual({ app_id: CV_APP_ID, comment_visibility: { write: false, read: true } });
});
