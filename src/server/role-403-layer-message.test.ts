/**
 * `V8-M39`(v8 の5本目の軸 `F-G`)—— **止め方を伝える**。
 * **台帳 `F-G7`(403 の文面が止めた層を誤って名指ししないようにする)/
 * `F-G8`(403 の応答から「どの層が止めたか」を読めるようにする)。**
 * **どちらも `docs/plan/v8/records/v8-m35.md` §5-1 で「限定採用・門外(`Δ7`)」。**
 *
 * ## **先に答えを書く(誇張しない)**
 *
 * 1. **`F-G7`** —— **`forbiddenRoleAccessError(what, verb)` の第1引数が、直上の条件が
 *    実際に判定した対象と食い違っていた箇所が **5箇所** あった**(単件 `POST` / 単件 `PATCH` /
 *    まとめ書込の作成・更新 / 手動起動の口の2枝)。**本ファイルはその5箇所を固定する。**
 * 2. **`F-G8`** —— **403 の文面の末尾に `(止めた層: role)` を出す。**
 *    **`ValidationError` のキーは今日も4キーである**(`src/kernel/errors.ts` に1バイトも
 *    触っていない)—— **層の名前は `message` の中の文字列であって、機械可読な欄ではない。**
 *    **形は既に在る3箇所(`src/server/inbound-route.ts` / `src/kernel/workflow-runner.ts` の2箇所)
 *    から逐語で写した** —— **新しい表現を1つも発明していない。**
 * 3. **`ADR-0305` 限定11 / `ADR-0317` 限定5 の伏せ方は1バイトも壊していない** ——
 *    **面が閉じた表の一覧は今日も 200 の空一覧、単件は今日も 404 であり、
 *    その本文に「止めた層」も「role」も「grant」も1文字も出ない**((D) 群が測る)。
 *
 * ## **【この検査が言えないこと。丸めない】**
 *
 * - **`grant`(点)の名前を出す 403 は、HTTP には今日も1本も無い。**
 *   **行ごとの付与が止める 403(`forbiddenRecordWriteError` / `forbiddenRecordDeleteError`)は
 *   本 MS が1バイトも触っていない** —— **したがって `ADR-0308` 限界6(「止めた層の名前は
 *   HTTP の応答から読めない」)が塞がったのは**面(`role`)が止めた 403 だけ**である。**
 * - **`AccessLayerName` の2値のうち、HTTP の文面に今日出るのは `role` の1語だけである。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN } from "./test-helpers.ts";

const APP_ID = "m39-layer";

/**
 * **題材**。**`withDefaultRoleRules` を使わない** —— **どの役割がどの規則を持つかが
 * 本ファイルの主題そのものなので、下ごしらえに足させると測っているものが消える。**
 */
