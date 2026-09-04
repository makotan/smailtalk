/**
 * アプリの完全削除(V1-M9-T09。ADR-0031)のテスト。
 *
 * 検証の要点(ゲート §8-8):
 * - **方法1**: 削除後に `data/apps/<app_id>/` が無い **かつ** kernel.sqlite の台帳行・
 *   changelog 行が無いことを **1つのテスト**で確かめる(片方だけだと非対称が再発する)。
 * - **方法2**: 削除後に T04 の孤児検出(`auditAppSnapshots`)が空を返す。
 * - **横断テーブル**(#5。ai_* / connections / outbox / connection_requests)の当該
 *   app_id 行も消える。
 * - **存在しない app_id / apply 窓中**の削除は統一形式エラーで拒否(状態を変えない)。
 * - **部分失敗**(ディレクトリ削除失敗)の注入時に統一形式エラーを返し、台帳は先に
 *   消えている(孤児ディレクトリが検出可能)。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiCapabilityStore } from "./ai-capability-store.ts";
import { CapabilityStore } from "./capability-store.ts";
import { CommentStore } from "./comment-store.ts";
import { createApp } from "./create-app.ts";
import { APP_SCOPED_KERNEL_TABLES, deleteApp } from "./delete-app.ts";
import { EscapeHatchStore, putEscapeHatchBody } from "./escape-hatch-store.ts";
import { InboundStore } from "./inbound-store.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { beginApply, endApply } from "./recovery.ts";
import { auditAppSnapshots } from "./snapshot-orphans.ts";
import { appDir, appEscapeHatchDir, appSnapshotsDir } from "./storage-paths.ts";

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "gp-delete-app-"));
});

afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

/** アプリを1つ作り、app_id を返す(台帳登録・ディレクトリ・第0行の changelog が入る)。 */
function seedApp(appId: string): void {
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, `${appId} のアプリ`, { app_id: appId });
  } finally {
    store.close();
  }
}

/** 横断テーブルにこの app_id の行を1件ずつ入れる(#5 の削除対象を作る)。 */
function seedCrossCuttingRows(appId: string): void {
  const cap = CapabilityStore.openForKernel(dataRoot);
  try {
    const conn = cap.createConnection({
      appId,
      name: "webhook",
      allowedHosts: ["example.com"],
      secretSource: { kind: "env", value: "TOKEN" },
    });
    cap.enqueueOutbox({
      appId,
      connectionId: conn.id,
      destination: "https://example.com/hook",
      payload: { hello: "world" },
    });
    cap.createRequest({
      appId,
      requestedName: "another",
      purpose: "test",
      suggestedHosts: ["example.org"],
    });
  } finally {
    cap.close();
  }
  const ai = AiCapabilityStore.openForKernel(dataRoot);
  try {
    const aiCap = ai.createCapability({
      appId,
      name: "summarize",
      provider: "claude_cli",
      model: "claude-3",
      limit: { maxCallsPerDay: 10, maxCostUsdPerDay: 1 },
    });
    ai.enqueueJob({
      appId,
      capabilityId: aiCap.id,
      workflowId: "wf",
      actor: null,
      prompt: "p",
      input: {},
      outputField: "out",
      fallback: "",
      targetTable: "t",
      targetRecordId: "r",
      chainDepth: 0,
    });
    ai.recordUsage({
      appId,
      capabilityId: aiCap.id,
      workflowId: "wf",
      actor: null,
      model: "claude-3",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.001,
      status: "success",
      usageDate: "2026-07-23",
      calledAt: "2026-07-23T00:00:00.000Z",
    });
    ai.createRequest({ appId, requestedName: "x", purpose: "p" });
  } finally {
    ai.close();
  }
  // V3-M5-T01(ADR-0055 限定4)。逃げ道(任意 CSS)の資産と申請。**3件目の孤児を作らない**
  // ため、`APP_SCOPED_KERNEL_TABLES` に載っていることを行の実在で確かめる。
  const digest = putEscapeHatchBody(dataRoot, appId, new TextEncoder().encode(".gp-view{}"));
  const hatch = EscapeHatchStore.openForKernel(dataRoot);
  try {
    hatch.issueEscapeHatchAsset({ appId, name: "compact", digest, scopeViews: ["v1"] });
    hatch.requestEscapeHatchAsset({
      appId,
      requestedName: "wide",
      purpose: "p",
      suggestedScopeViews: [],
    });
  } finally {
    hatch.close();
  }
  // V10-M10-T01(ADR-0366 CM-G3)。コメントの器。**4件目の孤児を作らない**ため、
  // テーブルを足すのと同じコミットで `APP_SCOPED_KERNEL_TABLES` に載せ、行の実在で確かめる。
  const comments = CommentStore.openForKernel(dataRoot);
  try {
    comments.addComment({
      appId,
      anchorForm: "view_field",
      anchorParts: ["v1", "title"],
      body: "この項目の説明が分かりにくい",
    });
  } finally {
    comments.close();
  }
}

