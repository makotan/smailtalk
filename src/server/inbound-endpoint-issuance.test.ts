/**
 * **受信口を人が発行できる口**(`V8-M41` 後半 / 台帳 `F-G14` / `ADR-0332`)。
 *
 * ## 何を塞いだのか(**着手前の実測。`v8-m33.md` §1-A の `A-8`**)
 *
 * **逐語**: 「**HTTP にも MCP にも発行の口が1本も無い。`request_inbound_endpoint` は申請まで**」/
 * 迂回欄 逐語「**scratchpad の bun スクリプトから `InboundStore.issueInboundEndpoint` を直に
 * 叩いた。リポジトリに1バイトも置いていない**」。
 *
 * **`src/kernel/inbound-store.ts:359`-`:362` のコメントは、着手前まで空約束だった** ——
 * 逐語「**発行は owner の HTTP 操作だけが呼ぶ(本 T01 ではどのルートにも結線しない =
 * テストからのみ呼ぶ)。**」 **その「owner の HTTP 操作」が、今日1本立った。**
 *
 * ## この検査が測るもの
 *
 * - **(1) 発行 → 受信の2本続き** —— **発行の応答だけでは足りない**(`A-8` が測ったのは
 *   「発行できない」であって「発行の口がある」ではない)。**返った `endpoint_id` で
 *   `POST /inbound/<endpoint_id>` が実際に1行書けるところまで測る。**
 * - **(2) 関門** —— **`requireOwner`**(`ADR-0332` 限定2)。**editor 403 / viewer 403 /
 *   未認証 401 / アプリ不在 404。**
 * - **(3) 応答が何を返し、何を返さないか** —— **署名検証鍵の本体はどこにも現れない**
 *   (そもそも保管していない。`ADR-0041` 限定4)。
 * - **(4) 口は1本ちょうど** —— **再発行・失効・一覧の口を1本も作っていない**
 *   (`ADR-0332` 限定3)。**同じパスの `GET` / `DELETE` / `PATCH` は 404 である。**
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboundStore } from "../kernel/inbound-store.ts";
import type { Manifest } from "../kernel/index.ts";
import { appDbPath, applyManifest, createApp, KernelMetaStore } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN } from "./test-helpers.ts";

const APP_ID = "ec";
const SIGNING_KEY = "test-issuance-signing-key-xyz";
const KEY_ENV_VAR = "ST_TEST_ISSUANCE_KEY";
const ISSUE_PATH = `/api/apps/${APP_ID}/inbound-endpoints`;

/**
 * 受信テーブル1本(`src/server/inbound-route.test.ts` の題材の最小形)。
 * **持ち主に `payment_events` の書込を1本だけ配る**(`D-V8-67`。受信は持ち主として書く)。
 */
function inboundManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "参照EC",
      tables: [
        {
          id: "payment_events",
          name: "決済イベント",
          fields: [
            { id: "event_id", name: "イベントID", type: "text", required: true, unique: true },
            { id: "event_type", name: "種類", type: "text", required: true },
            { id: "amount", name: "金額", type: "number" },
          ],
        },
      ],
      views: [],
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            { target: "table", table: "payment_events", can: ["read", "write"] },
          ],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-inbound-issuance-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "参照EC", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, inboundManifest()).valid).toBe(true);
  process.env[KEY_ENV_VAR] = SIGNING_KEY;
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  delete process.env[KEY_ENV_VAR];
  await rm(dataRoot, { recursive: true, force: true });
});

/** cookie + origin 付きリクエスト(`capability-issuance.test.ts` の `req` と同形)。 */
function req(
  cookie: string | undefined,
  method: string,
  path: string,
  body?: unknown,
  origin: string = TEST_ORIGIN,
): Promise<Response> {
  const headers: Record<string, string> = { origin };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return Promise.resolve(app.request(new Request(`http://localhost${path}`, init)));
}

/** 発行の body(最小形)。 */
function issueBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "mock-psp",
    targetTable: "payment_events",
    secretSource: { kind: "env", value: KEY_ENV_VAR },
    ...overrides,
  };
}

/** kernel.sqlite の発行済み受信口を**直接**読む(HTTP を通さない迂回検査)。 */
function listEndpoints() {
  const store = InboundStore.openForKernel(dataRoot);
  try {
    return store.listInboundEndpoints(APP_ID);
  } finally {
    store.close();
  }
}

/** 署名ヘッダ(モック PSP と同じ HMAC-SHA256(生バイト, 鍵))。 */
function signatureFor(rawBody: string, key: string = SIGNING_KEY): string {
  return `sha256=${createHmac("sha256", key).update(Buffer.from(rawBody, "utf-8")).digest("hex")}`;
}

