/**
 * **壁が止めない経路の実測**(`V5-M28-T06`。`A-G1` /
 * [`ADR-0249`](../../docs/adr/0249-view-action-audience-write-wall.md) 限定13)。
 *
 * **実施記録**: [`docs/plan/v5/records/v5-m28.md`](../../docs/plan/v5/records/v5-m28.md) §6-2 `T06`。
 *
 * ## 本ファイルが測るもの(**穴が空いていることを固定する側である**)
 *
 * **`ADR-0249` §4-5 の穴1〜5 と、穴6(誰も通さない壁)を、推測ではなく実行で確かめる。**
 * **通ったこと・止まったことを応答コードと行数の変化で数える。**
 *
 * | 検査 | §4-5 の穴 | 測る経路 |
 * |---|---|---|
 * | `(G-1)` | 穴1 | 受信口(`POST /inbound/:endpoint_id`。本物の HMAC 署名) |
 * | `(G-2)` | 穴3 | ワークフローの `create_record`(`on_create` 発火) |
 * | `(G-3)` | 穴5 | `DELETE /api/apps/:app/tables/:table/records/:id` |
 * | `(G-4)` | §4-4 | `anonymous` だけに書いた規則(旧 `audience: ["anonymous"]`) |
 * | `(G-5)` | 穴6 | 誰も通さない壁を書いた差分の `applyDiff` |
 * | `(G-6)` | **穴4** | **コードの島**(`run_function` の `output_table` 全置換) |
 * | `(G-7)` | **`V8-M20` が開いた穴** | **識別子(`id`)の無い操作起点には壁が立たない** |
 *
 * ## **本ファイルが測っていないもの(先に書く)**
 *
 * - **MCP 経路(穴2)を1件も測っていない。** **測るのは `src/mcp/tools/write.test.ts` の
 *   `(G-M1)`〜`(G-M3)` である**(同じ壁を MCP の口から越える)。
 * - **`scripts/mcp-trial/` を1度も使っていない。**
 * - **ブラウザを1枚も開いていない。**
 * - **穴7(`update_view` で壁が動く)・穴8(バッチの TOCTOU)を1件も測っていない。**
 * - **`(G-4)` で総当たりしたログイン済みロールは `owner` / `editor` / `viewer` / `customer` の
 *   4つだけである** —— **`user_kinds` で宣言した種類を1つも測っていない。**
 *
 * ## **この検査は「壁が効いた証拠」ではない**
 *
 * **`(G-1)` `(G-2)` `(G-5)` `(G-6)` は着手前から緑である**(`ADR-0249` は
 * これらの経路のコードを1バイトも書き換えていない)。**緑であることは、穴が
 * 塞がっていないことの記録であって、何かが直ったことの記録ではない。**
 *
 * ## **追記(`V8-M20`。台帳 `J-G29`(判定 = 廃止)。手続きは `ADR-0301`)**
 *
 * **壁を立てる宣言が `view_action.audience` から面(`app.roles[].rules`)へ移った** ——
 * **題材の4本の壁は、操作起点に識別子(`id`)を書き、面の規則
 * `{ target: "action", view, action, can: ["read"] }` で名指しする形に置き直した。**
 * **壁の中 / 壁の外の顔ぶれも、6本の検査の期待値も1バイトも変えていない。**
 *
 * **【実測。穴は穴のまま残っている】** **`(G-1)` `(G-2)` `(G-3)` `(G-5)` `(G-6)` は
 * 置き直した後も同じ応答である** —— **面は受信口・ワークフロー・コードの島・`DELETE` を
 * 1つも止めない。** **`ADR-0249` §4-5 の穴1・穴3・穴4・穴5・穴6 は、今日も塞がっていない。**
 *
 * **【`V8-M20` が新しく開いた穴。`(G-7)` が固定する】** **面の規則は `(view, action)` で
 * 名指しするので、`view_action.id` を書いていない操作起点には壁が1本も立たない。**
 * **旧層は識別子が無くても効いていた**(`schemas/manifest.schema.json` の
 * `$defs/view_action.audience` の `$comment` の逐語:「**旧層は id が無くても効いていた。**」)。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Role } from "../auth/types.ts";
import { InboundStore } from "../kernel/inbound-store.ts";
import {
  appDbPath,
  applyDiff,
  applyManifest,
  createApp,
  type Diff,
  ensureIslandRuntimeReady,
  KernelMetaStore,
  type Manifest,
} from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "wall-gaps-shop";
const SIGNING_KEY = "test-wall-gaps-signing-key";
const KEY_ENV_VAR = "ST_TEST_WALL_GAPS_KEY";
/** 受信口の既定の署名ヘッダ(`src/kernel/inbound-verify.ts` の `INBOUND_SIGNATURE_HEADER`)。 */
const SIGNATURE_HEADER = "X-Mock-PSP-Signature";

