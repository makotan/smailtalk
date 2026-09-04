/**
 * 受信 HTTP ルート `POST /inbound/:endpoint_id` の統合テスト(V2-M5-T02 / ADR-0041 §3 限定表)。
 *
 * **本物の SQLite** を使い、署名検証が**書込直前・実行層**で止まって**1バイトも書かない**ことを
 * 迂回テスト(DB の行数を直接検査)で実証する。あわせて 1行 create 限定・event_id 冪等・
 * フィールド制約検証・system actor・rate-limit を固定する。
 *
 * - (a) 正しい署名 → target_table に1行 create
 * - (b) 署名不一致 → 書かず遮断(DB 行が増えない = 実行層で止まる)
 * - (c) 鍵未登録 → 書かず遮断
 * - (d) 重複 event_id → 2件目が unique で弾かれ1行のみ(冪等吸収)
 * - (e) フィールド制約違反 payload → 書かず 400
 * - (f) update/delete を受信経路から起こせない(create 固定・system 列を書けない)
 * - (g) rate-limit 超過 → 429(署名前に効く)
 * - (h) `_auth_activity` に system actor が付く
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboundStore } from "../kernel/inbound-store.ts";
import {
  appDbPath,
  applyManifest,
  createApp,
  KernelMetaStore,
  type Manifest,
} from "../kernel/index.ts";
import { createServerApp } from "./app.ts";

const APP_ID = "ec";
const SIGNING_KEY = "test-inbound-signing-key-xyz";
const KEY_ENV_VAR = "ST_TEST_INBOUND_KEY";

/*
 * =====================================================================================
 * **【`V8-M26`。この題材はここで作り直された。理由を隠さずに書く】**
 * =====================================================================================
 *
 * **`V8-M26` が面(役割に束ねた権限)の既定を「閉じる」側へ倒した**(ユーザ決定 `D-V8-45` /
 * `D-V8-58` / `D-V8-65`)—— **規則を1本も名指ししていない表への書込は拒否される。**
 *
 * **受信の主体(`system:inbound`)は認証アカウントではないので実効ロール集合が空であり、
 * 面はこれを未ログイン(`anonymous`)として評価する。****`anonymous` の規則に `write` は
 * 書けない**(`schemas/manifest.schema.json` が `can` を `["read"]` に閉じている。実測で
 * `applyManifest` が `"write" は許可されていません` を返す)。
 * **したがって「面の側から受信を通す」道は今日1本も無い。**
 *
 * **残った唯一の道が、`src/server/inbound-route.ts` の 403 の hint がそのまま書いている
 * 手当てである** —— 逐語: **「参加者の表に "system:inbound" の行を1件作ると、この受信口は
 * 今までどおり書き込めます」。****本題材はその手当てを実際に施したものである** ——
 * **`payment_events` に行ごとのアクセス権(点)を宣言し、参加者の表に `system:inbound` を
 * 1行入れる。** **点が管轄内で書込を許すので、`combineRoleAndGrantAccess` の `OR` が
 * 面の拒否を上書きする。**
 *
 * **【`V8-M26` で失われたものを、丸めずに書く】** **`V8-M26` より前、この題材は
 * `payment_events` 1表だけで 201 を得ていた。****今日は、行ごとのアクセス権を宣言して
 * いない表を書込先にした受信口は、署名が正しくても 403 で1バイトも書けない。**
 * **これは検査の都合ではなく、実アプリでもそうである**(差分で作ったアプリの自動付与は
 * `owner` / `editor` / `viewer` にしか規則を配らない)。
 *
 * =====================================================================================
 * **【`D-V8-67` により作り直した(2026-08-10)。上の節は1バイトも消していない】**
 * =====================================================================================
 *
 * **ユーザ決定 `D-V8-67` の見出しの逐語: 「受信口は「持ち主が書いている」として扱う」。**
 * **受信の主体は今日、面から見て **持ち主(`owner`)** である** —— **上の節の逐語
 * 「『面の側から受信を通す』道は今日1本も無い」は今日は偽である。**
 *
 * **点(行ごとのアクセス権)の足場 —— `payment_events` の `access_control` 宣言と、
 * `payment_member` / `payment_grant` の2表と `seedInboundMember()` —— は撤去した。**
 * **代わりに `app.roles` の持ち主に `payment_events` の書込を1本だけ配る。**
 * **本ファイルが測っているのは署名検証・冪等・rate-limit であり、権限の足場は
 * 少ないほうが測っているものが濁らない。**
 */