/** 全 app_id-scoped テーブルに残る当該 app_id の行数の合計を数える。 */
function countScopedRows(appId: string): number {
  const db = new Database(join(dataRoot, "kernel.sqlite"));
  try {
    const existing = new Set(
      db
        .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all()
        .map((r) => r.name),
    );
    let total = 0;
    for (const table of [...APP_SCOPED_KERNEL_TABLES, "apps"]) {
      if (!existing.has(table)) {
        continue;
      }
      const row = db
        .query<{ c: number }, [string]>(`SELECT COUNT(*) AS c FROM "${table}" WHERE "app_id" = ?`)
        .get(appId);
      total += row?.c ?? 0;
    }
    return total;
  } finally {
    db.close();
  }
}

test("検証方法1: 削除後にディレクトリが無い かつ 台帳行・changelog 行も無い(非対称を1つのテストで塞ぐ)", () => {
  seedApp("todo");
  // 削除前は両方そろっている。
  expect(existsSync(appDir(dataRoot, "todo"))).toBe(true);
  {
    const store = KernelMetaStore.open(dataRoot);
    try {
      expect(store.getApp("todo")).not.toBeUndefined();
      expect(store.listChangelog("todo").length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  }

  const result = deleteApp(dataRoot, "todo");
  expect(result.valid).toBe(true);

  // (a) ディレクトリが無い。
  expect(existsSync(appDir(dataRoot, "todo"))).toBe(false);
  // (b) 台帳行・changelog 行が無い。**両方**をこのテストで見る。
  const store = KernelMetaStore.open(dataRoot);
  try {
    expect(store.getApp("todo")).toBeUndefined();
    expect(store.listChangelog("todo")).toEqual([]);
    expect(store.listAllChangelog().some((e) => e.app_id === "todo")).toBe(false);
  } finally {
    store.close();
  }
});

test("横断テーブル(#5)の当該 app_id 行がすべて消える", () => {
  seedApp("shop");
  seedApp("other");
  seedCrossCuttingRows("shop");
  seedCrossCuttingRows("other");

  expect(countScopedRows("shop")).toBeGreaterThan(1);

  const result = deleteApp(dataRoot, "shop");
  expect(result.valid).toBe(true);

  // shop の横断行・台帳行・changelog 行はすべて消えた。
  expect(countScopedRows("shop")).toBe(0);
  // other は1行も巻き込まれていない(app_id で正しく絞れている)。
  expect(countScopedRows("other")).toBeGreaterThan(1);
});

// --- V3-M5-T01 完了条件7: `delete_app` の孤児行を1件も増やさない(ADR-0055 限定4)-------
//
// **テーブルを足すのと同じコミットで `APP_SCOPED_KERNEL_TABLES` に載せる。**載せ忘れると
// 「消したつもりで残る」非対称が3件目として増える(既存の孤児2件 = `inbound_endpoints` /
// `inbound_endpoint_requests` は D-M3-8 で別タスクへ送り済みであり、本タスクでは直さない
// —— **直さないことと、3件目を作らないことは別である**)。
//
// **【2026-08-06 追記。V5-M2-T01】上の「本タスクでは直さない」は V3-M5-T01 時点の記述で
// あり、そのまま残す。** `inbound_endpoints` / `inbound_endpoint_requests` は
// `V5-M2-T01`(`R-G14`。門A本審査 `docs/plan/v5/records/v5-m0.md` §2-14 = 門外)で
// `APP_SCOPED_KERNEL_TABLES` に足した。**下の `toEqual` は 10 → 12 になる** ——
// この2行は「入れ替えを素通りさせない」ための固定であり、**足し忘れを検出する検査ではない**
// (`V5-M0` §2-14 S3 の 4 が「次に足し忘れたら赤くなる検査を1本も作らない」と申し送っている)。

test("V3-M5-T01: 逃げ道の2テーブルが APP_SCOPED_KERNEL_TABLES に載っている(単一ソースを固定する)", () => {
  const tables = [...APP_SCOPED_KERNEL_TABLES];
  expect(tables).toContain("escape_hatch_assets");
  expect(tables).toContain("escape_hatch_asset_requests");
  // 件数も固定する(8 → 10 → 12 → **13**。末尾2本は V5-M2-T01、13本目は V10-M10-T01)。
  // 1本消して1本足す入れ替えを素通りさせない。
  expect(tables).toEqual([
    "changelog",
    "ai_capabilities",
    "ai_jobs",
    "ai_usage",
    "ai_requests",
    "connections",
    "outbox",
    "connection_requests",
    "escape_hatch_assets",
    "escape_hatch_asset_requests",
    "inbound_endpoints",
    "inbound_endpoint_requests",
    "gp_comments",
  ]);
});

test("V3-M5-T01: 逃げ道の行と CSS の実体がアプリ削除で1件も残らない", () => {
  seedApp("hatch");
  seedCrossCuttingRows("hatch");

  // 削除前は資産の行も CSS の実体も在る。
  const hatchBefore = EscapeHatchStore.openForKernel(dataRoot);
  try {
    expect(hatchBefore.listEscapeHatchAssets("hatch")).toHaveLength(1);
    expect(hatchBefore.listPendingEscapeHatchAssetRequests("hatch")).toHaveLength(1);
  } finally {
    hatchBefore.close();
  }
  expect(existsSync(appEscapeHatchDir(dataRoot, "hatch"))).toBe(true);

  expect(deleteApp(dataRoot, "hatch").valid).toBe(true);

  // kernel.sqlite 側の2テーブルにも、ディスク上の実体にも1件も残らない。
  const hatchAfter = EscapeHatchStore.openForKernel(dataRoot);
  try {
    expect(hatchAfter.listEscapeHatchAssets("hatch")).toHaveLength(0);
    expect(hatchAfter.listPendingEscapeHatchAssetRequests("hatch")).toHaveLength(0);
  } finally {
    hatchAfter.close();
  }
  expect(existsSync(appEscapeHatchDir(dataRoot, "hatch"))).toBe(false);
});

// --- V10-M10-T01(ADR-0366 CM-G3): アプリを消すとコメントも消える -----------------------
//
// **この性質は本工程が初めて作った。** `ADR-0366` §Decision 5 の表は `undo` / `redo` に
// ついてしか述べていない —— **コメントは `undo` では巻き戻らないが、`delete_app` では消える。**
// **利用者が書き残した意見は、アプリの削除で1件も残らずに失われる**(限界として記録に書く)。

test("V10-M10-T01: コメントの行がアプリ削除で1件も残らない(別アプリのコメントは巻き添えにならない)", () => {
  seedApp("commented");
  seedApp("kept-app");
  seedCrossCuttingRows("commented");
  seedCrossCuttingRows("kept-app");

  const before = CommentStore.openForKernel(dataRoot);
  try {
    expect(before.listComments("commented")).toHaveLength(1);
    expect(before.listComments("kept-app")).toHaveLength(1);
  } finally {
    before.close();
  }

  expect(deleteApp(dataRoot, "commented").valid).toBe(true);

  const after = CommentStore.openForKernel(dataRoot);
  try {
    expect(after.listComments("commented")).toHaveLength(0);
    // 別アプリのコメントは1件も巻き添えになっていない(app_id で正しく絞れている)。
    expect(after.listComments("kept-app")).toHaveLength(1);
  } finally {
    after.close();
  }
});

test("検証方法2: 削除後に T04 の孤児検出(auditAppSnapshots)が空を返す", () => {
  seedApp("diary");
  // create_app 直後は snapshots は空。監査は全欄が空であることを確認しておく。
  const before = auditAppSnapshots(dataRoot, "diary");
  expect(before.orphans).toEqual([]);

  const result = deleteApp(dataRoot, "diary");
  expect(result.valid).toBe(true);

  const after = auditAppSnapshots(dataRoot, "diary");
  expect(after.on_disk).toEqual([]);
  expect(after.orphans).toEqual([]);
  expect(after.undo_snapshots).toEqual([]);
  expect(after.dangling_references).toEqual([]);
});

test("存在しない app_id の削除は統一形式エラーで拒否する(状態を変えない)", () => {
  seedApp("kept");

  const result = deleteApp(dataRoot, "ghost");
  expect(result.valid).toBe(false);
  if (result.valid) {
    throw new Error("unreachable");
  }
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]?.path).toBe("/app_id");
  expect(result.errors[0]?.allowed_values).toContain("kept");

  // 巻き添えで既存アプリを消していないこと。
  expect(existsSync(appDir(dataRoot, "kept"))).toBe(true);
});

