/**
 * **`V18-M4-T01`(`PM-G10` / `ADR-0435` / `ADR-0441`)—— TDD の赤。**
 *
 * ## 本ファイルが固定するもの
 *
 * **今日、「この画面は見せない」と決めた相手でも、`?view=` を名乗らずに表の口を直接
 * 叩けば、その表の行が**全件返る**。** **画面名を名乗れば 403 になるのに、名乗らなければ
 * 通る。** **本ファイルは、壁を立てたあとに返るべき答えを先に書く。**
 *
 * **したがって `V18-M4-T02` が配線するまで、下の (A) / (B) / (F-2) / (G-1) は**赤い**。**
 *
 * ## **【禁止】本ファイルは「直った」ことを1件も示さない**
 *
 * **`V18-M4-T01` は検査だけを書く葉であり、製品コードを1バイトも触っていない。**
 * **【禁止】「安全になった」と書かない。** **【禁止】「画面の定義を隠した」と書かない**
 * —— **隠れるのは行であって、画面の定義ではない**(`ADR-0435` §Status / `ADR-0441` §Status 2)。
 *
 * ## 壁の判定(**`docs/plan/v18/06-v18-m4-plan.md` §3-3 + §11-2。11本の決め**)
 *
 * | # | 決め | **固定する検査** |
 * |--:|---|---|
 * | **1** | **要求の形に合う画面だけを見る。** 一覧の口は**一覧系**(`list_view` / `report_view`)、単票の口は**単票系**(`detail_view` / `form`)。**1本でも読めれば通す。1本も読めなければ止める** | **(A-1)**(一覧系を1本も読めない → 0件)/ **(A-3)**(読めれば今日どおり)/ **(B-1)**(単票系を1本も読めない → 404)/ **(B-2)**(**同じ人・同じ表**で一覧は止まり単票は通る) |
 * | **2** | **その表を指す、その形の画面が1本も無いときは今日どおり通す** | **(C-1)**(画面0本の表)/ **(C-2)**(一覧系だけ持つ表の**単票**)/ **(C-3)**(単票系だけ持つ表の**一覧**) |
 * | **3** | **`GET` だけに掛ける。作成・更新・削除には1ビットも掛けない** | **(D-1)** / **(D-2)** / **(D-3)** |
 * | **4** | **一覧は応答から落とす(0件・`total` も 0)。単票は 404**(本文は実在しない行の 404 と、行のIDのほかに1バイトも違わない) | **(A-2)**(`total` とページ送り)/ **(B-3)**(本文の突合) |
 * | **5** | **運営の素通しを作らない。役割の規則がそのまま効く** | **(F-1)**(全画面を読める運営の答えは1ビットも動かない)/ **(F-2)**(**規則で読めない画面が在れば運営にも壁が立つ**) |
 * | **6** | **未ログイン(`anonymous`)にも同じ判定が及ぶ** | **(G-1)**(規則の無い公開表 → 0件)/ **(G-2)**(規則の在る公開表 → 今日どおり) |
 * | **9** | **発火するのは一覧と単票の**2経路ちょうど**。** 集計表 / 誰に配られているか / 到達不能 / バッチ は答えが1ビットも動かない | **(E-1)** 〜 **(E-5)** |
 * | **10** | **`owner-scope.ts` に新しい `export` を1名も作らない** | **本ファイルは撃たない**(`ADR-0441` 限定13 の式が撃つ。§「本ファイルが測らないもの」) |
 * | **11** | **バッチは壁の関数を通るが、広げた枝が読取だけなので答えが動かない。バッチ経路に早期 `return` を足さない** | **(E-4)**(バッチの答え)/ **(E-5)**(**単件経路とバッチ経路が同じ1本を通る**) |
 *
 * ## 赤 / 緑 の別(**書いた時点の宣言。走らせた結果は `T01` の記録に貼る**)
 *
 * | 群 | 何を見るか | **今日** |
 * |---|---|---|
 * | **(A)** | 一覧に壁が立つ | **赤**(A-1 / A-2)。**A-3 は緑** |
 * | **(B)** | 単票に壁が立つ | **赤**(B-1 / B-3)。**B-2 の単票側は緑** |
 * | **(C)** | 決め2(画面が0本) | **緑**(直した後も緑) |
 * | **(D)** | 決め3(書込) | **緑**(直した後も緑) |
 * | **(E)** | 決め9(4つの口) | **緑**(直した後も緑) |
 * | **(F)** | 決め5(運営) | **F-1 は緑 / F-2 は赤** |
 * | **(G)** | 決め6(未ログイン) | **G-1 は赤 / G-2 は緑** |
 * | **(H)** | **射程の担保**(画面の定義は今日どおり読める) | **緑**(**直す前も直した後も緑でなければならない**) |
 * | **(I)** | `?view=` を名乗った答えは1ビットも動かない | **緑**(直した後も緑) |
 *
 * ## 本ファイルが測らないもの(**誇張しない**)
 *
 * - **AI の口(`list_records`)の一覧に壁が立つことは1度も測っていない** —— **`V18-M4-T03`
 *   の担当である。** **本ファイルが AI の口を叩くのは (H-2)(画面の定義が今日どおり
 *   丸ごと読めること)の1本だけである。**
 * - **時刻起動 / 受信口 / 自動処理 / 島 は1度も叩いていない**(`ADR-0435` 限定9)。
 * - **`owner-scope.ts` の `export` の本数は1度も数えていない**(`ADR-0441` 限定13 の
 *   grep の式が撃つ。検査の中に写さない)。
 * - **実地データ(`data/` 3か所)は1バイトも読んでいない・書いていない。**
 *   **台は本ファイルが自前で組み立てた設計図である。**
 * - **参照の名前(担当者欄)が壊れること**(`D-V18-24` で受け入れ済み)は測っていない ——
 *   **製品の画面(`web/`)を1バイトも触らない段だからである。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { PUBLIC_FIELD } from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "unnamed-view-wall";

/** 実在しない行のID(単票の 404 の突合に使う)。 */
const ABSENT_ROW = "00000000-0000-4000-8000-000000000000";