/** 受信テーブル(モック PSP の Webhook payload と同形。event_id に unique = 冪等キー)。 */
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
            { id: "order_id", name: "注文ID", type: "text" },
            { id: "amount", name: "金額", type: "number" },
            { id: "currency", name: "通貨", type: "text" },
            { id: "status", name: "状態", type: "text" },
          ],
          // **【`V8-M26`】ここに `access_control`(点)の宣言を、`payment_member` /
          // `payment_grant` の2表とともに足していた。**
          // **【`D-V8-67` により撤去した】**(上の節)。
        },
      ],
      views: [],
      // **【`D-V8-67`】受信を通す道はこの1本である** —— **持ち主に `payment_events` の
      // 書込を配る。** **署名検証・冪等・rate-limit の測定を1ミリも変えない。**
      // **`editor` / `viewer` に規則を1本も配っていない** —— **本ファイルは使わない。**
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(類型17 の拡張)。
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

/*
 * **【`V8-M26`】ここに `seedInboundMember()`(参加者の表に `system:inbound` を1行入れる)を
 * 置いていた。** **【`D-V8-67` により撤去した】** —— **参加者の表そのものが無くなった。**
 */

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
let endpointId: string;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-inbound-route-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "参照EC", { app_id: APP_ID });
  } finally {
    store.close();
  }
  const applied = applyManifest(dataRoot, APP_ID, inboundManifest());
  expect(applied.valid).toBe(true);

  // 鍵は環境変数で渡す(secret-resolver の env source。鍵本体はストアに保存しない)。
  process.env[KEY_ENV_VAR] = SIGNING_KEY;

  // 人間 owner が inbound endpoint を発行する(T01 の InboundStore。テストからは発行を直接呼ぶ)。
  const inbound = InboundStore.openForKernel(dataRoot);
  try {
    endpointId = inbound.issueInboundEndpoint({
      appId: APP_ID,
      name: "mock-psp",
      secretSource: { kind: "env", value: KEY_ENV_VAR },
      targetTable: "payment_events",
    }).id;
  } finally {
    inbound.close();
  }

  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  delete process.env[KEY_ENV_VAR];
  await rm(dataRoot, { recursive: true, force: true });
});

/** 生バイト body(署名対象)を作る(パース→再シリアライズしない一定の文字列)。 */
function webhookBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event_id: "evt_1",
    event_type: "charge.succeeded",
    order_id: "order_1",
    amount: 12345,
    currency: "JPY",
    status: "paid",
    ...overrides,
  });
}

/** 署名ヘッダを作る(モック PSP と同じ HMAC-SHA256(生バイト, 鍵))。 */
function signatureFor(rawBody: string, key: string = SIGNING_KEY): string {
  return `sha256=${createHmac("sha256", key).update(Buffer.from(rawBody, "utf-8")).digest("hex")}`;
}

/** 受信口へ POST する。`sign=true` なら正しい署名を付ける。`signature` で明示指定も可。 */
async function postInbound(
  rawBody: string,
  opts: {
    endpoint?: string;
    signature?: string | null;
    extraHeaders?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...opts.extraHeaders,
  };
  const sig = opts.signature === undefined ? signatureFor(rawBody) : opts.signature;
  if (sig !== null) {
    headers["X-Mock-PSP-Signature"] = sig;
  }
  return app.request(
    new Request(`http://localhost/inbound/${opts.endpoint ?? endpointId}`, {
      method: "POST",
      headers,
      body: rawBody,
    }),
  );
}