/** `payment_events` の行数を本物の SQLite から数える。 */
function paymentRowCount(): number {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readonly: true });
  try {
    return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "payment_events"`).get()?.n ?? 0;
  } finally {
    db.close();
  }
}

type IssuedBody = {
  endpoint: {
    id: string;
    name: string;
    targetTable: string;
    secretSource: { kind: string; value: string };
    createdAt: string;
    signatureHeader: string;
    signatureFormat: string;
  };
};

// --- (1) 本丸: 発行 → 受信の2本続き ----------------------------------------------

test("(1) owner が発行した受信口で、実際に `POST /inbound/<id>` が受け取れる(2本続き)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });

  // === 1本目: 発行 ===
  const issued = await req(owner.cookie, "POST", ISSUE_PATH, issueBody());
  expect(issued.status).toBe(200);
  const body = (await issued.json()) as IssuedBody;
  expect(body.endpoint.name).toBe("mock-psp");
  expect(body.endpoint.targetTable).toBe("payment_events");
  // **取得元の参照であって鍵の値ではない**(`ADR-0041` 限定4 / `ADR-0020` §2d の対称)。
  expect(body.endpoint.secretSource).toEqual({ kind: "env", value: KEY_ENV_VAR });
  expect(body.endpoint.signatureHeader).toBe("X-Mock-PSP-Signature");
  expect(body.endpoint.signatureFormat).toBe("sha256_hex");
  expect(body.endpoint.id).toMatch(/^[0-9a-f-]{36}$/);
  // **`appId` は URL で確定しているので返さない**(`connectionView` と同じ作法)。
  expect(Object.keys(body.endpoint).sort()).toEqual([
    "createdAt",
    "id",
    "name",
    "secretSource",
    "signatureFormat",
    "signatureHeader",
    "targetTable",
  ]);

  // === 2本目: その id で受信できる ===
  const raw = JSON.stringify({ event_id: "evt_1", event_type: "charge.succeeded", amount: 12345 });
  const received = await app.request(
    new Request(`http://localhost/inbound/${body.endpoint.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Mock-PSP-Signature": signatureFor(raw),
      },
      body: raw,
    }),
  );
  expect(received.status).toBe(201);
  expect(paymentRowCount()).toBe(1);
});

// --- (2) 鍵の本体は応答のどこにも現れない ------------------------------------------

test("(2) 応答の生テキストに署名検証鍵の本体が1バイトも現れない", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const issued = await req(owner.cookie, "POST", ISSUE_PATH, issueBody());
  expect(issued.status).toBe(200);
  const text = await issued.text();
  // 環境変数「名」は返るが、その「値」(鍵の本体)は返らない。
  expect(text).toContain(KEY_ENV_VAR);
  expect(text).not.toContain(SIGNING_KEY);
});

// --- (3) 関門 = requireOwner ------------------------------------------------------

test("(3) 発行は owner のみ: editor 403 / viewer 403 / 未認証 401、いずれも1件も発行しない", async () => {
  const editor = seedSession(dataRoot, APP_ID, { role: "editor" });
  const viewer = seedSession(dataRoot, APP_ID, { role: "viewer" });

  const denied = await req(editor.cookie, "POST", ISSUE_PATH, issueBody());
  expect(denied.status).toBe(403);
  // **止めているのは `requireOwner` である**(文面が `owner` を名指ししたままであることで見る)。
  const deniedBody = (await denied.json()) as { errors?: { allowed_values?: string[] }[] };
  expect(deniedBody.errors?.[0]?.allowed_values).toEqual(["owner"]);

  expect((await req(viewer.cookie, "POST", ISSUE_PATH, issueBody())).status).toBe(403);
  expect((await req(undefined, "POST", ISSUE_PATH, issueBody())).status).toBe(401);

  expect(listEndpoints()).toHaveLength(0);
});

test("(3-2) 実在しないアプリは 404(発行の前にアプリの実在で分かれる)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const res = await req(
    owner.cookie,
    "POST",
    "/api/apps/no-such-app/inbound-endpoints",
    issueBody(),
  );
  expect(res.status).toBe(404);
});

// --- (4) 入力の検証 ---------------------------------------------------------------

test("(4) 不正な body は 400 で、1件も発行しない", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });

  const noName = await req(owner.cookie, "POST", ISSUE_PATH, issueBody({ name: "" }));
  expect(noName.status).toBe(400);
  const noNameBody = (await noName.json()) as { errors: { path: string }[] };
  expect(noNameBody.errors.map((e) => e.path)).toContain("/name");

  const noTarget = await req(owner.cookie, "POST", ISSUE_PATH, issueBody({ targetTable: 1 }));
  expect(noTarget.status).toBe(400);
  expect(
    ((await noTarget.json()) as { errors: { path: string }[] }).errors.map((e) => e.path),
  ).toContain("/targetTable");

  const badSource = await req(
    owner.cookie,
    "POST",
    ISSUE_PATH,
    issueBody({ secretSource: { kind: "file", value: "/etc/x" } }),
  );
  expect(badSource.status).toBe(400);

  expect(listEndpoints()).toHaveLength(0);
});