test("apply 窓の最中の削除は統一形式エラーで拒否する(競合を避ける)", () => {
  seedApp("wip");
  beginApply(dataRoot, "wip", "d-in-flight");
  try {
    const result = deleteApp(dataRoot, "wip");
    expect(result.valid).toBe(false);
    if (result.valid) {
      throw new Error("unreachable");
    }
    expect(result.errors[0]?.message ?? "").toContain("適用中");
    // 拒否されたのでアプリは残っている。
    expect(existsSync(appDir(dataRoot, "wip"))).toBe(true);
  } finally {
    endApply(dataRoot, "wip");
  }
});

test("部分失敗(ディレクトリ削除失敗)を注入すると、台帳は先に消えて統一形式エラーを返す", () => {
  seedApp("broken");

  // ディレクトリ削除だけが失敗する状況を注入する(FS と kernel.sqlite は単一 tx に
  // 入らないので、この窓は構造的に残る。ゲート §4-2 窓A)。
  const result = deleteApp(dataRoot, "broken", {
    removeDir: () => {
      throw new Error("EACCES: 権限がありません(注入)");
    },
  });
  expect(result.valid).toBe(false);
  if (result.valid) {
    throw new Error("unreachable");
  }
  // hint に「台帳は消したがディレクトリが残っている」旨が入る。
  expect(result.errors[0]?.hint ?? "").toContain("data/apps/broken/");

  // **台帳は先に消えている**(失敗しても _apps に幽霊を出さない順序)。
  const store = KernelMetaStore.open(dataRoot);
  try {
    expect(store.getApp("broken")).toBeUndefined();
  } finally {
    store.close();
  }
  // 実体ディレクトリは残っている = 孤児ディレクトリとして検出可能。
  expect(existsSync(appDir(dataRoot, "broken"))).toBe(true);
});

