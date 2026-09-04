/**
 * **巻き戻し(`undo` / `redo`)が集計表に何をするかの実測**
 * (`V8-M13-T01`。台帳 `Q-G38` = 門A / 限定採用。ユーザ決定 `D-V8-5`)。
 *
 * **審査の正は `docs/plan/v8/records/v8-m7.md`** である。**ただしそこには
 * 「`undo` / `redo` を1度も走らせていない(`Q-G38` の判定は `src/kernel/undo.ts` の
 * 読解である)」という自認が書いてある**(`v8-m7.md:762`)。
 * **`V8-M8` §7-2 が初めて走らせ、本ファイルがそれをリポジトリの検査として固定する。**
 *
 * ## ここで測るもの(**本物の SQLite / 本物の HTTP / モックを1つも置かない**)
 *
 * | 群 | 何を |
 * |---|---|
 * | (A) | **`undo` が集計表の宣言に何をするか**(マニフェスト・読取経路・表と行・役割の規則) |
 * | (B) | **`redo` が何を戻すか**(宣言・行)。**`redo` は HTTP に口が無い** |
 * | (C) | **`preview_undo`(巻き戻しの予告)が集計表について何を返すか** |
 * | (D) | **`D-V8-5`(毎回計算)の帰結** —— **保存された集計値がどこにも無いこと** |
 * | (E) | **`update_view` で書き換えた宣言の巻き戻し** |
 *
 * ## この検査の作り方(**期待値を先に書いていない**)
 *
 * **`V8-M13-T01` の指示により、(A)〜(E) はすべて先に手で叩いて実測し、
 * 出た応答をそのまま期待値にしている。** **実測の逐語は
 * `/private/tmp/.../scratchpad/m13-t01-evidence.md`(リポジトリの外)にある。**
 * **「こうなるはず」と書いてから叩いた検査は1本も無い。**
 *
 * ## 【正直に書く】この検査が言わないこと
 *
 * 1. **`undo` を2回以上続けて叩いていない。** **測ったのは1段だけである。**
 * 2. **MCP 経路の `undo` / `redo` / `preview_undo` を1度も呼んでいない。**
 *    **カーネル関数を直接呼ぶ点は MCP と同じだが、`src/mcp/tools/write.ts` の
 *    応答の形は1バイトも見ていない。**
 * 3. **`remove_view` で集計表を消してから `undo` する経路を測っていない。**
 *    **測ったのは `add_view` と `update_view` の巻き戻しだけである。**
 * 4. **グラフ(`chart`)・上限・結合を1つも含めていない。** **題材は
 *    束ねるキー1本 + 集計2本の最小形である。**
 * 5. **スナップショットが使えないとき(`unusableSnapshotError`)を1度も作っていない。**
 * 6. **可視性を1ミリも測っていない**(それは `report-visibility.test.ts`)。
 *    **本ファイルの利用者は owner 1人だけである。**
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appDbPath, createApp, KernelMetaStore, previewRedo, redo } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN } from "./test-helpers.ts";

const APP_ID = "q-g38-probe";

type Any = Record<string, unknown>;

/**
 * **題材の集計表の宣言。** **束ねるキー1本 + 集計2本の最小形。**
 * **この定数はマニフェストに入る値と1バイト同じであり、`redo` の突き合わせにも使う。**
 */
const BASE_REPORT: Any = {
  group_by: [{ field: "category" }],
  aggregates: [{ type: "sum", field: "amount" }, { type: "count" }],
};

/** 表を1本足す差分(`d1`)。 */
const DIFF_ADD_TABLE: Any = {
  diff_id: "d1",
  intent: "表を1本足す",
  operations: [
    {
      op: "add_table",
      table: {
        id: "sale",
        name: "売上",
        fields: [
          { id: "title", name: "件名", type: "text", required: true },
          { id: "amount", name: "金額", type: "number" },
          { id: "category", name: "区分", type: "select", options: ["A", "B"] },
        ],
      },
    },
  ],
};