function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "M39 実測台",
      tables: [
        {
          id: "memos",
          name: "メモ",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "body", name: "本文", type: "text" },
            { id: "parent", name: "親", type: "reference", reference_table: "memos" },
          ],
        },
        { id: "secrets", name: "秘密", fields: [{ id: "title", name: "件名", type: "text" }] },
        { id: "notices", name: "通知", fields: [{ id: "title", name: "件名", type: "text" }] },
        {
          id: "wf_runs",
          name: "実行履歴",
          fields: [
            { id: "ran_at", name: "実行時刻", type: "date" },
            { id: "workflow", name: "ワークフロー", type: "text" },
            { id: "trigger_type", name: "きっかけ", type: "text" },
            { id: "status", name: "結果", type: "text" },
            { id: "error", name: "エラー", type: "long_text" },
          ],
        },
      ],
      views: [
        {
          id: "memos_list",
          type: "list_view",
          table: "memos",
          columns: ["title", "body"],
          actions: [
            // **`set` 型** —— **書き先は(`memos`, 更新)。** **ボタンの規則の壁を立てる材料。**
            { id: "mark_done", set: { field: "body", value: "done" }, name: "完了にする" },
            // **`run` 型** —— **書き先を持たない。** **手動起動の口の題材。**
            { id: "run_notify", run: "notify", name: "通知する" },
            // **`form` 型** —— **書き先は(`memos`, 作成)。**
            { id: "new_memo", form: "memos_form", prefill: { field: "parent" }, name: "新規" },
          ],
        },
        { id: "memos_form", type: "form", table: "memos", fields: ["title", "body", "parent"] },
        { id: "secrets_list", type: "list_view", table: "secrets", columns: ["title"] },
      ],
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            { target: "table", table: "memos", can: ["read", "write", "delete"] },
            { target: "table", table: "secrets", can: ["read", "write", "delete"] },
            { target: "table", table: "notices", can: ["read", "write", "delete"] },
            { target: "table", table: "wf_runs", can: ["read", "write", "delete"] },
            { target: "view", view: "memos_list", can: ["read"] },
            { target: "view", view: "memos_form", can: ["read"] },
            { target: "view", view: "secrets_list", can: ["read"] },
            { target: "action", view: "memos_list", action: "mark_done", can: ["read"] },
            { target: "action", view: "memos_list", action: "run_notify", can: ["read"] },
            { target: "action", view: "memos_list", action: "new_memo", can: ["read"] },
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
          ],
        },
        {
          // **(b) 表の規則は持つが、ボタンの規則を1本も持たない。**
          id: "editor",
          name: "編集者",
          rules: [
            { target: "table", table: "memos", can: ["read", "write", "delete"] },
            { target: "view", view: "memos_list", can: ["read"] },
          ],
        },
        {
          // **(a) 表の規則を1本も持たない。**
          id: "viewer",
          name: "閲覧者",
          rules: [{ target: "view", view: "memos_list", can: ["read"] }],
        },
        {
          // **(c) 表も `mark_done` も持つが、`run_notify` を持たない。**
          id: "customer",
          name: "お客様",
          rules: [
            { target: "table", table: "memos", can: ["read", "write", "delete"] },
            { target: "view", view: "memos_list", can: ["read"] },
            { target: "action", view: "memos_list", action: "mark_done", can: ["read"] },
            { target: "action", view: "memos_list", action: "new_memo", can: ["read"] },
          ],
        },
      ],
      workflows: [
        {
          id: "notify",
          name: "通知する",
          trigger: { type: "manual", table: "memos" },
          actions: [
            { action: "create_record", table: "notices", values: { title: "通知しました" } },
          ],
          history_table: "wf_runs",
        },
      ],
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
let cookies: Record<"owner" | "editor" | "viewer" | "customer", string>;
let memoId: string;
let memoVersion: string;
let secretId: string;

