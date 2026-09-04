import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboundStore } from "./inbound-store.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { kernelDbPath } from "./storage-paths.ts";

/**
 * InboundStore の単体テスト(V2-M5-T01 / ADR-0041 §1・§3 限定表1/4/5)。
 *
 * capability-store.ts(送信 = connections)の**鏡写し**であり、受信 = inbound endpoint
 * を人間専用ストア(kernel.sqlite)に持つ。ADR-0041 の対称表(connection↔inbound endpoint /
 * grant↔inbound grant / secret 非保管↔検証鍵非保管 / 発行は人間・AI は申請だけ)を固定する。
 *
 * - **署名検証鍵は非保管**(SecretSource = 取得元への参照だけ。行に鍵本体が無い。限定4)。
 * - **書込先テーブルは1つ**(endpoint が app×table 1つへの inbound grant を内包する最小形。限定3)。
 * - **発行は人間 owner のみ・AI は申請だけ**(request は endpoint を発行しない。限定1)。
 * - `CREATE TABLE IF NOT EXISTS` なので既存 apps/changelog テーブルを壊さない(限定5)。
 */
describe("InboundStore", () => {
  let dataRoot: string;
  let store: InboundStore;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "gp-inbound-store-"));
    store = InboundStore.openForKernel(dataRoot);
  });

  afterEach(async () => {
    store.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  // --- inbound endpoint の発行(人間 owner 専用)-------------------------------

  test("issueInboundEndpoint → getInboundEndpoint で往復一致(env source・targetTable)", () => {
    const created = store.issueInboundEndpoint({
      appId: "app-a",
      name: "mock-psp",
      secretSource: { kind: "env", value: "MOCK_PSP_SIGNING_KEY" },
      targetTable: "payment_events",
    });
    expect(created.id).toBeTruthy();
    expect(created.createdAt).toBeTruthy();

    const fetched = store.getInboundEndpoint(created.id);
    expect(fetched).toBeDefined();
    expect(fetched?.appId).toBe("app-a");
    expect(fetched?.name).toBe("mock-psp");
    // 署名検証鍵の取得元(参照)が往復する。**鍵本体ではない。**
    expect(fetched?.secretSource).toEqual({ kind: "env", value: "MOCK_PSP_SIGNING_KEY" });
    // 書込先テーブルは1つ(inbound grant を内包する最小形)。
    expect(fetched?.targetTable).toBe("payment_events");
    expect(fetched?.createdAt).toBe(created.createdAt);
  });

  test("issueInboundEndpoint → getInboundEndpoint で往復一致(command source)", () => {
    const created = store.issueInboundEndpoint({
      appId: "app-a",
      name: "psp-op",
      secretSource: { kind: "command", value: "op read op://Private/PSP/signing-key" },
      targetTable: "payment_events",
    });
    const fetched = store.getInboundEndpoint(created.id);
    expect(fetched?.secretSource).toEqual({
      kind: "command",
      value: "op read op://Private/PSP/signing-key",
    });
    expect(fetched?.targetTable).toBe("payment_events");
  });

  test("getInboundEndpoint は未登録 id で undefined を返す", () => {
    expect(store.getInboundEndpoint("does-not-exist")).toBeUndefined();
  });

  test("listInboundEndpoints は app スコープで絞る(別 app の endpoint が混ざらない)", () => {
    store.issueInboundEndpoint({
      appId: "app-a",
      name: "ep-1",
      secretSource: { kind: "env", value: "A1" },
      targetTable: "t1",
    });
    store.issueInboundEndpoint({
      appId: "app-a",
      name: "ep-2",
      secretSource: { kind: "env", value: "A2" },
      targetTable: "t2",
    });
    store.issueInboundEndpoint({
      appId: "app-b",
      name: "ep-1",
      secretSource: { kind: "env", value: "B1" },
      targetTable: "t1",
    });

    const listA = store.listInboundEndpoints("app-a");
    expect(listA.map((e) => e.name).sort()).toEqual(["ep-1", "ep-2"]);
    expect(listA.every((e) => e.appId === "app-a")).toBe(true);

    const listB = store.listInboundEndpoints("app-b");
    expect(listB.map((e) => e.name)).toEqual(["ep-1"]);
  });

  test("deleteInboundEndpoint(失効)で消える", () => {
    const created = store.issueInboundEndpoint({
      appId: "app-a",
      name: "temp",
      secretSource: { kind: "env", value: "TMP" },
      targetTable: "t",
    });
    expect(store.getInboundEndpoint(created.id)).toBeDefined();
    store.deleteInboundEndpoint(created.id);
    expect(store.getInboundEndpoint(created.id)).toBeUndefined();
  });

  test("UNIQUE(app_id, name) 違反は弾かれる。別 app なら同名でも作れる", () => {
    store.issueInboundEndpoint({
      appId: "app-a",
      name: "dup",
      secretSource: { kind: "env", value: "X" },
      targetTable: "t",
    });
    expect(() =>
      store.issueInboundEndpoint({
        appId: "app-a",
        name: "dup",
        secretSource: { kind: "env", value: "Y" },
        targetTable: "t",
      }),
    ).toThrow();
    expect(() =>
      store.issueInboundEndpoint({
        appId: "app-b",
        name: "dup",
        secretSource: { kind: "env", value: "Z" },
        targetTable: "t",
      }),
    ).not.toThrow();
  });

  // --- 鍵非保管(限定4。行に鍵本体が無いことを設計で固定)------------------------

  test("行に署名検証鍵の本体が無い(secret_source_value は取得元の参照であって鍵値でない)", () => {
    store.issueInboundEndpoint({
      appId: "app-a",
      name: "mock-psp",
      // value は環境変数名(取得元)であって、鍵そのものではない。
      secretSource: { kind: "env", value: "MOCK_PSP_SIGNING_KEY" },
      targetTable: "payment_events",
    });

    // 生の DB 行を直接読み、鍵本体を保存する列が存在しないことを固定する。
    const db = new Database(kernelDbPath(dataRoot), { readonly: true });
    try {
      // スキーマ列名に "secret" や "key" の本体格納列が無い(取得元 kind/value だけ)。
      const columns = db
        .query<{ name: string }, []>(`PRAGMA table_info("inbound_endpoints")`)
        .all()
        .map((c) => c.name);
      expect(columns).toContain("secret_source_kind");
      expect(columns).toContain("secret_source_value");
      // 鍵本体を格納しそうな列は存在しない。
      expect(columns).not.toContain("secret");
      expect(columns).not.toContain("secret_value");
      expect(columns).not.toContain("signing_key");
      expect(columns).not.toContain("key");

      // secret_source_value は取得元(env 名)であって鍵値ではない。
      const row = db
        .query<{ secret_source_kind: string; secret_source_value: string }, []>(
          `SELECT "secret_source_kind", "secret_source_value" FROM "inbound_endpoints"`,
        )
        .get();
      expect(row?.secret_source_kind).toBe("env");
      expect(row?.secret_source_value).toBe("MOCK_PSP_SIGNING_KEY");
    } finally {
      db.close();
    }
  });

  // --- inbound endpoint の申請(AI 経路。ADR-0041 限定1)-------------------------

  test("requestInboundEndpoint → listPendingInboundEndpointRequests 往復(status=pending)", () => {
    const created = store.requestInboundEndpoint({
      appId: "app-a",
      requestedName: "mock-psp",
      purpose: "決済 Webhook を受け取るため",
      suggestedTargetTable: "payment_events",
    });
    expect(created.id).toBeTruthy();
    expect(created.createdAt).toBeTruthy();
    expect(created.status).toBe("pending");

    const pending = store.listPendingInboundEndpointRequests("app-a");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(created.id);
    expect(pending[0]?.requestedName).toBe("mock-psp");
    expect(pending[0]?.purpose).toBe("決済 Webhook を受け取るため");
    expect(pending[0]?.suggestedTargetTable).toBe("payment_events");
  });

  test("getInboundEndpointRequest で1件取得できる。未登録 id は undefined", () => {
    const created = store.requestInboundEndpoint({
      appId: "app-a",
      requestedName: "ep",
      purpose: "x",
      suggestedTargetTable: "t",
    });
    expect(store.getInboundEndpointRequest(created.id)?.requestedName).toBe("ep");
    expect(store.getInboundEndpointRequest("does-not-exist")).toBeUndefined();
  });

  test("markInboundEndpointRequest(approved) で pending から外れる(get では読める)", () => {
    const created = store.requestInboundEndpoint({
      appId: "app-a",
      requestedName: "ep",
      purpose: "x",
      suggestedTargetTable: "t",
    });
    store.markInboundEndpointRequest(created.id, "approved");
    expect(store.listPendingInboundEndpointRequests("app-a")).toHaveLength(0);
    expect(store.getInboundEndpointRequest(created.id)?.status).toBe("approved");
  });

  test("markInboundEndpointRequest(rejected) でも pending から外れる", () => {
    const created = store.requestInboundEndpoint({
      appId: "app-a",
      requestedName: "ep",
      purpose: "x",
      suggestedTargetTable: "t",
    });
    store.markInboundEndpointRequest(created.id, "rejected");
    expect(store.listPendingInboundEndpointRequests("app-a")).toHaveLength(0);
    expect(store.getInboundEndpointRequest(created.id)?.status).toBe("rejected");
  });

  test("listPendingInboundEndpointRequests は app スコープで絞る", () => {
    store.requestInboundEndpoint({
      appId: "app-a",
      requestedName: "a1",
      purpose: "x",
      suggestedTargetTable: "t",
    });
    store.requestInboundEndpoint({
      appId: "app-a",
      requestedName: "a2",
      purpose: "x",
      suggestedTargetTable: "t",
    });
    store.requestInboundEndpoint({
      appId: "app-b",
      requestedName: "b1",
      purpose: "x",
      suggestedTargetTable: "t",
    });

    expect(
      store
        .listPendingInboundEndpointRequests("app-a")
        .map((r) => r.requestedName)
        .sort(),
    ).toEqual(["a1", "a2"]);
    expect(store.listPendingInboundEndpointRequests("app-b").map((r) => r.requestedName)).toEqual([
      "b1",
    ]);
  });

  // --- AI 経路(申請)からは endpoint が発行されない(限定1 の核心)---------------

  test("申請は inbound_endpoints を1件も作らない(AI は申請だけ・発行は人間)", () => {
    store.requestInboundEndpoint({
      appId: "app-a",
      requestedName: "mock-psp",
      purpose: "x",
      suggestedTargetTable: "payment_events",
    });
    // 申請だけでは endpoint は生えない(発行は別関数 = 人間経路)。
    expect(store.listInboundEndpoints("app-a")).toHaveLength(0);
  });

  // --- 既存テーブルを壊さない(限定5。CREATE TABLE IF NOT EXISTS)---------------

  test("KernelMetaStore と同一 dataRoot で共存でき、双方が読み書きできる", () => {
    const meta = KernelMetaStore.open(dataRoot);
    try {
      meta.registerApp({ app_id: "coexist-app", name: "共存アプリ" });
      expect(meta.getApp("coexist-app")?.name).toBe("共存アプリ");
      meta.appendChangelog({
        app_id: "coexist-app",
        diff_id: "diff-1",
        intent: "初期化",
        operations: [],
      });
      expect(meta.listChangelog("coexist-app")).toHaveLength(1);

      // InboundStore 側も同じ dataRoot の kernel.sqlite で読み書きできる。
      const ep = store.issueInboundEndpoint({
        appId: "coexist-app",
        name: "ep",
        secretSource: { kind: "env", value: "COEXIST" },
        targetTable: "events",
      });
      expect(store.getInboundEndpoint(ep.id)?.targetTable).toBe("events");

      // meta 側が別ハンドルを開いても inbound テーブル追加で壊れていない。
      const meta2 = KernelMetaStore.open(dataRoot);
      try {
        expect(meta2.listApps().map((a) => a.app_id)).toContain("coexist-app");
      } finally {
        meta2.close();
      }
    } finally {
      meta.close();
    }
  });

  // --- CapabilityStore(送信)と共存できる(同じ kernel.sqlite・別テーブル)-------

  test("CapabilityStore(connections)と同一 kernel.sqlite に共存できる", async () => {
    // 送信ストアと受信ストアが同じ kernel.sqlite を別ハンドルで開いても互いを壊さない。
    const { CapabilityStore } = await import("./capability-store.ts");
    const cap = CapabilityStore.openForKernel(dataRoot);
    try {
      const conn = cap.createConnection({
        appId: "app-a",
        name: "psp-send",
        allowedHosts: ["127.0.0.1"],
        secretSource: { kind: "env", value: "SEND_KEY" },
      });
      const ep = store.issueInboundEndpoint({
        appId: "app-a",
        name: "psp-recv",
        secretSource: { kind: "env", value: "RECV_KEY" },
        targetTable: "payment_events",
      });
      expect(cap.getConnection(conn.id)?.name).toBe("psp-send");
      expect(store.getInboundEndpoint(ep.id)?.name).toBe("psp-recv");
    } finally {
      cap.close();
    }
  });
});