/** 集計表を1枚足す差分(`d2`)。**巻き戻しの対象はこれである。** */
const DIFF_ADD_REPORT: Any = {
  diff_id: "d2",
  intent: "集計表を1枚足す",
  operations: [
    {
      op: "add_view",
      view: {
        id: "by-cat",
        type: "report_view",
        table: "sale",
        name: "区分ごと",
        report: BASE_REPORT,
      },
    },
  ],
};

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
let cookie: string;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-report-undo-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "巻き戻しの実測", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **`seedSession` が `app.sqlite` を作る**(`AuthStore.openForApp` は `create: true`)。
  // **`POST /diffs` は owner セッションを要求するので、差分より先に用意する。**
  cookie = seedSession(dataRoot, APP_ID, { role: "owner", username: "prober" }).cookie;
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function req(method: string, path: string, body?: unknown, withCookie = true) {
  const headers: Record<string, string> = { origin: TEST_ORIGIN };
  if (withCookie) {
    headers.cookie = cookie;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return Promise.resolve(app.request(new Request(`http://localhost${path}`, init)));
}

/** 差分を1本当てる。**201 でなければその場で落ちる**(題材の下ごしらえが黙って崩れないように)。 */
async function applyDiffOverHttp(diff: Any): Promise<void> {
  const res = await req("POST", `/api/apps/${APP_ID}/diffs`, diff);
  expect(res.status, await res.clone().text()).toBe(201);
}

/** 行を1件入れる。 */
async function createRow(row: Any): Promise<void> {
  const res = await req("POST", `/api/apps/${APP_ID}/tables/sale/records`, row);
  expect(res.status, JSON.stringify(row)).toBe(201);
}

type ReportAggregate = { type: string; field?: string; value: number };
type ReportBody = {
  groups: { keys: { field: string; value: unknown }[]; aggregates: ReportAggregate[] }[];
  total_groups: number;
  totals: ReportAggregate[];
};

/** 集計表を1枚読む。**応答コードと本文の両方を返す**(`undo` のあとは 404 になるため)。 */
async function readReport(): Promise<{ status: number; body: Any }> {
  const res = await req("GET", `/api/apps/${APP_ID}/views/by-cat/report`);
  return { status: res.status, body: (await res.json()) as Any };
}

/** マニフェストの `views` を読む。 */
async function views(): Promise<Any[]> {
  const res = await req("GET", `/api/apps/${APP_ID}/manifest`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { app: { views: Any[] } };
  return body.app.views;
}

/** マニフェストの `roles` を読む。 */
async function roles(): Promise<Any[]> {
  const res = await req("GET", `/api/apps/${APP_ID}/manifest`);
  const body = (await res.json()) as { app: { roles: Any[] } };
  return body.app.roles;
}

/** 行の一覧を読む(件名だけ抜く)。 */
async function rowTitles(): Promise<string[]> {
  const res = await req("GET", `/api/apps/${APP_ID}/tables/sale/records`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { records: { title: string }[] };
  return body.records.map((r) => r.title);
}

/** 巻き戻しの予告を読む。**未認証で通る口なので cookie を送らない側でも測る。** */
async function previewUndoOverHttp(withCookie = true): Promise<{ status: number; preview: Any }> {
  const res = await req("GET", `/api/apps/${APP_ID}/undo/preview`, undefined, withCookie);
  const body = (await res.json()) as { preview: Any };
  return { status: res.status, preview: body.preview };
}

/**
 * **題材を「集計表を宣言し、そのあとに行を1件足した」状態まで進める。**
 *
 * **`s1` 〜 `s3` は `d2`(集計表を足す差分)の *前*、`s4` は *あと* に入れる** ——
 * **この前後の別れ方が (A-3) と (B-2) の観測点である。**
 */
async function seedUpToReportPlusOneRow(): Promise<void> {
  await applyDiffOverHttp(DIFF_ADD_TABLE);
  await createRow({ title: "s1", amount: 100, category: "A" });
  await createRow({ title: "s2", amount: 200, category: "B" });
  await createRow({ title: "s3", amount: 300, category: "A" });
  await applyDiffOverHttp(DIFF_ADD_REPORT);
  await createRow({ title: "s4", amount: 1000, category: "A" });
}

// =====================================================================================
// (A) `undo` が集計表の宣言に何をするか
// =====================================================================================

test("(A-1) undo で集計表の宣言がマニフェストから丸ごと消える(views が空になる)", async () => {
  await seedUpToReportPlusOneRow();
  expect((await views()).map((v) => v.id)).toEqual(["by-cat"]);

  const res = await req("POST", `/api/apps/${APP_ID}/undo`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { undo: { manifest: { app: { views: Any[] } } } };

  // **応答が返すマニフェストと、読み直したマニフェストの両方で空である。**
  expect(body.undo.manifest.app.views).toEqual([]);
  expect(await views()).toEqual([]);
});

test('(A-2) undo のあと集計の読取は 404 になり、文面は「ビュー "by-cat" はこのアプリのマニフェストにありません。」である', async () => {
  await seedUpToReportPlusOneRow();
  expect((await readReport()).status).toBe(200);

  expect((await req("POST", `/api/apps/${APP_ID}/undo`)).status).toBe(200);

  const after = await readReport();
  expect(after.status).toBe(404);
  // **逐語。** **「集計表だから」ではなく「その画面が無いから」の文面である。**
  expect(after.body).toEqual({
    errors: [
      {
        path: "",
        message: 'ビュー "by-cat" はこのアプリのマニフェストにありません。',
        allowed_values: [],
      },
    ],
  });
});

test("(A-3) undo のあとも表と行は残る —— ただし宣言した差分の *あと* に入れた行は消える", async () => {
  await seedUpToReportPlusOneRow();
  expect(await rowTitles()).toEqual(["s1", "s2", "s3", "s4"]);

  expect((await req("POST", `/api/apps/${APP_ID}/undo`)).status).toBe(200);

  // **表は残っている**(読取が 200 で返る)。**行は3件に減っている。**
  expect(await rowTitles()).toEqual(["s1", "s2", "s3"]);
  // **`undo` はスナップショット(`app.sqlite` の複製)への復元だからである。**
  // **【禁止】これを「集計表が壊した」と読まない** —— **`undo` の既存の性質であり、
  // 集計表に固有ではない。**
});

test("(A-4) undo は集計表を名指しした役割の規則も一緒に落とす(3役割すべてから消える)", async () => {
  await seedUpToReportPlusOneRow();
  // **`add_view` の畳み込みが既定3役割へ `target: "view"` の規則を1本ずつ自動で入れている。**
  const before = await roles();
  expect(
    before.map(
      (r) => (r.rules as Any[]).filter((x) => x.target === "view" && x.view === "by-cat").length,
    ),
  ).toEqual([1, 1, 1]);

  expect((await req("POST", `/api/apps/${APP_ID}/undo`)).status).toBe(200);

  const after = await roles();
  expect(
    after.map(
      (r) => (r.rules as Any[]).filter((x) => x.target === "view" && x.view === "by-cat").length,
    ),
  ).toEqual([0, 0, 0]);
  // **宙に浮いた規則は1本も残らない。** **表(`sale`)を名指しした規則は残る。**
  expect(
    after.map(
      (r) => (r.rules as Any[]).filter((x) => x.target === "table" && x.table === "sale").length,
    ),
  ).toEqual([1, 1, 1]);
});

test('(A-5) undo は changelog に kind="undo" の1行を足す(対象は集計表を足した差分)', async () => {
  await seedUpToReportPlusOneRow();
  expect((await req("POST", `/api/apps/${APP_ID}/undo`)).status).toBe(200);

  const res = await req("GET", `/api/apps/${APP_ID}/changelog`);
  const body = (await res.json()) as { changelog: Any[] };
  const last = body.changelog[body.changelog.length - 1] as Any;
  expect(last.kind).toBe("undo");
  expect(last.diff_id).toBe("undo-d2");
  expect(last.intent).toBe("d2(集計表を1枚足す)を取り消した");
  // **対象は `d2` の `seq`。** **`_create-app` / `d1` / `d2` / `undo-d2` の4行になる。**
  expect(body.changelog.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  expect(last.undo_target_seq).toBe(3);
});

// =====================================================================================
// (B) `redo` が何を戻すか(**HTTP に口が無い**)
// =====================================================================================

test("(B-1) redo に HTTP の口は1本も無い(POST /redo も GET /redo/preview も 404)", async () => {
  await seedUpToReportPlusOneRow();
  expect((await req("POST", `/api/apps/${APP_ID}/undo`)).status).toBe(200);

  const post = await req("POST", `/api/apps/${APP_ID}/redo`);
  expect(post.status).toBe(404);
  expect((await post.json()) as Any).toEqual({
    errors: [
      {
        path: "",
        message: `POST /api/apps/${APP_ID}/redo に対応するエンドポイントはありません。`,
        hint: "エンドポイント一覧は MANUAL.md の「HTTP の口」の節を参照してください。",
      },
    ],
  });
  expect((await req("GET", `/api/apps/${APP_ID}/redo/preview`)).status).toBe(404);
  // **したがって `redo` を走らせる経路はカーネル直呼び(= MCP と同じ)だけである。**
});

test("(B-2) redo で集計表の宣言が1バイトも同じ形で戻り、消えた行も戻る", async () => {
  await seedUpToReportPlusOneRow();
  expect((await req("POST", `/api/apps/${APP_ID}/undo`)).status).toBe(200);
  expect(await views()).toEqual([]);

  const result = redo(dataRoot, APP_ID);
  expect(result.valid).toBe(true);

  // **宣言は `add_view` に書いた形と逐語で一致する。**
  expect(await views()).toEqual([
    { id: "by-cat", type: "report_view", table: "sale", name: "区分ごと", report: BASE_REPORT },
  ]);
  // **`undo` が消した行も戻る。**
  expect(await rowTitles()).toEqual(["s1", "s2", "s3", "s4"]);
  // **役割の規則も戻る。**
  expect(
    (await roles()).map(
      (r) => (r.rules as Any[]).filter((x) => x.target === "view" && x.view === "by-cat").length,
    ),
  ).toEqual([1, 1, 1]);
});

// =====================================================================================
// (C) `preview_undo`(巻き戻しの予告)が集計表について何を返すか
// =====================================================================================

test("(C-1) preview_undo は集計表の宣言が消えることを removed_resources に1件も出さない(views は空のまま)", async () => {
  await seedUpToReportPlusOneRow();
  const { status, preview } = await previewUndoOverHttp();
  expect(status).toBe(200);

  // **【これが本タスクで見つけた穴である】** **`undo` はこの直後に `by-cat` を消すのに、
  // 予告の `removed_resources.views` は空である。**
  // **`extractRemovedResources`(`src/kernel/undo.ts`)が数えるのは `remove_*` の op だけで、
  // 「`add_view` を巻き戻すと画面が消える」を1件も数えないからである。**
  expect(preview.removed_resources).toEqual({
    tables: [],
    views: [],
    workflows: [],
    functions: [],
  });
  // **消えることが読み取れるのは `operations`(取り消される差分そのもの)からだけである。**
  const undoneOp = (preview.operations as Any[])[0] as Any;
  expect(undoneOp.op).toBe("add_view");
  expect((undoneOp.view as Any).id).toBe("by-cat");
});

test("(C-2) preview_undo は「宣言のあとに入った行が消える」ことは lost_records で予告する", async () => {
  await seedUpToReportPlusOneRow();
  const { preview } = await previewUndoOverHttp();

  expect(preview.diff_id).toBe("d2");
  expect(preview.lost_records).toEqual({ sale: 1 });
  expect(preview.restored_records).toEqual({});
  expect(preview.changed_records).toEqual({});
  // **【禁止】「予告があるので問題ない」と読まない** —— **予告を読むのは人であり、
  // AI が `undo` を呼ぶ経路では読まれないことがある。**
});

test("(C-3) preview_undo は未認証でも通る(集計表の宣言が丸ごと本文に出る)", async () => {
  await seedUpToReportPlusOneRow();
  const { status, preview } = await previewUndoOverHttp(false);
  expect(status).toBe(200);
  // **`GET /undo/preview` は今日も未認証で通る**(`src/server/change-routes.ts:192` の逐語)。
  // **集計表の宣言(束ねるキー・集計の種類・絞り込み)がそのまま読める。**
  const firstOp = (preview.operations as Any[])[0] as Any;
  expect((firstOp.view as Any).report).toEqual(BASE_REPORT);
});

test("(C-4) previewRedo は「戻ってくる行の件数」を返すが、戻ってくる集計表の宣言は名指ししない", async () => {
  await seedUpToReportPlusOneRow();
  expect((await req("POST", `/api/apps/${APP_ID}/undo`)).status).toBe(200);

  const result = previewRedo(dataRoot, APP_ID);
  expect(result.valid).toBe(true);
  const preview = (result as { preview: Any }).preview;
  expect(preview.diff_id).toBe("undo-d2");
  expect(preview.restored_records).toEqual({ sale: 1 });
  expect(preview.lost_records).toEqual({});
  // **`redo` の対象は undo エントリであり、その `operations` は空である。**
  // **したがって「集計表が戻る」ことは予告のどこにも出ない。**
  expect(preview.operations).toEqual([]);
  expect(preview.removed_resources).toEqual({
    tables: [],
    views: [],
    workflows: [],
    functions: [],
  });
});

// =====================================================================================
// (D) `D-V8-5`(毎回計算)の帰結 —— **保存された集計値がどこにも無いこと**
// =====================================================================================

test("(D-1) 宣言を1バイトも変えずに行を1件足すと、次の読取で数が増える(読むたびに計算している)", async () => {
  await applyDiffOverHttp(DIFF_ADD_TABLE);
  await createRow({ title: "s1", amount: 100, category: "A" });
  await createRow({ title: "s2", amount: 200, category: "B" });
  await createRow({ title: "s3", amount: 300, category: "A" });
  await applyDiffOverHttp(DIFF_ADD_REPORT);

  const first = (await readReport()).body as unknown as ReportBody;
  expect(first.totals).toEqual([
    { type: "sum", field: "amount", value: 600 },
    { type: "count", value: 3 },
  ]);

  await createRow({ title: "s4", amount: 1000, category: "A" });
  const second = (await readReport()).body as unknown as ReportBody;
  expect(second.totals).toEqual([
    { type: "sum", field: "amount", value: 1600 },
    { type: "count", value: 4 },
  ]);
  // **差分は1本も当てていない。** **宣言はマニフェスト上で同一である。**
  expect(await views()).toEqual([
    { id: "by-cat", type: "report_view", table: "sale", name: "区分ごと", report: BASE_REPORT },
  ]);
});

test("(D-2) undo → redo の直後に読むと、宣言した時点の数(600/3)ではなく今の行の数(1600/4)が返る", async () => {
  await seedUpToReportPlusOneRow();
  const before = (await readReport()).body as unknown as ReportBody;
  expect(before.totals).toEqual([
    { type: "sum", field: "amount", value: 1600 },
    { type: "count", value: 4 },
  ]);

  expect((await req("POST", `/api/apps/${APP_ID}/undo`)).status).toBe(200);
  expect(redo(dataRoot, APP_ID).valid).toBe(true);

  const read = await readReport();
  expect(read.status).toBe(200);
  const after = read.body as unknown as ReportBody;
  // **もし宣言した時点の集計値がどこかに保存されていれば `600` / `3` が返るはずである。**
  // **返らない。** **`undo` / `redo` は宣言と行を巻き戻すだけで、数は毎回作り直される。**
  expect(after.totals).toEqual([
    { type: "sum", field: "amount", value: 1600 },
    { type: "count", value: 4 },
  ]);
  expect(after.groups).toEqual(before.groups);
});

test("(D-3) 白箱 —— app.sqlite に集計値を持つ表が1本も無い(表は _auth_* 8本 + 宣言した sale の9本だけ)", async () => {
  await seedUpToReportPlusOneRow();
  await readReport();
  // **読んだあとに開く** —— **「読んだら書かれる」型の保存が無いことも同時に見る。**
  const db = new Database(appDbPath(dataRoot, APP_ID), { readonly: true });
  try {
    const names = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(names).toEqual([
      "_auth_activity",
      "_auth_invitations",
      "_auth_password_credentials",
      "_auth_pending_challenges",
      "_auth_sessions",
      "_auth_user_roles",
      "_auth_users",
      "_auth_webauthn_credentials",
      "sale",
    ]);
    // **`sale` の列は宣言した3本 + システム3列だけである。** **集計を溜める列が1本も無い。**
    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(sale)")
      .all()
      .map((r) => r.name);
    expect(columns).toEqual(["_id", "_created_at", "_updated_at", "title", "amount", "category"]);
  } finally {
    db.close();
  }
});

test("(D-4) 白箱 —— マニフェストの集計表の宣言に数が1つも入っていない(キーは group_by と aggregates の2つだけ)", async () => {
  await seedUpToReportPlusOneRow();
  await readReport();

  const manifest = JSON.parse(
    readFileSync(join(dataRoot, "apps", APP_ID, "manifest.json"), "utf-8"),
  ) as { app: { views: Any[] } };
  const report = (manifest.app.views[0] as Any).report as Any;
  // **宣言に在るのは「何で束ねるか」と「何を数えるか」だけである。**
  expect(Object.keys(report).sort()).toEqual(["aggregates", "group_by"]);
  expect(report).toEqual(BASE_REPORT);
  // **`value` というキーはマニフェストのどこにも無い**(集計の答えを持つ欄が無い)。
  expect(readFileSync(join(dataRoot, "apps", APP_ID, "manifest.json"), "utf-8")).not.toContain(
    '"value"',
  );
});

// =====================================================================================
// (E) `update_view` で書き換えた宣言の巻き戻し
// =====================================================================================

test("(E-1) update_view で減らした集計は、undo で前の宣言に戻る(読取の aggregates が2本に戻る)", async () => {
  await seedUpToReportPlusOneRow();

  await applyDiffOverHttp({
    diff_id: "d3",
    intent: "集計を件数だけに減らす",
    operations: [
      {
        op: "update_view",
        view: "by-cat",
        changes: {
          report: { group_by: [{ field: "category" }], aggregates: [{ type: "count" }] },
        },
      },
    ],
  });

  const narrowed = (await readReport()).body as unknown as ReportBody;
  expect(narrowed.totals).toEqual([{ type: "count", value: 4 }]);

  expect((await req("POST", `/api/apps/${APP_ID}/undo`)).status).toBe(200);

  const restored = (await readReport()).body as unknown as ReportBody;
  // **宣言が戻ったので `sum` が復活する。** **画面は 404 にならない**(消えたのではなく戻った)。
  expect(restored.totals).toEqual([
    { type: "sum", field: "amount", value: 1600 },
    { type: "count", value: 4 },
  ]);
  expect(await views()).toEqual([
    { id: "by-cat", type: "report_view", table: "sale", name: "区分ごと", report: BASE_REPORT },
  ]);
});

test("(E-2) update_view の巻き戻しの予告は、行について何も失われないと言う(lost / restored / changed が全部空)", async () => {
  await seedUpToReportPlusOneRow();
  await applyDiffOverHttp({
    diff_id: "d3",
    intent: "集計を件数だけに減らす",
    operations: [
      {
        op: "update_view",
        view: "by-cat",
        changes: {
          report: { group_by: [{ field: "category" }], aggregates: [{ type: "count" }] },
        },
      },
    ],
  });

  const { preview } = await previewUndoOverHttp();
  expect(preview.diff_id).toBe("d3");
  expect(preview.lost_records).toEqual({});
  expect(preview.restored_records).toEqual({});
  expect(preview.changed_records).toEqual({});
  expect(preview.removed_resources).toEqual({
    tables: [],
    views: [],
    workflows: [],
    functions: [],
  });
  // **宣言だけを書き換えた差分の巻き戻しは、行を1件も動かさない。**
  // **これは (C-2) と対になる** —— **危ないのは「宣言を足した差分を巻き戻すとき」である。**
});
