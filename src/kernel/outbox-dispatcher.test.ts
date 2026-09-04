import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityStore } from "./capability-store.ts";
import { dispatchOutbox, outboundFetch } from "./outbox-dispatcher.ts";
import { kernelDbPath } from "./storage-paths.ts";

/**
 * アウトボックス配送(V1-M4-T03 / ADR-0020 §3 改訂2)の検査。
 *
 * 主眼は2つ:
 * 1. use-time に secret を解決し、`Authorization: Bearer <secret>` で送ること。
 * 2. **secret の漏えいが無いこと** —— 失敗しても secret 値は error / ログ / outbox の
 *    どの列にも入らない(kernel.sqlite バイナリ走査でセンチネルが0バイト)。
 */

const VAR = "ST_T03_SECRET";
const APP_ID = "ext-app";

let dataRoot: string;
let sentinel: string;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-outbox-dispatch-"));
  sentinel = `SENTINEL-${crypto.randomUUID()}`;
});

afterEach(async () => {
  delete process.env[VAR];
  await rm(dataRoot, { recursive: true, force: true });
});

/** 接続を1本作り、その接続宛の outbox を1件積む。connectionId を返す。 */
function seedOutbox(allowedHosts: string[] = ["api.example.com"]): {
  connectionId: string;
} {
  const store = CapabilityStore.openForKernel(dataRoot);
  try {
    const conn = store.createConnection({
      appId: APP_ID,
      name: "api",
      allowedHosts,
      secretSource: { kind: "env", value: VAR },
    });
    store.enqueueOutbox({
      appId: APP_ID,
      connectionId: conn.id,
      destination: "https://api.example.com/v1/messages",
      payload: { title: "本" },
    });
    return { connectionId: conn.id };
  } finally {
    store.close();
  }
}

/** outbox の全行を生 SQL で読む(status / error を直接検査するため)。 */
function readOutboxRows(): { status: string; error: string | null }[] {
  const db = new Database(kernelDbPath(dataRoot));
  try {
    return db.query(`SELECT "status", "error" FROM "outbox"`).all() as {
      status: string;
      error: string | null;
    }[];
  } finally {
    db.close();
  }
}

/** kernel.sqlite(+ WAL / SHM)をバイナリで読み、センチネルが1バイトも無いことを確認する。 */
function assertNoSentinelOnDisk(): void {
  const dbPath = kernelDbPath(dataRoot);
  const needle = Buffer.from(sentinel, "utf8");
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch {
      continue; // -wal / -shm は存在しないことがある。
    }
    expect(bytes.includes(needle)).toBe(false);
  }
}

describe("outboundFetch", () => {
  test("destination・Bearer secret・JSON body で1回呼ばれ、res.ok を返す", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const spyFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const ok = await outboundFetch(
      "https://api.example.com/x",
      { title: "本" },
      sentinel,
      spyFetch,
    );

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.example.com/x");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${sentinel}`);
    expect(headers["content-type"]).toBe("application/json");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ title: "本" }));
  });

  test("fetch が例外を投げても握って false を返す(secret を漏らさない)", async () => {
    const throwing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await outboundFetch("https://api.example.com/x", {}, sentinel, throwing)).toBe(false);
  });
});