test("削除は冪等でなくてよいが、snapshots ディレクトリの二重削除で壊れない(T04 プリミティブ経由)", () => {
  seedApp("dup");
  // snapshots ディレクトリを確実に存在させる。
  mkdirSync(appSnapshotsDir(dataRoot, "dup"), { recursive: true });
  const result = deleteApp(dataRoot, "dup");
  expect(result.valid).toBe(true);
  expect(existsSync(appDir(dataRoot, "dup"))).toBe(false);
});

// --- V3-M12-T04: アプリを削除しても受信口の行が残る(**今日の漏れ**)-------------------
//
// **`inbound_endpoints` / `inbound_endpoint_requests`(ADR-0041。V2-M5)は
// `APP_SCOPED_KERNEL_TABLES` に載っていない。** したがってアプリを削除しても、この2テーブルの
// 当該 app_id 行は `kernel.sqlite` に残る。`ADR-0031:118` は「新テーブルを足す ADR は本 ADR を
// 参照し、`APP_SCOPED_KERNEL_TABLES` への追記を完了条件に含めること」を義務として書いているが、
// `ADR-0041` はそれを履行していない(実測: `ADR-0041` に `0031` / `APP_SCOPED` の参照は0件)。
//
// **是正(配列に2行足すこと)は `src/kernel/delete-app.ts` = 製品コードの改変であり、
// `ADR-0007` §1b の `Δ7` catch-all により門A である**(`v3-m12-t00.md` §4-5 の裁定)。
// **`V3-M12` は門A本審査を1件も開かないので、`T04` の出口は「起票まで」であり、本タスクは
// 製品コードを1バイトも変えない。**
//
// **下の2本の役割分担**(`V3-M12-T04` 完了条件4):
//  - 1本目(有効)= **今日の事実**(行が残る)を固定する。**是正が入ると赤くなる** ——
//    そのとき2本目と一緒に書き換えるための目印である。
//  - 2本目(`test.skip`)= **是正後にあるべき姿**(行が消える)を固定する。**有効化すると今日は
//    赤い**(`v3-m12-t04.md` §5 に実測出力あり)。**`bun test` の fail を増やさないために
//    `test.skip` で置く** —— 赤いまま残すこと自体が目的ではなく、漏れを消さずに記述しておく
//    ことが目的である。**門A を通って是正するタスクが、この `.skip` を外して緑にする。**
//
// **【2026-08-06。V5-M2-T01 が是正した】上の段落は V3-M12-T04 時点の記述であり、そのまま残す。**
// 門A本審査(`docs/plan/v5/records/v5-m0.md` §2-14)が本件を **門外(記録)** と判定し、
// `V5-M2-T01` が `APP_SCOPED_KERNEL_TABLES` に2要素を足した。**`.skip` は外した**(2本目)。
// **1本目は「今日の事実」を固定するものだったので、是正によって偽になった** —— 予告どおり
// 2本目と一緒に書き換え、**単一ソースに2本が載っていること**を固定する形に変えた。
// **【是正の射程】足した2要素は、これ以降に呼ばれる `deleteApp` にしか効かない。**
// **既に `kernel.sqlite` に取り残されている行は、この2要素では1件も消えない。**
// 取り残しが今日いくつあるかは `V5-M2` では数えていない(`V5-M0` §2-14 S3 の 3)。