/** payment_events の行数を **本物の SQLite を直接開いて**数える(迂回テスト。HTTP を通さない)。 */
function paymentRowCount(): number {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readonly: true });
  try {
    const row = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "payment_events"`).get();
    return row?.n ?? 0;
  } finally {
    db.close();
  }
}

// --- (a) 正しい署名 → 1行 create ------------------------------------------------

test("(a) 正しい署名 → target_table に1行 create される", async () => {
  const body = webhookBody();
  const res = await postInbound(body);
  expect(res.status).toBe(201);
  const json = (await res.json()) as { record: { event_id: string; amount: number } };
  expect(json.record.event_id).toBe("evt_1");
  expect(json.record.amount).toBe(12345);
  expect(paymentRowCount()).toBe(1);
});

// --- (b) 署名不一致 → 書かず遮断(実行層で止まる。迂回テスト)------------------------

test("(b) 署名不一致 → 401 で遮断し、DB に1バイトも書かない(実行層で止まる)", async () => {
  const body = webhookBody();
  // 正しい body の署名を、改竄した body に付けて送る(HMAC 不一致)。
  const tampered = webhookBody({ amount: 99999 });
  const res = await postInbound(tampered, { signature: signatureFor(body) });
  expect(res.status).toBe(401);
  // **書込先テーブルに行が増えていない**(バリデーション層でなく署名検証=実行層で止まった)。
  expect(paymentRowCount()).toBe(0);
});

test("(b') 署名ヘッダ欠落 → 401 で遮断し、書込ゼロ", async () => {
  const res = await postInbound(webhookBody(), { signature: null });
  expect(res.status).toBe(401);
  expect(paymentRowCount()).toBe(0);
});

test("(b'') 誤鍵で作った署名 → 401 で遮断し、書込ゼロ", async () => {
  const body = webhookBody();
  const res = await postInbound(body, { signature: signatureFor(body, "wrong-key") });
  expect(res.status).toBe(401);
  expect(paymentRowCount()).toBe(0);
});

test("エラーレスポンスに署名検証鍵が平文で現れない", async () => {
  const res = await postInbound(webhookBody(), { signature: "sha256=deadbeef" });
  expect(res.status).toBe(401);
  const text = await res.text();
  expect(text).not.toContain(SIGNING_KEY);
});

// --- (c) 鍵未登録 → 書かず遮断 --------------------------------------------------

test("(c) 鍵が解決できない(env 未設定)→ 401 で遮断し、書込ゼロ", async () => {
  // 環境変数を未設定の値に向けた endpoint を別途発行する。
  const inbound = InboundStore.openForKernel(dataRoot);
  let noKeyEndpointId: string;
  try {
    noKeyEndpointId = inbound.issueInboundEndpoint({
      appId: APP_ID,
      name: "no-key",
      secretSource: { kind: "env", value: "ST_TEST_UNSET_KEY_VAR" },
      targetTable: "payment_events",
    }).id;
  } finally {
    inbound.close();
  }
  const body = webhookBody();
  const res = await postInbound(body, { endpoint: noKeyEndpointId, signature: signatureFor(body) });
  expect(res.status).toBe(401);
  expect(paymentRowCount()).toBe(0);
});

// --- endpoint 不在 → 404・書込しない ---------------------------------------------

test("存在しない endpoint_id → 404、書込ゼロ", async () => {
  const res = await postInbound(webhookBody(), { endpoint: "does-not-exist" });
  expect(res.status).toBe(404);
  expect(paymentRowCount()).toBe(0);
});

// --- (d) 重複 event_id → 2件目が unique で弾かれ1行のみ ---------------------------

test("(d) 重複 event_id → 2件目は冪等吸収(200)され、行は1つだけ", async () => {
  const body = webhookBody();
  const first = await postInbound(body);
  expect(first.status).toBe(201);
  expect(paymentRowCount()).toBe(1);

  // 同じ event_id の Webhook が再到達(結果整合の重複)。unique で弾かれ二重書込しない。
  const second = await postInbound(body);
  expect(second.status).toBe(200);
  const json = (await second.json()) as { idempotent?: boolean };
  expect(json.idempotent).toBe(true);
  expect(paymentRowCount()).toBe(1);
});

// --- (e) フィールド制約違反 payload → 書かず記録 ----------------------------------

test("(e) 型違反 payload(amount が文字列)→ 400 で書かない", async () => {
  const body = webhookBody({ amount: "not-a-number" });
  const res = await postInbound(body);
  expect(res.status).toBe(400);
  expect(paymentRowCount()).toBe(0);
});

test("(e') 書込先テーブルに無いフィールドを含む payload → 400 で書かない", async () => {
  const body = webhookBody({ unexpected_field: "x" });
  const res = await postInbound(body);
  expect(res.status).toBe(400);
  expect(paymentRowCount()).toBe(0);
});

// --- (f) update/delete を受信経路から起こせない ----------------------------------

test("(f) payload に _id(システム列)を混ぜても create 固定で既存行を更新できない", async () => {
  // まず1行 create する。
  const created = await postInbound(webhookBody());
  expect(created.status).toBe(201);
  const createdId = ((await created.json()) as { record: { _id: string } }).record._id;

  // その _id を狙って別 event_id の payload に _id を混ぜ、更新を試みる。
  // _id はシステム列なので createRecord が拒否する(update 経路自体が受信ルートに無い)。
  const attack = webhookBody({ event_id: "evt_2", amount: 1, _id: createdId });
  const res = await postInbound(attack);
  expect(res.status).toBe(400);

  // 既存行は書き換わっていない(amount は元のまま)。行数も1のまま。
  const db = new Database(appDbPath(dataRoot, APP_ID), { readonly: true });
  try {
    const row = db
      .query<{ amount: number }, [string]>(`SELECT "amount" FROM "payment_events" WHERE "_id" = ?`)
      .get(createdId);
    expect(row?.amount).toBe(12345);
    const count = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "payment_events"`).get();
    expect(count?.n).toBe(1);
  } finally {
    db.close();
  }
});