/** 陰性対照の綴り(`06-v18-m4-plan.md` §10 罠7。`zzqqxx` は実在したので使わない)。 */
const NONEXISTENT_VIEW = "qx7v3nope";

type Any = Record<string, unknown>;

/**
 * **題材。** **表9本 × 画面の持ち方を、決め1 / 決め2 が割る**4通り**に敷き詰めてある。**
 *
 * | 表 | 一覧系(`list_view` / `report_view`) | 単票系(`detail_view` / `form`) | `viewer` が読める画面 |
 * |---|---|---|---|
 * | `tasks` | `tasks_list` | `tasks_detail` | **単票系だけ** |
 * | `secrets` | `secrets_list` | `secrets_detail` | **1本も無い** |
 * | `open_items` | `open_list` | `open_detail` | **両方** |
 * | `bare` | **0本** | **0本** | ——(決め2) |
 * | `reports_only` | `reports_report`(**集計画面**) | **0本** | **1本も無い**(決め2 は単票側だけ) |
 * | `forms_only` | **0本** | `forms_form`(**入力フォーム**) | **1本も無い**(決め2 は一覧側だけ) |
 * | `admin_blind` | `admin_blind_list` | **0本** | **誰も読めない**(運営も) |
 * | `public_items` | `public_list` | **0本** | 未ログインは読めない |
 * | `public_open` | `public_open_list` | **0本** | 未ログインも読める |
 *
 * **`editor` には画面の規則を1本も書いていない** —— **決め3(書込に1ビットも掛けない)を
 * 撃つために、「一覧は止まるのに書込は通る」相手が要る。**
 */
