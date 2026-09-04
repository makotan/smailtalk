/**
 * **集計表の結合(`report.join`)が受け付ける形と、受け付けない形の実測**
 * (`V8-M9`。台帳 `Q-G6` / `Q-G7` / `Q-G8` / `Q-G9`。ユーザ決定 `D-V8-1` / `D-V8-120`。
 * 裁定 `M7-1`(上限の実数)。門A 本審査 = `V8-M7`。
 * 審査記録 `docs/plan/v8/records/v8-m7.md` / 実施記録 `docs/plan/v8/records/v8-m9.md`)。
 *
 * **構えは `src/server/report-declaration-boundary.test.ts`(`V8-M8`)に倣う** ——
 * **(A) 適用時の拒否 / (B) `API` の応答 / (C) 白箱**の3群で、**本物の SQLite・本物の HTTP**
 * を通す。
 *
 * ## この検査が固定するもの
 *
 * | 群 | 何を |
 * |---|---|
 * | (A) | **適用時の拒否**(`src/kernel/referential-integrity.ts` の類型18)。**本物の SQLite への適用で示す** |
 * | (B) | **結合した集計の応答**(`GET /api/apps/:app_id/views/:view_id/report`) |
 * | (C) | **白箱**(製品コードとスキーマの文字列・構造を読む) |
 *
 * ## 【正直に書く】この検査が言わないこと(**7点**)
 *
 * 1. **可視性を1ミリも掛けていない** —— **`V8-M9` の範囲外である**(掛けるのは `V8-M10`)。
 *    **(22) と (23) は「今日は掛かっていない」ことを**事実として**固定しており、
 *    `V8-M10` で反転する検査である**(テスト名にそう書いてある)。
 * 2. **上限(群の件数の頭打ち)を1つも測っていない** —— **実装が1バイトも無い**(`V8-M10`)。
 * 3. **「合計が重複しない」ことを1つも示していない** —— **示せるのは「重複しうる形を
 *    スキーマから閉め出した」までである**((9) と (17) がその範囲を実測で書いている)。
 *    **一対多の結合が1本でも入れば、起点の行はその子の数だけ数えられる。**
 * 4. **性能を1度も測っていない** —— **結合はメモリ上で行うので、結合先の表が大きいほど
 *    遅くなるはずだが、どこで遅くなるかは1件も測っていない。**
 * 5. **ブラウザを1枚も開いていない** —— **`report_view` を描く実装は今日1バイトも無い**
 *    (描くのは `V8-M11`)。
 * 6. **MCP 経路を1ミリも測っていない**(`V8-M8` の (4) と同じ穴が結合にもそのまま在る)。
 * 7. **(21) の5経路のうち、振る舞いで示せたのは2つだけである** —— **残る3つは
 *    スキーマの構造で示している**(そのことを (21) の中に逐語で書いてある)。
 *
 * ## 【2026-08-16 訂正(`V8-M13-T04`。台帳 `Q-G30`)。上の7点を1バイトも書き換えていない】
 *
 * **上の 1 / 2 / 5 / 6 の将来形は、今日はもう将来ではない。**
 *
 * - **1 と 2**: **`V8-M10` が可視性と上限を掛けた** —— **集計の母集団には、その要求をした人が
 *   読める行だけが入るので、見る人によって数が変わる。** **ただし本ファイルの (22) / (23) は
 *   反転していない** —— **結合先の表は今日も素通しで全件読まれるからである**(**塞がっていない穴**)。
 *   **【禁止】これを「集計に権限が効くようになった」と書かない。**
 * - **5**: **`V8-M11` が描いた** —— **集計表はブラウザに描かれ、`V8-M12` が画面の上に
 *   グラフ(棒と折れ線の2種)を足した。**
 * - **6**: **`V8-M13-T02` が `read_report` を足した** —— **MCP からは集計表を1枚読める**
 *   (**`list_records` は今日も `report` を1つも見ない**)。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "report-join";

type Any = Record<string, unknown>;

/**
 * **題材の6表**(**参照の鎖が4段ある**)。
 *
 * ```
 * product ←(product)─ line_item ─(order)→ order ─(customer)→ customer ─(region)→ region ─(country)→ country
 * ```
 *
 * - **鎖が4段あることが要点である** —— **段数の上限(3)を超えた宣言を実際に作れなければ、
 *   「上限で止まった」ことを示せない**(実在しないから弾かれた、では検査にならない)。
 * - **`product` は突き合わせに使えない8型を全部持つ**(`text` / `long_text` / `number` /
 *   `select` / `date` / `boolean` / `image` / `file`)—— **(2) が8種を別々に打つため。**
 * - **`line_item.secret_cost` は役割の規則が名指しする項目である** ——
 *   **`Q-G22` の壁が**結合の向こう側**にも当たることを (11) が実測する。**
 */
function tables(): Any[] {
  return [
    {
      id: "product",
      name: "商品",
      fields: [
        { id: "name", name: "名前", type: "text", required: true },
        { id: "memo", name: "備考", type: "long_text" },
        { id: "price", name: "価格", type: "number" },
        { id: "category", name: "区分", type: "select", options: ["A", "B", "C"] },
        { id: "released_at", name: "発売日", type: "date" },
        { id: "active", name: "販売中", type: "boolean" },
        { id: "photo", name: "写真", type: "image" },
        { id: "doc", name: "資料", type: "file" },
      ],
    },
    {
      id: "line_item",
      name: "明細",
      fields: [
        { id: "order", name: "注文", type: "reference", reference_table: "order" },
        { id: "product", name: "商品", type: "reference", reference_table: "product" },
        { id: "amount", name: "金額", type: "number" },
        { id: "secret_cost", name: "原価", type: "number" },
      ],
    },
    {
      id: "order",
      name: "注文",
      fields: [
        { id: "method", name: "決済方法", type: "select", options: ["card", "cash"] },
        { id: "customer", name: "顧客", type: "reference", reference_table: "customer" },
        // **`product` への2本目の参照** —— **これが在るので「環になる結合」を実際に書ける**
        // (`order` → `product` と `product` → `line_item` → `order` が閉じる)。
        // **(5) が「閉路」を、実在しない表や同じ表の2度書きに頼らずに打てるのは、この列のためである。**
        { id: "main_product", name: "主力商品", type: "reference", reference_table: "product" },
        { id: "placed_at", name: "注文日", type: "date" },
      ],
    },
    {
      id: "customer",
      name: "顧客",
      fields: [
        { id: "name", name: "名前", type: "text", required: true },
        { id: "region", name: "地域", type: "reference", reference_table: "region" },
      ],
    },
    {
      id: "region",
      name: "地域",
      fields: [
        { id: "name", name: "名前", type: "text", required: true },
        { id: "area", name: "方面", type: "select", options: ["north", "south"] },
        { id: "country", name: "国", type: "reference", reference_table: "country" },
      ],
    },
    {
      id: "country",
      name: "国",
      fields: [
        { id: "name", name: "名前", type: "text", required: true },
        { id: "zone", name: "圏", type: "select", options: ["east", "west"] },
      ],
    },
    /*
     * **【`V8-M9` / `D-V8-126` が足した7表目】** **予約規約フィールド4本を実際に宣言した表。**
     *
     * **4本のうち3本(`st_public` / `st_undeletable` / `st_no_direct_create`)は `boolean` で
     * あり、着手前は束ねるキーに**書けていた**** —— **(26) がその3本を含む6本を1つずつ
     * 拒否させるには、実際に宣言された表が要る**(宣言していない表で打つと「存在しません」で
     * 落ち、予約名として拒否されたのか実在しないから拒否されたのかを区別できない)。
     * **どの結合の鎖にも入っていない** —— **既存 (1)〜(23) の題材を1バイトも動かさないため。**
     */
    {
      id: "probe",
      name: "予約名の的",
      fields: [
        { id: "kind", name: "区分", type: "select", options: ["x", "y"] },
        { id: "st_owner", name: "持ち主", type: "text" },
        { id: "st_public", name: "公開", type: "boolean" },
        { id: "st_undeletable", name: "削除不可", type: "boolean" },
        { id: "st_no_direct_create", name: "直接作成の遮断", type: "boolean" },
      ],
    },
  ];
}

/**
 * **既定3役割 + `line_item.secret_cost` を名指しする規則。**
 *
 * **`can` に `write` も入れているのは `V8-M8` の題材と同じ理由である** ——
 * **名指しした時点でその項目は全動詞が allow-list になるので、`read` だけ書くと
 * owner ですら書き込めなくなる。**
 */
function roles(): Any[] {
  return [
    {
      id: "owner",
      name: "持ち主",
      rules: [
        { target: "field", table: "line_item", field: "secret_cost", can: ["read", "write"] },
      ],
    },
    { id: "editor", name: "編集者" },
    { id: "viewer", name: "閲覧者" },
  ];
}