/** 受信口の2テーブル(`APP_SCOPED_KERNEL_TABLES` に**載っていない**)に残る当該 app_id の行数。 */
function countInboundRows(appId: string): { endpoints: number; requests: number } {
  const db = new Database(join(dataRoot, "kernel.sqlite"));
  try {
    const count = (table: string): number =>
      db
        .query<{ c: number }, [string]>(`SELECT COUNT(*) AS c FROM "${table}" WHERE "app_id" = ?`)
        .get(appId)?.c ?? 0;
    return { endpoints: count("inbound_endpoints"), requests: count("inbound_endpoint_requests") };
  } finally {
    db.close();
  }
}

/** 受信口を1つ発行し、申請を1件積む(2テーブルに1行ずつ入れる)。 */
function seedInboundRows(appId: string): void {
  const inbound = InboundStore.openForKernel(dataRoot);
  try {
    inbound.issueInboundEndpoint({
      appId,
      name: "psp-webhook",
      secretSource: { kind: "env", value: "PSP_WEBHOOK_SECRET" },
      targetTable: "payment_event",
    });
    inbound.requestInboundEndpoint({
      appId,
      requestedName: "shipping-webhook",
      purpose: "配送業者からの状態通知を受けたい",
      suggestedTargetTable: "shipping_event",
    });
  } finally {
    inbound.close();
  }
}

test("V5-M2-T01【是正の当て先】受信口の2テーブルが APP_SCOPED_KERNEL_TABLES に載っている", () => {
  // **V3-M12-T04 の1本目はここに `not.toContain` を書いて「今日の漏れ」を固定していた。**
  // `V5-M2-T01` が2要素を足したので、その形のままでは偽になる。**向きを反転させて残す** ——
  // 消すと「かつて載っていなかった」という事実が記録から消えるためである。
  //
  // **`string[]` へ広げているのは V3-M12-T04 から引き継いだ書き方である** ——
  // 当時は `APP_SCOPED_KERNEL_TABLES` が `as const` の10リテラルの union で、載っていない名前は
  // `toContain` の引数として**型検査を通らなかった**(`tsc` が TS2769)。**今日は載っているので
  // その非対称は型の側からは消えている。**
  const tables: string[] = [...APP_SCOPED_KERNEL_TABLES];
  expect(tables).toContain("inbound_endpoints");
  expect(tables).toContain("inbound_endpoint_requests");
});

test("V3-M12-T04【是正後に緑になる。門A の起票待ち → V5-M2-T01 が是正した】アプリ削除で受信口の2テーブルの行も消える", () => {
  seedApp("ec");
  seedInboundRows("ec");
  expect(countInboundRows("ec")).toEqual({ endpoints: 1, requests: 1 });

  expect(deleteApp(dataRoot, "ec").valid).toBe(true);

  // 是正後のあるべき姿。**今日は両方とも 1 のままなので赤い。**
  expect(countInboundRows("ec")).toEqual({ endpoints: 0, requests: 0 });
  const tables: string[] = [...APP_SCOPED_KERNEL_TABLES];
  expect(tables).toContain("inbound_endpoints");
  expect(tables).toContain("inbound_endpoint_requests");
});