function manifest(): Manifest {
  const table = (id: string, name: string, extra: Any[] = []): Any => ({
    id,
    name,
    fields: [{ id: "title", name: "名前", type: "text", required: true }, ...extra],
  });
  return {
    app: {
      id: APP_ID,
      name: "名乗らない読取の壁",
      tables: [
        table("tasks", "課題"),
        table("secrets", "秘密"),
        table("open_items", "開いた表"),
        table("bare", "画面を1本も持たない表"),
        table("reports_only", "集計画面だけの表", [
          { id: "kind", name: "区分", type: "select", options: ["甲", "乙", "丙"] },
        ]),
        table("forms_only", "入力フォームだけの表"),
        table("admin_blind", "誰も画面を読めない表"),
        table("public_items", "公開の表(未ログインに画面を開かない)", [
          { id: PUBLIC_FIELD, name: "公開", type: "boolean" },
        ]),
        table("public_open", "公開の表(未ログインに画面を開く)", [
          { id: PUBLIC_FIELD, name: "公開", type: "boolean" },
        ]),
      ],
      views: [
        {
          id: "tasks_list",
          name: "課題一覧",
          type: "list_view",
          table: "tasks",
          columns: ["title"],
        },
        {
          id: "tasks_detail",
          name: "課題の詳細",
          type: "detail_view",
          table: "tasks",
          fields: ["title"],
        },
        {
          id: "secrets_list",
          name: "秘密一覧",
          type: "list_view",
          table: "secrets",
          columns: ["title"],
        },
        {
          id: "secrets_detail",
          name: "秘密の詳細",
          type: "detail_view",
          table: "secrets",
          fields: ["title"],
        },
        {
          id: "open_list",
          name: "開いた一覧",
          type: "list_view",
          table: "open_items",
          columns: ["title"],
        },
        {
          id: "open_detail",
          name: "開いた詳細",
          type: "detail_view",
          table: "open_items",
          fields: ["title"],
        },
        // **集計画面は一覧系である**(計画 §11-7 の 1)。
        {
          id: "reports_report",
          name: "集計",
          type: "report_view",
          table: "reports_only",
          report: { group_by: [{ field: "kind" }], aggregates: [{ type: "count" }] },
        },
        // **入力フォームは単票系である。**
        {
          id: "forms_form",
          name: "入力",
          type: "form",
          table: "forms_only",
          fields: ["title"],
        },
        {
          id: "admin_blind_list",
          name: "誰も読めない一覧",
          type: "list_view",
          table: "admin_blind",
          columns: ["title"],
        },
        {
          id: "public_list",
          name: "公開一覧(閉じている)",
          type: "list_view",
          table: "public_items",
          columns: ["title"],
        },
        {
          id: "public_open_list",
          name: "公開一覧(開いている)",
          type: "list_view",
          table: "public_open",
          columns: ["title"],
        },
      ],
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            // **運営は `admin_blind_list` **以外**の画面をすべて読める** ——
            // **(F-1) の「答えが1ビットも動かない」と (F-2) の「素通しを作らない」を
            // 同じ台で並べるためである。**
            ...[
              "tasks_list",
              "tasks_detail",
              "secrets_list",
              "secrets_detail",
              "open_list",
              "open_detail",
              "reports_report",
              "forms_form",
              "public_list",
              "public_open_list",
            ].map((view) => ({ target: "view", view, can: ["read"] })),
          ],
        },
        {
          id: "editor",
          name: "編集者",
          // **画面の規則は1本も書かない。** **`secrets` にだけ削除まで開ける**
          // (決め3 を「書込が今日どおり通る」側で撃つには、消せる相手が要る)。
          rules: [{ target: "table", table: "secrets", can: ["read", "write", "delete"] }],
        },
        {
          id: "viewer",
          name: "閲覧者",
          rules: [
            { target: "view", view: "tasks_detail", can: ["read"] },
            { target: "view", view: "open_list", can: ["read"] },
            { target: "view", view: "open_detail", can: ["read"] },
          ],
        },
        {
          id: "anonymous",
          name: "未ログイン",
          rules: [
            // **`D-V8-64`: 表にも1行書かないと中身が並ばない。** **2表とも書く** ——
            // **割れるのは画面の規則だけにする。**
            { target: "table", table: "public_items", can: ["read"] },
            { target: "table", table: "public_open", can: ["read"] },
            { target: "view", view: "public_open_list", can: ["read"] },
          ],
        },
      ],
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
let viewer: ReturnType<typeof seedSession>;
let editor: ReturnType<typeof seedSession>;
let admin: ReturnType<typeof seedSession>;

/** 表ごとに作った行のID(`beforeEach` が詰める。1表あたり3行)。 */
const rows: Record<string, string[]> = {};

/** 行を作る表の全量(`bare` を含む9本)。 */
const ALL_TABLES = [
  "tasks",
  "secrets",
  "open_items",
  "bare",
  "reports_only",
  "forms_only",
  "admin_blind",
  "public_items",
  "public_open",
] as const;