describe("dispatchOutbox", () => {
  test("pending を配送し、Bearer <センチネル> で送って sent にする", async () => {
    process.env[VAR] = sentinel;
    seedOutbox();

    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const spyFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const result = await dispatchOutbox(dataRoot, spyFetch);
    expect(result).toEqual({ sent: 1, failed: 0 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.example.com/v1/messages");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${sentinel}`);

    // pending から外れている。
    const store = CapabilityStore.openForKernel(dataRoot);
    try {
      expect(store.listPendingOutbox()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  test("secret 漏えい: fetch が失敗しても error にセンチネルが入らず、DB にも0バイト", async () => {
    process.env[VAR] = sentinel;
    seedOutbox();

    // ok:false を返す fetch(secret は解決されるが、失敗理由に混ぜてはならない)。
    const failing = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    const result = await dispatchOutbox(dataRoot, failing);
    expect(result).toEqual({ sent: 0, failed: 1 });

    const rows = readOutboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.error).toBe("送信先が失敗応答");
    expect(rows[0]?.error).not.toContain(sentinel);

    // **主保証**: kernel.sqlite のどのファイルにもセンチネルが1バイトも無い。
    assertNoSentinelOnDisk();
  });

  test("secret 解決失敗(env 未設定): failed になり、fetch は呼ばれない・error にセンチネル非混入", async () => {
    // env を設定しない(seedOutbox は変数名だけを保存する)。
    seedOutbox();

    const calls: unknown[] = [];
    const spyFetch = (async () => {
      calls.push(1);
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const result = await dispatchOutbox(dataRoot, spyFetch);
    expect(result).toEqual({ sent: 0, failed: 1 });
    expect(calls).toHaveLength(0); // secret を解決できないので送信を試みない。

    const rows = readOutboxRows();
    expect(rows[0]?.status).toBe("failed");
    // 参照(変数名)は理由に含まれてよいが、解決値(センチネル)は含まれない(そもそも未設定)。
    expect(rows[0]?.error).not.toContain(sentinel);
    assertNoSentinelOnDisk();
  });

  test("配送時スコープ再検証: 積まれた宛先が接続の許可スコープ外なら fetch せず failed(多層防御)", async () => {
    // env は設定するが、スコープ外遮断が secret 解決より先に効くことを示すため、
    // 失敗理由が「スコープ外」であって「secret 解決失敗」ではないことを確かめる。
    process.env[VAR] = sentinel;

    // 接続は allowedHosts=["api.example.com"] で作るが、**enqueueOutbox を直接呼んで**
    // スコープ外の宛先(https://evil.example/x)の行を人為的に作る。これは「将来 owner が
    // 許可ホストを狭め、enqueue 済みの行が旧スコープの宛先を指したまま残った」状況の模擬である。
    const store = CapabilityStore.openForKernel(dataRoot);
    try {
      const conn = store.createConnection({
        appId: APP_ID,
        name: "api",
        allowedHosts: ["api.example.com"],
        secretSource: { kind: "env", value: VAR },
      });
      store.enqueueOutbox({
        appId: APP_ID,
        connectionId: conn.id,
        destination: "https://evil.example/x",
        payload: { title: "本" },
      });
    } finally {
      store.close();
    }

    const calls: unknown[] = [];
    const spyFetch = (async () => {
      calls.push(1);
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const result = await dispatchOutbox(dataRoot, spyFetch);
    expect(result).toEqual({ sent: 0, failed: 1 });
    expect(calls).toHaveLength(0); // スコープ外なので送信を試みない。

    const rows = readOutboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
    // 失敗理由はスコープ外の再検証であって secret 解決失敗ではない。
    expect(rows[0]?.error).toContain("スコープ外");
    expect(rows[0]?.error).toContain("配送時");
    // secret(センチネル)は理由に混ざらない。
    expect(rows[0]?.error).not.toContain(sentinel);
    assertNoSentinelOnDisk();
  });

  test("配送時スコープ再検証: env 未設定でも、スコープ外の失敗理由は secret 解決失敗より優先される", async () => {
    // env を設定しない。もし secret 解決を先に走らせていれば「解決失敗」になるが、
    // スコープ再検証を secret 解決の**前**に置いているので、理由は「スコープ外」になる。
    const store = CapabilityStore.openForKernel(dataRoot);
    try {
      const conn = store.createConnection({
        appId: APP_ID,
        name: "api",
        allowedHosts: ["api.example.com"],
        secretSource: { kind: "env", value: VAR },
      });
      store.enqueueOutbox({
        appId: APP_ID,
        connectionId: conn.id,
        destination: "https://evil.example/x",
        payload: { title: "本" },
      });
    } finally {
      store.close();
    }

    const calls: unknown[] = [];
    const spyFetch = (async () => {
      calls.push(1);
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const result = await dispatchOutbox(dataRoot, spyFetch);
    expect(result).toEqual({ sent: 0, failed: 1 });
    expect(calls).toHaveLength(0);

    const rows = readOutboxRows();
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.error).toContain("スコープ外");
  });

  test("回帰: スコープ内の正規行は従来どおり sent になる(再検証で壊れていない)", async () => {
    process.env[VAR] = sentinel;
    seedOutbox(); // destination=https://api.example.com/v1/messages(スコープ内)

    const calls: unknown[] = [];
    const spyFetch = (async () => {
      calls.push(1);
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const result = await dispatchOutbox(dataRoot, spyFetch);
    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(calls).toHaveLength(1);

    const rows = readOutboxRows();
    expect(rows[0]?.status).toBe("sent");
  });

  test("失効: connection 削除後に dispatch すると failed「接続が失効」・fetch は呼ばれない", async () => {
    process.env[VAR] = sentinel;
    const { connectionId } = seedOutbox();

    // 接続を失効させる(人間が UI で削除した状況)。
    const store = CapabilityStore.openForKernel(dataRoot);
    try {
      store.deleteConnection(connectionId);
    } finally {
      store.close();
    }

    const calls: unknown[] = [];
    const spyFetch = (async () => {
      calls.push(1);
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const result = await dispatchOutbox(dataRoot, spyFetch);
    expect(result).toEqual({ sent: 0, failed: 1 });
    expect(calls).toHaveLength(0);

    const rows = readOutboxRows();
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.error).toBe("接続が失効しています");
    assertNoSentinelOnDisk();
  });
});
