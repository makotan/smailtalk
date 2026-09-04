/**
 * `V5-M25-T05` / `V5-M25-T06` / `V5-M25-T02`
 * —— **手動起動の入口**([`ADR-0176`](../../docs/adr/0176-manual-trigger-entry-point.md))と、
 * **押した人の記録**(ユーザ決定 `D-V5-83`)と、**二重に押したときの実測**の検査。
 *
 * ## **本物のサーバ・本物の SQLite で測る**
 *
 * **`ADR-0174` / `ADR-0175` / `ADR-0176` はどれも §限界1 で「走らせて確かめていない」と
 * 自認している。** **本ファイルはそこを埋める側である** —— **`createServerApp` を
 * 組み立て、実ディスクの `app.sqlite` に対して本物の HTTP 要求を投げる。**
 *
 * ## **先に答えを書く(誇張しない)**
 *
 * 1. **未ログインは 401、権限の無い相手は 403 になる**(`ADR-0176` 限定4 / 限定5)。
 * 2. **画面に出さない相手(`view_action.audience` の列挙外)も、入口が 403 で断る** ——
 *    **`V5-M23` が測った「見えないだけで叩けば通る」を、処理を起こす経路では繰り返していない。**
 *    **【正直に書く】これは `ADR-0177` が作った非対称を1つ増やしている** ——
 *    **同じ `audience` が、レコード経路では読まれず、手動起動の入口では読まれる。**
 * 3. **要求の処理が重なったときの2本目は 409 になる。**
 *    **【禁止】これを「二重押しが防げるようになった」と書かない** ——
 *    **1本目が終わってから押せば2回目は普通に走る**((D-2) が実測している)。
 *
 * ## **追記(`V8-M20`。台帳 `J-G27` / `J-G29`。`ADR-0301`。上の 1〜3 を1バイトも消していない)**
 *
 * **上の 2 に出てくる2つの宣言(`view.audience` / `view_action.audience`)は廃止された。**
 * **代わりに立つのは面(`app.roles[].rules`)である** ——
 * **画面は `{ target: "view", view, can: ["read"] }`、ボタンは
 * `{ target: "action", view, action, can: ["read"] }`。**
 *
 * **入口が何を見て 403 を返すかを `src/server/app.ts` の `manualRunAuthMiddleware` で
 * 実測した**(判定の順序 3 と 5 の位置は1ミリも動いていない):
 *
 * | 段 | 旧(撤去済み) | 今日 |
 * |---|---|---|
 * | 画面(403) | `view.audience` の列挙外 | `judgeRoleAccess({ target: { target: "view", … }, verb: "read" })` |
 * | ボタン(403) | `view_action.audience` の列挙外 | `judgeRoleAccess({ target: { target: "action", … }, verb: "read" })` |
 *
 * **したがって `(B-3)` / `(C-1)` / `(C-2)` は消さずに置き直した** —— **同じ 403 が面の規則で
 * 立つことを実測している。** **【正直に書く】置き直しで題材が1つ変わった** ——
 * **面のボタンの規則は `view_action.id` で名指しするので、`ship-admin` の操作起点に
 * 識別子(`id`)を書き足した。** **旧層は識別子が無くても効いていた**(`schemas/manifest.schema.json`
 * の `$defs/view_action.audience` の `$comment` の逐語:「**旧層は id が無くても効いていた。**」)
 * —— **識別子を書いていない操作起点は今日は面から名指しできず、この入口の 403 も立たない。**
 * **その穴は `(C-3)` が実測して固定する。**
 *
 * **上の 2 が書いていた「`ADR-0177` が作った非対称」は、今日は別の形になっている** ——
 * **レコード経路も面のボタンの規則を読むようになった**(`isRoleActionWriteAllowed`)ので、
 * **「同じ宣言が経路によって効いたり効かなかったりする」は解消された。**
 * **【禁止】これを「穴が塞がった」と書かない** —— **レコード経路が読むのは
 * 作成と更新の2つだけであり、`GET` / `DELETE` は今日も通る。**
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "manual-run-shop";

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "手動起動の店",
      tables: [
        {
          id: "order",
          name: "注文",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "state", name: "状態", type: "text" },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
        {
          id: "notice",
          name: "通知",
          fields: [
            { id: "title", name: "件名", type: "text" },
            { id: "source", name: "対象", type: "text" },
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
      ],
      views: [
        {
          id: "order-list",
          type: "list_view",
          table: "order",
          columns: ["title", "state"],
          actions: [
            // **識別子(`id`)を書いていない操作起点。** **面から名指しできない**((C-3) が測る)。
            { run: "ship", name: "発送する" },
            // **【`V8-M20` / `J-G29` / `ADR-0301`】運営だけに見せる宣言**((C) 群が測る)。
            // **旧: `{ run: "ship-admin", name: "強制発送", audience: ["owner"] }`。**
            // **新: 識別子を書き、面の規則(下の `roles`)の `target: "action"` で名指しする。**
            { id: "ship-admin", run: "ship-admin", name: "強制発送" },
            // **【`V8-M38` / `F-G6`】`set` 型のボタン**(値の書換。**ワークフローを持たない**)。
            // **識別子を書いてある** —— **面のボタンの規則から名指しできる側である。**
            // **(F) 群がこのボタンを `run` の口に名指しして測る。**
            { id: "touch-admin", set: { field: "state", value: "touched" }, name: "状態を触る" },
            // **識別子を書いていない `set` 型のボタン**(**面から名指しできない側**)。
            // **(F-6) が測る。**
            { set: { field: "state", value: "poked" }, name: "つつく" },
          ],
        },
        // **【`V8-M20` / `J-G27` / `ADR-0301`】画面単位の宣言**((B) 群が測る)。
        // **旧: この画面に `audience: ["owner"]` を書いていた。**
        // **新: 面の規則(下の `roles`)の `target: "view"` で名指しする。**
        {
          id: "admin-order-list",
          type: "list_view",
          table: "order",
          columns: ["title"],
          actions: [{ run: "ship", name: "発送する" }],
        },
      ],
      // **面(`app.roles[].rules`)。** **既定3本(`owner` / `editor` / `viewer`)は消せない**
      // (`src/kernel/referential-integrity.ts` の類型17)。
      //
      // **旧: 規則を書いた対象だけが allow-list になる**(裁定 `R-4`)——
      // **`order-list`(画面)と `ship`(識別子なしのボタン)には1本も書いていないので、
      // それらは今日も管轄外(全許可)である。**
      //
      // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`。上の旧文を1バイトも消していない】**
      // **既定が「閉じる」側へ倒れた** —— **規則を1本も名指ししていない画面は今日は拒否される。**
      // **したがって `order-list`(画面)にだけは3役割とも `read` を書き足した** ——
      // **書かないと (C-3) が測っている穴(識別子の無いボタンは名指しできない)が、
      // 画面の段の 403 に隠れて1ミリも測れなくなるからである。**
      // **`ship`(識別子なしのボタン)には今日も1本も書いていない** ——
      // **書けない**((C-3) の主題)。
      // **`admin-order-list`(画面)と `ship-admin`(ボタン)は運営だけのままである**
      // ((B-3) / (C-1) / (C-2) の主題)。
      // **表(`order` / `notice` / `wf-runs`)の規則は `withDefaultRoleRules` が足す**
      // (`skipAllViews: true` にしてあるので、画面とボタンには1本も足させていない)。
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            // **画面: 3役割とも開ける**(`V8-M26`。既定が閉じたので明示が要る)。
            { target: "view", view: "order-list", can: ["read"] },
            // **画面: 運営だけが開ける**((B-3) が測る)。
            { target: "view", view: "admin-order-list", can: ["read"] },
            // **ボタン: 運営だけが押せる**((C-1) / (C-2) が測る)。
            { target: "action", view: "order-list", action: "ship-admin", can: ["read"] },
            // **【`V8-M38` / `F-G6`】`set` 型のボタンの規則。** **`owner` だけが持つ** ——
            // **`editor` / `viewer` は持たない**((F-2) が 403 を測る側である)。
            { target: "action", view: "order-list", action: "touch-admin", can: ["read"] },
          ],
        },
        {
          id: "editor",
          name: "編集者",
          rules: [{ target: "view", view: "order-list", can: ["read"] }],
        },
        {
          id: "viewer",
          name: "閲覧者",
          rules: [{ target: "view", view: "order-list", can: ["read"] }],
        },
      ],
      workflows: [
        {
          id: "ship",
          name: "発送する",
          trigger: { type: "manual", table: "order" },
          actions: [
            {
              action: "create_record",
              table: "notice",
              values: { title: "発送しました", source: "$record._id" },
            },
          ],
          history_table: "wf-runs",
        },
        {
          id: "ship-admin",
          name: "強制発送",
          trigger: { type: "manual", table: "order" },
          actions: [
            {
              action: "create_record",
              table: "notice",
              values: { title: "強制発送しました", source: "$record._id" },
            },
          ],
          history_table: "wf-runs",
        },
        {
          id: "auto",
          name: "自動",
          trigger: { type: "on_create", table: "order" },
          actions: [
            { action: "create_record", table: "notice", values: { title: "作成されました" } },
          ],
          history_table: "wf-runs",
        },
      ],
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-manual-run-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "手動起動の店", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **【`V8-M26`】表の規則だけを足す**(画面とボタンは題材が自分で書いた宣言のままにする)。
  expect(
    applyManifest(dataRoot, APP_ID, withDefaultRoleRules(manifest(), { skipAllViews: true })).valid,
  ).toBe(true);
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function req(cookie: string | undefined, method: string, path: string): Promise<Response> {
  const headers: Record<string, string> = { origin: TEST_ORIGIN };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  return Promise.resolve(app.request(new Request(`http://localhost${path}`, { method, headers })));
}

function session(role: "owner" | "editor" | "viewer" | "customer") {
  return seedSession(dataRoot, APP_ID, { role, username: `${role}-${Math.random()}` });
}

const ORDERS = `/api/apps/${APP_ID}/tables/order/records`;

/** 手動起動の入口の URL(`ADR-0176` §6-1。**具体のパスは実装が決める**)。 */
function runUrl(viewId: string, workflow: string, record: string): string {
  return `/api/apps/${APP_ID}/views/${viewId}/actions/run?workflow=${workflow}&record=${record}`;
}