// --- (g) rate-limit 超過 → 429(署名前に効く)------------------------------------

test("(g) rate-limit 超過 → 429(署名検証の前に効く)", async () => {
  // 受信口の rate-limit を limit=1 に絞ったサーバを立てる。
  const limited = createServerApp({
    dataRoot,
    rateLimit: { inbound: { limit: 1, windowMs: 60_000 } },
  });
  const body = webhookBody();
  const sig = signatureFor(body);
  const req = () =>
    limited.request(
      new Request(`http://localhost/inbound/${endpointId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Mock-PSP-Signature": sig },
        body,
      }),
    );
  const first = await req();
  expect(first.status).toBe(201);
  // 2回目は署名が正しくても rate-limit(署名前)で 429。
  const second = await req();
  expect(second.status).toBe(429);
});

test("(g') rate-limit は署名検証の前に効く(不正署名でも 429 になりうる = 署名前の門)", async () => {
  const limited = createServerApp({
    dataRoot,
    rateLimit: { inbound: { limit: 1, windowMs: 60_000 } },
  });
  const body = webhookBody();
  const badReq = () =>
    limited.request(
      new Request(`http://localhost/inbound/${endpointId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Mock-PSP-Signature": "sha256=bad" },
        body,
      }),
    );
  // 1回目は不正署名で 401(rate-limit は通る)。
  expect((await badReq()).status).toBe(401);
  // 2回目は rate-limit で 429(署名検証まで到達しない = 署名前に効く)。
  expect((await badReq()).status).toBe(429);
});

// --- (h) system actor が `_auth_activity` に付く ---------------------------------