function manifestOf(views: Any[], options?: { skipTables?: string[] }): Manifest {
  return withDefaultRoleRules(
    {
      app: { id: APP_ID, name: "集計表の結合", tables: tables(), views, roles: roles() },
    },
    options?.skipTables === undefined ? undefined : { skipTables: options.skipTables },
  ) as unknown as Manifest;
}

/**
 * **`V8-M9` の題材の全画面。** **1つの適用に全部載せる**(`V8-M8` の `allViews` と同じ作法)。
 *
 * **`applyManifest` はマニフェストを直接渡す経路でビューの削除を表現できないので、
 * 試す画面は必ずこの一覧の**前**に置く** —— **試す画面の JSON Pointer は `/app/views/0`。**
 */
function allViews(): Any[] {
  return [
    { id: "product-list", type: "list_view", table: "product", columns: ["name", "category"] },
    // (13) 順方向1本(子 → 親。行数が増えない)。
    {
      id: "fwd",
      type: "report_view",
      table: "line_item",
      report: {
        join: [{ table: "line_item", via: "order" }],
        group_by: [{ table: "order", field: "method" }],
        aggregates: [{ type: "sum", field: "amount" }, { type: "count" }],
      },
    },
    // (14) 逆方向1本(親 → 子。売れていない親が 0 で並ぶ)。
    {
      id: "rev",
      type: "report_view",
      table: "product",
      report: {
        join: [{ table: "line_item", via: "product" }],
        group_by: [{ field: "category" }],
        aggregates: [
          { type: "sum", table: "line_item", field: "amount" },
          { type: "count", table: "line_item" },
        ],
      },
    },
    // (15) 3表(`D-V8-1` の3例目「商品ごとの決済方法別売上集計」の形)。
    {
      id: "three",
      type: "report_view",
      table: "product",
      report: {
        join: [
          { table: "line_item", via: "product" },
          { table: "line_item", via: "order" },
        ],
        group_by: [{ field: "category" }, { table: "order", field: "method" }],
        aggregates: [{ type: "sum", table: "line_item", field: "amount" }],
      },
    },
    // (16) 段数3ちょうどの鎖(起点 = 明細。注文 → 顧客 → 地域)。
    {
      id: "depth3",
      type: "report_view",
      table: "line_item",
      report: {
        join: [
          { table: "line_item", via: "order" },
          { table: "order", via: "customer" },
          { table: "customer", via: "region" },
        ],
        group_by: [{ table: "region", field: "area" }],
        aggregates: [{ type: "count" }],
      },
    },
    // (17) `table` を省略した宣言(= 起点の表)。
    {
      id: "omit",
      type: "report_view",
      table: "product",
      report: {
        join: [{ table: "line_item", via: "product" }],
        group_by: [{ field: "category" }],
        aggregates: [{ type: "count" }],
      },
    },
    // (17) その明示版(応答が1バイトも変わらないことの対照)。
    {
      id: "explicit",
      type: "report_view",
      table: "product",
      report: {
        join: [{ table: "line_item", via: "product" }],
        group_by: [{ table: "product", field: "category" }],
        aggregates: [{ type: "count", table: "product" }],
      },
    },
    /*
     * --- **`D-V8-126`(行そのもので束ねる)の題材3枚** ------------------------------
     */
    // (24) **`D-V8-1` の3例目が、商品を1件ずつ並べる形で通る。**
    //      起点 = 商品 / 逆方向1本(明細)/ 順方向1本(注文)/ 束ねるキー2本(商品の
    //      `_id` と 注文の決済方法)/ 集計は合計。
    {
      id: "by-row",
      type: "report_view",
      table: "product",
      report: {
        join: [
          { table: "line_item", via: "product" },
          { table: "line_item", via: "order" },
        ],
        group_by: [{ field: "_id" }, { table: "order", field: "method" }],
        aggregates: [{ type: "sum", table: "line_item", field: "amount" }],
      },
    },
    // (25) **群の数が起点の表の行数と等しくなる**(`D-V8-126` が承知した代償)。
    //      **結合を1つも書いていない** —— **行そのもので束ねることは結合と独立である。**
    {
      id: "row-only",
      type: "report_view",
      table: "product",
      report: {
        group_by: [{ field: "_id" }],
        aggregates: [{ type: "count" }],
      },
    },
    // (29) **結合先の表の `_id` も書ける。**
    {
      id: "joined-row",
      type: "report_view",
      table: "line_item",
      report: {
        join: [{ table: "line_item", via: "order" }],
        group_by: [{ table: "order", field: "_id" }],
        aggregates: [{ type: "sum", field: "amount" }],
      },
    },
  ];
}

/** 試す画面を先頭に置いた題材。 */
function withViews(extra: Any[], options?: { skipTables?: string[] }): Manifest {
  return manifestOf([...extra, ...allViews()], options);
}

/** 結合だけを差し替えた集計表を1枚足す(束ねるキーと集計は素直な形に固定)。 */
function withJoin(join: unknown, overrides: Any = {}, view: Any = {}): Manifest {
  return withViews([
    {
      id: "j1",
      type: "report_view",
      table: "product",
      report: {
        join,
        group_by: [{ field: "category" }],
        aggregates: [{ type: "count" }],
        ...overrides,
      },
      ...view,
    },
  ]);
}

function rejected(manifest: Manifest): { path: string; message: string }[] {
  const result = applyManifest(dataRoot, APP_ID, manifest);
  expect(result.valid).toBe(false);
  return (result as { errors: { path: string; message: string }[] }).errors;
}