beforeAll(async () => {
  // **島は同期発火なので、事前ロードしていないと `runIslandSync` が fail-closed する。**
  await ensureIslandRuntimeReady();
});

/** ワークフロー履歴テーブルの5列(規約どおり)。 */
function historyFields() {
  return [
    { id: "ran_at", name: "実行時刻", type: "date" as const },
    { id: "workflow", name: "ワークフロー", type: "text" as const },
    { id: "trigger_type", name: "きっかけ", type: "text" as const },
    { id: "status", name: "結果", type: "text" as const },
    { id: "error", name: "エラー", type: "long_text" as const },
  ];
}

/** 島の JS。`tick` の行をそのまま `island_out` の形へ写すだけ(集計もしない)。 */
const ISLAND_CODE = `(rows) => rows.map((r) => ({ label: r.label }))`;

/**
 * **壁が4本立つ題材。**
 *
 * | 表 | 種類 | 立てている宣言 | 壁の中 | 壁の外 |
 * |---|---|---|---|---|
 * | `inbound_event` | 作成 | `catalog-list` の遷移の形(`inbound-form`) | `editor` | `owner` |
 * | `wf_note` | 作成 | 同(`wf-note-form`) | `editor` | `owner` |
 * | `island_out` | 作成 | 同(`island-form`) | `editor` | `owner` |
 * | `guest_note` | 作成 | 同(`guest-form`) | **`anonymous` だけ** | **ログイン済み全員** |
 *
 * **`product` と `tick` には壁が1本も立っていない**(発火のきっかけを作る側なので、
 * 壁の外の相手でも今日どおり作れる必要がある)。
 *
 * **【`V8-M20` / `J-G29`】上の表の「立てている宣言」は、今日は面の規則である** ——
 * **操作起点に識別子(`id`)を書き、`app.roles[].rules` の `target: "action"` で名指しする。**
 * **旧: 各操作起点の `audience: ["editor"]` / `["anonymous"]`。**
 * **壁の中 / 壁の外の顔ぶれは1つも変えていない。**
 *
 * **`no-id-form` / `no_id_note` は `(G-7)`(`V8-M20` が開いた穴)のためだけに在る** ——
 * **操作起点に識別子を書いていないので、面から名指しできず、壁が1本も立たない。**
 */
function gapsManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "壁の穴の店",
      tables: [
        // **【`V8-M26`】`product` / `tick` に `st_owner` を1本ずつ足した。理由を実測で書く。**
        //
        // **`V8-M26` より前、この2表は `st_owner` を持っていなかった。**
        // **今日それだと `(G-2)` / `(G-6)` が `201` ではなく `400` になる** ——
        // **実測した本文の逐語**:
        //   「テーブル "wf_note" はアクセス権で守られていますが、この自動処理の書き手
        //    (**この発火では書き手を特定できません**)には作る権限がありません(止めた層: role。
        //    1バイトも書いていません)。」
        //
        // **理由**: **`workflow-runner.ts` の `judgeAutomationWrite` は
        // 「面も点も管轄外の表なら今日どおり通す」というオプトインの逃げ道を持っているが、
        // その逃げ道の条件が `roleGovernsTable(...) === false` である。**
        // **`V8-M26` が表の既定を閉じた結果、`governed` はどの表でも真になり、
        // この逃げ道が1度も通らなくなった。**
        // **そして書き手が特定できない自動処理は未ログイン(`anonymous`)として判定され、
        // `anonymous` には書込の規則を1本も書けない**(schema の `J-G11` の非対称)。
        //
        // **`st_owner` を足すと、`resolveWorkflowActor` がトリガー元レコードの持ち主を
        // 書き手に解けるようになり、その人の役割(`owner`)で判定が通る。**
        // **【これは今日できなくなったことの実物である】** ——
        // **「持ち主を辿れないきっかけ表」から発火する自動処理は、今日はどの表にも書けない。**
        {
          id: "product",
          name: "商品",
          fields: [
            { id: "name", name: "商品名", type: "text", required: true },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
        {
          id: "tick",
          name: "きっかけ",
          fields: [
            { id: "label", name: "札", type: "text" },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
        {
          id: "inbound_event",
          name: "受信イベント",
          fields: [
            { id: "product", name: "商品", type: "reference", reference_table: "product" },
            { id: "event_id", name: "イベントID", type: "text", unique: true },
            { id: "note", name: "覚書", type: "text" },
          ],
        },
        {
          id: "wf_note",
          name: "自動処理の控え",
          fields: [
            { id: "product", name: "商品", type: "reference", reference_table: "product" },
            { id: "note", name: "覚書", type: "text" },
          ],
        },
        {
          id: "island_out",
          name: "島の出力",
          fields: [
            { id: "product", name: "商品", type: "reference", reference_table: "product" },
            { id: "label", name: "札", type: "text" },
          ],
        },
        {
          id: "guest_note",
          name: "未ログインの控え",
          fields: [
            { id: "product", name: "商品", type: "reference", reference_table: "product" },
            { id: "body", name: "本文", type: "text" },
          ],
        },
        // **`(G-7)`(`V8-M20` が開いた穴)のためだけの表。** **壁が立たない。**
        {
          id: "no_id_note",
          name: "識別子なしの控え",
          fields: [
            { id: "product", name: "商品", type: "reference", reference_table: "product" },
            { id: "note", name: "覚書", type: "text" },
          ],
        },
        { id: "wf_runs", name: "実行履歴", fields: historyFields() },
      ],
      views: [
        {
          id: "catalog-list",
          type: "list_view",
          table: "product",
          columns: ["name"],
          // **【`V8-M20` / `J-G29`】旧は各操作起点に `audience` を書いていた。**
          // **新は識別子(`id`)を書き、下の `roles` から名指しする。**
          actions: [
            {
              id: "go-inbound",
              form: "inbound-form",
              prefill: { field: "product" },
              name: "受信の控えを作る",
            },
            {
              id: "go-wf-note",
              form: "wf-note-form",
              prefill: { field: "product" },
              name: "控えを作る",
            },
            {
              id: "go-island",
              form: "island-form",
              prefill: { field: "product" },
              name: "島の出力を作る",
            },
            {
              // **誰も通さない壁**(ログイン済みは誰も `anonymous` ではない。`ADR-0249` §4-4)。
              // **旧: `audience: ["anonymous"]`。新: 役割 `anonymous` だけが読める規則。**
              id: "go-guest",
              form: "guest-form",
              prefill: { field: "product" },
              name: "感想を書く",
            },
            {
              // **識別子(`id`)を書かない操作起点。** **面から名指しできない**(`(G-7)`)。
              form: "no-id-form",
              prefill: { field: "product" },
              name: "識別子なしで控えを作る",
            },
          ],
        },
        {
          id: "inbound-form",
          type: "form",
          table: "inbound_event",
          fields: ["product", "event_id", "note"],
        },
        { id: "wf-note-form", type: "form", table: "wf_note", fields: ["product", "note"] },
        { id: "island-form", type: "form", table: "island_out", fields: ["product", "label"] },
        { id: "guest-form", type: "form", table: "guest_note", fields: ["product", "body"] },
        { id: "no-id-form", type: "form", table: "no_id_note", fields: ["product", "note"] },
      ],
      // **面の規則。** **既定3本(`owner` / `editor` / `viewer`)は消せない。**
      // **`owner` / `viewer` には規則を1本も書かない** —— **allow-list なので壁の外になる。**
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
          rules: [
            { target: "action", view: "catalog-list", action: "go-inbound", can: ["read"] },
            { target: "action", view: "catalog-list", action: "go-wf-note", can: ["read"] },
            { target: "action", view: "catalog-list", action: "go-island", can: ["read"] },
          ],
        },
        { id: "viewer", name: "閲覧者" },
        {
          id: "anonymous",
          name: "未ログイン",
          rules: [{ target: "action", view: "catalog-list", action: "go-guest", can: ["read"] }],
        },
      ],
      functions: [
        {
          id: "tick-copy",
          name: "きっかけを写す島",
          code: ISLAND_CODE,
          input: { source: "table", table: "tick" },
          output: { fields: [{ id: "label", type: "text" }] },
          capabilities: [],
        },
      ],
      workflows: [
        {
          id: "wf-note-on-product",
          name: "商品ができたら控えを作る",
          trigger: { type: "on_create", table: "product" },
          actions: [
            { action: "create_record", table: "wf_note", values: { note: "自動処理が作った" } },
          ],
          history_table: "wf_runs",
        },
        {
          id: "wf-island-on-tick",
          name: "きっかけができたら島が書く",
          trigger: { type: "on_create", table: "tick" },
          actions: [{ action: "run_function", function: "tick-copy", output_table: "island_out" }],
          history_table: "wf_runs",
        },
      ],
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
let endpointId: string;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-wall-gaps-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "壁の穴の店", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **【`V8-M26`】表(8本)にだけ既定3役割の規則を足す**(`skipAllViews: true`)。
  // **画面とボタンの規則は題材が自分で書いており(4本の壁そのもの)、そこへ既定の規則を
  // 足すと壁が1本も立たなくなる。**
  expect(
    applyManifest(dataRoot, APP_ID, withDefaultRoleRules(gapsManifest(), { skipAllViews: true }))
      .valid,
  ).toBe(true);

  process.env[KEY_ENV_VAR] = SIGNING_KEY;
  const inbound = InboundStore.openForKernel(dataRoot);
  try {
    endpointId = inbound.issueInboundEndpoint({
      appId: APP_ID,
      name: "mock-psp",
      secretSource: { kind: "env", value: KEY_ENV_VAR },
      // **壁の立った表を、そのまま受信口の書込先にする。**
      targetTable: "inbound_event",
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

function req(
  cookie: string | undefined,
  method: string,
  path: string,
  body?: unknown,
  extra?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = { origin: TEST_ORIGIN, ...(extra ?? {}) };
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

function session(role: Role) {
  return seedSession(dataRoot, APP_ID, { role, username: `${role}-${Math.random()}` });
}

const RECORDS = (table: string) => `/api/apps/${APP_ID}/tables/${table}/records`;

/** **本物の SQLite を直接開いて**行数を数える(HTTP を1本も通さない)。 */
function rowCount(table: string): number {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readonly: true });
  try {
    return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "${table}"`).get()?.n ?? 0;
  } finally {
    db.close();
  }
}

/** 受信口へ投げる生バイト body。 */
function webhookBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ event_id: "evt_1", note: "外から届いた", ...overrides });
}

/** モック PSP と同じ HMAC-SHA256(生バイト, 鍵)。 */
function signatureFor(rawBody: string): string {
  return `sha256=${createHmac("sha256", SIGNING_KEY).update(Buffer.from(rawBody, "utf-8")).digest("hex")}`;
}

// ---------------------------------------------------------------------------
// (G-1) 穴1 —— 受信口(inbound)
// ---------------------------------------------------------------------------

test("(G-1) 壁の立った表に、受信口(inbound)経由の書込は今日どおり通る", async () => {
  // **壁の外の相手(`owner`)でも、壁の中の相手(`editor`)でもない** ——
  // **受信口には名乗る相手が居ない**(`ADR-0249` §4-5 の穴1)。
  expect(rowCount("inbound_event")).toBe(0);

  const body = webhookBody();
  const res = await app.request(
    new Request(`http://localhost/inbound/${endpointId}`, {
      method: "POST",
      headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signatureFor(body) },
      body,
    }),
  );

  // **実測: 201。** **署名が合っていれば、壁の立った表に1行書かれる。**
  //
  // **【`V8-M26` / ユーザ決定 `D-V8-45` / 台帳 `T-G26a`。期待値を2行とも反転させた。
  // 旧文を1バイトも消していない】**
  // **旧(逐語)**: `expect(res.status).toBe(201);` / `expect(rowCount("inbound_event")).toBe(1);`
  //
  // **今日は `403` であり、行は1件も増えない。** **`ADR-0249` §4-5 の穴1 は、
  // `V8-M26` が既定を閉じたことで(狙ってではなく副作用として)塞がった。**
  //
  // **止めている場所は `src/server/inbound-route.ts` の `inboundAccessDenied` である。**
  // **その逃げ道の条件は `sources === undefined && !role.governed` であり、
  // `V8-M26` が表の既定を閉じた結果 `governed` がどの表でも真になって、1度も通らなくなった。**
  // **受信の主体(`system:inbound`)は認証アカウントではないので実効ロール集合が空であり、
  // 未ログイン(`anonymous`)として判定される** —— **`anonymous` には書込の規則を
  // 1本も書けない**(schema の `J-G11` の非対称。動詞は `read` に絞られている)。
  //
  // **【この反転が意味すること。丸めない】** **今日、署名の正しい Webhook は
  // 「行ごとの付与(点)を宣言した表」以外には1行も書けない。**
  // **面の側から受信口を通す道は今日1本も無い。**
  // **`withDefaultRoleRules` で規則を足しても変わらない** —— **既定3役割に足しても、
  // 受信の主体はその3つのどれでもないからである**(実測で確かめた)。
  //
  // =========================================================================
  // **【`D-V8-67` により再び戻した(2026-08-10)。上の反転の記述は1バイトも消していない】**
  // =========================================================================
  //
  // **ユーザ決定 `D-V8-67` の見出しの逐語: 「受信口は「持ち主が書いている」として扱う」。**
  // **受信の主体は今日、面から見て **持ち主(`owner`)** である** —— **したがって
  // 上の逐語「受信の主体はその3つのどれでもない」は今日は偽であり、
  // `withDefaultRoleRules` が `owner` に配った `inbound_event` の書込規則がそのまま効く。**
  // **反転していたときの期待値(逐語)**:
  // **`expect(res.status).toBe(403);` / `expect(rowCount("inbound_event")).toBe(0);`**
  //
  // **【`ADR-0249` §4-5 の穴1 は、今日ふたたび開いている。丸めない】** ——
  // **`V8-M26` が副作用として塞いでいたものを、`D-V8-67` が意図して開け直した。**
  // **説明文の逐語「受信口を一つ作ると、そこに届いたものは持ち主の広さで書けることに
  // なります(受信口ごとに絞れません)」が、この1行の実測である。**
  expect(res.status).toBe(201);
  expect(rowCount("inbound_event")).toBe(1);
});