test("(4-2) 署名の形は指定できるが、値域の外は 400 で1バイトも書かない(`ADR-0160` 限定2 / 限定4)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });

  const ok = await req(
    owner.cookie,
    "POST",
    ISSUE_PATH,
    issueBody({ signatureHeader: "X-Hub-Signature-256", signatureFormat: "hex" }),
  );
  expect(ok.status).toBe(200);
  const okBody = (await ok.json()) as IssuedBody;
  expect(okBody.endpoint.signatureHeader).toBe("X-Hub-Signature-256");
  expect(okBody.endpoint.signatureFormat).toBe("hex");

  const bad = await req(
    owner.cookie,
    "POST",
    ISSUE_PATH,
    issueBody({ name: "other", signatureHeader: "X-Whatever" }),
  );
  expect(bad.status).toBe(400);
  expect(listEndpoints()).toHaveLength(1);
});

test("(4-3) 同名の2度目は 409(UNIQUE(app_id, name))", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  expect((await req(owner.cookie, "POST", ISSUE_PATH, issueBody())).status).toBe(200);
  const again = await req(owner.cookie, "POST", ISSUE_PATH, issueBody());
  expect(again.status).toBe(409);
  expect(listEndpoints()).toHaveLength(1);
});

// --- (5) 申請の締め(AI の申請 → owner の発行)-------------------------------------

test("(5) requestId を書くと、その申請が approved になる(書かなければ pending のまま)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const store = InboundStore.openForKernel(dataRoot);
  let requestId: string;
  try {
    requestId = store.requestInboundEndpoint({
      appId: APP_ID,
      requestedName: "mock-psp",
      purpose: "決済の通知を受け取る",
      suggestedTargetTable: "payment_events",
    }).id;
    expect(store.listPendingInboundEndpointRequests(APP_ID)).toHaveLength(1);
  } finally {
    store.close();
  }

  // requestId を書かずに発行する → 申請は pending のまま。
  expect((await req(owner.cookie, "POST", ISSUE_PATH, issueBody())).status).toBe(200);
  const mid = InboundStore.openForKernel(dataRoot);
  try {
    expect(mid.listPendingInboundEndpointRequests(APP_ID)).toHaveLength(1);
  } finally {
    mid.close();
  }

  // requestId を書いて発行する → その申請が approved になる。
  expect(
    (await req(owner.cookie, "POST", ISSUE_PATH, issueBody({ name: "psp-2", requestId }))).status,
  ).toBe(200);
  const after = InboundStore.openForKernel(dataRoot);
  try {
    expect(after.listPendingInboundEndpointRequests(APP_ID)).toHaveLength(0);
    expect(after.getInboundEndpointRequest(requestId)?.status).toBe("approved");
  } finally {
    after.close();
  }
});

// --- (6) 口は1本ちょうど(再発行・失効・一覧を作っていない)---------------------------

test("(6) 【`ADR-0332` 限定3】同じパスの GET / DELETE / PATCH は1本も無い(404)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const issued = await req(owner.cookie, "POST", ISSUE_PATH, issueBody());
  expect(issued.status).toBe(200);
  const id = ((await issued.json()) as IssuedBody).endpoint.id;

  for (const [method, path] of [
    ["GET", ISSUE_PATH],
    ["DELETE", `${ISSUE_PATH}/${id}`],
    ["PATCH", `${ISSUE_PATH}/${id}`],
    ["POST", `${ISSUE_PATH}/${id}/rotate`],
  ] as const) {
    const res = await req(owner.cookie, method, path, method === "POST" ? {} : undefined);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { errors: { message: string }[] };
    expect(body.errors[0]?.message).toContain("に対応するエンドポイントはありません");
  }

  // 発行済みの1件は消えていない(失効の口が無いので消せない)。
  expect(listEndpoints()).toHaveLength(1);
});

// --- (7) CSRF(Origin 検査。connections と同型)--------------------------------------

test("(7) 別 Origin からの発行は 403(connections / ai-capabilities と同じガード)", async () => {
  const owner = seedSession(dataRoot, APP_ID, { role: "owner" });
  const res = await req(owner.cookie, "POST", ISSUE_PATH, issueBody(), "http://evil.example.com");
  expect(res.status).toBe(403);
  expect(listEndpoints()).toHaveLength(0);
});