function accepted(manifest: Manifest): void {
  const result = applyManifest(dataRoot, APP_ID, manifest);
  expect(
    result.valid,
    result.valid ? "" : JSON.stringify((result as { errors: unknown }).errors),
  ).toBe(true);
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  dataRoot = await mkdtemp(joinPath(tmpdir(), "gp-report-join-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "集計表の結合", { app_id: APP_ID });
  } finally {
    store.close();
  }
  accepted(manifestOf(allViews()));
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function req(cookie: string | undefined, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { origin: TEST_ORIGIN };
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

function owner(username: string): string {
  return seedSession(dataRoot, APP_ID, { role: "owner", username }).cookie;
}

/** 行を1件作り、**その `_id` を返す**(参照項目に入れる値がこれである)。 */
async function create(cookie: string, table: string, body: Any): Promise<string> {
  const res = await req(cookie, "POST", `/api/apps/${APP_ID}/tables/${table}/records`, body);
  expect(res.status, JSON.stringify(body)).toBe(201);
  // **応答の形は `{ record: … }` である**(`_id` は素の直下には無い。2026-08-14 実測)。
  const created = (await res.json()) as { record: { _id: string } };
  expect(typeof created.record._id, JSON.stringify(body)).toBe("string");
  return created.record._id;
}

type ReportKey = { field: string; value: string | number | boolean | null };
type ReportAggregate = { type: string; field?: string; value: number };
type ReportBody = {
  groups: { keys: ReportKey[]; aggregates: ReportAggregate[] }[];
  total_groups: number;
  totals: ReportAggregate[];
};

async function readReport(
  cookie: string | undefined,
  viewId: string,
): Promise<{ status: number; body: ReportBody }> {
  const res = await req(cookie, "GET", `/api/apps/${APP_ID}/views/${viewId}/report`);
  return { status: res.status, body: (await res.json()) as ReportBody };
}

/** 群を「キーの値の並び → 集計値の並び」の素朴な形へ潰す(期待値を読めるようにする)。 */
function shape(body: ReportBody): [(string | number | boolean | null)[], number[]][] {
  return body.groups.map((group) => [
    group.keys.map((key) => key.value),
    group.aggregates.map((aggregate) => aggregate.value),
  ]);
}

// =====================================================================================
// (A) 適用時の拒否(`src/kernel/referential-integrity.ts` の類型18)
// =====================================================================================

test("(1) 突き合わせに実在しないフィールドを指したら、本物の SQLite で拒否される", () => {
  const errors = rejected(withJoin([{ table: "line_item", via: "nope" }]));
  expect(errors.some((error) => error.path === "/app/views/0/report/join/0/via")).toBe(true);
  expect(errors.some((error) => error.message.includes("存在しません"))).toBe(true);
});

test("(2) 突き合わせに reference 型でないフィールドを指したら拒否される(8型すべてを別々に打つ)", () => {
  // **8種を別々に打つ** —— まとめて1回だけ打つと、どれか1つが通っていても気づけない。
  for (const fieldId of [
    "name", // text
    "memo", // long_text
    "price", // number
    "category", // select
    "released_at", // date
    "active", // boolean
    "photo", // image
    "doc", // file
  ]) {
    const errors = rejected(withJoin([{ table: "product", via: fieldId }]));
    expect(
      errors.some((error) => error.path === "/app/views/0/report/join/0/via"),
      fieldId,
    ).toBe(true);
    expect(
      errors.some((error) => error.message.includes("reference")),
      fieldId,
    ).toBe(true);
  }
});

test("(3) 実在しない表を結合したら拒否される", () => {
  const errors = rejected(withJoin([{ table: "nope", via: "product" }]));
  expect(errors.some((error) => error.path === "/app/views/0/report/join/0/table")).toBe(true);
  expect(errors.some((error) => error.message.includes("存在しません"))).toBe(true);
});

test("(4) どちらの表も結合に入っていない結合(孤立)は拒否される", () => {
  // 起点は `product`。`customer.region` は `customer` も `region` も結合に入っていない。
  const errors = rejected(withJoin([{ table: "customer", via: "region" }]));
  expect(errors.some((error) => error.path === "/app/views/0/report/join/0")).toBe(true);
  expect(errors.some((error) => error.message.includes("どちらもまだ結合に入っていません"))).toBe(
    true,
  );
});

test("(5) 両方すでに結合に入っている結合(閉路)は拒否される", () => {
  // 起点 `product` → 明細(逆)→ 注文(順)まで通り、**注文 → 商品 で環になる。**
  const errors = rejected(
    withJoin([
      { table: "line_item", via: "product" },
      { table: "line_item", via: "order" },
      { table: "order", via: "main_product" },
    ]),
  );
  expect(errors.some((error) => error.path === "/app/views/0/report/join/2")).toBe(true);
  expect(errors.some((error) => error.message.includes("どちらもすでに結合に入っています"))).toBe(
    true,
  );
});

test("(6) 同じ表を2回結合したら拒否される(どちらを足すのかが決まらない)", () => {
  const errors = rejected(
    withJoin([
      { table: "line_item", via: "product" },
      { table: "line_item", via: "product" },
    ]),
  );
  expect(errors.some((error) => error.path === "/app/views/0/report/join/1")).toBe(true);
  expect(errors.some((error) => error.message.includes("2度結合"))).toBe(true);
});

test("(7) 結合する表が起点を含めて5本を超えたら拒否される(裁定 M7-1。maxItems: 4)", () => {
  // **5本目の結合**(= 表6本目)。**止めているのはスキーマの `maxItems: 4` である。**
  const errors = rejected(
    withJoin([
      { table: "line_item", via: "product" },
      { table: "line_item", via: "order" },
      { table: "order", via: "customer" },
      { table: "customer", via: "region" },
      { table: "region", via: "country" },
    ]),
  );
  expect(errors.length).toBeGreaterThan(0);
});

test("(8) 段数(参照の鎖を辿る回数)が3を超えたら拒否される(裁定 M7-1)", () => {
  // 起点 `line_item`(深さ0)→ order(1) → customer(2) → region(3) → country(**4**)。
  // **表は起点を含めて5本ちょうどなので、本数の上限には当たらない** —— 止めるのは段数だけ。
  const errors = rejected(
    withJoin(
      [
        { table: "line_item", via: "order" },
        { table: "order", via: "customer" },
        { table: "customer", via: "region" },
        { table: "region", via: "country" },
      ],
      { group_by: [{ table: "order", field: "method" }] },
      { table: "line_item" },
    ),
  );
  expect(errors.some((error) => error.path === "/app/views/0/report/join/3")).toBe(true);
  expect(errors.some((error) => error.message.includes("段"))).toBe(true);
});

test("(9) 一対多(逆方向)の結合が2本以上あったら拒否される(合計が掛け算で重複するのを止める形が無いため)", () => {
  // 起点 `order` に対し、`line_item`(逆)と `payment` …は無いので、
  // `line_item` の逆方向のあとに `order` を親とする2本目の逆方向を作る:
  // 起点 `customer` → order(逆)→ line_item(逆)。
  const errors = rejected(
    withJoin(
      [
        { table: "order", via: "customer" },
        { table: "line_item", via: "order" },
      ],
      { group_by: [{ table: "order", field: "method" }] },
      { table: "customer" },
    ),
  );
  expect(errors.some((error) => error.path === "/app/views/0/report/join/1")).toBe(true);
  expect(errors.some((error) => error.message.includes("1本まで"))).toBe(true);
});

test("(10) 束ねるキー・集計列が、結合に入っていない表を指したら拒否される", () => {
  const groupErrors = rejected(
    withJoin([{ table: "line_item", via: "product" }], {
      group_by: [{ table: "country", field: "zone" }],
    }),
  );
  expect(groupErrors.some((error) => error.path === "/app/views/0/report/group_by/0/table")).toBe(
    true,
  );
  const aggregateErrors = rejected(
    withJoin([{ table: "line_item", via: "product" }], {
      aggregates: [{ type: "sum", table: "order", field: "amount" }],
    }),
  );
  expect(
    aggregateErrors.some((error) => error.path === "/app/views/0/report/aggregates/0/table"),
  ).toBe(true);
});

test("(11) 役割の規則が名指しした項目は、結合の向こう側の表でも束ねる・集計する対象にできない(Q-G22)", () => {
  const errors = rejected(
    withJoin([{ table: "line_item", via: "product" }], {
      aggregates: [{ type: "sum", table: "line_item", field: "secret_cost" }],
    }),
  );
  expect(errors.some((error) => error.message.includes("役割の規則が名指ししている項目"))).toBe(
    true,
  );
});

test("(12) 拒否は全か無かである(通る集計表が同じ差分に在っても、1つも適用されない)", () => {
  const result = applyManifest(
    dataRoot,
    APP_ID,
    manifestOf([
      ...allViews(),
      {
        id: "ok-2",
        type: "report_view",
        table: "product",
        report: {
          join: [{ table: "line_item", via: "product" }],
          group_by: [{ field: "category" }],
          aggregates: [{ type: "count" }],
        },
      },
      {
        id: "broken",
        type: "report_view",
        table: "product",
        report: {
          join: [{ table: "customer", via: "region" }],
          group_by: [{ field: "category" }],
          aggregates: [{ type: "count" }],
        },
      },
    ]),
  );
  expect(result.valid).toBe(false);
  const manifest = JSON.parse(
    readFileSync(joinPath(dataRoot, "apps", APP_ID, "manifest.json"), "utf-8"),
  ) as { app: { views: { id: string }[] } };
  expect(manifest.app.views.some((view) => view.id === "ok-2")).toBe(false);
  expect(manifest.app.views.some((view) => view.id === "fwd")).toBe(true);
});

// =====================================================================================
// (B) 結合した集計の応答(本物の HTTP)
// =====================================================================================

/** 題材の行を1組入れる(**戻り値は各行の `_id`**)。 */
async function seedRows(cookie: string) {
  const country = await create(cookie, "country", { name: "国1", zone: "east" });
  const region = await create(cookie, "region", { name: "地域1", area: "north", country });
  const customer = await create(cookie, "customer", { name: "客1", region });
  const o1 = await create(cookie, "order", { method: "card", customer });
  const o2 = await create(cookie, "order", { method: "cash", customer });
  const p1 = await create(cookie, "product", { name: "商品1", category: "A", price: 100 });
  const p2 = await create(cookie, "product", { name: "商品2", category: "A", price: 200 });
  const p3 = await create(cookie, "product", { name: "商品3", category: "C", price: 300 });
  await create(cookie, "line_item", { order: o1, product: p1, amount: 100 });
  await create(cookie, "line_item", { order: o2, product: p1, amount: 50 });
  await create(cookie, "line_item", { order: o1, product: p2, amount: 200 });
  return { o1, o2, p1, p2, p3, region, customer };
}

test("(13) 2表を結合した集計が API から出る(順方向。子 → 親。行数が増えない)", async () => {
  const cookie = owner("c13");
  await seedRows(cookie);
  // **参照先が無い明細**(注文を書いていない)—— **群から落ちず、キーが `null` の群に入る。**
  await create(cookie, "line_item", { amount: 7 });
  const { status, body } = await readReport(cookie, "fwd");
  expect(status).toBe(200);
  expect(shape(body)).toEqual([
    [["card"], [300, 2]],
    [["cash"], [50, 1]],
    [[null], [7, 1]],
  ]);
  // **全体の合計は母集団そのものを1度数えたものである**(`D-V8-122`)。
  expect(body.totals).toEqual([
    { type: "sum", field: "amount", value: 357 },
    { type: "count", value: 4 },
  ]);
});

test("(14) 2表を結合した集計が API から出る(逆方向。売れていない商品が 0 で並ぶ。Q-G9 / D-V8-120)", async () => {
  const cookie = owner("c14");
  await seedRows(cookie);
  const { status, body } = await readReport(cookie, "rev");
  expect(status).toBe(200);
  // **区分 C の商品(商品3)は明細を1件も持たない** —— **それでも群に残り、合計も件数も 0 である。**
  expect(shape(body)).toEqual([
    [["A"], [350, 3]],
    [["C"], [0, 0]],
  ]);
  expect(body.total_groups).toBe(2);
});

test("(15) 3表を結合した集計が API から出る(D-V8-1 の3例目の形。束ねるキーが2本)", async () => {
  const cookie = owner("c15");
  await seedRows(cookie);
  const { status, body } = await readReport(cookie, "three");
  expect(status).toBe(200);
  // 起点 = 商品 / 逆方向1本(明細)/ 順方向1本(注文)。
  expect(shape(body)).toEqual([
    [["A", "card"], [300]],
    [["A", "cash"], [50]],
    [["C", null], [0]],
  ]);
});

test("(16) 段数3の鎖が通る(明細 → 注文 → 顧客 → 地域)", async () => {
  const cookie = owner("c16");
  await seedRows(cookie);
  await create(cookie, "line_item", { amount: 7 });
  const { status, body } = await readReport(cookie, "depth3");
  expect(status).toBe(200);
  expect(shape(body)).toEqual([
    [["north"], [3]],
    [[null], [1]],
  ]);
});

test("(17) group_by[].table / aggregates[].table を省略すると起点の表を指す(一対多では起点の行が子の数だけ数えられる)", async () => {
  const cookie = owner("c17");
  await seedRows(cookie);
  const omitted = await readReport(cookie, "omit");
  const explicit = await readReport(cookie, "explicit");
  expect(omitted.body).toEqual(explicit.body);
  // **【正直に書く】商品1は明細を2件持つので、区分 A は 3 と数えられる**(商品は2件しかない)。
  // **これが「一対多の結合が入ると起点の行が重複して数えられる」ことの実測である。**
  // **【禁止】これを「重複しない」と書かない。**
  expect(shape(omitted.body)).toEqual([
    [["A"], [3]],
    [["C"], [1]],
  ]);
});

// =====================================================================================
// (C) 白箱
// =====================================================================================

test("(18) V8-M8 が置いた「結合を1つもしていない」の白箱検査を、反転させる(旧テスト名と旧の期待の逐語を残す)", async () => {
  /*
   * **旧の逐語**(`src/server/report-declaration-boundary.test.ts` の (26) の中。
   * `V8-M8-T07` 完了条件8 が置いたもの):
   *
   * ```
   * for (const forbidden of ["GROUP BY", "strftime", "JOIN", "SELECT "]) {
   *   expect(code.filter((line) => line.includes(forbidden)), forbidden).toEqual([]);
   * }
   * ```
   *
   * **旧のテスト名の逐語**: 「(26) 集計表の絞り込みは既存の compileFilter を通る
   * (src/kernel/ に2本目のフィルタコンパイラが無い)」。**その test は消していない。**
   *
   * **反転させるのは「結合を1つもしていない」の側だけである** ——
   * **`GROUP BY` / `strftime` / `SELECT ` の3語は今日も1行も無い**(下で測る)。
   * **`JOIN`(SQL の結合)も1文字も無い** —— **結合は SQL ではなくメモリ上で行うからである。**
   * **増えたのは「メモリ上で結合している」ことの側である。**
   */
  const source = await Bun.file(new URL("../kernel/report.ts", import.meta.url)).text();
  const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  // **SQL は今日も1文字も書いていない。**
  for (const forbidden of ["GROUP BY", "strftime", "JOIN", "SELECT "]) {
    expect(
      code.filter((line) => line.includes(forbidden)),
      forbidden,
    ).toEqual([]);
  }
  // **結合はメモリ上で行っている** —— **`V8-M8` の「母集団は1つの表だけである」は今日は偽。**
  expect(code.filter((line) => line.includes("report.join")).length).toBeGreaterThan(0);
  // **行の読み出しは今日も既存のファサード1本だけである**(`readRecordList` を呼ぶ行は1本)。
  expect(code.filter((line) => /readRecordList\(/.test(line))).toHaveLength(1);
});

test("(19) 白箱: プランナを持たない(結合の評価順は宣言順であり、辿る順を選ぶコードが1行も無い)", async () => {
  const source = await Bun.file(new URL("../kernel/report.ts", import.meta.url)).text();
  const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  // **並べ替えは群の並び1箇所だけである** —— **結合の順序を並べ替える `.sort(` が無い。**
  expect(code.filter((line) => line.includes(".sort("))).toHaveLength(1);
  // **「どの順で辿ると速いか」を選ぶ語彙が製品コードに1つも無い。**
  for (const word of ["estimate", "cardinality", "plan", "cost", "reorder", "heuristic"]) {
    expect(
      code.filter((line) => line.toLowerCase().includes(word)),
      word,
    ).toEqual([]);
  }
  /*
   * **振る舞いでも示す** —— **同じ2本の結合を、順序だけ入れ替えて書くと、
   * 一方は通り、もう一方は「孤立」で拒否される。**
   * **評価順が宣言順でなければ(= プランナが辿る順を選ぶなら)、どちらも通るはずである。**
   */
  accepted(
    withJoin(
      [
        { table: "line_item", via: "order" },
        { table: "order", via: "customer" },
      ],
      { group_by: [{ table: "order", field: "method" }] },
      { table: "line_item" },
    ),
  );
  const errors = rejected(
    withJoin(
      [
        { table: "order", via: "customer" },
        { table: "line_item", via: "order" },
      ],
      { group_by: [{ table: "order", field: "method" }] },
      { table: "line_item" },
    ),
  );
  expect(errors.some((error) => error.message.includes("どちらもまだ結合に入っていません"))).toBe(
    true,
  );
});

test("(20) 白箱: 射影(select)も計算式も1つも足していない(結合に書けるのは table と via の2キーちょうど)", () => {
  const schema = JSON.parse(
    readFileSync(new URL("../../schemas/manifest.schema.json", import.meta.url), "utf-8"),
  ) as { $defs: { report: { properties: Any; required: string[] } } };
  // **`$defs/report` に書けるキーは4本ちょうど**(`having` も並べ替えも今日も無い)。
  /*
   * **【2026-08-15。`V8-M11-T02`。台帳 `Q-G21a` / `Q-G12`。門A 本審査 = `V8-M7`。
   * 判定 = 限定採用。ユーザ決定 `D-V8-130`】期待値に `sort` を足した。**
   *
   * **旧行の逐語**:
   * `  expect(Object.keys(schema.$defs.report.properties)).toEqual([`
   * `    "join",`
   * `    "group_by",`
   * `    "aggregates",`
   * `    "filter",`
   * `  ]);`
   *
   * **【すぐ上の1行の注釈を1バイトも書き換えていない。ただし今日は偽である】** ——
   * **書けるキーは5本ちょうどであり、「並べ替えも今日も無い」は今日は成り立たない。**
   * **`having`(集計値で群を落とす)が1つも無いことだけは今日も真であり、
   * それは下の `'"having"'` を含む6語の検査が別に測っている。**
   *
   * **【この test が本来固定している主張は1ミリも弱めていない】** ——
   * **本題は「結合に射影(`select`)も計算式も足していない」ことであり、下の3本
   * (`join.items` のキーが `table` / `via` の2本ちょうど・両方必須・
   * `additionalProperties: false`)がそれを測っている。** **`sort` は結合の中に1バイトも
   * 入っておらず、`join` の値域は着手前と1バイトも同じである。**
   *
   * **【2026-08-15。`V8-M12-T02`。台帳 `Q-G23`(集計の数字を棒グラフと折れ線グラフで
   * 見たい)。門A 本審査 = `V8-M7`。判定 = 限定採用。ユーザ決定 `D-V8-131`】
   * 期待値に `chart`(グラフ種別)を足した。**
   * **旧行の逐語**: `    "sort",` の直後に `  ]);` が続いていた(**5本ちょうど**)。
   * **【上の注釈を1バイトも書き換えていない。ただし次の逐語は今日は偽である】** ——
   * **「書けるキーは5本ちょうどであり」は今日は 6本である。**
   * **`having` が1つも無いことは今日も真であり、下の `'"having"'` を含む6語の検査が
   * 別に測っている。**
   * **【この test が本来固定している主張も、やはり1ミリも弱めていない】** ——
   * **`chart` は結合の中に1バイトも入っておらず、`join` の値域は着手前と1バイトも
   * 同じである**(**下の3本がそれを測っている**)。
   */
  expect(Object.keys(schema.$defs.report.properties)).toEqual([
    "join",
    "group_by",
    "aggregates",
    "filter",
    "sort",
    "chart",
  ]);
  expect(schema.$defs.report.required).toEqual(["group_by", "aggregates"]);
  const joinDef = schema.$defs.report.properties.join as {
    maxItems: number;
    items: { properties: Any; required: string[]; additionalProperties: boolean };
  };
  // **1本の結合に書けるのは `table` と `via` の2キーちょうどで、両方とも必須である。**
  expect(Object.keys(joinDef.items.properties)).toEqual(["table", "via"]);
  expect(joinDef.items.required).toEqual(["table", "via"]);
  expect(joinDef.items.additionalProperties).toBe(false);
  // **起点を含めて5表** = 結合の要素は4本まで(裁定 `M7-1`)。
  expect(joinDef.maxItems).toBe(4);
  // **結合の条件を書く場所も、射影も、計算式も1語も無い。**
  const text = JSON.stringify(schema.$defs.report);
  for (const forbidden of ['"on"', '"select"', '"where"', '"having"', '"expr"', '"formula"']) {
    expect(text.includes(forbidden), forbidden).toBe(false);
  }
});

test("(21) 白箱: 既存5経路(related / reference のラベル / update_record.target / function.input / via)の辿り方を1バイトも引き直していない(`related_list` は名札 `id` が1本増えた)", async () => {
  const schema = JSON.parse(
    readFileSync(new URL("../../schemas/manifest.schema.json", import.meta.url), "utf-8"),
  ) as { $defs: Record<string, Any> };
  /** 定義を1本引く(**在らなければ空にせず落とす** —— 名前を間違えたまま緑にしない)。 */
  const def = (name: string): Any => {
    const found = schema.$defs[name];
    expect(found, name).toBeDefined();
    return found as Any;
  };

  // --- (a) `related` —— **振る舞いで示す。** 孫を辿る `related` は今日も拒否される。
  const twoHop = manifestOf([
    {
      id: "detail",
      type: "detail_view",
      table: "product",
      related: [{ table: "line_item", via: "order", columns: ["amount"] }],
    },
    ...allViews(),
  ]);
  // `line_item.order` は `order` を参照しており、この detail_view の対象表(`product`)ではない。
  expect(
    rejected(twoHop).some((error) => error.path === "/app/views/0/related/0/via"),
    "related",
  ).toBe(true);

  // --- (b) `reference` のラベル解決 —— **振る舞いで示す。** 参照列は今日も素のIDのままで返る。
  const cookie = owner("c21");
  const { p1 } = await seedRows(cookie);
  const listed = await req(cookie, "GET", `/api/apps/${APP_ID}/tables/line_item/records`);
  const rows = ((await listed.json()) as { records: Any[] }).records;
  const sample = rows.find((row) => row.product === p1) as Any;
  expect(typeof sample.product).toBe("string");
  // **参照先の行が展開されて入っていない**(`product` の中身は1バイトも混ざらない)。
  expect(Object.keys(sample)).not.toContain("name");

  /*
   * --- (c) (d) (e) —— **【示していないことを書く】** **この3つは振る舞いではなく
   * スキーマの構造で示している。** **「今日も1ホップである」ことを `API` の応答から
   * 示すには、ワークフローを発火させる題材と島の実行が要り、本ファイルの範囲を超える。**
   * **したがって本検査が示すのは「値域が1バイトも動いていない」までである。**
   */
  // (c) `update_record.target` —— 値域は今日も `$defs/action_value` を共有しており、
  //     その pattern は**単一トークンだけ**を許す(多段 `$record.a.b` を今日も書けない)。
  expect(((def("workflow_action").properties as Any).target as Any).$ref).toBe(
    "#/$defs/action_value",
  );
  const singleToken = new RegExp((def("action_value").then as Any).pattern as string);
  expect(singleToken.test("$record.customer")).toBe(true);
  expect(singleToken.test("$record.order.customer")).toBe(false);
  // (d) `function.input` —— 禁止7語が1語も現れない。
  const inputText = JSON.stringify(def("function_input"));
  for (const forbidden of ['"where"', '"filter"', '"select"', '"count"', '"group_by"', '"on"']) {
    expect(inputText.includes(forbidden), forbidden).toBe(false);
  }
  // (e) `via` —— **辿り方(1ホップ・単一の reference)は2箇所とも今日も同じ。**
  // **【`V10-M24-T01` / `CM-G22` / `ADR-0371` 限定1。上の一文「キーの集合が今日も同じ」は
  // `related_list` については今日は偽である】** **`related_list.items.properties` に名札(`id`)が
  // 1本増えて 5 → 6 になった。** **増えたのは名札1本だけで、`via` の意味論も段数も1バイトも
  // 動いていない**(`required` は `["table","via","columns"]` のまま・`additionalProperties: false`
  // も解いていない)。**`function_input` の側は1バイトも動いていない(4キーのまま)。**
  expect(Object.keys((def("related_list").items as Any).properties as Any)).toEqual([
    "id",
    "table",
    "via",
    "columns",
    "sort",
    "name",
  ]);
  expect(Object.keys(def("function_input").properties as Any)).toEqual([
    "source",
    "table",
    "view",
    "via",
  ]);
});

// =====================================================================================
// (D) **行そのもので束ねる**(`D-V8-126`。`V8-M9` の実装が見つけた穴)
//
// **なぜ本ファイルに足すのか**(新しいファイルを作らなかった理由。**両方あり得る**):
//
//  1. **必須の1件目(`D-V8-1` の3例目が「商品を1件ずつ」の形で通ること)は、
//     起点 = 商品 / 逆方向1本(明細)/ 順方向1本(注文)という**結合そのもの**の題材を
//     要求する。** **本ファイルの6表の題材・`seedRows`・`readReport` / `shape` を
//     そのまま使えるのに対し、新しいファイルへ移すとその約350行を写すことになる**
//     (写した題材は必ず片方だけが古くなる)。
//  2. **拒否の各件は「適用時の拒否」であり、(1)〜(12) と同じ群に属する。**
//
// **代償**: **本ファイルの名前(`report-join-boundary`)は、束ねるキーの予約名という
// 結合ではない主題を含まなくなる。** **ファイル名は変えていない**(変えると
// `V8-M8` / `V8-M9` の記録と ADR が名指ししている経路が切れる)。
// =====================================================================================

test("(24) D-V8-1 の3例目が「商品を1件ずつ」の形で通る(起点=商品 / 逆1本 / 順1本 / 束ね2本。売れていない商品が 0 で並ぶ)", async () => {
  const cookie = owner("c24");
  const { o1, o2, p1, p2, p3 } = await seedRows(cookie);
  const { status, body } = await readReport(cookie, "by-row");
  expect(status).toBe(200);

  // **群のキーの1本目は商品の行の番号そのもの(文字列)である。**
  expect(body.groups.every((group) => group.keys[0]?.field === "_id")).toBe(true);
  // **並び順は行の番号(UUID)の昇順なので、期待値を位置で書かない。**
  const byKey = new Map(
    body.groups.map((group) => [
      JSON.stringify(group.keys.map((key) => key.value)),
      group.aggregates.map((aggregate) => aggregate.value),
    ]),
  );
  expect(byKey.get(JSON.stringify([p1, "card"]))).toEqual([100]);
  expect(byKey.get(JSON.stringify([p1, "cash"]))).toEqual([50]);
  expect(byKey.get(JSON.stringify([p2, "card"]))).toEqual([200]);
  // **商品3は明細を1件も持たない** —— **それでも群に残り、合計は 0 である**
  // (`D-V8-120`。**これが「売れていない商品が 0 で並ぶ」の実体**)。
  expect(byKey.get(JSON.stringify([p3, null]))).toEqual([0]);
  expect(body.total_groups).toBe(4);
  // **注文の行そのものは群のキーに出ていない**(2本目のキーは決済方法である)。
  expect(body.groups.every((group) => group.keys[1]?.field === "method")).toBe(true);
  expect([o1, o2].every((id) => typeof id === "string")).toBe(true);
});

test("(25) 群の数が起点の表の行数と等しくなる(D-V8-126 が承知した代償。上限 10,000 に当たるのは V8-M10)", async () => {
  const cookie = owner("c25");
  await seedRows(cookie);
  // **商品をもう2件足す**(行数と群の数が一緒に動くことを示す)。
  await create(cookie, "product", { name: "商品4", category: "B" });
  await create(cookie, "product", { name: "商品5", category: "B" });
  const listed = await req(cookie, "GET", `/api/apps/${APP_ID}/tables/product/records`);
  const rows = ((await listed.json()) as { records: Any[] }).records;
  const { status, body } = await readReport(cookie, "row-only");
  expect(status).toBe(200);
  // **群の数 = 起点の表の行数。** **数値リテラルで書かない**(行を足したら両方動く)。
  expect(body.total_groups).toBe(rows.length);
  expect(body.groups).toHaveLength(rows.length);
  // **どの群も件数 1 である**(1行が1群)。
  expect(body.groups.every((group) => group.aggregates[0]?.value === 1)).toBe(true);
  // **【今日の事実。誇張しない】上限は1つも掛かっていない**(掛けるのは `V8-M10`)——
  // **10,001 件目の商品を登録した日に、この集計表は開かなくなる。**
  // **【2026-08-16 訂正(`V8-M13-T04`)。直前の2行を1バイトも書き換えていない】**
  // **直前の「上限は1つも掛かっていない」は今日は偽である** —— **`V8-M10` が掛けた。**
  // **群と読む行の上限は 10,000 で、超えると 400 になる**(`src/server/report-limits.ts`)。
  // **見立てのほう(10,001 件目で開かなくなる)は今日も正である。**
  expect(body.totals).toEqual([{ type: "count", value: rows.length }]);
});

test("(26) _id 以外の予約名は、束ねるキーに1つずつ書けない(システム列2本 + 予約規約フィールド4本)", () => {
  /*
   * **6本を1件ずつ別々に打つ。** **まとめて1回で打つと、どれか1本だけが拒否されても
   * 緑になる。**
   *
   * **止まる場所は2種類ある。隠さない**:
   *  - `_created_at` / `_updated_at` … **スキーマの pattern**(`^(_id|[a-z][a-z0-9_-]*)$`)が
   *    先に止める。**適用時の検査にも同じ名前が載っている**(pattern を緩めた日に穴が
   *    開かないように)。
   *  - `st_owner` / `st_public` / `st_undeletable` / `st_no_direct_create` …
   *    **pattern には当たる。止めるのは適用時の検査(類型18c)だけである。**
   *    **`st_public` / `st_undeletable` / `st_no_direct_create` は `boolean` なので、
   *    着手前は束ねるキーに書けていた** —— **本検査は「今日できなくなったこと」を
   *    固定している。**
   */
  for (const [reserved, expected] of [
    ["_created_at", "識別子の規約に合いません"],
    ["_updated_at", "識別子の規約に合いません"],
    ["st_owner", "は予約された名前です"],
    ["st_public", "は予約された名前です"],
    ["st_undeletable", "は予約された名前です"],
    ["st_no_direct_create", "は予約された名前です"],
  ] as const) {
    const errors = rejected(
      withViews([
        {
          id: "g1",
          type: "report_view",
          table: "probe",
          report: { group_by: [{ field: reserved }], aggregates: [{ type: "count" }] },
        },
      ]),
    );
    expect(
      errors.some(
        (error) =>
          error.path === "/app/views/0/report/group_by/0/field" && error.message.includes(expected),
      ),
      `${reserved} :: ${JSON.stringify(errors)}`,
    ).toBe(true);
  }
  // **`_id` だけが通る**(対照。これが無いと「予約名を全部弾いた」だけでも緑になる)。
  accepted(
    withViews([
      {
        id: "g1",
        type: "report_view",
        table: "probe",
        report: { group_by: [{ field: "_id" }], aggregates: [{ type: "count" }] },
      },
    ]),
  );
});

test("(27) 行そのものと束ね方(granularity)は同時に書けない(_id は日付ではない)", () => {
  const errors = rejected(
    withViews([
      {
        id: "g1",
        type: "report_view",
        table: "product",
        report: {
          group_by: [{ field: "_id", granularity: "month" }],
          aggregates: [{ type: "count" }],
        },
      },
    ]),
  );
  expect(errors.some((error) => error.path === "/app/views/0/report/group_by/0/granularity")).toBe(
    true,
  );
});

test("(28) 書ける場所は group_by[].field だけである(aggregates と filter は1ミリも広がっていない)", () => {
  // **合計の対象にはできない**(`aggregates[].field` は今日も `$defs/resource_id` である)。
  const aggregateErrors = rejected(
    withViews([
      {
        id: "g1",
        type: "report_view",
        table: "product",
        report: {
          group_by: [{ field: "category" }],
          aggregates: [{ type: "sum", field: "_id" }],
        },
      },
    ]),
  );
  expect(aggregateErrors.some((error) => error.path.includes("/report/aggregates/0"))).toBe(true);
  // **絞り込みの中も広がっていない。**
  const filterErrors = rejected(
    withViews([
      {
        id: "g1",
        type: "report_view",
        table: "product",
        report: {
          group_by: [{ field: "category" }],
          aggregates: [{ type: "count" }],
          filter: [{ field: "_id", equals: "x" }],
        },
      },
    ]),
  );
  expect(filterErrors.some((error) => error.path.includes("/report/filter"))).toBe(true);
  // **白箱: スキーマで広げたのは1箇所ちょうどである。**
  const schema = JSON.parse(
    readFileSync(new URL("../../schemas/manifest.schema.json", import.meta.url), "utf-8"),
  ) as { $defs: { report: { properties: Any } } };
  const report = schema.$defs.report.properties;
  const groupByField = ((((report.group_by as Any).items as Any).properties as Any).field ??
    {}) as Any;
  expect(groupByField.pattern).toBe("^(_id|[a-z][a-z0-9_-]*)$");
  expect(groupByField.$ref).toBeUndefined();
  // **合計の側は `$ref` のままである**(1箇所ちょうど、の対照)。
  expect(((((report.aggregates as Any).items as Any).properties as Any).field as Any).$ref).toBe(
    "#/$defs/resource_id",
  );
});

test("(29) 結合先の表の _id も書ける(結合に入っていない表は今日どおり拒否)", async () => {
  const cookie = owner("c29");
  const { o1, o2 } = await seedRows(cookie);
  const { status, body } = await readReport(cookie, "joined-row");
  expect(status).toBe(200);
  const byKey = new Map(
    body.groups.map((group) => [
      String(group.keys[0]?.value),
      group.aggregates.map((aggregate) => aggregate.value),
    ]),
  );
  // 注文1 に 100 と 200、注文2 に 50。
  expect(byKey.get(o1)).toEqual([300]);
  expect(byKey.get(o2)).toEqual([50]);
  // **結合に入っていない表の `_id` は今日どおり拒否される**(予約名でも壁は動いていない)。
  const errors = rejected(
    withJoin([{ table: "line_item", via: "product" }], {
      group_by: [{ table: "country", field: "_id" }],
    }),
  );
  expect(errors.some((error) => error.path === "/app/views/0/report/group_by/0/table")).toBe(true);
});

/*
 * **【`V8-M10-T03`(台帳 `Q-G13`)による反転。旧テスト名を逐語で残す】**
 *
 * **旧テスト名(逐語)**:
 *   `(22) V8-M9 も結合に可視性を1つも掛けていない(この検査は V8-M10 で反転する)`
 * **旧の期待値**: **上と同じ4語(`judgeRoleAccess` / `projectForRoleFields` / `st_owner` /
 *   `st_public`)が `report.ts` に1行も無いこと** —— **`toEqual([])` の4本。**
 *   **期待値そのものは1バイトも変えていない**(下でそのまま数えている)。
 *
 * ## **【白箱はこの形を数えられない。数えているのは振る舞いの側だけである】**
 *
 * **旧テスト名は「可視性を1つも掛けていない」ことを白箱で数えていたが、
 * `v8-m10.md` §1-0c の決定1(判定は `src/kernel/report.ts` の外に置く)を採った以上、
 * 可視性を掛けたあとも4語は `report.ts` に1つも無い。**
 * **つまりこの4本の `toEqual([])` は、可視性が掛かっていても掛かっていなくても緑である。**
 * **【禁止】これを「まだ掛かっていない証拠」とも「掛かっている証拠」とも読まない。**
 *
 * **今日この白箱が数えているのは、決定1 の履行そのものである** ——
 * **判定が `report.ts` の中に**書かれていない**こと。**
 * **可視性が掛かっていることの証拠は振る舞いの側にあり、
 * 起点の表については `src/server/report-visibility.test.ts` の (A)(B)(C)、
 * **結合先の表については今日まだ無い**((23) が「全件読まれる」を今日の事実として
 * 固定し続けている。塞ぐのは `V8-M10-T04` / `Q-G14`)。
 *
 * ## **【`V8-M10-T04`(台帳 `Q-G14`)による2度目の書き直し。上の段落は今日は偽である】**
 *
 * **`T03` が付けたテスト名(逐語)**:
 *   `(22) 判定は report.ts の外に在る(白箱はこの形を数えられない)。結合先は今日も素通しである`
 * **`V8-M9` が付けた元のテスト名(逐語)**:
 *   `(22) V8-M9 も結合に可視性を1つも掛けていない(この検査は V8-M10 で反転する)`
 * **旧の期待値**: **4語(`judgeRoleAccess` / `projectForRoleFields` / `st_owner` / `st_public`)が
 *   `report.ts` に1行も無いこと** —— **`toEqual([])` の4本。**
 *   **`T03` も `T04` も、この4本を1バイトも変えていない**(下でそのまま数えている)。
 *
 * **`T04` で偽になったのは「結合先は今日も素通しである」の側だけである** ——
 * **`app.ts` が表ごとに判定を引き直すようになり、結合先の表も同じ注入を通る。**
 * **`report.ts` は1バイトも変わっていない**(**読取が `readRows` の1本に寄っているので、
 * 起点も結合先も同じ1本を通る**)—— **したがってこの白箱は `T03` の日と `T04` の日を
 * 区別できない。** **区別しているのは振る舞いの側((30)〜(34) と、反転後の (23))である。**
 */
test("(22) 判定は report.ts の外に在る(白箱はこの形を数えられない)。結合先にも同じ1本が当たる", async () => {
  const source = await Bun.file(new URL("../kernel/report.ts", import.meta.url)).text();
  const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  for (const symbol of ["judgeRoleAccess", "projectForRoleFields", "st_owner", "st_public"]) {
    expect(
      code.filter((line) => line.includes(symbol)),
      symbol,
    ).toEqual([]);
  }
  // **【緩めていない。要求を1つ増やした】** —— **`report.ts` が受け取っているのは
  // **注入1つ**(`visibleRows`)だけであり、判定を自分で呼ぶ経路が1本も無いこと。**
  // **`owner-scope` を import する行が1つも無い**(`workflow-runner.ts:76` の先例を採らない)。
  expect(code.filter((line) => line.includes("owner-scope"))).toEqual([]);
  expect(code.filter((line) => line.includes("visibleRows")).length).toBeGreaterThan(0);
  // **【`V8-M10-T04`。要求をもう1つ増やした】** —— **読取が1本に寄っていることが、
  // 「結合先にも同じ注入が当たる」ことの構造的な根拠である。**
  // **`readRecordList(` は製品コードに1本ちょうど((18) が別に数えている)、
  // その1本を包む `readRows(` は起点と結合先の2箇所から呼ばれ、
  // `source.visibleRows(` は1箇所ちょうどである** —— **表ごとの出し分けを
  // `report.ts` の中に1つも持っていない。**
  expect(code.filter((line) => line.includes("source.visibleRows(")).length).toBe(1);
  const readRowsLines = code.filter((line) => line.includes("readRows("));
  expect(readRowsLines.filter((line) => line.includes("function readRows(")).length).toBe(1);
  expect(readRowsLines.length - 1).toBe(2);
});

/*
 * **【`V8-M10-T04`(台帳 `Q-G14`)による反転。旧テスト名と旧の期待値を逐語で残す】**
 *
 * **旧テスト名(逐語)**:
 *   `(23) 結合先の表の行は、要求した人が1行も読めなくても全件読まれる(V8-M10 が塞ぐ穴を今日の事実として固定する)`
 *
 * **旧の期待値(逐語)**:
 * ```
 *   expect(shape(editorReport.body)).toEqual([
 *     [["A"], [350, 3]],
 *     [["C"], [0, 0]],
 *   ]);
 *   // **持ち主の応答と1バイトも違わない。**
 *   const ownerReport = await readReport(ownerCookie, "rev");
 *   expect(JSON.stringify(editorReport.body)).toBe(JSON.stringify(ownerReport.body));
 * ```
 *
 * **旧の本文はこう書き残していた(逐語)**:
 *   「**`V8-M10` がこの壁を立てたら、下の `[350, 3]` は `[0, 0]` になる。**
 *    **そのとき本検査を「編集者の集計は 0 である」へ書き換えること**
 *    (消さずに、旧の期待値を逐語で残す)。」
 * —— **`[350, 3]` は実測で `[0, 0]` になった**(2026-08-15。`V8-M10-T04`)。
 * **予告した期待値と1バイトも同じ形で反転している。**
 */
test("(23) 結合先の表を1行も読めない人の集計は 0 になる(子が落ち、親は1行残る。旧: 全件読まれた)", async () => {
  /*
   * **題材**: `line_item` を読めるのは持ち主(`owner`)だけにする(`skipTables`)。
   * **編集者(`editor`)には `line_item` の読取の規則が1本も無い** ——
   * **一覧は 0 件になる**(`ADR-0305` 限定11。403 にせず応答から落とす)。
   * **`V8-M9` までは、それでも結合した集計が明細を全件読んで数えていた。**
   *
   * **今日は数えない。** **子は落ち、親(商品)は1行として残る**
   * (`v8-m10.md` §1-0c の決定5。**行そのものを落とさない**)——
   * **その結果、区分 A の群は消えずに `[0, 0]` で並ぶ**(`D-V8-120` と同じ向き)。
   */
  const withOwnerOnlyLineItem = manifestOf(allViews(), {
    skipTables: ["line_item"],
  }) as unknown as {
    app: { roles: { id: string; rules?: Any[] }[] };
  };
  const ownerRole = withOwnerOnlyLineItem.app.roles.find((role) => role.id === "owner");
  (ownerRole?.rules ?? []).push({
    target: "table",
    table: "line_item",
    can: ["read", "write", "delete"],
  });
  accepted(withOwnerOnlyLineItem as unknown as Manifest);

  const ownerCookie = owner("c23-owner");
  await seedRows(ownerCookie);
  const editorCookie = seedSession(dataRoot, APP_ID, {
    role: "editor",
    username: "c23-editor",
  }).cookie;

  // **編集者には明細が1行も見えない。**
  const listed = await req(editorCookie, "GET", `/api/apps/${APP_ID}/tables/line_item/records`);
  expect(listed.status).toBe(200);
  expect(((await listed.json()) as { records: unknown[] }).records).toEqual([]);

  // **結合した集計も1件も数えない** —— **`V8-M9` からここが反転した。**
  const editorReport = await readReport(editorCookie, "rev");
  expect(editorReport.status).toBe(200);
  expect(shape(editorReport.body)).toEqual([
    [["A"], [0, 0]],
    [["C"], [0, 0]],
  ]);
  // **群は1つも消えていない**(**行そのものを落としていない**。決定5)。
  expect(editorReport.body.total_groups).toBe(2);
  expect(editorReport.body.totals).toEqual([
    { type: "sum", field: "amount", value: 0 },
    { type: "count", value: 0 },
  ]);
  // **持ち主の応答とは違う**(旧は「1バイトも違わない」であった)。
  const ownerReport = await readReport(ownerCookie, "rev");
  expect(shape(ownerReport.body)).toEqual([
    [["A"], [350, 3]],
    [["C"], [0, 0]],
  ]);
  expect(JSON.stringify(editorReport.body)).not.toBe(JSON.stringify(ownerReport.body));
});

// =====================================================================================
// (D) **結合の向こう側にも可視性が効く**(`V8-M10-T04`。台帳 `Q-G14`。
//     `v8-m10.md` §1-0c の決定5)
//
// **倒し方は2つだけである** ——
//   **順方向(子 → 親)**: **見えない親は `null` に倒れる**(子の行は落ちない)。
//   **逆方向(親 → 子)**: **見えない子は落ち、親は1行として残る**(件数が 0 になる)。
// **どちらも「相手が最初から居ない」ときとまったく同じ形である** ——
// **その結果、応答の上では区別できない**((32) が実測で示す)。
// =====================================================================================

/**
 * **結合先の表の読取だけを役割の規則で細工した題材を1つ適用する**(`V8-M10-T04`)。
 *
 * **`skipTables` でその表の既定の規則を1本も置かず、必要な役割にだけ書き足す** ——
 * **(23) が採ったやり方をそのまま関数にしたものである**(題材を2つ持たない)。
 */
function withTableRules(params: {
  skip: readonly string[];
  add: { role: string; rules: Any[] }[];
}): void {
  const manifest = manifestOf(allViews(), { skipTables: [...params.skip] }) as unknown as {
    app: { roles: { id: string; rules?: Any[] }[] };
  };
  for (const entry of params.add) {
    const role = manifest.app.roles.find((candidate) => candidate.id === entry.role);
    if (role !== undefined) {
      role.rules = [...(role.rules ?? []), ...entry.rules];
    }
  }
  accepted(manifest as unknown as Manifest);
}

/** 持ち主だけが `order` を読める題材(編集者は「決済方法が card」の注文だけ読める)。 */
function orderVisibleOnlyForCard(): void {
  withTableRules({
    skip: ["order"],
    add: [
      {
        role: "owner",
        rules: [{ target: "table", table: "order", can: ["read", "write", "delete"] }],
      },
      {
        role: "editor",
        rules: [
          {
            target: "table",
            table: "order",
            can: ["read"],
            when: { field: "method", equals: "card" },
          },
        ],
      },
    ],
  });
}

/** 持ち主だけが `line_item` を読める題材(編集者は「金額が 100」の明細だけ読める)。 */
function lineItemVisibleOnlyFor100(): void {
  withTableRules({
    skip: ["line_item"],
    add: [
      {
        role: "owner",
        rules: [{ target: "table", table: "line_item", can: ["read", "write", "delete"] }],
      },
      {
        role: "editor",
        rules: [
          {
            target: "table",
            table: "line_item",
            can: ["read"],
            when: { field: "amount", equals: 100 },
          },
        ],
      },
    ],
  });
}

function editor(username: string): string {
  return seedSession(dataRoot, APP_ID, { role: "editor", username }).cookie;
}

test("(30) 順方向(子 → 親): 見えない親は null に倒れる(子の行は1行も落ちない)", async () => {
  orderVisibleOnlyForCard();
  const ownerCookie = owner("c30-owner");
  await seedRows(ownerCookie);
  const editorCookie = editor("c30-editor");

  // **編集者に見える注文は card の1件だけである**(一覧で先に確かめる)。
  const listed = await req(editorCookie, "GET", `/api/apps/${APP_ID}/tables/order/records`);
  expect(listed.status).toBe(200);
  expect(((await listed.json()) as { total: number }).total).toBe(1);

  const forOwner = await readReport(ownerCookie, "fwd");
  expect(shape(forOwner.body)).toEqual([
    [["card"], [300, 2]],
    [["cash"], [50, 1]],
  ]);

  const forEditor = await readReport(editorCookie, "fwd");
  expect(forEditor.status).toBe(200);
  // **`cash` の群が消え、その明細は「相手が無い」群(`null`)へ移った** ——
  // **明細の行そのものは1行も落ちていない**(合計も件数も持ち主と同じ)。
  expect(shape(forEditor.body)).toEqual([
    [["card"], [300, 2]],
    [[null], [50, 1]],
  ]);
  expect(forEditor.body.totals).toEqual([
    { type: "sum", field: "amount", value: 350 },
    { type: "count", value: 3 },
  ]);
  expect(JSON.stringify(forEditor.body)).not.toBe(JSON.stringify(forOwner.body));
});

test("(31) 逆方向(親 → 子): 見えない子は落ち、親は1行残る(件数が 0 になる)", async () => {
  lineItemVisibleOnlyFor100();
  const ownerCookie = owner("c31-owner");
  await seedRows(ownerCookie);
  const editorCookie = editor("c31-editor");

  const forOwner = await readReport(ownerCookie, "rev");
  expect(shape(forOwner.body)).toEqual([
    [["A"], [350, 3]],
    [["C"], [0, 0]],
  ]);

  const forEditor = await readReport(editorCookie, "rev");
  expect(forEditor.status).toBe(200);
  // **見える明細は金額 100 の1件だけ** —— **商品1は1件、商品2は0件、商品3は0件。**
  // **群は2つのまま**(**親を落としていない**)。
  expect(shape(forEditor.body)).toEqual([
    [["A"], [100, 1]],
    [["C"], [0, 0]],
  ]);
  expect(forEditor.body.total_groups).toBe(2);
});

/** 行を1件消す(**削除には版(`If-Match`)が要る**。`ADR-0017`)。 */
async function removeRecord(cookie: string, table: string, id: string): Promise<void> {
  const fetched = await req(cookie, "GET", `/api/apps/${APP_ID}/tables/${table}/records/${id}`);
  expect(fetched.status).toBe(200);
  const version = ((await fetched.json()) as { record: { _updated_at: string } }).record
    ._updated_at;
  const deleted = await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/tables/${table}/records/${id}`, {
      method: "DELETE",
      headers: { cookie, origin: TEST_ORIGIN, "if-match": version },
    }),
  );
  expect(deleted.status).toBe(204);
}

/** その人に見える行の `_id` を全部返す。 */
async function idsOf(cookie: string, table: string): Promise<string[]> {
  const res = await req(cookie, "GET", `/api/apps/${APP_ID}/tables/${table}/records`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { records: { _id: string; amount?: number }[] };
  return body.records.map((record) => record._id);
}

test("(32) 順方向: 見えない親と、最初から無い親は、応答の上で区別できない(1バイトも違わない)", async () => {
  /*
   * **`v8-m10.md` §1-0c の決定5 が承知した代償を、実測で確かめる。**
   * **同じ題材の上で「相手が居るが見えない」応答と「相手が最初から居ない」応答を採り、
   * `JSON.stringify` で突き合わせる**(実 HTTP の `cmp` は `v8-m10.md` §4 の実測で採る)。
   */
  orderVisibleOnlyForCard();
  const ownerCookie = owner("c32-owner");
  const seeded = await seedRows(ownerCookie);
  const editorCookie = editor("c32-editor");

  // (i) **相手(cash の注文)は居るが、編集者には見えない。**
  const invisible = await readReport(editorCookie, "fwd");

  // (ii) **相手を消す** —— **明細の参照先が実在しなくなる(= 最初から無いのと同じ形)。**
  await removeRecord(ownerCookie, "order", seeded.o2);
  const absent = await readReport(ownerCookie, "fwd");

  // **1バイトも違わない** —— **応答からは区別できない。**
  expect(JSON.stringify(invisible.body)).toBe(JSON.stringify(absent.body));
});

test("(33) 逆方向: 見えない子と、最初から無い子も、応答の上で区別できない(1バイトも違わない)", async () => {
  lineItemVisibleOnlyFor100();
  const ownerCookie = owner("c33-owner");
  await seedRows(ownerCookie);
  const editorCookie = editor("c33-editor");

  // (i) **商品2の子(金額 200)は居るが、編集者には見えない。**
  const invisible = await readReport(editorCookie, "rev");
  expect(shape(invisible.body)).toEqual([
    [["A"], [100, 1]],
    [["C"], [0, 0]],
  ]);

  // (ii) **見えない子(金額 100 以外)を実際に消す。**
  const visibleToEditor = new Set(await idsOf(editorCookie, "line_item"));
  for (const id of await idsOf(ownerCookie, "line_item")) {
    if (!visibleToEditor.has(id)) {
      await removeRecord(ownerCookie, "line_item", id);
    }
  }
  const absent = await readReport(ownerCookie, "rev");

  // **1バイトも違わない。**
  expect(JSON.stringify(invisible.body)).toBe(JSON.stringify(absent.body));
});

test("(34) 一対多の重複は、可視性を掛けても消えていない(V8-M9 の既知の限界は今日も真である)", async () => {
  lineItemVisibleOnlyFor100();
  const ownerCookie = owner("c34-owner");
  const seeded = await seedRows(ownerCookie);
  // **金額 100 の明細を、商品1にもう1件足す**(編集者に2件見える子を作る)。
  await create(ownerCookie, "line_item", {
    order: seeded.o1,
    product: seeded.p1,
    amount: 100,
  });
  const editorCookie = editor("c34-editor");

  // **`omit` は起点(商品)を数える集計表である** —— **商品は区分 A に2件しかない。**
  const forEditor = await readReport(editorCookie, "omit");
  expect(forEditor.status).toBe(200);
  // **それでも 3 と出る** —— **商品1が見える子の数(2)だけ数えられているからである。**
  // **【禁止】これを「重複しない」と書かない**(`v8-m9.md` の記録は今日も真である)。
  expect(shape(forEditor.body)).toEqual([
    [["A"], [3]],
    [["C"], [1]],
  ]);
  // **持ち主は子が4件見えるので、区分 A は 4 になる**(重複の量が人によって変わる)。
  const forOwner = await readReport(ownerCookie, "omit");
  expect(shape(forOwner.body)).toEqual([
    [["A"], [4]],
    [["C"], [1]],
  ]);
});

test("(35) 判定の配管(付与表・利用者表)には可視性を掛けていない(結合先に付与表を置いても循環しない)", async () => {
  /*
   * **`T03` が外した理由をそのまま守っているかを、白箱で1行だけ数える。**
   * **配管(`recordAccessJudge`)へ渡す `ReadSource` は、注入を組む**前**の
   * `source` そのものでなければならない** —— **注入した側を渡すと
   * 「自分に見える付与だけで判定する」循環になる。**
   */
  const source = await Bun.file(new URL("./app.ts", import.meta.url)).text();
  const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  // **`visibleRows` を組んだオブジェクトを配管へ渡している行が1つも無いこと。**
  expect(code.filter((line) => /recordAccessJudge\(\s*\{/.test(line))).toEqual([]);
});