// ---------------------------------------------------------------------------
// (G-2) 穴3 —— ワークフローの create_record
// ---------------------------------------------------------------------------

test("(G-2) 壁の立った表に、ワークフローの create_record は今日どおり通る", async () => {
  const owner = session("owner");
  expect(rowCount("wf_note")).toBe(0);

  // **`product` には壁が立っていないので、壁の外の相手でも作れる。**
  const created = await req(owner.cookie, "POST", RECORDS("product"), { name: "梅干し" });
  expect(created.status).toBe(201);

  // **その発火で `wf_note`(壁の立った表)に1行増える。** **実測: 0 → 1。**
  expect(rowCount("wf_note")).toBe(1);

  // **同じ相手が同じ表へ HTTP で作ろうとすると 403 である** —— **壁は立っている。**
  const blocked = await req(owner.cookie, "POST", RECORDS("wf_note"), { note: "運営が作る" });
  expect(blocked.status).toBe(403);
  expect(rowCount("wf_note")).toBe(1);
});

// ---------------------------------------------------------------------------
// (G-3) 穴5 —— DELETE
// ---------------------------------------------------------------------------

test("(G-3) 壁の立った表の行を、壁の外の相手が DELETE できる", async () => {
  const editor = session("editor");
  // **壁の中の相手が1行置く。**
  const created = await req(editor.cookie, "POST", RECORDS("wf_note"), { note: "担当が作った" });
  expect(created.status).toBe(201);
  const row = ((await created.json()) as { record: { _id: string; _updated_at: string } }).record;
  expect(rowCount("wf_note")).toBe(1);

  const owner = session("owner");
  // **同じ相手は1行も作れない**(壁の外である)。
  const blocked = await req(owner.cookie, "POST", RECORDS("wf_note"), { note: "運営が作る" });
  expect(blocked.status).toBe(403);

  // **なのに消せる。**
  const deleted = await req(owner.cookie, "DELETE", `${RECORDS("wf_note")}/${row._id}`, undefined, {
    "if-match": row._updated_at,
  });
  // **実測: 204。** **作れない相手が、同じ表の行を消せる。**
  expect(deleted.status).toBe(204);
  expect(rowCount("wf_note")).toBe(0);
});