test("(h) 受信起因の書込は system actor(system:inbound)で `_auth_activity` に記録される", async () => {
  const res = await postInbound(webhookBody());
  expect(res.status).toBe(201);

  const db = new Database(appDbPath(dataRoot, APP_ID), { readonly: true });
  try {
    const rows = db
      .query<{ user_id: string; username: string; action: string; table_id: string }, []>(
        `SELECT "user_id", "username", "action", "table_id" FROM "_auth_activity"`,
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe("system:inbound");
    expect(rows[0]?.username).toBe("system:inbound");
    expect(rows[0]?.action).toBe("create_record");
    expect(rows[0]?.table_id).toBe("payment_events");
  } finally {
    db.close();
  }
});

// --- V3-M13-T03(入口5): アクション失敗で受信 1行 create が巻き戻る(ADR-0066)----------
//
// `ADR-0066` §2 の入口表の5行目「**受信 capability(Webhook)| deferred tx
// (`inbound-route.ts:124`)| 巻き戻る**」を、**受信口を実際に叩いて**固定する。
//
// **`src/server/inbound-route.ts` に1バイトも足していない**(ADR-0066 限定1: 器は
// カーネルの `src/kernel/records.ts` にだけ置く)。ここで効くのは `createRecord` の内側の
// 器であり、受信ルート側の deferred tx は今日と同じ1つのままである。
//
// **限定9 は破らない** —— 本節は `collectWorkflowHistoryFailures` を受信ルートへ足す
// (= 既存の非対称を埋める)ことを1バイトも行わない。固定するのは巻き戻りだけである。

/** 受信テーブルの `on_create` が必ず失敗するワークフローを足したマニフェストを当て直す。 */
function installFailingWorkflow(): void {
  const base = inboundManifest();
  base.app.tables.push(
    {
      id: "strict",
      name: "必須つきテーブル",
      // `must` が required なので、値を与えない書き込みは**必ず失敗する**。
      fields: [
        { id: "must", name: "必須", type: "text", required: true },
        { id: "note", name: "メモ", type: "text" },
      ],
    },
    {
      id: "wf-runs",
      name: "実行履歴",
      fields: [
        { id: "ran_at", name: "実行時刻", type: "date" },
        { id: "workflow", name: "ワークフロー", type: "text" },
        { id: "trigger_type", name: "きっかけ", type: "text" },
        { id: "status", name: "結果", type: "text" },
        { id: "error", name: "エラー", type: "long_text" },
      ],
    },
  );
  base.app.workflows = [
    {
      id: "fails-on-create",
      name: "受信のたびに必ず失敗する",
      trigger: { type: "on_create", table: "payment_events" },
      actions: [{ action: "create_record", table: "strict", values: { note: "x" } }],
      history_table: "wf-runs",
    },
  ];
  const applied = applyManifest(dataRoot, APP_ID, base);
  expect(applied.valid).toBe(true);
}

/** 任意テーブルの行数を **本物の SQLite を直接開いて**数える。 */
function rowCountOf(tableId: string): number {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readonly: true });
  try {
    const row = db
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${JSON.stringify(tableId)}`)
      .get();
    return row?.n ?? 0;
  } finally {
    db.close();
  }
}

test("V3-M13-T03(入口5): 署名は通るのにワークフローのアクションが失敗すると、受信行が1行も残らない", async () => {
  installFailingWorkflow();

  const res = await postInbound(webhookBody());

  // **500 ではない**(ADR-0066 限定4: 例外を呼び出し元へ伝播させない)。
  // **新しい HTTP ステータスも作っていない**(限定12)—— 既存の 400 経路である。
  expect(res.status).toBe(400);
  const body = (await res.json()) as { errors: { path: string; message: string }[] };
  expect(body.errors).toHaveLength(1);
  expect(body.errors[0]?.path).toBe("");
  expect(String(body.errors[0]?.message)).toContain("ワークフローのアクションが失敗した");

  // **書込先テーブルに行が増えていない**(器が巻き戻した)。
  expect(paymentRowCount()).toBe(0);
  expect(rowCountOf("strict")).toBe(0);
  // 【V3-M13-T04 による期待値の更新】**失敗の履歴は残る**(ADR-0066 限定5)——
  // 受信 capability の外側 tx も `ok:false` を return する(throw しない)ので commit する。
  expect(rowCountOf("wf-runs")).toBe(1);
  // 監査も1行も残らない(ADR-0066 §限界3。本タスクはこれを解いていない)。
  const db = new Database(appDbPath(dataRoot, APP_ID), { readonly: true });
  try {
    const row = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "_auth_activity"`).get();
    expect(row?.n ?? 0).toBe(0);
  } finally {
    db.close();
  }
});

