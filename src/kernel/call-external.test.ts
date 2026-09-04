import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityStore } from "./capability-store.ts";
import { applyManifestDdl } from "./ddl.ts";
import { createRecord } from "./records.ts";
import { appDbPath } from "./storage-paths.ts";
import type { Manifest, Workflow } from "./types.ts";
import { runWorkflows } from "./workflow-runner.ts";

/**
 * `call_external` の実行層遮断マトリクス(V1-M4-T03 / ADR-0020 §3)。
 *
 * **遮断は runAction(実行層)にある** —— 許可(接続あり + スコープ内)だけが outbox に
 * 積まれ、不許可(接続なし)/ スコープ外は積まれない。**このテストは一度も
 * `validateManifest` / `apply_diff` を通さず、マニフェストを手で組んで実行経路
 * (`createRecord` → `runWorkflows` → runAction)を直接叩く** —— それでも遮断が効くことが、
 * 遮断がバリデーション層ではなく実行層にある証拠である(限定8c-5)。
 */

const APP_ID = "ext-app";

/** 履歴テーブルの5列(規約どおり)。 */
function historyFields() {
  return [
    { id: "ran_at", name: "実行時刻", type: "date" as const },
    { id: "workflow", name: "ワークフロー", type: "text" as const },
    { id: "trigger_type", name: "きっかけ", type: "text" as const },
    { id: "status", name: "結果", type: "text" as const },
    { id: "error", name: "エラー", type: "long_text" as const },
  ];
}

/** books(トリガー元)+ wf-runs(履歴)を持つマニフェスト。workflows は各テストが差し込む。 */
function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "外部送信テスト",
      tables: [
        {
          id: "books",
          name: "本",
          fields: [{ id: "title", name: "タイトル", type: "text", required: true }],
        },
        { id: "wf-runs", name: "実行履歴", fields: historyFields() },
      ],
      views: [],
    },
  };
}

/** call_external を1本だけ持つワークフロー(on_create × books)。 */
function callExternalWorkflow(connection: string, destination: string): Workflow {
  return {
    id: "notify-external",
    name: "外部へ通知",
    trigger: { type: "on_create", table: "books" },
    actions: [
      {
        action: "call_external",
        connection,
        destination,
        payload: { title: "$record.title", note: "固定文" },
      },
    ],
    history_table: "wf-runs",
  };
}

let dataRoot: string;
let db: Database;
let manifest: Manifest;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-call-external-"));
  // app.sqlite を **<dataRoot>/apps/<appId>/app.sqlite** の正規レイアウトで作る
  // (runCallExternal が db.filename から dataRoot / appId を逆算するため)。
  const dbPath = appDbPath(dataRoot, APP_ID);
  await mkdir(join(dataRoot, "apps", APP_ID), { recursive: true });
  db = new Database(dbPath, { create: true });
  manifest = baseManifest();
  applyManifestDdl(db, manifest);
});

afterEach(async () => {
  db.close();
  await rm(dataRoot, { recursive: true, force: true });
});

/** kernel.sqlite の outbox の pending を読み出す(検査用)。 */
function pendingOutbox() {
  const store = CapabilityStore.openForKernel(dataRoot);
  try {
    return store.listPendingOutbox();
  } finally {
    store.close();
  }
}

/** 接続を1本発行する(人間の owner 操作の代役)。 */
function issueConnection(name: string, allowedHosts: string[]): void {
  const store = CapabilityStore.openForKernel(dataRoot);
  try {
    store.createConnection({
      appId: APP_ID,
      name,
      allowedHosts,
      secretSource: { kind: "env", value: "ST_T03_SECRET" },
    });
  } finally {
    store.close();
  }
}

describe("call_external の実行層遮断マトリクス", () => {
  test("許可: 接続あり + スコープ内 → 成功し、outbox に pending 1件・payload は $record 解決済み", () => {
    issueConnection("api", ["api.example.com"]);
    manifest.app.workflows = [callExternalWorkflow("api", "https://api.example.com/v1/messages")];

    // createRecord が on_create を発火させ、runAction → runCallExternal が enqueue する。
    const result = createRecord(db, manifest, "books", { title: "吾輩は猫である" });
    expect(result.ok).toBe(true);

    const pending = pendingOutbox();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.destination).toBe("https://api.example.com/v1/messages");
    expect(pending[0]?.appId).toBe(APP_ID);
    // payload の `$record.title` は解決済み。リテラルはそのまま。
    expect(pending[0]?.payload).toEqual({ title: "吾輩は猫である", note: "固定文" });
    // **secret は outbox に載らない**(payload に authorization 相当のキーが無い)。
    expect(JSON.stringify(pending[0]?.payload)).not.toContain("ST_T03_SECRET");
  });

  // 【V3-M13-T02 / ADR-0066 による期待値の更新】遮断は**アクションの失敗**なので、
  // 決定が変わって**発火元の書込ごと成立しなくなった**(`ok:false`)。
  // **遮断そのものは1バイトも変わっていない** —— 測っている「outbox に1件も積まれない」は同じ。
  test("不許可(接続なし): capability 必要の failure・outbox 0件", () => {
    // 接続を1本も発行しない。
    manifest.app.workflows = [callExternalWorkflow("api", "https://api.example.com/v1/messages")];

    expect(createRecord(db, manifest, "books", { title: "本" }).ok).toBe(false);
    expect(pendingOutbox()).toHaveLength(0);
  });

  test("スコープ外: allowedHosts に無い宛先 → failure・outbox 0件", () => {
    issueConnection("api", ["api.example.com"]);
    manifest.app.workflows = [callExternalWorkflow("api", "https://evil.com/x")];

    expect(createRecord(db, manifest, "books", { title: "本" }).ok).toBe(false);
    expect(pendingOutbox()).toHaveLength(0);
  });

  test("スコープの既定は deny: allowedHosts が空なら常に不許可 → outbox 0件", () => {
    issueConnection("api", []); // 何も許可しない(既定 deny)。
    manifest.app.workflows = [callExternalWorkflow("api", "https://api.example.com/x")];

    expect(createRecord(db, manifest, "books", { title: "本" }).ok).toBe(false);
    expect(pendingOutbox()).toHaveLength(0);
  });

  test("迂回テスト: apply_diff / スキーマ検査を通さず runWorkflows を直接呼んでも遮断される", () => {
    // ここでは createRecord すら通さず、**runWorkflows(実行 seam の入口)を直接呼ぶ。**
    // マニフェストは手で組んだだけで一度も検証していない。それでも接続が無ければ
    // runAction(runCallExternal)が同期に遮断し、outbox に1件も積まれない ——
    // **遮断がバリデーション層ではなく実行層にあることの実証**(限定8c-5 / 脅威 T5)。
    manifest.app.workflows = [callExternalWorkflow("api", "https://api.example.com/v1/messages")];

    // トリガー元レコードを実際に1件書いてから、runWorkflows を直接叩く。
    const book = createRecord(
      db,
      { ...manifest, app: { ...manifest.app, workflows: [] } },
      "books",
      {
        title: "迂回",
      },
    );
    expect(book.ok).toBe(true);
    if (!book.ok) throw new Error("setup failed");

    runWorkflows(db, manifest, "books", "on_create", book.value);

    expect(pendingOutbox()).toHaveLength(0);
  });
});