// ---------------------------------------------------------------------------
// (G-4) §4-4 —— `anonymous` だけに書いた規則
//
// **【`V8-M20` / `J-G29`】旧テスト名: `(G-4) audience: ["anonymous"] だけを書くと、
// ログイン済みの誰もその表に作れない`。** **旧の題材は `audience: ["anonymous"]`。**
// **新の題材は役割 `anonymous`(予約4語の1つ)だけに書いたボタンの規則である。**
// **期待値(4ロールとも 403 / 0行 / 未ログインは 401)は1バイトも変えていない。**
// ---------------------------------------------------------------------------

test("(G-4) anonymous だけに規則を書くと、ログイン済みの誰もその表に作れない", async () => {
  const roles: readonly Role[] = ["owner", "editor", "viewer", "customer"];
  const statuses: Record<string, number> = {};
  for (const role of roles) {
    const s = session(role);
    const res = await req(s.cookie, "POST", RECORDS("guest_note"), { body: "感想" });
    statuses[role] = res.status;
  }
  // **実測: 4ロールとも 403。** **1行も書かれない。**
  expect(statuses).toEqual({ owner: 403, editor: 403, viewer: 403, customer: 403 });
  expect(rowCount("guest_note")).toBe(0);

  // **【対照】壁の立っていない表(`product`)へ同じ4ロールが投げた実測を並べる** ——
  // **`viewer` / `customer` の 403 は壁が作ったものではない**(今日から既にそうである)。
  // **壁だけが作った差分は `owner` / `editor` の2つである。**
  const control: Record<string, number> = {};
  for (const role of roles) {
    const s2 = session(role);
    const res = await req(s2.cookie, "POST", RECORDS("product"), { name: `${role}の商品` });
    control[role] = res.status;
  }
  expect(control).toEqual({ owner: 201, editor: 201, viewer: 403, customer: 403 });

  // **未ログインは壁の手前(認証)で落ちる** —— **`anonymous` と書いても入口は開かない。**
  const anon = await req(undefined, "POST", RECORDS("guest_note"), { body: "名無し" });
  expect(anon.status).toBe(401);
});