test("V3-M13-T03(入口5): アクションが成功する受信は、今日どおり 201 で1行書かれる", async () => {
  // **巻き戻りが「常に失敗する」に化けていないこと**を対で固定する(片側だけ見ない)。
  const base = inboundManifest();
  base.app.tables.push({
    id: "wf-runs",
    name: "実行履歴",
    fields: [
      { id: "ran_at", name: "実行時刻", type: "date" },
      { id: "workflow", name: "ワークフロー", type: "text" },
      { id: "trigger_type", name: "きっかけ", type: "text" },
      { id: "status", name: "結果", type: "text" },
      { id: "error", name: "エラー", type: "long_text" },
    ],
  });
  base.app.tables.push({
    id: "audit_log",
    name: "控え",
    fields: [{ id: "note", name: "メモ", type: "text" }],
  });
  base.app.workflows = [
    {
      id: "succeeds-on-create",
      name: "受信のたびに控えを作る",
      trigger: { type: "on_create", table: "payment_events" },
      actions: [
        { action: "create_record", table: "audit_log", values: { note: "$record.status" } },
      ],
      history_table: "wf-runs",
    },
  ];
  expect(applyManifest(dataRoot, APP_ID, base).valid).toBe(true);

  const res = await postInbound(webhookBody());

  /*
   * **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-58` / `D-V8-65`。期待値を反転させた】**
   *
   * **旧(逐語。1バイトも書き換えずにここへ写す)**:
   *   **`expect(res.status).toBe(201);`**
   *   **`expect(paymentRowCount()).toBe(1);`**
   *   **`expect(rowCountOf("audit_log")).toBe(1);`**
   *   **`expect(rowCountOf("wf-runs")).toBe(1);`**
   *
   * **なぜ反転したか(実測)**: **受信起因の発火では、ワークフローの書き手を特定できない**
   * (`src/kernel/workflow-runner.ts` の `judgeAutomationWrite` が `actorId === null` を
   * 「この発火では書き手を特定できません」として面へ渡す)。**面はそれを未ログイン
   * (`anonymous`)として評価し、`V8-M26` 以後は規則を1本も持たない表を拒否する。**
   * **`anonymous` に `write` の規則は書けない**(schema が `can` を `["read"]` に閉じている)し、
   * **点(行ごとのアクセス権)も `actorId === null` を必ず `no_member` に倒す**
   * (`creatorGrantPlan`)。**したがって `audit_log` を通す道は今日1本も無い。**
   *
   * **【この反転で失われたもの。丸めない】** **本検査の主題は冒頭のコメントの逐語
   * 「巻き戻りが『常に失敗する』に化けていないこと」を対で固定することだった。**
   * **今日はその対が作れない** —— **受信起因のワークフローが表へ1行でも書こうとすると、
   * 宛先の表が何であれ必ず失敗するからである。** **直前の検査(必ず失敗するワークフロー)と
   * 本検査は、今日は同じ 400 に落ちる。** **【禁止】「対で固定できている」と書かない。**
   * **残して測れるのは「巻き戻りが起きること」と「履歴だけは残ること」までである。**
   *
   * =========================================================================
   * **【`D-V8-67` により再び戻した(2026-08-10)。上の反転の記述は1バイトも消していない】**
   * =========================================================================
   *
   * **反転していたときの期待値(逐語)**:
   * ```
   * expect(res.status).toBe(400);
   * const body = (await res.json()) as { errors: { message: string }[] };
   * expect(String(body.errors[0]?.message)).toContain("ワークフローのアクションが失敗した");
   * expect(String(body.errors[0]?.message)).toContain("止めた層: role");
   * expect(paymentRowCount()).toBe(0);
   * expect(rowCountOf("audit_log")).toBe(0);
   * ```
   *
   * **【正直に書く。何が戻したのかを取り違えないこと】** —— **`D-V8-67` が変えたのは
   * 「受信口が表へ1行入れるとき」の主体だけである。** **その書込をきっかけに動く
   * ワークフローの書き手は、今日も `act_as` を書かなければ解決できない**
   * (`scripts/mock-psp/payment-flow-e2e.test.ts` の `wf-payment-received` は、
   * まさにその1行を足して直した)。**本検査の `audit_log` が今日通っているのは、
   * 宛先の表が面の管轄外だからであって、書き手が解決できるようになったからではない。**
   * **【禁止】「受信起因のワークフローの書き手が解決できるようになった」と書かない。**
   */
  expect(res.status).toBe(201);
  expect(paymentRowCount()).toBe(1);
  expect(rowCountOf("audit_log")).toBe(1);
  expect(rowCountOf("wf-runs")).toBe(1);
});