function request(
  cookie: string | undefined,
  method: string,
  path: string,
  body?: unknown,
  ifMatch?: string,
): Promise<Response> {
  const headers: Record<string, string> = { origin: TEST_ORIGIN };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  if (ifMatch !== undefined) {
    headers["if-match"] = ifMatch;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return Promise.resolve(app.request(new Request(`http://localhost${path}`, init)));
}

/** 一覧の口。**ステータス・行ID・`total` の3つを返す**(件数だけで判定しない)。 */
async function list(
  table: string,
  cookie: string | undefined,
  query = "",
): Promise<{ status: number; ids: string[]; total: number }> {
  const response = await request(
    cookie,
    "GET",
    `/api/apps/${APP_ID}/tables/${table}/records${query}`,
  );
  if (response.status !== 200) {
    return { status: response.status, ids: [], total: -1 };
  }
  const body = (await response.json()) as { records: { _id: string }[]; total: number };
  return { status: 200, ids: body.records.map((row) => row._id), total: body.total };
}

/** 単票の口。**ステータスと本文**を返す。 */
async function one(
  table: string,
  recordId: string,
  cookie: string | undefined,
): Promise<{ status: number; body: unknown }> {
  const response = await request(
    cookie,
    "GET",
    `/api/apps/${APP_ID}/tables/${table}/records/${recordId}`,
  );
  return { status: response.status, body: await response.json() };
}

/** 行IDを伏せて本文の**形**だけを比べる(`V18-M3-T02c` の (F-4) と同じ作法)。 */
function shape(body: unknown, ...ids: string[]): unknown {
  let text = JSON.stringify(body);
  for (const id of ids) {
    text = text.replaceAll(id, "<id>");
  }
  return JSON.parse(text);
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

/** 楽観ロックの札(`_updated_at`)を運営の単票の口から取る(`ADR-0017`)。 */
async function stamp(table: string, recordId: string): Promise<string> {
  const got = await one(table, recordId, admin.cookie);
  expect({ table, recordId, status: got.status }).toEqual({ table, recordId, status: 200 });
  return (got.body as { record: { _updated_at: string } }).record._updated_at;
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-v18m4-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "名乗らない読取の壁", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **表の規則だけを既定どおり足す**(`skipAllViews: true`)——
  // **画面の規則は題材が自分で書いている。** **既定を足すと壁そのものが測れなくなる。**
  const applied = applyManifest(
    dataRoot,
    APP_ID,
    withDefaultRoleRules(manifest(), {
      skipAllViews: true,
    }),
  );
  expect(applied.valid, applied.valid ? "" : JSON.stringify((applied as Any).errors)).toBe(true);
  app = createServerApp({ dataRoot });

  admin = seedSession(dataRoot, APP_ID, { role: "owner", username: "u-owner" });
  editor = seedSession(dataRoot, APP_ID, { role: "editor", username: "u-editor" });
  viewer = seedSession(dataRoot, APP_ID, { role: "viewer", username: "u-viewer" });

  // **行は運営の口から作る**(`createRecord` を直に呼ばない = 実際に通る道で作る)。
  for (const table of ALL_TABLES) {
    rows[table] = [];
    for (const index of [1, 2, 3]) {
      const values: Any = { title: `${table}-${index}` };
      if (table === "reports_only") {
        values.kind = ["甲", "乙", "丙"][index - 1] as string;
      }
      if (table === "public_items" || table === "public_open") {
        values[PUBLIC_FIELD] = true;
      }
      const created = await request(
        admin.cookie,
        "POST",
        `/api/apps/${APP_ID}/tables/${table}/records`,
        values,
      );
      expect({ table, status: created.status }).toEqual({ table, status: 201 });
      const body = (await created.json()) as { record: { _id: string } };
      (rows[table] as string[]).push(body.record._id);
    }
  }
  // **台の自己点検** —— **9表とも3行ずつ在ること**(取りこぼすと下の検査が
  // 「壁が立った」ではなく「行が無い」で緑になってしまう)。
  expect(ALL_TABLES.filter((table) => (rows[table] ?? []).length !== 3)).toEqual([]);
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

// ===========================================================================
// (A) 一覧の口 —— **決め1 / 決め4。`T01` のやること (A)**
// ===========================================================================

test("(A-1) その表を指す一覧系の画面を1本も読めない役割には、一覧が0件になる", async () => {
  // **今日の壊れ方**: **3表とも 200 で3行が返る。** **`?view=` を名乗れば 403 なのに、
  // 名乗らないと全件返る**(元番号27 そのもの)。
  const actual: Record<string, { status: number; count: number }> = {};
  for (const table of ["tasks", "secrets", "admin_blind"]) {
    const got = await list(table, viewer.cookie);
    actual[table] = { status: got.status, count: got.ids.length };
  }
  expect(actual).toEqual({
    // **`tasks` は単票系(`tasks_detail`)を読めるが、一覧系(`tasks_list`)は読めない** ——
    // **決め1 は「要求の形に合う画面だけを見る」ので、一覧は止まる。**
    tasks: { status: 200, count: 0 },
    secrets: { status: 200, count: 0 },
    admin_blind: { status: 200, count: 0 },
  });
});

test("(A-2) 【決め4】落とすのは応答からであり、`total` も 0 になる(403 で全部返す形にしない)", async () => {
  const got = await list("secrets", viewer.cookie);
  expect({ status: got.status, total: got.total, count: got.ids.length }).toEqual({
    status: 200,
    total: 0,
    count: 0,
  });
  // **ページ送りでも漏れない**(`limit=1` で歩いても1行も出てこない)。
  const page = await list("secrets", viewer.cookie, "?limit=1&offset=0");
  expect({ total: page.total, count: page.ids.length }).toEqual({ total: 0, count: 0 });
});

test("(A-3) 一覧系を1本でも読めれば、一覧は今日どおり全件返る", async () => {
  const got = await list("open_items", viewer.cookie);
  expect({ status: got.status, ids: sorted(got.ids), total: got.total }).toEqual({
    status: 200,
    ids: sorted(rows.open_items as string[]),
    total: 3,
  });
});

// ===========================================================================
// (B) 単票の口 —— **決め1 / 決め4。`T01` のやること (B)**
// ===========================================================================

test("(B-1) その表を指す単票系の画面を1本も読めない役割には、単票が 404 になる", async () => {
  const target = (rows.secrets as string[])[0] as string;
  expect((await one("secrets", target, viewer.cookie)).status).toBe(404);
});

test("(B-2) 【決め1 の帰結】同じ人・同じ表で、一覧は止まるのに単票は今日どおり 200 である", async () => {
  // **`tasks` は `tasks_detail`(単票系)を viewer に開いている。**
  // **実測の裏付け**: **課題管理アプリの一般利用者は名簿の詳細画面を読めるので、
  // 単票は今日 200 であり、直した後も 200 のままである**(起票の「今日の実測」)。
  const target = (rows.tasks as string[])[0] as string;
  const single = await one("tasks", target, viewer.cookie);
  const listed = await list("tasks", viewer.cookie);
  expect({ single: single.status, listed: listed.ids.length }).toEqual({ single: 200, listed: 0 });
});

test("(B-3) 【決め4】見えない行の 404 は、実在しない行の 404 と行のIDのほかに1バイトも違わない", async () => {
  const target = (rows.secrets as string[])[0] as string;
  const hidden = await one("secrets", target, viewer.cookie);
  const absent = await one("secrets", ABSENT_ROW, viewer.cookie);
  expect({ hidden: hidden.status, absent: absent.status }).toEqual({ hidden: 404, absent: 404 });
  expect(shape(hidden.body, target, ABSENT_ROW)).toEqual(shape(absent.body, target, ABSENT_ROW));
});

test("(B-4) 単票系を1本でも読めれば、単票は今日どおり 200 である", async () => {
  const target = (rows.open_items as string[])[0] as string;
  expect((await one("open_items", target, viewer.cookie)).status).toBe(200);
});

// ===========================================================================
// (C) 決め2 —— **その形の画面が0本の表は今日どおり通る。直す前も直した後も緑**
// ===========================================================================

test("(C-1) 画面を1本も持たない表は、一覧も単票も今日どおり通る", async () => {
  const listed = await list("bare", viewer.cookie);
  const single = await one("bare", (rows.bare as string[])[0] as string, viewer.cookie);
  expect({ status: listed.status, count: listed.ids.length, total: listed.total }).toEqual({
    status: 200,
    count: 3,
    total: 3,
  });
  expect(single.status).toBe(200);
});

test("(C-2) 一覧系だけを持つ表の**単票**は、今日どおり通る(単票系が0本)", async () => {
  // **`reports_only` を指す画面は集計画面(一覧系)1本だけである。**
  // **viewer はそれを読めないが、単票系が0本なので単票は止まらない。**
  const single = await one(
    "reports_only",
    (rows.reports_only as string[])[0] as string,
    viewer.cookie,
  );
  expect(single.status).toBe(200);
});

test("(C-3) 単票系だけを持つ表の**一覧**は、今日どおり全件返る(一覧系が0本)", async () => {
  // **`forms_only` を指す画面は入力フォーム(単票系)1本だけである。**
  const listed = await list("forms_only", viewer.cookie);
  expect({ status: listed.status, count: listed.ids.length, total: listed.total }).toEqual({
    status: 200,
    count: 3,
    total: 3,
  });
});

test("(C-4) 【決め1 の対偶】集計画面は一覧系である(`reports_only` の一覧は止まる)", async () => {
  // **計画 §11-7 の 1**: **決め1 は集計画面を一覧系に含める。**
  // **今日の実地では判定が1組も変わらないが、将来の穴になる側をここで固定する。**
  const listed = await list("reports_only", viewer.cookie);
  expect({ status: listed.status, count: listed.ids.length }).toEqual({ status: 200, count: 0 });
});

test("(C-5) 【決め1 の対偶】入力フォームは単票系である(`forms_only` の単票は 404)", async () => {
  const target = (rows.forms_only as string[])[0] as string;
  expect((await one("forms_only", target, viewer.cookie)).status).toBe(404);
});

// ===========================================================================
// (D) 決め3 —— **書込には1ビットも掛けない。直す前も直した後も緑**
// ===========================================================================
//
// **`editor` は画面の規則を1本も持たないので、一覧は (D-0) のとおり止まる側である。**
// **その同じ人・同じ表への作成・更新・削除が、今日と1ビットも同じ答えを返すこと。**

test("(D-0) 【台の確かめ】書込を撃つ相手は、読取の側では確かに止まる側に居る", async () => {
  // **これが緑でないと (D-1) 〜 (D-3) は「壁の外に居る人で書込を撃った」だけになる。**
  const listed = await list("secrets", editor.cookie);
  expect({ status: listed.status, count: listed.ids.length }).toEqual({ status: 200, count: 0 });
});

test("(D-1) 作成(`POST`)の答えは今日と1ビットも同じ(201)", async () => {
  const created = await request(
    editor.cookie,
    "POST",
    `/api/apps/${APP_ID}/tables/secrets/records`,
    {
      title: "編集者が作った",
    },
  );
  expect(created.status).toBe(201);
  const body = (await created.json()) as { record: { title: string } };
  expect(body.record.title).toBe("編集者が作った");
});

test("(D-2) 更新(`PATCH`)の答えは今日と1ビットも同じ(200)", async () => {
  const target = (rows.secrets as string[])[0] as string;
  const patched = await request(
    editor.cookie,
    "PATCH",
    `/api/apps/${APP_ID}/tables/secrets/records/${target}`,
    { title: "書き換えた" },
    // **楽観ロック(`ADR-0017`)の `If-Match` は今日どおり要る** ——
    // **壁とは別の関門であり、この段で1ビットも動かさない。**
    await stamp("secrets", target),
  );
  expect(patched.status).toBe(200);
});

test("(D-3) 削除(`DELETE`)の答えは今日と1ビットも同じ(204)", async () => {
  const target = (rows.secrets as string[])[1] as string;
  const deleted = await request(
    editor.cookie,
    "DELETE",
    `/api/apps/${APP_ID}/tables/secrets/records/${target}`,
    undefined,
    await stamp("secrets", target),
  );
  expect(deleted.status).toBe(204);
});

// ===========================================================================
// (E) 決め9 / 決め11 —— **4つの口の答えが1ビットも動かない。直す前も直した後も緑**
// ===========================================================================

test("(E-1) 集計表の口(`GET .../views/:view_id/report`)の答えは1ビットも動かない", async () => {
  // **この経路には `:table_id` が無い**(`app.ts:3609` の `as string` は今日嘘である)。
  // **壁が経路を絞らずに発火すると、ここが真っ先に壊れる。**
  const asOwner = await request(
    admin.cookie,
    "GET",
    `/api/apps/${APP_ID}/views/reports_report/report`,
  );
  const asViewer = await request(
    viewer.cookie,
    "GET",
    `/api/apps/${APP_ID}/views/reports_report/report`,
  );
  expect({ owner: asOwner.status, viewer: asViewer.status }).toEqual({ owner: 200, viewer: 403 });
  // **運営の答えの中身も固定する**(ステータスだけ見て「動いていない」と書かない)。
  const body = (await asOwner.json()) as { groups: unknown[] };
  // **応答のキーは着手前と同じ3つちょうどである**(`app.ts` の逐語)。
  expect(Object.keys(body).sort()).toEqual(["groups", "total_groups", "totals"]);
  expect(body.groups.length).toBe(3);
});

test("(E-2) 「誰に配られているか」の口の答えは1ビットも動かない", async () => {
  const target = (rows.secrets as string[])[0] as string;
  const response = await request(
    editor.cookie,
    "GET",
    `/api/apps/${APP_ID}/tables/secrets/records/${target}/access-sources`,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["access", "sources", "subject"]);
});

test("(E-3) 到達不能の行の口の答えは1ビットも動かない", async () => {
  const response = await request(
    admin.cookie,
    "GET",
    `/api/apps/${APP_ID}/tables/secrets/unreachable-records`,
  );
  // **この題材は行ごとの付与を1本も宣言していないので、`V8-M41`(`F-G13`)が開けた
  // 「面の判定で誰にも届かない行を拾う」枝に落ちる** —— **404 ではなく 200 である。**
  // **`secrets` は3役割とも表の読取を持つので、取り残しは0行である。**
  expect(response.status).toBe(200);
  const body = (await response.json()) as { records: unknown[] };
  expect(body.records.length).toBe(0);
});

test("(E-4) 【決め11】バッチの口の答えは1ビットも動かない(早期 `return` を足さない)", async () => {
  // **`editor` は `secrets` の一覧が止まる側に居るが、バッチは読取ではないので通る。**
  const batch = await request(editor.cookie, "POST", `/api/apps/${APP_ID}/batch`, {
    ops: [{ op: "create", table: "secrets", values: { title: "バッチで作った" } }],
  });
  expect(batch.status).toBe(200);
});

test("(E-5) 【決め11 / 起票 T02 (d)】単件経路とバッチ経路は同じ1本(`rejectNamedView`)を通る", async () => {
  // --- ① 振る舞いで撃つ: 同じ名乗りに、2経路が同じ答えを返す -------------------
  const single403 = await request(
    editor.cookie,
    "GET",
    `/api/apps/${APP_ID}/tables/secrets/records?view=secrets_list`,
  );
  const batch403 = await request(
    editor.cookie,
    "POST",
    `/api/apps/${APP_ID}/batch?view=secrets_list`,
    {
      ops: [{ op: "create", table: "secrets", values: { title: "x" } }],
    },
  );
  expect({ single: single403.status, batch: batch403.status }).toEqual({ single: 403, batch: 403 });
  expect(shape(await batch403.json())).toEqual(shape(await single403.json()));

  const single400 = await request(
    editor.cookie,
    "GET",
    `/api/apps/${APP_ID}/tables/secrets/records?view=${NONEXISTENT_VIEW}`,
  );
  const batch400 = await request(
    editor.cookie,
    "POST",
    `/api/apps/${APP_ID}/batch?view=${NONEXISTENT_VIEW}`,
    { ops: [{ op: "create", table: "secrets", values: { title: "x" } }] },
  );
  expect({ single: single400.status, batch: batch400.status }).toEqual({ single: 400, batch: 400 });
  expect(shape(await batch400.json())).toEqual(shape(await single400.json()));

  // --- ② 構造で撃つ: 定義は1本・呼び出しは2箇所ちょうど -----------------------
  // **`ADR-0435` 限定3 / `ADR-0441` 限定5 と同じことを、検査の側からも固定する。**
  // **決め11 が禁じている「バッチ経路に早期 `return` を足す」= 呼び出しを割る形は、
  // ここが 3 になるか 1 になるかで露見する。**
  const source = await readFile(join(import.meta.dir, "app.ts"), "utf8");
  const definitions = source.match(/^\s*const rejectNamedView = /gm) ?? [];
  const calls = source.match(/[^a-zA-Z_.]rejectNamedView\(/g) ?? [];
  expect({ definitions: definitions.length, calls: calls.length }).toEqual({
    definitions: 1,
    calls: 2,
  });
});

// ===========================================================================
// (F) 決め5 —— **運営の素通しを作らない**
// ===========================================================================

test("(F-1) 全画面を読める運営の答えは、どの表でも1ビットも動かない", async () => {
  // **【禁止】これを「運営は壁の外に居る」と読まない** —— **運営が通るのは、規則が
  // その画面を運営に開いているからである**(下の (F-2) が対偶を撃つ)。
  const totals: Record<string, number> = {};
  for (const table of ALL_TABLES) {
    if (table === "admin_blind") {
      continue;
    }
    const got = await list(table, admin.cookie);
    expect({ table, status: got.status }).toEqual({ table, status: 200 });
    totals[table] = got.total;
    expect({
      table,
      single: (await one(table, (rows[table] as string[])[0] as string, admin.cookie)).status,
    }).toEqual({
      table,
      single: 200,
    });
  }
  expect(totals).toEqual({
    tasks: 3,
    secrets: 3,
    open_items: 3,
    bare: 3,
    reports_only: 3,
    forms_only: 3,
    public_items: 3,
    public_open: 3,
  });
});

test("(F-2) 規則で画面を読めない運営にも、同じ壁が立つ(素通しを1本も作らない)", async () => {
  // **`admin_blind_list` は誰の規則にも書かれていない。** **運営も読めない。**
  // **ここに素通しを足すと、規則で運営から画面を隠したアプリで壁が飾りになる**(決め5)。
  const listed = await list("admin_blind", admin.cookie);
  expect({ status: listed.status, count: listed.ids.length, total: listed.total }).toEqual({
    status: 200,
    count: 0,
    total: 0,
  });
});

// ===========================================================================
// (G) 決め6 —— **未ログイン(`anonymous`)にも同じ判定が及ぶ**
// ===========================================================================

test("(G-1) 未ログインが読めない画面しか指していない公開表は、一覧が0件になる", async () => {
  // **`public_items` の行は `st_public: true` である**(= 匿名公開の窓が開く表)。
  // **今日は 200 で3行が返る。** **未ログインは `anonymous` 1語の主体として判定される。**
  const listed = await list("public_items", undefined);
  expect({ status: listed.status, count: listed.ids.length, total: listed.total }).toEqual({
    status: 200,
    count: 0,
    total: 0,
  });
});

test("(G-2) 未ログインが読める画面が1本でも在れば、今日どおり返る", async () => {
  const listed = await list("public_open", undefined);
  expect({ status: listed.status, ids: sorted(listed.ids), total: listed.total }).toEqual({
    status: 200,
    ids: sorted(rows.public_open as string[]),
    total: 3,
  });
});

// ===========================================================================
// (H) 射程の担保 —— **画面の定義そのものは今日どおり読める。**
// **直す前も直した後も緑でなければならない**(`T01` のやること (H) / 完了条件8)
// ===========================================================================

test("(H-1) 画面の定義は、読めない画面も含めて今日どおり丸ごと返る(`GET .../manifest`)", async () => {
  const response = await request(viewer.cookie, "GET", `/api/apps/${APP_ID}/manifest`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { app: { views: { id: string }[] } };
  // **viewer が1本も読めない画面(`secrets_list` / `secrets_detail` / `admin_blind_list`)も
  // 定義としては返る。** **【禁止】これを「隠した」と書かない** —— **隠れるのは行である。**
  expect(sorted(body.app.views.map((view) => view.id))).toEqual(
    sorted([
      "tasks_list",
      "tasks_detail",
      "secrets_list",
      "secrets_detail",
      "open_list",
      "open_detail",
      "reports_report",
      "forms_form",
      "admin_blind_list",
      "public_list",
      "public_open_list",
    ]),
  );
});

test("(H-2) AI の口(`get_manifest`)も、画面の定義を今日どおり丸ごと返す", async () => {
  const { createMcpServer } = await import("../mcp/server.ts");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createMcpServer({
    dataRoot,
    previewBaseUrl: "http://127.0.0.1:3000",
    actor: viewer.userId,
  });
  const client = new Client({ name: "v18-m4-t01", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = (await client.callTool({
      name: "get_manifest",
      arguments: { app_id: APP_ID },
    })) as { isError?: boolean; structuredContent?: unknown };
    expect(result.isError === true).toBe(false);
    const data = result.structuredContent as { manifest: { app: { views: { id: string }[] } } };
    expect(data.manifest.app.views.length).toBe(11);
    expect(data.manifest.app.views.map((view) => view.id)).toContain("secrets_list");
    expect(data.manifest.app.views.map((view) => view.id)).toContain("admin_blind_list");
  } finally {
    await client.close();
    await server.close();
  }
});

// ===========================================================================
// (I) `?view=` を名乗った要求の答えは1ビットも変わらない(完了条件2)
// ===========================================================================

test("(I-1) 読めない画面を名乗った一覧は、今日どおり 403 のままである", async () => {
  const response = await request(
    viewer.cookie,
    "GET",
    `/api/apps/${APP_ID}/tables/secrets/records?view=secrets_list`,
  );
  expect(response.status).toBe(403);
  const body = (await response.json()) as { errors?: { message?: string }[] };
  expect(body.errors?.[0]?.message).toContain("secrets_list");
});

test("(I-2) 読めない画面を名乗った単票も、今日どおり 403 のままである(404 に倒さない)", async () => {
  const target = (rows.secrets as string[])[0] as string;
  const response = await request(
    viewer.cookie,
    "GET",
    `/api/apps/${APP_ID}/tables/secrets/records/${target}?view=secrets_detail`,
  );
  expect(response.status).toBe(403);
});

test("(I-3) 読める画面を名乗った要求は、今日どおり通る", async () => {
  const listed = await list("open_items", viewer.cookie, "?view=open_list");
  expect({ status: listed.status, count: listed.ids.length }).toEqual({ status: 200, count: 3 });
});

test("(I-4) 実在しない画面IDを名乗った要求は、今日どおり 400 である", async () => {
  const response = await request(
    viewer.cookie,
    "GET",
    `/api/apps/${APP_ID}/tables/secrets/records?view=${NONEXISTENT_VIEW}`,
  );
  expect(response.status).toBe(400);
});

test("(I-5) 画面の対象表と URL の表が食い違う名乗りは、今日どおり 400 である", async () => {
  const response = await request(
    viewer.cookie,
    "GET",
    `/api/apps/${APP_ID}/tables/tasks/records?view=open_list`,
  );
  expect(response.status).toBe(400);
});