// ---------------------------------------------------------------------------
// (G-5) 穴6 —— 誰も通さない壁を書いた差分
// ---------------------------------------------------------------------------

// **【`V8-M20` / `J-G29`】置き直した検査。**
// **旧テスト名は同じ。** **旧の差分は `update_view` で操作起点に `audience: ["anonymous"]`
// を書くものだった。** **今日その宣言は存在しないので、同じ「誰も通さない壁」を
// 差分操作 `set_roles`(18種目)で書く** —— **役割 `anonymous` だけがそのボタンを読める形。**
// **問い(誰も通さない壁を書いても適用は通り、警告は1件も出ない)は1ミリも変えていない。**
test("(G-5) 誰も通さない壁を書いた差分は、今日どおり valid として適用される(警告0件)", () => {
  const diff: Diff = {
    diff_id: "d-nobody-wall",
    intent: "誰も通さない壁を書く",
    operations: [
      {
        op: "set_roles",
        // **`set_roles` は全体差し替えである** —— **既定3本を必ず含める。**
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
            id: "anonymous",
            name: "未ログイン",
            // **ログイン済みの誰も通らない壁**(`ADR-0249` 限定9 / §4-5 の穴6)。
            rules: [
              { target: "action", view: "catalog-list", action: "go-wf-note", can: ["read"] },
            ],
          },
        ],
      },
    ],
  } as unknown as Diff;

  const result = applyDiff(dataRoot, APP_ID, diff);
  // **実測: valid = true。** **誰も通さない壁でも、差分は今日どおり適用される。**
  expect(result.valid).toBe(true);

  // **警告を運ぶ枠が結果に1つも無い**(`ApplyDiffResult` に `warnings` キーは無い)。
  expect(Object.keys(result)).not.toContain("warnings");
});