async function seedOrder(cookie: string): Promise<string> {
  const res = await Promise.resolve(
    app.request(
      new Request(`http://localhost${ORDERS}`, {
        method: "POST",
        headers: { origin: TEST_ORIGIN, cookie, "content-type": "application/json" },
        body: JSON.stringify({ title: "注文1", state: "new" }),
      }),
    ),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { record: { _id: string } }).record._id;
}

function rowsOf(table: string): Record<string, unknown>[] {
  const db = new Database(join(dataRoot, "apps", APP_ID, "app.sqlite"), { readonly: true });
  try {
    return db.query(`SELECT * FROM ${JSON.stringify(table)} ORDER BY rowid`).all() as Record<
      string,
      unknown
    >[];
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// (A) 起こせる —— **ADR-0174 §限界1 の「走らせて確かめていない」を埋める**
// ---------------------------------------------------------------------------

test("(A-1) owner が押すと 200 になり、アクションが実際に走る", async () => {
  const o = session("owner");
  const id = await seedOrder(o.cookie);
  const before = rowsOf("notice").length;
  const res = await req(o.cookie, "POST", runUrl("order-list", "ship", id));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { workflow: string; record: string; failures: string[] };
  expect(body).toEqual({ workflow: "ship", record: id, failures: [] });
  const notices = rowsOf("notice");
  expect(notices.length).toBe(before + 1);
  expect(notices.at(-1)?.source).toBe(id);
});

test("(A-2) 履歴に trigger_type = manual の行が1行残る(列は5本のまま)", async () => {
  const o = session("owner");
  const id = await seedOrder(o.cookie);
  await req(o.cookie, "POST", runUrl("order-list", "ship", id));
  const manual = rowsOf("wf-runs").filter((row) => row.trigger_type === "manual");
  expect(manual).toHaveLength(1);
  expect(manual[0]?.workflow).toBe("ship");
  expect(manual[0]?.status).toBe("success");
  // **「誰が押したか」の列は無い**(`L-G11b` = 保留。`ADR-0072` 限定3 を1バイトも破っていない)。
  expect(Object.keys(manual[0] ?? {})).not.toContain("actor");
});

test("(A-3) その画面が宣言していないワークフローは起こせない(400)", async () => {
  const o = session("owner");
  const id = await seedOrder(o.cookie);
  // `auto` は `on_create` であり、どの画面の操作起点にも書かれていない。
  const res = await req(o.cookie, "POST", runUrl("order-list", "auto", id));
  expect(res.status).toBe(400);
});

test("(A-4) 実在しない行を対象にすると 404", async () => {
  const o = session("owner");
  await seedOrder(o.cookie);
  const res = await req(o.cookie, "POST", runUrl("order-list", "ship", "no-such-row"));
  expect(res.status).toBe(404);
});

// ---------------------------------------------------------------------------
// (B) 誰が起こせるか —— **サーバで測る**(`ADR-0176` 限定4 / 限定5)
// ---------------------------------------------------------------------------

test("(B-1) 未ログインは 401(匿名からは1本も通さない)", async () => {
  const o = session("owner");
  const id = await seedOrder(o.cookie);
  const res = await req(undefined, "POST", runUrl("order-list", "ship", id));
  expect(res.status).toBe(401);
});

// **【`V8-M27-T04` / `T-G5`。期待値を反転させた。旧のテスト名と旧の期待値を逐語で残す】**
// **旧: `test("(B-2) viewer は 403(書ける相手ではない)")` / `expect(res.status).toBe(403);`**
// **根拠**: **`V8-M27` / 台帳 `T-G5` / ユーザ決定 `D-V8-38`。**
// **手動起動の入口から「6. ロール」の段(`hasAdminWriteRole` / `nonAdminTableAccess`)を
// 撤去した** —— **`viewer` は「書ける相手ではない」という理由では止まらなくなった。**
// **今日この入口が見るのは、画面の面(3.)とボタンの面(5.)だけである** ——
// **`order-list` の画面には3役割とも `read` が書いてあり、`ship` は識別子を持たないので
// ボタンの面から名指しできない**((C-3) の主題)。**したがって `viewer` は通る。**
// **【正直に書く】これは広がりである。** **対象の表に書込の規則を持たない相手でも、
// 画面とボタンが開いていれば自動処理を起こせる**(入口は自動処理が何を書くかを見ない)。
test("(B-2 の反転) viewer はロールでは止まらない(止めているのは個人スコープの 404)", async () => {
  const o = session("owner");
  const id = await seedOrder(o.cookie);
  const v = session("viewer");
  const res = await req(v.cookie, "POST", runUrl("order-list", "ship", id));
  // **旧は `403`(`forbiddenWriteError`「この操作を行う権限がありません(閲覧のみ)。」)だった。**
  // **今日は `404` である** —— **`order` は `st_owner` を持ち、この行は `owner` のもの
  // だからである**(`ADR-0016` の個人スコープ。**本タスクは1バイトも触っていない**)。
  expect(res.status).toBe(404);
  // **止めた理由が「ロール」ではなく「その行が見えない」であることを、文面で固定する。**
  const body = (await res.json()) as { errors: { message: string }[] };
  expect(body.errors[0]?.message).toContain("は存在しません。");
  expect(body.errors[0]?.message).not.toContain("権限がありません");
});

// **【`V8-M27-T04` / `T-G5`】`viewer` が実際に起こせることは、本ファイルでは測れない** ——
// **この題材の `order` は `st_owner` を持ち、行の作成時にサーバが `st_owner` を
// 要求者の id へ矯正するので**(`ADR-0016`)、**`viewer` 名義の行を仕込む手だてが無い**
// (`owner` に `st_owner: viewer.userId` を送らせると 400 になる。2026-08-11 に実測した)。
// **代わりに `src/server/nonadmin-layer-removal.test.ts` の (d) が、
// `st_owner` を持たない表で `viewer` の 200 を実測している。**

// **【`V8-M20` / `J-G27` / `ADR-0301`】置き直した検査。**
// **旧テスト名: `(B-3) 画面単位の audience の列挙外は 403(画面ごと開けない相手は起こせない)`。**
// **旧の題材は `view.audience: ["owner"]`。** **新の題材は面の画面の規則である。**
// **期待値(403)は1バイトも変えていない** —— **入口が読む宣言が変わっただけである。**
test("(B-3) 画面単位の面の規則で読めない相手は 403(画面ごと開けない相手は起こせない)", async () => {
  const o = session("owner");
  const id = await seedOrder(o.cookie);
  const e = session("editor");
  const res = await req(e.cookie, "POST", runUrl("admin-order-list", "ship", id));
  expect(res.status).toBe(403);
});

test("(B-4) editor は開ける画面から、自分に見える行に対してなら起こせる(200)", async () => {
  const e = session("editor");
  const id = await seedOrder(e.cookie);
  const res = await req(e.cookie, "POST", runUrl("order-list", "ship", id));
  expect(res.status).toBe(200);
});

test("(B-5) 他人の行(個人スコープで見えない行)は 404 で伏せられる —— 処理も走らない", async () => {
  // **`order` は `st_owner` を持つ個人所有テーブルである。**
  // **`V5-M23` が測った「見えないだけで叩けば通る」を、行の見え方についても繰り返さない。**
  const o = session("owner");
  const id = await seedOrder(o.cookie);
  const e = session("editor");
  const before = rowsOf("notice").length;
  const res = await req(e.cookie, "POST", runUrl("order-list", "ship", id));
  expect(res.status).toBe(404);
  expect(rowsOf("notice").length).toBe(before);
});

// ---------------------------------------------------------------------------
// (C) 操作起点単位 —— **入口が読む**(`V5-M23` の穴を繰り返さない)
//
// **【`V8-M20` / `J-G29` / `ADR-0301`】旧: `view_action.audience`。**
// **新: 面のボタンの規則(`{ target: "action", view, action, can: ["read"] }`)。**
// **入口が 403 を返す位置は1ミリも動いていない**(`app.ts` の `manualRunAuthMiddleware`
// の判定の順序 5)。
// ---------------------------------------------------------------------------

// **旧テスト名: `(C-1) 操作起点の audience の列挙外は、入口を直接叩いても 403`。**
test("(C-1) 操作起点の面の規則で読めない相手は、入口を直接叩いても 403", async () => {
  const o = session("owner");
  const id = await seedOrder(o.cookie);
  const e = session("editor");
  const res = await req(e.cookie, "POST", runUrl("order-list", "ship-admin", id));
  expect(res.status).toBe(403);
  // **1行も走っていない。**
  expect(rowsOf("notice").filter((row) => row.title === "強制発送しました")).toHaveLength(0);
});

// **旧テスト名: `(C-2) 列挙に載っている相手は通る(200)`。**
test("(C-2) 規則で読める相手は通る(200)", async () => {
  const o = session("owner");
  const id = await seedOrder(o.cookie);
  const res = await req(o.cookie, "POST", runUrl("order-list", "ship-admin", id));
  expect(res.status).toBe(200);
});

/**
 * **【`V8-M20` / `J-G29` で新しく開いた穴。塞いでいないことを固定する側である】**
 *
 * **面のボタンの規則は `(view, action)` の2つで名指しする**(`J-G9`)—— **したがって
 * `view_action.id` を書いていない操作起点は名指しできず、規則を1本も書けない。**
 * **`app.ts` の該当箇所は `typeof declared.id === "string"` を先に見ており、識別子が
 * 無ければ面の判定そのものを呼ばない**(= 管轄外 = 全許可)。
 *
 * **旧層(`view_action.audience`)は識別子が無くても効いていた** ——
 * **`schemas/manifest.schema.json` の `$defs/view_action.audience` の `$comment` の逐語:
 * 「**旧層は id が無くても効いていた。**」**
 *
 * **【禁止】これを「同じ限界を引き継いだ」と書かない** —— **新しく開いた穴である。**
 * **【禁止】これを「壁が立っている」と書かない** —— **`ship` は今日、誰でも押せる。**
 */
test("(C-3) 識別子を書いていない操作起点には面の規則を1本も書けない(穴。同じ画面の同じ相手が通る)", async () => {
  // **自分の行を対象にする** —— **個人スコープ(`st_owner`)の 404 と混ざらないようにする。**
  const e = session("editor");
  const id = await seedOrder(e.cookie);

  // **`ship` には `id` が無い。** **`order-list` は画面の規則も持たない。**
  // **したがって面は1度も止めない** —— **実測: 200。**
  expect((await req(e.cookie, "POST", runUrl("order-list", "ship", id))).status).toBe(200);

  // **【対照】同じ画面・同じ相手・同じ行でも、`ship-admin`(識別子あり)は 403 になる。**
  // **止めているのは面のボタンの規則だけである。**
  expect((await req(e.cookie, "POST", runUrl("order-list", "ship-admin", id))).status).toBe(403);
});

// ---------------------------------------------------------------------------
// (F) **`set` 型のボタンが `run` の口に来たとき**(`V8-M38` / `F-G6` / 裁定 `F-11`)
// ---------------------------------------------------------------------------
//
// **着手前の実物**(`docs/plan/v8/records/v8-m35-prestate-m33.md` §C-2 の (2a) / (2b)):
// **`set` 型のボタンを名指しすると、そのボタンの規則を**持つ人**(`alice`)でも
// **持たない人**(`bob`)でも、応答が1バイト違わない 400 になった** ——
// **`manualRunNotDeclaredError`(「…を起こすボタンが1つも置かれていません。」)。**
// **面の判定(`app.ts` の判定の順序 5)に1度も到達していなかった。**
//
// **本群が固定するのは、`V8-M35` §5-2 が採った限定の2点だけである**:
//
//  1. **`set` 型のボタンは面の判定に**到達する**。** **通らない相手には 403。**
//  2. **通った相手には「これは自動処理を起こすボタンではない」と分かる 400 を返す。**
//
// **【禁止】これを「ボタンの規則が効くようになった」と読まない** ——
// **効くようになったのは `run` の口の入口の判定だけである。**
// **`PATCH …/records` 経路の同じ規則の評価(`isRoleActionWriteAllowed`)は
// 着手前から在り、`V8-M38` は1バイトも触っていない。**
//
// **【禁止】これを「`set` ボタンを起こせるようになった」と読まない** ——
// **`set` 型はワークフローを持たないので、この口からは今日も1度も走らない**
// (どの相手に対しても書込は0行である。(F-3) が実測する)。

test("(F-1) `set` 型のボタンを名指しした、規則を持つ相手は面の判定を通り、400 で「起こすボタンではない」と返る", async () => {
  const o = session("owner");
  const id = await seedOrder(o.cookie);
  const res = await req(o.cookie, "POST", runUrl("order-list", "touch-admin", id));
  expect(res.status).toBe(400);
  const body = (await res.json()) as {
    errors: { message: string; allowed_values?: string[]; hint?: string }[];
  };
  // **着手前の文面(逐語。`v8-m35-prestate-m33.md` §C-2 の (2a))**:
  //     画面 "memos_detail" には、自動処理 "memo_touch" を起こすボタンが1つも置かれていません。
  // **今日は「置かれていません」ではない** —— **置かれてはいるが、起こす種類ではない。**
  expect(body.errors[0]?.message).not.toContain("1つも置かれていません");
  expect(body.errors[0]?.message).toContain("touch-admin");
  expect(body.errors[0]?.message).toContain("自動処理を起こすボタンではありません");
  // **`allowed_values` は着手前と同じ「その画面の `run` 型の一覧」である**(中身を変えていない)。
  expect(body.errors[0]?.allowed_values).toEqual(["ship", "ship-admin"]);
});

test("(F-2) `set` 型のボタンを名指しした、規則を持たない相手は 403(面の判定に到達している)", async () => {
  const e = session("editor");
  // **自分の行を対象にする** —— **個人スコープ(`st_owner`)の 404 と混ざらないようにする。**
  const id = await seedOrder(e.cookie);
  const res = await req(e.cookie, "POST", runUrl("order-list", "touch-admin", id));
  expect(res.status).toBe(403);
  // **着手前は同じ要求が 400 だった**(面の判定に届かなかった)。
  const body = (await res.json()) as { errors: { message: string }[] };
  expect(body.errors[0]?.message).toContain("実行");
});

test("(F-3) `set` 型を `run` の口に名指ししても、行は1バイトも書き換わらない(400 でも 403 でも)", async () => {
  const o = session("owner");
  const id = await seedOrder(o.cookie);
  const e = session("editor");
  const eid = await seedOrder(e.cookie);
  expect((await req(o.cookie, "POST", runUrl("order-list", "touch-admin", id))).status).toBe(400);
  expect((await req(e.cookie, "POST", runUrl("order-list", "touch-admin", eid))).status).toBe(403);
  // **`set.value` は `"touched"`。** **どちらの行にも入っていない。**
  for (const row of rowsOf("order")) {
    expect(row.state).toBe("new");
  }
  // **手動起動のワークフローは1本も走っていない**(`wf-runs` に在る2行は、行の作成で
  // 発火した `auto`(`on_create`)の分である)。
  expect(rowsOf("wf-runs").filter((row) => row.trigger_type === "manual")).toHaveLength(0);
});

test("(F-4) その画面に無い識別子は、今日どおり 400(`manualRunNotDeclaredError` を1バイトも変えていない)", async () => {
  const o = session("owner");
  const id = await seedOrder(o.cookie);
  const res = await req(o.cookie, "POST", runUrl("order-list", "no-such-button", id));
  expect(res.status).toBe(400);
  const body = (await res.json()) as {
    errors: { message: string; allowed_values?: string[]; hint?: string }[];
  };
  expect(body.errors[0]?.message).toContain("1つも置かれていません");
  expect(body.errors[0]?.allowed_values).toEqual(["ship", "ship-admin"]);
  expect(body.errors[0]?.hint).toBe(
    "画面の操作起点(actions の run)に書かれている自動処理だけを起こせます。",
  );
});

test("(F-5) `run` 型のボタンの挙動は1ミリも変わらない(200 / 403 / 400 の3通り)", async () => {
  const o = session("owner");
  const id = await seedOrder(o.cookie);
  const e = session("editor");
  // **規則を持つ相手は今日も走る。**
  expect((await req(o.cookie, "POST", runUrl("order-list", "ship-admin", id))).status).toBe(200);
  // **規則を持たない相手は今日も 403。**
  expect((await req(e.cookie, "POST", runUrl("order-list", "ship-admin", id))).status).toBe(403);
  // **`manual` でないワークフローは今日も 400。**
  expect((await req(o.cookie, "POST", runUrl("order-list", "auto", id))).status).toBe(400);
});

/**
 * **【塞いでいない穴。固定する側である】**
 *
 * **識別子(`id`)を書いていない `set` 型のボタンは、`run` の口から名指しできない** ——
 * **`workflow` に渡せる文字列が1つも無いからである。** **(C-3) が `run` 型について
 * 測っている穴と同じ形が、`set` 型にも在る。**
 *
 * **【禁止】これを「`set` 型のボタンはすべて判定に届くようになった」と書かない。**
 */
test("(F-6) 識別子を書いていない `set` 型のボタンは、`run` の口から名指しできない(穴)", async () => {
  const o = session("owner");
  const id = await seedOrder(o.cookie);
  // **名前(`つつく`)でも、書き換え先の項目名(`state`)でも届かない。**
  for (const candidate of ["つつく", "state", "poked"]) {
    const res = await req(o.cookie, "POST", runUrl("order-list", candidate, id));
    expect(res.status, candidate).toBe(400);
    const body = (await res.json()) as { errors: { message: string }[] };
    expect(body.errors[0]?.message, candidate).toContain("1つも置かれていません");
  }
});

// ---------------------------------------------------------------------------
// (D) 二重に押す —— **`V5-M25-T02`。実際に投げて測る**
// ---------------------------------------------------------------------------

test("(D-1) 要求の処理が重なった2本目は 409 で、1回しか走らない", async () => {
  const o = session("owner");
  const id = await seedOrder(o.cookie);
  const before = rowsOf("notice").length;
  // **本物の要求を2本、同時に投げる。**
  const [first, second] = await Promise.all([
    req(o.cookie, "POST", runUrl("order-list", "ship", id)),
    req(o.cookie, "POST", runUrl("order-list", "ship", id)),
  ]);
  const statuses = [first.status, second.status].sort();
  expect(statuses).toEqual([200, 409]);
  // **走ったのは1回だけである。**
  expect(rowsOf("notice").length).toBe(before + 1);
  // **409 は履歴行を1行も書かない**(`ADR-0175` §6-2)。
  expect(rowsOf("wf-runs").filter((row) => row.trigger_type === "manual")).toHaveLength(1);
});

test("(D-2) 1本目が終わってから押せば2回目も走る(ADR-0175 限定3。二重押しは防げていない)", async () => {
  const o = session("owner");
  const id = await seedOrder(o.cookie);
  const before = rowsOf("notice").length;
  expect((await req(o.cookie, "POST", runUrl("order-list", "ship", id))).status).toBe(200);
  expect((await req(o.cookie, "POST", runUrl("order-list", "ship", id))).status).toBe(200);
  expect(rowsOf("notice").length).toBe(before + 2);
});

test("(D-3) 別の行が対象なら、重なっても両方通る(判定の要素は3つ組である)", async () => {
  const o = session("owner");
  const a = await seedOrder(o.cookie);
  const b = await seedOrder(o.cookie);
  const [first, second] = await Promise.all([
    req(o.cookie, "POST", runUrl("order-list", "ship", a)),
    req(o.cookie, "POST", runUrl("order-list", "ship", b)),
  ]);
  expect([first.status, second.status]).toEqual([200, 200]);
});

// ---------------------------------------------------------------------------
// (E) 押した人の記録 —— **`D-V5-83`。変更履歴ではなく監査記録の側**
// ---------------------------------------------------------------------------

function activityRows(): Record<string, unknown>[] {
  const db = new Database(join(dataRoot, "apps", APP_ID, "app.sqlite"), { readonly: true });
  try {
    return db.query(`SELECT * FROM "_auth_activity" ORDER BY rowid`).all() as Record<
      string,
      unknown
    >[];
  } finally {
    db.close();
  }
}

test("(E-1) 起こした人が _auth_activity に1行残る(user_id / username が押した人)", async () => {
  const o = session("owner");
  const id = await seedOrder(o.cookie);
  const before = activityRows().length;
  await req(o.cookie, "POST", runUrl("order-list", "ship", id));
  const rows = activityRows();
  const manual = rows.filter((row) => row.action === "manual_run");
  expect(rows.length).toBeGreaterThan(before);
  expect(manual).toHaveLength(1);
  expect(manual[0]?.user_id).toBe(o.userId);
  expect(manual[0]?.username).toBe(o.username);
  expect(manual[0]?.table_id).toBe("order");
  expect(manual[0]?.record_id).toBe(id);
});

test("(E-2) 409 で断られたときは1行も増えない", async () => {
  const o = session("owner");
  const id = await seedOrder(o.cookie);
  await Promise.all([
    req(o.cookie, "POST", runUrl("order-list", "ship", id)),
    req(o.cookie, "POST", runUrl("order-list", "ship", id)),
  ]);
  expect(activityRows().filter((row) => row.action === "manual_run")).toHaveLength(1);
});

test("(E-3) 403 で断られたときは1行も増えない", async () => {
  const o = session("owner");
  const id = await seedOrder(o.cookie);
  const e = session("editor");
  await req(e.cookie, "POST", runUrl("order-list", "ship-admin", id));
  expect(activityRows().filter((row) => row.action === "manual_run")).toHaveLength(0);
});

test("(E-4) 変更履歴(_workflow_history 相当の wf-runs)には押した人が1文字も入らない", async () => {
  const o = session("owner");
  const id = await seedOrder(o.cookie);
  await req(o.cookie, "POST", runUrl("order-list", "ship", id));
  const manual = rowsOf("wf-runs").filter((row) => row.trigger_type === "manual");
  expect(manual).toHaveLength(1);
  const serialized = JSON.stringify(manual[0]);
  // **押した人の id もログイン名も、履歴の行のどこにも出てこない。**
  expect(serialized).not.toContain(o.userId);
  expect(serialized).not.toContain(o.username);
});