// --- V5-M15(`G-G9` / `G-G10` / `ADR-0160`): 署名の形の宣言 -----------------------------
//
// **受信口ごとに「どのヘッダに署名が載るか」「値がどう書き表されているか」を宣言できる。**
// **書けるのは人間 owner の発行・更新の口だけである**(`ADR-0160` 限定6 = `ADR-0041` 限定1
// を1ミリも緩めない)。**AI 経路(`requestInboundEndpoint` / MCP / `apply_diff`)からは
// 1バイトも書けない** —— 申請の入力に署名の形を書く場所が無いことを固定する。

describe("InboundStore: 署名の形の宣言(ADR-0160)", () => {
  let dataRoot: string;
  let store: InboundStore;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "gp-inbound-sig-"));
    store = InboundStore.openForKernel(dataRoot);
  });

  afterEach(async () => {
    store.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  test("限定8: 宣言しないで発行すると既定(X-Mock-PSP-Signature / sha256_hex)になる", () => {
    const created = store.issueInboundEndpoint({
      appId: "app-a",
      name: "default-shape",
      secretSource: { kind: "env", value: "K" },
      targetTable: "t",
    });
    expect(created.signatureHeader).toBe("X-Mock-PSP-Signature");
    expect(created.signatureFormat).toBe("sha256_hex");
    const fetched = store.getInboundEndpoint(created.id);
    expect(fetched?.signatureHeader).toBe("X-Mock-PSP-Signature");
    expect(fetched?.signatureFormat).toBe("sha256_hex");
  });

  test("宣言して発行すると往復一致する(GitHub 形式)", () => {
    const created = store.issueInboundEndpoint({
      appId: "app-a",
      name: "github",
      secretSource: { kind: "env", value: "K" },
      targetTable: "t",
      signatureHeader: "X-Hub-Signature-256",
      signatureFormat: "sha256_hex",
    });
    const fetched = store.getInboundEndpoint(created.id);
    expect(fetched?.signatureHeader).toBe("X-Hub-Signature-256");
    expect(fetched?.signatureFormat).toBe("sha256_hex");
    // 一覧経由でも同じ値が返る(読み口を1本だけ直して他を忘れていないこと)。
    expect(store.listInboundEndpoints("app-a")[0]?.signatureHeader).toBe("X-Hub-Signature-256");
  });

  test("限定6: 発行済みの受信口の署名の形を、人間 owner の更新の口で差し替えられる", () => {
    const created = store.issueInboundEndpoint({
      appId: "app-a",
      name: "movable",
      secretSource: { kind: "env", value: "K" },
      targetTable: "t",
    });
    store.updateInboundEndpointSignature(created.id, {
      signatureHeader: "X-Hub-Signature-256",
      signatureFormat: "base64",
    });
    const fetched = store.getInboundEndpoint(created.id);
    expect(fetched?.signatureHeader).toBe("X-Hub-Signature-256");
    expect(fetched?.signatureFormat).toBe("base64");
  });

  test("限定2 / 限定4: 値域の外は発行でも更新でも拒否され、1行も書かれない", () => {
    expect(() =>
      store.issueInboundEndpoint({
        appId: "app-a",
        name: "bad-header",
        secretSource: { kind: "env", value: "K" },
        targetTable: "t",
        // 自由文字列は書けない(有限3値の列挙で閉じている)。
        signatureHeader: "X-Whatever-Signature" as never,
      }),
    ).toThrow(/signature_header/);
    expect(() =>
      store.issueInboundEndpoint({
        appId: "app-a",
        name: "bad-format",
        secretSource: { kind: "env", value: "K" },
        targetTable: "t",
        signatureFormat: "sha512_hex" as never,
      }),
    ).toThrow(/signature_format/);
    // 拒否された発行は1行も残っていない。
    expect(store.listInboundEndpoints("app-a").length).toBe(0);

    const ok = store.issueInboundEndpoint({
      appId: "app-a",
      name: "ok",
      secretSource: { kind: "env", value: "K" },
      targetTable: "t",
    });
    expect(() =>
      store.updateInboundEndpointSignature(ok.id, {
        signatureHeader: "Stripe-Signature",
        signatureFormat: "ed25519" as never,
      }),
    ).toThrow(/signature_format/);
    // 拒否された更新は既定のままで、1バイトも変わっていない。
    expect(store.getInboundEndpoint(ok.id)?.signatureHeader).toBe("X-Mock-PSP-Signature");
    expect(store.getInboundEndpoint(ok.id)?.signatureFormat).toBe("sha256_hex");
  });

  test("限定1: 署名ヘッダを書く列は1本しかない(2本目のヘッダを書く場所が無い)", () => {
    const db = new Database(kernelDbPath(dataRoot), { readonly: true });
    try {
      const columns = db
        .query<{ name: string }, []>(`PRAGMA table_info("inbound_endpoints")`)
        .all()
        .map((c) => c.name);
      expect(columns.filter((c) => c.includes("signature_header")).length).toBe(1);
      expect(columns.filter((c) => c.includes("signature_format")).length).toBe(1);
      // クエリパラメータ・body 内署名フィールドの置き場も無い。
      expect(columns.some((c) => c.includes("query") || c.includes("body"))).toBe(false);
    } finally {
      db.close();
    }
  });

  test("限定2 / 限定4: DB の CHECK 制約が値域の外を弾く(コード層を迂回しても入らない)", () => {
    const db = new Database(kernelDbPath(dataRoot), { readwrite: true });
    try {
      expect(() =>
        db
          .query(
            `INSERT INTO "inbound_endpoints"
               ("id","app_id","name","secret_source_kind","secret_source_value",
                "target_table","created_at","signature_header","signature_format")
             VALUES ('x','app-a','raw','env','K','t','2026-08-05T00:00:00.000Z','X-Free-Form','hex')`,
          )
          .run(),
      ).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });

  test("限定6: 申請(AI 経路)には署名の形を書く場所が1つも無い", () => {
    const request = store.requestInboundEndpoint({
      appId: "app-a",
      requestedName: "from-ai",
      purpose: "外部サービスからの通知を受けるため",
      suggestedTargetTable: "t",
    });
    // 申請の行にも、申請テーブルの列にも、署名の形は1つも無い。
    expect(Object.keys(request)).not.toContain("signatureHeader");
    expect(Object.keys(request)).not.toContain("signatureFormat");
    const db = new Database(kernelDbPath(dataRoot), { readonly: true });
    try {
      const columns = db
        .query<{ name: string }, []>(`PRAGMA table_info("inbound_endpoint_requests")`)
        .all()
        .map((c) => c.name);
      expect(columns.some((c) => c.includes("signature"))).toBe(false);
    } finally {
      db.close();
    }
    // 申請は発行済みの受信口を1件も作らない(ADR-0041 限定1 は1ミリも緩んでいない)。
    expect(store.listInboundEndpoints("app-a").length).toBe(0);
  });

  test("既存 DB(署名の形の列が無い)を開いても壊れず、既定値が入る(移行)", async () => {
    // V5-M15 より前のスキーマをそのまま作る(2列が無い状態)。
    const oldRoot = await mkdtemp(join(tmpdir(), "gp-inbound-old-"));
    try {
      const db = new Database(kernelDbPath(oldRoot), { create: true });
      db.exec(`
        CREATE TABLE "inbound_endpoints" (
          "id" TEXT PRIMARY KEY,
          "app_id" TEXT NOT NULL,
          "name" TEXT NOT NULL,
          "secret_source_kind" TEXT NOT NULL CHECK("secret_source_kind" IN ('env','command')),
          "secret_source_value" TEXT NOT NULL,
          "target_table" TEXT NOT NULL,
          "created_at" TEXT NOT NULL,
          UNIQUE ("app_id", "name")
        );
      `);
      db.query(
        `INSERT INTO "inbound_endpoints"
           ("id","app_id","name","secret_source_kind","secret_source_value","target_table","created_at")
         VALUES ('old-1','app-a','legacy','env','K','t','2026-07-24T00:00:00.000Z')`,
      ).run();
      db.close();

      const migrated = InboundStore.openForKernel(oldRoot);
      try {
        const fetched = migrated.getInboundEndpoint("old-1");
        expect(fetched?.name).toBe("legacy");
        // **既に在る受信口は今日どおりで、1つも壊れない**(限定8)。
        expect(fetched?.signatureHeader).toBe("X-Mock-PSP-Signature");
        expect(fetched?.signatureFormat).toBe("sha256_hex");
      } finally {
        migrated.close();
      }
    } finally {
      await rm(oldRoot, { recursive: true, force: true });
    }
  });
});