// ---------------------------------------------------------------------------
// (G-6) 穴4 —— コードの島(run_function の output_table 全置換)
// ---------------------------------------------------------------------------

test("(G-6) 壁の立った表に、コードの島(run_function)の書込は今日どおり通る", async () => {
  const owner = session("owner");
  expect(rowCount("island_out")).toBe(0);

  // **`island_out` には作成の壁が立っている** —— **壁の外の相手は1行も作れない。**
  const blocked = await req(owner.cookie, "POST", RECORDS("island_out"), { label: "運営が作る" });
  expect(blocked.status).toBe(403);
  expect(rowCount("island_out")).toBe(0);

  // **`tick` には壁が立っていない。** **その作成が島を起こす。**
  const created = await req(owner.cookie, "POST", RECORDS("tick"), { label: "一番目" });
  expect(created.status).toBe(201);

  // **島が壁の立った表へ書いた。** **実測: 0 → 1。**
  expect(rowCount("island_out")).toBe(1);
});

// ---------------------------------------------------------------------------
// (G-7) **`V8-M20` / `J-G29` が新しく開いた穴** —— 識別子(`id`)の無い操作起点
// ---------------------------------------------------------------------------

/**
 * **面の規則は `(view, action)` の2つでボタンを名指しする**(`J-G9`)——
 * **`view_action.id` を書いていない操作起点は名指しできず、壁の材料にならない。**
 *
 * **旧層(`view_action.audience`)は識別子が無くても効いていた** ——
 * **`schemas/manifest.schema.json` の `$defs/view_action.audience` の `$comment` の逐語:
 * 「**旧層は id が無くても効いていた。**」**
 *
 * **【禁止】これを「旧層と同じ限界」と書かない** —— **旧層は塞いでいた。**
 * **【禁止】これを「置き直しで塞がった」と書かない** —— **開いた側である。**
 */
test("(G-7) 識別子を書いていない操作起点の書き先には壁が1本も立たない(V8-M20 が開いた穴)", async () => {
  const owner = session("owner");
  expect(rowCount("no_id_note")).toBe(0);

  // **同じ画面(`catalog-list`)の隣の操作起点は、同じ相手を 403 で止める** ——
  // **違いは識別子を書いたか書かなかったかだけである。**
  const walled = await req(owner.cookie, "POST", RECORDS("wf_note"), { note: "運営が作る" });
  expect(walled.status).toBe(403);

  // **識別子の無い操作起点の書き先には壁が立たない。** **実測: 201。**
  const open = await req(owner.cookie, "POST", RECORDS("no_id_note"), { note: "運営が作る" });
  expect(open.status).toBe(201);
  expect(rowCount("no_id_note")).toBe(1);
});
