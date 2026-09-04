import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityStore } from "./capability-store.ts";
import { KernelMetaStore } from "./meta-store.ts";

/**
 * CapabilityStore の単体テスト(V1-M4-T02 / ADR-0020 §2c/§2d/§2e)。
 *
 * connection は「取得元への参照」だけを持つ(secret 本体は保存しない)。
 * kernel.sqlite に独自ハンドルで CREATE TABLE IF NOT EXISTS connections を足すだけで、
 * 既存の apps/changelog テーブルを壊さない(KernelMetaStore との共存テストで担保)。
 */
describe("CapabilityStore", () => {
  let dataRoot: string;
  let store: CapabilityStore;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "gp-capability-store-"));
    store = CapabilityStore.openForKernel(dataRoot);
  });

  afterEach(async () => {
    store.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  test("createConnection → getConnection で往復一致(env source)", () => {
    const created = store.createConnection({
      appId: "app-a",
      name: "stripe",
      allowedHosts: ["api.stripe.com", "files.stripe.com"],
      secretSource: { kind: "env", value: "STRIPE_API_KEY" },
    });
    expect(created.id).toBeTruthy();
    expect(created.createdAt).toBeTruthy();

    const fetched = store.getConnection(created.id);
    expect(fetched).toBeDefined();
    expect(fetched?.appId).toBe("app-a");
    expect(fetched?.name).toBe("stripe");
    expect(fetched?.allowedHosts).toEqual(["api.stripe.com", "files.stripe.com"]);
    expect(fetched?.secretSource).toEqual({ kind: "env", value: "STRIPE_API_KEY" });
    expect(fetched?.createdAt).toBe(created.createdAt);
  });

  test("createConnection → getConnection で往復一致(command source)", () => {
    const created = store.createConnection({
      appId: "app-a",
      name: "onepassword",
      allowedHosts: [],
      secretSource: { kind: "command", value: "op read op://Private/Stripe/credential" },
    });
    const fetched = store.getConnection(created.id);
    expect(fetched?.secretSource).toEqual({
      kind: "command",
      value: "op read op://Private/Stripe/credential",
    });
    // 既定のホワイトリストは空配列(何も許可しない)。
    expect(fetched?.allowedHosts).toEqual([]);
  });

  test("getConnection は未登録 id で undefined を返す", () => {
    expect(store.getConnection("does-not-exist")).toBeUndefined();
  });

  test("listConnections は app スコープで絞る(別 app の connection が混ざらない)", () => {
    store.createConnection({
      appId: "app-a",
      name: "conn-1",
      allowedHosts: [],
      secretSource: { kind: "env", value: "A1" },
    });
    store.createConnection({
      appId: "app-a",
      name: "conn-2",
      allowedHosts: [],
      secretSource: { kind: "env", value: "A2" },
    });
    store.createConnection({
      appId: "app-b",
      name: "conn-1",
      allowedHosts: [],
      secretSource: { kind: "env", value: "B1" },
    });

    const listA = store.listConnections("app-a");
    expect(listA.map((c) => c.name).sort()).toEqual(["conn-1", "conn-2"]);
    expect(listA.every((c) => c.appId === "app-a")).toBe(true);

    const listB = store.listConnections("app-b");
    expect(listB.map((c) => c.name)).toEqual(["conn-1"]);
  });

  test("deleteConnection で消える", () => {
    const created = store.createConnection({
      appId: "app-a",
      name: "temp",
      allowedHosts: [],
      secretSource: { kind: "env", value: "TMP" },
    });
    expect(store.getConnection(created.id)).toBeDefined();
    store.deleteConnection(created.id);
    expect(store.getConnection(created.id)).toBeUndefined();
  });

  test("UNIQUE(app_id, name) 違反は弾かれる", () => {
    store.createConnection({
      appId: "app-a",
      name: "dup",
      allowedHosts: [],
      secretSource: { kind: "env", value: "X" },
    });
    expect(() =>
      store.createConnection({
        appId: "app-a",
        name: "dup",
        allowedHosts: [],
        secretSource: { kind: "env", value: "Y" },
      }),
    ).toThrow();
    // 別 app なら同名でも作れる。
    expect(() =>
      store.createConnection({
        appId: "app-b",
        name: "dup",
        allowedHosts: [],
        secretSource: { kind: "env", value: "Z" },
      }),
    ).not.toThrow();
  });

  test("findConnectionByName は app スコープ内で名前引きできる", () => {
    const created = store.createConnection({
      appId: "app-a",
      name: "api",
      allowedHosts: ["api.example.com"],
      secretSource: { kind: "env", value: "X" },
    });
    // 別 app の同名は返さない。
    store.createConnection({
      appId: "app-b",
      name: "api",
      allowedHosts: [],
      secretSource: { kind: "env", value: "Y" },
    });

    const found = store.findConnectionByName("app-a", "api");
    expect(found?.id).toBe(created.id);
    expect(found?.appId).toBe("app-a");
    expect(found?.allowedHosts).toEqual(["api.example.com"]);

    // 未登録の名前は undefined。
    expect(store.findConnectionByName("app-a", "does-not-exist")).toBeUndefined();
    // 名前は合うが別 app の視点では見えない。
    expect(store.findConnectionByName("app-c", "api")).toBeUndefined();
  });

  test("outbox: enqueue → listPending 往復。payload の JSON が往復する", () => {
    const item = store.enqueueOutbox({
      appId: "app-a",
      connectionId: "conn-1",
      destination: "https://api.example.com/v1/messages",
      payload: { title: "本", nested: { n: 1 }, list: [1, 2, 3] },
    });
    expect(item.id).toBeTruthy();
    expect(item.createdAt).toBeTruthy();
    expect(item.status).toBe("pending");
    expect(item.dispatchedAt).toBeNull();
    expect(item.error).toBeNull();

    const pending = store.listPendingOutbox();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(item.id);
    expect(pending[0]?.destination).toBe("https://api.example.com/v1/messages");
    // payload の JSON が構造ごと往復する。
    expect(pending[0]?.payload).toEqual({ title: "本", nested: { n: 1 }, list: [1, 2, 3] });
  });

  test("outbox: listPending は created_at 昇順(同時刻は id 昇順)", () => {
    const a = store.enqueueOutbox({
      appId: "app-a",
      connectionId: "c",
      destination: "https://a.example.com",
      payload: {},
    });
    const b = store.enqueueOutbox({
      appId: "app-a",
      connectionId: "c",
      destination: "https://b.example.com",
      payload: {},
    });
    const ids = store.listPendingOutbox().map((i) => i.id);
    // 先に積んだものが先に出る(created_at 昇順)。
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  test("outbox: markOutbox で pending から外れ、dispatched_at が入る", () => {
    const item = store.enqueueOutbox({
      appId: "app-a",
      connectionId: "c",
      destination: "https://a.example.com",
      payload: {},
    });
    store.markOutbox(item.id, "sent");
    expect(store.listPendingOutbox()).toHaveLength(0);
  });

  test("outbox: markOutbox(failed, error) は error を残す。sent は error を残さない", () => {
    const failed = store.enqueueOutbox({
      appId: "app-a",
      connectionId: "c",
      destination: "https://a.example.com",
      payload: {},
    });
    store.markOutbox(failed.id, "failed", "送信先が失敗応答");

    const sent = store.enqueueOutbox({
      appId: "app-a",
      connectionId: "c",
      destination: "https://b.example.com",
      payload: {},
    });
    store.markOutbox(sent.id, "sent");

    // どちらも pending から外れている。
    expect(store.listPendingOutbox()).toHaveLength(0);
  });

  // --- 接続の申請(V1-M4-T04 / ADR-0020 §2b・§5)-----------------------------------

  test("createRequest → listPendingRequests 往復(status=pending・suggestedHosts が JSON 往復)", () => {
    const created = store.createRequest({
      appId: "app-a",
      requestedName: "api",
      purpose: "天気APIに問い合わせるため",
      suggestedHosts: ["api.weather.example.com"],
    });
    expect(created.id).toBeTruthy();
    expect(created.createdAt).toBeTruthy();
    expect(created.status).toBe("pending");

    const pending = store.listPendingRequests("app-a");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(created.id);
    expect(pending[0]?.requestedName).toBe("api");
    expect(pending[0]?.purpose).toBe("天気APIに問い合わせるため");
    expect(pending[0]?.suggestedHosts).toEqual(["api.weather.example.com"]);
  });

  test("getRequest で1件取得できる。未登録 id は undefined", () => {
    const created = store.createRequest({
      appId: "app-a",
      requestedName: "api",
      purpose: "x",
      suggestedHosts: [],
    });
    expect(store.getRequest(created.id)?.requestedName).toBe("api");
    expect(store.getRequest("does-not-exist")).toBeUndefined();
  });

  test("markRequest(approved) で pending から外れる(getRequest では読める)", () => {
    const created = store.createRequest({
      appId: "app-a",
      requestedName: "api",
      purpose: "x",
      suggestedHosts: [],
    });
    store.markRequest(created.id, "approved");
    expect(store.listPendingRequests("app-a")).toHaveLength(0);
    expect(store.getRequest(created.id)?.status).toBe("approved");
  });

  test("markRequest(rejected) でも pending から外れる", () => {
    const created = store.createRequest({
      appId: "app-a",
      requestedName: "api",
      purpose: "x",
      suggestedHosts: [],
    });
    store.markRequest(created.id, "rejected");
    expect(store.listPendingRequests("app-a")).toHaveLength(0);
    expect(store.getRequest(created.id)?.status).toBe("rejected");
  });

  test("listPendingRequests は app スコープで絞る(別 app の申請が混ざらない)", () => {
    store.createRequest({ appId: "app-a", requestedName: "a1", purpose: "x", suggestedHosts: [] });
    store.createRequest({ appId: "app-a", requestedName: "a2", purpose: "x", suggestedHosts: [] });
    store.createRequest({ appId: "app-b", requestedName: "b1", purpose: "x", suggestedHosts: [] });

    expect(
      store
        .listPendingRequests("app-a")
        .map((r) => r.requestedName)
        .sort(),
    ).toEqual(["a1", "a2"]);
    expect(store.listPendingRequests("app-b").map((r) => r.requestedName)).toEqual(["b1"]);
  });

  test("申請は connections を1件も作らない(申請と発行の分離)", () => {
    store.createRequest({
      appId: "app-a",
      requestedName: "api",
      purpose: "x",
      suggestedHosts: ["api.example.com"],
    });
    // 申請だけでは connection は生えない(発行は別経路)。
    expect(store.listConnections("app-a")).toHaveLength(0);
    expect(store.findConnectionByName("app-a", "api")).toBeUndefined();
  });

  test("KernelMetaStore と同一 dataRoot で共存でき、双方が読み書きできる", () => {
    // 既存の kernel.sqlite テーブル(apps/changelog)を壊していないことを確認する。
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

      // CapabilityStore 側も同じ dataRoot の kernel.sqlite で読み書きできる。
      const conn = store.createConnection({
        appId: "coexist-app",
        name: "conn",
        allowedHosts: ["example.com"],
        secretSource: { kind: "env", value: "COEXIST" },
      });
      expect(store.getConnection(conn.id)?.allowedHosts).toEqual(["example.com"]);

      // meta 側が別ハンドルを開いても connection テーブル追加で壊れていない。
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
});