async function call(
  cookie: string,
  method: string,
  path: string,
  init?: { body?: unknown; ifMatch?: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { origin: TEST_ORIGIN, cookie };
  if (init?.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (init?.ifMatch !== undefined) {
    headers["if-match"] = init.ifMatch;
  }
  const res = await Promise.resolve(
    app.request(
      new Request(`http://localhost${path}`, {
        method,
        headers,
        ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    ),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** 応答体の1本目のエラーを取り出す。 */
function firstError(body: Record<string, unknown>): Record<string, unknown> {
  const errors = body.errors as Record<string, unknown>[] | undefined;
  expect(Array.isArray(errors)).toBe(true);
  return (errors as Record<string, unknown>[])[0] as Record<string, unknown>;
}

function messageOf(body: Record<string, unknown>): string {
  return String(firstError(body).message);
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-m39-layer-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "M39 実測台", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, manifest()).valid).toBe(true);
  app = createServerApp({ dataRoot });
  cookies = {
    owner: seedSession(dataRoot, APP_ID, { role: "owner", username: "u_owner" }).cookie,
    editor: seedSession(dataRoot, APP_ID, { role: "editor", username: "u_editor" }).cookie,
    viewer: seedSession(dataRoot, APP_ID, { role: "viewer", username: "u_viewer" }).cookie,
    customer: seedSession(dataRoot, APP_ID, { role: "customer", username: "u_customer" }).cookie,
  };
  const created = await call(cookies.owner, "POST", `/api/apps/${APP_ID}/tables/memos/records`, {
    body: { title: "メモ1", body: "はじめ" },
  });
  expect(created.status).toBe(201);
  const record = (created.body as { record: Record<string, string> }).record;
  memoId = record._id as string;
  memoVersion = record._updated_at as string;
  const secret = await call(cookies.owner, "POST", `/api/apps/${APP_ID}/tables/secrets/records`, {
    body: { title: "ひみつ" },
  });
  expect(secret.status).toBe(201);
  secretId = (secret.body as { record: Record<string, string> }).record._id as string;
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (A) `F-G7` —— **表の面が止めたのか、ボタンの規則が止めたのかを、文面が取り違えない**
// ---------------------------------------------------------------------------

test("(A-1) 表の規則を持たない相手の PATCH は、表を名指しする(判定したのは表の面である)", async () => {
  const res = await call(
    cookies.viewer,
    "PATCH",
    `/api/apps/${APP_ID}/tables/memos/records/${memoId}`,
    { body: { body: "x" }, ifMatch: memoVersion },
  );
  expect(res.status).toBe(403);
  // **この枝は着手前から正しい** —— **`recordsAuthMiddleware` の判定対象は表そのものである。**
  expect(messageOf(res.body)).toContain('表 "memos" に対する書き込みは');
  // **ボタンを名指ししていない**(表の面が止めたのであって、ボタンの規則ではない)。
  expect(messageOf(res.body)).not.toContain("のボタン");
});

test("(A-2) 表の規則は持つがボタンの規則を持たない相手の PATCH は、ボタンの層を名指しする", async () => {
  const res = await call(
    cookies.editor,
    "PATCH",
    `/api/apps/${APP_ID}/tables/memos/records/${memoId}`,
    { body: { body: "x" }, ifMatch: memoVersion },
  );
  expect(res.status).toBe(403);
  // **着手前の逐語**: `表 "memos" に対する更新は、あなたの役割に許されていません。`
  // **判定は `isRoleActionWriteAllowed`(ボタンの規則)なのに、表を名指ししていた**(`D-8`)。
  expect(messageOf(res.body)).toContain('表 "memos" のボタン に対する更新は');
  // **特定のボタンIDを騙らない** —— **述語は「どのボタンが止めたか」を返さない。**
  expect(messageOf(res.body)).not.toContain("mark_done");
});

test("(A-3) 作成のボタンの規則を持たない相手の POST も、ボタンの層を名指しする", async () => {
  const res = await call(cookies.editor, "POST", `/api/apps/${APP_ID}/tables/memos/records`, {
    body: { title: "メモ2" },
  });
  expect(res.status).toBe(403);
  // **着手前の逐語**: `表 "memos" に対する作成は、あなたの役割に許されていません。`
  expect(messageOf(res.body)).toContain('表 "memos" のボタン に対する作成は');
});

test("(A-4) 表の面が止めた 403 と、ボタンの規則が止めた 403 は、文面が互いに違う", async () => {
  const byTable = await call(
    cookies.viewer,
    "PATCH",
    `/api/apps/${APP_ID}/tables/memos/records/${memoId}`,
    { body: { body: "x" }, ifMatch: memoVersion },
  );
  const byAction = await call(
    cookies.editor,
    "PATCH",
    `/api/apps/${APP_ID}/tables/memos/records/${memoId}`,
    { body: { body: "x" }, ifMatch: memoVersion },
  );
  expect(byTable.status).toBe(403);
  expect(byAction.status).toBe(403);
  expect(messageOf(byTable.body)).not.toBe(messageOf(byAction.body));
});

test("(A-5) まとめ書込(batch)の作成・更新も、ボタンの層を名指しする", async () => {
  const create = await call(cookies.editor, "POST", `/api/apps/${APP_ID}/batch`, {
    body: { ops: [{ op: "create", table: "memos", values: { title: "メモ3" } }] },
  });
  expect(create.status).toBe(403);
  expect(messageOf(create.body)).toContain('表 "memos" のボタン に対する作成は');
  const update = await call(cookies.editor, "POST", `/api/apps/${APP_ID}/batch`, {
    body: {
      ops: [
        { op: "update", table: "memos", id: memoId, if_match: memoVersion, values: { body: "y" } },
      ],
    },
  });
  expect(update.status).toBe(403);
  expect(messageOf(update.body)).toContain('表 "memos" のボタン に対する更新は');
});

// ---------------------------------------------------------------------------
// (B) `F-G7` —— **手動起動の口が、画面IDをボタン名として名指ししない**
//     (`cp-v8-unify.md` §20-D の 1)
// ---------------------------------------------------------------------------

test("(B-1) `run` 型のボタンの規則を持たない相手には、ボタンIDを名指しする(画面IDではない)", async () => {
  const res = await call(
    cookies.customer,
    "POST",
    `/api/apps/${APP_ID}/views/memos_list/actions/run?workflow=notify&record=${memoId}`,
  );
  expect(res.status).toBe(403);
  // **着手前の逐語**: `ボタン "memos_list" に対する実行は、あなたの役割に許されていません。`
  // **`memos_list` は画面のIDであってボタンのIDではない。**
  expect(messageOf(res.body)).toContain('ボタン "run_notify" に対する実行は');
  expect(messageOf(res.body)).not.toContain('ボタン "memos_list"');
});

test("(B-2) `set` 型のボタンを名指しした要求でも、ボタンIDを名指しする", async () => {
  const res = await call(
    cookies.viewer,
    "POST",
    `/api/apps/${APP_ID}/views/memos_list/actions/run?workflow=mark_done&record=${memoId}`,
  );
  expect(res.status).toBe(403);
  // **`V8-M38` / `F-G6` が作った枝**(`set` 型を判定の前に落とすのをやめた側)。
  expect(messageOf(res.body)).toContain('ボタン "mark_done" に対する実行は');
  expect(messageOf(res.body)).not.toContain('ボタン "memos_list"');
});

test("(B-3) 画面の規則が止めたときは、今日どおり画面を名指しする", async () => {
  const res = await call(
    cookies.editor,
    "POST",
    `/api/apps/${APP_ID}/views/secrets_list/actions/run?workflow=notify&record=${memoId}`,
  );
  expect(res.status).toBe(403);
  expect(messageOf(res.body)).toContain('画面 "secrets_list" に対する閲覧は');
});

// ---------------------------------------------------------------------------
// (C) `F-G8` —— **403 の文面から「止めた層」が読める**
// ---------------------------------------------------------------------------

test("(C-1) 面が止めた 403 の文面には、止めた層の名前が入る", async () => {
  for (const res of [
    await call(cookies.viewer, "PATCH", `/api/apps/${APP_ID}/tables/memos/records/${memoId}`, {
      body: { body: "x" },
      ifMatch: memoVersion,
    }),
    await call(cookies.editor, "PATCH", `/api/apps/${APP_ID}/tables/memos/records/${memoId}`, {
      body: { body: "x" },
      ifMatch: memoVersion,
    }),
    await call(cookies.editor, "POST", `/api/apps/${APP_ID}/tables/memos/records`, {
      body: { title: "メモ2" },
    }),
    await call(
      cookies.customer,
      "POST",
      `/api/apps/${APP_ID}/views/memos_list/actions/run?workflow=notify&record=${memoId}`,
    ),
    await call(
      cookies.editor,
      "POST",
      `/api/apps/${APP_ID}/views/secrets_list/actions/run?workflow=notify&record=${memoId}`,
    ),
  ]) {
    expect(res.status).toBe(403);
    // **既に在る3箇所(`inbound-route.ts` / `workflow-runner.ts` の2箇所)と同じ綴りである。**
    expect(messageOf(res.body)).toContain("(止めた層: role)");
  }
});

test("(C-2) `ValidationError` は今日も4キーであり、機械可読な層の欄は1本も無い", async () => {
  const res = await call(
    cookies.editor,
    "PATCH",
    `/api/apps/${APP_ID}/tables/memos/records/${memoId}`,
    { body: { body: "x" }, ifMatch: memoVersion },
  );
  expect(res.status).toBe(403);
  // **`path` / `message` / `hint` の3キーちょうど**(`allowed_values` はこの応答では出ない)。
  // **`blocked_by` のような5キー目を1本も足していない**(`F-G8` の限定)。
  expect(Object.keys(firstError(res.body)).sort()).toEqual(["hint", "message", "path"]);
});

// ---------------------------------------------------------------------------
// (D) **伏せ方を1バイトも壊していない**(`ADR-0305` 限定11 / `ADR-0317` 限定5)
// ---------------------------------------------------------------------------

test("(D-1) 面が閉じた表の一覧は、今日も 200 の空一覧である", async () => {
  const res = await call(cookies.editor, "GET", `/api/apps/${APP_ID}/tables/secrets/records`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ records: [], total: 0 });
});

test("(D-2) 面が閉じた表の単件は、今日も 404 である", async () => {
  const res = await call(
    cookies.editor,
    "GET",
    `/api/apps/${APP_ID}/tables/secrets/records/${secretId}`,
  );
  expect(res.status).toBe(404);
});

test("(D-3) 404・空一覧・400 の本文には、止めた層の名前が1文字も出ない", async () => {
  const hidden = await call(
    cookies.editor,
    "GET",
    `/api/apps/${APP_ID}/tables/secrets/records/${secretId}`,
  );
  const list = await call(cookies.editor, "GET", `/api/apps/${APP_ID}/tables/secrets/records`);
  // **`if-match` を書かない `PATCH`** —— **400 の側の対照である。**
  const badRequest = await call(
    cookies.owner,
    "PATCH",
    `/api/apps/${APP_ID}/tables/memos/records/${memoId}`,
    { body: { body: "x" } },
  );
  expect(hidden.status).toBe(404);
  expect(list.status).toBe(200);
  expect(badRequest.status).toBe(400);
  for (const res of [hidden, list, badRequest]) {
    const text = JSON.stringify(res.body);
    for (const word of ["止めた層", "role", "grant", "面"]) {
      expect(text).not.toContain(word);
    }
  }
});
